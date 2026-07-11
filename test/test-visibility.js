/**
 * Modul: Sichtbarkeits-Test (#474)
 * Zweck: Prüft die serverseitige Durchsetzung (visibilityWhere) für Aufgaben und
 *        Termine — all | assignees | private, ohne Admin-Bypass — sowie
 *        normalizeVisibility.
 * Ausführen: node --experimental-sqlite test/test-visibility.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { visibilityWhere, normalizeVisibility, VISIBILITY_VALUES } from '../server/services/visibility.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')));`);
db.exec(MIGRATIONS_SQL[1]);

// Anna (admin), Ben, Cara
const anna = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES ('anna','Anna','x','#007AFF','admin')`).run().lastInsertRowid;
const ben  = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('ben','Ben','x','#34C759')`).run().lastInsertRowid;
const cara = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('cara','Cara','x','#AF52DE')`).run().lastInsertRowid;

console.log('\n[Visibility-Test] Durchsetzung (#474)\n');

// --- Aufgaben: Anna ist Erstellerin, Ben ist zugewiesen ---
function mkTask(visibility, assignee) {
  const id = db.prepare(`INSERT INTO tasks (title, created_by, visibility) VALUES ('t', ?, ?)`).run(anna, visibility).lastInsertRowid;
  if (assignee) db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, assignee);
  return id;
}
const tAll    = mkTask('all', ben);
const tAssign = mkTask('assignees', ben);
const tPriv   = mkTask('private', ben);

const taskSql = `SELECT t.id FROM tasks t WHERE ${visibilityWhere('t','task_assignments','task_id')} ORDER BY t.id`;
const visibleTasks = (viewer) => db.prepare(taskSql).all(viewer, viewer).map((r) => r.id);

test('Ersteller (Anna) sieht alle eigenen Aufgaben, inkl. private', () => {
  eq(visibleTasks(anna), [tAll, tAssign, tPriv], 'Anna');
});
test('Zugewiesener (Ben) sieht all + assignees, nicht private', () => {
  eq(visibleTasks(ben), [tAll, tAssign], 'Ben');
});
test('Unbeteiligte (Cara) sieht nur all — kein Admin-Bypass greift für private/assignees', () => {
  eq(visibleTasks(cara), [tAll], 'Cara');
});

// --- Termine: analog ---
function mkEvent(visibility, assignee) {
  const id = db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, visibility) VALUES ('e','2026-01-01T10:00', ?, ?)`).run(anna, visibility).lastInsertRowid;
  if (assignee) db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, assignee);
  return id;
}
const eAll    = mkEvent('all', ben);
const eAssign = mkEvent('assignees', ben);
const ePriv   = mkEvent('private', ben);

const evSql = `SELECT e.id FROM calendar_events e WHERE ${visibilityWhere('e','event_assignments','event_id')} ORDER BY e.id`;
const visibleEvents = (viewer) => db.prepare(evSql).all(viewer, viewer).map((r) => r.id);

test('Termine: Ersteller sieht alle, Zugewiesener all+assignees, Fremde nur all', () => {
  eq(visibleEvents(anna), [eAll, eAssign, ePriv], 'Anna');
  eq(visibleEvents(ben),  [eAll, eAssign], 'Ben');
  eq(visibleEvents(cara), [eAll], 'Cara');
});

// --- Benannter Bind (@me), wie im Dashboard genutzt ---
test('visibilityWhere unterstützt benannten Platzhalter (@me)', () => {
  const sql = `SELECT t.id FROM tasks t WHERE ${visibilityWhere('t','task_assignments','task_id','@me')} ORDER BY t.id`;
  eq(db.prepare(sql).all({ me: cara }).map((r) => r.id), [tAll], 'Cara @me');
});

// --- normalizeVisibility ---
test('normalizeVisibility akzeptiert gültige Werte, fällt sonst auf Default zurück', () => {
  for (const v of VISIBILITY_VALUES) eq(normalizeVisibility(v), v, v);
  eq(normalizeVisibility('bogus'), 'all', 'ungültig → all');
  eq(normalizeVisibility(undefined), 'all', 'undefined → all');
  eq(normalizeVisibility('bogus', 'private'), 'private', 'eigener Fallback');
});

console.log(`\n[Visibility-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
