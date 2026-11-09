/**
 * Modul: Reminders-Test
 * Zweck: Validiert DB-Schema und Abfragen für Erinnerungen
 * Ausführen: node test-reminders.js
 */

import { DatabaseSync } from 'node:sqlite';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

// Hilfsfunktion: SQL-Block in Einzelstatements aufteilen und ausführen
function runSQL(database, sqlBlock) {
  const statements = sqlBlock.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    database.prepare(stmt).run();
  }
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

// Minimales Schema aufbauen: users + calendar_events + reminders
runSQL(db, `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    avatar_color  TEXT    NOT NULL DEFAULT '#007AFF',
    role          TEXT    NOT NULL DEFAULT 'member',
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);

runSQL(db, `
  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    category   TEXT    NOT NULL DEFAULT 'Sonstiges',
    status     TEXT    NOT NULL DEFAULT 'open',
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  )
`);

runSQL(db, `
  CREATE TABLE IF NOT EXISTS calendar_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT    NOT NULL,
    start_datetime   TEXT    NOT NULL,
    created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_source  TEXT    NOT NULL DEFAULT 'local'
  )
`);

runSQL(db, `
  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event')),
    entity_id   INTEGER NOT NULL,
    remind_at   TEXT    NOT NULL,
    dismissed   INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);

runSQL(db, `
  CREATE INDEX IF NOT EXISTS idx_reminders_entity ON reminders(entity_type, entity_id)
`);

runSQL(db, `
  CREATE INDEX IF NOT EXISTS idx_reminders_remind ON reminders(remind_at)
`);

runSQL(db, `
  CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(created_by)
`);

// Testdaten anlegen
const u1    = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('admin', 'Anna', 'x', '#007AFF')`).run();
const uid1  = u1.lastInsertRowid;

const task1 = db.prepare(`INSERT INTO tasks (title, created_by) VALUES ('Steuererklärung', ?)`).run(uid1);
const taskId = task1.lastInsertRowid;

const ev1   = db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by)
  VALUES ('Zahnarzt', '2026-05-01T10:00', ?)`).run(uid1);
const evId  = ev1.lastInsertRowid;

const now    = new Date().toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16);
const past   = new Date(Date.now() - 3_600_000).toISOString().slice(0, 16);

console.log('\n[Reminders-Test] Schema + CRUD + Pending-Abfragen\n');

// --------------------------------------------------------
// Erstellen
// --------------------------------------------------------

let reminderId1, reminderId2;

test('Erinnerung für Aufgabe erstellen', () => {
  const r = db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('task', ?, ?, ?)`).run(taskId, future, uid1);
  reminderId1 = r.lastInsertRowid;
  assert(reminderId1 > 0, 'Keine lastInsertRowid');
});

test('Erinnerung für Event erstellen', () => {
  const r = db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, ?, ?)`).run(evId, past, uid1);
  reminderId2 = r.lastInsertRowid;
  assert(reminderId2 > 0, 'Keine lastInsertRowid');
});

// --------------------------------------------------------
// Lesen
// --------------------------------------------------------

test('Erinnerung nach entity_type + entity_id laden', () => {
  const row = db.prepare(`SELECT * FROM reminders
    WHERE entity_type = 'task' AND entity_id = ? AND created_by = ?`).get(taskId, uid1);
  assert(row !== null && row !== undefined, 'Keine Zeile zurückgegeben');
  assert(row.entity_type === 'task', 'Falscher entity_type');
  assert(row.dismissed === 0, 'dismissed sollte 0 sein');
});

test('Pending-Abfrage liefert nur fällige (remind_at <= now)', () => {
  const rows = db.prepare(`SELECT * FROM reminders
    WHERE created_by = ? AND dismissed = 0 AND remind_at <= ?`).all(uid1, now);
  assert(rows.length === 1, `Erwartet 1, erhalten ${rows.length}`);
  assert(rows[0].entity_type === 'event', 'Falscher entity_type in Pending-Abfrage');
});

test('Zukunfts-Reminder erscheint nicht in Pending', () => {
  const rows = db.prepare(`SELECT * FROM reminders
    WHERE created_by = ? AND dismissed = 0 AND remind_at <= ?`).all(uid1, now);
  const futureFound = rows.some((r) => r.id === reminderId1);
  assert(!futureFound, 'Zukünftiger Reminder in Pending-Liste');
});

// --------------------------------------------------------
// Verwerfen (dismiss)
// --------------------------------------------------------

test('Erinnerung verwerfen', () => {
  db.prepare(`UPDATE reminders SET dismissed = 1 WHERE id = ?`).run(reminderId2);
  const row = db.prepare(`SELECT dismissed FROM reminders WHERE id = ?`).get(reminderId2);
  assert(row.dismissed === 1, 'dismissed ist nicht 1');
});

test('Verworfene Erinnerung erscheint nicht in Pending', () => {
  const rows = db.prepare(`SELECT * FROM reminders
    WHERE created_by = ? AND dismissed = 0 AND remind_at <= ?`).all(uid1, now);
  assert(rows.length === 0, `Erwartet 0 nach Dismiss, erhalten ${rows.length}`);
});

// --------------------------------------------------------
// Ersetzen (Upsert: erst löschen, dann neu einfügen)
// --------------------------------------------------------

test('Erinnerung ersetzen: alte löschen + neue einfügen', () => {
  db.prepare(`DELETE FROM reminders WHERE entity_type = 'task' AND entity_id = ? AND created_by = ?`)
    .run(taskId, uid1);
  const newFuture = new Date(Date.now() + 7_200_000).toISOString().slice(0, 16);
  db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('task', ?, ?, ?)`).run(taskId, newFuture, uid1);

  const rows = db.prepare(`SELECT * FROM reminders WHERE entity_type = 'task' AND entity_id = ?`)
    .all(taskId);
  assert(rows.length === 1, `Erwartet 1 Zeile nach Ersetzen, erhalten ${rows.length}`);
});

// --------------------------------------------------------
// Löschen
// --------------------------------------------------------

test('Alle Erinnerungen einer Entität löschen', () => {
  db.prepare(`DELETE FROM reminders WHERE entity_type = 'task' AND entity_id = ? AND created_by = ?`)
    .run(taskId, uid1);
  const rows = db.prepare(`SELECT * FROM reminders WHERE entity_type = 'task' AND entity_id = ?`)
    .all(taskId);
  assert(rows.length === 0, `Erwartet 0 nach Löschen, erhalten ${rows.length}`);
});

test('Nutzer-DELETE CASCADE: Erinnerungen werden mitgelöscht', () => {
  const u2    = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
    VALUES ('temp', 'Temp', 'x', '#FF0000')`).run();
  const tempUid = u2.lastInsertRowid;

  db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('task', ?, ?, ?)`).run(taskId, future, tempUid);

  db.prepare(`DELETE FROM users WHERE id = ?`).run(tempUid);

  const rows = db.prepare(`SELECT * FROM reminders WHERE created_by = ?`).all(tempUid);
  assert(rows.length === 0, 'Cascade-Delete hat nicht funktioniert');
});

// --------------------------------------------------------
// Constraints
// --------------------------------------------------------

test('Ungültiger entity_type wird abgelehnt', () => {
  let threw = false;
  try {
    db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES ('invalid', 1, ?, ?)`).run(future, uid1);
  } catch {
    threw = true;
  }
  assert(threw, 'CHECK-Constraint hat entity_type nicht abgelehnt');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------

console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
