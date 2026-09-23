/**
 * Modul: Schreibsperre waehrend eines Restores (#1431)
 * Zweck: Solange `restoreFromFile()` laeuft, beantwortet der Server jeden
 *        schreibenden Request mit 503 und `reason: 'restore_in_progress'`.
 *
 * Der Restore kopiert das Backup, waehrend die bisherige Verbindung noch offen
 * ist. Ein Schreibzugriff in dieser Zeit meldete Erfolg, den das Schliessen
 * und der Tausch danach verwarfen (Codex-Befund in #1431). Die eigentliche
 * Sperre sitzt in server/db.js (`query_only` auf der Verbindung, faengt auch
 * Hintergrundjobs); diese Middleware sorgt dafuer, dass ein Request eine
 * verstaendliche Antwort bekommt statt eines Datenbankfehlers.
 *
 * Frei von Seiteneffekten: der Zustand kommt als Funktion herein, damit der
 * Test das Modul ohne Datenbank laden kann.
 */

const READING_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Der Restore-Endpunkt selbst antwortet auf einen zweiten Restore mit 409. */
const EXEMPT_PATHS = new Set(['/api/v1/backup/restore']);

/**
 * @param {() => boolean} isRestoreRunning
 * @returns {import('express').RequestHandler}
 */
export function createRestoreWriteGate(isRestoreRunning) {
  return function restoreWriteGate(req, res, next) {
    if (READING_METHODS.has(req.method) || !isRestoreRunning()) return next();
    const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
    if (EXEMPT_PATHS.has(pathOnly)) return next();
    res.setHeader('Retry-After', '30');
    return res.status(503).json({
      error: 'A backup is being restored right now. This change was not saved - try again in a minute.',
      code: 503,
      reason: 'restore_in_progress',
    });
  };
}
