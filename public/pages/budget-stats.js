/**
 * Modul: Budget-Statistik-View
 * Zweck: Statistik-Tab (Zeitraum-Filter, Summary-Cards, Trendlinie, Donut, CSV-Export).
 */
import { api } from '/api.js';
import { t, formatDate, getLocale } from '/i18n.js';
import { toLocalDateKey, parseLocalDateKey, addLocalDays } from '/utils/date.js';
import { wireTablist } from '/utils/tablist.js';
import { renderSkeletonList } from '/utils/skeleton.js';

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

// Ansichts-Scope (#476/#505): im personal-Modus folgen Statistik und Export dem
// Mein/Haushalt-Umschalter, sonst ignoriert der Server den Parameter.
function scopeQuery() {
  return view.ctx?.budgetMode === 'personal' ? `&scope=${view.ctx.scope}` : '';
}

async function loadStats() {
  const body = view.root.querySelector('#budget-stats-body');
  // Ladezustand statt leerer Fläche — der Budget-Tab zeigt beim Monatswechsel
  // ebenfalls ein Skelett; hier blieb das Panel bis zur Antwort einfach leer.
  if (body) {
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 4, lines: 2 }));
  }
  try {
    const res = await api.get(`/budget/stats?range=${view.range}&anchor=${view.anchor}${scopeQuery()}`);
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
        <div class="budget-stats__ranges" role="tablist" aria-label="${t('budget.statsRangeLabel')}">
          ${['week', 'month', 'year'].map((r) => {
            const on = r === view.range;
            return `
            <button type="button" role="tab" class="budget-stats__range${on ? ' is-active' : ''}"
              data-tab-id="${r}" aria-selected="${on}" tabindex="${on ? '0' : '-1'}"
              aria-controls="budget-stats-body">${t(RANGE_LABELS[r])}</button>`;
          }).join('')}
        </div>
        <div class="budget-stats__stepper">
          <button class="btn btn--icon" data-step="-1" aria-label="${t('budget.prevPeriod')}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
          <span class="budget-stats__period" id="budget-stats-period"></span>
          <button class="btn btn--icon" data-step="1" aria-label="${t('budget.nextPeriod')}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
        </div>
      </div>
      <div id="budget-stats-body" role="tabpanel" tabindex="0"></div>
    </div>
  `);
  if (window.lucide) lucide.createIcons({ el: view.root });
  wire();
}

function wire() {
  // Geteilte Tablist-Grammatik (Klick + Pfeiltasten/Home/End + Roving-Tabindex)
  // wie die Budget-Haupttabs — vorher trug der Container role="tablist", ohne
  // dass ein Kind role="tab" hatte, und Pfeiltasten taten nichts.
  wireTablist(view.root.querySelector('.budget-stats__ranges'), {
    activeId: view.range,
    activeClass: 'is-active',
    onChange: (id) => { view.range = id; renderShell(); loadStats(); },
  });
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

// Eigene Datenreihen-Palette (tokens.css) statt geborgter Fremdmodul-Akzente:
// --module-shopping/--module-meals tragen eine andere Bedeutung und garantieren
// keinen Kontrast gegen die Kartenfläche. Die Zahl der Segmente ist auf
// DONUT_SEGMENTS begrenzt, damit sich keine zwei Segmente dieselbe Farbe teilen.
const DONUT_COLORS = [
  'var(--chart-series-1)', 'var(--chart-series-2)', 'var(--chart-series-3)',
  'var(--chart-series-4)', 'var(--chart-series-5)', 'var(--chart-series-6)',
  'var(--chart-series-7)',
];
const DONUT_SEGMENTS = DONUT_COLORS.length;

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
    const catLabel = view.ctx.esc(view.ctx.categoryLabel(c.category));
    return `
      <div class="budget-bar-row">
        <div class="budget-bar-row__label" title="${catLabel}">${catLabel}</div>
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

// Segmente auf die Palettengröße begrenzen: alles jenseits davon fließt in eine
// „Sonstige"-Sammelscheibe. Ein Donut mit 15 Kategorien ist ohnehin nicht mehr
// ablesbar, und ohne Deckel bekämen Segment 1 und 8 dieselbe Farbe.
function donutSlices(byCategory) {
  const exp = byCategory
    .filter((c) => c.expenses < 0)
    .map((c) => ({ label: view.ctx.categoryLabel(c.category), value: Math.abs(c.expenses) }))
    .sort((a, b) => b.value - a.value);
  if (exp.length <= DONUT_SEGMENTS) return exp;
  const head = exp.slice(0, DONUT_SEGMENTS - 1);
  const restValue = exp.slice(DONUT_SEGMENTS - 1).reduce((s, e) => s + e.value, 0);
  return [...head, { label: t('budget.statsOtherCategories'), value: restValue }];
}

function renderDonut() {
  const host = view.root.querySelector('#budget-stats-donut');
  const exp = donutSlices(view.data.byCategory);
  const total = exp.reduce((s, e) => s + e.value, 0);
  if (!host || total === 0) return;

  const pctOf = (value) => Math.round((value / total) * 100);
  const C = 2 * Math.PI * 60; // r=60
  let offset = 0;
  const segs = exp.map((e, i) => {
    const frac = e.value / total;
    const seg = `
      <circle r="60" cx="80" cy="80" fill="none" stroke="${DONUT_COLORS[i]}"
        stroke-width="22" stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)" />`;
    offset += frac * C;
    return seg;
  }).join('');
  // Die Legende trägt Betrag und Anteil als Text — die Farbe ist Beiwerk, nicht
  // der einzige Träger der Information (gilt auch für Farbfehlsichtigkeit).
  const legend = exp.map((e, i) => `
    <span class="budget-stats__legend-item">
      <i class="budget-stats__swatch" style="background:${DONUT_COLORS[i]};"></i>
      ${view.ctx.esc(e.label)} · ${fmtAmount(e.value)} · ${pctOf(e.value)}%
    </span>`).join('');
  const summary = t('budget.statsDonutSummary', {
    count: exp.length,
    top: exp[0].label,
    pct: pctOf(exp[0].value),
    total: fmtAmount(total),
  });

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.statsDonutTitle')}</div>
      <p class="sr-only">${view.ctx.esc(summary)}</p>
      <div class="budget-stats__donut-wrap">
        <svg viewBox="0 0 160 160" class="budget-stats__donut" aria-hidden="true">${segs}</svg>
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
    <a class="btn btn--secondary" href="/api/v1/budget/export?from=${from}&to=${to}${scopeQuery()}">
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
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  // Die Kurve trug bisher weder Skala noch Zeitachse: zwei farbige Linien ohne
  // jeden ablesbaren Wert. Achsenbeschriftung liegt als HTML außerhalb des SVG,
  // weil preserveAspectRatio="none" jeden Text im SVG verzerren würde.
  // Zweiter Kanal neben der Farbe (Critique P2): Einnahmen solide, Ausgaben
  // gestrichelt - so trennen sich die Serien auch bei Rot-Grün-Schwäche. Der
  // Screenreader-Zugang liegt in der sr-only-Summary + den Punkt-Buttons; das
  // rein visuelle SVG bleibt daher bewusst aria-hidden.
  const summary = t('budget.statsTrendSummary', {
    periods: s.length,
    income: fmtAmount(sum(incomes)),
    expenses: fmtAmount(sum(expenses)),
    peak: fmtAmount(max),
  });

  // Ablesbare Einzelwerte: die Kurve allein sagt nur "irgendwann im Mai war es
  // viel". Je Datenpunkt eine unsichtbare Schaltfläche über dem Diagramm — der
  // Wert steht in ihrem aria-label (also auch ohne Maus erreichbar, nicht als
  // Hover-only-Tooltip) und erscheint sichtbar in der Ableselinie darunter.
  const hotspots = s.map((p, i) => {
    const label = t('budget.statsPointLabel', {
      period: periodLabel(p.period),
      income: fmtAmount(p.income),
      expenses: fmtAmount(Math.abs(p.expenses)),
    });
    const frac = s.length <= 1 ? 0 : (PAD + (i * (W - 2 * PAD)) / (s.length - 1)) / W;
    return `<button type="button" class="budget-stats__point" data-index="${i}"
              style="--point-x:${frac.toFixed(4)};--point-slots:${s.length}"
              tabindex="${i === s.length - 1 ? '0' : '-1'}"
              aria-label="${view.ctx.esc(label)}"></button>`;
  }).join('');

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <div class="budget-chart-section__title">${t('budget.statsTrendTitle')}</div>
      <p class="sr-only">${view.ctx.esc(summary)}</p>
      <div class="budget-stats__trend-wrap">
        <span class="budget-stats__axis-max" aria-hidden="true">${fmtAmount(max)}</span>
        <span class="budget-stats__axis-mid" aria-hidden="true">${fmtAmount(max / 2)}</span>
        <div class="budget-stats__plot">
          <svg class="budget-stats__trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            ${[0.25, 0.5, 0.75].map((f) => {
              const gy = (PAD + f * (H - 2 * PAD)).toFixed(1);
              return `<line class="budget-stats__grid" x1="0" y1="${gy}" x2="${W}" y2="${gy}" vector-effect="non-scaling-stroke" />`;
            }).join('')}
            <polyline fill="none" stroke="var(--color-success)" stroke-width="2"
                      vector-effect="non-scaling-stroke" points="${points(incomes)}" />
            <polyline fill="none" stroke="var(--color-danger)" stroke-width="2" stroke-dasharray="6 4"
                      vector-effect="non-scaling-stroke" points="${points(expenses)}" />
          </svg>
          <div class="budget-stats__points" role="group" aria-label="${t('budget.statsPointsLabel')}">${hotspots}</div>
        </div>
        <div class="budget-stats__axis-x" aria-hidden="true">
          <span>${formatDate(view.data.from)}</span>
          <span>${formatDate(view.data.to)}</span>
        </div>
      </div>
      <div class="budget-stats__readout" id="budget-stats-readout" aria-hidden="true"></div>
      <div class="budget-stats__legend">
        <span><i class="budget-stats__swatch budget-stats__swatch--income"></i>${t('budget.statsIncome')} · ${fmtAmount(sum(incomes))}</span>
        <span><i class="budget-stats__swatch budget-stats__swatch--expense"></i>${t('budget.statsExpenses')} · ${fmtAmount(sum(expenses))}</span>
      </div>
    </div>`);
  wireTrendPoints(host, s);
}

// Bucket-Schlüssel der Serie: 'YYYY-MM' (Monatsraster) oder 'YYYY-MM-DD' (Tage).
function periodLabel(period) {
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-').map(Number);
    return new Intl.DateTimeFormat(getLocale(), { month: 'short', year: 'numeric' }).format(new Date(y, m - 1, 1));
  }
  return formatDate(period);
}

// Ableselinie + Roving-Tabindex über den Datenpunkten. Ein Tabstopp für die
// ganze Kurve (nicht 31 bei einem Monatsraster), Pfeiltasten wandern, Zeigen
// und Antippen wählen direkt. Der Wert steht ohnehin im aria-label jedes
// Punktes — die sichtbare Zeile ist die Entsprechung für alle anderen.
function wireTrendPoints(host, series) {
  const group = host.querySelector('.budget-stats__points');
  const readout = host.querySelector('#budget-stats-readout');
  if (!group || !readout) return;
  const buttons = [...group.querySelectorAll('.budget-stats__point')];
  if (!buttons.length) return;

  const show = (index, { focus = false } = {}) => {
    const point = series[index];
    if (!point) return;
    buttons.forEach((b, i) => {
      b.classList.toggle('is-active', i === index);
      b.tabIndex = i === index ? 0 : -1;
    });
    readout.textContent = t('budget.statsPointLabel', {
      period: periodLabel(point.period),
      income: fmtAmount(point.income),
      expenses: fmtAmount(Math.abs(point.expenses)),
    });
    if (focus) buttons[index].focus();
  };

  group.addEventListener('focusin', (e) => {
    const btn = e.target.closest('.budget-stats__point');
    if (btn) show(Number(btn.dataset.index));
  });
  group.addEventListener('pointerover', (e) => {
    const btn = e.target.closest('.budget-stats__point');
    if (btn) show(Number(btn.dataset.index));
  });
  group.addEventListener('keydown', (e) => {
    const current = buttons.findIndex((b) => b.tabIndex === 0);
    let next = current;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(buttons.length - 1, current + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else return;
    e.preventDefault();
    show(next, { focus: true });
  });

  // Jüngster Zeitabschnitt MIT Daten als Ausgangswert: der Monatsletzte ist
  // oft noch leer und "31.07. · 0,00" wäre ein nichtssagender Start
  // (Audit A2-05). Ganz ohne Daten bleibt der letzte Abschnitt.
  let initial = series.length - 1;
  while (initial > 0 && !series[initial].income && !series[initial].expenses) initial--;
  show(initial);
}

function updatePeriodLabel() {
  const el = view.root.querySelector('#budget-stats-period');
  if (el && view.data) el.textContent = `${formatDate(view.data.from)} – ${formatDate(view.data.to)}`;
}
