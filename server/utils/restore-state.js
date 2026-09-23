/**
 * Modul: Zustand eines laufenden Restores, geteilt ohne Datenbank-Import (#1431)
 * Zweck: Laeuft ein Restore? Und welche Jobs, die nach aussen schreiben,
 *        laufen gerade? server/db.js setzt den Zustand; Sync-Sperre,
 *        Scheduler und Middleware lesen ihn, ohne server/db.js zu laden (das
 *        oeffnet beim Import die Datenbank).
 *
 * Jobs, die nach aussen schreiben (Kalender- und Kontakte-Sync, Push,
 * WebDAV-Backup), lesen, warten auf den Anbieter und schreiben dann das
 * Ergebnis zurueck (Link, Tombstone, Zeitstempel). Liefe so ein Job in den
 * Restore hinein, schriebe er auf eine gesperrte oder geschlossene Verbindung,
 * und der entfernte Stand bliebe ohne Link oder doppelt (Codex-Befund in
 * #1431). Deshalb: waehrend eines Restores startet keiner, und die schon
 * laufenden wartet der Restore ab, bevor er die Verbindung sperrt.
 */

let running = false;

/** @type {Set<Promise<unknown>>} */
const activeJobs = new Set();

/** Was ein Job liefert, der wegen eines Restores gar nicht erst begonnen hat. */
export const SKIPPED_FOR_RESTORE = Object.freeze({ success: false, skipped: 'restore_in_progress' });

export function isRestoreRunning() {
  return running;
}

/** Nur fuer server/db.js. */
export function setRestoreRunning(value) {
  running = Boolean(value);
}

/**
 * Einen Job starten, der nach aussen schreibt - oder, waehrend eines
 * Restores, nicht starten.
 * @template T
 * @param {() => Promise<T> | T} run
 * @returns {Promise<T | typeof SKIPPED_FOR_RESTORE>}
 */
export function runExternalJob(run) {
  if (running) return Promise.resolve(SKIPPED_FOR_RESTORE);
  const started = (async () => run())();
  const tracked = started.finally(() => activeJobs.delete(tracked));
  // Der Restore wartet nur ab; einen Fehler meldet der Aufrufer des Jobs.
  tracked.catch(() => {});
  activeJobs.add(tracked);
  return tracked;
}

export function hasActiveExternalJobs() {
  return activeJobs.size > 0;
}

/** Alle laufenden Jobs abwarten, auch solche, die waehrenddessen noch begonnen haben. */
export async function waitForExternalJobs() {
  while (activeJobs.size > 0) {
    await Promise.allSettled([...activeJobs]);
  }
}
