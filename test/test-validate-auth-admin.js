/**
 * Test: request validation in the administration routes of /api/v1/auth
 *       (#2810, phase 2 section E, group 12b)
 * Purpose: the 13 routes of server/auth.js behind `requireAdmin`
 *          (invitations, the household two-factor requirement, signing a
 *          member out of every device, API tokens, member accounts) check
 *          their request against the schema of their operation in the
 *          OpenAPI document (`validateRequest()`) before the handler runs;
 *          with group 12a all 47 routes of the file do. Held here against the
 *          real router at its real prefix (test/auth-app.js) with the real
 *          session:
 *            - THE OWN CALLERS PASS: the bodies the settings pages send
 *              (public/settings/pages/admin-family.js: invitation, new member,
 *              member edit, the two-factor switch; admin-api.js: new API
 *              token). The old document refused the invitation of the page
 *              (`permission_preset` was missing);
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              and `fields`. Switches are booleans only: `system_admin:
 *              "true"` made an administrator, `null` demoted one, `"1"`
 *              turned the household requirement on; text fields are text:
 *              a number was stored as `"5"`; `subject_user_id` is a number:
 *              `"2"` and `true` picked an account;
 *            - PATH IDS: `DELETE /users/5abc` deleted account 5, `DELETE
 *              /invites/1.0` revoked invitation 1; both are a 400 now;
 *            - 500 NOW 400: a new member with `avatar_color: null`;
 *            - REMOVED: `role: 'admin'` at `POST /users` made an administrator
 *              beside `system_admin`; now it is an unknown field;
 *            - RIGHTS BEFORE SHAPE: anonymous 401, a member, a child or a
 *              split-expense guest 403 whatever the body; an API token gets
 *              403 `browser_session_required` at "sign a member out" whatever
 *              the id.
 *          No network: no SMTP (no invitation is mailed), no OIDC issuer.
 * Run: npm run test:validate-auth-admin
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// No limiter may stop a case (the order of the limiters is held in test:validate-auth).
process.env.RATE_LIMIT_MAX_ATTEMPTS = '1000000';
for (const key of [
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'AUTH_ALLOW_PASSWORD_LOGIN', 'BASE_URL',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
]) delete process.env[key];

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { AUTH_PREFIX, createAuthApp } from './auth-app.js';

const dbmod = await import('../server/db.js');
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { hashPassword } = await import('../server/utils/password.js');
const twoFactor = await import('../server/services/two-factor.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const PASSWORD = 'correct-horse-1';
const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const app = await createAuthApp({
  session: sessionMiddleware,
  // server/index.js puts the general API limiter in front; a generous one here.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  routers: [authRouter],
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
 * @param {{ json?: unknown, session?: { cookie: string, csrf: string } | null, token?: string }} [options]
 *   json left out: no body
 */
async function call(method, path, { json, session, token } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {any} */
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
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

/**
 * @param {string} username @param {string} role @param {string} [familyRole]
 * @returns {Promise<number>}
 */
async function account(username, role, familyRole = 'other') {
  const hash = await hashPassword(PASSWORD, 4);
  return Number(db.prepare('INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, ?, ?, ?)')
    .run(username, username, hash, role, familyRole).lastInsertRowid);
}

/** @param {string} username @returns {Promise<{ cookie: string, csrf: string }>} */
async function signIn(username) {
  const res = await call('POST', '/login', { json: { username, password: PASSWORD } });
  assert.equal(res.status, 200, `sign in ${username}: ${JSON.stringify(res.body)}`);
  return { cookie: res.cookie, csrf: res.body.csrfToken };
}

/** @param {number} id */
const userRow = (id) => db.prepare('SELECT id, username, display_name, role, avatar_color, avatar_data FROM users WHERE id = ?').get(id);

const ADMIN_TOKEN = 'yuvomi_validate_auth_admin_token_x';
/** @type {{ admin: number, member: number, kid: number, guest: number }} */
const ids = { admin: 0, member: 0, kid: 0, guest: 0 };
/** @type {Record<string, { cookie: string, csrf: string }>} */
const sessions = {};

test('the accounts: an admin with a session and an API token, a member, a child, a split-expense guest', async () => {
  ids.admin = await account('aadmin', 'admin', 'dad');
  ids.member = await account('amem', 'member', 'mom');
  ids.kid = await account('akid', 'member', 'child');
  ids.guest = await account('aguest', 'member');
  db.prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, NULL, ?)').run(ids.guest, ids.admin);
  db.prepare(`INSERT INTO api_tokens (name, token_hash, token_prefix, created_by) VALUES ('t', ?, ?, ?)`)
    .run(createHash('sha256').update(ADMIN_TOKEN).digest('hex'), ADMIN_TOKEN.slice(0, 12), ids.admin);
  for (const name of ['aadmin', 'amem', 'akid', 'aguest']) sessions[name] = await signIn(name);
});

// --------------------------------------------------------------------------
// Rights before shape
// --------------------------------------------------------------------------

/** Each of the 13 operations once with garbage in every input it has. */
const GARBAGE = /** @type {const} */ ([
  ['POST', '/invites', { display_name: 5, system_admin: 'true' }],
  ['GET', '/invites', undefined],
  ['DELETE', '/invites/1.0', undefined],
  ['GET', '/2fa/overview', undefined],
  ['PUT', '/2fa/require', { required: '1' }],
  ['POST', '/users/abc/devices/sign-out', undefined],
  ['GET', '/api-tokens', undefined],
  ['POST', '/api-tokens', { name: 5, subject_user_id: '2' }],
  ['DELETE', '/api-tokens/1.0', undefined],
  ['POST', '/api-tokens/1abc/remove', undefined],
  ['POST', '/users', { username: ['x'], system_admin: 'true' }],
  ['PATCH', '/users/1.5', { system_admin: null }],
  ['DELETE', '/users/5abc', undefined],
]);

test('anonymous callers get 401 before any schema, at all 13 operations', async () => {
  for (const [method, path, json] of GARBAGE) {
    const res = await call(method, path, { json });
    assert.equal(res.status, 401, `${method} ${path}: ${JSON.stringify(res.body)}`);
  }
});

test('a member, a child and a split-expense guest get 403 whatever the body, never a 400 telling the shape', async () => {
  for (const who of ['amem', 'akid', 'aguest']) {
    for (const [method, path, json] of GARBAGE) {
      const res = await call(method, path, { json, session: sessions[who] });
      assert.equal(res.status, 403, `${who} ${method} ${path}: ${JSON.stringify(res.body)}`);
      assert.notEqual(res.body?.reason, 'validation', `${who} ${method} ${path}`);
    }
  }
});

test('POST /users/{id}/devices/sign-out: an API token gets 403 browser_session_required whatever the id, before the schema', async () => {
  for (const id of ['abc', '1.0', ' 5', String(ids.member), '999999']) {
    const res = await call('POST', `/users/${encodeURIComponent(id)}/devices/sign-out`, { token: ADMIN_TOKEN });
    assert.equal(res.status, 403, `${id}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, {
      error: 'Only a signed-in browser session can sign out a member.', code: 403, reason: 'browser_session_required',
    });
  }
});

test('POST /users/{id}/devices/sign-out: a browser session signs a member out; a malformed id is a 400, an unknown one 404', async () => {
  const admin = sessions.aadmin;
  for (const id of ['abc', '1.0', '1e1', '5abc', ' 5']) {
    refused(await call('POST', `/users/${encodeURIComponent(id)}/devices/sign-out`, { session: admin }), 'path/id', 'type', id);
  }
  const unknown = await call('POST', '/users/999999/devices/sign-out', { session: admin });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'User not found.');
  const memberLater = await signIn('amem');
  const ok = await call('POST', `/users/${ids.member}/devices/sign-out`, { session: admin });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
  // The member's session is gone.
  const me = await call('GET', '/me', { session: memberLater });
  assert.equal(me.status, 401);
  sessions.amem = await signIn('amem');
});

// --------------------------------------------------------------------------
// Invitations
// --------------------------------------------------------------------------

test('POST /invites: the body of the invitation dialog passes, with both presets and empty optional fields', async () => {
  const admin = sessions.aadmin;
  // admin-family.js: every field, empty text where the form field is empty, booleans from the checkboxes.
  for (const preset of ['restricted', 'role']) {
    const res = await call('POST', '/invites', {
      session: admin,
      json: { username: '', display_name: '', email: '', family_role: 'other', permission_preset: preset, system_admin: false, send_email: false },
    });
    assert.equal(res.status, 201, `${preset}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.invite.role, 'member');
    assert.equal(res.body.data.email_sent, false);
  }
  const full = await call('POST', '/invites', {
    session: admin,
    json: { username: 'newbie', display_name: 'Newbie', email: 'newbie@example.test', family_role: 'child', permission_preset: 'restricted', system_admin: true, send_email: false },
  });
  assert.equal(full.status, 201, JSON.stringify(full.body));
  assert.equal(full.body.data.invite.role, 'admin');
  // Every field optional: no body at all is the narrow default invitation.
  const bare = await call('POST', '/invites', { session: admin });
  assert.equal(bare.status, 201, JSON.stringify(bare.body));
});

test('POST /invites: garbage per field is a 400; "true" no longer makes an administrator, a number no longer a name', async () => {
  const admin = sessions.aadmin;
  const before = db.prepare('SELECT COUNT(*) AS n FROM invites').get().n;
  for (const [json, path, rule] of /** @type {const} */ ([
    [{ display_name: 5 }, 'body/display_name', 'type'],
    [{ display_name: { a: 1 } }, 'body/display_name', 'type'],
    [{ username: ['abcd'] }, 'body/username', 'type'],
    [{ email: 5 }, 'body/email', 'type'],
    [{ system_admin: 'true' }, 'body/system_admin', 'type'],
    [{ system_admin: 1 }, 'body/system_admin', 'type'],
    [{ system_admin: null }, 'body/system_admin', 'type'],
    [{ send_email: 1 }, 'body/send_email', 'type'],
    [{ send_email: 'true' }, 'body/send_email', 'type'],
    [{ family_role: 'uncle' }, 'body/family_role', 'enum'],
    [{ family_role: 5 }, 'body/family_role', 'type'],
    [{ permission_preset: 'all' }, 'body/permission_preset', 'enum'],
    [{ permission_preset: null }, 'body/permission_preset', 'type'],
  ])) refused(await call('POST', '/invites', { session: admin, json }), path, rule, JSON.stringify(json));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, before, 'no invitation was created');
  // The shape comes before the taken username (409 before).
  refused(await call('POST', '/invites', { session: admin, json: { username: 'amem', display_name: 5 } }), 'body/display_name', 'type');
  const taken = await call('POST', '/invites', { session: admin, json: { username: 'amem' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.reason, 'members_username_taken');
});

test('GET /invites and DELETE /invites/{id}: `1.0` no longer revokes invitation 1, a plain id does', async () => {
  const admin = sessions.aadmin;
  const list = await call('GET', '/invites', { session: admin });
  assert.equal(list.status, 200);
  const first = Math.min(...list.body.data.invites.map((/** @type {any} */ i) => i.id));
  const open = () => db.prepare('SELECT revoked_at FROM invites WHERE id = ?').get(first).revoked_at;
  for (const id of ['1.0', '1e0', `${first}abc`, ` ${first}`, `${first}.0`]) {
    refused(await call('DELETE', `/invites/${encodeURIComponent(id)}`, { session: admin }), 'path/id', 'type', id);
    assert.equal(open(), null, `${id} revoked nothing`);
  }
  const ok = await call('DELETE', `/invites/${first}`, { session: admin });
  assert.deepEqual([ok.status, ok.body], [200, { data: { ok: true } }]);
  assert.notEqual(open(), null);
  const gone = await call('DELETE', '/invites/999999', { session: admin });
  assert.equal(gone.status, 404);
});

// --------------------------------------------------------------------------
// The household two-factor requirement
// --------------------------------------------------------------------------

test('PUT /2fa/require: the switch of the page turns it on and off; "1", "true", 1, null and [true] are a 400 and change nothing', async () => {
  const admin = sessions.aadmin;
  const overview = await call('GET', '/2fa/overview', { session: admin });
  assert.equal(overview.status, 200);
  const on = await call('PUT', '/2fa/require', { session: admin, json: { required: true } });
  assert.deepEqual([on.status, on.body], [200, { data: { required: true } }]);
  for (const required of ['1', 'true', 1, null, [true], 'x']) {
    refused(await call('PUT', '/2fa/require', { session: admin, json: { required } }), 'body/required', 'type', JSON.stringify(required));
    assert.equal(twoFactor.isRequiredForHousehold(db), true, `${JSON.stringify(required)} left the requirement on`);
  }
  const off = await call('PUT', '/2fa/require', { session: admin, json: { required: false } });
  assert.deepEqual([off.status, off.body], [200, { data: { required: false } }]);
  // "1" turned it on before (the only text that did).
  refused(await call('PUT', '/2fa/require', { session: admin, json: { required: '1' } }), 'body/required', 'type');
  assert.equal(twoFactor.isRequiredForHousehold(db), false);
  // Documented for now (the field becomes required in a later step): omitting `required` switches the requirement off.
  await call('PUT', '/2fa/require', { session: admin, json: { required: true } });
  const omitted = await call('PUT', '/2fa/require', { session: admin, json: {} });
  assert.deepEqual([omitted.status, omitted.body], [200, { data: { required: false } }]);
  await call('PUT', '/2fa/require', { session: admin, json: { required: true } });
  const noBody = await call('PUT', '/2fa/require', { session: admin });
  assert.deepEqual([noBody.status, noBody.body], [200, { data: { required: false } }]);
});

// --------------------------------------------------------------------------
// API tokens
// --------------------------------------------------------------------------

test('POST /api-tokens: the bodies of the API page pass (expiry as ISO time or null, scopes only when limited)', async () => {
  const admin = sessions.aadmin;
  // admin-api.js: { name, expires_at, subject_user_id: Number(select), scopes? }; expires_at from toISOString().
  const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
  const full = await call('POST', '/api-tokens', { session: admin, json: { name: 'Home Assistant', expires_at: expiresAt, subject_user_id: ids.member } });
  assert.equal(full.status, 201, JSON.stringify(full.body));
  assert.equal(full.body.data.subject_user_id, ids.member);
  const never = await call('POST', '/api-tokens', { session: admin, json: { name: 'No expiry', expires_at: null, subject_user_id: ids.admin, scopes: ['calendar:write', 'tasks:read'] } });
  assert.equal(never.status, 201, JSON.stringify(never.body));
  // The documented minimum: a name alone, a full-access token of the caller.
  const bare = await call('POST', '/api-tokens', { session: admin, json: { name: 'bare' } });
  assert.equal(bare.status, 201, JSON.stringify(bare.body));
  assert.equal(bare.body.data.subject_user_id, ids.admin);
  const list = await call('GET', '/api-tokens', { session: admin });
  assert.equal(list.status, 200);
});

test('POST /api-tokens: garbage per field is a 400; a number is no name, "2" or true no account', async () => {
  const admin = sessions.aadmin;
  const before = db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n;
  for (const [json, path, rule] of /** @type {const} */ ([
    [{ name: 5 }, 'body/name', 'type'],
    [{ name: {} }, 'body/name', 'type'],
    [{ name: ['x'] }, 'body/name', 'type'],
    [{}, 'body/name', 'required'],
    [{ name: 't', subject_user_id: '2' }, 'body/subject_user_id', 'type'],
    [{ name: 't', subject_user_id: true }, 'body/subject_user_id', 'type'],
    [{ name: 't', subject_user_id: [2] }, 'body/subject_user_id', 'type'],
    [{ name: 't', subject_user_id: 0 }, 'body/subject_user_id', 'minimum'],
    [{ name: 't', subject_user_id: 1.5 }, 'body/subject_user_id', 'type'],
    [{ name: 't', expires_at: '2999-01-01' }, 'body/expires_at', 'format'],
    [{ name: 't', expires_at: 5 }, 'body/expires_at', 'type'],
    [{ name: 't', scopes: 'calendar:read' }, 'body/scopes', 'type'],
    [{ name: 't', scopes: [5] }, 'body/scopes/0', 'type'],
  ])) refused(await call('POST', '/api-tokens', { session: admin, json }), path, rule, JSON.stringify(json));
  refused(await call('POST', '/api-tokens', { session: admin }), 'body', 'required', 'no body');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n, before, 'no token was created');
  // The handler's own answers stay: an empty name, an unknown account.
  const empty = await call('POST', '/api-tokens', { session: admin, json: { name: '  ' } });
  assert.equal(empty.body.reason, 'api_tokens_name_required');
  const unknown = await call('POST', '/api-tokens', { session: admin, json: { name: 't', subject_user_id: 999999 } });
  assert.equal(unknown.body.reason, 'api_tokens_subject_unknown');
});

test('DELETE /api-tokens/{id} and POST /api-tokens/{id}/remove: `1.0` no longer revokes token 1, a plain id does', async () => {
  const admin = sessions.aadmin;
  const id = Number(db.prepare("SELECT id FROM api_tokens WHERE name = 'bare'").get().id);
  const revoked = () => db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(id).revoked_at;
  for (const raw of [`${id}.0`, `${id}e0`, `${id}abc`, ` ${id}`]) {
    refused(await call('DELETE', `/api-tokens/${encodeURIComponent(raw)}`, { session: admin }), 'path/id', 'type', raw);
    assert.equal(revoked(), null, `${raw} revoked nothing`);
  }
  // Still active: removing it is the route's own 409.
  const active = await call('POST', `/api-tokens/${id}/remove`, { session: admin });
  assert.equal(active.status, 409);
  const ok = await call('DELETE', `/api-tokens/${id}`, { session: admin });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
  assert.notEqual(revoked(), null);
  assert.equal((await call('DELETE', '/api-tokens/999999', { session: admin })).status, 404);
  for (const raw of [`${id}.0`, `${id}abc`, ` ${id}`]) {
    refused(await call('POST', `/api-tokens/${encodeURIComponent(raw)}/remove`, { session: admin }), 'path/id', 'type', raw);
  }
  // The page sends `{}` along.
  const removed = await call('POST', `/api-tokens/${id}/remove`, { session: admin, json: {} });
  assert.deepEqual([removed.status, removed.body], [200, { ok: true }]);
  assert.equal((await call('POST', `/api-tokens/${id}/remove`, { session: admin })).status, 404);
});

// --------------------------------------------------------------------------
// Member accounts
// --------------------------------------------------------------------------

test('POST /users: the body of the new-member dialog passes, empty contact fields as null', async () => {
  const admin = sessions.aadmin;
  // admin-family.js openAddMemberModal: password (no SSO switch without OIDC), color of the picker, contact fields `|| null`.
  const res = await call('POST', '/users', {
    session: admin,
    json: {
      username: 'newmember', display_name: 'New Member', password: 'longenough1', avatar_color: '#0891B2',
      family_role: 'child', system_admin: false, phone: null, email: null, birth_date: null,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.user.role, 'member');
  const filled = await call('POST', '/users', {
    session: admin,
    json: {
      username: 'newadmin', display_name: 'New Admin', password: 'longenough1', avatar_color: '#ff9500', family_role: 'mom',
      system_admin: true, phone: '+49 30 1234', email: 'newadmin@example.test', birth_date: '1990-04-02',
    },
  });
  assert.equal(filled.status, 201, JSON.stringify(filled.body));
  assert.equal(filled.body.user.role, 'admin');
  // The minimum of the document: no color (one is picked), no role.
  const bare = await call('POST', '/users', { session: admin, json: { username: 'baremember', display_name: 'Bare', password: 'longenough1' } });
  assert.equal(bare.status, 201, JSON.stringify(bare.body));
  assert.match(userRow(bare.body.user.id).avatar_color, /^#[0-9A-Fa-f]{6}$/);
  const picture = await call('POST', '/users', { session: admin, json: { username: 'pictured', display_name: 'P', password: 'longenough1', avatar_data: PICTURE } });
  assert.equal(picture.status, 201, JSON.stringify(picture.body));
});

test('POST /users: `role: "admin"` without `system_admin` creates a member (it made an administrator before)', async () => {
  const res = await call('POST', '/users', { session: sessions.aadmin, json: { username: 'rolealias', display_name: 'R', password: 'longenough1', role: 'admin' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.user.role, 'member');
  assert.equal(db.prepare("SELECT role FROM users WHERE username = 'rolealias'").get().role, 'member');
});

test('POST /users: garbage per field is a 400 and creates nothing; `avatar_color: null` was a 500', async () => {
  const admin = sessions.aadmin;
  const valid = { username: 'garbage', display_name: 'G', password: 'longenough1' };
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  for (const [patch, path, rule] of /** @type {const} */ ([
    [{ system_admin: 'true' }, 'body/system_admin', 'type'],
    [{ system_admin: 1 }, 'body/system_admin', 'type'],
    [{ system_admin: null }, 'body/system_admin', 'type'],
    [{ sso_only: 1 }, 'body/sso_only', 'type'],
    [{ sso_only: 'true' }, 'body/sso_only', 'type'],
    [{ username: ['garbage'] }, 'body/username', 'type'],
    [{ display_name: 5 }, 'body/display_name', 'type'],
    [{ display_name: ['G'] }, 'body/display_name', 'type'],
    [{ password: 12345678 }, 'body/password', 'type'],
    [{ password: ['longenough1'] }, 'body/password', 'type'],
    [{ password: 'x'.repeat(1025) }, 'body/password', 'maxLength'],
    [{ avatar_color: null }, 'body/avatar_color', 'type'],
    [{ avatar_color: '' }, 'body/avatar_color', 'pattern'],
    [{ avatar_color: 'red' }, 'body/avatar_color', 'pattern'],
    [{ avatar_color: 5 }, 'body/avatar_color', 'type'],
    [{ avatar_data: '' }, 'body/avatar_data', 'minLength'],
    [{ avatar_data: 5 }, 'body/avatar_data', 'type'],
    [{ phone: 5 }, 'body/phone', 'type'],
    [{ email: 5 }, 'body/email', 'type'],
    [{ birth_date: '' }, 'body/birth_date', 'format'],
    [{ birth_year_unknown: 1 }, 'body/birth_year_unknown', 'type'],
    [{ birth_year_unknown: null }, 'body/birth_year_unknown', 'type'],
    [{ family_role: 'uncle' }, 'body/family_role', 'enum'],
  ])) {
    const json = { ...valid, ...patch };
    refused(await call('POST', '/users', { session: admin, json }), path, rule, JSON.stringify(patch));
  }
  refused(await call('POST', '/users', { session: admin, json: { display_name: 'G', password: 'longenough1' } }), 'body/username', 'required', 'no username');
  refused(await call('POST', '/users', { session: admin }), 'body', 'required', 'no body');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before, 'no account was created');
  // The shape comes before the taken username (409 before).
  refused(await call('POST', '/users', { session: admin, json: { ...valid, username: 'amem', display_name: 5 } }), 'body/display_name', 'type');
  // The handler keeps its own rules: the length after NFC, the username format.
  const short = await call('POST', '/users', { session: admin, json: { ...valid, password: 'short' } });
  assert.deepEqual([short.status, short.body.error], [400, 'Password must be at least 8 characters long.']);
  const name = await call('POST', '/users', { session: admin, json: { ...valid, username: 'no spaces' } });
  assert.equal(name.body.reason, 'members_username_invalid');
});

test('PATCH /users/{id}: the bodies of the edit dialog pass (with and without password, yearless birthday, picture removed)', async () => {
  const admin = sessions.aadmin;
  const id = Number(db.prepare("SELECT id FROM users WHERE username = 'newmember'").get().id);
  // admin-family.js openEditMemberModal: every field on every save; password only when typed; no SSO switch without OIDC.
  const edit = {
    username: 'newmember', display_name: 'New Member', avatar_color: '#0891b2', avatar_data: null, family_role: 'child',
    system_admin: false, phone: null, email: null, birth_date: null, birth_year_unknown: false,
  };
  const plain = await call('PATCH', `/users/${id}`, { session: admin, json: edit });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  const withPassword = await call('PATCH', `/users/${id}`, { session: admin, json: { ...edit, password: 'anotherlong1' } });
  assert.equal(withPassword.status, 200, JSON.stringify(withPassword.body));
  const yearless = await call('PATCH', `/users/${id}`, {
    session: admin, json: { ...edit, display_name: 'Yearless', avatar_data: PICTURE, phone: '+49 1', email: 'nm@example.test', birth_date: '2000-05-17', birth_year_unknown: true },
  });
  assert.equal(yearless.status, 200, JSON.stringify(yearless.body));
  assert.equal(userRow(id).avatar_data, PICTURE);
  const removed = await call('PATCH', `/users/${id}`, { session: admin, json: { ...edit, avatar_data: null } });
  assert.equal(removed.status, 200);
  assert.equal(userRow(id).avatar_data, null);
  // Every field optional: `{}` and no body change nothing.
  for (const json of [{}, undefined]) {
    const res = await call('PATCH', `/users/${id}`, { session: admin, json });
    assert.equal(res.status, 200, JSON.stringify(json));
  }
  const promoted = await call('PATCH', `/users/${id}`, { session: admin, json: { system_admin: true } });
  assert.equal(promoted.body.user.role, 'admin');
  const demoted = await call('PATCH', `/users/${id}`, { session: admin, json: { system_admin: false } });
  assert.equal(demoted.body.user.role, 'member');
});

test('PATCH /users/{id}: `system_admin: null` no longer demotes an administrator; garbage per field is a 400 and changes nothing', async () => {
  const admin = sessions.aadmin;
  const id = Number(db.prepare("SELECT id FROM users WHERE username = 'newadmin'").get().id);
  const row = userRow(id);
  for (const [json, path, rule] of /** @type {const} */ ([
    [{ system_admin: null }, 'body/system_admin', 'type'],
    [{ system_admin: 1 }, 'body/system_admin', 'type'],
    [{ system_admin: 'x' }, 'body/system_admin', 'type'],
    [{ system_admin: 'true' }, 'body/system_admin', 'type'],
    [{ display_name: 5 }, 'body/display_name', 'type'],
    [{ display_name: { a: 1 } }, 'body/display_name', 'type'],
    [{ username: ['newadmin'] }, 'body/username', 'type'],
    [{ avatar_color: null }, 'body/avatar_color', 'type'],
    [{ avatar_color: '' }, 'body/avatar_color', 'pattern'],
    [{ avatar_data: '' }, 'body/avatar_data', 'minLength'],
    [{ password: 12345678 }, 'body/password', 'type'],
    [{ password: ['longenough1'] }, 'body/password', 'type'],
    [{ password: 'x'.repeat(1025) }, 'body/password', 'maxLength'],
    [{ sso_only: null }, 'body/sso_only', 'type'],
    [{ phone: 5 }, 'body/phone', 'type'],
    [{ email: 5 }, 'body/email', 'type'],
    [{ birth_date: '' }, 'body/birth_date', 'format'],
    [{ birth_year_unknown: 1 }, 'body/birth_year_unknown', 'type'],
    [{ birth_year_unknown: null }, 'body/birth_year_unknown', 'type'],
    [{ family_role: 5 }, 'body/family_role', 'type'],
  ])) {
    refused(await call('PATCH', `/users/${id}`, { session: admin, json }), path, rule, JSON.stringify(json));
  }
  assert.deepEqual(userRow(id), row, 'nothing changed');
  assert.equal(userRow(id).role, 'admin');
  // The shape comes before the unknown member (404 before).
  refused(await call('PATCH', '/users/999999', { session: admin, json: { display_name: 5 } }), 'body/display_name', 'type');
  const unknown = await call('PATCH', '/users/999999', { session: admin, json: { display_name: 'X' } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.reason, 'members_member_not_found');
  // An empty password still keeps the current one ("Omit or leave empty").
  const empty = await call('PATCH', `/users/${id}`, { session: admin, json: { password: '' } });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
});

test('PATCH /users/{id}: `1.5`, `1e1`, `{id}abc` and ` {id}` no longer change account {id}', async () => {
  const admin = sessions.aadmin;
  const id = Number(db.prepare("SELECT id FROM users WHERE username = 'newadmin'").get().id);
  const name = userRow(id).display_name;
  for (const raw of [`${id}.5`, `${id}e0`, `${id}abc`, ` ${id}`, '9'.repeat(20)]) {
    const res = await call('PATCH', `/users/${encodeURIComponent(raw)}`, { session: admin, json: { display_name: 'Renamed' } });
    assert.equal(res.status, 400, `${raw}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'validation', raw);
    assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === 'path/id'), raw);
    assert.equal(userRow(id).display_name, name, `${raw} changed nothing`);
  }
});

test('DELETE /users/{id}: `5abc` no longer deletes account 5, a plain id does; `abc` is a 400 (404 before)', async () => {
  const admin = sessions.aadmin;
  const id = Number(db.prepare("SELECT id FROM users WHERE username = 'baremember'").get().id);
  for (const raw of [`${id}abc`, `${id}.0`, `${id}e0`, ` ${id}`, 'abc', '9'.repeat(20)]) {
    const res = await call('DELETE', `/users/${encodeURIComponent(raw)}`, { session: admin });
    assert.equal(res.status, 400, `${raw}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'validation', raw);
    assert.ok(userRow(id), `${raw} deleted nothing`);
  }
  const own = await call('DELETE', `/users/${ids.admin}`, { session: admin });
  assert.equal(own.body.reason, 'own_account');
  const ok = await call('DELETE', `/users/${id}`, { session: admin });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.outcome, 'deleted');
  assert.equal(userRow(id), undefined);
  assert.equal((await call('DELETE', '/users/999999', { session: admin })).status, 404);
});

test('only guard: the rules the administration handlers no longer check themselves stand in the document (group 12b, step b)', async () => {
  // Since 12b (b) no handler of these routes checks the family role, the
  // invitation preset, a sent colour or that a path id is a finite number:
  // only these schema rules do. The colour lands in a style attribute, the
  // preset decides the start rights of an invitation (an unknown one would
  // invite with the full rights of the role), and `invites.family_role` has
  // no CHECK.
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const { FAMILY_ROLES, INVITE_PRESETS } = await import('../server/services/auth-fields.js');
  const { COLOR_PATTERN } = await import('../server/utils/datetime-pattern.js');
  const spec = /** @type {any} */ (buildOpenApiSpec());
  /** @param {any} schema */
  const resolved = (schema) => (schema?.$ref ? spec.components.schemas[schema.$ref.split('/').pop()] : schema);
  /** @param {string} path @param {string} method */
  const bodyOf = (path, method) => resolved(spec.paths[`${AUTH_PREFIX}${path}`][method].requestBody.content['application/json'].schema);

  const invite = bodyOf('/invites', 'post');
  assert.deepEqual([invite.properties.family_role.type, invite.properties.family_role.enum], ['string', [...FAMILY_ROLES]]);
  assert.deepEqual([invite.properties.permission_preset.type, invite.properties.permission_preset.enum], ['string', [...INVITE_PRESETS]]);
  for (const [path, method] of [['/users', 'post'], ['/users/{id}', 'patch']]) {
    const body = bodyOf(path, method);
    assert.deepEqual([body.properties.family_role.type, body.properties.family_role.enum], ['string', [...FAMILY_ROLES]], `${method} ${path}`);
    assert.deepEqual([body.properties.avatar_color.type, body.properties.avatar_color.pattern], ['string', COLOR_PATTERN], `${method} ${path}`);
  }
  for (const [path, method] of [['/invites/{id}', 'delete'], ['/api-tokens/{id}', 'delete'], ['/users/{id}', 'patch']]) {
    const id = spec.paths[`${AUTH_PREFIX}${path}`][method].parameters.find((/** @type {any} */ p) => p.in === 'path' && p.name === 'id');
    assert.deepEqual(id.schema, { type: 'integer', maximum: Number.MAX_SAFE_INTEGER }, `${method} ${path}`);
  }
});
