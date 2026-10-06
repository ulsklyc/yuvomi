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

// Der naechste Termin einer Serie nach `dateText` - die EINE Rechnung, durch die
// der Buchungslauf der geteilten Ausgaben (generateRecurringExpense in
// server/services/split-expenses-scheduler.js), das Fortsetzen
// (nextRunNotBefore) und die Taschengeld-Gutschrift (#1734,
// server/services/reward-money.js) gehen.
//
// Monate und Jahre klemmen aufs Monatsende (server/utils/interval-date.js) und
// heben den Tag danach wieder auf `anchorDay`, den Tag, fuer den die Serie
// gedacht ist (`recurring_expenses.anchor_day`): 31.01. -> 28.02. -> 31.03.,
// jaehrlich 29.02. -> 28.02. -> im Schaltjahr wieder 29.02. Bis #1721 stand
// hier `setUTCMonth(+1)`: der 31. lief in den Folgemonat ueber (31.01. ->
// 03.03.), der Februar blieb ohne Buchung, und weil der naechste Schritt vom
// uebergelaufenen Datum ausging, kam die Serie nie zurueck.
//
// Ohne Anker (NULL) klemmt der Schritt nur. Woechentlich sind es sieben Tage,
// der Anker spielt dort nicht mit.
//
// Ein Termin in Datumsform, der kein Datum ist ("2026-02-31"), wird gelesen wie
// vor #1721: als der Tag, auf den `Date` ihn ueberlaufen laesst (03.03.). Die
// Route laesst so etwas nicht herein, aber die geteilten Helfer werfen daran,
// und ein Schritt, der wirft, liesse den Lauf an dieser Serie stuendlich
// scheitern, ohne sie je zu pausieren. Was auch `Date` nicht liest
// ("2026-13-01"), wirft hier wie zuvor.
export function addInterval(dateText, frequency, anchorDay = null) {
  const from = dateKey(new Date(`${dateText}T00:00:00Z`));
  if (frequency === 'monthly') return liftToAnchorDay(addMonthsClamped(from, 1), anchorDay);
  if (frequency === 'yearly') return liftToAnchorDay(addYearsClamped(from, 1), anchorDay);
  const date = parseDateKey(from);
  if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
  return dateKey(date);
}

// Der erste Termin der Serie, der nicht vor `today` liegt, gezaehlt ab
// `dateText` in ganzen Intervallen - mit addInterval, also mit genau der
// Rechnung, mit der der Lauf nach jeder Buchung weiterrueckt. Bewusst gezaehlt
// und nicht gesprungen: wo die Serie nach n Schritten steht, sagt der Lauf, und
// eine zweite Rechnung daneben muesste ihm erst wieder gleichen (ohne Anker
// haengt der naechste Termin vom vorigen ab: 31.01. -> 28.02. -> 28.03.).
//
// `anchorDay` ist der Ankertag der Zeile; wer ihn weglaesst, bekommt das Raster
// einer Serie ohne Anker.
//
// `skipped` zaehlt die uebergangenen Termine. Ein Termin am Tag `today` gilt
// nicht als versaeumt: der naechste Lauf bucht ihn.
export function nextRunNotBefore(dateText, frequency, today, anchorDay = null) {
  // Ein Datum, das keins ist, oder ein Rhythmus, der nicht vorrueckt, bleibt
  // stehen, statt zu werfen oder endlos zu zaehlen.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(today))) return { date: dateText, skipped: 0 };
  let date = dateText;
  let skipped = 0;
  while (date < today) {
    let next;
    // "2026-13-01" hat die Form eines Datums und ist keins.
    try { next = addInterval(date, frequency, anchorDay); } catch { break; }
    if (!(next > date)) break;
    date = next;
    skipped += 1;
  }
  return { date, skipped };
}
