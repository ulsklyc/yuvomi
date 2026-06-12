import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { confirmModal } from '/components/modal.js';
import {
  createDisclosure,
  createRetryState,
  createStatusSummary,
} from '/settings/components.js';

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

function showToast(message, tone = 'default') {
  window.oikos?.showToast(message, tone);
}

function documentStorageTarget(data) {
  if (data.effective_target) return data.effective_target;
  if (!data.url) return t('settings.documentStorageNotConfigured');
  const basePath = data.base_path ?? data.basePath ?? '';
  return basePath
    ? `${data.url.replace(/\/+$/, '')}/${String(basePath).replace(/^\/+/, '')}`
    : data.url;
}

function buildStatusSummary(data) {
  const activeBackend = data.active_upload_backend ?? (data.enabled ? 'webdav' : 'local');
  const activeLabel = activeBackend === 'webdav'
    ? t('documents.storageWebdav')
    : t('documents.storageLocal');
  const lastTest = data.last_test ?? data.lastTest;
  const lastTestLabel = formatSyncTime(lastTest) ?? t('settings.documentStorageNeverTested');
  const lastError = data.last_error ?? data.lastError;

  const details = [
    `${t('settings.documentStorageActive')}: ${activeLabel}`,
    `${t('settings.documentStorageCount')}: ${Number(data.webdav_document_count ?? 0)}`,
    `${t('settings.documentStorageLastTest')}: ${lastTestLabel}`,
  ];
  if (lastError) {
    details.push(`${t('settings.documentStorageLastError')}: ${lastError}`);
  }

  return createStatusSummary({
    title: activeLabel,
    status: documentStorageTarget(data),
    details,
    tone: lastError ? 'warning' : 'neutral',
  });
}

function buildConnectionForm() {
  const form = document.createElement('form');
  form.className = 'settings-form settings-form--compact';
  form.id = 'document-storage-form';
  form.noValidate = true;
  form.autocomplete = 'off';
  form.insertAdjacentHTML('beforeend', `
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
      <input class="form-input" type="text" id="document-storage-username" name="username" autocomplete="off" />
      <span class="form-hint" data-env-hint="username" hidden>${t('settings.documentStorageEnvHint')}</span>
    </div>
    <div class="form-group">
      <label class="form-label" for="document-storage-password">${t('settings.documentStoragePassword')}</label>
      <div class="settings-webdav-pw-wrap">
        <input class="form-input" type="password" id="document-storage-password" name="password"
          autocomplete="current-password" placeholder="${t('settings.documentStoragePasswordPlaceholder')}" />
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
  `);
  return form;
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.documentStorageTitle')}</h2>
      <div class="settings-card" id="document-storage-card">
        <p class="settings-card-description">${t('settings.documentStorageDescription')}</p>
        <div id="document-storage-status-host"></div>
        <p class="settings-document-storage-warning">
          <i data-lucide="triangle-alert" aria-hidden="true"></i>
          <span>${t('settings.documentStorageBackupWarning')}</span>
        </p>
        <div id="document-storage-disclosure-host"></div>
      </div>
    </section>
  `);
}

function applyConfigToForm(form, data) {
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
  const passwordInput = form.querySelector('#document-storage-password');
  passwordInput.value = '';
  passwordInput.placeholder = data.password_configured
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

function bindConnectionForm(container, form, reload) {
  form.querySelector('[data-reveal-target]')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const input = form.querySelector(`#${button.dataset.revealTarget}`);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    const icon = button.querySelector('[data-lucide]');
    if (icon) icon.dataset.lucide = reveal ? 'eye-off' : 'eye';
    window.lucide?.createIcons({ el: button });
  });

  const testBtn = form.querySelector('#document-storage-test-btn');
  const result = form.querySelector('#document-storage-test-result');
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
      await reload();
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
      showToast(t('settings.documentStorageSaved'), 'success');
      await reload();
    } catch (err) {
      showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = t('settings.documentStorageSave');
      }
    }
  });
}

async function loadDocumentStorageConfig(container) {
  const statusHost = container.querySelector('#document-storage-status-host');
  const disclosureHost = container.querySelector('#document-storage-disclosure-host');
  if (!statusHost || !disclosureHost) return;

  const reload = () => loadDocumentStorageConfig(container);

  let data;
  try {
    const res = await api.get('/documents/storage/config');
    data = res.data ?? {};
  } catch (err) {
    statusHost.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    disclosureHost.replaceChildren();
    return;
  }

  // Status-first: render the active backend + target before the connection fields.
  statusHost.replaceChildren(buildStatusSummary(data));

  const form = buildConnectionForm();
  const disclosure = createDisclosure({
    id: 'document-storage-connection',
    summary: t('settings.documentStorageTitle'),
    content: form,
  });
  disclosureHost.replaceChildren(disclosure);

  applyConfigToForm(form, data);
  bindConnectionForm(container, form, reload);

  window.lucide?.createIcons({ el: container });
}

export async function render(container, { user } = {}) {
  renderPage(container);
  await loadDocumentStorageConfig(container);
  window.lucide?.createIcons({ el: container });
}
