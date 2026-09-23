/**
 * Modul: Medikamenten-Scheduler
 * Zweck: Erzeugt pro fälligem Einnahme-Zeitfenster einen pending-Dosis-Log und
 *        stellt eine Erinnerung über den BESTEHENDEN Push-/Notification-Channel-
 *        Layer zu (Web Push + Gotify/ntfy) — analog zu push-scheduler.js /
 *        notifications.js, ohne Delivery-Logik zu duplizieren.
 *        Empfänger sind die betroffene Person UND jede Person, die ein Admin
 *        als Betreuer eingetragen hat (health_care_grants, #584, D#1041).
 * Abhängigkeiten: server/db.js, push.js, notification-channels.js, notifications.js.
 */
import { runExternalJob } from '../utils/restore-state.js';
import { createLogger } from '../logger.js';
import * as dbModule from '../db.js';
import { pushService as defaultPushService } from './push.js';
import { createNotificationChannelStore } from './notification-channels.js';
import { defaultProviders } from './notifications.js';
import { resolveHouseholdLocale, translate } from '../utils/i18n.js';

const log = createLogger('MedicationScheduler');
const APP_NAME = 'Yuvomi';
// Fallback-Body, falls der Medikamentenname fehlt: nie den App-Namen wiederholen (#581).
const FALLBACK_BODY = 'Medication reminder';
const PROVIDER_TIMEOUT_MS = 8_000;

/** Lokaler Datums-Key (YYYY-MM-DD) ohne UTC-Shift. */
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Lokale Uhrzeit 'HH:MM'. */
function localTime(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Wochentag-Index (Mo=0…So=6) eines Datums-Keys. */
function weekdayIndex(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

/** Ist der Plan am gegebenen Datum fällig (Aktivität, Grenzen, Wochentags-Maske)? */
function scheduleDueOnDate(schedule, dateKey) {
  if (schedule.active === 0) return false;
  if (schedule.start_date && dateKey < schedule.start_date) return false;
  if (schedule.end_date && dateKey > schedule.end_date) return false;
  if (schedule.days_mask === null || schedule.days_mask === undefined) return true;
  return (schedule.days_mask & (1 << weekdayIndex(dateKey))) !== 0;
}

async function withTimeout(fn, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verarbeitet fällige Medikamenten-Dosen: legt fehlende pending-Logs an und
 * fan-outet je neuer Dosis eine Erinnerung an Web Push + aktive Kanäle des
 * Medikament-Eigentümers und seiner Betreuer.
 *
 * @param {Object} [opts]
 * @param {import('better-sqlite3-multiple-ciphers').Database} [opts.database]
 * @param {Object} [opts.pushService]  - { sendPushToUser }
 * @param {Object} [opts.channelStore] - { listEnabledChannelsForUser }
 * @param {Object} [opts.providers]    - { [provider]: { send } }
 * @param {Date}   [opts.now]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{ due:number, created:number, notified:number, sent:number, failed:number }>}
 */
/**
 * Als Job, der liest, nach aussen wartet und dann schreibt: waehrend eines
 * Restores beginnt er nicht, ein laufender wird abgewartet (Codex-Befund in
 * #1431, siehe server/utils/restore-state.js).
 */
export function processDueMedications(options) {
  return runExternalJob(() => processDueMedicationsUntracked(options));
}

async function processDueMedicationsUntracked({
  database,
  pushService = defaultPushService,
  channelStore,
  providers = defaultProviders,
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const activeDb = database || dbModule.get();
  const store = channelStore || createNotificationChannelStore({ db: activeDb });
  const dateKey = localDateKey(now);
  const nowTime = localTime(now);

  const schedules = activeDb.prepare(`
    SELECT s.*, m.user_id AS owner_id, m.name AS med_name, u.display_name AS owner_name
    FROM medication_schedules s
    JOIN medications m ON m.id = s.medication_id
    JOIN users u ON u.id = m.user_id
    WHERE s.active = 1 AND m.active = 1
  `).all();

  // Betreuer der betroffenen Person (#584). Das Recht wird je Person von einem
  // Admin vergeben und ist nie aus einer Rolle abgeleitet - deshalb wird es hier
  // genauso nachgeschlagen wie beim Eintragen und nicht aus "ist Elternteil"
  // geraten. Bis D#1041 fragte der Scheduler die Tabelle gar nicht: ein Kind
  // ohne Geraet bekam die Erinnerung, die Eltern nicht.
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
    if (s.time_of_day > nowTime) continue; // heute noch nicht fällig
    const scheduledAt = `${dateKey}T${s.time_of_day}`;
    counters.due += 1;
    if (findLog.get(s.medication_id, s.id, scheduledAt)) continue; // schon erzeugt
    insertLog.run(s.medication_id, s.id, scheduledAt, 'pending', s.dose_qty ?? null);
    counters.created += 1;
    newlyDue.push({
      ownerId: s.owner_id, ownerName: s.owner_name, medName: s.med_name,
      medicationId: s.medication_id, scheduledAt,
    });
  }

  // Herkunft im Titel statt des App-Namens - Begruendung bei REMINDER_TITLE_KEYS
  // in notifications.js. „Yuvomi / Ibuprofen" sagte nicht, worum es geht;
  // „Medikamente / Ibuprofen" tut es, und zwar auf jeder Plattform.
  const originTitle = translate(resolveHouseholdLocale(activeDb), 'health.tabs.meds');

  for (const dose of newlyDue) {
    const medBody = dose.medName || FALLBACK_BODY;
    counters.notified += 1;

    // Die betroffene Person bekommt ihre Erinnerung wie bisher; jeder Betreuer
    // dieselbe mit vorangestelltem Namen ("Anna: Ibuprofen"). Der Name steht
    // nur beim Betreuer: er sagt, UM WEN es geht, und das ist auf dem eigenen
    // Geraet keine Frage. Eine Person ohne Geraet kostet nichts (kein Abo, kein
    // Kanal), eine mit Geraet bekommt weiterhin ihre eigene Erinnerung - so
    // gilt dieselbe Regel fuer das Fuenfjaehrige und das Vierzehnjaehrige.
    const recipients = [{ userId: dose.ownerId, body: medBody }];
    for (const { caregiver_id: caregiverId } of caregiversOf.all(dose.ownerId)) {
      if (caregiverId === dose.ownerId) continue;
      recipients.push({ userId: caregiverId, body: `${dose.ownerName}: ${medBody}` });
    }

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

      const channels = store.listEnabledChannelsForUser(recipient.userId);
      for (const channel of channels) {
        const provider = providers[channel.provider];
        if (!provider) continue;
        try {
          await withTimeout((signal) => provider.send({ channel, payload, fetchImpl, signal }));
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
