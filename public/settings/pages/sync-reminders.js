import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import {
  createInlineError,
  createRetryState,
  createSettingRow,
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

function enabledReminderListCount(lists) {
  return lists.filter((list) => list.enabled).length;
}

function showToast(message, tone = 'default') {
  window.oikos?.showToast(message, tone);
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.caldavRemindersToggle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.caldavRemindersHint')}</p>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--primary" id="reminders-sync-btn">
            ${t('settings.caldavSyncReminders')}
          </button>
        </div>
        <div id="reminders-accounts" class="settings-sync-accounts"></div>
      </div>
    </section>
  `);
}

function buildTargetSelect(account, list) {
  const select = document.createElement('select');
  select.className = 'form-input caldav-reminder-module';

  const tasksOption = document.createElement('option');
  tasksOption.value = 'tasks';
  tasksOption.textContent = t('settings.caldavReminderMapTasks');
  tasksOption.selected = list.targetModule === 'tasks';

  const shoppingOption = document.createElement('option');
  shoppingOption.value = 'shopping';
  shoppingOption.textContent = t('settings.caldavReminderMapShopping');
  shoppingOption.selected = list.targetModule === 'shopping';

  select.append(tasksOption, shoppingOption);

  select.addEventListener('change', async () => {
    const previous = list.targetModule;
    select.disabled = true;
    try {
      await api.patch(`/calendar/caldav/accounts/${account.id}/reminder-lists`, {
        listUrl: list.listUrl,
        targetModule: select.value,
      });
      list.targetModule = select.value;
      showToast(t('settings.reminderMapUpdated'), 'success');
    } catch (err) {
      select.value = previous ?? 'tasks';
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      select.disabled = false;
    }
  });

  return select;
}

function buildReminderRow(account, list) {
  const wrapper = document.createElement('div');
  wrapper.className = 'caldav-reminder-item';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'caldav-reminder-checkbox';
  toggle.checked = Boolean(list.enabled);

  const select = buildTargetSelect(account, list);

  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    toggle.disabled = true;
    try {
      await api.patch(`/calendar/caldav/accounts/${account.id}/reminder-lists`, {
        listUrl: list.listUrl,
        enabled,
        targetModule: select.value,
      });
      list.enabled = enabled;
      showToast(
        enabled ? t('settings.reminderListEnabled') : t('settings.reminderListDisabled'),
        'success',
      );
    } catch (err) {
      toggle.checked = !enabled;
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      toggle.disabled = false;
    }
  });

  const row = createSettingRow({
    label: list.listName,
    control: toggle,
  });
  wrapper.append(row, select);
  return wrapper;
}

function renderAccount(container, account, reminderLists, refresh) {
  const card = document.createElement('article');
  card.className = 'caldav-account-item';

  const details = [];
  if (account.caldav_url) details.push(account.caldav_url);
  details.push(lastSyncDetail(account.last_sync));

  card.appendChild(createStatusSummary({
    title: account.name,
    status: t('settings.enabledReminderListCount', {
      count: enabledReminderListCount(reminderLists),
    }),
    details,
  }));

  const list = document.createElement('div');
  list.className = 'caldav-calendars-list';
  if (reminderLists.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-card-description';
    empty.textContent = t('settings.caldavRemindersEmpty');
    list.appendChild(empty);
  } else {
    for (const reminderList of reminderLists) {
      list.appendChild(buildReminderRow(account, reminderList));
    }
  }
  card.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'caldav-account-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn btn--secondary btn--sm';
  refreshBtn.textContent = t('settings.caldavRefreshReminders');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await api.get(`/calendar/caldav/accounts/${account.id}/reminder-lists?refresh=true`);
      showToast(t('settings.reminderListsRefreshed'), 'success');
      await refresh();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
      refreshBtn.disabled = false;
    }
  });
  actions.appendChild(refreshBtn);

  card.appendChild(actions);
  container.appendChild(card);
}

async function loadAccounts(container) {
  const listEl = container.querySelector('#reminders-accounts');
  if (!listEl) return;
  listEl.replaceChildren();

  const reload = () => loadAccounts(container);

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
    let reminderLists = [];
    try {
      const remindersRes = await api.get(`/calendar/caldav/accounts/${account.id}/reminder-lists`);
      reminderLists = remindersRes.data || [];
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
    renderAccount(listEl, account, reminderLists, reload);
  }
}

function bindSyncButton(container) {
  const syncBtn = container.querySelector('#reminders-sync-btn');
  if (!syncBtn) return;
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      await api.post('/calendar/caldav/reminders/sync');
      showToast(t('settings.reminderSyncSuccess'), 'success');
      await loadAccounts(container);
    } catch (err) {
      showToast(err.message || t('settings.reminderSyncFailed'), 'danger');
    } finally {
      syncBtn.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  void user;
  renderPage(container);
  bindSyncButton(container);
  await loadAccounts(container);
  window.lucide?.createIcons({ el: container });
}
