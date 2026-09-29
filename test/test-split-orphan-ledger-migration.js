/**
 * Test: Ledger-Zeilen einer Ausgabe, die es nicht mehr gibt, fallen weg (Migration v227, #1445)
 * Zweck: `expenses.created_by` und `expense_ledger_entries.created_by` sind
 *        beide ON DELETE CASCADE. Bis v225 stempelte ein PUT /expenses/:id die
 *        Zeilen mit der BEARBEITENDEN Person. Wurde danach das Konto der
 *        Person geloescht, die die Ausgabe angelegt hatte, nahm die Kaskade
 *        Ausgabe und Anteile, die Zeilen (mit dem Bearbeiter) blieben - und
 *        verschoben weiter die Salden, waehrend keine Liste eine Ausgabe
 *        zeigte, die sie erklaert. v225 laesst sie liegen, v226 baut nur fuer
 *        existierende Ausgaben auf. v227 entfernt sie und nennt jede
 *        entfernte Ausgabe im Verlauf ihrer Gruppe (`ledger_removed`).
 *
 *        Zwei Teile:
 *        1. Ueber den echten Server: die Waise entsteht ueber die Routen, den
 *           alten PUT-Stempel und `DELETE /auth/users/<Autorin>`; gemessen
 *           werden die Salden der API gegen den Stand vor der Ausgabe und der
 *           Verlauf mit Dezimalbetrag.
 *        2. Upgrade durch den echten Runner: frische Datenbank bis v226,
 *           Waise per Kaskade saeen, dann `migrate()` mit allen Migrationen -
 *           so, wie eine Bestandsinstallation das Update faehrt. Daneben das,
 *           was bleiben muss: eine vollstaendige Ausgabe, eine geloeschte
 *           Ausgabe MIT Zeilen und Gegenbuchung (die Form aus #1416 - ihre
 *           `expenses`-Zeile existiert), und eine Zahlung, deren source_id
 *           zufaellig die id der verschwundenen Ausgabe ist.
 * Ausfuehren: npm run test:split-orphan-ledger-migration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3-multiple-ciphers';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'split-orphan-ledger-migration',
  env: { SESSION_SECRET: 'test-split-orphan-ledger-migration-secret', RATE_LIMIT_MAX_ATTEMPTS: '50' },
});
const dbmod = await import('../server/db.js');
const { groupBalanceRows } = await import('../server/services/split-expenses.js');
const db = dbmod.get();
const migration227 = dbmod.MIGRATIONS.find((m) => m.version === 227);

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* leer */ }
    return { status: res.status, body: json };
  };
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const adminCall = as(await login('admin', 'adminpass123'));

async function member(username, displayName) {
  const r = await adminCall('POST', '/auth/users', { username, display_name: displayName, password: `${username}pass123` });
  assert.equal(r.status, 201, `create ${username}`);
  return { id: r.body.user.id, call: as(await login(username, `${username}pass123`)) };
}

// OWN besitzt die Gruppe und zahlt, AUT legt die Ausgabe an (weder Zahlerin
// noch beteiligt - sonst blockte user_id ON DELETE RESTRICT ihre Loeschung),
// ED hat sie zuletzt bearbeitet, PAY teilt.
const OWN = await member('owner', 'Olivia');
const AUT = await member('author', 'Anna');
const ED = await member('editor', 'Emil');
const PAY = await member('payer', 'Paul');

const group = await OWN.call('POST', '/split-expenses/groups', { name: 'WG', type: 'household', default_currency: 'EUR' });
assert.equal(group.status, 201);
const GROUP = group.body.data.id;
for (const [u, role] of [[AUT, 'guest'], [ED, 'admin'], [PAY, 'guest']]) {
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: u.id, role })).status, 201);
}

async function balances() {
  const r = await OWN.call('GET', `/split-expenses/groups/${GROUP}/balances`);
  assert.equal(r.status, 200);
  return r.body.data.balances;
}

const ledgerOf = (id) => db.prepare(
  "SELECT * FROM expense_ledger_entries WHERE source_type = 'expense' AND source_id = ? ORDER BY id",
).all(id);
const snapshot = () => db.prepare('SELECT * FROM expense_ledger_entries ORDER BY id').all();

// Was bleibt: eine Ausgabe von OWN und eine Zahlung.
const kept = await OWN.call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
  title: 'Brot', amount: '4.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
  participants: [OWN.id, PAY.id], expense_date: '2026-09-02',
});
assert.equal(kept.status, 201);
const KEPT = kept.body.data.id;
const settled = await PAY.call('POST', `/split-expenses/groups/${GROUP}/settlements`, { payer_id: PAY.id, payee_id: OWN.id, amount: '1.00', currency: 'EUR' });
assert.equal(settled.status, 201);
const KEPT_ROWS = ledgerOf(KEPT);
const BALANCES = await balances();

// Die spaetere Waise: in Fremdwaehrung, gebucht wird der umgerechnete Betrag.
const lost = await AUT.call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
  title: 'Urlaub', amount: '20.00', currency: 'USD', converted_amount: '18.50', converted_currency: 'EUR',
  split_method: 'equal', payer_id: OWN.id, participants: [OWN.id, PAY.id], expense_date: '2026-09-03',
});
assert.equal(lost.status, 201, JSON.stringify(lost.body));
const LOST = lost.body.data.id;
assert.notDeepEqual(await balances(), BALANCES, 'Fixture: die Ausgabe bewegt die Salden');

// Der Stand, den der alte PUT hinterliess: Zeilen mit dem Bearbeiter
// gestempelt. Dann das Konto der Autorin loeschen - die Kaskade nimmt die
// Ausgabe, die Zeilen haengen am Bearbeiter und bleiben.
db.prepare("UPDATE expense_ledger_entries SET created_by = ? WHERE source_type = 'expense' AND source_id = ?").run(ED.id, LOST);
assert.equal((await adminCall('DELETE', `/auth/users/${AUT.id}`)).status, 200);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE id = ?').get(LOST).n, 0, 'Fixture: Ausgabe ist weg');
assert.equal(ledgerOf(LOST).length, 3, 'Fixture: Zahler + zwei Anteile sind geblieben');

test('Migration v227 existiert und laeuft als Funktion', () => {
  assert.ok(migration227, 'MIGRATIONS enthaelt v227');
  assert.equal(typeof migration227?.up, 'function');
});

test('vor der Migration zaehlt die Waise im Saldo mit (der Befund aus #1445)', async () => {
  assert.notDeepEqual(await balances(), BALANCES);
});

test('nach der Migration: Zeilen der Waise weg, Salden wie ohne die Ausgabe, der Rest unberuehrt', async () => {
  migration227.up(db);
  assert.equal(ledgerOf(LOST).length, 0, 'keine Zeile der verschwundenen Ausgabe');
  assert.deepEqual(ledgerOf(KEPT), KEPT_ROWS, 'vorhandene Ausgabe: dieselben Zeilen');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM expense_ledger_entries WHERE source_type = 'settlement'").get().n,
    2,
    'Zahlungszeilen bleiben',
  );
  assert.deepEqual(await balances(), BALANCES);
});

test('der Verlauf nennt die entfernte Ausgabe einmal, ohne Akteur, mit Titel und Dezimalbetrag', async () => {
  const r = await OWN.call('GET', `/split-expenses/groups/${GROUP}/activity`);
  assert.equal(r.status, 200);
  const list = Array.isArray(r.body.data) ? r.body.data : r.body.data.items;
  const removed = list.filter((a) => a.type === 'ledger_removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].entity_type, 'expense');
  assert.equal(removed[0].entity_id, LOST);
  assert.equal(removed[0].actor_id, null);
  assert.deepEqual(removed[0].metadata, { title: 'Urlaub', amount_minor: 1850, currency: 'EUR', amount: '18.50' });
});

test('zweiter Lauf aendert nichts', () => {
  const before = snapshot();
  const activityBefore = db.prepare('SELECT COUNT(*) AS n FROM expense_activity').get().n;
  const changesBefore = db.prepare('SELECT total_changes() AS n').get().n;
  migration227.up(db);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changesBefore, 'keine Zeile beruehrt');
  assert.deepEqual(snapshot(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_activity').get().n, activityBefore);
});

test('Upgrade von v226 durch den echten Runner entfernt die Waisen und verbucht v227', () => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  const logged = [];
  const write = process.stdout.write;
  try {
    process.stdout.write = (chunk, ...rest) => { logged.push(String(chunk)); return write.call(process.stdout, chunk, ...rest); };
    dbmod.migrate(fresh, dbmod.MIGRATIONS.filter((m) => m.version <= 226));
    const user = (name) => fresh.prepare(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')",
    ).run(name, name).lastInsertRowid;
    const own = user('own');
    const pay = user('pay');
    const aut = user('aut');
    const ed = user('ed');
    const groupId = fresh.prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(own).lastInsertRowid;
    const otherGroup = fresh.prepare("INSERT INTO expense_groups (name, created_by) VALUES ('Urlaub', ?)").run(own).lastInsertRowid;
    const addExpense = (gid, title, author, status = 'active') => fresh.prepare(`
      INSERT INTO expenses (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, created_by, status)
      VALUES (?, ?, 2000, 'USD', 1850, 'EUR', ?, ?, ?)
    `).run(gid, title, own, author, status).lastInsertRowid;
    const ledger = fresh.prepare(`
      INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?)
    `);
    // Buchung wie insertExpenseLedger: Zahler-Zeile, dann je Anteil eine.
    // `sharesFirst` dreht die Reihenfolge - der Verlaufseintrag muss den
    // Betrag an der Zahler-Zeile (counterparty_id NULL) finden, nicht an der
    // ersten Zeile.
    const book = (gid, id, title, stamp, sourceType = 'expense', sign = 1, sharesFirst = false) => {
      const payer = () => ledger.run(gid, sourceType, id, own, null, sign * 1850, title, stamp);
      if (!sharesFirst) payer();
      ledger.run(gid, sourceType, id, own, own, sign * -925, title, stamp);
      ledger.run(gid, sourceType, id, pay, own, sign * -925, title, stamp);
      if (sharesFirst) payer();
    };
    // Zwei Waisen in WG: von aut angelegt, von ed zuletzt bearbeitet (der alte PUT-Stempel).
    const orphan1 = addExpense(groupId, 'Einkauf', aut);
    const orphan2 = addExpense(groupId, 'Kino', aut);
    book(groupId, orphan1, 'Einkauf', ed);
    book(groupId, orphan2, 'Kino', ed, 'expense', 1, true);
    // Bleibt: eine vollstaendige Ausgabe in der anderen Gruppe ...
    const complete = addExpense(otherGroup, 'Hotel', own);
    book(otherGroup, complete, 'Hotel', own);
    // ... eine geloeschte Ausgabe mit Buchung und Gegenbuchung (Form aus #1416) ...
    const deleted = addExpense(groupId, 'Storniert', own, 'deleted');
    book(groupId, deleted, 'Storniert', own);
    book(groupId, deleted, 'Storniert', own, 'expense_reversal', -1);
    // ... und eine Zahlung, deren id zufaellig die der ersten Waise ist.
    fresh.prepare(`
      INSERT INTO settlements (id, group_id, payer_id, payee_id, amount_minor, currency, created_by)
      VALUES (?, ?, ?, ?, 500, 'EUR', ?)
    `).run(orphan1, groupId, pay, own, own);
    ledger.run(groupId, 'settlement', orphan1, pay, own, 500, 'Zahlung', own);
    ledger.run(groupId, 'settlement', orphan1, own, pay, -500, 'Zahlung', own);

    // Die Kaskade, die den Befund erzeugt: aut geht, ihre Ausgaben mit.
    fresh.prepare('DELETE FROM users WHERE id = ?').run(aut);
    assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM expenses WHERE id IN (?, ?)').get(orphan1, orphan2).n, 0, 'Fixture: Ausgaben weg');
    assert.equal(fresh.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 226, 'Fixture: Stand v226');
    const keptBefore = fresh.prepare(`
      SELECT * FROM expense_ledger_entries
      WHERE NOT (source_type = 'expense' AND source_id IN (?, ?))
      ORDER BY id
    `).all(orphan1, orphan2);
    // Richtig ist der Saldo ohne die beiden Waisen: nur die Zahlung (die
    // geloeschte Ausgabe hebt sich mit ihrer Gegenbuchung auf).
    const expectedWg = [
      { currency: 'EUR', user_id: own, display_name: 'own', net_minor: -500 },
      { currency: 'EUR', user_id: pay, display_name: 'pay', net_minor: 500 },
    ];

    dbmod.migrate(fresh, dbmod.MIGRATIONS);

    assert.deepEqual(groupBalanceRows(fresh, groupId), expectedWg, 'Salden der WG ohne die Waisen');
    assert.ok(fresh.prepare('SELECT 1 FROM schema_migrations WHERE version = 227').get(), 'v227 verbucht');
    assert.deepEqual(fresh.prepare('SELECT * FROM expense_ledger_entries ORDER BY id').all(), keptBefore,
      'genau die Zeilen der Waisen fallen weg - vollstaendige, geloeschte, Gegenbuchung und Zahlung bleiben');

    const activity = fresh.prepare(`
      SELECT group_id, actor_id, type, entity_type, entity_id, metadata FROM expense_activity ORDER BY id
    `).all();
    const removed = (id, title) => ({
      group_id: groupId, actor_id: null, type: 'ledger_removed', entity_type: 'expense', entity_id: id,
      metadata: JSON.stringify({ title, amount_minor: 1850, currency: 'EUR' }),
    });
    assert.deepEqual(activity, [removed(orphan1, 'Einkauf'), removed(orphan2, 'Kino')], 'N Eintraege fuer N entfernte Ausgaben, keiner sonst');
    assert.ok(logged.some((line) => line.includes(`shared expense ${orphan1} in group ${groupId}`)), 'Log nennt Ausgabe und Gruppe');
    assert.ok(!logged.some((line) => line.includes(`shared expense ${complete} `)), 'vollstaendige Ausgabe steht nicht im Log');
    assert.equal(fresh.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name = '_v227_orphans'").get().n, 0, 'Hilfstabelle geraeumt');

  } finally {
    process.stdout.write = write;
    fresh.close();
  }
});
