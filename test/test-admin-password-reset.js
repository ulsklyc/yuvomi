/**
 * Admin-Passwort-Reset (Issue #372).
 * Admins konnten beim Anlegen eines Familienmitglieds ein Passwort setzen,
 * aber ein bestehendes Passwort nicht mehr ändern. Dieser Test deckt das
 * optionale `password`-Feld von PATCH /api/v1/auth/users/:id ab.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'oikos-admin-pwreset-test-'));

process.env.SESSION_SECRET = 'test-admin-pwreset-secret-minimum-32ch';
process.env.DB_PATH = join(tmpDir, 'test.db');
process.env.SESSION_SECURE = 'false';
process.env.PORT = '13098';

const { default: app } = await import('../server/index.js');
await new Promise((r) => setTimeout(r, 400));

const BASE = 'http://localhost:13098';

function cookieHeader(setCookie) {
  return String(setCookie || '')
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  if (res.status !== 200) return { status: res.status, cookie, csrfToken: null };

  // /login durchläuft keine csrfMiddleware; GET /auth/me erzeugt das
  // Session-Token und liefert es im JSON-Body (`csrfToken`).
  const meRes = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } });
  const me = await meRes.json();
  return { status: res.status, cookie, csrfToken: me.csrfToken };
}

// Admin-Account anlegen
await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

const adminSession = await login('admin', 'adminpass123');
assert.equal(adminSession.status, 200);

// Familienmitglied mit Anfangspasswort anlegen
const createRes = await fetch(`${BASE}/api/v1/auth/users`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: adminSession.cookie,
    'X-CSRF-Token': adminSession.csrfToken,
  },
  body: JSON.stringify({ username: 'kid', display_name: 'Kid', password: 'initialPass1' }),
});
assert.equal(createRes.status, 201);
const { user: kid } = await createRes.json();

test('PATCH /auth/users/:id: admin can set a new password for a family member', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/users/${kid.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminSession.cookie,
      'X-CSRF-Token': adminSession.csrfToken,
    },
    body: JSON.stringify({
      username: 'kid',
      display_name: 'Kid',
      family_role: 'other',
      password: 'newPassword456',
    }),
  });
  assert.equal(res.status, 200);

  const loginWithNew = await login('kid', 'newPassword456');
  assert.equal(loginWithNew.status, 200);

  const loginWithOld = await login('kid', 'initialPass1');
  assert.equal(loginWithOld.status, 401);
});

test('PATCH /auth/users/:id: rejects a new password shorter than 8 characters', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/users/${kid.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminSession.cookie,
      'X-CSRF-Token': adminSession.csrfToken,
    },
    body: JSON.stringify({
      username: 'kid',
      display_name: 'Kid',
      family_role: 'other',
      password: 'short',
    }),
  });
  assert.equal(res.status, 400);

  // Passwort aus dem vorherigen Test muss weiterhin gültig sein
  const loginWithPrevious = await login('kid', 'newPassword456');
  assert.equal(loginWithPrevious.status, 200);
});

test('PATCH /auth/users/:id: omitting password leaves the existing password unchanged', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/users/${kid.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminSession.cookie,
      'X-CSRF-Token': adminSession.csrfToken,
    },
    body: JSON.stringify({
      username: 'kid',
      display_name: 'Kid Renamed',
      family_role: 'other',
    }),
  });
  assert.equal(res.status, 200);

  const loginStillWorks = await login('kid', 'newPassword456');
  assert.equal(loginStillWorks.status, 200);
});
