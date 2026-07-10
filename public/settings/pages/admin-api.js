import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal } from '/components/modal.js';
import { createRetryState } from '/settings/components.js';

// Muss mit MODULE_KEYS in server/scopes.js übereinstimmen (gleiche Reihenfolge).
const SCOPE_MODULE_KEYS = [
  'tasks', 'shopping', 'meals', 'calendar', 'notes', 'contacts', 'budget',
  'documents', 'health', 'rewards', 'housekeeping', 'weather', 'family',
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

function apiTokenHtml(token) {
  const status = token.revoked_at
    ? t('settings.apiTokenRevoked')
    : token.expires_at && new Date(token.expires_at).getTime() <= Date.now()
      ? t('settings.apiTokenExpired')
      : t('settings.apiTokenActive');
  const scopeSummary = Array.isArray(token.scopes)
    ? t('settings.apiTokenScopeSummary', { count: token.scopes.length })
    : t('settings.apiTokenScopeFull');
  const meta = [
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
  if (!tokens.length) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.apiTokensEmpty');
    list.appendChild(empty);
  } else {
    tokens.forEach((token) => {
      const tmp = document.createElement('div');
      tmp.insertAdjacentHTML('beforeend', apiTokenHtml(token));
      list.appendChild(tmp.firstElementChild);
    });
  }
  window.lucide?.createIcons({ el: list });
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.apiTokensTitle')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.apiTokensCardTitle')}</h3>
        <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.apiTokensHint')}</p>
        <p class="form-hint" style="margin-bottom:var(--space-3)">${t('settings.apiTokensMcpHint')}</p>
        <ul class="settings-members" id="api-token-list"></ul>
        <form id="api-token-form" class="settings-form" autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="api-token-name">${t('settings.apiTokenNameLabel')}</label>
            <input class="form-input" type="text" id="api-token-name" maxlength="100" required />
          </div>
          <div class="form-group">
            <label class="form-label" for="api-token-expires">${t('settings.apiTokenExpiresLabel')}</label>
            <yuvomi-datepicker type="datetime" id="api-token-expires"></yuvomi-datepicker>
            <p class="form-hint">${t('settings.apiTokenExpiresHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label">${t('settings.apiTokenScopes')}</label>
            <p class="form-hint" style="margin-bottom:var(--space-2)">${t('settings.apiTokenScopeHint')}</p>
            <label class="settings-toggle">
              <input type="checkbox" id="api-token-scope-limit" />
              <span>${t('settings.apiTokenScopeLimit')}</span>
            </label>
            <div id="api-token-scope-grid" class="api-token-scopes" hidden>
              <div class="api-token-scopes__head">
                <span>${t('settings.apiTokenScopeModule')}</span>
                <span>${t('settings.apiTokenScopeRead')}</span>
                <span>${t('settings.apiTokenScopeWrite')}</span>
              </div>
              ${SCOPE_MODULE_KEYS.map((key) => `
                <div class="api-token-scopes__row">
                  <span class="api-token-scopes__name">${t(`settings.apiTokenScopeModules.${key}`)}</span>
                  <label class="api-token-scopes__cell"><input type="checkbox" data-scope="${key}:read" aria-label="${t(`settings.apiTokenScopeModules.${key}`)} ${t('settings.apiTokenScopeRead')}" /></label>
                  <label class="api-token-scopes__cell"><input type="checkbox" data-scope="${key}:write" aria-label="${t(`settings.apiTokenScopeModules.${key}`)} ${t('settings.apiTokenScopeWrite')}" /></label>
                </div>
              `).join('')}
            </div>
          </div>
          <div id="api-token-created" class="settings-token-output" hidden>
            <label class="form-label" for="api-token-created-value">${t('settings.apiTokenCreatedLabel')}</label>
            <input class="form-input" id="api-token-created-value" type="text" readonly />
            <p class="form-hint">${t('settings.apiTokenCreatedHint')}</p>
          </div>
          <div id="api-token-error" class="form-error" role="alert" hidden></div>
          <button type="submit" class="btn btn--primary">${t('settings.apiTokenCreate')}</button>
        </form>
      </div>
    </section>
  `);
}

function bindEvents(container, initialTokens) {
  const form = container.querySelector('#api-token-form');
  const list = container.querySelector('#api-token-list');
  if (!form || !list) return;

  let tokens = [...initialTokens];

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
    const payload = { name, expires_at };
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
      outputValue.focus();
      outputValue.select();
      window.yuvomi?.showToast(t('settings.apiTokenCreatedToast'), 'success');
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      btn.disabled = false;
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
    })) return;
    try {
      await api.delete(`/auth/api-tokens/${id}`);
      tokens = tokens.map((token) => (
        token.id === id ? { ...token, revoked_at: new Date().toISOString() } : token
      ));
      renderApiTokenList(container, tokens);
      window.yuvomi?.showToast(t('settings.apiTokenRevokedToast'), 'default');
    } catch (err) {
      window.yuvomi?.showToast(err.message, 'danger');
    }
  });
}

async function loadTokens(container) {
  const list = container.querySelector('#api-token-list');
  if (!list) return;

  const reload = () => loadTokens(container);

  let tokens;
  try {
    const res = await api.get('/auth/api-tokens');
    tokens = res.data ?? [];
  } catch (err) {
    list.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    return;
  }

  renderApiTokenList(container, tokens);
  bindEvents(container, tokens);
  window.lucide?.createIcons({ el: container });
}

export async function render(container, { user } = {}) {
  renderPage(container);
  await loadTokens(container);
  window.lucide?.createIcons({ el: container });
}
