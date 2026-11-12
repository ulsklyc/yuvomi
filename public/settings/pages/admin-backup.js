import { api } from '/api.js';
import { t } from '/i18n.js';
import { dateTimeText } from '/utils/date-format.js';
import { confirmModal, whenModalClosed } from '/components/modal.js';
import { cronScheduleIntervalMs, formatCronSchedule } from '/settings/cron-label.js';
import { wirePasswordToggle } from '/utils/auth-ui.js';
import { errorSentenceWithDetail, errorSentence, loadErrorSentence } from '/utils/friendly-error.js';
import {
  backupKeyFieldHtml,
  encodeBackupKey,
  keyFieldAfterError,
  keyFieldDescribedBy,
  restoreErrorText,
} from '/settings/backup-key.js';
import {
  createDisclosure,
  createInfoRow,
  createRetryState,
  settingRowHtml,
  settingSwitchRowHtml,
} from '/settings/components.js';

// Zeitplan-Zelle: der Klartext trägt die Aussage, der Cron-Ausdruck bleibt als
// Beleg daneben stehen. Ohne erkanntes Muster ist der Ausdruck die Aussage.
function scheduleValue(schedule) {
  const readable = formatCronSchedule(schedule);
  if (!readable) return { value: schedule, code: true };

  // DER AUSDRUCK STEHT HINTER "MEHR DAZU" (Critique R24 G6-Einst-P3-4):
  // unter "Taeglich um 02:00" stand "0 2 * * *" fuer jeden sichtbar - ein
  // Beleg fuer wenige, Rauschen fuer alle. Ein natives <details> wie die
  // Hinweise der Blaetter (hintFoldHtml).
  const wrapper = document.createElement('span');
  wrapper.className = 'settings-info-value__stack';
  const text = document.createElement('span');
  text.textContent = readable;
  const more = document.createElement('details');
  more.className = 'settings-hint-fold__more';
  const summary = document.createElement('summary');
  summary.className = 'settings-hint-fold__summary';
  summary.textContent = t('settings.hintMore');
  const chevron = document.createElement('i');
  chevron.setAttribute('data-lucide', 'chevron-down');
  chevron.className = 'settings-hint-fold__icon';
  chevron.setAttribute('aria-hidden', 'true');
  summary.append(chevron);
  const expression = document.createElement('code');
  expression.textContent = schedule;
  more.append(summary, expression);
  wrapper.append(text, more);
  return { value: wrapper, code: false };
}

// Dieselben vier Gruende wie scheduler.lastError.reason
// (server/services/backup-scheduler.js): nie null, wenn lastError es nicht
// ist. Ein Grund ausserhalb dieser Liste faellt auf den Allgemeinsatz zurueck
// statt die Zeile zu verlieren.
/** @type {Record<string, string>} */
const BACKUP_ERROR_REASON_KEYS = {
  backup_dir_not_writable: 'settings.backupSchedulerReasonDirNotWritable',
  disk_full: 'settings.backupSchedulerReasonDiskFull',
  backup_verify_failed: 'settings.backupSchedulerReasonVerifyFailed',
  unknown: 'settings.backupSchedulerReasonUnknown',
};

/**
 * Der Satz zu einem Grund, für die Zeile der Karte und für den Toast nach
 * "Jetzt Backup erstellen": beide nennen denselben Fehlschlag.
 * @param {string | null | undefined} reason
 */
function backupReasonSentence(reason) {
  return t((reason && BACKUP_ERROR_REASON_KEYS[reason]) || 'common.errorGeneric');
}

// WARUM DER GRUND UND NICHT NUR "fehlgeschlagen": der Admin muss wissen, WAS
// zu tun ist - eine volle Platte und ein unschreibbares BACKUP_DIR verlangen
// Verschiedenes. Ein erfolgreicher Lauf setzt lastError auf null; diese
// Funktion gibt dann null, und die Zeile verschwindet von selbst (#2525). Nur
// `reason` wird gelesen, nie der rohe `message`-Text des Systemfehlers
// (#1909) - der steht im Server-Log.
/** @param {{ timestamp?: string, reason?: string | null, message?: string } | null} lastError */
export function backupErrorRow(lastError) {
  if (!lastError) return null;
  return createInfoRow({
    label: t('settings.backupSchedulerLastError'),
    value: backupReasonSentence(lastError.reason),
    tone: 'danger',
  });
}

/**
 * Was die Karte vom Scheduler liest (`scheduler` aus `GET /backup/status`).
 * @typedef {{
 *   enabled?: boolean,
 *   schedule?: string,
 *   keepCount?: number,
 *   lastBackup?: { timestamp?: string, success?: boolean, reason?: string } | null,
 *   lastError?: { timestamp?: string, reason?: string | null, message?: string } | null,
 *   lastSuccess?: string | null,
 *   nextRun?: string | null,
 * }} BackupSchedulerStatus
 */

/**
 * Wann zuletzt ein Backup gelang, oder null. `lastSuccess` überlebt einen
 * Fehlschlag; `lastBackup` ist nur der letzte Lauf und trägt den Zeitpunkt
 * allein dann, wenn dieser Lauf gelang.
 * @param {BackupSchedulerStatus} scheduler
 * @returns {string | null}
 */
function lastSuccessfulBackup(scheduler) {
  if (scheduler.lastSuccess) return scheduler.lastSuccess;
  return scheduler.lastBackup?.success ? (scheduler.lastBackup.timestamp ?? null) : null;
}

/**
 * Ist das letzte gelungene Backup überfällig?
 *
 * Ja, wenn es älter ist als ZWEI Abstände des Zeitplans: ein einzelner
 * ausgefallener Lauf (Neustart zur falschen Minute, ein Update) ist noch kein
 * Befund, zwei in Folge sind einer. Und ja, wenn schon ein Lauf versucht wurde
 * und noch nie einer gelang - dafür braucht es keinen Abstand.
 *
 * Nein bei einem Zeitplan, den `cron-label.js` nicht erkennt: aus einer Liste
 * oder einem Bereich lässt sich kein Abstand ablesen, und eine geratene
 * Warnung auf einer Backup-Seite ist schlimmer als keine.
 *
 * `now` ist ein ZEITPUNKT (Millisekunden), kein Tagesschlüssel: verglichen
 * werden zwei Zeitpunkte, die Haushaltszone spielt dabei keine Rolle.
 * Exportiert für Tests.
 *
 * @param {BackupSchedulerStatus} scheduler
 * @param {number} now
 * @returns {boolean}
 */
export function backupSuccessOverdue(scheduler, now) {
  if (!scheduler?.enabled) return false;
  const lastSuccess = lastSuccessfulBackup(scheduler);
  if (!lastSuccess) return Boolean(scheduler.lastBackup?.timestamp);
  const interval = cronScheduleIntervalMs(scheduler.schedule);
  if (interval == null) return false;
  const succeededAt = Date.parse(lastSuccess);
  if (Number.isNaN(succeededAt)) return false;
  return now - succeededAt > 2 * interval;
}

/**
 * Die Zeilen zum Stand der Backups. ZWEI AUSSAGEN, NICHT EINE: "Letztes
 * Backup" ist immer das letzte, das GELANG - das, worauf sich ein Restore
 * stützen kann. Stünde dort nach einem Fehlschlag dessen Datum mit
 * "(fehlgeschlagen)", wäre von der Karte verschwunden, wann zuletzt eines
 * gelang. Der fehlgeschlagene Lauf und sein Grund kommen als eigene Zeilen
 * dazu und gehen mit dem nächsten Erfolg wieder; gelang der letzte Lauf, sagt
 * "Letztes Backup" schon alles.
 *
 * Überfällig trägt die Zeile, um deren Datum es geht: Warnton und ein Satz
 * darunter, kein eigener Block - die Fehlerzeile bleibt das Lauteste der
 * Karte.
 *
 * @param {BackupSchedulerStatus} scheduler
 * @param {number} now
 * @returns {HTMLDivElement[]}
 */
function backupOutcomeRows(scheduler, now) {
  const lastSuccess = lastSuccessfulBackup(scheduler);
  const overdue = backupSuccessOverdue(scheduler, now);

  const lastBackupText = lastSuccess
    ? t('settings.backupSchedulerLastSuccess', { date: dateTimeText(lastSuccess) })
    : t('settings.backupSchedulerNever');
  /** @type {string | HTMLElement} */
  let lastBackupValue = lastBackupText;
  if (overdue && lastSuccess) {
    const stack = document.createElement('span');
    stack.className = 'settings-info-value__stack';
    const date = document.createElement('span');
    date.textContent = lastBackupText;
    const note = document.createElement('span');
    note.textContent = t('settings.backupSchedulerOverdue');
    stack.append(date, note);
    lastBackupValue = stack;
  }

  const rows = [
    createInfoRow({
      label: t('settings.backupSchedulerLastBackup'),
      value: lastBackupValue,
      tone: overdue ? 'warning' : null,
    }),
  ];

  const { lastBackup } = scheduler;
  if (lastBackup?.timestamp && lastBackup.success === false) {
    rows.push(createInfoRow({
      label: t('settings.backupSchedulerLastAttempt'),
      value: t('settings.backupSchedulerLastFail', { date: dateTimeText(lastBackup.timestamp) }),
    }));
  }

  const errorRow = backupErrorRow(scheduler.lastError ?? null);
  if (errorRow) rows.push(errorRow);
  return rows;
}

/**
 * Der Ton an "Aktiv". Der TEXT stimmt immer, solange der Zeitplan läuft; das
 * GRÜN sagt mehr, nämlich "hier ist nichts zu tun". Neben einer roten
 * Fehlerzeile oder einer Warnung am letzten Backup widerspräche es der Karte,
 * auf der es steht. Der Erfolgston bleibt deshalb nur, solange der letzte Lauf
 * nicht fehlschlug und kein Backup überfällig ist; sonst steht "Aktiv" ohne
 * Ton da. Kein dritter Ton an dieser Zeile: Fehler und Warnung haben ihre
 * eigene.
 * Exportiert für Tests.
 *
 * @param {BackupSchedulerStatus} scheduler
 * @param {number} now
 * @returns {'success' | null}
 */
export function backupStatusTone(scheduler, now) {
  if (!scheduler?.enabled) return null;
  if (scheduler.lastError || scheduler.lastBackup?.success === false) return null;
  return backupSuccessOverdue(scheduler, now) ? null : 'success';
}

/**
 * Die Zeile zum nächsten geplanten Lauf, oder null. `nextRun` ist null,
 * solange kein Zeitplan läuft; ein Wert, der kein Zeitpunkt ist, ergäbe eine
 * leere Zeile und bleibt deshalb ebenfalls weg.
 *
 * @param {BackupSchedulerStatus} scheduler
 * @returns {HTMLDivElement | null}
 */
function backupNextRunRow(scheduler) {
  const { nextRun } = scheduler;
  if (!nextRun || Number.isNaN(Date.parse(nextRun))) return null;
  return createInfoRow({
    label: t('settings.backupSchedulerNextRun'),
    value: dateTimeText(nextRun),
  });
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

      ${/* Der Datenbankschluessel gehoert neben das Backup, das ohne ihn nicht
           aufgeht. Versteckt, bis der Status sagt, woher er kommt - eine Karte
           ohne Aussage laese sich als "kein Schluessel". */ ''}
      <div class="settings-card settings-backup-card" id="backup-db-key-card" hidden>
        <div class="settings-backup-card__icon">
          <i data-lucide="key-round" aria-hidden="true"></i>
        </div>
        <div class="settings-backup-card__body">
          <h3 class="settings-card__title" id="backup-db-key-title">${t('settings.backupDbKeyTitle')}</h3>
          <p class="form-hint" id="backup-db-key-hint"></p>
          <div class="settings-token-output settings-db-key" id="backup-db-key-output" hidden></div>
          <div class="settings-form-actions" id="backup-db-key-actions" hidden>
            <button type="button" class="btn btn--secondary" id="backup-db-key-toggle"
              aria-expanded="false" aria-controls="backup-db-key-output">${t('settings.backupDbKeyShow')}</button>
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
              <span><span class="u-pointer-only">${t('settings.backupDropzoneTitle')}</span><span class="u-touch-only">${t('settings.backupDropzoneTitleTouch')}</span></span>
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
        <h3 class="settings-card__title">${t('settings.backupWebdavTitle')}</h3>
        <p class="form-hint">${t('settings.backupWebdavHint')}</p>
        <form class="settings-form settings-webdav-form" id="backup-webdav-form" novalidate>
          ${/* EIN FORMULAR-DIALEKT (R19, Einstellungen B7): Schalter und fuenf
               Felder als Zeilen der Gruppe - Etikett links, Feld rechts, wie
               SMTP und Konto. Vorher stand der Schalter in einer eigenen
               Leiste und jedes Feld UNTER seinem Etikett. */ ''}
          <div class="row-carrier settings-group">
            ${settingSwitchRowHtml({
              label: t('settings.backupWebdavEnabled'),
              attrs: { id: 'webdav-enabled', name: 'enabled' },
            })}
            ${settingRowHtml({
              label: t('settings.backupWebdavUrl'), labelFor: 'webdav-url',
              control: `<input class="form-input" type="url" id="webdav-url" name="url"
                placeholder="${t('settings.backupWebdavUrlPlaceholder')}" autocomplete="off" />`,
            })}
            ${settingRowHtml({
              label: t('settings.backupWebdavUsername'), labelFor: 'webdav-username',
              control: `<input class="form-input" type="text" id="webdav-username" name="username" autocomplete="off" />`,
            })}
            ${settingRowHtml({
              label: t('settings.backupWebdavPassword'), labelFor: 'webdav-password',
              // Das Auge sitzt IM Feld (wirePasswordToggle, Critique R24 G6-Einst-P3-4).
              control: `<input class="form-input" type="password" id="webdav-password" name="password"
                  autocomplete="new-password"
                  placeholder="${t('settings.backupWebdavPasswordPlaceholder')}" />`,
            })}
            ${settingRowHtml({
              label: t('settings.backupWebdavPath'), labelFor: 'webdav-path',
              control: `<input class="form-input" type="text" id="webdav-path" name="remotePath"
                placeholder="${t('settings.backupWebdavPathPlaceholder')}" />`,
            })}
            ${settingRowHtml({
              label: t('settings.backupWebdavKeep'), labelFor: 'webdav-keep',
              control: `<input class="form-input settings-input--compact" type="number" id="webdav-keep" name="keep" min="1" max="99" />`,
            })}
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
docker compose run --rm -v "$BACKUP:/tmp/yuvomi-restore.db:ro" --entrypoint sh "$SERVICE" -c 'set -eu; node server/check-backup.js /tmp/yuvomi-restore.db; target="\${DB_PATH:-/data/yuvomi.db}"; case "$target" in */oikos.db) target="\${target%/oikos.db}/yuvomi.db";; esac; stamp=$(date -u +%Y%m%dT%H%M%SZ); if [ -f "$target" ]; then cp "$target" "$target.pre-restore-$stamp.0.partial"; sync; mv "$target.pre-restore-$stamp.0.partial" "$target.pre-restore-$stamp"; fi; staging="$target.restore-tmp-0-$stamp"; cp /tmp/yuvomi-restore.db "$staging"; chmod 600 "$staging" 2&gt;/dev/null || true; chown node:node "$staging" 2&gt;/dev/null || true; sync; if [ -f "$target-wal" ]; then if [ -s "$target" ]; then mv "$target-wal" "$target.pre-restore-$stamp-wal"; else mv "$target-wal" "$target.pre-restore-$stamp.wal-kept"; fi; fi; rm -f "$target-shm"; sync; mv "$staging" "$target"; sync'
docker compose up -d "$SERVICE"</code></pre>
    <p class="form-hint">${t('settings.backupCliForeignKeyHint')}</p>
    <p class="form-hint">${t('settings.backupCliBackupHint')}</p>
    <pre class="settings-code-block"><code>docker compose exec yuvomi node --import ./server/utils/load-secrets-readonly.js -e "import('./server/db.js').then(async db =&gt; { await db.backupToFile('/data/yuvomi-backup.db'); process.exit(0); })"
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
      message: loadErrorSentence(error) ?? t('settings.loadError'),
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

    renderDatabaseKeyCard(container, res.data?.database_key);
    const { enabled, schedule, keepCount } = scheduler;
    // EIN "jetzt" für die ganze Karte: der Ton an "Aktiv" und die Warnung am
    // letzten Backup messen dasselbe und dürfen sich nicht widersprechen.
    const now = Date.now();

    const rows = [
      createInfoRow({
        label: t('settings.backupSchedulerStatus'),
        value: enabled ? t('settings.backupSchedulerEnabled') : t('settings.backupSchedulerDisabled'),
        tone: backupStatusTone(scheduler, now),
      }),
    ];

    if (enabled) {
      rows.push(createInfoRow({ label: t('settings.backupSchedulerSchedule'), ...scheduleValue(schedule) }));
      rows.push(createInfoRow({
        label: t('settings.backupSchedulerKeep'),
        value: t('settings.backupSchedulerKeepCount', { count: keepCount }),
      }));
      rows.push(...backupOutcomeRows(scheduler, now));
      // NACH DEN ERGEBNISSEN, NICHT BEIM ZEITPLAN: die Karte liest sich von
      // gestern nach morgen, und "wann versucht er es wieder" ist die Frage,
      // die ein Fehlschlag aufwirft - die Antwort steht direkt darunter, über
      // dem Knopf, der die Alternative zum Warten ist. Neben "Täglich um
      // 02:00" stünde zweimal fast dasselbe.
      const nextRunRow = backupNextRunRow(scheduler);
      if (nextRunRow) rows.push(nextRunRow);

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
          // DIE ANTWORT LESEN: ein fehlgeschlagener Lauf kommt als 200 mit
          // `success: false` zurück, nicht als Fehler. Ungelesen stünde
          // "Backup erfolgreich erstellt." über einer Karte, die gleich
          // darauf den Fehlschlag zeigt. Erfolg ist nur ein ausdrückliches
          // `true`; alles andere nennt den Grund.
          const result = (await api.post('/backup/trigger'))?.data;
          if (result?.success === true) {
            window.yuvomi?.showToast(t('settings.backupSchedulerTriggeredToast'), 'success');
          } else {
            window.yuvomi?.showToast(backupReasonSentence(result?.reason), 'danger');
          }
          // In beiden Fällen: die Zeilen sollen den Lauf zeigen, der gerade war.
          loadBackupSchedulerStatus(container);
        } catch (err) {
          window.yuvomi?.showToast(errorSentence(err), 'danger');
          triggerBtn.disabled = false;
          triggerBtn.textContent = t('settings.backupSchedulerTrigger');
        }
      });
    }
  } catch (err) {
    failWithRetry(err);
  }
}

/**
 * Karte "Datenbankschluessel" aus `database_key` des Status (nur Herkunft, nie
 * der Wert). Den Wert holt erst der Klick auf "Anzeigen" ueber eine eigene
 * Route, die jeden Abruf protokolliert; "Ausblenden" nimmt ihn wieder aus dem
 * DOM, statt ihn nur zu verstecken. Einen Wert gibt es nur fuer den Schluessel,
 * den Yuvomi selbst erzeugt hat - einer aus Env oder `_FILE` steht schon in der
 * Konfiguration des Betreibers.
 * Exportiert fuer Tests.
 */
export function renderDatabaseKeyCard(container, status) {
  const card = container.querySelector('#backup-db-key-card');
  if (!card || !status) return;
  const hint = card.querySelector('#backup-db-key-hint');
  const actions = card.querySelector('#backup-db-key-actions');
  const output = card.querySelector('#backup-db-key-output');
  const toggle = card.querySelector('#backup-db-key-toggle');

  const generated = status.encrypted && (status.origin === 'generated' || status.origin === 'stored');
  hint.textContent = !status.encrypted
    ? t('settings.backupDbKeyPlainHint')
    : generated ? t('settings.backupDbKeyGeneratedHint') : t('settings.backupDbKeyConfigHint');
  actions.hidden = !generated;
  card.hidden = false;
  if (!generated || toggle.dataset.bound) return;
  toggle.dataset.bound = 'true';

  const hide = () => {
    output.replaceChildren();
    output.hidden = true;
    toggle.textContent = t('settings.backupDbKeyShow');
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.addEventListener('click', async () => {
    if (toggle.getAttribute('aria-expanded') === 'true') { hide(); return; }
    toggle.disabled = true;
    try {
      const res = await api.get('/backup/database-key');
      const { key, path } = res.data ?? {};
      if (!key) {
        // Die Herkunft hat sich seit dem Laden geaendert (Neustart mit Env-Key).
        renderDatabaseKeyCard(container, res.data);
        return;
      }
      output.replaceChildren(buildDatabaseKeyOutput(key, path));
      output.hidden = false;
      toggle.textContent = t('settings.backupDbKeyHide');
      toggle.setAttribute('aria-expanded', 'true');
      window.lucide?.createIcons({ el: output });
    } catch (err) {
      window.yuvomi?.showToast(errorSentence(err), 'danger');
    } finally {
      toggle.disabled = false;
    }
  });
}

function buildDatabaseKeyOutput(key, path) {
  const fragment = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'settings-token-output__row';
  const input = document.createElement('input');
  input.className = 'form-input settings-db-key__value';
  input.type = 'text';
  input.readOnly = true;
  input.value = key;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-labelledby', 'backup-db-key-title');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn--secondary btn--sm';
  const icon = document.createElement('i');
  icon.dataset.lucide = 'copy';
  icon.className = 'icon-sm';
  icon.setAttribute('aria-hidden', 'true');
  copy.append(icon, document.createTextNode(` ${t('settings.backupDbKeyCopy')}`));
  copy.addEventListener('click', async () => {
    // Ohne HTTPS gibt es navigator.clipboard nicht - auf einer Heim-Instanz im
    // LAN der Normalfall. Dann ist "kopiert" gelogen; markieren hilft weiter.
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(input.value);
      window.yuvomi?.showToast(t('settings.backupDbKeyCopied'), 'success');
    } catch {
      input.focus();
      input.select();
      window.yuvomi?.showToast(t('settings.backupDbKeyCopyFailed'), 'danger');
    }
  });
  row.append(input, copy);
  fragment.append(row);
  if (path) {
    const where = document.createElement('p');
    where.className = 'form-hint settings-db-key__path';
    where.textContent = t('settings.backupDbKeyStoredAt', { path });
    fragment.append(where);
  }
  return fragment;
}

function renderWebdavStatus(grid, container, d) {
  if (!grid) return;
  if (!d.configured) { grid.replaceChildren(); return; }

  const lastUploadValue = d.lastUpload
    ? dateTimeText(d.lastUpload)
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
        window.yuvomi?.showToast(errorSentenceWithDetail(err, 'settings.connectionFailedDetail'), 'danger');
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
      message: loadErrorSentence(error) ?? t('settings.loadError'),
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

/**
 * Fehlermeldung einer WebDAV-Anfrage: `password_required` (neuer Server oder
 * Benutzer ohne neues Passwort) und `url_invalid` uebersetzt, sonst der Satz
 * der App (#1909). Nur Speichern: das Testen zeigt die Antwort des Servers.
 * Exportiert fuer test/test-settings-backup-key.js.
 */
export function webdavErrorMessage(err) {
  if (err?.data?.errorCode === 'password_required') return t('settings.backupWebdavPasswordRequired');
  if (err?.data?.errorCode === 'url_invalid') return t('settings.backupWebdavUrlInvalid');
  if (err?.data?.errorCode === 'config_incomplete') return t('settings.backupWebdavConfigIncomplete');
  return errorSentence(err);
}

/**
 * Message of the connection test (#2622): the route's own cases come in
 * `errorCode` and get their sentence; a refusal of the server its class in the
 * frame, a local failure its case sentence (errorSentenceWithDetail).
 * Exported for test/test-settings-backup-key.js.
 */
export function webdavTestErrorMessage(err) {
  if (typeof err?.data?.errorCode === 'string') return webdavErrorMessage(err);
  return errorSentenceWithDetail(err, 'settings.backupWebdavTestFailed');
}

function bindWebdavBackupEvents(container) {
  const form = container.querySelector('#backup-webdav-form');
  const testBtn = container.querySelector('#webdav-test-btn');
  const resultEl = container.querySelector('#webdav-test-result');
  if (!form) return;

  loadWebdavConfig(container);

  wirePasswordToggle(form.querySelector('#webdav-password'), { show: t('login.showPassword'), hide: t('login.hidePassword') });

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
        resultEl.textContent = webdavTestErrorMessage(err);
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
      window.yuvomi?.showToast(webdavErrorMessage(err), 'danger');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('settings.backupWebdavSaveBtn'); }
    }
  });
}

/** Exportiert fuer test/test-settings-backup-key.js: dort laeuft der Handler als Programm. */
export function bindRestoreEvents(container) {
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
    describeKeyField();
  }

  function resetKeyField() {
    if (!keyGroup || !keyInput) return;
    keyInput.value = '';
    keyInput.removeAttribute('aria-invalid');
    keyGroup.hidden = true;
  }

  // Die Fehlerbox gehoert ins describedby des Feldes, solange sie zu sehen ist
  // - Regel und Grund in keyFieldDescribedBy().
  function describeKeyField() {
    keyInput?.setAttribute(
      'aria-describedby',
      keyFieldDescribedBy(window.location.protocol, { withError: !errorEl.hidden }),
    );
  }

  function hideError() {
    errorEl.hidden = true;
    describeKeyField();
  }

  // Ein neuer Versuch am Schluessel nimmt die Markierung des alten zurueck.
  keyInput?.addEventListener('input', () => keyInput.removeAttribute('aria-invalid'));

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
    hideError();
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
    hideError();
    resetKeyField();
    setFile(file);
  });

  // Waehrend des Requests wird der Knopf NICHT `disabled` - dasselbe wie bei
  // „Auf anderen Geraeten abmelden" (#1423): ein deaktivierter Knopf nimmt den
  // Fokus nicht an, den das Modal ihm beim Schliessen zurueckgibt, und er fiel
  // auf #main-content. Die Sperre haelt `restoring`, `aria-disabled` sagt sie an.
  let restoring = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (restoring) return;
    const file = fileInput.files?.[0];
    if (!file) return;
    restoring = true;
    // Die Warnung zu Dateien ausserhalb der DB stand bisher nur auf dem
    // Dokumentenspeicher-Blatt - also nicht dort, wo sie gebraucht wird.
    if (!await confirmModal(t('settings.backupRestoreConfirm'), {
      danger: true,
      confirmLabel: t('settings.backupRestoreButton'),
      detail: t('settings.backupRestoreDetail'),
    })) {
      restoring = false;
      return;
    }
    // Mobil ist das Modal hier noch nicht zu: es schliesst animiert (bis zu
    // 400 ms) und gibt DANN den Fokus an den Ausloeser zurueck. Eine schnellere
    // Antwort setzte den Fokus ins Feld, und das Schliessen zoege ihn wieder ab.
    const modalClosed = whenModalClosed();

    hideError();
    restoreBtn.setAttribute('aria-disabled', 'true');
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
      const reason = err?.data?.reason;
      const action = keyFieldAfterError(reason);
      if (action === 'show') showKeyField();
      else if (action === 'reset') resetKeyField();
      // Nur ein widerlegter Schluessel ist ein ungueltiger Eintrag.
      if (reason === 'backup_key_wrong') keyInput?.setAttribute('aria-invalid', 'true');
      else keyInput?.removeAttribute('aria-invalid');
      showError(errorEl, restoreErrorText(err));
      describeKeyField();
      restoring = false;
      restoreBtn.removeAttribute('aria-disabled');
      restoreBtn.textContent = t('settings.backupRestoreButton');
      await modalClosed;
      // Nur einen Fokus umsetzen, den niemand selbst gewaehlt hat: wo das
      // Modal ihn abgelegt hat (Knopf, Seitenwurzel, body) oder schon im Feld.
      // Wer waehrend einer langen Anfrage weitergearbeitet hat, bleibt dort.
      const current = document.activeElement;
      const untouched = !current || current === document.body || current.id === 'main-content'
        || current === restoreBtn || current === keyInput;
      if (!untouched) return;
      const fieldAppeared = action === 'show' && keyGroup && !keyGroup.hidden;
      (fieldAppeared ? keyInput : restoreBtn).focus();
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
