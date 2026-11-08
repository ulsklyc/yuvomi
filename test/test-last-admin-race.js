/**
 * Test: Two admins demoting each other cannot leave the household without one (#2612)
 *
 * Purpose: `PATCH /api/v1/auth/users/:id` checked `assertAdminWouldRemain`,
 *          then, when the request carried a new password, waited on
 *          `await hashPassword(...)`, and only then wrote `role`. The `await`
 *          is a yield point: admins A and B who demote each other at the same
 *          time, each request with a password change, both passed the check
 *          (each still saw the other as admin), both writes landed, and no
 *          administrator was left.
 *
 * WHAT THE CASES HOLD
 *   1. Two parallel demotions with a password change: at least one answers
 *      400 `last_admin`, and exactly one admin is left in `users`. Run
 *      several rounds, since the interleaving depends on timing.
 *   2. Counter case: a single demotion with a password change still works
 *      while another admin remains, and the new password is in effect.
 *
 * Run: npm run test:last-admin-race
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'last-admin-race',
  env: { SESSION_SECRET: 'test-last-admin-race-secret-32-chars!' },
});
const db = (await import('../server/db.js')).get();

const ROUNDS = 3;

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

let counter = 0;
/** A further administrator through the real route, signed in. */
async function newAdmin(creator) {
  counter += 1;
  const username = `admin${counter}`;
  const password = `${username}-pass-123`;
  const r = await creator('POST', '/auth/users', { username, display_name: `Admin ${counter}`, password, system_admin: true });
  assert.equal(r.status, 201, `create ${username}`);
  return { id: r.body.user.id, username, call: as(await login(username, password)) };
}

function adminIds() {
  return db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id").all().map((r) => r.id);
}

test('two admins demoting each other with a password change leave exactly one admin', async () => {
  // Each round starts from the one admin the previous round left behind.
  let survivor = as(await login('admin', 'adminpass123'));
  for (let round = 1; round <= ROUNDS; round += 1) {
    const [only] = adminIds();
    const a = await newAdmin(survivor);
    const b = await newAdmin(survivor);
    // Only A and B count: the current admin steps out first, through the route.
    const out = await a.call('PATCH', `/auth/users/${only}`, { system_admin: false });
    assert.equal(out.status, 200, `round ${round}: precondition, the previous admin is demoted`);
    assert.deepEqual(adminIds(), [a.id, b.id], `round ${round}: precondition, A and B are the only admins`);

    const [ra, rb] = await Promise.all([
      a.call('PATCH', `/auth/users/${b.id}`, { system_admin: false, password: `b-new-password-${round}` }),
      b.call('PATCH', `/auth/users/${a.id}`, { system_admin: false, password: `a-new-password-${round}` }),
    ]);
    const statuses = JSON.stringify([ra.status, rb.status]);
    const refused = [ra, rb].filter((r) => r.status === 400 && r.body?.reason === 'last_admin');
    assert.ok(refused.length >= 1, `round ${round}: at least one demotion is refused as last_admin, got ${statuses}`);
    assert.equal(adminIds().length, 1, `round ${round}: exactly one admin remains, got ${JSON.stringify(adminIds())}`);
    survivor = adminIds()[0] === a.id ? a.call : b.call;
  }
});

test('a single demotion with a password change works while another admin remains', async () => {
  const survivor = adminIds()[0];
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(survivor);
  assert.ok(row, 'precondition: an admin exists');
  // The survivor's own password is unchanged: the request that targeted it
  // was the refused one.
  const survivorPass = `${row.username}-pass-123`;
  const creator = as(await login(row.username, survivorPass));
  const c = await newAdmin(creator);
  const d = await newAdmin(creator);
  const r = await c.call('PATCH', `/auth/users/${d.id}`, { system_admin: false, password: 'd-new-password-123' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(d.id).role, 'member');
  await login(d.username, 'd-new-password-123');
});
