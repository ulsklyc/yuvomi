/**
 * Module: Waste collection - per-user, per-type pickup reminders (#1063 Phase 8)
 * Purpose: establish the desired state of 'waste_pickup' reminders - a
 *          rolling window of upcoming, coalesced occurrences per user with an
 *          enabled reminder setting for that occurrence's type, resolved
 *          periodically via syncAllWasteReminders() (same place/shape as
 *          server/services/schedule-reminders.js's own sync).
 *
 * WHY AN ANCHOR TABLE, same reasoning as schedule-reminders.js: a Waste
 * occurrence is computed on read (server/services/waste-domain.js), not a
 * stored row, so reminders.entity_id has nothing stable to point at without
 * one. waste_reminder_entries (migration 200) gives one anchor per (user,
 * type, date_key) - exactly the coalesced occurrence identity the resolver
 * already uses, so a moved/skipped/re-mapped occurrence lands on a cleanly
 * different anchor rather than a duplicate, and the old anchor (with its
 * reminder) is dropped once it no longer qualifies.
 *
 * SAME SHAPE AS schedule-reminders.js: delete what no longer qualifies, add
 * what is missing, leave existing rows untouched (no resetting
 * pushed_at/dismissed on every run).
 */

import { localToUTC, householdTimeZone, todayKey, shiftDateKey } from '../utils/timezone.js';
import { resolvePermissions } from '../permissions.js';
import { createLogger } from '../logger.js';
import { listTypes, getOccurrences } from './waste-store.js';

const log = createLogger('Waste');

// A pickup rhythm is weekly/monthly, not daily like a shift - long enough to
// comfortably cover a monthly rhythm plus the widest allowed lead time
// (MAX_OFFSET_DAYS below), short enough that this stays "a few dozen rows,"
// not real storage (invariant #8 - every list has a measured work limit).
const REMINDER_WINDOW_DAYS = 45;

export const MIN_OFFSET_DAYS = 0;
export const MAX_OFFSET_DAYS = 14;

function toNaiveUTC(isoWithZ) {
  // reminders.remind_at is naive-UTC, HH:MM (no seconds) throughout this app
  // - localToUTC() always returns whole seconds here (delivery_time is HH:MM,
  // ':00' seconds appended by pickupReminderAt below), so stripping a
  // trailing ':00' after the 'Z' strip always removes exactly the seconds
  // field, never a real minutes value.
  return isoWithZ.replace(/\.\d{3}Z$/, '').replace(/Z$/, '').replace(/:00$/, '');
}

/** Reminder instant for a pickup: (pickup date - offsetDays) at deliveryTime, household-local, as naive UTC. */
function pickupReminderAt(dateKey, offsetDays, deliveryTime, tz) {
  const remindDateKey = shiftDateKey(dateKey, -Math.max(0, Number(offsetDays) || 0));
  return toNaiveUTC(localToUTC(`${remindDateKey}T${deliveryTime}:00`, tz));
}

function isoNow(now) {
  return now.toISOString();
}

function wasteDisabled(database) {
  const row = database.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();
  if (!row?.value) return false;
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) && parsed.includes('waste');
  } catch {
    return false;
  }
}

function lacksWaste(database, userId) {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
  if (!user) return true;
  return resolvePermissions(database, user).modules.waste === 'none';
}

function dropAllForUser(database, userId) {
  // Anchors first, then both - reminders.entity_id carries no real foreign
  // key onto waste_reminder_entries (the same polymorphic pattern every other
  // entity_type uses).
  const anchors = database.prepare('SELECT id FROM waste_reminder_entries WHERE user_id = ?').all(userId);
  if (anchors.length) {
    const ids = anchors.map((a) => a.id);
    database.prepare(`DELETE FROM reminders WHERE entity_type = 'waste_pickup' AND entity_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  database.prepare('DELETE FROM waste_reminder_entries WHERE user_id = ?').run(userId);
}

export const __test = { pickupReminderAt };

/**
 * Establishes the desired reminder state for ONE user: creates/drops anchors
 * and their reminders.
 *
 * The whole body runs inside ONE transaction (nests via SAVEPOINT if the
 * caller is already inside one, e.g. reminder-settings.js's own write).
 * Before this, a throw partway through the anchor loop below - a moved
 * pickup, an archived type, anything that touched getOccurrences() mid-run -
 * left some anchors/reminders deleted and others not yet recreated: an
 * inconsistent state that silently persisted until the next periodic tick
 * papered over it (PLAN.md #8, "never truncate silently" applies to a
 * half-applied sync too, not just a half-computed occurrence list).
 */
export function syncWasteRemindersForUser(database, userId, now = new Date()) {
  database.transaction(() => syncWasteRemindersForUserUnsafe(database, userId, now))();
}

function syncWasteRemindersForUserUnsafe(database, userId, now) {
  if (wasteDisabled(database) || lacksWaste(database, userId)) {
    dropAllForUser(database, userId);
    return;
  }

  const settings = database.prepare(`
    SELECT type_id, offset_days, delivery_time FROM waste_reminder_settings WHERE user_id = ? AND enabled = 1
  `).all(userId);
  if (!settings.length) {
    dropAllForUser(database, userId);
    return;
  }

  // Archived types are excluded the same way getNextPerType() already
  // excludes them - a type the household stopped using should stop
  // reminding, even if a stale enabled setting still names it.
  const activeTypeIds = new Set(listTypes(database, { includeArchived: false }).map((t) => t.id));
  const settingByTypeId = new Map(settings.filter((s) => activeTypeIds.has(s.type_id)).map((s) => [s.type_id, s]));
  if (!settingByTypeId.size) {
    dropAllForUser(database, userId);
    return;
  }

  const tz = householdTimeZone(database);
  const today = todayKey(database, now);
  const to = shiftDateKey(today, REMINDER_WINDOW_DAYS);
  const occurrences = getOccurrences(database, { from: today, to })
    .filter((occ) => settingByTypeId.has(occ.type_id));

  const slotKey = (typeId, dateKey) => `${typeId}:${dateKey}`;
  const qualifyingBySlot = new Map(occurrences.map((occ) => [slotKey(occ.type_id, occ.date_key), occ]));

  // GONE-STALE FIRST, same order as schedule-reminders.js: an anchor whose
  // slot no longer has a qualifying occurrence (moved away, skipped, the
  // type's setting was disabled or archived) goes, along with its reminder.
  const existingAnchors = database.prepare('SELECT id, type_id, date_key FROM waste_reminder_entries WHERE user_id = ?').all(userId);
  for (const anchor of existingAnchors) {
    if (!qualifyingBySlot.has(slotKey(anchor.type_id, anchor.date_key))) {
      database.prepare(`DELETE FROM reminders WHERE entity_type = 'waste_pickup' AND entity_id = ?`).run(anchor.id);
      database.prepare('DELETE FROM waste_reminder_entries WHERE id = ?').run(anchor.id);
    }
  }

  const upsertAnchor = database.prepare(`
    INSERT INTO waste_reminder_entries (user_id, type_id, date_key) VALUES (?, ?, ?)
    ON CONFLICT(user_id, type_id, date_key) DO UPDATE SET type_id = excluded.type_id
    RETURNING id
  `);

  for (const occ of occurrences) {
    const setting = settingByTypeId.get(occ.type_id);
    const anchorId = upsertAnchor.get(userId, occ.type_id, occ.date_key).id;
    const remindAt = pickupReminderAt(occ.date_key, setting.offset_days, setting.delivery_time, tz);

    const existing = database.prepare(`SELECT id, remind_at FROM reminders WHERE entity_type = 'waste_pickup' AND entity_id = ?`).get(anchorId);
    if (existing) {
      // Untouched when the target instant is unchanged - otherwise a run
      // every few minutes would reset pushed_at/dismissed and the same
      // notification would go out again and again.
      if (existing.remind_at === remindAt) continue;
      database.prepare('DELETE FROM reminders WHERE id = ?').run(existing.id);
    }
    // Only created if the target instant is still ahead of us - a moved
    // pickup whose new lead time already lies behind us gets no
    // after-the-fact notification.
    if (`${remindAt}Z` > isoNow(now)) {
      database.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('waste_pickup', ?, ?, ?)`).run(anchorId, remindAt, userId);
    }
  }
}

/**
 * Establishes the desired state for every user with an enabled setting (plus
 * any user who still carries anchors from a now-disabled setting, so those
 * get cleaned up too). Runs periodically, same place as the other module
 * syncs (server/services/notifications.js#processDueNotifications).
 */
export function syncAllWasteReminders(database, now = new Date()) {
  const withSettings = database.prepare('SELECT DISTINCT user_id FROM waste_reminder_settings WHERE enabled = 1').all();
  const withAnchors = database.prepare('SELECT DISTINCT user_id FROM waste_reminder_entries').all();
  const candidateIds = new Set([...withSettings.map((r) => r.user_id), ...withAnchors.map((r) => r.user_id)]);
  for (const userId of candidateIds) {
    try {
      syncWasteRemindersForUser(database, userId, now);
    } catch (err) {
      log.error(`Waste reminder sync failed for user ${userId}:`, err?.message || err);
    }
  }
}
