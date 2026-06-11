/**
 * Modul: Einstellungen (Settings)
 * Zweck: Benutzerkonto, Passwort, Kalender-Sync, Kontakte-Sync, Familienmitglieder
 * Abhängigkeiten: /api.js, /utils/settings-nav.js
 */

import { api, auth } from '/api.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { t, formatDate, formatTime, dateInputPlaceholder, formatDateInput, parseDateInput, isDateInputValid, getDateFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSettingsSidebar, renderBreadcrumb, getLastActivePage, setActivePage, findSectionAndPage } from '/utils/settings-nav.js';
import { renderSubTabs } from '/utils/sub-tabs.js';
import '/components/oikos-locale-picker.js';
import { getPwaInstallState, onPwaInstallStateChanged, promptPwaInstall } from '/utils/pwa-install.js';

const SUPPORTED_CURRENCIES = ['AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HUF', 'INR', 'JPY', 'KZT', 'NOK', 'PLN', 'RUB', 'SAR', 'SEK', 'TRY', 'UAH', 'USD', 'VND'];
const SETTINGS_TAB_KEY = 'oikos:settings:tab';
const APP_NAME_STORAGE_KEY = 'oikos-app-name';
const DEFAULT_APP_NAME = 'Yuvomi';
const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];
const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];
const randomAvatarColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
const MAX_AVATAR_DATA_LENGTH = 768 * 1024;
const BUILT_IN_MODULES = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'layout-dashboard', locked: true },
  { id: 'calendar', labelKey: 'nav.calendar', icon: 'calendar' },
  { id: 'tasks', labelKey: 'nav.tasks', icon: 'check-square' },
  { id: 'notes', labelKey: 'nav.notes', icon: 'sticky-note' },
  { id: 'birthdays', labelKey: 'nav.birthdays', icon: 'cake' },
  { id: 'contacts', labelKey: 'nav.contacts', icon: 'book-user' },
  { id: 'budget', labelKey: 'nav.budget', icon: 'wallet' },
  { id: 'documents', labelKey: 'nav.documents', icon: 'folder-lock' },
  { id: 'housekeeping', labelKey: 'nav.housekeeping', icon: 'paintbrush' },
  { id: 'meals', labelKey: 'nav.meals', icon: 'utensils' },
  { id: 'recipes', labelKey: 'nav.recipes', icon: 'book-text' },
  { id: 'shopping', labelKey: 'nav.shopping', icon: 'shopping-cart' },
];

const CATEGORY_I18N = {
  'Obst & Gemüse': 'shopping.catFruitVeg',
  'Backwaren': 'shopping.catBakery',
  'Milchprodukte': 'shopping.catDairy',
  'Fleisch & Fisch': 'shopping.catMeatFish',
  'Tiefkühl': 'shopping.catFrozen',
  'Getränke': 'shopping.catDrinks',
  'Haushalt': 'shopping.catHousehold',
  'Drogerie': 'shopping.catDrugstore',
  'Sonstiges': 'shopping.catMisc',
};
function catLabel(name) {
  const key = CATEGORY_I18N[name];
  return key ? t(key) : name;
}

function buildCurrencyOptions(selected) {
  const display = typeof Intl.DisplayNames !== 'undefined'
    ? new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'currency' })
    : null;
  return SUPPORTED_CURRENCIES
    .map((code) => {
      const label = display ? `${code} - ${display.of(code)}` : code;
      const sel = code === selected ? ' selected' : '';
      return `<option value="${code}"${sel}>${label}</option>`;
    })
    .join('');
}

function familyRoleLabel(role) {
  return t(`settings.familyRole${String(role || 'other').replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`);
}

function buildFamilyRoleOptions(selected = 'other') {
  return FAMILY_ROLES.map((role) => `
    <option value="${role}"${role === selected ? ' selected' : ''}>${familyRoleLabel(role)}</option>
  `).join('');
}

function maskDateInputValue(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  if (!digits) return '';

  if (getDateFormat() === 'ymd') {
    return [
      digits.slice(0, 4),
      digits.slice(4, 6),
      digits.slice(6, 8),
    ].filter(Boolean).join('-');
  }

  return [
    digits.slice(0, 2),
    digits.slice(2, 4),
    digits.slice(4, 8),
  ].filter(Boolean).join('/');
}

function bindSettingsDateInputs(root) {
  root.querySelectorAll('.js-date-input').forEach((input) => {
    input.addEventListener('input', () => {
      input.value = maskDateInputValue(input.value);
    });
    input.addEventListener('blur', () => {
      const parsed = parseDateInput(input.value);
      if (parsed) input.value = formatDateInput(parsed);
    });
  });
}

function avatarHtml(user, className = 'settings-avatar') {
  const safeName = esc(user?.display_name || '');
  const fallback = esc(initials(user?.display_name || ''));
  const bg = esc(user?.avatar_color || '#007AFF');
  return `
    <div class="${className}" style="background:${bg}" title="${safeName}">
      ${user?.avatar_data ? `<img src="${esc(user.avatar_data)}" alt="${safeName}" loading="lazy">` : fallback}
    </div>
  `;
}

function avatarEditorHtml(user, prefix) {
  return `
    <div class="settings-avatar-editor">
      <button type="button" class="settings-avatar-button" id="${prefix}-avatar-preview" aria-label="${t('settings.profilePictureLabel')}">
        ${avatarHtml(user, 'settings-avatar settings-avatar--lg')}
      </button>
      <input class="sr-only" type="file" id="${prefix}-avatar-file" accept="image/png,image/jpeg,image/webp" />
      <div class="settings-avatar-actions">
        <button type="button" class="settings-avatar-action" id="${prefix}-avatar-edit" aria-label="${t('settings.profilePictureLabel')}" title="${t('settings.profilePictureLabel')}">
          <i data-lucide="edit-2" aria-hidden="true"></i>
        </button>
        <button type="button" class="settings-avatar-action settings-avatar-action--danger" id="${prefix}-avatar-remove" aria-label="${t('settings.profilePictureRemove')}" title="${t('settings.profilePictureRemove')}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;
}

function setAvatarPreview(container, selector, user) {
  const preview = container.querySelector(selector);
  if (!preview) return;
  preview.replaceChildren();
  preview.insertAdjacentHTML('beforeend', avatarHtml(user, 'settings-avatar settings-avatar--lg'));
}

function bindAvatarPicker(container, prefix) {
  const fileInput = container.querySelector(`#${prefix}-avatar-file`);
  const pickers = [
    container.querySelector(`#${prefix}-avatar-preview`),
    container.querySelector(`#${prefix}-avatar-edit`),
  ];
  pickers.forEach((picker) => {
    picker?.addEventListener('click', () => fileInput?.click());
  });
}

async function readImageAsDataUrl(file) {
  if (!file) return undefined;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error(t('settings.profilePictureTypeError'));
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error(t('settings.profilePictureFileTooLarge'));
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(t('settings.profilePictureReadError')));
    reader.readAsDataURL(file);
  });

  const { openCropDialog } = await import('/utils/avatar-crop.js');
  const cropped = await openCropDialog(dataUrl);
  if (cropped === null) return undefined;

  if (cropped.length > MAX_AVATAR_DATA_LENGTH) {
    throw new Error(t('settings.profilePictureTooLarge'));
  }
  return cropped;
}

/**
 * @param {HTMLElement} container
 * @param {{ user: object }} context
 */
export async function render(container, { user }) {
  try {
    const me = await auth.me();
    if (me?.user && user) Object.assign(user, me.user);
    else if (me?.user) user = me.user;
  } catch {
    // Non-critical: render with the user object provided by the router.
  }

  // URL-Parameter auswerten (z.B. nach OAuth-Callback)
  const params   = new URLSearchParams(location.search);
  const syncOk   = params.get('sync_ok');
  const syncErr  = params.get('sync_error');

  // State für Familienmitglieder + Sync-Status
  let users           = [];
  let googleStatus    = { configured: false, connected: false, lastSync: null };
  let appleStatus     = { configured: false, lastSync: null };
  let prefs           = { visible_meal_types: ['breakfast', 'lunch', 'dinner', 'snack'], currency: 'EUR', date_format: 'mdy', time_format: '24h', app_name: DEFAULT_APP_NAME, disabled_modules: [], module_order: [], housekeeping_payment_tasks: false, weather_provider: null, weather_lat: null, weather_lon: null, weather_city: '', weather_units: 'metric' };
  let categories      = [];
  let icsSubscriptions = [];
  let apiTokens       = [];
  let thirdPartyModules = [];
  let dmsAccounts       = [];

  try {
    const [usersRes, gStatus, aStatus, prefsRes, catsRes, icsRes, apiTokensRes, modulesRes, dmsRes] = await Promise.allSettled([
      user.role === 'admin' ? auth.getUsers() : Promise.resolve({ data: [] }),
      api.get('/calendar/google/status'),
      api.get('/calendar/apple/status'),
      api.get('/preferences'),
      api.get('/shopping/categories'),
      api.get('/calendar/subscriptions'),
      user.role === 'admin' ? api.get('/auth/api-tokens') : Promise.resolve({ data: [] }),
      user.role === 'admin' ? api.get('/modules?admin=1') : Promise.resolve({ data: [] }),
      user.role === 'admin' ? api.get('/documents/dms/accounts') : Promise.resolve({ data: [] }),
    ]);
    if (usersRes.status === 'fulfilled')  users            = usersRes.value.data  ?? [];
    if (gStatus.status  === 'fulfilled')  googleStatus     = gStatus.value;
    if (aStatus.status  === 'fulfilled')  appleStatus      = aStatus.value;
    if (prefsRes.status === 'fulfilled')  prefs            = prefsRes.value.data  ?? prefs;
    if (catsRes.status  === 'fulfilled')  categories       = catsRes.value.data   ?? [];
    if (icsRes.status   === 'fulfilled')  icsSubscriptions = icsRes.value.data    ?? [];
    if (apiTokensRes.status === 'fulfilled') apiTokens     = apiTokensRes.value.data ?? [];
    if (modulesRes.status === 'fulfilled') thirdPartyModules = modulesRes.value.data ?? [];
    if (dmsRes.status   === 'fulfilled')  dmsAccounts      = dmsRes.value.data    ?? [];
  } catch (_) { /* non-critical */ }

  if (prefs.date_format) {
    try { localStorage.setItem('oikos-date-format', prefs.date_format); } catch (_) {}
  }
  if (prefs.time_format) {
    try { localStorage.setItem('oikos-time-format', prefs.time_format); } catch (_) {}
  }
  if (prefs.app_name) {
    try { localStorage.setItem(APP_NAME_STORAGE_KEY, prefs.app_name); } catch (_) {}
  }

  const googleStatusText = googleStatus.connected
    ? (googleStatus.lastSync ? t('settings.connectedLastSync', { date: formatDateTime(googleStatus.lastSync) }) : t('settings.connected'))
    : googleStatus.configured ? t('settings.notConnected') : t('settings.notConfigured');

  const appleStatusText = appleStatus.connected
    ? (appleStatus.lastSync ? t('settings.connectedLastSync', { date: formatDateTime(appleStatus.lastSync) }) : t('settings.connected'))
    : appleStatus.configured
      ? (appleStatus.lastSync ? t('settings.configuredLastSync', { date: formatDateTime(appleStatus.lastSync) }) : t('settings.configured'))
      : t('settings.notConnected');

  const allowedTabs = [
    'general', 'meals', 'budget', 'shopping', 'calendar', 'sync',
    ...(user?.role === 'admin' ? ['family', 'api-tokens'] : []),
    'account',
    ...(user?.role === 'admin' ? ['backup'] : []),
  ];
  const storedTab = sessionStorage.getItem(SETTINGS_TAB_KEY) ?? 'general';
  const activeTab = (syncOk || syncErr)
    ? 'sync'
    : (allowedTabs.includes(storedTab) ? storedTab : 'general');

  const panelHidden = (id) => id === activeTab ? '' : ' hidden';

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="page settings-page">
      <div class="page__header">
        <h1 class="page__title">${t('settings.title')}</h1>
      </div>

      ${syncOk  ? `<div class="settings-banner settings-banner--success">${syncOk === 'google' ? t('settings.syncSuccessGoogle') : t('settings.syncSuccessApple')}</div>` : ''}
      ${syncErr ? `<div class="settings-banner settings-banner--error">${syncErr === 'google' ? t('settings.syncErrorGoogle') : t('settings.syncErrorApple')}</div>` : ''}

      <!-- Panel: Allgemein (Design + Sprache) -->
      <div class="settings-tab-panel" data-panel="general" role="tabpanel"${panelHidden('general')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionDesign')}</h2>
          <div class="settings-card settings-card--appearance">
            <h3 class="settings-card__title">${t('settings.cardAppearance')}</h3>
            <div class="theme-toggle" id="theme-toggle">
              <button class="theme-toggle__btn ${currentTheme() === 'system' ? 'theme-toggle__btn--active' : ''}" data-theme-value="system" aria-label="${t('settings.themeSysLabel')}" aria-pressed="${currentTheme() === 'system' ? 'true' : 'false'}">
                <i data-lucide="monitor" class="icon-md" aria-hidden="true"></i>
                ${t('settings.themeSystem')}
              </button>
              <button class="theme-toggle__btn ${currentTheme() === 'light' ? 'theme-toggle__btn--active' : ''}" data-theme-value="light" aria-label="${t('settings.themeLightLabel')}" aria-pressed="${currentTheme() === 'light' ? 'true' : 'false'}">
                <i data-lucide="sun" class="icon-md" aria-hidden="true"></i>
                ${t('settings.themeLight')}
              </button>
              <button class="theme-toggle__btn ${currentTheme() === 'dark' ? 'theme-toggle__btn--active' : ''}" data-theme-value="dark" aria-label="${t('settings.themeDarkLabel')}" aria-pressed="${currentTheme() === 'dark' ? 'true' : 'false'}">
                <i data-lucide="moon" class="icon-md" aria-hidden="true"></i>
                ${t('settings.themeDark')}
              </button>
            </div>
          </div>
        </section>

        ${user?.role === 'admin' ? `
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionAppName')}</h2>
          <div class="settings-card settings-card--app-name">
            <h3 class="settings-card__title">${t('settings.appNameTitle')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.appNameHint')}</p>
            <form class="settings-form settings-form--compact" id="app-name-form" novalidate autocomplete="off">
              <div class="form-group">
                <label class="form-label" for="app-name-input">${t('settings.appNameLabel')}</label>
                <input
                  class="form-input"
                  type="text"
                  id="app-name-input"
                  maxlength="60"
                  placeholder="${t('settings.appNamePlaceholder')}"
                  value="${esc(prefs.app_name || DEFAULT_APP_NAME)}"
                />
              </div>
              <div id="app-name-error" class="form-error" hidden></div>
              <div class="settings-form-actions">
                <button type="submit" class="btn btn--primary">${t('common.save')}</button>
                <button type="button" class="btn btn--secondary" id="app-name-reset-btn">${t('common.reset')}</button>
              </div>
            </form>
          </div>
        </section>
        ` : ''}

        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionDate')}</h2>
          <div class="settings-card settings-card--datetime">
            <h3 class="settings-card__title">${t('settings.dateFormatTitle')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.dateFormatHint')}</p>
            <label class="form-label" for="date-format-select">${t('settings.dateFormatLabel')}</label>
            <select class="form-input" id="date-format-select">
              <option value="mdy"${prefs.date_format === 'mdy' ? ' selected' : ''}>MM/DD/YYYY</option>
              <option value="dmy"${prefs.date_format === 'dmy' ? ' selected' : ''}>DD.MM.YYYY</option>
              <option value="dmy_slash"${prefs.date_format === 'dmy_slash' ? ' selected' : ''}>DD/MM/YYYY</option>
              <option value="ymd"${prefs.date_format === 'ymd' ? ' selected' : ''}>YYYY-MM-DD</option>
              <option value="mdy_dot"${prefs.date_format === 'mdy_dot' ? ' selected' : ''}>MM.DD.YYYY</option>
              <option value="ymd_dot"${prefs.date_format === 'ymd_dot' ? ' selected' : ''}>YYYY.MM.DD</option>
              <option value="ymd_slash"${prefs.date_format === 'ymd_slash' ? ' selected' : ''}>YYYY/MM/DD</option>
            </select>
            <label class="form-label" for="time-format-select" style="margin-top:var(--space-3)">${t('settings.timeFormatLabel')}</label>
            <select class="form-input" id="time-format-select">
              <option value="24h"${prefs.time_format === '24h' ? ' selected' : ''}>24 ${t('settings.timeFormatHours')}</option>
              <option value="12h"${prefs.time_format === '12h' ? ' selected' : ''}>AM/PM</option>
            </select>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.languageTitle')}</h2>
          <div class="settings-card settings-card--language">
            <oikos-locale-picker></oikos-locale-picker>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionPwa')}</h2>
          <div class="settings-card settings-card--pwa settings-pwa-card">
            <div class="settings-pwa-card__icon">
              <i data-lucide="smartphone" aria-hidden="true"></i>
            </div>
            <div class="settings-pwa-card__body">
              <h3 class="settings-card__title">${t('settings.pwaInstallTitle')}</h3>
              <p class="form-hint" id="pwa-install-status" style="margin-bottom:var(--space-3)">${t('settings.pwaInstallChecking')}</p>
              <div class="settings-form-actions">
                <button type="button" class="btn btn--primary" id="pwa-install-btn">
                  <i data-lucide="download" aria-hidden="true"></i>
                  <span>${t('settings.pwaInstallButton')}</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        ${user?.role === 'admin' ? `
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionHousekeeping')}</h2>
          <div class="settings-card settings-card--housekeeping">
            <h3 class="settings-card__title">${t('settings.housekeepingPaymentsTitle')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.housekeepingPaymentTasksHint')}</p>
            <label class="toggle-row">
              <input type="checkbox" id="housekeeping-payment-tasks" ${prefs.housekeeping_payment_tasks ? 'checked' : ''}>
              <span>${t('settings.housekeepingPaymentTasksLabel')}</span>
            </label>
          </div>
        </section>
        ` : ''}

        ${user?.role === 'admin' ? `
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionModules')}</h2>
          <div class="settings-card settings-card--modules">
            <h3 class="settings-card__title">${t('settings.modulesTitle')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.modulesHint')}</p>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.modulesDragHint')}</p>
            <div class="settings-modules-list settings-modules-list--sortable" id="module-toggles">
              ${activeModuleRowsHtml(prefs, thirdPartyModules)}
            </div>
          </div>
        </section>
        ` : ''}

        ${user?.role === 'admin' ? `
        <section class="settings-section" id="weather-section">
          <h2 class="settings-section__title">${t('settings.sectionWeather')}</h2>
          <div class="settings-card" id="weather-card">
            <h3 class="settings-card__title">${t('settings.weatherTitle')}</h3>
            <p class="settings-card-description">${t('settings.weatherDescription')}</p>

            <div class="settings-sync-info" style="margin-bottom:var(--space-3)">
              <span class="form-label">${t('settings.weatherActiveProvider')}</span>
              <span id="weather-provider-status" class="settings-sync-info__status ${prefs.weather_provider === 'open-meteo' ? 'settings-sync-info__status--connected' : ''}">
                ${prefs.weather_provider === 'open-meteo'
                  ? t('settings.weatherProviderOpenMeteo')
                  : prefs.weather_provider === 'openweathermap'
                    ? t('settings.weatherProviderOwm')
                    : t('settings.weatherProviderNone')}
              </span>
            </div>

            <form class="settings-form settings-form--compact" id="weather-form" novalidate autocomplete="off">
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label" for="weather-lat">${t('settings.weatherLatLabel')}</label>
                  <input class="form-input" type="number" id="weather-lat" step="any" min="-90" max="90"
                    value="${esc(prefs.weather_lat ?? '')}"
                    placeholder="${t('settings.weatherLatPlaceholder')}" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="weather-lon">${t('settings.weatherLonLabel')}</label>
                  <input class="form-input" type="number" id="weather-lon" step="any" min="-180" max="180"
                    value="${esc(prefs.weather_lon ?? '')}"
                    placeholder="${t('settings.weatherLonPlaceholder')}" />
                </div>
              </div>
              <div style="margin-bottom:var(--space-3)">
                <button type="button" class="btn btn--secondary btn--sm" id="weather-locate-btn">
                  <i data-lucide="map-pin" aria-hidden="true"></i>
                  ${t('settings.weatherLocateBtn')}
                </button>
              </div>
              <div class="form-group">
                <label class="form-label" for="weather-city">${t('settings.weatherCityLabel')}</label>
                <input class="form-input" type="text" id="weather-city" maxlength="100"
                  value="${esc(prefs.weather_city ?? '')}"
                  placeholder="${t('settings.weatherCityPlaceholder')}" />
              </div>
              <div class="form-group">
                <label class="form-label" for="weather-units">${t('settings.weatherUnitsLabel')}</label>
                <select class="form-input" id="weather-units">
                  <option value="metric"${(prefs.weather_units ?? 'metric') === 'metric' ? ' selected' : ''}>${t('settings.weatherUnitsMetric')}</option>
                  <option value="imperial"${prefs.weather_units === 'imperial' ? ' selected' : ''}>${t('settings.weatherUnitsImperial')}</option>
                </select>
              </div>
              <p class="form-hint">${t('settings.weatherCoordHint')}</p>
              <p class="form-hint">${t('settings.weatherSwitchHint')}</p>
              <div id="weather-form-error" class="form-error" hidden></div>
              <div class="settings-form-actions">
                <button type="submit" class="btn btn--primary">${t('settings.weatherSave')}</button>
                ${prefs.weather_provider === 'open-meteo' ? `
                  <button type="button" class="btn btn--danger" id="weather-remove-btn">${t('settings.weatherRemove')}</button>
                ` : ''}
              </div>
            </form>
          </div>
        </section>
        ` : ''}

        ${user?.role === 'admin' ? `
        <section class="settings-section" id="documents-section">
          <h2 class="settings-section__title">${t('settings.sectionDocuments')}</h2>
          <div class="settings-card settings-card--document-storage" id="document-storage-card">
            <h3 class="settings-card__title">${t('settings.documentStorageTitle')}</h3>
            <p class="settings-card-description">${t('settings.documentStorageDescription')}</p>
            <form class="settings-form settings-form--compact" id="document-storage-form" novalidate autocomplete="off">
              <div class="settings-webdav-toggle-row">
                <label class="toggle-row">
                  <input type="checkbox" id="document-storage-enabled" name="enabled" />
                  <span>${t('settings.documentStorageEnabled')}</span>
                </label>
              </div>
              <div class="form-group">
                <label class="form-label" for="document-storage-url">${t('settings.documentStorageUrl')}</label>
                <input class="form-input" type="url" id="document-storage-url" name="url" placeholder="https://..." />
                <span class="form-hint" data-env-hint="url" hidden>${t('settings.documentStorageEnvHint')}</span>
              </div>
              <div class="form-group">
                <label class="form-label" for="document-storage-username">${t('settings.documentStorageUsername')}</label>
                <input class="form-input" type="text" id="document-storage-username" name="username" autocomplete="username" />
                <span class="form-hint" data-env-hint="username" hidden>${t('settings.documentStorageEnvHint')}</span>
              </div>
              <div class="form-group">
                <label class="form-label" for="document-storage-password">${t('settings.documentStoragePassword')}</label>
                <div class="settings-webdav-pw-wrap">
                  <input class="form-input" type="password" id="document-storage-password" name="password"
                    autocomplete="new-password" placeholder="${t('settings.documentStoragePasswordPlaceholder')}" />
                  <button type="button" class="btn btn--icon btn--ghost settings-webdav-reveal-btn"
                    data-reveal-target="document-storage-password" aria-label="${t('common.togglePasswordVisibility')}">
                    <i data-lucide="eye" aria-hidden="true"></i>
                  </button>
                </div>
                <span class="form-hint" data-env-hint="password" hidden>${t('settings.documentStorageEnvHint')}</span>
              </div>
              <div class="form-group">
                <label class="form-label" for="document-storage-path">${t('settings.documentStoragePath')}</label>
                <input class="form-input" type="text" id="document-storage-path" name="path" />
                <span class="form-hint" data-env-hint="path" hidden>${t('settings.documentStorageEnvHint')}</span>
              </div>
              <div class="form-hint" data-env-hint="enabled" hidden>${t('settings.documentStorageEnvHint')}</div>
              <div id="document-storage-test-result" class="form-hint" hidden></div>
              <div class="settings-form-actions">
                <button type="button" class="btn btn--secondary" id="document-storage-test-btn">
                  <i data-lucide="plug-zap" aria-hidden="true"></i>
                  ${t('settings.documentStorageTest')}
                </button>
                <button type="submit" class="btn btn--primary" id="document-storage-save-btn">
                  ${t('settings.documentStorageSave')}
                </button>
              </div>
            </form>
            <div class="settings-info-grid document-storage-status" id="document-storage-status"></div>
            <p class="settings-document-storage-warning">
              <i data-lucide="triangle-alert" aria-hidden="true"></i>
              <span>${t('settings.documentStorageBackupWarning')}</span>
            </p>
          </div>

          <div class="settings-card settings-card--document-storage" id="dms-card">
            <h3 class="settings-card__title">${t('settings.dmsTitle')}</h3>
            <p class="settings-card-description">${t('settings.dmsDescription')}</p>
            <ul class="dms-account-list" id="dms-account-list"></ul>
            <form class="settings-form settings-form--compact" id="dms-form" novalidate autocomplete="off">
              <div class="form-group">
                <label class="form-label" for="dms-name">${t('settings.dmsName')}</label>
                <input class="form-input" type="text" id="dms-name" maxlength="100" required />
              </div>
              <div class="form-group">
                <label class="form-label" for="dms-url">${t('settings.dmsBaseUrl')}</label>
                <input class="form-input" type="url" id="dms-url" required placeholder="https://..." />
              </div>
              <div class="form-group">
                <label class="form-label" for="dms-token">${t('settings.dmsToken')}</label>
                <input class="form-input" type="password" id="dms-token" required autocomplete="new-password" />
              </div>
              <div id="dms-form-error" class="form-error" hidden></div>
              <div class="settings-form-actions">
                <button type="submit" class="btn btn--primary">${t('settings.dmsAddBtn')}</button>
              </div>
            </form>
          </div>
        </section>
        ` : ''}
      </div>

      <!-- Panel: Mahlzeiten -->
      <div class="settings-tab-panel" data-panel="meals" role="tabpanel"${panelHidden('meals')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionMeals')}</h2>
          <div class="settings-card">
            <h3 class="settings-card__title">${t('settings.mealTypesLabel')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.mealTypesHint')}</p>
            <div class="meal-type-toggles" id="meal-type-toggles">
              <label class="toggle-row">
                <input type="checkbox" value="breakfast" checked>
                <span>${t('meals.typeBreakfast')}</span>
              </label>
              <label class="toggle-row">
                <input type="checkbox" value="lunch" checked>
                <span>${t('meals.typeLunch')}</span>
              </label>
              <label class="toggle-row">
                <input type="checkbox" value="dinner" checked>
                <span>${t('meals.typeDinner')}</span>
              </label>
              <label class="toggle-row">
                <input type="checkbox" value="snack" checked>
                <span>${t('meals.typeSnack')}</span>
              </label>
            </div>
          </div>
        </section>
      </div>

      <!-- Panel: Budget -->
      <div class="settings-tab-panel" data-panel="budget" role="tabpanel"${panelHidden('budget')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionBudget')}</h2>
          <div class="settings-card">
            <h3 class="settings-card__title">${t('settings.currencyLabel')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.currencyHint')}</p>
            <select class="form-input" id="currency-select">
              ${buildCurrencyOptions(prefs.currency)}
            </select>
          </div>
        </section>
      </div>

      <!-- Panel: Einkauf -->
      <div class="settings-tab-panel" data-panel="shopping" role="tabpanel"${panelHidden('shopping')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionShopping')}</h2>
          <div class="settings-card">
            <h3 class="settings-card__title">${t('settings.shoppingCategoriesLabel')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.shoppingCategoriesHint')}</p>
            <ul class="cat-list" id="cat-list">
              ${categories.map((c, i) => categoryRowHtml(c, i === 0, i === categories.length - 1)).join('')}
            </ul>
            <form class="cat-add-form" id="cat-add-form" novalidate autocomplete="off">
              <input class="form-input" type="text" id="cat-add-input"
                     placeholder="${t('settings.shoppingCategoryPlaceholder')}"
                     maxlength="60" />
              <button type="submit" class="btn btn--primary">${t('common.add')}</button>
            </form>
          </div>
        </section>
      </div>

      <!-- Panel: Kalender -->
      <div class="settings-tab-panel" data-panel="calendar" role="tabpanel"
        data-holiday-country="${esc(prefs.holiday_country ?? '')}"
        data-holiday-subdivision="${esc(prefs.holiday_subdivision ?? '')}"
        ${panelHidden('calendar')}>
        ${user?.role === 'admin' ? `
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionHolidays')}</h2>
          <div class="settings-card" id="holidays-card">
            <h3 class="settings-card__title">${t('settings.holidayTitle')}</h3>
            <p class="settings-card-description">${t('settings.holidayDescription')}</p>

            <form class="settings-form settings-form--compact" id="holidays-form" novalidate autocomplete="off">
              <div class="form-group">
                <label class="form-label" for="holiday-country">${t('settings.holidayCountryLabel')}</label>
                <select class="form-input" id="holiday-country">
                  <option value="">${t('settings.holidayCountryPlaceholder')}</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for="holiday-subdivision">${t('settings.holidaySubdivisionLabel')}</label>
                <select class="form-input" id="holiday-subdivision" disabled>
                  <option value="">${t('settings.holidaySubdivisionNone')}</option>
                </select>
              </div>
              <div class="form-group">
                <label class="toggle-row">
                  <input type="checkbox" id="holiday-show-public" ${prefs.holiday_show_public ? 'checked' : ''}>
                  <span>${t('settings.holidayPublicLabel')}</span>
                </label>
              </div>
              <div class="form-group" id="holiday-public-color-group" ${!prefs.holiday_show_public ? 'hidden' : ''}>
                <label class="form-label" for="holiday-public-color">${t('settings.holidayPublicColor')}</label>
                <input class="form-input" type="color" id="holiday-public-color"
                  value="${esc(prefs.holiday_public_color ?? '#FF3B30')}" />
              </div>
              <div class="form-group">
                <label class="toggle-row">
                  <input type="checkbox" id="holiday-show-school" ${prefs.holiday_show_school ? 'checked' : ''}>
                  <span>${t('settings.holidaySchoolLabel')}</span>
                </label>
              </div>
              <div class="form-group" id="holiday-school-color-group" ${!prefs.holiday_show_school ? 'hidden' : ''}>
                <label class="form-label" for="holiday-school-color">${t('settings.holidaySchoolColor')}</label>
                <input class="form-input" type="color" id="holiday-school-color"
                  value="${esc(prefs.holiday_school_color ?? '#34C759')}" />
              </div>
              <div id="holidays-form-error" class="form-error" hidden></div>
              <div class="settings-form-actions">
                <button type="submit" class="btn btn--primary">${t('settings.holidaySaveBtn')}</button>
              </div>
            </form>

            <div class="settings-sync-info" style="margin-top:var(--space-4)">
              <span class="form-label" id="holiday-last-sync-label">
                ${prefs.holiday_last_sync
                  ? t('settings.holidayLastSync', { date: new Date(prefs.holiday_last_sync).toLocaleString() })
                  : t('settings.holidayNeverSynced')}
              </span>
              <button type="button" class="btn btn--secondary btn--sm" id="holiday-sync-btn"
                ${!prefs.holiday_country ? 'disabled title="' + t('settings.holidayCountryRequired') + '"' : ''}>
                <i data-lucide="refresh-cw" aria-hidden="true"></i>
                ${t('settings.holidaySyncBtn')}
              </button>
            </div>
          </div>
        </section>
        ` : '<p class="form-hint" style="padding:var(--space-4)">' + t('settings.adminOnly') + '</p>'}
      </div>

      <!-- Panel: Synchronisation -->
      <div class="settings-tab-panel" data-panel="sync" role="tabpanel"${panelHidden('sync')}>

        <!-- Sektion: Offene Standards (CalDAV · CardDAV · ICS) -->
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionOpenStandards')}</h2>

          <!-- CalDAV Kalender -->
          <div class="settings-card">
            <h3 class="settings-card__title">${t('settings.caldavTitle')}</h3>
            <p class="settings-card-description">${t('settings.caldavDescription')}</p>

            <div id="caldav-accounts-list"></div>
            <div id="caldav-empty-state" class="caldav-empty-state" style="display: none;">
              <p>${t('settings.caldavEmptyState')}</p>
            </div>

            ${user?.role === 'admin' ? `
              <button class="btn btn--primary" id="caldav-add-account-btn">
                ${t('settings.caldavAddAccount')}
              </button>
            ` : ''}
          </div>

          <!-- CardDAV Kontakte -->
          <div class="settings-card">
            <h3 class="settings-card__title">${t('settings.cardavTitle')}</h3>
            <p class="settings-card-description">${t('settings.cardavDescription')}</p>

            <div id="cardav-accounts-list"></div>
            <div id="cardav-empty-state" class="caldav-empty-state" style="display: none;">
              <p>${t('settings.cardavEmptyState')}</p>
            </div>

            ${user?.role === 'admin' ? `
              <button class="btn btn--primary" id="cardav-add-account-btn">
                ${t('settings.cardavAddAccount')}
              </button>
            ` : ''}
          </div>

          <!-- ICS-Abonnements -->
          <div class="settings-card" id="ics-card">
            <h3 class="settings-card__title">${t('settings.ics.title')}</h3>
            <div id="ics-list-container"></div>
            <div id="ics-add-form-wrapper" hidden>
              <form id="ics-add-form" class="settings-form settings-form--compact" novalidate autocomplete="off">
                <div class="form-group">
                  <label class="form-label" for="ics-url">${t('settings.ics.form.url')}</label>
                  <input class="form-input" type="url" id="ics-url" required placeholder="https://..." />
                </div>
                <div class="form-group">
                  <label class="form-label" for="ics-name">${t('settings.ics.form.name')}</label>
                  <input class="form-input" type="text" id="ics-name" required maxlength="100" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="ics-color">${t('settings.ics.form.color')}</label>
                  <input class="form-input form-input--color" type="color" id="ics-color" value="#6366f1" />
                </div>
                <div class="form-group">
                  <label class="toggle-row">
                    <input type="checkbox" id="ics-shared" />
                    <span>${t('settings.ics.form.shared')}</span>
                  </label>
                </div>
                <div id="ics-add-error" class="form-error" hidden></div>
                <div class="settings-form-actions">
                  <button type="submit" class="btn btn--primary" id="ics-submit-btn">${t('settings.ics.actions.submit')}</button>
                  <button type="button" class="btn btn--secondary" id="ics-cancel-btn">${t('settings.ics.actions.cancel')}</button>
                </div>
              </form>
            </div>
            <div class="settings-sync-actions">
              <button class="btn btn--secondary" id="ics-add-btn">${t('settings.ics.add')}</button>
            </div>
          </div>
        </section>

        <!-- Sektion: Cloud-Dienste (Google · Apple) -->
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionCloudServices')}</h2>

          <!-- Google Calendar -->
          <div class="settings-card">
            <div class="settings-sync-header">
              <div class="settings-sync-logo settings-sync-logo--google">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
              </div>
              <div class="settings-sync-info">
                <div class="settings-sync-info__name">${t('settings.googleCalendar')}</div>
                <div class="settings-sync-info__status ${googleStatus.connected ? 'settings-sync-info__status--connected' : ''}">
                  ${googleStatusText}
                </div>
              </div>
            </div>
            ${googleStatus.configured ? `
              ${googleStatus.connected && user?.role === 'admin' ? `
                <div class="form-group settings-google-calendars">
                  <label class="form-label">${t('settings.googleCalendarsSelect')}</label>
                  <div class="google-calendars-list" id="google-calendars-list">
                    <p class="form-hint">${t('common.loading')}</p>
                  </div>
                  <p class="form-hint">${t('settings.googleCalendarsSelectHint')}</p>
                </div>
                <div class="form-group">
                  <label class="toggle-row">
                    <input type="checkbox" id="google-readonly-cb" ${googleStatus.readonly ? 'checked' : ''}>
                    <span>${t('settings.googleReadonly')}</span>
                  </label>
                  <p class="form-hint">${t('settings.googleReadonlyHint')}</p>
                </div>
              ` : ''}
              <div class="settings-sync-actions">
                ${googleStatus.connected ? `
                  <button class="btn btn--secondary" id="google-sync-btn">${t('settings.syncNow')}</button>
                  ${user?.role === 'admin' ? `<button class="btn btn--danger-outline" id="google-disconnect-btn">${t('settings.disconnect')}</button>` : ''}
                ` : `
                  ${user?.role === 'admin' ? `<a href="/api/v1/calendar/google/auth" class="btn btn--primary">${t('settings.connectGoogle')}</a>` : `<span class="form-hint">${t('settings.googleOnlyAdmin')}</span>`}
                `}
              </div>
            ` : ''}
          </div>

          <!-- Apple Calendar -->
          <div class="settings-card">
            <div class="settings-sync-header">
              <div class="settings-sync-logo settings-sync-logo--apple">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                </svg>
              </div>
              <div class="settings-sync-info">
                <div class="settings-sync-info__name">${t('settings.appleCalendar')}</div>
                <div class="settings-sync-info__status ${appleStatus.configured ? 'settings-sync-info__status--connected' : ''}">
                  ${appleStatusText}
                </div>
              </div>
            </div>
            ${appleStatus.configured ? `
              <div class="settings-sync-actions">
                <button class="btn btn--secondary" id="apple-sync-btn">${t('settings.syncNow')}</button>
                ${appleStatus.connected && user?.role === 'admin' ? `<button class="btn btn--danger-outline" id="apple-disconnect-btn">${t('settings.disconnect')}</button>` : ''}
              </div>
            ` : user?.role === 'admin' ? `
              <form id="apple-connect-form" class="settings-form settings-form--compact">
                <div class="form-group">
                  <label class="form-label" for="apple-caldav-url">${t('settings.caldavUrlLabel')}</label>
                  <input class="form-input" type="url" id="apple-caldav-url" placeholder="${t('settings.caldavUrlPlaceholder')}" required />
                </div>
                <div class="form-group">
                  <label class="form-label" for="apple-username">${t('settings.appleIdLabel')}</label>
                  <input class="form-input" type="email" id="apple-username" autocomplete="username" required />
                </div>
                <div class="form-group">
                  <label class="form-label" for="apple-password">${t('settings.applePasswordLabel')}</label>
                  <input class="form-input" type="password" id="apple-password" autocomplete="current-password" required />
                  <span class="form-hint">${t('settings.applePasswordHint')}</span>
                </div>
                <div id="apple-connect-error" class="form-error" hidden></div>
                <button type="submit" class="btn btn--primary" id="apple-connect-btn">${t('settings.appleConnectBtn')}</button>
              </form>
            ` : `<span class="form-hint">${t('settings.appleOnlyAdmin')}</span>`}
          </div>
        </section>
      </div>

      ${user?.role === 'admin' ? `
      <!-- Panel: Family Management -->
      <div class="settings-tab-panel" data-panel="family" role="tabpanel"${panelHidden('family')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionFamily')}</h2>
          <div class="settings-card settings-card--family" id="members-card">
            <ul class="settings-members" id="members-list">
              ${users.map(memberHtml).join('')}
            </ul>
            <button class="btn btn--primary settings-add-btn" id="add-member-btn">${t('settings.addMember')}</button>
          </div>

          <div class="settings-card settings-card--family settings-card--hidden" id="add-member-form-card">
            <h3 class="settings-card__title">${t('settings.newMemberTitle')}</h3>
            <form id="add-member-form" class="settings-form">
              <div class="form-group">
                <label class="form-label" for="new-username">${t('settings.usernameLabel')}</label>
                <input class="form-input" type="text" id="new-username" required autocomplete="off" />
              </div>
              <div class="settings-name-color-row">
                <div class="form-group settings-name-color-row__name">
                  <label class="form-label" for="new-display-name">${t('settings.displayNameLabel')}</label>
                  <input class="form-input" type="text" id="new-display-name" required />
                </div>
                <div class="form-group settings-color-field">
                  <label class="form-label" for="new-avatar-color">${t('settings.colorLabel')}</label>
                  <input class="settings-color-button" type="color" id="new-avatar-color" value="${randomAvatarColor()}" />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label" for="new-member-password">${t('settings.memberPasswordLabel')}</label>
                <input class="form-input" type="password" id="new-member-password" minlength="8" required autocomplete="new-password" />
              </div>
              <div class="form-group">
                <label class="form-label" for="new-family-role">${t('settings.familyRoleLabel')}</label>
                <select class="form-input" id="new-family-role">
                  ${buildFamilyRoleOptions()}
                </select>
              </div>
              <div class="modal-grid modal-grid--2">
                <div class="form-group">
                  <label class="form-label" for="new-member-phone">${t('settings.memberPhoneLabel')}</label>
                  <input class="form-input" type="tel" id="new-member-phone" autocomplete="tel" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="new-member-email">${t('settings.memberEmailLabel')}</label>
                  <input class="form-input" type="email" id="new-member-email" autocomplete="email" />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label" for="new-member-birth-date">${t('settings.memberBirthDateLabel')}</label>
                <input class="form-input" type="date" id="new-member-birth-date" />
                <p class="form-hint">${t('settings.memberContactBirthdayHint')}</p>
              </div>
              <label class="toggle-row">
                <input type="checkbox" id="new-system-admin" />
                <span>${t('settings.systemAdminLabel')}</span>
              </label>
              <p class="form-hint">${t('settings.systemAdminHint')}</p>
              <div id="member-error" class="form-error" hidden></div>
              <div class="settings-form-actions">
                <button type="submit" class="btn btn--primary">${t('settings.createMember')}</button>
                <button type="button" class="btn btn--secondary" id="cancel-add-member">${t('settings.cancelAddMember')}</button>
              </div>
            </form>
          </div>
        </section>
      </div>
      ` : ''}

      ${user?.role === 'admin' ? `
      <!-- Panel: API Tokens -->
      <div class="settings-tab-panel" data-panel="api-tokens" role="tabpanel"${panelHidden('api-tokens')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.apiTokensTitle')}</h2>
          <div class="settings-card settings-card--api-tokens">
            <h3 class="settings-card__title">${t('settings.apiTokensCardTitle')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.apiTokensHint')}</p>
            <ul class="settings-members" id="api-token-list">
              ${apiTokens.map(apiTokenHtml).join('')}
            </ul>
            <form id="api-token-form" class="settings-form" autocomplete="off">
              <div class="form-group">
                <label class="form-label" for="api-token-name">${t('settings.apiTokenNameLabel')}</label>
                <input class="form-input" type="text" id="api-token-name" maxlength="100" required />
              </div>
              <div class="form-group">
                <label class="form-label" for="api-token-expires">${t('settings.apiTokenExpiresLabel')}</label>
                <input class="form-input" type="datetime-local" id="api-token-expires" />
                <p class="form-hint">${t('settings.apiTokenExpiresHint')}</p>
              </div>
              <div id="api-token-created" class="settings-token-output" hidden>
                <label class="form-label" for="api-token-created-value">${t('settings.apiTokenCreatedLabel')}</label>
                <input class="form-input" id="api-token-created-value" type="text" readonly />
                <p class="form-hint">${t('settings.apiTokenCreatedHint')}</p>
              </div>
              <div id="api-token-error" class="form-error" hidden></div>
              <button type="submit" class="btn btn--primary">${t('settings.apiTokenCreate')}</button>
            </form>
          </div>
        </section>
      </div>
      ` : ''}

      <!-- Panel: Konto -->
      <div class="settings-tab-panel" data-panel="account" role="tabpanel"${panelHidden('account')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionAccount')}</h2>

          <div class="settings-card settings-card--account">
            <div class="settings-user-info">
              ${avatarHtml(user)}
              <div>
                <div class="settings-user-info__name">${esc(user?.display_name)}</div>
                <div class="settings-user-info__username">@${esc(user?.username)}</div>
              </div>
            </div>
          </div>

          <div class="settings-card settings-card--account">
            <h3 class="settings-card__title">${t('settings.profilePictureTitle')}</h3>
            <form id="profile-form" class="settings-form">
              <div class="settings-profile-editor">
                ${avatarEditorHtml(user, 'profile')}
                <div class="settings-profile-editor__fields">
                  <div class="settings-name-color-row">
                    <div class="form-group settings-name-color-row__name">
                      <label class="form-label" for="profile-display-name">${t('settings.displayNameLabel')}</label>
                      <input class="form-input" type="text" id="profile-display-name" maxlength="128" value="${esc(user?.display_name || '')}" required />
                    </div>
                    <div class="form-group settings-color-field">
                      <label class="form-label" for="profile-avatar-color">${t('settings.colorLabel')}</label>
                      <input class="settings-color-button" type="color" id="profile-avatar-color" value="${esc(user?.avatar_color || '#007AFF')}" />
                    </div>
                  </div>
                </div>
              </div>
              <div class="modal-grid modal-grid--2">
                <div class="form-group">
                  <label class="form-label" for="profile-phone">${t('settings.memberPhoneLabel')}</label>
                  <input class="form-input" type="tel" id="profile-phone" value="${esc(user?.phone || '')}" autocomplete="tel" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="profile-email">${t('settings.memberEmailLabel')}</label>
                  <input class="form-input" type="email" id="profile-email" value="${esc(user?.email || '')}" autocomplete="email" />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label" for="profile-birth-date">${t('settings.memberBirthDateLabel')}</label>
                <input class="form-input" type="date" id="profile-birth-date" value="${esc(user?.birth_date || '')}" />
                <p class="form-hint">${t('settings.memberContactBirthdayHint')}</p>
              </div>
              <div id="profile-error" class="form-error" hidden></div>
              <div class="settings-form-actions">
                <button type="submit" class="btn btn--primary">${t('common.save')}</button>
              </div>
            </form>
          </div>

          <div class="settings-card settings-card--account">
            <h3 class="settings-card__title">${t('settings.changePassword')}</h3>
            <form id="password-form" class="settings-form">
              <div class="form-group">
                <label class="form-label" for="current-password">${t('settings.currentPasswordLabel')}</label>
                <input class="form-input" type="password" id="current-password" autocomplete="current-password" required />
              </div>
              <div class="form-group">
                <label class="form-label" for="new-password">${t('settings.newPasswordLabel')}</label>
                <input class="form-input" type="password" id="new-password" autocomplete="new-password" minlength="8" required />
              </div>
              <div class="form-group">
                <label class="form-label" for="confirm-password">${t('settings.confirmPasswordLabel')}</label>
                <input class="form-input" type="password" id="confirm-password" autocomplete="new-password" minlength="8" required />
              </div>
              <div id="password-error" class="form-error" hidden></div>
              <button type="submit" class="btn btn--primary">${t('settings.savePassword')}</button>
            </form>
          </div>
        </section>

        <section class="settings-section">
          <button class="btn btn--danger-outline settings-logout-btn" id="logout-btn">${t('settings.logout')}</button>
        </section>
      </div>

      ${user?.role === 'admin' ? `
      <!-- Panel: Backup Management -->
      <div class="settings-tab-panel" data-panel="backup" role="tabpanel"${panelHidden('backup')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionBackup')}</h2>

          <div class="settings-card settings-card--backup settings-backup-card">
            <div class="settings-backup-card__icon">
              <i data-lucide="database-backup" aria-hidden="true"></i>
            </div>
            <div class="settings-backup-card__body">
              <h3 class="settings-card__title">${t('settings.backupDownloadTitle')}</h3>
              <p class="form-hint">${t('settings.backupDownloadHint')}</p>
              <div class="settings-form-actions">
                <a class="btn btn--primary" href="/api/v1/backup/database" download>${t('settings.backupDownloadButton')}</a>
              </div>
            </div>
          </div>

          <div class="settings-card settings-card--backup settings-backup-card settings-backup-card--danger">
            <div class="settings-backup-card__icon">
              <i data-lucide="rotate-ccw" aria-hidden="true"></i>
            </div>
            <div class="settings-backup-card__body">
              <h3 class="settings-card__title">${t('settings.backupRestoreTitle')}</h3>
              <p class="form-hint">${t('settings.backupRestoreHint')}</p>
              <form id="backup-restore-form" class="settings-form settings-form--compact">
                <label class="settings-backup-dropzone" id="backup-dropzone" for="backup-restore-file">
                  <i data-lucide="upload-cloud" aria-hidden="true"></i>
                  <span>${t('settings.backupDropzoneTitle')}</span>
                  <small>${t('settings.backupDropzoneHint')}</small>
                </label>
                <input class="sr-only" type="file" id="backup-restore-file" accept=".db,.sqlite,.sqlite3,application/octet-stream" />
                <div class="settings-backup-file" id="backup-selected-file" hidden></div>
                <div id="backup-restore-error" class="form-error" hidden></div>
                <div class="settings-form-actions">
                  <button type="submit" class="btn btn--danger-outline" id="backup-restore-btn" disabled>${t('settings.backupRestoreButton')}</button>
                </div>
              </form>
            </div>
          </div>

          <div class="settings-card settings-card--backup" id="backup-scheduler-card">
            <h3 class="settings-card__title">${t('settings.backupSchedulerTitle')}</h3>
            <p class="form-hint">${t('settings.backupSchedulerHint')}</p>
            <div class="settings-info-grid" id="backup-scheduler-info">
              <!-- Populated by JavaScript -->
            </div>
          </div>

          <!-- WebDAV Backup Target -->
          <div class="settings-card settings-card--backup" id="backup-webdav-card">
            <h3 class="settings-card__title">
              <i data-lucide="cloud-upload" class="icon-sm" aria-hidden="true"></i>
              ${t('settings.backupWebdavTitle')}
            </h3>
            <p class="form-hint">${t('settings.backupWebdavHint')}</p>
            <form class="settings-form" id="backup-webdav-form" novalidate style="margin-top:var(--space-4);">
              <!-- Enable toggle -->
              <div class="settings-webdav-toggle-row">
                <span class="form-label" style="margin:0;">${t('settings.backupWebdavEnabled')}</span>
                <label class="toggle">
                  <input type="checkbox" id="webdav-enabled" name="enabled" />
                  <span class="toggle__track" aria-hidden="true"></span>
                </label>
              </div>
              <div class="form-group">
                <label class="form-label" for="webdav-url">${t('settings.backupWebdavUrl')}</label>
                <input class="form-input" type="url" id="webdav-url" name="url"
                  placeholder="${t('settings.backupWebdavUrlPlaceholder')}" autocomplete="off" />
              </div>
              <div class="form-group">
                <label class="form-label" for="webdav-username">${t('settings.backupWebdavUsername')}</label>
                <input class="form-input" type="text" id="webdav-username" name="username"
                  autocomplete="username" />
              </div>
              <div class="form-group">
                <label class="form-label" for="webdav-password">${t('settings.backupWebdavPassword')}</label>
                <div class="settings-webdav-pw-wrap">
                  <input class="form-input" type="password" id="webdav-password" name="password"
                    autocomplete="current-password"
                    placeholder="${t('settings.backupWebdavPasswordPlaceholder')}" />
                  <button type="button" class="btn btn--icon btn--ghost settings-webdav-reveal-btn"
                    data-reveal-target="webdav-password" aria-label="${t('common.togglePasswordVisibility')}">
                    <i data-lucide="eye" class="icon-sm" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label" for="webdav-path">${t('settings.backupWebdavPath')}</label>
                <input class="form-input" type="text" id="webdav-path" name="remotePath"
                  placeholder="${t('settings.backupWebdavPathPlaceholder')}" />
              </div>
              <div class="form-group">
                <label class="form-label" for="webdav-keep">${t('settings.backupWebdavKeep')}</label>
                <input class="form-input" type="number" id="webdav-keep" name="keep" min="1" max="99"
                  style="max-width:100px;" />
              </div>
              <div id="webdav-test-result" class="form-hint" hidden></div>
              <div class="settings-form-actions">
                <button type="button" class="btn btn--secondary" id="webdav-test-btn">
                  <i data-lucide="plug" aria-hidden="true"></i>
                  ${t('settings.backupWebdavTestBtn')}
                </button>
                <button type="submit" class="btn btn--primary" id="webdav-save-btn">
                  ${t('settings.backupWebdavSaveBtn')}
                </button>
              </div>
            </form>

            <div class="settings-info-grid" id="backup-webdav-status" style="margin-top:var(--space-4);padding-top:var(--space-4);border-top:1px solid var(--color-border);">
              <!-- Populated by JavaScript -->
            </div>
          </div>

          <div class="settings-card settings-card--backup">
            <h3 class="settings-card__title">${t('settings.backupCliTitle')}</h3>
            <p class="form-hint">${t('settings.backupCliHint')}</p>
            <pre class="settings-code-block"><code>SERVICE=oikos
BACKUP="$PWD/oikos-backup.db"
docker compose stop "$SERVICE"
docker compose run --rm -v "$BACKUP:/tmp/oikos-restore.db:ro" --entrypoint sh "$SERVICE" -c 'set -eu; target="\${DB_PATH:-/data/oikos.db}"; stamp=$(date -u +%Y%m%dT%H%M%SZ); if [ -f "$target" ]; then cp "$target" "$target.pre-restore-$stamp"; fi; rm -f "$target-wal" "$target-shm"; cp /tmp/oikos-restore.db "$target"; chown node:node "$target" 2&gt;/dev/null || true'
docker compose up -d "$SERVICE"</code></pre>
            <p class="form-hint">${t('settings.backupCliBackupHint')}</p>
            <pre class="settings-code-block"><code>docker compose exec oikos node -e "import('./server/db.js').then(async db =&gt; { await db.backupToFile('/data/oikos-backup.db'); process.exit(0); })"
docker cp oikos:/data/oikos-backup.db ./oikos-backup.db</code></pre>
          </div>
        </section>
      </div>
      ` : ''}
    </div>
  `);

  // Meal-Type-Checkboxen initialisieren
  const toggles = container.querySelector('#meal-type-toggles');
  if (toggles) {
    toggles.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = prefs.visible_meal_types.includes(cb.value);
    });
  }

  // Initial Load: CalDAV & CardDAV Accounts
  if (container.querySelector('#caldav-accounts-list')) {
    loadCalDAVAccounts(container, user);
  }
  if (container.querySelector('#cardav-accounts-list')) {
    loadCardDAVAccounts(container, user);
  }

  // Initial render: DMS accounts (admin only)
  if (container.querySelector('#dms-account-list')) {
    renderDmsAccounts(dmsAccounts);
  }

  renderSettingsSubTabs(container, user, activeTab);
  bindEvents(container, user, users, categories, icsSubscriptions, apiTokens, thirdPartyModules);
  bindDocumentStorageEvents(container);
  bindDmsEvents(container);
  if (window.lucide) window.lucide.createIcons({ el: container });
}
// CalDAV-Konten laden
async function loadCalDAVAccounts(container, user) {
  const listEl = container.querySelector('#caldav-accounts-list');
  const emptyEl = container.querySelector('#caldav-empty-state');
  if (!listEl || !emptyEl) return;

  try {
    const accountsRes = await api.get('/calendar/caldav/accounts');
    const accounts = accountsRes.data || [];

    if (accounts.length === 0) {
      listEl.replaceChildren();
      emptyEl.style.display = '';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.replaceChildren();

    for (const account of accounts) {
      const calendarsRes = await api.get(`/calendar/caldav/accounts/${account.id}/calendars`);
      const calendars = calendarsRes.data || [];

      let reminderLists = [];
      try {
        const remindersRes = await api.get(`/calendar/caldav/accounts/${account.id}/reminder-lists`);
        reminderLists = remindersRes.data || [];
      } catch { /* reminder lists optional — ignore fetch errors */ }

      const accountCard = document.createElement('div');
      accountCard.className = 'caldav-account-item';
      accountCard.insertAdjacentHTML('beforeend', `
        <div class="caldav-account-header">
          <h4>${esc(account.name)}</h4>
          <div class="caldav-account-meta">
            <span>${esc(account.caldav_url)}</span>
            ${account.last_sync ? `<span>${t('settings.lastSync')}: ${formatDateTime(account.last_sync)}</span>` : ''}
          </div>
        </div>
        <details class="caldav-calendars-details">
          <summary class="caldav-calendars-summary">
            ${t('settings.caldavCalendarsToggle')} (${calendars.length})
          </summary>
          <div class="caldav-calendars-list">
            ${calendars.map((cal) => `
              <label class="caldav-calendar-item">
                <input type="checkbox" class="caldav-calendar-checkbox"
                       data-account-id="${account.id}"
                       data-calendar-url="${esc(cal.calendarUrl)}"
                       ${cal.enabled ? 'checked' : ''}>
                <span class="caldav-calendar-color" style="background-color: ${esc(cal.calendarColor || '#007AFF')}"></span>
                <span class="caldav-calendar-name">${esc(cal.calendarName || cal.calendarUrl)}</span>
              </label>
            `).join('')}
          </div>
        </details>
        <details class="caldav-calendars-details">
          <summary class="caldav-calendars-summary">
            ${t('settings.caldavRemindersToggle')} (${reminderLists.length})
          </summary>
          <p class="settings-card-description">${t('settings.caldavRemindersHint')}</p>
          <div class="caldav-calendars-list">
            ${reminderLists.length === 0
              ? `<p class="settings-card-description">${t('settings.caldavRemindersEmpty')}</p>`
              : reminderLists.map((list) => `
              <div class="caldav-reminder-item">
                <label class="caldav-calendar-item">
                  <input type="checkbox" class="caldav-reminder-checkbox"
                         data-account-id="${account.id}"
                         data-list-url="${esc(list.listUrl)}"
                         ${list.enabled ? 'checked' : ''}>
                  <span class="caldav-calendar-name">${esc(list.listName)}</span>
                </label>
                <select class="caldav-reminder-module"
                        data-account-id="${account.id}"
                        data-list-url="${esc(list.listUrl)}">
                  <option value="tasks" ${list.targetModule === 'tasks' ? 'selected' : ''}>${t('settings.caldavReminderMapTasks')}</option>
                  <option value="shopping" ${list.targetModule === 'shopping' ? 'selected' : ''}>${t('settings.caldavReminderMapShopping')}</option>
                </select>
              </div>
            `).join('')}
          </div>
        </details>
        <div class="caldav-account-actions">
          <button class="btn btn--secondary btn--sm" data-caldav-sync="${account.id}">${t('settings.syncNow')}</button>
          <button class="btn btn--secondary btn--sm" data-caldav-refresh="${account.id}">${t('settings.caldavRefreshCalendars')}</button>
          <button class="btn btn--secondary btn--sm" data-reminders-refresh="${account.id}">${t('settings.caldavRefreshReminders')}</button>
          <button class="btn btn--secondary btn--sm" data-reminders-sync="${account.id}">${t('settings.caldavSyncReminders')}</button>
          ${user?.role === 'admin' ? `<button class="btn btn--danger-outline btn--sm" data-caldav-delete="${account.id}">${t('common.delete')}</button>` : ''}
        </div>
      `);
      listEl.appendChild(accountCard);
    }

    if (window.lucide) lucide.createIcons({ el: listEl });

    // Bind calendar checkbox events
    listEl.querySelectorAll('.caldav-calendar-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        const accountId = parseInt(checkbox.dataset.accountId, 10);
        const calendarUrl = checkbox.dataset.calendarUrl;
        const enabled = checkbox.checked;

        try {
          await api.patch(`/calendar/caldav/accounts/${accountId}/calendars`, {
            calendarUrl,
            enabled,
          });
          window.oikos?.showToast(
            enabled ? t('settings.calendarEnabled') : t('settings.calendarDisabled'),
            'success'
          );
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
          checkbox.checked = !enabled; // Revert on error
        }
      });
    });

    // Bind reminder-list enable/disable toggles
    listEl.querySelectorAll('.caldav-reminder-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        const accountId = parseInt(checkbox.dataset.accountId, 10);
        const listUrl = checkbox.dataset.listUrl;
        const enabled = checkbox.checked;
        const select = checkbox.closest('.caldav-reminder-item')?.querySelector('.caldav-reminder-module');
        try {
          await api.patch(`/calendar/caldav/accounts/${accountId}/reminder-lists`, {
            listUrl,
            enabled,
            targetModule: select ? select.value : undefined,
          });
          window.oikos?.showToast(
            enabled ? t('settings.reminderListEnabled') : t('settings.reminderListDisabled'),
            'success'
          );
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
          checkbox.checked = !enabled;
        }
      });
    });

    // Bind reminder-list target-module selectors
    listEl.querySelectorAll('.caldav-reminder-module').forEach((select) => {
      select.addEventListener('change', async () => {
        const accountId = parseInt(select.dataset.accountId, 10);
        const listUrl = select.dataset.listUrl;
        try {
          await api.patch(`/calendar/caldav/accounts/${accountId}/reminder-lists`, {
            listUrl,
            targetModule: select.value,
          });
          window.oikos?.showToast(t('settings.reminderMapUpdated'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
    });

    // Bind reminder-list refresh (discover VTODO collections)
    listEl.querySelectorAll('[data-reminders-refresh]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const accountId = parseInt(btn.dataset.remindersRefresh, 10);
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = t('settings.loading');
        try {
          await api.get(`/calendar/caldav/accounts/${accountId}/reminder-lists?refresh=true`);
          await loadCalDAVAccounts(container, user);
          window.oikos?.showToast(t('settings.reminderListsRefreshed'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });

    // Bind reminder sync buttons (read-only: iCloud → Tasks/Shopping)
    listEl.querySelectorAll('[data-reminders-sync]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = t('settings.synchronizing');
        try {
          await api.post('/calendar/caldav/reminders/sync');
          window.oikos?.showToast(t('settings.reminderSyncSuccess'), 'success');
          await loadCalDAVAccounts(container, user);
        } catch (err) {
          window.oikos?.showToast(err.message || t('settings.reminderSyncFailed'), 'danger');
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });

    // Bind sync buttons
    listEl.querySelectorAll('[data-caldav-sync]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = t('settings.synchronizing');
        try {
          await api.post('/calendar/caldav/sync');
          window.oikos?.showToast(t('settings.caldavSyncSuccess'), 'success');
          await loadCalDAVAccounts(container, user);
        } catch (err) {
          window.oikos?.showToast(err.message || t('settings.caldavSyncFailed'), 'danger');
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });

    // Bind refresh buttons
    listEl.querySelectorAll('[data-caldav-refresh]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const accountId = parseInt(btn.dataset.caldavRefresh, 10);
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = t('settings.loading');
        try {
          await api.get(`/calendar/caldav/accounts/${accountId}/calendars?refresh=true`);
          await loadCalDAVAccounts(container, user);
          window.oikos?.showToast(t('settings.calendarsRefreshed'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });

    // Bind delete buttons
    listEl.querySelectorAll('[data-caldav-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const accountId = parseInt(btn.dataset.caldavDelete, 10);
        if (!await confirmModal(t('settings.deleteAccountConfirm'), { danger: true })) return;
        try {
          await api.delete(`/calendar/caldav/accounts/${accountId}`);
          window.oikos?.showToast(t('settings.caldavAccountDeleted'), 'success');
          await loadCalDAVAccounts(container, user);
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
    });

  } catch (err) {
    console.error('Failed to load CalDAV accounts:', err);
    window.oikos?.showToast(t('settings.caldavConnectionFailed'), 'danger');
  }
}

// CardDAV-Konten laden
async function loadCardDAVAccounts(container, user) {
  const listEl = container.querySelector('#cardav-accounts-list');
  const emptyEl = container.querySelector('#cardav-empty-state');
  if (!listEl || !emptyEl) return;

  try {
    const accountsRes = await api.get('/contacts/cardav/accounts');
    const accounts = accountsRes.data || [];

    if (accounts.length === 0) {
      listEl.replaceChildren();
      emptyEl.style.display = '';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.replaceChildren();

    for (const account of accounts) {
      const addressbooksRes = await api.get(`/contacts/cardav/accounts/${account.id}/addressbooks`);
      const addressbooks = addressbooksRes.data || [];

      const accountCard = document.createElement('div');
      accountCard.className = 'caldav-account-item';
      accountCard.insertAdjacentHTML('beforeend', `
        <div class="caldav-account-header">
          <h4>${esc(account.name)}</h4>
          <div class="caldav-account-meta">
            <span>${esc(account.cardav_url)}</span>
            ${account.last_sync ? `<span>${t('settings.lastSync')}: ${formatDateTime(account.last_sync)}</span>` : ''}
          </div>
        </div>
        <details class="caldav-calendars-details">
          <summary class="caldav-calendars-summary">
            ${t('settings.cardavAddressbooksToggle')} (${addressbooks.length})
          </summary>
          <div class="caldav-calendars-list">
            ${addressbooks.map((ab) => `
              <label class="caldav-calendar-item">
                <input type="checkbox" class="caldav-calendar-checkbox cardav-addressbook-checkbox"
                       data-account-id="${account.id}"
                       data-addressbook-url="${esc(ab.url)}"
                       ${ab.enabled ? 'checked' : ''}>
                <span class="caldav-calendar-name">${esc(ab.display_name || ab.url)}</span>
              </label>
            `).join('')}
          </div>
        </details>
        <div class="caldav-account-actions">
          <button class="btn btn--secondary btn--sm" data-cardav-sync="${account.id}">${t('settings.syncNow')}</button>
          <button class="btn btn--secondary btn--sm" data-cardav-refresh="${account.id}">${t('settings.cardavRefreshAddressbooks')}</button>
          <button class="btn btn--danger-outline btn--sm" data-cardav-delete="${account.id}">${t('settings.disconnect')}</button>
        </div>
      `);

      // Addressbook toggle
      accountCard.querySelectorAll('.cardav-addressbook-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', async () => {
          const accountId = parseInt(checkbox.dataset.accountId, 10);
          const addressbookUrl = checkbox.dataset.addressbookUrl;
          const enabled = checkbox.checked;
          try {
            await api.post(`/contacts/cardav/accounts/${accountId}/addressbooks/toggle`, {
              addressbookUrl,
              enabled,
            });
            window.oikos?.showToast(enabled ? t('settings.addressbookEnabled') : t('settings.addressbookDisabled'), 'success');
          } catch (err) {
            window.oikos?.showToast(err.message, 'danger');
            checkbox.checked = !enabled;
          }
        });
      });

      // Sync button
      const syncBtn = accountCard.querySelector(`[data-cardav-sync="${account.id}"]`);
      if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
          try {
            await api.post(`/contacts/cardav/accounts/${account.id}/sync`);
            window.oikos?.showToast(t('settings.cardavSyncSuccess'), 'success');
            await loadCardDAVAccounts(container, user);
          } catch (err) {
            window.oikos?.showToast(t('settings.cardavSyncFailed'), 'danger');
          }
        });
      }

      // Refresh button
      const refreshBtn = accountCard.querySelector(`[data-cardav-refresh="${account.id}"]`);
      if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
          try {
            await api.post(`/contacts/cardav/accounts/${account.id}/addressbooks/refresh`);
            window.oikos?.showToast(t('settings.addressbooksRefreshed'), 'success');
            await loadCardDAVAccounts(container, user);
          } catch (err) {
            window.oikos?.showToast(err.message, 'danger');
          }
        });
      }

      // Delete button
      const deleteBtn = accountCard.querySelector(`[data-cardav-delete="${account.id}"]`);
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          const confirmed = await confirmModal(t('settings.deleteCardDAVAccountConfirm'));
          if (!confirmed) return;
          try {
            await api.delete(`/contacts/cardav/accounts/${account.id}`);
            window.oikos?.showToast(t('settings.cardavAccountDeleted'), 'success');
            await loadCardDAVAccounts(container, user);
          } catch (err) {
            window.oikos?.showToast(err.message, 'danger');
          }
        });
      }

      listEl.appendChild(accountCard);
    }
  } catch (err) {
    console.error('Failed to load CardDAV accounts:', err);
  }
}

// --------------------------------------------------------
// Document storage
// --------------------------------------------------------

function documentStorageTarget(data) {
  if (data.effective_target) return data.effective_target;
  if (!data.url) return t('settings.documentStorageNotConfigured');
  const basePath = data.base_path ?? data.basePath ?? '';
  return basePath ? `${data.url.replace(/\/+$/, '')}/${String(basePath).replace(/^\/+/, '')}` : data.url;
}

function renderDocumentStorageStatus(container, data) {
  const status = container.querySelector('#document-storage-status');
  if (!status) return;
  const activeBackend = data.active_upload_backend ?? (data.enabled ? 'webdav' : 'local');
  const activeLabel = activeBackend === 'webdav'
    ? t('documents.storageWebdav')
    : t('documents.storageLocal');
  const lastTest = data.last_test ?? data.lastTest;
  const lastTestLabel = lastTest
    ? `${formatDate(lastTest)} ${formatTime(lastTest)}`
    : t('settings.documentStorageNeverTested');
  const lastError = data.last_error ?? data.lastError;

  status.replaceChildren();
  status.insertAdjacentHTML('beforeend', `
    <div class="settings-info-row">
      <span class="settings-info-label">${t('settings.documentStorageActive')}</span>
      <span class="settings-info-value settings-info-value--success">${esc(activeLabel)}</span>
    </div>
    <div class="settings-info-row">
      <span class="settings-info-label">${t('settings.documentStorageTarget')}</span>
      <span class="settings-info-value"><code>${esc(documentStorageTarget(data))}</code></span>
    </div>
    <div class="settings-info-row">
      <span class="settings-info-label">${t('settings.documentStorageCount')}</span>
      <span class="settings-info-value">${Number(data.webdav_document_count ?? 0)}</span>
    </div>
    <div class="settings-info-row">
      <span class="settings-info-label">${t('settings.documentStorageLastTest')}</span>
      <span class="settings-info-value">${esc(lastTestLabel)}</span>
    </div>
    ${lastError ? `
      <div class="settings-info-row">
        <span class="settings-info-label">${t('settings.documentStorageLastError')}</span>
        <span class="settings-info-value settings-document-storage-error">${esc(lastError)}</span>
      </div>
    ` : ''}
  `);
}

async function loadDocumentStorageConfig(container) {
  const form = container.querySelector('#document-storage-form');
  if (!form) return;
  try {
    const res = await api.get('/documents/storage/config');
    const data = res.data ?? {};
    const envControlled = data.env_controlled ?? data.envControlled ?? {};
    const basePath = data.base_path ?? data.basePath ?? '';
    form._documentStorageConfig = {
      ...data,
      base_path: basePath,
      env_controlled: envControlled,
    };

    form.querySelector('#document-storage-enabled').checked = Boolean(data.enabled);
    form.querySelector('#document-storage-url').value = data.url ?? '';
    form.querySelector('#document-storage-username').value = data.username ?? '';
    form.querySelector('#document-storage-password').value = '';
    form.querySelector('#document-storage-password').placeholder = data.password_configured
      ? '****'
      : t('settings.documentStoragePasswordPlaceholder');
    form.querySelector('#document-storage-path').value = basePath;

    const fieldIds = {
      enabled: 'document-storage-enabled',
      url: 'document-storage-url',
      username: 'document-storage-username',
      password: 'document-storage-password',
      path: 'document-storage-path',
    };
    for (const [field, id] of Object.entries(fieldIds)) {
      const input = form.querySelector(`#${id}`);
      const controlled = Boolean(envControlled[field]);
      if (input) input.disabled = controlled;
      const hint = form.querySelector(`[data-env-hint="${field}"]`);
      if (hint) hint.hidden = !controlled;
    }
    renderDocumentStorageStatus(container, data);
  } catch (err) {
    console.error('Failed to load document storage config:', err);
  }
}

function documentStoragePayload(form) {
  const envControlled = form._documentStorageConfig?.env_controlled ?? {};
  const payload = {};
  if (!envControlled.enabled) {
    payload.enabled = form.querySelector('#document-storage-enabled')?.checked ?? false;
  }
  if (!envControlled.url) {
    payload.url = form.querySelector('#document-storage-url')?.value?.trim() ?? '';
  }
  if (!envControlled.username) {
    payload.username = form.querySelector('#document-storage-username')?.value?.trim() ?? '';
  }
  if (!envControlled.path) {
    payload.path = form.querySelector('#document-storage-path')?.value?.trim() ?? '';
  }
  const password = form.querySelector('#document-storage-password')?.value;
  if (!envControlled.password && password && password !== '****') payload.password = password;
  return payload;
}

function hasProtectedDocumentStorageChange(form, payload) {
  const current = form._documentStorageConfig ?? {};
  if (Number(current.webdav_document_count ?? 0) < 1) return false;
  const envControlled = current.env_controlled ?? {};
  if (Object.hasOwn(payload, 'url') && payload.url !== (current.url ?? '')) return true;
  if (Object.hasOwn(payload, 'username') && payload.username !== (current.username ?? '')) return true;
  if (Object.hasOwn(payload, 'path') && payload.path !== (current.base_path ?? '')) return true;
  return !envControlled.password && Object.hasOwn(payload, 'password');
}

function bindDocumentStorageEvents(container) {
  const form = container.querySelector('#document-storage-form');
  const testBtn = container.querySelector('#document-storage-test-btn');
  const result = container.querySelector('#document-storage-test-result');
  if (!form) return;

  loadDocumentStorageConfig(container);

  form.querySelector('[data-reveal-target]')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const input = form.querySelector(`#${button.dataset.revealTarget}`);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    const icon = button.querySelector('[data-lucide]');
    if (icon) icon.dataset.lucide = reveal ? 'eye-off' : 'eye';
    if (window.lucide) window.lucide.createIcons({ el: button });
  });

  testBtn?.addEventListener('click', async () => {
    testBtn.disabled = true;
    if (result) {
      result.hidden = false;
      result.textContent = t('settings.documentStorageTesting');
      result.className = 'form-hint';
    }
    try {
      await api.post('/documents/storage/test', documentStoragePayload(form));
      if (result) {
        result.textContent = t('settings.documentStorageTestSuccess');
        result.className = 'form-hint settings-document-storage-success';
      }
      await loadDocumentStorageConfig(container);
    } catch (err) {
      if (result) {
        result.textContent = t('settings.documentStorageTestFailed', { error: err.message });
        result.className = 'form-hint settings-document-storage-error';
      }
    } finally {
      testBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveBtn = form.querySelector('#document-storage-save-btn');
    const payload = documentStoragePayload(form);
    if (hasProtectedDocumentStorageChange(form, payload)) {
      const confirmed = await confirmModal(t('settings.documentStorageConfirmExisting'), {
        confirmLabel: t('common.confirm'),
      });
      if (!confirmed) return;
      payload.confirm_existing_access = true;
    }
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = t('common.saving');
    }
    try {
      await api.put('/documents/storage/config', payload);
      window.oikos?.showToast(t('settings.documentStorageSaved'), 'success');
      await loadDocumentStorageConfig(container);
    } catch (err) {
      window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = t('settings.documentStorageSave');
      }
    }
  });
}

// --------------------------------------------------------
// DMS accounts
// --------------------------------------------------------

function renderDmsAccounts(accounts) {
  const list = document.getElementById('dms-account-list');
  if (!list) return;
  list.replaceChildren();
  if (!accounts.length) {
    const li = document.createElement('li');
    li.className = 'dms-account-empty form-hint';
    li.textContent = t('settings.dmsNone');
    list.appendChild(li);
    return;
  }
  for (const acc of accounts) {
    const li = document.createElement('li');
    li.className = 'dms-account-item';
    li.dataset.id = acc.id;

    const meta = document.createElement('div');
    meta.className = 'dms-account-meta';
    const name = document.createElement('strong');
    name.textContent = acc.name;
    const url = document.createElement('span');
    url.className = 'form-hint';
    url.textContent = acc.base_url;
    meta.append(name, document.createElement('br'), url);

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn btn--secondary btn--sm';
    testBtn.dataset.action = 'test-dms';
    testBtn.dataset.id = acc.id;
    testBtn.textContent = t('settings.dmsTestBtn');

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn--danger btn--sm';
    delBtn.dataset.action = 'remove-dms';
    delBtn.dataset.id = acc.id;
    delBtn.textContent = t('settings.dmsRemove');

    li.append(meta, testBtn, delBtn);
    list.appendChild(li);
  }
}

function bindDmsEvents(container) {
  const dmsForm = container.querySelector('#dms-form');
  if (!dmsForm) return;

  dmsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = container.querySelector('#dms-form-error');
    errEl.hidden = true;
    const name      = container.querySelector('#dms-name').value.trim();
    const base_url  = container.querySelector('#dms-url').value.trim();
    const api_token = container.querySelector('#dms-token').value;
    try {
      const res = await api.post('/documents/dms/accounts', { provider: 'paperless', name, base_url, api_token });
      const accounts = res.data ?? [];
      renderDmsAccounts(Array.isArray(accounts) ? accounts : [accounts]);
      // Reload full list to get up-to-date state
      const listRes = await api.get('/documents/dms/accounts');
      renderDmsAccounts(listRes.data ?? []);
      dmsForm.reset();
      window.oikos?.showToast(t('settings.dmsConnected'), 'success');
    } catch (err) {
      showError(errEl, err.message ?? t('common.errorGeneric'));
    }
  });

  const list = container.querySelector('#dms-account-list');
  if (!list) return;

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'test-dms') {
      btn.disabled = true;
      try {
        const res = await api.post(`/documents/dms/accounts/${id}/test`);
        const result = res.data ?? {};
        if (result.ok) {
          window.oikos?.showToast(t('settings.dmsTestOk'), 'success');
        } else {
          window.oikos?.showToast(t('settings.dmsTestFail', { status: result.status }), 'danger');
        }
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
      } finally {
        btn.disabled = false;
      }
    }

    if (action === 'remove-dms') {
      if (!confirm(t('settings.dmsRemoveConfirm'))) return;
      try {
        await api.delete(`/documents/dms/accounts/${id}`);
        const listRes = await api.get('/documents/dms/accounts');
        renderDmsAccounts(listRes.data ?? []);
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
      }
    }
  });
}

// --------------------------------------------------------
// Sub-Tab-Navigation
// --------------------------------------------------------

function buildSettingsTabs(user) {
  const tabs = [
    { id: 'general',    label: t('settings.tabGeneral'),    icon: 'settings'       },
    { id: 'meals',      label: t('settings.tabMeals'),      icon: 'utensils'       },
    { id: 'budget',     label: t('settings.tabBudget'),     icon: 'wallet'         },
    { id: 'shopping',   label: t('settings.tabShopping'),   icon: 'shopping-cart'  },
    { id: 'calendar',   label: t('settings.tabCalendar'),   icon: 'calendar'       },
    { id: 'sync',       label: t('settings.tabSync'),       icon: 'refresh-cw',    separatorBefore: true },
    { id: 'account',    label: t('settings.tabAccount'),    icon: 'user',          separatorBefore: true },
  ];
  if (user?.role === 'admin') {
    tabs.push(
      { id: 'family',     label: t('settings.tabFamily'),    icon: 'users',    separatorBefore: true },
      { id: 'api-tokens', label: t('settings.tabApiTokens'), icon: 'key'    },
      { id: 'backup',     label: t('settings.tabBackup'),    icon: 'database' },
    );
  }
  return tabs;
}

function renderSettingsSubTabs(container, user, activeTab) {
  const settingsPage = container.querySelector('.settings-page');
  if (!settingsPage) return;

  const lastBanner = [...settingsPage.querySelectorAll('.settings-banner')].at(-1);
  const anchor     = lastBanner ?? settingsPage.querySelector('.page__header');
  if (!anchor) return;

  renderSubTabs(anchor, {
    tabs:           buildSettingsTabs(user),
    activeId:       activeTab,
    storageKey:     SETTINGS_TAB_KEY,
    ariaLabel:      t('settings.tabsAriaLabel'),
    extraClass:     'settings-tabs',
    insertPosition: 'afterend',
    onChange: (tabId) => {
      container.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.panel !== tabId;
      });
    },
  });
}

function bindPwaInstallEvents(container) {
  const button = container.querySelector('#pwa-install-btn');
  const status = container.querySelector('#pwa-install-status');
  const label = button?.querySelector('span');
  if (!button || !status || !label) return;

  const renderState = (state = getPwaInstallState()) => {
    if (!container.isConnected) {
      unsubscribe?.();
      return;
    }

    if (state.installed) {
      status.textContent = t('settings.pwaInstallInstalled');
      label.textContent = t('settings.pwaInstallInstalledButton');
      button.disabled = true;
      return;
    }

    if (state.ios) {
      status.textContent = t('settings.pwaInstallIosHint');
      label.textContent = t('settings.pwaInstallInstructionsButton');
      button.disabled = false;
      return;
    }

    if (state.canPrompt) {
      status.textContent = t('settings.pwaInstallReady');
      label.textContent = t('settings.pwaInstallButton');
      button.disabled = false;
      return;
    }

    status.textContent = t('settings.pwaInstallUnavailable');
    label.textContent = t('settings.pwaInstallButton');
    button.disabled = true;
  };

  let unsubscribe = null;
  unsubscribe = onPwaInstallStateChanged(renderState);

  button.addEventListener('click', async () => {
    try {
      const result = await promptPwaInstall();
      if (result.outcome === 'accepted') {
        window.oikos?.showToast(t('settings.pwaInstallAcceptedToast'), 'success');
      } else if (result.outcome === 'ios') {
        window.oikos?.showToast(t('settings.pwaInstallIosToast'), 'default');
      } else if (result.outcome === 'installed') {
        window.oikos?.showToast(t('settings.pwaInstallAlreadyInstalledToast'), 'default');
      } else if (result.outcome === 'unavailable') {
        window.oikos?.showToast(t('settings.pwaInstallUnavailableToast'), 'warning');
      }
    } catch (err) {
      window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      renderState();
    }
  });
}

function thirdPartyModuleStatusLabel(module) {
  if (module.status === 'error') return t('settings.thirdPartyModulesStatusError');
  return module.enabled ? t('settings.thirdPartyModulesStatusEnabled') : t('settings.thirdPartyModulesStatusDisabled');
}

function orderedActiveModules(prefs, thirdPartyModules) {
  const rows = [
    ...BUILT_IN_MODULES.map((module) => ({
      type: 'built-in',
      id: module.id,
      orderId: module.id,
      label: t(module.labelKey),
      icon: module.icon,
      enabled: module.locked || !prefs.disabled_modules?.includes(module.id),
      locked: module.locked === true,
      status: module.locked ? t('settings.modulesBuiltInBadge') : t('settings.modulesBuiltInBadge'),
      draggable: true,
    })),
    ...thirdPartyModules.map((module) => ({
      type: 'third-party',
      id: module.id,
      orderId: `third-party-${module.id}`,
      label: module.menu?.label || module.name || module.id,
      icon: module.menu?.icon || module.icon || 'box',
      enabled: module.enabled && module.status === 'enabled',
      locked: false,
      status: module.menu?.show === false ? t('settings.modulesMenuDisabled') : thirdPartyModuleStatusLabel(module),
      error: module.error,
      disabled: module.status === 'error',
      draggable: module.menu?.show !== false,
      accent: module.accent,
    })),
  ];
  const orderIndex = new Map((prefs.module_order || []).map((id, index) => [id, index]));
  return rows.sort((a, b) => {
    const ai = orderIndex.has(a.orderId) ? orderIndex.get(a.orderId) : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b.orderId) ? orderIndex.get(b.orderId) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return 0;
  });
}

function activeModuleRowsHtml(prefs, thirdPartyModules) {
  const rows = orderedActiveModules(prefs, thirdPartyModules);
  if (!rows.length) {
    return `
      <div class="empty-state empty-state--compact">
        <div class="empty-state__title">${t('settings.thirdPartyModulesEmptyTitle')}</div>
        <div class="empty-state__description">${t('settings.thirdPartyModulesEmptyHint')}</div>
      </div>
    `;
  }
  return rows.map((module) => {
    const isThirdParty = module.type === 'third-party';
    const inputAttr = isThirdParty
      ? `data-third-party-module-toggle="${esc(module.id)}"`
      : `data-built-in-module-toggle="${esc(module.id)}"`;
    const rowAttr = module.draggable
      ? `draggable="true" data-module-order-id="${esc(module.orderId)}"`
      : '';
    return `
      <div class="settings-module-row settings-module-row--sortable" ${rowAttr} data-module-row-id="${esc(module.orderId)}">
        <button type="button" class="settings-module-drag" aria-label="${esc(t('settings.modulesDragHandle'))}" title="${esc(t('settings.modulesDragHandle'))}" ${module.draggable ? '' : 'disabled'}>
          <i data-lucide="grip-vertical" aria-hidden="true"></i>
        </button>
        <div class="settings-module-move-buttons">
          <button type="button" class="settings-module-move" data-module-move="up" aria-label="${esc(t('settings.modulesMoveUp'))}" title="${esc(t('settings.modulesMoveUp'))}" ${module.draggable ? '' : 'disabled'}>
            <i data-lucide="chevron-up" aria-hidden="true"></i>
          </button>
          <button type="button" class="settings-module-move" data-module-move="down" aria-label="${esc(t('settings.modulesMoveDown'))}" title="${esc(t('settings.modulesMoveDown'))}" ${module.draggable ? '' : 'disabled'}>
            <i data-lucide="chevron-down" aria-hidden="true"></i>
          </button>
        </div>
        <div class="settings-module-row__icon" style="--module-row-accent:${esc(module.accent || '#6366F1')}">
          <i data-lucide="${esc(module.icon)}" aria-hidden="true"></i>
        </div>
        <div class="settings-module-row__body">
          <div class="settings-module-row__title">
            <strong>${esc(module.label)}</strong>
            ${isThirdParty ? `<span class="settings-module-origin">${esc(t('settings.modulesExternalBadge'))}</span>` : ''}
            <span class="settings-module-status ${isThirdParty && module.disabled ? 'settings-module-status--error' : module.enabled ? 'settings-module-status--enabled' : 'settings-module-status--disabled'}">${esc(module.status)}</span>
          </div>
          ${module.error ? `<p class="form-error">${esc(module.error)}</p>` : ''}
        </div>
        <label class="toggle-row settings-module-row__toggle">
          <input type="checkbox" ${inputAttr} ${module.enabled ? 'checked' : ''} ${module.locked || module.disabled ? 'disabled' : ''}>
          <span>${t('settings.thirdPartyModulesEnableLabel')}</span>
        </label>
      </div>
    `;
  }).join('');
}

function collectModuleOrder(list) {
  return [...list.querySelectorAll('[data-module-order-id]')]
    .map((row) => row.dataset.moduleOrderId)
    .filter(Boolean);
}

function collectDisabledBuiltInModules(list) {
  return [...list.querySelectorAll('[data-built-in-module-toggle]')]
    .filter((input) => !input.checked)
    .map((input) => input.dataset.builtInModuleToggle);
}

async function saveModuleListState(list) {
  const disabled = collectDisabledBuiltInModules(list);
  const moduleOrder = collectModuleOrder(list);
  const res = await api.put('/preferences', { disabled_modules: disabled, module_order: moduleOrder });
  const savedDisabled = res?.data?.disabled_modules ?? disabled;
  const savedOrder = res?.data?.module_order ?? moduleOrder;
  window.oikos?.setDisabledModules?.(savedDisabled);
  window.oikos?.setModuleOrder?.(savedOrder);
}

function bindModuleListEvents(container, user) {
  if (user?.role !== 'admin') return;
  const list = container.querySelector('#module-toggles');
  if (!list) return;
  let dragged = null;
  let dragStartOrder = '';
  let savingOrder = false;

  const saveIfChanged = async (previousOrder) => {
    const currentOrder = collectModuleOrder(list).join('|');
    if (currentOrder === previousOrder || savingOrder) return;
    savingOrder = true;
    try {
      await saveModuleListState(list);
      window.oikos?.showToast(t('settings.modulesSaved'), 'success');
    } catch (err) {
      window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
      render(container, { user });
    } finally {
      savingOrder = false;
    }
  };

  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest('[data-module-order-id]');
    if (!row) return;
    dragged = row;
    dragStartOrder = collectModuleOrder(list).join('|');
    row.classList.add('settings-module-row--dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.dataset.moduleOrderId);
  });

  list.addEventListener('dragend', async () => {
    const previousOrder = dragStartOrder;
    dragged?.classList.remove('settings-module-row--dragging');
    dragged = null;
    dragStartOrder = '';
    await saveIfChanged(previousOrder);
  });

  list.addEventListener('dragover', (event) => {
    if (!dragged) return;
    event.preventDefault();
    const row = event.target.closest('[data-module-order-id]');
    if (!row || row === dragged) return;
    const rect = row.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    list.insertBefore(dragged, before ? row : row.nextSibling);
  });

  list.addEventListener('drop', (event) => {
    if (!dragged) return;
    event.preventDefault();
  });

  list.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-module-move]');
    if (!btn) return;
    const row = btn.closest('[data-module-order-id]');
    if (!row) return;
    const previousOrder = collectModuleOrder(list).join('|');
    if (btn.dataset.moduleMove === 'up') {
      const prev = row.previousElementSibling;
      if (prev?.matches('[data-module-order-id]')) list.insertBefore(row, prev);
    } else {
      const next = row.nextElementSibling;
      if (next?.matches('[data-module-order-id]')) list.insertBefore(next, row);
    }
    await saveIfChanged(previousOrder);
  });

  list.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-built-in-module-toggle], [data-third-party-module-toggle]');
    if (!input) return;
    const enabled = input.checked;
    input.disabled = true;
    try {
      if (input.dataset.thirdPartyModuleToggle) {
        await api.patch(`/modules/${encodeURIComponent(input.dataset.thirdPartyModuleToggle)}`, { enabled });
        await window.oikos?.refreshThirdPartyModules?.();
      }
      await saveModuleListState(list);
      window.oikos?.showToast(t('settings.thirdPartyModulesSaved'), 'success');
      render(container, { user });
    } catch (err) {
      input.checked = !enabled;
      window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      input.disabled = false;
    }
  });
}

// --------------------------------------------------------
// Event-Binding
// --------------------------------------------------------

function bindEvents(container, user, users, categories, icsSubscriptions, apiTokens, thirdPartyModules = []) {
  bindSettingsDateInputs(container);
  bindPwaInstallEvents(container);
  bindCategoryEvents(container);
  bindIcsEvents(container, user, icsSubscriptions);
  bindApiTokenEvents(container, apiTokens);
  bindModuleListEvents(container, user, thirdPartyModules);
  if (typeof bindBackupEvents === 'function') bindBackupEvents(container);
  // Theme-Toggle
  const themeToggle = container.querySelector('#theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-value]');
      if (!btn) return;
      const value = btn.dataset.themeValue;
      applyTheme(value);
      themeToggle.querySelectorAll('.theme-toggle__btn').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('theme-toggle__btn--active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    });
  }

  // Meal-Type-Toggles
  const mealToggles = container.querySelector('#meal-type-toggles');
  if (mealToggles) {
    mealToggles.addEventListener('change', async () => {
      const checked = [...mealToggles.querySelectorAll('input:checked')].map((cb) => cb.value);
      if (checked.length === 0) {
        window.oikos?.showToast(t('settings.mealTypesMinOne'), 'danger');
        // Revert: re-check all
        mealToggles.querySelectorAll('input').forEach((cb) => { cb.checked = true; });
        return;
      }
      try {
        await api.put('/preferences', { visible_meal_types: checked });
        window.oikos?.showToast(t('settings.mealTypesSaved'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
      }
    });
  }

  // Währungs-Auswahl
  const currencySelect = container.querySelector('#currency-select');
  if (currencySelect) {
    currencySelect.addEventListener('change', async () => {
      try {
        await api.put('/preferences', { currency: currencySelect.value });
        window.oikos?.showToast(t('settings.currencySaved'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
      }
    });
  }

  const dateFormatSelect = container.querySelector('#date-format-select');
  if (dateFormatSelect) {
    dateFormatSelect.addEventListener('change', async () => {
      try {
        await api.put('/preferences', { date_format: dateFormatSelect.value });
        try { localStorage.setItem('oikos-date-format', dateFormatSelect.value); } catch (_) {}
        window.dispatchEvent(new CustomEvent('date-format-changed', { detail: { dateFormat: dateFormatSelect.value } }));
        window.oikos?.showToast(t('settings.dateFormatSavedToast'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
      }
    });
  }

  const timeFormatSelect = container.querySelector('#time-format-select');
  if (timeFormatSelect) {
    timeFormatSelect.addEventListener('change', async () => {
      try {
        await api.put('/preferences', { time_format: timeFormatSelect.value });
        try { localStorage.setItem('oikos-time-format', timeFormatSelect.value); } catch (_) {}
        window.dispatchEvent(new CustomEvent('time-format-changed', { detail: { timeFormat: timeFormatSelect.value } }));
        window.oikos?.showToast(t('settings.timeFormatSavedToast'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
      }
    });
  }

  const housekeepingPaymentTasks = container.querySelector('#housekeeping-payment-tasks');
  if (housekeepingPaymentTasks) {
    housekeepingPaymentTasks.addEventListener('change', async () => {
      try {
        await api.put('/preferences', { housekeeping_payment_tasks: housekeepingPaymentTasks.checked });
        window.oikos?.showToast(t('settings.housekeepingPaymentTasksSaved'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        housekeepingPaymentTasks.checked = !housekeepingPaymentTasks.checked;
      }
    });
  }

  // ── Weather config (admin) ────────────────────────────────────────────────
  const weatherForm = container.querySelector('#weather-form');
  if (weatherForm) {
    weatherForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const lat   = container.querySelector('#weather-lat').value.trim();
      const lon   = container.querySelector('#weather-lon').value.trim();
      const city  = container.querySelector('#weather-city').value.trim();
      const units = container.querySelector('#weather-units').value;
      const errEl = container.querySelector('#weather-form-error');
      errEl.hidden = true;

      if (!lat || !lon) {
        errEl.textContent = `${t('settings.weatherLatLabel')} / ${t('settings.weatherLonLabel')}`;
        errEl.hidden = false;
        return;
      }

      try {
        await api.put('/preferences', {
          weather_lat:      lat,
          weather_lon:      lon,
          weather_city:     city,
          weather_units:    units,
          weather_provider: 'open-meteo',
        });
        window.oikos?.showToast(t('settings.weatherSaved'), 'success');
        // Seite neu rendern, damit der Status (aktiver Anbieter) + der
        // Deaktivieren-Button aktualisiert werden. settings.js importiert kein
        // navigate; daher der globale Router wie bei den anderen Handlern.
        window.oikos?.navigate('/settings');
      } catch (err) {
        errEl.textContent = err.message ?? t('common.errorGeneric');
        errEl.hidden = false;
      }
    });

    const removeBtn = container.querySelector('#weather-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        try {
          // weather_provider auf null setzt auf Auto-Detect (env) zurück; die
          // gespeicherten Koordinaten bleiben erhalten, werden aber ignoriert.
          await api.put('/preferences', { weather_provider: null });
          window.oikos?.showToast(t('settings.weatherRemoved'), 'success');
          window.oikos?.navigate('/settings');
        } catch (err) {
          window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        }
      });
    }

    const locateBtn = container.querySelector('#weather-locate-btn');
    if (locateBtn) {
      locateBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
          window.oikos?.showToast(t('settings.weatherLocateUnsupported'), 'warning');
          return;
        }
        locateBtn.disabled = true;
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            const lat = position.coords.latitude.toFixed(4);
            const lon = position.coords.longitude.toFixed(4);
            container.querySelector('#weather-lat').value = lat;
            container.querySelector('#weather-lon').value = lon;
            try {
              const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
              if (res.ok) {
                const data = await res.json();
                const city = data.address?.city || data.address?.town || data.address?.village || data.address?.municipality || '';
                if (city) container.querySelector('#weather-city').value = city;
              }
            } catch { /* Ortsname bleibt leer wenn Reverse-Geocoding fehlschlägt */ }
            locateBtn.disabled = false;
            window.oikos?.showToast(t('settings.weatherLocateSuccess'), 'success');
          },
          (err) => {
            locateBtn.disabled = false;
            window.oikos?.showToast(err.message, 'danger');
          },
          { enableHighAccuracy: true, timeout: 8000 },
        );
      });
    }
  }

  // ── Holiday config (admin) ────────────────────────────────────────────────
  const holidaysForm = container.querySelector('#holidays-form');
  if (holidaysForm) {
    // Populate countries dropdown
    const countrySelect = container.querySelector('#holiday-country');
    const subdivisionSelect = container.querySelector('#holiday-subdivision');
    const syncBtn = container.querySelector('#holiday-sync-btn');
    const errEl = container.querySelector('#holidays-form-error');

    (async () => {
      try {
        const res = await api.get('/preferences/holidays/countries');
        const panel = container.querySelector('[data-panel="calendar"]');
        const savedCode = panel?.dataset.holidayCountry ?? '';
        for (const c of (res.data ?? [])) {
          const opt = document.createElement('option');
          opt.value = c.isoCode;
          opt.textContent = c.name;
          if (c.isoCode === savedCode) opt.selected = true;
          countrySelect.appendChild(opt);
        }
        // After populating country list, load subdivisions for saved country
        if (savedCode) {
          const savedSub = panel?.dataset.holidaySubdivision ?? '';
          await loadSubdivisions(savedCode, savedSub);
        }
      } catch { /* silently ignore if API unavailable */ }
    })();

    // Load subdivisions for a given country code
    async function loadSubdivisions(countryCode, selectedCode) {
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = t('settings.holidaySubdivisionNone');
      subdivisionSelect.replaceChildren(noneOpt);
      subdivisionSelect.disabled = true;
      if (!countryCode) return;
      try {
        const res = await api.get(`/preferences/holidays/subdivisions/${countryCode}`);
        for (const s of (res.data ?? [])) {
          const opt = document.createElement('option');
          opt.value = s.isoCode;
          opt.textContent = s.name;
          if (s.isoCode === selectedCode) opt.selected = true;
          subdivisionSelect.appendChild(opt);
        }
        if ((res.data ?? []).length > 0) subdivisionSelect.disabled = false;
      } catch { /* ignore */ }
    }

    // Set sync button initial state
    if (syncBtn) {
      const panel = container.querySelector('[data-panel="calendar"]');
      const savedCode = panel?.dataset.holidayCountry ?? '';
      syncBtn.disabled = !savedCode;
      if (!savedCode) syncBtn.title = t('settings.holidayCountryRequired');
    }

    countrySelect.addEventListener('change', () => {
      const code = countrySelect.value;
      loadSubdivisions(code, '');
      if (syncBtn) {
        syncBtn.disabled = !code;
        syncBtn.title = code ? '' : t('settings.holidayCountryRequired');
      }
    });

    // Show/hide color pickers based on toggles
    const showPublicCb  = container.querySelector('#holiday-show-public');
    const showSchoolCb  = container.querySelector('#holiday-show-school');
    const publicColorGr = container.querySelector('#holiday-public-color-group');
    const schoolColorGr = container.querySelector('#holiday-school-color-group');
    showPublicCb?.addEventListener('change', () => { if (publicColorGr) publicColorGr.hidden = !showPublicCb.checked; });
    showSchoolCb?.addEventListener('change', () => { if (schoolColorGr) schoolColorGr.hidden = !showSchoolCb.checked; });

    holidaysForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      const country     = countrySelect.value || null;
      const subdivision = subdivisionSelect.value || null;
      const showPublic  = container.querySelector('#holiday-show-public').checked;
      const showSchool  = container.querySelector('#holiday-show-school').checked;
      const publicColor = container.querySelector('#holiday-public-color').value;
      const schoolColor = container.querySelector('#holiday-school-color').value;
      try {
        await api.put('/preferences', {
          holiday_country:      country,
          holiday_subdivision:  subdivision,
          holiday_show_public:  showPublic,
          holiday_show_school:  showSchool,
          holiday_public_color: publicColor,
          holiday_school_color: schoolColor,
        });
        window.oikos?.showToast(t('settings.holidaySaved'), 'success');
      } catch (err) {
        errEl.textContent = err.message ?? t('common.errorGeneric');
        errEl.hidden = false;
      }
    });

    syncBtn?.addEventListener('click', async () => {
      if (!countrySelect.value) {
        window.oikos?.showToast(t('settings.holidayCountryRequired'), 'warning');
        return;
      }
      syncBtn.disabled = true;
      try {
        // Einstellungen zuerst speichern, damit sync() die aktuellen Werte liest.
        // Wenn noch kein Toggle aktiviert ist, Public Holidays automatisch einschalten.
        const showPublicCbEl  = container.querySelector('#holiday-show-public');
        const showSchoolCbEl  = container.querySelector('#holiday-show-school');
        const noneEnabled = !showPublicCbEl?.checked && !showSchoolCbEl?.checked;
        if (noneEnabled && showPublicCbEl) {
          showPublicCbEl.checked = true;
          const pubGrp = container.querySelector('#holiday-public-color-group');
          if (pubGrp) pubGrp.hidden = false;
        }
        await api.put('/preferences', {
          holiday_country:      countrySelect.value || null,
          holiday_subdivision:  subdivisionSelect.value || null,
          holiday_show_public:  container.querySelector('#holiday-show-public')?.checked ?? false,
          holiday_show_school:  container.querySelector('#holiday-show-school')?.checked ?? false,
          holiday_public_color: container.querySelector('#holiday-public-color')?.value ?? '#FF3B30',
          holiday_school_color: container.querySelector('#holiday-school-color')?.value ?? '#34C759',
        });

        const res = await api.post('/preferences/holidays/sync', {});
        const lastSyncLabel = container.querySelector('#holiday-last-sync-label');
        if (lastSyncLabel && res.data?.last_sync) {
          lastSyncLabel.textContent = t('settings.holidayLastSync', {
            date: new Date(res.data.last_sync).toLocaleString(),
          });
        }
        window.oikos?.showToast(t('settings.holidaySynced'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('settings.holidaySyncError'), 'danger');
      } finally {
        syncBtn.disabled = !countrySelect.value;
      }
    });
  }

  const appNameForm = container.querySelector('#app-name-form');
  if (appNameForm) {
    appNameForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = container.querySelector('#app-name-error');
      const input = container.querySelector('#app-name-input');
      errorEl.hidden = true;
      const value = input.value.trim();
      try {
        await api.put('/preferences', { app_name: value });
        try {
          if (value) localStorage.setItem(APP_NAME_STORAGE_KEY, value);
          else localStorage.removeItem(APP_NAME_STORAGE_KEY);
        } catch (_) {}
        input.value = value || DEFAULT_APP_NAME;
        window.dispatchEvent(new CustomEvent('app-name-changed', { detail: { appName: value || DEFAULT_APP_NAME } }));
        window.oikos?.showToast(t('settings.appNameSavedToast'), 'success');
      } catch (err) {
        showError(errorEl, err.message ?? t('common.errorGeneric'));
      }
    });

    container.querySelector('#app-name-reset-btn')?.addEventListener('click', async () => {
      const errorEl = container.querySelector('#app-name-error');
      const input = container.querySelector('#app-name-input');
      errorEl.hidden = true;
      input.value = DEFAULT_APP_NAME;
      try {
        await api.put('/preferences', { app_name: '' });
        try { localStorage.removeItem(APP_NAME_STORAGE_KEY); } catch (_) {}
        window.dispatchEvent(new CustomEvent('app-name-changed', { detail: { appName: DEFAULT_APP_NAME } }));
        window.oikos?.showToast(t('settings.appNameSavedToast'), 'success');
      } catch (err) {
        showError(errorEl, err.message ?? t('common.errorGeneric'));
      }
    });
  }

  const profileState = { avatarData: user?.avatar_data ?? null };
  const profileAvatarFile = container.querySelector('#profile-avatar-file');
  bindAvatarPicker(container, 'profile');
  if (profileAvatarFile) {
    profileAvatarFile.addEventListener('change', async () => {
      const errorEl = container.querySelector('#profile-error');
      errorEl.hidden = true;
      try {
        const avatarData = await readImageAsDataUrl(profileAvatarFile.files?.[0]);
        if (avatarData !== undefined) {
          profileState.avatarData = avatarData;
          setAvatarPreview(container, '#profile-avatar-preview', {
            display_name: container.querySelector('#profile-display-name')?.value || user?.display_name,
            avatar_color: container.querySelector('#profile-avatar-color')?.value || user?.avatar_color,
            avatar_data: avatarData,
          });
        } else {
          profileAvatarFile.value = '';
        }
      } catch (err) {
        profileAvatarFile.value = '';
        showError(errorEl, err.message ?? t('common.errorGeneric'));
      }
    });
  }

  container.querySelector('#profile-avatar-remove')?.addEventListener('click', () => {
    profileState.avatarData = null;
    if (profileAvatarFile) profileAvatarFile.value = '';
    setAvatarPreview(container, '#profile-avatar-preview', {
      display_name: container.querySelector('#profile-display-name')?.value || user?.display_name,
      avatar_color: container.querySelector('#profile-avatar-color')?.value || user?.avatar_color,
      avatar_data: null,
    });
  });

  const profileForm = container.querySelector('#profile-form');
  if (profileForm) {
    profileForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = container.querySelector('#profile-error');
      const btn = profileForm.querySelector('[type=submit]');
      const birthDateRaw = container.querySelector('#profile-birth-date')?.value || '';
      errorEl.hidden = true;
      if (!isDateInputValid(birthDateRaw)) {
        showError(errorEl, t('settings.memberBirthDateInvalid'));
        return;
      }
      btn.disabled = true;
      try {
        const res = await auth.updateProfile({
          display_name: container.querySelector('#profile-display-name').value.trim(),
          avatar_color: container.querySelector('#profile-avatar-color').value,
          avatar_data: profileState.avatarData,
          phone: container.querySelector('#profile-phone')?.value.trim() || null,
          email: container.querySelector('#profile-email')?.value.trim() || null,
          birth_date: parseDateInput(birthDateRaw) || null,
        });
        Object.assign(user, res.user);
        window.oikos?.showToast(t('settings.profileSavedToast'), 'success');
        render(container, { user });
      } catch (err) {
        showError(errorEl, err.message ?? t('common.errorGeneric'));
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Passwort ändern
  const passwordForm = container.querySelector('#password-form');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPw  = container.querySelector('#current-password').value;
      const newPw      = container.querySelector('#new-password').value;
      const confirmPw  = container.querySelector('#confirm-password').value;
      const errorEl    = container.querySelector('#password-error');

      errorEl.hidden = true;

      if (newPw !== confirmPw) {
        showError(errorEl, t('settings.passwordMismatch'));
        return;
      }

      const btn = passwordForm.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await api.patch('/auth/me/password', { current_password: currentPw, new_password: newPw });
        passwordForm.reset();
        window.oikos?.showToast(t('settings.passwordSavedToast'), 'success');
      } catch (err) {
        showError(errorEl, err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Google Sync
  const googleSyncBtn = container.querySelector('#google-sync-btn');
  if (googleSyncBtn) {
    googleSyncBtn.addEventListener('click', async () => {
      googleSyncBtn.disabled = true;
      googleSyncBtn.textContent = t('settings.synchronizing');
      try {
        await api.post('/calendar/google/sync', {});
        window.oikos?.showToast(t('settings.syncSuccess', { provider: 'Google Calendar' }), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      } finally {
        googleSyncBtn.disabled = false;
        googleSyncBtn.textContent = t('settings.syncNow');
      }
    });
  }

  // Google Kalenderauswahl (Admin) – Mehrkalender-Checkboxliste laden + togglen
  const googleListEl = container.querySelector('#google-calendars-list');
  if (googleListEl) {
    // Toggle-Handler wird pro Checkbox gebunden, nachdem die Liste async geladen ist.
    const bindGoogleToggle = (checkbox) => {
      checkbox.addEventListener('change', async () => {
        const calendarId = checkbox.dataset.calendarId;
        const enabled = checkbox.checked;
        try {
          await api.patch('/calendar/google/calendars', { calendarId, enabled });
          window.oikos?.showToast(
            enabled ? t('settings.calendarEnabled') : t('settings.calendarDisabled'),
            'success'
          );
        } catch (err) {
          checkbox.checked = !enabled; // revert on failure
          window.oikos?.showToast(err.message, 'danger');
        }
      });
    };

    (async () => {
      try {
        const { data } = await api.get('/calendar/google/calendars');
        const calendars = data || [];
        googleListEl.replaceChildren();
        for (const cal of calendars) {
          const label = document.createElement('label');
          label.className = 'caldav-calendar-item';

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'google-calendar-checkbox';
          cb.dataset.calendarId = cal.id;
          cb.checked = !!cal.enabled;

          const dot = document.createElement('span');
          dot.className = 'caldav-calendar-color';
          dot.style.backgroundColor = cal.backgroundColor || 'var(--color-accent)';

          const name = document.createElement('span');
          name.className = 'caldav-calendar-name';
          name.textContent = cal.summary || cal.id;

          label.append(cb, dot, name);
          googleListEl.appendChild(label);
          bindGoogleToggle(cb);
        }
      } catch (err) {
        const p = document.createElement('p');
        p.className = 'form-hint';
        p.textContent = err.message;
        googleListEl.replaceChildren(p);
      }
    })();
  }

  const googleReadonlyCb = container.querySelector('#google-readonly-cb');
  if (googleReadonlyCb) {
    googleReadonlyCb.addEventListener('change', async () => {
      const enabled = googleReadonlyCb.checked;
      googleReadonlyCb.disabled = true;
      try {
        await api.put('/calendar/google/readonly', { readonly: enabled });
      } catch (err) {
        googleReadonlyCb.checked = !enabled;
        window.oikos?.showToast(err?.message ?? t('common.errorGeneric'), 'danger');
      } finally {
        googleReadonlyCb.disabled = false;
      }
    });
  }

  // Google Disconnect (Admin)
  const googleDisconnectBtn = container.querySelector('#google-disconnect-btn');
  if (googleDisconnectBtn) {
    googleDisconnectBtn.addEventListener('click', async () => {
      if (!await confirmModal(t('settings.googleDisconnectConfirm'), { danger: true })) return;
      try {
        await api.delete('/calendar/google/disconnect');
        window.oikos?.showToast(t('settings.disconnectedToast', { provider: 'Google Calendar' }), 'default');
        window.oikos?.navigate('/settings');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  }

  // Apple Sync
  const appleSyncBtn = container.querySelector('#apple-sync-btn');
  if (appleSyncBtn) {
    appleSyncBtn.addEventListener('click', async () => {
      appleSyncBtn.disabled = true;
      appleSyncBtn.textContent = t('settings.synchronizing');
      try {
        await api.post('/calendar/apple/sync', {});
        window.oikos?.showToast(t('settings.syncSuccess', { provider: 'Apple Calendar' }), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      } finally {
        appleSyncBtn.disabled = false;
        appleSyncBtn.textContent = t('settings.syncNow');
      }
    });
  }

  // Apple Disconnect (Admin)
  const appleDisconnectBtn = container.querySelector('#apple-disconnect-btn');
  if (appleDisconnectBtn) {
    appleDisconnectBtn.addEventListener('click', async () => {
      if (!await confirmModal(t('settings.appleDisconnectConfirm'), { danger: true })) return;
      try {
        await api.delete('/calendar/apple/disconnect');
        window.oikos?.showToast(t('settings.disconnectedToast', { provider: 'Apple Calendar' }), 'default');
        window.oikos?.navigate('/settings');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  }

  // Apple Connect-Formular (Admin)
  const appleConnectForm = container.querySelector('#apple-connect-form');
  if (appleConnectForm) {
    appleConnectForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = container.querySelector('#apple-connect-error');
      errorEl.hidden = true;

      const url      = container.querySelector('#apple-caldav-url').value.trim();
      const username = container.querySelector('#apple-username').value.trim();
      const password = container.querySelector('#apple-password').value;
      const btn      = container.querySelector('#apple-connect-btn');

      btn.disabled = true;
      btn.textContent = t('settings.appleConnecting');
      try {
        await api.post('/calendar/apple/connect', { url, username, password });
        window.oikos?.showToast(t('settings.appleConnectedToast'), 'success');
        window.oikos?.navigate('/settings');
      } catch (err) {
        showError(errorEl, err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = t('settings.appleConnectBtn');
      }
    });
  }


  // CalDAV add account button
  const caldavAddBtn = container.querySelector('#caldav-add-account-btn');
  if (caldavAddBtn) {
    caldavAddBtn.addEventListener('click', () => {
      openModal({
        title: t('settings.caldavAddAccount'),
        size: 'sm',
        content: `
          <form id="caldav-add-form" novalidate autocomplete="off">
            <div class="form-group">
              <label class="form-label" for="caldav-name">${t('settings.caldavNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
              <input class="form-input" type="text" id="caldav-name" required
                     placeholder="${t('settings.caldavNamePlaceholder')}" maxlength="100" />
            </div>
            <div class="form-group">
              <label class="form-label" for="caldav-url">${t('settings.caldavUrlLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
              <input class="form-input" type="url" id="caldav-url" required
                     placeholder="${t('settings.caldavUrlPlaceholder')}" />
              <small class="form-hint">${t('settings.caldavUrlHint')}</small>
            </div>
            <div class="form-group">
              <label class="form-label" for="caldav-username">${t('settings.caldavUsernameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
              <input class="form-input" type="text" id="caldav-username" required autocomplete="username" />
            </div>
            <div class="form-group">
              <label class="form-label" for="caldav-password">${t('settings.caldavPasswordLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
              <input class="form-input" type="password" id="caldav-password" required autocomplete="current-password" />
              <small class="form-hint">${t('settings.caldavPasswordHint')}</small>
            </div>
            <div id="caldav-add-error" class="form-error" hidden></div>
            <div class="modal-actions">
              <button type="button" class="btn btn--ghost" id="caldav-add-cancel">${t('common.cancel')}</button>
              <button type="submit" class="btn btn--primary">${t('common.save')}</button>
            </div>
          </form>
        `,
        onSave: (panel) => {
          const form = panel.querySelector('#caldav-add-form');
          const errorEl = panel.querySelector('#caldav-add-error');

          panel.querySelector('#caldav-add-cancel')?.addEventListener('click', () => closeModal({ force: true }));

          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            errorEl.hidden = true;

            const name = panel.querySelector('#caldav-name').value.trim();
            const caldavUrl = panel.querySelector('#caldav-url').value.trim();
            const username = panel.querySelector('#caldav-username').value.trim();
            const password = panel.querySelector('#caldav-password').value;

            if (!name || !caldavUrl || !username || !password) {
              showError(errorEl, t('common.requiredFields'));
              return;
            }

            try {
              await api.post('/calendar/caldav/accounts', {
                name,
                caldavUrl,
                username,
                password,
              });
              closeModal({ force: true });
              window.oikos?.showToast(t('settings.caldavAccountAdded'), 'success');
              await loadCalDAVAccounts(container, user);
            } catch (err) {
              showError(errorEl, err.message);
            }
          });
        },
      });
    });
  }

  // CardDAV add account button
  const cardavAddBtn = container.querySelector('#cardav-add-account-btn');
  if (cardavAddBtn) {
    cardavAddBtn.addEventListener('click', () => {
      openModal({
        title: t('settings.cardavAddAccount'),
        size: 'sm',
        content: `
          <form id="cardav-add-form" novalidate autocomplete="off">
            <div class="form-group">
              <label class="form-label" for="cardav-name">${t('settings.cardavNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
              <input class="form-input" type="text" id="cardav-name" required
                     placeholder="${t('settings.cardavNamePlaceholder')}" maxlength="100" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cardav-url">${t('settings.cardavUrlLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
              <input class="form-input" type="url" id="cardav-url" required
                     placeholder="${t('settings.cardavUrlPlaceholder')}" />
              <small class="form-hint">${t('settings.cardavUrlHint')}</small>
            </div>
            <div class="form-group">
              <label class="form-label" for="cardav-username">${t('settings.cardavUsernameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
              <input class="form-input" type="text" id="cardav-username" required autocomplete="username" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cardav-password">${t('settings.cardavPasswordLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
              <input class="form-input" type="password" id="cardav-password" required autocomplete="current-password" />
              <small class="form-hint">${t('settings.cardavPasswordHint')}</small>
            </div>
            <div id="cardav-add-error" class="form-error" hidden></div>
            <div class="modal-actions">
              <button type="button" class="btn btn--ghost" id="cardav-add-cancel">${t('common.cancel')}</button>
              <button type="submit" class="btn btn--primary">${t('common.save')}</button>
            </div>
          </form>
        `,
        onSave: (panel) => {
          const form = panel.querySelector('#cardav-add-form');
          const errorEl = panel.querySelector('#cardav-add-error');

          panel.querySelector('#cardav-add-cancel')?.addEventListener('click', () => closeModal({ force: true }));

          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            errorEl.hidden = true;

            const name = panel.querySelector('#cardav-name').value.trim();
            const cardavUrl = panel.querySelector('#cardav-url').value.trim();
            const username = panel.querySelector('#cardav-username').value.trim();
            const password = panel.querySelector('#cardav-password').value;

            if (!name || !cardavUrl || !username || !password) {
              showError(errorEl, t('common.allFieldsRequired'));
              return;
            }

            try {
              await api.post('/contacts/cardav/accounts', {
                name,
                cardavUrl,
                username,
                password,
              });
              closeModal({ force: true });
              window.oikos?.showToast(t('settings.cardavAccountAdded'), 'success');
              await loadCardDAVAccounts(container, user);
            } catch (err) {
              showError(errorEl, err.message);
            }
          });
        },
      });
    });
  }

  // Mitglied hinzufügen (Admin)
  const addMemberBtn = container.querySelector('#add-member-btn');
  if (addMemberBtn) {
    addMemberBtn.addEventListener('click', () => {
      container.querySelector('#add-member-form-card').classList.remove('settings-card--hidden');
      addMemberBtn.hidden = true;
    });
  }

  const cancelAddMember = container.querySelector('#cancel-add-member');
  if (cancelAddMember) {
    cancelAddMember.addEventListener('click', () => {
      container.querySelector('#add-member-form-card').classList.add('settings-card--hidden');
      container.querySelector('#add-member-btn').hidden = false;
      container.querySelector('#add-member-form').reset();
      container.querySelector('#new-avatar-color').value = randomAvatarColor();
      container.querySelector('#member-error').hidden = true;
    });
  }

  const addMemberForm = container.querySelector('#add-member-form');
  if (addMemberForm) {
    addMemberForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = container.querySelector('#member-error');
      errorEl.hidden = true;
      const birthDateRaw = container.querySelector('#new-member-birth-date')?.value || '';
      if (!isDateInputValid(birthDateRaw)) {
        showError(errorEl, t('settings.memberBirthDateInvalid'));
        return;
      }

      const data = {
        username:     container.querySelector('#new-username').value.trim(),
        display_name: container.querySelector('#new-display-name').value.trim(),
        password:     container.querySelector('#new-member-password').value,
        avatar_color: container.querySelector('#new-avatar-color').value,
        family_role:  container.querySelector('#new-family-role').value,
        system_admin: container.querySelector('#new-system-admin')?.checked === true,
        phone:        container.querySelector('#new-member-phone')?.value.trim() || null,
        email:        container.querySelector('#new-member-email')?.value.trim() || null,
        birth_date:   parseDateInput(birthDateRaw) || null,
      };

      const btn = addMemberForm.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const res  = await auth.createUser(data);
        const list = container.querySelector('#members-list');
        users.push(res.user);
        list.insertAdjacentHTML('beforeend', memberHtml(res.user));
        addMemberForm.reset();
        container.querySelector('#new-avatar-color').value = randomAvatarColor();
        container.querySelector('#add-member-form-card').classList.add('settings-card--hidden');
        container.querySelector('#add-member-btn').hidden = false;
        window.oikos?.showToast(t('settings.memberAddedToast', { name: res.user.display_name }), 'success');
        bindDeleteButtons(container, user);
        bindEditButtons(container, user, users);
      } catch (err) {
        showError(errorEl, err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  bindDeleteButtons(container, user);
  bindEditButtons(container, user, users);

  // Abmelden
  const logoutBtn = container.querySelector('#logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await auth.logout();
      } finally {
        if (window.oikos?.navigate) {
          window.oikos.navigate('/login');
        } else {
          window.location.replace('/login');
        }
      }
    });
  }
}

// --------------------------------------------------------
function bindDeleteButtons(container, user) {
  container.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true)); // Doppelte Listener vermeiden
  });
  container.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id   = parseInt(btn.dataset.deleteUser, 10);
      const name = btn.dataset.name;
      if (!await confirmModal(t('settings.deleteMemberConfirm', { name }), { danger: true, confirmLabel: t('common.delete') })) return;
      try {
        await auth.deleteUser(id);
        btn.closest('.settings-member').remove();
        window.oikos?.showToast(t('settings.memberDeletedToast', { name }), 'default');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  });
}

function bindEditButtons(container, currentUser, users) {
  container.querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  container.querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.editUser, 10);
      const member = users.find((u) => u.id === id);
      if (member) openEditMemberModal(member, currentUser, users, container);
    });
  });
}

function openEditMemberModal(member, currentUser, users, container) {
  const state = { avatarData: member.avatar_data ?? null };
  openModal({
    title: t('settings.editMemberTitle'),
    size: 'md',
    content: `
      <form id="edit-member-form" class="settings-form">
        <div class="settings-profile-editor">
          ${avatarEditorHtml(member, 'edit-member')}
          <div class="settings-profile-editor__fields">
            <div class="form-group">
              <label class="form-label" for="edit-member-username">${t('settings.usernameLabel')}</label>
              <input class="form-input" type="text" id="edit-member-username" value="${esc(member.username)}" required autocomplete="off" />
            </div>
            <div class="settings-name-color-row">
              <div class="form-group settings-name-color-row__name">
                <label class="form-label" for="edit-member-display-name">${t('settings.displayNameLabel')}</label>
                <input class="form-input" type="text" id="edit-member-display-name" value="${esc(member.display_name)}" required maxlength="128" />
              </div>
              <div class="form-group settings-color-field">
                <label class="form-label" for="edit-member-avatar-color">${t('settings.colorLabel')}</label>
                <input class="settings-color-button" type="color" id="edit-member-avatar-color" value="${esc(member.avatar_color || '#007AFF')}" />
              </div>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-member-family-role">${t('settings.familyRoleLabel')}</label>
          <select class="form-input" id="edit-member-family-role">
            ${buildFamilyRoleOptions(member.family_role)}
          </select>
        </div>
        <div class="modal-grid modal-grid--2">
          <div class="form-group">
            <label class="form-label" for="edit-member-phone">${t('settings.memberPhoneLabel')}</label>
            <input class="form-input" type="tel" id="edit-member-phone" value="${esc(member.phone || '')}" autocomplete="tel" />
          </div>
          <div class="form-group">
            <label class="form-label" for="edit-member-email">${t('settings.memberEmailLabel')}</label>
            <input class="form-input" type="email" id="edit-member-email" value="${esc(member.email || '')}" autocomplete="email" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-member-birth-date">${t('settings.memberBirthDateLabel')}</label>
          <input class="form-input" type="date" id="edit-member-birth-date" value="${esc(member.birth_date || '')}" />
          <p class="form-hint">${t('settings.memberContactBirthdayHint')}</p>
        </div>
        <label class="toggle-row">
          <input type="checkbox" id="edit-member-system-admin" ${member.role === 'admin' ? 'checked' : ''} />
          <span>${t('settings.systemAdminLabel')}</span>
        </label>
        <p class="form-hint">${t('settings.systemAdminHint')}</p>
        <div id="edit-member-error" class="form-error" hidden></div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="edit-member-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary">${t('settings.saveMember')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      const fileInput = panel.querySelector('#edit-member-avatar-file');
      const errorEl = panel.querySelector('#edit-member-error');
      bindSettingsDateInputs(panel);
      bindAvatarPicker(panel, 'edit-member');
      fileInput?.addEventListener('change', async () => {
        errorEl.hidden = true;
        try {
          const avatarData = await readImageAsDataUrl(fileInput.files?.[0]);
          if (avatarData !== undefined) {
            state.avatarData = avatarData;
            setAvatarPreview(panel, '#edit-member-avatar-preview', {
              display_name: panel.querySelector('#edit-member-display-name')?.value || member.display_name,
              avatar_color: panel.querySelector('#edit-member-avatar-color')?.value || member.avatar_color,
              avatar_data: avatarData,
            });
          } else {
            fileInput.value = '';
          }
        } catch (err) {
          fileInput.value = '';
          showError(errorEl, err.message ?? t('common.errorGeneric'));
        }
      });

      panel.querySelector('#edit-member-avatar-remove')?.addEventListener('click', () => {
        state.avatarData = null;
        if (fileInput) fileInput.value = '';
        setAvatarPreview(panel, '#edit-member-avatar-preview', {
          display_name: panel.querySelector('#edit-member-display-name')?.value || member.display_name,
          avatar_color: panel.querySelector('#edit-member-avatar-color')?.value || member.avatar_color,
          avatar_data: null,
        });
      });

      panel.querySelector('#edit-member-cancel')?.addEventListener('click', closeModal);
      panel.querySelector('#edit-member-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type=submit]');
        errorEl.hidden = true;
        const birthDateRaw = panel.querySelector('#edit-member-birth-date')?.value || '';
        if (!isDateInputValid(birthDateRaw)) {
          showError(errorEl, t('settings.memberBirthDateInvalid'));
          submitBtn.disabled = false;
          return;
        }
        submitBtn.disabled = true;
        try {
          const res = await auth.updateUser(member.id, {
            username: panel.querySelector('#edit-member-username').value.trim(),
            display_name: panel.querySelector('#edit-member-display-name').value.trim(),
            avatar_color: panel.querySelector('#edit-member-avatar-color').value,
            avatar_data: state.avatarData,
            family_role: panel.querySelector('#edit-member-family-role').value,
            system_admin: panel.querySelector('#edit-member-system-admin').checked,
            phone: panel.querySelector('#edit-member-phone')?.value.trim() || null,
            email: panel.querySelector('#edit-member-email')?.value.trim() || null,
            birth_date: parseDateInput(birthDateRaw) || null,
          });
          const idx = users.findIndex((u) => u.id === member.id);
          if (idx !== -1) users[idx] = res.user;
          if (currentUser.id === member.id) Object.assign(currentUser, res.user);
          closeModal({ force: true });
          window.oikos?.showToast(t('settings.memberUpdatedToast', { name: res.user.display_name }), 'success');
          render(container, { user: currentUser });
        } catch (err) {
          showError(errorEl, err.message ?? t('common.errorGeneric'));
        } finally {
          submitBtn.disabled = false;
        }
      });
    },
  });
}

function apiTokenHtml(token) {
  const status = token.revoked_at
    ? t('settings.apiTokenRevoked')
    : token.expires_at && new Date(token.expires_at).getTime() <= Date.now()
      ? t('settings.apiTokenExpired')
      : t('settings.apiTokenActive');
  const meta = [
    `${t('settings.apiTokenPrefix')}: ${token.token_prefix}...`,
    token.expires_at ? `${t('settings.apiTokenExpires')}: ${formatDateTime(token.expires_at)}` : t('settings.apiTokenNeverExpires'),
    token.last_used_at ? `${t('settings.apiTokenLastUsed')}: ${formatDateTime(token.last_used_at)}` : t('settings.apiTokenNeverUsed'),
    status,
  ].join(' · ');

  return `
    <li class="settings-member" data-api-token-id="${token.id}">
      <div class="settings-member__info">
        <span class="settings-member__name">${esc(token.name)}</span>
        <span class="settings-member__meta">${esc(meta)}</span>
      </div>
      <button class="btn btn--icon btn--danger-outline" data-revoke-api-token="${token.id}" data-name="${esc(token.name)}" ${token.revoked_at ? 'disabled' : ''} aria-label="${t('settings.apiTokenRevoke')}">
        <i data-lucide="ban" aria-hidden="true"></i>
      </button>
    </li>
  `;
}

function renderApiTokenList(container, tokens) {
  const list = container.querySelector('#api-token-list');
  if (!list) return;
  list.replaceChildren();
  tokens.forEach((token) => {
    const tmp = document.createElement('div');
    tmp.insertAdjacentHTML('beforeend', apiTokenHtml(token));
    list.appendChild(tmp.firstElementChild);
  });
  if (window.lucide) window.lucide.createIcons({ el: list });
}

function datetimeLocalToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function bindApiTokenEvents(container, initialTokens) {
  const form = container.querySelector('#api-token-form');
  const list = container.querySelector('#api-token-list');
  if (!form || !list) return;

  let tokens = [...initialTokens];

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = container.querySelector('#api-token-error');
    const output = container.querySelector('#api-token-created');
    const outputValue = container.querySelector('#api-token-created-value');
    errorEl.hidden = true;
    output.hidden = true;

    const name = container.querySelector('#api-token-name').value.trim();
    const expiresValue = container.querySelector('#api-token-expires').value;
    const expires_at = datetimeLocalToIso(expiresValue);
    if (expiresValue && !expires_at) {
      showError(errorEl, t('settings.apiTokenInvalidExpiration'));
      return;
    }

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const res = await api.post('/auth/api-tokens', { name, expires_at });
      tokens.unshift(res.data);
      renderApiTokenList(container, tokens);
      form.reset();
      outputValue.value = res.token;
      output.hidden = false;
      outputValue.focus();
      outputValue.select();
      window.oikos?.showToast(t('settings.apiTokenCreatedToast'), 'success');
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke-api-token]');
    if (!btn) return;
    const id = Number(btn.dataset.revokeApiToken);
    const name = btn.dataset.name;
    if (!await confirmModal(t('settings.apiTokenRevokeConfirm', { name }), { danger: true, confirmLabel: t('settings.apiTokenRevoke') })) return;
    try {
      await api.delete(`/auth/api-tokens/${id}`);
      tokens = tokens.map((token) => token.id === id ? { ...token, revoked_at: new Date().toISOString() } : token);
      renderApiTokenList(container, tokens);
      window.oikos?.showToast(t('settings.apiTokenRevokedToast'), 'default');
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  });
}

async function loadBackupSchedulerStatus(container) {
  const infoContainer = container.querySelector('#backup-scheduler-info');
  if (!infoContainer) return;

  try {
    const res = await api.get('/backup/status');
    const scheduler = res.data?.scheduler;
    if (!scheduler) return;

    const { enabled, schedule, keepCount, lastBackup } = scheduler;

    let lastBackupText = t('settings.backupSchedulerNever');
    if (lastBackup?.timestamp) {
      const date = formatDate(lastBackup.timestamp) + ' ' + formatTime(lastBackup.timestamp);
      lastBackupText = lastBackup.success
        ? t('settings.backupSchedulerLastSuccess', { date })
        : t('settings.backupSchedulerLastFail', { date });
    }

    const html = `
      <div class="settings-info-row">
        <span class="settings-info-label">${t('settings.backupSchedulerStatus')}</span>
        <span class="settings-info-value ${enabled ? 'settings-info-value--success' : ''}">
          ${enabled ? t('settings.backupSchedulerEnabled') : t('settings.backupSchedulerDisabled')}
        </span>
      </div>
      ${enabled ? `
        <div class="settings-info-row">
          <span class="settings-info-label">${t('settings.backupSchedulerSchedule')}</span>
          <span class="settings-info-value"><code>${esc(schedule)}</code></span>
        </div>
        <div class="settings-info-row">
          <span class="settings-info-label">${t('settings.backupSchedulerKeep')}</span>
          <span class="settings-info-value">${t('settings.backupSchedulerKeepCount', { count: keepCount })}</span>
        </div>
        <div class="settings-info-row">
          <span class="settings-info-label">${t('settings.backupSchedulerLastBackup')}</span>
          <span class="settings-info-value">${esc(lastBackupText)}</span>
        </div>
        <div class="settings-form-actions">
          <button class="btn btn--secondary" id="backup-trigger-btn">${t('settings.backupSchedulerTrigger')}</button>
        </div>
      ` : ''}
    `;

    infoContainer.replaceChildren();
    infoContainer.insertAdjacentHTML('beforeend', html);

    if (window.lucide) window.lucide.createIcons({ el: infoContainer });

    // Event-Handler für manuellen Trigger
    const triggerBtn = infoContainer.querySelector('#backup-trigger-btn');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', async () => {
        triggerBtn.disabled = true;
        triggerBtn.textContent = t('settings.backupSchedulerTriggering');
        try {
          await api.post('/backup/trigger');
          window.oikos?.showToast(t('settings.backupSchedulerTriggeredToast'), 'success');
          // Status neu laden
          loadBackupSchedulerStatus(container);
        } catch (err) {
          window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
          triggerBtn.disabled = false;
          triggerBtn.textContent = t('settings.backupSchedulerTrigger');
        }
      });
    }
  } catch (err) {
    console.error('Failed to load backup scheduler status:', err);
  }
}

// ─── WebDAV Backup ────────────────────────────────────────────────────────────

async function loadWebdavConfig(container) {
  const form       = container.querySelector('#backup-webdav-form');
  const statusGrid = container.querySelector('#backup-webdav-status');
  if (!form) return;

  try {
    const res = await api.get('/backup/webdav/config');
    const d   = res.data ?? {};

    const setVal = (id, val) => {
      const el = form.querySelector(`#${id}`);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = Boolean(val);
      else el.value = val ?? '';
    };

    setVal('webdav-enabled',  d.enabled);
    setVal('webdav-url',      d.envControlled ? d.url ?? '' : d.url ?? '');
    setVal('webdav-username', d.username ?? '');
    setVal('webdav-password', d.password ?? '');   // will show '****' if set
    setVal('webdav-path',     d.remotePath ?? '/oikos/backups/');
    setVal('webdav-keep',     d.keep ?? 7);

    // Mark fields read-only when controlled by env vars
    if (d.envControlled) {
      ['webdav-url', 'webdav-username', 'webdav-password', 'webdav-path', 'webdav-keep'].forEach((id) => {
        const el = form.querySelector(`#${id}`);
        if (el) {
          el.readOnly = true;
          el.disabled = true;
          el.style.opacity = '0.6';
        }
      });
      const hint = form.querySelector('#webdav-test-result');
      if (hint) {
        hint.hidden   = false;
        hint.textContent = t('settings.backupWebdavEnvHint');
        hint.className = 'form-hint';
      }
    }

    // Render status grid
    renderWebdavStatus(statusGrid, d);

    if (window.lucide) window.lucide.createIcons({ el: form });
  } catch (err) {
    console.error('Failed to load WebDAV config:', err);
  }
}

function renderWebdavStatus(grid, d) {
  if (!grid) return;
  if (!d.configured) { grid.replaceChildren(); return; }

  // Format date exactly like the scheduler status does
  const lastUploadValue = d.lastUpload
    ? formatDate(d.lastUpload) + ' ' + formatTime(d.lastUpload)
    : t('settings.backupWebdavNeverUploaded');

  const lastUploadColor = d.lastUpload ? 'var(--color-success)' : '';

  const errorRow = d.lastError
    ? `<div class="settings-info-row">
         <span class="settings-info-label">${t('settings.backupWebdavLastError')}</span>
         <span class="settings-info-value" style="color:var(--color-danger);word-break:break-all;">${esc(d.lastError)}</span>
       </div>`
    : '';

  grid.replaceChildren();
  grid.insertAdjacentHTML('beforeend', `
    <div class="settings-info-row">
      <span class="settings-info-label">${t('settings.backupWebdavLastUpload')}</span>
      <span class="settings-info-value" style="${lastUploadColor ? `color:${lastUploadColor};font-weight:var(--font-weight-semibold);` : ''}">${esc(lastUploadValue)}</span>
    </div>
    ${errorRow}
    <div class="settings-form-actions" style="margin-top:var(--space-2);">
      <button class="btn btn--secondary" id="webdav-trigger-btn">
        <i data-lucide="upload-cloud" aria-hidden="true"></i>
        ${t('settings.backupWebdavTriggerBtn')}
      </button>
    </div>
  `);

  if (window.lucide) window.lucide.createIcons({ el: grid });

  const triggerBtn = grid.querySelector('#webdav-trigger-btn');
  if (triggerBtn) {
    triggerBtn.addEventListener('click', async () => {
      triggerBtn.disabled = true;
      triggerBtn.textContent = t('settings.backupWebdavTriggering');
      try {
        await api.post('/backup/webdav/trigger');
        window.oikos?.showToast(t('settings.backupWebdavTriggeredToast'), 'success');
        loadWebdavConfig(triggerBtn.closest('.settings-tab-panel') ?? document);
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        const icon = document.createElement('i');
        icon.dataset.lucide = 'upload-cloud';
        icon.setAttribute('aria-hidden', 'true');
        triggerBtn.replaceChildren(icon, document.createTextNode(' ' + t('settings.backupWebdavTriggerBtn')));
        if (window.lucide) window.lucide.createIcons({ el: triggerBtn });
        triggerBtn.disabled = false;
      }
    });
  }
}

function bindWebdavBackupEvents(container) {
  const form      = container.querySelector('#backup-webdav-form');
  const testBtn   = container.querySelector('#webdav-test-btn');
  const resultEl  = container.querySelector('#webdav-test-result');
  if (!form) return;

  loadWebdavConfig(container);

  // Password reveal toggle
  form.querySelectorAll('[data-reveal-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = form.querySelector(`#${btn.dataset.revealTarget}`);
      if (!input) return;
      const isText = input.type === 'text';
      input.type = isText ? 'password' : 'text';
      const icon = btn.querySelector('[data-lucide]');
      if (icon) {
        icon.setAttribute('data-lucide', isText ? 'eye' : 'eye-off');
        if (window.lucide) window.lucide.createIcons({ el: btn });
      }
    });
  });

  // Connection test
  testBtn?.addEventListener('click', async () => {
    testBtn.disabled = true;
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = '…'; resultEl.className = 'form-hint'; }

    const overrides = {};
    const url      = form.querySelector('#webdav-url')?.value?.trim();
    const username = form.querySelector('#webdav-username')?.value?.trim();
    const password = form.querySelector('#webdav-password')?.value;
    const path     = form.querySelector('#webdav-path')?.value?.trim();

    if (url)                             overrides.url        = url;
    if (username)                        overrides.username   = username;
    if (password && password !== '****') overrides.password   = password;
    if (path)                            overrides.remotePath = path;

    try {
      const res = await api.post('/backup/webdav/test', overrides);
      if (resultEl) {
        resultEl.textContent = t('settings.backupWebdavTestSuccess', { files: res.data?.files ?? 0 });
        resultEl.className   = 'form-hint';
        resultEl.style.color = 'var(--color-success)';
      }
    } catch (err) {
      if (resultEl) {
        resultEl.textContent = t('settings.backupWebdavTestFailed', { error: err.message });
        resultEl.className   = 'form-hint';
        resultEl.style.color = 'var(--color-danger)';
      }
    } finally {
      testBtn.disabled = false;
    }
  });

  // Save form
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = form.querySelector('#webdav-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '…'; }

    const password = form.querySelector('#webdav-password')?.value;
    const payload  = {
      enabled:    form.querySelector('#webdav-enabled')?.checked ?? false,
      url:        form.querySelector('#webdav-url')?.value?.trim()     || null,
      username:   form.querySelector('#webdav-username')?.value?.trim() || null,
      remotePath: form.querySelector('#webdav-path')?.value?.trim()    || '/oikos/backups/',
      keep:       Number(form.querySelector('#webdav-keep')?.value)    || 7,
    };
    // Only send password if the user changed it (not the masked placeholder)
    if (password && password !== '****') payload.password = password;

    try {
      await api.put('/backup/webdav/config', payload);
      window.oikos?.showToast(t('settings.backupWebdavSaved'), 'success');
      loadWebdavConfig(container);
    } catch (err) {
      window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('settings.backupWebdavSaveBtn'); }
    }
  });
}

function bindBackupEvents(container) {
  // Scheduler-Status laden und anzeigen
  loadBackupSchedulerStatus(container);
  bindWebdavBackupEvents(container);

  const form = container.querySelector('#backup-restore-form');
  const fileInput = container.querySelector('#backup-restore-file');
  const selectedFile = container.querySelector('#backup-selected-file');
  const restoreBtn = container.querySelector('#backup-restore-btn');
  const errorEl = container.querySelector('#backup-restore-error');
  const dropzone = container.querySelector('#backup-dropzone');

  if (!form || !fileInput || !selectedFile || !restoreBtn || !errorEl) return;

  function setFile(file) {
    if (!file) {
      selectedFile.hidden = true;
      selectedFile.textContent = '';
      restoreBtn.disabled = true;
      return;
    }
    selectedFile.textContent = `${file.name} · ${Math.round(file.size / 1024)} KB`;
    selectedFile.hidden = false;
    restoreBtn.disabled = false;
  }

  fileInput.addEventListener('change', () => {
    errorEl.hidden = true;
    setFile(fileInput.files?.[0]);
  });

  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('settings-backup-dropzone--active');
  });

  dropzone?.addEventListener('dragleave', () => {
    dropzone.classList.remove('settings-backup-dropzone--active');
  });

  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('settings-backup-dropzone--active');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    errorEl.hidden = true;
    setFile(file);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!await confirmModal(t('settings.backupRestoreConfirm'), { danger: true, confirmLabel: t('settings.backupRestoreButton') })) return;

    errorEl.hidden = true;
    restoreBtn.disabled = true;
    restoreBtn.textContent = t('settings.backupRestoring');
    try {
      await api.rawPost('/backup/restore', file);
      window.oikos?.showToast(t('settings.backupRestoredToast'), 'success');
      window.location.reload();
    } catch (err) {
      showError(errorEl, err.message ?? t('common.errorGeneric'));
      restoreBtn.disabled = false;
      restoreBtn.textContent = t('settings.backupRestoreButton');
    }
  });
}


// --------------------------------------------------------
// Kategorie-Verwaltung
// --------------------------------------------------------

function categoryRowHtml(cat, isFirst, isLast) {
  return `
    <li class="cat-row" data-cat-id="${cat.id}">
      <i data-lucide="${esc(cat.icon)}" class="cat-row__icon" aria-hidden="true"></i>
      <span class="cat-row__name" data-action="rename-cat" title="${t('settings.shoppingCategoryRenameHint')}">${esc(catLabel(cat.name))}</span>
      <div class="cat-row__actions">
        <button class="btn btn--icon btn--ghost" data-action="move-cat-up" data-id="${cat.id}"
                aria-label="${t('settings.shoppingCategoryMoveUp')}"
                ${isFirst ? 'disabled' : ''}>
          <i data-lucide="chevron-up" class="icon-md" aria-hidden="true"></i>
        </button>
        <button class="btn btn--icon btn--ghost" data-action="move-cat-down" data-id="${cat.id}"
                aria-label="${t('settings.shoppingCategoryMoveDown')}"
                ${isLast ? 'disabled' : ''}>
          <i data-lucide="chevron-down" class="icon-md" aria-hidden="true"></i>
        </button>
        <button class="btn btn--icon btn--danger-outline" data-action="delete-cat" data-id="${cat.id}"
                aria-label="${t('settings.shoppingCategoryDelete')}">
          <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
        </button>
      </div>
    </li>`;
}

function renderCatList(container, cats) {
  const list = container.querySelector('#cat-list');
  if (!list) return;
  // DOM-API statt innerHTML (Security-Constraint des Projekts)
  list.replaceChildren();
  cats.forEach((c, i) => {
    const tmp = document.createElement('div');
    tmp.insertAdjacentHTML('beforeend', categoryRowHtml(c, i === 0, i === cats.length - 1));
    list.appendChild(tmp.firstElementChild);
  });
  if (window.lucide) window.lucide.createIcons({ el: list });
}

function bindCategoryEvents(container) {
  let cats = [];

  api.get('/shopping/categories').then((res) => {
    cats = res.data ?? [];
    renderCatList(container, cats);
  }).catch(() => {});

  const addForm = container.querySelector('#cat-add-form');
  if (addForm) {
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = container.querySelector('#cat-add-input');
      const name  = input.value.trim();
      if (!name) return;
      try {
        const res = await api.post('/shopping/categories', { name });
        cats.push(res.data);
        renderCatList(container, cats);
        input.value = '';
        input.focus();
        window.oikos?.showToast(t('settings.shoppingCategoryAdded'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
  }

  const catList = container.querySelector('#cat-list');
  if (!catList) return;

  catList.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const rowEl  = target.closest('[data-cat-id]');
    const id     = rowEl ? Number(rowEl.dataset.catId) : Number(target.dataset.id);

    if (action === 'rename-cat') {
      const cat = cats.find((c) => c.id === id);
      if (!cat) return;
      const { promptModal } = await import('/components/modal.js');
      const newName = await promptModal(t('settings.shoppingCategoryRenamePrompt'), catLabel(cat.name));
      if (!newName || newName === cat.name) return;
      try {
        const res = await api.put(`/shopping/categories/${id}`, { name: newName });
        const idx = cats.findIndex((c) => c.id === id);
        if (idx >= 0) cats[idx] = res.data;
        renderCatList(container, cats);
        window.oikos?.showToast(t('settings.shoppingCategoryRenamed'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    }

    if (action === 'move-cat-up') {
      const idx = cats.findIndex((c) => c.id === id);
      if (idx <= 0) return;
      [cats[idx - 1], cats[idx]] = [cats[idx], cats[idx - 1]];
      renderCatList(container, cats);
      try {
        await api.patch('/shopping/categories/reorder', { order: cats.map((c) => c.id) });
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    }

    if (action === 'move-cat-down') {
      const idx = cats.findIndex((c) => c.id === id);
      if (idx < 0 || idx >= cats.length - 1) return;
      [cats[idx], cats[idx + 1]] = [cats[idx + 1], cats[idx]];
      renderCatList(container, cats);
      try {
        await api.patch('/shopping/categories/reorder', { order: cats.map((c) => c.id) });
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    }

    if (action === 'delete-cat') {
      const cat = cats.find((c) => c.id === id);
      if (!cat) return;
      const { confirmModal: confirmDel } = await import('/components/modal.js');
      if (!await confirmDel(
        t('settings.shoppingCategoryDeleteConfirm', { name: catLabel(cat.name) }),
        { danger: true, confirmLabel: t('common.delete') }
      )) return;
      try {
        await api.delete(`/shopping/categories/${id}`);
        cats = cats.filter((c) => c.id !== id);
        renderCatList(container, cats);
        window.oikos?.showToast(t('settings.shoppingCategoryDeleted'), 'default');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    }
  });
}

function memberHtml(u) {
  const familyRole = familyRoleLabel(u.family_role);
  const systemRole = u.role === 'admin' ? ` · ${esc(t('settings.systemAdminBadge'))}` : '';
  const profileMeta = [
    u.phone ? t('settings.memberPhoneMeta', { value: u.phone }) : '',
    u.email || '',
    u.birth_date ? t('settings.memberBirthdayMeta', { date: formatDate(u.birth_date) }) : '',
  ].filter(Boolean).map(esc).join(' · ');
  return `
    <li class="settings-member" data-id="${u.id}">
      ${avatarHtml(u, 'settings-avatar settings-avatar--sm')}
      <div class="settings-member__info">
        <span class="settings-member__name">${esc(u.display_name)}</span>
        <span class="settings-member__meta">@${esc(u.username)} · ${esc(familyRole)}${systemRole}</span>
        ${profileMeta ? `<span class="settings-member__meta">${profileMeta}</span>` : ''}
      </div>
      <button class="btn btn--icon btn--secondary" data-edit-user="${u.id}" aria-label="${esc(u.display_name)} ${t('settings.editMemberLabel')}" title="${t('settings.editMemberLabel')}">
        <i data-lucide="edit-2" aria-hidden="true"></i>
      </button>
      <button class="btn btn--icon btn--danger-outline" data-delete-user="${u.id}" data-name="${esc(u.display_name)}" aria-label="${esc(u.display_name)} ${t('settings.deleteMemberLabel')}" title="${t('settings.deleteMemberLabel')}">
        <i data-lucide="trash-2" aria-hidden="true"></i>
      </button>
    </li>
  `;
}

// --------------------------------------------------------
// ICS-Abonnements
// --------------------------------------------------------

function renderIcsList(container, subs, user) {
  const listEl = container.querySelector('#ics-list-container');
  if (!listEl) return;
  listEl.replaceChildren();

  if (subs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.style.padding = 'var(--space-3) 0';
    empty.textContent = t('settings.ics.empty');
    listEl.appendChild(empty);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'settings-members';
  subs.forEach((sub) => {
    const li = document.createElement('li');
    li.className = 'settings-member';
    li.dataset.subId = sub.id;

    const dot = document.createElement('span');
    dot.className = 'settings-avatar settings-avatar--sm';
    dot.style.background = sub.color;
    dot.style.flexShrink = '0';
    li.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'settings-member__info';

    const nameLine = document.createElement('span');
    nameLine.className = 'settings-member__name';
    nameLine.textContent = sub.name;

    const badge = document.createElement('span');
    badge.className = `badge ${sub.shared ? 'badge--success' : 'badge--neutral'}`;
    badge.style.marginLeft = 'var(--space-2)';
    badge.textContent = sub.shared ? t('settings.ics.badges.shared') : t('settings.ics.badges.private');
    nameLine.appendChild(badge);
    info.appendChild(nameLine);

    const meta = document.createElement('span');
    meta.className = 'settings-member__meta';
    if (sub.last_sync) {
      const d = new Date(sub.last_sync);
      meta.textContent = `${t('settings.ics.status.lastSync')} ${formatDate(d)} ${formatTime(d)}`;
    } else {
      meta.textContent = t('settings.ics.status.never');
    }
    info.appendChild(meta);
    li.appendChild(info);

    const isOwner = sub.created_by === user.id || user.role === 'admin';
    if (isOwner) {
      const actions = document.createElement('div');
      actions.className = 'cat-row__actions';

      const syncBtn = document.createElement('button');
      syncBtn.className = 'btn btn--icon btn--ghost';
      syncBtn.title = t('settings.ics.actions.sync');
      syncBtn.setAttribute('aria-label', t('settings.ics.actions.sync'));
      syncBtn.dataset.action = 'ics-sync';
      syncBtn.dataset.id = sub.id;
      const syncIcon = document.createElement('i');
      syncIcon.setAttribute('data-lucide', 'refresh-cw');
      syncIcon.className = 'icon-md';
      syncIcon.setAttribute('aria-hidden', 'true');
      syncBtn.appendChild(syncIcon);
      actions.appendChild(syncBtn);

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn--icon btn--ghost';
      editBtn.title = t('settings.ics.actions.edit');
      editBtn.setAttribute('aria-label', t('settings.ics.actions.edit'));
      editBtn.dataset.action = 'ics-edit';
      editBtn.dataset.id = sub.id;
      const editIcon = document.createElement('i');
      editIcon.setAttribute('data-lucide', 'pencil');
      editIcon.className = 'icon-sm';
      editIcon.setAttribute('aria-hidden', 'true');
      editBtn.appendChild(editIcon);
      actions.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn--icon btn--danger-outline';
      delBtn.title = t('settings.ics.actions.delete');
      delBtn.setAttribute('aria-label', t('settings.ics.actions.delete'));
      delBtn.dataset.action = 'ics-delete';
      delBtn.dataset.id = sub.id;
      delBtn.dataset.name = sub.name;
      const delIcon = document.createElement('i');
      delIcon.setAttribute('data-lucide', 'trash-2');
      delIcon.className = 'icon-sm';
      delIcon.setAttribute('aria-hidden', 'true');
      delBtn.appendChild(delIcon);
      actions.appendChild(delBtn);

      li.appendChild(actions);
    }

    ul.appendChild(li);
  });
  listEl.appendChild(ul);
  if (window.lucide) window.lucide.createIcons({ el: listEl });
}

function bindIcsEvents(container, user, initialSubs) {
  let subs = [...initialSubs];
  renderIcsList(container, subs, user);

  const addBtn     = container.querySelector('#ics-add-btn');
  const formWrapper = container.querySelector('#ics-add-form-wrapper');
  const addForm    = container.querySelector('#ics-add-form');
  const cancelBtn  = container.querySelector('#ics-cancel-btn');
  const submitBtn  = container.querySelector('#ics-submit-btn');
  const errorEl    = container.querySelector('#ics-add-error');
  const listEl     = container.querySelector('#ics-list-container');

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      formWrapper.hidden = false;
      addBtn.hidden = true;
      container.querySelector('#ics-url')?.focus();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      formWrapper.hidden = true;
      addBtn.hidden = false;
      addForm?.reset();
      errorEl.hidden = true;
    });
  }

  if (addForm) {
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const url    = container.querySelector('#ics-url').value.trim();
      const name   = container.querySelector('#ics-name').value.trim();
      const color  = container.querySelector('#ics-color').value;
      const shared = container.querySelector('#ics-shared').checked ? 1 : 0;

      submitBtn.disabled = true;
      try {
        const res = await api.post('/calendar/subscriptions', { url, name, color, shared });
        subs.push(res.data);
        renderIcsList(container, subs, user);
        addForm.reset();
        formWrapper.hidden = true;
        addBtn.hidden = false;
        if (res.syncError) {
          window.oikos?.showToast(`${t('settings.ics.status.syncError')}: ${res.syncError}`, 'danger');
        } else {
          window.oikos?.showToast(t('settings.ics.addedToast'), 'success');
        }
      } catch (err) {
        errorEl.textContent = err.message ?? t('common.errorGeneric');
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  if (listEl) {
    listEl.addEventListener('click', async (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const id     = parseInt(target.dataset.id, 10);

      if (action === 'ics-sync') {
        const origIcon = target.querySelector('[data-lucide]');
        const origTitle = target.title;
        target.disabled = true;
        target.title = t('settings.ics.status.syncing');
        if (origIcon) origIcon.setAttribute('data-lucide', 'loader');
        if (window.lucide) window.lucide.createIcons({ el: target });
        try {
          const res = await api.post(`/calendar/subscriptions/${id}/sync`, {});
          const idx = subs.findIndex((s) => s.id === id);
          if (idx >= 0) subs[idx] = res.data;
          renderIcsList(container, subs, user);
          window.oikos?.showToast(t('settings.ics.syncedToast'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
          target.disabled = false;
          target.title = origTitle;
          if (origIcon) origIcon.setAttribute('data-lucide', 'refresh-cw');
          if (window.lucide) window.lucide.createIcons({ el: target });
        }
      }

      if (action === 'ics-edit') {
        const sub = subs.find((s) => s.id === id);
        if (!sub) return;
        openModal({
          title: t('settings.ics.actions.edit'),
          size: 'sm',
          content: `
            <form id="ics-edit-form" class="settings-form">
              <div class="form-group">
                <label class="form-label" for="ics-edit-name">${t('settings.ics.form.name')}</label>
                <input class="form-input" type="text" id="ics-edit-name" value="${esc(sub.name)}" required maxlength="100" />
              </div>
              <div class="settings-name-color-row">
                <div class="form-group settings-color-field">
                  <label class="form-label" for="ics-edit-color">${t('settings.ics.form.color')}</label>
                  <input class="settings-color-button" type="color" id="ics-edit-color" value="${esc(sub.color || '#3b82f6')}" />
                </div>
                <div class="form-group" style="display:flex;align-items:center;gap:var(--space-2);padding-top:var(--space-5)">
                  <input type="checkbox" id="ics-edit-shared" ${sub.shared ? 'checked' : ''} />
                  <label class="form-label" for="ics-edit-shared" style="margin:0">${t('settings.ics.form.shared')}</label>
                </div>
              </div>
              <div id="ics-edit-error" class="form-error" hidden></div>
              <div class="settings-form-actions">
                <button type="button" class="btn btn--secondary" id="ics-edit-cancel">${t('common.cancel')}</button>
                <button type="submit" class="btn btn--primary">${t('settings.ics.actions.save')}</button>
              </div>
            </form>
          `,
          onSave(panel) {
            panel.querySelector('#ics-edit-cancel')?.addEventListener('click', () => closeModal());
            panel.querySelector('#ics-edit-form')?.addEventListener('submit', async (e) => {
              e.preventDefault();
              const submitBtn = panel.querySelector('[type=submit]');
              const errEl     = panel.querySelector('#ics-edit-error');
              const name      = panel.querySelector('#ics-edit-name').value.trim();
              const color     = panel.querySelector('#ics-edit-color').value;
              const shared    = panel.querySelector('#ics-edit-shared').checked ? 1 : 0;
              errEl.hidden    = true;
              submitBtn.disabled = true;
              try {
                const res = await api.patch(`/calendar/subscriptions/${id}`, { name, color, shared });
                const idx = subs.findIndex((s) => s.id === id);
                if (idx >= 0) subs[idx] = res.data;
                renderIcsList(container, subs, user);
                window.oikos?.showToast(t('settings.ics.updatedToast'), 'success');
                closeModal({ force: true });
              } catch (err) {
                errEl.textContent = err.message ?? t('common.errorGeneric');
                errEl.hidden = false;
                submitBtn.disabled = false;
              }
            });
          },
        });
      }

      if (action === 'ics-delete') {
        const name = target.dataset.name;
        if (!await confirmModal(t('settings.ics.confirm_delete'), { danger: true, confirmLabel: t('common.delete') })) return;
        try {
          await api.delete(`/calendar/subscriptions/${id}`);
          subs = subs.filter((s) => s.id !== id);
          renderIcsList(container, subs, user);
          window.oikos?.showToast(t('settings.ics.deletedToast'), 'default');
        } catch (err) {
          window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        }
      }
    });
  }
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${formatDate(d)} ${formatTime(d)}`.trim();
}

function currentTheme() {
  return localStorage.getItem('oikos-theme') || 'system';
}

function applyTheme(value) {
  window.oikos?.applyTheme(value);
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}
