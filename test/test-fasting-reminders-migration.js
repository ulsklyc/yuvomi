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
const reminderMigration = MIGRATIONS.find((item) => item.version === 198);

function migrated() {
  const database = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-migration-')), 'db.sqlite'));
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL); INSERT INTO users VALUES (1, 'a'), (2, 'b');`);
  database.exec(migration.up);
  return database;
}

function migratedWithReminderWidening() {
  const database = migrated();
  database.exec(`CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry')),
    entity_id INTEGER NOT NULL, remind_at TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    pushed_at TEXT, assigned_from INTEGER REFERENCES users(id) ON DELETE SET NULL
  );`);
  database.exec(reminderMigration.up);
  return database;
}

test('v198 widens reminder entities and adds opt-in switches', () => {
  const database = migratedWithReminderWidening();
  const columns = database.prepare('PRAGMA table_info(health_fasting_settings)').all().map((row) => row.name);
  assert.deepEqual(columns.slice(-2), ['remind_goal', 'remind_next_start']);
  database.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('fasting_goal', 1, '2026-09-13T12:00:00.000Z', 1)").run();
  assert.equal(database.prepare('SELECT entity_type FROM reminders').get().entity_type, 'fasting_goal');
  database.close();
});
