import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { applyMigration, buildMigratedDatabase } from './helpers/migrated-database.js';
import {
  createFast, finishFast, updateFast, deleteFast, getFastingState,
  acknowledgeSafety, updateFastingSettings, FastingError,
} from '../server/services/fasting.js';
import { tempDir } from './tmp-dir.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS } = await import('../server/db.js');
const REMINDER_MIGRATION_VERSION = 220;

function setup(path = join(tempDir('yuvomi-fasting-service-'), 'db.sqlite')) {
  const database = buildMigratedDatabase(
    Database,
    MIGRATIONS.filter((migration) => migration.version < REMINDER_MIGRATION_VERSION),
    path,
  );
  applyMigration(database, MIGRATIONS.find((migration) => migration.version === REMINDER_MIGRATION_VERSION));
  const insertUser = database.prepare(`INSERT INTO users
    (id, username, display_name, password_hash, role, family_role)
    VALUES (?, ?, ?, 'hash', ?, ?)`);
  insertUser.run(1, 'owner', 'Owner', 'member', 'parent');
  insertUser.run(2, 'caregiver', 'Caregiver', 'member', 'parent');
  insertUser.run(3, 'admin', 'Admin', 'admin', 'parent');
  insertUser.run(4, 'disabled', 'Disabled', 'member', 'other');
  const allowFasting = database.prepare(`INSERT INTO access_permissions
    (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')`);
  allowFasting.run('1');
  allowFasting.run('2');
  return database;
}

const actor = (id) => ({ id });
const base = (overrides = {}) => ({
  userId: 1,
  startAt: '2026-09-13T08:00:00+02:00',
  startTzid: 'Europe/Prague',
  goalMinutes: 960,
  acknowledgeSafety: true,
  ...overrides,
});

test('forced reminder reconciliation failures roll back lifecycle and settings writes', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  let failSync = true;
  const failingCreate = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql) => {
        if (failSync && /^SELECT \* FROM health_fasting_settings/.test(sql)) throw new Error('forced reminder sync failure');
        return target.prepare(sql);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.throws(() => createFast(failingCreate, actor(1), base({ acknowledgeSafety: false })), /forced reminder sync failure/);
  assert.equal(database.prepare('SELECT count(*) AS count FROM health_fasts').get().count, 0);

  failSync = false;
  updateFastingSettings(database, actor(1), { defaultGoalMinutes: 960 }, 1);
  const active = createFast(database, actor(1), base({ acknowledgeSafety: false }));
  const beforeActive = database.prepare('SELECT * FROM health_fasts WHERE id = ?').get(active.id);
  const beforeSettings = database.prepare('SELECT * FROM health_fasting_settings WHERE user_id = 1').get();
  let settingsReads = 0;
  const failingSettings = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql) => {
        if (/^SELECT \* FROM health_fasting_settings/.test(sql) && ++settingsReads === 3) throw new Error('forced settings sync failure');
        return target.prepare(sql);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.throws(() => updateFastingSettings(failingSettings, actor(1), {
    defaultGoalMinutes: 720,
    activeId: active.id,
    expectedRevision: active.revision,
  }, 1), /forced settings sync failure/);
  assert.deepEqual(database.prepare('SELECT * FROM health_fasts WHERE id = ?').get(active.id), beforeActive);
  assert.deepEqual(database.prepare('SELECT * FROM health_fasting_settings WHERE user_id = 1').get(), beforeSettings);
  database.close();
});

test('a failure after the first reminder write leaves the reminders as they were (own transaction)', async () => {
  // syncFastingRemindersForUser called on its own, outside a lifecycle write: its
  // delete of a stale reminder and its insert of the wanted one stand or fall together.
  const { syncFastingRemindersForUser } = await import('../server/services/fasting-reminders.js');
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  updateFastingSettings(database, actor(1), { defaultGoalMinutes: 960 }, 1);
  database.prepare('UPDATE health_fasting_settings SET remind_goal = 1 WHERE user_id = 1').run();
  const fast = createFast(database, actor(1), base({ acknowledgeSafety: false }));
  database.prepare('DELETE FROM reminders').run();
  database.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('fasting_goal', ?, '2026-09-13T09:00:00.000Z', 1)`).run(fast.id + 1000);
  const before = database.prepare('SELECT * FROM reminders ORDER BY id').all();
  const failingInsert = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (/** @type {string} */ sql) => {
        if (/^\s*INSERT INTO reminders/.test(sql)) throw new Error('forced reminder insert failure');
        return target.prepare(sql);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const now = new Date('2026-09-13T05:00:00Z');
  assert.throws(() => syncFastingRemindersForUser(failingInsert, 1, now), /forced reminder insert failure/);
  assert.deepEqual(database.prepare('SELECT * FROM reminders ORDER BY id').all(), before, 'the stale reminder is gone without its replacement');
  // Without the failure the same call replaces the stale row with the wanted one.
  syncFastingRemindersForUser(database, 1, now);
  assert.deepEqual(database.prepare('SELECT entity_id FROM reminders').all().map((/** @type {any} */ r) => r.entity_id), [fast.id]);
  database.close();
});
