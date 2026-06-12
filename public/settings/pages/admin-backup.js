import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { confirmModal } from '/components/modal.js';
import { createDisclosure, createInfoRow } from '/settings/components.js';

function showError(element, message) {
  if (!element) return;
  element.textContent = message || t('common.errorGeneric');
  element.hidden = false;
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionBackup')}</h2>

      <div class="settings-card settings-backup-card">
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

      <div class="settings-card settings-backup-card settings-backup-card--danger">
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
            <div id="backup-restore-error" class="form-error" role="alert" hidden></div>
            <div class="settings-form-actions">
              <button type="submit" class="btn btn--danger-outline" id="backup-restore-btn" disabled>${t('settings.backupRestoreButton')}</button>
            </div>
          </form>
        </div>
      </div>

      <div class="settings-card" id="backup-scheduler-card">
        <h3 class="settings-card__title">${t('settings.backupSchedulerTitle')}</h3>
        <p class="form-hint">${t('settings.backupSchedulerHint')}</p>
        <div class="settings-info-grid" id="backup-scheduler-info"></div>
      </div>

      <div class="settings-card" id="backup-webdav-card">
        <h3 class="settings-card__title">
          <i data-lucide="cloud-upload" class="icon-sm" aria-hidden="true"></i>
          ${t('settings.backupWebdavTitle')}
        </h3>
        <p class="form-hint">${t('settings.backupWebdavHint')}</p>
        <form class="settings-form settings-webdav-form" id="backup-webdav-form" novalidate>
          <div class="settings-webdav-toggle-row">
            <span class="form-label">${t('settings.backupWebdavEnabled')}</span>
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
            <input class="form-input" type="text" id="webdav-username" name="username" autocomplete="off" />
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
            <input class="form-input settings-input--compact" type="number" id="webdav-keep" name="keep" min="1" max="99" />
          </div>
          <div id="webdav-test-result" class="form-hint" hidden></div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary" id="webdav-test-btn">
              <i data-lucide="plug" aria-hidden="true"></i>
              ${t('settings.backupWebdavTestBtn')}
            </button>
            <button type="submit" class="btn btn--primary" id="webdav-save-btn">${t('settings.backupWebdavSaveBtn')}</button>
          </div>
        </form>

        <div class="settings-info-grid settings-info-grid--divided" id="backup-webdav-status"></div>
      </div>

      <div id="backup-cli-host"></div>
    </section>
  `);
}

function buildCliContent() {
  const wrap = document.createElement('div');
  wrap.className = 'settings-backup-cli';
  wrap.insertAdjacentHTML('beforeend', `
    <p class="form-hint">${t('settings.backupCliHint')}</p>
    <pre class="settings-code-block"><code>SERVICE=oikos
BACKUP="$PWD/oikos-backup.db"
docker compose stop "$SERVICE"
docker compose run --rm -v "$BACKUP:/tmp/oikos-restore.db:ro" --entrypoint sh "$SERVICE" -c 'set -eu; target="\${DB_PATH:-/data/oikos.db}"; stamp=$(date -u +%Y%m%dT%H%M%SZ); if [ -f "$target" ]; then cp "$target" "$target.pre-restore-$stamp"; fi; rm -f "$target-wal" "$target-shm"; cp /tmp/oikos-restore.db "$target"; chown node:node "$target" 2&gt;/dev/null || true'
docker compose up -d "$SERVICE"</code></pre>
    <p class="form-hint">${t('settings.backupCliBackupHint')}</p>
    <pre class="settings-code-block"><code>docker compose exec oikos node -e "import('./server/db.js').then(async db =&gt; { await db.backupToFile('/data/oikos-backup.db'); process.exit(0); })"
docker cp oikos:/data/oikos-backup.db ./oikos-backup.db</code></pre>
  `);
  return wrap;
}

function renderCliDisclosure(container) {
  const host = container.querySelector('#backup-cli-host');
  if (!host) return;
  const card = document.createElement('div');
  card.className = 'settings-card';
  card.appendChild(createDisclosure({
    id: 'backup-cli',
    summary: t('settings.backupCliTitle'),
    expanded: false,
    content: buildCliContent(),
  }));
  host.replaceChildren(card);
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
      const date = `${formatDate(lastBackup.timestamp)} ${formatTime(lastBackup.timestamp)}`;
      lastBackupText = lastBackup.success
        ? t('settings.backupSchedulerLastSuccess', { date })
        : t('settings.backupSchedulerLastFail', { date });
    }

    const rows = [
      createInfoRow({
        label: t('settings.backupSchedulerStatus'),
        value: enabled ? t('settings.backupSchedulerEnabled') : t('settings.backupSchedulerDisabled'),
        tone: enabled ? 'success' : null,
      }),
    ];

    if (enabled) {
      rows.push(createInfoRow({ label: t('settings.backupSchedulerSchedule'), value: schedule, code: true }));
      rows.push(createInfoRow({
        label: t('settings.backupSchedulerKeep'),
        value: t('settings.backupSchedulerKeepCount', { count: keepCount }),
      }));
      rows.push(createInfoRow({ label: t('settings.backupSchedulerLastBackup'), value: lastBackupText }));

      const actions = document.createElement('div');
      actions.className = 'settings-form-actions';
      const triggerButton = document.createElement('button');
      triggerButton.type = 'button';
      triggerButton.className = 'btn btn--secondary';
      triggerButton.id = 'backup-trigger-btn';
      triggerButton.textContent = t('settings.backupSchedulerTrigger');
      actions.appendChild(triggerButton);
      rows.push(actions);
    }

    infoContainer.replaceChildren(...rows);

    const triggerBtn = infoContainer.querySelector('#backup-trigger-btn');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', async () => {
        triggerBtn.disabled = true;
        triggerBtn.textContent = t('settings.backupSchedulerTriggering');
        try {
          await api.post('/backup/trigger');
          window.oikos?.showToast(t('settings.backupSchedulerTriggeredToast'), 'success');
          loadBackupSchedulerStatus(container);
        } catch (err) {
          window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
          triggerBtn.disabled = false;
          triggerBtn.textContent = t('settings.backupSchedulerTrigger');
        }
      });
    }
  } catch (err) {
    console.error('[Settings] Failed to load backup scheduler status:', err);
  }
}

function renderWebdavStatus(grid, container, d) {
  if (!grid) return;
  if (!d.configured) { grid.replaceChildren(); return; }

  const lastUploadValue = d.lastUpload
    ? `${formatDate(d.lastUpload)} ${formatTime(d.lastUpload)}`
    : t('settings.backupWebdavNeverUploaded');

  const rows = [
    createInfoRow({
      label: t('settings.backupWebdavLastUpload'),
      value: lastUploadValue,
      tone: d.lastUpload ? 'success' : null,
    }),
  ];

  if (d.lastError) {
    rows.push(createInfoRow({
      label: t('settings.backupWebdavLastError'),
      value: d.lastError,
      tone: 'danger',
    }));
  }

  const actions = document.createElement('div');
  actions.className = 'settings-form-actions settings-form-actions--tight';
  const triggerButton = document.createElement('button');
  triggerButton.type = 'button';
  triggerButton.className = 'btn btn--secondary';
  triggerButton.id = 'webdav-trigger-btn';
  const triggerIcon = document.createElement('i');
  triggerIcon.dataset.lucide = 'upload-cloud';
  triggerIcon.setAttribute('aria-hidden', 'true');
  triggerButton.append(triggerIcon, document.createTextNode(` ${t('settings.backupWebdavTriggerBtn')}`));
  actions.appendChild(triggerButton);
  rows.push(actions);

  grid.replaceChildren(...rows);
  window.lucide?.createIcons({ el: grid });

  const triggerBtn = grid.querySelector('#webdav-trigger-btn');
  if (triggerBtn) {
    triggerBtn.addEventListener('click', async () => {
      triggerBtn.disabled = true;
      triggerBtn.textContent = t('settings.backupWebdavTriggering');
      try {
        await api.post('/backup/webdav/trigger');
        window.oikos?.showToast(t('settings.backupWebdavTriggeredToast'), 'success');
        loadWebdavConfig(container);
      } catch (err) {
        window.oikos?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        const icon = document.createElement('i');
        icon.dataset.lucide = 'upload-cloud';
        icon.setAttribute('aria-hidden', 'true');
        triggerBtn.replaceChildren(icon, document.createTextNode(` ${t('settings.backupWebdavTriggerBtn')}`));
        window.lucide?.createIcons({ el: triggerBtn });
        triggerBtn.disabled = false;
      }
    });
  }
}

async function loadWebdavConfig(container) {
  const form = container.querySelector('#backup-webdav-form');
  const statusGrid = container.querySelector('#backup-webdav-status');
  if (!form) return;

  try {
    const res = await api.get('/backup/webdav/config');
    const d = res.data ?? {};

    const setVal = (id, val) => {
      const el = form.querySelector(`#${id}`);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = Boolean(val);
      else el.value = val ?? '';
    };

    setVal('webdav-enabled', d.enabled);
    setVal('webdav-url', d.url ?? '');
    setVal('webdav-username', d.username ?? '');
    setVal('webdav-password', d.password ?? '');
    setVal('webdav-path', d.remotePath ?? '/yuvomi/backups/');
    setVal('webdav-keep', d.keep ?? 7);

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
        hint.hidden = false;
        hint.textContent = t('settings.backupWebdavEnvHint');
        hint.className = 'form-hint';
      }
    }

    renderWebdavStatus(statusGrid, container, d);
    window.lucide?.createIcons({ el: form });
  } catch (err) {
    console.error('[Settings] Failed to load WebDAV config:', err);
  }
}

function bindWebdavBackupEvents(container) {
  const form = container.querySelector('#backup-webdav-form');
  const testBtn = container.querySelector('#webdav-test-btn');
  const resultEl = container.querySelector('#webdav-test-result');
  if (!form) return;

  loadWebdavConfig(container);

  form.querySelectorAll('[data-reveal-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = form.querySelector(`#${btn.dataset.revealTarget}`);
      if (!input) return;
      const isText = input.type === 'text';
      input.type = isText ? 'password' : 'text';
      const icon = btn.querySelector('[data-lucide]');
      if (icon) {
        icon.setAttribute('data-lucide', isText ? 'eye' : 'eye-off');
        window.lucide?.createIcons({ el: btn });
      }
    });
  });

  testBtn?.addEventListener('click', async () => {
    testBtn.disabled = true;
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = '…'; resultEl.className = 'form-hint'; }

    const overrides = {};
    const url = form.querySelector('#webdav-url')?.value?.trim();
    const username = form.querySelector('#webdav-username')?.value?.trim();
    const password = form.querySelector('#webdav-password')?.value;
    const path = form.querySelector('#webdav-path')?.value?.trim();

    if (url) overrides.url = url;
    if (username) overrides.username = username;
    if (password && password !== '****') overrides.password = password;
    if (path) overrides.remotePath = path;

    try {
      const res = await api.post('/backup/webdav/test', overrides);
      if (resultEl) {
        resultEl.textContent = t('settings.backupWebdavTestSuccess', { files: res.data?.files ?? 0 });
        resultEl.className = 'form-hint';
        resultEl.style.color = 'var(--color-success)';
      }
    } catch (err) {
      if (resultEl) {
        resultEl.textContent = t('settings.backupWebdavTestFailed', { error: err.message });
        resultEl.className = 'form-hint';
        resultEl.style.color = 'var(--color-danger)';
      }
    } finally {
      testBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveBtn = form.querySelector('#webdav-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '…'; }

    const password = form.querySelector('#webdav-password')?.value;
    const payload = {
      enabled: form.querySelector('#webdav-enabled')?.checked ?? false,
      url: form.querySelector('#webdav-url')?.value?.trim() || null,
      username: form.querySelector('#webdav-username')?.value?.trim() || null,
      remotePath: form.querySelector('#webdav-path')?.value?.trim() || '/yuvomi/backups/',
      keep: Number(form.querySelector('#webdav-keep')?.value) || 7,
    };
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

function bindRestoreEvents(container) {
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

  dropzone?.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('settings-backup-dropzone--active');
  });

  dropzone?.addEventListener('dragleave', () => {
    dropzone.classList.remove('settings-backup-dropzone--active');
  });

  dropzone?.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('settings-backup-dropzone--active');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    errorEl.hidden = true;
    setFile(file);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!await confirmModal(t('settings.backupRestoreConfirm'), {
      danger: true,
      confirmLabel: t('settings.backupRestoreButton'),
    })) return;

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

export async function render(container, { user } = {}) {
  renderPage(container);
  renderCliDisclosure(container);
  bindRestoreEvents(container);
  await loadBackupSchedulerStatus(container);
  bindWebdavBackupEvents(container);
  window.lucide?.createIcons({ el: container });
}
