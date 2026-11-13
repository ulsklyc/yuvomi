/**
 * Module: origin of a reminder (entity_type -> module)
 * Purpose: ONE map for the question which module a `reminders` row belongs
 *          to. Read by GET /reminders/pending (server/routes/reminders.js:
 *          token scopes, member permissions, household switch) and by the
 *          delivery (server/services/notifications.js#processDueNotifications:
 *          household switch and member permissions). Until #1279 the map lived
 *          only in the router, and the delivery did not ask about the module at
 *          all; until #1289 it did not ask about the recipient's permissions.
 *          The medication scheduler, which sends without `reminders` rows,
 *          asks the same recipient verdict since #2602.
 * Dependencies: server/services/household-modules.js,
 *   server/authorize/ (actorForUser, authorize; it loads no server/db.js either)
 */
import { householdDisabledModules } from './household-modules.js';
// The delivery passes in its own connection; the actor without a request
// (server/authorize/, phase 2 B1) reads through exactly that connection.
import { actorForUser, authorize, deniedModules } from '../authorize/index.ts';

/* ONE MAP OVER ALL ORIGINS, WITH NO EXCEPTION FOR THE NEWEST ONE.
 *
 * `/api/v1/reminders` resolves to `calendar` via `moduleForPath()`, but the
 * rows come from many modules (see the comment above `mayTouchOrigin()` in
 * server/routes/reminders.js). Whatever is missing here, the router does not
 * hand out: `mayTouchOrigin()` refuses an unknown origin. A new origin that
 * only lands in VALID_ENTITY_TYPES and the migration's CHECK list would
 * therefore vanish silently from `/pending` - test/test-disabled-module-reminders.js
 * holds every value of both lists against this map. */
export const ORIGIN_MODULE = Object.freeze({
  task:                   'tasks',
  event:                  'calendar',
  subscription:           'budget',
  inventory_item:         'inventory',
  inventory_tracked_date: 'inventory',
  pantry_item:            'pantry',
  cycle_period:           'health',
  cycle_log_nudge:        'health',
  health_prevention_due:  'health',
  schedule_entry:         'schedule',
  schedule_extra_entry:   'schedule',
  waste_pickup:           'waste',
  document_expiry:        'documents',
  fasting_goal:           'health',
  fasting_next_start:     'health',
  shopping_move_returned: 'shopping',
});

/* THE SAME QUESTION FOR THE SUBSCRIPTION ADDRESSES (#2615).
 *
 * Each `/feed/<name>/:token.ics` route in server/index.js belongs to one
 * permission module. A member for whom that module is `none` gets an empty
 * calendar (`receive` of server/authorize/, as for the delivery below); the household switch stays
 * deliberately open for feeds (docs/DECISIONS.md). Birthdays follow
 * `calendar`, as in the delivery: `birthdays` is a nav id under it, not a
 * permission module of its own. A local calendar's feed is not here - its token
 * belongs to the calendar, not to a member.
 * test/test-denied-module-feeds.js holds every value against PERMISSION_MODULES. */
export const FEED_MODULE = Object.freeze({
  calendar:              'calendar',
  birthdays:             'calendar',
  'inventory-deadlines': 'inventory',
  cycle:                 'health',
  schedule:              'schedule',
  waste:                 'waste',
});

/**
 * Does this event belong to a birthday? Birthdays write their reminders as
 * `event` on the calendar event they create themselves
 * (services/birthdays.js#syncBirthdayReminder), so the map above sees
 * calendar in it. For the household switch, though, these are two modules.
 */
function isBirthdayEvent(database, eventId) {
  return Boolean(database.prepare(`
    SELECT 1 FROM birthdays WHERE calendar_event_id = ? OR name_day_calendar_event_id = ? LIMIT 1
  `).get(eventId, eventId));
}

/**
 * The rows without those whose module is switched off in the household (#1279).
 *
 * SKIP, DO NOT DELETE. A task or event reminder was set by hand; subscription,
 * inventory and document reminders are created only when their record is
 * WRITTEN. No run recreates any of them - deleted, it would never come back
 * after switching the module on again. The row therefore stays pending and is
 * delivered after switching back on, as after a server outage (the delivery
 * knows no age limit). Sources that a run recreates periodically (pantry,
 * schedule, waste, cycle, birthdays) additionally clean up their rows
 * themselves; for them this filter is only the latch between two runs.
 *
 * BIRTHDAYS ARE THE ONE EXCEPTION TO THE MAP: their `event` rows follow the
 * `birthdays` switch, not `calendar`. Without this distinction a switched-off
 * calendar would take the messages away from a household with birthdays
 * switched on. The lookup only happens when one of the two switches is set
 * at all.
 *
 * Synchronous, without `await`: the callers read the rows right before.
 *
 * @param {object} database
 * @param {Array<{entity_type: string, entity_id: number}>} rows
 * @returns {Array} the same row objects, filtered
 */
export function withoutSwitchedOffModules(database, rows) {
  const off = householdDisabledModules(database);
  if (!off.size) return rows;
  const eventsNeedLookup = off.has('calendar') || off.has('birthdays');
  return rows.filter((row) => {
    if (row.entity_type === 'event' && eventsNeedLookup) {
      return !off.has(isBirthdayEvent(database, row.entity_id) ? 'birthdays' : 'calendar');
    }
    return !off.has(ORIGIN_MODULE[row.entity_type]);
  });
}

/**
 * The modules denied entirely to THIS recipient - or `null` if the recipient
 * does not exist (any more).
 *
 * THE SAME TWO STEPS AS IN THE ROUTER, not a second spelling:
 * `resolvePermissions()` -> `buildSessionModuleAccess()` -> `deniedModules()`
 * is exactly the path `req.sessionModuleAccess` takes in server/auth.js and
 * that `mayTouchOrigin()` in server/routes/reminders.js evaluates. The first
 * two run in `actorForUser()` (server/authorize/), the actor without a request;
 * it does not classify display or guest accounts (see there). So here as
 * there only `none` counts, not `read`: whoever may read a module may also
 * hear from it - a filter that took the message away would turn a read
 * permission into a lock. An admin falls through `buildSessionModuleAccess()`
 * to `null` and thus to the empty set.
 *
 * `null` INSTEAD OF THE EMPTY SET FOR AN UNKNOWN RECIPIENT, and that is not a
 * matter of taste (see `creatorLacksPantry()` in services/pantry-reminders.js):
 * a denylist answers "unknown id" with "nothing denied", i.e. with YES.
 * Without an account there is nobody the message belongs to. `created_by` is
 * NOT NULL with a foreign key to `users` - but relying on exactly that would
 * make the answer depend on a PRAGMA.
 *
 * NO PRODUCTION CALLER SINCE PHASE 2 B2: the delivery
 * (`withoutModulesDeniedToRecipient()` below), the medication scheduler
 * (#2602) and the calendar feeds (#2615, server/index.js) ask
 * `authorize(actor, 'receive', { module })` of server/authorize/, which gives
 * the same answer. It stays exported for one reader: test/test-visibility-matrix.js
 * records its answer for an unknown account (`recipientDeniedModulesIsNull`,
 * test/visibility-matrix.expected.json). No new caller.
 *
 * @param {import('../authorize/index.ts').Database} database
 * @param {number} userId
 * @returns {Set<string>|null}
 */
export function recipientDeniedModules(database, userId) {
  const actor = actorForUser(database, userId);
  if (!actor) return null;
  return deniedModules(actor.moduleAccess);
}

/**
 * The rows without those whose module is denied to the RECIPIENT (#1289).
 *
 * THE SECOND AXIS OF THE DELIVERY, NEXT TO THE HOUSEHOLD SWITCH ABOVE.
 * `GET /reminders/pending` has asked it for a long time (`mayTouchOrigin()`),
 * Web Push and the channels did not: a member with `tasks: none` no longer saw
 * the toast but kept getting the task title on their phone, for subscriptions
 * including amount and date, and tapping it opened a page the route guard
 * refuses.
 *
 * THE CHECK LIVES HERE, at the ONE place every row has to pass, and not at
 * every source that writes rows: pantry, schedule, waste and cycle already ask
 * when creating, and still the gap stayed open - a permission can also be
 * revoked AFTER creation. A rule that lives on the write side would have to
 * stand in seven files and would be forgotten in the eighth.
 *
 * NO TOKEN SCOPES. The router's second axis has no counterpart here: a scope
 * belongs to an API token, i.e. to a REQUEST, and a delivery run is not one.
 * The account decides, not a credential that is not in play right now.
 *
 * SKIP, DO NOT DELETE - same reason as for the household switch above, and
 * here even more so: a revoked permission is an administrative decision that
 * can be reversed, and the row belongs to the member themselves (they set it
 * or got it assigned). `pushed_at` stays empty, the message goes out once the
 * permission is given back.
 *
 * BIRTHDAYS NEED NO EXCEPTION HERE, unlike for the household switch:
 * `birthdays` is not a permission module but a nav id under `calendar`
 * (PERMISSION_MODULES in server/authorize/catalog.ts). Whoever lacks the calendar
 * lacks the birthdays - special handling would invent a distinction the
 * permission matrix does not even offer.
 *
 * An origin WITHOUT a module passes, as for the household switch: the map
 * above is complete, and the guard in test/test-disabled-module-reminders.js
 * keeps it that way. Blocking on suspicion would be the wrong answer here - it
 * would let a future origin vanish silently instead of delivering it.
 *
 * Synchronous, without `await`: the caller reads the rows right before.
 *
 * @param {import('../authorize/index.ts').Database} database
 * @param {Array<{entity_type: string, created_by: number}>} rows
 * @returns {Array} the same row objects, filtered
 */
export function withoutModulesDeniedToRecipient(database, rows) {
  if (!rows.length) return rows;
  // The actor once per recipient, not per row: a run typically carries several
  // messages of the same person, and every resolution is up to three queries.
  const byUser = new Map();
  return rows.filter((row) => {
    if (!byUser.has(row.created_by)) byUser.set(row.created_by, actorForUser(database, row.created_by));
    const actor = byUser.get(row.created_by);
    // An unknown recipient: nobody the message belongs to, whatever its origin.
    if (!actor) return false;
    const moduleKey = ORIGIN_MODULE[row.entity_type];
    return !moduleKey || authorize(actor, 'receive', { module: moduleKey }).allowed;
  });
}
