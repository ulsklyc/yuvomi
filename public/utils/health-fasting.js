/** Pure fasting timer and dial calculations shared by the page and tests. */

const MAX_GOAL_HOURS = 14 * 24;
const MINUTE = 60 * 1000;
const DAY_MINUTES = 24 * 60;

export const FASTING_PRESETS = Object.freeze([12, 14, 15, 16, 18, 20, 23]);

/** Unbounded hours: a multi-day fast must not wrap back to midnight. */
export function formatFastingClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
}

export function fastingClockModel(active, lastCompleted = null, now = Date.now()) {
  const anchor = active?.start_at || lastCompleted?.end_at;
  const seconds = anchor ? Math.max(0, Math.floor((Number(now) - Date.parse(anchor)) / 1000)) : 0;
  const goal = Number(active?.goal_minutes) * 60;
  return {
    seconds, days: Math.floor(seconds / 86400), hasAnchor: !!anchor,
    remaining: goal > 0 ? Math.max(0, goal - seconds) : null,
    reached: goal > 0 && seconds >= goal,
    progress: active ? Math.min(100, seconds / (goal || 86400) * 100) : 0,
  };
}

export function fastingNotificationAvailability(goalMinutes) {
  const goal = Number(goalMinutes) > 0;
  return { goal, next: goal && Number(goalMinutes) < 1440 };
}

export function fastingDisplayModel(active, lastCompleted = null, preference = 'auto', now = Date.now()) {
  const clock = fastingClockModel(active, lastCompleted, now);
  const mode = clock.remaining !== null && preference !== 'elapsed' ? 'remaining' : 'elapsed';
  return { ...clock, mode, displaySeconds: mode === 'remaining' ? clock.remaining : clock.seconds,
    overtime: clock.reached ? clock.seconds - Number(active.goal_minutes) * 60 : 0 };
}

export function normalizeGoalHours(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error('Goal must use whole hours.');
  const hours = Number(text);
  if (!Number.isSafeInteger(hours) || hours < 1) throw new Error('Goal must use whole hours from 1 to 336.');
  if (hours > MAX_GOAL_HOURS) throw new Error('Goal cannot exceed 336 hours.');
  return hours * 60;
}

function elapsedMinutes(startAt, now = new Date()) {
  const start = new Date(startAt);
  const end = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error('Fasting timestamps must be valid dates.');
  }
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / MINUTE));
}

export function fastingTimerModel({ startAt, goalMinutes = null, now = new Date() } = {}) {
  const elapsed = elapsedMinutes(startAt, now);
  const goal = goalMinutes === null || goalMinutes === undefined ? null : Number(goalMinutes);
  const goalReached = goal !== null && Number.isFinite(goal) && elapsed >= goal;
  return {
    elapsedMinutes: elapsed,
    dayCount: Math.floor(elapsed / DAY_MINUTES),
    goalReached,
    goalDeltaMinutes: goalReached ? elapsed - goal : 0,
  };
}

export function fastingDialModel({ elapsedMinutes: rawElapsed = 0, goalMinutes = null, zoneMode = 'timer' } = {}) {
  const elapsed = Number.isFinite(Number(rawElapsed)) ? Math.max(0, Math.floor(Number(rawElapsed))) : 0;
  const days = Math.max(1, Math.ceil(Math.max(elapsed, Number(goalMinutes) || 0) / DAY_MINUTES));
  const visibleCount = Math.min(14, days);
  const visibleDaySegments = Array.from({ length: visibleCount }, (_, index) => {
    const dayElapsed = Math.min(DAY_MINUTES, Math.max(0, elapsed - index * DAY_MINUTES));
    return {
      day: index + 1,
      progress: dayElapsed / DAY_MINUTES,
      elapsedMinutes: dayElapsed,
    };
  });
  const zones = zoneMode === 'educational'
    ? [
      { day: 1, startMinute: 0, endMinute: 12 * 60, key: 'health.fasting.zoneMeal' },
      { day: 1, startMinute: 8 * 60, endMinute: 20 * 60, key: 'health.fasting.zoneStored' },
      { day: 1, startMinute: 12 * 60, endMinute: 24 * 60, key: 'health.fasting.zoneKetones' },
    ]
    : [];
  return {
    visibleDaySegments,
    // The dial shows a partial current day as a segment, but the compact
    // "+N days" label counts only completed days beyond the visual cap.
    additionalDays: Math.max(0, Math.floor(elapsed / DAY_MINUTES) - 14),
    zones,
    goalMinutes: goalMinutes === null || goalMinutes === undefined ? null : Number(goalMinutes),
  };
}

export function formatFastingDuration(rawMinutes) {
  const total = Math.max(0, Math.floor(Number(rawMinutes) || 0));
  const days = Math.floor(total / DAY_MINUTES);
  const hours = Math.floor((total % DAY_MINUTES) / 60);
  const minutes = total % 60;
  const parts = [];
  if (days) parts.push(`${days} d`);
  if (hours) parts.push(`${hours} h`);
  if (minutes || parts.length === 0) parts.push(`${minutes} min`);
  return parts.join(' ');
}
