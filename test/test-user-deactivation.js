/**
 * Test: Ein Konto mit Spuren wird deaktiviert statt geloescht (#1381)
 * Zweck: `DELETE /api/v1/auth/users/:id` liess bis hierher die Fremdschluessel
 *        entscheiden. Wer eine Buchung fuer andere eingetragen hatte, nahm sie
 *        mit (CASCADE, die Salden der anderen aenderten sich still); wer an
 *        einer Ausgabe beteiligt war oder je einen Quick-Link angelegt hatte,
 *        liess sich gar nicht entfernen (RESTRICT / NO ACTION, die Route
 *        antwortete 500).
 *
 *        Jetzt: Spuren in geteilten Daten -> das Konto wird DEAKTIVIERT. Die
 *        Zeile bleibt, damit Urheberschaft und Salden bleiben; jeder Zugang
 *        endet sofort. Ohne Spuren wird es geloescht wie bisher.
 *
 *        Gemessen wird ueber den ECHTEN Server (test/server-ready.js): die
 *        Regel "ein Ehemaliger kommt auf keinem Weg mehr hinein" ist eine
 *        Aussage ueber jeden Weg, und jeder Weg ist deshalb ein eigener Test -
 *        Passwort, SSO (per `sub` und per Adresse), API-Token, bestehende
 *        Sitzung, die fuenf Abo-Adressen, die Stellvertretung am Wandtablett,
 *        der Passwort-Reset. Dazu die Zustellung: Push, Mail, Kanaele.
 *
 *        Wie der Anbieter hineinkommt: `openid-client` wird per `mock.module`
 *        ersetzt, wie in test-staff-sign-in.js. Nachgebaut ist nur, was der
 *        Callback nach der kryptografischen Pruefung sieht.
 *
 *        Wo ein Test die Spalte selbst setzt (eine Zeile, die nach dem
 *        Deaktivieren noch dasteht oder neu entsteht), haelt er die ZWEITE
 *        Linie fest: das Deaktivieren raeumt das Zugangsmaterial ab, und der
 *        jeweilige Weg fragt trotzdem selbst. Diese Tests heissen "auch wenn".
 * Ausfuehren: npm run test:user-deactivation
 */
process.env.OIDC_ISSUER = 'https://idp.example/';
process.env.OIDC_CLIENT_ID = 'yuvomi';
process.env.OIDC_CLIENT_SECRET = 'shh';
process.env.OIDC_REDIRECT_URI = 'http://127.0.0.1/api/v1/auth/oidc/callback';
delete process.env.AUTH_ALLOW_PASSWORD_LOGIN;
delete process.env.OIDC_ALLOW_SIGNUP;
delete process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM;

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { startTestServer, cookieHeader } from './server-ready.js';

/** Was der Anbieter beim naechsten Callback liefert. */
let idp = { claims: {}, userinfo: {} };

// `namedExports` statt `exports`: die CI faehrt Node 22 und 24, dort gibt es nur
// diese Form; neuere Node-Versionen warnen, fuehren sie aber aus.
mock.module('openid-client', {
  namedExports: {
    discovery: async () => ({ issuer: process.env.OIDC_ISSUER }),
    ClientSecretBasic: () => () => {},
    randomState: () => 'test-state',
    randomNonce: () => 'test-nonce',
    randomPKCECodeVerifier: () => 'test-verifier',
    calculatePKCECodeChallenge: async () => 'test-challenge',
    buildAuthorizationUrl: () => new URL('https://idp.example/authorize'),
    authorizationCodeGrant: async () => ({ access_token: 'test-access-token', claims: () => idp.claims }),
    fetchUserInfo: async () => idp.userinfo,
  },
});

const { baseUrl: BASE } = await startTestServer({
  name: 'user-deactivation',
  env: { SESSION_SECRET: 'test-user-deactivation-secret-32chars', RATE_LIMIT_MAX_ATTEMPTS: '500' },
});
const db = (await import('../server/db.js')).get();
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');
const { buildResetRoutes } = await import('../server/auth.js');
const { passwordResetService } = await import('../server/services/password-reset.js');
const { createPushService } = await import('../server/services/push.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { memberEmail } = await import('../server/services/member-email.js');

// --------------------------------------------------------------------------
// Werkzeug
// --------------------------------------------------------------------------

async function loginRaw(username, password) {
  return fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

async function login(username, password) {
  const res = await loginRaw(username, password);
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

function as(session) {
  const headers = session.token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }
    : { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* leer */ }
    return { status: res.status, body: json };
  };
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const adminSession = await login('admin', 'adminpass123');
const admin = as(adminSession);
const ADMIN = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;

let counter = 0;
/** Ein Mitglied ueber die echte Route, samt eigener Sitzung. */
async function member(displayName, extra = {}) {
  counter += 1;
  const username = `user${counter}`;
  const password = `${username}-pass-123`;
  const r = await admin('POST', '/auth/users', { username, display_name: displayName, password, ...extra });
  assert.equal(r.status, 201, `create ${username}`);
  const session = await login(username, password);
  return { id: r.body.user.id, username, password, session, call: as(session), name: displayName };
}

const remove = (user) => admin('DELETE', `/auth/users/${user.id}`);
const row = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const count = (sql, ...args) => db.prepare(sql).get(...args).n;

/** Legt einen Quick-Link an: die kleinste Spur, die ein Konto hinterlassen kann. */
async function leaveTrace(user) {
  const r = await user.call('POST', '/quick-links', { name: `Link von ${user.name}`, url: 'https://example.com/' });
  assert.equal(r.status, 201, 'Vorbedingung: Quick-Link angelegt');
  return r.body.data.id;
}

/** Deaktiviert ein Mitglied ueber die Route und prueft, dass es so kam. */
async function deactivate(user) {
  await leaveTrace(user);
  const r = await remove(user);
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'deactivated');
  return r;
}

function sessionsOf(userId) {
  return db.prepare('SELECT sess FROM sessions').all()
    .filter((r) => { try { return JSON.parse(r.sess).userId === userId; } catch { return false; } }).length;
}

function cookiesOf(res, fallback = '') {
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return set.length ? set.join('; ') : fallback;
}

/** Faehrt eine SSO-Anmeldung von `/oidc/start` bis zur Frage, ob eine Sitzung besteht. */
async function ssoSignIn({ claims, userinfo = {} }) {
  idp = { claims: { iss: process.env.OIDC_ISSUER, ...claims }, userinfo: { sub: claims.sub, ...userinfo } };
  const start = await fetch(`${BASE}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 302, 'Vorbedingung: /oidc/start leitet zum Anbieter');
  const startCookie = cookiesOf(start);
  const callback = await fetch(`${BASE}/api/v1/auth/oidc/callback?code=test-code&state=test-state`, {
    redirect: 'manual',
    headers: { cookie: startCookie },
  });
  const cookie = cookiesOf(callback, startCookie);
  const me = await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie } });
  return { status: callback.status, location: callback.headers.get('location'), meStatus: me.status };
}

// --------------------------------------------------------------------------
// Die Entscheidung: deaktivieren oder loeschen
// --------------------------------------------------------------------------

test('ohne Spuren: das Konto wird geloescht, samt der Verweise ohne Fremdschluessel', async () => {
  const u = await member('Ohne Spur');
  // Eigene Einstellung und abweichende Rechte: zwei Verweise ohne FK, die bisher
  // als Waisen liegen blieben.
  db.prepare("INSERT INTO sync_config (key, value) VALUES (?, 'x')").run(`dashboard_layout:user:${u.id}`);
  assert.equal((await admin('PUT', `/permissions/user/${u.id}`, { modules: { budget: 'read' } })).status, 200);
  assert.ok(count("SELECT COUNT(*) AS n FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?", String(u.id)) > 0);

  const r = await remove(u);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, outcome: 'deleted', traces: [] });
  assert.equal(row(u.id), undefined, 'die Zeile ist weg');
  assert.equal(sessionsOf(u.id), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM sync_config WHERE key LIKE '%:user:' || ?", String(u.id)), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?", String(u.id)), 0);
  assert.equal((await u.call('GET', '/auth/me')).status, 401);
});

test('nur private Daten sind keine Spur: eigene Gesundheitsdaten, eigener Schichtplan, eigenes Token', async () => {
  const u = await member('Nur Privates');
  db.prepare("INSERT INTO health_vitals (user_id, type, value_num, measured_at) VALUES (?, 'weight', 70, '2026-09-01T08:00:00Z')").run(u.id);
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/privat', 'k', 'a')").run(u.id);
  // Ein Token, das der Admin FUER dieses Konto ausgestellt hat.
  assert.equal((await admin('POST', '/auth/api-tokens', { name: 'fuer u', subject_user_id: u.id })).status, 201);
  const r = await remove(u);
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'deleted');
  assert.equal(row(u.id), undefined);
});

test('ein Quick-Link genuegt: 200 und deaktiviert statt 500 (NO ACTION)', async () => {
  const u = await member('Quick-Link');
  const link = await leaveTrace(u);
  const r = await remove(u);
  assert.equal(r.status, 200, 'vorher: 500 Internal server error');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.outcome, 'deactivated');
  assert.deepEqual(r.body.traces, [{ table: 'quick_links', column: 'created_by', rows: 1 }]);
  assert.match(row(u.id).deactivated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(count('SELECT COUNT(*) AS n FROM quick_links WHERE id = ?', link), 1, 'der Quick-Link bleibt');
});

test('ein zweites Entfernen laesst ein deaktiviertes Konto, wie es ist', async () => {
  const u = await member('Zweimal');
  await deactivate(u);
  const at = row(u.id).deactivated_at;
  const again = await remove(u);
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, 'deactivated');
  assert.equal(row(u.id).deactivated_at, at, 'der Zeitpunkt des ersten Mals bleibt');
});

// --------------------------------------------------------------------------
// Geteilte Ausgaben: der Anlass des Tickets
// --------------------------------------------------------------------------

const OWN = await member('Olivia');
const CR = await member('Clara');
const OTH = await member('Otto');
const groupRes = await OWN.call('POST', '/split-expenses/groups', { name: 'WG-Kasse', type: 'household', default_currency: 'EUR' });
assert.equal(groupRes.status, 201);
const GROUP = groupRes.body.data.id;
for (const u of [CR, OTH]) {
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: u.id, role: 'guest' })).status, 201);
}
// 30.00, von Olivia bezahlt, zu dritt geteilt: Olivia +20, Clara -10, Otto -10.
assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
  title: 'Einkauf', amount: '30.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
  participants: [OWN.id, CR.id, OTH.id], expense_date: '2026-09-01',
})).status, 201);

async function balances() {
  const r = await OWN.call('GET', `/split-expenses/groups/${GROUP}/balances`);
  assert.equal(r.status, 200);
  return Object.fromEntries(r.body.data.balances.map((b) => [b.user_id, b.net_minor]));
}

test('wer eine Zahlung nur ERFASST hat: Zahlung und Salden bleiben, das Konto wird deaktiviert', async () => {
  const REC = await member('Rolf');
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: REC.id, role: 'admin' })).status, 201);
  // Rolf traegt Claras Zahlung an Olivia ein - er ist weder Zahler noch Empfaenger.
  const pay = await REC.call('POST', `/split-expenses/groups/${GROUP}/settlements`, {
    payer_id: CR.id, payee_id: OWN.id, amount: '4.00', currency: 'EUR',
  });
  assert.equal(pay.status, 201);
  const sid = pay.body.data.id;
  const before = await balances();
  assert.deepEqual(before, { [OWN.id]: 1600, [CR.id]: -600, [OTH.id]: -1000 });
  const ledgerBefore = count('SELECT COUNT(*) AS n FROM expense_ledger_entries');

  const r = await remove(REC);
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'deactivated');
  assert.deepEqual(await balances(), before, 'vorher: die Zahlung ging per CASCADE mit, Clara stand wieder bei -10');
  assert.equal(count('SELECT COUNT(*) AS n FROM settlements WHERE id = ?', sid), 1, 'die Zahlung bleibt');
  assert.equal(count('SELECT COUNT(*) AS n FROM expense_ledger_entries'), ledgerBefore, 'keine Ledger-Zeile verschwindet');
  assert.equal(db.prepare('SELECT created_by FROM settlements WHERE id = ?').get(sid).created_by, REC.id, 'und nennt weiter, wer sie eintrug');
});

test('wer an einer Ausgabe BETEILIGT ist: 200 und deaktiviert statt 500 (RESTRICT)', async () => {
  const before = await balances();
  const r = await remove(OTH);
  assert.equal(r.status, 200, 'vorher: 500 Internal server error');
  assert.equal(r.body.outcome, 'deactivated');
  assert.ok(r.body.traces.some((t) => t.table === 'expense_splits' && t.column === 'user_id'));
  assert.deepEqual(await balances(), before, 'Ottos Schuld bleibt in den Salden');
  // Der Name bleibt am Saldo: die Zeile ist nicht verschwunden.
  const list = await OWN.call('GET', `/split-expenses/groups/${GROUP}/balances`);
  assert.ok(JSON.stringify(list.body).includes('Otto'));
});

test('ein deaktivierter Gast kommt nicht NEU in eine Gruppe, seine alte Mitgliedschaft bleibt speicherbar', async () => {
  const guest = await OWN.call('POST', `/split-expenses/groups/${GROUP}/guests`, {
    display_name: 'Gast Gabi', password: 'gast-gabi-pass-123',
  });
  assert.equal(guest.status, 201);
  const gid = guest.body.data.id;
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
    title: 'Taxi', amount: '10.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
    participants: [OWN.id, gid], expense_date: '2026-09-03',
  })).status, 201);
  const r = await admin('DELETE', `/auth/users/${gid}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'deactivated');

  const second = await OWN.call('POST', '/split-expenses/groups', { name: 'Urlaub', type: 'trip', default_currency: 'EUR' });
  assert.equal(second.status, 201);
  const add = await OWN.call('POST', `/split-expenses/groups/${second.body.data.id}/members`, { user_id: gid, role: 'guest' });
  assert.equal(add.status, 400, 'nicht neu in eine andere Gruppe');
  const keep = await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: gid, role: 'guest' });
  assert.equal(keep.status, 201, 'die bestehende Mitgliedschaft laesst sich weiter speichern');
  const search = await OWN.call('GET', '/split-expenses/search?q=Gabi');
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.data.people, [], 'die Suche bietet sie nicht mehr an');
});

// --------------------------------------------------------------------------
// Auswahl und gespeicherter Verweis
// --------------------------------------------------------------------------

test('fehlt in /family/members, ist als NEUER Zustaendiger 400, der gespeicherte Verweis bleibt', async () => {
  const u = await member('Ehemalige Emma');
  const created = await admin('POST', '/tasks', { title: 'Alte Aufgabe', assigned_to: [u.id] });
  assert.equal(created.status, 201);
  const taskId = created.body.data.id;
  assert.ok((await admin('GET', '/family/members')).body.data.some((m) => m.id === u.id), 'Vorbedingung: steht in der Auswahl');

  const r = await remove(u);
  assert.equal(r.body.outcome, 'deactivated', 'eine Zuweisung ist eine Spur');

  const members = await admin('GET', '/family/members');
  assert.ok(!members.body.data.some((m) => m.id === u.id), 'fehlt in der Auswahl');

  const fresh = await admin('POST', '/tasks', { title: 'Neue Aufgabe', assigned_to: [u.id] });
  assert.equal(fresh.status, 400, 'neu zuweisen geht nicht');
  assert.match(fresh.body.error, /not a household member/);

  const task = await admin('GET', `/tasks/${taskId}`);
  assert.equal(task.status, 200);
  assert.ok(JSON.stringify(task.body).includes('Ehemalige Emma'), 'die alte Aufgabe nennt sie weiter');
  const saved = await admin('PUT', `/tasks/${taskId}`, { title: 'Alte Aufgabe, umbenannt', assigned_to: [u.id] });
  assert.equal(saved.status, 200, 'der gespeicherte Verweis bleibt speicherbar');
  assert.equal(count('SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ? AND user_id = ?', taskId, u.id), 1);
});

test('GET /users nennt Ehemalige weiter, mit Zeitpunkt und am Ende', async () => {
  const u = await member('Aaron Ehemalig');
  await deactivate(u);
  const list = (await admin('GET', '/auth/users')).body.data;
  const entry = list.find((x) => x.id === u.id);
  assert.ok(entry, 'steht weiter in der Kontenliste');
  assert.match(entry.deactivated_at, /^\d{4}-/);
  assert.equal(entry.role, 'member');
  const firstFormer = list.findIndex((x) => x.deactivated_at);
  assert.ok(list.slice(firstFormer).every((x) => x.deactivated_at), 'Ehemalige stehen geschlossen am Ende, trotz "Aaron"');
  assert.equal(list.find((x) => x.id === ADMIN).deactivated_at, null);
});

// --------------------------------------------------------------------------
// Kein Weg mehr hinein
// --------------------------------------------------------------------------

test('Passwort: 403 mit Grund, keine Sitzung', async () => {
  const u = await member('Passwort');
  await deactivate(u);
  const res = await loginRaw(u.username, u.password);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'This account cannot sign in.', code: 403, reason: 'account_cannot_sign_in' });
  assert.equal(sessionsOf(u.id), 0);
});

test('bestehende Sitzung: endet mit dem Deaktivieren', async () => {
  const u = await member('Sitzung');
  assert.equal((await u.call('GET', '/auth/me')).status, 200);
  assert.ok(sessionsOf(u.id) > 0);
  await deactivate(u);
  assert.equal(sessionsOf(u.id), 0, 'die Sitzungszeilen sind weg');
  assert.equal((await u.call('GET', '/auth/me')).status, 401);
  assert.equal((await u.call('GET', '/tasks')).status, 401);
});

test('bestehende Sitzung, auch wenn ihre Zeile noch dasteht: 401', async () => {
  // Ein Request, der beim Deaktivieren noch lief und seine Sitzung veraendert
  // hat, schreibt sie per INSERT OR REPLACE zurueck. Nachgestellt, indem die
  // Zeile nach dem Deaktivieren wieder eingesetzt wird.
  const u = await member('Sitzung zwei');
  const kept = db.prepare('SELECT * FROM sessions').all()
    .filter((r) => JSON.parse(r.sess).userId === u.id);
  assert.equal(kept.length, 1);
  await deactivate(u);
  const columns = Object.keys(kept[0]);
  db.prepare(`INSERT INTO sessions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((c) => kept[0][c]));
  assert.equal(sessionsOf(u.id), 1, 'Vorbedingung: die Sitzung steht wieder da');
  assert.equal((await u.call('GET', '/auth/me')).status, 401);
  assert.equal((await u.call('GET', '/tasks')).status, 401);
  assert.equal((await u.call('POST', '/tasks', { title: 'von einem Ehemaligen' })).status, 401);
});

test('SSO per sub: abgewiesen, und es entsteht kein Ersatzkonto', async () => {
  const u = await member('SSO Sub');
  db.prepare('UPDATE users SET oidc_sub = ?, oidc_provider = ? WHERE id = ?').run('sub-former-1', process.env.OIDC_ISSUER, u.id);
  const ok = await ssoSignIn({ claims: { sub: 'sub-former-1' } });
  assert.equal(ok.meStatus, 200, 'Vorbedingung: vor dem Deaktivieren kommt das Konto per SSO herein');

  await deactivate(u);
  assert.equal(row(u.id).oidc_sub, 'sub-former-1', 'die Bindung bleibt, damit der Rueckweg das Konto FINDET');
  const users = count('SELECT COUNT(*) AS n FROM users');
  const res = await ssoSignIn({ claims: { sub: 'sub-former-1', name: 'SSO Sub' } });
  assert.equal(res.location, '/login?error=oidc_sign_in_blocked');
  assert.equal(res.meStatus, 401);
  assert.equal(sessionsOf(u.id), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM users'), users, 'kein zweites Konto fuer dieselbe Person');
});

test('SSO per verifizierter Adresse: abgewiesen, nicht verknuepft, kein Ersatzkonto', async () => {
  const u = await member('SSO Adresse', { email: 'former@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
  await deactivate(u);
  const users = count('SELECT COUNT(*) AS n FROM users');
  const res = await ssoSignIn({
    claims: { sub: 'sub-former-2', email_verified: true }, userinfo: { email: 'former@example.com' },
  });
  assert.equal(res.location, '/login?error=oidc_sign_in_blocked');
  assert.equal(res.meStatus, 401);
  assert.equal(row(u.id).oidc_sub, null, 'nicht verknuepft');
  assert.equal(count('SELECT COUNT(*) AS n FROM users'), users, 'kein Ersatzkonto');
});

test('API-Token als Subjekt: 401, widerrufen; ein Token, das er fuer ANDERE ausstellte, laeuft weiter', async () => {
  const u = await member('Token');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
  const uAdmin = as(await login(u.username, u.password));
  const other = await member('Token Nutzniesser');
  const own = await uAdmin('POST', '/auth/api-tokens', { name: 'eigenes' });
  const forOther = await uAdmin('POST', '/auth/api-tokens', { name: 'fuer other', subject_user_id: other.id });
  const fromAdmin = await admin('POST', '/auth/api-tokens', { name: 'vom admin fuer u', subject_user_id: u.id });
  for (const t of [own, forOther, fromAdmin]) assert.equal(t.status, 201);
  for (const t of [own, forOther, fromAdmin]) {
    assert.equal((await as({ token: t.body.token })('GET', '/tasks')).status, 200, 'Vorbedingung: alle drei gelten');
  }

  const r = await remove(u);
  assert.equal(r.body.outcome, 'deactivated', 'ein fuer andere ausgestelltes Token ist eine Spur');
  assert.equal((await as({ token: own.body.token })('GET', '/tasks')).status, 401);
  assert.equal((await as({ token: fromAdmin.body.token })('GET', '/tasks')).status, 401);
  assert.equal(count('SELECT COUNT(*) AS n FROM api_tokens WHERE subject_user_id = ? AND revoked_at IS NULL', u.id), 0, 'widerrufen, nicht geloescht');
  assert.equal(count('SELECT COUNT(*) AS n FROM api_tokens WHERE subject_user_id = ?', u.id), 2);
  assert.equal((await as({ token: forOther.body.token })('GET', '/tasks')).status, 200, 'handelt als das andere Konto und laeuft weiter');
});

test('API-Token, auch wenn seine Zeile nicht widerrufen ist: 401', async () => {
  // Eine Token-Zeile, die nach dem Deaktivieren noch gilt (aus einer Sicherung,
  // oder weil sie danach entstand). Die Anmeldung fragt das Subjekt selbst.
  const u = await member('Token zwei');
  const t = await admin('POST', '/auth/api-tokens', { name: 'bleibt', subject_user_id: u.id });
  assert.equal(t.status, 201);
  await deactivate(u);
  db.prepare('UPDATE api_tokens SET revoked_at = NULL WHERE subject_user_id = ?').run(u.id);
  assert.equal((await as({ token: t.body.token })('GET', '/tasks')).status, 401);
  assert.equal((await as({ token: t.body.token })('GET', '/auth/me')).status, 401);
});

test('kein neues API-Token fuer einen Ehemaligen, und er fehlt unter den Subjekten', async () => {
  const u = await member('Token drei');
  await deactivate(u);
  const t = await admin('POST', '/auth/api-tokens', { name: 'zu spaet', subject_user_id: u.id });
  assert.equal(t.status, 400);
  assert.equal(t.body.reason, 'account_deactivated');
  const list = await admin('GET', '/auth/api-tokens');
  assert.ok(!list.body.subjects.some((s) => s.id === u.id));
});

const FEEDS = [
  ['calendar', 'calendar_feed_token'],
  ['inventory-deadlines', 'inventory_deadlines_feed_token'],
  ['cycle', 'cycle_feed_token'],
  ['schedule', 'schedule_feed_token'],
  ['waste', 'waste_feed_token'],
];

for (const [path, column] of FEEDS) {
  test(`Abo-Adresse ${path}: 404, das Token ist geloescht - und auch ein wieder eingesetztes gilt nicht`, async () => {
    const u = await member(`Feed ${path}`);
    const token = `feedtoken-${path}-${'x'.repeat(30)}`;
    db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(token, u.id);
    const url = `${BASE}/feed/${path}/${token}.ics`;
    assert.equal((await fetch(url)).status, 200, 'Vorbedingung: die Adresse liefert');

    await deactivate(u);
    assert.equal(row(u.id)[column], null, 'das Token ist geloescht');
    assert.equal((await fetch(url)).status, 404);

    db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(token, u.id);
    assert.equal((await fetch(url)).status, 404, 'auch wenn das Token wieder dasteht');
  });
}

// Ein Wandtablett, an dem jemand fuer eine Person abhakt.
const createdDisplay = await admin('POST', '/displays', { display_name: 'Kueche' });
assert.equal(createdDisplay.status, 201);
const issued = await admin('POST', `/displays/${createdDisplay.body.data.id}/pairing-code`, {});
const paired = await fetch(`${BASE}/api/v1/displays/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: issued.body.data.code }),
});
const displayToken = decodeURIComponent(
  String(paired.headers.get('set-cookie') || '').match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`))[1],
);

/** Ein Request, wie ihn das Tablett stellt (Cookie-Glas wie in test-display-actions.js). */
function asDisplay(token) {
  const jar = new Map([[DISPLAY_COOKIE, token]]);
  let csrf = null;
  const send = async (method, path, body) => {
    const headers = { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) csrf = fresh;
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return async (method, path, body) => {
    if (!csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) await send('GET', '/preferences');
    return send(method, path, body);
  };
}
const display = asDisplay(displayToken);

test('Wandtablett: niemand hakt mehr als ein Ehemaliger ab, und die Personenauswahl nennt ihn nicht', async () => {
  const u = await member('Tablett Tom');
  const addTask = (title) => Number(db.prepare(`
    INSERT INTO tasks(title, status, visibility, created_by) VALUES (?, 'open', 'all', ?) RETURNING id
  `).get(title, ADMIN).id);
  const first = addTask('vorher');
  assert.equal((await display('PATCH', `/tasks/${first}/status`, { status: 'done', done_by_user_id: u.id })).status, 200,
    'Vorbedingung: vor dem Deaktivieren hakt das Tablett fuer ihn ab');
  assert.ok((await display('GET', '/displays/people')).body.data.some((p) => p.id === u.id));

  const r = await remove(u);
  assert.equal(r.body.outcome, 'deactivated', '"erledigt von" ist eine Spur');
  const second = addTask('nachher');
  const res = await display('PATCH', `/tasks/${second}/status`, { status: 'done', done_by_user_id: u.id });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not a household member/);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(second).status, 'open');
  assert.ok(!(await display('GET', '/displays/people')).body.data.some((p) => p.id === u.id));
  // Der gespeicherte Verweis bleibt: die erste Aufgabe weiss weiter, wer sie erledigt hat.
  assert.equal(count('SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND done_by_user_id = ?', first, u.id), 1);
});

// --------------------------------------------------------------------------
// Passwort-Reset
// --------------------------------------------------------------------------

// Die Reset-Routen mit einem Mailversand, der mitschreibt - auf DERSELBEN
// Datenbank wie der Server. Der echte Server haengt am echten Mailversand,
// und der ist in einer Suite nicht eingerichtet.
const mails = [];
const resetApp = express();
resetApp.use(express.json());
const resetRouter = express.Router();
buildResetRoutes(resetRouter, {
  database: db,
  emailService: { isConfigured: () => true, sendMail: async (mail) => { mails.push(mail); } },
  resetService: passwordResetService,
  baseUrl: 'https://yuvomi.example',
  limiter: (_req, _res, next) => next(),
});
resetApp.use(resetRouter);
const resetServer = resetApp.listen(0, '127.0.0.1');
await new Promise((resolve) => resetServer.on('listening', resolve));
test.after(() => resetServer.close());
const RESET = `http://127.0.0.1:${resetServer.address().port}`;

async function forgot(identifier) {
  const before = mails.length;
  const res = await fetch(`${RESET}/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier }),
  });
  assert.equal(res.status, 200);
  // Der Versand laeuft NACH der Antwort. Gewartet wird auf ein Kontrollkonto,
  // dessen Mail sicher kommt - erst dann ist "keine Mail" eine Aussage.
  return before;
}
async function settle(expected) {
  for (let i = 0; i < 100 && mails.length < expected; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}

test('Passwort-Reset: kein Link an einen Ehemaligen, und ein alter Link gilt nicht mehr', async () => {
  const u = await member('Reset', { email: 'reset-former@example.com' });
  const control = await member('Reset Kontrolle', { email: 'reset-control@example.com' });
  const { token: oldToken } = passwordResetService.createToken(u.id);
  const hashBefore = row(u.id).password_hash;

  await deactivate(u);
  assert.equal(count('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', u.id), 0, 'offene Reset-Tokens sind geloescht');
  assert.equal(memberEmail(u.id, { db }), null, 'an dieses Konto geht keine Mail mehr');
  assert.equal(memberEmail(control.id, { db }), 'reset-control@example.com');

  const before = await forgot(u.username);
  await forgot('reset-former@example.com');
  await forgot(control.username);
  await settle(before + 1);
  const sent = mails.slice(before).map((mail) => mail.to);
  assert.deepEqual(sent, ['reset-control@example.com'], 'nur das Kontrollkonto bekommt einen Link');

  const redeemOld = await fetch(`${RESET}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: oldToken, password: 'ein-neues-passwort-123' }),
  });
  assert.equal(redeemOld.status, 400);

  // Auch wenn nach dem Deaktivieren noch ein gueltiges Token entsteht.
  const { token: lateToken } = passwordResetService.createToken(u.id);
  const redeemLate = await fetch(`${RESET}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: lateToken, password: 'ein-neues-passwort-123' }),
  });
  assert.equal(redeemLate.status, 400);
  assert.deepEqual(await redeemLate.json(), { error: 'Invalid or expired token.', code: 400 });
  assert.equal(row(u.id).password_hash, hashBefore, 'das Passwort ist unveraendert');
});

// --------------------------------------------------------------------------
// Nichts wird mehr zugestellt
// --------------------------------------------------------------------------

function fakeWebpush() {
  const calls = [];
  return {
    calls,
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    setVapidDetails: () => {},
    sendNotification: async (subscription) => { calls.push(subscription.endpoint); },
  };
}

test('Push: Abos und eigene Kanaele sind weg, und auch ein wieder eingesetztes Abo bekommt nichts', async () => {
  const u = await member('Push');
  const control = await member('Push Kontrolle');
  for (const who of [u, control]) {
    const sub = await who.call('POST', '/push/subscribe', {
      endpoint: `https://push.example/${who.username}`, keys: { p256dh: 'k', auth: 'a' },
    });
    assert.equal(sub.status, 201);
  }
  db.prepare(`
    INSERT INTO notification_channels (provider, name, enabled, scope, user_id) VALUES ('ntfy', 'Mein Kanal', 1, 'user', ?)
  `).run(u.id);

  await deactivate(u);
  assert.equal(count('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', u.id), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM notification_channels WHERE user_id = ?', u.id), 0);

  // Auch wenn ein Abo danach noch dasteht: der eine Engpass fuer Web Push fragt selbst.
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/spaet', 'k', 'a')").run(u.id);
  const webpush = fakeWebpush();
  const push = createPushService({ db, webpush });
  assert.equal(await push.sendPushToUser(u.id, { title: 't' }), 0);
  assert.equal(await push.sendPushToUser(control.id, { title: 't' }), 1, 'Kontrolle: ein aktives Konto bekommt den Push');
  assert.deepEqual(webpush.calls, [`https://push.example/${control.username}`]);
});

test('Erinnerungen: offene sind geloescht, und eine neu entstandene geht weder an Push noch an einen Kanal', async () => {
  const u = await member('Erinnerung');
  const control = await member('Erinnerung Kontrolle');
  const task = Number(db.prepare(`
    INSERT INTO tasks(title, status, visibility, created_by) VALUES ('Muell', 'open', 'all', ?) RETURNING id
  `).get(ADMIN).id);
  const remind = db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('task', ?, ?, ?)");
  remind.run(task, '2020-01-01T08:00:00Z', u.id);
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, pushed_at) VALUES ('task', ?, '2019-01-01T08:00:00Z', ?, '2019-01-01T08:00:05Z')").run(task, u.id);

  await deactivate(u);
  assert.equal(count('SELECT COUNT(*) AS n FROM reminders WHERE created_by = ? AND pushed_at IS NULL', u.id), 0, 'offene sind geloescht');
  assert.equal(count('SELECT COUNT(*) AS n FROM reminders WHERE created_by = ?', u.id), 1, 'die zugestellte bleibt als Verlauf');

  // Auch wenn ein Abgleich danach eine Zeile neu anlegt - samt Abo und einem
  // Kanal des ganzen Haushalts, in den eine oeffentliche Zeile sonst duerfte.
  remind.run(task, '2020-01-02T08:00:00Z', u.id);
  remind.run(task, '2020-01-02T08:00:00Z', control.id);
  for (const who of [u, control]) {
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'a')").run(who.id, `https://push.example/r-${who.id}`);
  }
  db.prepare("INSERT INTO notification_channels (provider, name, enabled, scope) VALUES ('ntfy', 'Haushalt', 1, 'household')").run();
  const pushed = [];
  const channelled = [];
  await processDueNotifications({
    database: db,
    now: new Date('2020-01-03T00:00:00Z'),
    pushService: { sendPushToUser: async (userId) => { pushed.push(userId); return 1; } },
    providers: { ntfy: { send: async ({ payload }) => { channelled.push(payload); } } },
  });
  assert.deepEqual(pushed, [control.id], 'Push nur an das aktive Konto');
  assert.equal(channelled.length, 1, 'und der Haushaltskanal bekommt nur dessen Zeile');
  assert.equal(count('SELECT COUNT(*) AS n FROM reminders WHERE created_by = ? AND pushed_at IS NULL', u.id), 1, 'die Zeile des Ehemaligen bleibt unzugestellt');
});

test('Betreuung: ein Ehemaliger betreut niemanden mehr und laesst sich nicht neu eintragen', async () => {
  const u = await member('Betreuer');
  const kid = await member('Kind');
  assert.equal((await admin('PUT', `/health/caregivers/${kid.id}`, { caregiver_ids: [u.id] })).status, 200);
  await deactivate(u);
  assert.equal(count('SELECT COUNT(*) AS n FROM health_care_grants WHERE caregiver_id = ?', u.id), 0);
  const again = await admin('PUT', `/health/caregivers/${kid.id}`, { caregiver_ids: [u.id] });
  assert.equal(again.status, 400);
  assert.equal(again.body.reason, 'account_deactivated');
});

// --------------------------------------------------------------------------
// Der letzte Administrator
// --------------------------------------------------------------------------

test('das eigene Konto entfernt niemand - auch nicht mit Spuren', async () => {
  await admin('POST', '/quick-links', { name: 'Admin-Link', url: 'https://example.com/a' });
  const r = await admin('DELETE', `/auth/users/${ADMIN}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'own_account');
  assert.equal(row(ADMIN).deactivated_at, null);
});

test('ein deaktivierter Administrator ist keiner mehr, und er zaehlt nicht als verbleibender', async () => {
  const second = await member('Zweiter Admin');
  assert.equal((await admin('PATCH', `/auth/users/${second.id}`, { system_admin: true })).status, 200);
  assert.equal(row(second.id).role, 'admin');
  await deactivate(second);
  assert.equal(row(second.id).role, 'member', 'die Rolle faellt beim Deaktivieren');

  // Der einzige aktive Administrator kann sich nicht herabstufen - auch dann
  // nicht, wenn die Zeile eines Ehemaligen noch `admin` truege (Sicherung).
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(second.id);
  const demote = await admin('PATCH', `/auth/users/${ADMIN}`, { system_admin: false });
  assert.equal(demote.status, 400);
  assert.equal(demote.body.error, 'At least one system admin must remain.');
  db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(second.id);

  const promote = await admin('PATCH', `/auth/users/${second.id}`, { system_admin: true });
  assert.equal(promote.status, 400, 'ein Ehemaliger wird nicht Administrator');
  assert.equal(promote.body.reason, 'account_deactivated');
});

// --------------------------------------------------------------------------
// Eine Transaktion
// --------------------------------------------------------------------------

test('scheitert das Deaktivieren, bleibt ALLES, wie es war - auch die Sitzung', async () => {
  const u = await member('Atomar');
  await leaveTrace(u);
  const t = await admin('POST', '/auth/api-tokens', { name: 'atomar', subject_user_id: u.id });
  assert.equal(t.status, 201);
  // Ein Ausloeser, der das LETZTE Schreiben des Deaktivierens scheitern laesst.
  db.exec(`
    CREATE TEMP TRIGGER fail_removal BEFORE UPDATE OF default_assignee_user_id ON external_calendars
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
  `);
  db.prepare("INSERT INTO external_calendars (source, external_id, name, default_assignee_user_id) VALUES ('google', 'x-atomar', 'X', ?)").run(u.id);
  try {
    const r = await remove(u);
    assert.equal(r.status, 500);
  } finally {
    db.exec('DROP TRIGGER fail_removal');
  }
  assert.equal(row(u.id).deactivated_at, null, 'nicht deaktiviert');
  assert.equal(sessionsOf(u.id), 1, 'die Sitzung steht noch - sie endet nur ZUSAMMEN mit dem Konto');
  assert.equal((await u.call('GET', '/auth/me')).status, 200);
  assert.equal((await as({ token: t.body.token })('GET', '/tasks')).status, 200, 'das Token gilt noch');

  // Und ohne den Ausloeser geht dasselbe durch.
  assert.equal((await remove(u)).body.outcome, 'deactivated');
  assert.equal(sessionsOf(u.id), 0);
  assert.equal(db.prepare("SELECT default_assignee_user_id AS v FROM external_calendars WHERE external_id = 'x-atomar'").get().v, null);
});
