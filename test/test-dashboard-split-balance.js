/**
 * Kennzahl „Ausgleich offen" der geteilten Ausgaben auf dem Dashboard.
 *
 * Das Modul hatte kein Dashboard-Element (Critique 2026-09-23). Die Kachel
 * steht in der bestehenden Kennzahlreihe (`metrics`) und zeigt aus Sicht des
 * Betrachters den Netto-Saldo plus die groesste offene Position.
 *
 * DIE EINE ZUSAGE, AN DER ALLES HAENGT: die Kachel rechnet NICHT selbst. Sie
 * liest dieselben Saldenzeilen wie die Ausgleichs-Ansicht des Moduls
 * (`groupBalanceRows()` + `simplifyDebts()`), damit ein Fehler in den Salden
 * beide Stellen gleich trifft und ein Fix beide zugleich heilt, statt dass die
 * Uebersicht eine zweite Zahl erfindet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import http from 'node:http';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-split-balance-test-secret';

register('./test-browser-loader.mjs', import.meta.url);

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const moduleDatabase = get();
const database = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(database);
moduleDatabase.close();
database.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('currency', 'EUR')").run();

function seedUser(name) {
  return Number(database.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', 'member', 'parent')
  `).run(`${name.toLowerCase()}-${randomUUID()}`, name).lastInsertRowid);
}

function seedGroup(name, members, { currency = 'EUR' } = {}) {
  const groupId = Number(database.prepare(`
    INSERT INTO expense_groups (name, type, default_currency, created_by) VALUES (?, 'general', ?, ?)
  `).run(name, currency, members[0]).lastInsertRowid);
  members.forEach((userId, index) => {
    database.prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)')
      .run(groupId, userId, index === 0 ? 'owner' : 'admin', members[0]);
  });
  return groupId;
}

function setModuleAccess(userId, moduleKey, access) {
  database.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, ?)
  `).run(String(userId), moduleKey, access);
}

function clearModuleAccess(userId) {
  database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
}

const ME = seedUser('Linda');
const ALEX = seedUser('Alex');
const BEA = seedUser('Bea');

const TRIP = seedGroup('Urlaub', [ME, ALEX]);
const FLAT = seedGroup('WG', [ME, BEA]);
const FOREIGN = seedGroup('Nur Alex und Bea', [ALEX, BEA]);
const ARCHIVED = seedGroup('Alte Reise', [ME, ALEX]);

let actor = ME;
let tokenScopes = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(database, user));
  req.authScopes = tokenScopes;
  next();
});
app.use('/dashboard', dashboardRouter);
app.use('/split-expenses', splitRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  database.close();
});

async function as(userId, fn) {
  const previous = actor;
  actor = userId;
  try { return await fn(); } finally { actor = previous; }
}

async function getJson(path) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, `GET ${path}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await response.json();
  assert.equal(response.status, 201, `POST ${path}: ${JSON.stringify(json)}`);
  return json;
}

const addExpense = (groupId, payerId, amount, participants, extra = {}) => postJson(`/split-expenses/groups/${groupId}/expenses`, {
  title: `Ausgabe ${amount}`, amount, payer_id: payerId, participants, expense_date: '2026-09-20', ...extra,
});
const settle = (groupId, payerId, payeeId, amount, currency = 'EUR') => postJson(`/split-expenses/groups/${groupId}/settlements`, {
  payer_id: payerId, payee_id: payeeId, amount, currency,
});

async function splitBalanceOf(userId) {
  return as(userId, async () => (await getJson('/dashboard/')).splitBalance);
}

/**
 * Was die Ausgleichs-Ansicht des Moduls dem Betrachter an offenen Positionen
 * zeigt - gelesen ueber die Modul-Route, nicht nachgerechnet.
 */
async function modulePositionsOf(userId, groupIds) {
  return as(userId, async () => {
    const out = [];
    for (const groupId of groupIds) {
      const { data } = await getJson(`/split-expenses/groups/${groupId}/balances`);
      for (const debt of data.simplified_debts) {
        if (debt.from_user_id === userId) out.push({ groupId, direction: 'owe', userId: debt.to_user_id, currency: debt.currency, amountMinor: debt.amount_minor });
        if (debt.to_user_id === userId) out.push({ groupId, direction: 'owed', userId: debt.from_user_id, currency: debt.currency, amountMinor: debt.amount_minor });
      }
    }
    return out.sort((a, b) => a.groupId - b.groupId);
  });
}

const comparable = (positions) => positions
  .map(({ groupId, direction, userId, currency, amountMinor }) => ({ groupId, direction, userId, currency, amountMinor }))
  .sort((a, b) => a.groupId - b.groupId);

// --------------------------------------------------------------------------
// Server: Netto-Berechnung ueber dieselbe Quelle wie das Modul
// --------------------------------------------------------------------------

test('ohne Ausgaben: die Antwort traegt die leere Form, nicht undefined', async () => {
  assert.deepEqual(await splitBalanceOf(ME), { net: [], positions: [] });
});

test('zwei Personen, Teilzahlung: Netto und groesste Position aus Sicht des Betrachters', async () => {
  // Urlaub: Alex legt 46,00 aus, halbe-halbe -> ich schulde Alex 23,00.
  await as(ALEX, () => addExpense(TRIP, ALEX, '46.00', [ME, ALEX]));
  // Teilzahlung 10,00 an Alex -> offen 13,00.
  await as(ME, () => settle(TRIP, ME, ALEX, '10.00'));
  // WG: ich lege 30,00 aus, halbe-halbe -> Bea schuldet mir 15,00.
  await as(ME, () => addExpense(FLAT, ME, '30.00', [ME, BEA]));
  // Fremde Gruppe (ich bin nicht Mitglied) und archivierte Gruppe zaehlen nicht.
  await as(ALEX, () => addExpense(FOREIGN, ALEX, '100.00', [ALEX, BEA]));
  await as(ALEX, () => addExpense(ARCHIVED, ALEX, '50.00', [ME, ALEX]));
  database.prepare("UPDATE expense_groups SET status = 'archived' WHERE id = ?").run(ARCHIVED);

  const balance = await splitBalanceOf(ME);
  assert.deepEqual(balance.net, [{ currency: 'EUR', netMinor: 200, amount: '2.00' }],
    'netto: 15,00 bekomme ich, 13,00 schulde ich -> +2,00');
  assert.deepEqual(balance.positions.map((p) => [p.direction, p.name, p.amount, p.groupId]), [
    ['owed', 'Bea', '15.00', FLAT],
    ['owe', 'Alex', '13.00', TRIP],
  ], 'groesste Position zuerst; fremde und archivierte Gruppen fehlen');
  assert.ok(!balance.positions.some((p) => p.groupId === FOREIGN || p.groupId === ARCHIVED));
});

test('dieselbe Quelle: jede Position steht genauso in der Ausgleichs-Ansicht des Moduls', async () => {
  const tile = comparable((await splitBalanceOf(ME)).positions);
  const module = comparable(await modulePositionsOf(ME, [TRIP, FLAT]));
  assert.deepEqual(tile, module);
});

test('eine Buchungszeile ohne Ausgabe verschiebt Kachel und Modul GLEICH', async () => {
  // Die Saldenquelle zaehlt jede Ledger-Zeile. Den Altbestand solcher Zeilen
  // (#1445) hat Migration v227 einmal entfernt (test:split-orphan-ledger-
  // migration); hier zugesagt ist nur, dass die Kachel denselben Stand zeigt
  // wie das Modul. Gemessen wird die Gleichheit, nicht der Betrag.
  const orphan = database.prepare(`
    INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', 999999, ?, ?, -500, 'EUR', 'geloeschte Ausgabe', ?)
  `).run(TRIP, ME, ALEX, ALEX).lastInsertRowid;
  const orphanPayer = database.prepare(`
    INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', 999999, ?, NULL, 500, 'EUR', 'geloeschte Ausgabe', ?)
  `).run(TRIP, ALEX, ALEX).lastInsertRowid;
  try {
    const tile = comparable((await splitBalanceOf(ME)).positions);
    const module = comparable(await modulePositionsOf(ME, [TRIP, FLAT]));
    assert.deepEqual(tile, module, 'die Kachel darf keine zweite Wahrheit neben dem Modul fuehren');
    assert.equal(tile.find((p) => p.groupId === TRIP).amountMinor, 1800, 'beide zaehlen dieselbe Zeile');
  } finally {
    database.prepare('DELETE FROM expense_ledger_entries WHERE id IN (?, ?)').run(orphan, orphanPayer);
  }
});

test('Fremdwaehrung: Haushaltswaehrung zuerst, Betrag in der ISO-Skala der Waehrung', async () => {
  const yen = seedGroup('Japan', [ME, ALEX], { currency: 'JPY' });
  await as(ALEX, () => addExpense(yen, ALEX, '1235', [ME], { currency: 'JPY' }));
  const balance = await splitBalanceOf(ME);
  assert.deepEqual(balance.positions.map((p) => [p.currency, p.amount]), [
    ['EUR', '15.00'], ['EUR', '13.00'], ['JPY', '1235'],
  ], 'Betraege verschiedener Waehrungen sind nicht vergleichbar - die Haushaltswaehrung fuehrt');
  assert.deepEqual(balance.net.find((n) => n.currency === 'JPY'), { currency: 'JPY', netMinor: -1235, amount: '-1235' });
  await as(ME, () => settle(yen, ME, ALEX, '1235', 'JPY'));
  assert.ok(!(await splitBalanceOf(ME)).positions.some((p) => p.currency === 'JPY'), 'ausgeglichen verschwindet die Position');
});

// --------------------------------------------------------------------------
// Rechte
// --------------------------------------------------------------------------

test('Rechte: budget none -> leer, budget read -> sichtbar', async () => {
  try {
    setModuleAccess(ME, 'budget', 'none');
    assert.deepEqual(await splitBalanceOf(ME), { net: [], positions: [] }, 'ohne Budget-Recht keine Salden auf der Leitung');
    setModuleAccess(ME, 'budget', 'read');
    assert.equal((await splitBalanceOf(ME)).positions.length, 2, 'Nur-lesen darf die Salden sehen');
  } finally {
    clearModuleAccess(ME);
  }
});

test('Rechte: ein Token ohne budget:read bekommt die leere Form', async () => {
  try {
    tokenScopes = ['dashboard:read'];
    assert.deepEqual(await splitBalanceOf(ME), { net: [], positions: [] });
    tokenScopes = ['dashboard:read', 'budget:read'];
    assert.equal((await splitBalanceOf(ME)).positions.length, 2);
  } finally {
    tokenScopes = null;
  }
});

test('Sichtbarkeit: jeder sieht nur seine eigenen Positionen', async () => {
  const alex = await splitBalanceOf(ALEX);
  // Alex: Bea schuldet ihm 50,00 (Gruppe ohne mich), ich schulde ihm 13,00 (Urlaub).
  assert.deepEqual(alex.positions.map((p) => [p.direction, p.name, p.amount]), [
    ['owed', 'Bea', '50.00'], ['owed', 'Linda', '13.00'],
  ]);
  assert.ok(!alex.positions.some((p) => p.groupId === FLAT), 'die WG, in der Alex nicht ist, bleibt draussen');
});

test('ausgeglichen: keine Positionen, kein Netto', async () => {
  await as(ME, () => settle(TRIP, ME, ALEX, '13.00'));
  await as(BEA, () => settle(FLAT, BEA, ME, '15.00'));
  assert.deepEqual(await splitBalanceOf(ME), { net: [], positions: [] });
});

// --------------------------------------------------------------------------
// Browser: Registrierung, Kachel, Formatierung
// --------------------------------------------------------------------------

const BASE_DATA = {
  // Eine zweite Kachel, damit die Reihe ueberhaupt steht (unter zwei Kacheln
  // blendet sie sich aus).
  rewards: { standings: [{ display_name: 'Leo', balance: 60 }] },
};

async function dashboardTest() {
  globalThis.window = { yuvomi: { isModuleDisabled: () => false } };
  return (await import('../public/pages/dashboard.js')).__test;
}

function splitTile(tiles) {
  return tiles.find((tile) => tile.id === 'split-expenses');
}

const nbsp = (text) => String(text).replace(/\s/g, ' ');

test('Registrierung: die Kennzahlreihe kennt die geteilten Ausgaben', async () => {
  const __test = await dashboardTest();
  assert.ok(__test.METRIC_TILE_ORDER.includes('split-expenses'));
  // Direkt hinter dem Budget: Geld zu Geld, und vor den Opt-in-Modulen, damit
  // eine offene Forderung nicht hinter einem Punktestand verschwindet.
  assert.equal(__test.METRIC_TILE_ORDER.indexOf('split-expenses'), __test.METRIC_TILE_ORDER.indexOf('budget') + 1);
});

test('Kachel: Netto als Wert, groesste Position plus Rest als Fussnote, Sprung in die Ausgleichs-Ansicht', async () => {
  const __test = await dashboardTest();
  const tile = splitTile(__test.selectMetricTiles({
    ...BASE_DATA,
    splitBalance: {
      net: [{ currency: 'EUR', netMinor: 200, amount: '2.00' }],
      positions: [
        { direction: 'owed', userId: 3, name: 'Bea', groupId: 7, groupName: 'WG', currency: 'EUR', amountMinor: 1500, amount: '15.00' },
        { direction: 'owe', userId: 2, name: 'Alex', groupId: 4, groupName: 'Urlaub', currency: 'EUR', amountMinor: 1300, amount: '13.00' },
      ],
    },
  }, 'EUR', new Set()));
  assert.ok(tile, 'mit offenen Positionen steht die Kachel in der Reihe');
  assert.equal(nbsp(tile.value), '2,00 €');
  assert.equal(tile.tone, 'balance-positive');
  assert.equal(tile.note, 'dashboard.splitOwesYou{"name":"Bea"} · +1');
  assert.equal(tile.route, '/budget?tab=split-expenses&group=7');
});

test('Kachel: wer schuldet, sieht ein Minus in Rot', async () => {
  const __test = await dashboardTest();
  const tile = splitTile(__test.selectMetricTiles({
    ...BASE_DATA,
    splitBalance: {
      net: [{ currency: 'EUR', netMinor: -1300, amount: '-13.00' }],
      positions: [{ direction: 'owe', userId: 2, name: 'Alex', groupId: 4, groupName: 'Urlaub', currency: 'EUR', amountMinor: 1300, amount: '13.00' }],
    },
  }, 'EUR', new Set()));
  assert.equal(nbsp(tile.value), '-13,00 €');
  assert.equal(tile.tone, 'balance-negative');
  assert.equal(tile.note, 'dashboard.splitYouOwe{"name":"Alex"}', 'eine einzige Position traegt kein „+0"');
});

test('Kachel: ausgeglichen, gesperrt oder abgeschaltet -> keine Kachel', async () => {
  const __test = await dashboardTest();
  const settled = __test.selectMetricTiles({ ...BASE_DATA, splitBalance: { net: [], positions: [] } }, 'EUR', new Set());
  assert.equal(splitTile(settled), undefined, 'ausgeglichen braucht keine Handlung - die Kachel macht Platz');
  const missing = __test.selectMetricTiles({ ...BASE_DATA }, 'EUR', new Set());
  assert.equal(splitTile(missing), undefined, 'ohne Feld (aelterer Server) keine Kachel');

  const open = {
    ...BASE_DATA,
    splitBalance: {
      net: [{ currency: 'EUR', netMinor: -1300, amount: '-13.00' }],
      positions: [{ direction: 'owe', userId: 2, name: 'Alex', groupId: 4, groupName: 'Urlaub', currency: 'EUR', amountMinor: 1300, amount: '13.00' }],
    },
  };
  const previous = globalThis.window;
  try {
    globalThis.window = { yuvomi: { isModuleDisabled: (m) => m === 'budget' } };
    assert.equal(splitTile(__test.selectMetricTiles(open, 'EUR', new Set())), undefined,
      'abgeschaltetes Budget-Modul nimmt die geteilten Ausgaben mit');
  } finally {
    globalThis.window = previous;
  }
});

test('Formatierung: Nachkommastellen nach ISO 4217 (0, 2, 3), nicht nach CLDR', async () => {
  const __test = await dashboardTest();
  const valueFor = (currency, amount, netMinor) => nbsp(splitTile(__test.selectMetricTiles({
    ...BASE_DATA,
    splitBalance: {
      net: [{ currency, netMinor, amount }],
      positions: [{ direction: 'owed', userId: 3, name: 'Bea', groupId: 7, groupName: 'WG', currency, amountMinor: Math.abs(netMinor), amount }],
    },
  }, 'EUR', new Set())).value);
  assert.equal(valueFor('JPY', '1235', 1235), '1.235 ¥', 'JPY: keine Nachkommastellen');
  assert.equal(valueFor('KWD', '12.345', 12345), '12,345 KWD', 'KWD: drei Nachkommastellen');
  // HUF: ISO 4217 sagt zwei, der CLDR zeigt keine - der Server rechnet in der
  // ISO-Skala, und 12,50 als „13" zu zeigen waere eine erfundene Rundung.
  assert.equal(valueFor('HUF', '12.50', 1250), '12,50 HUF', 'HUF: zwei Stellen nach ISO');
  assert.equal(valueFor('EUR', '1234.50', 123450), '1.234,50 €', 'ab 1000 bleiben die Cent - ein Saldo ist ein Kontostand');
});

// --------------------------------------------------------------------------
// Sprungziel: /budget?tab=split-expenses&group=N oeffnet die Ausgleichs-Ansicht
// --------------------------------------------------------------------------

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

test('Sprungziel: das Budget oeffnet den Reiter aus ?tab=, und nur einen, den es gibt', async () => {
  const { __test: budget } = await import('../public/pages/budget.js');
  assert.equal(budget.tabFromQuery('?tab=split-expenses&group=7'), 'split-expenses');
  assert.equal(budget.tabFromQuery('?tab=subscriptions'), 'subscriptions');
  assert.equal(budget.tabFromQuery('?tab=__proto__'), null, 'ein unbekannter Reiter faellt auf den bisherigen zurueck');
  assert.equal(budget.tabFromQuery(''), null);
});

test('Sprungziel: die geteilten Ausgaben waehlen die Gruppe aus ?group=, wenn der Betrachter sie hat', async () => {
  const { __test: split } = await import('../public/pages/split-expenses.js');
  const groups = [{ id: 3 }, { id: 7 }];
  assert.equal(split.groupFromQuery('?tab=split-expenses&group=7', groups), 7);
  assert.equal(split.groupFromQuery('?group=99', groups), null, 'eine fremde oder archivierte Gruppe wird nicht erraten');
  assert.equal(split.groupFromQuery('', groups), null);
});

/* Review #1450: das Netto summiert ueber alle Gruppen und laesst eine Waehrung
 * mit Summe 0 weg, die Positionen bleiben je Gruppe stehen. Die Kachel hing
 * nur an den Positionen und fiel ohne passendes Netto auf "0" zurueck - also
 * "0,00 €" neben "Du schuldest Alex", oder ein offenes Netto in einer anderen
 * Waehrung blieb versteckt. */
const pos = (direction, name, groupId, currency, amountMinor) => ({
  direction, userId: groupId, name, groupId, groupName: `G${groupId}`, currency, amountMinor,
  amount: (amountMinor / 100).toFixed(2),
});

test('Kachel: gleicht sich das Netto ueber Gruppen aus, gibt es keine Kachel - nie "0,00"', async () => {
  const __test = await dashboardTest();
  const tile = splitTile(__test.selectMetricTiles({
    ...BASE_DATA,
    splitBalance: { net: [], positions: [pos('owe', 'Alex', 4, 'EUR', 5000), pos('owed', 'Bob', 7, 'EUR', 5000)] },
  }, 'EUR', new Set()));
  assert.equal(tile, undefined, `insgesamt ausgeglichen ist die Regel "ausgeglichen, keine Kachel" - erhalten: ${tile && nbsp(tile.value)}`);
});

test('Kachel: Wert und Position kommen aus der Waehrung, in der wirklich etwas offen ist', async () => {
  const __test = await dashboardTest();
  const tile = splitTile(__test.selectMetricTiles({
    ...BASE_DATA,
    splitBalance: {
      net: [{ currency: 'USD', netMinor: -2000, amount: '-20.00' }],
      positions: [pos('owe', 'Alex', 4, 'EUR', 5000), pos('owed', 'Bob', 7, 'EUR', 5000), pos('owe', 'Cleo', 9, 'USD', 2000)],
    },
  }, 'EUR', new Set()));
  assert.ok(tile, 'das offene USD-Netto bekommt eine Kachel');
  assert.match(nbsp(tile.value), /-20,00/, `der Wert ist das offene Netto, nicht "0": ${nbsp(tile.value)}`);
  assert.equal(tile.tone, 'balance-negative');
  assert.match(tile.note, /Cleo/, 'die genannte Position gehoert zur Waehrung des Werts');
  assert.equal(tile.route, '/budget?tab=split-expenses&group=9');
});

// --------------------------------------------------------------------------
// Aequivalenz: Kachel-Netto == Kennzahlband des Moduls (GET /split-expenses/dashboard)
// --------------------------------------------------------------------------
//
// Das Kennzahlband des Moduls ("Du bekommst" / "Du schuldest") summiert in
// einer eigenen Abfrage ueber alle aktiven Gruppen des Betrachters, die Kachel
// geht ueber `openBalancesForUser()` -> `groupBalanceRows()` je Gruppe. Beide
// sind dieselbe Summe (je Waehrung die Ledger-Zeilen des Betrachters in seinen
// aktiven Gruppen); der Test haelt fest, dass das auch auf einem Datensatz mit
// allen bekannten Sonderfaellen gilt, damit eine Aenderung an EINER der beiden
// Stellen hier rot wird statt still eine zweite Zahl zu zeigen.

async function moduleNetOf(userId) {
  return as(userId, async () => {
    const { data } = await getJson('/split-expenses/dashboard');
    const out = new Map();
    for (const row of data.total_owed) out.set(row.currency, (out.get(row.currency) ?? 0) + row.amount_minor);
    for (const row of data.total_owing) out.set(row.currency, (out.get(row.currency) ?? 0) - row.amount_minor);
    return [...out.entries()].filter(([, minor]) => minor !== 0).sort(([a], [b]) => a.localeCompare(b));
  });
}

async function tileNetOf(userId) {
  return (await splitBalanceOf(userId)).net
    .map(({ currency, netMinor }) => [currency, netMinor])
    .sort(([a], [b]) => a.localeCompare(b));
}

async function deleteJson(path) {
  const response = await fetch(`${base}${path}`, { method: 'DELETE' });
  assert.equal(response.status, 200, `DELETE ${path}`);
}

test('Aequivalenz: Kachel-Netto und Kennzahlband des Moduls sind dieselbe Summe, fuer jeden Betrachter', async () => {
  const CLEO = seedUser('Cleo');
  const SWAP = seedGroup('Ausgleich ueber Gruppen', [ME, ALEX, CLEO]);
  const USD = seedGroup('USA', [ME, BEA, CLEO], { currency: 'USD' });
  const KWD = seedGroup('Kuwait', [ALEX, ME], { currency: 'KWD' });
  const LEFT = seedGroup('Ausgetreten', [ALEX, CLEO]);

  // Geloeschte Ausgabe: ihre Ledger-Zeilen fallen mit ihr.
  const gone = await as(ME, () => addExpense(SWAP, ME, '90.00', [ME, ALEX, CLEO]));
  await as(ME, () => deleteJson(`/split-expenses/expenses/${gone.data.id}`));
  // Offene Ausgabe mit Rest-Cent (Aufteilung 100,00 / 3).
  await as(ALEX, () => addExpense(SWAP, ALEX, '100.00', [ME, ALEX, CLEO]));
  // Zahlung und ihr Storno (Gegenbuchung) - danach wieder offen.
  const paid = await as(ME, () => settle(SWAP, ME, ALEX, '20.00'));
  await as(ME, async () => {
    const response = await fetch(`${base}/split-expenses/groups/${SWAP}/settlements/${paid.data.id}/reverse`, { method: 'POST' });
    assert.equal(response.status, 200, 'Storno');
  });
  // Eine Zahlung, die stehen bleibt.
  await as(CLEO, () => settle(SWAP, CLEO, ALEX, '10.00'));
  // Fremdwaehrungen mit 2 und 3 Nachkommastellen.
  await as(BEA, () => addExpense(USD, BEA, '75.50', [ME, BEA, CLEO], { currency: 'USD' }));
  await as(ALEX, () => addExpense(KWD, ALEX, '12.345', [ME, ALEX], { currency: 'KWD' }));
  // Ein Mitglied, das mit offenem Saldo aus der Gruppe entfernt wurde: seine
  // Zeilen bleiben im Ledger, zaehlen fuer ihn aber an keiner der beiden Stellen.
  await as(CLEO, () => addExpense(LEFT, CLEO, '40.00', [ALEX, CLEO]));
  await as(ALEX, () => deleteJson(`/split-expenses/groups/${LEFT}/members/${CLEO}`));
  // Archivierte Gruppe mit offenem Saldo (ARCHIVED aus dem Test oben) bleibt aussen vor.

  for (const [name, uid] of [['Linda', ME], ['Alex', ALEX], ['Bea', BEA], ['Cleo', CLEO]]) {
    const tile = await tileNetOf(uid);
    const module = await moduleNetOf(uid);
    assert.deepEqual(tile, module, `${name}: Kachel ${JSON.stringify(tile)} vs Modul ${JSON.stringify(module)}`);
  }
  // Der Datensatz darf nicht trivial ausgeglichen sein - sonst misst die
  // Gleichheit nur zwei leere Listen.
  assert.ok((await tileNetOf(ME)).length >= 2, 'Linda hat in mehreren Waehrungen etwas offen');
  assert.ok((await tileNetOf(CLEO)).length >= 1, 'Cleo hat etwas offen');
});
