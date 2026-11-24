/**
 * Modul: Suchindex-Zeilen per rowid (Migration 284, #2810)
 * Zweck: Die Suchindex-Trigger loeschten per `WHERE entity = ... AND entity_id = ...`.
 *        `search_index` ist eine FTS5-Tabelle, und fuer UNINDEXED-Spalten hat
 *        FTS5 keinen Index: jede geaenderte oder geloeschte Zeile las den ganzen
 *        Index, Massenoperationen wurden quadratisch (4000 Einkaufsartikel
 *        umbenennen: 5,5 s). Seit Migration 284 traegt jede Zeile das rowid
 *        `(code << 40) + id`, und alle Trigger lesen und schreiben darueber.
 *
 *        Geprueft wird:
 *          1. Struktur: kein Trigger, der search_index schreibt, loescht ohne
 *             rowid, und jedes INSERT nennt rowid - haelt auch kuenftige Module.
 *          2. Gleichwertigkeit: der Index-Inhalt (entity, entity_id, title, body)
 *             ist nach der Migration derselbe wie davor, an einem Seed mit allen
 *             acht Entitaeten samt Tags und Serien-Kindern; jedes rowid ist der
 *             erwartete Schluessel; FTS5 `integrity-check` ist gruen.
 *          3. Je Entitaet: nach INSERT/UPDATE genau eine Zeile unter dem
 *             erwarteten rowid, nach DELETE keine; ein INSERT auf ein schon
 *             belegtes rowid bricht den Schreibvorgang nicht ab.
 *
 * Ausführen: npm run test:search-index-rowid
 */

import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore - better-sqlite3-multiple-ciphers bringt keine Typen mit
import Database from 'better-sqlite3-multiple-ciphers';

/** @typedef {any} Db */
/** @typedef {{ rowid: number, entity: keyof typeof CODES, entity_id: number, title: string, body: string }} IndexRow */

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'search-index-rowid-test-secret';

const { MIGRATIONS } = await import('../server/db.js');

const FIX_VERSION = 284;

/** Die feste Codetabelle aus Migration 284 (docs/SPEC.md). Nie neu vergeben. */
const CODES = { task: 1, event: 2, note: 3, contact: 4, item: 5, medication: 6, activity: 7, waste_type: 8 };
const keyOf = (/** @type {keyof typeof CODES} */ entity, /** @type {number} */ id) => CODES[entity] * 2 ** 40 + id;

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
    applyMigration(db, migration);
  }
  return db;
}

/**
 * @param {Db} db
 * @param {any} migration
 */
function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

/** Ein Tag so, wie server/utils/task-tags.js ihn schreibt (OR IGNORE, tag_key). */
/**
 * @param {Db} db @param {string} table @param {string} fk @param {number} id @param {string} tag
 */
function addTag(db, table, fk, id, tag) {
  db.prepare(`INSERT OR IGNORE INTO ${table} (${fk}, tag, tag_key) VALUES (?, ?, ?)`).run(id, tag, tag.toLowerCase());
}

/** Ein Seed mit allen acht Entitaeten, Tags an Aufgabe und Artikel, Serien-Kindern. */
/** @param {Db} db */
function seed(db) {
  const userId = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner', 'Owner', 'hash', 'admin')
  `).run().lastInsertRowid);
  const listId = Number(db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
    .run('Wocheneinkauf', userId).lastInsertRowid);
  /** @type {Record<string, number>} */
  const ids = {};
  ids.task = Number(db.prepare('INSERT INTO tasks (title, description, created_by) VALUES (?, ?, ?)')
    .run('Steuererklärung', 'Belege sammeln', userId).lastInsertRowid);
  addTag(db, 'task_tags', 'task_id', ids.task, 'büro');
  addTag(db, 'task_tags', 'task_id', ids.task, 'frist');
  db.prepare('INSERT INTO tasks (title, created_by) VALUES (?, ?)').run('Ohne Beschreibung', userId);
  ids.event = Number(db.prepare(`
    INSERT INTO calendar_events (title, description, location, start_datetime, created_by)
    VALUES ('Zahnarzt', 'Kontrolle', 'Hauptstraße 1', '2026-11-24T09:00:00Z', ?)
  `).run(userId).lastInsertRowid);
  const series = Number(db.prepare(`
    INSERT INTO calendar_events (title, description, location, start_datetime, created_by, recurrence_rule)
    VALUES ('Training', 'Halle', 'Sportplatz', '2026-11-24T18:00:00Z', ?, 'FREQ=WEEKLY')
  `).run(userId).lastInsertRowid);
  // Ein Kind mit ueberschriebenem Ort, eines ohne Ueberschreibung.
  db.prepare(`
    INSERT INTO calendar_events (title, description, location, start_datetime, created_by, recurrence_parent_id, overridden_fields)
    VALUES ('Training', 'Halle', 'Turnhalle Süd', '2026-12-01T18:00:00Z', ?, ?, '["location"]')
  `).run(userId, series);
  db.prepare(`
    INSERT INTO calendar_events (title, description, location, start_datetime, created_by, recurrence_parent_id)
    VALUES ('Training', 'Halle', 'Sportplatz', '2026-12-08T18:00:00Z', ?, ?)
  `).run(userId, series);
  ids.note = Number(db.prepare('INSERT INTO notes (title, content, created_by) VALUES (?, ?, ?)')
    .run('Rezept', 'Mehl, Eier', userId).lastInsertRowid);
  ids.contact = Number(db.prepare('INSERT INTO contacts (name, phone, email) VALUES (?, ?, ?)')
    .run('Dr. Müller', '0301234', 'praxis@example.org').lastInsertRowid);
  ids.item = Number(db.prepare('INSERT INTO shopping_items (list_id, name, notes) VALUES (?, ?, ?)')
    .run(listId, 'Vollmilch', '3,5 %').lastInsertRowid);
  addTag(db, 'shopping_item_tags', 'item_id', ids.item, 'kühl');
  db.prepare('INSERT INTO shopping_items (list_id, name, sort_order) VALUES (?, ?, 5)').run(listId, 'Brot');
  ids.medication = Number(db.prepare('INSERT INTO medications (user_id, name, dosage_text) VALUES (?, ?, ?)')
    .run(userId, 'Ibuprofen', '400 mg').lastInsertRowid);
  ids.activity = Number(db.prepare('INSERT INTO health_activities (user_id, type, note, performed_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'Radfahren', 'Feierabendrunde', '2026-11-24T17:00:00Z').lastInsertRowid);
  ids.waste_type = Number(db.prepare("INSERT INTO waste_types (name, color) VALUES (?, '#336699')")
    .run('Biotonne').lastInsertRowid);
  return { userId, listId, ids };
}

const content = (/** @type {Db} */ db) => /** @type {IndexRow[]} */ (db.prepare(`
  SELECT entity, entity_id, title, body FROM search_index ORDER BY entity, entity_id, title, body
`).all());

const rowsOf = (/** @type {Db} */ db, /** @type {string} */ entity, /** @type {number} */ id) => /** @type {IndexRow[]} */ (db
  .prepare('SELECT rowid AS rowid, entity, entity_id, title, body FROM search_index WHERE entity = ? AND entity_id = ?')
  .all(entity, id));

const integrityCheck = (/** @type {Db} */ db) => db.exec("INSERT INTO search_index(search_index) VALUES('integrity-check')");

// --------------------------------------------------------------------------
// 1. Struktur
// --------------------------------------------------------------------------
test('Kein Suchindex-Trigger loescht ohne rowid, jedes INSERT in search_index nennt rowid', () => {
  const db = buildDatabase();
  try {
    const triggers = db.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%search_index%'
    `).all();
    // Vorbedingung: ohne Trigger waere der Guard leer und gruen.
    assert.ok(triggers.length >= 28, `nur ${triggers.length} Suchindex-Trigger - stimmt die Abfrage?`);
    const bad = [];
    for (const { name, sql } of triggers) {
      const flat = sql.replace(/\s+/g, ' ');
      for (const m of flat.matchAll(/DELETE FROM search_index\b([^;]*)/gi)) {
        if (!/^\s*WHERE rowid = /i.test(m[1])) bad.push(`${name}: DELETE ohne rowid:${m[1].slice(0, 60)}`);
      }
      for (const m of flat.matchAll(/INSERT(?: OR \w+)? INTO search_index\s*([^;]*)/gi)) {
        if (!/^\(\s*rowid\s*,/i.test(m[1])) bad.push(`${name}: INSERT ohne rowid:${m[1].slice(0, 60)}`);
      }
    }
    assert.deepEqual(bad, []);
  } finally {
    db.close();
  }
});

// --------------------------------------------------------------------------
// 2. Gleichwertigkeit der Migration
// --------------------------------------------------------------------------
test('Migration 284: derselbe Index-Inhalt wie davor, jedes rowid ist sein Schluessel', () => {
  const db = buildDatabase(FIX_VERSION - 1);
  try {
    seed(db);
    const before = content(db);
    // Vorbedingung: alle acht Entitaeten und die Tags stehen im Index.
    assert.deepEqual([...new Set(before.map((r) => r.entity))].sort(), Object.keys(CODES).sort());
    assert.ok(before.some((r) => r.entity === 'task' && /büro frist/.test(r.body)), 'Aufgaben-Tags im body');
    assert.ok(before.some((r) => r.entity === 'item' && /kühl/.test(r.body)), 'Artikel-Tags im body');
    assert.ok(before.some((r) => r.entity === 'event' && r.title === '' && r.body === 'Turnhalle Süd'), 'ueberschriebener Ort eines Kindes');

    applyMigration(db, MIGRATIONS.find((m) => m.version === FIX_VERSION));
    assert.deepEqual(content(db), before);

    const wrong = /** @type {IndexRow[]} */ (db.prepare('SELECT rowid AS rowid, entity, entity_id FROM search_index').all())
      .filter((r) => r.rowid !== keyOf(r.entity, r.entity_id));
    assert.deepEqual(wrong, []);
    integrityCheck(db);
  } finally {
    db.close();
  }
});

// --------------------------------------------------------------------------
// 3. Je Entitaet: einfuegen, aendern, loeschen
// --------------------------------------------------------------------------
/** @type {Array<{ entity: keyof typeof CODES, table: string, update: string, title: string }>} */
const ENTITIES = [
  { entity: 'task', table: 'tasks', update: "title = 'Neu'", title: 'Neu' },
  { entity: 'event', table: 'calendar_events', update: "title = 'Neu'", title: 'Neu' },
  { entity: 'note', table: 'notes', update: "title = 'Neu'", title: 'Neu' },
  { entity: 'contact', table: 'contacts', update: "name = 'Neu'", title: 'Neu' },
  { entity: 'item', table: 'shopping_items', update: "name = 'Neu'", title: 'Neu' },
  { entity: 'medication', table: 'medications', update: "name = 'Neu'", title: 'Neu' },
  { entity: 'activity', table: 'health_activities', update: "type = 'Neu'", title: 'Neu' },
  { entity: 'waste_type', table: 'waste_types', update: "name = 'Neu'", title: 'Neu' },
];

test('Je Entitaet: nach INSERT und UPDATE genau eine Zeile unter ihrem Schluessel, nach DELETE keine', () => {
  const db = buildDatabase();
  try {
    const { ids } = seed(db);
    for (const { entity, table, update, title } of ENTITIES) {
      const id = ids[entity];
      assert.deepEqual(rowsOf(db, entity, id).map((r) => r.rowid), [keyOf(entity, id)], `${entity} nach INSERT`);
      db.prepare(`UPDATE ${table} SET ${update} WHERE id = ?`).run(id);
      const after = rowsOf(db, entity, id);
      assert.deepEqual(after.map((r) => [r.rowid, r.title]), [[keyOf(entity, id), title]], `${entity} nach UPDATE`);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      assert.deepEqual(rowsOf(db, entity, id), [], `${entity} nach DELETE`);
    }
    integrityCheck(db);
  } finally {
    db.close();
  }
});

test('Tags: Anfuegen und Entfernen schreiben die eine Zeile von Aufgabe und Artikel neu', () => {
  const db = buildDatabase();
  try {
    const { ids } = seed(db);
    addTag(db, 'task_tags', 'task_id', ids.task, 'steuer');
    db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag = ?').run(ids.task, 'büro');
    assert.deepEqual(rowsOf(db, 'task', ids.task).map((r) => [r.rowid, r.body]),
      [[keyOf('task', ids.task), 'Belege sammeln frist steuer']]);
    addTag(db, 'shopping_item_tags', 'item_id', ids.item, 'bio');
    db.prepare('DELETE FROM shopping_item_tags WHERE item_id = ? AND tag = ?').run(ids.item, 'kühl');
    assert.deepEqual(rowsOf(db, 'item', ids.item).map((r) => [r.rowid, r.body]),
      [[keyOf('item', ids.item), '3,5 % bio']]);
    integrityCheck(db);
  } finally {
    db.close();
  }
});

test('Ein INSERT auf ein schon belegtes rowid bricht den Schreibvorgang nicht ab', () => {
  // Eine verwaiste Index-Zeile (etwa aus einem Lauf mit abgeschaltetem Trigger)
  // unter dem Schluessel, den die naechste Zeile bekommt: ein schlichtes INSERT
  // scheiterte mit "constraint failed" und naehme das Anlegen des Nutzers mit.
  const db = buildDatabase();
  try {
    const { userId, listId } = seed(db);
    /** @type {Record<string, () => { lastInsertRowid: number | bigint }>} */
    const values = {
      task: () => db.prepare('INSERT INTO tasks (title, created_by) VALUES (?, ?)').run('Frisch', userId),
      event: () => db.prepare("INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('Frisch', '2026-11-25T09:00:00Z', ?)").run(userId),
      note: () => db.prepare('INSERT INTO notes (title, content, created_by) VALUES (?, ?, ?)').run('Frisch', '', userId),
      contact: () => db.prepare('INSERT INTO contacts (name) VALUES (?)').run('Frisch'),
      item: () => db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(listId, 'Frisch'),
      medication: () => db.prepare('INSERT INTO medications (user_id, name) VALUES (?, ?)').run(userId, 'Frisch'),
      activity: () => db.prepare("INSERT INTO health_activities (user_id, type, performed_at) VALUES (?, 'Frisch', '2026-11-25T09:00:00Z')").run(userId),
      waste_type: () => db.prepare("INSERT INTO waste_types (name, color) VALUES ('Frisch', '#123456')").run(),
    };
    for (const { entity, table } of ENTITIES) {
      const next = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`).get().n;
      db.prepare("INSERT INTO search_index (rowid, entity, entity_id, title, body) VALUES (?, ?, ?, 'verwaist', '')")
        .run(keyOf(entity, next), entity, next);
      const id = Number(values[entity]().lastInsertRowid);
      assert.equal(id, next, `${entity}: Vorbedingung, die neue Zeile traegt die vorbelegte ID`);
      assert.deepEqual(rowsOf(db, entity, id).map((r) => [r.rowid, r.title]), [[keyOf(entity, id), 'Frisch']], entity);
    }
    integrityCheck(db);
  } finally {
    db.close();
  }
});
