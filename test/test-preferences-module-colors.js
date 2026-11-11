/**
 * Test: Preferences – module_colors per-user override (#1115)
 * Zweck: GET gibt module_colors als leeres Objekt zurueck, wenn nichts gesetzt
 *        ist; PUT speichert Farben als {light, dark}-Paare und gibt sie im Echo
 *        zurueck; PUT wirft 400 auf ungueltige Farb-Strings; unbekannte Modul-IDs
 *        werden still ignoriert; null/leerer Wert entfernt den Eintrag;
 *        maximal 30 Eintraege.
 * Ausführen: node --experimental-sqlite --test test/test-preferences-module-colors.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const { default: preferencesRouter } = await import('../server/routes/preferences.js');

const actor = { userId: 1, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.userId;
  req.authRole = actor.role;
  next();
});
app.use('/', preferencesRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function call(method, body) {
  const res = await fetch(base + '/', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('GET: module_colors is an empty object by default', async () => {
  const { status, json } = await call('GET');
  assert.equal(status, 200);
  assert.deepEqual(json.data.module_colors, {});
});

test('PUT: valid {light, dark} pairs are stored and echoed', async () => {
  const colors = {
    tasks:    { light: '#4f46e5', dark: '#818cf8' },
    calendar: { light: '#16a34a', dark: '#4ade80' },
  };
  const { status, json } = await call('PUT', { module_colors: colors });
  assert.equal(status, 200);
  assert.deepEqual(json.data.module_colors.tasks,    { light: '#4f46e5', dark: '#818cf8' });
  assert.deepEqual(json.data.module_colors.calendar, { light: '#16a34a', dark: '#4ade80' });
});

test('GET after PUT: persisted colours are returned', async () => {
  const { json } = await call('GET');
  assert.deepEqual(json.data.module_colors.tasks,    { light: '#4f46e5', dark: '#818cf8' });
  assert.deepEqual(json.data.module_colors.calendar, { light: '#16a34a', dark: '#4ade80' });
});

test('PUT: null value removes a colour entry', async () => {
  const { json } = await call('PUT', { module_colors: { tasks: null } });
  assert.equal(json.data.module_colors.tasks, undefined);
  assert.deepEqual(json.data.module_colors.calendar, { light: '#16a34a', dark: '#4ade80' });
});

test('PUT: 400 on flat hex string instead of {light, dark}', async () => {
  const { status } = await call('PUT', { module_colors: { tasks: '#4f46e5' } });
  assert.equal(status, 400);
});

test('PUT: 400 when light is missing', async () => {
  const { status } = await call('PUT', { module_colors: { tasks: { dark: '#818cf8' } } });
  assert.equal(status, 400);
});

test('PUT: 400 when dark is missing', async () => {
  const { status } = await call('PUT', { module_colors: { tasks: { light: '#4f46e5' } } });
  assert.equal(status, 400);
});

test('PUT: 400 on invalid hex in light', async () => {
  const { status } = await call('PUT', { module_colors: { tasks: { light: 'blue', dark: '#818cf8' } } });
  assert.equal(status, 400);
});

test('PUT: 400 on 3-digit hex in dark', async () => {
  const { status } = await call('PUT', { module_colors: { tasks: { light: '#4f46e5', dark: '#abc' } } });
  assert.equal(status, 400);
});

test('PUT: array coercion is rejected (typeof check)', async () => {
  const { status } = await call('PUT', { module_colors: { tasks: { light: ['#4f46e5'], dark: '#818cf8' } } });
  assert.equal(status, 400);
});

test('PUT: unknown module id is silently ignored', async () => {
  const { status, json } = await call('PUT', {
    module_colors: {
      nonexistent_module: { light: '#ff0000', dark: '#cc0000' },
      budget:             { light: '#cc0000', dark: '#ff4444' },
    },
  });
  assert.equal(status, 200);
  assert.equal(json.data.module_colors.nonexistent_module, undefined);
  assert.deepEqual(json.data.module_colors.budget, { light: '#cc0000', dark: '#ff4444' });
});

test('PUT: 400 when more than 30 entries', async () => {
  const colors = {};
  for (let i = 0; i < 31; i++) {
    colors[`third-party-mod${String(i).padStart(2, '0')}a`] = { light: '#ff0000', dark: '#cc0000' };
  }
  const { status } = await call('PUT', { module_colors: colors });
  assert.equal(status, 400);
});

test('PUT: 400 when module_colors is an array', async () => {
  const { status } = await call('PUT', { module_colors: ['#ff0000'] });
  assert.equal(status, 400);
});

test('PUT: empty object is a no-op (PATCH semantics)', async () => {
  await call('PUT', { module_colors: { budget: { light: '#ff0000', dark: '#cc0000' } } });
  const { json } = await call('PUT', { module_colors: {} });
  assert.deepEqual(json.data.module_colors.budget, { light: '#ff0000', dark: '#cc0000' });
  await call('PUT', { module_colors: { budget: null } });
});
