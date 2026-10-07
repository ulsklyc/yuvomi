import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { savePreferences } from '/settings/preferences-cache.js';
import {
  createInfoList,
  createRetryState,
  createStatusSummary,
} from '/settings/components.js';

const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';
const DEFAULT_APP_NAME = 'Yuvomi';

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

/**
 * Der App-Shell hält den aktiven Namen bereits im localStorage - daraus startet
 * das Feld, damit es sofort das zeigt, was in der Seitenleiste steht. `/version`
 * korrigiert es gleich danach, ohne dass ein Ladezustand nötig wird.
 */
function cachedAppName() {
  try {
    return localStorage.getItem(APP_NAME_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionAppName')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.appNameTitle')}</h3>
        <p class="form-hint">${t('settings.appNameHint')}</p>
        <form class="settings-form settings-form--compact" id="app-name-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="app-name-input">${t('settings.appNameLabel')}</label>
            <input class="form-input" type="text" id="app-name-input" maxlength="60"
              placeholder="${t('settings.appNamePlaceholder')}"
              value="${esc(cachedAppName() || DEFAULT_APP_NAME)}">
          </div>
          <div id="app-name-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary" id="app-name-reset-btn">${t('common.reset')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.systemTitle')}</h2>
      <div class="settings-card" id="system-info-card">
        <p class="settings-card-description">${t('settings.systemDescription')}</p>
        <div id="system-info-host"></div>
      </div>
    </section>
  `);
}

function buildInfoRows(info) {
  const rows = [];

  if (info.version) {
    rows.push({
      label: t('settings.systemVersionLabel'),
      value: t('settings.systemVersionValue', { version: info.version }),
    });
  }
  rows.push({
    label: t('settings.systemLicenseLabel'),
    value: 'MIT',
  });
  rows.push({
    label: t('settings.systemSetupStatusLabel'),
    value: info.setup_required
      ? t('settings.systemSetupRequired')
      : t('settings.systemSetupComplete'),
  });

  return rows;
}

function renderInfo(host, info) {
  host.replaceChildren(createInfoList(buildInfoRows(info)));
}

function refreshBranding(appName) {
  if (appName) safeStorageSet(APP_NAME_STORAGE_KEY, appName);
  else safeStorageRemove(APP_NAME_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent('app-name-changed', {
    detail: { appName: appName || DEFAULT_APP_NAME },
  }));
}

function bindAppNameEvents(container) {
  const form = container.querySelector('#app-name-form');
  const input = container.querySelector('#app-name-input');
  const errorElement = container.querySelector('#app-name-error');

  const persist = async (value) => {
    errorElement.hidden = true;
    try {
      await savePreferences({ app_name: value });
      input.value = value || DEFAULT_APP_NAME;
      refreshBranding(value);
      window.yuvomi?.showToast(t('settings.appNameSavedToast'), 'success');
    } catch (error) {
      errorElement.textContent = error.message || t('common.errorGeneric');
      errorElement.hidden = false;
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    persist(input.value.trim());
  });

  container.querySelector('#app-name-reset-btn').addEventListener('click', () => persist(''));
}

async function loadSystemInfo(container) {
  const host = container.querySelector('#system-info-host');
  if (!host) return;

  const reload = () => loadSystemInfo(container);

  let info;
  try {
    info = await api.get('/version');
  } catch (err) {
    host.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    return;
  }

  if (!info?.version) {
    host.replaceChildren(createStatusSummary({
      title: t('settings.systemTitle'),
      status: t('settings.loadError'),
      tone: 'warning',
    }));
    return;
  }

  if (info.app_name) {
    safeStorageSet(APP_NAME_STORAGE_KEY, info.app_name);
    const input = container.querySelector('#app-name-input');
    if (input) input.value = info.app_name;
  }

  renderInfo(host, info);
  window.lucide?.createIcons({ el: container });
}

export async function render(container, { user } = {}) {
  void user;
  renderPage(container);
  bindAppNameEvents(container);
  await loadSystemInfo(container);
  window.lucide?.createIcons({ el: container });
}
