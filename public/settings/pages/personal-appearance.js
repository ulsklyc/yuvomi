import { api } from '/api.js';
import {
  getLocale,
  getSupportedLocales,
  setLocale,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';
import { appendCurrencyOptions, persistCurrencySelection } from '/settings/currency.js';
import {
  CUSTOM_REGION,
  REGION_CODES,
  REGION_PRESETS,
  detectRegion,
  regionLabel,
} from '/settings/region-presets.js';

const DATE_FORMATS = [
  ['mdy', 'MM/DD/YYYY'],
  ['dmy', 'DD.MM.YYYY'],
  ['dmy_slash', 'DD/MM/YYYY'],
  ['ymd', 'YYYY-MM-DD'],
  ['mdy_dot', 'MM.DD.YYYY'],
  ['ymd_dot', 'YYYY.MM.DD'],
  ['ymd_slash', 'YYYY/MM/DD'],
];

function safeStorageGet(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function currentTheme() {
  return safeStorageGet('oikos-theme', 'system') || 'system';
}

function formatOptions(selected) {
  return DATE_FORMATS.map(([value, label]) => (
    `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`
  )).join('');
}

function regionOptions(selectedRegion) {
  const locale = getLocale();
  const presets = REGION_CODES.map((code) => (
    `<option value="${esc(code)}"${selectedRegion === code ? ' selected' : ''}>${esc(regionLabel(code, locale))}</option>`
  )).join('');
  const custom = `<option value="${CUSTOM_REGION}"${selectedRegion === CUSTOM_REGION ? ' selected' : ''}>${t('settings.regionCustom')}</option>`;
  return presets + custom;
}

function localeLabel(locale) {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(locale) || locale;
  } catch {
    return locale;
  }
}

function localeOptions() {
  const storedLocale = safeStorageGet('oikos-locale');
  return [
    `<option value="system"${storedLocale ? '' : ' selected'}>${t('settings.localeSystem')}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${storedLocale === locale ? ' selected' : ''}>${esc(localeLabel(locale))}</option>`
    )),
  ].join('');
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || t('common.errorGeneric');
  element.hidden = false;
}

function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}

function renderLoadError(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="settings-card">
      <p class="form-error" role="alert">${t('settings.loadError')}</p>
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" id="appearance-retry">${t('settings.retry')}</button>
      </div>
    </div>
  `);
}

function renderPage(container, preferences, isAdmin) {
  const theme = currentTheme();
  const activeRegion = detectRegion(preferences);
  const customHidden = isAdmin && activeRegion !== CUSTOM_REGION;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionDesign')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.cardAppearance')}</h3>
        <div class="theme-toggle" id="theme-toggle">
          <button class="theme-toggle__btn ${theme === 'system' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="system" aria-label="${t('settings.themeSysLabel')}" aria-pressed="${theme === 'system'}">
            <i data-lucide="monitor" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeSystem')}
          </button>
          <button class="theme-toggle__btn ${theme === 'light' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="light" aria-label="${t('settings.themeLightLabel')}" aria-pressed="${theme === 'light'}">
            <i data-lucide="sun" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeLight')}
          </button>
          <button class="theme-toggle__btn ${theme === 'dark' ? 'theme-toggle__btn--active' : ''}" type="button" data-theme-value="dark" aria-label="${t('settings.themeDarkLabel')}" aria-pressed="${theme === 'dark'}">
            <i data-lucide="moon" class="icon-md" aria-hidden="true"></i>
            ${t('settings.themeDark')}
          </button>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.languageTitle')}</h2>
      <div class="settings-card">
        <div class="form-group">
          <label class="form-label" for="locale-select">${t('settings.localeLabel')}</label>
          <select class="form-input locale-picker__select" id="locale-select" aria-describedby="locale-error">
            ${localeOptions()}
          </select>
        </div>
        <div id="locale-error" class="form-error" role="alert" hidden></div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.regionTitle')}</h2>
      ${isAdmin ? `
      <div class="settings-card">
        <p class="form-hint">${t('settings.regionHint')}</p>
        <div class="form-group">
          <label class="form-label" for="region-select">${t('settings.regionLabel')}</label>
          <select class="form-input" id="region-select" aria-describedby="region-error">
            ${regionOptions(activeRegion)}
          </select>
        </div>
        <div id="region-error" class="form-error" role="alert" hidden></div>
      </div>` : ''}
      <div class="settings-card" id="custom-formats"${customHidden ? ' hidden' : ''}>
        ${isAdmin ? `
        <div class="form-group">
          <label class="form-label" for="currency-select">${t('settings.currencyLabel')}</label>
          <select class="form-input" id="currency-select" aria-describedby="currency-error"></select>
        </div>
        <div id="currency-error" class="form-error" role="alert" hidden></div>` : ''}
        <div class="form-group">
          <label class="form-label" for="date-format-select">${t('settings.dateFormatLabel')}</label>
          <select class="form-input" id="date-format-select" aria-describedby="date-format-error">
            ${formatOptions(preferences.date_format)}
          </select>
        </div>
        <div id="date-format-error" class="form-error" role="alert" hidden></div>
        <div class="form-group">
          <label class="form-label" for="time-format-select">${t('settings.timeFormatLabel')}</label>
          <select class="form-input" id="time-format-select" aria-describedby="time-format-error">
            <option value="24h"${preferences.time_format === '24h' ? ' selected' : ''}>24 ${t('settings.timeFormatHours')}</option>
            <option value="12h"${preferences.time_format === '12h' ? ' selected' : ''}>AM/PM</option>
          </select>
        </div>
        <div id="time-format-error" class="form-error" role="alert" hidden></div>
      </div>
    </section>
  `);
}

function applyTheme(value) {
  safeStorageSet('oikos-theme', value);
  if (window.oikos?.applyTheme) {
    try {
      window.oikos.applyTheme(value);
      return;
    } catch {
      // Fall back to applying the theme directly when router storage fails.
    }
  }

  if (value === 'dark' || value === 'light') {
    document.documentElement.setAttribute('data-theme', value);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// Hält den Region-Dropdown mit den drei Einzel-Selects synchron (Preset oder
// "Benutzerdefiniert"), nachdem ein Einzelwert manuell geändert wurde.
function syncRegionSelect(container) {
  const regionSelect = container.querySelector('#region-select');
  if (!regionSelect) return;
  regionSelect.value = detectRegion({
    currency: container.querySelector('#currency-select')?.value,
    date_format: container.querySelector('#date-format-select')?.value,
    time_format: container.querySelector('#time-format-select')?.value,
  });
}

function bindEvents(container, user) {
  const themeToggle = container.querySelector('#theme-toggle');
  themeToggle?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-value]');
    if (!button) return;
    applyTheme(button.dataset.themeValue);
    themeToggle.querySelectorAll('.theme-toggle__btn').forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle('theme-toggle__btn--active', active);
      candidate.setAttribute('aria-pressed', String(active));
    });
  });

  const localeSelect = container.querySelector('#locale-select');
  localeSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#locale-error');
    clearError(errorElement);
    localeSelect.disabled = true;
    try {
      if (localeSelect.value === 'system') {
        safeStorageRemove('oikos-locale');
        location.reload();
        return;
      }
      const locale = localeSelect.value;
      await setLocale(locale);
      await render(container, { user });
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      if (localeSelect.isConnected) localeSelect.disabled = false;
    }
  });

  const regionSelect = container.querySelector('#region-select');
  regionSelect?.addEventListener('change', async () => {
    const customBlock = container.querySelector('#custom-formats');
    if (regionSelect.value === CUSTOM_REGION) {
      if (customBlock) customBlock.hidden = false;
      return;
    }
    const preset = REGION_PRESETS[regionSelect.value];
    if (!preset) return;
    const errorElement = container.querySelector('#region-error');
    clearError(errorElement);
    regionSelect.disabled = true;
    try {
      await api.put('/preferences', {
        currency: preset.currency,
        date_format: preset.date_format,
        time_format: preset.time_format,
      });
      const currencySelect = container.querySelector('#currency-select');
      if (currencySelect) currencySelect.value = preset.currency;
      const dateSelect = container.querySelector('#date-format-select');
      if (dateSelect) dateSelect.value = preset.date_format;
      const timeSelect = container.querySelector('#time-format-select');
      if (timeSelect) timeSelect.value = preset.time_format;
      safeStorageSet('oikos-date-format', preset.date_format);
      safeStorageSet('oikos-time-format', preset.time_format);
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: preset.date_format },
      }));
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: preset.time_format },
      }));
      if (customBlock) customBlock.hidden = true;
      window.oikos?.showToast(t('settings.regionSaved'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      if (regionSelect.isConnected) regionSelect.disabled = false;
    }
  });

  const currencySelect = container.querySelector('#currency-select');
  let persistedCurrency = currencySelect?.value;
  currencySelect?.addEventListener('change', async () => {
    if (currencySelect.disabled) return;
    const errorElement = container.querySelector('#currency-error');
    clearError(errorElement);
    try {
      await persistCurrencySelection(
        currencySelect,
        persistedCurrency,
        () => api.put('/preferences', { currency: currencySelect.value }),
      );
      persistedCurrency = currencySelect.value;
      syncRegionSelect(container);
      window.oikos?.showToast(t('settings.currencySaved'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    }
  });

  const dateFormatSelect = container.querySelector('#date-format-select');
  dateFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#date-format-error');
    clearError(errorElement);
    dateFormatSelect.disabled = true;
    try {
      await api.put('/preferences', { date_format: dateFormatSelect.value });
      safeStorageSet('oikos-date-format', dateFormatSelect.value);
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: dateFormatSelect.value },
      }));
      syncRegionSelect(container);
      window.oikos?.showToast(t('settings.dateFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      dateFormatSelect.disabled = false;
    }
  });

  const timeFormatSelect = container.querySelector('#time-format-select');
  timeFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#time-format-error');
    clearError(errorElement);
    timeFormatSelect.disabled = true;
    try {
      await api.put('/preferences', { time_format: timeFormatSelect.value });
      safeStorageSet('oikos-time-format', timeFormatSelect.value);
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: timeFormatSelect.value },
      }));
      syncRegionSelect(container);
      window.oikos?.showToast(t('settings.timeFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      timeFormatSelect.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  try {
    const response = await api.get('/preferences');
    const preferences = {
      currency: response?.data?.currency || 'EUR',
      date_format: response?.data?.date_format || 'dmy',
      time_format: response?.data?.time_format || '24h',
    };

    safeStorageSet('oikos-date-format', preferences.date_format);
    safeStorageSet('oikos-time-format', preferences.time_format);
    const isAdmin = user?.role === 'admin';
    renderPage(container, preferences, isAdmin);
    if (isAdmin) {
      appendCurrencyOptions(container.querySelector('#currency-select'), preferences.currency);
    }
    bindEvents(container, user);
    window.lucide?.createIcons({ el: container });
  } catch {
    renderLoadError(container);
    container.querySelector('#appearance-retry')?.addEventListener('click', () => {
      render(container, { user });
    });
  }
}
