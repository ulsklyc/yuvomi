import { toCsv } from './health-export.js';

const HEADER = ['start_at', 'end_at', 'start_tzid', 'duration_minutes', 'goal_minutes', 'goal_reached', 'rating', 'note', 'visibility'];

export function fastingToCsv(rows) {
  return toCsv(HEADER, (rows || []).map((row) => {
    const start = Date.parse(row.start_at);
    const end = row.end_at ? Date.parse(row.end_at) : NaN;
    const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.floor((end - start) / 60000) : '';
    const goalReached = row.goal_minutes === null || row.goal_minutes === undefined || !Number.isFinite(start) || !Number.isFinite(end)
      ? ''
      : end - start >= Number(row.goal_minutes) * 60000;
    return [row.start_at, row.end_at, row.start_tzid, duration, row.goal_minutes, goalReached, row.rating, row.note, row.visibility];
  }));
}

export const FASTING_EXPORT_HEADERS = Object.freeze(HEADER);
