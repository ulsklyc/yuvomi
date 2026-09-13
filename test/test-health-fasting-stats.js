import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFastingRows, fastingStreaks, weeklyFastingSeries } from '../server/services/fasting-stats.js';

const rows = [
  { start_at: '2026-09-01T06:00:00.000Z', end_at: '2026-09-01T22:00:00.000Z', goal_minutes: 960, start_tzid: 'Europe/Prague' },
  { start_at: '2026-09-02T06:00:00.000Z', end_at: '2026-09-03T08:00:00.000Z', goal_minutes: 960, start_tzid: 'Europe/Prague' },
  { start_at: '2026-08-30T06:00:00.000Z', end_at: '2026-08-30T10:00:00.000Z', goal_minutes: 960, start_tzid: 'Europe/Prague' },
];

test('summaries count completed fasts and calculate total/average minutes', () => {
  assert.deepEqual(summarizeFastingRows(rows), { count: 3, totalMinutes: 2760, averageMinutes: 920 });
});

test('streak credits target-or-longer fasts by recorded timezone completion date', () => {
  const result = fastingStreaks(rows, { today: '2026-09-03', targetZone: 'Europe/Prague' });
  assert.equal(result.current, 2);
  assert.equal(result.longest, 2);
});

test('each record uses its captured zone for streak and weekly completion dates', () => {
  const sameInstant = '2026-09-13T22:30:00.000Z';
  const prague = { id: 1, start_at: '2026-09-13T06:30:00.000Z', end_at: sameInstant, goal_minutes: 960, start_tzid: 'Europe/Prague' };
  const losAngeles = { id: 2, start_at: '2026-09-13T06:30:00.000Z', end_at: sameInstant, goal_minutes: 960, start_tzid: 'America/Los_Angeles' };
  assert.deepEqual(fastingStreaks([prague], { today: '2026-09-14' }), { current: 1, longest: 1 });
  const series = weeklyFastingSeries([prague, losAngeles], { endDate: '2026-09-14' });
  assert.deepEqual(series.slice(-2), [
    { date: '2026-09-13', count: 1, totalMinutes: 960, goalMinutes: 960, goalCount: 1, hasRecord: true },
    { date: '2026-09-14', count: 1, totalMinutes: 960, goalMinutes: 960, goalCount: 1, hasRecord: true },
  ]);
});

test('summaries count sub-minute records and weekly series distinguishes no record and no goal', () => {
  const rows = [
    { id: 1, start_at: '2026-09-13T10:00:00.000Z', end_at: '2026-09-13T10:00:30.000Z', goal_minutes: null, start_tzid: 'UTC' },
    { id: 2, start_at: '2026-09-14T01:00:00.000Z', end_at: '2026-09-14T03:00:00.000Z', goal_minutes: 60, start_tzid: 'UTC' },
    { id: 3, start_at: '2026-09-14T04:00:00.000Z', end_at: '2026-09-14T07:00:00.000Z', goal_minutes: 120, start_tzid: 'UTC' },
  ];
  assert.deepEqual(summarizeFastingRows(rows.slice(0, 1)), { count: 1, totalMinutes: 0, averageMinutes: 0 });
  const series = weeklyFastingSeries(rows, { endDate: '2026-09-14' });
  assert.deepEqual(series.at(-3), { date: '2026-09-12', count: 0, totalMinutes: 0, goalMinutes: null, goalCount: 0, hasRecord: false });
  assert.deepEqual(series.at(-2), { date: '2026-09-13', count: 1, totalMinutes: 0, goalMinutes: null, goalCount: 0, hasRecord: true });
  assert.deepEqual(series.at(-1), { date: '2026-09-14', count: 2, totalMinutes: 300, goalMinutes: 180, goalCount: 2, hasRecord: true });
});

test('weekly series always contains seven buckets', () => {
  const series = weeklyFastingSeries(rows, { endDate: '2026-09-03', timeZone: 'Europe/Prague' });
  assert.equal(series.length, 7);
  assert.ok(series.every((bucket) => typeof bucket.date === 'string' && Number.isInteger(bucket.count)));
});

test('a very long fast is counted exactly without allocating an entry per day', (context) => {
  // Stop the old implementation at its allocation boundary so the regression
  // can run RED safely, without actually exhausting the test runner's memory.
  const from = Array.from;
  context.mock.method(Array, 'from', (value, ...args) => {
    assert.ok(!(value?.length > 1000), 'streak calculation must not expand elapsed days');
    return from(value, ...args);
  });
  const long = { start_at: '-200000-01-01T00:00:00Z', end_at: '2026-09-01T00:00:00Z', goal_minutes: 60, start_tzid: 'UTC' };
  assert.deepEqual(fastingStreaks([long], { today: '2026-09-02' }), { current: 73788725, longest: 73788725 });
});

test('interval streaks merge overlaps and adjacency but preserve gaps and goal eligibility', () => {
  const fast = (start, end, goal = 60) => ({ start_at: start, end_at: end, goal_minutes: goal });
  const history = [
    fast('2026-01-01T01:00Z', '2026-01-01T02:00Z'),
    fast('2026-01-02T01:00Z', '2026-01-03T02:00Z'),
    fast('2026-01-03T03:00Z', '2026-01-03T04:00Z'),
    fast('2026-01-04T01:00Z', '2026-01-06T02:00Z'),
    fast('2026-01-07T01:00Z', '2026-01-07T02:00Z', null),
    fast('2026-01-07T03:00Z', '2026-01-07T04:00Z', 120),
    fast('2026-01-08T01:00Z', '2026-01-08T02:00Z'),
  ];
  assert.deepEqual(fastingStreaks(history, { today: '2026-01-09' }), { current: 1, longest: 6 });
  assert.deepEqual(fastingStreaks(history.toReversed(), { today: '2026-01-10' }), { current: 0, longest: 6 });
  assert.deepEqual(fastingStreaks(history.slice(0, 4), { today: '2026-01-06' }), { current: 6, longest: 6 });
});

test('interval calendar arithmetic supports early years, eras and Gregorian leap boundaries', () => {
  const fast = (date) => ({ start_at: `${date}T01:00Z`, end_at: `${date}T02:00Z`, goal_minutes: 60 });
  for (const dates of [
    ['-000001-12-31', '0000-01-01'],
    ['0000-02-28', '0000-02-29', '0000-03-01'],
    ['0100-02-28', '0100-03-01'],
    ['2000-02-28', '2000-02-29', '2000-03-01'],
  ]) assert.deepEqual(fastingStreaks(dates.map(fast), { today: dates.at(-1) }), { current: dates.length, longest: dates.length });
});

test('credit lengths retain the 24-hour boundary and equivalent offset instants', () => {
  for (const [end, count] of [['2026-01-02T00:00Z', 1], ['2026-01-02T01:00Z', 2], ['2026-01-03T01:00Z', 3]]) {
    const fast = { start_at: '2026-01-01T01:00+01:00', end_at: end, goal_minutes: 60 };
    assert.equal(fastingStreaks([fast], { today: '2026-01-03' }).longest, count);
  }
});

test('streak credit ceiling uses exact duration beyond a whole-day boundary', () => {
  const row = {
    start_at: '2026-09-01T00:00:00.000Z',
    end_at: '2026-09-02T00:00:30.000Z',
    goal_minutes: 60,
    start_tzid: 'UTC',
  };
  assert.deepEqual(fastingStreaks([row], { today: '2026-09-02' }), { current: 2, longest: 2 });
});
