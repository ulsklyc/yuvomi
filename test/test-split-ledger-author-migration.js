/**
 * Test: Ledger-Zeilen tragen den Autor ihres Datensatzes (Migration v225, #1309)
 * Zweck: Ein PUT /expenses/:id stempelte die neu geschriebenen Ledger-Zeilen
 *        mit der BEARBEITENDEN Person, ein Storno einer Zahlung (#1378) die
 *        Gegenbuchung mit der STORNIERENDEN. Beide Spalten sind
 *        `created_by ON DELETE CASCADE`: das Loeschen dieses Kontos nahm nur
 *        die Zeilen mit, und die weiter aktive Ausgabe fiel aus den Salden
 *        (bzw. die stornierte Zahlung zaehlte wieder). Die Routen sind
 *        repariert (test:split-settlement-reversal); die Migration zieht die
 *        schon geschriebenen Zeilen nach.
 *
 *        Aufgebaut wird der Stand VOR der Migration ueber die echten Routen
 *        und dann so zurueckgestempelt, wie ihn die alten Routen geschrieben
 *        haben. Gemessen wird am Ende das, worum es geht: nach der Migration
 *        laesst `DELETE /auth/users/:id` die Salden unveraendert.
 * Ausfuehren: npm run test:split-ledger-author-migration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'split-ledger-author-migration',
  env: { SESSION_SECRET: 'test-split-ledger-author-migration-secret', RATE_LIMIT_MAX_ATTEMPTS: '50' },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();
const migration225 = dbmod.MIGRATIONS.find((m) => m.version === 225);

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

// OWN besitzt die Gruppe, AUT legt die Ausgabe an und erfasst die Zahlung,
// ED bearbeitet und storniert als Gruppenverwalter, PAY zahlt und teilt.
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
  return Object.fromEntries(r.body.data.balances.map((b) => [b.user_id, b.net_minor]));
}
const authors = (type, id) => db.prepare(
  'SELECT created_by FROM expense_ledger_entries WHERE source_type = ? AND source_id = ? ORDER BY id',
).all(type, id).map((row) => row.created_by);
const snapshot = () => db.prepare('SELECT id, created_by FROM expense_ledger_entries ORDER BY id').all();

// Ausgabe von Anna, von Emil bearbeitet.
const body = (amount) => ({
  title: 'Einkauf', amount, currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
  participants: [OWN.id, PAY.id], expense_date: '2026-09-02',
});
const created = await AUT.call('POST', `/split-expenses/groups/${GROUP}/expenses`, body('8.00'));
assert.equal(created.status, 201);
const EXPENSE = created.body.data.id;
assert.equal((await ED.call('PUT', `/split-expenses/expenses/${EXPENSE}`, body('12.00'))).status, 200);

// Zahlung von PAUL erfasst (Paul an Olivia), von Emil storniert. Bewusst eine
// andere Person als Anna und dieselbe id wie die Ausgabe: griffe die
// Ausgaben-Korrektur auch 'settlement'-Zeilen (oder gar keinen Typfilter), trugen
// sie danach Annas id - und nur so wird der falsche Typ sichtbar.
const settled = await PAY.call('POST', `/split-expenses/groups/${GROUP}/settlements`, { payer_id: PAY.id, payee_id: OWN.id, amount: '2.00', currency: 'EUR' });
assert.equal(settled.status, 201);
const SETTLEMENT = settled.body.data.id;
assert.equal(SETTLEMENT, EXPENSE, 'Fixture: Zahlung und Ausgabe teilen die id');
assert.equal((await ED.call('POST', `/split-expenses/groups/${GROUP}/settlements/${SETTLEMENT}/reverse`)).status, 200);

// Eine zweite Ausgabe, die nie bearbeitet wurde - die Migration darf sie nicht anfassen.
const untouched = await AUT.call('POST', `/split-expenses/groups/${GROUP}/expenses`, { ...body('4.00'), title: 'Brot' });
assert.equal(untouched.status, 201);
const UNTOUCHED = untouched.body.data.id;

// Der Stand, den die alten Routen geschrieben haben: Bearbeiter bzw.
// Stornierender am Ledger.
db.prepare("UPDATE expense_ledger_entries SET created_by = ? WHERE source_type = 'expense' AND source_id = ?").run(ED.id, EXPENSE);
db.prepare("UPDATE expense_ledger_entries SET created_by = ? WHERE source_type = 'settlement_reversal' AND source_id = ?").run(ED.id, SETTLEMENT);
// Eine Ausgaben-Gegenbuchung (expense_reversal, #1416) mit dem Bearbeiter -
// Betrag 0, damit sie die Salden nicht verschiebt.
const addRow = db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, ?, ?, ?, NULL, 0, 'EUR', 'fixture', ?)
`);
addRow.run(GROUP, 'expense_reversal', EXPENSE, OWN.id, ED.id);
// Waisen: eine Ausgabenzeile ohne Ausgabe, eine Gegenbuchung ohne Buchung.
const ORPHAN_EXPENSE = 999001;
const ORPHAN_SETTLEMENT = 999002;
addRow.run(GROUP, 'expense', ORPHAN_EXPENSE, OWN.id, ED.id);
addRow.run(GROUP, 'settlement_reversal', ORPHAN_SETTLEMENT, OWN.id, ED.id);
const BALANCES = await balances();

test('Migration v225 existiert', () => {
  // Nicht an die Position im Array gebunden: die naechste Migration haengt
  // dahinter an, und diese Suite soll davon nicht rot werden.
  assert.ok(migration225, 'MIGRATIONS enthaelt v225');
  assert.equal(migration225.version, 225);
});

test('Migration setzt created_by auf den Autor des Datensatzes', () => {
  assert.deepEqual(authors('expense', EXPENSE), [ED.id, ED.id, ED.id], 'Ausgangslage: vom Bearbeiter gestempelt');
  db.exec(migration225.up);
  assert.deepEqual(authors('expense', EXPENSE), [AUT.id, AUT.id, AUT.id], 'Ausgabe: Ersteller');
  assert.deepEqual(authors('expense_reversal', EXPENSE), [AUT.id], 'Ausgaben-Gegenbuchung: Ersteller der Ausgabe');
  assert.deepEqual(authors('settlement', SETTLEMENT), [PAY.id, PAY.id], 'Buchung einer Zahlung bleibt bei ihrem Autor');
  assert.deepEqual(authors('settlement_reversal', SETTLEMENT), [PAY.id, PAY.id], 'Gegenbuchung: Autor der Buchung');
  assert.deepEqual(authors('expense', UNTOUCHED), [AUT.id, AUT.id, AUT.id]);
  assert.deepEqual(authors('expense', ORPHAN_EXPENSE), [ED.id], 'Waise ohne Ausgabe bleibt');
  assert.deepEqual(authors('settlement_reversal', ORPHAN_SETTLEMENT), [ED.id], 'Waise ohne Buchung bleibt');
});

test('zweiter Lauf aendert nichts', () => {
  const before = snapshot();
  const changesBefore = db.prepare('SELECT total_changes() AS n').get().n;
  db.exec(migration225.up);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changesBefore, 'keine Zeile beruehrt');
  assert.deepEqual(snapshot(), before);
});

test('danach laesst das Loeschen des Bearbeiters die Salden unveraendert', async () => {
  const del = await adminCall('DELETE', `/auth/users/${ED.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(await balances(), BALANCES, 'Ausgabe zaehlt weiter, Storno bleibt');
  assert.equal(db.prepare('SELECT status FROM expenses WHERE id = ?').get(EXPENSE).status, 'active');
  assert.equal(authors('settlement_reversal', SETTLEMENT).length, 2);
});
