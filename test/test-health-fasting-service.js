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

test('capability is required and safety acknowledgement is explicit', () => {
  const database = setup();
  assert.throws(() => createFast(database, actor(4), base({ userId: 4 })), (error) => error.reason === 'FASTING_CAPABILITY_REQUIRED');
  database.prepare('DELETE FROM access_permissions WHERE subject_id = ?').run('1');
  assert.throws(() => createFast(database, actor(1), base({ acknowledgeSafety: false })), (error) => error.reason === 'FASTING_CAPABILITY_REQUIRED');
  database.prepare("INSERT INTO access_permissions VALUES ('user', '1', 'capability', 'health_use_fasting', 'allow', NULL)").run();
  assert.throws(() => createFast(database, actor(1), base({ acknowledgeSafety: false })), (error) => error.reason === 'FASTING_ACK_REQUIRED');
  database.close();
});

test('create canonicalizes offset timestamp, then finish and optimistic edit work', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  const created = createFast(database, actor(1), base({ acknowledgeSafety: false }));
  assert.equal(created.start_at, '2026-09-13T06:00:00.000Z');
  assert.equal(created.end_at, null);
  assert.throws(() => createFast(database, actor(1), base({ startAt: '2026-09-13T08:00:00' })), (error) => error.reason === 'FASTING_TIMESTAMP_INVALID');
  const ended = finishFast(database, actor(1), created.id, { expectedRevision: created.revision, endAt: '2026-09-13T12:00:00+02:00' });
  assert.equal(ended.end_at, '2026-09-13T10:00:00.000Z');
  const edited = updateFast(database, actor(1), ended.id, { expectedRevision: ended.revision, note: 'good', rating: 5 });
  assert.equal(edited.note, 'good');
  assert.equal(edited.revision, ended.revision + 1);
  assert.throws(() => updateFast(database, actor(1), ended.id, { expectedRevision: ended.revision, note: 'stale' }), (error) => error.reason === 'FASTING_REVISION_CONFLICT');
  deleteFast(database, actor(1), edited.id, { expectedRevision: edited.revision });
  assert.equal(getFastingState(database, actor(1), 1).history.length, 0);
  database.close();
});

test('future, malformed, overlap and bounds are rejected', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  assert.throws(() => createFast(database, actor(1), base({ startAt: '2099-01-01T00:00:00Z' })), (error) => error.reason === 'FASTING_FUTURE');
  assert.throws(() => createFast(database, actor(1), base({ startAt: '2026-09-13T08:00:00', acknowledgeSafety: false })), (error) => error.reason === 'FASTING_TIMESTAMP_INVALID');
  assert.throws(() => createFast(database, actor(1), base({ startTzid: 'No/Such_Zone', acknowledgeSafety: false })), (error) => error.reason === 'FASTING_TIMEZONE_INVALID');
  assert.throws(() => createFast(database, actor(1), base({ goalMinutes: 61, acknowledgeSafety: false })), (error) => error.reason === 'FASTING_GOAL_INVALID');
  const first = createFast(database, actor(1), base({ acknowledgeSafety: false }));
  assert.throws(() => createFast(database, actor(1), base({ startAt: '2026-09-13T09:00:00+02:00', acknowledgeSafety: false })), (error) => error.reason === 'FASTING_ACTIVE_EXISTS');
  assert.ok(first.id);
  database.close();
});

test('caregiver requires grant and capabilities on both sides; admin cannot bypass it', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  assert.throws(() => createFast(database, actor(2), base({ acknowledgeSafety: false })), (error) => error.reason === 'FASTING_SUBJECT_FORBIDDEN');
  database.prepare('INSERT INTO health_care_grants VALUES (1, 2)').run();
  const created = createFast(database, actor(2), base({ acknowledgeSafety: false }));
  assert.equal(created.user_id, 1);
  database.prepare("DELETE FROM access_permissions WHERE subject_id = '1'").run();
  assert.throws(() => createFast(database, actor(2), base({ startAt: '2026-09-14T08:00:00+02:00', acknowledgeSafety: false })), (error) => error.reason === 'FASTING_SUBJECT_FORBIDDEN');
  assert.throws(() => getFastingState(database, actor(3), 1), (error) => error.reason === 'FASTING_SUBJECT_FORBIDDEN');
  database.close();
});

test('lifecycle and active-goal settings enter an immediate transaction before record reads', () => {
  const database = setup();
  let immediateCalls = 0;
  const guarded = new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') return (operation) => {
        const tx = target.transaction(operation);
        const wrapped = (...args) => tx(...args);
        wrapped.immediate = (...args) => {
          immediateCalls += 1;
          return tx.immediate(...args);
        };
        return wrapped;
      };
      if (property === 'prepare') return (sql) => {
        if (/FROM health_fasts/.test(sql) && !target.inTransaction) throw new Error('health_fasts read outside transaction');
        const statement = target.prepare(sql);
        if (!/^(?:\s*)(?:INSERT|UPDATE|DELETE)/i.test(sql)) return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            if (statementProperty === 'run') return (...args) => {
              if (!target.inTransaction) throw new Error('write outside transaction');
              return statementTarget.run(...args);
            };
            const statementValue = statementTarget[statementProperty];
            return typeof statementValue === 'function' ? statementValue.bind(statementTarget) : statementValue;
          },
        });
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  acknowledgeSafety(database, actor(1), 1);
  const created = createFast(guarded, actor(1), base({ acknowledgeSafety: false }));
  updateFastingSettings(guarded, actor(1), {
    defaultGoalMinutes: 720, activeId: created.id, expectedRevision: created.revision,
  }, 1);
  const active = getFastingState(database, actor(1), 1).active;
  const ended = finishFast(guarded, actor(1), active.id, { expectedRevision: active.revision, endAt: '2026-09-13T12:00:00+02:00' });
  const edited = updateFast(guarded, actor(1), ended.id, { expectedRevision: ended.revision, note: 'transactional' });
  deleteFast(guarded, actor(1), edited.id, { expectedRevision: edited.revision });
  assert.equal(immediateCalls, 5);
  database.close();
});

test('createFast acquires the writer lock before overlap validation on two real connections', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'yuvomi-fasting-lock-')), 'db.sqlite');
  const first = setup(path);
  acknowledgeSafety(first, actor(1), 1);
  const second = new Database(path);
  second.pragma('busy_timeout = 0');
  let competitorError;
  let competed = false;
  const hooked = new Proxy(first, {
    get(target, property) {
      if (property === 'prepare') return (sql) => {
        const statement = target.prepare(sql);
        if (!/AND id <> COALESCE/.test(sql)) return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            if (statementProperty === 'get') return (...args) => {
              if (!competed) {
                competed = true;
                try { createFast(second, actor(1), base({ startAt: '2026-09-13T09:00:00+02:00', acknowledgeSafety: false })); }
                catch (error) { competitorError = error; }
              }
              return statementTarget.get(...args);
            };
            const value = statementTarget[statementProperty];
            return typeof value === 'function' ? value.bind(statementTarget) : value;
          },
        });
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const created = createFast(hooked, actor(1), base({ acknowledgeSafety: false }));
  assert.ok(created.id);
  assert.equal(competed, true);
  assert.equal(competitorError?.code, 'SQLITE_BUSY');
  assert.equal(first.prepare('SELECT count(*) AS count FROM health_fasts').get().count, 1);
  second.close();
  first.close();
});

test('journal settings and lifecycle preserve goal, clock and revisions', () => {
  const database = setup();
  try {
    const settings = updateFastingSettings(database, actor(1), {
      acknowledgeSafety: true, defaultGoalMinutes: 120,
      zoneMode: 'educational', clockMode: 'remaining',
    });
    assert.equal(settings.default_goal_minutes, 120);
    assert.equal(settings.clock_mode, 'remaining');
    const row = createFast(database, actor(1), base({
      startAt: '2025-01-01T10:00:00.000Z', goalMinutes: 120,
      acknowledgeSafety: false,
    }));
    updateFastingSettings(database, actor(1), {
      defaultGoalMinutes: 180, activeId: row.id, expectedRevision: row.revision,
    });
    const changed = getFastingState(database, actor(1)).active;
    assert.equal(changed.start_at, row.start_at);
    assert.equal(changed.goal_minutes, 180);
    assert.equal(changed.revision, row.revision + 1);
    const ended = finishFast(database, actor(1), row.id, {
      expectedRevision: changed.revision, endAt: '2025-01-01T14:00:00.000Z',
    });
    const reopened = updateFast(database, actor(1), row.id, {
      expectedRevision: ended.revision, endAt: null,
    });
    deleteFast(database, actor(1), row.id, { expectedRevision: reopened.revision });
    assert.equal(getFastingState(database, actor(1)).active, null);
  } finally { database.close(); }
});

test('a failed settings write rolls back the active goal and clock preference', () => {
  const database = setup();
  try {
    updateFastingSettings(database, actor(1), {
      acknowledgeSafety: true, defaultGoalMinutes: 120, clockMode: 'elapsed',
    });
    const row = createFast(database, actor(1), base({
      startAt: '2025-01-01T10:00:00.000Z', goalMinutes: 120, acknowledgeSafety: false,
    }));
    const failing = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') return (sql) => {
          if (/^INSERT INTO health_fasting_settings \(user_id, default_goal_minutes/.test(sql)) {
            throw new Error('forced core settings write failure');
          }
          return target.prepare(sql);
        };
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    assert.throws(() => updateFastingSettings(failing, actor(1), {
      defaultGoalMinutes: 180, activeId: row.id, expectedRevision: row.revision,
      clockMode: 'remaining',
    }), /forced core settings write failure/);
    const state = getFastingState(database, actor(1));
    assert.equal(state.active.goal_minutes, 120);
    assert.equal(state.active.revision, row.revision);
    assert.equal(state.settings.default_goal_minutes, 120);
    assert.equal(state.settings.clock_mode, 'elapsed');
  } finally { database.close(); }
});
