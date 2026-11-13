/**
 * Test: an ICS feed stays empty for a member whose module is `none` (#2615)
 * Purpose: the six subscription addresses outside `/api/v1` resolved their
 *          token to the owner and delivered, without ever asking the
 *          member's module permission. A member with `calendar: none` kept
 *          receiving every household event through the personal feed,
 *          including other members' private ones (the personal feed
 *          deliberately does not filter by visibility, docs/SPEC.md).
 *
 *          Decided on 08.11.: on `none` the feed answers 200 with an EMPTY
 *          calendar - same HTTP headers, same calendar header lines, no
 *          VEVENT. The subscription stays in the calendar app and fills
 *          again once the permission is given back: skip, do not delete, the
 *          same line as the delivery of reminders (#1289,
 *          test-denied-module-reminders.js).
 *
 *          Measured over the REAL server (test/server-ready.js): the handlers
 *          are inline routes in server/index.js, there is no router to mount
 *          in-process. Per feed: events before; empty on `none` from the
 *          member override and from the role profile; `read` keeps
 *          delivering; an admin with a deny row keeps delivering; giving the
 *          permission back fills it again. Plus the guard that every feed
 *          points at a module of the permission matrix.
 * Run: npm run test:denied-module-feeds
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'denied-module-feeds',
  // TRUST_PROXY=1 (the default, set here so the suite does not lean on it):
  // the feed limiter allows 30 requests per minute and address, and this suite
  // makes about 70. Each request comes from an address of its own.
  env: { SESSION_SECRET: 'test-denied-module-feeds-secret-32chars', TRUST_PROXY: '1' },
});
const db = (await import('../server/db.js')).get();
const { PERMISSION_MODULES } = await import('../server/authorize/index.ts');
// Read as a namespace, not destructured: against a state without the map the
// guard below turns red on its own instead of taking the whole suite down.
const origins = await import('../server/services/reminder-origins.js');

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------

// Offsets of whole days from now, never the edge of one: every seed lies two
// or more days inside the window its feed spans, so the UTC date here and the
// household date in the feed cannot fall on different sides of it.
function dateKey(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

let counter = 0;
function insertUser({ role = 'member', familyRole = 'other' } = {}) {
  counter += 1;
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', ?, ?) RETURNING id
  `).get(`feeduser${counter}`, `Feed user ${counter}`, role, familyRole).id);
}

/** Sparse, as the admin UI writes it. */
function setModuleAccess(subjectType, subjectId, moduleKey, access) {
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES (?, ?, 'module', ?, ?)
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key) DO UPDATE SET access = excluded.access
  `).run(subjectType, String(subjectId), moduleKey, access);
}

function clearModuleAccess(subjectType, subjectId, moduleKey) {
  db.prepare(`
    DELETE FROM access_permissions
    WHERE subject_type = ? AND subject_id = ? AND resource_type = 'module' AND resource_key = ?
  `).run(subjectType, String(subjectId), moduleKey);
}

let requests = 0;
async function fetchFeed(path, token) {
  requests += 1;
  const res = await fetch(`${BASE}/feed/${path}/${token}.ics`, {
    headers: { 'X-Forwarded-For': `10.${Math.floor(requests / 250)}.${requests % 250}.1` },
  });
  const body = await res.text();
  return {
    status: res.status,
    body,
    headers: {
      'content-type': res.headers.get('content-type'),
      'content-disposition': res.headers.get('content-disposition'),
      'cache-control': res.headers.get('cache-control'),
    },
    // The calendar's own header lines: everything before the first component.
    head: body.split('\r\n').filter(Boolean)
      .slice(0, Math.max(0, body.split('\r\n').filter(Boolean)
        .findIndex((l) => l === 'BEGIN:VEVENT' || l === 'BEGIN:VTIMEZONE' || l === 'END:VCALENDAR'))),
  };
}

const hasEvent = (feed) => feed.body.includes('BEGIN:VEVENT');

// --------------------------------------------------------------------------
// Household data - one set for the whole suite
// --------------------------------------------------------------------------

// A set zone: the calendar and schedule feeds then carry X-WR-TIMEZONE, and
// the empty answer has to carry it too.
db.prepare(`
  INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();

const OTHER = insertUser({ familyRole: 'parent' });
// Somebody else's PRIVATE event: the personal feed hands it to every member,
// which is what makes `calendar: none` a leak and not just a stale view.
db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, external_source, created_by, visibility)
  VALUES ('Private appointment of another member', ?, ?, 0, 'local', ?, 'private')
`).run(`${dateKey(3)}T09:00:00Z`, `${dateKey(3)}T10:00:00Z`, OTHER);
db.prepare("INSERT INTO birthdays (name, birth_date, created_by) VALUES ('Feed birthday', '1990-05-12', ?)").run(OTHER);
db.prepare('INSERT INTO inventory_items (name, purchase_date, warranty_months) VALUES (?, ?, 24)')
  .run('Feed dishwasher', dateKey(-30));
const wasteType = Number(db.prepare(`
  INSERT INTO waste_types (name, color, created_by) VALUES ('Feed bin', '#2E7D32', ?) RETURNING id
`).get(OTHER).id);
db.prepare('INSERT INTO waste_one_off_pickups (type_id, date, created_by) VALUES (?, ?, ?)')
  .run(wasteType, dateKey(5), OTHER);
const shiftType = Number(db.prepare(`
  INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color)
  VALUES ('Early', 'E', '06:00', '14:00', '#6C3AED') RETURNING id
`).get().id);

/** Per feed: its address, token column, module, and what the owner's own feed needs. */
const FEEDS = [
  { feed: 'calendar', column: 'calendar_feed_token', module: 'calendar', seed: () => {} },
  { feed: 'birthdays', column: 'birthday_feed_token', module: 'calendar', seed: () => {} },
  { feed: 'inventory-deadlines', column: 'inventory_deadlines_feed_token', module: 'inventory', seed: () => {} },
  {
    feed: 'cycle', column: 'cycle_feed_token', module: 'health',
    seed: (userId) => db.prepare('INSERT INTO cycle_periods (user_id, start_date, end_date) VALUES (?, ?, ?)')
      .run(userId, dateKey(-10), dateKey(-6)),
  },
  {
    feed: 'schedule', column: 'schedule_feed_token', module: 'schedule',
    seed: (userId) => db.prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id) VALUES (?, ?, ?)')
      .run(userId, dateKey(2), shiftType),
  },
  { feed: 'waste', column: 'waste_feed_token', module: 'waste', seed: () => {} },
];

/** A subscriber of `feed` with own data, and a feed that delivers events. */
async function subscriber({ feed, column, seed }, user = {}) {
  const id = insertUser(user);
  seed(id);
  const token = `denied-${feed}-${id}-${'x'.repeat(32)}`;
  db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(token, id);
  const before = await fetchFeed(feed, token);
  assert.equal(before.status, 200, `precondition: /feed/${feed} answers`);
  assert.ok(hasEvent(before), `precondition: /feed/${feed} carries events:\n${before.body}`);
  return { id, token, before };
}

// --------------------------------------------------------------------------
// 1. `none` EMPTIES THE FEED - AND GIVING IT BACK FILLS IT AGAIN
// --------------------------------------------------------------------------
for (const spec of FEEDS) {
  test(`/feed/${spec.feed}: on ${spec.module} none an empty calendar, same headers, refilled on return`, async () => {
    const s = await subscriber(spec);
    if (spec.feed === 'calendar') {
      assert.ok(s.before.body.includes('Private appointment of another member'),
        'precondition: the personal feed carries another member\'s private event');
    }

    setModuleAccess('user', s.id, spec.module, 'none');
    const denied = await fetchFeed(spec.feed, s.token);
    assert.equal(denied.status, 200, 'the subscription stays valid - a 404 makes calendar apps drop it');
    assert.ok(!hasEvent(denied), `/feed/${spec.feed} still delivers to a member without ${spec.module}:\n${denied.body}`);
    assert.ok(denied.body.startsWith('BEGIN:VCALENDAR\r\n') && denied.body.endsWith('END:VCALENDAR\r\n'),
      `not a calendar:\n${denied.body}`);
    assert.deepEqual(denied.headers, s.before.headers, 'the HTTP headers changed');
    assert.deepEqual(denied.head, s.before.head, 'the calendar header lines changed (an app may rename the subscription)');

    clearModuleAccess('user', s.id, spec.module);
    const back = await fetchFeed(spec.feed, s.token);
    assert.equal(back.status, 200);
    assert.ok(hasEvent(back), 'giving the permission back did not fill the feed again');
  });
}

// --------------------------------------------------------------------------
// 2. BOTH SOURCES OF THE RESOLUTION
// --------------------------------------------------------------------------
for (const spec of FEEDS) {
  test(`/feed/${spec.feed}: ${spec.module} none from the role profile empties it too`, async () => {
    // A family role of its own per feed, so the profile row hits only this subscriber.
    const familyRole = 'grandparent';
    const s = await subscriber(spec, { familyRole });
    setModuleAccess('role', familyRole, spec.module, 'none');
    try {
      const denied = await fetchFeed(spec.feed, s.token);
      assert.equal(denied.status, 200);
      assert.ok(!hasEvent(denied), `the role profile denies ${spec.module} and /feed/${spec.feed} still delivers`);
    } finally {
      clearModuleAccess('role', familyRole, spec.module);
    }
  });
}

// --------------------------------------------------------------------------
// 3. COUNTER CASES: `read` IS NOT A LOCK, AND AN ADMIN IS NEVER AFFECTED
// --------------------------------------------------------------------------
for (const spec of FEEDS) {
  test(`/feed/${spec.feed}: ${spec.module} read keeps delivering`, async () => {
    const s = await subscriber(spec);
    setModuleAccess('user', s.id, spec.module, 'read');
    const feed = await fetchFeed(spec.feed, s.token);
    assert.equal(feed.status, 200);
    assert.ok(hasEvent(feed), 'a read permission turned into a lock');
  });

  test(`/feed/${spec.feed}: an admin with a deny row on their id keeps delivering`, async () => {
    const s = await subscriber(spec, { role: 'admin' });
    setModuleAccess('user', s.id, spec.module, 'none');
    const feed = await fetchFeed(spec.feed, s.token);
    assert.equal(feed.status, 200);
    assert.ok(hasEvent(feed), 'an admin was locked out by a permission row - admins bypass the matrix');
  });
}

// --------------------------------------------------------------------------
// 4. THE GUARD AGAINST TOMORROW'S GAP
//
// A feed whose module is not a key of the permission matrix would pass this
// axis: `resolvePermissions()` never sets an unknown key to `none`.
// --------------------------------------------------------------------------
test('every feed points at a module of the permission matrix', () => {
  const FEED_MODULE = origins.FEED_MODULE;
  assert.ok(FEED_MODULE, 'FEED_MODULE is not exported from server/services/reminder-origins.js');
  const gateable = new Set(PERMISSION_MODULES.map((m) => m.key));
  assert.ok(gateable.size >= 15, `only ${gateable.size} permission modules found`);
  assert.deepEqual(Object.keys(FEED_MODULE).sort(), FEEDS.map((f) => f.feed).sort(),
    'FEED_MODULE and the feeds of this suite drifted apart');
  for (const spec of FEEDS) assert.equal(FEED_MODULE[spec.feed], spec.module, `module of /feed/${spec.feed}`);
  const ungated = Object.entries(FEED_MODULE).filter(([, key]) => !gateable.has(key));
  assert.deepEqual(ungated, [], 'a feed points at a module the permission matrix does not know');
});
