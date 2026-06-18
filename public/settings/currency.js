import { getLocale } from '/i18n.js';

// Haushaltweite Währungsauswahl. Muss exakt mit VALID_CURRENCIES in
// server/routes/preferences.js übereinstimmen (per Test abgesichert).
export const SUPPORTED_CURRENCIES = [
  'AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HUF',
  'INR', 'JPY', 'KZT', 'NOK', 'PLN', 'RUB', 'SAR', 'SEK', 'TRY', 'UAH', 'USD',
];

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

export function appendCurrencyOptions(select, selectedCurrency) {
  let displayNames = null;
  try {
    displayNames = new Intl.DisplayNames([getLocale()], { type: 'currency' });
  } catch {
    // Currency codes remain usable when DisplayNames is unavailable.
  }

  for (const currency of SUPPORTED_CURRENCIES) {
    const option = document.createElement('option');
    option.value = currency;
    const displayName = displayNames?.of(currency);
    option.textContent = displayName ? `${currency} - ${displayName}` : currency;
    option.selected = currency === selectedCurrency;
    select.appendChild(option);
  }
}
