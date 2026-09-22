/**
 * Test: Verlorene Ledger-Zeilen aktiver Ausgaben werden neu aufgebaut (Migration v226, #1382)
 * Zweck: `expense_ledger_entries.created_by` ist ON DELETE CASCADE. Bis v225
 *        stempelte ein PUT /expenses/:id die Zeilen mit der BEARBEITENDEN
 *        Person; wurde deren Konto geloescht, nahm die Kaskade die Zeilen mit,
 *        und die weiter aktive Ausgabe fiel still aus allen Salden. v225 hat
 *        den Autor der noch vorhandenen Zeilen korrigiert, die schon
 *        verlorenen kann ein UPDATE nicht zurueckholen. v226 baut sie aus
 *        `expenses` + `expense_splits` neu auf, mit einer als SQL
 *        EINGEFRORENEN Fassung der Regel von `insertExpenseLedger`.
 *
 *        Zwei Teile:
 *        1. Aequivalenz: Zeilen, die die ROUTE bucht, gegen Zeilen, die die
 *           eingefrorene Migration aufbaut. ROT HEISST: die Buchungsregel hat
 *           sich geaendert. Dann v226 NICHT anfassen - sie laeuft auf
 *           Bestandsinstallationen genau einmal, auf dem Schema ihrer Version,
 *           und hat damals richtig gebaut. Stattdessen diesen Vergleich an die
 *           neue Regel anpassen (bzw. auf den Stand von v226 festnageln).
 *        2. Upgrade durch den echten Runner: frische Datenbank bis v225
 *           migrieren, eine verlorene Ausgabe saeen, dann `migrate()` mit
 *           allen Migrationen - so, wie eine Bestandsinstallation das Update
 *           faehrt.
 *
 *        Der Verlust wird ueber den echten Weg hergestellt: Ausgaben ueber die
 *        Routen anlegen, ihre Zeilen so stempeln, wie der alte PUT es tat, und
 *        dann `DELETE /auth/users/<Bearbeiter>` die Kaskade ausloesen lassen.
 *        Gemessen wird gegen den Stand VOR dem Verlust: dieselben Zeilen,
 *        dieselben Salden.
 * Ausfuehren: npm run test:split-ledger-rebuild-migration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3-multiple-ciphers';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'split-ledger-rebuild-migration',
  env: { SESSION_SECRET: 'test-split-ledger-rebuild-migration-secret', RATE_LIMIT_MAX_ATTEMPTS: '50' },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();
const migration226 = dbmod.MIGRATIONS.find((m) => m.version === 226);

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
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
const adminCall = as(await login('admin', 'adminpass123'));

async function member(username, displayName) {
  const r = await adminCall('POST', '/auth/users', { username, display_name: displayName, password: `${username}pass123` });
  assert.equal(r.status, 201, `create ${username}`);
  return { id: r.body.user.id, call: as(await login(username, `${username}pass123`)) };
}

// OWN besitzt die Gruppe, AUT legt die Ausgaben an, ED ist der Bearbeiter,
// dessen Konto spaeter geloescht wird, PAY zahlt und teilt.
const OWN = await member('owner', 'Olivia');
const AUT = await member('author', 'Anna');
const ED = await member('editor', 'Emil');
const PAY = await member('payer', 'Paul');

const group = await OWN.call('POST', '/split-expenses/groups', { name: 'WG', type: 'household', default_currency: 'EUR' });
assert.equal(group.status, 201);
const GROUP = group.body.data.id;
for (const [u, role] of [[AUT, 'guest'], [ED, 'admin'], [PAY, 'guest']]) {
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: u.id, role })).status, 201);
}

async function balances() {
  const r = await OWN.call('GET', `/split-expenses/groups/${GROUP}/balances`);
  assert.equal(r.status, 200);
  return r.body.data.balances;
}

async function expense(extra) {
  const r = await AUT.call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
    title: 'Einkauf', amount: '10.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
    participants: [OWN.id, PAY.id, AUT.id], expense_date: '2026-09-02', ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}

// Was die Route gebucht hat, ohne id und Zeitstempel - daran misst sich der Neuaufbau.
const bookedRows = (id) => db.prepare(`
  SELECT group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by
  FROM expense_ledger_entries WHERE source_type = 'expense' AND source_id = ?
  ORDER BY user_id, amount_minor
`).all(id);
const rowIds = (id) => db.prepare(
  "SELECT id FROM expense_ledger_entries WHERE source_type = 'expense' AND source_id = ? ORDER BY id",
).all(id).map((row) => row.id);
const snapshot = () => db.prepare('SELECT * FROM expense_ledger_entries ORDER BY id').all();

// 10.00 durch drei: ein Rest-Cent, der beim Neuaufbau bei derselben Person landen muss.
const LOST_REMAINDER = await expense({ title: 'Rest-Cent' });
// Fremdwaehrung: gebucht wird der umgerechnete Betrag, nicht der eingegebene.
const LOST_FX = await expense({ title: 'Urlaub', amount: '20.00', currency: 'USD', converted_amount: '18.50', converted_currency: 'EUR', participants: [OWN.id, PAY.id] });
// Bleibt vollstaendig - die Migration darf sie nicht anfassen.
const KEPT = await expense({ title: 'Brot', amount: '4.00' });
// Geloescht: ihre Zeilen sind absichtlich weg, und das muss so bleiben.
const DELETED = await expense({ title: 'Storniert', amount: '6.00' });
assert.equal((await AUT.call('DELETE', `/split-expenses/expenses/${DELETED}`)).status, 200);
assert.equal(db.prepare('SELECT status FROM expenses WHERE id = ?').get(DELETED).status, 'deleted');
// Eine Zahlung - Settlement-Zeilen gehoeren nicht zum Neuaufbau.
const settled = await PAY.call('POST', `/split-expenses/groups/${GROUP}/settlements`, { payer_id: PAY.id, payee_id: OWN.id, amount: '2.00', currency: 'EUR' });
assert.equal(settled.status, 201);

const EXPECTED = { [LOST_REMAINDER]: bookedRows(LOST_REMAINDER), [LOST_FX]: bookedRows(LOST_FX) };
assert.equal(EXPECTED[LOST_REMAINDER].length, 4, 'Fixture: Zahler + drei Anteile');
assert.equal(EXPECTED[LOST_FX].length, 3, 'Fixture: Zahler + zwei Anteile');
assert.ok(EXPECTED[LOST_FX].every((row) => row.currency === 'EUR'), 'Fixture: in converted_currency gebucht');
assert.ok(EXPECTED[LOST_FX].some((row) => row.amount_minor === 1850), 'Fixture: umgerechneter Betrag');
const KEPT_IDS = rowIds(KEPT);
const BALANCES = await balances();

// Der Stand, den der alte PUT hinterliess: Zeilen mit dem Bearbeiter gestempelt.
// Dann das Konto loeschen - die Kaskade nimmt genau diese Zeilen.
for (const id of [LOST_REMAINDER, LOST_FX]) {
  db.prepare("UPDATE expense_ledger_entries SET created_by = ? WHERE source_type = 'expense' AND source_id = ?").run(ED.id, id);
}
assert.equal((await adminCall('DELETE', `/auth/users/${ED.id}`)).status, 200);
assert.equal(bookedRows(LOST_REMAINDER).length, 0, 'Fixture: Kaskade hat die Zeilen genommen');
assert.equal(bookedRows(LOST_FX).length, 0);
assert.equal(db.prepare('SELECT status FROM expenses WHERE id = ?').get(LOST_REMAINDER).status, 'active', 'Fixture: Ausgabe weiter aktiv');
assert.notDeepEqual(await balances(), BALANCES, 'Fixture: die Salden sind falsch');

test('Migration v226 existiert und laeuft als Funktion', () => {
  assert.ok(migration226, 'MIGRATIONS enthaelt v226');
  assert.equal(typeof migration226.up, 'function');
});

test('Migration baut die verlorenen Zeilen so auf, wie die Route sie gebucht hat', () => {
  migration226.up(db);
  assert.deepEqual(bookedRows(LOST_REMAINDER), EXPECTED[LOST_REMAINDER], 'Rest-Cent: dieselben Zeilen');
  assert.deepEqual(bookedRows(LOST_FX), EXPECTED[LOST_FX], 'Fremdwaehrung: dieselben Zeilen');
});

test('vollstaendige und geloeschte Ausgaben bleiben unberuehrt', () => {
  assert.deepEqual(rowIds(KEPT), KEPT_IDS, 'vollstaendige Ausgabe: dieselben Zeilen, keine neuen');
  assert.equal(bookedRows(DELETED).length, 0, 'geloeschte Ausgabe bekommt keine Zeilen');
});

test('der Verlauf der Gruppe nennt jede wiederhergestellte Ausgabe genau einmal', async () => {
  const r = await OWN.call('GET', `/split-expenses/groups/${GROUP}/activity`);
  assert.equal(r.status, 200);
  const list = Array.isArray(r.body.data) ? r.body.data : r.body.data.items;
  const restored = list.filter((a) => a.type === 'ledger_restored');
  assert.deepEqual(restored.map((a) => a.entity_id).sort((a, b) => a - b), [LOST_REMAINDER, LOST_FX].sort((a, b) => a - b));
  assert.ok(restored.every((a) => a.actor_id === null && a.entity_type === 'expense'), 'kein Akteur, Ausgabe als Bezug');
  // Der Betrag liegt in Minor-Units; die API ergaenzt die Dezimalform nach ISO 4217.
  assert.deepEqual(restored.find((a) => a.entity_id === LOST_FX).metadata, {
    title: 'Urlaub', amount_minor: 1850, currency: 'EUR', amount: '18.50',
  });
});

test('Salden danach gleich dem Stand vor dem Verlust', async () => {
  assert.deepEqual(await balances(), BALANCES);
});

test('zweiter Lauf aendert nichts', () => {
  const before = snapshot();
  const changesBefore = db.prepare('SELECT total_changes() AS n').get().n;
  migration226.up(db);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changesBefore, 'keine Zeile beruehrt');
  assert.deepEqual(snapshot(), before);
});

test('Upgrade von v225 durch den echten Runner baut die Zeilen auf und verbucht v226', () => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  const logged = [];
  const write = process.stdout.write;
  try {
    process.stdout.write = (chunk, ...rest) => { logged.push(String(chunk)); return write.call(process.stdout, chunk, ...rest); };
    dbmod.migrate(fresh, dbmod.MIGRATIONS.filter((m) => m.version <= 225));
    const user = (name) => fresh.prepare(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')",
    ).run(name, name).lastInsertRowid;
    const own = user('own');
    const pay = user('pay');
    const groupId = fresh.prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(own).lastInsertRowid;
    const addExpense = (status) => fresh.prepare(`
      INSERT INTO expenses (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, created_by, status)
      VALUES (?, 'Einkauf', 2000, 'USD', 1850, 'EUR', ?, ?, ?)
    `).run(groupId, own, own, status).lastInsertRowid;
    const addSplits = (id) => {
      for (const [who, amount] of [[own, 925], [pay, 925]]) {
        fresh.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_minor, currency) VALUES (?, ?, ?, ?)').run(id, who, amount, 'EUR');
      }
    };
    // Gruppe WG: zwei verlorene Ausgaben (Anteile da, Ledger-Zeilen weg) und eine geloeschte.
    const lost = addExpense('active');
    const lost2 = addExpense('active');
    const gone = addExpense('deleted');
    for (const id of [lost, lost2, gone]) addSplits(id);
    // Gruppe Urlaub: eine vollstaendige Ausgabe - keine Reparatur, kein Eintrag.
    const otherGroup = fresh.prepare("INSERT INTO expense_groups (name, created_by) VALUES ('Urlaub', ?)").run(own).lastInsertRowid;
    const complete = fresh.prepare(`
      INSERT INTO expenses (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, created_by)
      VALUES (?, 'Hotel', 1850, 'EUR', 1850, 'EUR', ?, ?)
    `).run(otherGroup, own, own).lastInsertRowid;
    addSplits(complete);
    const ledger = fresh.prepare(`
      INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
      VALUES (?, 'expense', ?, ?, ?, ?, 'EUR', 'Hotel', ?)
    `);
    ledger.run(otherGroup, complete, own, null, 1850, own);
    ledger.run(otherGroup, complete, own, own, -925, own);
    ledger.run(otherGroup, complete, pay, own, -925, own);
    assert.equal(fresh.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 225, 'Fixture: Stand v225');

    dbmod.migrate(fresh, dbmod.MIGRATIONS);

    assert.ok(fresh.prepare('SELECT 1 FROM schema_migrations WHERE version = 226').get(), 'v226 verbucht');
    const rows = fresh.prepare(`
      SELECT group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by
      FROM expense_ledger_entries WHERE group_id = ? ORDER BY id
    `).all(groupId);
    const rowsOf = (id) => [
      { group_id: groupId, source_type: 'expense', source_id: id, user_id: own, counterparty_id: null, amount_minor: 1850, currency: 'EUR', memo: 'Einkauf', created_by: own },
      { group_id: groupId, source_type: 'expense', source_id: id, user_id: own, counterparty_id: own, amount_minor: -925, currency: 'EUR', memo: 'Einkauf', created_by: own },
      { group_id: groupId, source_type: 'expense', source_id: id, user_id: pay, counterparty_id: own, amount_minor: -925, currency: 'EUR', memo: 'Einkauf', created_by: own },
    ];
    assert.deepEqual(rows, [...rowsOf(lost), ...rowsOf(lost2)], 'nur die aktiven Ausgaben, Zahler zuerst, im umgerechneten Betrag');
    assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM expense_ledger_entries WHERE group_id = ?').get(otherGroup).n, 3, 'vollstaendige Ausgabe unberuehrt');

    // Verlauf: genau ein Eintrag je wiederhergestellter Ausgabe, keiner in der Gruppe ohne Reparatur.
    const activity = fresh.prepare(`
      SELECT group_id, actor_id, type, entity_type, entity_id, metadata FROM expense_activity ORDER BY id
    `).all();
    const restored = (id) => ({
      group_id: groupId, actor_id: null, type: 'ledger_restored', entity_type: 'expense', entity_id: id,
      metadata: JSON.stringify({ title: 'Einkauf', amount_minor: 1850, currency: 'EUR' }),
    });
    assert.deepEqual(activity, [restored(lost), restored(lost2)], 'N Eintraege fuer N wiederhergestellte Ausgaben');
    assert.equal(activity.filter((a) => a.group_id === otherGroup).length, 0, 'Gruppe ohne Reparatur: kein Eintrag');
    assert.ok(
      logged.some((line) => line.includes(`shared expense ${lost} in group ${groupId}`)),
      'Log nennt Ausgabe und Gruppe',
    );
    assert.ok(!logged.some((line) => line.includes(`shared expense ${gone} `)), 'geloeschte Ausgabe steht nicht im Log');
    assert.equal(fresh.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name = '_v226_missing'").get().n, 0, 'Hilfstabelle geraeumt');
  } finally {
    process.stdout.write = write;
    fresh.close();
  }
});
