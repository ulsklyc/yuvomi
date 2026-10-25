import { getLocale } from '/i18n.js';
import { CURRENCY_CODES } from '/utils/currency-codes.js';

export async function persistCurrencySelection(select, previousCurrency, save) {
  select.disabled = true;
  try {
    await save();
  } catch (error) {
    select.value = previousCurrency;
    throw error;
  } finally {
    select.disabled = false;
  }
}

const displayNamesByLocale = new Map();
function currencyDisplayNames(locale) {
  if (!displayNamesByLocale.has(locale)) {
    let names = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'currency' });
    } catch {
      // Currency codes remain usable when DisplayNames is unavailable.
    }
    displayNamesByLocale.set(locale, names);
  }
  return displayNamesByLocale.get(locale);
}

/** Full name of a currency ("United Arab Emirates Dirham"), or null. */
export function currencyName(currency, locale = getLocale()) {
  return currencyDisplayNames(locale)?.of(currency) || null;
}

/**
 * Short label of a currency for a select in a narrow column (#2166): the code
 * plus its narrow symbol from CLDR ("GBP £", "USD $"), or the code alone when
 * the symbol is the code ("AED", "CHF"). The code keeps every option distinct;
 * the full name goes in the hint line next to the select (`currencyName`).
 */
export function currencyShortLabel(currency, locale = getLocale()) {
  try {
    const symbol = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((part) => part.type === 'currency')?.value;
    return symbol && symbol !== currency ? `${currency} ${symbol}` : currency;
  } catch {
    return currency;
  }
}

/** Long label "AED - United Arab Emirates Dirham", for full-width selects. */
export function currencyLongLabel(currency, locale = getLocale()) {
  const name = currencyName(currency, locale);
  return name ? `${currency} - ${name}` : currency;
}

export function appendCurrencyOptions(select, selectedCurrency, label = currencyLongLabel) {
  for (const currency of CURRENCY_CODES) {
    const option = document.createElement('option');
    option.value = currency;
    option.textContent = label(currency);
    option.selected = currency === selectedCurrency;
    select.appendChild(option);
  }
}
