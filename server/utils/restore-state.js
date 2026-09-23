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
const TRACKED = Symbol('yuvomi.restore.trackedWrite');

export function trackWriteRequest(res) {
  if (res[TRACKED]) return;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const tracked = finished.finally(() => activeWriteRequests.delete(tracked));
  activeWriteRequests.add(tracked);
  res[TRACKED] = done;
  res.once('finish', done);
  res.once('close', done);
}

/**
 * Eine Anfrage wieder freigeben, bevor sie endet. Die Restore-Route ruft das
 * fuer sich selbst - der Restore wartete sonst auf seine eigene Anfrage. An
 * der Route statt ueber einen Pfadvergleich: `/restore/` oder eine andere
 * Schreibweise, die Express genauso annimmt, entgeht so nicht (Review #1431).
 * @param {import('node:http').ServerResponse} res
 */
export function untrackWriteRequest(res) {
  res[TRACKED]?.();
}

export function hasActiveWriteRequests() {
  return activeWriteRequests.size > 0;
}

/** Was gerade noch schreibt: laufende Jobs und zugelassene Anfragen. */
export function activeWriters() {
  return [...activeJobs, ...activeWriteRequests];
}

/**
 * Wie lange ein Restore hoechstens auf laufende Jobs, Backups und Anfragen
 * wartet, bevor er aufgibt (Review #1431). Ein haengender Anbieter oder ein
 * Upload, der nie endet, haelt ihn so nicht ewig auf; er bricht dann ab, bevor
 * er irgendetwas aendert.
 */
export const RESTORE_WAIT_TIMEOUT_MS = 60_000;
let waitTimeoutMs = RESTORE_WAIT_TIMEOUT_MS;

export function restoreWaitTimeoutMs() {
  return waitTimeoutMs;
}

/** NUR FUER TESTS: die Frist kuerzer stellen; ohne Argument zurueck auf den Standard. */
export function setRestoreWaitTimeoutForTests(ms = RESTORE_WAIT_TIMEOUT_MS) {
  waitTimeoutMs = ms;
}

/**
 * Warten, bis `pending()` leer ist - hoechstens bis `deadline`.
 * @param {() => Promise<unknown>[]} pending
 * @param {number} deadline  Zeitpunkt in ms
 * @returns {Promise<boolean>} `true`, wenn alles fertig ist; `false` bei Fristablauf
 */
export async function waitUntilIdle(pending, deadline) {
  for (let open = pending(); open.length > 0; open = pending()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(true), remaining); });
    timer.unref?.();
    const timedOut = await Promise.race([Promise.allSettled(open).then(() => false), expired]);
    clearTimeout(timer);
    if (timedOut) return false;
  }
  return true;
}
