import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { syncFastingRemindersForUser } from '../server/services/fasting-reminders.js';
import { applyMigration, buildMigratedDatabase } from './helpers/migrated-database.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS } = await import('../server/db.js');
const REMINDER_MIGRATION_VERSION = 220;

function setup() {
  const database = buildMigratedDatabase(
    Database,
    MIGRATIONS.filter((migration) => migration.version < REMINDER_MIGRATION_VERSION),
    join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-reminders-')), 'db.sqlite'),
  );
  applyMigration(database, MIGRATIONS.find((migration) => migration.version === REMINDER_MIGRATION_VERSION));
  database.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, family_role)
    VALUES (1, 'a', 'A', 'hash', 'member', 'other')`).run();
  database.prepare(`INSERT INTO access_permissions
    (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', '1', 'capability', 'health_use_fasting', 'allow')`).run();
  database.prepare("INSERT INTO health_fasting_settings (user_id, default_goal_minutes, remind_goal, remind_next_start) VALUES (1, 960, 1, 1)").run();
  return database;
}

function seedReminderPair(database) {
  database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (1, '2026-09-09T06:00:00.000Z', '2026-09-09T22:00:00.000Z', 'UTC', 960)`).run();
  syncFastingRemindersForUser(database, 1, new Date('2026-09-09T21:00:00Z'));
  assert.equal(database.prepare('SELECT count(*) AS count FROM reminders').get().count, 2);
}

test('sync is idempotent and a later active fast cancels the earlier next-start reminder', () => {
  const database = setup();
  const fast = database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (1, '2026-09-09T16:00:00.000Z', '2026-09-10T00:00:00.000Z', 'Europe/Prague', 960)`).run().lastInsertRowid;
  const active = database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (1, '2026-09-10T06:00:00.000Z', NULL, 'Europe/Prague', 960)`).run().lastInsertRowid;
  syncFastingRemindersForUser(database, 1, new Date('2026-09-10T01:00:00Z'));
  syncFastingRemindersForUser(database, 1, new Date('2026-09-10T01:00:00Z'));
  const rows = database.prepare('SELECT entity_type, entity_id, remind_at, created_by FROM reminders ORDER BY entity_type').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, active);
  assert.deepEqual(rows.map((row) => row.entity_type), ['fasting_goal']);
  database.close();
});

test('no next-start reminder for a fast of 24 hours or longer', () => {
  const database = setup();
  database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (1, '2026-09-09T06:00:00.000Z', '2026-09-10T08:00:00.000Z', 'Europe/Prague', 960)`).run();
  syncFastingRemindersForUser(database, 1, new Date('2026-09-11T00:00:00Z'));
  assert.deepEqual(database.prepare('SELECT entity_type FROM reminders').all().map((row) => row.entity_type), []);
  database.close();
});

test('unavailable notifications cancel pending rows without erasing saved preferences', () => {
  const database = setup();
  seedReminderPair(database);
  database.prepare('UPDATE health_fasting_settings SET default_goal_minutes = 1440').run();
  syncFastingRemindersForUser(database, 1, new Date('2026-09-09T21:00:00Z'));
  assert.equal(database.prepare("SELECT count(*) n FROM reminders WHERE entity_type='fasting_next_start'").get().n, 0);
  database.prepare('UPDATE health_fasting_settings SET default_goal_minutes = NULL').run();
  syncFastingRemindersForUser(database, 1, new Date('2026-09-09T21:00:00Z'));
  assert.equal(database.prepare('SELECT count(*) n FROM reminders').get().n, 0);
  assert.equal(database.prepare('SELECT remind_goal FROM health_fasting_settings').get().remind_goal, 1);
  database.close();
});

test('household Health disablement removes pending fasting reminders', () => {
  const database = setup();
  seedReminderPair(database);
  database.prepare(`INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '["health"]')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  syncFastingRemindersForUser(database, 1, new Date('2026-09-09T21:00:00Z'));
  assert.equal(database.prepare(`SELECT count(*) AS count FROM reminders
    WHERE entity_type IN ('fasting_goal', 'fasting_next_start')`).get().count, 0);
  database.close();
});

for (const permission of [
  { resourceType: 'capability', resourceKey: 'health_use_fasting' },
  { resourceType: 'module', resourceKey: 'health' },
]) {
  test(`${permission.resourceType} denial removes pending fasting reminders`, () => {
    const database = setup();
    seedReminderPair(database);
    database.prepare(`INSERT INTO access_permissions
      (subject_type, subject_id, resource_type, resource_key, access)
      VALUES ('user', '1', ?, ?, 'none')
      ON CONFLICT(subject_type, subject_id, resource_type, resource_key)
      DO UPDATE SET access = excluded.access`).run(permission.resourceType, permission.resourceKey);
    syncFastingRemindersForUser(database, 1, new Date('2026-09-09T21:00:00Z'));
    assert.equal(database.prepare(`SELECT count(*) AS count FROM reminders
      WHERE entity_type IN ('fasting_goal', 'fasting_next_start')`).get().count, 0);
    database.close();
  });
}

test('a later fast stably cancels an earlier next-start reminder', () => {
  const database = setup();
  database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (1, '2026-09-10T00:00:00.000Z', '2026-09-10T08:00:00.000Z', 'UTC', 960)`).run();
  database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (1, '2026-09-10T10:00:00.000Z', NULL, 'UTC', 960)`).run();
  for (let pass = 0; pass < 3; pass++) {
    syncFastingRemindersForUser(database, 1, new Date('2026-09-10T09:00:00Z'));
    assert.equal(database.prepare("SELECT count(*) n FROM reminders WHERE entity_type='fasting_next_start'").get().n, 0, `pass ${pass + 1}`);
  }
  database.close();
});

for (const terminal of ['dismissed', 'pushed']) {
  test(`unchanged future ${terminal} reminder is not recreated`, () => {
    const database = setup();
    const fastId = database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
      VALUES (1, '2026-09-10T00:00:00.000Z', '2026-09-10T08:00:00.000Z', 'UTC', 960)`).run().lastInsertRowid;
    syncFastingRemindersForUser(database, 1, new Date('2026-09-10T09:00:00Z'));
    const row = database.prepare("SELECT * FROM reminders WHERE entity_type='fasting_next_start' AND entity_id = ?").get(fastId);
    if (terminal === 'dismissed') database.prepare('UPDATE reminders SET dismissed = 1 WHERE id = ?').run(row.id);
    else database.prepare("UPDATE reminders SET pushed_at = '2026-09-10T09:30:00.000Z' WHERE id = ?").run(row.id);
    for (let pass = 0; pass < 3; pass++) syncFastingRemindersForUser(database, 1, new Date('2026-09-10T09:00:00Z'));
    const rows = database.prepare("SELECT id, dismissed, pushed_at FROM reminders WHERE entity_type='fasting_next_start' AND entity_id = ?").all(fastId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, row.id);
    assert.equal(rows[0].dismissed, terminal === 'dismissed' ? 1 : 0);
    assert.equal(rows[0].pushed_at, terminal === 'pushed' ? '2026-09-10T09:30:00.000Z' : null);
    database.close();
  });
}
