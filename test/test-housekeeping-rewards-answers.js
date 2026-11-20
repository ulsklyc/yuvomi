/**
 * Test: the answers of the housekeeping and rewards modules stay byte-equal (#2810, phase 2 section E, group 3)
 * Purpose: server/routes/housekeeping.js (24 routes) and server/routes/rewards.js
 *          (19 routes) dropped the hand checks the schema of their operation
 *          already covers (`validateRequest()` runs before every handler since
 *          #2831) and the try/catch blocks that answered an unexpected error
 *          with a 500 of their own. That is a refactor, and this suite holds
 *          it: for a table of requests to all 43 operations - valid, every
 *          refusal of the handler that stays, every input a dropped hand check
 *          refused (now the schema's 400), not found, rights, conflicts, for
 *          an admin, a member, a child without `housekeeping_view_amounts` and
 *          a paired display - it pins status and the WHOLE answer body. The
 *          expectations were written at the state before the refactor
 *          (a1aa36de9) and are literal here, no fixture file, no update mode.
 *          Only values that follow a clock this suite does not hold (SQLite's
 *          own `now`) are replaced by a marker before the comparison.
 *
 *          The clock stands still (`mock.timers`, 18.11.2026 12:00 UTC) and the
 *          household lives in Europe/Berlin (`household_timezone`): visits,
 *          months, due dates and plans read "now" and "today".
 *
 *          Rows the table holds on purpose:
 *            - `GET /rewards/redemptions?status=<each of the four>` answers
 *              exactly the requests of that status, and each `kind` its own
 *              subset - the data has a non-empty, distinct subset for every
 *              value (a filter narrowed in the handler turns a row red);
 *            - a 400-digit id in the body (`9` x 400): the schema's digit text
 *              lets it through, `Number()` reads it as Infinity, and the
 *              handler's own `Number.isFinite` answers.
 *
 *          The second part: an unexpected error in every one of the 43 routes
 *          reaches the central error handler - 500 with its fixed sentence and
 *          its log line `Unhandled error: <METHOD> <pattern> -> 500` - and the
 *          process keeps answering. What stays the route's own: the 409 of a
 *          taken username, the 409 of a document being deleted and the 403 of
 *          a receipt link without the right, and the 400 of a money input
 *          (`SplitInputError`).
 * Run: npm run test:housekeeping-rewards-answers
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { default: rewardsRouter } = await import('../server/routes/rewards.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { applyChildStartPermissions, resolveRequestModuleAccess } = await import('../server/authorize/index.ts');
const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
const db = dbmod.get();

db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('housekeeping_payment_tasks', '1')").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

/** @param {string} username @param {string} role @param {string} familyRole */
function user(username, role, familyRole) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('linda', 'admin', 'parent');
const MEMBER = user('tom', 'member', 'parent');
// A child starts without `housekeeping_view_amounts`.
const CHILD = user('mia', 'member', 'child');
applyChildStartPermissions(db, { id: CHILD, role: 'member', family_role: 'child' });
const DISPLAY = user('wall', 'member', 'other');

/** @type {Record<string, { id: number, role: string, method?: string, scopes?: string[] }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  member: { id: MEMBER, role: 'member' },
  child: { id: CHILD, role: 'member' },
  display: { id: DISPLAY, role: 'member', method: 'display' },
  // An API token of the admin that may write housekeeping, not shopping.
  token: { id: ADMIN, role: 'admin', method: 'api_token', scopes: ['housekeeping:write', 'housekeeping:read'] },
};

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = {
  warn: (/** @type {string} */ line) => { logged.warn.push(line); },
  error: (/** @type {string} */ line) => { logged.error.push(line); },
};

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read. `x-access` overrides
// the session's module access (e.g. {"documents":"none"}).
app.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
  const actor = ACTORS[req.get('x-actor') ?? 'admin'];
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = actor.method ?? 'session';
  req.authScopes = actor.scopes ?? null;
  req.session = { userId: actor.id, role: actor.role };
  req.sessionModuleAccess = req.get('x-access')
    ? { ...resolveRequestModuleAccess(db, req), ...JSON.parse(req.get('x-access')) }
    : resolveRequestModuleAccess(db, req);
  // An unexpected error: the first answer of the handler throws.
  if (req.get('x-fail') === 'json') {
    const json = res.json;
    let thrown = false;
    res.json = function (/** @type {unknown} */ value) {
      if (!thrown) { thrown = true; throw new Error('serializer broke'); }
      return json.call(this, value);
    };
  }
  next();
});
// The mounts of server/index.js, in its order.
app.use('/api/v1/housekeeping', housekeepingRouter);
app.use('/api/v1/rewards', rewardsRouter);
app.use(createErrorHandler(log));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

const NO_BODY = Symbol('no body');

/**
 * @typedef {{ actor?: string, access?: Record<string, string>, fail?: boolean }} CallOptions
 */

/**
 * @param {string} method
 * @param {string} path under /api/v1
 * @param {unknown} body a JSON value or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, path, body, { actor, access, fail } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== NO_BODY) headers['Content-Type'] = 'application/json';
  if (actor) headers['x-actor'] = actor;
  if (access) headers['x-access'] = JSON.stringify(access);
  if (fail) headers['x-fail'] = 'json';
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: body === NO_BODY ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (text.length === 0) return { status: res.status, body: null };
  return { status: res.status, body: JSON.parse(text) };
}

// Timestamps SQLite writes from its own clock ('now'), not from Date, and the
// version of an avatar address, which follows such a timestamp.
const VOLATILE = new Set(['created_at', 'updated_at', 'decided_at']);
const AVATAR_VERSION = /^(\/api\/v1\/people\/\d+\/avatar\?v=)[0-9a-f]+$/;

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (VOLATILE.has(key) && v !== null) return '<volatile>';
    if (typeof v === 'string' && AVATAR_VERSION.test(v)) return v.replace(AVATAR_VERSION, '$1<volatile>');
    return v;
  });
}

// ── Seed ──

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_LABEL_JPEG = 'data:image/png;base64,/9j/4AABAgP/2Q==';
const EMOJI_70 = '😀'.repeat(70); // 70 code points, 140 UTF-16 units
const HUGE_DIGITS = '9'.repeat(400); // digit text, Number() reads Infinity
const DOC = Number(db.prepare(`
  INSERT INTO family_documents (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
  VALUES ('Quittung', 'other', 'family', 'q.pdf', 'application/pdf', 1234, 'data:application/pdf;base64,AA==', ?)
`).run(ADMIN).lastInsertRowid);

const MARIA = {
  display_name: ' Maria ', username: 'maria', phone: '+49 30 1234', email: 'maria@example.org', birth_date: '1980-05-04',
  daily_rate: 60, payment_schedule: 'monthly', rate_type: 'daily', calendar_color: '#1D4ED8', avatar_color: '#0F766E',
  avatar_data: PNG, notes: 'Dienstags',
};
const PEDRO = { display_name: 'Pedro', daily_rate: 0, rate_type: 'hourly', hourly_rate: 20, payment_schedule: null, username: null };
const VISIT = { date: '2026-11-18', original_date: '2026-11-18', daily_rate: 65, extras: 5 };

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a body that is a function is called when its row runs.
 * @type {Array<[string, string, string, unknown, CallOptions?] | (() => void)>}
 */
const STEPS = [
  // ── housekeeping: empty household ─────────────────────────────────────────
  ['hk dashboard empty', 'GET', '/housekeeping/dashboard', NO_BODY],
  ['hk templates', 'GET', '/housekeeping/task-templates', NO_BODY],
  ['hk worker empty', 'GET', '/housekeeping/worker', NO_BODY],
  ['hk workers empty', 'GET', '/housekeeping/workers', NO_BODY],
  ['hk workers member', 'GET', '/housekeeping/workers', NO_BODY, { actor: 'member' }],
  ['hk check-in no worker', 'POST', '/housekeeping/work-sessions/check-in', { worker_id: 1, daily_rate: 60 }],

  // ── housekeeping: worker profiles ─────────────────────────────────────────
  ['hk worker create member', 'POST', '/housekeeping/worker', MARIA, { actor: 'member' }],
  ['hk worker create no body', 'POST', '/housekeeping/worker', NO_BODY],
  ['hk worker create empty', 'POST', '/housekeeping/worker', {}],
  ['hk worker create schedule unknown', 'POST', '/housekeeping/worker', { ...MARIA, payment_schedule: 'yearly' }],
  ['hk worker create schedule false', 'POST', '/housekeeping/worker', { ...MARIA, payment_schedule: false }],
  ['hk worker create schedule zero', 'POST', '/housekeeping/worker', { ...MARIA, payment_schedule: 0 }],
  ['hk worker create rate type unknown', 'POST', '/housekeeping/worker', { ...MARIA, rate_type: 'weekly' }],
  ['hk worker create rate type number', 'POST', '/housekeeping/worker', { ...MARIA, rate_type: 1 }],
  ['hk worker create daily rate text', 'POST', '/housekeeping/worker', { ...MARIA, daily_rate: '60' }],
  ['hk worker create daily rate null', 'POST', '/housekeeping/worker', { ...MARIA, daily_rate: null }],
  ['hk worker create daily rate missing', 'POST', '/housekeeping/worker', { display_name: 'Maria' }],
  ['hk worker create daily rate negative', 'POST', '/housekeeping/worker', { ...MARIA, daily_rate: -1 }],
  ['hk worker create hourly rate text', 'POST', '/housekeeping/worker', { ...MARIA, hourly_rate: '20' }],
  ['hk worker create hourly rate negative', 'POST', '/housekeeping/worker', { ...MARIA, hourly_rate: -0.5 }],
  ['hk worker create name spaces', 'POST', '/housekeeping/worker', { ...MARIA, display_name: '   ' }],
  ['hk worker create name empty', 'POST', '/housekeeping/worker', { ...MARIA, display_name: '' }],
  ['hk worker create name 129', 'POST', '/housekeeping/worker', { ...MARIA, display_name: 'a'.repeat(129) }],
  ['hk worker create name emoji', 'POST', '/housekeeping/worker', { ...MARIA, display_name: EMOJI_70 }],
  ['hk worker create username spaces', 'POST', '/housekeeping/worker', { ...MARIA, username: ' ab' }],
  ['hk worker create username blank inside', 'POST', '/housekeeping/worker', { ...MARIA, username: 'ma ria' }],
  ['hk worker create username number', 'POST', '/housekeeping/worker', { ...MARIA, username: 5 }],
  ['hk worker create birth day invalid', 'POST', '/housekeeping/worker', { ...MARIA, birth_date: '1980-02-30' }],
  ['hk worker create birth day shape', 'POST', '/housekeeping/worker', { ...MARIA, birth_date: '04.05.1980' }],
  ['hk worker create year unknown number', 'POST', '/housekeeping/worker', { ...MARIA, birth_year_unknown: 1 }],
  ['hk worker create calendar color', 'POST', '/housekeeping/worker', { ...MARIA, calendar_color: 'red' }],
  ['hk worker create avatar color', 'POST', '/housekeeping/worker', { ...MARIA, avatar_color: 'blue' }],
  ['hk worker create avatar text', 'POST', '/housekeeping/worker', { ...MARIA, avatar_data: 'data:text/plain;base64,AA' }],
  ['hk worker create avatar number', 'POST', '/housekeeping/worker', { ...MARIA, avatar_data: 5 }],
  ['hk worker create notes 5001', 'POST', '/housekeeping/worker', { ...MARIA, notes: 'n'.repeat(5001) }],
  ['hk worker create id zero', 'POST', '/housekeeping/worker', { ...MARIA, id: 0 }],
  ['hk worker create id negative', 'POST', '/housekeeping/worker', { ...MARIA, id: -3 }],
  ['hk worker create id unknown', 'POST', '/housekeeping/worker', { ...MARIA, id: 999 }],
  ['hk worker create id empty', 'POST', '/housekeeping/worker', { ...MARIA, id: '' }],
  ['hk worker create id letters', 'POST', '/housekeeping/worker', { ...MARIA, id: '7abc' }],
  ['hk worker create', 'POST', '/housekeeping/worker', MARIA],
  ['hk worker create username taken', 'POST', '/housekeeping/worker', { ...MARIA, display_name: 'Maria Zwei' }],
  ['hk worker create hourly', 'POST', '/housekeeping/worker', PEDRO],
  ['hk worker create defaults empty', 'POST', '/housekeeping/worker', { display_name: 'Ana', daily_rate: 50, payment_schedule: '', rate_type: '', hourly_rate: null, username: '' }],
  ['hk worker update', 'POST', '/housekeeping/worker', () => ({ ...MARIA, id: resolved('__MARIA__'), payment_schedule: 'twice_monthly', birth_date: '1980-02-29', birth_year_unknown: true })],
  ['hk worker update digit text', 'POST', '/housekeeping/worker', () => ({ display_name: 'Ana', daily_rate: 55, id: resolved('__ANA__') })],
  ['hk worker update schedule unknown', 'POST', '/housekeeping/worker', () => ({ ...MARIA, id: Number(resolved('__MARIA__')), payment_schedule: 'weekly' })],
  ['hk worker get', 'GET', '/housekeeping/worker', NO_BODY],
  ['hk worker get child', 'GET', '/housekeeping/worker', NO_BODY, { actor: 'child' }],
  ['hk worker get timezone', 'GET', '/housekeeping/worker?timezone=America/New_York&local_date=2026-11-17&timezone_offset_minutes=-300', NO_BODY],
  ['hk worker get local date shape', 'GET', '/housekeeping/worker?local_date=2026-1-1', NO_BODY],
  ['hk worker get offset fraction', 'GET', '/housekeeping/worker?timezone_offset_minutes=1.5', NO_BODY],
  ['hk workers', 'GET', '/housekeeping/workers', NO_BODY],
  ['hk workers token', 'GET', '/housekeeping/workers', NO_BODY, { actor: 'token' }],

  // ── housekeeping: check-in, check-out, reopen ─────────────────────────────
  ['hk check-in no body', 'POST', '/housekeeping/work-sessions/check-in', NO_BODY],
  ['hk check-in worker zero', 'POST', '/housekeeping/work-sessions/check-in', { worker_id: 0, daily_rate: 60 }],
  ['hk check-in worker negative', 'POST', '/housekeeping/work-sessions/check-in', { worker_id: -1, daily_rate: 60 }],
  ['hk check-in worker unknown', 'POST', '/housekeeping/work-sessions/check-in', { worker_id: 999, daily_rate: 60 }],
  ['hk check-in worker letters', 'POST', '/housekeeping/work-sessions/check-in', { worker_id: '1abc', daily_rate: 60 }],
  ['hk check-in rate missing', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')) })],
  ['hk check-in rate text', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: '60' })],
  ['hk check-in rate negative', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: -1 })],
  ['hk check-in extras negative', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: 60, extras: -1 })],
  ['hk check-in extras text', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: 60, extras: '5' })],
  ['hk check-in title spaces long', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: 60, payment_title: `  ${'t'.repeat(199)}  ` })],
  ['hk check-in title 201', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: 60, event_title: 't'.repeat(201) })],
  ['hk check-in description emoji', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: 60, payment_description: '😀'.repeat(2600) })],
  ['hk check-in', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: 60, extras: null, event_title: ' Besuch ', payment_title: 'Lohn', payment_description: 'Bar' })],
  ['hk check-in again', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: 60 })],
  ['hk check-out worker zero', 'POST', '/housekeeping/work-sessions/check-out', { worker_id: 0 }],
  ['hk check-out worker letters', 'POST', '/housekeeping/work-sessions/check-out', { worker_id: 'x' }],
  ['hk check-out none open', 'POST', '/housekeeping/work-sessions/check-out', () => ({ worker_id: Number(resolved('__PEDRO__')) })],
  ['hk check-out extras text', 'POST', '/housekeeping/work-sessions/check-out', () => ({ worker_id: Number(resolved('__MARIA__')), extras: '10' })],
  ['hk check-out extras negative', 'POST', '/housekeeping/work-sessions/check-out', () => ({ worker_id: Number(resolved('__MARIA__')), extras: -1 })],
  ['hk check-out', 'POST', '/housekeeping/work-sessions/check-out', () => ({ worker_id: resolved('__MARIA__'), extras: 10 })],
  ['hk reopen', 'POST', '/housekeeping/work-sessions/__V1__/reopen', NO_BODY],
  ['hk reopen still open', 'POST', '/housekeeping/work-sessions/__V1__/reopen', NO_BODY],
  ['hk reopen zero', 'POST', '/housekeeping/work-sessions/0/reopen', NO_BODY],
  ['hk reopen unknown', 'POST', '/housekeeping/work-sessions/999/reopen', NO_BODY],
  ['hk reopen letters', 'POST', '/housekeeping/work-sessions/1abc/reopen', NO_BODY],
  ['hk check-out keeps extras', 'POST', '/housekeeping/work-sessions/check-out', () => ({ worker_id: Number(resolved('__MARIA__')), extras: null })],
  ['hk check-in child', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__PEDRO__')), payment_title: 'x' }), { actor: 'child' }],
  ['hk check-in child rate text', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__ANA__')), daily_rate: 'x' }), { actor: 'child' }],
  ['hk check-out child', 'POST', '/housekeeping/work-sessions/check-out', () => ({ worker_id: Number(resolved('__PEDRO__')), extras: 99 }), { actor: 'child' }],
  ['hk check-in day context', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__MARIA__')), daily_rate: 70, extras: 0, local_date: '2026-11-17', timezone_offset_minutes: -600 })],
  ['hk reopen other open', 'POST', '/housekeeping/work-sessions/__V1__/reopen', NO_BODY],
  ['hk check-out third', 'POST', '/housekeeping/work-sessions/check-out', () => ({ worker_id: Number(resolved('__MARIA__')) })],
  ['hk check-in ana', 'POST', '/housekeeping/work-sessions/check-in', () => ({ worker_id: Number(resolved('__ANA__')), daily_rate: 50 }), { actor: 'member' }],

  // ── housekeeping: month lists ─────────────────────────────────────────────
  ['hk summary', 'GET', '/housekeeping/summary', NO_BODY],
  ['hk summary child', 'GET', '/housekeeping/summary', NO_BODY, { actor: 'child' }],
  ['hk summary month', 'GET', '/housekeeping/summary?month=2026-11', NO_BODY],
  ['hk summary month empty', 'GET', '/housekeeping/summary?month=', NO_BODY],
  ['hk summary month other', 'GET', '/housekeeping/summary?month=2026-10', NO_BODY],
  ['hk summary month 13', 'GET', '/housekeeping/summary?month=2026-13', NO_BODY],
  ['hk summary month short', 'GET', '/housekeeping/summary?month=2026-1', NO_BODY],
  ['hk summary month twice', 'GET', '/housekeeping/summary?month=2026-11&month=2026-10', NO_BODY],
  ['hk summary month year 1000', 'GET', '/housekeeping/summary?month=1000-01', NO_BODY],
  ['hk summary month year 1001', 'GET', '/housekeeping/summary?month=1001-01', NO_BODY],
  ['hk summary month letters', 'GET', '/housekeeping/summary?month=abc', NO_BODY],
  ['hk work-sessions', 'GET', '/housekeeping/work-sessions', NO_BODY],
  ['hk work-sessions child', 'GET', '/housekeeping/work-sessions', NO_BODY, { actor: 'child' }],
  ['hk work-sessions month 00', 'GET', '/housekeeping/work-sessions?month=2026-00', NO_BODY],
  ['hk work-sessions month other', 'GET', '/housekeeping/work-sessions?month=9999-12', NO_BODY],
  ['hk work-sessions month 0999', 'GET', '/housekeeping/work-sessions?month=0999-12', NO_BODY],
  ['hk visits', 'GET', '/housekeeping/visits', NO_BODY],
  ['hk visits member', 'GET', '/housekeeping/visits', NO_BODY, { actor: 'member' }],
  ['hk visits child', 'GET', '/housekeeping/visits', NO_BODY, { actor: 'child' }],
  ['hk visits no documents', 'GET', '/housekeeping/visits', NO_BODY, { access: { documents: 'none' } }],
  ['hk visits worker', 'GET', '/housekeeping/visits?worker_id=__PEDRO__', NO_BODY],
  ['hk visits worker unknown', 'GET', '/housekeeping/visits?worker_id=999', NO_BODY],
  ['hk visits worker zero', 'GET', '/housekeeping/visits?worker_id=0', NO_BODY],
  ['hk visits worker negative', 'GET', '/housekeeping/visits?worker_id=-2', NO_BODY],
  ['hk visits worker empty', 'GET', '/housekeeping/visits?worker_id=', NO_BODY],
  ['hk visits worker letters', 'GET', '/housekeeping/visits?worker_id=1abc', NO_BODY],
  ['hk visits month 13', 'GET', '/housekeeping/visits?month=2026-13', NO_BODY],
  ['hk visits month other', 'GET', '/housekeeping/visits?month=2026-12&worker_id=__MARIA__', NO_BODY],
  ['hk dashboard', 'GET', '/housekeeping/dashboard', NO_BODY],
  ['hk dashboard child', 'GET', '/housekeeping/dashboard', NO_BODY, { actor: 'child' }],
  ['hk dashboard timezone', 'GET', '/housekeeping/dashboard?timezone=Asia/Tokyo', NO_BODY],

  // ── housekeeping: one visit ───────────────────────────────────────────────
  ['hk visit get', 'GET', '/housekeeping/visits/__V1__', NO_BODY],
  ['hk visit get child', 'GET', '/housekeeping/visits/__V1__', NO_BODY, { actor: 'child' }],
  ['hk visit get zero', 'GET', '/housekeeping/visits/0', NO_BODY],
  ['hk visit get unknown', 'GET', '/housekeeping/visits/999', NO_BODY],
  ['hk visit get letters', 'GET', '/housekeeping/visits/12abc', NO_BODY],
  ['hk visit put no body', 'PUT', '/housekeeping/visits/__V1__', NO_BODY],
  ['hk visit put empty', 'PUT', '/housekeeping/visits/__V1__', {}],
  ['hk visit put day invalid', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, date: '2026-02-30' }],
  ['hk visit put day shape', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, date: '18.11.2026' }],
  ['hk visit put original invalid', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, original_date: '2026-11-31' }],
  ['hk visit put rate missing', 'PUT', '/housekeeping/visits/__V1__', { date: '2026-11-18' }],
  ['hk visit put rate null', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, daily_rate: null }],
  ['hk visit put rate text', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, daily_rate: '65' }],
  ['hk visit put rate negative', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, daily_rate: -1 }],
  ['hk visit put extras negative', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, extras: -1 }],
  ['hk visit put minutes on daily', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, minutes_worked: 30 }],
  ['hk visit put receipt zero', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, receipt_document_id: 0 }],
  ['hk visit put receipt negative', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, receipt_document_id: -1 }],
  ['hk visit put receipt letters', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, receipt_document_id: '1x' }],
  ['hk visit put receipt no documents', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, receipt_document_id: DOC }, { access: { documents: 'none' } }],
  ['hk visit put receipt unknown', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, receipt_document_id: 999 }],
  ['hk visit put title emoji', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, payment_title: '😀'.repeat(150) }],
  ['hk visit put', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, receipt_document_id: DOC, event_title: 'Grossputz', payment_title: 'Lohn Maria' }],
  ['hk visit put receipt digit text', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, receipt_document_id: String(DOC) }],
  ['hk visit put move day', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, date: '2026-11-16' }],
  ['hk visit put receipt hidden keep', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, date: '2026-11-16', original_date: '2026-11-16', receipt_document_id: null }, { access: { documents: 'none' } }],
  ['hk visit put receipt hidden change', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, date: '2026-11-16', original_date: '2026-11-16', receipt_document_id: DOC }, { access: { documents: 'none' } }],
  ['hk visit put child', 'PUT', '/housekeeping/visits/__V1__', { date: '2026-11-17', original_date: '2026-11-16', daily_rate: 1, extras: 1 }, { actor: 'child' }],
  ['hk visit put child rate text', 'PUT', '/housekeeping/visits/__V1__', { date: '2026-11-17', daily_rate: 'x' }, { actor: 'child' }],
  ['hk visit put hourly minutes', 'PUT', '/housekeeping/visits/__V2__', { date: '2026-11-18', minutes_worked: 90, extras: 2 }],
  ['hk visit put hourly minutes fraction', 'PUT', '/housekeeping/visits/__V2__', { date: '2026-11-18', minutes_worked: 1.5 }],
  ['hk visit put hourly minutes text', 'PUT', '/housekeeping/visits/__V2__', { date: '2026-11-18', minutes_worked: '90' }],
  ['hk visit put hourly minutes null', 'PUT', '/housekeeping/visits/__V2__', { date: '2026-11-18', minutes_worked: null, receipt_document_id: '' }],
  ['hk visit put hourly minutes negative', 'PUT', '/housekeeping/visits/__V2__', { date: '2026-11-18', minutes_worked: -30 }],
  ['hk visit put zero', 'PUT', '/housekeeping/visits/0', VISIT],
  ['hk visit put unknown', 'PUT', '/housekeeping/visits/999', VISIT],

  // ── housekeeping: pay, unpay, delete ──────────────────────────────────────
  ['hk pay child', 'POST', '/housekeeping/visits/__V1__/pay', NO_BODY, { actor: 'child' }],
  ['hk pay zero', 'POST', '/housekeeping/visits/0/pay', NO_BODY],
  ['hk pay unknown', 'POST', '/housekeeping/visits/999/pay', NO_BODY],
  ['hk pay', 'POST', '/housekeeping/visits/__V1__/pay', { ignored: true }],
  ['hk visit get paid member', 'GET', '/housekeeping/visits/__V1__', NO_BODY, { actor: 'member' }],
  ['hk visit put paid member', 'PUT', '/housekeeping/visits/__V1__', VISIT, { actor: 'member' }],
  ['hk visit put paid member malformed', 'PUT', '/housekeeping/visits/__V1__', { ...VISIT, daily_rate: 'x' }, { actor: 'member' }],
  ['hk pay paid member', 'POST', '/housekeeping/visits/__V1__/pay', NO_BODY, { actor: 'member' }],
  ['hk visit delete paid member', 'DELETE', '/housekeeping/visits/__V1__', NO_BODY, { actor: 'member' }],
  ['hk unpay member', 'POST', '/housekeeping/visits/__V1__/unpay', NO_BODY, { actor: 'member' }],
  ['hk unpay zero', 'POST', '/housekeeping/visits/0/unpay', NO_BODY],
  ['hk unpay unknown', 'POST', '/housekeeping/visits/999/unpay', NO_BODY],
  ['hk unpay', 'POST', '/housekeeping/visits/__V1__/unpay', NO_BODY],
  ['hk unpay unpaid', 'POST', '/housekeeping/visits/__V1__/unpay', NO_BODY],
  ['hk pay member', 'POST', '/housekeeping/visits/__V2__/pay', NO_BODY, { actor: 'member' }],
  ['hk reopen paid', 'POST', '/housekeeping/work-sessions/__V2__/reopen', NO_BODY],
  ['hk visits after pay', 'GET', '/housekeeping/visits', NO_BODY],
  ['hk visit delete zero', 'DELETE', '/housekeeping/visits/0', NO_BODY],
  ['hk visit delete letters', 'DELETE', '/housekeeping/visits/1.0', NO_BODY],
  ['hk visit delete', 'DELETE', '/housekeeping/visits/__V3__', NO_BODY],
  ['hk visit delete again', 'DELETE', '/housekeeping/visits/__V3__', NO_BODY],

  // ── housekeeping: decay tasks ─────────────────────────────────────────────
  ['hk tasks empty', 'GET', '/housekeeping/decay-tasks', NO_BODY],
  ['hk task create', 'POST', '/housekeeping/decay-tasks', { name: ' Fenster ', area: 'Haus', frequency_days: 30, last_completed: '2026-11-01T10:00:00+01:00' }],
  ['hk task create no last', 'POST', '/housekeeping/decay-tasks', { name: 'Bad', area: 'Bad', frequency_days: 7 }],
  ['hk task create wall clock', 'POST', '/housekeeping/decay-tasks', { name: 'Ofen', area: 'Kueche', frequency_days: 1, last_completed: '2026-11-17T08:00' }],
  ['hk task create last empty', 'POST', '/housekeeping/decay-tasks', { name: 'Keller', area: 'Keller', frequency_days: 60, last_completed: '' }],
  ['hk task create no body', 'POST', '/housekeeping/decay-tasks', NO_BODY],
  ['hk task create frequency missing', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y' }],
  ['hk task create frequency zero', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y', frequency_days: 0 }],
  ['hk task create frequency negative', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y', frequency_days: -7 }],
  ['hk task create frequency fraction', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y', frequency_days: 1.5 }],
  ['hk task create frequency text', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y', frequency_days: '7' }],
  ['hk task create frequency null', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y', frequency_days: null }],
  ['hk task create frequency true', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y', frequency_days: true }],
  ['hk task create name spaces', 'POST', '/housekeeping/decay-tasks', { name: '  ', area: 'y', frequency_days: 7 }],
  ['hk task create area 101', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'a'.repeat(101), frequency_days: 7 }],
  ['hk task create area emoji', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: EMOJI_70, frequency_days: 7 }],
  ['hk task create last shape', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y', frequency_days: 7, last_completed: '2026-11-18 10:00' }],
  ['hk task create last invalid day', 'POST', '/housekeeping/decay-tasks', { name: 'x', area: 'y', frequency_days: 7, last_completed: '2026-02-30T10:00' }],
  ['hk tasks', 'GET', '/housekeeping/decay-tasks', NO_BODY],
  ['hk task patch name', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', { name: 'Fenster innen' }],
  ['hk task patch frequency', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', { frequency_days: 14, last_completed: null }],
  ['hk task patch empty', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', {}],
  ['hk task patch no body', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', NO_BODY],
  ['hk task patch frequency zero', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', { frequency_days: 0 }],
  ['hk task patch frequency text', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', { frequency_days: '3' }],
  ['hk task patch frequency null', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', { frequency_days: null }],
  ['hk task patch name null', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', { name: null }],
  ['hk task patch area spaces', 'PATCH', '/housekeeping/decay-tasks/__FENSTER__', { area: '  ' }],
  ['hk task patch zero', 'PATCH', '/housekeeping/decay-tasks/0', { name: 'x' }],
  ['hk task patch unknown', 'PATCH', '/housekeeping/decay-tasks/999', { name: 'x' }],
  ['hk task patch letters', 'PATCH', '/housekeeping/decay-tasks/abc', { name: 'x' }],
  ['hk task complete', 'POST', '/housekeeping/decay-tasks/__BAD__/complete', NO_BODY],
  ['hk task complete zero', 'POST', '/housekeeping/decay-tasks/0/complete', NO_BODY],
  ['hk task complete unknown', 'POST', '/housekeeping/decay-tasks/999/complete', NO_BODY],
  ['hk task delete', 'DELETE', '/housekeeping/decay-tasks/__KELLER__', NO_BODY],
  ['hk task delete again', 'DELETE', '/housekeeping/decay-tasks/__KELLER__', NO_BODY],
  ['hk task delete zero', 'DELETE', '/housekeeping/decay-tasks/0', NO_BODY],
  ['hk tasks end', 'GET', '/housekeeping/decay-tasks', NO_BODY],

  // ── housekeeping: supplies, maintenance log ───────────────────────────────
  ['hk supply', 'POST', '/housekeeping/supply-requests', { name: ' Spuelmittel ', quantity: '2 Flaschen' }],
  ['hk supply quantity null', 'POST', '/housekeeping/supply-requests', { name: 'Schwamm', quantity: null }],
  ['hk supply name spaces', 'POST', '/housekeeping/supply-requests', { name: '  ' }],
  ['hk supply name number', 'POST', '/housekeeping/supply-requests', { name: 5 }],
  ['hk supply no body', 'POST', '/housekeeping/supply-requests', NO_BODY],
  ['hk supply token', 'POST', '/housekeeping/supply-requests', { name: 'x' }, { actor: 'token' }],
  ['hk supply no shopping', 'POST', '/housekeeping/supply-requests', { name: 7 }, { access: { shopping: 'read' } }],
  ['hk log empty', 'GET', '/housekeeping/maintenance-log', NO_BODY],
  ['hk log create', 'POST', '/housekeeping/maintenance-log', { description: ' Wasserhahn tropft ', photo_url: PNG }],
  ['hk log create photo null', 'POST', '/housekeeping/maintenance-log', { description: 'Lampe', photo_url: null }],
  ['hk log create photo empty', 'POST', '/housekeeping/maintenance-log', { description: 'Tuer', photo_url: '' }],
  ['hk log create photo number', 'POST', '/housekeeping/maintenance-log', { description: 'x', photo_url: 5 }],
  ['hk log create photo list', 'POST', '/housekeeping/maintenance-log', { description: 'x', photo_url: [PNG] }],
  ['hk log create photo text', 'POST', '/housekeeping/maintenance-log', { description: 'x', photo_url: 'abc' }],
  ['hk log create photo mismatch', 'POST', '/housekeeping/maintenance-log', { description: 'x', photo_url: PNG_LABEL_JPEG }],
  ['hk log create description spaces', 'POST', '/housekeeping/maintenance-log', { description: '   ' }],
  ['hk log create description missing', 'POST', '/housekeeping/maintenance-log', { photo_url: PNG }],
  ['hk log', 'GET', '/housekeeping/maintenance-log', NO_BODY],

  // ── rewards: participants ─────────────────────────────────────────────────
  ['rw overview empty', 'GET', '/rewards/overview', NO_BODY],
  ['rw participants', 'GET', '/rewards/participants', NO_BODY],
  ['rw participants member', 'GET', '/rewards/participants', NO_BODY, { actor: 'member' }],
  ['rw participant member', 'PUT', `/rewards/participants/${MEMBER}`, { enabled: true }, { actor: 'member' }],
  ['rw participant member malformed', 'PUT', `/rewards/participants/${MEMBER}`, { enabled: 'yes' }, { actor: 'member' }],
  ['rw participant enable', 'PUT', `/rewards/participants/${MEMBER}`, { enabled: true }],
  ['rw participant enable child', 'PUT', `/rewards/participants/${CHILD}`, { enabled: true }],
  ['rw participant enable admin', 'PUT', `/rewards/participants/${ADMIN}`, { enabled: true }],
  ['rw participant disable admin', 'PUT', `/rewards/participants/${ADMIN}`, { enabled: false }],
  ['rw participant enabled text', 'PUT', `/rewards/participants/${ADMIN}`, { enabled: 'true' }],
  ['rw participant enabled one', 'PUT', `/rewards/participants/${ADMIN}`, { enabled: 1 }],
  ['rw participant enabled null', 'PUT', `/rewards/participants/${ADMIN}`, { enabled: null }],
  ['rw participant empty', 'PUT', `/rewards/participants/${ADMIN}`, {}],
  ['rw participant no body', 'PUT', `/rewards/participants/${ADMIN}`, NO_BODY],
  ['rw participant unknown', 'PUT', '/rewards/participants/999', { enabled: true }],
  ['rw participant zero', 'PUT', '/rewards/participants/0', { enabled: true }],
  ['rw participant letters', 'PUT', '/rewards/participants/1.9', { enabled: true }],
  ['rw participant staff', 'PUT', '/rewards/participants/__MARIA_USER__', { enabled: true }],
  ['rw participant staff off', 'PUT', '/rewards/participants/__MARIA_USER__', { enabled: false }],
  ['rw participants after', 'GET', '/rewards/participants', NO_BODY],

  // ── rewards: catalog ──────────────────────────────────────────────────────
  ['rw catalog empty', 'GET', '/rewards/catalog', NO_BODY],
  ['rw catalog create member', 'POST', '/rewards/catalog', { name: 'Kino', cost: 50 }, { actor: 'member' }],
  ['rw catalog create', 'POST', '/rewards/catalog', { name: ' Kino ', cost: 50, icon: ' 🎬🎬🎬🎬🎬 ', description: ' Ein Film ', sort_order: 2 }],
  ['rw catalog create limited', 'POST', '/rewards/catalog', { name: 'Eis', cost: 10, quantity: 2 }],
  ['rw catalog create pricey', 'POST', '/rewards/catalog', { name: 'Fahrrad', cost: 1000000, quantity: null, icon: null, description: null }],
  ['rw catalog create switched off', 'POST', '/rewards/catalog', { name: 'Zoo', cost: 30 }],
  ['rw catalog create no body', 'POST', '/rewards/catalog', NO_BODY],
  ['rw catalog create name spaces', 'POST', '/rewards/catalog', { name: '   ', cost: 5 }],
  ['rw catalog create name missing', 'POST', '/rewards/catalog', { cost: 5 }],
  ['rw catalog create cost missing', 'POST', '/rewards/catalog', { name: 'x' }],
  ['rw catalog create cost zero', 'POST', '/rewards/catalog', { name: 'x', cost: 0 }],
  ['rw catalog create cost negative', 'POST', '/rewards/catalog', { name: 'x', cost: -5 }],
  ['rw catalog create cost over', 'POST', '/rewards/catalog', { name: 'x', cost: 1000001 }],
  ['rw catalog create cost text', 'POST', '/rewards/catalog', { name: 'x', cost: '5' }],
  ['rw catalog create cost fraction', 'POST', '/rewards/catalog', { name: 'x', cost: 1.5 }],
  ['rw catalog create cost null', 'POST', '/rewards/catalog', { name: 'x', cost: null }],
  ['rw catalog create quantity zero', 'POST', '/rewards/catalog', { name: 'x', cost: 5, quantity: 0 }],
  ['rw catalog create quantity over', 'POST', '/rewards/catalog', { name: 'x', cost: 5, quantity: 1000001 }],
  ['rw catalog create quantity empty', 'POST', '/rewards/catalog', { name: 'x', cost: 5, quantity: '' }],
  ['rw catalog create quantity text', 'POST', '/rewards/catalog', { name: 'x', cost: 5, quantity: '2' }],
  ['rw catalog create sort text', 'POST', '/rewards/catalog', { name: 'x', cost: 5, sort_order: '1' }],
  ['rw catalog create sort null', 'POST', '/rewards/catalog', { name: 'x', cost: 5, sort_order: null }],
  ['rw catalog create icon number', 'POST', '/rewards/catalog', { name: 'x', cost: 5, icon: 5 }],
  ['rw catalog patch', 'PATCH', '/rewards/catalog/__ZOO__', { is_active: false, icon: ' 🦁 ', description: '' }],
  ['rw catalog patch name', 'PATCH', '/rewards/catalog/__KINO__', { name: ' Kino gross ', cost: 60, sort_order: 1, quantity: 5 }],
  ['rw catalog patch keep', 'PATCH', '/rewards/catalog/__KINO__', { name: null, cost: null, quantity: null, icon: null, description: null }],
  ['rw catalog patch empty', 'PATCH', '/rewards/catalog/__KINO__', {}],
  ['rw catalog patch no body', 'PATCH', '/rewards/catalog/__KINO__', NO_BODY],
  ['rw catalog patch name spaces', 'PATCH', '/rewards/catalog/__KINO__', { name: '  ' }],
  ['rw catalog patch cost zero', 'PATCH', '/rewards/catalog/__KINO__', { cost: 0 }],
  ['rw catalog patch cost over', 'PATCH', '/rewards/catalog/__KINO__', { cost: 1000001 }],
  ['rw catalog patch cost text', 'PATCH', '/rewards/catalog/__KINO__', { cost: '60' }],
  ['rw catalog patch quantity zero', 'PATCH', '/rewards/catalog/__KINO__', { quantity: 0 }],
  ['rw catalog patch quantity empty', 'PATCH', '/rewards/catalog/__KINO__', { quantity: '' }],
  ['rw catalog patch active text', 'PATCH', '/rewards/catalog/__KINO__', { is_active: 'true' }],
  ['rw catalog patch active one', 'PATCH', '/rewards/catalog/__KINO__', { is_active: 1 }],
  ['rw catalog patch active null', 'PATCH', '/rewards/catalog/__KINO__', { is_active: null }],
  ['rw catalog patch sort null', 'PATCH', '/rewards/catalog/__KINO__', { sort_order: null }],
  ['rw catalog patch zero', 'PATCH', '/rewards/catalog/0', { name: 'x' }],
  ['rw catalog patch unknown', 'PATCH', '/rewards/catalog/999', { name: 'x' }],
  ['rw catalog patch letters', 'PATCH', '/rewards/catalog/1abc', { name: 'x' }],
  ['rw catalog patch member', 'PATCH', '/rewards/catalog/__KINO__', { cost: 'x' }, { actor: 'member' }],
  ['rw catalog', 'GET', '/rewards/catalog', NO_BODY],
  ['rw catalog all', 'GET', '/rewards/catalog?all=1', NO_BODY],
  ['rw catalog all member', 'GET', '/rewards/catalog?all=1', NO_BODY, { actor: 'member' }],
  ['rw catalog all zero', 'GET', '/rewards/catalog?all=0', NO_BODY],
  ['rw catalog all true', 'GET', '/rewards/catalog?all=true', NO_BODY],

  // ── rewards: bonus points ─────────────────────────────────────────────────
  ['rw bonus member', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: 5 }, { actor: 'member' }],
  ['rw bonus', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: 200, reason: ' Garten ' }],
  ['rw bonus digit text', 'POST', '/rewards/bonus', { user_id: String(CHILD), delta: 100, reason: 'r'.repeat(250) }],
  ['rw bonus correction', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: -20, reason: null }],
  ['rw bonus at bound', 'POST', '/rewards/bonus', { user_id: CHILD, delta: -1000000 }],
  ['rw bonus back', 'POST', '/rewards/bonus', { user_id: CHILD, delta: 1000000 }],
  ['rw bonus delta zero', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: 0 }],
  ['rw bonus delta over', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: 1000001 }],
  ['rw bonus delta under', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: -1000001 }],
  ['rw bonus delta text', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: '5' }],
  ['rw bonus delta fraction', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: 2.5 }],
  ['rw bonus delta missing', 'POST', '/rewards/bonus', { user_id: MEMBER }],
  ['rw bonus user missing', 'POST', '/rewards/bonus', { delta: 5 }],
  ['rw bonus user letters', 'POST', '/rewards/bonus', { user_id: 'abc', delta: 5 }],
  ['rw bonus user null', 'POST', '/rewards/bonus', { user_id: null, delta: 5 }],
  ['rw bonus user huge', 'POST', '/rewards/bonus', { user_id: HUGE_DIGITS, delta: 5 }],
  ['rw bonus user zero', 'POST', '/rewards/bonus', { user_id: 0, delta: 5 }],
  ['rw bonus not participating', 'POST', '/rewards/bonus', { user_id: ADMIN, delta: 5 }],
  ['rw bonus reason number', 'POST', '/rewards/bonus', { user_id: MEMBER, delta: 5, reason: 5 }],

  // ── rewards: redemptions ──────────────────────────────────────────────────
  ['rw redeem member', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__EIS__')), note: ' Bitte ' }), { actor: 'member' }],
  ['rw redeem member second', 'POST', '/rewards/redemptions', () => ({ catalog_id: resolved('__EIS__') }), { actor: 'member' }],
  ['rw redeem member third', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__KINO__')) }), { actor: 'member' }],
  ['rw redeem child', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__KINO__')), note: 'n'.repeat(600) }), { actor: 'child' }],
  ['rw redeem child for other', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__EIS__')), user_id: MEMBER }), { actor: 'child' }],
  ['rw redeem admin for child', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__EIS__')), user_id: CHILD }), { actor: 'admin' }],
  ['rw redeem admin self', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__EIS__')) })],
  ['rw redeem admin user huge', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__EIS__')), user_id: HUGE_DIGITS })],
  ['rw redeem admin user zero', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__EIS__')), user_id: 0 })],
  ['rw redeem insufficient', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__FAHRRAD__')) }), { actor: 'member' }],
  ['rw redeem switched off', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__ZOO__')) }), { actor: 'member' }],
  ['rw redeem unknown', 'POST', '/rewards/redemptions', { catalog_id: 999 }, { actor: 'member' }],
  ['rw redeem catalog missing', 'POST', '/rewards/redemptions', {}, { actor: 'member' }],
  ['rw redeem catalog letters', 'POST', '/rewards/redemptions', { catalog_id: 'x' }, { actor: 'member' }],
  ['rw redeem catalog null', 'POST', '/rewards/redemptions', { catalog_id: null }, { actor: 'member' }],
  ['rw redeem kind unknown', 'POST', '/rewards/redemptions', { kind: 'gift', catalog_id: 1 }, { actor: 'member' }],
  ['rw redeem kind null', 'POST', '/rewards/redemptions', { kind: null, catalog_id: 1 }, { actor: 'member' }],
  ['rw redeem kind number', 'POST', '/rewards/redemptions', { kind: 1, catalog_id: 1 }, { actor: 'member' }],
  ['rw redeem note number', 'POST', '/rewards/redemptions', { catalog_id: 1, note: 5 }, { actor: 'member' }],
  ['rw redeem no body', 'POST', '/rewards/redemptions', NO_BODY, { actor: 'member' }],
  ['rw redeem display no person', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__EIS__')) }), { actor: 'display' }],
  ['rw redeem display person', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__KINO__')), user_id: CHILD }), { actor: 'display' }],
  ['rw redeem money no account', 'POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00' }, { actor: 'member' }],
  ['rw redeem money display', 'POST', '/rewards/redemptions', { kind: 'deposit', amount: '1.00', user_id: CHILD }, { actor: 'display' }],

  // ── rewards: pocket money ─────────────────────────────────────────────────
  ['rw money empty', 'GET', '/rewards/money', NO_BODY],
  ['rw money account member', 'POST', '/rewards/money/accounts', { user_id: MEMBER }, { actor: 'member' }],
  ['rw money account no body', 'POST', '/rewards/money/accounts', NO_BODY],
  ['rw money account empty', 'POST', '/rewards/money/accounts', {}],
  ['rw money account unknown', 'POST', '/rewards/money/accounts', { user_id: 999 }],
  ['rw money account zero', 'POST', '/rewards/money/accounts', { user_id: 0 }],
  ['rw money account huge', 'POST', '/rewards/money/accounts', { user_id: HUGE_DIGITS }],
  ['rw money account letters', 'POST', '/rewards/money/accounts', { user_id: '1x' }],
  ['rw money account staff', 'POST', '/rewards/money/accounts', () => ({ user_id: Number(resolved('__MARIA_USER__')) })],
  ['rw money account currency', 'POST', '/rewards/money/accounts', { user_id: MEMBER, currency: 'JPY' }],
  ['rw money account', 'POST', '/rewards/money/accounts', { user_id: MEMBER, currency: null }],
  ['rw money account again', 'POST', '/rewards/money/accounts', { user_id: String(MEMBER) }],
  ['rw money entry member', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.00', direction: 'credit' }, { actor: 'member' }],
  ['rw money entry credit', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '20.00', direction: 'credit', reason: ' Oma ' }],
  ['rw money entry credit child', 'POST', '/rewards/money/entries', { user_id: String(CHILD), amount: '5', direction: 'credit' }],
  ['rw money entry debit', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '2.50', direction: 'debit', reason: null }],
  ['rw money entry debit too much', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '100.00', direction: 'debit' }],
  ['rw money entry direction unknown', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.00', direction: 'gift' }],
  ['rw money entry direction missing', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.00' }],
  ['rw money entry direction null', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.00', direction: null }],
  ['rw money entry amount number', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: 1, direction: 'credit' }],
  ['rw money entry amount letters', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: 'abc', direction: 'credit' }],
  ['rw money entry amount negative', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '-1.00', direction: 'credit' }],
  ['rw money entry amount too precise', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.001', direction: 'credit' }],
  ['rw money entry currency', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.00', direction: 'credit', currency: 'USD' }],
  ['rw money entry user huge', 'POST', '/rewards/money/entries', { user_id: HUGE_DIGITS, amount: '1.00', direction: 'credit' }],
  ['rw money entry user letters', 'POST', '/rewards/money/entries', { user_id: 'x', amount: '1.00', direction: 'credit' }],
  ['rw money entry staff', 'POST', '/rewards/money/entries', () => ({ user_id: Number(resolved('__MARIA_USER__')), amount: '1.00', direction: 'credit' })],
  ['rw money entry reason number', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.00', direction: 'credit', reason: 5 }],
  ['rw money entry too large', 'POST', '/rewards/money/entries', { user_id: MEMBER, amount: '99999999999.00', direction: 'credit' }],
  ['rw money ledger', 'GET', '/rewards/money/ledger', NO_BODY],
  ['rw money ledger member', 'GET', '/rewards/money/ledger', NO_BODY, { actor: 'member' }],
  ['rw money ledger child other', 'GET', `/rewards/money/ledger?user_id=${MEMBER}`, NO_BODY, { actor: 'child' }],
  ['rw money ledger user', 'GET', `/rewards/money/ledger?user_id=${CHILD}&limit=1`, NO_BODY],
  ['rw money ledger user zero', 'GET', '/rewards/money/ledger?user_id=0&limit=0', NO_BODY],
  ['rw money ledger limit negative', 'GET', '/rewards/money/ledger?limit=-5', NO_BODY],
  ['rw money ledger limit big', 'GET', '/rewards/money/ledger?limit=100000', NO_BODY],
  ['rw money ledger user letters', 'GET', '/rewards/money/ledger?user_id=abc', NO_BODY],
  ['rw money ledger limit fraction', 'GET', '/rewards/money/ledger?limit=1.5', NO_BODY],
  ['rw money ledger display', 'GET', '/rewards/money/ledger', NO_BODY, { actor: 'display' }],
  ['rw money request withdrawal', 'POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '3.00', note: ' Kino ' }, { actor: 'member' }],
  ['rw money request deposit', 'POST', '/rewards/redemptions', { kind: 'deposit', amount: '7.00', currency: 'EUR' }, { actor: 'member' }],
  ['rw money request deposit child', 'POST', '/rewards/redemptions', { kind: 'deposit', amount: '1' }, { actor: 'child' }],
  ['rw money request too much', 'POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '500.00' }, { actor: 'member' }],
  ['rw money request amount number', 'POST', '/rewards/redemptions', { kind: 'withdrawal', amount: 3 }, { actor: 'member' }],
  ['rw money request amount letters', 'POST', '/rewards/redemptions', { kind: 'withdrawal', amount: 'drei' }, { actor: 'member' }],
  ['rw money request currency', 'POST', '/rewards/redemptions', { kind: 'deposit', amount: '1.00', currency: 'CHF' }, { actor: 'member' }],
  ['rw money request admin for member', 'POST', '/rewards/redemptions', { kind: 'deposit', amount: '0.50', user_id: String(MEMBER) }],
  ['rw money request admin user huge', 'POST', '/rewards/redemptions', { kind: 'deposit', amount: '0.50', user_id: HUGE_DIGITS }],
  ['rw money request staff', 'POST', '/rewards/redemptions', () => ({ kind: 'deposit', amount: '0.50', user_id: Number(resolved('__MARIA_USER__')) })],

  // ── rewards: deciding requests ────────────────────────────────────────────
  ['rw decide fulfill', 'PATCH', '/rewards/redemptions/__R1__', { action: 'fulfill' }],
  ['rw decide reject', 'PATCH', '/rewards/redemptions/__R2__', { action: 'reject' }],
  ['rw decide cancel own', 'PATCH', '/rewards/redemptions/__R3__', { action: 'cancel' }, { actor: 'member' }],
  ['rw decide decided', 'PATCH', '/rewards/redemptions/__R1__', { action: 'reject' }],
  ['rw decide member fulfill', 'PATCH', '/rewards/redemptions/__R4__', { action: 'fulfill' }, { actor: 'member' }],
  ['rw decide member cancel foreign', 'PATCH', '/rewards/redemptions/__R4__', { action: 'cancel' }, { actor: 'member' }],
  ['rw decide action unknown', 'PATCH', '/rewards/redemptions/__R4__', { action: 'approve' }],
  ['rw decide action missing', 'PATCH', '/rewards/redemptions/__R4__', {}],
  ['rw decide action number', 'PATCH', '/rewards/redemptions/__R4__', { action: 1 }],
  ['rw decide no body', 'PATCH', '/rewards/redemptions/__R4__', NO_BODY],
  ['rw decide member unknown action', 'PATCH', '/rewards/redemptions/__R4__', { action: 'approve' }, { actor: 'member' }],
  ['rw decide zero', 'PATCH', '/rewards/redemptions/0', { action: 'fulfill' }],
  ['rw decide unknown', 'PATCH', '/rewards/redemptions/999', { action: 'fulfill' }],
  ['rw decide letters', 'PATCH', '/rewards/redemptions/0x10', { action: 'fulfill' }],
  ['rw decide money foreign', 'PATCH', '/rewards/redemptions/__MW__', { action: 'cancel' }, { actor: 'child' }],
  ['rw decide money withdrawal', 'PATCH', '/rewards/redemptions/__MW__', { action: 'fulfill' }],
  ['rw decide money deposit reject', 'PATCH', '/rewards/redemptions/__MD__', { action: 'reject' }],
  () => {
    // Decisions of SQLite's own clock, set to two minutes before the frozen one.
    db.prepare("UPDATE reward_redemptions SET decided_at = '2026-11-18T11:58:00Z' WHERE decided_at IS NOT NULL").run();
  },
  ['rw reopen member fulfilled', 'PATCH', '/rewards/redemptions/__R1__', { action: 'reopen' }, { actor: 'member' }],
  ['rw reopen own cancel', 'PATCH', '/rewards/redemptions/__R3__', { action: 'reopen' }, { actor: 'member' }],
  ['rw reopen pending', 'PATCH', '/rewards/redemptions/__R3__', { action: 'reopen' }],
  ['rw reopen money', 'PATCH', '/rewards/redemptions/__MD__', { action: 'reopen' }],
  ['rw cancel again', 'PATCH', '/rewards/redemptions/__R3__', { action: 'cancel' }, { actor: 'member' }],
  ['rw decide money deposit reject again', 'PATCH', '/rewards/redemptions/__MD__', { action: 'reject' }],
  ['rw decide fulfill last unit', 'PATCH', '/rewards/redemptions/__R5__', { action: 'fulfill' }],
  ['rw decide fulfill sold out', 'PATCH', '/rewards/redemptions/__R6__', { action: 'fulfill' }],
  ['rw redeem sold out', 'POST', '/rewards/redemptions', () => ({ catalog_id: Number(resolved('__EIS__')) }), { actor: 'member' }],

  // ── rewards: listing requests by status and kind ──────────────────────────
  ['rw redemptions', 'GET', '/rewards/redemptions', NO_BODY],
  ['rw redemptions pending', 'GET', '/rewards/redemptions?status=pending', NO_BODY],
  ['rw redemptions fulfilled', 'GET', '/rewards/redemptions?status=fulfilled', NO_BODY],
  ['rw redemptions rejected', 'GET', '/rewards/redemptions?status=rejected', NO_BODY],
  ['rw redemptions cancelled', 'GET', '/rewards/redemptions?status=cancelled', NO_BODY],
  ['rw redemptions kind reward', 'GET', '/rewards/redemptions?kind=reward', NO_BODY],
  ['rw redemptions kind money', 'GET', '/rewards/redemptions?kind=money', NO_BODY],
  ['rw redemptions kind all', 'GET', '/rewards/redemptions?kind=all', NO_BODY],
  ['rw redemptions kind withdrawal', 'GET', '/rewards/redemptions?kind=withdrawal', NO_BODY],
  ['rw redemptions kind deposit', 'GET', '/rewards/redemptions?kind=deposit', NO_BODY],
  ['rw redemptions kind all pending', 'GET', '/rewards/redemptions?kind=all&status=pending', NO_BODY],
  ['rw redemptions kind money rejected', 'GET', '/rewards/redemptions?kind=money&status=rejected', NO_BODY],
  ['rw redemptions member', 'GET', '/rewards/redemptions?kind=all', NO_BODY, { actor: 'member' }],
  ['rw redemptions child', 'GET', '/rewards/redemptions?kind=all', NO_BODY, { actor: 'child' }],
  ['rw redemptions display', 'GET', '/rewards/redemptions?kind=all', NO_BODY, { actor: 'display' }],
  ['rw redemptions status unknown', 'GET', '/rewards/redemptions?status=bogus', NO_BODY],
  ['rw redemptions status empty', 'GET', '/rewards/redemptions?status=', NO_BODY],
  ['rw redemptions status twice', 'GET', '/rewards/redemptions?status=pending&status=fulfilled', NO_BODY],
  ['rw redemptions kind unknown', 'GET', '/rewards/redemptions?kind=bogus', NO_BODY],
  ['rw redemptions kind empty', 'GET', '/rewards/redemptions?kind=', NO_BODY],
  ['rw redemptions kind proto', 'GET', '/rewards/redemptions?kind=__proto__', NO_BODY],
  ['rw redemptions kind constructor', 'GET', '/rewards/redemptions?kind=constructor', NO_BODY],

  // ── rewards: ledger, overview ─────────────────────────────────────────────
  ['rw ledger', 'GET', '/rewards/ledger', NO_BODY],
  ['rw ledger user', 'GET', `/rewards/ledger?user_id=${MEMBER}&limit=3`, NO_BODY],
  ['rw ledger user zero', 'GET', '/rewards/ledger?user_id=0&limit=2', NO_BODY],
  ['rw ledger limit zero', 'GET', '/rewards/ledger?limit=0', NO_BODY],
  ['rw ledger limit negative', 'GET', '/rewards/ledger?limit=-1', NO_BODY],
  ['rw ledger user letters', 'GET', '/rewards/ledger?user_id=x', NO_BODY],
  ['rw ledger user twice', 'GET', '/rewards/ledger?user_id=1&user_id=2', NO_BODY],
  ['rw ledger child', 'GET', '/rewards/ledger', NO_BODY, { actor: 'child' }],
  ['rw overview', 'GET', '/rewards/overview', NO_BODY],
  ['rw overview member', 'GET', '/rewards/overview', NO_BODY, { actor: 'member' }],
  ['rw overview display', 'GET', '/rewards/overview', NO_BODY, { actor: 'display' }],

  // ── rewards: plans ────────────────────────────────────────────────────────
  ['rw plan member', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 1 }, { actor: 'member' }],
  ['rw plan weekly', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 3 }],
  ['rw plan monthly', 'PUT', `/rewards/money/plans/${MEMBER}`, { amount: '10.00', frequency: 'monthly', anchor_day: 31, paused: true, currency: 'EUR' }],
  ['rw plan resume', 'PUT', `/rewards/money/plans/${MEMBER}`, { amount: '10.00', frequency: 'monthly', anchor_day: 18, paused: false }],
  ['rw plan weekly anchor 8', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 8 }],
  ['rw plan anchor zero', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 0 }],
  ['rw plan anchor 32', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'monthly', anchor_day: 32 }],
  ['rw plan anchor text', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'monthly', anchor_day: '3' }],
  ['rw plan frequency unknown', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'daily', anchor_day: 3 }],
  ['rw plan frequency missing', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', anchor_day: 3 }],
  ['rw plan paused text', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 3, paused: 'yes' }],
  ['rw plan paused null', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 3, paused: null }],
  ['rw plan amount letters', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: 'zwei', frequency: 'weekly', anchor_day: 3 }],
  ['rw plan amount number', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: 2, frequency: 'weekly', anchor_day: 3 }],
  ['rw plan currency', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: '2.00', frequency: 'weekly', anchor_day: 3, currency: 'USD' }],
  ['rw plan anchor 8 and amount', 'PUT', `/rewards/money/plans/${CHILD}`, { amount: 'x', frequency: 'weekly', anchor_day: 8 }],
  ['rw plan unknown', 'PUT', '/rewards/money/plans/999', { amount: '2.00', frequency: 'weekly', anchor_day: 3 }],
  ['rw plan zero', 'PUT', '/rewards/money/plans/0', { amount: '2.00', frequency: 'weekly', anchor_day: 3 }],
  ['rw plan staff', 'PUT', '/rewards/money/plans/__MARIA_USER__', { amount: '2.00', frequency: 'weekly', anchor_day: 3 }],
  ['rw plan no body', 'PUT', `/rewards/money/plans/${CHILD}`, NO_BODY],
  ['rw money', 'GET', '/rewards/money', NO_BODY],
  ['rw money member', 'GET', '/rewards/money', NO_BODY, { actor: 'member' }],
  ['rw money child', 'GET', '/rewards/money', NO_BODY, { actor: 'child' }],
  ['rw money display', 'GET', '/rewards/money', NO_BODY, { actor: 'display' }],
  ['rw plan delete member', 'DELETE', `/rewards/money/plans/${CHILD}`, NO_BODY, { actor: 'member' }],
  ['rw plan delete', 'DELETE', `/rewards/money/plans/${CHILD}`, NO_BODY],
  ['rw plan delete again', 'DELETE', `/rewards/money/plans/${CHILD}`, NO_BODY],
  ['rw plan delete zero', 'DELETE', '/rewards/money/plans/0', NO_BODY],
  ['rw plan delete letters', 'DELETE', '/rewards/money/plans/1e2', NO_BODY],
  ['rw account delete not empty', 'DELETE', `/rewards/money/accounts/${MEMBER}`, NO_BODY],
  ['rw money cancel child request', 'PATCH', '/rewards/redemptions/__MD2__', { action: 'cancel' }, { actor: 'child' }],
  ['rw money entry debit rest', 'POST', '/rewards/money/entries', { user_id: CHILD, amount: '7.00', direction: 'debit' }],
  ['rw account delete', 'DELETE', `/rewards/money/accounts/${CHILD}`, NO_BODY],
  ['rw account delete again', 'DELETE', `/rewards/money/accounts/${CHILD}`, NO_BODY],
  ['rw account delete zero', 'DELETE', '/rewards/money/accounts/0', NO_BODY],
  ['rw account delete member', 'DELETE', `/rewards/money/accounts/${CHILD}`, NO_BODY, { actor: 'member' }],

  // ── rewards: deletes at the end ───────────────────────────────────────────
  ['rw catalog delete member', 'DELETE', '/rewards/catalog/__ZOO__', NO_BODY, { actor: 'member' }],
  ['rw catalog delete', 'DELETE', '/rewards/catalog/__ZOO__', NO_BODY],
  ['rw catalog delete again', 'DELETE', '/rewards/catalog/__ZOO__', NO_BODY],
  ['rw catalog delete zero', 'DELETE', '/rewards/catalog/0', NO_BODY],
  ['rw catalog delete letters', 'DELETE', '/rewards/catalog/abc', NO_BODY],
  ['rw catalog end', 'GET', '/rewards/catalog?all=1', NO_BODY],
];

const workerId = (/** @type {string} */ name) => db.prepare(`
  SELECT hw.id FROM housekeeping_workers hw JOIN users u ON u.id = hw.user_id WHERE u.display_name = ?
`).get(name).id;
const visitId = (/** @type {number} */ n) => db.prepare('SELECT id FROM housekeeping_work_sessions ORDER BY id LIMIT 1 OFFSET ?').get(n).id;
const taskId = (/** @type {string} */ name) => db.prepare('SELECT id FROM housekeeping_decay_tasks WHERE name = ?').get(name).id;
const rewardId = (/** @type {string} */ name) => db.prepare('SELECT id FROM reward_catalog WHERE name = ?').get(name).id;
const redemptionId = (/** @type {string} */ kind, /** @type {number} */ n) => db.prepare(`
  SELECT id FROM reward_redemptions WHERE ${kind === 'reward' ? "kind = 'reward'" : 'kind = ?'} ORDER BY id LIMIT 1 OFFSET ?
`).get(...(kind === 'reward' ? [n] : [kind, n])).id;

/** Ids that exist only once their row ran, by placeholder. */
const PLACEHOLDERS = {
  __MARIA__: () => workerId('Maria'),
  __MARIA_USER__: () => db.prepare('SELECT user_id FROM housekeeping_workers WHERE id = ?').get(resolvedId('__MARIA__')).user_id,
  __PEDRO__: () => workerId('Pedro'),
  __ANA__: () => workerId('Ana'),
  __V1__: () => visitId(0),
  __V2__: () => visitId(1),
  __V3__: () => visitId(2),
  __FENSTER__: () => taskId('Fenster'),
  __BAD__: () => taskId('Bad'),
  __KELLER__: () => taskId('Keller'),
  __KINO__: () => rewardId('Kino'),
  __EIS__: () => rewardId('Eis'),
  __FAHRRAD__: () => rewardId('Fahrrad'),
  __ZOO__: () => rewardId('Zoo'),
  __R1__: () => redemptionId('reward', 0),
  __R2__: () => redemptionId('reward', 1),
  __R3__: () => redemptionId('reward', 2),
  __R4__: () => redemptionId('reward', 3),
  __R5__: () => redemptionId('reward', 4),
  __R6__: () => redemptionId('reward', 5),
  __MW__: () => redemptionId('withdrawal', 0),
  __MD__: () => redemptionId('deposit', 0),
  __MD2__: () => redemptionId('deposit', 1),
};

/** @type {Map<string, number | string>} */
const resolvedIds = new Map();

/** @param {string} key */
function resolvedId(key) {
  if (!resolvedIds.has(key)) resolvedIds.set(key, /** @type {Record<string, () => number | string>} */ (PLACEHOLDERS)[key]());
  return /** @type {number | string} */ (resolvedIds.get(key));
}

/** A path or value with its placeholders as ids, each read once and kept. @param {string} text */
function resolved(text) {
  return text.replace(/__[A-Z0-9_]+__/g, (key) => String(resolvedId(key)));
}

/** A body that is a function, called when its row runs. @param {unknown} body */
function resolvedBody(body) {
  return typeof body === 'function' ? body() : body;
}

// Written at a1aa36de9, before the refactor.
/** @type {Record<string, { status: number, body: unknown }>} */
const EXPECTED = {
  "hk dashboard empty": {"status":200,"body":{"data":{"worker":null,"workers":[],"current_session":null,"visits_this_month":0,"last_visit":null,"pending_tasks":0,"finished_tasks_this_month":0,"pending_payments":0,"paid_this_month":0,"monthly_payments":[{"month":"2026-06","total":0,"pending":0},{"month":"2026-07","total":0,"pending":0},{"month":"2026-08","total":0,"pending":0},{"month":"2026-09","total":0,"pending":0},{"month":"2026-10","total":0,"pending":0},{"month":"2026-11","total":0,"pending":0}]}}},
  "hk templates": {"status":200,"body":{"data":[{"key":"cleanBathrooms","name":"Clean bathrooms","area":"Bathrooms","frequency_days":7},{"key":"mopKitchenFloor","name":"Mop kitchen floor","area":"Kitchen","frequency_days":7},{"key":"dustLivingRoom","name":"Dust living room","area":"Living room","frequency_days":14},{"key":"changeBedLinens","name":"Change bed linens","area":"Bedrooms","frequency_days":14},{"key":"cleanRefrigerator","name":"Clean refrigerator","area":"Kitchen","frequency_days":30},{"key":"cleanWindows","name":"Clean windows","area":"Whole house","frequency_days":30},{"key":"deepCleanOven","name":"Deep clean oven","area":"Kitchen","frequency_days":60},{"key":"washOutdoor","name":"Wash balcony/patio","area":"Outdoor","frequency_days":30}]}},
  "hk worker empty": {"status":200,"body":{"data":null}},
  "hk workers empty": {"status":200,"body":{"data":[],"can_manage":true}},
  "hk workers member": {"status":200,"body":{"data":[],"can_manage":false}},
  "hk check-in no worker": {"status":400,"body":{"error":"Add a housekeeper before checking in.","code":400}},
  "hk worker create member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "hk worker create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "hk worker create empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/display_name","rule":"required"}]}},
  "hk worker create schedule unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/payment_schedule","rule":"enum"}]}},
  "hk worker create schedule false": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/payment_schedule","rule":"type"}]}},
  "hk worker create schedule zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/payment_schedule","rule":"type"}]}},
  "hk worker create rate type unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/rate_type","rule":"enum"}]}},
  "hk worker create rate type number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/rate_type","rule":"type"}]}},
  "hk worker create daily rate text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/daily_rate","rule":"type"}]}},
  "hk worker create daily rate null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/daily_rate","rule":"type"}]}},
  "hk worker create daily rate missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/daily_rate","rule":"required"}]}},
  "hk worker create daily rate negative": {"status":400,"body":{"error":"daily_rate must be greater than or equal to zero.","code":400}},
  "hk worker create hourly rate text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/hourly_rate","rule":"type"}]}},
  "hk worker create hourly rate negative": {"status":400,"body":{"error":"hourly_rate must be greater than or equal to zero.","code":400}},
  "hk worker create name spaces": {"status":400,"body":{"error":"display_name must not be empty.","code":400}},
  "hk worker create name empty": {"status":400,"body":{"error":"display_name is required.","code":400}},
  "hk worker create name 129": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/display_name","rule":"maxLength"}]}},
  "hk worker create name emoji": {"status":400,"body":{"error":"display_name may be at most 128 characters long.","code":400}},
  "hk worker create username spaces": {"status":400,"body":{"error":"Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.","code":400,"reason":"housekeeping_username_invalid"}},
  "hk worker create username blank inside": {"status":400,"body":{"error":"Username must be 3-64 characters long and may only contain letters, numbers, dots, hyphens, and underscores.","code":400,"reason":"housekeeping_username_invalid"}},
  "hk worker create username number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/username","rule":"type"}]}},
  "hk worker create birth day invalid": {"status":400,"body":{"error":"birth_date must be a valid calendar date.","code":400}},
  "hk worker create birth day shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/birth_date","rule":"pattern"}]}},
  "hk worker create year unknown number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/birth_year_unknown","rule":"type"}]}},
  "hk worker create calendar color": {"status":400,"body":{"error":"calendar_color must be a valid HEX color (#RRGGBB).","code":400}},
  "hk worker create avatar color": {"status":400,"body":{"error":"avatar_color must be a valid HEX color (#RRGGBB).","code":400}},
  "hk worker create avatar text": {"status":400,"body":{"error":"Avatar image must be PNG, JPEG, or WebP.","code":400}},
  "hk worker create avatar number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/avatar_data","rule":"type"}]}},
  "hk worker create notes 5001": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/notes","rule":"maxLength"}]}},
  "hk worker create id zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "hk worker create id negative": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "hk worker create id unknown": {"status":404,"body":{"error":"Housekeeper not found.","code":404,"reason":"housekeeping_worker_not_found"}},
  "hk worker create id empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/id","rule":"type"},{"path":"body/id","rule":"pattern"},{"path":"body/id","rule":"anyOf"}]}},
  "hk worker create id letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/id","rule":"type"},{"path":"body/id","rule":"pattern"},{"path":"body/id","rule":"anyOf"}]}},
  "hk worker create": {"status":201,"body":{"data":{"id":1,"user_id":5,"username":"maria","display_name":"Maria","avatar_color":"#0F766E","avatar_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","phone":"+49 30 1234","email":"maria@example.org","birth_date":"1980-05-04","birth_year_unknown":false,"daily_rate":60,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#1D4ED8","current_session":null,"today_session":null,"notes":"Dienstags","created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk worker create username taken": {"status":409,"body":{"error":"Username is already taken.","code":409,"reason":"housekeeping_username_taken"}},
  "hk worker create hourly": {"status":201,"body":{"data":{"id":2,"user_id":6,"username":"housekeeper_6","display_name":"Pedro","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":0,"rate_type":"hourly","hourly_rate":20,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk worker create defaults empty": {"status":201,"body":{"data":{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":50,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk worker update": {"status":200,"body":{"data":{"id":1,"user_id":5,"username":"maria","display_name":"Maria","avatar_color":"#0F766E","avatar_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","phone":"+49 30 1234","email":"maria@example.org","birth_date":"2000-02-29","birth_year_unknown":true,"daily_rate":60,"rate_type":"daily","hourly_rate":0,"payment_schedule":"twice_monthly","calendar_color":"#1D4ED8","current_session":null,"today_session":null,"notes":"Dienstags","created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk worker update digit text": {"status":200,"body":{"data":{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk worker update schedule unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/payment_schedule","rule":"enum"}]}},
  "hk worker get": {"status":200,"body":{"data":{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk worker get child": {"status":200,"body":{"data":{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":null,"rate_type":"daily","hourly_rate":null,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk worker get timezone": {"status":200,"body":{"data":{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk worker get local date shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/local_date","rule":"pattern"}]}},
  "hk worker get offset fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/timezone_offset_minutes","rule":"type"}]}},
  "hk workers": {"status":200,"body":{"data":[{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"user_id":5,"username":"maria","display_name":"Maria","avatar_color":"#0F766E","avatar_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","phone":"+49 30 1234","email":"maria@example.org","birth_date":"2000-02-29","birth_year_unknown":true,"daily_rate":60,"rate_type":"daily","hourly_rate":0,"payment_schedule":"twice_monthly","calendar_color":"#1D4ED8","current_session":null,"today_session":null,"notes":"Dienstags","created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"user_id":6,"username":"housekeeper_6","display_name":"Pedro","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":0,"rate_type":"hourly","hourly_rate":20,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}],"can_manage":true}},
  "hk workers token": {"status":200,"body":{"data":[{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"user_id":5,"username":"maria","display_name":"Maria","avatar_color":"#0F766E","avatar_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","phone":"+49 30 1234","email":"maria@example.org","birth_date":"2000-02-29","birth_year_unknown":true,"daily_rate":60,"rate_type":"daily","hourly_rate":0,"payment_schedule":"twice_monthly","calendar_color":"#1D4ED8","current_session":null,"today_session":null,"notes":"Dienstags","created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"user_id":6,"username":"housekeeper_6","display_name":"Pedro","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":0,"rate_type":"hourly","hourly_rate":20,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":null,"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}],"can_manage":true}},
  "hk check-in no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "hk check-in worker zero": {"status":400,"body":{"error":"worker_id must be a positive number.","code":400}},
  "hk check-in worker negative": {"status":400,"body":{"error":"worker_id must be a positive number.","code":400}},
  "hk check-in worker unknown": {"status":404,"body":{"error":"Housekeeper not found.","code":404,"reason":"housekeeping_worker_not_found"}},
  "hk check-in worker letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/worker_id","rule":"type"},{"path":"body/worker_id","rule":"pattern"},{"path":"body/worker_id","rule":"anyOf"}]}},
  "hk check-in rate missing": {"status":400,"body":{"error":"daily_rate is required.","code":400}},
  "hk check-in rate text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/daily_rate","rule":"type"}]}},
  "hk check-in rate negative": {"status":400,"body":{"error":"Amounts must be greater than or equal to zero.","code":400}},
  "hk check-in extras negative": {"status":400,"body":{"error":"Amounts must be greater than or equal to zero.","code":400}},
  "hk check-in extras text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/extras","rule":"type"}]}},
  "hk check-in title spaces long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/payment_title","rule":"maxLength"}]}},
  "hk check-in title 201": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/event_title","rule":"maxLength"}]}},
  "hk check-in description emoji": {"status":400,"body":{"error":"payment_description may be at most 5000 characters long.","code":400}},
  "hk check-in": {"status":201,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":60,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":1,"daily_total":60,"extras_total":0,"total_amount":60}}},
  "hk check-in again": {"status":409,"body":{"error":"This housekeeper is already checked in.","code":409,"reason":"housekeeping_already_checked_in"}},
  "hk check-out worker zero": {"status":400,"body":{"error":"worker_id must be a positive number.","code":400}},
  "hk check-out worker letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/worker_id","rule":"type"},{"path":"body/worker_id","rule":"pattern"},{"path":"body/worker_id","rule":"anyOf"}]}},
  "hk check-out none open": {"status":404,"body":{"error":"No open work session found.","code":404,"reason":"housekeeping_open_session_not_found"}},
  "hk check-out extras text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/extras","rule":"type"}]}},
  "hk check-out extras negative": {"status":400,"body":{"error":"Extras must be greater than or equal to zero.","code":400}},
  "hk check-out": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":60,"extras":10,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":1,"daily_total":60,"extras_total":10,"total_amount":70}}},
  "hk reopen": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":60,"extras":10,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":1,"daily_total":60,"extras_total":10,"total_amount":70}}},
  "hk reopen still open": {"status":409,"body":{"error":"This visit is still open.","code":409,"reason":"housekeeping_visit_open"}},
  "hk reopen zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "hk reopen unknown": {"status":404,"body":{"error":"Visit not found.","code":404,"reason":"housekeeping_visit_not_found"}},
  "hk reopen letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "hk check-out keeps extras": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":60,"extras":10,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":1,"daily_total":60,"extras_total":10,"total_amount":70}}},
  "hk check-in child": {"status":201,"body":{"data":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":null,"minutes_worked":null},"summary":{"month":"2026-11","session_count":2,"daily_total":null,"extras_total":null,"total_amount":null}}},
  "hk check-in child rate text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/daily_rate","rule":"type"}]}},
  "hk check-out child": {"status":200,"body":{"data":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":null,"minutes_worked":0},"summary":{"month":"2026-11","session_count":2,"daily_total":null,"extras_total":null,"total_amount":null}}},
  "hk check-in day context": {"status":201,"body":{"data":{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":3,"daily_total":130,"extras_total":10,"total_amount":140}}},
  "hk reopen other open": {"status":409,"body":{"error":"This housekeeper is already checked in.","code":409,"reason":"housekeeping_already_checked_in"}},
  "hk check-out third": {"status":200,"body":{"data":{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":3,"daily_total":130,"extras_total":10,"total_amount":140}}},
  "hk check-in ana": {"status":201,"body":{"data":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":180,"extras_total":10,"total_amount":190}}},
  "hk summary": {"status":200,"body":{"data":{"current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"default_daily_rate":55,"summary":{"month":"2026-11","session_count":4,"daily_total":180,"extras_total":10,"total_amount":190}}}},
  "hk summary child": {"status":200,"body":{"data":{"current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},"default_daily_rate":null,"summary":{"month":"2026-11","session_count":4,"daily_total":null,"extras_total":null,"total_amount":null}}}},
  "hk summary month": {"status":200,"body":{"data":{"current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"default_daily_rate":55,"summary":{"month":"2026-11","session_count":4,"daily_total":180,"extras_total":10,"total_amount":190}}}},
  "hk summary month empty": {"status":200,"body":{"data":{"current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"default_daily_rate":55,"summary":{"month":"2026-11","session_count":4,"daily_total":180,"extras_total":10,"total_amount":190}}}},
  "hk summary month other": {"status":200,"body":{"data":{"current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"default_daily_rate":55,"summary":{"month":"2026-10","session_count":0,"daily_total":0,"extras_total":0,"total_amount":0}}}},
  "hk summary month 13": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/month","rule":"pattern"}]}},
  "hk summary month short": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/month","rule":"pattern"}]}},
  "hk summary month twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/month","rule":"type"}]}},
  "hk summary month year 1000": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/month","rule":"pattern"}]}},
  "hk summary month year 1001": {"status":200,"body":{"data":{"current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"default_daily_rate":55,"summary":{"month":"1001-01","session_count":0,"daily_total":0,"extras_total":0,"total_amount":0}}}},
  "hk summary month letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/month","rule":"pattern"}]}},
  "hk work-sessions": {"status":200,"body":{"data":[{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":0},{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":60,"extras":10,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null}]}},
  "hk work-sessions child": {"status":200,"body":{"data":[{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":null,"minutes_worked":0},{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null}]}},
  "hk work-sessions month 00": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/month","rule":"pattern"}]}},
  "hk work-sessions month other": {"status":200,"body":{"data":[]}},
  "hk work-sessions month 0999": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/month","rule":"pattern"}]}},
  "hk visits": {"status":200,"body":{"data":{"month":"2026-11","visits":[{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Ana","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"open","payment_task_title":"Pay Ana for housekeeping","receipt_document_name":null,"total_amount":50,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Pay Maria for housekeeping","receipt_document_name":null,"total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":0,"worker_name":"Pedro","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"open","payment_task_title":"Pay Pedro for housekeeping","receipt_document_name":null,"total_amount":0,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":60,"extras":10,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Lohn","receipt_document_name":null,"total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false}],"totals":{"total":190,"paid":0,"pending":190}}}},
  "hk visits member": {"status":200,"body":{"data":{"month":"2026-11","visits":[{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Ana","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"open","payment_task_title":"Pay Ana for housekeeping","receipt_document_name":null,"total_amount":50,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Pay Maria for housekeeping","receipt_document_name":null,"total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":0,"worker_name":"Pedro","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"open","payment_task_title":"Pay Pedro for housekeeping","receipt_document_name":null,"total_amount":0,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":60,"extras":10,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Lohn","receipt_document_name":null,"total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false}],"totals":{"total":190,"paid":0,"pending":190}}}},
  "hk visits child": {"status":200,"body":{"data":{"month":"2026-11","visits":[{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null,"worker_name":"Ana","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":null,"payment_task_title":null,"receipt_document_name":null,"total_amount":null,"can_edit":false,"can_delete":false,"can_mark_paid":false,"can_mark_unpaid":false},{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":null,"payment_task_title":null,"receipt_document_name":null,"total_amount":null,"can_edit":false,"can_delete":false,"can_mark_paid":false,"can_mark_unpaid":false},{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":null,"minutes_worked":0,"worker_name":"Pedro","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":null,"payment_task_title":null,"receipt_document_name":null,"total_amount":null,"can_edit":false,"can_delete":false,"can_mark_paid":false,"can_mark_unpaid":false},{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":null,"payment_task_title":null,"receipt_document_name":null,"total_amount":null,"can_edit":false,"can_delete":false,"can_mark_paid":false,"can_mark_unpaid":false}],"totals":null}}},
  "hk visits no documents": {"status":200,"body":{"data":{"month":"2026-11","visits":[{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":null,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Ana","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"open","payment_task_title":"Pay Ana for housekeeping","receipt_document_name":null,"total_amount":50,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":null,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Pay Maria for housekeeping","receipt_document_name":null,"total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":null,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":0,"worker_name":"Pedro","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"open","payment_task_title":"Pay Pedro for housekeeping","receipt_document_name":null,"total_amount":0,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":null,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":60,"extras":10,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Lohn","receipt_document_name":null,"total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false}],"totals":{"total":190,"paid":0,"pending":190}}}},
  "hk visits worker": {"status":200,"body":{"data":{"month":"2026-11","visits":[{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":0,"worker_name":"Pedro","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"open","payment_task_title":"Pay Pedro for housekeeping","receipt_document_name":null,"total_amount":0,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false}],"totals":{"total":0,"paid":0,"pending":0}}}},
  "hk visits worker unknown": {"status":200,"body":{"data":{"month":"2026-11","visits":[],"totals":{"total":0,"paid":0,"pending":0}}}},
  "hk visits worker zero": {"status":400,"body":{"error":"worker_id must be a positive number.","code":400}},
  "hk visits worker negative": {"status":400,"body":{"error":"worker_id must be a positive number.","code":400}},
  "hk visits worker empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/worker_id","rule":"type"}]}},
  "hk visits worker letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/worker_id","rule":"type"}]}},
  "hk visits month 13": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/month","rule":"pattern"}]}},
  "hk visits month other": {"status":200,"body":{"data":{"month":"2026-12","visits":[],"totals":{"total":0,"paid":0,"pending":0}}}},
  "hk dashboard": {"status":200,"body":{"data":{"worker":{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"today_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"},"workers":[{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"today_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"user_id":5,"username":"maria","display_name":"Maria","avatar_color":"#0F766E","avatar_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","phone":"+49 30 1234","email":"maria@example.org","birth_date":"2000-02-29","birth_year_unknown":true,"daily_rate":60,"rate_type":"daily","hourly_rate":0,"payment_schedule":"twice_monthly","calendar_color":"#1D4ED8","current_session":null,"today_session":{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"notes":"Dienstags","created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"user_id":6,"username":"housekeeper_6","display_name":"Pedro","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":0,"rate_type":"hourly","hourly_rate":20,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":0},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}],"current_session":null,"visits_this_month":4,"last_visit":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"pending_tasks":0,"finished_tasks_this_month":0,"pending_payments":190,"paid_this_month":0,"monthly_payments":[{"month":"2026-06","total":0,"pending":0},{"month":"2026-07","total":0,"pending":0},{"month":"2026-08","total":0,"pending":0},{"month":"2026-09","total":0,"pending":0},{"month":"2026-10","total":0,"pending":0},{"month":"2026-11","total":190,"pending":190}]}}},
  "hk dashboard child": {"status":200,"body":{"data":{"worker":{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":null,"rate_type":"daily","hourly_rate":null,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},"today_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"},"workers":[{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":null,"rate_type":"daily","hourly_rate":null,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},"today_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"user_id":5,"username":"maria","display_name":"Maria","avatar_color":"#0F766E","avatar_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","phone":"+49 30 1234","email":"maria@example.org","birth_date":"2000-02-29","birth_year_unknown":true,"daily_rate":null,"rate_type":"daily","hourly_rate":null,"payment_schedule":"twice_monthly","calendar_color":"#1D4ED8","current_session":null,"today_session":{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},"notes":"Dienstags","created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"user_id":6,"username":"housekeeper_6","display_name":"Pedro","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":null,"rate_type":"hourly","hourly_rate":null,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":null,"minutes_worked":0},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}],"current_session":null,"visits_this_month":4,"last_visit":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},"pending_tasks":0,"finished_tasks_this_month":0,"pending_payments":null,"paid_this_month":null,"monthly_payments":null}}},
  "hk dashboard timezone": {"status":200,"body":{"data":{"worker":{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"today_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"},"workers":[{"id":3,"user_id":7,"username":"housekeeper_7","display_name":"Ana","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":55,"rate_type":"daily","hourly_rate":0,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"today_session":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"user_id":5,"username":"maria","display_name":"Maria","avatar_color":"#0F766E","avatar_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","phone":"+49 30 1234","email":"maria@example.org","birth_date":"2000-02-29","birth_year_unknown":true,"daily_rate":60,"rate_type":"daily","hourly_rate":0,"payment_schedule":"twice_monthly","calendar_color":"#1D4ED8","current_session":null,"today_session":{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"notes":"Dienstags","created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"user_id":6,"username":"housekeeper_6","display_name":"Pedro","avatar_color":"#0891B2","avatar_data":null,"phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"daily_rate":0,"rate_type":"hourly","hourly_rate":20,"payment_schedule":"monthly","calendar_color":"#0891B2","current_session":null,"today_session":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":0},"notes":null,"created_at":"<volatile>","updated_at":"<volatile>"}],"current_session":null,"visits_this_month":4,"last_visit":{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"pending_tasks":0,"finished_tasks_this_month":0,"pending_payments":190,"paid_this_month":0,"monthly_payments":[{"month":"2026-06","total":0,"pending":0},{"month":"2026-07","total":0,"pending":0},{"month":"2026-08","total":0,"pending":0},{"month":"2026-09","total":0,"pending":0},{"month":"2026-10","total":0,"pending":0},{"month":"2026-11","total":190,"pending":190}]}}},
  "hk visit get": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":60,"extras":10,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Lohn","receipt_document_name":null,"total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false}}},
  "hk visit get child": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":null,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":null,"payment_task_title":null,"receipt_document_name":null,"total_amount":null,"can_edit":false,"can_delete":false,"can_mark_paid":false,"can_mark_unpaid":false}}},
  "hk visit get zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "hk visit get unknown": {"status":404,"body":{"error":"Visit not found.","code":404,"reason":"housekeeping_visit_not_found"}},
  "hk visit get letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "hk visit put no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "hk visit put empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/date","rule":"required"}]}},
  "hk visit put day invalid": {"status":400,"body":{"error":"date must be a valid calendar date.","code":400}},
  "hk visit put day shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/date","rule":"pattern"}]}},
  "hk visit put original invalid": {"status":400,"body":{"error":"original_date must be a valid calendar date.","code":400}},
  "hk visit put rate missing": {"status":400,"body":{"error":"daily_rate is required.","code":400}},
  "hk visit put rate null": {"status":400,"body":{"error":"daily_rate is required.","code":400}},
  "hk visit put rate text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/daily_rate","rule":"type"}]}},
  "hk visit put rate negative": {"status":400,"body":{"error":"Amounts must be greater than or equal to zero.","code":400}},
  "hk visit put extras negative": {"status":400,"body":{"error":"Amounts must be greater than or equal to zero.","code":400}},
  "hk visit put minutes on daily": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk visit put receipt zero": {"status":400,"body":{"error":"receipt_document_id must be a positive number.","code":400}},
  "hk visit put receipt negative": {"status":400,"body":{"error":"receipt_document_id must be a positive number.","code":400}},
  "hk visit put receipt letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/receipt_document_id","rule":"type"},{"path":"body/receipt_document_id","rule":"pattern"},{"path":"body/receipt_document_id","rule":"const"},{"path":"body/receipt_document_id","rule":"anyOf"}]}},
  "hk visit put receipt no documents": {"status":403,"body":{"error":"Linking a document requires access to documents.","code":403,"reason":"cross_module_access"}},
  "hk visit put receipt unknown": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk visit put title emoji": {"status":400,"body":{"error":"payment_title may be at most 200 characters long.","code":400}},
  "hk visit put": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk visit put receipt digit text": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk visit put move day": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-16T12:00:00.000Z","check_out":"2026-11-16T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk visit put receipt hidden keep": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":null,"has_receipt":null,"check_in":"2026-11-16T12:00:00.000Z","check_out":"2026-11-16T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk visit put receipt hidden change": {"status":403,"body":{"error":"You cannot change a receipt you may not see.","code":403}},
  "hk visit put child": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":null,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-17T12:00:00.000Z","check_out":"2026-11-17T12:00:00.000Z","daily_rate":null,"extras":null,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":null,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":null,"extras_total":null,"total_amount":null}}},
  "hk visit put child rate text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/daily_rate","rule":"type"}]}},
  "hk visit put hourly minutes": {"status":200,"body":{"data":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":30,"extras":2,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":90},"summary":{"month":"2026-11","session_count":4,"daily_total":215,"extras_total":7,"total_amount":222}}},
  "hk visit put hourly minutes fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/minutes_worked","rule":"type"}]}},
  "hk visit put hourly minutes text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/minutes_worked","rule":"type"}]}},
  "hk visit put hourly minutes null": {"status":200,"body":{"data":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":30,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":90},"summary":{"month":"2026-11","session_count":4,"daily_total":215,"extras_total":5,"total_amount":220}}},
  "hk visit put hourly minutes negative": {"status":200,"body":{"data":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":-30},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk visit put zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "hk visit put unknown": {"status":404,"body":{"error":"Visit not found.","code":404,"reason":"housekeeping_visit_not_found"}},
  "hk pay child": {"status":403,"body":{"error":"Payments need permission to see housekeeping amounts.","code":403,"reason":"amounts_hidden"}},
  "hk pay zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "hk pay unknown": {"status":404,"body":{"error":"Visit not found.","code":404,"reason":"housekeeping_visit_not_found"}},
  "hk pay": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-17T12:00:00.000Z","check_out":"2026-11-17T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":"2026-11-18T12:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk visit get paid member": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-17T12:00:00.000Z","check_out":"2026-11-17T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":"2026-11-18T12:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"done","payment_task_title":"Lohn Maria","receipt_document_name":"Quittung","total_amount":70,"can_edit":false,"can_delete":false,"can_mark_paid":false,"can_mark_unpaid":false}}},
  "hk visit put paid member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "hk visit put paid member malformed": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/daily_rate","rule":"type"}]}},
  "hk pay paid member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "hk visit delete paid member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "hk unpay member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "hk unpay zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "hk unpay unknown": {"status":404,"body":{"error":"Visit not found.","code":404,"reason":"housekeeping_visit_not_found"}},
  "hk unpay": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-17T12:00:00.000Z","check_out":"2026-11-17T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk unpay unpaid": {"status":200,"body":{"data":{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-17T12:00:00.000Z","check_out":"2026-11-17T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk pay member": {"status":200,"body":{"data":{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":"2026-11-18T12:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":-30},"summary":{"month":"2026-11","session_count":4,"daily_total":185,"extras_total":5,"total_amount":190}}},
  "hk reopen paid": {"status":409,"body":{"error":"This check-out can no longer be taken back.","code":409,"reason":"housekeeping_reopen_expired"}},
  "hk visits after pay": {"status":200,"body":{"data":{"month":"2026-11","visits":[{"id":4,"worker_id":3,"calendar_event_id":5,"payment_task_id":4,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":null,"daily_rate":50,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Ana","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"open","payment_task_title":"Pay Ana for housekeeping","receipt_document_name":null,"total_amount":50,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":3,"worker_id":1,"calendar_event_id":4,"payment_task_id":3,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":70,"extras":0,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Pay Maria for housekeeping","receipt_document_name":null,"total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false},{"id":2,"worker_id":2,"calendar_event_id":3,"payment_task_id":2,"receipt_document_id":null,"has_receipt":false,"check_in":"2026-11-18T12:00:00.000Z","check_out":"2026-11-18T12:00:00.000Z","daily_rate":0,"extras":0,"paid_at":"2026-11-18T12:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>","rate_type":"hourly","hourly_rate":20,"minutes_worked":-30,"worker_name":"Pedro","worker_avatar_color":"#0891B2","worker_avatar_data":null,"payment_schedule":"monthly","payment_task_status":"done","payment_task_title":"Pay Pedro for housekeeping","receipt_document_name":null,"total_amount":0,"can_edit":true,"can_delete":true,"can_mark_paid":false,"can_mark_unpaid":true},{"id":1,"worker_id":1,"calendar_event_id":2,"payment_task_id":1,"receipt_document_id":1,"has_receipt":true,"check_in":"2026-11-17T12:00:00.000Z","check_out":"2026-11-17T12:00:00.000Z","daily_rate":65,"extras":5,"paid_at":null,"created_at":"<volatile>","updated_at":"<volatile>","rate_type":"daily","hourly_rate":0,"minutes_worked":null,"worker_name":"Maria","worker_avatar_color":"#0F766E","worker_avatar_data":"/api/v1/people/5/avatar?v=<volatile>","payment_schedule":"twice_monthly","payment_task_status":"open","payment_task_title":"Lohn Maria","receipt_document_name":"Quittung","total_amount":70,"can_edit":true,"can_delete":true,"can_mark_paid":true,"can_mark_unpaid":false}],"totals":{"total":190,"paid":0,"pending":190}}}},
  "hk visit delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "hk visit delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "hk visit delete": {"status":200,"body":{"data":{"summary":{"month":"2026-11","session_count":3,"daily_total":115,"extras_total":5,"total_amount":120}}}},
  "hk visit delete again": {"status":404,"body":{"error":"Visit not found.","code":404,"reason":"housekeeping_visit_not_found"}},
  "hk tasks empty": {"status":200,"body":{"data":[]}},
  "hk task create": {"status":201,"body":{"data":{"id":1,"name":"Fenster","area":"Haus","frequency_days":30,"last_completed":"2026-11-01T09:00:00.000Z","urgency":0.571,"urgency_status":"ok","due_date":"2026-12-01T09:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk task create no last": {"status":201,"body":{"data":{"id":2,"name":"Bad","area":"Bad","frequency_days":7,"last_completed":null,"urgency":null,"urgency_status":"overdue","due_date":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk task create wall clock": {"status":201,"body":{"data":{"id":3,"name":"Ofen","area":"Kueche","frequency_days":1,"last_completed":"2026-11-17T08:00","urgency":1.208,"urgency_status":"today","due_date":"2026-11-18T07:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk task create last empty": {"status":201,"body":{"data":{"id":4,"name":"Keller","area":"Keller","frequency_days":60,"last_completed":null,"urgency":null,"urgency_status":"overdue","due_date":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk task create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "hk task create frequency missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"required"}]}},
  "hk task create frequency zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"minimum"}]}},
  "hk task create frequency negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"minimum"}]}},
  "hk task create frequency fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"type"}]}},
  "hk task create frequency text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"type"}]}},
  "hk task create frequency null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"type"}]}},
  "hk task create frequency true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"type"}]}},
  "hk task create name spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "hk task create area 101": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/area","rule":"maxLength"}]}},
  "hk task create area emoji": {"status":400,"body":{"error":"area may be at most 100 characters long.","code":400}},
  "hk task create last shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/last_completed","rule":"pattern"}]}},
  "hk task create last invalid day": {"status":201,"body":{"data":{"id":5,"name":"x","area":"y","frequency_days":7,"last_completed":"2026-02-30T10:00","urgency":37.304,"urgency_status":"overdue","due_date":"2026-03-09T09:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk tasks": {"status":200,"body":{"data":[{"id":2,"name":"Bad","area":"Bad","frequency_days":7,"last_completed":null,"urgency":null,"urgency_status":"overdue","due_date":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"name":"Keller","area":"Keller","frequency_days":60,"last_completed":null,"urgency":null,"urgency_status":"overdue","due_date":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":5,"name":"x","area":"y","frequency_days":7,"last_completed":"2026-02-30T10:00","urgency":37.304,"urgency_status":"overdue","due_date":"2026-03-09T09:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"name":"Ofen","area":"Kueche","frequency_days":1,"last_completed":"2026-11-17T08:00","urgency":1.208,"urgency_status":"today","due_date":"2026-11-18T07:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"name":"Fenster","area":"Haus","frequency_days":30,"last_completed":"2026-11-01T09:00:00.000Z","urgency":0.571,"urgency_status":"ok","due_date":"2026-12-01T09:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "hk task patch name": {"status":200,"body":{"data":{"id":1,"name":"Fenster innen","area":"Haus","frequency_days":30,"last_completed":"2026-11-01T09:00:00.000Z","urgency":0.571,"urgency_status":"ok","due_date":"2026-12-01T09:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk task patch frequency": {"status":200,"body":{"data":{"id":1,"name":"Fenster innen","area":"Haus","frequency_days":14,"last_completed":null,"urgency":null,"urgency_status":"overdue","due_date":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk task patch empty": {"status":200,"body":{"data":{"id":1,"name":"Fenster innen","area":"Haus","frequency_days":14,"last_completed":null,"urgency":null,"urgency_status":"overdue","due_date":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk task patch no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "hk task patch frequency zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"minimum"}]}},
  "hk task patch frequency text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"type"}]}},
  "hk task patch frequency null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency_days","rule":"type"}]}},
  "hk task patch name null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "hk task patch area spaces": {"status":400,"body":{"error":"area must not be empty.","code":400}},
  "hk task patch zero": {"status":400,"body":{"error":"taskId must be a positive number.","code":400}},
  "hk task patch unknown": {"status":404,"body":{"error":"Task not found.","code":404,"reason":"housekeeping_task_not_found"}},
  "hk task patch letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/taskId","rule":"type"}]}},
  "hk task complete": {"status":200,"body":{"data":{"id":2,"name":"Bad","area":"Bad","frequency_days":7,"last_completed":"2026-11-18T12:00:00.000Z","urgency":0,"urgency_status":"ok","due_date":"2026-11-25T12:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk task complete zero": {"status":400,"body":{"error":"taskId must be a positive number.","code":400}},
  "hk task complete unknown": {"status":404,"body":{"error":"Task not found.","code":404,"reason":"housekeeping_task_not_found"}},
  "hk task delete": {"status":200,"body":{"data":null}},
  "hk task delete again": {"status":404,"body":{"error":"Task not found.","code":404,"reason":"housekeeping_task_not_found"}},
  "hk task delete zero": {"status":400,"body":{"error":"taskId must be a positive number.","code":400}},
  "hk tasks end": {"status":200,"body":{"data":[{"id":1,"name":"Fenster innen","area":"Haus","frequency_days":14,"last_completed":null,"urgency":null,"urgency_status":"overdue","due_date":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":5,"name":"x","area":"y","frequency_days":7,"last_completed":"2026-02-30T10:00","urgency":37.304,"urgency_status":"overdue","due_date":"2026-03-09T09:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"name":"Ofen","area":"Kueche","frequency_days":1,"last_completed":"2026-11-17T08:00","urgency":1.208,"urgency_status":"today","due_date":"2026-11-18T07:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"name":"Bad","area":"Bad","frequency_days":7,"last_completed":"2026-11-18T12:00:00.000Z","urgency":0,"urgency_status":"ok","due_date":"2026-11-25T12:00:00.000Z","created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "hk supply": {"status":201,"body":{"data":{"id":1,"name":"Spuelmittel","quantity":"2 Flaschen","shopping_item_id":1,"created_by":1,"created_at":"<volatile>"},"shopping_item_id":1}},
  "hk supply quantity null": {"status":201,"body":{"data":{"id":2,"name":"Schwamm","quantity":null,"shopping_item_id":2,"created_by":1,"created_at":"<volatile>"},"shopping_item_id":2}},
  "hk supply name spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "hk supply name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "hk supply no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "hk supply token": {"status":403,"body":{"error":"Write access to the shopping list is required.","code":403,"reason":"cross_module_access"}},
  "hk supply no shopping": {"status":403,"body":{"error":"Write access to the shopping list is required.","code":403,"reason":"cross_module_access"}},
  "hk log empty": {"status":200,"body":{"data":[]}},
  "hk log create": {"status":201,"body":{"data":{"id":1,"description":"Wasserhahn tropft","photo_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk log create photo null": {"status":201,"body":{"data":{"id":2,"description":"Lampe","photo_url":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk log create photo empty": {"status":201,"body":{"data":{"id":3,"description":"Tuer","photo_url":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "hk log create photo number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/photo_url","rule":"type"}]}},
  "hk log create photo list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/photo_url","rule":"type"}]}},
  "hk log create photo text": {"status":400,"body":{"error":"Photo must be PNG, JPEG, or WebP.","code":400}},
  "hk log create photo mismatch": {"status":400,"body":{"error":"Photo content does not match its image type.","code":400}},
  "hk log create description spaces": {"status":400,"body":{"error":"description must not be empty.","code":400}},
  "hk log create description missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/description","rule":"required"}]}},
  "hk log": {"status":200,"body":{"data":[{"id":3,"description":"Tuer","photo_url":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"description":"Lampe","photo_url":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"description":"Wasserhahn tropft","photo_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "rw overview empty": {"status":200,"body":{"data":{"balances":[],"catalog":[],"pendingCount":0,"moneyPendingCount":0,"isAdmin":true,"me":1,"setup":{"participantCount":0,"catalogCount":0,"pointedTaskCount":0}}}},
  "rw participants": {"status":200,"body":{"data":[{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"enabled":false,"balance":0},{"id":3,"display_name":"mia","avatar_color":"#007AFF","avatar_data":null,"family_role":"child","sort_order":null,"enabled":false,"balance":0},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"enabled":false,"balance":0},{"id":4,"display_name":"wall","avatar_color":"#007AFF","avatar_data":null,"family_role":"other","sort_order":null,"enabled":false,"balance":0}]}},
  "rw participants member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw participant member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw participant member malformed": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw participant enable": {"status":200,"body":{"data":{"user_id":2,"enabled":true}}},
  "rw participant enable child": {"status":200,"body":{"data":{"user_id":3,"enabled":true}}},
  "rw participant enable admin": {"status":200,"body":{"data":{"user_id":1,"enabled":true}}},
  "rw participant disable admin": {"status":200,"body":{"data":{"user_id":1,"enabled":false}}},
  "rw participant enabled text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "rw participant enabled one": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "rw participant enabled null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "rw participant empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"required"}]}},
  "rw participant no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rw participant unknown": {"status":404,"body":{"error":"User not found.","code":404}},
  "rw participant zero": {"status":404,"body":{"error":"User not found.","code":404}},
  "rw participant letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/userId","rule":"type"}]}},
  "rw participant staff": {"status":400,"body":{"error":"Only household members can be chosen here - user 5 is not a household member.","code":400}},
  "rw participant staff off": {"status":200,"body":{"data":{"user_id":5,"enabled":false}}},
  "rw participants after": {"status":200,"body":{"data":[{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"enabled":false,"balance":0},{"id":3,"display_name":"mia","avatar_color":"#007AFF","avatar_data":null,"family_role":"child","sort_order":null,"enabled":true,"balance":0},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"enabled":true,"balance":0},{"id":4,"display_name":"wall","avatar_color":"#007AFF","avatar_data":null,"family_role":"other","sort_order":null,"enabled":false,"balance":0}]}},
  "rw catalog empty": {"status":200,"body":{"data":[]}},
  "rw catalog create member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw catalog create": {"status":201,"body":{"data":{"id":1,"name":"Kino","cost":50,"icon":"🎬🎬🎬🎬","description":"Ein Film","is_active":1,"sort_order":2,"quantity":null,"remaining":null}}},
  "rw catalog create limited": {"status":201,"body":{"data":{"id":2,"name":"Eis","cost":10,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":2,"remaining":2}}},
  "rw catalog create pricey": {"status":201,"body":{"data":{"id":3,"name":"Fahrrad","cost":1000000,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null}}},
  "rw catalog create switched off": {"status":201,"body":{"data":{"id":4,"name":"Zoo","cost":30,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null}}},
  "rw catalog create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rw catalog create name spaces": {"status":400,"body":{"error":"name is required.","code":400}},
  "rw catalog create name missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "rw catalog create cost missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"required"}]}},
  "rw catalog create cost zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"minimum"}]}},
  "rw catalog create cost negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"minimum"}]}},
  "rw catalog create cost over": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"maximum"}]}},
  "rw catalog create cost text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"type"}]}},
  "rw catalog create cost fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"type"}]}},
  "rw catalog create cost null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"type"}]}},
  "rw catalog create quantity zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"minimum"}]}},
  "rw catalog create quantity over": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"maximum"}]}},
  "rw catalog create quantity empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"type"}]}},
  "rw catalog create quantity text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"type"}]}},
  "rw catalog create sort text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/sort_order","rule":"type"}]}},
  "rw catalog create sort null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/sort_order","rule":"type"}]}},
  "rw catalog create icon number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon","rule":"type"}]}},
  "rw catalog patch": {"status":200,"body":{"data":{"id":4,"name":"Zoo","cost":30,"icon":"🦁","description":null,"is_active":0,"sort_order":0,"quantity":null,"remaining":null}}},
  "rw catalog patch name": {"status":200,"body":{"data":{"id":1,"name":"Kino gross","cost":60,"icon":"🎬🎬🎬🎬","description":"Ein Film","is_active":1,"sort_order":1,"quantity":5,"remaining":5}}},
  "rw catalog patch keep": {"status":200,"body":{"data":{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null}}},
  "rw catalog patch empty": {"status":200,"body":{"data":{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null}}},
  "rw catalog patch no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rw catalog patch name spaces": {"status":400,"body":{"error":"name is required.","code":400}},
  "rw catalog patch cost zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"minimum"}]}},
  "rw catalog patch cost over": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"maximum"}]}},
  "rw catalog patch cost text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cost","rule":"type"}]}},
  "rw catalog patch quantity zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"minimum"}]}},
  "rw catalog patch quantity empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"type"}]}},
  "rw catalog patch active text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/is_active","rule":"type"}]}},
  "rw catalog patch active one": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/is_active","rule":"type"}]}},
  "rw catalog patch active null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/is_active","rule":"type"}]}},
  "rw catalog patch sort null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/sort_order","rule":"type"}]}},
  "rw catalog patch zero": {"status":404,"body":{"error":"Reward not found.","code":404,"reason":"rewards_reward_not_found"}},
  "rw catalog patch unknown": {"status":404,"body":{"error":"Reward not found.","code":404,"reason":"rewards_reward_not_found"}},
  "rw catalog patch letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rw catalog patch member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw catalog": {"status":200,"body":{"data":[{"id":2,"name":"Eis","cost":10,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":2,"remaining":2},{"id":3,"name":"Fahrrad","cost":1000000,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null},{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null}]}},
  "rw catalog all": {"status":200,"body":{"data":[{"id":2,"name":"Eis","cost":10,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":2,"remaining":2},{"id":3,"name":"Fahrrad","cost":1000000,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null},{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null},{"id":4,"name":"Zoo","cost":30,"icon":"🦁","description":null,"is_active":0,"sort_order":0,"quantity":null,"remaining":null}]}},
  "rw catalog all member": {"status":200,"body":{"data":[{"id":2,"name":"Eis","cost":10,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":2,"remaining":2},{"id":3,"name":"Fahrrad","cost":1000000,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null},{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null}]}},
  "rw catalog all zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/all","rule":"enum"}]}},
  "rw catalog all true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/all","rule":"enum"}]}},
  "rw bonus member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw bonus": {"status":201,"body":{"data":{"user_id":2,"balance":200}}},
  "rw bonus digit text": {"status":201,"body":{"data":{"user_id":3,"balance":100}}},
  "rw bonus correction": {"status":201,"body":{"data":{"user_id":2,"balance":180}}},
  "rw bonus at bound": {"status":201,"body":{"data":{"user_id":3,"balance":-999900}}},
  "rw bonus back": {"status":201,"body":{"data":{"user_id":3,"balance":100}}},
  "rw bonus delta zero": {"status":400,"body":{"error":"delta must be a non-zero number.","code":400}},
  "rw bonus delta over": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/delta","rule":"maximum"}]}},
  "rw bonus delta under": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/delta","rule":"minimum"}]}},
  "rw bonus delta text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/delta","rule":"type"}]}},
  "rw bonus delta fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/delta","rule":"type"}]}},
  "rw bonus delta missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/delta","rule":"required"}]}},
  "rw bonus user missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/user_id","rule":"required"}]}},
  "rw bonus user letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/user_id","rule":"type"},{"path":"body/user_id","rule":"pattern"},{"path":"body/user_id","rule":"anyOf"}]}},
  "rw bonus user null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/user_id","rule":"type"},{"path":"body/user_id","rule":"anyOf"}]}},
  "rw bonus user huge": {"status":400,"body":{"error":"user_id is required.","code":400}},
  "rw bonus user zero": {"status":400,"body":{"error":"User does not participate in the reward system.","code":400,"reason":"rewards_not_participating"}},
  "rw bonus not participating": {"status":400,"body":{"error":"User does not participate in the reward system.","code":400,"reason":"rewards_not_participating"}},
  "rw bonus reason number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reason","rule":"type"}]}},
  "rw redeem member": {"status":201,"body":{"data":{"id":1,"user_id":2,"catalog_id":2,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"pending","note":"Bitte","requested_by":2,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw redeem member second": {"status":201,"body":{"data":{"id":2,"user_id":2,"catalog_id":2,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"pending","note":null,"requested_by":2,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw redeem member third": {"status":201,"body":{"data":{"id":3,"user_id":2,"catalog_id":1,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":null,"requested_by":2,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw redeem child": {"status":201,"body":{"data":{"id":4,"user_id":3,"catalog_id":1,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","requested_by":3,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw redeem child for other": {"status":201,"body":{"data":{"id":5,"user_id":3,"catalog_id":2,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"pending","note":null,"requested_by":3,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw redeem admin for child": {"status":201,"body":{"data":{"id":6,"user_id":3,"catalog_id":2,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"pending","note":null,"requested_by":1,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw redeem admin self": {"status":400,"body":{"error":"User does not participate in the reward system.","code":400,"reason":"rewards_not_participating"}},
  "rw redeem admin user huge": {"status":400,"body":{"error":"user_id is required.","code":400}},
  "rw redeem admin user zero": {"status":400,"body":{"error":"user_id is required.","code":400}},
  "rw redeem insufficient": {"status":400,"body":{"error":"Insufficient points.","code":400,"reason":"rewards_insufficient_points"}},
  "rw redeem switched off": {"status":404,"body":{"error":"Reward not found.","code":404,"reason":"rewards_reward_not_found"}},
  "rw redeem unknown": {"status":404,"body":{"error":"Reward not found.","code":404,"reason":"rewards_reward_not_found"}},
  "rw redeem catalog missing": {"status":404,"body":{"error":"Reward not found.","code":404,"reason":"rewards_reward_not_found"}},
  "rw redeem catalog letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/catalog_id","rule":"type"},{"path":"body/catalog_id","rule":"pattern"},{"path":"body/catalog_id","rule":"anyOf"}]}},
  "rw redeem catalog null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/catalog_id","rule":"type"},{"path":"body/catalog_id","rule":"anyOf"}]}},
  "rw redeem kind unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/kind","rule":"enum"}]}},
  "rw redeem kind null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/kind","rule":"type"}]}},
  "rw redeem kind number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/kind","rule":"type"}]}},
  "rw redeem note number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/note","rule":"type"}]}},
  "rw redeem no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rw redeem display no person": {"status":400,"body":{"error":"A paired display must name the person it is acting for.","code":400}},
  "rw redeem display person": {"status":400,"body":{"error":"Insufficient points.","code":400,"reason":"rewards_insufficient_points"}},
  "rw redeem money no account": {"status":400,"body":{"error":"This person has no pocket money account.","code":400,"reason":"no_money_account"}},
  "rw redeem money display": {"status":403,"body":{"error":"Pocket money is not available on a display.","code":403,"reason":"money_not_on_display"}},
  "rw money empty": {"status":200,"body":{"data":{"currency":"EUR","minor_unit":2,"accounts":[],"candidates":[{"id":1,"display_name":"linda","family_role":"parent"},{"id":3,"display_name":"mia","family_role":"child"},{"id":2,"display_name":"tom","family_role":"parent"},{"id":4,"display_name":"wall","family_role":"other"}]}}},
  "rw money account member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw money account no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rw money account empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/user_id","rule":"required"}]}},
  "rw money account unknown": {"status":404,"body":{"error":"User not found.","code":404}},
  "rw money account zero": {"status":404,"body":{"error":"User not found.","code":404}},
  "rw money account huge": {"status":404,"body":{"error":"User not found.","code":404}},
  "rw money account letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/user_id","rule":"type"},{"path":"body/user_id","rule":"pattern"},{"path":"body/user_id","rule":"anyOf"}]}},
  "rw money account staff": {"status":400,"body":{"error":"Only household members can have pocket money.","code":400}},
  "rw money account currency": {"status":400,"body":{"error":"This pocket money account is kept in EUR.","code":400,"reason":"currency_mismatch"}},
  "rw money account": {"status":201,"body":{"data":{"user_id":2,"balance_minor":0,"currency":"EUR","minor_unit":2,"plan":null}}},
  "rw money account again": {"status":409,"body":{"error":"This person already has a pocket money account.","code":409,"reason":"money_account_exists"}},
  "rw money entry member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw money entry credit": {"status":201,"body":{"data":{"user_id":2,"balance_minor":2000,"currency":"EUR","minor_unit":2}}},
  "rw money entry credit child": {"status":201,"body":{"data":{"user_id":3,"balance_minor":500,"currency":"EUR","minor_unit":2}}},
  "rw money entry debit": {"status":201,"body":{"data":{"user_id":2,"balance_minor":1750,"currency":"EUR","minor_unit":2}}},
  "rw money entry debit too much": {"status":400,"body":{"error":"Insufficient funds.","code":400,"reason":"insufficient_funds"}},
  "rw money entry direction unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/direction","rule":"enum"}]}},
  "rw money entry direction missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/direction","rule":"required"}]}},
  "rw money entry direction null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/direction","rule":"type"}]}},
  "rw money entry amount number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount","rule":"type"}]}},
  "rw money entry amount letters": {"status":400,"body":{"error":"amount must be a valid decimal string.","code":400}},
  "rw money entry amount negative": {"status":400,"body":{"error":"amount must be greater than zero.","code":400}},
  "rw money entry amount too precise": {"status":400,"body":{"error":"amount has too many decimal places for EUR.","code":400}},
  "rw money entry currency": {"status":400,"body":{"error":"This pocket money account is kept in EUR.","code":400,"reason":"currency_mismatch"}},
  "rw money entry user huge": {"status":400,"body":{"error":"user_id is required.","code":400}},
  "rw money entry user letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/user_id","rule":"type"},{"path":"body/user_id","rule":"pattern"},{"path":"body/user_id","rule":"anyOf"}]}},
  "rw money entry staff": {"status":400,"body":{"error":"Only household members can have pocket money.","code":400}},
  "rw money entry reason number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reason","rule":"type"}]}},
  "rw money entry too large": {"status":400,"body":{"error":"amount is too large.","code":400}},
  "rw money ledger": {"status":200,"body":{"data":[{"id":14,"user_id":2,"delta":-250,"currency":"EUR","type":"adjust","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2},{"id":13,"user_id":3,"delta":500,"currency":"EUR","type":"bonus","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2},{"id":12,"user_id":2,"delta":2000,"currency":"EUR","type":"bonus","reason":"Oma","allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2}]}},
  "rw money ledger member": {"status":200,"body":{"data":[{"id":14,"user_id":2,"delta":-250,"currency":"EUR","type":"adjust","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2},{"id":12,"user_id":2,"delta":2000,"currency":"EUR","type":"bonus","reason":"Oma","allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2}]}},
  "rw money ledger child other": {"status":200,"body":{"data":[]}},
  "rw money ledger user": {"status":200,"body":{"data":[{"id":13,"user_id":3,"delta":500,"currency":"EUR","type":"bonus","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2}]}},
  "rw money ledger user zero": {"status":200,"body":{"data":[{"id":14,"user_id":2,"delta":-250,"currency":"EUR","type":"adjust","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2},{"id":13,"user_id":3,"delta":500,"currency":"EUR","type":"bonus","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2},{"id":12,"user_id":2,"delta":2000,"currency":"EUR","type":"bonus","reason":"Oma","allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2}]}},
  "rw money ledger limit negative": {"status":200,"body":{"data":[{"id":14,"user_id":2,"delta":-250,"currency":"EUR","type":"adjust","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2}]}},
  "rw money ledger limit big": {"status":200,"body":{"data":[{"id":14,"user_id":2,"delta":-250,"currency":"EUR","type":"adjust","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2},{"id":13,"user_id":3,"delta":500,"currency":"EUR","type":"bonus","reason":null,"allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2},{"id":12,"user_id":2,"delta":2000,"currency":"EUR","type":"bonus","reason":"Oma","allowance_date":null,"redemption_id":null,"request_kind":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda","minor_unit":2}]}},
  "rw money ledger user letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/user_id","rule":"type"}]}},
  "rw money ledger limit fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/limit","rule":"type"}]}},
  "rw money ledger display": {"status":200,"body":{"data":[]}},
  "rw money request withdrawal": {"status":201,"body":{"data":{"id":7,"user_id":2,"catalog_id":null,"reward_name":"withdrawal","reward_icon":null,"cost":300,"status":"pending","note":"Kino","requested_by":2,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"withdrawal","currency":"EUR"}}},
  "rw money request deposit": {"status":201,"body":{"data":{"id":8,"user_id":2,"catalog_id":null,"reward_name":"deposit","reward_icon":null,"cost":700,"status":"pending","note":null,"requested_by":2,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"deposit","currency":"EUR"}}},
  "rw money request deposit child": {"status":201,"body":{"data":{"id":9,"user_id":3,"catalog_id":null,"reward_name":"deposit","reward_icon":null,"cost":100,"status":"pending","note":null,"requested_by":3,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"deposit","currency":"EUR"}}},
  "rw money request too much": {"status":400,"body":{"error":"Insufficient funds.","code":400,"reason":"insufficient_funds"}},
  "rw money request amount number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount","rule":"type"}]}},
  "rw money request amount letters": {"status":400,"body":{"error":"amount must be a valid decimal string.","code":400}},
  "rw money request currency": {"status":400,"body":{"error":"This pocket money account is kept in EUR.","code":400,"reason":"currency_mismatch"}},
  "rw money request admin for member": {"status":201,"body":{"data":{"id":10,"user_id":2,"catalog_id":null,"reward_name":"deposit","reward_icon":null,"cost":50,"status":"pending","note":null,"requested_by":1,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"deposit","currency":"EUR"}}},
  "rw money request admin user huge": {"status":400,"body":{"error":"user_id is required.","code":400}},
  "rw money request staff": {"status":400,"body":{"error":"This person has no pocket money account.","code":400,"reason":"no_money_account"}},
  "rw decide fulfill": {"status":200,"body":{"data":{"id":1,"user_id":2,"catalog_id":2,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":"Bitte","requested_by":2,"decided_by":1,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw decide reject": {"status":200,"body":{"data":{"id":2,"user_id":2,"catalog_id":2,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"requested_by":2,"decided_by":1,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw decide cancel own": {"status":200,"body":{"data":{"id":3,"user_id":2,"catalog_id":1,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"cancelled","note":null,"requested_by":2,"decided_by":2,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw decide decided": {"status":409,"body":{"error":"Redemption already decided.","code":409,"reason":"rewards_redemption_decided"}},
  "rw decide member fulfill": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw decide member cancel foreign": {"status":403,"body":{"error":"Not allowed.","code":403}},
  "rw decide action unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/action","rule":"enum"}]}},
  "rw decide action missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/action","rule":"required"}]}},
  "rw decide action number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/action","rule":"type"}]}},
  "rw decide no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rw decide member unknown action": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/action","rule":"enum"}]}},
  "rw decide zero": {"status":404,"body":{"error":"Redemption not found.","code":404,"reason":"rewards_redemption_not_found"}},
  "rw decide unknown": {"status":404,"body":{"error":"Redemption not found.","code":404,"reason":"rewards_redemption_not_found"}},
  "rw decide letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rw decide money foreign": {"status":404,"body":{"error":"Redemption not found.","code":404,"reason":"rewards_redemption_not_found"}},
  "rw decide money withdrawal": {"status":200,"body":{"data":{"id":7,"user_id":2,"catalog_id":null,"reward_name":"withdrawal","reward_icon":null,"cost":300,"status":"fulfilled","note":"Kino","requested_by":2,"decided_by":1,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"withdrawal","currency":"EUR"}}},
  "rw decide money deposit reject": {"status":200,"body":{"data":{"id":8,"user_id":2,"catalog_id":null,"reward_name":"deposit","reward_icon":null,"cost":700,"status":"rejected","note":null,"requested_by":2,"decided_by":1,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"deposit","currency":"EUR"}}},
  "rw reopen member fulfilled": {"status":403,"body":{"error":"Only who decided can take the decision back.","code":403,"reason":"rewards_reopen_not_allowed"}},
  "rw reopen own cancel": {"status":200,"body":{"data":{"id":3,"user_id":2,"catalog_id":1,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":null,"requested_by":2,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw reopen pending": {"status":409,"body":{"error":"This request is still open.","code":409,"reason":"rewards_redemption_open"}},
  "rw reopen money": {"status":200,"body":{"data":{"id":8,"user_id":2,"catalog_id":null,"reward_name":"deposit","reward_icon":null,"cost":700,"status":"pending","note":null,"requested_by":2,"decided_by":null,"decided_at":null,"created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"deposit","currency":"EUR"}}},
  "rw cancel again": {"status":200,"body":{"data":{"id":3,"user_id":2,"catalog_id":1,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"cancelled","note":null,"requested_by":2,"decided_by":2,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw decide money deposit reject again": {"status":200,"body":{"data":{"id":8,"user_id":2,"catalog_id":null,"reward_name":"deposit","reward_icon":null,"cost":700,"status":"rejected","note":null,"requested_by":2,"decided_by":1,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"deposit","currency":"EUR"}}},
  "rw decide fulfill last unit": {"status":200,"body":{"data":{"id":5,"user_id":3,"catalog_id":2,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":null,"requested_by":3,"decided_by":1,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"reward","currency":null}}},
  "rw decide fulfill sold out": {"status":409,"body":{"error":"No units of this reward are left; the request was rejected and the points returned.","code":409,"reason":"out_of_stock","data":{"id":6,"user_id":3,"catalog_id":2,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"requested_by":1,"decided_by":1,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":"out_of_stock","kind":"reward","currency":null}}},
  "rw redeem sold out": {"status":409,"body":{"error":"No units of this reward are left.","code":409,"reason":"out_of_stock"}},
  "rw redemptions": {"status":200,"body":{"data":[{"id":4,"user_id":3,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":30,"minor_unit":null},{"id":6,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":"out_of_stock","decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":5,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":3,"user_id":2,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"cancelled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"tom","user_balance":170,"minor_unit":null},{"id":2,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null},{"id":1,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":"Bitte","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null}]}},
  "rw redemptions pending": {"status":200,"body":{"data":[{"id":4,"user_id":3,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":30,"minor_unit":null}]}},
  "rw redemptions fulfilled": {"status":200,"body":{"data":[{"id":5,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":1,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":"Bitte","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null}]}},
  "rw redemptions rejected": {"status":200,"body":{"data":[{"id":6,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":"out_of_stock","decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":2,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null}]}},
  "rw redemptions cancelled": {"status":200,"body":{"data":[{"id":3,"user_id":2,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"cancelled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"tom","user_balance":170,"minor_unit":null}]}},
  "rw redemptions kind reward": {"status":200,"body":{"data":[{"id":4,"user_id":3,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":30,"minor_unit":null},{"id":6,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":"out_of_stock","decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":5,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":3,"user_id":2,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"cancelled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"tom","user_balance":170,"minor_unit":null},{"id":2,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null},{"id":1,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":"Bitte","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null}]}},
  "rw redemptions kind money": {"status":200,"body":{"data":[{"id":10,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":50,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":1450,"minor_unit":2},{"id":9,"user_id":3,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":100,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":500,"minor_unit":2},{"id":8,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":700,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2},{"id":7,"user_id":2,"catalog_id":null,"kind":"withdrawal","currency":"EUR","reward_name":"withdrawal","reward_icon":null,"cost":300,"status":"fulfilled","note":"Kino","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2}]}},
  "rw redemptions kind all": {"status":200,"body":{"data":[{"id":10,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":50,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":1450,"minor_unit":2},{"id":9,"user_id":3,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":100,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":500,"minor_unit":2},{"id":4,"user_id":3,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":30,"minor_unit":null},{"id":8,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":700,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2},{"id":7,"user_id":2,"catalog_id":null,"kind":"withdrawal","currency":"EUR","reward_name":"withdrawal","reward_icon":null,"cost":300,"status":"fulfilled","note":"Kino","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2},{"id":6,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":"out_of_stock","decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":5,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":3,"user_id":2,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"cancelled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"tom","user_balance":170,"minor_unit":null},{"id":2,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null},{"id":1,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":"Bitte","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null}]}},
  "rw redemptions kind withdrawal": {"status":200,"body":{"data":[{"id":7,"user_id":2,"catalog_id":null,"kind":"withdrawal","currency":"EUR","reward_name":"withdrawal","reward_icon":null,"cost":300,"status":"fulfilled","note":"Kino","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2}]}},
  "rw redemptions kind deposit": {"status":200,"body":{"data":[{"id":10,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":50,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":1450,"minor_unit":2},{"id":9,"user_id":3,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":100,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":500,"minor_unit":2},{"id":8,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":700,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2}]}},
  "rw redemptions kind all pending": {"status":200,"body":{"data":[{"id":10,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":50,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":1450,"minor_unit":2},{"id":9,"user_id":3,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":100,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":500,"minor_unit":2},{"id":4,"user_id":3,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":30,"minor_unit":null}]}},
  "rw redemptions kind money rejected": {"status":200,"body":{"data":[{"id":8,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":700,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2}]}},
  "rw redemptions member": {"status":200,"body":{"data":[{"id":10,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":50,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":1450,"minor_unit":2},{"id":8,"user_id":2,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":700,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2},{"id":7,"user_id":2,"catalog_id":null,"kind":"withdrawal","currency":"EUR","reward_name":"withdrawal","reward_icon":null,"cost":300,"status":"fulfilled","note":"Kino","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":null,"minor_unit":2},{"id":3,"user_id":2,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"cancelled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"tom","user_balance":170,"minor_unit":null},{"id":2,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null},{"id":1,"user_id":2,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":"Bitte","decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":170,"minor_unit":null}]}},
  "rw redemptions child": {"status":200,"body":{"data":[{"id":9,"user_id":3,"catalog_id":null,"kind":"deposit","currency":"EUR","reward_name":"deposit","reward_icon":null,"cost":100,"status":"pending","note":null,"decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":500,"minor_unit":2},{"id":4,"user_id":3,"catalog_id":1,"kind":"reward","currency":null,"reward_name":"Kino gross","reward_icon":null,"cost":60,"status":"pending","note":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","decision_reason":null,"decided_at":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":null,"user_balance":30,"minor_unit":null},{"id":6,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"rejected","note":null,"decision_reason":"out_of_stock","decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null},{"id":5,"user_id":3,"catalog_id":2,"kind":"reward","currency":null,"reward_name":"Eis","reward_icon":null,"cost":10,"status":"fulfilled","note":null,"decision_reason":null,"decided_at":"<volatile>","created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"decided_by_name":"linda","user_balance":30,"minor_unit":null}]}},
  "rw redemptions display": {"status":200,"body":{"data":[]}},
  "rw redemptions status unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"enum"}]}},
  "rw redemptions status empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"enum"}]}},
  "rw redemptions status twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"type"}]}},
  "rw redemptions kind unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/kind","rule":"enum"}]}},
  "rw redemptions kind empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/kind","rule":"enum"}]}},
  "rw redemptions kind proto": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/kind","rule":"enum"}]}},
  "rw redemptions kind constructor": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/kind","rule":"enum"}]}},
  "rw ledger": {"status":200,"body":{"data":[{"id":19,"user_id":3,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":6,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":18,"user_id":2,"delta":60,"type":"reversal","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":15,"user_id":2,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":2,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":11,"user_id":3,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":6,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":10,"user_id":3,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":5,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"mia"},{"id":9,"user_id":3,"delta":-60,"type":"redeem","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":4,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"mia"},{"id":8,"user_id":2,"delta":-60,"type":"redeem","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":7,"user_id":2,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":2,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":6,"user_id":2,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":1,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":5,"user_id":3,"delta":1000000,"type":"bonus","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":4,"user_id":3,"delta":-1000000,"type":"adjust","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":3,"user_id":2,"delta":-20,"type":"adjust","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":2,"user_id":3,"delta":100,"type":"bonus","reason":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":1,"user_id":2,"delta":200,"type":"bonus","reason":"Garten","task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"}]}},
  "rw ledger user": {"status":200,"body":{"data":[{"id":18,"user_id":2,"delta":60,"type":"reversal","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":15,"user_id":2,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":2,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":8,"user_id":2,"delta":-60,"type":"redeem","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"}]}},
  "rw ledger user zero": {"status":200,"body":{"data":[{"id":19,"user_id":3,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":6,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":18,"user_id":2,"delta":60,"type":"reversal","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"}]}},
  "rw ledger limit zero": {"status":200,"body":{"data":[{"id":19,"user_id":3,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":6,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":18,"user_id":2,"delta":60,"type":"reversal","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":15,"user_id":2,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":2,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":11,"user_id":3,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":6,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":10,"user_id":3,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":5,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"mia"},{"id":9,"user_id":3,"delta":-60,"type":"redeem","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":4,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"mia"},{"id":8,"user_id":2,"delta":-60,"type":"redeem","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":7,"user_id":2,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":2,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":6,"user_id":2,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":1,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":5,"user_id":3,"delta":1000000,"type":"bonus","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":4,"user_id":3,"delta":-1000000,"type":"adjust","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":3,"user_id":2,"delta":-20,"type":"adjust","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":2,"user_id":3,"delta":100,"type":"bonus","reason":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":1,"user_id":2,"delta":200,"type":"bonus","reason":"Garten","task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"}]}},
  "rw ledger limit negative": {"status":200,"body":{"data":[{"id":19,"user_id":3,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":6,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"}]}},
  "rw ledger user letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/user_id","rule":"type"}]}},
  "rw ledger user twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/user_id","rule":"type"}]}},
  "rw ledger child": {"status":200,"body":{"data":[{"id":19,"user_id":3,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":6,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":18,"user_id":2,"delta":60,"type":"reversal","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":15,"user_id":2,"delta":10,"type":"reversal","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":2,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":11,"user_id":3,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":6,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":10,"user_id":3,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":5,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"mia"},{"id":9,"user_id":3,"delta":-60,"type":"redeem","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":4,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"mia"},{"id":8,"user_id":2,"delta":-60,"type":"redeem","reason":"Kino gross","task_id":null,"decay_days":null,"base_points":null,"redemption_id":3,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":7,"user_id":2,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":2,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":6,"user_id":2,"delta":-10,"type":"redeem","reason":"Eis","task_id":null,"decay_days":null,"base_points":null,"redemption_id":1,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"tom"},{"id":5,"user_id":3,"delta":1000000,"type":"bonus","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":4,"user_id":3,"delta":-1000000,"type":"adjust","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":3,"user_id":2,"delta":-20,"type":"adjust","reason":null,"task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":2,"user_id":3,"delta":100,"type":"bonus","reason":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"mia","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"},{"id":1,"user_id":2,"delta":200,"type":"bonus","reason":"Garten","task_id":null,"decay_days":null,"base_points":null,"redemption_id":null,"created_at":"<volatile>","user_name":"tom","user_color":"#007AFF","user_avatar":null,"actor_name":"linda"}]}},
  "rw overview": {"status":200,"body":{"data":{"balances":[{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"balance":170,"rank":1},{"id":3,"display_name":"mia","avatar_color":"#007AFF","avatar_data":null,"family_role":"child","sort_order":null,"balance":30,"rank":2}],"catalog":[{"id":2,"name":"Eis","cost":10,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":2,"remaining":0},{"id":3,"name":"Fahrrad","cost":1000000,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null},{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null}],"pendingCount":1,"moneyPendingCount":2,"isAdmin":true,"me":1,"setup":{"participantCount":2,"catalogCount":3,"pointedTaskCount":0}}}},
  "rw overview member": {"status":200,"body":{"data":{"balances":[{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"balance":170,"rank":1},{"id":3,"display_name":"mia","avatar_color":"#007AFF","avatar_data":null,"family_role":"child","sort_order":null,"balance":30,"rank":2}],"catalog":[{"id":2,"name":"Eis","cost":10,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":2,"remaining":0},{"id":3,"name":"Fahrrad","cost":1000000,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null},{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null}],"pendingCount":1,"moneyPendingCount":1,"isAdmin":false,"me":2,"setup":{"participantCount":2,"catalogCount":3,"pointedTaskCount":0}}}},
  "rw overview display": {"status":200,"body":{"data":{"balances":[{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"balance":170,"rank":1},{"id":3,"display_name":"mia","avatar_color":"#007AFF","avatar_data":null,"family_role":"child","sort_order":null,"balance":30,"rank":2}],"catalog":[{"id":2,"name":"Eis","cost":10,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":2,"remaining":0},{"id":3,"name":"Fahrrad","cost":1000000,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null},{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null}],"pendingCount":1,"moneyPendingCount":0,"isAdmin":false,"me":4,"setup":{"participantCount":2,"catalogCount":3,"pointedTaskCount":0}}}},
  "rw plan member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw plan weekly": {"status":200,"body":{"data":{"user_id":3,"plan":{"amount_minor":200,"currency":"EUR","minor_unit":2,"frequency":"weekly","anchor_day":3,"next_run_date":"2026-11-25","paused":false},"balance_minor":700}}},
  "rw plan monthly": {"status":200,"body":{"data":{"user_id":2,"plan":{"amount_minor":1000,"currency":"EUR","minor_unit":2,"frequency":"monthly","anchor_day":31,"next_run_date":"2026-11-30","paused":true},"balance_minor":1450}}},
  "rw plan resume": {"status":200,"body":{"data":{"user_id":2,"plan":{"amount_minor":1000,"currency":"EUR","minor_unit":2,"frequency":"monthly","anchor_day":18,"next_run_date":"2026-12-18","paused":false},"balance_minor":2450}}},
  "rw plan weekly anchor 8": {"status":400,"body":{"error":"anchor_day must be a whole number from 1 to 7.","code":400}},
  "rw plan anchor zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/anchor_day","rule":"minimum"}]}},
  "rw plan anchor 32": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/anchor_day","rule":"maximum"}]}},
  "rw plan anchor text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/anchor_day","rule":"type"}]}},
  "rw plan frequency unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency","rule":"enum"}]}},
  "rw plan frequency missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency","rule":"required"}]}},
  "rw plan paused text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/paused","rule":"type"}]}},
  "rw plan paused null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/paused","rule":"type"}]}},
  "rw plan amount letters": {"status":400,"body":{"error":"amount must be a valid decimal string.","code":400}},
  "rw plan amount number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount","rule":"type"}]}},
  "rw plan currency": {"status":400,"body":{"error":"This pocket money account is kept in EUR.","code":400,"reason":"currency_mismatch"}},
  "rw plan anchor 8 and amount": {"status":400,"body":{"error":"anchor_day must be a whole number from 1 to 7.","code":400}},
  "rw plan unknown": {"status":404,"body":{"error":"User not found.","code":404}},
  "rw plan zero": {"status":404,"body":{"error":"User not found.","code":404}},
  "rw plan staff": {"status":400,"body":{"error":"Only household members can have pocket money.","code":400}},
  "rw plan no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rw money": {"status":200,"body":{"data":{"currency":"EUR","minor_unit":2,"accounts":[{"id":3,"display_name":"mia","avatar_color":"#007AFF","avatar_data":null,"family_role":"child","sort_order":null,"balance_minor":700,"former":false,"currency":"EUR","minor_unit":2,"plan":{"amount_minor":200,"currency":"EUR","minor_unit":2,"frequency":"weekly","anchor_day":3,"next_run_date":"2026-11-25","paused":false},"closable":false},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"balance_minor":2450,"former":false,"currency":"EUR","minor_unit":2,"plan":{"amount_minor":1000,"currency":"EUR","minor_unit":2,"frequency":"monthly","anchor_day":18,"next_run_date":"2026-12-18","paused":false},"closable":false}],"candidates":[{"id":1,"display_name":"linda","family_role":"parent"},{"id":4,"display_name":"wall","family_role":"other"}]}}},
  "rw money member": {"status":200,"body":{"data":{"currency":"EUR","minor_unit":2,"accounts":[{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"parent","sort_order":null,"balance_minor":2450,"former":false,"currency":"EUR","minor_unit":2,"plan":{"amount_minor":1000,"currency":"EUR","minor_unit":2,"frequency":"monthly","anchor_day":18,"next_run_date":"2026-12-18","paused":false},"closable":false}],"candidates":[]}}},
  "rw money child": {"status":200,"body":{"data":{"currency":"EUR","minor_unit":2,"accounts":[{"id":3,"display_name":"mia","avatar_color":"#007AFF","avatar_data":null,"family_role":"child","sort_order":null,"balance_minor":700,"former":false,"currency":"EUR","minor_unit":2,"plan":{"amount_minor":200,"currency":"EUR","minor_unit":2,"frequency":"weekly","anchor_day":3,"next_run_date":"2026-11-25","paused":false},"closable":false}],"candidates":[]}}},
  "rw money display": {"status":200,"body":{"data":{"currency":"EUR","minor_unit":2,"accounts":[],"candidates":[]}}},
  "rw plan delete member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw plan delete": {"status":200,"body":{"ok":true}},
  "rw plan delete again": {"status":404,"body":{"error":"Plan not found.","code":404,"reason":"rewards_money_plan_not_found"}},
  "rw plan delete zero": {"status":404,"body":{"error":"Plan not found.","code":404,"reason":"rewards_money_plan_not_found"}},
  "rw plan delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/userId","rule":"type"}]}},
  "rw account delete not empty": {"status":409,"body":{"error":"Only an empty account can be closed: no balance, no plan, no open request.","code":409,"reason":"money_account_not_empty"}},
  "rw money cancel child request": {"status":200,"body":{"data":{"id":9,"user_id":3,"catalog_id":null,"reward_name":"deposit","reward_icon":null,"cost":100,"status":"cancelled","note":null,"requested_by":3,"decided_by":3,"decided_at":"<volatile>","created_at":"<volatile>","updated_at":"<volatile>","decision_reason":null,"kind":"deposit","currency":"EUR"}}},
  "rw money entry debit rest": {"status":201,"body":{"data":{"user_id":3,"balance_minor":0,"currency":"EUR","minor_unit":2}}},
  "rw account delete": {"status":200,"body":{"ok":true}},
  "rw account delete again": {"status":404,"body":{"error":"Account not found.","code":404,"reason":"rewards_money_account_not_found"}},
  "rw account delete zero": {"status":404,"body":{"error":"Account not found.","code":404,"reason":"rewards_money_account_not_found"}},
  "rw account delete member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw catalog delete member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "rw catalog delete": {"status":200,"body":{"ok":true}},
  "rw catalog delete again": {"status":404,"body":{"error":"Reward not found.","code":404,"reason":"rewards_reward_not_found"}},
  "rw catalog delete zero": {"status":404,"body":{"error":"Reward not found.","code":404,"reason":"rewards_reward_not_found"}},
  "rw catalog delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rw catalog end": {"status":200,"body":{"data":[{"id":2,"name":"Eis","cost":10,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":2,"remaining":0},{"id":3,"name":"Fahrrad","cost":1000000,"icon":null,"description":null,"is_active":1,"sort_order":0,"quantity":null,"remaining":null},{"id":1,"name":"Kino gross","cost":60,"icon":null,"description":null,"is_active":1,"sort_order":1,"quantity":null,"remaining":null}]}},
};

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  logged.error.length = 0;
  const seen = new Set();
  for (const step of STEPS) {
    if (typeof step === 'function') { step(); continue; }
    const [name, method, path, body, opts] = step;
    assert.ok(!seen.has(name), `duplicate row name ${name}`);
    seen.add(name);
    const actual = await call(method, resolved(path), resolvedBody(body), opts);
    const expected = EXPECTED[name];
    assert.ok(expected, `no expectation for ${name}`);
    assert.deepEqual({ status: actual.status, body: normalized(actual.body) }, expected, name);
  }
  assert.equal(seen.size, Object.keys(EXPECTED).length, 'every expectation has its row');
  assert.deepEqual(logged.error, [], 'no row of the table reached the central handler');
});

/**
 * The answer and the log line of the central handler.
 * @param {{ status: number, body: unknown }} res
 * @param {string} method
 * @param {string} pattern
 */
function assertCentral(res, method, pattern) {
  assert.deepEqual(res, { status: 500, body: { error: 'Internal server error.', code: 500 } }, `${method} ${pattern}`);
  assert.deepEqual(logged.error, [`Unhandled error: ${method} ${pattern} -> 500`], `${method} ${pattern}: the central handler logged it`);
  logged.error.length = 0;
}

/**
 * Each request in turn with a handler whose first answer throws; every one is
 * a 500 of the central handler.
 * @param {string} base the mount
 * @param {Array<[string, string, unknown, string]>} rows [method, path under /api/v1, body, route pattern]
 */
async function assertAllCentral(base, rows) {
  for (const [method, path, body, pattern] of rows) {
    assertCentral(await call(method, path, body, { fail: true }), method, `${base}${pattern}`);
  }
}

test('housekeeping: an unexpected error in each of the 24 routes is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const hk = '/housekeeping';
  const base = '/api/v1/housekeeping';
  const last = (/** @type {string} */ table) => db.prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`).get().id;
  await assertAllCentral(base, [
    ['GET', `${hk}/dashboard`, NO_BODY, '/dashboard'],
    ['GET', `${hk}/task-templates`, NO_BODY, '/task-templates'],
    ['GET', `${hk}/worker`, NO_BODY, '/worker'],
    ['GET', `${hk}/workers`, NO_BODY, '/workers'],
    ['POST', `${hk}/worker`, { display_name: 'Probe', daily_rate: 1, username: 'probe' }, '/worker'],
    ['GET', `${hk}/summary`, NO_BODY, '/summary'],
    ['GET', `${hk}/work-sessions`, NO_BODY, '/work-sessions'],
    ['GET', `${hk}/visits`, NO_BODY, '/visits'],
  ]);
  const worker = last('housekeeping_workers');
  await assertAllCentral(base, [
    ['POST', `${hk}/work-sessions/check-in`, { worker_id: worker, daily_rate: 1 }, '/work-sessions/check-in'],
    ['POST', `${hk}/work-sessions/check-out`, { worker_id: worker }, '/work-sessions/check-out'],
  ]);
  const visit = last('housekeeping_work_sessions');
  await assertAllCentral(base, [
    ['POST', `${hk}/work-sessions/${visit}/reopen`, NO_BODY, '/work-sessions/:id/reopen'],
  ]);
  assert.equal((await call('POST', `${hk}/work-sessions/check-out`, { worker_id: worker })).status, 200, 'answers again');
  await assertAllCentral(base, [
    ['GET', `${hk}/visits/${visit}`, NO_BODY, '/visits/:id'],
    ['PUT', `${hk}/visits/${visit}`, { date: '2026-11-18', daily_rate: 2 }, '/visits/:id'],
    ['POST', `${hk}/visits/${visit}/pay`, NO_BODY, '/visits/:id/pay'],
    ['POST', `${hk}/visits/${visit}/unpay`, NO_BODY, '/visits/:id/unpay'],
    ['DELETE', `${hk}/visits/${visit}`, NO_BODY, '/visits/:id'],
    ['GET', `${hk}/decay-tasks`, NO_BODY, '/decay-tasks'],
    ['POST', `${hk}/decay-tasks`, { name: 'Probe', area: 'Probe', frequency_days: 3 }, '/decay-tasks'],
  ]);
  const task = last('housekeeping_decay_tasks');
  await assertAllCentral(base, [
    ['PATCH', `${hk}/decay-tasks/${task}`, { name: 'Probe 2' }, '/decay-tasks/:taskId'],
    ['POST', `${hk}/decay-tasks/${task}/complete`, NO_BODY, '/decay-tasks/:taskId/complete'],
    ['DELETE', `${hk}/decay-tasks/${task}`, NO_BODY, '/decay-tasks/:taskId'],
    ['POST', `${hk}/supply-requests`, { name: 'Probe' }, '/supply-requests'],
    ['GET', `${hk}/maintenance-log`, NO_BODY, '/maintenance-log'],
    ['POST', `${hk}/maintenance-log`, { description: 'Probe' }, '/maintenance-log'],
  ]);
  assert.equal((await call('GET', `${hk}/dashboard`, NO_BODY)).status, 200, 'answers again');
});

test('rewards: an unexpected error in each of the 19 routes is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const rw = '/rewards';
  const base = '/api/v1/rewards';
  await assertAllCentral(base, [
    ['GET', `${rw}/overview`, NO_BODY, '/overview'],
    ['GET', `${rw}/participants`, NO_BODY, '/participants'],
    ['PUT', `${rw}/participants/${ADMIN}`, { enabled: true }, '/participants/:userId'],
    ['GET', `${rw}/catalog`, NO_BODY, '/catalog'],
    ['POST', `${rw}/catalog`, { name: 'Probe', cost: 1 }, '/catalog'],
    ['POST', `${rw}/bonus`, { user_id: ADMIN, delta: 100 }, '/bonus'],
    ['GET', `${rw}/ledger`, NO_BODY, '/ledger'],
  ]);
  const reward = db.prepare("SELECT id FROM reward_catalog WHERE name = 'Probe'").get().id;
  await assertAllCentral(base, [
    ['PATCH', `${rw}/catalog/${reward}`, { name: 'Probe' }, '/catalog/:id'],
    ['POST', `${rw}/redemptions`, { catalog_id: reward }, '/redemptions'],
    ['GET', `${rw}/redemptions`, NO_BODY, '/redemptions'],
  ]);
  const redemption = db.prepare('SELECT id FROM reward_redemptions WHERE catalog_id = ?').get(reward).id;
  await assertAllCentral(base, [
    ['PATCH', `${rw}/redemptions/${redemption}`, { action: 'fulfill' }, '/redemptions/:id'],
    ['DELETE', `${rw}/catalog/${reward}`, NO_BODY, '/catalog/:id'],
    ['GET', `${rw}/money`, NO_BODY, '/money'],
    ['GET', `${rw}/money/ledger`, NO_BODY, '/money/ledger'],
    ['POST', `${rw}/money/accounts`, { user_id: ADMIN }, '/money/accounts'],
    ['PUT', `${rw}/money/plans/${ADMIN}`, { amount: '1.00', frequency: 'monthly', anchor_day: 1 }, '/money/plans/:userId'],
    ['DELETE', `${rw}/money/plans/${ADMIN}`, NO_BODY, '/money/plans/:userId'],
    ['DELETE', `${rw}/money/accounts/${ADMIN}`, NO_BODY, '/money/accounts/:userId'],
    ['POST', `${rw}/money/entries`, { user_id: ADMIN, amount: '1.00', direction: 'credit' }, '/money/entries'],
  ]);
  assert.equal((await call('GET', `${rw}/overview`, NO_BODY)).status, 200, 'answers again');
});

test('the handled cases keep their own answer and never reach the central handler', async () => {
  logged.error.length = 0;
  const hk = '/housekeeping';
  // POST /worker: a taken username is a 409.
  assert.equal((await call('POST', `${hk}/worker`, { display_name: 'Erste', daily_rate: 1, username: 'erste' })).status, 201);
  assert.deepEqual(await call('POST', `${hk}/worker`, { display_name: 'Doppelt', daily_rate: 1, username: 'erste' }), {
    status: 409, body: { error: 'Username is already taken.', code: 409, reason: 'housekeeping_username_taken' },
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Doppelt'").get().n, 0, 'no account written');

  // PUT /visits/{id}: the deletion lock is a 409, a new receipt without the right a 403.
  const worker = db.prepare('SELECT id FROM housekeeping_workers ORDER BY id LIMIT 1').get().id;
  const visit = (await call('POST', `${hk}/work-sessions/check-in`, { worker_id: worker, daily_rate: 10 })).body.data;
  assert.equal((await call('POST', `${hk}/work-sessions/check-out`, { worker_id: worker })).status, 200);
  const body = { date: '2026-11-18', daily_rate: 11, receipt_document_id: DOC };
  lockDocumentDeletes([DOC]);
  try {
    assert.deepEqual(await call('PUT', `${hk}/visits/${visit.id}`, body), {
      status: 409,
      body: { error: 'The document is currently being deleted. Try again when the operation finishes.', code: 409, reason: 'DOCUMENT_DELETE_IN_PROGRESS' },
    });
  } finally {
    unlockDocumentDeletes([DOC]);
  }
  assert.deepEqual(await call('PUT', `${hk}/visits/${visit.id}`, body, { access: { documents: 'none' } }), {
    status: 403, body: { error: 'Linking a document requires access to documents.', code: 403, reason: 'cross_module_access' },
  });
  const stored = db.prepare('SELECT daily_rate, receipt_document_id FROM housekeeping_work_sessions WHERE id = ?').get(visit.id);
  assert.deepEqual({ ...stored }, { daily_rate: 10, receipt_document_id: null }, 'nothing written');

  // A money input the account refuses (`SplitInputError`) is a 400 on all three ways in.
  const accounts = () => db.prepare('SELECT COUNT(*) AS n FROM reward_money_accounts').get().n;
  const before = accounts();
  const mismatch = { status: 400, body: { error: 'This pocket money account is kept in EUR.', code: 400, reason: 'currency_mismatch' } };
  assert.deepEqual(await call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '1.00', currency: 'USD' }, { actor: 'member' }), mismatch);
  assert.deepEqual(await call('POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.00', direction: 'credit', currency: 'USD' }), mismatch);
  assert.deepEqual(await call('POST', '/rewards/money/accounts', { user_id: CHILD, currency: 'USD' }), mismatch);
  assert.equal(accounts(), before, 'no account opened');
  assert.deepEqual(await call('POST', '/rewards/money/entries', { user_id: MEMBER, amount: '1.5.0', direction: 'credit' }), {
    status: 400, body: { error: 'amount must be a valid decimal string.', code: 400 },
  });
  assert.deepEqual(logged.error, [], 'none reached the central handler');
});
