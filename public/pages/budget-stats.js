/**
 * Modul: Budget-Statistik-View
 * Zweck: Statistik-Tab (Zeitraum-Filter, Summary-Cards, Trendlinie, Donut, CSV-Export).
 */
import { api } from '/api.js';
import { t, formatDate, getLocale } from '/i18n.js';
import { wireTablist } from '/utils/tablist.js';
import { attachSegmentIndicator } from '/utils/segment-indicator.js';
import { renderSkeletonChart } from '/utils/skeleton.js';
import { growBars, drawChartOnce } from '/utils/ux.js';
import { mountEmptyState, mountLoadError } from '/utils/empty-state.js';
import { CHART, chartX, chartY, chartGridMarkup, chartXLabelsMarkup, calmDomain } from '/utils/chart.js';
import { formatMoneyAxis, formatSignedAmount } from '/utils/money.js';
import { addLocalDays, todayKey } from '/utils/date.js';
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

/* DIE LETZTE ANFRAGE GEWINNT, NICHT DIE LETZTE ANTWORT (#1775, Review). `view`
 * ist EIN geteilter Zustand, und jeder Schritt am Stepper (Pfeil oder Wisch)
 * startet eine neue Ladung, ohne auf die vorige zu warten: kam die aeltere
 * Antwort spaeter an, schrieb sie ihren Zeitraum ueber den neueren - der Kopf
 * zeigte April, die Auswertung Maerz. Jede Ladung zieht deshalb eine Nummer
 * und schreibt nur, wenn sie noch die juengste ist. Liefert `false` fuer eine
 * ueberholte Ladung; die zeichnet dann auch nichts. */
let loadSeq = 0;
async function fetchStats() {
  const seq = ++loadSeq;
  let data = null;
  let prev = null;
  let error = false;
  try {
    const res = await api.get(`/budget/stats?range=${view.range}&anchor=${view.anchor}${scopeQuery()}`);
    data = res.data;
    prev = await loadPrevious(res.data);
  } catch (err) {
    console.error('[Budget] stats load error:', err);
    data = null;
    // Das Fehlerobjekt selbst, nicht nur `true`: `mountLoadError` liest daraus
    // den Statuscode - die einzige Angabe, die dem Selbsthoster hier weiterhilft.
    error = err;
  }
  if (seq !== loadSeq) return false;
  view.data = data;
  view.prev = prev;
  view.error = error;
  return true;
}

async function loadStats() {
  const body = view.root.querySelector('#budget-stats-body');
  // Ladezustand statt leerer Fläche — der Budget-Tab zeigt beim Monatswechsel
  // ebenfalls ein Skelett; hier blieb das Panel bis zur Antwort einfach leer.
  if (body) {
    body.replaceChildren();
    // Diagrammfoermig, nicht als Liste: danach stehen hier Verlauf und Anteile.
    body.insertAdjacentHTML('beforeend', renderSkeletonChart({ charts: 2 }));
  }
  if (!(await fetchStats())) return;
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
  // Gleitende Auswahl-Kapsel wie jede Segmentleiste (Kanon, Runde 7 D8); das
  // Panel wird mit dem Berichte-Tab neu gebaut, der Schluessel haelt die Lage.
  attachSegmentIndicator(view.root.querySelector('.budget-stats__ranges'), { key: 'budget-stats-range' });
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
    // EIN LEERZUSTAND MIT HANDLUNG (Critique R17): „Keine Daten im Zeitraum"
    // endete in einer Sackgasse - der Reiter hat keinen Anlege-Knopf im Kopf.
    // Wer schreiben darf, legt von hier den Eintrag an, der die Statistik
    // fuellt (derselbe Dialog und dasselbe Wort wie im Leerzustand der
    // Uebersicht); bei `read` bleibt die Auskunft.
    const box = mountEmptyState(body, {
      icon: 'chart-column',
      title: t('budget.statsEmptyTitle'),
      description: t('budget.statsEmptyDescription'),
      action: typeof view.ctx.onAddEntry === 'function'
        ? { label: t('budget.emptyAction'), icon: 'plus', attrs: { id: 'budget-stats-empty-add' } }
        : undefined,
    });
    box?.querySelector('#budget-stats-empty-add')?.addEventListener('click', () => view.ctx.onAddEntry?.(
      // Der Zeitraum, den der Server fuer DIESE Ansicht gemeldet hat (#1775).
      view.data ? { from: view.data.from, to: view.data.to } : null,
    ));
    return;
  }
  /* KEINE ZWEITE UEBERSICHT (Critique 2026-09-25). Hier standen dieselben
   * drei Kennzahl-Karten und dieselbe Kategorieliste wie auf dem Reiter
   * „Uebersicht" - fuer den Monat 1:1 dieselben Zahlen. Die Statistik
   * beantwortet jetzt, was die Uebersicht nicht kann: wie sich der Zeitraum
   * aufbaut (kumulierter Verlauf) und was sich gegenueber dem Vorzeitraum
   * je Kategorie veraendert hat. Die Summen stehen in der Legende des
   * Verlaufs, samt Veraenderung. */
  /* EINE BAHN WIE DIE UEBRIGEN REITER (Critique 2026-09-26, A5 P2-5). Die
   * drei Diagramme standen untereinander auf dem Lesemass und endeten 404px
   * vor der Bahn, an der Uebersicht, Konten, Abos, Darlehen und Aufteilung
   * enden. Ab 960px Modulflaeche steht die Statistik in derselben Zweispalte
   * wie die Uebersicht (budget.css, Container der Budget-Seite): links Verlauf und
   * Kategorievergleich auf dem Lesemass, rechts die Ausgaben-Anteile als
   * Seitenleiste. Der Verlauf bleibt links, weil sein SVG mit der Breite auch
   * in der Hoehe und in der Schrift waechst. */
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    ${/* DER RING IST DER KOPF DER KATEGORIELISTE (R16 Schritt 2b). Er stand im
        * Markup HINTER den Balken: mobil 874px von ihnen entfernt, am Desktop in
        * einer Seitenleiste, die unter ihm leer blieb, waehrend links 700px
        * Balken liefen. Jetzt: Verlauf und Ring teilen die erste Zeile (Ring
        * rechts), die Balken nehmen darunter die ganze Bahn; einspaltig steht
        * der Ring zwischen Verlauf und Balken. Keine leere Leiste, kein
        * Anheften. */ ''}
    <div class="budget-stats__grid">
      <div id="budget-stats-trend" class="budget-stats__main"></div>
      <div id="budget-stats-donut" class="budget-stats__aside"></div>
      <div id="budget-stats-cat" class="budget-stats__main budget-stats__main--wide"></div>
    </div>
    <div class="budget-stats__export"></div>
  `);
  renderTrendChart();
  watchTrendBreakpoint(view.root);
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
/* EINE FARBE JE KATEGORIE IN BEIDEN DIAGRAMMEN (R14 P8, A5 P2-8). Die
 * Ausgabenbalken standen alle im Modulton, der Donut daneben in sieben
 * Serienfarben - dieselben Betraege in zwei Farbsystemen. Jetzt nimmt jeder
 * Balken die Farbe seines Donut-Segments (dieselbe Reihenfolge wie
 * donutSlices: groesste Ausgabe zuerst, jenseits der Palette die Farbe der
 * Sammelscheibe). */
function categoryColorIndex(byCategory) {
  const order = (byCategory ?? [])
    .filter((c) => c.expenses < 0)
    .sort((a, b) => Math.abs(b.expenses) - Math.abs(a.expenses));
  return new Map(order.map((c, i) => [c.category, Math.min(i, DONUT_SEGMENTS - 1)]));
}

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

  const colors = categoryColorIndex(view.data.byCategory);
  const html = blocks.map(({ kind, labelKey, betterWhen, rows }) => {
    // DAS EIGENE MAXIMUM DES BLOCKS, wie im Monats-Diagramm.
    const max = Math.max(...rows.map((r) => Math.abs(r.amount)), 1);
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    const absTotal = rows.reduce((sum, r) => sum + Math.abs(r.amount), 0);
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
      // Ausgaben: Farbe des Donut-Segments und der Anteil als Text - die Farbe
      // ist Zuordnung, der Anteil die Aussage (auch ohne Farbsehen lesbar).
      const colorIndex = kind === 'expenses' ? colors.get(r.category) : undefined;
      const fillColor = colorIndex != null ? `;--bar-fill:${DONUT_COLORS[colorIndex]}` : '';
      const share = kind === 'expenses' && absTotal > 0 && r.amount !== 0
        ? ` <span class="budget-bar-row__share">${Math.round((Math.abs(r.amount) / absTotal) * 100)}%</span>`
        : '';
      return `
        <div class="budget-bar-row budget-bar-row--compare">
          <div class="budget-bar-row__label" title="${catLabel}">${catLabel}</div>
          <div class="budget-bar-row__track" style="--bar-visible:${r.amount !== 0 ? 1 : 0}">
            <div class="budget-bar-row__fill budget-bar-row__fill--${kind}" style="--bar-scale:${scale.toFixed(4)}${fillColor}" data-bar-key="${kind}:${view.ctx.esc(String(r.category))}"></div>
            ${targetMarker}
          </div>
          <div class="budget-bar-row__amount">${view.ctx.esc(signed(r.amount))}${share}</div>
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
  growBars(host, { selector: '.budget-bar-row__fill', memo: 'budget-stats-categories' });
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
        stroke-width="16" stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)" />`;
    offset += frac * C;
    return seg;
  }).join('');
  // KEINE ZWEITE LEGENDE (R14 P8): Betrag und Anteil je Kategorie stehen an
  // den Balken, die dieselbe Farbe tragen (categoryColorIndex). Die
  // Donut-Legende zaehlte alles ein zweites Mal auf. Die Zusammenfassung
  // (Zahl der Segmente, groesstes, Summe) stand seit R16 SICHTBAR neben dem
  // Ring: sie war nur fuer Screenreader da, und der Ring stand ohne ein Wort
  // neben 198px Leere.
  //
  // DIE SUMME STEHT IN DER RINGMITTE (Critique R18, 2026-10-07). Der Satz
  // "7 Segmente · Groesstes: ..." war Fliesstext neben einem leeren Ring - das
  // eine Wort, das der Ring braucht, ist seine Summe, und die gehoert in seine
  // Mitte. Was R16 schuetzte, bleibt: der Ring steht nicht stumm da (er nennt
  // jetzt sichtbar, WAS er teilt und wie viel), und er steht nicht neben Leere
  // (er sitzt mittig auf seinem Traeger). Der Satz geht zurueck in die
  // zugaengliche Beschreibung - mit der genauen Summe; die Mitte rundet auf
  // ganze Einheiten, damit auch sechsstellige Betraege in 104px passen.
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
      <div class="budget-stats__card budget-stats__donut-wrap">
        <svg viewBox="0 0 160 160" class="budget-stats__donut" aria-hidden="true">
          <g class="budget-stats__donut-arcs">${segs}</g>
          <text class="budget-stats__donut-total" x="80" y="77" text-anchor="middle">${view.ctx.esc(formatMoneyAxis(total, view.ctx.currency))}</text>
          <text class="budget-stats__donut-label" x="80" y="77" dy="1.5em" text-anchor="middle">${view.ctx.esc(t('budget.statsExpenses'))}</text>
        </svg>
      </div>
    </div>`);
  // Der Ring fuellt sich einmal, beim ersten Erscheinen (ux.js, drawChartOnce).
  drawChartOnce('budget-stats-donut', { arcs: host.querySelectorAll('.budget-stats__donut circle') });
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
  // Ruhige Achse (R18): drei Linien - 0 / 3.000 / 6.000. `max` bleibt der echte
  // Spitzenwert fuer die Zusammenfassung, die Kurve misst gegen die Obergrenze.
  const axis = calmAxis(max);
  // MOBIL EINE HOEHERE FLAECHE (Critique R17). Die Geometrie skaliert mit der
  // Breite: 600x200 wurden bei 390px Fenster 324x108 - eine Kurve, die zwischen
  // zwei Gitterlinien kaum Hub hat. Unter 640px rechnet das Diagramm auf
  // 600x300 (dieselben Raender, utils/chart.js `geo`) und steht damit bei
  // mindestens 160px. Entschieden beim Zeichnen, wie die uebrigen Flaechen.
  const geo = trendGeometry();
  // HEUTE TEILT DIE KURVE (Critique R17). Aufsummiert lief sie durchgezogen bis
  // zum Monatsende - ab heute eine waagerechte Linie, die behauptet, es sei
  // schon gebucht. EIN Strichprinzip (R18): was war, ist durchgezogen, was
  // kommt, punktiert - fuer beide Serien. Die Serien selbst trennt die Farbe,
  // die Flaeche unter den Einnahmen und der beschriftete Punkt am heutigen Tag;
  // die Ausgaben trugen bis dahin zusaetzlich eine Strichelung, und mit der
  // punktierten Zukunft standen drei Strichmuster in einem Bild.
  const todayIndex = cumulative ? futureStartIndex(s.map((p) => p.period), todayKey()) : -1;
  const lastPast = todayIndex >= 0 ? todayIndex : s.length - 1;
  const points = (arr, from = 0, to = arr.length - 1) => arr
    .map((v, i) => (i < from || i > to ? null : `${chartX(i, s.length, geo).toFixed(1)},${chartY(v, 0, axis.max, geo).toFixed(1)}`))
    .filter(Boolean).join(' ');
  // Die Flaeche unter den Einnahmen reicht bis heute: die Linie, unten
  // geschlossen auf der Grundlinie (Bauart der Abo-Prognose, subscriptions.js).
  const baseY = chartY(0, 0, axis.max, geo).toFixed(1);
  const areaPoints = `${chartX(0, s.length, geo).toFixed(1)},${baseY} ${points(incomes, 0, lastPast)} ${chartX(lastPast, s.length, geo).toFixed(1)},${baseY}`;
  // DER PUNKT MIT WERT (R18): am heutigen Tag, ohne Zukunft am letzten Tag mit
  // Daten. Er traegt, was die Kurve sonst nur ueber die Achse hergab.
  let markIndex = lastPast;
  if (todayIndex < 0 && !cumulative) while (markIndex > 0 && !rawIncomes[markIndex] && !rawExpenses[markIndex]) markIndex -= 1;
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
  // Zweiter Kanal neben der Farbe (Critique P2, seit R18 ohne Strichelung): die
  // Einnahmen tragen die Flaeche, beide Serien einen beschrifteten Punkt, die
  // Legende nennt sie - so trennen sie sich auch bei Rot-Grün-Schwäche. Der
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
    const frac = chartX(i, s.length, geo) / geo.W;
    return `<button type="button" class="budget-stats__point" data-index="${i}"
              style="--point-x:${frac.toFixed(4)};--point-slots:${s.length}"
              tabindex="${i === s.length - 1 ? '0' : '-1'}"
              aria-label="${view.ctx.esc(label)}"></button>`;
  }).join('');

  // `.chart` traegt 600 / 200 als Seitenverhaeltnis (panel.css); die hoehere
  // Flaeche sagt ihres selbst an (wie die Gesundheits-Diagramme).
  const { W, H } = geo;
  const ratio = H === CHART.H ? '' : ` style="aspect-ratio: ${W} / ${H}"`;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="budget-chart-section">
      <h2 class="budget-chart-section__title">${t(cumulative ? 'budget.statsTrendTitleCumulative' : 'budget.statsTrendTitle')}</h2>
      <p class="sr-only">${view.ctx.esc(summary)}</p>
      <div class="budget-stats__card">
      <div class="budget-stats__trend-wrap">
        <div class="budget-stats__plot">
          <svg class="chart budget-stats__trend" viewBox="0 0 ${W} ${H}"${ratio} aria-hidden="true">
            <defs>
              <linearGradient id="budget-stats-area" x1="0" y1="0" x2="0" y2="1">
                <stop class="budget-stats__area-from" offset="0" />
                <stop class="budget-stats__area-to" offset="1" />
              </linearGradient>
            </defs>
            ${chartGridMarkup(0, axis.max, (val) => formatMoneyAxis(val, view.ctx.currency), geo, axis.steps)}
            ${chartXLabelsMarkup(axisLabels(s.map((p) => p.period)), geo)}
            ${todayIndex >= 0 ? todayMarkerMarkup(chartX(todayIndex, s.length, geo), geo) : ''}
            <g class="budget-stats__lines">
              <polygon class="budget-stats__area" fill="url(#budget-stats-area)" points="${areaPoints}" />
              <polyline class="budget-stats__line budget-stats__line--income" fill="none" stroke-width="2"
                        vector-effect="non-scaling-stroke" points="${points(incomes, 0, lastPast)}" />
              <polyline class="budget-stats__line budget-stats__line--expense" fill="none" stroke-width="2"
                        vector-effect="non-scaling-stroke" points="${points(expenses, 0, lastPast)}" />
              ${todayIndex >= 0 ? `
              <polyline class="budget-stats__line budget-stats__line--income budget-stats__future" fill="none" stroke-width="2"
                        vector-effect="non-scaling-stroke" points="${points(incomes, todayIndex)}" />
              <polyline class="budget-stats__line budget-stats__line--expense budget-stats__future" fill="none" stroke-width="2"
                        vector-effect="non-scaling-stroke" points="${points(expenses, todayIndex)}" />` : ''}
              ${markMarkup({ x: chartX(markIndex, s.length, geo), income: incomes[markIndex], expenses: expenses[markIndex], axisMax: axis.max, geo })}
            </g>
          </svg>
          <div class="budget-stats__points" role="group" aria-label="${t('budget.statsPointsLabel')}">${hotspots}</div>
        </div>
      </div>
      <div class="budget-stats__readout" id="budget-stats-readout" aria-hidden="true"></div>
      <div class="budget-stats__legend">
        <span class="budget-stats__legend-item"><i class="budget-stats__swatch budget-stats__swatch--income"></i>${t('budget.statsIncome')} · ${fmtAmount(sum(rawIncomes))}${totalTrend(sum(rawIncomes), comparison?.income, 'higher')}</span>
        <span class="budget-stats__legend-item"><i class="budget-stats__swatch budget-stats__swatch--expense"></i>${t('budget.statsExpenses')} · ${fmtAmount(sum(rawExpenses))}${totalTrend(sum(rawExpenses), comparison && Math.abs(comparison.expenses), 'lower')}</span>
      </div>
      </div>
    </div>`);
  // Der Gutter folgt dem breitesten Achsenwert (#1607): "₩6,000,000" ist breiter
  // als die Mindestbreite, die an "5.550 €" bemessen ist. Gemessen wird ohne
  // Aufruf von hier: `watchChartGutters()` (utils/chart.js) sieht das SVG, sobald
  // es im Dokument steht (#1722).
  if (window.lucide) lucide.createIcons({ el: host });
  wireTrendPoints(host, shown, pointKey, s);
  // Die Kurven zeichnen sich einmal ein, beim ersten Erscheinen - nicht bei
  // jedem Zeitraum (ux.js, drawChartOnce). Raster und Achse stehen.
  drawChartOnce('budget-stats-trend', { lines: host.querySelector('.budget-stats__lines') });
}

/** Die Flaeche des Verlaufs: mobil hoeher (siehe renderTrendChart). */
const TREND_CHART_NARROW = Object.freeze({ ...CHART, H: 300 });

/**
 * Die Geometrie haengt an der Breite, also zeichnet der Verlauf neu, wenn das
 * Fenster die Schwelle kreuzt (Telefon gedreht, Fenster geteilt): sonst blieb
 * die Flaeche der alten Breite stehen - 600x200 auf dem Telefon ist genau das
 * gedrungene Diagramm, das die hoehere Flaeche abloest. EIN Lauscher je
 * Modul; er meldet sich ab, sobald sein Panel aus dem Dokument ist.
 */
let trendWatch = null;
function watchTrendBreakpoint(panel) {
  const mql = globalThis.window?.matchMedia?.('(max-width: 639px)');
  if (!mql?.addEventListener) return;
  trendWatch?.mql.removeEventListener('change', trendWatch.onChange);
  const onChange = () => {
    if (!panel.isConnected) {
      mql.removeEventListener('change', onChange);
      if (trendWatch?.onChange === onChange) trendWatch = null;
      return;
    }
    renderTrendChart();
  };
  mql.addEventListener('change', onChange);
  trendWatch = { mql, onChange };
}

function trendGeometry() {
  return globalThis.window?.matchMedia?.('(max-width: 639px)')?.matches === true ? TREND_CHART_NARROW : CHART;
}

/**
 * Der Punkt, an dem die Zukunft beginnt: der Index des letzten Tages bis
 * heute. `-1`, wenn der Zeitraum keine Zukunft hat (heute ist der letzte Tag
 * oder liegt dahinter) oder ganz in ihr liegt (heute vor dem ersten Tag) -
 * dann gibt es nichts zu teilen. Tagesschluessel vergleichen sich als Text.
 * @param {string[]} periods  'YYYY-MM-DD', aufsteigend
 * @param {string} today      Tagesschluessel der Haushaltszone (todayKey())
 */
function futureStartIndex(periods, today) {
  if (!periods.length || today < periods[0] || today >= periods[periods.length - 1]) return -1;
  let index = -1;
  for (let i = 0; i < periods.length; i += 1) {
    if (periods[i] <= today) index = i;
    else break;
  }
  return index;
}

/**
 * Die ruhige Achse des Verlaufs: drei Linien, ganzzahlige Schritte (die
 * Geldachse beschriftet ohne Nachkommastellen). Regel und Begruendung stehen
 * an `calmDomain` (utils/chart.js) - die Aktivitaet der Gesundheit nutzt sie auch.
 * @param {number} max  groesster Datenwert
 * @returns {{ max: number, step: number, steps: 2 }}
 */
function calmAxis(max) {
  const { max: top, step, steps } = calmDomain(max, { integer: true });
  return { max: top, step, steps };
}

/**
 * Senkrechte Marke am heutigen Tag, das Wort UEBER der Flaeche.
 *
 * DAS WORT STEHT UEBER DER OBERSTEN LINIE, NICHT DARAUF (R18). Es hing an der
 * Oberkante des Plots (`dominant-baseline: hanging` bei PAD_T) - genau auf der
 * obersten Gitterlinie, und wo die Einnahmen am Monatsanfang schon oben
 * liefen, auch auf der Kurve: gemessen bei 390px war "Heute" durchgestrichen.
 * Jetzt sitzt es mittig ueber der Marke, eine halbe Schrifthoehe ueber der
 * Linie (`dy` in em, die Achsenschrift ist fest); das SVG zeigt seinen
 * Ueberlauf (`svg.chart`, panel.css), der Traeger haelt den Platz frei
 * (`.budget-stats__trend-wrap`, budget.css).
 */
function todayMarkerMarkup(x, geo) {
  const top = geo.PAD_T;
  const bottom = geo.H - geo.PAD_B;
  const anchor = todayAnchor(x, geo);
  return `
            <line class="budget-stats__today" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${bottom}" vector-effect="non-scaling-stroke" />
            <text class="chart__axis budget-stats__today-label" x="${x.toFixed(1)}" y="${top}" dy="-0.5em" text-anchor="${anchor}">${view.ctx.esc(t('common.today'))}</text>`;
}

/** An den Raendern steht das Wort buendig zur Marke, sonst liefe es aus dem Bild. */
function todayAnchor(x, geo) {
  if (x > geo.W - geo.PAD_R - 40) return 'end';
  if (x < geo.PAD_L + 40) return 'start';
  return 'middle';
}

/**
 * Wo die Werte der beiden Punkte stehen. Die hoehere Serie traegt ihren Wert
 * UEBER dem Punkt, die tiefere DARUNTER - so stossen die beiden nie aneinander.
 * Liegt die tiefere zu nah an der Grundlinie (unter 15 % der Achse), stuende
 * ihr Wert in der Zeile der X-Beschriftung: dann wandert er ueber den Punkt,
 * sofern zwischen beiden Punkten Platz ist (20 % der Achse), sonst entfaellt
 * er - Legende und Ableselinie nennen ihn weiter.
 * @returns {{ income: 'above'|'below'|null, expenses: 'above'|'below'|null }}
 */
function markLabelPlan(income, expenses, axisMax) {
  const hi = income >= expenses ? 'income' : 'expenses';
  const lo = hi === 'income' ? 'expenses' : 'income';
  const value = { income, expenses };
  const plan = { income: null, expenses: null };
  plan[hi] = 'above';
  if (value[lo] / axisMax >= 0.15) plan[lo] = 'below';
  else if ((value[hi] - value[lo]) / axisMax >= 0.2) plan[lo] = 'above';
  return plan;
}

/**
 * Die zwei Punkte am markierten Tag samt Wert. Jeder Punkt ist eine Linie der
 * Laenge null mit runder Kappe und `non-scaling-stroke`: so bleibt er bei jeder
 * Breite 8px gross (ein `<circle>` skalierte mit dem viewBox auf 4 bis 12px),
 * darunter derselbe in Flaechenfarbe als 2px-Ring, damit er sich von der Linie
 * loest. Die Werte tragen Textfarbe, nicht die der Serie, und einen Hof in
 * Flaechenfarbe (`paint-order`), damit keine Linie durch eine Ziffer laeuft.
 */
function markMarkup({ x, income, expenses, axisMax, geo }) {
  const plan = markLabelPlan(income, expenses, axisMax);
  // Am rechten Rand stehen die Werte links vom Punkt.
  const flip = x > geo.W - geo.PAD_R - 90;
  const dot = (series, value) => {
    const y = chartY(value, 0, axisMax, geo).toFixed(1);
    const at = `x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"`;
    const where = plan[series];
    const label = where
      ? `<text class="chart__axis budget-stats__mark-value" x="${x.toFixed(1)}" y="${y}" dx="${flip ? '-0.7em' : '0.7em'}" dy="${where === 'above' ? '-0.6em' : '1.4em'}" text-anchor="${flip ? 'end' : 'start'}">${view.ctx.esc(formatMoneyAxis(value, view.ctx.currency))}</text>`
      : '';
    return `<line class="budget-stats__mark-ring" ${at} /><line class="budget-stats__mark budget-stats__mark--${series}" ${at} />${label}`;
  };
  return [['income', income], ['expenses', expenses]].map(([series, value]) => dot(series, value)).join('');
}

/**
 * DIE ZEITACHSE SAGT NUR, WAS DER KOPF NICHT SAGT (R18). Unter einem Kopf, der
 * "Oktober 2026" nennt, stand dreimal das volle Datum ("01.10.2026"). Jetzt
 * der Tag allein ("1.", "16.", "31." - in der Schreibweise der Sprache); laeuft
 * der Zeitraum ueber eine Monatsgrenze (Woche), kommt der Monat dazu, im Jahr
 * steht der Monatsname und das Jahr nur, wenn die Reihe zwei Jahre beruehrt.
 * Ableselinie und Punkt-Labels nennen weiter das volle Datum (`periodLabel`).
 * @param {string[]} periods  'YYYY-MM-DD' oder 'YYYY-MM', aufsteigend
 */
function axisLabels(periods) {
  if (!periods.length) return [];
  const first = periods[0];
  const last = periods[periods.length - 1];
  const daily = /^\d{4}-\d{2}-\d{2}$/.test(first);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  const options = daily
    ? (first.slice(0, 7) === last.slice(0, 7) ? { day: 'numeric' } : { day: 'numeric', month: 'numeric' })
    : (sameYear ? { month: 'short' } : { month: 'short', year: '2-digit' });
  // Mittags statt Mitternacht: der Schluessel ist ein Kalendertag, kein
  // Zeitpunkt - so kippt er in keiner Zone auf den Nachbartag.
  const fmt = new Intl.DateTimeFormat(getLocale(), options);
  // DER TAG ALLEIN TRAEGT DEN PUNKT SEINER SPRACHE. Intl schreibt den Tag ohne
  // Monat als nackte Zahl ("1"), auch wo die Sprache ihn als Ordnungszahl
  // setzt ("1." in de, fi, hu). Ob sie das tut, steht im Tag-Monat-Muster:
  // folgt dem Tag dort ein Punkt, gehoert er zum Tag. Sprachen mit eigenem
  // Zeichen ("1日", "1일") bringen es schon mit und bleiben unberuehrt.
  let suffix = '';
  if (daily && options.month === undefined) {
    const parts = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2026, 0, 2, 12));
    const at = parts.findIndex((part) => part.type === 'day');
    if (parts[at + 1]?.type === 'literal' && parts[at + 1].value.startsWith('.')) suffix = '.';
  }
  return periods.map((p) => {
    const [y, m, d = 1] = p.split('-').map(Number);
    const text = fmt.format(new Date(y, m - 1, d, 12));
    return /^\d+$/.test(text) ? `${text}${suffix}` : text;
  });
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

  // `mark: false` fuer den Ausgangswert: die Ableselinie nennt ihn mit Datum,
  // aber die senkrechte Marke erscheint erst, wenn jemand zeigt, tippt oder
  // per Tastatur wandert. Ungefragt am letzten Datenpunkt stehend las sie sich
  // als "heute" (Critique 2026-10-05, R16).
  const show = (index, { focus = false, mark = true } = {}) => {
    const point = series[index];
    if (!point) return;
    buttons.forEach((b, i) => {
      b.classList.toggle('is-active', mark && i === index);
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
  show(initial, { mark: false });
}

// Der Zeitraum steht im geteilten Kopf, nicht mehr im Panel. Gemeldet wird er
// erst nach dem Laden, weil der Server die Wochengrenzen festlegt.
function updatePeriodLabel() {
  if (view.data) view.ctx.onPeriod({ from: view.data.from, to: view.data.to });
}

// Nur fuer Tests: die Farbzuordnung von Balken und Donut (R14 P8).
export const __test = { fetchStats, statsView: () => view, categoryColorIndex, DONUT_SEGMENTS, futureStartIndex, TREND_CHART_NARROW, calmAxis, markLabelPlan, todayAnchor, axisLabels };
