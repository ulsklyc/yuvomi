import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-migration-')), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');
const migration = MIGRATIONS.find((item) => item.version === 197);

function migrated() {
  const database = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-migration-')), 'db.sqlite'));
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL); INSERT INTO users VALUES (1, 'a'), (2, 'b');`);
  database.exec(migration.up);
  return database;
}

test('v197 creates fasting records and sparse settings', () => {
  const database = migrated();
  assert.deepEqual(database.prepare('PRAGMA table_info(health_fasts)').all().map((row) => row.name), [
    'id', 'user_id', 'start_at', 'end_at', 'start_tzid', 'goal_minutes', 'rating', 'note',
    'visibility', 'revision', 'created_by', 'updated_by', 'created_at', 'updated_at',
  ]);
  assert.deepEqual(database.prepare('PRAGMA table_info(health_fasting_settings)').all().map((row) => row.name), [
    'user_id', 'default_goal_minutes', 'zone_mode', 'safety_acknowledged_at',
    'safety_acknowledged_by', 'created_at', 'updated_at',
  ]);
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'health_fasts'").all().map((row) => row.name);
  assert.ok(indexes.includes('idx_health_fasts_one_active'));
  database.close();
});

test('v197 enforces one active fast, note/rating/goal bounds and audit FK actions', () => {
  const database = migrated();
  database.pragma('foreign_keys = ON');
  const insert = database.prepare(`INSERT INTO health_fasts
    (user_id, start_at, start_tzid, goal_minutes, rating, note, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(1, '2026-09-13T08:00:00.000Z', 'Europe/Prague', 960, 5, 'ok', 1, 1);
  assert.throws(() => insert.run(1, '2026-09-13T09:00:00.000Z', 'Europe/Prague', 960, null, null, 1, 1), /UNIQUE/);
  assert.throws(() => insert.run(2, '2026-09-13T09:00:00.000Z', 'Europe/Prague', 61, null, null, 1, 1), /CHECK/);
  assert.throws(() => insert.run(2, '2026-09-13T09:00:00.000Z', 'Europe/Prague', 960, 6, null, 1, 1), /CHECK/);
  assert.throws(() => insert.run(2, '2026-09-13T09:00:00.000Z', 'Europe/Prague', 960, null, 'x'.repeat(2001), 1, 1), /CHECK/);
  database.prepare('DELETE FROM users WHERE id = 1').run();
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM health_fasts').get().count, 0);
  assert.equal(database.prepare('PRAGMA foreign_key_list(health_fasts)').all().filter((row) => row.from === 'created_by')[0].on_delete, 'SET NULL');
  database.close();
});
