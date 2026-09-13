import { resolvePermissions } from '../permissions.js';
import { summarizeFastingRows, fastingStreaks, weeklyFastingSeries } from './fasting-stats.js';
import { fastingDateKey, parseFastingDateRange, rowMatchesFastingDateRange } from './fasting-dates.js';
import { householdTimeZone, shiftDateKey } from '../utils/timezone.js';
import { syncFastingRemindersForUser } from './fasting-reminders.js';

export class FastingError extends Error {
  constructor(status, reason, message, current = undefined) {
    super(message);
    this.name = 'FastingError';
    this.status = status;
    this.reason = reason;
    if (current !== undefined) this.current = current;
  }
}

const MAX_GOAL_MINUTES = 14 * 24 * 60;
const MAX_NOTE = 2000;

function fail(status, reason, message, current) {
  throw new FastingError(status, reason, message, current);
}

function asActor(actor) {
  const id = Number(actor?.id);
  if (!Number.isInteger(id) || id < 1) fail(401, 'FASTING_ACTOR_REQUIRED', 'A signed-in user is required.');
  return id;
}

function userRow(database, id) {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(id);
  if (!user) fail(401, 'FASTING_ACTOR_REQUIRED', 'A signed-in user is required.');
  return user;
}

function capabilityAllowed(database, id) {
  const user = userRow(database, id);
  return resolvePermissions(database, user).capabilities.health_use_fasting === 'allow';
}

function ensureCapability(database, id, reason = 'FASTING_CAPABILITY_REQUIRED') {
  if (!capabilityAllowed(database, id)) fail(403, reason, 'Fasting is not enabled for this user.');
}

function ensureSubject(database, actorId, subjectId, { read = false } = {}) {
  ensureCapability(database, actorId);
  if (actorId === subjectId) return;
  if (!capabilityAllowed(database, subjectId)) {
    fail(403, 'FASTING_SUBJECT_FORBIDDEN', read ? 'This person does not permit fasting access.' : 'You cannot record fasting for this person.');
  }
  const grant = database.prepare(
    'SELECT 1 FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?'
  ).get(subjectId, actorId);
  // An ungranted viewer may still read family-visible rows. The visibility
  // query below filters the result; only private access needs the grant.
  if (read && !grant) return;
  if (!grant) {
    fail(403, 'FASTING_SUBJECT_FORBIDDEN', read ? 'This person does not permit fasting access.' : 'You cannot record fasting for this person.');
  }
}

function parseInstant(value, field, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(400, 'FASTING_TIMESTAMP_INVALID', `${field} must be an ISO timestamp with an explicit offset.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(400, 'FASTING_TIMESTAMP_INVALID', `${field} must be a valid timestamp.`);
  return date.toISOString();
}

function ensureTimezone(tzid) {
  if (typeof tzid !== 'string' || !tzid.trim()) fail(400, 'FASTING_TIMEZONE_INVALID', 'start_tzid must be a valid IANA time zone.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid }).format();
  } catch {
    fail(400, 'FASTING_TIMEZONE_INVALID', 'start_tzid must be a valid IANA time zone.');
  }
  return tzid;
}

function goalMinutes(value, field = 'goal_minutes') {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 60 || n > MAX_GOAL_MINUTES || n % 60 !== 0) {
    fail(400, 'FASTING_GOAL_INVALID', `${field} must be a whole-hour goal from 1 to 336 hours.`);
  }
  return n;
}

function noteValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_NOTE) fail(400, 'FASTING_NOTE_INVALID', 'note must be at most 2,000 characters.');
  return value;
}

function ratingValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) fail(400, 'FASTING_RATING_INVALID', 'rating must be an integer from 1 to 5.');
  return n;
}

function booleanSetting(value, field) {
  if (value === undefined) return undefined;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  fail(400, 'FASTING_SETTING_INVALID', `${field} must be a boolean.`);
}

function visibilityValue(value, fallback = 'private') {
  const v = value === undefined || value === null || value === '' ? fallback : value;
  if (v !== 'private' && v !== 'family') fail(400, 'FASTING_VISIBILITY_INVALID', 'visibility must be private or family.');
  return v;
}

function defaultVisibility(database, subjectId) {
  try {
    return database.prepare('SELECT visibility FROM health_visibility_defaults WHERE user_id = ? AND scope_key = ?')
      .get(subjectId, 'fasting')?.visibility === 'family' ? 'family' : 'private';
  } catch {
    return 'private';
  }
}

function safetyAcknowledged(database, subjectId) {
  return !!database.prepare('SELECT safety_acknowledged_at FROM health_fasting_settings WHERE user_id = ?').get(subjectId)?.safety_acknowledged_at;
}

function ensureSafety(database, actorId, subjectId, acknowledgeSafety) {
  if (safetyAcknowledged(database, subjectId)) return;
  if (acknowledgeSafety === true) {
    acknowledgeSafetyFor(database, actorId, subjectId);
    return;
  }
  fail(409, 'FASTING_ACK_REQUIRED', 'Confirm the fasting safety information before starting.');
}

function acknowledgeSafetyFor(database, actorId, subjectId) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO health_fasting_settings (user_id, safety_acknowledged_at, safety_acknowledged_by)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET safety_acknowledged_at = excluded.safety_acknowledged_at,
      safety_acknowledged_by = excluded.safety_acknowledged_by, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(subjectId, now, actorId);
}

export function acknowledgeSafety(database, actor, subjectId = Number(actor?.id)) {
  const actorId = asActor(actor);
  const subject = Number(subjectId);
  if (!Number.isInteger(subject) || subject < 1) fail(400, 'FASTING_SUBJECT_INVALID', 'Invalid target user.');
  ensureSubject(database, actorId, subject);
  acknowledgeSafetyFor(database, actorId, subject);
  return database.prepare('SELECT * FROM health_fasting_settings WHERE user_id = ?').get(subject);
}

function validateRange(startAt, endAt, now = new Date()) {
  if (endAt && endAt <= startAt) fail(400, 'FASTING_RANGE_INVALID', 'end_at must be after start_at.');
  if (new Date(startAt).getTime() > now.getTime()) fail(400, 'FASTING_FUTURE', 'A fast cannot start in the future.');
  if (endAt && new Date(endAt).getTime() > now.getTime()) fail(400, 'FASTING_FUTURE', 'A fast cannot end in the future.');
}

function visibleFilter(database, actorId, subjectId) {
  const isOwner = actorId === subjectId;
  const grant = !isOwner && database.prepare('SELECT 1 FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?').get(subjectId, actorId);
  return isOwner || grant ? 'user_id = ?' : "user_id = ? AND visibility = 'family'";
}

export function getFastingHistory(database, actor, subjectId = Number(actor?.id), options = {}) {
  const actorId = asActor(actor);
  const subject = Number(subjectId);
  ensureSubject(database, actorId, subject, { read: true });
  const limit = Number(options.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'FASTING_PAGE_INVALID', 'limit must be between 1 and 100.');
  const hasCursor = options.beforeAt !== undefined || options.beforeId !== undefined;
  const beforeId = Number(options.beforeId);
  if (hasCursor && (!options.beforeAt || !Number.isSafeInteger(beforeId) || beforeId < 1)) fail(400, 'FASTING_PAGE_INVALID', 'Both cursor fields are required.');
  const beforeAt = hasCursor ? parseInstant(options.beforeAt, 'before_at') : null;
  const invalidRange = () => fail(400, 'FASTING_DATE_RANGE_INVALID', 'from and to must be valid YYYY-MM-DD dates with from no later than to.');
  const range = parseFastingDateRange(options.from, options.to, invalidRange);
  const sql = `SELECT * FROM health_fasts WHERE ${visibleFilter(database, actorId, subject)}
    AND end_at IS NOT NULL ${hasCursor ? 'AND (start_at < ? OR (start_at = ? AND id < ?))' : ''}
    ORDER BY start_at DESC, id DESC`;
  const params = [subject, ...(hasCursor ? [beforeAt, beforeAt, beforeId] : [])];
  let rows;
  if (!range.from && !range.to) {
    rows = database.prepare(`${sql} LIMIT ?`).all(...params, limit + 1);
  } else {
    rows = [];
    for (const row of database.prepare(sql).iterate(...params)) {
      if (!rowMatchesFastingDateRange(row, range)) continue;
      rows.push(row);
      if (rows.length === limit + 1) break;
    }
  }
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit);
  const last = entries.at(-1);
  return { entries, has_more: hasMore, next_cursor: hasMore ? { before_at: last.start_at, before_id: last.id } : null };
}

export function getAllFastingHistory(database, actor, subjectId = Number(actor?.id), options = {}) {
  const actorId = asActor(actor);
  ensureSubject(database, actorId, Number(subjectId), { read: true });
  const invalidRange = () => fail(400, 'FASTING_DATE_RANGE_INVALID', 'from and to must be valid YYYY-MM-DD dates with from no later than to.');
  const range = parseFastingDateRange(options.from, options.to, invalidRange);
  const rows = [];
  for (const row of database.prepare(`SELECT * FROM health_fasts WHERE ${visibleFilter(database, actorId, Number(subjectId))}
    AND end_at IS NOT NULL ORDER BY start_at DESC, id DESC`).iterate(Number(subjectId))) {
    if (rowMatchesFastingDateRange(row, range)) rows.push(row);
  }
  return rows;
}

export function getFastingClockMode(database, userId) {
  const value = database.prepare('SELECT value FROM sync_config WHERE key = ?').get(`fasting_clock_mode:user:${Number(userId)}`)?.value;
  return ['elapsed', 'remaining'].includes(value) ? value : 'auto';
}

export function getFastingState(database, actor, subjectId = Number(actor?.id)) {
  const actorId = asActor(actor);
  const subject = Number(subjectId);
  const history = getFastingHistory(database, actor, subject);
  const canWrite = actorId === subject || !!database.prepare('SELECT 1 FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?').get(subject, actorId);
  return {
    active: database.prepare(`SELECT * FROM health_fasts WHERE ${visibleFilter(database, actorId, subject)} AND end_at IS NULL`).get(subject) || null,
    history: history.entries,
    history_has_more: history.has_more,
    history_next_cursor: history.next_cursor,
    // Family visibility applies to records, not the owner's personal settings
    // or first-use acknowledgement. Caregivers retain the managed-person view.
    settings: canWrite ? { ...(database.prepare('SELECT * FROM health_fasting_settings WHERE user_id = ?').get(subject) || {
      user_id: subject, default_goal_minutes: null, zone_mode: 'timer', safety_acknowledged_at: null,
    }), clock_mode: getFastingClockMode(database, subject) } : null,
    canWrite,
    acknowledged: canWrite ? safetyAcknowledged(database, subject) : null,
    display_tzid: householdTimeZone(database),
  };
}

export function getFastingStats(database, actor, subjectId = Number(actor?.id), now = new Date()) {
  const state = getFastingState(database, actor, subjectId);
  const rows = getAllFastingHistory(database, actor, subjectId);
  const zone = householdTimeZone(database);
  const today = fastingDateKey(now, zone);
  const currentYear = today.slice(0, 4);
  const windowStart = shiftDateKey(today, -29);
  const completionKey = (row) => fastingDateKey(row.end_at, row.start_tzid || 'UTC');
  const yearRows = rows.filter((row) => completionKey(row)?.slice(0, 4) === currentYear);
  const last30Rows = rows.filter((row) => {
    const key = completionKey(row);
    return key && key >= windowStart && key <= today;
  });
  const streaks = fastingStreaks(rows, { today });
  return {
    display_tzid: zone,
    today,
    allTime: summarizeFastingRows(rows),
    year: summarizeFastingRows(yearRows),
    last30Days: summarizeFastingRows(last30Rows),
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
    weekly: weeklyFastingSeries(rows, { endDate: today }),
  };
}

function overlap(database, subjectId, startAt, endAt, excludeId = null) {
  const row = database.prepare(`
    SELECT * FROM health_fasts
    WHERE user_id = ? AND id <> COALESCE(?, 0)
      AND start_at < COALESCE(?, '9999-12-31T23:59:59.999Z')
      AND COALESCE(end_at, '9999-12-31T23:59:59.999Z') > ?
    LIMIT 1
  `).get(subjectId, excludeId, endAt, startAt);
  if (row) fail(409, 'FASTING_OVERLAP', 'This fast overlaps another recorded fast.', row);
}

function immediate(database, operation) {
  return database.transaction(operation).immediate();
}

function createFastInTransaction(database, actor, input = {}) {
  const actorId = asActor(actor);
  const subjectId = Number(input.userId ?? actorId);
  ensureSubject(database, actorId, subjectId);
  ensureSafety(database, actorId, subjectId, input.acknowledgeSafety);
  const startAt = parseInstant(input.startAt, 'start_at');
  const endAt = input.endAt === undefined || input.endAt === null ? null : parseInstant(input.endAt, 'end_at');
  const startTzid = ensureTimezone(input.startTzid);
  const goal = goalMinutes(input.goalMinutes);
  const note = noteValue(input.note);
  const rating = ratingValue(input.rating);
  const visibility = visibilityValue(input.visibility, defaultVisibility(database, subjectId));
  validateRange(startAt, endAt);
  if (endAt === null && database.prepare('SELECT 1 FROM health_fasts WHERE user_id = ? AND end_at IS NULL').get(subjectId)) {
    fail(409, 'FASTING_ACTIVE_EXISTS', 'This person already has an active fast.');
  }
  overlap(database, subjectId, startAt, endAt);
  try {
    const result = database.prepare(`INSERT INTO health_fasts
      (user_id, start_at, end_at, start_tzid, goal_minutes, rating, note, visibility, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(subjectId, startAt, endAt, startTzid, goal, rating, note, visibility, actorId, actorId);
    return database.prepare('SELECT * FROM health_fasts WHERE id = ?').get(result.lastInsertRowid);
  } catch (error) {
    if (/UNIQUE|health_fasts_one_active/.test(error.message)) fail(409, 'FASTING_ACTIVE_EXISTS', 'This person already has an active fast.');
    throw error;
  }
}

export function createFast(database, actor, input = {}) {
  return immediate(database, () => {
    const row = createFastInTransaction(database, actor, input);
    syncFastingRemindersForUser(database, row.user_id);
    return row;
  });
}

function loadWritable(database, actorId, id) {
  const row = database.prepare('SELECT * FROM health_fasts WHERE id = ?').get(id);
  if (!row) fail(404, 'FASTING_NOT_FOUND', 'Fasting record not found.');
  ensureSubject(database, actorId, row.user_id);
  return row;
}

function expectedRevision(input) {
  const n = Number(input?.expectedRevision);
  if (!Number.isInteger(n) || n < 1) fail(400, 'FASTING_REVISION_REQUIRED', 'expected_revision is required.');
  return n;
}

function finishFastInTransaction(database, actor, id, input = {}) {
  const actorId = asActor(actor);
  const row = loadWritable(database, actorId, Number(id));
  const revision = expectedRevision(input);
  if (row.revision !== revision) fail(409, 'FASTING_REVISION_CONFLICT', 'The fasting record changed. Reload and try again.', row);
  if (row.end_at !== null) fail(409, 'FASTING_ALREADY_FINISHED', 'This fast is already finished.', row);
  const endAt = parseInstant(input.endAt ?? new Date().toISOString(), 'end_at');
  validateRange(row.start_at, endAt);
  overlap(database, row.user_id, row.start_at, endAt, row.id);
  const changed = database.prepare(`UPDATE health_fasts SET end_at = ?, revision = revision + 1,
    updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND revision = ?`).run(endAt, actorId, row.id, revision);
  if (!changed.changes) fail(409, 'FASTING_REVISION_CONFLICT', 'The fasting record changed. Reload and try again.', row);
  return database.prepare('SELECT * FROM health_fasts WHERE id = ?').get(row.id);
}

export function finishFast(database, actor, id, input = {}) {
  return immediate(database, () => {
    const row = finishFastInTransaction(database, actor, id, input);
    syncFastingRemindersForUser(database, row.user_id);
    return row;
  });
}

function updateFastInTransaction(database, actor, id, input = {}) {
  const actorId = asActor(actor);
  const row = loadWritable(database, actorId, Number(id));
  const revision = expectedRevision(input);
  if (row.revision !== revision) fail(409, 'FASTING_REVISION_CONFLICT', 'The fasting record changed. Reload and try again.', row);
  const startAt = input.startAt === undefined ? row.start_at : parseInstant(input.startAt, 'start_at');
  const endAt = input.endAt === undefined ? row.end_at : (input.endAt === null ? null : parseInstant(input.endAt, 'end_at'));
  const tzid = input.startTzid === undefined ? row.start_tzid : ensureTimezone(input.startTzid);
  const goal = input.goalMinutes === undefined ? row.goal_minutes : goalMinutes(input.goalMinutes);
  const note = input.note === undefined ? row.note : noteValue(input.note);
  const rating = input.rating === undefined ? row.rating : ratingValue(input.rating);
  const visibility = input.visibility === undefined ? row.visibility : visibilityValue(input.visibility);
  validateRange(startAt, endAt);
  overlap(database, row.user_id, startAt, endAt, row.id);
  const changed = database.prepare(`UPDATE health_fasts SET start_at = ?, end_at = ?, start_tzid = ?, goal_minutes = ?,
    note = ?, rating = ?, visibility = ?, revision = revision + 1, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ? AND revision = ?`).run(startAt, endAt, tzid, goal, note, rating, visibility, actorId, row.id, revision);
  if (!changed.changes) fail(409, 'FASTING_REVISION_CONFLICT', 'The fasting record changed. Reload and try again.', row);
  return database.prepare('SELECT * FROM health_fasts WHERE id = ?').get(row.id);
}

export function updateFast(database, actor, id, input = {}) {
  return immediate(database, () => {
    const row = updateFastInTransaction(database, actor, id, input);
    syncFastingRemindersForUser(database, row.user_id);
    return row;
  });
}

function deleteFastInTransaction(database, actor, id, input = {}) {
  const actorId = asActor(actor);
  const row = loadWritable(database, actorId, Number(id));
  const revision = expectedRevision(input);
  if (row.revision !== revision) fail(409, 'FASTING_REVISION_CONFLICT', 'The fasting record changed. Reload and try again.', row);
  const changed = database.prepare('DELETE FROM health_fasts WHERE id = ? AND revision = ?').run(row.id, revision);
  if (!changed.changes) fail(409, 'FASTING_REVISION_CONFLICT', 'The fasting record changed. Reload and try again.', row);
  return row;
}

export function deleteFast(database, actor, id, input = {}) {
  return immediate(database, () => {
    const row = deleteFastInTransaction(database, actor, id, input);
    syncFastingRemindersForUser(database, row.user_id);
    return row;
  });
}

export function updateFastingSettings(database, actor, input = {}, subjectId = Number(actor?.id)) {
  return immediate(database, () => {
    const settings = updateSettings(database, actor, input, subjectId);
    syncFastingRemindersForUser(database, Number(subjectId));
    return settings;
  });
}

function updateSettings(database, actor, input, subjectId) {
  const actorId = asActor(actor);
  const subject = Number(subjectId);
  ensureSubject(database, actorId, subject);
  if (actorId !== subject && Object.keys(input).some((key) => !['acknowledgeSafety'].includes(key))) {
    fail(403, 'FASTING_SETTINGS_FORBIDDEN', 'Only the person fasting can change fasting settings.');
  }
  const goal = input.defaultGoalMinutes === undefined ? undefined : goalMinutes(input.defaultGoalMinutes, 'default_goal_minutes');
  const zone = input.zoneMode === undefined ? undefined : input.zoneMode;
  const remindGoal = booleanSetting(input.remindGoal, 'remind_goal');
  const remindNextStart = booleanSetting(input.remindNextStart, 'remind_next_start');
  if (input.clockMode !== undefined && !['auto', 'elapsed', 'remaining'].includes(input.clockMode)) fail(400, 'FASTING_CLOCK_MODE_INVALID', 'Invalid clock mode.');
  if (zone !== undefined && zone !== 'timer' && zone !== 'educational') fail(400, 'FASTING_ZONE_MODE_INVALID', 'zone_mode must be timer or educational.');
  if (goal !== undefined && input.activeId !== undefined) {
    const active = database.prepare('SELECT * FROM health_fasts WHERE user_id = ? AND end_at IS NULL').get(subject);
    if ((active?.id ?? null) !== input.activeId) fail(409, 'FASTING_REVISION_CONFLICT', 'The active fast changed. Reload and try again.');
    if (active) updateFastInTransaction(database, actor, active.id, { expectedRevision: input.expectedRevision, goalMinutes: goal });
  }
  if (input.clockMode !== undefined) database.prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`)
    .run(`fasting_clock_mode:user:${subject}`, input.clockMode);
  if (input.acknowledgeSafety === true) acknowledgeSafetyFor(database, actorId, subject);
  const current = database.prepare('SELECT * FROM health_fasting_settings WHERE user_id = ?').get(subject);
  if (goal === undefined && zone === undefined && remindGoal === undefined && remindNextStart === undefined) return { ...(current || { user_id: subject, default_goal_minutes: null, zone_mode: 'timer', remind_goal: 0, remind_next_start: 0 }), clock_mode: getFastingClockMode(database, subject) };
  const nextGoal = goal === undefined ? (current?.default_goal_minutes ?? null) : goal;
  const nextZone = zone === undefined ? (current?.zone_mode || 'timer') : zone;
  const nextRemindGoal = remindGoal === undefined ? (current?.remind_goal || 0) : remindGoal;
  const nextRemindNextStart = remindNextStart === undefined ? (current?.remind_next_start || 0) : remindNextStart;
  database.prepare(`INSERT INTO health_fasting_settings (user_id, default_goal_minutes, zone_mode, remind_goal, remind_next_start)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
    default_goal_minutes = excluded.default_goal_minutes,
    zone_mode = excluded.zone_mode,
    remind_goal = excluded.remind_goal,
    remind_next_start = excluded.remind_next_start,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`)
    .run(subject, nextGoal, nextZone, nextRemindGoal, nextRemindNextStart);
  return { ...database.prepare('SELECT * FROM health_fasting_settings WHERE user_id = ?').get(subject), clock_mode: getFastingClockMode(database, subject) };
}
