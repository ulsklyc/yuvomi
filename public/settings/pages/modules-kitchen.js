import { recipeProviders } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { closeModal, confirmModal, openModal, refocusAfterRender } from '/components/modal.js';
import {
  createInlineError,
  createRetryState,
  createStatusSummary,
  settingRowHtml,
  settingSwitchRowHtml,
} from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { formRowHtml, formRowsHtml } from '/utils/form-row.js';

/** Das Pflichtzeichen hinter einem Etikett - Markup, kein Text (aria-hidden). */
import { esc, REQUIRED_MARK } from '/utils/html.js';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
// Muss zur Serverpruefung in routes/preferences.js passen; der Server kappt
// ohnehin, das `maxlength` erspart dem Nutzer nur die Fehlermeldung.
const MAX_MEAL_TYPE_NAME = 40;

/* Hier steht bewusst das EINGEBAUTE Wort, nicht mealTypeLabel(): dieser Schirm
 * ist der Ort, an dem der Haushaltsname vergeben wird, und er steht direkt
 * daneben im Feld. Beides auf denselben Namen zu setzen zeigte ihn zweimal und
 * verbaerge, was das Feld eigentlich ueberschreibt. */
function builtInMealTypeLabel(mealType) {
  return t(`meals.type${mealType[0].toUpperCase()}${mealType.slice(1)}`);
}

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
  const mealTypeNames = (preferences.meal_type_names && typeof preferences.meal_type_names === 'object')
    ? preferences.meal_type_names
    : {};

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionMeals')}</h2>
      <!-- EIN FORMULAR-DIALEKT (R19, Critique 2026-10-16): hier stand eine
           Karte mit zwei Kartentiteln, die Schalter ohne Haarlinien und die
           Namen als Felder UNTER ihrem Etikett - ein zweiter Dialekt neben
           den gruppierten Zeilen der anderen Blaetter, und vier Ueberschriften
           uebereinander ("Fuer den Haushalt", "Essensplan", "Sichtbare
           Mahlzeiten", "Eigene Namen"). Jetzt zwei Gruppen in der Form der
           iOS-Einstellungen: Zeilen im Traeger, ein leiser Gruppentitel, der
           Hinweis als Gruppenfuss. -->
      <h3 class="settings-card__title settings-group__title">${t('settings.mealTypesLabel')}</h3>
      <div class="row-carrier settings-group meal-type-toggles" id="meal-type-toggles">
        ${MEAL_TYPES.map((mealType) => settingSwitchRowHtml({
          label: builtInMealTypeLabel(mealType),
          checked: visibleMealTypes.includes(mealType),
          attrs: { value: mealType },
        })).join('')}
      </div>
      <p class="form-hint settings-group__footer">${t('settings.mealTypesHint')}</p>
      <h3 class="settings-card__title settings-group__title">${t('settings.mealTypeNamesLabel')}</h3>
      <div class="row-carrier settings-group meal-type-names" id="meal-type-names">
        ${MEAL_TYPES.map((mealType) => settingRowHtml({
          label: builtInMealTypeLabel(mealType),
          labelFor: `meal-name-${mealType}`,
          control: `<input class="form-input" type="text" id="meal-name-${mealType}"
                     data-meal-name="${mealType}" maxlength="${MAX_MEAL_TYPE_NAME}"
                     value="${esc(mealTypeNames[mealType] ?? '')}"
                     placeholder="${esc(builtInMealTypeLabel(mealType))}">`,
        })).join('')}
      </div>
      <p class="form-hint settings-group__footer">${t('settings.mealTypeNamesHint')}</p>
      <p class="form-hint settings-group__footer">${t('settings.kitchenExternalHint')}</p>
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
      refocusAfterRender();
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
        ${/* Derselbe Zeilen-Dialekt wie die Blaetter (R19, B7). */ ''}
        ${formRowsHtml(formRowHtml({
          label: t('settings.recipeProviderExternalUrlLabel'), labelFor: 'recipe-provider-link-external-url', field: true,
          description: t('settings.recipeProviderExternalUrlHint', { provider: providerLabel(account.provider) }),
          descriptionId: 'recipe-provider-link-external-url-hint',
          control: `<input class="form-input" type="url" id="recipe-provider-link-external-url" aria-describedby="recipe-provider-link-external-url-hint" placeholder="https://cook.example.com" value="${esc(account.externalUrl ?? '')}" />`,
        }))}
        <div id="recipe-provider-link-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" id="recipe-provider-link-cancel">${t('common.cancel')}</button>
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
          refocusAfterRender();
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
          ${/* DER DIALOG SPRICHT DENSELBEN DIALEKT (R19, B7): Zeilen im
               Traeger, Hinweise unter ihrer Zeile. */ ''}
          ${formRowsHtml([
            formRowHtml({
              label: t('settings.recipeProviderTypeLabel'), labelFor: 'recipe-provider-select',
              control: `<select class="form-input" id="recipe-provider-select">
                <option value="mealie">Mealie</option>
                <option value="tandoor">Tandoor</option>
              </select>`,
            }),
            formRowHtml({
              label: t('settings.recipeProviderNameLabel'), labelFor: 'recipe-provider-name', labelExtra: REQUIRED_MARK, field: true,
              control: '<input class="form-input" type="text" id="recipe-provider-name" required maxlength="100" />',
            }),
            formRowHtml({
              label: t('settings.recipeProviderUrlLabel'), labelFor: 'recipe-provider-url', labelExtra: REQUIRED_MARK, field: true,
              description: t('settings.recipeProviderUrlHint'), descriptionId: 'recipe-provider-url-hint',
              control: '<input class="form-input" type="url" id="recipe-provider-url" required aria-describedby="recipe-provider-url-hint" placeholder="https://cook.example.com" />',
            }),
            formRowHtml({
              label: t('settings.recipeProviderExternalUrlLabel'), labelFor: 'recipe-provider-external-url', field: true,
              description: t('settings.recipeProviderExternalUrlHint', { provider: 'Mealie' }), descriptionId: 'recipe-provider-external-url-hint',
              control: '<input class="form-input" type="url" id="recipe-provider-external-url" aria-describedby="recipe-provider-external-url-hint" placeholder="https://cook.example.com" />',
            }),
            formRowHtml({
              label: t('settings.recipeProviderTokenLabel'), labelFor: 'recipe-provider-token', labelExtra: REQUIRED_MARK, field: true,
              description: t('settings.recipeProviderTokenHintMealie'), descriptionId: 'recipe-provider-token-hint',
              control: '<input class="form-input" type="password" id="recipe-provider-token" required autocomplete="new-password" aria-describedby="recipe-provider-token-hint" />',
            }),
          ])}
          <div id="recipe-provider-add-error" class="form-error" role="alert" hidden></div>
          <div class="modal-panel__footer modal-panel__footer--plain">
            <button type="button" class="btn btn--secondary" id="recipe-provider-add-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.add')}</button>
          </div>
        </form>
      `,
      onSave: (panel) => {
        const form = panel.querySelector('#recipe-provider-add-form');
        const errorEl = panel.querySelector('#recipe-provider-add-error');
        const providerSelect = panel.querySelector('#recipe-provider-select');
        const externalUrlHint = panel.querySelector('#recipe-provider-external-url-hint');
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
            refocusAfterRender();
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

  /* Namen der Slots (#1058).
   *
   * AUF `change`, NICHT AUF `input`: sonst schriebe jeder Tastendruck eine
   * Praeferenz. Der Browser feuert `change` beim Verlassen des Feldes und bei
   * Enter - genau dann, wenn der Name fertig ist.
   *
   * ALLE VIER WERDEN GESENDET, nicht nur das geaenderte: der Server speichert
   * das Objekt als Ganzes, ein Teil-Objekt loeschte die uebrigen Namen. */
  const nameFields = container.querySelector('#meal-type-names');
  const nameInputs = [...(nameFields?.querySelectorAll('[data-meal-name]') ?? [])];
  let persistedNames = Object.fromEntries(nameInputs.map((i) => [i.dataset.mealName, i.value]));

  nameFields?.addEventListener('change', async (event) => {
    const field = event.target.closest('[data-meal-name]');
    if (!field) return;

    const names = Object.fromEntries(nameInputs.map((i) => [i.dataset.mealName, i.value.trim()]));
    nameInputs.forEach((i) => { i.disabled = true; });
    try {
      await savePreferences({ meal_type_names: names });
      // Der Server trimmt und wirft leere Namen weg - das Feld zeigt danach,
      // was wirklich gespeichert ist, statt der eingetippten Leerzeichen.
      nameInputs.forEach((i) => { i.value = names[i.dataset.mealName] ?? ''; });
      persistedNames = names;
      window.yuvomi?.showToast(t('settings.mealTypeNamesSaved'), 'success');
    } catch (error) {
      nameInputs.forEach((i) => { i.value = persistedNames[i.dataset.mealName] ?? ''; });
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      nameInputs.forEach((i) => { i.disabled = false; });
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
