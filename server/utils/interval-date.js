/**
 * Modul: Monats-/Jahres-Addition mit Tages-Klemmung
 * Zweck: `Datum + N Monate/Jahre`, Tag geklemmt auf den letzten Tag des Zielmonats
 *        (31. Januar + 1 Monat -> 28./29. Februar) - EINE Rechnung fuer jedes
 *        Modul, das eine Frist um Monate/Jahre verschiebt.
 * Abhängigkeiten: keine.
 *
 * WARUM DIESE DATEI EXISTIERT: dieselbe Rechnung stand bereits zweimal im Baum -
 * server/services/subscriptions.js#addBillingCycle (monthly/yearly-Zweige) und
 * server/services/inventory-deadlines.js#warrantyEndDate (dessen eigener
 * Kommentar schon zugab, die erste Kopie zu spiegeln). Praevention waere die
 * dritte. Beide bestehenden Module sind jetzt duenne Fassaden darueber -
 * dasselbe Vorbild wie server/utils/reminder-schedule.js.
 */

export function dateKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function parseDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Date must be in YYYY-MM-DD format.');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (dateKey(date) !== value) throw new Error('Date is invalid.');
  return date;
}

/** `value` (YYYY-MM-DD) + `months`, Tag geklemmt auf den letzten Tag des Zielmonats. */
export function addMonthsClamped(value, months) {
  const date = parseDateKey(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + Number(months));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return dateKey(date);
}

/** `value` (YYYY-MM-DD) + `years`, Tag geklemmt (29. Feb + 1 Jahr -> 28. Feb). */
export function addYearsClamped(value, years) {
  const date = parseDateKey(value);
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + Number(years));
  date.setUTCMonth(month);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return dateKey(date);
}

/**
 * Hebt den Tag von `value` (YYYY-MM-DD) auf `anchorDay`, soweit der Monat ihn
 * hat - sonst auf den Monatsletzten. Der Monat bleibt, und gesenkt wird nie.
 *
 * Das Gegenstueck zum Klemmen oben: `addMonthsClamped('2026-01-31', 1)` ist der
 * 28.02., und der naechste Schritt von dort der 28.03. - der 31. ist vergessen.
 * Eine Serie, die ihren Tag kennt, hebt nach jedem Schritt wieder an:
 * 31 -> 28/29 -> 31 (#1721).
 *
 * Ohne brauchbaren Anker (NULL, keine ganze Zahl von 1 bis 31) bleibt `value`,
 * wie es ist: dann gilt das Klemmen allein.
 */
export function liftToAnchorDay(value, anchorDay) {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) return value;
  const date = parseDateKey(value);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay, lastDay);
  if (day <= date.getUTCDate()) return value;
  date.setUTCDate(day);
  return dateKey(date);
}
