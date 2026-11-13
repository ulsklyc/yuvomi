/**
 * Module: medication scheduler
 * Purpose: Creates a pending dose log for every due intake slot and delivers a
 *          reminder through the EXISTING push / notification-channel layer
 *          (Web Push + Gotify/ntfy) - the same building blocks as
 *          push-scheduler.js / notifications.js, without duplicating delivery
 *          logic.
 *          Recipients are the person the medication belongs to AND every
 *          person an admin has entered as their caregiver (health_care_grants,
 *          #584, D#1041) - each of them only while Health is not denied to
 *          them (#2602), and never through a channel the household shares
 *          (#2598).
 * Dependencies: server/db.js, push.js, notification-channels.js, channel-delivery.js,
 *               household-modules.js, server/authorize/, utils/timezone.js.
 */
import { runExternalJob } from '../utils/restore-state.js';
import { createLogger } from '../logger.js';
import * as dbModule from '../db.js';
import { pushService as defaultPushService } from './push.js';
import { createNotificationChannelStore } from './notification-channels.js';
import { defaultProviders, sendToChannel } from './channel-delivery.js';
import { householdDisabledModules } from './household-modules.js';
import { actorForUser, authorize } from '../authorize/index.ts';
import { resolveHouseholdLocale, translate } from '../utils/i18n.js';
import { householdTimeZone, utcToWall } from '../utils/timezone.js';

const log = createLogger('MedicationScheduler');
const APP_NAME = 'Yuvomi';
// Fallback body when the medication has no name: never repeat the app name (#581).
const FALLBACK_BODY = 'Medication reminder';

/**
 * Day (YYYY-MM-DD) and time ('HH:MM') of `now` on the HOUSEHOLD's clock.
 * `time_of_day` and `scheduled_at` are wall-clock times of the household; this
 * used to call getDate()/getHours(), i.e. the zone of the server PROCESS - with
 * `TZ=UTC` in the container the 08:00 reminder in Berlin arrived at 10:00
 * (#1539).
 */
function householdWallClock(database, now) {
  const iso = now.toISOString();
  const wall = utcToWall(iso, householdTimeZone(database));
  return wall
    ? { dateKey: wall.date, time: wall.time.slice(0, 5) }
    : { dateKey: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** Weekday index (Mon=0 ... Sun=6) of a date key - zone-free via Date.UTC. */
function weekdayIndex(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Is the schedule due on the given date (active flag, bounds, weekday mask)? */
function scheduleDueOnDate(schedule, dateKey) {
  if (schedule.active === 0) return false;
  if (schedule.start_date && dateKey < schedule.start_date) return false;
  if (schedule.end_date && dateKey > schedule.end_date) return false;
  if (schedule.days_mask === null || schedule.days_mask === undefined) return true;
  return (schedule.days_mask & (1 << weekdayIndex(dateKey))) !== 0;
}

/**
 * May this recipient hear about a medication dose at all?
 *
 * THE SAME VERDICT AS THE REGULAR DELIVERY PATH (#2602). Reminder rows go
 * through `withoutModulesDeniedToRecipient()` in notifications.js since #1289;
 * this scheduler sends on its own and only asked the household switch. A
 * member whose Health permission was set to `none` kept getting "Ibuprofen" on
 * their phone - and a caregiver kept getting ANOTHER person's dose
 * ("Anna: Ibuprofen") after their access to Health had been taken away, with
 * a tap target (`/health/meds`) the route guard refuses.
 *
 * Only `none` counts, not `read`: whoever may read Health may hear from it.
 * An admin is never filtered. An unknown recipient (no actor) is dropped -
 * there is nobody the reminder belongs to. The verdict is `receive` of
 * server/authorize/.
 *
 * SKIP, DO NOT DELETE: the dose log is written before this question is asked
 * and stays, like a reminder row under #1289. A revoked right is an
 * administrative decision that can be reversed; the person's history is not
 * part of it.
 */
function mayHearAboutHealth(database, userId) {
  return authorize(actorForUser(database, userId), 'receive', { module: 'health' }).allowed;
}

/**
 * Processes due medication doses: creates missing pending logs and fans out
 * one reminder per new dose to Web Push and to the recipient's OWN channels,
 * for the medication's owner and for their caregivers.
 *
 * @param {Object} [opts]
 * @param {import('better-sqlite3-multiple-ciphers').Database} [opts.database]
 * @param {Object} [opts.pushService]  - { sendPushToUser }
 * @param {Object} [opts.channelStore] - { listEnabledChannelsForUser }
 * @param {Object} [opts.providers]    - { [provider]: { send } }
 * @param {Date}   [opts.now]
 * @param {Function} [opts.fetchImpl] - tests inject one; without it the delivery takes
 *   the SSRF-guarded fetch that channel-delivery.js sets as the default for every sender
 * @returns {Promise<{ due:number, created:number, notified:number, sent:number, failed:number }>}
 */
/**
 * Runs as a job that reads, waits on the outside world and then writes: it
 * does not start while a restore is running, and a running one is awaited
 * (Codex finding in #1431, see server/utils/restore-state.js).
 */
export function processDueMedications(options) {
  return runExternalJob(() => processDueMedicationsUntracked(options));
}

/**
 * @param {{
 *   database?: any, pushService?: typeof defaultPushService, channelStore?: any,
 *   providers?: typeof defaultProviders, now?: Date, fetchImpl?: Function,
 * }} [opts] - described at processDueMedications()
 */
async function processDueMedicationsUntracked({
  database,
  pushService = defaultPushService,
  channelStore,
  providers = defaultProviders,
  now = new Date(),
  // No default of its own: `undefined` falls through to the guarded fetch of
  // sendToChannel(), the one default for every sender.
  fetchImpl,
} = {}) {
  const activeDb = database || dbModule.get();

  // HEALTH SWITCHED OFF FOR THE WHOLE HOUSEHOLD MEANS: THE RUN DOES NOTHING (#1660).
  // Same rule as the reminder syncs since #1279 - the household does not use
  // the module, so the server creates no dose and announces none on its own.
  // Until then this run kept writing logs every minute and sending pushes whose
  // tap led to a page the route guard refuses.
  //
  // AFTER SWITCHING IT BACK ON, ONLY TODAY COMES BACK, and that follows from
  // the design further down, not from a special rule here: due is what was
  // already due TODAY and has no log yet. Nobody catches up on the doses of
  // the days in between - the same course as after a server outage, at most
  // one message per intake time of today and no flood. That is also why
  // nothing is cleaned up: what was created before switching off is the
  // person's history and stays.
  if (householdDisabledModules(activeDb).has('health')) {
    return { due: 0, created: 0, notified: 0, sent: 0, failed: 0 };
  }

  const store = channelStore || createNotificationChannelStore({ db: activeDb });
  const { dateKey, time: nowTime } = householdWallClock(activeDb, now);

  const schedules = activeDb.prepare(`
    SELECT s.*, m.user_id AS owner_id, m.name AS med_name, u.display_name AS owner_name
    FROM medication_schedules s
    JOIN medications m ON m.id = s.medication_id
    JOIN users u ON u.id = m.user_id
    WHERE s.active = 1 AND m.active = 1
  `).all();

  // Caregivers of the affected person (#584). The grant is given per person by
  // an admin and is never derived from a role - so it is looked up here
  // exactly as when it is entered, not guessed from "is a parent". Until
  // D#1041 the scheduler did not query the table at all: a child without a
  // device got the reminder, the parents did not.
  const caregiversOf = activeDb.prepare(
    'SELECT caregiver_id FROM health_care_grants WHERE subject_id = ? ORDER BY caregiver_id'
  );

  const findLog = activeDb.prepare(
    'SELECT id FROM medication_logs WHERE medication_id = ? AND schedule_id = ? AND scheduled_at = ?'
  );
  const insertLog = activeDb.prepare(
    'INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, dose_qty) VALUES (?, ?, ?, ?, ?)'
  );

  const counters = { due: 0, created: 0, notified: 0, sent: 0, failed: 0 };
  const newlyDue = [];

  for (const s of schedules) {
    if (!scheduleDueOnDate(s, dateKey)) continue;
    if (s.time_of_day > nowTime) continue; // not due yet today
    const scheduledAt = `${dateKey}T${s.time_of_day}`;
    counters.due += 1;
    if (findLog.get(s.medication_id, s.id, scheduledAt)) continue; // already created
    insertLog.run(s.medication_id, s.id, scheduledAt, 'pending', s.dose_qty ?? null);
    counters.created += 1;
    newlyDue.push({
      ownerId: s.owner_id, ownerName: s.owner_name, medName: s.med_name,
      medicationId: s.medication_id, scheduledAt,
    });
  }

  // The origin in the title instead of the app name - reasoning at
  // REMINDER_TITLE_KEYS in notifications.js. "Yuvomi / Ibuprofen" did not say
  // what it is about; "Medications / Ibuprofen" does, on every platform.
  const originTitle = translate(resolveHouseholdLocale(activeDb), 'health.tabs.meds');

  // WHO HEARS ABOUT WHICH DOSE IS DECIDED HERE, FOR ALL DOSES, BEFORE THE FIRST
  // `await` (#2602). Same shape as processDueNotifications(): read, judge,
  // then send - no yield point between the permission lookup and the verdict.
  //
  // The affected person gets their reminder as before; every caregiver gets
  // the same one with the person's name in front ("Anna: Ibuprofen"). The name
  // appears only for the caregiver: it says WHO it is about, which is no
  // question on one's own device. A person without a device costs nothing (no
  // subscription, no channel), one with a device keeps getting their own
  // reminder - so the same rule holds for the five-year-old and the
  // fourteen-year-old.
  //
  // Once per recipient and run, not per dose, like withoutModulesDeniedToRecipient():
  // every resolution is two queries, and the cache cannot go stale because no
  // `await` lies between the first lookup and the last.
  const mayHear = new Map();
  const recipientMayHear = (userId) => {
    if (!mayHear.has(userId)) mayHear.set(userId, mayHearAboutHealth(activeDb, userId));
    return mayHear.get(userId);
  };
  const deliveries = newlyDue.map((dose) => {
    const medBody = dose.medName || FALLBACK_BODY;
    const recipients = [{ userId: dose.ownerId, body: medBody }];
    for (const { caregiver_id: caregiverId } of caregiversOf.all(dose.ownerId)) {
      if (caregiverId === dose.ownerId) continue;
      recipients.push({ userId: caregiverId, body: `${dose.ownerName}: ${medBody}` });
    }
    return { dose, recipients: recipients.filter(({ userId }) => recipientMayHear(userId)) };
  });

  for (const { dose, recipients } of deliveries) {
    // `notified` counts doses that went out to at least one recipient, not
    // recipients - and not a dose nobody may hear about.
    if (!recipients.length) continue;
    counters.notified += 1;

    for (const recipient of recipients) {
      const payload = {
        title: originTitle || APP_NAME,
        body: recipient.body,
        url: '/health/meds',
        tag: `medication-${dose.medicationId}-${dose.scheduledAt}`,
        priority: 'default',
      };

      try {
        const sent = await pushService.sendPushToUser(recipient.userId, payload);
        if (sent > 0) counters.sent += 1;
      } catch (err) {
        counters.failed += 1;
        log.error(`Web Push failed for medication ${dose.medicationId}:`, err?.message || err);
      }

      // ONLY THE RECIPIENT'S OWN CHANNELS, NEVER ONE THE HOUSEHOLD SHARES (#2598).
      // Every Health origin is `'personal'` for household channels
      // (HOUSEHOLD_CHANNEL_POLICY in authorize/rows/reminders.ts), and SECURITY.md
      // promises that a channel shared by the household never receives a
      // health reminder. A medication's row visibility does not change that:
      // a family-visible one still goes out by push and to the person's own
      // channels only. Allowlist, as in processDueNotifications(): a channel
      // without or with an unknown `scope` counts as a household channel.
      // Until then this loop handed every dose - private ones included, plus
      // one copy per caregiver with the person's name - to the household's
      // ntfy/Gotify/webhook/e-mail channel.
      const channels = store.listEnabledChannelsForUser(recipient.userId)
        .filter((channel) => channel.scope === 'user');
      for (const channel of channels) {
        if (!providers[channel.provider]) continue;
        try {
          await sendToChannel({ channel, payload, fetchImpl, providers });
          counters.sent += 1;
        } catch (err) {
          counters.failed += 1;
          log.error(`Channel delivery failed for medication ${dose.medicationId}:`, err?.message || err);
        }
      }
    }
  }

  if (counters.created) log.info(`Created ${counters.created} due medication dose(s).`);
  return counters;
}

export function startScheduler() {
  const run = () => {
    processDueMedications().catch((err) => log.error('Medication scheduler run failed:', err?.message || err));
  };
  setTimeout(run, 15_000).unref();
  setInterval(run, 60_000).unref();
  log.info('Medication scheduler active (every 60s).');
}
