/**
 * Modul: Dubletten im Volltext-Index (Migration 151)
 * Zweck: Ein Einkaufsartikel, der ohne eigene `sort_order` angelegt wird - der
 *        Normalfall über die App -, landete ZWEIMAL in `search_index`.
 *
 *        Ursache ist ein Zusammenspiel zweier AFTER-INSERT-Trigger auf
 *        `shopping_items`, deren Reihenfolge SQLite nicht zusichert:
 *          1. `trg_shopping_items_sort_order` (Migration 133) macht ein UPDATE
 *             auf dieselbe Zeile, sobald `sort_order` beim Einfügen 0 ist.
 *          2. Dieses UPDATE löst `trg_search_items_au` aus - der räumt auf und
 *             schreibt eine Index-Zeile.
 *          3. Erst DANACH läuft `trg_search_items_ai` und schreibt eine zweite.
 *
 *        WARUM ES NIE JEMAND GEMERKT HAT: der Fehler heilt sich beim ersten
 *        UPDATE selbst, denn `trg_search_items_au` löscht über
 *        (entity, entity_id) und trifft damit beide Zeilen. Abhaken genügt.
 *        Doppelt sind also genau die frisch angelegten, noch unberührten
 *        Artikel - und das sind die, nach denen jemand sucht.
 *
 *        Der Schaden ist nicht kosmetisch: `runSearch` deckelt bei fünf
 *        Treffern je Art, und doppelte Zeilen halbieren, was davon ankommt.
 *
 * Ausführen: npm run test:search-index-duplicates
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'search-index-duplicates-test-secret';

const { MIGRATIONS } = await import('../server/db.js');
const { runSearch } = await import('../server/services/search.js');

const FIX_VERSION = 151;

/** Baut eine Datenbank mit allen Migrationen bis einschliesslich `upTo`. */
function buildDatabase(upTo = Infinity) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) break;
    if (typeof migration.up === 'function') migration.up(db);
    else db.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  // runSearch() (unten) fragt seit #1063 Phase 10 immer auch waste_types ab
  // (Migration 194, Trigger aus Migration 203) - unabhaengig von `upTo`, denn
  // der Umfang dieser Suite (der Dublettenfix aus Migration 151) hat mit der
  // Frage, ob Waste zu diesem historischen Stand schon existierte, nichts zu
  // tun. Ohne das schlaegt jeder runSearch()-Aufruf hier mit "no such table"
  // fehl, sobald `upTo` (wie meistens) unter 190 liegt.
  for (const version of [194, 203]) {
    if (upTo >= version) continue;
    const migration = MIGRATIONS.find((m) => m.version === version);
    if (typeof migration.up === 'function') migration.up(db);
    else db.exec(migration.up);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return db;
}

function applyMigration(db, version) {
  const migration = MIGRATIONS.find((m) => m.version === version);
  assert.ok(migration, `Migration ${version} muss es geben`);
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function seedUserAndList(db) {
  const userId = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('owner', 'Owner', 'hash', 'admin')
  `).run().lastInsertRowid;
  const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
    .run('Wocheneinkauf', userId).lastInsertRowid;
  return { userId, listId };
}

const indexRows = (db, entity, entityId) => db
  .prepare('SELECT COUNT(*) AS n FROM search_index WHERE entity = ? AND entity_id = ?')
  .get(entity, entityId).n;

// --------------------------------------------------------------------------
// Der Anlassfall.
// --------------------------------------------------------------------------
test('Ein Artikel ohne eigene sort_order steht genau EINMAL im Index', () => {
  const db = buildDatabase();
  const { listId } = seedUserAndList(db);
  try {
    // Ohne sort_order - genau so legen die neun Einfügewege der App an, und
    // genau dann greift der sort_order-Trigger mit seinem UPDATE.
    const id = db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)')
      .run(listId, 'Buchweizenmehl').lastInsertRowid;
    assert.equal(indexRows(db, 'item', id), 1);
  } finally {
    db.close();
  }
});

test('Der Fehler tritt nur ohne eigene sort_order auf - beide Wege ergeben eine Zeile', () => {
  // Die Gegenprobe zum Anlassfall: MIT sort_order feuert der Trigger nicht und
  // es war schon immer richtig. Stünde hier nur der eine Weg, sagte ein grüner
  // Test nicht, ob der Fix greift oder ob der Trigger nur nicht gefeuert hat.
  const db = buildDatabase();
  const { listId } = seedUserAndList(db);
  try {
    const ohne = db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)')
      .run(listId, 'Ohnesortierung').lastInsertRowid;
    const mit = db.prepare('INSERT INTO shopping_items (list_id, name, sort_order) VALUES (?, ?, 7)')
      .run(listId, 'Mitsortierung').lastInsertRowid;

    assert.equal(db.prepare('SELECT sort_order FROM shopping_items WHERE id = ?').get(ohne).sort_order, 1,
      'Vorbedingung: der sort_order-Trigger hat gefeuert und die Zeile angefasst');
    assert.equal(indexRows(db, 'item', ohne), 1);
    assert.equal(indexRows(db, 'item', mit), 1);
  } finally {
    db.close();
  }
});

test('Die Suche liefert einen Artikel einmal, und fünf Artikel bleiben fünf', () => {
  // Der eigentliche Schaden: `runSearch` deckelt bei SEARCH_LIMIT (5) je
  // Trefferart. Mit Dubletten kamen von fünf angelegten Artikeln nur zweieinhalb
  // an - ein Deckel, der die Hälfte wegschneidet, ohne es zu sagen.
  const db = buildDatabase();
  const { userId, listId } = seedUserAndList(db);
  try {
    for (let i = 1; i <= 5; i += 1) {
      db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)')
        .run(listId, `Quinoasorte ${i}`);
    }
    const hits = runSearch(db, 'Quinoasorte', userId).items;
    assert.equal(hits.length, 5, 'alle fünf Artikel kommen an');
    assert.equal(new Set(hits.map((h) => h.id)).size, 5, 'und zwar fünf verschiedene');
  } finally {
    db.close();
  }
});

test('Auch nach Ändern und Abhaken bleibt es bei einer Zeile', () => {
  // Der `_au`-Trigger räumte schon vorher auf (deshalb heilte sich der Fehler
  // beim ersten Anfassen selbst). Diese Zusicherung hält fest, dass der Fix
  // ihn nicht umdreht: zweimal löschen und einmal einfügen ist genauso falsch.
  const db = buildDatabase();
  const { listId } = seedUserAndList(db);
  try {
    const id = db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)')
      .run(listId, 'Kichererbsen').lastInsertRowid;
    db.prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(id);
    assert.equal(indexRows(db, 'item', id), 1, 'nach dem Abhaken');
    db.prepare('UPDATE shopping_items SET name = ? WHERE id = ?').run('Kichererbsenmehl', id);
    assert.equal(indexRows(db, 'item', id), 1, 'nach dem Umbenennen');
    assert.equal(
      db.prepare("SELECT title FROM search_index WHERE entity = 'item' AND entity_id = ?").get(id).title,
      'Kichererbsenmehl',
      'und der Index trägt den neuen Namen',
    );
    db.prepare('DELETE FROM shopping_items WHERE id = ?').run(id);
    assert.equal(indexRows(db, 'item', id), 0, 'nach dem Löschen bleibt nichts zurück');
  } finally {
    db.close();
  }
});

test('Der Fix hängt NICHT an der Trigger-Reihenfolge', () => {
  /* DIE WICHTIGSTE ZUSICHERUNG DIESER DATEI, und sie hat gefehlt.
   *
   * SQLite feuert mehrere AFTER-INSERT-Trigger derselben Tabelle in UMGEKEHRTER
   * Erstellungsreihenfolge - zugesichert ist das nicht, gemessen schon. Migration
   * 151 legt `trg_search_items_ai` neu an und schiebt ihn damit an den Anfang
   * dieser Reihenfolge. Schon das allein lässt die Dubletten verschwinden, ganz
   * ohne das DELETE im Trigger.
   *
   * Ein Test, der nur zählt, ist deshalb blind für den Unterschied zwischen der
   * Zusage („dieser Trigger schreibt genau eine Zeile") und ihrem Zufall („er
   * kommt gerade zuerst dran"). Gemessen habe ich das: mit entferntem DELETE und
   * intaktem DROP/CREATE blieb die ganze Datei grün.
   *
   * Hier wird die Reihenfolge deshalb zurückgedreht - der sort_order-Trigger wird
   * neu angelegt und feuert damit wieder vor dem Index-Trigger. Genau das
   * passiert von selbst, sobald irgendeine spätere Migration ihn anfasst. */
  const db = buildDatabase();
  const { listId } = seedUserAndList(db);
  try {
    // Aus sqlite_master gelesen und nicht abgeschrieben: eine Kopie der
    // Trigger-Definition im Test wäre eine zweite, die still veraltet.
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get('trg_shopping_items_sort_order')?.sql;
    assert.ok(sql, 'Vorbedingung: den sort_order-Trigger gibt es');

    db.exec('DROP TRIGGER trg_shopping_items_sort_order');
    db.exec(sql);

    const id = db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)')
      .run(listId, 'Rollgerste').lastInsertRowid;
    assert.equal(db.prepare('SELECT sort_order FROM shopping_items WHERE id = ?').get(id).sort_order, 1,
      'Vorbedingung: der neu angelegte sort_order-Trigger feuert weiterhin');
    assert.equal(indexRows(db, 'item', id), 1,
      'auch bei umgedrehter Reihenfolge genau eine Zeile - der Index-Trigger muss selbst idempotent sein');
  } finally {
    db.close();
  }
});

// --------------------------------------------------------------------------
// Die REGEL, nicht der eine Fall. Der Fix sitzt bei den Einkaufsartikeln, weil
// nur dort ein zweiter AFTER-INSERT-Trigger steht - aber die Falle gehört der
// Konstruktion, nicht der Tabelle. Kommt morgen ein sort_order-artiger Trigger
// auf `tasks` dazu, fällt es hier auf und nicht in der Suche eines Nutzers.
// --------------------------------------------------------------------------
const ENTITY_SEEDS = {
  task: (db, { userId }) => db.prepare(`
    INSERT INTO tasks (title, priority, status, created_by) VALUES (?, 'medium', 'open', ?)
  `).run('Zwetschgenmus', userId).lastInsertRowid,
  event: (db, { userId }) => db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, created_by) VALUES (?, '2030-01-01T10:00:00Z', ?)
  `).run('Zwetschgenmus', userId).lastInsertRowid,
  note: (db, { userId }) => db.prepare('INSERT INTO notes (title, content, created_by) VALUES (?, ?, ?)')
    .run('Zwetschgenmus', 'Text', userId).lastInsertRowid,
  contact: (db) => db.prepare('INSERT INTO contacts (name) VALUES (?)')
    .run('Zwetschgenmus').lastInsertRowid,
  item: (db, { listId }) => db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)')
    .run(listId, 'Zwetschgenmus').lastInsertRowid,
  medication: (db, { userId }) => db.prepare(`
    INSERT INTO medications (user_id, name, visibility) VALUES (?, ?, 'private')
  `).run(userId, 'Zwetschgenmus').lastInsertRowid,
  activity: (db, { userId }) => db.prepare(`
    INSERT INTO health_activities (user_id, type, performed_at, visibility)
    VALUES (?, ?, '2030-01-01T08:00:00Z', 'private')
  `).run(userId, 'Zwetschgenmus').lastInsertRowid,
};

test('Guard: KEINE indizierte Entität legt beim Anlegen zwei Index-Zeilen an', () => {
  const db = buildDatabase();
  const ctx = seedUserAndList(db);
  try {
    const doppelt = [];
    for (const [entity, seed] of Object.entries(ENTITY_SEEDS)) {
      const id = seed(db, ctx);
      const n = indexRows(db, entity, id);
      assert.ok(n > 0, `Vorbedingung: ${entity} wird überhaupt indiziert (sonst prüft dieser Guard nichts)`);
      if (n !== 1) doppelt.push(`${entity}: ${n}`);
    }
    assert.deepEqual(doppelt, [], [
      'Diese Entitäten schreiben beim Anlegen mehr als eine Index-Zeile.',
      'Meist steckt ein zweiter AFTER-INSERT-Trigger dahinter, der ein UPDATE',
      'auf dieselbe Zeile macht - SQLite sichert die Reihenfolge zweier Trigger',
      'desselben Typs nicht zu. Der _ai-Trigger dieser Entität muss dann wie der',
      'von shopping_items vor dem INSERT löschen (Migration 151).',
    ].join(' '));
  } finally {
    db.close();
  }
});

test('Guard: nur ein AFTER-INSERT-Trigger im Schema updatet seine eigene Tabelle', () => {
  // Die Sonde eine Ebene unter dem Guard oben: sie benennt die Konstruktion,
  // die den Fehler erzeugt, statt nur ihr Ergebnis zu zählen. Wer einen
  // zweiten solchen Trigger anlegt, muss den zugehörigen _ai-Trigger prüfen -
  // und liest das hier, bevor die Dubletten in der Suche eines Nutzers landen.
  const db = buildDatabase();
  try {
    const verdaechtig = db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .filter((t) => /AFTER\s+INSERT/i.test(t.sql)
        && new RegExp(`UPDATE\\s+${t.tbl_name}\\b`, 'i').test(t.sql.replace(/\s+/g, ' ')))
      .map((t) => t.name);

    assert.deepEqual(verdaechtig, ['trg_shopping_items_sort_order'],
      'Kommt hier einer dazu, prüfe den _ai-Trigger seiner Tabelle auf Dubletten');
  } finally {
    db.close();
  }
});

// --------------------------------------------------------------------------
// Bestandsdaten: die Migration muss aufräumen, was schon geschrieben ist.
// --------------------------------------------------------------------------
test(`Migration ${FIX_VERSION} räumt vorhandene Dubletten weg`, () => {
  const db = buildDatabase(FIX_VERSION - 1);
  const { userId, listId } = seedUserAndList(db);
  try {
    // Auf dem alten Stand entstehen sie von selbst - kein Nachstellen von Hand,
    // sondern der echte Schaden, den eine Bestandsinstallation trägt.
    const ids = [];
    for (const name of ['Amaranth', 'Buchweizen', 'Couscous']) {
      ids.push(db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)')
        .run(listId, name).lastInsertRowid);
    }
    for (const id of ids) {
      assert.equal(indexRows(db, 'item', id), 2, 'Vorbedingung: der alte Stand schreibt wirklich doppelt');
    }
    const task = ENTITY_SEEDS.task(db, { userId, listId });
    assert.equal(indexRows(db, 'task', task), 1, 'Vorbedingung: eine Aufgabe war schon vorher einfach');

    applyMigration(db, FIX_VERSION);

    for (const id of ids) {
      assert.equal(indexRows(db, 'item', id), 1, 'die Dublette ist weg');
    }
    assert.equal(indexRows(db, 'task', task), 1, 'und die einfache Zeile ist nicht mit weggeräumt worden');

    // Der Index muss danach noch suchbar sein - eine Migration, die Zeilen aus
    // einer FTS5-Tabelle entfernt, darf ihn nicht beschädigen.
    const hits = runSearch(db, 'Buchweizen', userId).items;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'Buchweizen');
  } finally {
    db.close();
  }
});

test(`Migration ${FIX_VERSION} repariert auch den Trigger, nicht nur die Daten`, () => {
  // Ohne diese Zusicherung wäre die Migration ein einmaliges Aufräumen: der
  // nächste angelegte Artikel stünde wieder doppelt da, und niemand sähe es,
  // bis jemand sucht.
  const db = buildDatabase(FIX_VERSION - 1);
  const { listId } = seedUserAndList(db);
  try {
    applyMigration(db, FIX_VERSION);
    const id = db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)')
      .run(listId, 'Dinkelgriess').lastInsertRowid;
    assert.equal(indexRows(db, 'item', id), 1, 'nach der Migration angelegt - eine Zeile');
  } finally {
    db.close();
  }
});
