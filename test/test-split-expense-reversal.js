/**
 * Test: Loeschen einer geteilten Ausgabe bucht eine Gegenbuchung (#1382)
 * Zweck: Das Loeschen einer Ausgabe entfernte ihre Ledger-Zeilen. Der Saldo
 *        aenderte sich, und nichts im Ledger sagte mehr, warum. Jetzt entsteht
 *        je `expense`-Zeile ihr genaues Negativ als `expense_reversal` (gleiche
 *        `source_id`), die Buchung selbst bleibt stehen - dieselbe Form wie das
 *        Storno einer Zahlung (#1309, test:split-settlement-reversal).
 *
 *        Gemessen wird ueber den ECHTEN Server (test/server-ready.js): das
 *        Modul-Gate (`budget: read`) sitzt in server/index.js.
 *
 *        Die zentrale Zusicherung ist der SALDO: nach dem Loeschen steht er
 *        genau dort, wo er ohne die Ausgabe stuende. Daneben das Ledger Zeile
 *        fuer Zeile - eine Version, die weiter loescht, haette denselben Saldo
 *        und muss trotzdem rot werden.
 *
 *        Drei Randfaelle aus dem Auftrag:
 *        - eine Ausgabe, die schon in einem Ausgleich steckt: der Ausgleich ist
 *          nicht an Ausgaben gebunden, er bleibt stehen, und die Salden zeigen
 *          danach, dass er ohne die Ausgabe zu viel war;
 *        - Fremdwaehrung: gebucht wird in `converted_currency`, und die
 *          Gegenbuchung spiegelt die GEBUCHTEN Zeilen, statt aus dem Kurs neu zu
 *          rechnen;
 *        - zweites Loeschen: 404, keine zweite Gegenbuchung.
 * Ausfuehren: npm run test:split-expense-reversal
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'split-expense-reversal',
  env: { SESSION_SECRET: 'test-split-expense-reversal-secret-32chars', RATE_LIMIT_MAX_ATTEMPTS: '50' },
});
const db = (await import('../server/db.js')).get();

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

// Owner legt an, MGR verwaltet mit, CR traegt Ausgaben ein, OTH ist einfaches
// Mitglied, RD verwaltet die Gruppe mit - hat aber nur `budget: read`.
const OWN = await member('owner', 'Olivia');
const MGR = await member('manager', 'Max');
const CR = await member('creator', 'Clara');
const OTH = await member('other', 'Otto');
const RD = await member('reader', 'Rita');

assert.equal((await adminCall('PUT', `/permissions/user/${RD.id}`, { modules: { budget: 'read' } })).status, 200);

const group = await OWN.call('POST', '/split-expenses/groups', { name: 'WG-Kasse', type: 'household', default_currency: 'EUR' });
assert.equal(group.status, 201);
const GROUP = group.body.data.id;
for (const [u, role] of [[MGR, 'admin'], [CR, 'guest'], [OTH, 'guest'], [RD, 'admin']]) {
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: u.id, role })).status, 201);
}

async function balances() {
  const r = await OWN.call('GET', `/split-expenses/groups/${GROUP}/balances`);
  assert.equal(r.status, 200);
  return Object.fromEntries(r.body.data.balances.map((b) => [`${b.user_id}:${b.currency}`, b.net_minor]));
}
const ledger = (id, type) => db.prepare(
  'SELECT user_id, counterparty_id, amount_minor, currency, memo, created_by FROM expense_ledger_entries WHERE source_type = ? AND source_id = ? ORDER BY id',
).all(type, id);
const mirror = (rows) => rows.map(({ user_id, counterparty_id, amount_minor, currency, memo }) => ({ user_id, counterparty_id, amount_minor: -amount_minor, currency, memo }));
const shape = (rows) => rows.map(({ user_id, counterparty_id, amount_minor, currency, memo }) => ({ user_id, counterparty_id, amount_minor, currency, memo }));
const del = (who, id) => who.call('DELETE', `/split-expenses/expenses/${id}`);

async function addExpense(by, body) {
  const r = await by.call('POST', `/split-expenses/groups/${GROUP}/expenses`, { expense_date: '2026-09-01', split_method: 'equal', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}

// E1: 30.00 EUR, Clara traegt ein, Olivia hat bezahlt, zu dritt geteilt:
// Olivia +20, Clara -10, Otto -10.
const E1 = await addExpense(CR, { title: 'Einkauf', amount: '30.00', currency: 'EUR', payer_id: OWN.id, participants: [OWN.id, CR.id, OTH.id] });
// Clara gleicht ihren Anteil aus - die Ausgabe steckt damit in einem Ausgleich.
const pay = await CR.call('POST', `/split-expenses/groups/${GROUP}/settlements`, { payer_id: CR.id, payee_id: OWN.id, amount: '10.00', currency: 'EUR' });
assert.equal(pay.status, 201);
const S1 = pay.body.data.id;
// E2: 20.00 USD, umgerechnet 18.00 EUR, Max bezahlt, Max + Otto: Max +9, Otto -9 (EUR).
const E2 = await addExpense(OWN, {
  title: 'Mietwagen', amount: '20.00', currency: 'USD', converted_amount: '18.00', converted_currency: 'EUR',
  payer_id: MGR.id, participants: [MGR.id, OTH.id],
});

const START = {
  [`${OWN.id}:EUR`]: 1000, [`${OTH.id}:EUR`]: -1900, [`${MGR.id}:EUR`]: 900,
};

test('Ausgangslage: Salden aus zwei Ausgaben und einem Ausgleich', async () => {
  assert.deepEqual(await balances(), START);
  assert.equal(ledger(E1, 'expense').length, 4, 'Zahler + drei Anteile');
  assert.equal(ledger(E2, 'expense').length, 3);
  assert.ok(ledger(E2, 'expense').every((row) => row.currency === 'EUR'), 'Fremdwaehrung bucht in converted_currency');
});

test('anderes Mitglied -> 403, nichts gebucht, Ausgabe aktiv', async () => {
  const r = await del(OTH, E1);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Not authorized.');
  assert.equal(ledger(E1, 'expense_reversal').length, 0);
  assert.equal(db.prepare('SELECT status FROM expenses WHERE id = ?').get(E1).status, 'active');
  assert.deepEqual(await balances(), START);
});

test('Verwalter mit budget: read -> 403 am Modul-Gate', async () => {
  const r = await del(RD, E1);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'You have read-only access to this module.');
  assert.equal(ledger(E1, 'expense_reversal').length, 0);
});

test('Ersteller loescht eine ausgeglichene Ausgabe: Gegenbuchung statt Loeschen, Ausgleich bleibt', async () => {
  const booked = ledger(E1, 'expense');
  const r = await del(CR, E1);
  assert.equal(r.status, 200);

  // Die Buchung bleibt stehen, daneben ihr genaues Negativ, Zeile fuer Zeile.
  assert.deepEqual(shape(ledger(E1, 'expense')), shape(booked), 'die urspruengliche Buchung bleibt');
  const reversed = ledger(E1, 'expense_reversal');
  assert.deepEqual(shape(reversed), mirror(booked));
  assert.ok(reversed.every((row) => row.created_by === CR.id), 'gebucht von der loeschenden Person');

  // Saldo = ohne E1: nur der Ausgleich (Clara +10, Olivia -10) und E2.
  assert.deepEqual(await balances(), {
    [`${OWN.id}:EUR`]: -1000, [`${CR.id}:EUR`]: 1000, [`${OTH.id}:EUR`]: -900, [`${MGR.id}:EUR`]: 900,
  });

  // Der Ausgleich ist nicht an die Ausgabe gebunden und bleibt unberuehrt.
  assert.equal(ledger(S1, 'settlement').length, 2);
  assert.equal(ledger(S1, 'settlement_reversal').length, 0);

  const row = db.prepare('SELECT status, deleted_at FROM expenses WHERE id = ?').get(E1);
  assert.equal(row.status, 'deleted');
  assert.match(row.deleted_at, /^\d{4}-\d{2}-\d{2}T/);
  const list = await OWN.call('GET', `/split-expenses/groups/${GROUP}/expenses`);
  assert.deepEqual(list.body.data.map((e) => e.id), [E2], 'aus der Ausgabenliste verschwunden');
});

test('zweites Loeschen -> 404, keine zweite Gegenbuchung', async () => {
  const r = await del(OWN, E1);
  assert.equal(r.status, 404);
  assert.equal(ledger(E1, 'expense_reversal').length, 4);
});

test('Verwalter loescht eine Fremdwaehrungs-Ausgabe: Gegenbuchung in der gebuchten Waehrung', async () => {
  const booked = ledger(E2, 'expense');
  // Der Kurs der Ausgabe aendert sich nachtraeglich im Datensatz - die
  // Gegenbuchung darf ihn nicht neu anwenden, sondern spiegelt die Buchung.
  db.prepare('UPDATE expenses SET converted_amount_minor = 1234 WHERE id = ?').run(E2);
  const r = await del(MGR, E2);
  assert.equal(r.status, 200);
  assert.deepEqual(shape(ledger(E2, 'expense_reversal')), mirror(booked));
  assert.ok(ledger(E2, 'expense_reversal').every((row) => row.currency === 'EUR' && row.created_by === MGR.id));
  // Uebrig bleibt allein der Ausgleich.
  assert.deepEqual(await balances(), { [`${OWN.id}:EUR`]: -1000, [`${CR.id}:EUR`]: 1000 });
});

test('Verlauf: expense_deleted nennt Titel und Betrag, die angelegte Ausgabe traegt ihren Stand', async () => {
  const E3 = await addExpense(OTH, { title: 'Brot', amount: '4.00', currency: 'EUR', payer_id: OTH.id, participants: [OTH.id, OWN.id] });
  const r = await OWN.call('GET', `/split-expenses/groups/${GROUP}/activity?limit=100`);
  assert.equal(r.status, 200);
  const items = r.body.data;

  const deleted = items.find((a) => a.type === 'expense_deleted' && a.entity_id === E1);
  assert.ok(deleted, 'expense_deleted im Verlauf');
  assert.equal(deleted.actor_id, CR.id);
  assert.deepEqual(deleted.metadata, { title: 'Einkauf', amount: '30.00', currency: 'EUR' });
  const deletedFx = items.find((a) => a.type === 'expense_deleted' && a.entity_id === E2);
  // Der Betrag, unter dem die Ausgabe in der Liste stand: der eingegebene, in
  // seiner Waehrung - nicht der umgerechnete, den das Ledger fuehrt.
  assert.deepEqual(deletedFx.metadata, { title: 'Mietwagen', amount: '20.00', currency: 'USD' });

  const created = items.find((a) => a.type === 'expense_created' && a.entity_id === E1);
  assert.equal(created.expense.id, E1);
  assert.equal(created.expense.title, 'Einkauf');
  assert.equal(created.expense.amount, '30.00');
  assert.equal(created.expense.currency, 'EUR');
  assert.match(created.expense.deleted_at, /^\d{4}-\d{2}-\d{2}T/);

  const active = items.find((a) => a.type === 'expense_created' && a.entity_id === E3);
  assert.deepEqual({ ...active.expense }, { id: E3, title: 'Brot', amount_minor: 400, amount: '4.00', currency: 'EUR', deleted_at: null });
});
