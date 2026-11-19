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
 * @returns {{ converted_amount: string | null, converted_currency: string, exchange_snapshot: Record<string, unknown> | null }}
 */
export function keptConversion(expense, amount, currency) {
  if (!conversionKept(expense, amount, currency)) {
    return { converted_amount: null, converted_currency: currency, exchange_snapshot: null };
  }
  return {
    converted_amount: expense.converted_amount,
    converted_currency: expense.converted_currency,
    exchange_snapshot: storedSnapshot(expense),
  };
}

/**
 * Bleibt die gespeicherte Umrechnung beim Speichern stehen? Die EINE Bedingung
 * fuer den Payload (keptConversion) und die Pruefung im Dialog
 * (exactShareBasis): Betrag und Waehrung unveraendert, und die Ausgabe traegt
 * eine Umrechnung als Dezimaltext des Servers.
 *
 * @param {any} expense die gespeicherte Ausgabe oder null (neue Ausgabe, Serie)
 * @param {string} amount der Betrag des Dialogs (Dezimaltext mit Punkt)
 * @param {string} currency die Waehrung des Dialogs
 * @returns {boolean}
 */
export function conversionKept(expense, amount, currency) {
  if (!expense) return false;
  const unchanged = currency === expense.currency && Number(amount) === Number(expense.amount);
  return unchanged && Boolean(expense.converted_currency) && typeof expense.converted_amount === 'string';
}

/**
 * Wogegen die exakten Anteile aufgehen muessen. Der Server rechnet sie bei
 * behaltener Umrechnung gegen `converted_amount` in `converted_currency`
 * (buildSplits in PUT /expenses/:id), und genau dort liegen auch die
 * gespeicherten Anteile (expense_splits.currency). Prueft der Dialog gegen den
 * eingegebenen Betrag, bestehen 6 + 4 bei "10 USD -> 9 EUR" im Dialog, und
 * der Server antwortet 400. Aendert der Dialog Betrag oder Waehrung, faellt
 * die Umrechnung weg (keptConversion), und es gilt wieder die Eingabe.
 *
 * `from` nennt den eingegebenen Betrag, wenn die Anteile in einer ANDEREN
 * Waehrung stehen als die Eingabe - sonst null. Der Betrag bleibt Text des
 * Servers, hier wird nichts zurueckgerechnet.
 *
 * `digits`: die Nachkommastellen, die der SERVER fuer die Anteile fuehrt, oder
 * null (dann gelten die der Waehrung). Bei behaltener Umrechnung abgelesen am
 * Dezimaltext `converted_amount` - der Server schreibt ihn ueber
 * minorToDecimal immer mit voller Stellenzahl. COP, HUF, IDR und IRR zeigt
 * der CLDR ohne Nachkommastellen, der Server speichert sie mit zwei: eine
 * Umrechnung nach HUF ergibt "3581.47", und mit der Genauigkeit des CLDR
 * koennten die Anteile diese Summe nie treffen. Die EINE Quelle fuer
 * Feldpruefung, Platzhalter und Fehlertext.
 *
 * @param {any} expense die gespeicherte Ausgabe oder null
 * @param {string} amount der Betrag des Dialogs (Dezimaltext mit Punkt)
 * @param {string} currency die Waehrung des Dialogs
 * @returns {{ amount: string, currency: string, digits: number | null, from: { amount: string, currency: string } | null }}
 */
export function exactShareBasis(expense, amount, currency) {
  if (!conversionKept(expense, amount, currency)) return { amount, currency, digits: null, from: null };
  const from = expense.converted_currency === currency ? null : { amount: String(expense.amount), currency };
  const digits = (expense.converted_amount.split('.')[1] ?? '').length;
  return { amount: expense.converted_amount, currency: expense.converted_currency, digits, from };
}

/**
 * Der gespeicherte Kurs als Objekt (die Spalte haelt Text), oder null. Das
 * Schema nimmt seit v2.94 nur ein Objekt oder null an (#2810); bis v2.93
 * speicherte es jeden JSON-Wert, den ein fremder Client schickte. Eine solche
 * Bestandszeile (Text, Zahl, Liste, `true`) geht als null zurueck, sonst
 * antwortete jedes Speichern im Dialog 400.
 * @param {any} expense
 * @returns {Record<string, unknown> | null}
 */
function storedSnapshot(expense) {
  let value = expense?.exchange_snapshot ?? null;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
