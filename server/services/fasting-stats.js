/** Pure server-side fasting summaries; resource use scales with record count. */
import { fastingDateKey } from './fasting-dates.js';

const DAY = 24 * 60;

function duration(row) {
  const start = Date.parse(row?.start_at);
  const end = Date.parse(row?.end_at);
  const milliseconds = end - start;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? { milliseconds, minutes: Math.floor(milliseconds / 60000) }
    : null;
}

export function dateKeyInZone(value, timeZone = 'UTC') {
  return fastingDateKey(value, timeZone);
}

function addDays(key, amount) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function summarizeFastingRows(rows = []) {
  const durations = rows.map(duration).filter(Boolean);
  const totalMinutes = durations.reduce((sum, item) => sum + item.minutes, 0);
  return { count: durations.length, totalMinutes, averageMinutes: durations.length ? Math.round(totalMinutes / durations.length) : 0 };
}

// Gregorian calendar-day ordinal, without Date's year-0..99 remapping or
// TimeClip limits at the edges of the supported instant range.
function calendarDay(year, month, day) {
  const previousYear = year - 1;
  const beforeMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return 365 * year + Math.floor(previousYear / 4) - Math.floor(previousYear / 100)
    + Math.floor(previousYear / 400) + beforeMonth[month - 1] + day - 1
    + (leap && month > 2 ? 1 : 0);
}

function completionDay(value, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  return calendarDay(year, Number(parts.month), Number(parts.day));
}

export function fastingStreaks(rows = [], { today = dateKeyInZone(new Date()) } = {}) {
  // One inclusive interval per qualifying record. Actual fast duration is
  // deliberately unbounded, so neither memory nor work may grow per day.
  const intervals = [];
  const formatters = new Map();
  for (const row of rows) {
    const elapsed = duration(row);
    if (elapsed && row?.goal_minutes !== null && row?.goal_minutes !== undefined && elapsed.milliseconds >= Number(row.goal_minutes) * 60000) {
      const zone = row.start_tzid || 'UTC';
      let formatter = formatters.get(zone);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric' });
        formatters.set(zone, formatter);
      }
      const end = completionDay(row.end_at, formatter);
      intervals.push([end - Math.ceil(elapsed.milliseconds / (DAY * 60000)) + 1, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push(interval);
  }
  const match = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/.exec(today);
  const todayDay = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : NaN;
  let longest = 0;
  let current = 0;
  for (const [start, end] of merged) {
    const length = end - start + 1;
    longest = Math.max(longest, length);
    if (end === todayDay || end === todayDay - 1) current = length;
  }
  return { current, longest };
}

export function weeklyFastingSeries(rows = [], { endDate = dateKeyInZone(new Date()) } = {}) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(endDate, index - 6);
    const matches = rows.map((row) => ({ row, elapsed: duration(row) }))
      .filter(({ row, elapsed }) => elapsed && dateKeyInZone(row.end_at, row.start_tzid || 'UTC') === date);
    const goals = matches.map(({ row }) => row.goal_minutes).filter((goal) => goal !== null && goal !== undefined).map(Number);
    return {
      date,
      count: matches.length,
      totalMinutes: matches.reduce((sum, { elapsed }) => sum + elapsed.minutes, 0),
      goalMinutes: goals.length ? goals.reduce((sum, goal) => sum + goal, 0) : null,
      goalCount: goals.length,
      hasRecord: matches.length > 0,
    };
  });
}
