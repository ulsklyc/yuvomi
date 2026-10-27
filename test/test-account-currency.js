/**
 * Tests: Betraege auf einem Konto stehen in dessen Waehrung (#2302)
 * Module: server/routes/subscriptions.js, server/routes/budget/loans.js,
 *         server/routes/budget/entries.js, server/routes/budget/accounts.js,
 *         server/services/subscription-budget-projection.js
 *
 * ENTSCHEIDUNG (Ulas, 27.10.2026): Ein Betrag auf einem Konto in Fremdwaehrung
 * steht in der Waehrung des Kontos - Startsaldo, Umbuchungen und Buchungen
 * gleichermassen. Vorhandene Buchungen gelten als Kontowaehrung, es gibt keine
 * Migration. Was das Abo und das Darlehen selbst buchen, rechnen sie ab jetzt in
 * die Kontowaehrung um: das Abo ueber den Kurs-Cache, die Rate ueber den festen
 * Kurs des Darlehens (eine dritte Waehrung weiter ueber den Kurs-Cache).
 *
 * Gefahren wird der ECHTE Code ueber einer migrierten In-Memory-DB; den
 * Kursabruf ersetzt der Test-Haken der Abo-Route.
 *
 * Ausfuehren: npm run test:account-currency
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'account-currency-test-secret';
delete process.env.FIXER_API_KEY;

const dbmod = await import('../server/db.js');
const subscriptions = await import('../server/routes/subscriptions.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const { expectedSubscriptionEntries } = await import('../server/services/subscription-budget-projection.js');

const db = dbmod.get();
const ADA = db.prepare(
  'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)',
).run('ada', 'Ada', 'x', 'admin').lastInsertRowid;
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('currency', 'EUR')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

// 1 EUR = 1.10 USD, 1 CHF = 1.25 USD - aus der Sicht der Kontowaehrung USD.
const RATES = { USD: { EUR: 1.1, CHF: 1.25, USD: 1 }, EUR: { USD: 1 / 1.1, EUR: 1 } };
const lookups = [];
subscriptions._setRatesForTest(async (base, currencies) => {
  lookups.push(`${base}<-${currencies.join(',')}`);
  return { rates: RATES[base] ?? { [base]: 1 }, source: 'test', fetchedAt: '2026-10-27T00:00:00Z' };
});
test.after(() => subscriptions._setRatesForTest(null));

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = ADA;
  req.authRole = 'admin';
  req.session = { userId: ADA, role: 'admin' };
  next();
});
app.use('/api/v1/budget/subscriptions', subscriptions.default);
app.use('/api/v1/budget', budgetRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1/budget`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function account(name, currency) {
  const r = await call('POST', '/accounts', { name, type: 'checking', starting_balance: 0, currency });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}
async function sub(extra) {
  const r = await call('POST', '/subscriptions', {
    name: 'Gym', amount: 30, currency: 'EUR', billing_cycle: 'monthly', next_payment_date: '2030-01-15', ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
async function loan(extra) {
  const r = await call('POST', '/loans', {
    borrower: 'Bank', title: 'Kredit', total_amount: 1200, installment_count: 12, start_month: '2026-05', ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}
const entry = (id) => db.prepare('SELECT id, amount, title, account_id FROM budget_entries WHERE id = ?').get(id);

test.beforeEach(() => {
  lookups.length = 0;
  db.prepare('DELETE FROM budget_subscriptions').run();
  db.prepare('DELETE FROM budget_loan_payments').run();
  db.prepare('DELETE FROM budget_loans').run();
  db.prepare('DELETE FROM budget_entries').run();
  db.prepare('DELETE FROM budget_accounts').run();
  db.prepare('DELETE FROM subscription_exchange_rates').run();
});

test('Abo: die Buchung auf einem USD-Konto steht in USD, umgerechnet ueber den Kurs-Cache', async () => {
  const usd = await account('Chase', 'USD');
  const created = await sub({ account_id: usd });
  const booked = entry(created.budget_entry_id);
  assert.equal(booked.account_id, usd);
  assert.equal(booked.amount, -33, '30 EUR sind 33 USD - nicht 30 in der Budget-Waehrung');
  assert.equal(booked.title, 'Gym (EUR)');
  assert.ok(lookups.includes('USD<-EUR'), `Kurs relativ zur Kontowaehrung geholt: ${lookups}`);
});

test('Abo: in der Waehrung seines Kontos bucht es ohne Umrechnung', async () => {
  const usd = await account('Chase', 'USD');
  const created = await sub({ account_id: usd, currency: 'USD', amount: 12 });
  const booked = entry(created.budget_entry_id);
  assert.equal(booked.amount, -12);
  assert.equal(booked.title, 'Gym', 'kein Waehrungszusatz: die Buchung steht in der Waehrung des Abos');
});

test('Abo: Verlaengern bucht die naechste Zahlung wieder in der Kontowaehrung', async () => {
  const usd = await account('Chase', 'USD');
  const created = await sub({ account_id: usd });
  const r = await call('POST', `/subscriptions/${created.id}/renew`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(entry(created.budget_entry_id).amount, -33, 'die bezahlte bleibt in USD');
  const next = db.prepare('SELECT budget_entry_id FROM budget_subscriptions WHERE id = ?').get(created.id).budget_entry_id;
  assert.notEqual(next, created.budget_entry_id);
  assert.equal(entry(next).amount, -33);
});

test('Abo: Archivieren des Kontos rechnet die wartende Buchung in die Budget-Waehrung zurueck', async () => {
  const usd = await account('Chase', 'USD');
  const created = await sub({ account_id: usd });
  const r = await call('PUT', `/accounts/${usd}`, { archived: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const booked = entry(created.budget_entry_id);
  assert.equal(booked.account_id, null);
  assert.equal(booked.amount, -30, 'ohne Konto in EUR');
  assert.equal(booked.title, 'Gym');

  await call('PUT', `/accounts/${usd}`, { archived: false });
  assert.equal(entry(created.budget_entry_id).amount, -33, 'zurueckgeholt wieder in USD');
});

test('Abo: Loeschen des Kontos rechnet die wartende Buchung in die Budget-Waehrung zurueck', async () => {
  const usd = await account('Chase', 'USD');
  const created = await sub({ account_id: usd });
  const r = await call('DELETE', `/accounts/${usd}`);
  assert.equal(r.status, 204);
  assert.equal(entry(created.budget_entry_id).amount, -30);
});

test('Abo: eine neue Kontowaehrung rechnet die wartende Buchung um', async () => {
  const acc = await account('Giro', null);
  const created = await sub({ account_id: acc });
  assert.equal(entry(created.budget_entry_id).amount, -30);
  const r = await call('PUT', `/accounts/${acc}`, { currency: 'USD' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(entry(created.budget_entry_id).amount, -33);
});

test('Projektion: erwartete Abo-Zahlungen eines USD-Kontos stehen in USD', async () => {
  const usd = await account('Chase', 'USD');
  const created = await sub({ account_id: usd, next_payment_date: '2030-01-15' });
  const { entries } = expectedSubscriptionEntries(db, {
    from: '2030-02-01', to: '2030-02-28', accountId: usd, today: '2030-01-10',
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].subscription_id, created.id);
  assert.equal(entries[0].amount, -33);
  assert.equal(entries[0].title, 'Gym (EUR)');
});

test('Rate: Darlehen in USD auf einem USD-Konto bucht ohne Umrechnung', async () => {
  const usd = await account('Chase', 'USD');
  const id = await loan({ currency: 'USD', exchange_rate: 0.9, account_id: usd });
  const r = await call('POST', `/loans/${id}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-05-15' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const booked = entry(r.body.data.payment.budget_entry_id);
  assert.equal(Math.abs(booked.amount), 100, 'nicht 90 EUR auf dem USD-Konto');
  assert.equal(booked.account_id, usd);
});

test('Rate: Darlehen in USD ohne Konto bleibt beim festen Kurs in die Budget-Waehrung', async () => {
  const id = await loan({ currency: 'USD', exchange_rate: 0.9 });
  const r = await call('POST', `/loans/${id}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-05-15' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Math.abs(entry(r.body.data.payment.budget_entry_id).amount), 90);
});

test('Rate: Darlehen in EUR auf einem USD-Konto rechnet ueber den Kurs-Cache', async () => {
  const usd = await account('Chase', 'USD');
  db.prepare(`INSERT INTO subscription_exchange_rates (base_currency, quote_currency, rate, fetched_at)
              VALUES ('USD', 'EUR', 1.1, '2026-10-27T00:00:00Z')`).run();
  const id = await loan({ account_id: usd });
  const r = await call('POST', `/loans/${id}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-05-15' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Math.abs(entry(r.body.data.payment.budget_entry_id).amount), 110);
});

test('Rate: ohne bekannten Kurs zur Kontowaehrung wird sie abgelehnt, nicht falsch gebucht', async () => {
  const usd = await account('Chase', 'USD');
  const id = await loan({ currency: 'CHF', exchange_rate: 1.05, account_id: usd });
  const r = await call('POST', `/loans/${id}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-05-15' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.reason, 'loan_payment_rate_unavailable');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_loan_payments').get().n, 0);
});

test('Rate: ein geaenderter Betrag der Buchung geht ueber denselben Kurs zurueck in die Rate', async () => {
  const usd = await account('Chase', 'USD');
  const id = await loan({ currency: 'USD', exchange_rate: 0.9, account_id: usd });
  const paid = await call('POST', `/loans/${id}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-05-15' });
  const entryId = paid.body.data.payment.budget_entry_id;
  const sign = Math.sign(entry(entryId).amount);
  const r = await call('PUT', `/${entryId}`, { amount: 50 * sign });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const payment = db.prepare('SELECT amount FROM budget_loan_payments WHERE budget_entry_id = ?').get(entryId);
  assert.equal(payment.amount, 50, '50 USD auf dem USD-Konto sind 50 USD Rate, nicht 55,56');
});
