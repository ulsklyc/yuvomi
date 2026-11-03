/**
 * Modul: Erinnerungen an ein geloeschtes erstes Vorkommen (#2470)
 * Zweck: Die eine Pruefung fuer `GET /reminders/pending`, `GET /reminders/upcoming`
 *        und die Zustellung (notifications.js#processDueNotifications), ob eine
 *        Termin-Erinnerung zu einem Vorkommen gehoert, das es nicht mehr gibt.
 * Abhaengigkeiten: calendar-events.js (Expansion, Ausnahmen), utils/timezone.js,
 *        utils/reminder-schedule.js
 *
 * WARUM ES DIESE PRUEFUNG BRAUCHT. Eine Erinnerung an einer Serie haengt am
 * Master und rechnet von seinem Beginn (#2468, SPEC: "inherited reminders use
 * the master anchor") - sie gehoert also zum ERSTEN Vorkommen. Wird genau
 * dieses geloescht, bleibt der Master stehen, und es entsteht nur eine Zeile in
 * `calendar_event_exceptions`. Der Trigger, der die Erinnerungen eines
 * geloeschten Termins abraeumt, greift nicht, und kein Leseweg fragte nach der
 * Ausnahme: der Termin meldete sich weiter.
 *
 * ALLE LOESCHWEGE LANDEN IN DERSELBEN TABELLE: das lokale Loeschen
 * (`deleteOccurrence`, `POST /:id/exceptions`), die EXDATE eines ICS-, CalDAV-
 * oder Apple-Imports (imported-occurrence-key.js) und Google
 * (google-calendar.js). Deshalb steht die Pruefung am Lesen und nicht an einem
 * dieser Schreiber - und sie fragt die Ausnahme so, wie die Expansion sie
 * fragt (`exceptionsInclude`, beide Schluesselformen von #2034), statt eine
 * zweite Lesart zu bauen.
 *
 * DAS ERSTE VORKOMMEN IST DAS ERSTE DER REGEL, NICHT DTSTART (#960): ein Beginn
 * am 15. mit "am Monatsletzten" hat sein erstes Vorkommen am 31. Darum fragt
 * die Pruefung die Expansion nach ihm, statt den Schluessel aus dem Beginn zu
 * bilden.
 *
 * VERSCHOBEN IST NICHT GELOESCHT. Ein "nur dieses" bearbeitetes Vorkommen
 * traegt ebenfalls eine Ausnahme, dazu ein verknuepftes Einzelvorkommen an
 * ihrem Schluessel. Es findet statt und erbt die Erinnerungen des Masters -
 * die Zeile bleibt.
 *
 * NUR, WAS NICHT NACH DEM BEGINN DES ERSTEN VORKOMMENS LIEGT. Eine Zeile am
 * Master kann zu einem spaeteren Vorkommen gehoeren: eine fremde Serie rechnet
 * eine neu gesetzte Erinnerung vom geoeffneten Vorkommen (#2468). Liegt sie
 * nach dem Beginn des ersten, wird sie hier nicht beurteilt. Der Preis: eine
 * Erinnerung, die NACH dem Beginn ihres ersten Vorkommens liegt (#1260, der
 * Termin wurde hinter sie geschoben), meldet sich nach dessen Loeschen weiter,
 * wie vorher. Lieber eine Meldung zu viel als eine gewollte still verschluckt.
 *
 * UEBERSPRUNGEN, NICHT GELOESCHT - derselbe Grund wie bei Sichtbarkeit und
 * Modulschalter (reminder-targets.js, reminder-origins.js): ein Leseweg
 * schreibt nicht, und das Vorkommen kann zurueckkommen (Ausnahme
 * zurueckgenommen, Serie zurueckgesetzt). Eine Zeile, die die Zustellung
 * ueberspringt, behaelt `pushed_at = NULL` und kostet je Lauf eine Abfrage.
 *
 * SYNCHRON, wie alles zwischen Lesen und Urteil in der Zustellung: kein Yield-
 * Punkt, an dem eine Ausnahme dazwischenkommt.
 */
import { createLogger } from '../logger.js';
import {
  exceptionsInclude, expandRecurringEvents, loadEventExceptions, occurrenceSlotOf, seriesReadingZone,
} from './calendar-events.js';
import { householdTimeZone, storedToInstantMsPrecise } from '../utils/timezone.js';
import { remindAtCompareKey, remindAtUtcSql } from '../utils/reminder-schedule.js';

const log = createLogger('Reminders');

/**
 * Das geloeschte erste Vorkommen eines Termins als Zeitpunkt seines Beginns
 * (Schluessel wie `remindAtCompareKey`), oder null, wenn der Termin keine Serie
 * ist oder sein erstes Vorkommen stattfindet.
 */
function deletedFirstOccurrenceStart(database, eventId) {
  const master = database.prepare(`
    SELECT * FROM calendar_events WHERE id = ? AND recurrence_rule IS NOT NULL AND recurrence_rule != ''
  `).get(eventId);
  if (!master) return null;
  const exceptions = loadEventExceptions(database, [master.id]).get(master.id);
  if (!exceptions?.size) return null;

  // Ohne Ausnahmen ausgerollt, damit das erste Vorkommen der Regel herauskommt
  // und nicht das erste, das noch steht.
  const [first] = expandRecurringEvents([master], '0001-01-01', '9999-12-31', null, {
    maxOccurrencesPerSeries: 1,
    householdZone: seriesReadingZone(database, master),
  });
  const slot = occurrenceSlotOf(first);
  if (!slot || !exceptionsInclude(exceptions, slot.key, slot.legacyKey)) return null;

  const moved = database.prepare(`
    SELECT 1 FROM calendar_events WHERE recurrence_parent_id = ? AND recurrence_id IN (?, ?)
  `).get(master.id, slot.key, slot.legacyKey);
  if (moved) return null;

  // Ein reines Datum zaehlt als 09:00 Ortszeit, derselbe Anker wie beim
  // Rechnen der Vorlaeufe (reminderAnchorInstantMs in
  // calendar-occurrence-overrides.js).
  const start = String(first.start_datetime);
  const ms = storedToInstantMsPrecise(start.includes('T') ? start : `${start}T09:00:00`, householdTimeZone(database));
  return ms === null ? null : remindAtCompareKey(ms);
}

/**
 * Die Zeilen ohne die Termin-Erinnerungen, deren erstes Vorkommen geloescht ist.
 * `rows` braucht `entity_type`, `entity_id` und `remind_at`.
 *
 * Schlaegt die Pruefung fuer einen Termin fehl, bleiben seine Zeilen drin und
 * der Fehler steht im Log: das ist der Stand vor dieser Pruefung, und eine
 * kaputte Serie soll nicht die ganze Glocke oder den Zustelllauf mitnehmen.
 */
export function withoutDeletedFirstOccurrence(database, rows) {
  const deletedStart = new Map();
  let remindAtKey = null;
  return rows.filter((row) => {
    if (row.entity_type !== 'event') return true;
    const id = Number(row.entity_id);
    if (!deletedStart.has(id)) {
      try {
        deletedStart.set(id, deletedFirstOccurrenceStart(database, id));
      } catch (err) {
        log.error(`Checking the first occurrence of event ${id} failed:`, err?.message || err);
        deletedStart.set(id, null);
      }
    }
    const start = deletedStart.get(id);
    if (start === null) return true;
    // `remind_at` in derselben Lesart wie Fenster und Faelligkeit (#1364): eine
    // alte Zeile mit Offset liegt sonst an der falschen Seite des Beginns.
    remindAtKey ??= database.prepare(`SELECT ${remindAtUtcSql('@value')} AS key`);
    const key = remindAtKey.get({ value: row.remind_at })?.key;
    return !key || key > start;
  });
}
