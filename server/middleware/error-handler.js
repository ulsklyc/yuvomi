/**
 * Modul: Globaler Fehlerbehandler der App
 * Zweck: Letzte Station jedes Fehlers. Aus server/index.js herausgezogen, damit
 *        der Test ihn als Programm faehrt (#1431).
 *
 * Waehrend eines Restores (#1431) kommt hier etwa eine Sitzung an, die nicht
 * gespeichert werden kann (`reason: 'restore_in_progress'`): daraus wird 503
 * mit demselben Grund, den der Client uebersetzt.
 *
 * Ist die Antwort schon unterwegs - express-session meldet einen Fehler erst
 * nach dem Schreiben -, gehoert der Fehler an Express: dessen Standard-
 * Behandler beendet die Verbindung. Ein blosses `return` liesse die halbe
 * Antwort offen stehen, bis der Client aufgibt (Review #1431).
 */

/**
 * @param {{ warn: Function, error: Function }} log
 * @returns {import('express').ErrorRequestHandler}
 */
export function createErrorHandler(log) {
  return function errorHandler(err, req, res, next) {
    if (err?.reason === 'restore_in_progress') {
      log.warn(`Request refused during a restore: ${req.method} ${req.path}`);
      if (res.headersSent) return next(err);
      res.setHeader('Retry-After', '30');
      return res.status(503).json({ error: err.message, code: 503, reason: err.reason });
    }
    log.error('Unhandled error:', err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: 'Internal server error.', code: 500 });
  };
}
