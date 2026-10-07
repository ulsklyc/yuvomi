/**
 * Modul: Taschengeld - die Waehrung eines Kontos und das deaktivierte Kind (#1734)
 * Zweck: Zwei Regeln, die der Maintainer nach dem Review zu #1745 entschieden
 *        hat, gemessen durch den ECHTEN Server:
 *          X. Ein Konto hat genau EINE Waehrung, und sie steht an seinen Zeilen
 *             (Buchung, Anfrage, Plan). Wechselt der Haushalt seine Waehrung,
 *             bleibt das Konto, wie es ist: 1,00 EUR werden nicht zu 100 Yen.
 *             Ein neues Konto nimmt die Waehrung von dann, ein leeres ebenso.
 *             Ein fremder Code an einer Buchung ist ein Fehler.
 *          Y. Ein deaktiviertes Kind wird nur noch ausgezahlt: offene
 *             Geld-Anfragen enden, der Plan pausiert, das Restguthaben sehen
 *             nur Admins, und sie duerfen nur noch abbuchen.
 * Ausfuehren: npm run test:reward-money-accounts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rewardMoneyHousehold } from './reward-money-harness.js';

const {
  BASE, dbmod, db, rewards, money, todayKey, shiftDateKey, parseDateKey, withToken, admin, ADMIN_ID, member, emma, leo, mia, display, DISPLAY_ID, EMMA_START, LEO_START, credit, moneyOf, pointsOf, moneyRows, freshKid, sqlMoney,
} = await rewardMoneyHousehold('reward-money-accounts');

const planOf = (id) => db.prepare('SELECT * FROM reward_allowances WHERE user_id = ?').get(id);

// ==========================================================================
// Die Waehrung eines Kontos (#1734, Entscheidung X)
// ==========================================================================

const setHouseholdCurrency = (code) => (code
  ? db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('currency', ?)").run(code)
  : db.prepare("DELETE FROM sync_config WHERE key = 'currency'").run());
const lastMoneyRow = (id) => moneyRows(id).at(-1);

test('ein Konto behaelt seine Waehrung, wenn der Haushalt sie wechselt: 1,00 EUR bleiben 1,00 EUR', async () => {
  const kid = await member('eurokind');
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1.00', direction: 'credit' })).status, 201);
  money.savePlan(db, kid.id, { amountMinor: 50, frequency: 'weekly', anchorDay: 2, paused: false }, { today: '2026-10-07' });
  assert.equal(planOf(kid.id).currency, 'EUR');
  try {
    for (const [household, unit] of [['JPY', 0], ['KWD', 3]]) {
      setHouseholdCurrency(household);
      for (const [who, call] of [['Kind', kid.call], ['Admin', admin]]) {
        const data = (await call('GET', '/rewards/money')).body.data;
        const account = data.accounts.find((a) => a.id === kid.id);
        assert.deepEqual([data.currency, data.minor_unit], [household, unit], `${who}/${household}: oben steht die Haushaltswaehrung`);
        assert.deepEqual([account.currency, account.minor_unit], ['EUR', 2], `${who}/${household}: das Konto bleibt in EUR`);
        assert.deepEqual([account.plan.currency, account.plan.minor_unit, account.plan.amount_minor], ['EUR', 2, 50]);
      }
      const start = moneyOf(kid.id);

      // Betraege werden in den Stellen des KONTOS gelesen.
      const w = await kid.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '0.25' });
      assert.equal(w.status, 201, `${household}: 0,25 EUR sind ein gueltiger Betrag`);
      assert.deepEqual([w.body.data.cost, w.body.data.currency], [25, 'EUR']);
      assert.equal((await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '0.255' })).status, 400, 'EUR hat zwei Stellen, auch im Dinar-Haushalt');
      const tooMuch = await kid.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '25' });
      assert.equal(tooMuch.body.reason, 'insufficient_funds', '"25" sind 25,00 EUR, nicht 25 Yen');
      const listed = (await admin('GET', '/rewards/redemptions?kind=money&status=pending')).body.data.find((r) => r.id === w.body.data.id);
      assert.deepEqual([listed.currency, listed.minor_unit, listed.user_balance], ['EUR', 2, start]);
      assert.equal((await admin('PATCH', `/rewards/redemptions/${w.body.data.id}`, { action: 'fulfill' })).status, 200);
      assert.deepEqual([lastMoneyRow(kid.id).delta, lastMoneyRow(kid.id).currency], [-25, 'EUR']);

      const dep = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '0.10' });
      assert.equal((await admin('PATCH', `/rewards/redemptions/${dep.body.data.id}`, { action: 'fulfill' })).status, 200);
      assert.deepEqual([lastMoneyRow(kid.id).delta, lastMoneyRow(kid.id).currency], [10, 'EUR']);

      const booked = await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '0.05', direction: 'credit' });
      assert.equal(booked.status, 201);
      assert.deepEqual([booked.body.data.currency, booked.body.data.minor_unit, booked.body.data.balance_minor], ['EUR', 2, start - 25 + 10 + 5]);

      // Der Plan bucht weiter EUR.
      db.prepare("UPDATE reward_allowances SET next_run_date = ? WHERE user_id = ?").run(household === 'JPY' ? '2026-10-13' : '2026-10-20', kid.id);
      assert.equal(money.creditDueAllowances(db, { today: household === 'JPY' ? '2026-10-13' : '2026-10-20' }).credited, 1);
      assert.deepEqual([lastMoneyRow(kid.id).delta, lastMoneyRow(kid.id).currency, lastMoneyRow(kid.id).allowance_date != null], [50, 'EUR', true]);
      const amountOnly = await admin('PUT', `/rewards/money/plans/${kid.id}`, { amount: '0.60', frequency: 'weekly', anchor_day: 2 });
      assert.deepEqual([amountOnly.body.data.plan.amount_minor, amountOnly.body.data.plan.currency], [60, 'EUR'], 'auch eine Planaenderung rechnet in EUR');
      db.prepare('UPDATE reward_allowances SET amount_minor = 50 WHERE user_id = ?').run(kid.id);

      // Der Verlauf nennt je Zeile, worin sie steht.
      const history = (await kid.call('GET', '/rewards/money/ledger')).body.data;
      assert.ok(history.length >= 4 && history.every((r) => r.currency === 'EUR' && r.minor_unit === 2));
    }

    // Ein NEUES Konto nimmt die Waehrung, die der Haushalt dann fuehrt.
    setHouseholdCurrency('JPY');
    const yen = await member('yenneu');
    const opened = await admin('POST', '/rewards/money/entries', { user_id: yen.id, amount: '500', direction: 'credit' });
    assert.deepEqual([opened.body.data.currency, opened.body.data.minor_unit, opened.body.data.balance_minor], ['JPY', 0, 500]);
    const both = (await admin('GET', '/rewards/money')).body.data.accounts;
    assert.equal(both.find((a) => a.id === yen.id).currency, 'JPY');
    assert.equal(both.find((a) => a.id === kid.id).currency, 'EUR', 'und das alte daneben bleibt, was es war');

    // Die Sichtbarkeit haengt nicht an der Waehrung.
    assert.deepEqual((await yen.call('GET', '/rewards/money')).body.data.accounts.map((a) => a.id), [yen.id]);
    assert.deepEqual((await yen.call('GET', `/rewards/money/ledger?user_id=${kid.id}`)).body.data, []);
  } finally {
    setHouseholdCurrency(null);
    db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid.id);
  }
});

test('eine Buchung, eine Anfrage oder ein Plan mit fremdem Waehrungscode ist ein Fehler', async () => {
  const kid = await member('codekind');
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '10.00', direction: 'credit', currency: 'EUR' })).status, 201, 'der richtige Code geht durch');
  const rows = () => moneyRows(kid.id).length;
  const requests = () => db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions WHERE user_id = ?').get(kid.id).n;
  const before = [rows(), requests()];
  try {
    setHouseholdCurrency('JPY');
    for (const res of [
      await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '500', direction: 'credit', currency: 'JPY' }),
      await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1', direction: 'debit', currency: 'JPY' }),
      await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '500', currency: 'JPY' }),
      await kid.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1', currency: 'JPY' }),
      await admin('PUT', `/rewards/money/plans/${kid.id}`, { amount: '500', frequency: 'weekly', anchor_day: 1, currency: 'JPY' }),
      await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1.00', direction: 'credit', currency: ['EUR'] }),
    ]) {
      assert.equal(res.status, 400);
      assert.equal(res.body.reason, 'currency_mismatch');
    }
    assert.deepEqual([rows(), requests()], before, 'nichts davon wurde gespeichert');
    assert.equal(planOf(kid.id), undefined);

    // Auch die Schreibschicht selbst sagt nein, in der Transaktion der Buchung.
    assert.throws(() => money.postMoney(db, { userId: kid.id, delta: 500, type: 'bonus', currency: 'JPY' }), (err) => err.reason === 'currency_mismatch');
    assert.throws(() => money.postMoney(db, { userId: kid.id, delta: 500, type: 'bonus' }), (err) => err.reason === 'currency_mismatch', 'und ohne Code erst recht');
    assert.equal(db.prepare('SELECT currency FROM reward_money_accounts WHERE user_id = ?').get(kid.id).currency, 'EUR', 'die Waehrung des Kontos ist eine Spalte');
    assert.throws(() => money.savePlan(db, kid.id, { amountMinor: 500, frequency: 'weekly', anchorDay: 1, currency: 'JPY' }, { today: '2026-10-07' }), (err) => err.reason === 'currency_mismatch');
    assert.equal(rows(), before[0]);
    assert.ok(moneyRows(kid.id).every((r) => r.currency === 'EUR'), 'das Konto hat genau eine Waehrung');
  } finally {
    setHouseholdCurrency(null);
  }
});

test('die Waehrung wechselt nur ueber Schliessen und neu Eroeffnen - und schliessen laesst sich nur ein leeres Konto', async () => {
  const kid = await member('leerkind');
  await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '3.00', direction: 'credit' });
  const close = () => admin('DELETE', `/rewards/money/accounts/${kid.id}`);
  const accountOf = async (call) => (await call('GET', '/rewards/money')).body.data.accounts.find((a) => a.id === kid.id);
  try {
    setHouseholdCurrency('JPY');
    assert.equal(money.accountCurrency(db, kid.id), 'EUR');

    // Guthaben: nicht schliessbar.
    assert.equal((await accountOf(admin)).closable, false);
    let res = await close();
    assert.deepEqual([res.status, res.body.reason], [409, 'money_account_not_empty']);

    // Saldo null, aber ein Plan: nicht schliessbar - und das Konto bleibt EUR.
    await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '3.00', direction: 'debit' });
    assert.equal(moneyOf(kid.id), 0);
    assert.equal((await admin('PUT', `/rewards/money/plans/${kid.id}`, { amount: '1.00', frequency: 'weekly', anchor_day: 1, paused: true })).body.data.plan.currency, 'EUR');
    res = await close();
    assert.deepEqual([res.status, res.body.reason], [409, 'money_account_not_empty'], 'ein Plan haengt noch daran');
    assert.equal((await admin('DELETE', `/rewards/money/plans/${kid.id}`)).status, 200);

    // Saldo null, kein Plan, aber eine offene Anfrage: nicht schliessbar.
    const open = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '1.00' });
    assert.deepEqual([open.status, open.body.data.currency], [201, 'EUR'], 'ein leeres Konto behaelt seine Waehrung, solange es besteht');
    res = await close();
    assert.deepEqual([res.status, res.body.reason], [409, 'money_account_not_empty'], 'eine Anfrage ist noch offen');
    assert.equal(money.accountCurrency(db, kid.id), 'EUR', 'nichts davon hat das Konto angefasst');
    await kid.call('PATCH', `/rewards/redemptions/${open.body.data.id}`, { action: 'cancel' });

    // Jetzt leer: der Server sagt es, und das Schliessen geht - nur fuer Admins.
    const empty = await accountOf(kid.call);
    assert.deepEqual([empty.balance_minor, empty.currency, empty.closable], [0, 'EUR', true]);
    assert.equal((await kid.call('DELETE', `/rewards/money/accounts/${kid.id}`)).status, 403, 'das Kind schliesst sein Konto nicht selbst');
    assert.equal((await leo.call('DELETE', `/rewards/money/accounts/${kid.id}`)).status, 403);
    assert.equal(money.accountCurrency(db, kid.id), 'EUR');
    assert.equal((await close()).status, 200);
    assert.equal((await close()).status, 404, 'ein geschlossenes Konto gibt es nicht mehr');
    assert.equal(await accountOf(kid.call), undefined, 'das Kind hat kein Konto mehr');
    assert.equal((await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '1' })).body.reason, 'no_money_account');
    assert.ok((await admin('GET', '/rewards/money')).body.data.candidates.some((c) => c.id === kid.id), 'und steht wieder zur Wahl');
    assert.equal(moneyRows(kid.id).length, 2, 'der Verlauf bleibt');

    // Neu eroeffnet: in der Waehrung, die der Haushalt jetzt fuehrt.
    const reopened = await admin('POST', '/rewards/money/accounts', { user_id: kid.id });
    assert.deepEqual([reopened.status, reopened.body.data.currency, reopened.body.data.minor_unit, reopened.body.data.balance_minor], [201, 'JPY', 0, 0]);
    await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '500', direction: 'credit' });
    assert.deepEqual(moneyRows(kid.id).map((r) => [r.delta, r.currency]), [[300, 'EUR'], [-300, 'EUR'], [500, 'JPY']],
      'die alten Zeilen behalten ihren Code und summieren sich in ihm zu null');
    assert.equal(moneyOf(kid.id), 500);
    assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1.00', direction: 'credit', currency: 'EUR' })).body.reason, 'currency_mismatch');
    const history = (await kid.call('GET', '/rewards/money/ledger')).body.data;
    assert.deepEqual(history.map((r) => [r.currency, r.minor_unit]).sort(), [['EUR', 2], ['EUR', 2], ['JPY', 0]], 'jede Zeile nennt, worin sie steht');
  } finally {
    setHouseholdCurrency(null);
  }
});

test('ein Konto eroeffnen ohne Plan: Sache der Admins, nur fuer Mitglieder, und das Kind sieht es mit Saldo null', async () => {
  const kid = await member('neukonto');
  const open = (call, body) => call('POST', '/rewards/money/accounts', body);
  const hasAccount = () => money.hasMoneyAccount(db, kid.id);

  // Nur Admins.
  assert.equal((await open(kid.call, { user_id: kid.id })).status, 403, 'ein Kind eroeffnet sich kein Konto');
  assert.equal((await open(leo.call, { user_id: kid.id })).status, 403);
  assert.equal(hasAccount(), false);
  assert.deepEqual((await kid.call('GET', '/rewards/money')).body.data.accounts, []);

  // Nur Haushaltsmitglieder, und nur Konten, die es gibt.
  const guest = freshKid();
  db.prepare('INSERT INTO split_expense_guest_users(user_id) VALUES (?)').run(guest);
  assert.equal((await open(admin, { user_id: guest })).status, 400);
  assert.equal(money.hasMoneyAccount(db, guest), false);
  const former = freshKid();
  db.prepare("UPDATE users SET deactivated_at = '2026-10-07T00:00:00Z' WHERE id = ?").run(former);
  const refused = await open(admin, { user_id: former });
  assert.deepEqual([refused.status, refused.body.reason], [409, 'account_deactivated'], 'fuer ein ehemaliges Kind wird nichts eroeffnet');
  assert.equal(money.hasMoneyAccount(db, former), false);
  assert.equal((await open(admin, { user_id: 99999999 })).status, 404);
  assert.equal((await open(admin, {})).status, 404);
  assert.equal((await open(admin, { user_id: kid.id, currency: 'JPY' })).body.reason, 'currency_mismatch', 'ein neues Konto steht in der Haushaltswaehrung');
  assert.equal(hasAccount(), false, 'und der abgewiesene Versuch hat nichts angelegt');

  // Eroeffnet: ohne Plan, ohne Buchung.
  const opened = await open(admin, { user_id: kid.id });
  assert.equal(opened.status, 201);
  assert.deepEqual(opened.body.data, { user_id: kid.id, balance_minor: 0, currency: 'EUR', minor_unit: 2, plan: null });
  assert.equal(planOf(kid.id), undefined);
  assert.equal(moneyRows(kid.id).length, 0);
  const again = await open(admin, { user_id: kid.id });
  assert.deepEqual([again.status, again.body.reason], [409, 'money_account_exists']);

  // Das Kind sieht es und kann anfragen; die Geschwister sehen es nicht.
  const mine = (await kid.call('GET', '/rewards/money')).body.data.accounts;
  assert.deepEqual(mine.map((a) => [a.id, a.balance_minor, a.plan, a.former, a.closable]), [[kid.id, 0, null, false, true]]);
  assert.ok(!(await leo.call('GET', '/rewards/money')).body.data.accounts.some((a) => a.id === kid.id));
  assert.deepEqual((await display('GET', '/rewards/money')).body.data.accounts, []);
  assert.ok(!(await admin('GET', '/rewards/money')).body.data.candidates.some((c) => c.id === kid.id));
  const dep = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '2.50' });
  assert.equal(dep.status, 201, 'auf ein leeres Konto laesst sich eine Einzahlung anfragen');
  assert.equal((await admin('PATCH', `/rewards/redemptions/${dep.body.data.id}`, { action: 'fulfill' })).status, 200);
  assert.equal(moneyOf(kid.id), 250);

  // Plan und erste Gutschrift eroeffnen weiterhin mit.
  const viaPlan = await member('viaplan');
  assert.equal((await admin('PUT', `/rewards/money/plans/${viaPlan.id}`, { amount: '1.00', frequency: 'weekly', anchor_day: 1, paused: true })).status, 200);
  assert.equal(money.accountCurrency(db, viaPlan.id), 'EUR');
  const viaCredit = await member('viacredit');
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: viaCredit.id, amount: '1.00', direction: 'credit' })).status, 201);
  assert.equal(money.accountCurrency(db, viaCredit.id), 'EUR');
  // Ein Abzug eroeffnet nichts.
  const viaDebit = await member('viadebit');
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: viaDebit.id, amount: '1.00', direction: 'debit' })).status, 400);
  assert.equal(money.hasMoneyAccount(db, viaDebit.id), false);
  // Die Schreibschicht bucht nicht ohne Konto.
  assert.throws(() => money.postMoney(db, { userId: viaDebit.id, delta: 100, type: 'bonus', currency: 'EUR' }), (err) => err.reason === 'no_money_account');
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(viaPlan.id);
});

test('ein eroeffnetes, nie benutztes Konto haelt das Loeschen eines Kindes nicht auf', async () => {
  const { removeUser, userTraces } = await import('../server/services/user-removal.js');
  const kid = freshKid();
  assert.equal((await admin('POST', '/rewards/money/accounts', { user_id: kid })).status, 201);
  assert.deepEqual(userTraces(db, kid), []);
  assert.equal(removeUser(db, kid).outcome, 'deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_money_accounts WHERE user_id = ?').get(kid).n, 0, 'die Kontozeile geht per CASCADE mit');
});

// ==========================================================================
// Das deaktivierte Kind: nur noch auszahlen (#1734, Entscheidung Y)
// ==========================================================================

test('beim Deaktivieren enden offene Geld-Anfragen und der Plan; das Restguthaben sehen nur Admins und zahlen es aus', async () => {
  const { removeUser } = await import('../server/services/user-removal.js');
  const kid = await member('abschied');
  assert.equal((await credit(kid, 500)).status, 201);
  money.savePlan(db, kid.id, { amountMinor: 100, frequency: 'weekly', anchorDay: 1, paused: false }, { today: '2026-10-07' });
  const dep = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '3.00' });
  const wd = await kid.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00' });
  // Eine offene PRAEMIEN-Anfrage bleibt, was sie ist: die Regel gilt dem Geld.
  db.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status) VALUES (?, 'Eis', 1, 'pending')").run(kid.id);

  assert.equal(removeUser(db, kid.id).outcome, 'deactivated', 'ein Kind mit Restguthaben ist eine Spur: nur deaktivierbar');

  const status = (id) => db.prepare('SELECT status, decision_reason, decided_by FROM reward_redemptions WHERE id = ?').get(id);
  for (const id of [dep.body.data.id, wd.body.data.id]) {
    assert.deepEqual({ ...status(id) }, { status: 'cancelled', decision_reason: 'account_deactivated', decided_by: null });
  }
  assert.equal(db.prepare("SELECT status FROM reward_redemptions WHERE user_id = ? AND kind = 'reward'").get(kid.id).status, 'pending');
  assert.ok(planOf(kid.id).paused_at, 'der Plan ist pausiert');
  assert.equal(moneyOf(kid.id), 500, 'das Guthaben bleibt');

  // Admins sehen das Konto, als ehemalig gekennzeichnet - sonst niemand.
  const forAdmin = (await admin('GET', '/rewards/money')).body.data;
  const account = forAdmin.accounts.find((a) => a.id === kid.id);
  assert.deepEqual([account.former, account.balance_minor, account.plan.paused], [true, 500, true]);
  assert.equal(forAdmin.accounts.at(-1).id, kid.id, 'Ehemalige stehen am Ende');
  assert.ok(forAdmin.accounts.filter((a) => a.id !== kid.id).every((a) => a.former === false));
  assert.ok(!forAdmin.candidates.some((c) => c.id === kid.id));
  for (const [who, call] of [['Leo', leo.call], ['Emma', emma.call], ['Wandtablett', display]]) {
    const seen = (await call('GET', '/rewards/money')).body.data;
    assert.ok(!seen.accounts.some((a) => a.id === kid.id), `${who} sieht das ehemalige Konto nicht`);
    assert.deepEqual((await call('GET', `/rewards/money/ledger?user_id=${kid.id}`)).body.data, [], `${who}: auch nicht seinen Verlauf`);
    assert.ok(!(await call('GET', '/rewards/redemptions?kind=all')).body.data.some((r) => r.user_id === kid.id && r.kind !== 'reward'));
  }
  // Der Admin-Zweig geht fuer niemanden sonst auf - auch nicht fuer das Konto selbst.
  assert.deepEqual(money.listMoneyAccounts(db, { admin: false, display: false, me: kid.id }), []);
  assert.deepEqual(money.listMoneyAccounts(db, { admin: true, display: true, me: kid.id }), []);
  assert.ok((await admin('GET', `/rewards/money/ledger?user_id=${kid.id}`)).body.data.length >= 1, 'Admins lesen den Verlauf weiter');

  // Nur noch abbuchen.
  const refusedCredit = await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1.00', direction: 'credit' });
  assert.deepEqual([refusedCredit.status, refusedCredit.body.reason], [409, 'account_deactivated']);
  const plan = { amount: '1.00', frequency: 'weekly', anchor_day: 1 };
  for (const body of [plan, { ...plan, paused: false }, { ...plan, amount: '9.00', paused: true }]) {
    const res = await admin('PUT', `/rewards/money/plans/${kid.id}`, body);
    assert.deepEqual([res.status, res.body.reason], [409, 'account_deactivated'], `Plan ${JSON.stringify(body)}`);
  }
  assert.ok(planOf(kid.id).paused_at && planOf(kid.id).amount_minor === 100, 'der Plan steht, wie er war');
  assert.equal((await admin('POST', '/rewards/redemptions', { kind: 'deposit', amount: '1.00', user_id: kid.id })).status, 400, 'und niemand stellt fuer das Konto eine Anfrage');
  assert.equal((await admin('PATCH', `/rewards/redemptions/${dep.body.data.id}`, { action: 'fulfill' })).status, 409, 'storniert ist entschieden');
  assert.equal(moneyOf(kid.id), 500);

  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '9.00', direction: 'debit' })).body.reason, 'insufficient_funds', 'nicht unter null');
  const paid = await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '2.00', direction: 'debit', reason: 'ausgezahlt' });
  assert.deepEqual([paid.status, paid.body.data.balance_minor], [201, 300]);
  assert.ok((await admin('GET', '/rewards/money')).body.data.accounts.some((a) => a.id === kid.id && a.former));

  // Wieder aktiviert (das Produkt hat dafuer keine Route; der Zustand ist die Spalte):
  // ein Konto wie zuvor, der Plan bleibt pausiert, Storniertes bleibt storniert.
  db.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(kid.id);
  const back = (await admin('GET', '/rewards/money')).body.data.accounts.find((a) => a.id === kid.id);
  assert.deepEqual([back.former, back.balance_minor, back.plan.paused], [false, 300, true]);
  assert.equal(money.creditDueAllowances(db, { today: '2026-12-31' }).credited, 0, 'der pausierte Plan bucht nicht von selbst');
  assert.equal(status(dep.body.data.id).status, 'cancelled');
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1.00', direction: 'credit' })).status, 201, 'gutschreiben geht wieder');
  const resumed = await admin('PUT', `/rewards/money/plans/${kid.id}`, { ...plan, paused: false });
  assert.deepEqual([resumed.status, resumed.body.data.plan.paused], [200, false], 'und ein Admin setzt den Plan fort');

  // Ausgezahlt bis null und deaktiviert: das Konto steht in keiner Liste mehr.
  db.prepare("UPDATE users SET deactivated_at = '2026-10-07T00:00:00Z' WHERE id = ?").run(kid.id);
  const rest = (moneyOf(kid.id) / 100).toFixed(2);
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: rest, direction: 'debit' })).status, 201);
  assert.equal(moneyOf(kid.id), 0);
  assert.ok(!(await admin('GET', '/rewards/money')).body.data.accounts.some((a) => a.id === kid.id), 'bei Saldo null verschwindet es');
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid.id);
});

test('eine alte offene Anfrage eines deaktivierten Kindes wird nicht mehr freigegeben, und der Lauf raeumt sie weg', async () => {
  // Die Sonde des Reviews: Einzahlung 3,00 offen, Konto deaktiviert (an
  // `deactivate()` vorbei, wie bei einem Bestand von vor dieser Regel), fulfill.
  const kid = await member('altlast');
  assert.equal((await credit(kid, 500)).status, 201);
  const dep = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '3.00' });
  const wd = await kid.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00' });
  db.prepare("UPDATE users SET deactivated_at = '2026-10-07T00:00:00Z' WHERE id = ?").run(kid.id);

  const res = await admin('PATCH', `/rewards/redemptions/${dep.body.data.id}`, { action: 'fulfill' });
  assert.deepEqual([res.status, res.body.reason], [409, 'account_deactivated']);
  assert.deepEqual([res.body.data.status, res.body.data.decision_reason], ['cancelled', 'account_deactivated']);
  assert.equal(moneyOf(kid.id), 500, 'kein Geld auf einem Konto, das nur noch ausgezahlt wird');
  assert.equal(db.prepare('SELECT status FROM reward_redemptions WHERE id = ?').get(wd.body.data.id).status, 'cancelled', 'die andere offene endet im selben Griff');

  // Derselbe Bestand, ohne dass jemand tippt: der naechste Lauf storniert.
  const other = await member('altlast2');
  assert.equal((await credit(other, 500)).status, 201);
  const open = await other.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '3.00' });
  money.savePlan(db, other.id, { amountMinor: 100, frequency: 'weekly', anchorDay: 1, paused: false }, { today: '2026-10-07' });
  db.prepare("UPDATE users SET deactivated_at = '2026-10-07T00:00:00Z' WHERE id = ?").run(other.id);
  money.creditDueAllowances(db, { today: '2026-10-07' });
  assert.deepEqual({ ...db.prepare('SELECT status, decision_reason FROM reward_redemptions WHERE id = ?').get(open.body.data.id) },
    { status: 'cancelled', decision_reason: 'account_deactivated' });
  money.creditDueAllowances(db, { today: '2026-10-31' });
  assert.ok(planOf(other.id).paused_at);
  assert.equal(moneyOf(other.id), 500);
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(other.id);
});

// ==========================================================================
// Letzte Runde aus dem zweiten Review zu #1745
// ==========================================================================

test('ein Plan in fremder Waehrung wird nicht gebucht, sondern pausiert - der Saldo ist EINE Summe', () => {
  const kid = freshKid();
  sqlMoney(kid, 500, 'bonus', 'JPY');
  money.savePlan(db, kid, { amountMinor: 800, frequency: 'weekly', anchorDay: 2, paused: false }, { today: '2026-10-07' });
  assert.equal(planOf(kid).currency, 'JPY');
  // Die Planzeile behauptet EUR (von Hand verdreht, wie nach einer Wiederherstellung).
  db.prepare("UPDATE reward_allowances SET currency = 'EUR', next_run_date = '2026-10-13' WHERE user_id = ?").run(kid);

  const reported = [];
  const result = money.creditDueAllowances(db, { today: '2026-10-13', onError: (plan, err) => reported.push([plan.user_id, err.message]) });
  assert.equal(result.credited, 0, '800 EUR auf einem Yen-Konto waeren 800 Yen im Saldo');
  assert.equal(moneyOf(kid), 500);
  assert.equal(moneyRows(kid).length, 1, 'keine Zeile geschrieben');
  assert.ok(planOf(kid).paused_at, 'der Plan ist pausiert');
  assert.equal(planOf(kid).next_run_date, '2026-10-13', 'und steht auf seinem Termin');
  assert.equal(reported.filter(([id]) => id === kid).length, 1, 'gemeldet, einmal');
  assert.match(reported.find(([id]) => id === kid)[1], /EUR/);
  assert.equal(money.creditDueAllowances(db, { today: '2026-10-20', onError: (plan, err) => reported.push([plan.user_id, err.message]) }).credited, 0);
  assert.equal(reported.filter(([id]) => id === kid).length, 1, 'ein pausierter Plan meldet sich nicht jede Stunde wieder');
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
});

test('beim Deaktivieren wird erst gebucht, was faellig war, dann pausiert', async () => {
  const { removeUser } = await import('../server/services/user-removal.js');
  const today = todayKey(db);
  const kid = await member('faellig');
  assert.equal((await credit(kid, 100)).status, 201);
  money.savePlan(db, kid.id, { amountMinor: 200, frequency: 'weekly', anchorDay: 1, paused: false }, { today });
  // Der Lauf hat drei Wochen nicht stattgefunden.
  db.prepare('UPDATE reward_allowances SET next_run_date = ? WHERE user_id = ?').run(shiftDateKey(today, -21), kid.id);

  assert.equal(removeUser(db, kid.id).outcome, 'deactivated');
  const booked = db.prepare('SELECT allowance_date, delta FROM reward_ledger WHERE user_id = ? AND allowance_date IS NOT NULL ORDER BY allowance_date').all(kid.id).map((r) => [r.allowance_date, r.delta]);
  assert.deepEqual(booked, [-21, -14, -7, 0].map((days) => [shiftDateKey(today, days), 200]), 'die vier faelligen Termine stehen im Guthaben, das ausgezahlt wird');
  assert.equal(moneyOf(kid.id), 100 + 4 * 200);
  assert.ok(planOf(kid.id).paused_at);
  assert.equal((await admin('GET', '/rewards/money')).body.data.accounts.find((a) => a.id === kid.id).balance_minor, 900);

  // Ein Konto, das an deactivate() vorbei deaktiviert wurde und das der Lauf
  // erst spaeter findet: gebucht wird bis zum Tag des Deaktivierens, nicht bis heute.
  const late = freshKid();
  sqlMoney(late, 100);
  money.savePlan(db, late, { amountMinor: 200, frequency: 'weekly', anchorDay: 1, paused: false }, { today });
  db.prepare('UPDATE reward_allowances SET next_run_date = ? WHERE user_id = ?').run(shiftDateKey(today, -21), late);
  db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run(`${shiftDateKey(today, -10)}T12:00:00Z`, late);
  money.creditDueAllowances(db, { today });
  const lateBooked = db.prepare('SELECT allowance_date FROM reward_ledger WHERE user_id = ? AND allowance_date IS NOT NULL ORDER BY allowance_date').all(late).map((r) => r.allowance_date);
  assert.deepEqual(lateBooked, [shiftDateKey(today, -21), shiftDateKey(today, -14)], 'die Woche nach dem Deaktivieren steht dem Konto nicht mehr zu');
  assert.ok(planOf(late).paused_at);
  for (const id of [kid.id, late]) db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(id);
});

test('der eigene Geld-Zaehler der Uebersicht stimmt auch ohne Punkte-Teilnahme - und bleibt fuer alle anderen null', async () => {
  const kid = await member('nurgeld');
  assert.equal((await admin('POST', '/rewards/money/accounts', { user_id: kid.id })).status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_participants WHERE user_id = ?').get(kid.id).n, 0, 'die Probe braucht ein Kind, das keine Punkte sammelt');
  const tile = async (call) => (await call('GET', '/dashboard')).body.rewards;
  const before = { leo: await tile(leo.call), mia: await tile(mia.call), display: await tile(display), admin: await tile(admin) };

  const dep = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '1.00', note: 'nur-mein-geld' });
  assert.equal(dep.status, 201);
  const own = await tile(kid.call);
  assert.equal(own.view, 'family', 'ohne Punkte-Teilnahme ist die Sicht die der Familie');
  assert.equal(own.moneyPending, 1, 'die eigene offene Einzahlung zaehlt');
  assert.equal(own.pending, 0);
  assert.equal((await kid.call('GET', '/rewards/overview')).body.data.moneyPendingCount, 1, 'wie auf der Seite');

  // Niemand sonst erfaehrt davon.
  for (const [who, call] of [['leo', leo.call], ['mia', mia.call], ['display', display]]) {
    const after = await call('GET', '/dashboard');
    assert.equal(after.body.rewards.moneyPending, before[who].moneyPending, `${who}: der Zaehler bleibt`);
    assert.ok(!JSON.stringify(after.body).includes('nur-mein-geld'));
  }
  assert.equal((await tile(display)).moneyPending, 0);
  assert.equal((await tile(admin)).moneyPending, before.admin.moneyPending + 1, 'Admins zaehlen sie mit');
  await kid.call('PATCH', `/rewards/redemptions/${dep.body.data.id}`, { action: 'cancel' });
});

test('eine entschiedene Geld-Anfrage traegt keinen Saldo: nach Schliessen und Neueroeffnen staende Yen neben EUR', async () => {
  const kid = await member('saldonull');
  await admin('POST', '/rewards/money/accounts', { user_id: kid.id });
  const dep = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '2.00' });
  const open = (await admin('GET', '/rewards/redemptions?kind=money')).body.data.find((r) => r.id === dep.body.data.id);
  assert.deepEqual([open.status, open.user_balance, open.currency], ['pending', 0, 'EUR'], 'offen: der Saldo steht daneben');
  await admin('PATCH', `/rewards/redemptions/${dep.body.data.id}`, { action: 'fulfill' });
  await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '2.00', direction: 'debit' });
  try {
    assert.equal((await admin('DELETE', `/rewards/money/accounts/${kid.id}`)).status, 200);
    setHouseholdCurrency('JPY');
    await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '700', direction: 'credit' });
    for (const call of [admin, kid.call]) {
      const decided = (await call('GET', '/rewards/redemptions?kind=money')).body.data.find((r) => r.id === dep.body.data.id);
      assert.deepEqual([decided.status, decided.currency, decided.minor_unit], ['fulfilled', 'EUR', 2]);
      assert.equal(decided.user_balance, null, 'kein 700 (Yen) neben "EUR"');
    }
    // Eine Praemien-Anfrage behaelt ihren Punktestand, auch entschieden.
    db.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status) VALUES (?, 'Eis', 1, 'fulfilled')").run(kid.id);
    const reward = (await kid.call('GET', '/rewards/redemptions')).body.data.find((r) => r.kind === 'reward');
    assert.equal(reward.user_balance, 0);
  } finally {
    setHouseholdCurrency(null);
  }
});
