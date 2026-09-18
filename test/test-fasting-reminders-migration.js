import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { applyMigration, buildMigratedDatabase } from './helpers/migrated-database.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-migration-')), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');
const REMINDER_MIGRATION_VERSION = 219;
const reminderMigration = MIGRATIONS.find((item) => item.version === REMINDER_MIGRATION_VERSION);

function reminderTypes(database) {
  const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get().sql;
  const list = sql.match(/CHECK\s*\(\s*entity_type\s+IN\s*\(([^)]*)\)\s*\)/i)?.[1];
  assert.ok(list, 'reminders entity_type CHECK is present');
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function migratedWithReminderWidening() {
  const database = buildMigratedDatabase(
    Database,
    MIGRATIONS.filter((migration) => migration.version < REMINDER_MIGRATION_VERSION),
    join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-migration-')), 'db.sqlite'),
  );
  database.prepare(`INSERT INTO users (id, username, display_name, password_hash, role)
    VALUES (1, 'a', 'A', 'hash', 'member')`).run();
  const predecessorTypes = reminderTypes(database);
  database.prepare("INSERT INTO tasks (id, title, created_by) VALUES (10, 'Task', 1)").run();
  database.prepare("INSERT INTO calendar_events (id, title, start_datetime, end_datetime, created_by) VALUES (20, 'Event', '2026-09-13T09:00:00.000Z', '2026-09-13T10:00:00.000Z', 1)").run();
  const insert = database.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES (?, ?, '2026-09-13T12:00:00.000Z', 1)`);
  predecessorTypes.forEach((type, index) => insert.run(type, type === 'task' ? 10 : type === 'event' ? 20 : index + 100));
  applyMigration(database, reminderMigration);
  return { database, predecessorTypes };
}

test('v219 preserves v218 document reminders, widens reminder entities, and adds opt-in switches', () => {
  const { database, predecessorTypes } = migratedWithReminderWidening();
  const columns = database.prepare('PRAGMA table_info(health_fasting_settings)').all().map((row) => row.name);
  assert.deepEqual(columns.slice(-2), ['remind_goal', 'remind_next_start']);
  database.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('fasting_goal', 1, '2026-09-13T12:00:00.000Z', 1)").run();
  database.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('fasting_next_start', 1, '2026-09-13T13:00:00.000Z', 1)").run();
  assert.deepEqual(database.prepare('SELECT entity_type FROM reminders ORDER BY id').all().map((row) => row.entity_type), [
    ...predecessorTypes, 'fasting_goal', 'fasting_next_start',
  ]);
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_reminders_%_ad' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(triggers, ['trg_reminders_events_ad', 'trg_reminders_tasks_ad']);
  database.prepare('DELETE FROM tasks WHERE id = 10').run();
  database.prepare('DELETE FROM calendar_events WHERE id = 20').run();
  assert.deepEqual(database.prepare('SELECT entity_type FROM reminders ORDER BY id').all().map((row) => row.entity_type), [
    ...predecessorTypes.filter((type) => type !== 'task' && type !== 'event'),
    'fasting_goal', 'fasting_next_start',
  ]);
  database.close();
});
