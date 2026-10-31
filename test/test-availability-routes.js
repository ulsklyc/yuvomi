/**
 * Test: Availability-Routen (#1591)
 * Zweck: End-to-End über den echten Availability-Router - GET, PUT, DELETE.
 *        Prüft: Validierung (400: ungültiger State, falsches Datum-Format,
 *        Datum in der Vergangenheit, Note zu lang), erfolgreiches Setzen und
 *        Ueberschreiben des eigenen Status, GET liefert nur nicht abgelaufene
 *        Eintraege, DELETE entfernt den eigenen Eintrag, anderer Nutzer sieht
 *        den eigenen Status des ersten im GET.
 * Ausführen: node --experimental-sqlite --test test/test-availability-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: availabilityRouter } = await import('../server/routes/availability.js');
const db = dbmod.get();

const USER_A = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('alice','Alice','x','member')`).run().lastInsertRowid;
const USER_B = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('bob','Bob','x','member')`).run().lastInsertRowid;

let actorId = USER_A;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actorId;
  req.authRole = 'member';
  req.session = { userId: actorId, role: 'member' };
  next();
});
app.use('/', availabilityRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

function future(offsetSeconds = 3600) {
  const d = new Date(Date.now() + offsetSeconds * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function call(method, path, body, asUser = USER_A) {
  actorId = asUser;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, json };
}

// -----------------------------------------------------------------------

test('PUT: valid state sets status', async () => {
  const exp = future();
  const { status, json } = await call('PUT', '/', { state: 'busy', expires_at: exp });
  assert.equal(status, 200);
  assert.equal(json.data.state, 'busy');
  assert.equal(json.data.expires_at, exp);
  assert.ok(json.data.set_at);
});

test('PUT: state with note stores note', async () => {
  const exp = future();
  const { status, json } = await call('PUT', '/', { state: 'away', note: 'On holiday', expires_at: exp });
  assert.equal(status, 200);
  assert.equal(json.data.state, 'away');
});

test('PUT: upsert overwrites previous status for same user', async () => {
  const exp = future();
  await call('PUT', '/', { state: 'available', expires_at: exp });
  const { status, json } = await call('PUT', '/', { state: 'do_not_disturb', expires_at: future(7200) });
  assert.equal(status, 200);
  assert.equal(json.data.state, 'do_not_disturb');
});

test('PUT: 400 on invalid state', async () => {
  const { status } = await call('PUT', '/', { state: 'invisible', expires_at: future() });
  assert.equal(status, 400);
});

test('PUT: 400 on missing expires_at', async () => {
  const { status } = await call('PUT', '/', { state: 'busy' });
  assert.equal(status, 400);
});

test('PUT: 400 on expires_at in the past', async () => {
  const past = new Date(Date.now() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { status } = await call('PUT', '/', { state: 'busy', expires_at: past });
  assert.equal(status, 400);
});

test('PUT: 400 on malformed expires_at', async () => {
  const { status } = await call('PUT', '/', { state: 'busy', expires_at: '2099-01-01' });
  assert.equal(status, 400);
});

test('PUT: 400 on note too long', async () => {
  const note = 'x'.repeat(201);
  const { status } = await call('PUT', '/', { state: 'busy', note, expires_at: future() });
  assert.equal(status, 400);
});

test('GET: returns active status set by user', async () => {
  // Reset: clear first
  await call('DELETE', '/', undefined, USER_A);
  await call('PUT', '/', { state: 'available', expires_at: future() }, USER_A);
  const { status, json } = await call('GET', '/', undefined, USER_B);
  assert.equal(status, 200);
  const alice = json.data.find((r) => r.user_id === USER_A);
  assert.ok(alice, 'Alice\'s status should appear for Bob');
  assert.equal(alice.state, 'available');
});

test('DELETE: removes own status', async () => {
  await call('PUT', '/', { state: 'busy', expires_at: future() }, USER_A);
  const { status } = await call('DELETE', '/', undefined, USER_A);
  assert.equal(status, 200);
  const { json } = await call('GET', '/', undefined, USER_A);
  const alice = json.data.find((r) => r.user_id === USER_A);
  assert.equal(alice, undefined, 'Status should be gone after DELETE');
});

test('GET: does not return expired status', async () => {
  // Insert a row that expires 1 second from now, then wait 2 s... that is too slow.
  // Instead: insert directly with an already-past expires_at via direct DB write.
  db.prepare(`
    INSERT INTO user_availability (user_id, state, expires_at, set_at)
    VALUES (?, 'busy', '2000-01-01T00:00:00Z', strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(user_id) DO UPDATE SET
      state='busy', expires_at='2000-01-01T00:00:00Z',
      set_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  `).run(USER_A);
  const { json } = await call('GET', '/');
  const alice = json.data.find((r) => r.user_id === USER_A);
  assert.equal(alice, undefined, 'Expired status must not appear in GET');
  // Clean up
  db.prepare('DELETE FROM user_availability WHERE user_id = ?').run(USER_A);
});
