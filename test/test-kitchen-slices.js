/**
 * Module: shopping and meals overview slices (phase 2, section D, contract E10)
 * Purpose: holds the contract of server/services/shopping-slices.ts and
 *          server/services/meals-slices.ts, as test:tasks-slices does for tasks:
 *
 *          1. NO CLOCK. The system clock is frozen at a deliberately wrong instant
 *             (2031); two calls with two different `ctx` answer what fits `ctx`.
 *             A meal slice that read `new Date()`, `Date.now()` or todayKey()
 *             itself would answer for 2031.
 *          2. ONE FORM. emptyShoppingOverview()/emptyMealsOverview() and the
 *             failure values carry exactly the keys of the slice (`shoppingTile`
 *             only with a selection; its empty form is the missing field).
 *          3. ISOLATION. Through the slice, each failing read answers its own
 *             failure value under its old name and logs `<name> error:`; a failed
 *             tile leaves the field out; without a guard a failure throws.
 *
 *          The whole GET /dashboard answer is held byte for byte by
 *          test:overview-golden; this suite holds what that one cannot see.
 *
 * Run: npm run test:kitchen-slices
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The production driver, migrated by server/db.js itself, in memory.
process.env.DB_PATH = ':memory:';

const { get } = await import('../server/db.js');
const { personReader } = await import('../server/authorize/index.ts');
const {
  emptyShoppingOverview, shoppingOverviewSlice, SHOPPING_BLOCK_FAILED,
} = await import('../server/services/shopping-slices.ts');
const {
  emptyMealsOverview, mealsOverviewSlice, MEALS_BLOCK_FAILED,
} = await import('../server/services/meals-slices.ts');
const { sliceRunner } = await import('../server/services/slice-runner.ts');

const db = get();
test.after(() => db.close());

const ANNA = Number(db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES ('slice-anna', 'Anna', 'hash', '#7C3AED', 'admin', 'parent')
`).run().lastInsertRowid);

/** @param {string} name @param {string} updatedAt */
function addList(name, updatedAt) {
  return Number(db.prepare(`
    INSERT INTO shopping_lists (name, created_by, updated_at) VALUES (?, ?, ?)
  `).run(name, ANNA, updatedAt).lastInsertRowid);
}
/** @param {number} listId @param {string} name @param {number} [checked] */
function addItem(listId, name, checked = 0) {
  db.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, ?)').run(listId, name, checked);
}

const GROCERIES = addList('Groceries', '2026-03-10T08:00:00Z');
const HARDWARE = addList('Hardware', '2026-03-11T08:00:00Z');
const EMPTY = addList('Empty', '2026-03-12T08:00:00Z');
addItem(GROCERIES, 'milk');
addItem(GROCERIES, 'bread');
addItem(GROCERIES, 'eggs', 1);
addItem(HARDWARE, 'screws');
addItem(EMPTY, 'done already', 1);

/** @param {string} date @param {string} type @param {string} title */
function addMeal(date, type, title) {
  db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by, cook_user_id) VALUES (?, ?, ?, ?, ?)
  `).run(date, type, title, ANNA, ANNA);
}
addMeal('2026-03-11', 'dinner', 'soup wednesday');
addMeal('2026-03-11', 'breakfast', 'porridge wednesday');
addMeal('2026-03-12', 'lunch', 'pasta thursday');

const ZONE = 'Europe/Berlin';
const WEDNESDAY = Object.freeze({ today: '2026-03-11', zone: ZONE, now: new Date('2026-03-11T09:30:00.000Z') });
const THURSDAY = Object.freeze({ today: '2026-03-12', zone: ZONE, now: new Date('2026-03-12T09:30:00.000Z') });

const reader = personReader(ANNA);
/** @param {{ title?: unknown }[]} list */
const titles = (list) => list.map((row) => row.title);

test('the slices read no clock: two ctx, a wrong system clock, two answers that fit ctx', () => {
  // A system clock years away: any reading of it lands on no seeded day.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2031-07-01T03:00:00.000Z') });
  try {
    assert.deepEqual(titles(mealsOverviewSlice(db, reader, WEDNESDAY).todayMeals),
      ['porridge wednesday', 'soup wednesday']);
    assert.deepEqual(titles(mealsOverviewSlice(db, reader, THURSDAY).todayMeals), ['pasta thursday']);
    const shopping = shoppingOverviewSlice(db, reader, WEDNESDAY);
    assert.equal(shopping.shoppingOpenCount, 3);
    assert.equal(shopping.shoppingOpenLists, 2);
  } finally {
    mock.timers.reset();
  }
});

test('meals: the household meal type setting filters, the cook comes along', () => {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('visible_meal_types', 'dinner,nonsense')").run();
  try {
    const [meal, ...rest] = mealsOverviewSlice(db, reader, WEDNESDAY).todayMeals;
    assert.equal(rest.length, 0);
    assert.equal(meal.title, 'soup wednesday');
    assert.equal(meal.cook_name, 'Anna');
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'visible_meal_types'").run();
  }
});

test('shopping: lists with open items over all lists, newest first, open items only', () => {
  const answer = shoppingOverviewSlice(db, reader, WEDNESDAY);
  assert.deepEqual(answer.shoppingLists.map((list) => [list.name, list.open_count, list.total_count]),
    [['Hardware', 1, 1], ['Groceries', 2, 3]]);
  assert.deepEqual(answer.shoppingLists[1].items?.map((item) => item.name), ['milk', 'bread']);
  assert.equal('shoppingTile' in answer, false, 'no selection, no tile');
});

test('shopping: the selection fills only the tile, an unknown id drops out', () => {
  const answer = shoppingOverviewSlice(db, reader, WEDNESDAY, { listSelection: [EMPTY, HARDWARE, 999999] });
  assert.equal(answer.shoppingOpenCount, 3, 'the shared count stays unfiltered');
  assert.equal(answer.shoppingLists.length, 2);
  assert.deepEqual(answer.shoppingTile?.lists.map((list) => list.name), ['Hardware', 'Empty']);
  assert.equal(answer.shoppingTile?.openCount, 1);
  assert.equal(answer.shoppingTile?.listCount, 2);

  assert.equal('shoppingTile' in shoppingOverviewSlice(db, reader, WEDNESDAY, { listSelection: [999999] }), false,
    'a selection of nothing that exists counts as no selection');
  assert.equal('shoppingTile' in shoppingOverviewSlice(db, reader, WEDNESDAY,
    { listSelection: [HARDWARE], withTile: false }), false, 'the wall leaves the tile out');
});

test('the empty forms and the failure values carry exactly the keys of the slices', () => {
  const shoppingKeys = Object.keys(shoppingOverviewSlice(db, reader, WEDNESDAY)).sort();
  assert.deepEqual(Object.keys(emptyShoppingOverview()).sort(), shoppingKeys);
  assert.deepEqual(Object.keys(SHOPPING_BLOCK_FAILED).sort(), shoppingKeys);
  // The empty form keeps the key order the route has always written.
  assert.deepEqual(Object.keys(emptyShoppingOverview()), ['shoppingLists', 'shoppingOpenCount', 'shoppingOpenLists']);
  assert.notEqual(emptyShoppingOverview(), emptyShoppingOverview(), 'a fresh object per call');

  const mealKeys = Object.keys(mealsOverviewSlice(db, reader, WEDNESDAY)).sort();
  assert.deepEqual(Object.keys(emptyMealsOverview()).sort(), mealKeys);
  assert.deepEqual(Object.keys(MEALS_BLOCK_FAILED).sort(), mealKeys);
  assert.deepEqual(emptyMealsOverview(), { todayMeals: [] });
  assert.notEqual(emptyMealsOverview(), emptyMealsOverview(), 'a fresh object per call');
});

/** A logger that keeps what runSlice() writes. */
function capturingLog() {
  /** @type {unknown[][]} */
  const lines = [];
  return { lines, error: (/** @type {unknown[]} */ ...args) => { lines.push(args); } };
}

test('through the slices each failing read answers its own failure value under its old name', () => {
  const broken = { prepare() { throw new Error('no such table: shopping_items'); }, exec() {} };

  const shoppingLog = capturingLog();
  const shopping = shoppingOverviewSlice(broken, reader, WEDNESDAY, { listSelection: [HARDWARE] },
    sliceRunner(shoppingLog));
  assert.deepEqual(shopping, { shoppingLists: [], shoppingOpenCount: null, shoppingOpenLists: 0 });
  assert.deepEqual(shopping, { ...SHOPPING_BLOCK_FAILED });
  assert.deepEqual(shoppingLog.lines, [
    ['shopping selection error:', 'no such table: shopping_items'],
    ['shoppingOpenCount error:', 'no such table: shopping_items'],
    ['shoppingLists error:', 'no such table: shopping_items'],
  ]);
  assert.throws(() => shoppingOverviewSlice(broken, reader, WEDNESDAY), /no such table/,
    'without a guard a failing read throws');

  const mealsLog = capturingLog();
  assert.deepEqual(mealsOverviewSlice(broken, reader, WEDNESDAY, {}, sliceRunner(mealsLog)), { ...MEALS_BLOCK_FAILED });
  assert.deepEqual(mealsLog.lines, [['todayMeals error:', 'no such table: shopping_items']]);
  assert.throws(() => mealsOverviewSlice(broken, reader, WEDNESDAY), /no such table/,
    'without a guard a failing read throws');
});

test('a failing tile read leaves the field out and logs `shoppingTile error:`, the rest stands', () => {
  // Only the tile's own list read fails; selection, counts and lists work.
  const tileBroken = {
    /** @param {string} sql */
    prepare(sql) {
      if (sql.includes('ORDER BY (open_count > 0) DESC')) throw new Error('tile boom');
      return db.prepare(sql);
    },
    exec() {},
  };
  const log = capturingLog();
  const answer = shoppingOverviewSlice(tileBroken, reader, WEDNESDAY, { listSelection: [HARDWARE] }, sliceRunner(log));
  assert.equal('shoppingTile' in answer, false);
  assert.equal(answer.shoppingOpenCount, 3);
  assert.equal(answer.shoppingLists.length, 2);
  assert.deepEqual(log.lines, [['shoppingTile error:', 'tile boom']]);
});
