/**
 * Modul: Budget-Tracker (Budget)
 * Zweck: Monatsübersicht, Kategorie-Balkendiagramm (Canvas), Transaktionsliste,
 *        CRUD, CSV-Export
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, confirmModal, advancedSection, wireBlurValidation, reportFieldError } from '/components/modal.js';
import { stagger, vibrate, scheduleUndoableDelete } from '/utils/ux.js';
import { wireTablist } from '/utils/tablist.js';
import { t, formatDate, getLocale, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { render as renderSplitExpenses } from '/pages/split-expenses.js';
import { openSubscriptionModal, render as renderSubscriptions } from '/pages/subscriptions.js';
import { renderStats } from '/pages/budget-stats.js';
import { renderPlans } from '/pages/budget-plans.js';
import { toLocalDateKey } from '/utils/date.js';
import { budgetCategoryLabel, budgetCategoryLabelKey } from '/utils/category-labels.js';
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
// Konten (#495)
// --------------------------------------------------------

// Muss mit ACCOUNT_TYPE_KEYS in server/routes/budget.js übereinstimmen.
const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'credit', 'investment', 'other'];
const ACCOUNT_TYPE_ICONS = {
  checking:   'landmark',
  savings:    'piggy-bank',
  cash:       'wallet',
  credit:     'credit-card',
  investment: 'trending-up',
  other:      'circle-dollar-sign',
};

// Kuratierte Konto-Akzentfarben. Die Werte kommen aus tokens.css
// (--chart-series-*), damit die Palette im Dark Mode mit aufgehellt wird und
// nirgends Hex-Literale im JS stehen. Leerer Wert = Modul-Akzent (Teal).
// nameKey benennt den Farbton für Screenreader — vorher stand dort der Hexcode,
// den die Sprachausgabe als „Raute-Null-F-Sieben..." vorgelesen hat.
const ACCOUNT_COLORS = [
  { value: 'var(--chart-series-2)', nameKey: 'budget.colorTeal' },
  { value: 'var(--chart-series-4)', nameKey: 'budget.colorBlue' },
  { value: 'var(--chart-series-1)', nameKey: 'budget.colorViolet' },
  { value: 'var(--chart-series-6)', nameKey: 'budget.colorMagenta' },
  { value: 'var(--chart-series-3)', nameKey: 'budget.colorOrange' },
  { value: 'var(--chart-series-7)', nameKey: 'budget.colorGreen' },
  { value: 'var(--chart-series-5)', nameKey: 'budget.colorOcher' },
];

function accountTypeLabel(type) {
  return t(`budget.accountType_${ACCOUNT_TYPES.includes(type) ? type : 'other'}`);
}

// Akzentfarbe eines Kontos für die Kachel; Fallback auf den Modul-Akzent.
function accountAccent(color) {
  return esc(color) || 'var(--module-accent)';
}

function accountName(id) {
  if (id == null) return '';
  return state.accounts.find((a) => a.id === id)?.name || '';
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
  accounts:    [],
  netWorth:    0,
  accountFilterId: null,      // aktiver Konto-Filter für die Transaktionsliste (Drilldown)
  accountsShowArchived: false,
  activeTab:   'budget',
  loanFilterId: null,
  loanStatusFilter: 'active',
  currency:    'EUR',
  budgetMode:  'shared',      // 'shared' (Altverhalten) | 'personal' (#476/#505)
  scope:       'mine',        // Ansichts-Filter im personal-Modus: 'mine' | 'household'
  meta:        { expenseCategories: [], incomeCategories: [], expenseSubcategories: {} },
};
let _container = null;
let _user = null;
let _tablist = null;   // wireTablist-Handle: erlaubt programmatische Tab-Wechsel (sync)
let _scopeTablist = null;

// Fähigkeiten je Untertab — EINE Quelle für Monatsnavigation, Toolbar-„+" und FAB.
// Vorher lagen diese drei Entscheidungen in getrennten Ausschluss-Listen, was sich
// widersprochen hat (Monatslabel ohne Pfeile auf „Darlehen", FAB ohne Toolbar-„+"
// auf „Berichte"). `month`: Monat ist der Bezugsrahmen des Tabs. `add`: es gibt
// eine sinnvolle Neu-Aktion (labelKey benennt sie für FAB und Toolbar-Button).
const TAB_CAPS = {
  'budget':         { month: true,  add: 'budget.newEntryFabLabel' },
  'plan':           { month: true,  add: 'budget.planAddBudget' },
  'accounts':       { month: false, add: 'budget.addAccount' },
  'subscriptions':  { month: false, add: 'subscriptions.add' },
  'loans':          { month: false, add: 'budget.newLoan' },
  'reports':        { month: false, add: null },
  'split-expenses': { month: false, add: 'splitExpenses.addExpense' },
};

function tabCaps() {
  if (_user?.access_scope === 'split_guest') return TAB_CAPS['split-expenses'];
  return TAB_CAPS[state.activeTab] ?? TAB_CAPS.budget;
}

// --------------------------------------------------------
// Formatierung
// --------------------------------------------------------

function formatAmount(n) {
  return getNumberFormat({ style: 'currency', currency: state.currency }).format(n);
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
  // Konto-Drilldown: Transaktionsliste optional auf ein Konto filtern.
  const accountQuery = state.accountFilterId ? `&account_id=${state.accountFilterId}` : '';
  // Ansichts-Scope (#476/#505): nur im personal-Modus relevant; sonst ignoriert der Server ihn.
  const scopeQuery = state.budgetMode === 'personal' ? `&scope=${state.scope}` : '';
  try {
    const [entriesRes, summaryRes, prevSummaryRes, loansRes] = await Promise.all([
      api.get(`/budget?month=${month}${accountQuery}${scopeQuery}`),
      api.get(`/budget/summary?month=${month}${scopeQuery}`),
      api.get(`/budget/summary?month=${prevMonth}${scopeQuery}`),
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

async function loadAccounts() {
  try {
    // Immer inkl. archivierter Konten laden: für die Namensauflösung in der
    // Transaktionsliste (ein Eintrag kann einem archivierten Konto gehören) und
    // den optionalen „Archivierte anzeigen"-Modus. net_worth ignoriert archivierte
    // serverseitig; die Kachel-Liste filtert clientseitig.
    const res = await api.get('/budget/accounts?include_archived=1');
    state.accounts = res.data?.accounts ?? [];
    state.netWorth = res.data?.net_worth ?? 0;
  } catch (err) {
    console.error('[Budget] loadAccounts Fehler:', err);
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
  // `state` ist ein Modul-Singleton und überlebt den Seitenwechsel. Filter sind
  // aber an eine Sitzung mit dem Modul gebunden: sonst zeigt das Budget nach
  // einer Woche noch den Kontoauszug von damals — beim Darlehens-Statusfilter
  // sogar ohne sichtbaren Hinweis. Der aktive Tab bleibt bewusst erhalten.
  state.accountFilterId = null;
  state.loanFilterId = null;
  state.loanStatusFilter = 'active';
  state.accountsShowArchived = false;
  if (user?.access_scope === 'split_guest') state.activeTab = 'split-expenses';

  if (user?.access_scope !== 'split_guest') {
    try {
      const [prefsRes] = await Promise.all([
        api.get('/preferences'),
        loadBudgetMeta(),
      ]);
      state.currency = prefsRes.data?.currency ?? 'EUR';
      state.budgetMode = prefsRes.data?.budget_mode === 'personal' ? 'personal' : 'shared';
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
        ${state.budgetMode === 'personal' ? `
        <div class="budget-scope" role="tablist" aria-label="${t('budget.scopeLabel')}">
          ${[['mine', t('budget.scopeMine')], ['household', t('budget.scopeHousehold')]].map(([id, label]) => {
            const on = id === state.scope;
            return `<button class="sub-tab${on ? ' sub-tab--active' : ''}" type="button" role="tab" data-tab-id="${id}" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}"><span class="sub-tab__label">${label}</span></button>`;
          }).join('')}
        </div>` : ''}
        <div class="page-toolbar__actions">
          <div class="budget-tabs" role="tablist" aria-label="${t('budget.tabsLabel')}">
            ${[
              ...(user?.access_scope === 'split_guest' ? [] : [
                ['budget',        t('budget.budgetTab')],
                ['accounts',      t('budget.accountsTab')],
                ['plan',          t('budget.planTab')],
                ['subscriptions', t('subscriptions.tabLabel')],
                ['loans',         t('budget.loansTab')],
                ['reports',       t('budget.reportsTab')],
              ]),
              ['split-expenses',  t('splitExpenses.tabLabel')],
            ].map(([id, label]) => {
              const on = id === state.activeTab;
              return `<button class="sub-tab${on ? ' sub-tab--active' : ''}" id="budget-tab-${id}" type="button" role="tab" data-tab-id="${id}" aria-controls="budget-body" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}"><span class="sub-tab__label">${label}</span></button>`;
            }).join('')}
          </div>
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
    // Konten einmalig beim Mount laden (Salden sind monatsunabhängig; kein
    // Nachladen pro Monatswechsel). Namensliste versorgt die Transaktions-Meta.
    await Promise.all([loadMonth(state.month), loadAccounts()]);
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
  // Ansichts-Scope (Mein Budget / Haushalt) — nur im personal-Modus vorhanden.
  // Dieselbe Verhaltensschicht wie die Haupt-Tabs: Roving-Tabindex ohne
  // Pfeiltasten wäre eine Tastaturfalle (nur ein Button per Tab erreichbar).
  _scopeTablist = wireTablist(_container.querySelector('.budget-scope'), {
    activeId: state.scope,
    onChange: async (id) => {
      state.scope = id;
      await loadMonth(state.month);
      renderBody();
    },
  });
  // Neu-Aktion je Tab — spiegelt TAB_CAPS.add. Tabs ohne Neu-Aktion (Berichte)
  // blenden beide Auslöser aus, der Handler bleibt dort folgenlos.
  const addHandler = () => {
    switch (state.activeTab) {
      case 'split-expenses': _container.querySelector('#split-add-expense')?.click(); return;
      case 'subscriptions':  openSubscriptionModal(); return;
      case 'plan':           _container.querySelector('#budget-plan-add')?.click(); return;
      case 'accounts':       openAccountModal(); return;
      case 'loans':          openLoanModal(); return;
      case 'reports':        return;
      default:               openBudgetModal({ mode: 'create' });
    }
  };
  _container.querySelector('#budget-add').addEventListener('click', addHandler);
  _container.querySelector('#fab-new-budget').addEventListener('click', addHandler);
  // Geteilte Tablist-Verhaltensschicht (Klick + Pfeiltasten/Home/End + Roving-
  // Tabindex + ARIA) — dieselbe Grammatik wie Rewards/Haushaltshilfe statt einer
  // modul-eigenen Nachbildung (utils/tablist.js). wireTablist malt den aktiven
  // Tab (sub-tab--active/aria/tabindex); renderBody übernimmt nur noch den Inhalt.
  _tablist = wireTablist(_container.querySelector('.budget-tabs'), {
    activeId: state.activeTab,
    onChange: (id) => {
      state.activeTab = id;
      renderBody();
    },
  });
  // Edge-Fade + Aktiver-Tab-in-Sicht übernimmt jetzt wireTablist zentral
  // (Audit A2-18: gleiche Affordanz für Budget, Haushaltshilfe, Rewards).
  updateLabel();
}

function updateLabel() {
  const lbl = _container.querySelector('#budget-label');
  if (lbl) lbl.textContent = formatMonthLabel(state.month);
}

// --------------------------------------------------------
// Body
// --------------------------------------------------------

function renderBody() {
  const body = _container.querySelector('#budget-body');
  if (!body) return;
  updateLabel();

  const s    = state.summary;
  const p    = state.prevSummary;
  updateTabs();
  if (state.activeTab === 'reports') {
    setHtml(body, '<div class="budget-tab-panel budget-tab-panel--reports" id="budget-reports-panel"></div>');
    renderStats(body.querySelector('#budget-reports-panel'), {
      user: _user, currency: state.currency,
      budgetMode: state.budgetMode, scope: state.scope,
      formatAmount, categoryLabel, esc,
    }).catch((err) => console.error('[Budget] stats render error:', err));
    return;
  }
  if (state.activeTab === 'plan') {
    setHtml(body, '<div class="budget-tab-panel budget-tab-panel--plan" id="budget-plan-panel"></div>');
    renderPlans(body.querySelector('#budget-plan-panel'), {
      user: _user, currency: state.currency, month: state.month,
      formatAmount, categoryLabel, esc,
      expenseCategories: expenseCategories(),
    }).catch((err) => console.error('[Budget] plans render error:', err));
    return;
  }
  if (state.activeTab === 'loans') {
    setHtml(body, renderLoansPage());
    wireLoansPage();
    if (window.lucide) lucide.createIcons({ el: body });
    return;
  }
  if (state.activeTab === 'accounts') {
    const paint = () => {
      setHtml(body, renderAccountsPage());
      wireAccountsPage();
      if (window.lucide) lucide.createIcons({ el: body });
    };
    paint(); // sofort aus dem State (beim Mount geladen)
    // Salden nach zwischenzeitlichen Einträgen frisch ziehen, ohne den Wechsel zu blockieren.
    loadAccounts().then(() => { if (state.activeTab === 'accounts') paint(); });
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
          ${state.accountFilterId ? `
          <button class="budget-account-chip" id="budget-clear-account-filter" type="button"
                  aria-label="${t('budget.clearAccountFilter')}">
            <i data-lucide="wallet" class="icon-xs" aria-hidden="true"></i>
            <span>${esc(accountName(state.accountFilterId))}</span>
            <i data-lucide="x" class="icon-xs" aria-hidden="true"></i>
          </button>` : ''}
        </div>
        <div class="budget-list-header__actions">
        <button class="btn btn--icon btn--ghost" id="budget-manage-categories"
          aria-label="${t('budget.manageCategories')}" title="${t('budget.manageCategories')}">
          <i data-lucide="tags" class="icon-md" aria-hidden="true"></i>
        </button>
        ${state.entries.length ? `
        <a href="/api/v1/budget/export?month=${state.month}${state.budgetMode === 'personal' ? `&scope=${state.scope}` : ''}" class="btn btn--secondary budget-csv-export">
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
  _container.querySelector('#budget-clear-account-filter')?.addEventListener('click', async () => {
    state.accountFilterId = null;
    await loadMonth(state.month);
    renderBody();
  });
  stagger(_container.querySelector('#budget-list')?.querySelectorAll('.budget-entry') ?? []);

  _container.querySelector('#budget-list')?.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-action="delete"]');
    if (delBtn) { await deleteEntry(parseInt(delBtn.dataset.id, 10)); return; }

    const item = e.target.closest('.budget-entry[data-id]');
    if (item && !e.target.closest('[data-action]')) {
      const entry = state.entries.find((e) => e.id === parseInt(item.dataset.id, 10));
      if (entry) openBudgetModal({ mode: 'edit', entry });
    }
  });

  // Enter/Space auf der fokussierten Zeile öffnet Bearbeiten, analog zum Klick.
  // Guard auf e.target === Zeile: Enter auf dem inneren Lösch-Button feuert
  // bereits dessen click und darf nicht zusätzlich das Edit-Modal öffnen.
  _container.querySelector('#budget-list')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.budget-entry[data-id]');
    if (!item || e.target !== item) return;
    e.preventDefault();
    const entry = state.entries.find((x) => x.id === parseInt(item.dataset.id, 10));
    if (entry) openBudgetModal({ mode: 'edit', entry });
  });
}

function updateTabs() {
  _container.classList.toggle('budget-page--split-active', state.activeTab === 'split-expenses' || _user?.access_scope === 'split_guest');
  _container.classList.toggle('budget-page--loans-active', state.activeTab === 'loans');
  _container.classList.toggle('budget-page--subscriptions-active', state.activeTab === 'subscriptions');
  // Tab-Optik (aktive Pille, aria-selected, Roving-Tabindex) trägt jetzt
  // wireTablist; hier bleiben nur Panel-Verknüpfung und Scroll-Fade.
  const panel = _container.querySelector('#budget-body');
  if (panel) panel.setAttribute('aria-labelledby', `budget-tab-${state.activeTab}`);
  // Scroll-Fade der Tab-Leiste hält wireScrollFade selbst aktuell (Audit F-06).

  // Monatsnavigation als Block: entweder der ganze Monats-Umschalter gehört zum
  // Tab oder keines seiner Teile. Kein sichtbares Monatslabel ohne Pfeile mehr.
  const caps = tabCaps();
  ['#budget-prev', '#budget-next', '#budget-today', '#budget-label'].forEach((selector) => {
    const el = _container.querySelector(selector);
    if (el) el.hidden = !caps.month;
  });

  // Toolbar-„+" und FAB zeigen dieselbe Aktion mit demselben Label — oder beide
  // gar nichts (Berichte hat keine Neu-Aktion).
  const addLabel = caps.add ? t(caps.add) : '';
  const addBtn = _container.querySelector('#budget-add');
  if (addBtn) {
    addBtn.hidden = !caps.add;
    if (caps.add) {
      addBtn.setAttribute('aria-label', addLabel);
      addBtn.setAttribute('title', addLabel);
    }
  }
  const fab = _container.querySelector('#fab-new-budget');
  if (fab) {
    fab.hidden = !caps.add;
    if (caps.add) fab.setAttribute('aria-label', addLabel);
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
    // Nicht-null-Kategorien behalten einen sichtbaren Mindestbalken, statt bei
    // winzigem Anteil (z. B. -25 € neben +5050 €) auf 0 zu runden und leer zu
    // wirken (Audit P3).
    const rawPct    = (Math.abs(c.total) / maxAbs) * 100;
    const pct       = c.total !== 0 ? Math.max(3, Math.round(rawPct)) : 0;
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
      ? ` <span class="budget-recur-mark" role="img" aria-label="${t('budget.recurringLabel')}"><i data-lucide="repeat" class="icon-xs" aria-hidden="true"></i></span>${e.recurrence_virtual ? ' ' + t('budget.virtualBudgetBadge') : ''}`
      : (e.recurrence_parent_id ? ` <span class="budget-recur-mark" role="img" aria-label="${t('budget.recurringInstanceLabel')}"><i data-lucide="corner-down-left" class="icon-xs" aria-hidden="true"></i></span>` : '');
    const categoryMeta = isIncome || !e.subcategory
      ? categoryLabel(e.category)
      : `${categoryLabel(e.category)} · ${subcategoryLabel(e.subcategory)}`;
    const acctName = accountName(e.account_id);
    const acctMeta = acctName
      ? ` · <span class="budget-entry__account"><i data-lucide="wallet" class="icon-xs" aria-hidden="true"></i>${esc(acctName)}</span>`
      : '';
    // Im personal-Modus geteilte Einträge klar als Haushalts-Topf kennzeichnen (#476/#505).
    const sharedBadge = (state.budgetMode === 'personal' && e.visibility === 'shared')
      ? ` <span class="budget-badge budget-badge--shared">${esc(t('budget.householdBadge'))}</span>`
      : '';

    // Die Zeile ist die Edit-Fläche und braucht deshalb Tastaturzugang
    // (role=button + tabindex); ein echtes <button> geht nicht, weil der
    // Lösch-Button darin verschachtelt ist. Das aria-label hält den
    // Lösch-Button-Namen aus dem Zeilen-Namen heraus.
    return `
      <div class="budget-entry" data-id="${e.id}" role="button" tabindex="0"
           aria-label="${esc(t('budget.editEntry'))}: ${esc(e.title)}, ${sign}${formatAmount(e.amount)}">
        <div class="budget-entry__indicator ${indClass}"></div>
        <div class="budget-entry__body">
          <div class="budget-entry__title">${esc(e.title)}${sharedBadge}</div>
          <div class="budget-entry__meta">${date} · ${esc(categoryMeta)}${acctMeta}${recurTag}</div>
        </div>
        <div class="budget-entry__amount ${amtClass}">${sign}${formatAmount(e.amount)}</div>
        <button class="row-action row-action--danger" data-action="delete" data-id="${e.id}" aria-label="${t('budget.deleteLabel')}">
          <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
    `;
  }).join('');
}

function renderAccountsPage() {
  const all = state.accounts ?? [];
  const hasArchived = all.some((a) => a.archived);
  const visible = all.filter((a) => state.accountsShowArchived || !a.archived);
  const netClass = state.netWorth >= 0 ? 'budget-networth--positive' : 'budget-networth--negative';

  const archiveToggle = hasArchived ? `
      <button class="budget-accounts__toggle" id="budget-toggle-archived" type="button" aria-pressed="${state.accountsShowArchived}">
        <i data-lucide="${state.accountsShowArchived ? 'eye-off' : 'archive'}" class="icon-xs" aria-hidden="true"></i>
        ${state.accountsShowArchived ? t('budget.hideArchivedAccounts') : t('budget.showArchivedAccounts')}
      </button>` : '';

  const header = `
    <div class="budget-accounts__header">
      <div class="budget-networth ${netClass}">
        <span class="budget-networth__label">${t('budget.netWorth')}</span>
        <span class="budget-networth__amount">${formatAmount(state.netWorth)}</span>
      </div>
      <div class="budget-accounts__header-actions">
        ${archiveToggle}
        <button class="btn btn--secondary" id="budget-add-account" type="button">
          <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${t('budget.addAccount')}
        </button>
      </div>
    </div>`;

  if (!all.length) {
    return `
      <div class="budget-tab-panel budget-tab-panel--accounts">
        ${header}
        <div class="empty-state">
          <i data-lucide="wallet" class="empty-state__icon" aria-hidden="true"></i>
          <div class="empty-state__title">${t('budget.accountsEmptyTitle')}</div>
          <div class="empty-state__description">${t('budget.accountsEmptyDescription')}</div>
          <button class="btn btn--primary empty-state__cta" id="budget-add-account-empty" type="button">
            <i data-lucide="plus" aria-hidden="true" class="icon-md"></i>${t('budget.addAccount')}
          </button>
        </div>
      </div>`;
  }

  const cards = visible.map((a) => {
    const balClass = a.current_balance >= 0 ? 'budget-account__balance--positive' : 'budget-account__balance--negative';
    const icon = ACCOUNT_TYPE_ICONS[a.type] || ACCOUNT_TYPE_ICONS.other;
    const archivedBadge = a.archived
      ? `<span class="budget-account__badge">${t('budget.archivedBadge')}</span>`
      : '';
    return `
      <div class="budget-account ${a.archived ? 'budget-account--archived' : ''}" style="--account-accent:${accountAccent(a.color)}">
        <button class="budget-account__main" type="button" data-drill="${a.id}"
                aria-label="${t('budget.viewAccountTransactions', { name: a.name })} · ${t('budget.currentBalance')} ${formatAmount(a.current_balance)}">
          <span class="budget-account__icon"><i data-lucide="${icon}" class="icon-md" aria-hidden="true"></i></span>
          <span class="budget-account__body">
            <span class="budget-account__name"><span class="budget-account__name-text">${esc(a.name)}</span>${archivedBadge}</span>
            <span class="budget-account__type">${esc(accountTypeLabel(a.type))}</span>
          </span>
          <span class="budget-account__figures">
            <span class="budget-account__balance ${balClass}">${formatAmount(a.current_balance)}</span>
            <span class="budget-account__starting">${t('budget.startingBalanceShort')} ${formatAmount(a.starting_balance)}</span>
          </span>
          <i data-lucide="chevron-right" class="budget-account__chevron icon-sm" aria-hidden="true"></i>
        </button>
        <button class="budget-account__edit" type="button" data-edit="${a.id}" aria-label="${t('budget.editAccount')}">
          <i data-lucide="pencil" class="icon-sm" aria-hidden="true"></i>
        </button>
      </div>`;
  }).join('');

  return `
    <div class="budget-tab-panel budget-tab-panel--accounts">
      ${header}
      <div class="budget-accounts__list">${cards}</div>
    </div>`;
}

function wireAccountsPage() {
  _container.querySelector('#budget-add-account')?.addEventListener('click', () => openAccountModal());
  _container.querySelector('#budget-add-account-empty')?.addEventListener('click', () => openAccountModal());
  _container.querySelector('#budget-toggle-archived')?.addEventListener('click', () => {
    state.accountsShowArchived = !state.accountsShowArchived;
    renderBody();
  });
  // Zeilen-Klick öffnet den Kontoauszug (Drilldown-Filter), das Stift-Icon bearbeitet.
  _container.querySelectorAll('.budget-account__main[data-drill]').forEach((el) => {
    el.addEventListener('click', async () => {
      state.accountFilterId = parseInt(el.dataset.drill, 10);
      state.activeTab = 'budget';
      // Aktive Pille mitziehen: dieser Wechsel läuft nicht über die Tab-Leiste,
      // daher malt wireTablist ihn nur über sync() nach (updateTabs tut es nicht mehr).
      _tablist?.sync('budget');
      await loadMonth(state.month);
      renderBody();
      // Der geklickte Button wird beim Re-Render entfernt — ohne Fokus-Umzug
      // fällt der Fokus auf <body> und Tastatur-/Screenreader-Nutzer landen
      // wieder am Seitenanfang. Das Panel ist tabindex="0" und trägt den Titel.
      _container.querySelector('#budget-body')?.focus();
    });
  });
  _container.querySelectorAll('.budget-account__edit[data-edit]').forEach((el) => {
    el.addEventListener('click', () => {
      const account = state.accounts.find((a) => a.id === parseInt(el.dataset.edit, 10));
      if (account) openAccountModal(account);
    });
  });
}

function openAccountModal(account = null) {
  const isEdit = !!account;
  const typeOpts = ACCOUNT_TYPES.map((key) =>
    `<option value="${key}" ${isEdit && account.type === key ? 'selected' : ''}>${esc(accountTypeLabel(key))}</option>`
  ).join('');

  const currentColor = isEdit ? (account.color || '') : '';
  const swatch = (value, styleColor, label) =>
    `<button type="button" class="budget-color-swatch ${currentColor === value ? 'is-active' : ''}"
             data-color="${esc(value)}" style="--swatch:${esc(styleColor)}" aria-label="${esc(label)}" aria-pressed="${currentColor === value}"></button>`;
  const colorSwatches = swatch('', 'var(--module-accent)', t('budget.accountColorDefault'))
    + ACCOUNT_COLORS.map((c) => swatch(c.value, c.value, t(c.nameKey))).join('');

  const content = `
    <div class="form-group">
      <label class="form-label" for="am-name">${t('budget.accountNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
      <input type="text" class="form-input" id="am-name" maxlength="100"
             placeholder="${t('budget.accountNamePlaceholder')}" value="${esc(isEdit ? account.name : '')}">
    </div>
    <div class="form-group">
      <label class="form-label" for="am-type">${t('budget.accountTypeLabel')}</label>
      <select class="form-input" id="am-type">${typeOpts}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="am-balance">${t('budget.startingBalanceLabel')}</label>
      <input type="number" class="form-input" id="am-balance" step="0.01" inputmode="decimal"
             placeholder="0.00" value="${isEdit ? account.starting_balance : ''}">
      <p class="form-hint">${t('budget.startingBalanceHint')}</p>
    </div>
    <div class="form-group">
      <label class="form-label">${t('budget.accountColorLabel')}</label>
      <div class="budget-color-picker" id="am-color" role="group" aria-label="${t('budget.accountColorLabel')}">${colorSwatches}</div>
    </div>

    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      <div style="display:flex;gap:var(--space-2)">
      ${isEdit ? `<button class="btn btn--danger btn--icon" id="am-delete" aria-label="${t('budget.deleteAccount')}">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
      </button>
      <button class="btn btn--secondary btn--icon" id="am-archive"
              aria-label="${account.archived ? t('budget.unarchiveAccount') : t('budget.archiveAccount')}"
              title="${account.archived ? t('budget.unarchiveAccount') : t('budget.archiveAccount')}">
        <i data-lucide="${account.archived ? 'archive-restore' : 'archive'}" class="icon-md" aria-hidden="true"></i>
      </button>` : '<div></div>'}
      </div>
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="am-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="am-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>`;

  openSharedModal({
    title: isEdit ? t('budget.editAccount') : t('budget.newAccount'),
    content,
    size: 'sm',
    onSave(panel) {
      let selectedColor = currentColor;
      const colorPicker = panel.querySelector('#am-color');
      colorPicker?.querySelectorAll('.budget-color-swatch').forEach((sw) => {
        sw.addEventListener('click', () => {
          selectedColor = sw.dataset.color;
          colorPicker.querySelectorAll('.budget-color-swatch').forEach((o) => {
            const active = o === sw;
            o.classList.toggle('is-active', active);
            o.setAttribute('aria-pressed', String(active));
          });
        });
      });

      panel.querySelector('#am-cancel').addEventListener('click', closeModal);

      panel.querySelector('#am-archive')?.addEventListener('click', async () => {
        const nextArchived = !account.archived;
        try {
          await api.put(`/budget/accounts/${account.id}`, { archived: nextArchived });
          closeModal({ force: true });
          await loadAccounts();
          renderBody();
          window.yuvomi?.showToast(nextArchived ? t('budget.accountArchivedToast') : t('budget.accountRestoredToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });

      panel.querySelector('#am-delete')?.addEventListener('click', async () => {
        const ok = await confirmModal(
          t('budget.deleteAccountConfirm', { name: account.name }),
          { confirmLabel: t('common.delete'), danger: true },
        );
        if (!ok) return;
        try {
          await api.delete(`/budget/accounts/${account.id}`);
          closeModal({ force: true });
          await loadMonth(state.month);
          renderBody();
          window.yuvomi?.showToast(t('budget.accountDeletedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });

      panel.querySelector('#am-save').addEventListener('click', async () => {
        const saveBtn = panel.querySelector('#am-save');
        const name    = panel.querySelector('#am-name').value.trim();
        const type    = panel.querySelector('#am-type').value;
        const rawBal  = panel.querySelector('#am-balance').value;
        const startingBalance = rawBal === '' ? 0 : parseFloat(rawBal);

        if (!name) {
          reportFieldError(panel.querySelector('#am-name'), t('common.titleRequired'));
          return;
        }
        if (isNaN(startingBalance)) {
          reportFieldError(panel.querySelector('#am-balance'), t('budget.validAmountRequired'));
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '…';
        try {
          const body = { name, type, starting_balance: startingBalance, color: selectedColor || null };
          if (isEdit) {
            await api.put(`/budget/accounts/${account.id}`, body);
          } else {
            await api.post('/budget/accounts', body);
          }
          closeModal({ force: true });
          await loadAccounts();
          renderBody();
          window.yuvomi?.showToast(isEdit ? t('budget.accountSavedToast') : t('budget.accountAddedToast'), 'success');
        } catch (err) {
          saveBtn.disabled = false;
          saveBtn.textContent = isEdit ? t('common.save') : t('common.add');
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });
    },
  });
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
          ${[['active', 'budget.loanStatusActive'], ['paid', 'budget.loanStatusPaid'], ['all', 'budget.loanStatusAll']]
            .map(([id, key]) => {
              const on = state.loanStatusFilter === id;
              // aria-pressed statt reiner Einfärbung: sonst ist der aktive Filter
              // für Screenreader nicht von den inaktiven zu unterscheiden.
              return `<button class="budget-loans__filter ${on ? 'budget-loans__filter--active' : ''}"
                  type="button" data-loan-status="${id}" aria-pressed="${on}">${t(key)}</button>`;
            }).join('')}
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
    // Fallbacks über t() bzw. leer: der frühere hartkodierte englische Titel und
    // die deutsche Kategorie „Geschenke & Transfers" waren in 22 von 23 Sprachen
    // falsch — und die Kategorie ist längst ein Key, kein Anzeigename.
    title: payment.entry_title || t('budget.loanPaymentTitle', { borrower: loan.borrower }),
    amount: Number(payment.amount || 0),
    category: payment.entry_category || '',
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
      <div class="row-actions">
        ${entry ? `
        <button class="row-action" data-action="loan-payment-edit" data-loan-id="${loan.id}" data-payment-id="${payment.id}" data-entry-id="${entry.id}" aria-label="${t('common.edit')}">
          <i data-lucide="pencil" class="icon-md" aria-hidden="true"></i>
        </button>` : ''}
        <button class="row-action row-action--danger" data-action="loan-payment-delete" data-loan-id="${loan.id}" data-payment-id="${payment.id}" data-entry-id="${entry?.id ?? ''}" aria-label="${t('budget.deleteLabel')}">
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
      const entry = loan && payment ? loanPaymentToEntry(loan, payment) : null;
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
          <button class="budget-loan-card__filter ${state.loanFilterId === loan.id ? 'budget-loan-card__filter--active' : ''}"
                  type="button" data-action="loan-filter" data-id="${loan.id}"
                  aria-pressed="${state.loanFilterId === loan.id}" aria-label="${t('budget.filterLoanTransactions')}">
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
  const sign     = positive ? '+' : '';
  const cls      = positive ? 'budget-summary-card__trend--positive' : 'budget-summary-card__trend--negative';
  // Pfeil als Lucide-Icon statt ▲/▼: die Textglyphen fallen aus der Icon-Familie
  // und sind je nach Font unterschiedlich breit (Zeilenzittern). Das „vs." stand
  // bisher fest im Template — jetzt trägt der Key den ganzen Satz.
  const icon = positive ? 'trending-up' : 'trending-down';
  return `<div class="budget-summary-card__trend ${cls}">
    <i data-lucide="${icon}" class="icon-xs" aria-hidden="true"></i>
    ${esc(t('budget.trendDelta', { amount: `${sign}${formatAmount(delta)}`, month: prevLabel }))}
  </div>`;
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
        itemFilter: (item) => !budgetCategoryLabelKey(item.key),
        titleKey: 'budget.manageCategories',
        hintKey: 'category.manageHint',
      });
    },
    onClose: () => manager?.removeEventListener('category-manager-changed', onChanged),
  });
}

function openBudgetModal({ mode, entry = null, initialType = '' }) {
  const isEdit = mode === 'edit';
  const today  = toLocalDateKey(new Date());
  const todayMonth = today.slice(0, 7);
  // Ein neuer Eintrag gehört in den Monat, den der Nutzer gerade ansieht. Sonst
  // legt „+" beim Blättern in den März stillschweigend einen Juli-Eintrag an,
  // der sofort aus der Liste verschwindet. Im laufenden Monat bleibt es heute.
  const defaultDate = state.month === todayMonth ? today : `${state.month}-01`;

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

  const hasAccounts = (state.accounts?.length ?? 0) > 0;
  const accountOpts = `<option value="">${t('budget.noAccount')}</option>` + (state.accounts ?? []).map((a) =>
    `<option value="${a.id}" ${isEdit && entry.account_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`
  ).join('');
  const accountField = hasAccounts ? `
        <div class="form-group">
          <label class="form-label" for="bm-account">${t('budget.accountLabel')}</label>
          <select class="form-input" id="bm-account">${accountOpts}</select>
        </div>` : '';

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
        <div style="display:flex;gap:var(--space-2)">
          <button class="btn btn--secondary budget-inline-add" type="button" id="bm-add-category">${t('budget.addCategory')}</button>
          <button class="btn btn--ghost budget-inline-add" type="button" id="bm-manage-categories">${t('budget.manageCategories')}</button>
        </div>
      </div>
      <select class="form-input" id="bm-category">${catOpts}</select>
    </div>

    <div class="form-group js-entry-field">
      <label class="form-label" for="bm-date">${t('budget.dateLabel')}</label>
      <yuvomi-datepicker type="date" id="bm-date"
             value="${isEdit ? entry.date : defaultDate}"></yuvomi-datepicker>
    </div>

    ${state.budgetMode === 'personal' ? `
    <div class="form-group js-entry-field">
      <label class="toggle">
        <input type="checkbox" id="bm-shared" ${isEdit && entry.visibility === 'shared' ? 'checked' : ''}>
        <span class="toggle__track"></span>
        <span>${t('budget.sharedToggleLabel')}</span>
      </label>
      <p class="form-hint">${t('budget.sharedToggleHint')}</p>
    </div>` : ''}

    <div class="js-entry-field">
      ${advancedSection(`
        ${accountField}
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
        { open: isEdit && (entry.is_recurring || !!entry.subcategory || entry.account_id != null) })}
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
        <input type="month" class="form-input" id="lm-start" value="${defaultDate.slice(0, 7)}">
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
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
      panel.querySelector('#bm-manage-categories')?.addEventListener('click', openCategoryManager);
      panel.querySelector('#bm-add-subcategory').addEventListener('click', addSubcategory);
      panel.querySelector('#bm-cancel').addEventListener('click', closeModal);

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
        const accountSel = panel.querySelector('#bm-account');
        // Konto-Feld erscheint nur, wenn Konten existieren. Fehlt es, bleibt die
        // Zuordnung beim Bearbeiten unverändert (account_id nicht mitsenden).
        const accountId  = accountSel ? (accountSel.value === '' ? null : parseInt(accountSel.value, 10)) : undefined;

        if (!title) {
          reportFieldError(panel.querySelector('#bm-title'), t('common.titleRequired'));
          return;
        }
        if (isNaN(absVal) || absVal <= 0) {
          reportFieldError(panel.querySelector('#bm-amount'), t('budget.validAmountRequired'));
          return;
        }
        if (!date) {
          reportFieldError(panel.querySelector('#bm-date'), t('calendar.invalidDate'));
          return;
        }

        const amount = currentType === 'expense' ? -absVal : absVal;

        saveBtn.disabled    = true;
        saveBtn.textContent = '…';

        try {
          const body = { title, amount, category, subcategory, date, is_recurring: recurring, recurrence_interval: interval, recurrence_virtual: virtual };
          if (accountId !== undefined) body.account_id = accountId;
          // Sichtbarkeit nur im personal-Modus mitsenden (#476/#505).
          const sharedEl = panel.querySelector('#bm-shared');
          if (sharedEl) body.visibility = sharedEl.checked ? 'shared' : 'private';
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
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
    // Der Auslöser bekommt den Fokus zurück, sonst fällt er beim Schließen auf
    // <body> — das Overlay liegt über einem offenen Modal.
    const opener = document.activeElement;
    const cleanup = (value = '') => {
      overlay.remove();
      if (opener?.isConnected) opener.focus();
      resolve(value);
    };
    overlay.querySelectorAll('[data-action="inline-cancel"]').forEach((btn) => {
      btn.addEventListener('click', () => cleanup(''));
    });
    overlay.querySelector('[data-action="inline-save"]').addEventListener('click', () => {
      cleanup(input.value.trim());
    });
    // Klick auf den Grund schließt — dieselbe Erwartung wie beim geteilten Modal.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) cleanup('');
    });
    // Escape und Fokus-Trap auf Overlay-Ebene, nicht nur im Eingabefeld: sonst
    // tabbt man aus dem „Dialog" heraus in das darunterliegende Formular.
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cleanup(''); return; }
      if (e.key === 'Enter' && e.target === input) { cleanup(input.value.trim()); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll('button, input')].filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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

  if (!borrower) {
    reportFieldError(panel.querySelector('#lm-borrower'), t('budget.loanBorrowerRequired'));
    return;
  }
  if (isNaN(total_amount) || total_amount <= 0) {
    reportFieldError(panel.querySelector('#lm-amount'), t('budget.validAmountRequired'));
    return;
  }
  if (!Number.isInteger(installment_count) || installment_count < 1) {
    reportFieldError(panel.querySelector('#lm-installments'), t('budget.loanInstallmentsRequired'));
    return;
  }
  if (!/^\d{4}-\d{2}$/.test(start_month)) {
    reportFieldError(panel.querySelector('#lm-start'), t('budget.loanStartMonthRequired'));
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = '…';
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
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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

async function markLoanPayment(id) {
  const loan = state.loans.loans.find((item) => item.id === id);
  if (!loan?.next_installment_number) return;
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
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

async function deleteLoan(id) {
  const loan = state.loans.loans.find((item) => item.id === id);
  if (!loan) return;

  state.loans.loans = state.loans.loans.filter((item) => item.id !== id);
  renderBody();

  scheduleUndoableDelete({
    message: t('budget.loanDeletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/budget/loans/${id}`, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      await loadMonth(state.month);
      renderBody();
    },
    restore: (err) => {
      state.loans.loans = [...state.loans.loans, loan];
      renderBody();
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

async function deleteLoanPayment(loanId, paymentId) {
  const loan = state.loans.loans.find((item) => item.id === loanId);
  const payment = loan?.payments?.find((item) => item.id === paymentId);

  if (loan && payment) {
    loan.payments = loan.payments.filter((item) => item.id !== paymentId);
    renderBody();
  }

  scheduleUndoableDelete({
    message: t('budget.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/budget/loans/${loanId}/payments/${paymentId}`, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      await loadMonth(state.month);
      renderBody();
    },
    restore: (err) => {
      if (loan && payment) {
        loan.payments = [...(loan.payments || []), payment];
        renderBody();
      }
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
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

  scheduleUndoableDelete({
    message: t('budget.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/budget/${id}`, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      await loadMonth(state.month);
      renderBody();
    },
    restore: (err) => {
      if (entry) {
        state.entries = [...state.entries, entry].sort((a, b) => new Date(b.date) - new Date(a.date));
        renderBody();
      }
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
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

  scheduleUndoableDelete({
    message: t('budget.recurringSeriesDeleted'),
    commit: async ({ keepalive }) => {
      await api.delete(`/budget/${id}/series`, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      await loadMonth(state.month);
      renderBody();
    },
    // Undo stellte bisher nichts wieder her (Serie blieb bis zum nächsten
    // Reload verschwunden) — jetzt lädt der Monat neu, der Server hat ja
    // nie gelöscht.
    restore: async (err) => {
      await loadMonth(state.month);
      renderBody();
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}
