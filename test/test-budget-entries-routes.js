/**
 * Test: Budget-Eintrags-Routen (Härtung)
 * Zweck: End-to-End über den echten Budget-Router (server/routes/budget.js →
 *        routes/budget/entries.js) - die untertestete Eintrags-Schicht. Die
 *        Basis-CRUD deckt test-notes-contacts-budget.js ab, Scope/Sichtbarkeit
 *        test-budget-routes-scope.js; hier gezielt die offenen Blöcke:
 *          - GET /summary (Monatsaggregation + byCategory, 400)
 *          - GET /export (CSV, BOM, Formel-Injection-Schutz, resolveExportRange)
 *          - GET / (month-400, category-/account_id-Filter, loan_id-Drilldown)
 *          - POST / (subcategory-400, account-not-found-400, virtuelles Budget)
 *          - PUT /:id (404, subcategory-400, Konto setzen/entfernen, virtuelles
 *            Budget, Loan-Payment-Kopplung: Richtung setzt das Vorzeichen (#859),
 *            Rest-Grenze + Sync)
 *          - DELETE /:id (404, Loan-Payment-Cascade + refreshLoanStatus,
 *            Skip-Markierung bei Instanz-Löschung)
 *          - PUT /:id/series (404, not-recurring-400, Parent-Update, Sichtbarkeits-
 *            Propagation auf ALLE Instanzen, Konto der Serie inkl. Haushaltszone
 *            und Nicht-Rückwirkung, Neuaufbau NUR bei geändertem Rhythmus, 403)
 *          - DELETE /:id/series (404, not-recurring-400, Parent + Instanzen weg, 403)
 *
 *        Systemuhr: PUT /:id/series schneidet bei HEUTE in der Haushaltszone
 *        (todayKey(db), #829 - nicht der Serverzone, #973). Statt die Uhr zu
 *        fixieren werden Extremdaten genutzt: 2000-01 (immer < heute) und
 *        2099-12 (immer >= heute). Was hinter dem Schnitt liegt, wird seit
 *        v2.64.2 AKTUALISIERT statt gelöscht - gelöscht wird nur noch, wenn
 *        sich der Rhythmus ändert und die Termine deshalb anderswo liegen.
 *        Die zwei Tests, die die Zone selbst messen, rechnen mit der echten
 *        Uhr, weil nur die Lage "heute, aber je nach Zone anderer Tag" den
 *        Fehler trägt; sie überspringen sich im seltenen Fenster, in dem beide
 *        Zonen denselben Tag zeigen, statt ohne Messung grün zu sein.
 *        Die sicherheitskritische Sichtbarkeits-Propagation ist datumsunabhängig
 *        und wird separat geprüft.
 * Ausführen: node --experimental-sqlite --test test/test-budget-entries-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
const db = dbmod.get();

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;
const B = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')").run().lastInsertRowid;
const ADMIN = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run().lastInsertRowid;

function setMode(mode) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
}
setMode('shared'); // Default für die meisten Tests; 403-Tests schalten lokal auf personal.

let actor = { id: A, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.authRole = actor.role; req.session = { userId: actor.id }; next(); });
app.use('/', budgetRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());
// Modus deterministisch auf den shared-Default zurücksetzen, damit ein Fehlschlag in
// einem personal-Modus-Test den budget_mode nicht in Folgetests leakt.
test.afterEach(() => setMode('shared'));

async function call(method, route, { as = { id: A, role: 'member' }, body } = {}) {
  actor = as;
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  // arrayBuffer statt text(): res.text() strippt ein führendes BOM (U+FEFF) beim
  // WHATWG-Decode; für den CSV-BOM-Check muss der rohe Body erhalten bleiben.
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  let json = null;
  if (ct.includes('application/json')) { try { json = JSON.parse(text); } catch { /* leer */ } }
  return { status: res.status, body: json, text, contentType: ct, disposition: res.headers.get('content-disposition') || '' };
}

// Direkter Eintrags-Insert (umgeht die POST-Validierung für Fixtures).
function insertEntry(fields) {
  const f = {
    title: 'x', amount: -10, category: 'food', subcategory: '', date: '2030-01-10',
    is_recurring: 0, recurrence_rule: null, recurrence_interval: 'monthly',
    recurrence_virtual: 0, recurrence_full_amount: null, recurrence_parent_id: null,
    is_pending: 0,
    account_id: null, created_by: A, owner_id: A, visibility: 'shared', ...fields,
  };
  return db.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, subcategory, date, is_recurring, recurrence_rule,
       recurrence_interval, recurrence_virtual, recurrence_full_amount, recurrence_parent_id,
       is_pending, account_id, created_by, owner_id, visibility)
    VALUES (@title,@amount,@category,@subcategory,@date,@is_recurring,@recurrence_rule,
       @recurrence_interval,@recurrence_virtual,@recurrence_full_amount,@recurrence_parent_id,
       @is_pending,@account_id,@created_by,@owner_id,@visibility)
  `).run(f).lastInsertRowid;
}

// ── GET /summary ────────────────────────────────────────────────────────────────
test('GET /summary: ungültiger Monat → 400', async () => {
  const r = await call('GET', '/summary?month=2030-13-01');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /YYYY-MM/);
});

test('GET /summary: aggregiert income/expenses/balance + byCategory', async () => {
  insertEntry({ title: 'salary', amount: 100, category: 'food', date: '2030-03-05' });
  insertEntry({ title: 'lunch', amount: -30, category: 'food', date: '2030-03-06' });
  insertEntry({ title: 'gas', amount: -20, category: 'transport', date: '2030-03-07' });
  const r = await call('GET', '/summary?month=2030-03');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.income, 100);
  assert.equal(r.body.data.expenses, -50);
  assert.equal(r.body.data.balance, 50);
  // byCategory nach |Summe| absteigend: food (net 70) vor transport (net -20).
  assert.deepEqual(r.body.data.byCategory.map((c) => c.category), ['food', 'transport']);
  const food = r.body.data.byCategory.find((c) => c.category === 'food');
  assert.equal(food.income, 100);
  assert.equal(food.expenses, -30);
  assert.equal(food.total, 70);
});

// ── GET /export ─────────────────────────────────────────────────────────────────
test('GET /export: CSV mit BOM, Header und Zeilen (month-Range)', async () => {
  insertEntry({ title: 'Kaffee', amount: -4.5, category: 'food', date: '2031-02-10' });
  const r = await call('GET', '/export?month=2031-02');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/csv/);
  assert.match(r.disposition, /budget-2031-02\.csv/);
  assert.equal(r.text.charCodeAt(0), 0xFEFF, 'BOM (U+FEFF) vorangestellt');
  assert.match(r.text, /Date,Title,Amount,Category,Subcategory,Recurring,Status,Created by/);
  assert.match(r.text, /"Kaffee"/);
  // Punkt-Dezimal ohne Tausendertrennung (#521): in einem komma-getrennten CSV
  // wäre ein Komma-Dezimaltrenner ein zweites Feldtrennzeichen und würde die
  // Betragsspalte zerreißen. Die Datenzeile muss exakt 8 Felder behalten.
  assert.match(r.text, /-4\.50/, 'Betrag mit Dezimalpunkt');
  const dataLine = r.text.replace(/^﻿/, '').trim().split('\n')[1];
  assert.equal(dataLine.split(',').length, 8, 'Betrag erzeugt kein zusätzliches CSV-Feld');
  assert.match(dataLine, /,Booked,/, 'eine erfolgte Buchung ist als solche ausgewiesen (#637)');
});

test('GET /export: eine erwartete Buchung bleibt drin, aber gekennzeichnet', async () => {
  insertEntry({ title: 'Erwartet', amount: -12, category: 'food', date: '2031-03-10', is_pending: 1 });
  const r = await call('GET', '/export?month=2031-03');
  const dataLine = r.text.replace(/^﻿/, '').trim().split('\n')[1];
  assert.match(dataLine, /,Expected,/, 'im Beleg darf sie nicht wie eine erfolgte aussehen');
});

test('GET /export: schützt vor CSV-Formel-Injection (führendes =)', async () => {
  insertEntry({ title: '=SUM(A1:A9)', amount: -1, category: 'food', date: '2031-03-10' });
  const r = await call('GET', '/export?from=2031-03-01&to=2031-03-31');
  assert.equal(r.status, 200);
  assert.match(r.disposition, /budget-2031-03-01_2031-03-31\.csv/, 'from/to-Range im Dateinamen');
  assert.match(r.text, /"'=SUM\(A1:A9\)"/, 'gefährlicher Titel wird mit \' entschärft');
});

// ── GET / (Liste): Filter + Drilldown ────────────────────────────────────────────
test('GET /: ungültiger Monat ohne loan_id → 400', async () => {
  const r = await call('GET', '/?month=nope');
  assert.equal(r.status, 400);
});

test('GET /: category-Filter grenzt die Liste ein', async () => {
  insertEntry({ title: 'food-a', amount: -5, category: 'food', date: '2032-04-10' });
  insertEntry({ title: 'trans-a', amount: -5, category: 'transport', date: '2032-04-11' });
  const r = await call('GET', '/?month=2032-04&category=transport');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((e) => e.title), ['trans-a']);
});

test('GET /: account_id-Filter grenzt auf ein Konto ein', async () => {
  const acc = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Giro', ?)").run(A).lastInsertRowid;
  insertEntry({ title: 'with-acc', amount: -7, category: 'food', date: '2032-05-10', account_id: acc });
  insertEntry({ title: 'no-acc', amount: -7, category: 'food', date: '2032-05-11' });
  const r = await call('GET', `/?month=2032-05&account_id=${acc}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((e) => e.title), ['with-acc']);
});

test('GET /?loan_id=: Drilldown listet die verknüpften Zahlungs-Einträge', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('Auto','Bob',1000,10,'2032-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'rate-1', amount: 100, category: 'Sonstiges Einkommen', date: '2032-06-01' });
  db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2032-06-01',?,?)`).run(loan, eid, A);
  const r = await call('GET', `/?loan_id=${loan}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.some((e) => e.id === eid && e.loan_id === loan), 'verknüpfter Eintrag erscheint');
});

// ── POST / ───────────────────────────────────────────────────────────────────────
test('POST /: ungültige Subkategorie → 400', async () => {
  const r = await call('POST', '/', { body: { title: 'x', amount: -5, category: 'food', subcategory: 'does-not-exist', date: '2033-01-10' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /subcategory/i);
});

test('POST /: unbekanntes Konto → 400', async () => {
  const r = await call('POST', '/', { body: { title: 'x', amount: -5, category: 'food', date: '2033-01-11', account_id: 999999 } });
  assert.equal(r.status, 400);
  // Englisch wie jeder Satz des Servers - bis #1668 stand hier "Konto nicht gefunden.".
  assert.equal(r.body.error, 'Account not found.');
});

test('POST /: virtuelles Budget glättet den Jahresbetrag auf den Monatsanteil', async () => {
  const r = await call('POST', '/', {
    body: { title: 'Versicherung', amount: -1200, category: 'financial_other', date: '2033-02-01',
            is_recurring: true, recurrence_virtual: true, recurrence_interval: 'yearly' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.amount, -100, 'amount = -1200 / 12 Monate');
  assert.equal(r.body.data.recurrence_full_amount, -1200, 'voller Periodenbetrag bleibt erhalten');
  assert.equal(r.body.data.recurrence_virtual, 1);
});

// ── PUT /:id ───────────────────────────────────────────────────────────────────
test('PUT /:id: unbekannte id → 404', async () => {
  const r = await call('PUT', '/999999', { body: { title: 'x' } });
  assert.equal(r.status, 404);
});

test('PUT /:id: ungültige Subkategorie → 400', async () => {
  const id = insertEntry({ title: 'edit-me', amount: -5, category: 'food', date: '2033-03-10' });
  const r = await call('PUT', `/${id}`, { body: { category: 'food', subcategory: 'bogus' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /subcategory/i);
});

test('PUT /:id: Konto setzen und wieder entfernen', async () => {
  const acc = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Spar', ?)").run(A).lastInsertRowid;
  const id = insertEntry({ title: 'acc-toggle', amount: -5, category: 'food', date: '2033-04-10' });
  const set = await call('PUT', `/${id}`, { body: { account_id: acc } });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.account_id, acc);
  const clear = await call('PUT', `/${id}`, { body: { account_id: null } });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.data.account_id, null, 'null entfernt die Zuordnung');
});

test('PUT /:id: virtuelles Budget rechnet den Halbjahresbetrag neu', async () => {
  const id = insertEntry({ title: 'v-edit', amount: -50, category: 'financial_other', date: '2033-05-10' });
  const r = await call('PUT', `/${id}`, { body: {
    is_recurring: true, recurrence_virtual: true,
    recurrence_interval: 'monthly', recurrence_interval_count: 6, amount: -600,
  } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, -100, 'amount = -600 / 6 Monate');
  assert.equal(r.body.data.recurrence_interval_count, 6);
  assert.equal(r.body.data.recurrence_full_amount, -600);
});

test('PUT /:id: half_year ist kein Intervall mehr → 400', async () => {
  // Nach der Normalisierung auf Einheit + Anzahl (#636) gibt es genau eine
  // Schreibweise fuer den Halbjahres-Rhythmus.
  const id = insertEntry({ title: 'legacy', amount: -50, category: 'food', date: '2033-05-11' });
  const r = await call('PUT', `/${id}`, { body: { is_recurring: true, recurrence_interval: 'half_year' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^Interval /);
});

test('POST: Intervall-Anzahl ausserhalb von [1, 99] → 400', async () => {
  for (const count of [0, -1, 100, 2.5, 'zwei']) {
    const r = await call('POST', '/', { body: {
      title: 'bad-count', amount: -10, category: 'food', date: '2033-06-01',
      is_recurring: 1, recurrence_interval: 'weekly', recurrence_interval_count: count,
    } });
    assert.equal(r.status, 400, `count=${count} muss abgelehnt werden`);
  }
});

test('POST: woechentliche Serie speichert Einheit und Anzahl', async () => {
  const r = await call('POST', '/', { body: {
    title: 'weekly', amount: -25, category: 'food', date: '2033-06-03',
    is_recurring: 1, recurrence_interval: 'weekly', recurrence_interval_count: 2,
  } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.recurrence_interval, 'weekly');
  assert.equal(r.body.data.recurrence_interval_count, 2);
});

test('PUT /:id: ungültiger Betrag → 400', async () => {
  const id = insertEntry({ title: 'amt', amount: -5, category: 'food', date: '2033-05-20' });
  const r = await call('PUT', `/${id}`, { body: { amount: 'viel' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^Amount /);
});

test('PUT /:id: unbekanntes Konto → 400', async () => {
  const id = insertEntry({ title: 'acc-bad', amount: -5, category: 'food', date: '2033-05-21' });
  const r = await call('PUT', `/${id}`, { body: { account_id: 888888 } });
  assert.equal(r.status, 400);
  // Englisch wie jeder Satz des Servers - bis #1668 stand hier "Konto nicht gefunden.".
  assert.equal(r.body.error, 'Account not found.');
});

test('PUT /:id: Sichtbarkeit umschalten (owner_id bleibt fix)', async () => {
  const id = insertEntry({ title: 'vis', amount: -5, category: 'food', date: '2033-05-22', owner_id: A, visibility: 'shared' });
  const r = await call('PUT', `/${id}`, { body: { visibility: 'private' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.visibility, 'private');
  assert.equal(r.body.data.owner_id, A, 'owner_id unverändert');
});

test('PUT /:id: laufende Dokumentlöschung lässt Buchung unverändert', async () => {
  const id = insertEntry({ title: 'vorher', amount: -5, category: 'food', date: '2033-05-23' });
  const documentId = db.prepare(`
    INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES ('Beleg', 'beleg.txt', 'text/plain', 1, ?, 'other', 'family', 'active', ?)
  `).run(Buffer.from('x'), A).lastInsertRowid;

  lockDocumentDeletes([documentId]);
  try {
    const r = await call('PUT', `/${id}`, {
      body: { title: 'nachher', amount: -99, attachment_document_ids: [documentId] },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'DOCUMENT_DELETE_IN_PROGRESS');
    const unchanged = db.prepare('SELECT title, amount FROM budget_entries WHERE id = ?').get(id);
    assert.equal(unchanged.title, 'vorher');
    assert.equal(unchanged.amount, -5);
  } finally {
    unlockDocumentDeletes([documentId]);
  }
});

// ── PUT /:id: Loan-Payment-Kopplung ──────────────────────────────────────────────

/**
 * Legt ein Darlehen samt bezahlter Rate und gekoppeltem Budget-Eintrag an (#638/#859).
 * Das Vorzeichen des Eintrags folgt der Richtung - genau so, wie der Loans-Router
 * bucht; die Rate selbst bleibt positiv (CHECK amount > 0).
 */
function loanWithPayment({ direction = 'lent', amount = 100, date, total = 1000, currency = null, rate = null } = {}) {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by, direction, currency, exchange_rate)
                           VALUES ('L','Bo',?,10,'2033-01',?,?,?,?)`)
    .run(total, A, direction, currency, rate ?? 1).lastInsertRowid;
  const borrowed = direction === 'borrowed';
  const eid = insertEntry({
    title: 'pay',
    amount: (borrowed ? -1 : 1) * amount,
    category: borrowed ? 'financial_other' : 'Sonstiges Einkommen',
    subcategory: borrowed ? 'loans_interest' : '',
    date,
  });
  const pid = db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,?,?,?,?)`).run(loan, amount, date, eid, A).lastInsertRowid;
  return { loan, eid, pid };
}

test('PUT /:id: Rate eines aufgenommenen Kredits bleibt korrigierbar (#859)', async () => {
  // Der gemeldete Bug: Seit die Richtung existiert (#638), bucht eine Rate auf einen
  // aufgenommenen Kredit als Ausgabe - also negativ. Die alte Prüfung "muss Einkommen
  // bleiben" wies damit jede Korrektur ab, die das Edit-Modal überhaupt senden kann.
  const { eid, pid } = loanWithPayment({ direction: 'borrowed', date: '2033-06-01' });
  const r = await call('PUT', `/${eid}`, { body: { amount: -50 } });
  assert.equal(r.status, 200, 'Korrektur wird angenommen');
  assert.equal(r.body.data.amount, -50, 'Eintrag bleibt eine Ausgabe');
  assert.equal(db.prepare('SELECT amount FROM budget_loan_payments WHERE id = ?').get(pid).amount, 50,
    'die Rate selbst bleibt vorzeichenlos (CHECK amount > 0)');
});

test('PUT /:id: das Vorzeichen gehört dem Darlehen, nicht dem Request', async () => {
  // Ein Client, der den Typ-Umschalter umgeht, darf die Buchungsrichtung nicht kippen -
  // daran hängen Monatsbilanz, Statistik und Kontosaldo.
  const borrowedCase = loanWithPayment({ direction: 'borrowed', date: '2033-06-02' });
  const up = await call('PUT', `/${borrowedCase.eid}`, { body: { amount: 70 } });
  assert.equal(up.status, 200);
  assert.equal(up.body.data.amount, -70, 'positiv gesendet, als Ausgabe gebucht');

  const lentCase = loanWithPayment({ direction: 'lent', date: '2033-06-03' });
  const down = await call('PUT', `/${lentCase.eid}`, { body: { amount: -70 } });
  assert.equal(down.status, 200);
  assert.equal(down.body.data.amount, 70, 'negativ gesendet, als Einnahme gebucht');
});

test('PUT /:id: Betrag null wird abgewiesen, in beide Richtungen', async () => {
  // Vorher deckte die income-Prüfung das mit ab. Fällt sie weg, muss die Null
  // eigens abgefangen werden - sonst verletzt sie CHECK(amount > 0) als 500er.
  for (const [direction, day] of [['borrowed', '2033-06-04'], ['lent', '2033-06-05']]) {
    const { eid } = loanWithPayment({ direction, date: day });
    const r = await call('PUT', `/${eid}`, { body: { amount: 0 } });
    assert.equal(r.status, 400, `${direction}: 0 abgewiesen`);
    assert.match(r.body.error, /greater than zero/i);
  }
});

test('PUT /:id: die Rest-Grenze greift auch bei einem aufgenommenen Kredit', async () => {
  // Der Restschuld-Vergleich lief gegen den vorzeichenbehafteten Betrag: bei einer
  // Ausgabe war er damit immer erfüllt und die Grenze wirkungslos.
  const { eid } = loanWithPayment({ direction: 'borrowed', date: '2033-06-06' });
  const r = await call('PUT', `/${eid}`, { body: { amount: -5000 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /remaining loan/i);
});

test('PUT /:id: aufgenommener Kredit in Fremdwährung - Kurs und Vorzeichen greifen zusammen', async () => {
  // 1 USD = 0,50 EUR. 100 EUR Ausgabe entsprechen 200 USD Rate.
  const { eid, pid } = loanWithPayment({ direction: 'borrowed', date: '2033-06-07', currency: 'USD', rate: 0.5 });
  const r = await call('PUT', `/${eid}`, { body: { amount: -100 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, -100, 'Eintrag bleibt eine Ausgabe in Budget-Währung');
  assert.equal(db.prepare('SELECT amount FROM budget_loan_payments WHERE id = ?').get(pid).amount, 200,
    '100 EUR / 0,50 = 200 USD, positiv geführt');
});

test('PUT /:id: Rückzahlung über dem Restbetrag → 400', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('L2','Bo',1000,10,'2033-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay2', amount: 100, category: 'Sonstiges Einkommen', date: '2033-07-01' });
  db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-07-01',?,?)`).run(loan, eid, A);
  const r = await call('PUT', `/${eid}`, { body: { amount: 5000 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /remaining loan/i);
});

test('PUT /:id: gültige Rückzahlung aktualisiert Eintrag + Payment synchron', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('L3','Bo',1000,10,'2033-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay3', amount: 100, category: 'Sonstiges Einkommen', date: '2033-08-01' });
  const pid = db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-08-01',?,?)`).run(loan, eid, A).lastInsertRowid;
  const r = await call('PUT', `/${eid}`, { body: { amount: 500 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, 500, 'Eintragsbetrag aktualisiert');
  const pay = db.prepare('SELECT amount FROM budget_loan_payments WHERE id = ?').get(pid);
  assert.equal(pay.amount, 500, 'Payment folgt dem Eintragsbetrag');
});

test('PUT /:id: Fremdwährungs-Darlehen (#582) rechnet den Eintragsbetrag zurück', async () => {
  // Darlehen in USD, 1 USD = 0,50 EUR. Der Budget-Eintrag steht in EUR, die
  // gekoppelte Rate in USD - ein Edit des Eintrags darf die Restschuld nicht
  // verdoppeln, sondern muss über den Kurs zurückrechnen.
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by, currency, exchange_rate)
                           VALUES ('L-USD','Bo',1000,10,'2033-01',?,'USD',0.5)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay-usd', amount: 50, category: 'Sonstiges Einkommen', date: '2033-09-01' });
  const pid = db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-09-01',?,?)`).run(loan, eid, A).lastInsertRowid;

  const r = await call('PUT', `/${eid}`, { body: { amount: 100 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, 100, 'Eintrag bleibt in Budget-Währung');
  const pay = db.prepare('SELECT amount FROM budget_loan_payments WHERE id = ?').get(pid);
  assert.equal(pay.amount, 200, '100 EUR / 0,50 = 200 USD Rate');
});

test('PUT /:id: Rest-Grenze eines Fremdwährungs-Darlehens gilt in Darlehenswährung', async () => {
  // Restschuld 1000 USD. 400 EUR entsprechen bei 0,50 genau 800 USD (erlaubt),
  // 600 EUR wären 1200 USD und müssen abgewiesen werden.
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by, currency, exchange_rate)
                           VALUES ('L-USD2','Bo',1000,10,'2033-01',?,'USD',0.5)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay-usd2', amount: 50, category: 'Sonstiges Einkommen', date: '2033-10-01' });
  db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2033-10-01',?,?)`).run(loan, eid, A);

  assert.equal((await call('PUT', `/${eid}`, { body: { amount: 400 } })).status, 200);
  const tooMuch = await call('PUT', `/${eid}`, { body: { amount: 600 } });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /remaining loan/i);
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────────
test('DELETE /:id: unbekannte id → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:id: entfernt verknüpfte Rückzahlung mit (Cascade)', async () => {
  const loan = db.prepare(`INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by)
                           VALUES ('L4','Bo',1000,10,'2034-01',?)`).run(A).lastInsertRowid;
  const eid = insertEntry({ title: 'pay4', amount: 100, category: 'Sonstiges Einkommen', date: '2034-02-01' });
  const pid = db.prepare(`INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
              VALUES (?,1,100,'2034-02-01',?,?)`).run(loan, eid, A).lastInsertRowid;
  const r = await call('DELETE', `/${eid}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(eid), undefined, 'Eintrag weg');
  assert.equal(db.prepare('SELECT 1 FROM budget_loan_payments WHERE id = ?').get(pid), undefined, 'Payment mit-gelöscht');
});

test('DELETE /:id: gelöschte Serien-Instanz markiert ihren Fälligkeitstag als übersprungen', async () => {
  const parent = insertEntry({ title: 'series', amount: -20, category: 'food', date: '2034-03-01', is_recurring: 1 });
  const inst = insertEntry({ title: 'series', amount: -20, category: 'food', date: '2034-05-15', recurrence_parent_id: parent });
  const r = await call('DELETE', `/${inst}`);
  assert.equal(r.status, 204);
  // Am Tag, nicht am Monat (#636): sonst nähme eine gelöschte Woche die übrigen mit.
  const skip = db.prepare('SELECT 1 FROM budget_recurrence_skipped WHERE parent_id = ? AND date = ?').get(parent, '2034-05-15');
  assert.ok(skip, 'Skip-Markierung gesetzt, damit die Instanz nicht neu materialisiert wird');
});

// ── PUT /:id/series ──────────────────────────────────────────────────────────────
test('PUT /:id/series: unbekannte id → 404', async () => {
  const r = await call('PUT', '/999999/series', { body: { title: 'x' } });
  assert.equal(r.status, 404);
});

test('PUT /:id/series: Nicht-Serie → 400', async () => {
  const id = insertEntry({ title: 'plain', amount: -5, category: 'food', date: '2035-01-10', is_recurring: 0 });
  const r = await call('PUT', `/${id}/series`, { body: { amount: -9 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /recurring/i);
});

test('PUT /:id/series: ungültiger Betrag → 400', async () => {
  const parent = insertEntry({ title: 's-amt', amount: -5, category: 'food', date: '2035-01-20', is_recurring: 1 });
  const r = await call('PUT', `/${parent}/series`, { body: { amount: 'nope' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^Amount /);
});

test('PUT /:id/series: virtuelles Budget glättet den Serien-Jahresbetrag', async () => {
  const parent = insertEntry({ title: 's-virt', amount: -50, category: 'financial_other', date: '2035-01-25', is_recurring: 1 });
  const r = await call('PUT', `/${parent}/series`, { body: { recurrence_virtual: true, recurrence_interval: 'yearly', amount: -1200 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.amount, -100, 'geglätteter Monatsanteil -1200/12');
  assert.equal(r.body.data.recurrence_full_amount, -1200);
  assert.equal(r.body.data.recurrence_interval, 'yearly');
});

test('PUT /:id/series: aktualisiert das Original und propagiert Sichtbarkeit auf alle Instanzen', async () => {
  const parent = insertEntry({ title: 'orig', amount: -20, category: 'food', date: '2035-02-01', is_recurring: 1, visibility: 'shared' });
  const past = insertEntry({ title: 'orig', amount: -20, category: 'food', date: '2000-01-15', recurrence_parent_id: parent, visibility: 'shared' });
  const future = insertEntry({ title: 'orig', amount: -20, category: 'food', date: '2099-12-15', recurrence_parent_id: parent, visibility: 'shared' });
  setMode('personal'); // Sichtbarkeit greift nur im personal-Modus, Propagation ist aber datumsunabhängig
  const r = await call('PUT', `/${parent}/series`, { as: { id: A, role: 'member' }, body: { title: 'neu', visibility: 'private' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, 'neu', 'Original-Titel aktualisiert');
  // Sichtbarkeit trifft ALLE Instanzen (privat→geteilt-Leak-Schutz), unabhängig vom Datum.
  assert.equal(db.prepare('SELECT visibility FROM budget_entries WHERE id = ?').get(past).visibility, 'private', 'Vergangenheits-Instanz geerbt');
  // Bis v2.64.1 wurde die künftige Instanz hier gelöscht und beim nächsten Lesen
  // neu gebaut. Seit der Rhythmus unverändert bleibt, wird sie AKTUALISIERT: sie
  // behält ihre Identität und ihre Belege und trägt trotzdem den neuen Wert.
  // Der Test misst deshalb den Wert, nicht mehr das Verschwinden.
  const nachher = db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(future);
  assert.ok(nachher, '2099er-Instanz bleibt bestehen, statt gelöscht zu werden');
  assert.equal(nachher.title, 'neu', '2099er-Instanz übernimmt den neuen Titel (>= heute)');
  const vergangen = db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(past);
  assert.ok(vergangen, '2000er-Instanz bleibt (< heute)');
  assert.equal(vergangen.title, 'orig', 'eine gebuchte Vergangenheit wird nicht umgeschrieben');
});

test('PUT /:id/series: ein geänderter Rhythmus baut die künftigen Instanzen neu', async () => {
  // Die Gegenrichtung zum Test darüber, und der Grund, warum das Löschen nicht
  // ganz verschwindet: verschiebt sich der Takt, liegen die Termine anderswo -
  // eine bestehende Zeile am alten Datum wäre dann falsch, nicht veraltet.
  const parent = insertEntry({ title: 'takt', amount: -20, category: 'food', date: '2035-02-02', is_recurring: 1, recurrence_interval: 'monthly' });
  const future = insertEntry({ title: 'takt', amount: -20, category: 'food', date: '2099-11-15', recurrence_parent_id: parent });
  const r = await call('PUT', `/${parent}/series`, { body: { recurrence_interval: 'weekly' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(future), undefined,
    'bei geändertem Takt wird die künftige Instanz verworfen und neu berechnet');
});

// Konto an der Serie (#973). Das Feld fehlte in dieser Route ganz, während der
// Einzel-PUT es konnte - und das war genau die eine Reparatur, die dem Melder
// offenstand: Konto an einer Folgebuchung nachtragen, "alle künftigen ändern"
// wählen. Die Route ignorierte das Feld und löschte die Instanz gleich darauf mit.
test('PUT /:id/series: setzt das Konto der Serie und entfernt es wieder', async () => {
  const acc = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Serien-Giro', ?)").run(A).lastInsertRowid;
  const parent = insertEntry({ title: 's-acc', amount: -20, category: 'food', date: '2035-04-01', is_recurring: 1 });

  const set = await call('PUT', `/${parent}/series`, { body: { account_id: acc } });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.account_id, acc, 'Konto landet am Serien-Original');
  assert.equal(db.prepare('SELECT account_id FROM budget_entries WHERE id = ?').get(parent).account_id, acc);

  const clear = await call('PUT', `/${parent}/series`, { body: { account_id: null } });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.data.account_id, null, 'null entfernt die Zuordnung');
});

test('PUT /:id/series: ohne account_id im Body bleibt das Konto stehen', async () => {
  // Die Route schreibt jedes andere Feld bedingungslos. Ohne die CASE-WHEN-Form
  // würde ein Titel-Update das Konto auf NULL setzen - der Bug, den der Fix
  // hätte einführen können.
  const acc = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Bleibt', ?)").run(A).lastInsertRowid;
  const parent = insertEntry({ title: 's-keep', amount: -20, category: 'food', date: '2035-04-05', is_recurring: 1, account_id: acc });
  const r = await call('PUT', `/${parent}/series`, { body: { title: 'nur der Titel' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, 'nur der Titel');
  assert.equal(r.body.data.account_id, acc, 'ein Titel-Update darf das Konto nicht abräumen');
});

test('PUT /:id/series: unbekanntes Konto → 400', async () => {
  const parent = insertEntry({ title: 's-badacc', amount: -20, category: 'food', date: '2035-04-10', is_recurring: 1 });
  const r = await call('PUT', `/${parent}/series`, { body: { account_id: 999999 } });
  assert.equal(r.status, 400);
  // Englisch wie jeder Satz des Servers - bis #1668 stand hier "Konto nicht gefunden.".
  assert.equal(r.body.error, 'Account not found.');
  assert.equal(db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(parent).title, 's-badacc',
    'die abgelehnte Anfrage darf nichts anderes geschrieben haben');
});

test('PUT /:id/series: eine schon gebuchte Instanz DIESES Monats bleibt stehen', async () => {
  // Der Schnitt lag am Monatsersten. Bei einer Wochenserie liegen mehrere
  // Instanzen im selben Monat, und die vom Monatsanfang war dann bereits
  // gebucht, wurde aber mitgelöscht und aus dem Original neu erzeugt - mitsamt
  // dem gerade gewählten Konto. Eine erfolgte Abbuchung zog so auf ein anderes
  // Konto um. Der Test rechnet mit der echten Uhr statt mit Extremdaten, weil
  // genau die Lage "im laufenden Monat, aber vor heute" den Fehler trug.
  const heute = new Date();
  if (heute.getDate() < 3) return; // am 1./2. gibt es diese Lage nicht
  const monat = `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}`;
  const gestern = new Date(heute); gestern.setDate(heute.getDate() - 1);
  const gesternKey = `${monat}-${String(gestern.getDate()).padStart(2, '0')}`;

  const alt = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Alt', ?)").run(A).lastInsertRowid;
  const neu = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Neu', ?)").run(A).lastInsertRowid;
  const parent = insertEntry({ title: 'woche', amount: -20, category: 'food', date: `${monat}-01`, is_recurring: 1, account_id: alt });
  const gebucht = insertEntry({ title: 'woche', amount: -20, category: 'food', date: gesternKey, recurrence_parent_id: parent, account_id: alt });

  const r = await call('PUT', `/${parent}/series`, { body: { account_id: neu } });
  assert.equal(r.status, 200);
  const zeile = db.prepare('SELECT account_id FROM budget_entries WHERE id = ?').get(gebucht);
  assert.ok(zeile, 'die gestrige Buchung darf nicht gelöscht werden');
  assert.equal(zeile.account_id, alt,
    'eine bereits erfolgte Abbuchung darf nicht auf das neue Konto umziehen');
});

test('PUT /:id/series: der Schnitt folgt der Haushaltszone, nicht der Serverzone', async () => {
  // Der Kontosaldo liest seinen Stichtag mit todayKey(db) aus der Haushaltszone
  // (#829). Nimmt diese Route stattdessen die Serverzone, liegt die Grenze rund
  // um Mitternacht auf einem anderen Tag als die Zahlen, die der Haushalt sieht.
  // Kiritimati (UTC+14) und Midway (UTC-11) trennen 25 Stunden - ihr Datum ist
  // fast immer verschieden; genau dann traegt der Test etwas.
  const setZone = (tz) => db.prepare(
    `INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(tz);
  const tagIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

  const frueh = 'Pacific/Kiritimati', spaet = 'Pacific/Midway';
  if (tagIn(frueh) === tagIn(spaet)) return; // seltenes Fenster, in dem der Test nichts misst

  try {
    // Der Tag, der in Kiritimati schon laeuft, in Midway aber noch Zukunft ist.
    const grenztag = tagIn(frueh);
    const monat = grenztag.slice(0, 7);
    const parent = insertEntry({ title: 'tz', amount: -20, category: 'food', date: `${monat}-01`, is_recurring: 1 });
    const anGrenze = insertEntry({ title: 'tz', amount: -20, category: 'food', date: grenztag, recurrence_parent_id: parent });

    // In Midway ist dieser Tag noch nicht angebrochen: er liegt hinter dem
    // Schnitt und muss geloescht werden.
    setZone(spaet);
    const r = await call('PUT', `/${parent}/series`, { body: { title: 'tz-neu' } });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(anGrenze).title, 'tz-neu',
      `${grenztag} ist in ${spaet} noch Zukunft und muss den neuen Wert uebernehmen`);

    // In Kiritimati ist derselbe Tag bereits heute - "heute" faellt selbst noch
    // hinter den Schnitt (>=), der Tag DAVOR aber nicht mehr.
    const gestern = new Date(`${grenztag}T12:00:00Z`);
    gestern.setUTCDate(gestern.getUTCDate() - 1);
    const gesternKey = gestern.toISOString().slice(0, 10);
    if (gesternKey.slice(0, 7) !== monat) return; // Monatswechsel: der Cutoff-Monat waere ein anderer
    const davor = insertEntry({ title: 'tz2', amount: -20, category: 'food', date: gesternKey, recurrence_parent_id: parent });
    setZone(frueh);
    const r2 = await call('PUT', `/${parent}/series`, { body: { title: 'tz-neuer' } });
    assert.equal(r2.status, 200);
    const alt = db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(davor);
    assert.ok(alt, `${gesternKey} muss stehen bleiben`);
    assert.equal(alt.title, 'tz2',
      `${gesternKey} liegt in ${frueh} vor heute und darf nicht umgeschrieben werden`);
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
});

test('PUT /:id/series: das Konto wirkt nicht rückwirkend auf vergangene Instanzen', async () => {
  // Anders als die Sichtbarkeit: ein zu weiter Alt-Wert bei visibility ist ein
  // Leck, ein Konto ist eine Tatsache über eine bereits erfolgte Abbuchung.
  // Künftige Instanzen erben es ohnehin über die Neu-Generierung.
  const acc = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Neu-Giro', ?)").run(A).lastInsertRowid;
  const parent = insertEntry({ title: 's-past', amount: -20, category: 'food', date: '2035-04-20', is_recurring: 1 });
  const past = insertEntry({ title: 's-past', amount: -20, category: 'food', date: '2000-01-15', recurrence_parent_id: parent });

  const r = await call('PUT', `/${parent}/series`, { body: { account_id: acc } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT account_id FROM budget_entries WHERE id = ?').get(past).account_id, null,
    'die Buchung von 2000 lief nicht über das heute gewählte Konto');
});

test('PUT /:id/series: fremder Nutzer im personal-Modus → 403 (kein Bypass)', async () => {
  const parent = insertEntry({ title: 'a-series', amount: -20, category: 'food', date: '2035-03-01', is_recurring: 1, owner_id: A, visibility: 'shared' });
  setMode('personal');
  const asMember = await call('PUT', `/${parent}/series`, { as: { id: B, role: 'member' }, body: { title: 'hijack' } });
  const asAdmin = await call('PUT', `/${parent}/series`, { as: { id: ADMIN, role: 'admin' }, body: { title: 'hijack' } });
  assert.equal(asMember.status, 403, 'B darf A-Serie nicht ändern');
  assert.equal(asAdmin.status, 403, 'Admin ist kein Owner → auch 403');
  assert.equal(db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(parent).title, 'a-series', 'unverändert');
});

// ── #1035: das Original ist eine gewoehnliche Buchung, die Serie hat eine eigene Definition ──
//
// Bis v2.70 war die erste Zeile einer Serie zweierlei: Vorlage fuer jedes
// kuenftige Vorkommen UND die erste, von Hand erfasste Buchung. "Alle
// kuenftigen aendern" schrieb deshalb auf eine Buchung, die Jahre zurueckliegen
// konnte. Die Tests hier messen beide Seiten der Trennung: die alte Buchung
// bleibt, wie sie war, und die kuenftigen Vorkommen tragen trotzdem den neuen
// Stand - letzteres ueber die echte Materialisierung (GET eines Monats, der
// sicher noch keine Instanz hat), nicht ueber einen Blick in eine Tabelle.
const accountTotal = (accountId) => db.prepare(
  'SELECT COALESCE(SUM(amount), 0) AS s FROM budget_entries WHERE account_id = ?'
).get(accountId).s;
const entryRow = (id) => db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
const newAccount = (name) => db.prepare(
  'INSERT INTO budget_accounts (name, created_by) VALUES (?, ?)'
).run(name, A).lastInsertRowid;
/** Materialisiert `month` ueber die Route und liefert das Vorkommen der Serie darin. */
async function generatedIn(month, anchorId) {
  const r = await call('GET', `/?month=${month}`);
  assert.equal(r.status, 200);
  return db.prepare(
    'SELECT * FROM budget_entries WHERE recurrence_parent_id = ? AND date BETWEEN ? AND ?'
  ).get(anchorId, `${month}-01`, `${month}-31`);
}

test('#1035: Kontowechsel "alle kuenftigen" verschiebt die Originalbuchung von 2020 nicht', async () => {
  // Der gemessene Fall aus dem Issue: Serie ab 05.01.2020 auf "Alt", eine
  // Instanz 05.02.2020, beide -900. Der Wechsel kommt von der Instanz aus.
  const alt = newAccount('Alt-1035');
  const neu = newAccount('Neu-1035');
  const series = await call('POST', '/', { body: {
    title: 'Miete', amount: -900, category: 'housing', subcategory: 'rent_mortgage',
    date: '2020-01-05', is_recurring: 1, recurrence_interval: 'monthly', account_id: alt,
  } });
  assert.equal(series.status, 201);
  const anchor = series.body.data.id;
  const instance = insertEntry({
    title: 'Miete', amount: -900, category: 'housing', subcategory: 'rent_mortgage',
    date: '2020-02-05', recurrence_parent_id: anchor, account_id: alt,
  });
  assert.equal(accountTotal(alt), -1800);

  const r = await call('PUT', `/${instance}/series`, { body: { account_id: neu } });
  assert.equal(r.status, 200);

  assert.equal(entryRow(anchor).account_id, alt,
    'die Buchung vom 05.01.2020 bleibt auf dem Konto, von dem sie abging');
  assert.equal(entryRow(instance).account_id, alt, 'die Instanz vom 05.02.2020 ebenso');
  assert.equal(accountTotal(alt), -1800, 'Saldo Alt unveraendert');
  assert.equal(accountTotal(neu), 0, 'Saldo Neu unveraendert');

  const next = await generatedIn('2099-12', anchor);
  assert.ok(next, 'die Serie laeuft weiter');
  assert.equal(next.account_id, neu, 'kuenftige Vorkommen laufen ueber das neue Konto');
});

test('#1035: Titel, Betrag, Kategorie und Unterkategorie gelten ab heute, nicht fuer die erste Buchung', async () => {
  // "It is not only the account": dieselbe Zeile traegt vier weitere Werte,
  // und die Route hat sie schon immer mit umgeschrieben.
  const series = await call('POST', '/', { body: {
    title: 'Strom', amount: -80, category: 'housing', subcategory: 'utilities',
    date: '2020-01-05', is_recurring: 1, recurrence_interval: 'monthly',
  } });
  const anchor = series.body.data.id;
  const past = insertEntry({
    title: 'Strom', amount: -80, category: 'housing', subcategory: 'utilities',
    date: '2020-02-05', recurrence_parent_id: anchor,
  });
  const future = insertEntry({
    title: 'Strom', amount: -80, category: 'housing', subcategory: 'utilities',
    date: '2099-10-05', recurrence_parent_id: anchor,
  });

  const r = await call('PUT', `/${past}/series`, { body: {
    title: 'Strom neu', amount: -95, category: 'transport', subcategory: 'fuel',
  } });
  assert.equal(r.status, 200);

  const first = entryRow(anchor);
  assert.deepEqual(
    [first.title, first.amount, first.category, first.subcategory],
    ['Strom', -80, 'housing', 'utilities'],
    'die Originalbuchung von 2020 behaelt alle vier Werte',
  );
  const before = entryRow(past);
  assert.deepEqual([before.title, before.amount, before.category, before.subcategory],
    ['Strom', -80, 'housing', 'utilities'], 'die gebuchte Instanz von 2020 ebenso');
  const later = entryRow(future);
  assert.deepEqual([later.title, later.amount, later.category, later.subcategory],
    ['Strom neu', -95, 'transport', 'fuel'], 'die vorhandene kuenftige Instanz zieht nach');
  const fresh = await generatedIn('2099-11', anchor);
  assert.deepEqual([fresh.title, fresh.amount, fresh.category, fresh.subcategory],
    ['Strom neu', -95, 'transport', 'fuel'], 'ein neu entstehendes Vorkommen traegt den neuen Stand');
});

test('#1035: eine Einzel-Korrektur der ersten Buchung ist keine Aenderung der Serie', async () => {
  // Die Gegenrichtung: solange das Original die Vorlage war, schrieb eine
  // Korrektur NUR dieser Buchung (Nachzahlung im ersten Monat) in jedes
  // kuenftige Vorkommen weiter.
  const series = await call('POST', '/', { body: {
    title: 'Wasser', amount: -30, category: 'housing', subcategory: 'utilities',
    date: '2020-01-05', is_recurring: 1, recurrence_interval: 'monthly',
  } });
  const anchor = series.body.data.id;
  const fix = await call('PUT', `/${anchor}`, { body: { title: 'Wasser mit Nachzahlung', amount: -130 } });
  assert.equal(fix.status, 200);
  assert.equal(entryRow(anchor).title, 'Wasser mit Nachzahlung', 'die Buchung selbst ist korrigiert');

  const fresh = await generatedIn('2099-09', anchor);
  assert.equal(fresh.title, 'Wasser', 'die Serie behaelt ihren Titel');
  assert.equal(fresh.amount, -30, 'und ihren Betrag');
});

test('#1035: liegt die erste Buchung selbst noch vor uns, zieht sie mit', async () => {
  // Der Schnitt ist fuer alle Buchungen derselbe - auch fuer die erste. Eine
  // Serie, die naechsten Monat beginnt, hat noch nichts gebucht.
  const series = await call('POST', '/', { body: {
    title: 'Kita', amount: -300, category: 'housing', subcategory: 'utilities',
    date: '2099-01-07', is_recurring: 1, recurrence_interval: 'monthly',
  } });
  const anchor = series.body.data.id;
  const r = await call('PUT', `/${anchor}/series`, { body: { title: 'Kita neu', amount: -320 } });
  assert.equal(r.status, 200);
  assert.equal(entryRow(anchor).title, 'Kita neu');
  assert.equal(entryRow(anchor).amount, -320);
});

test('#1035: Sichtbarkeit gilt fuer die ganze Serie, die erste Buchung eingeschlossen (gewollt)', async () => {
  // Bewusst RUECKWIRKEND, anders als die Werte: wer eine Serie privat stellt,
  // meint auch ihre alten Buchungen - eine private Serie, deren Vergangenheit
  // im Haushalt sichtbar bliebe, waere die Ueberraschung (Entscheidung in #1035).
  const series = await call('POST', '/', { body: {
    title: 'Therapie', amount: -60, category: 'housing', subcategory: 'utilities',
    date: '2020-01-05', is_recurring: 1, recurrence_interval: 'monthly', visibility: 'shared',
  } });
  const anchor = series.body.data.id;
  const past = insertEntry({ title: 'Therapie', amount: -60, date: '2020-02-05', recurrence_parent_id: anchor });
  setMode('personal');
  const r = await call('PUT', `/${past}/series`, { body: { visibility: 'private' } });
  assert.equal(r.status, 200);
  assert.equal(entryRow(anchor).visibility, 'private', 'die erste Buchung von 2020');
  assert.equal(entryRow(past).visibility, 'private', 'die gebuchte Instanz von 2020');
  const fresh = await generatedIn('2099-08', anchor);
  assert.equal(fresh.visibility, 'private', 'und jedes kuenftige Vorkommen');
});

test('#1035: eine beendete Serie erzeugt nichts mehr, eine neu begonnene startet mit den Werten der Buchung', async () => {
  const series = await call('POST', '/', { body: {
    title: 'Zeitung', amount: -20, category: 'housing', subcategory: 'utilities',
    date: '2020-01-05', is_recurring: 1, recurrence_interval: 'monthly',
  } });
  const anchor = series.body.data.id;
  assert.equal((await call('PUT', `/${anchor}`, { body: { is_recurring: false } })).status, 200);
  assert.equal(await generatedIn('2099-07', anchor), undefined, 'beendet heisst beendet');

  assert.equal((await call('PUT', `/${anchor}`, { body: { is_recurring: true, title: 'Zeitung digital' } })).status, 200);
  const fresh = await generatedIn('2099-06', anchor);
  assert.ok(fresh, 'wieder begonnen');
  assert.equal(fresh.title, 'Zeitung digital');
});

test('#1035: eine Einzelbuchung, die per Bearbeiten zur Serie wird, ist deren Vorlage', async () => {
  const plain = insertEntry({ title: 'Einzeln', amount: -12, category: 'housing', subcategory: 'utilities', date: '2020-03-09' });
  const r = await call('PUT', `/${plain}`, { body: { is_recurring: true, title: 'Jetzt monatlich' } });
  assert.equal(r.status, 200);
  const fresh = await generatedIn('2099-05', plain);
  assert.ok(fresh, 'die neue Serie erzeugt Vorkommen');
  assert.equal(fresh.title, 'Jetzt monatlich');
  assert.equal(fresh.amount, -12);
});

// ── #1546: "Alle zukuenftigen" aus einem Vorkommen beendet die Serie nicht ──────
//
// Der Bearbeiten-Dialog eines Vorkommens schickte die Rhythmus-Felder DIESES
// Vorkommens mit: is_recurring 0 und die Spalten-Defaults. Gemessen im echten
// Browser gegen den echten Router (test:budget-series-edit-browser): die Serie
// war danach beendet, jedes Vorkommen ab heute geloescht. Die Tests hier
// schicken genau diesen Body.
const addMonths1546 = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** Serie ueber die Route anlegen und die Monate um heute materialisieren. */
async function runningSeries1546(fields) {
  const created = await call('POST', '/', { body: {
    title: 'Miete', amount: -900, category: 'housing', subcategory: 'rent_mortgage', is_recurring: 1, ...fields,
  } });
  assert.equal(created.status, 201);
  const anchor = created.body.data.id;
  const now = todayKeyOf1546().slice(0, 7);
  for (let i = -2; i <= 3; i++) await call('GET', `/?month=${addMonths1546(now, i)}`);
  return anchor;
}
// Derselbe Tag, an dem die Route schneidet: Haushaltszone, nicht UTC.
const { todayKey: todayKey1546 } = await import('../server/utils/timezone.js');
const todayKeyOf1546 = () => todayKey1546(db);
const occurrences1546 = (anchor) => db.prepare(
  'SELECT * FROM budget_entries WHERE recurrence_parent_id = ? ORDER BY date'
).all(anchor);

test('#1546: der alte Dialog-Body eines Vorkommens beendet die Serie nicht mehr', async () => {
  const start = `${addMonths1546(todayKeyOf1546().slice(0, 7), -3)}-05`;
  const anchor = await runningSeries1546({ date: start, recurrence_interval: 'weekly', recurrence_interval_count: 2 });
  const before = occurrences1546(anchor);
  const occurrence = before.find((r) => r.date < todayKeyOf1546());
  const future = before.filter((r) => r.date > todayKeyOf1546()).map((r) => r.id);
  assert.ok(occurrence && future.length, 'Vorkommen vor und nach heute vorhanden');

  // Genau das schickte der Dialog (gemessen): Werte des Vorkommens, Rhythmus
  // aus dessen Spalten-Defaults.
  const r = await call('PUT', `/${occurrence.id}/series`, { body: {
    title: 'Miete neu', amount: -900, category: 'housing', subcategory: 'rent_mortgage', date: occurrence.date,
    is_recurring: 0, recurrence_interval: 'monthly', recurrence_interval_count: 1,
    recurrence_virtual: 0, recurrence_confirm: 0,
  } });
  assert.equal(r.status, 400, 'laut abgewiesen statt still ausgefuehrt');
  assert.match(r.body.error, /cannot end the series/);

  const a = entryRow1546(anchor);
  assert.equal(a.is_recurring, 1, 'die Serie laeuft weiter');
  assert.equal(a.recurrence_interval, 'weekly', 'ihr Rhythmus bleibt');
  assert.equal(a.recurrence_interval_count, 2);
  for (const id of future) assert.ok(entryRow1546(id), `kuenftiges Vorkommen ${id} bleibt stehen`);
  assert.equal(entryRow1546(occurrence.id).title, 'Miete', 'eine abgewiesene Anfrage schreibt nichts');
});

test('#1546: ohne Rhythmus-Felder aendert "alle kuenftigen" die Werte und laesst den Rhythmus stehen', async () => {
  const start = `${addMonths1546(todayKeyOf1546().slice(0, 7), -3)}-05`;
  const anchor = await runningSeries1546({ date: start, recurrence_interval: 'weekly', recurrence_interval_count: 2 });
  const occurrence = occurrences1546(anchor).find((r) => r.date < todayKeyOf1546());
  const futureBefore = occurrences1546(anchor).filter((r) => r.date >= todayKeyOf1546()).map((r) => r.id);

  const r = await call('PUT', `/${occurrence.id}/series`, { body: { title: 'Miete neu' } });
  assert.equal(r.status, 200);
  const a = entryRow1546(anchor);
  assert.equal(a.is_recurring, 1);
  assert.equal(a.recurrence_interval, 'weekly');
  const futureAfter = occurrences1546(anchor).filter((row) => row.date >= todayKeyOf1546());
  assert.deepEqual(futureAfter.map((row) => row.id), futureBefore, 'dieselben Zeilen, nicht neu gebaut');
  assert.ok(futureAfter.every((row) => row.title === 'Miete neu'), 'mit dem neuen Titel');
});

test('#1546: is_recurring true bleibt erlaubt', async () => {
  const anchor = await runningSeries1546({ date: `${addMonths1546(todayKeyOf1546().slice(0, 7), -1)}-07` });
  const r = await call('PUT', `/${anchor}/series`, { body: { is_recurring: true, title: 'Miete' } });
  assert.equal(r.status, 200);
  assert.equal(entryRow1546(anchor).is_recurring, 1);
});

test('#1546: eine virtuelle Serie behaelt ihr virtual-Flag und ihren Periodenbetrag', async () => {
  const start = `${addMonths1546(todayKeyOf1546().slice(0, 7), -3)}-09`;
  const anchor = await runningSeries1546({
    date: start, amount: -1200, recurrence_interval: 'yearly', recurrence_virtual: 1,
  });
  const occurrence = occurrences1546(anchor).find((r) => r.date < todayKeyOf1546());
  assert.equal(occurrence.amount, -100, 'ein Vorkommen traegt den Monatsanteil');

  const r = await call('PUT', `/${occurrence.id}/series`, { body: { title: 'Police neu' } });
  assert.equal(r.status, 200);
  const a = entryRow1546(anchor);
  assert.equal(a.recurrence_virtual, 1, 'virtuell bleibt virtuell');
  assert.equal(a.recurrence_interval, 'yearly');
  assert.equal(a.recurrence_full_amount, -1200, 'Periodenbetrag unveraendert');
});

test('#1546: ein ueber ein Vorkommen geaenderter Betrag einer virtuellen Serie ist dessen Monatsanteil', async () => {
  // Das Vorkommen zeigt 100 im Monat. Wer dort 110 eintraegt, meint 110 im
  // Monat - als Periodenbetrag gelesen, waeren daraus 9,17 geworden.
  const start = `${addMonths1546(todayKeyOf1546().slice(0, 7), -3)}-10`;
  const anchor = await runningSeries1546({
    date: start, amount: -1200, recurrence_interval: 'yearly', recurrence_virtual: 1,
  });
  const occurrence = occurrences1546(anchor).find((r) => r.date < todayKeyOf1546());
  const r = await call('PUT', `/${occurrence.id}/series`, { body: { amount: -110 } });
  assert.equal(r.status, 200);
  const later = occurrences1546(anchor).filter((row) => row.date >= todayKeyOf1546());
  assert.ok(later.length && later.every((row) => row.amount === -110), 'kuenftige Vorkommen tragen 110 im Monat');
  // Der Periodenbetrag gehoert der Definition (#1035); die erste Buchung liegt
  // drei Monate zurueck, ist gebucht und behaelt ihren.
  const def = db.prepare('SELECT * FROM budget_series WHERE anchor_id = ?').get(anchor);
  assert.equal(def.full_amount, -1320, 'Periodenbetrag 12 x 110');
  assert.equal(def.amount, -110, 'Vorlage fuer kuenftige Monate: der Anteil');
  assert.equal(entryRow1546(anchor).recurrence_full_amount, -1200, 'die gebuchte erste Buchung bleibt');
  assert.ok(def.updated_at >= def.created_at && /T.*Z$/.test(def.updated_at),
    'die Serien-Aenderung fuehrt updated_at der Definition nach');
  assert.equal(entryRow1546(anchor).recurrence_virtual, 1);
});

test('#1546: eine so beendete Serie laesst sich an ihrer ersten Buchung wieder starten', async () => {
  // Der Weg fuer Bestaende, die der Fehler schon beendet hat: erste Buchung
  // oeffnen, "wiederkehrend" wieder einschalten, Rhythmus wieder waehlen. Die
  // geloeschten Vorkommen kommen beim naechsten Oeffnen ihres Monats zurueck -
  // sie waren erzeugt, nicht als uebersprungen vermerkt. Belege und einmalige
  // Aenderungen daran kommen nicht zurueck.
  const now = todayKeyOf1546().slice(0, 7);
  const anchor = await runningSeries1546({ date: `${addMonths1546(now, -3)}-11` });
  // Der Schaden, wie ihn die alte Route hinterliess:
  db.prepare('UPDATE budget_entries SET is_recurring = 0 WHERE id = ?').run(anchor);
  db.prepare('DELETE FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?').run(anchor, todayKeyOf1546());
  const next = addMonths1546(now, 1);
  await call('GET', `/?month=${next}`);
  assert.equal(occurrences1546(anchor).filter((r) => r.date.startsWith(next)).length, 0, 'beendet: nichts');

  const r = await call('PUT', `/${anchor}`, { body: { is_recurring: true, recurrence_interval: 'monthly' } });
  assert.equal(r.status, 200);
  await call('GET', `/?month=${next}`);
  assert.equal(occurrences1546(anchor).filter((row) => row.date.startsWith(next)).length, 1,
    'das Vorkommen des naechsten Monats ist wieder da');
});
const entryRow1546 = (id) => db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);

// ── DELETE /:id/series ───────────────────────────────────────────────────────────
test('DELETE /:id/series: unbekannte id → 404', async () => {
  const r = await call('DELETE', '/999999/series');
  assert.equal(r.status, 404);
});

test('DELETE /:id/series: Nicht-Serie → 400', async () => {
  const id = insertEntry({ title: 'plain2', amount: -5, category: 'food', date: '2036-01-10', is_recurring: 0 });
  const r = await call('DELETE', `/${id}/series`);
  assert.equal(r.status, 400);
});

test('DELETE /:id/series: löscht Original und alle Instanzen', async () => {
  const parent = insertEntry({ title: 'kill', amount: -20, category: 'food', date: '2036-02-01', is_recurring: 1 });
  const i1 = insertEntry({ title: 'kill', amount: -20, category: 'food', date: '2036-03-15', recurrence_parent_id: parent });
  const i2 = insertEntry({ title: 'kill', amount: -20, category: 'food', date: '2036-04-15', recurrence_parent_id: parent });
  const r = await call('DELETE', `/${parent}/series`);
  assert.equal(r.status, 204);
  for (const id of [parent, i1, i2]) {
    assert.equal(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(id), undefined, `Eintrag ${id} weg`);
  }
});

test('DELETE /:id/series: fremder Nutzer im personal-Modus → 403 (kein Bypass)', async () => {
  const parent = insertEntry({ title: 'a-keep', amount: -20, category: 'food', date: '2036-05-01', is_recurring: 1, owner_id: A, visibility: 'shared' });
  setMode('personal');
  const asAdmin = await call('DELETE', `/${parent}/series`, { as: { id: ADMIN, role: 'admin' } });
  assert.equal(asAdmin.status, 403);
  assert.ok(db.prepare('SELECT 1 FROM budget_entries WHERE id = ?').get(parent), 'Serie unangetastet');
});


// ── Bestätigung vor der Buchung (#637) ───────────────────────────────────────

test('GET /summary: erwartete Buchungen zählen nicht mit, werden aber ausgewiesen', async () => {
  insertEntry({ title: 'gebucht', amount: -40, category: 'food', date: '2038-02-05' });
  insertEntry({ title: 'erwartet', amount: -60, category: 'food', date: '2038-02-06', is_pending: 1 });
  const r = await call('GET', '/summary?month=2038-02');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.expenses, -40, 'nur die tatsächliche Buchung');
  assert.equal(r.body.data.balance, -40);
  assert.equal(r.body.data.pending.count, 1);
  assert.equal(r.body.data.pending.expenses, -60);
  // Auch die Kategorie-Aufschlüsselung darf die erwartete Buchung nicht führen.
  const food = r.body.data.byCategory.find((c) => c.category === 'food');
  assert.equal(food.total, -40);
});

test('PATCH /:id/confirm: bucht und übernimmt den korrigierten Betrag', async () => {
  const id = insertEntry({ title: 'strom', amount: -60, category: 'housing', date: '2038-03-01', is_pending: 1 });
  const r = await call('PATCH', `/${id}/confirm`, { body: { amount: 58.4, date: '2038-03-03' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.is_pending, 0);
  assert.equal(r.body.data.amount, -58.4, 'Vorzeichen bleibt eine Ausgabe');
  assert.equal(r.body.data.date, '2038-03-03');

  const summary = await call('GET', '/summary?month=2038-03');
  assert.equal(summary.body.data.expenses, -58.4, 'jetzt zählt sie mit');
  assert.equal(summary.body.data.pending.count, 0);
});

test('PATCH /:id/confirm: ohne Angaben bleibt alles, nur der Status wechselt', async () => {
  const id = insertEntry({ title: 'abo', amount: -9.99, category: 'subscriptions', date: '2038-04-01', is_pending: 1 });
  const r = await call('PATCH', `/${id}/confirm`, { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.is_pending, 0);
  assert.equal(r.body.data.amount, -9.99);
  assert.equal(r.body.data.date, '2038-04-01');
});

test('PATCH /:id/confirm: eine Einnahme bleibt eine Einnahme', async () => {
  const id = insertEntry({ title: 'gehalt', amount: 2000, category: 'food', date: '2038-05-01', is_pending: 1 });
  const r = await call('PATCH', `/${id}/confirm`, { body: { amount: 2010 } });
  assert.equal(r.body.data.amount, 2010);
});

test('PATCH /:id/confirm: bereits gebucht → 400, unbekannt → 404', async () => {
  const booked = insertEntry({ title: 'da', amount: -5, category: 'food', date: '2038-06-01' });
  assert.equal((await call('PATCH', `/${booked}/confirm`, { body: {} })).status, 400);
  assert.equal((await call('PATCH', '/999999/confirm', { body: {} })).status, 404);
});

test('PATCH /:id/confirm: ungültiger Betrag oder Datum → 400', async () => {
  const id = insertEntry({ title: 'krumm', amount: -5, category: 'food', date: '2038-07-01', is_pending: 1 });
  assert.equal((await call('PATCH', `/${id}/confirm`, { body: { amount: 'viel' } })).status, 400);
  assert.equal((await call('PATCH', `/${id}/confirm`, { body: { date: '07.2038' } })).status, 400);
  // Nach zwei abgelehnten Anfragen steht die Buchung unverändert da.
  assert.equal(db.prepare('SELECT is_pending FROM budget_entries WHERE id = ?').get(id).is_pending, 1);
});

test('POST: recurrence_confirm reist mit und gilt nur für Serien', async () => {
  const series = await call('POST', '/', { body: {
    title: 'serie', amount: -30, category: 'food', date: '2038-08-01',
    is_recurring: 1, recurrence_confirm: 1,
  } });
  assert.equal(series.body.data.recurrence_confirm, 1);

  const single = await call('POST', '/', { body: {
    title: 'einzeln', amount: -30, category: 'food', date: '2038-08-02', recurrence_confirm: 1,
  } });
  assert.equal(single.body.data.recurrence_confirm, 0, 'ohne Serie gibt es nichts zu bestätigen');
});

// --------------------------------------------------------
// Zustaendige je Buchung (#1057) - ein Etikett, das kein Geld bewegt
// --------------------------------------------------------

test('POST: responsible_user_ids legt die Zustaendigen an', async () => {
  const r = await call('POST', '/', { body: {
    title: 'Wasser', amount: -42, category: 'housing', date: '2038-09-01',
    responsible_user_ids: [A, B],
  } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.responsible_users.map((u) => u.id).sort(), [A, B].sort());
});

test('PUT ohne das Feld laesst die Zustaendigen stehen, ein leeres Array raeumt sie ab', async () => {
  // Der wichtigere der beiden Faelle ist der erste: ein Teil-Request, der nur
  // den Betrag korrigiert, darf die Zuordnung nicht stillschweigend loeschen.
  const created = await call('POST', '/', { body: {
    title: 'Strom', amount: -80, category: 'housing', date: '2038-09-02', responsible_user_ids: [A],
  } });
  const id = created.body.data.id;

  const partial = await call('PUT', `/${id}`, { body: {
    title: 'Strom', amount: -90, category: 'housing', date: '2038-09-02',
  } });
  assert.deepEqual(partial.body.data.responsible_users.map((u) => u.id), [A], 'ohne Feld unveraendert');

  const cleared = await call('PUT', `/${id}`, { body: {
    title: 'Strom', amount: -90, category: 'housing', date: '2038-09-02', responsible_user_ids: [],
  } });
  assert.deepEqual(cleared.body.data.responsible_users, [], 'leeres Array heisst niemand');
});

test('POST: eine unbekannte User-ID faellt weg, ohne den Request zu kippen', async () => {
  // Die Auswahl kann eine Person nennen, die zwischen Laden und Absenden
  // entfernt wurde - das ist kein Fehler des Aufrufers.
  const r = await call('POST', '/', { body: {
    title: 'Gas', amount: -60, category: 'housing', date: '2038-09-03',
    responsible_user_ids: [A, 999999],
  } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.responsible_users.map((u) => u.id), [A]);
});

test('PUT /:id/series: kuenftige Instanzen ziehen nach, bereits gebuchte nicht', async () => {
  const series = await call('POST', '/', { body: {
    title: 'Abschlag', amount: -50, category: 'housing', date: '2020-01-05',
    is_recurring: 1, recurrence_interval: 'monthly', responsible_user_ids: [A],
  } });
  const pid = series.body.data.id;

  // Eine Instanz in der Vergangenheit und eine in der Zukunft materialisieren,
  // BEVOR die Serie umgeschrieben wird - sonst entstuenden beide erst danach
  // und trueden ohnehin den neuen Stand.
  const past = insertEntry({
    title: 'Abschlag', amount: -50, category: 'housing', date: '2020-02-05', recurrence_parent_id: pid,
  });
  const future = insertEntry({
    title: 'Abschlag', amount: -50, category: 'housing', date: '2038-02-05', recurrence_parent_id: pid,
  });
  db.prepare('INSERT INTO budget_entry_responsibles (entry_id, user_id) VALUES (?, ?), (?, ?)')
    .run(past, A, future, A);

  await call('PUT', `/${pid}/series`, { body: {
    title: 'Abschlag', amount: -50, category: 'housing', responsible_user_ids: [B],
  } });

  const who = (id) => db.prepare('SELECT user_id FROM budget_entry_responsibles WHERE entry_id = ? ORDER BY user_id').all(id).map((r) => r.user_id);
  // Bis #1035 trug das Original hier [B]: es war zugleich die Vorlage. Die
  // erste Buchung ist aber vom 05.01.2020 - wer damals zustaendig war, bleibt
  // es, genau wie an der Instanz vom Februar.
  assert.deepEqual(who(pid), [A], 'die erste Buchung von 2020 bleibt, wie sie war');
  assert.deepEqual(who(future), [B], 'kuenftige Instanz zieht nach');
  assert.deepEqual(who(past), [A], 'eine gebuchte Vergangenheit bleibt, wie sie war');
  const fresh = await generatedIn('2099-04', pid);
  assert.deepEqual(who(fresh.id), [B], 'ein neu entstehendes Vorkommen erbt die neue Zustaendigkeit');
});

// ── GET /?q= - Suche im Hauptbuch (Re-Critique 2026-09-27, C6) ───────────────
//
// "Wann war die letzte Zahnarztrechnung?" hiess bisher Monate blaettern: die
// Liste kannte nur einen Monat. `q` sucht ueber ALLE Monate, im Wortinneren,
// ohne Ruecksicht auf Gross-/Kleinschreibung und Akzente - und nur in dem, was
// der Betrachter sehen darf: private Buchungen anderer fehlen, und von einer
// fremden "nur Betrag"-Buchung ist der Titel verdeckt, also findet er sie nicht.

test('GET /?q=: findet Wortteile ueber alle Monate, neueste zuerst', async () => {
  insertEntry({ title: 'Zahnarztrechnung Dr. Müller', amount: -80, date: '2033-02-03' });
  insertEntry({ title: 'ZAHNARZT Kontrolle', amount: -40, date: '2033-07-19' });
  insertEntry({ title: 'Kieferorthopaede', amount: -99, date: '2033-05-01' });
  const r = await call('GET', '/?q=arzt');
  assert.equal(r.status, 200);
  const titles = r.body.data.map((e) => e.title);
  assert.deepEqual(titles.filter((t) => /arzt/i.test(t)), ['ZAHNARZT Kontrolle', 'Zahnarztrechnung Dr. Müller']);
  assert.ok(!titles.includes('Kieferorthopaede'));
  // Akzente fallen beidseitig weg: "muller" findet "Müller".
  const umlaut = await call('GET', '/?q=muller');
  assert.ok(umlaut.body.data.some((e) => e.title === 'Zahnarztrechnung Dr. Müller'));
});

test('GET /?q=: % und _ sind Zeichen, keine Platzhalter', async () => {
  insertEntry({ title: 'Rabatt 50% Schuhe', amount: -30, date: '2033-03-03' });
  insertEntry({ title: 'Rabatt 500 Schuhe', amount: -30, date: '2033-03-04' });
  insertEntry({ title: 'snake_case Kurs', amount: -12, date: '2033-03-05' });
  insertEntry({ title: 'snakeXcase Kurs', amount: -12, date: '2033-03-06' });
  const pct = await call('GET', `/?q=${encodeURIComponent('50%')}`);
  assert.deepEqual(pct.body.data.map((e) => e.title), ['Rabatt 50% Schuhe']);
  const under = await call('GET', `/?q=${encodeURIComponent('e_c')}`);
  assert.deepEqual(under.body.data.map((e) => e.title), ['snake_case Kurs']);
});

test('GET /?q=: fremde private Buchungen fehlen, verdeckte Titel werden nicht gefunden', async () => {
  setMode('personal');
  insertEntry({ title: 'Geheimgeschenk privat', amount: -50, date: '2033-09-01', created_by: B, owner_id: B, visibility: 'private' });
  insertEntry({ title: 'Geheimgeschenk betrag', amount: -60, date: '2033-09-02', created_by: B, owner_id: B, visibility: 'shared_amount' });
  insertEntry({ title: 'Geheimgeschenk offen', amount: -70, date: '2033-09-03', created_by: B, owner_id: B, visibility: 'shared' });
  const r = await call('GET', '/?q=geheim&scope=household', { as: { id: A, role: 'member' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((e) => e.title), ['Geheimgeschenk offen']);
  const owner = await call('GET', '/?q=geheim&scope=mine', { as: { id: B, role: 'member' } });
  assert.equal(owner.body.data.length, 3, 'die eigene Buchung findet ihr Besitzer in jeder Stufe');
});

test('GET /?q=: begrenzt die Treffer und sagt es', async () => {
  for (let i = 0; i < 205; i += 1) insertEntry({ title: `Kaffeebar ${i}`, amount: -3, date: `2034-01-${String((i % 28) + 1).padStart(2, '0')}` });
  const r = await call('GET', '/?q=kaffeebar');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 200);
  assert.equal(r.body.meta?.truncated, true);
  const leer = await call('GET', '/?q=%20%20');
  assert.equal(leer.status, 400, 'eine leere Suche ist keine Monatsliste ohne Monat');
});

// ── #1545: die Serie hat ihren eigenen Starttag ─────────────────────────────
//
// Bis v228 war der Starttag das Datum der ersten Buchung: occurrenceDatesInMonth()
// leitet jedes spaetere Vorkommen aus ihm ab. Eine Korrektur NUR der ersten
// Buchung ("abgebucht am 6., nicht am 5.") verschob deshalb das Raster jedes
// Vorkommens, das noch nicht angelegt war. Seit v229 steht der Starttag in der
// Definition; verlegen laesst er sich nur ausdruecklich ueber `start_date`.

const seriesDates = (anchorId, month) => db.prepare(
  'SELECT date FROM budget_entries WHERE recurrence_parent_id = ? AND date BETWEEN ? AND ? ORDER BY date'
).all(anchorId, `${month}-01`, `${month}-31`).map((r) => r.date);
const startOf = (anchorId) => db.prepare('SELECT start_date FROM budget_series WHERE anchor_id = ?').get(anchorId)?.start_date;

test('#1545: Datumskorrektur NUR der ersten Buchung verschiebt keine kuenftigen Vorkommen (monatlich)', async () => {
  const pid = insertEntry({ title: 'Miete 1545', amount: -900, date: '2000-01-05', is_recurring: 1 });
  const r = await call('PUT', `/${pid}`, { body: { date: '2000-01-06' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.date, '2000-01-06', 'die Buchung selbst ist korrigiert');
  await generatedIn('2099-12', pid);
  assert.deepEqual(seriesDates(pid, '2099-12'), ['2099-12-05'], 'das Raster bleibt am 5.');
  assert.equal(startOf(pid), '2000-01-05');
});

test('#1545: Datumskorrektur NUR der ersten Buchung laesst auch das Wochenraster stehen', async () => {
  // Alle zwei Wochen ab Mittwoch, 5.1.2000 - korrigiert auf Donnerstag, den 6.
  // Bis v228 lagen danach ALLE kuenftigen Vorkommen auf einem Donnerstag.
  const pid = insertEntry({ title: 'Kurs 1545', amount: -20, date: '2000-01-05', is_recurring: 1, recurrence_interval: 'weekly' });
  db.prepare('UPDATE budget_entries SET recurrence_interval_count = 2 WHERE id = ?').run(pid);
  const before = (await call('PUT', `/${pid}`, { body: { date: '2000-01-06' } })).status;
  assert.equal(before, 200);
  await generatedIn('2099-12', pid);
  const dates = seriesDates(pid, '2099-12');
  assert.ok(dates.length >= 2);
  for (const d of dates) {
    assert.equal(new Date(`${d}T00:00:00Z`).getUTCDay(), 3, `${d} liegt auf einem Mittwoch wie der Starttag`);
  }
});

test('#1545: "alle kuenftigen" mit start_date verlegt das Raster, die gebuchte erste Buchung bleibt', async () => {
  const pid = insertEntry({ title: 'Strom 1545', amount: -80, date: '2000-01-05', is_recurring: 1 });
  await generatedIn('2099-11', pid);
  assert.deepEqual(seriesDates(pid, '2099-11'), ['2099-11-05']);
  const r = await call('PUT', `/${pid}/series`, { body: { start_date: '2000-01-06' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.series.start_date, '2000-01-06');
  assert.equal(r.body.data.date, '2000-01-05', 'die erste Buchung ist gebucht und behaelt ihr Datum');
  assert.deepEqual(seriesDates(pid, '2099-11'), [], 'die kuenftige Instanz faellt wie bei einem Rhythmuswechsel');
  await generatedIn('2099-11', pid);
  assert.deepEqual(seriesDates(pid, '2099-11'), ['2099-11-06'], 'und entsteht am neuen Tag neu');
});

test('#1545: `date` im Serien-Body bleibt wirkungslos, nur start_date verlegt den Starttag', async () => {
  const pid = insertEntry({ title: 'Wasser 1545', amount: -30, date: '2000-01-05', is_recurring: 1 });
  await generatedIn('2099-10', pid);
  const r = await call('PUT', `/${pid}/series`, { body: { title: 'Wasser neu', date: '2000-01-09' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.series.start_date, '2000-01-05');
  assert.deepEqual(seriesDates(pid, '2099-10'), ['2099-10-05']);
});

test('#1545: liegt die erste Buchung noch vor uns, zieht sie mit dem Starttag mit', async () => {
  const pid = insertEntry({ title: 'Abo 1545', amount: -10, date: '2099-06-05', is_recurring: 1 });
  const r = await call('PUT', `/${pid}/series`, { body: { start_date: '2099-06-07' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.date, '2099-06-07');
  assert.equal(startOf(pid), '2099-06-07');
  await generatedIn('2099-07', pid);
  assert.deepEqual(seriesDates(pid, '2099-07'), ['2099-07-07']);
  assert.deepEqual(seriesDates(pid, '2099-06'), [], 'der Starttag ist die erste Buchung, keine zweite');
});

test('#1545: ein Starttag ab heute bei gebuchter erster Buchung bekommt sein Vorkommen', async () => {
  // Der Monatsaufruf legt den Starttag nie an - das ist die erste Buchung. Bleibt
  // die gebucht stehen, haette der neue Starttag sonst keine Buchung.
  const pid = insertEntry({ title: 'Garten 1545', amount: -15, date: '2000-01-05', is_recurring: 1 });
  const r = await call('PUT', `/${pid}/series`, { body: { start_date: '2099-03-06' } });
  assert.equal(r.status, 200);
  assert.deepEqual(seriesDates(pid, '2099-03'), ['2099-03-06']);
  await generatedIn('2099-03', pid);
  assert.deepEqual(seriesDates(pid, '2099-03'), ['2099-03-06'], 'kein zweites am selben Tag');
  await generatedIn('2099-02', pid);
  assert.deepEqual(seriesDates(pid, '2099-02'), [], 'vor dem neuen Starttag entsteht nichts');
  await generatedIn('2099-04', pid);
  assert.deepEqual(seriesDates(pid, '2099-04'), ['2099-04-06']);
});

test('#1545: ein ungueltiger Starttag wird abgewiesen', async () => {
  const pid = insertEntry({ title: 'Fehler 1545', amount: -1, date: '2000-01-05', is_recurring: 1 });
  for (const start_date of ['2000-02-30', '05.01.2000', null]) {
    const r = await call('PUT', `/${pid}/series`, { body: { start_date } });
    assert.equal(r.status, 400, String(start_date));
  }
  assert.equal(startOf(pid), '2000-01-05');
});

test('#1545: vor den Monat der gebuchten ersten Buchung laesst sich der Starttag nicht legen', async () => {
  // Der Monatsaufruf laesst nur den MONAT des Starttags aus - er gehoert der
  // ersten Buchung. Laege der Starttag einen Monat frueher, entstuende im Monat
  // der ersten Buchung ein zweites Vorkommen neben ihr (Review-Befund in #1585),
  // und davor Buchungen, die es vor dem Beginn der Serie nie gab.
  const pid = insertEntry({ title: 'Frueher 1545', amount: -50, date: '2000-02-05', is_recurring: 1 });
  const r = await call('PUT', `/${pid}/series`, { body: { start_date: '2000-01-05' } });
  assert.equal(r.status, 400);
  assert.equal(startOf(pid), '2000-02-05');
  await generatedIn('2000-02', pid);
  assert.deepEqual(seriesDates(pid, '2000-02'), [], 'keine Doublette neben der ersten Buchung');
  // Im selben Monat bleibt es erlaubt: "ab jetzt am 4. statt am 5.".
  const same = await call('PUT', `/${pid}/series`, { body: { start_date: '2000-02-04' } });
  assert.equal(same.status, 200);
  assert.equal(startOf(pid), '2000-02-04');
  await generatedIn('2000-02', pid);
  assert.deepEqual(seriesDates(pid, '2000-02'), []);
});

test('#1545: liegt die erste Buchung noch vor uns, darf der Starttag auch frueher liegen - sie zieht mit', async () => {
  const pid = insertEntry({ title: 'Vorgezogen 1545', amount: -50, date: '2099-08-05', is_recurring: 1 });
  const r = await call('PUT', `/${pid}/series`, { body: { start_date: '2099-06-05' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.date, '2099-06-05');
  await generatedIn('2099-06', pid);
  assert.deepEqual(seriesDates(pid, '2099-06'), []);
  await generatedIn('2099-07', pid);
  assert.deepEqual(seriesDates(pid, '2099-07'), ['2099-07-05']);
});

// Review-Befund in #1585: nach einem verlegten Starttag (oder einem neuen
// Rhythmus) raeumt die Serien-Aenderung nur ab heute ab. Ein vergangener Monat,
// der seine Vorkommen schon hat, bekam beim naechsten Aufruf ein zweites auf
// dem neuen Raster daneben - zwei Buchungen fuer einen Zeitraum, beide in jeder
// Summe und im Kontosaldo. Vor heute wird deshalb nach einer Rasteraenderung
// nichts mehr erzeugt.

test('#1545: ein verlegter Starttag legt in vergangenen Monaten kein zweites Vorkommen an', async () => {
  const pid = insertEntry({ title: 'Raster 1545', amount: -70, date: '2000-01-05', is_recurring: 1 });
  await generatedIn('2000-03', pid);
  await generatedIn('2000-08', pid);
  assert.deepEqual(seriesDates(pid, '2000-03'), ['2000-03-05']);
  // Tag im selben Monat wie die erste Buchung verschoben ...
  assert.equal((await call('PUT', `/${pid}/series`, { body: { start_date: '2000-01-04' } })).status, 200);
  await generatedIn('2000-03', pid);
  assert.deepEqual(seriesDates(pid, '2000-03'), ['2000-03-05'], 'Maerz bleibt bei seiner einen Buchung');
  // ... und in einen spaeteren vergangenen Monat.
  assert.equal((await call('PUT', `/${pid}/series`, { body: { start_date: '2000-06-20' } })).status, 200);
  await generatedIn('2000-08', pid);
  assert.deepEqual(seriesDates(pid, '2000-08'), ['2000-08-05'], 'August ebenso');
  await generatedIn('2099-08', pid);
  assert.deepEqual(seriesDates(pid, '2099-08'), ['2099-08-20'], 'ab heute gilt das neue Raster');
});

test('#1545: auch ein neuer Rhythmus legt in vergangenen Monaten kein zweites Vorkommen an', async () => {
  const pid = insertEntry({ title: 'Rhythmus 1545', amount: -70, date: '2000-01-05', is_recurring: 1 });
  await generatedIn('2000-03', pid);
  assert.equal((await call('PUT', `/${pid}/series`, {
    body: { recurrence_interval: 'weekly', recurrence_interval_count: 1 },
  })).status, 200);
  await generatedIn('2000-03', pid);
  assert.deepEqual(seriesDates(pid, '2000-03'), ['2000-03-05'], 'keine Wochentermine neben der Maerz-Buchung');
  await generatedIn('2099-08', pid);
  assert.ok(seriesDates(pid, '2099-08').length >= 4, 'ab heute woechentlich');
});

// Entscheidung in #1585 ("Vergangenheit einfrieren"): vor einer Rasteraenderung
// entstehen alle noch fehlenden Vorkommen vom Start bis gestern im ALTEN Raster.
// Ohne das bliebe ein vergangener Monat, der nie aufgeschlagen wurde, leer -
// vor grid_from entsteht nichts mehr, und das alte Raster kennt danach niemand.

test('#1585: ein nie geoeffneter vergangener Monat traegt nach einem Rhythmuswechsel die alten Buchungen', async () => {
  const pid = insertEntry({ title: 'Einfrieren R 1545', amount: -40, date: '2000-01-05', is_recurring: 1 });
  const r = await call('PUT', `/${pid}/series`, {
    body: { title: 'Neuer Titel', recurrence_interval: 'weekly', recurrence_interval_count: 1 },
  });
  assert.equal(r.status, 200);
  await generatedIn('2000-05', pid);
  assert.deepEqual(seriesDates(pid, '2000-05'), ['2000-05-05'], 'Mai 2000 im alten, monatlichen Raster');
  const may = db.prepare("SELECT title FROM budget_entries WHERE recurrence_parent_id = ? AND date = '2000-05-05'").get(pid);
  assert.equal(may.title, 'Einfrieren R 1545', 'mit den Werten vor der Aenderung');
  await generatedIn('2099-08', pid);
  assert.ok(seriesDates(pid, '2099-08').length >= 4, 'ab heute woechentlich');
});

test('#1585: ein nie geoeffneter vergangener Monat traegt nach einem verlegten Starttag die alten Buchungen', async () => {
  const pid = insertEntry({ title: 'Einfrieren S 1545', amount: -40, date: '2000-01-05', is_recurring: 1 });
  assert.equal((await call('PUT', `/${pid}/series`, { body: { start_date: '2000-01-20' } })).status, 200);
  await generatedIn('2003-07', pid);
  assert.deepEqual(seriesDates(pid, '2003-07'), ['2003-07-05']);
  await generatedIn('2099-08', pid);
  assert.deepEqual(seriesDates(pid, '2099-08'), ['2099-08-20']);
});

test('#1585: Einfrieren legt nichts doppelt an und keinen geloeschten Monat wieder an', async () => {
  const pid = insertEntry({ title: 'Einfrieren D 1545', amount: -40, date: '2000-01-05', is_recurring: 1 });
  await generatedIn('2000-02', pid);
  await generatedIn('2000-03', pid);
  const march = db.prepare("SELECT id FROM budget_entries WHERE recurrence_parent_id = ? AND date = '2000-03-05'").get(pid).id;
  assert.equal((await call('DELETE', `/${march}`)).status, 204);
  assert.equal((await call('PUT', `/${pid}/series`, { body: { recurrence_interval_count: 2 } })).status, 200);
  assert.deepEqual(seriesDates(pid, '2000-02'), ['2000-02-05']);
  assert.deepEqual(seriesDates(pid, '2000-03'), [], 'die geloeschte Maerz-Buchung bleibt geloescht');
  const perMonth = db.prepare(`
    SELECT strftime('%Y-%m', date) AS m, COUNT(*) AS c FROM budget_entries
    WHERE recurrence_parent_id = ? GROUP BY m HAVING c > 1
  `).all(pid);
  assert.deepEqual(perMonth, [], 'kein Monat mit zwei Buchungen');
});

test('#1585: Rhythmuswechsel ueber PUT /:id an der ersten Buchung - Vergangenheit eingefroren, ab heute neu, keine Doubletten', async () => {
  const pid = insertEntry({ title: 'Einfrieren A 1545', amount: -40, date: '2000-01-05', is_recurring: 1 });
  await generatedIn('2000-03', pid);
  await generatedIn('2099-08', pid);
  assert.deepEqual(seriesDates(pid, '2099-08'), ['2099-08-05']);
  const r = await call('PUT', `/${pid}`, { body: { recurrence_interval: 'weekly', recurrence_interval_count: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual(seriesDates(pid, '2099-08'), [], 'das kuenftige Vorkommen im alten Raster ist weg');
  await generatedIn('2000-03', pid);
  assert.deepEqual(seriesDates(pid, '2000-03'), ['2000-03-05'], 'kein Wochentermin neben der Maerz-Buchung');
  await generatedIn('2001-06', pid);
  assert.deepEqual(seriesDates(pid, '2001-06'), ['2001-06-05'], 'nie geoeffneter Monat im alten Raster');
  await generatedIn('2099-08', pid);
  const aug = seriesDates(pid, '2099-08');
  assert.ok(aug.length >= 4, 'ab heute woechentlich');
  for (const d of aug) {
    assert.equal(new Date(`${d}T00:00:00Z`).getUTCDay(), 3, `${d}: nur Mittwoche wie der Starttag, kein Rest des alten Rasters`);
  }
});

// --- #1668: jede Absage der Budget-Routen traegt ihren Grund -----------------
// Die Seite schrieb an 13 Stellen den Satz des Servers in einen Toast. Damit sie
// stattdessen ihren eigenen Satz am richtigen Feld zeigen kann, nennt jede 400
// und 409 der Schreibrouten einen `reason`. Der Satz in `error` ist die
// zugesagte Antwort der API und bleibt Wort fuer Wort - mit einer Ausnahme:
// validateAccountRef antwortete deutsch ("Konto nicht gefunden."), das war ein
// Fehler und heisst jetzt "Account not found.".
// Nachtrag: die deutschen Feldnamen und Saetze, die diese Tabelle damals
// woertlich festhielt ("Titel is required.", "Intervall-Anzahl muss ..."), sind
// seither englisch; Status und `reason` jeder Zeile sind dieselben geblieben.
// Dass keiner zurueckkommt, haelt test:budget-error-language.
test('#1668: jede Absage von Buchung, Serie, Konto, Kategorie und Rate nennt ihren Grund, der Satz bleibt', async () => {
  setMode('shared');
  const ADM = { id: ADMIN, role: 'admin' };
  const EXPECTED = {
    'e-title': { status: 400, reason: 'entry_title_invalid', error: 'Title is required.' },
    'e-amount': { status: 400, reason: 'entry_amount_invalid', error: 'Amount is required.' },
    'e-category': { status: 400, reason: 'entry_category_invalid', error: 'Category must be one of: Erwerbseinkommen, Geschenke & Transfers, Kapitalerträge, Sonstiges Einkommen, Sozialleistungen, education, financial_other, food, housing, leisure, personal_health, shopping_clothing, subscriptions, transport.' },
    'e-date': { status: 400, reason: 'entry_date_invalid', error: 'Date must be in YYYY-MM-DD format.' },
    'e-interval': { status: 400, reason: 'entry_recurrence_invalid', error: 'Interval must be one of: weekly, monthly, yearly.' },
    'e-count': { status: 400, reason: 'entry_interval_count_invalid', error: 'Interval count must be between 1 and 99.' },
    'e-sub': { status: 400, reason: 'entry_subcategory_invalid', error: 'Invalid subcategory.' },
    'e-account': { status: 400, reason: 'entry_account_invalid', error: 'Account not found.' },
    'e-account-nan': { status: 400, reason: 'entry_account_invalid', error: 'account_id must be a valid account id.' },
    'e-two': { status: 400, reason: 'entry_title_invalid', error: 'Title is required. Amount is required. Date must be in YYYY-MM-DD format.' },
    'p-title': { status: 400, reason: 'entry_title_invalid', error: 'Title may be at most 200 characters long.' },
    'p-amount': { status: 400, reason: 'entry_amount_invalid', error: 'Amount must be a valid number.' },
    'p-category': { status: 400, reason: 'entry_category_invalid', error: 'Category must be one of: Erwerbseinkommen, Geschenke & Transfers, Kapitalerträge, Sonstiges Einkommen, Sozialleistungen, education, financial_other, food, housing, leisure, personal_health, shopping_clothing, subscriptions, transport.' },
    'p-date': { status: 400, reason: 'entry_date_invalid', error: 'Date must be in YYYY-MM-DD format.' },
    'p-interval': { status: 400, reason: 'entry_recurrence_invalid', error: 'Interval must be one of: weekly, monthly, yearly.' },
    'p-count': { status: 400, reason: 'entry_interval_count_invalid', error: 'Interval count must be between 1 and 99.' },
    'p-sub': { status: 400, reason: 'entry_subcategory_invalid', error: 'Invalid subcategory.' },
    'p-account': { status: 400, reason: 'entry_account_invalid', error: 'Account not found.' },
    's-notrec': { status: 400, reason: 'entry_not_recurring', error: 'Not a recurring entry.' },
    'sd-notrec': { status: 400, reason: 'entry_not_recurring', error: 'Not a recurring entry.' },
    'c-booked': { status: 400, reason: 'entry_already_booked', error: 'Entry is already booked.' },
    's-title': { status: 400, reason: 'entry_title_invalid', error: 'Title may be at most 200 characters long.' },
    's-amount': { status: 400, reason: 'entry_amount_invalid', error: 'Amount must be a valid number.' },
    's-category': { status: 400, reason: 'entry_category_invalid', error: 'Category must be one of: Erwerbseinkommen, Geschenke & Transfers, Kapitalerträge, Sonstiges Einkommen, Sozialleistungen, education, financial_other, food, housing, leisure, personal_health, shopping_clothing, subscriptions, transport.' },
    's-interval': { status: 400, reason: 'entry_recurrence_invalid', error: 'Interval must be one of: weekly, monthly, yearly.' },
    's-count': { status: 400, reason: 'entry_interval_count_invalid', error: 'Interval count must be between 1 and 99.' },
    's-start': { status: 400, reason: 'entry_start_date_invalid', error: 'start_date must be in YYYY-MM-DD format.' },
    's-end': { status: 400, reason: 'series_end_refused', error: 'A series edit cannot end the series. To end it, set is_recurring to false on its first entry (PUT /budget/:id) or delete it (DELETE /budget/:id/series).' },
    's-account': { status: 400, reason: 'entry_account_invalid', error: 'Account not found.' },
    's-early': { status: 400, reason: 'series_start_too_early', error: 'The start day of a series cannot lie in a month before its first entry once that entry is booked.' },
    'c-amount': { status: 400, reason: 'entry_amount_invalid', error: 'Amount must be a valid number.' },
    'c-date': { status: 400, reason: 'entry_date_invalid', error: 'Date must be in YYYY-MM-DD format.' },
    'a-name': { status: 400, reason: 'account_name_invalid', error: 'Name is required.' },
    'a-type': { status: 400, reason: 'account_type_invalid', error: 'Account type must be one of: checking, savings, cash, credit, investment, other.' },
    'a-balance': { status: 400, reason: 'account_balance_invalid', error: 'Starting balance must be a valid number.' },
    'a-color': { status: 400, reason: 'account_color_invalid', error: 'Color must be a valid HEX color (#RRGGBB).' },
    'a-bank': { status: 400, reason: 'account_credit_bank_invalid', error: 'Bank may be at most 100 characters long.' },
    'a-limit': { status: 400, reason: 'account_credit_limit_invalid', error: 'Credit limit must be a valid number.' },
    'a-limit-neg': { status: 400, reason: 'account_credit_limit_invalid', error: 'Credit limit must not be negative.' },
    'ap-name': { status: 400, reason: 'account_name_invalid', error: 'Name is required.' },
    'ap-type': { status: 400, reason: 'account_type_invalid', error: 'Account type must be one of: checking, savings, cash, credit, investment, other.' },
    'ap-balance': { status: 400, reason: 'account_balance_invalid', error: 'Starting balance must be a valid number.' },
    'ap-color': { status: 400, reason: 'account_color_invalid', error: 'Color must be a valid HEX color (#RRGGBB).' },
    'ap-bank': { status: 400, reason: 'account_credit_bank_invalid', error: 'Bank may be at most 100 characters long.' },
    'ap-limit': { status: 400, reason: 'account_credit_limit_invalid', error: 'Credit limit must be a valid number.' },
    'ap-limit-neg': { status: 400, reason: 'account_credit_limit_invalid', error: 'Credit limit must not be negative.' },
    'k-name': { status: 400, reason: 'category_name_invalid', error: 'Name is required.' },
    'k-type': { status: 400, reason: 'category_type_invalid', error: 'Type must be one of: expense, income.' },
    'k-dup': { status: 409, reason: 'category_exists', error: 'Category already exists.' },
    'kp-name': { status: 400, reason: 'category_name_invalid', error: 'Name is required.' },
    'kr-type': { status: 400, reason: 'category_type_invalid', error: 'Type must be one of: expense, income.' },
    'ks-name': { status: 400, reason: 'subcategory_name_invalid', error: 'Name is required.' },
    'ks-dup': { status: 409, reason: 'subcategory_exists', error: 'Subcategory already exists.' },
    'ksp-name': { status: 400, reason: 'subcategory_name_invalid', error: 'Name is required.' },
    'l-amount': { status: 400, reason: 'loan_payment_amount_invalid', error: 'Amount must be a valid number.' },
    'l-date': { status: 400, reason: 'loan_payment_date_invalid', error: 'Paid date must be in YYYY-MM-DD format.' },
    'l-number': { status: 400, reason: 'loan_payment_installment_invalid', error: 'Installment number is invalid.' },
    'l-zero': { status: 400, reason: 'loan_payment_amount_invalid', error: 'Amount must be greater than zero.' },
    'l-exceeds': { status: 400, reason: 'loan_payment_amount_exceeds', error: 'Amount cannot be greater than the remaining loan amount.' },
    'l-three': { status: 400, reason: 'loan_payment_date_invalid', error: 'Paid date must be in YYYY-MM-DD format. Installment number is invalid. Amount cannot be greater than the remaining loan amount.' },
    'l-paid': { status: 409, reason: 'loan_installment_paid', error: 'Installment already paid.' },
    'p-loan-zero': { status: 400, reason: 'entry_amount_invalid', error: 'Amount must be greater than zero.' },
    'p-loan-exceeds': { status: 400, reason: 'entry_amount_exceeds_loan', error: 'Amount cannot be greater than the remaining loan amount.' },
    'l-settled': { status: 409, reason: 'loan_settled', error: 'Loan is already paid.' },
  };
  const seen = [];
  const run = async (label, method, route, body) => {
    const r = await call(method, route, { as: ADM, body });
    const want = EXPECTED[label];
    assert.ok(want, `Vorbedingung: ${label} ist gefuehrt`);
    assert.deepEqual(
      { status: r.status, body: r.body },
      { status: want.status, body: { error: want.error, code: want.status, reason: want.reason } },
      `${label}: ${method} ${route}`,
    );
    seen.push(label);
    return r;
  };
  const ok = { title: 'T', amount: -5, date: '2030-01-10' };
  const long = 'x'.repeat(300);
  await run('e-title', 'POST', '/', { amount: -5, date: '2030-01-10' });
  await run('e-amount', 'POST', '/', { title: 'T', date: '2030-01-10' });
  await run('e-category', 'POST', '/', { ...ok, category: 'nope' });
  await run('e-date', 'POST', '/', { ...ok, date: 'nope' });
  await run('e-interval', 'POST', '/', { ...ok, is_recurring: 1, recurrence_interval: 'hourly' });
  await run('e-count', 'POST', '/', { ...ok, is_recurring: 1, recurrence_interval_count: 0 });
  await run('e-sub', 'POST', '/', { ...ok, subcategory: 'nope' });
  await run('e-account', 'POST', '/', { ...ok, account_id: 987654 });
  await run('e-account-nan', 'POST', '/', { ...ok, account_id: 'abc' });
  await run('e-two', 'POST', '/', { date: 'nope' });
  const made = await call('POST', '/', { as: ADM, body: ok }); const id = made.body.data.id;
  await run('p-title', 'PUT', `/${id}`, { title: long });
  await run('p-amount', 'PUT', `/${id}`, { amount: 'abc' });
  await run('p-category', 'PUT', `/${id}`, { category: 'nope' });
  await run('p-date', 'PUT', `/${id}`, { date: 'nope' });
  await run('p-interval', 'PUT', `/${id}`, { recurrence_interval: 'hourly' });
  await run('p-count', 'PUT', `/${id}`, { recurrence_interval_count: 0 });
  await run('p-sub', 'PUT', `/${id}`, { subcategory: 'nope' });
  await run('p-account', 'PUT', `/${id}`, { account_id: 987654 });
  await run('s-notrec', 'PUT', `/${id}/series`, { title: 'X' });
  await run('sd-notrec', 'DELETE', `/${id}/series`);
  await run('c-booked', 'PATCH', `/${id}/confirm`, {});
  const rec = await call('POST', '/', { as: ADM, body: { ...ok, is_recurring: 1, recurrence_interval: 'monthly' } }); const rid = rec.body.data.id;
  await run('s-title', 'PUT', `/${rid}/series`, { title: long });
  await run('s-amount', 'PUT', `/${rid}/series`, { amount: 'abc' });
  await run('s-category', 'PUT', `/${rid}/series`, { category: 'nope' });
  await run('s-interval', 'PUT', `/${rid}/series`, { recurrence_interval: 'hourly' });
  await run('s-count', 'PUT', `/${rid}/series`, { recurrence_interval_count: 0 });
  await run('s-start', 'PUT', `/${rid}/series`, { start_date: 'nope' });
  await run('s-end', 'PUT', `/${rid}/series`, { is_recurring: false });
  await run('s-account', 'PUT', `/${rid}/series`, { account_id: 987654 });
  const old = await call('POST', '/', { as: ADM, body: { ...ok, date: '2020-06-15', is_recurring: 1, recurrence_interval: 'monthly' } });
  await run('s-early', 'PUT', `/${old.body.data.id}/series`, { start_date: '2020-05-01' });
  const pend = db.prepare("INSERT INTO budget_entries (title, amount, category, subcategory, date, is_pending, created_by, owner_id, visibility) VALUES ('P', -5, 'food', '', '2030-01-10', 1, ?, ?, 'shared')").run(ADMIN, ADMIN).lastInsertRowid;
  await run('c-amount', 'PATCH', `/${pend}/confirm`, { amount: 'abc' });
  await run('c-date', 'PATCH', `/${pend}/confirm`, { date: 'nope' });
  // Konten
  await run('a-name', 'POST', '/accounts', {});
  await run('a-type', 'POST', '/accounts', { name: 'N', type: 'nope' });
  await run('a-balance', 'POST', '/accounts', { name: 'N', starting_balance: 'abc' });
  await run('a-color', 'POST', '/accounts', { name: 'N', color: 'nope' });
  await run('a-bank', 'POST', '/accounts', { name: 'N', credit_bank: long });
  await run('a-limit', 'POST', '/accounts', { name: 'N', credit_limit: 'abc' });
  await run('a-limit-neg', 'POST', '/accounts', { name: 'N', credit_limit: -1 });
  const acc = await call('POST', '/accounts', { as: ADM, body: { name: 'Giro' } }); const aid = acc.body.data.id;
  await run('ap-name', 'PUT', `/accounts/${aid}`, { name: '' });
  await run('ap-type', 'PUT', `/accounts/${aid}`, { type: 'nope' });
  await run('ap-balance', 'PUT', `/accounts/${aid}`, { starting_balance: 'abc' });
  await run('ap-color', 'PUT', `/accounts/${aid}`, { color: 'nope' });
  await run('ap-bank', 'PUT', `/accounts/${aid}`, { credit_bank: long });
  await run('ap-limit', 'PUT', `/accounts/${aid}`, { credit_limit: 'abc' });
  await run('ap-limit-neg', 'PUT', `/accounts/${aid}`, { credit_limit: -1 });
  // Kategorien
  await run('k-name', 'POST', '/categories', {});
  await run('k-type', 'POST', '/categories', { name: 'Neu', type: 'nope' });
  const cat = await call('POST', '/categories', { as: ADM, body: { name: 'Probe1668' } }); const key = cat.body.data.key;
  await run('k-dup', 'POST', '/categories', { name: 'probe1668' });
  await run('kp-name', 'PUT', `/categories/${key}`, { name: '' });
  await run('kr-type', 'PATCH', '/categories/reorder', { type: 'nope', order: [] });
  await run('ks-name', 'POST', `/categories/${key}/subcategories`, {});
  const sub = await call('POST', `/categories/${key}/subcategories`, { as: ADM, body: { name: 'Unter1668' } });
  await run('ks-dup', 'POST', `/categories/${key}/subcategories`, { name: 'unter1668' });
  await run('ksp-name', 'PUT', `/categories/${key}/subcategories/${sub.body.data.key}`, { name: '' });
  // Raten
  const loan = await call('POST', '/loans', { as: ADM, body: { borrower: 'R', title: 'R', total_amount: 1200, installment_count: 12, start_month: '2026-01' } });
  const lid = loan.body.data.id;
  await run('l-amount', 'POST', `/loans/${lid}/payments`, { amount: 'abc', paid_date: '2026-01-05' });
  await run('l-date', 'POST', `/loans/${lid}/payments`, { amount: 100, paid_date: 'nope' });
  await run('l-number', 'POST', `/loans/${lid}/payments`, { installment_number: 99, amount: 100, paid_date: '2026-01-05' });
  await run('l-zero', 'POST', `/loans/${lid}/payments`, { amount: 0, paid_date: '2026-01-05' });
  await run('l-exceeds', 'POST', `/loans/${lid}/payments`, { amount: 99999, paid_date: '2026-01-05' });
  await run('l-three', 'POST', `/loans/${lid}/payments`, { installment_number: 99, amount: 99999, paid_date: 'nope' });
  const pay = await call('POST', `/loans/${lid}/payments`, { as: ADM, body: { installment_number: 1, amount: 100, paid_date: '2026-01-05' } });
  await run('l-paid', 'POST', `/loans/${lid}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-01-05' });
  const eid = pay.body.data?.payment?.budget_entry_id ?? db.prepare('SELECT budget_entry_id FROM budget_loan_payments WHERE loan_id = ?').get(lid).budget_entry_id;
  await run('p-loan-zero', 'PUT', `/${eid}`, { amount: 0 });
  await run('p-loan-exceeds', 'PUT', `/${eid}`, { amount: 99999 });
  const done = await call('POST', '/loans', { as: ADM, body: { borrower: 'S', title: 'S', total_amount: 100, installment_count: 1, start_month: '2026-01', paid_installments: 1 } });
  await run('l-settled', 'POST', `/loans/${done.body.data.id}/payments`, { amount: 10, paid_date: '2026-01-05' });

  // Zustaendig kann nur sein, wer zum Haushalt gehoert (#1207) - ein Gast der
  // geteilten Ausgaben nicht.
  const guest = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('gast1668','Gast','x','member')").run().lastInsertRowid;
  db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(guest);
  for (const [method, route, extra] of [['POST', '/', ok], ['PUT', `/${id}`, {}], ['PUT', `/${rid}/series`, {}]]) {
    const r = await call(method, route, { as: ADM, body: { ...extra, responsible_user_ids: [guest] } });
    assert.deepEqual(r.body, {
      error: `Only household members can be chosen here - user ${guest} is not a household member.`,
      code: 400,
      reason: 'entry_responsible_invalid',
    }, `${method} ${route}`);
  }
  assert.deepEqual(seen.sort(), Object.keys(EXPECTED).sort(), 'jeder gefuehrte Fall wurde gefahren');
});
