/**
 * Modul: Budget-Tracker (Budget)
 * Zweck: Monatsübersicht, Kategorie-Balkendiagramm (Canvas), Transaktionsliste,
 *        CRUD, CSV-Export
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, confirmModal, advancedSection } from '/components/modal.js';
import { stagger, vibrate } from '/utils/ux.js';
import { t, formatDate, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { render as renderSplitExpenses } from '/pages/split-expenses.js';
import { openSubscriptionModal, render as renderSubscriptions } from '/pages/subscriptions.js';
import { renderStats } from '/pages/budget-stats.js';
import { toLocalDateKey } from '/utils/date.js';
import { budgetCategoryLabel } from '/utils/category-labels.js';
import { renderUserMultiSelect, bindUserMultiSelect, getSelectedUserIds } from '/components/user-multi-select.js';
import '/components/category-manager.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const SUBCATEGORY_I18N = () => ({
  rent_mortgage:            t('budget.subcatRentMortgage'),
  condominium:              t('budget.subcatCondominium'),
  utilities:                t('budget.subcatUtilities'),
  internet_tv_phone:        t('budget.subcatInternetTvPhone'),
  renovation_maintenance:   t('budget.subcatRenovationMaintenance'),
  cleaning:                 t('budget.subcatCleaning'),
  groceries:                t('budget.subcatGroceries'),
  restaurants_bars:         t('budget.subcatRestaurantsBars'),
  snacks_fast_food:         t('budget.subcatSnacksFastFood'),
  bakery:                   t('budget.subcatBakery'),
  fuel:                     t('budget.subcatFuel'),
  parking_tolls:            t('budget.subcatParkingTolls'),
  public_transport:         t('budget.subcatPublicTransport'),
  apps_taxi:                t('budget.subcatAppsTaxi'),
  maintenance_insurance:    t('budget.subcatMaintenanceInsurance'),
  pharmacy:                 t('budget.subcatPharmacy'),
  health_insurance:         t('budget.subcatHealthInsurance'),
  gym_sports:               t('budget.subcatGymSports'),
  beauty_cosmetics:         t('budget.subcatBeautyCosmetics'),
  travel:                   t('budget.subcatTravel'),
  streaming:                t('budget.subcatStreaming'),
  events:                   t('budget.subcatEvents'),
  hobbies:                  t('budget.subcatHobbies'),
  clothes_shoes:            t('budget.subcatClothesShoes'),
  electronics:              t('budget.subcatElectronics'),
  gifts:                    t('budget.subcatGifts'),
  courses_college:          t('budget.subcatCoursesCollege'),
  school_supplies:          t('budget.subcatSchoolSupplies'),
  languages:                t('budget.subcatLanguages'),
  loans_interest:           t('budget.subcatLoansInterest'),
  bank_fees:                t('budget.subcatBankFees'),
  insurance_other:          t('budget.subcatInsuranceOther'),
  investments:              t('budget.subcatInvestments'),
  taxes:                    t('budget.subcatTaxes'),
  subscription_entertainment: t('budget.subcatSubscriptionEntertainment'),
  subscription_productivity:  t('budget.subcatSubscriptionProductivity'),
  subscription_utilities:     t('budget.subcatSubscriptionUtilities'),
  subscription_health:        t('budget.subcatSubscriptionHealth'),
  subscription_education:     t('budget.subcatSubscriptionEducation'),
  subscription_other:         t('budget.subcatSubscriptionOther'),
});

function categoryLabel(category) {
  const item = typeof category === 'object'
    ? category
    : [...expenseCategories(), ...incomeCategories()].find((c) => c.key === category);
  const key = item?.key ?? category;
  const name = item?.name ?? category;
  return budgetCategoryLabel(key, name, t);
}

function subcategoryLabel(subcategory) {
  const item = typeof subcategory === 'object'
    ? subcategory
    : Object.values(state.meta.expenseSubcategories ?? {}).flat().find((s) => s.key === subcategory);
  const key = item?.key ?? subcategory;
  const name = item?.name ?? subcategory;
  return SUBCATEGORY_I18N()[key] ?? name;
}

function expenseCategories() {
  return state.meta.expenseCategories ?? [];
}

function incomeCategories() {
  return state.meta.incomeCategories ?? [];
}

function getSubcategories(category) {
  return state.meta.expenseSubcategories?.[category] || [];
}

function defaultSubcategory(category) {
  return getSubcategories(category)[0]?.key || '';
}

function defaultCategory(type) {
  const cats = type === 'income' ? incomeCategories() : expenseCategories();
  return cats[0]?.key || '';
}

function getMonthName(monthIndex) {
  // monthIndex: 0-based (0=Januar, 11=Dezember)
  const date = new Date(2000, monthIndex, 1);
  return new Intl.DateTimeFormat(getLocale(), { month: 'long' }).format(date);
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  month:       '',   // YYYY-MM
  entries:     [],
  summary:     null,
  prevSummary: null, // Vormonat für Monatsvergleich
  loans:       { loans: [], summary: { active_count: 0, remaining_amount: 0, remaining_installments: 0 } },
  activeTab:   'budget',
  loanFilterId: null,
  loanStatusFilter: 'active',
  budgetMode:  'shared',
  budgetView:  'mine',
  currency:    'EUR',
  meta:        { expenseCategories: [], incomeCategories: [], expenseSubcategories: {} },
  familyMembers: [],
};
let _container = null;
let _user = null;

// --------------------------------------------------------
// Formatierung
// --------------------------------------------------------

function formatAmount(n) {
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: state.currency }).format(n);
}

function formatMonthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${getMonthName(parseInt(m, 10) - 1)} ${y}`;
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
}

// --------------------------------------------------------
// API
// --------------------------------------------------------

async function loadMonth(month) {
  const prevMonth = addMonths(month, -1);
  try {
    const viewParam = state.budgetMode === 'personal' ? `&view=${state.budgetView}` : '';
    const [entriesRes, summaryRes, prevSummaryRes, loansRes] = await Promise.all([
      api.get(`/budget?month=${month}${viewParam}`),
      api.get(`/budget/summary?month=${month}${viewParam}`),
      api.get(`/budget/summary?month=${prevMonth}${viewParam}`),
      api.get('/budget/loans'),
    ]);
    state.month       = month;
    state.entries     = entriesRes.data;
    state.summary     = summaryRes.data;
    state.prevSummary = prevSummaryRes.data;
    state.loans       = loansRes.data;
  } catch (err) {
    console.error('[Budget] loadMonth Fehler:', err);
    state.month       = month;
    state.entries     = [];
    state.summary     = { income: 0, expenses: 0, balance: 0, byCategory: [] };
    state.prevSummary = null;
    state.loans       = { loans: [], summary: { active_count: 0, remaining_amount: 0, remaining_installments: 0 } };
    window.yuvomi?.showToast(t('budget.loadError'), 'danger');
  }
}

async function loadFamilyMembers() {
  try {
    const res = await api.get('/family/members');
    state.familyMembers = res.data ?? [];
  } catch {
    state.familyMembers = [];
  }
}

async function loadBudgetMeta() {
  try {
    const res = await api.get('/budget/meta');
    state.meta = {
      expenseCategories: res.data?.expenseCategories ?? [],
      incomeCategories: res.data?.incomeCategories ?? [],
      expenseSubcategories: res.data?.expenseSubcategories ?? {},
    };
  } catch (err) {
    console.error('[Budget] meta Fehler:', err);
    state.meta = { expenseCategories: [], incomeCategories: [], expenseSubcategories: {} };
    window.yuvomi?.showToast(t('budget.metaLoadError'), 'danger');
  }
}

// --------------------------------------------------------
// Entry Point
// --------------------------------------------------------

export async function render(container, { user }) {
  _container = container;
  _user = user;
  const today = new Date();
  state.month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  if (user?.access_scope === 'split_guest') state.activeTab = 'split-expenses';

  if (user?.access_scope !== 'split_guest') {
    try {
      const [prefsRes] = await Promise.all([
        api.get('/preferences'),
        loadBudgetMeta(),
        loadFamilyMembers(),
      ]);
      state.currency = prefsRes.data?.currency ?? 'EUR';
      state.budgetMode = prefsRes.data?.budget_mode ?? 'shared';
      state.budgetView = user?.role === 'admin' ? 'mine' : 'mine';
    } catch (_) { /* Fallback auf EUR */ }
  }

  setHtml(container, `
    <div class="budget-page">
      <div class="page-toolbar page-toolbar--wrap budget-nav">
        <h1 class="page-toolbar__title">${t('budget.title')}</h1>
        <div class="page-toolbar__center budget-nav__month">
          <button class="btn btn--icon" id="budget-prev" aria-label="${t('budget.prevMonth')}">
            <i data-lucide="chevron-left" aria-hidden="true"></i>
          </button>
          <button class="budget-nav__today" id="budget-today">${t('budget.currentMonth')}</button>
          <span class="budget-nav__label" id="budget-label"></span>
          <button class="btn btn--icon" id="budget-next" aria-label="${t('budget.nextMonth')}">
            <i data-lucide="chevron-right" aria-hidden="true"></i>
          </button>
        </div>
        <div class="page-toolbar__actions">
          <div class="budget-tabs" role="tablist" aria-label="${t('budget.tabsLabel')}">
            ${user?.access_scope === 'split_guest' ? '' : `
            <button class="budget-tab" id="budget-tab-budget" type="button" role="tab" aria-selected="true" aria-controls="budget-body" tabindex="-1" data-tab="budget">
              ${t('budget.budgetTab')}
            </button>
            <button class="budget-tab" id="budget-tab-subscriptions" type="button" role="tab" aria-selected="false" aria-controls="budget-body" tabindex="-1" data-tab="subscriptions">
              ${t('subscriptions.tabLabel')}
            </button>
            <button class="budget-tab" id="budget-tab-loans" type="button" role="tab" aria-selected="false" aria-controls="budget-body" tabindex="-1" data-tab="loans">
              ${t('budget.loansTab')}
            </button>
            <button class="budget-tab" id="budget-tab-reports" type="button" role="tab" aria-selected="false" aria-controls="budget-body" tabindex="-1" data-tab="reports">
              ${t('budget.reportsTab')}
            </button>`}
          <button class="budget-tab" id="budget-tab-split-expenses" type="button" role="tab" aria-selected="false" aria-controls="budget-body" tabindex="-1" data-tab="split-expenses">
              ${t('splitExpenses.tabLabel')}
            </button>
          </div>
          ${state.budgetMode === 'personal' && _user?.role === 'admin' ? `
          <div class="budget-view-toggle" role="group" aria-label="${t('budget.viewModeLabel')}">
            <button class="budget-view-toggle__btn ${state.budgetView === 'mine' ? 'budget-view-toggle__btn--active' : ''}" id="budget-view-mine" type="button">${t('budget.viewMine')}</button>
            <button class="budget-view-toggle__btn ${state.budgetView === 'household' ? 'budget-view-toggle__btn--active' : ''}" id="budget-view-household" type="button">${t('budget.viewHousehold')}</button>
          </div>` : ''}
          <button class="btn btn--primary btn--icon toolbar-new-btn" id="budget-add" aria-label="${t('budget.addEntryLabel')}">
            <i data-lucide="plus" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div id="budget-body" role="tabpanel" tabindex="0" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
        ${renderSkeletonList({ rows: 6, lines: 2 })}
      </div>
      <button class="page-fab" id="fab-new-budget" aria-label="${t('budget.newEntryFabLabel')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });

  if (user?.access_scope !== 'split_guest') {
    await loadMonth(state.month);
  } else {
    state.summary = { income: 0, expenses: 0, balance: 0, byCategory: [] };
    state.prevSummary = null;
    state.entries = [];
  }
  renderBody();
  wireNav();
}

// --------------------------------------------------------
// Navigation
// --------------------------------------------------------

function wireNav() {
  _container.querySelector('#budget-prev').addEventListener('click', async () => {
    await loadMonth(addMonths(state.month, -1));
    renderBody();
    updateLabel();
  });
  _container.querySelector('#budget-next').addEventListener('click', async () => {
    await loadMonth(addMonths(state.month, 1));
    renderBody();
    updateLabel();
  });
  _container.querySelector('#budget-today').addEventListener('click', async () => {
    const today = new Date();
    const m = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    if (m === state.month) return;
    await loadMonth(m);
    renderBody();
    updateLabel();
  });
  const addHandler = () => {
    if (state.activeTab === 'split-expenses') {
      _container.querySelector('#split-add-expense')?.click();
      return;
    }
    if (state.activeTab === 'subscriptions') {
      openSubscriptionModal();
      return;
    }
    openBudgetModal({ mode: 'create' });
  };
  _container.querySelector('#budget-add').addEventListener('click', addHandler);
  _container.querySelector('#fab-new-budget').addEventListener('click', addHandler);
  _container.querySelectorAll('.budget-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      renderBody();
    });
  });
  _container.querySelector('#budget-view-mine')?.addEventListener('click', async () => {
    if (state.budgetView === 'mine') return;
    state.budgetView = 'mine';
    await loadMonth(state.month);
    renderBody();
  });
  _container.querySelector('#budget-view-household')?.addEventListener('click', async () => {
    if (state.budgetView === 'household') return;
    state.budgetView = 'household';
    await loadMonth(state.month);
    renderBody();
  });
  // Pfeiltasten-Navigation im Tablist (WAI-ARIA): ←/→ und Home/End wechseln
  // den aktiven Tab und ziehen den Fokus mit.
  _container.querySelector('.budget-tabs')?.addEventListener('keydown', (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tabs = [..._container.querySelectorAll('.budget-tab')];
    if (!tabs.length) return;
    const current = tabs.findIndex((tab) => tab.dataset.tab === state.activeTab);
    let next = current;
    if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    e.preventDefault();
    state.activeTab = tabs[next].dataset.tab;
    renderBody();
    _container.querySelector('.budget-tab--active')?.focus();
  });
  // Edge-Fade live nachführen, während der Nutzer die Tab-Leiste scrollt.
  // (Re-Render ruft updateTabsFade ohnehin auf; daher kein window-resize-
  // Listener, der bei Re-Navigation lecken würde.) Aktiven Tab in Sicht holen.
  const tabsEl = _container.querySelector('.budget-tabs');
  tabsEl?.addEventListener('scroll', updateTabsFade, { passive: true });
  _container.querySelector('.budget-tab--active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  updateLabel();
}

function updateLabel() {
  const lbl = _container.querySelector('#budget-label');
  if (lbl) lbl.textContent = formatMonthLabel(state.month);
}

function updateBudgetViewToggle() {
  const mineBtn = _container.querySelector('#budget-view-mine');
  const householdBtn = _container.querySelector('#budget-view-household');
  if (!mineBtn || !householdBtn) return;
  const mineActive = state.budgetView === 'mine';
  mineBtn.classList.toggle('budget-view-toggle__btn--active', mineActive);
  householdBtn.classList.toggle('budget-view-toggle__btn--active', !mineActive);
  mineBtn.setAttribute('aria-pressed', String(mineActive));
  householdBtn.setAttribute('aria-pressed', String(!mineActive));
}

// Scroll-Affordance der Tab-Leiste: Rand ausblenden, solange auf der Seite
// weitere Tabs verborgen sind (Mobil; auf Desktop passen alle → keine Maske).
function updateTabsFade() {
  const el = _container?.querySelector('.budget-tabs');
  if (!el) return;
  // Epsilon > Scroll-Snap/Padding-Ruhelage (~2px), sonst flackert der Rand-Fade
  // schon bei minimalem Offset am Anfang/Ende.
  const eps = 8;
  const max = el.scrollWidth - el.clientWidth;
  el.classList.toggle('has-fade-start', el.scrollLeft > eps);
  el.classList.toggle('has-fade-end', el.scrollLeft < max - eps);
}

// --------------------------------------------------------
// Body
// --------------------------------------------------------

function renderBody() {
  const body = _container.querySelector('#budget-body');
  if (!body) return;
  updateLabel();
  updateBudgetViewToggle();

  const s    = state.summary;
  const p    = state.prevSummary;
  updateTabs();
  if (state.activeTab === 'reports') {
    setHtml(body, '<div class="budget-tab-panel budget-tab-panel--reports" id="budget-reports-panel"></div>');
    renderStats(body.querySelector('#budget-reports-panel'), {
      user: _user, currency: state.currency,
      formatAmount, categoryLabel, esc,
    }).catch((err) => console.error('[Budget] stats render error:', err));
    return;
  }
  if (state.activeTab === 'loans') {
    setHtml(body, renderLoansPage());
    wireLoansPage();
    if (window.lucide) lucide.createIcons({ el: body });
    return;
  }
  if (state.activeTab === 'subscriptions') {
    setHtml(body, '<div class="budget-tab-panel budget-tab-panel--subscriptions" id="budget-subscriptions-panel"></div>');
    renderSubscriptions(body.querySelector('#budget-subscriptions-panel'), { user: _user }).catch((err) => {
      console.error('[Budget] subscriptions render error:', err);
    });
    return;
  }
  if (state.activeTab === 'split-expenses') {
    setHtml(body, '<div class="budget-tab-panel budget-tab-panel--split-expenses" id="budget-split-expenses-panel"></div>');
    const panel = body.querySelector('#budget-split-expenses-panel');
    renderSplitExpenses(panel, { embedded: true, user: _user }).catch((err) => {
      console.error('[Budget] split expenses render error:', err);
      setHtml(panel, `<div class="empty-state"><div class="empty-state__title">${t('splitExpenses.title')}</div><div class="empty-state__description">${t('budget.loadError')}</div></div>`);
    });
    return;
  }

  const balanceClass = s.balance >= 0 ? 'budget-summary-card--balance-positive' : 'budget-summary-card--balance-negative';
  const prevLabel = p ? formatMonthLabel(p.month).split(' ')[0].slice(0, 3) : '';

  setHtml(body, `
    <div class="budget-tab-panel budget-tab-panel--budget">
    <!-- Zusammenfassung -->
    <div class="budget-summary">
      <div class="budget-summary-card budget-summary-card--income">
        <div class="budget-summary-card__label">${t('budget.income')}</div>
        <div class="budget-summary-card__amount">${formatAmount(s.income)}</div>
        ${p ? renderTrend(s.income, p.income, prevLabel) : ''}
      </div>
      <div class="budget-summary-card budget-summary-card--expenses">
        <div class="budget-summary-card__label">${t('budget.expenses')}</div>
        <div class="budget-summary-card__amount">${formatAmount(Math.abs(s.expenses))}</div>
        ${p ? renderTrend(s.expenses, p.expenses, prevLabel) : ''}
      </div>
      <div class="budget-summary-card ${balanceClass}">
        <div class="budget-summary-card__label">${t('budget.balance')}</div>
        <div class="budget-summary-card__amount">${formatAmount(s.balance)}</div>
        ${p ? renderTrend(s.balance, p.balance, prevLabel) : ''}
      </div>
    </div>

    <!-- Kategorie-Balken -->
    ${s.byCategory.length ? `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.byCategory')}</div>
      <p class="sr-only">${esc(chartSummary(s.byCategory))}</p>
      <div class="budget-chart">
        ${renderCategoryBars(s.byCategory)}
      </div>
    </div>` : ''}

    <!-- Transaktionsliste -->
    <div class="budget-list-section">
      <div class="budget-list-header">
        <div>
          <span class="budget-list-header__title">${t('budget.transactions')}</span>
          ${state.budgetMode === 'personal' ? `<div class="budget-list-header__filter">${state.budgetView === 'household' ? t('budget.viewHousehold') : t('budget.viewMine')}</div>` : ''}
          ${state.budgetMode === 'personal' ? `<div class="budget-list-header__hint">${t('budget.singleAssigneeHint')}</div>` : ''}
        </div>
        <div class="budget-list-header__actions">
        <button class="btn btn--icon btn--ghost" id="budget-manage-categories"
          aria-label="${t('budget.manageCategories')}" title="${t('budget.manageCategories')}">
          <i data-lucide="tags" class="icon-md" aria-hidden="true"></i>
        </button>
        ${state.entries.length ? `
        <a href="/api/v1/budget/export?month=${state.month}" class="btn btn--secondary budget-csv-export">
          <i data-lucide="download" class="icon-sm" aria-hidden="true"></i>CSV
        </a>` : ''}
        </div>
      </div>
      <div class="budget-list" id="budget-list">
        ${renderEntries()}
      </div>
    </div>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: body });
  _container.querySelector('#empty-cta-budget')?.addEventListener('click', () => {
    document.querySelector('.page-fab')?.click();
  });
  _container.querySelector('#budget-manage-categories')?.addEventListener('click', openCategoryManager);
  stagger(_container.querySelector('#budget-list')?.querySelectorAll('.budget-entry') ?? []);

  _container.querySelector('#budget-list')?.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-action="delete"]');
    if (delBtn) { await deleteEntry(parseInt(delBtn.dataset.id, 10)); return; }

    const parentBtn = e.target.closest('[data-action="open-parent"]');
    if (parentBtn) {
      state.budgetView = 'household';
      await loadMonth(state.month);
      renderBody();
      const entry = state.entries.find((row) => row.id === parseInt(parentBtn.dataset.id, 10));
      if (entry) openBudgetModal({ mode: 'edit', entry });
      return;
    }

    const item = e.target.closest('.budget-entry[data-id]');
    if (item && !e.target.closest('[data-action]')) {
      const entry = state.entries.find((e) => e.id === parseInt(item.dataset.id, 10));
      if (entry && !entry.is_readonly) openBudgetModal({ mode: 'edit', entry });
    }
  });
}

function updateTabs() {
  _container.classList.toggle('budget-page--split-active', state.activeTab === 'split-expenses' || _user?.access_scope === 'split_guest');
  _container.classList.toggle('budget-page--loans-active', state.activeTab === 'loans');
  _container.classList.toggle('budget-page--subscriptions-active', state.activeTab === 'subscriptions');
  let activeTabId = '';
  _container.querySelectorAll('.budget-tab').forEach((tab) => {
    const active = tab.dataset.tab === state.activeTab;
    tab.classList.toggle('budget-tab--active', active);
    tab.setAttribute('aria-selected', String(active));
    // Roving Tabindex: nur der aktive Tab ist per Tab-Taste fokussierbar,
    // zwischen den Tabs wird mit Pfeiltasten gewechselt (WAI-ARIA Tabs).
    tab.tabIndex = active ? 0 : -1;
    if (active) activeTabId = tab.id;
  });
  const panel = _container.querySelector('#budget-body');
  if (panel && activeTabId) panel.setAttribute('aria-labelledby', activeTabId);
  updateTabsFade();
  const splitActive = state.activeTab === 'split-expenses' || _user?.access_scope === 'split_guest';
  const loansActive = state.activeTab === 'loans';
  const subscriptionsActive = state.activeTab === 'subscriptions';
  const reportsActive = state.activeTab === 'reports';
  ['#budget-today', '#budget-label', '#budget-add'].forEach((selector) => {
    const el = _container.querySelector(selector);
    if (el) el.hidden = splitActive || subscriptionsActive || reportsActive;
  });
  ['#budget-prev', '#budget-next'].forEach((selector) => {
    const el = _container.querySelector(selector);
    if (el) el.hidden = splitActive || loansActive || subscriptionsActive || reportsActive;
  });
  const fab = _container.querySelector('#fab-new-budget');
  if (fab) {
    fab.hidden = false;
    fab.setAttribute('aria-label', splitActive
      ? t('splitExpenses.addExpense')
      : subscriptionsActive ? t('subscriptions.add') : t('budget.newEntryFabLabel'));
  }
}

// Screenreader-Zusammenfassung des Kategorie-Diagramms (Audit 1.7): Anzahl
// Kategorien + größter Posten mit Anteil. Wird als .sr-only-Text vor dem rein
// visuellen Balken-Chart ausgegeben.
function chartSummary(byCategory) {
  const total = byCategory.reduce((sum, c) => sum + Math.abs(c.total), 0) || 1;
  const top = byCategory.reduce((a, b) => (Math.abs(b.total) > Math.abs(a.total) ? b : a));
  const pct = Math.round((Math.abs(top.total) / total) * 100);
  return t('budget.chartSummary', {
    count: byCategory.length,
    top: categoryLabel(top.category),
    pct,
  });
}

function renderCategoryBars(byCategory) {
  const maxAbs = Math.max(...byCategory.map((c) => Math.abs(c.total)), 1);

  return byCategory.map((c) => {
    const isExpense = c.total < 0;
    const pct       = Math.round((Math.abs(c.total) / maxAbs) * 100);
    const cls       = isExpense ? 'budget-bar-row__fill--expenses' : 'budget-bar-row__fill--income';

    return `
      <div class="budget-bar-row">
        <div class="budget-bar-row__label" title="${esc(categoryLabel(c.category))}">${esc(categoryLabel(c.category))}</div>
        <div class="budget-bar-row__track">
          <div class="budget-bar-row__fill ${cls}" style="--bar-scale:${pct / 100}"></div>
        </div>
        <div class="budget-bar-row__amount" style="color:${isExpense ? 'var(--color-danger)' : 'var(--color-success)'};">
          ${isExpense ? '' : '+'}${formatAmount(c.total)}
        </div>
      </div>
    `;
  }).join('');
}

function renderEntries() {
  if (!state.entries.length) {
    return `<div class="empty-state">
      <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <line x1="12" y1="1" x2="12" y2="23"/>
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
      </svg>
      <div class="empty-state__title">${t('budget.emptyTitle')}</div>
      <div class="empty-state__description">${t('budget.emptyDescription')}</div>
      <p class="empty-state__hint">${t('emptyHint.budget')}</p>
      <button class="btn btn--primary empty-state__cta" id="empty-cta-budget">
        <i data-lucide="plus" aria-hidden="true" class="icon-md"></i>
        ${t('budget.emptyAction')}
      </button>
    </div>`;
  }

  return state.entries.map((e) => {
    const isIncome  = e.amount > 0;
    const amtClass  = isIncome ? 'budget-entry__amount--income' : 'budget-entry__amount--expenses';
    const indClass  = isIncome ? 'budget-entry__indicator--income' : 'budget-entry__indicator--expenses';
    const sign      = isIncome ? '+' : '';
    const date      = formatEntryDate(e.date);
    const recurTag  = e.is_recurring
      ? ` <span class="budget-recur-mark" role="img" aria-label="${t('budget.recurringLabel')}">🔁</span>${e.recurrence_virtual ? ' ' + t('budget.virtualBudgetBadge') : ''}`
      : (e.recurrence_parent_id ? ` <span class="budget-recur-mark" role="img" aria-label="${t('budget.recurringInstanceLabel')}">↩</span>` : '');
    const categoryMeta = isIncome || !e.subcategory
      ? categoryLabel(e.category)
      : `${categoryLabel(e.category)} · ${subcategoryLabel(e.subcategory)}`;
    const sourceMeta = e.assignee_count > 1
      ? (e.is_readonly && e.owner_name
          ? `${t('budget.sharedFromBudget', { owner: t('budget.viewHousehold') })}`
          : `${t('budget.assigneesLabel')}: ${e.assignee_count} · ${t('budget.viewHousehold')}`)
      : '';
    const canOpenParent = state.budgetMode === 'personal'
      && state.budgetView === 'mine'
      && e.assignee_count > 1
      && _user?.role === 'admin';
    const parentAction = canOpenParent
      ? ` <button class="budget-entry__meta-action" type="button" data-action="open-parent" data-id="${e.id}">${t('common.edit')} ${t('budget.viewHousehold')}</button>`
      : '';

    return `
      <div class="budget-entry" data-id="${e.id}">
        <div class="budget-entry__indicator ${indClass}"></div>
        <div class="budget-entry__body">
          <div class="budget-entry__title">${esc(e.title)}</div>
          <div class="budget-entry__meta">${date} · ${esc(categoryMeta)}${recurTag}${sourceMeta ? ` · ${esc(sourceMeta)}` : ''}${parentAction}</div>
        </div>
        <div class="budget-entry__amount ${amtClass}">${sign}${formatAmount(e.amount)}</div>
        ${(!e.is_readonly) ? `<div class="budget-entry__actions">
          ${e.is_readonly ? '' : `<button class="budget-entry__action budget-entry__delete" data-action="delete" data-id="${e.id}" aria-label="${t('budget.deleteLabel')}">
            <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
          </button>`}
        </div>` : ''}
      </div>
    `;
  }).join('');
}

function renderLoansDashboard() {
  const loans = state.loans?.loans ?? [];
  if (!loans.length) return '';

  const summary = state.loans?.summary ?? {};
  const visibleLoans = filteredLoans();

  return `
    <section class="budget-loans">
      <div class="budget-loans__header">
        <div>
          <div class="budget-loans__eyebrow">${t('budget.loansTitle')}</div>
          <div class="budget-loans__summary">${t('budget.loansSummary', {
            count: summary.active_count ?? 0,
            amount: formatAmount(summary.remaining_amount ?? 0),
          })}</div>
          ${state.loanFilterId ? `<div class="budget-list-header__filter">${esc(activeLoanLabel())}</div>` : ''}
        </div>
        <div class="budget-loans__filters" role="group" aria-label="${t('budget.loanStatusFilterLabel')}">
          ${state.loanFilterId ? `
          <button class="budget-loans__filter" type="button" id="budget-clear-loan-filter">
            <i data-lucide="x" aria-hidden="true"></i>${t('budget.clearLoanFilter')}
          </button>` : ''}
          <button class="budget-loans__filter ${state.loanStatusFilter === 'active' ? 'budget-loans__filter--active' : ''}"
                  type="button" data-loan-status="active">${t('budget.loanStatusActive')}</button>
          <button class="budget-loans__filter ${state.loanStatusFilter === 'paid' ? 'budget-loans__filter--active' : ''}"
                  type="button" data-loan-status="paid">${t('budget.loanStatusPaid')}</button>
          <button class="budget-loans__filter ${state.loanStatusFilter === 'all' ? 'budget-loans__filter--active' : ''}"
                  type="button" data-loan-status="all">${t('budget.loanStatusAll')}</button>
        </div>
      </div>
      <div class="budget-loans__stats">
        <div>
          <span>${t('budget.loanRemainingAmount')}</span>
          <strong>${formatAmount(summary.remaining_amount ?? 0)}</strong>
        </div>
        <div>
          <span>${t('budget.loanRemainingInstallments')}</span>
          <strong>${summary.remaining_installments ?? 0}</strong>
        </div>
        <div>
          <span>${t('budget.loanPaidAmount')}</span>
          <strong>${formatAmount(summary.paid_amount ?? 0)}</strong>
        </div>
      </div>
      ${visibleLoans.length ? `
        <div class="budget-loans__list">
          ${visibleLoans.map(renderLoanCard).join('')}
        </div>
      ` : `
        <div class="budget-loans__empty">${t('budget.loansEmpty')}</div>
      `}
      ${renderLoanTransactions(visibleLoans)}
    </section>
  `;
}

function filteredLoans() {
  const loans = state.loans?.loans ?? [];
  return loans.filter((loan) => {
    const matchesStatus = state.loanStatusFilter === 'all' || loan.status === state.loanStatusFilter;
    const matchesLoan = !state.loanFilterId || loan.id === state.loanFilterId;
    return matchesStatus && matchesLoan;
  });
}

function activeLoanLabel() {
  const loan = state.loans.loans.find((item) => item.id === state.loanFilterId);
  return loan ? t('budget.loanFilterActive', { title: loan.title }) : '';
}

function loanPaymentsFor(loans) {
  return loans.flatMap((loan) => (loan.payments ?? []).map((payment) => ({ ...payment, loan })))
    .sort((a, b) => new Date(b.paid_date) - new Date(a.paid_date) || b.installment_number - a.installment_number);
}

function renderLoanTransactions(loans) {
  const payments = loanPaymentsFor(loans);
  if (!payments.length) return '';

  return `<div class="budget-loan-transactions">
    <div class="budget-loan-transactions__title">${t('budget.loanTransactions')}</div>
    <div class="budget-loan-transactions__list">
      ${payments.map(({ loan, ...payment }) => renderLoanPaymentEntry(loan, payment)).join('')}
    </div>
  </div>`;
}

function loanPaymentToEntry(loan, payment) {
  if (!payment.budget_entry_id) return null;
  return {
    id: payment.budget_entry_id,
    title: payment.entry_title || `Loan repayment: ${loan.borrower}`,
    amount: Number(payment.amount || 0),
    category: payment.entry_category || 'Geschenke & Transfers',
    subcategory: payment.entry_subcategory || '',
    date: payment.paid_date,
    is_recurring: payment.entry_is_recurring || 0,
    recurrence_parent_id: payment.entry_recurrence_parent_id || null,
  };
}

function renderLoanPaymentEntry(loan, payment) {
  const entry = loanPaymentToEntry(loan, payment);
  const meta = `${formatEntryDate(payment.paid_date)} · ${esc(loan.title)} · ${t('budget.loanInstallmentNumber', {
    number: payment.installment_number,
    total: loan.installment_count,
  })}`;

  return `
    <div class="budget-entry budget-entry--loan" data-loan-payment-id="${payment.id}" data-loan-id="${loan.id}" ${entry ? `data-entry-id="${entry.id}"` : ''}>
      <div class="budget-entry__indicator budget-entry__indicator--income"></div>
      <div class="budget-entry__body">
        <div class="budget-entry__title">${esc(payment.entry_title || t('budget.loanPaymentTitle', { borrower: loan.borrower }))}</div>
        <div class="budget-entry__meta">${meta}</div>
      </div>
      <div class="budget-entry__amount budget-entry__amount--income">+${formatAmount(payment.amount)}</div>
      <div class="budget-entry__actions">
        ${entry ? `
        <button class="budget-entry__action" data-action="loan-payment-edit" data-loan-id="${loan.id}" data-payment-id="${payment.id}" data-entry-id="${entry.id}" aria-label="${t('common.edit')}">
          <i data-lucide="pencil" class="icon-md" aria-hidden="true"></i>
        </button>` : ''}
        <button class="budget-entry__action budget-entry__delete" data-action="loan-payment-delete" data-loan-id="${loan.id}" data-payment-id="${payment.id}" data-entry-id="${entry?.id ?? ''}" aria-label="${t('budget.deleteLabel')}">
          <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;
}

function renderLoansPage() {
  const loans = state.loans?.loans ?? [];
  if (!loans.length) {
    return `<div class="budget-tab-panel budget-tab-panel--loans">
      <div class="empty-state">
        <i data-lucide="hand-coins" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${t('budget.loansEmpty')}</div>
        <div class="empty-state__description">${t('budget.loansEmptyDescription')}</div>
        <button class="btn btn--primary empty-state__cta" id="budget-empty-loan">
          <i data-lucide="plus" aria-hidden="true" class="icon-md"></i>
          ${t('budget.newLoan')}
        </button>
      </div>
    </div>`;
  }

  return `<div class="budget-tab-panel budget-tab-panel--loans">
    ${renderLoansDashboard()}
  </div>`;
}

function wireLoansPage() {
  _container.querySelector('#budget-empty-loan')?.addEventListener('click', () => openBudgetModal({ mode: 'create', initialType: 'loan' }));
  _container.querySelector('#budget-clear-loan-filter')?.addEventListener('click', () => {
    state.loanFilterId = null;
    renderBody();
  });
  _container.querySelectorAll('[data-loan-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.loanStatusFilter = btn.dataset.loanStatus;
      renderBody();
    });
  });
  _container.querySelectorAll('.budget-loan-card[data-loan-id]').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('button, a')) return;
      const loan = state.loans.loans.find((item) => item.id === parseInt(card.dataset.loanId, 10));
      if (loan) openLoanReport(loan);
    });
  });
  _container.querySelectorAll('[data-action="loan-pay"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await markLoanPayment(parseInt(btn.dataset.id, 10));
    });
  });
  _container.querySelectorAll('[data-action="loan-edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const loan = state.loans.loans.find((item) => item.id === parseInt(btn.dataset.id, 10));
      if (loan) openLoanModal(loan);
    });
  });
  _container.querySelectorAll('[data-action="loan-delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLoan(parseInt(btn.dataset.id, 10));
    });
  });
  _container.querySelectorAll('[data-action="loan-filter"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id, 10);
      state.loanFilterId = state.loanFilterId === id ? null : id;
      renderBody();
    });
  });
  _container.querySelectorAll('[data-action="loan-payment-edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const loan = state.loans.loans.find((item) => item.id === parseInt(btn.dataset.loanId, 10));
      const payment = loan?.payments?.find((item) => item.id === parseInt(btn.dataset.paymentId, 10));
      const entry = state.entries.find((item) => item.id === parseInt(btn.dataset.entryId, 10))
        || (loan && payment ? loanPaymentToEntry(loan, payment) : null);
      if (entry) openBudgetModal({ mode: 'edit', entry });
    });
  });
  _container.querySelectorAll('[data-action="loan-payment-delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLoanPayment(parseInt(btn.dataset.loanId, 10), parseInt(btn.dataset.paymentId, 10));
    });
  });
}

function openLoanReport(loan) {
  const payments = (loan.payments ?? []).slice()
    .sort((a, b) => new Date(b.paid_date) - new Date(a.paid_date) || b.installment_number - a.installment_number);
  const content = `
    <div class="loan-report">
      <div class="loan-report__hero">
        <div>
          <div class="loan-report__borrower">${esc(loan.borrower)}</div>
          <div class="loan-report__title">${esc(loan.title)}</div>
        </div>
        <span class="loan-report__status loan-report__status--${loan.status}">
          ${loan.status === 'paid' ? t('budget.loanStatusPaid') : t('budget.loanStatusActive')}
        </span>
      </div>
      <div class="loan-report__grid">
        <div><span>${t('budget.loanAmountLabel')}</span><strong>${formatAmount(loan.total_amount)}</strong></div>
        <div><span>${t('budget.loanRemainingAmount')}</span><strong>${formatAmount(loan.remaining_amount)}</strong></div>
        <div><span>${t('budget.loanPaidAmount')}</span><strong>${formatAmount(loan.paid_amount)}</strong></div>
        <div><span>${t('budget.loanRemainingInstallments')}</span><strong>${loan.remaining_installments}</strong></div>
      </div>
      <div class="loan-report__section-title">${t('budget.loanTransactions')}</div>
      ${payments.length ? `
        <div class="loan-report__transactions">
          ${payments.map((payment) => `
            <div class="budget-loan-transaction">
              <div>
                <strong>${t('budget.loanInstallmentNumber', { number: payment.installment_number, total: loan.installment_count })}</strong>
                <span>${formatEntryDate(payment.paid_date)}</span>
              </div>
              <div>
                <strong>${formatAmount(payment.amount)}</strong>
              </div>
            </div>
          `).join('')}
        </div>
      ` : `<div class="budget-loans__empty">${t('budget.loanNoTransactions')}</div>`}
    </div>
    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      <div></div>
      <button class="btn btn--primary" id="loan-report-close">${t('common.close')}</button>
    </div>`;

  openSharedModal({
    title: t('budget.loanReportTitle'),
    content,
    size: 'md',
    onSave(panel) {
      panel.querySelector('#loan-report-close')?.addEventListener('click', closeModal);
    },
  });
}

function renderLoanCard(loan) {
  const paidPct = Math.min(100, Math.round((loan.paid_amount / loan.total_amount) * 100));
  const nextDue = loan.next_due_month ? formatMonthLabel(loan.next_due_month) : t('budget.loanPaidStatus');
  const payDisabled = loan.remaining_installments <= 0 ? 'disabled' : '';

  return `
    <article class="budget-loan-card" data-loan-id="${loan.id}">
      <div class="budget-loan-card__main">
        <div class="budget-loan-card__title-row">
          <div class="budget-loan-card__title">${esc(loan.title)}</div>
          <button class="budget-loan-card__filter ${state.loanFilterId === loan.id ? 'budget-loan-card__filter--active' : ''}" data-action="loan-filter" data-id="${loan.id}" aria-label="${t('budget.filterLoanTransactions')}">
            <i data-lucide="filter" aria-hidden="true"></i>
          </button>
        </div>
        <div class="budget-loan-card__meta">${esc(loan.borrower)} · ${t('budget.loanInstallmentMeta', {
          paid: loan.paid_installments,
          total: loan.installment_count,
        })}</div>
      </div>
      <div class="budget-loan-card__amounts">
        <strong>${formatAmount(loan.remaining_amount)}</strong>
        <span>${t('budget.loanRemainingOf', { total: formatAmount(loan.total_amount) })}</span>
      </div>
      <div class="budget-loan-card__progress" role="progressbar"
           aria-valuenow="${paidPct}" aria-valuemin="0" aria-valuemax="100"
           aria-label="${t('budget.loanProgressLabel')}">
        <span style="--bar-scale:${paidPct / 100}"></span>
      </div>
      <div class="budget-loan-card__footer">
        <span>${t('budget.loanNextDue', { month: nextDue })}</span>
        <div class="budget-loan-card__actions">
          <button class="btn btn--secondary btn--icon" data-action="loan-edit" data-id="${loan.id}" aria-label="${t('budget.editLoan')}">
            <i data-lucide="pencil" aria-hidden="true"></i>
          </button>
          <button class="btn btn--secondary btn--icon" data-action="loan-delete" data-id="${loan.id}" aria-label="${t('budget.deleteLoan')}">
            <i data-lucide="trash-2" aria-hidden="true"></i>
          </button>
          <button class="btn btn--primary" data-action="loan-pay" data-id="${loan.id}" ${payDisabled}>
            ${t('budget.markLoanPaid')}
          </button>
        </div>
      </div>
    </article>
  `;
}

/**
 * Rendert eine Trend-Zeile im Vergleich zum Vormonat.
 * Alle drei Metriken (income, expenses, balance) nutzen dieselbe Logik:
 *   delta > 0 → positiver Trend (▲ grün), delta < 0 → negativer Trend (▼ rot).
 * Ausgaben werden als negative Zahlen übergeben, daher gilt:
 *   weniger Ausgaben ↔ delta > 0 ↔ gut.
 * @param {number} current   Aktueller Wert
 * @param {number} prev      Vormonatswert
 * @param {string} prevLabel Kurzname des Vormonats (z.B. "Mär")
 */
function renderTrend(current, prev, prevLabel) {
  const delta = current - prev;
  if (Math.abs(delta) < 0.005) {
    return `<div class="budget-summary-card__trend budget-summary-card__trend--neutral">${t('budget.trendNeutral', { month: prevLabel })}</div>`;
  }
  const positive = delta > 0;
  const arrow    = positive ? '▲' : '▼';
  const sign     = positive ? '+' : '';
  const cls      = positive ? 'budget-summary-card__trend--positive' : 'budget-summary-card__trend--negative';
  return `<div class="budget-summary-card__trend ${cls}">${arrow} ${sign}${formatAmount(delta)} vs. ${prevLabel}</div>`;
}

function formatEntryDate(dateStr) {
  return formatDate(dateStr);
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

function openCategoryManager() {
  let manager = null;
  const onChanged = async () => {
    await loadBudgetMeta();
    renderBody();
  };
  openSharedModal({
    title: t('budget.manageCategories'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    size: 'lg',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/budget/categories',
        groups: [
          { key: 'expense', labelKey: 'budget.expenses', addLabelKey: 'budget.addCategory', subcategories: true },
          { key: 'income',  labelKey: 'budget.income',   addLabelKey: 'budget.addCategory' },
        ],
        supportsSubcategories: true,
        labelResolver: (item) => item.label ?? budgetCategoryLabel(item.key, item.name, t),
        titleKey: 'budget.manageCategories',
        hintKey: 'category.manageHint',
      });
    },
    onClose: () => manager?.removeEventListener('category-manager-changed', onChanged),
  });
}

function renderBudgetAssignmentEditor(assignments = [], splitMethod = 'equal') {
  const selectedIds = assignments.map((assignment) => assignment.user_id);
  const rows = assignments.map((assignment) => {
    const member = state.familyMembers.find((item) => item.id === assignment.user_id);
    if (!member) return '';
    return `
      <div class="budget-assignment-row" data-user-id="${assignment.user_id}">
        <span class="budget-assignment-row__name">${esc(member.display_name)}</span>
        <input class="form-input budget-assignment-row__value" type="number" step="0.01"
               value="${splitMethod === 'percentage' ? esc(String(assignment.share_percentage ?? '')) : esc(String(assignment.share_amount ?? ''))}">
      </div>`;
  }).join('');
  return `
    <div class="budget-assignment-editor" id="budget-assignment-editor">
      <div class="budget-assignment-editor__heading">${t('budget.assigneesLabel')}</div>
      ${renderUserMultiSelect(state.familyMembers, selectedIds, 'budget-assignees', 'budget.assigneesLabel')}
      <div class="form-hint">${selectedIds.length > 1 ? t('budget.multiAssigneeHint') : t('budget.singleAssigneeHint')}</div>
      <div class="form-group">
        <label class="form-label" for="budget-split-method">${t('budget.splitSectionLabel')}</label>
        <select class="form-input" id="budget-split-method">
          <option value="equal" ${splitMethod === 'equal' ? 'selected' : ''}>${t('splitExpenses.splitEqual')}</option>
          <option value="exact" ${splitMethod === 'exact' ? 'selected' : ''}>${t('splitExpenses.splitExact')}</option>
          <option value="percentage" ${splitMethod === 'percentage' ? 'selected' : ''}>${t('splitExpenses.splitPercentage')}</option>
        </select>
      </div>
      <div class="budget-assignment-editor__rows" id="budget-assignment-rows">${rows}</div>
    </div>`;
}

function bindBudgetAssignmentEditor(panel, initialAssignments = [], initialSplitMethod = 'equal') {
  bindUserMultiSelect(panel, 'budget-assignees');
  const methodEl = panel.querySelector('#budget-split-method');
  const rowsEl = panel.querySelector('#budget-assignment-rows');
  const hintEl = panel.querySelector('.budget-assignment-editor .form-hint');
  const renderRows = () => {
    const selectedIds = getSelectedUserIds(panel, 'budget-assignees');
    const existing = new Map(initialAssignments.map((assignment) => [assignment.user_id, assignment]));
    const splitMethod = methodEl?.value || initialSplitMethod;
    if (hintEl) hintEl.textContent = selectedIds.length > 1 ? t('budget.multiAssigneeHint') : t('budget.singleAssigneeHint');
    rowsEl.replaceChildren();
    if (splitMethod === 'equal' || selectedIds.length <= 1) return;
    rowsEl.insertAdjacentHTML('beforeend', selectedIds.map((userId) => {
      const member = state.familyMembers.find((item) => item.id === userId);
      const current = existing.get(userId);
      return `
        <div class="budget-assignment-row" data-user-id="${userId}">
          <span class="budget-assignment-row__name">${esc(member?.display_name || '')}</span>
          <input class="form-input budget-assignment-row__value" type="number" step="0.01"
                 value="${splitMethod === 'percentage' ? esc(String(current?.share_percentage ?? '')) : esc(String(current?.share_amount ?? ''))}">
        </div>`;
    }).join(''));
  };
  panel.querySelector('.user-ms[data-ms-name="budget-assignees"]')?.addEventListener('change', renderRows);
  methodEl?.addEventListener('change', renderRows);
  renderRows();
}

function collectBudgetAssignments(panel) {
  const selectedIds = getSelectedUserIds(panel, 'budget-assignees');
  const splitMethod = panel.querySelector('#budget-split-method')?.value || 'equal';
  if (!selectedIds.length) return { split_method: splitMethod, assignments: [] };
  if (splitMethod === 'equal' || selectedIds.length === 1) {
    return { split_method: splitMethod, assignments: selectedIds.map((user_id) => ({ user_id })) };
  }
  const assignments = selectedIds.map((user_id) => {
    const row = panel.querySelector(`.budget-assignment-row[data-user-id="${user_id}"] .budget-assignment-row__value`);
    const value = row?.value?.trim() || '';
    return splitMethod === 'percentage'
      ? { user_id, share_percentage: value }
      : { user_id, share_amount: value };
  });
  return { split_method: splitMethod, assignments };
}

function validateBudgetAssignments(panel, amount) {
  const { split_method, assignments } = collectBudgetAssignments(panel);
  if (assignments.length <= 1 || split_method === 'equal') return null;
  if (split_method === 'percentage') {
    const total = assignments.reduce((sum, assignment) => sum + Number(assignment.share_percentage || 0), 0);
    if (Math.abs(total - 100) > 0.01) return t('splitExpenses.splitHint.percentage');
  }
  if (split_method === 'exact') {
    const total = assignments.reduce((sum, assignment) => sum + Number(assignment.share_amount || 0), 0);
    if (Math.abs(total - Math.abs(Number(amount || 0))) > 0.01) return t('splitExpenses.splitHint.exact');
  }
  return null;
}

function openBudgetModal({ mode, entry = null, initialType = '' }) {
  const isEdit = mode === 'edit';
  const today  = toLocalDateKey(new Date());
  const todayMonth = today.slice(0, 7);

  const isExpense  = isEdit ? entry.amount < 0 : true;
  // Bei virtuellen Serien hält amount nur den Monatsanteil; im Formular den eingegebenen Periodenbetrag zeigen.
  const editAmount = isEdit && entry.recurrence_virtual && entry.recurrence_full_amount != null
    ? entry.recurrence_full_amount
    : (isEdit ? entry.amount : 0);
  const absAmount  = isEdit ? Math.abs(editAmount).toFixed(2) : '';
  const curInterval = isEdit && entry.recurrence_interval ? entry.recurrence_interval : 'monthly';
  const intervalOption = (val, key) =>
    `<option value="${val}" ${curInterval === val ? 'selected' : ''}>${t(key)}</option>`;

  const initialCats = isExpense ? expenseCategories() : incomeCategories();
  const catOpts     = initialCats.map((c) =>
    `<option value="${esc(c.key)}" ${isEdit && entry.category === c.key ? 'selected' : ''}>${esc(categoryLabel(c))}</option>`
  ).join('');
  const initialCategory = isEdit ? entry.category : initialCats[0]?.key;
  const initialSubcategory = isEdit ? entry.subcategory : defaultSubcategory(initialCategory);
  const subcatOpts = getSubcategories(initialCategory).map((s) =>
    `<option value="${esc(s.key)}" ${initialSubcategory === s.key ? 'selected' : ''}>${esc(subcategoryLabel(s))}</option>`
  ).join('');
  const assignmentSection = state.budgetMode === 'personal'
    ? renderBudgetAssignmentEditor(isEdit ? (entry.assignments || []) : [], isEdit ? (entry.split_method || 'equal') : 'equal')
    : '';
  const viewHint = state.budgetMode === 'personal' ? `<div class="form-hint">${t('budget.viewMine')}</div>` : '';

  const content = `
    <div class="amount-type-toggle ${isEdit ? 'amount-type-toggle--entry-only' : ''}">
      <button class="amount-type-btn amount-type-btn--expenses ${isExpense ? 'amount-type-btn--active' : ''}"
              id="type-expense" type="button">${t('budget.typeExpense')}</button>
      <button class="amount-type-btn amount-type-btn--income ${!isExpense ? 'amount-type-btn--active' : ''}"
              id="type-income" type="button">${t('budget.typeIncome')}</button>
      ${!isEdit ? `<button class="amount-type-btn amount-type-btn--loan"
              id="type-loan" type="button">${t('budget.typeLoan')}</button>` : ''}
    </div>

    <div class="form-group js-entry-field">
      <label class="form-label" for="bm-title">${t('budget.titleLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
      <input type="text" class="form-input" id="bm-title"
             placeholder="${t('budget.titlePlaceholder')}" value="${esc(isEdit ? entry.title : '')}">
    </div>

    <div class="form-group js-entry-field">
      <label class="form-label" for="bm-amount">${t('budget.amountLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
      <input type="number" class="form-input" id="bm-amount"
             placeholder="${t('budget.amountPlaceholder')}" step="0.01" min="0.01"
             inputmode="decimal" value="${absAmount}">
    </div>

    <div class="form-group js-entry-field">
      <div class="budget-field-header">
        <label class="form-label" for="bm-category">${t('budget.categoryLabel')}</label>
        <button class="btn btn--secondary budget-inline-add" type="button" id="bm-add-category">${t('budget.addCategory')}</button>
      </div>
      <select class="form-input" id="bm-category">${catOpts}</select>
    </div>

    <div class="form-group js-entry-field">
      <label class="form-label" for="bm-date">${t('budget.dateLabel')}</label>
      <input type="date" class="form-input" id="bm-date"
             value="${isEdit ? entry.date : today}">
    </div>

    ${state.budgetMode === 'personal' ? `<div class="js-entry-field">${viewHint}${assignmentSection}</div>` : ''}

    <div class="js-entry-field">
      ${advancedSection(`
        <div class="form-group" id="bm-subcategory-group" ${isExpense ? '' : 'hidden'}>
          <div class="budget-field-header">
            <label class="form-label" for="bm-subcategory">${t('budget.subcategoryLabel')}</label>
            <button class="btn btn--secondary budget-inline-add" type="button" id="bm-add-subcategory">${t('budget.addSubcategory')}</button>
          </div>
          <select class="form-input" id="bm-subcategory">${subcatOpts}</select>
        </div>

        <div class="form-group">
          <label class="toggle">
            <input type="checkbox" id="bm-recurring" ${isEdit && entry.is_recurring ? 'checked' : ''}>
            <span class="toggle__track"></span>
            <span>${t('budget.recurringLabel')}</span>
          </label>
        </div>

        <div class="form-group" id="bm-recurrence-options" ${isEdit && entry.is_recurring ? '' : 'hidden'}>
          <label class="form-label" for="bm-interval">${t('budget.recurringIntervalLabel')}</label>
          <select class="form-input" id="bm-interval">
            ${intervalOption('monthly', 'budget.intervalMonthly')}
            ${intervalOption('half_year', 'budget.intervalHalfYear')}
            ${intervalOption('yearly', 'budget.intervalYearly')}
          </select>
          <label class="toggle" style="margin-top:var(--space-3)">
            <input type="checkbox" id="bm-virtual" ${isEdit && entry.recurrence_virtual ? 'checked' : ''}>
            <span class="toggle__track"></span>
            <span>${t('budget.virtualBudgetLabel')}</span>
          </label>
          <p style="color:var(--color-text-secondary);font-size:var(--text-sm);margin-top:var(--space-1)">${t('budget.virtualBudgetHint')}</p>
        </div>`,
        { open: isEdit && (entry.is_recurring || !!entry.subcategory) })}
    </div>

    <div id="bm-loan-fields" hidden>
      <div class="form-group">
        <label class="form-label" for="lm-borrower">${t('budget.loanBorrowerLabel')}</label>
        <input type="text" class="form-input" id="lm-borrower"
               placeholder="${t('budget.loanBorrowerPlaceholder')}">
      </div>
      <div class="form-group">
        <label class="form-label" for="lm-title">${t('budget.loanTitleLabel')}</label>
        <input type="text" class="form-input" id="lm-title"
               placeholder="${t('budget.loanTitlePlaceholder')}">
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label class="form-label" for="lm-amount">${t('budget.loanAmountLabel')}</label>
          <input type="number" class="form-input" id="lm-amount" step="0.01" min="0.01" inputmode="decimal">
        </div>
        <div class="form-group">
          <label class="form-label" for="lm-installments">${t('budget.loanInstallmentsLabel')}</label>
          <input type="number" class="form-input" id="lm-installments" step="1" min="1" max="240" inputmode="numeric">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="lm-start">${t('budget.loanStartMonthLabel')}</label>
        <input type="month" class="form-input" id="lm-start" value="${todayMonth}">
      </div>
      <div class="form-group">
        <label class="form-label" for="lm-notes">${t('budget.loanNotesLabel')}</label>
        <textarea class="form-input" id="lm-notes" rows="3"></textarea>
      </div>
    </div>

    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      ${isEdit ? `<button class="btn btn--danger btn--icon" id="bm-delete" aria-label="${t('budget.deleteLabel')}">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
      </button>` : '<div></div>'}
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="bm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="bm-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>`;

  openSharedModal({
    title: isEdit ? t('budget.editEntry') : t('budget.newEntry'),
    content,
    size: 'sm',
    onSave(panel) {
      let currentType = !isEdit && initialType === 'loan' ? 'loan' : (isExpense ? 'expense' : 'income');

      const setType = (type) => {
        currentType = type;
        panel.querySelector('#type-expense').classList.toggle('amount-type-btn--active', type === 'expense');
        panel.querySelector('#type-income').classList.toggle('amount-type-btn--active', type === 'income');
        panel.querySelector('#type-loan')?.classList.toggle('amount-type-btn--active', type === 'loan');
        panel.querySelectorAll('.js-entry-field').forEach((el) => { el.hidden = type === 'loan'; });
        panel.querySelector('#bm-loan-fields').hidden = type !== 'loan';
        // Wiederkehrungs-Optionen nur zeigen, wenn "Wiederkehrend" aktiv ist.
        if (type !== 'loan') {
          panel.querySelector('#bm-recurrence-options').hidden = !panel.querySelector('#bm-recurring').checked;
        }
        panel.querySelector('#bm-save').textContent = type === 'loan'
          ? t('budget.createLoan')
          : (isEdit ? t('common.save') : t('common.add'));
        if (type !== 'loan') updateCategoryOptions();
      };

      const updateCategoryOptions = (preferredCategory = '') => {
        const cats = currentType === 'income' ? incomeCategories() : expenseCategories();
        const catSelect = panel.querySelector('#bm-category');
        const currentValue = preferredCategory || catSelect.value;

        const options = cats.map((c) => {
          const opt = document.createElement('option');
          opt.value = c.key;
          opt.textContent = categoryLabel(c);
          opt.selected = currentValue === c.key;
          return opt;
        });
        catSelect.replaceChildren(...options);
        if (!cats.some((c) => c.key === catSelect.value)) catSelect.value = cats[0]?.key || '';
        updateSubcategoryOptions();
      };

      const updateSubcategoryOptions = (preferredSubcategory = '') => {
        const catSelect = panel.querySelector('#bm-category');
        const subcatGroup = panel.querySelector('#bm-subcategory-group');
        const subcatSelect = panel.querySelector('#bm-subcategory');
        const subcategories = currentType === 'expense' ? getSubcategories(catSelect.value) : [];
        const currentValue = preferredSubcategory || subcatSelect.value;

        subcatGroup.hidden = currentType !== 'expense';
        subcatSelect.replaceChildren(...subcategories.map((s) => {
          const opt = document.createElement('option');
          opt.value = s.key;
          opt.textContent = subcategoryLabel(s);
          opt.selected = currentValue === s.key;
          return opt;
        }));
        if (subcategories.length && !subcategories.some((s) => s.key === subcatSelect.value)) {
          subcatSelect.value = subcategories[0].key;
        }
      };

      const addCategory = async () => {
        const name = await requestNameInPanel(panel, {
          title: t('budget.newCategoryTitle'),
          label: t('budget.newCategoryPrompt'),
          placeholder: t('budget.newCategoryPlaceholder'),
        });
        if (!name?.trim()) return;
        try {
          const res = await api.post('/budget/categories', { name: name.trim(), type: currentType });
          await loadBudgetMeta();
          updateCategoryOptions(res.data.key);
          window.yuvomi?.showToast(t('budget.categoryAddedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
        }
      };

      const addSubcategory = async () => {
        if (currentType !== 'expense') return;
        const category = panel.querySelector('#bm-category').value;
        if (!category) return;
        const name = await requestNameInPanel(panel, {
          title: t('budget.newSubcategoryTitle'),
          label: t('budget.newSubcategoryPrompt'),
          placeholder: t('budget.newSubcategoryPlaceholder'),
        });
        if (!name?.trim()) return;
        try {
          const res = await api.post(`/budget/categories/${encodeURIComponent(category)}/subcategories`, { name: name.trim() });
          await loadBudgetMeta();
          updateSubcategoryOptions(res.data.key);
          window.yuvomi?.showToast(t('budget.subcategoryAddedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
        }
      };

      panel.querySelector('#type-expense').addEventListener('click', () => {
        setType('expense');
      });
      panel.querySelector('#type-income').addEventListener('click', () => {
        setType('income');
      });
      panel.querySelector('#type-loan')?.addEventListener('click', () => {
        setType('loan');
      });
      panel.querySelector('#bm-category').addEventListener('change', () => updateSubcategoryOptions());
      panel.querySelector('#bm-recurring').addEventListener('change', (e) => {
        panel.querySelector('#bm-recurrence-options').hidden = !e.target.checked;
      });
      panel.querySelector('#bm-add-category').addEventListener('click', addCategory);
      panel.querySelector('#bm-add-subcategory').addEventListener('click', addSubcategory);
      panel.querySelector('#bm-cancel').addEventListener('click', closeModal);
      if (state.budgetMode === 'personal') bindBudgetAssignmentEditor(panel, entry?.assignments || [], entry?.split_method || 'equal');

      panel.querySelector('#bm-delete')?.addEventListener('click', async () => {
        closeModal({ force: true });
        await deleteEntry(entry.id);
      });

      panel.querySelector('#bm-save').addEventListener('click', async () => {
        const saveBtn    = panel.querySelector('#bm-save');
        if (currentType === 'loan') {
          await saveLoanFromPanel(panel, saveBtn, { closeAfterSave: true });
          return;
        }

        const title      = panel.querySelector('#bm-title').value.trim();
        const absVal     = parseFloat(panel.querySelector('#bm-amount').value);
        const category   = panel.querySelector('#bm-category').value;
        const subcategory = currentType === 'expense' ? panel.querySelector('#bm-subcategory').value : '';
        const date       = panel.querySelector('#bm-date').value;
        const recurring  = panel.querySelector('#bm-recurring').checked ? 1 : 0;
        const interval   = panel.querySelector('#bm-interval').value;
        const virtual    = recurring && panel.querySelector('#bm-virtual').checked ? 1 : 0;
        const assignmentPayload = state.budgetMode === 'personal' ? collectBudgetAssignments(panel) : { split_method: 'equal', assignments: [] };

        if (!title)           { window.yuvomi?.showToast(t('common.titleRequired'), 'error'); return; }
        if (isNaN(absVal) || absVal <= 0) { window.yuvomi?.showToast(t('budget.validAmountRequired'), 'error'); return; }
        if (!date) { window.yuvomi?.showToast(t('calendar.invalidDate'), 'error'); return; }

        const amount = currentType === 'expense' ? -absVal : absVal;
        const assignmentError = state.budgetMode === 'personal' ? validateBudgetAssignments(panel, amount) : null;
        if (assignmentError) { window.yuvomi?.showToast(assignmentError, 'error'); return; }

        saveBtn.disabled    = true;
        saveBtn.textContent = '…';

        try {
          const body = { title, amount, category, subcategory, date, is_recurring: recurring, recurrence_interval: interval, recurrence_virtual: virtual, ...assignmentPayload };
          if (mode === 'create') {
            const res = await api.post('/budget', body);
            state.entries.unshift(res.data);
            await loadMonth(state.month);
            closeModal({ force: true });
            renderBody();
            window.yuvomi?.showToast(t('budget.addedToast'), 'success');
          } else if (entry.recurrence_parent_id) {
            // Kind-Instanz: Nutzer fragen, ob nur dieser oder alle zukünftigen
            saveBtn.disabled = false;
            saveBtn.textContent = t('common.save');
            closeModal({ force: true });
            const scope = await recurringChoiceModal({
              title: t('budget.recurringSeriesScope'),
              thisLabel: t('budget.recurringThisOnly'),
              seriesLabel: t('budget.recurringEditSeries'),
            });
            if (scope === null) { openBudgetModal({ mode: 'edit', entry }); return; }
            if (scope === 'series') {
              await api.put(`/budget/${entry.id}/series`, body);
              window.yuvomi?.showToast(t('budget.recurringSeriesSaved'), 'success');
            } else {
              const res = await api.put(`/budget/${entry.id}`, body);
              const idx = state.entries.findIndex((e) => e.id === entry.id);
              if (idx !== -1) state.entries[idx] = res.data;
              window.yuvomi?.showToast(t('budget.savedToast'), 'success');
            }
            await loadMonth(state.month);
            renderBody();
          } else {
            const res = await api.put(`/budget/${entry.id}`, body);
            const idx = state.entries.findIndex((e) => e.id === entry.id);
            if (idx !== -1) state.entries[idx] = res.data;
            await loadMonth(state.month);
            closeModal({ force: true });
            renderBody();
            window.yuvomi?.showToast(t('budget.savedToast'), 'success');
          }
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
          saveBtn.disabled    = false;
          saveBtn.textContent = isEdit ? t('common.save') : t('common.add');
        }
      });
      setType(currentType);
    },
  });
}

function requestNameInPanel(panel, { title, label, placeholder }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'budget-inline-modal';
    setHtml(overlay, `
      <div class="budget-inline-modal__panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="budget-inline-modal__header">
          <strong>${esc(title)}</strong>
          <button class="btn btn--icon" type="button" data-action="inline-cancel" aria-label="${t('common.cancel')}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </div>
        <div class="form-group">
          <label class="form-label" for="budget-inline-name">${esc(label)}</label>
          <input class="form-input" id="budget-inline-name" type="text" placeholder="${esc(placeholder)}">
        </div>
        <div class="budget-inline-modal__footer">
          <button class="btn btn--secondary" type="button" data-action="inline-cancel">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="button" data-action="inline-save">${t('common.add')}</button>
        </div>
      </div>
    `);
    panel.append(overlay);
    if (window.lucide) lucide.createIcons({ el: overlay });

    const input = overlay.querySelector('#budget-inline-name');
    const cleanup = (value = '') => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelectorAll('[data-action="inline-cancel"]').forEach((btn) => {
      btn.addEventListener('click', () => cleanup(''));
    });
    overlay.querySelector('[data-action="inline-save"]').addEventListener('click', () => {
      cleanup(input.value.trim());
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cleanup(input.value.trim());
      if (e.key === 'Escape') cleanup('');
    });
    input.focus();
  });
}

async function saveLoanFromPanel(panel, saveBtn, { loan = null, closeAfterSave = false } = {}) {
  const isEdit = Boolean(loan);
  const borrower = panel.querySelector('#lm-borrower').value.trim();
  const title = panel.querySelector('#lm-title').value.trim() || borrower;
  const total_amount = parseFloat(panel.querySelector('#lm-amount').value);
  const installment_count = parseInt(panel.querySelector('#lm-installments').value, 10);
  const start_month = panel.querySelector('#lm-start').value;
  const notes = panel.querySelector('#lm-notes').value.trim();

  if (!borrower) { window.yuvomi?.showToast(t('budget.loanBorrowerRequired'), 'error'); return; }
  if (isNaN(total_amount) || total_amount <= 0) { window.yuvomi?.showToast(t('budget.validAmountRequired'), 'error'); return; }
  if (!Number.isInteger(installment_count) || installment_count < 1) { window.yuvomi?.showToast(t('budget.loanInstallmentsRequired'), 'error'); return; }
  if (!/^\d{4}-\d{2}$/.test(start_month)) { window.yuvomi?.showToast(t('budget.loanStartMonthRequired'), 'error'); return; }

  saveBtn.disabled = true;
  saveBtn.textContent = '...';
  try {
    const body = { borrower, title, total_amount, installment_count, start_month, notes };
    if (isEdit) {
      await api.put(`/budget/loans/${loan.id}`, body);
    } else {
      await api.post('/budget/loans', body);
    }
    await loadMonth(state.month);
    if (closeAfterSave) closeModal({ force: true });
    renderBody();
    window.yuvomi?.showToast(isEdit ? t('budget.loanSavedToast') : t('budget.loanAddedToast'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = isEdit ? t('common.save') : t('budget.createLoan');
  }
}

function openLoanModal(loan = null) {
  const isEdit = Boolean(loan);
  const todayMonth = toLocalDateKey(new Date()).slice(0, 7);
  const content = `
    <div class="form-group">
      <label class="form-label" for="lm-borrower">${t('budget.loanBorrowerLabel')}</label>
      <input type="text" class="form-input" id="lm-borrower"
             placeholder="${t('budget.loanBorrowerPlaceholder')}" value="${esc(loan?.borrower ?? '')}">
    </div>
    <div class="form-group">
      <label class="form-label" for="lm-title">${t('budget.loanTitleLabel')}</label>
      <input type="text" class="form-input" id="lm-title"
             placeholder="${t('budget.loanTitlePlaceholder')}" value="${esc(loan?.title ?? '')}">
    </div>
    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" for="lm-amount">${t('budget.loanAmountLabel')}</label>
        <input type="number" class="form-input" id="lm-amount" step="0.01" min="0.01"
               inputmode="decimal" value="${loan ? loan.total_amount.toFixed(2) : ''}">
      </div>
      <div class="form-group">
        <label class="form-label" for="lm-installments">${t('budget.loanInstallmentsLabel')}</label>
        <input type="number" class="form-input" id="lm-installments" step="1" min="1" max="240"
               inputmode="numeric" value="${loan?.installment_count ?? ''}">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="lm-start">${t('budget.loanStartMonthLabel')}</label>
      <input type="month" class="form-input" id="lm-start" value="${esc(loan?.start_month ?? todayMonth)}">
    </div>
    <div class="form-group">
      <label class="form-label" for="lm-notes">${t('budget.loanNotesLabel')}</label>
      <textarea class="form-input" id="lm-notes" rows="3">${esc(loan?.notes ?? '')}</textarea>
    </div>
    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      <div></div>
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="lm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="lm-save">${isEdit ? t('common.save') : t('budget.createLoan')}</button>
      </div>
    </div>`;

  openSharedModal({
    title: isEdit ? t('budget.editLoan') : t('budget.newLoan'),
    content,
    size: 'sm',
    onSave(panel) {
      panel.querySelector('#lm-cancel').addEventListener('click', closeModal);
      panel.querySelector('#lm-save').addEventListener('click', async () => {
        const saveBtn = panel.querySelector('#lm-save');
        await saveLoanFromPanel(panel, saveBtn, { loan, closeAfterSave: true });
      });
    },
  });
}

function openLoanPaymentModal(loan) {
  if (!loan?.next_installment_number) return;
  const today = toLocalDateKey(new Date());
  const assignmentSection = state.budgetMode === 'personal'
    ? renderBudgetAssignmentEditor([], 'equal')
    : '';
  const content = `
    <div class="form-group">
      <label class="form-label" for="lpm-amount">${t('budget.amountLabel')}</label>
      <input type="number" class="form-input" id="lpm-amount" step="0.01" min="0.01" inputmode="decimal"
             value="${(loan.next_installment_number === loan.installment_count ? loan.remaining_amount : Math.min(loan.installment_amount, loan.remaining_amount)).toFixed(2)}">
    </div>
    <div class="form-group">
      <label class="form-label" for="lpm-date">${t('splitExpenses.date')}</label>
      <input type="date" class="form-input" id="lpm-date" value="${today}">
    </div>
    ${state.budgetMode === 'personal' ? assignmentSection : ''}
    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      <div></div>
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="lpm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="lpm-save">${t('budget.markLoanPaid')}</button>
      </div>
    </div>`;

  openSharedModal({
    title: t('budget.markLoanPaid'),
    content,
    size: 'sm',
    onSave(panel) {
      panel.querySelector('#lpm-cancel')?.addEventListener('click', closeModal);
      if (state.budgetMode === 'personal') bindBudgetAssignmentEditor(panel, [], 'equal');
      panel.querySelector('#lpm-save')?.addEventListener('click', async () => {
        const saveBtn = panel.querySelector('#lpm-save');
        const amount = parseFloat(panel.querySelector('#lpm-amount').value);
        const paid_date = panel.querySelector('#lpm-date').value;
        if (isNaN(amount) || amount <= 0) { window.yuvomi?.showToast(t('budget.validAmountRequired'), 'error'); return; }
        if (!paid_date) { window.yuvomi?.showToast(t('calendar.invalidDate'), 'error'); return; }
        const assignmentPayload = state.budgetMode === 'personal' ? collectBudgetAssignments(panel) : { split_method: 'equal', assignments: [] };
        const assignmentError = state.budgetMode === 'personal' ? validateBudgetAssignments(panel, amount) : null;
        if (assignmentError) { window.yuvomi?.showToast(assignmentError, 'error'); return; }
        saveBtn.disabled = true;
        try {
          await api.post(`/budget/loans/${loan.id}/payments`, { installment_number: loan.next_installment_number, amount, paid_date, ...assignmentPayload });
          await loadMonth(state.month);
          closeModal({ force: true });
          renderBody();
          window.yuvomi?.showToast(t('budget.loanPaymentAddedToast'), 'success');
        } catch (err) {
          saveBtn.disabled = false;
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
        }
      });
    },
  });
}

async function markLoanPayment(id) {
  const loan = state.loans.loans.find((item) => item.id === id);
  if (!loan?.next_installment_number) return;
  if (state.budgetMode === 'personal') {
    openLoanPaymentModal(loan);
    return;
  }
  const today = toLocalDateKey(new Date());
  try {
    const res = await api.post(`/budget/loans/${id}/payments`, {
      installment_number: loan.next_installment_number,
      amount: loan.next_installment_number === loan.installment_count
        ? loan.remaining_amount
        : Math.min(loan.installment_amount, loan.remaining_amount),
      paid_date: today,
    });
    const paymentId = res.data?.payment?.id;
    await loadMonth(state.month);
    renderBody();
    vibrate(30);

    // Undo wie bei Löschungen: die eine Geld-Aktion, die eine Verpflichtung
    // *erzeugt*, bekommt dasselbe 5-Sekunden-Netz — Rücknahme löscht die Rate.
    if (paymentId) {
      window.yuvomi?.showToast(t('budget.loanPaymentAddedToast'), 'default', 5000, async () => {
        try {
          await api.delete(`/budget/loans/${id}/payments/${paymentId}`);
          await loadMonth(state.month);
          renderBody();
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });
    } else {
      window.yuvomi?.showToast(t('budget.loanPaymentAddedToast'), 'success');
    }
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
  }
}

async function deleteLoan(id) {
  const loan = state.loans.loans.find((item) => item.id === id);
  if (!loan) return;

  state.loans.loans = state.loans.loans.filter((item) => item.id !== id);
  renderBody();

  let undone = false;
  window.yuvomi?.showToast(t('budget.loanDeletedToast'), 'default', 5000, () => {
    undone = true;
    state.loans.loans = [...state.loans.loans, loan];
    renderBody();
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/budget/loans/${id}`);
      await loadMonth(state.month);
      renderBody();
    } catch (err) {
      state.loans.loans = [...state.loans.loans, loan];
      renderBody();
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
    }
  }, 5000);
}

async function deleteLoanPayment(loanId, paymentId) {
  const loan = state.loans.loans.find((item) => item.id === loanId);
  const payment = loan?.payments?.find((item) => item.id === paymentId);

  if (loan && payment) {
    loan.payments = loan.payments.filter((item) => item.id !== paymentId);
    renderBody();
  }

  let undone = false;
  window.yuvomi?.showToast(t('budget.deletedToast'), 'default', 5000, () => {
    undone = true;
    if (loan && payment) {
      loan.payments = [...(loan.payments || []), payment];
      renderBody();
    }
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/budget/loans/${loanId}/payments/${paymentId}`);
      await loadMonth(state.month);
      renderBody();
    } catch (err) {
      if (loan && payment) {
        loan.payments = [...(loan.payments || []), payment];
        renderBody();
      }
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }, 5000);
}

// --------------------------------------------------------
// Eintrag löschen
// --------------------------------------------------------

async function deleteEntry(id) {
  const entry = state.entries.find((e) => e.id === id);

  if (entry && (entry.is_recurring || entry.recurrence_parent_id)) {
    const scope = await recurringChoiceModal({
      title: t('budget.recurringSeriesScope'),
      thisLabel: t('budget.recurringThisOnly'),
      seriesLabel: t('budget.recurringEntireSeries'),
      seriesDanger: true,
    });
    if (scope === null) return;
    if (scope === 'series') { await deleteEntrySeries(id); return; }
  }

  state.entries = state.entries.filter((e) => e.id !== id);
  renderBody();
  vibrate([30, 50, 30]);

  let undone = false;
  window.yuvomi?.showToast(t('budget.deletedToast'), 'default', 5000, () => {
    undone = true;
    if (entry) {
      state.entries = [...state.entries, entry].sort((a, b) => new Date(b.date) - new Date(a.date));
      renderBody();
    }
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/budget/${id}`);
      await loadMonth(state.month);
      renderBody();
    } catch (err) {
      if (entry) {
        state.entries = [...state.entries, entry].sort((a, b) => new Date(b.date) - new Date(a.date));
        renderBody();
      }
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }, 5000);
}

// --------------------------------------------------------
// Hilfsfunktion
// --------------------------------------------------------

/**
 * Zeigt ein Modal mit zwei Wahloptionen für wiederkehrende Einträge.
 * Gibt 'this' | 'series' | null (abgebrochen) zurück.
 */
function recurringChoiceModal({ title, thisLabel, seriesLabel, seriesDanger = false }) {
  return new Promise((resolve) => {
    let resolved = false;
    function finish(value) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    }
    openSharedModal({
      title,
      size: 'sm',
      content: `
        <div class="modal-actions modal-actions--stack">
          <button type="button" class="btn btn--secondary" id="rcs-this">${thisLabel}</button>
          <button type="button" class="btn ${seriesDanger ? 'btn--danger' : 'btn--primary'}" id="rcs-series">${seriesLabel}</button>
          <button type="button" class="btn btn--ghost" id="rcs-cancel">${t('common.cancel')}</button>
        </div>`,
      onClose: () => finish(null),
      onSave(panel) {
        panel.querySelector('#rcs-this')?.addEventListener('click', () => finish('this'));
        panel.querySelector('#rcs-series')?.addEventListener('click', () => finish('series'));
        panel.querySelector('#rcs-cancel')?.addEventListener('click', () => finish(null));
      },
    });
  });
}

async function deleteEntrySeries(id) {
  const entry = state.entries.find((e) => e.id === id);
  const parentId = entry?.recurrence_parent_id ?? (entry?.is_recurring ? entry.id : id);
  state.entries = state.entries.filter((e) => e.id !== parentId && e.recurrence_parent_id !== parentId);
  renderBody();
  vibrate([30, 50, 30]);

  let undone = false;
  window.yuvomi?.showToast(t('budget.recurringSeriesDeleted'), 'default', 5000, () => { undone = true; });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/budget/${id}/series`);
      await loadMonth(state.month);
      renderBody();
    } catch (err) {
      await loadMonth(state.month);
      renderBody();
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }, 5000);
}
