/**
 * Module: Budget subscriptions
 * Purpose: Recurring subscription tracking, budgeting, analytics, and renewal reminders.
 */

import { api } from '/api.js';
import { closeModal, confirmModal, openModal } from '/components/modal.js';
import {
  dateInputPlaceholder,
  formatDate,
  formatDateInput,
  getLocale,
  isDateInputValid,
  parseDateInput,
  t,
} from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { toLocalDateKey } from '/utils/date.js';

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
const CURRENCIES = [
  'AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HUF', 'INR',
  'JPY', 'KZT', 'NOK', 'PLN', 'RUB', 'SAR', 'SEK', 'TRY', 'UAH', 'USD',
];
const DEFAULT_CATEGORY_LABELS = {
  Entertainment: 'budget.subcatSubscriptionEntertainment',
  Productivity: 'budget.subcatSubscriptionProductivity',
  Utilities: 'budget.subcatSubscriptionUtilities',
  Health: 'budget.subcatSubscriptionHealth',
  Education: 'budget.subcatSubscriptionEducation',
  Other: 'budget.subcatSubscriptionOther',
};

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
}

function money(amount, currency = state.summary?.base_currency || state.settings.base_currency) {
  const value = Number(amount || 0);
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency }).format(value);
}

function categoryLabel(category) {
  const name = typeof category === 'object' ? category?.name : category;
  return DEFAULT_CATEGORY_LABELS[name] ? t(DEFAULT_CATEGORY_LABELS[name]) : (name || t('subscriptions.uncategorized'));
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
  const today = new Date(`${toLocalDateKey(new Date())}T00:00:00`);
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
  if (state.status !== 'all') params.set('enabled', state.status === 'active' ? 'true' : 'false');
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
  setHtml(container, `
    <div class="subscriptions-page" aria-busy="true">
      <div class="subscriptions-toolbar">
        <label class="subscriptions-search">
          <i data-lucide="search" aria-hidden="true"></i>
          <span class="sr-only">${t('subscriptions.searchLabel')}</span>
          <input id="subscriptions-search" type="search" placeholder="${t('subscriptions.searchPlaceholder')}" autocomplete="off">
        </label>
        <select class="form-input subscriptions-filter" id="subscriptions-category-filter" aria-label="${t('subscriptions.categoryFilter')}"></select>
        <select class="form-input subscriptions-filter" id="subscriptions-method-filter" aria-label="${t('subscriptions.paymentMethodFilter')}"></select>
        <select class="form-input subscriptions-filter" id="subscriptions-status-filter" aria-label="${t('subscriptions.statusFilter')}">
          <option value="all">${t('subscriptions.statusAll')}</option>
          <option value="active">${t('subscriptions.statusActive')}</option>
          <option value="disabled">${t('subscriptions.statusDisabled')}</option>
        </select>
        <select class="form-input subscriptions-filter" id="subscriptions-sort" aria-label="${t('subscriptions.sortLabel')}">
          <option value="due">${t('subscriptions.sortDue')}</option>
          <option value="cost-desc">${t('subscriptions.sortCostDesc')}</option>
          <option value="cost-asc">${t('subscriptions.sortCostAsc')}</option>
          <option value="name">${t('subscriptions.sortName')}</option>
        </select>
        <button class="btn btn--secondary btn--icon" id="subscriptions-manage" aria-label="${t('subscriptions.manageMetadata')}">
          <i data-lucide="tags" aria-hidden="true"></i>
        </button>
        <button class="btn btn--secondary btn--icon" id="subscriptions-settings" aria-label="${t('subscriptions.settingsTitle')}">
          <i data-lucide="settings-2" aria-hidden="true"></i>
        </button>
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
    setHtml(container.querySelector('#subscriptions-content'), `
      <div class="empty-state">
        <i data-lucide="circle-alert" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${t('subscriptions.loadError')}</div>
      </div>
    `);
  } finally {
    container.querySelector('.subscriptions-page')?.setAttribute('aria-busy', 'false');
    if (window.lucide) window.lucide.createIcons({ el: container });
  }
}

function renderFilters() {
  const category = container.querySelector('#subscriptions-category-filter');
  const method = container.querySelector('#subscriptions-method-filter');
  setHtml(category, `
    <option value="">${t('subscriptions.allCategories')}</option>
    ${state.meta.categories.map((item) => `<option value="${item.id}">${esc(categoryLabel(item))}</option>`).join('')}
  `);
  setHtml(method, `
    <option value="">${t('subscriptions.allPaymentMethods')}</option>
    ${state.meta.payment_methods.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join('')}
  `);
  category.value = state.categoryId;
  method.value = state.paymentMethodId;
  container.querySelector('#subscriptions-status-filter').value = state.status;
  container.querySelector('#subscriptions-sort').value = state.sort;
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
    renderContent();
  });
  container.querySelector('#subscriptions-manage').addEventListener('click', openMetadataModal);
  container.querySelector('#subscriptions-settings').addEventListener('click', openSettingsModal);
}

async function reload(options) {
  try {
    await load(options);
    renderFilters();
    renderContent();
  } catch (err) {
    window.oikos?.showToast(err.data?.error || t('subscriptions.loadError'), 'danger');
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
  setHtml(content, `
    ${renderSummary()}
    ${renderAnalytics()}
    <section class="subscriptions-list-section">
      <div class="subscriptions-section-head">
        <div>
          <h2>${t('subscriptions.listTitle')}</h2>
          <span>${t('subscriptions.listCount', { count: rows.length })}</span>
        </div>
        ${state.rates?.source === 'unavailable'
          ? `<span class="subscriptions-rate-status subscriptions-rate-status--warning">${t('subscriptions.ratesUnavailable')}</span>`
          : `<button class="btn btn--secondary" id="subscriptions-refresh-rates">
              <i data-lucide="refresh-cw" aria-hidden="true"></i>${t('subscriptions.refreshRates')}
            </button>`}
      </div>
      <div class="subscriptions-list" id="subscriptions-list">
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
  const percentage = hasBudget ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const isOverBudget = hasBudget && summary.remaining_budget < 0;
  return `
    <section class="subscriptions-summary">
      <article class="subscriptions-summary-card">
        <span>${t('subscriptions.monthlyCost')}</span>
        <strong>${money(used)}</strong>
        <small>${t('subscriptions.activeCount', { count: summary.active_count })}</small>
      </article>
      <article class="subscriptions-summary-card">
        <span>${t('subscriptions.monthlyBudget')}</span>
        <strong>${money(budget)}</strong>
        <div class="subscriptions-budget-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}">
          <span style="width:${percentage}%"></span>
        </div>
      </article>
      <article class="subscriptions-summary-card ${isOverBudget ? 'subscriptions-summary-card--danger' : ''}">
        <span>${hasBudget ? (isOverBudget ? t('subscriptions.overBudget') : t('subscriptions.remainingBudget')) : t('subscriptions.noBudgetLimit')}</span>
        <strong>${hasBudget ? money(Math.abs(summary.remaining_budget)) : t('subscriptions.unlimited')}</strong>
        <small>${hasBudget ? `${percentage}% ${t('subscriptions.budgetUsed')}` : t('subscriptions.setBudgetHint')}</small>
      </article>
      <article class="subscriptions-summary-card">
        <span>${t('subscriptions.yearlyProjection')}</span>
        <strong>${money(used * 12)}</strong>
        <small>${summary.base_currency}</small>
      </article>
    </section>
  `;
}

function renderAnalytics() {
  const categories = state.summary?.by_category || [];
  const methods = state.summary?.by_payment_method || [];
  return `
    <section class="subscriptions-analytics">
      ${renderBreakdown(t('subscriptions.byCategory'), categories, categoryLabel)}
      ${renderBreakdown(t('subscriptions.byPaymentMethod'), methods)}
    </section>
  `;
}

function renderBreakdown(title, rows, labelFor = (name) => name) {
  const max = Math.max(...rows.map((row) => row.amount), 1);
  return `
    <article class="subscriptions-chart">
      <h2>${title}</h2>
      ${rows.length ? rows.map((row) => `
        <div class="subscriptions-chart-row">
          <span title="${esc(labelFor(row.name))}">${esc(labelFor(row.name))}</span>
          <div><i style="width:${Math.round((row.amount / max) * 100)}%"></i></div>
          <strong>${money(row.amount)}</strong>
        </div>
      `).join('') : `<p>${t('subscriptions.noAnalytics')}</p>`}
    </article>
  `;
}

function renderCard(subscription) {
  const brandColor = subscription.brand_color || subscription.category_color || '#0F766E';
  const converted = subscription.monthly_base === null
    ? t('subscriptions.conversionUnavailable')
    : t('subscriptions.monthlyEquivalent', { amount: money(subscription.monthly_base) });
  return `
    <article class="subscription-card ${subscription.enabled ? '' : 'subscription-card--disabled'}"
             data-id="${subscription.id}" style="--subscription-color:${esc(brandColor)}">
      <div class="subscription-card__brand">
        ${subscription.logo_data
          ? `<img src="${esc(subscription.logo_data)}" alt="">`
          : `<span>${esc(subscription.name.slice(0, 2).toUpperCase())}</span>`}
      </div>
      <div class="subscription-card__body">
        <div class="subscription-card__title-row">
          <div>
            <h3>${esc(subscription.name)}</h3>
            <p>${esc(subscription.description || categoryLabel(subscription.category_name))}</p>
          </div>
          <span class="subscription-status ${subscription.enabled ? 'subscription-status--active' : ''}">
            ${subscription.enabled ? t('subscriptions.active') : t('subscriptions.disabled')}
          </span>
        </div>
        <div class="subscription-card__meta">
          <span><i data-lucide="calendar-clock" aria-hidden="true"></i>${formatDate(subscription.next_payment_date)} · ${dueLabel(subscription)}</span>
          <span><i data-lucide="repeat-2" aria-hidden="true"></i>${cycleLabel(subscription)}</span>
          <span><i data-lucide="wallet-cards" aria-hidden="true"></i>${esc(subscription.payment_method_name || t('subscriptions.unspecified'))}</span>
          <span><i data-lucide="bell" aria-hidden="true"></i>${t('subscriptions.reminderMeta', { count: subscription.reminder_days })}</span>
        </div>
      </div>
      <div class="subscription-card__cost">
        <strong>${money(subscription.amount, subscription.currency)}</strong>
        <span>${converted}</span>
      </div>
      <div class="subscription-card__actions">
        <button class="btn btn--secondary btn--icon" data-action="toggle" aria-label="${subscription.enabled ? t('subscriptions.disable') : t('subscriptions.enable')}">
          <i data-lucide="${subscription.enabled ? 'pause' : 'play'}" aria-hidden="true"></i>
        </button>
        <button class="btn btn--secondary btn--icon" data-action="renew" aria-label="${t('subscriptions.markRenewed')}">
          <i data-lucide="calendar-check" aria-hidden="true"></i>
        </button>
        <button class="btn btn--secondary btn--icon" data-action="edit" aria-label="${t('subscriptions.edit')}">
          <i data-lucide="pencil" aria-hidden="true"></i>
        </button>
        <button class="btn btn--secondary btn--icon" data-action="delete" aria-label="${t('subscriptions.delete')}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>
      </div>
    </article>
  `;
}

function renderEmpty() {
  return `
    <div class="empty-state">
      <i data-lucide="repeat-2" class="empty-state__icon" aria-hidden="true"></i>
      <div class="empty-state__title">${t('subscriptions.emptyTitle')}</div>
      <div class="empty-state__description">${t('subscriptions.emptyDescription')}</div>
      <button class="btn btn--primary empty-state__cta" id="subscriptions-empty-add">${t('subscriptions.add')}</button>
    </div>
  `;
}

function bindContent() {
  container.querySelector('#subscriptions-refresh-rates')?.addEventListener('click', () => reload({ refreshRates: true }));
  container.querySelector('#subscriptions-empty-add')?.addEventListener('click', () => openSubscriptionModal());
  container.querySelector('#subscriptions-list')?.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const card = action.closest('[data-id]');
    const subscription = state.subscriptions.find((row) => row.id === Number(card?.dataset.id));
    if (!subscription) return;
    if (action.dataset.action === 'edit') openSubscriptionModal(subscription);
    if (action.dataset.action === 'toggle') await toggleSubscription(subscription);
    if (action.dataset.action === 'renew') await renewSubscription(subscription);
    if (action.dataset.action === 'delete') await deleteSubscription(subscription);
  });
}

function currencyItems() {
  let names;
  try {
    names = new Intl.DisplayNames([getLocale()], { type: 'currency' });
  } catch {
    names = null;
  }
  return CURRENCIES.map((code) => ({
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
    suppressFocusOpen = true;
    search.focus();
    queueMicrotask(() => { suppressFocusOpen = false; });
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
      select(visible[0]);
    }
    if (event.key === 'Escape') close();
  });
  options.forEach((option) => {
    option.addEventListener('click', () => select(option));
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
  const categoryItems = [
    { value: '', label: t('subscriptions.uncategorized') },
    ...state.meta.categories.map((item) => ({ value: item.id, label: categoryLabel(item) })),
  ];
  const methodItems = [
    { value: '', label: t('subscriptions.unspecified') },
    ...state.meta.payment_methods.map((item) => ({ value: item.id, label: item.name })),
  ];
  const initialLogo = subscription?.logo_data || '';
  const initialName = subscription?.name || '';
  const content = `
    <form id="subscription-form" class="subscription-form">
      <section class="subscription-form__section subscription-form__identity">
        <label class="subscription-logo-picker" for="subscription-logo" title="${t('subscriptions.logoLabel')}">
          <span id="subscription-logo-preview">
            ${initialLogo
              ? `<img src="${esc(initialLogo)}" alt="">`
              : `<strong>${esc(initialName.slice(0, 2).toUpperCase() || '+')}</strong>`}
          </span>
          <small><i data-lucide="upload" aria-hidden="true"></i>${t('subscriptions.logoLabel')}</small>
          <input id="subscription-logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml">
        </label>
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
            <input class="form-input" id="subscription-amount" type="number" min="0" step="0.01" inputmode="decimal" required value="${subscription?.amount ?? ''}">
          </div>
          ${comboboxMarkup({
            id: 'subscription-currency',
            label: t('subscriptions.currencyLabel'),
            items: currencyItems(),
            value: subscription?.currency || state.settings.base_currency,
            placeholder: t('subscriptions.currencySearchPlaceholder'),
          })}
          <div class="form-group">
            <label class="form-label" for="subscription-cycle">${t('subscriptions.billingCycleLabel')}</label>
            <select class="form-input" id="subscription-cycle">
              ${state.meta.billing_cycles.map((cycle) => `<option value="${cycle}" ${subscription?.billing_cycle === cycle ? 'selected' : ''}>${t(`subscriptions.cycle.${cycle}`)}</option>`).join('')}
            </select>
          </div>
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
            <input class="form-input" id="subscription-next-date" inputmode="numeric"
                   placeholder="${dateInputPlaceholder()}" value="${esc(formatDateInput(subscription?.next_payment_date || toLocalDateKey(new Date())))}" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="subscription-reminder">${t('subscriptions.reminderDaysLabel')}</label>
            <input class="form-input" id="subscription-reminder" type="number" min="0" max="365" step="1" value="${subscription?.reminder_days ?? 3}">
          </div>
        </div>
      </section>

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
          <label class="form-label" for="subscription-website">${t('subscriptions.websiteLabel')}</label>
          <div class="subscriptions-logo-search">
            <input class="form-input" id="subscription-website" inputmode="url" placeholder="example.com" value="${esc(subscription?.website_url || '')}">
            <button class="btn btn--secondary" type="button" id="subscription-find-logo">
              <i data-lucide="image-search" aria-hidden="true"></i>${t('subscriptions.findLogo')}
            </button>
          </div>
          <small>${t('subscriptions.findLogoHint')}</small>
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
      </section>
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
      wireCombobox(panel, 'subscription-category');
      wireCombobox(panel, 'subscription-method');
      panel.querySelector('#subscription-cancel').addEventListener('click', closeModal);
      panel.querySelector('#subscription-logo').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
          searchedLogoData = await fileToDataUrl(file);
          showLogo(searchedLogoData);
        } catch (err) {
          event.target.value = '';
          window.oikos?.showToast(err.message, 'danger');
        }
      });
      panel.querySelector('#subscription-name').addEventListener('input', () => {
        if (!logoPreview.querySelector('img')) showLogo(null);
      });
      panel.querySelector('#subscription-find-logo').addEventListener('click', async () => {
        let website = panel.querySelector('#subscription-website').value.trim();
        if (!website) return;
        if (!/^https:\/\//i.test(website)) website = `https://${website}`;
        panel.querySelector('#subscription-website').value = website;
        const button = panel.querySelector('#subscription-find-logo');
        button.disabled = true;
        try {
          const result = await api.post('/budget/subscriptions/logo-search', { website_url: website });
          searchedLogoData = result.data.logo_data;
          showLogo(searchedLogoData);
          window.oikos?.showToast(t('subscriptions.logoFound'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.data?.error || t('subscriptions.logoNotFound'), 'danger');
        } finally {
          button.disabled = false;
        }
      });
      panel.querySelector('#subscription-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await saveSubscription(panel, subscription, searchedLogoData);
      });
    },
  });
}

async function fileToDataUrl(file) {
  if (!file) return null;
  if (file.size > 500000) throw new Error(t('subscriptions.logoTooLarge'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function saveSubscription(panel, existing, searchedLogoData = null) {
  const dateInput = panel.querySelector('#subscription-next-date');
  const currencyInput = panel.querySelector('#subscription-currency');
  if (!isDateInputValid(dateInput.value)) {
    window.oikos?.showToast(t('subscriptions.invalidDate'), 'danger');
    dateInput.focus();
    return;
  }
  if (!currencyInput.value) {
    window.oikos?.showToast(t('subscriptions.currencyRequired'), 'danger');
    panel.querySelector('#subscription-currency-search').focus();
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
      website_url: panel.querySelector('#subscription-website').value.trim() || null,
      brand_color: panel.querySelector('#subscription-color').value,
      logo_data: logoData,
      notes: panel.querySelector('#subscription-notes').value.trim() || null,
      enabled: panel.querySelector('#subscription-enabled').checked,
    };
    if (existing) await api.put(`/budget/subscriptions/${existing.id}`, payload);
    else await api.post('/budget/subscriptions', payload);
    await closeModal({ force: true });
    await reload();
    window.oikos?.showToast(t(existing ? 'subscriptions.savedToast' : 'subscriptions.addedToast'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error || err.message || t('common.unknownError'), 'danger');
  } finally {
    submit.disabled = false;
  }
}

async function toggleSubscription(subscription) {
  try {
    await api.put(`/budget/subscriptions/${subscription.id}`, { enabled: !subscription.enabled });
    await reload();
    window.oikos?.showToast(t(subscription.enabled ? 'subscriptions.disabledToast' : 'subscriptions.enabledToast'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error || t('common.unknownError'), 'danger');
  }
}

async function renewSubscription(subscription) {
  try {
    await api.post(`/budget/subscriptions/${subscription.id}/renew`, {});
    await reload();
    window.oikos?.showToast(t('subscriptions.renewedToast'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error || t('common.unknownError'), 'danger');
  }
}

async function deleteSubscription(subscription) {
  const confirmed = await confirmModal(t('subscriptions.deleteConfirm', { name: subscription.name }), { danger: true });
  if (!confirmed) return;
  try {
    await api.delete(`/budget/subscriptions/${subscription.id}`);
    await reload();
    window.oikos?.showToast(t('subscriptions.deletedToast'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error || t('common.unknownError'), 'danger');
  }
}

async function openSettingsModal() {
  const content = `
    <form id="subscriptions-settings-form">
      <div class="form-group">
        <label class="form-label" for="subscriptions-budget">${t('subscriptions.monthlyBudgetLabel')}</label>
        <input class="form-input" id="subscriptions-budget" type="number" min="0" step="0.01" value="${state.settings.monthly_budget}">
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
      panel.querySelector('#subscriptions-settings-cancel').addEventListener('click', closeModal);
      panel.querySelector('#subscriptions-settings-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const baseCurrency = panel.querySelector('#subscriptions-base-currency').value;
        if (!baseCurrency) {
          window.oikos?.showToast(t('subscriptions.currencyRequired'), 'danger');
          panel.querySelector('#subscriptions-base-currency-search').focus();
          return;
        }
        try {
          await api.put('/budget/subscriptions/settings', {
            monthly_budget: Number(panel.querySelector('#subscriptions-budget').value),
            base_currency: baseCurrency,
          });
          await closeModal({ force: true });
          await reload({ refreshRates: true });
          window.oikos?.showToast(t('subscriptions.settingsSaved'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.data?.error || t('common.unknownError'), 'danger');
        }
      });
    },
  });
}

function metadataRows(items, kind) {
  return items.map((item, index) => `
    <li data-id="${item.id}">
      ${kind === 'categories' ? `<i style="background:${esc(item.color)}"></i>` : '<i data-lucide="credit-card" aria-hidden="true"></i>'}
      <span>${esc(kind === 'categories' ? categoryLabel(item) : item.name)}</span>
      <button class="btn btn--icon" data-move="-1" ${index === 0 ? 'disabled' : ''} aria-label="${t('subscriptions.moveUp')}">
        <i data-lucide="chevron-up" aria-hidden="true"></i>
      </button>
      <button class="btn btn--icon" data-move="1" ${index === items.length - 1 ? 'disabled' : ''} aria-label="${t('subscriptions.moveDown')}">
        <i data-lucide="chevron-down" aria-hidden="true"></i>
      </button>
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
    size: 'lg',
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
        openMetadataModal();
      });
      panel.querySelector('#subscription-add-method').addEventListener('click', async () => {
        const name = panel.querySelector('#subscription-new-method').value.trim();
        if (!name) return;
        await api.post('/budget/subscriptions/payment-methods', { name });
        await closeModal({ force: true });
        await reload();
        openMetadataModal();
      });
      panel.querySelectorAll('[data-move]').forEach((button) => {
        button.addEventListener('click', async () => {
          const list = button.closest('ul');
          const rows = [...list.querySelectorAll('li')];
          const index = rows.indexOf(button.closest('li'));
          const target = index + Number(button.dataset.move);
          [rows[index], rows[target]] = [rows[target], rows[index]];
          const key = list.id.includes('category') ? 'categories' : 'payment_methods';
          await api.put('/budget/subscriptions/meta/order', { [key]: rows.map((row) => Number(row.dataset.id)) });
          await closeModal({ force: true });
          await reload();
          openMetadataModal();
        });
      });
    },
  });
}
