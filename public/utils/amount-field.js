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
import { amountPlaceholder, amountToInput, amountExample, amountInputProblem, smallestUnitLabel, currencySymbol } from '/utils/money.js';

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
 * DAS FELD MIT SEINER WAEHRUNG (R22 D9, Critique R24 G4-Budget-P1-1): Betrag
 * gross mit Ziffern gleicher Breite, die Waehrung als Suffix IM Feld. Bis R24
 * hatte nur die Buchung diese Form; Umbuchung, Ausgabe, Darlehen und Abo
 * fuehrten die Waehrung als eigenes Feld daneben (Select "EUR", Such-Combobox)
 * oder gar nicht. Jetzt EIN Markup fuer jedes Geldgeruest.
 *
 * Ohne `currencies` ist das Suffix das Zeichen der Waehrung (`€`), ohne
 * Zeiger. Mit `currencies` ist es die WAHL der Waehrung - ein `<select>` mit den
 * Codes am selben Ort (`.budget-amount-field__unit--choice`); der Dialog zieht
 * beim Wechsel `setAmountCurrency` nach wie bisher am eigenen Feld.
 *
 * @param {object} opts
 * @param {string} opts.id          id des Textfelds
 * @param {string} opts.currency    ISO-Code
 * @param {number|string|null} [opts.value]
 * @param {string} [opts.name]      name des Textfelds (Formulare mit FormData)
 * @param {boolean} [opts.required=true]
 * @param {string[]|null} [opts.currencies]  Codes der Wahl, oder null
 * @param {string} [opts.currencyName='currency']  name der Wahl
 * @param {string} [opts.currencyId]  id der Wahl
 * @param {string} [opts.describedBy]  weitere ids fuer aria-describedby
 * @returns {string}
 */
export function amountFieldHtml({
  id, currency, value = '', name = '', required = true,
  currencies = null, currencyName = 'currency', currencyId = '', describedBy = '',
}) {
  const choice = Array.isArray(currencies) && currencies.length > 0;
  const unitId = choice ? (currencyId || `${id}-currency`) : `${id}-unit`;
  const list = choice && !currencies.includes(currency) ? [currency, ...currencies] : currencies;
  const unit = choice
    ? `<select class="budget-amount-field__unit budget-amount-field__unit--choice" id="${esc(unitId)}" name="${esc(currencyName)}"
        aria-label="${esc(t('splitExpenses.currency'))}">${list.map((code) =>
        `<option value="${esc(code)}"${code === currency ? ' selected' : ''}>${esc(code)}</option>`).join('')}</select>`
    : `<span class="budget-amount-field__unit" id="${esc(unitId)}">${esc(currencySymbol(currency))}</span>`;
  const described = [choice ? '' : unitId, describedBy].filter(Boolean).join(' ');
  return `<div class="budget-amount-field${choice ? ' budget-amount-field--choice' : ''}">
        <input class="form-input budget-amount-input" id="${esc(id)}"${name ? ` name="${esc(name)}"` : ''}${amountInputAttrs(currency, value)}
               ${described ? `aria-describedby="${esc(described)}"` : ''}${required ? ' required' : ''}>
        ${unit}
      </div>`;
}

/**
 * Das Zeichen im Suffix eines Feldes ohne Wahl auf eine andere Waehrung
 * stellen (Konto gewechselt). Ein Feld MIT Wahl zeigt den Code selbst.
 */
export function setAmountUnit(input, currency) {
  const unit = input?.parentElement?.querySelector('span.budget-amount-field__unit');
  if (unit) unit.textContent = currencySymbol(currency);
  setAmountCurrency(input, currency);
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
  const problem = amountInputProblem(input.value, currency, { ...options, decimalComma: true });
  if (!problem || (problem === 'precision' && !precision)) return false;
  return [input, amountProblemText(problem, currency)];
}
