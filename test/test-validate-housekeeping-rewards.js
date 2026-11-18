/**
 * Test: request validation in the housekeeping and rewards modules (#2810, phase 2 section E, group 3)
 * Purpose: server/routes/housekeeping.js (24 routes) and server/routes/rewards.js
 *          (19 routes) check every request against the schema of its operation
 *          in the OpenAPI document (`validateRequest()` in every route) before
 *          the handler runs. Held here against the real routers at their real
 *          prefixes, in the order of server/index.js (express.json,
 *          defaultEmptyBody, the routers, the central error handler):
 *            - REFUSED: each input of the decided list is a 400 with
 *              `reason: 'validation'` and `fields`; `?month=2026-13` is a 400
 *              where it was a 500;
 *            - ORDER: a malformed request is a 400 before the 404, 403 and 409
 *              of the handler (rows that need a lookup), a valid one meets the
 *              same answer as before;
 *            - RIGHTS ORDER: rights without a row stand in front of the check
 *              (requireAdmin on eleven rewards routes and on
 *              POST /housekeeping/worker, the shopping write right of a supply
 *              request): 403 stays 403 with the same body, also for a broken
 *              body;
 *            - DESTRUCTIVE TOLERANCES CLOSED: `enabled` missing or as text at
 *              PUT /rewards/participants/{userId} and `is_active: "true"` at
 *              PATCH /rewards/catalog/{id} are a 400 and leave the data standing
 *              (they switched the participation and the reward off);
 *            - THE OWN CALLERS: every request the app (public/pages/housekeeping.js,
 *              public/pages/rewards.js, also on a paired display) sends passes,
 *              the legacy digit text of ids included;
 *            - ONE SOURCE: the enums and limits are the constants of
 *              server/services/housekeeping-fields.js and
 *              server/services/reward-fields.js, the day and time patterns those
 *              of server/utils/datetime-pattern.js, and every month the month
 *              pattern accepts is one householdMonthWindow() can compute.
 *          The household zone is pinned; no answer asserted here carries a date.
 * Run: npm run test:validate-housekeeping-rewards
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { default: rewardsRouter } = await import('../server/routes/rewards.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { applyChildStartPermissions, resolveRequestModuleAccess } = await import('../server/authorize/index.ts');
const { postLedger } = await import('../server/services/rewards.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const hk = await import('../server/services/housekeeping-fields.js');
const rw = await import('../server/services/reward-fields.js');
const money = await import('../server/services/reward-money.js');
const { MAX_AVATAR_DATA_LENGTH } = await import('../server/utils/avatar-limits.js');
const { DATE_PATTERN, OPTIONAL_DATE_PATTERN, OPTIONAL_DATETIME_PATTERN } = await import('../server/utils/datetime-pattern.js');
const { householdMonthWindow } = await import('../server/services/housekeeping-month.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const ADMIN_REQUIRED = { error: 'Admin access required.', code: 403, reason: 'admin_required' };

/** @param {string} username @param {string} role @param {string} familyRole */
function user(username, role, familyRole) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('admin3', 'admin', 'parent');
const MEMBER = user('member3', 'member', 'parent');
// A child starts without `housekeeping_view_amounts`.
const CHILD = user('child3', 'member', 'child');
applyChildStartPermissions(db, { id: CHILD, role: 'member', family_role: 'child' });
const DISPLAY = user('wall3', 'member', 'other');
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

/** @type {Record<string, { id: number, role: string, method?: string, scopes?: string[] }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  member: { id: MEMBER, role: 'member' },
  child: { id: CHILD, role: 'member' },
  display: { id: DISPLAY, role: 'member', method: 'display' },
  // An API token of the admin that may write housekeeping, not shopping.
  token: { id: ADMIN, role: 'admin', method: 'api_token', scopes: ['housekeeping:write', 'housekeeping:read'] },
};

const quiet = { warn: () => {}, error: () => {} };
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const actor = ACTORS[req.get('x-actor') ?? 'admin'];
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = actor.method ?? 'session';
  req.authScopes = actor.scopes ?? null;
  req.session = { userId: actor.id, role: actor.role };
  req.sessionModuleAccess = resolveRequestModuleAccess(db, req);
  next();
});
// The mounts of server/index.js.
app.use('/api/v1/housekeeping', housekeepingRouter);
app.use('/api/v1/rewards', rewardsRouter);
app.use(createErrorHandler(quiet));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {{ json?: unknown, actor?: string }} [options] json left out: no body
 */
async function call(method, route, { json, actor } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor) headers['x-actor'] = actor;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, body };
}

/**
 * The 400 of the middleware: exactly these fields.
 * @param {{ status: number, body: any }} res
 * @param {Array<{ path: string, rule: string }>} fields
 * @param {string} [label]
 */
function assertRefused(res, fields, label = '') {
  assert.equal(res.status, 400, `${label} ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { error: SENTENCE, code: 400, reason: 'validation', fields }, label);
}

/**
 * The 400 of the middleware with this field among its fields (an `anyOf`
 * names the failing branches too).
 * @param {{ status: number, body: any }} res
 * @param {string} path
 * @param {string} rule
 * @param {string} [label]
 */
function assertRefusedAt(res, path, rule, label = '') {
  assert.equal(res.status, 400, `${label} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.reason, 'validation', label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path && f.rule === rule), `${label}: ${JSON.stringify(res.body.fields)}`);
}

/**
 * A 400 of the handler, not of the schema: no `fields`.
 * @param {{ status: number, body: any }} res
 * @param {string | undefined} [reason]
 * @param {string} [label]
 */
function assertHandlerRefused(res, reason, label = '') {
  assert.equal(res.status, 400, `${label} ${JSON.stringify(res.body)}`);
  assert.notEqual(res.body?.error, SENTENCE, `${label} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.fields, undefined, label);
  assert.equal(res.body?.reason, reason, label);
}

/** @param {{ status: number, body: any }} res @param {number} status @param {string} [label] */
function assertPassed(res, status, label = '') {
  assert.equal(res.status, status, `${label} ${JSON.stringify(res.body)}`);
}

const NOT_DIGITS = ['12abc', '5.0', '1e2', '0x10', '%201'];

// ════════════════════════════════════════════════════════════════════════════
// HOUSEKEEPING
// ════════════════════════════════════════════════════════════════════════════

// Asked before any housekeeper exists, held in the first test below. All
// seeding happens before the first test: the suite's server closes once the
// tests ran.
const BEFORE_ANY_WORKER = {
  malformed: await call('POST', '/housekeeping/work-sessions/check-in', { json: { worker_id: 'x' } }),
  empty: await call('POST', '/housekeeping/work-sessions/check-in', { json: {} }),
  valid: await call('POST', '/housekeeping/work-sessions/check-in', { json: { worker_id: 1, daily_rate: 50 } }),
};

/**
 * The worker form of public/pages/housekeeping.js (saveWorker).
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
const workerForm = (over = {}) => ({
  id: null,
  display_name: 'Rosa',
  username: null,
  phone: null,
  email: null,
  birth_date: null,
  birth_year_unknown: false,
  daily_rate: 60,
  rate_type: 'daily',
  hourly_rate: 0,
  payment_schedule: 'monthly',
  calendar_color: '#0891B2',
  avatar_color: '#0891B2',
  notes: null,
  ...over,
});

const WORKER = (await call('POST', '/housekeeping/worker', { json: workerForm() })).body.data;
assert.ok(WORKER?.id, 'seed housekeeper');

for (const id of [MEMBER, CHILD]) {
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(id);
  // The defaults of postLedger() read as the only types of its options (JSDoc): any.
  postLedger(db, /** @type {any} */ ({ userId: id, delta: 500, type: 'bonus', reason: 'seed', createdBy: ADMIN }));
}
const REWARD = (await call('POST', '/rewards/catalog', { json: { name: 'Kino', cost: 10, quantity: null, icon: '🎬', description: null } })).body.data;
assert.ok(REWARD?.id, 'seed reward');

test('housekeeping: before any housekeeper, a malformed check-in is the schema\'s 400, a valid one the handler\'s', () => {
  assertRefusedAt(BEFORE_ANY_WORKER.malformed, 'body/worker_id', 'anyOf');
  assertRefused(BEFORE_ANY_WORKER.empty, [{ path: 'body/worker_id', rule: 'required' }]);
  assertHandlerRefused(BEFORE_ANY_WORKER.valid, undefined, 'Add a housekeeper first');
});

test('POST /housekeeping/worker: the admin gate comes first, a member gets the same 403 for any body', async () => {
  for (const json of [workerForm(), { display_name: 5, daily_rate: 'x' }, [], undefined]) {
    const res = await call('POST', '/housekeeping/worker', { json, actor: 'member' });
    assert.deepEqual({ status: res.status, body: res.body }, { status: 403, body: ADMIN_REQUIRED }, JSON.stringify(json));
  }
});

test('POST /housekeeping/worker: the app\'s form passes, the id as a number, as legacy digit text and as null', async () => {
  assertPassed(await call('POST', '/housekeeping/worker', { json: workerForm({ display_name: 'Neu', username: 'neu.hilfe', avatar_data: undefined }) }), 201);
  assertPassed(await call('POST', '/housekeeping/worker', { json: workerForm({ id: WORKER.id, notes: 'Dienstag' }) }), 200);
  assertPassed(await call('POST', '/housekeeping/worker', { json: workerForm({ id: String(WORKER.id), payment_schedule: '', rate_type: null }) }), 200);
  assertPassed(await call('POST', '/housekeeping/worker', { json: workerForm({ id: WORKER.id, birth_date: '2000-02-29', birth_year_unknown: true, rate_type: 'hourly', hourly_rate: 12.5 }) }), 200);
  assertPassed(await call('POST', '/housekeeping/worker', { json: workerForm({ id: WORKER.id, birth_date: '', avatar_data: null, calendar_color: '', avatar_color: null }) }), 200);
});

test('POST /housekeeping/worker: each field refuses what is not its type, list or length', async () => {
  /** @type {Array<[string, unknown, string, string?]>} */
  const cases = [
    ['display_name', 5, 'type'], ['display_name', null, 'type'], ['display_name', ['Rosa'], 'type'], ['display_name', ` ${'x'.repeat(128)}`, 'maxLength'],
    ['username', 5, 'type'], ['username', 'x'.repeat(65), 'maxLength'],
    ['phone', 5, 'type'], ['phone', 'x'.repeat(101), 'maxLength'],
    ['email', true, 'type'], ['email', 'x'.repeat(201), 'maxLength'],
    ['notes', { a: 1 }, 'type'], ['notes', 'x'.repeat(5001), 'maxLength'],
    ['birth_date', '2026-1-1', 'pattern'], ['birth_date', 20260101, 'type'], ['birth_date', ['2026-01-01'], 'type'],
    ['birth_year_unknown', 1, 'type'], ['birth_year_unknown', 'true', 'type'], ['birth_year_unknown', null, 'type'],
    ['daily_rate', '60', 'type'], ['daily_rate', true, 'type'], ['daily_rate', null, 'type'], ['daily_rate', [60], 'type'],
    ['hourly_rate', '12', 'type'], ['hourly_rate', false, 'type'],
    ['rate_type', 'weekly', 'enum'], ['rate_type', 1, 'type'],
    ['payment_schedule', 'weekly', 'enum'], ['payment_schedule', false, 'type'],
    ['calendar_color', 5, 'type'], ['avatar_color', ['#000000'], 'type'],
    ['avatar_data', 5, 'type'], ['avatar_data', `data:image/png;base64,${'A'.repeat(768 * 1024)}`, 'maxLength'],
  ];
  for (const [field, value, rule] of cases) {
    assertRefused(await call('POST', '/housekeeping/worker', { json: workerForm({ [field]: value }) }), [{ path: `body/${field}`, rule }], `${field}=${JSON.stringify(value).slice(0, 40)}`);
  }
  for (const id of ['abc', '7abc', 1.5, true, {}, '']) {
    assertRefusedAt(await call('POST', '/housekeeping/worker', { json: workerForm({ id }) }), 'body/id', 'anyOf', `id=${JSON.stringify(id)}`);
  }
  for (const field of ['display_name', 'daily_rate']) {
    const json = workerForm();
    delete json[field];
    assertRefused(await call('POST', '/housekeeping/worker', { json }), [{ path: `body/${field}`, rule: 'required' }], `without ${field}`);
  }
  assertRefused(await call('POST', '/housekeeping/worker'), [{ path: 'body', rule: 'required' }]);
  assertRefused(await call('POST', '/housekeeping/worker', { json: [] }), [{ path: 'body', rule: 'type' }]);
});

test('POST /housekeeping/worker: what the schema cannot say stays the handler\'s, the UI\'s reason included', async () => {
  // The naming rule reads the trimmed name: its reason still reaches the app.
  assertHandlerRefused(await call('POST', '/housekeeping/worker', { json: workerForm({ username: 'a b!' }) }), 'housekeeping_username_invalid');
  assertPassed(await call('POST', '/housekeeping/worker', { json: workerForm({ display_name: 'Trim', username: ' trim.me ' }) }), 201);
  assertHandlerRefused(await call('POST', '/housekeeping/worker', { json: workerForm({ birth_date: '2026-02-30' }) }));
  assertHandlerRefused(await call('POST', '/housekeeping/worker', { json: workerForm({ daily_rate: -5 }) }));
  assertHandlerRefused(await call('POST', '/housekeeping/worker', { json: workerForm({ calendar_color: 'red' }) }));
  assertHandlerRefused(await call('POST', '/housekeeping/worker', { json: workerForm({ display_name: '   ' }) }));
  assertHandlerRefused(await call('POST', '/housekeeping/worker', { json: workerForm({ id: 0 }) }));
  // 400 before 404: an unknown id with a broken body is the schema's.
  assertRefused(await call('POST', '/housekeeping/worker', { json: workerForm({ id: 999999, daily_rate: 'x' }) }), [{ path: 'body/daily_rate', rule: 'type' }]);
  const gone = await call('POST', '/housekeeping/worker', { json: workerForm({ id: 999999 }) });
  assert.deepEqual([gone.status, gone.body.reason], [404, 'housekeeping_worker_not_found']);
});

test('housekeeping queries: month is 01 to 12 in the years 1001 to 9999, a 400 where 2026-13 was a 500', async () => {
  for (const route of ['/housekeeping/summary', '/housekeeping/work-sessions', '/housekeeping/visits']) {
    for (const month of ['2026-13', '2026-00', '0000-01', '0999-12', '1000-01', '2026-1', '2026-011', 'abc', '2026-11-01']) {
      assertRefused(await call('GET', `${route}?month=${month}`), [{ path: 'query/month', rule: 'pattern' }], `${route} ${month}`);
    }
    assertRefused(await call('GET', `${route}?month=2026-10&month=2026-11`), [{ path: 'query/month', rule: 'type' }], `${route} twice`);
    for (const month of ['2026-11', '1001-01', '9999-12', '']) {
      assertPassed(await call('GET', `${route}?month=${month}`), 200, `${route} ${month}`);
    }
    assertPassed(await call('GET', route), 200, `${route} without month`);
  }
});

test('housekeeping queries: worker_id plain decimal, the day context typed; the app\'s queries pass', async () => {
  for (const workerId of ['abc', '1abc', '1.5', '1e2', '']) {
    assertRefused(await call('GET', `/housekeeping/visits?month=2026-11&worker_id=${workerId}`), [{ path: 'query/worker_id', rule: 'type' }], `worker_id=${workerId}`);
  }
  assertRefused(await call('GET', '/housekeeping/visits?worker_id=1&worker_id=2'), [{ path: 'query/worker_id', rule: 'type' }]);
  assertHandlerRefused(await call('GET', '/housekeeping/visits?worker_id=0'));
  assertPassed(await call('GET', `/housekeeping/visits?month=2026-11&worker_id=${WORKER.id}`), 200);
  for (const route of ['/housekeeping/dashboard', '/housekeeping/worker', '/housekeeping/workers']) {
    assertRefused(await call('GET', `${route}?local_date=2026-1-1`), [{ path: 'query/local_date', rule: 'pattern' }], route);
    assertRefused(await call('GET', `${route}?timezone_offset_minutes=1.5`), [{ path: 'query/timezone_offset_minutes', rule: 'type' }], route);
    assertRefused(await call('GET', `${route}?timezone=UTC&timezone=Europe/Berlin`), [{ path: 'query/timezone', rule: 'type' }], route);
    // The app's day parameters (localDayParams), the zone may be empty; an older client's day and offset.
    assertPassed(await call('GET', `${route}?timezone=Europe%2FBerlin`), 200, route);
    assertPassed(await call('GET', `${route}?timezone=`), 200, route);
    assertPassed(await call('GET', `${route}?local_date=2026-11-18&timezone_offset_minutes=-60`), 200, route);
  }
});

test('check-in and check-out: typed bodies, the 400 before the 404 and 409; the app\'s requests pass', async () => {
  const route = '/housekeeping/work-sessions/check-in';
  /** @type {Array<[string, unknown, string]>} */
  const cases = [
    ['daily_rate', '60', 'type'], ['daily_rate', null, 'type'], ['extras', true, 'type'], ['extras', '0', 'type'],
    ['event_title', 5, 'type'], ['payment_title', 'x'.repeat(201), 'maxLength'], ['payment_description', ['x'], 'type'],
    ['timezone', 5, 'type'], ['local_date', '18.11.2026', 'pattern'], ['timezone_offset_minutes', '60', 'type'],
  ];
  for (const [field, value, rule] of cases) {
    assertRefused(await call('POST', route, { json: { worker_id: WORKER.id, daily_rate: 60, [field]: value } }), [{ path: `body/${field}`, rule }], field);
  }
  // 400 before the 404 of an unknown housekeeper.
  assertRefused(await call('POST', route, { json: { worker_id: 999999, daily_rate: '60' } }), [{ path: 'body/daily_rate', rule: 'type' }]);
  assert.equal((await call('POST', route, { json: { worker_id: 999999, daily_rate: 60 } })).body.reason, 'housekeeping_worker_not_found');
  // The app's check-in (toggleSession), the zone may be empty.
  const checkIn = { worker_id: WORKER.id, daily_rate: 60, extras: 0, timezone: '', event_title: 'Rosa', payment_title: 'Lohn Rosa', payment_description: 'Besuch' };
  assertPassed(await call('POST', route, { json: checkIn }), 201);
  // 400 before the 409 of an open session; a valid body still meets the 409.
  assertRefused(await call('POST', route, { json: { ...checkIn, extras: '5' } }), [{ path: 'body/extras', rule: 'type' }]);
  assert.equal((await call('POST', route, { json: checkIn })).body.reason, 'housekeeping_already_checked_in');

  const out = '/housekeeping/work-sessions/check-out';
  assertRefused(await call('POST', out, { json: {} }), [{ path: 'body/worker_id', rule: 'required' }]);
  assertRefused(await call('POST', out, { json: { worker_id: WORKER.id, extras: '5' } }), [{ path: 'body/extras', rule: 'type' }]);
  // The app checks out with the number id; the legacy digit text passes too (then 404: closed already).
  const closed = await call('POST', out, { json: { worker_id: WORKER.id } });
  assertPassed(closed, 200);
  assert.equal((await call('POST', out, { json: { worker_id: String(WORKER.id) } })).body.reason, 'housekeeping_open_session_not_found');
  // 400 before the 404 of no open session.
  assertRefused(await call('POST', out, { json: { worker_id: WORKER.id, extras: [1] } }), [{ path: 'body/extras', rule: 'type' }]);
  // The undo: the app sends {}; a body is ignored, the path id plain decimal.
  assertPassed(await call('POST', `/housekeeping/work-sessions/${closed.body.data.id}/reopen`, { json: { anything: 1 } }), 200);
  assertPassed(await call('POST', '/housekeeping/work-sessions/check-out', { json: { worker_id: WORKER.id, extras: null } }), 200);
});

test('check-in without the amounts right: the types of the amount fields are checked all the same', async () => {
  const route = '/housekeeping/work-sessions/check-in';
  // Until #2810 the handler swapped these fields for the profile's before it checked them.
  assertRefused(await call('POST', route, { json: { worker_id: WORKER.id, daily_rate: '60' }, actor: 'child' }), [{ path: 'body/daily_rate', rule: 'type' }]);
  // The app's check-in of an account without amounts: `worker.daily_rate` is null there, so it sends 0.
  assertPassed(await call('POST', route, { json: { worker_id: WORKER.id, daily_rate: 0, extras: 0, timezone: 'Europe/Berlin' }, actor: 'child' }), 201);
  assertPassed(await call('POST', '/housekeeping/work-sessions/check-out', { json: { worker_id: WORKER.id }, actor: 'child' }), 200);
});

/** A visit of the housekeeper, written directly. @param {{ paid?: boolean, hourly?: boolean }} [options] */
function visit({ paid = false, hourly = false } = {}) {
  return Number(db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, paid_at, created_by, rate_type, hourly_rate)
    VALUES (?, '2026-11-02T08:00:00.000Z', '2026-11-02T12:00:00.000Z', 60, 0, ?, ?, ?, ?)
  `).run(WORKER.id, paid ? '2026-11-03T08:00:00.000Z' : null, ADMIN, hourly ? 'hourly' : 'daily', hourly ? 15 : 0).lastInsertRowid);
}

test('PUT /housekeeping/visits/{id}: a full replace with a required day; the app\'s body passes', async () => {
  const id = visit();
  const route = `/housekeeping/visits/${id}`;
  // The app's edit form (openVisitEditModal) for a daily rate.
  const form = { date: '2026-11-02', original_date: '2026-11-02', daily_rate: 60, extras: 5, receipt_document_id: null, event_title: 'Rosa', payment_title: 'Lohn', payment_description: 'Besuch' };
  assertPassed(await call('PUT', route, { json: form }), 200);
  /** @type {Array<[string, unknown, string]>} */
  const cases = [
    ['date', '2026-11-2', 'pattern'], ['date', null, 'type'], ['date', ['2026-11-02'], 'type'],
    ['original_date', '2.11.2026', 'pattern'], ['daily_rate', '60', 'type'], ['extras', true, 'type'],
    ['minutes_worked', '30', 'type'], ['minutes_worked', 1.5, 'type'],
    ['event_title', 5, 'type'], ['payment_description', 'x'.repeat(5001), 'maxLength'],
  ];
  for (const [field, value, rule] of cases) {
    assertRefused(await call('PUT', route, { json: { ...form, [field]: value } }), [{ path: `body/${field}`, rule }], field);
  }
  for (const receipt of ['abc', '1.5', true, []]) {
    assertRefusedAt(await call('PUT', route, { json: { ...form, receipt_document_id: receipt } }), 'body/receipt_document_id', 'anyOf', JSON.stringify(receipt));
  }
  const { date: _date, ...withoutDate } = form;
  assertRefused(await call('PUT', route, { json: withoutDate }), [{ path: 'body/date', rule: 'required' }]);
  // "no value" forms of the handler: null and "" clear the receipt, null keeps the minutes, "" the form's day.
  assertPassed(await call('PUT', route, { json: { ...form, receipt_document_id: '', original_date: '' } }), 200);
  assertPassed(await call('PUT', route, { json: { ...form, minutes_worked: null } }), 200);
  // A daily rate needs its rate: `null` passes the schema (an hourly visit sends it) and stays the handler's 400.
  assertHandlerRefused(await call('PUT', route, { json: { ...form, daily_rate: null } }));
  // The calendar check stays the handler's.
  assertHandlerRefused(await call('PUT', route, { json: { ...form, date: '2026-02-30' } }));
  // The app's form for an hourly visit: minutes instead of a rate.
  const hourly = visit({ hourly: true });
  const { daily_rate: _rate, ...hourlyForm } = form;
  assertPassed(await call('PUT', `/housekeeping/visits/${hourly}`, { json: { ...hourlyForm, minutes_worked: 120 } }), 200);
});

test('visits: the 400 comes before the 404 and before the admin 403 of a paid visit; a valid request meets them as before', async () => {
  const paid = visit({ paid: true });
  const form = { date: '2026-11-02', daily_rate: 60, extras: 0 };
  // Unknown visit: was 404 for any body.
  assertRefused(await call('PUT', '/housekeeping/visits/999999', { json: { daily_rate: 60 } }), [{ path: 'body/date', rule: 'required' }]);
  assert.equal((await call('PUT', '/housekeeping/visits/999999', { json: form })).body.reason, 'housekeeping_visit_not_found');
  // A paid visit and a member: was 403 for any body.
  assertRefused(await call('PUT', `/housekeeping/visits/${paid}`, { json: { daily_rate: 'x', date: '2026-11-02' }, actor: 'member' }), [{ path: 'body/daily_rate', rule: 'type' }]);
  const refused = await call('PUT', `/housekeeping/visits/${paid}`, { json: form, actor: 'member' });
  assert.deepEqual({ status: refused.status, body: refused.body }, { status: 403, body: ADMIN_REQUIRED });
  assert.ok(db.prepare('SELECT paid_at FROM housekeeping_work_sessions WHERE id = ?').get(paid).paid_at, 'the paid visit stands');
  // Body-less routes ignore a body as before (the app sends {}).
  for (const [method, path] of [['POST', `/housekeeping/visits/${paid}/pay`], ['POST', `/housekeeping/visits/${paid}/unpay`], ['DELETE', `/housekeeping/visits/${paid}`]]) {
    const res = await call(method, path, { json: { junk: [1] }, actor: 'member' });
    assert.deepEqual({ status: res.status, body: res.body }, { status: 403, body: ADMIN_REQUIRED }, `${method} ${path}`);
  }
  assertPassed(await call('POST', `/housekeeping/visits/${paid}/unpay`, { json: {} }), 200);
  assertPassed(await call('POST', `/housekeeping/visits/${paid}/pay`, { json: {} }), 200);
});

test('housekeeping path ids: anything but plain decimal digits is a 400 naming the parameter', async () => {
  const id = visit();
  /** @type {Array<[string, (bad: string) => string, string, unknown]>} */
  const routes = [
    ['GET', (b) => `/housekeeping/visits/${b}`, 'path/id', undefined],
    ['PUT', (b) => `/housekeeping/visits/${b}`, 'path/id', { date: '2026-11-02', daily_rate: 60 }],
    ['DELETE', (b) => `/housekeeping/visits/${b}`, 'path/id', undefined],
    ['POST', (b) => `/housekeeping/visits/${b}/pay`, 'path/id', {}],
    ['POST', (b) => `/housekeeping/visits/${b}/unpay`, 'path/id', {}],
    ['POST', (b) => `/housekeeping/work-sessions/${b}/reopen`, 'path/id', {}],
    ['PATCH', (b) => `/housekeeping/decay-tasks/${b}`, 'path/taskId', {}],
    ['DELETE', (b) => `/housekeeping/decay-tasks/${b}`, 'path/taskId', undefined],
    ['POST', (b) => `/housekeeping/decay-tasks/${b}/complete`, 'path/taskId', {}],
  ];
  for (const [method, route, path, json] of routes) {
    for (const bad of NOT_DIGITS) {
      assertRefused(await call(method, route(bad), { json }), [{ path, rule: 'type' }], `${method} ${route(bad)}`);
    }
  }
  // `DELETE /visits/<id>abc` deleted the visit before (parseInt); it is still there.
  assertPassed(await call('GET', `/housekeeping/visits/${id}`), 200);
  // 0 and below stay the handler's 400.
  assertHandlerRefused(await call('GET', '/housekeeping/visits/0'));
  assertHandlerRefused(await call('DELETE', '/housekeeping/decay-tasks/-1'));
});

test('decay tasks: typed bodies, the frequency a whole number of at least 1; the app\'s requests pass', async () => {
  const created = await call('POST', '/housekeeping/decay-tasks', { json: { name: 'Fenster', area: 'Wohnzimmer', frequency_days: 14 } });
  assertPassed(created, 201);
  const task = created.body.data;
  /** @type {Array<[string, unknown, string]>} */
  const cases = [
    ['name', 5, 'type'], ['name', 'x'.repeat(201), 'maxLength'], ['area', null, 'type'], ['area', 'x'.repeat(101), 'maxLength'],
    ['frequency_days', '7', 'type'], ['frequency_days', 1.5, 'type'], ['frequency_days', true, 'type'], ['frequency_days', 0, 'minimum'],
    ['last_completed', '18.11.2026', 'pattern'], ['last_completed', 5, 'type'], ['last_completed', '2026-11-18 10:00', 'pattern'],
  ];
  /** @type {Record<string, unknown>} */
  const valid = { name: 'Fenster', area: 'Wohnzimmer', frequency_days: 7 };
  for (const [field, value, rule] of cases) {
    assertRefused(await call('POST', '/housekeeping/decay-tasks', { json: { ...valid, [field]: value } }), [{ path: `body/${field}`, rule }], `POST ${field}`);
    assertRefused(await call('PATCH', `/housekeeping/decay-tasks/${task.id}`, { json: { [field]: value } }), [{ path: `body/${field}`, rule }], `PATCH ${field}`);
  }
  for (const field of ['name', 'area', 'frequency_days']) {
    const json = { ...valid };
    delete json[field];
    assertRefused(await call('POST', '/housekeeping/decay-tasks', { json }), [{ path: `body/${field}`, rule: 'required' }], field);
  }
  // 400 before the 404 of an unknown task; a valid body still meets it.
  assertRefused(await call('PATCH', '/housekeeping/decay-tasks/999999', { json: { frequency_days: '7' } }), [{ path: 'body/frequency_days', rule: 'type' }]);
  assert.equal((await call('PATCH', '/housekeeping/decay-tasks/999999', { json: {} })).body.reason, 'housekeeping_task_not_found');
  // The app: edit (name, area, frequency), complete with {}, undo with the previous value or null.
  assertPassed(await call('PATCH', `/housekeeping/decay-tasks/${task.id}`, { json: { name: 'Fenster', area: 'Küche', frequency_days: 10 } }), 200);
  assertPassed(await call('POST', `/housekeeping/decay-tasks/${task.id}/complete`, { json: {} }), 200);
  assertPassed(await call('PATCH', `/housekeeping/decay-tasks/${task.id}`, { json: { last_completed: null } }), 200);
  assertPassed(await call('PATCH', `/housekeeping/decay-tasks/${task.id}`, { json: { last_completed: '2026-11-18T09:30:00.000Z' } }), 200);
  assertPassed(await call('PATCH', `/housekeeping/decay-tasks/${task.id}`, { json: { last_completed: '' } }), 200);
  assertPassed(await call('POST', '/housekeeping/decay-tasks', { json: { ...valid, last_completed: '2026-11-18T10:00+01:00' } }), 201);
  assertPassed(await call('PATCH', `/housekeeping/decay-tasks/${task.id}`, { json: {} }), 200);
  // The calendar of a zoned value stays the handler's.
  assertHandlerRefused(await call('PATCH', `/housekeeping/decay-tasks/${task.id}`, { json: { last_completed: '2026-02-30T10:00Z' } }));
});

test('supply requests and the maintenance log: the shopping right comes before the check, the texts are typed', async () => {
  // A token without `shopping:write`: 403 for any body, as before.
  for (const json of [{ name: 'Seife' }, { name: 5 }, {}]) {
    const res = await call('POST', '/housekeeping/supply-requests', { json, actor: 'token' });
    assert.deepEqual([res.status, res.body.reason], [403, 'cross_module_access'], JSON.stringify(json));
  }
  assertRefused(await call('POST', '/housekeeping/supply-requests', { json: { name: 5 } }), [{ path: 'body/name', rule: 'type' }]);
  assertRefused(await call('POST', '/housekeeping/supply-requests', { json: { name: 'Seife', quantity: 2 } }), [{ path: 'body/quantity', rule: 'type' }]);
  assertRefused(await call('POST', '/housekeeping/supply-requests', { json: {} }), [{ path: 'body/name', rule: 'required' }]);
  assertPassed(await call('POST', '/housekeeping/supply-requests', { json: { name: 'Seife', quantity: '2 Stück' } }), 201);

  assertRefused(await call('POST', '/housekeeping/maintenance-log', { json: { description: 5 } }), [{ path: 'body/description', rule: 'type' }]);
  assertRefused(await call('POST', '/housekeeping/maintenance-log', { json: { description: 'Tropft', photo_url: 5 } }), [{ path: 'body/photo_url', rule: 'type' }]);
  assertRefused(await call('POST', '/housekeeping/maintenance-log', { json: {} }), [{ path: 'body/description', rule: 'required' }]);
  assertHandlerRefused(await call('POST', '/housekeeping/maintenance-log', { json: { description: 'Tropft', photo_url: 'data:text/plain;base64,AA==' } }));
  assertPassed(await call('POST', '/housekeeping/maintenance-log', { json: { description: 'Tropft', photo_url: null } }), 201);
});

// ════════════════════════════════════════════════════════════════════════════
// REWARDS
// ════════════════════════════════════════════════════════════════════════════

test('rewards: the admin gate comes first on its eleven routes, a member gets the same 403 for any body', async () => {
  /** @type {Array<[string, string, unknown]>} */
  const routes = [
    ['GET', '/rewards/participants', undefined],
    ['PUT', `/rewards/participants/${CHILD}`, { enabled: 'x' }],
    ['POST', '/rewards/catalog', { cost: 'x' }],
    ['PATCH', `/rewards/catalog/${REWARD.id}`, { is_active: 'true' }],
    ['DELETE', `/rewards/catalog/${REWARD.id}`, undefined],
    ['POST', '/rewards/bonus', { user_id: null }],
    ['POST', '/rewards/money/entries', { direction: 'x' }],
    ['POST', '/rewards/money/accounts', {}],
    ['DELETE', `/rewards/money/accounts/${CHILD}`, undefined],
    ['PUT', `/rewards/money/plans/${CHILD}`, { anchor_day: '3' }],
    ['DELETE', `/rewards/money/plans/${CHILD}`, undefined],
  ];
  for (const [method, path, json] of routes) {
    const res = await call(method, path, { json, actor: 'member' });
    assert.deepEqual({ status: res.status, body: res.body }, { status: 403, body: ADMIN_REQUIRED }, `${method} ${path}`);
  }
  assert.equal(db.prepare('SELECT is_active FROM reward_catalog WHERE id = ?').get(REWARD.id).is_active, 1);
});

test('rewards path ids: anything but plain decimal digits is a 400 naming the parameter', async () => {
  /** @type {Array<[string, (bad: string) => string, string, unknown]>} */
  const routes = [
    ['PUT', (b) => `/rewards/participants/${b}`, 'path/userId', { enabled: true }],
    ['PATCH', (b) => `/rewards/catalog/${b}`, 'path/id', {}],
    ['DELETE', (b) => `/rewards/catalog/${b}`, 'path/id', undefined],
    ['PATCH', (b) => `/rewards/redemptions/${b}`, 'path/id', { action: 'cancel' }],
    ['DELETE', (b) => `/rewards/money/accounts/${b}`, 'path/userId', undefined],
    ['PUT', (b) => `/rewards/money/plans/${b}`, 'path/userId', { amount: '1.00', frequency: 'weekly', anchor_day: 1 }],
    ['DELETE', (b) => `/rewards/money/plans/${b}`, 'path/userId', undefined],
  ];
  for (const [method, route, path, json] of routes) {
    for (const bad of [...NOT_DIGITS, '1.9', '%20' + String(REWARD.id)]) {
      assertRefused(await call(method, route(bad), { json }), [{ path, rule: 'type' }], `${method} ${route(bad)}`);
    }
  }
  // `/catalog/<id>.9` and `/catalog/%20<id>` reached the reward before (toInt); it is still there.
  assertPassed(await call('GET', '/rewards/catalog'), 200);
  assert.ok(db.prepare('SELECT 1 FROM reward_catalog WHERE id = ?').get(REWARD.id));
});

test('PUT /rewards/participants/{userId}: `enabled` is a required boolean; missing or as text it no longer switches off', async () => {
  const enabled = () => db.prepare('SELECT enabled FROM reward_participants WHERE user_id = ?').get(CHILD).enabled;
  const route = `/rewards/participants/${CHILD}`;
  for (const json of [{}, { enabled: 'true' }, { enabled: '1' }, { enabled: 1 }, { enabled: null }, { enabled: [true] }]) {
    const res = await call('PUT', route, { json });
    assertRefused(res, [{ path: 'body/enabled', rule: 'enabled' in json ? 'type' : 'required' }], JSON.stringify(json));
    assert.equal(enabled(), 1, `${JSON.stringify(json)} leaves the participation standing`);
  }
  assertRefused(await call('PUT', route), [{ path: 'body', rule: 'required' }]);
  assert.equal(enabled(), 1, 'no body leaves the participation standing');
  // 400 before the 404 of an unknown user; a valid body still meets it.
  assertRefused(await call('PUT', '/rewards/participants/999999', { json: {} }), [{ path: 'body/enabled', rule: 'required' }]);
  assert.equal((await call('PUT', '/rewards/participants/999999', { json: { enabled: false } })).status, 404);
  // The app's checkbox.
  assertPassed(await call('PUT', route, { json: { enabled: false } }), 200);
  assert.equal(enabled(), 0);
  assertPassed(await call('PUT', route, { json: { enabled: true } }), 200);
  assert.equal(enabled(), 1);
});

test('the catalog: typed bodies within the handler\'s limits', async () => {
  /** @type {Array<[string, unknown, string]>} */
  const cases = [
    ['name', 5, 'type'], ['cost', '50', 'type'], ['cost', 50.5, 'type'], ['cost', true, 'type'], ['cost', 0, 'minimum'], ['cost', 1_000_001, 'maximum'],
    ['quantity', 0, 'minimum'], ['quantity', 1_000_001, 'maximum'], ['quantity', '', 'type'], ['quantity', '3', 'type'],
    ['icon', 5, 'type'], ['description', ['x'], 'type'], ['sort_order', '1', 'type'], ['sort_order', null, 'type'],
  ];
  const valid = { name: 'Eis', cost: 20, quantity: null, icon: null, description: null };
  for (const [field, value, rule] of cases) {
    assertRefused(await call('POST', '/rewards/catalog', { json: { ...valid, [field]: value } }), [{ path: `body/${field}`, rule }], `POST ${field}`);
    if (field !== 'name') assertRefused(await call('PATCH', `/rewards/catalog/${REWARD.id}`, { json: { [field]: value } }), [{ path: `body/${field}`, rule }], `PATCH ${field}`);
  }
  assertRefused(await call('POST', '/rewards/catalog', { json: { cost: 20 } }), [{ path: 'body/name', rule: 'required' }]);
  assertRefused(await call('POST', '/rewards/catalog', { json: { name: 'Eis' } }), [{ path: 'body/cost', rule: 'required' }]);
  // The icon is still cut to 8 characters, not refused; empty after trim stays the handler's.
  assertPassed(await call('POST', '/rewards/catalog', { json: { ...valid, icon: '1234567890' } }), 201);
  assertHandlerRefused(await call('POST', '/rewards/catalog', { json: { ...valid, name: '  ' } }));
});

test('PATCH /rewards/catalog/{id}: `is_active` as text no longer switches a reward off; the app\'s form passes', async () => {
  const active = () => db.prepare('SELECT is_active FROM reward_catalog WHERE id = ?').get(REWARD.id).is_active;
  for (const value of ['true', 'false', 1, 0, null]) {
    assertRefused(await call('PATCH', `/rewards/catalog/${REWARD.id}`, { json: { is_active: value } }), [{ path: 'body/is_active', rule: 'type' }], JSON.stringify(value));
    assert.equal(active(), 1, `is_active ${JSON.stringify(value)} leaves the reward active`);
  }
  // 400 before the 404 of an unknown reward; a valid body still meets it with the UI's reason.
  assertRefused(await call('PATCH', '/rewards/catalog/999999', { json: { cost: 'x' } }), [{ path: 'body/cost', rule: 'type' }]);
  assert.equal((await call('PATCH', '/rewards/catalog/999999', { json: {} })).body.reason, 'rewards_reward_not_found');
  // The app's edit form (saveReward): all fields, `is_active` a boolean.
  assertPassed(await call('PATCH', `/rewards/catalog/${REWARD.id}`, { json: { name: 'Kino', cost: 10, quantity: 5, icon: '🎬', description: 'Samstag', is_active: true } }), 200);
  assertPassed(await call('PATCH', `/rewards/catalog/${REWARD.id}`, { json: { quantity: null, cost: null, name: null } }), 200);
  assert.equal(active(), 1);
  // The bare answer of the delete stays.
  const extra = (await call('POST', '/rewards/catalog', { json: { name: 'Eis', cost: 20 } })).body.data;
  const del = await call('DELETE', `/rewards/catalog/${extra.id}`);
  assert.deepEqual({ status: del.status, body: del.body }, { status: 200, body: { ok: true } });
});

test('rewards queries: typed filters, given twice a 400; the app\'s queries pass', async () => {
  assertRefused(await call('GET', '/rewards/catalog?all=true'), [{ path: 'query/all', rule: 'enum' }]);
  assertPassed(await call('GET', '/rewards/catalog?all=1'), 200);
  for (const route of ['/rewards/ledger', '/rewards/money/ledger']) {
    assertRefused(await call('GET', `${route}?user_id=abc`), [{ path: 'query/user_id', rule: 'type' }], route);
    assertRefused(await call('GET', `${route}?limit=12.5`), [{ path: 'query/limit', rule: 'type' }], route);
    assertRefused(await call('GET', `${route}?user_id=1&user_id=2`), [{ path: 'query/user_id', rule: 'type' }], route);
    // `0` stays the handler's "everybody", a limit outside 1..500 its clamp.
    assertPassed(await call('GET', `${route}?user_id=0&limit=9999`), 200, route);
    assertPassed(await call('GET', `${route}?user_id=${CHILD}&limit=12`), 200, route);
  }
  assertPassed(await call('GET', '/rewards/ledger?limit=8'), 200);
  for (const query of ['kind=', 'kind=__proto__', 'kind=points', 'status=bogus', 'status=PENDING', 'kind=all&kind=reward']) {
    const res = await call('GET', `/rewards/redemptions?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(res.body.reason, 'validation', query);
  }
  assertPassed(await call('GET', '/rewards/redemptions?status=pending&kind=all'), 200);
  assertPassed(await call('GET', '/rewards/redemptions?kind=all'), 200);
  assertPassed(await call('GET', '/rewards/redemptions'), 200);
});

test('POST /rewards/redemptions: typed ids, never null; the app\'s and the display\'s requests pass', async () => {
  const route = '/rewards/redemptions';
  /** @type {Array<[Record<string, unknown>, string, string]>} */
  const cases = [
    [{ catalog_id: 'abc' }, 'body/catalog_id', 'anyOf'], [{ catalog_id: null }, 'body/catalog_id', 'anyOf'], [{ catalog_id: 1.5 }, 'body/catalog_id', 'anyOf'],
    [{ catalog_id: REWARD.id, user_id: null }, 'body/user_id', 'anyOf'], [{ catalog_id: REWARD.id, user_id: '0x10' }, 'body/user_id', 'anyOf'],
    [{ catalog_id: REWARD.id, note: 5 }, 'body/note', 'type'], [{ kind: null }, 'body/kind', 'type'], [{ kind: 'loan' }, 'body/kind', 'enum'],
    [{ kind: 'withdrawal', amount: 5 }, 'body/amount', 'type'], [{ kind: 'withdrawal', amount: '1.00', currency: 5 }, 'body/currency', 'type'],
  ];
  for (const [json, path, rule] of cases) {
    assertRefusedAt(await call('POST', route, { json, actor: 'member' }), path, rule, JSON.stringify(json));
  }
  // The app (redeem dialog): numbers; a member's `user_id` is ignored as before.
  assertPassed(await call('POST', route, { json: { catalog_id: REWARD.id, user_id: MEMBER, note: undefined }, actor: 'member' }), 201);
  // An admin on behalf of somebody; the legacy digit text.
  assertPassed(await call('POST', route, { json: { catalog_id: String(REWARD.id), user_id: String(CHILD), note: 'bitte' } }), 201);
  // A paired display names the person (#1209).
  assertPassed(await call('POST', route, { json: { catalog_id: REWARD.id, user_id: CHILD }, actor: 'display' }), 201);
  // A typed but unknown reward is still the UI's 404; without `catalog_id` too (the money path needs none).
  for (const json of [{ catalog_id: 999999 }, {}]) {
    const gone = await call('POST', route, { json, actor: 'member' });
    assert.deepEqual([gone.status, gone.body.reason], [404, 'rewards_reward_not_found'], JSON.stringify(json));
  }
  // The money request of the app passes the schema (and meets the handler's account rule).
  const money = await call('POST', route, { json: { kind: 'withdrawal', amount: '1.00', note: undefined }, actor: 'member' });
  assert.deepEqual([money.status, money.body.reason], [400, 'no_money_account']);
});

test('PATCH /rewards/redemptions/{id}: `action` is required and from its list, a 400 before the 404, 409 and 403', async () => {
  const filed = await call('POST', '/rewards/redemptions', { json: { catalog_id: REWARD.id }, actor: 'child' });
  assertPassed(filed, 201);
  const id = filed.body.data.id;
  for (const json of [{}, { action: 'approve' }, { action: 5 }, { action: null }]) {
    assertRefusedAt(await call('PATCH', `/rewards/redemptions/${id}`, { json }), 'body/action', 'action' in json ? (typeof json.action === 'string' ? 'enum' : 'type') : 'required', JSON.stringify(json));
  }
  // Unknown request (was 404), a member's decision on somebody else's (was 403 admin).
  assertRefused(await call('PATCH', '/rewards/redemptions/999999', { json: { action: 'approve' } }), [{ path: 'body/action', rule: 'enum' }]);
  assertRefused(await call('PATCH', `/rewards/redemptions/${id}`, { json: { action: 'approve' }, actor: 'member' }), [{ path: 'body/action', rule: 'enum' }]);
  // A valid action still meets the 404, the 403 and the 409 as before.
  assert.equal((await call('PATCH', '/rewards/redemptions/999999', { json: { action: 'cancel' } })).body.reason, 'rewards_redemption_not_found');
  const refused = await call('PATCH', `/rewards/redemptions/${id}`, { json: { action: 'fulfill' }, actor: 'member' });
  assert.deepEqual({ status: refused.status, body: refused.body }, { status: 403, body: ADMIN_REQUIRED });
  // The app decides and takes it back.
  assertPassed(await call('PATCH', `/rewards/redemptions/${id}`, { json: { action: 'fulfill' } }), 200);
  // Decided: was 409 for a nonsense action.
  assertRefused(await call('PATCH', `/rewards/redemptions/${id}`, { json: { action: 'approve' } }), [{ path: 'body/action', rule: 'enum' }]);
  assert.equal((await call('PATCH', `/rewards/redemptions/${id}`, { json: { action: 'reject' } })).body.reason, 'rewards_redemption_decided');
  assertPassed(await call('PATCH', `/rewards/redemptions/${id}`, { json: { action: 'reopen' } }), 200);
});

test('POST /rewards/bonus: user and delta required and whole numbers, delta within the handler\'s bound', async () => {
  /** @type {Array<[Record<string, unknown>, string, string]>} */
  const cases = [
    [{ user_id: null, delta: 5 }, 'body/user_id', 'anyOf'], [{ user_id: CHILD, delta: '5' }, 'body/delta', 'type'],
    [{ user_id: CHILD, delta: 2.5 }, 'body/delta', 'type'], [{ user_id: CHILD, delta: 1_000_001 }, 'body/delta', 'maximum'],
    [{ user_id: CHILD, delta: -1_000_001 }, 'body/delta', 'minimum'], [{ user_id: CHILD, delta: 5, reason: 5 }, 'body/reason', 'type'],
    [{ delta: 5 }, 'body/user_id', 'required'], [{ user_id: CHILD }, 'body/delta', 'required'],
  ];
  for (const [json, path, rule] of cases) {
    assertRefusedAt(await call('POST', '/rewards/bonus', { json }), path, rule, JSON.stringify(json));
  }
  assertHandlerRefused(await call('POST', '/rewards/bonus', { json: { user_id: CHILD, delta: 0 } }));
  // `user_id: null` reached the enrolment check before; the 400 of a non-participant stays the handler's.
  assertHandlerRefused(await call('POST', '/rewards/bonus', { json: { user_id: ADMIN, delta: 5 } }), 'rewards_not_participating');
  // The app's bonus dialog; the reason is still cut, not refused.
  assertPassed(await call('POST', '/rewards/bonus', { json: { user_id: CHILD, delta: -3, reason: 'x'.repeat(300) } }), 201);
  assertPassed(await call('POST', '/rewards/bonus', { json: { user_id: String(CHILD), delta: 3, reason: undefined } }), 201);
});

test('pocket money: entries, accounts and plans typed; the 400 before the 404 of an unknown person', async () => {
  /** @type {Array<[string, string, Record<string, unknown>, string, string]>} */
  const cases = [
    ['POST', '/rewards/money/entries', { user_id: CHILD, amount: '1.00', direction: 'deposit' }, 'body/direction', 'enum'],
    ['POST', '/rewards/money/entries', { user_id: CHILD, amount: 1, direction: 'credit' }, 'body/amount', 'type'],
    ['POST', '/rewards/money/entries', { user_id: CHILD, direction: 'credit' }, 'body/amount', 'required'],
    ['POST', '/rewards/money/entries', { user_id: 'abc', amount: '1.00', direction: 'credit' }, 'body/user_id', 'anyOf'],
    ['POST', '/rewards/money/entries', { user_id: CHILD, amount: '1.00', direction: 'credit', reason: {} }, 'body/reason', 'type'],
    ['POST', '/rewards/money/accounts', {}, 'body/user_id', 'required'],
    ['POST', '/rewards/money/accounts', { user_id: null }, 'body/user_id', 'anyOf'],
    ['PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'daily', anchor_day: 1 }, 'body/frequency', 'enum'],
    ['PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: '3' }, 'body/anchor_day', 'type'],
    ['PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 0 }, 'body/anchor_day', 'minimum'],
    ['PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'monthly', anchor_day: 32 }, 'body/anchor_day', 'maximum'],
    ['PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 1, paused: null }, 'body/paused', 'type'],
    ['PUT', '/rewards/money/plans/999999', { amount: 2, frequency: 'weekly', anchor_day: 1 }, 'body/amount', 'type'],
  ];
  for (const [method, path, json, field, rule] of cases) {
    assertRefusedAt(await call(method, path, { json }), field, rule, `${method} ${path} ${JSON.stringify(json)}`);
  }
  assert.equal((await call('PUT', '/rewards/money/plans/999999', { json: { amount: '2.00', frequency: 'weekly', anchor_day: 1 } })).status, 404);
  // A weekly plan on day 8 is within the schema and stays the handler's 400.
  assertHandlerRefused(await call('PUT', `/rewards/money/plans/${CHILD}`, { json: { amount: '2.00', frequency: 'weekly', anchor_day: 8 } }));
  // The app: open an account, book, plan, close the plan.
  assertPassed(await call('POST', '/rewards/money/accounts', { json: { user_id: MEMBER } }), 201);
  assertPassed(await call('POST', '/rewards/money/entries', { json: { user_id: CHILD, amount: '5.00', direction: 'credit', reason: undefined } }), 201);
  assertPassed(await call('PUT', `/rewards/money/plans/${CHILD}`, { json: { amount: '2.00', frequency: 'monthly', anchor_day: 15, paused: false } }), 200);
  const del = await call('DELETE', `/rewards/money/plans/${CHILD}`);
  assert.deepEqual({ status: del.status, body: del.body }, { status: 200, body: { ok: true } });
  assertPassed(await call('POST', '/rewards/redemptions', { json: { kind: 'withdrawal', amount: '1.00', note: 'Eis' }, actor: 'child' }), 201);
});

// ════════════════════════════════════════════════════════════════════════════
// ONE SOURCE
// ════════════════════════════════════════════════════════════════════════════

const SPEC = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));

/** @param {string} path @param {string} method */
const bodyOf = (path, method) => SPEC.paths[path][method].requestBody.content['application/json'].schema.properties;
/** @param {string} path @param {string} method @returns {string[]} */
const requiredOf = (path, method) => SPEC.paths[path][method].requestBody.content['application/json'].schema.required ?? [];
/** @param {string} path @param {string} method @param {string} name */
const queryOf = (path, method, name) => SPEC.paths[path][method].parameters.find((/** @type {any} */ p) => p.name === name).schema;
/** @param {readonly unknown[]} values */
const asSet = (values) => [...new Set(values.filter((v) => v !== null && v !== ''))].sort();

test('one source: the housekeeping lists, limits and patterns are the handler\'s own', () => {
  const worker = bodyOf('/api/v1/housekeeping/worker', 'post');
  assert.deepEqual(asSet(worker.payment_schedule.enum), asSet(hk.PAYMENT_SCHEDULES), 'payment_schedule');
  assert.deepEqual(asSet(worker.rate_type.enum), asSet(hk.RATE_TYPES), 'rate_type');
  assert.equal(worker.display_name.maxLength, hk.MAX_WORKER_NAME);
  assert.equal(worker.username.maxLength, hk.MAX_WORKER_USERNAME);
  assert.equal(worker.avatar_data.maxLength, MAX_AVATAR_DATA_LENGTH);
  assert.equal(worker.birth_date.pattern, OPTIONAL_DATE_PATTERN);
  // The list is also the CHECK of the column.
  for (const schedule of hk.PAYMENT_SCHEDULES) {
    assert.doesNotThrow(() => db.transaction(() => {
      db.prepare('UPDATE housekeeping_workers SET payment_schedule = ? WHERE id = ?').run(schedule, WORKER.id);
    })(), schedule);
  }
  for (const route of ['summary', 'work-sessions', 'visits']) {
    assert.equal(queryOf(`/api/v1/housekeeping/${route}`, 'get', 'month').pattern, hk.HOUSEKEEPING_MONTH_PATTERN, route);
  }
  const visitBody = bodyOf('/api/v1/housekeeping/visits/{id}', 'put');
  assert.equal(visitBody.date.pattern, DATE_PATTERN);
  assert.equal(visitBody.original_date.pattern, OPTIONAL_DATE_PATTERN);
  for (const [path, method] of [['/api/v1/housekeeping/decay-tasks', 'post'], ['/api/v1/housekeeping/decay-tasks/{taskId}', 'patch']]) {
    assert.equal(bodyOf(path, method).last_completed.pattern, OPTIONAL_DATETIME_PATTERN, `${method} ${path}`);
  }
  assert.equal(bodyOf('/api/v1/housekeeping/work-sessions/check-in', 'post').local_date.pattern, DATE_PATTERN);
});

test('one source: the rewards lists and limits are the handler\'s own', () => {
  assert.deepEqual(asSet(bodyOf('/api/v1/rewards/redemptions/{id}', 'patch').action.enum), asSet(rw.REDEMPTION_ACTIONS), 'action');
  assert.deepEqual(asSet(rw.REDEMPTION_ACTIONS), asSet([...rw.REDEMPTION_DECISIONS, 'reopen']), 'the decisions and their way back');
  assert.deepEqual(asSet(bodyOf('/api/v1/rewards/redemptions', 'post').kind.enum), asSet(['reward', ...rw.MONEY_KINDS]), 'kind of a request');
  assert.deepEqual(asSet(queryOf('/api/v1/rewards/redemptions', 'get', 'status').enum), asSet(rw.REDEMPTION_STATUSES), 'status');
  assert.deepEqual(asSet(queryOf('/api/v1/rewards/redemptions', 'get', 'kind').enum), asSet(Object.keys(rw.REDEMPTION_KIND_FILTERS)), 'kind filter');
  assert.deepEqual(asSet(bodyOf('/api/v1/rewards/money/plans/{userId}', 'put').frequency.enum), asSet(rw.ALLOWANCE_FREQUENCIES), 'frequency');
  assert.deepEqual(asSet(bodyOf('/api/v1/rewards/money/entries', 'post').direction.enum), asSet(rw.MONEY_DIRECTIONS), 'direction');
  assert.equal(money.MONEY_KINDS, rw.MONEY_KINDS, 'reward-money.js hands on the one list');
  assert.equal(money.ALLOWANCE_FREQUENCIES, rw.ALLOWANCE_FREQUENCIES, 'reward-money.js hands on the one list');
  const catalog = bodyOf('/api/v1/rewards/catalog', 'post');
  assert.equal(catalog.cost.maximum, rw.MAX_COST);
  assert.equal(catalog.quantity.maximum, rw.MAX_QUANTITY);
  assert.equal(bodyOf('/api/v1/rewards/bonus', 'post').delta.maximum, rw.MAX_BONUS);
  assert.equal(bodyOf('/api/v1/rewards/bonus', 'post').delta.minimum, -rw.MAX_BONUS);
});

// Since step (b) these schema values are the only guard in front of the
// handler: its own checks of them are gone (#2810). Literal bounds are held
// as values here, the lists and limits of the fields files above.
test('the schema alone guards what the handlers stopped checking: types, literal bounds, default forms', () => {
  const worker = bodyOf('/api/v1/housekeeping/worker', 'post');
  assert.deepEqual(worker.daily_rate.type, 'number', 'worker daily_rate');
  assert.deepEqual(worker.hourly_rate.type, ['number', 'null'], 'worker hourly_rate');
  assert.ok(requiredOf('/api/v1/housekeeping/worker', 'post').includes('daily_rate'), 'worker daily_rate required');
  for (const field of ['payment_schedule', 'rate_type']) {
    assert.deepEqual(worker[field].type, ['string', 'null'], field);
    assert.ok(worker[field].enum.includes('') && worker[field].enum.includes(null), `${field}: "" and null are the default`);
  }
  assert.deepEqual(bodyOf('/api/v1/housekeeping/work-sessions/check-out', 'post').extras.type, ['number', 'null'], 'check-out extras');
  assert.deepEqual(bodyOf('/api/v1/housekeeping/visits/{id}', 'put').minutes_worked.type, ['integer', 'null'], 'minutes_worked');
  for (const [path, method] of [['/api/v1/housekeeping/decay-tasks', 'post'], ['/api/v1/housekeeping/decay-tasks/{taskId}', 'patch']]) {
    const frequency = bodyOf(path, method).frequency_days;
    assert.equal(frequency.type, 'integer', `${method} ${path}`);
    assert.equal(frequency.minimum, 1, `${method} ${path}`);
  }
  assert.ok(requiredOf('/api/v1/housekeeping/decay-tasks', 'post').includes('frequency_days'), 'frequency_days required');
  // 1 is also the CHECK of the column: 0 is refused there, 1 is not.
  assert.throws(() => db.prepare("INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, created_by) VALUES ('x', 'y', 0, ?)").run(ADMIN), /CHECK/);
  assert.throws(() => db.transaction(() => {
    db.prepare("INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, created_by) VALUES ('x', 'y', 1, ?)").run(ADMIN);
    throw new Error('rollback');
  })(), /^Error: rollback$/, '1 passes the CHECK (rolled back)');
  assert.deepEqual(bodyOf('/api/v1/housekeeping/maintenance-log', 'post').photo_url.type, ['string', 'null'], 'photo_url');
  for (const method of ['post', 'patch']) {
    const path = method === 'post' ? '/api/v1/rewards/catalog' : '/api/v1/rewards/catalog/{id}';
    const catalog = bodyOf(path, method);
    assert.equal(catalog.cost.minimum, 1, `${method} cost`);
    assert.equal(catalog.cost.maximum, rw.MAX_COST, `${method} cost`);
    assert.equal(catalog.quantity.minimum, 1, `${method} quantity: 0 is never a stock`);
    assert.equal(catalog.quantity.maximum, rw.MAX_QUANTITY, `${method} quantity`);
    assert.deepEqual(catalog.quantity.type, ['integer', 'null'], `${method} quantity`);
    assert.equal(catalog.sort_order.type, 'integer', `${method} sort_order`);
  }
  assert.equal(bodyOf('/api/v1/rewards/catalog', 'post').cost.type, 'integer');
  assert.deepEqual(bodyOf('/api/v1/rewards/catalog/{id}', 'patch').cost.type, ['integer', 'null']);
  assert.equal(bodyOf('/api/v1/rewards/catalog/{id}', 'patch').is_active.type, 'boolean');
  assert.equal(bodyOf('/api/v1/rewards/participants/{userId}', 'put').enabled.type, 'boolean');
  assert.equal(bodyOf('/api/v1/rewards/bonus', 'post').delta.type, 'integer');
  const plan = bodyOf('/api/v1/rewards/money/plans/{userId}', 'put');
  assert.equal(plan.paused.type, 'boolean');
  assert.equal(plan.anchor_day.type, 'integer');
  assert.equal(plan.anchor_day.minimum, 1);
  assert.equal(plan.anchor_day.maximum, 31);
});

test('one source: every month the pattern accepts is one the month window computes, in every zone', () => {
  const pattern = new RegExp(hk.HOUSEKEEPING_MONTH_PATTERN);
  const zones = [...Intl.supportedValuesOf('timeZone'), 'UTC'];
  const failed = [];
  for (const year of [1001, 1002, 1999, 2026, 9998, 9999]) {
    for (let m = 1; m <= 12; m++) {
      const month = `${year}-${String(m).padStart(2, '0')}`;
      assert.ok(pattern.test(month), month);
      for (const zone of zones) {
        try { householdMonthWindow(month, zone); } catch (err) { failed.push(`${month} ${zone}: ${/** @type {Error} */ (err).message}`); }
      }
    }
  }
  assert.deepEqual(failed, []);
  for (const month of ['0000-01', '0999-12', '1000-01', '1000-12', '2026-00', '2026-13', '10000-01']) {
    assert.ok(!pattern.test(month), `${month} is refused`);
  }
  assert.ok(pattern.test(''), 'empty is the current month');
});
