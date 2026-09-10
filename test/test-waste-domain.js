/**
 * Modul: Waste collection domain (#1063 Phase 1)
 * Zweck: server/services/waste-domain.js is pure - no database, no Express -
 *        so this suite exercises it directly: the recurrence adapter onto
 *        recurrence.js, bounded range resolution, provenance-preserving
 *        coalescing (invariant #3/#4), and next-per-type. Every date is
 *        ground-truthed against a real `node:22` run of recurrence.js itself
 *        (2026-01-05 is a Monday, 2026 is not a leap year, 2028 is), never
 *        hand-computed from a mental calendar.
 * Ausführen: npm run test:waste-domain
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECURRENCE_KINDS, WEEKDAY_CODES, WEEKLY_INTERVAL_MAX, MONTHLY_INTERVAL_MAX,
  OCCURRENCE_RANGE_MAX_DAYS, validateType, validateOneOff, validateScheduleRecurrence,
  validateOverride, validateRange, scheduleToRule, expandSchedule, coalesceOccurrences,
  resolveOccurrences, nextPerType,
} from '../server/services/waste-domain.js';

function weeklySchedule(overrides = {}) {
  return {
    id: 10, type_id: 1, recurrence_kind: 'weekly', anchor_date: '2026-01-05',
    interval: 1, weekdays: 'MO,TH', month_day: null, valid_until: null, active: 1,
    ...overrides,
  };
}

function monthlySchedule(overrides = {}) {
  return {
    id: 20, type_id: 1, recurrence_kind: 'monthly_fixed_day', anchor_date: '2026-01-15',
    interval: 1, weekdays: null, month_day: 15, valid_until: null, active: 1,
    ...overrides,
  };
}

// 2026-01-12 is the 2nd Monday of January 2026 (Mondays: 5, 12, 19, 26) -
// same ground-truthing convention as the file header (#1063 Phase 9).
function ordinalSchedule(overrides = {}) {
  return {
    id: 30, type_id: 1, recurrence_kind: 'monthly_ordinal_weekday', anchor_date: '2026-01-12',
    interval: 1, weekdays: 'MO', month_day: 2, valid_until: null, active: 1,
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// validateScheduleRecurrence
// -------------------------------------------------------------------------

test('validateScheduleRecurrence: accepts a well-formed weekly schedule', () => {
  assert.deepEqual(validateScheduleRecurrence(weeklySchedule()), []);
});

test('validateScheduleRecurrence: accepts a well-formed fixed-day monthly schedule', () => {
  assert.deepEqual(validateScheduleRecurrence(monthlySchedule()), []);
});

test('validateScheduleRecurrence: accepts a well-formed last-day-of-month schedule', () => {
  const schedule = monthlySchedule({ anchor_date: '2026-01-31', month_day: -1 });
  assert.deepEqual(validateScheduleRecurrence(schedule), []);
});

test('validateScheduleRecurrence: rejects an unknown recurrence_kind', () => {
  const errors = validateScheduleRecurrence(weeklySchedule({ recurrence_kind: 'daily' }));
  assert.ok(errors.some((e) => e.includes('recurrence_kind')));
});

test('validateScheduleRecurrence: rejects weekly with no weekdays', () => {
  const errors = validateScheduleRecurrence(weeklySchedule({ weekdays: null }));
  assert.ok(errors.some((e) => e.includes('weekdays')));
});

test('validateScheduleRecurrence: rejects weekly carrying a month_day', () => {
  const errors = validateScheduleRecurrence(weeklySchedule({ month_day: 5 }));
  assert.ok(errors.some((e) => e.includes('month_day must not be set')));
});

test('validateScheduleRecurrence: rejects monthly carrying weekdays', () => {
  const errors = validateScheduleRecurrence(monthlySchedule({ weekdays: 'MO' }));
  assert.ok(errors.some((e) => e.includes('weekdays must not be set')));
});

test('validateScheduleRecurrence: rejects a month_day that does not match anchor_date\'s day', () => {
  const errors = validateScheduleRecurrence(monthlySchedule({ anchor_date: '2026-01-10', month_day: 15 }));
  assert.ok(errors.some((e) => e.includes('anchor_date must fall on month_day')));
});

test('validateScheduleRecurrence: rejects month_day=-1 when anchor_date is not the actual last day', () => {
  const errors = validateScheduleRecurrence(monthlySchedule({ anchor_date: '2026-01-15', month_day: -1 }));
  assert.ok(errors.some((e) => e.includes('last day of its month')));
});

test('validateScheduleRecurrence: rejects an out-of-bounds weekly interval', () => {
  assert.ok(validateScheduleRecurrence(weeklySchedule({ interval: WEEKLY_INTERVAL_MAX + 1 })).length > 0);
  assert.deepEqual(validateScheduleRecurrence(weeklySchedule({ interval: WEEKLY_INTERVAL_MAX })), []);
});

test('validateScheduleRecurrence: rejects an out-of-bounds monthly interval', () => {
  assert.ok(validateScheduleRecurrence(monthlySchedule({ interval: MONTHLY_INTERVAL_MAX + 1 })).length > 0);
  assert.deepEqual(validateScheduleRecurrence(monthlySchedule({ interval: MONTHLY_INTERVAL_MAX })), []);
});

test('validateScheduleRecurrence: rejects valid_until before anchor_date', () => {
  const errors = validateScheduleRecurrence(weeklySchedule({ valid_until: '2025-01-01' }));
  assert.ok(errors.some((e) => e.includes('valid_until')));
});

// -------------------------------------------------------------------------
// validateScheduleRecurrence: monthly_ordinal_weekday (#1063 Phase 9)
// -------------------------------------------------------------------------

test('validateScheduleRecurrence: accepts a well-formed ordinal-weekday schedule (2nd Monday)', () => {
  assert.deepEqual(validateScheduleRecurrence(ordinalSchedule()), []);
});

test('validateScheduleRecurrence: accepts "last Friday" (month_day=-1)', () => {
  // 2026-01-30 is the last Friday of January 2026 (Fridays: 2, 9, 16, 23, 30).
  const schedule = ordinalSchedule({ anchor_date: '2026-01-30', weekdays: 'FR', month_day: -1 });
  assert.deepEqual(validateScheduleRecurrence(schedule), []);
});

test('validateScheduleRecurrence: rejects more than one weekday for an ordinal schedule', () => {
  const errors = validateScheduleRecurrence(ordinalSchedule({ weekdays: 'MO,TH' }));
  assert.ok(errors.some((e) => e.includes('exactly one of')));
});

test('validateScheduleRecurrence: rejects an ordinal position outside -1/1-4 (no month always has a 5th)', () => {
  const errors = validateScheduleRecurrence(ordinalSchedule({ month_day: 5 }));
  assert.ok(errors.some((e) => e.includes('month_day must be one of')));
});

test('validateScheduleRecurrence: rejects an anchor_date that is not itself the chosen ordinal occurrence', () => {
  // 2026-01-05 is the 1st Monday, not the 2nd.
  const errors = validateScheduleRecurrence(ordinalSchedule({ anchor_date: '2026-01-05' }));
  assert.ok(errors.some((e) => e.includes('must itself be the')));
});

test('validateScheduleRecurrence: rejects an ordinal schedule missing weekdays or month_day', () => {
  assert.ok(validateScheduleRecurrence(ordinalSchedule({ weekdays: null })).length > 0);
  assert.ok(validateScheduleRecurrence(ordinalSchedule({ month_day: null })).length > 0);
});

test('RECURRENCE_KINDS and WEEKDAY_CODES are the stable vocabulary the schema CHECKs mirror', () => {
  assert.deepEqual(RECURRENCE_KINDS, ['weekly', 'monthly_fixed_day', 'monthly_ordinal_weekday']);
  assert.deepEqual(WEEKDAY_CODES, ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
});

// -------------------------------------------------------------------------
// validateOverride / validateRange / validateType / validateOneOff
// -------------------------------------------------------------------------

test('validateOverride: accepts a move and an explicit skip', () => {
  assert.deepEqual(validateOverride({ original_date: '2026-01-12', replacement_date: '2026-01-14' }), []);
  assert.deepEqual(validateOverride({ original_date: '2026-01-12', replacement_date: null }), []);
});

test('validateOverride: rejects replacement_date equal to original_date', () => {
  const errors = validateOverride({ original_date: '2026-01-12', replacement_date: '2026-01-12' });
  assert.ok(errors.some((e) => e.includes('differ')));
});

test('validateOverride: rejects malformed dates', () => {
  assert.ok(validateOverride({ original_date: 'not-a-date', replacement_date: null }).length > 0);
  assert.ok(validateOverride({ original_date: '2026-01-12', replacement_date: 'nope' }).length > 0);
});

test('validateRange: accepts exactly the 731-day ceiling and rejects one day more (invariant #7)', () => {
  assert.deepEqual(validateRange('2026-01-01', '2028-01-01'), []); // 731 days inclusive
  const errors = validateRange('2026-01-01', '2028-01-02'); // 732 days inclusive
  assert.ok(errors.some((e) => e.includes(String(OCCURRENCE_RANGE_MAX_DAYS))));
});

test('validateRange: rejects to before from', () => {
  assert.ok(validateRange('2026-06-01', '2026-01-01').length > 0);
});

test('validateType: requires a name and defaults icon/color', () => {
  const { value, errors } = validateType({ name: 'Recycling' });
  assert.deepEqual(errors, []);
  assert.equal(value.name, 'Recycling');
  assert.equal(value.icon, 'trash-2');
  assert.match(value.color, /^#[0-9A-Fa-f]{6}$/);
});

test('validateType: rejects a missing name', () => {
  assert.ok(validateType({ name: '' }).errors.length > 0);
});

test('validateType: partial mode only checks provided keys', () => {
  const { value, errors } = validateType({ archived: true }, { partial: true });
  assert.deepEqual(errors, []);
  assert.equal(value.archived, 1);
  assert.equal(value.name, undefined);
});

test('validateOneOff: requires a valid date', () => {
  assert.ok(validateOneOff({ date: 'nope' }).errors.length > 0);
  assert.deepEqual(validateOneOff({ date: '2026-03-01' }).errors, []);
});

// -------------------------------------------------------------------------
// scheduleToRule
// -------------------------------------------------------------------------

test('scheduleToRule: weekly schedule becomes FREQ=WEEKLY with BYDAY and the stored anchor', () => {
  const { rrule, anchor } = scheduleToRule(weeklySchedule());
  assert.equal(rrule, 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH');
  assert.equal(anchor, '2026-01-05');
});

test('scheduleToRule: fixed-day monthly carries no BYMONTHDAY (day comes from the anchor)', () => {
  const { rrule } = scheduleToRule(monthlySchedule());
  assert.equal(rrule, 'FREQ=MONTHLY;INTERVAL=1');
});

test('scheduleToRule: last-day-of-month sets BYMONTHDAY=-1', () => {
  const { rrule } = scheduleToRule(monthlySchedule({ anchor_date: '2026-01-31', month_day: -1 }));
  assert.equal(rrule, 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1');
});

test('scheduleToRule: valid_until maps onto RRULE UNTIL', () => {
  const { rrule } = scheduleToRule(weeklySchedule({ valid_until: '2026-03-01' }));
  assert.equal(rrule, 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH;UNTIL=20260301');
});

// -------------------------------------------------------------------------
// expandSchedule - recurrence edges (ground-truthed against recurrence.js)
// -------------------------------------------------------------------------

test('expandSchedule: weekly multi-weekday only lands on the selected weekdays', () => {
  const occ = expandSchedule(weeklySchedule(), [], '2026-01-01', '2026-01-31');
  const dates = occ.map((o) => o.date_key);
  assert.deepEqual(dates, [
    '2026-01-05', '2026-01-08', '2026-01-12', '2026-01-15',
    '2026-01-19', '2026-01-22', '2026-01-26', '2026-01-29',
  ]);
  for (const d of dates) {
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    assert.ok(weekday === 1 || weekday === 4, `${d} must be Monday or Thursday`);
  }
});

test('expandSchedule: fixed month-day never clamps (2026-01-15 through 2026-04-15)', () => {
  const occ = expandSchedule(monthlySchedule(), [], '2026-01-01', '2026-04-30');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
});

test('expandSchedule: last-day-of-month clamps through a short month and a leap February', () => {
  const schedule = monthlySchedule({ anchor_date: '2026-01-31', month_day: -1 });
  const occ = expandSchedule(schedule, [], '2026-01-01', '2026-04-30');
  // 2026-02-28 (not leap) then 2026-03-31, 2026-04-30 - each the true last day, never drifting.
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('expandSchedule: last-day-of-month hits Feb 29 in a leap year', () => {
  const schedule = monthlySchedule({ anchor_date: '2028-01-31', month_day: -1 });
  const occ = expandSchedule(schedule, [], '2028-01-01', '2028-03-31');
  assert.deepEqual(occ.map((o) => o.date_key), ['2028-01-31', '2028-02-29', '2028-03-31']);
});

test('expandSchedule: interval > 1 skips the right number of cycles (biweekly, every-3-months)', () => {
  const weekly = expandSchedule(weeklySchedule({ weekdays: 'MO', interval: 2 }), [], '2026-01-01', '2026-03-01');
  assert.deepEqual(weekly.map((o) => o.date_key), ['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16']);

  const monthly = expandSchedule(monthlySchedule({ interval: 3 }), [], '2026-01-01', '2026-12-31');
  assert.deepEqual(monthly.map((o) => o.date_key), ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
});

test('expandSchedule: ordinal weekday ("2nd Monday") lands on the correct date every month, including February', () => {
  // Mondays: Jan 5/12/19/26, Feb 2/9/16/23, Mar 2/9/16/23/30 - 2nd Monday each: Jan 12, Feb 9, Mar 9.
  const occ = expandSchedule(ordinalSchedule(), [], '2026-01-01', '2026-03-31');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-12', '2026-02-09', '2026-03-09']);
});

test('expandSchedule: "last Friday" ordinal schedule never clamps into the wrong week', () => {
  // Fridays: Jan 2/9/16/23/30, Feb 6/13/20/27, Mar 6/13/20/27 - last each: Jan 30, Feb 27, Mar 27.
  const schedule = ordinalSchedule({ anchor_date: '2026-01-30', weekdays: 'FR', month_day: -1 });
  const occ = expandSchedule(schedule, [], '2026-01-01', '2026-03-31');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-30', '2026-02-27', '2026-03-27']);
});

test('expandSchedule: ordinal weekday with interval > 1 steps whole months at a time', () => {
  // Every 3rd month, 2nd Monday: Jan 12 -> Apr 13 (Mondays in April: 6, 13, 20, 27) -> Jul 13.
  const schedule = ordinalSchedule({ interval: 3 });
  const occ = expandSchedule(schedule, [], '2026-01-01', '2026-12-31');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-12', '2026-04-13', '2026-07-13', '2026-10-12']);
});

test('expandSchedule: a move/skip override applies to an ordinal-weekday occurrence exactly like any other origin', () => {
  const overrides = [{ original_date: '2026-02-09', replacement_date: '2026-02-11' }];
  const occ = expandSchedule(ordinalSchedule(), overrides, '2026-01-01', '2026-03-31');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-12', '2026-02-11', '2026-03-09']);
  const moved = occ.find((o) => o.date_key === '2026-02-11');
  assert.equal(moved.original_date, '2026-02-09');
  assert.equal(moved.moved, true);
});

test('expandSchedule: valid_until stops the series (via RRULE UNTIL, not reimplemented)', () => {
  const schedule = weeklySchedule({ weekdays: 'MO', valid_until: '2026-01-20' });
  const occ = expandSchedule(schedule, [], '2026-01-01', '2026-02-28');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-05', '2026-01-12', '2026-01-19']);
});

test('expandSchedule: an explicit skip removes exactly that occurrence', () => {
  const overrides = [{ original_date: '2026-01-12', replacement_date: null }];
  const occ = expandSchedule(weeklySchedule({ weekdays: 'MO' }), overrides, '2026-01-01', '2026-01-31');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-05', '2026-01-19', '2026-01-26']);
});

test('expandSchedule: a move relocates the occurrence and records original_date + moved', () => {
  const overrides = [{ original_date: '2026-01-12', replacement_date: '2026-01-14' }];
  const occ = expandSchedule(weeklySchedule({ weekdays: 'MO' }), overrides, '2026-01-01', '2026-01-31');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-05', '2026-01-14', '2026-01-19', '2026-01-26']);
  const moved = occ.find((o) => o.date_key === '2026-01-14');
  assert.equal(moved.original_date, '2026-01-12');
  assert.equal(moved.moved, true);
  const unmoved = occ.find((o) => o.date_key === '2026-01-05');
  assert.equal(unmoved.original_date, null);
  assert.equal(unmoved.moved, false);
});

test('expandSchedule: a move whose original date is before `from` is still found (walks from the anchor)', () => {
  const overrides = [{ original_date: '2026-01-05', replacement_date: '2026-01-20' }];
  const occ = expandSchedule(weeklySchedule({ weekdays: 'MO' }), overrides, '2026-01-15', '2026-01-31');
  const dates = occ.map((o) => o.date_key);
  assert.ok(dates.includes('2026-01-20'), 'the moved-in occurrence must appear even though its original date is outside the range');
  assert.equal(occ.find((o) => o.date_key === '2026-01-20').original_date, '2026-01-05');
});

test('expandSchedule: a move out of range simply disappears (no phantom left at the original date)', () => {
  const overrides = [{ original_date: '2026-01-12', replacement_date: '2026-03-01' }];
  const occ = expandSchedule(weeklySchedule({ weekdays: 'MO' }), overrides, '2026-01-01', '2026-01-31');
  assert.deepEqual(occ.map((o) => o.date_key), ['2026-01-05', '2026-01-19', '2026-01-26']);
});

// -------------------------------------------------------------------------
// coalesceOccurrences / resolveOccurrences - identity, provenance, ordering
// -------------------------------------------------------------------------

const TYPE_A = { id: 1, name: 'Recycling', icon: 'recycle', color: '#22C55E', sort_order: 0, archived: 0 };
const TYPE_B = { id: 2, name: 'Compost', icon: 'leaf', color: '#84CC16', sort_order: 1, archived: 0 };

test('coalesceOccurrences: two origins on the same (type, date) coalesce into one occurrence with ordered provenance', () => {
  const raw = [
    { type_id: 1, date_key: '2026-01-12', origin: { kind: 'one_off', one_off_id: 5, moved: false } },
    { type_id: 1, date_key: '2026-01-12', origin: { kind: 'schedule', schedule_id: 10, moved: false } },
  ];
  const [occ] = coalesceOccurrences(raw, new Map([[1, TYPE_A]]));
  assert.equal(occ.coalesced, true);
  assert.equal(occ.origins.length, 2);
  // schedule sorts before one_off regardless of input order (invariant #3's provenance order).
  assert.deepEqual(occ.origins.map((o) => o.kind), ['schedule', 'one_off']);
  assert.equal(occ.key, '1:2026-01-12');
  assert.equal(occ.deep_link, '?type=1&date=2026-01-12');
});

test('resolveOccurrences: a moved schedule occurrence does not erase a same-day one-off from another origin (invariant #4)', () => {
  const schedule = weeklySchedule({ id: 10, type_id: 1, weekdays: 'MO' });
  const overridesBySchedule = new Map([[10, [{ original_date: '2026-01-12', replacement_date: '2026-01-14' }]]]);
  const oneOffs = [{ id: 99, type_id: 1, date: '2026-01-12' }];

  const occurrences = resolveOccurrences({
    types: [TYPE_A], schedules: [schedule], overridesBySchedule, oneOffs,
    from: '2026-01-01', to: '2026-01-31',
  });

  const onOriginal = occurrences.find((o) => o.date_key === '2026-01-12');
  assert.ok(onOriginal, 'the original date must still show because the one-off still supplies it');
  assert.equal(onOriginal.moved, false);
  assert.equal(onOriginal.coalesced, false);
  assert.deepEqual(onOriginal.origins.map((o) => o.kind), ['one_off']);

  const onReplacement = occurrences.find((o) => o.date_key === '2026-01-14');
  assert.ok(onReplacement, 'the moved-to date must show the schedule origin');
  assert.equal(onReplacement.moved, true);
  assert.deepEqual(onReplacement.origins.map((o) => o.kind), ['schedule']);
});

test('resolveOccurrences: an inactive (paused) schedule contributes nothing', () => {
  const schedule = weeklySchedule({ weekdays: 'MO', active: 0 });
  const occurrences = resolveOccurrences({
    types: [TYPE_A], schedules: [schedule], overridesBySchedule: new Map(), oneOffs: [],
    from: '2026-01-01', to: '2026-01-31',
  });
  assert.deepEqual(occurrences, []);
});

test('resolveOccurrences: an archived type\'s schedule still projects (archived only blocks deletion, not the range read)', () => {
  const archived = { ...TYPE_A, archived: 1 };
  const schedule = weeklySchedule({ weekdays: 'MO' });
  const occurrences = resolveOccurrences({
    types: [archived], schedules: [schedule], overridesBySchedule: new Map(), oneOffs: [],
    from: '2026-01-01', to: '2026-01-10',
  });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].date_key, '2026-01-05');
});

test('resolveOccurrences: deterministic order - by date, then by type sort_order, then type id', () => {
  const scheduleA = weeklySchedule({ id: 10, type_id: 1, weekdays: 'MO' });
  const scheduleB = weeklySchedule({ id: 11, type_id: 2, weekdays: 'MO' });
  const occurrences = resolveOccurrences({
    types: [TYPE_B, TYPE_A], // deliberately passed out of sort_order to prove the resolver sorts, not the input
    schedules: [scheduleA, scheduleB], overridesBySchedule: new Map(), oneOffs: [],
    from: '2026-01-05', to: '2026-01-05',
  });
  assert.equal(occurrences.length, 2);
  assert.deepEqual(occurrences.map((o) => o.type_id), [1, 2]); // TYPE_A.sort_order(0) before TYPE_B.sort_order(1)
});

test('resolveOccurrences: a type absent from the `types` list contributes nothing (defense against orphaned rows)', () => {
  const schedule = weeklySchedule({ type_id: 999, weekdays: 'MO' });
  const occurrences = resolveOccurrences({
    types: [TYPE_A], schedules: [schedule], overridesBySchedule: new Map(), oneOffs: [],
    from: '2026-01-01', to: '2026-01-31',
  });
  assert.deepEqual(occurrences, []);
});

// -------------------------------------------------------------------------
// nextPerType - time-injected (todayKey passed in, no wall clock read)
// -------------------------------------------------------------------------

test('nextPerType: returns exactly one earliest occurrence per active type, sorted by type order', () => {
  const scheduleA = weeklySchedule({ id: 10, type_id: 1, weekdays: 'MO,TH' });
  const scheduleB = monthlySchedule({ id: 20, type_id: 2, anchor_date: '2026-01-20', month_day: 20 });
  const result = nextPerType({
    types: [TYPE_B, TYPE_A], schedules: [scheduleA, scheduleB], overridesBySchedule: new Map(), oneOffs: [],
    todayKey: '2026-01-06',
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].type.id, 1);
  assert.equal(result[0].next.date_key, '2026-01-08'); // next Mon/Thu at or after Jan 6 is Thursday Jan 8
  assert.equal(result[1].type.id, 2);
  assert.equal(result[1].next.date_key, '2026-01-20');
});

test('nextPerType: a type with no upcoming occurrence within the horizon reports next: null', () => {
  const schedule = weeklySchedule({ weekdays: 'MO', valid_until: '2026-01-10' });
  const result = nextPerType({
    types: [TYPE_A], schedules: [schedule], overridesBySchedule: new Map(), oneOffs: [],
    todayKey: '2026-06-01',
  });
  assert.equal(result[0].next, null);
});

test('nextPerType: archived types are excluded entirely, even with an upcoming occurrence', () => {
  const archived = { ...TYPE_A, archived: 1 };
  const schedule = weeklySchedule({ weekdays: 'MO' });
  const result = nextPerType({
    types: [archived], schedules: [schedule], overridesBySchedule: new Map(), oneOffs: [],
    todayKey: '2026-01-01',
  });
  assert.deepEqual(result, []);
});

test('nextPerType: a one-off-only type (no schedule at all) is still found', () => {
  const oneOffs = [{ id: 1, type_id: 1, date: '2026-03-01' }];
  const result = nextPerType({
    types: [TYPE_A], schedules: [], overridesBySchedule: new Map(), oneOffs, todayKey: '2026-01-01',
  });
  assert.equal(result[0].next.date_key, '2026-03-01');
  assert.deepEqual(result[0].next.origins.map((o) => o.kind), ['one_off']);
});
