import test from 'node:test';
import assert from 'node:assert/strict';
import { fastingHelpHtml } from '../public/components/fasting-help.js';
import {
  normalizeGoalHours,
  fastingTimerModel,
  fastingDialModel,
  formatFastingDuration,
  formatFastingClock,
  fastingClockModel,
  fastingDisplayModel,
} from '../public/utils/health-fasting.js';

test('help markup remains importable without a DOM and escapes labels with unique associations', () => {
  const first = fastingHelpHtml('<Goal>', ['Full guidance']), second = fastingHelpHtml('Goal', ['Full guidance']);
  assert.match(first, /^<yuvomi-fasting-help>/);
  assert.match(first, /<\/yuvomi-fasting-help>$/);
  assert.match(first, /&lt;Goal&gt;/);
  assert.match(first, /data-lucide="info"/);
  assert.notEqual(first.match(/id="([^"]+)"/)[1], second.match(/id="([^"]+)"/)[1]);
});

test('goal normalization accepts whole hours 1 through 336 and null', () => {
  assert.equal(normalizeGoalHours(null), null);
  assert.equal(normalizeGoalHours('16'), 960);
  assert.throws(() => normalizeGoalHours('16.5'), /whole hours/);
  assert.throws(() => normalizeGoalHours(337), /336/);
});

test('display preference cannot count down without a goal and progress always fills forward', () => {
  const active = { start_at: '2026-01-01T00:00:00Z', goal_minutes: 60 };
  const now = Date.parse('2026-01-01T00:30:00Z');
  assert.equal(fastingDisplayModel(active, null, 'auto', now).mode, 'remaining');
  assert.equal(fastingDisplayModel(active, null, 'remaining', now).displaySeconds, 1800);
  assert.equal(fastingDisplayModel(active, null, 'elapsed', now).progress, 50);
  assert.equal(fastingDisplayModel({ ...active, goal_minutes: null }, null, 'remaining', now).mode, 'elapsed');
  const over = fastingDisplayModel(active, null, 'remaining', now + 3600000);
  assert.equal(over.displaySeconds, 0);
  assert.equal(over.overtime, 1800);
  assert.equal(over.progress, 100);
});


test('timer uses instants and marks an over-goal fast without stopping it', () => {
  const model = fastingTimerModel({
    startAt: '2026-09-13T08:00:00.000Z',
    goalMinutes: 960,
    now: new Date('2026-09-14T02:30:00.000Z'),
  });
  assert.deepEqual(model, {
    elapsedMinutes: 1110,
    dayCount: 0,
    goalReached: true,
    goalDeltaMinutes: 150,
  });
});

test('dial caps explicit segments at fourteen and zones only belong to day one', () => {
  const model = fastingDialModel({
    elapsedMinutes: 15 * 1440 + 90,
    goalMinutes: 14 * 1440,
    zoneMode: 'educational',
  });
  assert.equal(model.visibleDaySegments.length, 14);
  assert.equal(model.additionalDays, 1);
  assert.ok(model.zones.every((zone) => zone.day === 1));
});

test('dial reserves future goal days and uses neutral overlapping educational phases', () => {
  assert.equal(fastingDialModel({ elapsedMinutes: 60, goalMinutes: 4320 }).visibleDaySegments.length, 3);
  const zones = fastingDialModel({ zoneMode: 'educational' }).zones;
  assert.equal(zones[0].key, 'health.fasting.zoneMeal');
  assert.ok(zones[1].startMinute < zones[0].endMinute);
  assert.equal(fastingDialModel({ zoneMode: 'timer' }).zones.length, 0);
});

test('duration formatter preserves days and minutes', () => {
  assert.equal(formatFastingDuration(25 * 60 + 7), '1 d 1 h 7 min');
});

test('clock ticks within the first minute and never wraps total hours', () => {
  assert.equal(formatFastingClock(1), '00:00:01');
  assert.equal(formatFastingClock(3661), '01:01:01');
  assert.equal(formatFastingClock(360061), '100:01:01');
  assert.equal(formatFastingClock(-1), '00:00:00');
});

test('running and idle clocks use their own anchors and expose remaining goal time', () => {
  const now = Date.parse('2026-09-14T10:00:01Z');
  const active = { start_at: '2026-09-13T08:00:00Z', goal_minutes: 2880 };
  const running = fastingClockModel(active, null, now);
  assert.equal(running.seconds, 93601);
  assert.equal(running.days, 1);
  assert.equal(running.remaining, 79199);
  assert.equal(running.reached, false);
  const completed = fastingClockModel(null, { end_at: '2026-09-14T10:00:00Z' }, now);
  assert.equal(completed.seconds, 1);
  assert.equal(completed.remaining, null);
  assert.equal(fastingClockModel(null, null, now).hasAnchor, false);
  assert.equal(fastingClockModel({ ...active, goal_minutes: 60 }, null, now).reached, true);
});
