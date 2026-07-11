/**
 * Modul: Sync-Standard-Zuweisung-Test (#459)
 * Zweck: Prüft assignDefaultToEvent — neue Sync-Termine erhalten die konfigurierte
 *        Standard-Person; No-op bei fehlender/verwaister Person; überschreibt keine
 *        bestehende Zuweisung.
 * Ausführen: node --experimental-sqlite test/test-sync-default-assignee.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { assignDefaultToEvent } from '../server/services/sync-assignment.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')));`);
db.exec(MIGRATIONS_SQL[1]);

const ben = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('ben','Ben','x','#34C759')`).run().lastInsertRowid;
const cara = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('cara','Cara','x','#AF52DE')`).run().lastInsertRowid;

function mkEvent(assignedTo = null) {
  return db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, assigned_to) VALUES ('e','2026-01-01T10:00', ?, ?)`)
    .run(ben, assignedTo).lastInsertRowid;
}
const assignments = (id) => db.prepare('SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id').all(id).map((r) => r.user_id);
const assignedTo = (id) => db.prepare('SELECT assigned_to FROM calendar_events WHERE id = ?').get(id).assigned_to;

console.log('\n[Sync-Default-Assignee-Test] #459\n');

test('weist neuen Termin der Standard-Person zu (assigned_to + event_assignments)', () => {
  const id = mkEvent();
  assignDefaultToEvent(db, id, ben);
  assert(assignedTo(id) === ben, 'assigned_to gesetzt');
  assert(JSON.stringify(assignments(id)) === JSON.stringify([ben]), 'event_assignments-Zeile angelegt');
});

test('No-op ohne konfigurierte Person (userId null)', () => {
  const id = mkEvent();
  assignDefaultToEvent(db, id, null);
  assert(assignedTo(id) === null, 'assigned_to bleibt null');
  assert(assignments(id).length === 0, 'keine Zuweisung');
});

test('No-op bei verwaister Person (nicht existierende User-ID)', () => {
  const id = mkEvent();
  assignDefaultToEvent(db, id, 9999);
  assert(assignedTo(id) === null, 'assigned_to bleibt null');
  assert(assignments(id).length === 0, 'keine Zuweisung');
});

test('überschreibt eine bestehende assigned_to nicht (nur wenn null)', () => {
  const id = mkEvent(cara);
  assignDefaultToEvent(db, id, ben);
  assert(assignedTo(id) === cara, 'bestehende assigned_to bleibt Cara');
  // event_assignments ist additiv (INSERT OR IGNORE): die Standard-Person kommt
  // hinzu, ohne die remote-geführte assigned_to zu ersetzen.
  assert(JSON.stringify(assignments(id)) === JSON.stringify([ben]), 'Ben additiv ergänzt');
});

test('idempotent — doppelter Aufruf legt keine Duplikate an', () => {
  const id = mkEvent();
  assignDefaultToEvent(db, id, ben);
  assignDefaultToEvent(db, id, ben);
  assert(JSON.stringify(assignments(id)) === JSON.stringify([ben]), 'keine Duplikate');
});

console.log(`\n[Sync-Default-Assignee-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
