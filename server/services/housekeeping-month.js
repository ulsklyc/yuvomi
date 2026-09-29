/**
 * Modul: Haushaltshilfe - der Monat des Haushalts
 * Zweck: In welchen Monat ein Besuch faellt, fuer das Modul UND die Uebersicht.
 * Abhaengigkeiten: utils/timezone.js, utils/interval-date.js
 *
 * `check_in` ist ein UTC-Instant: der Check-in schreibt `toISOString()`, das
 * Bearbeiten ebenso (#1540), und kein Codepfad hat je eine andere Form
 * geschrieben. Zonenlose Wanduhrzeit liest `storedToInstantMs()` trotzdem mit -
 * als Absicherung fuer von Hand eingespielte Zeilen, nicht als Bestandsform.
 * `substr(check_in, 1, 7)` ist der UTC-Monat: ein Besuch am Ersten um 00:30
 * Berliner Zeit stand im Vormonat, westlich von UTC einer am Letzten abends schon im naechsten. #1387
 * hat das Modul umgestellt, die Uebersicht zaehlte weiter so (#1451) - zwei
 * Zahlen fuer denselben Monat. Beide lesen jetzt hier.
 */

import { localToUTCPrecise, storedToInstantMs, utcToWall } from '../utils/timezone.js';
import { addMonthsClamped } from '../utils/interval-date.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Der Monat (YYYY-MM), in dem ein gespeicherter Zeitpunkt im Haushalt liegt.
 * `storedToInstantMs()` liest Instant und zonenlose Wanduhrzeit.
 */
export function householdMonthOf(value, tz) {
  const ms = storedToInstantMs(value, tz);
  if (ms === null) return null;
  return utcToWall(new Date(ms).toISOString(), tz)?.date.slice(0, 7) ?? null;
}

/**
 * Ein Monat des Haushalts als halboffenes Intervall [start, end) in UTC, in
 * der Schreibweise von `check_in` (`toISOString()`), damit der Textvergleich
 * in SQL dem Zeitvergleich entspricht.
 */
export function householdMonthRange(monthValue, tz) {
  const toInstant = (key) => new Date(localToUTCPrecise(`${key}-01T00:00:00`, tz)).toISOString();
  const next = addMonthsClamped(`${monthValue}-01`, 1).slice(0, 7);
  return {
    start: toInstant(monthValue),
    // Nach 9999-12 gibt es keinen vierstelligen Monat mehr, den ein
    // gespeicherter Besuch tragen koennte.
    end: /^\d{4}-\d{2}$/.test(next) ? toInstant(next) : '9999-12-31T23:59:59.999Z',
  };
}

/**
 * Die ABGESCHLOSSENEN Besuche eines Haushaltsmonats: Anzahl und offener
 * Betrag (unbezahlt, Tagessatz plus Extras) - die Zahlen der Uebersicht.
 *
 * Der Textvergleich allein traegt nur die Instant-Form: eine zonenlose Zeile
 * ('2026-09-30T23:30:00') sortiert als Text nach '2026-09-30T22:00:00.000Z'
 * und fiele in Berlin in den Oktober. SQL holt deshalb ein Fenster mit einem
 * Tag Rand je Seite, und entschieden wird Zeile fuer Zeile ueber
 * `householdMonthOf` - dieselbe Regel, nach der das Modul seinen Verlauf
 * gruppiert.
 */
export function finishedVisitsInMonth(database, monthValue, tz) {
  const { start, end } = householdMonthRange(monthValue, tz);
  const widen = (iso, days) => {
    const ms = Date.parse(iso);
    const shifted = Number.isFinite(ms) ? new Date(ms + days * DAY_MS).toISOString() : '';
    // Jenseits von 9999 schreibt toISOString '+010000-…' - als Text kleiner als jedes Datum.
    return /^\d{4}-/.test(shifted) ? shifted : iso;
  };
  const rows = database.prepare(`
    SELECT check_in, daily_rate, extras, paid_at
    FROM housekeeping_work_sessions
    WHERE check_out IS NOT NULL AND check_in >= ? AND check_in < ?
  `).all(widen(start, -1), widen(end, 1))
    .filter((row) => householdMonthOf(row.check_in, tz) === monthValue);
  return {
    visits: rows.length,
    unpaid: rows.reduce((sum, row) => (row.paid_at ? sum : sum + Number(row.daily_rate || 0) + Number(row.extras || 0)), 0),
  };
}
