import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { closeModal, confirmModal, openModal } from '/components/modal.js';
import {
  createInlineError,
  createRetryState,
  createStatusSummary,
} from '/settings/components.js';

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

function lastSyncDetail(value) {
  const formatted = formatSyncTime(value);
  return formatted
    ? t('settings.lastSyncValue', { value: formatted })
    : t('settings.neverSynced');
}

function enabledAddressbookCount(addressbooks) {
  return addressbooks.filter((ab) => ab.enabled).length;
}

function showToast(message, tone = 'default') {
  window.oikos?.showToast(message, tone);
}

function renderPage(container, user) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.cardavTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.cardavDescription')}</p>
        <div id="cardav-accounts" class="settings-sync-accounts"></div>
        ${user?.role === 'admin' ? `
          <div class="settings-form-actions">
            <button type="button" class="btn btn--primary" id="cardav-add-account-btn">
              ${t('settings.cardavAddAccount')}
            </button>
          </div>
        ` : ''}
      </div>
    </section>
  `);
}

function buildAddressbookList(account, addressbooks) {
  const details = document.createElement('details');
  details.className = 'caldav-calendars-details';

  const summary = document.createElement('summary');
  summary.className = 'caldav-calendars-summary';
  summary.textContent = `${t('settings.cardavAddressbooksToggle')} (${addressbooks.length})`;
  details.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'caldav-calendars-list';
  for (const ab of addressbooks) {
    const label = document.createElement('label');
    label.className = 'caldav-calendar-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'cardav-addressbook-checkbox';
    checkbox.checked = Boolean(ab.enabled);

    const name = document.createElement('span');
    name.className = 'caldav-calendar-name';
    name.textContent = ab.display_name || ab.url;

    label.append(checkbox, name);
    list.appendChild(label);

    checkbox.addEventListener('change', async () => {
      const enabled = checkbox.checked;
      checkbox.disabled = true;
      try {
        await api.post(`/contacts/cardav/accounts/${account.id}/addressbooks/toggle`, {
          addressbookUrl: ab.url,
          enabled,
        });
        showToast(
          enabled ? t('settings.addressbookEnabled') : t('settings.addressbookDisabled'),
          'success',
        );
      } catch (err) {
        checkbox.checked = !enabled;
        showToast(err.message || t('common.errorGeneric'), 'danger');
      } finally {
        checkbox.disabled = false;
      }
    });
  }
  details.appendChild(list);
  return details;
}

function renderAccount(container, account, addressbooks, refresh, user) {
  const card = document.createElement('article');
  card.className = 'caldav-account-item';

  const details = [t('settings.cardavTitle')];
  if (account.cardav_url) details.push(account.cardav_url);
  details.push(lastSyncDetail(account.last_sync));
  if (account.last_error) {
    details.push(t('settings.syncLatestError', { error: account.last_error }));
  }

  const summary = createStatusSummary({
    title: account.name,
    status: t('settings.enabledAddressbookCount', {
      count: enabledAddressbookCount(addressbooks),
    }),
    details,
    tone: account.last_error ? 'warning' : 'neutral',
  });
  card.appendChild(summary);

  card.appendChild(buildAddressbookList(account, addressbooks));

  const actions = document.createElement('div');
  actions.className = 'caldav-account-actions';

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn btn--secondary btn--sm';
  syncBtn.textContent = t('settings.syncNow');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      await api.post(`/contacts/cardav/accounts/${account.id}/sync`);
      showToast(t('settings.cardavSyncSuccess'), 'success');
      await refresh();
    } catch (err) {
      showToast(err.message || t('settings.cardavSyncFailed'), 'danger');
      syncBtn.disabled = false;
    }
  });
  actions.appendChild(syncBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn btn--secondary btn--sm';
  refreshBtn.textContent = t('settings.cardavRefreshAddressbooks');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await api.post(`/contacts/cardav/accounts/${account.id}/addressbooks/refresh`);
      showToast(t('settings.addressbooksRefreshed'), 'success');
      await refresh();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
      refreshBtn.disabled = false;
    }
  });
  actions.appendChild(refreshBtn);

  if (user?.role === 'admin') {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn--danger-outline btn--sm';
    deleteBtn.textContent = t('settings.disconnect');
    deleteBtn.addEventListener('click', async () => {
      if (!await confirmModal(t('settings.deleteCardDAVAccountConfirm'), { danger: true })) return;
      try {
        await api.delete(`/contacts/cardav/accounts/${account.id}`);
        showToast(t('settings.cardavAccountDeleted'), 'success');
        await refresh();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    actions.appendChild(deleteBtn);
  }

  card.appendChild(actions);
  container.appendChild(card);
}

async function loadAccounts(container, user) {
  const listEl = container.querySelector('#cardav-accounts');
  if (!listEl) return;
  listEl.replaceChildren();

  const reload = () => loadAccounts(container, user);

  let accounts;
  try {
    const res = await api.get('/contacts/cardav/accounts');
    accounts = res.data || [];
  } catch (err) {
    listEl.appendChild(createRetryState({
      message: err.message || t('settings.cardavConnectionFailed'),
      onRetry: reload,
    }));
    return;
  }

  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.cardavEmptyState');
    listEl.appendChild(empty);
    return;
  }

  for (const account of accounts) {
    let addressbooks = [];
    try {
      const abRes = await api.get(`/contacts/cardav/accounts/${account.id}/addressbooks`);
      addressbooks = abRes.data || [];
    } catch (err) {
      const wrapper = document.createElement('div');
      wrapper.className = 'caldav-account-item';
      wrapper.appendChild(createStatusSummary({
        title: account.name,
        status: t('settings.notConnected'),
        details: [lastSyncDetail(account.last_sync)],
        tone: 'warning',
      }));
      wrapper.appendChild(createInlineError(err.message || t('common.errorGeneric')));
      listEl.appendChild(wrapper);
      continue;
    }
    renderAccount(listEl, account, addressbooks, reload, user);
  }
}

function bindAddButton(container, user) {
  const addBtn = container.querySelector('#cardav-add-account-btn');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => {
    openModal({
      title: t('settings.cardavAddAccount'),
      size: 'sm',
      content: `
        <form id="cardav-add-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="cardav-name">${t('settings.cardavNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="text" id="cardav-name" required
                   placeholder="${t('settings.cardavNamePlaceholder')}" maxlength="100" />
          </div>
          <div class="form-group">
            <label class="form-label" for="cardav-url">${t('settings.cardavUrlLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="url" id="cardav-url" required
                   placeholder="${t('settings.cardavUrlPlaceholder')}" />
            <small class="form-hint">${t('settings.cardavUrlHint')}</small>
          </div>
          <div class="form-group">
            <label class="form-label" for="cardav-username">${t('settings.cardavUsernameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="text" id="cardav-username" required autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label" for="cardav-password">${t('settings.cardavPasswordLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="password" id="cardav-password" required autocomplete="current-password" />
            <small class="form-hint">${t('settings.cardavPasswordHint')}</small>
          </div>
          <div id="cardav-add-error" class="form-error" role="alert" hidden></div>
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" id="cardav-add-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>
      `,
      onSave: (panel) => {
        const form = panel.querySelector('#cardav-add-form');
        const errorEl = panel.querySelector('#cardav-add-error');
        panel.querySelector('#cardav-add-cancel')?.addEventListener('click', () => closeModal({ force: true }));

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errorEl.hidden = true;

          const name = panel.querySelector('#cardav-name').value.trim();
          const cardavUrl = panel.querySelector('#cardav-url').value.trim();
          const username = panel.querySelector('#cardav-username').value.trim();
          const password = panel.querySelector('#cardav-password').value;

          if (!name || !cardavUrl || !username || !password) {
            errorEl.textContent = t('common.allFieldsRequired');
            errorEl.hidden = false;
            return;
          }

          try {
            await api.post('/contacts/cardav/accounts', {
              name,
              cardavUrl,
              username,
              password,
            });
            closeModal({ force: true });
            showToast(t('settings.cardavAccountAdded'), 'success');
            await loadAccounts(container, user);
          } catch (err) {
            errorEl.textContent = err.message || t('common.errorGeneric');
            errorEl.hidden = false;
          }
        });
      },
    });
  });
}

export async function render(container, { user }) {
  renderPage(container, user);
  bindAddButton(container, user);
  await loadAccounts(container, user);
  window.lucide?.createIcons({ el: container });
}
