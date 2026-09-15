/**
 * Test: Budget-Modus in der Preferences-API (#476/#505)
 * Zweck: GET liefert budget_mode mit Default 'shared'; PUT speichert shared/
 *        personal — aber NUR für Admins (Nicht-Admin → 403), Ungültiges → 400.
 * Ausführen: node --experimental-sqlite --test test/test-preferences-budget-mode.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

let currentRole = 'admin';
function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = currentRole; next(); });
  app.use('/', preferencesRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

test('GET /preferences: budget_mode defaults to shared', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.budget_mode, 'shared');
  } finally { await close(); }
});

for (const value of ['personal', 'shared']) {
  test(`PUT /preferences: admin saves budget_mode='${value}'`, async () => {
    currentRole = 'admin';
    const { baseUrl, close } = await startApp();
    try {
      const put = await fetch(`${baseUrl}/`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget_mode: value }),
      });
      const putBody = await put.json();
      assert.equal(put.status, 200);
      assert.equal(putBody.data.budget_mode, value);

      const get = await fetch(`${baseUrl}/`);
      const getBody = await get.json();
      assert.equal(getBody.data.budget_mode, value, 'persisted value survives round-trip');
    } finally { await close(); }
  });
}

test('PUT /preferences: non-admin cannot change budget_mode (403)', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budget_mode: 'personal' }),
    });
    assert.equal(res.status, 403);
  } finally { await close(); }
});

test('PUT /preferences: admin gets 400 on invalid budget_mode', async () => {
  currentRole = 'admin';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budget_mode: 'bogus' }),
    });
    assert.equal(res.status, 400);
  } finally { await close(); }
});
