/**
 * Modul: das CalDAV-Konto nach einem await noch einmal ansehen (#2947)
 * Zweck: Kalender, Erinnerungslisten und das Aendern der Zugangsdaten fragen
 *        den Server (await) mit der Zeile, die sie davor gelesen haben. Danach
 *        gilt nur, was die Zeile JETZT sagt: geloescht heisst dieselbe 404 wie
 *        vor der Abfrage, ein anderer Server oder andere Zugangsdaten heissen,
 *        dass die Antwort zu einem Konto gehoert, das es so nicht mehr gibt.
 *        Geteilt von server/services/caldav-sync.js und
 *        server/services/caldav-reminders-sync.js.
 */

/**
 * Das Konto verschwand, waehrend der Server gefragt wurde. Die Routen
 * antworten darauf wie auf ein unbekanntes Konto vor der Abfrage
 * (`refuseGoneAccount` in server/routes/calendar/caldav.js).
 * @param {number} accountId
 * @returns {Error & { code: 'caldav_account_gone' }}
 */
export function accountGoneError(accountId) {
  const err = /** @type {Error & { code: 'caldav_account_gone' }} */ (new Error(`Account ${accountId} not found.`));
  err.code = 'caldav_account_gone';
  return err;
}

/**
 * Zeigt die Zeile noch auf denselben Server mit denselben Zugangsdaten?
 * @param {{ caldav_url: string, username: string, password: string }} current
 * @param {{ caldav_url: string, username: string, password: string }} read
 */
export function sameConnection(current, read) {
  return current.caldav_url === read.caldav_url && current.username === read.username
    && current.password === read.password;
}
