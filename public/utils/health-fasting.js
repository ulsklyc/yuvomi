/** Pure fasting timer and dial calculations shared by the page and tests. */
import { getNumberFormat, t } from '../i18n.js';

const MAX_GOAL_HOURS = 14 * 24;
const MINUTE = 60 * 1000;
const DAY_MINUTES = 24 * 60;

export const FASTING_PRESETS = Object.freeze([12, 14, 15, 16, 18, 20, 23]);

function fastingSubjectParams(view) {
  const params = new URLSearchParams();
  if (view.subject && view.subject !== view.self) params.set('user_id', view.subject);
  return params;
}

export function fastingHistoryQuery(view, cursor = null) {
  const params = fastingSubjectParams(view);
  if (view.from) params.set('from', view.from);
  if (view.to) params.set('to', view.to);
  if (cursor) {
    params.set('before_at', cursor.before_at);
    params.set('before_id', cursor.before_id);
  }
  return params.size ? `?${params}` : '';
}

export function fastingStatsQuery(view) {
  const params = fastingSubjectParams(view);
  return params.size ? `?${params}` : '';
}

export function shouldLoadFastingStats(stats, statsError = false) {
  return stats === undefined || statsError;
}

export function fastingCompletionCalendarHint(timeZone) {
  if (!timeZone) return '';
  return `${t('health.fasting.completedFrom')} / ${t('health.fasting.completedTo')}: ${t('settings.timezoneLabel')} - ${timeZone}`;
}

/**
 * Completed-entry forms must use the authoritative server clock. Falling back
 * to the device clock would reintroduce future timestamps on a phone whose
 * clock runs ahead of the server.
 */
export function fastingServerDate(serverNow) {
  const timestamp = Date.parse(serverNow);
  if (!Number.isFinite(timestamp)) throw new Error('FASTING_SERVER_TIME_UNAVAILABLE');
  return new Date(timestamp);
}

/**
 * Keeps an authoritative server clock moving after a state response is
 * received. Device time supplies elapsed duration only; its absolute offset
 * from the server is captured and cancelled out.
 */
export function fastingServerClock(serverNow, deviceNow = () => Date.now()) {
  const serverStartedAt = fastingServerDate(serverNow).getTime();
  const deviceStartedAt = Number(deviceNow());
  if (!Number.isFinite(deviceStartedAt)) throw new Error('FASTING_DEVICE_TIME_UNAVAILABLE');
  return () => serverStartedAt + (Number(deviceNow()) - deviceStartedAt);
}

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
  const unit = (value, name) => getNumberFormat({
    style: 'unit', unit: name, unitDisplay: 'short',
  }).format(value);
  if (days) parts.push(unit(days, 'day'));
  if (hours) parts.push(unit(hours, 'hour'));
  if (minutes || parts.length === 0) parts.push(unit(minutes, 'minute'));
  return parts.join(' ');
}
