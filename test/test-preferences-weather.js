/**
 * Test: Wetter-Konfiguration in der Preferences-API
 * Zweck: GET liefert die 5 weather_*-Felder mit Defaults; PUT speichert sie
 *        (admin-only) und validiert lat/lon/provider.
 * Ausführen: node --experimental-sqlite --test test/test-preferences-weather.js
 */

// Env vor dem Import der Route setzen — db.js initialisiert mit DB_PATH=:memory:
// eine In-Memory-DB inkl. aller Migrationen (Muster aus test-caldav-event-target.js).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

// Rolle wird pro Request über diesen mutierbaren Halter umgeschaltet.
let currentRole = 'admin';
function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = currentRole; next(); });
  app.use('/', preferencesRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

test('GET /preferences includes weather fields with defaults', async () => {
  currentRole = 'admin';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.json();
    assert.equal(res.status, 200);
    for (const k of ['weather_provider', 'weather_lat', 'weather_lon', 'weather_city', 'weather_units', 'weather_auto_locate']) {
      assert.ok(k in body.data, `missing ${k}`);
    }
    assert.equal(body.data.weather_provider, null);
    assert.equal(body.data.weather_units, 'metric');
    assert.equal(body.data.weather_auto_locate, false);
  } finally { await close(); }
});

test('PUT /preferences saves weather config (admin)', async () => {
  currentRole = 'admin';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_lat: '52.52', weather_lon: '13.41',
        weather_city: 'Berlin', weather_units: 'metric', weather_provider: 'open-meteo' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.weather_provider, 'open-meteo');
    assert.equal(body.data.weather_lat, '52.52');
    assert.equal(body.data.weather_city, 'Berlin');
  } finally { await close(); }
});

test('PUT /preferences rejects invalid lat', async () => {
  currentRole = 'admin';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weather_lat: '999' }) });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('PUT /preferences rejects invalid provider', async () => {
  currentRole = 'admin';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weather_provider: 'unknown-provider' }) });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('PUT /preferences rejects non-admin weather config change', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_provider: 'open-meteo', weather_lat: '52.52', weather_lon: '13.41' }) });
    assert.equal(res.status, 403);
  } finally { await close(); }
});

test('PUT /preferences saves weather_auto_locate (admin)', async () => {
  currentRole = 'admin';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_auto_locate: true }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.weather_auto_locate, true);
  } finally { await close(); }
});

test('PUT /preferences rejects non-boolean weather_auto_locate', async () => {
  currentRole = 'admin';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weather_auto_locate: 'yes' }) });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('PUT /preferences rejects non-admin weather_auto_locate change', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weather_auto_locate: true }) });
    assert.equal(res.status, 403);
  } finally { await close(); }
});
