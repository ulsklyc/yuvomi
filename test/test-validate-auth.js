/**
 * Test: request validation in the sign-in, session and own-account routes
 *       (#2810, phase 2 section E, group 12a)
 * Purpose: server/auth.js checks 34 of its 47 routes against the schema of
 *          their operation in the OpenAPI document (`validateRequest()`)
 *          before the handler runs; the 13 administration routes (12b) are
 *          held in test:validate-auth-admin. Held here against the real router at its real prefix
 *          (test/auth-app.js) with the real session:
 *            - THE OWN CALLERS PASS: the bodies the pages send (login, setup,
 *              join, reset, profile, password card, two-factor, signed-in
 *              devices and pairing, Gravatar, the changelog mark), the iOS
 *              app (login, second factor, device, pairing redeem) and the
 *              YunoHost package (setup, form-encoded). The old document
 *              refused the password card (`currentPassword` in camelCase);
 *            - REFUSED: garbage per field is a 400 with `reason:
 *              'validation'` and `fields`; a login with an array as username
 *              signed in before, a number as new password was stored;
 *            - 500 NOW 400: a reset or invitation token that is not text;
 *            - RIGHTS AND SETUP BEFORE SHAPE: after the setup the route
 *              answers 403 (404 in production) whatever the body; an API
 *              token gets 403 at the device routes and at "sign out the
 *              other sessions" whatever the body;
 *            - RATE LIMIT: a schema 400 counts like any failed sign-in, the
 *              sixth of five allowed is a 429 (own process, real limiter);
 *            - SAME ANSWER: a malformed sign-in, reset request, token check
 *              or invitation preview answers the same for an existing and an
 *              unknown account;
 *            - ONE SOURCE: the family roles of server/services/auth-fields.js
 *              equal the CHECK constraint of `users.family_role` and the
 *              rights catalog, the invitation presets equal the catalog.
 *          No network: no OIDC issuer, no SMTP, Gravatar switched off.
 * Run: npm run test:validate-auth
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// The rate limit has its own case in a process of its own; here no limiter may stop a case.
process.env.RATE_LIMIT_MAX_ATTEMPTS = '1000000';
for (const key of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'GRAVATAR_BASE_URL', 'AUTH_ALLOW_PASSWORD_LOGIN']) delete process.env[key];

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { AUTH_PREFIX, createAuthApp } from './auth-app.js';

const dbmod = await import('../server/db.js');
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { hashPassword } = await import('../server/utils/password.js');
const twoFactor = await import('../server/services/two-factor.js');
const { generateCode } = await import('../server/utils/totp.js');
const { permissionCatalog } = await import('../server/authorize/index.ts');
const fields = await import('../server/services/auth-fields.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const PASSWORD = 'correct-horse-1';

const app = await createAuthApp({
  session: sessionMiddleware,
  // server/index.js puts the general API limiter in front; a generous one here.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  routers: [authRouter],
  // Room for a profile picture over the limit of the document (server/index.js takes more as well).
  jsonLimit: '2mb',
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const origin = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
const BASE = `${origin}${AUTH_PREFIX}`;
test.after(() => server.close());

/**
 * A request to the auth router.
 * @param {string} method
 * @param {string} path below /api/v1/auth
 * @param {{ json?: unknown, form?: Record<string, string>, raw?: string, session?: { cookie: string, csrf: string } | null, token?: string }} [options]
 *   json left out (and no form, no raw): no body
 */
async function call(method, path, { json, form, raw, session, token } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {any} */
  let body;
  if (form) body = new URLSearchParams(form);
  else if (raw !== undefined) { headers['Content-Type'] = 'application/json'; body = raw; }
  else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (session) { headers.Cookie = session.cookie; headers['X-CSRF-Token'] = session.csrf; }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  /** @type {any} */
  let data = null;
  try { data = JSON.parse(text); } catch { /* no JSON */ }
  return { status: res.status, body: data, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

/**
 * A 400 of validateRequest() naming the field and its rule.
 * @param {{ status: number, body: any }} res @param {string} path @param {string} rule @param {string} [what]
 */
function refused(res, path, rule, what = '') {
  assert.equal(res.status, 400, `${what} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, what);
  assert.equal(res.body?.reason, 'validation', what);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path && f.rule === rule), `${what}: ${JSON.stringify(res.body.fields)}`);
}

/** @param {{ status: number, body: any }} res @param {string} [what] */
function notSchema(res, what = '') {
  assert.notEqual(res.body?.reason, 'validation', `${what}: ${res.status} ${JSON.stringify(res.body)}`);
}

/**
 * @param {string} username @param {string} role @param {string} [familyRole]
 * @returns {Promise<number>}
 */
async function account(username, role, familyRole = 'other') {
  const hash = await hashPassword(PASSWORD);
  return Number(db.prepare('INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, ?, ?, ?)')
    .run(username, username, hash, role, familyRole).lastInsertRowid);
}

/** @param {string} username @returns {Promise<{ cookie: string, csrf: string }>} */
async function signIn(username) {
  const res = await call('POST', '/login', { json: { username, password: PASSWORD } });
  assert.equal(res.status, 200, `sign in ${username}: ${JSON.stringify(res.body)}`);
  return { cookie: res.cookie, csrf: res.body.csrfToken };
}

/** An unrestricted API token of an account. @param {number} userId @param {string} value */
function apiToken(userId, value) {
  db.prepare(`INSERT INTO api_tokens (name, token_hash, token_prefix, created_by) VALUES ('t', ?, ?, ?)`)
    .run(createHash('sha256').update(value).digest('hex'), value.slice(0, 12), userId);
  return value;
}

// --------------------------------------------------------------------------
// POST /setup: the package contract (YunoHost), before and after the setup
// --------------------------------------------------------------------------

test('POST /setup before the first account: wrong types are a 400 for the field, nothing is created', async () => {
  for (const [json, path] of /** @type {const} */ ([
    [{ username: 5, display_name: 'A', password: 'longenough1' }, 'body/username'],
    [{ username: ['admin'], display_name: 'A', password: 'longenough1' }, 'body/username'],
    [{ username: 'admin', display_name: { a: 1 }, password: 'longenough1' }, 'body/display_name'],
    [{ username: 'admin', display_name: 'A', password: 12345678 }, 'body/password'],
    [{ username: 'admin', display_name: 'A', password: ['longenough1'] }, 'body/password'],
  ])) refused(await call('POST', '/setup', { json }), path, 'type', JSON.stringify(json));
  refused(await call('POST', '/setup', { json: { username: 'admin', display_name: 'A', password: 'x'.repeat(1025) } }), 'body/password', 'maxLength');
  refused(await call('POST', '/setup', { json: { username: 'admin', display_name: 'A', password: 'longenough1', timezone: 5 } }), 'body/timezone', 'type');
  refused(await call('POST', '/setup'), 'body', 'required');
  // An unknown zone as text stays the route's own answer the setup page retries on.
  const zone = await call('POST', '/setup', { json: { username: 'admin', display_name: 'A', password: 'longenough1', timezone: 'Mars/Olympus' } });
  assert.equal(zone.status, 400);
  assert.equal(zone.body.reason, 'invalid_timezone');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

test('POST /setup: the form-encoded body of the YunoHost package creates the admin (201)', async () => {
  // scripts/install of ulsklyc/yuvomi_ynh: curl --data-urlencode username= display_name= password= [timezone=]
  const res = await call('POST', '/setup', {
    form: { username: 'ynhadmin', display_name: 'YNH Admin', password: 'p@ss w0rd/ä&=', timezone: 'Etc/UTC', extra_field: 'ignored' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.user.username, 'ynhadmin');
  assert.equal(res.body.user.role, 'admin');
});

test('POST /setup after the setup: 403, and 404 in production, with a valid and with an invalid body', async () => {
  const valid = { username: 'second', display_name: 'Second', password: 'longenough1' };
  for (const json of [valid, {}, { username: 5 }, undefined]) {
    const res = await call('POST', '/setup', { json });
    assert.equal(res.status, 403, JSON.stringify(json));
    assert.equal(res.body.reason, 'setup_completed');
  }
  const form = await call('POST', '/setup', { form: { username: 'second', display_name: 'S', password: 'longenough1' } });
  assert.equal(form.status, 403);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    for (const json of [valid, {}, { username: 5 }, undefined]) {
      const res = await call('POST', '/setup', { json });
      assert.equal(res.status, 404, JSON.stringify(json));
      assert.deepEqual(res.body, { error: 'Not found.', code: 404 });
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

// The accounts of the remaining cases, made after the setup cases (which need an empty table).
const ADMIN_TOKEN = 'yuvomi_validate_auth_admin_token';
test('the accounts of the remaining cases', async () => {
  const admin = await account('vadmin', 'admin', 'dad');
  await account('vmem', 'member', 'mom');
  await account('vkid', 'member', 'child');
  apiToken(admin, ADMIN_TOKEN);
});

// --------------------------------------------------------------------------
// Sign-in
// --------------------------------------------------------------------------

test('POST /login: the page and the iOS app sign in, as JSON and as a form', async () => {
  const json = await call('POST', '/login', { json: { username: 'vmem', password: PASSWORD } });
  assert.equal(json.status, 200);
  assert.equal(json.body.user.username, 'vmem');
  const form = await call('POST', '/login', { form: { username: 'vmem', password: PASSWORD } });
  assert.equal(form.status, 200);
  // A wrong password stays the route's answer.
  const wrong = await call('POST', '/login', { json: { username: 'vmem', password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  // Empty fields keep the route's own sentence.
  const empty = await call('POST', '/login', { json: { username: '', password: '' } });
  assert.deepEqual(empty.body, { error: 'Username and password are required.', code: 400 });
});

test('POST /login: an array or a number is a 400, an array with a real username no longer signs in', async () => {
  // Before #2810 `["vmem"]` bound as the text "vmem" and signed in (200).
  refused(await call('POST', '/login', { json: { username: ['vmem'], password: PASSWORD } }), 'body/username', 'type', 'username array');
  refused(await call('POST', '/login', { json: { username: 'vmem', password: [PASSWORD] } }), 'body/password', 'type', 'password array');
  refused(await call('POST', '/login', { json: { username: { a: 1 }, password: PASSWORD } }), 'body/username', 'type', 'username object (500 before)');
  refused(await call('POST', '/login', { json: { username: 5, password: PASSWORD } }), 'body/username', 'type', 'username number');
  refused(await call('POST', '/login', { json: { username: 'vmem', password: 12345678 } }), 'body/password', 'type', 'password number');
  refused(await call('POST', '/login', { json: { username: 'v'.repeat(65), password: PASSWORD } }), 'body/username', 'maxLength', 'username 65');
  refused(await call('POST', '/login', { json: { username: 'vmem', password: 'x'.repeat(1025) } }), 'body/password', 'maxLength', 'password 1025');
  refused(await call('POST', '/login', { json: { username: 'vmem' } }), 'body/password', 'required', 'no password');
  refused(await call('POST', '/login'), 'body', 'required', 'no body');
  // 1024 characters reach the handler: a wrong password, not a shape.
  assert.equal((await call('POST', '/login', { json: { username: 'vmem', password: 'x'.repeat(1024) } })).status, 401);
});

test('a malformed sign-in, reset request, token check or preview answers the same for an existing and an unknown account', async () => {
  const pairs = [
    ['POST', '/login', { username: 'vmem', password: 5 }, { username: 'nobody', password: 5 }],
    ['POST', '/login', { username: 'vmem', password: 'x'.repeat(1025) }, { username: 'nobody', password: 'x'.repeat(1025) }],
    ['POST', '/forgot-password', { identifier: ['vmem'] }, { identifier: ['nobody'] }],
    ['POST', '/reset-password/check', { token: ['vmem'] }, { token: ['nobody'] }],
  ];
  for (const [method, path, known, unknown] of pairs) {
    const a = await call(/** @type {string} */ (method), /** @type {string} */ (path), { json: known });
    const b = await call(/** @type {string} */ (method), /** @type {string} */ (path), { json: unknown });
    assert.equal(a.status, 400, `${path} ${JSON.stringify(known)}`);
    assert.deepEqual(a.body, b.body, `${path}: the same answer`);
  }
  const knownForm = await call('POST', '/forgot-password', { json: { identifier: 'vmem' } });
  const unknownForm = await call('POST', '/forgot-password', { json: { identifier: 'nobody' } });
  assert.equal(knownForm.status, 200);
  assert.deepEqual(knownForm.body, unknownForm.body);
  const twice = await call('GET', '/invites/preview?token=a&token=b');
  refused(twice, 'query/token', 'type', 'token twice');
});

// --------------------------------------------------------------------------
// Password reset and invitations
// --------------------------------------------------------------------------

test('reset: the pages pass, a token that is not text is a 400 (500 before), a missing one too', async () => {
  const check = await call('POST', '/reset-password/check', { json: { token: 'not-a-token' } });
  assert.deepEqual(check, { ...check, status: 200, body: { data: { valid: false } } });
  refused(await call('POST', '/reset-password/check', { json: { token: 5 } }), 'body/token', 'type');
  refused(await call('POST', '/reset-password/check', { json: {} }), 'body/token', 'required');
  const reset = await call('POST', '/reset-password', { json: { token: 'not-a-token', password: 'longenough1' } });
  assert.deepEqual(reset.body, { error: 'Invalid or expired token.', code: 400 });
  refused(await call('POST', '/reset-password', { json: { token: 5, password: 'longenough1' } }), 'body/token', 'type', 'token number (500 before)');
  refused(await call('POST', '/reset-password', { json: { token: { a: 1 }, password: 'longenough1' } }), 'body/token', 'type', 'token object (500 before)');
  refused(await call('POST', '/reset-password', { json: { token: 'abc', password: 'x'.repeat(1025) } }), 'body/password', 'maxLength');
  refused(await call('POST', '/forgot-password', { json: {} }), 'body/identifier', 'required');
  // The shortest password stays the handler's rule (after NFC): 4 emoji are 8 code units.
  const short = await call('POST', '/reset-password', { json: { token: 'abc', password: 'short' } });
  assert.deepEqual(short.body, { error: 'Password must be at least 8 characters long.', code: 400 });
});

test('invitations: the join page passes and creates the account, a token that is not text is a 400', async () => {
  const admin = await signIn('vadmin');
  const created = await call('POST', '/invites', { session: admin, json: { display_name: 'Joiner', family_role: 'other', permission_preset: 'restricted', system_admin: false, send_email: false } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { token } = created.body.data;
  const preview = await call('GET', `/invites/preview?token=${encodeURIComponent(token)}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.valid, true);
  assert.equal((await call('GET', '/invites/preview?token=unknown')).body.data.valid, false);
  refused(await call('GET', '/invites/preview'), 'query/token', 'required', 'no token (200 valid:false before)');
  refused(await call('POST', '/invites/accept', { json: { token: 5, password: 'longenough1' } }), 'body/token', 'type', 'token number (500 before)');
  refused(await call('POST', '/invites/accept', { json: { token, username: 'joiner', password: 'x'.repeat(1025) } }), 'body/password', 'maxLength');
  // The SSO-only shape of the join page (no password) passes the document; with password
  // sign-in on the route asks for it in its own sentence.
  const noPassword = await call('POST', '/invites/accept', { json: { token, username: 'joiner', display_name: 'Joiner' } });
  assert.deepEqual(noPassword.body, { error: 'Token and password are required.', code: 400 });
  // public/pages/join.js
  const accepted = await call('POST', '/invites/accept', { json: { token, username: 'joiner', display_name: 'Joiner', password: 'longenough1' } });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
});

// --------------------------------------------------------------------------
// Second factor
// --------------------------------------------------------------------------

test('POST /2fa/verify: a code that is not text is a 400 before the pending sign-in is looked at', async () => {
  refused(await call('POST', '/2fa/verify', { json: { code: 123456 } }), 'body/code', 'type', '401 before');
  refused(await call('POST', '/2fa/verify', { json: { code: 'x'.repeat(65) } }), 'body/code', 'maxLength');
  refused(await call('POST', '/2fa/verify', { json: {} }), 'body/code', 'required');
  const none = await call('POST', '/2fa/verify', { json: { code: '123456' } });
  assert.equal(none.status, 401);
  assert.equal(none.body.reason, 'two_factor_no_pending_sign_in');
});

test('two-factor: setup, enable, verify, recovery codes and disable with the bodies of the page and the app', async () => {
  const id = await account('v2fa', 'member');
  const session = await signIn('v2fa');
  const setup = await call('POST', '/2fa/setup', { session, json: {} });
  assert.equal(setup.status, 200);
  refused(await call('POST', '/2fa/enable', { session, json: { code: 123456 } }), 'body/code', 'type');
  refused(await call('POST', '/2fa/enable', { session, json: {} }), 'body/code', 'required');
  const wrong = await call('POST', '/2fa/enable', { session, json: { code: '000000' } });
  notSchema(wrong, 'a wrong code');
  const enabled = await call('POST', '/2fa/enable', { session, json: { code: generateCode(setup.body.data.secret) } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const codes = enabled.body.data.recovery_codes;

  // Sign-in with the second factor (page and iOS: `{ code }` as text).
  const first = await call('POST', '/login', { json: { username: 'v2fa', password: PASSWORD } });
  assert.equal(first.body.twoFactorRequired, true);
  const pending = { cookie: first.cookie, csrf: '' };
  const bad = await call('POST', '/2fa/verify', { session: pending, json: { code: '000000' } });
  assert.equal(bad.status, 401);
  refused(await call('POST', '/2fa/verify', { session: pending, json: { code: 0 } }), 'body/code', 'type');
  const good = await call('POST', '/2fa/verify', { session: pending, json: { code: codes[0] } });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  const signedIn = { cookie: good.cookie || pending.cookie, csrf: good.body.csrfToken };

  refused(await call('POST', '/2fa/recovery-codes', { session: signedIn, json: { code: 5 } }), 'body/code', 'type');
  const regen = await call('POST', '/2fa/recovery-codes', { session: signedIn, json: { code: codes[1] } });
  assert.equal(regen.status, 200, JSON.stringify(regen.body));
  refused(await call('POST', '/2fa/disable', { session: signedIn, json: { code: ['x'] } }), 'body/code', 'type');
  const off = await call('POST', '/2fa/disable', { session: signedIn, json: { code: regen.body.data.recovery_codes[0] } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(twoFactor.isEnabled(db, id), false);
  // Without two-factor: a malformed code is the 400 of the document before the 409 not_enabled.
  refused(await call('POST', '/2fa/disable', { session: signedIn, json: { code: 'x'.repeat(65) } }), 'body/code', 'maxLength', '409 before');
  const notEnabled = await call('POST', '/2fa/disable', { session: signedIn, json: { code: '123456' } });
  assert.equal(notEnabled.body.reason, 'not_enabled');
});

// --------------------------------------------------------------------------
// Signed-in devices (iOS) and pairing
// --------------------------------------------------------------------------

const IOS_DEVICE = { name: 'iPhone von Mo', platform: 'ios', device_id: 'ABCDEF12-3456-7890' };

test('POST /devices and /devices/pair: an API token gets 403 whatever the body, before the schema', async () => {
  for (const json of [{}, { name: 5 }, IOS_DEVICE, undefined]) {
    const res = await call('POST', '/devices', { token: ADMIN_TOKEN, json });
    assert.equal(res.status, 403, JSON.stringify(json));
    assert.deepEqual(res.body, { error: 'A signed-in device can only be added from a sign-in.', code: 403, reason: 'session_required' });
  }
  for (const json of [{}, { server: 5 }, { server: origin }]) {
    const res = await call('POST', '/devices/pair', { token: ADMIN_TOKEN, json });
    assert.equal(res.status, 403, JSON.stringify(json));
    assert.deepEqual(res.body, { error: 'A pairing code can only be created from a sign-in.', code: 403, reason: 'session_required' });
  }
});

test('devices: the iOS app adds, lists and signs out a device; pairing from the page and redeem from the app pass', async () => {
  const session = await signIn('vkid');
  const added = await call('POST', '/devices', { session, json: IOS_DEVICE });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  refused(await call('POST', '/devices', { session, json: { ...IOS_DEVICE, platform: 'iOS' } }), 'body/platform', 'pattern');
  refused(await call('POST', '/devices', { session, json: { ...IOS_DEVICE, name: 5 } }), 'body/name', 'type');
  const list = await call('GET', '/devices', { session });
  assert.equal(list.status, 200);
  refused(await call('DELETE', `/devices/${added.body.data.id}.0`, { session }), 'path/id', 'type', '1.0');
  const gone = await call('DELETE', `/devices/${added.body.data.id}`, { session });
  assert.equal(gone.status, 200);

  // public/settings/signed-in-devices.js
  const pair = await call('POST', '/devices/pair', { session, json: { server: origin } });
  assert.equal(pair.status, 201, JSON.stringify(pair.body));
  refused(await call('POST', '/devices/pair', { session, json: { server: 5 } }), 'body/server', 'type');
  // YuvomiPairingRedeemer.swift: a wrong code keeps its reason, a body that is no text the schema's.
  const wrongCode = await call('POST', '/devices/pair/redeem', { json: { code: 'WRONG-CODE', ...IOS_DEVICE } });
  assert.equal(wrongCode.status, 400);
  assert.equal(wrongCode.body.reason, 'invalid_pairing_code');
  refused(await call('POST', '/devices/pair/redeem', { json: { code: 5, ...IOS_DEVICE } }), 'body/code', 'type');
  const redeemed = await call('POST', '/devices/pair/redeem', { json: { code: pair.body.data.code, ...IOS_DEVICE } });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));
  const device = { cookie: '', csrf: '' };
  const current = await call('DELETE', '/devices/current', { session: device, token: redeemed.body.credential });
  assert.equal(current.status, 200, JSON.stringify(current.body));
});

test('POST /logout-others: an API token gets 403 before anything else, a browser session ends the others', async () => {
  const res = await call('POST', '/logout-others', { token: ADMIN_TOKEN, json: { any: 'thing' } });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Only a signed-in browser session can sign out other sessions.', code: 403, reason: 'browser_session_required' });
  const session = await signIn('vmem');
  const own = await call('POST', '/logout-others', { session, json: {} });
  assert.equal(own.status, 200);
});

// --------------------------------------------------------------------------
// Own account
// --------------------------------------------------------------------------

test('PATCH /me/password: the body of the password card passes (the old document refused it), camelCase does not', async () => {
  const id = await account('vpass', 'member');
  const session = await signIn('vpass');
  const before = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash;
  // public/settings/pages/personal-account.js
  const changed = await call('PATCH', '/me/password', { session, json: { current_password: PASSWORD, new_password: 'another-pass-2' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.notEqual(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash, before);
  const current = 'another-pass-2';
  refused(await call('PATCH', '/me/password', { session, json: { currentPassword: current, newPassword: 'third-pass-33' } }), 'body/current_password', 'required', 'camelCase');
  refused(await call('PATCH', '/me/password', { session, json: { current_password: current, new_password: 12345678 } }), 'body/new_password', 'type', 'number stored before');
  refused(await call('PATCH', '/me/password', { session, json: { current_password: current, new_password: 'x'.repeat(1025) } }), 'body/new_password', 'maxLength');
  const wrong = await call('PATCH', '/me/password', { session, json: { current_password: 'not-it-at-all', new_password: 'third-pass-33' } });
  assert.equal(wrong.body.reason, 'wrong_password');
});

test('PATCH /me/profile: the body of the profile form passes, garbage per field is a 400', async () => {
  const session = await signIn('vmem');
  // public/settings/pages/personal-account.js, as it sends it
  const full = await call('PATCH', '/me/profile', { session, json: {
    display_name: 'Mo', avatar_color: '#34c759', avatar_data: null, phone: null, email: 'mo@example.com',
    birth_date: '1990-04-12', birth_year_unknown: false,
  } });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  const yearless = await call('PATCH', '/me/profile', { session, json: { birth_date: '2000-02-29', birth_year_unknown: true, phone: '+49 30 123' } });
  assert.equal(yearless.status, 200, JSON.stringify(yearless.body));
  // Nothing to change: no body, `{}`, fields an account does not set on itself.
  assert.equal((await call('PATCH', '/me/profile', { session })).status, 200);
  const ignored = await call('PATCH', '/me/profile', { session, json: { role: 'admin', family_role: 'dad', username: 'hacker' } });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.user.role, 'member');
  assert.equal(ignored.body.user.username, 'vmem');
  for (const [json, path, rule] of /** @type {const} */ ([
    [{ display_name: 5 }, 'body/display_name', 'type'],
    [{ avatar_color: null }, 'body/avatar_color', 'type'],
    [{ avatar_color: '' }, 'body/avatar_color', 'pattern'],
    [{ avatar_color: 'red;position:fixed' }, 'body/avatar_color', 'pattern'],
    [{ avatar_data: '' }, 'body/avatar_data', 'minLength'],
    [{ avatar_data: 5 }, 'body/avatar_data', 'type'],
    [{ avatar_data: `data:image/png;base64,${'A'.repeat(768 * 1024)}` }, 'body/avatar_data', 'maxLength'],
    [{ email: 5 }, 'body/email', 'type'],
    [{ phone: 5 }, 'body/phone', 'type'],
    [{ birth_date: '' }, 'body/birth_date', 'format'],
    [{ birth_date: '1990-02-30' }, 'body/birth_date', 'format'],
    [{ birth_year_unknown: 1 }, 'body/birth_year_unknown', 'type'],
    [{ birth_year_unknown: null }, 'body/birth_year_unknown', 'type'],
  ])) refused(await call('PATCH', '/me/profile', { session, json }), path, rule, JSON.stringify(json).slice(0, 60));
  // The emptiness of a trimmed name stays the route's own sentence.
  const blank = await call('PATCH', '/me/profile', { session, json: { display_name: '   ' } });
  assert.deepEqual(blank.body, { error: 'Display name is required.', code: 400 });
});

test('POST /changelog-seen: the router\'s `{}` and `{ latest }` and no body pass, a number does not', async () => {
  const session = await signIn('vmem');
  for (const json of [{}, { latest: '2.94.0' }, { latest: null }, undefined]) {
    assert.equal((await call('POST', '/changelog-seen', { session, json })).status, 200, JSON.stringify(json));
  }
  refused(await call('POST', '/changelog-seen', { session, json: { latest: 5 } }), 'body/latest', 'type', 'stored "5" before');
  refused(await call('POST', '/changelog-seen', { session, json: { latest: ['1.0'] } }), 'body/latest', 'type');
});

test('POST /me/avatar/gravatar: the page\'s `{ email }` and no body reach the switch, an email that is not text is a 400', async () => {
  const session = await signIn('vmem');
  const page = await call('POST', '/me/avatar/gravatar', { session, json: { email: 'mo@example.com' } });
  assert.equal(page.status, 404);
  assert.equal(page.body.reason, 'gravatar_disabled');
  assert.equal((await call('POST', '/me/avatar/gravatar', { session })).body.reason, 'gravatar_disabled');
  refused(await call('POST', '/me/avatar/gravatar', { session, json: { email: 5 } }), 'body/email', 'type', '404 before');
});

test('only guard: the Gravatar route no longer checks the type of `email` itself, the document does (group 12a, step b)', async () => {
  // The handler compares `email` with the stored address only when it was
  // sent (`!== undefined`); that it is text, only this schema says.
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const operation = /** @type {any} */ (buildOpenApiSpec()).paths[`${AUTH_PREFIX}/me/avatar/gravatar`].post;
  const schema = operation.requestBody.content['application/json'].schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.email.type, 'string');
});

test('only guard: a sent profile colour and the device id are the document\'s rules (group 12b, step b)', async () => {
  // PATCH /me/profile no longer checks the colour itself (the stored one is
  // not the request's); a sent one lands in a style attribute, and only this
  // pattern holds it. DELETE /devices/{id} reads Number(): that the id is
  // plain decimal digits (no `1e1`, ` 5`, `5abc`), only its type says.
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const { COLOR_PATTERN } = await import('../server/utils/datetime-pattern.js');
  const spec = /** @type {any} */ (buildOpenApiSpec());
  let schema = spec.paths[`${AUTH_PREFIX}/me/profile`].patch.requestBody.content['application/json'].schema;
  if (schema.$ref) schema = spec.components.schemas[schema.$ref.split('/').pop()];
  assert.deepEqual([schema.properties.avatar_color.type, schema.properties.avatar_color.pattern], ['string', COLOR_PATTERN]);
  const id = spec.paths[`${AUTH_PREFIX}/devices/{id}`].delete.parameters.find((/** @type {any} */ p) => p.in === 'path' && p.name === 'id');
  assert.deepEqual(id.schema, { type: 'integer', maximum: Number.MAX_SAFE_INTEGER });
});

test('the routes without input stay as they were: me, users, 2fa, devices, oidc, logout, onboarding', async () => {
  const session = await signIn('vmem');
  assert.equal((await call('GET', '/me?x=1', { session })).status, 200);
  assert.equal((await call('GET', '/users', { session })).status, 200);
  assert.equal((await call('GET', '/2fa', { session })).status, 200);
  assert.equal((await call('GET', '/oidc/config')).status, 200);
  assert.equal((await call('GET', '/oidc/start')).status, 404);
  assert.equal((await call('GET', '/oidc/callback?code=x&state=y')).status, 302);
  assert.equal((await call('GET', '/oidc/link', { session })).status, 200);
  assert.equal((await call('POST', '/oidc/link/start', { session, json: {} })).status, 404);
  assert.equal((await call('DELETE', '/oidc/link', { session })).status, 409);
  assert.equal((await call('POST', '/onboarding-seen', { session, json: {} })).status, 200);
  assert.equal((await call('POST', '/logout', { session, json: {} })).status, 200);
  // Anonymous: 401 before any schema.
  assert.equal((await call('PATCH', '/me/profile', { json: { display_name: 5 } })).status, 401);
  assert.equal((await call('POST', '/2fa/enable', { json: { code: 5 } })).status, 401);
});

// --------------------------------------------------------------------------
// The rate limit: a schema 400 counts (own process with the real limiter)
// --------------------------------------------------------------------------

test('POST /login: with RATE_LIMIT_MAX_ATTEMPTS=5 the sixth schema 400 is a 429', () => {
  const child = `
    const { createAuthApp } = await import(${JSON.stringify(new URL('./auth-app.js', import.meta.url).href)});
    const app = await createAuthApp({ session: (await import(${JSON.stringify(new URL('../server/auth.js', import.meta.url).href)})).sessionMiddleware });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.on('listening', r));
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ['x'], password: 5 }),
      });
      const body = await res.json();
      statuses.push([res.status, body.reason ?? null]);
    }
    server.close();
    console.log('RESULT ' + JSON.stringify(statuses));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    env: { ...process.env, RATE_LIMIT_MAX_ATTEMPTS: '5', DB_PATH: ':memory:' },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `${run.stdout.slice(-400)} ${run.stderr.slice(-800)}`);
  assert.deepEqual(JSON.parse(line.slice('RESULT '.length)), [
    [400, 'validation'], [400, 'validation'], [400, 'validation'], [400, 'validation'], [400, 'validation'], [429, null],
  ]);
});

// --------------------------------------------------------------------------
// One source
// --------------------------------------------------------------------------

test('the family roles and the invitation presets of server/services/auth-fields.js are those of the database and the rights', () => {
  // The CHECK stands in the migrations, one file each under server/migrations/.
  const dir = new URL('../server/migrations/', import.meta.url);
  const src = readdirSync(dir).filter((f) => /^\d{4}\.ts$/.test(f)).sort()
    .map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const checks = [...src.matchAll(/CHECK\(family_role IN \(([^)]*)\)\)/g)].map((m) => m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')));
  assert.ok(checks.length >= 1, 'the CHECK of users.family_role is found');
  for (const values of checks) assert.deepEqual(values, [...fields.FAMILY_ROLES]);
  const catalog = /** @type {any} */ (permissionCatalog());
  assert.deepEqual(catalog.roles, [...fields.FAMILY_ROLES]);
  assert.deepEqual(catalog.invitePresets.values, [...fields.INVITE_PRESETS]);
  // The database itself refuses a role outside the list.
  assert.throws(() => db.prepare("INSERT INTO users (username, display_name, password_hash, family_role) VALUES ('rolex', 'r', 'x', 'uncle')").run());
});
