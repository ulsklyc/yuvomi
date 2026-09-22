/**
 * Test: Storno einer Zahlung in den geteilten Ausgaben (#1309)
 * Zweck: Eine eingetragene Zahlung liess sich weder aendern noch entfernen. Die
 *        Entscheidung: STORNIEREN statt loeschen - eine Gegenbuchung
 *        (`settlement_reversal`) je Ledger-Zeile, die Zahlung selbst bleibt samt
 *        `settlement_entries` und Nachweis stehen.
 *
 *        Gemessen wird ueber den ECHTEN Server (test/server-ready.js), nicht
 *        ueber den eingehaengten Router: das Modul-Gate (`budget: read`) und die
 *        Token-Scopes sitzen in server/index.js, und eine Suite am nackten Router
 *        saehe sie nie.
 *
 *        Die zentrale Zusicherung ist der SALDO nach dem Storno, nicht die
 *        Existenz der Route - eine Version, die nur den Aktivitaetseintrag
 *        schreibt und das Ledger vergisst, muss hier rot werden.
 *
 *        Jede Ablehnung prueft auch ihren GRUND (Fehlertext): das Mitglied mit
 *        `budget: read` ist Gruppenverwalter, die Gruppenregel liesse es also
 *        durch - ein 403 von dort waere ein Nein aus dem falschen Grund.
 * Ausfuehren: npm run test:split-settlement-reversal
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'split-settlement-reversal',
  env: { SESSION_SECRET: 'test-split-settlement-reversal-secret-32c', RATE_LIMIT_MAX_ATTEMPTS: '50' },
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
  const headers = session.token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }
    : { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
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

// Owner legt an, MGR verwaltet mit, CR traegt Zahlungen ein, OTH ist einfaches
// Mitglied, RD verwaltet die Gruppe mit - hat aber nur `budget: read`.
const OWN = await member('owner', 'Olivia');
const MGR = await member('manager', 'Max');
const CR = await member('creator', 'Clara');
const OTH = await member('other', 'Otto');
const RD = await member('reader', 'Rita');

const perm = await adminCall('PUT', `/permissions/user/${RD.id}`, { modules: { budget: 'read' } });
assert.equal(perm.status, 200, 'budget: read fuer RD');

const group = await OWN.call('POST', '/split-expenses/groups', { name: 'WG-Kasse', type: 'household', default_currency: 'EUR' });
assert.equal(group.status, 201);
const GROUP = group.body.data.id;
for (const [u, role] of [[MGR, 'admin'], [CR, 'guest'], [OTH, 'guest']]) {
  const r = await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: u.id, role });
  assert.equal(r.status, 201);
}
// RD ist Verwalter der Gruppe - die Gruppenregel liesse ihn stornieren, nur das
// Modulrecht haelt ihn auf.
assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: RD.id, role: 'admin' })).status, 201);

// 30.00, von Olivia bezahlt, zu dritt geteilt: Olivia +20, Clara -10, Otto -10.
const expense = await OWN.call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
  title: 'Einkauf', amount: '30.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
  participants: [OWN.id, CR.id, OTH.id], expense_date: '2026-09-01',
});
assert.equal(expense.status, 201);

async function balances(viewer = OWN) {
  const r = await viewer.call('GET', `/split-expenses/groups/${GROUP}/balances`);
  assert.equal(r.status, 200);
  return Object.fromEntries(r.body.data.balances.map((b) => [b.user_id, b.net_minor]));
}
const BEFORE_PAYMENT = { [OWN.id]: 2000, [CR.id]: -1000, [OTH.id]: -1000 };

// Nachweis: ein Dokument, das Clara sehen darf (sie hat es angelegt).
const proofDoc = Number(db.prepare(`
  INSERT INTO family_documents (name, original_name, mime_type, file_size, content_data, created_by)
  VALUES ('Beleg', 'beleg.pdf', 'application/pdf', 10, x'255044', ?)
`).run(CR.id).lastInsertRowid);

async function registerPayment(by, amount = '10.00', extra = {}) {
  const r = await by.call('POST', `/split-expenses/groups/${GROUP}/settlements`, {
    payer_id: CR.id, payee_id: OWN.id, amount, currency: 'EUR', ...extra,
  });
  assert.equal(r.status, 201);
  return r.body.data.id;
}
const reverse = (who, sid, gid = GROUP) => who.call('POST', `/split-expenses/groups/${gid}/settlements/${sid}/reverse`);
const ledger = (sid, type) => db.prepare(
  'SELECT user_id, counterparty_id, amount_minor, currency, created_by FROM expense_ledger_entries WHERE source_type = ? AND source_id = ? ORDER BY id',
).all(type, sid);

let S1;
test('Ausgangslage: Claras Zahlung von 10.00 an Olivia gleicht Clara aus', async () => {
  assert.deepEqual(await balances(), BEFORE_PAYMENT);
  S1 = await registerPayment(CR, '10.00', { proof_document_id: proofDoc });
  assert.deepEqual(await balances(), { [OWN.id]: 1000, [OTH.id]: -1000 }, 'Clara ausgeglichen, Olivia +10');
});

test('anderes Mitglied (weder Verwalter noch Ersteller) -> 403, Salden unveraendert', async () => {
  const r = await reverse(OTH, S1);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Not authorized.');
  assert.deepEqual(await balances(), { [OWN.id]: 1000, [OTH.id]: -1000 });
  assert.equal(ledger(S1, 'settlement_reversal').length, 0);
});

test('Verwalter mit budget: read -> 403 am Modul-Gate, nicht an der Gruppenregel', async () => {
  const r = await reverse(RD, S1);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'You have read-only access to this module.');
  assert.equal(ledger(S1, 'settlement_reversal').length, 0);
});

test('Token mit Scope budget:read -> 403 am Scope-Gate', async () => {
  const created = await adminCall('POST', '/auth/api-tokens', { name: 'nur lesen', subject_user_id: MGR.id, scopes: ['budget:read'] });
  assert.equal(created.status, 201);
  const tokenCall = as({ token: created.body.token });
  const read = await tokenCall('GET', `/split-expenses/groups/${GROUP}/balances`);
  assert.equal(read.status, 200, 'der Scope liest - die Sperre gilt nur dem Schreiben');
  const r = await tokenCall('POST', `/split-expenses/groups/${GROUP}/settlements/${S1}/reverse`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Token scope does not permit this operation.');
  assert.equal(ledger(S1, 'settlement_reversal').length, 0);
});

test('Ersteller storniert: Salden zurueck auf den Stand vor der Zahlung, Gegenbuchung im Ledger', async () => {
  const settlementsBefore = db.prepare('SELECT COUNT(*) AS n FROM settlements').get().n;
  const r = await reverse(CR, S1);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.id, S1);
  assert.equal(r.body.data.reversed_by, CR.id);
  assert.match(r.body.data.reversed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r.body.data.amount, '10.00');

  assert.deepEqual(await balances(), BEFORE_PAYMENT, 'Salden wie vor der Zahlung');

  // Die Gegenbuchung ist das genaue Negativ der Buchung, Zeile fuer Zeile.
  const booked = ledger(S1, 'settlement');
  const reversed = ledger(S1, 'settlement_reversal');
  assert.equal(booked.length, 2, 'die urspruengliche Buchung bleibt stehen');
  assert.deepEqual(
    reversed.map(({ user_id, counterparty_id, amount_minor, currency }) => ({ user_id, counterparty_id, amount_minor, currency })),
    booked.map(({ user_id, counterparty_id, amount_minor, currency }) => ({ user_id, counterparty_id, amount_minor: -amount_minor, currency })),
  );
  assert.ok(reversed.every((row) => row.created_by === CR.id));

  // Nichts geloescht: Zahlung, Eintrag und Nachweis bleiben. Ein Storno ist
  // selbst keine Zahlung - es gibt nichts, das man seinerseits stornieren koennte.
  const row = db.prepare('SELECT status, deleted_at, proof_document_id FROM settlements WHERE id = ?').get(S1);
  assert.deepEqual({ ...row }, { status: 'active', deleted_at: null, proof_document_id: proofDoc });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settlement_entries WHERE settlement_id = ?').get(S1).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settlements').get().n, settlementsBefore, 'kein neuer Zahlungsdatensatz');
});

test('zweites Storno -> 409, keine zweite Gegenbuchung, Salden unveraendert', async () => {
  const r = await reverse(OWN, S1);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Settlement is already reversed.');
  assert.equal(ledger(S1, 'settlement_reversal').length, 2);
  assert.deepEqual(await balances(), BEFORE_PAYMENT);
});

test('Verwalter storniert eine fremde Zahlung', async () => {
  const s2 = await registerPayment(CR, '4.00');
  assert.deepEqual(await balances(), { [OWN.id]: 1600, [CR.id]: -600, [OTH.id]: -1000 });
  const r = await reverse(MGR, s2);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reversed_by, MGR.id);
  assert.deepEqual(await balances(), BEFORE_PAYMENT);
});

test('Zahlung aus einer anderen Gruppe oder unbekannte ID -> 404', async () => {
  const other = await OWN.call('POST', '/split-expenses/groups', { name: 'Reise', type: 'travel', default_currency: 'EUR' });
  assert.equal(other.status, 201);
  const wrongGroup = await reverse(OWN, S1, other.body.data.id);
  assert.equal(wrongGroup.status, 404);
  assert.equal(wrongGroup.body.error, 'Settlement not found.');
  const unknown = await reverse(OWN, 999999);
  assert.equal(unknown.status, 404);
});

test('Zahlung ohne Ledger-Buchung -> 409 statt eines Stornos, das nichts aufhebt', async () => {
  const s = await registerPayment(CR, '1.00');
  db.prepare("DELETE FROM expense_ledger_entries WHERE source_type = 'settlement' AND source_id = ?").run(s);
  const r = await reverse(CR, s);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Settlement has no ledger entries to reverse.');
  assert.equal(ledger(s, 'settlement_reversal').length, 0);
});

test('Verlauf: Zahlung traegt ihren Stand, can_reverse folgt der Regel je Betrachter', async () => {
  const s3 = await registerPayment(CR, '2.50');
  const view = async (who) => {
    const r = await who.call('GET', `/split-expenses/groups/${GROUP}/activity?limit=100`);
    assert.equal(r.status, 200);
    return r.body.data;
  };
  const fuer = async (who, sid) => (await view(who)).find((a) => a.type === 'payment_registered' && a.entity_id === sid)?.settlement;

  const offen = await fuer(CR, s3);
  assert.deepEqual(
    { ...offen },
    { id: s3, payer_id: CR.id, payer_name: 'Clara', payee_id: OWN.id, payee_name: 'Olivia', amount_minor: 250, amount: '2.50', currency: 'EUR', reversed_at: null, can_reverse: true },
  );
  assert.equal((await fuer(OTH, s3)).can_reverse, false, 'fremdes Mitglied');
  assert.equal((await fuer(MGR, s3)).can_reverse, true, 'Verwalter');

  const storniert = await fuer(OWN, S1);
  assert.match(storniert.reversed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(storniert.can_reverse, false, 'storniert ist storniert, auch fuer den Verwalter');

  const eintrag = (await view(OWN)).find((a) => a.type === 'payment_reversed' && a.entity_id === S1);
  assert.ok(eintrag, 'payment_reversed im Verlauf');
  assert.equal(eintrag.actor_id, CR.id);
  assert.deepEqual(eintrag.metadata, { amount: '10.00', currency: 'EUR' });
});

// Beide Haelften eines Paares - Buchung und Gegenbuchung - haengen per
// `created_by ON DELETE CASCADE` an einem Konto. Trug die Gegenbuchung die
// STORNIERENDE Person, riss das Loeschen eines Kontos das Paar auseinander:
// nur eine Haelfte verschwand, und der Saldo stimmte nicht mehr. Die
// Gegenbuchung traegt deshalb den `created_by` ihrer Originalzeile; wer
// storniert hat, steht in `expense_activity.actor_id` (payment_reversed).
async function reversedAt(sid) {
  const r = await OWN.call('GET', `/split-expenses/groups/${GROUP}/activity?limit=100`);
  assert.equal(r.status, 200);
  return r.body.data.find((a) => a.type === 'payment_registered' && a.entity_id === sid)?.settlement?.reversed_at;
}

test('Konto der STORNIERENDEN Person geloescht: Zahlung bleibt storniert, Salden bleiben', async () => {
  const M2 = await member('manager2', 'Mara');
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: M2.id, role: 'admin' })).status, 201);
  const base = await balances();
  const s = await registerPayment(CR, '3.00');
  const r = await reverse(M2, s);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reversed_by, M2.id, 'reversed_by nennt weiter, wer storniert hat');
  assert.deepEqual(await balances(), base);

  const eintrag = db.prepare("SELECT actor_id FROM expense_activity WHERE type = 'payment_reversed' AND entity_type = 'settlement' AND entity_id = ?").get(s);
  assert.equal(eintrag.actor_id, M2.id, 'wer storniert hat, steht im Verlauf');

  const del = await adminCall('DELETE', `/auth/users/${M2.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(await balances(), base, 'die stornierte Zahlung zaehlt nicht wieder');
  assert.match(String(await reversedAt(s)), /^\d{4}-\d{2}-\d{2}T/, 'bleibt storniert');
  const again = await reverse(OWN, s);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'Settlement is already reversed.');

  const booked = ledger(s, 'settlement');
  const reversed = ledger(s, 'settlement_reversal');
  assert.equal(reversed.length, 2);
  assert.ok(booked.every((row) => row.created_by === CR.id));
  assert.deepEqual(reversed.map((row) => row.created_by), booked.map((row) => row.created_by), 'Gegenbuchung traegt den Autor der Originalzeile');
});

test('Konto der ERFASSENDEN Person geloescht: Buchung und Gegenbuchung fallen gemeinsam', async () => {
  const RC = await member('recorder', 'Rolf');
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: RC.id, role: 'guest' })).status, 201);
  const base = await balances();
  const s = await registerPayment(RC, '2.00');
  assert.equal((await reverse(MGR, s)).status, 200);
  assert.deepEqual(await balances(), base);

  // Rolf ist weder Zahler noch Empfaenger - kein RESTRICT haelt das Loeschen
  // auf. Die Zahlung selbst haengt per `settlements.created_by` CASCADE an ihm.
  const del = await adminCall('DELETE', `/auth/users/${RC.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(await balances(), base, 'Salden wie vor der Zahlung');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settlements WHERE id = ?').get(s).n, 0);
  assert.equal(ledger(s, 'settlement').length, 0);
  assert.equal(ledger(s, 'settlement_reversal').length, 0, 'keine Gegenbuchung ohne Partner');
});

// Dieselbe Klasse an einer Ausgabe: das Bearbeiten schreibt ihre Ledger-Zeilen
// neu. Trugen die neuen Zeilen die BEARBEITENDE Person, verschwanden sie mit
// deren Konto, waehrend die Ausgabe (`expenses.created_by` = Ersteller) aktiv
// stehen blieb und nicht mehr in den Salden zaehlte. Die Zeilen tragen immer
// `expenses.created_by`; wer bearbeitet hat, steht in `expense_edited`.
test('Konto der BEARBEITENDEN Person geloescht: die Ausgabe zaehlt weiter in den Salden', async () => {
  const R3 = await member('author3', 'Anna');
  const M3 = await member('manager3', 'Mika');
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: R3.id, role: 'guest' })).status, 201);
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: M3.id, role: 'admin' })).status, 201);
  const base = await balances();
  const created = await R3.call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
    title: 'Getraenke', amount: '8.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
    participants: [OWN.id, OTH.id], expense_date: '2026-09-02',
  });
  assert.equal(created.status, 201);
  const eid = created.body.data.id;
  const edited = await M3.call('PUT', `/split-expenses/expenses/${eid}`, {
    title: 'Getraenke', amount: '12.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
    participants: [OWN.id, OTH.id], expense_date: '2026-09-02',
  });
  assert.equal(edited.status, 200);
  const afterEdit = await balances();
  assert.deepEqual(afterEdit, { ...base, [OWN.id]: base[OWN.id] + 600, [OTH.id]: base[OTH.id] - 600 });
  const eintrag = db.prepare("SELECT actor_id FROM expense_activity WHERE type = 'expense_edited' AND entity_type = 'expense' AND entity_id = ? ORDER BY id DESC").get(eid);
  assert.equal(eintrag.actor_id, M3.id, 'wer bearbeitet hat, steht im Verlauf');

  const del = await adminCall('DELETE', `/auth/users/${M3.id}`);
  assert.equal(del.status, 200);
  assert.equal(db.prepare('SELECT status FROM expenses WHERE id = ?').get(eid).status, 'active');
  assert.deepEqual(await balances(), afterEdit, 'die Ausgabe zaehlt weiter');
  const rows = ledger(eid, 'expense');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.created_by === R3.id), 'Ledger-Zeilen tragen den Ersteller der Ausgabe');
});
