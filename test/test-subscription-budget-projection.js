/**
 * Test: Ein Abo steht in JEDEM Monat des Budgets, in dem es faellig wird (#1844)
 *
 * Zweck: Ein Abo mit "Ins Budget einbeziehen" haelt genau EINE Buchung, am
 *        Tag der naechsten Zahlung; die naechste entsteht erst mit "Als
 *        verlaengert markieren". Die Monatsliste liest `date BETWEEN`, also
 *        stand das Abo in genau einem Monat. Die Folgemonate zeigen es jetzt
 *        als ERWARTETE Zeile, beim Lesen aus dem Rhythmus gerechnet
 *        (server/services/subscription-budget-projection.js) - geschrieben
 *        wird nichts.
 *
 * Gemessen wird ueber die echten Router (Budget + Abos) auf einer
 * In-Memory-DB, nicht am Quelltext: Monatsliste, Zusammenfassung, Statistik,
 * Plan, CSV. Die Regel fuer Summen ist die der erwarteten Buchungen (#637):
 * sichtbar, gekennzeichnet, in KEINER Summe, in `pending` ausgewiesen.
 *
 * DIE UHR STEHT: 11.10.2026, 10:00 UTC, Haushaltszone UTC. Ohne das kippten
 * "vergangener Monat" und "laufender Monat" mit dem Kalender, und die Suite
 * waere am Monatswechsel rot oder - schlimmer - gruen, ohne etwas zu messen.
 * Ein Fall verschiebt die Zone, damit "heute" nachweislich der Haushaltszone
 * folgt und nicht dem UTC-Tag.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-subscription-budget-projection.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.FIXER_API_KEY;

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const { default: subscriptionsRouter } = await import('../server/routes/subscriptions.js');
const { addBillingCycle } = await import('../server/services/subscriptions.js');
const db = dbmod.get();

const NOW = '2026-10-11T10:00:00Z';
mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
test.after(() => mock.timers.reset());

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;
const B = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')").run().lastInsertRowid;

function setConfig(key, value) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
setConfig('household_timezone', 'UTC');
setConfig('currency', 'EUR');
setConfig('budget_mode', 'shared');

let actor = { id: A, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.authRole = actor.role; req.session = { userId: actor.id }; next(); });
// Dieselbe Reihenfolge wie in server/index.js: die Abos haengen unter dem
// Budget-Praefix und muessen VOR dem Budget-Router stehen.
app.use('/budget/subscriptions', subscriptionsRouter);
app.use('/budget', budgetRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

test.beforeEach(() => {
  db.prepare('DELETE FROM budget_subscriptions').run();
  db.prepare('DELETE FROM budget_entries').run();
  db.prepare('DELETE FROM subscription_exchange_rates').run();
  setConfig('budget_mode', 'shared');
  setConfig('household_timezone', 'UTC');
  mock.timers.setTime(new Date(NOW).getTime());
});

async function call(method, route, { as = A, body } = {}) {
  actor = { id: as, role: 'member' };
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, body: json, text };
}

async function createSub(fields = {}, { as = A } = {}) {
  const r = await call('POST', '/budget/subscriptions', {
    as,
    body: {
      name: 'Streaming', amount: 12.99, currency: 'EUR', billing_cycle: 'monthly',
      cycle_interval: 1, next_payment_date: '2026-10-20', ...fields,
    },
  });
  assert.equal(r.status, 201, `Abo angelegt: ${r.text}`);
  return r.body.data;
}

async function month(ym, { as = A, query = '' } = {}) {
  const r = await call('GET', `/budget?month=${ym}${query}`, { as });
  assert.equal(r.status, 200, r.text);
  return r.body.data;
}

const expectedOf = (rows) => rows.filter((row) => row.expected === true);
const bookedOf = (rows) => rows.filter((row) => row.expected !== true);
const entryCount = () => db.prepare('SELECT COUNT(*) AS n FROM budget_entries').get().n;

// ── Das Fehlbild aus #1844 ──────────────────────────────────────────────────────

test('monatliches Abo: der Folgemonat zeigt es als erwartete Zeile, geschrieben wird nichts', async () => {
  const sub = await createSub();
  assert.equal(entryCount(), 1, 'genau eine Buchung, am Tag der naechsten Zahlung');

  const october = await month('2026-10');
  assert.equal(october.length, 1, 'im Monat der echten Zeile steht nichts daneben');
  assert.equal(october[0].date, '2026-10-20');
  assert.ok(Number.isInteger(october[0].id), 'die Oktober-Zeile ist die gebuchte');
  assert.notEqual(october[0].expected, true);

  const november = await month('2026-11');
  assert.equal(november.length, 1, 'der Folgemonat zeigt das Abo');
  const row = november[0];
  assert.equal(row.expected, true, 'als erwartet gekennzeichnet');
  assert.equal(row.id, null, 'ohne echte id: es gibt keine Zeile');
  assert.equal(row.subscription_id, sub.id);
  assert.equal(row.date, '2026-11-20');
  assert.equal(row.amount, -12.99);
  assert.equal(row.title, 'Streaming');
  assert.equal(row.category, 'subscriptions');
  assert.equal(row.is_pending, 1, 'wie jede erwartete Buchung: noch nicht passiert');

  const march = await month('2027-03');
  assert.deepEqual(expectedOf(march).map((r) => r.date), ['2027-03-20'], 'auch Monate spaeter');

  assert.equal(entryCount(), 1, 'das Lesen hat keine Zeile angelegt');
});

test('Summen: die erwartete Zeile zaehlt in keiner mit und steht in `pending`', async () => {
  await createSub();
  const r = await call('GET', '/budget/summary?month=2026-11');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.expenses, 0, 'nicht gebucht, also keine Ausgabe');
  assert.equal(r.body.data.balance, 0);
  assert.deepEqual(r.body.data.byCategory, [], 'kein Kategoriebalken aus einer Erwartung');
  assert.deepEqual(r.body.data.pending, { count: 1, income: 0, expenses: -12.99 },
    'aber ausgewiesen, sonst verschwaende das Geld zwischen Liste und Summen (#637)');

  const stats = await call('GET', '/budget/stats?range=month&anchor=2026-11-15');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.totals.expenses, 0, 'Statistik zaehlt nur Gebuchtes');

  const october = await call('GET', '/budget/summary?month=2026-10');
  assert.equal(october.body.data.expenses, -12.99, 'die echte Zeile zaehlt wie bisher');
  assert.equal(october.body.data.pending.count, 0, 'und hat keine Erwartung neben sich');
});

test('eine echte erwartete Buchung und ein Abo addieren sich in `pending`', async () => {
  await createSub();
  db.prepare(`INSERT INTO budget_entries (title, amount, category, date, is_pending, created_by, owner_id)
              VALUES ('Strom', -50, 'housing', '2026-11-03', 1, ?, ?)`).run(A, A);
  const r = await call('GET', '/budget/summary?month=2026-11');
  assert.deepEqual(r.body.data.pending, { count: 2, income: 0, expenses: -62.99 });
});

// ── Rhythmus ────────────────────────────────────────────────────────────────────

test('Monatsende: die Projektion geht denselben Weg wie "Als verlaengert markieren"', async () => {
  const sub = await createSub({ next_payment_date: '2026-10-31' });
  const projected = [];
  for (const ym of ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03']) {
    projected.push(...expectedOf(await month(ym)).map((r) => r.date));
  }
  // Der 31. klemmt im November auf den 30. und bleibt dort - genau das tut
  // addBillingCycle(), mit dem /renew weiterrueckt. Eine eigene Rechnung
  // ("immer der 31., soweit der Monat ihn hat") zeigte Termine, die das
  // Verlaengern nie bucht.
  assert.deepEqual(projected, ['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28', '2027-03-28']);

  const renewed = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', `/budget/subscriptions/${sub.id}/renew`);
    assert.equal(r.status, 200);
    renewed.push(r.body.data.next_payment_date);
  }
  assert.deepEqual(renewed, projected, 'was erwartet angezeigt wurde, ist genau das, was gebucht wird');
});

test('jaehrliches Abo: nur der Faelligkeitsmonat des Folgejahres', async () => {
  await createSub({ billing_cycle: 'yearly', next_payment_date: '2026-12-05', amount: 99 });
  assert.equal(expectedOf(await month('2027-01')).length, 0);
  assert.equal(expectedOf(await month('2027-11')).length, 0);
  assert.deepEqual(expectedOf(await month('2027-12')).map((r) => [r.date, r.amount]), [['2027-12-05', -99]]);
  assert.deepEqual(expectedOf(await month('2028-12')).map((r) => r.date), ['2028-12-05']);
});

test('woechentliches Abo: weitere Termine im Monat der echten Zeile, sie selbst nie doppelt', async () => {
  await createSub({ billing_cycle: 'weekly', next_payment_date: '2026-10-13', amount: 5 });
  const october = await month('2026-10');
  assert.deepEqual(bookedOf(october).map((r) => r.date), ['2026-10-13']);
  assert.deepEqual(expectedOf(october).map((r) => r.date).sort(), ['2026-10-20', '2026-10-27']);
  assert.equal(october.filter((r) => r.date === '2026-10-13').length, 1, 'der Tag der echten Zeile steht einmal da');
  const november = expectedOf(await month('2026-11')).map((r) => r.date).sort();
  assert.deepEqual(november, ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24']);
});

test('"alle 3 Monate" und taeglich mit Abstand folgen cycle_interval', async () => {
  await createSub({ cycle_interval: 3, next_payment_date: '2026-10-20' });
  assert.equal(expectedOf(await month('2026-11')).length, 0);
  assert.equal(expectedOf(await month('2026-12')).length, 0);
  assert.deepEqual(expectedOf(await month('2027-01')).map((r) => r.date), ['2027-01-20']);
  db.prepare('DELETE FROM budget_subscriptions').run();
  db.prepare('DELETE FROM budget_entries').run();
  await createSub({ billing_cycle: 'daily', cycle_interval: 10, next_payment_date: '2026-10-25' });
  const want = [];
  for (let d = addBillingCycle('2026-10-25', 'daily', 10); d <= '2026-11-30'; d = addBillingCycle(d, 'daily', 10)) {
    if (d >= '2026-11-01') want.push(d);
  }
  assert.deepEqual(expectedOf(await month('2026-11')).map((r) => r.date).sort(), want);
});

// ── Ende, Pause, Vergangenheit ──────────────────────────────────────────────────

test('pausiertes Abo: keine erwartete Zeile', async () => {
  const sub = await createSub();
  assert.equal(expectedOf(await month('2026-11')).length, 1);
  const r = await call('PUT', `/budget/subscriptions/${sub.id}`, { body: { enabled: false } });
  assert.equal(r.status, 200);
  assert.equal((await month('2026-11')).length, 0, 'ohne "Ins Budget einbeziehen" steht nichts im Budget');
  assert.equal((await month('2026-10')).length, 0);
});

test('Ende an einem Datum: die Zahlung am Endtag ist die letzte', async () => {
  await createSub({ end_type: 'on_date', end_date: '2026-12-20' });
  assert.equal(expectedOf(await month('2026-11')).length, 1);
  assert.deepEqual(expectedOf(await month('2026-12')).map((r) => r.date), ['2026-12-20']);
  assert.equal(expectedOf(await month('2027-01')).length, 0, 'hinter dem Ende kommt nichts mehr');
});

test('Ende nach N Zahlungen: die anstehende zaehlt mit', async () => {
  await createSub({ end_type: 'after_count', occurrence_count: 3 });
  // Zahlung 1 ist die gebuchte im Oktober, 2 und 3 sind erwartet.
  assert.equal(expectedOf(await month('2026-11')).length, 1);
  assert.equal(expectedOf(await month('2026-12')).length, 1);
  assert.equal(expectedOf(await month('2027-01')).length, 0);
});

test('abgeschlossenes Abo: nichts', async () => {
  const sub = await createSub({ end_type: 'after_count', occurrence_count: 1 });
  assert.equal(expectedOf(await month('2026-11')).length, 0, 'eine einzige Zahlung hat keinen Folgemonat');
  const r = await call('POST', `/budget/subscriptions/${sub.id}/renew`);
  assert.equal(r.body.data.status, 'completed');
  assert.equal(expectedOf(await month('2026-11')).length, 0);
});

test('vergangene Monate bekommen keine Projektion, der laufende schon', async () => {
  await createSub({ next_payment_date: '2026-07-15' });
  assert.deepEqual(bookedOf(await month('2026-07')).map((r) => r.date), ['2026-07-15']);
  assert.equal(expectedOf(await month('2026-08')).length, 0, 'August ist vorbei');
  assert.equal(expectedOf(await month('2026-09')).length, 0, 'September ist vorbei');
  assert.deepEqual(expectedOf(await month('2026-10')).map((r) => r.date), ['2026-10-15'], 'der laufende Monat zeigt, was aussteht');
  assert.deepEqual(expectedOf(await month('2026-11')).map((r) => r.date), ['2026-11-15']);
});

test('"heute" folgt der Haushaltszone, nicht dem UTC-Tag', async () => {
  await createSub({ next_payment_date: '2026-07-15' });
  // 31.10. 20:00 UTC: in UTC noch Oktober, in Kiritimati (UTC+14) schon der 1.11.
  mock.timers.setTime(new Date('2026-10-31T20:00:00Z').getTime());
  assert.equal(expectedOf(await month('2026-10')).length, 1, 'UTC-Haushalt: Oktober laeuft noch');
  setConfig('household_timezone', 'Pacific/Kiritimati');
  assert.equal(expectedOf(await month('2026-10')).length, 0, 'Kiritimati: Oktober ist vorbei');
  assert.equal(expectedOf(await month('2026-11')).length, 1);
});

test('nach dem Verlaengern: die gebuchte Zeile ersetzt die erwartete, keine Doppelung', async () => {
  const sub = await createSub();
  await call('POST', `/budget/subscriptions/${sub.id}/renew`);
  const november = await month('2026-11');
  assert.equal(november.length, 1);
  assert.ok(Number.isInteger(november[0].id), 'jetzt die gebuchte Zeile');
  assert.notEqual(november[0].expected, true);
  assert.deepEqual(expectedOf(await month('2026-12')).map((r) => r.date), ['2026-12-20']);
  assert.equal(expectedOf(await month('2026-10')).length, 0, 'der bezahlte Monat bekommt nichts dazu');
});

// ── Sichtbarkeit ────────────────────────────────────────────────────────────────

test('persoenlicher Modus: die erwartete Zeile folgt exakt der echten', async () => {
  setConfig('budget_mode', 'personal');
  await createSub({ name: 'Privat', visibility: 'private' });
  await createSub({ name: 'Geteilt', visibility: 'shared' });

  const titles = async (ym, as, scope) => (await month(ym, { as, query: `&scope=${scope}` })).map((r) => r.title).sort();
  // Was die echte Zeile im Oktober zeigt, zeigt die erwartete im November -
  // fuer jeden Betrachter und jede Ansicht dieselbe Menge.
  for (const [as, scope] of [[A, 'mine'], [A, 'household'], [B, 'mine'], [B, 'household']]) {
    const real = await titles('2026-10', as, scope);
    const projected = await titles('2026-11', as, scope);
    assert.deepEqual(projected, real, `Betrachter ${as === A ? 'A' : 'B'}, scope=${scope}`);
  }
  assert.deepEqual(await titles('2026-11', A, 'mine'), ['Geteilt', 'Privat']);
  assert.deepEqual(await titles('2026-11', A, 'household'), ['Geteilt']);
  assert.deepEqual(await titles('2026-11', B, 'mine'), [], 'ein fremdes privates Abo erscheint nirgends');
  assert.deepEqual(await titles('2026-11', B, 'household'), ['Geteilt']);

  const summaryB = await call('GET', '/budget/summary?month=2026-11&scope=household', { as: B });
  assert.equal(summaryB.body.data.pending.count, 1, 'auch die Zahl verraet das private Abo nicht');
  const csvB = await call('GET', '/budget/export?month=2026-11&scope=household', { as: B });
  assert.doesNotMatch(csvB.text, /Privat/);
  assert.match(csvB.text, /Geteilt/);
});

// ── Filter der Liste ────────────────────────────────────────────────────────────

test('Filter: Kategorie trifft, Konto, Darlehen und Suche zeigen keine erwartete Zeile', async () => {
  await createSub();
  assert.equal(expectedOf(await month('2026-11', { query: '&category=subscriptions' })).length, 1);
  assert.equal(expectedOf(await month('2026-11', { query: '&category=food' })).length, 0);
  assert.equal(expectedOf(await month('2026-11', { query: '&account_id=1' })).length, 0,
    'eine erwartete Abo-Zahlung haengt an keinem Konto');
  const search = await call('GET', '/budget?q=Streaming');
  assert.equal(search.status, 200);
  assert.equal(expectedOf(search.body.data).length, 0, 'die Suche findet Buchungen, keine Erwartungen');
  assert.equal(search.body.data.length, 1);
});

// ── Betrag in Fremdwaehrung, Export ─────────────────────────────────────────────

test('Fremdwaehrung: Betrag und Titel wie an der gebuchten Zeile', async () => {
  db.prepare(`INSERT INTO subscription_exchange_rates (base_currency, quote_currency, rate, fetched_at)
              VALUES ('EUR', 'USD', 0.9, ?)`).run(new Date(NOW).toISOString());
  await createSub({ name: 'Cloud', amount: 10, currency: 'USD' });
  const real = (await month('2026-10'))[0];
  const projected = (await month('2026-11'))[0];
  assert.equal(real.amount, -9);
  assert.equal(projected.amount, real.amount);
  assert.equal(projected.title, real.title);
  assert.equal(projected.title, 'Cloud (USD)');
});

test('CSV-Export: die erwartete Zeile bleibt drin, gekennzeichnet als Expected', async () => {
  await createSub();
  const csv = await call('GET', '/budget/export?month=2026-11');
  assert.equal(csv.status, 200);
  const line = csv.text.split('\n').find((l) => l.includes('Streaming'));
  assert.ok(line, 'das Abo steht im Export des Folgemonats');
  assert.match(line, /^2026-11-20,"Streaming",-12\.99,subscriptions,/);
  assert.match(line, /,Expected,/);
  const october = await call('GET', '/budget/export?month=2026-10');
  assert.match(october.text.split('\n').find((l) => l.includes('Streaming')), /,Booked,/);
});

test('erwartete Zeile traegt die Form einer Buchung, aber nichts aus dem Abo darueber hinaus', async () => {
  await createSub({ notes: 'geheim', account_username: 'konto@example.org' });
  const row = (await month('2026-11'))[0];
  assert.deepEqual(row.responsible_users, []);
  assert.deepEqual(row.attachments, []);
  assert.equal(row.is_recurring, 0);
  assert.equal(row.account_id, null);
  assert.equal(JSON.stringify(row).includes('geheim'), false);
  assert.equal(JSON.stringify(row).includes('konto@example.org'), false);
});

// ── Grenzen der Arbeit je Anfrage ───────────────────────────────────────────────
// Die Projektion rechnet beim Lesen, also bei JEDEM Aufschlagen eines Monats.
// Was sie kostet, darf weder am Alter eines Abos haengen noch an der Breite
// des Bereichs noch an der Zahl der Abos - und wo eine Grenze greift, sagt die
// Antwort es, statt eine kuerzere Liste wie eine vollstaendige aussehen zu
// lassen.

const projection = await import('../server/services/subscription-budget-projection.js');

/** Die Referenz: Schritt fuer Schritt mit addBillingCycle, wie /renew. */
function steppedDates(sub, from, to) {
  const dates = [];
  let remaining = sub.end_type === 'after_count'
    ? Number(sub.occurrence_count) - Number(sub.occurrences_done || 0) - 1 : Infinity;
  let date = sub.next_payment_date;
  while (remaining > 0) {
    const next = addBillingCycle(date, sub.billing_cycle, sub.cycle_interval);
    if (next > to) break;
    if (sub.end_type === 'on_date' && next > sub.end_date) break;
    if (next >= from) dates.push(next);
    date = next;
    remaining -= 1;
  }
  return dates;
}

test('ein uraltes Abo kostet nicht mehr Schritte als ein neues', () => {
  const base = { enabled: 1, completed_at: null, end_type: 'never', cycle_interval: 1 };
  for (const [cycle, start] of [['daily', '1900-01-01'], ['weekly', '1900-01-01'], ['monthly', '1000-01-31'], ['yearly', '1004-02-29']]) {
    const sub = { ...base, billing_cycle: cycle, next_payment_date: start };
    const stats = { steps: 0 };
    const dates = projection.upcomingPaymentDates(sub, '2026-11-01', '2026-11-30', stats);
    assert.deepEqual(dates, steppedDates(sub, '2026-11-01', '2026-11-30'), `${cycle} ab ${start}: dieselben Tage wie Schritt fuer Schritt`);
    assert.ok(stats.steps > 0 || dates.length === 0, 'der Zaehler misst');
    assert.ok(stats.steps <= dates.length + 2,
      `${cycle} ab ${start}: ${stats.steps} Schritte fuer ${dates.length} Tage - der Vorlauf wird gesprungen, nicht gezaehlt`);
  }
});

test('Sprung zum Bereichsanfang == Schritt fuer Schritt (Aequivalenz, auch am Monatsende)', () => {
  // Fester Zufall: dieselben Faelle bei jedem Lauf.
  let seed = 1844;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const starts = ['2019-01-29', '2019-01-30', '2019-01-31', '2020-02-29', '2023-08-31', '2024-12-31',
    '2023-11-30', '2025-03-15', '2026-10-28', '1996-02-29', '2000-02-29', '2026-10-01'];
  const windows = [['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2027-02-01', '2027-02-28'],
    ['2028-02-01', '2028-02-29'], ['2026-10-11', '2027-10-11'], ['2100-02-01', '2100-03-31'], ['2031-01-01', '2031-12-31']];
  let cases = 0;
  for (const start of starts) {
    for (const cycle of ['daily', 'weekly', 'monthly', 'yearly']) {
      for (const interval of [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 24, 48]) {
        const [from, to] = windows[rnd(windows.length)];
        const end = rnd(4);
        const sub = {
          enabled: 1, completed_at: null, billing_cycle: cycle, cycle_interval: interval, next_payment_date: start,
          end_type: end === 1 ? 'on_date' : end === 2 ? 'after_count' : 'never',
          end_date: end === 1 ? ['2026-11-15', '2027-02-28', '2030-06-30'][rnd(3)] : null,
          occurrence_count: end === 2 ? 1 + rnd(400) : null,
          occurrences_done: end === 2 ? rnd(3) : 0,
        };
        assert.deepEqual(projection.upcomingPaymentDates(sub, from, to), steppedDates(sub, from, to),
          JSON.stringify({ start, cycle, interval, from, to, end: sub.end_type, end_date: sub.end_date, n: sub.occurrence_count, done: sub.occurrences_done }));
        cases += 1;
      }
    }
  }
  assert.equal(cases, starts.length * 4 * 12);
});

test('Gesamtgrenze: zu viele erwartete Zeilen brechen das Zaehlen ab, und die Antwort sagt es', async () => {
  // Direkt gesaet (170 Abos ueber die Route waeren 170 Anfragen), aber in der
  // Form, die die Route hinterlaesst: jedes Abo mit seiner verknuepften Buchung.
  const insertEntry = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id)
    VALUES (?, -1, 'subscriptions', '2026-10-01', ?, ?)`);
  const insert = db.prepare(`
    INSERT INTO budget_subscriptions (name, amount, currency, billing_cycle, cycle_interval, next_payment_date, created_by, owner_id, budget_entry_id)
    VALUES (?, 1, 'EUR', 'daily', 1, '2026-10-01', ?, ?, ?)`);
  const perSub = 30; // November, taeglich
  const count = Math.ceil(projection.MAX_EXPECTED_ROWS / perSub) + 1;
  for (let i = 0; i < count; i += 1) insert.run(`Abo ${i}`, A, A, insertEntry.run(`Abo ${i}`, A, A).lastInsertRowid);

  const stats = { steps: 0 };
  const direct = projection.expectedSubscriptionEntries(db, { from: '2026-11-01', to: '2026-11-30', stats });
  assert.equal(direct.omitted, true);
  assert.deepEqual(direct.entries, [], 'ganz oder gar nicht: eine gekuerzte Liste saehe vollstaendig aus');
  assert.ok(stats.steps <= projection.MAX_EXPECTED_ROWS + count * 2,
    `abgebrochen nach ${stats.steps} Schritten, nicht erst nach ${count * perSub}`);

  const list = await call('GET', '/budget?month=2026-11');
  assert.equal(list.status, 200);
  assert.equal(expectedOf(list.body.data).length, 0);
  assert.equal(list.body.meta?.expected_omitted, true, 'die Liste sagt, dass die Erwartungen fehlen');

  const summary = await call('GET', '/budget/summary?month=2026-11');
  assert.equal(summary.body.data.pending.count, 0, 'keine Teilsumme');
  assert.equal(summary.body.data.pending.expected_omitted, true, 'die Zahl sagt, dass sie unvollstaendig ist');

  // Unter der Grenze: alles da, kein Hinweis.
  db.prepare('DELETE FROM budget_subscriptions WHERE id IN (SELECT id FROM budget_subscriptions LIMIT 2)').run();
  const ok = await call('GET', '/budget?month=2026-11');
  assert.equal(expectedOf(ok.body.data).length, (count - 2) * perSub);
  assert.equal(ok.body.meta?.expected_omitted, undefined);
});

test('Export ueber Jahre: erwartete Zeilen hoechstens fuer das Fenster, und der Kopf nennt das Ende', async () => {
  await createSub();
  const res = await fetch(`${baseUrl}/budget/export?from=2026-01-01&to=2099-12-31`);
  const text = await res.text();
  const expectedLines = text.split('\n').filter((l) => l.includes(',Expected,'));
  // Fenster: ab dem laufenden Monat (01.10.2026), PROJECTION_WINDOW_DAYS weit.
  assert.equal(projection.PROJECTION_WINDOW_DAYS, 366);
  assert.deepEqual(expectedLines.map((l) => l.slice(0, 10)), [
    '2026-11-20', '2026-12-20', '2027-01-20', '2027-02-20', '2027-03-20', '2027-04-20',
    '2027-05-20', '2027-06-20', '2027-07-20', '2027-08-20', '2027-09-20',
  ]);
  assert.equal(res.headers.get('x-budget-expected-until'), '2027-10-01');

  const monthly = await fetch(`${baseUrl}/budget/export?month=2026-11`);
  assert.equal(monthly.headers.get('x-budget-expected-until'), null, 'ein Monat passt ins Fenster: kein Hinweis');
  await monthly.text();
});

// ── Fehlender oder unpassender Zustand: keine Projektion ────────────────────────
// Die erwartete Zeile setzt die GEBUCHTE fort. Fehlt die, oder passt ein Wert
// nicht in die Positivliste, gibt es keine erwartete Zeile - nie "trotzdem",
// und nie ein Ersatzwert, der wie eine Zahlung aussieht.

test('ohne verknuepfte Buchung keine Projektion (von Hand geloescht), nach dem Speichern wieder', async () => {
  const sub = await createSub();
  assert.equal(expectedOf(await month('2026-11')).length, 1);
  const del = await call('DELETE', `/budget/${sub.budget_entry_id}`);
  assert.ok(del.status === 200 || del.status === 204, `Buchung geloescht: ${del.status}`);
  assert.equal(db.prepare('SELECT budget_entry_id FROM budget_subscriptions WHERE id = ?').get(sub.id).budget_entry_id, null,
    'die Verknuepfung ist verwaist (ON DELETE SET NULL)');
  assert.equal((await month('2026-11')).length, 0, 'ohne gebuchte Zeile setzt nichts sie fort');
  assert.equal((await call('GET', '/budget/summary?month=2026-11')).body.data.pending.count, 0);
  // Das Abo speichern legt die Buchung wieder an - und mit ihr die Folgemonate.
  await call('PUT', `/budget/subscriptions/${sub.id}`, { body: { name: 'Streaming' } });
  assert.equal(expectedOf(await month('2026-11')).length, 1);
});

test('Positivliste: unbekanntes Ende, Ende ohne Datum, unbekannter Rhythmus, abgeschlossen trotz Schalter', () => {
  const ok = { enabled: 1, completed_at: null, billing_cycle: 'monthly', cycle_interval: 1, next_payment_date: '2026-10-20', end_type: 'never' };
  const dates = (over) => projection.upcomingPaymentDates({ ...ok, ...over }, '2026-11-01', '2026-11-30');
  assert.deepEqual(dates({}), ['2026-11-20'], 'Vorbedingung: der gute Zustand projiziert');
  assert.deepEqual(dates({ end_type: 'someday' }), [], 'ein Ende, das niemand kennt, ist nicht "nie"');
  assert.deepEqual(dates({ end_type: null }), []);
  assert.deepEqual(dates({ end_type: 'on_date', end_date: null }), [], 'Ende an einem Datum ohne Datum ist nicht unendlich');
  assert.deepEqual(dates({ end_type: 'on_date', end_date: '2026-13-45' }), []);
  assert.deepEqual(dates({ end_type: 'after_count', occurrence_count: null }), []);
  assert.deepEqual(dates({ end_type: 'after_count', occurrence_count: 'viele' }), []);
  assert.deepEqual(dates({ billing_cycle: 'quarterly' }), []);
  assert.deepEqual(dates({ cycle_interval: 0 }), []);
  assert.deepEqual(dates({ next_payment_date: '' }), []);
  assert.deepEqual(dates({ next_payment_date: '2026-02-30' }), []);
  assert.deepEqual(dates({ enabled: 0 }), []);
  assert.deepEqual(dates({ enabled: 1, completed_at: '2026-10-01T00:00:00Z' }), [], 'abgeschlossen schlaegt den Schalter');
});

test('abgeschlossen, aber der Schalter steht noch: die Route projiziert nicht', async () => {
  const sub = await createSub();
  // Vorbedingung, ohne die der Fall nichts misst: VOR der Aenderung steht
  // genau eine erwartete Zeile da. Waere die Projektion tot, bliebe die
  // Null unten gruen.
  assert.equal(expectedOf(await month('2026-11')).length, 1, 'Vorbedingung: das laufende Abo projiziert');
  db.prepare("UPDATE budget_subscriptions SET completed_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(sub.id);
  assert.equal(expectedOf(await month('2026-11')).length, 0);
});

// ── Zwei Mitglieder: die Sichtbarkeit haengt an der gebuchten Zeile ─────────────

test('die gebuchte Zeile wird privat: der andere sieht weder sie noch ihre Fortsetzung', async () => {
  setConfig('budget_mode', 'personal');
  const sub = await createSub({ name: 'Geteilt', visibility: 'shared' });
  assert.equal(expectedOf(await month('2026-11', { as: B, query: '&scope=household' })).length, 1);
  const put = await call('PUT', `/budget/${sub.budget_entry_id}`, { body: { visibility: 'private' } });
  assert.equal(put.status, 200, put.text);
  for (const scope of ['mine', 'household']) {
    assert.equal((await month('2026-10', { as: B, query: `&scope=${scope}` })).length, 0, `B, ${scope}: die echte Zeile ist weg`);
    assert.equal((await month('2026-11', { as: B, query: `&scope=${scope}` })).length, 0, `B, ${scope}: also auch keine erwartete`);
    const summary = await call('GET', `/budget/summary?month=2026-11&scope=${scope}`, { as: B });
    assert.equal(summary.body.data.pending.count, 0);
  }
  assert.equal(expectedOf(await month('2026-11', { as: A, query: '&scope=mine' })).length, 1, 'A sieht beide weiter');
  // Die Abo-Liste zeigt B das geteilte Abo weiter, aber nicht mehr, an
  // welcher (fuer B unsichtbaren) Buchung es haengt.
  const subsB = (await call('GET', '/budget/subscriptions', { as: B })).body.data.subscriptions;
  assert.equal(subsB.find((x) => x.id === sub.id).budget_entry_id, null);
});

test('"nur Betrag" an der gebuchten Zeile: fuer andere gibt es KEINE erwartete Zeile - in keiner Antwort', async () => {
  setConfig('budget_mode', 'personal');
  const sub = await createSub({ name: 'Therapie', visibility: 'shared' });
  const put = await call('PUT', `/budget/${sub.budget_entry_id}`, { body: { visibility: 'shared_amount' } });
  assert.equal(put.status, 200, put.text);
  const real = (await month('2026-10', { as: B, query: '&scope=household' }))[0];
  assert.equal(real.details_hidden, true, 'Vorbedingung: die echte Zeile ist fuer B maskiert');

  // AUSLASSEN STATT MASKIEREN. Eine maskierte Buchung bleibt stehen, weil ihr
  // Betrag in den Summen steckt und sie ohne die Zeile nicht aufgingen. Eine
  // erwartete Zeile steckt in keiner Summe: es gibt nichts, das ihr Fehlen
  // verfaelschte - und eine Reihe gleicher Betraege im Rhythmus eines Abos
  // waere der Zweck, auch ohne Titel.
  //
  // Geprueft wird JEDE Antwort des Budgets, die eine Zeile oder eine Zahl aus
  // der Projektion tragen koennte, fuer beide Ansichten.
  for (const scope of ['mine', 'household']) {
    const q = `&scope=${scope}`;
    const answers = {
      list: await call('GET', `/budget?month=2026-11${q}`, { as: B }),
      listByCategory: await call('GET', `/budget?month=2026-11&category=subscriptions${q}`, { as: B }),
      listMasked: await call('GET', `/budget?month=2026-11&category=__private__${q}`, { as: B }),
      summary: await call('GET', `/budget/summary?month=2026-11${q}`, { as: B }),
      exportMonth: await call('GET', `/budget/export?month=2026-11${q}`, { as: B }),
      exportRange: await call('GET', `/budget/export?from=2026-11-01&to=2027-06-30${q}`, { as: B }),
      stats: await call('GET', `/budget/stats?range=month&anchor=2026-11-15${q}`, { as: B }),
      plans: await call('GET', `/budget/plans?month=2026-11${q}`, { as: B }),
    };
    for (const [name, answer] of Object.entries(answers)) {
      assert.equal(answer.status, 200, `${name} (${scope}): ${answer.text.slice(0, 120)}`);
      assert.doesNotMatch(answer.text, /Therapie/, `${name} (${scope}): der Name des Abos`);
      assert.doesNotMatch(answer.text, /subscription_id/, `${name} (${scope}): ein Verweis auf das Abo`);
      assert.doesNotMatch(answer.text, /"expected":true|,Expected,/, `${name} (${scope}): eine erwartete Zeile`);
      assert.doesNotMatch(answer.text, /subscriptions/, `${name} (${scope}): die Kategorie der Reihe`);
      // Die Statistik nennt im Vergleich den Vormonat, und dort steht der
      // Betrag der GEBUCHTEN Oktober-Zeile - den teilt die Stufe ja gerade.
      if (name !== 'stats') assert.doesNotMatch(answer.text, /12\.99/, `${name} (${scope}): der Betrag der Reihe`);
    }
    assert.deepEqual(answers.list.body.data, [], `${scope}: der November ist fuer B leer`);
    assert.equal(answers.summary.body.data.pending.count, 0, `${scope}: und keine Zahl zaehlt sie`);
  }

  // DER RUECKVERWEIS. Die Abo-Liste zeigt B das geteilte Abo weiter - es IST
  // geteilt -, aber nicht, an welcher Buchung es haengt: deren id steht an der
  // maskierten Oktober-Zeile.
  const subsB = (await call('GET', '/budget/subscriptions', { as: B })).body.data.subscriptions;
  const seenByB = subsB.find((x) => x.id === sub.id);
  assert.ok(seenByB, 'Vorbedingung: das geteilte Abo steht in Bs Abo-Liste');
  assert.equal(seenByB.budget_entry_id, null, 'ohne Verweis auf die Buchung, deren Zweck B nicht sieht');
  const subsA = (await call('GET', '/budget/subscriptions', { as: A })).body.data.subscriptions;
  assert.equal(subsA.find((x) => x.id === sub.id).budget_entry_id, sub.budget_entry_id, 'A behaelt ihn');

  // A selbst sieht alles.
  const own = await month('2026-11', { as: A, query: '&scope=mine' });
  assert.equal(own.length, 1);
  assert.equal(own[0].title, 'Therapie');
  assert.equal(own[0].subscription_id, sub.id);
});

test('das Abo ist privat, seine Buchung wurde geteilt: wer das Abo nicht sieht, bekommt keine erwartete Zeile', async () => {
  setConfig('budget_mode', 'personal');
  const sub = await createSub({ name: 'Privat', visibility: 'private' });
  const put = await call('PUT', `/budget/${sub.budget_entry_id}`, { body: { visibility: 'shared' } });
  assert.equal(put.status, 200, put.text);
  assert.equal((await month('2026-10', { as: B, query: '&scope=household' })).length, 1, 'Vorbedingung: die Buchung selbst sieht B');
  for (const scope of ['mine', 'household']) {
    assert.deepEqual(await month('2026-11', { as: B, query: `&scope=${scope}` }), [], `B, ${scope}`);
    const csv = await call('GET', `/budget/export?month=2026-11&scope=${scope}`, { as: B });
    assert.doesNotMatch(csv.text, /Privat|Expected/);
  }
  assert.equal(expectedOf(await month('2026-11', { as: A, query: '&scope=household' })).length, 1, 'A sieht sie, im Haushalts-Topf wie die Buchung');
});

test('eine erwartete Zeile hat fuer jeden, der sie sieht, dieselbe Form - eine maskierte gibt es nicht', async () => {
  setConfig('budget_mode', 'personal');
  await createSub({ name: 'Eins', visibility: 'shared' });
  await createSub({ name: 'Zwei', visibility: 'private' });
  const shapes = new Set();
  for (const [as, scope] of [[A, 'mine'], [A, 'household'], [B, 'mine'], [B, 'household']]) {
    for (const row of await month('2026-11', { as, query: `&scope=${scope}` })) {
      assert.notEqual(row.details_hidden, true);
      shapes.add(Object.keys(row).sort().join(','));
    }
  }
  assert.equal(shapes.size, 1, [...shapes].join(' | '));
});

test('eine fremde private Buchung am selben Tag unterdrueckt nichts und verraet nichts', async () => {
  setConfig('budget_mode', 'personal');
  await createSub({ name: 'Geteilt', visibility: 'shared' }, { as: B });
  const before = await month('2026-11', { as: B, query: '&scope=mine' });
  // Vorbedingung, ohne die der Vergleich unten zwei leere Listen vergliche:
  // B sieht genau eine erwartete Zeile, die eine fremde Buchung unterdruecken
  // KOENNTE.
  assert.deepEqual(expectedOf(before).map((r) => [r.date, r.title]), [['2026-11-20', 'Geteilt']]);
  // A legt eine private Buchung mit gleichem Titel, Betrag und Tag an.
  db.prepare(`INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility)
              VALUES ('Geteilt', -12.99, 'subscriptions', '2026-11-20', ?, ?, 'private')`).run(A, A);
  assert.deepEqual(await month('2026-11', { as: B, query: '&scope=mine' }), before,
    'die Antwort an B ist dieselbe: es gibt keine Unterdrueckung, an der eine fremde Zeile haengen koennte');
});

test('Fremdwaehrung ohne gespeicherten Kurs: der Betrag der gebuchten Zeile, kein zweiter Wert', async () => {
  await createSub({ name: 'Cloud', amount: 10, currency: 'USD' });
  const real = (await month('2026-10'))[0];
  const projected = (await month('2026-11'))[0];
  assert.equal(projected.amount, real.amount);
  // Der Kurs aendert sich spaeter: die erwartete Zeile bleibt bei dem, was gebucht steht.
  db.prepare(`INSERT INTO subscription_exchange_rates (base_currency, quote_currency, rate, fetched_at)
              VALUES ('EUR', 'USD', 0.5, ?)`).run(new Date(NOW).toISOString());
  assert.equal((await month('2026-11'))[0].amount, real.amount);
});
