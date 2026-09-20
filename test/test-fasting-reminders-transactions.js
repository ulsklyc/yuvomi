import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { applyMigration, buildMigratedDatabase } from './helpers/migrated-database.js';
import {
  createFast, finishFast, updateFast, deleteFast, getFastingState,
  acknowledgeSafety, updateFastingSettings, FastingError,
} from '../server/services/fasting.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS } = await import('../server/db.js');
const REMINDER_MIGRATION_VERSION = 220;

function setup(path = join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-service-')), 'db.sqlite')) {
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
