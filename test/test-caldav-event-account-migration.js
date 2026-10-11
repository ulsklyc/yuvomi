/**
 * Test: Migration v238 gegen eine befüllte Bestands-DB (#1860)
 * Zweck: v238 trägt an calendar_events und calendar_pending_deletions das
 *        CalDAV-Konto nach und ordnet den Bestand zu. Diese Suite baut die echte
 *        Migrationskette bis v237, befüllt sie mit einem, zwei und keinem Konto
 *        und weist nach:
 *        - die Zuordnung je Regel: ein Konto bekommt alles; bei mehreren zählt
 *          nur der Kalender-Schlüssel, und nur, wenn er in genau EINER Auswahl
 *          steht; Upload-Ziel und Objektadresse entscheiden nichts;
 *        - Apple, Google und lokale Zeilen bleiben ohne Konto, auch mit Ziel;
 *        - keine andere Spalte ändert sich, auch `updated_at` nicht, und der
 *          Suchindex wird nicht neu geschrieben;
 *        - kein Tabellen-Rebuild: die Trigger stehen mit demselben Wortlaut in
 *          derselben Reihenfolge, die Indizes bleiben;
 *        - beide Spalten tragen ihren Fremdschlüssel, und er wirkt: wird ein
 *          Konto gelöscht, bleiben seine Termine ohne Konto stehen und seine
 *          Löschaufträge verschwinden.
 * Ausführen: node --test test/test-caldav-event-account-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei: db.js migriert beim Modul-Load.
// Geprüft wird hier die exportierte Migration gegen eine eigens aufgebaute
// Vor-v238-DB.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-caldavacc-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const V238 = MIGRATIONS.find((m) => m.version === 238);

/** Eine Migration so fahren, wie es der Runner in db.js tut. */
function applyMigration(db, migration) {
  if (migration.foreignKeysOff) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      if (typeof migration.up === 'function') migration.up(db);
      else db.exec(migration.up);
      migration.afterUp?.(db);
    })();
  } finally {
    if (migration.foreignKeysOff) db.pragma('foreign_keys = ON');
  }
}

/** Echte Migrationskette bis v237 - der Stand, den ein Bestandsnutzer mitbringt. */
function buildPre238Database() {
  const db = new Database(join(tempDir('yuvomi-caldavacc-'), 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS.filter((m) => m.version <= 237)) applyMigration(db, migration);
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1,'admin','Admin','x','admin')").run();
  return db;
}

const OLD = '2025-01-02T03:04:05Z';

function addAccount(db, name, calendars) {
  const id = Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES (?, ?, ?, 'p')"
  ).run(name, `https://${name}.example/`, name).lastInsertRowid);
  for (const [url, enabled] of calendars) {
    db.prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (?, ?, ?, '#4A90E2', ?)
    `).run(id, url, url, enabled);
  }
  return id;
}

function calendarRef(db, source, externalId) {
  return Number(db.prepare(
    "INSERT INTO external_calendars (source, external_id, name, color) VALUES (?, ?, ?, '#34A853') RETURNING id"
  ).get(source, externalId, externalId).id);
}

/**
 * Legt einen Termin an und stellt `updated_at` danach auf einen alten Wert: der
 * Trigger setzt es bei jedem UPDATE auf "jetzt", und genau das soll die
 * Migration nicht auslösen.
 */
function addEvent(db, title, fields = {}) {
  const row = {
    title, external_source: 'local', external_calendar_id: null, calendar_ref_id: null,
    external_object_url: null, target_caldav_account_id: null, target_caldav_calendar_url: null,
    outbound_dirty: 0, outbound_move_to: null, ...fields,
  };
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source, external_calendar_id,
       calendar_ref_id, external_object_url, target_caldav_account_id, target_caldav_calendar_url,
       outbound_dirty, outbound_move_to)
    VALUES (@title, '2035-03-10T09:00', '2035-03-10T10:00', 0, 1, @external_source, @external_calendar_id,
       @calendar_ref_id, @external_object_url, @target_caldav_account_id, @target_caldav_calendar_url,
       @outbound_dirty, @outbound_move_to)
  `).run(row).lastInsertRowid);
  return id;
}

function addTombstone(db, source, calendarExternalId, uid, objectUrl = null) {
  return Number(db.prepare(`
    INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url)
    VALUES (?, ?, ?, ?)
  `).run(source, calendarExternalId, uid, objectUrl).lastInsertRowid);
}

/** `updated_at` alt stellen, ohne dass der Trigger es gleich wieder überschreibt. */
function ageEvents(db) {
  db.exec('DROP TRIGGER trg_calendar_events_updated_at');
  db.prepare('UPDATE calendar_events SET updated_at = ?').run(OLD);
  db.exec(`
    CREATE TRIGGER trg_calendar_events_updated_at
      AFTER UPDATE ON calendar_events FOR EACH ROW
      BEGIN UPDATE calendar_events SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
  `);
}

const events = (db) => db.prepare('SELECT * FROM calendar_events ORDER BY id').all();
const tombstones = (db) => db.prepare('SELECT * FROM calendar_pending_deletions ORDER BY id').all();
const accountOf = (db, id) => db.prepare('SELECT caldav_account_id FROM calendar_events WHERE id = ?').get(id).caldav_account_id;
const tombstoneAccount = (db, id) => db.prepare('SELECT caldav_account_id FROM calendar_pending_deletions WHERE id = ?').get(id)?.caldav_account_id;
const triggersOf = (db) => db.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'calendar_events' ORDER BY rowid"
).all();
const searchRows = (db) => db.prepare("SELECT rowid, entity_id, title FROM search_index WHERE entity = 'event' ORDER BY rowid").all();

/** Alle Spalten außer der neuen müssen nach der Migration dieselben Werte tragen. */
function assertUntouched(before, after, what) {
  assert.equal(after.length, before.length, `${what}: eine Zeile ist verschwunden oder dazugekommen`);
  for (const [i, row] of after.entries()) {
    for (const [key, value] of Object.entries(before[i])) {
      assert.deepEqual(row[key], value, `${what} ${row.id}: Feld ${key} hat sich geändert`);
    }
  }
}

test('ein Konto: jede CalDAV-Zeile und jeder CalDAV-Löschauftrag gehört ihm', () => {
  const db = buildPre238Database();
  const account = addAccount(db, 'solo', [['https://solo.example/cal/a/', 1]]);
  const refA = calendarRef(db, 'caldav', 'https://solo.example/cal/a/');
  // Rest eines früher gelöschten Kontos: sein Kalender steht in keiner Auswahl mehr.
  const refGone = calendarRef(db, 'caldav', 'https://gone.example/cal/x/');
  const refApple = calendarRef(db, 'apple', 'https://caldav.icloud.com/1/cal/');
  const refGoogle = calendarRef(db, 'google', 'fam@g');

  const ids = {
    selected:   addEvent(db, 'Im Kalender', { external_source: 'caldav', external_calendar_id: 'u1', calendar_ref_id: refA }),
    noCalendar: addEvent(db, 'Ohne Kalender', { external_source: 'caldav', external_calendar_id: 'u2' }),
    leftover:   addEvent(db, 'Rest', { external_source: 'caldav', external_calendar_id: 'u3', calendar_ref_id: refGone }),
    dirty:      addEvent(db, 'Bearbeitet', { external_source: 'caldav', external_calendar_id: 'u4', calendar_ref_id: refA, outbound_dirty: 1 }),
    apple:      addEvent(db, 'Apple', { external_source: 'apple', external_calendar_id: 'u5', calendar_ref_id: refApple }),
    google:     addEvent(db, 'Google', { external_source: 'google', external_calendar_id: 'g1', calendar_ref_id: refGoogle }),
    local:      addEvent(db, 'Lokal mit Ziel', { target_caldav_account_id: account, target_caldav_calendar_url: 'https://solo.example/cal/a/' }),
  };
  const stones = {
    withCalendar: addTombstone(db, 'caldav', 'https://solo.example/cal/a/', 'd1', 'https://solo.example/cal/a/d1.ics'),
    noCalendar:   addTombstone(db, 'caldav', '', 'd2', 'https://solo.example/cal/a/d2.ics'),
    google:       addTombstone(db, 'google', 'fam@g', 'd3'),
    apple:        addTombstone(db, 'apple', 'https://caldav.icloud.com/1/cal/', 'd4'),
  };
  ageEvents(db);
  const before = { events: events(db), tombstones: tombstones(db), search: searchRows(db) };

  applyMigration(db, V238);

  for (const key of ['selected', 'noCalendar', 'leftover', 'dirty']) {
    assert.equal(accountOf(db, ids[key]), account, `CalDAV-Zeile "${key}" gehört nicht dem einzigen Konto`);
  }
  for (const key of ['apple', 'google', 'local']) {
    assert.equal(accountOf(db, ids[key]), null, `Zeile "${key}" hat ein CalDAV-Konto bekommen`);
  }
  assert.equal(tombstoneAccount(db, stones.withCalendar), account);
  assert.equal(tombstoneAccount(db, stones.noCalendar), account);
  assert.equal(tombstoneAccount(db, stones.google), null);
  assert.equal(tombstoneAccount(db, stones.apple), null);

  assertUntouched(before.events, events(db), 'Termin');
  assertUntouched(before.tombstones, tombstones(db), 'Löschauftrag');
  assert.deepEqual(searchRows(db), before.search, 'der Suchindex wurde neu geschrieben');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('zwei Konten: zugeordnet wird nur über einen Kalender-Schlüssel, der in genau einer Auswahl steht', () => {
  const db = buildPre238Database();
  const shared = 'https://dav.example/cal/shared/';
  // Auch ein abgewählter Kalender steht in der Auswahl seines Kontos.
  const a = addAccount(db, 'anna', [['https://dav.example/cal/anna/', 1], ['https://dav.example/cal/anna-off/', 0], [shared, 1]]);
  const b = addAccount(db, 'ben', [['https://dav.example/cal/ben/', 1], [shared, 1]]);
  const ref = {
    a:      calendarRef(db, 'caldav', 'https://dav.example/cal/anna/'),
    aOff:   calendarRef(db, 'caldav', 'https://dav.example/cal/anna-off/'),
    b:      calendarRef(db, 'caldav', 'https://dav.example/cal/ben/'),
    shared: calendarRef(db, 'caldav', shared),
    gone:   calendarRef(db, 'caldav', 'https://gone.example/cal/x/'),
    // Fast derselbe Schlüssel: verglichen wird zeichengleich, nicht "ähnlich".
    near:   calendarRef(db, 'caldav', 'https://dav.example/cal/anna'),
    apple:  calendarRef(db, 'apple', 'https://dav.example/cal/anna/'),
  };

  const ids = {
    inA:        addEvent(db, 'In Anna', { external_source: 'caldav', external_calendar_id: 'u1', calendar_ref_id: ref.a }),
    inAOff:     addEvent(db, 'In Annas abgewähltem', { external_source: 'caldav', external_calendar_id: 'u2', calendar_ref_id: ref.aOff }),
    inB:        addEvent(db, 'In Ben', { external_source: 'caldav', external_calendar_id: 'u3', calendar_ref_id: ref.b }),
    inBoth:     addEvent(db, 'In beiden', { external_source: 'caldav', external_calendar_id: 'u4', calendar_ref_id: ref.shared }),
    inNone:     addEvent(db, 'In keinem', { external_source: 'caldav', external_calendar_id: 'u5', calendar_ref_id: ref.gone }),
    near:       addEvent(db, 'Fast', { external_source: 'caldav', external_calendar_id: 'u6', calendar_ref_id: ref.near }),
    // Ohne Kalender, aber Ziel und Adresse zeigen auf Ben: beides entscheidet nichts.
    noCalendar: addEvent(db, 'Ohne Kalender', {
      external_source: 'caldav', external_calendar_id: 'u7',
      target_caldav_account_id: b, target_caldav_calendar_url: 'https://dav.example/cal/ben/',
      external_object_url: 'https://dav.example/cal/ben/u7.ics',
    }),
    dirtyInB:   addEvent(db, 'Bearbeitet in Ben', { external_source: 'caldav', external_calendar_id: 'u8', calendar_ref_id: ref.b, outbound_dirty: 1 }),
    dirtyNone:  addEvent(db, 'Bearbeitet ohne Kalender', { external_source: 'caldav', external_calendar_id: 'u9', outbound_dirty: 1, outbound_move_to: shared }),
    // Das Ziel widerspricht dem Kalender: der Kalender zählt.
    targetLies: addEvent(db, 'Ziel sagt Ben', { external_source: 'caldav', external_calendar_id: 'u10', calendar_ref_id: ref.a, target_caldav_account_id: b }),
    apple:      addEvent(db, 'Apple', { external_source: 'apple', external_calendar_id: 'u11', calendar_ref_id: ref.apple }),
    google:     addEvent(db, 'Google', { external_source: 'google', external_calendar_id: 'g1' }),
    local:      addEvent(db, 'Lokal mit Ziel', { target_caldav_account_id: a, target_caldav_calendar_url: 'https://dav.example/cal/anna/' }),
  };
  const stones = {
    inA:        addTombstone(db, 'caldav', 'https://dav.example/cal/anna/', 'd1', 'https://dav.example/cal/anna/d1.ics'),
    inB:        addTombstone(db, 'caldav', 'https://dav.example/cal/ben/', 'd2'),
    inBoth:     addTombstone(db, 'caldav', shared, 'd3'),
    inNone:     addTombstone(db, 'caldav', 'https://gone.example/cal/x/', 'd4'),
    noCalendar: addTombstone(db, 'caldav', '', 'd5', 'https://dav.example/cal/ben/d5.ics'),
    // Derselbe Kalender-Schlüssel, andere Quelle.
    apple:      addTombstone(db, 'apple', 'https://dav.example/cal/anna/', 'd6'),
    google:     addTombstone(db, 'google', 'fam@g', 'd7'),
  };
  ageEvents(db);
  const before = { events: events(db), tombstones: tombstones(db), search: searchRows(db) };

  applyMigration(db, V238);

  const expected = {
    inA: a, inAOff: a, inB: b, dirtyInB: b, targetLies: a,
    inBoth: null, inNone: null, near: null, noCalendar: null, dirtyNone: null,
    apple: null, google: null, local: null,
  };
  for (const [key, account] of Object.entries(expected)) {
    assert.equal(accountOf(db, ids[key]), account, `Zeile "${key}" ist falsch zugeordnet`);
  }
  const expectedStones = { inA: a, inB: b, inBoth: null, inNone: null, noCalendar: null, apple: null, google: null };
  for (const [key, account] of Object.entries(expectedStones)) {
    assert.equal(tombstoneAccount(db, stones[key]), account, `Löschauftrag "${key}" ist falsch zugeordnet`);
  }

  assertUntouched(before.events, events(db), 'Termin');
  assertUntouched(before.tombstones, tombstones(db), 'Löschauftrag');
  assert.deepEqual(searchRows(db), before.search, 'der Suchindex wurde neu geschrieben');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('kein Konto: nichts wird zugeordnet, die Spalten stehen trotzdem', () => {
  const db = buildPre238Database();
  const id = addEvent(db, 'Waise', { external_source: 'caldav', external_calendar_id: 'u1' });
  const stone = addTombstone(db, 'caldav', 'https://gone.example/cal/x/', 'd1');

  applyMigration(db, V238);

  assert.equal(accountOf(db, id), null);
  assert.equal(tombstoneAccount(db, stone), null);
  db.close();
});

test('kein Rebuild: Tabellen, Trigger und Indizes bleiben, die Trigger mit demselben Wortlaut', () => {
  const db = buildPre238Database();
  // Mit Bestand: nur dann ruhen die Trigger überhaupt.
  const account = addAccount(db, 'solo', [['https://solo.example/cal/a/', 1]]);
  addEvent(db, 'Im Kalender', { external_source: 'caldav', external_calendar_id: 'u1' });
  const tableSql = (name) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).sql;
  const indexNames = () => db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('calendar_events', 'calendar_pending_deletions') AND sql IS NOT NULL ORDER BY name"
  ).all().map((r) => r.name);
  const rootpageOf = (name) => db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).rootpage;
  const before = {
    events: tableSql('calendar_events'), stones: tableSql('calendar_pending_deletions'),
    triggers: triggersOf(db), indexes: indexNames(),
    rootpages: {
      calendar_events: rootpageOf('calendar_events'),
      calendar_pending_deletions: rootpageOf('calendar_pending_deletions'),
    },
  };
  assert.ok(before.triggers.length >= 5, 'die Vorher-Aufnahme hat die Trigger nicht gesehen');

  applyMigration(db, V238);

  // ADD COLUMN fügt genau eine Spaltendefinition in den gespeicherten Wortlaut
  // ein (vor einer Tabellen-Constraint am Ende) und lässt die Tabelle auf
  // ihrer Seite; ein Rebuild schriebe die Definition neu und zöge um.
  for (const [name, sql, rootpage] of [
    ['calendar_events', before.events, before.rootpages.calendar_events],
    ['calendar_pending_deletions', before.stones, before.rootpages.calendar_pending_deletions],
  ]) {
    const added = /,\s*caldav_account_id INTEGER\s+REFERENCES caldav_accounts\(id\) ON DELETE (?:SET NULL|CASCADE)/;
    assert.match(tableSql(name), added, `${name}: die neue Spalte steht nicht in der Definition`);
    assert.equal(tableSql(name).replace(added, ''), sql, `${name}: die bestehende Tabellendefinition ist nicht erhalten`);
    assert.equal(rootpageOf(name), rootpage, `${name} wurde neu aufgebaut`);
  }
  assert.deepEqual(triggersOf(db), before.triggers, 'Trigger fehlen, sind umsortiert oder haben einen anderen Wortlaut');
  const after = indexNames();
  for (const name of before.indexes) assert.ok(after.includes(name), `Index ${name} fehlt nach der Migration`);
  assert.ok(after.includes('idx_calendar_caldav_account_uid'));
  assert.ok(after.includes('idx_cal_pending_del_account'));

  // Die Trigger arbeiten wieder: eine Änderung danach setzt updated_at.
  const id = Number(db.prepare("SELECT id FROM calendar_events WHERE external_calendar_id = 'u1'").get().id);
  db.exec('DROP TRIGGER trg_calendar_events_updated_at');
  db.prepare('UPDATE calendar_events SET updated_at = ? WHERE id = ?').run(OLD, id);
  db.exec(before.triggers.find((t) => t.name === 'trg_calendar_events_updated_at').sql);
  db.prepare("UPDATE calendar_events SET title = 'Neu' WHERE id = ?").run(id);
  assert.notEqual(db.prepare('SELECT updated_at FROM calendar_events WHERE id = ?').get(id).updated_at, OLD);
  assert.equal(db.prepare("SELECT title FROM search_index WHERE entity = 'event' AND entity_id = ?").get(id).title, 'Neu');
  assert.equal(accountOf(db, id), account);
  db.close();
});

test('beide Spalten tragen ihren Fremdschlüssel: Termine bleiben ohne Konto, Löschaufträge gehen mit', () => {
  const db = buildPre238Database();
  const a = addAccount(db, 'anna', [['https://dav.example/cal/anna/', 1]]);
  const b = addAccount(db, 'ben', [['https://dav.example/cal/ben/', 1]]);
  const refA = calendarRef(db, 'caldav', 'https://dav.example/cal/anna/');
  const refB = calendarRef(db, 'caldav', 'https://dav.example/cal/ben/');
  const eventA = addEvent(db, 'In Anna', { external_source: 'caldav', external_calendar_id: 'u1', calendar_ref_id: refA });
  const eventB = addEvent(db, 'In Ben', { external_source: 'caldav', external_calendar_id: 'u2', calendar_ref_id: refB });
  const stoneA = addTombstone(db, 'caldav', 'https://dav.example/cal/anna/', 'd1');
  const stoneB = addTombstone(db, 'caldav', 'https://dav.example/cal/ben/', 'd2');
  const stoneGoogle = addTombstone(db, 'google', 'fam@g', 'd3');

  applyMigration(db, V238);

  const foreignKey = (table) => db.pragma(`foreign_key_list(${table})`).find((fk) => fk.from === 'caldav_account_id');
  assert.deepEqual(
    (({ table, to, on_delete }) => ({ table, to, on_delete }))(foreignKey('calendar_events') ?? {}),
    { table: 'caldav_accounts', to: 'id', on_delete: 'SET NULL' }
  );
  assert.deepEqual(
    (({ table, to, on_delete }) => ({ table, to, on_delete }))(foreignKey('calendar_pending_deletions') ?? {}),
    { table: 'caldav_accounts', to: 'id', on_delete: 'CASCADE' }
  );
  assert.equal(accountOf(db, eventA), a);

  // Ein Konto, das es nicht gibt, nimmt keine der beiden Spalten an.
  assert.throws(() => db.prepare('UPDATE calendar_events SET caldav_account_id = 999 WHERE id = ?').run(eventA), /FOREIGN KEY/);

  db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(a);

  assert.equal(accountOf(db, eventA), null, 'der Termin des gelöschten Kontos trägt es noch');
  assert.equal(db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(eventA).title, 'In Anna', 'der Termin ging mit dem Konto verloren');
  assert.equal(accountOf(db, eventB), b);
  assert.equal(tombstoneAccount(db, stoneA), undefined, 'der Löschauftrag des gelöschten Kontos steht noch');
  assert.equal(tombstoneAccount(db, stoneB), b);
  assert.equal(tombstoneAccount(db, stoneGoogle), null);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('eine Datenbank, die die Spalten schon trägt, läuft durch und wird trotzdem zugeordnet', () => {
  const db = buildPre238Database();
  const account = addAccount(db, 'solo', [['https://solo.example/cal/a/', 1]]);
  const id = addEvent(db, 'Im Kalender', { external_source: 'caldav', external_calendar_id: 'u1' });
  // Der Stand nach reconcileCriticalSchema() auf einer gedrifteten Datei.
  db.exec(`
    ALTER TABLE calendar_events ADD COLUMN caldav_account_id INTEGER REFERENCES caldav_accounts(id) ON DELETE SET NULL;
    ALTER TABLE calendar_pending_deletions ADD COLUMN caldav_account_id INTEGER REFERENCES caldav_accounts(id) ON DELETE CASCADE;
  `);

  applyMigration(db, V238);

  assert.equal(accountOf(db, id), account);
  db.close();
});
