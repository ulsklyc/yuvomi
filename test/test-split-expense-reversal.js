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
  assert.ok(reversed.every((row) => row.created_by === CR.id));

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
  // Max loescht, Olivia hat angelegt: die Gegenbuchung traegt Olivia.
  assert.ok(ledger(E2, 'expense_reversal').every((row) => row.currency === 'EUR' && row.created_by === OWN.id));
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
  assert.deepEqual(deleted.metadata, { title: 'Einkauf', amount_minor: 3000, currency: 'EUR', amount: '30.00' });
  const deletedFx = items.find((a) => a.type === 'expense_deleted' && a.entity_id === E2);
  // Der Betrag, unter dem die Ausgabe in der Liste stand: der eingegebene, in
  // seiner Waehrung - nicht der umgerechnete, den das Ledger fuehrt.
  assert.deepEqual(deletedFx.metadata, { title: 'Mietwagen', amount_minor: 2000, currency: 'USD', amount: '20.00' });

  const created = items.find((a) => a.type === 'expense_created' && a.entity_id === E1);
  assert.deepEqual(Object.keys(created.expense), ['id', 'deleted_at']);
  assert.equal(created.expense.id, E1);
  assert.match(created.expense.deleted_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(created.metadata, { title: 'Einkauf', amount_minor: 3000, currency: 'EUR', amount: '30.00' });

  const active = items.find((a) => a.type === 'expense_created' && a.entity_id === E3);
  assert.deepEqual({ ...active.expense }, { id: E3, deleted_at: null });
});

// Buchung und Gegenbuchung haengen per `created_by ON DELETE CASCADE` an einem
// Konto. Trug die Gegenbuchung die LOESCHENDE Person, riss das Loeschen eines
// Kontos das Paar auseinander - in beide Richtungen: mit dem Konto der
// loeschenden Person verschwand nur die Gegenbuchung, und die geloeschte
// Ausgabe zaehlte still wieder im Saldo; mit dem Konto der anlegenden Person
// verschwanden Ausgabe und Buchung, und die Gegenbuchung blieb als Waise ohne
// Ausgabe stehen (die Klasse, die Migration v227 einmal entfernt hat). Die
// Gegenbuchung traegt deshalb den `created_by` ihrer Originalzeile, wie das
// Storno einer Zahlung; wer geloescht hat, steht in `expense_activity.actor_id`
// (expense_deleted).
//
// Seit #1381 erreicht `DELETE /auth/users/:id` diese Kaskade nicht mehr: beide
// Konten haben eine Spur (Verlauf bzw. Ausgabe) und werden DEAKTIVIERT. Die
// ersten beiden Tests halten das am echten Weg fest - nichts faellt, nichts
// verwaist, kein Saldo bewegt sich. Die Kaskade selbst steht weiter im Schema
// (Bestandsdatenbanken, jeder direkte Zugriff); der dritte Test faehrt sie auf
// Datenbankebene und haelt die Autor-Regel dort fest, wo sie noch traegt.
const ledgerTotal = () => db.prepare('SELECT COUNT(*) AS n FROM expense_ledger_entries').get().n;
const deactivatedAt = (id) => db.prepare('SELECT deactivated_at FROM users WHERE id = ?').get(id)?.deactivated_at;

test('Konto der LOESCHENDEN Person entfernt: deaktiviert, die Ausgabe bleibt aufgehoben, Salden bleiben', async () => {
  const A2 = await member('author2', 'Anna');
  const M2 = await member('manager2', 'Mara');
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: A2.id, role: 'guest' })).status, 201);
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: M2.id, role: 'admin' })).status, 201);
  const base = await balances();
  const eid = await addExpense(A2, { title: 'Getraenke', amount: '8.00', currency: 'EUR', payer_id: OWN.id, participants: [OWN.id, OTH.id] });
  assert.notDeepEqual(await balances(), base, 'die Ausgabe zaehlt, solange sie aktiv ist');
  assert.equal((await del(M2, eid)).status, 200);
  assert.deepEqual(await balances(), base);

  const eintrag = () => db.prepare("SELECT actor_id FROM expense_activity WHERE type = 'expense_deleted' AND entity_type = 'expense' AND entity_id = ?").get(eid);
  assert.equal(eintrag().actor_id, M2.id, 'wer geloescht hat, steht im Verlauf');

  const rows = ledgerTotal();
  const gone = await adminCall('DELETE', `/auth/users/${M2.id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.outcome, 'deactivated', 'Mara steht im Verlauf - das ist eine Spur');
  assert.ok(deactivatedAt(M2.id), 'das Konto steht noch, deaktiviert');
  assert.equal(ledgerTotal(), rows, 'keine Ledger-Zeile verschwindet');
  assert.equal(eintrag().actor_id, M2.id, 'der Verlauf nennt sie weiter');
  assert.deepEqual(await balances(), base, 'die geloeschte Ausgabe zaehlt nicht wieder');
  const booked = ledger(eid, 'expense');
  const reversed = ledger(eid, 'expense_reversal');
  assert.equal(booked.length, 3);
  assert.deepEqual(shape(reversed), mirror(booked), 'die Gegenbuchung steht noch');
  assert.ok(booked.every((row) => row.created_by === A2.id));
  assert.deepEqual(reversed.map((row) => row.created_by), booked.map((row) => row.created_by), 'Gegenbuchung traegt den Autor der Originalzeile');
});

// BIS #1381 STAND HIER DAS GEGENTEIL: das Konto liess sich loeschen, und
// Ausgabe, Buchung und Gegenbuchung fielen per CASCADE gemeinsam. Jetzt ist die
// Ausgabe eine Spur, das Konto wird deaktiviert, und alles bleibt stehen.
test('Konto der ANLEGENDEN Person entfernt: deaktiviert, Ausgabe, Buchung und Gegenbuchung bleiben', async () => {
  const A3 = await member('author3', 'Arne');
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: A3.id, role: 'guest' })).status, 201);
  const base = await balances();
  const eid = await addExpense(A3, { title: 'Pizza', amount: '6.00', currency: 'EUR', payer_id: OWN.id, participants: [OWN.id, OTH.id] });
  assert.equal((await del(MGR, eid)).status, 200);
  assert.deepEqual(await balances(), base);
  const booked = ledger(eid, 'expense');
  const reversed = ledger(eid, 'expense_reversal');
  assert.equal(booked.length, 3);

  // Arne nimmt an keiner Buchung teil; die Ausgabe haengt per
  // `expenses.created_by` CASCADE an ihm. Genau deshalb ist sie eine Spur.
  const rows = ledgerTotal();
  const gone = await adminCall('DELETE', `/auth/users/${A3.id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.outcome, 'deactivated');
  assert.ok(deactivatedAt(A3.id));
  assert.equal(ledgerTotal(), rows, 'keine Ledger-Zeile verschwindet');
  assert.equal(db.prepare('SELECT status FROM expenses WHERE id = ?').get(eid)?.status, 'deleted', 'die Ausgabe bleibt, als geloescht');
  assert.deepEqual(ledger(eid, 'expense'), booked, 'die Buchung bleibt');
  assert.deepEqual(ledger(eid, 'expense_reversal'), reversed, 'die Gegenbuchung bleibt');
  assert.deepEqual(shape(reversed), mirror(booked));
  assert.deepEqual(await balances(), base, 'Salden unveraendert');
});

// Die Kaskade selbst, an der Route vorbei. Die Konten nehmen an keiner Buchung
// teil - sonst hielte `user_id ON DELETE RESTRICT` das Loeschen auf.
test('Kaskade auf Datenbankebene: Buchung und Gegenbuchung haengen am selben Konto und fallen nur gemeinsam', async () => {
  const A4 = await member('author4', 'Asta');
  const M4 = await member('manager4', 'Mio');
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: A4.id, role: 'guest' })).status, 201);
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: M4.id, role: 'admin' })).status, 201);
  const base = await balances();
  const eid = await addExpense(A4, { title: 'Eis', amount: '6.00', currency: 'EUR', payer_id: OWN.id, participants: [OWN.id, OTH.id] });
  assert.equal((await del(M4, eid)).status, 200);
  assert.deepEqual(await balances(), base);

  // Loeschende Person: nichts im Ledger haengt an ihr.
  const rows = ledgerTotal();
  assert.equal(db.prepare('DELETE FROM users WHERE id = ?').run(M4.id).changes, 1);
  assert.equal(ledgerTotal(), rows, 'die Gegenbuchung faellt nicht mit der loeschenden Person');
  assert.deepEqual(await balances(), base, 'die geloeschte Ausgabe zaehlt nicht wieder');

  // Anlegende Person: Ausgabe, Buchung und Gegenbuchung gehen zusammen.
  assert.equal(db.prepare('DELETE FROM users WHERE id = ?').run(A4.id).changes, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE id = ?').get(eid).n, 0);
  assert.equal(ledger(eid, 'expense').length, 0);
  assert.equal(ledger(eid, 'expense_reversal').length, 0, 'keine Gegenbuchung ohne ihre Buchung');
  assert.equal(ledgerTotal(), rows - 6);
  assert.deepEqual(await balances(), base, 'Salden wie vor der Ausgabe');
});

// Zusammenspiel mit #1381: ein deaktiviertes Konto bleibt in Buchungen und
// Salden stehen. Eine Ausgabe, die es angelegt hat und an der ein weiteres
// deaktiviertes Konto beteiligt ist (als Zahler und mit einem Anteil), muss
// sich von einem aktiven Mitglied weiter loeschen lassen - mit vollstaendiger
// Gegenbuchung, auch fuer die Zeilen der Ehemaligen.
test('Ausgabe mit deaktivierten Konten (angelegt von / beteiligt): aktives Mitglied loescht, Gegenbuchung vollstaendig', async () => {
  const A5 = await member('author5', 'Alma');
  const P5 = await member('payer5', 'Paul');
  for (const u of [A5, P5]) {
    assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: u.id, role: 'guest' })).status, 201);
  }
  const base = await balances();
  assert.equal(base[`${P5.id}:EUR`], undefined, 'Fixture: Paul hat vorher keinen Saldo');
  // 9.00 EUR, Alma traegt ein, Paul hat bezahlt, Paul + Olivia + Otto.
  const eid = await addExpense(A5, { title: 'Blumen', amount: '9.00', currency: 'EUR', payer_id: P5.id, participants: [P5.id, OWN.id, OTH.id] });
  const withExpense = await balances();
  assert.equal(withExpense[`${P5.id}:EUR`], 600, 'Fixture: Paul bekommt 6.00');
  assert.equal(withExpense[`${OWN.id}:EUR`], base[`${OWN.id}:EUR`] - 300);

  for (const u of [A5, P5]) {
    const gone = await adminCall('DELETE', `/auth/users/${u.id}`);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.outcome, 'deactivated');
    assert.ok(deactivatedAt(u.id));
  }
  assert.deepEqual(await balances(), withExpense, 'Deaktivieren bewegt keinen Saldo, Paul steht weiter darin');
  assert.equal((await del(P5, eid)).status, 401, 'der Ehemalige selbst kommt nicht mehr herein');
  assert.equal((await del(OTH, eid)).status, 403, 'die Rechte sind dieselben geblieben');

  const booked = ledger(eid, 'expense');
  assert.equal(booked.length, 4, 'Zahler + drei Anteile');
  assert.equal((await del(MGR, eid)).status, 200);
  const reversed = ledger(eid, 'expense_reversal');
  assert.deepEqual(ledger(eid, 'expense'), booked, 'die Buchung bleibt');
  assert.deepEqual(shape(reversed), mirror(booked), 'jede Zeile aufgehoben, auch die des Ehemaligen');
  assert.ok(reversed.some((row) => row.user_id === P5.id), 'Fixture: die Gegenbuchung fasst Pauls Zeilen an');
  assert.ok(reversed.every((row) => row.created_by === A5.id), 'Autor bleibt die (deaktivierte) anlegende Person');
  const after = await balances();
  assert.equal(after[`${P5.id}:EUR`] ?? 0, 0, 'Pauls Guthaben ist wieder heraus');
  assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([, v]) => v !== 0)), Object.fromEntries(Object.entries(base).filter(([, v]) => v !== 0)), 'Salden der anderen wie ohne die Ausgabe');
  assert.equal(db.prepare("SELECT actor_id FROM expense_activity WHERE type = 'expense_deleted' AND entity_id = ?").get(eid).actor_id, MGR.id);
  assert.equal((await del(MGR, eid)).status, 404, 'zweites Loeschen bucht nichts');
  assert.equal(ledger(eid, 'expense_reversal').length, 4);
  assert.ok(deactivatedAt(A5.id) && deactivatedAt(P5.id), 'beide bleiben deaktiviert');
});

// 10.00 durch drei laesst einen Rest-Cent bei einer Person. Die Gegenbuchung
// spiegelt die gebuchten Zeilen und rechnet nicht neu - der Cent kommt bei
// genau der Person wieder heraus, bei der er gelandet ist.
test('Rest-Cent: die Gegenbuchung hebt jede Zeile genau auf', async () => {
  const base = await balances();
  const eid = await addExpense(OWN, { title: 'Taxi', amount: '10.00', currency: 'EUR', payer_id: OWN.id, participants: [OWN.id, MGR.id, OTH.id] });
  const booked = ledger(eid, 'expense');
  assert.deepEqual(booked.filter((row) => row.counterparty_id != null).map((row) => -row.amount_minor).sort(), [333, 333, 334], 'Fixture: ein Anteil traegt den Rest-Cent');
  assert.equal((await del(OWN, eid)).status, 200);
  assert.deepEqual(shape(ledger(eid, 'expense_reversal')), mirror(booked));
  assert.deepEqual(await balances(), base);
});

// Bearbeiten schreibt die Zeilen einer Ausgabe neu. Die Gegenbuchung spiegelt
// den Stand NACH der Bearbeitung, und sie traegt weiter die anlegende Person -
// nicht die, die bearbeitet, und nicht die, die loescht.
test('erst bearbeitet, dann geloescht: aufgehoben wird der bearbeitete Stand', async () => {
  const base = await balances();
  const eid = await addExpense(CR, { title: 'Kino', amount: '8.00', currency: 'EUR', payer_id: OWN.id, participants: [OWN.id, OTH.id] });
  const edited = await MGR.call('PUT', `/split-expenses/expenses/${eid}`, {
    title: 'Kino', amount: '12.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
    participants: [OWN.id, OTH.id, MGR.id], expense_date: '2026-09-01',
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const booked = ledger(eid, 'expense');
  assert.equal(booked.length, 4, 'Zahler + drei Anteile nach der Bearbeitung');
  assert.equal(booked[0].amount_minor, 1200);
  assert.equal((await del(OWN, eid)).status, 200);
  const reversed = ledger(eid, 'expense_reversal');
  assert.deepEqual(shape(reversed), mirror(booked));
  assert.ok(reversed.every((row) => row.created_by === CR.id), 'Autor ist die anlegende Person');
  assert.deepEqual(await balances(), base);
});
