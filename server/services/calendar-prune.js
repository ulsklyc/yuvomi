// --------------------------------------------------------
// Inbound-Löschungen für synchronisierte Kalender (#508).
//
// Termine, die ein Server nicht mehr ausliefert, müssen lokal verschwinden. Ohne
// diesen Schritt bleiben in iCloud/Nextcloud gelöschte Termine für immer stehen,
// weil die Inbound-Syncs sonst nur upserten.
//
// Geteilt von caldav-sync.js und apple-calendar.js. Google braucht das nicht: dort
// meldet der Sync-Token-Delta Löschungen aktiv als `status: 'cancelled'`. ICS auch
// nicht: dort ist der Feed ein einzelner atomarer Request.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
const log = createLogger('CalendarPrune');

/**
 * Entfernt lokal die Termine eines externen Kalenders, die der Server nicht mehr
 * ausliefert.
 *
 * Der Scope ist strikt `calendar_ref_id` + `source`: lokale Termine und noch nicht
 * hochgeladene Outbound-Termine (`external_source = 'local'`) bleiben unangetastet.
 *
 * `calendarUids` sind die UIDs, die genau dieser Kalender geliefert hat, und dienen
 * nur dem Leer-Guard. Verglichen wird gegen `accountUids` (alle UIDs des Accounts),
 * damit ein zwischen zwei Kalendern verschobener Termin nicht gelöscht und unter
 * neuer ID wieder angelegt wird — das würde seine Zuweisungen verlieren.
 *
 * Leer-Guard: Liefert ein Kalender keine einzige UID, obwohl lokal Termine an ihm
 * hängen, wird nicht gelöscht. Ein leeres Fetch-Ergebnis ist weit häufiger ein
 * stiller Server- oder Auth-Fehler als ein tatsächlich geleerter Kalender, und der
 * Preis für die falsche Annahme wäre der Totalverlust des Kalenders.
 *
 * @param {object} database          Datenbank-Handle
 * @param {object} opts
 * @param {number} opts.calRefId     external_calendars.id des Kalenders
 * @param {Set}    opts.calendarUids UIDs, die dieser Kalender geliefert hat
 * @param {Set}    [opts.accountUids] Alle UIDs des Accounts (default: calendarUids)
 * @param {string} [opts.source]     external_source-Wert ('caldav' | 'apple')
 * @param {string} [opts.calendarName] Nur für die Log-Ausgabe
 * @returns {number} Anzahl gelöschter Termine.
 */
export function pruneDeletedEvents(database, {
  calRefId,
  calendarUids,
  accountUids = calendarUids,
  source = 'caldav',
  calendarName = null,
} = {}) {
  const localEvents = database.prepare(`
    SELECT id, external_calendar_id FROM calendar_events
    WHERE calendar_ref_id = ? AND external_source = ?
  `).all(calRefId, source);

  const stale = localEvents.filter(ev => !accountUids.has(ev.external_calendar_id));
  if (stale.length === 0) return 0;

  if (calendarUids.size === 0) {
    const label = calendarName ? `"${calendarName}"` : `ref ${calRefId}`;
    log.warn(
      `Calendar ${label}: server returned no events, but ${stale.length} exist locally. ` +
      `Skipping deletion — assuming a fetch error rather than an emptied calendar.`
    );
    return 0;
  }

  const del = database.prepare('DELETE FROM calendar_events WHERE id = ?');
  for (const ev of stale) del.run(ev.id);

  return stale.length;
}
