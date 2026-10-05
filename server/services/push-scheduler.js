/**
 * Modul: Push-Scheduler
 * Zweck: Kompatibilitaets-Scheduler fuer faellige Reminder-Notifications.
 * Abhängigkeiten: server/services/notifications.js
 */
import { runExternalJob } from '../utils/restore-state.js';
import { createLogger } from '../logger.js';
import { processDueNotifications } from './notifications.js';

const log = createLogger('PushScheduler');

export async function processDuePushes(options = {}) {
  const result = await processDueNotifications(options);
  return { ...result, pushed: result.sent + result.skipped };
}

export function startScheduler() {
  // Versendet nach aussen und vermerkt es danach: waehrend eines Restores
  // beginnt kein Lauf, ein laufender wird abgewartet (Codex-Befund in #1431).
  const run = () => {
    runExternalJob(() => processDuePushes())
      .catch((err) => log.error('Push scheduler run failed:', err?.message || err));
  };
  setTimeout(run, 10_000).unref();
  setInterval(run, 60_000).unref();
  log.info('Push scheduler active (every 60s).');
}
