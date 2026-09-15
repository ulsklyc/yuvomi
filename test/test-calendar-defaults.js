/**
 * Test: Standardwerte für neue Termine (#497/#498)
 * Zweck: Per-User-Preferences calendar_default_reminders (Offset-Liste, Cap,
 *        Validierung) und calendar_default_assign_me (Boolean). Prüft GET-Defaults,
 *        PUT-Roundtrip, ungültige Offsets/Cap → 400 und Per-User-Isolation.
 * Ausführen: node --experimental-sqlite --test test/test-calendar-defaults.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

// authUserId wird pro Request gesetzt, um Per-User-Isolation zu prüfen.
let currentUserId = 1;
function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = currentUserId; req.authRole = 'admin'; next(); });
  app.use('/', preferencesRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}
const getPrefs = (baseUrl) => fetch(`${baseUrl}/`).then((r) => r.json());
const putPrefs = (baseUrl, body) => fetch(`${baseUrl}/`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('GET: calendar defaults start empty/false', async () => {
  currentUserId = 1;
  const { baseUrl, close } = await startApp();
  try {
    const { data } = await getPrefs(baseUrl);
    assert.deepEqual(data.calendar_default_reminders, []);
    assert.equal(data.calendar_default_assign_me, false);
  } finally { await close(); }
});

test('PUT: saves and normalizes default reminders (dedup + sort)', async () => {
  currentUserId = 1;
  const { baseUrl, close } = await startApp();
  try {
    const put = await putPrefs(baseUrl, { calendar_default_reminders: [1440, 15, 1440, 0] });
    const body = await put.json();
    assert.equal(put.status, 200);
    assert.deepEqual(body.data.calendar_default_reminders, [0, 15, 1440]);

    const { data } = await getPrefs(baseUrl);
    assert.deepEqual(data.calendar_default_reminders, [0, 15, 1440], 'survives round-trip');
  } finally { await close(); }
});

test('PUT: saves assign-me toggle', async () => {
  currentUserId = 1;
  const { baseUrl, close } = await startApp();
  try {
    await putPrefs(baseUrl, { calendar_default_assign_me: true });
    assert.equal((await getPrefs(baseUrl)).data.calendar_default_assign_me, true);
    await putPrefs(baseUrl, { calendar_default_assign_me: false });
    assert.equal((await getPrefs(baseUrl)).data.calendar_default_assign_me, false);
  } finally { await close(); }
});

test('PUT: rejects invalid reminder offset with 400', async () => {
  currentUserId = 1;
  const { baseUrl, close } = await startApp();
  try {
    const res = await putPrefs(baseUrl, { calendar_default_reminders: [7] });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('PUT: rejects non-array reminders with 400', async () => {
  currentUserId = 1;
  const { baseUrl, close } = await startApp();
  try {
    const res = await putPrefs(baseUrl, { calendar_default_reminders: '15' });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('PUT: rejects more than 5 reminders with 400', async () => {
  currentUserId = 1;
  const { baseUrl, close } = await startApp();
  try {
    const res = await putPrefs(baseUrl, { calendar_default_reminders: [0, 15, 60, 1440, 2880, 10080] });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('per-user isolation: user 2 keeps its own defaults', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentUserId = 1;
    await putPrefs(baseUrl, { calendar_default_reminders: [15], calendar_default_assign_me: true });
    currentUserId = 2;
    await putPrefs(baseUrl, { calendar_default_reminders: [1440], calendar_default_assign_me: false });

    currentUserId = 1;
    const u1 = (await getPrefs(baseUrl)).data;
    assert.deepEqual(u1.calendar_default_reminders, [15]);
    assert.equal(u1.calendar_default_assign_me, true);

    currentUserId = 2;
    const u2 = (await getPrefs(baseUrl)).data;
    assert.deepEqual(u2.calendar_default_reminders, [1440]);
    assert.equal(u2.calendar_default_assign_me, false);
  } finally { await close(); }
});
