import { recipeProviders } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { closeModal, confirmModal, openModal } from '/components/modal.js';
import {
  createInlineError,
  createRetryState,
  createStatusSummary,
  toggleRowHtml,
} from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { esc } from '/utils/html.js';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

// Anzeigename je Provider - Eigenname, keine i18n-Übersetzung (wie
// recipes.sourceMealie/sourceTandoor in jeder Locale unübersetzt bleiben).
function providerLabel(provider) {
  return provider === 'tandoor' ? 'Tandoor' : 'Mealie';
}

function showToast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

function lastSyncDetail(value) {
  const formatted = formatSyncTime(value);
  return formatted ? t('settings.lastSyncValue', { value: formatted }) : t('settings.neverSynced');
}

export async function persistMealTypeSelection(
  inputs,
  checkedMealTypes,
  persistedMealTypes,
  save,
) {
  inputs.forEach((input) => {
    input.disabled = true;
  });

  try {
    await save();
  } catch (error) {
    inputs.forEach((input) => {
      input.checked = persistedMealTypes.includes(input.value);
    });
    throw error;
  } finally {
    inputs.forEach((input) => {
      input.disabled = false;
    });
  }

  return checkedMealTypes;
}

function renderPage(container, preferences) {
  const visibleMealTypes = Array.isArray(preferences.visible_meal_types)
    ? preferences.visible_meal_types
    : MEAL_TYPES;

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionMeals')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.mealTypesLabel')}</h3>
        <p class="form-hint">${t('settings.mealTypesHint')}</p>
        <div class="meal-type-toggles" id="meal-type-toggles">
          ${MEAL_TYPES.map((mealType) => toggleRowHtml({
            label: t(`meals.type${mealType[0].toUpperCase()}${mealType.slice(1)}`),
            checked: visibleMealTypes.includes(mealType),
            attrs: { value: mealType },
          })).join('')}
        </div>
        <p class="form-hint">${t('settings.kitchenExternalHint')}</p>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.recipeProvidersTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.recipeProvidersDescription')}</p>
        <div id="recipe-provider-accounts" class="settings-sync-accounts"></div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--primary" id="recipe-provider-add-account-btn">
            ${t('settings.recipeProviderAddAccount')}
          </button>
        </div>
      </div>
    </section>
  `);
}

function renderProviderAccount(container, account, refresh) {
  const card = document.createElement('article');
  card.className = 'caldav-account-item';

  const details = [providerLabel(account.provider), lastSyncDetail(account.lastSync), account.baseUrl];
  if (account.lastError) details.push(t('settings.recipeProviderLastError', { message: account.lastError }));

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn btn--secondary btn--sm';
  syncBtn.textContent = t('settings.syncNow');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      // syncAccount() wirft nie bei einem fehlgeschlagenen Provider-Abruf (Netzwerk/
      // Auth) - der Fehler steckt dann in result.data.failed/error, HTTP bleibt 200.
      // Nur ein echter Request-Fehler (Server down, 500) landet im catch.
      const res = await recipeProviders.syncAccount(account.id);
      if (res.data?.failed) {
        showToast(res.data.error || t('settings.recipeProviderSyncFailed'), 'danger');
      } else {
        showToast(t('settings.recipeProviderSyncSuccess'), 'success');
      }
      await refresh();
    } catch (err) {
      showToast(err.message || t('settings.recipeProviderSyncFailed'), 'danger');
      syncBtn.disabled = false;
    }
  });

  card.appendChild(createStatusSummary({
    title: account.name,
    status: account.lastError
      ? t('settings.notConnected')
      : (account.lastSync ? t('settings.connected') : t('settings.notConnected')),
    details,
    action: syncBtn,
    tone: account.lastError ? 'danger' : (account.lastSync ? 'success' : 'neutral'),
  }));

  const actions = document.createElement('div');
  actions.className = 'caldav-account-actions';

  const editLinkBtn = document.createElement('button');
  editLinkBtn.type = 'button';
  editLinkBtn.className = 'btn btn--ghost btn--sm';
  editLinkBtn.textContent = t('settings.recipeProviderEditLink');
  editLinkBtn.addEventListener('click', () => openProviderLinkModal(account, refresh));
  actions.appendChild(editLinkBtn);

  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.className = 'btn btn--ghost btn--sm';
  enableBtn.textContent = account.enabled ? t('settings.recipeProviderDisable') : t('settings.recipeProviderEnable');
  enableBtn.addEventListener('click', async () => {
    enableBtn.disabled = true;
    try {
      await recipeProviders.updateAccount(account.id, { enabled: !account.enabled });
      await refresh();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
      enableBtn.disabled = false;
    }
  });
  actions.appendChild(enableBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn--danger-outline btn--sm';
  deleteBtn.textContent = t('common.delete');
  deleteBtn.addEventListener('click', async () => {
    // Löschen des Accounts löscht per FK-Kaskade auch alle von ihm gespiegelten
    // Rezepte - der Hinweis nennt das explizit, sonst verschwinden Rezepte
    // scheinbar grundlos aus dem Essensplan.
    const confirmed = await confirmModal(
      t('settings.disconnectAccountConfirmTitle', { name: account.name }),
      {
        detail: t('settings.recipeProviderDeleteAccountConfirm', { count: account.recipeCount ?? 0 }),
        confirmLabel: t('common.delete'),
        danger: true,
      },
    );
    if (!confirmed) return;
    try {
      await recipeProviders.deleteAccount(account.id);
      showToast(t('settings.recipeProviderAccountDeleted'), 'success');
      await refresh();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  actions.appendChild(deleteBtn);

  card.appendChild(actions);
  container.appendChild(card);
}

function openProviderLinkModal(account, refresh) {
  openModal({
    title: t('settings.recipeProviderEditLink'),
    size: 'sm',
    content: `
      <form id="recipe-provider-link-form" novalidate autocomplete="off">
        <p class="form-hint">${t('settings.recipeProviderExternalUrlHint', { provider: providerLabel(account.provider) })}</p>
        <div class="form-group">
          <label class="form-label" for="recipe-provider-link-external-url">${t('settings.recipeProviderExternalUrlLabel')}</label>
          <input class="form-input" type="url" id="recipe-provider-link-external-url" placeholder="https://cook.example.com" value="${esc(account.externalUrl ?? '')}" />
        </div>
        <div id="recipe-provider-link-error" class="form-error" role="alert" hidden></div>
        <div class="modal-actions">
          <button type="button" class="btn btn--ghost" id="recipe-provider-link-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary">${t('common.save')}</button>
        </div>
      </form>
    `,
    onSave: (panel) => {
      const form = panel.querySelector('#recipe-provider-link-form');
      const errorEl = panel.querySelector('#recipe-provider-link-error');
      panel.querySelector('#recipe-provider-link-cancel')?.addEventListener('click', () => closeModal({ force: true }));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.hidden = true;
        const external_url = panel.querySelector('#recipe-provider-link-external-url').value.trim();
        try {
          await recipeProviders.updateAccount(account.id, { external_url });
          closeModal({ force: true });
          showToast(t('settings.recipeProviderAccountUpdated'), 'success');
          await refresh();
        } catch (err) {
          errorEl.textContent = err.message || t('common.errorGeneric');
          errorEl.hidden = false;
        }
      });
    },
  });
}

async function loadProviderAccounts(container) {
  const listEl = container.querySelector('#recipe-provider-accounts');
  if (!listEl) return;
  listEl.replaceChildren();

  const reload = () => loadProviderAccounts(container);

  let accounts;
  try {
    // getStatus() statt listAccounts(): liefert dieselben Felder bereits im
    // camelCase-Format, das renderProviderAccount() erwartet, plus recipeCount -
    // listAccounts() (GET /accounts) gibt dagegen die rohen snake_case-DB-Spalten
    // zurück (base_url/last_sync/last_error) und kennt recipeCount gar nicht.
    const res = await recipeProviders.getStatus();
    accounts = res.data || [];
  } catch (err) {
    listEl.appendChild(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    return;
  }

  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.recipeProvidersEmptyState');
    listEl.appendChild(empty);
    return;
  }

  for (const account of accounts) renderProviderAccount(listEl, account, reload);
}

function bindProviderAddButton(container) {
  const addBtn = container.querySelector('#recipe-provider-add-account-btn');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => {
    openModal({
      title: t('settings.recipeProviderAddAccount'),
      size: 'sm',
      content: `
        <form id="recipe-provider-add-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="recipe-provider-select">${t('settings.recipeProviderTypeLabel')}</label>
            <select class="form-input" id="recipe-provider-select">
              <option value="mealie">Mealie</option>
              <option value="tandoor">Tandoor</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="recipe-provider-name">${t('settings.recipeProviderNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="text" id="recipe-provider-name" required maxlength="100" />
          </div>
          <div class="form-group">
            <label class="form-label" for="recipe-provider-url">${t('settings.recipeProviderUrlLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="url" id="recipe-provider-url" required placeholder="https://cook.example.com" />
            <small class="form-hint">${t('settings.recipeProviderUrlHint')}</small>
          </div>
          <div class="form-group">
            <label class="form-label" for="recipe-provider-external-url">${t('settings.recipeProviderExternalUrlLabel')}</label>
            <input class="form-input" type="url" id="recipe-provider-external-url" placeholder="https://cook.example.com" />
            <small class="form-hint">${t('settings.recipeProviderExternalUrlHint', { provider: 'Mealie' })}</small>
          </div>
          <div class="form-group">
            <label class="form-label" for="recipe-provider-token">${t('settings.recipeProviderTokenLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="password" id="recipe-provider-token" required autocomplete="off" />
            <small class="form-hint" id="recipe-provider-token-hint">${t('settings.recipeProviderTokenHintMealie')}</small>
          </div>
          <div id="recipe-provider-add-error" class="form-error" role="alert" hidden></div>
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" id="recipe-provider-add-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>
      `,
      onSave: (panel) => {
        const form = panel.querySelector('#recipe-provider-add-form');
        const errorEl = panel.querySelector('#recipe-provider-add-error');
        const providerSelect = panel.querySelector('#recipe-provider-select');
        const externalUrlHint = panel.querySelector('#recipe-provider-external-url').nextElementSibling;
        const tokenHint = panel.querySelector('#recipe-provider-token-hint');
        panel.querySelector('#recipe-provider-add-cancel')?.addEventListener('click', () => closeModal({ force: true }));

        // Name/URL/externe URL/Token haben dieselbe Form für jeden Provider -
        // nur der Token-Hinweis und der "Öffnen in ..."-Text unterscheiden sich,
        // je nachdem, wo der Nutzer den API-Token erzeugt.
        providerSelect.addEventListener('change', () => {
          const label = providerLabel(providerSelect.value);
          tokenHint.textContent = providerSelect.value === 'tandoor'
            ? t('settings.recipeProviderTokenHintTandoor')
            : t('settings.recipeProviderTokenHintMealie');
          externalUrlHint.textContent = t('settings.recipeProviderExternalUrlHint', { provider: label });
        });

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errorEl.hidden = true;

          const provider = providerSelect.value;
          const name = panel.querySelector('#recipe-provider-name').value.trim();
          const base_url = panel.querySelector('#recipe-provider-url').value.trim();
          const external_url = panel.querySelector('#recipe-provider-external-url').value.trim();
          const api_token = panel.querySelector('#recipe-provider-token').value;

          if (!name || !base_url || !api_token) {
            errorEl.textContent = t('common.requiredFields');
            errorEl.hidden = false;
            return;
          }

          try {
            await recipeProviders.createAccount({ provider, name, base_url, external_url, api_token });
            closeModal({ force: true });
            showToast(t('settings.recipeProviderAccountAdded'), 'success');
            await loadProviderAccounts(container);
          } catch (err) {
            errorEl.textContent = err.message || t('common.errorGeneric');
            errorEl.hidden = false;
          }
        });
      },
    });
  });
}

function bindEvents(container) {
  const mealToggles = container.querySelector('#meal-type-toggles');
  const inputs = [...(mealToggles?.querySelectorAll('input') ?? [])];
  let persistedMealTypes = inputs
    .filter((input) => input.checked)
    .map((input) => input.value);

  mealToggles?.addEventListener('change', async () => {
    if (inputs.some((input) => input.disabled)) return;

    const checkedMealTypes = inputs
      .filter((input) => input.checked)
      .map((checkbox) => checkbox.value);

    if (checkedMealTypes.length === 0) {
      inputs.forEach((input) => {
        input.checked = persistedMealTypes.includes(input.value);
      });
      window.yuvomi?.showToast(t('settings.mealTypesMinOne'), 'danger');
      return;
    }

    try {
      persistedMealTypes = await persistMealTypeSelection(
        inputs,
        checkedMealTypes,
        persistedMealTypes,
        () => savePreferences({ visible_meal_types: checkedMealTypes }),
      );
      window.yuvomi?.showToast(t('settings.mealTypesSaved'), 'success');
    } catch (error) {
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  });
}

export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindEvents(container);
  bindProviderAddButton(container);
  await loadProviderAccounts(container);
}
