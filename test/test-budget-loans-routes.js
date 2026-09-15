/**
 * Test: Budget-Loans-Routen (Härtung, Sichtbarkeit #476/#505)
 * Zweck: End-to-End über den echten Loans-Router - Owner/visibility-Enforcement
 *        im personal-Modus: Default-Sichtbarkeit, Lese-Scope (private vs. shared),
 *        Edit-Gates (mayEdit) inkl. KEIN Admin-Bypass, sowie die Repayment-
 *        Erbung von owner_id/visibility. Der budget-visibility-Service ist in
 *        test-budget-visibility.js abgedeckt; hier zählt die Route-Durchsetzung.
 *        Kontrast: im shared-Modus sind alle Loans offen und editierbar.
 * Ausführen: node --experimental-sqlite --test test/test-budget-loans-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';

const dbmod = await import('../server/db.js');
const { default: loansRouter } = await import('../server/routes/budget/loans.js');
const db = dbmod.get();

const A = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')`).run().lastInsertRowid;
const B = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')`).run().lastInsertRowid;
const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;

function setMode(mode) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
}

let actor = { id: A, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', loansRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

async function createLoan(as, { title, visibility }) {
  const r = await call('POST', '/loans', {
    as,
    body: { borrower: title, title, total_amount: 1200, installment_count: 12, start_month: '2026-05', visibility },
  });
  return r;
}

async function listTitles(as, scope) {
  const q = scope ? `?scope=${scope}` : '';
  const r = await call('GET', `/loans${q}`, { as });
  return r.body.data.loans.map((l) => l.title);
}

const AA = { id: A, role: 'member' };
const BB = { id: B, role: 'member' };
const ADM = { id: ADMIN, role: 'admin' };

// --------------------------------------------------------------------------
// personal-Modus: Default-Sichtbarkeit + Scope
// --------------------------------------------------------------------------
test('personal: neuer Loan ohne visibility ist default privat, owner = Ersteller', async () => {
  setMode('personal');
  const r = await createLoan(AA, { title: 'A-privat-default' });
  assert.equal(r.status, 201);
  const id = r.body.data.id;
  const row = db.prepare('SELECT owner_id, visibility FROM budget_loans WHERE id = ?').get(id);
  assert.equal(row.visibility, 'private');
  assert.equal(row.owner_id, A);
});

test('personal: B sieht A privat NICHT, aber A shared - kein Admin-Bypass', async () => {
  setMode('personal');
  await createLoan(AA, { title: 'A-priv', visibility: 'private' });
  await createLoan(AA, { title: 'A-shared', visibility: 'shared' });

  const bTitles = await listTitles(BB);
  assert.ok(bTitles.includes('A-shared'), 'B sieht A shared');
  assert.ok(!bTitles.includes('A-priv'), 'B sieht A privat nicht');

  // Admin ebenfalls kein Zugriff auf A privat.
  const adminTitles = await listTitles(ADM);
  assert.ok(!adminTitles.includes('A-priv'), 'Admin sieht A privat nicht (kein Bypass)');
});

// --------------------------------------------------------------------------
// personal-Modus: Edit-Gates (mayEdit) - kein Admin-Bypass
// --------------------------------------------------------------------------
let PRIV_LOAN;
test('personal setup: A legt privaten Loan für Edit-Gates an', async () => {
  setMode('personal');
  const r = await createLoan(AA, { title: 'A-priv-edit', visibility: 'private' });
  PRIV_LOAN = r.body.data.id;
});

test('personal: B darf A privaten Loan nicht ändern -> 403', async () => {
  const r = await call('PUT', `/loans/${PRIV_LOAN}`, { as: BB, body: { title: 'hijack' } });
  assert.equal(r.status, 403);
});

test('personal: Admin darf A privaten Loan nicht ändern -> 403 (kein Bypass)', async () => {
  const r = await call('PUT', `/loans/${PRIV_LOAN}`, { as: ADM, body: { title: 'admin-hijack' } });
  assert.equal(r.status, 403);
});

test('personal: A (Eigentümer) darf eigenen Loan ändern', async () => {
  const r = await call('PUT', `/loans/${PRIV_LOAN}`, { as: AA, body: { title: 'A-neu' } });
  assert.equal(r.status, 200);
});

test('personal: B darf A privaten Loan nicht löschen -> 403', async () => {
  const r = await call('DELETE', `/loans/${PRIV_LOAN}`, { as: BB });
  assert.equal(r.status, 403);
});

test('personal: B darf keine Zahlung auf A privaten Loan buchen -> 403', async () => {
  const r = await call('POST', `/loans/${PRIV_LOAN}/payments`, { as: BB, body: { amount: 100 } });
  assert.equal(r.status, 403);
});

// --------------------------------------------------------------------------
// personal-Modus: Repayment erbt owner_id + visibility (#476/#505)
// --------------------------------------------------------------------------
test('personal: Ratenzahlung auf privaten Loan erzeugt privaten Budget-Eintrag desselben Owners', async () => {
  const pay = await call('POST', `/loans/${PRIV_LOAN}/payments`, { as: AA, body: { installment_number: 1, amount: 100, paid_date: '2026-05-15' } });
  assert.equal(pay.status, 201);
  const entryId = db.prepare('SELECT budget_entry_id FROM budget_loan_payments WHERE id = ?').get(pay.body.data.payment.id).budget_entry_id;
  const entry = db.prepare('SELECT owner_id, visibility FROM budget_entries WHERE id = ?').get(entryId);
  assert.equal(entry.visibility, 'private', 'Repayment-Eintrag erbt private');
  assert.equal(entry.owner_id, A, 'Repayment-Eintrag erbt Owner');
});

// --------------------------------------------------------------------------
// Kontrast: shared-Modus - alles offen und editierbar
// --------------------------------------------------------------------------
test('shared: B sieht A-Loans und darf sie ändern (mayEdit immer true)', async () => {
  setMode('shared');
  const created = await createLoan(AA, { title: 'shared-loan' });
  const id = created.body.data.id;

  const bTitles = await listTitles(BB);
  assert.ok(bTitles.includes('shared-loan'), 'B sieht Loan im shared-Modus');

  const edit = await call('PUT', `/loans/${id}`, { as: BB, body: { title: 'shared-loan-2' } });
  assert.equal(edit.status, 200, 'B darf im shared-Modus ändern');
});

test('nicht existierender Loan -> 404', async () => {
  const r = await call('PUT', '/loans/999999', { as: AA, body: { title: 'x' } });
  assert.equal(r.status, 404);
});

// --------------------------------------------------------------------------
// Zins-Darlehen (#569): Ableitung total_amount/installment_count + Prognose-Phase
// --------------------------------------------------------------------------
let INTEREST_LOAN;
test('POST interest fixed_then_variable: leitet Laufzeit + Gesamtbetrag ab, liefert Zins-Summary', async () => {
  setMode('shared');
  const r = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Hyp', title: 'Hypothek', start_month: '2026-01',
      interest_mode: 'fixed_then_variable', principal: 200000,
      fixed_rate: 2.5, initial_repayment_rate: 2, fixed_period_months: 180, followup_rate: 4,
    },
  });
  assert.equal(r.status, 201);
  INTEREST_LOAN = r.body.data.id;
  const row = db.prepare('SELECT interest_mode, principal, fixed_rate, initial_repayment_rate, fixed_period_months, followup_rate, total_amount, installment_count FROM budget_loans WHERE id = ?').get(INTEREST_LOAN);
  assert.equal(row.interest_mode, 'fixed_then_variable');
  assert.equal(row.principal, 200000);
  assert.equal(row.fixed_period_months, 180);
  assert.ok(row.installment_count > 180, 'Laufzeit über die Zinsbindung hinaus abgeleitet');
  assert.ok(row.total_amount > 200000, 'Gesamtbetrag enthält Zinsen');

  const s = r.body.data.interest;
  assert.ok(s, 'interest-Summary vorhanden');
  assert.ok(Math.abs(s.monthly_payment - 750) <= 0.02, `monthly_payment ${s.monthly_payment}`);
  assert.equal(s.binding_end_month, '2041-01');
  assert.ok(s.remaining_after_binding > 0);
  assert.ok(s.total_interest > 0);
});

test('POST interest: Rate deckt Zins nicht -> 400', async () => {
  const r = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Bad', start_month: '2026-01',
      interest_mode: 'fixed_then_variable', principal: 100000,
      fixed_rate: 1, initial_repayment_rate: 1, fixed_period_months: 12, followup_rate: 20,
    },
  });
  assert.equal(r.status, 400);
});

test('POST interest: fehlende Kreditsumme -> 400', async () => {
  const r = await call('POST', '/loans', {
    as: AA,
    body: { borrower: 'NoPrincipal', start_month: '2026-01', interest_mode: 'fixed', fixed_rate: 2.5, initial_repayment_rate: 2 },
  });
  assert.equal(r.status, 400);
});

test('PUT interest: geänderter Anschlusszins rechnet Laufzeit/Betrag neu', async () => {
  const before = db.prepare('SELECT total_amount, installment_count FROM budget_loans WHERE id = ?').get(INTEREST_LOAN);
  const r = await call('PUT', `/loans/${INTEREST_LOAN}`, {
    as: AA,
    body: {
      interest_mode: 'fixed_then_variable', principal: 200000,
      fixed_rate: 2.5, initial_repayment_rate: 2, fixed_period_months: 180, followup_rate: 6,
    },
  });
  assert.equal(r.status, 200);
  const after = db.prepare('SELECT total_amount, installment_count FROM budget_loans WHERE id = ?').get(INTEREST_LOAN);
  assert.ok(after.installment_count > before.installment_count, 'höherer Anschlusszins -> längere Laufzeit');
  assert.ok(after.total_amount > before.total_amount, 'höherer Anschlusszins -> mehr Gesamtzins');
});

test('GET interest-Loan: installment_amount = konstante Annuität, nicht total/count', async () => {
  const r = await call('GET', '/loans', { as: AA });
  const loan = r.body.data.loans.find((l) => l.id === INTEREST_LOAN);
  assert.ok(loan.interest, 'interest-Summary vorhanden');
  // Der gebuchte Ratenbetrag folgt der Annuität (monthly_payment), nicht dem
  // Laufzeit-Durchschnitt total_amount/installment_count (letzte Rate kleiner).
  assert.ok(Math.abs(loan.installment_amount - loan.interest.monthly_payment) <= 0.001,
    `installment_amount ${loan.installment_amount} == monthly ${loan.interest.monthly_payment}`);
  assert.ok(loan.installment_amount > loan.total_amount / loan.installment_count,
    'Annuität liegt über dem Laufzeit-Durchschnitt');
});

test('PUT ohne interest_mode: direkter total_amount-Edit auf Zinsdarlehen -> 400', async () => {
  const r = await call('PUT', `/loans/${INTEREST_LOAN}`, { as: AA, body: { total_amount: 123456 } });
  assert.equal(r.status, 400);
});

test('PUT ohne interest_mode: neutrales Feld (notes) auf Zinsdarlehen bleibt erlaubt', async () => {
  const r = await call('PUT', `/loans/${INTEREST_LOAN}`, { as: AA, body: { notes: 'Hinweis' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.interest_mode, 'fixed_then_variable', 'Zins-Terms unangetastet');
});

// --------------------------------------------------------------------------
// Rein variables Darlehen (#569-Nachtrag): ein Satz, keine Zinsbindung
// --------------------------------------------------------------------------
test('POST interest variable: speichert Modus ohne Bindungsfelder, rechnet wie fixed', async () => {
  setMode('shared');
  const variable = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Var', title: 'Variables Darlehen', start_month: '2026-01',
      interest_mode: 'variable', principal: 150000, fixed_rate: 3.5, initial_repayment_rate: 2,
      // Bindungsfelder mitgeschickt: dürfen im variablen Modus nicht landen.
      fixed_period_months: 120, followup_rate: 9,
    },
  });
  assert.equal(variable.status, 201);
  const row = db.prepare('SELECT interest_mode, fixed_rate, fixed_period_months, followup_rate, total_amount, installment_count FROM budget_loans WHERE id = ?').get(variable.body.data.id);
  assert.equal(row.interest_mode, 'variable');
  assert.equal(row.fixed_period_months, null);
  assert.equal(row.followup_rate, null);

  const s = variable.body.data.interest;
  assert.equal(s.mode, 'variable');
  assert.equal(s.binding_end_month, null, 'ohne Bindung kein Bindungs-Endmonat');
  assert.equal(s.remaining_after_binding, 0);

  // Gleiche Mathematik wie der Festzins-Modus mit identischen Eingaben.
  const fixed = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Fix', title: 'Vergleich fest', start_month: '2026-01',
      interest_mode: 'fixed', principal: 150000, fixed_rate: 3.5, initial_repayment_rate: 2,
    },
  });
  assert.equal(fixed.status, 201);
  assert.equal(row.installment_count, fixed.body.data.installment_count);
  assert.equal(s.monthly_payment, fixed.body.data.interest.monthly_payment);
});

test('PUT interest: Wechsel fixed_then_variable -> variable löscht die Bindungsfelder', async () => {
  const r = await call('PUT', `/loans/${INTEREST_LOAN}`, {
    as: AA,
    body: {
      interest_mode: 'variable', principal: 200000, fixed_rate: 2.5, initial_repayment_rate: 2,
    },
  });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT interest_mode, fixed_period_months, followup_rate FROM budget_loans WHERE id = ?').get(INTEREST_LOAN);
  assert.equal(row.interest_mode, 'variable');
  assert.equal(row.fixed_period_months, null);
  assert.equal(row.followup_rate, null);
  assert.equal(r.body.data.interest.mode, 'variable');
});

test('POST /loans/preview: variabler Modus liefert Rate + Laufzeit', async () => {
  const r = await call('POST', '/loans/preview', {
    as: AA,
    body: { interest_mode: 'variable', principal: 150000, fixed_rate: 3.5, initial_repayment_rate: 2 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ok, true);
  assert.ok(Math.abs(r.body.data.monthly_payment - 687.5) <= 0.02, `monthly ${r.body.data.monthly_payment}`);
  assert.ok(r.body.data.total_months > 0);
  assert.equal(r.body.data.remaining_after_binding, null, 'ohne Bindung keine Restschuld-Marke');
});

test('POST /loans/preview: unbekannter Modus bleibt abgewiesen', async () => {
  const r = await call('POST', '/loans/preview', {
    as: AA,
    body: { interest_mode: 'bogus', principal: 150000, fixed_rate: 3.5, initial_repayment_rate: 2 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ok, false);
});

// --------------------------------------------------------------------------
// Währung je Darlehen (#582): eigene Währung + fester Kurs in die Budget-Währung
// --------------------------------------------------------------------------

function setBudgetCurrency(currency) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('currency', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(currency);
}

async function createForeignLoan(body = {}) {
  return call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Fremdwährung', title: 'USD-Darlehen',
      total_amount: 1200, installment_count: 12, start_month: '2026-05',
      currency: 'USD', exchange_rate: 0.92,
      ...body,
    },
  });
}

test('POST currency: Fremdwährung + Kurs werden gespeichert und ausgeliefert', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  const r = await createForeignLoan();
  assert.equal(r.status, 201);
  assert.equal(r.body.data.currency, 'USD');
  assert.equal(r.body.data.exchange_rate, 0.92);
  assert.equal(r.body.data.is_foreign_currency, true);
  // Der Darlehensbetrag bleibt ungewandelt - nur so bleibt die Restschuld exakt.
  assert.equal(r.body.data.total_amount, 1200);
});

test('POST currency: Budget-Währung wird als NULL gespeichert, Kurs auf 1 normalisiert', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  const r = await createForeignLoan({ currency: 'EUR', exchange_rate: 7 });
  assert.equal(r.status, 201);
  const row = db.prepare('SELECT currency, exchange_rate FROM budget_loans WHERE id = ?').get(r.body.data.id);
  assert.equal(row.currency, null, 'ohne Fremdwährung folgt das Darlehen dem Budget');
  assert.equal(row.exchange_rate, 1, 'ein Kurs ohne Fremdwährung darf nicht hängen bleiben');
  assert.equal(r.body.data.currency, 'EUR');
  assert.equal(r.body.data.is_foreign_currency, false);
});

test('POST currency: Kurs <= 0 und unsinniger Währungscode -> 400', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  assert.equal((await createForeignLoan({ exchange_rate: 0 })).status, 400);
  assert.equal((await createForeignLoan({ exchange_rate: -3 })).status, 400);
  assert.equal((await createForeignLoan({ currency: 'US' })).status, 400);
});

test('Ratenzahlung: Rate bleibt in Darlehenswährung, Budget-Eintrag wird umgerechnet', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  const loan = await createForeignLoan();
  const id = loan.body.data.id;

  const pay = await call('POST', `/loans/${id}/payments`, {
    as: AA,
    body: { amount: 100, paid_date: '2026-05-01' },
  });
  assert.equal(pay.status, 201);

  const payment = db.prepare('SELECT amount, budget_entry_id FROM budget_loan_payments WHERE loan_id = ?').get(id);
  assert.equal(payment.amount, 100, 'Rate wird in Darlehenswährung geführt');
  const entry = db.prepare('SELECT amount, title FROM budget_entries WHERE id = ?').get(payment.budget_entry_id);
  assert.equal(entry.amount, 92, '100 USD * 0.92 = 92 EUR im Budget');
  assert.ok(entry.title.includes('(USD)'), 'Fremdwährung ist am Budget-Eintrag erkennbar');

  // Restschuld rechnet weiter in Darlehenswährung.
  assert.equal(pay.body.data.loan.remaining_amount, 1100);
});

test('GET /loans: Summenkarte rechnet Fremdwährung in die Budget-Währung um', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  db.prepare('DELETE FROM budget_loans').run();

  await createForeignLoan();                                     // 1200 USD * 0.92 = 1104 EUR
  await createForeignLoan({ currency: 'EUR', exchange_rate: 1 }); // 1200 EUR
  const r = await call('GET', '/loans', { as: AA });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.summary.currency, 'EUR');
  assert.equal(r.body.data.summary.has_foreign_currency, true);
  assert.equal(r.body.data.summary.total_amount, 2304);
  assert.equal(r.body.data.summary.remaining_amount, 2304);
});

test('PUT currency: Zurückstellen auf die Budget-Währung löscht den Kurs', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  const loan = await createForeignLoan();
  const id = loan.body.data.id;

  const r = await call('PUT', `/loans/${id}`, { as: AA, body: { currency: 'EUR' } });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT currency, exchange_rate FROM budget_loans WHERE id = ?').get(id);
  assert.equal(row.currency, null);
  assert.equal(row.exchange_rate, 1);
});

test('PUT currency: Teil-Update ohne currency lässt Währung und Kurs unberührt', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  const loan = await createForeignLoan();
  const id = loan.body.data.id;

  const r = await call('PUT', `/loans/${id}`, { as: AA, body: { notes: 'nur eine Notiz' } });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT currency, exchange_rate FROM budget_loans WHERE id = ?').get(id);
  assert.equal(row.currency, 'USD');
  assert.equal(row.exchange_rate, 0.92);
});

test('PUT currency: Zins-Pfad (interest_mode im Body) behält die Fremdwährung', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  const loan = await createForeignLoan();
  const id = loan.body.data.id;

  const r = await call('PUT', `/loans/${id}`, {
    as: AA,
    body: { interest_mode: 'fixed', principal: 100000, fixed_rate: 3, initial_repayment_rate: 2 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.currency, 'USD');
  assert.equal(r.body.data.exchange_rate, 0.92);
});

// --------------------------------------------------------------------------
// Restschuld vs. Restzahlungssumme
// --------------------------------------------------------------------------

test('GET interest-Loan: remaining_principal ist die Restschuld, nicht die Summe der Restraten', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  db.prepare('DELETE FROM budget_loans').run();

  // Nachgebauter Nutzerfall: 21.000 € zu 4,07 %, Rate 330,10 €, 72 Monate.
  const created = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Lukas', title: 'Auto', start_month: '2022-12',
      interest_mode: 'fixed', principal: 21000,
      fixed_rate: 4.07, initial_repayment_rate: 14.792857,
    },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.remaining_principal, 21000, 'ohne Zahlung ist die volle Kreditsumme offen');

  for (let n = 0; n < 3; n++) {
    const pay = await call('POST', `/loans/${id}/payments`, { as: AA, body: { paid_date: '2026-07-01' } });
    assert.equal(pay.status, 201);
  }

  const r = await call('GET', '/loans', { as: AA });
  const loan = r.body.data.loans.find((l) => l.id === id);
  assert.equal(loan.paid_installments, 3);
  // Kern der Abgrenzung: remaining_amount enthält die Zinsen der Restlaufzeit,
  // remaining_principal nicht. Gleichsetzen wäre der Bug, der das ausgelöst hat.
  assert.ok(loan.remaining_principal < loan.remaining_amount,
    `Restschuld ${loan.remaining_principal} muss unter der Restzahlungssumme ${loan.remaining_amount} liegen`);
  assert.ok(loan.remaining_principal < 21000, 'drei Raten haben getilgt');
  assert.ok(loan.remaining_principal > 20000, 'aber nur einen kleinen Teil');
  assert.equal(loan.remaining_principal, loan.interest.remaining_principal, 'ein Wert, zwei Zugriffswege');

  assert.equal(r.body.data.summary.has_interest, true);
  assert.ok(r.body.data.summary.remaining_principal < r.body.data.summary.remaining_amount,
    'die Summenkarte trennt beide Größen ebenfalls');
});

test('GET zinsfreies Darlehen: remaining_principal == remaining_amount', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  db.prepare('DELETE FROM budget_loans').run();

  const created = await call('POST', '/loans', {
    as: AA,
    body: { borrower: 'Ohne Zins', title: 'Privat', start_month: '2026-01', total_amount: 1200, installment_count: 12 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.interest, null, 'kein Zinsmodell');
  assert.equal(created.body.data.remaining_principal, created.body.data.remaining_amount,
    'ohne Zinsen gibt es keinen Unterschied zwischen den beiden Größen');

  const r = await call('GET', '/loans', { as: AA });
  assert.equal(r.body.data.summary.has_interest, false, 'ohne Zins bleibt die Summenkarte bei "Offen"');
  assert.equal(r.body.data.summary.remaining_principal, r.body.data.summary.remaining_amount);
});

test('Sondertilgung: die Restschuld folgt dem gebuchten Geld, nicht der Ratennummer (#954)', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  db.prepare('DELETE FROM budget_loans').run();

  // Zwei identische Darlehen als Differentialprobe: bis Rate 1 laufen beide
  // gleich, in Rate 2 zahlt eines 500 € mehr. Der Zinsanteil der 2. Rate ist in
  // beiden derselbe (gleiche Restschuld davor), das Extra geht also eins zu
  // eins in die Tilgung - vorher zeigten beide dieselbe Planposition, und die
  // Sondertilgung war unsichtbar (#935).
  const mk = () => call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Lukas', title: 'Auto', start_month: '2022-12',
      interest_mode: 'fixed', principal: 21000,
      fixed_rate: 4.07, initial_repayment_rate: 14.792857,
    },
  });
  const plain = (await mk()).body.data;
  const extra = (await mk()).body.data;

  for (const id of [plain.id, extra.id]) {
    const pay = await call('POST', `/loans/${id}/payments`, { as: AA, body: { paid_date: '2026-07-01' } });
    assert.equal(pay.status, 201);
  }
  const p2 = await call('POST', `/loans/${plain.id}/payments`, { as: AA, body: { paid_date: '2026-08-01' } });
  assert.equal(p2.status, 201);
  const e2 = await call('POST', `/loans/${extra.id}/payments`, {
    as: AA, body: { paid_date: '2026-08-01', amount: plain.installment_amount + 500 },
  });
  assert.equal(e2.status, 201);

  const r = await call('GET', '/loans', { as: AA });
  const a = r.body.data.loans.find((l) => l.id === plain.id);
  const b = r.body.data.loans.find((l) => l.id === extra.id);
  assert.equal(a.paid_installments, 2, 'die Zählung bleibt eine Zählung');
  assert.equal(b.paid_installments, 2);
  assert.ok(Math.abs((a.remaining_principal - b.remaining_principal) - 500) <= 0.02,
    `500 € Extra müssen die Restschuld um 500 € trennen (plain ${a.remaining_principal}, extra ${b.remaining_principal})`);
  // Die Prognose-Kennzahlen bleiben planbasiert und damit identisch.
  assert.equal(a.interest.monthly_payment, b.interest.monthly_payment);
  assert.equal(a.interest.total_interest, b.interest.total_interest);
});

test('Frühe Volltilgung: Restschuld 0 heißt bezahlt, kuenftige Planzinsen schuldet niemand nach (#954)', async () => {
  setMode('shared');
  setBudgetCurrency('EUR');
  db.prepare('DELETE FROM budget_loans').run();

  const created = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Lukas', title: 'Auto', start_month: '2022-12',
      interest_mode: 'fixed', principal: 21000,
      fixed_rate: 4.07, initial_repayment_rate: 14.792857,
    },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  // Kapital plus Zinsanteil der ersten Periode in einer Rate: real ist danach
  // nichts mehr offen, obwohl 71 Plan-Raten nie gebucht wurden.
  const payoff = 21000 + 21000 * (4.07 / 100 / 12) + 1;
  const pay = await call('POST', `/loans/${id}/payments`, { as: AA, body: { paid_date: '2026-07-01', amount: payoff } });
  assert.equal(pay.status, 201);

  const loan = (await call('GET', '/loans', { as: AA })).body.data.loans.find((l) => l.id === id);
  assert.equal(loan.remaining_principal, 0, 'keine Restschuld mehr');
  assert.equal(loan.status, 'paid', 'die Volltilgung stellt den Status um');
  assert.equal(loan.is_settled, true);
  assert.equal(loan.next_installment_number, null, 'keine Rate mehr im Angebot');
  assert.equal(loan.next_due_month, null);

  // Und buchbar ist auch keine mehr - vorher bot der Zaehlungs-Gate 71 weitere an.
  const again = await call('POST', `/loans/${id}/payments`, { as: AA, body: { paid_date: '2026-08-01' } });
  assert.equal(again.status, 409, `weitere Rate muss abgewiesen werden, kam ${again.status}`);
});

// --------------------------------------------------------------------------
// Richtung der Rate (#638)
//
// Die Lücke, durch die der Bug kam: bis hierher prüfte KEIN Test das Vorzeichen
// des erzeugten budget_entries-Eintrags. Das Modul wurde für verliehenes Geld
// gebaut (Rate = Einnahme); mit den Zinsfeldern aus #569 kam der aufgenommene
// Kredit dazu, und eine Hypothekenrate landete als Einnahme in der Monatsbilanz.
// --------------------------------------------------------------------------

/** Buchung, die eine Rate im Budget erzeugt hat. */
function bookingOf(loanId) {
  return db.prepare(`
    SELECT b.amount, b.category, b.subcategory, b.account_id
    FROM budget_loan_payments p JOIN budget_entries b ON b.id = p.budget_entry_id
    WHERE p.loan_id = ? ORDER BY p.installment_number ASC
  `).all(loanId);
}

/** Kategorietyp laut Stammdaten - stats.js liest den Typ zwar am Vorzeichen ab,
 *  aber eine Ausgabe unter einer income-Kategorie wäre trotzdem falsch. */
function categoryType(key) {
  return db.prepare('SELECT type FROM budget_categories WHERE key = ?').get(key)?.type;
}

async function createDirectedLoan(body) {
  setMode('shared');
  setBudgetCurrency('EUR');
  const r = await call('POST', '/loans', {
    as: AA,
    body: { borrower: 'Bank', title: 'Darlehen', start_month: '2026-01', total_amount: 1200, installment_count: 12, ...body },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}

test('POST ohne direction: Default bleibt lent (Bestandsverhalten)', async () => {
  const id = await createDirectedLoan({});
  assert.equal(db.prepare('SELECT direction FROM budget_loans WHERE id = ?').get(id).direction, 'lent');
});

test('lent: Rate ist eine Einnahme (positiv, income-Kategorie)', async () => {
  const id = await createDirectedLoan({ direction: 'lent' });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 1, amount: 100, paid_date: '2026-01-15' } });

  const [entry] = bookingOf(id);
  assert.equal(entry.amount, 100, 'verliehenes Geld kommt zurück: positiver Betrag');
  assert.equal(categoryType(entry.category), 'income', 'und eine income-Kategorie');
});

test('borrowed: Rate ist eine Ausgabe (negativ, expense-Kategorie) - #638', async () => {
  const id = await createDirectedLoan({ direction: 'borrowed', borrower: 'Sparkasse' });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 1, amount: 916.67, paid_date: '2026-01-15' } });

  const [entry] = bookingOf(id);
  assert.equal(entry.amount, -916.67, 'die Hypothekenrate verlässt den Haushalt');
  assert.equal(entry.category, 'financial_other');
  assert.equal(entry.subcategory, 'loans_interest');
  assert.equal(categoryType(entry.category), 'expense',
    'Vorzeichen und Kategorietyp müssen zusammenpassen, sonst steht eine Ausgabe unter einer income-Kategorie');
});

test('borrowed: die Rate zählt in der Monatsbilanz als Ausgabe, nicht als Einnahme', async () => {
  const id = await createDirectedLoan({ direction: 'borrowed' });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 1, amount: 500, paid_date: '2026-02-10' } });

  // Dieselbe Formel wie in stats.js: der Typ hängt am Vorzeichen.
  const totals = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses
    FROM budget_entries WHERE date BETWEEN '2026-02-01' AND '2026-02-28'
  `).get();
  assert.equal(totals.income, 0, 'keine Einnahme');
  assert.equal(totals.expenses, -500);
});

test('borrowed + Fremdwährung: Kurs und Vorzeichen greifen zusammen', async () => {
  const id = await createDirectedLoan({ direction: 'borrowed', currency: 'USD', exchange_rate: 0.92 });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 1, amount: 100, paid_date: '2026-01-15' } });

  const payment = db.prepare('SELECT amount FROM budget_loan_payments WHERE loan_id = ?').get(id);
  assert.equal(payment.amount, 100, 'die Rate bleibt positiv in Darlehenswährung');
  assert.equal(bookingOf(id)[0].amount, -92, '100 USD * 0.92, dann gespiegelt');
});

test('PUT lent -> borrowed: bereits gebuchte Raten werden mit umgebucht', async () => {
  const id = await createDirectedLoan({ direction: 'lent' });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 1, amount: 100, paid_date: '2026-01-15' } });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 2, amount: 100, paid_date: '2026-02-15' } });
  assert.deepEqual(bookingOf(id).map((e) => e.amount), [100, 100]);

  const r = await call('PUT', `/loans/${id}`, { as: AA, body: { direction: 'borrowed' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Der Reparaturweg für Bestandsdaten aus #638: die Migration setzt alles auf
  // 'lent', ein Umstellen muss die falsch gebuchten Raten mitziehen.
  const entries = bookingOf(id);
  assert.deepEqual(entries.map((e) => e.amount), [-100, -100], 'beide Raten gespiegelt');
  assert.ok(entries.every((e) => e.category === 'financial_other' && e.subcategory === 'loans_interest'),
    'Kategorie zieht mit, sonst steht eine Ausgabe unter einer income-Kategorie');
});

test('PUT borrowed -> lent: Rückweg bucht ebenfalls um', async () => {
  const id = await createDirectedLoan({ direction: 'borrowed' });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 1, amount: 100, paid_date: '2026-01-15' } });
  assert.equal(bookingOf(id)[0].amount, -100);

  await call('PUT', `/loans/${id}`, { as: AA, body: { direction: 'lent' } });
  const [entry] = bookingOf(id);
  assert.equal(entry.amount, 100);
  assert.equal(categoryType(entry.category), 'income');
});

test('PUT ohne direction: Richtung bleibt, Raten werden nicht angefasst', async () => {
  const id = await createDirectedLoan({ direction: 'borrowed' });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 1, amount: 100, paid_date: '2026-01-15' } });

  await call('PUT', `/loans/${id}`, { as: AA, body: { notes: 'nur eine Notiz' } });
  assert.equal(db.prepare('SELECT direction FROM budget_loans WHERE id = ?').get(id).direction, 'borrowed');
  assert.equal(bookingOf(id)[0].amount, -100, 'ein Teil-Update darf nicht stumm zurückbuchen');
});

test('PUT über den Zins-Pfad: direction überlebt den Feldsatz', async () => {
  const id = await createDirectedLoan({
    direction: 'borrowed', interest_mode: 'fixed', principal: 200000, fixed_rate: 3.5, initial_repayment_rate: 2,
  });
  const r = await call('PUT', `/loans/${id}`, {
    as: AA,
    body: { interest_mode: 'fixed', principal: 200000, fixed_rate: 4, initial_repayment_rate: 2 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT direction FROM budget_loans WHERE id = ?').get(id).direction, 'borrowed');
});

test('unbekannte Richtung -> 400', async () => {
  setMode('shared');
  const r = await call('POST', '/loans', {
    as: AA,
    body: { borrower: 'X', title: 'X', start_month: '2026-01', total_amount: 100, installment_count: 1, direction: 'sideways' },
  });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Konto an der Rate (#638): vorher hatte der Raten-Eintrag nie eine account_id,
// eine Rate konnte also kein Konto belasten.
// --------------------------------------------------------------------------

test('account_id: die Rate belastet das Konto des Darlehens', async () => {
  const acct = db.prepare(`
    INSERT INTO budget_accounts (name, type, starting_balance, created_by) VALUES ('Giro', 'checking', 1000, ?)
  `).run(A).lastInsertRowid;

  const id = await createDirectedLoan({ direction: 'borrowed', account_id: acct });
  await call('POST', `/loans/${id}/payments`, { as: AA, body: { installment_number: 1, amount: 250, paid_date: '2026-01-15' } });

  const [entry] = bookingOf(id);
  assert.equal(entry.account_id, acct, 'ohne Zuordnung könnte eine Rate kein Konto belasten');
  assert.equal(entry.amount, -250);

  const balance = db.prepare(`
    SELECT starting_balance + COALESCE((SELECT SUM(amount) FROM budget_entries WHERE account_id = a.id), 0) AS v
    FROM budget_accounts a WHERE a.id = ?
  `).get(acct).v;
  assert.equal(balance, 750, 'der Kontosaldo folgt der Rate');
});

test('account_id: unbekanntes Konto -> 400', async () => {
  setMode('shared');
  const r = await call('POST', '/loans', {
    as: AA,
    body: { borrower: 'X', title: 'X', start_month: '2026-01', total_amount: 100, installment_count: 1, account_id: 999999 },
  });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Bereits gezahlte Raten beim Anlegen (#813)
//
// Ein Darlehen, das schon läuft, wenn es hier eingetragen wird, startete bisher
// mit lauter offenen Raten. Der teuerste Teil davon ist NICHT die Bequemlichkeit,
// sondern was die naheliegende Abhilfe angerichtet hätte: die vergangenen Raten
// über die normale Zahlungsroute abzuhaken, die jede Rate ins Budget bucht.
// --------------------------------------------------------------------------

function paymentsOf(loanId) {
  return db.prepare('SELECT * FROM budget_loan_payments WHERE loan_id = ? ORDER BY installment_number').all(loanId);
}

test('#813: bereits gezahlte Raten werden beim Anlegen nachgetragen', async () => {
  const r = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Altkredit', title: 'Altkredit', total_amount: 1200,
      installment_count: 12, start_month: '2026-01', paid_installments: 3,
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.paid_installments, 3);
  assert.equal(r.body.data.remaining_installments, 9);

  const rows = paymentsOf(r.body.data.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((p) => p.installment_number), [1, 2, 3]);
  // Der Fälligkeitsmonat läuft mit der Rate, nicht alle drei auf den Startmonat.
  assert.deepEqual(rows.map((p) => p.paid_date), ['2026-01-01', '2026-02-01', '2026-03-01']);
  assert.deepEqual(rows.map((p) => p.amount), [100, 100, 100]);
});

// Der eigentliche Punkt. Eine regulär abgehakte Rate bucht ins Budget, weil sie
// gerade bezahlt wird - diese hier liefen nie über den Haushalt.
test('#813: nachgetragene Raten erzeugen KEINE Budget-Buchungen', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM budget_entries').get().c;
  const r = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Ohne Buchung', title: 'Ohne Buchung', total_amount: 600,
      installment_count: 6, start_month: '2025-07', paid_installments: 4,
    },
  });
  const after = db.prepare('SELECT COUNT(*) AS c FROM budget_entries').get().c;
  assert.equal(after, before, 'vergangene Monate dürfen nicht mit erfundenen Ausgaben gefüllt werden');
  for (const p of paymentsOf(r.body.data.id)) {
    assert.equal(p.budget_entry_id, null, 'eine nachgetragene Rate hängt an keiner Buchung');
  }
});

// Gegenprobe zur vorigen Zusicherung: die normale Zahlungsroute bucht weiterhin.
// Ohne diesen Test wäre "erzeugt keine Buchung" auch dann erfüllt, wenn das
// Buchen insgesamt kaputtginge.
test('#813: die normale Zahlungsroute bucht unverändert weiter', async () => {
  const r = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Bucht noch', title: 'Bucht noch', total_amount: 300,
      installment_count: 3, start_month: '2026-02', paid_installments: 1,
    },
  });
  const id = r.body.data.id;
  const before = db.prepare('SELECT COUNT(*) AS c FROM budget_entries').get().c;
  await call('POST', `/loans/${id}/payments`, {
    as: AA, body: { installment_number: 2, amount: 100, paid_date: '2026-03-15' },
  });
  const after = db.prepare('SELECT COUNT(*) AS c FROM budget_entries').get().c;
  assert.equal(after, before + 1, 'die reguläre Rate bucht weiter ins Budget');
  const rows = paymentsOf(id);
  assert.equal(rows.find((p) => p.installment_number === 1).budget_entry_id, null);
  assert.ok(rows.find((p) => p.installment_number === 2).budget_entry_id, 'die reguläre Rate trägt ihre Buchung');
});

test('#813: alle Raten nachgetragen schließt das Darlehen ab', async () => {
  const r = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Fertig', title: 'Fertig', total_amount: 500,
      installment_count: 5, start_month: '2025-01', paid_installments: 5,
    },
  });
  assert.equal(r.body.data.status, 'paid');
  assert.equal(r.body.data.remaining_installments, 0);
  assert.equal(r.body.data.remaining_amount, 0, 'ein vollständig nachgetragenes Darlehen überzahlt sich nicht');
});

// Die Deckelung auf den Restbetrag. Sie greift NUR, wenn die Rate nicht glatt
// aufgeht - bei 200 auf 3 Raten sind das 66,67 je Rate und in der Summe 200,01.
// Ohne Deckelung überzahlt sich das Darlehen um einen Cent und rutscht in eine
// negative Restsumme. Der erste Anlauf dieser Suite prüfte nur glatte Beträge
// und wäre gegen ein Entfernen der Deckelung blind gewesen.
test('#813: die letzte nachgetragene Rate wird auf den Restbetrag gekürzt', async () => {
  const r = await call('POST', '/loans', {
    as: AA,
    body: {
      borrower: 'Krumm', title: 'Krumm', total_amount: 200,
      installment_count: 3, start_month: '2025-03', paid_installments: 3,
    },
  });
  const rows = paymentsOf(r.body.data.id);
  assert.deepEqual(rows.map((p) => p.amount), [66.67, 66.67, 66.66]);
  const sum = rows.reduce((acc, p) => acc + p.amount, 0);
  assert.ok(Math.abs(sum - 200) < 0.005, `die Summe darf den Betrag nicht übersteigen, war ${sum}`);
  assert.equal(r.body.data.remaining_amount, 0);
  assert.equal(r.body.data.status, 'paid');
});

test('#813: ohne das Feld bleibt alles wie vorher', async () => {
  const r = await createLoan(AA, { title: 'Unverändert' });
  assert.equal(r.body.data.paid_installments, 0);
  assert.equal(paymentsOf(r.body.data.id).length, 0);
});

test('#813: unbrauchbare Werte werden abgewiesen', async () => {
  const base = {
    borrower: 'X', title: 'X', total_amount: 1200, installment_count: 12, start_month: '2026-01',
  };
  for (const bad of [-1, 13, 'viele']) {
    const r = await call('POST', '/loans', { as: AA, body: { ...base, paid_installments: bad } });
    assert.equal(r.status, 400, `paid_installments=${bad} muss 400 geben`);
  }
  // Leerstring ist der Normalfall aus einem nicht ausgefüllten Formularfeld und
  // darf nicht als 0-Fehler durchschlagen.
  const ok = await call('POST', '/loans', { as: AA, body: { ...base, paid_installments: '' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.paid_installments, 0);
});

// ── Titel einer gebuchten Rate: Datensprache des Haushalts ───────────────────────
//
// Der Titel in budget_entries ist das, was REST-API, CSV-Export, FTS-Suchindex und
// MCP zu sehen bekommen - keiner dieser Kanäle durchläuft die Client-Übersetzung.
// Genau dieselbe Begründung wie bei Geburtstagsterminen (#524/#631/#632).
//
// Der übersetzte Fallback in public/pages/budget.js greift nur bei LEEREM Titel und
// kam deshalb nie zum Zug; er bleibt für nachgetragene Raten (#813), die gar keinen
// Budget-Eintrag haben.

function setLanguage(value) {
  if (value === null) {
    db.prepare("DELETE FROM sync_config WHERE key = 'language'").run();
    return;
  }
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('language', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
}

function setRegion(value) {
  if (value === null) {
    db.prepare("DELETE FROM sync_config WHERE key = 'region'").run();
    return;
  }
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('region', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
}

async function titleOfBookedInstalment(loanBody = {}) {
  const id = await createDirectedLoan({ borrower: 'Sparkasse', ...loanBody });
  const r = await call('POST', `/loans/${id}/payments`, {
    as: AA, body: { installment_number: 1, amount: 100, paid_date: '2026-01-15' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const entryId = r.body.data.payment.budget_entry_id;
  return db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(entryId).title;
}

/** Erwarteter Titel aus DER Locale-Datei, die auch der Server liest. Ein zweites
 *  Mal hingeschriebene Übersetzung wäre eine zweite Wahrheit: sie bricht bei jeder
 *  Korrektur am Wortlaut, ohne dass am Verhalten etwas falsch wäre. Geprüft wird,
 *  dass der Titel AUS der Locale kommt - nicht, wie sie gerade formuliert ist. */
function expectedTitle(locale, borrower) {
  const dict = JSON.parse(readFileSync(new URL(`../public/locales/${locale}.json`, import.meta.url), 'utf8'));
  return dict.budget.loanPaymentTitle.replace('{{borrower}}', borrower);
}

test('der gespeicherte Titel folgt der Datensprache des Haushalts', async () => {
  setLanguage('de');
  const de = await titleOfBookedInstalment();
  assert.equal(de, expectedTitle('de', 'Sparkasse'));
  assert.doesNotMatch(de, /Loan repayment/, 'der englische Titel steht noch in der Zeile');

  setLanguage('fr');
  const fr = await titleOfBookedInstalment();
  assert.equal(fr, expectedTitle('fr', 'Sparkasse'));
  assert.notEqual(fr, de, 'die Sprache wirkt sich auf den gespeicherten Titel nicht aus');
});

test('ohne gesetzte Sprache leitet die Region sie ab', async () => {
  setLanguage(null);
  setRegion('es-ES');
  assert.equal(await titleOfBookedInstalment(), expectedTitle('es', 'Sparkasse'));
});

test('ohne Sprache und ohne Region gilt Englisch, nicht die Referenz-Locale', async () => {
  // de ist die Referenz-Locale der Übersetzungsdateien, aber nicht der Default
  // eines Haushalts, der nie etwas eingestellt hat. Diese eine Erwartung steht
  // absichtlich wörtlich da: sie ist die Aussage, nicht die Übersetzung.
  setLanguage(null);
  setRegion(null);
  assert.equal(await titleOfBookedInstalment(), 'Loan repayment: Sparkasse');
});

test('der Währungszusatz bleibt am übersetzten Titel', async () => {
  setLanguage('de');
  setBudgetCurrency('EUR');
  const title = await titleOfBookedInstalment({ currency: 'USD', exchange_rate: 0.92 });
  assert.equal(title, 'Darlehensrückzahlung: Sparkasse (USD)',
    'die Währung sagt, in welcher Einheit die Rate geführt wird - sie darf mit der Übersetzung nicht wegfallen');
  setLanguage(null);
  setRegion(null);
});

test('kein fest verdrahteter Anzeigetext mehr im Loans-Router', () => {
  // Ein Literal hier wäre wieder in 23 von 24 Sprachen falsch, und keiner der
  // Kanäle, die diese Zeile lesen, könnte es nachträglich übersetzen.
  const source = readFileSync(new URL('../server/routes/budget/loans.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /'Loan repayment|`Loan repayment/,
    'der englische Titel steht wieder im Quelltext');
  assert.match(source, /translate\(resolveHouseholdLocale\(/,
    'der Titel läuft nicht mehr über die Haushaltssprache');
});

test('teardown: Server schließen', async () => {
  await new Promise((r) => server.close(r));
});
