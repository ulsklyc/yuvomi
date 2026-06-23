import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { closeModal, confirmModal, openModal } from '/components/modal.js';
import {
  createDisclosure,
  createInlineError,
  createRetryState,
  createStatusSummary,
} from '/settings/components.js';

const MORE_PROVIDERS_ID = 'sync-more-providers';
const GOOGLE_PROVIDER_ID = 'sync-provider-google';
const APPLE_PROVIDER_ID = 'sync-provider-apple';

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

function enabledCalendarCount(calendars) {
  return calendars.filter((cal) => cal.enabled).length;
}

function showToast(message, tone = 'default') {
  window.oikos?.showToast(message, tone);
}

function providerConnectionStatus(status) {
  if (!status) return t('settings.notConnected');
  if (status.connected) {
    const formatted = formatSyncTime(status.lastSync);
    return formatted
      ? t('settings.connectedLastSync', { date: formatted })
      : t('settings.connected');
  }
  if (status.configured) {
    const formatted = formatSyncTime(status.lastSync);
    return formatted
      ? t('settings.configuredLastSync', { date: formatted })
      : t('settings.configured');
  }
  return t('settings.notConfigured');
}

// --------------------------------------------------------------------------
// Page scaffold
// --------------------------------------------------------------------------

function renderPage(container, user) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div id="sync-calendar-banner"></div>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.caldavTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.caldavDescription')}</p>
        <div id="caldav-accounts" class="settings-sync-accounts"></div>
        ${user?.role === 'admin' ? `
          <div class="settings-form-actions">
            <button type="button" class="btn btn--primary" id="caldav-add-account-btn">
              ${t('settings.caldavAddAccount')}
            </button>
          </div>
        ` : ''}
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.ics.title')}</h2>
      <div class="settings-card">
        <div id="ics-accounts" class="settings-sync-accounts"></div>
        <div id="ics-add-form-wrapper" hidden>
          <form id="ics-add-form" class="settings-form settings-form--compact" novalidate autocomplete="off">
            <div class="form-group">
              <label class="form-label" for="ics-url">${t('settings.ics.form.url')}</label>
              <input class="form-input" type="url" id="ics-url" required placeholder="https://..." />
            </div>
            <div class="form-group">
              <label class="form-label" for="ics-name">${t('settings.ics.form.name')}</label>
              <input class="form-input" type="text" id="ics-name" required maxlength="100" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ics-color">${t('settings.ics.form.color')}</label>
              <input class="form-input form-input--color" type="color" id="ics-color" value="#6366f1" />
            </div>
            <div class="form-group">
              <label class="toggle-row">
                <input type="checkbox" id="ics-shared" />
                <span>${t('settings.ics.form.shared')}</span>
              </label>
            </div>
            <div id="ics-add-error" class="form-error" role="alert" hidden></div>
            <div class="settings-form-actions">
              <button type="submit" class="btn btn--primary" id="ics-submit-btn">${t('settings.ics.actions.submit')}</button>
              <button type="button" class="btn btn--secondary" id="ics-cancel-btn">${t('settings.ics.actions.cancel')}</button>
            </div>
          </form>
        </div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="ics-add-btn">${t('settings.ics.add')}</button>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <div id="sync-more-providers-container"></div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.feedExportTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.feedExportDescription')}</p>
        <div id="feed-export-body"></div>
      </div>
    </section>
  `);
}

// --------------------------------------------------------------------------
// CalDAV calendar accounts
// --------------------------------------------------------------------------

function buildCalendarList(account, calendars) {
  const details = document.createElement('details');
  details.className = 'caldav-calendars-details';

  const summary = document.createElement('summary');
  summary.className = 'caldav-calendars-summary';
  summary.textContent = `${t('settings.caldavCalendarsToggle')} (${calendars.length})`;
  details.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'caldav-calendars-list';
  for (const cal of calendars) {
    const label = document.createElement('label');
    label.className = 'caldav-calendar-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'caldav-calendar-checkbox';
    checkbox.checked = Boolean(cal.enabled);

    const color = document.createElement('span');
    color.className = 'caldav-calendar-color';
    color.style.backgroundColor = cal.calendarColor || 'var(--color-accent)';

    const name = document.createElement('span');
    name.className = 'caldav-calendar-name';
    name.textContent = cal.calendarName || cal.calendarUrl;

    label.append(checkbox, color, name);
    list.appendChild(label);

    checkbox.addEventListener('change', async () => {
      const enabled = checkbox.checked;
      checkbox.disabled = true;
      try {
        await api.patch(`/calendar/caldav/accounts/${account.id}/calendars`, {
          calendarUrl: cal.calendarUrl,
          enabled,
        });
        showToast(
          enabled ? t('settings.calendarEnabled') : t('settings.calendarDisabled'),
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

function renderCalDAVAccount(container, account, calendars, refresh, user) {
  const card = document.createElement('article');
  card.className = 'caldav-account-item';

  const details = [
    t('settings.enabledCalendarCount', { count: enabledCalendarCount(calendars) }),
    lastSyncDetail(account.last_sync),
  ];
  if (account.caldav_url) details.unshift(account.caldav_url);

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn btn--secondary btn--sm';
  syncBtn.textContent = t('settings.syncNow');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      await api.post('/calendar/caldav/sync');
      showToast(t('settings.caldavSyncSuccess'), 'success');
      await refresh();
    } catch (err) {
      showToast(err.message || t('settings.caldavSyncFailed'), 'danger');
      syncBtn.disabled = false;
    }
  });

  card.appendChild(createStatusSummary({
    title: account.name,
    status: account.last_sync ? t('settings.connected') : t('settings.notConnected'),
    details,
    action: syncBtn,
    tone: account.last_sync ? 'success' : 'neutral',
  }));

  card.appendChild(buildCalendarList(account, calendars));

  const actions = document.createElement('div');
  actions.className = 'caldav-account-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn btn--secondary btn--sm';
  refreshBtn.textContent = t('settings.caldavRefreshCalendars');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await api.get(`/calendar/caldav/accounts/${account.id}/calendars?refresh=true`);
      showToast(t('settings.calendarsRefreshed'), 'success');
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
    deleteBtn.textContent = t('common.delete');
    deleteBtn.addEventListener('click', async () => {
      if (!await confirmModal(t('settings.deleteAccountConfirm'), { danger: true })) return;
      try {
        await api.delete(`/calendar/caldav/accounts/${account.id}`);
        showToast(t('settings.caldavAccountDeleted'), 'success');
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

async function loadCalDAVAccounts(container, user) {
  const listEl = container.querySelector('#caldav-accounts');
  if (!listEl) return;
  listEl.replaceChildren();

  const reload = () => loadCalDAVAccounts(container, user);

  let accounts;
  try {
    const res = await api.get('/calendar/caldav/accounts');
    accounts = res.data || [];
  } catch (err) {
    listEl.appendChild(createRetryState({
      message: err.message || t('settings.caldavConnectionFailed'),
      onRetry: reload,
    }));
    return;
  }

  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.caldavEmptyState');
    listEl.appendChild(empty);
    return;
  }

  for (const account of accounts) {
    let calendars = [];
    try {
      const calRes = await api.get(`/calendar/caldav/accounts/${account.id}/calendars`);
      calendars = calRes.data || [];
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
    renderCalDAVAccount(listEl, account, calendars, reload, user);
  }
}

function bindCalDAVAddButton(container, user) {
  const addBtn = container.querySelector('#caldav-add-account-btn');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => {
    openModal({
      title: t('settings.caldavAddAccount'),
      size: 'sm',
      content: `
        <form id="caldav-add-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="caldav-name">${t('settings.caldavNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="text" id="caldav-name" required
                   placeholder="${t('settings.caldavNamePlaceholder')}" maxlength="100" />
          </div>
          <div class="form-group">
            <label class="form-label" for="caldav-url">${t('settings.caldavUrlLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="url" id="caldav-url" required
                   placeholder="${t('settings.caldavUrlPlaceholder')}" />
            <small class="form-hint">${t('settings.caldavUrlHint')}</small>
          </div>
          <div class="form-group">
            <label class="form-label" for="caldav-username">${t('settings.caldavUsernameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="text" id="caldav-username" required autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label" for="caldav-password">${t('settings.caldavPasswordLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
            <input class="form-input" type="password" id="caldav-password" required autocomplete="current-password" />
            <small class="form-hint">${t('settings.caldavPasswordHint')}</small>
          </div>
          <div id="caldav-add-error" class="form-error" role="alert" hidden></div>
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" id="caldav-add-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>
      `,
      onSave: (panel) => {
        const form = panel.querySelector('#caldav-add-form');
        const errorEl = panel.querySelector('#caldav-add-error');
        panel.querySelector('#caldav-add-cancel')?.addEventListener('click', () => closeModal({ force: true }));

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errorEl.hidden = true;

          const name = panel.querySelector('#caldav-name').value.trim();
          const caldavUrl = panel.querySelector('#caldav-url').value.trim();
          const username = panel.querySelector('#caldav-username').value.trim();
          const password = panel.querySelector('#caldav-password').value;

          if (!name || !caldavUrl || !username || !password) {
            errorEl.textContent = t('common.requiredFields');
            errorEl.hidden = false;
            return;
          }

          try {
            await api.post('/calendar/caldav/accounts', {
              name,
              caldavUrl,
              username,
              password,
            });
            closeModal({ force: true });
            showToast(t('settings.caldavAccountAdded'), 'success');
            await loadCalDAVAccounts(container, user);
          } catch (err) {
            errorEl.textContent = err.message || t('common.errorGeneric');
            errorEl.hidden = false;
          }
        });
      },
    });
  });
}

// --------------------------------------------------------------------------
// ICS / Webcal subscriptions
// --------------------------------------------------------------------------

function renderIcsList(container, subs, user) {
  const listEl = container.querySelector('#ics-accounts');
  if (!listEl) return;
  listEl.replaceChildren();

  if (subs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.ics.empty');
    listEl.appendChild(empty);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'settings-members';
  for (const sub of subs) {
    const li = document.createElement('li');
    li.className = 'settings-member';

    const dot = document.createElement('span');
    dot.className = 'settings-avatar settings-avatar--sm';
    dot.style.background = sub.color;
    dot.style.flexShrink = '0';
    li.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'settings-member__info';

    const nameLine = document.createElement('span');
    nameLine.className = 'settings-member__name';
    nameLine.textContent = sub.name;

    const badge = document.createElement('span');
    badge.className = `badge ${sub.shared ? 'badge--success' : 'badge--neutral'}`;
    badge.style.marginLeft = 'var(--space-2)';
    badge.textContent = sub.shared ? t('settings.ics.badges.shared') : t('settings.ics.badges.private');
    nameLine.appendChild(badge);
    info.appendChild(nameLine);

    const meta = document.createElement('span');
    meta.className = 'settings-member__meta';
    const formatted = formatSyncTime(sub.last_sync);
    meta.textContent = formatted
      ? `${t('settings.ics.status.lastSync')} ${formatted}`
      : t('settings.ics.status.never');
    info.appendChild(meta);
    li.appendChild(info);

    const isOwner = sub.created_by === user?.id || user?.role === 'admin';
    if (isOwner) {
      li.appendChild(buildIcsActions(container, sub, subs, user));
    }
    ul.appendChild(li);
  }
  listEl.appendChild(ul);
  window.lucide?.createIcons({ el: listEl });
}

function buildIcsActions(container, sub, subs, user) {
  const actions = document.createElement('div');
  actions.className = 'cat-row__actions';

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn btn--icon btn--ghost';
  syncBtn.title = t('settings.ics.actions.sync');
  syncBtn.setAttribute('aria-label', t('settings.ics.actions.sync'));
  const syncIcon = document.createElement('i');
  syncIcon.setAttribute('data-lucide', 'refresh-cw');
  syncIcon.className = 'icon-md';
  syncIcon.setAttribute('aria-hidden', 'true');
  syncBtn.appendChild(syncIcon);
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      const res = await api.post(`/calendar/subscriptions/${sub.id}/sync`, {});
      const idx = subs.findIndex((s) => s.id === sub.id);
      if (idx >= 0) subs[idx] = res.data;
      renderIcsList(container, subs, user);
      showToast(t('settings.ics.syncedToast'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
      syncBtn.disabled = false;
    }
  });
  actions.appendChild(syncBtn);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn--icon btn--ghost';
  editBtn.title = t('settings.ics.actions.edit');
  editBtn.setAttribute('aria-label', t('settings.ics.actions.edit'));
  const editIcon = document.createElement('i');
  editIcon.setAttribute('data-lucide', 'pencil');
  editIcon.className = 'icon-sm';
  editIcon.setAttribute('aria-hidden', 'true');
  editBtn.appendChild(editIcon);
  editBtn.addEventListener('click', () => openIcsEditModal(container, sub, subs, user));
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn--icon btn--danger-outline';
  delBtn.title = t('settings.ics.actions.delete');
  delBtn.setAttribute('aria-label', t('settings.ics.actions.delete'));
  const delIcon = document.createElement('i');
  delIcon.setAttribute('data-lucide', 'trash-2');
  delIcon.className = 'icon-sm';
  delIcon.setAttribute('aria-hidden', 'true');
  delBtn.appendChild(delIcon);
  delBtn.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.ics.confirm_delete'), {
      danger: true,
      confirmLabel: t('common.delete'),
    })) return;
    try {
      await api.delete(`/calendar/subscriptions/${sub.id}`);
      const idx = subs.findIndex((s) => s.id === sub.id);
      if (idx >= 0) subs.splice(idx, 1);
      renderIcsList(container, subs, user);
      showToast(t('settings.ics.deletedToast'), 'default');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  actions.appendChild(delBtn);

  return actions;
}

function openIcsEditModal(container, sub, subs, user) {
  openModal({
    title: t('settings.ics.actions.edit'),
    size: 'sm',
    content: `
      <form id="ics-edit-form" class="settings-form">
        <div class="form-group">
          <label class="form-label" for="ics-edit-name">${t('settings.ics.form.name')}</label>
          <input class="form-input" type="text" id="ics-edit-name" value="${esc(sub.name)}" required maxlength="100" />
        </div>
        <div class="settings-name-color-row">
          <div class="form-group settings-color-field">
            <label class="form-label" for="ics-edit-color">${t('settings.ics.form.color')}</label>
            <input class="settings-color-button" type="color" id="ics-edit-color" value="${esc(sub.color) || '#3b82f6'}" />
          </div>
          <div class="form-group settings-color-field">
            <label class="toggle-row">
              <input type="checkbox" id="ics-edit-shared" ${sub.shared ? 'checked' : ''} />
              <span>${t('settings.ics.form.shared')}</span>
            </label>
          </div>
        </div>
        <div id="ics-edit-error" class="form-error" role="alert" hidden></div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="ics-edit-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary">${t('settings.ics.actions.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#ics-edit-cancel')?.addEventListener('click', () => closeModal());
      panel.querySelector('#ics-edit-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type=submit]');
        const errEl = panel.querySelector('#ics-edit-error');
        const name = panel.querySelector('#ics-edit-name').value.trim();
        const color = panel.querySelector('#ics-edit-color').value;
        const shared = panel.querySelector('#ics-edit-shared').checked ? 1 : 0;
        errEl.hidden = true;
        submitBtn.disabled = true;
        try {
          const res = await api.patch(`/calendar/subscriptions/${sub.id}`, { name, color, shared });
          const idx = subs.findIndex((s) => s.id === sub.id);
          if (idx >= 0) subs[idx] = res.data;
          renderIcsList(container, subs, user);
          showToast(t('settings.ics.updatedToast'), 'success');
          closeModal({ force: true });
        } catch (err) {
          errEl.textContent = err.message || t('common.errorGeneric');
          errEl.hidden = false;
          submitBtn.disabled = false;
        }
      });
    },
  });
}

function bindIcsEvents(container, subs, user) {
  const addBtn = container.querySelector('#ics-add-btn');
  const formWrapper = container.querySelector('#ics-add-form-wrapper');
  const addForm = container.querySelector('#ics-add-form');
  const cancelBtn = container.querySelector('#ics-cancel-btn');
  const submitBtn = container.querySelector('#ics-submit-btn');
  const errorEl = container.querySelector('#ics-add-error');

  addBtn?.addEventListener('click', () => {
    formWrapper.hidden = false;
    addBtn.hidden = true;
    container.querySelector('#ics-url')?.focus();
  });

  cancelBtn?.addEventListener('click', () => {
    formWrapper.hidden = true;
    addBtn.hidden = false;
    addForm?.reset();
    errorEl.hidden = true;
  });

  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const url = container.querySelector('#ics-url').value.trim();
    const name = container.querySelector('#ics-name').value.trim();
    const color = container.querySelector('#ics-color').value;
    const shared = container.querySelector('#ics-shared').checked ? 1 : 0;

    submitBtn.disabled = true;
    try {
      const res = await api.post('/calendar/subscriptions', { url, name, color, shared });
      subs.push(res.data);
      renderIcsList(container, subs, user);
      addForm.reset();
      formWrapper.hidden = true;
      addBtn.hidden = false;
      if (res.syncError) {
        showToast(`${t('settings.ics.status.syncError')}: ${res.syncError}`, 'danger');
      } else {
        showToast(t('settings.ics.addedToast'), 'success');
      }
    } catch (err) {
      errorEl.textContent = err.message || t('common.errorGeneric');
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// More providers (Google · Apple)
// --------------------------------------------------------------------------

function buildGoogleProvider(googleStatus, user) {
  const section = document.createElement('div');
  section.className = 'settings-card settings-provider';
  section.id = `${GOOGLE_PROVIDER_ID}-panel`;

  const header = document.createElement('div');
  header.className = 'settings-provider__header';
  const title = document.createElement('h4');
  title.className = 'settings-provider__name';
  title.textContent = t('settings.googleCalendar');
  const badge = document.createElement('span');
  badge.className = 'badge badge--neutral settings-provider__badge';
  badge.textContent = t('settings.providerSpecific');
  header.append(title, badge);
  section.appendChild(header);

  const status = document.createElement('p');
  status.className = 'settings-sync-info__status';
  status.textContent = providerConnectionStatus(googleStatus);
  section.appendChild(status);

  if (!googleStatus?.configured) {
    section.appendChild(buildProviderHint(t('settings.notConfigured')));
    return section;
  }

  if (googleStatus.connected && user?.role === 'admin') {
    section.appendChild(buildGoogleCalendarPicker());
    section.appendChild(buildGoogleReadonlyToggle(googleStatus));
  }

  const actions = document.createElement('div');
  actions.className = 'settings-sync-actions';
  if (googleStatus.connected) {
    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn btn--secondary';
    syncBtn.textContent = t('settings.syncNow');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = t('settings.synchronizing');
      try {
        await api.post('/calendar/google/sync', {});
        showToast(t('settings.syncSuccess', { provider: 'Google Calendar' }), 'success');
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t('settings.syncNow');
      }
    });
    actions.appendChild(syncBtn);

    if (user?.role === 'admin') {
      const disconnectBtn = document.createElement('button');
      disconnectBtn.type = 'button';
      disconnectBtn.className = 'btn btn--danger-outline';
      disconnectBtn.textContent = t('settings.disconnect');
      disconnectBtn.addEventListener('click', async () => {
        if (!await confirmModal(t('settings.googleDisconnectConfirm'), { danger: true })) return;
        try {
          await api.delete('/calendar/google/disconnect');
          showToast(t('settings.disconnectedToast', { provider: 'Google Calendar' }), 'default');
          window.oikos?.navigate('/settings/sync/calendar');
        } catch (err) {
          showToast(err.message || t('common.errorGeneric'), 'danger');
        }
      });
      actions.appendChild(disconnectBtn);
    }
  } else if (user?.role === 'admin') {
    const connect = document.createElement('a');
    connect.href = '/api/v1/calendar/google/auth';
    connect.className = 'btn btn--primary';
    connect.textContent = t('settings.connectGoogle');
    actions.appendChild(connect);
  } else {
    section.appendChild(buildProviderHint(t('settings.googleOnlyAdmin')));
  }
  if (actions.childElementCount) section.appendChild(actions);

  return section;
}

function buildProviderHint(text) {
  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = text;
  return hint;
}

function buildGoogleCalendarPicker() {
  const group = document.createElement('div');
  group.className = 'form-group settings-google-calendars';

  const label = document.createElement('label');
  label.className = 'form-label';
  label.textContent = t('settings.googleCalendarsSelect');
  group.appendChild(label);

  const list = document.createElement('div');
  list.className = 'google-calendars-list';
  const loading = document.createElement('p');
  loading.className = 'form-hint';
  loading.textContent = t('common.loading');
  list.appendChild(loading);
  group.appendChild(list);

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = t('settings.googleCalendarsSelectHint');
  group.appendChild(hint);

  (async () => {
    try {
      const { data } = await api.get('/calendar/google/calendars');
      const calendars = data || [];
      list.replaceChildren();
      for (const cal of calendars) {
        const item = document.createElement('label');
        item.className = 'caldav-calendar-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'google-calendar-checkbox';
        checkbox.checked = Boolean(cal.enabled);

        const dot = document.createElement('span');
        dot.className = 'caldav-calendar-color';
        dot.style.backgroundColor = cal.backgroundColor || 'var(--color-accent)';

        const name = document.createElement('span');
        name.className = 'caldav-calendar-name';
        name.textContent = cal.summary || cal.id;

        item.append(checkbox, dot, name);
        list.appendChild(item);

        checkbox.addEventListener('change', async () => {
          const enabled = checkbox.checked;
          checkbox.disabled = true;
          try {
            await api.patch('/calendar/google/calendars', { calendarId: cal.id, enabled });
            showToast(
              enabled ? t('settings.calendarEnabled') : t('settings.calendarDisabled'),
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
    } catch (err) {
      const p = document.createElement('p');
      p.className = 'form-hint';
      p.textContent = err.message || t('common.errorGeneric');
      list.replaceChildren(p);
    }
  })();

  return group;
}

function buildGoogleReadonlyToggle(googleStatus) {
  const group = document.createElement('div');
  group.className = 'form-group';

  const row = document.createElement('label');
  row.className = 'toggle-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = Boolean(googleStatus.readonly);

  const text = document.createElement('span');
  text.textContent = t('settings.googleReadonly');

  row.append(checkbox, text);
  group.appendChild(row);

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = t('settings.googleReadonlyHint');
  group.appendChild(hint);

  checkbox.addEventListener('change', async () => {
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    try {
      await api.put('/calendar/google/readonly', { readonly: enabled });
    } catch (err) {
      checkbox.checked = !enabled;
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      checkbox.disabled = false;
    }
  });

  return group;
}

function buildAppleProvider(appleStatus, user) {
  const section = document.createElement('div');
  section.className = 'settings-card settings-provider';
  section.id = `${APPLE_PROVIDER_ID}-panel`;

  const header = document.createElement('div');
  header.className = 'settings-provider__header';
  const title = document.createElement('h4');
  title.className = 'settings-provider__name';
  title.textContent = t('settings.appleCalendar');
  const badge = document.createElement('span');
  badge.className = 'badge badge--warning settings-provider__badge settings-legacy-badge';
  badge.textContent = t('settings.legacy');
  header.append(title, badge);
  section.appendChild(header);

  const status = document.createElement('p');
  status.className = 'settings-sync-info__status';
  status.textContent = providerConnectionStatus(appleStatus);
  section.appendChild(status);

  const legacyHint = document.createElement('p');
  legacyHint.className = 'form-hint settings-legacy-hint';
  legacyHint.textContent = t('settings.appleLegacyHint');
  section.appendChild(legacyHint);

  if (appleStatus?.configured) {
    const actions = document.createElement('div');
    actions.className = 'settings-sync-actions';

    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn btn--secondary';
    syncBtn.textContent = t('settings.syncNow');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = t('settings.synchronizing');
      try {
        await api.post('/calendar/apple/sync', {});
        showToast(t('settings.syncSuccess', { provider: 'Apple Calendar' }), 'success');
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t('settings.syncNow');
      }
    });
    actions.appendChild(syncBtn);

    if (appleStatus.connected && user?.role === 'admin') {
      const disconnectBtn = document.createElement('button');
      disconnectBtn.type = 'button';
      disconnectBtn.className = 'btn btn--danger-outline';
      disconnectBtn.textContent = t('settings.disconnect');
      disconnectBtn.addEventListener('click', async () => {
        if (!await confirmModal(t('settings.appleDisconnectConfirm'), { danger: true })) return;
        try {
          await api.delete('/calendar/apple/disconnect');
          showToast(t('settings.disconnectedToast', { provider: 'Apple Calendar' }), 'default');
          window.oikos?.navigate('/settings/sync/calendar');
        } catch (err) {
          showToast(err.message || t('common.errorGeneric'), 'danger');
        }
      });
      actions.appendChild(disconnectBtn);
    }
    section.appendChild(actions);
  } else if (user?.role === 'admin') {
    section.appendChild(buildAppleConnectForm());
  } else {
    section.appendChild(buildProviderHint(t('settings.appleOnlyAdmin')));
  }

  return section;
}

function buildAppleConnectForm() {
  const form = document.createElement('form');
  form.className = 'settings-form settings-form--compact';
  form.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="apple-caldav-url">${t('settings.caldavUrlLabel')}</label>
      <input class="form-input" type="url" id="apple-caldav-url" placeholder="${t('settings.caldavUrlPlaceholder')}" required />
    </div>
    <div class="form-group">
      <label class="form-label" for="apple-username">${t('settings.appleIdLabel')}</label>
      <input class="form-input" type="email" id="apple-username" autocomplete="username" required />
    </div>
    <div class="form-group">
      <label class="form-label" for="apple-password">${t('settings.applePasswordLabel')}</label>
      <input class="form-input" type="password" id="apple-password" autocomplete="current-password" required />
      <span class="form-hint">${t('settings.applePasswordHint')}</span>
    </div>
    <div id="apple-connect-error" class="form-error" role="alert" hidden></div>
    <button type="submit" class="btn btn--primary" id="apple-connect-btn">${t('settings.appleConnectBtn')}</button>
  `);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = form.querySelector('#apple-connect-error');
    errorEl.hidden = true;
    const url = form.querySelector('#apple-caldav-url').value.trim();
    const username = form.querySelector('#apple-username').value.trim();
    const password = form.querySelector('#apple-password').value;
    const btn = form.querySelector('#apple-connect-btn');

    btn.disabled = true;
    btn.textContent = t('settings.appleConnecting');
    try {
      await api.post('/calendar/apple/connect', { url, username, password });
      showToast(t('settings.appleConnectedToast'), 'success');
      window.oikos?.navigate('/settings/sync/calendar');
    } catch (err) {
      errorEl.textContent = err.message || t('common.errorGeneric');
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = t('settings.appleConnectBtn');
    }
  });

  return form;
}

async function renderMoreProviders(container, user) {
  const host = container.querySelector('#sync-more-providers-container');
  if (!host) return;

  let googleStatus = null;
  let appleStatus = null;
  const [gRes, aRes] = await Promise.allSettled([
    api.get('/calendar/google/status'),
    api.get('/calendar/apple/status'),
  ]);
  if (gRes.status === 'fulfilled') googleStatus = gRes.value;
  if (aRes.status === 'fulfilled') appleStatus = aRes.value;

  const panel = document.createElement('div');
  panel.className = 'settings-providers';
  panel.appendChild(buildGoogleProvider(googleStatus, user));
  panel.appendChild(buildAppleProvider(appleStatus, user));

  const disclosure = createDisclosure({
    id: MORE_PROVIDERS_ID,
    summary: t('settings.moreProviders'),
    expanded: false,
    content: panel,
  });
  host.replaceChildren(disclosure);
  window.lucide?.createIcons({ el: host });
}

// --------------------------------------------------------------------------
// Read-only ICS export feed
// --------------------------------------------------------------------------

function renderFeedExportInactive(body) {
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <p class="settings-card-description">${t('settings.feedExportInactive')}</p>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--primary" id="feed-activate">${t('settings.feedExportActivate')}</button>
    </div>
  `);
}

function renderFeedExportActive(body, data) {
  const webcal = data.url.replace(/^https?:\/\//i, 'webcal://');
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="feed-url">${t('settings.feedExportUrlLabel')}</label>
      <input id="feed-url" class="form-input" type="text" readonly value="${esc(data.url)}">
      <p class="form-hint">${t('settings.feedExportHint')}</p>
    </div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" id="feed-copy">${t('settings.feedExportCopy')}</button>
      <a class="btn btn--secondary" href="${esc(webcal)}">${t('settings.feedExportSubscribe')}</a>
      <button type="button" class="btn btn--secondary" id="feed-regen">${t('settings.feedExportRegenerate')}</button>
      <button type="button" class="btn btn--danger-outline" id="feed-disable">${t('settings.feedExportDisable')}</button>
    </div>
  `);
}

async function loadFeedExport(container, user) {
  const body = container.querySelector('#feed-export-body');
  if (!body) return;

  const reload = () => loadFeedExport(container, user);

  let res;
  try {
    res = await api.get('/calendar/feed');
  } catch (err) {
    body.replaceChildren();
    body.appendChild(createInlineError(err.message || t('common.errorGeneric')));
    return;
  }

  const data = res?.data;
  if (!data) {
    renderFeedExportInactive(body);
    body.querySelector('#feed-activate')?.addEventListener('click', async () => {
      try {
        await api.post('/calendar/feed/regenerate');
        showToast(t('settings.feedExportTitle'), 'success');
        await reload();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    return;
  }

  renderFeedExportActive(body, data);

  body.querySelector('#feed-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText(data.url);
      showToast(t('settings.feedExportCopied'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#feed-regen')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.feedExportRegenerateConfirm'), { danger: true })) return;
    try {
      await api.post('/calendar/feed/regenerate');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#feed-disable')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.feedExportDisableConfirm'), { danger: true })) return;
    try {
      await api.delete('/calendar/feed');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
}

// --------------------------------------------------------------------------
// OAuth callback banner
// --------------------------------------------------------------------------

function expandMoreProviders(container, provider) {
  const trigger = container.querySelector(`#${MORE_PROVIDERS_ID}-trigger`);
  const panel = container.querySelector(`#${MORE_PROVIDERS_ID}-panel`);
  if (trigger && panel) {
    trigger.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    trigger.focus({ preventScroll: true });
  }
  const providerPanelId = provider === 'apple'
    ? `${APPLE_PROVIDER_ID}-panel`
    : `${GOOGLE_PROVIDER_ID}-panel`;
  container.querySelector(`#${providerPanelId}`)?.scrollIntoView({ block: 'nearest' });
}

function handleOAuthCallback(container, query) {
  const params = query instanceof URLSearchParams
    ? query
    : new URLSearchParams(query || '');
  const syncOk = params.get('sync_ok');
  const syncErr = params.get('sync_error');
  if (!syncOk && !syncErr) return;

  const banner = container.querySelector('#sync-calendar-banner');
  if (banner) {
    const provider = syncOk || syncErr;
    const message = syncOk
      ? (syncOk === 'google' ? t('settings.syncSuccessGoogle') : t('settings.syncSuccessApple'))
      : (syncErr === 'google' ? t('settings.syncErrorGoogle') : t('settings.syncErrorApple'));
    const el = document.createElement('div');
    el.className = `settings-banner ${syncOk ? 'settings-banner--success' : 'settings-banner--error'}`;
    el.setAttribute('role', syncOk ? 'status' : 'alert');
    el.textContent = message;
    banner.replaceChildren(el);
    expandMoreProviders(container, provider);
  }

  // Strip only the OAuth callback parameters, keep everything else.
  try {
    const url = new URL(location.href);
    url.searchParams.delete('sync_ok');
    url.searchParams.delete('sync_error');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch {
    // location parsing can fail in restricted contexts; ignore.
  }
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

export async function render(container, { user, query } = {}) {
  renderPage(container, user);
  bindCalDAVAddButton(container, user);

  let icsSubs = [];
  const [icsRes] = await Promise.allSettled([api.get('/calendar/subscriptions')]);
  if (icsRes.status === 'fulfilled') icsSubs = icsRes.value.data || [];
  renderIcsList(container, icsSubs, user);
  bindIcsEvents(container, icsSubs, user);

  await loadCalDAVAccounts(container, user);
  await renderMoreProviders(container, user);
  await loadFeedExport(container, user);

  handleOAuthCallback(container, query);

  window.lucide?.createIcons({ el: container });
}
