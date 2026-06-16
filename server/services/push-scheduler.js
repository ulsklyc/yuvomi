/**
 * Modul: Push-Scheduler
 * Zweck: Fällige, ungepushte Reminder finden und als Web Push zustellen.
 * Abhängigkeiten: server/db.js, server/services/push.js, server/services/birthdays.js
 */
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { pushService as defaultPushService } from './push.js';
import { syncAllBirthdayReminders } from './birthdays.js';

const log = createLogger('PushScheduler');
const APP_NAME = 'Yuvomi';

export async function processDuePushes({ database, pushService = defaultPushService } = {}) {
  const getDb = () => (database || db.get());
  const now = new Date().toISOString();

  // Geburtstags-Reminder für alle User materialisieren (best effort).
  const users = getDb().prepare('SELECT id FROM users').all();
  for (const u of users) {
    try {
      syncAllBirthdayReminders(getDb(), u.id, new Date());
    } catch (err) {
      log.error(`Birthday sync failed for user ${u.id}:`, err?.message || err);
    }
  }

  const due = getDb().prepare(`
    SELECT r.id, r.created_by,
      CASE r.entity_type
        WHEN 'task'  THEN (SELECT title FROM tasks           WHERE id = r.entity_id)
        WHEN 'event' THEN (SELECT title FROM calendar_events WHERE id = r.entity_id)
      END AS entity_title
    FROM reminders r
    WHERE r.dismissed = 0 AND r.pushed_at IS NULL AND r.remind_at <= ?
    ORDER BY r.remind_at ASC
  `).all(now);

  const markPushed = getDb().prepare('UPDATE reminders SET pushed_at = ? WHERE id = ?');
  let pushed = 0;
  for (const r of due) {
    try {
      await pushService.sendPushToUser(r.created_by, {
        title: APP_NAME,
        body: r.entity_title || APP_NAME,
        url: '/reminders',
        tag: `reminder-${r.id}`,
      });
      pushed += 1;
    } catch (err) {
      log.error(`Push failed for reminder ${r.id}:`, err?.message || err);
    }
    markPushed.run(now, r.id);
  }
  if (pushed) log.info(`Pushed ${pushed} reminder(s).`);
  return { pushed, due: due.length };
}

export function startScheduler() {
  const run = () => {
    processDuePushes().catch((err) => log.error('Push scheduler run failed:', err?.message || err));
  };
  setTimeout(run, 10_000).unref();
  setInterval(run, 60_000).unref();
  log.info('Push scheduler active (every 60s).');
}
