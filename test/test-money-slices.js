/**
 * Module: budget and rewards overview slices (phase 2, section D, contract E10)
 * Purpose: holds the contract of server/services/budget-slices.ts and
 *          server/services/rewards-slices.ts, as test:notes-birthdays-slices does
 *          for notes and birthdays:
 *
 *          1. NO CLOCK. Every reading of the system clock (Date.now(), new Date()
 *             without an argument) throws while the slices run; the month of the
 *             budget comes in `options`, two months answer two sums.
 *          2. ONE FORM. emptyBudgetOverview()/emptyRewardsOverview() carry exactly
 *             the keys of a successful slice in the route's order; the failure
 *             values are what the route's old catch wrote (budget without
 *             `savingsGoal`, rewards without `me`).
 *          3. ISOLATION. Through the slice, a failing read answers its failure
 *             value under its old name and logs `<name> error:`; without a guard
 *             a failure throws. A missing budget_plans table only drops the goal.
 *
 *          The whole GET /dashboard answer is held byte for byte by
 *          test:overview-golden; this suite holds what that one cannot see.
 *
 * Run: npm run test:money-slices
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The production driver, migrated by server/db.js itself, in memory.
process.env.DB_PATH = ':memory:';

const { get } = await import('../server/db.js');
const { personReader } = await import('../server/authorize/index.ts');
const {
  budgetBlockFailed, budgetOverviewSlice, emptyBudgetOverview,
} = await import('../server/services/budget-slices.ts');
const {
  emptyRewardsOverview, rewardsOverviewSlice, REWARDS_BLOCK_FAILED,
} = await import('../server/services/rewards-slices.ts');
const { sliceRunner } = await import('../server/services/slice-runner.ts');

const db = get();
test.after(() => db.close());

/** @param {string} username @param {string} name @param {string} role @param {string} familyRole */
function addUser(username, name, role, familyRole) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', ?, ?)
  `).run(username, name, role, familyRole).lastInsertRowid);
}
const ANNA = addUser('money-anna', 'Anna', 'admin', 'parent');
const BEN = addUser('money-ben', 'Ben', 'member', 'child');
const CARA = addUser('money-cara', 'Cara', 'member', 'child');
const GRAN = addUser('money-gran', 'Gran', 'member', 'parent');

// ---- Budget: March 2026 and one February entry ------------------------------
const insertEntry = db.prepare(`
  INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, is_pending)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
/** @param {number} amount @param {string} category @param {string} date @param {number} owner @param {number} [pending] */
function addEntry(amount, category, date, owner, pending = 0) {
  return Number(insertEntry.run(`entry ${category}`, amount, category, date, owner, owner, pending).lastInsertRowid);
}
addEntry(1000.5, 'salary', '2026-03-01', ANNA);
addEntry(-10, 'food', '2026-03-02', ANNA);
addEntry(-25.25, 'food', '2026-03-03', BEN);
addEntry(-40, 'housing', '2026-03-04', ANNA);
addEntry(-5, 'leisure', '2026-03-05', ANNA);
addEntry(-7, 'education', '2026-03-06', ANNA);
addEntry(-3, 'transport', '2026-03-07', ANNA);
addEntry(-1, 'clothing', '2026-03-31', ANNA);
// Pending and transfer rows count nowhere.
addEntry(-999, 'pending', '2026-03-08', ANNA, 1);
const transferOut = addEntry(-500, 'transfer', '2026-03-09', ANNA);
const transferIn = addEntry(500, 'transfer', '2026-03-09', ANNA);
db.prepare('UPDATE budget_entries SET transfer_entry_id = ? WHERE id = ?').run(transferIn, transferOut);
db.prepare('UPDATE budget_entries SET transfer_entry_id = ? WHERE id = ?').run(transferOut, transferIn);
addEntry(-77, 'food', '2026-02-28', ANNA);
db.prepare("INSERT INTO budget_plans (category, amount, created_by) VALUES ('__savings__', 123.456, ?)").run(String(ANNA));

// ---- Rewards: Ben and Cara collect, Anna approves, Gran only looks ---------
db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(BEN);
db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(CARA);
const KINO = Number(db.prepare(`
  INSERT INTO reward_catalog (name, cost, icon, description, is_active, sort_order, created_by)
  VALUES ('Kino', 50, 'film', 'x', 1, 0, ?)
`).run(ANNA).lastInsertRowid);
const ledger = db.prepare(`
  INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
`);
ledger.run(BEN, 20, 'earn', 'ben 1', ANNA, '2026-03-01T08:00:00Z');
ledger.run(BEN, 15, 'bonus', 'ben 2', ANNA, '2026-03-02T08:00:00Z');
const taken = Number(ledger.run(BEN, 30, 'earn', 'ben taken back', ANNA, '2026-03-03T08:00:00Z').lastInsertRowid);
db.prepare(`
  INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, created_at, reverses_id)
  VALUES (?, -30, 'reversal', 'undo', ?, '2026-03-04T08:00:00Z', ?)
`).run(BEN, ANNA, taken);
ledger.run(CARA, 60, 'earn', 'cara 1', ANNA, '2026-03-01T09:00:00Z');
const redemption = db.prepare(`
  INSERT INTO reward_redemptions (user_id, reward_name, reward_icon, cost, status, kind, currency, requested_by)
  VALUES (?, ?, 'gift', ?, 'pending', ?, ?, ?)
`);
redemption.run(BEN, 'Kino', 50, 'reward', null, BEN);
redemption.run(CARA, 'Kino', 50, 'reward', null, CARA);
redemption.run(BEN, 'deposit', 300, 'deposit', 'EUR', BEN);
redemption.run(GRAN, 'withdrawal', 200, 'withdrawal', 'EUR', GRAN);

const ZONE = 'Europe/Berlin';
const CTX = Object.freeze({ today: '2026-03-11', zone: ZONE, now: new Date('2026-03-11T09:30:00.000Z') });
const anna = personReader(ANNA);

/** @param {number} me @param {boolean} admin */
const money = (me, admin) => ({ admin, display: false, me });

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

test('the slices read no clock; the budget month comes from options', () => {
  const [march, february, rewards] = withoutClock(() => [
    budgetOverviewSlice(db, anna, CTX, { month: '2026-03' }),
    budgetOverviewSlice(db, anna, CTX, { month: '2026-02' }),
    rewardsOverviewSlice(db, anna, CTX, { approver: true, moneyReader: money(ANNA, true) }),
  ]);
  assert.equal(march.budget.month, '2026-03');
  assert.equal(march.budget.entryCount, 8);
  assert.equal(february.budget.month, '2026-02');
  assert.equal(february.budget.expenses, 77);
  assert.equal(rewards.rewards.view, 'approver');
});

test('budget: sums, signs, top five by absolute amount, pending and transfers left out', () => {
  const { budget } = budgetOverviewSlice(db, anna, CTX, { month: '2026-03' });
  assert.deepEqual(budget, {
    month: '2026-03',
    income: 1000.5,
    expenses: 91.25,
    balance: 909.25,
    entryCount: 8,
    topExpenseCategory: 'housing',
    topExpenseAmount: 40,
    topExpenses: [
      { category: 'housing', amount: 40 },
      { category: 'food', amount: 35.25 },
      { category: 'education', amount: 7 },
      { category: 'leisure', amount: 5 },
      { category: 'transport', amount: 3 },
    ],
    savingsGoal: 123.46,
  });
});

test('budget: personal mode reads only the reader\'s own entries', () => {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('budget_mode', 'personal')").run();
  try {
    const { budget } = budgetOverviewSlice(db, personReader(BEN), CTX, { month: '2026-03' });
    assert.equal(budget.entryCount, 1);
    assert.equal(budget.expenses, 25.25);
    assert.equal(budget.income, 0);
    assert.deepEqual(budget.topExpenses, [{ category: 'food', amount: 25.25 }]);
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'budget_mode'").run();
  }
});

test('rewards: approver, self and family views', () => {
  const approver = rewardsOverviewSlice(db, anna, CTX, { approver: true, moneyReader: money(ANNA, true) }).rewards;
  assert.equal(approver.view, 'approver');
  assert.equal(approver.me, ANNA);
  assert.deepEqual(approver.standings.map((m) => [m.display_name, m.balance]), [['Ben', 35], ['Cara', 60]]);
  assert.equal(approver.participantCount, 2);
  assert.equal(approver.pending, 2);
  assert.equal(approver.moneyPending, 2);
  assert.deepEqual(approver.catalog, [{ id: KINO, name: 'Kino', cost: 50, remaining: null }]);
  assert.deepEqual(approver.recent, []);

  const self = rewardsOverviewSlice(db, personReader(BEN), CTX, { approver: false, moneyReader: money(BEN, false) }).rewards;
  assert.equal(self.view, 'self');
  assert.deepEqual(self.standings.map((m) => m.display_name), ['Ben']);
  assert.equal(self.pending, 1);
  assert.equal(self.moneyPending, 1);
  assert.deepEqual(self.recent.map((r) => r.reason), ['ben 2', 'ben 1'], 'a credit taken back is no "earned"');

  const family = rewardsOverviewSlice(db, personReader(GRAN), CTX, { approver: false, moneyReader: money(GRAN, false) }).rewards;
  assert.equal(family.view, 'family');
  assert.equal(family.standings.length, 2);
  assert.equal(family.pending, 0);
  assert.equal(family.moneyPending, 1, 'the own money counter does not hang on the points enrolment');
  assert.deepEqual(family.recent, []);
});

test('the empty forms carry the keys of the slices, the failure values the old catch\'s', () => {
  const budgetKeys = Object.keys(budgetOverviewSlice(db, anna, CTX, { month: '2026-03' }).budget);
  assert.deepEqual(Object.keys(emptyBudgetOverview('2026-03')), ['budget']);
  assert.deepEqual(Object.keys(emptyBudgetOverview('2026-03').budget), budgetKeys);
  assert.deepEqual(emptyBudgetOverview('2026-03').budget, {
    month: '2026-03', income: 0, expenses: 0, balance: 0, entryCount: 0,
    topExpenseCategory: null, topExpenseAmount: 0, topExpenses: [], savingsGoal: null,
  });
  assert.deepEqual(Object.keys(budgetBlockFailed('2026-03').budget), budgetKeys.filter((k) => k !== 'savingsGoal'));
  assert.notEqual(emptyBudgetOverview('2026-03'), emptyBudgetOverview('2026-03'), 'a fresh object per call');

  const rewardKeys = Object.keys(rewardsOverviewSlice(db, anna, CTX, { approver: true, moneyReader: money(ANNA, true) }).rewards);
  assert.deepEqual(rewardKeys, ['view', 'me', 'standings', 'participantCount', 'pending', 'moneyPending', 'catalog', 'recent']);
  assert.deepEqual(Object.keys(emptyRewardsOverview().rewards), rewardKeys.filter((k) => k !== 'me'));
  assert.deepEqual(emptyRewardsOverview(), {
    rewards: { view: null, standings: [], participantCount: 0, pending: 0, moneyPending: 0, catalog: [], recent: [] },
  });
  assert.deepEqual(REWARDS_BLOCK_FAILED, emptyRewardsOverview());
  assert.notEqual(emptyRewardsOverview(), emptyRewardsOverview(), 'a fresh object per call');
});

/** A logger that keeps what runSlice() writes. */
function capturingLog() {
  /** @type {unknown[][]} */
  const lines = [];
  return { lines, error: (/** @type {unknown[]} */ ...args) => { lines.push(args); } };
}

test('through the slices a failing read answers its failure value under its old name', () => {
  const broken = { prepare() { throw new Error('no such table: budget_entries'); }, exec() {} };

  const budgetLog = capturingLog();
  const budget = budgetOverviewSlice(broken, anna, CTX, { month: '2026-03' }, sliceRunner(budgetLog));
  assert.deepEqual(budget, budgetBlockFailed('2026-03'));
  assert.deepEqual(Object.keys(budget.budget), ['month', 'income', 'expenses', 'balance', 'entryCount',
    'topExpenseCategory', 'topExpenseAmount', 'topExpenses'], 'the failure has no savingsGoal, as the old catch');
  assert.deepEqual(budgetLog.lines, [['budget error:', 'no such table: budget_entries']]);
  assert.throws(() => budgetOverviewSlice(broken, anna, CTX, { month: '2026-03' }), /no such table/,
    'without a guard a failing read throws');

  const rewardsLog = capturingLog();
  const rewards = rewardsOverviewSlice(broken, anna, CTX, { approver: true, moneyReader: money(ANNA, true) },
    sliceRunner(rewardsLog));
  assert.deepEqual(rewards, { rewards: { ...REWARDS_BLOCK_FAILED.rewards } });
  assert.deepEqual(rewardsLog.lines, [['rewards error:', 'no such table: budget_entries']]);
  assert.throws(() => rewardsOverviewSlice(broken, anna, CTX, { approver: true, moneyReader: money(ANNA, true) }),
    /no such table/, 'without a guard a failing read throws');
});

test('a missing budget_plans table drops only the savings goal, the block stands', () => {
  const noPlans = {
    /** @param {string} sql */
    prepare(sql) {
      if (sql.includes('budget_plans')) throw new Error('no such table: budget_plans');
      return db.prepare(sql);
    },
    exec() {},
  };
  const log = capturingLog();
  const { budget } = budgetOverviewSlice(noPlans, anna, CTX, { month: '2026-03' }, sliceRunner(log));
  assert.equal(budget.savingsGoal, null);
  assert.equal(budget.entryCount, 8);
  assert.deepEqual(log.lines, []);
});

test('a count that fails after the member list empties the whole reward block', () => {
  const countBroken = {
    /** @param {string} sql */
    prepare(sql) {
      if (sql.includes('r.kind != \'reward\'')) throw new Error('count boom');
      return db.prepare(sql);
    },
    exec() {},
  };
  const log = capturingLog();
  assert.deepEqual(rewardsOverviewSlice(countBroken, anna, CTX, { approver: true, moneyReader: money(ANNA, true) },
    sliceRunner(log)), emptyRewardsOverview());
  assert.deepEqual(log.lines, [['rewards error:', 'count boom']]);
});
