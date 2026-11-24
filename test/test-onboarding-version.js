/**
 * Modul: Onboarding-Version (Konto statt Geraet)
 * Zweck: der Einfuehrungs-Rundgang lag bisher allein in localStorage - ein
 *        neues Geraet oder ein privates Fenster zeigte ihn erneut, obwohl das
 *        Konto ihn laengst gesehen hat. `users.onboarding_version` traegt den
 *        Merker jetzt am Konto; zwei Faelle muessen stimmen:
 *        (1) Migration: Bestandskonten werden auf die aktuelle Version
 *            zurueckdatiert (sie haben die Einfuehrung schon gesehen), ein
 *            kuenftiges INSERT startet bei 0 (noch nicht gesehen).
 *        (2) Route: /auth/me und /auth/login melden onboarding_pending nach
 *            derselben Regel, und /auth/onboarding-seen hebt die Version an.
 * Ausführen: node --test test/test-onboarding-version.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AUTH_PREFIX, createAuthApp } from './auth-app.js';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const migration = dbmod.MIGRATIONS.find((m) => m.description.startsWith('Users: onboarding'));

// --------------------------------------------------------------------------
// Migration, isoliert (wie test-inventory-default-off-migration.js): eine
// Bestands-DB nachbauen heisst hier nur die users-Tabelle vor dieser Spalte.
// --------------------------------------------------------------------------

function usersTableBefore(rows) {
  const conn = new DatabaseSync(':memory:');
  conn.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);');
  for (const row of rows) {
    conn.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(row.id, row.username);
  }
  return conn;
}

test('Bestandskonten werden beim Upgrade auf die aktuelle Version zurueckdatiert', () => {
  const conn = usersTableBefore([{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }]);
  conn.exec(migration.up);
  // node:sqlite liefert Zeilen mit Object.create(null) - deepEqual haelt das
  // fuer verschieden von einem Literal, auch bei gleichen Feldern. `{ ...row }`
  // normalisiert auf ein gewoehnliches Objekt vor dem Vergleich.
  const rows = conn.prepare('SELECT id, onboarding_version FROM users ORDER BY id').all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ id: 1, onboarding_version: 1 }, { id: 2, onboarding_version: 1 }]);
});

test('die Spalten-DEFAULT bleibt 0, ein kuenftiges Konto startet ungesehen', () => {
  const conn = usersTableBefore([]);
  conn.exec(migration.up);
  conn.prepare('INSERT INTO users (id, username) VALUES (3, ?)').run('new-member');
  const row = conn.prepare('SELECT onboarding_version FROM users WHERE id = 3').get();
  assert.equal(row.onboarding_version, 0);
});

// --------------------------------------------------------------------------
// Routen, gegen den echten Router.
// --------------------------------------------------------------------------

// requireAuth (in auth.js) resolves its own req.session/req.authUserId - it
// does not read whatever an earlier test middleware sets, unlike preferences.js
// (test-preferences-routes.js). A real session is therefore the only way in:
// sessionMiddleware, a per-request "log in as" hook, and real cookie handling
// so csrfMiddleware's session-bound token round-trips like a real browser.
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');

const actor = { userId: 0 };
const app = await createAuthApp({
  session: sessionMiddleware,
  auth: (req, _res, next) => {
    if (actor.userId) { req.session.userId = actor.userId; req.session.role = 'member'; }
    next();
  },
  routers: [authRouter],
});
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}${AUTH_PREFIX}`;

test.after(() => server.close());

// Ein frischer Cookie-Jar pro Aufrufpaar statt ein geteilter ueber die ganze
// Datei: jeder Test loggt sich per `actor.userId` neu ein, und GET vor POST
// holt sich sein eigenes CSRF-Token - genau der Weg, den ein Browser auch
// ginge (GET setzt das Token, POST spiegelt es im Header).
function cookieHeader(res) {
  return res.headers.getSetCookie().map((raw) => raw.split(';')[0]).join('; ');
}

async function get(path, cookies = '') {
  const res = await fetch(`${base}${path}`, { headers: { Cookie: cookies } });
  const body = await res.json();
  // /me issues the CSRF token in the response BODY, not a header - it predates
  // csrfMiddleware and isn't routed through it (GET needs no CSRF protection
  // for itself, only to hand out the token for what comes after). The real
  // client (public/api.js) reads it the same way.
  return { status: res.status, body, cookies: cookieHeader(res) || cookies, csrfToken: body.csrfToken };
}
async function post(path, { cookies, csrfToken }) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookies, 'X-CSRF-Token': csrfToken || '' },
  });
  return { status: res.status, body: await res.json() };
}

const insertUser = db.prepare(`
  INSERT INTO users (id, username, display_name, password_hash, role, onboarding_version)
  VALUES (?, ?, ?, 'x', 'member', ?)
`);
insertUser.run(101, 'fresh-member', 'Fresh Member', 0);
insertUser.run(102, 'onboarded-member', 'Onboarded Member', 1);

test('/auth/me: ein frisches Konto (Version 0) muss den Rundgang noch sehen', async () => {
  actor.userId = 101;
  const { status, body } = await get('/me');
  assert.equal(status, 200);
  assert.equal(body.user.onboarding_pending, true);
});

test('/auth/me: ein Konto auf der aktuellen Version sieht ihn nicht erneut', async () => {
  actor.userId = 102;
  const { status, body } = await get('/me');
  assert.equal(status, 200);
  assert.equal(body.user.onboarding_pending, false);
});

test('/auth/onboarding-seen hebt die Version des aufrufenden Kontos an', async () => {
  actor.userId = 101;
  const before = await get('/me');
  assert.equal(before.body.user.onboarding_pending, true);

  // Dieselbe Session (Cookie) traegt das CSRF-Token von GET zu POST - genau
  // der Weg, den ein Browser auch ginge.
  const marked = await post('/onboarding-seen', before);
  assert.equal(marked.status, 200);
  assert.equal(marked.body.ok, true);

  const after = await get('/me', before.cookies);
  assert.equal(after.body.user.onboarding_pending, false);
});

test('/auth/onboarding-seen wirkt nur auf das aufrufende Konto, nicht auf andere', async () => {
  insertUser.run(103, 'bystander', 'Bystander', 0);
  actor.userId = 101; // schon auf der aktuellen Version aus dem Test zuvor
  const login101 = await get('/me');
  await post('/onboarding-seen', login101);

  actor.userId = 103;
  const { body } = await get('/me');
  assert.equal(body.user.onboarding_pending, true, 'ein fremdes Konto bleibt von einem Aufruf fuer ein anderes unberuehrt');
});
