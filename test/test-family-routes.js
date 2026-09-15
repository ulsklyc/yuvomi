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
