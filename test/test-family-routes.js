/**
 * Test: Family-Routen-Schicht (Härtung)
 * Zweck: End-to-End über den echten Router (server/routes/family.js) - zuvor nur
 *        ~24% Zeilen / 1 von 2 fn abgedeckt (nur die Registrierung, nie der Handler).
 *        Eine einzige Read-only-Route GET /members, aber mit substanzieller SQL:
 *          - LEFT JOIN auf contacts (phone/email) + birthdays (birth_date)
 *          - Ausschluss von Housekeeping-Workern (NOT EXISTS)
 *          - Sortierung display_name COLLATE NOCASE ASC
 *          - Response-Shape { data: Member[] } inkl. family_role/avatar_color
 * Ausführen: node --experimental-sqlite --test test/test-family-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: familyRouter } = await import('../server/routes/family.js');
const db = dbmod.get();

const app = express();
app.use('/', familyRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function get(route) {
  const res = await fetch(`${baseUrl}${route}`);
  const body = await res.json();
  return { status: res.status, body };
}

// ── Fixtures: gemischte Groß-/Kleinschreibung für die NOCASE-Sortierung ───────────
function addUser(name, role, color) {
  return db.prepare(
    "INSERT INTO users (username, display_name, password_hash, family_role, avatar_color) VALUES (?, ?, 'x', ?, ?)"
  ).run(name.toLowerCase().replace(/\s+/g, '_'), name, role, color).lastInsertRowid;
}
const bob   = addUser('Bob',   'parent', '#111111');
const alice = addUser('alice', 'child',  '#222222');
const zoe   = addUser('Zoe',   'child',  '#333333');
const willy = addUser('Willy Worker', 'parent', '#444444');

// alice hat einen verknüpften Kontakt (phone/email), Bob einen Geburtstag.
db.prepare("INSERT INTO contacts (name, category, phone, email, family_user_id) VALUES ('Alice K','Familie','+49 170 000','alice@test.de', ?)").run(alice);
db.prepare("INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES ('Bob', '1980-05-05', ?, ?)").run(bob, bob);
// willy ist Housekeeping-Worker → muss aus /members verschwinden.
db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(willy);

const names = (data) => data.map((m) => m.display_name);

test('GET /members — liefert Familienmitglieder ohne Housekeeping-Worker', async () => {
  const res = await get('/members');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.data.length, 3, 'drei Mitglieder, Worker ausgeschlossen');
  assert.ok(!names(res.body.data).includes('Willy Worker'), 'Housekeeping-Worker nicht enthalten');
});

test('GET /members — NOCASE-Sortierung nach display_name', async () => {
  const res = await get('/members');
  assert.deepEqual(names(res.body.data), ['alice', 'Bob', 'Zoe'], 'case-insensitiv aufsteigend');
});

test('GET /members — LEFT JOIN liefert Kontakt- und Geburtstagsdaten', async () => {
  const res = await get('/members');
  const byName = Object.fromEntries(res.body.data.map((m) => [m.display_name, m]));

  assert.equal(byName['alice'].phone, '+49 170 000');
  assert.equal(byName['alice'].email, 'alice@test.de');
  assert.equal(byName['alice'].birth_date, null, 'alice hat keinen Geburtstag');

  assert.equal(byName['Bob'].birth_date, '1980-05-05');
  assert.equal(byName['Bob'].phone, null, 'Bob hat keinen Kontakt');

  // Zoe: weder Kontakt noch Geburtstag -> alle LEFT-JOIN-Felder null.
  assert.equal(byName['Zoe'].phone, null);
  assert.equal(byName['Zoe'].email, null);
  assert.equal(byName['Zoe'].birth_date, null);
});

test('GET /members — Shape enthält family_role, avatar_color, id', async () => {
  const res = await get('/members');
  const bobRow = res.body.data.find((m) => m.display_name === 'Bob');
  assert.equal(bobRow.id, bob);
  assert.equal(bobRow.family_role, 'parent');
  assert.equal(bobRow.avatar_color, '#111111');
  assert.ok('created_at' in bobRow, 'created_at im Ergebnis');
});

// --------------------------------------------------------------------------
// Geburtstag ohne Jahr am Mitglied (#2095, Codex-Befund auf #2111). Ein
// Kontakt ohne Jahr, der zum Split-Gast wird, hinterlaesst eine birthdays-Zeile
// mit family_user_id, Platzhalterjahr 2000 und year_unknown = 1. Profil- und
// Mitgliedsleser muessen die Marke liefern, und das Profil darf sie beim
// Aendern von Tag oder Monat nicht still abnehmen.
// --------------------------------------------------------------------------
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const authActor = { userId: 0 };
const authApp = express();
authApp.use(express.json());
authApp.use(sessionMiddleware);
authApp.use((req, _res, next) => {
  if (authActor.userId) { req.session.userId = authActor.userId; req.session.role = 'member'; }
  next();
});
authApp.use('/', authRouter);
const authServer = authApp.listen(0, '127.0.0.1');
const authBase = await new Promise((r) => authServer.on('listening', () => r(`http://127.0.0.1:${authServer.address().port}`)));
test.after(() => authServer.close());

async function signIn(userId) {
  authActor.userId = userId;
  const res = await fetch(`${authBase}/me`);
  authActor.userId = 0;
  const body = await res.json();
  return { cookies: res.headers.getSetCookie().map((raw) => raw.split(';')[0]).join('; '), csrfToken: body.csrfToken, me: body };
}
async function authCall(method, path, session, payload) {
  const res = await fetch(`${authBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: session.cookies, 'X-CSRF-Token': session.csrfToken || '' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// Angelegt erst im ersten Test: die Zaehl- und Sortiertests oben laufen
// vorher und rechnen mit drei Mitgliedern.
let yearlessGuest = null;
function addYearlessGuest() {
  yearlessGuest = addUser('Gast Ohne Jahr', 'other', '#555555');
  db.prepare(`INSERT INTO birthdays (name, birth_date, year_unknown, created_by, family_user_id)
    VALUES ('Gast Ohne Jahr', '2000-03-15', 1, ?, ?)`).run(yearlessGuest, yearlessGuest);
}
const storedBirthday = () => db.prepare('SELECT birth_date, year_unknown FROM birthdays WHERE family_user_id = ?').get(yearlessGuest);

test('GET /members und /me liefern die Marke "Jahr unbekannt"', async () => {
  addYearlessGuest();
  const members = (await get('/members')).body.data;
  const guest = members.find((m) => m.display_name === 'Gast Ohne Jahr');
  assert.equal(guest.birth_date, '2000-03-15');
  // Boolean wie im Schema und wie `publicUser` (Codex-Befund auf #2111).
  assert.equal(guest.birth_year_unknown, true);
  assert.equal(members.find((m) => m.display_name === 'Bob').birth_year_unknown, false);

  const session = await signIn(yearlessGuest);
  assert.equal(session.me.user.birth_year_unknown, true);
});

test('Profil: Tag und Monat aendern laesst die Marke stehen, ein Jahr nimmt sie ab', async () => {
  const session = await signIn(yearlessGuest);
  const moved = await authCall('PATCH', '/me/profile', session, { birth_date: '2000-04-20', birth_year_unknown: true });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual({ ...storedBirthday() }, { birth_date: '2000-04-20', year_unknown: 1 }, 'kein stilles Jahr 2000');
  assert.equal(moved.body.user.birth_year_unknown, true);

  // Ein Client ohne das Feld schickt das Platzhalterdatum zurueck: bleibt jahrlos.
  await authCall('PATCH', '/me/profile', session, { birth_date: '2000-04-20' });
  assert.equal(storedBirthday().year_unknown, 1);

  // Ausdruecklich `false` bei gleichem Datum: wirklich im Jahr 2000 geboren
  // (Codex-Befund auf #2111) - die Marke geht, das Datum bleibt.
  await authCall('PATCH', '/me/profile', session, { birth_date: '2000-04-20', birth_year_unknown: false });
  assert.deepEqual({ ...storedBirthday() }, { birth_date: '2000-04-20', year_unknown: 0 });

  const withYear = await authCall('PATCH', '/me/profile', session, { birth_date: '1984-04-20', birth_year_unknown: false });
  assert.equal(withYear.status, 200);
  assert.deepEqual({ ...storedBirthday() }, { birth_date: '1984-04-20', year_unknown: 0 });

  // Und wieder ohne Jahr: das Jahr weicht dem Platzhalter.
  const yearless = await authCall('PATCH', '/me/profile', session, { birth_date: '1984-04-20', birth_year_unknown: true });
  assert.equal(yearless.status, 200);
  assert.deepEqual({ ...storedBirthday() }, { birth_date: '2000-04-20', year_unknown: 1 });
});
