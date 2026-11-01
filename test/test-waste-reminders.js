/**
 * Module: Waste collection - per-user pickup reminders (#1063 Phase 8)
 * Purpose: syncWasteRemindersForUser()/syncAllWasteReminders() - anchor+
 *          reminder creation, idempotent no-op on an unchanged target,
 *          cleanup of a moved/skipped/re-mapped-away occurrence, per-user
 *          isolation, module-disabled/permission-denial drop, archived-type
 *          exclusion, coalesced-occurrence dedup, DST-aware delivery time
 *          computation, and one message per pickup in a household channel.
 * Ausführen: npm run test:waste-reminders
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'waste-reminders-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const store = await import('../server/services/waste-store.js');
const { syncWasteRemindersForUser, syncAllWasteReminders, __test } = await import('../server/services/waste-reminders.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

get().prepare(`
  INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();
get().prepare(`
  INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();

function seedUser(prefix) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'hash', 'member')
  `).run(`${prefix}-${randomUUID()}`, prefix).lastInsertRowid;
}

const ALICE = seedUser('alice');
const BOB = seedUser('bob');

function seedType(overrides = {}) {
  return store.createType(get(), { name: `Type-${randomUUID()}`, ...overrides }, ALICE);
}

function seedWeeklySchedule(typeId, overrides = {}) {
  return store.createSchedule(get(), {
    type_id: typeId, recurrence_kind: 'weekly', anchor_date: '2026-01-05',
    interval: 1, weekdays: 'MO', ...overrides,
  }, ALICE);
}

function setSetting(userId, typeId, { enabled = true, offsetDays = 1, deliveryTime = '08:00' } = {}) {
  get().prepare(`
    INSERT INTO waste_reminder_settings (user_id, type_id, enabled, offset_days, delivery_time)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, type_id) DO UPDATE SET enabled = excluded.enabled, offset_days = excluded.offset_days, delivery_time = excluded.delivery_time
  `).run(userId, typeId, enabled ? 1 : 0, offsetDays, deliveryTime);
}

function reminderFor(userId, typeId, dateKey) {
  return get().prepare(`
    SELECT r.* FROM reminders r
    JOIN waste_reminder_entries e ON e.id = r.entity_id
    WHERE r.entity_type = 'waste_pickup' AND e.user_id = ? AND e.type_id = ? AND e.date_key = ?
  `).get(userId, typeId, dateKey);
}

function anchorCountForType(userId, typeId) {
  return get().prepare('SELECT COUNT(*) AS n FROM waste_reminder_entries WHERE user_id = ? AND type_id = ?').get(userId, typeId).n;
}

// Each test's own fixed "now", a few days before its fixture's pickup date -
// the sync window is 45 days FORWARD from "today" (REMINDER_WINDOW_DAYS), so
// "now" must be close to, not far before, the fixture date, and always
// before the computed remind_at instant (syncWasteRemindersForUser never
// creates a reminder for an already-past target).

// -------------------------------------------------------------------------
// pickupReminderAt: DST-aware delivery time (pure)
// -------------------------------------------------------------------------

test('pickupReminderAt: the household-local delivery time resolves to a different UTC offset across a DST transition', () => {
  // Europe/Berlin: CET (UTC+1) through 2027-03-28, CEST (UTC+2) from 2027-03-28
  // onward (the transition itself happens at 02:00 local that day, so 08:00
  // local that same day is already CEST) - a naive fixed-offset
  // implementation would give the same UTC instant for both.
  const beforeDst = __test.pickupReminderAt('2027-03-27', 0, '08:00', 'Europe/Berlin');
  const afterDst = __test.pickupReminderAt('2027-03-28', 0, '08:00', 'Europe/Berlin');
  assert.equal(beforeDst, '2027-03-27T07:00');
  assert.equal(afterDst, '2027-03-28T06:00');
});

test('pickupReminderAt: offset_days shifts the reminder date before the pickup date, delivery time unaffected', () => {
  assert.equal(__test.pickupReminderAt('2026-06-10', 3, '08:00', 'UTC'), '2026-06-07T08:00');
  assert.equal(__test.pickupReminderAt('2026-06-10', 0, '08:00', 'UTC'), '2026-06-10T08:00');
});

// -------------------------------------------------------------------------
// syncWasteRemindersForUser: core create/idempotent/cleanup behavior
// -------------------------------------------------------------------------

test('syncWasteRemindersForUser: an enabled setting creates an anchor + reminder for the next qualifying occurrence', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  const type = seedType({ name: 'Bio' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-01-05', weekdays: 'MO' }); // a Monday
  setSetting(ALICE, type.id, { offsetDays: 1, deliveryTime: '08:00' });

  syncWasteRemindersForUser(get(), ALICE, NOW);

  const reminder = reminderFor(ALICE, type.id, '2026-01-05');
  assert.ok(reminder, 'expected a reminder anchored to the 2026-01-05 Monday pickup');
  assert.equal(reminder.remind_at, '2026-01-04T08:00');
  assert.equal(reminder.dismissed, 0);
  assert.equal(reminder.pushed_at, null);
});

test('syncWasteRemindersForUser: a second run with nothing changed leaves the existing reminder row untouched (same id, pushed_at preserved)', () => {
  const NOW = new Date('2026-01-29T00:00:00Z');
  const type = seedType({ name: 'Papier' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-02-02', weekdays: 'MO' });
  setSetting(ALICE, type.id, { offsetDays: 1 });
  syncWasteRemindersForUser(get(), ALICE, NOW);

  const first = reminderFor(ALICE, type.id, '2026-02-02');
  get().prepare('UPDATE reminders SET pushed_at = ? WHERE id = ?').run('2025-06-01T00:00:00', first.id);

  syncWasteRemindersForUser(get(), ALICE, NOW);
  const second = reminderFor(ALICE, type.id, '2026-02-02');
  assert.equal(second.id, first.id, 'a rerun with an unchanged target instant must not delete/reinsert the row');
  assert.equal(second.pushed_at, '2025-06-01T00:00:00', 'pushed_at must survive an unrelated rerun, or the same push would repeat forever');
});

test('syncWasteRemindersForUser: disabling the setting drops the anchor and its reminder', () => {
  const NOW = new Date('2026-02-26T00:00:00Z');
  const type = seedType({ name: 'Glas' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-03-02', weekdays: 'MO' });
  setSetting(ALICE, type.id, { offsetDays: 1 });
  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.ok(reminderFor(ALICE, type.id, '2026-03-02'));

  setSetting(ALICE, type.id, { enabled: false });
  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.equal(reminderFor(ALICE, type.id, '2026-03-02'), undefined);
  assert.equal(anchorCountForType(ALICE, type.id), 0);
});

test('syncWasteRemindersForUser: moving the occurrence (schedule override) drops the old anchor/reminder and creates a new one on the moved date', () => {
  const NOW = new Date('2026-04-01T00:00:00Z');
  const type = seedType({ name: 'Restmuell' });
  const schedule = seedWeeklySchedule(type.id, { anchor_date: '2026-04-06', weekdays: 'MO' });
  setSetting(ALICE, type.id, { offsetDays: 1 });
  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.ok(reminderFor(ALICE, type.id, '2026-04-06'), 'original Monday pickup has a reminder');

  store.upsertOverride(get(), schedule.id, { original_date: '2026-04-06', replacement_date: '2026-04-08' });
  syncWasteRemindersForUser(get(), ALICE, NOW);

  assert.equal(reminderFor(ALICE, type.id, '2026-04-06'), undefined, 'the old date must lose its reminder');
  const moved = reminderFor(ALICE, type.id, '2026-04-08');
  assert.ok(moved, 'the moved-to date must gain one');
  assert.equal(moved.remind_at, '2026-04-07T08:00');
});

test('syncWasteRemindersForUser: a coalesced occurrence (schedule + manual one-off, same type/date) still produces exactly one reminder', () => {
  const NOW = new Date('2026-04-30T00:00:00Z');
  const type = seedType({ name: 'Sperrmuell' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-05-04', weekdays: 'MO' });
  store.createOneOff(get(), { type_id: type.id, date: '2026-05-04' }, ALICE);
  setSetting(ALICE, type.id, { offsetDays: 1 });

  syncWasteRemindersForUser(get(), ALICE, NOW);

  const rows = get().prepare(`
    SELECT r.id FROM reminders r JOIN waste_reminder_entries e ON e.id = r.entity_id
    WHERE r.entity_type = 'waste_pickup' AND e.user_id = ? AND e.type_id = ? AND e.date_key = ?
  `).all(ALICE, type.id, '2026-05-04');
  assert.equal(rows.length, 1, 'the resolver already coalesces same-type/date origins into one occurrence - this must not fan out into two reminders');
});

test('syncWasteRemindersForUser: an archived type is excluded even with an enabled setting still naming it', () => {
  const NOW = new Date('2026-05-28T00:00:00Z');
  const type = seedType({ name: 'ArchivedType' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-06-01', weekdays: 'MO' });
  setSetting(ALICE, type.id, { offsetDays: 1 });
  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.ok(reminderFor(ALICE, type.id, '2026-06-01'));

  get().prepare('UPDATE waste_types SET archived = 1 WHERE id = ?').run(type.id);
  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.equal(reminderFor(ALICE, type.id, '2026-06-01'), undefined);
});

test('syncWasteRemindersForUser: per-user isolation - two users with different offsets/settings for the same type never affect each other', () => {
  const NOW = new Date('2026-07-01T00:00:00Z');
  const type = seedType({ name: 'SharedType' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-07-06', weekdays: 'MO' });
  setSetting(ALICE, type.id, { offsetDays: 2, deliveryTime: '07:00' });
  setSetting(BOB, type.id, { offsetDays: 0, deliveryTime: '20:00' });

  syncWasteRemindersForUser(get(), ALICE, NOW);
  syncWasteRemindersForUser(get(), BOB, NOW);

  const aliceReminder = reminderFor(ALICE, type.id, '2026-07-06');
  const bobReminder = reminderFor(BOB, type.id, '2026-07-06');
  assert.equal(aliceReminder.remind_at, '2026-07-04T07:00');
  assert.equal(bobReminder.remind_at, '2026-07-06T20:00');
  assert.notEqual(aliceReminder.id, bobReminder.id);

  // Disabling Bob's setting must never touch Alice's reminder for the same
  // occurrence.
  setSetting(BOB, type.id, { enabled: false });
  syncWasteRemindersForUser(get(), BOB, NOW);
  assert.equal(reminderFor(BOB, type.id, '2026-07-06'), undefined);
  assert.ok(reminderFor(ALICE, type.id, '2026-07-06'), "Bob's cleanup must not delete Alice's reminder");
});

test('syncWasteRemindersForUser: a module-disabled household drops every reminder for the user, and lacksWaste (permission denial) does too', () => {
  const NOW = new Date('2026-07-30T00:00:00Z');
  const type = seedType({ name: 'GateType' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-08-03', weekdays: 'MO' });
  setSetting(ALICE, type.id, { offsetDays: 1 });
  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.ok(reminderFor(ALICE, type.id, '2026-08-03'));

  get().prepare(`UPDATE sync_config SET value = '["waste"]' WHERE key = 'disabled_modules'`).run();
  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.equal(reminderFor(ALICE, type.id, '2026-08-03'), undefined, 'a disabled module must drop the reminder');
  get().prepare(`UPDATE sync_config SET value = '[]' WHERE key = 'disabled_modules'`).run();

  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.ok(reminderFor(ALICE, type.id, '2026-08-03'), 're-enabling the module must let the sync recreate it');

  get().prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'waste', 'none')
  `).run(String(ALICE));
  syncWasteRemindersForUser(get(), ALICE, NOW);
  assert.equal(reminderFor(ALICE, type.id, '2026-08-03'), undefined, 'a per-user denied module must drop the reminder too');

  // Cleanup: this DB is shared across tests in this file - a dangling denial
  // would silently gate every later test's own use of ALICE.
  get().prepare(`DELETE FROM access_permissions WHERE subject_id = ? AND resource_key = 'waste'`).run(String(ALICE));
});

test('syncAllWasteReminders: syncs every user with an enabled setting, and a user who only has leftover anchors (setting since disabled)', () => {
  const NOW = new Date('2026-09-03T00:00:00Z');
  const type = seedType({ name: 'AllUsersType' });
  seedWeeklySchedule(type.id, { anchor_date: '2026-09-07', weekdays: 'MO' });
  setSetting(ALICE, type.id, { offsetDays: 1 });
  setSetting(BOB, type.id, { offsetDays: 1 });

  syncAllWasteReminders(get(), NOW);
  assert.ok(reminderFor(ALICE, type.id, '2026-09-07'));
  assert.ok(reminderFor(BOB, type.id, '2026-09-07'));

  // Bob disables afterwards - syncAllWasteReminders must still pick him up
  // (via his leftover anchor) to clean up, even though he no longer has any
  // enabled setting row.
  setSetting(BOB, type.id, { enabled: false });
  syncAllWasteReminders(get(), NOW);
  assert.equal(reminderFor(BOB, type.id, '2026-09-07'), undefined);
  assert.ok(reminderFor(ALICE, type.id, '2026-09-07'), "Bob's own cleanup pass must not touch Alice's reminder");
});

// -------------------------------------------------------------------------
// Delivery: one row per person, one message in a household channel
// -------------------------------------------------------------------------

// Monday 2026-09-07 with the default lead of one day at 08:00.
const PICKUP = '2026-09-07';
const BEFORE_REMINDER = new Date('2026-09-01T00:00:00Z');
const AFTER_REMINDER = new Date('2026-09-06T09:00:00Z');

function householdChannel(name) {
  const channels = createNotificationChannelStore({ db: get() });
  const channel = channels.createChannel({
    provider: 'ntfy', name, enabled: true,
    config: { baseUrl: 'https://ntfy.test', topic: name }, secrets: {},
  });
  return { remove: () => channels.deleteChannel(channel.id) };
}

// Everything the suite left pending would otherwise answer in this delivery.
const settleEverything = () => get()
  .prepare("UPDATE reminders SET pushed_at = '2000-01-01T00:00:00Z' WHERE pushed_at IS NULL").run();

async function deliver({ send = async () => {} } = {}) {
  const heard = [];
  await processDueNotifications({
    database: get(),
    channelStore: createNotificationChannelStore({ db: get() }),
    pushService: { sendPushToUser: async () => 0 },
    providers: {
      ntfy: {
        id: 'ntfy',
        send: async ({ payload }) => {
          await send();
          heard.push(payload.body);
        },
      },
    },
    now: AFTER_REMINDER,
  });
  return heard;
}

/** Fresh people and a fresh type, so no earlier test's settings can answer here. */
function twoMembersRemindedOf(type, settings = [{}, {}]) {
  seedWeeklySchedule(type.id);
  const people = settings.map((setting) => {
    const userId = seedUser('member');
    setSetting(userId, type.id, setting);
    syncWasteRemindersForUser(get(), userId, BEFORE_REMINDER);
    return userId;
  });
  assert.equal(reminderFor(people[0], type.id, PICKUP).created_by, people[0]);
  assert.equal(reminderFor(people[1], type.id, PICKUP).created_by, people[1]);
  return people;
}

test('delivery: a household channel hears one pickup once, not once per member', async () => {
  const channel = householdChannel('waste-one');
  try {
    settleEverything();
    const type = seedType();
    const [first, second] = twoMembersRemindedOf(type);
    assert.notEqual(reminderFor(first, type.id, PICKUP).entity_id, reminderFor(second, type.id, PICKUP).entity_id,
      'the premise: each person has an anchor of their own');
    assert.equal(reminderFor(first, type.id, PICKUP).remind_at, reminderFor(second, type.id, PICKUP).remind_at);

    assert.deepEqual(await deliver(), [`${type.name} - ${PICKUP}`]);
    assert.deepEqual(await deliver(), [], 'and the next run reports nothing late');
    assert.ok(reminderFor(second, type.id, PICKUP).pushed_at, 'the silent row is still finished');
  } finally {
    channel.remove();
  }
});

test('delivery: a member with a different lead time keeps a message of their own', async () => {
  const channel = householdChannel('waste-two');
  try {
    settleEverything();
    twoMembersRemindedOf(seedType(), [{ offsetDays: 1 }, { offsetDays: 2 }]);
    assert.equal((await deliver()).length, 2, 'two instants are two messages');
  } finally {
    channel.remove();
  }
});

test('delivery: two types collected on the same day stay two messages', async () => {
  const channel = householdChannel('waste-three');
  try {
    settleEverything();
    const paper = seedType();
    const glass = seedType();
    twoMembersRemindedOf(paper);
    twoMembersRemindedOf(glass);
    assert.deepEqual((await deliver()).sort(),
      [`${paper.name} - ${PICKUP}`, `${glass.name} - ${PICKUP}`].sort());
  } finally {
    channel.remove();
  }
});

test('delivery: a failed first attempt does not swallow the message', async () => {
  const channel = householdChannel('waste-four');
  try {
    settleEverything();
    twoMembersRemindedOf(seedType());
    let down = true;
    const send = async () => { if (down) { down = false; throw new Error('channel briefly gone'); } };
    assert.equal((await deliver({ send })).length, 1, 'the second row catches the outage');
    get().prepare("UPDATE notification_deliveries SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE status = 'failed'").run();
    assert.equal((await deliver()).length, 0, 'and the retry of the first does not repeat it');
  } finally {
    channel.remove();
  }
});
