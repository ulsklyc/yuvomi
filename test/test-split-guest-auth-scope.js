/**
 * Regression: Ausgaben-Gast am Auth-Router (GHSA-q7gc-2cc9-w8fj)
 *
 * Ein Konto aus `split_expense_guest_users` ist die engste Art von Konto: ein
 * Aussenstehender, dem ein Gruppenverwalter Name und Passwort anlegt. Das
 * Gast-Gate in server/index.js beschraenkt ihn auf die geteilten Ausgaben -
 * aber der Auth-Router haengt VOR diesem Gate, und jede `/auth`-Anfrage wurde
 * darin beantwortet, bevor das Gate sie sah. Ein Gast las so ueber
 * `GET /auth/users` die Kontoliste des Haushalts mit Benutzernamen, E-Mail,
 * Telefon und Geburtsdatum.
 *
 * WAS DIE FAELLE HALTEN
 *   1. Der gemeldete Weg: `GET /auth/users` ist fuer einen Gast zu.
 *   2. JEDE Route des Auth-Routers, die nicht in der Allowlist steht, ist fuer
 *      einen Gast zu - aus dem Quelltext von server/auth.js aufgezaehlt, damit
 *      eine neue Route ohne Eintrag hier rot wird statt still offen.
 *   3. Was der Gast-Client braucht, bleibt offen: `/auth/me`, Abmelden, der
 *      Changelog-Merker, die geteilten Ausgaben. Andere Module bleiben zu.
 *   4. Jede Route ohne `requireAuth` steht in der Allowlist: wer im Browser
 *      noch als Gast angemeldet ist, kann sich als jemand anderes anmelden.
 *   5. Mitglieder merken nichts davon.
 *   6. Die Verankerung: die Liste ist `/api/v1`-relativ und exakt.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-split-guest-auth-scope.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'split-guest-auth-scope',
  env: { SESSION_SECRET: 'test-split-guest-auth-scope-secret-min32' },
});
const { SPLIT_GUEST_AUTH_ROUTES, splitGuestMayReach } = await import('../server/split-guest-scope.js');
const db = (await import('../server/db.js')).get();

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

await fetch(`${API}/auth/setup`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const admin = await login('admin', 'adminpass123');

const memberRes = await fetch(`${API}/auth/users`, {
  method: 'POST',
  headers: sessionHeaders(admin),
  body: JSON.stringify({ username: 'member1', display_name: 'Member One', password: 'member1pass1234' }),
});
assert.equal(memberRes.status, 201, 'Mitglied angelegt');
const member = await login('member1', 'member1pass1234');

// Der Gast entsteht auf dem Weg aus der Meldung: ein Mitglied, das eine
// Ausgabengruppe verwaltet, legt ihn an - kein Admin, kein Direkteintrag.
const groupRes = await fetch(`${API}/split-expenses/groups`, {
  method: 'POST', headers: sessionHeaders(member), body: JSON.stringify({ name: 'Reise', type: 'travel' }),
});
assert.equal(groupRes.status, 201, 'Gruppe angelegt');
const groupId = (await groupRes.json()).data.id;
const guestRes = await fetch(`${API}/split-expenses/groups/${groupId}/guests`, {
  method: 'POST',
  headers: sessionHeaders(member),
  body: JSON.stringify({ username: 'guest1', display_name: 'Gast', password: 'guestpass1234' }),
});
assert.equal(guestRes.status, 201, 'Gast angelegt');
const guest = await login('guest1', 'guestpass1234');

async function asGuest(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: sessionHeaders(guest),
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { status: res.status, body: payload };
}

/**
 * Alle Routen des Auth-Routers, aus dem Quelltext. `router.*` und die
 * `build*Routes(targetRouter)`-Bausteine haengen am selben Mount. Pfad-
 * parameter bekommen einen Beispielwert; das Gate entscheidet vor der Route.
 */
function authRoutes() {
  const source = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  const pattern = /\b(?:router|targetRouter)\.(get|post|put|patch|delete)\('([^']+)',([^\n]*)/g;
  const routes = [];
  for (const [, method, path, rest] of source.matchAll(pattern)) {
    routes.push({ method: method.toUpperCase(), path, needsAuth: /\brequireAuth\b/.test(rest) });
  }
  return routes;
}

const ROUTES = authRoutes();
const listed = (method, path) => SPLIT_GUEST_AUTH_ROUTES.some(([m, p]) => m === method && p === `/auth${path}`);

test('Voraussetzung: der Quelltext liefert die Routen des Auth-Routers', () => {
  assert.ok(ROUTES.length >= 40, `nur ${ROUTES.length} Routen gefunden - das Muster greift nicht mehr`);
  assert.ok(ROUTES.some((r) => r.method === 'GET' && r.path === '/users'));
  assert.ok(ROUTES.some((r) => r.method === 'POST' && r.path === '/invites/accept'));
});

test('ein Ausgaben-Gast bekommt die Kontoliste nicht', async () => {
  const res = await asGuest('GET', '/auth/users');
  assert.equal(res.status, 403);
  assert.equal(res.body?.reason, 'split_guest_scope');
  assert.equal(res.body?.data, undefined, 'keine Zeilen in der Absage');
});

test('jede Konto-Route ausserhalb der Allowlist ist fuer einen Gast zu', async () => {
  const open = [];
  for (const { method, path } of ROUTES) {
    if (listed(method, path)) continue;
    const concrete = path.replace(/:[A-Za-z_]+/g, '1');
    const res = await asGuest(method, `/auth${concrete}`, method === 'GET' ? undefined : {});
    if (res.status !== 403 || res.body?.reason !== 'split_guest_scope') {
      open.push(`${method} /auth${path} -> ${res.status} ${res.body?.reason ?? ''}`.trim());
    }
  }
  assert.deepEqual(open, [], 'diese Routen erreicht ein Gast noch');
});

test('was der Gast-Client braucht, bleibt offen', async () => {
  const me = await asGuest('GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'guest1');
  assert.equal(me.body.user.access_scope, 'split_guest');

  const seen = await asGuest('POST', '/auth/changelog-seen', {});
  assert.notEqual(seen.body?.reason, 'split_guest_scope', `changelog-seen: ${seen.status}`);
  assert.ok(seen.status < 400, `changelog-seen: ${seen.status}`);

  const groups = await asGuest('GET', '/split-expenses/groups');
  assert.equal(groups.status, 200);

  const tasks = await asGuest('GET', '/tasks');
  assert.equal(tasks.status, 403);
  assert.equal(tasks.body?.reason, 'split_guest_scope');
});

test('jede Route ohne Anmeldung steht in der Allowlist', () => {
  const missing = ROUTES
    .filter((r) => !r.needsAuth && !listed(r.method, r.path))
    .map((r) => `${r.method} /auth${r.path}`);
  assert.deepEqual(missing, [], 'oeffentliche Routen, die eine Gast-Sitzung im Browser versperrt');
});

test('mit einer Gast-Sitzung im Browser meldet sich ein Mitglied an', async () => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { ...json, Cookie: guest.cookie },
    body: JSON.stringify({ username: 'member1', password: 'member1pass1234' }),
  });
  assert.equal(res.status, 200);
});

test('Mitglieder merken nichts davon', async () => {
  const res = await fetch(`${API}/auth/users`, { headers: sessionHeaders(member) });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.ok(data.some((u) => u.username === 'admin'));
});

test('Verankerung: `/api/v1`-relativ, exakt, mit Methode', () => {
  assert.equal(splitGuestMayReach('GET', '/auth/me'), true);
  assert.equal(splitGuestMayReach('get', '/auth/me'), true);
  assert.equal(splitGuestMayReach('GET', '/me'), false, 'mount-relativer Pfad trifft nichts');
  assert.equal(splitGuestMayReach('PATCH', '/auth/me'), false);
  assert.equal(splitGuestMayReach('GET', '/auth/users'), false);
  assert.equal(splitGuestMayReach('GET', '/auth/Users'), false);
  assert.equal(splitGuestMayReach('GET', '/auth/me/'), false);
  assert.equal(splitGuestMayReach('DELETE', '/split-expenses/groups/1'), true);
  assert.equal(splitGuestMayReach('GET', '/split-expenses'), true);
  assert.equal(splitGuestMayReach('GET', '/split-expensesx'), false);
  assert.equal(splitGuestMayReach('GET', '/version'), false, 'liegt vor dem Gate, kein Eintrag');
});

/**
 * Ein Token-Zeile direkt in der Datenbank. `createdBy` ist der Aussteller,
 * `subject` das Konto, als das es handelt.
 */
function insertToken(createdBy, subject = null) {
  const token = `yuvomi_guestscope_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id)
    VALUES ('Gegenprobe', ?, 'yuvomi_gs', ?, ?)
  `).run(crypto.createHash('sha256').update(token).digest('hex'), createdBy, subject);
  return token;
}

test('ein mitgeschicktes Token versteckt die Gast-Sitzung nicht', async () => {
  // Das Tor muss die Anfrage so sehen wie `requireAuth`. Ein Token, das das
  // Tor fuer gueltig hielte, `requireAuth` aber nicht (hier: der Aussteller
  // ist ehemalig), liesse das Tor ein Mitglied sehen und `requireAuth` danach
  // auf die Gast-Sitzung zurueckfallen - die Kontoliste ginge an den Gast.
  const fresh = await login('guest1', 'guestpass1234');
  const formerRes = await fetch(`${API}/auth/users`, {
    method: 'POST',
    headers: sessionHeaders(admin),
    body: JSON.stringify({ username: 'former1', display_name: 'Former', password: 'former1pass1234' }),
  });
  assert.equal(formerRes.status, 201);
  const formerId = (await formerRes.json()).data?.id ?? db.prepare("SELECT id FROM users WHERE username = 'former1'").get().id;
  const memberId = db.prepare("SELECT id FROM users WHERE username = 'member1'").get().id;
  const deadCreator = insertToken(formerId, memberId);
  db.prepare("UPDATE users SET deactivated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(formerId);
  const unusable = insertToken(memberId);
  db.prepare("UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE token_hash = ?")
    .run(crypto.createHash('sha256').update(unusable).digest('hex'));

  for (const [label, token] of [['Aussteller ehemalig', deadCreator], ['widerrufen', unusable], ['Unsinn', 'yuvomi_nonsense']]) {
    const res = await fetch(`${API}/auth/users`, {
      headers: { Cookie: fresh.cookie, Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => null);
    assert.equal(res.status, 403, `${label}: ${res.status}`);
    assert.equal(body?.data, undefined, `${label}: keine Zeilen`);
  }

  // Gegenrichtung: ein gueltiges Mitglieds-Token neben der Gast-Sitzung.
  // `requireAuth` nimmt das Token; das Tor sperrt trotzdem, weil die Sitzung
  // im selben Request einem Gast gehoert - die engere Antwort.
  const valid = insertToken(memberId);
  const res = await fetch(`${API}/auth/users`, {
    headers: { Cookie: fresh.cookie, Authorization: `Bearer ${valid}` },
  });
  assert.equal(res.status, 403, 'gueltiges Token neben Gast-Sitzung');
});

test('Logout bleibt offen und beendet die Sitzung', async () => {
  // Eine eigene Sitzung: die Anmeldung oben ueber dem Gast-Cookie hat dessen
  // Sitzung bereits ersetzt.
  const fresh = await login('guest1', 'guestpass1234');
  const res = await fetch(`${API}/auth/logout`, { method: 'POST', headers: sessionHeaders(fresh), body: '{}' });
  assert.equal(res.status, 200);
  const after = await fetch(`${API}/auth/me`, { headers: { Cookie: fresh.cookie } });
  assert.equal(after.status, 401);
});
