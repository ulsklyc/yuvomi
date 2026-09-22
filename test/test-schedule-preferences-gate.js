/**
 * Test: Modul-Gate fuer /schedule/preferences ueber den ECHTEN Server
 * Zweck: PR #1099 review finding #2. `scopedModuleKey` liess `null` als
 *        Modul-Schluessel durch `moduleAccessVerdict()` laufen, was bei JEDEM
 *        Zugriffsniveau (auch `none`) "erlaubt" ergab - und der frühere
 *        `startsWith('/schedule/preferences')`-Vergleich haette auch
 *        `/schedule/preferencesX` mitgemeint. Die Schedule-Suiten haengen den
 *        Router direkt ein und sehen dieses Gate nie (server/index.js) -
 *        deshalb hier ueber `test/server-ready.js`, wie
 *        `test-shopping-versions.js` es fuer sein eigenes Modul-Gate tut.
 * Ausfuehren: node --experimental-sqlite --test test/test-schedule-preferences-gate.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'schedule-preferences-gate',
  env: { SESSION_SECRET: 'test-schedule-prefs-gate-secret-min32c' },
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const admin = await login('admin', 'adminpass123');

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* leer */ }
    return { status: res.status, body: json };
  };
}
const adminCall = as(admin);

const created = await adminCall('POST', '/auth/users', { username: 'member1', display_name: 'Member', password: 'memberpass123' });
assert.equal(created.status, 201);
const memberId = created.body.user.id;
const member = await login('member1', 'memberpass123');
const memberCall = as(member);

async function setScheduleAccess(level) {
  const r = await adminCall('PUT', `/permissions/user/${memberId}`, { modules: { schedule: level } });
  assert.equal(r.status, 200, `set schedule access to ${level}`);
}

test('none -> GET /schedule/preferences denied through the global module gate', async () => {
  await setScheduleAccess('none');
  const r = await memberCall('GET', '/schedule/preferences');
  assert.equal(r.status, 403);
});

test('none -> PUT /schedule/preferences denied through the global module gate', async () => {
  await setScheduleAccess('none');
  const r = await memberCall('PUT', '/schedule/preferences', { weeklyHours: 20 });
  assert.equal(r.status, 403);
});

test('read -> GET /schedule/preferences allowed', async () => {
  await setScheduleAccess('read');
  const r = await memberCall('GET', '/schedule/preferences');
  assert.equal(r.status, 200);
});

test('read -> PUT /schedule/preferences allowed (own row, not a module write)', async () => {
  await setScheduleAccess('read');
  const r = await memberCall('PUT', '/schedule/preferences', { weeklyHours: 20 });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.weeklyHours, 20);
});

test('the exception is exact - a longer path is not swept in', async () => {
  await setScheduleAccess('none');
  // /schedule/preferencesX does not exist as a route, but the gate must still
  // deny it at `none` rather than let a startsWith-style match slip it through
  // as if it were the real preferences path.
  const r = await memberCall('GET', '/schedule/preferencesX');
  assert.equal(r.status, 403);
});

// Die Ausnahme gilt NUR fuer Sitzungen (READ_LEVEL_WRITES, Achse `session`):
// ein Token mit `schedule:read` bleibt an `schedule:write` gebunden - auch
// ueber HTTP, nicht nur in der Funktion.
test('token with schedule:read -> PUT /schedule/preferences denied, GET allowed', async () => {
  const crypto = await import('node:crypto');
  const { get } = await import('../server/db.js');
  const token = 'yuvomi_test_schedule_prefs_read_token';
  get().prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, scopes)
    VALUES ('schedule-read', ?, 'yuvomi_test', 1, ?)
  `).run(crypto.createHash('sha256').update(token).digest('hex'), JSON.stringify(['schedule:read']));
  const call = (method, body) => fetch(`${BASE}/api/v1/schedule/preferences`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await call('GET')).status, 200, 'Gegenprobe: das Token kommt durch, wo es lesen darf');
  assert.equal((await call('PUT', { weeklyHours: 20 })).status, 403);
});
