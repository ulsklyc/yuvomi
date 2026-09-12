/**
 * Modul: Notification-Orchestrator
 * Zweck: Reminder an Web Push und externe Notification-Channels fan-outen und Delivery-State pflegen.
 * Abhaengigkeiten: server/db.js, push.js, notification-channels.js, Provider-Adapter
 */
import { createLogger } from '../logger.js';
import * as dbModule from '../db.js';
import { pushService as defaultPushService } from './push.js';
import { createNotificationChannelStore } from './notification-channels.js';
import { gotifyProvider } from './notification-providers/gotify.js';
import { ntfyProvider } from './notification-providers/ntfy.js';
import { webhookProvider } from './notification-providers/webhook.js';
import { emailProvider } from './notification-providers/email.js';
import { guardedFetch } from './notification-providers/guarded-fetch.js';
import { syncAllBirthdayReminders } from './birthdays.js';
import { resolveHouseholdLocale, translate } from '../utils/i18n.js';
import { warrantyEndDate } from './inventory-deadlines.js';
import { syncAllPantryExpiryReminders } from './pantry-reminders.js';
import { syncAllCycleReminders } from './cycle-reminders.js';
import { syncAllScheduleReminders } from './schedule-reminders.js';
import { syncAllWasteReminders } from './waste-reminders.js';

const log = createLogger('Notifications');
const APP_NAME = 'Yuvomi';
// Greift nur, wenn die verknuepfte Entitaet inzwischen geloescht wurde: nie den
// App-Namen als Body wiederholen, sonst besteht die Notification nur aus "Yuvomi" (#581).
const FALLBACK_BODY = 'Reminder';
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// Exportiert, damit die Zeitschranken des Mail-Transports (services/email.js)
// dagegen gepruefte werden koennen statt gegen eine abgeschriebene Zahl: die
// Staffelung ist die Zusicherung, nicht der einzelne Wert.
export const PROVIDER_TIMEOUT_MS = 8_000;

export const defaultProviders = {
  gotify: gotifyProvider,
  ntfy: ntfyProvider,
  webhook: webhookProvider,
  email: emailProvider,
};

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeError(error) {
  return String(error?.message || error || 'Notification delivery failed.').slice(0, 500);
}

/**
 * Body einer Abo-Erinnerung: Name, Betrag und Verlaengerungsdatum (#581).
 * Bewusst nur Daten, kein Satzbau - der Server kennt die Sprache des Empfaengers
 * nicht (Locale und Zahlen-/Datumsformat liegen im localStorage des Clients),
 * deshalb ISO-Datum und Betrag mit Waehrungscode statt formulierter Text.
 */
function subscriptionBody(reminder) {
  const parts = [reminder.entity_title];
  const amount = Number(reminder.sub_amount);
  if (Number.isFinite(amount) && reminder.sub_currency) {
    parts.push(`${amount.toFixed(2)} ${reminder.sub_currency}`);
  }
  if (reminder.sub_next_payment_date) parts.push(String(reminder.sub_next_payment_date).slice(0, 10));
  return parts.join(' - ');
}

/**
 * DER TITEL EINER MELDUNG NENNT IHRE HERKUNFT.
 *
 * Die Herkunfts-Regel (Block 2) gibt jeder Meldung ihr Siegel - eine
 * Systembenachrichtigung kann keines tragen: sie hat kein DOM, ihr `icon` zeigt
 * nur ein Teil der Plattformen, und ihr `badge` wird auf Android monochrom
 * maskiert, wodurch der Familienton ohnehin verloren ginge. Was auf JEDER
 * Plattform ankommt, ist der Titel, und der stand bisher app-weit auf „Yuvomi" -
 * also auf dem, was das System darueber ohnehin schon anzeigt. „Kalender" ueber
 * „Zahnarzttermin" beantwortet dieselbe Frage wie das Siegel im Toast.
 *
 * UEBERSETZT UEBER DIE DATENSPRACHE DES HAUSHALTS, nicht ueber die des
 * Empfaengers: die kennt der Server nicht (Locale liegt im localStorage). Das
 * ist dieselbe Sprache, in der er schon Geburtstagstermine ablegt, und dieselbe
 * Quelle - public/locales/*.json ueber utils/i18n.js. Die Keys sind bestehende
 * Modulnamen; eine Meldung braucht dafuer kein eigenes Vokabular.
 */
/*
 * UND DIESELBE HERKUNFT SETZT DAS ZIEL (Critique 2026-08-10).
 *
 * Der Titel nannte das Modul, und der Tipp darauf landete trotzdem im
 * Dashboard: `url` stand fest auf `/reminders`, und diese Route gibt es in
 * `ROUTES` nicht - der Router fiel still auf `/` zurueck, Dokumenttitel
 * „Yuvomi · Yuvomi". Der Befund war schon vorher einer und ist seit der
 * Titel-Herkunft doppelt so teuer: die Meldung sagt jetzt, wo sie herkommt,
 * und schickt den Nutzer trotzdem woandershin.
 *
 * Die Zuordnung stand die ganze Zeit hier - sie wurde nur nicht gefragt. Ein
 * Eintrag traegt beides, Titel und Ziel, damit die zweite Antwort nicht von
 * der ersten wegdriften kann. Push ist der zeitkritischste Pfad der App: wer
 * eine Erinnerung antippt, will an das Ding, nicht an eine Uebersicht.
 *
 * Abonnements zeigen auf `/budget` und nicht auf ihren Tab darin - einen
 * Deep-Link auf `budget.activeTab` gibt es nicht (geprueft). Das Modul ist die
 * genaueste Antwort, die das Ziel heute geben kann, und immer noch eine.
 */
const REMINDER_ORIGINS = {
  task:                   { titleKey: 'nav.tasks',              url: '/tasks' },
  event:                  { titleKey: 'nav.calendar',           url: '/calendar' },
  subscription:           { titleKey: 'subscriptions.tabLabel', url: '/budget' },
  inventory_item:         { titleKey: 'nav.inventory',          url: '/inventory' },
  inventory_tracked_date: { titleKey: 'nav.inventory',          url: '/inventory' },
  pantry_item:            { titleKey: 'nav.pantry',             url: '/pantry' },
  // Beide Zyklus-Herkuenfte teilen sich denselben Titel/Ziel - gleiches
  // Vorbild wie schedule_entry/schedule_extra_entry (Schedule v3), zwei
  // entity_type fuer zwei Sync-Quellen, eine Modul-Beschriftung.
  cycle_period:           { titleKey: 'health.cycle.title',     url: '/health' },
  cycle_log_nudge:        { titleKey: 'health.cycle.title',     url: '/health' },
  schedule_entry:         { titleKey: 'nav.schedule',           url: '/schedule' },
  schedule_extra_entry:   { titleKey: 'nav.schedule',           url: '/schedule' },
  // url here is only the fallback used when waste_type_id/waste_date_key are
  // unavailable (entity deleted between sync and delivery) - the normal path
  // overrides it in reminderPayload() with the stable ?type=&date= deep link
  // contract every other Waste projection already uses.
  waste_pickup:           { titleKey: 'nav.waste',              url: '/waste' },
};

/**
 * Body einer Garantie-Erinnerung: Gegenstandsname und Garantieende.
 * Gleiche Begruendung wie bei subscriptionBody - reine Daten, kein Satzbau,
 * weil der Server die Sprache des Empfaengers nicht kennt. Faellt das
 * Garantieende nicht berechenbar aus (unplausibles Kaufdatum, geloeschte
 * Felder), bleibt der Name allein stehen statt die Zustellung zu sprengen.
 */
function warrantyBody(reminder) {
  if (!reminder.inv_purchase_date || reminder.inv_warranty_months == null) return reminder.entity_title;
  try {
    return `${reminder.entity_title} - ${warrantyEndDate(reminder.inv_purchase_date, reminder.inv_warranty_months)}`;
  } catch {
    return reminder.entity_title;
  }
}

/**
 * Body einer Fristen-Erinnerung: Gegenstand · Bezeichnung, plus das Datum.
 * Gleiche Begruendung wie subscriptionBody/warrantyBody - reine Daten, kein
 * Satzbau, weil der Server die Sprache des Empfaengers nicht kennt.
 */
function trackedDateBody(reminder) {
  if (!reminder.inv_tracked_date) return reminder.entity_title;
  return `${reminder.entity_title} - ${reminder.inv_tracked_date}`;
}

/**
 * Body einer Ablauf-Erinnerung: Artikelname und Mindesthaltbarkeitsdatum.
 * Gleiche Begruendung wie die drei Funktionen darueber - reine Daten, kein
 * Satzbau, weil der Server die Sprache des Empfaengers nicht kennt.
 */
function pantryExpiryBody(reminder) {
  if (!reminder.pantry_expires_on) return reminder.entity_title;
  return `${reminder.entity_title} - ${reminder.pantry_expires_on}`;
}

/**
 * Body einer Zyklus-Erinnerung: `entity_title` ist bei diesen beiden Arten das
 * rohe `anchor_date` (siehe REMINDER_ORIGINS-Kommentar), kein Name - "Zyklus"
 * mit einem nackten Datum darunter sagt nicht, ob die Periode erwartet wird
 * oder der heutige Tag noch nicht geloggt ist. Anders als
 * subscriptionBody/warrantyBody/... nutzt das hier bewusst translate(locale,
 * ...): reminderPayload() tut das für den Titel schon (Haushaltssprache, der
 * Server kennt die Empfaengersprache nicht), Satzbau fuer den Body ist
 * dieselbe Ausnahme, kein neues Prinzip.
 */
function cycleBody(reminder, locale) {
  if (reminder.entity_type === 'cycle_log_nudge') {
    return translate(locale, 'health.cycle.settings.remindLogDaily');
  }
  return `${translate(locale, 'health.cycle.status.nextPeriod')} - ${reminder.entity_title}`;
}

function scheduleEntryBody(reminder) {
  if (!reminder.schedule_start_time) return reminder.entity_title;
  return `${reminder.entity_title} - ${reminder.schedule_start_time}`;
}

/**
 * Body of a Waste pickup reminder: the type name and its raw YYYY-MM-DD
 * pickup date - same reasoning as warrantyBody/trackedDateBody/
 * pantryExpiryBody above (plain data, no sentence, the server doesn't know
 * the recipient's date-format locale).
 */
function wastePickupBody(reminder) {
  if (!reminder.waste_date_key) return reminder.entity_title;
  return `${reminder.entity_title} - ${reminder.waste_date_key}`;
}

function reminderPayload(reminder, locale) {
  const title = reminder.entity_title || FALLBACK_BODY;
  const origin = REMINDER_ORIGINS[reminder.entity_type];
  let body = title;
  if (reminder.entity_type === 'subscription' && reminder.entity_title) {
    body = subscriptionBody(reminder);
  } else if (reminder.entity_type === 'inventory_item' && reminder.entity_title) {
    body = warrantyBody(reminder);
  } else if (reminder.entity_type === 'inventory_tracked_date' && reminder.entity_title) {
    body = trackedDateBody(reminder);
  } else if (reminder.entity_type === 'pantry_item' && reminder.entity_title) {
    body = pantryExpiryBody(reminder);
  } else if ((reminder.entity_type === 'cycle_period' || reminder.entity_type === 'cycle_log_nudge') && reminder.entity_title) {
    body = cycleBody(reminder, locale);
  } else if ((reminder.entity_type === 'schedule_entry' || reminder.entity_type === 'schedule_extra_entry') && reminder.entity_title) {
    body = scheduleEntryBody(reminder);
  } else if (reminder.entity_type === 'waste_pickup' && reminder.entity_title) {
    body = wastePickupBody(reminder);
  }
  // Waste is the one entity_type with a real per-occurrence deep link
  // (?type=<id>&date=<date_key>, the same contract every other Waste
  // projection - Dashboard widget, Calendar chip - already uses); every other
  // origin's url is a static page. Falls back to the origin's plain /waste
  // only if the anchor/type vanished between sync and delivery.
  const url = (reminder.entity_type === 'waste_pickup' && reminder.waste_type_id && reminder.waste_date_key)
    ? `/waste?type=${reminder.waste_type_id}&date=${reminder.waste_date_key}`
    : (origin ? origin.url : '/');
  return {
    // Ohne bekannte Herkunft bleibt der App-Name: er ist nichtssagend, aber nie
    // falsch - und ein roher `entity_type` im Titel waere beides. Das Ziel
    // faellt aus demselben Grund auf die Uebersicht: sie ist die einzige Seite,
    // die es mit Sicherheit gibt.
    title: origin ? translate(locale, origin.titleKey) : APP_NAME,
    body,
    url,
    tag: `reminder-${reminder.id}`,
    priority: 'default',
  };
}

function upsertPendingDelivery(database, { reminderId, provider, channelId = null, targetKey, nowIso }) {
  database.prepare(`
    INSERT INTO notification_deliveries
      (reminder_id, provider, channel_id, target_key, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(reminder_id, provider, target_key) DO NOTHING
  `).run(reminderId, provider, channelId, targetKey, nowIso, nowIso);
  return database.prepare(`
    SELECT * FROM notification_deliveries
    WHERE reminder_id = ? AND provider = ? AND target_key = ?
  `).get(reminderId, provider, targetKey);
}

function shouldAttempt(delivery, nowIso) {
  if (!delivery) return true;
  if (delivery.status === 'sent' || delivery.status === 'skipped') return false;
  if (delivery.status === 'failed' && delivery.next_attempt_at && delivery.next_attempt_at > nowIso) return false;
  return delivery.attempt_count < MAX_ATTEMPTS;
}

function markSent(database, deliveryId, nowIso) {
  database.prepare(`
    UPDATE notification_deliveries
    SET status = 'sent',
        attempt_count = attempt_count + 1,
        last_attempt_at = ?,
        next_attempt_at = NULL,
        sent_at = ?,
        error = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(nowIso, nowIso, nowIso, deliveryId);
}

function markSkipped(database, deliveryId, nowIso, reason) {
  database.prepare(`
    UPDATE notification_deliveries
    SET status = 'skipped',
        next_attempt_at = NULL,
        error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(reason, nowIso, deliveryId);
}

function markFailed(database, deliveryId, now, error) {
  const nowIso = iso(now);
  const row = database.prepare('SELECT attempt_count FROM notification_deliveries WHERE id = ?').get(deliveryId);
  const nextAttempt = (row?.attempt_count ?? 0) + 1;
  const exhausted = nextAttempt >= MAX_ATTEMPTS;
  database.prepare(`
    UPDATE notification_deliveries
    SET status = ?,
        attempt_count = ?,
        last_attempt_at = ?,
        next_attempt_at = ?,
        error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    exhausted ? 'skipped' : 'failed',
    nextAttempt,
    nowIso,
    exhausted ? null : iso(new Date(now.getTime() + RETRY_DELAY_MS)),
    safeError(error),
    nowIso,
    deliveryId
  );
  return exhausted ? 'skipped' : 'failed';
}

function allKnownDeliveriesComplete(database, reminderId, expectedTargets) {
  if (expectedTargets.length === 0) return true;
  const rows = database.prepare(`
    SELECT provider, target_key, status
    FROM notification_deliveries
    WHERE reminder_id = ?
  `).all(reminderId);
  const byKey = new Map(rows.map((row) => [`${row.provider}:${row.target_key}`, row.status]));
  return expectedTargets.every((target) => {
    const status = byKey.get(`${target.provider}:${target.targetKey}`);
    return status === 'sent' || status === 'skipped';
  });
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

export function createNotificationService({ providers = defaultProviders, channelStore } = {}) {
  async function testChannel({ channel, payload, fetchImpl = guardedFetch } = {}) {
    const provider = providers[channel?.provider];
    if (!provider) throw new Error('Unknown notification provider.');
    return withTimeout((signal) => provider.send({ channel, payload, fetchImpl, signal }));
  }

  return { providers, channelStore, testChannel };
}

export async function processDueNotifications({
  database,
  pushService = defaultPushService,
  channelStore,
  providers = defaultProviders,
  now = new Date(),
  fetchImpl = guardedFetch,
} = {}) {
  const getDb = () => (database || dbModule.get());
  const activeDb = getDb();
  const nowIso = iso(now);
  const store = channelStore || createNotificationChannelStore({ db: activeDb });

  const users = activeDb.prepare('SELECT id FROM users').all();
  for (const user of users) {
    try {
      syncAllBirthdayReminders(activeDb, user.id, now);
    } catch (err) {
      log.error(`Birthday sync failed for user ${user.id}:`, err?.message || err);
    }
  }

  // DER BESTAND ZIEHT HIER NACH, nicht erst beim naechsten Anfassen. Der
  // Router legt die Erinnerung eines Artikels beim Speichern an - aber ein
  // Vorrat, der schon vor diesem Feature im Regal stand, ist nie gespeichert
  // worden und haette nie gemeldet. Gleiche Bauart und gleiche Stelle wie der
  // Geburtstags-Sync darueber: idempotent, ohne Zustand, bei jedem Lauf erneut.
  // Haushaltsweit statt je Nutzer - der Vorrat gehoert dem Haushalt.
  try {
    syncAllPantryExpiryReminders(activeDb, now);
  } catch (err) {
    log.error('Pantry expiry sync failed:', err?.message || err);
  }

  // Gleiche Stelle, gleiche Bauart: ein rollierendes Fenster je Nutzer statt
  // haushaltweit, weil der Zyklus (anders als der Vorrat) persoenlich ist.
  try {
    syncAllCycleReminders(activeDb, now);
  } catch (err) {
    log.error('Cycle reminder sync failed:', err?.message || err);
  }
  // haushaltweit, weil der Schichtplan (anders als der Vorrat) persoenlich ist.
  try {
    syncAllScheduleReminders(activeDb, now);
  } catch (err) {
    log.error('Schedule reminder sync failed:', err?.message || err);
  }
  // Gleiche Stelle, gleiche Bauart: je Nutzer, weil eine Waste-Erinnerung eine
  // persoenliche Typ-Auswahl ist (waste_reminder_settings), nicht haushaltweit
  // wie der Vorrat.
  try {
    syncAllWasteReminders(activeDb, now);
  } catch (err) {
    log.error('Waste reminder sync failed:', err?.message || err);
  }

  const due = activeDb.prepare(`
    SELECT r.id, r.created_by, r.entity_type,
      CASE r.entity_type
        WHEN 'task'  THEN (SELECT title FROM tasks           WHERE id = r.entity_id)
        WHEN 'event' THEN (SELECT title FROM calendar_events WHERE id = r.entity_id)
        WHEN 'subscription' THEN (SELECT name FROM budget_subscriptions WHERE id = r.entity_id)
        WHEN 'inventory_item' THEN (SELECT name FROM inventory_items WHERE id = r.entity_id)
        WHEN 'inventory_tracked_date' THEN (
          SELECT ii.name || ' · ' || d.label
          FROM inventory_item_dates d JOIN inventory_items ii ON ii.id = d.item_id
          WHERE d.id = r.entity_id
        )
        WHEN 'pantry_item' THEN (SELECT name FROM pantry_items WHERE id = r.entity_id)
        WHEN 'cycle_period' THEN (SELECT anchor_date FROM cycle_reminder_anchors WHERE id = r.entity_id)
        WHEN 'cycle_log_nudge' THEN (SELECT anchor_date FROM cycle_reminder_anchors WHERE id = r.entity_id)
        WHEN 'schedule_entry' THEN (
          SELECT t.name FROM schedule_reminder_entries e JOIN schedule_shift_types t ON t.id = e.shift_type_id
          WHERE e.id = r.entity_id
        )
        WHEN 'schedule_extra_entry' THEN (
          SELECT t.name FROM schedule_extra_shifts e JOIN schedule_shift_types t ON t.id = e.shift_type_id
          WHERE e.id = r.entity_id
        )
        WHEN 'waste_pickup' THEN (
          SELECT t.name FROM waste_reminder_entries e JOIN waste_types t ON t.id = e.type_id
          WHERE e.id = r.entity_id
        )
      END AS entity_title,
      CASE WHEN r.entity_type = 'inventory_item'
        THEN (SELECT purchase_date FROM inventory_items WHERE id = r.entity_id) END AS inv_purchase_date,
      CASE WHEN r.entity_type = 'inventory_item'
        THEN (SELECT warranty_months FROM inventory_items WHERE id = r.entity_id) END AS inv_warranty_months,
      CASE WHEN r.entity_type = 'inventory_tracked_date'
        THEN (SELECT date FROM inventory_item_dates WHERE id = r.entity_id) END AS inv_tracked_date,
      CASE WHEN r.entity_type = 'pantry_item'
        THEN (SELECT expires_on FROM pantry_items WHERE id = r.entity_id) END AS pantry_expires_on,
      CASE
        WHEN r.entity_type = 'schedule_entry' THEN (
          SELECT t.start_time FROM schedule_reminder_entries e JOIN schedule_shift_types t ON t.id = e.shift_type_id
          WHERE e.id = r.entity_id
        )
        WHEN r.entity_type = 'schedule_extra_entry' THEN (
          SELECT t.start_time FROM schedule_extra_shifts e JOIN schedule_shift_types t ON t.id = e.shift_type_id
          WHERE e.id = r.entity_id
        )
      END AS schedule_start_time,
      CASE WHEN r.entity_type = 'waste_pickup'
        THEN (SELECT type_id FROM waste_reminder_entries WHERE id = r.entity_id) END AS waste_type_id,
      CASE WHEN r.entity_type = 'waste_pickup'
        THEN (SELECT date_key FROM waste_reminder_entries WHERE id = r.entity_id) END AS waste_date_key,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT amount FROM budget_subscriptions WHERE id = r.entity_id) END AS sub_amount,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT currency FROM budget_subscriptions WHERE id = r.entity_id) END AS sub_currency,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT next_payment_date FROM budget_subscriptions WHERE id = r.entity_id)
        END AS sub_next_payment_date
    FROM reminders r
    WHERE r.dismissed = 0 AND r.pushed_at IS NULL AND r.remind_at <= ?
    ORDER BY r.remind_at ASC
  `).all(nowIso);

  const counters = { due: due.length, attempted: 0, sent: 0, failed: 0, skipped: 0 };
  const markPushed = activeDb.prepare('UPDATE reminders SET pushed_at = ? WHERE id = ?');
  // Einmal je Lauf, nicht je Meldung: die Datensprache gehoert dem Haushalt.
  const locale = resolveHouseholdLocale(activeDb);

  for (const reminder of due) {
    const payload = reminderPayload(reminder, locale);
    const channels = store.listEnabledChannelsForUser(reminder.created_by);
    const pushCount = activeDb.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(reminder.created_by).c;
    const targets = [];
    if (pushCount > 0) {
      targets.push({ provider: 'webpush', channelId: null, targetKey: `user:${reminder.created_by}`, send: 'webpush' });
    }
    for (const channel of channels) {
      targets.push({
        provider: channel.provider,
        channelId: channel.id,
        targetKey: `channel:${channel.id}`,
        channel,
        send: 'provider',
      });
    }

    for (const target of targets) {
      const delivery = upsertPendingDelivery(activeDb, {
        reminderId: reminder.id,
        provider: target.provider,
        channelId: target.channelId,
        targetKey: target.targetKey,
        nowIso,
      });
      if (!shouldAttempt(delivery, nowIso)) continue;

      counters.attempted += 1;
      try {
        if (target.send === 'webpush') {
          const sent = await pushService.sendPushToUser(reminder.created_by, payload);
          if (sent > 0) {
            markSent(activeDb, delivery.id, nowIso);
            counters.sent += 1;
          } else {
            markSkipped(activeDb, delivery.id, nowIso, 'No active Web Push subscriptions accepted the notification.');
            counters.skipped += 1;
          }
        } else {
          const provider = providers[target.provider];
          if (!provider) throw new Error('Unknown notification provider.');
          await withTimeout((signal) => provider.send({ channel: target.channel, payload, fetchImpl, signal }));
          markSent(activeDb, delivery.id, nowIso);
          counters.sent += 1;
        }
      } catch (err) {
        const status = markFailed(activeDb, delivery.id, now, err);
        if (status === 'skipped') counters.skipped += 1;
        else counters.failed += 1;
        log.error(`Notification delivery failed for reminder ${reminder.id}:`, safeError(err));
      }
    }

    if (allKnownDeliveriesComplete(activeDb, reminder.id, targets)) {
      markPushed.run(nowIso, reminder.id);
    }
  }

  if (counters.sent) log.info(`Sent ${counters.sent} notification target(s).`);
  return counters;
}

export const notificationService = createNotificationService();
