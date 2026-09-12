/**
 * Module: Budget subscriptions
 * Purpose: Recurring subscription tracking, budgeting, analytics, and renewal reminders.
 */

import { api } from '/api.js';
import { closeModal, confirmModal, confirmOverModal, openModal, advancedSection, reportFieldError, refocusAfterRender } from '/components/modal.js';
import {
  formatDate,
  getLocale,
  isDateInputValid,
  parseDateInput,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import { todayKey } from '/utils/date.js';
import { CURRENCY_CODES } from '/utils/currency-codes.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { formatMoney, amountPlaceholder, amountStep, applyAmountFormat, amountIsSavable, smallestUnitLabel } from '/utils/money.js';
import { attachOverlay } from '/utils/overlay-history.js';

let state = {
  subscriptions: [],
  summary: null,
  meta: { categories: [], payment_methods: [], billing_cycles: [] },
  settings: { monthly_budget: 0, base_currency: 'EUR' },
  rates: null,
  query: '',
  categoryId: '',
  paymentMethodId: '',
  status: 'all',
  sort: 'due',
  user: null,
};
let container = null;

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
}

// Format aus utils/money.js - EINE Quelle für das ganze Budget-Modul. Vorher
// hatte jede der drei Page-Dateien einen eigenen Formatierer, sodass dieselbe
// Zahl in zwei Untertabs verschieden geschrieben sein konnte (Critique P0).
// Abo-Beträge tragen die Rolle `plain`: Rechnungsbeträge ohne Kontorichtung,
// also kein Vorzeichen und keine Ampelfarbe.
function money(amount, currency = state.summary?.base_currency || state.settings.base_currency) {
  return formatMoney(amount, currency);
}

// EINE ZEILE SAGT SELBST, WIE SIE HEISST. Vorher stand hier eine Karte von
// englischen Vorgabe-NAMEN auf i18n-Schluessel, und daneben - fuer die
// Zahlungsarten - gar nichts: dieselbe Liste stand halb uebersetzt da (#950).
// Eine Namenskarte kann auch nicht wissen, ob 'Other' die Vorgabe oder eine
// selbst angelegte Zeile desselben Namens meint. Seit Migration 170 tragen
// beide Tabellen `label_key`, wie task_categories, contact_categories und
// inventory_categories es laengst tun; Umbenennen loescht ihn, dann gilt der
// eigene Name. Der Rueckfall ist das leere Fach, nicht ein englisches Wort.
function metaLabel(item, emptyKey) {
  if (item?.label_key) return t(item.label_key);
  return item?.name || t(emptyKey);
}

function categoryLabel(category) {
  return metaLabel(category, 'subscriptions.uncategorized');
}

function paymentMethodLabel(method) {
  return metaLabel(method, 'subscriptions.unspecified');
}

// Ein Abo traegt Kategorie und Zahlungsart denormalisiert (JOIN in
// routes/subscriptions.js), also als zwei lose Felder statt als Zeile. Diese
// beiden setzen sie wieder zusammen, damit dieselbe Regel greift wie ueberall
// sonst - genau so macht es inventory.js mit `itemCategoryLabel`. Ohne sie
// laesst sich ein Aufrufer leicht mit dem nackten `*_name` abspeisen, und
// genau daran hing #950.
function rowCategoryLabel(row) {
  return categoryLabel({ name: row?.category_name, label_key: row?.category_label_key });
}

function rowPaymentMethodLabel(row) {
  return paymentMethodLabel({ name: row?.payment_method_name, label_key: row?.payment_method_label_key });
}

function addMonths(date, count) {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + count, 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

function addCycleDate(date, cycle, interval) {
  const next = new Date(date);
  if (cycle === 'daily') next.setDate(next.getDate() + interval);
  else if (cycle === 'weekly') next.setDate(next.getDate() + (interval * 7));
  else if (cycle === 'yearly') next.setFullYear(next.getFullYear() + interval);
  else return addMonths(next, interval);
  return next;
}

// Letztes einzuplanendes Fälligkeitsdatum bei begrenztem Abo (#594), sonst null.
// Für 'after_count' wird das Startdatum um die verbleibenden Zyklen fortgeschrieben.
function subscriptionEndBoundary(subscription) {
  if (subscription.end_type === 'on_date' && subscription.end_date) {
    return new Date(`${subscription.end_date}T00:00:00`);
  }
  if (subscription.end_type === 'after_count') {
    const remaining = Number(subscription.occurrence_count) - Number(subscription.occurrences_done || 0);
    if (remaining <= 0) return new Date(0);
    let last = new Date(`${subscription.next_payment_date}T00:00:00`);
    for (let index = 1; index < remaining; index += 1) {
      last = addCycleDate(last, subscription.billing_cycle, subscription.cycle_interval || 1);
    }
    return last;
  }
  return null;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(getLocale(), { month: 'short' }).format(new Date(year, month - 1, 1));
}

function cycleLabel(subscription) {
  const key = `subscriptions.cycle.${subscription.billing_cycle}`;
  return subscription.cycle_interval === 1
    ? t(key)
    : t('subscriptions.everyCycle', {
      count: subscription.cycle_interval,
      cycle: t(`subscriptions.cyclePlural.${subscription.billing_cycle}`),
    });
}

function daysUntil(date) {
  const today = new Date(`${todayKey()}T00:00:00`);
  const due = new Date(`${date}T00:00:00`);
  return Math.round((due - today) / 86400000);
}

function dueLabel(subscription) {
  const days = daysUntil(subscription.next_payment_date);
  if (days < 0) return t('subscriptions.overdueDays', { count: Math.abs(days) });
  if (days === 0) return t('subscriptions.dueToday');
  if (days === 1) return t('subscriptions.dueTomorrow');
  return t('subscriptions.dueInDays', { count: days });
}

async function load({ refreshRates = false } = {}) {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.categoryId) params.set('category_id', state.categoryId);
  if (state.paymentMethodId) params.set('payment_method_id', state.paymentMethodId);
  if (state.status !== 'all') params.set('status', state.status);
  if (refreshRates) params.set('refresh_rates', 'true');

  const [list, meta, settings] = await Promise.all([
    api.get(`/budget/subscriptions?${params}`),
    api.get('/budget/subscriptions/meta'),
    api.get('/budget/subscriptions/settings'),
  ]);
  state.subscriptions = list.data?.subscriptions || [];
  state.summary = list.data?.summary || null;
  state.rates = list.data?.rates || null;
  state.meta = meta.data || state.meta;
  state.settings = settings.data || state.settings;
}

export async function render(target, { user } = {}) {
  container = target;
  state.user = user || null;
  // `full`, nicht `reading`: die Seite ist nicht auf das Mass migriert. Ihr
  // Analytik-Raster (drei Spalten, zusammen mindestens 724px) und die Liste
  // kennen kein Lesemass; als `reading` haette nur das Kennzahlenband die
  // 720px angenommen und den Sprung zu den Diagrammen darunter erzeugt - als
  // Budget-Reiter wie als Gast-Route. Zielmodus ist `dashboard`, sobald
  // Werkzeugzeile, Raster und Liste dasselbe Mass lesen.
  setHtml(container, `
    <div class="subscriptions-page app-page app-page--full" data-composition="full" aria-busy="true">
      <div class="subscriptions-toolbar">
        <label class="subscriptions-search">
          <i data-lucide="search" aria-hidden="true"></i>
          <span class="sr-only">${t('subscriptions.searchLabel')}</span>
          <input id="subscriptions-search" type="search" placeholder="${t('subscriptions.searchPlaceholder')}" autocomplete="off">
        </label>
        <label class="subscriptions-filter-field">
          <span class="subscriptions-filter-field__label">${t('subscriptions.filterLabelCategory')}</span>
          <select class="form-input subscriptions-filter" id="subscriptions-category-filter"></select>
        </label>
        <label class="subscriptions-filter-field">
          <span class="subscriptions-filter-field__label">${t('subscriptions.filterLabelMethod')}</span>
          <select class="form-input subscriptions-filter" id="subscriptions-method-filter"></select>
        </label>
        <label class="subscriptions-filter-field">
          <span class="subscriptions-filter-field__label">${t('subscriptions.filterLabelStatus')}</span>
          <select class="form-input subscriptions-filter" id="subscriptions-status-filter">
            <option value="all">${t('common.all')}</option>
            <option value="active">${t('subscriptions.statusActive')}</option>
            <option value="paused">${t('subscriptions.statusDisabled')}</option>
            <option value="completed">${t('subscriptions.completed')}</option>
          </select>
        </label>
        <label class="subscriptions-filter-field">
          <span class="subscriptions-filter-field__label">${t('subscriptions.filterLabelSort')}</span>
          <select class="form-input subscriptions-filter" id="subscriptions-sort">
            <option value="due">${t('subscriptions.sortDue')}</option>
            <option value="cost-desc">${t('subscriptions.sortCostDesc')}</option>
            <option value="cost-asc">${t('subscriptions.sortCostAsc')}</option>
            <option value="name">${t('subscriptions.sortName')}</option>
          </select>
        </label>
        <button class="btn btn--ghost subscriptions-filter-reset" id="subscriptions-reset-filters" type="button" hidden>
          <i data-lucide="filter-x" class="icon-sm" aria-hidden="true"></i>${t('subscriptions.resetFilters')}
        </button>
        <div class="subscriptions-toolbar__actions">
          <button class="btn btn--secondary btn--icon" id="subscriptions-manage" aria-label="${t('subscriptions.manageMetadata')}" title="${t('subscriptions.manageMetadata')}">
            <i data-lucide="tags" aria-hidden="true"></i>
          </button>
          <button class="btn btn--secondary btn--icon" id="subscriptions-settings" aria-label="${t('subscriptions.settingsTitle')}" title="${t('subscriptions.settingsTitle')}">
            <i data-lucide="settings-2" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div id="subscriptions-content">${renderSkeletonList({ rows: 5, lines: 2 })}</div>
    </div>
  `);
  if (window.lucide) window.lucide.createIcons({ el: container });
  try {
    await load();
    renderFilters();
    renderContent();
    bindToolbar();
  } catch (err) {
    console.error('[Subscriptions] load error:', err);
    // Vorher stand hier ein Leerzustands-Markup ohne Rolle und ohne CTA: der
    // Fehler war fuer Screenreader stumm und die Seite eine Sackgasse - neu
    // laden ging nur ueber den Browser. `mountLoadError` erzwingt beides.
    mountLoadError(container.querySelector('#subscriptions-content'), {
      title: t('subscriptions.loadError'),
      description: t('common.loadErrorDescription'),
      error: err,
      retryLabel: t('common.retry'),
      onRetry: () => render(container, { user: state.user }),
    });
  } finally {
    container.querySelector('.subscriptions-page')?.setAttribute('aria-busy', 'false');
    if (window.lucide) window.lucide.createIcons({ el: container });
  }
}

function renderFilters() {
  // Die Neutral-Option jedes Filters heisst „Alle", nicht „Alle Kategorien" /
  // „Alle Zahlungsarten" / „Alle Status": das Feldlabel steht sichtbar darueber
  // und der Wert wiederholte es nur. Die Wiederholung forderte fuer alle vier
  // Selects dieselbe Breite und kappte am Ende den einzigen Wert, der wirklich
  // Platz braucht (die Sortierung).
  const category = container.querySelector('#subscriptions-category-filter');
  const method = container.querySelector('#subscriptions-method-filter');
  setHtml(category, `
    <option value="">${t('common.all')}</option>
    ${state.meta.categories.map((item) => `<option value="${item.id}">${esc(categoryLabel(item))}</option>`).join('')}
  `);
  setHtml(method, `
    <option value="">${t('common.all')}</option>
    ${state.meta.payment_methods.map((item) => `<option value="${item.id}">${esc(paymentMethodLabel(item))}</option>`).join('')}
  `);
  category.value = state.categoryId;
  method.value = state.paymentMethodId;
  container.querySelector('#subscriptions-status-filter').value = state.status;
  container.querySelector('#subscriptions-sort').value = state.sort;
  updateResetButton();
}

// Vier Filter plus Suche können gleichzeitig greifen — ohne Ausweg wirkt eine
// leere Liste wie „keine Abos" statt „nichts passt zum Filter". Der Knopf
// erscheint nur, wenn tatsächlich etwas eingeschränkt ist.
function hasActiveFilters() {
  return Boolean(state.query) || Boolean(state.categoryId) || Boolean(state.paymentMethodId)
    || state.status !== 'all' || state.sort !== 'due';
}

function updateResetButton() {
  const btn = container.querySelector('#subscriptions-reset-filters');
  if (btn) btn.hidden = !hasActiveFilters();
}

async function resetFilters() {
  state.query = '';
  state.categoryId = '';
  state.paymentMethodId = '';
  state.status = 'all';
  state.sort = 'due';
  const search = container.querySelector('#subscriptions-search');
  if (search) search.value = '';
  await reload();
}

function bindToolbar() {
  let searchTimer;
  container.querySelector('#subscriptions-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.query = event.target.value.trim();
      await reload();
    }, 250);
  });
  container.querySelector('#subscriptions-category-filter').addEventListener('change', async (event) => {
    state.categoryId = event.target.value;
    await reload();
  });
  container.querySelector('#subscriptions-method-filter').addEventListener('change', async (event) => {
    state.paymentMethodId = event.target.value;
    await reload();
  });
  container.querySelector('#subscriptions-status-filter').addEventListener('change', async (event) => {
    state.status = event.target.value;
    await reload();
  });
  container.querySelector('#subscriptions-sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    updateResetButton();
    renderContent();
  });
  container.querySelector('#subscriptions-reset-filters').addEventListener('click', resetFilters);
  container.querySelector('#subscriptions-manage').addEventListener('click', openMetadataModal);
  container.querySelector('#subscriptions-settings').addEventListener('click', openSettingsModal);
}

async function reload(options) {
  try {
    await load(options);
    renderFilters();
    renderContent();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error || t('subscriptions.loadError'), 'danger');
  }
}

function sortedSubscriptions() {
  return [...state.subscriptions].sort((a, b) => {
    if (state.sort === 'cost-desc') return (b.monthly_base ?? -1) - (a.monthly_base ?? -1);
    if (state.sort === 'cost-asc') return (a.monthly_base ?? Infinity) - (b.monthly_base ?? Infinity);
    if (state.sort === 'name') return a.name.localeCompare(b.name, getLocale());
    return a.next_payment_date.localeCompare(b.next_payment_date) || a.name.localeCompare(b.name, getLocale());
  });
}

function renderContent() {
  const content = container.querySelector('#subscriptions-content');
  const rows = sortedSubscriptions();
  // Kurs-Status/-Aktion nur, wenn überhaupt ein Abo in Fremdwährung läuft -
  // sonst ist „Wechselkurse nicht verfügbar" eine Dauerwarnung ohne Anlass.
  const baseCurrency = state.summary?.base_currency || state.settings.base_currency;
  const hasForeignCurrency = rows.some((s) => s.currency && s.currency !== baseCurrency);
  setHtml(content, `
    ${renderSummary()}
    ${renderAnalytics()}
    <section class="subscriptions-list-section">
      <div class="subscriptions-section-head">
        <div>
          <h2>${t('subscriptions.listTitle')}</h2>
          <span>${t('subscriptions.listCount', { count: rows.length })}</span>
        </div>
        ${!hasForeignCurrency ? ''
          : state.rates?.source === 'unavailable'
            ? `<span class="subscriptions-rate-status subscriptions-rate-status--warning">${t('subscriptions.ratesUnavailable')}</span>`
            : `<button class="btn btn--secondary" id="subscriptions-refresh-rates">
              <i data-lucide="refresh-cw" aria-hidden="true"></i>${t('subscriptions.refreshRates')}
            </button>`}
      </div>
      <div class="subscriptions-list row-divided" id="subscriptions-list">
        ${rows.length ? rows.map(renderCard).join('') : renderEmpty()}
      </div>
    </section>
  `);
  bindContent();
  if (window.lucide) window.lucide.createIcons({ el: content });
}

function renderSummary() {
  const summary = state.summary || {
    active_count: 0,
    monthly_total: 0,
    monthly_budget: 0,
    remaining_budget: 0,
    base_currency: state.settings.base_currency,
  };
  const budget = Number(summary.monthly_budget || 0);
  const used = Number(summary.monthly_total || 0);
  const hasBudget = budget > 0;
  // Balkenbreite ist bei 100% gecappt, das Label nennt die echte Auslastung (121% statt „100%").
  const realPercentage = hasBudget ? Math.round((used / budget) * 100) : 0;
  const percentage = Math.min(100, realPercentage);
  const isOverBudget = hasBudget && summary.remaining_budget < 0;
  // Geteilte Kennzahl-Zeile und -Karte des Budget-Moduls (budget.css). Die
  // frühere eigene .subscriptions-summary-card war die zweite von fünf
  // Bauarten im selben Modul (Critique 2026-07-30, P0).
  // Rolle `plain`: Abo-Kosten sind Rechnungsbeträge ohne Kontorichtung.
  return `
    <section class="metric-grid metric-grid--quad">
      <article class="metric-card">
        <div class="metric-card__label">${t('subscriptions.monthlyCost')}</div>
        <div class="metric-card__value">${money(used)}</div>
        <div class="metric-card__note">${t('subscriptions.activeCount', { count: summary.active_count })}</div>
      </article>
      <article class="metric-card">
        <div class="metric-card__label">${t('subscriptions.monthlyBudget')}</div>
        <div class="metric-card__value">${money(budget)}</div>
        <div class="metric-card__progress${isOverBudget ? ' metric-card__progress--over' : ''}"
             role="progressbar" aria-label="${esc(t('subscriptions.monthlyBudget'))}"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}" aria-valuetext="${realPercentage}%">
          <span style="--fill:${percentage / 100}"></span>
        </div>
      </article>
      <article class="metric-card${isOverBudget ? ' metric-card--negative' : ''}">
        <div class="metric-card__label">${hasBudget ? (isOverBudget ? t('subscriptions.overBudget') : t('subscriptions.remainingBudget')) : t('subscriptions.noBudgetLimit')}</div>
        <div class="metric-card__value">${hasBudget ? money(Math.abs(summary.remaining_budget)) : t('subscriptions.unlimited')}</div>
        <div class="metric-card__note${isOverBudget ? ' metric-card__note--danger' : ''}">${hasBudget ? `${realPercentage}% ${t('subscriptions.budgetUsed')}` : t('subscriptions.setBudgetHint')}</div>
      </article>
      <article class="metric-card">
        <div class="metric-card__label">${t('subscriptions.yearlyProjection')}</div>
        <div class="metric-card__value">${money(used * 12)}</div>
        <div class="metric-card__note">${esc(summary.base_currency)}</div>
      </article>
    </section>
  `;
}

function renderAnalytics() {
  const categories = amountRows(state.summary?.by_category || [], categoryLabel);
  const methods = amountRows(state.summary?.by_payment_method || [], paymentMethodLabel);
  const forecast = renewalForecast();
  return `
    <section class="subscriptions-analytics">
      ${renderAreaChart(t('subscriptions.renewalForecast'), forecast)}
      ${renderPieChart(t('subscriptions.byCategory'), categories)}
      ${renderBreakdown(t('subscriptions.byPaymentMethod'), methods)}
    </section>
  `;
}

function amountRows(rows, labelFor) {
  return rows
    .map((row) => ({ ...row, label: labelFor(row), amount: Number(row.amount || 0) }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

function dueAmount(subscription) {
  if (subscription.monthly_base === null) return 0;
  if (subscription.currency === (state.summary?.base_currency || state.settings.base_currency)) return Number(subscription.amount || 0);
  const nativeMonthly = Number(subscription.monthly_native || 0);
  if (!nativeMonthly) return Number(subscription.monthly_base || 0);
  return Number(subscription.amount || 0) * (Number(subscription.monthly_base || 0) / nativeMonthly);
}

function renewalForecast() {
  const today = new Date(`${todayKey()}T00:00:00`);
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = addMonths(start, index);
    return { key: monthKey(date), label: monthLabel(monthKey(date)), amount: 0 };
  });
  const monthMap = new Map(months.map((row) => [row.key, row]));
  const end = addMonths(start, months.length);
  for (const subscription of state.subscriptions.filter((row) => row.enabled)) {
    const boundary = subscriptionEndBoundary(subscription);
    let due = new Date(`${subscription.next_payment_date}T00:00:00`);
    while (due < start) due = addCycleDate(due, subscription.billing_cycle, subscription.cycle_interval || 1);
    while (due < end && (!boundary || due <= boundary)) {
      const row = monthMap.get(monthKey(due));
      if (row) row.amount += dueAmount(subscription);
      due = addCycleDate(due, subscription.billing_cycle, subscription.cycle_interval || 1);
    }
  }
  return months.map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }));
}

// KEINE geteilte Chart-Geometrie (utils/chart.js), und das ist Absicht: die
// traegt einen 40px-Gutter fuer eine Werteachse, und diese Flaeche hat keine.
// Sie ist 72px flach, beschriftet alle sechs Monate statt drei Marken und liegt
// damit naeher an der Sparkline der Kennzahlkarte als am Trend-Chart. Eine
// andere FORM, keine andere Fassung derselben.
//
// `vector-effect` ist dagegen faellig: `preserveAspectRatio="none"` streckt
// einen 100x52-viewBox auf rund 300x72, also X um Faktor 3 und Y um 1,4 - ohne
// den Ausschalter wird die 2,5px-Linie in einer Achse dicker als in der
// anderen. Dieselbe Zeile steht an jeder anderen gestreckten Kurve der App.
function renderAreaChart(title, rows) {
  const max = Math.max(...rows.map((row) => row.amount), 1);
  const points = rows.map((row, index) => {
    const x = rows.length === 1 ? 50 : Math.round((index / (rows.length - 1)) * 100);
    const y = Math.round(46 - ((row.amount / max) * 34));
    return `${x},${y}`;
  }).join(' ');
  const areaPoints = `0,52 ${points} 100,52`;
  return `
    <article class="subscriptions-chart subscriptions-chart--area">
      <div class="subscriptions-chart__head">
        <h2>${title}</h2>
        <strong>${money(Math.max(...rows.map((row) => row.amount), 0))}</strong>
      </div>
      <svg class="subscriptions-area-chart" viewBox="0 0 100 52" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="${areaPoints}"></polygon>
        <polyline points="${points}" vector-effect="non-scaling-stroke"></polyline>
      </svg>
      <div class="subscriptions-chart-axis">
        ${rows.map((row) => `<span>${esc(row.label)}</span>`).join('')}
      </div>
    </article>
  `;
}

function renderPieChart(title, rows) {
  // Datenreihen-Tokens statt Hex-Literalen: tokens.css definiert die Serie im
  // Dark Mode auf hellere Werte um, Literale machten das nicht mit - der Donut
  // behielt dort seine Light-Mode-Sättigung, während der Statistik-Donut nebenan
  // korrekt aufhellte (Critique 2026-07-30). conic-gradient und der Legenden-
  // Hintergrund verarbeiten var() unverändert.
  const colors = Array.from({ length: 6 }, (_, i) => `var(--chart-series-${i + 1})`);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  let offset = 0;
  const gradient = total > 0
    ? rows.slice(0, 6).map((row, index) => {
      const start = offset;
      offset += (row.amount / total) * 360;
      return `${colors[index % colors.length]} ${start}deg ${offset}deg`;
    }).join(', ')
    : 'var(--color-surface-3) 0deg 360deg';
  return `
    <article class="subscriptions-chart subscriptions-chart--pie">
      <div class="subscriptions-chart__head">
        <h2>${title}</h2>
        <strong>${money(total)}</strong>
      </div>
      ${rows.length ? `
        <div class="subscriptions-pie-layout">
          <div class="subscriptions-pie" style="background:conic-gradient(${gradient})"></div>
          <div class="subscriptions-pie-legend">
            ${rows.slice(0, 4).map((row, index) => `
              <span><i style="background:${colors[index % colors.length]}"></i>${esc(row.label)}</span>
            `).join('')}
          </div>
        </div>
      ` : `<p>${t('subscriptions.noAnalytics')}</p>`}
    </article>
  `;
}

function renderBreakdown(title, rows) {
  const max = Math.max(...rows.map((row) => row.amount), 1);
  return `
    <article class="subscriptions-chart">
      <div class="subscriptions-chart__head">
        <h2>${title}</h2>
      </div>
      ${rows.length ? rows.map((row) => `
        <div class="subscriptions-chart-row">
          <span title="${esc(row.label)}">${esc(row.label)}</span>
          <div><i style="width:${Math.round((row.amount / max) * 100)}%"></i></div>
          <strong>${money(row.amount)}</strong>
        </div>
      `).join('') : `<p>${t('subscriptions.noAnalytics')}</p>`}
    </article>
  `;
}

function statusMeta(subscription) {
  const status = subscription.status || (subscription.enabled ? 'active' : 'paused');
  if (status === 'completed') return { cardClass: 'subscription-card--completed', badgeClass: 'subscription-status--completed', label: t('subscriptions.completed') };
  if (status === 'active') return { cardClass: '', badgeClass: 'subscription-status--active', label: t('subscriptions.active') };
  return { cardClass: 'subscription-card--disabled', badgeClass: '', label: t('subscriptions.disabled') };
}

// Ende-Zeile in der Card (#594): abgeschlossen, Enddatum oder Restzahlungen.
function endInfoLabel(subscription) {
  if (subscription.status === 'completed') {
    const day = subscription.completed_at ? String(subscription.completed_at).slice(0, 10) : null;
    return { icon: 'circle-check', text: day ? t('subscriptions.completedOn', { date: formatDate(day) }) : t('subscriptions.completed') };
  }
  if (subscription.end_type === 'on_date' && subscription.end_date) {
    return { icon: 'calendar-x', text: t('subscriptions.endsOn', { date: formatDate(subscription.end_date) }) };
  }
  if (subscription.end_type === 'after_count') {
    return { icon: 'list-ordered', text: t('subscriptions.endsAfter', { count: Number(subscription.occurrences_remaining ?? 0) }) };
  }
  return null;
}

// Die Zeile fuehrt ZWEI Aktionen, und welche, sagt der Rang (§2, Session 16):
// der Zeilenanfang die primaere positive - eine Zahlung buchen -, das Zeilenende
// das Destruktive. Bearbeiten liegt auf dem TAP, nicht auf einer Wischrichtung
// und nicht mehr auf einem eigenen Knopf; der Zustandsschalter ist ganz
// entfallen, weil dasselbe Feld im Bearbeiten-Formular steht. Vier Icon-Knoepfe
// je Zeile waren die lauteste Stelle des Bildschirms, uebrig sind zwei.
//
// BEWUSST kein aria-label am Zeilenkoerper: `role=button` ist per ARIA "children
// presentational", das Label haette also den ganzen Inhalt ersetzt - Name,
// Status, Faelligkeit, Zyklus, Zahlungsart und Betrag zusammen zu "Bearbeiten,
// Schaltfläche". Genau derselbe Beschluss steht in `pantry.js` (Critique P1,
// WCAG 1.3.1/4.1.2) und `contacts.js`. Aus demselben Grund tragen Name und
// Beschreibung `<span>` statt `<h3>`/`<p>`: Content-Model eines `<button>` ist
// Phrasing Content. Was der Knopf TUT, kommt als sr-only Zusatz ans Ende.
function renderCard(subscription) {
  const brandColor = subscription.brand_color || subscription.category_color || '#0F766E';
  const converted = subscription.monthly_base === null
    ? t('subscriptions.conversionUnavailable')
    : t('subscriptions.monthlyEquivalent', { amount: money(subscription.monthly_base) });
  const status = statusMeta(subscription);
  const endInfo = endInfoLabel(subscription);
  return `
    <div class="swipe-row" data-swipe-id="${subscription.id}">
      <div class="swipe-reveal swipe-reveal--done swipe-reveal--leading" aria-hidden="true">
        <i data-lucide="calendar-check" class="icon-md"></i>
        <span>${t('subscriptions.markRenewed')}</span>
      </div>
      <div class="swipe-reveal swipe-reveal--delete swipe-reveal--trailing" aria-hidden="true">
        <i data-lucide="trash-2" class="icon-md"></i>
        <span>${t('common.delete')}</span>
      </div>
    <article class="subscription-card ${status.cardClass}"
             data-id="${subscription.id}" style="--subscription-color:${esc(brandColor)}">
      <button type="button" class="subscription-card__main list-row__main--interactive"
              data-action="edit">
        <span class="subscription-card__brand">
          ${subscription.logo_data
            ? `<img src="${esc(subscription.logo_data)}" alt="">`
            : `<span>${esc(subscription.name.slice(0, 2).toUpperCase())}</span>`}
        </span>
        <span class="subscription-card__body">
          <span class="subscription-card__title-row">
            <span>
              <span class="subscription-card__name">${esc(subscription.name)}</span>
              <span class="subscription-card__desc">${esc(subscription.description || rowCategoryLabel(subscription))}</span>
            </span>
            <span class="subscription-status ${status.badgeClass}">
              ${status.label}
            </span>
          </span>
          <span class="subscription-card__meta">
            <span><i data-lucide="calendar-clock" aria-hidden="true"></i>${formatDate(subscription.next_payment_date)} · ${dueLabel(subscription)}</span>
            <span><i data-lucide="repeat-2" aria-hidden="true"></i>${cycleLabel(subscription)}</span>
            <span><i data-lucide="wallet-cards" aria-hidden="true"></i>${esc(rowPaymentMethodLabel(subscription))}</span>
            <span><i data-lucide="bell" aria-hidden="true"></i>${t('subscriptions.reminderMeta', { count: subscription.reminder_days })}</span>
            ${endInfo ? `<span><i data-lucide="${endInfo.icon}" aria-hidden="true"></i>${esc(endInfo.text)}</span>` : ''}
          </span>
        </span>
        <span class="subscription-card__cost">
          <strong>${money(subscription.amount, subscription.currency)}</strong>
          <span>${converted}</span>
        </span>
        <span class="sr-only">${t('common.edit')}</span>
      </button>
      <div class="subscription-card__actions">
        <button class="btn btn--secondary btn--icon" data-action="renew" aria-label="${t('subscriptions.markRenewed')}">
          <i data-lucide="calendar-check" aria-hidden="true"></i>
        </button>
        <button class="btn btn--secondary btn--icon" data-action="delete" aria-label="${t('subscriptions.delete')}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>
      </div>
    </article>
    </div>
  `;
}

/**
 * Die Wischgesten der Abo-Liste. Zuordnung nach dem app-weiten Rang: der
 * Zeilenanfang traegt die primaere positive Aktion (eine Zahlung buchen), das
 * Zeilenende das Destruktive.
 *
 * KEINE der beiden Richtungen laesst die Zeile hinausfliegen. Beide fuehren
 * ueber eine Bestaetigung, und was danach kommt, entscheidet der Nutzer - eine
 * Zeile, die schon weg ist, waehrend der Dialog noch fragt, hat die Antwort
 * vorweggenommen. Der Knopf daneben ruft dieselbe Funktion, damit die Geste
 * keine zweite Schreibweise derselben Arbeit wird.
 */
function wireSubscriptionSwipe(host) {
  wireSwipeRows(host, {
    card: '.subscription-card',
    leading: {
      reveal: '.swipe-reveal--done',
      run: (row) => {
        const subscription = subscriptionFor(row);
        if (subscription) renewSubscription(subscription);
      },
    },
    trailing: {
      reveal: '.swipe-reveal--delete',
      run: (row) => {
        const subscription = subscriptionFor(row);
        if (subscription) deleteSubscription(subscription);
      },
    },
  });
}

// Beide Richtungen RUFEN ihre Funktion, statt sie einem Helfer zu uebergeben.
// Der Guard auf Ebene 3 folgt von der Wischrichtung der Aufrufkante zu der
// Funktion, in der der Rueckweg steht - eine als Argument durchgereichte
// Referenz waere fuer ihn keine Kante, und er haette den Rueckweg nicht
// gefunden, obwohl er da ist. Eine Verdrahtung, die ein Guard nicht lesen kann,
// ist eine, die beim naechsten Mal niemand prueft.
function subscriptionFor(row) {
  return state.subscriptions.find((item) => item.id === Number(row.dataset.swipeId));
}

function renderEmpty() {
  // „Keine Abos" und „nichts passt zum Filter" sind verschiedene Zustände: der
  // erste braucht eine Anlegen-Aktion, der zweite einen Weg zurück. Die
  // Variante traegt den Unterschied jetzt mit: `no-results` wird als
  // `role="status"` angesagt und fuehrt einen sekundaeren CTA.
  if (hasActiveFilters()) {
    return emptyStateHTML({
      variant: 'no-results',
      icon: 'filter-x',
      title: t('subscriptions.noMatchesTitle'),
      description: t('subscriptions.noMatchesDescription'),
      action: { label: t('subscriptions.resetFilters'), attrs: { id: 'subscriptions-empty-reset' } },
    });
  }
  return emptyStateHTML({
    icon: 'repeat-2',
    title: t('subscriptions.emptyTitle'),
    description: t('subscriptions.emptyDescription'),
    action: { label: t('subscriptions.add'), attrs: { id: 'subscriptions-empty-add' } },
  });
}

function bindContent() {
  container.querySelector('#subscriptions-refresh-rates')?.addEventListener('click', () => reload({ refreshRates: true }));
  container.querySelector('#subscriptions-empty-add')?.addEventListener('click', () => openSubscriptionModal());
  container.querySelector('#subscriptions-empty-reset')?.addEventListener('click', resetFilters);
  const list = container.querySelector('#subscriptions-list');
  list?.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]');
    const card = event.target.closest('.subscription-card');
    const subscription = state.subscriptions.find((row) => row.id === Number(card?.dataset.id));
    if (!subscription) return;

    if (!action) return;
    // Der Zeilenkoerper OEFFNET das Bearbeiten und ist dafuer ein echter
    // `<button>` (`.list-row__main--interactive`, das app-weite Vokabular fuer
    // eine klickbare Zeile). Ein blosser Tap-Handler auf dem `<article>` haette
    // den Bearbeiten-Knopf entfernt, ohne einen Tastaturweg an seine Stelle zu
    // setzen - das waere kein Aufraeumen, sondern ein Regress.
    if (action.dataset.action === 'edit') openSubscriptionModal(subscription);
    if (action.dataset.action === 'renew') await renewSubscription(subscription);
    if (action.dataset.action === 'delete') await deleteSubscription(subscription);
  });
  if (list) {
    wireSubscriptionSwipe(list);
    maybeShowSwipeHint(list);
  }
}

function currencyItems() {
  let names;
  try {
    names = new Intl.DisplayNames([getLocale()], { type: 'currency' });
  } catch {
    names = null;
  }
  return CURRENCY_CODES.map((code) => ({
    value: code,
    label: `${code} · ${names?.of(code) || code}`,
  }));
}

function comboboxMarkup({ id, label, items, value = '', placeholder }) {
  const selected = items.find((item) => String(item.value) === String(value));
  return `
    <div class="form-group subscriptions-combobox" data-combobox="${id}">
      <label class="form-label" for="${id}-search">${label}</label>
      <div class="subscriptions-combobox__control">
        <i data-lucide="search" aria-hidden="true"></i>
        <input class="form-input" id="${id}-search" type="search" role="combobox"
               aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-options"
               autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(selected?.label || '')}">
        <input id="${id}" type="hidden" value="${esc(selected?.value ?? '')}">
      </div>
      <div class="subscriptions-combobox__options" id="${id}-options" role="listbox" hidden>
        ${items.map((item) => `
          <button type="button" role="option" data-value="${esc(item.value)}"
                  aria-selected="${String(item.value) === String(value)}">${esc(item.label)}</button>
        `).join('')}
      </div>
    </div>
  `;
}

function wireCombobox(panel, id) {
  const root = panel.querySelector(`[data-combobox="${id}"]`);
  const search = root.querySelector(`#${id}-search`);
  const value = root.querySelector(`#${id}`);
  const options = [...root.querySelectorAll('[role="option"]')];
  let suppressFocusOpen = false;
  const open = () => {
    root.querySelector('.subscriptions-combobox__options').hidden = false;
    search.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    root.querySelector('.subscriptions-combobox__options').hidden = true;
    search.setAttribute('aria-expanded', 'false');
  };
  const select = (option) => {
    value.value = option.dataset.value;
    search.value = option.textContent.trim();
    options.forEach((item) => item.setAttribute('aria-selected', String(item === option)));
    close();
    // Das Wertfeld ist ein verstecktes Input, das nur programmatisch gesetzt
    // wird - ohne dieses Event erfährt niemand von der Auswahl. Die Betragsfelder
    // hängen an der Währungs-Combobox und müssen dabei nachziehen.
    value.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const selectFromKeyboard = (option) => {
    select(option);
    suppressFocusOpen = true;
    search.focus({ preventScroll: true });
    setTimeout(() => { suppressFocusOpen = false; }, 120);
  };
  const filter = () => {
    const query = search.value.trim().toLocaleLowerCase(getLocale());
    options.forEach((option) => {
      option.hidden = Boolean(query) && !option.textContent.toLocaleLowerCase(getLocale()).includes(query);
    });
    open();
  };
  search.addEventListener('focus', () => {
    if (suppressFocusOpen) return;
    search.select();
    filter();
  });
  search.addEventListener('input', () => {
    value.value = '';
    filter();
  });
  search.addEventListener('keydown', (event) => {
    const visible = options.filter((option) => !option.hidden);
    const active = visible.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open();
      (visible[Math.min(active + 1, visible.length - 1)] || visible[0])?.focus();
    }
    if (event.key === 'Enter' && visible.length) {
      event.preventDefault();
      event.stopPropagation();
      selectFromKeyboard(visible[0]);
    }
    if (event.key === 'Escape') close();
  });
  options.forEach((option) => {
    option.addEventListener('pointerdown', (event) => {
      event.preventDefault();
    });
    option.addEventListener('click', (event) => {
      event.preventDefault();
      select(option);
    });
    option.addEventListener('keydown', (event) => {
      const visible = options.filter((item) => !item.hidden);
      const index = visible.indexOf(option);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      }
      if (event.key === 'Escape') {
        close();
        search.focus();
      }
    });
  });
  root.addEventListener('focusout', () => setTimeout(() => {
    if (!root.contains(document.activeElement)) close();
  }, 0));
}

export function openSubscriptionModal(subscription = null) {
  const edit = Boolean(subscription);
  // Jedes Abo trägt seine eigene Währung; das Betragsfeld richtet sich danach
  // und wird beim Wechsel der Währungs-Combobox nachgezogen.
  const formCurrency = subscription?.currency || state.settings.base_currency;
  const cycleItems = state.meta.billing_cycles.map((cycle) => ({
    value: cycle,
    label: t(`subscriptions.cycle.${cycle}`),
  }));
  const categoryItems = [
    { value: '', label: t('subscriptions.uncategorized') },
    ...state.meta.categories.map((item) => ({ value: item.id, label: categoryLabel(item) })),
  ];
  const methodItems = [
    { value: '', label: t('subscriptions.unspecified') },
    ...state.meta.payment_methods.map((item) => ({ value: item.id, label: paymentMethodLabel(item) })),
  ];
  const initialLogo = subscription?.logo_data || '';
  const initialName = subscription?.name || '';

  // Sekundärfelder: Organisation + Service hinter „Weitere Einstellungen".
  // Beim Bearbeiten automatisch geöffnet, falls bereits Werte abseits der Defaults gesetzt sind.
  const advancedOpen = edit && (
    !!subscription.category_id
    || !!subscription.payment_method_id
    || (!!subscription.brand_color && subscription.brand_color !== '#0F766E')
    || !!subscription.notes
    || subscription.enabled === false
  );

  const advancedFieldsHtml = `
      <section class="subscription-form__section">
        <h3><i data-lucide="tags" aria-hidden="true"></i>${t('subscriptions.organizationDetails')}</h3>
        <div class="subscription-form__organization-grid">
          ${comboboxMarkup({
            id: 'subscription-category',
            label: t('subscriptions.categoryLabel'),
            items: categoryItems,
            value: subscription?.category_id || '',
            placeholder: t('subscriptions.categorySearchPlaceholder'),
          })}
          ${comboboxMarkup({
            id: 'subscription-method',
            label: t('subscriptions.paymentMethodLabel'),
            items: methodItems,
            value: subscription?.payment_method_id || '',
            placeholder: t('subscriptions.paymentMethodSearchPlaceholder'),
          })}
          <div class="form-group subscription-form__color">
            <label class="form-label" for="subscription-color">${t('subscriptions.brandColorLabel')}</label>
            <input class="form-input form-input--color" id="subscription-color" type="color" value="${esc(subscription?.brand_color || '#0F766E')}">
          </div>
        </div>
      </section>

      <section class="subscription-form__section">
        <h3><i data-lucide="panel-top" aria-hidden="true"></i>${t('subscriptions.serviceDetails')}</h3>
        <div class="form-group">
          <label class="form-label" for="subscription-account">${t('subscriptions.accountUsernameLabel')}</label>
          <input class="form-input" type="text" id="subscription-account" maxlength="200"
                 autocomplete="off" spellcheck="false" value="${esc(subscription?.account_username || '')}">
          <p class="form-hint">${t('subscriptions.accountUsernameHint')}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="subscription-notes">${t('subscriptions.notesLabel')}</label>
          <textarea class="form-input" id="subscription-notes" rows="3">${esc(subscription?.notes || '')}</textarea>
        </div>
        <div class="subscriptions-enabled-row">
          <div>
            <strong>${t('subscriptions.enabledLabel')}</strong>
            <small>${t('subscriptions.enabledHint')}</small>
          </div>
          <label class="toggle">
            <input id="subscription-enabled" type="checkbox" ${subscription?.enabled === false ? '' : 'checked'}>
            <span class="toggle__track"></span>
          </label>
        </div>
      </section>`;

  const content = `
    <form id="subscription-form" class="subscription-form">
      <section class="subscription-form__section subscription-form__identity">
        <div class="subscription-logo-tools">
          <label class="subscription-logo-picker" for="subscription-logo" title="${t('subscriptions.logoLabel')}">
            <span id="subscription-logo-preview">
              ${initialLogo
                ? `<img src="${esc(initialLogo)}" alt="">`
                : `<strong>${esc(initialName.slice(0, 2).toUpperCase() || '+')}</strong>`}
            </span>
            <small><i data-lucide="upload" aria-hidden="true"></i>${t('subscriptions.logoLabel')}</small>
            <input id="subscription-logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml">
          </label>
          <button class="btn btn--secondary subscription-find-logo-btn" type="button" id="subscription-find-logo">
            <i data-lucide="scan-search" aria-hidden="true"></i>${t('subscriptions.findLogo')}
          </button>
        </div>
        <div class="subscription-form__identity-fields">
          <div class="form-group">
            <label class="form-label" for="subscription-name">${t('subscriptions.nameLabel')}</label>
            <input class="form-input" id="subscription-name" maxlength="200" required value="${esc(initialName)}">
          </div>
          <div class="form-group">
            <label class="form-label" for="subscription-description">${t('subscriptions.descriptionLabel')}</label>
            <input class="form-input" id="subscription-description" maxlength="5000" value="${esc(subscription?.description || '')}">
          </div>
        </div>
      </section>

      <section class="subscription-form__section">
        <h3><i data-lucide="receipt-text" aria-hidden="true"></i>${t('subscriptions.billingDetails')}</h3>
        <div class="subscription-form__billing-grid">
          <div class="form-group">
            <label class="form-label" for="subscription-amount">${t('subscriptions.amountLabel')}</label>
            <input class="form-input" id="subscription-amount" type="number"
                   min="0"
                   step="${amountStep(formCurrency, subscription?.amount ?? '')}"
                   placeholder="${amountPlaceholder(formCurrency)}"
                   inputmode="decimal" required value="${subscription?.amount ?? ''}">
          </div>
          ${comboboxMarkup({
            id: 'subscription-currency',
            label: t('subscriptions.currencyLabel'),
            items: currencyItems(),
            value: subscription?.currency || state.settings.base_currency,
            placeholder: t('subscriptions.currencySearchPlaceholder'),
          })}
          ${comboboxMarkup({
            id: 'subscription-cycle',
            label: t('subscriptions.billingCycleLabel'),
            items: cycleItems,
            value: subscription?.billing_cycle || 'monthly',
            placeholder: t('subscriptions.billingCycleLabel'),
          })}
          <div class="form-group">
            <label class="form-label" for="subscription-interval">${t('subscriptions.intervalLabel')}</label>
            <input class="form-input" id="subscription-interval" type="number" min="1" max="365" step="1" value="${subscription?.cycle_interval || 1}">
          </div>
        </div>
      </section>

      <section class="subscription-form__section">
        <h3><i data-lucide="calendar-clock" aria-hidden="true"></i>${t('subscriptions.renewalDetails')}</h3>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label" for="subscription-next-date">${t('subscriptions.nextPaymentLabel')}</label>
            <yuvomi-datepicker id="subscription-next-date" type="date"
                   value="${esc(subscription?.next_payment_date || todayKey())}"></yuvomi-datepicker>
          </div>
          <div class="form-group">
            <label class="form-label" for="subscription-reminder">${t('subscriptions.reminderDaysLabel')}</label>
            <input class="form-input" id="subscription-reminder" type="number" min="0" max="365" step="1" value="${subscription?.reminder_days ?? 3}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="subscription-end-type">${t('subscriptions.endLabel')}</label>
          <select class="form-input" id="subscription-end-type">
            <option value="never">${t('subscriptions.endNever')}</option>
            <option value="on_date">${t('subscriptions.endOnDate')}</option>
            <option value="after_count">${t('subscriptions.endAfterCount')}</option>
          </select>
        </div>
        <div class="form-grid-2">
          <div class="form-group" id="subscription-end-date-field" ${(subscription?.end_type === 'on_date') ? '' : 'hidden'}>
            <label class="form-label" for="subscription-end-date">${t('subscriptions.endDateLabel')}</label>
            <yuvomi-datepicker id="subscription-end-date" type="date"
                   value="${esc(subscription?.end_date || '')}"></yuvomi-datepicker>
          </div>
          <div class="form-group" id="subscription-end-count-field" ${(subscription?.end_type === 'after_count') ? '' : 'hidden'}>
            <label class="form-label" for="subscription-end-count">${t('subscriptions.endCountLabel')}</label>
            <input class="form-input" id="subscription-end-count" type="number" min="1" max="1200" step="1" value="${subscription?.occurrence_count ?? ''}">
          </div>
        </div>
      </section>

      ${advancedSection(advancedFieldsHtml, { open: advancedOpen })}
      <div class="modal-panel__footer subscriptions-modal-footer">
        <button class="btn btn--secondary" type="button" id="subscription-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" type="submit">${edit ? t('common.save') : t('common.add')}</button>
      </div>
    </form>
  `;
  openModal({
    title: edit ? t('subscriptions.editTitle') : t('subscriptions.addTitle'),
    content,
    size: 'lg',
    onSave(panel) {
      let searchedLogoData = null;
      const logoPreview = panel.querySelector('#subscription-logo-preview');
      const showLogo = (data) => {
        logoPreview.replaceChildren();
        if (data) {
          logoPreview.insertAdjacentHTML('afterbegin', `<img src="${esc(data)}" alt="">`);
        } else {
          logoPreview.insertAdjacentHTML('afterbegin', `<strong>${esc(panel.querySelector('#subscription-name').value.slice(0, 2).toUpperCase() || '+')}</strong>`);
        }
      };
      wireCombobox(panel, 'subscription-currency');
      // Ohne `required`: ein Abo darf 0 kosten (Gratis-Tarif, Server prüft
      // amount >= 0), die Untergrenze bleibt also bei null statt bei einer
      // kleinsten Einheit.
      panel.querySelector('#subscription-currency').addEventListener('change', (event) => {
        applyAmountFormat(panel.querySelector('#subscription-amount'), event.target.value);
      });
      wireCombobox(panel, 'subscription-cycle');
      wireCombobox(panel, 'subscription-category');
      wireCombobox(panel, 'subscription-method');
      // Ende-Bedingung (#594): das passende Zusatzfeld ein-/ausblenden.
      const endTypeSelect = panel.querySelector('#subscription-end-type');
      endTypeSelect.value = subscription?.end_type || 'never';
      const syncEndFields = () => {
        panel.querySelector('#subscription-end-date-field').hidden = endTypeSelect.value !== 'on_date';
        panel.querySelector('#subscription-end-count-field').hidden = endTypeSelect.value !== 'after_count';
      };
      endTypeSelect.addEventListener('change', syncEndFields);
      syncEndFields();
      panel.querySelector('#subscription-cancel').addEventListener('click', closeModal);
      panel.querySelector('#subscription-logo').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
          searchedLogoData = await fileToDataUrl(file);
          showLogo(searchedLogoData);
        } catch (err) {
          event.target.value = '';
          window.yuvomi?.showToast(err.message, 'danger');
        }
      });
      panel.querySelector('#subscription-name').addEventListener('input', () => {
        if (!logoPreview.querySelector('img')) showLogo(null);
      });
      panel.querySelector('#subscription-find-logo').addEventListener('click', async () => {
        openLogoPickerModal(panel, subscription?.website_url || panel.querySelector('#subscription-name').value.trim(), (logoData) => {
          searchedLogoData = logoData;
          showLogo(searchedLogoData);
          window.yuvomi?.showToast(t('subscriptions.logoFound'), 'success');
        });
      });
      panel.querySelector('#subscription-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await saveSubscription(panel, subscription, searchedLogoData);
      });
    },
  });
}

/* Muss dem accept-Attribut des Logo-Felds entsprechen (test/test-image-picker.js
 * hält beide deckungsgleich). Bewusst NICHT pickCroppedImage() (#901): ein Logo
 * lebt von Transparenz und darf SVG sein - der Zuschnitt gibt immer ein
 * 256-px-JPEG zurück und zerstörte beides. */
const LOGO_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

async function fileToDataUrl(file) {
  if (!file) return null;
  if (!LOGO_ACCEPTED_TYPES.includes(file.type)) throw new Error(t('subscriptions.logoTypeError'));
  if (file.size > 500000) throw new Error(t('subscriptions.logoTooLarge'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    // Roh weitergereicht war das der ProgressEvent - `err.message` im Toast
    // des Aufrufers zeigte dann `undefined`.
    reader.onerror = () => reject(new Error(t('documents.fileReadError')));
    reader.readAsDataURL(file);
  });
}

async function saveSubscription(panel, existing, searchedLogoData = null) {
  const dateInput = panel.querySelector('#subscription-next-date');
  const currencyInput = panel.querySelector('#subscription-currency');
  if (!isDateInputValid(dateInput.value)) {
    // Fehler am Feld statt als ortloser Toast (geteiltes Muster, Critique P1).
    reportFieldError(dateInput, t('subscriptions.invalidDate'));
    return;
  }
  if (!currencyInput.value) {
    // Die Meldung klebt am sichtbaren Suchfeld der Combobox, nicht am
    // versteckten Wert-Input.
    reportFieldError(panel.querySelector('#subscription-currency-search'), t('subscriptions.currencyRequired'));
    return;
  }
  // Ende-Bedingung (#594): nur das aktive Zusatzfeld liefert einen Wert.
  const endType = panel.querySelector('#subscription-end-type').value;
  let endDate = null;
  let occurrenceCount = null;
  if (endType === 'on_date') {
    const endDateInput = panel.querySelector('#subscription-end-date');
    if (!isDateInputValid(endDateInput.value)) {
      reportFieldError(endDateInput, t('subscriptions.invalidDate'));
      return;
    }
    endDate = parseDateInput(endDateInput.value);
  } else if (endType === 'after_count') {
    const countInput = panel.querySelector('#subscription-end-count');
    const count = Number(countInput.value);
    if (!Number.isInteger(count) || count < 1) {
      reportFieldError(countInput, t('subscriptions.endCountInvalid'));
      return;
    }
    occurrenceCount = count;
  }
  // Bei einem Bestandsbetrag neben dem Raster liefert amountStep "any", damit
  // sich das vorhandene Abo überhaupt noch speichern lässt. Das gilt aber fürs
  // ganze Feld: ohne diese Prüfung wäre aus 12,5 JPY anschliessend auch
  // 12,555 JPY speicherbar, also mehr Bruch als die feste Schrittweite zuliess.
  const amountInput = panel.querySelector('#subscription-amount');
  const amountValue = Number(amountInput.value);
  const targetCurrency = currencyInput.value.trim().toUpperCase();
  if (!amountIsSavable(amountValue, targetCurrency, {
    original: existing?.amount ?? null,
    originalCurrency: existing?.currency ?? null,
  })) {
    reportFieldError(amountInput, t('common.amountPrecisionRequired', {
      currency: targetCurrency,
      step: smallestUnitLabel(targetCurrency),
    }));
    return;
  }

  const submit = panel.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const file = panel.querySelector('#subscription-logo').files[0];
    const logoData = searchedLogoData || (file ? await fileToDataUrl(file) : existing?.logo_data || null);
    const payload = {
      name: panel.querySelector('#subscription-name').value.trim(),
      description: panel.querySelector('#subscription-description').value.trim() || null,
      amount: Number(panel.querySelector('#subscription-amount').value),
      currency: panel.querySelector('#subscription-currency').value.trim().toUpperCase(),
      billing_cycle: panel.querySelector('#subscription-cycle').value,
      cycle_interval: Number(panel.querySelector('#subscription-interval').value),
      next_payment_date: parseDateInput(dateInput.value),
      reminder_days: Number(panel.querySelector('#subscription-reminder').value),
      category_id: Number(panel.querySelector('#subscription-category').value) || null,
      payment_method_id: Number(panel.querySelector('#subscription-method').value) || null,
      website_url: existing?.website_url || null,
      brand_color: panel.querySelector('#subscription-color').value,
      logo_data: logoData,
      notes: panel.querySelector('#subscription-notes').value.trim() || null,
      // Konto/Benutzername des Dienstes (#1004) - unverschluesselt und
      // absichtlich KEIN Passwortfeld; die Grenze steht in docs/SCOPE.md.
      account_username: panel.querySelector('#subscription-account').value.trim() || null,
      enabled: panel.querySelector('#subscription-enabled').checked,
      end_type: endType,
      end_date: endDate,
      occurrence_count: occurrenceCount,
    };
    if (existing) await api.put(`/budget/subscriptions/${existing.id}`, payload);
    else await api.post('/budget/subscriptions', payload);
    await closeModal({ force: true });
    await reload();
    refocusAfterRender();
    window.yuvomi?.showToast(t(existing ? 'subscriptions.savedToast' : 'subscriptions.addedToast'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error || err.message || t('common.unknownError'), 'danger');
  } finally {
    submit.disabled = false;
  }
}

function logoOptionsMarkup(options) {
  return options.length ? options.map((option, index) => `
    <button class="subscriptions-logo-option" type="button" data-logo-index="${index}" aria-label="${esc(t('subscriptions.useLogo'))}">
      <img src="${esc(option.logo_data)}" alt="">
      <span>${esc(t('subscriptions.logoSourceWebsite'))}</span>
    </button>
  `).join('') : `<p class="subscriptions-logo-empty">${t('subscriptions.logoSearchEmpty')}</p>`;
}

function openLogoPickerModal(panel, initialQuery, onSelect) {
  panel.querySelector('.subscriptions-logo-picker-modal')?.remove();
  panel.insertAdjacentHTML('beforeend', `
    <div class="subscriptions-logo-picker-modal" role="dialog" aria-modal="true" aria-labelledby="subscription-logo-picker-title">
      <div class="subscriptions-logo-picker-panel">
        <div class="subscriptions-logo-picker-head">
          <h3 id="subscription-logo-picker-title">${t('subscriptions.logoSearchTitle')}</h3>
          <button class="btn btn--secondary btn--icon" type="button" id="subscription-logo-picker-close" aria-label="${esc(t('common.close'))}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </div>
        <form id="subscription-logo-search-form" class="subscriptions-logo-search-form">
          <label class="form-label" for="subscription-logo-search-input">${t('subscriptions.logoSearchLabel')}</label>
          <div class="subscriptions-logo-search">
            <input class="form-input" id="subscription-logo-search-input" inputmode="url"
                   placeholder="${esc(t('subscriptions.logoSearchPlaceholder'))}" value="${esc(initialQuery || '')}">
            <button class="btn btn--primary" type="submit">
              <i data-lucide="search" aria-hidden="true"></i>${t('subscriptions.searchLogo')}
            </button>
          </div>
        </form>
        <div class="subscriptions-logo-results" id="subscription-logo-results">
          <p class="subscriptions-logo-empty">${t('subscriptions.findLogoHint')}</p>
        </div>
      </div>
    </div>
  `);
  const overlay = panel.querySelector('.subscriptions-logo-picker-modal');
  const results = overlay.querySelector('#subscription-logo-results');
  const input = overlay.querySelector('#subscription-logo-search-input');
  let options = [];
  const close = () => overlay.remove();
  // Der Picker liegt ueber dem Abo-Formular; die Zurueck-Geste meint ihn (#871).
  attachOverlay(overlay, close);
  const search = async () => {
    const query = input.value.trim();
    if (!query) return;
    const button = overlay.querySelector('[type="submit"]');
    button.disabled = true;
    setHtml(results, `<p class="subscriptions-logo-empty">${t('subscriptions.logoSearching')}</p>`);
    try {
      const response = await api.post('/budget/subscriptions/logo-search', { query });
      options = response.data?.options || [];
      setHtml(results, logoOptionsMarkup(options));
    } catch (err) {
      const message = err.data?.error || t('subscriptions.logoSearchError');
      options = [];
      setHtml(results, `<p class="subscriptions-logo-empty">${esc(message)}</p>`);
      window.yuvomi?.showToast(message, 'danger');
    } finally {
      button.disabled = false;
      if (window.lucide) window.lucide.createIcons({ el: overlay });
    }
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
    const option = event.target.closest('[data-logo-index]');
    if (!option) return;
    const selected = options[Number(option.dataset.logoIndex)];
    if (!selected) return;
    onSelect(selected.logo_data);
    close();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  overlay.querySelector('#subscription-logo-picker-close').addEventListener('click', close);
  overlay.querySelector('#subscription-logo-search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await search();
  });
  if (window.lucide) window.lucide.createIcons({ el: overlay });
  setTimeout(() => input.focus(), 50);
}

// Eine Zahlung zu buchen schiebt das Faelligkeitsdatum und legt einen
// Budget-Eintrag an. Beides ist mit einem zweiten Wisch NICHT umkehrbar - anders
// als das Abhaken einer Aufgabe, das dieselbe Kante traegt. Deshalb fragt die
// Aktion nach, und deshalb fragt sie an BEIDEN Wegen nach, Geste wie Knopf: eine
// Bestaetigung, die nur an einem der beiden haengt, ist keine Regel, sondern
// eine Eigenschaft des Wegs.
async function renewSubscription(subscription) {
  const confirmed = await confirmModal(
    t('subscriptions.renewConfirm', { name: subscription.name }),
    { detail: t('subscriptions.renewConfirmDetail', { date: formatDate(subscription.next_payment_date) }) });
  if (!confirmed) return;
  try {
    const response = await api.post(`/budget/subscriptions/${subscription.id}/renew`, {});
    await reload();
    refocusAfterRender();
    const completed = response.data?.status === 'completed';
    window.yuvomi?.showToast(t(completed ? 'subscriptions.completedToast' : 'subscriptions.renewedToast'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error || t('common.unknownError'), 'danger');
  }
}

async function deleteSubscription(subscription) {
  const confirmed = await confirmModal(t('subscriptions.deleteConfirm', { name: subscription.name }),
    { danger: true, detail: t('subscriptions.deleteConfirmDetail') });
  if (!confirmed) return;
  try {
    await api.delete(`/budget/subscriptions/${subscription.id}`);
    await reload();
    refocusAfterRender();
    window.yuvomi?.showToast(t('subscriptions.deletedToast'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error || t('common.unknownError'), 'danger');
  }
}

async function openSettingsModal() {
  const content = `
    <form id="subscriptions-settings-form">
      <div class="form-group">
        <label class="form-label" for="subscriptions-budget">${t('subscriptions.monthlyBudgetLabel')}</label>
        <input class="form-input" id="subscriptions-budget" type="number" min="0"
               step="${amountStep(state.settings.base_currency, state.settings.monthly_budget)}"
               placeholder="${amountPlaceholder(state.settings.base_currency)}"
               value="${state.settings.monthly_budget}">
      </div>
      ${comboboxMarkup({
        id: 'subscriptions-base-currency',
        label: t('subscriptions.baseCurrencyLabel'),
        items: currencyItems(),
        value: state.settings.base_currency,
        placeholder: t('subscriptions.currencySearchPlaceholder'),
      })}
      <div class="form-group">
        <small>${t('subscriptions.fixerHint')}</small>
      </div>
      <div class="modal-panel__footer subscriptions-modal-footer">
        <button class="btn btn--secondary" type="button" id="subscriptions-settings-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" type="submit">${t('common.save')}</button>
      </div>
    </form>
  `;
  openModal({
    title: t('subscriptions.settingsTitle'),
    content,
    size: 'sm',
    onSave(panel) {
      wireCombobox(panel, 'subscriptions-base-currency');
      panel.querySelector('#subscriptions-base-currency').addEventListener('change', (event) => {
        applyAmountFormat(panel.querySelector('#subscriptions-budget'), event.target.value);
      });
      panel.querySelector('#subscriptions-settings-cancel').addEventListener('click', closeModal);
      panel.querySelector('#subscriptions-settings-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const baseCurrency = panel.querySelector('#subscriptions-base-currency').value;
        if (!baseCurrency) {
          reportFieldError(panel.querySelector('#subscriptions-base-currency-search'), t('subscriptions.currencyRequired'));
          return;
        }
        // Auch hier gilt: bei einem Bestandsbudget neben dem Raster steht das
        // Feld auf step="any", die Prüfung muss also hier stattfinden.
        const budgetInput = panel.querySelector('#subscriptions-budget');
        if (!amountIsSavable(Number(budgetInput.value), baseCurrency, {
          original: state.settings.monthly_budget ?? null,
          originalCurrency: state.settings.base_currency ?? null,
        })) {
          reportFieldError(budgetInput, t('common.amountPrecisionRequired', {
            currency: baseCurrency,
            step: smallestUnitLabel(baseCurrency),
          }));
          return;
        }
        try {
          await api.put('/budget/subscriptions/settings', {
            monthly_budget: Number(panel.querySelector('#subscriptions-budget').value),
            base_currency: baseCurrency,
          });
          await closeModal({ force: true });
          await reload({ refreshRates: true });
          refocusAfterRender();
          window.yuvomi?.showToast(t('subscriptions.settingsSaved'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error || t('common.unknownError'), 'danger');
        }
      });
    },
  });
}

function metadataRows(items, kind) {
  const isCat = kind === 'categories';
  const editLabel = isCat ? t('subscriptions.editCategory') : t('subscriptions.editPaymentMethod');
  const deleteLabel = isCat ? t('subscriptions.deleteCategory') : t('subscriptions.deletePaymentMethod');
  return items.map((item, index) => `
    <li data-id="${item.id}" data-kind="${kind}">
      <div class="subscriptions-metadata-row__view">
        ${isCat ? `<i style="background:${esc(item.color)}"></i>` : '<i data-lucide="credit-card" aria-hidden="true"></i>'}
        <span>${esc(isCat ? categoryLabel(item) : paymentMethodLabel(item))}</span>
        <div class="subscriptions-metadata-row__actions">
          <button class="btn btn--icon" data-move="-1" ${index === 0 ? 'aria-disabled="true"' : ''} aria-label="${t('subscriptions.moveUp')}">
            <i data-lucide="chevron-up" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon" data-move="1" ${index === items.length - 1 ? 'aria-disabled="true"' : ''} aria-label="${t('subscriptions.moveDown')}">
            <i data-lucide="chevron-down" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon" data-act="edit" aria-label="${editLabel}">
            <i data-lucide="pencil" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon" data-act="delete" aria-label="${deleteLabel}">
            <i data-lucide="trash-2" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="subscriptions-metadata-row__edit" hidden>
        <input class="form-input subscriptions-metadata-edit-name" value="${esc(isCat ? categoryLabel(item) : paymentMethodLabel(item))}" data-original-name="${esc(item.name ?? '')}" maxlength="100" aria-label="${editLabel}">
        ${isCat ? `<input class="form-input form-input--color subscriptions-metadata-edit-color" type="color" value="${esc(item.color)}" aria-label="${t('subscriptions.brandColorLabel')}">` : ''}
        <div class="subscriptions-metadata-row__actions">
          <button class="btn btn--icon" data-act="save" aria-label="${t('common.save')}">
            <i data-lucide="check" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon" data-act="cancel" aria-label="${t('common.cancel')}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </li>
  `).join('');
}

function openMetadataModal() {
  const content = `
    <div class="subscriptions-metadata">
      <section>
        <h3>${t('subscriptions.categoriesTitle')}</h3>
        <ul id="subscription-category-list">${metadataRows(state.meta.categories, 'categories')}</ul>
        <div class="subscriptions-metadata-add">
          <input class="form-input" id="subscription-new-category" placeholder="${t('subscriptions.newCategoryPlaceholder')}">
          <input class="form-input form-input--color" id="subscription-new-category-color" type="color" value="#0F766E">
          <button class="btn btn--primary" id="subscription-add-category">${t('common.add')}</button>
        </div>
      </section>
      <section>
        <h3>${t('subscriptions.paymentMethodsTitle')}</h3>
        <ul id="subscription-method-list">${metadataRows(state.meta.payment_methods, 'methods')}</ul>
        <div class="subscriptions-metadata-add">
          <input class="form-input" id="subscription-new-method" placeholder="${t('subscriptions.newPaymentMethodPlaceholder')}">
          <button class="btn btn--primary" id="subscription-add-method">${t('common.add')}</button>
        </div>
      </section>
      <div class="modal-panel__footer subscriptions-modal-footer">
        <button class="btn btn--primary" id="subscriptions-metadata-close">${t('common.close')}</button>
      </div>
    </div>
  `;
  openModal({
    title: t('subscriptions.manageMetadata'),
    content,
    size: 'xl',
    onSave(panel) {
      panel.querySelector('#subscriptions-metadata-close').addEventListener('click', closeModal);
      panel.querySelector('#subscription-add-category').addEventListener('click', async () => {
        const name = panel.querySelector('#subscription-new-category').value.trim();
        if (!name) return;
        await api.post('/budget/subscriptions/categories', {
          name,
          color: panel.querySelector('#subscription-new-category-color').value,
        });
        await closeModal({ force: true });
        await reload();
        refocusAfterRender();
        openMetadataModal();
      });
      panel.querySelector('#subscription-add-method').addEventListener('click', async () => {
        const name = panel.querySelector('#subscription-new-method').value.trim();
        if (!name) return;
        await api.post('/budget/subscriptions/payment-methods', { name });
        await closeModal({ force: true });
        await reload();
        refocusAfterRender();
        openMetadataModal();
      });
      panel.querySelectorAll('[data-move]').forEach((button) => {
        button.addEventListener('click', async () => {
          // aria-disabled statt disabled: der Button bleibt fokussierbar, der
          // No-op-Klick am Listenrand wird hier verworfen (siehe layout.css).
          if (button.getAttribute('aria-disabled') === 'true') return;
          const list = button.closest('ul');
          const rows = [...list.querySelectorAll('li')];
          const index = rows.indexOf(button.closest('li'));
          const target = index + Number(button.dataset.move);
          [rows[index], rows[target]] = [rows[target], rows[index]];
          const key = list.id.includes('category') ? 'categories' : 'payment_methods';
          await api.put('/budget/subscriptions/meta/order', { [key]: rows.map((row) => Number(row.dataset.id)) });
          await closeModal({ force: true });
          await reload();
          refocusAfterRender();
          openMetadataModal();
        });
      });

      // Inline-Bearbeitung: die vorgerenderte Edit-Zeile ein-/ausblenden.
      panel.querySelectorAll('[data-act="edit"]').forEach((button) => {
        button.addEventListener('click', () => {
          const li = button.closest('li');
          li.querySelector('.subscriptions-metadata-row__view').hidden = true;
          const editRow = li.querySelector('.subscriptions-metadata-row__edit');
          editRow.hidden = false;
          editRow.querySelector('.subscriptions-metadata-edit-name').focus();
        });
      });
      panel.querySelectorAll('[data-act="cancel"]').forEach((button) => {
        button.addEventListener('click', () => {
          const li = button.closest('li');
          const editRow = li.querySelector('.subscriptions-metadata-row__edit');
          const nameInput = editRow.querySelector('.subscriptions-metadata-edit-name');
          nameInput.value = nameInput.defaultValue;
          const colorInput = editRow.querySelector('.subscriptions-metadata-edit-color');
          if (colorInput) colorInput.value = colorInput.defaultValue;
          editRow.hidden = true;
          li.querySelector('.subscriptions-metadata-row__view').hidden = false;
          // Fokus zurück auf den Auslöser, statt ins Leere (der Cancel-Button
          // wird gerade versteckt) - sonst verliert die Tastatur die Position.
          li.querySelector('[data-act="edit"]').focus();
        });
      });
      // Tastatur im Inline-Edit: Enter speichert, Escape bricht ab. stopPropagation
      // hält den globalen Modal-Handler (modal.js) davon ab, den ersten .btn--primary
      // im Panel zu klicken bzw. das ganze Modal via Escape zu schließen.
      panel.querySelectorAll('.subscriptions-metadata-row__edit input').forEach((input) => {
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          const act = event.key === 'Enter' ? 'save' : 'cancel';
          input.closest('li').querySelector(`[data-act="${act}"]`).click();
        });
      });
      panel.querySelectorAll('[data-act="save"]').forEach((button) => {
        button.addEventListener('click', async () => {
          const li = button.closest('li');
          const id = Number(li.dataset.id);
          const editRow = li.querySelector('.subscriptions-metadata-row__edit');
          const nameInput = editRow.querySelector('.subscriptions-metadata-edit-name');
          const typed = nameInput.value.trim();
          if (!typed) { nameInput.focus(); return; }
          // Das Feld zeigt bei Default-Kategorien den lokalisierten Namen ("Bildung").
          // Bleibt er unverändert (z. B. nur Farbe geändert), den gespeicherten Kanon-
          // Namen ("Education") behalten, damit die Lokalisierung nicht verloren geht.
          const name = nameInput.value === nameInput.defaultValue
            ? (nameInput.dataset.originalName ?? typed)
            : typed;
          const colorInput = editRow.querySelector('.subscriptions-metadata-edit-color');
          try {
            if (li.dataset.kind === 'categories') {
              await api.put(`/budget/subscriptions/categories/${id}`, { name, color: colorInput.value });
            } else {
              await api.put(`/budget/subscriptions/payment-methods/${id}`, { name });
            }
            await closeModal({ force: true });
            await reload();
            refocusAfterRender();
            openMetadataModal();
            window.yuvomi?.showToast(t('subscriptions.metaSavedToast'), 'success');
          } catch (err) {
            window.yuvomi?.showToast(err.data?.error || err.message || t('common.unknownError'), 'danger');
          }
        });
      });
      panel.querySelectorAll('[data-act="delete"]').forEach((button) => {
        button.addEventListener('click', async () => {
          const li = button.closest('li');
          const id = Number(li.dataset.id);
          const isCat = li.dataset.kind === 'categories';
          const item = state.meta[isCat ? 'categories' : 'payment_methods'].find((row) => row.id === id);
          const inUse = item?.usage_count || 0;
          const name = item ? (isCat ? categoryLabel(item) : paymentMethodLabel(item)) : '';
          // confirmOverModal parkt das Verwalten-Modal, statt es zu ersetzen:
          // „Abbrechen" gibt es mitsamt Scrollposition und Fokus zurück. Nur
          // nach echtem Löschen wird es neu aufgebaut - die Liste hat sich
          // geändert.
          // Der Folgentext haengt nicht daran, ob gerade ein Abo zugeordnet ist:
          // bei einer Kategorie faellt die verknuepfte Budget-Unterkategorie in
          // jedem Fall mit (routes/subscriptions.js). Frueher stand `detail` bei
          // usage_count 0 auf null - dann nannte der Dialog gar keine Folge.
          const warnung = inUse ? `${t('subscriptions.metaInUseWarning', { count: inUse })} ` : '';
          const confirmed = await confirmOverModal(
            t(isCat ? 'subscriptions.deleteCategoryConfirm' : 'subscriptions.deletePaymentMethodConfirm', { name }),
            {
              danger: true,
              detail: isCat
                ? `${warnung}${t('subscriptions.deleteCategoryConfirmDetail')}`
                : `${warnung}${t('subscriptions.deletePaymentMethodConfirmDetail')}`,
            },
          );
          if (!confirmed) return;
          try {
            await api.delete(`/budget/subscriptions/${isCat ? 'categories' : 'payment-methods'}/${id}`);
            await reload();
            refocusAfterRender();
            window.yuvomi?.showToast(t('subscriptions.metaDeletedToast'), 'success');
          } catch (err) {
            window.yuvomi?.showToast(err.data?.error || err.message || t('common.unknownError'), 'danger');
          }
          openMetadataModal();
        });
      });
    },
  });
}
