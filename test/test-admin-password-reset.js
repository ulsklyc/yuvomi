/**
 * Admin-Passwort-Reset (Issue #372).
 * Admins konnten beim Anlegen eines Familienmitglieds ein Passwort setzen,
 * aber ein bestehendes Passwort nicht mehr ändern. Dieser Test deckt das
 * optionale `password`-Feld von PATCH /api/v1/auth/users/:id ab.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

// Start, Portwahl und Abbau liegen im Helfer - inklusive des Grundes, warum
// hier kein `process.exit(0)` mehr steht.
const { baseUrl: BASE } = await startTestServer({
  name: 'admin-password-reset',
  env: { SESSION_SECRET: 'test-admin-pwreset-secret-minimum-32ch' },
});
const { get: getDatabase } = await import('../server/db.js');
const database = getDatabase();

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

async function patchUser(userId, body) {
  return fetch(`${BASE}/api/v1/auth/users/${userId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminSession.cookie,
      'X-CSRF-Token': adminSession.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

function seedPendingFastingReminder(userId) {
  database.prepare("DELETE FROM reminders WHERE created_by = ? AND entity_type IN ('fasting_goal', 'fasting_next_start')").run(userId);
  database.prepare('DELETE FROM health_fasts WHERE user_id = ?').run(userId);
  database.prepare(`INSERT INTO health_fasting_settings
    (user_id, default_goal_minutes, remind_goal, remind_next_start)
    VALUES (?, 960, 1, 0)
    ON CONFLICT(user_id) DO UPDATE SET default_goal_minutes = 960, remind_goal = 1, remind_next_start = 0`).run(userId);
  const fastId = database.prepare(`INSERT INTO health_fasts
    (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (?, '2026-09-18T06:00:00.000Z', NULL, 'UTC', 960)`).run(userId).lastInsertRowid;
  database.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('fasting_goal', ?, '2026-09-18T22:00:00.000Z', ?)`).run(fastId, userId);
}

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

test('PATCH /auth/users/:id reconciles fasting reminders on a denied family-role transition', async () => {
  database.prepare(`INSERT INTO access_permissions
    (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'child', 'capability', 'health_use_fasting', 'none')
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key)
    DO UPDATE SET access = excluded.access`).run();
  seedPendingFastingReminder(kid.id);

  const response = await patchUser(kid.id, { family_role: 'child' });
  assert.equal(response.status, 200);
  assert.equal(database.prepare('SELECT family_role FROM users WHERE id = ?').get(kid.id).family_role, 'child');
  assert.equal(database.prepare("SELECT count(*) AS count FROM reminders WHERE created_by = ? AND entity_type = 'fasting_goal'").get(kid.id).count, 0);
});

test('PATCH /auth/users/:id reconciles fasting reminders when an admin is demoted', async () => {
  assert.equal((await patchUser(kid.id, { system_admin: true })).status, 200);
  seedPendingFastingReminder(kid.id);

  const response = await patchUser(kid.id, { system_admin: false });
  assert.equal(response.status, 200);
  assert.equal(database.prepare('SELECT role FROM users WHERE id = ?').get(kid.id).role, 'member');
  assert.equal(database.prepare("SELECT count(*) AS count FROM reminders WHERE created_by = ? AND entity_type = 'fasting_goal'").get(kid.id).count, 0);
});

test('PATCH /auth/users/:id rolls a role change back when fasting cleanup fails', async () => {
  assert.equal((await patchUser(kid.id, { system_admin: true })).status, 200);
  seedPendingFastingReminder(kid.id);
  database.exec(`CREATE TRIGGER test_fail_auth_fasting_delete
    BEFORE DELETE ON reminders
    WHEN OLD.entity_type IN ('fasting_goal', 'fasting_next_start')
    BEGIN
      SELECT RAISE(ABORT, 'forced auth fasting cleanup failure');
    END`);
  try {
    const response = await patchUser(kid.id, { system_admin: false });
    assert.equal(response.status, 500);
    assert.equal(database.prepare('SELECT role FROM users WHERE id = ?').get(kid.id).role, 'admin');
    assert.equal(database.prepare("SELECT count(*) AS count FROM reminders WHERE created_by = ? AND entity_type = 'fasting_goal'").get(kid.id).count, 1);
  } finally {
    database.exec('DROP TRIGGER IF EXISTS test_fail_auth_fasting_delete');
  }
});
