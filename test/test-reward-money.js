/**
 * Modul: Taschengeld im Belohnungsmodul (#1734, Discussion #916)
 * Zweck: Ein Geld-Saldo je Kind auf dem Ledger der Belohnungen, getrennt von
 *        den Punkten. Diese Suite haelt fest, gemessen durch den ECHTEN Server
 *        (test/server-ready.js - ein nackt eingehaengter Router sieht weder
 *        das Modul-Gate noch die Display-Gates):
 *          1. Punkte und Geld mischen sich nie. JEDER Leser einer Summe ueber
 *             das Ledger (services/rewards.js, /rewards/overview,
 *             /rewards/participants, /dashboard samt "zuletzt verdient", die
 *             Deckungspruefung beim Einloesen, der Netto-Stand einer Aufgabe)
 *             bleibt von einer Geldbuchung unbewegt und umgekehrt.
 *          2. Geld sehen NUR das Kind selbst und Admins: nicht das
 *             Geschwisterkind, nicht das Wandtablett, und ein gescoptes
 *             API-Token nur nach derselben Regel. Gefiltert wird an der
 *             Leseabfrage - geprueft wird deshalb die Antwort, nicht die
 *             Oberflaeche.
 *          3. Abhebung und Einzahlung sind Anfragen: nichts wird beim Stellen
 *             gebucht, erst die Freigabe eines Admins bucht. Keine
 *             Ueberziehung, geprueft beim Stellen UND bei der Freigabe.
 *          4. Die Gutschrift nach Plan: woechentlich und monatlich mit
 *             Ankertag, Monatsende wie #1721, versaeumte Termine nachgebucht,
 *             jeder Termin genau einmal, "heute" ist der Haushaltstag.
 *          5. Die Migration auf einer Datenbank mit Bestand: jede Zeile ist
 *             Punkte, die Salden stehen wie zuvor, die fuenf Indizes bleiben.
 * Ausfuehren: npm run test:reward-money
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

import { tempDir } from './tmp-dir.js';

import { rewardMoneyHousehold } from './reward-money-harness.js';

const {
  BASE, dbmod, db, rewards, money, todayKey, shiftDateKey, parseDateKey, withToken, admin, ADMIN_ID, member, emma, leo, mia, display, DISPLAY_ID, EMMA_START, LEO_START, credit, moneyOf, pointsOf, moneyRows, freshKid, sqlMoney,
} = await rewardMoneyHousehold('reward-money');

// ==========================================================================
// 1. Punkte und Geld mischen sich nie
// ==========================================================================

test('die Summe geht nicht ohne Einheit', () => {
  assert.throws(() => rewards.ledgerBalance(db, emma.id), /ledger unit/);
  assert.throws(() => rewards.ledgerBalance(db, emma.id, 'cents'), /ledger unit/);
  assert.throws(() => rewards.ledgerBalanceSql(undefined, 'u.id'), /ledger unit/);
  assert.throws(() => rewards.ledgerBalanceSql('points', "u.id) OR (1=1"), /qualified column/);
  assert.throws(() => rewards.postLedger(db, { userId: emma.id, delta: 1, type: 'bonus', unit: 'euro' }), /ledger unit/);
  // Eine Geldzeile ohne Waehrung und eine Punktezeile mit einer gibt es nicht.
  assert.throws(() => rewards.postLedger(db, { userId: emma.id, delta: 1, type: 'bonus', unit: 'money' }), /carries a currency/);
  assert.throws(() => rewards.postLedger(db, { userId: emma.id, delta: 1, type: 'bonus', currency: 'EUR' }), /carries a currency/);
});

test('services/rewards.js: eine Geldbuchung bewegt den Punktestand nicht, und umgekehrt', () => {
  const kid = freshKid({ enrolled: true });
  rewards.postLedger(db, { userId: kid, delta: 40, type: 'bonus' });
  rewards.postLedger(db, { userId: kid, delta: 2_500, type: 'bonus', unit: 'money', currency: 'EUR' });
  assert.equal(rewards.getBalance(db, kid), 40, 'getBalance ist der Punktestand');
  assert.equal(rewards.ledgerBalance(db, kid, 'points'), 40);
  assert.equal(rewards.ledgerBalance(db, kid, 'money'), 2_500);
  assert.equal(money.moneyBalance(db, kid), 2_500);
  rewards.postLedger(db, { userId: kid, delta: -15, type: 'adjust' });
  assert.equal(rewards.ledgerBalance(db, kid, 'money'), 2_500, 'eine Punktebuchung bewegt das Geld nicht');
  assert.equal(rewards.getBalance(db, kid), 25);
});

test('GET /rewards/overview: der Stand in der Rangliste zaehlt nur Punkte', async () => {
  rewards.postLedger(db, { userId: emma.id, delta: 30, type: 'bonus' });
  const before = (await admin('GET', '/rewards/overview')).body.data.balances.find((b) => b.id === emma.id).balance;
  assert.equal(before, pointsOf(emma.id));
  assert.equal((await credit(emma, 900)).status, 201);
  const after = (await admin('GET', '/rewards/overview')).body.data.balances.find((b) => b.id === emma.id).balance;
  assert.equal(after, before, 'neun Euro mehr sind keine 900 Punkte mehr');
  sqlMoney(emma.id, -900, 'adjust');
});

test('GET /rewards/participants: der Stand je Mitglied zaehlt nur Punkte', async () => {
  const row = (await admin('GET', '/rewards/participants')).body.data.find((p) => p.id === emma.id);
  assert.equal(row.balance, pointsOf(emma.id));
  assert.notEqual(row.balance, pointsOf(emma.id) + moneyOf(emma.id), 'die Probe braucht einen Geld-Saldo ungleich 0');
});

test('GET /dashboard: der Stand der Kachel zaehlt nur Punkte, und "zuletzt verdient" nennt kein Geld', async () => {
  const res = await emma.call('GET', '/dashboard');
  assert.equal(res.status, 200);
  const rw = res.body.rewards;
  assert.equal(rw.view, 'self');
  assert.equal(rw.standings.length, 1);
  assert.equal(rw.standings[0].balance, pointsOf(emma.id), 'Kachel: nur Punkte');
  assert.ok(rw.recent.length >= 1, 'die Probe braucht eine Punkte-Gutschrift');
  assert.ok(!rw.recent.some((r) => r.reason === 'Startguthaben-Emma'), 'die Geld-Gutschrift ist kein "zuletzt verdient"');
  assert.ok(!rw.recent.some((r) => r.delta === EMMA_START), 'und ihr Betrag steht nicht als Punkte da');

  const forAdmin = (await admin('GET', '/dashboard')).body.rewards;
  assert.equal(forAdmin.standings.find((s) => s.id === emma.id).balance, pointsOf(emma.id), 'auch in der Sicht der Eltern');
});

test('die Deckung einer Praemie zaehlt nur Punkte, die einer Abhebung nur Geld', async () => {
  const item = await admin('POST', '/rewards/catalog', { name: 'Eis', cost: 10 });
  assert.equal(item.status, 201);

  // Viel Geld, keine Punkte: keine Praemie.
  const rich = await member('rich');
  await admin('PUT', `/rewards/participants/${rich.id}`, { enabled: true });
  assert.equal((await credit(rich, 5_000)).status, 201);
  const noPoints = await rich.call('POST', '/rewards/redemptions', { catalog_id: item.body.data.id });
  assert.equal(noPoints.status, 400);
  assert.equal(noPoints.body.error, 'Insufficient points.');

  // Viele Punkte, kein Geld: keine Abhebung.
  rewards.postLedger(db, { userId: rich.id, delta: 100_000, type: 'bonus' });
  sqlMoney(rich.id, -5_000, 'adjust');
  const noMoney = await rich.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00' });
  assert.equal(noMoney.status, 400);
  assert.equal(noMoney.body.reason, 'insufficient_funds');

  // Und die Einloesung bucht Punkte, nicht Geld.
  const ok = await rich.call('POST', '/rewards/redemptions', { catalog_id: item.body.data.id });
  assert.equal(ok.status, 201);
  assert.equal(moneyOf(rich.id), 0);
  assert.equal(pointsOf(rich.id), 100_000 - 10);
  const listed = (await rich.call('GET', '/rewards/redemptions')).body.data.find((r) => r.id === ok.body.data.id);
  assert.equal(listed.kind, 'reward');
  assert.equal(listed.user_balance, 100_000 - 10, 'user_balance einer Praemien-Anfrage ist der Punktestand');
});

test('der Netto-Stand einer Aufgabe liest keine Geldzeile: vergeben und zuruecknehmen', () => {
  const kid = freshKid({ enrolled: true });
  const task = Number(db.prepare("INSERT INTO tasks(title, status, visibility, points, created_by) VALUES ('Netto', 'open', 'all', 5, ?) RETURNING id").get(ADMIN_ID).id);
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(task, kid);
  // Eine Geldzeile, die (von Hand) dieselbe Aufgabe nennt. Ohne Einheiten-Filter
  // gaelte die Aufgabe als schon verguetet.
  db.prepare("INSERT INTO reward_ledger (user_id, delta, type, task_id, unit, currency) VALUES (?, 300, 'earn', ?, 'money', 'EUR')").run(kid, task);

  rewards.syncTaskRewards(db, task, 'open', 'done', ADMIN_ID);
  assert.equal(pointsOf(kid), 5, 'die Punkte werden trotz der Geldzeile vergeben');

  rewards.syncTaskRewards(db, task, 'done', 'open', ADMIN_ID);
  assert.equal(pointsOf(kid), 0, 'zurueckgenommen werden genau die Punkte');
  assert.equal(moneyOf(kid), 300, 'und das Geld bleibt stehen');
  const reversal = db.prepare("SELECT delta, unit FROM reward_ledger WHERE task_id = ? AND type = 'reversal'").all(task);
  assert.deepEqual(reversal.map((r) => ({ ...r })), [{ delta: -5, unit: 'points' }]);
});

// ==========================================================================
// 2. Wer das Geld sieht
// ==========================================================================

const ownOnly = (rows, id) => rows.every((r) => r.user_id === id);

test('GET /rewards/money: das Kind sieht sein Konto, das Geschwisterkind nur seines, Admins alle', async () => {
  const forEmma = (await emma.call('GET', '/rewards/money')).body.data;
  assert.deepEqual(forEmma.accounts.map((a) => a.id), [emma.id]);
  assert.equal(forEmma.accounts[0].balance_minor, moneyOf(emma.id));
  assert.equal(forEmma.currency, 'EUR');
  assert.equal(forEmma.minor_unit, 2);
  assert.deepEqual(forEmma.candidates, [], 'wer ein Konto eroeffnen koennte, erfahren nur die Eltern');

  const forLeo = (await leo.call('GET', '/rewards/money')).body.data;
  assert.deepEqual(forLeo.accounts.map((a) => a.id), [leo.id], 'Leo sieht sein Konto - und nicht Emmas');
  assert.ok(!JSON.stringify(forLeo).includes(String(moneyOf(emma.id))), 'Emmas Saldo steht nirgends in Leos Antwort');

  const forMia = (await mia.call('GET', '/rewards/money')).body.data;
  assert.deepEqual(forMia.accounts, [], 'ohne Konto: nichts');

  const forAdmin = (await admin('GET', '/rewards/money')).body.data;
  const ids = forAdmin.accounts.map((a) => a.id);
  assert.ok(ids.includes(emma.id) && ids.includes(leo.id));
  assert.ok(forAdmin.candidates.some((c) => c.id === mia.id), 'Mia hat noch kein Konto');
  assert.ok(!forAdmin.candidates.some((c) => c.id === emma.id));
});

test('GET /rewards/money/ledger: gefiltert an der Abfrage - auch wenn das Geschwisterkind ausdruecklich fragt', async () => {
  const own = (await emma.call('GET', '/rewards/money/ledger')).body.data;
  assert.ok(own.length >= 1 && ownOnly(own, emma.id));
  assert.ok(own.some((r) => r.reason === 'Startguthaben-Emma'));

  const leoAll = (await leo.call('GET', '/rewards/money/ledger')).body.data;
  assert.ok(leoAll.length >= 1 && ownOnly(leoAll, leo.id), 'ohne Filter: nur die eigenen Zeilen');
  const leoAsks = await leo.call('GET', `/rewards/money/ledger?user_id=${emma.id}`);
  assert.equal(leoAsks.status, 200);
  assert.deepEqual(leoAsks.body.data, [], '`user_id` ist ein Filter, kein Recht');

  const forAdmin = (await admin('GET', `/rewards/money/ledger?user_id=${emma.id}`)).body.data;
  assert.ok(forAdmin.some((r) => r.reason === 'Startguthaben-Emma'), 'Admins sehen es');
});

test('GET /rewards/ledger: der Punkte-Verlauf fuehrt keine Geldzeile - fuer niemanden', async () => {
  for (const [name, call] of [['Admin', admin], ['Emma', emma.call], ['Leo', leo.call]]) {
    const rows = (await call('GET', '/rewards/ledger?limit=500')).body.data;
    assert.ok(!rows.some((r) => r.reason === 'Startguthaben-Emma' || r.reason === 'Startguthaben-Leo'), `${name}: keine Geldzeile`);
    assert.ok(!rows.some((r) => r.delta === EMMA_START), `${name}: kein Geldbetrag als Punkte`);
    const filtered = (await call('GET', `/rewards/ledger?user_id=${emma.id}&limit=500`)).body.data;
    assert.ok(!filtered.some((r) => r.reason === 'Startguthaben-Emma'), `${name}: auch nicht mit Filter`);
  }
});

test('eine offene Geld-Anfrage: Liste, Zaehler und Uebersicht verraten sie dem Geschwisterkind nicht', async () => {
  const overviewOf = async (call) => (await call('GET', '/rewards/overview')).body.data;
  const tileOf = async (call) => (await call('GET', '/dashboard')).body.rewards;
  const leoBefore = await overviewOf(leo.call);
  const leoTileBefore = await tileOf(leo.call);
  const adminBefore = await overviewOf(admin);
  const adminTileBefore = await tileOf(admin);
  const emmaBefore = await overviewOf(emma.call);
  const emmaTileBefore = await tileOf(emma.call);

  const filed = await emma.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '4.21', note: 'Kino-geheim' });
  assert.equal(filed.status, 201);
  const id = filed.body.data.id;

  // Leo: nichts.
  for (const query of ['', '?kind=all', '?kind=money', '?kind=withdrawal', '?status=pending&kind=all']) {
    const leoList = (await leo.call('GET', `/rewards/redemptions${query}`)).body.data;
    assert.ok(!leoList.some((r) => r.id === id), `Leo, ${query || 'ohne kind'}`);
  }
  const leoAfter = await overviewOf(leo.call);
  assert.equal(leoAfter.pendingCount, leoBefore.pendingCount, 'der Zaehler der Seite bleibt');
  assert.equal(leoAfter.moneyPendingCount, leoBefore.moneyPendingCount, 'und der fuer Geld auch');
  const leoDash = await leo.call('GET', '/dashboard');
  assert.equal(leoDash.body.rewards.pending, leoTileBefore.pending, 'der Zaehler der Kachel bleibt');
  assert.equal(leoDash.body.rewards.moneyPending, leoTileBefore.moneyPending);
  assert.ok(!JSON.stringify(leoDash.body).includes('Kino-geheim'));
  assert.ok(!JSON.stringify(leoDash.body.rewards).includes(String(moneyOf(emma.id))), 'kein Geld-Saldo in der Uebersicht');

  // Emma und die Eltern: da.
  const emmaRow = (await emma.call('GET', '/rewards/redemptions?kind=all')).body.data.find((r) => r.id === id);
  assert.equal(emmaRow.kind, 'withdrawal');
  assert.equal(emmaRow.cost, 421);
  assert.equal(emmaRow.user_balance, moneyOf(emma.id), 'user_balance einer Geld-Anfrage ist der Geld-Saldo');
  const adminRow = (await admin('GET', '/rewards/redemptions?status=pending&kind=money')).body.data.find((r) => r.id === id);
  assert.equal(adminRow.note, 'Kino-geheim');
  // Die alten Felder zaehlen weiter nur Praemien; Geld steht daneben.
  const adminAfter = await overviewOf(admin);
  assert.equal(adminAfter.pendingCount, adminBefore.pendingCount, '`pendingCount` bleibt die Zahl der Praemien-Anfragen');
  assert.equal(adminAfter.moneyPendingCount, adminBefore.moneyPendingCount + 1);
  const emmaAfter = await overviewOf(emma.call);
  assert.equal(emmaAfter.pendingCount, emmaBefore.pendingCount);
  assert.equal(emmaAfter.moneyPendingCount, emmaBefore.moneyPendingCount + 1, 'die eigene zaehlt fuer Emma mit');
  const adminTile = await tileOf(admin);
  assert.equal(adminTile.pending, adminTileBefore.pending, 'auch `pending` der Kachel bleibt bei den Praemien');
  assert.equal(adminTile.moneyPending, adminTileBefore.moneyPending + 1);
  const emmaTile = await tileOf(emma.call);
  assert.equal(emmaTile.pending, emmaTileBefore.pending);
  assert.equal(emmaTile.moneyPending, emmaTileBefore.moneyPending + 1);

  // Auch die Eltern-Kachel fuehrt kein Geld.
  assert.ok(!JSON.stringify((await admin('GET', '/dashboard')).body.rewards).includes(String(moneyOf(emma.id))));

  assert.equal((await emma.call('PATCH', `/rewards/redemptions/${id}`, { action: 'cancel' })).status, 200);
});

test('das Wandtablett liest kein Geld - auch keines, das an seinem eigenen Konto haengt', async () => {
  // Die Absage soll nicht daran haengen, dass das Geraet zufaellig keine Zeilen
  // hat: es bekommt welche, von Hand.
  sqlMoney(DISPLAY_ID, 4_242);
  db.prepare("INSERT INTO reward_redemptions (user_id, kind, currency, reward_name, cost, status) VALUES (?, 'deposit', 'EUR', 'deposit', 4243, 'pending')").run(DISPLAY_ID);
  const open = await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '3.33' });
  assert.equal(open.status, 201);

  const accounts = await display('GET', '/rewards/money');
  assert.equal(accounts.status, 200);
  assert.deepEqual(accounts.body.data.accounts, []);
  assert.deepEqual(accounts.body.data.candidates, []);
  assert.deepEqual((await display('GET', '/rewards/money/ledger')).body.data, [], 'keine Geldbuchung, auch nicht die "eigene"');
  assert.deepEqual((await display('GET', `/rewards/money/ledger?user_id=${emma.id}`)).body.data, []);
  for (const query of ['', '?kind=all', '?kind=money', '?kind=deposit']) {
    const requests = (await display('GET', `/rewards/redemptions${query}`)).body.data;
    assert.ok(!requests.some((r) => r.kind !== 'reward'), `keine Geld-Anfrage in der Liste des Tabletts (${query || 'ohne kind'})`);
  }
  const overview = (await display('GET', '/rewards/overview')).body.data;
  const visiblePoints = db.prepare("SELECT COUNT(*) AS n FROM reward_redemptions WHERE status = 'pending' AND kind = 'reward'").get().n;
  assert.equal(overview.pendingCount, visiblePoints, 'der Zaehler nennt nur Praemien-Anfragen');
  assert.equal(overview.moneyPendingCount, 0, 'und der fuer Geld ist am Tablett null');
  const dash = await display('GET', '/dashboard');
  assert.equal(dash.status, 200);
  assert.equal(dash.body.rewards.pending, 0);
  assert.equal(dash.body.rewards.moneyPending, 0);
  for (const secret of [String(moneyOf(emma.id)), String(moneyOf(leo.id)), '4242', '4243']) {
    assert.ok(!JSON.stringify(dash.body.rewards).includes(secret), `die Uebersicht des Tabletts nennt ${secret} nicht`);
  }

  // Und es stellt keine Geld-Anfrage, obwohl es die Route erreicht.
  const before = db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions').get().n;
  const refused = await display('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00', user_id: emma.id });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.reason, 'money_not_on_display');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions').get().n, before);

  await emma.call('PATCH', `/rewards/redemptions/${open.body.data.id}`, { action: 'cancel' });
  db.prepare('DELETE FROM reward_redemptions WHERE user_id = ?').run(DISPLAY_ID);
  db.prepare('DELETE FROM reward_ledger WHERE user_id = ?').run(DISPLAY_ID);
});

test('ein gescoptes API-Token faellt unter dieselbe Regel: sein Subjekt sieht sich, nicht das Geschwisterkind', async () => {
  const mint = async (name, subject) => {
    const res = await admin('POST', '/auth/api-tokens', { name, subject_user_id: subject, scopes: ['rewards:read'] });
    assert.equal(res.status, 201, `Token ${name}`);
    return withToken(res.body.token);
  };
  const leoToken = await mint('Leo liest', leo.id);
  const emmaToken = await mint('Emma liest', emma.id);

  const viaLeo = (await leoToken('GET', '/rewards/money')).body.data;
  assert.deepEqual(viaLeo.accounts.map((a) => a.id), [leo.id]);
  assert.deepEqual((await leoToken('GET', `/rewards/money/ledger?user_id=${emma.id}`)).body.data, []);
  assert.ok(ownOnly((await leoToken('GET', '/rewards/money/ledger')).body.data, leo.id));

  const viaEmma = (await emmaToken('GET', '/rewards/money')).body.data;
  assert.deepEqual(viaEmma.accounts.map((a) => a.id), [emma.id]);
  assert.ok((await emmaToken('GET', '/rewards/money/ledger')).body.data.some((r) => r.reason === 'Startguthaben-Emma'));

  // Lesen heisst lesen: der Scope `rewards:read` stellt keine Anfrage.
  assert.equal((await emmaToken('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00' })).status, 403);
});

test('der Einzelpfad verraet nicht, was die Liste verschweigt: eine fremde Geld-Anfrage ist 404, offen wie entschieden', async () => {
  const open = await emma.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.11' });
  const decided = await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '1.12' });
  assert.equal((await emma.call('PATCH', `/rewards/redemptions/${decided.body.data.id}`, { action: 'cancel' })).status, 200);
  const missing = await leo.call('PATCH', '/rewards/redemptions/99999999', { action: 'cancel' });
  assert.equal(missing.status, 404);

  for (const [label, id] of [['offen', open.body.data.id], ['entschieden', decided.body.data.id]]) {
    for (const action of ['cancel', 'fulfill', 'reject', 'unsinn']) {
      const res = await leo.call('PATCH', `/rewards/redemptions/${id}`, { action });
      assert.equal(res.status, 404, `${label}/${action}: wie eine Kennung, die es nicht gibt`);
      assert.deepEqual(res.body, missing.body, 'und mit genau derselben Antwort');
    }
  }
  assert.equal(db.prepare('SELECT status FROM reward_redemptions WHERE id = ?').get(open.body.data.id).status, 'pending');

  // Emma selbst und die Eltern erreichen sie weiter.
  assert.equal((await admin('PATCH', `/rewards/redemptions/${decided.body.data.id}`, { action: 'fulfill' })).status, 409);
  assert.equal((await emma.call('PATCH', `/rewards/redemptions/${open.body.data.id}`, { action: 'cancel' })).status, 200);
});

test('eine Anfrage "fuer" das Geschwisterkind gilt der eigenen Person - auch die Absage misst nur den eigenen Saldo', async () => {
  // Leo hat weniger als Emma. Zaehlte `user_id` fuer ihn, verriete die Antwort,
  // ob EMMAS Guthaben den Betrag deckt.
  const amount = ((moneyOf(leo.id) + 1) / 100).toFixed(2);
  assert.ok(moneyOf(emma.id) > moneyOf(leo.id) + 1, 'die Probe braucht einen Betrag, den nur Emma decken koennte');
  const before = db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions WHERE user_id = ?').get(emma.id).n;
  const res = await leo.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount, user_id: emma.id });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'insufficient_funds', 'gemessen an Leos Guthaben');
  const small = await leo.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '0.50', user_id: emma.id });
  assert.equal(small.status, 201);
  assert.equal(small.body.data.user_id, leo.id, 'die Anfrage gehoert Leo');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions WHERE user_id = ?').get(emma.id).n, before);
  await leo.call('PATCH', `/rewards/redemptions/${small.body.data.id}`, { action: 'cancel' });
});

test('ein Geschwisterkind mit `rewards: read` und ein Token ohne Belohnungs-Scope lesen ebenfalls nichts', async () => {
  const open = await emma.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '2.22', note: 'nur-fuer-Eltern' });
  const peeker = await member('peeker');
  assert.equal((await admin('PUT', `/permissions/user/${peeker.id}`, { modules: { rewards: 'read' } })).status, 200);
  let all = '';
  for (const path of ['/rewards/money', '/rewards/money/ledger', `/rewards/money/ledger?user_id=${emma.id}`, '/rewards/redemptions', '/rewards/redemptions?kind=all', '/rewards/redemptions?status=pending&kind=money', '/rewards/ledger?limit=500', '/rewards/overview', '/dashboard']) {
    const res = await peeker.call('GET', path);
    assert.equal(res.status, 200, path);
    all += JSON.stringify(res.body);
  }
  for (const secret of ['nur-fuer-Eltern', 'Startguthaben-Emma', 'Startguthaben-Leo', '"withdrawal"', '"deposit"', String(moneyOf(emma.id)), String(moneyOf(leo.id))]) {
    assert.ok(!all.includes(secret), `${secret} steht in keiner Antwort`);
  }
  assert.equal((await peeker.call('PATCH', `/rewards/redemptions/${open.body.data.id}`, { action: 'cancel' })).status, 403, 'nur-lesen: das Modul-Gate steht davor');

  const minted = await admin('POST', '/auth/api-tokens', { name: 'Nur Aufgaben', subject_user_id: emma.id, scopes: ['tasks:read'] });
  assert.equal(minted.status, 201);
  const noScope = withToken(minted.body.token);
  for (const path of ['/rewards/money', '/rewards/money/ledger', '/rewards/redemptions', '/rewards/overview']) {
    assert.equal((await noScope('GET', path)).status, 403, `${path}: ohne Scope kein Zugriff, auch nicht auf das eigene Geld`);
  }
  await emma.call('PATCH', `/rewards/redemptions/${open.body.data.id}`, { action: 'cancel' });
});

test('Buchen und Planen ist Sache der Admins', async () => {
  const before = moneyRows(emma.id).length;
  assert.equal((await emma.call('POST', '/rewards/money/entries', { user_id: emma.id, amount: '50.00', direction: 'credit' })).status, 403);
  assert.equal((await leo.call('POST', '/rewards/money/entries', { user_id: emma.id, amount: '1.00', direction: 'debit' })).status, 403);
  assert.equal((await emma.call('PUT', `/rewards/money/plans/${emma.id}`, { amount: '99.00', frequency: 'weekly', anchor_day: 1 })).status, 403);
  assert.equal((await emma.call('DELETE', `/rewards/money/plans/${emma.id}`)).status, 403);
  assert.equal(moneyRows(emma.id).length, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_allowances WHERE user_id = ?').get(emma.id).n, 0);
});

test('mit `rewards: read` bleibt der Stand sichtbar und die Anfrage weg - wie bei Praemien', async () => {
  const reader = await member('reader');
  assert.equal((await credit(reader, 1_500)).status, 201);
  assert.equal((await admin('PUT', `/permissions/user/${reader.id}`, { modules: { rewards: 'read' } })).status, 200);
  const seen = (await reader.call('GET', '/rewards/money')).body.data;
  assert.equal(seen.accounts[0].balance_minor, 1_500, 'der Zustand bleibt lesbar');
  const refused = await reader.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00' });
  assert.equal(refused.status, 403, 'die Handlung ist weg');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions WHERE user_id = ?').get(reader.id).n, 0);
});

// ==========================================================================
// 3. Abhebung und Einzahlung
// ==========================================================================

test('Abhebung: freier Betrag, beim Stellen nichts gebucht, erst die Freigabe bucht', async () => {
  const start = moneyOf(emma.id);
  const rows = moneyRows(emma.id).length;
  const filed = await emma.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '12.34', note: 'Buch' });
  assert.equal(filed.status, 201);
  assert.equal(filed.body.data.status, 'pending');
  assert.equal(filed.body.data.kind, 'withdrawal');
  assert.equal(filed.body.data.cost, 1_234);
  assert.equal(filed.body.data.catalog_id, null);
  assert.equal(moneyOf(emma.id), start, 'der Saldo steht bis zur Freigabe');
  assert.equal(moneyRows(emma.id).length, rows, 'keine Ledger-Zeile beim Stellen');

  const id = filed.body.data.id;
  assert.equal((await emma.call('PATCH', `/rewards/redemptions/${id}`, { action: 'fulfill' })).status, 403, 'das Kind gibt nicht selbst frei');
  assert.equal((await leo.call('PATCH', `/rewards/redemptions/${id}`, { action: 'fulfill' })).status, 404, 'fuer Leo gibt es die Anfrage nicht');
  assert.equal((await leo.call('PATCH', `/rewards/redemptions/${id}`, { action: 'cancel' })).status, 404, 'und er zieht sie nicht zurueck');
  assert.equal(moneyOf(emma.id), start);

  const points = pointsOf(emma.id);
  const ok = await admin('PATCH', `/rewards/redemptions/${id}`, { action: 'fulfill' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'fulfilled');
  assert.equal(moneyOf(emma.id), start - 1_234);
  assert.equal(pointsOf(emma.id), points, 'die Freigabe einer Abhebung bucht keine Punkte');
  const booked = moneyRows(emma.id).at(-1);
  assert.deepEqual(
    { delta: booked.delta, type: booked.type, unit: booked.unit, redemption_id: booked.redemption_id },
    { delta: -1_234, type: 'redeem', unit: 'money', redemption_id: id },
  );
  assert.equal((await admin('PATCH', `/rewards/redemptions/${id}`, { action: 'fulfill' })).status, 409, 'entschieden ist entschieden');
  assert.equal(moneyOf(emma.id), start - 1_234);

  const history = (await emma.call('GET', '/rewards/money/ledger')).body.data.find((r) => r.redemption_id === id);
  assert.equal(history.request_kind, 'withdrawal');
});

test('keine Ueberziehung: abgewiesen beim Stellen, und noch einmal bei der Freigabe', async () => {
  const kid = await member('sparer');
  assert.equal((await credit(kid, 5_000)).status, 201);

  const tooMuch = await kid.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '50.01' });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.body.reason, 'insufficient_funds');

  // Zwei Anfragen, jede fuer sich gedeckt - zusammen nicht. Nichts ist reserviert.
  const a = await kid.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '30.00' });
  const b = await kid.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '30.00' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal((await admin('PATCH', `/rewards/redemptions/${a.body.data.id}`, { action: 'fulfill' })).status, 200);
  const second = await admin('PATCH', `/rewards/redemptions/${b.body.data.id}`, { action: 'fulfill' });
  assert.equal(second.status, 409);
  assert.equal(second.body.reason, 'insufficient_funds');
  assert.equal(second.body.data.status, 'pending', 'die Anfrage bleibt offen');
  assert.equal(moneyOf(kid.id), 2_000, 'und der Saldo faellt nicht unter null');

  // Erst gutschreiben, dann freigeben - der Weg, den die Antwort offen laesst.
  assert.equal((await credit(kid, 1_000)).status, 201);
  assert.equal((await admin('PATCH', `/rewards/redemptions/${b.body.data.id}`, { action: 'fulfill' })).status, 200);
  assert.equal(moneyOf(kid.id), 0);

  // Auch die Eltern ziehen nicht mehr ab, als da ist.
  const debit = await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '0.01', direction: 'debit' });
  assert.equal(debit.status, 400);
  assert.equal(debit.body.reason, 'insufficient_funds');
  assert.equal(moneyOf(kid.id), 0);
});

test('ablehnen und zurueckziehen buchen nichts - weder Geld noch Punkte', async () => {
  const start = moneyOf(emma.id);
  const points = pointsOf(emma.id);
  const all = () => db.prepare('SELECT COUNT(*) AS n FROM reward_ledger WHERE user_id = ?').get(emma.id).n;
  const rows = all();

  const a = await emma.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '2.00' });
  const rejected = await admin('PATCH', `/rewards/redemptions/${a.body.data.id}`, { action: 'reject' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.status, 'rejected');

  const b = await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '3.00' });
  const cancelled = await emma.call('PATCH', `/rewards/redemptions/${b.body.data.id}`, { action: 'cancel' });
  assert.equal(cancelled.status, 200, 'die eigene Anfrage zieht das Kind selbst zurueck');
  assert.equal(cancelled.body.data.status, 'cancelled');

  assert.equal(all(), rows, 'keine einzige Ledger-Zeile');
  assert.equal(moneyOf(emma.id), start);
  assert.equal(pointsOf(emma.id), points, 'eine abgelehnte Geld-Anfrage wird nicht als Punkte zurueckgebucht');
});

test('Einzahlung: Anfrage des Kindes, gutgeschrieben erst mit der Bestaetigung', async () => {
  const start = moneyOf(emma.id);
  const filed = await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '20.00', note: 'Geburtstag' });
  assert.equal(filed.status, 201);
  assert.equal(filed.body.data.kind, 'deposit');
  assert.equal(moneyOf(emma.id), start, 'noch nicht gutgeschrieben');
  assert.equal((await emma.call('PATCH', `/rewards/redemptions/${filed.body.data.id}`, { action: 'fulfill' })).status, 403);

  assert.equal((await admin('PATCH', `/rewards/redemptions/${filed.body.data.id}`, { action: 'fulfill' })).status, 200);
  assert.equal(moneyOf(emma.id), start + 2_000);
  const booked = moneyRows(emma.id).at(-1);
  assert.deepEqual({ delta: booked.delta, type: booked.type, unit: booked.unit, reason: booked.reason },
    { delta: 2_000, type: 'bonus', unit: 'money', reason: 'Geburtstag' });
});

test('der Haushaltsschalter "ohne Freigabe" reicht nicht bis zum Geld', async () => {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('rewards_require_approval', '0')").run();
  try {
    const start = moneyOf(emma.id);
    const filed = await emma.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00' });
    assert.equal(filed.status, 201);
    assert.equal(filed.body.data.status, 'pending', 'eine Abhebung wartet immer auf einen Admin');
    assert.equal(moneyOf(emma.id), start);
    await emma.call('PATCH', `/rewards/redemptions/${filed.body.data.id}`, { action: 'cancel' });
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'rewards_require_approval'").run();
  }
});

test('wer kein Konto hat, stellt keine Anfrage; Eltern eroeffnen es mit der ersten Buchung', async () => {
  const none = await mia.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '5.00' });
  assert.equal(none.status, 400);
  assert.equal(none.body.reason, 'no_money_account');

  // Nur Haushaltsmitglieder.
  const guest = freshKid();
  db.prepare('INSERT INTO split_expense_guest_users(user_id) VALUES (?)').run(guest);
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: guest, amount: '5.00', direction: 'credit' })).status, 400);
  assert.equal((await admin('PUT', `/rewards/money/plans/${guest}`, { amount: '5.00', frequency: 'weekly', anchor_day: 1 })).status, 400);
  assert.equal(moneyOf(guest), 0);
});

test('ein Betrag ist ein Dezimaltext in ganzen kleinsten Einheiten der Kontowaehrung: 2, 0 und 3 Stellen', async () => {
  const setCurrency = (code) => db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('currency', ?)").run(code);
  try {
    // EUR: zwei Stellen.
    assert.equal(money.parseMoneyAmount('5.00', 'EUR'), 500);
    assert.equal(money.parseMoneyAmount('5', 'EUR'), 500);
    for (const bad of [5, '5.001', '0', '-1.00', 'abc', '', '1,50']) {
      const res = await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} wird abgewiesen`);
    }
    // JPY: keine. Ein Konto, das unter JPY eroeffnet wird, rechnet in ganzen Yen.
    setCurrency('JPY');
    assert.equal(money.parseMoneyAmount('500', 'JPY'), 500);
    assert.throws(() => money.parseMoneyAmount('5.5', 'JPY'), /decimal places/);
    const yenKid = await member('yenkid');
    assert.equal((await admin('POST', '/rewards/money/entries', { user_id: yenKid.id, amount: '1000', direction: 'credit' })).status, 201);
    const yenAccount = (await yenKid.call('GET', '/rewards/money')).body.data.accounts[0];
    assert.deepEqual([yenAccount.currency, yenAccount.minor_unit, yenAccount.balance_minor], ['JPY', 0, 1000]);
    const yen = await yenKid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '300' });
    assert.equal(yen.body.data.cost, 300);
    assert.equal(yen.body.data.currency, 'JPY');
    assert.equal((await yenKid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '3.5' })).status, 400);
    await yenKid.call('PATCH', `/rewards/redemptions/${yen.body.data.id}`, { action: 'cancel' });
    // KWD: drei.
    setCurrency('KWD');
    assert.equal(money.parseMoneyAmount('1.234', 'KWD'), 1_234);
    assert.equal(money.parseMoneyAmount('1', 'KWD'), 1_000);
    assert.throws(() => money.parseMoneyAmount('1.2345', 'KWD'), /decimal places/);
    const dinarKid = await member('dinarkid');
    assert.equal((await admin('POST', '/rewards/money/entries', { user_id: dinarKid.id, amount: '1.234', direction: 'credit' })).status, 201);
    const dinar = (await dinarKid.call('GET', '/rewards/money')).body.data;
    assert.deepEqual([dinar.accounts[0].currency, dinar.accounts[0].minor_unit, dinar.accounts[0].balance_minor], ['KWD', 3, 1_234]);
    assert.deepEqual([dinar.currency, dinar.minor_unit], ['KWD', 3], 'oben steht die Waehrung des Haushalts: darin wird ein neues Konto eroeffnet');
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'currency'").run();
  }
});

// ==========================================================================
// 4. Die Gutschrift nach Plan
// ==========================================================================

const planOf = (id) => db.prepare('SELECT * FROM reward_allowances WHERE user_id = ?').get(id);
const credits = (id) => db.prepare(
  'SELECT allowance_date, delta, type, unit FROM reward_ledger WHERE user_id = ? AND allowance_date IS NOT NULL ORDER BY allowance_date',
).all(id).map((r) => ({ ...r }));

test('der erste Termin: der Wochentag bzw. der Tag im Monat, nie vor heute', () => {
  // 2026-10-06 ist ein Dienstag.
  assert.equal(money.firstRunDate('weekly', 2, '2026-10-06'), '2026-10-06', 'Dienstag an einem Dienstag: heute');
  assert.equal(money.firstRunDate('weekly', 1, '2026-10-06'), '2026-10-12', 'Montag: der naechste');
  assert.equal(money.firstRunDate('weekly', 7, '2026-10-06'), '2026-10-11', 'Sonntag');
  assert.equal(money.firstRunDate('monthly', 6, '2026-10-06'), '2026-10-06');
  assert.equal(money.firstRunDate('monthly', 15, '2026-10-06'), '2026-10-15');
  assert.equal(money.firstRunDate('monthly', 1, '2026-10-06'), '2026-11-01', 'der 1. ist vorbei: naechster Monat');
  assert.equal(money.firstRunDate('monthly', 31, '2026-02-10'), '2026-02-28', 'der 31. im Februar ist der Monatsletzte');
  assert.equal(money.firstRunDate('monthly', 31, '2028-02-29'), '2028-02-29', 'im Schaltjahr der 29.');
  assert.equal(money.firstRunDate('monthly', 30, '2026-03-31'), '2026-04-30');
});

/** Der Monatsletzte bzw. der Ankertag, zwoelf Monate ab `yyyy-mm`. */
function expectedMonthly(year, month, anchor, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const last = new Date(Date.UTC(year, month - 1 + i + 1, 0));
    const day = Math.min(anchor, last.getUTCDate());
    out.push(`${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return out;
}

for (const year of [2027, 2028]) {
  for (const anchor of [29, 30, 31]) {
    test(`monatlich am ${anchor}., zwoelf Termine ab Januar ${year}: Ankertag oder Monatsletzter, und der Tag kommt zurueck`, () => {
      const kid = freshKid();
      const start = `${year}-01-${anchor}`;
      // Angelegt am Vortag: faellt der erste Termin auf den Tag des Anlegens,
      // bucht savePlan() ihn gleich mit.
      money.savePlan(db, kid, { amountMinor: 500, frequency: 'monthly', anchorDay: anchor, paused: false }, { today: `${year}-01-${anchor - 1}` });
      assert.equal(planOf(kid).next_run_date, start);
      const result = money.creditDueAllowances(db, { today: `${year}-12-31` });
      assert.equal(result.credited, 12);
      const soll = expectedMonthly(year, 1, anchor, 12);
      assert.deepEqual(credits(kid).map((c) => c.allowance_date), soll);
      assert.ok(soll.includes(`${year}-02-${year === 2028 ? 29 : 28}`), 'der Februar ist dabei');
      assert.equal(soll[2], `${year}-03-${anchor}`, 'im Maerz steht der Termin wieder auf dem Ankertag');
      assert.equal(moneyOf(kid), 12 * 500);
      assert.equal(planOf(kid).next_run_date, `${year + 1}-01-${anchor}`);
      db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
    });
  }
}

test('woechentlich: sieben Tage, und versaeumte Termine werden nachgebucht - jeder genau einmal', () => {
  const kid = freshKid();
  money.savePlan(db, kid, { amountMinor: 250, frequency: 'weekly', anchorDay: 5, paused: false }, { today: '2026-10-06' });
  assert.equal(planOf(kid).next_run_date, '2026-10-09', 'der naechste Freitag');
  assert.equal(money.creditDueAllowances(db, { today: '2026-10-08' }).credited, 0, 'vor dem Termin: nichts');

  // Der Server war drei Wochen aus.
  const first = money.creditDueAllowances(db, { today: '2026-10-25' });
  assert.equal(first.credited, 3);
  assert.deepEqual(credits(kid), [
    { allowance_date: '2026-10-09', delta: 250, type: 'bonus', unit: 'money' },
    { allowance_date: '2026-10-16', delta: 250, type: 'bonus', unit: 'money' },
    { allowance_date: '2026-10-23', delta: 250, type: 'bonus', unit: 'money' },
  ]);
  assert.equal(planOf(kid).next_run_date, '2026-10-30');

  // Der Lauf feuert ein zweites Mal fuer denselben Tag.
  const second = money.creditDueAllowances(db, { today: '2026-10-25' });
  assert.equal(second.credited, 0);
  assert.equal(moneyOf(kid), 750);
  assert.equal(pointsOf(kid), 0, 'Taschengeld sind keine Punkte');
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
});

test('die Idempotenz steht im Schema: derselbe Termin laesst sich je Person nicht zweimal buchen', () => {
  const kid = freshKid();
  const other = freshKid();
  money.savePlan(db, kid, { amountMinor: 100, frequency: 'weekly', anchorDay: 2, paused: false }, { today: '2026-10-06' });
  money.creditDueAllowances(db, { today: '2026-10-06' });
  assert.equal(credits(kid).length, 1);

  // Der Plan steht (durch einen Fehler, ein Zuruecksetzen, einen zweiten
  // Prozess) wieder auf dem schon gebuchten Termin.
  db.prepare("UPDATE reward_allowances SET next_run_date = '2026-10-06' WHERE user_id = ?").run(kid);
  assert.equal(money.creditDueAllowances(db, { today: '2026-10-06' }).credited, 0);
  assert.equal(credits(kid).length, 1);
  assert.equal(planOf(kid).next_run_date, '2026-10-13', 'und der Plan rueckt trotzdem weiter');

  // Plan geloescht und neu angelegt, selber Tag: der Schluessel ist die Person.
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
  money.savePlan(db, kid, { amountMinor: 999, frequency: 'weekly', anchorDay: 2, paused: false }, { today: '2026-10-06' });
  assert.equal(money.creditDueAllowances(db, { today: '2026-10-06' }).credited, 0);
  assert.equal(moneyOf(kid), 100);

  // Und ohne den Lauf: das Schema selbst sagt nein.
  assert.throws(() => db.prepare(
    "INSERT INTO reward_ledger (user_id, delta, type, unit, currency, allowance_date) VALUES (?, 100, 'bonus', 'money', 'EUR', '2026-10-06')",
  ).run(kid), /UNIQUE/);
  // Eine andere Person am selben Tag ist kein Konflikt, und Zeilen ohne Termin auch nicht.
  db.prepare("INSERT INTO reward_ledger (user_id, delta, type, unit, currency, allowance_date) VALUES (?, 100, 'bonus', 'money', 'EUR', '2026-10-06')").run(other);
  sqlMoney(kid, 1);
  sqlMoney(kid, 1);
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
});

test('pausiert bucht nicht, und Fortsetzen ueberspringt die Termine der Pause', () => {
  const kid = freshKid();
  const input = { amountMinor: 300, frequency: 'weekly', anchorDay: 2, paused: false };
  money.savePlan(db, kid, input, { today: '2026-10-06' });
  money.creditDueAllowances(db, { today: '2026-10-06' });
  money.savePlan(db, kid, { ...input, paused: true }, { today: '2026-10-07' });
  assert.ok(planOf(kid).paused_at);

  assert.equal(money.creditDueAllowances(db, { today: '2026-11-05' }).credited, 0);
  assert.equal(moneyOf(kid), 300);

  const resumed = money.savePlan(db, kid, input, { today: '2026-11-05' });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.next_run_date, '2026-11-10', 'der naechste Dienstag ab heute, im alten Raster');
  assert.equal(money.creditDueAllowances(db, { today: '2026-11-05' }).credited, 0, 'die Wochen der Pause kommen nicht nach');
  assert.equal(money.creditDueAllowances(db, { today: '2026-11-10' }).credited, 1);
  assert.equal(moneyOf(kid), 600);
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
});

test('nur der Betrag geaendert: der Termin bleibt; Rhythmus oder Ankertag geaendert: neu ab heute', () => {
  const kid = freshKid();
  money.savePlan(db, kid, { amountMinor: 300, frequency: 'monthly', anchorDay: 20, paused: false }, { today: '2026-10-06' });
  assert.equal(planOf(kid).next_run_date, '2026-10-20');
  money.savePlan(db, kid, { amountMinor: 350, frequency: 'monthly', anchorDay: 20, paused: false }, { today: '2026-10-10' });
  assert.equal(planOf(kid).next_run_date, '2026-10-20', 'vor dem Termin: er bleibt');
  money.savePlan(db, kid, { amountMinor: 400, frequency: 'monthly', anchorDay: 20, paused: false }, { today: '2026-10-25' });
  assert.deepEqual(credits(kid).map((c) => [c.allowance_date, c.delta]), [['2026-10-20', 350]],
    'ein faelliger Termin geht durch eine Betragsaenderung nicht verloren - und er traegt den alten Betrag');
  assert.equal(planOf(kid).next_run_date, '2026-11-20');
  assert.equal(planOf(kid).amount_minor, 400);
  money.savePlan(db, kid, { amountMinor: 400, frequency: 'monthly', anchorDay: 28, paused: false }, { today: '2026-10-25' });
  assert.equal(planOf(kid).next_run_date, '2026-10-28');
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
});

test('ein deaktiviertes Konto sammelt nicht weiter: der Plan wird pausiert statt gebucht', () => {
  const kid = freshKid();
  const sibling = freshKid();
  for (const id of [kid, sibling]) {
    money.savePlan(db, id, { amountMinor: 500, frequency: 'weekly', anchorDay: 2, paused: false }, { today: '2026-10-05' });
  }
  db.prepare("UPDATE users SET deactivated_at = '2026-10-05T00:00:00Z' WHERE id = ?").run(kid);

  const result = money.creditDueAllowances(db, { today: '2026-10-20' });
  assert.equal(result.paused, 1);
  assert.equal(moneyOf(kid), 0, 'keine Gutschrift fuer das deaktivierte Konto');
  assert.ok(planOf(kid).paused_at, 'der Plan steht auf pausiert');
  assert.equal(moneyOf(sibling), 1_500, 'und der Plan daneben laeuft weiter');
  db.prepare('DELETE FROM reward_allowances WHERE user_id IN (?, ?)').run(kid, sibling);
});

test('"heute" ist der Tag des Haushalts, nicht der UTC-Tag', () => {
  const setZone = (zone) => db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
  const now = new Date('2026-03-10T05:00:00Z');
  const kid = freshKid();
  try {
    money.savePlan(db, kid, { amountMinor: 500, frequency: 'weekly', anchorDay: 2, paused: false }, { today: '2026-03-09' });
    assert.equal(planOf(kid).next_run_date, '2026-03-10');

    // UTC-11: dort ist noch der 9. Maerz.
    setZone('Pacific/Pago_Pago');
    assert.equal(todayKey(db, now), '2026-03-09', 'die Probe braucht eine Zone, in der noch gestern ist');
    assert.equal(money.creditDueAllowances(db, { now }).credited, 0, 'am Vorabend des Haushalts wird nicht gebucht');
    assert.equal(moneyOf(kid), 0);

    // UTC+14: dort ist der 10. laengst da.
    setZone('Pacific/Kiritimati');
    assert.equal(todayKey(db, now), '2026-03-10');
    assert.equal(money.creditDueAllowances(db, { now }).credited, 1);
    assert.equal(moneyOf(kid), 500);
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
    db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
  }
});

test('PUT /rewards/money/plans: anlegen, lesen, pruefen, beenden - und der Plan eroeffnet das Konto', async () => {
  // Ein Wochentag drei Tage nach heute: der Plan ist heute nicht faellig, also
  // bucht das Anlegen nichts, an welchem Tag die Suite auch laeuft.
  const today = todayKey(db);
  const inThree = shiftDateKey(today, 3);
  const weekday = parseDateKey(inThree).getUTCDay() || 7;

  for (const bad of [
    { amount: '5.00', frequency: 'daily', anchor_day: 1 },
    { amount: '5.00', frequency: 'weekly', anchor_day: 8 },
    { amount: '5.00', frequency: 'weekly', anchor_day: 0 },
    { amount: '5.00', frequency: 'monthly', anchor_day: 32 },
    { amount: '5.00', frequency: 'monthly', anchor_day: 1.5 },
    { amount: 5, frequency: 'weekly', anchor_day: 1 },
    { amount: '0', frequency: 'weekly', anchor_day: 1 },
    { amount: '5.00', frequency: 'weekly', anchor_day: 1, paused: 'yes' },
  ]) {
    assert.equal((await admin('PUT', `/rewards/money/plans/${mia.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin('PUT', '/rewards/money/plans/999999', { amount: '5.00', frequency: 'weekly', anchor_day: 1 })).status, 404);
  assert.equal(planOf(mia.id), undefined);

  const saved = await admin('PUT', `/rewards/money/plans/${mia.id}`, { amount: '5.00', frequency: 'weekly', anchor_day: weekday });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.plan, { amount_minor: 500, currency: 'EUR', minor_unit: 2, frequency: 'weekly', anchor_day: weekday, next_run_date: inThree, paused: false });
  assert.equal(saved.body.data.balance_minor, 0);

  const forMia = (await mia.call('GET', '/rewards/money')).body.data;
  assert.equal(forMia.accounts.length, 1, 'der Plan allein ist ein Konto');
  assert.equal(forMia.accounts[0].plan.next_run_date, inThree);
  assert.equal(forMia.accounts[0].balance_minor, 0);
  assert.ok(!(await leo.call('GET', '/rewards/money')).body.data.accounts.some((a) => a.id === mia.id), 'auch den Plan sieht Leo nicht');

  // Faellt der Termin auf heute, steht die Gutschrift mit dem Speichern da - einmal.
  const todayWeekday = parseDateKey(today).getUTCDay() || 7;
  const due = await admin('PUT', `/rewards/money/plans/${mia.id}`, { amount: '5.00', frequency: 'weekly', anchor_day: todayWeekday });
  assert.equal(due.body.data.balance_minor, 500);
  assert.equal(due.body.data.plan.next_run_date, shiftDateKey(today, 7));
  const again = await admin('PUT', `/rewards/money/plans/${mia.id}`, { amount: '5.00', frequency: 'monthly', anchor_day: Number(today.slice(8)) });
  assert.equal(again.body.data.balance_minor, 500, 'derselbe Tag wird durch eine Planaenderung nicht zweimal gebucht');

  assert.equal((await admin('DELETE', `/rewards/money/plans/${mia.id}`)).status, 200);
  assert.equal((await admin('DELETE', `/rewards/money/plans/${mia.id}`)).status, 404);
  assert.equal(moneyOf(mia.id), 500, 'Saldo und Buchungen bleiben');
  const history = (await mia.call('GET', '/rewards/money/ledger')).body.data;
  assert.equal(history[0].allowance_date, today);
  assert.equal(history[0].actor_name, null, 'die Gutschrift nach Plan hat niemand gebucht');
});

// ==========================================================================
// Nacharbeit aus dem Review zu #1745
// ==========================================================================

test('GET /rewards/redemptions ohne `kind` bleibt, was es war: Praemien - Geld nur auf ausdrueckliche Nachfrage', async () => {
  const w = await emma.call('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.31' });
  const dep = await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '1.32' });
  const ids = (rows) => rows.map((r) => r.id);
  for (const [name, call] of [['Admin', admin], ['Emma', emma.call]]) {
    const plain = (await call('GET', '/rewards/redemptions')).body.data;
    assert.ok(plain.every((r) => r.kind === 'reward'), `${name}: ohne kind keine Geld-Zeile - ein Client, der cost als Punkte summiert, zaehlt keine Cent`);
    const statusOnly = (await call('GET', '/rewards/redemptions?status=pending')).body.data;
    assert.ok(statusOnly.every((r) => r.kind === 'reward'), `${name}: auch mit status`);
    assert.ok((await call('GET', '/rewards/redemptions?kind=reward')).body.data.every((r) => r.kind === 'reward'));

    const moneyOnly = (await call('GET', '/rewards/redemptions?kind=money')).body.data;
    assert.ok(moneyOnly.length >= 2 && moneyOnly.every((r) => r.kind !== 'reward'), `${name}: kind=money`);
    assert.ok(ids(moneyOnly).includes(w.body.data.id) && ids(moneyOnly).includes(dep.body.data.id));
    const wOnly = (await call('GET', '/rewards/redemptions?kind=withdrawal')).body.data;
    assert.ok(wOnly.every((r) => r.kind === 'withdrawal') && ids(wOnly).includes(w.body.data.id));
    const dOnly = (await call('GET', '/rewards/redemptions?kind=deposit')).body.data;
    assert.ok(dOnly.every((r) => r.kind === 'deposit') && ids(dOnly).includes(dep.body.data.id));
    const all = (await call('GET', '/rewards/redemptions?kind=all')).body.data;
    assert.equal(all.length, plain.length + moneyOnly.length, `${name}: all = Praemien + Geld`);
    assert.equal((await call('GET', '/rewards/redemptions?kind=alles')).status, 400, 'ein unbekannter Wert ist kein stilles "alles"');
  }
  for (const r of [w, dep]) await emma.call('PATCH', `/rewards/redemptions/${r.body.data.id}`, { action: 'cancel' });
});

test('Betrag, Notiz und Grund sind Texte: ein Array oder ein Objekt ist ein Eingabefehler', async () => {
  const requests = () => db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions WHERE user_id = ?').get(emma.id).n;
  const rows = () => moneyRows(emma.id).length;
  const before = [requests(), rows()];
  for (const amount of [['5'], { v: '5' }, true, null, 5]) {
    assert.equal((await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount })).status, 400, `amount ${JSON.stringify(amount)}`);
    assert.equal((await admin('POST', '/rewards/money/entries', { user_id: emma.id, amount, direction: 'credit' })).status, 400);
  }
  for (const text of [{ x: 1 }, ['a'], 7, true]) {
    assert.equal((await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '5.00', note: text })).status, 400, `note ${JSON.stringify(text)}`);
    assert.equal((await admin('POST', '/rewards/money/entries', { user_id: emma.id, amount: '5.00', direction: 'credit', reason: text })).status, 400, `reason ${JSON.stringify(text)}`);
  }
  assert.deepEqual([requests(), rows()], before, 'nichts davon wurde gespeichert');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reward_redemptions WHERE note LIKE '%object Object%'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reward_ledger WHERE reason LIKE '%object Object%'").get().n, 0);
  // `null` als Notiz heisst weiter "keine".
  const ok = await emma.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '5.00', note: null });
  assert.equal(ok.status, 201);
  await emma.call('PATCH', `/rewards/redemptions/${ok.body.data.id}`, { action: 'cancel' });
});

test('die Obergrenze haengt nicht an der Waehrung: zwei Millionen Rupiah sind ein Geburtstagsgeld', async () => {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('currency', 'IDR')").run();
  const kid = await member('rupiah');
  try {
    assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '50000000', direction: 'credit' })).status, 201, '50 Millionen Rp von den Eltern');
    const gift = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '2000000' });
    assert.equal(gift.status, 201, 'zwei Millionen Rp als Einzahlung');
    assert.equal(gift.body.data.cost, 200_000_000, 'IDR rechnet nach ISO 4217 mit zwei Stellen');
    assert.equal((await admin('PATCH', `/rewards/redemptions/${gift.body.data.id}`, { action: 'fulfill' })).status, 200);
    assert.equal(moneyOf(kid.id), 5_200_000_000);
    assert.equal((await admin('PUT', `/rewards/money/plans/${kid.id}`, { amount: '150000', frequency: 'monthly', anchor_day: 1, paused: true })).status, 200);

    // Es gibt weiter eine Grenze, und sie ist eine der Rechnung.
    assert.equal(money.parseMoneyAmount('10000000000', 'IDR'), money.MAX_MONEY_MINOR);
    assert.throws(() => money.parseMoneyAmount('10000000000.01', 'IDR'), /too large/);
    assert.equal((await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '10000000000.01' })).status, 400);
    assert.ok(money.MAX_MONEY_MINOR * 5200 < Number.MAX_SAFE_INTEGER, 'hundert Jahre Wochenplan am Deckel bleiben exakt');
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'currency'").run();
  }
});

test('eine Gutschrift, nach der der Saldo keine exakte Zahl mehr waere, wird nicht gebucht', async () => {
  const kid = await member('kroesus');
  const nearMax = Number.MAX_SAFE_INTEGER - 100;
  sqlMoney(kid.id, nearMax);
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1.01', direction: 'credit' })).status, 400);
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: kid.id, amount: '1.00', direction: 'credit' })).status, 201, 'genau bis zur Grenze geht es');
  assert.equal(moneyOf(kid.id), Number.MAX_SAFE_INTEGER);

  const dep = await kid.call('POST', '/rewards/redemptions', { kind: 'deposit', amount: '0.01' });
  const refused = await admin('PATCH', `/rewards/redemptions/${dep.body.data.id}`, { action: 'fulfill' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'balance_too_large');
  assert.equal(refused.body.data.status, 'pending');

  money.savePlan(db, kid.id, { amountMinor: 1, frequency: 'weekly', anchorDay: 2, paused: false }, { today: '2026-10-06' });
  assert.equal(moneyOf(kid.id), Number.MAX_SAFE_INTEGER, 'auch der Plan bucht nicht darueber hinaus');
  assert.equal(planOf(kid.id).next_run_date, '2026-10-06', 'und bleibt auf seinem Termin stehen');
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid.id);
  db.prepare('DELETE FROM reward_ledger WHERE user_id = ?').run(kid.id);
});

test('ein Kind mit nur einem Plan bleibt loeschbar; erst eine Buchung ist eine Spur', async () => {
  const { removeUser, userTraces } = await import('../server/services/user-removal.js');
  const planOnly = freshKid();
  money.savePlan(db, planOnly, { amountMinor: 500, frequency: 'weekly', anchorDay: 5, paused: true }, { today: '2026-10-06' });
  assert.deepEqual(userTraces(db, planOnly), [], 'ein Plan ist eine Einstellung am Konto, keine Spur');
  assert.equal(removeUser(db, planOnly).outcome, 'deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(planOnly).n, 0);
  assert.equal(planOf(planOnly), undefined, 'der Plan geht per CASCADE mit');

  const withMoney = freshKid();
  money.savePlan(db, withMoney, { amountMinor: 500, frequency: 'weekly', anchorDay: 5, paused: true }, { today: '2026-10-06' });
  sqlMoney(withMoney, 500);
  assert.equal(removeUser(db, withMoney).outcome, 'deactivated', 'Geld, das gebucht ist, geht nicht mit einem Klick verloren');
  assert.equal(moneyOf(withMoney), 500);
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(withMoney);
});

test('eine Planaenderung bucht die ausstehenden Termine zuerst - mit dem alten Betrag, und keiner faellt weg', () => {
  const kid = freshKid();
  // Dienstags 1,00 seit dem 1. September; der Server lief seither nicht.
  money.savePlan(db, kid, { amountMinor: 100, frequency: 'weekly', anchorDay: 2, paused: false }, { today: '2026-08-31' });
  assert.equal(planOf(kid).next_run_date, '2026-09-01');

  // Am 6. Oktober stellen die Eltern auf freitags 50,00 um.
  const saved = money.savePlan(db, kid, { amountMinor: 5_000, frequency: 'weekly', anchorDay: 5 }, { today: '2026-10-06' });
  assert.deepEqual(credits(kid), ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29', '2026-10-06']
    .map((allowance_date) => ({ allowance_date, delta: 100, type: 'bonus', unit: 'money' })),
  'sechs Termine, jeder mit dem Betrag, der an ihm galt');
  assert.equal(moneyOf(kid), 600);
  assert.equal(saved.next_run_date, '2026-10-09', 'der neue Plan beginnt am naechsten Freitag');
  assert.equal(saved.amount_minor, 5_000);

  // Nur der Betrag: dasselbe - erst buchen, dann aendern.
  db.prepare("UPDATE reward_allowances SET next_run_date = '2026-10-09' WHERE user_id = ?").run(kid);
  money.savePlan(db, kid, { amountMinor: 7_000, frequency: 'weekly', anchorDay: 5 }, { today: '2026-10-23' });
  assert.deepEqual(credits(kid).slice(6).map((c) => [c.allowance_date, c.delta]),
    [['2026-10-09', 5_000], ['2026-10-16', 5_000], ['2026-10-23', 5_000]]);
  assert.equal(planOf(kid).next_run_date, '2026-10-30');
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(kid);
});

test('PUT ohne `paused` laesst einen pausierten Plan pausiert', async () => {
  const kid = await member('pausenkind');
  const body = { amount: '5.00', frequency: 'monthly', anchor_day: 15 };
  assert.equal((await admin('PUT', `/rewards/money/plans/${kid.id}`, { ...body, paused: true })).body.data.plan.paused, true);
  const amountOnly = await admin('PUT', `/rewards/money/plans/${kid.id}`, { ...body, amount: '6.00' });
  assert.equal(amountOnly.status, 200);
  assert.equal(amountOnly.body.data.plan.paused, true, 'das fehlende Feld setzt den Plan nicht fort');
  assert.equal(amountOnly.body.data.plan.amount_minor, 600);
  assert.ok(planOf(kid.id).paused_at);
  assert.equal((await admin('PUT', `/rewards/money/plans/${kid.id}`, { ...body, paused: false })).body.data.plan.paused, false, 'ausdruecklich false setzt fort');
  assert.equal((await admin('PUT', `/rewards/money/plans/${kid.id}`, body)).body.data.plan.paused, false, 'und ohne Feld bleibt auch das');
  // Service: dasselbe ohne die Route.
  const fresh = freshKid();
  assert.equal(money.savePlan(db, fresh, { amountMinor: 100, frequency: 'weekly', anchorDay: 1 }, { today: '2026-10-06' }).paused, false, 'ein neuer Plan ohne Angabe laeuft');
  db.prepare('DELETE FROM reward_allowances WHERE user_id IN (?, ?)').run(kid.id, fresh);
});

test('nur Haushaltsmitglieder: ein deaktiviertes Konto steht in keiner Kontenliste, und fuer einen Gast stellt niemand eine Anfrage', async () => {
  // Ein deaktiviertes Konto OHNE Guthaben (nur Plan) steht in keiner Liste mehr.
  const gone = freshKid();
  money.savePlan(db, gone, { amountMinor: 500, frequency: 'weekly', anchorDay: 5, paused: true }, { today: '2026-10-06' });
  assert.ok((await admin('GET', '/rewards/money')).body.data.accounts.some((a) => a.id === gone), 'Vorbedingung: mit Plan steht das Konto in der Liste');
  db.prepare("UPDATE users SET deactivated_at = '2026-10-05T00:00:00Z' WHERE id = ?").run(gone);
  const listed = (await admin('GET', '/rewards/money')).body.data;
  assert.ok(!listed.accounts.some((a) => a.id === gone), 'deaktiviert und ohne Guthaben: nicht mehr in der Liste');
  assert.ok(!listed.candidates.some((c) => c.id === gone), 'und auch kein Kandidat');
  db.prepare('DELETE FROM reward_allowances WHERE user_id = ?').run(gone);

  // Ein Gast der geteilten Ausgaben mit einer (von Hand angelegten) Geldzeile:
  // "hat ein Konto" allein darf nicht reichen - und "ehemalig" ist er auch nicht.
  const guest = freshKid();
  db.prepare('INSERT INTO split_expense_guest_users(user_id) VALUES (?)').run(guest);
  sqlMoney(guest, 1_000);
  assert.ok(!(await admin('GET', '/rewards/money')).body.data.accounts.some((a) => a.id === guest), 'ein Gast steht auch fuer Admins in keiner Kontenliste');
  assert.equal((await admin('POST', '/rewards/money/entries', { user_id: guest, amount: '1.00', direction: 'debit' })).status, 400, 'und wird nicht "ausgezahlt"');
  assert.equal(money.hasMoneyAccount(db, guest), true, 'Vorbedingung: die Kontopruefung allein liesse ihn durch');
  const before = db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions WHERE user_id = ?').get(guest).n;
  const res = await admin('POST', '/rewards/redemptions', { kind: 'withdrawal', amount: '1.00', user_id: guest });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'no_money_account');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions WHERE user_id = ?').get(guest).n, before);
});

// ==========================================================================
// 5. Die Migration auf einer Datenbank mit Bestand
// ==========================================================================

test('die Migration auf Bestand: jede Zeile ist Punkte, die Salden stehen, die fuenf Indizes bleiben', () => {
  // Ueber die Beschreibung gefunden, nicht ueber die Nummer: zwei offene PRs
  // beanspruchen regelmaessig dieselbe, und umnummeriert wird beim Mergen.
  const migration = dbmod.MIGRATIONS.find((m) => /pocket money/.test(m.description));
  assert.ok(migration, 'die Migration des Taschengelds');

  // reward_ledger und reward_redemptions im Stand vor der Migration (v70 + v221 + v230).
  const conn = new DatabaseSync(':memory:');
  conn.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE reward_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      catalog_id INTEGER, reward_name TEXT NOT NULL, reward_icon TEXT, cost INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', note TEXT, requested_by INTEGER, decided_by INTEGER,
      decided_at TEXT, decision_reason TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE reward_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('earn', 'bonus', 'redeem', 'adjust', 'reversal')),
      reason TEXT, task_id INTEGER, redemption_id INTEGER, created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), series_id INTEGER, reverses_id INTEGER
    );
    CREATE INDEX idx_reward_ledger_user ON reward_ledger(user_id);
    CREATE INDEX idx_reward_ledger_redemption ON reward_ledger(redemption_id);
    CREATE INDEX idx_reward_ledger_task ON reward_ledger(task_id, user_id);
    CREATE INDEX idx_reward_ledger_series ON reward_ledger(series_id, user_id, created_at);
    CREATE INDEX idx_reward_ledger_reverses ON reward_ledger(reverses_id);
    INSERT INTO users (name) VALUES ('a'), ('b');
    INSERT INTO reward_ledger (user_id, delta, type) VALUES (1, 20, 'earn'), (1, -5, 'redeem'), (2, 7, 'bonus'), (2, -7, 'reversal');
    INSERT INTO reward_redemptions (user_id, reward_name, cost) VALUES (1, 'Eis', 5);
  `);
  const sums = () => conn.prepare('SELECT user_id, SUM(delta) AS bal FROM reward_ledger GROUP BY user_id ORDER BY user_id').all().map((r) => ({ ...r }));
  const before = sums();

  conn.exec(migration.up);

  assert.deepEqual(conn.prepare('SELECT DISTINCT unit FROM reward_ledger').all().map((r) => r.unit), ['points']);
  assert.deepEqual(sums(), before, 'kein Saldo hat sich bewegt');
  assert.deepEqual(before, [{ user_id: 1, bal: 15 }, { user_id: 2, bal: 0 }]);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM reward_ledger WHERE allowance_date IS NOT NULL').get().n, 0);
  assert.deepEqual(conn.prepare('SELECT DISTINCT kind FROM reward_redemptions').all().map((r) => r.kind), ['reward']);

  const indexes = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reward_ledger' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
  assert.deepEqual(indexes, [
    'idx_reward_ledger_redemption', 'idx_reward_ledger_reverses', 'idx_reward_ledger_series',
    'idx_reward_ledger_task', 'idx_reward_ledger_user', 'uniq_reward_allowance_credit',
  ], 'die fuenf Indizes bleiben, einer kommt dazu, uniq_reward_earn kommt nicht zurueck');

  // Die Einheit ist geprueft, nicht nur benannt.
  assert.throws(() => conn.exec("INSERT INTO reward_ledger (user_id, delta, type, unit) VALUES (1, 1, 'bonus', 'cents')"), /CHECK/);
  assert.throws(() => conn.exec("INSERT INTO reward_redemptions (user_id, reward_name, cost, kind) VALUES (1, 'x', 1, 'loan')"), /CHECK/);
  assert.throws(() => conn.exec("INSERT INTO reward_allowances (user_id, amount_minor, currency, frequency, anchor_day, next_run_date) VALUES (1, 0, 'EUR', 'weekly', 1, '2026-01-01')"), /CHECK/);
  conn.exec("INSERT INTO reward_allowances (user_id, amount_minor, currency, frequency, anchor_day, next_run_date) VALUES (1, 500, 'EUR', 'weekly', 1, '2026-01-01')");
  assert.throws(() => conn.exec("INSERT INTO reward_allowances (user_id, amount_minor, currency, frequency, anchor_day, next_run_date) VALUES (1, 500, 'EUR', 'monthly', 1, '2026-01-01')"), /UNIQUE/, 'ein Plan je Person');
  assert.throws(() => conn.exec("INSERT INTO reward_allowances (user_id, amount_minor, frequency, anchor_day, next_run_date) VALUES (2, 500, 'weekly', 1, '2026-01-01')"), /NOT NULL/, 'kein Plan ohne Waehrung');

  // Die Waehrung haengt an der Einheit: Bestand (Punkte) traegt keine, Geld immer eine.
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM reward_ledger WHERE currency IS NOT NULL').get().n, 0);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM reward_redemptions WHERE currency IS NOT NULL').get().n, 0);
  // Das Konto: eine Zeile je Person, mit Waehrung.
  conn.exec("INSERT INTO reward_money_accounts (user_id, currency) VALUES (1, 'EUR')");
  assert.throws(() => conn.exec("INSERT INTO reward_money_accounts (user_id, currency) VALUES (1, 'JPY')"), /UNIQUE/, 'ein Konto je Person');
  assert.throws(() => conn.exec('INSERT INTO reward_money_accounts (user_id) VALUES (2)'), /NOT NULL/, 'kein Konto ohne Waehrung');
  conn.exec("INSERT INTO reward_ledger (user_id, delta, type, unit, currency) VALUES (1, 100, 'bonus', 'money', 'EUR')");
  assert.throws(() => conn.exec("INSERT INTO reward_ledger (user_id, delta, type, unit) VALUES (1, 100, 'bonus', 'money')"), /CHECK/, 'Geld ohne Code');
  assert.throws(() => conn.exec("INSERT INTO reward_ledger (user_id, delta, type, currency) VALUES (1, 100, 'bonus', 'EUR')"), /CHECK/, 'Punkte mit Code');
  conn.exec("INSERT INTO reward_redemptions (user_id, reward_name, cost, kind, currency) VALUES (1, 'deposit', 100, 'deposit', 'EUR')");
  assert.throws(() => conn.exec("INSERT INTO reward_redemptions (user_id, reward_name, cost, kind) VALUES (1, 'deposit', 100, 'deposit')"), /CHECK/, 'Geld-Anfrage ohne Code');
  assert.throws(() => conn.exec("INSERT INTO reward_redemptions (user_id, reward_name, cost, currency) VALUES (1, 'Eis', 5, 'EUR')"), /CHECK/, 'Praemien-Anfrage mit Code');
  assert.equal(conn.prepare("SELECT SUM(delta) AS bal FROM reward_ledger WHERE user_id = 1 AND unit = 'points'").get().bal, 15, 'und die Punkte stehen, wie sie waren');
  conn.close();
});

test('das echte migrate() mit dem ausgelieferten Treiber, auf einer Datei im Stand davor mit Bestand', () => {
  // Der Test darueber faehrt das SQL auf node:sqlite gegen ein handgebautes
  // Schema. Hier laeuft der Weg, den eine Installation beim Update geht: die
  // echten Migrationen bis davor, Bestand, dann `migrate()` mit dem Treiber,
  // der ausgeliefert wird.
  const V = dbmod.MIGRATIONS.find((m) => /pocket money/.test(m.description));
  const file = new Database(join(tempDir('yuvomi-reward-money-mig-'), 'db.sqlite'));
  try {
    file.pragma('foreign_keys = ON');
    dbmod.migrate(file, dbmod.MIGRATIONS.filter((m) => m.version < V.version));
    assert.ok(!file.prepare('PRAGMA table_info(reward_ledger)').all().some((c) => c.name === 'unit'), 'Vorbedingung: der Stand davor');

    const user = (name) => Number(file.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')").run(name, name).lastInsertRowid);
    const a = user('anna');
    const b = user('ben');
    const eis = Number(file.prepare("INSERT INTO reward_catalog (name, cost) VALUES ('Eis', 10)").run().lastInsertRowid);
    // Einloesungen in drei Zustaenden, mit den Buchungen, die sie hinterlassen.
    const redemption = (uid, status) => Number(file.prepare(
      "INSERT INTO reward_redemptions (user_id, catalog_id, reward_name, cost, status) VALUES (?, ?, 'Eis', 10, ?)",
    ).run(uid, eis, status).lastInsertRowid);
    const ledger = file.prepare('INSERT INTO reward_ledger (user_id, delta, type, reason, redemption_id) VALUES (?, ?, ?, ?, ?)');
    ledger.run(a, 50, 'earn', 'Zimmer', null);
    ledger.run(a, 5, 'bonus', null, null);
    const open = redemption(a, 'pending'); ledger.run(a, -10, 'redeem', 'Eis', open);
    const done = redemption(a, 'fulfilled'); ledger.run(a, -10, 'redeem', 'Eis', done);
    const no = redemption(b, 'rejected'); ledger.run(b, -10, 'redeem', 'Eis', no); ledger.run(b, 10, 'reversal', 'Eis', no);
    ledger.run(b, -3, 'adjust', null, null);
    const sums = () => file.prepare('SELECT user_id, SUM(delta) AS bal FROM reward_ledger GROUP BY user_id ORDER BY user_id').all();
    const before = { sums: sums(), ledger: file.prepare('SELECT COUNT(*) AS n FROM reward_ledger').get().n, redemptions: file.prepare('SELECT id, status FROM reward_redemptions ORDER BY id').all() };
    assert.deepEqual(before.sums, [{ user_id: a, bal: 35 }, { user_id: b, bal: -3 }]);

    dbmod.migrate(file, dbmod.MIGRATIONS.filter((m) => m.version <= V.version));

    assert.equal(file.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(file.pragma('foreign_key_check'), []);
    assert.equal(file.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, V.version);
    assert.deepEqual(sums(), before.sums, 'kein Saldo hat sich bewegt');
    assert.equal(file.prepare('SELECT COUNT(*) AS n FROM reward_ledger').get().n, before.ledger);
    assert.deepEqual(file.prepare('SELECT DISTINCT unit, currency, allowance_date FROM reward_ledger').all(), [{ unit: 'points', currency: null, allowance_date: null }]);
    assert.deepEqual(file.prepare('SELECT DISTINCT kind, currency FROM reward_redemptions').all(), [{ kind: 'reward', currency: null }]);
    assert.deepEqual(file.prepare('SELECT id, status FROM reward_redemptions ORDER BY id').all(), before.redemptions, 'jede Einloesung in ihrem Zustand');
    assert.equal(file.prepare('SELECT COUNT(*) AS n FROM reward_money_accounts').get().n, 0);
    assert.equal(file.prepare('SELECT COUNT(*) AS n FROM reward_allowances').get().n, 0);
    const indexes = file.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reward_ledger' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
    assert.deepEqual(indexes, ['idx_reward_ledger_redemption', 'idx_reward_ledger_reverses', 'idx_reward_ledger_series', 'idx_reward_ledger_task', 'idx_reward_ledger_user', 'uniq_reward_allowance_credit']);

    // Beide CHECKs lehnen die falschen Formen ab - mit dem ausgelieferten Treiber.
    const refuses = (sql, ...args) => assert.throws(() => file.prepare(sql).run(...args), /CHECK constraint failed/, sql);
    refuses("INSERT INTO reward_ledger (user_id, delta, type, unit) VALUES (?, 1, 'bonus', 'money')", a);
    refuses("INSERT INTO reward_ledger (user_id, delta, type, currency) VALUES (?, 1, 'bonus', 'EUR')", a);
    refuses("INSERT INTO reward_ledger (user_id, delta, type, unit) VALUES (?, 1, 'bonus', 'cents')", a);
    refuses("INSERT INTO reward_redemptions (user_id, reward_name, cost, kind) VALUES (?, 'deposit', 1, 'deposit')", a);
    refuses("INSERT INTO reward_redemptions (user_id, reward_name, cost, currency) VALUES (?, 'Eis', 1, 'EUR')", a);
    // Und die richtigen gehen.
    file.prepare("INSERT INTO reward_money_accounts (user_id, currency) VALUES (?, 'EUR')").run(a);
    file.prepare("INSERT INTO reward_ledger (user_id, delta, type, unit, currency) VALUES (?, 100, 'bonus', 'money', 'EUR')").run(a);
    file.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, kind, currency) VALUES (?, 'deposit', 100, 'deposit', 'EUR')").run(a);
    assert.equal(rewards.ledgerBalance(file, a, 'points'), 35, 'der Punktestand liest das Geld nicht mit');
    assert.equal(rewards.ledgerBalance(file, a, 'money'), 100);
    assert.deepEqual(file.pragma('foreign_key_check'), []);
  } finally {
    file.close();
  }
});

test('die laufende Datenbank traegt dasselbe: Spalten, Index, Plan-Tabelle', () => {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(cols('reward_ledger').includes('unit') && cols('reward_ledger').includes('allowance_date') && cols('reward_ledger').includes('currency'));
  assert.ok(cols('reward_redemptions').includes('currency') && cols('reward_allowances').includes('currency'));
  assert.ok(cols('reward_redemptions').includes('kind'));
  assert.ok(cols('reward_allowances').includes('anchor_day'));
  assert.deepEqual(cols('reward_money_accounts'), ['id', 'user_id', 'currency', 'created_by', 'created_at', 'updated_at']);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reward_ledger'").all().map((r) => r.name);
  for (const name of ['idx_reward_ledger_user', 'idx_reward_ledger_redemption', 'idx_reward_ledger_task', 'idx_reward_ledger_series', 'idx_reward_ledger_reverses', 'uniq_reward_allowance_credit']) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.includes('uniq_reward_earn'));
});
