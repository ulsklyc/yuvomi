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
    const s = app.listen(0, '127.0.0.1', () => resolve({
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

test('GET /preferences includes weather_user with null fields by default', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok('weather_user' in body.data, 'missing weather_user');
    assert.deepEqual(body.data.weather_user, {
      lat: null, lon: null, city: null, units: null, auto_locate: null,
    });
  } finally { await close(); }
});

test('PUT /preferences saves weather_user as non-admin (member)', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_user: { lat: '52.52', lon: '13.41', city: 'Berlin', units: 'imperial', auto_locate: true } }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.weather_user, {
      lat: '52.52', lon: '13.41', city: 'Berlin', units: 'imperial', auto_locate: true,
    });
  } finally { await close(); }
});

test('PUT /preferences weather_user=null field clears the override', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    await fetch(`${baseUrl}/`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_user: { lat: '52.52', lon: '13.41' } }) });
    const res = await fetch(`${baseUrl}/`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_user: { lat: null } }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.weather_user.lat, null);
    assert.equal(body.data.weather_user.lon, '13.41');
  } finally { await close(); }
});

test('PUT /preferences rejects invalid weather_user lat', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_user: { lat: '999' } }) });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('PUT /preferences rejects non-boolean weather_user.auto_locate', async () => {
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_user: { auto_locate: 'yes' } }) });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('weather_user is isolated per authUserId', async () => {
  // User 1 (startApp setzt authUserId=1) speichert Berlin.
  currentRole = 'member';
  const { baseUrl, close } = await startApp();
  try {
    await fetch(`${baseUrl}/`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weather_user: { lat: '52.52' } }) });
    const body = await (await fetch(`${baseUrl}/`)).json();
    assert.equal(body.data.weather_user.lat, '52.52');
  } finally { await close(); }
});

// ----------------------------------------------------------------
// weather_source: woher das Wetter des Haushalts kommt. Der Web-Installer
// schreibt WEATHER_* in die .env, das Dashboard zeigte damit Wetter, die
// Admin-Seite aber "Nicht konfiguriert" - sie las nur die Datenbank.
// ----------------------------------------------------------------
const WEATHER_ENV_KEYS = ['WEATHER_LAT', 'WEATHER_LON', 'WEATHER_CITY', 'WEATHER_UNITS',
  'OPENWEATHER_API_KEY', 'OPENWEATHER_CITY', 'OPENWEATHER_UNITS'];
const OWM_KEY = 'owm-secret-key-123';

async function withWeatherEnv(env, fn) {
  const saved = Object.fromEntries(WEATHER_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of WEATHER_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  currentRole = 'admin';
  const { baseUrl, close } = await startApp();
  const put = (body) => fetch(`${baseUrl}/`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const source = async () => {
    const res = await fetch(`${baseUrl}/`);
    const text = await res.text();
    assert.ok(!text.includes(OWM_KEY), 'der API-Key steht in der Antwort');
    return JSON.parse(text).data.weather_source;
  };
  try {
    // Die Suite teilt sich eine Datenbank - mit leerem Haushaltswetter beginnen.
    assert.equal((await put({ weather_provider: null, weather_lat: null, weather_lon: null, weather_city: '' })).status, 200);
    await fn({ put, source });
  } finally {
    await close();
    for (const k of WEATHER_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('weather_source: none ohne Datenbank und ohne .env', async () => {
  await withWeatherEnv({}, async ({ source }) => {
    assert.deepEqual(await source(), { source: 'none', provider: null, lat: null, lon: null, city: null, units: null });
  });
});

test('weather_source: env meldet Stadt, Koordinaten und Einheit aus WEATHER_*', async () => {
  await withWeatherEnv({ WEATHER_LAT: '52.52', WEATHER_LON: '13.4', WEATHER_CITY: 'Berlin', OPENWEATHER_API_KEY: OWM_KEY },
    async ({ source }) => {
      assert.deepEqual(await source(), {
        source: 'env', provider: 'open-meteo', lat: '52.52', lon: '13.4', city: 'Berlin', units: 'metric',
      });
    });
});

test('weather_source: OPENWEATHER_* (Legacy) ist ebenfalls env - ohne Key im Payload', async () => {
  await withWeatherEnv({ OPENWEATHER_API_KEY: OWM_KEY, OPENWEATHER_CITY: 'Hamburg' }, async ({ source }) => {
    assert.deepEqual(await source(), {
      source: 'env', provider: 'openweathermap', lat: null, lon: null, city: 'Hamburg', units: 'metric',
    });
  });
});

test('weather_source: gespeicherter Standort gewinnt, Entfernen gibt die .env frei', async () => {
  await withWeatherEnv({ WEATHER_LAT: '52.52', WEATHER_LON: '13.4', WEATHER_CITY: 'Berlin' }, async ({ put, source }) => {
    assert.equal((await put({ weather_provider: 'open-meteo', weather_lat: '48.14', weather_lon: '11.58', weather_city: 'München' })).status, 200);
    const stored = await source();
    assert.equal(stored.source, 'db');
    assert.equal(stored.city, 'München');

    // Genau das schickt der Entfernen-Knopf der Admin-Seite.
    assert.equal((await put({ weather_provider: null, weather_lat: null, weather_lon: null, weather_city: '' })).status, 200);
    const after = await source();
    assert.equal(after.source, 'env', 'nach dem Entfernen greift wieder die .env');
    assert.equal(after.city, 'Berlin');
  });
});

test('weather_source: nur den Anbieter zu entfernen laesst die Koordinaten wirken', async () => {
  // Der Proxy nimmt Koordinaten auch ohne Anbieter - die Quelle bleibt db, und
  // die Admin-Seite zeigt deshalb weiter einen Entfernen-Knopf.
  await withWeatherEnv({ WEATHER_LAT: '52.52', WEATHER_LON: '13.4' }, async ({ put, source }) => {
    await put({ weather_provider: 'open-meteo', weather_lat: '48.14', weather_lon: '11.58' });
    await put({ weather_provider: null });
    assert.deepEqual(
      { source: (await source()).source, provider: (await source()).provider },
      { source: 'db', provider: 'open-meteo' },
    );
  });
});

test('PUT /preferences weather_lat/weather_lon = null loescht die Koordinaten', async () => {
  await withWeatherEnv({}, async ({ put }) => {
    await put({ weather_lat: '48.14', weather_lon: '11.58' });
    const res = await put({ weather_lat: null, weather_lon: null });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.weather_lat, null);
    assert.equal(body.data.weather_lon, null);
  });
});
