/**
 * Modul: Haushaltshilfe - der Monat des Haushalts
 * Zweck: In welchen Monat ein Besuch faellt, fuer das Modul UND die Uebersicht -
 *        und welcher von mehreren Besuchen der spaetere ist.
 * Abhaengigkeiten: utils/timezone.js, utils/interval-date.js
 *
 * `check_in` ist ein UTC-Instant: der Check-in schreibt `toISOString()`, das
 * Bearbeiten ebenso (#1540), und kein Codepfad hat je eine andere Form
 * geschrieben. Zonenlose Wanduhrzeit liest `checkInInstantMs()` trotzdem mit -
 * als Absicherung fuer von Hand eingespielte Zeilen, nicht als Bestandsform.
 * `substr(check_in, 1, 7)` ist der UTC-Monat: ein Besuch am Ersten um 00:30
 * Berliner Zeit stand im Vormonat, westlich von UTC einer am Letzten abends schon im naechsten. #1387
 * hat das Modul umgestellt, die Uebersicht zaehlte weiter so (#1451) - zwei
 * Zahlen fuer denselben Monat. Beide lesen jetzt hier.
 */

import { localToUTCPrecise, storedToInstantMsPrecise, utcToWall } from '../utils/timezone.js';
import { addMonthsClamped } from '../utils/interval-date.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ein gespeicherter `check_in` als Zeitpunkt (ms seit Epoch) - die EINE Lesart
 * fuer Monat, Tag und Reihenfolge. Instants bleiben, was sie sind; zonenlose
 * Wanduhrzeit wird in `tz` gelesen, DST-genau: die einfache Umrechnung bildet
 * in der Umstellnacht zwei Wanduhrzeiten auf denselben Zeitpunkt ab (Berlin,
 * 00:30 und 01:30 werden beide 23:30Z).
 *
 * Sekundenbruchteile einer zonenlosen Zeile traegt der geteilte Umrechner
 * selbst durch (#1658). Bis dahin rechnete er sie doppelt - '…T23:59:59.900'
 * kam in einem UTC-Haushalt als '00:00:00.800' des Folgetags heraus -, und
 * diese Funktion nahm den Bruchteil deshalb an ihm vorbei.
 */
export function checkInInstantMs(value, tz) {
  return storedToInstantMsPrecise(value, tz);
}

/**
 * Der Monat (YYYY-MM), in dem ein gespeicherter Zeitpunkt im Haushalt liegt.
 */
export function householdMonthOf(value, tz) {
  const ms = checkInInstantMs(value, tz);
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
 * Das SQL-Fenster fuer einen Haushaltsmonat: seine Grenzen mit einem Tag Rand
 * je Seite. Wer damit liest, MUSS danach mit `householdMonthOf` aussieben.
 *
 * Der Textvergleich gegen die genauen Grenzen traegt nur die Instant-Form:
 * eine zonenlose Zeile ('2026-09-30T23:30:00') sortiert als Text nach
 * '2026-09-30T22:00:00.000Z' und fiele in Berlin in den Oktober, westlich von
 * UTC eine vom Ersten frueh in den Vormonat. Der Rand holt beide herein, und
 * entschieden wird Zeile fuer Zeile - dieselbe Regel, nach der das Modul seine
 * Monatsgrafik gruppiert.
 */
export function householdMonthWindow(monthValue, tz) {
  return widenedWindow(householdMonthRange(monthValue, tz));
}

/**
 * Ein halboffenes Intervall in der Schreibweise von `check_in`, um einen Tag
 * Rand je Seite geweitet. Der Rand reicht fuer jede Form: eine zonenlose
 * Wanduhrzeit steht als Text hoechstens 14 Stunden neben ihrem Zeitpunkt.
 */
export function widenedWindow({ start, end }) {
  const widen = (iso, days) => {
    const ms = Date.parse(iso);
    const shifted = Number.isFinite(ms) ? new Date(ms + days * DAY_MS).toISOString() : '';
    // Jenseits von 9999 schreibt toISOString '+010000-…' - als Text kleiner als jedes Datum.
    return /^\d{4}-/.test(shifted) ? shifted : iso;
  };
  return { start: widen(start, -1), end: widen(end, 1) };
}

/**
 * Sortierfunktion "spaetester Besuch zuerst", nach dem ZEITPUNKT von
 * `check_in`. `ORDER BY check_in` sortiert Text: die zonenlose
 * '2026-07-15T11:00:00' (11:00 im Haushalt) steht dann hinter
 * '2026-07-15T10:00:00.000Z' (12:00 in Berlin), und '…T10:00:00Z' aus
 * scripts/seed-demo.js hinter '…T10:00:00.500Z' derselben Sekunde. Unlesbare
 * Werte ans Ende, Gleichstand nach der juengeren Zeile.
 * Gelesen wird ueber `checkInInstantMs()`: DST-genau, sonst entschiede in der
 * Umstellnacht die `id` einen falschen Gleichstand.
 */
export function byCheckInDesc(tz) {
  const at = (row) => checkInInstantMs(row.check_in, tz) ?? -Infinity;
  return (a, b) => {
    const [left, right] = [at(a), at(b)];
    if (left !== right) return left > right ? -1 : 1;
    return (b.id ?? 0) - (a.id ?? 0);
  };
}

/**
 * Der spaeteste Besuch - ersetzt `ORDER BY check_in DESC LIMIT 1`.
 *
 * Ohne die ganze Tabelle zu lesen: die als TEXT groesste Zeile gibt den
 * Zeitpunkt vor, und nur was als Text hoechstens einen Tag darunter liegt, kann
 * als Zeitpunkt spaeter sein. Unter diesen Zeilen entscheidet `byCheckInDesc`.
 * `where` ist ein fester SQL-Ausdruck des Aufrufers, nie Eingabe.
 */
export function latestVisit(database, tz, where = '', params = []) {
  const from = `FROM housekeeping_work_sessions WHERE ${where || '1 = 1'}`;
  const top = database.prepare(`SELECT check_in ${from} ORDER BY check_in DESC LIMIT 1`).get(...params);
  if (!top) return undefined;
  const topMs = checkInInstantMs(top.check_in, tz);
  const floor = topMs === null ? '' : widenedWindow({ start: new Date(topMs).toISOString(), end: '' }).start;
  return database.prepare(`SELECT * ${from} AND check_in >= ?`).all(...params, floor)
    .sort(byCheckInDesc(tz))[0];
}

/**
 * Die ABGESCHLOSSENEN Besuche eines Haushaltsmonats: Anzahl und offener
 * Betrag (unbezahlt, Tagessatz plus Extras) - die Zahlen der Uebersicht.
 */
export function finishedVisitsInMonth(database, monthValue, tz) {
  const window = householdMonthWindow(monthValue, tz);
  const rows = database.prepare(`
    SELECT check_in, daily_rate, extras, paid_at
    FROM housekeeping_work_sessions
    WHERE check_out IS NOT NULL AND check_in >= ? AND check_in < ?
  `).all(window.start, window.end)
    .filter((row) => householdMonthOf(row.check_in, tz) === monthValue);
  return {
    visits: rows.length,
    unpaid: rows.reduce((sum, row) => (row.paid_at ? sum : sum + Number(row.daily_rate || 0) + Number(row.extras || 0)), 0),
  };
}
