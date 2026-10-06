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
    assert.throws(() => money.savePlan(db, kid.id, { amountMinor: 500, frequency: 'weekly', anchorDay: 1, currency: 'JPY' }, { today: '2026-10-07' }), (err) => err.reason === 'currency_mismatch');
    assert.equal(rows(), before[0]);
    assert.ok(moneyRows(kid.id).every((r) => r.currency === 'EUR'), 'das Konto hat genau eine Waehrung');
  } finally {
    setHouseholdCurrency(null);
  }
});

test('ein leeres Konto (Saldo null, kein Plan, nichts offen) nimmt beim naechsten Eroeffnen die Waehrung des Haushalts', async () => {
  const kid = await member('leerkind');
  await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '3.00', direction: 'credit' });
  try {
    setHouseholdCurrency('JPY');
    assert.equal(money.accountCurrency(db, kid.id), 'EUR', 'mit Guthaben: EUR');

    // Saldo null, aber ein Plan: das Konto gilt weiter.
    await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '3.00', direction: 'debit' });
    assert.equal(moneyOf(kid.id), 0);
    assert.equal(money.accountCurrency(db, kid.id), null, 'ohne Plan, ohne Offenes, Saldo null: leer');
    money.savePlan(db, kid.id, { amountMinor: 100, frequency: 'weekly', anchorDay: 5, paused: true, currency: 'JPY' }, { today: '2026-10-07' });
    assert.equal(money.accountCurrency(db, kid.id), 'JPY', 'der neue Plan eroeffnet in der Haushaltswaehrung von heute');
    db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid.id);

    // Saldo null, aber eine offene Anfrage in EUR: bleibt EUR.
    db.prepare("INSERT INTO reward_redemptions (user_id, kind, currency, reward_name, cost, status) VALUES (?, 'deposit', 'EUR', 'deposit', 100, 'pending')").run(kid.id);
    assert.equal(money.accountCurrency(db, kid.id), 'EUR', 'eine offene Anfrage haelt die Waehrung');
    assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '500', direction: 'credit', currency: 'JPY' })).body.reason, 'currency_mismatch');
    db.prepare("UPDATE reward_redemptions SET status = 'cancelled' WHERE user_id = ?").run(kid.id);

    // Jetzt leer: die naechste Buchung eroeffnet in Yen.
    const shown = (await kid.call('GET', '/rewards/money')).body.data.accounts[0];
    assert.deepEqual([shown.currency, shown.minor_unit, shown.balance_minor], ['JPY', 0, 0], 'das leere Konto zeigt, worin es als Naechstes rechnet');
    const reopened = await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '500', direction: 'credit' });
    assert.deepEqual([reopened.body.data.currency, reopened.body.data.balance_minor], ['JPY', 500]);
    assert.deepEqual(moneyRows(kid.id).map((r) => [r.delta, r.currency]), [[300, 'EUR'], [-300, 'EUR'], [500, 'JPY']],
      'die alten Zeilen behalten ihren Code und summieren sich in ihm zu null');
    assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1.00', direction: 'credit', currency: 'EUR' })).body.reason, 'currency_mismatch',
      'und zurueck geht es nicht, solange Yen darauf liegen');
    const history = (await kid.call('GET', '/rewards/money/ledger')).body.data;
    assert.deepEqual(history.map((r) => [r.currency, r.minor_unit]).sort(), [['EUR', 2], ['EUR', 2], ['JPY', 0]]);
  } finally {
    setHouseholdCurrency(null);
  }
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

