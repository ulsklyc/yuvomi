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
import { syncAllBirthdayReminders } from './birthdays.js';

const log = createLogger('Notifications');
const APP_NAME = 'Yuvomi';
// Greift nur, wenn die verknuepfte Entitaet inzwischen geloescht wurde: nie den
// App-Namen als Body wiederholen, sonst besteht die Notification nur aus "Yuvomi" (#581).
const FALLBACK_BODY = 'Reminder';
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const PROVIDER_TIMEOUT_MS = 8_000;

export const defaultProviders = {
  gotify: gotifyProvider,
  ntfy: ntfyProvider,
  webhook: webhookProvider,
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

function reminderPayload(reminder) {
  const title = reminder.entity_title || FALLBACK_BODY;
  return {
    title: APP_NAME,
    body: reminder.entity_type === 'subscription' && reminder.entity_title
      ? subscriptionBody(reminder)
      : title,
    url: '/reminders',
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
  async function testChannel({ channel, payload, fetchImpl = fetch } = {}) {
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
  fetchImpl = fetch,
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

  const due = activeDb.prepare(`
    SELECT r.id, r.created_by, r.entity_type,
      CASE r.entity_type
        WHEN 'task'  THEN (SELECT title FROM tasks           WHERE id = r.entity_id)
        WHEN 'event' THEN (SELECT title FROM calendar_events WHERE id = r.entity_id)
        WHEN 'subscription' THEN (SELECT name FROM budget_subscriptions WHERE id = r.entity_id)
      END AS entity_title,
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

  for (const reminder of due) {
    const payload = reminderPayload(reminder);
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
