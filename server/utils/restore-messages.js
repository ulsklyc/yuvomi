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
