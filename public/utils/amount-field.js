/**
 * DAS BETRAGSFELD - EIN Baustein fuer jede Geldeingabe der App (Critique R23, D1).
 *
 * Bis R23 gab es zwei Dialekte. Die geteilten Ausgaben, Belohnungen und der
 * Einkauf nahmen Text und lasen ihn mit `toDecimalString`; Budget, Abos,
 * Darlehen, Umbuchung, Inventar und Haushaltshilfe nahmen `type="number"`. Das
 * zweite ist bei Geld gefaehrlich: Chrome liest "1.200" unter de als 1,2 und
 * speichert still einen Tausendstel des Gemeinten, "1.234,56" lehnt es ab - mit
 * einer Meldung "0.01", die dem Platzhalter "0,00" widerspricht. Ein Zahlenfeld
 * zeigt ausserdem, was der BROWSER fuer die Region haelt, nicht was die App
 * eingestellt hat.
 *
 * Der Baustein besteht aus drei Teilen, die zusammengehoeren:
 * - `amountInputAttrs()` ins Markup: Textfeld mit `inputmode="decimal"`,
 *   Platzhalter und Bestandswert in der Schreibweise der Region.
 * - `amountFieldError()` beim Speichern: der benannte Grund (gruppiert, keine
 *   Zahl, nicht positiv, zu viele Stellen) als Eintrag fuer `reportFieldErrors`.
 * - `parseAmountInput()` (utils/money.js) fuer den Wert, der gesendet wird.
 *
 * Ein `type="number"` an einem Geldfeld haelt `test:budget-ui` auf.
 */
import { t, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { amountPlaceholder, amountToInput, amountExample, amountInputProblem, smallestUnitLabel } from '/utils/money.js';

/**
 * Die Attribute eines Betragsfeldes, ohne `id`, `class` und `required` - die
 * setzt der Aufrufer wie bei jedem anderen Feld.
 *
 * @param {string} currency ISO-Code
 * @param {number|string|null} [value] Bestandswert (Zahl oder Punkt-Dezimaltext)
 * @returns {string}
 */
export function amountInputAttrs(currency, value = '') {
  return ` type="text" inputmode="decimal" autocomplete="off" spellcheck="false"`
    + ` placeholder="${esc(amountPlaceholder(currency))}" value="${esc(amountToInput(value ?? '', currency))}"`;
}

/**
 * Ein Betragsfeld auf eine andere Waehrung umstellen (Waehrungsauswahl im
 * selben Dialog). Nur der Platzhalter folgt; den Wert prueft das Speichern.
 */
export function setAmountCurrency(input, currency) {
  if (input) input.placeholder = amountPlaceholder(currency);
}

/**
 * Der Satz zu einem Grund aus `amountInputProblem()`.
 * @param {string} problem
 * @param {string} currency
 * @param {{ digits?: number }} [options]  `digits`: die Stellen, die der SERVER
 *   fuer diesen Betrag fuehrt (Belohnungen-Geld) - sonst die der Waehrung.
 */
export function amountProblemText(problem, currency, { digits = null } = {}) {
  if (problem === 'grouped') return t('common.amountGrouped', { example: amountExample(currency) });
  if (problem === 'invalid') return t('common.amountInvalid', { example: amountExample(currency) });
  if (problem === 'notPositive') return t('common.amountNotPositive');
  const step = Number.isInteger(digits) && digits >= 0
    ? getNumberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(1 / 10 ** digits)
    : smallestUnitLabel(currency);
  return t('common.amountPrecisionRequired', { currency, step });
}

/**
 * Was am Betragsfeld zu melden ist - als `[feld, text]` fuer `reportFieldErrors`
 * oder `false`.
 *
 * @param {HTMLInputElement|null} input
 * @param {string} currency
 * @param {{ required?: boolean, sign?: 'positive'|'nonNegative'|'any',
 *           original?: number|string|null, originalCurrency?: string|null }} [options]
 *   `original`: der Bestandswert - ein unangetasteter Wert neben dem Raster
 *   bleibt speicherbar (siehe `amountInputProblem`).
 *   `precision: false`: die Stellen nicht pruefen - fuer ein Formular, dessen
 *   Waehrung noch fehlt (das Waehrungsfeld meldet dann selbst).
 */
export function amountFieldError(input, currency, { precision = true, ...options } = {}) {
  if (!input) return false;
  const problem = amountInputProblem(input.value, currency, options);
  if (!problem || (problem === 'precision' && !precision)) return false;
  return [input, amountProblemText(problem, currency)];
}
