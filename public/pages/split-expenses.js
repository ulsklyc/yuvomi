/**
 * Module: Split Expenses
 * Purpose: Mobile-first shared expense groups, balances, settlements, and activity.
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, confirmModal } from '/components/modal.js';
import { t, formatDate, getLocale, dateInputPlaceholder, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';
import { stagger } from '/utils/ux.js';

let state = {
  meta: null,
  dashboard: null,
  groups: [],
  members: [],
  groupMembers: [],
  memberCandidates: [],
  activeGroupId: null,
  expenses: [],
  balances: { balances: [], simplified_debts: [] },
  activity: [],
  query: '',
  category: '',
  user: null,
};
let _container = null;

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('beforeend', html);
}

function money(amount, currency) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency }).format(n);
}

function groupIcon(type) {
  return {
    household: 'home',
    couple: 'heart',
    travel: 'plane',
    event: 'party-popper',
    shopping: 'shopping-cart',
    general: 'users',
  }[type] || 'users';
}

export async function render(container, { user } = {}) {
  _container = container;
  state.user = user || null;
  setHtml(container, `
    <div class="split-page">
      <header class="split-topbar">
        <div>
          <h1 class="split-title">${t('splitExpenses.title')}</h1>
          <p class="split-subtitle">${t('splitExpenses.subtitle')}</p>
        </div>
        <button class="btn btn--primary" id="split-add-expense">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.addExpense')}
        </button>
      </header>
      <section class="split-summary" id="split-summary"></section>
      <div class="split-layout">
        <aside class="split-groups-panel">
          <div class="split-panel-head">
            <div class="split-panel-title">${t('splitExpenses.groups')}</div>
            <button class="btn btn--icon" id="split-add-group" aria-label="${t('splitExpenses.addGroup')}" ${isSplitGuest() ? 'hidden' : ''}>
              <i data-lucide="plus" aria-hidden="true"></i>
            </button>
          </div>
          <div class="split-search">
            <i data-lucide="search" aria-hidden="true"></i>
            <input id="split-group-search" type="search" placeholder="${t('splitExpenses.searchGroups')}" autocomplete="off">
          </div>
          <div class="split-groups" id="split-groups"></div>
        </aside>
        <main class="split-main" id="split-main"></main>
      </div>
      <button class="page-fab" id="split-fab" aria-label="${t('splitExpenses.addExpense')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: _container });
  await loadInitial();
  bindShell();
  renderAll();
}

async function loadInitial() {
  const calls = [
    api.get('/split-expenses/meta'),
    api.get('/split-expenses/dashboard'),
    api.get('/split-expenses/groups'),
  ];
  if (!isSplitGuest()) calls.push(api.get('/family/members'));
  const [meta, dashboard, groups, members] = await Promise.all(calls);
  state.meta = meta.data;
  state.dashboard = dashboard.data;
  state.groups = groups.data || [];
  state.members = members?.data || [];
  state.activeGroupId = state.groups[0]?.id || null;
  if (state.activeGroupId) await loadGroupData();
}

function isSplitGuest() {
  return state.user?.access_scope === 'split_guest';
}

async function loadGroups() {
  const res = await api.get(`/split-expenses/groups?q=${encodeURIComponent(state.query)}`);
  state.groups = res.data || [];
  if (!state.activeGroupId || !state.groups.some((g) => g.id === state.activeGroupId)) {
    state.activeGroupId = state.groups[0]?.id || null;
  }
}

async function loadGroupData() {
  if (!state.activeGroupId) {
    state.expenses = [];
    state.balances = { balances: [], simplified_debts: [] };
    state.activity = [];
    return;
  }
  const params = new URLSearchParams();
  if (state.category) params.set('category', state.category);
  const [expenses, balances, activity, groupMembers] = await Promise.all([
    api.get(`/split-expenses/groups/${state.activeGroupId}/expenses?${params.toString()}`),
    api.get(`/split-expenses/groups/${state.activeGroupId}/balances`),
    api.get(`/split-expenses/groups/${state.activeGroupId}/activity?limit=12`),
    api.get(`/split-expenses/groups/${state.activeGroupId}/members`),
  ]);
  state.expenses = expenses.data || [];
  state.balances = balances.data || { balances: [], simplified_debts: [] };
  state.activity = activity.data || [];
  state.groupMembers = groupMembers.data || [];
}

async function loadMemberCandidates() {
  if (isSplitGuest() || !state.activeGroupId) {
    state.memberCandidates = [];
    return [];
  }
  const res = await api.get(`/split-expenses/groups/${state.activeGroupId}/member-candidates`);
  state.memberCandidates = res.data || [];
  return state.memberCandidates;
}

function bindShell() {
  _container.querySelector('#split-add-group')?.addEventListener('click', () => openGroupModal());
  _container.querySelector('#split-add-expense')?.addEventListener('click', () => openExpenseModal());
  _container.querySelector('#split-fab')?.addEventListener('click', () => openExpenseModal());
  let groupSearchTimer;
  _container.querySelector('#split-group-search')?.addEventListener('input', (e) => {
    const value = e.target.value.trim();
    clearTimeout(groupSearchTimer);
    groupSearchTimer = setTimeout(async () => {
      state.query = value;
      await loadGroups();
      await loadGroupData();
      renderAll();
    }, 250);
  });
  _container.querySelector('#split-groups')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-group-id]');
    if (!btn) return;
    state.activeGroupId = Number(btn.dataset.groupId);
    await loadGroupData();
    renderAll();
  });
}

function renderAll() {
  renderSummary();
  renderGroups();
  renderMain();
  if (window.lucide) lucide.createIcons({ el: _container });
}

function renderSummary() {
  const summary = _container.querySelector('#split-summary');
  const owed = state.dashboard?.total_owed || [];
  const owing = state.dashboard?.total_owing || [];
  setHtml(summary, `
    <div class="split-summary-card split-summary-card--positive">
      <span>${t('splitExpenses.youAreOwed')}</span>
      <strong>${owed.length ? owed.map((r) => money(r.amount, r.currency)).join(' · ') : money(0, state.meta.default_currency)}</strong>
    </div>
    <div class="split-summary-card split-summary-card--negative">
      <span>${t('splitExpenses.youOwe')}</span>
      <strong>${owing.length ? owing.map((r) => money(r.amount, r.currency)).join(' · ') : money(0, state.meta.default_currency)}</strong>
    </div>
    <div class="split-summary-card">
      <span>${t('splitExpenses.activeGroups')}</span>
      <strong>${state.groups.length}</strong>
    </div>
  `);
}

function renderGroups() {
  const el = _container.querySelector('#split-groups');
  if (!state.groups.length) {
    setHtml(el, `
      <div class="empty-state split-empty-inline">
        <i data-lucide="receipt-text" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${t('splitExpenses.emptyGroupsTitle')}</div>
        <div class="empty-state__description">${t('splitExpenses.emptyGroupsText')}</div>
      </div>
    `);
    return;
  }
  setHtml(el, state.groups.map((group) => `
    <button class="split-group ${group.id === state.activeGroupId ? 'split-group--active' : ''}" type="button" data-group-id="${group.id}">
      <span class="split-group__avatar"><i data-lucide="${groupIcon(group.type)}" aria-hidden="true"></i></span>
      <span class="split-group__body">
        <span class="split-group__name">${esc(group.name)}</span>
        <span class="split-group__meta">${t(`splitExpenses.groupType.${group.type}`)} · ${group.member_count} ${t('splitExpenses.members')}</span>
      </span>
    </button>
  `).join(''));
}

function renderMain() {
  const main = _container.querySelector('#split-main');
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  if (!group) {
    setHtml(main, `
      <div class="empty-state split-main-empty">
        <i data-lucide="users-round" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${t('splitExpenses.emptyGroupsTitle')}</div>
        <div class="empty-state__description">${t('splitExpenses.emptyGroupsText')}</div>
      </div>
    `);
    return;
  }
  setHtml(main, `
    <section class="split-group-header">
      <div>
        <div class="split-kicker">${t(`splitExpenses.groupType.${group.type}`)}</div>
        <h2>${esc(group.name)}</h2>
        <p>${esc(group.description || t('splitExpenses.groupDefaultDescription'))}</p>
      </div>
      <div class="split-header-actions">
        ${isSplitGuest() ? '' : `
        <button class="btn btn--secondary btn--icon" id="split-edit-group" aria-label="${t('splitExpenses.editGroup')}">
          <i data-lucide="pencil" aria-hidden="true"></i>
        </button>
        <button class="btn btn--secondary btn--icon" id="split-archive-group" aria-label="${t('splitExpenses.archiveGroup')}">
          <i data-lucide="archive" aria-hidden="true"></i>
        </button>
        <button class="btn btn--secondary btn--icon" id="split-delete-group" aria-label="${t('splitExpenses.deleteGroup')}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>`}
        <button class="btn btn--secondary" id="split-settle">
          <i data-lucide="hand-coins" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.settle')}
        </button>
        <button class="btn btn--secondary" id="split-invite" ${isSplitGuest() ? 'hidden' : ''}>
          <i data-lucide="user-plus" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.addMember')}
        </button>
      </div>
    </section>
    <div class="split-content-grid">
      <section class="split-card split-card--balances">
        <div class="split-card-head">
          <h3>${t('splitExpenses.balances')}</h3>
          <span>${t('splitExpenses.simplified')}</span>
        </div>
        <div id="split-balances">${renderBalances()}</div>
      </section>
      <section class="split-card">
        <div class="split-card-head">
          <h3>${t('splitExpenses.recentExpenses')}</h3>
        </div>
        <div id="split-expense-list">${renderExpenses()}</div>
      </section>
      <section class="split-card">
        <div class="split-card-head">
          <h3>${t('splitExpenses.activity')}</h3>
        </div>
        <div class="split-activity">${renderActivity()}</div>
      </section>
    </div>
  `);
  main.querySelector('#split-edit-group')?.addEventListener('click', () => openGroupModal(group));
  main.querySelector('#split-archive-group')?.addEventListener('click', () => archiveGroup(group.id));
  main.querySelector('#split-delete-group')?.addEventListener('click', () => deleteGroup(group.id));
  main.querySelector('#split-settle')?.addEventListener('click', () => openSettlementModal());
  const settleButton = main.querySelector('#split-settle');
  if (settleButton) settleButton.disabled = state.expenses.length === 0;
  main.querySelector('#split-invite')?.addEventListener('click', () => openMemberModal());
  stagger(main.querySelectorAll('.split-expense, .split-debt, .split-activity-item'));
}

function renderBalances() {
  const debts = state.balances.simplified_debts || [];
  if (!debts.length) return `<div class="split-muted">${t('splitExpenses.noBalances')}</div>`;
  return debts.map((debt) => `
    <div class="split-debt">
      <span>${esc(debt.from_name)} ${t('splitExpenses.owes')} ${esc(debt.to_name)}</span>
      <strong>${money(debt.amount, debt.currency)}</strong>
    </div>
  `).join('');
}

function renderExpenses() {
  if (!state.expenses.length) return `<div class="split-muted">${t('splitExpenses.noExpenses')}</div>`;
  return state.expenses.map((expense) => `
    <article class="split-expense">
      <div class="split-expense__icon"><i data-lucide="${categoryIcon(expense.category)}" aria-hidden="true"></i></div>
      <div class="split-expense__body">
        <strong>${esc(expense.title)}</strong>
        <span>${t('splitExpenses.paidBy')}: ${esc(expense.payer_name || '')} · ${formatDate(expense.expense_date)}</span>
      </div>
      <div class="split-expense__amount">${money(expense.amount, expense.currency)}</div>
    </article>
  `).join('');
}

function renderActivity() {
  if (!state.activity.length) return `<div class="split-muted">${t('splitExpenses.noActivity')}</div>`;
  return state.activity.map((item) => `
    <div class="split-activity-item">
      <span class="split-activity-dot"></span>
      <div>
        <strong>${t(`splitExpenses.activityType.${item.type}`) || item.type}</strong>
        <span>${esc(item.actor_name || t('splitExpenses.system'))} · ${formatDate(item.created_at.slice(0, 10))}</span>
      </div>
    </div>
  `).join('');
}

function categoryIcon(category) {
  return {
    groceries: 'shopping-basket',
    rent: 'home',
    utilities: 'plug-zap',
    baby: 'baby',
    pets: 'paw-print',
    school: 'graduation-cap',
    travel: 'plane',
    shopping: 'shopping-bag',
    subscriptions: 'badge-dollar-sign',
    health: 'heart-pulse',
    home: 'sofa',
    general: 'receipt',
  }[category] || 'receipt';
}

async function archiveGroup(groupId) {
  const confirmed = await confirmModal(t('splitExpenses.archiveGroupConfirm'), {
    confirmLabel: t('splitExpenses.archiveGroup'),
  });
  if (!confirmed) return;
  await api.post(`/split-expenses/groups/${groupId}/archive`, {});
  await loadGroups();
  await loadGroupData();
  renderAll();
}

async function deleteGroup(groupId) {
  const confirmed = await confirmModal(t('splitExpenses.deleteGroupConfirm'), {
    danger: true,
    confirmLabel: t('splitExpenses.deleteGroup'),
  });
  if (!confirmed) return;
  await api.delete(`/split-expenses/groups/${groupId}`);
  await loadGroups();
  await loadGroupData();
  renderAll();
}

function memberOptions(selectedId = '', source = state.groupMembers.length ? state.groupMembers : state.members) {
  return source.map((member) => {
    const id = member.id ?? member.user_id;
    return `<option value="${id}" ${String(id) === String(selectedId) ? 'selected' : ''}>${esc(member.display_name)}</option>`;
  }).join('');
}

function memberCandidateOptions(candidates = []) {
  return candidates
    .filter((candidate) => !candidate.in_group)
    .map((candidate) => {
      const value = candidate.source === 'contact' ? `contact:${candidate.contact_id}` : `user:${candidate.user_id}`;
      const suffix = candidate.source === 'contact' ? ` · ${t('nav.contacts')}` : '';
      return `<option value="${esc(value)}">${esc(candidate.display_name)}${suffix}</option>`;
    }).join('');
}

function groupMemberCheckboxes() {
  const members = state.groupMembers.length ? state.groupMembers : state.members;
  return members.map((member) => {
    const id = member.id ?? member.user_id;
    return `
    <div class="split-participant-row" data-participant-row="${id}">
      <label class="split-check">
        <input type="checkbox" name="participants" value="${id}" checked>
        <span>${esc(member.display_name)}</span>
      </label>
      <input class="input split-split-value" name="split_value_${id}" inputmode="decimal" aria-label="${esc(member.display_name)} ${t('splitExpenses.splitValue')}" placeholder="">
    </div>
  `;
  }).join('');
}

function updateSplitInputs(panel) {
  const method = panel.querySelector('[name="split_method"]')?.value || 'equal';
  panel.querySelectorAll('.split-split-value').forEach((input) => {
    input.hidden = method === 'equal';
    input.required = method !== 'equal';
    if (method === 'percentage') input.placeholder = '30';
    else if (method === 'exact') input.placeholder = '70.00';
    else if (method === 'shares') input.placeholder = '1';
    else input.placeholder = '';
  });
  const hint = panel.querySelector('#split-method-hint');
  validateSplitForm(panel);
}

function numberValue(value) {
  const normalized = String(value || '').trim().replace(',', '.');
  if (!normalized) return NaN;
  return Number(normalized);
}

function validateSplitForm(panel) {
  const method = panel.querySelector('[name="split_method"]')?.value || 'equal';
  const amount = numberValue(panel.querySelector('[name="amount"]')?.value);
  const selected = [...panel.querySelectorAll('input[name="participants"]:checked')];
  let valid = selected.length > 0 && Number.isFinite(amount) && amount > 0;
  let message = t(`splitExpenses.splitHint.${method}`);
  if (valid && method === 'percentage') {
    const total = selected.reduce((sum, input) => sum + (numberValue(panel.querySelector(`[name="split_value_${input.value}"]`)?.value) || 0), 0);
    valid = Math.abs(total - 100) < 0.01;
    message = `${message} ${t('splitExpenses.splitCurrentTotal', { total: total.toFixed(2) })}`;
  } else if (valid && method === 'exact') {
    const total = selected.reduce((sum, input) => sum + (numberValue(panel.querySelector(`[name="split_value_${input.value}"]`)?.value) || 0), 0);
    valid = Math.abs(total - amount) < 0.01;
    message = `${message} ${t('splitExpenses.splitCurrentTotal', { total: total.toFixed(2) })}`;
  } else if (valid && method === 'shares') {
    valid = selected.every((input) => {
      const value = numberValue(panel.querySelector(`[name="split_value_${input.value}"]`)?.value);
      return Number.isInteger(value) && value > 0;
    });
  }
  const hint = panel.querySelector('#split-method-hint');
  if (hint) hint.textContent = message;
  const save = panel.querySelector('#split-save-expense');
  if (save) save.disabled = !valid;
  return valid;
}

function formatDateWhileTyping(value) {
  const placeholder = dateInputPlaceholder();
  const separator = placeholder.includes('/') ? '/' : placeholder.includes('.') ? '.' : '-';
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  if (placeholder.startsWith('YYYY')) {
    if (digits.length <= 4) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 4)}${separator}${digits.slice(4)}`;
    return `${digits.slice(0, 4)}${separator}${digits.slice(4, 6)}${separator}${digits.slice(6)}`;
  }
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}${separator}${digits.slice(2)}`;
  return `${digits.slice(0, 2)}${separator}${digits.slice(2, 4)}${separator}${digits.slice(4)}`;
}

function collectSplitPayload(form) {
  const method = form.querySelector('[name="split_method"]')?.value || 'equal';
  const participants = [...form.querySelectorAll('input[name="participants"]:checked')].map((input) => Number(input.value));
  if (method === 'equal') return { participants, splits: [] };
  const splits = participants.map((userId) => {
    const value = form.querySelector(`[name="split_value_${userId}"]`)?.value.trim() || '';
    if (method === 'percentage') return { user_id: userId, percentage: value };
    if (method === 'exact') return { user_id: userId, amount: value };
    return { user_id: userId, shares: Number(value) };
  });
  return { participants, splits };
}

function renderGroupMemberEditor(candidates = []) {
  if (!candidates.length) return '';
  return `
    <fieldset class="split-participants">
      <legend>${t('splitExpenses.members')}</legend>
      ${candidates.map((candidate) => {
        const key = candidate.source === 'contact' ? `contact:${candidate.contact_id}` : `user:${candidate.user_id}`;
        const locked = candidate.group_role === 'owner';
        const badge = candidate.source === 'contact' ? ` · ${t('nav.contacts')}` : '';
        return `
          <label class="split-check">
            <input type="checkbox" name="group_members" value="${esc(key)}" ${candidate.in_group ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            <span>${esc(candidate.display_name)}${badge}${candidate.group_role === 'guest' ? ` · ${t('splitExpenses.roleGuest')}` : ''}</span>
          </label>
        `;
      }).join('')}
    </fieldset>
  `;
}

async function syncEditedGroupMembers(group, form) {
  if (!group) return;
  const selected = new Set([...form.querySelectorAll('input[name="group_members"]:checked')].map((input) => input.value));
  const candidates = state.memberCandidates || [];
  const currentUserIds = new Set(state.groupMembers.map((member) => Number(member.user_id)));
  for (const candidate of candidates) {
    if (candidate.source === 'user') {
      const userId = Number(candidate.user_id);
      const selectedKey = `user:${userId}`;
      if (selected.has(selectedKey) && !currentUserIds.has(userId)) {
        await api.post(`/split-expenses/groups/${group.id}/members`, { user_id: userId, role: 'guest' });
      } else if (!selected.has(selectedKey) && currentUserIds.has(userId) && candidate.group_role !== 'owner') {
        await api.delete(`/split-expenses/groups/${group.id}/members/${userId}`);
      }
    } else if (candidate.source === 'contact') {
      const selectedKey = `contact:${candidate.contact_id}`;
      if (selected.has(selectedKey)) {
        await api.post(`/split-expenses/groups/${group.id}/members`, { contact_id: candidate.contact_id, role: 'guest' });
      }
    }
  }
}

async function openGroupModal(group = null) {
  const currency = state.meta?.default_currency || 'EUR';
  const isEdit = Boolean(group);
  const candidates = isEdit ? await loadMemberCandidates() : [];
  openSharedModal({
    title: isEdit ? t('splitExpenses.editGroup') : t('splitExpenses.addGroup'),
    content: `
      <form id="split-group-form" class="split-form">
        <label>${t('splitExpenses.name')}<input class="input" name="name" required maxlength="200" value="${esc(group?.name || '')}"></label>
        <label>${t('splitExpenses.description')}<textarea class="input" name="description" rows="3" maxlength="5000">${esc(group?.description || '')}</textarea></label>
        <label>${t('splitExpenses.type')}<select class="input" name="type">${state.meta.group_types.map((type) => `<option value="${type}" ${type === group?.type ? 'selected' : ''}>${t(`splitExpenses.groupType.${type}`)}</option>`).join('')}</select></label>
        <label>${t('splitExpenses.currency')}<select class="input" name="default_currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === (group?.default_currency || currency) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        ${isEdit ? renderGroupMemberEditor(candidates) : ''}
        <div class="modal-actions">
          <button class="btn btn--secondary" type="button" id="split-cancel-group">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-group">${t('common.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-group')?.addEventListener('click', () => closeModal());
      panel.querySelector('#split-group-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = panel.querySelector('#split-group-form');
        const data = Object.fromEntries(new FormData(form));
        if (isEdit) await api.patch(`/split-expenses/groups/${group.id}`, data);
        else await api.post('/split-expenses/groups', data);
        if (isEdit) await syncEditedGroupMembers(group, form);
        closeModal({ force: true });
        await loadGroups();
        await loadGroupData();
        renderAll();
      });
    },
  });
}

function openExpenseModal(prefill = {}) {
  if (!state.activeGroupId) return openGroupModal();
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  openSharedModal({
    title: t('splitExpenses.addExpense'),
    content: `
      <form id="split-expense-form" class="split-form">
        <label>${t('splitExpenses.titleLabel')}<input class="input" name="title" required maxlength="200" value="${esc(prefill.title || '')}"></label>
        <div class="split-form-row">
          <label>${t('splitExpenses.amount')}<input class="input" name="amount" inputmode="decimal" placeholder="42.50" required></label>
          <label>${t('splitExpenses.paidBy')}<select class="input" name="payer_id">${memberOptions(state.user?.id)}</select></label>
        </div>
        <div class="split-form-row">
          <label>${t('splitExpenses.currency')}<select class="input" name="currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === group.default_currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <label>${t('splitExpenses.date')}<input class="input" name="expense_date" type="date" value="${(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()}"></label>
        </div>
        <label>${t('splitExpenses.splitMethod')}<select class="input" name="split_method">
          <option value="equal">${t('splitExpenses.splitEqual')}</option>
          <option value="percentage">${t('splitExpenses.splitPercentage')}</option>
          <option value="exact">${t('splitExpenses.splitExact')}</option>
          <option value="shares">${t('splitExpenses.splitShares')}</option>
        </select></label>
        <p class="form-hint" id="split-method-hint">${t('splitExpenses.splitHint.equal')}</p>
        <fieldset class="split-participants"><legend>${t('splitExpenses.participants')}</legend>${groupMemberCheckboxes()}</fieldset>
        <label>${t('splitExpenses.notes')}<textarea class="input" name="description" rows="3" maxlength="5000"></textarea></label>
        <div class="modal-actions">
          <button class="btn btn--secondary" type="button" id="split-cancel-expense">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-expense">${t('common.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-expense')?.addEventListener('click', () => closeModal());
      panel.querySelector('[name="split_method"]')?.addEventListener('change', () => updateSplitInputs(panel));
      panel.querySelector('#split-expense-form')?.addEventListener('input', () => validateSplitForm(panel));
      panel.querySelectorAll('input[name="participants"]').forEach((input) => {
        input.addEventListener('change', () => {
          const row = input.closest('.split-participant-row');
          const valueInput = row?.querySelector('.split-split-value');
          if (valueInput) valueInput.disabled = !input.checked;
          validateSplitForm(panel);
        });
      });
      updateSplitInputs(panel);
      panel.querySelector('#split-expense-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!validateSplitForm(panel)) return;
        const form = panel.querySelector('#split-expense-form');
        const data = Object.fromEntries(new FormData(form));
        const { participants, splits } = collectSplitPayload(form);
        await api.post(`/split-expenses/groups/${state.activeGroupId}/expenses`, { ...data, participants, splits });
        closeModal({ force: true });
        const dash = await api.get('/split-expenses/dashboard');
        state.dashboard = dash.data;
        await loadGroupData();
        renderAll();
      });
    },
  });
}

function openSettlementModal() {
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  openSharedModal({
    title: t('splitExpenses.registerPayment'),
    content: `
      <form id="split-settlement-form" class="split-form">
        <div class="split-form-row">
          <label>${t('splitExpenses.payer')}<select class="input" name="payer_id">${memberOptions()}</select></label>
          <label>${t('splitExpenses.payee')}<select class="input" name="payee_id">${memberOptions()}</select></label>
        </div>
        <div class="split-form-row">
          <label>${t('splitExpenses.amount')}<input class="input" name="amount" inputmode="decimal" required></label>
          <label>${t('splitExpenses.currency')}<select class="input" name="currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === group.default_currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        </div>
        <label>${t('splitExpenses.notes')}<textarea class="input" name="notes" rows="3" maxlength="5000"></textarea></label>
        <div class="modal-actions">
          <button class="btn btn--secondary" type="button" id="split-cancel-settlement">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-settlement">${t('splitExpenses.registerPayment')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-settlement')?.addEventListener('click', () => closeModal());
      panel.querySelector('#split-settlement-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(panel.querySelector('#split-settlement-form')));
        await api.post(`/split-expenses/groups/${state.activeGroupId}/settlements`, data);
        closeModal({ force: true });
        const dash = await api.get('/split-expenses/dashboard');
        state.dashboard = dash.data;
        await loadGroupData();
        renderAll();
      });
    },
  });
}

async function openMemberModal() {
  const candidates = await loadMemberCandidates();
  openSharedModal({
    title: t('splitExpenses.addMember'),
    content: `
      <form id="split-member-form" class="split-form">
        <label>${t('splitExpenses.member')}<select class="input" name="member_ref">${memberCandidateOptions(candidates)}</select></label>
        <label>${t('splitExpenses.role')}<select class="input" name="role"><option value="guest">${t('splitExpenses.roleGuest')}</option><option value="admin">${t('splitExpenses.roleAdmin')}</option></select></label>
        <div class="modal-actions">
          <button class="btn btn--secondary" type="button" id="split-new-guest">${t('splitExpenses.createGuest')}</button>
          <button class="btn btn--secondary" type="button" id="split-cancel-member">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-member">${t('common.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-member')?.addEventListener('click', () => closeModal());
      panel.querySelector('#split-new-guest')?.addEventListener('click', () => openGuestModal());
      panel.querySelector('#split-member-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(panel.querySelector('#split-member-form')));
        const [source, id] = String(data.member_ref || '').split(':');
        delete data.member_ref;
        if (source === 'contact') data.contact_id = Number(id);
        else data.user_id = Number(id);
        await api.post(`/split-expenses/groups/${state.activeGroupId}/members`, data);
        closeModal({ force: true });
        await loadGroups();
        await loadGroupData();
        renderAll();
      });
    },
  });
}

function openGuestModal() {
  openSharedModal({
    title: t('splitExpenses.createGuest'),
    content: `
      <form id="split-guest-form" class="split-form">
        <label>${t('splitExpenses.displayName')}<input class="input" name="display_name" required maxlength="128"></label>
        <label>${t('splitExpenses.usernameOptional')}<input class="input" name="username" autocomplete="off" maxlength="64"></label>
        <label>${t('splitExpenses.temporaryPassword')}<input class="input" name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <div class="split-form-row">
          <label>${t('splitExpenses.phone')}<input class="input" name="phone" type="tel" autocomplete="tel"></label>
          <label>${t('splitExpenses.email')}<input class="input" name="email" type="email" autocomplete="email"></label>
        </div>
        <label>${t('splitExpenses.birthDate')}<input class="input" name="birth_date" type="text" placeholder="${dateInputPlaceholder()}" inputmode="numeric"></label>
        <p class="form-hint">${t('splitExpenses.guestSyncHint')}</p>
        <div class="modal-actions">
          <button class="btn btn--secondary" type="button" id="split-cancel-guest">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-guest">${t('splitExpenses.createAndAddGuest')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-guest')?.addEventListener('click', () => closeModal());
      const birthDateInput = panel.querySelector('[name="birth_date"]');
      birthDateInput?.addEventListener('input', () => {
        birthDateInput.value = formatDateWhileTyping(birthDateInput.value);
      });
      panel.querySelector('#split-guest-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = panel.querySelector('#split-guest-form');
        const birthDateRaw = form.querySelector('[name="birth_date"]')?.value || '';
        if (!isDateInputValid(birthDateRaw)) return;
        const data = Object.fromEntries(new FormData(form));
        data.birth_date = parseDateInput(birthDateRaw) || null;
        await api.post(`/split-expenses/groups/${state.activeGroupId}/guests`, data);
        closeModal({ force: true });
        const [members, groupMembers] = await Promise.all([
          api.get('/family/members'),
          api.get(`/split-expenses/groups/${state.activeGroupId}/members`),
        ]);
        state.members = members.data || [];
        state.groupMembers = groupMembers.data || [];
        await loadGroups();
        await loadGroupData();
        renderAll();
      });
    },
  });
}
