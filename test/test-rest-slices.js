/**
 * Module: the last blocks of GET /dashboard as slices (phase 2, section D, contract E10)
 * Purpose: holds the contract of the split balance slice (server/services/budget-slices.ts),
 *          the waste slice (server/services/waste-slices.ts) and the two blocks the
 *          route runs itself under runSlice() (quick links, pantry):
 *
 *          1. THE SPLIT BALANCE. The viewer's open balances (`options.userId`), the
 *             household currency first; the currency comes from sync_config, `EUR`
 *             when no row is set. A failing currency read empties only this block.
 *          2. THE PICKUP WINDOW. Today and tomorrow of `ctx.today` - yesterday and the
 *             day after stay outside - and only the six fields a row needs. Neither
 *             slice reads a clock.
 *          3. ONE FORM. The empty forms are fresh objects in the route's key order.
 *          4. ISOLATION. Each block fails alone to its old failure value under its old
 *             name (`split balance`, `wastePickups`, `quick links`, `pantryExpiring`)
 *             and logs `<name> error:`; the pantry block fails to `null`, NOT to its
 *             empty form. Without a guard a slice throws.
 *          5. THE ROUTE. The keys stand at their old places of the answer, in
 *             success, failure and the denied form; the route hands in the viewer
 *             and the admin flag.
 *
 *          The whole GET /dashboard answer is held byte for byte by
 *          test:overview-golden; this suite holds what that one cannot see.
 *
 * Run: npm run test:rest-slices
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// @ts-expect-error express 5 ships no type declarations (TS7016); new code type-checks clean
import express from 'express';

// 10:30 in Berlin on 2026-03-11: the route reads this clock once.
const FROZEN_NOW = Date.parse('2026-03-11T09:30:00.000Z');
mock.timers.enable({ apis: ['Date'], now: FROZEN_NOW });

// The production driver, migrated by server/db.js itself, in memory.
process.env.DB_PATH = ':memory:';

const { get } = await import('../server/db.js');
const { personReader } = await import('../server/authorize/index.ts');
const { resolveRequestModuleAccess } = await import('../server/authorize/actor.ts');
const { emptySplitBalanceOverview, splitBalanceOverviewSlice } = await import('../server/services/budget-slices.ts');
const { emptyWasteOverview, wasteOverviewSlice } = await import('../server/services/waste-slices.ts');
const { emptyPantryExpiring } = await import('../server/services/pantry-expiring.js');
const { sliceRunner } = await import('../server/services/slice-runner.ts');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

const db = get();

db.prepare(`
  INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();
db.prepare("DELETE FROM sync_config WHERE key = 'currency'").run();
// Every module switched on (a fresh household leaves waste and schedule off).
db.prepare(`
  INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();

/** @param {string} username @param {string} name @param {string} role */
function addUser(username, name, role) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', ?, 'parent')
  `).run(username, name, role).lastInsertRowid);
}
const ANNA = addUser('rest-anna', 'Anna', 'admin');
const BEN = addUser('rest-ben', 'Ben', 'member');
const CARL = addUser('rest-carl', 'Carl', 'member');

// ---- Split expenses -------------------------------------------------------------
/** @param {string} name @param {string} currency @param {number[]} members */
function addGroup(name, currency, members) {
  const id = Number(db.prepare(`
    INSERT INTO expense_groups (name, type, default_currency, created_by) VALUES (?, 'general', ?, ?)
  `).run(name, currency, members[0]).lastInsertRowid);
  for (const user of members) {
    db.prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)')
      .run(id, user, user === members[0] ? 'owner' : 'admin', members[0]);
  }
  return id;
}
/**
 * Anna owes Ben `minor` in `currency` within `group`.
 * @param {number} group @param {number} minor @param {string} currency
 */
function annaOwesBen(group, minor, currency) {
  const insert = db.prepare(`
    INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', 1, ?, ?, ?, ?, 'seed', ?)
  `);
  insert.run(group, ANNA, BEN, -minor, currency, BEN);
  insert.run(group, BEN, null, minor, currency, BEN);
}
const TRIP = addGroup('Trip', 'EUR', [ANNA, BEN]);
const NEW_YORK = addGroup('New York', 'USD', [ANNA, BEN]);
annaOwesBen(TRIP, 500, 'EUR');
annaOwesBen(NEW_YORK, 300, 'USD');

// ---- Waste ------------------------------------------------------------------------
const WASTE_TYPE = Number(db.prepare(`
  INSERT INTO waste_types (name, icon, color, created_by) VALUES ('Paper', 'trash-2', '#2563EB', ?)
`).run(ANNA).lastInsertRowid);
for (const day of ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13']) {
  db.prepare('INSERT INTO waste_one_off_pickups (type_id, date, created_by) VALUES (?, ?, ?)').run(WASTE_TYPE, day, ANNA);
}

// ---- Quick links: Ben's shared link, editable by Anna only as admin ------------------
db.prepare(`
  INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('Wiki', 'https://wiki.example/', 'all', ?, 0)
`).run(BEN);

// ---- Pantry -----------------------------------------------------------------------
db.prepare("INSERT INTO pantry_items (name, quantity, unit, expires_on) VALUES ('Milk', 1, 'l', '2026-03-11')").run();

const CTX = Object.freeze({ today: '2026-03-11', zone: 'Europe/Berlin', now: new Date(FROZEN_NOW) });
const anna = personReader(ANNA);
const WASTE_FIELDS = ['date_key', 'type_id', 'type_name', 'type_icon', 'type_color', 'deep_link'];

/** A logger that keeps what runSlice() writes. */
function capturingLog() {
  /** @type {unknown[][]} */
  const lines = [];
  return { lines, error: (/** @type {unknown[]} */ ...args) => { lines.push(args); } };
}

/**
 * Runs `fn` while every reading of the system clock throws. A Date WITH an argument
 * stays possible: that is a conversion, not a clock.
 * @template T @param {() => T} fn @returns {T}
 */
function withoutClock(fn) {
  const RealDate = globalThis.Date;
  class NoClock extends RealDate {
    /** @param {...any} args */
    constructor(...args) {
      if (args.length === 0) throw new Error('a slice read the clock (new Date())');
      super(.../** @type {[any]} */ (args));
    }
    /** @returns {number} */
    static now() { throw new Error('a slice read the clock (Date.now())'); }
  }
  globalThis.Date = /** @type {DateConstructor} */ (/** @type {unknown} */ (NoClock));
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** @param {{ positions: { currency: string, amountMinor: number, direction: string }[] }} balance */
const positionsOf = (balance) => balance.positions.map((p) => [p.currency, p.direction, p.amountMinor]);

// ---- 1. The split balance ------------------------------------------------------------

test('split balance: the viewer\'s open positions, the default household currency EUR first', () => {
  const { splitBalance } = withoutClock(() => splitBalanceOverviewSlice(db, anna, CTX, { userId: ANNA }));
  assert.deepEqual(positionsOf(splitBalance), [['EUR', 'owe', 500], ['USD', 'owe', 300]]);
  assert.deepEqual(splitBalance.net.map((n) => n.currency), ['EUR', 'USD']);
  assert.equal(splitBalance.positions[0].name, 'Ben');
  assert.equal(splitBalance.positions[0].groupName, 'Trip');
});

test('split balance: the household currency from sync_config comes first', () => {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('currency', 'USD')").run();
  try {
    const { splitBalance } = splitBalanceOverviewSlice(db, anna, CTX, { userId: ANNA });
    assert.deepEqual(positionsOf(splitBalance), [['USD', 'owe', 300], ['EUR', 'owe', 500]]);
    assert.deepEqual(splitBalance.net.map((n) => n.currency), ['USD', 'EUR']);
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'currency'").run();
  }
});

test('split balance: the balances are the viewer\'s (options.userId), not the reader\'s', () => {
  const ben = splitBalanceOverviewSlice(db, anna, CTX, { userId: BEN }).splitBalance;
  assert.deepEqual(positionsOf(ben), [['EUR', 'owed', 500], ['USD', 'owed', 300]]);
  assert.deepEqual(splitBalanceOverviewSlice(db, anna, CTX, { userId: CARL }), emptySplitBalanceOverview(),
    'outside every group nothing is open');
});

test('split balance: a failing currency read empties only this block, under its old name', () => {
  const currencyBroken = {
    /** @param {string} sql */
    prepare(sql) {
      if (sql.includes("key = 'currency'")) throw new Error('currency boom');
      return db.prepare(sql);
    },
    exec() {},
  };
  const log = capturingLog();
  const failed = splitBalanceOverviewSlice(currencyBroken, anna, CTX, { userId: ANNA }, sliceRunner(log));
  assert.deepEqual(failed, { splitBalance: { net: [], positions: [] } });
  assert.deepEqual(Object.keys(failed.splitBalance), ['net', 'positions'], 'the failure value in the old key order');
  assert.deepEqual(log.lines, [['split balance error:', 'currency boom']]);
  assert.throws(() => splitBalanceOverviewSlice(currencyBroken, anna, CTX, { userId: ANNA }), /currency boom/,
    'without a guard a failing read throws');

  // The balance read itself fails the same way.
  const ledgerBroken = {
    /** @param {string} sql */
    prepare(sql) {
      if (sql.includes('expense_groups')) throw new Error('ledger boom');
      return db.prepare(sql);
    },
    exec() {},
  };
  const ledgerLog = capturingLog();
  assert.deepEqual(splitBalanceOverviewSlice(ledgerBroken, anna, CTX, { userId: ANNA }, sliceRunner(ledgerLog)),
    emptySplitBalanceOverview());
  assert.deepEqual(ledgerLog.lines, [['split balance error:', 'ledger boom']]);
});

// ---- 2. The pickup window ------------------------------------------------------------

test('waste: today and tomorrow of ctx.today, yesterday and the day after stay outside', () => {
  const { wastePickups } = withoutClock(() => wasteOverviewSlice(db, anna, CTX));
  assert.deepEqual(wastePickups.map((p) => p.date_key), ['2026-03-11', '2026-03-12']);
  // The day comes from ctx, not from a clock.
  const later = wasteOverviewSlice(db, anna, { ...CTX, today: '2026-03-12' });
  assert.deepEqual(later.wastePickups.map((p) => p.date_key), ['2026-03-12', '2026-03-13']);
});

test('waste: only the six fields a row needs, in their order', () => {
  const { wastePickups } = wasteOverviewSlice(db, anna, CTX);
  for (const pickup of wastePickups) assert.deepEqual(Object.keys(pickup), WASTE_FIELDS);
  assert.deepEqual(wastePickups[0], {
    date_key: '2026-03-11',
    type_id: WASTE_TYPE,
    type_name: 'Paper',
    type_icon: 'trash-2',
    type_color: '#2563EB',
    deep_link: wastePickups[0].deep_link,
  });
  assert.equal(typeof wastePickups[0].deep_link, 'string');
});

test('waste: a failing read empties only this block, under its old name', () => {
  const broken = { prepare() { throw new Error('no such table: boom'); }, exec() {} };
  const log = capturingLog();
  assert.deepEqual(wasteOverviewSlice(broken, anna, CTX, {}, sliceRunner(log)), { wastePickups: [] });
  assert.deepEqual(log.lines, [['wastePickups error:', 'no such table: boom']]);
  assert.throws(() => wasteOverviewSlice(broken, anna, CTX), /no such table/, 'without a guard a failing read throws');
});

// ---- 3. One form ---------------------------------------------------------------------

test('the empty forms are fresh objects in the route\'s key order', () => {
  assert.deepEqual(emptySplitBalanceOverview(), { splitBalance: { net: [], positions: [] } });
  assert.deepEqual(Object.keys(emptySplitBalanceOverview().splitBalance), ['net', 'positions']);
  assert.notEqual(emptySplitBalanceOverview().splitBalance, emptySplitBalanceOverview().splitBalance);
  assert.deepEqual(emptyWasteOverview(), { wastePickups: [] });
  assert.notEqual(emptyWasteOverview().wastePickups, emptyWasteOverview().wastePickups);
});

// ---- 4./5. The route ---------------------------------------------------------------

let viewer = ANNA;
/** @type {string[] | null} */
let tokenScopes = null;
const app = express();
app.use((/** @type {any} */ req, /** @type {unknown} */ _res, /** @type {() => void} */ next) => {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(viewer);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.authMethod = tokenScopes ? 'api_token' : 'session';
  req.session = { userId: user.id, role: user.role };
  // What requireAuth does: hand the connection to the actor and resolve the modules.
  req.sessionModuleAccess = resolveRequestModuleAccess(db, req);
  req.authScopes = tokenScopes;
  next();
});
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const endpoint = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/`;

test.after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  db.close();
  mock.timers.reset();
});

async function dashboard() {
  const res = await fetch(endpoint);
  assert.equal(res.status, 200);
  return res.json();
}

/**
 * The keys around the moved blocks, in the order they stand in the answer.
 * @param {Record<string, unknown>} body
 */
function neighbourhood(body) {
  const keys = Object.keys(body);
  const at = (/** @type {string} */ key) => keys.indexOf(key);
  return { keys, at };
}

/**
 * Captures what the route logs through console.error while `fn` runs.
 * @param {() => Promise<void>} fn
 */
async function routeLog(fn) {
  /** @type {unknown[][]} */
  const lines = [];
  const spy = mock.method(console, 'error', (/** @type {unknown[]} */ ...args) => { lines.push(args); });
  try {
    await fn();
  } finally {
    spy.mock.restore();
  }
  return lines;
}

test('route: the moved keys stand at their old places of the answer', async () => {
  const body = await dashboard();
  const { at } = neighbourhood(body);
  // budget, then the split balance, then the rewards.
  assert.equal(at('splitBalance'), at('budget') + 1);
  assert.equal(at('rewards'), at('splitBalance') + 1);
  // quick links after the countdowns and before the budget.
  assert.ok(at('countdownTotal') < at('quicklinks') && at('quicklinks') < at('budget'));
  // waste after the housekeeping block, before the own shift; pantry after the shift.
  assert.equal(at('wastePickups'), at('housekeeping') + 1);
  assert.equal(at('myShiftsToday'), at('wastePickups') + 1);
  assert.equal(at('pantryExpiring'), at('myShiftsToday') + 1);
  assert.deepEqual(body.wastePickups.map((/** @type {{ date_key: string }} */ p) => p.date_key), ['2026-03-11', '2026-03-12']);
  assert.deepEqual(body.splitBalance.positions.map((/** @type {{ currency: string }} */ p) => p.currency), ['EUR', 'USD']);
  assert.equal(body.pantryExpiring.todayItems[0].name, 'Milk');
});

test('route: the viewer and the admin flag reach their blocks', async () => {
  const asAnna = await dashboard();
  assert.equal(asAnna.quicklinks.length, 1);
  assert.equal(asAnna.quicklinks[0].can_edit, true, 'an admin may edit Ben\'s shared link');
  assert.equal(asAnna.splitBalance.positions[0].direction, 'owe');
  viewer = BEN;
  try {
    const asBen = await dashboard();
    assert.equal(asBen.splitBalance.positions[0].direction, 'owed', 'the balance is the viewer\'s');
    assert.equal(asBen.quicklinks[0].can_edit, true, 'the owner may edit');
  } finally {
    viewer = ANNA;
  }
  viewer = CARL;
  try {
    const asCarl = await dashboard();
    assert.equal(asCarl.quicklinks[0].can_edit, false, 'a member may not edit another\'s link');
    assert.deepEqual(asCarl.splitBalance, { net: [], positions: [] });
  } finally {
    viewer = ANNA;
  }
});

test('route: quick links fail to [] under `quick links`, the rest stays', async () => {
  db.exec('ALTER TABLE quick_links RENAME TO quick_links_away');
  try {
    /** @type {any} */
    let body;
    const lines = await routeLog(async () => { body = await dashboard(); });
    assert.deepEqual(body.quicklinks, []);
    const { at } = neighbourhood(body);
    assert.ok(at('countdownTotal') < at('quicklinks') && at('quicklinks') < at('budget'), 'the key keeps its place');
    assert.ok(Array.isArray(body.users) && body.users.length > 0);
    assert.deepEqual(lines.map((line) => [line[0], line[1]]), [['[Dashboard]', 'quick links error:']]);
  } finally {
    db.exec('ALTER TABLE quick_links_away RENAME TO quick_links');
  }
});

test('route: the pantry block fails to null, not to its empty form', async () => {
  db.exec('ALTER TABLE pantry_items RENAME TO pantry_items_away');
  try {
    /** @type {any} */
    let body;
    const lines = await routeLog(async () => { body = await dashboard(); });
    assert.equal(body.pantryExpiring, null);
    const { at } = neighbourhood(body);
    assert.equal(at('pantryExpiring'), at('myShiftsToday') + 1, 'the key keeps its place');
    assert.deepEqual(lines.map((line) => [line[0], line[1]]), [['[Dashboard]', 'pantryExpiring error:']]);
  } finally {
    db.exec('ALTER TABLE pantry_items_away RENAME TO pantry_items');
  }
});

test('route: split balance and waste fail alone, at their places', async () => {
  db.exec('ALTER TABLE expense_groups RENAME TO expense_groups_away');
  db.exec('ALTER TABLE waste_one_off_pickups RENAME TO waste_one_off_pickups_away');
  try {
    /** @type {any} */
    let body;
    const lines = await routeLog(async () => { body = await dashboard(); });
    assert.deepEqual(body.splitBalance, { net: [], positions: [] });
    assert.deepEqual(body.wastePickups, []);
    const { at } = neighbourhood(body);
    assert.equal(at('splitBalance'), at('budget') + 1);
    assert.equal(at('myShiftsToday'), at('wastePickups') + 1);
    assert.deepEqual(lines.map((line) => [line[0], line[1]]),
      [['[Dashboard]', 'split balance error:'], ['[Dashboard]', 'wastePickups error:']]);
  } finally {
    db.exec('ALTER TABLE expense_groups_away RENAME TO expense_groups');
    db.exec('ALTER TABLE waste_one_off_pickups_away RENAME TO waste_one_off_pickups');
  }
});

test('route: a token without the modules gets the empty forms at the old places', async () => {
  tokenScopes = ['dashboard:read'];
  try {
    const body = await dashboard();
    assert.deepEqual(body.splitBalance, { net: [], positions: [] });
    assert.deepEqual(body.wastePickups, []);
    assert.deepEqual(body.pantryExpiring, emptyPantryExpiring());
    const { at } = neighbourhood(body);
    assert.equal(at('splitBalance'), at('budget') + 1, 'in DENIED_PAYLOAD.budget after the budget');
  } finally {
    tokenScopes = null;
  }
});
