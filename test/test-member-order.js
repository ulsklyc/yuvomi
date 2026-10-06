/**
 * Test: Die eine Haushaltsreihenfolge der Mitglieder (#1644)
 * Zweck: Ein Haushalt ordnet seine Mitglieder einmal, und jede Personenliste
 *        folgt dem. Gemessen wird ueber den ECHTEN Server (test/server-ready.js)
 *        und die echten Routen:
 *
 *        1. Migration 232 auf einer Bestandsdatenbank (Stand v231, mit
 *           Mitgliedern, Personal, Gast und Wandtablett): laeuft durch und
 *           laesst jede Position NULL - kein Backfill.
 *        2. Ein Haushalt ohne Positionen sieht die Reihenfolge von vorher. Die
 *           Erwartung ist die AUFGEZEICHNETE Antwort des Stands vor #1644
 *           (origin/main 7e3dbe36d, 06.10.2026, dieselbe Saat), je Route.
 *        3. `PATCH /family/members/reorder`: die Reihenfolge gilt danach in
 *           jeder Liste, fuer zwei verschiedene Nutzer gleich, und ein frischer
 *           Prozess auf derselben Datei liest sie ebenso (Neustart).
 *        4. Unplatzierte stehen nach den Platzierten, nach Name (NOCASE).
 *        5. Absagen: Nicht-Admin 403; Personal, Gast, Wandtablett, Ehemalige,
 *           unbekannte id, Dublette, fehlendes Mitglied, kaputte Liste 400 -
 *           jeweils mit `reason`, und ohne dass etwas geschrieben wurde.
 *        6. Die Position gilt nur fuer ein Mitglied: wer nach dem Ordnen
 *           deaktiviert wird oder Personal wird, hat keine mehr.
 *        7. Server-Leser (`memberOrderSql`) und Browser-Vergleich
 *           (`compareMembers`) liefern dieselbe Reihenfolge - gegen
 *           ausgeschriebene Erwartungswerte, nicht gegeneinander allein.
 * Ausfuehren: npm run test:member-order
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3-multiple-ciphers';

import { startTestServer, cookieHeader } from './server-ready.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { baseUrl: BASE, dbPath: DB_PATH } = await startTestServer({
  name: 'member-order',
  env: { SESSION_SECRET: 'test-member-order-secret-32-characters', RATE_LIMIT_MAX_ATTEMPTS: '500' },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();
const members = await import('../server/services/household-members.js');
const { compareMembers, compareNamesNoCase, sortMembers, memberRanks, memberRankOf } = await import('../public/utils/member-order.js');

// --------------------------------------------------------------------------
// Werkzeug
// --------------------------------------------------------------------------

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  return { cookie: cookieHeader(res.headers.get('set-cookie')), csrfToken: (await res.json()).csrfToken };
}

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, route, body) => {
    const res = await fetch(`${BASE}/api/v1${route}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* leer */ }
    return { status: res.status, body: json };
  };
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Mara', password: 'adminpass123' }),
});
const admin = as(await login('admin', 'adminpass123'));

const ID = { Mara: db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id };
const CALL = { Mara: admin };

/** Ein Konto ueber die echte Route; `login: true` gibt ihm eine eigene Sitzung. */
async function account(displayName, { withLogin = false } = {}) {
  const username = `user${Object.keys(ID).length}`;
  const password = `${username}-pass-123`;
  const r = await admin('POST', '/auth/users', { username, display_name: displayName, password });
  assert.equal(r.status, 201, `create ${displayName}: ${JSON.stringify(r.body)}`);
  ID[displayName] = r.body.user.id;
  if (withLogin) CALL[displayName] = as(await login(username, password));
  return r.body.user;
}

// Ein gewoehnlicher Haushalt: vier Mitglieder, in einer Anlegefolge, die weder
// das Alphabet noch die spaetere Wunschfolge ist. Daneben jede Art Konto, die
// KEIN Mitglied ist.
await account('Zoe', { withLogin: true });
await account('Ömer');
await account('Anna');
await account('Ben');
await account('Carla Putzhilfe');
await account('Gustav Gast');
await account('Dora');
db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(ID['Carla Putzhilfe']);
db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(ID['Gustav Gast']);
// Ein Wandtablett: eine users-Zeile mit einem Eintrag in display_accounts.
ID.Wandtablett = Number(db.prepare(`
  INSERT INTO users (username, display_name, password_hash) VALUES ('display-1', 'Wandtablett', 'x') RETURNING id
`).get().id);
db.prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(ID.Wandtablett, ID.Mara);
// Dora wird ein ehemaliges Konto - ueber die Route, mit einer Spur in geteilten Daten.
db.prepare("INSERT INTO tasks (title, status, visibility, created_by) VALUES ('Spur', 'open', 'all', ?)").run(ID.Dora);
{
  const r = await admin('DELETE', `/auth/users/${ID.Dora}`);
  assert.equal(r.body?.outcome, 'deactivated', 'Fixture: Dora ist deaktiviert, nicht geloescht');
}

const NAME = () => new Map(Object.entries(ID).map(([name, id]) => [id, name]));
const names = (rows, key = 'id') => rows.map((row) => NAME().get(row[key]) ?? `?${row[key]}`);

/** Jede Personenliste, die aus einer Server-Mitgliederliste liest - als Namen in Antwortfolge. */
const LISTS = {
  'GET /family/members': async (call) => names((await call('GET', '/family/members')).body.data),
  'GET /auth/users': async (call) => names((await call('GET', '/auth/users')).body.data),
  'GET /tasks/meta/options (users)': async (call) => names((await call('GET', '/tasks/meta/options')).body.users),
  'GET /dashboard (users)': async (call) => names((await call('GET', '/dashboard')).body.users),
  'GET /schedule/household-members': async (call) => names((await call('GET', '/schedule/household-members')).body.data),
};
/** Dieselbe Frage an die Listen, die nur ein Administrator bekommt. */
const ADMIN_LISTS = {
  'GET /rewards/participants': async (call) => names((await call('GET', '/rewards/participants')).body.data),
  'GET /permissions/catalog (members)': async (call) => names((await call('GET', '/permissions/catalog')).body.data.members),
  'GET /auth/2fa/overview': async (call) => names((await call('GET', '/auth/2fa/overview')).body.data, 'user_id'),
  'GET /auth/api-tokens (subjects)': async (call) => names((await call('GET', '/auth/api-tokens')).body.subjects),
};

async function readLists(call, lists) {
  const out = {};
  for (const [name, read] of Object.entries(lists)) out[name] = await read(call);
  return out;
}

const HOUSEHOLD = ['Anna', 'Ben', 'Mara', 'Zoe', 'Ömer'];
const onlyMembers = (list, set = HOUSEHOLD) => list.filter((name) => set.includes(name));
const rawPositions = () => Object.fromEntries(
  db.prepare('SELECT id, sort_order FROM users ORDER BY id').all().map((row) => [NAME().get(row.id), row.sort_order]),
);
const reorder = (call, order) => call('PATCH', '/family/members/reorder', { order });
const ids = (...people) => people.map((name) => ID[name]);

// --------------------------------------------------------------------------
// 1. Migration auf einer Bestandsdatenbank
// --------------------------------------------------------------------------

test('migration 232 on an existing database (v231): runs, adds the column, leaves every position NULL', () => {
  const old = new Database(':memory:');
  try {
    dbmod.migrate(old, dbmod.MIGRATIONS.filter((m) => m.version <= 231));
    assert.equal(old.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 231, 'Vorbedingung: Stand v231');
    assert.ok(!old.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'sort_order'), 'Vorbedingung: v231 kennt die Spalte nicht');

    const add = old.prepare("INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, 'x') RETURNING id");
    const people = ['Zoe', 'Anna', 'Ben', 'Putzhilfe', 'Gast', 'Tablett', 'Ehemalig'].map((name) => [name, Number(add.get(name.toLowerCase(), name).id)]);
    const idOf = Object.fromEntries(people);
    old.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(idOf.Putzhilfe);
    old.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(idOf.Gast);
    old.prepare('INSERT INTO display_accounts (user_id) VALUES (?)').run(idOf.Tablett);
    old.prepare("UPDATE users SET deactivated_at = '2026-10-01T10:00:00Z' WHERE id = ?").run(idOf.Ehemalig);
    const before = old.prepare('SELECT id, username, display_name, deactivated_at FROM users ORDER BY id').all();

    // Nur bis 232: jede spaetere Migration haengt hinten an, und ein Lauf ueber
    // die ganze Liste liesse diesen Test mit der naechsten Nummer rot werden.
    dbmod.migrate(old, dbmod.MIGRATIONS.filter((m) => m.version <= 232));

    assert.equal(old.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 232);
    const column = old.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'sort_order');
    assert.ok(column, 'die Spalte ist da');
    assert.equal(column.notnull, 0, 'nullbar');
    assert.equal(column.dflt_value, null, 'kein Standardwert - NULL heisst "nicht platziert"');
    assert.deepEqual(
      old.prepare('SELECT sort_order FROM users').all().map((row) => row.sort_order),
      people.map(() => null),
      'kein Backfill: jede Zeile ist unplatziert',
    );
    assert.deepEqual(old.prepare('SELECT id, username, display_name, deactivated_at FROM users ORDER BY id').all(), before, 'die Zeilen selbst sind unveraendert');
    // Und der Leser ordnet den Bestand wie vorher: nur die Mitglieder, nach Name.
    assert.deepEqual(
      members.listMemberOrder({ db: old }).map((row) => row.id),
      [idOf.Anna, idOf.Ben, idOf.Zoe],
    );
  } finally {
    old.close();
  }
});

// --------------------------------------------------------------------------
// 2. Ohne Positionen: die Reihenfolge von vorher
// --------------------------------------------------------------------------

/**
 * AUFGEZEICHNET am Stand vor #1644 (origin/main 7e3dbe36d), mit genau der Saat
 * oben: dieselbe Datei gegen jenen Baum gefahren, die Antworten je Route
 * abgeschrieben. Kein Wert hier ist aus dem neuen Leser abgeleitet.
 */
const RECORDED_BEFORE = {
  member: {
    'GET /family/members': ['Anna', 'Ben', 'Mara', 'Zoe', 'Ömer'],
    'GET /auth/users': ['Anna', 'Ben', 'Carla Putzhilfe', 'Gustav Gast', 'Mara', 'Zoe', 'Ömer', 'Dora'],
    'GET /tasks/meta/options (users)': ['Anna', 'Ben', 'Mara', 'Zoe', 'Ömer'],
    'GET /dashboard (users)': ['Anna', 'Ben', 'Mara', 'Zoe', 'Ömer'],
    'GET /schedule/household-members': ['Anna', 'Ben', 'Mara', 'Zoe', 'Ömer'],
  },
  admin: {
    'GET /rewards/participants': ['Anna', 'Ben', 'Mara', 'Zoe', 'Ömer'],
    'GET /permissions/catalog (members)': ['Anna', 'Ben', 'Carla Putzhilfe', 'Gustav Gast', 'Mara', 'Wandtablett', 'Zoe', 'Ömer'],
    'GET /auth/2fa/overview': ['Anna', 'Ben', 'Carla Putzhilfe', 'Gustav Gast', 'Mara', 'Wandtablett', 'Zoe', 'Ömer'],
    'GET /auth/api-tokens (subjects)': ['Anna', 'Ben', 'Carla Putzhilfe', 'Mara', 'Zoe', 'Ömer'],
  },
};

test('a household without positions sees the order it had before #1644, on every list', async () => {
  assert.deepEqual(await readLists(CALL.Zoe, LISTS), RECORDED_BEFORE.member, 'als Mitglied');
  assert.deepEqual(await readLists(admin, LISTS), RECORDED_BEFORE.member, 'als Administrator');
  assert.deepEqual(await readLists(admin, ADMIN_LISTS), RECORDED_BEFORE.admin);
});

test('without positions every member carries sort_order null', async () => {
  const family = (await admin('GET', '/family/members')).body.data;
  assert.deepEqual(family.map((m) => m.sort_order), [null, null, null, null, null]);
  const users = (await admin('GET', '/auth/users')).body.data;
  assert.deepEqual(users.map((u) => u.sort_order), users.map(() => null));
  assert.deepEqual(
    Object.fromEntries(users.map((u) => [u.display_name, u.is_household_member])),
    { Anna: true, Ben: true, 'Carla Putzhilfe': false, 'Gustav Gast': false, Mara: true, Zoe: true, 'Ömer': true, Dora: false },
    'is_household_member nennt genau die Mitglieder',
  );
});

// --------------------------------------------------------------------------
// 5. Absagen - VOR dem ersten Ordnen, damit "nichts geschrieben" messbar ist
// --------------------------------------------------------------------------

test('a non-admin cannot reorder: 403 with reason, nothing written', async () => {
  const before = rawPositions();
  const r = await reorder(CALL.Zoe, ids('Zoe', 'Mara', 'Anna', 'Ben', 'Ömer'));
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'admin_required');
  assert.equal(r.body.error, 'Only administrators can change the member order.');
  assert.equal(r.body.code, 403);
  assert.deepEqual(rawPositions(), before);
});

const REFUSALS = [
  ['housekeeping staff', () => ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben', 'Carla Putzhilfe'), 'not_a_household_member'],
  ['a split-expense guest', () => ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben', 'Gustav Gast'), 'not_a_household_member'],
  ['a wall display', () => ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben', 'Wandtablett'), 'not_a_household_member'],
  ['a deactivated account', () => ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben', 'Dora'), 'not_a_household_member'],
  ['staff in place of a member', () => ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Carla Putzhilfe'), 'not_a_household_member'],
  ['an unknown id', () => [...ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben'), 999999], 'not_a_household_member'],
  ['a duplicate', () => ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben', 'Zoe'), 'duplicate_member'],
  ['a duplicate in place of a member', () => ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Anna'), 'duplicate_member'],
  ['a missing member', () => ids('Mara', 'Zoe', 'Ömer', 'Anna'), 'incomplete_order'],
  ['an empty list', () => [], 'invalid_order'],
  ['ids as strings', () => ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben').map(String), 'invalid_order'],
  ['a fraction', () => [...ids('Mara', 'Zoe', 'Ömer', 'Anna'), ID.Ben + 0.5], 'invalid_order'],
  ['a boolean', () => [...ids('Mara', 'Zoe', 'Ömer', 'Anna'), true], 'invalid_order'],
  ['zero', () => [...ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben'), 0], 'invalid_order'],
  ['an object instead of a list', () => ({ 0: ID.Mara }), 'invalid_order'],
];

for (const [label, order, reason] of REFUSALS) {
  test(`reorder refuses ${label}: 400 ${reason}, nothing written`, async () => {
    const before = rawPositions();
    const r = await reorder(admin, order());
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.reason, reason);
    assert.equal(r.body.code, 400);
    assert.match(r.body.error, /^[A-Za-z][ -~]+\.$/, 'ein englischer Satz');
    assert.deepEqual(rawPositions(), before);
  });
}

test('reorder without a body or without `order` is a 400, not a 500', async () => {
  for (const body of [undefined, {}, { order: null }, { ids: ids('Mara') }]) {
    const r = await admin('PATCH', '/family/members/reorder', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.reason, 'invalid_order');
  }
});

test('the refusal names who is not a household member', async () => {
  const r = await reorder(admin, ids('Mara', 'Zoe', 'Ömer', 'Anna', 'Ben', 'Carla Putzhilfe', 'Dora'));
  assert.equal(r.body.error, `Only household members have a place in the member order - user ${ID['Carla Putzhilfe']}, ${ID.Dora} is not a household member.`);
});

// --------------------------------------------------------------------------
// 3. Ordnen: ueberall dieselbe Reihenfolge, fuer jeden, auch nach einem Neustart
// --------------------------------------------------------------------------

const WANTED = ['Mara', 'Ömer', 'Zoe', 'Ben', 'Anna'];

test('an admin sets the order: positions 1..n, and the answer is the member list in that order', async () => {
  const r = await reorder(admin, ids(...WANTED));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(names(r.body.data), WANTED);
  assert.deepEqual(r.body.data.map((m) => m.sort_order), [1, 2, 3, 4, 5]);
  assert.deepEqual(rawPositions(), {
    Mara: 1, 'Ömer': 2, Zoe: 3, Ben: 4, Anna: 5,
    'Carla Putzhilfe': null, 'Gustav Gast': null, Dora: null, Wandtablett: null,
  });
});

test('every list of people follows the order, and two different users see the same one', async () => {
  const asAdmin = await readLists(admin, LISTS);
  const asZoe = await readLists(CALL.Zoe, LISTS);
  assert.deepEqual(asZoe, asAdmin, 'Mitglied und Administrator sehen dieselbe Reihenfolge');
  for (const [route, list] of Object.entries(asAdmin)) {
    assert.deepEqual(onlyMembers(list), WANTED, route);
  }
  for (const [route, list] of Object.entries(await readLists(admin, ADMIN_LISTS))) {
    assert.deepEqual(onlyMembers(list), WANTED, route);
  }
  // Das Kontenverzeichnis ganz: Platzierte zuerst, dann wer keine Position hat
  // (Personal, Gast) nach Name, Ehemalige am Ende.
  assert.deepEqual(asAdmin['GET /auth/users'], [...WANTED, 'Carla Putzhilfe', 'Gustav Gast', 'Dora']);
});

/** Liest `/family/members` in einem FRISCHEN Prozess auf derselben Datei - ueber den echten Router. */
function membersInFreshProcess() {
  const code = `
    import express from 'express';
    const { default: router } = await import('./server/routes/family.js');
    const app = express();
    app.use('/', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.on('listening', resolve));
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/members');
    process.stdout.write('RESULT ' + JSON.stringify((await res.json()).data.map((m) => [m.id, m.sort_order])));
    server.close();
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DB_PATH, SESSION_SECRET: 'test-member-order-secret-32-characters', LOG_LEVEL: 'error' },
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT ')) ?? '';
  assert.ok(line, `der frische Prozess hat geantwortet (exit ${run.status}): ${run.stderr.slice(-400)}`);
  return JSON.parse(line.slice('RESULT '.length));
}

test('the order survives a restart: a fresh process on the same file reads it', () => {
  assert.deepEqual(membersInFreshProcess(), ids(...WANTED).map((id, index) => [id, index + 1]));
});

// --------------------------------------------------------------------------
// 4. Unplatzierte nach den Platzierten, nach Name
// --------------------------------------------------------------------------

test('new members are unplaced and come after the placed ones, by name without regard to ASCII case', async () => {
  // Anlegefolge bewusst gegen das Alphabet. "emil" klein: BINARY stellte ihn
  // hinter "Frida", NOCASE davor. "Élise": kein ASCII, steht hinter allem ASCII.
  for (const name of ['Frida', 'Élise', 'emil']) await account(name);
  const family = (await admin('GET', '/family/members')).body.data;
  assert.deepEqual(names(family), [...WANTED, 'emil', 'Frida', 'Élise']);
  assert.deepEqual(family.map((m) => m.sort_order), [1, 2, 3, 4, 5, null, null, null]);

  const everyone = [...WANTED, 'emil', 'Frida', 'Élise'];
  const lists = { ...await readLists(CALL.Zoe, LISTS), ...await readLists(admin, ADMIN_LISTS) };
  for (const [route, list] of Object.entries(lists)) {
    assert.deepEqual(onlyMembers(list, everyone), everyone, route);
  }
  // Auch die Listen, die vor #1644 BINARY sortierten (Kontenverzeichnis,
  // Aufgabenfilter, Uebersicht), stellen "emil" jetzt vor "Frida" - die eine
  // Regel statt zweier.
  assert.deepEqual(lists['GET /auth/users'], [...WANTED, 'Carla Putzhilfe', 'emil', 'Frida', 'Gustav Gast', 'Élise', 'Dora']);
});

test('an order that leaves a new member out is incomplete; with them it places everyone', async () => {
  const before = rawPositions();
  const partial = await reorder(admin, ids(...WANTED));
  assert.equal(partial.status, 400);
  assert.equal(partial.body.reason, 'incomplete_order');
  assert.deepEqual(rawPositions(), before);

  const next = ['emil', 'Mara', 'Ömer', 'Zoe', 'Ben', 'Anna', 'Élise', 'Frida'];
  const r = await reorder(admin, ids(...next));
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.body.data), next);
  assert.deepEqual(names((await CALL.Zoe('GET', '/family/members')).body.data), next);
});

// --------------------------------------------------------------------------
// 6. Die Position gilt nur fuer ein Mitglied
// --------------------------------------------------------------------------

test('a placed member who is deactivated drops out; the others keep their places, the gap is harmless', async () => {
  // Ben steht auf Platz 5 von 8.
  db.prepare("INSERT INTO tasks (title, status, visibility, created_by) VALUES ('Spur', 'open', 'all', ?)").run(ID.Ben);
  assert.equal((await admin('DELETE', `/auth/users/${ID.Ben}`)).body.outcome, 'deactivated');
  assert.equal(rawPositions().Ben, 5, 'Vorbedingung: die Zahl steht noch in der Spalte');

  const family = (await admin('GET', '/family/members')).body.data;
  assert.deepEqual(names(family), ['emil', 'Mara', 'Ömer', 'Zoe', 'Anna', 'Élise', 'Frida']);
  assert.deepEqual(family.map((m) => m.sort_order), [1, 2, 3, 4, 6, 7, 8], 'Luecke bei 5');

  const users = (await admin('GET', '/auth/users')).body.data;
  const ben = users.find((u) => u.id === ID.Ben);
  assert.equal(ben.sort_order, null, 'ein Ehemaliger hat keine Position, auch wenn die Spalte eine traegt');
  assert.equal(ben.is_household_member, false);
  assert.deepEqual(names(users).slice(-2).sort(), ['Ben', 'Dora'], 'beide Ehemaligen am Ende');

  // Wer ordnet, ordnet ohne ihn - und danach ist auch die Spalte leer.
  const refused = await reorder(admin, ids('emil', 'Mara', 'Ömer', 'Zoe', 'Ben', 'Anna', 'Élise', 'Frida'));
  assert.equal(refused.body.reason, 'not_a_household_member');
  const r = await reorder(admin, ids('Mara', 'emil', 'Ömer', 'Zoe', 'Anna', 'Élise', 'Frida'));
  assert.equal(r.status, 200);
  assert.equal(rawPositions().Ben, null, 'das naechste Ordnen nimmt die alte Zahl weg');
});

test('a placed member who becomes housekeeping staff has no position: the reader decides, not the write path', async () => {
  // Frida steht auf Platz 7 und wird Personal - die Spalte behaelt die 7.
  db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(ID.Frida);
  try {
    assert.equal(rawPositions().Frida, 7);
    assert.deepEqual(names((await admin('GET', '/family/members')).body.data), ['Mara', 'emil', 'Ömer', 'Zoe', 'Anna', 'Élise']);
    const users = (await admin('GET', '/auth/users')).body.data;
    assert.equal(users.find((u) => u.id === ID.Frida).sort_order, null);
    // Mit einer rohen 7 stuende sie VOR "Carla Putzhilfe" bei den Platzierten.
    assert.deepEqual(names(users), ['Mara', 'emil', 'Ömer', 'Zoe', 'Anna', 'Élise', 'Carla Putzhilfe', 'Frida', 'Gustav Gast', 'Ben', 'Dora']);
  } finally {
    db.prepare('DELETE FROM housekeeping_workers WHERE user_id = ?').run(ID.Frida);
  }
});

test('shared expenses: the people offered for a group and its balances follow the order', async () => {
  const group = await admin('POST', '/split-expenses/groups', { name: 'Haushalt', type: 'household', default_currency: 'EUR' });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  const candidates = await admin('GET', `/split-expenses/groups/${group.body.data.id}/member-candidates`);
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  // Stand nach dem letzten Ordnen: Mara, emil, Ömer, Zoe, Anna, Élise, Frida.
  assert.deepEqual(
    names(candidates.body.data.filter((row) => row.source === 'user'), 'user_id'),
    ['Mara', 'emil', 'Ömer', 'Zoe', 'Anna', 'Élise', 'Frida'],
  );
});

test('lists that rank by something else first use the member order only for ties', async () => {
  // Punktestand: Anna (Platz 5) fuehrt, Mara und emil stehen gleich.
  for (const name of ['Mara', 'emil', 'Anna']) {
    db.prepare('INSERT OR REPLACE INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(ID[name]);
  }
  db.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_by) VALUES (?, 10, 'bonus', 'Test', ?)").run(ID.Anna, ID.Mara);
  // Die Haushaltsreihenfolge umdrehen: emil vor Mara.
  assert.equal((await reorder(admin, ids('emil', 'Mara', 'Ömer', 'Zoe', 'Anna', 'Élise', 'Frida'))).status, 200);
  const overview = (await admin('GET', '/rewards/overview')).body.data;
  assert.deepEqual(names(overview.balances), ['Anna', 'emil', 'Mara'], 'Stand zuerst, Gleichstand nach Haushaltsreihenfolge');
});

// --------------------------------------------------------------------------
// 7. Server-Leser und Browser-Vergleich: dieselbe Reihenfolge
// --------------------------------------------------------------------------

/**
 * Handgebaute Personen mit AUSGESCHRIEBENER Erwartung. Die Faelle, an denen
 * zwei Implementierungen auseinanderlaufen:
 *   - Gross/Klein in ASCII (NOCASE faltet) gegen Nicht-ASCII (faltet nicht);
 *   - ein Name als Anfang eines anderen;
 *   - gleicher Name, verschiedene id; gleiche Position, verschiedener Name;
 *   - Codepunkt- gegen UTF-16-Reihenfolge: U+FF21 (ein Zeichen der BMP) steht
 *     in SQLite VOR einem Emoji (Ersatzpaar, in UTF-16 kleiner als U+FF21);
 *   - Personal mit einer Zahl in der Spalte.
 */
const PEOPLE = [
  // [id, display_name, rohe Spalte, Personal?]
  [1, 'Zoe', null, false],
  [2, 'anna', null, false],
  [3, 'Anna', null, false],
  [4, 'Ömer', null, false],
  [5, 'Al', null, false],
  [6, 'Alex', null, false],
  [7, 'élise', null, false],
  [8, 'Élise', null, false],
  [9, '😀 Max', null, false],
  [10, 'Ａlex', null, false],
  [11, 'Papa', 2, false],
  [12, 'Mama', 1, false],
  [13, 'Kind', 7, false],
  [14, 'Zwilling', 4, false],
  [15, 'Aaron', 4, false],
  [16, 'Putzhilfe', 1, true],
  [17, 'bob', null, false],
  [18, 'Bob', null, false],
];
const EXPECTED_MEMBERS = [
  'Mama', 'Papa', 'Aaron', 'Zwilling', 'Kind',
  'Al', 'Alex', 'anna', 'Anna', 'bob', 'Bob', 'Zoe',
  'Élise', 'Ömer', 'élise', 'Ａlex', '😀 Max',
];
// Das Kontenverzeichnis: Personal hat keine Position und steht im Alphabet.
const EXPECTED_ACCOUNTS = [
  'Mama', 'Papa', 'Aaron', 'Zwilling', 'Kind',
  'Al', 'Alex', 'anna', 'Anna', 'bob', 'Bob', 'Putzhilfe', 'Zoe',
  'Élise', 'Ömer', 'élise', 'Ａlex', '😀 Max',
];

function seededPeople() {
  const mem = new Database(':memory:');
  dbmod.migrate(mem, dbmod.MIGRATIONS);
  // Rueckwaerts eingefuegt, damit die Einfuegefolge nie zufaellig die Antwort ist.
  for (const [id, name, position, staff] of [...PEOPLE].reverse()) {
    mem.prepare("INSERT INTO users (id, username, display_name, password_hash, sort_order) VALUES (?, ?, ?, 'x', ?)").run(id, `p${id}`, name, position);
    if (staff) mem.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(id);
  }
  return mem;
}

test('server reader: memberOrderSql() gives the written-out order', () => {
  const mem = seededPeople();
  try {
    const membersOnly = mem.prepare(`
      SELECT u.display_name FROM users u WHERE ${members.householdMemberSql('u')} ORDER BY ${members.memberOrderSql('u')}
    `).all().map((row) => row.display_name);
    assert.deepEqual(membersOnly, EXPECTED_MEMBERS);
    const accounts = mem.prepare(`SELECT u.display_name FROM users u ORDER BY ${members.memberOrderSql('u')}`).all().map((row) => row.display_name);
    assert.deepEqual(accounts, EXPECTED_ACCOUNTS);
    // Ueber Ergebnisspalten (hinter einem UNION) dieselbe Folge.
    const overColumns = mem.prepare(`
      SELECT * FROM (
        SELECT u.id AS user_id, u.display_name, ${members.memberPositionSql('u')} AS sort_order FROM users u WHERE u.id <= 9
        UNION ALL
        SELECT u.id AS user_id, u.display_name, ${members.memberPositionSql('u')} AS sort_order FROM users u WHERE u.id > 9
      )
      ORDER BY ${members.memberOrderOverColumnsSql({ position: 'sort_order', name: 'display_name', id: 'user_id' })}
    `).all().map((row) => row.display_name);
    assert.deepEqual(overColumns, EXPECTED_ACCOUNTS);
  } finally {
    mem.close();
  }
});

test('browser comparison: compareMembers() gives the same written-out order from what the server sends', () => {
  const mem = seededPeople();
  try {
    // Was eine Route herausgibt: die Position ueber memberPositionSql(), in
    // einer Folge, die NICHT die Antwort ist (nach id absteigend).
    const sent = mem.prepare(`
      SELECT u.id, u.display_name, ${members.memberPositionSql('u')} AS sort_order,
             ${members.householdMemberSql('u')} AS is_member
      FROM users u ORDER BY u.id DESC
    `).all();
    assert.deepEqual(sortMembers(sent).map((p) => p.display_name), EXPECTED_ACCOUNTS);
    assert.deepEqual(sortMembers(sent.filter((p) => p.is_member)).map((p) => p.display_name), EXPECTED_MEMBERS);
    // Dieselbe Eingabe, andere Ausgangsfolge: das Ergebnis haengt nicht daran.
    assert.deepEqual(sortMembers([...sent].reverse()).map((p) => p.display_name), EXPECTED_ACCOUNTS);
    assert.equal(sent.find((p) => p.display_name === 'Putzhilfe').sort_order, null, 'Vorbedingung: die rohe 1 des Personals kommt nicht heraus');
  } finally {
    mem.close();
  }
});

test('browser comparison on the real routes: re-sorting any answer changes nothing', async () => {
  const family = (await admin('GET', '/family/members')).body.data;
  assert.deepEqual(sortMembers([...family].reverse()).map((m) => m.id), family.map((m) => m.id));
  const users = (await admin('GET', '/auth/users')).body.data;
  for (const part of [users.filter((u) => !u.deactivated_at), users.filter((u) => u.deactivated_at)]) {
    assert.deepEqual(sortMembers([...part].reverse()).map((u) => u.id), part.map((u) => u.id));
  }
});

test('compareNamesNoCase folds only A-Z and orders by code point, not by UTF-16 unit or locale', () => {
  assert.ok(compareNamesNoCase('anna', 'Bob') < 0, 'ASCII ohne Gross/Klein');
  assert.equal(compareNamesNoCase('ANNA', 'anna'), 0);
  assert.ok(compareNamesNoCase('Zoe', 'Ömer') < 0, 'ein Umlaut steht hinter Z (localeCompare saehe es umgekehrt)');
  assert.ok(compareNamesNoCase('Élise', 'élise') < 0, 'ausserhalb von ASCII wird nicht gefaltet');
  assert.ok(compareNamesNoCase('Al', 'Alex') < 0, 'der kuerzere Anfang zuerst');
  assert.ok(compareNamesNoCase('Ａ', '😀') < 0, 'Codepunkte: U+FF21 vor U+1F600');
  assert.ok('Ａ' > '😀', 'Vorbedingung: der JS-Stringvergleich (UTF-16) saehe es umgekehrt');
  assert.equal(compareNamesNoCase(null, undefined), 0);
});

test('compareMembers: placed first, gaps allowed, ties by id; a string position is no position', () => {
  const a = { id: 1, display_name: 'Zoe', sort_order: 40 };
  const b = { id: 2, display_name: 'Anna', sort_order: null };
  const c = { id: 3, display_name: 'Ben', sort_order: 7 };
  const d = { id: 4, display_name: 'Ben', sort_order: 7 };
  const e = { id: 5, display_name: 'Aaron' };
  const f = { user_id: 6, display_name: 'aaron', sort_order: '1' };
  assert.deepEqual(sortMembers([f, e, d, c, b, a]).map((p) => p.id ?? p.user_id), [3, 4, 1, 5, 6, 2]);
  assert.equal(compareMembers(a, a), 0);
});

test('memberRanks: the place of an id in the order, strangers last', () => {
  const ranks = memberRanks([
    { id: 9, display_name: 'Zoe', sort_order: null },
    { id: 4, display_name: 'Anna', sort_order: null },
    { id: 7, display_name: 'Ben', sort_order: 1 },
  ]);
  assert.deepEqual([7, 4, 9].map((id) => memberRankOf(ranks, id)), [0, 1, 2]);
  assert.equal(memberRankOf(ranks, '4'), 1, 'eine id als Zeichenkette (Datensatzfeld) trifft dieselbe Person');
  assert.ok(memberRankOf(ranks, 123) > 2);
});

test('the reader takes no options and rejects a bad alias', () => {
  assert.throws(() => members.memberOrderSql('u', { byName: true }), /takes no options/);
  assert.throws(() => members.memberOrderSql('u; DROP TABLE users'), /invalid table alias/);
  assert.throws(() => members.memberOrderOverColumnsSql({ position: 'sort_order', name: 'display_name COLLATE BINARY', id: 'id' }), /invalid column/);
});
