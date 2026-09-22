/**
 * Test: Auf anderen Geraeten abmelden (#1354)
 *
 * Zweck: Seit D#1242 bleibt eine unbenutzte Sitzung 90 Tage gueltig. Ein
 *        verlorenes Telefon blieb damit bis zu drei Monate angemeldet, und das
 *        Mitglied konnte daran nichts tun: `POST /auth/logout` beendet nur die
 *        eigene Sitzung, alle anderen endeten nur als Nebenwirkung (Passwort,
 *        2FA, Admin, Reset, Loeschen).
 *
 * WAS DIE FAELLE HALTEN
 *   1. Nach `POST /auth/logout-others` ist jede andere Sitzung desselben
 *      Mitglieds 401, die aufrufende bleibt angemeldet, die Sitzung eines
 *      anderen Mitglieds bleibt unberuehrt - und die Antwort nennt die Zahl.
 *   2. Ohne Sitzung 401, ohne CSRF-Token 403 - und dann endet auch nichts.
 *   3. Ein API-Token ist keine Sitzung: es darf die Sitzungen nicht beenden
 *      (es gibt keine "aktuelle", die es ausnehmen koennte) und bleibt selbst
 *      gueltig.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-sign-out-other-sessions.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'sign-out-other-sessions',
  env: { SESSION_SECRET: 'test-sign-out-others-secret-min32chars' },
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `Anmeldung ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

async function meStatus(session) {
  return (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: session.cookie } })).status;
}

function signOutOthers({ cookie, csrfToken } = {}, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return fetch(`${BASE}/api/v1/auth/logout-others`, { method: 'POST', headers });
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const adminSetup = await login('admin', 'adminpass123');
const created = await fetch(`${BASE}/api/v1/auth/users`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: adminSetup.cookie, 'X-CSRF-Token': adminSetup.csrfToken },
  body: JSON.stringify({ username: 'kid', display_name: 'Kid', password: 'kidpass1234' }),
});
assert.equal(created.status, 201, 'zweites Mitglied angelegt');

test('beendet alle anderen Sitzungen des Mitglieds, die eigene und fremde bleiben', async () => {
  const phone = await login('kid', 'kidpass1234');
  const laptop = await login('kid', 'kidpass1234');
  const tablet = await login('kid', 'kidpass1234');
  const other = await login('admin', 'adminpass123');

  const res = await signOutOthers(phone);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ended, 2, 'Antwort nennt die Zahl der beendeten Sitzungen');

  assert.equal(await meStatus(laptop), 401, 'zweite Sitzung desselben Mitglieds ist beendet');
  assert.equal(await meStatus(tablet), 401, 'dritte Sitzung desselben Mitglieds ist beendet');
  assert.equal(await meStatus(phone), 200, 'die aufrufende Sitzung bleibt angemeldet');
  assert.equal(await meStatus(other), 200, 'die Sitzung eines anderen Mitglieds bleibt');

  // Ein zweiter Aufruf findet nichts mehr - die eigene Sitzung zaehlt nie mit.
  const again = await (await signOutOthers(phone)).json();
  assert.equal(again.ended, 0, 'die eigene Sitzung zaehlt nicht mit');
  assert.equal(await meStatus(phone), 200, 'auch nach dem zweiten Aufruf angemeldet');
});

test('ohne Sitzung 401, ohne CSRF-Token 403 - und es endet nichts', async () => {
  const caller = await login('kid', 'kidpass1234');
  const second = await login('kid', 'kidpass1234');

  assert.equal((await signOutOthers({})).status, 401, 'ohne Sitzung abgewiesen');
  assert.equal((await signOutOthers({ cookie: caller.cookie })).status, 403, 'ohne CSRF-Token abgewiesen');
  assert.equal(await meStatus(second), 200, 'die andere Sitzung lebt nach den abgewiesenen Aufrufen');
});

test('ein API-Token beendet keine Sitzungen und bleibt selbst gueltig', async () => {
  const admin = await login('admin', 'adminpass123');
  const secondAdmin = await login('admin', 'adminpass123');
  const tokenRes = await fetch(`${BASE}/api/v1/auth/api-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken },
    body: JSON.stringify({ name: 'probe' }),
  });
  assert.equal(tokenRes.status, 201, 'API-Token angelegt');
  const { token } = await tokenRes.json();
  assert.ok(token, 'Token im Klartext zurueck');

  const res = await signOutOthers({}, { Authorization: `Bearer ${token}` });
  assert.equal(res.status, 403, 'ein Token ist keine Sitzung');
  assert.equal(await meStatus(admin), 200, 'Sitzung A lebt');
  assert.equal(await meStatus(secondAdmin), 200, 'Sitzung B lebt');
  const probe = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(probe.status, 200, 'das Token selbst bleibt gueltig');
});
