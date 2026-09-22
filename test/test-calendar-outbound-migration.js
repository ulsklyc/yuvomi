/**
 * Test: Migrationen v103-v106 gegen eine befüllte Bestands-DB (#593)
 * Zweck: Die vier Outbound-Migrationen fassen mit calendar_events eine Tabelle an,
 *        in der bei Bestandsnutzern alles steht - Termine, Anhänge, Zuweisungen,
 *        Sync-Zuordnungen. Diese Suite baut die echte Migrationskette bis v102 auf,
 *        befüllt sie und weist nach, dass v103-v106 rein additiv sind: kein
 *        Tabellen-Rebuild, kein verlorener Wert, keine verletzte Fremdschlüssel-
 *        Beziehung, Trigger und Indizes unverändert. Prüft außerdem, dass die
 *        neuen Marker auf den neutralen Werten stehen, damit der erste Sync nach
 *        dem Update nichts beim Provider anfasst.
 * Ausführen: node --test test/test-calendar-outbound-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei: db.js migriert beim Modul-Load.
// Geprüft werden hier nur die exportierten Migrations-SQLs gegen eine eigens
// aufgebaute Vor-v103-DB.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-calmig-'), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const OUTBOUND_VERSIONS = [103, 104, 105, 106];

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  migration.afterUp?.(db);
}

/** Echte Migrationskette bis v102 - der Stand, den ein Bestandsnutzer mitbringt. */
function buildPreOutboundDatabase() {
  const db = new Database(join(tempDir('yuvomi-calmig-'), 'db.sqlite'));
  for (const migration of MIGRATIONS.filter((m) => m.version <= 102)) {
    applyMigration(db, migration);
  }
  return db;
}

/** Termine, wie sie über die Jahre entstanden sind: lokal, gespiegelt, Altbestand. */
function seed(db) {
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1,'admin','Admin','x','admin')").run();
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (2,'maria','Maria','x','member')").run();

  const calRef = db.prepare(
    "INSERT INTO external_calendars (source, external_id, name, color) VALUES ('google','fam@g','Familie','#34A853') RETURNING id"
  ).get().id;

  const rows = [
    // rein lokaler Termin mit Serie und Zuweisung
    { title: 'Elternabend', start_datetime: '2026-09-01T19:00', end_datetime: '2026-09-01T21:00',
      external_source: 'local', external_calendar_id: null, calendar_ref_id: null,
      target_google_calendar_id: null, recurrence_rule: 'FREQ=MONTHLY', user_modified: 0 },
    // gespiegelter Google-Termin
    { title: 'Zahnarzt', start_datetime: '2026-09-05T08:30', end_datetime: '2026-09-05T09:15',
      external_source: 'google', external_calendar_id: 'gev-alt-1', calendar_ref_id: calRef,
      target_google_calendar_id: 'fam@g', recurrence_rule: null, user_modified: 1 },
    // Altbestand: gespiegelt, aber ohne calendar_ref_id, und mit einem Ziel, das
    // vom tatsächlichen Kalender abweicht (war folgenlos setzbar)
    { title: 'Urlaub', start_datetime: '2026-07-01', end_datetime: '2026-07-14',
      external_source: 'google', external_calendar_id: 'gev-alt-2', calendar_ref_id: null,
      target_google_calendar_id: 'anderer@g', recurrence_rule: null, user_modified: 0 },
  ];

  const insert = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, external_source, external_calendar_id,
       calendar_ref_id, target_google_calendar_id, recurrence_rule, user_modified, created_by)
    VALUES (@title, @start_datetime, @end_datetime, @external_source, @external_calendar_id,
       @calendar_ref_id, @target_google_calendar_id, @recurrence_rule, @user_modified, 1)
  `);
  const ids = rows.map((r) => insert.run(r).lastInsertRowid);

  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 2)').run(ids[0]);
  return { ids, calRef, rows };
}

function snapshot(db) {
  return db.prepare('SELECT * FROM calendar_events ORDER BY id').all();
}

function tableSql(db, name) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(name)?.sql;
}

test('die Outbound-Migrationen sind additiv - Bestandsdaten bleiben unverändert', () => {
  const db = buildPreOutboundDatabase();
  const seeded = seed(db);
  const before = snapshot(db);
  assert.equal(before.length, 3);

  for (const version of OUTBOUND_VERSIONS) {
    applyMigration(db, MIGRATIONS.find((m) => m.version === version));
  }

  const after = snapshot(db);
  assert.equal(after.length, 3, 'keine Zeile darf verschwinden');
  for (const [i, row] of after.entries()) {
    for (const [key, value] of Object.entries(before[i])) {
      assert.deepEqual(row[key], value, `Feld ${key} von Termin ${row.id} hat sich geändert`);
    }
  }

  // Verknüpfte Zuweisung überlebt (bei einem Tabellen-Rebuild das erste Opfer).
  const assignments = db.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?').all(seeded.ids[0]);
  assert.deepEqual(assignments, [{ user_id: 2 }]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('calendar_events wird nicht neu aufgebaut, nur erweitert', () => {
  const db = buildPreOutboundDatabase();
  const sqlBefore = tableSql(db, 'calendar_events');
  const triggersBefore = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='calendar_events' ORDER BY name"
  ).all();
  const indexesBefore = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='calendar_events' AND sql IS NOT NULL ORDER BY name"
  ).all();

  for (const version of OUTBOUND_VERSIONS) {
    applyMigration(db, MIGRATIONS.find((m) => m.version === version));
  }

  // ADD COLUMN hängt die Spalte an die bestehende Definition an; ein Rebuild
  // würde die Definition komplett ersetzen.
  const sqlAfter = tableSql(db, 'calendar_events');
  assert.ok(sqlAfter.startsWith(sqlBefore.slice(0, sqlBefore.lastIndexOf(')'))),
    'die bestehende Tabellendefinition muss erhalten bleiben');

  const triggersAfter = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='calendar_events' ORDER BY name"
  ).all();
  assert.deepEqual(triggersAfter, triggersBefore, 'Trigger dürfen nicht verloren gehen');

  const indexesAfter = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='calendar_events' AND sql IS NOT NULL ORDER BY name"
  ).all();
  for (const idx of indexesBefore) {
    assert.ok(indexesAfter.some((i) => i.name === idx.name), `Index ${idx.name} fehlt nach der Migration`);
  }
});

test('die neuen Marker starten neutral - der erste Sync fasst nichts beim Provider an', () => {
  const db = buildPreOutboundDatabase();
  seed(db);
  for (const version of OUTBOUND_VERSIONS) {
    applyMigration(db, MIGRATIONS.find((m) => m.version === version));
  }

  for (const row of snapshot(db)) {
    assert.equal(row.outbound_dirty, 0, `Termin ${row.id} dürfte keinen Push auslösen`);
    assert.equal(row.outbound_attempts, 0);
    assert.equal(row.outbound_move_to, null, `Termin ${row.id} dürfte keinen Umzug auslösen`);
    assert.equal(row.external_object_url, null, `Termin ${row.id} hat noch keine bekannte Objekt-URL`);
  }
  // Auch der Altbestand mit abweichendem Ziel (anderer@g vs. kein calendar_ref_id)
  // steht auf neutral - genau der Fall, der sonst still umziehen würde.
  const legacy = snapshot(db).find((r) => r.external_calendar_id === 'gev-alt-2');
  assert.equal(legacy.target_google_calendar_id, 'anderer@g');
  assert.equal(legacy.outbound_move_to, null);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM calendar_pending_deletions').get().c, 0,
    'ohne Nutzeraktion darf keine Löschung vorgemerkt sein');
});

test('v103 ist gegen eine bereits vorhandene Tabelle idempotent', () => {
  const db = buildPreOutboundDatabase();
  const v103 = MIGRATIONS.find((m) => m.version === 103);
  applyMigration(db, v103);
  assert.doesNotThrow(() => applyMigration(db, v103), 'CREATE TABLE IF NOT EXISTS muss ein zweites Mal durchlaufen');
});
