/**
 * Modul: Budget-Statistik-View
 * Zweck: Statistik-Tab (Zeitraum-Filter, Summary-Cards, Trendlinie, Donut, CSV-Export).
 */
import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { toLocalDateKey, parseLocalDateKey, addLocalDays } from '/utils/date.js';

const view = { range: 'month', anchor: toLocalDateKey(new Date()), data: null, error: false, ctx: null, root: null };

const RANGE_LABELS = {
  week: 'budget.statsRangeWeek',
  month: 'budget.statsRangeMonth',
  year: 'budget.statsRangeYear',
};

export async function renderStats(panel, ctx) {
  view.ctx = ctx;
  view.root = panel;
  renderShell();
  await loadStats();
}

function fmtAmount(v) { return view.ctx.formatAmount(v); }

async function loadStats() {
  const body = view.root.querySelector('#budget-stats-body');
  try {
    const res = await api.get(`/budget/stats?range=${view.range}&anchor=${view.anchor}`);
    view.data = res.data;
    view.error = false;
  } catch (err) {
    console.error('[Budget] stats load error:', err);
    view.data = null;
    view.error = true;
  }
  renderBodyContent(body);
}

function renderShell() {
  view.root.replaceChildren();
  view.root.insertAdjacentHTML('beforeend', `
    <div class="budget-stats">
      <div class="budget-stats__controls">
        <div class="budget-stats__ranges" role="tablist">
          ${['week', 'month', 'year'].map((r) => `
            <button type="button" class="budget-stats__range${r === view.range ? ' is-active' : ''}"
              data-range="${r}">${t(RANGE_LABELS[r])}</button>`).join('')}
        </div>
        <div class="budget-stats__stepper">
          <button class="btn btn--icon" data-step="-1" aria-label="${t('budget.prevPeriod')}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
          <span class="budget-stats__period" id="budget-stats-period"></span>
          <button class="btn btn--icon" data-step="1" aria-label="${t('budget.nextPeriod')}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
        </div>
      </div>
      <div id="budget-stats-body"></div>
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: view.root });
  wire();
}

function wire() {
  view.root.querySelectorAll('.budget-stats__range').forEach((b) =>
    b.addEventListener('click', () => { view.range = b.dataset.range; renderShell(); loadStats(); }));
  view.root.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => { stepAnchor(Number(b.dataset.step)); renderShell(); loadStats(); }));
}

function stepAnchor(dir) {
  if (view.range === 'week') {
    view.anchor = addLocalDays(view.anchor, 7 * dir);
    return;
  }
  const d = parseLocalDateKey(view.anchor);
  if (view.range === 'month') d.setMonth(d.getMonth() + dir);
  else d.setFullYear(d.getFullYear() + dir);
  view.anchor = toLocalDateKey(d);
}

function renderBodyContent(body) {
  // Fehler beim Laden klar von „keine Daten" trennen: ein Netzwerk-/Serverfehler
  // darf der Familie nicht vortäuschen, ihre Finanzhistorie sei leer.
  if (view.error) {
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${t('budget.statsError')}</div>
        <div class="empty-state__description">${t('budget.statsErrorDescription')}</div>
        <button class="btn btn--primary empty-state__cta" id="budget-stats-retry">
          <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
          ${t('budget.statsRetry')}
        </button>
      </div>`);
    if (window.lucide) lucide.createIcons({ el: body });
    body.querySelector('#budget-stats-retry')?.addEventListener('click', () => loadStats());
    return;
  }
  const d = view.data;
  if (!d || (d.totals.income === 0 && d.totals.expenses === 0 && !d.series.some((s) => s.income || s.expenses))) {
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <div class="empty-state__title">${t('budget.statsEmptyTitle')}</div>
        <div class="empty-state__description">${t('budget.statsEmptyDescription')}</div>
      </div>`);
    return;
  }
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div class="budget-summary">
      <div class="budget-summary-card budget-summary-card--income">
        <div class="budget-summary-card__label">${t('budget.statsIncome')}</div>
        <div class="budget-summary-card__amount">${fmtAmount(d.totals.income)}</div>
      </div>
      <div class="budget-summary-card budget-summary-card--expenses">
        <div class="budget-summary-card__label">${t('budget.statsExpenses')}</div>
        <div class="budget-summary-card__amount">${fmtAmount(Math.abs(d.totals.expenses))}</div>
      </div>
      <div class="budget-summary-card ${d.totals.balance >= 0 ? 'budget-summary-card--balance-positive' : 'budget-summary-card--balance-negative'}">
        <div class="budget-summary-card__label">${t('budget.statsBalance')}</div>
        <div class="budget-summary-card__amount">${fmtAmount(d.totals.balance)}</div>
      </div>
    </div>
    <div id="budget-stats-trend"></div>
    <div id="budget-stats-cat"></div>
    <div id="budget-stats-donut"></div>
    <div class="budget-stats__export"></div>
  `);
  updatePeriodLabel();
  renderTrendChart();
  renderCatBars();
  renderDonut();
  renderExport();
}

const DONUT_COLORS = [
  'var(--color-accent)', 'var(--color-danger)', 'var(--color-warning)',
  'var(--color-success)', 'var(--color-info)', 'var(--module-shopping)',
  'var(--module-meals)', 'var(--color-text-secondary)',
];

function renderCatBars() {
  const host = view.root.querySelector('#budget-stats-cat');
  const cats = view.data.byCategory.filter((c) => c.total !== 0);
  if (!host || !cats.length) return;
  const maxAbs = Math.max(...cats.map((c) => Math.abs(c.total)), 1);
  // Budgetplan-Ziele nur im Monatsbereich einblenden — dort deckt sich der
  // Zeitraum exakt mit dem stetigen Monatsplan (kein irreführendes Hochskalieren).
  const plans = view.data.range === 'month' ? (view.data.plans || {}) : {};
  const rows = cats.map((c) => {
    const isExp = c.total < 0;
    const pct = Math.round((Math.abs(c.total) / maxAbs) * 100);
    const target = isExp ? plans[c.category] : undefined;
    const targetPos = target != null ? Math.min(1, target / maxAbs) : null;
    const targetMarker = targetPos != null
      ? `<div class="budget-bar-row__target" style="--target-pos:${targetPos.toFixed(4)}"
             title="${t('budget.planTarget', { amount: view.ctx.formatAmount(target) })}"></div>`
      : '';
    return `
      <div class="budget-bar-row">
        <div class="budget-bar-row__label">${view.ctx.esc(view.ctx.categoryLabel(c.category))}</div>
        <div class="budget-bar-row__track">
          <div class="budget-bar-row__fill ${isExp ? 'budget-bar-row__fill--expenses' : 'budget-bar-row__fill--income'}"
               style="--bar-scale:${pct / 100}"></div>
          ${targetMarker}
        </div>
        <div class="budget-bar-row__amount" style="color:${isExp ? 'var(--color-danger)' : 'var(--color-success)'};">
          ${isExp ? '' : '+'}${view.ctx.formatAmount(c.total)}
        </div>
      </div>`;
  }).join('');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.statsCategoryTitle')}</div>
      <div class="budget-chart">${rows}</div>
    </div>`);
}

function renderDonut() {
  const host = view.root.querySelector('#budget-stats-donut');
  const exp = view.data.byCategory
    .filter((c) => c.expenses < 0)
    .map((c) => ({ category: c.category, value: Math.abs(c.expenses) }));
  const total = exp.reduce((s, e) => s + e.value, 0);
  if (!host || total === 0) return;

  const C = 2 * Math.PI * 60; // r=60
  let offset = 0;
  const segs = exp.map((e, i) => {
    const frac = e.value / total;
    const seg = `
      <circle r="60" cx="80" cy="80" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}"
        stroke-width="22" stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)" />`;
    offset += frac * C;
    return seg;
  }).join('');
  const legend = exp.map((e, i) => `
    <span class="budget-stats__legend-item">
      <i class="budget-stats__swatch" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]};"></i>
      ${view.ctx.esc(view.ctx.categoryLabel(e.category))} · ${Math.round((e.value / total) * 100)}%
    </span>`).join('');

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.statsDonutTitle')}</div>
      <div class="budget-stats__donut-wrap">
        <svg viewBox="0 0 160 160" class="budget-stats__donut" role="img"
             aria-label="${t('budget.statsDonutTitle')}">${segs}</svg>
        <div class="budget-stats__legend budget-stats__legend--wrap">${legend}</div>
      </div>
    </div>`);
}

function renderExport() {
  const host = view.root.querySelector('.budget-stats__export');
  if (!host) return;
  const { from, to } = view.data;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <a class="btn btn--secondary" href="/api/v1/budget/export?from=${from}&to=${to}">
      <i data-lucide="download" class="icon-md" aria-hidden="true"></i> ${t('budget.statsExport')}
    </a>`);
  if (window.lucide) lucide.createIcons({ el: host });
}

function renderTrendChart() {
  const host = view.root.querySelector('#budget-stats-trend');
  if (!host) return;
  const s = view.data.series;
  const W = 600, H = 180, PAD = 8;
  const incomes  = s.map((p) => p.income);
  const expenses = s.map((p) => Math.abs(p.expenses));
  const max = Math.max(1, ...incomes, ...expenses);
  const x = (i) => PAD + (s.length <= 1 ? 0 : (i * (W - 2 * PAD)) / (s.length - 1));
  const y = (v) => H - PAD - (v / max) * (H - 2 * PAD);
  const points = (arr) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.statsTrendTitle')}</div>
      <svg class="budget-stats__trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
           role="img" aria-label="${t('budget.statsTrendTitle')}">
        <polyline fill="none" stroke="var(--color-success)" stroke-width="2"
                  vector-effect="non-scaling-stroke" points="${points(incomes)}" />
        <polyline fill="none" stroke="var(--color-danger)" stroke-width="2"
                  vector-effect="non-scaling-stroke" points="${points(expenses)}" />
      </svg>
      <div class="budget-stats__legend">
        <span><i class="budget-stats__swatch budget-stats__swatch--income"></i>${t('budget.statsIncome')}</span>
        <span><i class="budget-stats__swatch budget-stats__swatch--expense"></i>${t('budget.statsExpenses')}</span>
      </div>
    </div>`);
}

function updatePeriodLabel() {
  const el = view.root.querySelector('#budget-stats-period');
  if (el && view.data) el.textContent = `${formatDate(view.data.from)} – ${formatDate(view.data.to)}`;
}
