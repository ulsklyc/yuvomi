/**
 * Test: Angemeldete Geraete (Vorbereitung des nativen Clients, Refs #255)
 *
 * Zweck: Ein Telefon mit nativem Client ist eine Person auf ihrem eigenen Geraet,
 *        mit WENIGER Reichweite als eine Browser-Sitzung. Es traegt ein Device
 *        Credential: eine Zeile in `api_tokens` mit `kind = 'device'`.
 *
 * WAS DIE FAELLE HALTEN
 *   1. Ausstellen geht nur aus einer Sitzung, nicht aus einem Credential, und
 *      nur fuer Haushaltsmitglieder. Dieselbe `device_id` ersetzt.
 *   2. 90 Tage ohne Benutzung beenden ein Credential, Benutzung verlaengert.
 *   3. Was eine Sitzung beendet, beendet auch die Geraete: Passwort, Admin-
 *      Passwort, "Auf anderen Geraeten abmelden", Deaktivieren und Loeschen.
 *      Integrations-Tokens bleiben dabei stehen.
 *   4. Kein Weg in die Verwaltung: Ein Admin ist auf dem Geraet ein Mitglied,
 *      und von `/auth` erreicht ein Credential nur eine Allowlist.
 *   5. Ein Admin sieht fremde Geraete nicht und kann ein Mitglied nur pauschal
 *      abmelden, die Token-Verwaltung fasst sie nicht an.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-signed-in-devices.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'signed-in-devices',
  env: { SESSION_SECRET: 'test-signed-in-devices-secret-min32chars' },
});

const API = `${BASE}/api/v1`;
const json = { 'Content-Type': 'application/json' };

async function login(username, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: json, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `Anmeldung ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${API}/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

const sessionHeaders = (s) => ({ ...json, Cookie: s.cookie, 'X-CSRF-Token': s.csrfToken });
const bearer = (credential) => ({ ...json, Authorization: `Bearer ${credential}` });

function register(session, body) {
  return fetch(`${API}/auth/devices`, {
    method: 'POST', headers: sessionHeaders(session), body: JSON.stringify(body),
  });
}

let deviceCounter = 0;
async function device(session, overrides = {}) {
  deviceCounter += 1;
  const res = await register(session, {
    name: `Telefon ${deviceCounter}`,
    platform: 'ios',
    device_id: `device-${deviceCounter}-${crypto.randomUUID()}`,
    ...overrides,
  });
  assert.equal(res.status, 201, 'Geraet angemeldet');
  return res.json();
}

const meStatus = async (credential) => (
  await fetch(`${API}/auth/me`, { headers: bearer(credential) })
).status;

await fetch(`${API}/auth/setup`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const admin = await login('admin', 'adminpass123');

let memberCounter = 0;
async function member() {
  memberCounter += 1;
  const username = `member${memberCounter}`;
  const password = `${username}pass1234`;
  const res = await fetch(`${API}/auth/users`, {
    method: 'POST',
    headers: sessionHeaders(admin),
    body: JSON.stringify({ username, display_name: username, password }),
  });
  assert.equal(res.status, 201, `Mitglied ${username} angelegt`);
  const created = await res.json();
  const id = created.user?.id ?? created.data?.id;
  assert.ok(id, 'Antwort nennt die Id');
  return { id, username, password, session: await login(username, password) };
}

const db = (await import('../server/db.js')).get();

function integrationToken(userId) {
  const token = `yuvomi_integration_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id)
    VALUES ('Integration', ?, 'yuvomi_integ', ?, ?)
  `).run(crypto.createHash('sha256').update(token).digest('hex'), userId, userId);
  return token;
}

test('ein Mitglied meldet ein Geraet an und arbeitet danach nur mit dem Credential', async () => {
  const { session } = await member();
  const body = await device(session, { name: 'Mein iPhone' });
  assert.equal(body.data.name, 'Mein iPhone');
  assert.equal(body.data.platform, 'ios');
  assert.match(body.credential, /^yuvomi_/);

  assert.equal(await meStatus(body.credential), 200, '/auth/me mit dem Credential');
  const tasks = await fetch(`${API}/tasks`, { headers: bearer(body.credential) });
  assert.equal(tasks.status, 200, 'ein Modul mit den Rechten der Person');
});

test('die Geraeteliste nennt das Geheimnis nie und markiert das aktuelle Geraet', async () => {
  const { session } = await member();
  const first = await device(session);
  const second = await device(session);

  const res = await fetch(`${API}/auth/devices`, { headers: bearer(second.credential) });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes(first.credential) && !raw.includes(second.credential));
  assert.ok(!raw.includes('token_hash'));
  const { data } = JSON.parse(raw);
  assert.equal(data.length, 2);
  assert.deepEqual(data.filter((d) => d.current).map((d) => d.id), [second.data.id]);
});

test('Absagen beim Anmelden: kein Credential aus einem Credential, ungueltige Angaben', async () => {
  const { session } = await member();
  const { credential } = await device(session);

  const chained = await fetch(`${API}/auth/devices`, {
    method: 'POST',
    headers: bearer(credential),
    body: JSON.stringify({ name: 'Zweites', platform: 'ios', device_id: 'chained-device' }),
  });
  assert.equal(chained.status, 403, 'ein verlorenes Telefon stellt kein weiteres aus');
  assert.equal((await chained.json()).reason, 'device_credential');

  const fromToken = await fetch(`${API}/auth/devices`, {
    method: 'POST',
    headers: bearer(integrationToken(1)),
    body: JSON.stringify({ name: 'Aus Token', platform: 'ios', device_id: 'from-integration' }),
  });
  assert.equal(fromToken.status, 403, 'eine Integration ist keine Anmeldung');
  assert.equal((await fromToken.json()).reason, 'session_required');

  for (const bad of [
    { platform: 'ios', device_id: 'abcdefgh' },
    { name: 'x'.repeat(101), platform: 'ios', device_id: 'abcdefgh' },
    { name: 'Telefon', device_id: 'abcdefgh' },
    { name: 'Telefon', platform: 'iOS 26!', device_id: 'abcdefgh' },
    { name: 'Telefon', platform: 'ios' },
    { name: 'Telefon', platform: 'ios', device_id: 'kurz' },
  ]) {
    assert.equal((await register(session, bad)).status, 400, JSON.stringify(bad));
  }
});

test('nur Mitglieder: Personal und Ausgaben-Gaeste bekommen kein Geraet', async () => {
  const worker = await member();
  db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(worker.id);
  const refusedWorker = await register(worker.session, { name: 'T', platform: 'ios', device_id: 'worker-device' });
  assert.ok([401, 403].includes(refusedWorker.status), 'Personal weist schon die Sitzung ab oder die Route');

  const guest = await member();
  db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(guest.id);
  const refusedGuest = await register(guest.session, { name: 'T', platform: 'ios', device_id: 'guest-device' });
  assert.equal(refusedGuest.status, 403);
  assert.equal((await refusedGuest.json()).reason, 'not_a_household_member');
});

test('dieselbe device_id ersetzt das Credential, statt ein zweites danebenzustellen', async () => {
  const { session } = await member();
  const first = await device(session, { device_id: 'same-phone-id' });
  const second = await device(session, { device_id: 'same-phone-id' });

  assert.equal(await meStatus(first.credential), 401, 'das alte Credential ist tot');
  assert.equal(await meStatus(second.credential), 200);
  const list = await (await fetch(`${API}/auth/devices`, { headers: bearer(second.credential) })).json();
  assert.equal(list.data.length, 1, 'ein Telefon, eine Zeile');
});

test('90 Tage ohne Benutzung beenden das Credential, Benutzung verlaengert', async () => {
  const { session } = await member();
  const { credential, data } = await device(session);
  const setLastUsed = (days) => db.prepare(`
    UPDATE api_tokens
       SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?), created_at = '2020-01-01T00:00:00Z'
     WHERE id = ?
  `).run(`-${days} days`, data.id);

  setLastUsed(89);
  assert.equal(await meStatus(credential), 200, 'knapp unter der Frist');
  const after = db.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(data.id);
  assert.ok(Date.parse(after.last_used_at) > Date.now() - 60_000, 'die Benutzung schiebt die Frist');

  setLastUsed(91);
  assert.equal(await meStatus(credential), 401, 'ueber der Frist');
});

test('eine Integration ohne Benutzung laeuft nicht ab: die Frist gilt nur Geraeten', async () => {
  const { id } = await member();
  const token = integrationToken(id);
  db.prepare(`UPDATE api_tokens SET last_used_at = '2020-01-01T00:00:00Z' WHERE token_prefix = 'yuvomi_integ'`).run();
  assert.equal(await meStatus(token), 200);
});

test('"Auf anderen Geraeten abmelden" beendet auch Geraete und zaehlt sie mit', async () => {
  const { id, session } = await member();
  const { credential } = await device(session);
  const token = integrationToken(id);

  const res = await fetch(`${API}/auth/logout-others`, { method: 'POST', headers: sessionHeaders(session) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ended, 1);
  assert.equal(await meStatus(credential), 401);
  assert.equal(await meStatus(token), 200, 'eine Integration ist kein Geraet');
});

test('der eigene Passwortwechsel beendet die Geraete', async () => {
  const { password, session } = await member();
  const { credential } = await device(session);
  const res = await fetch(`${API}/auth/me/password`, {
    method: 'PATCH',
    headers: sessionHeaders(session),
    body: JSON.stringify({ current_password: password, new_password: 'ganzneuespasswort1' }),
  });
  assert.equal(res.status, 200);
  assert.equal(await meStatus(credential), 401);
});

test('das Admin-Passwort beendet die Geraete des Mitglieds', async () => {
  const { id, session } = await member();
  const { credential } = await device(session);
  const res = await fetch(`${API}/auth/users/${id}`, {
    method: 'PATCH',
    headers: sessionHeaders(admin),
    body: JSON.stringify({ password: 'vomadmingesetzt1234' }),
  });
  assert.equal(res.status, 200);
  assert.equal(await meStatus(credential), 401);
});

test('Deaktivieren und Loeschen beenden die Geraete', async () => {
  const gone = await member();
  const { credential } = await device(gone.session);
  const res = await fetch(`${API}/auth/users/${gone.id}`, { method: 'DELETE', headers: sessionHeaders(admin) });
  assert.equal(res.status, 200);
  assert.equal(await meStatus(credential), 401);
});

test('ein Admin ist auf dem Geraet ein Mitglied: keine Admin-Route, weder hier noch dort', async () => {
  const { credential } = await device(admin);
  assert.equal((await fetch(`${API}/displays`, { headers: sessionHeaders(admin) })).status, 200, 'die Sitzung darf');

  const refused = await fetch(`${API}/displays`, { headers: bearer(credential) });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).reason, 'device_credential');

  const tokens = await fetch(`${API}/auth/api-tokens`, { headers: bearer(credential) });
  assert.equal(tokens.status, 403);
  assert.equal((await fetch(`${API}/tasks`, { headers: bearer(credential) })).status, 200, 'der Alltag bleibt');
});

test('von /auth erreicht ein Credential nur die Allowlist', async () => {
  const { session } = await member();
  const { credential } = await device(session);
  for (const [method, path] of [
    ['PATCH', '/auth/me/profile'],
    ['PATCH', '/auth/me/password'],
    ['POST', '/auth/2fa/disable'],
    ['POST', '/auth/2fa/setup'],
    ['POST', '/auth/logout-others'],
    ['GET', '/auth/oidc/link'],
  ]) {
    const res = await fetch(`${API}${path}`, { method, headers: bearer(credential), body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).reason, 'device_credential', `${method} ${path}`);
  }
  assert.equal((await fetch(`${API}/auth/users`, { headers: bearer(credential) })).status, 200, 'die Personenliste braucht die Zuweisung');
});

test('ein ungueltiges Credential ist kein Geraet: das Tor laesst es zur Antwort 401 durch', async () => {
  assert.equal(await meStatus('yuvomi_gibt_es_nicht'), 401);
});

test('abmelden: das aktuelle Geraet, ein eigenes Geraet, kein fremdes', async () => {
  const { session } = await member();
  const other = await member();
  const here = await device(session);
  const there = await device(session);
  const foreign = await device(other.session);

  const refused = await fetch(`${API}/auth/devices/${foreign.data.id}`, { method: 'DELETE', headers: bearer(here.credential) });
  assert.equal(refused.status, 404, 'ein fremdes Geraet gibt es hier nicht');
  assert.equal(await meStatus(foreign.credential), 200);

  const byId = await fetch(`${API}/auth/devices/${there.data.id}`, { method: 'DELETE', headers: sessionHeaders(session) });
  assert.equal(byId.status, 200);
  assert.equal(await meStatus(there.credential), 401);

  const current = await fetch(`${API}/auth/devices/current`, { method: 'DELETE', headers: bearer(here.credential) });
  assert.equal(current.status, 200);
  assert.equal(await meStatus(here.credential), 401);

  const noDevice = await fetch(`${API}/auth/devices/current`, { method: 'DELETE', headers: sessionHeaders(session) });
  assert.equal(noDevice.status, 403, 'eine Sitzung ist kein aktuelles Geraet');
});

test('ein Admin meldet ein Mitglied pauschal ab und erfaehrt dabei nichts ueber dessen Geraete', async () => {
  const target = await member();
  const { credential } = await device(target.session, { name: 'Geheimes Telefon' });
  const token = integrationToken(target.id);

  const asMember = await fetch(`${API}/auth/users/${target.id}/devices/sign-out`, {
    method: 'POST', headers: sessionHeaders((await member()).session),
  });
  assert.equal(asMember.status, 403);

  const res = await fetch(`${API}/auth/users/${target.id}/devices/sign-out`, { method: 'POST', headers: sessionHeaders(admin) });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.deepEqual(JSON.parse(raw), { ok: true }, 'keine Zahl, kein Name, keine Zeit');
  assert.equal(await meStatus(credential), 401);
  assert.equal(
    (await fetch(`${API}/auth/me`, { headers: { Cookie: target.session.cookie } })).status,
    401,
    'auch die Browser-Sitzung: das Telefon kann die PWA tragen',
  );
  assert.equal(await meStatus(token), 200, 'Integrationen bleiben');
  assert.equal(
    (await fetch(`${API}/auth/users/999999/devices/sign-out`, { method: 'POST', headers: sessionHeaders(admin) })).status,
    404,
  );
});

test('die eigene Admin-Sitzung ueberlebt das Abmelden der eigenen Geraete', async () => {
  const self = await login('admin', 'adminpass123');
  const me = await (await fetch(`${API}/auth/me`, { headers: { Cookie: self.cookie } })).json();
  const res = await fetch(`${API}/auth/users/${me.user.id}/devices/sign-out`, { method: 'POST', headers: sessionHeaders(self) });
  assert.equal(res.status, 200);
  assert.equal((await fetch(`${API}/auth/me`, { headers: { Cookie: self.cookie } })).status, 200);
});

test('die Token-Verwaltung fasst Geraete nicht an', async () => {
  // Eine frische Sitzung: der Fall darueber hat alle anderen des Admins beendet.
  const adminNow = await login('admin', 'adminpass123');
  const created = await fetch(`${API}/auth/users`, {
    method: 'POST',
    headers: sessionHeaders(adminNow),
    body: JSON.stringify({ username: 'tokenmember', display_name: 'T', password: 'tokenmember1234' }),
  });
  assert.equal(created.status, 201);
  const { credential, data } = await device(await login('tokenmember', 'tokenmember1234'), { name: 'Unsichtbar' });

  const list = await fetch(`${API}/auth/api-tokens`, { headers: sessionHeaders(adminNow) });
  assert.equal(list.status, 200);
  assert.ok(!(await list.text()).includes('Unsichtbar'), 'der Admin sieht es nicht');

  const revoke = await fetch(`${API}/auth/api-tokens/${data.id}`, { method: 'DELETE', headers: sessionHeaders(adminNow) });
  assert.equal(revoke.status, 404);
  const remove = await fetch(`${API}/auth/api-tokens/${data.id}/remove`, { method: 'POST', headers: sessionHeaders(adminNow) });
  assert.equal(remove.status, 404);
  assert.equal(await meStatus(credential), 200);
});
