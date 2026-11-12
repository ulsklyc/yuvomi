import { api } from '/api.js';
import { t, formatUnit } from '/i18n.js';
import { esc } from '/utils/html.js';
import { savePreferences } from '/settings/preferences-cache.js';
import {
  createInfoList,
  createRetryState,
  createStatusSummary,
  settingRowHtml,
} from '/settings/components.js';
import { errorSentence, loadErrorSentence } from '/utils/friendly-error.js';
import { dateTimeText } from '/utils/date-format.js';

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
          ${/* Eine Zeile der Gruppe (R19, ein Formular-Dialekt). */ ''}
          <div class="row-carrier settings-group">
            ${settingRowHtml({
              label: t('settings.appNameLabel'), labelFor: 'app-name-input',
              control: `<input class="form-input" type="text" id="app-name-input" maxlength="60"
              placeholder="${t('settings.appNamePlaceholder')}"
              value="${esc(cachedAppName() || DEFAULT_APP_NAME)}">`,
            })}
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

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.diagnosticsTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.diagnosticsDescription')}</p>
        <div id="system-diagnostics-host"></div>
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
      errorElement.textContent = errorSentence(error, 'settings.preferenceSaveFailed');
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
      message: loadErrorSentence(err) ?? t('common.errorGeneric'),
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

/* --------------------------------------------------------
   Diagnose (Phase 1b, Abschnitt G): was `GET /system/diagnostics` antwortet,
   als Zeilen zum Lesen und als ein Text zum Einfuegen in einen Fehlerbericht.
   -------------------------------------------------------- */

/**
 * @typedef {object} Diagnostics  Die Antwort von `GET /api/v1/system/diagnostics` (docs/SPEC.md, "Diagnostics").
 * @property {string} version
 * @property {string | null} build_revision
 * @property {string} node
 * @property {string} platform
 * @property {string} arch
 * @property {{ version: string | null, encrypted: boolean }} sqlite
 * @property {number} schema_version
 * @property {string | null} last_migration_at
 * @property {number | null} database_bytes
 * @property {number | null} wal_bytes
 * @property {number | null} data_dir_free_bytes
 * @property {number} uptime_seconds
 * @property {{ last_attempt: string | null, last_success: string | null, reason: string | null,
 *   next_run: string | null, local: boolean | null, webdav: boolean | null }} backup
 * @property {string | null} key_source
 * @property {{ status: string, reason?: string }} ready
 * @property {number | null} modules_installed
 */

/** @typedef {{ label: string, value: string, tone?: 'danger' }} DiagnosticsRow */

/** Warum die Instanz nicht bereit ist. Die beiden uebrigen Gruende (Restore, geschlossene DB) erreichen dieses Blatt nicht. */
const NOT_READY_SENTENCES = new Map([
  ['schema_behind', 'settings.diagnosticsNotReadySchema'],
  ['data_dir_not_writable', 'settings.diagnosticsNotReadyDataDir'],
]);

/** Woher der Datenbankschluessel kommt (`secretOrigin`, server/utils/auto-secrets.js) - nie der Schluessel. */
const KEY_SOURCE_LABELS = new Map([
  ['env', 'settings.diagnosticsKeySourceEnv'],
  ['file', 'settings.diagnosticsKeySourceFile'],
  ['stored', 'settings.diagnosticsKeySourceStored'],
  ['generated', 'settings.diagnosticsKeySourceGenerated'],
]);

/** Der Grund des letzten Fehlschlags als Tatsache in einer Zeile; was zu tun ist, sagt das Blatt "Backup". */
const BACKUP_REASON_LABELS = new Map([
  ['backup_dir_not_writable', 'settings.diagnosticsBackupReasonDirNotWritable'],
  ['disk_full', 'settings.diagnosticsBackupReasonDiskFull'],
  ['backup_verify_failed', 'settings.diagnosticsBackupReasonVerifyFailed'],
]);

/**
 * Eine Groesse in der Einheit, in der sie sich liest. Zahl und Wort kommen aus
 * `formatUnit`, die Teilung durch 1024 wie bei `formatSize` (modules-install.js).
 * @param {number} bytes
 */
function sizeText(bytes) {
  if (bytes >= 1024 ** 3) return formatUnit(bytes / 1024 ** 3, 'gigabyte', { maximumFractionDigits: 1 });
  if (bytes >= 1024 ** 2) return formatUnit(bytes / 1024 ** 2, 'megabyte', { maximumFractionDigits: 1 });
  return formatUnit(Math.round(bytes / 1024), 'kilobyte', { maximumFractionDigits: 0 });
}

/**
 * Die Zeilen in vier Gruppen, in der Reihenfolge, in der ein Fehlerbericht
 * fragt: was laeuft, worauf, mit welcher Datenbank, und ist sie gesichert.
 *
 * Ein Wert, den der Server nicht lesen konnte (`null`), heisst "Unbekannt" -
 * auch im Backup-Block: "Noch nie" steht nur da, wenn der Status lesbar war.
 * Drei Zeilen gibt es nur mit Inhalt: Build, Schluesselquelle, letzter Fehler.
 *
 * @param {Diagnostics} d
 * @param {number} now  Zeitpunkt der Antwort in Millisekunden; aus der Laufzeit wird damit der Startzeitpunkt.
 * @returns {{ title: string, rows: DiagnosticsRow[] }[]}
 */
function diagnosticsGroups(d, now) {
  const unknown = t('settings.diagnosticsUnknown');
  const text = (/** @type {unknown} */ value) => (value === null || value === undefined ? unknown : String(value));
  const size = (/** @type {number | null} */ bytes) => (typeof bytes === 'number' ? sizeText(bytes) : unknown);
  const onOff = (/** @type {boolean | null} */ flag) => (typeof flag === 'boolean'
    ? t(flag ? 'settings.diagnosticsEnabled' : 'settings.diagnosticsDisabled')
    : unknown);
  const stamp = (/** @type {string | null} */ value, missing = unknown) => (value ? dateTimeText(value) : missing);
  const backup = d.backup;
  const backupRead = typeof backup.local === 'boolean';
  const backupStamp = (/** @type {string | null} */ value, /** @type {string} */ missingKey) => (
    stamp(value, backupRead ? t(missingKey) : unknown)
  );

  /** @type {DiagnosticsRow[]} */
  const app = [{ label: t('settings.systemVersionLabel'), value: t('settings.systemVersionValue', { version: d.version }) }];
  if (d.build_revision) app.push({ label: t('settings.diagnosticsBuild'), value: d.build_revision });
  app.push(
    d.ready.status === 'ready'
      ? { label: t('settings.diagnosticsReady'), value: t('settings.diagnosticsReadyYes') }
      : {
        label: t('settings.diagnosticsReady'),
        value: t(NOT_READY_SENTENCES.get(d.ready.reason ?? '') ?? 'settings.diagnosticsNotReady'),
        tone: 'danger',
      },
    {
      label: t('settings.diagnosticsRunningSince'),
      value: dateTimeText(new Date(now - d.uptime_seconds * 1000).toISOString()),
    },
    { label: t('settings.diagnosticsModules'), value: text(d.modules_installed) },
  );

  /** @type {DiagnosticsRow[]} */
  const database = [
    { label: t('settings.diagnosticsSchemaVersion'), value: text(d.schema_version) },
    { label: t('settings.diagnosticsLastMigration'), value: stamp(d.last_migration_at) },
    { label: t('settings.diagnosticsDatabaseSize'), value: size(d.database_bytes) },
    { label: t('settings.diagnosticsWalSize'), value: size(d.wal_bytes) },
    { label: t('settings.diagnosticsFreeSpace'), value: size(d.data_dir_free_bytes) },
    { label: t('settings.diagnosticsEncryption'), value: onOff(d.sqlite.encrypted) },
  ];
  if (d.key_source) {
    const key = KEY_SOURCE_LABELS.get(d.key_source);
    database.push({ label: t('settings.diagnosticsKeySource'), value: key ? t(key) : d.key_source });
  }

  /** @type {DiagnosticsRow[]} */
  const backupRows = [
    { label: t('settings.diagnosticsBackupLocal'), value: onOff(backup.local) },
    { label: t('settings.diagnosticsBackupWebdav'), value: onOff(backup.webdav) },
    { label: t('settings.diagnosticsBackupLastAttempt'), value: backupStamp(backup.last_attempt, 'settings.diagnosticsNever') },
    { label: t('settings.diagnosticsBackupLastSuccess'), value: backupStamp(backup.last_success, 'settings.diagnosticsNever') },
  ];
  if (backup.reason) {
    backupRows.push({
      label: t('settings.diagnosticsBackupLastError'),
      value: t(BACKUP_REASON_LABELS.get(backup.reason) ?? 'settings.diagnosticsBackupReasonUnknown'),
      tone: 'danger',
    });
  }
  backupRows.push({
    label: t('settings.diagnosticsBackupNextRun'),
    value: backupStamp(backup.next_run, 'settings.diagnosticsNotScheduled'),
  });

  return [
    { title: t('settings.diagnosticsGroupApp'), rows: app },
    {
      title: t('settings.diagnosticsGroupServer'),
      rows: [
        // Eigennamen, in jeder Sprache gleich - wie "MIT" in der Karte darueber.
        { label: 'Node.js', value: text(d.node) },
        { label: t('settings.diagnosticsPlatform'), value: `${text(d.platform)} (${text(d.arch)})` },
        { label: 'SQLite', value: text(d.sqlite.version) },
      ],
    },
    { title: t('settings.diagnosticsGroupDatabase'), rows: database },
    { title: t('settings.diagnosticsGroupBackup'), rows: backupRows },
  ];
}

/**
 * Der Text fuer den Fehlerbericht: die Feldnamen der API und die rohen Werte,
 * eine Zeile je Feld, in der Reihenfolge von docs/SPEC.md. Bewusst NICHT
 * uebersetzt und nicht formatiert - wer den Bericht liest, spricht die Sprache
 * der Person nicht unbedingt, und "4,8 MB" ist ungenauer als die Zahl. Jede
 * Zeile steht immer da; was fehlt, ist `null`, wie in der Antwort.
 * @param {Diagnostics} d
 */
function diagnosticsReport(d) {
  const ready = d.ready.status === 'not_ready' ? `not_ready (${d.ready.reason ?? null})` : d.ready.status;
  /** @type {[string, unknown][]} */
  const fields = [
    ['version', d.version],
    ['build_revision', d.build_revision],
    ['node', d.node],
    ['platform', d.platform],
    ['arch', d.arch],
    ['sqlite.version', d.sqlite.version],
    ['sqlite.encrypted', d.sqlite.encrypted],
    ['schema_version', d.schema_version],
    ['last_migration_at', d.last_migration_at],
    ['database_bytes', d.database_bytes],
    ['wal_bytes', d.wal_bytes],
    ['data_dir_free_bytes', d.data_dir_free_bytes],
    ['uptime_seconds', d.uptime_seconds],
    ['backup.last_attempt', d.backup.last_attempt],
    ['backup.last_success', d.backup.last_success],
    ['backup.reason', d.backup.reason],
    ['backup.next_run', d.backup.next_run],
    ['backup.local', d.backup.local],
    ['backup.webdav', d.backup.webdav],
    ['key_source', d.key_source],
    ['ready', ready],
    ['modules_installed', d.modules_installed],
  ];
  return ['Yuvomi diagnostics', ...fields.map(([name, value]) => `${name}: ${value ?? null}`)].join('\n');
}

/**
 * Legt den Text des Feldes in die Zwischenablage und sagt, ob es wirklich
 * geklappt hat. Ueber http im Heimnetz gibt es `navigator.clipboard` nicht;
 * dann bleibt der Auswahl-Weg, und dafuer muss das Feld sichtbar sein. Klappt
 * auch der nicht, steht es markiert da. Dasselbe Muster wie `copyFieldValue`
 * (sync-calendar.js) und `copyInviteLink` (admin-family.js).
 * @param {HTMLTextAreaElement} field
 * @param {(visible: boolean) => void} showField
 */
async function copyReport(field, showField) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(field.value);
      return true;
    } catch { /* auf den Auswahl-Weg zurueckfallen */ }
  }
  showField(true);
  try {
    field.focus();
    field.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  }
}

/**
 * Knopf und Ausweichfeld. Das Feld erscheint nur, wenn der Browser nicht
 * kopieren kann; dann sagt der Satz darunter, was zu tun ist, und kein Toast
 * daneben - die Flaeche zeigt es schon.
 * @param {string} report
 * @returns {HTMLElement[]}
 */
function createCopyControls(report) {
  const actions = document.createElement('div');
  actions.className = 'settings-form-actions settings-diagnostics__actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--secondary';
  const icon = document.createElement('i');
  icon.dataset.lucide = 'copy';
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon, document.createTextNode(` ${t('settings.diagnosticsCopy')}`));
  actions.append(button);

  const field = document.createElement('textarea');
  field.className = 'form-input settings-diagnostics__text';
  field.readOnly = true;
  field.rows = report.split('\n').length;
  field.spellcheck = false;
  field.value = report;
  field.setAttribute('aria-label', t('settings.diagnosticsTextLabel'));
  field.setAttribute('aria-describedby', 'system-diagnostics-copy-hint');
  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.id = 'system-diagnostics-copy-hint';
  hint.textContent = t('settings.diagnosticsCopyFailed');

  const showField = (/** @type {boolean} */ visible) => {
    field.hidden = !visible;
    hint.hidden = !visible;
  };
  showField(false);

  button.addEventListener('click', async () => {
    if (!await copyReport(field, showField)) return;
    // Der Auswahl-Weg hat den Fokus ins Feld gelegt; mit dem Feld ginge er verloren.
    if (!field.hidden) button.focus();
    showField(false);
    window.yuvomi?.showToast(t('settings.diagnosticsCopied'), 'success');
  });

  return [actions, field, hint];
}

/**
 * @param {HTMLElement} host
 * @param {Diagnostics} data
 */
function renderDiagnostics(host, data) {
  const groups = diagnosticsGroups(data, Date.now()).map(({ title, rows }) => {
    const group = document.createElement('div');
    group.className = 'settings-diagnostics__group';
    const heading = document.createElement('h3');
    heading.className = 'settings-card__title';
    heading.textContent = title;
    group.append(heading, createInfoList(rows));
    return group;
  });
  host.replaceChildren(...groups, ...createCopyControls(diagnosticsReport(data)));
  window.lucide?.createIcons({ el: host });
}

/**
 * Eigene Abfrage neben `/version`: scheitert sie, bleibt die Karte darueber
 * stehen, und hier steht ein Satz mit "Erneut versuchen" statt leerer Zeilen.
 * @param {{ querySelector(selector: string): Element | null }} container
 */
async function loadDiagnostics(container) {
  const host = /** @type {HTMLElement | null} */ (container.querySelector('#system-diagnostics-host'));
  if (!host) return;
  const retry = () => loadDiagnostics(container);

  /** @type {Diagnostics | null | undefined} */
  let data;
  try {
    data = (await api.get('/system/diagnostics'))?.data;
  } catch (err) {
    host.replaceChildren(createRetryState({
      message: loadErrorSentence(err) ?? t('common.errorGeneric'),
      onRetry: retry,
    }));
    return;
  }

  if (!data) {
    host.replaceChildren(createRetryState({ message: t('settings.loadError'), onRetry: retry }));
    return;
  }

  renderDiagnostics(host, data);
}

export async function render(container, { user } = {}) {
  void user;
  renderPage(container);
  bindAppNameEvents(container);
  await Promise.all([loadSystemInfo(container), loadDiagnostics(container)]);
  window.lucide?.createIcons({ el: container });
}
