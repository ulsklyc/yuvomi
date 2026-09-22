/**
 * Test: Verlorene Ledger-Zeilen aktiver Ausgaben werden neu aufgebaut (Migration v226, #1382)
 * Zweck: `expense_ledger_entries.created_by` ist ON DELETE CASCADE. Bis v225
 *        stempelte ein PUT /expenses/:id die Zeilen mit der BEARBEITENDEN
 *        Person; wurde deren Konto geloescht, nahm die Kaskade die Zeilen mit,
 *        und die weiter aktive Ausgabe fiel still aus allen Salden. v225 hat
 *        den Autor der noch vorhandenen Zeilen korrigiert, die schon
 *        verlorenen kann ein UPDATE nicht zurueckholen. v226 baut sie aus
 *        `expenses` + `expense_splits` neu auf - ueber `insertExpenseLedger`,
 *        dieselbe Funktion, mit der die Route bucht.
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
