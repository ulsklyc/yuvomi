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

const db = (await import('../server/db.js')).get();
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');

/** Die Sitzungs-ID hinter einem Cookie-Header (signiert: `s:<sid>.<sig>`). */
function sidOf(cookie) {
  const signed = decodeURIComponent(/yuvomi\.sid=([^;]+)/.exec(cookie)[1]);
  return signed.slice(2, signed.lastIndexOf('.'));
}

async function createMember(username) {
  const res = await fetch(`${BASE}/api/v1/auth/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminSetup.cookie, 'X-CSRF-Token': adminSetup.csrfToken },
    body: JSON.stringify({ username, display_name: username, password: `${username}pass1234` }),
  });
  assert.equal(res.status, 201, `Mitglied ${username} angelegt`);
}

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

test('eine abgelaufene, noch nicht aufgeraeumte Zeile zaehlt nicht als beendete Sitzung', async () => {
  // Der Store raeumt abgelaufene Zeilen nur alle 15 Minuten weg. Bis dahin steht
  // eine Sitzung, die laengst nicht mehr gilt, noch in der Tabelle - die Antwort
  // darf sie nicht als "1 andere Sitzung beendet" melden (Review zu #1423).
  await createMember('expiry');
  const caller = await login('expiry', 'expirypass1234');
  const stale = await login('expiry', 'expirypass1234');
  db.prepare('UPDATE sessions SET expired_at = ? WHERE sid = ?').run(Date.now() - 1000, sidOf(stale.cookie));

  const body = await (await signOutOthers(caller)).json();
  assert.equal(body.ended, 0, 'eine abgelaufene Zeile ist keine lebende Sitzung');
  const left = db.prepare('SELECT 1 FROM sessions WHERE sid = ?').get(sidOf(stale.cookie));
  assert.equal(left, undefined, 'geloescht wird die abgelaufene Zeile trotzdem');
  assert.equal(await meStatus(caller), 200, 'die eigene Sitzung bleibt');
});

test('ein gekoppeltes Display neben einer Sitzung wird abgewiesen, und nichts endet', async () => {
  const admin = await login('admin', 'adminpass123');
  const secondAdmin = await login('admin', 'adminpass123');
  const adminHeaders = { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken };
  const createdDisplay = await fetch(`${BASE}/api/v1/displays`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ display_name: 'Kueche' }),
  });
  assert.equal(createdDisplay.status, 201, 'Display angelegt');
  const displayId = (await createdDisplay.json()).data.id;
  const issued = await fetch(`${BASE}/api/v1/displays/${displayId}/pairing-code`, {
    method: 'POST', headers: adminHeaders, body: '{}',
  });
  const { code } = (await issued.json()).data;
  const paired = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(paired.status, 201, 'Geraet gekoppelt');
  const match = String(paired.headers.get('set-cookie') || '').match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`));
  assert.ok(match, 'Display-Cookie gesetzt');

  // Das Tablett, auf dem sich ausserdem ein Mensch angemeldet hat: Sitzungs-
  // Cookie UND gueltiges CSRF-Token der Sitzung, dazu das Display-Cookie.
  const res = await signOutOthers(
    { cookie: `${admin.cookie}; ${DISPLAY_COOKIE}=${match[1]}`, csrfToken: admin.csrfToken },
  );
  assert.equal(res.status, 403, 'das Display fuehrt, und ein Display beendet keine Sitzungen');
  assert.equal(await meStatus(secondAdmin), 200, 'die andere Sitzung lebt');
});

test('der Limiter zaehlt je Mitglied, nicht je Adresse', async () => {
  // Hinter einem Proxy ohne `trust proxy` kommt der ganze Haushalt von EINER
  // Adresse. Zaehlte der Limiter je IP, sperrte ein Mitglied mit ein paar
  // Klicks alle anderen aus (Review zu #1423). Diese Suite laeuft komplett von
  // 127.0.0.1 - genau diese Lage.
  await createMember('eager');
  await createMember('patient');
  const eager = await login('eager', 'eagerpass1234');
  const statuses = [];
  for (let i = 0; i < 7; i += 1) statuses.push((await signOutOthers(eager)).status);
  assert.ok(statuses.includes(429), `wer zu oft klickt, wird gebremst: ${statuses.join(',')}`);

  const patient = await login('patient', 'patientpass1234');
  assert.equal((await signOutOthers(patient)).status, 200, 'ein anderes Mitglied von derselben Adresse ist frei');
});

test('Loeschen eines Mitglieds beendet jede seiner Sitzungen, auch eine abgelaufene Zeile', async () => {
  // Loeschen laeuft ueber denselben Helfer wie "Auf anderen Geraeten abmelden"
  // statt ueber eine eigene Kopie der Schleife.
  await createMember('leaving');
  const phone = await login('leaving', 'leavingpass1234');
  const laptop = await login('leaving', 'leavingpass1234');
  const stale = await login('leaving', 'leavingpass1234');
  db.prepare('UPDATE sessions SET expired_at = ? WHERE sid = ?').run(Date.now() - 1000, sidOf(stale.cookie));
  const admin = await login('admin', 'adminpass123');
  const { id } = db.prepare("SELECT id FROM users WHERE username = 'leaving'").get();

  const res = await fetch(`${BASE}/api/v1/auth/users/${id}`, {
    method: 'DELETE',
    headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrfToken },
  });
  assert.equal(res.status, 200);
  for (const s of [phone, laptop, stale]) {
    assert.equal(db.prepare('SELECT 1 FROM sessions WHERE sid = ?').get(sidOf(s.cookie)), undefined,
      'keine Sitzungszeile des geloeschten Mitglieds bleibt');
  }
  assert.equal(await meStatus(phone), 401);
  assert.equal(await meStatus(admin), 200, 'die Sitzung des Admins bleibt');
});
