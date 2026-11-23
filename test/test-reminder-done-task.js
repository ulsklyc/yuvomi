/**
 * Test: the reminder of a done or archived task stays quiet (#2721)
 * Purpose: a reminder on a task that is done (`status = 'done'`) or archived (`archived_at`) must not
 *          sound on any path: not in `GET /reminders/pending` (toast, bell) and not in the delivery
 *          (Web Push, channels) - `GET /reminders/upcoming` already left it out. Held here:
 *            1. an open task is unchanged: due in `/pending` and push, coming in `/upcoming`;
 *            2. done and archived: the due reminder is in neither `/pending` nor push, the coming one
 *               not in `/upcoming`;
 *            3. reopened AFTER the reminder came due: it counts as missed and nothing goes out, not
 *               at the next delivery run and not as a toast;
 *            4. reopened BEFORE it comes due: it goes out when it is due.
 *          Network-free: in-memory SQLite over the full migration chain, the push service and the
 *          channel providers are stand-ins, the router runs on a loopback port. The clock stands
 *          still (`mock.timers`, `Date` only), household zone UTC.
 * Run: npm run test:reminder-done-task
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const NOW = Date.parse('2024-06-15T12:00:00Z');
mock.timers.enable({ apis: ['Date'], now: NOW });
after(() => mock.timers.reset());

const dbmod = await import('../server/db.js');
const remindersModule = await import('../server/routes/reminders.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/authorize/index.ts');
const db = dbmod.get();

db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')").run();
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('disabled_modules', '[]')").run();

let userSeq = 0;
/** A member with a push subscription, so the delivery has somewhere to send. */
function freshUser() {
  userSeq += 1;
  const id = Number(db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, '$2b$12$x', 'member', 'other')",
  ).run(`rdt-u${userSeq}`, `User ${userSeq}`).lastInsertRowid);
  db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(id, `https://push.test/${id}`, 'p', 'a');
  return id;
}

/** @param {number} owner */
function makeTask(owner) {
  return Number(db.prepare(
    "INSERT INTO tasks (title, category, status, created_by) VALUES ('Taxes', 'Sonstiges', 'open', ?)",
  ).run(owner).lastInsertRowid);
}

/** @param {number} owner @param {number} taskId @param {string} remindAt */
function insertReminder(owner, taskId, remindAt) {
  return Number(db.prepare(
    "INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('task', ?, ?, ?)",
  ).run(taskId, remindAt, owner).lastInsertRowid);
}

/** @type {Record<string, (id: number) => unknown>} */
const closeTask = {
  done: (id) => db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id),
  archived: (id) => db.prepare("UPDATE tasks SET archived_at = '2024-06-15T11:00:00Z' WHERE id = ?").run(id),
};
/** @param {number} id */
const reopenTask = (id) => db.prepare("UPDATE tasks SET status = 'open', archived_at = NULL WHERE id = ?").run(id);

/** One delivery run at the stand-still clock; the tags of what was pushed. */
async function deliver() {
  /** @type {string[]} */
  const tags = [];
  await processDueNotifications({
    database: db,
    channelStore: createNotificationChannelStore({ db }),
    pushService: /** @type {any} */ ({
      sendPushToUser: async (/** @type {number} */ _userId, /** @type {{ tag?: string }} */ payload) => {
        if (payload.tag) tags.push(payload.tag);
        return 1;
      },
    }),
    providers: /** @type {any} */ ({}),
    now: new Date(),
  });
  return tags;
}

// The real router, with the same rights resolution as in production.
/** @type {number} */
let currentUid = 0;
const app = express();
app.use(express.json());
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(currentUid);
  req.authUserId = currentUid;
  req.session = { userId: currentUid, role: 'member' };
  req.authScopes = null;
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, /** @type {any} */ (user)));
  next();
});
app.use('/api/v1/reminders', remindersModule.default);
const server = http.createServer((req, res) => {
  res.setHeader('Connection', 'close');
  app(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = /** @type {import('node:net').AddressInfo} */ (server.address());
const base = `http://127.0.0.1:${address.port}/api/v1/reminders`;
after(() => server.close());

/** @param {number} userId @param {string} path */
async function ids(userId, path) {
  currentUid = userId;
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, path);
  const body = /** @type {{ data: { id: number }[] }} */ (await res.json());
  return body.data.map((row) => Number(row.id));
}
const pending = (/** @type {number} */ userId) => ids(userId, '/pending');
const upcoming = (/** @type {number} */ userId) => ids(userId, '/upcoming?from=2024-06-15T12:00:00Z&to=2024-06-29T12:00:00Z');

/** Where a due row shows: the toast list and the push. */
async function seenDue(/** @type {number} */ userId, /** @type {number} */ reminderId) {
  return {
    pending: (await pending(userId)).includes(reminderId),
    push: (await deliver()).includes(`reminder-${reminderId}`),
  };
}

const DUE = '2024-06-15T11:55:00';    // before now: due
const COMING = '2024-06-15T13:00:00'; // after now: coming

test('an open task is unchanged on every path', async () => {
  const me = freshUser();
  const task = makeTask(me);
  const due = insertReminder(me, task, DUE);
  const coming = insertReminder(me, task, COMING);
  assert.ok((await upcoming(me)).includes(coming));
  assert.deepEqual(await seenDue(me, due), { pending: true, push: true });
  assert.equal(db.prepare('SELECT dismissed FROM reminders WHERE id = ?').get(due)?.dismissed, 0);
});

for (const [name, close] of Object.entries(closeTask)) {
  test(`${name}: neither /pending nor the delivery, and /upcoming leaves the coming one out`, async () => {
    const me = freshUser();
    const task = makeTask(me);
    const due = insertReminder(me, task, DUE);
    const coming = insertReminder(me, task, COMING);
    close(task);
    assert.equal((await upcoming(me)).includes(coming), false, '/upcoming');
    assert.deepEqual(await seenDue(me, due), { pending: false, push: false });
    // Missed, not delivered: nothing counts as sent. The coming row stays as it was.
    const rows = db.prepare('SELECT id, pushed_at, dismissed FROM reminders WHERE entity_id = ? ORDER BY id').all(task);
    assert.deepEqual(
      rows.map((/** @type {any} */ r) => [Number(r.id), r.pushed_at, r.dismissed]),
      [[due, null, 1], [coming, null, 0]],
    );
  });

  test(`${name}, reopened after it came due: the missed reminder does not go out`, async () => {
    const me = freshUser();
    const task = makeTask(me);
    const due = insertReminder(me, task, DUE);
    close(task);
    assert.deepEqual(await seenDue(me, due), { pending: false, push: false });
    reopenTask(task);
    assert.deepEqual(await seenDue(me, due), { pending: false, push: false });
  });

  test(`${name}, reopened before it comes due: it goes out when it is due`, async () => {
    const me = freshUser();
    const task = makeTask(me);
    const coming = insertReminder(me, task, COMING);
    close(task);
    assert.equal((await upcoming(me)).includes(coming), false);
    reopenTask(task);
    assert.ok((await upcoming(me)).includes(coming));
    // Not due yet: no toast, no push, the row stays pending.
    assert.deepEqual(await seenDue(me, coming), { pending: false, push: false });
    mock.timers.setTime(Date.parse('2024-06-15T13:00:30Z'));
    try {
      assert.deepEqual(await seenDue(me, coming), { pending: true, push: true });
    } finally {
      mock.timers.setTime(NOW);
    }
  });
}
