/**
 * Module: Split Expenses
 * Purpose: Mobile-first shared expense groups, balances, settlements, and activity.
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal } from '/components/modal.js';
import { t, formatDate, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { stagger } from '/utils/ux.js';

let state = {
  meta: null,
  dashboard: null,
  groups: [],
  members: [],
  groupMembers: [],
  activeGroupId: null,
  expenses: [],
  balances: { balances: [], simplified_debts: [] },
  activity: [],
  query: '',
  category: '',
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

export async function render(container) {
  _container = container;
  setHtml(container, `
    <div class="split-page">
      <header class="split-topbar">
        <div>
          <h1 class="split-title">${t('splitExpenses.title')}</h1>
          <p class="split-subtitle">${t('splitExpenses.subtitle')}</p>
        </div>
        <button class="btn btn--primary" id="split-add-expense">
          <i data-lucide="plus" class="icon-base" aria-hidden="true"></i>
          ${t('splitExpenses.addExpense')}
        </button>
      </header>
      <section class="split-summary" id="split-summary"></section>
      <div class="split-layout">
        <aside class="split-groups-panel">
          <div class="split-panel-head">
            <div class="split-panel-title">${t('splitExpenses.groups')}</div>
            <button class="btn btn--icon" id="split-add-group" aria-label="${t('splitExpenses.addGroup')}">
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
        <i data-lucide="plus" class="icon-2xl" aria-hidden="true"></i>
      </button>
    </div>
  `);
  if (window.lucide) lucide.createIcons();
  await loadInitial();
  bindShell();
  renderAll();
}

async function loadInitial() {
  const [meta, dashboard, groups, members] = await Promise.all([
    api.get('/split-expenses/meta'),
    api.get('/split-expenses/dashboard'),
    api.get('/split-expenses/groups'),
    api.get('/family/members'),
  ]);
  state.meta = meta.data;
  state.dashboard = dashboard.data;
  state.groups = groups.data || [];
  state.members = members.data || [];
  state.activeGroupId = state.groups[0]?.id || null;
  if (state.activeGroupId) await loadGroupData();
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

function bindShell() {
  _container.querySelector('#split-add-group')?.addEventListener('click', () => openGroupModal());
  _container.querySelector('#split-add-expense')?.addEventListener('click', () => openExpenseModal());
  _container.querySelector('#split-fab')?.addEventListener('click', () => openExpenseModal());
  _container.querySelector('#split-group-search')?.addEventListener('input', async (e) => {
    state.query = e.target.value.trim();
    await loadGroups();
    await loadGroupData();
    renderAll();
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
  if (window.lucide) lucide.createIcons();
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
        <button class="btn btn--secondary" id="split-settle">
          <i data-lucide="hand-coins" class="icon-base" aria-hidden="true"></i>
          ${t('splitExpenses.settle')}
        </button>
        <button class="btn btn--secondary" id="split-invite">
          <i data-lucide="user-plus" class="icon-base" aria-hidden="true"></i>
          ${t('splitExpenses.addMember')}
        </button>
      </div>
    </section>
    <section class="split-quick-actions">
      ${quickAction('groceries', 'shopping-basket', 'quickGroceries')}
      ${quickAction('school', 'graduation-cap', 'quickSchool')}
      ${quickAction('utilities', 'plug-zap', 'quickUtilities')}
      ${quickAction('rent', 'home', 'quickRent')}
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
          <select class="input split-category-filter" id="split-category">
            <option value="">${t('splitExpenses.allCategories')}</option>
            ${state.meta.categories.map((cat) => `<option value="${cat}" ${cat === state.category ? 'selected' : ''}>${t(`splitExpenses.category.${cat}`)}</option>`).join('')}
          </select>
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
  main.querySelector('#split-settle')?.addEventListener('click', () => openSettlementModal());
  main.querySelector('#split-invite')?.addEventListener('click', () => openMemberModal());
  main.querySelectorAll('[data-quick-category]').forEach((btn) => {
    btn.addEventListener('click', () => openExpenseModal({ category: btn.dataset.quickCategory, title: btn.dataset.quickTitle }));
  });
  main.querySelector('#split-category')?.addEventListener('change', async (e) => {
    state.category = e.target.value;
    await loadGroupData();
    renderMain();
    if (window.lucide) lucide.createIcons();
  });
  stagger(main.querySelectorAll('.split-expense, .split-debt, .split-activity-item'));
}

function quickAction(category, icon, labelKey) {
  return `
    <button class="split-quick" type="button" data-quick-category="${category}" data-quick-title="${esc(t(`splitExpenses.${labelKey}`))}">
      <i data-lucide="${icon}" aria-hidden="true"></i>
      <span>${t(`splitExpenses.${labelKey}`)}</span>
    </button>
  `;
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
        <span>${esc(expense.payer_name || '')} · ${formatDate(expense.expense_date)} · ${t(`splitExpenses.category.${expense.category}`)}</span>
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

function memberOptions(selectedId = '', source = state.groupMembers.length ? state.groupMembers : state.members) {
  return source.map((member) => {
    const id = member.id ?? member.user_id;
    return `<option value="${id}" ${String(id) === String(selectedId) ? 'selected' : ''}>${esc(member.display_name)}</option>`;
  }).join('');
}

function groupMemberCheckboxes() {
  const members = state.groupMembers.length ? state.groupMembers : state.members;
  return members.map((member) => {
    const id = member.id ?? member.user_id;
    return `
    <label class="split-check">
      <input type="checkbox" name="participants" value="${id}" checked>
      <span>${esc(member.display_name)}</span>
    </label>
  `;
  }).join('');
}

function openGroupModal() {
  const currency = state.meta?.default_currency || 'EUR';
  openSharedModal({
    title: t('splitExpenses.addGroup'),
    content: `
      <form id="split-group-form" class="split-form">
        <label>${t('splitExpenses.name')}<input class="input" name="name" required maxlength="200"></label>
        <label>${t('splitExpenses.description')}<textarea class="input" name="description" rows="3" maxlength="5000"></textarea></label>
        <label>${t('splitExpenses.type')}<select class="input" name="type">${state.meta.group_types.map((type) => `<option value="${type}">${t(`splitExpenses.groupType.${type}`)}</option>`).join('')}</select></label>
        <label>${t('splitExpenses.currency')}<select class="input" name="default_currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
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
        await api.post('/split-expenses/groups', data);
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
        <label>${t('splitExpenses.amount')}<input class="input" name="amount" inputmode="decimal" placeholder="42.50" required></label>
        <div class="split-form-row">
          <label>${t('splitExpenses.currency')}<select class="input" name="currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === group.default_currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <label>${t('splitExpenses.date')}<input class="input" name="expense_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        </div>
        <div class="split-form-row">
          <label>${t('splitExpenses.paidBy')}<select class="input" name="payer_id">${memberOptions()}</select></label>
          <label>${t('splitExpenses.categoryLabel')}<select class="input" name="category">${state.meta.categories.map((cat) => `<option value="${cat}" ${cat === prefill.category ? 'selected' : ''}>${t(`splitExpenses.category.${cat}`)}</option>`).join('')}</select></label>
        </div>
        <label>${t('splitExpenses.splitMethod')}<select class="input" name="split_method"><option value="equal">${t('splitExpenses.splitEqual')}</option><option value="shares">${t('splitExpenses.splitShares')}</option></select></label>
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
      panel.querySelector('#split-expense-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = panel.querySelector('#split-expense-form');
        const data = Object.fromEntries(new FormData(form));
        const participants = [...form.querySelectorAll('input[name="participants"]:checked')].map((input) => Number(input.value));
        await api.post(`/split-expenses/groups/${state.activeGroupId}/expenses`, { ...data, participants });
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

function openMemberModal() {
  openSharedModal({
    title: t('splitExpenses.addMember'),
    content: `
      <form id="split-member-form" class="split-form">
        <label>${t('splitExpenses.member')}<select class="input" name="user_id">${memberOptions('', state.members)}</select></label>
        <label>${t('splitExpenses.role')}<select class="input" name="role"><option value="guest">${t('splitExpenses.roleGuest')}</option><option value="admin">${t('splitExpenses.roleAdmin')}</option></select></label>
        <div class="modal-actions">
          <button class="btn btn--secondary" type="button" id="split-cancel-member">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-member">${t('common.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-member')?.addEventListener('click', () => closeModal());
      panel.querySelector('#split-member-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(panel.querySelector('#split-member-form')));
        await api.post(`/split-expenses/groups/${state.activeGroupId}/members`, data);
        closeModal({ force: true });
        await loadGroups();
        await loadGroupData();
        renderAll();
      });
    },
  });
}
