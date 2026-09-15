/**
 * Test: Wochenstart in der Preferences-API (#484, #465)
 * Zweck: GET liefert week_start mit Default 'monday'; PUT speichert monday/
 *        sunday/saturday (haushaltweit, von jedem Mitglied), weist Ungültiges ab.
 * Ausführen: node --experimental-sqlite --test test/test-preferences-weekstart.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

let currentRole = 'member';
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

test('GET /preferences: week_start defaults to monday', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.week_start, 'monday');
  } finally { await close(); }
});

for (const value of ['monday', 'sunday', 'saturday']) {
  test(`PUT /preferences: saves week_start='${value}' (non-admin member allowed)`, async () => {
    currentRole = 'member';
    const { baseUrl, close } = await startApp();
    try {
      const put = await fetch(`${baseUrl}/`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ week_start: value }),
      });
      const putBody = await put.json();
      assert.equal(put.status, 200);
      assert.equal(putBody.data.week_start, value);

      const get = await fetch(`${baseUrl}/`);
      const getBody = await get.json();
      assert.equal(getBody.data.week_start, value, 'persisted value survives round-trip');
    } finally { await close(); }
  });
}

test('PUT /preferences: rejects an invalid week_start with 400', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_start: 'friday' }),
    });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('PUT /preferences: omitting week_start leaves the stored value untouched', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await fetch(`${baseUrl}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_start: 'sunday' }),
    });
    // Ein unabhängiges Feld ändern; week_start darf dabei erhalten bleiben.
    const res = await fetch(`${baseUrl}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ time_format: '12h' }),
    });
    const body = await res.json();
    assert.equal(body.data.week_start, 'sunday');
  } finally { await close(); }
});
