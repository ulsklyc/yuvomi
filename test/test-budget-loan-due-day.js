/**
 * Test: Faelligkeitstag am Darlehen (#1631)
 *
 * Zweck: Ein Darlehen kannte den Monat seiner Rate, aber keinen Tag. "Als
 *        bezahlt markieren" datierte die Rate deshalb auf den Tag des Tippens -
 *        bei einem Einzug am 27. landete sie am 25. oder am 2. des Folgemonats,
 *        im zweiten Fall im falschen Budgetmonat. Geprueft wird gegen die echten
 *        Routen und die echte Helferfunktion:
 *          - das Klemmen auf den letzten Tag kuerzerer Monate steht an EINER
 *            Stelle (`dueDateInMonth`), und `next_due_date` kommt von dort;
 *          - der Server liefert das Datum, wer es als `paid_date` durchreicht,
 *            bucht die Rate in den Monat, in dem sie faellig ist - gleich, wann
 *            getippt wird;
 *          - ohne Faelligkeitstag ist `next_due_date` fuer die Rate des
 *            laufenden Monats null (gebucht wird auf heute), fuer eine Rate,
 *            deren Monat schon vorbei ist, der Erste dieses Monats (#1741);
 *          - ein eigenes `paid_date` per API bleibt, was es war;
 *          - ein ungueltiger Tag ist eine Absage mit Grund, kein gerundeter Wert;
 *          - "bereits gezahlte Raten" tragen den Tag nur beim Anlegen;
 *          - die Migration laeuft auf einer Bestands-DB und laesst sie, wie sie war.
 *
 * DIE UHR WIRD GESTELLT, UND DIE ZONE AUCH. `next_due_date` ist keine Frage an
 * die Uhr: der Faelligkeitstag einer Rate haengt nicht daran, wann jemand fragt.
 * Genau das wird gemessen - an einem Zeitpunkt, an dem der Tag des Haushalts
 * (Pacific/Kiritimati, UTC+14) schon der 2. November ist, waehrend UTC noch den
 * 1. zeigt. Wer das Datum aus "heute" ableitete, in welcher Zone auch immer,
 * fiele hier auf.
 *
 * OHNE FAELLIGKEITSTAG IST ES SEIT #1741 DOCH EINE FRAGE AN DIE UHR - an den
 * MONAT des Haushalts: ist der Faelligkeitsmonat vorbei? Jeder Test, der dort
 * ein Datum oder null erwartet, stellt deshalb Uhr und Zone, und zwei tun es
 * am Monatswechsel, einmal mit dem Haushalt vor UTC, einmal dahinter.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-budget-loan-due-day.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const { dueDateInMonth } = await import('../server/routes/budget/helpers.js');
const { todayKey, utcDateKey } = await import('../server/utils/timezone.js');
const { MIGRATIONS, migrate } = dbmod;
const db = dbmod.get();

const USER = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('a', 'A', 'x', 'admin')"
).run().lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = USER;
  req.authRole = 'admin';
  req.session = { userId: USER, role: 'admin' };
  next();
});
app.use('/', budgetRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((resolve) => {
  server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

/** Ein zinsfreies Darlehen; `over` ueberschreibt und ergaenzt den Koerper. */
async function createLoan(over = {}) {
  const res = await call('POST', '/loans', {
    borrower: 'Bank', title: 'Autokredit', total_amount: 1200, installment_count: 12,
    start_month: '2026-10', direction: 'borrowed', ...over,
  });
  return res;
}

async function loanFromList(id) {
  const res = await call('GET', '/loans');
  assert.equal(res.status, 200);
  return res.body.data.loans.find((loan) => loan.id === id);
}

/**
 * "Als bezahlt markieren", wie die Seite es schickt (markLoanPayment in
 * public/pages/budget.js): das Datum des Servers, sonst heute - und heute ist
 * der Tag des Haushalts. Dass die Seite genau das tut, misst test:budget-ui.
 */
async function markPaid(id) {
  const loan = await loanFromList(id);
  return call('POST', `/loans/${id}/payments`, {
    installment_number: loan.next_installment_number,
    paid_date: loan.next_due_date ?? todayKey(db),
  });
}

function setZone(zone) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);
}

/** Uhr und Zone fuer die Dauer von `fn` stellen. */
async function at(iso, zone, fn) {
  setZone(zone);
  mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
}

const entryOf = (payment) => db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(payment.budget_entry_id);
const paymentsOf = (loanId) => db.prepare(
  'SELECT installment_number, paid_date, budget_entry_id FROM budget_loan_payments WHERE loan_id = ? ORDER BY installment_number'
).all(loanId);

// --------------------------------------------------------------------------
// Das Klemmen: eine Stelle
// --------------------------------------------------------------------------

test('dueDateInMonth klemmt auf den letzten Tag kuerzerer Monate', () => {
  assert.equal(dueDateInMonth('2026-10', 27), '2026-10-27');
  assert.equal(dueDateInMonth('2026-01', 31), '2026-01-31');
  assert.equal(dueDateInMonth('2026-02', 31), '2026-02-28', '31 im Februar');
  assert.equal(dueDateInMonth('2028-02', 31), '2028-02-29', '31 im Februar eines Schaltjahrs');
  assert.equal(dueDateInMonth('2028-02', 29), '2028-02-29');
  assert.equal(dueDateInMonth('2026-02', 29), '2026-02-28', '29 in einem Jahr ohne Schalttag');
  assert.equal(dueDateInMonth('2100-02', 29), '2100-02-28', '2100 ist kein Schaltjahr');
  assert.equal(dueDateInMonth('2026-04', 31), '2026-04-30', '31 im April');
  assert.equal(dueDateInMonth('2026-04', 30), '2026-04-30');
  assert.equal(dueDateInMonth('2026-12', 1), '2026-12-01');
});

test('dueDateInMonth: kein Tag, kein Datum', () => {
  for (const day of [null, undefined, 0, 32, -1, 1.5, '27', NaN, true]) {
    assert.equal(dueDateInMonth('2026-10', day), null, `Tag ${String(day)}`);
  }
  for (const month of [null, undefined, '', '2026', '2026-13', '2026-00', '2026-1', 'x']) {
    assert.equal(dueDateInMonth(month, 27), null, `Monat ${String(month)}`);
  }
});

// --------------------------------------------------------------------------
// Der Server liefert das Datum
// --------------------------------------------------------------------------

test('ein Darlehen mit Faelligkeitstag nennt das Datum der naechsten Rate', async () => {
  const created = await createLoan({ due_day: 27 });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.due_day, 27);
  assert.equal(created.body.data.next_due_month, '2026-10');
  assert.equal(created.body.data.next_due_date, '2026-10-27');
  // Dieselbe Zahl in der Liste, aus der die Karte gezeichnet wird.
  const listed = await loanFromList(created.body.data.id);
  assert.equal(listed.due_day, 27);
  assert.equal(listed.next_due_date, '2026-10-27');
});

test('ohne Faelligkeitstag ist next_due_date fuer die Rate des laufenden Monats null, der Monat bleibt', async () => {
  await at('2026-10-06T10:00:00Z', 'Europe/Berlin', async () => {
    const created = await createLoan();
    assert.equal(created.status, 201);
    assert.equal(created.body.data.due_day, null);
    assert.equal(created.body.data.next_due_month, '2026-10');
    assert.equal(created.body.data.next_due_date, null);
    const listed = await loanFromList(created.body.data.id);
    assert.equal(listed.next_due_date, null);
    assert.ok('next_due_date' in listed, 'das Feld steht da, auch wenn es leer ist');
    // Eine Rate, die erst kommt, hat ebenso wenig ein Datum.
    const future = await createLoan({ start_month: '2027-03' });
    assert.equal(future.body.data.next_due_date, null);
    assert.equal((await loanFromList(future.body.data.id)).next_due_date, null);
  });
});

test('Tag 31: jede Rate bekommt den letzten Tag ihres Monats, das getilgte Darlehen kein Datum', async () => {
  const created = await createLoan({ due_day: 31, start_month: '2026-01', installment_count: 4, total_amount: 400 });
  const id = created.body.data.id;
  for (const expected of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']) {
    assert.equal((await loanFromList(id)).next_due_date, expected);
    const paid = await markPaid(id);
    assert.equal(paid.status, 201);
    assert.equal(paid.body.data.payment.paid_date, expected);
    assert.equal(entryOf(paid.body.data.payment).date, expected, 'der Budget-Eintrag traegt dasselbe Datum');
  }
  const settled = await loanFromList(id);
  assert.equal(settled.is_settled, true);
  assert.equal(settled.next_due_month, null);
  assert.equal(settled.next_due_date, null);
});

test('Tag 31 im Februar eines Schaltjahrs ist der 29.', async () => {
  const created = await createLoan({ due_day: 31, start_month: '2028-02' });
  assert.equal(created.body.data.next_due_date, '2028-02-29');
  const paid = await markPaid(created.body.data.id);
  assert.equal(paid.body.data.payment.paid_date, '2028-02-29');
  assert.equal(paid.body.data.loan.next_due_date, '2028-03-31');
});

// --------------------------------------------------------------------------
// Markieren vor und nach dem Faelligkeitstag
// --------------------------------------------------------------------------

/** Summe der Ausgaben eines Monats, wie die Uebersicht sie zeigt (negativ). */
async function monthExpenses(month) {
  const res = await call('GET', `/summary?month=${month}`);
  assert.equal(res.status, 200);
  return res.body.data.expenses;
}

test('frueh markiert: am 25. Oktober getippt, auf den 27. gebucht', async () => {
  db.prepare('DELETE FROM budget_entries').run();
  const created = await createLoan({ due_day: 27 });
  await at('2026-10-25T10:00:00Z', 'Europe/Berlin', async () => {
    assert.equal(todayKey(db), '2026-10-25', 'Vorbedingung: der Haushalt steht auf dem 25.');
    const paid = await markPaid(created.body.data.id);
    assert.equal(paid.status, 201);
    assert.equal(paid.body.data.payment.paid_date, '2026-10-27');
    assert.equal(entryOf(paid.body.data.payment).date, '2026-10-27');
    // Die naechste Rate ist die des Folgemonats, wieder an ihrem Tag.
    assert.equal(paid.body.data.loan.next_due_date, '2026-11-27');
  });
});

test('spaet markiert: am 2. November fuer den 27. Oktober landet die Rate im Oktober', async () => {
  db.prepare('DELETE FROM budget_entries').run();
  const created = await createLoan({ due_day: 27 });
  // 01.11. 11:00 UTC: in Pacific/Kiritimati (UTC+14) ist es der 02.11., 01:00.
  await at('2026-11-01T11:00:00Z', 'Pacific/Kiritimati', async () => {
    assert.equal(utcDateKey(), '2026-11-01', 'Vorbedingung: UTC steht auf dem 1.');
    assert.equal(todayKey(db), '2026-11-02', 'Vorbedingung: der Haushalt steht auf dem 2. November');
    assert.equal((await loanFromList(created.body.data.id)).next_due_date, '2026-10-27',
      'das Datum der Rate haengt nicht an der Uhr');
    const paid = await markPaid(created.body.data.id);
    assert.equal(paid.status, 201);
    assert.equal(paid.body.data.payment.paid_date, '2026-10-27');
    assert.equal(entryOf(paid.body.data.payment).date, '2026-10-27');
    // Und zwar dort, wo die Monatssumme sie zaehlt.
    assert.equal(await monthExpenses('2026-10'), -100, 'die Rate zaehlt im Oktober');
    assert.ok((await monthExpenses('2026-11')) === 0, 'und nicht im November');
  });
});

test('ohne Faelligkeitstag bleibt die Rate des laufenden Monats bei heute - dem Tag des Haushalts', async () => {
  db.prepare('DELETE FROM budget_entries').run();
  const created = await createLoan({ start_month: '2026-11' });
  await at('2026-11-01T11:00:00Z', 'Pacific/Kiritimati', async () => {
    assert.equal(todayKey(db), '2026-11-02', 'Vorbedingung: der Haushalt steht auf dem 2. November');
    assert.equal((await loanFromList(created.body.data.id)).next_due_date, null);
    const paid = await markPaid(created.body.data.id);
    assert.equal(paid.status, 201);
    assert.equal(paid.body.data.payment.paid_date, '2026-11-02');
    assert.equal(entryOf(paid.body.data.payment).date, '2026-11-02');
    assert.equal(await monthExpenses('2026-11'), -100, 'wie bisher: im Monat des Tippens');
    assert.ok((await monthExpenses('2026-10')) === 0, 'und nicht im Oktober');
  });
});

// --------------------------------------------------------------------------
// Ohne Faelligkeitstag: eine ueberfaellige Rate gehoert in ihren Monat (#1741)
// --------------------------------------------------------------------------

test('#1741: ein Darlehen von 2022 ohne Faelligkeitstag - drei heute markierte Raten landen in 2022-01, -02, -03', async () => {
  db.prepare('DELETE FROM budget_entries').run();
  const created = await createLoan({ title: 'Hypothek', total_amount: 240000, installment_count: 240, start_month: '2022-01' });
  const id = created.body.data.id;
  await at('2026-10-06T10:00:00Z', 'Europe/Berlin', async () => {
    assert.equal(todayKey(db), '2026-10-06');
    for (const [month, expected] of [['2022-01', '2022-01-01'], ['2022-02', '2022-02-01'], ['2022-03', '2022-03-01']]) {
      const loan = await loanFromList(id);
      assert.equal(loan.due_day, null);
      assert.equal(loan.next_due_month, month);
      assert.equal(loan.next_due_date, expected, 'der Erste des Faelligkeitsmonats, wie bei "bereits gezahlte Raten"');
      const paid = await markPaid(id);
      assert.equal(paid.status, 201);
      assert.equal(paid.body.data.payment.paid_date, expected);
      assert.equal(entryOf(paid.body.data.payment).date, expected, 'der Budget-Eintrag traegt dasselbe Datum');
      assert.equal(await monthExpenses(month), -1000, `die Rate zaehlt in ${month}`);
    }
    assert.ok((await monthExpenses('2026-10')) === 0, 'und keine im Monat des Tippens');
    // Die Antwort auf das Buchen nennt schon das Datum der naechsten Rate.
    const fourth = await markPaid(id);
    assert.equal(fourth.body.data.payment.paid_date, '2022-04-01');
    assert.equal(fourth.body.data.loan.next_due_date, '2022-05-01');
  });
});

test('#1741: aufgeholt bis zum laufenden Monat - der letzte vergangene Monat bekommt den Ersten, der laufende heute', async () => {
  db.prepare('DELETE FROM budget_entries').run();
  const created = await createLoan({ start_month: '2026-09' });
  const id = created.body.data.id;
  await at('2026-10-06T10:00:00Z', 'Europe/Berlin', async () => {
    const september = await markPaid(id);
    assert.equal(september.body.data.payment.paid_date, '2026-09-01');
    assert.equal(september.body.data.loan.next_due_month, '2026-10');
    assert.equal(september.body.data.loan.next_due_date, null, 'die Rate des laufenden Monats hat kein Datum');
    const october = await markPaid(id);
    assert.equal(october.body.data.payment.paid_date, '2026-10-06', 'sie bleibt bei heute');
    assert.equal(october.body.data.loan.next_due_date, null, 'und eine kuenftige ebenso');
  });
});

test('#1741: "vorbei" misst der Monat des Haushalts, nicht der von UTC - Haushalt vor UTC', async () => {
  db.prepare('DELETE FROM budget_entries').run();
  const created = await createLoan({ start_month: '2026-10' });
  const id = created.body.data.id;
  // 31.10. 11:00 UTC: in Pacific/Kiritimati (UTC+14) ist es der 01.11., 01:00.
  await at('2026-10-31T11:00:00Z', 'Pacific/Kiritimati', async () => {
    assert.equal(utcDateKey(), '2026-10-31', 'Vorbedingung: UTC steht noch im Oktober');
    assert.equal(todayKey(db), '2026-11-01', 'Vorbedingung: der Haushalt steht im November');
    assert.equal((await loanFromList(id)).next_due_date, '2026-10-01', 'fuer den Haushalt ist der Oktober vorbei');
    const paid = await markPaid(id);
    assert.equal(paid.body.data.payment.paid_date, '2026-10-01');
    assert.equal(await monthExpenses('2026-10'), -100);
    assert.ok((await monthExpenses('2026-11')) === 0);
  });
});

test('#1741: "vorbei" misst der Monat des Haushalts, nicht der von UTC - Haushalt hinter UTC', async () => {
  db.prepare('DELETE FROM budget_entries').run();
  const created = await createLoan({ start_month: '2026-10' });
  const id = created.body.data.id;
  // 01.11. 05:00 UTC: in America/Los_Angeles (UTC-7) ist es der 31.10., 22:00.
  await at('2026-11-01T05:00:00Z', 'America/Los_Angeles', async () => {
    assert.equal(utcDateKey(), '2026-11-01', 'Vorbedingung: UTC steht schon im November');
    assert.equal(todayKey(db), '2026-10-31', 'Vorbedingung: der Haushalt steht noch im Oktober');
    assert.equal((await loanFromList(id)).next_due_date, null, 'fuer den Haushalt laeuft der Oktober noch');
    const paid = await markPaid(id);
    assert.equal(paid.body.data.payment.paid_date, '2026-10-31', 'gebucht wird auf heute, den Tag des Haushalts');
    assert.equal(await monthExpenses('2026-10'), -100);
  });
});

test('#1741: mit Faelligkeitstag aendert sich nichts - auch nicht fuer eine Rate von 2022', async () => {
  const created = await createLoan({ due_day: 5, total_amount: 240000, installment_count: 240, start_month: '2022-01' });
  const id = created.body.data.id;
  await at('2026-10-06T10:00:00Z', 'Europe/Berlin', async () => {
    for (const expected of ['2022-01-05', '2022-02-05', '2022-03-05']) {
      assert.equal((await loanFromList(id)).next_due_date, expected);
      assert.equal((await markPaid(id)).body.data.payment.paid_date, expected);
    }
  });
  // Und der Tag der laufenden Rate haengt weiter nicht an der Uhr.
  const current = await createLoan({ due_day: 27, start_month: '2026-10' });
  for (const [iso, zone] of [['2026-10-06T10:00:00Z', 'Europe/Berlin'], ['2026-12-24T10:00:00Z', 'Europe/Berlin'], ['2026-09-01T10:00:00Z', 'Pacific/Kiritimati']]) {
    await at(iso, zone, async () => {
      assert.equal((await loanFromList(current.body.data.id)).next_due_date, '2026-10-27');
    });
  }
});

test('#1741: ein eigenes paid_date bleibt auch fuer eine ueberfaellige Rate ohne Faelligkeitstag, was es war', async () => {
  const created = await createLoan({ start_month: '2022-01' });
  const id = created.body.data.id;
  await at('2026-10-06T10:00:00Z', 'Europe/Berlin', async () => {
    const own = await call('POST', `/loans/${id}/payments`, { paid_date: '2026-10-06' });
    assert.equal(own.status, 201);
    assert.equal(own.body.data.payment.paid_date, '2026-10-06', 'der Server setzt den Ersten nicht selbst ein');
    assert.equal(entryOf(own.body.data.payment).date, '2026-10-06');
    const missing = await call('POST', `/loans/${id}/payments`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.reason, 'loan_payment_date_invalid');
  });
});

test('ein eigenes paid_date per API bleibt, was es war - auch mit Faelligkeitstag', async () => {
  const created = await createLoan({ due_day: 27 });
  const id = created.body.data.id;
  const own = await call('POST', `/loans/${id}/payments`, { paid_date: '2026-09-03' });
  assert.equal(own.status, 201);
  assert.equal(own.body.data.payment.paid_date, '2026-09-03');
  assert.equal(entryOf(own.body.data.payment).date, '2026-09-03');
  // paid_date bleibt Pflicht: der Server setzt kein Datum ein, auch nicht den Faelligkeitstag.
  const missing = await call('POST', `/loans/${id}/payments`, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.reason, 'loan_payment_date_invalid');
  assert.equal(paymentsOf(id).length, 1, 'die Absage hat nichts gebucht');
});

// --------------------------------------------------------------------------
// Ungueltiger Tag
// --------------------------------------------------------------------------

const INVALID_DAYS = [0, 32, 1.5, 'x', -1, '1.5', '032', true, [27], { day: 27 }];

test('POST /loans: ein ungueltiger Tag ist eine Absage mit Grund, kein Darlehen', async () => {
  for (const due_day of INVALID_DAYS) {
    const before = db.prepare('SELECT COUNT(*) AS c FROM budget_loans').get().c;
    const res = await createLoan({ due_day });
    assert.equal(res.status, 400, `Tag ${JSON.stringify(due_day)}`);
    assert.equal(res.body.reason, 'loan_due_day_invalid', `Tag ${JSON.stringify(due_day)}`);
    assert.equal(res.body.error, 'Due day must be a whole number between 1 and 31.');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_loans').get().c, before, 'nichts angelegt');
  }
});

test('POST /loans: 1, 31 und die Ziffernfolge eines Formularfelds gelten, leer heisst kein Tag', async () => {
  for (const [sent, stored] of [[1, 1], [31, 31], ['27', 27], [' 5 ', 5], [null, null], ['', null], ['  ', null]]) {
    const res = await createLoan({ due_day: sent });
    assert.equal(res.status, 201, `Tag ${JSON.stringify(sent)}`);
    assert.equal(res.body.data.due_day, stored, `Tag ${JSON.stringify(sent)}`);
  }
});

test('PUT /loans/:id: beide Wege lehnen einen ungueltigen Tag ab und lassen den alten stehen', async () => {
  const created = await createLoan({ due_day: 27 });
  const id = created.body.data.id;
  const full = { borrower: 'Bank', title: 'Autokredit', start_month: '2026-10', interest_mode: 'none', total_amount: 1200, installment_count: 12 };
  for (const due_day of INVALID_DAYS) {
    // Der Dialog schickt den vollen Feldsatz (interest_mode), die API auch Teilstuecke.
    for (const body of [{ ...full, due_day }, { due_day }]) {
      const res = await call('PUT', `/loans/${id}`, body);
      assert.equal(res.status, 400, `Tag ${JSON.stringify(due_day)}`);
      assert.equal(res.body.reason, 'loan_due_day_invalid');
    }
  }
  assert.equal(db.prepare('SELECT due_day FROM budget_loans WHERE id = ?').get(id).due_day, 27);
});

test('PUT /loans/:id: der Tag laesst sich setzen, aendern und wieder wegnehmen; fehlt er, bleibt er', async () => {
  // Uhr gestellt: ohne Tag haengt next_due_date am Monat des Haushalts (#1741).
  await at('2026-10-06T10:00:00Z', 'Europe/Berlin', async () => {
    const created = await createLoan();
    const id = created.body.data.id;
    const full = { borrower: 'Bank', title: 'Autokredit', start_month: '2026-10', interest_mode: 'none', total_amount: 1200, installment_count: 12 };

    const set = await call('PUT', `/loans/${id}`, { ...full, due_day: 27 });
    assert.equal(set.status, 200);
    assert.equal(set.body.data.due_day, 27);
    assert.equal(set.body.data.next_due_date, '2026-10-27');

    // Ein Teil-Update ohne das Feld (API) fasst den Tag nicht an - auf beiden Wegen.
    assert.equal((await call('PUT', `/loans/${id}`, { title: 'Auto' })).body.data.due_day, 27);
    assert.equal((await call('PUT', `/loans/${id}`, full)).body.data.due_day, 27);

    const changed = await call('PUT', `/loans/${id}`, { due_day: 31 });
    assert.equal(changed.body.data.due_day, 31);
    assert.equal(changed.body.data.next_due_date, '2026-10-31');

    const cleared = await call('PUT', `/loans/${id}`, { ...full, due_day: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.due_day, null);
    assert.equal(cleared.body.data.next_due_date, null);

    await call('PUT', `/loans/${id}`, { due_day: 15 });
    const clearedPartial = await call('PUT', `/loans/${id}`, { due_day: '' });
    assert.equal(clearedPartial.body.data.due_day, null);
  });
});

// --------------------------------------------------------------------------
// Bereits gezahlte Raten
// --------------------------------------------------------------------------

test('bereits gezahlte Raten tragen beim Anlegen den Faelligkeitstag, geklemmt je Monat', async () => {
  const created = await createLoan({ due_day: 31, start_month: '2026-01', paid_installments: 4 });
  assert.equal(created.status, 201);
  assert.deepEqual(paymentsOf(created.body.data.id), [
    { installment_number: 1, paid_date: '2026-01-31', budget_entry_id: null },
    { installment_number: 2, paid_date: '2026-02-28', budget_entry_id: null },
    { installment_number: 3, paid_date: '2026-03-31', budget_entry_id: null },
    { installment_number: 4, paid_date: '2026-04-30', budget_entry_id: null },
  ]);
  assert.equal(created.body.data.next_due_date, '2026-05-31');
});

test('ohne Faelligkeitstag bleiben bereits gezahlte Raten auf dem Ersten', async () => {
  const created = await createLoan({ start_month: '2026-01', paid_installments: 2 });
  assert.deepEqual(paymentsOf(created.body.data.id).map((p) => p.paid_date), ['2026-01-01', '2026-02-01']);
});

test('ein spaeter gesetzter oder geaenderter Tag fasst keine bestehende Rate an', async () => {
  await at('2026-10-06T10:00:00Z', 'Europe/Berlin', async () => {
    const withDay = await createLoan({ due_day: 31, start_month: '2026-01', paid_installments: 2 });
    const withoutDay = await createLoan({ start_month: '2026-01', paid_installments: 2 });
    // Dazu je eine regulaer gebuchte Rate mit eigenem Datum.
    await call('POST', `/loans/${withDay.body.data.id}/payments`, { paid_date: '2026-03-04' });
    await call('POST', `/loans/${withoutDay.body.data.id}/payments`, { paid_date: '2026-03-04' });
    const before = [paymentsOf(withDay.body.data.id), paymentsOf(withoutDay.body.data.id)];
    const entriesBefore = db.prepare('SELECT id, date FROM budget_entries ORDER BY id').all();

    assert.equal((await call('PUT', `/loans/${withDay.body.data.id}`, { due_day: 15 })).body.data.next_due_date, '2026-04-15');
    assert.equal((await call('PUT', `/loans/${withoutDay.body.data.id}`, { due_day: 27 })).body.data.next_due_date, '2026-04-27');
    assert.deepEqual([paymentsOf(withDay.body.data.id), paymentsOf(withoutDay.body.data.id)], before);

    // Ohne Tag nennt die ueberfaellige April-Rate den Ersten ihres Monats (#1741).
    assert.equal((await call('PUT', `/loans/${withDay.body.data.id}`, { due_day: null })).body.data.next_due_date, '2026-04-01');
    assert.deepEqual(paymentsOf(withDay.body.data.id), before[0]);
    assert.deepEqual(db.prepare('SELECT id, date FROM budget_entries ORDER BY id').all(), entriesBefore,
      'und kein Budget-Eintrag hat sein Datum gewechselt');
  });
});

// --------------------------------------------------------------------------
// Migration auf einer Bestands-DB
// --------------------------------------------------------------------------

const DUE_DAY_MIGRATION = MIGRATIONS.find((m) => m.description.includes('(#1631)'));

// Die Nummer, nicht "der letzte Eintrag": das stand hier bis #1721 und wurde mit
// der naechsten Migration (234) rot, ohne dass an dieser etwas falsch war. Dass
// neue Eintraege ans Ende gehoeren, haelt test:migrations-append-only.
test('die Migration traegt die Nummer 233', () => {
  assert.ok(DUE_DAY_MIGRATION, 'Vorbedingung: die Migration wurde gefunden');
  assert.equal(DUE_DAY_MIGRATION.version, 233);
});

test('Bestands-DB: die Migration laeuft, due_day ist NULL, nichts sonst aendert sich', () => {
  const old = new Database(join(tempDir('yuvomi-loan-due-day-'), 'db.sqlite'));
  try {
    old.pragma('foreign_keys = ON');
    // Die ECHTE Kette bis direkt vor diese Migration.
    migrate(old, MIGRATIONS.filter((m) => m.version < DUE_DAY_MIGRATION.version));
    const columns = () => old.prepare('PRAGMA table_info(budget_loans)').all().map((c) => c.name);
    assert.ok(!columns().includes('due_day'), 'Vorbedingung: der Bestand kennt die Spalte nicht');

    const user = old.prepare(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES ('alt', 'Alt', 'x', 'admin')"
    ).run().lastInsertRowid;
    const loan = old.prepare(`
      INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, created_by, owner_id)
      VALUES ('Bestand', 'Bank', 1200, 12, '2026-01', ?, ?)
    `).run(user, user).lastInsertRowid;
    old.prepare(`
      INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, created_by)
      VALUES (?, 1, 100, '2026-01-01', ?), (?, 2, 100, '2026-02-17', ?)
    `).run(loan, user, loan, user);
    const snapshot = () => ({
      loans: old.prepare('SELECT id, title, borrower, total_amount, installment_count, start_month, status, updated_at FROM budget_loans').all(),
      payments: old.prepare('SELECT * FROM budget_loan_payments ORDER BY id').all(),
      triggers: old.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'index') AND tbl_name = 'budget_loans' ORDER BY name").all(),
    });
    const before = snapshot();

    migrate(old, MIGRATIONS.filter((m) => m.version <= DUE_DAY_MIGRATION.version));

    assert.ok(columns().includes('due_day'));
    assert.equal(old.prepare('SELECT due_day FROM budget_loans WHERE id = ?').get(loan).due_day, null);
    assert.deepEqual(snapshot(), before, 'Darlehen, Raten, Trigger und Indizes wie vorher');
    assert.equal(
      old.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = ?').get(DUE_DAY_MIGRATION.version).c, 1,
      'die Migration ist verbucht',
    );
    // Ein zweiter Lauf ist ein Nichts, kein "duplicate column".
    migrate(old, MIGRATIONS.filter((m) => m.version <= DUE_DAY_MIGRATION.version));

    // Der CHECK haelt, was die Route verspricht - auch fuer Schreiber an ihr vorbei.
    const set = old.prepare('UPDATE budget_loans SET due_day = ? WHERE id = ?');
    for (const ok of [1, 27, 31, null]) set.run(ok, loan);
    for (const bad of [0, 32, 1.5, 'x', -3]) {
      assert.throws(() => set.run(bad, loan), /CHECK constraint failed/, `due_day ${JSON.stringify(bad)}`);
    }
  } finally {
    old.close();
  }
});
