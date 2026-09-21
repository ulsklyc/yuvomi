import test from 'node:test';
import assert from 'node:assert/strict';
import { fastingHelpHtml } from '../public/components/fasting-help.js';
import { renderFastingStats } from '../public/components/health-fasting-insights.js';
import {
  normalizeGoalHours,
  fastingTimerModel,
  fastingDialModel,
  formatFastingDuration,
  formatFastingClock,
  fastingClockModel,
  fastingDisplayModel,
  fastingServerDate,
  fastingServerClock,
  fastingCompletionCalendarHint,
  fastingHistoryQuery,
  fastingStatsQuery,
  shouldLoadFastingStats,
} from '../public/utils/health-fasting.js';
import { withLocales } from './i18n-env.js';

test('journal filters stay out of stats requests and completion hints name their calendar', () => {
  const view = { self: 1, subject: 2, from: '2026-09-01', to: '2026-09-30' };
  assert.equal(fastingHistoryQuery(view), '?user_id=2&from=2026-09-01&to=2026-09-30');
  assert.equal(fastingStatsQuery(view), '?user_id=2');
  assert.equal(fastingCompletionCalendarHint('Europe/Prague'), 'health.fasting.completedFrom / health.fasting.completedTo: settings.timezoneLabel - Europe/Prague');
  assert.equal(fastingCompletionCalendarHint(''), '');
});

test('insights reload only when absent or after a failed request', () => {
  assert.equal(shouldLoadFastingStats(undefined, false), true);
  assert.equal(shouldLoadFastingStats(null, true), true);
  assert.equal(shouldLoadFastingStats({ currentStreak: 2 }, false), false);
});

test('help markup remains importable without a DOM and escapes labels with unique associations', () => {
  const first = fastingHelpHtml('<Goal>', ['Full guidance']), second = fastingHelpHtml('Goal', ['Full guidance']);
  assert.match(first, /^<yuvomi-fasting-help>/);
  assert.match(first, /<\/yuvomi-fasting-help>$/);
  assert.match(first, /&lt;Goal&gt;/);
  assert.match(first, /data-lucide="info"/);
  assert.notEqual(first.match(/id="([^"]+)"/)[1], second.match(/id="([^"]+)"/)[1]);
});

test('insights transport errors leave an explicit fallback instead of hiding the journal', () => {
  assert.equal(renderFastingStats(null), '');
  const fallback = renderFastingStats(null, { error: true });
  assert.match(fallback, /role="status"/);
  assert.match(fallback, /fasting-stats/);
});

test('partial weekly goal coverage pluralizes by recorded goals, not all fasts', () => {
  const empty = { count: 0, totalMinutes: 0, averageMinutes: 0 };
  const markup = renderFastingStats({
    allTime: empty, year: empty, last30Days: empty,
    currentStreak: 0, longestStreak: 0,
    weekly: [{ date: '2026-09-18', count: 2, totalMinutes: 120, goalMinutes: 60, goalCount: 1, hasRecord: true }],
  });
  assert.match(markup, /health\.fasting\.goalCoverage\{&quot;count&quot;:1,&quot;records&quot;:1,&quot;total&quot;:2\}/);
});

test('goal normalization accepts whole hours 1 through 336 and null', () => {
  assert.equal(normalizeGoalHours(null), null);
  assert.equal(normalizeGoalHours('16'), 960);
  assert.throws(() => normalizeGoalHours('16.5'), /whole hours/);
  assert.throws(() => normalizeGoalHours(337), /336/);
});

test('completed-entry defaults require a valid server clock', () => {
  assert.equal(fastingServerDate('2026-09-14T10:20:30.000Z').toISOString(), '2026-09-14T10:20:30.000Z');
  assert.throws(() => fastingServerDate(), /FASTING_SERVER_TIME_UNAVAILABLE/);
  assert.throws(() => fastingServerDate('not-a-date'), /FASTING_SERVER_TIME_UNAVAILABLE/);
});

test('derived server clock advances by device elapsed time after capture', () => {
  let deviceNow = Date.parse('2026-09-15T09:57:00.000Z');
  const serverNow = fastingServerClock('2026-09-15T10:00:00.000Z', () => deviceNow);

  assert.equal(serverNow(), Date.parse('2026-09-15T10:00:00.000Z'));
  deviceNow += 90_000;
  assert.equal(serverNow(), Date.parse('2026-09-15T10:01:30.000Z'));
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

// Interface language and region are set apart (test/i18n-env.js), otherwise the
// test cannot see which of them supplies the word: with both left at `de` it
// compared against Intl('de'), and "1 Tg. 1 Std. 7 Min." under an English
// interface stayed green (#1365). The word belongs to the person, the number to
// the household.
test('duration formatter preserves days and minutes in the interface language with region digits', async () => {
  const duration = 25 * 60 + 7;
  await withLocales({ language: 'en', region: 'de-DE' }, () => {
    assert.equal(formatFastingDuration(duration), '1 day 1 hr 7 min');
    assert.equal(formatFastingDuration(1000 * 24 * 60 + 60), '1.000 days 1 hr', 'grouping from the region');
    assert.equal(formatFastingDuration(0), '0 min');
  });
  await withLocales({ language: 'de', region: 'de-DE' }, () => {
    assert.equal(formatFastingDuration(duration), '1 Tg. 1 Std. 7 Min.');
  });
  await withLocales({ language: 'en', region: 'ar-SA' }, () => {
    assert.equal(formatFastingDuration(duration), '١ day ١ hr ٧ min');
  });
  await withLocales({ language: 'fr', region: 'de-CH' }, () => {
    assert.equal(formatFastingDuration(1000 * 24 * 60 + 60), "1'000\u202fj 1\u202fh");
  });
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
