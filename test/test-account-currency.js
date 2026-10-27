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

// Security-Befund zu #2302: die Kontowaehrung war freier Text bis 8 Zeichen.
test('Konto: nur unterstuetzte ISO-Codes, leer heisst Budget-Waehrung', async () => {
  const bad = await call('POST', '/accounts', { name: 'X', type: 'checking', starting_balance: 0, currency: 'XYZ1' });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(bad.body.reason, 'account_currency_invalid');
  const lower = await account('Chase', 'usd');
  assert.equal(db.prepare('SELECT currency FROM budget_accounts WHERE id = ?').get(lower).currency, 'USD');
  const put = await call('PUT', `/accounts/${lower}`, { currency: 'XYZ1' });
  assert.equal(put.status, 400);
  assert.equal(put.body.reason, 'account_currency_invalid');
  await call('PUT', `/accounts/${lower}`, { currency: '' });
  assert.equal(db.prepare('SELECT currency FROM budget_accounts WHERE id = ?').get(lower).currency, null);
  // Ein Bestandswert aus der Zeit davor haelt ein Bearbeiten nicht auf.
  db.prepare("UPDATE budget_accounts SET currency = 'XYZ1' WHERE id = ?").run(lower);
  const rename = await call('PUT', `/accounts/${lower}`, { name: 'Chase 2', currency: 'XYZ1' });
  assert.equal(rename.status, 200, JSON.stringify(rename.body));
});

// Review-Runde (Codex zu #2331)
test('Abo: ohne Kurs zur Kontowaehrung entsteht keine Buchung mit dem unveraenderten Betrag', async () => {
  const sek = await account('Stockholm', 'SEK');
  const created = await sub({ account_id: sek });
  const booked = created.budget_entry_id ? entry(created.budget_entry_id) : null;
  assert.ok(!booked || booked.amount !== -30, `30 EUR sind nicht 30 SEK: ${JSON.stringify(booked)}`);
});

test('Abo: ohne Kurs laesst ein Kontowechsel die gebuchte Umrechnung stehen', async () => {
  const usd = await account('Chase', 'USD');
  const created = await sub({ account_id: usd });
  assert.equal(entry(created.budget_entry_id).amount, -33);
  const r = await call('PUT', `/accounts/${usd}`, { currency: 'SEK' });
  assert.equal(r.status, 200);
  assert.equal(entry(created.budget_entry_id).amount, -33, 'kein Kurs EUR->SEK: der Betrag wird nicht still zu 30');
});

test('Verlaengern: eine auf ein anderes Konto gestellte Zahlung behaelt dessen Waehrung', async () => {
  const usd = await account('Chase', 'USD');
  const giro = await account('Giro', null);
  const created = await sub({ account_id: usd });
  const moved = await call('PUT', `/${created.budget_entry_id}`, { account_id: giro, amount: -30 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const r = await call('POST', `/subscriptions/${created.id}/renew`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const paid = entry(created.budget_entry_id);
  assert.equal(paid.account_id, giro);
  assert.equal(paid.amount, -30, 'auf dem Euro-Konto 30 EUR, nicht 33');
});

test('Rate: ein unveraenderter Betrag bleibt bei geaendertem Kurs-Cache dieselbe Rate', async () => {
  const usd = await account('Chase', 'USD');
  db.prepare(`INSERT INTO subscription_exchange_rates (base_currency, quote_currency, rate, fetched_at)
              VALUES ('USD', 'EUR', 1.1, '2026-10-27T00:00:00Z')`).run();
  const id = await loan({ account_id: usd });
  const paid = await call('POST', `/loans/${id}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-05-15' });
  const entryId = paid.body.data.payment.budget_entry_id;
  db.prepare("UPDATE subscription_exchange_rates SET rate = 1.2 WHERE base_currency = 'USD' AND quote_currency = 'EUR'").run();
  const amount = entry(entryId).amount;
  const r = await call('PUT', `/${entryId}`, { amount, title: 'Rate' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT amount FROM budget_loan_payments WHERE budget_entry_id = ?').get(entryId).amount, 100);
});

test('Projektion: eine auf ein Euro-Konto gestellte Zahlung verschiebt die Folgezahlungen des USD-Kontos nicht', async () => {
  const usd = await account('Chase', 'USD');
  const giro = await account('Giro', null);
  db.prepare(`INSERT INTO subscription_exchange_rates (base_currency, quote_currency, rate, fetched_at)
              VALUES ('USD', 'EUR', 1.1, '2026-10-27T00:00:00Z')`).run();
  const created = await sub({ account_id: usd, next_payment_date: '2030-01-15' });
  const moved = await call('PUT', `/${created.budget_entry_id}`, { account_id: giro, amount: -30 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const { entries } = expectedSubscriptionEntries(db, {
    from: '2030-02-01', to: '2030-02-28', accountId: usd, today: '2030-01-10',
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, -33, 'USD 33 wie die Vorgabe, nicht die 30 EUR der umgestellten Zahlung');
});

test('Nettovermoegen: nur Budget-Waehrung bleibt die schlichte Summe', async () => {
  const giro = await account('Giro', null);
  await call('PUT', `/accounts/${giro}`, { starting_balance: 250 });
  const r = await call('GET', '/accounts');
  assert.equal(r.body.data.net_worth, 250);
  assert.equal(r.body.data.net_worth_approx, undefined);
  assert.equal(r.body.data.net_worth_by_currency, undefined);
});

test('Nettovermoegen: ein USD-Konto geht ueber den Kurs-Cache ein und ist als Naeherung markiert', async () => {
  const giro = await account('Giro', null);
  const usd = await account('Chase', 'USD');
  await call('PUT', `/accounts/${giro}`, { starting_balance: 100 });
  await call('PUT', `/accounts/${usd}`, { starting_balance: 110 });
  db.prepare(`INSERT INTO subscription_exchange_rates (base_currency, quote_currency, rate, fetched_at)
              VALUES ('USD', 'EUR', 1.1, '2026-10-20T06:00:00Z')`).run();
  const r = await call('GET', '/accounts');
  assert.equal(r.body.data.net_worth, 200, '100 EUR + 110 USD (= 100 EUR), nicht 210');
  assert.equal(r.body.data.net_worth_approx, true);
  assert.equal(r.body.data.net_worth_rates_at, '2026-10-20T06:00:00Z');
  assert.deepEqual(r.body.data.net_worth_by_currency, [{ currency: 'EUR', amount: 100 }, { currency: 'USD', amount: 110 }]);
});

test('Nettovermoegen: ohne Kurs keine Gesamtzahl, sondern die Summe je Waehrung', async () => {
  const giro = await account('Giro', null);
  const usd = await account('Chase', 'USD');
  await call('PUT', `/accounts/${giro}`, { starting_balance: 100 });
  await call('PUT', `/accounts/${usd}`, { starting_balance: 110 });
  const r = await call('GET', '/accounts');
  assert.equal(r.body.data.net_worth, null, 'eine Rohsumme 210 waere falsch');
  assert.deepEqual(r.body.data.net_worth_by_currency, [{ currency: 'EUR', amount: 100 }, { currency: 'USD', amount: 110 }]);
});

test('Nettovermoegen: eine Teilsumme behaelt die Stellen ihrer Waehrung', async () => {
  // KWD fuehrt drei Stellen; es steht nicht in CURRENCY_CODES, also ein
  // Bestandskonto aus der Zeit davor, mit einer Buchung von 1,234 KWD.
  await account('Giro', null);
  const kwd = db.prepare(`INSERT INTO budget_accounts (name, type, starting_balance, currency, sort_order, created_by)
                          VALUES ('Kuwait', 'checking', 0, 'KWD', 99, ?)`).run(ADA).lastInsertRowid;
  db.prepare(`INSERT INTO budget_entries (title, amount, category, date, created_by, account_id)
              VALUES ('Zins', 1.234, 'other_income', '2026-10-01', ?, ?)`).run(ADA, kwd);
  db.prepare(`INSERT INTO subscription_exchange_rates (base_currency, quote_currency, rate, fetched_at)
              VALUES ('EUR', 'KWD', 3, '2026-10-27T00:00:00Z')`).run();
  const r = await call('GET', '/accounts');
  assert.deepEqual(r.body.data.net_worth_by_currency.find((p) => p.currency === 'KWD'), { currency: 'KWD', amount: 1.234 });
  assert.equal(r.body.data.net_worth, 3.7, '1,234 KWD zu 3 sind 3,70 EUR, nicht 3,69');
});
