/**
 * Test: request validation in the six small modules of group 1A (#2810, phase 2 section E)
 * Purpose: reminders, notifications, modules, permissions, email and weather
 *          check every request against the schema of its operation in the
 *          OpenAPI document (`validateRequest()` in every route, after the
 *          gates that answer 403 or 429) before the handler runs. Held here
 *          against the real routers, mounted at their real prefixes in the
 *          order of the app (express.json, defaultEmptyBody, router, error
 *          handler):
 *            - REFUSED: each input of the decided list is a 400 with `fields`
 *              naming it, and the route's own `reason` where the schema
 *              carries it (`x-reason`: `bad_url`, `email_port_invalid`,
 *              `email_from_invalid`, `name_too_short`), else `validation`;
 *            - GATES FIRST: a member gets 403, never a 400 that names fields;
 *            - KEPT: what the routes lived with goes through as before, and
 *              what the schema cannot say still gets the handler's answer;
 *            - THE OWN FRONTEND: every request the app's pages send to these
 *              endpoints passes the middleware of its operation;
 *            - ONE SOURCE: the enums the handlers no longer check themselves
 *              equal their source as a set - `familyRole` the roles of
 *              `permissionCatalog()`, every reminder `entity_type` (and
 *              `types`) `VALID_ENTITY_TYPES`.
 *          No clock is frozen and no answer depends on the day: the reminder
 *          times lie far in the future or are compared as text.
 * Run: npm run test:validate-small-modules-a
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_ALLOW_WEB_INSTALL = 'true';
// Removed at process exit (test/tmp-dir.js).
const MODULES_DIR = tempDir('yuvomi-validate-1a-');
process.env.MODULES_DIR = MODULES_DIR;

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { buildRouter: buildNotificationsRouter } = await import('../server/routes/notifications.js');
const { default: modulesRouter } = await import('../server/routes/modules.js');
const { default: permissionsRouter } = await import('../server/routes/permissions.js');
const { buildRouter: buildEmailRouter } = await import('../server/routes/email.js');
const { buildRouter: buildWeatherRouter } = await import('../server/routes/weather.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { validateRequest } = await import('../server/api/validate-request.ts');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const ADMIN = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin1a','Admin','x','admin')").run().lastInsertRowid);
const MEMBER = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('member1a','Member','x','member','child')").run().lastInsertRowid);
db.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

/** @type {string[]} */
const sentTests = [];
const emailService = {
  getPublicConfig: () => ({}),
  isEnvControlled: () => false,
  /** @param {string} to */
  sendTest: async (to) => { sentTests.push(to); return { ok: true }; },
};
const notificationService = { providers: {}, testChannel: async () => ({ ok: true }) };
const weatherFetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });

const quiet = { warn: () => {}, error: () => {} };
// The install routes count every request per user (10 installs, 30 attempts in
// 10 minutes): each admin request gets an id of its own unless one is named.
let nextLimiterId = 1000;
const app = express();
app.use(express.json());
app.use(defaultEmptyBody);
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const member = req.get('x-actor') === 'member';
  const id = member ? MEMBER : ADMIN;
  req.authUserId = req.path.startsWith('/api/v1/modules/install/') && !member ? nextLimiterId++ : id;
  req.authRole = member ? 'member' : 'admin';
  req.authMethod = 'session';
  req.session = { userId: id, role: req.authRole };
  next();
});
// The order of server/index.js. The stubs carry only what these routes call.
app.use('/api/v1/weather', buildWeatherRouter(/** @type {any} */ ({ cfgGet: () => null, fetchFn: weatherFetch, logger: quiet })));
app.use('/api/v1/reminders', remindersRouter);
app.use('/api/v1/modules', modulesRouter);
app.use('/api/v1/email', buildEmailRouter(/** @type {any} */ ({ emailService, resolveUserEmail: () => null })));
app.use('/api/v1/notifications', buildNotificationsRouter(/** @type {any} */ ({ notificationService })));
app.use('/api/v1/permissions', permissionsRouter);
app.use(createErrorHandler(quiet));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {{ json?: unknown, raw?: Buffer, member?: boolean }} [options] json left out: no body
 */
async function call(method, route, { json, raw, member = false } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (member) headers['x-actor'] = 'member';
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (raw !== undefined) headers['Content-Type'] = 'application/zip';
  const res = await fetch(`${baseUrl}/api/v1${route}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : /** @type {any} */ (raw),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 204 or an asset */ }
  return { status: res.status, body };
}

/**
 * The 400 of the middleware: exactly these fields, the reason of the first.
 * @param {{ status: number, body: any }} res
 * @param {Array<{ path: string, rule: string, reason?: string }>} fields
 */
function assertRefused(res, fields) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: SENTENCE, code: 400, reason: fields[0].reason ?? 'validation', fields });
}

/**
 * A 400 of the handler, not of the schema: no `fields`.
 * @param {{ status: number, body: any }} res
 * @param {string | undefined} reason
 */
function assertHandlerRefused(res, reason) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.notEqual(res.body?.error, SENTENCE, JSON.stringify(res.body));
  assert.equal(res.body?.fields, undefined);
  assert.equal(res.body?.reason, reason);
}

/**
 * @param {{ status: number, body: any }} res
 * @param {number} status
 */
function assertPassed(res, status) {
  assert.equal(res.status, status, JSON.stringify(res.body));
}

/** @param {{ status: number, body: any }} res */
function assertForbidden(res) {
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body?.fields, undefined, 'a member learns no field names');
}

function newTask(owner = ADMIN) {
  return Number(db.prepare("INSERT INTO tasks (title, category, status, created_by) VALUES ('Steuer', 'Sonstiges', 'open', ?)").run(owner).lastInsertRowid);
}

const NOT_DIGITS = ['12abc', '5.0', '1e2', '0x10'];

// ── Reminders ───────────────────────────────────────────────────────────────

test('reminders: a path id that is not plain digits is a 400', async () => {
  for (const id of NOT_DIGITS) {
    assertRefused(await call('PATCH', `/reminders/${id}/dismiss`, { json: {} }), [{ path: 'path/id', rule: 'type' }]);
    assertRefused(await call('DELETE', `/reminders/${id}`), [{ path: 'path/id', rule: 'type' }]);
  }
});

test('reminders: entity_id in the query must be plain digits, once (1abc, 1.9, repeated)', async () => {
  const task = newTask();
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['GET', '/reminders/all', undefined],
    ['GET', '/reminders', undefined],
    ['PUT', '/reminders', { remind_ats: [] }],
    ['DELETE', '/reminders', undefined],
  ])) {
    for (const id of [`${task}abc`, '1.9']) {
      assertRefused(await call(method, `${route}?entity_type=task&entity_id=${id}`, { json }), [{ path: 'query/entity_id', rule: 'type' }]);
    }
    assertRefused(await call(method, `${route}?entity_type=task&entity_id=${task}&entity_id=2`, { json }), [{ path: 'query/entity_id', rule: 'type' }]);
    assertRefused(await call(method, `${route}?entity_type=nope&entity_id=${task}`, { json }), [{ path: 'query/entity_type', rule: 'enum' }]);
    assertRefused(await call(method, `${route}?entity_id=${task}`, { json }), [{ path: 'query/entity_type', rule: 'required' }]);
  }
});

test('reminders: POST takes no id that is not whole, no list as remind_at, no unknown origin', async () => {
  const task = newTask();
  const ok = { entity_type: 'task', entity_id: task, remind_at: '2099-01-01T10:00:00' };
  // anyOf names each branch that failed, then itself.
  assertRefused(await call('POST', '/reminders', { json: { ...ok, entity_id: `${task}abc` } }),
    [{ path: 'body/entity_id', rule: 'type' }, { path: 'body/entity_id', rule: 'pattern' }, { path: 'body/entity_id', rule: 'anyOf' }]);
  assertRefused(await call('POST', '/reminders', { json: { ...ok, entity_id: 1.9 } }),
    [{ path: 'body/entity_id', rule: 'type' }, { path: 'body/entity_id', rule: 'anyOf' }]);
  assertRefused(await call('POST', '/reminders', { json: { ...ok, entity_id: true } }),
    [{ path: 'body/entity_id', rule: 'type' }, { path: 'body/entity_id', rule: 'anyOf' }]);
  assertRefused(await call('POST', '/reminders', { json: { ...ok, remind_at: ['2099-01-01T10:00'] } }), [{ path: 'body/remind_at', rule: 'type' }]);
  assertRefused(await call('POST', '/reminders', { json: { ...ok, remind_at: '2099-01-01t10:00:00z' } }), [{ path: 'body/remind_at', rule: 'pattern' }]);
  assertRefused(await call('POST', '/reminders', { json: { ...ok, entity_type: 'nope' } }), [{ path: 'body/entity_type', rule: 'enum' }]);
  assertRefused(await call('POST', '/reminders', { json: [] }), [{ path: 'body', rule: 'type' }]);
  assertRefused(await call('POST', '/reminders'), [{ path: 'body', rule: 'required' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE entity_id = ?').get(task).n, 0, 'nothing written');
});

test('reminders: PUT needs remind_ats as a list of times, and the 400 comes before the 404', async () => {
  const task = newTask();
  const route = `/reminders?entity_type=task&entity_id=${task}`;
  assertRefused(await call('PUT', route, { json: { remind_ats: '2099-01-01' } }), [{ path: 'body/remind_ats', rule: 'type' }]);
  assertRefused(await call('PUT', route, { json: {} }), [{ path: 'body/remind_ats', rule: 'required' }]);
  assertRefused(await call('PUT', route, { json: { remind_ats: [null] } }), [{ path: 'body/remind_ats/0', rule: 'type' }]);
  assertRefused(await call('PUT', route), [{ path: 'body', rule: 'required' }]);
  // Before #2810 an unknown entity answered 404 here.
  assertRefused(await call('PUT', '/reminders?entity_type=task&entity_id=999999', { json: { remind_ats: 'x' } }), [{ path: 'body/remind_ats', rule: 'type' }]);
});

test('reminders: the window edges of /upcoming have the shape the handler reads, not RFC 3339 date-time', async () => {
  for (const from of ['2099-01-01t10:00:00z', '2099-01-01 10:00', '2099-01-01T10:00+02']) {
    assertRefused(await call('GET', `/reminders/upcoming?from=${encodeURIComponent(from)}&to=2099-01-02`), [{ path: 'query/from', rule: 'pattern' }]);
  }
  for (const [from, to] of [['2099-01-01', '2099-01-02'], ['2099-01-01T10:00', '2099-01-02T10:00:00.5'], ['2099-01-01T10:00:00Z', '2099-01-02T10:00:00%2B0200']]) {
    const res = await call('GET', `/reminders/upcoming?from=${from}&to=${to}`);
    assertPassed(res, 200);
    assert.deepEqual(res.body, { data: [] });
  }
  // What the schema cannot say stays the handler's.
  assertHandlerRefused(await call('GET', '/reminders/upcoming?from=2099-02-31&to=2099-03-01'), undefined);
  assertHandlerRefused(await call('GET', '/reminders/upcoming?from=2099-01-01&to=2099-02-01'), undefined);
  assertHandlerRefused(await call('GET', '/reminders/upcoming?from=2099-01-01&to=2099-01-02&types=task&types=event'), undefined);
  assertRefused(await call('GET', '/reminders/upcoming?to=2099-01-02'), [{ path: 'query/from', rule: 'required' }]);
});

test('reminders: audience is text; once', async () => {
  assertPassed(await call('GET', '/reminders/pending?audience=household'), 200);
  assertPassed(await call('GET', '/reminders/pending?audience=foo'), 200);
  assertRefused(await call('GET', '/reminders/pending?audience=household&audience=x'), [{ path: 'query/audience', rule: 'type' }]);
});

test('reminders: kept - entity_id as digit text, every time shape the handler reads, derived origins keep their sentence', async () => {
  const task = newTask();
  for (const [entityId, remindAt, stored] of /** @type {Array<[unknown, string, string]>} */ ([
    [String(task), '2099-01-01T10:00:00', '2099-01-01T10:00:00'],
    [task, '2099-01-01', '2099-01-01T00:00:00'],
    [task, '2099-01-01T10:00', '2099-01-01T10:00:00'],
    [task, '2099-01-01T18:00:00+0200', '2099-01-01T16:00:00'],
    [task, '2099-01-01T18:00:00.123Z', '2099-01-01T18:00:00'],
  ])) {
    const res = await call('POST', '/reminders', { json: { entity_type: 'task', entity_id: entityId, remind_at: remindAt } });
    assertPassed(res, 201);
    assert.equal(res.body.data.remind_at, stored);
  }
  const derived = await call('POST', '/reminders', { json: { entity_type: 'pantry_item', entity_id: 1, remind_at: '2099-01-01' } });
  assertHandlerRefused(derived, undefined);
  assert.match(derived.body.error, /pantry_item/);
  assertHandlerRefused(await call('POST', '/reminders', { json: { entity_type: 'task', entity_id: 0, remind_at: '2099-01-01' } }), undefined);
  assertHandlerRefused(await call('GET', `/reminders?entity_type=task&entity_id=0`), undefined);
  const negative = await call('GET', '/reminders?entity_type=task&entity_id=-1');
  assertPassed(negative, 200);
  assert.equal(negative.body.data, null);
});

test('reminders: kept - PUT counts instants after conversion, takes an empty list, the cap stays the handler\'s', async () => {
  const task = newTask();
  const route = `/reminders?entity_type=task&entity_id=${task}`;
  const sevenNamingThree = ['2099-01-01T10:00', '2099-01-01T10:00:00', '2099-01-01T12:00:00+02:00', '2099-01-02', '2099-01-02T00:00', '2099-01-03T00:00:00Z', '2099-01-03'];
  const res = await call('PUT', route, { json: { remind_ats: sevenNamingThree } });
  assertPassed(res, 200);
  assert.equal(res.body.data.length, 3);
  const six = ['2099-01-01', '2099-01-02', '2099-01-03', '2099-01-04', '2099-01-05', '2099-01-06'];
  const capped = await call('PUT', route, { json: { remind_ats: six } });
  assertHandlerRefused(capped, undefined);
  assert.match(capped.body.error, /At most 5/);
  assertPassed(await call('PUT', route, { json: { remind_ats: [] } }), 200);
});

// ── Notifications ───────────────────────────────────────────────────────────

const NTFY = { provider: 'ntfy', name: 'Family', enabled: true, config: { baseUrl: 'https://ntfy.example', topic: 'family', priority: 'default', authType: 'none' } };

async function newChannel() {
  const res = await call('POST', '/notifications/channels', { json: NTFY });
  assertPassed(res, 201);
  return res.body.data.id;
}

test('notifications: a member gets 403 for an invalid request, never the field names', async () => {
  assertForbidden(await call('POST', '/notifications/channels', { json: { provider: 5 }, member: true }));
  assertForbidden(await call('PUT', '/notifications/channels/12abc', { json: [], member: true }));
});

test('notifications: create refuses a provider that is not exactly known, non-text, non-boolean and non-object fields', async () => {
  for (const [patch, field] of /** @type {Array<[Record<string, unknown>, { path: string, rule: string }]>} */ ([
    [{ provider: ' NTFY ' }, { path: 'body/provider', rule: 'enum' }],
    [{ name: 5 }, { path: 'body/name', rule: 'type' }],
    [{ enabled: 'false' }, { path: 'body/enabled', rule: 'type' }],
    [{ config: null }, { path: 'body/config', rule: 'type' }],
    [{ secrets: null }, { path: 'body/secrets', rule: 'type' }],
    [{ clearSecrets: 5 }, { path: 'body/clearSecrets', rule: 'type' }],
    [{ clearSecrets: 'token' }, { path: 'body/clearSecrets', rule: 'type' }],
    [{ clearSecrets: [5] }, { path: 'body/clearSecrets/0', rule: 'type' }],
  ])) {
    assertRefused(await call('POST', '/notifications/channels', { json: { ...NTFY, ...patch } }), [field]);
  }
  assertRefused(await call('POST', '/notifications/channels', { json: { name: 'x', config: {} } }), [{ path: 'body/provider', rule: 'required' }]);
  assertRefused(await call('POST', '/notifications/channels'), [{ path: 'body', rule: 'required' }]);
});

test('notifications: path ids that are not plain digits are a 400, and the 400 comes before the 404', async () => {
  for (const id of NOT_DIGITS) {
    assertRefused(await call('PUT', `/notifications/channels/${id}`, { json: { enabled: true } }), [{ path: 'path/id', rule: 'type' }]);
    assertRefused(await call('DELETE', `/notifications/channels/${id}`), [{ path: 'path/id', rule: 'type' }]);
    assertRefused(await call('POST', `/notifications/channels/${id}/test`, { json: {} }), [{ path: 'path/id', rule: 'type' }]);
  }
  assertRefused(await call('PUT', '/notifications/channels/999999', { json: { enabled: 'x' } }), [{ path: 'body/enabled', rule: 'type' }]);
});

test('notifications: kept - a partial update, an empty name stays the handler\'s, a list of secret names', async () => {
  const id = await newChannel();
  const partial = await call('PUT', `/notifications/channels/${id}`, { json: { enabled: false } });
  assertPassed(partial, 200);
  assert.equal(partial.body.data.enabled, false);
  assertPassed(await call('PUT', `/notifications/channels/${id}`, { json: { clearSecrets: ['token'] } }), 200);
  assertRefused(await call('PUT', `/notifications/channels/${id}`, { json: { provider: 'bogus' } }), [{ path: 'body/provider', rule: 'enum' }]);
  for (const name of ['', '   ']) {
    const res = await call('POST', '/notifications/channels', { json: { ...NTFY, name } });
    assertHandlerRefused(res, undefined);
    assert.match(res.body.error, /name is required/);
  }
  assertHandlerRefused(await call('PUT', '/notifications/channels/0', { json: {} }), undefined);
  assertPassed(await call('POST', `/notifications/channels/${id}/test`, { json: {} }), 200);
  assertPassed(await call('DELETE', `/notifications/channels/${id}`), 200);
});

// ── Modules ─────────────────────────────────────────────────────────────────

test('modules: a member gets 403 for an invalid install, never the field names', async () => {
  assertForbidden(await call('POST', '/modules/install/github', { json: { url: 5 }, member: true }));
  assertForbidden(await call('POST', '/modules/install/zip?overwrite=yes', { raw: Buffer.from('x'), member: true }));
  assertForbidden(await call('PATCH', '/modules/x', { json: { enabled: 'yes' }, member: true }));
});

test('modules: overwrite of a ZIP install is 0 or 1, once; path is at most 500 characters as sent', async () => {
  for (const query of ['overwrite=true', 'overwrite=yes']) {
    assertRefused(await call('POST', `/modules/install/zip?${query}`, { raw: Buffer.from('x') }), [{ path: 'query/overwrite', rule: 'enum' }]);
  }
  assertRefused(await call('POST', '/modules/install/zip?overwrite=1&overwrite=1', { raw: Buffer.from('x') }), [{ path: 'query/overwrite', rule: 'type' }]);
  assertRefused(await call('POST', `/modules/install/zip?path=${' '.repeat(2)}${'y'.repeat(499)}`, { raw: Buffer.from('x') }), [{ path: 'query/path', rule: 'maxLength' }]);
  // Kept: the app's query, and an empty archive is still the handler's not_zip.
  assertHandlerRefused(await call('POST', '/modules/install/zip?overwrite=1&path=', { raw: Buffer.alloc(0) }), 'not_zip');
});

test('modules: a GitHub install keeps bad_url for what answered bad_url before; other fields are validation', async () => {
  const BAD_URL = 'bad_url';
  assertRefused(await call('POST', '/modules/install/github', { json: { url: 5 } }), [{ path: 'body/url', rule: 'type', reason: BAD_URL }]);
  assertRefused(await call('POST', '/modules/install/github', { json: {} }), [{ path: 'body/url', rule: 'required', reason: BAD_URL }]);
  assertRefused(await call('POST', '/modules/install/github', { json: [] }), [{ path: 'body', rule: 'type', reason: BAD_URL }]);
  assertRefused(await call('POST', '/modules/install/github'), [{ path: 'body', rule: 'required', reason: BAD_URL }]);
  assertRefused(await call('POST', '/modules/install/github', { json: { url: `https://github.com/${'a'.repeat(2000)}` } }), [{ path: 'body/url', rule: 'maxLength', reason: BAD_URL }]);
  assertRefused(await call('POST', '/modules/install/github', { json: { url: 'owner/repo', ref: 5 } }), [{ path: 'body/ref', rule: 'type' }]);
  assertRefused(await call('POST', '/modules/install/github', { json: { url: 'owner/repo', path: 5 } }), [{ path: 'body/path', rule: 'type' }]);
  assertRefused(await call('POST', '/modules/install/github', { json: { url: 'owner/repo', overwrite: '1' } }), [{ path: 'body/overwrite', rule: 'type' }]);
  // Kept: an empty or malformed URL is the handler's bad_url, before any download.
  assertHandlerRefused(await call('POST', '/modules/install/github', { json: { url: '' } }), BAD_URL);
  assertHandlerRefused(await call('POST', '/modules/install/github', { json: { url: '   ' } }), BAD_URL);
});

test('modules: enabled is a boolean, an asset needs its path, admin is text once', async () => {
  assertRefused(await call('PATCH', '/modules/x', { json: { enabled: 'yes' } }), [{ path: 'body/enabled', rule: 'type' }]);
  assertRefused(await call('PATCH', '/modules/x', { json: {} }), [{ path: 'body/enabled', rule: 'required' }]);
  // `/assets/:id/` matches the optional wildcard with no path; before #2810 the
  // route answered 404 for it. Without the slash no route matches at all.
  assertRefused(await call('GET', '/modules/assets/nope/'), [{ path: 'path/assetPath', rule: 'required' }]);
  assert.equal((await call('GET', '/modules/assets/nope')).status, 404);
  assert.equal((await call('GET', '/modules/assets/nope/index.js')).status, 404);
  assertPassed(await call('GET', '/modules?admin=1'), 200);
  assertPassed(await call('GET', '/modules?admin=true'), 200);
  assertRefused(await call('GET', '/modules?admin=1&admin=1'), [{ path: 'query/admin', rule: 'type' }]);
});

// ── Permissions ─────────────────────────────────────────────────────────────

const PAYLOAD = { modules: { tasks: 'read' }, widgets: {}, capabilities: { notes_edit_others: 'allow' } };

test('permissions: a member gets 403 for an invalid request, never the field names', async () => {
  assertForbidden(await call('PUT', '/permissions/role/child', { json: [], member: true }));
  assertForbidden(await call('GET', '/permissions/user/12abc', { member: true }));
});

test('permissions: no body, a list, null or a non-object map is a 400, and nothing is wiped', async () => {
  assertPassed(await call('PUT', '/permissions/role/child', { json: PAYLOAD }), 200);
  const stored = () => db.prepare("SELECT COUNT(*) AS n FROM access_permissions WHERE subject_type = 'role' AND subject_id = 'child'").get().n;
  const before = stored();
  assert.ok(before > 0);
  for (const route of ['/permissions/role/child', `/permissions/user/${MEMBER}`]) {
    assertRefused(await call('PUT', route), [{ path: 'body', rule: 'required' }]);
    assertRefused(await call('PUT', route, { json: [] }), [{ path: 'body', rule: 'type' }]);
    assertRefused(await call('PUT', route, { json: { ...PAYLOAD, capabilities: null } }), [{ path: 'body/capabilities', rule: 'type' }]);
    assertRefused(await call('PUT', route, { json: { ...PAYLOAD, modules: 'abc' } }), [{ path: 'body/modules', rule: 'type' }]);
    assertRefused(await call('PUT', route, { json: { ...PAYLOAD, widgets: [] } }), [{ path: 'body/widgets', rule: 'type' }]);
    assertRefused(await call('PUT', route, { json: { ...PAYLOAD, modules: { tasks: 'bogus' } } }), [{ path: 'body/modules/tasks', rule: 'enum' }]);
    assertRefused(await call('PUT', route, { json: { ...PAYLOAD, capabilities: { notes_edit_others: 'read' } } }), [{ path: 'body/capabilities/notes_edit_others', rule: 'enum' }]);
  }
  assert.equal(stored(), before, 'no refused request wiped the rows');
});

test('permissions: userId is plain digits; the 400 comes before the 404 and the admin target', async () => {
  for (const id of ['12abc', '1.5', ...NOT_DIGITS]) {
    assertRefused(await call('GET', `/permissions/user/${id}`), [{ path: 'path/userId', rule: 'type' }]);
    assertRefused(await call('PUT', `/permissions/user/${id}`, { json: PAYLOAD }), [{ path: 'path/userId', rule: 'type' }]);
  }
  assertRefused(await call('PUT', '/permissions/user/999999', { json: [] }), [{ path: 'body', rule: 'type' }]);
  assertRefused(await call('PUT', `/permissions/user/${ADMIN}`, { json: [] }), [{ path: 'body', rule: 'type' }]);
  assertRefused(await call('GET', '/permissions/role/Child'), [{ path: 'path/familyRole', rule: 'enum' }]);
});

test('permissions: kept - unknown keys stay the handler\'s, empty maps clear, an unknown member is 404', async () => {
  const unknown = await call('PUT', '/permissions/role/child', { json: { modules: { nope: 'read' } } });
  assertHandlerRefused(unknown, undefined);
  assert.match(unknown.body.error, /Unknown module/);
  assertPassed(await call('PUT', `/permissions/user/${MEMBER}`, { json: { modules: {}, widgets: {}, capabilities: {} } }), 200);
  assertPassed(await call('PUT', '/permissions/role/child', { json: { modules: {}, widgets: {} } }), 200);
  assert.equal((await call('GET', '/permissions/user/-5')).status, 404);
  assertHandlerRefused(await call('PUT', `/permissions/user/${ADMIN}`, { json: PAYLOAD }), undefined);
});

// ── Email ───────────────────────────────────────────────────────────────────

test('email: a member gets 403 for an invalid request, never the field names', async () => {
  assertForbidden(await call('PUT', '/email/config', { json: { port: 'x' }, member: true }));
  assertForbidden(await call('PUT', '/email/config', { member: true }));
});

test('email: port is a whole number 1..65535 or null, and keeps email_port_invalid', async () => {
  const PORT = 'email_port_invalid';
  for (const port of ['587', true, [587], '', 1.5]) {
    assertRefused(await call('PUT', '/email/config', { json: { port } }), [{ path: 'body/port', rule: 'type', reason: PORT }]);
  }
  assertRefused(await call('PUT', '/email/config', { json: { port: 0 } }), [{ path: 'body/port', rule: 'minimum', reason: PORT }]);
  assertRefused(await call('PUT', '/email/config', { json: { port: 70000 } }), [{ path: 'body/port', rule: 'maximum', reason: PORT }]);
});

test('email: fromAddress that is no text keeps email_from_invalid; other fields are validation; the body is required', async () => {
  for (const fromAddress of [5, true, ['a@b']]) {
    assertRefused(await call('PUT', '/email/config', { json: { fromAddress } }), [{ path: 'body/fromAddress', rule: 'type', reason: 'email_from_invalid' }]);
  }
  assertRefused(await call('PUT', '/email/config', { json: { host: 5 } }), [{ path: 'body/host', rule: 'type' }]);
  assertRefused(await call('PUT', '/email/config', { json: { fromName: {} } }), [{ path: 'body/fromName', rule: 'type' }]);
  assertRefused(await call('PUT', '/email/config', { json: { secure: null } }), [{ path: 'body/secure', rule: 'type' }]);
  assertRefused(await call('PUT', '/email/config', { json: { secure: ['ssl'] } }), [{ path: 'body/secure', rule: 'type' }]);
  assertRefused(await call('PUT', '/email/config', { json: { pass: 5 } }), [{ path: 'body/pass', rule: 'type' }]);
  assertRefused(await call('PUT', '/email/config', { json: { clearPassword: 'true' } }), [{ path: 'body/clearPassword', rule: 'type' }]);
  // Before #2810 a missing body was a 200 that stored nothing.
  assertRefused(await call('PUT', '/email/config'), [{ path: 'body', rule: 'required' }]);
  assertRefused(await call('POST', '/email/test', { json: { to: 5 } }), [{ path: 'body/to', rule: 'type' }]);
  assertRefused(await call('POST', '/email/test', { json: { to: null } }), [{ path: 'body/to', rule: 'type' }]);
});

test('email: kept - null clears, an empty object saves nothing, the address shape stays the handler\'s', async () => {
  assertPassed(await call('PUT', '/email/config', { json: { host: 'smtp.example', port: 587, fromAddress: 'family@example' } }), 200);
  assertPassed(await call('PUT', '/email/config', { json: { host: null, port: null, user: null, fromAddress: null, fromName: null } }), 200);
  const cleared = db.prepare("SELECT key, value FROM sync_config WHERE key IN ('email_smtp_host', 'email_smtp_port', 'email_from_address')").all();
  assert.deepEqual(cleared.map((/** @type {any} */ row) => row.value), ['', '', '']);
  assertPassed(await call('PUT', '/email/config', { json: {} }), 200);
  assertHandlerRefused(await call('PUT', '/email/config', { json: { fromAddress: ' no-address ' } }), 'email_from_invalid');
  assertPassed(await call('PUT', '/email/config', { json: { fromAddress: '' } }), 200);
  assertHandlerRefused(await call('POST', '/email/test'), 'email_no_recipient');
  assertPassed(await call('POST', '/email/test', { json: { to: 'admin@example' } }), 200);
  assert.deepEqual(sentTests, ['admin@example']);
});

// ── Weather ─────────────────────────────────────────────────────────────────

test('weather: a missing, empty or repeated place name keeps name_too_short', async () => {
  const SHORT = 'name_too_short';
  assertRefused(await call('GET', '/weather/geocode'), [{ path: 'query/name', rule: 'required', reason: SHORT }]);
  assertRefused(await call('GET', '/weather/geocode?name='), [{ path: 'query/name', rule: 'minLength', reason: SHORT }]);
  assertRefused(await call('GET', '/weather/geocode?name=Berlin&name=Wien'), [{ path: 'query/name', rule: 'type', reason: SHORT }]);
});

test('weather: lang and city are text, once; an icon code is 2 to 4 letters or digits', async () => {
  assertRefused(await call('GET', '/weather/geocode?name=Berlin&lang=de&lang=en'), [{ path: 'query/lang', rule: 'type' }]);
  assertRefused(await call('GET', '/weather?city=a&city=b'), [{ path: 'query/city', rule: 'type' }]);
  assertRefused(await call('GET', '/weather?lang=de&lang=en'), [{ path: 'query/lang', rule: 'type' }]);
  for (const code of ['a', 'abcde', 'a-b']) {
    assertRefused(await call('GET', `/weather/icon/${code}`), [{ path: 'path/code', rule: 'pattern' }]);
  }
});

test('weather: kept - the exact length after trim stays the handler\'s, any lang is read leniently', async () => {
  assertHandlerRefused(await call('GET', `/weather/geocode?name=${encodeURIComponent(' a ')}`), 'name_too_short');
  // One code point, two UTF-16 units: the route takes it, so no minLength 2 in the schema.
  assertPassed(await call('GET', `/weather/geocode?name=${encodeURIComponent('😀')}`), 200);
  assertHandlerRefused(await call('GET', `/weather/geocode?name=${'x'.repeat(101)}`), 'name_too_long');
  assertHandlerRefused(await call('GET', `/weather/geocode?name=${'😀'.repeat(51)}`), 'name_too_long');
  assertPassed(await call('GET', `/weather/geocode?name=${encodeURIComponent(`  ${'x'.repeat(100)}`)}`), 200);
  for (const lang of ['de-AT', 'DE', 'xx', '']) {
    assertPassed(await call('GET', `/weather/geocode?name=Wien&lang=${lang}`), 200);
  }
  const weather = await call('GET', '/weather?lang=xx&city=Berlin');
  assertPassed(weather, 200);
  assert.equal(weather.body.data, null);
});

// ── THE OWN FRONTEND: every request it sends passes its operation ──────────

/**
 * The middleware of the app document for one operation, called as Express
 * would: true when it lets the request through.
 * @param {string} method
 * @param {string} mount
 * @param {string} pattern
 * @param {{ params?: Record<string, unknown>, query?: Record<string, unknown>, body?: unknown }} request
 */
function passes(method, mount, pattern, { params = {}, query = {}, body } = {}) {
  /** @type {unknown} */
  let outcome = 'not called';
  const req = { method, baseUrl: mount, route: { path: pattern }, params, query, body };
  validateRequest()(req, {}, (/** @type {unknown} */ err) => { outcome = err; });
  if (outcome === undefined) return true;
  const fields = /** @type {any} */ (outcome)?.fields ?? /** @type {any} */ (outcome)?.details?.fields;
  return JSON.stringify(fields ?? outcome);
}

/**
 * Each entry: where it is sent from, the operation and the request exactly as
 * that call site builds it. Query values are the strings Express hands on.
 * @type {Array<[string, string, string, string, { params?: Record<string, unknown>, query?: Record<string, unknown>, body?: unknown }]>}
 */
const FRONTEND_CALLS = [
  // public/reminders.js and public/pages/dashboard.js (bell, wall)
  ['reminders.js pending', 'GET', '/api/v1/reminders', '/pending', {}],
  ['dashboard.js pending on a wall', 'GET', '/api/v1/reminders', '/pending', { query: { audience: 'household' } }],
  ['reminders.js dismiss', 'PATCH', '/api/v1/reminders', '/:id/dismiss', { params: { id: '42' }, body: {} }],
  // public/pages/tasks.js: load, save (the id as a number since #2810; the page
  // itself runs in test:module-readonly-ui), remove
  ['tasks.js load', 'GET', '/api/v1/reminders', '/', { query: { entity_type: 'task', entity_id: '12' } }],
  ['tasks.js save', 'POST', '/api/v1/reminders', '/', { body: { entity_type: 'task', entity_id: 12, remind_at: '2099-01-01T08:00:00' } }],
  ['tasks.js remove', 'DELETE', '/api/v1/reminders', '/', { query: { entity_type: 'task', entity_id: '12' } }],
  // public/pages/calendar.js: load, save the set (naive UTC, at most five), remove
  ['calendar.js load', 'GET', '/api/v1/reminders', '/all', { query: { entity_type: 'event', entity_id: '7' } }],
  ['calendar.js save', 'PUT', '/api/v1/reminders', '/', { query: { entity_type: 'event', entity_id: '7' }, body: { remind_ats: ['2099-01-01T07:45:00', '2099-01-01T07:00:00'] } }],
  ['calendar.js remove', 'DELETE', '/api/v1/reminders', '/', { query: { entity_type: 'event', entity_id: '7' } }],
  // public/settings/pages/notifications.js through public/api.js
  ['notifications.js providers', 'GET', '/api/v1/notifications', '/providers', {}],
  ['notifications.js list', 'GET', '/api/v1/notifications', '/channels', {}],
  ['notifications.js create ntfy', 'POST', '/api/v1/notifications', '/channels', { body: { provider: 'ntfy', name: 'Familie', enabled: true, config: { baseUrl: 'https://ntfy.sh', topic: 'family', priority: 'default', authType: 'token' }, secrets: { token: 'tk' } } }],
  ['notifications.js create gotify', 'POST', '/api/v1/notifications', '/channels', { body: { provider: 'gotify', name: '', enabled: false, config: { baseUrl: 'https://gotify.example', priority: 5 } } }],
  ['notifications.js edit', 'PUT', '/api/v1/notifications', '/channels/:id', { params: { id: '3' }, body: { provider: 'email', name: 'Mail', enabled: true, config: { toAddress: 'a@b.example' } } }],
  ['notifications.js test', 'POST', '/api/v1/notifications', '/channels/:id/test', { params: { id: '3' }, body: {} }],
  ['notifications.js delete', 'DELETE', '/api/v1/notifications', '/channels/:id', { params: { id: '3' } }],
  // router.js, boot-fetch.js and the module settings pages
  ['router.js list', 'GET', '/api/v1/modules', '/', {}],
  ['modules-active.js admin list', 'GET', '/api/v1/modules', '/', { query: { admin: '1' } }],
  ['modules-active.js info', 'GET', '/api/v1/modules', '/install/info', {}],
  ['modules-active.js enable', 'PATCH', '/api/v1/modules', '/:id', { params: { id: 'weather-plus' }, body: { enabled: true } }],
  ['router.js disable', 'PATCH', '/api/v1/modules', '/:id', { params: { id: 'weather-plus' }, body: { enabled: false } }],
  ['modules-active.js delete', 'DELETE', '/api/v1/modules', '/:id', { params: { id: 'weather-plus' } }],
  ['modules-install.js github', 'POST', '/api/v1/modules', '/install/github', { body: { url: 'https://github.com/owner/repo' } }],
  ['modules-install.js github retry', 'POST', '/api/v1/modules', '/install/github', { body: { url: 'owner/repo', overwrite: true, path: '' } }],
  ['modules-install.js zip', 'POST', '/api/v1/modules', '/install/zip', { query: {} }],
  ['modules-install.js zip retry', 'POST', '/api/v1/modules', '/install/zip', { query: { overwrite: '1', path: 'packages/a' } }],
  ['extension-i18n.js asset', 'GET', '/api/v1/modules', '/assets/:id/{*assetPath}', { params: { id: 'weather-plus', assetPath: ['locales', 'de.json'] } }],
  // public/settings/pages/admin-permissions.js, admin-family.js, admin-api.js
  ['admin-permissions.js catalog', 'GET', '/api/v1/permissions', '/catalog', {}],
  ['admin-permissions.js role', 'GET', '/api/v1/permissions', '/role/:familyRole', { params: { familyRole: 'child' } }],
  ['admin-permissions.js member', 'GET', '/api/v1/permissions', '/user/:userId', { params: { userId: '5' } }],
  ['admin-permissions.js save role', 'PUT', '/api/v1/permissions', '/role/:familyRole', { params: { familyRole: 'child' }, body: { modules: { tasks: 'read', 'ext:weather-plus': 'none' }, widgets: { 'weather-plus:now': 'allow' }, capabilities: { notes_edit_others: 'none' } } }],
  ['admin-permissions.js save member', 'PUT', '/api/v1/permissions', '/user/:userId', { params: { userId: '5' }, body: { modules: {}, widgets: {}, capabilities: {} } }],
  // public/settings/pages/admin-email.js through public/api.js
  ['admin-email.js load', 'GET', '/api/v1/email', '/config', {}],
  ['admin-email.js save', 'PUT', '/api/v1/email', '/config', { body: { host: 'smtp.example', secure: 'starttls', user: 'me', fromAddress: 'yuvomi@nas', fromName: 'Yuvomi', port: 587, pass: 'secret' } }],
  ['admin-email.js save all env-locked', 'PUT', '/api/v1/email', '/config', { body: {} }],
  ['admin-email.js test', 'POST', '/api/v1/email', '/test', { body: {} }],
  ['api.js test with recipient', 'POST', '/api/v1/email', '/test', { body: { to: 'me@example' } }],
  // public/pages/dashboard.js and public/settings/weather-location.js
  ['dashboard.js weather', 'GET', '/api/v1/weather', '/', { query: { lang: 'de' } }],
  ['weather-location.js geocode', 'GET', '/api/v1/weather', '/geocode', { query: { name: 'Wien', lang: 'pt-BR' } }],
  ['dashboard.js icon', 'GET', '/api/v1/weather', '/icon/:code', { params: { code: '10d' } }],
];

for (const [site, method, mount, pattern, request] of FRONTEND_CALLS) {
  test(`the own frontend passes the schema: ${site}`, () => {
    assert.equal(passes(method, mount, pattern, request), true);
  });
}

// ── The schema's lists against their one source ─────────────────────────────
// Since #2820 the handlers no longer check the family role or the reminder
// origin themselves: the enum of the operation is the only guard. These copies
// must say exactly what the code knows, in both directions.

const { buildOpenApiSpec } = await import('../server/openapi.js');
const { permissionCatalog } = await import('../server/authorize/index.ts');
const { VALID_ENTITY_TYPES } = await import('../server/routes/reminders.js');
const SPEC = buildOpenApiSpec();

/**
 * The enum of one parameter of one operation of the built document.
 * @param {string} route
 * @param {string} method
 * @param {string} name
 * @param {(schema: any) => unknown} [pick]
 */
function parameterEnum(route, method, name, pick = (schema) => schema.enum) {
  const operation = SPEC.paths[route]?.[method];
  assert.ok(operation, `${method.toUpperCase()} ${route} is in the document`);
  const parameter = (operation.parameters ?? []).find((/** @type {any} */ p) => p.name === name);
  assert.ok(parameter, `${method.toUpperCase()} ${route} has the parameter ${name}`);
  const values = pick(parameter.schema);
  assert.ok(Array.isArray(values) && values.length > 0, `${method.toUpperCase()} ${route}: ${name} carries an enum`);
  return values;
}

/** @param {unknown[]} values */
const asSet = (values) => [...new Set(values)].sort();

test('permissions: the familyRole enum of the document is exactly the roles of permissionCatalog()', () => {
  const roles = permissionCatalog().roles;
  assert.ok(Array.isArray(roles) && roles.length >= 7, 'permissionCatalog().roles is read');
  for (const method of ['get', 'put']) {
    const values = parameterEnum('/api/v1/permissions/role/{familyRole}', method, 'familyRole');
    assert.equal(values.length, new Set(values).size, `${method.toUpperCase()}: no role twice`);
    assert.deepEqual(asSet(values), asSet(roles), `${method.toUpperCase()} /permissions/role/{familyRole}`);
  }
});

test('reminders: every entity_type enum of the document is exactly VALID_ENTITY_TYPES', () => {
  assert.ok(Array.isArray(VALID_ENTITY_TYPES) && VALID_ENTITY_TYPES.length >= 16, 'VALID_ENTITY_TYPES is read');
  const expected = asSet(VALID_ENTITY_TYPES);
  /** @type {Array<[string, unknown[]]>} */
  const lists = [];
  for (const [route, method] of [
    ['/api/v1/reminders/all', 'get'],
    ['/api/v1/reminders', 'get'],
    ['/api/v1/reminders', 'put'],
    ['/api/v1/reminders', 'delete'],
  ]) {
    lists.push([`${method.toUpperCase()} ${route} entity_type`, parameterEnum(route, method, 'entity_type')]);
  }
  lists.push(['GET /api/v1/reminders/upcoming types', parameterEnum('/api/v1/reminders/upcoming', 'get', 'types', (schema) => schema.items?.enum)]);
  const body = SPEC.components.schemas.ReminderCreateInput?.properties?.entity_type?.enum;
  assert.ok(Array.isArray(body), 'ReminderCreateInput.entity_type carries an enum');
  lists.push(['ReminderCreateInput.entity_type', body]);
  for (const [where, values] of lists) {
    assert.equal(values.length, new Set(values).size, `${where}: no type twice`);
    assert.deepEqual(asSet(values), expected, where);
  }
});
