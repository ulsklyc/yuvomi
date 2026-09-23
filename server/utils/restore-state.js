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

/**
 * Schreibende Anfragen, die das Gate VOR dem Restore zugelassen hat und die
 * noch laufen (Codex-Befund in #1431). Ein Upload etwa wartet erst auf das
 * Ablegen der Datei und schreibt dann - ohne dieses Warten liefe er ueber den
 * Tausch und schriebe in die gerade eingespielte Datenbank. Der Restore wartet
 * sie ab, bevor er die Verbindung sperrt; sie landen damit bewusst in der
 * alten Datenbank und so im Rollback-Stand.
 * @type {Set<Promise<void>>}
 */
const activeWriteRequests = new Set();

/**
 * Eine zugelassene schreibende Anfrage bis zu ihrem Ende festhalten.
 * @param {import('node:http').ServerResponse} res
 */
export function trackWriteRequest(res) {
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const tracked = finished.finally(() => activeWriteRequests.delete(tracked));
  activeWriteRequests.add(tracked);
  res.once('finish', done);
  res.once('close', done);
}

export function hasActiveWriteRequests() {
  return activeWriteRequests.size > 0;
}

/**
 * Laufende Jobs UND zugelassene schreibende Anfragen abwarten. Ohne Zeitgrenze
 * - ein haengender Anbieter oder ein Upload, der nie endet, haelt den Restore
 * auf (Folge-Ticket).
 */
export async function waitForWritersToFinish() {
  while (activeJobs.size > 0 || activeWriteRequests.size > 0) {
    await Promise.allSettled([...activeJobs, ...activeWriteRequests]);
  }
}
