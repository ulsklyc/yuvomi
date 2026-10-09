/**
 * Blatt: Einstellungen -> Module -> Eigenes Modul hinzufuegen (adminOnly)
 *
 * Ein Drittmodul ist JavaScript vom selben Ursprung: es laeuft mit der Sitzung
 * jedes Mitglieds, das es oeffnet. Es hier zu installieren ist dasselbe wie
 * einen Ordner nach `modules/` zu kopieren, nur ohne Shell-Zugang. Deshalb
 * steht der Sicherheitshinweis VOR den beiden Wegen, und ein neues Modul kommt
 * ausgeschaltet an - eingeschaltet wird es in "Aktive Module", wo der Admin
 * es vorher ansehen kann. Der ganze Weg ist eine Entscheidung des Betreibers
 * (`MODULES_ALLOW_WEB_INSTALL`, Review zu PR #1671): ohne den Schalter zeigt
 * das Blatt nur den Weg von Hand, genau wie bei einem schreibgeschuetzten oder
 * nicht dauerhaften Modulordner (`installPageStatus`).
 *
 * Zwei Wege, ein Ablauf (`runInstall`): GitHub-Adresse oder ZIP-Datei. Die
 * Antworten des Servers, die eine Rueckfrage brauchen, laufen hier wieder in
 * denselben Ablauf: 409 `exists` fragt, ob ersetzt werden soll, und schickt
 * dann mit `overwrite`; 422 `multiple` zeigt die gefundenen Module zur Wahl
 * und schickt dann mit `path`. `exists` kommt nur fuer einen Ordner MIT
 * Installationsdatensatz; einen von Hand kopierten ersetzt der Server nicht
 * (409 `not_web_installed`, Review Runde 4 zu PR #1671), und das Blatt zeigt
 * dann den Satz dazu (installErrorText) statt der Ersetzen-Rueckfrage.
 */

import { api } from '/api.js';
import { formatUnit, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal } from '/components/modal.js';
import { moduleDisplayLabel } from '/utils/extension-i18n.js';
import { createDisclosure, createRetryState, createStatusSummary } from '/settings/components.js';
import { installErrorText } from '/settings/module-install-errors.js';

const ACTIVE_MODULES_PATH = '/settings/modules/active';
const MODULES_GUIDE_URL = 'https://github.com/ulsklyc/yuvomi/blob/main/MODULES.md';
const DEFAULT_MAX_ZIP_MB = 20;

// Die Abbildung reason -> Meldung liegt in /settings/module-install-errors.js,
// weil auch der Loeschen-Toast in modules-active.js sie braucht. Hier
// re-exportiert, damit Tests und Aufrufer sie weiter an dieser Stelle finden.
export { installErrorText };

/**
 * Pruefung VOR dem Hochladen: dieselben Grenzen wie der Server, damit ein
 * 300-MB-Video nicht erst ganz uebertragen wird, um dann abgelehnt zu werden.
 * @returns {string|null} Fehlermeldung oder null
 */
export function zipFileProblem(file, maxZipMb = DEFAULT_MAX_ZIP_MB) {
  if (!file) return null;
  if (!/\.zip$/i.test(String(file.name ?? ''))) return t('settings.installModuleFileNotZip');
  if (Number(file.size) > maxZipMb * 1024 * 1024) return t('settings.installModuleFileTooLarge', { max: maxZipMb });
  return null;
}

/** Query der ZIP-Route: `?overwrite=1&path=...` (beides optional). */
export function installQuery({ overwrite = false, path = null } = {}) {
  const params = new URLSearchParams();
  if (overwrite) params.set('overwrite', '1');
  if (typeof path === 'string') params.set('path', path);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Groesse der gewaehlten Datei, Zahl und Einheit aus der Locale (formatUnit:
 * das Wort aus der UI-Sprache, die Ziffern aus der Region). Ein von Hand
 * gebautes "1.5 MB" ging an beidem vorbei (Review zu PR #1671).
 */
export function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return formatUnit(size / (1024 * 1024), 'megabyte', { maximumFractionDigits: 1 });
  return formatUnit(Math.max(1, Math.round(size / 1024)), 'kilobyte', { maximumFractionDigits: 0 });
}

function moduleWithVersion(name, version) {
  return version ? `${name} ${version}` : name;
}

function sendInstall(source, options) {
  if (source.kind === 'github') {
    const body = { url: source.url };
    if (options.overwrite) body.overwrite = true;
    if (typeof options.path === 'string') body.path = options.path;
    return api.post('/modules/install/github', body);
  }
  return api.rawPost(`/modules/install/zip${installQuery(options)}`, source.file, { 'Content-Type': 'application/zip' });
}

function pageHtml(maxZipMb) {
  return `
    <section class="settings-section">
      <div id="module-install-notice"></div>

      <div class="settings-card settings-backup-card">
        <div class="settings-backup-card__icon">
          <i data-lucide="github" aria-hidden="true"></i>
        </div>
        <div class="settings-backup-card__body" data-install-card="github">
          <h3 class="settings-card__title">${esc(t('settings.installModuleGithubTitle'))}</h3>
          <p class="form-hint">${esc(t('settings.installModuleGithubHint'))}</p>
          <form class="settings-form settings-form--compact" data-install-form novalidate>
            <div class="form-group">
              <label class="form-label" for="module-install-url">${esc(t('settings.installModuleGithubUrlLabel'))}</label>
              <input class="form-input" type="url" id="module-install-url" name="url" inputmode="url"
                autocomplete="off" spellcheck="false" autocapitalize="off"
                placeholder="https://github.com/owner/repo" aria-describedby="module-install-url-hint" />
              <p class="form-hint" id="module-install-url-hint">${esc(t('settings.installModuleGithubExamples'))}</p>
            </div>
            <div class="form-error" role="alert" data-install-error hidden></div>
            <div class="settings-form-actions">
              <button type="submit" class="btn btn--primary" data-install-button>${esc(t('settings.installModuleButton'))}</button>
            </div>
          </form>
          <div data-install-candidates hidden></div>
          <div class="settings-module-install__result" role="status" data-install-result></div>
        </div>
      </div>

      <div class="settings-card settings-backup-card">
        <div class="settings-backup-card__icon">
          <i data-lucide="file-archive" aria-hidden="true"></i>
        </div>
        <div class="settings-backup-card__body" data-install-card="zip">
          <h3 class="settings-card__title">${esc(t('settings.installModuleZipTitle'))}</h3>
          <p class="form-hint">${esc(t('settings.installModuleZipHint', { max: maxZipMb }))}</p>
          <form class="settings-form settings-form--compact" data-install-form novalidate>
            <label class="settings-backup-dropzone" id="module-install-dropzone" for="module-install-file">
              <i data-lucide="upload-cloud" aria-hidden="true"></i>
              <span>${esc(t('settings.installModuleDropzoneTitle'))}</span>
              <small>${esc(t('settings.installModuleDropzoneHint'))}</small>
            </label>
            <input class="sr-only" type="file" id="module-install-file" accept=".zip,application/zip" />
            <div class="settings-backup-file" data-install-file hidden></div>
            <div class="form-error" role="alert" data-install-error hidden></div>
            <div class="settings-form-actions">
              <button type="submit" class="btn btn--primary" data-install-button disabled>${esc(t('settings.installModuleButton'))}</button>
            </div>
          </form>
          <div data-install-candidates hidden></div>
          <div class="settings-module-install__result" role="status" data-install-result></div>
        </div>
      </div>
    </section>
  `;
}

function noticeElement() {
  return createStatusSummary({
    title: t('settings.installModuleSecurityTitle'),
    status: t('settings.installModuleSecurityText'),
    details: [t('settings.installModuleSecurityDisabled')],
    tone: 'warning',
    // Direkt unter dem Blatt-Titel (h1): sonst springt das Outline auf h3.
    level: 2,
  });
}

/**
 * Warum das Blatt keine Installationswege zeigt, oder null, wenn es sie zeigt.
 * Drei Faelle, ein Bild (der "Weg von Hand" mit Link auf MODULES.md):
 *  - 'not_writable': der Modulordner ist schreibgeschuetzt (:ro-Mount);
 *  - 'web_install_off': der Betreiber hat `MODULES_ALLOW_WEB_INSTALL` nicht
 *    gesetzt - der Server lehnt jede Installation mit 403 ab, Knoepfe, die nur
 *    scheitern koennen, gibt es nicht;
 *  - 'not_persistent': der Ordner liegt im Container statt auf einem Volume,
 *    ein installiertes Modul waere nach dem naechsten Update weg (Umbrel,
 *    Container ohne Volume). Frueher nur ein Hinweis ueber den Knoepfen; seit
 *    dem Review zu PR #1671 wie schreibgeschuetzt.
 * Die Reihenfolge ist die Haerte: ein :ro-Mount hilft auch der Schalter nicht,
 * und ein Schalter, der aus ist, erklaert mehr als ein fehlendes Volume. Nur
 * ein sicheres `false` zaehlt; `null` heisst "unbekannt" und bleibt still.
 * @returns {'not_writable'|'web_install_off'|'not_persistent'|null}
 */
export function installPageStatus(info) {
  if (info?.writable === false) return 'not_writable';
  if (info?.webInstall === false) return 'web_install_off';
  if (info?.persistent === false) return 'not_persistent';
  return null;
}

const STATUS_KEYS = Object.freeze({
  not_writable: {
    title: 'settings.installModuleNotWritableTitle',
    status: 'settings.installModuleNotWritableText',
    hint: 'settings.installModuleNotWritableHint',
  },
  web_install_off: {
    title: 'settings.installModuleWebInstallOffTitle',
    status: 'settings.installModuleWebInstallOffText',
    hint: 'settings.installModuleWebInstallOffHint',
  },
  not_persistent: {
    title: 'settings.installModuleNotWritableTitle',
    status: 'settings.installModuleNotPersistentText',
    hint: 'settings.installModuleNotPersistentHint',
  },
});

/** Der Weg von Hand: Ueberschrift, Grund, Hinweis und der Link auf MODULES.md. */
function manualWayElement(status) {
  const keys = STATUS_KEYS[status];
  const link = document.createElement('a');
  link.className = 'btn btn--secondary';
  link.href = MODULES_GUIDE_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = t('settings.installModuleManualLink');
  return createStatusSummary({
    title: t(keys.title),
    status: t(keys.status),
    details: [t(keys.hint)],
    tone: 'warning',
    level: 2,
    action: link,
  });
}

/** Die Bausteine einer Karte; `busy` sperrt sie fuer die Dauer einer Anfrage. */
function cardState(body) {
  return {
    body,
    form: body.querySelector('[data-install-form]'),
    button: body.querySelector('[data-install-button]'),
    errorEl: body.querySelector('[data-install-error]'),
    candidatesEl: body.querySelector('[data-install-candidates]'),
    resultEl: body.querySelector('[data-install-result]'),
    busy: false,
  };
}

function showError(card, message) {
  card.errorEl.textContent = message || t('settings.installModuleErrorGeneric');
  card.errorEl.hidden = false;
}

function clearError(card) {
  card.errorEl.textContent = '';
  card.errorEl.hidden = true;
}

function clearCandidates(card) {
  card.candidatesEl.replaceChildren();
  card.candidatesEl.hidden = true;
}

/**
 * Waehrend der Anfrage wird der Knopf NICHT `disabled` - dasselbe wie beim
 * Einspielen eines Backups (admin-backup.js): ein deaktivierter Knopf nimmt
 * den Fokus nicht an, den die Ersetzen-Rueckfrage ihm beim Schliessen
 * zurueckgibt. Die Sperre haelt `busy`, `aria-disabled` sagt sie an.
 */
function setBusy(card, busy, button = card.button) {
  card.busy = busy;
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.textContent;
    button.setAttribute('aria-disabled', 'true');
    button.textContent = t('settings.installModuleInstalling');
  } else {
    button.removeAttribute('aria-disabled');
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
  }
}

/**
 * Der Satz unter "installiert": das Modul ist aus. Neu installiert ODER
 * ersetzt - jedes Ersetzen nimmt die Freigabe zurueck (module-install.js
 * schreibt `approved: false` in den Installationsdatensatz, Review zu PR
 * #1671), und das muss hier stehen, sonst sucht der Admin, warum sein Modul
 * ploetzlich fehlt.
 */
export function successStatus(response) {
  return response?.replaced
    ? t('settings.installModuleSuccessReplaced')
    : t('settings.installModuleSuccessDisabled');
}

/**
 * Frage und Detail fuer 409 `exists`. Das Detail sagt vorher, was der Server
 * nachher tut: ein Ersetzen schaltet das Modul aus, bis der Admin es wieder
 * freigibt - es darf nicht wie ein harmloses Update klingen.
 * @returns {{ question: string, detail: string }}
 */
export function replaceConfirmText(data = {}) {
  const existing = data.existing ?? {};
  return {
    question: t('settings.installModuleReplaceConfirm', {
      name: existing.name || existing.id || '',
      from: existing.version || t('settings.installModuleVersionUnknown'),
      to: data.incoming?.version || t('settings.installModuleVersionNew'),
    }),
    detail: t('settings.installModuleReplaceDetail'),
  };
}

/** Optionen fuer den zweiten Versuch mit dem gewaehlten Kandidaten; '' ist die Wurzel. */
export function candidateInstallOptions(options, candidate) {
  return { ...options, path: String(candidate?.path ?? '') };
}

function successElement(response) {
  const module = response?.data ?? {};
  const name = moduleDisplayLabel(module) || module.id || '';
  const open = document.createElement('a');
  open.className = 'btn btn--secondary';
  open.href = ACTIVE_MODULES_PATH;
  open.dataset.installOpenActive = '';
  open.textContent = t('settings.installModuleOpenActive');
  open.addEventListener('click', (event) => {
    if (!window.yuvomi?.navigate) return;
    event.preventDefault();
    window.yuvomi.navigate(ACTIVE_MODULES_PATH);
  });

  const wrap = document.createElement('div');
  wrap.appendChild(createStatusSummary({
    title: t('settings.installModuleSuccess', { module: moduleWithVersion(name, module.version) }),
    status: successStatus(response),
    tone: 'success',
    action: open,
  }));

  const skipped = Array.isArray(response?.skipped) ? response.skipped.filter((entry) => typeof entry === 'string') : [];
  if (skipped.length) {
    const content = document.createElement('div');
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent = t('settings.installModuleSkippedHint');
    const list = document.createElement('ul');
    list.className = 'settings-module-install__skipped';
    for (const path of skipped) {
      const item = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = path;
      item.appendChild(code);
      list.appendChild(item);
    }
    content.append(hint, list);
    wrap.appendChild(createDisclosure({
      id: `module-install-skipped-${Date.now()}`,
      summary: t('settings.installModuleSkippedTitle'),
      content,
    }));
  }
  return wrap;
}

/**
 * Mehrere `module.json` im Archiv: zur Wahl stellen, mit Name, Kennung,
 * Version und Ordner - zwei Beispielmodule eines Repos heissen oft gleich.
 * Ausserhalb des Formulars, damit die Wahl keinen offenen Stand fuer den
 * Verlassen-Schutz hinterlaesst.
 */
function showCandidates(card, source, options, candidates) {
  const group = `module-install-candidate-${card.body.dataset.installCard}`;
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'settings-module-candidates';
  fieldset.insertAdjacentHTML('beforeend', `
    <legend class="form-label">${esc(t('settings.installModuleCandidatesTitle'))}</legend>
    <p class="form-hint">${esc(t('settings.installModuleCandidatesHint'))}</p>
    <div class="settings-module-candidates__list">
      ${candidates.map((candidate, index) => `
        <label class="settings-module-candidate">
          <input type="radio" name="${group}" value="${index}" />
          <span class="settings-module-candidate__text">
            <strong>${esc(candidate.name || candidate.id || candidate.path || '')}</strong>
            <span class="form-hint">${esc(t('settings.installModuleCandidateMeta', {
    id: candidate.id || '',
    version: candidate.version || t('settings.installModuleVersionUnknown'),
    path: candidate.path || '/',
  }))}</span>
          </span>
        </label>`).join('')}
    </div>
    <div class="form-error" role="alert" data-candidate-error hidden></div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--primary" data-install-selected>${esc(t('settings.installModuleSelectedButton'))}</button>
    </div>
  `);
  card.candidatesEl.replaceChildren(fieldset);
  card.candidatesEl.hidden = false;

  const errorEl = fieldset.querySelector('[data-candidate-error]');
  const button = fieldset.querySelector('[data-install-selected]');
  fieldset.addEventListener('change', () => { errorEl.hidden = true; });
  button.addEventListener('click', () => {
    if (card.busy) return;
    const chosen = fieldset.querySelector(`input[name="${group}"]:checked`);
    if (!chosen) {
      errorEl.textContent = t('settings.installModuleCandidateRequired');
      errorEl.hidden = false;
      fieldset.querySelector('input[type="radio"]')?.focus();
      return;
    }
    runInstall(card, source, candidateInstallOptions(options, candidates[Number(chosen.value)]), button);
  });
  // Die Wahl ist jetzt der naechste Schritt: der Fokus geht zur ersten Option.
  fieldset.querySelector('input[type="radio"]')?.focus();
}

/**
 * Der eine Ablauf beider Karten. `button` ist der Knopf, der ihn ausgeloest
 * hat (Installieren oder "Ausgewaehltes installieren").
 */
async function runInstall(card, source, options = {}, button = card.button) {
  if (card.busy) return;
  clearError(card);
  card.resultEl.replaceChildren();
  setBusy(card, true, button);
  let response;
  try {
    response = await sendInstall(source, options);
  } catch (error) {
    setBusy(card, false, button);
    const reason = error?.data?.reason;
    if (error?.status === 409 && reason === 'exists' && error.data?.existing && !options.overwrite) {
      const { question, detail } = replaceConfirmText(error.data);
      const ok = await confirmModal(question, {
        confirmLabel: t('settings.installModuleReplaceButton'),
        detail,
      });
      if (ok) await runInstall(card, source, { ...options, overwrite: true }, button);
      return;
    }
    if (error?.status === 422 && reason === 'multiple' && Array.isArray(error.data?.candidates) && error.data.candidates.length) {
      showCandidates(card, source, options, error.data.candidates);
      return;
    }
    if (button !== card.button && button?.isConnected) {
      const candidateError = card.candidatesEl.querySelector('[data-candidate-error]');
      if (candidateError) {
        candidateError.textContent = installErrorText(error);
        candidateError.hidden = false;
        return;
      }
    }
    showError(card, installErrorText(error));
    return;
  }

  setBusy(card, false, button);
  clearCandidates(card);
  // Formular leeren: ein installiertes Modul ist kein offener Stand, und der
  // Verlassen-Schutz (dirty-guard.js) gibt das Formular am `reset` frei.
  card.form.reset();
  card.onReset?.();
  card.resultEl.replaceChildren(successElement(response));
  window.lucide?.createIcons({ el: card.resultEl });
  // "Ausgewaehltes installieren" ist mit der Kandidatenliste verschwunden; ohne
  // Ziel fiele der Fokus auf <body>. Der naechste Schritt ist "Aktive Module
  // oeffnen" (dort wird das Modul eingeschaltet) - also dorthin.
  if (button !== card.button) {
    card.resultEl.querySelector('[data-install-open-active]')?.focus();
  }
  try {
    await window.yuvomi?.refreshThirdPartyModules?.();
  } catch (error) {
    console.warn('[Settings] Module catalog refresh failed:', error);
  }
}

function bindGithubCard(body) {
  const card = cardState(body);
  const input = body.querySelector('#module-install-url');
  // Eine geaenderte Adresse macht die Kandidaten der alten wertlos: sie stammen
  // aus einem anderen Archiv, und "Ausgewaehltes installieren" schickte die
  // NEUE Adresse mit einem Pfad aus der alten.
  input?.addEventListener('input', () => {
    clearError(card);
    clearCandidates(card);
  });
  card.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (card.busy) return;
    const url = input.value.trim();
    if (!url) {
      showError(card, t('settings.installModuleUrlRequired'));
      input.focus();
      return;
    }
    clearCandidates(card);
    runInstall(card, { kind: 'github', url });
  });
}

function bindZipCard(body, maxZipMb) {
  const card = cardState(body);
  const fileInput = body.querySelector('#module-install-file');
  const selected = body.querySelector('[data-install-file]');
  const dropzone = body.querySelector('#module-install-dropzone');

  function setFile(file) {
    clearError(card);
    clearCandidates(card);
    if (!file) {
      selected.hidden = true;
      selected.textContent = '';
      card.button.disabled = true;
      return;
    }
    selected.textContent = `${file.name} · ${formatSize(file.size)}`;
    selected.hidden = false;
    const problem = zipFileProblem(file, maxZipMb);
    card.button.disabled = Boolean(problem);
    if (problem) showError(card, problem);
  }
  card.onReset = () => setFile(null);

  fileInput.addEventListener('change', () => setFile(fileInput.files?.[0]));
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
    setFile(file);
  });

  card.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (card.busy) return;
    const file = fileInput.files?.[0];
    if (!file) return;
    const problem = zipFileProblem(file, maxZipMb);
    if (problem) {
      showError(card, problem);
      return;
    }
    clearCandidates(card);
    runInstall(card, { kind: 'zip', file });
  });
}

export async function render(container) {
  container.replaceChildren();

  let info;
  try {
    info = (await api.get('/modules/install/info'))?.data ?? {};
  } catch (error) {
    container.appendChild(createRetryState({
      message: error?.message || t('settings.loadError'),
      onRetry: () => render(container),
    }));
    return;
  }

  // Schreibgeschuetzt, Schalter aus oder nicht dauerhaft: keine Knoepfe, die
  // nur scheitern koennen oder deren Ergebnis das naechste Update loescht -
  // stattdessen der Weg von Hand (installPageStatus).
  const status = installPageStatus(info);
  if (status) {
    container.appendChild(manualWayElement(status));
    return;
  }

  const maxZipMb = Number(info.maxZipMb) > 0 ? Number(info.maxZipMb) : DEFAULT_MAX_ZIP_MB;
  container.insertAdjacentHTML('beforeend', pageHtml(maxZipMb));
  container.querySelector('#module-install-notice')?.replaceWith(noticeElement());
  bindGithubCard(container.querySelector('[data-install-card="github"]'));
  bindZipCard(container.querySelector('[data-install-card="zip"]'), maxZipMb);
  window.lucide?.createIcons({ el: container });
}
