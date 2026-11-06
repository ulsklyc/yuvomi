import { api } from '/api.js';
import { t } from '/i18n.js';
import { dateTimeText } from '/utils/date-format.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { rowActionHtml } from '/utils/row-action.js';
import { confirmModal, refocusAfterRender, reportFieldErrors, constraintErrors } from '/components/modal.js';
import { createRetryState, hintFoldHtml, settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';
import { getExtensionModules } from '/utils/extension-widgets.js';
import { moduleDisplayLabel } from '/utils/extension-i18n.js';

// Core scope keys — extension modules are appended from /permissions/catalog at render time.
const CORE_SCOPE_MODULE_KEYS = [
  'tasks', 'shopping', 'meals', 'pantry', 'inventory', 'calendar', 'schedule', 'notes', 'contacts', 'budget',
  'documents', 'health', 'rewards', 'housekeeping', 'waste', 'weather', 'family',
  'dashboard', 'search',
];

function formatTokenTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateTimeText(date);
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

/**
 * SICHERE VORGABE STATT LEERFELD (Greenlit-Kritik, 25.10.2026): ein neues Token
 * lief ohne Eingabe nie ab und durfte alles. Die Gueltigkeit ist jetzt eine
 * Auswahl mit 90 Tagen vorn, "Kein Ablauf" bleibt waehlbar, aber als bewusste
 * Wahl. Die API selbst bleibt unveraendert (`expires_at` optional, /api/v1 ist
 * zugesagt) - der Schutz sitzt dort, wo Menschen Tokens anlegen.
 */
export const TOKEN_VALIDITY_DAYS = { 30: 30, 90: 90, 365: 365 };
export const TOKEN_VALIDITY_DEFAULT = '90';

/**
 * ISO-Zeitpunkt fuer eine Vorgabe in Tagen, gerechnet ab `now` in KALENDERTAGEN:
 * "1 Jahr" endet zur selben Uhrzeit, auch wenn dazwischen eine Zeitumstellung
 * liegt (365 x 24 h landete eine Stunde daneben).
 */
export function validityExpiresAt(choice, now = Date.now()) {
  const days = TOKEN_VALIDITY_DAYS[choice];
  if (!days) return null;
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function datetimeLocalToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Was das Formular als `expires_at` schickt. Nur "Kein Ablauf" ergibt `null`;
 * ein eigenes Datum ohne gueltigen Wert ist ein Fehler und NIE stillschweigend
 * "kein Ablauf" - genau so entstand frueher das unbefristete Token.
 */
export function resolveTokenExpiry(choice, customValue, now = Date.now()) {
  if (choice === 'never') return { expires_at: null };
  if (choice === 'custom') {
    const iso = datetimeLocalToIso(customValue);
    return iso ? { expires_at: iso } : { error: 'settings.apiTokenInvalidExpiration' };
  }
  const iso = validityExpiresAt(choice, now);
  return iso ? { expires_at: iso } : { error: 'settings.apiTokenInvalidExpiration' };
}

/**
 * Gilt dieses Token noch? DAS SAGT DER SERVER (`active`), nicht die Uhr dieses
 * Geraets: geht sie vor, hielte die Seite ein Token fuer abgelaufen, das noch
 * anmeldet, boete nur "Entfernen" an, bekaeme dafuer 409 - und "Widerrufen"
 * stuende nirgends (Codex zu #1681). Die eigene Rechnung bleibt nur fuer eine
 * Antwort ohne das Feld und fuer den Widerruf, den diese Seite selbst gerade
 * eingetragen hat (`revoked_at` schlaegt alles).
 */
export function isApiTokenActive(token, now = Date.now()) {
  if (token.revoked_at) return false;
  if (typeof token.active === 'boolean') return token.active;
  if (!token.expires_at) return true;
  const expires = new Date(token.expires_at).getTime();
  return Number.isNaN(expires) || expires > now;
}

function apiTokenHtml(token, active) {
  const status = token.revoked_at
    ? t('settings.apiTokenRevoked')
    : active ? t('settings.apiTokenActive') : t('settings.apiTokenExpired');
  const scopeSummary = Array.isArray(token.scopes)
    ? t('settings.apiTokenScopeSummary', { count: token.scopes.length })
    : t('settings.apiTokenScopeFull');
  const meta = [
    token.subject_name,
    `${t('settings.apiTokenPrefix')}: ${token.token_prefix}...`,
    scopeSummary,
    token.expires_at
      ? `${t('settings.apiTokenExpires')}: ${formatTokenTime(token.expires_at)}`
      : t('settings.apiTokenNeverExpires'),
    token.last_used_at
      ? `${t('settings.apiTokenLastUsed')}: ${formatTokenTime(token.last_used_at)}`
      : t('settings.apiTokenNeverUsed'),
    status,
  ].join(' · ');

  // EIN KNOPF JE ZEILE, UND WELCHER, SAGT DER ZUSTAND (D#1672). Ein aktives
  // Token wird widerrufen - das beendet den Zugang und laesst den Zeitpunkt
  // stehen. Erst was nicht mehr gilt, laesst sich entfernen. Vorher trug die
  // tote Zeile einen gesperrten Widerruf-Knopf und blieb fuer immer.
  const action = active
    ? `<button class="btn btn--icon btn--danger-outline" data-revoke-api-token="${token.id}" data-name="${esc(token.name)}" aria-label="${esc(t('settings.apiTokenRevoke'))}">
        <i data-lucide="ban" aria-hidden="true"></i>
      </button>`
    : rowActionHtml({
      icon: 'trash-2',
      tone: 'danger',
      label: t('common.removeNamed', { name: token.name }),
      attrs: { 'data-remove-api-token': token.id, 'data-name': token.name },
    });

  return `
    <li class="settings-member" data-api-token-id="${token.id}">
      <div class="settings-member__info">
        <span class="settings-member__name">${esc(token.name)}</span>
        <span class="settings-member__meta">${esc(meta)}</span>
      </div>
      ${action}
    </li>
  `;
}

function fillTokenList(list, tokens, active) {
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', tokens.map((token) => apiTokenHtml(token, active)).join(''));
}

/**
 * Zwei Listen: was gilt, und was nicht mehr gilt. Der zweite Abschnitt steht
 * nur da, wenn er etwas zeigt - eine Ueberschrift ueber nichts waere eine
 * Frage ohne Gegenstand.
 */
export function renderApiTokenList(container, tokens) {
  const list = container.querySelector('#api-token-list');
  if (!list) return;
  const now = Date.now();
  const active = tokens.filter((token) => isApiTokenActive(token, now));
  const inactive = tokens.filter((token) => !isApiTokenActive(token, now));

  fillTokenList(list, active, true);
  if (!active.length) {
    const empty = document.createElement('li');
    empty.className = 'form-hint';
    empty.textContent = t(tokens.length ? 'settings.apiTokensNoneActive' : 'settings.apiTokensEmpty');
    list.appendChild(empty);
  }

  const inactiveSection = container.querySelector('#api-token-inactive-section');
  const inactiveList = container.querySelector('#api-token-inactive-list');
  if (inactiveSection && inactiveList) {
    fillTokenList(inactiveList, inactive, false);
    inactiveSection.hidden = inactive.length === 0;
    window.lucide?.createIcons({ el: inactiveList });
  }
  window.lucide?.createIcons({ el: list });
}

function scopeModuleLabel(key) {
  if (String(key).startsWith('ext:')) {
    const moduleId = key.slice(4);
    const mod = getExtensionModules().find((m) => m.id === moduleId);
    if (mod) return moduleDisplayLabel(mod);
  }
  const i18nKey = `settings.apiTokenScopeModules.${key}`;
  const label = t(i18nKey);
  return label === i18nKey ? key : label;
}

/**
 * JE MODUL EINE OPTIONSZEILE (R24, E11; Critique G6-Einst-P3-1). Hier stand eine
 * graue Tabelle mit 30 nativen 13px-Kaestchen (Lesen | Schreiben), Treffer ueber
 * die Zelle - der Formular-Dialekt mitten in einem Einstellungsblatt. Jetzt
 * dieselbe Zeile wie Name, Person und Gueltigkeit darueber: Modul links, die
 * Stufe als Auswahl rechts ("Kein Zugriff ⌄"), wie die Rechte-Matrix. Schreiben
 * schliesst Lesen ein - die Stufe sagt es, statt ein zweites Kaestchen zu
 * sperren.
 */
export const SCOPE_LEVELS = ['none', 'read', 'write'];

function renderScopeRows(scopeKeys) {
  const options = [
    ['none', t('settings.permAccessNone')],
    ['read', t('settings.apiTokenScopeRead')],
    ['write', t('settings.apiTokenScopeWrite')],
  ].map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');
  return scopeKeys.map((key) => settingRowHtml({
    label: scopeModuleLabel(key),
    labelFor: `api-token-scope-${key.replace(/[^a-z0-9_-]/gi, '-')}`,
    control: `<select class="form-input" id="api-token-scope-${esc(key.replace(/[^a-z0-9_-]/gi, '-'))}" data-scope-module="${esc(key)}">${options}</select>`,
  })).join('');
}

/** Die gewaehlten Stufen als Scopes der API: Schreiben schliesst Lesen ein. */
export function scopesFromLevels(entries) {
  return entries.flatMap(([key, level]) => {
    if (level === 'write') return [`${key}:read`, `${key}:write`];
    if (level === 'read') return [`${key}:read`];
    return [];
  });
}

function renderPage(container, scopeKeys = CORE_SCOPE_MODULE_KEYS) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.apiTokensTitle')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.apiTokensCardTitle')}</h3>
        ${hintFoldHtml({
          lead: t('settings.apiTokensHint'),
          moreHtml: `<p class="form-hint">${esc(t('settings.apiTokensMcpHint'))}</p>`,
        })}
        <ul class="settings-members row-divided" id="api-token-list"></ul>
        <form id="api-token-form" class="settings-form" autocomplete="off" novalidate>
          ${/* EIN FORMULAR-DIALEKT (R19, Einstellungen B7): Name, Person,
               Ablauf und die Rechte-Grenze als Zeilen der Gruppe; die
               Rechtetabelle erscheint darunter, sobald die Grenze gilt. */ ''}
          <div class="row-carrier settings-group">
            ${settingRowHtml({
              label: t('settings.apiTokenNameLabel'), labelFor: 'api-token-name', labelExtra: REQUIRED_MARK,
              control: '<input class="form-input" type="text" id="api-token-name" maxlength="100" required />',
            })}
            ${settingRowHtml({
              label: t('settings.apiTokenSubjectLabel'), labelFor: 'api-token-subject', labelExtra: REQUIRED_MARK,
              control: '<select class="form-input" id="api-token-subject" required></select>',
            })}
            ${settingRowHtml({
              label: t('settings.apiTokenValidityLabel'), labelFor: 'api-token-validity',
              description: t('settings.apiTokenValidityUntil', { date: formatTokenTime(validityExpiresAt(TOKEN_VALIDITY_DEFAULT)) }),
              descriptionId: 'api-token-validity-hint',
              control: `<select class="form-input" id="api-token-validity" aria-describedby="api-token-validity-hint">
                <option value="30">${t('settings.apiTokenValidity30')}</option>
                <option value="90" selected>${t('settings.apiTokenValidity90')}</option>
                <option value="365">${t('settings.apiTokenValidity365')}</option>
                <option value="custom">${t('settings.apiTokenValidityCustom')}</option>
                <option value="never">${t('settings.apiTokenValidityNever')}</option>
              </select>`,
            })}
            ${settingRowHtml({
              label: t('settings.apiTokenExpiresLabel'), labelFor: 'api-token-expires',
              // Datum UND Uhrzeit passen auf dem Telefon nicht neben das Label
              // ("TT.M", "H"); `wide` kennt settingRowHtml nicht, es wirkte nie.
              stacked: true,
              attrs: { id: 'api-token-expires-row', hidden: '' },
              control: '<yuvomi-datepicker type="datetime" id="api-token-expires"></yuvomi-datepicker>',
            })}
            ${settingSwitchRowHtml({
              label: t('settings.apiTokenScopeLimit'),
              description: t('settings.apiTokenScopeHint'),
              descriptionId: 'api-token-scope-hint',
              checked: true,
              attrs: { id: 'api-token-scope-limit' },
            })}
          </div>
          <div id="api-token-scope-grid" class="row-carrier settings-group api-token-scopes" role="group" aria-label="${esc(t('settings.apiTokenScopeModule'))}">
            ${renderScopeRows(scopeKeys)}
          </div>
          <div id="api-token-created" class="settings-token-output" hidden>
            <label class="form-label" for="api-token-created-value">${t('settings.apiTokenCreatedLabel')}</label>
            <div class="settings-token-output__row">
              <input class="form-input" id="api-token-created-value" type="text" readonly />
              <button type="button" class="btn btn--secondary btn--sm" id="api-token-copy">
                <i data-lucide="copy" class="icon-sm" aria-hidden="true"></i>
                ${t('settings.apiTokenCopy')}
              </button>
            </div>
            <p class="form-hint">${t('settings.apiTokenCreatedHint')}</p>
          </div>
          <div id="api-token-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('settings.apiTokenCreate')}</button>
          </div>
        </form>
      </div>
    </section>
    <section class="settings-section" id="api-token-inactive-section" hidden>
      <h2 class="settings-section__title">${t('settings.apiTokensInactiveTitle')}</h2>
      <div class="settings-card">
        <p class="form-hint">${t('settings.apiTokensInactiveHint')}</p>
        <ul class="settings-members row-divided" id="api-token-inactive-list"></ul>
      </div>
    </section>
  `);
}

function bindEvents(container, initialTokens, users, currentUserId) {
  const form = container.querySelector('#api-token-form');
  const list = container.querySelector('#api-token-list');
  if (!form || !list) return;

  let tokens = [...initialTokens];

  const subject = container.querySelector('#api-token-subject');
  for (const member of users) {
    const option = document.createElement('option');
    option.value = String(member.id);
    option.textContent = member.display_name || member.username;
    // defaultSelected, nicht nur selected: form.reset() nach dem Anlegen kehrt zur
    // VORGABE zurueck. Mit `selected` allein sprang "Handelt als" auf die erste
    // Person der Liste, und das naechste Token handelte still als jemand anderes.
    option.selected = option.defaultSelected = Number(member.id) === Number(currentUserId);
    subject.appendChild(option);
  }

  const validity = container.querySelector('#api-token-validity');
  const validityHint = container.querySelector('#api-token-validity-hint');
  const expiresRow = container.querySelector('#api-token-expires-row');
  const expiresPicker = container.querySelector('#api-token-expires');
  // Die Zeile unter der Auswahl sagt, was die Wahl bedeutet: das Ablaufdatum
  // einer Vorgabe, "bis zum Widerruf" ohne Ablauf; beim eigenen Datum steht das
  // Datumsfeld darunter und der Hinweis schweigt.
  const syncValidity = () => {
    const choice = validity.value;
    expiresRow.hidden = choice !== 'custom';
    const until = validityExpiresAt(choice);
    const text = until
      ? t('settings.apiTokenValidityUntil', { date: formatTokenTime(until) })
      : choice === 'never' ? t('settings.apiTokenValidityNeverHint') : '';
    validityHint.textContent = text;
    validityHint.hidden = !text;
  };
  validity.addEventListener('change', syncValidity);
  syncValidity();

  const scopeLimit = container.querySelector('#api-token-scope-limit');
  const scopeGrid = container.querySelector('#api-token-scope-grid');
  if (scopeLimit && scopeGrid) {
    scopeLimit.addEventListener('change', () => {
      scopeGrid.hidden = !scopeLimit.checked;
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des Markups melden sich am Feld (constraintErrors, components/modal.js).
    if (reportFieldErrors(constraintErrors(form))) return;
    const errorEl = container.querySelector('#api-token-error');
    const output = container.querySelector('#api-token-created');
    const outputValue = container.querySelector('#api-token-created-value');
    clearError(errorEl);
    output.hidden = true;

    const name = container.querySelector('#api-token-name').value.trim();
    const expiry = resolveTokenExpiry(validity.value, expiresPicker.value);
    if (expiry.error) {
      showError(errorEl, t(expiry.error));
      return;
    }
    const { expires_at } = expiry;

    // scopes: nur senden, wenn „auf Module beschränken" aktiv ist. Sonst voller Zugriff.
    const payload = { name, expires_at, subject_user_id: Number(subject.value) };
    if (scopeLimit && scopeLimit.checked) {
      const scopes = scopesFromLevels([...scopeGrid.querySelectorAll('select[data-scope-module]')]
        .map((select) => [select.dataset.scopeModule, select.value]));
      if (!scopes.length) {
        showError(errorEl, t('settings.apiTokenScopeRequired'));
        return;
      }
      payload.scopes = scopes;
    }

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const res = await api.post('/auth/api-tokens', payload);
      tokens.unshift(res.data);
      renderApiTokenList(container, tokens);
      form.reset();
      expiresPicker.value = '';
      syncValidity();
      if (scopeGrid) scopeGrid.hidden = !scopeLimit.checked;
      // The raw token is shown exactly once, only from the creation response.
      outputValue.value = res.token;
      output.hidden = false;
      window.lucide?.createIcons({ el: output });
      outputValue.focus();
      outputValue.select();
      window.yuvomi?.showToast(t('settings.apiTokenCreatedToast'), 'success');
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Der riskanteste Moment der Oberfläche hatte die schwächste Behandlung: das
  // Token ist genau einmal sichtbar und stand in einem readonly Input, aus dem
  // es von Hand markiert werden musste (Critique 2026-07-27).
  container.querySelector('#api-token-copy')?.addEventListener('click', async () => {
    const value = container.querySelector('#api-token-created-value')?.value;
    if (!value) return;
    try {
      await navigator.clipboard?.writeText(value);
      window.yuvomi?.showToast(t('settings.apiTokenCopied'), 'success');
    } catch (err) {
      window.yuvomi?.showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });

  list.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-revoke-api-token]');
    if (!btn) return;
    const id = Number(btn.dataset.revokeApiToken);
    const name = btn.dataset.name;
    if (!await confirmModal(t('settings.apiTokenRevokeConfirm', { name }), {
      danger: true,
      confirmLabel: t('settings.apiTokenRevoke'),
      detail: t('settings.apiTokenRevokeDetail'),
    })) return;
    try {
      await api.delete(`/auth/api-tokens/${id}`);
      tokens = tokens.map((token) => (
        token.id === id ? { ...token, revoked_at: new Date().toISOString() } : token
      ));
      renderApiTokenList(container, tokens);
      refocusAfterRender();
      window.yuvomi?.showToast(t('settings.apiTokenRevokedToast'), 'default');
    } catch (err) {
      window.yuvomi?.showToast(err.message, 'danger');
    }
  });

  // ENTFERNEN HAT KEIN RUECKGAENGIG: die Zeile samt Token-Hash ist danach weg,
  // es gibt nichts, was sich zurueckholen liesse. Deshalb die Rueckfrage vorab
  // statt eines Toasts mit Undo, und sie nennt die Folge.
  const inactiveList = container.querySelector('#api-token-inactive-list');
  inactiveList?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-remove-api-token]');
    if (!btn) return;
    const id = Number(btn.dataset.removeApiToken);
    const name = btn.dataset.name;
    if (!await confirmModal(t('settings.apiTokenRemoveConfirm', { name }), {
      danger: true,
      confirmLabel: t('settings.apiTokenRemove'),
      detail: t('settings.apiTokenRemoveDetail'),
    })) return;
    try {
      await api.post(`/auth/api-tokens/${id}/remove`, {});
    } catch (err) {
      // 404: jemand war schneller, die Zeile ist schon weg - das Ziel ist erreicht.
      if (err?.status !== 404) {
        // Der Server haelt das Token noch fuer aktiv (die Uhr dieses Geraets
        // geht vor, oder die Liste ist alt): sein Satz statt des englischen,
        // und die Liste neu vom Server, damit die Zeile wieder richtig steht.
        const active = err?.status === 409 && err.data?.reason === 'api_token_active';
        window.yuvomi?.showToast(active ? t('settings.apiTokenRemoveActive') : err.message, 'danger');
        if (active) {
          try {
            tokens = (await api.get('/auth/api-tokens')).data ?? tokens;
            renderApiTokenList(container, tokens);
            refocusAfterRender();
          } catch (reloadErr) {
            window.yuvomi?.showToast(reloadErr.message, 'danger');
          }
        }
        return;
      }
    }
    tokens = tokens.filter((token) => token.id !== id);
    renderApiTokenList(container, tokens);
    refocusAfterRender();
    window.yuvomi?.showToast(t('settings.apiTokenRemovedToast'), 'default');
  });
}

async function loadTokens(container, currentUserId) {
  const list = container.querySelector('#api-token-list');
  if (!list) return;

  const reload = () => loadTokens(container, currentUserId);

  let tokens;
  let users;
  try {
    const tokenResponse = await api.get('/auth/api-tokens');
    tokens = tokenResponse.data ?? [];
    users = tokenResponse.subjects ?? [];
  } catch (err) {
    list.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    return;
  }

  renderApiTokenList(container, tokens);
  bindEvents(container, tokens, users, currentUserId);
  window.lucide?.createIcons({ el: container });
}

export async function render(container, { user } = {}) {
  let scopeKeys = [...CORE_SCOPE_MODULE_KEYS];
  try {
    const catalog = await api.get('/permissions/catalog');
    if (Array.isArray(catalog.data?.scopeModuleKeys)) scopeKeys = catalog.data.scopeModuleKeys;
  } catch { /* core keys only */ }
  renderPage(container, scopeKeys);
  await loadTokens(container, user?.id);
  window.lucide?.createIcons({ el: container });
}

export const __test = { renderPage };
