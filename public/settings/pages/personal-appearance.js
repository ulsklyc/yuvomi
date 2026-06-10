import { api } from '/api.js';
import {
  getLocale,
  getSupportedLocales,
  setLocale,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';

const DATE_FORMATS = [
  ['mdy', 'MM/DD/YYYY'],
  ['dmy', 'DD.MM.YYYY'],
  ['dmy_slash', 'DD/MM/YYYY'],
  ['ymd', 'YYYY-MM-DD'],
  ['mdy_dot', 'MM.DD.YYYY'],
  ['ymd_dot', 'YYYY.MM.DD'],
  ['ymd_slash', 'YYYY/MM/DD'],
];

function currentTheme() {
  return localStorage.getItem('oikos-theme') || 'system';
}

function formatOptions(selected) {
  return DATE_FORMATS.map(([value, label]) => (
    `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`
  )).join('');
}

function localeLabel(locale) {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(locale) || locale;
  } catch {
    return locale;
  }
}

function localeOptions() {
  const storedLocale = localStorage.getItem('oikos-locale');
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
    <header class="settings-leaf-header">
      <h1 class="settings-leaf-header__title">${t('settings.pageAppearance')}</h1>
      <p class="settings-leaf-header__description">${t('settings.pageAppearanceDescription')}</p>
    </header>
    <div class="settings-card settings-card--appearance">
      <p class="form-error">${t('settings.loadError')}</p>
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" id="appearance-retry">${t('settings.retry')}</button>
      </div>
    </div>
  `);
}

function renderPage(container, preferences) {
  const theme = currentTheme();
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <header class="settings-leaf-header">
      <h1 class="settings-leaf-header__title">${t('settings.pageAppearance')}</h1>
      <p class="settings-leaf-header__description">${t('settings.pageAppearanceDescription')}</p>
    </header>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionDesign')}</h2>
      <div class="settings-card settings-card--appearance">
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
      <div class="settings-card settings-card--language">
        <div class="form-group">
          <label class="form-label" for="locale-select">${t('settings.localeLabel')}</label>
          <select class="form-input locale-picker__select" id="locale-select">
            ${localeOptions()}
          </select>
        </div>
        <div id="locale-error" class="form-error" hidden></div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionDate')}</h2>
      <div class="settings-card settings-card--datetime">
        <h3 class="settings-card__title">${t('settings.dateFormatTitle')}</h3>
        <p class="form-hint">${t('settings.dateFormatHint')}</p>
        <div class="form-group">
          <label class="form-label" for="date-format-select">${t('settings.dateFormatLabel')}</label>
          <select class="form-input" id="date-format-select">
            ${formatOptions(preferences.date_format)}
          </select>
        </div>
        <div id="date-format-error" class="form-error" hidden></div>
        <div class="form-group">
          <label class="form-label" for="time-format-select">${t('settings.timeFormatLabel')}</label>
          <select class="form-input" id="time-format-select">
            <option value="24h"${preferences.time_format === '24h' ? ' selected' : ''}>24 ${t('settings.timeFormatHours')}</option>
            <option value="12h"${preferences.time_format === '12h' ? ' selected' : ''}>AM/PM</option>
          </select>
        </div>
        <div id="time-format-error" class="form-error" hidden></div>
      </div>
    </section>
  `);
}

function applyTheme(value) {
  if (window.oikos?.applyTheme) {
    window.oikos.applyTheme(value);
    return;
  }

  localStorage.setItem('oikos-theme', value);
  if (value === 'dark' || value === 'light') {
    document.documentElement.setAttribute('data-theme', value);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function bindEvents(container) {
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
        localStorage.removeItem('oikos-locale');
        location.reload();
        return;
      }
      await setLocale(localeSelect.value);
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      localeSelect.disabled = false;
    }
  });

  const dateFormatSelect = container.querySelector('#date-format-select');
  dateFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#date-format-error');
    clearError(errorElement);
    dateFormatSelect.disabled = true;
    try {
      await api.put('/preferences', { date_format: dateFormatSelect.value });
      localStorage.setItem('oikos-date-format', dateFormatSelect.value);
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: dateFormatSelect.value },
      }));
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
      localStorage.setItem('oikos-time-format', timeFormatSelect.value);
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: timeFormatSelect.value },
      }));
      window.oikos?.showToast(t('settings.timeFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      timeFormatSelect.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  void user;
  try {
    const response = await api.get('/preferences');
    const preferences = {
      date_format: response?.data?.date_format || 'dmy',
      time_format: response?.data?.time_format || '24h',
    };

    localStorage.setItem('oikos-date-format', preferences.date_format);
    localStorage.setItem('oikos-time-format', preferences.time_format);
    renderPage(container, preferences);
    bindEvents(container);
    window.lucide?.createIcons({ el: container });
  } catch {
    renderLoadError(container);
    container.querySelector('#appearance-retry')?.addEventListener('click', () => {
      render(container, { user });
    });
  }
}
