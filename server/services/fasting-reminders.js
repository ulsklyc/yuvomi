/**
 * Own-only fasting reminders.  A reminder points directly at the fasting row,
 * so reconciliation can be idempotent without an additional anchor table.
 */
import { resolvePermissions } from '../permissions.js';
import { createLogger } from '../logger.js';

const log = createLogger('FastingReminders');
const GOAL_TYPE = 'fasting_goal';
const NEXT_START_TYPE = 'fasting_next_start';
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function userCanUseFasting(database, userId) {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  const permissions = resolvePermissions(database, user);
  return permissions.modules.health !== 'none' && permissions.capabilities.health_use_fasting === 'allow';
}

function desiredReminder(userId, type, fastId, remindAt) {
  return { userId, type, fastId, remindAt: iso(remindAt) };
}

function addDesired(map, reminder) {
  map.set(`${reminder.type}:${reminder.fastId}`, reminder);
}

function pendingReminders(database, userId) {
  return database.prepare(`
    SELECT id, entity_type, entity_id, remind_at
    FROM reminders
    WHERE created_by = ? AND entity_type IN (?, ?)
      AND dismissed = 0 AND pushed_at IS NULL
  `).all(userId, GOAL_TYPE, NEXT_START_TYPE);
}

function allFastingReminders(database, userId) {
  return database.prepare(`
    SELECT id, entity_type, entity_id, remind_at, dismissed, pushed_at
    FROM reminders
    WHERE created_by = ? AND entity_type IN (?, ?)
  `).all(userId, GOAL_TYPE, NEXT_START_TYPE);
}

function removePending(database, row) {
  database.prepare('DELETE FROM reminders WHERE id = ? AND dismissed = 0 AND pushed_at IS NULL').run(row.id);
}

function reconcile(database, userId, desired) {
  const existing = pendingReminders(database, userId);
  const byKey = new Map(existing.map((row) => [`${row.entity_type}:${row.entity_id}`, row]));
  const allExact = new Set(allFastingReminders(database, userId)
    .map((row) => `${row.entity_type}:${row.entity_id}:${row.remind_at}`));

  for (const row of existing) {
    const wanted = desired.get(`${row.entity_type}:${row.entity_id}`);
    if (!wanted || wanted.remindAt !== row.remind_at) removePending(database, row);
  }

  const insert = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES (?, ?, ?, ?)
  `);
  for (const wanted of desired.values()) {
    const old = byKey.get(`${wanted.type}:${wanted.fastId}`);
    if (old && old.remind_at === wanted.remindAt) continue;
    if (allExact.has(`${wanted.type}:${wanted.fastId}:${wanted.remindAt}`)) continue;
    // Backfilled records and late opt-in must not produce a stale notification.
    if (wanted.remindAt <= wanted.nowIso) continue;
    insert.run(wanted.type, wanted.fastId, wanted.remindAt, userId);
  }
}

/**
 * Synchronize one owner's goal/next-start reminders.
 *
 * Goal reminders are scheduled for start + target.  The next-start reminder
 * is end + (24h - target) and only applies to completed fasts shorter than
 * 24 hours.  Existing due rows remain intact during outages; only pending
 * rows that no longer describe the current state are removed.
 */
export function syncFastingRemindersForUser(database, userId, now = new Date()) {
  const nowIso = iso(now);
  database.transaction(() => {
    const settings = database.prepare('SELECT * FROM health_fasting_settings WHERE user_id = ?').get(userId);
    const canUse = userCanUseFasting(database, userId);
    const desired = new Map();
    if (canUse && settings && Number(settings.default_goal_minutes) > 0) {
      const rows = database.prepare('SELECT * FROM health_fasts WHERE user_id = ? ORDER BY start_at ASC, id ASC').all(userId);
      for (const row of rows) {
        const goalMs = Number(row.goal_minutes || 0) * 60 * 1000;
        if (!goalMs) continue;
        const completedDuration = row.end_at === null ? null : Date.parse(row.end_at) - Date.parse(row.start_at);
        if (settings.remind_goal === 1 && (row.end_at === null || (completedDuration != null && completedDuration >= goalMs))) {
          const remindAt = new Date(Date.parse(row.start_at) + goalMs);
          addDesired(desired, { ...desiredReminder(userId, GOAL_TYPE, row.id, remindAt), nowIso });
        }
        if (settings.remind_next_start === 1 && Number(settings.default_goal_minutes) < 1440 && row.end_at !== null && Date.parse(row.end_at) - Date.parse(row.start_at) < DAY_MS && Number(row.goal_minutes) < 24 * 60) {
          const hasLaterStart = rows.some((candidate) => candidate.start_at > row.start_at
            || (candidate.start_at === row.start_at && Number(candidate.id) > Number(row.id)));
          if (hasLaterStart) continue;
          const remindAt = new Date(Date.parse(row.end_at) + (24 * 60 * 60 * 1000 - goalMs));
          addDesired(desired, { ...desiredReminder(userId, NEXT_START_TYPE, row.id, remindAt), nowIso });
        }
      }
    }
    reconcile(database, userId, desired);
  })();
}

export function syncAllFastingReminders(database, now = new Date()) {
  const ids = new Set([
    ...database.prepare('SELECT user_id FROM health_fasting_settings WHERE remind_goal = 1 OR remind_next_start = 1').all().map((r) => r.user_id),
    ...database.prepare(`SELECT DISTINCT created_by AS user_id FROM reminders WHERE entity_type IN (?, ?)`).all(GOAL_TYPE, NEXT_START_TYPE).map((r) => r.user_id),
  ]);
  for (const userId of ids) {
    try {
      syncFastingRemindersForUser(database, userId, now);
    } catch (error) {
      log.error(`Fasting reminder sync failed for user ${userId}:`, error?.message || error);
    }
  }
}
