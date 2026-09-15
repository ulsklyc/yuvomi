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
  assert.match(r.body.error, /Konto/);
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
  assert.match(r.body.error, /Intervall/);
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
  assert.match(r.body.error, /Betrag/);
});

test('PUT /:id: unbekanntes Konto → 400', async () => {
  const id = insertEntry({ title: 'acc-bad', amount: -5, category: 'food', date: '2033-05-21' });
  const r = await call('PUT', `/${id}`, { body: { account_id: 888888 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Konto/);
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
  assert.match(r.body.error, /Betrag/);
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
  assert.match(r.body.error, /Konto/);
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
  assert.deepEqual(who(pid), [B], 'das Original traegt die neue Zustaendigkeit');
  assert.deepEqual(who(future), [B], 'kuenftige Instanz zieht nach');
  assert.deepEqual(who(past), [A], 'eine gebuchte Vergangenheit bleibt, wie sie war');
});
