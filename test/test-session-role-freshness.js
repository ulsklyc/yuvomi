/**
 * Test: The role of a cookie session comes from `users`, not from the session (#2611)
 *
 * Purpose: `requireAuth` took `req.authRole` from `req.session.role`. A
 *          demotion rewrites the session rows that exist at that moment
 *          (`updateUserRoleSessions`), but two paths leave a row with
 *          `role: 'admin'` behind: a login whose `await verifyPassword` spans
 *          the demotion writes the stale role into the new session, and
 *          `POST /auth/oidc/link/start` saves the whole session back via
 *          `INSERT OR REPLACE` after its own `await`. Both are reproduced here
 *          the same way the deactivation suite reproduces a write-back: copy
 *          the session row, demote, insert the copy again.
 *
 * WHAT THE CASES HOLD
 *   1. A written-back admin session of a demoted account is a member session:
 *      admin routes answer 403, `/auth/me` reports `member`.
 *   2. The same written-back session no longer skips module rights: a
 *      sparse `tasks = none` row applies again (403 on a tasks read route).
 *   3. Counter cases: a real admin stays admin even with a `tasks = none` row
 *      on their id, and even when their session row says `member`.
 *
 * Run: npm run test:session-role-freshness
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'session-role-freshness',
  env: { SESSION_SECRET: 'test-session-role-freshness-secret-32ch' },
});
const db = (await import('../server/db.js')).get();

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  return { cookie: cookieHeader(res.headers.get('set-cookie')), csrfToken: (await res.json()).csrfToken };
}

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const admin = as(await login('admin', 'adminpass123'));
const ADMIN = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;

let counter = 0;
/** A second administrator through the real route, signed in. */
async function secondAdmin() {
  counter += 1;
  const username = `admin${counter}`;
  const password = `${username}-pass-123`;
  const r = await admin('POST', '/auth/users', { username, display_name: `Admin ${counter}`, password, system_admin: true });
  assert.equal(r.status, 201, `create ${username}`);
  const id = r.body.user.id;
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(id).role, 'admin', 'precondition: the account is an admin');
  return { id, call: as(await login(username, password)) };
}

function sessionRowsOf(userId) {
  return db.prepare('SELECT * FROM sessions').all().filter((r) => JSON.parse(r.sess).userId === userId);
}

/** Writes session rows back the way `BetterSQLiteStore.set` does. */
function writeBack(rows, patch = {}) {
  for (const row of rows) {
    const data = { ...row, sess: JSON.stringify({ ...JSON.parse(row.sess), ...patch }) };
    const columns = Object.keys(data);
    db.prepare(`INSERT OR REPLACE INTO sessions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((c) => data[c]));
  }
}

/** Sparse, as the admin UI writes it: one row for the one module. */
function denyModule(userId, moduleKey) {
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, 'none')
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key) DO UPDATE SET access = excluded.access
  `).run(String(userId), moduleKey);
}

/** Copies the admin session, demotes through the real route, writes the copy back. */
async function demoteWithStaleSession(u) {
  assert.equal((await u.call('GET', '/auth/api-tokens')).status, 200, 'precondition: an admin session');
  const kept = sessionRowsOf(u.id);
  assert.equal(kept.length, 1);
  assert.equal(JSON.parse(kept[0].sess).role, 'admin', 'precondition: the copy says admin');

  const r = await admin('PATCH', `/auth/users/${u.id}`, { system_admin: false });
  assert.equal(r.status, 200, 'demotion');
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(u.id).role, 'member');

  writeBack(kept);
  assert.equal(JSON.parse(sessionRowsOf(u.id)[0].sess).role, 'admin', 'precondition: the stale role is back in the row');
}

test('a written-back admin session of a demoted account is a member session', async () => {
  const u = await secondAdmin();
  await demoteWithStaleSession(u);

  assert.equal((await u.call('GET', '/auth/api-tokens')).status, 403, 'admin route');
  const created = await u.call('POST', '/auth/users', { username: 'from-a-demoted-admin', display_name: 'X', password: 'from-a-demoted-admin-123' });
  assert.equal(created.status, 403, 'account management');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'from-a-demoted-admin'").get().n, 0);
  const me = await u.call('GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'member');
});

test('after the write-back, a module right of the demoted account applies again', async () => {
  const u = await secondAdmin();
  denyModule(u.id, 'tasks');
  // An admin skips module rights; the row is there, but does not apply yet.
  assert.equal((await u.call('GET', '/tasks')).status, 200, 'precondition: admins skip module rights');
  await demoteWithStaleSession(u);

  assert.equal((await u.call('GET', '/tasks')).status, 403, 'tasks = none applies');
});

test('counter case: a real admin stays admin with a tasks = none row on their id', async () => {
  denyModule(ADMIN, 'tasks');
  try {
    assert.equal((await admin('GET', '/tasks')).status, 200);
    assert.equal((await admin('GET', '/auth/api-tokens')).status, 200);
  } finally {
    db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(ADMIN));
  }
});

test('counter case: a real admin stays admin when their session row says member', async () => {
  const u = await secondAdmin();
  writeBack(sessionRowsOf(u.id), { role: 'member' });
  assert.equal(JSON.parse(sessionRowsOf(u.id)[0].sess).role, 'member', 'precondition: the row says member');

  assert.equal((await u.call('GET', '/auth/api-tokens')).status, 200);
  assert.equal((await u.call('GET', '/auth/me')).body.user.role, 'admin');
});
