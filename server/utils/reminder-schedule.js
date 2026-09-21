/**
 * Modul: Erinnerungs-Vorlauf - reine Datumsrechnung
 * Zweck: "N Tage vor diesem Datum, morgens" als EINE Rechnung für alle Module,
 *        die eine Frist ankündigen (Abos, Garantien, Inventar-Fristen, Vorrat).
 * Abhängigkeiten: keine.
 *
 * WARUM DIESE DATEI EXISTIERT: dieselben vier Zeilen standen zweimal im Baum -
 * server/services/subscriptions.js#reminderDate und
 * server/services/inventory-deadlines.js#reminderDateForWarranty. Beide sind
 * jetzt Fassaden über dieser Funktion, weil der Vorrat als dritter Aufrufer
 * dazukam und drei Kopien einer Rechnung drei Gelegenheiten sind, sie
 * auseinanderlaufen zu lassen. Die sprechenden Namen bleiben an ihren Modulen:
 * "reminderDateForWarranty" sagt am Gegenstand mehr als der generische Name.
 *
 * KEIN ZEITZONEN-SUFFIX am Ergebnis, bewusst: `reminders.remind_at` wird im
 * ganzen Baum als naiv-UTC gelesen (siehe public/utils/reminder-offset.js).
 * Ein 'Z' hier wäre kein Detail, sondern ein zweiter Offset obendrauf.
 */

/** Feste Tageszeit der Ankündigung. Eine Frist hat keine Uhrzeit - die Meldung braucht eine. */
const REMINDER_TIME = '09:00';

/**
 * Dieselbe Tageszeit als anhängbares Suffix, für Aufrufer, die den Termin in
 * SQL bilden (`date(x, '-7 days') || ?`). Exportiert statt dort getippt: eine
 * Uhrzeit, die an zwei Stellen steht, ist zwei Uhrzeiten.
 */
export const REMINDER_TIME_SUFFIX = `T${REMINDER_TIME}`;

/* HIER STAND EINMAL EIN ZAHLENPAAR (`REMINDER_HOUR`/`REMINDER_MINUTE`), für
 * Aufrufer, die mit der Tageszeit RECHNEN mussten - `setUTCHours(9, 0)`, um den
 * "nächsten Morgen" zu finden. Es ist entfallen, weil genau diese Rechnung der
 * Fehler war: sie mass an der UTC-Wanduhr, während alles daneben in
 * Kalendertagen der Haushaltszone denkt. Wer den nächsten Termin sucht, hängt
 * das Suffix an einen Datumsschlüssel und vergleicht mit
 * `reminderIsInThePast()` - dann gibt es nur eine Uhrzeit und nur eine Uhr. */

function dateKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function parseDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Date must be in YYYY-MM-DD format.');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (dateKey(date) !== value) throw new Error('Date is invalid.');
  return date;
}

/**
 * Erinnerungstermin zu einer Frist: `dueDateKey` minus `offsetDays`, 09:00.
 * @param {string} dueDateKey - YYYY-MM-DD
 * @param {number} offsetDays - Vorlauf in Tagen; negative Werte zählen als 0
 * @returns {string} YYYY-MM-DDTHH:MM ohne Zeitzonen-Suffix
 */
export function reminderDateBefore(dueDateKey, offsetDays) {
  const date = parseDateKey(dueDateKey);
  date.setUTCDate(date.getUTCDate() - Math.max(0, Number(offsetDays) || 0));
  return `${dateKey(date)}T${REMINDER_TIME}`;
}

/**
 * Liegt ein berechneter Erinnerungstermin schon hinter uns?
 * `remindAt` ist naiv-UTC, das 'Z' macht den Vergleich gegen `now` korrekt,
 * statt einen zweiten Zeitzonen-Offset einzuführen.
 * @param {string} remindAt - Ergebnis von reminderDateBefore()
 * @param {Date} [now]
 */
export function reminderIsInThePast(remindAt, now = new Date()) {
  return new Date(`${remindAt}Z`).getTime() <= now.getTime();
}

/**
 * `reminders.remind_at` als Zeitpunkt, in SQL: ein naiv-UTC-Schluessel
 * `YYYY-MM-DDTHH:MM:SS.sss`, der sich als Text richtig vergleichen laesst.
 *
 * WARUM NICHT DIE SPALTE SELBST (#1364). Die Spalte ist naiv-UTC, aber bis
 * einschliesslich v2.68.0 speicherte `POST`/`PUT /api/v1/reminders` den Wert
 * ROH, und ein Wert mit Offset steht deshalb so in Bestandsinstallationen:
 * `18:00:00+02:00`.
 * Als Text gegen `new Date().toISOString()` verglichen ist er erst um 18:00
 * UTC faellig, also zwei Stunden zu spaet; ein westlicher Offset (`-04:00`)
 * feuert entsprechend zu frueh. Die Routen rechnen neue Werte inzwischen um,
 * die alten Zeilen bleiben aber stehen - repariert wird deshalb die LESEseite,
 * ohne Migration.
 *
 * SQLite liest `Z` und `+hh:mm` selbst und rechnet sie nach UTC, ein
 * zonenloser Wert gilt ihm als UTC - genau die Bedeutung der Spalte. `+hhmm`
 * ohne Doppelpunkt (vom Validator ebenfalls angenommen) kennt es nicht und
 * liefert NULL, deshalb wird der Doppelpunkt vorher eingesetzt. Ein reines
 * Datum wird Mitternacht UTC, wie es auch der Textvergleich behandelte.
 *
 * @param {string} column  Spaltenausdruck, z.B. 'r.remind_at' - nie Nutzereingabe
 * @returns {string} SQL-Ausdruck
 */
export function remindAtUtcSql(column) {
  const withColon = `CASE WHEN ${column} GLOB '*[+-][0-9][0-9][0-9][0-9]'`
    + ` THEN substr(${column}, 1, length(${column}) - 2) || ':' || substr(${column}, -2)`
    + ` ELSE ${column} END`;
  return `strftime('%Y-%m-%dT%H:%M:%f', ${withColon})`;
}

/**
 * Die Gegenseite von `remindAtUtcSql()`: ein Zeitpunkt im selben Schluessel.
 * @param {Date|string} instant  Date oder ISO-Zeitpunkt mit Zone
 * @returns {string} YYYY-MM-DDTHH:MM:SS.sss (UTC, ohne Suffix)
 */
export function remindAtCompareKey(instant) {
  return new Date(instant).toISOString().slice(0, 23);
}
