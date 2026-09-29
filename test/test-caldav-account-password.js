/**
 * Modul: CalDAV-Konto - neuer Server braucht das Passwort neu
 * Zweck: `updateAccount` testete die Verbindung bei geaenderter Adresse mit
 *        dem GESPEICHERTEN Passwort (`password || account.password`). Ein PUT
 *        mit fremder Adresse und ohne Passwort schickte die Basic-Zugangsdaten
 *        des Haushalts also sofort an diesen Host - noch bevor irgendetwas
 *        gespeichert war. Fuer CardDAV gilt seit v2.70.0 die Regel "neuer Server
 *        oder Benutzer = Passwort neu eingeben" (test/test-carddav-admin-gate.js);
 *        diese Suite haelt dieselbe Regel fuer CalDAV fest.
 *
 *        Die Suite laeuft durch den ECHTEN Server (test/server-ready.js), und
 *        ein lokaler HTTP-Server spielt den fremden Host und schneidet jeden
 *        Authorization-Header mit: gemessen wird, was dort ankam und was in
 *        der Tabelle steht, nicht nur der Statuscode.
 * Ausfuehren: node --experimental-sqlite --test test/test-caldav-account-password.js
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'caldav-account-password',
  env: { SESSION_SECRET: 'test-caldav-account-password-secret-32' },
});
const db = (await import('../server/db.js')).get();

// Der fremde Host: antwortet immer 401, merkt sich aber jede Anfrage.
const seen = [];
const foreign = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
  res.end();
});
await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
const FOREIGN_URL = `http://127.0.0.1:${foreign.address().port}/dav/`;
after(() => new Promise((resolve) => foreign.close(resolve)));

const HOUSEHOLD_SECRET = 'household-caldav-secret';
const leakedToForeignHost = () => seen.some((r) => r.authorization
  && Buffer.from(r.authorization.replace(/^Basic /, ''), 'base64').toString().includes(HOUSEHOLD_SECRET));

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
});
assert.equal(loginRes.status, 200, 'login admin');
const cookie = cookieHeader(loginRes.headers.get('set-cookie'));
const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
const AUTH = { Cookie: cookie, 'X-CSRF-Token': me.csrfToken };

async function admin(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function seedAccount(tag) {
  return db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('Haushalt', ?, 'family', ?)
  `).run(`https://dav.example.invalid/${tag}/`, HOUSEHOLD_SECRET).lastInsertRowid;
}
const accountRow = (id) => db.prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(id);

test('Neuer Server ohne neues Passwort: 400 password_required, nichts gesendet, nichts geschrieben', async () => {
  const id = seedAccount('host');
  seen.length = 0;
  const put = await admin('PUT', `/calendar/caldav/accounts/${id}`, { caldavUrl: FOREIGN_URL });
  assert.equal(leakedToForeignHost(), false, 'Passwort beim fremden Host angekommen');
  assert.equal(seen.length, 0, `der fremde Host sah ${seen.length} Anfragen`);
  assert.equal(put.status, 400);
  assert.equal(put.body.errorCode, 'password_required');
  assert.equal(accountRow(id).caldav_url, 'https://dav.example.invalid/host/', 'Adresse unveraendert');
  assert.equal(accountRow(id).password, HOUSEHOLD_SECRET, 'Passwort unveraendert');
});

test('Neuer Server, leeres Passwort und neuer Name: ebenso abgelehnt', async () => {
  const id = seedAccount('empty');
  seen.length = 0;
  const put = await admin('PUT', `/calendar/caldav/accounts/${id}`, { name: 'Umbenannt', caldavUrl: FOREIGN_URL, username: 'family', password: '' });
  assert.equal(seen.length, 0, 'kein Verbindungsversuch');
  assert.equal(put.status, 400);
  assert.equal(put.body.errorCode, 'password_required');
  assert.equal(accountRow(id).name, 'Haushalt', 'nichts geschrieben, auch der Name nicht');
});

test('Anderer Port oder anderes Schema zaehlt als neuer Server', async () => {
  const id = seedAccount('port');
  for (const url of ['https://dav.example.invalid:8443/port/', 'http://dav.example.invalid/port/']) {
    const put = await admin('PUT', `/calendar/caldav/accounts/${id}`, { caldavUrl: url });
    assert.equal(put.status, 400, url);
    assert.equal(put.body.errorCode, 'password_required', url);
  }
  assert.equal(accountRow(id).caldav_url, 'https://dav.example.invalid/port/');
});

test('Neuer Benutzername ohne neues Passwort: 400 password_required', async () => {
  const id = seedAccount('user');
  const put = await admin('PUT', `/calendar/caldav/accounts/${id}`, { username: 'someone-else' });
  assert.equal(put.status, 400);
  assert.equal(put.body.errorCode, 'password_required');
  assert.equal(accountRow(id).username, 'family', 'Benutzer unveraendert');
});

test('Neuer Server MIT neuem Passwort: der Test geht mit dem NEUEN Passwort raus', async () => {
  const id = seedAccount('move');
  seen.length = 0;
  const put = await admin('PUT', `/calendar/caldav/accounts/${id}`, { caldavUrl: FOREIGN_URL, password: 'new-secret' });
  // Der fremde Host lehnt ab (401) - die Verbindung scheitert, gespeichert wird nichts.
  assert.equal(put.status, 500);
  assert.ok(seen.length > 0, 'der Verbindungstest lief');
  assert.equal(leakedToForeignHost(), false, 'nur das neu eingegebene Passwort ging raus');
  assert.equal(accountRow(id).caldav_url, 'https://dav.example.invalid/move/');
});

test('Nur ein neuer Name: kein Passwort noetig, kein Verbindungstest', async () => {
  const id = seedAccount('rename');
  seen.length = 0;
  const put = await admin('PUT', `/calendar/caldav/accounts/${id}`, { name: 'Familie' });
  assert.equal(put.status, 200);
  assert.equal(accountRow(id).name, 'Familie');
  assert.equal(accountRow(id).password, HOUSEHOLD_SECRET);
  assert.equal(seen.length, 0);
});
