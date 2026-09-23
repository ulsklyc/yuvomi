/**
 * Modul: Schreibsperre waehrend eines Restores (#1431)
 * Zweck: Solange `restoreFromFile()` laeuft, beantwortet der Server jeden
 *        schreibenden Request mit 503 und `reason: 'restore_in_progress'` -
 *        einen zweiten Restore mit 409, bevor sein Upload gelesen wird.
 *
 * Der Restore kopiert das Backup, waehrend die bisherige Verbindung noch offen
 * ist. Ein Schreibzugriff in dieser Zeit meldete Erfolg, den das Schliessen
 * und der Tausch danach verwarfen (Codex-Befund in #1431). Die eigentliche
 * Sperre sitzt in server/db.js (`query_only` auf der Verbindung, faengt auch
 * Hintergrundjobs); diese Middleware sorgt dafuer, dass ein Request eine
 * verstaendliche Antwort bekommt statt eines Datenbankfehlers.
 *
 * Der zweite Restore wird HIER beantwortet und nicht erst in der Route: dort
 * kaeme er erst nach Sitzung (deren Verbindung in der Tauschphase fehlt - 500
 * statt 409) und nach `express.raw()`, das das ganze Backup hochlaedt, nur um
 * es abzulehnen (Codex-Befund in #1431). Deshalb haengt die Middleware in
 * server/index.js vor Body-Parsern und Sitzung.
 *
 * Frei von Seiteneffekten: der Zustand kommt als Funktion herein, damit der
 * Test das Modul ohne Datenbank laden kann.
 */

import { RESTORE_IN_PROGRESS_MESSAGE, RESTORE_IN_PROGRESS_REASON } from '../utils/restore-messages.js';

const READING_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const RESTORE_PATH = '/api/v1/backup/restore';

/**
 * @param {() => boolean} isRestoreRunning
 * @returns {import('express').RequestHandler}
 */
export function createRestoreWriteGate(isRestoreRunning) {
  return function restoreWriteGate(req, res, next) {
    if (READING_METHODS.has(req.method) || !isRestoreRunning()) return next();
    res.setHeader('Retry-After', '30');
    // Die Verbindung schliessen: der Rest des Uploads soll nicht mehr kommen.
    res.setHeader('Connection', 'close');
    const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
    if (pathOnly === RESTORE_PATH) {
      return res.status(409).json({ error: RESTORE_IN_PROGRESS_MESSAGE, code: 409, reason: RESTORE_IN_PROGRESS_REASON });
    }
    return res.status(503).json({
      error: 'A backup is being restored right now. This change was not saved - try again in a minute.',
      code: 503,
      reason: RESTORE_IN_PROGRESS_REASON,
    });
  };
}
