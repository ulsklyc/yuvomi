/**
 * Test: request validation in the calendar provider routes (#2810, phase 2
 *       section E, group 10b)
 * Purpose: the four provider route files under server/routes/calendar/
 *          (google 12, apple 5, caldav 12, outlook 9) check every request
 *          against the schema of its operation in the OpenAPI document
 *          (`validateRequest()` in every route, 38) before the handler runs.
 *          Held here against the real routers at their real prefix, in the
 *          order of server/index.js (test/calendar-app.js):
 *            - THE OWN CALLERS: the requests public/settings/pages/
 *              sync-calendar.js and sync-reminders.js send pass - booleans
 *              for the switches, numbers for people, `null` where the
 *              Outlook controls clear a field, `deleteEvents=true|false`;
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              and `fields`: a switch as text (`enabled: "false"` switched a
 *              CalDAV calendar ON), a path id that is not plain digits
 *              (`PUT /caldav/accounts/1abc` changed account 1), a query
 *              switch outside `true|false`, a missing body at a PUT;
 *            - ORDER: `requireAdmin` stands in front of the check (a member
 *              with a malformed body meets the 403), the check in front of
 *              the account lookup (400 before 404);
 *            - UNKNOWN ACCOUNT (decision 11): a CalDAV or Outlook account in
 *              the path that does not exist is a 404 with its reason, looked
 *              up before the service, whose plain Error answered 500 or a
 *              502 `remote_failed` as if the server had refused;
 *            - THE OAUTH CALLBACKS (decision 12) declare no query: whatever
 *              the provider sends goes on to the redirect, never a 400 of the
 *              check;
 *            - SINKS: a value of the wrong type reached the service raw
 *              (`targetModule: "x"` and `calendarUrl: 5` answered 500,
 *              `name: 5` was stored as the name of a CalDAV account);
 *            - REASONS STAY: the checks with an answer of their own
 *              (`apple_url_invalid`, a password too long, a blank id) stay
 *              in the handler, the schema carries type and shape only;
 *            - ONE SOURCE: the value lists of the schemas are the constants of
 *              server/services/calendar-fields.js, which the handlers read,
 *              and equal the CHECK constraints of their columns;
 *            - ONLY GUARD (step b): what the handlers no longer check
 *              themselves is pinned as values of the built document;
 *            - FULL REPRESENTATION (step c): `PATCH /external-calendars`
 *              requires `default_assignee_user_ids` or
 *              `default_assignee_user_id` (left out, the stored set was
 *              emptied); the PATCH of sync-calendar.js sends the list.
 *          No network: no Google, Microsoft, iCloud or CalDAV server is asked.
 *          Every request either stops at the check, at a handler check before
 *          the service, or reaches a service path that only reads and writes
 *          the database (an unconnected Google answers 409 before any call).
 * Run: npm run test:validate-calendar-providers
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Outlook counts as configured, so the account routes reach the lookup; no
// request to Microsoft is made by the routes asked here.
process.env.MS_CLIENT_ID = 'test-client';
process.env.MS_CLIENT_SECRET = 'test-secret-value';
process.env.MS_REDIRECT_URI = 'http://127.0.0.1/api/v1/calendar/outlook/callback';
for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete process.env[key];

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import rateLimit from 'express-rate-limit';
import { createCalendarApp } from './calendar-app.js';

const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const fields = await import('../server/services/calendar-fields.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
/** The `fields` of a PATCH /external-calendars without either assignee field (measured). */
const MISSING_ASSIGNEES = [
  { path: 'body/default_assignee_user_ids', rule: 'required' },
  { path: 'body/default_assignee_user_id', rule: 'required' },
  { path: 'body', rule: 'anyOf' },
];

/** @param {string} username @param {string} role @param {string} familyRole */
function user(username, role, familyRole) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('admin10b', 'admin', 'mom');
const MEM = user('mem10b', 'member', 'dad');

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
};

const app = await createCalendarApp({
  auth: (/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = 'session';
    req.session = { userId: actor.id, role: actor.role };
    req.sessionModuleAccess = null;
    req.authScopes = null;
    next();
  },
  // server/index.js puts the general API limiter in front; a generous one here.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  mount: ['calendar'],
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api/v1`)));
test.after(() => { server.close(); });

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
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  /** @type {any} */
  let body = null;
  try { body = JSON.parse(text); } catch { /* no JSON body */ }
  return { status: res.status, body, location: res.headers.get('location') };
}

/**
 * The 400 of the schema, naming the field.
 * @param {{ status: number, body: any }} res
 * @param {string} path the expected `fields[].path`
 * @param {string} label
 */
function assertRefused(res, path, label) {
  assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.equal(res.body?.reason, 'validation', label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path), `${label}: ${JSON.stringify(res.body.fields)}`);
}

/**
 * Not the refusal of the schema: the request reached the handler.
 * @param {{ status: number, body: any }} res
 * @param {string} label
 */
function assertPassed(res, label) {
  assert.notEqual(res.body?.error, SENTENCE, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
  assert.notEqual(res.status, 500, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
}

// A CalDAV account with one calendar and one reminder list, stored by hand:
// no server is asked for them.
function caldavAccount(name = 'Fake') {
  const id = Number(db.prepare("INSERT INTO caldav_accounts (name, caldav_url, username, password, reminders_discovered_at) VALUES (?, 'https://dav.invalid/', ?, 'p', '2035-01-01T00:00:00Z')")
    .run(name, `u-${name}`).lastInsertRowid);
  db.prepare("INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled) VALUES (?, 'https://dav.invalid/cal/', 'Cal', '#336699', 1)").run(id);
  db.prepare("INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled) VALUES (?, 'https://dav.invalid/list/', 'List', 'tasks', 0)").run(id);
  return id;
}
function outlookAccount(name = 'Papa') {
  const id = Number(db.prepare(`INSERT INTO outlook_accounts (name, ms_user_id, email, access_token, refresh_token, token_expiry)
    VALUES (?, ?, 'p@example.invalid', 'tok', 'ref', '2099-01-01T00:00:00Z')`).run(name, `ms-${name}`).lastInsertRowid);
  db.prepare("INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled) VALUES (?, 'cal-A', 'Kalender A', 1, 0)").run(id);
  return id;
}

test('the own callers: every request of the settings pages reaches the handler', async () => {
  const cd = caldavAccount('Own');
  const ol = outlookAccount('Own');
  db.prepare("INSERT INTO external_calendars (source, external_id, name, color) VALUES ('google', 'g-1', 'Google', NULL)").run();

  // Google (sync-calendar.js).
  assertPassed(await call('POST', '/calendar/google/sync', { json: {} }), 'POST google/sync {}');
  assertPassed(await call('GET', '/calendar/google/status'), 'GET google/status');
  const toggle = await call('PATCH', '/calendar/google/calendars', { json: { calendarId: 'g-1', enabled: true } });
  assertPassed(toggle, 'PATCH google/calendars');
  assert.equal(toggle.status, 409, 'unconnected: google_not_configured, no call to Google');
  assert.equal((await call('PUT', '/calendar/google/readonly', { json: { readonly: true } })).status, 200);
  assert.equal((await call('PATCH', '/calendar/external-calendars', { json: { source: 'google', external_id: 'g-1', default_assignee_user_ids: [MEM] } })).status, 200);
  assert.equal((await call('GET', '/calendar/external-calendars/default-assignee-backfill')).status, 200);
  const backfill = await call('POST', '/calendar/external-calendars/default-assignee-backfill', { json: { expected_count: 0, expected_token: null, moves: [] } });
  assert.ok([200, 409].includes(backfill.status), JSON.stringify(backfill.body));
  for (const v of ['true', 'false']) {
    assert.equal((await call('DELETE', `/calendar/google/disconnect?deleteEvents=${v}`)).status, 200, `google deleteEvents=${v}`);
  }
  assert.equal((await call('DELETE', '/calendar/google/mirrored-events')).status, 200);

  // Apple: the form sends three strings; a url without http(s) is the
  // handler's own answer, so nothing is sent to iCloud.
  const apple = await call('POST', '/calendar/apple/connect', { json: { url: 'ftp://caldav.invalid', username: 'me@example.invalid', password: 'app-pass' } });
  assert.equal(apple.status, 400);
  assert.equal(apple.body.reason, 'apple_url_invalid');
  assertPassed(await call('GET', '/calendar/apple/status'), 'GET apple/status');
  for (const v of ['true', 'false']) {
    assert.equal((await call('DELETE', `/calendar/apple/disconnect?deleteEvents=${v}`)).status, 204, `apple deleteEvents=${v}`);
  }

  // CalDAV: the add form sends four strings; a password above 4096
  // characters is the handler's answer, before any connection.
  const add = await call('POST', '/calendar/caldav/accounts', { json: { name: 'N', caldavUrl: 'https://dav.invalid/', username: 'u', password: 'x'.repeat(4097) } });
  assert.equal(add.status, 400);
  assert.notEqual(add.body.error, SENTENCE);
  assert.equal((await call('GET', '/calendar/caldav/accounts')).status, 200);
  assert.equal((await call('GET', `/calendar/caldav/accounts/${cd}/calendars`)).status, 200);
  for (const deleteEvents of [false, true]) {
    const res = await call('PATCH', `/calendar/caldav/accounts/${cd}/calendars`, { json: { calendarUrl: 'https://dav.invalid/cal/', enabled: false, deleteEvents } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  assert.equal((await call('PUT', `/calendar/caldav/accounts/${cd}`, { json: { name: 'Renamed' } })).status, 200);
  assert.equal((await call('GET', `/calendar/caldav/accounts/${cd}/reminder-lists`)).status, 200);
  for (const json of [
    { listUrl: 'https://dav.invalid/list/', defaultAssigneeUserIds: [MEM] },
    { listUrl: 'https://dav.invalid/list/', targetModule: 'tasks' },
    { listUrl: 'https://dav.invalid/list/', enabled: true, targetModule: 'tasks' },
  ]) {
    const res = await call('PATCH', `/calendar/caldav/accounts/${cd}/reminder-lists`, { json });
    assert.equal(res.status, 200, `${JSON.stringify(json)}: ${JSON.stringify(res.body)}`);
  }
  assertPassed(await call('GET', '/calendar/caldav/status'), 'GET caldav/status');
  assertPassed(await call('GET', '/calendar/caldav/reminders/status'), 'GET caldav/reminders/status');
  const gone = caldavAccount('Gone');
  for (const v of ['false', 'true']) {
    const id = v === 'false' ? gone : caldavAccount('Gone2');
    assert.equal((await call('DELETE', `/calendar/caldav/accounts/${id}?deleteEvents=${v}`)).status, 200, `caldav deleteEvents=${v}`);
  }

  // Outlook: the auto-sync controls send a calendar id or null, a number or null.
  assert.equal((await call('GET', '/calendar/outlook/accounts')).status, 200);
  for (const json of [{ autoSyncCalendarId: null }, { ownerUserId: MEM }, { ownerUserId: null }]) {
    const res = await call('PUT', `/calendar/outlook/accounts/${ol}`, { json });
    assert.equal(res.status, 200, `${JSON.stringify(json)}: ${JSON.stringify(res.body)}`);
  }
  assert.equal((await call('GET', `/calendar/outlook/accounts/${ol}/calendars`)).status, 200);
  assert.equal((await call('PATCH', `/calendar/outlook/accounts/${ol}/calendars`, { json: { calendarId: 'cal-A', enabled: true } })).status, 200);
  assertPassed(await call('GET', '/calendar/outlook/status'), 'GET outlook/status');
  assert.equal((await call('DELETE', `/calendar/outlook/accounts/${outlookAccount('Gone')}`)).status, 200);
});

test('refused: garbage per field is a 400 of the schema', async () => {
  const cd = caldavAccount('Garbage');
  const ol = outlookAccount('Garbage');
  /** @type {Array<[string, string, unknown, string]>} */
  const cases = [
    // Google
    ['PATCH', '/calendar/google/calendars', { calendarId: 'g-1', enabled: 'false' }, 'body/enabled'],
    ['PATCH', '/calendar/google/calendars', { calendarId: 5, enabled: true }, 'body/calendarId'],
    ['PATCH', '/calendar/google/calendars', { enabled: true }, 'body/calendarId'],
    ['PUT', '/calendar/google/readonly', { readonly: 1 }, 'body/readonly'],
    ['PUT', '/calendar/google/readonly', undefined, 'body'],
    ['PATCH', '/calendar/external-calendars', { source: 'outlook', external_id: 'x', default_assignee_user_ids: [] }, 'body/source'],
    ['PATCH', '/calendar/external-calendars', { source: 'google', external_id: 5, default_assignee_user_ids: [] }, 'body/external_id'],
    ['PATCH', '/calendar/external-calendars', { source: 'google', external_id: 'g-1', default_assignee_user_ids: ['2'] }, 'body/default_assignee_user_ids/0'],
    ['POST', '/calendar/external-calendars/default-assignee-backfill', { expected_count: '0' }, 'body/expected_count'],
    ['POST', '/calendar/external-calendars/default-assignee-backfill', { expected_count: 0, expected_token: 'abc' }, 'body/expected_token'],
    ['POST', '/calendar/external-calendars/default-assignee-backfill', { expected_count: 0, moves: [{ event_id: '1', from_user_ids: [1], to_user_ids: [2] }] }, 'body/moves/0/event_id'],
    ['DELETE', '/calendar/google/disconnect?deleteEvents=yes', undefined, 'query/deleteEvents'],
    ['GET', '/calendar/external-calendars/default-assignee-backfill?moved_after=a&moved_after=b', undefined, 'query/moved_after'],
    // Apple
    ['POST', '/calendar/apple/connect', { url: 'https://caldav.invalid', username: 5, password: 'p' }, 'body/username'],
    ['POST', '/calendar/apple/connect', { url: 5, username: 'u', password: 'p' }, 'body/url'],
    ['POST', '/calendar/apple/connect', { url: 'https://caldav.invalid', username: 'u' }, 'body/password'],
    ['DELETE', '/calendar/apple/disconnect?deleteEvents=1', undefined, 'query/deleteEvents'],
    // CalDAV
    ['POST', '/calendar/caldav/accounts', { name: 5, caldavUrl: 'https://dav.invalid/', username: 'u', password: 'p' }, 'body/name'],
    ['PUT', `/calendar/caldav/accounts/${cd}`, { name: 5 }, 'body/name'],
    ['PUT', `/calendar/caldav/accounts/${cd}`, undefined, 'body'],
    ['PUT', '/calendar/caldav/accounts/1abc', { name: 'x' }, 'path/id'],
    ['DELETE', `/calendar/caldav/accounts/${cd}.0`, undefined, 'path/id'],
    ['DELETE', `/calendar/caldav/accounts/${cd}?deleteEvents=TRUE`, undefined, 'query/deleteEvents'],
    ['GET', `/calendar/caldav/accounts/${cd}/calendars?refresh=1`, undefined, 'query/refresh'],
    ['PATCH', `/calendar/caldav/accounts/${cd}/calendars`, { calendarUrl: 'https://dav.invalid/cal/', enabled: 'false' }, 'body/enabled'],
    ['PATCH', `/calendar/caldav/accounts/${cd}/calendars`, { calendarUrl: 5, enabled: true }, 'body/calendarUrl'],
    ['GET', `/calendar/caldav/accounts/${cd}/reminder-lists?refresh=yes`, undefined, 'query/refresh'],
    ['PATCH', `/calendar/caldav/accounts/${cd}/reminder-lists`, { listUrl: 'https://dav.invalid/list/', targetModule: 'x' }, 'body/targetModule'],
    ['PATCH', `/calendar/caldav/accounts/${cd}/reminder-lists`, { listUrl: 'https://dav.invalid/list/', enabled: 0 }, 'body/enabled'],
    ['PATCH', `/calendar/caldav/accounts/${cd}/reminder-lists`, { listUrl: 'https://dav.invalid/list/', defaultAssigneeUserIds: [0] }, 'body/defaultAssigneeUserIds/0'],
    // Outlook
    ['PUT', `/calendar/outlook/accounts/${ol}`, { ownerUserId: '2' }, 'body/ownerUserId'],
    ['PUT', `/calendar/outlook/accounts/${ol}`, { name: 5 }, 'body/name'],
    ['PUT', `/calendar/outlook/accounts/${ol}`, undefined, 'body'],
    ['DELETE', `/calendar/outlook/accounts/${ol}abc`, undefined, 'path/id'],
    ['GET', `/calendar/outlook/accounts/${ol}/calendars?refresh=1`, undefined, 'query/refresh'],
    ['PATCH', `/calendar/outlook/accounts/${ol}/calendars`, { calendarId: 'cal-A', enabled: 'true' }, 'body/enabled'],
  ];
  for (const [method, route, json, path] of cases) {
    assertRefused(await call(method, route, { json }), path, `${method} ${route} ${JSON.stringify(json)}`);
  }
  // Nothing of it was written: the account keeps its name, the calendar its state.
  assert.equal(db.prepare('SELECT name FROM caldav_accounts WHERE id = ?').get(cd).name, 'Garbage');
  assert.equal(db.prepare('SELECT enabled FROM caldav_calendar_selection WHERE account_id = ?').get(cd).enabled, 1);
});

test('enabled: "false" no longer switches a CalDAV calendar on', async () => {
  const cd = caldavAccount('Switch');
  db.prepare('UPDATE caldav_calendar_selection SET enabled = 0 WHERE account_id = ?').run(cd);
  const res = await call('PATCH', `/calendar/caldav/accounts/${cd}/calendars`, { json: { calendarUrl: 'https://dav.invalid/cal/', enabled: 'false' } });
  assertRefused(res, 'body/enabled', 'enabled: "false"');
  assert.equal(db.prepare('SELECT enabled FROM caldav_calendar_selection WHERE account_id = ?').get(cd).enabled, 0);
});

test('a path id that is not plain digits changes no account', async () => {
  const cd = caldavAccount('Tail');
  const res = await call('PUT', `/calendar/caldav/accounts/${cd}abc`, { json: { name: 'Hijacked' } });
  assertRefused(res, 'path/id', `PUT /caldav/accounts/${cd}abc`);
  assert.equal(db.prepare('SELECT name FROM caldav_accounts WHERE id = ?').get(cd).name, 'Tail');
  const ol = outlookAccount('Tail');
  assertRefused(await call('DELETE', `/calendar/outlook/accounts/${ol}.0`), 'path/id', 'DELETE outlook 1.0');
  assert.ok(db.prepare('SELECT 1 FROM outlook_accounts WHERE id = ?').get(ol), 'the Outlook account is still there');
});

test('unknown account: 404 with its reason, before the service (decision 11)', async () => {
  const UNKNOWN = 999999;
  /** @type {Array<[string, string, unknown, string]>} */
  const cases = [
    ['PUT', `/calendar/caldav/accounts/${UNKNOWN}`, { name: 'x' }, 'caldav_account_not_found'],
    ['DELETE', `/calendar/caldav/accounts/${UNKNOWN}?deleteEvents=false`, undefined, 'caldav_account_not_found'],
    ['GET', `/calendar/caldav/accounts/${UNKNOWN}/calendars`, undefined, 'caldav_account_not_found'],
    ['GET', `/calendar/caldav/accounts/${UNKNOWN}/calendars?refresh=true`, undefined, 'caldav_account_not_found'],
    ['PATCH', `/calendar/caldav/accounts/${UNKNOWN}/calendars`, { calendarUrl: 'https://dav.invalid/cal/', enabled: true }, 'caldav_account_not_found'],
    ['GET', `/calendar/caldav/accounts/${UNKNOWN}/reminder-lists?refresh=true`, undefined, 'caldav_account_not_found'],
    ['PATCH', `/calendar/caldav/accounts/${UNKNOWN}/reminder-lists`, { listUrl: 'https://dav.invalid/list/', enabled: true }, 'caldav_account_not_found'],
    ['PUT', `/calendar/outlook/accounts/${UNKNOWN}`, { name: 'x' }, 'outlook_account_not_found'],
    ['DELETE', `/calendar/outlook/accounts/${UNKNOWN}`, undefined, 'outlook_account_not_found'],
    ['GET', `/calendar/outlook/accounts/${UNKNOWN}/calendars?refresh=true`, undefined, 'outlook_account_not_found'],
    ['PATCH', `/calendar/outlook/accounts/${UNKNOWN}/calendars`, { calendarId: 'cal-A', enabled: true }, 'outlook_account_not_found'],
  ];
  for (const [method, route, json, reason] of cases) {
    const res = await call(method, route, { json });
    assert.equal(res.status, 404, `${method} ${route}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, reason, `${method} ${route}`);
  }
  // A path id 0 or -1 passes the check (plain digits) and meets the same 404.
  for (const id of ['0', '-1']) {
    assert.equal((await call('DELETE', `/calendar/caldav/accounts/${id}`)).status, 404, `caldav ${id}`);
    assert.equal((await call('DELETE', `/calendar/outlook/accounts/${id}`)).status, 404, `outlook ${id}`);
  }
});

test('order: admin before the check, the check before the account lookup', async () => {
  // A member with a malformed request meets the 403 of requireAdmin.
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['PATCH', '/calendar/google/calendars', { enabled: 'x' }],
    ['PUT', '/calendar/caldav/accounts/1abc', { name: 5 }],
    ['PATCH', '/calendar/external-calendars', { source: 5 }],
    ['DELETE', '/calendar/apple/disconnect?deleteEvents=yes', undefined],
    ['PUT', '/calendar/outlook/accounts/1', undefined],
  ])) {
    const res = await call(method, route, { json, actor: 'mem' });
    assert.equal(res.status, 403, `${method} ${route}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  // A malformed request to an unknown account is the 400, not the 404.
  assertRefused(await call('PUT', '/calendar/caldav/accounts/999999', { json: { name: 5 } }), 'body/name', 'caldav 400 before 404');
  assertRefused(await call('PATCH', '/calendar/outlook/accounts/999999/calendars', { json: { calendarId: 'c', enabled: 'x' } }), 'body/enabled', 'outlook 400 before 404');
});

test('the OAuth callbacks declare no query: what the provider sends goes on to the redirect', async () => {
  for (const provider of ['google', 'outlook']) {
    for (const query of ['error=access_denied&scope=x&prompt=consent', 'code=a&code=b&state=s', 'code=a&state=s&authuser=0']) {
      const res = await call('GET', `/calendar/${provider}/callback?${query}`);
      assert.equal(res.status, 302, `${provider} ?${query}: ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.location, `/settings?sync_error=${provider}`, `${provider} ?${query}`);
    }
    // Without `code` and `error` the handler keeps its own JSON answer.
    const none = await call('GET', `/calendar/${provider}/callback?state=s`);
    assert.equal(none.status, 400);
    assert.equal(none.body.error, 'No authorization code received.');
  }
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  for (const provider of ['google', 'outlook']) {
    const operation = spec.paths[`/api/v1/calendar/${provider}/callback`].get;
    assert.equal((operation.parameters ?? []).filter((/** @type {any} */ p) => p.in === 'query').length, 0, `${provider} callback declares no query`);
    assert.ok(operation.responses[302] && operation.responses[400], `${provider} callback documents 302 and 400`);
  }
});

test('sinks: a value of the wrong type no longer reaches the service', async () => {
  const cd = caldavAccount('Sink');
  // `targetModule: "x"` threw a plain Error in the service (500).
  assertRefused(await call('PATCH', `/calendar/caldav/accounts/${cd}/reminder-lists`, { json: { listUrl: 'https://dav.invalid/list/', targetModule: 'x' } }), 'body/targetModule', 'targetModule x');
  // `calendarUrl: 5` found no selection (500).
  assertRefused(await call('PATCH', `/calendar/caldav/accounts/${cd}/calendars`, { json: { calendarUrl: 5, enabled: true } }), 'body/calendarUrl', 'calendarUrl 5');
  // `name: 5` was stored as the name.
  assertRefused(await call('PUT', `/calendar/caldav/accounts/${cd}`, { json: { name: 5 } }), 'body/name', 'name 5');
  assert.equal(db.prepare('SELECT name FROM caldav_accounts WHERE id = ?').get(cd).name, 'Sink');
});

test('reasons stay with the handler: the schema carries type and shape only', async () => {
  const apple = await call('POST', '/calendar/apple/connect', { json: { url: 'caldav.invalid', username: 'u', password: 'p' } });
  assert.equal(apple.status, 400);
  assert.equal(apple.body.reason, 'apple_url_invalid');
  const blank = await call('PATCH', '/calendar/google/calendars', { json: { calendarId: '   ', enabled: true } });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error, 'calendarId is missing or invalid.');
  const missing = await call('PATCH', `/calendar/caldav/accounts/${caldavAccount('Reason')}/reminder-lists`, { json: { listUrl: 'https://dav.invalid/list/' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'Missing listUrl or update fields.');
  // No x-reason in the provider schemas (decision 14).
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const names = ['GoogleCalendarSelectionInput', 'GoogleReadonlyInput', 'ExternalCalendarAssigneesInput', 'DefaultAssigneeBackfillInput',
    'AppleConnectInput', 'CaldavAccountCreateInput', 'CaldavAccountUpdateInput', 'CaldavCalendarSelectionInput',
    'CaldavReminderListUpdateInput', 'OutlookAccountUpdateInput', 'OutlookCalendarSelectionInput'];
  for (const name of names) {
    assert.ok(spec.components.schemas[name], name);
    assert.ok(!JSON.stringify(spec.components.schemas[name]).includes('x-reason'), `${name} carries no x-reason`);
    assert.ok(!('additionalProperties' in spec.components.schemas[name]), `${name} leaves unknown fields alone`);
  }
  // Passwords are write-only.
  for (const name of ['AppleConnectInput', 'CaldavAccountCreateInput', 'CaldavAccountUpdateInput']) {
    assert.equal(spec.components.schemas[name].properties.password.writeOnly, true, `${name}.password`);
  }
});

test('one source: the value lists of the schemas are those of calendar-fields.js and of the columns', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schemas = spec.components.schemas;
  assert.deepEqual(schemas.ExternalCalendarAssigneesInput.properties.source.enum, [...fields.EXTERNAL_CALENDAR_SOURCES]);
  assert.deepEqual(schemas.CaldavReminderListUpdateInput.properties.targetModule.enum, [...fields.REMINDER_LIST_TARGETS]);
  // The CHECK constraints of the columns take exactly these values.
  const cd = caldavAccount('Check');
  const tryInsert = (/** @type {() => void} */ fn) => { try { fn(); return true; } catch { return false; } };
  for (const source of [...fields.EXTERNAL_CALENDAR_SOURCES, 'outlook', 'ics', 'local']) {
    const ok = tryInsert(() => db.prepare("INSERT INTO external_calendars (source, external_id, name) VALUES (?, ?, 'n')").run(source, `check-${source}`));
    assert.equal(ok, fields.EXTERNAL_CALENDAR_SOURCES.includes(source), `external_calendars.source ${source}`);
  }
  for (const module of [...fields.REMINDER_LIST_TARGETS, 'notes', 'calendar']) {
    const ok = tryInsert(() => db.prepare("INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module) VALUES (?, ?, 'n', ?)").run(cd, `https://dav.invalid/${module}/`, module));
    assert.equal(ok, fields.REMINDER_LIST_TARGETS.includes(module), `caldav_reminder_selection.target_module ${module}`);
  }
});

// --------------------------------------------------------------------------
// Full representation (group 10b c)
// --------------------------------------------------------------------------

/** A synced Google calendar with stored default assignees. @param {string} externalId @param {number[]} ids */
function assignedCalendar(externalId, ids) {
  const id = Number(db.prepare("INSERT INTO external_calendars (source, external_id, name, color) VALUES ('google', ?, 'Assigned', NULL)")
    .run(externalId).lastInsertRowid);
  db.prepare('DELETE FROM external_calendar_assignees WHERE calendar_id = ?').run(id);
  const ins = db.prepare('INSERT INTO external_calendar_assignees (calendar_id, user_id, position) VALUES (?, ?, ?)');
  ids.forEach((uid, position) => ins.run(id, uid, position));
  return id;
}
/** The stored set, in order. @param {number} id */
function storedAssignees(id) {
  return db.prepare('SELECT user_id FROM external_calendar_assignees WHERE calendar_id = ? ORDER BY position, user_id')
    .all(id).map((/** @type {any} */ r) => r.user_id);
}

test('full representation: PATCH /external-calendars requires one of the two assignee fields', async () => {
  // Left out, the route wrote an empty set: `[2,3]` became `[]` with a 200.
  const cal = assignedCalendar('full-1', [ADMIN, MEM]);
  const target = { source: 'google', external_id: 'full-1' };
  const without = await call('PATCH', '/calendar/external-calendars', { json: target });
  assert.equal(without.status, 400, JSON.stringify(without.body));
  assert.equal(without.body.error, SENTENCE);
  assert.equal(without.body.reason, 'validation');
  assert.deepEqual(without.body.fields, MISSING_ASSIGNEES);
  assert.deepEqual(storedAssignees(cal), [ADMIN, MEM], 'refused: the stored set stays');
  // Before the 404 of a calendar that is neither synced nor offered.
  const unknown = await call('PATCH', '/calendar/external-calendars', { json: { source: 'google', external_id: 'never-synced' } });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.deepEqual(unknown.body.fields, MISSING_ASSIGNEES);

  // The list replaces the set.
  const list = await call('PATCH', '/calendar/external-calendars', { json: { ...target, default_assignee_user_ids: [MEM] } });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(storedAssignees(cal), [MEM]);
  // `[]` clears it on purpose.
  const emptied = await call('PATCH', '/calendar/external-calendars', { json: { ...target, default_assignee_user_ids: [] } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
  assert.deepEqual(emptied.body.data.default_assignee_user_ids, []);
  assert.deepEqual(storedAssignees(cal), []);
  // The earlier single form: one person, or `null` to clear.
  const single = await call('PATCH', '/calendar/external-calendars', { json: { ...target, default_assignee_user_id: ADMIN } });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.deepEqual(storedAssignees(cal), [ADMIN]);
  const cleared = await call('PATCH', '/calendar/external-calendars', { json: { ...target, default_assignee_user_id: null } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.data.default_assignee_user_id, null);
  assert.deepEqual(storedAssignees(cal), []);
});

test('the own caller: the body sync-calendar.js builds sets exactly the people it sends', async () => {
  const cal = assignedCalendar('full-2', [ADMIN, MEM]);
  // buildCalendarAssigneeMenu(): { source, external_id, default_assignee_user_ids } after one tick.
  const res = await call('PATCH', '/calendar/external-calendars', { json: { source: 'google', external_id: 'full-2', default_assignee_user_ids: [ADMIN] } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.default_assignee_user_ids, [ADMIN]);
  assert.deepEqual(storedAssignees(cal), [ADMIN]);
});

/**
 * The top-level keys of every `api.patch('/calendar/external-calendars', {...})`
 * of the page.
 * @param {string} source public/settings/pages/sync-calendar.js
 * @returns {string[][]}
 */
function externalCalendarPatches(source) {
  const found = [];
  for (const match of source.matchAll(/api\.patch\(\s*'\/calendar\/external-calendars'\s*,\s*\{/g)) {
    const open = /** @type {number} */ (match.index) + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if ('({['.includes(source[i])) depth++;
      else if (')}]'.includes(source[i]) && --depth === 0) { end = i; break; }
    }
    const text = source.slice(open, end + 1).replace(/^\s*\/\/.*$/gm, '');
    const keys = [];
    depth = 0;
    for (let j = 0; j < text.length; j++) {
      const c = text[j];
      if ('({['.includes(c)) depth++;
      else if (')}]'.includes(c)) depth--;
      if (depth === 1 && (c === '{' || c === ',')) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*[:,}]/.exec(text.slice(j + 1));
        if (m) keys.push(m[1]);
      }
    }
    found.push(keys);
  }
  return found;
}

test('the own caller: the PATCH of sync-calendar.js sends a field of every anyOf branch it needs', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schema = spec.components.schemas.ExternalCalendarAssigneesInput;
  assert.deepEqual(schema.anyOf.map((/** @type {any} */ b) => b.required), [['default_assignee_user_ids'], ['default_assignee_user_id']]);
  const calls = externalCalendarPatches(readFileSync(new URL('../public/settings/pages/sync-calendar.js', import.meta.url), 'utf8'));
  assert.equal(calls.length, 1, `the PATCHes found ${JSON.stringify(calls)}`);
  for (const keys of calls) {
    for (const key of schema.required) assert.ok(keys.includes(key), `sends ${key}: ${JSON.stringify(keys)}`);
    assert.ok(schema.anyOf.some((/** @type {any} */ branch) => branch.required.every((/** @type {string} */ k) => keys.includes(k))),
      `sends one anyOf branch: ${JSON.stringify(keys)}`);
  }
});

test('the document: 38 provider operations, each with its answers', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const ops = Object.entries(/** @type {Record<string, any>} */ (spec.paths))
    .filter(([path]) => /^\/api\/v1\/calendar\/(google|apple|caldav|outlook|external-calendars)(\/|$)/.test(path))
    .flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op: /** @type {any} */ (op) })));
  assert.equal(ops.length, 38);
  for (const { path, method, op } of ops) {
    const input = (op.parameters ?? []).some((/** @type {any} */ p) => p.in === 'path' || p.in === 'query') || op.requestBody;
    if (input) assert.ok(op.responses[400], `${method} ${path} documents the 400 of the check`);
    if (op.requestBody) assert.ok(op.requestBody.content['application/json'].schema.$ref, `${method} ${path} has a body schema`);
    if ((op.parameters ?? []).some((/** @type {any} */ p) => p.in === 'path' && p.name === 'id') && /caldav|outlook/.test(path)) {
      assert.ok(op.responses[404], `${method} ${path} documents the 404 of an unknown account`);
    }
  }
  assert.ok(spec.paths['/api/v1/calendar/apple/disconnect'].delete.responses[204], 'apple disconnect 204');
  assert.match(spec.paths['/api/v1/calendar/external-calendars'].patch.description, /One of the two is required/);
  assert.doesNotMatch(spec.paths['/api/v1/calendar/external-calendars'].patch.description, /Omitting both clears the set/);
  assert.equal(spec.paths['/api/v1/calendar/external-calendars'].patch.requestBody.required, true);
  // Step (c) of decision 17: one of the two assignee fields, the rest as before.
  assert.deepEqual(spec.components.schemas.ExternalCalendarAssigneesInput.required, ['source', 'external_id']);
  assert.deepEqual(spec.components.schemas.ExternalCalendarAssigneesInput.anyOf, [
    { properties: { default_assignee_user_ids: { type: 'array' } }, required: ['default_assignee_user_ids'] },
    { properties: { default_assignee_user_id: { type: ['integer', 'null'] } }, required: ['default_assignee_user_id'] },
  ]);
});

// Since group 10b step (b) the schema is the only guard for these: the
// provider handlers dropped their own check (#2810). So the types, lists,
// bounds and patterns are pinned here as literal values - a looser type, a
// lost `required`, a value added to a list (also to the constant in
// server/services/calendar-fields.js the list is read from), a lost minimum or
// a wider pattern turns this red.
test('only guard: the types, lists and bounds the provider handlers no longer check are the document\'s, as values', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schemas = spec.components.schemas;
  const BOOL = { type: 'boolean' };
  // PATCH /google/calendars: `enabled must be a boolean.`
  assert.deepEqual(schemas.GoogleCalendarSelectionInput.required, ['calendarId', 'enabled']);
  assert.deepEqual(schemas.GoogleCalendarSelectionInput.properties.enabled, BOOL);
  // PUT /google/readonly: `readonly must be a boolean.`
  assert.deepEqual(schemas.GoogleReadonlyInput.required, ['readonly']);
  assert.equal(schemas.GoogleReadonlyInput.properties.readonly.type, 'boolean');
  // POST .../default-assignee-backfill: `expected_count is missing or invalid.`, `expected_token is invalid.`
  const backfill = schemas.DefaultAssigneeBackfillInput;
  assert.deepEqual(backfill.required, ['expected_count']);
  assert.deepEqual(backfill.properties.expected_count, { type: 'integer', minimum: 0 });
  assert.deepEqual(backfill.properties.expected_token.type, ['string', 'null']);
  assert.equal(backfill.properties.expected_token.pattern, '^[0-9a-f]{64}$');
  // PATCH /caldav/accounts/{id}/calendars: the `enabled` half of `Missing calendarUrl or enabled field.` and `deleteEvents must be a boolean.`
  const caldav = schemas.CaldavCalendarSelectionInput;
  assert.deepEqual(caldav.required, ['calendarUrl', 'enabled']);
  assert.deepEqual(caldav.properties.enabled, BOOL);
  assert.equal(caldav.properties.deleteEvents.type, 'boolean');
  // PATCH /outlook/accounts/{id}/calendars: the type half of `calendarId is missing or invalid.` and `enabled must be a boolean.`
  const outlook = schemas.OutlookCalendarSelectionInput;
  assert.deepEqual(outlook.required, ['calendarId', 'enabled']);
  assert.deepEqual(outlook.properties.enabled, BOOL);
  assert.equal(outlook.properties.calendarId.type, 'string');
  // The value lists: the constants, and the constants as they stand.
  assert.deepEqual(schemas.CaldavReminderListUpdateInput.properties.targetModule, { type: 'string', enum: ['tasks', 'shopping'] });
  assert.deepEqual([...fields.REMINDER_LIST_TARGETS], ['tasks', 'shopping']);
  assert.deepEqual(schemas.ExternalCalendarAssigneesInput.properties.source, { type: 'string', enum: ['google', 'apple', 'caldav'] });
  assert.deepEqual([...fields.EXTERNAL_CALENDAR_SOURCES], ['google', 'apple', 'caldav']);
  // The query switches the handlers read as `=== 'true'`.
  const SWITCH = { type: 'string', enum: ['true', 'false'] };
  for (const [path, method, name] of [
    ['/api/v1/calendar/google/disconnect', 'delete', 'deleteEvents'],
    ['/api/v1/calendar/apple/disconnect', 'delete', 'deleteEvents'],
    ['/api/v1/calendar/caldav/accounts/{id}', 'delete', 'deleteEvents'],
    ['/api/v1/calendar/caldav/accounts/{id}/calendars', 'get', 'refresh'],
    ['/api/v1/calendar/caldav/accounts/{id}/reminder-lists', 'get', 'refresh'],
    ['/api/v1/calendar/outlook/accounts/{id}/calendars', 'get', 'refresh'],
  ]) {
    const param = spec.paths[path][method].parameters.find((/** @type {any} */ p) => p.name === name && p.in === 'query');
    assert.deepEqual(param.schema, SWITCH, `${method} ${path} ${name}`);
  }
  // The path ids pathId() reads with Number() (it was parseInt): whole numbers only.
  const ID = { type: 'integer', maximum: 9007199254740991 };
  for (const [path, method] of [
    ['/api/v1/calendar/caldav/accounts/{id}', 'put'], ['/api/v1/calendar/caldav/accounts/{id}', 'delete'],
    ['/api/v1/calendar/caldav/accounts/{id}/calendars', 'get'], ['/api/v1/calendar/caldav/accounts/{id}/calendars', 'patch'],
    ['/api/v1/calendar/caldav/accounts/{id}/reminder-lists', 'get'], ['/api/v1/calendar/caldav/accounts/{id}/reminder-lists', 'patch'],
    ['/api/v1/calendar/outlook/accounts/{id}', 'put'], ['/api/v1/calendar/outlook/accounts/{id}', 'delete'],
    ['/api/v1/calendar/outlook/accounts/{id}/calendars', 'get'], ['/api/v1/calendar/outlook/accounts/{id}/calendars', 'patch'],
  ]) {
    const param = spec.paths[path][method].parameters.find((/** @type {any} */ p) => p.name === 'id' && p.in === 'path');
    assert.deepEqual(param.schema, ID, `${method} ${path} id`);
  }
});
