/**
 * Modul: Budget-Statistik-View
 * Zweck: Statistik-Tab (Zeitraum-Filter, Summary-Cards, Trendlinie, Donut, CSV-Export).
 */
import { api } from '/api.js';
import { t, formatDate, getLocale } from '/i18n.js';
import { wireTablist } from '/utils/tablist.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { mountEmptyState, mountLoadError } from '/utils/empty-state.js';
import { CHART, chartX, chartY, chartGridMarkup, chartXLabelsMarkup } from '/utils/chart.js';
import { formatMoneyAxis, formatSignedAmount } from '/utils/money.js';
import { addLocalDays } from '/utils/date.js';
import { trendMarkup } from '/utils/metric-card.js';

// Zeitraum und Anker gehören dem Modul (budget.js) und kommen über ctx herein.
// Vorher hielt dieser View beides selbst - damit gab es zwei Zeitachsen im selben
// Modul, die nie synchron waren (Critique 2026-07-30, P1).
const view = { range: 'month', anchor: null, data: null, prev: null, error: false, ctx: null, root: null };

const RANGE_LABELS = {
  week: 'budget.statsRangeWeek',
  month: 'budget.statsRangeMonth',
  year: 'budget.statsRangeYear',
};

export async function renderStats(panel, ctx) {
  view.ctx = ctx;
  view.root = panel;
  view.range = ctx.range;
  view.anchor = ctx.anchor;
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
    view.prev = await loadPrevious(res.data);
  } catch (err) {
    console.error('[Budget] stats load error:', err);
    view.data = null;
    // Das Fehlerobjekt selbst, nicht nur `true`: `mountLoadError` liest daraus
    // den Statuscode - die einzige Angabe, die dem Selbsthoster hier weiterhilft.
    view.error = err;
  }
  renderBodyContent(body);
}

/* DER VORZEITRAUM FUER DEN KATEGORIEVERGLEICH. Die Antwort traegt nur seine
 * Summen (`comparison`), nicht seine Kategorien - der Client fragt denselben
 * Endpunkt deshalb ein zweites Mal, verankert am Tag vor dem Zeitraum: das ist
 * die Vorwoche, der Vormonat oder das Vorjahr, je nach Aufloesung, und die
 * Grenzen dafuer zieht der Server wie beim ersten Aufruf. Scheitert nur dieser
 * Aufruf, fehlt der Vergleich - die Auswertung selbst bleibt stehen. */
async function loadPrevious(data) {
  if (!data?.from) return null;
  try {
    const res = await api.get(`/budget/stats?range=${view.range}&anchor=${addLocalDays(data.from, -1)}${scopeQuery()}`);
    return res.data;
  } catch (err) {
    console.error('[Budget] stats comparison load error:', err);
    return null;
  }
}

function renderShell() {
  view.root.replaceChildren();
  view.root.insertAdjacentHTML('beforeend', `
    <!-- reading, wie die Budget-Seite, in der dieses Panel steckt: dashboard
         hier setzte --page-measure fuer den Unterbaum auf --layout-wide, und das
         Kennzahlenband der Berichte lief auf 1200px, waehrend der Budget-Kopf
         und jeder andere Reiter bei 720px enden (auf main war es 720). Ein
         eigener Modus je Reiter hiesse, auch den Kopf je Reiter umzuschalten -
         das ist Welle C in docs/PAGE-COMPOSITION.md, keine Nebenwirkung. -->
    <div class="budget-stats app-page app-page--reading page-measure--narrow" data-composition="reading">
      <!-- Nur noch die Auflösung: der Zeitraum selbst wird über den geteilten
           Kopf-Stepper des Moduls gewählt. Optik aus dem geteilten
           .segmented-Baustein. -->
      <div class="budget-stats__controls">
        <div class="segmented budget-stats__ranges" role="tablist" aria-label="${t('budget.statsRangeLabel')}">
          ${['week', 'month', 'year'].map((r) => {
            const on = r === view.range;
            return `
            <button type="button" role="tab" class="segmented__item${on ? ' is-active' : ''}"
              data-tab-id="${r}" aria-selected="${on}" tabindex="${on ? '0' : '-1'}"
              aria-controls="budget-stats-body">${t(RANGE_LABELS[r])}</button>`;
          }).join('')}
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
  //
  // Die Auflösung meldet das Modul zurück (onRangeChange), damit sie den
  // Tabwechsel überlebt und der Kopf-Stepper in derselben Schrittweite läuft.
  wireTablist(view.root.querySelector('.budget-stats__ranges'), {
    activeId: view.range,
    activeClass: 'is-active',
    onChange: (id) => view.ctx.onRangeChange(id),
  });
}

function renderBodyContent(body) {
  // Zuerst der Zeitraum: er gehört in den Kopf und muss auch dann stimmen, wenn
  // der Zeitraum leer ist - sonst zeigte der Kopf beim Wochenwechsel in eine
  // buchungsfreie Woche weiter den alten Bereich.
  updatePeriodLabel();
  // Fehler beim Laden klar von „keine Daten" trennen: ein Netzwerk-/Serverfehler
  // darf der Familie nicht vortäuschen, ihre Finanzhistorie sei leer.
  if (view.error) {
    body.replaceChildren();
    mountLoadError(body, {
      title: t('budget.statsError'),
      description: t('budget.statsErrorDescription'),
      error: view.error,
      retryLabel: t('budget.statsRetry'),
      onRetry: () => loadStats(),
    });
    return;
  }
  const d = view.data;
  if (!d || (d.totals.income === 0 && d.totals.expenses === 0 && !d.series.some((s) => s.income || s.expenses))) {
    body.replaceChildren();
    mountEmptyState(body, {
      icon: 'chart-column',
      title: t('budget.statsEmptyTitle'),
      description: t('budget.statsEmptyDescription'),
    });
    return;
  }
  /* KEINE ZWEITE UEBERSICHT (Critique 2026-09-25). Hier standen dieselben
   * drei Kennzahl-Karten und dieselbe Kategorieliste wie auf dem Reiter
   * „Uebersicht" - fuer den Monat 1:1 dieselben Zahlen. Die Statistik
   * beantwortet jetzt, was die Uebersicht nicht kann: wie sich der Zeitraum
   * aufbaut (kumulierter Verlauf) und was sich gegenueber dem Vorzeitraum
   * je Kategorie veraendert hat. Die Summen stehen in der Legende des
   * Verlaufs, samt Veraenderung. */
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div id="budget-stats-trend"></div>
    <div id="budget-stats-cat"></div>
    <div id="budget-stats-donut"></div>
    <div class="budget-stats__export"></div>
  `);
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

function signed(n) {
  return formatSignedAmount(n, { currency: view.ctx.currency, role: 'flow' }).text;
}

// Je Kategorie die Summe EINER Richtung (Einnahmen oder Ausgaben) - dieselbe
// Trennung wie im Monats-Diagramm (budget.js `categoryBlocks`).
function categoryAmounts(byCategory, kind) {
  const map = new Map();
  for (const c of byCategory ?? []) {
    const value = Number(kind === 'expenses' ? c.expenses : c.income) || 0;
    if (value !== 0) map.set(c.category, value);
  }
  return map;
}

// Der Vorzeitraum als Text: „August 2026", „2025" oder „01.09. - 07.09.".
function previousPeriodLabel(prev) {
  if (!prev?.from) return '';
  if (view.range === 'year') return prev.from.slice(0, 4);
  if (view.range === 'month') {
    const [y, m] = prev.from.split('-').map(Number);
    return new Intl.DateTimeFormat(getLocale(), { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  }
  return `${formatDate(prev.from)} - ${formatDate(prev.to)}`;
}

/* VERGLEICH JE KATEGORIE STATT EINER ZWEITEN KATEGORIELISTE (Critique
 * 2026-09-25). Zwei Bloecke wie im Monats-Diagramm, jeder nach seinem eigenen
 * Maximum; neben jedem Betrag die Veraenderung gegenueber dem Vorzeitraum,
 * mit Pfeil (Richtung) und Farbe (Bewertung: mehr Ausgaben sind schlechter,
 * mehr Einnahmen besser) - dieselbe Trend-Sprache wie die Kennzahl-Karten.
 * Eine Kategorie, die nur im Vorzeitraum vorkam, steht mit null da: ihr
 * Wegfall ist genau die Veraenderung, nach der man hier sucht. */
function renderCatBars() {
  const host = view.root.querySelector('#budget-stats-cat');
  if (!host) return;
  const hasPrev = !!view.prev;
  // Budgetplan-Ziele nur im Monatsbereich einblenden — dort deckt sich der
  // Zeitraum exakt mit dem stetigen Monatsplan (kein irreführendes Hochskalieren).
  const plans = view.data.range === 'month' ? (view.data.plans || {}) : {};
  const blocks = [
    { kind: 'expenses', labelKey: 'budget.statsExpenses', betterWhen: 'lower' },
    { kind: 'income', labelKey: 'budget.statsIncome', betterWhen: 'higher' },
  ].map((b) => {
    const now = categoryAmounts(view.data.byCategory, b.kind);
    const before = categoryAmounts(view.prev?.byCategory, b.kind);
    const rows = [...new Set([...now.keys(), ...before.keys()])]
      .map((category) => ({ category, amount: now.get(category) ?? 0, prev: before.get(category) ?? 0 }))
      .sort((x, y) => (Math.abs(y.amount) - Math.abs(x.amount)) || (Math.abs(y.prev) - Math.abs(x.prev)));
    return { ...b, rows };
  }).filter((b) => b.rows.some((r) => r.amount !== 0));
  if (!blocks.length) return;

  const html = blocks.map(({ kind, labelKey, betterWhen, rows }) => {
    // DAS EIGENE MAXIMUM DES BLOCKS, wie im Monats-Diagramm.
    const max = Math.max(...rows.map((r) => Math.abs(r.amount)), 1);
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    const titleId = `budget-stats-${kind}-title`;
    const body = rows.map((r) => {
      // Der Anteil ist der Anteil: kein Boden (Critique 2026-08-13, Guard in
      // test:frontend-audit) - der Mindeststummel steht als Laenge im CSS.
      const scale = Math.abs(r.amount) / max;
      const target = kind === 'expenses' ? plans[r.category] : undefined;
      const targetPos = target != null ? Math.min(1, target / max) : null;
      const targetMarker = targetPos != null
        ? `<div class="budget-bar-row__target" style="--target-pos:${targetPos.toFixed(4)}"
               title="${view.ctx.esc(t('budget.planTarget', { amount: view.ctx.formatAmount(target) }))}"></div>`
        : '';
      const catLabel = view.ctx.esc(view.ctx.categoryLabel(r.category));
      // Betragsraum wie auf den Karten: Ausgaben als Betrag, damit „+" mehr
      // ausgegeben heisst und nicht weniger.
      const delta = Math.abs(r.amount) - Math.abs(r.prev);
      const deltaHtml = hasPrev
        ? trendMarkup({ delta, betterWhen, text: view.ctx.esc(signed(delta)) })
        : '';
      return `
        <div class="budget-bar-row budget-bar-row--compare">
          <div class="budget-bar-row__label" title="${catLabel}">${catLabel}</div>
          <div class="budget-bar-row__track" style="--bar-visible:${r.amount !== 0 ? 1 : 0}">
            <div class="budget-bar-row__fill budget-bar-row__fill--${kind}" style="--bar-scale:${scale.toFixed(4)}"></div>
            ${targetMarker}
          </div>
          <div class="budget-bar-row__amount">${view.ctx.esc(signed(r.amount))}</div>
          ${deltaHtml ? `<div class="budget-bar-row__delta">${deltaHtml}</div>` : ''}
        </div>`;
    }).join('');
    return `
      <section class="budget-chart-block budget-chart-block--${kind}" aria-labelledby="${titleId}">
        <h3 class="budget-chart-block__title" id="${titleId}">
          <span>${t(labelKey)}</span>
          <span class="budget-chart-block__total">${view.ctx.esc(signed(total))}</span>
        </h3>
        <div class="budget-chart-block__rows">${body}</div>
      </section>`;
  }).join('');

  const note = hasPrev
    ? `<p class="budget-stats__compare-note">${view.ctx.esc(t('budget.statsCompareNote', { period: previousPeriodLabel(view.prev) }))}</p>`
    : '';
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <h2 class="budget-chart-section__title">${t('budget.statsCategoryTitle')}</h2>
      ${note}
      <div class="budget-chart">${html}</div>
    </div>`);
  if (window.lucide) lucide.createIcons({ el: host });
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
      <h2 class="budget-chart-section__title">${t('budget.statsDonutTitle')}</h2>
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
  const comparison = view.data.comparison;
  const s = view.data.series;
  const rawIncomes  = s.map((p) => p.income);
  const rawExpenses = s.map((p) => Math.abs(p.expenses));
  /* AUFSUMMIERT, SOLANGE DIE PUNKTE TAGE SIND (Critique 2026-09-25). Als
   * Tageswerte war der Monat eine flache Linie mit zwei Zacken (Gehalt, Miete)
   * - wie der Monat verlaeuft, ob die Ausgaben die Einnahmen einholen, sah man
   * nicht. Aufsummiert endet jede Kurve bei der Summe des Zeitraums, und der
   * Abstand zwischen beiden ist der Saldo bis zu diesem Tag. Das Jahr bleibt
   * je Monat: zwoelf Monatswerte vergleicht man nebeneinander. */
  const cumulative = s.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(s[0].period);
  const running = (arr) => { let acc = 0; return arr.map((v) => (acc += v)); };
  const incomes  = cumulative ? running(rawIncomes) : rawIncomes;
  const expenses = cumulative ? running(rawExpenses) : rawExpenses;
  const shown = s.map((p, i) => ({ period: p.period, income: incomes[i], expenses: expenses[i] }));
  const max = Math.max(1, ...incomes, ...expenses);
  const points = (arr) => arr.map((v, i) => `${chartX(i, s.length).toFixed(1)},${chartY(v, 0, max).toFixed(1)}`).join(' ');
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const pointKey = cumulative ? 'budget.statsPointLabelCumulative' : 'budget.statsPointLabel';

  // DIE ACHSE STEHT JETZT IM BILD (utils/chart.js).
  //
  // Hier stand: „Achsenbeschriftung liegt als HTML außerhalb des SVG, weil
  // preserveAspectRatio='none' jeden Text im SVG verzerren würde." Der Satz war
  // richtig und hat die Kausalität verkehrt herum gelesen - das `none` war die
  // URSACHE, nicht die Randbedingung. Ohne feste Ränder gibt es keinen Platz für
  // eine Achse im Bild, also musste sie nach draußen, und dort verschiebt sie
  // sich gegen ihre eigenen Gitterlinien, sobald das Diagramm skaliert (gemessen:
  // ein 600x180-viewBox auf 720x216 gestreckt). Die geteilte Geometrie bringt den
  // linken Gutter mit, damit fällt beides weg.
  //
  // Zweiter Kanal neben der Farbe (Critique P2): Einnahmen solide, Ausgaben
  // gestrichelt - so trennen sich die Serien auch bei Rot-Grün-Schwäche. Der
  // Screenreader-Zugang liegt in der sr-only-Summary + den Punkt-Buttons; das
  // rein visuelle SVG bleibt daher bewusst aria-hidden.
  const summary = t('budget.statsTrendSummary', {
    periods: s.length,
    income: fmtAmount(sum(rawIncomes)),
    expenses: fmtAmount(sum(rawExpenses)),
    peak: fmtAmount(max),
  });

  // Ablesbare Einzelwerte: die Kurve allein sagt nur "irgendwann im Mai war es
  // viel". Je Datenpunkt eine unsichtbare Schaltfläche über dem Diagramm — der
  // Wert steht in ihrem aria-label (also auch ohne Maus erreichbar, nicht als
  // Hover-only-Tooltip) und erscheint sichtbar in der Ableselinie darunter.
  const hotspots = shown.map((p, i) => {
    const label = t(pointKey, {
      period: periodLabel(p.period),
      income: fmtAmount(p.income),
      expenses: fmtAmount(p.expenses),
    });
    const frac = chartX(i, s.length) / CHART.W;
    return `<button type="button" class="budget-stats__point" data-index="${i}"
              style="--point-x:${frac.toFixed(4)};--point-slots:${s.length}"
              tabindex="${i === s.length - 1 ? '0' : '-1'}"
              aria-label="${view.ctx.esc(label)}"></button>`;
  }).join('');

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <h2 class="budget-chart-section__title">${t(cumulative ? 'budget.statsTrendTitleCumulative' : 'budget.statsTrendTitle')}</h2>
      <p class="sr-only">${view.ctx.esc(summary)}</p>
      <div class="budget-stats__trend-wrap">
        <div class="budget-stats__plot">
          <svg class="budget-stats__trend" viewBox="0 0 ${CHART.W} ${CHART.H}" aria-hidden="true">
            ${chartGridMarkup(0, max, (val) => formatMoneyAxis(val, view.ctx.currency))}
            ${chartXLabelsMarkup(s.map((p) => periodLabel(p.period)))}
            <polyline fill="none" stroke="var(--color-success)" stroke-width="2"
                      vector-effect="non-scaling-stroke" points="${points(incomes)}" />
            <polyline fill="none" stroke="var(--color-danger)" stroke-width="2" stroke-dasharray="6 4"
                      vector-effect="non-scaling-stroke" points="${points(expenses)}" />
          </svg>
          <div class="budget-stats__points" role="group" aria-label="${t('budget.statsPointsLabel')}">${hotspots}</div>
        </div>
      </div>
      <div class="budget-stats__readout" id="budget-stats-readout" aria-hidden="true"></div>
      <div class="budget-stats__legend">
        <span class="budget-stats__legend-item"><i class="budget-stats__swatch budget-stats__swatch--income"></i>${t('budget.statsIncome')} · ${fmtAmount(sum(rawIncomes))}${totalTrend(sum(rawIncomes), comparison?.income, 'higher')}</span>
        <span class="budget-stats__legend-item"><i class="budget-stats__swatch budget-stats__swatch--expense"></i>${t('budget.statsExpenses')} · ${fmtAmount(sum(rawExpenses))}${totalTrend(sum(rawExpenses), comparison && Math.abs(comparison.expenses), 'lower')}</span>
      </div>
    </div>`);
  if (window.lucide) lucide.createIcons({ el: host });
  wireTrendPoints(host, shown, pointKey, s);
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
/* Die Summe des Zeitraums gegen den Vorzeitraum, in der Trend-Sprache der
 * Kennzahl-Karten - die Karten selbst stehen auf der Uebersicht. */
function totalTrend(current, previous, betterWhen) {
  if (previous == null) return '';
  const delta = current - previous;
  return ` ${trendMarkup({ delta, betterWhen, text: view.ctx.esc(signed(delta)) })}`;
}

function wireTrendPoints(host, series, labelKey, raw = series) {
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
    readout.textContent = t(labelKey, {
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
  /* DIE GANZE FLAECHE IST DAS ZIEL (Critique 2026-09-25). Ein Punkt war eine
   * Spalte von 100 % / Tage - 22-24px am Desktop, 10px am Telefon. Zeigen und
   * Wischen waehlen jetzt ueber die ganze Diagrammflaeche den naechsten Tag,
   * wie ein Regler; die Knoepfe bleiben fuer Tastatur und Screenreader. */
  group.addEventListener('pointermove', (e) => {
    const rect = group.getBoundingClientRect();
    if (!rect.width) return;
    const x = (e.clientX - rect.left) / rect.width;
    let best = 0;
    buttons.forEach((b, i) => {
      if (Math.abs(Number(b.style.getPropertyValue('--point-x')) - x)
        < Math.abs(Number(buttons[best].style.getPropertyValue('--point-x')) - x)) best = i;
    });
    show(best);
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
  // Aufsummiert ist kein Wert mehr null - gesucht wird am ROHEN Abschnitt.
  let initial = raw.length - 1;
  while (initial > 0 && !raw[initial].income && !raw[initial].expenses) initial--;
  show(initial);
}

// Der Zeitraum steht im geteilten Kopf, nicht mehr im Panel. Gemeldet wird er
// erst nach dem Laden, weil der Server die Wochengrenzen festlegt.
function updatePeriodLabel() {
  if (view.data) view.ctx.onPeriod({ from: view.data.from, to: view.data.to });
}
