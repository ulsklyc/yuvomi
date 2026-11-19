/**
 * Modul: Umrechnung einer Ausgabe beim Bearbeiten (#2810)
 * Zweck: PUT /split-expenses/expenses/{id} ersetzt die ganze Ausgabe:
 *        `converted_amount`, `converted_currency` und `exchange_snapshot`
 *        muessen mitkommen, der Dialog zeigt sie aber nicht. Bis v2.93 schickte
 *        er sie nie, und jedes Speichern setzte sie zurueck (Betrag, Waehrung,
 *        kein Kurs). Bleiben Betrag und Waehrung unveraendert, gehen die
 *        gespeicherten Werte zurueck; aendert der Dialog eines davon, passt die
 *        gespeicherte Umrechnung nicht mehr, und es bleibt beim bisherigen
 *        Ergebnis: umgerechnet = eingegeben, kein Kurs.
 *
 *        Der umgerechnete Betrag geht als der Dezimaltext zurueck, den der
 *        Server selbst liefert (`converted_amount`, in der Speichergenauigkeit
 *        von `converted_currency`), nie aus `converted_amount_minor` mit der
 *        Anzeigegenauigkeit des Browsers gerechnet: die zeigt HUF, IDR, IRR und
 *        COP ohne Nachkommastellen, der Server speichert sie mit zwei, und aus
 *        900 (9,00 HUF) wurde "900" und damit 90000.
 *
 *        Nie `undefined` - ein solcher Schluessel fiele aus dem JSON.
 */

/**
 * @param {any} expense die gespeicherte Ausgabe, wie die Liste sie liefert
 * @param {string} amount der Betrag des Dialogs (Dezimaltext mit Punkt)
 * @param {string} currency die Waehrung des Dialogs
 * @returns {{ converted_amount: string | null, converted_currency: string, exchange_snapshot: unknown }}
 */
export function keptConversion(expense, amount, currency) {
  const unchanged = currency === expense?.currency && Number(amount) === Number(expense?.amount);
  if (!unchanged || !expense.converted_currency || typeof expense.converted_amount !== 'string') {
    return { converted_amount: null, converted_currency: currency, exchange_snapshot: null };
  }
  return {
    converted_amount: expense.converted_amount,
    converted_currency: expense.converted_currency,
    exchange_snapshot: storedSnapshot(expense),
  };
}

/**
 * Der gespeicherte Kurs als JSON-Wert (die Spalte haelt Text), oder null.
 * @param {any} expense
 * @returns {unknown}
 */
function storedSnapshot(expense) {
  const stored = expense?.exchange_snapshot;
  if (typeof stored !== 'string') return stored ?? null;
  try { return JSON.parse(stored) ?? null; } catch { return null; }
}
