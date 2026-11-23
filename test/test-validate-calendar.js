/**
 * Test: request validation in the calendar core and the dashboard (#2810,
 *       phase 2 section E, group 10a)
 * Purpose: six route files under server/routes/calendar/ (read 3, crud 10,
 *          local-calendars 7, feed 5, sync-targets 1, subscriptions 6) and
 *          server/routes/dashboard.js (1) check every request against the
 *          schema of its operation in the OpenAPI document
 *          (`validateRequest()` in every route, 33) before the handler runs.
 *          Held here against the real routers at their real prefixes, in the
 *          order of server/index.js (express.json, defaultEmptyBody, the
 *          dashboard, the calendar, the central error handler;
 *          test/calendar-app.js):
 *            - THE OWN CALLERS: the requests public/pages/calendar.js,
 *              settings/pages/personal-calendar-subscriptions.js and
 *              personal-feeds.js send pass - booleans for the switches,
 *              numbers for ids, `null` where the event form clears a field;
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              and `fields`: a switch as text or 0/1 (`all_day: "yes"` made an
 *              all-day event), an id as text (`local_calendar_id: "1"`), a
 *              path id that is not plain digits (`DELETE /calendar/1abc`
 *              deleted event 1), query garbage (`/upcoming?limit=abc` was 5),
 *              a missing body at a PUT (answered 200, nothing done);
 *            - ORDER: a malformed request is a 400 before the 404 and the 403
 *              of the row; with a valid body, a child without
 *              `calendar_edit_others` still meets the 403. The two rights
 *              without a row stand in front of the check
 *              (`requireCalendarWrite`, `refuseUploadWithoutDocumentsWrite`):
 *              there the 403 comes first, also with a malformed body;
 *            - REASONS STAY: a check with a reason of its own - the name of a
 *              local calendar or a subscription, an occurrence key, an
 *              address that does not parse - keeps its reason, the schema
 *              carries only type and shape;
 *            - THE DASHBOARD IS LENIENT BY PROMISE: every value its
 *              description tolerates still answers 200;
 *            - THE SINK: an assignee id that is no whole number reached the
 *              foreign key of `event_assignments` and answered 500;
 *            - ONE SOURCE: the value lists of the schemas are the constants of
 *              server/services/calendar-fields.js, which the handlers read,
 *              and its visibility levels equal those of the rights.
 *          The household zone is pinned; every date sent lies in 2035, and no
 *          answer asserted here carries a date of the clock. No network: the
 *          feed of a subscription comes from a local server.
 * Run: npm run test:validate-calendar
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js): the attachment of a document.
process.env.DOCUMENT_STORAGE_LOCAL_PATH = tempDir('yuvomi-validate-calendar-');
// The feed of the subscription comes from 127.0.0.1.
process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import rateLimit from 'express-rate-limit';
import { createCalendarApp } from './calendar-app.js';

const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const fields = await import('../server/services/calendar-fields.js');
const { VISIBILITY_VALUES, applyChildStartPermissions } = await import('../server/authorize/index.ts');
const { VALID_SOURCES } = await import('../server/routes/calendar/helpers.js');
const { validateCalendarName } = await import('../server/services/local-calendars.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';

/** @param {string} key @param {string} value */
function setConfig(key, value) {
  db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
/** @param {string} username @param {string} role @param {string} familyRole */
function user(username, role, familyRole) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('admin10', 'admin', 'mom');
const MEM = user('mem10', 'member', 'dad');
const CHILD = user('child10', 'member', 'child');
applyChildStartPermissions(db, { id: CHILD, role: 'member', family_role: 'child' });
setConfig('household_timezone', 'Europe/Berlin');

/**
 * Who asks: `reader` may only read the calendar (a member's right or a token
 * with `calendar:read`), `docread` may only read documents.
 * @type {Record<string, { id: number, role: string, access?: Record<string, string> }>}
 */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  child: { id: CHILD, role: 'member' },
  reader: { id: MEM, role: 'member', access: { calendar: 'read' } },
  docread: { id: MEM, role: 'member', access: { documents: 'read' } },
};

// A local feed for the subscription: no request leaves the machine.
const FEED = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:feed-1@test\r\nDTSTAMP:20350101T000000Z\r\nDTSTART:20350510T090000Z\r\nDTEND:20350510T100000Z\r\nSUMMARY:Feed event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const feedServer = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/calendar' }); res.end(FEED); });
await new Promise((r) => feedServer.listen(0, '127.0.0.1', () => r(null)));
const feedUrl = `http://127.0.0.1:${/** @type {any} */ (feedServer.address()).port}/feed.ics`;

const app = await createCalendarApp({
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.session = { userId: actor.id, role: actor.role };
    req.sessionModuleAccess = actor.access ?? null;
    req.authScopes = null;
    next();
  },
  // The routes check rights per row; in server/index.js the general API
  // limiter stands in front of them, here a generous one does.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  jsonLimit: '10mb',
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api/v1`)));
test.after(() => {
  server.close();
  feedServer.close();
});

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {{ json?: unknown, actor?: string }} [options] json left out: no body
 */
async function call(method, route, { json, actor } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor !== undefined) headers['x-actor'] = actor;
  /** @type {any} */
  let payload;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const text = await res.text();
  /** @type {any} */
  let body = null;
  try { body = JSON.parse(text); } catch { /* no JSON body */ }
  return { status: res.status, body };
}

/**
 * The 400 of the schema, naming the field.
 * @param {{ status: number, body: any }} res
 * @param {string} path the expected `fields[].path`, e.g. `body/all_day`
 * @param {string} label
 */
function assertRefused(res, path, label) {
  assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.equal(res.body?.reason, 'validation', label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path), `${label}: ${JSON.stringify(res.body.fields)}`);
}

// The body the event form sends (public/pages/calendar.js, saveEvent).
const UI_EVENT = {
  title: 'Zahnarzt', description: null, start_datetime: '2035-05-01T09:00', end_datetime: '2035-05-01T10:00',
  all_day: false, location: null, color: null, icon: 'calendar', assigned_to: [MEM],
  visibility: 'all', countdown: false, recurrence_rule: null,
  target_google_calendar_id: null, target_caldav_account_id: null, target_caldav_calendar_url: null,
  target_outlook_account_id: null, target_outlook_calendar_id: null,
};

/** @param {Record<string, unknown>} [extra] @param {string} [actor] */
async function createEvent(extra = {}, actor = 'admin') {
  const res = await call('POST', '/calendar', { json: { ...UI_EVENT, ...extra }, actor });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return /** @type {any} */ (res.body.data);
}

/** A daily series of five and the key of its second occurrence, as GET /calendar names it. */
async function createSeries() {
  const series = await createEvent({ title: 'Serie', recurrence_rule: 'FREQ=DAILY;COUNT=5' });
  const list = await call('GET', '/calendar?from=2035-05-01&to=2035-05-07');
  const second = list.body.data.filter((/** @type {any} */ e) => e.id === series.id)[1];
  assert.ok(second?.recurrence_id, 'the series has a second occurrence');
  return { id: series.id, key: encodeURIComponent(second.recurrence_id) };
}

// --------------------------------------------------------------------------
// The own callers pass
// --------------------------------------------------------------------------

test('the requests of the calendar page, its settings and the MCP tool pass', async () => {
  const event = await createEvent();
  assert.equal((await call('PUT', `/calendar/${event.id}`, { json: { title: 'Zahnarzt neu', color: '#FF3B30', end_datetime: null } })).status, 200);
  assert.equal((await call('GET', `/calendar/${event.id}`)).status, 200);
  // The MCP tool `create_event` sends text, booleans and leaves out the rest.
  assert.equal((await call('POST', '/calendar', { json: { title: 'MCP', start_datetime: '2035-05-03', all_day: true } })).status, 201);

  const { id, key } = await createSeries();
  assert.equal((await call('PUT', `/calendar/${id}/occurrences/${key}`, { json: { title: 'Nur einmal', reminder_offsets: [15] } })).status, 200);

  assert.equal((await call('GET', '/calendar?from=2035-05-01&to=2035-05-31&assigned_to=' + MEM + '&source=local')).status, 200);
  assert.equal((await call('GET', '/calendar/upcoming?limit=5')).status, 200);
  assert.equal((await call('GET', '/calendar/upcoming?limit=99')).body.data.length <= 20, true, 'a larger limit is cut, not refused');
  assert.deepEqual((await call('GET', '/calendar/search?q=a')).body, { data: [], total: 0 }, 'one character answers empty');
  assert.equal((await call('GET', '/calendar/holidays?from=2035-05-01&to=2035-05-31')).status, 200);

  const created = await call('POST', '/calendar/calendars', { json: { name: 'Arbeit', color: '#34C759' } });
  assert.equal(created.status, 201);
  const calendars = (await call('GET', '/calendar/calendars')).body.data.map((/** @type {any} */ c) => c.id);
  assert.equal((await call('PATCH', '/calendar/calendars/reorder', { json: { order: [...calendars].reverse() } })).status, 200);
  assert.equal((await call('PUT', `/calendar/calendars/${created.body.data.id}`, { json: { name: 'Beruf' } })).status, 200);

  assert.equal((await call('PUT', '/calendar/feed', { json: { showAssignees: true } })).status, 200);
  assert.equal((await call('PUT', '/calendar/feed', { json: { includeBirthdays: false } })).status, 200);

  // personal-calendar-subscriptions.js: `shared` as a boolean since #2810.
  const sub = await call('POST', '/calendar/subscriptions', { json: { url: feedUrl, name: 'Verein', color: '#123456', shared: true, default_assignee_user_ids: [] } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal((await call('PATCH', `/calendar/subscriptions/${sub.body.data.id}`, { json: { name: 'Verein neu', color: '#654321', shared: false } })).status, 200);
  assert.equal((await call('POST', '/calendar/import', { json: { color: '#123456', ics: FEED, local_calendar_id: created.body.data.id } })).status, 201);
  assert.equal((await call('GET', '/calendar/sync-targets')).status, 200);
});

test('an exception takes the occurrence key the calendar reads return, and the former date', async () => {
  const { id, key } = await createSeries();
  const byKey = await call('POST', `/calendar/${id}/exceptions`, { json: { recurrence_id: decodeURIComponent(key) } });
  assert.equal(byKey.status, 201, JSON.stringify(byKey.body));
  const other = await createSeries();
  const byDate = await call('POST', `/calendar/${other.id}/exceptions`, { json: { recurrence_id: null, date: '2035-05-03' } });
  assert.equal(byDate.status, 201, JSON.stringify(byDate.body));
});

// --------------------------------------------------------------------------
// Refused: garbage per field
// --------------------------------------------------------------------------

test('an event body with a switch, an id or a field of the wrong type is a 400', async () => {
  for (const [patch, path] of /** @type {Array<[Record<string, unknown>, string]>} */ ([
    [{ all_day: 'yes' }, 'body/all_day'],
    [{ all_day: 1 }, 'body/all_day'],
    [{ countdown: 'x' }, 'body/countdown'],
    [{ local_calendar_id: '1' }, 'body/local_calendar_id'],
    [{ local_calendar_id: true }, 'body/local_calendar_id'],
    [{ color: '' }, 'body/color'],
    [{ icon: 5 }, 'body/icon'],
    [{ visibility: 'bad' }, 'body/visibility'],
    [{ assigned_to: '2' }, 'body/assigned_to'],
    [{ end_datetime: '' }, 'body/end_datetime'],
    [{ start_datetime: '2035-02-30' }, 'body/start_datetime'],
    [{ target_google_calendar_id: 5 }, 'body/target_google_calendar_id'],
    [{ attachment_data: 5 }, 'body/attachment_data'],
  ])) {
    assertRefused(await call('POST', '/calendar', { json: { ...UI_EVENT, ...patch } }), path, `POST ${JSON.stringify(patch)}`);
  }
  const event = await createEvent();
  assertRefused(await call('PUT', `/calendar/${event.id}`, { json: { all_day: 'yes' } }), 'body/all_day', 'PUT all_day');
  assertRefused(await call('PUT', `/calendar/${event.id}`, { json: { confirmed_orphan_count: 1.5 } }), 'body/confirmed_orphan_count', 'PUT confirmed_orphan_count');
  // A PUT without a body answered 200 and changed nothing.
  assertRefused(await call('PUT', `/calendar/${event.id}`), 'body', 'PUT without a body');
  const stored = db.prepare('SELECT all_day FROM calendar_events WHERE id = ?').get(event.id);
  assert.equal(/** @type {any} */ (stored).all_day, 0, 'nothing written');
});

test('the sink: an assignee id that is no whole number never reaches the foreign key', async () => {
  // Before: `INSERT INTO event_assignments` with 1.5 or -1 failed its foreign
  // key and answered 500 `Internal error.`.
  for (const assigned of [[1.5], [-1], [0], ['x']]) {
    assertRefused(await call('POST', '/calendar', { json: { ...UI_EVENT, assigned_to: assigned } }), 'body/assigned_to', `assigned_to ${JSON.stringify(assigned)}`);
  }
  const event = await createEvent();
  assertRefused(await call('PUT', `/calendar/${event.id}`, { json: { assigned_to: [1.5] } }), 'body/assigned_to', 'PUT assigned_to [1.5]');
});

test('a path id that is not plain digits is a 400 and deletes nothing', async () => {
  const event = await createEvent({ title: 'Bleibt' });
  // parseInt read `1abc` as 1: the event was deleted (204).
  assertRefused(await call('DELETE', `/calendar/${event.id}abc`), 'path/id', 'DELETE 1abc');
  assertRefused(await call('DELETE', `/calendar/${event.id}.0`), 'path/id', 'DELETE 1.0');
  assert.equal((await call('GET', `/calendar/${event.id}`)).status, 200, 'the event is still there');
  const { id, key } = await createSeries();
  assertRefused(await call('DELETE', `/calendar/${id}.0/occurrences/${key}`), 'path/seriesId', 'DELETE occurrence 1.0');
  assertRefused(await call('POST', `/calendar/${id}abc/reset`), 'path/id', 'reset 1abc');
  // Number() read `0x1` as 1 at the local calendars.
  const cal = (await call('POST', '/calendar/calendars', { json: { name: 'Hex', color: '#123456' } })).body.data;
  assertRefused(await call('DELETE', `/calendar/calendars/0x${cal.id.toString(16)}`), 'path/id', 'DELETE calendar 0x');
  assert.ok((await call('GET', '/calendar/calendars')).body.data.some((/** @type {any} */ c) => c.id === cal.id), 'the calendar is still there');
  const sub = await call('POST', '/calendar/subscriptions', { json: { url: feedUrl, name: 'Pfad', color: '#123456' } });
  assertRefused(await call('DELETE', `/calendar/subscriptions/${sub.body.data.id}abc`), 'path/id', 'DELETE subscription 1abc');
});

test('the query of the calendar reads: garbage is a 400, what the description promises passes', async () => {
  // Was 5 (abc, 0, empty) or -1 (unchecked).
  for (const limit of ['abc', '0', '-1', '1.5', '']) {
    assertRefused(await call('GET', `/calendar/upcoming?limit=${limit}`), 'query/limit', `limit=${limit}`);
  }
  assertRefused(await call('GET', '/calendar/upcoming?limit=3&limit=4'), 'query/limit', 'limit twice');
  assertRefused(await call('GET', '/calendar?from=2035-02-30&to=2035-03-31'), 'query/from', 'from 30 February');
  assertRefused(await call('GET', '/calendar?assigned_to=abc'), 'query/assigned_to', 'assigned_to=abc');
  assert.equal((await call('GET', '/calendar?from=2035-05-01&to=2035-05-31&source=caldav')).status, 200, 'an unknown source is ignored');
  // /holidays: both days required (400 before too, now with the field), and a calendar day.
  assertRefused(await call('GET', '/calendar/holidays?to=2035-05-31'), 'query/from', 'holidays without from');
  assertRefused(await call('GET', '/calendar/holidays?from=2035-13-01&to=2035-13-02'), 'query/from', 'holidays month 13');
  assertRefused(await call('GET', '/calendar/search?q=ab&q=cd'), 'query/q', 'q twice');
});

test('local calendars, the feed, subscriptions and the import: garbage is a 400', async () => {
  const cal = (await call('POST', '/calendar/calendars', { json: { name: 'Garten', color: '#123456' } })).body.data;
  assertRefused(await call('POST', '/calendar/calendars', { json: { name: 'Null', color: null } }), 'body/color', 'color null (was the default)');
  assertRefused(await call('PUT', `/calendar/calendars/${cal.id}`, { json: { sort_order: '3' } }), 'body/sort_order', 'sort_order as text');
  assertRefused(await call('PUT', `/calendar/calendars/${cal.id}`, { json: {} }), 'body', 'PUT {}');
  assertRefused(await call('PATCH', '/calendar/calendars/reorder', { json: { order: 'x' } }), 'body/order', 'order as text');
  assertRefused(await call('PUT', '/calendar/feed', { json: { showAssignees: 'true' } }), 'body/showAssignees', 'feed switch as text');
  assertRefused(await call('PUT', '/calendar/feed', { json: {} }), 'body', 'feed without a switch');
  assertRefused(await call('POST', '/calendar/subscriptions', { json: { url: feedUrl, name: 'Eins', color: '#123456', shared: 1 } }), 'body/shared', 'shared as 1');
  const sub = await call('POST', '/calendar/subscriptions', { json: { url: feedUrl, name: 'Zwei', color: '#123456' } });
  assertRefused(await call('PATCH', `/calendar/subscriptions/${sub.body.data.id}`, { json: { shared: 'x' } }), 'body/shared', 'PATCH shared "x" (stored as 1)');
  assertRefused(await call('PATCH', `/calendar/subscriptions/${sub.body.data.id}`), 'body', 'PATCH without a body');
  assertRefused(await call('POST', '/calendar/subscriptions', { json: { url: feedUrl, name: 'Drei', color: '#123456', default_assignee_user_ids: ['x'] } }), 'body/default_assignee_user_ids/0', 'assignee as text');
  // `ics` and `url` together: the handler took `ics` (decision 18: `oneOf` stays).
  const both = await call('POST', '/calendar/import', { json: { ics: FEED, url: feedUrl } });
  assert.equal(both.status, 400);
  assert.equal(both.body.reason, 'validation');
  assertRefused(await call('POST', '/calendar/import', { json: { ics: FEED, local_calendar_id: '1' } }), 'body/local_calendar_id', 'import calendar id as text');
  assertRefused(await call('POST', `/calendar/1/exceptions`, { json: { recurrence_id: 5 } }), 'body/recurrence_id', 'exception key as number');
});

test('a check with a reason of its own keeps it: the schema carries only type and shape', async () => {
  const long = 'x'.repeat(fields.CALENDAR_NAME_MAX + 1);
  const name = await call('POST', '/calendar/calendars', { json: { name: long, color: '#123456' } });
  assert.equal(name.status, 400);
  assert.equal(name.body.reason, 'calendar_name_invalid');
  assert.deepEqual(name.body.params, { limit: fields.CALENDAR_NAME_MAX });
  assert.equal((await call('POST', '/calendar/calendars', { json: { name: '   ', color: '#123456' } })).body.reason, 'calendar_name_invalid');
  const subName = await call('POST', '/calendar/subscriptions', { json: { url: feedUrl, name: 'y'.repeat(fields.ICS_SUBSCRIPTION_NAME_MAX + 1), color: '#123456' } });
  assert.equal(subName.body.reason, 'calendar_subscription_name_invalid');
  assert.equal((await call('POST', '/calendar/subscriptions', { json: { url: 'not an address', name: 'Z', color: '#123456' } })).body.reason, 'calendar_ics_url_invalid');
  assert.equal((await call('POST', '/calendar/import', { json: { url: 'not an address' } })).body.reason, 'calendar_ics_url_invalid');
  const event = await createEvent({ recurrence_rule: 'FREQ=DAILY;COUNT=3' });
  assert.equal((await call('POST', `/calendar/${event.id}/exceptions`, { json: {} })).body.reason, 'malformed_recurrence_id');
  assert.equal((await call('PUT', `/calendar/${event.id}/occurrences/not-a-key`, { json: { title: 'x' } })).body.reason, 'invalid_recurrence_id');
});

test('PUT keeps a stored recurrence rule of any length: the edit form sends it back unchanged', async () => {
  // A synced series (CalDAV, Google) stores its rule as the server sends it,
  // without a length limit, and public/rrule-ui.js getRRuleValues() sends the
  // stored rule back when its fields were not touched. The handler takes a
  // rule equal to the stored one unchecked (#756); the schema of the update
  // must not refuse it first (no `maxLength` there).
  const longRule = `FREQ=YEARLY;COUNT=3;BYYEARDAY=${Array.from({ length: 120 }, (_, i) => i + 1).join(',')}`;
  assert.ok(longRule.length > 300, `${longRule.length} characters`);
  const event = await createEvent({ title: 'Synchronisiert' });
  db.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?').run(longRule, event.id);
  const res = await call('PUT', `/calendar/${event.id}`, { json: { title: 'Neuer Titel', recurrence_rule: longRule } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(/** @type {any} */ (db.prepare('SELECT title, recurrence_rule FROM calendar_events WHERE id = ?').get(event.id)).recurrence_rule, longRule);
  // A new rule of that length is still the handler's 400.
  const other = await createEvent({ title: 'Lokal' });
  const refused = await call('PUT', `/calendar/${other.id}`, { json: { recurrence_rule: longRule } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.reason, undefined, 'the handler sentence, not the schema');
});

// --------------------------------------------------------------------------
// Order
// --------------------------------------------------------------------------

test('a malformed request is a 400 before the 404 and the 403 of the row', async () => {
  const foreign = await createEvent({ title: 'Von Admin' });
  const { id, key } = await createSeries();
  // Unknown event: 404 with a valid body, 400 with a malformed one.
  assert.equal((await call('PUT', '/calendar/987654', { json: { title: 'x' } })).status, 404);
  assertRefused(await call('PUT', '/calendar/987654', { json: { title: 5 } }), 'body/title', 'unknown event, title 5');
  // A child without calendar_edit_others: 403 with a valid body ...
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['PUT', `/calendar/${foreign.id}`, { title: 'Kind' }],
    ['PUT', `/calendar/${id}/occurrences/${key}`, { title: 'Kind' }],
    ['PUT', `/calendar/${id}/occurrences/${key}/following`, { title: 'Kind' }],
    ['DELETE', `/calendar/${foreign.id}`, undefined],
  ])) {
    const res = await call(method, route, { json, actor: 'child' });
    assert.equal(res.status, 403, `${method} ${route}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'not_owner');
  }
  // ... and the 400 with a malformed one.
  assertRefused(await call('PUT', `/calendar/${foreign.id}`, { json: { title: 5 }, actor: 'child' }), 'body/title', 'child, title 5');
  assertRefused(await call('PUT', `/calendar/${id}/occurrences/${key}`, { json: { color: '' }, actor: 'child' }), 'body/color', 'child, occurrence color ""');
  assertRefused(await call('DELETE', `/calendar/${foreign.id}abc`, { actor: 'child' }), 'path/id', 'child, DELETE 1abc');
});

test('the two rights without a row stand in front of the check: 403 also with a malformed request', async () => {
  const cal = (await call('POST', '/calendar/calendars', { json: { name: 'Recht', color: '#123456' } })).body.data;
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['POST', '/calendar/calendars', { name: 5 }],
    ['POST', '/calendar/calendars', { name: 'Gueltig' }],
    ['PATCH', '/calendar/calendars/reorder', { order: 'x' }],
    ['PUT', `/calendar/calendars/${cal.id}`, { name: 5 }],
    ['PUT', '/calendar/calendars/987654', { name: 5 }],
    ['DELETE', '/calendar/calendars/abc', undefined],
    ['DELETE', `/calendar/calendars/${cal.id}`, undefined],
  ])) {
    const res = await call(method, route, { json, actor: 'reader' });
    assert.equal(res.status, 403, `${method} ${route} ${JSON.stringify(json)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'cross_module_access');
  }
  // An attachment without write access to documents: the 403 before the
  // schema and before the lookup (DECISIONS.md entry 10).
  const attachment = { attachment_data: `data:text/plain;base64,${Buffer.from('x').toString('base64')}`, attachment_name: 'a.txt' };
  const own = await createEvent({ title: 'Eigen' }, 'mem');
  const { id, key } = await createSeries();
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['POST', '/calendar', { ...UI_EVENT, ...attachment }],
    ['POST', '/calendar', { ...UI_EVENT, ...attachment, title: 5 }],
    ['PUT', `/calendar/${own.id}`, { ...attachment, title: 5 }],
    ['PUT', '/calendar/987654', { ...attachment, all_day: 'yes' }],
    ['PUT', `/calendar/${id}/occurrences/${key}`, { ...attachment, color: '' }],
    ['PUT', `/calendar/${id}/occurrences/${key}/following`, { ...attachment, color: '' }],
  ])) {
    const res = await call(method, route, { json, actor: 'docread' });
    assert.equal(res.status, 403, `${method} ${route}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'ATTACHMENT_UPLOAD_REFUSED');
  }
});

// --------------------------------------------------------------------------
// The dashboard
// --------------------------------------------------------------------------

test('the dashboard answers every value its description tolerates with 200', async () => {
  for (const query of [
    'audience=x', 'audience=', 'audience=household&audience=household', 'events_scope=x', 'events_scope=',
    'events_birthdays=x', 'events_limit=7', 'events_limit=500', 'events_limit=abc', 'events_limit=', 'events_limit=8.0',
    'events_limit=5&events_limit=8', 'notes_category=abc', 'notes_category=0', 'notes_category=-1', 'notes_category=1.5',
    'notes_category=', 'notes_category=1,2', 'shopping_list=abc', 'shopping_list=0', 'shopping_list=1,2',
    'events_calendar=x', 'events_calendar=local:0', 'events_calendar=', 'events_calendar=local:01', 'tasks_category=',
    Array.from({ length: 51 }, (_, i) => `notes_category=${i + 1}`).join('&'),
    'events_limit[]=12', 'events_limit[a]=12',
  ]) {
    const res = await call('GET', `/dashboard/?${query}`);
    assert.equal(res.status, 200, `${query.slice(0, 60)}: ${JSON.stringify(res.body)?.slice(0, 200)}`);
  }
  assert.equal((await call('GET', '/dashboard/?events_limit=12&events_scope=mine&audience=household')).status, 200);
});

// --------------------------------------------------------------------------
// One source
// --------------------------------------------------------------------------

test('the value lists of the schemas are the constants the handlers read', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec({}));
  const schemas = spec.components.schemas;
  assert.deepEqual([...fields.EVENT_VISIBILITY], [...VISIBILITY_VALUES], 'the visibility levels of the rights');
  for (const name of ['CalendarEventCreateInput', 'CalendarEventUpdateInput', 'CalendarOccurrenceOnlyMutation', 'CalendarOccurrenceFollowingMutation']) {
    assert.deepEqual(schemas[name].properties.visibility.enum, [...fields.EVENT_VISIBILITY], name);
  }
  for (const name of ['CalendarOccurrenceOnlyMutation', 'CalendarOccurrenceFollowingMutation']) {
    assert.equal(schemas[name].properties.reminder_offsets.maxItems, fields.MAX_REMINDER_OFFSETS, name);
  }
  assert.equal(VALID_SOURCES, fields.VALID_SOURCES, 'the route reads the one list');
  const source = spec.paths['/api/v1/calendar'].get.parameters.find((/** @type {any} */ p) => p.name === 'source');
  assert.equal(source.schema.enum, undefined, 'another source is ignored, not refused');
  for (const value of fields.VALID_SOURCES) assert.match(source.description, new RegExp(`\`${value}\``));
  assert.deepEqual(validateCalendarName('x'.repeat(fields.CALENDAR_NAME_MAX + 1)).params, { limit: fields.CALENDAR_NAME_MAX });
  assert.equal(validateCalendarName('x'.repeat(fields.CALENDAR_NAME_MAX)).error, null);
  // Lengths with a reason stay out of the schema (decision 14).
  for (const name of ['LocalCalendarCreateInput', 'LocalCalendarUpdateInput', 'IcsSubscriptionCreateInput', 'IcsSubscriptionUpdateInput']) {
    assert.equal(schemas[name].properties.name.maxLength, undefined, name);
    assert.equal(schemas[name].properties.name.minLength, undefined, name);
  }
});
