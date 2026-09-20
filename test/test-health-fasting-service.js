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
  const setFasting = database.prepare(`INSERT INTO access_permissions
    (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'capability', 'health_use_fasting', ?)`);
  setFasting.run('1', 'allow');
  setFasting.run('2', 'allow');
  setFasting.run('4', 'none');
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
  database.prepare("UPDATE access_permissions SET access = 'none' WHERE subject_id = ? AND resource_key = 'health_use_fasting'").run('1');
  assert.throws(() => createFast(database, actor(1), base({ acknowledgeSafety: false })), (error) => error.reason === 'FASTING_CAPABILITY_REQUIRED');
  database.prepare("UPDATE access_permissions SET access = 'allow' WHERE subject_id = '1' AND resource_key = 'health_use_fasting'").run();
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

test('deleting a fast removes pending, delivered and dismissed reminders atomically', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  const created = createFast(database, actor(1), base({ acknowledgeSafety: false }));
  const insert = database.prepare(`INSERT INTO reminders
    (entity_type, entity_id, remind_at, created_by, dismissed, pushed_at)
    VALUES (?, ?, ?, 1, ?, ?)`);
  insert.run('fasting_goal', created.id, '2026-09-13T22:00:00.000Z', 0, '2026-09-13T22:00:01.000Z');
  insert.run('fasting_next_start', created.id, '2026-09-14T06:00:00.000Z', 1, null);

  deleteFast(database, actor(1), created.id, { expectedRevision: created.revision });

  assert.equal(database.prepare(`SELECT count(*) AS count FROM reminders
    WHERE entity_type IN ('fasting_goal', 'fasting_next_start') AND entity_id = ?`).get(created.id).count, 0);
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

test('caregiver requires grant and capabilities on both sides; private ids stay hidden', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  assert.throws(() => createFast(database, actor(2), base({ acknowledgeSafety: false })), (error) => error.reason === 'FASTING_SUBJECT_FORBIDDEN');
  database.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (1, 2)').run();
  const created = createFast(database, actor(2), base({ acknowledgeSafety: false }));
  assert.equal(created.user_id, 1);
  database.prepare("UPDATE access_permissions SET access = 'none' WHERE subject_id = '1' AND resource_key = 'health_use_fasting'").run();
  assert.throws(() => createFast(database, actor(2), base({ startAt: '2026-09-14T08:00:00+02:00', acknowledgeSafety: false })), (error) => error.reason === 'FASTING_SUBJECT_FORBIDDEN');
  database.prepare("UPDATE access_permissions SET access = 'allow' WHERE subject_id = '1' AND resource_key = 'health_use_fasting'").run();
  assert.throws(() => updateFast(database, actor(3), created.id, {
    expectedRevision: created.revision, note: 'admin without grant',
  }), (error) => error.reason === 'FASTING_NOT_FOUND');
  database.close();
});

test('admin cannot bypass the caregiver grant for a reachable subject write', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  assert.throws(
    () => createFast(database, actor(3), base({ acknowledgeSafety: false })),
    (error) => error.reason === 'FASTING_SUBJECT_FORBIDDEN',
  );
  database.close();
});

test('only the fasting person can acknowledge safety', () => {
  const database = setup();
  database.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (1, 2)').run();
  assert.throws(
    () => createFast(database, actor(2), base({ acknowledgeSafety: true })),
    (error) => error.reason === 'FASTING_ACK_REQUIRED',
  );
  assert.throws(
    () => acknowledgeSafety(database, actor(2), 1),
    (error) => error.reason === 'FASTING_ACK_FORBIDDEN',
  );
  acknowledgeSafety(database, actor(1), 1);
  assert.equal(createFast(database, actor(2), base({ acknowledgeSafety: false })).user_id, 1);
  database.close();
});

test('server now fills omitted start and finish timestamps', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  const before = Date.now();
  const created = createFast(database, actor(1), base({ startAt: undefined, acknowledgeSafety: false }));
  assert.ok(Date.parse(created.start_at) >= before && Date.parse(created.start_at) <= Date.now());
  deleteFast(database, actor(1), created.id, { expectedRevision: created.revision });
  const older = createFast(database, actor(1), base({ startAt: '2025-01-01T08:00:00Z', acknowledgeSafety: false }));
  const ended = finishFast(database, actor(1), older.id, { expectedRevision: older.revision });
  assert.ok(Date.parse(ended.end_at) >= Date.parse(older.start_at) && Date.parse(ended.end_at) <= Date.now());
  database.close();
});

test('journal state exposes server time for completed-entry defaults', () => {
  const database = setup();
  const before = Date.now();
  const state = getFastingState(database, actor(1), 1);
  const serverNow = Date.parse(state.server_now);
  assert.ok(Number.isFinite(serverNow));
  assert.ok(serverNow >= before && serverNow <= Date.now());
  database.close();
});

test('implausible years and interval overlaps are rejected numerically', () => {
  const database = setup();
  acknowledgeSafety(database, actor(1), 1);
  assert.throws(
    () => createFast(database, actor(1), base({ startAt: '0202-09-13T08:00:00Z', acknowledgeSafety: false })),
    (error) => error.reason === 'FASTING_TIMESTAMP_INVALID',
  );
  const first = createFast(database, actor(1), base({
    startAt: '2025-01-01T08:00:00Z', endAt: '2025-01-01T10:00:00Z', acknowledgeSafety: false,
  }));
  assert.throws(
    () => createFast(database, actor(1), base({
      startAt: '2025-01-01T09:00:00Z', endAt: '2025-01-01T11:00:00Z', acknowledgeSafety: false,
    })),
    (error) => error.reason === 'FASTING_OVERLAP',
  );
  const second = createFast(database, actor(1), base({
    startAt: '2025-01-02T08:00:00Z', endAt: '2025-01-02T10:00:00Z', acknowledgeSafety: false,
  }));
  assert.throws(
    () => updateFast(database, actor(1), second.id, {
      expectedRevision: second.revision, startAt: '2025-01-01T09:30:00Z', endAt: '2025-01-01T11:30:00Z',
    }),
    (error) => error.reason === 'FASTING_OVERLAP',
  );
  assert.ok(first.id);
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
