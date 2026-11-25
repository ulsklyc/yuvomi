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

/** @param {{ job?: () => Promise<unknown> }} [opts] - `job` is for tests. */
export function startScheduler({ job = () => processDuePushes() } = {}) {
  // Versendet nach aussen und vermerkt es danach: waehrend eines Restores
  // beginnt kein Lauf, ein laufender wird abgewartet (Codex-Befund in #1431).
  // Ein Lauf zur Zeit (#2942): dauert einer laenger als das Intervall (ein
  // langsamer Push-Dienst oder Kanal), laesst der naechste Tick ihn zu Ende
  // laufen, statt dieselben Zustellungen noch einmal anzufangen.
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runExternalJob(job)
      .catch((err) => log.error('Push scheduler run failed:', err?.message || err))
      .finally(() => { running = false; });
  };
  setTimeout(run, 10_000).unref();
  setInterval(run, 60_000).unref();
  log.info('Push scheduler active (every 60s).');
}
