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

/* DER FASTEN-RING (Critique 2026-09-26, A6 P2-3): einmal gebaut, danach wandert
 * nur die Laenge der Spur - frueher schrieb der Takt jede Minute das ganze SVG
 * neu, eine Transition konnte so nie greifen. Gemessen wird ueber den AUFRUFER
 * (updateFastingClock), nicht ueber den Helfer allein: der Takt ist es, der
 * neu baut oder nicht. Die Stubs zaehlen, wie oft der Ring-Traeger geleert wird. */
function dialHost() {
  const host = {
    dataset: {}, rebuilds: 0, traces: [],
    replaceChildren() { host.rebuilds += 1; host.traces = []; },
    insertAdjacentHTML(_where, html) {
      host.html = html;
      host.traces = [...html.matchAll(/<circle class="(fasting-dial__trace[^"]*)"[^>]*stroke-dasharray="([^"]+)"/g)]
        .map(([, cls, dash]) => {
          const classes = new Set(cls.split(' '));
          const attrs = new Map([['stroke-dasharray', dash]]);
          return {
            getAttribute: (n) => attrs.get(n) ?? null,
            setAttribute: (n, v) => { attrs.set(n, String(v)); },
            classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
          };
        });
    },
    querySelectorAll: (sel) => (sel === '.fasting-dial__trace' ? host.traces : []),
  };
  return host;
}

function clockRoot(dial) {
  const node = () => ({ hidden: false, textContent: '00:00:00', dataset: {}, style: { setProperty() {} } });
  const parts = {
    '[data-fasting-timer]': node(), '[data-fasting-clock-label]': node(), '[data-fasting-days]': node(),
    '[data-fasting-announcement]': node(), '.fasting-clock-switch': node(), '[data-fasting-progress]': node(),
    '[data-fasting-segments]': dial,
  };
  return { parts, querySelector: (sel) => parts[sel] ?? null, querySelectorAll: () => [] };
}

test('the fasting dial is built once and only its trace length moves with the clock', async () => {
  {
    const { updateFastingClock } = await import('../public/components/fasting-controls.js');
    const dial = dialHost();
    const root = clockRoot(dial);
    const start = Date.parse('2026-09-26T00:00:00Z');
    const active = { start_at: new Date(start).toISOString(), goal_minutes: 960 };
    const RealNow = Date.now;
    try {
      Date.now = () => start + 2 * 3600e3;
      updateFastingClock(root, active, null, {});
      assert.equal(dial.rebuilds, 1, 'the first tick builds the dial');
      const first = dial.traces[0].getAttribute('stroke-dasharray');
      Date.now = () => start + 2 * 3600e3 + 1000;
      updateFastingClock(root, active, null, {});
      Date.now = () => start + 3 * 3600e3;
      updateFastingClock(root, active, null, {});
      assert.equal(dial.rebuilds, 1, 'later ticks of the same shape do not rewrite the SVG');
      assert.notEqual(dial.traces[0].getAttribute('stroke-dasharray'), first, 'the trace length follows the clock');
      assert.match(dial.traces[0].getAttribute('stroke-dasharray'), /^12\.5 87\.5$/, '3 h of a one-day dial');
    } finally { Date.now = RealNow; }
  }
});

test('a resting fasting clock shows no zeros, no day and no elapsed/remaining switch', async () => {
  {
    const { updateFastingClock } = await import('../public/components/fasting-controls.js');
    const root = clockRoot(dialHost());
    updateFastingClock(root, null, null, {});
    assert.equal(root.parts['[data-fasting-timer]'].hidden, true, 'no fast ever: no 00:00:00');
    assert.equal(root.parts['[data-fasting-days]'].hidden, true, 'no running fast: no "day 0"');
    assert.equal(root.parts['.fasting-clock-switch'].hidden, true, 'nothing to switch while resting');
    assert.equal(root.parts['[data-fasting-announcement]'].textContent, '', 'no "since last fast: 00:00:00"');
    assert.ok(!/00:00:00/.test(root.parts['[data-fasting-timer]'].textContent));
    // Gegenprobe: laeuft ein Fasten, ist alles wieder da.
    const running = clockRoot(dialHost());
    updateFastingClock(running, { start_at: new Date(Date.now() - 3600e3).toISOString(), goal_minutes: 960 }, null, {});
    assert.equal(running.parts['[data-fasting-timer]'].hidden, false);
    assert.equal(running.parts['[data-fasting-days]'].hidden, false);
    assert.equal(running.parts['.fasting-clock-switch'].hidden, false);
    // Nach einem Fasten zaehlt die Zeit seitdem, aber es gibt keinen Fastentag.
    const since = clockRoot(dialHost());
    updateFastingClock(since, null, { end_at: new Date(Date.now() - 3600e3).toISOString() }, {});
    assert.equal(since.parts['[data-fasting-timer]'].hidden, false);
    assert.match(since.parts['[data-fasting-timer]'].textContent, /^01:00:0\d$/);
    assert.equal(since.parts['[data-fasting-days]'].hidden, true);
  }
});

test('the fasting ring is a real stroke with round ends whose trace moves by transition', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/fasting-controls.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const base = rules.find((r) => r.selector === '.fasting-dial__svg circle' && !r.at.length);
  assert.ok(base, 'the dial stroke rule is gone');
  assert.ok(Number(/stroke-width:\s*(\d+)/.exec(base.body)?.[1]) >= 8, 'stroke of about 10/120, not a 3/120 hairline');
  assert.match(base.body, /stroke-linecap:\s*round/);
  const trace = rules.find((r) => r.selector === '.fasting-dial__trace' && !r.at.length);
  assert.match(trace?.body ?? '', /transition:\s*stroke-dasharray\s+var\(--duration-[a-z0-9]+\)\s+var\(--ease-[a-z-]+\)/);
  const reduced = rules.find((r) => r.selector === '.fasting-dial__trace' && r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
  assert.match(reduced?.body ?? '', /transition:\s*none/, 'reduced motion: the trace jumps');
  // `hidden` muss gegen die display-Regeln der Traeger gewinnen, sonst bleibt
  // der Ruhezustand bei Nullen stehen, obwohl das Attribut gesetzt ist.
  for (const sel of ['.fasting-clock-switch[hidden]', '[data-fasting-timer][hidden]', '[data-fasting-days][hidden]']) {
    assert.ok(rules.some((r) => r.selector.split(',').map((s) => s.trim()).includes(sel) && /display:\s*none/.test(r.body)), `${sel} hides`);
  }
});
