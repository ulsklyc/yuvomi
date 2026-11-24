/**
 * Modul: Changelog-Merker (Konto statt Geraet)
 * Zweck: Was ein Konto zuletzt gesehen hat, lag allein in localStorage - wer am
 *        Rechner gelesen hatte, bekam auf dem Tablet denselben Punkt und
 *        dieselbe "Neu in deiner App"-Liste noch einmal (#496). Migration 173
 *        traegt beide Merker am Konto. Vier Dinge muessen stimmen:
 *        (1) Migration: Bestandskonten bekommen NULL und NICHT die laufende
 *            Version. NULL heisst "noch nie hingesehen", und genau dann bleibt
 *            die Liste beim ersten Blick leer - sie zurueckzudatieren waere die
 *            Behauptung, sie haetten schon geschaut.
 *        (2) /auth/me traegt beide Merker heraus.
 *        (3) /auth/changelog-seen nimmt die INSTALLIERTE Version vom Server und
 *            die veroeffentlichte aus dem Body, und ein fehlender Body-Wert
 *            loescht den bisherigen nicht.
 *        (4) AUCH die Login-Antwort traegt sie. `loginPayload()` baut sein
 *            Nutzerobjekt von Hand, weil der Router nach dem Login kein /me
 *            mehr fragt - genau dort ist das Feld beim Bauen zuerst gefehlt.
 * Ausführen: npm run test:changelog-seen
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { AUTH_PREFIX, createAuthApp } from './auth-app.js';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const migration = dbmod.MIGRATIONS.find((m) => m.description.startsWith('Users: the changelog marks'));

const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);

// --------------------------------------------------------------------------
// Migration, isoliert - eine Bestands-DB ist hier nur die users-Tabelle vor
// diesen Spalten.
// --------------------------------------------------------------------------

test('Bestandskonten starten auf NULL, nicht auf der laufenden Version', () => {
  const conn = new DatabaseSync(':memory:');
  conn.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);');
  conn.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('alice');
  conn.exec(migration.up);

  const row = conn.prepare('SELECT changelog_seen_version, changelog_seen_latest FROM users WHERE id = 1').get();
  assert.equal(row.changelog_seen_version, null);
  assert.equal(row.changelog_seen_latest, null);
});

test('ein spaeter angelegtes Konto beginnt ebenfalls ohne Merker', () => {
  const conn = new DatabaseSync(':memory:');
  conn.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);');
  conn.exec(migration.up);
  conn.prepare('INSERT INTO users (id, username) VALUES (2, ?)').run('bob');

  const row = conn.prepare('SELECT changelog_seen_version FROM users WHERE id = 2').get();
  assert.equal(row.changelog_seen_version, null);
});

// --------------------------------------------------------------------------
// Routen, gegen den echten Router. Aufbau wie test-onboarding-version.js:
// requireAuth loest seine Session selbst auf, eine echte Sitzung ist also der
// einzige Weg hinein.
// --------------------------------------------------------------------------

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

function cookieHeader(res) {
  return res.headers.getSetCookie().map((raw) => raw.split(';')[0]).join('; ');
}

async function get(path, cookies = '') {
  const res = await fetch(`${base}${path}`, { headers: { Cookie: cookies } });
  const body = await res.json();
  return { status: res.status, body, cookies: cookieHeader(res) || cookies, csrfToken: body.csrfToken };
}

async function post(path, { cookies, csrfToken }, payload) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookies, 'X-CSRF-Token': csrfToken || '' },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

db.prepare(`
  INSERT INTO users (id, username, display_name, password_hash, role)
  VALUES (?, ?, ?, 'x', 'member')
`).run(201, 'reader', 'Reader');

const marks = (id) => db.prepare(
  'SELECT changelog_seen_version, changelog_seen_latest FROM users WHERE id = ?'
).get(id);

test('/auth/me traegt beide Merker heraus, anfangs leer', async () => {
  actor.userId = 201;
  const { status, body } = await get('/me');
  assert.equal(status, 200);
  assert.deepEqual(body.user.changelog_seen, { version: null, latest: null });
});

test('/auth/changelog-seen nimmt die installierte Version vom SERVER', async () => {
  actor.userId = 201;
  const session = await get('/me');
  // Der Client schickt sie bewusst nicht mit: welche Version laeuft, weiss der
  // Server - eine Behauptung aus dem Body koennte falsch sein.
  const res = await post('/changelog-seen', session, { version: '99.0.0', latest: 'v2.99.0' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.version, APP_VERSION);

  const row = marks(201);
  assert.equal(row.changelog_seen_version, APP_VERSION);
  assert.equal(row.changelog_seen_latest, 'v2.99.0');
});

test('ohne latest im Body bleibt der bisherige Wert stehen', async () => {
  actor.userId = 201;
  const session = await get('/me');
  const res = await post('/changelog-seen', session, {});
  assert.equal(res.status, 200);
  // Nicht ueberschrieben: ein fehlender Wert ist keine Aussage, und mit null zu
  // ueberschreiben hiesse, den Punkt beim naechsten Laden grundlos zurueckzuholen.
  assert.equal(marks(201).changelog_seen_latest, 'v2.99.0');
});

test('/auth/me meldet danach, was gespeichert wurde', async () => {
  actor.userId = 201;
  const { body } = await get('/me');
  assert.deepEqual(body.user.changelog_seen, { version: APP_VERSION, latest: 'v2.99.0' });
});

test('AUCH DIE LOGIN-ANTWORT traegt die Merker, nicht nur /auth/me', async () => {
  // GENAU HIER IST ES BEIM BAUEN SCHIEFGEGANGEN. `loginPayload()` baut sein
  // Nutzerobjekt von Hand statt ueber `publicUser()`, weil der Router nach dem
  // Login nicht noch einmal /me fragt. Ohne diese Zeile kam der Router mit
  // einem Konto ohne Merker in die Uebersicht, hielt den ersten Blick fuer den
  // allerersten und liess die "Neu bei dir"-Liste weg - im Browser sichtbar,
  // von allen Tests unbemerkt.
  const { hashPassword } = await import('../server/utils/password.js');
  const hash = await hashPassword('geheim12345');
  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role,
                       changelog_seen_version, changelog_seen_latest)
    VALUES (?, ?, ?, ?, 'member', ?, ?)
  `).run(202, 'login-reader', 'Login Reader', hash, '2.58.0', 'v2.60.0');

  actor.userId = 0;
  const session = await get('/me');
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookies,
      'X-CSRF-Token': session.csrfToken || '',
    },
    body: JSON.stringify({ username: 'login-reader', password: 'geheim12345' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.user.changelog_seen, { version: '2.58.0', latest: 'v2.60.0' });
});

test('eine unsinnig lange Version wird abgewiesen', async () => {
  actor.userId = 201;
  const session = await get('/me');
  const res = await post('/changelog-seen', session, { latest: 'v'.repeat(65) });
  assert.equal(res.status, 400);
  assert.equal(marks(201).changelog_seen_latest, 'v2.99.0', 'der gespeicherte Wert bleibt unberuehrt');
});

test('ohne Sitzung gibt es 401, nicht 200', async () => {
  actor.userId = 0;
  const res = await fetch(`${base}/changelog-seen`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 401);
});
