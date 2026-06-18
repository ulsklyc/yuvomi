import { api } from '/api.js';
import { t } from '/i18n.js';
import { confirmModal } from '/components/modal.js';
import {
  createDisclosure,
  createInlineError,
  createRetryState,
  createStatusSummary,
} from '/settings/components.js';

function showToast(message, tone = 'default') {
  window.oikos?.showToast(message, tone);
}

function buildAddForm(container) {
  const form = document.createElement('form');
  form.className = 'settings-form settings-form--compact';
  form.id = 'dms-form';
  form.noValidate = true;
  form.autocomplete = 'off';
  form.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="dms-provider">${t('settings.dmsProvider')}</label>
      <select class="form-input" id="dms-provider">
        <option value="paperless">${t('settings.dmsProviderPaperless')}</option>
        <option value="papra">${t('settings.dmsProviderPapra')}</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="dms-name">${t('settings.dmsName')}</label>
      <input class="form-input" type="text" id="dms-name" maxlength="100" required />
    </div>
    <div class="form-group">
      <label class="form-label" for="dms-url">${t('settings.dmsBaseUrl')}</label>
      <input class="form-input" type="url" id="dms-url" required placeholder="https://..." />
    </div>
    <div class="form-group" id="dms-org-group" hidden>
      <label class="form-label" for="dms-org-id">${t('settings.dmsOrgId')}</label>
      <input class="form-input" type="text" id="dms-org-id" maxlength="200" />
    </div>
    <div class="form-group">
      <label class="form-label" for="dms-token">${t('settings.dmsToken')}</label>
      <input class="form-input" type="password" id="dms-token" required autocomplete="current-password" />
    </div>
    <div id="dms-form-error-host"></div>
    <div class="settings-form-actions">
      <button type="submit" class="btn btn--primary">${t('settings.dmsAddBtn')}</button>
    </div>
  `);

  const providerSelect = form.querySelector('#dms-provider');
  const orgGroup = form.querySelector('#dms-org-group');
  const orgInput = form.querySelector('#dms-org-id');
  providerSelect.addEventListener('change', () => {
    const isPapra = providerSelect.value === 'papra';
    orgGroup.hidden = !isPapra;
    orgInput.required = isPapra;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorHost = form.querySelector('#dms-form-error-host');
    errorHost.replaceChildren();
    const provider = providerSelect.value;
    const name = form.querySelector('#dms-name').value.trim();
    const base_url = form.querySelector('#dms-url').value.trim();
    const api_token = form.querySelector('#dms-token').value;
    const payload = { provider, name, base_url, api_token };
    if (provider === 'papra') payload.org_id = orgInput.value.trim();
    try {
      await api.post('/documents/dms/accounts', payload);
      form.reset();
      orgGroup.hidden = true;
      orgInput.required = false;
      showToast(t('settings.dmsConnected'), 'success');
      await loadDmsAccounts(container);
    } catch (err) {
      errorHost.replaceChildren(createInlineError(err.message ?? t('common.errorGeneric')));
    }
  });

  return form;
}

function renderAccount(listEl, account, reload) {
  const actions = document.createElement('div');
  actions.className = 'dms-account-meta';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn btn--secondary btn--sm';
  testBtn.textContent = t('settings.dmsTestBtn');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    try {
      const res = await api.post(`/documents/dms/accounts/${account.id}/test`);
      const result = res.data ?? {};
      if (result.ok) {
        showToast(t('settings.dmsTestOk'), 'success');
      } else {
        showToast(t('settings.dmsTestFail', { status: result.status }), 'danger');
      }
    } catch (err) {
      showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      testBtn.disabled = false;
    }
  });
  actions.appendChild(testBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn--danger btn--sm';
  delBtn.textContent = t('settings.dmsRemove');
  delBtn.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.dmsRemoveConfirm'), { danger: true })) return;
    try {
      await api.delete(`/documents/dms/accounts/${account.id}`);
      await reload();
    } catch (err) {
      showToast(err.message ?? t('common.errorGeneric'), 'danger');
    }
  });
  actions.appendChild(delBtn);

  const card = createStatusSummary({
    title: account.name,
    status: account.base_url,
    details: [t('settings.dmsDescription')],
    tone: 'neutral',
    action: actions,
  });
  card.className += ' dms-account-item';
  card.dataset.id = account.id;

  listEl.appendChild(card);
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.dmsTitle')}</h2>
      <div class="settings-card" id="dms-card">
        <p class="settings-card-description">${t('settings.dmsDescription')}</p>
        <div class="dms-account-list" id="dms-account-list"></div>
        <div id="dms-add-host"></div>
      </div>
    </section>
  `);
}

async function loadDmsAccounts(container) {
  const listEl = container.querySelector('#dms-account-list');
  const addHost = container.querySelector('#dms-add-host');
  if (!listEl || !addHost) return;

  const reload = () => loadDmsAccounts(container);

  let accounts;
  try {
    const res = await api.get('/documents/dms/accounts');
    accounts = res.data ?? [];
  } catch (err) {
    listEl.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    addHost.replaceChildren();
    return;
  }

  listEl.replaceChildren();
  if (!accounts.length) {
    const empty = document.createElement('p');
    empty.className = 'dms-account-empty form-hint';
    empty.textContent = t('settings.dmsNone');
    listEl.appendChild(empty);
  } else {
    for (const account of accounts) {
      renderAccount(listEl, account, reload);
    }
  }

  const addForm = buildAddForm(container);
  if (accounts.length) {
    // With existing accounts the add form is tucked behind a disclosure.
    addHost.replaceChildren(createDisclosure({
      id: 'dms-add',
      summary: t('settings.dmsAddBtn'),
      content: addForm,
    }));
  } else {
    addHost.replaceChildren(addForm);
  }

  window.lucide?.createIcons({ el: container });
}

export async function render(container, { user } = {}) {
  renderPage(container);
  await loadDmsAccounts(container);
  window.lucide?.createIcons({ el: container });
}
