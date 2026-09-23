/**
 * Modul: Meldungen rund um einen laufenden Restore (#1431)
 * Zweck: EIN Text fuer „ein Restore laeuft schon" - `restoreFromFile()` in
 *        server/db.js und `restoreWriteGate` (server/middleware) antworten
 *        damit gleich, und keiner zieht dafuer das andere Modul nach.
 */

export const RESTORE_IN_PROGRESS_REASON = 'restore_in_progress';

export const RESTORE_IN_PROGRESS_MESSAGE =
  'Another restore is already running on this instance. Wait until it has finished, then check '
  + 'which backup is in place before restoring again. This request changed nothing.';

export const RESTORE_WRITE_REFUSED_MESSAGE =
  'A backup is being restored right now. This change was not saved - try again in a minute.';

/**
 * Fehler fuer alles, was waehrend eines Restores nicht geschrieben werden kann
 * (Sitzung, OAuth-Zustand). Der globale Fehlerbehandler in server/index.js
 * macht daraus 503 mit demselben `reason`, den der Client uebersetzt.
 */
export function restoreInProgressError() {
  const err = new Error(RESTORE_WRITE_REFUSED_MESSAGE);
  err.reason = RESTORE_IN_PROGRESS_REASON;
  err.status = 503;
  return err;
}
