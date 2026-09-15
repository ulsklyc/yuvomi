/**
 * Regression: API-Token-Scope-Bypass am Auth-Router (GHSA-xcv5-6w6x-x5q2)
 *
 * Der Auth-Router ist in server/index.js absichtlich VOR den globalen
 * Scope-/Guest-/Modul-Gates gemountet, damit login/setup/oidc ohne Auth
 * erreichbar bleiben. Dadurch umging ein gescoptes API-Token die
 * Scope-Durchsetzung und konnte ueber /auth/api-tokens ein unbeschraenktes
 * Token bzw. ueber /auth/users einen Admin anlegen - vollstaendige
 * Privilege-Escalation trotz Least-Privilege-Scope.
 *
 * Der Fix (server/auth.js) haengt ein Router-Eingangs-Gate vor alle
 * Auth-Routen: ein gescoptes Token (`scopes !== null`) wird mit 403 abgewiesen,
 * ungescopte (Legacy-)Tokens und Session-Auth bleiben unberuehrt. `/auth` ist
 * kein scopebares Modul, das globale Gate wuerde jedes gescopte Token ohnehin
 * verwerfen - diese Sperre zieht dieselbe Grenze schon am Router-Eingang.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-auth-router-token-scope.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'auth-router-scope-test-secret';
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import express from 'express';

const dbmod = await import('../server/db.js');
const { router: authRouter } = await import('../server/auth.js');
const database = dbmod.get();

const adminId = Number(database.prepare(`
  INSERT INTO users(username, display_name, password_hash, role)
  VALUES ('scope-admin', 'Scope Admin', 'x', 'admin')
`).run().lastInsertRowid);

function mintToken(value, scopes) {
  database.prepare(`
    INSERT INTO api_tokens(name, token_hash, token_prefix, created_by, scopes)
    VALUES (?, ?, 'yuvomi_test', ?, ?)
  `).run(
    `token-${value}`,
    crypto.createHash('sha256').update(value).digest('hex'),
    adminId,
    scopes === null ? null : JSON.stringify(scopes),
  );
  return value;
}

// Subjekt ist in beiden Faellen der Admin: der Angriff nutzt genau ein
// gescoptes Token MIT Admin-Subjekt (so wird es in der App gemuenzt).
const scopedToken = mintToken('yuvomi_scoped_notes_read_token', ['notes:read']);
const legacyToken = mintToken('yuvomi_legacy_unscoped_token', null);

const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, token, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await response.json(); } catch { /* leerer Body */ }
  return { status: response.status, body: json };
}

test('gescoptes Token kann kein neues (unbeschraenktes) Token anlegen', async () => {
  const res = await call('POST', '/api/v1/auth/api-tokens', scopedToken, { name: 'pivot' });
  assert.equal(res.status, 403);
  const count = database.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE name = 'pivot'`).get().n;
  assert.equal(count, 0, 'kein Token durch den Bypass entstanden');
});

test('gescoptes Token kann keinen Admin-Benutzer anlegen', async () => {
  const res = await call('POST', '/api/v1/auth/users', scopedToken, {
    username: 'evil',
    display_name: 'e',
    password: 'P@ssw0rd-longenough',
    system_admin: true,
  });
  assert.equal(res.status, 403);
  const count = database.prepare(`SELECT COUNT(*) AS n FROM users WHERE username = 'evil'`).get().n;
  assert.equal(count, 0, 'kein Benutzer durch den Bypass entstanden');
});

test('gescoptes Token erreicht auch Lese-Auth-Routen nicht (/auth/me, /auth/api-tokens)', async () => {
  assert.equal((await call('GET', '/api/v1/auth/me', scopedToken)).status, 403);
  assert.equal((await call('GET', '/api/v1/auth/api-tokens', scopedToken)).status, 403);
});

test('leere Scope-Liste zaehlt als gescopt und wird ebenfalls abgewiesen', async () => {
  const emptyScoped = mintToken('yuvomi_empty_scope_token', []);
  assert.equal((await call('GET', '/api/v1/auth/me', emptyScoped)).status, 403);
});

test('ungescoptes (Legacy-)Token bleibt unberuehrt: Auth-Routen erreichbar', async () => {
  // /auth/me antwortet 200 mit Identitaet - das Gate laesst das Token durch,
  // requireAuth authentifiziert es normal.
  const me = await call('GET', '/api/v1/auth/me', legacyToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, adminId);

  // Und der eigentliche Verwaltungspfad funktioniert weiter (kein Kollateralschaden).
  const created = await call('POST', '/api/v1/auth/api-tokens', legacyToken, { name: 'legit' });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.scopes, null);
});

test('ohne Token: oeffentliche Weiche greift nicht (401 von requireAuth, nicht 403 vom Gate)', async () => {
  const res = await fetch(`${baseUrl}/api/v1/auth/me`);
  assert.equal(res.status, 401);
});
