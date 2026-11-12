/**
 * Modul: Erinnerungs-Kennzeichen fuer Listen
 * Zweck: Welche Termine und Aufgaben einer Liste tragen eine Erinnerung des
 *        Betrachters? Eine Abfrage fuer die ganze Liste.
 *
 * DIESELBEN ZEILEN WIE DIE LESEANSICHT. Die Glocken-Zeile im Termin und in der
 * Aufgabe liest `GET /reminders/all` bzw. `GET /reminders`: eigene Zeilen
 * (`created_by`), nicht verworfen. Die Liste fragt nach denselben Zeilen, damit
 * sie nichts verspricht, das der Termin beim Oeffnen nicht haelt.
 *
 * ERINNERUNGEN GEHOEREN EINER PERSON. Zwei Mitglieder sehen denselben Termin,
 * aber nur wer eine Erinnerung gesetzt hat (oder sie als Zugewiesener geerbt
 * hat, #921), sieht die Glocke. Das Kennzeichen sagt "du wirst erinnert",
 * nicht "jemand wird erinnert".
 *
 * Den Sichtbarkeitsfilter der Erinnerungs-Routen (reminderTargetVisibleSql)
 * braucht es hier nicht: gefragt wird nur nach Zeilen, die die Liste dem
 * Betrachter ohnehin zeigt.
 *
 * DIE GLOCKE HEISST "DAS MELDET SICH BEI DIR" (#2687). Deshalb steht sie an
 * einer Serie nur an dem Vorkommen, zu dem die Erinnerung gehoert, und nicht
 * an jedem (ownEventReminderMarks unten), und an einer erledigten oder
 * abgelegten Aufgabe gar nicht (routes/tasks.js#attachReminderFlags).
 */
import { createLogger } from '../logger.js';
import { expandRecurringEvents, occurrenceSlotOf, seriesReadingZone } from './calendar-events.js';
import { householdTimeZone, shiftDateKey, storedToInstantMsPrecise } from '../utils/timezone.js';
import { remindAtCompareKey, remindAtUtcSql } from '../utils/reminder-schedule.js';

const log = createLogger('Reminders');

/**
 * @typedef {{ prepare(sql: string): { all(...params: any[]): any[] } }} Connection
 *   die Verbindung (better-sqlite3 oder node:sqlite)
 */

/**
 * @param {Connection} database
 * @param {'event' | 'task'} entityType
 * @param {Iterable<number | string | null | undefined>} ids
 * @param {number | null | undefined} userId
 * @returns {Set<number>} die IDs aus `ids`, an denen eine eigene, nicht
 *   verworfene Erinnerung haengt
 */
export function ownReminderIds(database, entityType, ids, userId) {
  const wanted = [...new Set([...ids].map(Number).filter(Number.isInteger))];
  if (!database || !userId || wanted.length === 0) return new Set();
  // json_each statt einer Platzhalterliste: ein Monat mit Serien bringt
  // schnell einige hundert IDs, und die Zahl der Platzhalter ist begrenzt.
  const rows = database.prepare(`
    SELECT DISTINCT r.entity_id AS id
    FROM reminders r
    WHERE r.entity_type = ? AND r.created_by = ? AND r.dismissed = 0
      AND r.entity_id IN (SELECT value FROM json_each(?))
  `).all(entityType, userId, JSON.stringify(wanted));
  return new Set(rows.map((row) => Number(row.id)));
}

// Wie viele Vorkommen ab dem Tag vor einer Erinnerung angesehen werden, um das
// erste zu finden, das bei oder nach ihr beginnt. Das Fenster setzt einen Tag
// frueher ein, weil es in Serientagen zaehlt und die Erinnerung ein Zeitpunkt
// ist; bei einer taeglichen Serie liegen dann bis zu drei Vorkommen davor.
const OCCURRENCES_AROUND_REMINDER = 5;

/**
 * Der Beginn eines Vorkommens im Schluessel von `remindAtUtcSql()`. Ein reines
 * Datum zaehlt als 09:00 Ortszeit - derselbe Anker wie beim Rechnen der
 * Vorlaeufe und in reminder-deleted-occurrence.js.
 * @param {unknown} start
 * @param {string} zone
 * @returns {string | null}
 */
function startKey(start, zone) {
  const text = String(start);
  const ms = storedToInstantMsPrecise(text.includes('T') ? text : `${text}T09:00:00`, zone);
  return ms === null ? null : remindAtCompareKey(new Date(ms));
}

/**
 * Die Vorkommen einer Serie, zu denen diese Erinnerungen gehoeren, als
 * Schluessel (#2034, beide Formen).
 *
 * EINE ERINNERUNG AN EINER SERIE IST EINE ZEILE MIT EINEM ZEITPUNKT. Sie haengt
 * am Master, meldet sich einmal und gehoert damit zu EINEM Vorkommen: dem
 * ersten, das bei oder nach ihr beginnt. Fuer eine Zeile, die vom Beginn der
 * Serie rechnet (#2468), ist das das erste Vorkommen der Regel - dieselbe
 * Lesart wie in reminder-deleted-occurrence.js, das genau diese Zeilen nach
 * dem Loeschen des ersten Vorkommens ueberspringt. Fuer eine Zeile nach dem
 * Beginn des ersten Vorkommens (eine fremde Serie rechnet eine neu gesetzte
 * Erinnerung vom geoeffneten Vorkommen) ist es das Vorkommen, vor dem sie
 * liegt.
 *
 * OHNE AUSNAHMEN AUSGEROLLT, wie dort: gefragt ist der Platz in der Regel. Ist
 * er geloescht, steht kein Vorkommen in der Liste und damit keine Glocke; ist
 * er verschoben, traegt das verknuepfte Einzelvorkommen seinen Schluessel und
 * bekommt sie.
 *
 * @param {Connection} database
 * @param {Record<string, any>} master  Serienzeile aus `calendar_events`
 * @param {string[]} remindKeys  `remind_at` im Schluessel von `remindAtUtcSql()`
 * @returns {Set<string>}
 */
function notifyingSlots(database, master, remindKeys) {
  /** @type {Set<string>} */
  const slots = new Set();
  /** @param {object | undefined} occurrence */
  const add = (occurrence) => {
    const slot = occurrenceSlotOf(occurrence);
    if (slot) slots.add(slot.key).add(slot.legacyKey);
  };
  const zone = householdTimeZone(database);
  const householdZone = seriesReadingZone(database, master);
  /**
   * @param {string} from
   * @param {Record<string, unknown>} options
   * @returns {Record<string, any>[]}
   */
  const occurrencesFrom = (from, options) => expandRecurringEvents(
    [master], from, '9999-12-31', null, /** @type {any} */ ({ householdZone, ...options }),
  );
  const [first] = occurrencesFrom('0001-01-01', { maxOccurrencesPerSeries: 1 });
  if (!first) return slots;
  const firstKey = startKey(first.start_datetime, zone);
  for (const remindKey of remindKeys) {
    if (!firstKey || remindKey <= firstKey) {
      add(first);
      continue;
    }
    add(occurrencesFrom(shiftDateKey(remindKey.slice(0, 10), -1), {
      maxOccurrencesPerSeries: OCCURRENCES_AROUND_REMINDER, resumeAtWindow: true,
    }).find((occurrence) => (startKey(occurrence.start_datetime, zone) ?? '') >= remindKey));
  }
  return slots;
}

/**
 * An welchen Terminen einer Liste meldet sich eine Erinnerung des Betrachters?
 *
 * Ein einzelner Termin und ein Vorkommen mit eigenen Erinnerungen: sobald eine
 * Zeile an ihm haengt. Ein Vorkommen, das die Erinnerungen seiner Serie erbt:
 * nur, wenn eine davon zu ihm gehoert (notifyingSlots). Zwei Abfragen fuer die
 * ganze Liste, die zweite nur, wenn ueberhaupt eine Erinnerung an ihr haengt.
 *
 * Scheitert das Ausrollen einer Serie, bleibt sie ohne Glocke und der Fehler
 * steht im Log: eine kaputte Regel soll nicht die ganze Liste mitnehmen.
 *
 * @param {Connection} database
 * @param {Iterable<number | string | null | undefined>} ownerIds  Termine und
 *   Erinnerungs-Eigner der Liste (`reminder_owner_id`)
 * @param {number | null | undefined} userId
 * @returns {{ has(ownerId: number, recurrenceId?: string | null): boolean }}
 *   `recurrenceId` ist der Schluessel des Vorkommens (`recurrence_id` der Antwort)
 */
export function ownEventReminderMarks(database, ownerIds, userId) {
  const wanted = [...new Set([...ownerIds].map(Number).filter(Number.isInteger))];
  /** @type {Map<number, string[]>} */
  const remindKeysByOwner = new Map();
  /** @type {Map<number, Set<string>>} */
  const slotsBySeries = new Map();
  if (database && userId && wanted.length > 0) {
    const rows = database.prepare(`
      SELECT r.entity_id AS id, ${remindAtUtcSql('r.remind_at')} AS remind_key
      FROM reminders r
      WHERE r.entity_type = 'event' AND r.created_by = ? AND r.dismissed = 0
        AND r.entity_id IN (SELECT value FROM json_each(?))
    `).all(userId, JSON.stringify(wanted));
    for (const row of rows) {
      const id = Number(row.id);
      remindKeysByOwner.set(id, [...(remindKeysByOwner.get(id) ?? []), String(row.remind_key ?? '')]);
    }
  }
  if (remindKeysByOwner.size > 0) {
    const masters = database.prepare(`
      SELECT * FROM calendar_events
      WHERE recurrence_rule IS NOT NULL AND recurrence_rule != ''
        AND id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify([...remindKeysByOwner.keys()]));
    for (const master of masters) {
      const id = Number(master.id);
      try {
        slotsBySeries.set(id, notifyingSlots(database, master, remindKeysByOwner.get(id) ?? []));
      } catch (err) {
        log.error(`Finding the occurrence a reminder of series ${id} belongs to failed:`, err instanceof Error ? err.message : err);
        slotsBySeries.set(id, new Set());
      }
    }
  }
  return {
    has(ownerId, recurrenceId = null) {
      if (!remindKeysByOwner.has(ownerId)) return false;
      const slots = slotsBySeries.get(ownerId);
      return slots ? recurrenceId != null && slots.has(String(recurrenceId)) : true;
    },
  };
}
