import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[10]); // ics_subscriptions
db.exec(MIGRATIONS_SQL[11]); // calendar_events ics columns
db.exec(MIGRATIONS_SQL[61]); // feed token

console.log('\n[ICS-Export-Test]\n');

test('Migration 61 fügt calendar_feed_token hinzu', () => {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  assert(cols.includes('calendar_feed_token'), 'Spalte fehlt');
});

test('Feed-Token ist unique', () => {
  db.prepare(`INSERT INTO users (username,display_name,password_hash,calendar_feed_token) VALUES ('a','A','x','tok1')`).run();
  let threw = false;
  try { db.prepare(`INSERT INTO users (username,display_name,password_hash,calendar_feed_token) VALUES ('b','B','x','tok1')`).run(); }
  catch { threw = true; }
  assert(threw, 'UNIQUE sollte feuern');
});

test('Mehrere NULL-Token erlaubt (Partial-Index)', () => {
  db.prepare(`INSERT INTO users (username,display_name,password_hash) VALUES ('c','C','x')`).run();
  db.prepare(`INSERT INTO users (username,display_name,password_hash) VALUES ('d','D','x')`).run();
  assert(true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
