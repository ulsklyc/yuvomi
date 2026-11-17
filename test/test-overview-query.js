/**
 * Module: the query options of GET /dashboard (phase 2, section D)
 * Purpose: holds overviewQueryOptions(query, viewer) from
 *          server/services/overview-query.ts without HTTP: per option the normal
 *          case and the edges (missing, empty, garbage, an array instead of a
 *          string), `eventsAssignedTo` in its four situations (mine as a member,
 *          mine as a display, mine with the household audience, not mine), and
 *          `events_birthdays=hide`. The answer is frozen.
 *
 *          The whole GET /dashboard answer per role is held byte for byte by
 *          test:overview-golden; this suite holds the input check on its own.
 *
 * Run: npm run test:overview-query
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { overviewQueryOptions, normalizeShoppingListFilter } = await import('../server/services/overview-query.ts');

const MEMBER = { userId: 7, display: false };
const DISPLAY = { userId: 9, display: true };

test('the answer is frozen and carries exactly the eight options', () => {
  const options = overviewQueryOptions({}, MEMBER);
  assert.ok(Object.isFrozen(options));
  assert.deepEqual(Object.keys(options), [
    'taskCategories', 'noteCategories', 'householdAudience', 'eventsAssignedTo',
    'includeBirthdays', 'eventsLimit', 'eventsCalendar', 'shoppingListSelection',
  ]);
});

test('the defaults of an empty query', () => {
  assert.deepEqual({ ...overviewQueryOptions({}, MEMBER) }, {
    taskCategories: [],
    noteCategories: [],
    householdAudience: false,
    eventsAssignedTo: null,
    includeBirthdays: true,
    eventsLimit: 5,
    eventsCalendar: undefined,
    shoppingListSelection: [],
  });
});

test('taskCategories: string, array without duplicates, missing, empty, garbage', () => {
  const of = (/** @type {unknown} */ value) => overviewQueryOptions({ tasks_category: value }, MEMBER).taskCategories;
  assert.deepEqual(of('Haushalt'), ['Haushalt']);
  assert.deepEqual(of(['Haushalt', 'Schule', 'Haushalt']), ['Haushalt', 'Schule']);
  assert.deepEqual(of(undefined), []);
  assert.deepEqual(of(''), []);
  assert.deepEqual(of({ a: 'x' }), []);
  assert.deepEqual(of(['', { a: 'x' }, 'Schule']), ['Schule']);
  assert.equal(of(Array.from({ length: 80 }, (_, i) => `c${i}`)).length, 50);
});

test('noteCategories: ids only, without duplicates, at most 50', () => {
  const of = (/** @type {unknown} */ value) => overviewQueryOptions({ notes_category: value }, MEMBER).noteCategories;
  assert.deepEqual(of('3'), [3]);
  assert.deepEqual(of(['3', '4', '3']), [3, 4]);
  assert.deepEqual(of(undefined), []);
  assert.deepEqual(of(''), []);
  assert.deepEqual(of(['abc', '-1', '0', '1.5', '2']), [2]);
  assert.equal(of(Array.from({ length: 80 }, (_, i) => String(i + 1))).length, 50);
});

test('householdAudience: audience=household, also as an array; anything else is personal', () => {
  const of = (/** @type {unknown} */ value) => overviewQueryOptions({ audience: value }, MEMBER).householdAudience;
  assert.equal(of('household'), true);
  assert.equal(of(['personal', 'household']), true);
  assert.equal(of(undefined), false);
  assert.equal(of(''), false);
  assert.equal(of('Household'), false);
  assert.equal(of({ household: 'household' }), false);
});

test('eventsAssignedTo: mine as a member is the viewer', () => {
  assert.equal(overviewQueryOptions({ events_scope: 'mine' }, MEMBER).eventsAssignedTo, 7);
});

test('eventsAssignedTo: a display has no "mine" (#1808)', () => {
  assert.equal(overviewQueryOptions({ events_scope: 'mine' }, DISPLAY).eventsAssignedTo, null);
});

test('eventsAssignedTo: the household audience has no "mine" (#1817)', () => {
  assert.equal(overviewQueryOptions({ events_scope: 'mine', audience: 'household' }, MEMBER).eventsAssignedTo, null);
});

test('eventsAssignedTo: not mine is everyone, also missing, empty, garbage or an array', () => {
  for (const scope of ['all', undefined, '', 'MINE', ['mine'], { mine: 'mine' }]) {
    assert.equal(overviewQueryOptions({ events_scope: scope }, MEMBER).eventsAssignedTo, null, JSON.stringify(scope));
  }
});

test('includeBirthdays: only events_birthdays=hide drops them', () => {
  const of = (/** @type {unknown} */ value) => overviewQueryOptions({ events_birthdays: value }, MEMBER).includeBirthdays;
  assert.equal(of('hide'), false);
  assert.equal(of('show'), true);
  assert.equal(of(undefined), true);
  assert.equal(of(''), true);
  assert.equal(of(['hide']), true);
});

test('eventsLimit: 5, 8 or 12, everything else is five', () => {
  const of = (/** @type {unknown} */ value) => overviewQueryOptions({ events_limit: value }, MEMBER).eventsLimit;
  assert.equal(of('8'), 8);
  assert.equal(of('12'), 12);
  assert.equal(of('5'), 5);
  for (const other of [undefined, '', '7', '500', 'abc', ['8', '12'], ['8']]) {
    assert.equal(of(other), 5, JSON.stringify(other));
  }
});

test('eventsCalendar: the raw value, untouched (the route checks it against the catalog)', () => {
  const list = ['local:1', 'cal:2'];
  assert.equal(overviewQueryOptions({ events_calendar: list }, MEMBER).eventsCalendar, list);
  assert.equal(overviewQueryOptions({ events_calendar: 'sub:3' }, MEMBER).eventsCalendar, 'sub:3');
  assert.equal(overviewQueryOptions({ events_calendar: '' }, MEMBER).eventsCalendar, '');
  assert.equal(overviewQueryOptions({}, MEMBER).eventsCalendar, undefined);
});

test('shoppingListSelection: positive integers, without duplicates, at most 50', () => {
  const of = (/** @type {unknown} */ value) => overviewQueryOptions({ shopping_list: value }, MEMBER).shoppingListSelection;
  assert.deepEqual(of('7'), [7]);
  assert.deepEqual(of(['7', '3', '7']), [7, 3]);
  assert.deepEqual(of(undefined), []);
  assert.deepEqual(of(''), []);
  assert.deepEqual(of(['abc', '0', '-1', '07', '1.5', '4']), [4]);
  assert.deepEqual(of({ a: '1' }), []);
  assert.equal(of(Array.from({ length: 80 }, (_, i) => String(i + 1))).length, 50);
  assert.deepEqual(normalizeShoppingListFilter(null), []);
});

test('a missing query reads as an empty one', () => {
  assert.deepEqual({ ...overviewQueryOptions(undefined, MEMBER) }, { ...overviewQueryOptions({}, MEMBER) });
});
