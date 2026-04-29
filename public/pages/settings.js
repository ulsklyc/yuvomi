/**
 * Modul: Einstellungen (Settings)
 * Zweck: Benutzerkonto, Passwort, Kalender-Sync, Familienmitglieder
 * Abhängigkeiten: /api.js
 */

import { api, auth } from '/api.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { t, formatDate, formatTime, dateInputPlaceholder, formatDateInput, parseDateInput, isDateInputValid, getDateFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import '/components/oikos-locale-picker.js';

const SUPPORTED_CURRENCIES = ['AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HUF', 'INR', 'JPY', 'NOK', 'PLN', 'RUB', 'SAR', 'SEK', 'TRY', 'UAH', 'USD'];
const SETTINGS_TAB_KEY = 'oikos:settings:tab';
const APP_NAME_STORAGE_KEY = 'oikos-app-name';
const DEFAULT_APP_NAME = 'Oikos';
const FAMILY_ROLES = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];
const MAX_AVATAR_DATA_LENGTH = 768 * 1024;

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

function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(undefined);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      return reject(new Error(t('settings.profilePictureTypeError')));
    }
    if (file.size > 5 * 1024 * 1024) {
      return reject(new Error(t('settings.profilePictureFileTooLarge')));
    }

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
      try {
        const maxSize = 512;
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
        if (dataUrl.length > MAX_AVATAR_DATA_LENGTH) {
          reject(new Error(t('settings.profilePictureTooLarge')));
        } else {
          resolve(dataUrl);
        }
      } catch (err) {
        reject(err);
      }
      };
      img.onerror = () => reject(new Error(t('settings.profilePictureReadError')));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error(t('settings.profilePictureReadError')));
    reader.readAsDataURL(file);
  });
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
  let prefs           = { visible_meal_types: ['breakfast', 'lunch', 'dinner', 'snack'], currency: 'EUR', date_format: 'mdy', app_name: DEFAULT_APP_NAME };
  let categories      = [];
  let icsSubscriptions = [];
  let apiTokens       = [];

  try {
    const [usersRes, gStatus, aStatus, prefsRes, catsRes, icsRes, apiTokensRes] = await Promise.allSettled([
      user.role === 'admin' ? auth.getUsers() : Promise.resolve({ data: [] }),
      api.get('/calendar/google/status'),
      api.get('/calendar/apple/status'),
      api.get('/preferences'),
      api.get('/shopping/categories'),
      api.get('/calendar/subscriptions'),
      user.role === 'admin' ? api.get('/auth/api-tokens') : Promise.resolve({ data: [] }),
    ]);
    if (usersRes.status === 'fulfilled')  users            = usersRes.value.data  ?? [];
    if (gStatus.status  === 'fulfilled')  googleStatus     = gStatus.value;
    if (aStatus.status  === 'fulfilled')  appleStatus      = aStatus.value;
    if (prefsRes.status === 'fulfilled')  prefs            = prefsRes.value.data  ?? prefs;
    if (catsRes.status  === 'fulfilled')  categories       = catsRes.value.data   ?? [];
    if (icsRes.status   === 'fulfilled')  icsSubscriptions = icsRes.value.data    ?? [];
    if (apiTokensRes.status === 'fulfilled') apiTokens     = apiTokensRes.value.data ?? [];
  } catch (_) { /* non-critical */ }

  if (prefs.date_format) {
    try { localStorage.setItem('oikos-date-format', prefs.date_format); } catch (_) {}
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
    'general', 'meals', 'budget', 'shopping', 'calendar',
    ...(user?.role === 'admin' ? ['family', 'api-tokens'] : []),
    'account',
  ];
  const storedTab = sessionStorage.getItem(SETTINGS_TAB_KEY) ?? 'general';
  const activeTab = (syncOk || syncErr)
    ? 'calendar'
    : (allowedTabs.includes(storedTab) ? storedTab : 'general');

  const panelHidden = (id) => id === activeTab ? '' : ' hidden';
  const btnClass    = (id) => `settings-tab-btn${id === activeTab ? ' settings-tab-btn--active' : ''}`;
  const btnAria     = (id) => id === activeTab ? 'true' : 'false';

  container.innerHTML = `
    <div class="page settings-page">
      <div class="page__header">
        <h1 class="page__title">${t('settings.title')}</h1>
      </div>

      ${syncOk  ? `<div class="settings-banner settings-banner--success">${syncOk === 'google' ? t('settings.syncSuccessGoogle') : t('settings.syncSuccessApple')}</div>` : ''}
      ${syncErr ? `<div class="settings-banner settings-banner--error">${syncErr === 'google' ? t('settings.syncErrorGoogle') : t('settings.syncErrorApple')}</div>` : ''}

      <nav class="settings-tabs" role="tablist" aria-label="${t('settings.tabsAriaLabel')}">
        <button class="${btnClass('general')}"  role="tab" data-tab="general"  aria-selected="${btnAria('general')}">${t('settings.tabGeneral')}</button>
        <button class="${btnClass('meals')}"    role="tab" data-tab="meals"    aria-selected="${btnAria('meals')}">${t('settings.tabMeals')}</button>
        <button class="${btnClass('budget')}"   role="tab" data-tab="budget"   aria-selected="${btnAria('budget')}">${t('settings.tabBudget')}</button>
        <button class="${btnClass('shopping')}" role="tab" data-tab="shopping" aria-selected="${btnAria('shopping')}">${t('settings.tabShopping')}</button>
        <button class="${btnClass('calendar')}" role="tab" data-tab="calendar" aria-selected="${btnAria('calendar')}">${t('settings.tabCalendar')}</button>
        ${user?.role === 'admin' ? `<button class="${btnClass('family')}" role="tab" data-tab="family" aria-selected="${btnAria('family')}">${t('settings.tabFamily')}</button>` : ''}
        ${user?.role === 'admin' ? `<button class="${btnClass('api-tokens')}" role="tab" data-tab="api-tokens" aria-selected="${btnAria('api-tokens')}">${t('settings.tabApiTokens')}</button>` : ''}
        <button class="${btnClass('account')}"  role="tab" data-tab="account"  aria-selected="${btnAria('account')}">${t('settings.tabAccount')}</button>
      </nav>

      <!-- Panel: Allgemein (Design + Sprache) -->
      <div class="settings-tab-panel" data-panel="general" role="tabpanel"${panelHidden('general')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionDesign')}</h2>
          <div class="settings-card">
            <h3 class="settings-card__title">${t('settings.cardAppearance')}</h3>
            <div class="theme-toggle" id="theme-toggle">
              <button class="theme-toggle__btn ${currentTheme() === 'system' ? 'theme-toggle__btn--active' : ''}" data-theme-value="system" aria-label="${t('settings.themeSysLabel')}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                ${t('settings.themeSystem')}
              </button>
              <button class="theme-toggle__btn ${currentTheme() === 'light' ? 'theme-toggle__btn--active' : ''}" data-theme-value="light" aria-label="${t('settings.themeLightLabel')}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                ${t('settings.themeLight')}
              </button>
              <button class="theme-toggle__btn ${currentTheme() === 'dark' ? 'theme-toggle__btn--active' : ''}" data-theme-value="dark" aria-label="${t('settings.themeDarkLabel')}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                ${t('settings.themeDark')}
              </button>
            </div>
          </div>
        </section>

        ${user?.role === 'admin' ? `
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionAppName')}</h2>
          <div class="settings-card">
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
          <div class="settings-card">
            <h3 class="settings-card__title">${t('settings.dateFormatTitle')}</h3>
            <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.dateFormatHint')}</p>
            <label class="form-label" for="date-format-select">${t('settings.dateFormatLabel')}</label>
            <select class="form-input" id="date-format-select">
              <option value="mdy"${prefs.date_format === 'mdy' ? ' selected' : ''}>MM/DD/YYYY</option>
              <option value="dmy"${prefs.date_format === 'dmy' ? ' selected' : ''}>DD/MM/YYYY</option>
              <option value="ymd"${prefs.date_format === 'ymd' ? ' selected' : ''}>YYYY-MM-DD</option>
            </select>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.languageTitle')}</h2>
          <div class="settings-card">
            <oikos-locale-picker></oikos-locale-picker>
          </div>
        </section>
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
      <div class="settings-tab-panel" data-panel="calendar" role="tabpanel"${panelHidden('calendar')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionCalendarSync')}</h2>

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

          <!-- ICS-Abonnements -->
          <div class="settings-card" id="ics-card">
            <div class="settings-sync-header">
              <div class="settings-sync-info">
                <div class="settings-sync-info__name">${t('settings.ics.title')}</div>
              </div>
            </div>
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
      </div>

      ${user?.role === 'admin' ? `
      <!-- Panel: Family Management -->
      <div class="settings-tab-panel" data-panel="family" role="tabpanel"${panelHidden('family')}>
        <section class="settings-section">
          <h2 class="settings-section__title">${t('settings.sectionFamily')}</h2>
          <div class="settings-card" id="members-card">
            <ul class="settings-members" id="members-list">
              ${users.map(memberHtml).join('')}
            </ul>
            <button class="btn btn--primary settings-add-btn" id="add-member-btn">${t('settings.addMember')}</button>
          </div>

          <div class="settings-card settings-card--hidden" id="add-member-form-card">
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
                  <input class="settings-color-button" type="color" id="new-avatar-color" value="#007AFF" />
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
          <div class="settings-card">
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

          <div class="settings-card">
            <div class="settings-user-info">
              ${avatarHtml(user)}
              <div>
                <div class="settings-user-info__name">${esc(user?.display_name)}</div>
                <div class="settings-user-info__username">@${esc(user?.username)}</div>
              </div>
            </div>
          </div>

          <div class="settings-card">
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

          <div class="settings-card">
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
    </div>
  `;

  // Meal-Type-Checkboxen initialisieren
  const toggles = container.querySelector('#meal-type-toggles');
  if (toggles) {
    toggles.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = prefs.visible_meal_types.includes(cb.value);
    });
  }

  bindEvents(container, user, users, categories, icsSubscriptions, apiTokens);
  if (window.lucide) window.lucide.createIcons();
}

// --------------------------------------------------------
// Event-Binding
// --------------------------------------------------------

function bindEvents(container, user, users, categories, icsSubscriptions, apiTokens) {
  bindTabEvents(container);
  bindSettingsDateInputs(container);
  bindCategoryEvents(container);
  bindIcsEvents(container, user, icsSubscriptions);
  bindApiTokenEvents(container, apiTokens);
  // Theme-Toggle
  const themeToggle = container.querySelector('#theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-value]');
      if (!btn) return;
      const value = btn.dataset.themeValue;
      applyTheme(value);
      themeToggle.querySelectorAll('.theme-toggle__btn').forEach(b => b.classList.remove('theme-toggle__btn--active'));
      btn.classList.add('theme-toggle__btn--active');
    });
  }

  // Meal-Type-Toggles
  const mealToggles = container.querySelector('#meal-type-toggles');
  if (mealToggles) {
    mealToggles.addEventListener('change', async () => {
      const checked = [...mealToggles.querySelectorAll('input:checked')].map((cb) => cb.value);
      if (checked.length === 0) {
        window.oikos?.showToast(t('settings.mealTypesMinOne'), 'error');
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
        window.location.href = '/login';
      }
    });
  }
}

// --------------------------------------------------------
// Tab-Navigation
// --------------------------------------------------------

function bindTabEvents(container) {
  const tabList = container.querySelector('.settings-tabs');
  if (!tabList) return;

  tabList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;

    tabList.querySelectorAll('[data-tab]').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('settings-tab-btn--active', active);
      b.setAttribute('aria-selected', String(active));
    });

    container.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });

    try { sessionStorage.setItem(SETTINGS_TAB_KEY, tab); } catch (_) {}
  });
}


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
    const tmp = document.createElement('template');
    tmp.innerHTML = apiTokenHtml(token);
    list.appendChild(tmp.content.firstElementChild);
  });
  if (window.lucide) window.lucide.createIcons();
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
          <i data-lucide="chevron-up" style="width:16px;height:16px" aria-hidden="true"></i>
        </button>
        <button class="btn btn--icon btn--ghost" data-action="move-cat-down" data-id="${cat.id}"
                aria-label="${t('settings.shoppingCategoryMoveDown')}"
                ${isLast ? 'disabled' : ''}>
          <i data-lucide="chevron-down" style="width:16px;height:16px" aria-hidden="true"></i>
        </button>
        <button class="btn btn--icon btn--danger-outline" data-action="delete-cat" data-id="${cat.id}"
                aria-label="${t('settings.shoppingCategoryDelete')}">
          <i data-lucide="trash-2" style="width:14px;height:14px" aria-hidden="true"></i>
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
    const tmp = document.createElement('template');
    tmp.innerHTML = categoryRowHtml(c, i === 0, i === cats.length - 1);
    list.appendChild(tmp.content.firstElementChild);
  });
  if (window.lucide) window.lucide.createIcons();
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
      syncIcon.style.cssText = 'width:16px;height:16px';
      syncIcon.setAttribute('aria-hidden', 'true');
      syncBtn.appendChild(syncIcon);
      actions.appendChild(syncBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn--icon btn--danger-outline';
      delBtn.title = t('settings.ics.actions.delete');
      delBtn.setAttribute('aria-label', t('settings.ics.actions.delete'));
      delBtn.dataset.action = 'ics-delete';
      delBtn.dataset.id = sub.id;
      delBtn.dataset.name = sub.name;
      const delIcon = document.createElement('i');
      delIcon.setAttribute('data-lucide', 'trash-2');
      delIcon.style.cssText = 'width:14px;height:14px';
      delIcon.setAttribute('aria-hidden', 'true');
      delBtn.appendChild(delIcon);
      actions.appendChild(delBtn);

      li.appendChild(actions);
    }

    ul.appendChild(li);
  });
  listEl.appendChild(ul);
  if (window.lucide) window.lucide.createIcons();
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
        if (window.lucide) window.lucide.createIcons();
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
          if (window.lucide) window.lucide.createIcons();
        }
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
