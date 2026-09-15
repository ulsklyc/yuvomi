/**
 * Test: Immich-Bildschirmschoner (#693)
 * Zweck: Die Route holt Fotos von einem fremden Server und reicht sie an jeden
 *        angemeldeten Browser weiter. Getestet wird deshalb, was OHNE Immich
 *        passieren muss: die Konfigurations-Endpunkte bleiben Admins
 *        vorbehalten, ein unkonfigurierter Server antwortet ruhig statt zu
 *        scheitern, und beide Ids (Album wie Asset) muessen eine UUID sein,
 *        bevor sie in einen ausgehenden Request geraten.
 *        Keine Suite darf Immich wirklich erreichen - jeder Pfad hier endet
 *        vor dem ersten ausgehenden Request.
 * Ausfuehren: node --test test/test-screensaver.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
// server/db.js initializes on import; select an isolated database before the
// dynamic route import so this suite can never touch a developer installation.
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { __test, default: screensaverRouter } = await import('../server/routes/screensaver.js');

let actor = { id: 1, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  next();
});
app.use('/', screensaverRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leerer Body */ }
  return { status: res.status, body: json };
}

function withoutImmichEnv(fn) {
  const previous = {
    IMMICH_URL: process.env.IMMICH_URL,
    IMMICH_API_KEY: process.env.IMMICH_API_KEY,
    IMMICH_SCREENSAVER_ALBUM_ID: process.env.IMMICH_SCREENSAVER_ALBUM_ID,
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('Immich URL accepts server roots and URLs ending in /api', () => {
  assert.equal(__test.immichUrl('https://photos.example', '/search/random'), 'https://photos.example/api/search/random');
  assert.equal(__test.immichUrl('https://photos.example/api', '/search/random'), 'https://photos.example/api/search/random');
});

test('screensaver is disabled unless URL and API key are both configured', () => {
  withoutImmichEnv(() => {
    assert.equal(__test.config().enabled, false);
    process.env.IMMICH_URL = 'https://photos.example';
    assert.equal(__test.config().enabled, false);
    process.env.IMMICH_API_KEY = 'secret';
    assert.equal(__test.config().enabled, true);
  });
});

test('nur Admins sehen und aendern die Immich-Konfiguration', async () => {
  actor = { id: 2, role: 'member' };
  try {
    assert.equal((await call('GET', '/config')).status, 403);
    assert.equal((await call('PUT', '/config', { url: 'https://evil.example' })).status, 403);
    assert.equal((await call('POST', '/test')).status, 403);
  } finally {
    actor = { id: 1, role: 'admin' };
  }
});

test('ohne Konfiguration antwortet /photos ruhig statt zu scheitern', async () => {
  const r = await withoutImmichEnv(() => call('GET', '/photos'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { enabled: false, photos: [] });
});

test('der Thumbnail-Proxy nimmt nur UUIDs an', async () => {
  // Ohne Konfiguration endet jeder Aufruf mit 404, bevor die Id geprueft wird.
  process.env.IMMICH_URL = 'https://photos.example';
  process.env.IMMICH_API_KEY = 'secret';
  try {
    // Ein Pfadsegment, das Immichs URL verlassen koennte, darf gar nicht erst
    // in den ausgehenden Request geraten.
    assert.equal((await call('GET', '/photos/..%2F..%2Fadmin')).status, 400);
    assert.equal((await call('GET', '/photos/not-a-uuid')).status, 400);
  } finally {
    delete process.env.IMMICH_URL;
    delete process.env.IMMICH_API_KEY;
  }
});

test('eine Album-Id, die keine UUID ist, wird verworfen statt weitergereicht', async () => {
  const invalid = await call('PUT', '/config', { albumId: 'alle-fotos' });
  assert.equal(invalid.status, 400);
  // Auch aus der Datenbank gelesen bleibt nur eine UUID stehen: der Wert geht
  // in den Body des Immich-Requests.
  assert.equal(__test.config().albumId, '');
});
