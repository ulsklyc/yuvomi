import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { rowActionHtml } from '/utils/row-action.js';
import { confirmModal, refocusAfterRender } from '/components/modal.js';
import { createRetryState, toggleRowHtml } from '/settings/components.js';
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
  return `${formatDate(date)} ${formatTime(date)}`.trim();
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

function datetimeLocalToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function renderScopeRows(scopeKeys) {
  return scopeKeys.map((key) => `
    <div class="api-token-scopes__row">
      <span class="api-token-scopes__name">${esc(scopeModuleLabel(key))}</span>
      <label class="api-token-scopes__cell"><input type="checkbox" data-scope="${key}:read" aria-label="${esc(scopeModuleLabel(key))} ${t('settings.apiTokenScopeRead')}" /></label>
      <label class="api-token-scopes__cell"><input type="checkbox" data-scope="${key}:write" aria-label="${esc(scopeModuleLabel(key))} ${t('settings.apiTokenScopeWrite')}" /></label>
    </div>
  `).join('');
}

function renderPage(container, scopeKeys = CORE_SCOPE_MODULE_KEYS) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.apiTokensTitle')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.apiTokensCardTitle')}</h3>
        <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.apiTokensHint')}</p>
        <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.apiTokensMcpHint')}</p>
        <ul class="settings-members row-divided" id="api-token-list"></ul>
        <form id="api-token-form" class="settings-form" autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="api-token-name">${t('settings.apiTokenNameLabel')}</label>
            <input class="form-input" type="text" id="api-token-name" maxlength="100" required />
          </div>
          <div class="form-group">
            <label class="form-label" for="api-token-subject">${t('settings.apiTokenSubjectLabel')}</label>
            <select class="form-input" id="api-token-subject" required></select>
          </div>
          <div class="form-group">
            <label class="form-label" for="api-token-expires">${t('settings.apiTokenExpiresLabel')}</label>
            <yuvomi-datepicker type="datetime" id="api-token-expires"></yuvomi-datepicker>
            <p class="form-hint">${t('settings.apiTokenExpiresHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label">${t('settings.apiTokenScopes')}</label>
            <p class="form-hint" style="margin-bottom:var(--space-2)">${t('settings.apiTokenScopeHint')}</p>
            ${toggleRowHtml({
              control: 'switch',
              label: t('settings.apiTokenScopeLimit'),
              attrs: { id: 'api-token-scope-limit' },
            })}
            <div id="api-token-scope-grid" class="api-token-scopes" hidden>
              <div class="api-token-scopes__head">
                <span>${t('settings.apiTokenScopeModule')}</span>
                <span>${t('settings.apiTokenScopeRead')}</span>
                <span>${t('settings.apiTokenScopeWrite')}</span>
              </div>
              ${renderScopeRows(scopeKeys)}
            </div>
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
          <button type="submit" class="btn btn--primary">${t('settings.apiTokenCreate')}</button>
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
    option.selected = Number(member.id) === Number(currentUserId);
    subject.appendChild(option);
  }

  const scopeLimit = container.querySelector('#api-token-scope-limit');
  const scopeGrid = container.querySelector('#api-token-scope-grid');
  if (scopeLimit && scopeGrid) {
    scopeLimit.addEventListener('change', () => {
      scopeGrid.hidden = !scopeLimit.checked;
    });
    // Schreibrecht schließt Leserecht ein: read spiegeln + sperren, solange write aktiv ist.
    scopeGrid.addEventListener('change', (event) => {
      const box = event.target;
      if (!box.dataset.scope || !box.dataset.scope.endsWith(':write')) return;
      const readBox = scopeGrid.querySelector(`[data-scope="${box.dataset.scope.replace(':write', ':read')}"]`);
      if (!readBox) return;
      if (box.checked) { readBox.checked = true; readBox.disabled = true; } else { readBox.disabled = false; }
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = container.querySelector('#api-token-error');
    const output = container.querySelector('#api-token-created');
    const outputValue = container.querySelector('#api-token-created-value');
    clearError(errorEl);
    output.hidden = true;

    const name = container.querySelector('#api-token-name').value.trim();
    const expiresValue = container.querySelector('#api-token-expires').value;
    const expires_at = datetimeLocalToIso(expiresValue);
    if (expiresValue && !expires_at) {
      showError(errorEl, t('settings.apiTokenInvalidExpiration'));
      return;
    }

    // scopes: nur senden, wenn „auf Module beschränken" aktiv ist. Sonst voller Zugriff.
    const payload = { name, expires_at, subject_user_id: Number(subject.value) };
    if (scopeLimit && scopeLimit.checked) {
      const scopes = [...scopeGrid.querySelectorAll('input[data-scope]:checked')]
        .map((box) => box.dataset.scope);
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
      if (scopeGrid) {
        scopeGrid.hidden = true;
        scopeGrid.querySelectorAll('input[data-scope]').forEach((box) => { box.disabled = false; });
      }
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
