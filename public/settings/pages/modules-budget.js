import { api } from '/api.js';
import { getLocale, t } from '/i18n.js';

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

function appendCurrencyOptions(select, selectedCurrency) {
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

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionBudget')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.currencyLabel')}</h3>
        <p class="form-hint">${t('settings.currencyHint')}</p>
        <label class="form-label" for="currency-select">${t('settings.currencyLabel')}</label>
        <select class="form-input" id="currency-select"></select>
      </div>
    </section>
  `);

  appendCurrencyOptions(
    container.querySelector('#currency-select'),
    preferences.currency || 'EUR',
  );
}

function bindEvents(container, initialCurrency) {
  const currencySelect = container.querySelector('#currency-select');
  let persistedCurrency = initialCurrency;

  currencySelect?.addEventListener('change', async () => {
    if (currencySelect.disabled) return;

    try {
      await persistCurrencySelection(
        currencySelect,
        persistedCurrency,
        () => api.put('/preferences', { currency: currencySelect.value }),
      );
      persistedCurrency = currencySelect.value;
      window.oikos?.showToast(t('settings.currencySaved'), 'success');
    } catch (error) {
      window.oikos?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  });
}

export async function render(container, { user }) {
  void user;
  const response = await api.get('/preferences');
  const preferences = response?.data ?? {};
  renderPage(container, preferences);
  bindEvents(container, preferences.currency || 'EUR');
}
