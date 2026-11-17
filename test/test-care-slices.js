/**
 * Module: health and housekeeping overview slices (phase 2, section D, contract E10)
 * Purpose: holds the contract of server/services/health-slices.ts and
 *          server/services/housekeeping-slices.ts, as test:money-slices does for
 *          budget and rewards:
 *
 *          1. NO CLOCK. Every reading of the system clock (Date.now(), new Date()
 *             without an argument) throws while the slices run; the dose day, the
 *             nutrition day and the housekeeping month come from `ctx.today`, two
 *             days answer two balances.
 *          2. ONE FORM. emptyHealthOverview()/emptyHousekeepingOverview() carry
 *             exactly the keys of a successful slice in the route's order; the
 *             failure values are what the route's old catch wrote.
 *          3. ISOLATION. Through the slice, a failing read answers its failure
 *             value under its old name (`health`, `fasting`, `nutrition`,
 *             `housekeeping`) and logs `<name> error:`; a fasting 403 is the empty
 *             fasting form without a log line; without a guard a failure throws.
 *          4. OWN DATA ONLY. The medication block reads the viewer's own active
 *             medications, never a family-visible one of someone else (#592); the
 *             unpaid wage follows the capability question (R20).
 *
 *          The whole GET /dashboard answer is held byte for byte by
 *          test:overview-golden; this suite holds what that one cannot see.
 *
 * Run: npm run test:care-slices
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The production driver, migrated by server/db.js itself, in memory.
process.env.DB_PATH = ':memory:';

const { get } = await import('../server/db.js');
const { personReader } = await import('../server/authorize/index.ts');
const {
  emptyFastingWidget, emptyHealthOverview, emptyNutritionWidget, healthBlockFailed, healthOverviewSlice,
} = await import('../server/services/health-slices.ts');
const {
  emptyHousekeepingOverview, housekeepingBlockFailed, housekeepingOverviewSlice,
} = await import('../server/services/housekeeping-slices.ts');
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
const ANNA = addUser('care-anna', 'Anna', 'admin', 'parent');
const BEN = addUser('care-ben', 'Ben', 'member', 'parent');
const HELGA = addUser('care-helga', 'Helga', 'member', 'parent');

// Ben may not fast: the fasting service answers 403 for him.
db.prepare(`
  INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
  VALUES ('user', ?, 'capability', 'health_use_fasting', 'none')
`).run(String(BEN));

// ---- Medications: 2026-03-11 is a Wednesday (weekday index 2) ---------------
const insertMed = db.prepare(`
  INSERT INTO medications (user_id, name, active, visibility, stock_qty, refill_threshold) VALUES (?, ?, ?, ?, ?, ?)
`);
/** @returns {number} */
const addMed = (/** @type {number} */ owner, /** @type {string} */ name, active = 1, visibility = 'private',
  /** @type {number|null} */ stock = null, /** @type {number|null} */ threshold = null) => (
  Number(insertMed.run(owner, name, active, visibility, stock, threshold).lastInsertRowid)
);
const insertSchedule = db.prepare(`
  INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, dose_qty, start_date, end_date, active)
  VALUES (?, ?, ?, 1, ?, ?, ?) RETURNING id
`);
/** @returns {number} */
const addSchedule = (/** @type {number} */ med, /** @type {string} */ time, /** @type {number|null} */ mask,
  start = '2026-03-01', /** @type {string|null} */ end = null, active = 1) => insertSchedule.get(med, time, mask, start, end, active).id;
const insertLog = db.prepare(`
  INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, dose_qty) VALUES (?, ?, ?, ?, 1)
`);

const IRON = addMed(ANNA, 'Iron', 1, 'private', 2, 5);
const ironMorning = addSchedule(IRON, '08:00', 127);
addSchedule(IRON, '20:00', null);
insertLog.run(IRON, ironMorning, '2026-03-11T08:00', 'taken');
const VITAMIN = addMed(ANNA, 'Vitamin D', 1, 'family', 10, 1);
const vitaminNoon = addSchedule(VITAMIN, '12:00', 1 << 2);
insertLog.run(VITAMIN, vitaminNoon, '2026-03-11T12:00', 'skipped');
// Thursday only, ended, not yet started, inactive: none is due on the 11th.
addSchedule(VITAMIN, '09:00', 1 << 3);
addSchedule(VITAMIN, '10:00', 127, '2026-03-01', '2026-03-10');
addSchedule(VITAMIN, '11:00', 127, '2026-03-12');
addSchedule(VITAMIN, '06:00', 127, '2026-03-01', null, 0);
// An inactive medication and a family-visible one of Ben: neither is Anna's tile.
addSchedule(addMed(ANNA, 'Old', 0, 'private', 0, 1), '07:00', 127);
addSchedule(addMed(BEN, 'Ben family', 1, 'family', 0, 1), '07:30', 127);

// ---- Fasting and nutrition --------------------------------------------------
db.prepare(`
  INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes, visibility, created_by, updated_by)
  VALUES (?, '2026-03-11T06:00:00.000Z', NULL, 'Europe/Berlin', 960, 'private', ?, ?)
`).run(ANNA, ANNA, ANNA);
// Ben fasts too, but may not: without the 403 his tile would show this fast.
db.prepare(`
  INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes, visibility, created_by, updated_by)
  VALUES (?, '2026-03-11T05:00:00.000Z', NULL, 'Europe/Berlin', 720, 'private', ?, ?)
`).run(BEN, BEN, BEN);
db.prepare('INSERT INTO health_nutrition_targets (user_id, energy_kcal, protein_g) VALUES (?, 2000, 60)').run(ANNA);
const insertMeal = db.prepare(`
  INSERT INTO health_nutrition_entries (user_id, consumed_at, meal_type, title, energy_kcal, protein_g, visibility, created_by)
  VALUES (?, ?, 'breakfast', ?, ?, ?, 'private', ?)
`);
insertMeal.run(ANNA, '2026-03-11T07:30', 'oats', 350, 12, ANNA);
insertMeal.run(ANNA, '2026-03-10T07:30', 'eggs', 200, 14, ANNA);

// ---- Housekeeping: Helga is in the house; one finished, unpaid visit in March
const WORKER = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40) RETURNING id').get(HELGA).id;
const insertVisit = db.prepare(`
  INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, worker_id, created_by, paid_at)
  VALUES (?, ?, 40, ?, ?, ?, ?)
`);
insertVisit.run('2026-03-02T08:00:00.000Z', '2026-03-02T12:00:00.000Z', 5, WORKER, ANNA, null);
insertVisit.run('2026-03-03T08:00:00.000Z', '2026-03-03T12:00:00.000Z', 0, WORKER, ANNA, '2026-03-04T00:00:00.000Z');
insertVisit.run('2026-02-20T08:00:00.000Z', '2026-02-20T12:00:00.000Z', 0, WORKER, ANNA, null);
insertVisit.run('2026-03-11T07:00:00.000Z', null, 0, WORKER, ANNA, null);

const ZONE = 'Europe/Berlin';
const CTX = Object.freeze({ today: '2026-03-11', zone: ZONE, now: new Date('2026-03-11T09:30:00.000Z') });
const NEXT_DAY = Object.freeze({ today: '2026-03-12', zone: ZONE, now: new Date('2026-03-12T09:30:00.000Z') });
const FEBRUARY = Object.freeze({ today: '2026-02-21', zone: ZONE, now: new Date('2026-02-21T09:30:00.000Z') });
const anna = personReader(ANNA);
const amounts = { viewsAmounts: () => true };

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

test('the slices read no clock; day and month come from ctx.today', () => {
  const [today, tomorrow, march, february] = withoutClock(() => [
    healthOverviewSlice(db, anna, CTX),
    healthOverviewSlice(db, anna, NEXT_DAY),
    housekeepingOverviewSlice(db, anna, CTX, amounts),
    housekeepingOverviewSlice(db, anna, FEBRUARY, amounts),
  ]);
  assert.equal(today.nutrition.date, '2026-03-11');
  assert.equal(today.nutrition.totals.energy_kcal, 350);
  assert.equal(tomorrow.nutrition.date, '2026-03-12');
  assert.equal(tomorrow.nutrition.entryCount, 0);
  assert.equal(today.health.dosesTotal, 3);
  // Thursday: the Thursday dose and the dose starting on the 12th are due, the
  // Wednesday one is not.
  assert.equal(tomorrow.health.dosesTotal, 4);
  assert.equal(march.housekeeping.visitsThisMonth, 2);
  assert.equal(february.housekeeping.visitsThisMonth, 1);
});

test('health: own active medications only, due doses, logs, next dose and refill hint', () => {
  const { health } = healthOverviewSlice(db, anna, CTX);
  assert.deepEqual(health, {
    hasMeds: true,
    dosesTotal: 3,
    dosesTaken: 1,
    dosesSkipped: 1,
    nextDose: { name: 'Iron', time: '20:00' },
    lowStockCount: 1,
  });
  // Ben's own medication is his tile; Anna's family-visible one never is (#592).
  const ben = healthOverviewSlice(db, personReader(BEN), CTX).health;
  assert.equal(ben.dosesTotal, 1);
  assert.deepEqual(ben.nextDose, { name: 'Ben family', time: '07:30' });
  assert.equal(ben.lowStockCount, 1);
  const helga = healthOverviewSlice(db, personReader(HELGA), CTX).health;
  assert.deepEqual(helga, healthBlockFailed(), 'no medications: the empty tile');
});

test('fasting and nutrition: the own state, a fasting 403 is the empty form without a log line', () => {
  const log = capturingLog();
  const own = healthOverviewSlice(db, anna, CTX, {}, sliceRunner(log));
  assert.equal(/** @type {any} */ (own.fasting).active.goal_minutes, 960);
  assert.equal(/** @type {any} */ (own.nutrition.target)?.energy_kcal, 2000);
  const ben = healthOverviewSlice(db, personReader(BEN), CTX, {}, sliceRunner(log));
  assert.deepEqual(ben.fasting, emptyFastingWidget());
  assert.equal(ben.nutrition.target, null, 'no target for someone without one');
  assert.deepEqual(log.lines, []);
});

test('housekeeping: presence, worker, month, unpaid amount behind the capability, last visit', () => {
  const { housekeeping } = housekeepingOverviewSlice(db, anna, CTX, amounts);
  assert.deepEqual(housekeeping, {
    configured: true,
    present: true,
    presentSince: '2026-03-11T07:00:00.000Z',
    workerName: 'Helga',
    visitsThisMonth: 2,
    unpaidAmount: 45,
    lastVisit: '2026-03-03T08:00:00.000Z',
  });
  let asked = 0;
  const hidden = housekeepingOverviewSlice(db, anna, CTX, { viewsAmounts: () => { asked += 1; return false; } });
  assert.equal(hidden.housekeeping.unpaidAmount, null);
  assert.equal(asked, 1, 'the capability is asked once');
});

test('the empty forms carry the keys of the slices, the failure values the old catch\'s', () => {
  const full = healthOverviewSlice(db, anna, CTX);
  const empty = emptyHealthOverview();
  assert.deepEqual(Object.keys(empty), ['health', 'fasting', 'nutrition']);
  assert.deepEqual(Object.keys(full), Object.keys(empty));
  assert.deepEqual(Object.keys(empty.health), Object.keys(full.health));
  assert.deepEqual(Object.keys(empty.nutrition), Object.keys(full.nutrition));
  assert.deepEqual(Object.keys(empty.nutrition.totals), Object.keys(full.nutrition.totals));
  assert.deepEqual(Object.keys(/** @type {object} */ (empty.fasting)), Object.keys(/** @type {object} */ (full.fasting)));
  assert.deepEqual(empty, {
    health: { hasMeds: false, dosesTotal: 0, dosesTaken: 0, dosesSkipped: 0, nextDose: null, lowStockCount: 0 },
    fasting: { settings: { clock_mode: 'auto', zone_mode: 'timer' }, active: null, lastCompleted: null },
    nutrition: emptyNutritionWidget(),
  });
  assert.equal(emptyNutritionWidget().target, null, 'no target, not a target of zeros (#1326)');
  assert.notEqual(emptyHealthOverview(), emptyHealthOverview(), 'a fresh object per call');

  const hk = housekeepingOverviewSlice(db, anna, CTX, amounts);
  assert.deepEqual(Object.keys(emptyHousekeepingOverview()), ['housekeeping']);
  assert.deepEqual(Object.keys(emptyHousekeepingOverview().housekeeping), Object.keys(hk.housekeeping));
  assert.deepEqual(emptyHousekeepingOverview(), {
    housekeeping: {
      configured: false, present: false, presentSince: null, workerName: null,
      visitsThisMonth: 0, unpaidAmount: 0, lastVisit: null,
    },
  });
  assert.deepEqual(housekeepingBlockFailed(), emptyHousekeepingOverview());
  assert.notEqual(emptyHousekeepingOverview(), emptyHousekeepingOverview(), 'a fresh object per call');
});

/** A logger that keeps what runSlice() writes. */
function capturingLog() {
  /** @type {unknown[][]} */
  const lines = [];
  return { lines, error: (/** @type {unknown[]} */ ...args) => { lines.push(args); } };
}

test('through the slices a failing read answers its failure value under its old name', () => {
  const broken = { prepare() { throw new Error('no such table: boom'); }, exec() {} };

  const healthLog = capturingLog();
  const health = healthOverviewSlice(broken, anna, CTX, {}, sliceRunner(healthLog));
  assert.deepEqual(health, { health: healthBlockFailed(), fasting: null, nutrition: emptyNutritionWidget() });
  assert.deepEqual(healthLog.lines, [
    ['health error:', 'no such table: boom'],
    ['fasting error:', 'no such table: boom'],
    ['nutrition error:', 'no such table: boom'],
  ]);
  assert.throws(() => healthOverviewSlice(broken, anna, CTX), /no such table/, 'without a guard a failing read throws');

  const hkLog = capturingLog();
  const hk = housekeepingOverviewSlice(broken, anna, CTX, amounts, sliceRunner(hkLog));
  assert.deepEqual(hk, housekeepingBlockFailed());
  assert.deepEqual(hkLog.lines, [['housekeeping error:', 'no such table: boom']]);
  assert.throws(() => housekeepingOverviewSlice(broken, anna, CTX, amounts), /no such table/,
    'without a guard a failing read throws');
});

test('each health block fails alone; a failing capability read empties only housekeeping', () => {
  const nutritionBroken = {
    /** @param {string} sql */
    prepare(sql) {
      if (sql.includes('health_nutrition_entries')) throw new Error('nutrition boom');
      return db.prepare(sql);
    },
    exec() {},
  };
  const log = capturingLog();
  const out = healthOverviewSlice(nutritionBroken, anna, CTX, {}, sliceRunner(log));
  assert.equal(out.health.dosesTotal, 3);
  assert.equal(/** @type {any} */ (out.fasting).active.goal_minutes, 960);
  assert.deepEqual(out.nutrition, emptyNutritionWidget());
  assert.deepEqual(log.lines, [['nutrition error:', 'nutrition boom']]);

  const hkLog = capturingLog();
  const hk = housekeepingOverviewSlice(db, anna, CTX, { viewsAmounts: () => { throw new Error('capability boom'); } },
    sliceRunner(hkLog));
  assert.deepEqual(hk, housekeepingBlockFailed());
  assert.deepEqual(hkLog.lines, [['housekeeping error:', 'capability boom']]);
});
