import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import {
  createFast, finishFast, updateFast, deleteFast, getFastingState,
  acknowledgeSafety, updateFastingSettings, FastingError,
} from '../server/services/fasting.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS } = await import('../server/db.js');

function setup(path = join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-service-')), 'db.sqlite')) {
  const database = new Database(path);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT NOT NULL DEFAULT 'member', family_role TEXT NOT NULL DEFAULT 'other');
    CREATE TABLE access_permissions (subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_key TEXT NOT NULL, access TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE health_care_grants (subject_id INTEGER NOT NULL, caregiver_id INTEGER NOT NULL, PRIMARY KEY(subject_id, caregiver_id));
    CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry')),
      entity_id INTEGER NOT NULL, remind_at TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT,
      pushed_at TEXT, assigned_from INTEGER
    );
  `);
  database.exec(MIGRATIONS.find((item) => item.version === 197).up);
  database.exec(MIGRATIONS.find((item) => item.version === 198).up);
  database.exec("INSERT INTO users VALUES (1, 'owner', 'member', 'parent'), (2, 'caregiver', 'member', 'parent'), (3, 'admin', 'admin', 'parent'), (4, 'disabled', 'member', 'other')");
  database.prepare("INSERT INTO access_permissions VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow', NULL)").run('1');
  database.prepare("INSERT INTO access_permissions VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow', NULL)").run('2');
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
