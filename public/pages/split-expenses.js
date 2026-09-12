/**
 * Module: Split Expenses
 * Purpose: Mobile-first shared expense groups, balances, settlements, and activity.
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, confirmModal, confirmOverModal, reportFieldError, refocusAfterRender } from '/components/modal.js';
import { renderDocumentAttachField, bindDocumentAttachField } from '/components/document-attach.js';
import { t, formatDate, getLocale, dateInputPlaceholder, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';
import { stagger } from '/utils/ux.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { formatMoney, amountPlaceholder, toDecimalString, amountIsSavable, smallestUnitLabel } from '/utils/money.js';
import { todayKey } from '/utils/date.js';
import { wireTablist } from '/utils/tablist.js';
import { findPageFab } from '/utils/fab.js';
import { emptyStateHTML } from '/utils/empty-state.js';

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
  // Statusfilter der Gruppenliste (#574): 'archived' zeigt das Archiv
  // schreibgeschützt, inklusive Weg zurück über restoreGroup().
  groupStatus: 'active',
  user: null,
};
let _container = null;

/* UEBERGABE AUS DEM BUDGET (#1057).
 *
 * Eine Buchung mit Zustaendigen kann in die geteilten Ausgaben gereicht werden,
 * mit den Zustaendigen als Beteiligte. Das ist der Uebergang, den das Ticket
 * ausdruecklich statt einer Verschmelzung der beiden Funktionen wollte: das
 * Etikett im Budget bleibt eine Zuschreibung, die Forderung entsteht erst hier,
 * und der Nutzer bestaetigt sie im Dialog.
 *
 * DER DIALOG WIRD NICHT UEBERSPRUNGEN. Die Aufteilung, die Waehrung und die
 * Gruppe sind Entscheidungen, die das Budget nicht treffen kann - vorbefuellt
 * wird, was es weiss, den Rest sieht und bestaetigt die Person davor.
 */
let _pendingPrefill = null;

export function prefillSplitExpense(data) {
  _pendingPrefill = data ?? null;
}
let _statusTablist = null;   // wireTablist-Handle des Statusfilters (sync ohne onChange)

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('beforeend', html);
}

// Format aus utils/money.js - EINE Quelle für das ganze Budget-Modul (Critique
// P0). Geteilte Ausgaben tragen die Rolle `plain`: ein Rechnungsposten der
// Gruppe ist keine Bewegung auf dem Konto des Betrachters, wer ihn ausgelegt
// hat, hat eine Forderung und kein Minus. Die Rollentabelle steht in money.js.
function money(amount, currency) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  return formatMoney(n, currency);
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

export async function render(container, { user, embedded = false } = {}) {
  _container = container;
  state.user = user || null;
  // `split`, nicht `reading`: Kopf und Kennzahlenband stehen ueber einem
  // zweispaltigen .split-layout (Gruppen links, Detail rechts) - das IST die
  // Bauart des Modus. Das Raster selbst traegt die Seite noch in eigenem CSS
  // (Container-Queries statt Viewport-Breite, siehe split-expenses.css);
  // das Shell-Raster wirkt nur auf .app-page__body, den es hier nicht gibt.
  //
  // EINGEBETTET (budget.js ruft immer mit embedded:true - es gibt heute keine
  // eigenstaendige Route) TRAEGT DIE UEBERSCHRIFT KEIN ZWEITES <h1>: der
  // Modulkopf sagt bereits "Budget" (Cross-Modul-Review). Die Budget-Seiten-
  // CSS behandelte den Split-Titel dort eingebettet schon laenger als
  // Bereichs-Ueberschrift (typography.css) - das Element selbst blieb bis
  // hierher ein <h1> und widersprach damit seiner eigenen Rolle. Aus demselben
  // Grund traegt der Knopf hier --secondary statt --primary: die Primaeraktion ist der FAB
  // (#split-fab, siehe unten), nicht zwei violette Knoepfe fuer dieselbe
  // Handlung. Unveraendert bleibt die (heute nicht erreichte) eigenstaendige
  // Zukunft: <h1> plus Primaerknopf, falls Split-Ausgaben je eine eigene
  // Navigationsebene bekommt (DESIGN.md, Q-3).
  const TitleTag = embedded ? 'h2' : 'h1';
  const addExpenseBtnVariant = embedded ? 'btn--secondary' : 'btn--primary';
  setHtml(container, `
    <div class="split-page app-page app-page--split" data-composition="split">
      <header class="panel-head split-topbar">
        <div>
          <${TitleTag} class="split-title">${t('splitExpenses.title')}</${TitleTag}>
          <p class="split-subtitle">${t('splitExpenses.subtitle')}</p>
        </div>
        <button class="btn ${addExpenseBtnVariant}" id="split-add-expense">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.addExpense')}
        </button>
      </header>
      <section class="metric-grid" id="split-summary"></section>
      <div class="split-layout">
        <aside class="split-groups-panel">
          <div class="split-panel-head">
            <div class="split-panel-title">${t('splitExpenses.groups')}</div>
            <button class="btn btn--icon" id="split-add-group" aria-label="${t('splitExpenses.addGroup')}" ${isSplitGuest() ? 'hidden' : ''}>
              <i data-lucide="plus" aria-hidden="true"></i>
            </button>
          </div>
          <label class="split-search" for="split-group-search">
            <span class="split-search__label">${t('splitExpenses.searchGroups')}</span>
            <span class="split-search__control">
              <i data-lucide="search" aria-hidden="true"></i>
              <input id="split-group-search" type="search" placeholder="${t('splitExpenses.searchGroups')}" autocomplete="off">
            </span>
          </label>
          <!-- Geteilter Umschalter-Baustein des Budget-Moduls statt eigener
               Pillen-Optik, und role="radiogroup" statt role="group": eine
               Einfachauswahl, die ihren Zustand ansagt und über die geteilte
               Verhaltensschicht Pfeiltasten mitbringt (Critique 2026-07-30, P1). -->
          <div class="segmented split-status-filter" id="split-status-filter" role="radiogroup" aria-label="${t('splitExpenses.statusLabel')}">
            ${[['active', 'splitExpenses.statusActive'], ['archived', 'splitExpenses.statusArchived']].map(([id, key]) => {
              const on = state.groupStatus === id;
              return `<button type="button" class="segmented__item${on ? ' is-active' : ''}"
                  role="radio" data-tab-id="${id}" aria-checked="${on}"
                  tabindex="${on ? '0' : '-1'}">${t(key)}</button>`;
            }).join('')}
          </div>
          <div class="split-groups" id="split-groups"></div>
        </aside>
        <main class="split-main" id="split-main" aria-busy="true">${renderSkeletonList({ rows: 5, lines: 2 })}</main>
      </div>
      <button class="page-fab" id="split-fab" aria-label="${t('splitExpenses.addExpense')}" data-dock-label="${t('newLabel.splitExpenses')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: _container });
  await loadInitial();
  bindShell();
  renderAll();

  // Erst NACH renderAll(): der Dialog braucht die geladenen Gruppen und
  // Mitglieder, sonst stuende er ohne Beteiligte da.
  if (_pendingPrefill) {
    const prefill = _pendingPrefill;
    _pendingPrefill = null;
    openExpenseModal(null, prefill);
  }
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
  const res = await api.get(`/split-expenses/groups?status=${state.groupStatus}&q=${encodeURIComponent(state.query)}`);
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
  findPageFab('split-fab')?.addEventListener('click', () => openExpenseModal());
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
  _statusTablist = wireTablist(_container.querySelector('#split-status-filter'), {
    activeId: state.groupStatus,
    activeClass: 'is-active',
    mode: 'select',
    onChange: async (id) => {
      state.groupStatus = id;
      state.activeGroupId = null;
      await loadGroups();
      await loadGroupData();
      renderAll();
    },
  });
  _container.querySelector('#split-groups')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-group-id]');
    if (!btn) return;
    state.activeGroupId = Number(btn.dataset.groupId);
    await loadGroupData();
    renderAll();
  });
}

function isArchivedView() {
  return state.groupStatus === 'archived';
}

function renderAll() {
  renderStatusFilter();
  renderSummary();
  renderGroups();
  renderMain();
  if (window.lucide) lucide.createIcons({ el: _container });
}

/**
 * Statusfilter spiegeln + Anlegen-Aktionen im Archiv stilllegen: eine neue
 * Ausgabe würde dort in eine archivierte Gruppe laufen.
 */
function renderStatusFilter() {
  // Zustand über die geteilte Verhaltensschicht spiegeln (sync löst kein
  // onChange aus) statt Klassen und ARIA von Hand nachzuziehen.
  _statusTablist?.sync(state.groupStatus);
  const addExpense = _container.querySelector('#split-add-expense');
  if (addExpense) addExpense.hidden = isArchivedView();
  const fab = findPageFab('split-fab');
  if (fab) fab.hidden = isArchivedView();
}

function renderSummary() {
  const summary = _container.querySelector('#split-summary');
  const owed = state.dashboard?.total_owed || [];
  const owing = state.dashboard?.total_owing || [];
  // Geteilte Kennzahlkarte des Budget-Moduls (budget.css). Die frühere eigene
  // .split-summary-card war die dritte von fünf Bauarten im selben Modul
  // (Critique 2026-07-30, P0).
  // Rolle `total`: die Richtung steht im Label („Du bekommst" / „Du schuldest"),
  // nicht im Vorzeichen - deshalb der Ton explizit statt aus der Zahl.
  setHtml(summary, `
    <div class="metric-card metric-card--positive">
      <div class="metric-card__label">${t('splitExpenses.youAreOwed')}</div>
      <div class="metric-card__value">${owed.length ? owed.map((r) => money(r.amount, r.currency)).join(' · ') : money(0, state.meta.default_currency)}</div>
    </div>
    <div class="metric-card metric-card--negative">
      <div class="metric-card__label">${t('splitExpenses.youOwe')}</div>
      <div class="metric-card__value">${owing.length ? owing.map((r) => money(r.amount, r.currency)).join(' · ') : money(0, state.meta.default_currency)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-card__label">${isArchivedView() ? t('splitExpenses.statusArchived') : t('splitExpenses.activeGroups')}</div>
      <div class="metric-card__value">${state.groups.length}</div>
    </div>
  `);
}

function renderGroups() {
  const el = _container.querySelector('#split-groups');
  if (!state.groups.length) {
    setHtml(el, isArchivedView()
      ? emptyStateHTML({
        className: 'split-empty-inline',
        icon: 'archive',
        title: t('splitExpenses.emptyArchivedTitle'),
      })
      : emptyStateHTML({
        className: 'split-empty-inline',
        icon: 'receipt-text',
        title: t('splitExpenses.emptyGroupsTitle'),
        description: t('splitExpenses.emptyGroupsText'),
      }));
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
  main.removeAttribute('aria-busy');
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  if (!group) {
    setHtml(main, isArchivedView()
      ? emptyStateHTML({
        className: 'split-main-empty',
        icon: 'archive',
        title: t('splitExpenses.emptyArchivedTitle'),
      })
      : emptyStateHTML({
        className: 'split-main-empty',
        icon: 'users-round',
        title: t('splitExpenses.emptyGroupsTitle'),
        description: t('splitExpenses.emptyGroupsText'),
      }));
    return;
  }
  // Archiv-Ansicht: Salden, Ausgaben und Verlauf bleiben lesbar, alle
  // schreibenden Aktionen weichen dem Wiederherstellen (#574).
  const archived = isArchivedView();
  setHtml(main, `
    <section class="split-group-header">
      <div>
        <h2>${esc(group.name)}</h2>
        <p class="split-group-type">${t(`splitExpenses.groupType.${group.type}`)}</p>
        ${archived ? `<p class="split-archived-badge"><i data-lucide="archive" class="icon-md" aria-hidden="true"></i>${t('splitExpenses.statusArchived')}</p>` : ''}
        <p>${esc(group.description || t('splitExpenses.groupDefaultDescription'))}</p>
      </div>
      <div class="split-header-actions">
        ${archived ? `
        <button class="btn btn--secondary" id="split-restore-group" ${isSplitGuest() ? 'hidden' : ''}>
          <i data-lucide="archive-restore" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.restoreGroup')}
        </button>` : `
        ${isSplitGuest() ? '' : `
        <button class="btn btn--secondary btn--icon" id="split-edit-group" aria-label="${t('splitExpenses.editGroup')}">
          <i data-lucide="pencil" aria-hidden="true"></i>
        </button>
        <button class="btn btn--secondary btn--icon" id="split-archive-group" aria-label="${t('splitExpenses.archiveGroup')}">
          <i data-lucide="archive" aria-hidden="true"></i>
        </button>
        <!-- Loeschen ist unumkehrbar (die Gruppe faellt mitsamt ihrer Ausgaben),
             Bearbeiten/Archivieren nicht - dieselbe Kapsel fuer alle drei
             verwischte den Unterschied. --danger-outline hebt sich ab, ohne die
             Zeile zu dominieren; confirmModal({danger:true}) haengt schon
             darunter (deleteGroup()). -->
        <button class="btn btn--icon btn--danger-outline" id="split-delete-group" aria-label="${t('splitExpenses.deleteGroup')}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>`}
        <button class="btn btn--secondary" id="split-settle">
          <i data-lucide="hand-coins" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.settle')}
        </button>
        <button class="btn btn--secondary" id="split-invite" ${isSplitGuest() ? 'hidden' : ''}>
          <i data-lucide="user-plus" class="icon-md" aria-hidden="true"></i>
          ${t('splitExpenses.addMember')}
        </button>`}
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
        <div id="split-expense-list">${renderExpenses(archived)}</div>
      </section>
      <section class="split-card">
        <div class="split-card-head">
          <h3>${t('splitExpenses.activity')}</h3>
        </div>
        <div class="split-activity">${renderActivity()}</div>
      </section>
    </div>
  `);
  main.querySelector('#split-restore-group')?.addEventListener('click', () => restoreGroup(group.id));
  main.querySelector('#split-edit-group')?.addEventListener('click', () => openGroupModal(group));
  main.querySelector('#split-archive-group')?.addEventListener('click', () => archiveGroup(group.id));
  main.querySelector('#split-delete-group')?.addEventListener('click', () => deleteGroup(group.id));
  main.querySelector('#split-settle')?.addEventListener('click', () => openSettlementModal());
  const settleButton = main.querySelector('#split-settle');
  if (settleButton) settleButton.disabled = state.expenses.length === 0;
  main.querySelector('#split-invite')?.addEventListener('click', () => openMemberModal());
  if (!archived) {
    main.querySelector('#split-expense-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-expense-id]');
      if (!btn) return;
      const expense = state.expenses.find((item) => item.id === Number(btn.dataset.expenseId));
      if (expense) openExpenseModal(expense);
    });
  }
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

function renderExpenses(readOnly = false) {
  if (!state.expenses.length) return `<div class="split-muted">${t('splitExpenses.noExpenses')}</div>`;
  return state.expenses.map((expense) => {
    // Beleg-Marke (#583): dass ein Nachweis vorliegt, ist die Information -
    // wie viele es sind, beantwortet keine Frage vor dem Öffnen.
    const receiptCount = expense.attachments?.length ?? 0;
    const receiptMark = receiptCount
      ? ` <span class="split-expense__receipt" role="img" aria-label="${esc(t('splitExpenses.receiptsAttachedLabel', { count: receiptCount }))}"><i data-lucide="paperclip" aria-hidden="true"></i></span>`
      : '';
    const body = `
      <div class="split-expense__icon"><i data-lucide="${categoryIcon(expense.category)}" aria-hidden="true"></i></div>
      <div class="split-expense__body">
        <strong>${esc(expense.title)}</strong>
        <span>${t('splitExpenses.paidBy')}: ${esc(expense.payer_name || '')} · ${formatDate(expense.expense_date)}${receiptMark}</span>
      </div>
      <div class="split-expense__amount">${money(expense.amount, expense.currency)}</div>
    `;
    // Im Archiv bleibt der Eintrag ein reiner Listeneintrag - ein Button würde
    // eine Bearbeiten-Aktion versprechen, die es dort nicht gibt.
    if (readOnly) return `<div class="split-expense">${body}</div>`;
    return `
      <button type="button" class="split-expense" data-expense-id="${expense.id}" aria-label="${esc(expense.title)} - ${t('splitExpenses.editExpense')}">
        ${body}
      </button>
    `;
  }).join('');
}

function renderActivity() {
  if (!state.activity.length) return `<div class="split-muted">${t('splitExpenses.noActivity')}</div>`;
  return state.activity.map((item) => `
    <div class="split-activity-item">
      <span class="split-activity-dot"></span>
      <div>
        <strong>${esc(t(`splitExpenses.activityType.${item.type}`))}</strong>
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
  await refreshDashboard();
  await loadGroups();
  await loadGroupData();
  renderAll();
  refocusAfterRender();
}

/**
 * Holt eine archivierte Gruppe zurück in die aktive Liste und wechselt dorthin.
 * Bewusst ohne Rückfrage: der Schritt ist verlustfrei und über Archivieren
 * jederzeit umkehrbar.
 */
async function restoreGroup(groupId) {
  await api.post(`/split-expenses/groups/${groupId}/unarchive`, {});
  state.groupStatus = 'active';
  state.activeGroupId = groupId;
  await refreshDashboard();
  await loadGroups();
  await loadGroupData();
  renderAll();
}

async function refreshDashboard() {
  const dash = await api.get('/split-expenses/dashboard');
  state.dashboard = dash.data;
}

async function deleteGroup(groupId) {
  const confirmed = await confirmModal(t('splitExpenses.deleteGroupConfirm'), {
    danger: true,
    confirmLabel: t('splitExpenses.deleteGroup'),
    detail: t('splitExpenses.deleteGroupConfirmDetail'),
  });
  if (!confirmed) return;
  await api.delete(`/split-expenses/groups/${groupId}`);
  await refreshDashboard();
  await loadGroups();
  await loadGroupData();
  renderAll();
  refocusAfterRender();
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

function groupMemberCheckboxes(selectedIds = null, splitValues = {}) {
  const members = state.groupMembers.length ? state.groupMembers : state.members;
  const selectedSet = selectedIds ? new Set(selectedIds.map(Number)) : null;
  return members.map((member) => {
    const id = member.id ?? member.user_id;
    const checked = selectedSet ? selectedSet.has(Number(id)) : true;
    const value = splitValues[id] ?? '';
    return `
    <div class="split-participant-row" data-participant-row="${id}">
      <label class="split-check">
        <input type="checkbox" name="participants" value="${id}" ${checked ? 'checked' : ''}>
        <span>${esc(member.display_name)}</span>
      </label>
      <input class="input split-split-value" name="split_value_${id}" inputmode="decimal" aria-label="${esc(member.display_name)} ${t('splitExpenses.splitValue')}" placeholder="" value="${esc(value)}">
    </div>
  `;
  }).join('');
}

/**
 * Rekonstruiert die pro-Teilnehmer Split-Eingabewerte aus einer gespeicherten
 * Ausgabe, damit der Bearbeiten-Dialog denselben Aufteilungsmodus vorbelegt.
 * - exact: exakte Beträge (verlustfrei)
 * - percentage: Prozentanteile, Restbetrag auf letzten Teilnehmer (Summe = 100)
 * - shares: ganzzahlige Anteile über den ggT der Minor-Beträge
 * - equal: keine Werte nötig
 */
function deriveSplitValues(expense) {
  const method = expense.split_method;
  const splits = expense.splits || [];
  const values = {};
  if (method === 'exact') {
    for (const split of splits) values[split.user_id] = String(split.amount);
  } else if (method === 'percentage') {
    const totalMinor = splits.reduce((sum, split) => sum + Math.abs(Number(split.amount_minor || 0)), 0) || 1;
    let acc = 0;
    splits.forEach((split, index) => {
      if (index === splits.length - 1) {
        values[split.user_id] = String(Number((100 - acc).toFixed(2)));
      } else {
        const pct = Number(((Math.abs(Number(split.amount_minor || 0)) / totalMinor) * 100).toFixed(2));
        acc += pct;
        values[split.user_id] = String(pct);
      }
    });
  } else if (method === 'shares') {
    const amounts = splits.map((split) => Math.abs(Number(split.amount_minor || 0)));
    const divisor = amounts.reduce((a, b) => splitGcd(a, b), 0) || 1;
    splits.forEach((split, index) => {
      values[split.user_id] = String(Math.max(1, Math.round(amounts[index] / divisor)));
    });
  }
  return values;
}

function splitGcd(a, b) {
  return b === 0 ? a : splitGcd(b, a % b);
}

/**
 * Standard-Aufteilung einer Gruppe (#517). Die API liefert default_split_config
 * als JSON-String ([{ user_id, percentage }] bzw. [{ user_id, shares }]); dieser
 * Helfer parst tolerant in ein Array.
 */
function parseSplitConfig(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Übersetzt die gespeicherte Standard-Config einer Gruppe in die pro-Mitglied
 * Split-Eingabewerte, mit denen eine neue Ausgabe vorbelegt wird. Nur für
 * percentage/shares relevant; equal/exact brauchen keine Werte.
 */
function defaultSplitValues(group) {
  const method = group?.default_split_method;
  if (method !== 'percentage' && method !== 'shares') return {};
  const values = {};
  for (const entry of parseSplitConfig(group?.default_split_config)) {
    values[entry.user_id] = method === 'shares' ? String(entry.shares) : String(entry.percentage);
  }
  return values;
}

function updateSplitInputs(panel) {
  const method = panel.querySelector('[name="split_method"]')?.value || 'equal';
  // Der Betrag und die Teilbeträge stehen in der gewählten Währung; Prozente
  // und Anteile sind reine Zahlen und behalten ihren festen Platzhalter.
  const currency = panel.querySelector('[name="currency"]')?.value || state.meta?.default_currency || 'EUR';
  const zero = amountPlaceholder(currency);
  const amountInput = panel.querySelector('[name="amount"]');
  if (amountInput) amountInput.placeholder = zero;
  panel.querySelectorAll('.split-split-value').forEach((input) => {
    input.hidden = method === 'equal';
    input.required = method !== 'equal';
    if (method === 'percentage') input.placeholder = '30';
    else if (method === 'exact') input.placeholder = zero;
    else if (method === 'shares') input.placeholder = '1';
    else input.placeholder = '';
  });
  const hint = panel.querySelector('#split-method-hint');
  validateSplitForm(panel);
}

/**
 * Ein Geldbetrag aus dem Formular in der Schreibweise, die der Server erwartet.
 *
 * parseMoneyToMinor() in server/services/split-expenses.js nimmt ausschliesslich
 * /^-?\d+(\.\d+)?$/ entgegen, die Eingabe folgt dagegen der Region - bis in die
 * Ziffern hinein. Ohne diese Umschrift kommt "12,50" oder "۱۲٫۵۰" unverändert
 * am Server an, und das Anlegen scheitert dort mit einem Fehler, der auf kein
 * Feld zeigt. Die Umschrift selbst steht in utils/money.js, der einen Quelle
 * für Geldformate.
 */
const decimalString = toDecimalString;

/**
 * Weist einen Betrag zurück, der mehr Nachkommastellen hat als die Währung
 * kennt. Die Felder hier sind Textfelder, es gibt also kein `step`, das der
 * Browser prüfen könnte - und der Platzhalter zeigt bei HUF, IDR oder IRR
 * bereits ganze Einheiten an.
 *
 * Ohne diese Prüfung landet die Ablehnung beim Server (parseMoneyToMinor wirft
 * bei zu vielen Stellen), und die Meldung erscheint als ortloser Fehler statt
 * am Feld, das sie meint.
 *
 * @returns {boolean} true, wenn abgewiesen wurde (der Aufrufer bricht dann ab)
 */
function rejectOffGridSplitAmount(input, value, currency, original = null) {
  if (input == null || value === '' || value == null) return false;
  if (amountIsSavable(value, currency, { original })) return false;
  reportFieldError(input, t('common.amountPrecisionRequired', {
    currency,
    step: smallestUnitLabel(currency),
  }));
  return true;
}

function numberValue(value) {
  const normalized = decimalString(value);
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

/**
 * Standard-Aufteilungs-Editor im Gruppen-Modal (#517). Bietet Methode +
 * pro-Mitglied-Werte (percentage/shares), mit denen neue Ausgaben starten.
 * 'exact' ist bewusst nicht wählbar - exakte Beträge hängen vom Ausgabenbetrag
 * ab, ein fixer Default ergibt keinen Sinn. Erst ab zwei Mitgliedern sichtbar.
 */
function renderGroupDefaults(group) {
  const members = state.groupMembers.length ? state.groupMembers : state.members;
  if (members.length < 2) return '';
  const method = group?.default_split_method || 'equal';
  const values = defaultSplitValues(group);
  const opt = (value, label) => `<option value="${value}" ${value === method ? 'selected' : ''}>${label}</option>`;
  return `
    <fieldset class="split-defaults">
      <legend>${t('splitExpenses.defaultSplit')}</legend>
      <p class="form-hint">${t('splitExpenses.defaultSplitHint')}</p>
      <label>${t('splitExpenses.splitMethod')}<select class="input" name="default_split_method">
        ${opt('equal', t('splitExpenses.splitEqual'))}
        ${opt('percentage', t('splitExpenses.splitPercentage'))}
        ${opt('shares', t('splitExpenses.splitShares'))}
      </select></label>
      ${members.map((member) => {
        const id = member.id ?? member.user_id;
        return `
        <div class="split-participant-row" data-default-row="${id}">
          <span>${esc(member.display_name)}</span>
          <input class="input split-default-value" name="default_value_${id}" inputmode="decimal" aria-label="${esc(member.display_name)} ${t('splitExpenses.splitValue')}" value="${esc(values[id] ?? '')}">
        </div>`;
      }).join('')}
      <p class="form-hint" id="split-default-hint" role="status"></p>
    </fieldset>
  `;
}

/**
 * Zeigt/versteckt die Default-Werte je Methode und blockiert das Speichern der
 * Gruppe nur, wenn eine percentage-Config ausgefüllt ist, aber nicht 100 ergibt.
 * Leere Werte = keine Vorbelegung (erlaubt).
 */
function updateGroupDefaults(panel) {
  const select = panel.querySelector('[name="default_split_method"]');
  if (!select) return;
  const method = select.value;
  const rows = [...panel.querySelectorAll('.split-default-value')];
  rows.forEach((input) => {
    input.hidden = method === 'equal';
    if (method === 'percentage') input.placeholder = '50';
    else if (method === 'shares') input.placeholder = '1';
    else input.placeholder = '';
  });
  const filled = rows.filter((input) => String(input.value).trim() !== '');
  let valid = true;
  let message = '';
  if (method === 'percentage' && filled.length) {
    const total = rows.reduce((sum, input) => sum + (numberValue(input.value) || 0), 0);
    valid = Math.abs(total - 100) < 0.01;
    message = t('splitExpenses.splitCurrentTotal', { total: total.toFixed(2) });
  } else if (method === 'shares' && filled.length) {
    valid = filled.every((input) => {
      const value = numberValue(input.value);
      return Number.isInteger(value) && value > 0;
    });
  }
  const hint = panel.querySelector('#split-default-hint');
  if (hint) hint.textContent = valid ? message : `${t('splitExpenses.defaultSplitInvalid')} ${message}`.trim();
  const save = panel.querySelector('#split-save-group');
  if (save) save.disabled = !valid;
}

/**
 * Baut aus den Default-Wert-Feldern die default_split_config für die API und
 * entfernt die flachen default_value_*-Felder aus dem Payload.
 */
function collectGroupDefaults(form, data) {
  const method = form.querySelector('[name="default_split_method"]')?.value;
  Object.keys(data).forEach((key) => { if (key.startsWith('default_value_')) delete data[key]; });
  if (!method) return;
  data.default_split_method = method;
  const config = [];
  if (method === 'percentage' || method === 'shares') {
    form.querySelectorAll('.split-default-value').forEach((input) => {
      const raw = decimalString(input.value);
      if (!raw) return;
      const uid = Number(input.name.replace('default_value_', ''));
      config.push(method === 'shares' ? { user_id: uid, shares: Number(raw) } : { user_id: uid, percentage: raw });
    });
  }
  data.default_split_config = config;
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
    const value = decimalString(form.querySelector(`[name="split_value_${userId}"]`)?.value);
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
        ${isEdit ? renderGroupDefaults(group) : ''}
        <div class="modal-actions">
          <button class="btn btn--secondary" type="button" id="split-cancel-group">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-group">${t('common.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      panel.querySelector('#split-cancel-group')?.addEventListener('click', () => closeModal());
      panel.querySelector('[name="default_split_method"]')?.addEventListener('change', () => updateGroupDefaults(panel));
      panel.querySelectorAll('.split-default-value').forEach((input) => input.addEventListener('input', () => updateGroupDefaults(panel)));
      updateGroupDefaults(panel);
      panel.querySelector('#split-group-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = panel.querySelector('#split-group-form');
        const data = Object.fromEntries(new FormData(form));
        collectGroupDefaults(form, data);
        if (isEdit) await api.patch(`/split-expenses/groups/${group.id}`, data);
        else await api.post('/split-expenses/groups', data);
        if (isEdit) await syncEditedGroupMembers(group, form);
        // Neue Gruppen sind aktiv - aus dem Archiv heraus angelegt bliebe die
        // Liste sonst leer, obwohl die Gruppe existiert.
        if (!isEdit) state.groupStatus = 'active';
        closeModal({ force: true });
        await loadGroups();
        await loadGroupData();
        renderAll();
        refocusAfterRender();
      });
    },
  });
}

function openExpenseModal(expense = null, prefill = null) {
  if (!state.activeGroupId) return openGroupModal();
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  const isEdit = Boolean(expense && expense.id);
  // Eine Vorbelegung aus dem Budget (#1057) verhaelt sich wie eine NEUE Ausgabe,
  // deren Felder schon ausgefuellt sind - nicht wie eine bearbeitete.
  if (prefill && !isEdit) {
    expense = {
      title: prefill.title ?? '',
      amount: prefill.amount ?? '',
      currency: prefill.currency ?? group.default_currency,
      expense_date: prefill.date ?? null,
    };
  }
  // Neue Ausgaben starten mit der Standard-Aufteilung der Gruppe (#517),
  // bestehende mit ihrer eigenen gespeicherten Aufteilung.
  const method = isEdit ? (expense.split_method || 'equal') : (group.default_split_method || 'equal');
  // `null` heisst "Standard-Aufteilung der Gruppe". Eine Vorbelegung aus dem
  // Budget nennt dagegen genau die Zustaendigen (#1057) - aber nur die, die
  // auch in DIESER Gruppe sind: eine Person, die im Haushalt zustaendig ist,
  // aber nicht zur Gruppe gehoert, kann hier nichts tragen. Bleibt davon
  // niemand uebrig, faellt es auf die Standard-Aufteilung zurueck statt auf
  // eine Ausgabe ohne Beteiligte.
  const prefilledIds = prefill?.participantIds?.length
    ? prefill.participantIds.filter((id) => state.groupMembers.some((m) => Number(m.id ?? m.user_id) === Number(id)))
    : [];
  const selectedIds = isEdit
    ? (expense.splits || []).map((s) => s.user_id)
    : (prefilledIds.length ? prefilledIds : null);
  const splitValues = isEdit ? deriveSplitValues(expense) : defaultSplitValues(group);
  // Der vorbelegte Tag ist „heute" und geht deshalb nach der Anzeigezone - aus
  // der Browser-Uhr gebaut trug eine neue Ausgabe abends in einer anderen Zone
  // den Nachbartag (#829, Nachlese #851).
  const today = todayKey();
  const methodOption = (value, label) => `<option value="${value}" ${value === method ? 'selected' : ''}>${label}</option>`;
  openSharedModal({
    title: isEdit ? t('splitExpenses.editExpense') : t('splitExpenses.addExpense'),
    content: `
      <form id="split-expense-form" class="split-form">
        <label>${t('splitExpenses.titleLabel')}<input class="input" name="title" required maxlength="200" value="${esc(expense?.title || '')}"></label>
        <div class="split-form-row">
          <label>${t('splitExpenses.amount')}<input class="input" name="amount" inputmode="decimal" placeholder="${amountPlaceholder(isEdit ? expense.currency : group.default_currency)}" required value="${esc(expense?.amount || '')}"></label>
          <label>${t('splitExpenses.paidBy')}<select class="input" name="payer_id">${memberOptions(isEdit ? expense.payer_id : state.user?.id)}</select></label>
        </div>
        <div class="split-form-row">
          <label>${t('splitExpenses.currency')}<select class="input" name="currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === (expense?.currency || group.default_currency) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <label>${t('splitExpenses.date')}<yuvomi-datepicker name="expense_date" type="date" value="${esc(expense?.expense_date || today)}"></yuvomi-datepicker></label>
        </div>
        <label>${t('splitExpenses.splitMethod')}<select class="input" name="split_method">
          ${methodOption('equal', t('splitExpenses.splitEqual'))}
          ${methodOption('percentage', t('splitExpenses.splitPercentage'))}
          ${methodOption('exact', t('splitExpenses.splitExact'))}
          ${methodOption('shares', t('splitExpenses.splitShares'))}
        </select></label>
        <p class="form-hint" id="split-method-hint">${t(`splitExpenses.splitHint.${method}`)}</p>
        <fieldset class="split-participants"><legend>${t('splitExpenses.participants')}</legend>${groupMemberCheckboxes(selectedIds, splitValues)}</fieldset>
        <label>${t('splitExpenses.notes')}<textarea class="input" name="description" rows="3" maxlength="5000">${esc(expense?.description || '')}</textarea></label>
        ${renderDocumentAttachField({
          attachments: isEdit ? (expense.attachments || []) : [],
          label: t('splitExpenses.receiptsLabel'),
          hint: t('splitExpenses.receiptsHint'),
          icon: 'receipt',
        })}
        <div class="modal-actions">
          ${isEdit ? `<button class="btn btn--danger" type="button" id="split-delete-expense">${t('common.delete')}</button>` : ''}
          <button class="btn btn--secondary" type="button" id="split-cancel-expense">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-expense">${t('common.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      // Belege (#583): landen als Dokumente im Dokumente-Modul, benannt nach der
      // Ausgabe - ein Kassenbon soll dort auffindbar bleiben.
      const receipts = bindDocumentAttachField(panel, {
        category: 'finance',
        folderKey: 'splitExpenses',
        folderName: t('documents.splitExpensesFolder'),
        documentName: (file) => t('splitExpenses.receiptDocumentName', {
          title: panel.querySelector('[name="title"]').value.trim() || file.name,
          group: group?.name || '',
        }),
      });
      panel.querySelector('#split-cancel-expense')?.addEventListener('click', () => closeModal());
      panel.querySelector('[name="split_method"]')?.addEventListener('change', () => updateSplitInputs(panel));
      panel.querySelector('[name="currency"]')?.addEventListener('change', () => updateSplitInputs(panel));
      panel.querySelector('#split-expense-form')?.addEventListener('input', () => validateSplitForm(panel));
      panel.querySelectorAll('input[name="participants"]').forEach((input) => {
        const row = input.closest('.split-participant-row');
        const valueInput = row?.querySelector('.split-split-value');
        if (valueInput) valueInput.disabled = !input.checked;
        input.addEventListener('change', () => {
          if (valueInput) valueInput.disabled = !input.checked;
          validateSplitForm(panel);
        });
      });
      updateSplitInputs(panel);
      panel.querySelector('#split-delete-expense')?.addEventListener('click', async () => {
        // confirmOverModal statt confirmModal: das Ausgaben-Formular trägt
        // Betrag, Teilnehmer, Aufteilung und wartende Belege - „Abbrechen" gibt
        // es unverändert zurück, statt alles davon zu verdrängen.
        const confirmed = await confirmOverModal(t('splitExpenses.deleteExpenseConfirm'), {
          danger: true,
          confirmLabel: t('common.delete'),
          detail: t('splitExpenses.deleteExpenseConfirmDetail'),
        });
        if (!confirmed) return;
        await api.delete(`/split-expenses/expenses/${expense.id}`);
        await refreshDashboard();
        await loadGroupData();
        renderAll();
        refocusAfterRender();
      });
      panel.querySelector('#split-expense-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!validateSplitForm(panel)) return;
        const form = panel.querySelector('#split-expense-form');
        const data = Object.fromEntries(new FormData(form));
        data.amount = decimalString(data.amount);
        const expenseCurrency = form.querySelector('[name="currency"]')?.value || group.default_currency;
        if (rejectOffGridSplitAmount(form.querySelector('[name="amount"]'), numberValue(data.amount),
          expenseCurrency, isEdit ? expense.amount : null)) return;
        // Auch die Genau-Beträge: sie sind Geld in derselben Währung.
        if (form.querySelector('[name="split_method"]')?.value === 'exact') {
          for (const field of form.querySelectorAll('.split-split-value')) {
            if (field.hidden || !field.value) continue;
            if (rejectOffGridSplitAmount(field, numberValue(field.value), expenseCurrency)) return;
          }
        }
        const { participants, splits } = collectSplitPayload(form);
        const payload = { ...data, participants, splits };
        // commit() lädt wartende Dateien erst jetzt hoch: ein abgebrochenes
        // Formular hinterlässt keine verwaiste Datei im Dokumente-Modul.
        if (receipts) payload.attachment_document_ids = await receipts.commit();
        if (isEdit) await api.put(`/split-expenses/expenses/${expense.id}`, payload);
        else await api.post(`/split-expenses/groups/${state.activeGroupId}/expenses`, payload);
        closeModal({ force: true });
        await refreshDashboard();
        await loadGroupData();
        renderAll();
        refocusAfterRender();
      });
    },
  });
}

function openSettlementModal() {
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  // Vorbefüllung aus der offenen Schuld: bevorzugt die, in der ich selbst der
  // Schuldner bin - statt Zahler=Empfänger=erstes Mitglied und leerem Betrag.
  const debts = state.balances.simplified_debts || [];
  const debt = debts.find((d) => String(d.from_user_id) === String(state.user?.id)) || debts[0] || null;
  openSharedModal({
    title: t('splitExpenses.registerPayment'),
    content: `
      <form id="split-settlement-form" class="split-form">
        <div class="split-form-row">
          <label>${t('splitExpenses.payer')}<select class="input" name="payer_id">${memberOptions(debt?.from_user_id ?? state.user?.id)}</select></label>
          <label>${t('splitExpenses.payee')}<select class="input" name="payee_id">${memberOptions(debt?.to_user_id)}</select></label>
        </div>
        <p class="form-hint field-hint--warn" id="split-settlement-same" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('splitExpenses.settlementSamePerson')}</span></p>
        <div class="split-form-row">
          <label>${t('splitExpenses.amount')}<input class="input" name="amount" inputmode="decimal" placeholder="${amountPlaceholder(debt?.currency || group.default_currency)}" required value="${debt ? esc(String(debt.amount)) : ''}"></label>
          <label>${t('splitExpenses.currency')}<select class="input" name="currency">${state.meta.currencies.map((c) => `<option value="${c}" ${c === (debt?.currency || group.default_currency) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        </div>
        <label>${t('splitExpenses.notes')}<textarea class="input" name="notes" rows="3" maxlength="5000"></textarea></label>
        ${renderDocumentAttachField({
          label: t('splitExpenses.proofLabel'),
          hint: t('splitExpenses.proofHint'),
          icon: 'receipt',
          maxItems: 1,
        })}
        <div class="modal-actions">
          <button class="btn btn--secondary" type="button" id="split-cancel-settlement">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="submit" id="split-save-settlement">${t('splitExpenses.registerPayment')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      // Zahlungsnachweis: das Modell kennt genau ein Dokument je Zahlung
      // (settlements.proof_document_id), deshalb wird unten nur das erste
      // übernommen - mehrere Nachweise für eine Überweisung gibt es nicht.
      const proof = bindDocumentAttachField(panel, {
        category: 'finance',
        folderKey: 'splitExpenses',
        folderName: t('documents.splitExpensesFolder'),
        documentName: (file) => t('splitExpenses.proofDocumentName', {
          group: group?.name || '',
          name: file.name,
        }),
      });
      const form = panel.querySelector('#split-settlement-form');
      const payerSel = form.querySelector('[name="payer_id"]');
      const payeeSel = form.querySelector('[name="payee_id"]');
      const sameHint = panel.querySelector('#split-settlement-same');
      const samePerson = () => payerSel.value === payeeSel.value;
      const syncSameHint = () => { sameHint.hidden = !samePerson(); };
      // Zahlerwechsel: passende Schuld dieses Zahlers übernehmen, solange der
      // Betrag noch unberührt ist; mindestens den Empfänger-Konflikt auflösen.
      payerSel.addEventListener('change', () => {
        const match = (state.balances.simplified_debts || []).find((d) => String(d.from_user_id) === payerSel.value);
        if (match) {
          payeeSel.value = String(match.to_user_id);
          const amountInput = form.querySelector('[name="amount"]');
          if (!amountInput.value || (debt && amountInput.value === String(debt.amount))) {
            amountInput.value = String(match.amount);
          }
        }
        syncSameHint();
      });
      payeeSel.addEventListener('change', syncSameHint);
      syncSameHint();
      // Der Platzhalter zeigt die Null im Format der gewählten Währung und muss
      // beim Wechsel mitgehen - JPY schreibt "0", EUR "0,00".
      const currencySel = form.querySelector('[name="currency"]');
      currencySel?.addEventListener('change', () => {
        form.querySelector('[name="amount"]').placeholder = amountPlaceholder(currencySel.value);
      });
      panel.querySelector('#split-cancel-settlement')?.addEventListener('click', () => closeModal());
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (samePerson()) { syncSameHint(); payeeSel.focus(); return; }
        const data = Object.fromEntries(new FormData(form));
        data.amount = decimalString(data.amount);
        if (rejectOffGridSplitAmount(form.querySelector('[name="amount"]'), numberValue(data.amount),
          form.querySelector('[name="currency"]')?.value || group.default_currency,
          debt?.amount ?? null)) return;
        const proofIds = proof ? await proof.commit() : [];
        if (proofIds.length) data.proof_document_id = proofIds[0];
        await api.post(`/split-expenses/groups/${state.activeGroupId}/settlements`, data);
        closeModal({ force: true });
        await refreshDashboard();
        await loadGroupData();
        renderAll();
        refocusAfterRender();
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
        refocusAfterRender();
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
        refocusAfterRender();
      });
    },
  });
}
