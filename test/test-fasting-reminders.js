import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { syncFastingRemindersForUser } from '../server/services/fasting-reminders.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS } = await import('../server/db.js');

function setup() {
  const database = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-reminders-')), 'db.sqlite'));
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT NOT NULL DEFAULT 'member', family_role TEXT NOT NULL DEFAULT 'other');
    CREATE TABLE access_permissions (subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_key TEXT NOT NULL, access TEXT NOT NULL, updated_at TEXT);`);
  database.exec(`CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry')),
    entity_id INTEGER NOT NULL,
    remind_at TEXT NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    pushed_at TEXT,
    assigned_from INTEGER REFERENCES users(id) ON DELETE SET NULL
  );`);
  for (const version of [197, 198]) {
    const migration = MIGRATIONS.find((item) => item.version === version);
    if (typeof migration.up === 'function') migration.up(database); else database.exec(migration.up);
  }
  database.exec("INSERT INTO users VALUES (1, 'a', 'member', 'other')");
  database.prepare("INSERT INTO access_permissions VALUES ('user', '1', 'capability', 'health_use_fasting', 'allow', NULL)").run();
  database.prepare("INSERT INTO health_fasting_settings (user_id, default_goal_minutes, remind_goal, remind_next_start) VALUES (1, 960, 1, 1)").run();
  return database;
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
  database.prepare(`INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (1, '2026-09-09T06:00:00.000Z', '2026-09-09T22:00:00.000Z', 'UTC', 960)`).run();
  syncFastingRemindersForUser(database, 1, new Date('2026-09-09T21:00:00Z'));
  assert.equal(database.prepare('SELECT count(*) n FROM reminders').get().n, 2);
  database.prepare('UPDATE health_fasting_settings SET default_goal_minutes = 1440').run();
  syncFastingRemindersForUser(database, 1, new Date('2026-09-09T21:00:00Z'));
  assert.equal(database.prepare("SELECT count(*) n FROM reminders WHERE entity_type='fasting_next_start'").get().n, 0);
  database.prepare('UPDATE health_fasting_settings SET default_goal_minutes = NULL').run();
  syncFastingRemindersForUser(database, 1, new Date('2026-09-09T21:00:00Z'));
  assert.equal(database.prepare('SELECT count(*) n FROM reminders').get().n, 0);
  assert.equal(database.prepare('SELECT remind_goal FROM health_fasting_settings').get().remind_goal, 1);
  database.close();
});

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
