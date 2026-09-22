import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { confirmModal } from '/components/modal.js';
import { formatCronSchedule } from '/settings/cron-label.js';
import { backupKeyFieldHtml, encodeBackupKey, keyFieldAfterError, keyFieldDescribedBy } from '/settings/backup-key.js';
import {
  createDisclosure,
  createInfoRow,
  createRetryState,
  toggleRowHtml,
} from '/settings/components.js';

// Zeitplan-Zelle: der Klartext trägt die Aussage, der Cron-Ausdruck bleibt als
// Beleg daneben stehen. Ohne erkanntes Muster ist der Ausdruck die Aussage.
function scheduleValue(schedule) {
  const readable = formatCronSchedule(schedule);
  if (!readable) return { value: schedule, code: true };

  const wrapper = document.createElement('span');
  wrapper.className = 'settings-info-value__stack';
  const text = document.createElement('span');
  text.textContent = readable;
  const expression = document.createElement('code');
  expression.textContent = schedule;
  wrapper.append(text, expression);
  return { value: wrapper, code: false };
}

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
            ${backupKeyFieldHtml(window.location.protocol)}
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
            ${toggleRowHtml({
              label: t('settings.backupWebdavEnabled'),
              attrs: { id: 'webdav-enabled', name: 'enabled' },
            })}
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
    <pre class="settings-code-block"><code>SERVICE=yuvomi
BACKUP="$PWD/yuvomi-backup.db"
docker compose stop "$SERVICE"
docker compose run --rm -v "$BACKUP:/tmp/yuvomi-restore.db:ro" --entrypoint sh "$SERVICE" -c 'set -eu; target="\${DB_PATH:-/data/yuvomi.db}"; case "$target" in */oikos.db) target="\${target%/oikos.db}/yuvomi.db";; esac; stamp=$(date -u +%Y%m%dT%H%M%SZ); if [ -f "$target" ]; then cp "$target" "$target.pre-restore-$stamp"; fi; rm -f "$target-wal" "$target-shm"; cp /tmp/yuvomi-restore.db "$target"; chown node:node "$target" 2&gt;/dev/null || true'
docker compose up -d "$SERVICE"</code></pre>
    <p class="form-hint">${t('settings.backupCliForeignKeyHint')}</p>
    <p class="form-hint">${t('settings.backupCliBackupHint')}</p>
    <pre class="settings-code-block"><code>docker compose exec yuvomi node -e "import('./server/db.js').then(async db =&gt; { await db.backupToFile('/data/yuvomi-backup.db'); process.exit(0); })"
docker cp yuvomi:/data/yuvomi-backup.db ./yuvomi-backup.db</code></pre>
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

/**
 * "Automatische Backups" mit Titel, Hinweis und leerem Inhalt liest sich als
 * "es gibt keine" - die gefaehrlichste moegliche Fehldeutung auf einer
 * Backup-Seite. Beide Ladepfade schrieben den Fehler nur in die Konsole
 * (Critique 2026-07-27); `createRetryState` sagt jetzt, dass der Stand
 * unbekannt ist, und bietet den zweiten Versuch an.
 */
async function loadBackupSchedulerStatus(container) {
  const infoContainer = container.querySelector('#backup-scheduler-info');
  if (!infoContainer) return;

  const failWithRetry = (error) => {
    console.error('[Settings] Failed to load backup scheduler status:', error);
    infoContainer.replaceChildren(createRetryState({
      message: error?.message || t('settings.loadError'),
      onRetry: () => loadBackupSchedulerStatus(container),
    }));
  };

  try {
    const res = await api.get('/backup/status');
    const scheduler = res.data?.scheduler;
    // Die Route liefert den Scheduler-Status immer mit; fehlt er, ist die
    // Antwort kaputt und nicht etwa "kein Scheduler eingerichtet".
    if (!scheduler) {
      failWithRetry(new Error(t('settings.loadError')));
      return;
    }

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
      rows.push(createInfoRow({ label: t('settings.backupSchedulerSchedule'), ...scheduleValue(schedule) }));
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
          window.yuvomi?.showToast(t('settings.backupSchedulerTriggeredToast'), 'success');
          loadBackupSchedulerStatus(container);
        } catch (err) {
          window.yuvomi?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
          triggerBtn.disabled = false;
          triggerBtn.textContent = t('settings.backupSchedulerTrigger');
        }
      });
    }
  } catch (err) {
    failWithRetry(err);
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
        window.yuvomi?.showToast(t('settings.backupWebdavTriggeredToast'), 'success');
        loadWebdavConfig(container);
      } catch (err) {
        window.yuvomi?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
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

  // Ein leeres Formular nach einem Ladefehler ist schlimmer als gar keins: es
  // sieht aus wie "nichts konfiguriert" und wuerde beim Speichern eine
  // bestehende Verbindung ueberschreiben, deren Werte niemand gesehen hat.
  const failWithRetry = (error) => {
    console.error('[Settings] Failed to load WebDAV config:', error);
    form.hidden = true;
    const state = createRetryState({
      message: error?.message || t('settings.loadError'),
      onRetry: async () => {
        state.remove();
        form.hidden = false;
        await loadWebdavConfig(container);
      },
    });
    form.after(state);
  };

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
    failWithRetry(err);
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
        resultEl.className = 'form-hint form-hint--success';
      }
    } catch (err) {
      if (resultEl) {
        resultEl.textContent = t('settings.backupWebdavTestFailed', { error: err.message });
        resultEl.className = 'form-hint form-hint--danger';
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
      window.yuvomi?.showToast(t('settings.backupWebdavSaved'), 'success');
      loadWebdavConfig(container);
    } catch (err) {
      window.yuvomi?.showToast(err.message ?? t('common.errorGeneric'), 'danger');
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
  const keyGroup = container.querySelector('#backup-restore-key-group');
  const keyInput = container.querySelector('#backup-restore-key');
  const httpWarning = container.querySelector('#backup-restore-key-http');

  if (!form || !fileInput || !selectedFile || !restoreBtn || !errorEl) return;

  // Das Feld erscheint erst, wenn der Server sagt, dass es gebraucht wird: ein
  // Backup DIESER Installation oeffnet der eigene Schluessel, und ein Feld, das
  // immer dasteht, fragt nach einem Geheimnis, das niemand eingeben muss.
  function showKeyField() {
    if (!keyGroup || !keyInput) return;
    keyGroup.hidden = false;
    // Ueber HTTP geht der Schluessel im Klartext uebers Netz - sagen, nicht sperren.
    const { protocol } = window.location;
    if (httpWarning) httpWarning.hidden = protocol !== 'http:';
    keyInput.setAttribute('aria-describedby', keyFieldDescribedBy(protocol));
    keyInput.focus();
  }

  function resetKeyField() {
    if (!keyGroup || !keyInput) return;
    keyInput.value = '';
    keyGroup.hidden = true;
  }

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
    resetKeyField();
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
    resetKeyField();
    setFile(file);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file) return;
    // Die Warnung zu Dateien ausserhalb der DB stand bisher nur auf dem
    // Dokumentenspeicher-Blatt - also nicht dort, wo sie gebraucht wird.
    if (!await confirmModal(t('settings.backupRestoreConfirm'), {
      danger: true,
      confirmLabel: t('settings.backupRestoreButton'),
      detail: t('settings.backupRestoreDetail'),
    })) return;

    errorEl.hidden = true;
    restoreBtn.disabled = true;
    restoreBtn.textContent = t('settings.backupRestoring');
    // Nur im Header, nie in der URL; nach dem Versuch nicht aufbewahrt.
    const backupKey = keyGroup && !keyGroup.hidden ? keyInput?.value ?? '' : '';
    const headers = backupKey ? { 'X-Backup-Key': encodeBackupKey(backupKey) } : {};
    try {
      await api.rawPost('/backup/restore', file, headers);
      resetKeyField();
      window.yuvomi?.showToast(t('settings.backupRestoredToast'), 'success');
      window.location.reload();
    } catch (err) {
      const action = keyFieldAfterError(err?.data?.reason);
      if (action === 'show') showKeyField();
      else if (action === 'reset') resetKeyField();
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
