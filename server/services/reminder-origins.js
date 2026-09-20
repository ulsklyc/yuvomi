/**
 * Modul: Herkunft einer Erinnerung (entity_type -> Modul)
 * Zweck: EINE Karte fuer die Frage, zu welchem Modul eine `reminders`-Zeile
 *        gehoert. Gelesen von GET /reminders/pending (server/routes/reminders.js:
 *        Token-Scopes, Mitgliedsrechte, Haushaltsschalter) und von der Zustellung
 *        (server/services/notifications.js#processDueNotifications:
 *        Haushaltsschalter). Bis #1279 stand die Karte nur im Router, und die
 *        Zustellung fragte gar nicht nach dem Modul.
 * Abhaengigkeiten: server/services/household-modules.js
 */
import { householdDisabledModules } from './household-modules.js';

/* EINE KARTE UEBER ALLE HERKUENFTE, OHNE AUSNAHME FUER DIE NEUESTE.
 *
 * `/api/v1/reminders` loest ueber `moduleForPath()` auf `calendar` auf, die
 * Zeilen stammen aber aus vielen Modulen (siehe den Kommentar ueber
 * `mayTouchOrigin()` in server/routes/reminders.js). Was hier fehlt, liefert
 * der Router nicht aus: `mayTouchOrigin()` lehnt eine unbekannte Herkunft ab.
 * Eine neue Herkunft, die nur in VALID_ENTITY_TYPES und der CHECK-Liste der
 * Migration landet, verschwaende also still aus `/pending` - dagegen haelt
 * test/test-disabled-module-reminders.js jeden Wert beider Listen an diese
 * Karte. */
export const ORIGIN_MODULE = Object.freeze({
  task:                   'tasks',
  event:                  'calendar',
  subscription:           'budget',
  inventory_item:         'inventory',
  inventory_tracked_date: 'inventory',
  pantry_item:            'pantry',
  cycle_period:           'health',
  cycle_log_nudge:        'health',
  health_prevention_due:  'health',
  schedule_entry:         'schedule',
  schedule_extra_entry:   'schedule',
  waste_pickup:           'waste',
  document_expiry:        'documents',
});

/**
 * Gehoert dieser Termin einem Geburtstag? Geburtstage schreiben ihre
 * Erinnerungen als `event` an den Kalendertermin, den sie selbst anlegen
 * (services/birthdays.js#syncBirthdayReminder), die Karte oben sieht darin
 * also Kalender. Fuer den Haushaltsschalter sind es aber zwei Module.
 */
function isBirthdayEvent(database, eventId) {
  return Boolean(database.prepare(`
    SELECT 1 FROM birthdays WHERE calendar_event_id = ? OR name_day_calendar_event_id = ? LIMIT 1
  `).get(eventId, eventId));
}

/**
 * Die Zeilen ohne die, deren Modul im Haushalt abgeschaltet ist (#1279).
 *
 * UEBERSPRINGEN, NICHT LOESCHEN. Eine Aufgaben- oder Termin-Erinnerung hat
 * jemand von Hand gesetzt; Abo-, Inventar- und Dokument-Erinnerungen entstehen
 * nur beim SCHREIBEN ihres Datensatzes. Keine davon legt ein Lauf wieder an -
 * geloescht kaeme sie nach dem Wiedereinschalten nie zurueck. Die Zeile bleibt
 * deshalb ausstehend und wird nach dem Wiedereinschalten zugestellt wie nach
 * einem Serverausfall (die Zustellung kennt keine Altersgrenze). Quellen, die
 * ein Lauf periodisch neu herstellt (Vorrat, Schichtplan, Muell, Zyklus,
 * Geburtstage), raeumen ihre Zeilen zusaetzlich selbst ab; fuer sie ist dieser
 * Filter nur der Riegel zwischen zwei Laeufen.
 *
 * GEBURTSTAGE SIND DIE EINE AUSNAHME VON DER KARTE: ihre `event`-Zeilen folgen
 * dem Schalter `birthdays`, nicht `calendar`. Ohne diese Unterscheidung naehme
 * ein abgeschalteter Kalender einem Haushalt mit eingeschalteten Geburtstagen
 * deren Meldungen weg. Nachgeschlagen wird nur, wenn einer der beiden Schalter
 * ueberhaupt steht.
 *
 * Synchron, ohne `await`: die Aufrufer lesen die Zeilen unmittelbar davor.
 *
 * @param {object} database
 * @param {Array<{entity_type: string, entity_id: number}>} rows
 * @returns {Array} dieselben Zeilenobjekte, gefiltert
 */
export function withoutSwitchedOffModules(database, rows) {
  const off = householdDisabledModules(database);
  if (!off.size) return rows;
  const eventsNeedLookup = off.has('calendar') || off.has('birthdays');
  return rows.filter((row) => {
    if (row.entity_type === 'event' && eventsNeedLookup) {
      return !off.has(isBirthdayEvent(database, row.entity_id) ? 'birthdays' : 'calendar');
    }
    return !off.has(ORIGIN_MODULE[row.entity_type]);
  });
}
