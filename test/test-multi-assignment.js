/**
 * Modul: Multi-Assignment-Test
 * Zweck: Validiert Multi-Personen-Zuweisung für Tasks und Kalendereinträge
 * Ausführen: node test-multi-assignment.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

// Testdaten
const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES ('anna', 'Anna', 'x', '#007AFF', 'admin')`).run();
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('max', 'Max', 'x', '#34C759')`).run();
const u3 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('lisa', 'Lisa', 'x', '#FF9500')`).run();
const uid1 = u1.lastInsertRowid;
const uid2 = u2.lastInsertRowid;
const uid3 = u3.lastInsertRowid;

console.log('\n[Multi-Assignment-Test] Tasks\n');

let taskId1, taskId2;

test('Task mit einem Zugewiesenen erstellen', () => {
  const r = db.prepare(`INSERT INTO tasks (title, category, priority, status, assigned_to, created_by)
    VALUES ('Aufgabe 1', 'misc', 'low', 'open', ?, ?)`).run(uid1, uid1);
  taskId1 = r.lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId1, uid1);
  assert(taskId1 > 0, 'ID muss > 0 sein');
});

test('Zweiten Benutzer zur gleichen Aufgabe hinzufügen', () => {
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId1, uid2);
  const rows = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(taskId1);
  assert(rows.length === 2, `Erwartet 2 Assignments, erhalten ${rows.length}`);
});

test('Dritten Benutzer zur Aufgabe hinzufügen', () => {
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId1, uid3);
  const rows = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(taskId1);
  assert(rows.length === 3, `Erwartet 3 Assignments, erhalten ${rows.length}`);
});

test('Duplicate-Assignment wird ignoriert (PRIMARY KEY)', () => {
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId1, uid1);
  const rows = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(taskId1);
  assert(rows.length === 3, `Erwartet weiterhin 3, erhalten ${rows.length}`);
});

test('JSON-Aggregation der zugewiesenen User', () => {
  const row = db.prepare(`
    SELECT json_group_array(json_object('id', u.id, 'display_name', u.display_name, 'color', u.avatar_color))
           AS assigned_users_json
    FROM task_assignments ta JOIN users u ON u.id = ta.user_id
    WHERE ta.task_id = ?
  `).get(taskId1);
  const users = JSON.parse(row.assigned_users_json);
  assert(users.length === 3, `Erwartet 3 User-Objekte, erhalten ${users.length}`);
  assert(users.every((u) => u.id && u.display_name && u.color), 'Alle Felder müssen vorhanden sein');
});

test('Filter per EXISTS: Aufgaben für Benutzer 2 finden', () => {
  const r2 = db.prepare(`INSERT INTO tasks (title, category, priority, status, assigned_to, created_by)
    VALUES ('Aufgabe 2', 'misc', 'low', 'open', ?, ?)`).run(uid2, uid1);
  taskId2 = r2.lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId2, uid2);

  const rows = db.prepare(`
    SELECT t.id FROM tasks t
    WHERE EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.user_id = ?)
  `).all(uid2);
  assert(rows.length === 2, `uid2 sollte in 2 Tasks sein, erhalten ${rows.length}`);
});

test('Filter: Aufgaben nur für Benutzer 3', () => {
  const rows = db.prepare(`
    SELECT t.id FROM tasks t
    WHERE EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.user_id = ?)
  `).all(uid3);
  assert(rows.length === 1, `uid3 sollte in 1 Task sein, erhalten ${rows.length}`);
  assert(rows[0].id === taskId1, 'Falsche Task-ID gefunden');
});

test('Assignments ersetzen (DELETE + INSERT)', () => {
  db.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId1);
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId1, uid3);
  const rows = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(taskId1);
  assert(rows.length === 1, `Nach Ersetzen soll 1 Assignment sein, erhalten ${rows.length}`);
  assert(rows[0].user_id === uid3, 'Falscher User nach Ersetzen');
});

test('CASCADE: Assignments werden beim Task-Löschen mitgelöscht', () => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId1);
  const rows = db.prepare('SELECT * FROM task_assignments WHERE task_id = ?').all(taskId1);
  assert(rows.length === 0, `Assignments sollen gelöscht sein, erhalten ${rows.length}`);
});

test('CASCADE: Assignments werden beim User-Löschen entfernt', () => {
  db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId2, uid3);
  db.prepare('DELETE FROM users WHERE id = ?').run(uid3);
  const rows = db.prepare('SELECT * FROM task_assignments WHERE user_id = ?').all(uid3);
  assert(rows.length === 0, 'user_id-Referenz soll entfernt sein');
});

console.log('\n[Multi-Assignment-Test] Kalendereinträge\n');

let eventId1;

const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

test('Event mit zwei Zugewiesenen erstellen', () => {
  const r = db.prepare(`INSERT INTO calendar_events
    (title, start_datetime, all_day, color, icon, assigned_to, created_by, external_source)
    VALUES ('Termin', ?, 0, '#007AFF', 'calendar', ?, ?, 'local')`).run(`${tomorrow}T10:00`, uid1, uid1);
  eventId1 = r.lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(eventId1, uid1);
  db.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(eventId1, uid2);
  const rows = db.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?').all(eventId1);
  assert(rows.length === 2, `Erwartet 2 Event-Assignments, erhalten ${rows.length}`);
});

test('Event-Assignments JSON-Aggregation', () => {
  const row = db.prepare(`
    SELECT json_group_array(json_object('id', u.id, 'display_name', u.display_name, 'color', u.avatar_color))
           AS assigned_users_json
    FROM event_assignments ea JOIN users u ON u.id = ea.user_id
    WHERE ea.event_id = ?
  `).get(eventId1);
  const users = JSON.parse(row.assigned_users_json);
  assert(users.length === 2, `Erwartet 2, erhalten ${users.length}`);
});

test('EXISTS-Filter für Events', () => {
  const rows = db.prepare(`
    SELECT e.id FROM calendar_events e
    WHERE EXISTS (SELECT 1 FROM event_assignments ea WHERE ea.event_id = e.id AND ea.user_id = ?)
  `).all(uid2);
  assert(rows.length === 1, `uid2 soll in 1 Event sein, erhalten ${rows.length}`);
});

test('CASCADE: Event-Assignments beim Event-Löschen entfernt', () => {
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId1);
  const rows = db.prepare('SELECT * FROM event_assignments WHERE event_id = ?').all(eventId1);
  assert(rows.length === 0, `Event-Assignments sollen gelöscht sein, erhalten ${rows.length}`);
});

console.log(`\n[Multi-Assignment-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
