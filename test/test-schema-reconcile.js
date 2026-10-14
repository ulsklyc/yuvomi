/**
 * Tests: Schema-Selbstheilung gegen Migrations-Drift (#538)
 * Modul: server/db.js → reconcileCriticalSchema()
 *
 * Szenario: Eine Migration (v54) ist in schema_migrations als angewendet vermerkt,
 * ihr additiver Effekt (reminders.pushed_at) fehlt real - etwa nach Restore aus
 * einem inkonsistenten Backup. Ohne die Spalte scheitert der Notification-/Push-
 * Scheduler bei jedem Lauf still auf `no such column: r.pushed_at`.
 *
 * Der Test läuft gegen eine eigene node:sqlite-DB (built-in) und beweist damit,
 * dass die Reparatur mit derselben API funktioniert wie in Produktion mit
 * better-sqlite3 (PRAGMA table_info + ALTER TABLE ADD COLUMN).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// db.js initialisiert beim Import die globale (better-sqlite3-)DB; wir testen
// reconcileCriticalSchema aber isoliert gegen eine eigene node:sqlite-Instanz.
const { reconcileCriticalSchema } = await import('../server/db.js');

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

test('trägt fehlende reminders.pushed_at nach und erhält Bestandsdaten', () => {
  const db = new DatabaseSync(':memory:');
  // reminders wie in einer gedrifteten DB: ohne pushed_at
  db.exec(`CREATE TABLE reminders (
    id INTEGER PRIMARY KEY, entity_type TEXT, entity_id INTEGER,
    remind_at TEXT, dismissed INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT
  )`);
  db.exec(`INSERT INTO reminders (id, entity_type, remind_at) VALUES (1, 'task', '2026-01-01T09:00:00Z')`);
  assert.equal(hasColumn(db, 'reminders', 'pushed_at'), false);

  reconcileCriticalSchema(db);

  assert.equal(hasColumn(db, 'reminders', 'pushed_at'), true);
  // Die neue Spalte ist NULL-defaultet, Bestandszeile bleibt erhalten
  const row = db.prepare('SELECT id, entity_type, pushed_at FROM reminders WHERE id = 1').get();
  assert.equal(row.entity_type, 'task');
  assert.equal(row.pushed_at, null);
  // Genau die Query des Schedulers ist danach lauffähig
  assert.doesNotThrow(() => db.prepare('SELECT id FROM reminders r WHERE r.pushed_at IS NULL').all());
});

test('ist idempotent: vorhandene Spalte samt Wert bleibt unangetastet', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE reminders (id INTEGER PRIMARY KEY, remind_at TEXT, pushed_at TEXT)`);
  db.exec(`INSERT INTO reminders (id, pushed_at) VALUES (1, '2026-05-05T10:00:00Z')`);

  reconcileCriticalSchema(db);
  reconcileCriticalSchema(db); // zweiter Lauf darf keinen Duplicate-Column-Fehler werfen

  const row = db.prepare('SELECT pushed_at FROM reminders WHERE id = 1').get();
  assert.equal(row.pushed_at, '2026-05-05T10:00:00Z');
});

test('ist ein No-op, wenn die reminders-Tabelle ganz fehlt (kein Wurf, keine Neuanlage)', () => {
  const db = new DatabaseSync(':memory:');
  assert.doesNotThrow(() => reconcileCriticalSchema(db));
  const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'").get();
  assert.equal(tbl, undefined);
});

test('greift ohne database-Argument nicht auf eine nicht-initialisierte DB zu', () => {
  // Defensive: reconcileCriticalSchema(undefined) bei fehlender globaler DB darf nicht werfen.
  assert.doesNotThrow(() => reconcileCriticalSchema(null));
});

// --------------------------------------------------------------------------
// Eine Spalte mit Nachtrag (#1935): calendar_events.series_authored
// --------------------------------------------------------------------------
// Migration 246 legt die Spalte an UND setzt sie fuer lokale Zeilen auf 1. Die
// Spalte allein nachzutragen stellte jede Zeile auf 0 - die hier angelegten
// Serien gingen danach wie eingelesene hinaus, ohne ausgerichteten Start.

function driftedCalendar() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY, title TEXT, tzid TEXT, caldav_account_id INTEGER,
      external_source TEXT NOT NULL DEFAULT 'local', updated_at TEXT
    );
    CREATE TRIGGER trg_calendar_events_updated_at AFTER UPDATE ON calendar_events FOR EACH ROW
      BEGIN UPDATE calendar_events SET updated_at = 'touched' WHERE id = OLD.id; END;
    INSERT INTO calendar_events (id, title, external_source, updated_at) VALUES
      (1, 'Eigen', 'local', 'original'), (2, 'Google', 'google', 'original'),
      (3, 'CalDAV', 'caldav', 'original'), (4, 'Abo', 'ics', 'original');
  `);
  return db;
}

test('traegt series_authored MIT dem Nachtrag der Migration nach: lokale Zeilen sind verfasst', () => {
  const db = driftedCalendar();
  assert.equal(hasColumn(db, 'calendar_events', 'series_authored'), false);

  reconcileCriticalSchema(db);

  const rows = db.prepare('SELECT series_authored, updated_at FROM calendar_events ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.series_authored), [1, 0, 0, 0],
    'die lokale Zeile traegt die Marke wieder, bei gespiegelten wird nicht geraten');
  assert.deepEqual(rows.map((r) => r.updated_at), Array(4).fill('original'),
    'die Reparatur setzt keinen Termin auf "eben geaendert"');
  // Die Trigger sind wieder da.
  db.exec("UPDATE calendar_events SET title = 'Neu' WHERE id = 2");
  assert.equal(db.prepare('SELECT updated_at FROM calendar_events WHERE id = 2').get().updated_at, 'touched');
});

test('der Nachtrag laeuft nur, wenn die Spalte neu angelegt wurde', () => {
  // Steht die Spalte schon, ist jede 0 an einer lokalen Zeile eine Auskunft
  // (der Abruf nimmt die Marke nie an lokalen Zeilen, aber die Reparatur hat
  // dort nichts zu entscheiden) und bleibt stehen.
  const db = driftedCalendar();
  reconcileCriticalSchema(db);
  db.exec('DROP TRIGGER trg_calendar_events_updated_at');
  db.exec('UPDATE calendar_events SET series_authored = 0 WHERE id = 1');

  reconcileCriticalSchema(db);

  assert.equal(db.prepare('SELECT series_authored FROM calendar_events WHERE id = 1').get().series_authored, 0);
});
