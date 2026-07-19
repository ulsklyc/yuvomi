/**
 * Modul: Gesundheit (Health) — Seitenmodul mit Sub-Tab-Leiste
 * Zweck: Ein Seitenmodul mit fünf Deep-Link-Routen (Übersicht, Vitalwerte,
 *        Medikamente, Laborwerte, Aktivität). render() baut Kopf + Sub-Tab-
 *        Leiste + fünf Panels; update() bedient die Soft-Navigation zwischen
 *        den Tabs (Muster wie Settings).
 *        Vitalwerte-Tab (Phase 2): Personen-Umschalter, Zeitraum-Steuerung,
 *        Karten je Metrik (letzter Wert + Delta) und native SVG-Trend-Charts —
 *        Erfassung via Shared-Modal, Aggregation via computeVitalSeries.
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js, /utils/date.js,
 *        /components/modal.js, /utils/health-vitals.js, /utils/health-tabs.js
 */

import { api } from '/api.js';
import { t, formatDate, formatTime, getLocale, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { wireScrollFade } from '/utils/ux.js';
import { toLocalDateKey, parseLocalDateKey, addLocalDays } from '/utils/date.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { computeVitalSeries, VITAL_METRICS, vitalMetric } from '/utils/health-vitals.js';
import {
  computeDueDoses, computeAdherence, refillState,
  daysMaskToIndices, indicesToDaysMask, WEEKDAY_COUNT,
} from '/utils/health-meds.js';
import {
  deriveFlag, summarizeReport, analyteNames, analyteTrend, LAB_FLAGS,
} from '/utils/health-labs.js';
import {
  ACTIVITY_TYPES, activityType, weekSummary, activityTotals,
} from '/utils/health-activity.js';
import { upcomingDoses, computeAdherenceStreak } from '/utils/health-overview.js';
import {
  FLOW_LEVELS, flowLevel, SYMPTOM_TYPES, symptomType, MOOD_TYPES, PHASE,
  predictCycle, cycleStats, buildCycleCalendar, cycleRing,
} from '/utils/health-cycle.js';
import { HEALTH_ROUTES, renderHealthTabsBar } from '/utils/health-tabs.js';

let _container = null;

// Haushaltweiter Opt-in für den Zyklus-Tab (Settings → Module → Gesundheit).
// Default an, damit Bestandshaushalte ihr Verhalten behalten; wird in render()
// aus /preferences aufgefrischt.
let cycleEnabled = true;

async function loadHealthPrefs() {
  try {
    const res = await api.get('/preferences');
    cycleEnabled = res?.data?.health_cycle_enabled !== false;
  } catch {
    cycleEnabled = true;
  }
}

// Vitalwerte-View-Zustand. Eine einzige Messungs-Liste (alle Typen) je Person;
// Karten und Chart werden clientseitig daraus abgeleitet.
const vitals = {
  meId: null,
  personId: null,
  members: [],
  rows: [],
  range: 'month',
  anchor: toLocalDateKey(new Date()),
  selectedType: 'bp',
  loaded: false,
  error: false,
  root: null,
};

const RANGE_LABELS = {
  week: 'health.vitals.range.week',
  month: 'health.vitals.range.month',
  year: 'health.vitals.range.year',
};

// Kanal-Farben (Trend-Chart). Nur Tokens — keine Wertung, rein zur Unterscheidung.
const CHANNEL_COLORS = ['var(--module-health)', 'var(--color-info)', 'var(--color-warning)'];

// Gemeinsame Chart-Geometrie: linker Gutter für Y-Wert-Labels, unterer für
// X-Datumslabels. Alle drei Health-Charts (Vitalwerte, Laborwerte, Aktivität)
// teilen denselben 600×200-viewBox und dieselben Ränder, damit sie als EIN
// lesbares System wirken statt als drei verschiedene Kurven-Kästen.
const CHART = Object.freeze({ W: 600, H: 200, PAD_L: 40, PAD_R: 12, PAD_T: 14, PAD_B: 26 });

function chartScales() {
  const { W, H, PAD_L, PAD_R, PAD_T, PAD_B } = CHART;
  return { left: PAD_L, right: W - PAD_R, top: PAD_T, bottom: H - PAD_B };
}

// Fünf horizontale Gitterlinien mit Y-Wert-Beschriftung am linken Rand — ersetzt
// die früheren zwei frei schwebenden Min-/Max-Zahlen durch eine echte Werteachse.
function chartGridMarkup(min, max) {
  const { W, PAD_L, PAD_R } = CHART;
  const { top, bottom } = chartScales();
  const out = [];
  for (let k = 0; k <= 4; k++) {
    const gy = top + (k * (bottom - top)) / 4;
    const val = max - (k * (max - min)) / 4;
    out.push(`<line class="health-chart__grid" x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${W - PAD_R}" y2="${gy.toFixed(1)}" />`);
    out.push(`<text x="${PAD_L - 6}" y="${(gy + 3.5).toFixed(1)}" class="health-chart__axis health-chart__axis--y" text-anchor="end">${esc(fmtNum(val))}</text>`);
  }
  return out.join('');
}

// X-Achsen-Datumslabels (erstes, mittleres, letztes Datum) unter dem Plot,
// an den Plotgrenzen ausgerichtet (erstes linksbündig, letztes rechtsbündig).
function chartXLabelsMarkup(dates) {
  if (!dates.length) return '';
  const { H, W, PAD_L, PAD_R } = CHART;
  const y = H - 7;
  const picks = dates.length <= 2
    ? dates.map((d, i) => ({ d, i }))
    : [dates[0], dates[Math.floor((dates.length - 1) / 2)], dates[dates.length - 1]].map((d, i) => ({ d, i }));
  return picks.map(({ d }, idx) => {
    const anchor = idx === 0 ? 'start' : idx === picks.length - 1 ? 'end' : 'middle';
    const px = anchor === 'start' ? PAD_L : anchor === 'end' ? W - PAD_R : (PAD_L + (W - PAD_R)) / 2;
    return `<text x="${px.toFixed(1)}" y="${y}" class="health-chart__axis" text-anchor="${anchor}">${esc(formatDate(d))}</text>`;
  }).join('');
}

// Panel-Definitionen je Route. Icons folgen den Sub-Tab-Icons (health-tabs.js).
const PANELS = () => [
  {
    route: '/health',
    icon: 'heart-pulse',
    titleKey: 'health.overview.title',
    emptyTitleKey: 'health.overview.emptyTitle',
    emptyDescKey: 'health.overview.emptyDesc',
  },
  {
    route: '/health/vitals',
    icon: 'activity',
    titleKey: 'health.vitals.title',
    emptyTitleKey: 'health.vitals.emptyTitle',
    emptyDescKey: 'health.vitals.emptyDesc',
  },
  {
    route: '/health/cycle',
    icon: 'droplet',
    titleKey: 'health.cycle.title',
    emptyTitleKey: 'health.cycle.emptyTitle',
    emptyDescKey: 'health.cycle.emptyDesc',
  },
  {
    route: '/health/meds',
    icon: 'pill',
    titleKey: 'health.meds.title',
    emptyTitleKey: 'health.meds.emptyTitle',
    emptyDescKey: 'health.meds.emptyDesc',
  },
  {
    route: '/health/labs',
    icon: 'flask-conical',
    titleKey: 'health.labs.title',
    emptyTitleKey: 'health.labs.emptyTitle',
    emptyDescKey: 'health.labs.emptyDesc',
  },
  {
    route: '/health/activity',
    icon: 'dumbbell',
    titleKey: 'health.activity.title',
    emptyTitleKey: 'health.activity.emptyTitle',
    emptyDescKey: 'health.activity.emptyDesc',
  },
];

function normalizeHealthPath(path) {
  // Zyklus deaktiviert → Deep-Link auf die Übersicht umleiten (kein leeres Panel).
  if (path === '/health/cycle' && !cycleEnabled) return '/health';
  return HEALTH_ROUTES.includes(path) ? path : '/health';
}

function panelMarkup(panel, activeRoute) {
  const hidden = panel.route === activeRoute ? '' : 'hidden';
  // Vitalwerte-Panel bekommt einen leeren Mount-Punkt (data-vitals-root), der von
  // mountVitals() befüllt wird; alle übrigen Panels bleiben Empty-State-Gerüste.
  const body = panel.route === '/health'
    ? '<div class="health-overview" data-overview-root></div>'
    : panel.route === '/health/vitals'
    ? '<div class="health-vitals" data-vitals-root></div>'
    : panel.route === '/health/cycle'
    ? '<div class="health-cycle" data-cycle-root></div>'
    : panel.route === '/health/meds'
    ? '<div class="health-meds" data-meds-root></div>'
    : panel.route === '/health/labs'
    ? '<div class="health-labs" data-labs-root></div>'
    : panel.route === '/health/activity'
    ? '<div class="health-activity" data-activity-root></div>'
    : `
      <div class="empty-state health-empty">
        <div class="health-empty__icon" aria-hidden="true">
          <i data-lucide="${esc(panel.icon)}"></i>
        </div>
        <div class="empty-state__title">${esc(t(panel.emptyTitleKey))}</div>
        <div class="empty-state__description">${esc(t(panel.emptyDescKey))}</div>
      </div>`;

  // Eigenes data-health-panel-Attribut statt des (per Frontend-Audit gesperrten)
  // Legacy-„data-panel". Die Sichtbarkeit steuert showPanel() lokal — renderSubTabs
  // synchronisiert bewusst keine Panels für dieses Modul.
  return `
    <section class="health-panel" data-health-panel="${esc(panel.route)}"
             role="tabpanel" aria-label="${esc(t(panel.titleKey))}" ${hidden}>
      <header class="health-panel__head">
        <h2 class="health-panel__title u-toolbar-title">${esc(t(panel.titleKey))}</h2>
      </header>
      ${body}
    </section>
  `;
}

function showPanel(activeRoute) {
  if (!_container) return;
  _container.querySelectorAll('[data-health-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.healthPanel !== activeRoute;
  });
}

// Routen-basierter Kontext-FAB: die Primäraktion folgt der aktiven Health-Route.
// Auf der Übersicht (keine Erstellen-Aktion) ausgeblendet.
let _fab = null;

function updateHealthFab(activeRoute) {
  if (!_fab) return;
  // Gating spiegelt die früheren Inline-„Hinzufügen"-Buttons: Erstellen nur in
  // der eigenen Ansicht (isOwn*View), in fremden (read-only) Ansichten kein FAB.
  switch (activeRoute) {
    case '/health/vitals':
      setPageFabAction(_fab, { hidden: !isOwnView(), label: t('health.vitals.add'), onClick: () => openVitalModal() }); break;
    case '/health/cycle':
      setPageFabAction(_fab, { hidden: !isOwnCycleView(), label: t('health.cycle.add'), onClick: () => openPeriodModal(null) }); break;
    case '/health/meds':
      setPageFabAction(_fab, { hidden: !isOwnMedsView(), label: t('health.meds.add'), onClick: () => openMedModal(null) }); break;
    case '/health/labs':
      setPageFabAction(_fab, { hidden: !isOwnLabsView(), label: t('health.labs.add'), onClick: () => openLabModal(null) }); break;
    case '/health/activity':
      setPageFabAction(_fab, { hidden: !isOwnActivityView(), label: t('health.activity.add'), onClick: () => openActivityModal(null) }); break;
    default:
      setPageFabAction(_fab, { hidden: true });
  }
}

// FAB nach Panel-Mount / Personenwechsel neu bewerten (personId steht dann fest).
function refreshHealthFab() {
  updateHealthFab(normalizeHealthPath(window.location.pathname));
}

export async function render(container, ctx = {}) {
  _container = container;
  vitals.meId = ctx.user?.id ?? vitals.meId;
  vitals.root = null;
  vitals.loaded = false;
  meds.meId = ctx.user?.id ?? meds.meId;
  meds.root = null;
  meds.loaded = false;
  labs.meId = ctx.user?.id ?? labs.meId;
  labs.root = null;
  labs.loaded = false;
  activity.meId = ctx.user?.id ?? activity.meId;
  activity.root = null;
  activity.loaded = false;
  cycle.meId = ctx.user?.id ?? cycle.meId;
  cycle.root = null;
  cycle.loaded = false;
  overview.meId = ctx.user?.id ?? overview.meId;
  overview.root = null;
  overview.loaded = false;
  await loadHealthPrefs();
  const activeRoute = normalizeHealthPath(window.location.pathname);
  const panels = PANELS().filter((panel) => cycleEnabled || panel.route !== '/health/cycle');

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="health-page">
      <h1 class="sr-only">${esc(t('nav.health'))}</h1>
      ${panels.map((panel) => panelMarkup(panel, activeRoute)).join('')}
    </div>
  `);

  _fab = createPageFab({ id: 'health-fab' });
  container.querySelector('.health-page').appendChild(_fab);

  if (window.lucide) window.lucide.createIcons({ el: container });
  showPanel(activeRoute);
  renderHealthTabsBar(container, activeRoute, { cycleEnabled });
  updateHealthFab(activeRoute);
  maybeMountOverview(activeRoute);
  maybeMountVitals(activeRoute);
  maybeMountCycle(activeRoute);
  maybeMountMeds(activeRoute);
  maybeMountLabs(activeRoute);
  maybeMountActivity(activeRoute);
}

// Soft-Navigation zwischen Health-Tabs (vom Router aufgerufen, wenn das Modul
// bereits gerendert ist). Tauscht nur die Sub-Tab-Leiste (frischer Aktiv-Zustand
// + Panel-Sync) aus — kein Full-Reload. Rückgabe false erzwingt volles Rendern.
export async function update({ path, user } = {}) {
  if (!_container?.isConnected) return false;
  if (user?.id) { vitals.meId = user.id; meds.meId = user.id; labs.meId = user.id; activity.meId = user.id; cycle.meId = user.id; overview.meId = user.id; }
  const activeRoute = normalizeHealthPath(path || window.location.pathname);

  showPanel(activeRoute);
  _container.querySelector('.sub-tabs-bar')?.remove();
  renderHealthTabsBar(_container, activeRoute, { cycleEnabled });
  updateHealthFab(activeRoute);
  maybeMountOverview(activeRoute);
  maybeMountVitals(activeRoute);
  maybeMountCycle(activeRoute);
  maybeMountMeds(activeRoute);
  maybeMountLabs(activeRoute);
  maybeMountActivity(activeRoute);
  return true;
}

// ========================================================
// VITALWERTE-TAB
// ========================================================

// Mountet den Vitalwerte-Tab beim ersten Aktivieren (oder nach Full-Render).
function maybeMountVitals(activeRoute) {
  if (activeRoute !== '/health/vitals') return;
  const root = _container?.querySelector('[data-vitals-root]');
  if (!root) return;
  if (vitals.root === root && vitals.loaded) return;
  vitals.root = root;
  mountVitals();
}

async function mountVitals() {
  vitals.root.replaceChildren();
  vitals.root.insertAdjacentHTML('beforeend',
    `<div class="health-vitals__loading">${esc(t('common.loading'))}</div>`);

  try {
    if (!vitals.members.length) {
      const res = await api.get('/family/members');
      vitals.members = res.data || [];
    }
    if (!vitals.personId) vitals.personId = vitals.meId ?? vitals.members[0]?.id ?? null;
    await loadVitals();
    vitals.error = false;
  } catch (err) {
    console.error('[Health] vitals mount error:', err);
    vitals.error = true;
  }
  vitals.loaded = true;
  renderVitalsShell();
}

async function loadVitals() {
  const query = vitals.personId ? `?user_id=${encodeURIComponent(vitals.personId)}` : '';
  const res = await api.get(`/health/vitals${query}`);
  vitals.rows = res.data || [];
}

function isOwnView() {
  return vitals.personId != null && vitals.personId === vitals.meId;
}

function renderVitalsShell() {
  if (!vitals.root?.isConnected) return;
  vitals.root.replaceChildren();

  if (vitals.error) {
    vitals.root.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${esc(t('health.vitals.loadError'))}</div>
        <div class="empty-state__description">${esc(t('health.vitals.loadErrorDesc'))}</div>
        <button class="btn btn--primary empty-state__cta" data-action="vitals-retry">
          <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
          ${esc(t('health.vitals.retry'))}
        </button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: vitals.root });
    vitals.root.querySelector('[data-action="vitals-retry"]')
      ?.addEventListener('click', () => mountVitals());
    return;
  }

  vitals.root.insertAdjacentHTML('beforeend', `
    <div class="health-persons" role="tablist" aria-label="${esc(t('health.vitals.personsLabel'))}">
      ${personChipsMarkup(vitals.members, vitals.personId, vitals.meId)}
    </div>
    ${readOnlyBannerMarkup(vitals.members, vitals.personId, isOwnView())}
    <div class="health-vitals__toolbar">
      <div class="health-vitals__ranges" role="tablist" aria-label="${esc(t('health.vitals.chartTitle'))}">
        ${['week', 'month', 'year'].map((r) => `
          <button type="button" class="health-vitals__range${r === vitals.range ? ' is-active' : ''}"
            data-range="${r}" role="tab" aria-selected="${r === vitals.range}">${esc(t(RANGE_LABELS[r]))}</button>`).join('')}
      </div>
    </div>
    <div class="health-vitals__cards" id="health-vitals-cards"></div>
    <div class="health-vitals__detail" id="health-vitals-detail"></div>
  `);
  if (window.lucide) window.lucide.createIcons({ el: vitals.root });
  wireVitals();
  refreshHealthFab();
  renderCards();
  renderDetail();
}

// Geteilter Personen-Umschalter (Vitalwerte + Medikamente): identisches Markup,
// die aktive Person und „Ich"-Markierung kommen je Tab per Argument.
function personChipsMarkup(members, activeId, meId) {
  return (members || []).map((m) => {
    const active = m.id === activeId;
    const label = m.id === meId
      ? `${m.display_name} · ${t('health.vitals.you')}`
      : m.display_name;
    return `
      <button type="button" class="health-person-chip${active ? ' is-active' : ''}"
        data-person-id="${esc(m.id)}" role="tab" aria-selected="${active}">
        <span class="health-person-chip__dot" aria-hidden="true"
          style="background:${esc(m.avatar_color) || 'var(--module-health)'}"></span>
        <span class="health-person-chip__name">${esc(label)}</span>
      </button>`;
  }).join('');
}

// Nur-Lesen-Hinweis beim Betrachten der Daten einer anderen Person. Das bloße
// Fehlen der Bearbeiten-Buttons ist leicht zu übersehen — der Banner macht den
// View-Only-Zustand explizit. Gibt '' für die eigene Ansicht zurück.
function readOnlyBannerMarkup(members, personId, own) {
  if (own) return '';
  const m = (members || []).find((x) => x.id === personId);
  const name = m ? m.display_name : '';
  return `
    <div class="health-readonly-banner" role="status">
      <i data-lucide="eye" aria-hidden="true"></i>
      <span>${esc(t('health.readOnlyBanner', { name }))}</span>
    </div>`;
}

// Medizinischer Disclaimer (kein Diagnose-Anspruch). Übersicht-Fuß + Erfassungs-
// Modals, die Werte interpretieren. `modal` unterdrückt den oberen Abstand.
function disclaimerMarkup(modal = false) {
  return `<p class="health-disclaimer${modal ? ' health-disclaimer--modal' : ''}">${esc(t('health.disclaimer'))}</p>`;
}

// Screenreader-Alternative zu den nativen SVG-Charts: eine visuell versteckte
// Tabelle mit denselben Datenpunkten. Der Chart selbst bleibt role="img" mit
// Kurz-Label; die Tabelle liefert die eigentlichen Werte. `rows` = [[c1,c2], …].
function chartTableMarkup(caption, headers, rows) {
  const head = headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('');
  const body = rows.map((cells) =>
    `<tr>${cells.map((c, i) => (i === 0
      ? `<th scope="row">${esc(c)}</th>`
      : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('');
  return `
    <table class="sr-only">
      <caption>${esc(caption)}</caption>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

// Tastatur-Navigation für die handgebauten role="tablist"-Chip-Reihen
// (Personen-Umschalter, Zeitraum-Wahl). Muster wie die geteilte Sub-Tab-Leiste,
// aber mit *manueller* Aktivierung: Pfeiltasten/Home/End bewegen nur den Fokus
// (roving tabindex), aktiviert wird per Enter/Space über den nativen Button —
// so löst nicht jeder Tastendruck einen Personen-Reload aus. Der Haupt-Tab-Balken
// (.health-tabs-bar) liegt außerhalb der Panels und bringt eigene Tastatur mit.
function wireTablistKeys(root) {
  // Personen-Chipzeile: Rand-Fade-Affordanz beim Überlaufen (geteilte
  // has-fade-*-Konvention, Audit F-06). Hier zentral, weil alle sechs Tabs
  // diesen Helfer nach jedem Panel-Render aufrufen.
  wireScrollFade(root.querySelector('.health-persons'));
  root.querySelectorAll('[role="tablist"]:not(.health-tabs-bar)').forEach((list) => {
    const tabs = () => [...list.querySelectorAll('[role="tab"]')];
    tabs().forEach((el) => { el.tabIndex = el.getAttribute('aria-selected') === 'true' ? 0 : -1; });
    list.addEventListener('keydown', (e) => {
      const KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
      if (!KEYS.includes(e.key)) return;
      const els = tabs();
      if (!els.length) return;
      const focused = els.indexOf(document.activeElement);
      const active = Math.max(0, els.findIndex((el) => el.getAttribute('aria-selected') === 'true'));
      const from = focused >= 0 ? focused : active;
      let next = from;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (from + 1) % els.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (from - 1 + els.length) % els.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = els.length - 1;
      e.preventDefault();
      els.forEach((el, i) => { el.tabIndex = i === next ? 0 : -1; });
      els[next].focus();
    });
  });
}

function wireVitals() {
  wireTablistKeys(vitals.root);
  vitals.root.querySelectorAll('.health-person-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = Number(chip.dataset.personId);
      if (id === vitals.personId) return;
      vitals.personId = id;
      switchPerson();
    }));

  vitals.root.querySelectorAll('.health-vitals__range').forEach((btn) =>
    btn.addEventListener('click', () => {
      vitals.range = btn.dataset.range;
      renderVitalsShell();
    }));

}

async function switchPerson() {
  vitals.anchor = toLocalDateKey(new Date());
  try {
    await loadVitals();
    vitals.error = false;
  } catch (err) {
    console.error('[Health] vitals load error:', err);
    vitals.error = true;
  }
  renderVitalsShell();
}

// --------------------------------------------------------
// Karten je Metrik
// --------------------------------------------------------

function renderCards() {
  const host = vitals.root.querySelector('#health-vitals-cards');
  if (!host) return;
  const cards = VITAL_METRICS.map((metric) => {
    const series = computeVitalSeries(vitals.rows, {
      type: metric.type, range: vitals.range, anchor: vitals.anchor,
    });
    return cardMarkup(metric, series);
  }).join('');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', cards);
  if (window.lucide) window.lucide.createIcons({ el: host });

  host.querySelectorAll('.health-metric-card').forEach((card) =>
    card.addEventListener('click', () => {
      vitals.selectedType = card.dataset.type;
      host.querySelectorAll('.health-metric-card').forEach((c) =>
        c.classList.toggle('is-active', c.dataset.type === vitals.selectedType));
      renderDetail();
    }));
}

function cardMarkup(metric, series) {
  const active = metric.type === vitals.selectedType;
  const latest = series.latest;
  const label = t(metric.labelKey);

  let valueHtml;
  let metaHtml = `<div class="health-metric-card__empty">${esc(t('health.vitals.noValue'))}</div>`;

  if (latest) {
    const unit = esc(latest.unit || '');
    let valueText;
    if (metric.type === 'bp') {
      valueText = `${fmtNum(latest.value_num)}/${fmtNum(latest.value_num2)}`;
    } else {
      valueText = fmtNum(latest.value_num);
    }
    valueHtml = `<span class="health-metric-card__value">${esc(valueText)}</span>${unit ? ` <span class="health-metric-card__unit">${unit}</span>` : ''}`;
    metaHtml = `
      <div class="health-metric-card__meta">
        ${deltaMarkup(series.deltas.value_num)}
        <span class="health-metric-card__date">${esc(formatDate(String(latest.measured_at).slice(0, 10)))}</span>
      </div>`;
  } else {
    valueHtml = '<span class="health-metric-card__value health-metric-card__value--empty">–</span>';
  }

  return `
    <button type="button" class="health-metric-card${active ? ' is-active' : ''}" data-type="${esc(metric.type)}"
      aria-pressed="${active}">
      <span class="health-metric-card__head">
        <i data-lucide="${esc(metric.icon)}" class="health-metric-card__icon" aria-hidden="true"></i>
        <span class="health-metric-card__label">${esc(label)}</span>
      </span>
      <span class="health-metric-card__body">${valueHtml}</span>
      ${latest ? sparklineMarkup(series.points, 'value_num') : ''}
      ${metaHtml}
    </button>`;
}

// Mini-Trendlinie für die Metrik-Karte: gibt der Karte Sub-Domänen-Charakter, ohne
// den vollen Chart zu wiederholen. Rein dekorativ (aria-hidden) — die exakten Werte
// liefern Karte, Detail-Chart und Screenreader-Tabelle. Nur bei ≥2 Datenpunkten.
function sparklineMarkup(points, key) {
  const withVal = points
    .map((p, i) => ({ v: p[key], i }))
    .filter((o) => o.v !== null && o.v !== undefined);
  if (withVal.length < 2) return '';
  const W = 100;
  const H = 26;
  const PAD = 3;
  const vals = withVal.map((o) => o.v);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const n = withVal.length;
  const x = (idx) => PAD + (idx * (W - 2 * PAD)) / (n - 1);
  const y = (v) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD);
  const pts = withVal.map((o, idx) => `${x(idx).toFixed(1)},${y(o.v).toFixed(1)}`).join(' ');
  const lastX = x(n - 1).toFixed(1);
  const lastY = y(withVal[n - 1].v).toFixed(1);
  return `<svg class="health-metric-card__spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="var(--module-accent)" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      <circle cx="${lastX}" cy="${lastY}" r="2" fill="var(--module-accent)" vector-effect="non-scaling-stroke" />
    </svg>`;
}

function deltaMarkup(delta) {
  if (delta === null || delta === undefined) return '<span class="health-metric-card__delta"></span>';
  const icon = delta > 0 ? 'trending-up' : (delta < 0 ? 'trending-down' : 'minus');
  const dir = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
  return `
    <span class="health-metric-card__delta health-metric-card__delta--${dir}">
      <i data-lucide="${icon}" aria-hidden="true"></i>${esc(fmtDelta(delta))}
    </span>`;
}

// --------------------------------------------------------
// Detail: Trend-Chart der ausgewählten Metrik
// --------------------------------------------------------

function renderDetail() {
  const host = vitals.root.querySelector('#health-vitals-detail');
  if (!host) return;
  const metric = vitalMetric(vitals.selectedType) || VITAL_METRICS[0];
  const series = computeVitalSeries(vitals.rows, {
    type: metric.type, range: vitals.range, anchor: vitals.anchor,
  });

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <div class="health-chart-section">
      <div class="health-chart-section__head">
        <div class="health-chart-section__title">${esc(t(metric.labelKey))}</div>
        <div class="health-vitals__stepper">
          <button class="btn btn--icon" data-step="-1" aria-label="${esc(t('health.vitals.prevPeriod'))}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
          <span class="health-vitals__period">${esc(`${formatDate(series.from)} – ${formatDate(series.to)}`)}</span>
          <button class="btn btn--icon" data-step="1" aria-label="${esc(t('health.vitals.nextPeriod'))}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
        </div>
      </div>
      ${series.hasData ? chartMarkup(metric, series) : `
        <div class="empty-state health-chart-empty">
          <div class="empty-state__title">${esc(t('health.vitals.noData'))}</div>
        </div>`}
    </div>`);
  if (window.lucide) window.lucide.createIcons({ el: host });

  host.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      stepAnchor(Number(btn.dataset.step));
      renderVitalsShell();
    }));
}

function stepAnchor(dir) {
  if (vitals.range === 'week') {
    vitals.anchor = addLocalDays(vitals.anchor, 7 * dir);
    return;
  }
  const d = parseLocalDateKey(vitals.anchor);
  if (vitals.range === 'month') d.setMonth(d.getMonth() + dir);
  else d.setFullYear(d.getFullYear() + dir);
  vitals.anchor = toLocalDateKey(d);
}

function chartMarkup(metric, series) {
  const pts = series.points;

  // Aktive Kanäle: die, die im Zeitraum mindestens einen Wert tragen.
  const channels = metric.channels
    .map((key, idx) => ({ key, idx }))
    .filter(({ key }) => pts.some((p) => p[key] !== null));
  if (!channels.length) {
    return `<div class="empty-state health-chart-empty"><div class="empty-state__title">${esc(t('health.vitals.noData'))}</div></div>`;
  }

  // Buckets mit mindestens einem Messwert. Weniger als zwei ergeben keine Kurve —
  // dann ein ehrlicher Low-Data-Hinweis statt eines einzelnen Punkts im Leerraum.
  const dataIdx = pts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => channels.some(({ key }) => p[key] !== null))
    .map(({ i }) => i);
  if (dataIdx.length < 2) {
    return `<div class="empty-state health-chart-empty"><div class="empty-state__title">${esc(t('health.vitals.sparse'))}</div></div>`;
  }

  const allValues = channels.flatMap(({ key }) => pts.map((p) => p[key]).filter((v) => v !== null));
  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const pad = span * 0.1;
  min -= pad; max += pad;

  const { W, H } = CHART;
  const { left, right, top, bottom } = chartScales();
  // X-Domäne an die tatsächliche Datenspanne klemmen (erster bis letzter Bucket mit
  // Wert), damit dünne Daten die volle Breite nutzen statt mittig zusammenzukleben.
  const firstIdx = dataIdx[0];
  const lastIdx = dataIdx[dataIdx.length - 1];
  const x = (i) => left + ((i - firstIdx) * (right - left)) / (lastIdx - firstIdx);
  const y = (v) => bottom - ((v - min) / (max - min)) * (bottom - top);

  // Flächenfüllung nur bei Einzelkanal-Metriken (Gewicht, Glukose …). Bei Blutdruck
  // (drei Kurven) würde ein Füllband die Linien verschlucken — dort bewusst keine.
  let area = '';
  if (channels.length === 1) {
    const key = channels[0].key;
    const vp = pts.map((p, i) => ({ p, i })).filter(({ p }) => p[key] !== null);
    if (vp.length >= 2) {
      const spine = vp.map(({ p, i }) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
      const x0 = x(vp[0].i).toFixed(1);
      const x1 = x(vp[vp.length - 1].i).toFixed(1);
      area = `<polygon class="health-chart__area" points="${x0},${bottom.toFixed(1)} ${spine} ${x1},${bottom.toFixed(1)}" />`;
    }
  }

  const seriesSvg = channels.map(({ key, idx }) => {
    const color = CHANNEL_COLORS[idx % CHANNEL_COLORS.length];
    const chName = metric.channelLabelKeys?.[idx] ? t(metric.channelLabelKeys[idx]) : t(metric.labelKey);
    const linePts = [];
    const dots = [];
    pts.forEach((p, i) => {
      if (p[key] === null) return;
      const px = x(i).toFixed(1);
      const py = y(p[key]).toFixed(1);
      linePts.push(`${px},${py}`);
      dots.push(`<circle cx="${px}" cy="${py}" r="3.5" fill="${color}"><title>${esc(`${chName} · ${formatDate(p.date)}: ${fmtNum(p[key])}`)}</title></circle>`);
    });
    return `
      <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"
        stroke-linecap="round" points="${linePts.join(' ')}" />
      ${dots.join('')}`;
  }).join('');

  const legend = metric.channels.length > 1
    ? `<div class="health-chart__legend">${channels.map(({ key, idx }) => `
        <span class="health-chart__legend-item">
          <i class="health-chart__swatch" style="background:${CHANNEL_COLORS[idx % CHANNEL_COLORS.length]}"></i>
          ${esc(t(metric.channelLabelKeys[idx]))}
        </span>`).join('')}</div>`
    : '';

  const grid = chartGridMarkup(min, max);

  // Screenreader-Datentabelle: nur Buckets mit mindestens einem Wert.
  const chLabel = (idx) => (metric.channelLabelKeys?.[idx] ? t(metric.channelLabelKeys[idx]) : t(metric.labelKey));
  const tableHeaders = [t('health.vitals.field.measuredAt'), ...channels.map(({ idx }) => chLabel(idx))];
  const dataPoints = pts.filter((p) => channels.some(({ key }) => p[key] !== null));
  const tableRows = dataPoints
    .map((p) => [formatDate(p.date), ...channels.map(({ key }) => (p[key] !== null ? fmtNum(p[key]) : '–'))]);
  const table = tableRows.length ? chartTableMarkup(t(metric.labelKey), tableHeaders, tableRows) : '';
  const xLabels = chartXLabelsMarkup(dataPoints.map((p) => p.date));

  return `
    <svg class="health-chart" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="${esc(t(metric.labelKey))}">
      ${grid}
      ${area}
      ${seriesSvg}
      ${xLabels}
    </svg>
    ${table}
    ${legend}`;
}

// --------------------------------------------------------
// Erfassungs-Modal
// --------------------------------------------------------

function localDateTimeValue(date) {
  const key = toLocalDateKey(date);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${key}T${hh}:${mm}`;
}

function valueFieldsMarkup(type) {
  const metric = vitalMetric(type) || VITAL_METRICS[0];
  if (type === 'bp') {
    return `
      <div class="modal-grid modal-grid--3">
        <div class="form-field">
          <label class="label" for="vital-sys">${esc(t('health.vitals.field.systolic'))}</label>
          <input class="input" id="vital-sys" type="number" inputmode="numeric" step="1" min="0" required>
        </div>
        <div class="form-field">
          <label class="label" for="vital-dia">${esc(t('health.vitals.field.diastolic'))}</label>
          <input class="input" id="vital-dia" type="number" inputmode="numeric" step="1" min="0" required>
        </div>
        <div class="form-field">
          <label class="label" for="vital-pulse">${esc(t('health.vitals.field.pulse'))}</label>
          <input class="input" id="vital-pulse" type="number" inputmode="numeric" step="1" min="0">
        </div>
      </div>`;
  }
  const unitField = metric.units.length > 1
    ? `
      <div class="form-field">
        <label class="label" for="vital-unit">${esc(t('health.vitals.field.unit'))}</label>
        <select class="input" id="vital-unit">
          ${metric.units.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('')}
        </select>
      </div>`
    : `<input type="hidden" id="vital-unit" value="${esc(metric.units[0])}">`;
  return `
    <div class="modal-grid modal-grid--2">
      <div class="form-field">
        <label class="label" for="vital-value">${esc(t('health.vitals.field.value'))}</label>
        <input class="input" id="vital-value" type="number" inputmode="decimal" step="any" required>
      </div>
      ${unitField}
    </div>`;
}

function openVitalModal(opts = {}) {
  const now = new Date();
  const typeOptions = VITAL_METRICS.map((m) =>
    `<option value="${esc(m.type)}"${m.type === vitals.selectedType ? ' selected' : ''}>${esc(t(m.labelKey))}</option>`).join('');

  openModal({
    title: t('health.vitals.add'),
    size: 'md',
    content: `
      <form id="vital-form" class="form-stack">
        <div class="form-field">
          <label class="label" for="vital-type">${esc(t('health.vitals.field.type'))}</label>
          <select class="input" id="vital-type">${typeOptions}</select>
        </div>
        <div id="vital-value-fields">${valueFieldsMarkup(vitals.selectedType)}</div>
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="vital-measured-at">${esc(t('health.vitals.field.measuredAt'))}</label>
            <yuvomi-datepicker id="vital-measured-at" type="datetime" value="${esc(localDateTimeValue(now))}"></yuvomi-datepicker>
          </div>
          <div class="form-field">
            <label class="label" for="vital-visibility">${esc(t('health.vitals.field.visibility'))}</label>
            <select class="input" id="vital-visibility">
              <option value="private">${esc(t('health.vitals.visibility.private'))}</option>
              <option value="family">${esc(t('health.vitals.visibility.family'))}</option>
            </select>
          </div>
        </div>
        <div class="form-field">
          <label class="label" for="vital-note">${esc(t('health.vitals.field.note'))}</label>
          <textarea class="input" id="vital-note" rows="2" maxlength="2000"></textarea>
        </div>
        ${disclaimerMarkup(true)}
        <div class="modal-actions">
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      const form = panel.querySelector('#vital-form');
      const typeSelect = panel.querySelector('#vital-type');
      const fieldsHost = panel.querySelector('#vital-value-fields');

      typeSelect.addEventListener('change', () => {
        fieldsHost.replaceChildren();
        fieldsHost.insertAdjacentHTML('beforeend', valueFieldsMarkup(typeSelect.value));
      });

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('[type="submit"]');
        const body = collectVitalBody(panel, typeSelect.value);
        if (!body) {
          submitBtn.disabled = false;
          window.yuvomi?.showToast(t('health.vitals.invalidValue'), 'danger');
          return;
        }
        submitBtn.disabled = true;
        try {
          await api.post('/health/vitals', body);
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.vitals.saved'), 'success');
          await reloadAfterSave(body.type);
          await opts.onSaved?.();
        } catch (err) {
          console.error('[Health] vitals save error:', err);
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.vitals.saveError'), 'danger');
        }
      });
    },
  });
}

function numOrNull(input) {
  if (!input || input.value.trim() === '') return null;
  const n = Number(input.value);
  return Number.isFinite(n) ? n : NaN;
}

function collectVitalBody(panel, type) {
  const measuredAt = panel.querySelector('#vital-measured-at')?.value;
  const visibility = panel.querySelector('#vital-visibility')?.value || 'private';
  const note = panel.querySelector('#vital-note')?.value.trim() || undefined;
  if (!measuredAt) return null;

  const body = { type, measured_at: measuredAt, visibility, note };

  if (type === 'bp') {
    const sys = numOrNull(panel.querySelector('#vital-sys'));
    const dia = numOrNull(panel.querySelector('#vital-dia'));
    const pulse = numOrNull(panel.querySelector('#vital-pulse'));
    if (sys === null || Number.isNaN(sys) || dia === null || Number.isNaN(dia)) return null;
    if (Number.isNaN(pulse)) return null;
    body.value_num = sys;
    body.value_num2 = dia;
    if (pulse !== null) body.value_num3 = pulse;
    body.unit = 'mmHg';
  } else {
    const value = numOrNull(panel.querySelector('#vital-value'));
    if (value === null || Number.isNaN(value)) return null;
    body.value_num = value;
    body.unit = panel.querySelector('#vital-unit')?.value || undefined;
  }
  return body;
}

async function reloadAfterSave(savedType) {
  vitals.selectedType = savedType;
  vitals.anchor = toLocalDateKey(new Date());
  try {
    await loadVitals();
    vitals.error = false;
  } catch (err) {
    console.error('[Health] vitals reload error:', err);
    vitals.error = true;
  }
  renderVitalsShell();
}

// --------------------------------------------------------
// Zahlen-/Delta-Formatierung (lokalisiert)
// --------------------------------------------------------

function fmtNum(value, opts) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '–';
  return getNumberFormat({ maximumFractionDigits: 1, ...opts }).format(Number(value));
}

function fmtDelta(value) {
  if (value === null || value === undefined) return '';
  return getNumberFormat({ maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(value);
}

// ========================================================
// MEDIKAMENTE-TAB
// ========================================================

// Medikamente-View-Zustand. Je Person: Medikamentenliste + Einnahmepläne + Logs
// (Zeitraum für Adherence). „Heute fällig", Adherence und Bestand werden
// clientseitig aus computeDueDoses/computeAdherence/refillState abgeleitet.
const meds = {
  meId: null,
  personId: null,
  members: [],
  list: [],
  schedulesByMed: {},
  logsByMed: {},
  loaded: false,
  error: false,
  root: null,
  adherenceDays: 7,
};

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// Vollständige i18n-Keys als Konstante — der Frontend-Audit extrahiert String-
// Literale direkt aus Übersetzungsaufrufen; ein konkatenierter Präfix würde als
// fehlender Key beanstandet, daher hier die kompletten Keys vorberechnen.
const WEEKDAY_LABEL_KEYS = WEEKDAY_KEYS.map((k) => `health.meds.weekday.${k}`);

function maybeMountMeds(activeRoute) {
  if (activeRoute !== '/health/meds') return;
  const root = _container?.querySelector('[data-meds-root]');
  if (!root) return;
  if (meds.root === root && meds.loaded) return;
  meds.root = root;
  mountMeds();
}

async function mountMeds() {
  meds.root.replaceChildren();
  meds.root.insertAdjacentHTML('beforeend',
    `<div class="health-meds__loading">${esc(t('common.loading'))}</div>`);

  try {
    if (!meds.members.length) {
      const res = await api.get('/family/members');
      meds.members = res.data || [];
    }
    if (!meds.personId) meds.personId = meds.meId ?? meds.members[0]?.id ?? null;
    await loadMeds();
    meds.error = false;
  } catch (err) {
    console.error('[Health] meds mount error:', err);
    meds.error = true;
  }
  meds.loaded = true;
  renderMedsShell();
}

async function loadMeds() {
  const query = meds.personId ? `?user_id=${encodeURIComponent(meds.personId)}` : '';
  const res = await api.get(`/health/medications${query}`);
  meds.list = res.data || [];
  meds.schedulesByMed = {};
  meds.logsByMed = {};

  const today = toLocalDateKey(new Date());
  const from = addLocalDays(today, -(meds.adherenceDays - 1));
  await Promise.all(meds.list.map(async (m) => {
    const [sRes, lRes] = await Promise.all([
      api.get(`/health/medications/${m.id}/schedules`),
      api.get(`/health/medications/${m.id}/logs?from=${from}T00:00&to=${today}T23:59`),
    ]);
    meds.schedulesByMed[m.id] = sRes.data || [];
    meds.logsByMed[m.id] = lRes.data || [];
  }));
}

function isOwnMedsView() {
  return meds.personId != null && meds.personId === meds.meId;
}

function allSchedules() {
  return meds.list.flatMap((m) => meds.schedulesByMed[m.id] || []);
}

function allLogsInRange(from, to) {
  const out = [];
  for (const m of meds.list) {
    for (const l of (meds.logsByMed[m.id] || [])) {
      const key = String(l.scheduled_at || l.taken_at || l.created_at || '').slice(0, 10);
      if (key >= from && key <= to) out.push(l);
    }
  }
  return out;
}

function findLogForDose(dose) {
  return (meds.logsByMed[dose.medicationId] || []).find(
    (l) => l.schedule_id === dose.scheduleId && l.scheduled_at === dose.scheduledAt
  ) || null;
}

function renderMedsShell() {
  if (!meds.root?.isConnected) return;
  meds.root.replaceChildren();

  if (meds.error) {
    meds.root.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${esc(t('health.meds.loadError'))}</div>
        <div class="empty-state__description">${esc(t('health.meds.loadErrorDesc'))}</div>
        <button class="btn btn--primary empty-state__cta" data-action="meds-retry">
          <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
          ${esc(t('health.meds.retry'))}
        </button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: meds.root });
    meds.root.querySelector('[data-action="meds-retry"]')?.addEventListener('click', () => mountMeds());
    return;
  }

  meds.root.insertAdjacentHTML('beforeend', `
    <div class="health-persons" role="tablist" aria-label="${esc(t('health.meds.personsLabel'))}">
      ${personChipsMarkup(meds.members, meds.personId, meds.meId)}
    </div>
    ${readOnlyBannerMarkup(meds.members, meds.personId, isOwnMedsView())}
    <div class="health-meds__toolbar">
      <h3 class="health-meds__section-title u-toolbar-title">${esc(t('health.meds.dueToday.title'))}</h3>
    </div>
    <div class="health-meds__due">${dueTodayMarkup()}</div>
    <div class="health-meds__adherence-wrap">${adherenceMarkup()}</div>
    <h3 class="health-meds__section-title u-toolbar-title">${esc(t('health.meds.title'))}</h3>
    <div class="health-meds__list" id="health-meds-list">${medListMarkup()}</div>
  `);
  if (window.lucide) window.lucide.createIcons({ el: meds.root });
  wireMeds();
  refreshHealthFab();
}

function dueTodayMarkup() {
  const today = toLocalDateKey(new Date());
  const due = computeDueDoses(allSchedules(), { from: today, to: today });
  if (!due.length) {
    return `<div class="health-meds__due-empty">${esc(t('health.meds.dueToday.empty'))}</div>`;
  }
  const rows = due.map((dose) => {
    const med = meds.list.find((m) => m.id === dose.medicationId);
    return dueRowMarkup(dose, med, findLogForDose(dose));
  }).join('');
  return `<ul class="health-meds__due-list">${rows}</ul>`;
}

function dueRowMarkup(dose, med, log) {
  const name = med ? med.name : '';
  const status = log?.status;
  const own = isOwnMedsView();
  const doseText = dose.dose_qty != null ? ` · ${fmtNum(dose.dose_qty)}` : '';

  let actions;
  if (status === 'taken') {
    actions = `<span class="health-dose__status health-dose__status--taken"><i data-lucide="check" aria-hidden="true"></i>${esc(t('health.meds.status.taken'))}</span>`;
  } else if (status === 'skipped') {
    actions = `<span class="health-dose__status health-dose__status--skipped"><i data-lucide="x" aria-hidden="true"></i>${esc(t('health.meds.status.skipped'))}</span>`;
  } else if (own) {
    const data = `data-med-id="${esc(dose.medicationId)}" data-schedule-id="${esc(dose.scheduleId ?? '')}" data-scheduled-at="${esc(dose.scheduledAt)}" data-log-id="${esc(log?.id ?? '')}" data-dose="${esc(dose.dose_qty ?? '')}"`;
    actions = `
      <div class="health-dose__actions">
        <button type="button" class="btn btn--sm btn--primary" data-dose-take ${data}>${esc(t('health.meds.take'))}</button>
        <button type="button" class="btn btn--sm btn--ghost" data-dose-skip ${data}>${esc(t('health.meds.skip'))}</button>
      </div>`;
  } else {
    actions = `<span class="health-dose__status">${esc(t('health.meds.status.pending'))}</span>`;
  }

  return `
    <li class="health-dose">
      <span class="health-dose__time">${esc(dose.time)}</span>
      <span class="health-dose__name">${esc(name)}${esc(doseText)}</span>
      ${actions}
    </li>`;
}

function adherenceMarkup() {
  const today = toLocalDateKey(new Date());
  const from = addLocalDays(today, -(meds.adherenceDays - 1));
  const planned = computeDueDoses(allSchedules(), { from, to: today }).length;
  const a = computeAdherence(allLogsInRange(from, today), planned);

  const head = `
    <div class="health-adherence__head">
      <span class="health-adherence__title">${esc(t('health.meds.adherence.title'))}</span>
      <span class="health-adherence__period">${esc(t('health.meds.adherence.period', { days: meds.adherenceDays }))}</span>
    </div>`;

  if (a.rate === null) {
    return `<div class="health-adherence">${head}
      <div class="health-adherence__empty">${esc(t('health.meds.adherence.noData'))}</div></div>`;
  }
  // Geplant, aber noch nichts protokolliert: KEIN großes rotes „0 %" — das liest
  // sich als Vorwurf. Stattdessen ein neutraler Frühzustand (Adherence-Scham vermeiden).
  if (a.taken === 0) {
    return `<div class="health-adherence">${head}
      <div class="health-adherence__empty">${esc(t('health.meds.adherence.notStarted'))}</div></div>`;
  }
  const pct = Math.round(a.rate * 100);
  return `
    <div class="health-adherence">
      ${head}
      <div class="health-adherence__value">${esc(fmtNum(pct))}%</div>
      <div class="health-adherence__bar"><span style="width:${pct}%"></span></div>
      <div class="health-adherence__summary">${esc(t('health.meds.adherence.summary', { taken: a.taken, planned: a.planned }))}</div>
    </div>`;
}

function medListMarkup() {
  if (!meds.list.length) {
    return `<div class="health-meds__empty">${esc(t('health.meds.noMeds'))}</div>`;
  }
  return meds.list.map(medCardMarkup).join('');
}

function medCardMarkup(med) {
  const rf = refillState(med);
  const subtitle = [med.dosage_text, med.form].filter(Boolean).join(' · ');
  const own = isOwnMedsView();

  const badges = [];
  if (!med.active) badges.push(`<span class="health-med-badge health-med-badge--muted">${esc(t('health.meds.badge.inactive'))}</span>`);
  if (med.prn) badges.push(`<span class="health-med-badge">${esc(t('health.meds.badge.prn'))}</span>`);

  let stockHtml = '';
  if (rf.level !== 'none') {
    const unit = med.stock_unit ? ` ${esc(med.stock_unit)}` : '';
    const warn = rf.below;
    const warnLabel = rf.level === 'out' ? t('health.meds.stock.out') : t('health.meds.stock.low');
    stockHtml = `
      <div class="health-med-card__stock${warn ? ' is-warn' : ''}">
        <i data-lucide="package" aria-hidden="true"></i>
        <span>${esc(t('health.meds.stock.label'))}: ${esc(fmtNum(rf.stock))}${unit}</span>
        ${warn ? `<span class="health-med-card__refill"><i data-lucide="alert-triangle" aria-hidden="true"></i>${esc(warnLabel)}</span>` : ''}
      </div>`;
  }

  const tag = own ? 'button' : 'div';
  const attrs = own ? `type="button" data-med-edit="${esc(med.id)}"` : '';
  return `
    <${tag} class="health-med-card${med.active ? '' : ' is-inactive'}" ${attrs}>
      <div class="health-med-card__head">
        <span class="health-med-card__name">${esc(med.name)}</span>
        <span class="health-med-card__badges">${badges.join('')}</span>
      </div>
      ${subtitle ? `<div class="health-med-card__sub">${esc(subtitle)}</div>` : ''}
      ${stockHtml}
    </${tag}>`;
}

function wireMeds() {
  wireTablistKeys(meds.root);
  meds.root.querySelectorAll('.health-person-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = Number(chip.dataset.personId);
      if (id === meds.personId) return;
      meds.personId = id;
      switchMedsPerson();
    }));


  meds.root.querySelectorAll('[data-med-edit]').forEach((card) =>
    card.addEventListener('click', () => {
      const id = Number(card.dataset.medEdit);
      const med = meds.list.find((m) => m.id === id);
      if (med) openMedModal(med);
    }));

  meds.root.querySelectorAll('[data-dose-take]').forEach((btn) =>
    btn.addEventListener('click', () => handleDose(btn, 'take')));
  meds.root.querySelectorAll('[data-dose-skip]').forEach((btn) =>
    btn.addEventListener('click', () => handleDose(btn, 'skip')));
}

async function switchMedsPerson() {
  try {
    await loadMeds();
    meds.error = false;
  } catch (err) {
    console.error('[Health] meds load error:', err);
    meds.error = true;
  }
  renderMedsShell();
}

async function reloadMeds() {
  try {
    await loadMeds();
    meds.error = false;
  } catch (err) {
    console.error('[Health] meds reload error:', err);
    meds.error = true;
  }
  renderMedsShell();
}

async function handleDose(btn, action) {
  const medId = Number(btn.dataset.medId);
  const logId = btn.dataset.logId ? Number(btn.dataset.logId) : null;
  const scheduleId = btn.dataset.scheduleId ? Number(btn.dataset.scheduleId) : null;
  const scheduledAt = btn.dataset.scheduledAt || null;
  const dose = btn.dataset.dose !== '' ? Number(btn.dataset.dose) : null;

  btn.disabled = true;
  try {
    if (logId) {
      await api.post(`/health/logs/${logId}/${action}`, {});
    } else {
      const body = { status: action === 'take' ? 'taken' : 'skipped' };
      if (scheduledAt) body.scheduled_at = scheduledAt;
      if (scheduleId) body.schedule_id = scheduleId;
      if (dose != null && Number.isFinite(dose)) body.dose_qty = dose;
      if (action === 'take') body.taken_at = new Date().toISOString();
      await api.post(`/health/medications/${medId}/logs`, body);
    }

    // Bestand runterzählen bei „genommen" (nur wenn Bestand erfasst + Dosis bekannt).
    if (action === 'take' && dose != null && Number.isFinite(dose)) {
      const med = meds.list.find((m) => m.id === medId);
      if (med && med.stock_qty != null) {
        const next = Math.max(0, Number(med.stock_qty) - dose);
        await api.patch(`/health/medications/${medId}`, { stock_qty: next });
      }
    }

    window.yuvomi?.showToast(t('health.meds.doseSaved'), 'success');
    await reloadMeds();
  } catch (err) {
    console.error('[Health] dose error:', err);
    btn.disabled = false;
    window.yuvomi?.showToast(err?.data?.error || t('health.meds.doseError'), 'danger');
  }
}

// --------------------------------------------------------
// Medikament-Modal (Anlegen/Bearbeiten inkl. Einnahmeplan)
// --------------------------------------------------------

function openMedModal(med) {
  const isEdit = Boolean(med && med.id);
  const val = (v) => (v == null ? '' : String(v));

  openModal({
    title: isEdit ? t('health.meds.edit') : t('health.meds.add'),
    size: 'md',
    content: `
      <form id="med-form" class="form-stack">
        <div class="form-field">
          <label class="label" for="med-name">${esc(t('health.meds.field.name'))}</label>
          <input class="input" id="med-name" type="text" maxlength="200" required value="${esc(val(med?.name))}">
        </div>
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="med-dosage">${esc(t('health.meds.field.dosageText'))}</label>
            <input class="input" id="med-dosage" type="text" maxlength="100" value="${esc(val(med?.dosage_text))}">
          </div>
          <div class="form-field">
            <label class="label" for="med-form-field">${esc(t('health.meds.field.form'))}</label>
            <input class="input" id="med-form-field" type="text" maxlength="30" value="${esc(val(med?.form))}">
          </div>
        </div>
        <div class="modal-grid modal-grid--3">
          <div class="form-field">
            <label class="label" for="med-stock">${esc(t('health.meds.field.stockQty'))}</label>
            <input class="input" id="med-stock" type="number" inputmode="decimal" step="any" min="0" value="${esc(val(med?.stock_qty))}">
          </div>
          <div class="form-field">
            <label class="label" for="med-stock-unit">${esc(t('health.meds.field.stockUnit'))}</label>
            <input class="input" id="med-stock-unit" type="text" maxlength="30" value="${esc(val(med?.stock_unit))}">
          </div>
          <div class="form-field">
            <label class="label" for="med-refill">${esc(t('health.meds.field.refillThreshold'))}</label>
            <input class="input" id="med-refill" type="number" inputmode="decimal" step="any" min="0" value="${esc(val(med?.refill_threshold))}">
          </div>
        </div>
        <div class="modal-grid modal-grid--2">
          <label class="health-check">
            <input type="checkbox" id="med-active" ${med == null || med.active ? 'checked' : ''}>
            <span>${esc(t('health.meds.field.active'))}</span>
          </label>
          <label class="health-check">
            <input type="checkbox" id="med-prn" ${med?.prn ? 'checked' : ''}>
            <span>${esc(t('health.meds.field.prn'))}</span>
          </label>
        </div>
        <div class="form-field">
          <label class="label" for="med-visibility">${esc(t('health.meds.field.visibility'))}</label>
          <select class="input" id="med-visibility">
            <option value="private" ${med?.visibility === 'family' ? '' : 'selected'}>${esc(t('health.meds.visibility.private'))}</option>
            <option value="family" ${med?.visibility === 'family' ? 'selected' : ''}>${esc(t('health.meds.visibility.family'))}</option>
          </select>
        </div>
        <div class="form-field">
          <label class="label" for="med-note">${esc(t('health.meds.field.note'))}</label>
          <textarea class="input" id="med-note" rows="2" maxlength="5000">${esc(val(med?.note))}</textarea>
        </div>

        <div class="health-sched">
          <span class="label">${esc(t('health.meds.schedule.title'))}</span>
          <div id="med-sched-editor"></div>
        </div>

        <div class="modal-actions">
          ${isEdit ? `<button type="button" class="btn btn--danger btn--ghost" data-action="med-delete">${esc(t('common.delete'))}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      renderSchedEditor(panel, med);
      if (window.lucide) window.lucide.createIcons({ el: panel });

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="med-delete"]')?.addEventListener('click', () => deleteMed(med));

      panel.querySelector('#med-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const body = collectMedBody(panel);
        if (!body) {
          window.yuvomi?.showToast(t('health.meds.nameRequired'), 'danger');
          return;
        }
        submitBtn.disabled = true;
        try {
          if (isEdit) await api.patch(`/health/medications/${med.id}`, body);
          else await api.post('/health/medications', body);
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.meds.saved'), 'success');
          await reloadMeds();
        } catch (err) {
          console.error('[Health] med save error:', err);
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.meds.saveError'), 'danger');
        }
      });
    },
  });
}

function collectMedBody(panel) {
  const name = panel.querySelector('#med-name')?.value.trim();
  if (!name) return null;

  const num = (sel) => {
    const raw = panel.querySelector(sel)?.value;
    return raw !== '' && raw != null ? Number(raw) : null;
  };
  const str = (sel) => panel.querySelector(sel)?.value?.trim() || undefined;

  return {
    name,
    dosage_text: str('#med-dosage'),
    form: str('#med-form-field'),
    stock_qty: num('#med-stock'),
    stock_unit: str('#med-stock-unit'),
    refill_threshold: num('#med-refill'),
    note: str('#med-note'),
    visibility: panel.querySelector('#med-visibility')?.value || 'private',
    active: panel.querySelector('#med-active')?.checked ? 1 : 0,
    prn: panel.querySelector('#med-prn')?.checked ? 1 : 0,
  };
}

async function deleteMed(med) {
  if (!med?.id) return;
  if (!(await confirmModal(t('health.meds.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') }))) return;
  try {
    await api.delete(`/health/medications/${med.id}`);
    closeModal({ force: true });
    window.yuvomi?.showToast(t('health.meds.deleted'), 'success');
    await reloadMeds();
  } catch (err) {
    console.error('[Health] med delete error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.meds.deleteError'), 'danger');
  }
}

// Zeichnet den Einnahmeplan-Editor im Modal (Liste + Hinzufügen-Formular) und
// verdrahtet ihn. Für ein noch nicht gespeichertes Medikament nur ein Hinweis.
function renderSchedEditor(panel, med) {
  const host = panel.querySelector('#med-sched-editor');
  if (!host) return;
  host.replaceChildren();

  if (!med || !med.id) {
    host.insertAdjacentHTML('beforeend',
      `<div class="health-sched-hint">${esc(t('health.meds.schedule.newHint'))}</div>`);
    return;
  }

  const schedules = meds.schedulesByMed[med.id] || [];
  const list = schedules.length
    ? `<ul class="health-sched-list">${schedules.map(schedRowMarkup).join('')}</ul>`
    : `<div class="health-sched-empty">${esc(t('health.meds.schedule.none'))}</div>`;

  host.insertAdjacentHTML('beforeend', `
    ${list}
    <div class="health-sched-add">
      <div class="modal-grid modal-grid--2">
        <div class="form-field">
          <label class="label" for="sched-time">${esc(t('health.meds.schedule.time'))}</label>
          <yuvomi-datepicker id="sched-time" type="time" value="08:00"></yuvomi-datepicker>
        </div>
        <div class="form-field">
          <label class="label" for="sched-dose">${esc(t('health.meds.schedule.dose'))}</label>
          <input class="input" id="sched-dose" type="number" inputmode="decimal" step="any" min="0">
        </div>
      </div>
      <div class="form-field">
        <span class="label">${esc(t('health.meds.schedule.days'))}</span>
        <div class="health-weekday-toggle" id="sched-days">
          ${WEEKDAY_KEYS.map((k, i) => `
            <button type="button" class="health-weekday is-active" data-day="${i}" aria-pressed="true">${esc(t(WEEKDAY_LABEL_KEYS[i]))}</button>`).join('')}
        </div>
      </div>
      <button type="button" class="btn btn--secondary btn--sm" data-action="sched-add">
        <i data-lucide="plus" aria-hidden="true"></i>${esc(t('health.meds.schedule.add'))}
      </button>
    </div>`);
  if (window.lucide) window.lucide.createIcons({ el: host });
  wireSchedEditor(panel, med);
}

function schedRowMarkup(s) {
  const indices = daysMaskToIndices(s.days_mask);
  const daysLabel = (s.days_mask == null || indices.length === WEEKDAY_COUNT)
    ? t('health.meds.schedule.daily')
    : indices.map((i) => t(WEEKDAY_LABEL_KEYS[i])).join(', ');
  const doseText = s.dose_qty != null ? ` · ${fmtNum(s.dose_qty)}` : '';
  return `
    <li class="health-sched-row" data-schedule-id="${esc(s.id)}">
      <span class="health-sched-row__time">${esc(s.time_of_day)}</span>
      <span class="health-sched-row__days">${esc(daysLabel)}${esc(doseText)}</span>
      <button type="button" class="btn btn--icon btn--sm" data-sched-del="${esc(s.id)}"
        aria-label="${esc(t('health.meds.schedule.delete'))}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
    </li>`;
}

function wireSchedEditor(panel, med) {
  const host = panel.querySelector('#med-sched-editor');

  host.querySelectorAll('.health-weekday').forEach((btn) =>
    btn.addEventListener('click', () => {
      const on = btn.classList.toggle('is-active');
      btn.setAttribute('aria-pressed', String(on));
    }));

  host.querySelector('[data-action="sched-add"]')?.addEventListener('click', async (e) => {
    const addBtn = e.currentTarget;
    const time = host.querySelector('#sched-time')?.value;
    if (!time) { window.yuvomi?.showToast(t('health.meds.schedule.timeRequired'), 'danger'); return; }
    const doseRaw = host.querySelector('#sched-dose')?.value;
    const indices = [...host.querySelectorAll('.health-weekday.is-active')].map((b) => Number(b.dataset.day));

    const body = { time_of_day: time, days_mask: indicesToDaysMask(indices) };
    if (doseRaw !== '' && doseRaw != null) body.dose_qty = Number(doseRaw);

    addBtn.disabled = true;
    try {
      const res = await api.post(`/health/medications/${med.id}/schedules`, body);
      const created = res.data;
      meds.schedulesByMed[med.id] = [...(meds.schedulesByMed[med.id] || []), created];
      renderSchedEditor(panel, med);
    } catch (err) {
      console.error('[Health] schedule add error:', err);
      addBtn.disabled = false;
      window.yuvomi?.showToast(err?.data?.error || t('health.meds.saveError'), 'danger');
    }
  });

  host.querySelectorAll('[data-sched-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.schedDel);
      btn.disabled = true;
      try {
        await api.delete(`/health/schedules/${id}`);
        meds.schedulesByMed[med.id] = (meds.schedulesByMed[med.id] || []).filter((s) => s.id !== id);
        renderSchedEditor(panel, med);
      } catch (err) {
        console.error('[Health] schedule delete error:', err);
        btn.disabled = false;
        window.yuvomi?.showToast(err?.data?.error || t('health.meds.saveError'), 'danger');
      }
    }));
}

// ========================================================
// LABORWERTE-TAB
// ========================================================

// Laborwerte-View-Zustand. Je Person die Befund-Liste (jeweils inkl. results[]);
// Kennzahlen (Analyten-Anzahl/Auffälligkeiten) und der Analyt-Trend werden
// clientseitig aus summarizeReport/analyteTrend abgeleitet.
const labs = {
  meId: null,
  personId: null,
  members: [],
  reports: [],
  selectedReportId: null,
  trendAnalyte: null,
  loaded: false,
  error: false,
  root: null,
};

// Flag-Label-Keys als vollständige Konstanten (kein Konkatenieren in t() — der
// Frontend-Audit extrahiert String-Literale direkt aus Übersetzungsaufrufen).
const LAB_FLAG_LABEL_KEYS = {
  low: 'health.labs.flag.low',
  normal: 'health.labs.flag.normal',
  high: 'health.labs.flag.high',
};

function maybeMountLabs(activeRoute) {
  if (activeRoute !== '/health/labs') return;
  const root = _container?.querySelector('[data-labs-root]');
  if (!root) return;
  if (labs.root === root && labs.loaded) return;
  labs.root = root;
  mountLabs();
}

async function mountLabs() {
  labs.root.replaceChildren();
  labs.root.insertAdjacentHTML('beforeend',
    `<div class="health-labs__loading">${esc(t('common.loading'))}</div>`);

  try {
    if (!labs.members.length) {
      const res = await api.get('/family/members');
      labs.members = res.data || [];
    }
    if (!labs.personId) labs.personId = labs.meId ?? labs.members[0]?.id ?? null;
    await loadLabs();
    labs.error = false;
  } catch (err) {
    console.error('[Health] labs mount error:', err);
    labs.error = true;
  }
  labs.loaded = true;
  renderLabsShell();
}

async function loadLabs() {
  const query = labs.personId ? `?user_id=${encodeURIComponent(labs.personId)}` : '';
  const res = await api.get(`/health/labs${query}`);
  labs.reports = res.data || [];
  // Auswahl/Trend-Analyt an die neue Liste angleichen.
  if (!labs.reports.some((r) => r.id === labs.selectedReportId)) {
    labs.selectedReportId = labs.reports[0]?.id ?? null;
  }
  const names = analyteNames(labs.reports);
  if (!names.includes(labs.trendAnalyte)) labs.trendAnalyte = names[0] ?? null;
}

function isOwnLabsView() {
  return labs.personId != null && labs.personId === labs.meId;
}

function selectedReport() {
  return labs.reports.find((r) => r.id === labs.selectedReportId) || null;
}

async function switchLabsPerson() {
  labs.selectedReportId = null;
  labs.trendAnalyte = null;
  try {
    await loadLabs();
    labs.error = false;
  } catch (err) {
    console.error('[Health] labs load error:', err);
    labs.error = true;
  }
  renderLabsShell();
}

async function reloadLabs() {
  try {
    await loadLabs();
    labs.error = false;
  } catch (err) {
    console.error('[Health] labs reload error:', err);
    labs.error = true;
  }
  renderLabsShell();
}

function renderLabsShell() {
  if (!labs.root?.isConnected) return;
  labs.root.replaceChildren();

  if (labs.error) {
    labs.root.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${esc(t('health.labs.loadError'))}</div>
        <div class="empty-state__description">${esc(t('health.labs.loadErrorDesc'))}</div>
        <button class="btn btn--primary empty-state__cta" data-action="labs-retry">
          <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
          ${esc(t('health.labs.retry'))}
        </button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: labs.root });
    labs.root.querySelector('[data-action="labs-retry"]')?.addEventListener('click', () => mountLabs());
    return;
  }

  labs.root.insertAdjacentHTML('beforeend', `
    <div class="health-persons" role="tablist" aria-label="${esc(t('health.labs.personsLabel'))}">
      ${personChipsMarkup(labs.members, labs.personId, labs.meId)}
    </div>
    ${readOnlyBannerMarkup(labs.members, labs.personId, isOwnLabsView())}
    <div class="health-labs__toolbar">
      <h3 class="health-labs__section-title u-toolbar-title">${esc(t('health.labs.reportsTitle'))}</h3>
    </div>
    <div class="health-labs__list" id="health-labs-list">${labReportListMarkup()}</div>
    <div class="health-labs__detail" id="health-labs-detail">${labDetailMarkup()}</div>
  `);
  if (window.lucide) window.lucide.createIcons({ el: labs.root });
  wireLabs();
  refreshHealthFab();
}

function labReportListMarkup() {
  if (!labs.reports.length) {
    return `<div class="health-labs__empty">${esc(t('health.labs.noReports'))}</div>`;
  }
  return labs.reports.map(labReportCardMarkup).join('');
}

function labReportCardMarkup(report) {
  const sum = summarizeReport(report);
  const active = report.id === labs.selectedReportId;
  const dateLabel = formatDate(String(report.report_date).slice(0, 10));
  const countLabel = t('health.labs.analyteCount', { count: sum.total });
  const abnormalBadge = sum.hasAbnormal
    ? `<span class="health-lab-badge health-lab-badge--warn">
         <i data-lucide="alert-triangle" aria-hidden="true"></i>${esc(t('health.labs.abnormalBadge', { count: sum.abnormal }))}
       </span>`
    : '';

  return `
    <button type="button" class="health-lab-card${active ? ' is-active' : ''}" data-report-id="${esc(report.id)}"
      aria-pressed="${active}">
      <span class="health-lab-card__head">
        <span class="health-lab-card__date">${esc(dateLabel)}</span>
        ${abnormalBadge}
      </span>
      ${report.lab_name ? `<span class="health-lab-card__name">${esc(report.lab_name)}</span>` : ''}
      <span class="health-lab-card__count">${esc(countLabel)}</span>
    </button>`;
}

function labDetailMarkup() {
  const report = selectedReport();
  if (!report) {
    return `<div class="health-labs__detail-empty">${esc(t('health.labs.selectHint'))}</div>`;
  }

  const own = isOwnLabsView();
  const results = Array.isArray(report.results) ? report.results : [];
  const dateLabel = formatDate(String(report.report_date).slice(0, 10));

  const table = results.length
    ? `
      <div class="health-lab-table-wrap">
        <table class="health-lab-table">
          <thead>
            <tr>
              <th scope="col">${esc(t('health.labs.col.analyte'))}</th>
              <th scope="col">${esc(t('health.labs.col.value'))}</th>
              <th scope="col">${esc(t('health.labs.col.reference'))}</th>
              <th scope="col">${esc(t('health.labs.col.flag'))}</th>
            </tr>
          </thead>
          <tbody>${results.map(resultRowMarkup).join('')}</tbody>
        </table>
      </div>`
    : `<div class="health-labs__detail-empty">${esc(t('health.labs.noAnalytes'))}</div>`;

  return `
    <div class="health-lab-detail">
      <div class="health-lab-detail__head">
        <div class="health-lab-detail__title">
          <span class="health-lab-detail__date">${esc(dateLabel)}</span>
          ${report.lab_name ? `<span class="health-lab-detail__lab">${esc(report.lab_name)}</span>` : ''}
        </div>
        ${own ? `
          <button type="button" class="btn btn--ghost btn--sm" data-action="lab-edit" data-report-id="${esc(report.id)}">
            <i data-lucide="pencil" aria-hidden="true"></i>${esc(t('health.labs.edit'))}
          </button>` : ''}
      </div>
      ${report.note ? `<div class="health-lab-detail__note">${esc(report.note)}</div>` : ''}
      ${table}
      ${labTrendMarkup()}
    </div>`;
}

function resultRowMarkup(r) {
  const unit = r.unit ? ` ${esc(r.unit)}` : '';
  const refText = referenceLabel(r.ref_low, r.ref_high);
  return `
    <tr>
      <td class="health-lab-table__analyte">${esc(r.analyte)}</td>
      <td class="health-lab-table__value">${esc(fmtNum(r.value_num))}${unit}</td>
      <td class="health-lab-table__ref">${esc(refText)}</td>
      <td class="health-lab-table__flag">${flagIndicatorMarkup(r.flag)}</td>
    </tr>`;
}

function referenceLabel(refLow, refHigh) {
  const low = refLow == null ? null : fmtNum(refLow);
  const high = refHigh == null ? null : fmtNum(refHigh);
  if (low !== null && high !== null) return `${low} – ${high}`;
  if (low !== null) return `≥ ${low}`;
  if (high !== null) return `≤ ${high}`;
  return '–';
}

function flagIndicatorMarkup(flag) {
  if (!flag || !LAB_FLAGS.includes(flag)) {
    return '<span class="health-lab-flag health-lab-flag--none">–</span>';
  }
  const icon = flag === 'low' ? 'arrow-down' : (flag === 'high' ? 'arrow-up' : 'check');
  return `
    <span class="health-lab-flag health-lab-flag--${esc(flag)}">
      <i data-lucide="${icon}" aria-hidden="true"></i>${esc(t(LAB_FLAG_LABEL_KEYS[flag]))}
    </span>`;
}

// --------------------------------------------------------
// Trend eines wiederkehrenden Analyten (native SVG-Kurve)
// --------------------------------------------------------

function labTrendMarkup() {
  const names = analyteNames(labs.reports);
  if (names.length === 0) return '';
  const selected = names.includes(labs.trendAnalyte) ? labs.trendAnalyte : names[0];
  const points = analyteTrend(labs.reports, selected);

  const options = names.map((n) =>
    `<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(n)}</option>`).join('');

  const body = points.length >= 2
    ? labTrendChart(points, selected)
    : `<div class="health-labs__detail-empty">${esc(t('health.labs.trend.tooFew'))}</div>`;

  return `
    <div class="health-lab-trend">
      <div class="health-lab-trend__head">
        <span class="health-lab-trend__title">${esc(t('health.labs.trend.title'))}</span>
        <label class="health-lab-trend__select">
          <span class="sr-only">${esc(t('health.labs.trend.analyte'))}</span>
          <select class="input" id="health-lab-trend-analyte">${options}</select>
        </label>
      </div>
      ${body}
    </div>`;
}

function labTrendChart(points, analyteName) {
  const { W, H } = CHART;
  const { left, right, top: pTop, bottom: pBottom } = chartScales();
  const n = points.length;

  // Referenzbereich (Normalband). Erster nicht-leerer Wert je Grenze — in der
  // Praxis über Befunde konstant. Fließt in die Skala ein, damit das Band sichtbar ist.
  const refLow = points.find((p) => p.refLow != null)?.refLow ?? null;
  const refHigh = points.find((p) => p.refHigh != null)?.refHigh ?? null;

  const domain = points.map((p) => p.value);
  if (refLow != null) domain.push(refLow);
  if (refHigh != null) domain.push(refHigh);
  let min = Math.min(...domain);
  let max = Math.max(...domain);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const pad = span * 0.1;
  min -= pad; max += pad;

  const x = (i) => left + (n <= 1 ? 0 : (i * (right - left)) / (n - 1));
  const y = (v) => pBottom - ((v - min) / (max - min)) * (pBottom - pTop);

  // Referenzband: gefülltes Rechteck zwischen ref_low und ref_high, sonst eine
  // einzelne gestrichelte Grenzlinie.
  let band = '';
  if (refLow != null && refHigh != null) {
    const yHigh = y(refHigh);
    const yLow = y(refLow);
    const top = Math.min(yHigh, yLow);
    const h = Math.abs(yLow - yHigh);
    band = `
      <rect class="health-chart__band" x="${left}" y="${top.toFixed(1)}" width="${(right - left).toFixed(1)}" height="${h.toFixed(1)}" />
      <line class="health-chart__band-line" x1="${left}" y1="${yHigh.toFixed(1)}" x2="${right}" y2="${yHigh.toFixed(1)}" />
      <line class="health-chart__band-line" x1="${left}" y1="${yLow.toFixed(1)}" x2="${right}" y2="${yLow.toFixed(1)}" />`;
  } else if (refLow != null || refHigh != null) {
    const yr = y(refLow != null ? refLow : refHigh);
    band = `<line class="health-chart__band-line" x1="${left}" y1="${yr.toFixed(1)}" x2="${right}" y2="${yr.toFixed(1)}" />`;
  }

  const unit = points.find((p) => p.unit)?.unit || '';
  const ariaLabel = unit ? `${analyteName} (${unit})` : analyteName;

  const linePts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => {
    const color = FLAG_DOT_COLORS[p.flag] || 'var(--module-health)';
    const val = unit ? `${fmtNum(p.value)} ${unit}` : fmtNum(p.value);
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(`${formatDate(p.date)}: ${val}`)}</title></circle>`;
  }).join('');

  // Screenreader-Tabelle: Datum, Wert, Referenz, Einordnung — dieselben Daten wie
  // die Punkt-Farben, aber vorlesbar.
  const refText = (lo, hi) => {
    if (lo != null && hi != null) return `${fmtNum(lo)}–${fmtNum(hi)}`;
    if (lo != null) return `≥ ${fmtNum(lo)}`;
    if (hi != null) return `≤ ${fmtNum(hi)}`;
    return '–';
  };
  const tableRows = points.map((p) => [
    formatDate(p.date),
    unit ? `${fmtNum(p.value)} ${unit}` : fmtNum(p.value),
    refText(p.refLow, p.refHigh),
    p.flag ? t(LAB_FLAG_LABEL_KEYS[p.flag]) : '–',
  ]);
  const table = chartTableMarkup(
    ariaLabel,
    [t('health.labs.field.reportDate'), t('health.labs.col.value'), t('health.labs.col.reference'), t('health.labs.col.flag')],
    tableRows,
  );

  const grid = chartGridMarkup(min, max);
  const xLabels = chartXLabelsMarkup(points.map((p) => p.date));

  return `
    <svg class="health-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">
      ${grid}
      ${band}
      <polyline fill="none" stroke="var(--module-health)" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round" points="${linePts}" />
      ${dots}
      ${xLabels}
    </svg>
    ${table}
    ${unit ? `<div class="health-lab-trend__unit">${esc(t('health.labs.trend.unit', { unit }))}</div>` : ''}`;
}

// Punkt-Farben je Flag — nur Tokens, farbcodiert wie die Tabelle.
const FLAG_DOT_COLORS = {
  low: 'var(--color-info)',
  normal: 'var(--color-success)',
  high: 'var(--color-danger)',
};

function wireLabs() {
  wireTablistKeys(labs.root);
  labs.root.querySelectorAll('.health-person-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = Number(chip.dataset.personId);
      if (id === labs.personId) return;
      labs.personId = id;
      switchLabsPerson();
    }));


  labs.root.querySelectorAll('.health-lab-card').forEach((card) =>
    card.addEventListener('click', () => {
      const id = Number(card.dataset.reportId);
      if (id === labs.selectedReportId) return;
      labs.selectedReportId = id;
      renderLabsShell();
    }));

  labs.root.querySelector('[data-action="lab-edit"]')?.addEventListener('click', (e) => {
    const id = Number(e.currentTarget.dataset.reportId);
    const report = labs.reports.find((r) => r.id === id);
    if (report) openLabModal(report);
  });

  labs.root.querySelector('#health-lab-trend-analyte')?.addEventListener('change', (e) => {
    labs.trendAnalyte = e.target.value;
    const host = labs.root.querySelector('#health-labs-detail');
    if (!host) return;
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', labDetailMarkup());
    if (window.lucide) window.lucide.createIcons({ el: host });
    wireLabsDetail();
  });
}

// Verdrahtet nur die Detail-internen Steuerelemente neu (nach Trend-Wechsel).
function wireLabsDetail() {
  labs.root.querySelector('[data-action="lab-edit"]')?.addEventListener('click', (e) => {
    const id = Number(e.currentTarget.dataset.reportId);
    const report = labs.reports.find((r) => r.id === id);
    if (report) openLabModal(report);
  });
  labs.root.querySelector('#health-lab-trend-analyte')?.addEventListener('change', (e) => {
    labs.trendAnalyte = e.target.value;
    const host = labs.root.querySelector('#health-labs-detail');
    if (!host) return;
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', labDetailMarkup());
    if (window.lucide) window.lucide.createIcons({ el: host });
    wireLabsDetail();
  });
}

// --------------------------------------------------------
// Befund-Modal (Kopf-Felder + Analyt-Editor)
// --------------------------------------------------------

function openLabModal(report) {
  const isEdit = Boolean(report && report.id);
  const val = (v) => (v == null ? '' : String(v));
  const dateValue = isEdit
    ? String(report.report_date).slice(0, 10)
    : toLocalDateKey(new Date());

  openModal({
    title: isEdit ? t('health.labs.edit') : t('health.labs.add'),
    size: 'md',
    content: `
      <form id="lab-form" class="form-stack">
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="lab-date">${esc(t('health.labs.field.reportDate'))}</label>
            <yuvomi-datepicker id="lab-date" type="date" value="${esc(dateValue)}"></yuvomi-datepicker>
          </div>
          <div class="form-field">
            <label class="label" for="lab-name">${esc(t('health.labs.field.labName'))}</label>
            <input class="input" id="lab-name" type="text" maxlength="200" value="${esc(val(report?.lab_name))}">
          </div>
        </div>
        <div class="form-field">
          <label class="label" for="lab-visibility">${esc(t('health.labs.field.visibility'))}</label>
          <select class="input" id="lab-visibility">
            <option value="private" ${report?.visibility === 'family' ? '' : 'selected'}>${esc(t('health.labs.visibility.private'))}</option>
            <option value="family" ${report?.visibility === 'family' ? 'selected' : ''}>${esc(t('health.labs.visibility.family'))}</option>
          </select>
        </div>
        <div class="form-field">
          <label class="label" for="lab-note">${esc(t('health.labs.field.note'))}</label>
          <textarea class="input" id="lab-note" rows="2" maxlength="5000">${esc(val(report?.note))}</textarea>
        </div>

        <div class="health-results">
          <span class="label">${esc(t('health.labs.results.title'))}</span>
          <div id="lab-results-editor"></div>
        </div>

        ${disclaimerMarkup(true)}
        <div class="modal-actions">
          ${isEdit ? `<button type="button" class="btn btn--danger btn--ghost" data-action="lab-delete">${esc(t('common.delete'))}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      renderResultEditor(panel, report);
      if (window.lucide) window.lucide.createIcons({ el: panel });

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="lab-delete"]')?.addEventListener('click', () => deleteLabReport(report));

      panel.querySelector('#lab-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const body = collectLabHead(panel);
        if (!body) {
          window.yuvomi?.showToast(t('health.labs.dateRequired'), 'danger');
          return;
        }
        submitBtn.disabled = true;
        try {
          if (isEdit) {
            await api.patch(`/health/labs/${report.id}`, body);
          } else {
            const created = await api.post('/health/labs', body);
            // Neu angelegten Befund direkt selektieren, damit das Detail nicht
            // beim zuvor gewählten Befund stehen bleibt.
            if (created?.data?.id != null) labs.selectedReportId = created.data.id;
          }
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.labs.saved'), 'success');
          await reloadLabs();
        } catch (err) {
          console.error('[Health] lab save error:', err);
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.labs.saveError'), 'danger');
        }
      });
    },
  });
}

function collectLabHead(panel) {
  const reportDate = panel.querySelector('#lab-date')?.value;
  if (!reportDate) return null;
  const str = (sel) => panel.querySelector(sel)?.value.trim() || undefined;
  return {
    report_date: reportDate,
    lab_name: str('#lab-name'),
    note: str('#lab-note'),
    visibility: panel.querySelector('#lab-visibility')?.value || 'private',
  };
}

async function deleteLabReport(report) {
  if (!report?.id) return;
  if (!(await confirmModal(t('health.labs.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') }))) return;
  try {
    await api.delete(`/health/labs/${report.id}`);
    closeModal({ force: true });
    window.yuvomi?.showToast(t('health.labs.deleted'), 'success');
    if (labs.selectedReportId === report.id) labs.selectedReportId = null;
    await reloadLabs();
  } catch (err) {
    console.error('[Health] lab delete error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.labs.deleteError'), 'danger');
  }
}

// Zeichnet den Analyt-Editor im Modal (Liste + Hinzufügen-Formular mit Flag-
// Vorschau) und verdrahtet ihn. Für einen noch nicht gespeicherten Befund nur
// ein Hinweis (Analyten über die nested-Endpunkte, wie beim Einnahmeplan).
function renderResultEditor(panel, report) {
  const host = panel.querySelector('#lab-results-editor');
  if (!host) return;
  host.replaceChildren();

  if (!report || !report.id) {
    host.insertAdjacentHTML('beforeend',
      `<div class="health-results-hint">${esc(t('health.labs.results.newHint'))}</div>`);
    return;
  }

  const results = Array.isArray(report.results) ? report.results : [];
  const list = results.length
    ? `<ul class="health-results-list">${results.map(resultEditRowMarkup).join('')}</ul>`
    : `<div class="health-results-empty">${esc(t('health.labs.results.none'))}</div>`;

  host.insertAdjacentHTML('beforeend', `
    ${list}
    <div class="health-results-add">
      <div class="modal-grid modal-grid--2">
        <div class="form-field">
          <label class="label" for="res-analyte">${esc(t('health.labs.results.analyte'))}</label>
          <input class="input" id="res-analyte" type="text" maxlength="120">
        </div>
        <div class="form-field">
          <label class="label" for="res-value">${esc(t('health.labs.results.value'))}</label>
          <input class="input" id="res-value" type="number" inputmode="decimal" step="any">
        </div>
      </div>
      <div class="modal-grid modal-grid--3">
        <div class="form-field">
          <label class="label" for="res-unit">${esc(t('health.labs.results.unit'))}</label>
          <input class="input" id="res-unit" type="text" maxlength="30">
        </div>
        <div class="form-field">
          <label class="label" for="res-ref-low">${esc(t('health.labs.results.refLow'))}</label>
          <input class="input" id="res-ref-low" type="number" inputmode="decimal" step="any">
        </div>
        <div class="form-field">
          <label class="label" for="res-ref-high">${esc(t('health.labs.results.refHigh'))}</label>
          <input class="input" id="res-ref-high" type="number" inputmode="decimal" step="any">
        </div>
      </div>
      <div class="health-results-preview" id="res-flag-preview" aria-live="polite"></div>
      <button type="button" class="btn btn--secondary btn--sm" data-action="res-add">
        <i data-lucide="plus" aria-hidden="true"></i>${esc(t('health.labs.results.add'))}
      </button>
    </div>`);
  if (window.lucide) window.lucide.createIcons({ el: host });
  wireResultEditor(panel, report);
}

function resultEditRowMarkup(r) {
  const unit = r.unit ? ` ${esc(r.unit)}` : '';
  return `
    <li class="health-results-row" data-result-id="${esc(r.id)}">
      <span class="health-results-row__analyte">${esc(r.analyte)}</span>
      <span class="health-results-row__value">${esc(fmtNum(r.value_num))}${unit}</span>
      <span class="health-results-row__flag">${flagIndicatorMarkup(r.flag)}</span>
      <button type="button" class="btn btn--icon btn--sm" data-result-del="${esc(r.id)}"
        aria-label="${esc(t('health.labs.results.delete'))}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
    </li>`;
}

function wireResultEditor(panel, report) {
  const host = panel.querySelector('#lab-results-editor');

  const preview = host.querySelector('#res-flag-preview');
  const valueEl = host.querySelector('#res-value');
  const lowEl = host.querySelector('#res-ref-low');
  const highEl = host.querySelector('#res-ref-high');

  const updatePreview = () => {
    if (!preview) return;
    const flag = deriveFlag(valueEl?.value, lowEl?.value, highEl?.value);
    preview.replaceChildren();
    if (flag) {
      preview.insertAdjacentHTML('beforeend',
        `<span class="health-results-preview__label">${esc(t('health.labs.results.flagPreview'))}</span>${flagIndicatorMarkup(flag)}`);
      if (window.lucide) window.lucide.createIcons({ el: preview });
    }
  };
  [valueEl, lowEl, highEl].forEach((el) => el?.addEventListener('input', updatePreview));

  host.querySelector('[data-action="res-add"]')?.addEventListener('click', async (e) => {
    const addBtn = e.currentTarget;
    const analyte = host.querySelector('#res-analyte')?.value.trim();
    const valueRaw = valueEl?.value;
    if (!analyte) { window.yuvomi?.showToast(t('health.labs.results.analyteRequired'), 'danger'); return; }
    if (valueRaw === '' || valueRaw == null || !Number.isFinite(Number(valueRaw))) {
      window.yuvomi?.showToast(t('health.labs.results.valueRequired'), 'danger'); return;
    }

    const body = { analyte, value_num: Number(valueRaw) };
    const unit = host.querySelector('#res-unit')?.value.trim();
    if (unit) body.unit = unit;
    if (lowEl?.value !== '' && lowEl?.value != null) body.ref_low = Number(lowEl.value);
    if (highEl?.value !== '' && highEl?.value != null) body.ref_high = Number(highEl.value);

    addBtn.disabled = true;
    try {
      const res = await api.post(`/health/labs/${report.id}/results`, body);
      report.results = [...(report.results || []), res.data];
      renderResultEditor(panel, report);
      syncLabsAfterResultChange();
    } catch (err) {
      console.error('[Health] lab result add error:', err);
      addBtn.disabled = false;
      window.yuvomi?.showToast(err?.data?.error || t('health.labs.saveError'), 'danger');
    }
  });

  host.querySelectorAll('[data-result-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.resultDel);
      btn.disabled = true;
      try {
        await api.delete(`/health/results/${id}`);
        report.results = (report.results || []).filter((r) => r.id !== id);
        renderResultEditor(panel, report);
        syncLabsAfterResultChange();
      } catch (err) {
        console.error('[Health] lab result delete error:', err);
        btn.disabled = false;
        window.yuvomi?.showToast(err?.data?.error || t('health.labs.saveError'), 'danger');
      }
    }));
}

// Aktualisiert die komplette Labs-Shell (hinter dem Modal) live nach Analyt-
// Änderung, ohne Netz-Reload — der report ist bereits Teil labs.reports, sein
// results[] wurde in-place mutiert. So bleiben Karten-Anzahl/Auffälligkeits-Badge
// und Detail-Tabelle synchron.
function syncLabsAfterResultChange() {
  const names = analyteNames(labs.reports);
  if (!names.includes(labs.trendAnalyte)) labs.trendAnalyte = names[0] ?? null;
  renderLabsShell();
}

// ========================================================
// AKTIVITÄT-TAB
// ========================================================

// Aktivität-View-Zustand. Je Person eine Trainingseinheiten-Liste; die
// Wochenübersicht (Summen + Balken-Chart) und das Log werden clientseitig aus
// weekSummary/activityTotals über den gewählten Wochen-Anker abgeleitet.
const activity = {
  meId: null,
  personId: null,
  members: [],
  rows: [],
  anchor: toLocalDateKey(new Date()),
  loaded: false,
  error: false,
  root: null,
};

// Wochentags-Label-Keys (Mo–So) als vollständige Konstanten — der Frontend-Audit
// extrahiert String-Literale direkt aus t()-Aufrufen; ein konkatenierter Präfix
// (z. B. `health.activity.weekday.` + var) würde als fehlender Key beanstandet.
const ACTIVITY_WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ACTIVITY_WEEKDAY_LABEL_KEYS = ACTIVITY_WEEKDAY_KEYS.map((k) => `health.activity.weekday.${k}`);

function maybeMountActivity(activeRoute) {
  if (activeRoute !== '/health/activity') return;
  const root = _container?.querySelector('[data-activity-root]');
  if (!root) return;
  if (activity.root === root && activity.loaded) return;
  activity.root = root;
  mountActivity();
}

async function mountActivity() {
  activity.root.replaceChildren();
  activity.root.insertAdjacentHTML('beforeend',
    `<div class="health-activity__loading">${esc(t('common.loading'))}</div>`);

  try {
    if (!activity.members.length) {
      const res = await api.get('/family/members');
      activity.members = res.data || [];
    }
    if (!activity.personId) activity.personId = activity.meId ?? activity.members[0]?.id ?? null;
    await loadActivity();
    activity.error = false;
  } catch (err) {
    console.error('[Health] activity mount error:', err);
    activity.error = true;
  }
  activity.loaded = true;
  renderActivityShell();
}

async function loadActivity() {
  const query = activity.personId ? `?user_id=${encodeURIComponent(activity.personId)}` : '';
  const res = await api.get(`/health/activities${query}`);
  activity.rows = res.data || [];
}

function isOwnActivityView() {
  return activity.personId != null && activity.personId === activity.meId;
}

async function switchActivityPerson() {
  activity.anchor = toLocalDateKey(new Date());
  try {
    await loadActivity();
    activity.error = false;
  } catch (err) {
    console.error('[Health] activity load error:', err);
    activity.error = true;
  }
  renderActivityShell();
}

async function reloadActivity() {
  try {
    await loadActivity();
    activity.error = false;
  } catch (err) {
    console.error('[Health] activity reload error:', err);
    activity.error = true;
  }
  renderActivityShell();
}

function stepActivityWeek(dir) {
  activity.anchor = addLocalDays(activity.anchor, 7 * dir);
}

// Einheiten der gewählten Woche, absteigend chronologisch (neueste zuerst).
function activityWeekRows(range) {
  return activity.rows
    .filter((r) => {
      const dk = String(r.performed_at).slice(0, 10);
      return dk >= range.from && dk <= range.to;
    })
    .sort((a, b) => {
      const ka = String(a.performed_at);
      const kb = String(b.performed_at);
      if (ka === kb) return (b.id || 0) - (a.id || 0);
      return ka < kb ? 1 : -1;
    });
}

function renderActivityShell() {
  if (!activity.root?.isConnected) return;
  activity.root.replaceChildren();

  if (activity.error) {
    activity.root.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${esc(t('health.activity.loadError'))}</div>
        <div class="empty-state__description">${esc(t('health.activity.loadErrorDesc'))}</div>
        <button class="btn btn--primary empty-state__cta" data-action="activity-retry">
          <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
          ${esc(t('health.activity.retry'))}
        </button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: activity.root });
    activity.root.querySelector('[data-action="activity-retry"]')?.addEventListener('click', () => mountActivity());
    return;
  }

  const summary = weekSummary(activity.rows, { anchor: activity.anchor, weekStartsOn: 1 });
  const weekRows = activityWeekRows(summary);
  const totals = activityTotals(weekRows);

  activity.root.insertAdjacentHTML('beforeend', `
    <div class="health-persons" role="tablist" aria-label="${esc(t('health.activity.personsLabel'))}">
      ${personChipsMarkup(activity.members, activity.personId, activity.meId)}
    </div>
    ${readOnlyBannerMarkup(activity.members, activity.personId, isOwnActivityView())}
    <div class="health-activity__toolbar">
      <div class="health-activity__stepper">
        <button class="btn btn--icon" data-step="-1" aria-label="${esc(t('health.activity.prevWeek'))}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
        <span class="health-activity__period">${esc(`${formatDate(summary.from)} – ${formatDate(summary.to)}`)}</span>
        <button class="btn btn--icon" data-step="1" aria-label="${esc(t('health.activity.nextWeek'))}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
      </div>
    </div>
    <div class="health-activity__summary">${activityStatsMarkup(totals)}</div>
    <div class="health-activity__chart">${activityChartMarkup(summary)}</div>
    <div class="health-activity__log">${activityLogMarkup(weekRows)}</div>
  `);
  if (window.lucide) window.lucide.createIcons({ el: activity.root });
  wireActivity();
  refreshHealthFab();
}

function activityStatsMarkup(totals) {
  const cards = [
    { icon: 'list', labelKey: 'health.activity.totals.count', value: fmtNum(totals.count) },
    { icon: 'clock', labelKey: 'health.activity.totals.duration', value: t('health.activity.unit.min', { value: fmtNum(totals.durationMin) }) },
    { icon: 'route', labelKey: 'health.activity.totals.distance', value: t('health.activity.unit.km', { value: fmtNum(totals.distanceKm) }) },
    { icon: 'flame', labelKey: 'health.activity.totals.calories', value: t('health.activity.unit.kcal', { value: fmtNum(totals.calories) }) },
  ];
  return cards.map((c) => `
    <div class="health-activity-stat">
      <i data-lucide="${esc(c.icon)}" class="health-activity-stat__icon" aria-hidden="true"></i>
      <span class="health-activity-stat__value">${esc(c.value)}</span>
      <span class="health-activity-stat__label">${esc(t(c.labelKey))}</span>
    </div>`).join('');
}

// Nativer SVG-Balken-Chart: Gesamt-Dauer (Min) je Wochentag Mo–So.
function activityChartMarkup(summary) {
  const buckets = summary.buckets;
  const max = Math.max(...buckets.map((b) => b.durationMin), 0);
  if (max <= 0) {
    return `<div class="empty-state health-chart-empty"><div class="empty-state__title">${esc(t('health.activity.noData'))}</div></div>`;
  }

  const { W, H } = CHART;
  const { left, right, top, bottom } = chartScales();
  const n = buckets.length;
  const chartH = bottom - top;
  const slot = (right - left) / n;
  const barW = slot * 0.6;

  const bars = buckets.map((b, i) => {
    const h = (b.durationMin / max) * chartH;
    const x = left + i * slot + (slot - barW) / 2;
    const y = bottom - h;
    const label = t(ACTIVITY_WEEKDAY_LABEL_KEYS[i]);
    const rect = b.durationMin > 0
      ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="var(--module-health)"><title>${esc(`${label}: ${t('health.activity.unit.min', { value: fmtNum(b.durationMin) })}`)}</title></rect>`
      : '';
    return `${rect}
      <text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" class="health-chart__axis" text-anchor="middle">${esc(label)}</text>`;
  }).join('');

  const grid = chartGridMarkup(0, max);

  const tableRows = buckets.map((b, i) => [
    t(ACTIVITY_WEEKDAY_LABEL_KEYS[i]),
    t('health.activity.unit.min', { value: fmtNum(b.durationMin) }),
  ]);
  const table = chartTableMarkup(
    t('health.activity.chartTitle'),
    [t('health.activity.col.day'), t('health.activity.totals.duration')],
    tableRows,
  );

  return `
    <svg class="health-chart health-activity-chart" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="${esc(t('health.activity.chartTitle'))}">
      ${grid}
      ${bars}
    </svg>
    ${table}`;
}

function activityLogMarkup(rows) {
  if (!rows.length) {
    return `<div class="health-activity__empty">${esc(t('health.activity.noEntries'))}</div>`;
  }
  const own = isOwnActivityView();
  return `
    <h3 class="health-activity__log-title u-toolbar-title">${esc(t('health.activity.logTitle'))}</h3>
    <ul class="health-activity-list">${rows.map((r) => activityRowMarkup(r, own)).join('')}</ul>`;
}

function activityRowMarkup(row, own) {
  const preset = activityType(row.type);
  const icon = preset ? preset.icon : 'activity';
  const typeLabel = preset ? t(preset.labelKey) : row.type;
  const raw = String(row.performed_at);
  const dateKey = raw.slice(0, 10);
  const whenLabel = raw.includes('T')
    ? `${formatDate(dateKey)} · ${formatTime(raw)}`
    : formatDate(dateKey);

  const meta = [];
  if (row.duration_min != null) meta.push(t('health.activity.unit.min', { value: fmtNum(row.duration_min) }));
  if (row.distance_km != null) meta.push(t('health.activity.unit.km', { value: fmtNum(row.distance_km) }));
  if (row.calories != null) meta.push(t('health.activity.unit.kcal', { value: fmtNum(row.calories) }));
  if (row.intensity) meta.push(row.intensity);
  const metaHtml = meta.length
    ? `<span class="health-activity-row__meta">${meta.map((m) => `<span class="health-activity-row__chip">${esc(m)}</span>`).join('')}</span>`
    : '';
  const noteHtml = row.note ? `<span class="health-activity-row__note">${esc(row.note)}</span>` : '';
  const editBtn = own
    ? `<button type="button" class="btn btn--icon btn--sm health-activity-row__edit" data-activity-edit="${esc(row.id)}"
         aria-label="${esc(t('health.activity.edit'))}"><i data-lucide="pencil" aria-hidden="true"></i></button>`
    : '';

  return `
    <li class="health-activity-row">
      <span class="health-activity-row__icon" aria-hidden="true"><i data-lucide="${esc(icon)}"></i></span>
      <span class="health-activity-row__body">
        <span class="health-activity-row__head">
          <span class="health-activity-row__type">${esc(typeLabel)}</span>
          <span class="health-activity-row__when">${esc(whenLabel)}</span>
        </span>
        ${metaHtml}
        ${noteHtml}
      </span>
      ${editBtn}
    </li>`;
}

function wireActivity() {
  wireTablistKeys(activity.root);
  activity.root.querySelectorAll('.health-person-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = Number(chip.dataset.personId);
      if (id === activity.personId) return;
      activity.personId = id;
      switchActivityPerson();
    }));

  activity.root.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      stepActivityWeek(Number(btn.dataset.step));
      renderActivityShell();
    }));


  activity.root.querySelectorAll('[data-activity-edit]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.activityEdit);
      const row = activity.rows.find((r) => r.id === id);
      if (row) openActivityModal(row);
    }));
}

// --------------------------------------------------------
// Erfassungs-Modal (Anlegen/Bearbeiten inkl. Löschen)
// --------------------------------------------------------

function activityTypeSelectMarkup(current) {
  // Preset-Wert oder „custom" (Freitext); ein unbekannter gespeicherter type
  // (z. B. früher als Freitext angelegt) wählt automatisch die Freitext-Option.
  const isPreset = ACTIVITY_TYPES.some((a) => a.value === current);
  const options = ACTIVITY_TYPES.map((a) =>
    `<option value="${esc(a.value)}"${a.value === current ? ' selected' : ''}>${esc(t(a.labelKey))}</option>`).join('');
  const customSelected = current != null && !isPreset;
  return `
    <option value="" disabled ${current == null ? 'selected' : ''}>${esc(t('health.activity.field.typePlaceholder'))}</option>
    ${options}
    <option value="__custom__"${customSelected ? ' selected' : ''}>${esc(t('health.activity.type.custom'))}</option>`;
}

function openActivityModal(row, opts = {}) {
  const isEdit = Boolean(row && row.id);
  const val = (v) => (v == null ? '' : String(v));
  const isPreset = row && ACTIVITY_TYPES.some((a) => a.value === row.type);
  const customValue = isEdit && !isPreset ? val(row.type) : '';
  const dateValue = isEdit && row.performed_at
    ? String(row.performed_at).slice(0, 16)
    : localDateTimeValue(new Date());

  openModal({
    title: isEdit ? t('health.activity.edit') : t('health.activity.add'),
    size: 'md',
    content: `
      <form id="activity-form" class="form-stack">
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="activity-type">${esc(t('health.activity.field.type'))}</label>
            <select class="input" id="activity-type" required>${activityTypeSelectMarkup(isEdit ? row.type : null)}</select>
          </div>
          <div class="form-field" id="activity-custom-field" ${customValue ? '' : 'hidden'}>
            <label class="label" for="activity-custom">${esc(t('health.activity.field.customType'))}</label>
            <input class="input" id="activity-custom" type="text" maxlength="50" value="${esc(customValue)}">
          </div>
        </div>
        <div class="form-field">
          <label class="label" for="activity-performed-at">${esc(t('health.activity.field.performedAt'))}</label>
          <yuvomi-datepicker id="activity-performed-at" type="datetime" value="${esc(dateValue)}"></yuvomi-datepicker>
        </div>
        <div class="modal-grid modal-grid--3">
          <div class="form-field">
            <label class="label" for="activity-duration">${esc(t('health.activity.field.duration'))}</label>
            <input class="input" id="activity-duration" type="number" inputmode="numeric" step="1" min="0" value="${esc(val(row?.duration_min))}">
          </div>
          <div class="form-field">
            <label class="label" for="activity-distance">${esc(t('health.activity.field.distance'))}</label>
            <input class="input" id="activity-distance" type="number" inputmode="decimal" step="any" min="0" value="${esc(val(row?.distance_km))}">
          </div>
          <div class="form-field">
            <label class="label" for="activity-calories">${esc(t('health.activity.field.calories'))}</label>
            <input class="input" id="activity-calories" type="number" inputmode="numeric" step="1" min="0" value="${esc(val(row?.calories))}">
          </div>
        </div>
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="activity-intensity">${esc(t('health.activity.field.intensity'))}</label>
            <input class="input" id="activity-intensity" type="text" maxlength="30" value="${esc(val(row?.intensity))}">
          </div>
          <div class="form-field">
            <label class="label" for="activity-visibility">${esc(t('health.activity.field.visibility'))}</label>
            <select class="input" id="activity-visibility">
              <option value="private" ${row?.visibility === 'family' ? '' : 'selected'}>${esc(t('health.activity.visibility.private'))}</option>
              <option value="family" ${row?.visibility === 'family' ? 'selected' : ''}>${esc(t('health.activity.visibility.family'))}</option>
            </select>
          </div>
        </div>
        <div class="form-field">
          <label class="label" for="activity-note">${esc(t('health.activity.field.note'))}</label>
          <textarea class="input" id="activity-note" rows="2" maxlength="2000">${esc(val(row?.note))}</textarea>
        </div>
        <div class="modal-actions">
          ${isEdit ? `<button type="button" class="btn btn--danger btn--ghost" data-action="activity-delete">${esc(t('common.delete'))}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      const typeSelect = panel.querySelector('#activity-type');
      const customField = panel.querySelector('#activity-custom-field');
      const customInput = panel.querySelector('#activity-custom');

      const syncCustom = () => {
        const show = typeSelect.value === '__custom__';
        customField.hidden = !show;
        if (show) customInput.focus();
      };
      typeSelect.addEventListener('change', syncCustom);

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="activity-delete"]')?.addEventListener('click', () => deleteActivity(row));

      panel.querySelector('#activity-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const body = collectActivityBody(panel);
        if (!body) {
          window.yuvomi?.showToast(t('health.activity.invalid'), 'danger');
          return;
        }
        submitBtn.disabled = true;
        try {
          if (isEdit) {
            await api.patch(`/health/activities/${row.id}`, body);
          } else {
            await api.post('/health/activities', body);
            activity.anchor = toLocalDateKey(new Date(body.performed_at));
          }
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.activity.saved'), 'success');
          await reloadActivity();
          await opts.onSaved?.();
        } catch (err) {
          console.error('[Health] activity save error:', err);
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.activity.saveError'), 'danger');
        }
      });
    },
  });
}

function collectActivityBody(panel) {
  const typeSelect = panel.querySelector('#activity-type');
  const performedAt = panel.querySelector('#activity-performed-at')?.value;
  if (!performedAt) return null;

  let type = typeSelect?.value;
  if (type === '__custom__') {
    type = panel.querySelector('#activity-custom')?.value.trim();
  }
  if (!type) return null;

  const numField = (sel) => {
    const raw = panel.querySelector(sel)?.value.trim();
    if (raw === '' || raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  };
  const duration = numField('#activity-duration');
  const distance = numField('#activity-distance');
  const calories = numField('#activity-calories');
  if ([duration, distance, calories].some((n) => Number.isNaN(n))) return null;

  const strField = (sel) => panel.querySelector(sel)?.value.trim() || undefined;
  const body = {
    type,
    performed_at: performedAt,
    visibility: panel.querySelector('#activity-visibility')?.value || 'private',
  };
  if (duration !== undefined) body.duration_min = duration;
  if (distance !== undefined) body.distance_km = distance;
  if (calories !== undefined) body.calories = calories;
  const intensity = strField('#activity-intensity');
  if (intensity) body.intensity = intensity;
  const note = strField('#activity-note');
  if (note) body.note = note;
  return body;
}

async function deleteActivity(row) {
  if (!row?.id) return;
  if (!(await confirmModal(t('health.activity.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') }))) return;
  try {
    await api.delete(`/health/activities/${row.id}`);
    closeModal({ force: true });
    window.yuvomi?.showToast(t('health.activity.deleted'), 'success');
    await reloadActivity();
  } catch (err) {
    console.error('[Health] activity delete error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.activity.deleteError'), 'danger');
  }
}

// ========================================================
// ÜBERSICHT-TAB
// ========================================================

// Übersicht-View-Zustand. Konsumiert dieselben API-Daten wie die Detail-Tabs
// (Vitalwerte + Medikamente/Einnahmepläne/Logs) und leitet daraus rein
// clientseitig „Heute fällig", Adherence/Streak, letzte Vitalwerte und die
// nächsten Erinnerungen ab (bestehende Pure-Functions, keine neue API-Logik).
const overview = {
  meId: null,
  personId: null,
  members: [],
  vitals: [],
  meds: [],
  schedulesByMed: {},
  logsByMed: {},
  exportRange: { from: null, to: null },
  loaded: false,
  error: false,
  root: null,
};

// Fenster für Adherence-Quote und Streak-Rückschau (Tage).
const OVERVIEW_ADHERENCE_DAYS = 30;
// Default-Zeitraum für den CSV-Export (Tage rückwärts ab heute).
const OVERVIEW_EXPORT_DAYS = 90;
// Exportierbare Bereiche: Route-Segment + Locale-Key des Buttons + Icon.
const EXPORT_AREAS = [
  { area: 'vitals', labelKey: 'health.export.vitals', icon: 'heart-pulse' },
  { area: 'activities', labelKey: 'health.export.activities', icon: 'dumbbell' },
  { area: 'labs', labelKey: 'health.export.labs', icon: 'flask-conical' },
  { area: 'meds-logs', labelKey: 'health.export.medsLogs', icon: 'pill' },
];

function maybeMountOverview(activeRoute) {
  if (activeRoute !== '/health') return;
  const root = _container?.querySelector('[data-overview-root]');
  if (!root) return;
  if (overview.root === root && overview.loaded) return;
  overview.root = root;
  mountOverview();
}

async function mountOverview() {
  overview.root.replaceChildren();
  overview.root.insertAdjacentHTML('beforeend',
    `<div class="health-overview__loading">${esc(t('common.loading'))}</div>`);

  try {
    if (!overview.members.length) {
      const res = await api.get('/family/members');
      overview.members = res.data || [];
    }
    if (!overview.personId) overview.personId = overview.meId ?? overview.members[0]?.id ?? null;
    const today = toLocalDateKey(new Date());
    overview.exportRange = { from: addLocalDays(today, -(OVERVIEW_EXPORT_DAYS - 1)), to: today };
    await loadOverview();
    overview.error = false;
  } catch (err) {
    console.error('[Health] overview mount error:', err);
    overview.error = true;
  }
  overview.loaded = true;
  renderOverviewShell();
}

async function loadOverview() {
  const query = overview.personId ? `?user_id=${encodeURIComponent(overview.personId)}` : '';
  const [vRes, mRes] = await Promise.all([
    api.get(`/health/vitals${query}`),
    api.get(`/health/medications${query}`),
  ]);
  overview.vitals = vRes.data || [];
  overview.meds = mRes.data || [];
  overview.schedulesByMed = {};
  overview.logsByMed = {};

  const today = toLocalDateKey(new Date());
  const from = addLocalDays(today, -(OVERVIEW_ADHERENCE_DAYS - 1));
  await Promise.all(overview.meds.map(async (m) => {
    const [sRes, lRes] = await Promise.all([
      api.get(`/health/medications/${m.id}/schedules`),
      api.get(`/health/medications/${m.id}/logs?from=${from}T00:00&to=${today}T23:59`),
    ]);
    overview.schedulesByMed[m.id] = sRes.data || [];
    overview.logsByMed[m.id] = lRes.data || [];
  }));
}

function isOwnOverviewView() {
  return overview.personId != null && overview.personId === overview.meId;
}

function overviewAllSchedules() {
  return overview.meds.flatMap((m) => overview.schedulesByMed[m.id] || []);
}

function overviewAllLogs() {
  return overview.meds.flatMap((m) => overview.logsByMed[m.id] || []);
}

function overviewFindLog(dose) {
  return (overview.logsByMed[dose.medicationId] || []).find(
    (l) => l.schedule_id === dose.scheduleId && l.scheduled_at === dose.scheduledAt,
  ) || null;
}

async function switchOverviewPerson() {
  try {
    await loadOverview();
    overview.error = false;
  } catch (err) {
    console.error('[Health] overview load error:', err);
    overview.error = true;
  }
  renderOverviewShell();
}

async function reloadOverview() {
  try {
    await loadOverview();
    overview.error = false;
  } catch (err) {
    console.error('[Health] overview reload error:', err);
    overview.error = true;
  }
  renderOverviewShell();
}

function renderOverviewShell() {
  if (!overview.root?.isConnected) return;
  overview.root.replaceChildren();

  if (overview.error) {
    overview.root.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${esc(t('health.overview.loadError'))}</div>
        <div class="empty-state__description">${esc(t('health.overview.loadErrorDesc'))}</div>
        <button class="btn btn--primary empty-state__cta" data-action="overview-retry">
          <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
          ${esc(t('health.overview.retry'))}
        </button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: overview.root });
    overview.root.querySelector('[data-action="overview-retry"]')?.addEventListener('click', () => mountOverview());
    return;
  }

  overview.root.insertAdjacentHTML('beforeend', `
    <div class="health-persons" role="tablist" aria-label="${esc(t('health.overview.personsLabel'))}">
      ${personChipsMarkup(overview.members, overview.personId, overview.meId)}
    </div>
    ${readOnlyBannerMarkup(overview.members, overview.personId, isOwnOverviewView())}
    <div class="health-overview__grid">
      ${overviewCard('calendar-check', 'health.overview.dueToday.title', overviewDueMarkup())}
      ${overviewCard('trending-up', 'health.overview.adherence.title', overviewAdherenceMarkup())}
      ${overviewCard('activity', 'health.overview.vitals.title', overviewVitalsMarkup())}
      ${isOwnOverviewView() ? overviewCard('plus-circle', 'health.overview.quick.title', quickCaptureMarkup()) : ''}
      ${overviewCard('bell', 'health.overview.reminders.title', overviewUpcomingMarkup())}
      ${overviewCard('download', 'health.export.title', overviewExportMarkup())}
    </div>
    ${disclaimerMarkup()}
  `);
  if (window.lucide) window.lucide.createIcons({ el: overview.root });
  wireOverview();
}

function overviewCard(icon, titleKey, body) {
  return `
    <section class="health-overview__card">
      <header class="health-overview__card-head">
        <i data-lucide="${esc(icon)}" class="health-overview__card-icon" aria-hidden="true"></i>
        <h3 class="health-overview__card-title u-toolbar-title">${esc(t(titleKey))}</h3>
      </header>
      <div class="health-overview__card-body">${body}</div>
    </section>`;
}

// --- Heute fällig (identische Logik wie dueTodayMarkup im Meds-Tab) ---

function overviewDueMarkup() {
  const today = toLocalDateKey(new Date());
  const due = computeDueDoses(overviewAllSchedules(), { from: today, to: today });
  if (!due.length) {
    return `<div class="health-meds__due-empty">${esc(t('health.meds.dueToday.empty'))}</div>`;
  }
  const own = isOwnOverviewView();
  const rows = due.map((dose) => {
    const med = overview.meds.find((m) => m.id === dose.medicationId);
    return overviewDueRowMarkup(dose, med, overviewFindLog(dose), own);
  }).join('');
  return `<ul class="health-meds__due-list">${rows}</ul>`;
}

function overviewDueRowMarkup(dose, med, log, own) {
  const name = med ? med.name : '';
  const status = log?.status;
  const doseText = dose.dose_qty != null ? ` · ${fmtNum(dose.dose_qty)}` : '';

  let actions;
  if (status === 'taken') {
    actions = `<span class="health-dose__status health-dose__status--taken"><i data-lucide="check" aria-hidden="true"></i>${esc(t('health.meds.status.taken'))}</span>`;
  } else if (status === 'skipped') {
    actions = `<span class="health-dose__status health-dose__status--skipped"><i data-lucide="x" aria-hidden="true"></i>${esc(t('health.meds.status.skipped'))}</span>`;
  } else if (own) {
    const data = `data-med-id="${esc(dose.medicationId)}" data-schedule-id="${esc(dose.scheduleId ?? '')}" data-scheduled-at="${esc(dose.scheduledAt)}" data-log-id="${esc(log?.id ?? '')}" data-dose="${esc(dose.dose_qty ?? '')}"`;
    actions = `
      <div class="health-dose__actions">
        <button type="button" class="btn btn--sm btn--primary" data-ov-dose-take ${data}>${esc(t('health.meds.take'))}</button>
        <button type="button" class="btn btn--sm btn--ghost" data-ov-dose-skip ${data}>${esc(t('health.meds.skip'))}</button>
      </div>`;
  } else {
    actions = `<span class="health-dose__status">${esc(t('health.meds.status.pending'))}</span>`;
  }

  return `
    <li class="health-dose">
      <span class="health-dose__time">${esc(dose.time)}</span>
      <span class="health-dose__name">${esc(name)}${esc(doseText)}</span>
      ${actions}
    </li>`;
}

async function handleOverviewDose(btn, action) {
  const medId = Number(btn.dataset.medId);
  const logId = btn.dataset.logId ? Number(btn.dataset.logId) : null;
  const scheduleId = btn.dataset.scheduleId ? Number(btn.dataset.scheduleId) : null;
  const scheduledAt = btn.dataset.scheduledAt || null;
  const dose = btn.dataset.dose !== '' ? Number(btn.dataset.dose) : null;

  btn.disabled = true;
  try {
    if (logId) {
      await api.post(`/health/logs/${logId}/${action}`, {});
    } else {
      const body = { status: action === 'take' ? 'taken' : 'skipped' };
      if (scheduledAt) body.scheduled_at = scheduledAt;
      if (scheduleId) body.schedule_id = scheduleId;
      if (dose != null && Number.isFinite(dose)) body.dose_qty = dose;
      if (action === 'take') body.taken_at = new Date().toISOString();
      await api.post(`/health/medications/${medId}/logs`, body);
    }

    if (action === 'take' && dose != null && Number.isFinite(dose)) {
      const med = overview.meds.find((m) => m.id === medId);
      if (med && med.stock_qty != null) {
        const next = Math.max(0, Number(med.stock_qty) - dose);
        await api.patch(`/health/medications/${medId}`, { stock_qty: next });
      }
    }

    window.yuvomi?.showToast(t('health.meds.doseSaved'), 'success');
    await reloadOverview();
  } catch (err) {
    console.error('[Health] overview dose error:', err);
    btn.disabled = false;
    window.yuvomi?.showToast(err?.data?.error || t('health.meds.doseError'), 'danger');
  }
}

// --- Adherence-Quote + Streak ---

function overviewAdherenceMarkup() {
  const today = toLocalDateKey(new Date());
  const from = addLocalDays(today, -(OVERVIEW_ADHERENCE_DAYS - 1));
  const schedules = overviewAllSchedules();
  const planned = computeDueDoses(schedules, { from, to: today }).length;
  const logs = overviewAllLogs().filter((l) => {
    const k = String(l.scheduled_at || l.taken_at || l.created_at || '').slice(0, 10);
    return k >= from && k <= today;
  });
  const a = computeAdherence(logs, planned);
  const streak = computeAdherenceStreak(schedules, overviewAllLogs(), { today });

  if (a.rate === null) {
    return `<div class="health-adherence__empty">${esc(t('health.overview.adherence.noData'))}</div>`;
  }
  // Frühzustand ohne Vorwurf: solange nichts protokolliert ist, kein „0 %".
  if (a.taken === 0) {
    return `<div class="health-adherence__empty">${esc(t('health.overview.adherence.notStarted'))}</div>`;
  }
  const pct = Math.round(a.rate * 100);
  // Die Streak-Kachel erscheint erst ab Tag 1 — eine „🔥 0"-Serie zu zeigen wäre
  // demotivierend statt anspornend.
  const streakStat = streak > 0
    ? `<div class="health-overview__stat">
        <span class="health-overview__stat-value">
          <i data-lucide="flame" class="health-overview__streak-icon" aria-hidden="true"></i>${esc(fmtNum(streak))}
        </span>
        <span class="health-overview__stat-label">${esc(t('health.overview.adherence.streakLabel'))}</span>
      </div>`
    : '';
  return `
    <div class="health-overview__adherence">
      <div class="health-overview__stat">
        <span class="health-overview__stat-value">${esc(fmtNum(pct))}%</span>
        <span class="health-overview__stat-label">${esc(t('health.overview.adherence.period', { days: OVERVIEW_ADHERENCE_DAYS }))}</span>
        <div class="health-adherence__bar"><span style="width:${pct}%"></span></div>
      </div>
      ${streakStat}
    </div>`;
}

// --- Letzte Vitalwerte (Karten, Klick navigiert zum Vitalwerte-Tab) ---

function overviewVitalsMarkup() {
  const today = toLocalDateKey(new Date());
  const cards = VITAL_METRICS.map((metric) => {
    const series = computeVitalSeries(overview.vitals, { type: metric.type, range: 'month', anchor: today });
    return overviewVitalCardMarkup(metric, series);
  }).join('');
  return `<div class="health-overview__vitals-grid">${cards}</div>`;
}

function overviewVitalCardMarkup(metric, series) {
  const latest = series.latest;
  const label = t(metric.labelKey);

  let valueHtml;
  let metaHtml = `<div class="health-metric-card__empty">${esc(t('health.vitals.noValue'))}</div>`;
  if (latest) {
    const unit = esc(latest.unit || '');
    const valueText = metric.type === 'bp'
      ? `${fmtNum(latest.value_num)}/${fmtNum(latest.value_num2)}`
      : fmtNum(latest.value_num);
    valueHtml = `<span class="health-metric-card__value">${esc(valueText)}</span>${unit ? ` <span class="health-metric-card__unit">${unit}</span>` : ''}`;
    metaHtml = `
      <div class="health-metric-card__meta">
        ${deltaMarkup(series.deltas.value_num)}
        <span class="health-metric-card__date">${esc(formatDate(String(latest.measured_at).slice(0, 10)))}</span>
      </div>`;
  } else {
    valueHtml = '<span class="health-metric-card__value health-metric-card__value--empty">–</span>';
  }

  return `
    <button type="button" class="health-metric-card" data-vital-nav="${esc(metric.type)}">
      <span class="health-metric-card__head">
        <i data-lucide="${esc(metric.icon)}" class="health-metric-card__icon" aria-hidden="true"></i>
        <span class="health-metric-card__label">${esc(label)}</span>
      </span>
      <span class="health-metric-card__body">${valueHtml}</span>
      ${metaHtml}
    </button>`;
}

// --- Nächste Erinnerungen (heute noch offene Zeitfenster, reine Anzeige) ---

function overviewUpcomingMarkup() {
  const now = new Date();
  const today = toLocalDateKey(now);
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const up = upcomingDoses(overviewAllSchedules(), overviewAllLogs(), { today, nowTime, limit: 5 });
  if (!up.length) {
    return `<div class="health-overview__reminders-empty">${esc(t('health.overview.reminders.empty'))}</div>`;
  }
  const rows = up.map((dose) => {
    const med = overview.meds.find((m) => m.id === dose.medicationId);
    const doseText = dose.dose_qty != null ? ` · ${fmtNum(dose.dose_qty)}` : '';
    return `
      <li class="health-overview-reminder">
        <span class="health-dose__time">${esc(dose.time)}</span>
        <span class="health-dose__name">${esc(med ? med.name : '')}${esc(doseText)}</span>
      </li>`;
  }).join('');
  return `<ul class="health-overview__reminders-list">${rows}</ul>`;
}

// --- Schnell-Erfassung (nur eigene Person) ---

function quickCaptureMarkup() {
  if (!isOwnOverviewView()) return '';
  return `
    <div class="health-overview__quick">
      <button type="button" class="btn btn--secondary" data-action="ov-add-vital">
        <i data-lucide="heart-pulse" class="icon-md" aria-hidden="true"></i>${esc(t('health.overview.quick.vital'))}
      </button>
      <button type="button" class="btn btn--secondary" data-action="ov-add-activity">
        <i data-lucide="dumbbell" class="icon-md" aria-hidden="true"></i>${esc(t('health.overview.quick.activity'))}
      </button>
      <button type="button" class="btn btn--secondary" data-action="ov-go-meds">
        <i data-lucide="pill" class="icon-md" aria-hidden="true"></i>${esc(t('health.overview.quick.meds'))}
      </button>
    </div>`;
}

// --- CSV-Export je Bereich (Server-Route, Muster wie Budget-Stats-Export) ---

function overviewExportHref(area) {
  const { from, to } = overview.exportRange;
  const params = new URLSearchParams();
  if (overview.personId) params.set('user_id', String(overview.personId));
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const q = params.toString();
  return `/api/v1/health/export/${area}${q ? `?${q}` : ''}`;
}

function exportButtonsMarkup() {
  return EXPORT_AREAS.map((e) => `
    <a class="btn btn--secondary health-overview__export-btn" href="${esc(overviewExportHref(e.area))}"
       download data-export-area="${esc(e.area)}">
      <i data-lucide="${esc(e.icon)}" class="icon-md" aria-hidden="true"></i>${esc(t(e.labelKey))}
    </a>`).join('');
}

function overviewExportMarkup() {
  const { from, to } = overview.exportRange;
  return `
    <div class="health-overview__export">
      <div class="health-overview__export-range">
        <div class="form-field">
          <label class="label" for="ov-export-from">${esc(t('health.export.rangeFrom'))}</label>
          <yuvomi-datepicker id="ov-export-from" type="date" value="${esc(from || '')}"></yuvomi-datepicker>
        </div>
        <div class="form-field">
          <label class="label" for="ov-export-to">${esc(t('health.export.rangeTo'))}</label>
          <yuvomi-datepicker id="ov-export-to" type="date" value="${esc(to || '')}"></yuvomi-datepicker>
        </div>
      </div>
      <div class="health-overview__export-buttons" id="ov-export-buttons">${exportButtonsMarkup()}</div>
      <div class="health-overview__export-hint">${esc(t('health.export.hint'))}</div>
    </div>`;
}

function rerenderExportButtons() {
  const host = overview.root?.querySelector('#ov-export-buttons');
  if (!host) return;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', exportButtonsMarkup());
  if (window.lucide) window.lucide.createIcons({ el: host });
}

function wireOverview() {
  wireTablistKeys(overview.root);
  overview.root.querySelectorAll('.health-person-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = Number(chip.dataset.personId);
      if (id === overview.personId) return;
      overview.personId = id;
      switchOverviewPerson();
    }));

  overview.root.querySelectorAll('[data-ov-dose-take]').forEach((btn) =>
    btn.addEventListener('click', () => handleOverviewDose(btn, 'take')));
  overview.root.querySelectorAll('[data-ov-dose-skip]').forEach((btn) =>
    btn.addEventListener('click', () => handleOverviewDose(btn, 'skip')));

  overview.root.querySelectorAll('[data-vital-nav]').forEach((card) =>
    card.addEventListener('click', () => {
      vitals.selectedType = card.dataset.vitalNav;
      window.yuvomi?.navigate('/health/vitals');
    }));

  overview.root.querySelector('[data-action="ov-add-vital"]')
    ?.addEventListener('click', () => openVitalModal({ onSaved: () => reloadOverview() }));
  overview.root.querySelector('[data-action="ov-add-activity"]')
    ?.addEventListener('click', () => openActivityModal(null, { onSaved: () => reloadOverview() }));
  overview.root.querySelector('[data-action="ov-go-meds"]')
    ?.addEventListener('click', () => window.yuvomi?.navigate('/health/meds'));

  const fromEl = overview.root.querySelector('#ov-export-from');
  const toEl = overview.root.querySelector('#ov-export-to');
  fromEl?.addEventListener('change', () => { overview.exportRange.from = fromEl.value || null; rerenderExportButtons(); });
  toEl?.addEventListener('change', () => { overview.exportRange.to = toEl.value || null; rerenderExportButtons(); });
}

// ========================================================
// ZYKLUS-TAB (Menstruation)
// ========================================================
//
// Ein Personen-gescopter Tab wie Vitalwerte/Aktivität: Personen-Umschalter,
// Hero-„Zyklus-Ring" (SVG), Vorhersage-Statistik, Schnellerfassung, Monatskalender
// und Perioden-Verlauf. Vorhersagen (nächste Periode, Eisprung, fruchtbares
// Fenster) sind rein clientseitig (health-cycle.js). Zyklusdaten sind sensibel →
// Default-Sichtbarkeit privat; Fremd-Person-Ansicht ist read-only.

const cycle = {
  meId: null,
  personId: null,
  members: [],
  periods: [],
  logs: [],
  settings: null,
  anchor: toLocalDateKey(new Date()),
  loaded: false,
  error: false,
  root: null,
};

// Wochentags-/Phasen-Label-Keys als vollständige Konstanten (Frontend-Audit:
// niemals Präfix + Variable konkatenieren).
const CYCLE_WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const CYCLE_WEEKDAY_LABEL_KEYS = CYCLE_WEEKDAY_KEYS.map((k) => `health.cycle.weekday.${k}`);
const CYCLE_PHASE_LABEL_KEYS = {
  [PHASE.MENSTRUATION]: 'health.cycle.phase.menstruation',
  [PHASE.FOLLICULAR]:   'health.cycle.phase.follicular',
  [PHASE.FERTILE]:      'health.cycle.phase.fertile',
  [PHASE.OVULATION]:    'health.cycle.phase.ovulation',
  [PHASE.LUTEAL]:       'health.cycle.phase.luteal',
};
// Bogenfarben je Phase (Token-Referenzen, keine Hardcodes).
const CYCLE_PHASE_COLOR = {
  [PHASE.MENSTRUATION]: 'var(--cycle-period)',
  [PHASE.FERTILE]:      'var(--cycle-fertile)',
  [PHASE.OVULATION]:    'var(--cycle-ovulation)',
};

function maybeMountCycle(activeRoute) {
  if (activeRoute !== '/health/cycle') return;
  const root = _container?.querySelector('[data-cycle-root]');
  if (!root) return;
  if (cycle.root === root && cycle.loaded) return;
  cycle.root = root;
  mountCycle();
}

function cycleSkeletonMarkup() {
  // Skeleton statt Spinner/Text: spiegelt die Hero-Silhouette (Ring + Statistik),
  // damit der Layout-Sprung beim Laden ausbleibt (Product-Register).
  return `
    <div class="cycle-skeleton" aria-hidden="true">
      <div class="cycle-skeleton__ring skeleton"></div>
      <div class="cycle-skeleton__side">
        <div class="skeleton skeleton-line skeleton-line--title"></div>
        <div class="skeleton skeleton-line skeleton-line--medium"></div>
        <div class="skeleton skeleton-line skeleton-line--short"></div>
      </div>
    </div>`;
}

async function mountCycle() {
  cycle.root.replaceChildren();
  cycle.root.insertAdjacentHTML('beforeend', `<div class="health-cycle__loading" role="status">
    <span class="sr-only">${esc(t('common.loading'))}</span>
    ${cycleSkeletonMarkup()}
  </div>`);

  try {
    if (!cycle.members.length) {
      const res = await api.get('/family/members');
      cycle.members = res.data || [];
    }
    if (!cycle.personId) cycle.personId = cycle.meId ?? cycle.members[0]?.id ?? null;
    await loadCycle();
    cycle.error = false;
  } catch (err) {
    console.error('[Health] cycle mount error:', err);
    cycle.error = true;
  }
  cycle.loaded = true;
  renderCycleShell();
}

async function loadCycle() {
  const query = cycle.personId ? `?user_id=${encodeURIComponent(cycle.personId)}` : '';
  const [periodsRes, logsRes] = await Promise.all([
    api.get(`/health/cycle/periods${query}`),
    api.get(`/health/cycle/logs${query}`),
  ]);
  cycle.periods = periodsRes.data || [];
  cycle.logs = logsRes.data || [];
  // Einstellungen (und damit persönliche Vorhersage-Parameter) nur in der eigenen
  // Ansicht; für fremde Personen greifen die aus deren Historie abgeleiteten Werte.
  if (isOwnCycleView()) {
    try { cycle.settings = (await api.get('/health/cycle/settings')).data || {}; }
    catch { cycle.settings = {}; }
  } else {
    cycle.settings = null;
  }
}

function isOwnCycleView() {
  return cycle.personId != null && cycle.personId === cycle.meId;
}

function cycleSettings() {
  return (isOwnCycleView() && cycle.settings) ? cycle.settings : {};
}

async function switchCyclePerson() {
  cycle.anchor = toLocalDateKey(new Date());
  try { await loadCycle(); cycle.error = false; }
  catch (err) { console.error('[Health] cycle load error:', err); cycle.error = true; }
  renderCycleShell();
}

async function reloadCycle() {
  try { await loadCycle(); cycle.error = false; }
  catch (err) { console.error('[Health] cycle reload error:', err); cycle.error = true; }
  renderCycleShell();
}

function stepCycleMonth(dir) {
  const d = parseLocalDateKey(`${cycle.anchor.slice(0, 7)}-01`);
  d.setMonth(d.getMonth() + dir);
  cycle.anchor = toLocalDateKey(d);
}

function renderCycleShell() {
  if (!cycle.root?.isConnected) return;
  cycle.root.replaceChildren();

  if (cycle.error) {
    cycle.root.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
        <div class="empty-state__title">${esc(t('health.cycle.loadError'))}</div>
        <div class="empty-state__description">${esc(t('health.cycle.loadErrorDesc'))}</div>
        <button class="btn btn--primary empty-state__cta" data-action="cycle-retry">
          <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
          ${esc(t('health.cycle.retry'))}
        </button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: cycle.root });
    cycle.root.querySelector('[data-action="cycle-retry"]')?.addEventListener('click', () => mountCycle());
    return;
  }

  const own = isOwnCycleView();
  const prediction = predictCycle(cycle.periods, cycleSettings());

  const persons = `
    <div class="health-persons" role="tablist" aria-label="${esc(t('health.cycle.personsLabel'))}">
      ${personChipsMarkup(cycle.members, cycle.personId, cycle.meId)}
    </div>
    ${readOnlyBannerMarkup(cycle.members, cycle.personId, own)}`;

  // Schwangerschafts-Modus: Vorhersagen sind pausiert — statt Ring/Prognose wird
  // der Schwangerschafts-Status gezeigt. Logging, Kalender (ohne Projektion) und
  // Historie bleiben verfügbar; ohne Perioden-Historie entfällt nur die Historie.
  if (prediction.isPregnant) {
    cycle.root.insertAdjacentHTML('beforeend', `
      ${persons}
      ${cyclePregnancyMarkup(prediction, own)}
      ${own ? cycleTodayActionsMarkup(true) : ''}
      ${cycleCalendarMarkup(own)}
      ${prediction.hasData ? cycleHistoryMarkup(own) : ''}
      ${cycleFooterMarkup(own)}
    `);
    if (window.lucide) window.lucide.createIcons({ el: cycle.root });
    wireCycle();
    refreshHealthFab();
    return;
  }

  if (!prediction.hasData) {
    cycle.root.insertAdjacentHTML('beforeend', `
      ${persons}
      <div class="empty-state health-empty">
        <div class="health-empty__icon" aria-hidden="true"><i data-lucide="droplet"></i></div>
        <div class="empty-state__title">${esc(t('health.cycle.emptyTitle'))}</div>
        <div class="empty-state__description">${esc(t('health.cycle.emptyDesc'))}</div>
        ${own ? `<button class="btn btn--primary empty-state__cta" data-action="cycle-first">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>${esc(t('health.cycle.emptyCta'))}</button>` : ''}
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: cycle.root });
    wireCycle();
    refreshHealthFab();
    return;
  }

  cycle.root.insertAdjacentHTML('beforeend', `
    ${persons}
    <div class="cycle-hero">
      ${cycleRingMarkup(prediction)}
      <div class="cycle-hero__side">
        ${cycleStatsMarkup(prediction)}
        ${prediction.trackFertility ? `<p class="health-disclaimer">${esc(t('health.cycle.fertilityDisclaimer'))}</p>` : ''}
      </div>
    </div>
    ${own ? cycleTodayActionsMarkup() : ''}
    ${cycleCalendarMarkup(own)}
    ${cycleHistoryMarkup(own)}
    ${cycleFooterMarkup(own)}
  `);
  if (window.lucide) window.lucide.createIcons({ el: cycle.root });
  wireCycle();
  refreshHealthFab();
}

// --------------------------------------------------------
// Hero: Schwangerschaft (Vorhersage pausiert)
// --------------------------------------------------------

function cyclePregnancyMarkup(prediction, own) {
  const p = prediction.pregnancy || {};
  const pct = Math.round((p.progress || 0) * 100);

  let detail;
  if (p.hasDue) {
    const weekLine = t('health.cycle.pregnancy.week', { weeks: p.gestWeeks, days: p.gestDays });
    const countdown = p.overdue
      ? t('health.cycle.pregnancy.overdue', { days: Math.abs(p.daysUntilDue) })
      : t('health.cycle.pregnancy.countdown', { days: p.daysUntilDue });
    detail = `
      <div class="cycle-preg__week">${esc(weekLine)}</div>
      <div class="cycle-preg__meta">
        <span class="cycle-preg__badge">${esc(t('health.cycle.pregnancy.trimester', { n: p.trimester }))}</span>
        <span class="cycle-preg__countdown">${esc(countdown)}</span>
      </div>
      <div class="cycle-preg__bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(t('health.cycle.pregnancy.progressLabel'))}">
        <span class="cycle-preg__bar-fill" style="width:${pct}%"></span>
      </div>
      <div class="cycle-preg__due">${esc(t('health.cycle.pregnancy.dueDate', { date: formatDate(p.dueDate) }))}</div>`;
  } else {
    detail = `<p class="cycle-preg__nodate">${esc(t('health.cycle.pregnancy.noDate'))}</p>`;
  }

  return `
    <div class="cycle-preg">
      <div class="cycle-preg__icon" aria-hidden="true"><i data-lucide="baby"></i></div>
      <div class="cycle-preg__body">
        <span class="cycle-preg__title">${esc(t('health.cycle.pregnancy.title'))}</span>
        ${detail}
        <p class="cycle-preg__paused">${esc(t('health.cycle.pregnancy.paused'))}</p>
        ${own ? `<button class="btn btn--ghost btn--sm cycle-preg__edit" data-action="cycle-settings"><i data-lucide="settings-2" aria-hidden="true"></i>${esc(t('health.cycle.settings.open'))}</button>` : ''}
      </div>
    </div>`;
}

// --------------------------------------------------------
// Hero: Zyklus-Ring (SVG-Donut mit Phasen-Bögen + Markern)
// --------------------------------------------------------

function cyclePolar(cx, cy, r, frac) {
  const a = (frac * 360 - 90) * (Math.PI / 180);
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function cycleRingMarkup(prediction) {
  const ring = cycleRing(prediction);
  const CX = 110, CY = 110, R = 86, SW = 20;
  const C = 2 * Math.PI * R;

  const arcs = ring.segments.map((s) => {
    const len = Math.max(0, (s.end - s.start)) * C;
    if (len <= 0.01) return '';
    const color = CYCLE_PHASE_COLOR[s.phase] || 'var(--module-health)';
    return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}" stroke-width="${SW}"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-s.start * C).toFixed(2)}"
      transform="rotate(-90 ${CX} ${CY})" />`;
  }).join('');

  let markers = '';
  if (ring.ovulationFrac != null) {
    const [ox, oy] = cyclePolar(CX, CY, R, ring.ovulationFrac);
    markers += `<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="5.5" fill="var(--cycle-ovulation)" stroke="var(--color-surface)" stroke-width="2.5" />`;
  }
  const [tx, ty] = cyclePolar(CX, CY, R, ring.currentFrac);
  markers += `<circle class="cycle-ring__now" cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="7.5" fill="var(--module-health)" stroke="var(--color-surface)" stroke-width="3" />`;

  const phaseLabel = t(CYCLE_PHASE_LABEL_KEYS[prediction.phase] || CYCLE_PHASE_LABEL_KEYS[PHASE.FOLLICULAR]);
  const ringAria = `${phaseLabel} · ${t('health.cycle.ring.cycleDay', { day: prediction.cycleDay })}`;

  return `
    <div class="cycle-ring" data-phase="${esc(prediction.phase)}">
      <svg class="cycle-ring__svg" viewBox="0 0 220 220" role="img" aria-label="${esc(ringAria)}">
        <circle class="cycle-ring__track" cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke-width="${SW}" />
        ${arcs}
        ${markers}
      </svg>
      <div class="cycle-ring__center">
        <span class="cycle-ring__phase">${esc(phaseLabel)}</span>
        <span class="cycle-ring__day">${esc(t('health.cycle.ring.cycleDay', { day: prediction.cycleDay }))}</span>
        <span class="cycle-ring__status">${esc(cycleCountdownText(prediction))}</span>
      </div>
    </div>`;
}

function cycleCountdownText(prediction) {
  const d = prediction.daysUntilNext;
  if (d === 0) return t('health.cycle.status.today');
  if (d < 0) return t('health.cycle.status.overdue', { count: Math.abs(d) });
  return t('health.cycle.status.inDays', { count: d });
}

// --------------------------------------------------------
// Vorhersage-Statistik (Karten)
// --------------------------------------------------------

function cycleStatCardMarkup({ icon, labelKey, value, sub }) {
  return `
    <div class="cycle-stat">
      <span class="cycle-stat__head"><i data-lucide="${esc(icon)}" aria-hidden="true"></i>${esc(t(labelKey))}</span>
      <span class="cycle-stat__value">${esc(value)}</span>
      ${sub ? `<span class="cycle-stat__sub">${esc(sub)}</span>` : ''}
    </div>`;
}

function cycleStatsMarkup(prediction) {
  const stats = prediction.stats;
  const tiles = [];

  // Nächste Periode: nur das Datum — der Countdown steht bereits im Ring-Zentrum,
  // die Karte würde ihn sonst dublieren (Critique).
  tiles.push(cycleStatCardMarkup({
    icon: 'calendar-heart',
    labelKey: 'health.cycle.status.nextPeriod',
    value: formatDate(prediction.nextStart),
    sub: '',
  }));

  if (prediction.trackFertility) {
    tiles.push(cycleStatCardMarkup({
      icon: 'sparkles',
      labelKey: 'health.cycle.status.fertileWindow',
      value: `${formatDate(prediction.fertileStart)} – ${formatDate(prediction.fertileEnd)}`,
      sub: `${t('health.cycle.status.ovulation')}: ${formatDate(prediction.ovulationDate)}`,
    }));
  } else {
    const reg = stats.regular === null
      ? t('health.cycle.status.notEnoughData')
      : t(stats.regular ? 'health.cycle.status.regular' : 'health.cycle.status.irregular');
    tiles.push(cycleStatCardMarkup({ icon: 'activity', labelKey: 'health.cycle.status.regularity', value: reg, sub: '' }));
  }

  // Ø Zyklus + Ø Periode teilen sich EINE volle-Breite-Kachel statt zweier fast
  // identischer Tiles — bricht die „identical card grid"-Wiederholung auf.
  tiles.push(`
    <div class="cycle-stat cycle-stat--dual">
      <div class="cycle-stat__pair-item">
        <span class="cycle-stat__head"><i data-lucide="repeat" aria-hidden="true"></i>${esc(t('health.cycle.status.avgCycle'))}</span>
        <span class="cycle-stat__value">${esc(t('health.cycle.unit.days', { value: fmtNum(stats.avgCycle) }))}</span>
      </div>
      <div class="cycle-stat__pair-item">
        <span class="cycle-stat__head"><i data-lucide="droplet" aria-hidden="true"></i>${esc(t('health.cycle.status.avgPeriod'))}</span>
        <span class="cycle-stat__value">${esc(t('health.cycle.unit.days', { value: fmtNum(stats.avgPeriod) }))}</span>
      </div>
    </div>`);

  return `<div class="cycle-stats">${tiles.join('')}</div>`;
}

// --------------------------------------------------------
// Schnellerfassung „Heute"
// --------------------------------------------------------

function cycleOpenPeriod() {
  // Jüngste laufende Periode (kein Enddatum), deren Start nicht in der Zukunft liegt.
  const today = toLocalDateKey(new Date());
  return [...cycle.periods]
    .filter((p) => !p.end_date && String(p.start_date).slice(0, 10) <= today)
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0] || null;
}

function cycleTodayActionsMarkup(pregnant = false) {
  const open = cycleOpenPeriod();
  // Im Schwangerschafts-Modus keine „Periode starten/beenden"-Aktion anbieten —
  // nur das Tages-Protokoll bleibt (z. B. für Schmierblutungen/Symptome).
  const primary = pregnant
    ? ''
    : (open
      ? `<button class="btn btn--secondary" data-action="cycle-end-period"><i data-lucide="check" aria-hidden="true"></i>${esc(t('health.cycle.today.endPeriod'))}</button>`
      : `<button class="btn btn--primary" data-action="cycle-start-period"><i data-lucide="droplet" aria-hidden="true"></i>${esc(t('health.cycle.today.startPeriod'))}</button>`);
  return `
    <div class="cycle-today">
      <span class="cycle-today__label">${esc(t('health.cycle.today.title'))}</span>
      <div class="cycle-today__actions">
        ${primary}
        <button class="btn btn--ghost" data-action="cycle-log-today"><i data-lucide="pencil-line" aria-hidden="true"></i>${esc(t('health.cycle.today.logDay'))}</button>
      </div>
    </div>`;
}

async function cycleStartPeriodToday() {
  const today = toLocalDateKey(new Date());
  try {
    await api.post('/health/cycle/periods', { start_date: today });
    cycle.anchor = today;
    window.yuvomi?.showToast(t('health.cycle.today.startedToast'), 'success');
    await reloadCycle();
  } catch (err) {
    console.error('[Health] cycle start error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.cycle.saveError'), 'danger');
  }
}

async function cycleEndPeriodToday() {
  const open = cycleOpenPeriod();
  if (!open) { window.yuvomi?.showToast(t('health.cycle.today.noOpenPeriod'), 'info'); return; }
  try {
    await api.patch(`/health/cycle/periods/${open.id}`, { end_date: toLocalDateKey(new Date()) });
    window.yuvomi?.showToast(t('health.cycle.today.endedToast'), 'success');
    await reloadCycle();
  } catch (err) {
    console.error('[Health] cycle end error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.cycle.saveError'), 'danger');
  }
}

// --------------------------------------------------------
// Monatskalender
// --------------------------------------------------------

function cycleMonthLabel(anchorKey) {
  const d = parseLocalDateKey(`${anchorKey.slice(0, 7)}-01`);
  try {
    return new Intl.DateTimeFormat(getLocale(), { month: 'long', year: 'numeric' }).format(d);
  } catch {
    return anchorKey.slice(0, 7);
  }
}

function cycleCalendarMarkup(own) {
  const cal = buildCycleCalendar(cycle.anchor, {
    periods: cycle.periods, logs: cycle.logs, settings: cycleSettings(), weekStartsOn: 1,
  });

  const weekdays = CYCLE_WEEKDAY_LABEL_KEYS
    .map((k) => `<span class="cycle-cal__wd">${esc(t(k))}</span>`).join('');

  const cells = cal.weeks.flat().map((c) => {
    const cls = ['cycle-cal__day'];
    if (!c.inMonth) cls.push('is-out');
    if (c.isToday) cls.push('is-today');
    if (c.phase) cls.push(`is-${c.phase}`);
    if (c.predicted) cls.push('is-predicted');
    if (c.hasLog) cls.push('has-log');
    const flowAttr = c.flow ? ` data-flow="${esc(c.flow)}"` : '';
    const tag = own ? 'button' : 'div';
    const attrs = own
      ? `type="button" data-cycle-day="${esc(c.dateKey)}" aria-label="${esc(formatDate(c.dateKey))}"`
      : 'aria-hidden="true"';
    return `<${tag} class="${cls.join(' ')}"${flowAttr} ${attrs}>
      <span class="cycle-cal__num">${esc(c.day)}</span>
      ${c.hasLog ? '<span class="cycle-cal__dot" aria-hidden="true"></span>' : ''}
    </${tag}>`;
  }).join('');

  return `
    <section class="cycle-cal">
      <div class="cycle-cal__head">
        <h3 class="cycle-section__title u-toolbar-title">${esc(t('health.cycle.calendar.title'))}</h3>
        <div class="cycle-cal__nav">
          <button class="btn btn--icon" data-cycle-month="-1" aria-label="${esc(t('health.cycle.calendar.prevMonth'))}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
          <span class="cycle-cal__month">${esc(cycleMonthLabel(cycle.anchor))}</span>
          <button class="btn btn--icon" data-cycle-month="1" aria-label="${esc(t('health.cycle.calendar.nextMonth'))}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="cycle-cal__weekdays" aria-hidden="true">${weekdays}</div>
      <div class="cycle-cal__grid" role="grid">${cells}</div>
      ${cycleLegendMarkup()}
    </section>`;
}

function cycleLegendMarkup() {
  const items = [
    { cls: 'is-menstruation', key: 'health.cycle.legend.period' },
    { cls: 'is-menstruation is-predicted', key: 'health.cycle.legend.predicted' },
    { cls: 'is-fertile', key: 'health.cycle.legend.fertile' },
    { cls: 'is-ovulation', key: 'health.cycle.legend.ovulation' },
    { cls: 'is-today', key: 'health.cycle.legend.today' },
  ];
  return `<div class="cycle-legend">${items.map((i) => `
    <span class="cycle-legend__item"><span class="cycle-legend__swatch ${i.cls}"></span>${esc(t(i.key))}</span>`).join('')}</div>`;
}

// --------------------------------------------------------
// Perioden-Verlauf
// --------------------------------------------------------

function cycleHistoryMarkup(own) {
  const asc = [...cycle.periods].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  const nextStartById = new Map();
  for (let i = 0; i < asc.length - 1; i += 1) nextStartById.set(asc[i].id, asc[i + 1].start_date);
  const rows = [...asc].reverse();

  if (!rows.length) return '';

  return `
    <section class="cycle-history">
      <h3 class="cycle-section__title u-toolbar-title">${esc(t('health.cycle.history.title'))}</h3>
      <ul class="cycle-history__list">${rows.map((p) => {
        const start = String(p.start_date).slice(0, 10);
        const end = p.end_date ? String(p.end_date).slice(0, 10) : null;
        const rangeLabel = end ? `${formatDate(start)} – ${formatDate(end)}` : formatDate(start);
        const lenDays = end ? (Math.round((Date.parse(`${end}T00:00Z`) - Date.parse(`${start}T00:00Z`)) / 86400000) + 1) : null;
        const nextStart = nextStartById.get(p.id);
        const cycleLen = nextStart ? Math.round((Date.parse(`${String(nextStart).slice(0, 10)}T00:00Z`) - Date.parse(`${start}T00:00Z`)) / 86400000) : null;
        const meta = [];
        if (lenDays != null) meta.push(t('health.cycle.unit.days', { value: fmtNum(lenDays) }));
        else meta.push(t('health.cycle.history.ongoing'));
        if (cycleLen != null) meta.push(t('health.cycle.history.cycleLength', { value: fmtNum(cycleLen) }));
        const editBtn = own
          ? `<button type="button" class="btn btn--icon btn--sm" data-cycle-edit="${esc(p.id)}" aria-label="${esc(t('health.cycle.period.edit'))}"><i data-lucide="pencil" aria-hidden="true"></i></button>`
          : '';
        return `
          <li class="cycle-history__row">
            <span class="cycle-history__dot" aria-hidden="true"></span>
            <span class="cycle-history__body">
              <span class="cycle-history__range">${esc(rangeLabel)}</span>
              <span class="cycle-history__meta">${meta.map((m) => `<span class="cycle-history__chip">${esc(m)}</span>`).join('')}</span>
            </span>
            ${editBtn}
          </li>`;
      }).join('')}</ul>
    </section>`;
}

function cycleFooterMarkup(own) {
  const q = cycle.personId ? `?user_id=${encodeURIComponent(cycle.personId)}` : '';
  return `
    <div class="cycle-footer">
      <a class="btn btn--ghost btn--sm" href="/api/v1/health/export/cycle${q}" download>
        <i data-lucide="download" aria-hidden="true"></i>${esc(t('health.cycle.export.csv'))}
      </a>
      ${own ? `<button class="btn btn--ghost btn--sm" data-action="cycle-settings"><i data-lucide="settings-2" aria-hidden="true"></i>${esc(t('health.cycle.settings.open'))}</button>` : ''}
    </div>
    ${disclaimerMarkup()}`;
}

// --------------------------------------------------------
// Verdrahtung
// --------------------------------------------------------

function wireCycle() {
  wireTablistKeys(cycle.root);
  cycle.root.querySelectorAll('.health-person-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = Number(chip.dataset.personId);
      if (id === cycle.personId) return;
      cycle.personId = id;
      switchCyclePerson();
    }));

  cycle.root.querySelectorAll('[data-cycle-month]').forEach((btn) =>
    btn.addEventListener('click', () => { stepCycleMonth(Number(btn.dataset.cycleMonth)); renderCycleShell(); }));

  cycle.root.querySelectorAll('[data-cycle-day]').forEach((btn) =>
    btn.addEventListener('click', () => openDayLogModal(btn.dataset.cycleDay)));

  cycle.root.querySelectorAll('[data-cycle-edit]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const p = cycle.periods.find((x) => x.id === Number(btn.dataset.cycleEdit));
      if (p) openPeriodModal(p);
    }));

  cycle.root.querySelector('[data-action="cycle-first"]')?.addEventListener('click', () => openPeriodModal(null));
  cycle.root.querySelector('[data-action="cycle-start-period"]')?.addEventListener('click', () => cycleStartPeriodToday());
  cycle.root.querySelector('[data-action="cycle-end-period"]')?.addEventListener('click', () => cycleEndPeriodToday());
  cycle.root.querySelector('[data-action="cycle-log-today"]')?.addEventListener('click', () => openDayLogModal(toLocalDateKey(new Date())));
  cycle.root.querySelector('[data-action="cycle-settings"]')?.addEventListener('click', () => openCycleSettingsModal());
}

// --------------------------------------------------------
// Perioden-Modal (Anlegen/Bearbeiten inkl. Löschen)
// --------------------------------------------------------

function openPeriodModal(period) {
  const isEdit = Boolean(period && period.id);
  const startVal = isEdit ? String(period.start_date).slice(0, 10) : toLocalDateKey(new Date());
  const endVal = isEdit && period.end_date ? String(period.end_date).slice(0, 10) : '';

  openModal({
    title: isEdit ? t('health.cycle.period.edit') : t('health.cycle.period.add'),
    size: 'sm',
    content: `
      <form id="cycle-period-form" class="form-stack">
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="cycle-start">${esc(t('health.cycle.field.startDate'))}</label>
            <yuvomi-datepicker id="cycle-start" type="date" value="${esc(startVal)}"></yuvomi-datepicker>
          </div>
          <div class="form-field">
            <label class="label" for="cycle-end">${esc(t('health.cycle.field.endDate'))}</label>
            <yuvomi-datepicker id="cycle-end" type="date" value="${esc(endVal)}"></yuvomi-datepicker>
          </div>
        </div>
        <div class="form-field">
          <label class="label" for="cycle-visibility">${esc(t('health.cycle.field.visibility'))}</label>
          <select class="input" id="cycle-visibility">
            <option value="private" ${period?.visibility === 'family' ? '' : 'selected'}>${esc(t('health.cycle.visibility.private'))}</option>
            <option value="family" ${period?.visibility === 'family' ? 'selected' : ''}>${esc(t('health.cycle.visibility.family'))}</option>
          </select>
        </div>
        <div class="form-field">
          <label class="label" for="cycle-note">${esc(t('health.cycle.field.note'))}</label>
          <textarea class="input" id="cycle-note" rows="2" maxlength="2000">${esc(period?.note || '')}</textarea>
        </div>
        <div class="modal-actions">
          ${isEdit ? `<button type="button" class="btn btn--danger btn--ghost" data-action="cycle-delete-period">${esc(t('common.delete'))}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="cycle-delete-period"]')?.addEventListener('click', () => deletePeriod(period));
      panel.querySelector('#cycle-period-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const start = panel.querySelector('#cycle-start').value;
        const end = panel.querySelector('#cycle-end').value;
        if (!start) { window.yuvomi?.showToast(t('health.cycle.invalid'), 'danger'); return; }
        if (end && end < start) { window.yuvomi?.showToast(t('health.cycle.invalid'), 'danger'); return; }
        const body = {
          start_date: start,
          end_date: end || null,
          visibility: panel.querySelector('#cycle-visibility').value || 'private',
          note: panel.querySelector('#cycle-note').value.trim() || null,
        };
        submitBtn.disabled = true;
        try {
          if (isEdit) await api.patch(`/health/cycle/periods/${period.id}`, body);
          else { await api.post('/health/cycle/periods', body); cycle.anchor = start; }
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.cycle.saved'), 'success');
          await reloadCycle();
        } catch (err) {
          console.error('[Health] cycle period save error:', err);
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.cycle.saveError'), 'danger');
        }
      });
    },
  });
}

async function deletePeriod(period) {
  if (!period?.id) return;
  if (!(await confirmModal(t('health.cycle.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') }))) return;
  try {
    await api.delete(`/health/cycle/periods/${period.id}`);
    closeModal({ force: true });
    window.yuvomi?.showToast(t('health.cycle.deleted'), 'success');
    await reloadCycle();
  } catch (err) {
    console.error('[Health] cycle period delete error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.cycle.deleteError'), 'danger');
  }
}

// --------------------------------------------------------
// Tages-Log-Modal (Flow, Symptome, Stimmung)
// --------------------------------------------------------

function openDayLogModal(dateKey) {
  const key = String(dateKey).slice(0, 10);
  const existing = cycle.logs.find((l) => String(l.log_date).slice(0, 10) === key) || null;
  const activeSymptoms = new Set((existing?.symptoms ? String(existing.symptoms).split(',') : []).filter(Boolean));
  const currentFlow = existing?.flow || '';
  const currentMood = existing?.mood || '';

  const flowButtons = [{ value: '', labelKey: 'health.cycle.flow.none' }, ...FLOW_LEVELS.map((f) => ({ value: f.value, labelKey: f.labelKey }))]
    .map((f) => `<button type="button" class="cycle-choice" data-flow="${esc(f.value)}" aria-pressed="${f.value === currentFlow}">${esc(t(f.labelKey))}</button>`).join('');

  const symptomButtons = SYMPTOM_TYPES.map((s) =>
    `<button type="button" class="cycle-choice cycle-choice--chip" data-symptom="${esc(s.value)}" aria-pressed="${activeSymptoms.has(s.value)}">
      <i data-lucide="${esc(s.icon)}" aria-hidden="true"></i>${esc(t(s.labelKey))}</button>`).join('');

  const moodOptions = [`<option value="" ${currentMood ? '' : 'selected'}>${esc(t('health.cycle.mood.none'))}</option>`,
    ...MOOD_TYPES.map((m) => `<option value="${esc(m.value)}" ${m.value === currentMood ? 'selected' : ''}>${esc(t(m.labelKey))}</option>`)].join('');

  openModal({
    title: `${t('health.cycle.dayLog.title')} · ${formatDate(key)}`,
    size: 'md',
    content: `
      <form id="cycle-log-form" class="form-stack">
        <div class="form-field">
          <span class="label">${esc(t('health.cycle.flow.label'))}</span>
          <div class="cycle-choices" data-group="flow" role="group" aria-label="${esc(t('health.cycle.flow.label'))}">${flowButtons}</div>
        </div>
        <div class="form-field">
          <span class="label">${esc(t('health.cycle.symptom.label'))}</span>
          <div class="cycle-choices cycle-choices--wrap" data-group="symptoms">${symptomButtons}</div>
        </div>
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="cycle-mood">${esc(t('health.cycle.mood.label'))}</label>
            <select class="input" id="cycle-mood">${moodOptions}</select>
          </div>
          <div class="form-field">
            <label class="label" for="cycle-log-visibility">${esc(t('health.cycle.field.visibility'))}</label>
            <select class="input" id="cycle-log-visibility">
              <option value="private" ${existing?.visibility === 'family' ? '' : 'selected'}>${esc(t('health.cycle.visibility.private'))}</option>
              <option value="family" ${existing?.visibility === 'family' ? 'selected' : ''}>${esc(t('health.cycle.visibility.family'))}</option>
            </select>
          </div>
        </div>
        <div class="form-field">
          <label class="label" for="cycle-log-note">${esc(t('health.cycle.field.note'))}</label>
          <textarea class="input" id="cycle-log-note" rows="2" maxlength="2000">${esc(existing?.note || '')}</textarea>
        </div>
        <div class="modal-actions">
          ${existing ? `<button type="button" class="btn btn--danger btn--ghost" data-action="cycle-delete-log">${esc(t('common.delete'))}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      // Flow: Einfachauswahl (Toggle). Symptome: Mehrfachauswahl.
      panel.querySelectorAll('[data-group="flow"] .cycle-choice').forEach((btn) =>
        btn.addEventListener('click', () => {
          const on = btn.getAttribute('aria-pressed') === 'true';
          panel.querySelectorAll('[data-group="flow"] .cycle-choice').forEach((b) => b.setAttribute('aria-pressed', 'false'));
          btn.setAttribute('aria-pressed', on ? 'false' : 'true');
        }));
      panel.querySelectorAll('[data-symptom]').forEach((btn) =>
        btn.addEventListener('click', () => btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')));

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="cycle-delete-log"]')?.addEventListener('click', () => deleteDayLog(existing));

      panel.querySelector('#cycle-log-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const flowBtn = panel.querySelector('[data-group="flow"] .cycle-choice[aria-pressed="true"]');
        const symptoms = [...panel.querySelectorAll('[data-symptom][aria-pressed="true"]')].map((b) => b.dataset.symptom);
        const body = {
          log_date: key,
          flow: flowBtn?.dataset.flow || '',
          symptoms,
          mood: panel.querySelector('#cycle-mood').value || null,
          visibility: panel.querySelector('#cycle-log-visibility').value || 'private',
          note: panel.querySelector('#cycle-log-note').value.trim() || null,
        };
        submitBtn.disabled = true;
        try {
          await api.post('/health/cycle/logs', body);
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.cycle.saved'), 'success');
          await reloadCycle();
        } catch (err) {
          console.error('[Health] cycle log save error:', err);
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.cycle.saveError'), 'danger');
        }
      });
    },
  });
}

async function deleteDayLog(log) {
  if (!log?.id) return;
  if (!(await confirmModal(t('health.cycle.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') }))) return;
  try {
    await api.delete(`/health/cycle/logs/${log.id}`);
    closeModal({ force: true });
    window.yuvomi?.showToast(t('health.cycle.deleted'), 'success');
    await reloadCycle();
  } catch (err) {
    console.error('[Health] cycle log delete error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.cycle.deleteError'), 'danger');
  }
}

// --------------------------------------------------------
// Einstellungs-Modal (persönliche Vorhersage-Parameter)
// --------------------------------------------------------

function openCycleSettingsModal() {
  const s = cycle.settings || {};
  const val = (v) => (v == null ? '' : String(v));
  const stats = cycleStats(cycle.periods, s);
  // Plausibilitäts-Fenster für den Entbindungstermin: knapp in der Vergangenheit
  // (gerade entbunden/überfällig) bis ~40 Wochen voraus (frisch schwanger). Hält
  // die SSW-/Countdown-Mathematik sinnvoll, verhindert absurde Eingaben.
  const dueTodayKey = toLocalDateKey(new Date());
  const dueMin = addLocalDays(dueTodayKey, -40);
  const dueMax = addLocalDays(dueTodayKey, 300);

  openModal({
    title: t('health.cycle.settings.title'),
    size: 'sm',
    content: `
      <form id="cycle-settings-form" class="form-stack">
        <div class="form-field">
          <label class="label" for="cs-cycle">${esc(t('health.cycle.settings.cycleLength'))}</label>
          <input class="input" id="cs-cycle" type="number" inputmode="numeric" min="15" max="60" step="1"
            placeholder="${esc(fmtNum(stats.avgCycle))}" value="${esc(val(s.cycle_length_avg))}">
        </div>
        <div class="form-field">
          <label class="label" for="cs-period">${esc(t('health.cycle.settings.periodLength'))}</label>
          <input class="input" id="cs-period" type="number" inputmode="numeric" min="1" max="15" step="1"
            placeholder="${esc(fmtNum(stats.avgPeriod))}" value="${esc(val(s.period_length_avg))}">
        </div>
        <div class="form-field">
          <label class="label" for="cs-luteal">${esc(t('health.cycle.settings.lutealLength'))}</label>
          <input class="input" id="cs-luteal" type="number" inputmode="numeric" min="8" max="18" step="1"
            value="${esc(val(s.luteal_length ?? 14))}">
        </div>
        <label class="cycle-toggle">
          <input type="checkbox" id="cs-fertility" ${s.track_fertility === 0 ? '' : 'checked'}>
          <span>${esc(t('health.cycle.settings.trackFertility'))}</span>
        </label>
        <p class="cycle-hint">${esc(t('health.cycle.settings.autoHint'))}</p>
        <hr class="cycle-settings__sep">
        <label class="cycle-toggle">
          <input type="checkbox" id="cs-pregnancy" ${s.pregnancy_mode ? 'checked' : ''}>
          <span>${esc(t('health.cycle.settings.pregnancyMode'))}</span>
        </label>
        <div class="form-field" id="cs-due-field" ${s.pregnancy_mode ? '' : 'hidden'}>
          <label class="label" for="cs-due">${esc(t('health.cycle.settings.dueDate'))}</label>
          <yuvomi-datepicker id="cs-due" type="date" value="${esc(s.pregnancy_due_date || '')}" min="${esc(dueMin)}" max="${esc(dueMax)}"></yuvomi-datepicker>
        </div>
        <p class="cycle-hint">${esc(t('health.cycle.settings.pregnancyHint'))}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      // Datumsfeld nur zeigen, wenn der Schwangerschafts-Modus aktiv ist.
      const pregToggle = panel.querySelector('#cs-pregnancy');
      const dueField = panel.querySelector('#cs-due-field');
      pregToggle?.addEventListener('change', () => { dueField.hidden = !pregToggle.checked; });
      panel.querySelector('#cycle-settings-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const numOr = (sel) => { const raw = panel.querySelector(sel).value.trim(); return raw === '' ? null : Number(raw); };
        const pregnant = pregToggle.checked;
        const due = (panel.querySelector('#cs-due').value || '').trim();
        const body = {
          cycle_length_avg: numOr('#cs-cycle'),
          period_length_avg: numOr('#cs-period'),
          luteal_length: numOr('#cs-luteal') ?? 14,
          track_fertility: panel.querySelector('#cs-fertility').checked,
          pregnancy_mode: pregnant,
          // Termin auch beim Ausschalten behalten (nur im aktiven Modus genutzt) —
          // versehentliches Umschalten löscht die Eingabe dann nicht.
          pregnancy_due_date: due || null,
        };
        submitBtn.disabled = true;
        try {
          cycle.settings = (await api.put('/health/cycle/settings', body)).data || body;
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.cycle.settings.saved'), 'success');
          renderCycleShell();
        } catch (err) {
          console.error('[Health] cycle settings save error:', err);
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.cycle.saveError'), 'danger');
        }
      });
    },
  });
}
