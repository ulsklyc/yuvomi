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
import { CHART, chartScales, chartGridMarkup, chartXLabelsMarkup, chartX, chartY } from '/utils/chart.js';
import { scheduleUndoableDelete } from '/utils/ux.js';
import { toLocalDateKey, parseLocalDateKey, addLocalDays, todayKey} from '/utils/date.js';
import { zonedDateKey } from '/utils/timezone.js';
import { nowFields } from '/utils/timezone.js';
import { trendMarkup } from '/utils/metric-card.js';
import { openModal, closeModal, confirmModal, confirmOverModal, reportFieldError, advancedSection, refocusAfterRender } from '/components/modal.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import {
  computeVitalSeries, VITAL_METRICS, vitalMetric,
  MOOD_SCALE, moodStep, splitDuration, durationToHours,
} from '/utils/health-vitals.js';
import {
  computeDueDoses, computeAdherence, refillState,
  daysMaskToIndices, indicesToDaysMask, WEEKDAY_COUNT,
  prnDoseState, splitRemaining, toLocalStamp, parseLogInstant, scheduledLogs,
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
  predictCycle, cycleStats, buildCycleCalendar, cycleRing, MIN_HISTORY_GAPS,
  normalizeSymptomEntries, symptomIntensityLabelKey,
  cycleLengthTrend, symptomFrequencyByPhase, bbtSeries, symptomIntensityTrend,
  symptomCyclePattern, TYPICAL_CYCLE_RANGE, isTypicalCycleLength,
  predictSymptomLikelihood,
} from '/utils/health-cycle.js';
import { HEALTH_ROUTES, renderHealthTabsBar } from '/utils/health-tabs.js';
import { emptyStateHTML, emptyHintHTML, mountLoadError } from '/utils/empty-state.js';

let _container = null;

/**
 * Ladefehler eines Gesundheits-Bereichs.
 *
 * Die sechs Bereiche (Werte, Medikamente, Labor, Aktivitaet, Uebersicht,
 * Zyklus) trugen denselben Block sechsmal als Kopie - und alle sechs waren
 * dieselbe halbe Sache: ein `.empty-state` ohne `role="alert"`, also fuer einen
 * Screenreader stumm, und ohne die technische Zeile, obwohl der gefangene
 * Fehler danebenstand. Sechs Kopien heisst auch: eine Korrektur haette sechsmal
 * gemacht werden muessen.
 *
 * Die Textschluessel folgen dem Bereichsnamen (`health.<area>.loadError`,
 * `.loadErrorDesc`, `.retry`); das war schon vorher so und traegt den Helfer.
 *
 * @param {{root: HTMLElement, error: unknown}} area   Bereichs-State.
 * @param {string}   name    Schluessel-Praefix, z. B. 'vitals'.
 * @param {Function} onRetry Der Mount des Bereichs.
 */
function mountAreaLoadError(area, name, onRetry) {
  mountLoadError(area.root, {
    title: t(`health.${name}.loadError`),
    description: t(`health.${name}.loadErrorDesc`),
    error: area.error,
    retryLabel: t(`health.${name}.retry`),
    onRetry,
  });
}

// Sichtbarkeit des Zyklus-Tabs. Zwei Schalter greifen ineinander: der Haushalt
// erlaubt ihn (Settings → Module → Gesundheit, Admin), und jede Person kann ihn
// für sich abwählen (Settings → Persönlich → Gesundheit, #760). `_effective` ist
// die bereits verrechnete Sicht - der Client verrechnet sie NICHT selbst nach,
// damit die Regel an genau einer Stelle steht. Default an, damit Bestandskonten
// ihr Verhalten behalten; wird in render() aus /preferences aufgefrischt.
let cycleEnabled = true;

async function loadHealthPrefs() {
  try {
    const res = await api.get('/preferences');
    cycleEnabled = res?.data?.health_cycle_effective !== false;
  } catch {
    cycleEnabled = true;
  }
}

// Die persoenliche Standard-Sichtbarkeit je Bereich (#958). Wie `careFor`
// einmal je Seitenaufruf geladen und von allen vier Tabs geteilt: sie haengt an
// der Person, nicht am Tab.
//
// SPARSE wie serverseitig - was hier fehlt, ist 'private'. Faellt die Abfrage
// aus, bleibt die Karte leer und jedes Formular steht auf 'privat': der engere
// Wert ist der richtige Ausgang, wenn man die Wahl gerade nicht kennt.
let visibilityDefaults = {};

/** Was das Formular dieses Bereichs vorauswaehlt. */
function defaultVisibility(scopeKey) {
  return visibilityDefaults[scopeKey] === 'family' ? 'family' : 'private';
}

/** Scope-Schluessel einer Vitalmetrik - dieselbe Schreibweise wie im Server. */
function vitalScopeKey(type) {
  return `vital:${String(type || '')}`;
}

async function loadVisibilityDefaults() {
  try {
    visibilityDefaults = (await api.get('/health/visibility-defaults'))?.data?.defaults || {};
  } catch {
    visibilityDefaults = {};
  }
}

// Personen, für die diese Person eintragen darf (#584). Einmal je Seitenaufruf
// geladen und für alle Tabs geteilt - die Betreuung hängt am Nutzer, nicht am Tab.
let careFor = [];

async function loadCareGrants() {
  try {
    const res = await api.get('/health/caregivers/me');
    careFor = Array.isArray(res?.data) ? res.data : [];
  } catch {
    // Keine Auskunft heißt keine Betreuung: im Zweifel weniger Rechte anzeigen,
    // nicht mehr. Ein Schreibversuch scheiterte ohnehin serverseitig.
    careFor = [];
  }
}

/**
 * Darf in der Ansicht dieser Person geschrieben werden - eigene Daten oder die
 * einer betreuten Person? Ersetzt die fünf gleichlautenden `isOwn*View()`, die
 * jeder Tab für sich trug; geblieben ist `isOwnCycleView()`, denn dort stellt
 * sich weiterhin die andere Frage ("bin ich das selbst?") - der Zyklus-Tab ist
 * von der Betreuung bewusst ausgenommen.
 */
function canEditFor(personId, meId) {
  if (personId == null) return false;
  return personId === meId || careFor.includes(personId);
}

/**
 * Eigentümer-Feld für einen POST: nur gesetzt, wenn für eine andere Person
 * eingetragen wird. Ohne das Feld verhält sich die API wie bisher.
 */
function ownerField(personId, meId) {
  return personId != null && personId !== meId ? { user_id: personId } : {};
}

// Vitalwerte-View-Zustand. Eine einzige Messungs-Liste (alle Typen) je Person;
// Karten und Chart werden clientseitig daraus abgeleitet.
const vitals = {
  meId: null,
  personId: null,
  members: [],
  rows: [],
  range: 'month',
  anchor: todayKey(),
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

// Die Chart-Geometrie STAND HIER und ist nach `utils/chart.js` gezogen: sie
// loeste den Fall fuer die drei Charts dieses Moduls, und dieselbe Aufgabe
// stellte sich dem Budget-Trend und dem Abo-Flaechenchart - beide haben sie je
// eigen und je falscher beantwortet (Achse ausserhalb des SVG, verzerrende
// Skalierung). Was hier bleibt, ist das VOKABULAR: wie ein Achsenwert dieses
// Moduls aussieht, weiss nur dieses Modul.
const chartGridFor = (min, max, metric) => chartGridMarkup(min, max, (val, wholeTicks) => axisTickText(metric, val, wholeTicks));

// Achsen-Tick. Eine Dauer darf hier nicht dezimal stehen: „8,4" neben einer
// Verlaufszeile mit „8 Std. 24 Min." wäre dieselbe Größe in zwei Zahlensystemen.
// Kompakt (8:24) statt ausgeschrieben, weil eine Y-Achse keinen Platz für Wörter
// hat - die Zahl bleibt dabei dieselbe.
function axisTickText(metric, value, wholeTicks) {
  if (metric?.format === 'duration') {
    const parts = splitDuration(value);
    if (!parts) return '–';
    return `${fmtNum(parts.hours, { maximumFractionDigits: 0 })}:${String(parts.minutes).padStart(2, '0')}`;
  }
  // Die Stimmungs-Skala kennt nur ganze Stufen; Zwischenwerte an der Achse
  // wären eine Genauigkeit, die es in der Erfassung nicht gibt.
  if (metric?.format === 'scale') return fmtNum(Math.round(value), { maximumFractionDigits: 0 });
  return fmtNum(wholeTicks ? Math.round(value) : value);
}

// Die Auswahl der drei Marken und ihre Ausrichtung stehen in `utils/chart.js`;
// hier steht nur, dass die Beschriftung dieses Moduls ein DATUM ist.
const chartXLabels = (dates) => chartXLabelsMarkup(dates.map((d) => formatDate(d)));

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
    : emptyStateHTML({
      icon: panel.icon,
      title: t(panel.emptyTitleKey),
      description: t(panel.emptyDescKey),
    });

  // Eigenes data-health-panel-Attribut statt des (per Frontend-Audit gesperrten)
  // Legacy-„data-panel". Über dieses Attribut reicht health-tabs.js die Panels an
  // renderSubTabs weiter (`panelFor`); von dort kommen `id`, `aria-labelledby` zum
  // zugehörigen Tab und der Hidden-Zustand. Rolle und `aria-label` stehen hier
  // trotzdem: sie tragen das Panel in dem Moment zwischen Markup-Einbau und
  // Leisten-Render, in dem die Verknüpfung noch nicht steht. Danach ersetzt der
  // Tabname das Label (zwei Namen wären einer zu viel).
  return `
    <section class="health-panel" data-health-panel="${esc(panel.route)}"
             role="tabpanel" aria-label="${esc(t(panel.titleKey))}" ${hidden}>
      <!-- Der Panel-Titel steht sichtbar schon in der Sub-Tab-Leiste darueber:
           alle sechs Panels wiederholten ihn wortgleich als h2 direkt darunter
           ("Uebersicht" ueber "Uebersicht"), also verdoppelte der Kopf
           Information, statt eine Ebene zu benennen (Finish-Review Runde 4,
           Befund 6). Dieselbe Regel hat die Einstellungen schon einmal
           eingeholt - der Guard dazu prueft sie jetzt fuer beide.
           Als Ueberschrift bleibt er stehen, nur unsichtbar: er haelt die
           Dokumentgliederung zwischen dem h1 des Moduls und den h3 der
           Abschnitte, und das tabpanel traegt denselben Namen im aria-label. -->
      <h2 class="health-panel__title sr-only">${esc(t(panel.titleKey))}</h2>
      ${body}
    </section>
  `;
}

// Kein eigenes showPanel() mehr: Auswahl und Panel-Sichtbarkeit sind EINE
// Operation (WAI-ARIA APG „Tabs"), und sie gehört dorthin, wo auch
// `aria-selected` gesetzt wird - in renderSubTabs. Zwei Besitzer für denselben
// Zustand sind genau die Naht, an der `aria-selected` und `hidden` auseinander
// laufen können.

// Routen-basierter Kontext-FAB: die Primäraktion folgt der aktiven Health-Route.
// Auf der Übersicht (keine Erstellen-Aktion) ausgeblendet.
let _fab = null;

function updateHealthFab(activeRoute) {
  if (!_fab) return;
  // Gating spiegelt die früheren Inline-„Hinzufügen"-Buttons: Erstellen in der
  // eigenen Ansicht und in der einer betreuten Person (#584), in allen übrigen
  // (read-only) Ansichten kein FAB. Der Zyklus-Tab bleibt bei isOwnCycleView() -
  // er ist von der Betreuung ausgenommen.
  switch (activeRoute) {
    case '/health/vitals':
      setPageFabAction(_fab, { hidden: !canEditFor(vitals.personId, vitals.meId), label: t('health.vitals.add'), onClick: () => openVitalModal() }); break;
    case '/health/cycle':
      setPageFabAction(_fab, { hidden: !isOwnCycleView(), label: t('health.cycle.add'), onClick: () => openPeriodModal(null) }); break;
    case '/health/meds':
      setPageFabAction(_fab, { hidden: !canEditFor(meds.personId, meds.meId), label: t('health.meds.add'), onClick: () => openMedModal(null) }); break;
    case '/health/labs':
      setPageFabAction(_fab, { hidden: !canEditFor(labs.personId, labs.meId), label: t('health.labs.add'), onClick: () => openLabModal(null) }); break;
    case '/health/activity':
      setPageFabAction(_fab, { hidden: !canEditFor(activity.personId, activity.meId), label: t('health.activity.add'), onClick: () => openActivityModal(null) }); break;
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
  await Promise.all([loadHealthPrefs(), loadCareGrants(), loadVisibilityDefaults()]);
  const activeRoute = normalizeHealthPath(window.location.pathname);
  const panels = PANELS().filter((panel) => cycleEnabled || panel.route !== '/health/cycle');

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="health-page app-page app-page--dashboard" data-composition="dashboard">
      <!-- Kanonischer Modulkopf: die Sub-Tab-Leiste wechselt eine SICHT
           innerhalb der Gesundheit (alle Health-Routen tragen module: 'health'),
           also steht der Modulname als Large Title ueber ihr - dasselbe Muster
           wie Budget, Belohnungen und Haushaltshilfe. renderHealthTabsBar haengt
           die Leiste als zweite Zeile in diesen Kopf. -->
      <header class="page-toolbar health-toolbar">
        <h1 class="page-toolbar__title">${esc(t('nav.health'))}</h1>
      </header>
      ${panels.map((panel) => panelMarkup(panel, activeRoute)).join('')}
    </div>
  `);

  _fab = createPageFab({ id: 'health-fab' });
  container.querySelector('.health-page').appendChild(_fab);

  if (window.lucide) window.lucide.createIcons({ el: container });
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
    vitals.error = err;
  }
  vitals.loaded = true;
  renderVitalsShell();
}

async function loadVitals() {
  const query = vitals.personId ? `?user_id=${encodeURIComponent(vitals.personId)}` : '';
  const res = await api.get(`/health/vitals${query}`);
  vitals.rows = res.data || [];
}

function renderVitalsShell() {
  if (!vitals.root?.isConnected) return;
  vitals.root.replaceChildren();

  if (vitals.error) {
    mountAreaLoadError(vitals, 'vitals', mountVitals);
    return;
  }

  vitals.root.insertAdjacentHTML('beforeend', `
    ${personSwitcherMarkup(vitals.members, vitals.personId, vitals.meId,
      { menuId: 'health-person-menu-vitals', label: t('health.vitals.personsLabel') })}
    ${readOnlyBannerMarkup(vitals.members, vitals.personId, canEditFor(vitals.personId, vitals.meId), vitals.meId)}
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

// Geteilter Personen-Umschalter: EIN Knopf mit der aktiven Person statt einer
// Dauer-Pillenzeile (Critique 2026-08-31: 6 Ansichts-Tabs + 4 Personen-Pillen
// = 10 Wahlmoeglichkeiten vor dem ersten Inhalt, mobil eine volle 48px-Zeile).
// Die aktive Person bleibt am Knopf sichtbar (Wiedererkennen statt Erinnern);
// das Menue ist das geteilte popover-menu-Vokabular mit role=menuitemradio -
// dieselbe Bauart wie der Rezepte-Quellenfilter. Ein Haushalt mit nur einer
// sichtbaren Person bekommt keinen Umschalter: die eigene Ansicht ist die
// einzige, und ein Menue mit einem Eintrag waere Chrome ohne Auskunft.
function personSwitcherMarkup(members, activeId, meId, { menuId, label }) {
  const list = members || [];
  if (list.length <= 1) return '';
  const nameOf = (m) => (m.id === meId
    ? `${m.display_name} · ${t('health.vitals.you')}`
    : m.display_name);
  const dotOf = (m) => `<span class="health-person-chip__dot" aria-hidden="true"
          style="background:${esc(m.avatar_color) || 'var(--module-health)'}"></span>`;
  const active = list.find((m) => m.id === activeId) ?? list[0];
  return `
    <div class="health-person-switcher">
      <button type="button" class="health-person-switcher__trigger popover-menu__trigger"
              popovertarget="${esc(menuId)}" aria-haspopup="menu" aria-expanded="false"
              aria-label="${esc(label)}: ${esc(nameOf(active))}">
        ${dotOf(active)}
        <span class="health-person-switcher__name">${esc(nameOf(active))}</span>
        <i data-lucide="chevron-down" class="icon-sm health-person-switcher__chevron" aria-hidden="true"></i>
      </button>
      <div class="popover-menu" id="${esc(menuId)}" popover role="menu" aria-label="${esc(label)}">
        ${list.map((m) => `
          <button type="button" role="menuitemradio" aria-checked="${m.id === activeId}"
                  class="popover-menu__item" data-person-id="${esc(m.id)}">
            <i data-lucide="check" class="icon-md popover-menu__item-check${m.id === activeId ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>
            ${dotOf(m)}
            <span>${esc(nameOf(m))}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

/**
 * Verdrahtet den Personen-Umschalter - und gibt den Fokus zurueck.
 *
 * DER RUECKWEG IST DER HALBE FIX. Die Auswahl laedt neu und rendert die ganze
 * Ansicht samt Umschalter neu; der Browser gibt den Fokus beim Schliessen des
 * Popovers zwar an den Trigger zurueck, aber den gibt es dann nicht mehr - der
 * neue ist ein anderer Knoten mit derselben Rolle, und der Fokus faellt auf
 * <body>. Wer per Tastatur die Person wechselt, faengt sonst jedes Mal von
 * vorn an zu tabben, und die Pfeiltasten im Menue waeren eine Bedienung, die
 * beim ersten Gebrauch endet.
 *
 * EINMAL FUER ALLE SECHS ANSICHTEN: dieselben sieben Zeilen standen sechsmal
 * da, einmal je Ansicht - genau die Bauart, an der dieser PR sein
 * Nachzuegler-Muster gemessen hat.
 */
function wirePersonSwitcher(view, onSwitch) {
  view.root.querySelectorAll('.health-person-switcher [data-person-id]').forEach((item) =>
    item.addEventListener('click', async () => {
      const id = Number(item.dataset.personId);
      if (id === view.personId) return;
      view.personId = id;
      await onSwitch();
      view.root.querySelector('.health-person-switcher__trigger')?.focus();
    }));
}

// Hinweis auf den Zustand einer fremden Ansicht. Zwei Fälle, ein Baustein:
// ohne Schreibrecht der bisherige Nur-Lesen-Hinweis (das bloße Fehlen der
// Bearbeiten-Buttons ist leicht zu übersehen), mit Betreuung (#584) stattdessen
// die Ansage, für wen gerade eingetragen wird. Letzteres ist kein Schmuck: die
// Ansicht sieht sonst aus wie die eigene, und ein Fieberwert landet lautlos beim
// falschen Kind. Gibt '' für die eigene Ansicht zurück.
function readOnlyBannerMarkup(members, personId, canEdit, meId) {
  if (personId == null || personId === meId) return '';
  const m = (members || []).find((x) => x.id === personId);
  const name = m ? m.display_name : '';
  if (canEdit) {
    return `
      <div class="health-readonly-banner health-readonly-banner--care" role="status">
        <i data-lucide="pencil-line" aria-hidden="true"></i>
        <span>${esc(t('health.careBanner', { name }))}</span>
      </div>`;
  }
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

// Einfachauswahl über eine .health-choices-Reihe: ein Klick wählt, ein zweiter
// auf dieselbe Stufe wählt wieder ab. `optional: false` lässt die getroffene
// Wahl stehen - für Skalen, bei denen „nichts" keine Aussage ist.
// Delegiert am Container, damit ein neu aufgebauter Inhalt (Metrikwechsel im
// Erfassungs-Dialog) nicht jedes Mal neu verdrahtet werden muss.
function wireChoiceGroup(root, group, { optional = true } = {}) {
  const host = root.querySelector(`[data-group="${group}"]`);
  if (!host) return;
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('.health-choice');
    if (!btn || !host.contains(btn)) return;
    const on = btn.getAttribute('aria-pressed') === 'true';
    host.querySelectorAll('.health-choice').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    btn.setAttribute('aria-pressed', on && optional ? 'false' : 'true');
    // Eine getroffene Wahl beantwortet eine zuvor gemeldete Pflichtfeld-Meldung.
    // reportFieldError() räumt selbst nur bei input/change auf - Ereignisse, die
    // eine Buttonreihe nie feuert, sodass die Meldung sonst rot stehen bliebe.
    const field = host.closest('.form-field');
    if (field?.classList.contains('form-field--error')) {
      field.classList.remove('form-field--error');
      host.querySelectorAll('.health-choice[aria-invalid]').forEach((b) => b.setAttribute('aria-invalid', 'false'));
    }
  });
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
  // Die Personen-Chipzeile (Fade-Affordanz + scrollIntoView) ist hier raus:
  // der Umschalter ist seit 2026-08-31 ein popover-menu-Knopf, keine
  // scrollende Tabliste mehr - siehe personSwitcherMarkup.
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
  installPopoverMenus(vitals.root);
  wirePersonSwitcher(vitals, switchPerson);

  vitals.root.querySelectorAll('.health-vitals__range').forEach((btn) =>
    btn.addEventListener('click', () => {
      vitals.range = btn.dataset.range;
      renderVitalsShell();
    }));

}

async function switchPerson() {
  vitals.anchor = todayKey();
  try {
    await loadVitals();
    vitals.error = false;
  } catch (err) {
    console.error('[Health] vitals load error:', err);
    vitals.error = err;
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

  host.querySelectorAll('.metric-card--select').forEach((card) =>
    card.addEventListener('click', () => {
      vitals.selectedType = card.dataset.type;
      host.querySelectorAll('.metric-card--select').forEach((c) => {
        const on = c.dataset.type === vitals.selectedType;
        c.classList.toggle('is-active', on);
        // aria-pressed muss den Toggle mitgehen - vorher blieb der beim
        // Render gesetzte Wert stehen und log nach dem ersten Klick.
        c.setAttribute('aria-pressed', String(on));
      });
      renderDetail();
    }));
}

function cardMarkup(metric, series) {
  const active = metric.type === vitals.selectedType;
  const latest = series.latest;
  const label = t(metric.labelKey);

  let valueHtml;
  let metaHtml = `<span class="metric-card__note">${esc(t('health.vitals.noValue'))}</span>`;

  if (latest) {
    const unit = esc(vitalUnitText(metric, latest));
    const valueText = vitalValueText(metric, latest);
    valueHtml = `<span class="metric-card__value">${esc(valueText)}</span>${unit ? ` <span class="metric-card__unit">${unit}</span>` : ''}`;
    metaHtml = `
      <span class="metric-card__meta">
        ${deltaMarkup(series.deltas.value_num, metric)}
        <span>${esc(formatDate(String(latest.measured_at).slice(0, 10)))}</span>
      </span>`;
  } else {
    valueHtml = '<span class="metric-card__value metric-card__value--empty">–</span>';
  }

  return `
    <button type="button" class="metric-card metric-card--select${active ? ' is-active' : ''}" data-type="${esc(metric.type)}"
      aria-pressed="${active}">
      <span class="metric-card__head">
        <i data-lucide="${esc(metric.icon)}" class="metric-card__icon" aria-hidden="true"></i>
        <span class="metric-card__label">${esc(label)}</span>
      </span>
      <span class="metric-card__body">${valueHtml}</span>
      ${latest ? sparklineMarkup(series.points, 'value_num', metric) : ''}
      ${metaHtml}
    </button>`;
}

// Mini-Trendlinie für die Metrik-Karte: gibt der Karte Sub-Domänen-Charakter, ohne
// den vollen Chart zu wiederholen. Rein dekorativ (aria-hidden) — die exakten Werte
// liefern Karte, Detail-Chart und Screenreader-Tabelle. Nur bei ≥2 Datenpunkten.
function sparklineMarkup(points, key, metric) {
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
  // Feste Skala auch hier: sonst zeigte die Mini-Linie einer Karte einen
  // anderen Verlauf als der Chart darunter, aus denselben Werten.
  if (metric?.domain) ({ min, max } = metric.domain);
  if (min === max) { min -= 1; max += 1; }
  const n = withVal.length;
  const x = (idx) => PAD + (idx * (W - 2 * PAD)) / (n - 1);
  const y = (v) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD);
  const pts = withVal.map((o, idx) => `${x(idx).toFixed(1)},${y(o.v).toFixed(1)}`).join(' ');
  const lastX = x(n - 1).toFixed(1);
  const lastY = y(withVal[n - 1].v).toFixed(1);
  // Farbe steht in panel.css am geteilten Bauteil, nicht hier: sie ist eine
  // Aussage über den WERT und gehört deshalb der Karte, nicht dem Modul.
  return `<svg class="metric-card__spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      <circle cx="${lastX}" cy="${lastY}" r="2" vector-effect="non-scaling-stroke" />
    </svg>`;
}

function deltaMarkup(delta, metric) {
  if (delta === null || delta === undefined) return '<span class="metric-card__trend"></span>';
  // betterWhen bleibt null: „hoch" ist je nach Metrik gut ODER schlecht
  // (Gewichtsabnahme, SpO₂, Glukose-Kontrolle) - die Farbe bleibt neutral,
  // die Richtung trägt allein der Pfeil (utils/metric-card.js).
  return trendMarkup({ delta, text: esc(fmtVitalDelta(metric, delta)) });
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
      ${series.hasData
    ? chartMarkup(metric, series)
    : emptyHintHTML(t('health.vitals.noData'), { className: 'health-chart-empty' })}
    </div>
    ${recentMeasurementsMarkup(metric)}`);
  if (window.lucide) window.lucide.createIcons({ el: host });

  host.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      stepAnchor(Number(btn.dataset.step));
      renderVitalsShell();
    }));

  // Korrekturpfad (Audit R2, A2-08): Einzelmessungen sind lösch-, damit
  // korrigierbar (löschen + neu erfassen). Undo-Toast statt Confirm (Hausmuster).
  host.querySelectorAll('[data-delete-vital]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.deleteVital);
      const idx = vitals.rows.findIndex((r) => r.id === id);
      if (idx === -1) return;
      const [row] = vitals.rows.splice(idx, 1);
      renderVitalsShell();
      scheduleUndoableDelete({
        commit: ({ keepalive } = {}) => api.delete(`/health/vitals/${id}`, { keepalive }),
        restore: () => { vitals.rows.splice(idx, 0, row); renderVitalsShell(); },
        message: t('health.vitals.measurementDeleted'),
      });
    }));
}

// Kompakte Historie der gewählten Metrik: jüngste Messungen mit Löschweg
// (nur eigene Ansicht) - macht Tippfehler ohne Umweg korrigierbar.
function recentMeasurementsMarkup(metric) {
  const rows = vitals.rows
    .filter((r) => r.type === metric.type)
    .sort((a, b) => String(b.measured_at).localeCompare(String(a.measured_at)))
    .slice(0, 8);
  if (!rows.length) return '';
  const own = canEditFor(vitals.personId, vitals.meId);
  const valueText = (r) => vitalValueText(metric, r);
  return `
    <div class="health-recent">
      <div class="health-recent__title">${esc(t('health.vitals.recentMeasurements'))}</div>
      <ul class="health-recent__list">
        ${rows.map((r) => `
          <li class="health-recent__row">
            <span class="health-recent__date">${esc(formatDate(String(r.measured_at).slice(0, 10)))}</span>
            <span class="health-recent__value">${esc(valueText(r))}${vitalUnitText(metric, r) ? ` <small>${esc(vitalUnitText(metric, r))}</small>` : ''}</span>
            ${own ? `
            <button type="button" class="row-action row-action--danger" data-delete-vital="${r.id}"
                    aria-label="${esc(t('health.vitals.deleteMeasurement'))}">
              <i data-lucide="trash-2" aria-hidden="true"></i>
            </button>` : ''}
          </li>`).join('')}
      </ul>
    </div>`;
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
    return emptyHintHTML(t('health.vitals.noData'), { className: 'health-chart-empty' });
  }

  // Buckets mit mindestens einem Messwert. Weniger als zwei ergeben keine Kurve —
  // dann ein ehrlicher Low-Data-Hinweis statt eines einzelnen Punkts im Leerraum.
  const dataIdx = pts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => channels.some(({ key }) => p[key] !== null))
    .map(({ i }) => i);
  if (dataIdx.length < 2) {
    return emptyHintHTML(t('health.vitals.sparse'), { className: 'health-chart-empty' });
  }

  const allValues = channels.flatMap(({ key }) => pts.map((p) => p[key]).filter((v) => v !== null));
  let min;
  let max;
  if (metric.domain) {
    // Feste Skala: keine Polsterung, die Grenzen sind die Aussage.
    ({ min, max } = metric.domain);
  } else {
    min = Math.min(...allValues);
    max = Math.max(...allValues);
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const pad = span * 0.1;
    min -= pad; max += pad;
  }

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
      dots.push(`<circle cx="${px}" cy="${py}" r="3.5" fill="${color}"><title>${esc(`${chName} · ${formatDate(p.date)}: ${fmtChannelValue(metric, p[key])}`)}</title></circle>`);
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

  const grid = chartGridFor(min, max, metric);

  // Screenreader-Datentabelle: nur Buckets mit mindestens einem Wert.
  const chLabel = (idx) => (metric.channelLabelKeys?.[idx] ? t(metric.channelLabelKeys[idx]) : t(metric.labelKey));
  const tableHeaders = [t('health.vitals.field.measuredAt'), ...channels.map(({ idx }) => chLabel(idx))];
  const dataPoints = pts.filter((p) => channels.some(({ key }) => p[key] !== null));
  const tableRows = dataPoints
    .map((p) => [formatDate(p.date), ...channels.map(({ key }) => fmtChannelValue(metric, p[key]))]);
  const table = tableRows.length ? chartTableMarkup(t(metric.labelKey), tableHeaders, tableRows) : '';
  const xLabels = chartXLabels(dataPoints.map((p) => p.date));

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

  // Schlaf wird in Stunden und Minuten erfasst, nicht als Dezimalzahl - „7,5"
  // ist eine Rechnung, die der Erfassende sonst im Kopf machen müsste.
  if (metric.format === 'duration') {
    return `
      <div class="modal-grid modal-grid--2">
        <div class="form-field">
          <label class="label" for="vital-hours">${esc(t('health.vitals.field.hours'))}</label>
          <input class="input" id="vital-hours" type="number" inputmode="numeric" step="1" min="0" max="24" required>
        </div>
        <div class="form-field">
          <label class="label" for="vital-minutes">${esc(t('health.vitals.field.minutes'))}</label>
          <input class="input" id="vital-minutes" type="number" inputmode="numeric" step="1" min="0" max="59" value="0">
        </div>
      </div>
      <input type="hidden" id="vital-unit" value="${esc(metric.units[0] || '')}">`;
  }

  // Stimmung als Skala: fünf Gesichter statt eines Zahlenfelds - derselbe
  // Auswahl-Chip wie Flow und Symptome im Zyklus-Tagebuch (.health-choice).
  if (metric.format === 'scale') {
    return `
      <div class="form-field">
        <span class="label">${esc(t('health.vitals.field.mood'))}</span>
        <div class="health-choices health-choices--scale" data-group="mood" role="group"
             aria-label="${esc(t('health.vitals.field.mood'))}">
          ${MOOD_SCALE.map((step) => `
            <button type="button" class="health-choice" data-mood="${esc(step.value)}" aria-pressed="false">
              <i data-lucide="${esc(step.icon)}" aria-hidden="true"></i>
              <span class="health-choice-label">${esc(t(step.labelKey))}</span>
            </button>`).join('')}
        </div>
      </div>
      <input type="hidden" id="vital-unit" value="">`;
  }

  if (metric.format === 'pair') {
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
              <option value="private"${defaultVisibility(vitalScopeKey(vitals.selectedType)) === 'family' ? '' : ' selected'}>${esc(t('health.vitals.visibility.private'))}</option>
              <option value="family"${defaultVisibility(vitalScopeKey(vitals.selectedType)) === 'family' ? ' selected' : ''}>${esc(t('health.vitals.visibility.family'))}</option>
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

      // Die Stimmungs-Skala bringt Icons mit; nach jedem Feldwechsel neu zeichnen.
      // Die Stimmungs-Skala ist eine Einfachauswahl, die stehen bleiben muss:
      // eine abgewählte Stufe wäre kein Eintrag, sondern ein leeres Formular.
      const paintFields = () => {
        if (window.lucide) window.lucide.createIcons({ el: fieldsHost });
        wireChoiceGroup(fieldsHost, 'mood', { optional: false });
      };
      paintFields();

      // Die Voreinstellung haengt an der METRIK (#958): Blutdruck kann
      // familiensichtbar sein und die Stimmung privat. Beim Typwechsel zieht
      // das Feld deshalb mit - aber NUR, solange niemand es selbst angefasst
      // hat. Eine bewusst getroffene Wahl darf ein Typwechsel nicht
      // zurueckdrehen; sie waere sonst weg, ohne dass es jemand sieht.
      const visibilitySelect = panel.querySelector('#vital-visibility');
      let visibilityTouched = false;
      visibilitySelect?.addEventListener('change', () => { visibilityTouched = true; });

      typeSelect.addEventListener('change', () => {
        fieldsHost.replaceChildren();
        fieldsHost.insertAdjacentHTML('beforeend', valueFieldsMarkup(typeSelect.value));
        paintFields();
        if (!visibilityTouched && visibilitySelect) {
          visibilitySelect.value = defaultVisibility(vitalScopeKey(typeSelect.value));
        }
      });

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('[type="submit"]');
        const body = collectVitalBody(panel, typeSelect.value);
        if (!body) {
          submitBtn.disabled = false;
          // Fehler am Wertefeld statt als ortloser Toast (geteiltes Muster,
          // Critique P1): erstes Eingabefeld der Metrik markieren. Bei der
          // Stimmungs-Skala gibt es kein Eingabefeld - dort trägt die erste
          // Stufe die Meldung, das versteckte Einheiten-Feld könnte sie nicht
          // zeigen.
          reportFieldError(
            fieldsHost.querySelector('input:not([type="hidden"])') || fieldsHost.querySelector('.health-choice'),
            t('health.vitals.invalidValue'),
          );
          return;
        }
        submitBtn.disabled = true;
        try {
          await api.post('/health/vitals', { ...body, ...ownerField(vitals.personId, vitals.meId) });
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.vitals.saved'), 'success');
          await reloadAfterSave(body.type);
          await opts.onSaved?.();
          refocusAfterRender();
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
  const metric = vitalMetric(type);

  if (metric?.format === 'duration') {
    const hours = numOrNull(panel.querySelector('#vital-hours'));
    const minutes = numOrNull(panel.querySelector('#vital-minutes'));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    const total = durationToHours(hours || 0, minutes || 0);
    // Null Stunden null Minuten ist keine Nacht, sondern ein leeres Formular.
    if (total === null || total <= 0 || total > 24) return null;
    body.value_num = total;
    body.unit = panel.querySelector('#vital-unit')?.value || undefined;
    return body;
  }

  if (metric?.format === 'scale') {
    const chosen = panel.querySelector('[data-group="mood"] .health-choice[aria-pressed="true"]');
    if (!chosen) return null;
    const step = moodStep(chosen.dataset.mood);
    if (!step) return null;
    body.value_num = step.value;
    return body;
  }

  if (metric?.format === 'pair') {
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
  vitals.anchor = todayKey();
  try {
    await loadVitals();
    vitals.error = false;
  } catch (err) {
    console.error('[Health] vitals reload error:', err);
    vitals.error = err;
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

// --------------------------------------------------------
// Metrik-abhängige Wertdarstellung
// --------------------------------------------------------
// Eine Metrik sagt über `format`, wie ihre Zahlen gelesen werden; Karten,
// Verlaufsliste, Chart-Tooltips und Übersicht fragen ausschließlich hier nach.
// Vorher trug jede dieser Stellen ihren eigenen `type === 'bp'`-Zweig - mit
// Schlaf und Stimmung wären daraus fünf dreifache Verzweigungen geworden.

/** Dezimalstunden als „7 h 30 min". */
function fmtDuration(value) {
  const parts = splitDuration(value);
  if (!parts) return '–';
  const hours = fmtNum(parts.hours, { maximumFractionDigits: 0 });
  const minutes = fmtNum(parts.minutes, { maximumFractionDigits: 0 });
  if (parts.hours && parts.minutes) return t('health.duration.hm', { hours, minutes });
  if (parts.hours) return t('health.duration.h', { hours });
  return t('health.duration.m', { minutes });
}

/** Ein einzelner Kanalwert (Chart-Punkt, Screenreader-Tabelle). */
function fmtChannelValue(metric, value) {
  if (value === null || value === undefined) return '–';
  if (metric?.format === 'duration') return fmtDuration(value);
  if (metric?.format === 'scale') return t(moodStep(value)?.labelKey || 'health.vitals.noValue');
  return fmtNum(value);
}

/** Der Wert einer ganzen Messung, wie er auf Karte und Verlaufszeile steht. */
function vitalValueText(metric, row) {
  if (!row) return '–';
  if (metric?.format === 'pair') return `${fmtNum(row.value_num)}/${fmtNum(row.value_num2)}`;
  return fmtChannelValue(metric, row.value_num);
}

// Die Einheit steckt bei Dauer und Skala schon im Wertetext („7 h 30 min") oder
// existiert gar nicht - sie ein zweites Mal danebenzusetzen ergäbe „7 h 30 min h".
function vitalUnitText(metric, row) {
  if (metric?.format === 'duration' || metric?.format === 'scale') return '';
  return row?.unit || '';
}

/** Delta zum Vorwert. Bei Schlaf in Minuten, weil „+0,5" niemand als Zeit liest. */
function fmtVitalDelta(metric, delta) {
  if (delta === null || delta === undefined) return '';
  if (metric?.format === 'duration') {
    const minutes = Math.round(delta * 60);
    return t('health.duration.m', {
      minutes: getNumberFormat({ maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(minutes),
    });
  }
  return fmtDelta(delta);
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
    meds.error = err;
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

  const today = todayKey();
  await Promise.all(meds.list.map(async (m) => {
    const from = addLocalDays(today, -(medLogWindowDays(m, meds.adherenceDays) - 1));
    const [sRes, lRes] = await Promise.all([
      api.get(`/health/medications/${m.id}/schedules`),
      api.get(`/health/medications/${m.id}/logs?from=${from}T00:00&to=${today}T23:59`),
    ]);
    meds.schedulesByMed[m.id] = sRes.data || [];
    meds.logsByMed[m.id] = lRes.data || [];
  }));
}

/**
 * Wie weit zurueck die Dosis-Eintraege eines Medikaments gelesen werden muessen.
 *
 * Grundlage ist das Adhaerenz-Fenster. Ein Bedarfsmedikament braucht mehr, wenn
 * sein Mindestabstand darueber hinausreicht (erlaubt sind bis zu 28 Tage): der
 * Countdown rechnet aus der LETZTEN Einnahme, und was ausserhalb des Fensters
 * liegt, kommt gar nicht erst an. Der Meds-Tab schriebe dann „Noch nicht
 * genommen", waehrend die Uebersicht mit ihrem groesseren Fenster gleichzeitig
 * den richtigen Zeitpunkt zeigt - und die Zeile, die vor einer zu fruehen Dosis
 * warnen soll, waere die eine, die schweigt.
 */
function medLogWindowDays(med, baseDays) {
  const hours = Number(med?.min_interval_hours);
  if (!med?.prn || !Number.isFinite(hours) || hours <= 0) return baseDays;
  return Math.max(baseDays, Math.ceil(hours / 24) + 1);
}

function allSchedules() {
  return meds.list.flatMap((m) => meds.schedulesByMed[m.id] || []);
}

/**
 * Die Dosen, gegen die sich die Adhaerenz messen laesst - also die GEPLANTEN.
 *
 * `planned` zaehlt Eintraege aus den Einnahmeplaenen; eine Bedarfsdosis gehoert
 * zu keinem und darf deshalb nicht im Zaehler stehen. Sichtbar wurde das erst
 * mit #700: vorher fielen Bedarfsdosen schon am Zeitraumfilter der Route heraus,
 * seit dem Fix kommen sie mit - und drei von sieben geplanten Dosen plus acht
 * Kopfschmerztabletten haetten „100 %, 11 von 11" ergeben.
 */
function allLogsInRange(from, to) {
  const out = [];
  for (const m of meds.list) {
    for (const l of scheduledLogs(meds.logsByMed[m.id])) {
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
    mountAreaLoadError(meds, 'meds', mountMeds);
    return;
  }

  meds.root.insertAdjacentHTML('beforeend', `
    ${personSwitcherMarkup(meds.members, meds.personId, meds.meId,
      { menuId: 'health-person-menu-meds', label: t('health.meds.personsLabel') })}
    ${readOnlyBannerMarkup(meds.members, meds.personId, canEditFor(meds.personId, meds.meId), meds.meId)}
    <div class="health-meds__toolbar">
      <h3 class="health-meds__section-title u-section-title">${esc(t('health.meds.dueToday.title'))}</h3>
    </div>
    <div class="health-meds__due">${dueTodayMarkup()}</div>
    ${prnMeds('meds').length ? `
    <h3 class="health-meds__section-title u-section-title">${esc(t('health.meds.prn.title'))}</h3>
    <div class="health-meds__prn">${prnListMarkup('meds')}</div>` : ''}
    <div class="health-meds__adherence-wrap">${adherenceMarkup()}${medLogHistoryMarkup()}</div>
    <!-- „Alle Medikamente", nicht „Medikamente": der Abschnitt stand unter dem
         gleichnamigen Tab und trug denselben Namen wie das Panel, benannte sich
         also gegen „Heute faellig" gar nicht. Gefunden vom Guard, der die
         Titelwiederholung seit Runde 5 fuer Leiste UND Abschnitt prueft. -->
    <h3 class="health-meds__section-title u-section-title">${esc(t('health.meds.allTitle'))}</h3>
    <div class="health-meds__list" id="health-meds-list">${medListMarkup()}</div>
  `);
  if (window.lucide) window.lucide.createIcons({ el: meds.root });
  wireMeds();
  refreshHealthFab();
}

function dueTodayMarkup() {
  const today = todayKey();
  const due = computeDueDoses(allSchedules(), { from: today, to: today });
  if (!due.length) {
    return emptyHintHTML(t('health.meds.dueToday.empty'));
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
  const own = canEditFor(meds.personId, meds.meId);
  const doseText = dose.dose_qty != null ? ` · ${t('health.meds.doseQty', { count: fmtNum(dose.dose_qty) })}` : '';

  let actions;
  if (status === 'taken') {
    actions = `<span class="health-dose__status health-dose__status--taken"><i data-lucide="check" aria-hidden="true"></i>${esc(t('health.meds.status.taken'))}</span>`;
  } else if (status === 'skipped') {
    actions = `<span class="health-dose__status health-dose__status--skipped"><i data-lucide="x" aria-hidden="true"></i>${esc(t('health.meds.status.skipped'))}</span>`;
  } else if (own) {
    const data = `data-med-id="${esc(dose.medicationId)}" data-schedule-id="${esc(dose.scheduleId ?? '')}" data-scheduled-at="${esc(dose.scheduledAt)}" data-log-id="${esc(log?.id ?? '')}" data-dose="${esc(dose.dose_qty ?? '')}"`;
    actions = `
      <div class="health-dose__actions">
        <button type="button" class="btn btn--sm btn--primary health-dose__take" data-dose-take ${data} aria-label="${esc(t('health.meds.take'))}"><i data-lucide="check" class="icon-sm" aria-hidden="true"></i><span class="health-dose__take-label">${esc(t('health.meds.take'))}</span></button>
        <button type="button" class="btn btn--sm btn--ghost health-dose__skip" data-dose-skip ${data} aria-label="${esc(t('health.meds.skip'))}"><i data-lucide="skip-forward" class="icon-sm" aria-hidden="true"></i><span class="health-dose__skip-label">${esc(t('health.meds.skip'))}</span></button>
      </div>`;
  } else {
    actions = `<span class="health-dose__status">${esc(t('health.meds.status.pending'))}</span>`;
  }

  return `
    <li class="list-row health-dose">
      <span class="health-dose__time">${esc(dose.time)}</span>
      <span class="list-row__name health-dose__name">${esc(name)}${esc(doseText)}</span>
      ${actions}
    </li>`;
}

// --------------------------------------------------------
// Bedarfsmedikation (#700)
//
// „Bei Bedarf" gab es seit jeher als Feld, als Abzeichen und als Spalte - nur
// keinen Knopf: beide Buchungspfade hingen an `data-schedule-id`, und ein
// Bedarfsmedikament hat definitionsgemaess keinen Zeitplan. Yuvomi versprach
// hier etwas, das es nicht einloeste.
//
// Der Abschnitt steht bewusst EINMAL da und wird von beiden Tabs benutzt
// (Medikamente und Uebersicht). Die Datei fuehrt fuer die geplante Dosis zwei
// getrennte Renderer - `dueRowMarkup` und `overviewDueRowMarkup` -, und genau
// dort ist eine Korrektur schon einmal nur in einem der beiden gelandet.
// --------------------------------------------------------

/** Der Datenzugang eines Tabs, damit ein Renderer beiden dient. */
function prnScope(scope) {
  return scope === 'overview'
    ? { list: overview.meds, logs: overview.logsByMed, own: canEditFor(overview.personId, overview.meId), reload: reloadOverview }
    : { list: meds.list,     logs: meds.logsByMed,     own: canEditFor(meds.personId, meds.meId),         reload: reloadMeds };
}

/** Die aktiven Bedarfsmedikamente eines Tabs. */
function prnMeds(scope) {
  return prnScope(scope).list.filter((m) => m.prn && m.active);
}

/** Zeitpunkt lesbar: die Uhrzeit allein nur, wenn sie noch heute liegt. */
function prnWhenLabel(at) {
  // `at` ist ein Zeitpunkt: sein Kalendertag kommt aus der Anzeigezone, nicht aus
  // den Browser-Gettern - sonst vergleicht die Zeile zwei verschiedene Uhren.
  const sameDay = zonedDateKey(at) === todayKey();
  return sameDay ? formatTime(at) : `${formatDate(at)} ${formatTime(at)}`;
}

/** Restdauer als „5 Std. 20 Min." bzw. „20 Min.". */
function prnRemainingLabel(ms) {
  const { hours, minutes } = splitRemaining(ms);
  return hours > 0
    ? t('health.meds.prn.remainingHm', { hours, minutes })
    : t('health.meds.prn.remainingM', { minutes });
}

/**
 * Der Stand als zwei Angaben - die handlungsleitende zuerst.
 *
 * Vorn steht immer die absolute Uhrzeit, weil sie auch in drei Stunden noch
 * stimmt; „noch 5 Std. 20 Min." ist nur in dem Moment richtig, in dem man
 * hinsieht. Die Zweitangabe faellt bei Enge weg (health.css) - dieselbe
 * Antwort, die die geplante Dosis daneben schon gibt, und der volle Satz
 * bleibt am `title`/`aria-label` haengen.
 *
 * @returns {{ lead:string, detail:string, full:string }}
 */
function prnStatusParts(state) {
  if (!state.allowed && state.nextAllowedAt) {
    const lead = t('health.meds.prn.nextAt', { time: prnWhenLabel(state.nextAllowedAt) });
    const detail = prnRemainingLabel(state.remainingMs);
    return { lead, detail, full: `${lead} · ${detail}` };
  }
  if (!state.lastTakenAt) {
    const lead = t('health.meds.prn.never');
    return { lead, detail: '', full: lead };
  }
  const lead = t('health.meds.prn.ready');
  const detail = t('health.meds.prn.lastTaken', { time: prnWhenLabel(state.lastTakenAt) });
  return { lead, detail, full: `${lead} · ${detail}` };
}

/** Die Statuszeile als Markup - eine Quelle fuer Erstaufbau und Minutentakt. */
function prnStatusMarkup(state) {
  const parts = prnStatusParts(state);
  // Der Countdown wird aus `data-prn-next` neu geschrieben, nicht aus einem
  // laufenden Zaehler - deshalb ueberlebt er Reload und Geraetewechsel.
  //
  // Der Zeitpunkt steht NUR am wartenden Stand. `nextAllowedAt` existiert auch,
  // wenn er laengst verstrichen ist, und der Minutentakt liest jedes gesetzte
  // Attribut: eine abgelaufene Zeile haette ihn bei jedem Tick als „gerade
  // abgelaufen" gemeldet und damit im Minutenrhythmus beide Tabs neu gebaut -
  // ein offenes Einnahmeprotokoll klappt dabei zu, Scrollstand und Fokus gehen
  // verloren.
  const countdown = state.allowed ? '' : state.nextAllowedAt.toISOString();
  return `
    <span class="health-prn__status" data-prn-countdown title="${esc(parts.full)}"
          data-prn-next="${esc(countdown)}">
      <span class="health-prn__lead">${esc(parts.lead)}</span>
      ${parts.detail ? `<span class="health-prn__detail">${esc(parts.detail)}</span>` : ''}
    </span>`;
}

function prnRowMarkup(med, scope, own) {
  const s = prnScope(scope);
  const state = prnDoseState(med, s.logs[med.id] || []);
  const doseText = med.prn_dose_qty != null
    ? t('health.meds.doseQty', { count: fmtNum(med.prn_dose_qty) })
    : med.dosage_text || '';

  const action = own
    ? `<button type="button" class="btn btn--sm ${state.allowed ? 'btn--primary' : 'btn--ghost'} health-prn__take"
               data-prn-take data-prn-scope="${esc(scope)}" data-med-id="${esc(med.id)}"
               aria-label="${esc(t('health.meds.prn.takeFor', { medication: med.name }))}">
         <i data-lucide="pill" class="icon-sm" aria-hidden="true"></i>
         <span class="health-prn__take-label">${esc(t('health.meds.prn.take'))}</span>
       </button>`
    : '';

  return `
    <li class="list-row health-dose health-prn${state.allowed ? '' : ' is-waiting'}">
      <span class="list-row__name health-dose__name">${esc(med.name)}${doseText ? ` · ${esc(doseText)}` : ''}</span>
      ${prnStatusMarkup(state)}
      ${action}
    </li>`;
}

/** Die Liste selbst - ohne Ueberschrift, die setzt der jeweilige Tab. */
function prnListMarkup(scope) {
  const list = prnMeds(scope);
  if (!list.length) return '';
  const own = prnScope(scope).own;
  return `<ul class="health-meds__due-list">${list.map((m) => prnRowMarkup(m, scope, own)).join('')}</ul>`;
}

/**
 * Schreibt die Countdown-Zeilen neu, ohne die Seite anzufassen.
 *
 * Einmal pro Minute reicht: die Anzeige rundet ohnehin auf volle Minuten auf.
 * Laeuft der Abstand waehrenddessen ab, holt der naechste Durchlauf den ganzen
 * Abschnitt frisch, damit der Knopf seine Rolle wechselt.
 */
function refreshPrnCountdowns() {
  const now = Date.now();
  let expired = false;
  for (const el of document.querySelectorAll('[data-prn-countdown]')) {
    const next = parseLogInstant(el.dataset.prnNext);
    if (!next) continue;
    const remaining = next.getTime() - now;
    if (remaining <= 0) { expired = true; continue; }
    const lead = t('health.meds.prn.nextAt', { time: prnWhenLabel(next) });
    const detail = prnRemainingLabel(remaining);
    el.title = `${lead} · ${detail}`;
    el.querySelector('.health-prn__lead').textContent = lead;
    const detailEl = el.querySelector('.health-prn__detail');
    if (detailEl) detailEl.textContent = detail;
  }
  return expired;
}

let prnTicker = null;

/** Startet den Minutentakt, sobald ein Countdown auf der Seite steht. */
function ensurePrnTicker() {
  if (prnTicker) return;
  prnTicker = window.setInterval(() => {
    if (!document.querySelector('[data-prn-countdown]')) { stopPrnTicker(); return; }
    if (!refreshPrnCountdowns()) return;
    // Abgelaufen: der Abschnitt muss neu, sonst bliebe der Knopf im
    // Warte-Zustand stehen, obwohl die Dosis erlaubt ist. Beide Tabs sind
    // gleichzeitig im DOM (nur eines sichtbar) - deshalb kein `else if`, sonst
    // bliebe das jeweils andere auf dem alten Stand stehen.
    if (meds.root?.isConnected) renderMedsShell();
    if (overview.root?.isConnected) renderOverviewShell();
  }, 60_000);
}

function stopPrnTicker() {
  if (!prnTicker) return;
  window.clearInterval(prnTicker);
  prnTicker = null;
}

// Welche Medikamente gerade gebucht werden. Denselben Knopf gibt es mehrfach -
// je Tab einen, beide gleichzeitig gemountet, und bei einem Medikament mit Plan
// UND Bedarf zusaetzlich den geplanten neben dem der Bedarfszeile. `btn.disabled`
// sperrt nur den angeklickten: wer waehrend der laufenden Anfrage den Tab
// wechselt oder die andere Zeile nimmt, bucht dieselbe Dosis ein zweites Mal,
// samt zweitem Bestandsabzug.
const doseInFlight = new Set();

/** JEDEN Buchungsknopf eines Medikaments sperren oder freigeben. */
function setDoseBusy(medId, busy) {
  if (busy) doseInFlight.add(medId); else doseInFlight.delete(medId);
  for (const el of doseButtonsFor(medId)) el.disabled = busy;
}

/** Alle Knoepfe, die fuer dieses Medikament eine Dosis buchen - geplant wie bei Bedarf. */
function doseButtonsFor(medId) {
  return document.querySelectorAll(
    `[data-prn-take][data-med-id="${medId}"],`
    + `[data-dose-take][data-med-id="${medId}"], [data-dose-skip][data-med-id="${medId}"],`
    + `[data-ov-dose-take][data-med-id="${medId}"], [data-ov-dose-skip][data-med-id="${medId}"]`,
  );
}

/** Eine Bedarfsdosis buchen. */
async function handlePrnDose(btn) {
  const scope = btn.dataset.prnScope;
  const s = prnScope(scope);
  const medId = Number(btn.dataset.medId);
  const med = s.list.find((m) => m.id === medId);
  if (!med) return;
  if (doseInFlight.has(medId)) return;

  const state = prnDoseState(med, s.logs[medId] || []);
  // Nicht gesperrt, nur gefragt: der Mindestabstand ist eine Empfehlung vom
  // Beipackzettel, kein Schloss - und wer eine Dosis wirklich frueher nimmt,
  // soll sie eintragen koennen, statt sie zu verschweigen. Der Dialog nennt
  // den Zeitpunkt, um den es geht.
  const fruehGefragt = Boolean(!state.allowed && state.nextAllowedAt);
  if (fruehGefragt) {
    const ok = await confirmModal(t('health.meds.prn.earlyConfirm'), {
      detail: t('health.meds.prn.earlyDetail', {
        time: prnWhenLabel(state.nextAllowedAt),
        remaining: prnRemainingLabel(state.remainingMs),
      }),
      confirmLabel: t('health.meds.prn.earlyConfirmAction'),
    });
    if (!ok) return;
  }

  setDoseBusy(medId, true);
  const dose = med.prn_dose_qty != null ? Number(med.prn_dose_qty) : null;
  try {
    await api.post(`/health/medications/${medId}/logs`, {
      status: 'taken',
      // Wanduhrzeit, keine ISO-Zone: die Route kuerzt den Wert auf Minuten und
      // wuerfe die Zone weg - die Einnahme stuende dann mit der UTC-Zahl im
      // Protokoll und der Countdown rechnete daneben.
      taken_at: toLocalStamp(),
      ...(dose != null && Number.isFinite(dose) ? { dose_qty: dose } : {}),
    });
  } catch (err) {
    console.error('[Health] prn dose error:', err);
    setDoseBusy(medId, false);
    window.yuvomi?.showToast(err?.data?.error || t('health.meds.doseError'), 'danger');
    return;
  }

  // AB HIER IST DIE DOSIS GEBUCHT. Der Bestandsabzug ist ein zweiter Aufruf,
  // und wenn er scheitert, darf das nicht als „Buchung fehlgeschlagen" dastehen:
  // wer es dann noch einmal versucht, hat die Dosis zweimal im Protokoll. Der
  // Bestand ist eine Nebenbuchhaltung, die Dosis die Aussage ueber den Koerper.
  //
  // Der Abzug wird beim Zuruecknehmen NICHT gutgeschrieben - so haelt es die
  // geplante Dosis seit jeher (#701 korrigiert den Eintrag, nicht den Bestand).
  // Das ist eine bekannte Grenze und keine Eigenheit der Bedarfsdosis; sie
  // aufzuheben hiesse, jede Korrektur serverseitig gegenzubuchen, und das gehoert
  // in einen eigenen Schritt statt in diesen.
  if (dose != null && Number.isFinite(dose) && med.stock_qty != null) {
    try {
      const next = Math.max(0, Number(med.stock_qty) - dose);
      await api.patch(`/health/medications/${medId}`, { stock_qty: next });
    } catch (err) {
      console.error('[Health] prn stock error:', err);
      window.yuvomi?.showToast(t('health.meds.stockUpdateFailed'), 'danger');
    }
  }

  window.yuvomi?.showToast(t('health.meds.doseSaved'), 'success');
  // Erst nach dem Neuzeichnen freigeben: bis dahin darf kein Zwilling scharf
  // sein. Freigegeben wird ueber `setDoseBusy` und nicht ueber das Set allein -
  // die Knoepfe von eben sind beim Neuzeichnen verschwunden, und die neuen sind
  // gerade erst durch `wirePrn` gesperrt worden, weil die Buchung da noch lief.
  // Ein blosses `delete` haette den Eintrag geraeumt und den Knopf gesperrt
  // gelassen: bei einem Medikament ohne Mindestabstand bis zum naechsten
  // Seitenaufbau.
  await reloadMedViews();
  setDoseBusy(medId, false);
  // Nur nach der Rueckfrage: ohne sie wurde auf diesem Weg kein Dialog
  // geschlossen, und das Nachfassen griffe auf den Merker eines frueheren zurueck
  // (#1083). Nach `setDoseBusy`, sonst traefe es den noch gesperrten Knopf.
  if (fruehGefragt) refocusAfterRender();
}

/**
 * BEIDE Ansichten auffrischen, die Medikamentendaten zeigen.
 *
 * Uebersicht und Medikamente sind gleichzeitig gemountet, und die weiche
 * Tab-Navigation baut ein bereits geladenes Panel nicht neu auf. Nur den
 * angefassten neu zu laden hiesse: der andere rechnet mit dem Stand von vorhin.
 * Das faellt ueberall an, wo sich etwas an Medikamenten, Plaenen oder Dosen
 * aendert - eine gebuchte Dosis verschiebt drueben den Countdown, ein
 * abgeschalteter Bedarfshaken laesst drueben einen Knopf stehen, den es nicht
 * mehr geben duerfte, und der bucht dann eine Dosis, vor der niemand mehr warnt.
 * Geladen wird nur, was auch gemountet ist; wer die Uebersicht nie geoeffnet
 * hat, zahlt nichts dafuer.
 */
async function reloadMedViews() {
  const jobs = [];
  if (meds.root?.isConnected && meds.loaded) jobs.push(reloadMeds());
  if (overview.root?.isConnected && overview.loaded) jobs.push(reloadOverview());
  await Promise.all(jobs);
}

/** Sperrt frisch gezeichnete Knoepfe, deren Buchung noch laeuft. */
function respectDoseLock(root) {
  // Ein Neuaufbau waehrend einer laufenden Buchung darf keinen Knopf wieder
  // scharf machen - er entsteht ja frisch und wuesste sonst nichts davon.
  root.querySelectorAll('[data-med-id]').forEach((btn) => {
    if (typeof btn.disabled !== 'boolean') return;
    if (doseInFlight.has(Number(btn.dataset.medId))) btn.disabled = true;
  });
}

/** Bindet die Bedarfsknoepfe eines Wurzelelements. */
function wirePrn(root) {
  respectDoseLock(root);
  root.querySelectorAll('[data-prn-take]').forEach((btn) => {
    btn.addEventListener('click', () => handlePrnDose(btn));
  });
  if (root.querySelector('[data-prn-countdown]')) ensurePrnTicker();
}

function adherenceMarkup() {
  const today = todayKey();
  const from = addLocalDays(today, -(meds.adherenceDays - 1));
  const planned = computeDueDoses(allSchedules(), { from, to: today }).length;
  const a = computeAdherence(allLogsInRange(from, today), planned);

  // Seit Block 2 die geteilte Kennzahlkarte: Titel + Zeitraum teilen sich die
  // Meta-Zeile, der Balken ist der geteilte __progress (Zweitkanal zur Zahl).
  const head = `
    <div class="metric-card__meta">
      <span class="metric-card__label">${esc(t('health.meds.adherence.title'))}</span>
      <span>${esc(t('health.meds.adherence.period', { days: meds.adherenceDays }))}</span>
    </div>`;

  if (a.rate === null) {
    return `<div class="metric-card">${head}
      <div class="metric-card__note">${esc(t('health.meds.adherence.noData'))}</div></div>`;
  }
  // Geplant, aber noch nichts protokolliert: KEIN großes rotes „0 %" — das liest
  // sich als Vorwurf. Stattdessen ein neutraler Frühzustand (Adherence-Scham vermeiden).
  if (a.taken === 0) {
    return `<div class="metric-card">${head}
      <div class="metric-card__note">${esc(t('health.meds.adherence.notStarted'))}</div></div>`;
  }
  const pct = Math.round(a.rate * 100);
  return `
    <div class="metric-card">
      ${head}
      <div class="metric-card__value">${esc(fmtNum(pct))}%</div>
      <div class="metric-card__progress" role="progressbar" aria-label="${esc(t('health.meds.adherence.title'))}"
           aria-valuemin="0" aria-valuemax="100"
           aria-valuenow="${pct}" aria-valuetext="${pct}%"><span style="--fill:${pct / 100}"></span></div>
      <div class="metric-card__note">${esc(t('health.meds.adherence.summary', { taken: a.taken, planned: a.planned }))}</div>
    </div>`;
}

// Einnahmeprotokoll als aufklappbare Ansicht unter der Adhärenz (Audit R2,
// A2-22): die aggregierte Zahl bekommt ihre nachlesbaren Belege - bisher gab
// es das Protokoll nur als CSV-Export.
function medLogHistoryMarkup() {
  const entries = [];
  for (const m of meds.list) {
    for (const l of (meds.logsByMed[m.id] || [])) {
      entries.push({
        id: l.id, med: m.name, medId: m.id, scheduleId: l.schedule_id ?? null,
        at: l.taken_at || l.scheduled_at || l.created_at || '', status: l.status,
      });
    }
  }
  if (!entries.length) return '';
  entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // Dasselbe ausdrueckliche Betreuungsrecht wie beim Buchen und Abhaken gilt
  // auch fuer die Korrektur (#999). Der Server zieht diese Grenze zentral ueber
  // `ownLogRow` -> `writableChild`; die Oberflaeche muss deshalb denselben
  // bereits geladenen Grant verwenden statt einer engeren Eigentuemerpruefung.
  const own = canEditFor(meds.personId, meds.meId);

  const rows = entries.slice(0, 10).map((e) => {
    // Uebersprungen und ausstehend sind beide "nicht genommen" und treten
    // gleich weit zurueck; unterscheiden tut sie das Wort daneben.
    const muted = e.status !== 'taken';
    const d = String(e.at);
    const timeLabel = d.length >= 16
      ? `${formatDate(d.slice(0, 10))} · ${formatTime(new Date(d))}`
      : formatDate(d.slice(0, 10));
    // Drei Staende, nicht zwei: das Protokoll kannte nur "uebersprungen" und
    // "sonst genommen" und schrieb damit "Genommen" unter jede ausstehende
    // Dosis. Solange es keinen Weg zurueck gab, fiel das kaum auf - seit es
    // einen gibt (#701), waere es die Zeile, die der Korrektur widerspricht.
    const statusLabel = {
      skipped: t('health.meds.status.skipped'),
      pending: t('health.meds.log.statusPending'),
    }[e.status] ?? t('health.meds.status.taken');
    const icon = { skipped: 'circle-slash', pending: 'circle-dashed' }[e.status] ?? 'check';
    const body = `
        <i data-lucide="${icon}" aria-hidden="true"></i>
        <span class="health-medlog__med">${esc(e.med)}</span>
        <span class="health-medlog__time">${esc(timeLabel)}</span>
        <span class="health-medlog__status">${esc(statusLabel)}</span>`;
    if (!own) {
      return `<li class="health-medlog__row${muted ? ' is-muted' : ''}">${body}</li>`;
    }
    return `<li class="health-medlog__row${muted ? ' is-muted' : ''}">
        <button type="button" class="health-medlog__edit" data-medlog-edit="${esc(e.id)}"
                aria-label="${esc(t('health.meds.log.correct', { medication: e.med, time: timeLabel }))}">
          ${body}
        </button>
      </li>`;
  }).join('');
  return `
    <details class="health-medlog">
      <summary>${esc(t('health.meds.logTitle'))}</summary>
      <ul class="health-medlog__list">${rows}</ul>
    </details>`;
}

/** Ein Log-Eintrag aus dem geladenen Bestand, samt Medikamentenname. */
function findMedLog(logId) {
  for (const m of meds.list) {
    const hit = (meds.logsByMed[m.id] || []).find((l) => l.id === logId);
    if (hit) return { ...hit, medName: m.name };
  }
  return null;
}

/**
 * Einen Dosis-Eintrag korrigieren oder zurücknehmen (#701).
 *
 * Vorher gab es nur take/skip, also zwei Einbahnstraßen: ein Fehlgriff blieb
 * für immer stehen, und zwar nicht nur in der App, sondern auch im Export.
 *
 * Gelöscht werden kann nur, was nicht aus einem Zeitplan stammt. Ein geplanter
 * Eintrag wird zurückgenommen ("steht aus") statt entfernt, weil der Scheduler
 * ihn sonst beim nächsten Lauf wieder anlegt - das Löschen sähe aus wie ein
 * Erfolg und wäre eine Rückkehr auf Raten. Der Server weist es entsprechend ab.
 */
function openMedLogModal(logId) {
  const entry = findMedLog(logId);
  if (!entry) return;

  const when = entry.taken_at || entry.scheduled_at || entry.created_at || '';
  const dateValue = String(when).slice(0, 10);
  const timeValue = String(when).length >= 16 ? String(when).slice(11, 16) : '';
  const isScheduled = Boolean(entry.schedule_id);

  openModal({
    title: t('health.meds.log.editTitle'),
    size: 'sm',
    content: `
      <form id="medlog-form" class="form-stack">
        <p class="form-hint">${esc(entry.medName)}</p>
        <div class="form-field">
          <label class="label" for="medlog-status">${esc(t('health.meds.log.statusLabel'))}</label>
          <select class="input" id="medlog-status">
            <option value="taken"${entry.status === 'taken' ? ' selected' : ''}>${esc(t('health.meds.status.taken'))}</option>
            <option value="skipped"${entry.status === 'skipped' ? ' selected' : ''}>${esc(t('health.meds.status.skipped'))}</option>
            <option value="pending"${entry.status === 'pending' ? ' selected' : ''}>${esc(t('health.meds.log.statusPending'))}</option>
          </select>
        </div>
        <div class="modal-grid modal-grid--2" id="medlog-when">
          <div class="form-field">
            <label class="label" for="medlog-date">${esc(t('health.meds.log.dateLabel'))}</label>
            <yuvomi-datepicker id="medlog-date" type="date" value="${esc(dateValue)}"></yuvomi-datepicker>
          </div>
          <div class="form-field">
            <label class="label" for="medlog-time">${esc(t('health.meds.log.timeLabel'))}</label>
            <yuvomi-datepicker id="medlog-time" type="time" value="${esc(timeValue)}"></yuvomi-datepicker>
          </div>
        </div>
        <p class="form-hint">${esc(isScheduled ? t('health.meds.log.scheduledHint') : t('health.meds.log.adhocHint'))}</p>

        <div class="modal-actions">
          ${isScheduled ? '' : `<button type="button" class="btn btn--danger btn--ghost" data-action="medlog-delete">${esc(t('common.delete'))}</button>`}
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      if (window.lucide) window.lucide.createIcons({ el: panel });

      const statusField = panel.querySelector('#medlog-status');
      const whenBox = panel.querySelector('#medlog-when');
      // Ein Zeitpunkt gehört zu "genommen". Bei den anderen beiden Ständen wäre
      // er ein Widerspruch in derselben Zeile, deshalb tritt er dort weg.
      //
      // `style.display` statt des hidden-Attributs: `.modal-grid` setzt
      // `display: grid`, und eine Klassenregel schlägt das Attribut - das Feld
      // wäre trotz `hidden` sichtbar geblieben.
      const syncWhen = () => { whenBox.style.display = statusField.value === 'taken' ? '' : 'none'; };
      statusField.addEventListener('change', syncWhen);
      syncWhen();

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="medlog-delete"]')?.addEventListener('click', () => deleteMedLog(entry));

      panel.querySelector('#medlog-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const status = statusField.value;
        const body = { status };
        if (status === 'taken') {
          const date = panel.querySelector('#medlog-date')?.value || dateValue;
          const time = panel.querySelector('#medlog-time')?.value || '00:00';
          if (date) body.taken_at = `${date}T${time.length === 5 ? time : '00:00'}:00`;
        }
        submitBtn.disabled = true;
        try {
          await api.patch(`/health/logs/${entry.id}`, body);
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.meds.log.saved'), 'success');
          await reloadMedViews();
          refocusAfterRender();
        } catch (err) {
          console.error('[Health] med log save error:', err);
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('health.meds.log.saveError'), 'danger');
        }
      });
    },
  });
}

async function deleteMedLog(entry) {
  if (!(await confirmOverModal(t('health.meds.log.deleteConfirm'),
    { danger: true, confirmLabel: t('common.delete'), detail: t('health.meds.log.deleteConfirmDetail') }))) return;
  try {
    await api.delete(`/health/logs/${entry.id}`);
    closeModal({ force: true });
    window.yuvomi?.showToast(t('health.meds.log.deleted'), 'success');
    await reloadMedViews();
    refocusAfterRender();
  } catch (err) {
    console.error('[Health] med log delete error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.meds.log.saveError'), 'danger');
  }
}

function medListMarkup() {
  if (!meds.list.length) {
    return emptyHintHTML(t('health.meds.noMeds'));
  }
  return meds.list.map(medCardMarkup).join('');
}

function medCardMarkup(med) {
  const rf = refillState(med);
  const subtitle = [med.dosage_text, med.form].filter(Boolean).join(' · ');
  const own = canEditFor(meds.personId, meds.meId);

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
  installPopoverMenus(meds.root);
  wirePersonSwitcher(meds, switchMedsPerson);


  meds.root.querySelectorAll('[data-med-edit]').forEach((card) =>
    card.addEventListener('click', () => {
      const id = Number(card.dataset.medEdit);
      const med = meds.list.find((m) => m.id === id);
      if (med) openMedModal(med);
    }));

  // Eine Zeile im Einnahmeprotokoll korrigieren (#701).
  meds.root.querySelectorAll('[data-medlog-edit]').forEach((row) =>
    row.addEventListener('click', () => openMedLogModal(Number(row.dataset.medlogEdit))));

  meds.root.querySelectorAll('[data-dose-take]').forEach((btn) =>
    btn.addEventListener('click', () => handleDose(btn, 'take')));
  meds.root.querySelectorAll('[data-dose-skip]').forEach((btn) =>
    btn.addEventListener('click', () => handleDose(btn, 'skip')));

  wirePrn(meds.root);
}

async function switchMedsPerson() {
  try {
    await loadMeds();
    meds.error = false;
  } catch (err) {
    console.error('[Health] meds load error:', err);
    meds.error = err;
  }
  renderMedsShell();
}

async function reloadMeds() {
  try {
    await loadMeds();
    meds.error = false;
  } catch (err) {
    console.error('[Health] meds reload error:', err);
    meds.error = err;
  }
  renderMedsShell();
}

async function handleDose(btn, action) {
  const medId = Number(btn.dataset.medId);
  // Dieselbe Sperre wie bei der Bedarfsdosis: bei einem Medikament mit Plan UND
  // Bedarf stehen beide Knoepfe nebeneinander, und zwei angestossene Buchungen
  // sehen beide den alten Bestand.
  if (doseInFlight.has(medId)) return;
  const logId = btn.dataset.logId ? Number(btn.dataset.logId) : null;
  const scheduleId = btn.dataset.scheduleId ? Number(btn.dataset.scheduleId) : null;
  const scheduledAt = btn.dataset.scheduledAt || null;
  const dose = btn.dataset.dose !== '' ? Number(btn.dataset.dose) : null;

  setDoseBusy(medId, true);
  try {
    if (logId) {
      await api.post(`/health/logs/${logId}/${action}`, {});
    } else {
      const body = { status: action === 'take' ? 'taken' : 'skipped' };
      if (scheduledAt) body.scheduled_at = scheduledAt;
      if (scheduleId) body.schedule_id = scheduleId;
      if (dose != null && Number.isFinite(dose)) body.dose_qty = dose;
      // Wanduhrzeit wie bei der Bedarfsdosis: `v.datetime` kuerzt den Wert auf
      // Minuten und wirft die Zone weg, aus 22:41 MESZ wuerde 20:41. Sichtbar
      // war das im Protokoll; seit ein Medikament Plan UND Bedarf haben kann,
      // rechnet auch der Countdown daraus - und zwar zwei Stunden daneben.
      if (action === 'take') body.taken_at = toLocalStamp();
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
    // Beide Tabs, nicht nur dieser: ein Medikament kann Plan UND Bedarf haben,
    // und dann verschiebt auch die geplante Dosis den Countdown drueben.
    await reloadMedViews();
    setDoseBusy(medId, false);
  } catch (err) {
    console.error('[Health] dose error:', err);
    setDoseBusy(medId, false);
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
        <!-- Nur fuer Bedarfsmedikamente sichtbar (#700): ein Mindestabstand an
             einem Medikament mit Zeitplan waere eine zweite, widersprechende
             Auskunft darueber, wann die naechste Dosis ansteht. -->
        <div class="modal-grid modal-grid--2" id="med-prn-fields">
          <div class="form-field">
            <label class="label" for="med-interval">${esc(t('health.meds.field.minInterval'))}</label>
            <!-- Die Grenzen sind die der Route: groesser als 0 (ein Abstand von
                 0 waere ein Countdown, der immer abgelaufen ist) und hoechstens
                 28 Tage. Nicht enger, sonst liesse sich ein ueber die API
                 gesetzter Viertelstundenabstand hier nicht mehr speichern -
                 auch dann nicht, wenn nur der Name geaendert wird. Leer bleiben
                 darf das Feld weiterhin: das ist „kein Abstand hinterlegt". -->
            <input class="input" id="med-interval" type="number" inputmode="decimal" step="any" min="0.01" max="672"
                   value="${esc(val(med?.min_interval_hours))}">
            <p class="form-hint">${esc(t('health.meds.field.minIntervalHint'))}</p>
          </div>
          <div class="form-field">
            <label class="label" for="med-prn-dose">${esc(t('health.meds.field.prnDose'))}</label>
            <input class="input" id="med-prn-dose" type="number" inputmode="decimal" step="any" min="0"
                   value="${esc(val(med?.prn_dose_qty))}">
            <p class="form-hint">${esc(t('health.meds.field.prnDoseHint'))}</p>
          </div>
        </div>
        <div class="form-field">
          <label class="label" for="med-visibility">${esc(t('health.meds.field.visibility'))}</label>
          <select class="input" id="med-visibility">
            <option value="private" ${(med?.visibility || defaultVisibility('meds')) === 'family' ? '' : 'selected'}>${esc(t('health.meds.visibility.private'))}</option>
            <option value="family" ${(med?.visibility || defaultVisibility('meds')) === 'family' ? 'selected' : ''}>${esc(t('health.meds.visibility.family'))}</option>
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

      // Die Bedarfsfelder folgen dem Haken - `style.display` und nicht `hidden`,
      // weil `.modal-grid` `display: grid` setzt und die Klassenregel das
      // Attribut schlaegt (dieselbe Falle wie im Protokoll-Modal).
      const prnBox = panel.querySelector('#med-prn-fields');
      const prnFlag = panel.querySelector('#med-prn');
      const syncPrn = () => { prnBox.style.display = prnFlag.checked ? '' : 'none'; };
      prnFlag.addEventListener('change', syncPrn);
      syncPrn();

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="med-delete"]')?.addEventListener('click', () => deleteMed(med));

      panel.querySelector('#med-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const body = collectMedBody(panel);
        if (!body) {
          reportFieldError(panel.querySelector('#med-name'), t('health.meds.nameRequired'));
          return;
        }
        submitBtn.disabled = true;
        try {
          if (isEdit) await api.patch(`/health/medications/${med.id}`, body);
          else await api.post('/health/medications', { ...body, ...ownerField(meds.personId, meds.meId) });
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.meds.saved'), 'success');
          await reloadMedViews();
          refocusAfterRender();
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
  const isPrn = Boolean(panel.querySelector('#med-prn')?.checked);

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
    prn: isPrn ? 1 : 0,
    // Faellt der Haken, raeumen die beiden Felder mit ab - sie stehen dann zwar
    // noch ausgefuellt hinter `display: none`, beschreiben aber nichts mehr.
    // Ein Medikament mit Zeitplan traege sonst weiter einen Mindestabstand,
    // den keine Ansicht mehr zeigt und kein Formular mehr aendert.
    min_interval_hours: isPrn ? num('#med-interval') : null,
    prn_dose_qty: isPrn ? num('#med-prn-dose') : null,
  };
}

async function deleteMed(med) {
  if (!med?.id) return;
  if (!(await confirmOverModal(t('health.meds.deleteConfirm'),
    { danger: true, confirmLabel: t('common.delete'), detail: t('health.meds.deleteConfirmDetail') }))) return;
  try {
    await api.delete(`/health/medications/${med.id}`);
    window.yuvomi?.showToast(t('health.meds.deleted'), 'success');
    await reloadMedViews();
    refocusAfterRender();
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
  const doseText = s.dose_qty != null ? ` · ${t('health.meds.doseQty', { count: fmtNum(s.dose_qty) })}` : '';
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
    if (!time) {
      reportFieldError(host.querySelector('#sched-time'), t('health.meds.schedule.timeRequired'));
      return;
    }
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
    labs.error = err;
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
    labs.error = err;
  }
  renderLabsShell();
}

async function reloadLabs() {
  try {
    await loadLabs();
    labs.error = false;
  } catch (err) {
    console.error('[Health] labs reload error:', err);
    labs.error = err;
  }
  renderLabsShell();
}

function renderLabsShell() {
  if (!labs.root?.isConnected) return;
  labs.root.replaceChildren();

  if (labs.error) {
    mountAreaLoadError(labs, 'labs', mountLabs);
    return;
  }

  labs.root.insertAdjacentHTML('beforeend', `
    ${personSwitcherMarkup(labs.members, labs.personId, labs.meId,
      { menuId: 'health-person-menu-labs', label: t('health.labs.personsLabel') })}
    ${readOnlyBannerMarkup(labs.members, labs.personId, canEditFor(labs.personId, labs.meId), labs.meId)}
    <div class="health-labs__toolbar">
      <h3 class="health-labs__section-title u-section-title">${esc(t('health.labs.reportsTitle'))}</h3>
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
    return emptyHintHTML(t('health.labs.noReports'));
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
    return emptyHintHTML(t('health.labs.selectHint'));
  }

  const own = canEditFor(labs.personId, labs.meId);
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
    : emptyHintHTML(t('health.labs.noAnalytes'));

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
    : emptyHintHTML(t('health.labs.trend.tooFew'));

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

  const grid = chartGridFor(min, max);
  const xLabels = chartXLabels(points.map((p) => p.date));

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
  installPopoverMenus(labs.root);
  wirePersonSwitcher(labs, switchLabsPerson);


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
    : todayKey();

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
            <option value="private" ${(report?.visibility || defaultVisibility('labs')) === 'family' ? '' : 'selected'}>${esc(t('health.labs.visibility.private'))}</option>
            <option value="family" ${(report?.visibility || defaultVisibility('labs')) === 'family' ? 'selected' : ''}>${esc(t('health.labs.visibility.family'))}</option>
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
          reportFieldError(panel.querySelector('#lab-date'), t('health.labs.dateRequired'));
          return;
        }
        submitBtn.disabled = true;
        try {
          if (isEdit) {
            await api.patch(`/health/labs/${report.id}`, body);
          } else {
            const created = await api.post('/health/labs', { ...body, ...ownerField(labs.personId, labs.meId) });
            // Neu angelegten Befund direkt selektieren, damit das Detail nicht
            // beim zuvor gewählten Befund stehen bleibt.
            if (created?.data?.id != null) labs.selectedReportId = created.data.id;
          }
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.labs.saved'), 'success');
          await reloadLabs();
          refocusAfterRender();
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
  if (!(await confirmOverModal(t('health.labs.deleteConfirm'),
    { danger: true, confirmLabel: t('common.delete'), detail: t('health.labs.deleteConfirmDetail') }))) return;
  try {
    await api.delete(`/health/labs/${report.id}`);
    window.yuvomi?.showToast(t('health.labs.deleted'), 'success');
    if (labs.selectedReportId === report.id) labs.selectedReportId = null;
    await reloadLabs();
    refocusAfterRender();
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
    if (!analyte) {
      reportFieldError(host.querySelector('#res-analyte'), t('health.labs.results.analyteRequired'));
      return;
    }
    if (valueRaw === '' || valueRaw == null || !Number.isFinite(Number(valueRaw))) {
      reportFieldError(valueEl, t('health.labs.results.valueRequired'));
      return;
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
  anchor: todayKey(),
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
    activity.error = err;
  }
  activity.loaded = true;
  renderActivityShell();
}

async function loadActivity() {
  const query = activity.personId ? `?user_id=${encodeURIComponent(activity.personId)}` : '';
  const res = await api.get(`/health/activities${query}`);
  activity.rows = res.data || [];
}

async function switchActivityPerson() {
  activity.anchor = todayKey();
  try {
    await loadActivity();
    activity.error = false;
  } catch (err) {
    console.error('[Health] activity load error:', err);
    activity.error = err;
  }
  renderActivityShell();
}

async function reloadActivity() {
  try {
    await loadActivity();
    activity.error = false;
  } catch (err) {
    console.error('[Health] activity reload error:', err);
    activity.error = err;
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
    mountAreaLoadError(activity, 'activity', mountActivity);
    return;
  }

  const summary = weekSummary(activity.rows, { anchor: activity.anchor, weekStartsOn: 1 });
  const weekRows = activityWeekRows(summary);
  const totals = activityTotals(weekRows);
  // Leere Woche: nur der Stepper (Wochen-Navigation) und EINE Leerzustand-
  // Karte im Chart-Slot. Die "0 Einheiten"-Stat-Wand und die doppelte
  // Leer-Meldung im Log entfallen (Audit A2-09/A2-21).

  activity.root.insertAdjacentHTML('beforeend', `
    ${personSwitcherMarkup(activity.members, activity.personId, activity.meId,
      { menuId: 'health-person-menu-activity', label: t('health.activity.personsLabel') })}
    ${readOnlyBannerMarkup(activity.members, activity.personId, canEditFor(activity.personId, activity.meId), activity.meId)}
    <div class="health-activity__toolbar">
      <div class="health-activity__stepper">
        <button class="btn btn--icon" data-step="-1" aria-label="${esc(t('health.activity.prevWeek'))}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
        <span class="health-activity__period">${esc(`${formatDate(summary.from)} – ${formatDate(summary.to)}`)}</span>
        <button class="btn btn--icon" data-step="1" aria-label="${esc(t('health.activity.nextWeek'))}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
      </div>
    </div>
    ${totals.count === 0 ? '' : `<div class="health-activity__summary">${activityStatsMarkup(totals)}</div>`}
    <div class="health-activity__chart">${activityChartMarkup(summary)}</div>
    ${totals.count === 0 ? '' : `<div class="health-activity__log">${activityLogMarkup(weekRows)}</div>`}
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
    <div class="metric-card">
      <span class="metric-card__head">
        <i data-lucide="${esc(c.icon)}" class="metric-card__icon" aria-hidden="true"></i>
        <span class="metric-card__label">${esc(t(c.labelKey))}</span>
      </span>
      <span class="metric-card__value">${esc(c.value)}</span>
    </div>`).join('');
}

// Nativer SVG-Balken-Chart: Gesamt-Dauer (Min) je Wochentag Mo–So.
function activityChartMarkup(summary) {
  const buckets = summary.buckets;
  const max = Math.max(...buckets.map((b) => b.durationMin), 0);
  if (max <= 0) {
    return emptyHintHTML(t('health.activity.noData'), { className: 'health-chart-empty' });
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
      <text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" class="chart__axis" text-anchor="middle">${esc(label)}</text>`;
  }).join('');

  const grid = chartGridFor(0, max);

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
    return emptyHintHTML(t('health.activity.noEntries'));
  }
  const own = canEditFor(activity.personId, activity.meId);
  return `
    <h3 class="health-activity__log-title u-section-title">${esc(t('health.activity.logTitle'))}</h3>
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
  installPopoverMenus(activity.root);
  wirePersonSwitcher(activity, switchActivityPerson);

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
              <option value="private" ${(row?.visibility || defaultVisibility('activities')) === 'family' ? '' : 'selected'}>${esc(t('health.activity.visibility.private'))}</option>
              <option value="family" ${(row?.visibility || defaultVisibility('activities')) === 'family' ? 'selected' : ''}>${esc(t('health.activity.visibility.family'))}</option>
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
            await api.post('/health/activities', { ...body, ...ownerField(activity.personId, activity.meId) });
            activity.anchor = zonedDateKey(body.performed_at);
          }
          closeModal({ force: true });
          window.yuvomi?.showToast(t('health.activity.saved'), 'success');
          await reloadActivity();
          await opts.onSaved?.();
          refocusAfterRender();
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
  if (!(await confirmOverModal(t('health.activity.deleteConfirm'),
    { danger: true, confirmLabel: t('common.delete'), detail: t('health.activity.deleteConfirmDetail') }))) return;
  try {
    await api.delete(`/health/activities/${row.id}`);
    window.yuvomi?.showToast(t('health.activity.deleted'), 'success');
    await reloadActivity();
    refocusAfterRender();
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
    const today = todayKey();
    overview.exportRange = { from: addLocalDays(today, -(OVERVIEW_EXPORT_DAYS - 1)), to: today };
    await loadOverview();
    overview.error = false;
  } catch (err) {
    console.error('[Health] overview mount error:', err);
    overview.error = err;
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

  const today = todayKey();
  await Promise.all(overview.meds.map(async (m) => {
    const from = addLocalDays(today, -(medLogWindowDays(m, OVERVIEW_ADHERENCE_DAYS) - 1));
    const [sRes, lRes] = await Promise.all([
      api.get(`/health/medications/${m.id}/schedules`),
      api.get(`/health/medications/${m.id}/logs?from=${from}T00:00&to=${today}T23:59`),
    ]);
    overview.schedulesByMed[m.id] = sRes.data || [];
    overview.logsByMed[m.id] = lRes.data || [];
  }));
}

function overviewAllSchedules() {
  return overview.meds.flatMap((m) => overview.schedulesByMed[m.id] || []);
}

function overviewAllLogs() {
  return overview.meds.flatMap((m) => overview.logsByMed[m.id] || []);
}

/**
 * Nur die geplanten Dosen - dieselbe Grenze wie `allLogsInRange` im Meds-Tab.
 * Adhaerenz misst die Einhaltung eines Plans, und eine Bedarfsdosis hat keinen;
 * seit sie nicht mehr am Zeitraumfilter haengenbleibt (#700), muss sie hier
 * ausdruecklich draussen bleiben. Auch der Streak rechnet nur mit ihnen.
 */
function overviewScheduledLogs() {
  return scheduledLogs(overviewAllLogs());
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
    overview.error = err;
  }
  renderOverviewShell();
}

async function reloadOverview() {
  try {
    await loadOverview();
    overview.error = false;
  } catch (err) {
    console.error('[Health] overview reload error:', err);
    overview.error = err;
  }
  renderOverviewShell();
}

function renderOverviewShell() {
  if (!overview.root?.isConnected) return;
  overview.root.replaceChildren();

  if (overview.error) {
    mountAreaLoadError(overview, 'overview', mountOverview);
    return;
  }

  overview.root.insertAdjacentHTML('beforeend', `
    ${personSwitcherMarkup(overview.members, overview.personId, overview.meId,
      { menuId: 'health-person-menu-overview', label: t('health.overview.personsLabel') })}
    ${readOnlyBannerMarkup(overview.members, overview.personId, canEditFor(overview.personId, overview.meId), overview.meId)}
    <div class="health-overview__grid">
      ${overviewCard('calendar-check', 'health.overview.dueToday.title', overviewDueMarkup())}
      ${prnMeds('overview').length ? overviewCard('pill', 'health.meds.prn.title', prnListMarkup('overview')) : ''}
      ${overviewCard('trending-up', 'health.overview.adherence.title', overviewAdherenceMarkup())}
      ${overviewCard('activity', 'health.overview.vitals.title', overviewVitalsMarkup())}
      ${canEditFor(overview.personId, overview.meId) ? overviewCard('plus-circle', 'health.overview.quick.title', quickCaptureMarkup()) : ''}
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
        <h3 class="health-overview__card-title u-section-title">${esc(t(titleKey))}</h3>
      </header>
      <div class="health-overview__card-body">${body}</div>
    </section>`;
}

// --- Heute fällig (identische Logik wie dueTodayMarkup im Meds-Tab) ---

function overviewDueMarkup() {
  const today = todayKey();
  const due = computeDueDoses(overviewAllSchedules(), { from: today, to: today });
  if (!due.length) {
    return emptyHintHTML(t('health.meds.dueToday.empty'));
  }
  const own = canEditFor(overview.personId, overview.meId);
  const rows = due.map((dose) => {
    const med = overview.meds.find((m) => m.id === dose.medicationId);
    return overviewDueRowMarkup(dose, med, overviewFindLog(dose), own);
  }).join('');
  return `<ul class="health-meds__due-list">${rows}</ul>`;
}

function overviewDueRowMarkup(dose, med, log, own) {
  const name = med ? med.name : '';
  const status = log?.status;
  const doseText = dose.dose_qty != null ? ` · ${t('health.meds.doseQty', { count: fmtNum(dose.dose_qty) })}` : '';

  let actions;
  if (status === 'taken') {
    actions = `<span class="health-dose__status health-dose__status--taken"><i data-lucide="check" aria-hidden="true"></i>${esc(t('health.meds.status.taken'))}</span>`;
  } else if (status === 'skipped') {
    actions = `<span class="health-dose__status health-dose__status--skipped"><i data-lucide="x" aria-hidden="true"></i>${esc(t('health.meds.status.skipped'))}</span>`;
  } else if (own) {
    const data = `data-med-id="${esc(dose.medicationId)}" data-schedule-id="${esc(dose.scheduleId ?? '')}" data-scheduled-at="${esc(dose.scheduledAt)}" data-log-id="${esc(log?.id ?? '')}" data-dose="${esc(dose.dose_qty ?? '')}"`;
    /* DIESELBE FORM WIE IN `dueRowMarkup` - hier fehlte sie, und der Fix von
     * dort erreichte diese Zeile deshalb nicht. Der Knopf trug weder
     * `health-dose__skip` noch den Label-Span, also hatte die Container-Query
     * `@container list-rows (max-width: 26rem)` nichts zu verbergen: gemessen
     * bei 390px lag "Ueberspringen" bei left=360 und damit zu 92 von 122px
     * ausserhalb des Bildes, geclippt und ohne Scrollweg dorthin (Critique
     * 2026-08-13, offen geblieben). Zwei Renderer fuer dieselbe Zeile, und die
     * Korrektur landete in einem - dasselbe Muster, das dieser Branch schon
     * dreimal produziert hat.
     * Das `aria-label` traegt den ganzen Satz weiter, wenn der Text faellt. */
    actions = `
      <div class="health-dose__actions">
        <button type="button" class="btn btn--sm btn--primary health-dose__take" data-ov-dose-take ${data} aria-label="${esc(t('health.meds.take'))}"><i data-lucide="check" class="icon-sm" aria-hidden="true"></i><span class="health-dose__take-label">${esc(t('health.meds.take'))}</span></button>
        <button type="button" class="btn btn--sm btn--ghost health-dose__skip" data-ov-dose-skip ${data} aria-label="${esc(t('health.meds.skip'))}"><i data-lucide="skip-forward" class="icon-sm" aria-hidden="true"></i><span class="health-dose__skip-label">${esc(t('health.meds.skip'))}</span></button>
      </div>`;
  } else {
    actions = `<span class="health-dose__status">${esc(t('health.meds.status.pending'))}</span>`;
  }

  return `
    <li class="list-row health-dose">
      <span class="health-dose__time">${esc(dose.time)}</span>
      <span class="list-row__name health-dose__name">${esc(name)}${esc(doseText)}</span>
      ${actions}
    </li>`;
}

async function handleOverviewDose(btn, action) {
  const medId = Number(btn.dataset.medId);
  if (doseInFlight.has(medId)) return;
  const logId = btn.dataset.logId ? Number(btn.dataset.logId) : null;
  const scheduleId = btn.dataset.scheduleId ? Number(btn.dataset.scheduleId) : null;
  const scheduledAt = btn.dataset.scheduledAt || null;
  const dose = btn.dataset.dose !== '' ? Number(btn.dataset.dose) : null;

  setDoseBusy(medId, true);
  try {
    if (logId) {
      await api.post(`/health/logs/${logId}/${action}`, {});
    } else {
      const body = { status: action === 'take' ? 'taken' : 'skipped' };
      if (scheduledAt) body.scheduled_at = scheduledAt;
      if (scheduleId) body.schedule_id = scheduleId;
      if (dose != null && Number.isFinite(dose)) body.dose_qty = dose;
      // Wanduhrzeit wie bei der Bedarfsdosis: `v.datetime` kuerzt den Wert auf
      // Minuten und wirft die Zone weg, aus 22:41 MESZ wuerde 20:41. Sichtbar
      // war das im Protokoll; seit ein Medikament Plan UND Bedarf haben kann,
      // rechnet auch der Countdown daraus - und zwar zwei Stunden daneben.
      if (action === 'take') body.taken_at = toLocalStamp();
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
    await reloadMedViews();
    setDoseBusy(medId, false);
  } catch (err) {
    console.error('[Health] overview dose error:', err);
    setDoseBusy(medId, false);
    window.yuvomi?.showToast(err?.data?.error || t('health.meds.doseError'), 'danger');
  }
}

// --- Adherence-Quote + Streak ---

function overviewAdherenceMarkup() {
  const today = todayKey();
  const from = addLocalDays(today, -(OVERVIEW_ADHERENCE_DAYS - 1));
  const schedules = overviewAllSchedules();
  const planned = computeDueDoses(schedules, { from, to: today }).length;
  const logs = overviewScheduledLogs().filter((l) => {
    const k = String(l.scheduled_at || l.taken_at || l.created_at || '').slice(0, 10);
    return k >= from && k <= today;
  });
  const a = computeAdherence(logs, planned);
  const streak = computeAdherenceStreak(schedules, overviewScheduledLogs(), { today });

  if (a.rate === null) {
    return `<div class="metric-card__note">${esc(t('health.overview.adherence.noData'))}</div>`;
  }
  // Frühzustand ohne Vorwurf: solange nichts protokolliert ist, kein „0 %".
  if (a.taken === 0) {
    return `<div class="metric-card__note">${esc(t('health.overview.adherence.notStarted'))}</div>`;
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
        <div class="metric-card__progress"><span style="--fill:${pct / 100}"></span></div>
      </div>
      ${streakStat}
    </div>`;
}

// --- Letzte Vitalwerte (Karten, Klick navigiert zum Vitalwerte-Tab) ---

function overviewVitalsMarkup() {
  const today = todayKey();
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
  let metaHtml = `<span class="metric-card__note">${esc(t('health.vitals.noValue'))}</span>`;
  if (latest) {
    const unit = esc(vitalUnitText(metric, latest));
    const valueText = vitalValueText(metric, latest);
    valueHtml = `<span class="metric-card__value">${esc(valueText)}</span>${unit ? ` <span class="metric-card__unit">${unit}</span>` : ''}`;
    metaHtml = `
      <span class="metric-card__meta">
        ${deltaMarkup(series.deltas.value_num, metric)}
        <span>${esc(formatDate(String(latest.measured_at).slice(0, 10)))}</span>
      </span>`;
  } else {
    valueHtml = '<span class="metric-card__value metric-card__value--empty">–</span>';
  }

  // --inset: die Kachel liegt IN der Übersichtskarte (Kasten-in-Kasten,
  // Muster vorher .health-overview__card .health-metric-card).
  return `
    <button type="button" class="metric-card metric-card--select metric-card--inset" data-vital-nav="${esc(metric.type)}">
      <span class="metric-card__head">
        <i data-lucide="${esc(metric.icon)}" class="metric-card__icon" aria-hidden="true"></i>
        <span class="metric-card__label">${esc(label)}</span>
      </span>
      <span class="metric-card__body">${valueHtml}</span>
      ${metaHtml}
    </button>`;
}

// --- Nächste Erinnerungen (heute noch offene Zeitfenster, reine Anzeige) ---

function overviewUpcomingMarkup() {
  // „Welche Dosis steht heute noch aus" ist eine Frage an die Uhr, also an die
  // Anzeigezone. `toLocalDateKey(new Date())` war der Browser-Tag und
  // `getHours()` die Browser-Stunde: auf einem Geraet in einer anderen Zone
  // wurden Zeitfenster als verstrichen gefuehrt, die es noch gar nicht waren
  // (#829, Nachlese #851).
  const now = nowFields();
  const p2 = (n) => String(n).padStart(2, '0');
  const today = `${now.year}-${p2(now.month)}-${p2(now.day)}`;
  const nowTime = `${p2(now.hour)}:${p2(now.minute)}`;
  const up = upcomingDoses(overviewAllSchedules(), overviewAllLogs(), { today, nowTime, limit: 5 });
  if (!up.length) {
    return `<div class="health-overview__reminders-empty">${esc(t('health.overview.reminders.empty'))}</div>`;
  }
  const rows = up.map((dose) => {
    const med = overview.meds.find((m) => m.id === dose.medicationId);
    const doseText = dose.dose_qty != null ? ` · ${t('health.meds.doseQty', { count: fmtNum(dose.dose_qty) })}` : '';
    return `
      <li class="list-row health-overview-reminder">
        <span class="health-dose__time">${esc(dose.time)}</span>
        <span class="list-row__name health-dose__name">${esc(med ? med.name : '')}${esc(doseText)}</span>
      </li>`;
  }).join('');
  return `<ul class="health-overview__reminders-list">${rows}</ul>`;
}

// --- Schnell-Erfassung (nur eigene Person) ---

function quickCaptureMarkup() {
  if (!canEditFor(overview.personId, overview.meId)) return '';
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
  installPopoverMenus(overview.root);
  wirePersonSwitcher(overview, switchOverviewPerson);

  overview.root.querySelectorAll('[data-ov-dose-take]').forEach((btn) =>
    btn.addEventListener('click', () => handleOverviewDose(btn, 'take')));
  overview.root.querySelectorAll('[data-ov-dose-skip]').forEach((btn) =>
    btn.addEventListener('click', () => handleOverviewDose(btn, 'skip')));

  wirePrn(overview.root);

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
  anchor: todayKey(),
  loaded: false,
  error: false,
  root: null,
  // Im Trends-Abschnitt gewaehltes Symptom fuer das Wahrscheinlichkeits-Overlay
  // (Phase 4e) - null heisst "kein Overlay", derselbe Monatskalender bleibt
  // sonst unveraendert. Personen-/Monatswechsel setzen es zurueck (setzt
  // sich sonst leise auf einer fremden Person/einem falschen Symptom fort).
  likelihoodSymptom: null,
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
    cycle.error = err;
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
  cycle.anchor = todayKey();
  cycle.likelihoodSymptom = null;
  try { await loadCycle(); cycle.error = false; }
  catch (err) { console.error('[Health] cycle load error:', err); cycle.error = err; }
  renderCycleShell();
}

async function reloadCycle() {
  try { await loadCycle(); cycle.error = false; }
  catch (err) { console.error('[Health] cycle reload error:', err); cycle.error = err; }
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
    mountAreaLoadError(cycle, 'cycle', mountCycle);
    return;
  }

  const own = isOwnCycleView();
  // dayLogs mitgeben: Phase 3, ein bestätigter Temperaturanstieg im laufenden
  // Zyklus ersetzt das kalendarische Eisprungdatum (siehe predictCycle()-Doku).
  const prediction = predictCycle(cycle.periods, cycleSettings(), todayKey(), cycle.logs);

  const persons = `
    ${personSwitcherMarkup(cycle.members, cycle.personId, cycle.meId,
      { menuId: 'health-person-menu-cycle', label: t('health.cycle.personsLabel') })}
    ${readOnlyBannerMarkup(cycle.members, cycle.personId, own, cycle.meId)}`;

  // Schwangerschafts-Modus: Vorhersagen sind pausiert — statt Ring/Prognose wird
  // der Schwangerschafts-Status gezeigt. Logging, Kalender (ohne Projektion) und
  // Historie bleiben verfügbar; ohne Perioden-Historie entfällt nur die Historie.
  if (prediction.isPregnant) {
    cycle.root.insertAdjacentHTML('beforeend', `
      ${persons}
      ${cyclePregnancyMarkup(prediction, own)}
      ${own ? cycleTodayActionsMarkup(true) : ''}
      ${cycleCalendarMarkup(own)}
      ${prediction.hasData ? cycleTrendsMarkup() : ''}
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
      ${emptyStateHTML({
    icon: 'droplet',
    title: t('health.cycle.emptyTitle'),
    description: t('health.cycle.emptyDesc'),
    // Ohne eigenen Zyklus gibt es hier nichts einzutragen: der CTA entfaellt,
    // die Aussage bleibt.
    action: own
      ? { label: t('health.cycle.emptyCta'), icon: 'plus', attrs: { 'data-action': 'cycle-first' } }
      : undefined,
  })}`);
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
    ${cycleRingLegendMarkup(prediction)}
    ${own ? cycleTodayActionsMarkup() : ''}
    ${cycleCalendarMarkup(own)}
    ${cycleTrendsMarkup()}
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
        <span class="cycle-preg__bar-fill" style="--cycle-fill:${(pct / 100).toFixed(4)}"></span>
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
    // Bestätigt (Temperaturanstieg, Phase 3) bekommt einen zusätzlichen
    // Aussenring - derselbe Punkt, ein sichtbar anderer Zustand, keine zweite
    // Farbe (die bliebe ohne Legende unerklärt).
    if (ring.ovulationConfirmed) {
      markers += `<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="8" fill="none" stroke="var(--cycle-ovulation)" stroke-width="2" />`;
    }
    markers += `<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="5.5" fill="var(--cycle-ovulation)" stroke="var(--color-surface)" stroke-width="2.5" />`;
  }
  const [tx, ty] = cyclePolar(CX, CY, R, ring.currentFrac);
  markers += `<circle class="cycle-ring__now" cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="7.5" fill="var(--module-health)" stroke="var(--color-surface)" stroke-width="3" />`;

  // "Day N"-Sprechblase (Flo-Vorbild): sitzt am „jetzt"-Marker, aber ausserhalb
  // des Rings, statt die Tageszahl in der ohnehin engen Ringmitte unterzubringen.
  // Eine kurze Konnektorlinie verbindet Marker und Sprechblase, exakt am selben
  // Winkel (cyclePolar mit grösserem Radius) - keine zweite, unabhängige Position.
  const [lx, ly] = cyclePolar(CX, CY, R + SW / 2 + 3, ring.currentFrac);
  const [bx, by] = cyclePolar(CX, CY, R + SW / 2 + 19, ring.currentFrac);
  markers += `<line class="cycle-ring__connector" x1="${lx.toFixed(1)}" y1="${ly.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="var(--color-border)" stroke-width="1.5" />`;
  const badgeLeftPct = (bx / 220 * 100).toFixed(2);
  const badgeTopPct = (by / 220 * 100).toFixed(2);

  const phaseLabel = t(CYCLE_PHASE_LABEL_KEYS[prediction.phase] || CYCLE_PHASE_LABEL_KEYS[PHASE.FOLLICULAR]);
  const ringAria = `${phaseLabel} · ${t('health.cycle.ring.cycleDay', { day: prediction.cycleDay })} ${t('health.cycle.ring.of', { total: ring.total })}`;

  return `
    <div class="cycle-ring" data-phase="${esc(prediction.phase)}">
      <svg class="cycle-ring__svg" viewBox="0 0 220 220" role="img" aria-label="${esc(ringAria)}">
        <circle class="cycle-ring__track" cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke-width="${SW}" />
        ${arcs}
        ${markers}
      </svg>
      <div class="cycle-ring__daybadge" style="left:${badgeLeftPct}%; top:${badgeTopPct}%" aria-hidden="true">
        <span class="cycle-ring__daybadge-label">${esc(t('health.cycle.ring.dayBadge', { day: prediction.cycleDay }))}</span>
      </div>
      <div class="cycle-ring__center">
        <span class="cycle-ring__phase">${esc(phaseLabel)}</span>
        <span class="cycle-ring__status">${esc(`${t('health.cycle.status.nextPeriod')}: ${cycleCountdownText(prediction)}`)}</span>
      </div>
    </div>`;
}

/**
 * Kompakte Legende zum Ring - nur die drei Farben, die der Ring tatsaechlich
 * zeigt (Periode immer, fruchtbares Fenster/Eisprung nur bei aktivierter
 * Fruchtbarkeitsverfolgung, siehe cycleRing()). Bewusst NICHT die volle
 * Kalender-Legende (die auch "vorhergesagt"/"heute" fuehrt, was auf dem Ring
 * keine eigene Farbe hat) - dieselbe .cycle-legend-Komponente, aber eine
 * eigene, kleinere Auswahl. Der Ring-Mittelpunkt nennt die AKTUELLE Phase
 * schon als Text; diese Legende erklaert die uebrigen Bogenfarben, die sonst
 * nur ueber die Farbe selbst zu unterscheiden waeren.
 */
function cycleRingLegendMarkup(prediction) {
  const items = [{ cls: 'is-menstruation', key: 'health.cycle.legend.period' }];
  if (prediction.trackFertility) {
    items.push(
      { cls: 'is-fertile', key: 'health.cycle.legend.fertile' },
      { cls: 'is-ovulation', key: 'health.cycle.legend.ovulation' },
    );
  }
  return `<div class="cycle-legend cycle-ring__legend">${items.map((i) => `
    <span class="cycle-legend__item"><span class="cycle-legend__swatch ${i.cls}"></span>${esc(t(i.key))}</span>`).join('')}</div>`;
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
    // Bestätigt (Phase 3, Temperaturanstieg) vs. vorhergesagt (Kalendermethode) -
    // derselbe Unterschied, den predictCycle()/cycleRing() schon tragen, hier nur
    // sichtbar gemacht.
    const ovulationLabel = prediction.ovulationConfirmed
      ? t('health.cycle.status.ovulationConfirmed')
      : t('health.cycle.status.ovulation');
    tiles.push(cycleStatCardMarkup({
      icon: 'sparkles',
      labelKey: 'health.cycle.status.fertileWindow',
      value: `${formatDate(prediction.fertileStart)} – ${formatDate(prediction.fertileEnd)}`,
      sub: `${ovulationLabel}: ${formatDate(prediction.ovulationDate)}`,
    }));
  }

  // Regelmäßigkeit (Phase 4d): vorher nur sichtbar, wenn Fruchtbarkeit NICHT
  // verfolgt wird (prediction.trackFertility ? fertileWindow : regularity) -
  // mit Fruchtbarkeitsverfolgung an, dem Standard, war diese Kachel bisher
  // nirgends zu sehen. Jetzt immer da, unabhängig von trackFertility.
  const variationValue = stats.variation != null
    ? t('health.cycle.unit.days', { value: fmtNum(stats.variation) })
    : t('health.cycle.status.notEnoughData');
  const regularitySub = stats.regular === null ? '' : t(stats.regular ? 'health.cycle.status.regular' : 'health.cycle.status.irregular');
  tiles.push(cycleStatCardMarkup({ icon: 'activity', labelKey: 'health.cycle.status.cycleVariation', value: variationValue, sub: regularitySub }));

  // Ø Zyklus + Ø Periode teilen sich EINE volle-Breite-Kachel statt zweier fast
  // identischer Tiles — bricht die „identical card grid"-Wiederholung auf.
  // Der Typisch/Untypisch-Badge (Phase 4d, allgemein üblicher Bereich statt
  // des SELBSTBEZÜGLICHEN Regelmäßigkeits-Werts oben) erscheint nur bei einer
  // echten Basis (Historie oder manuelle Einstellung) - bei einem reinen
  // Default-Wert (source: 'default'/'insufficient_history') wäre "Typisch"
  // eine unbelegte Aussage über einen Platzhalter, keine echte Einschätzung.
  const hasRealCycleBasis = stats.source === 'history' || stats.source === 'settings';
  const typical = isTypicalCycleLength(stats.avgCycle);
  const typicalBadge = hasRealCycleBasis
    ? `<span class="cycle-stat__badge ${typical ? 'cycle-stat__badge--typical' : 'cycle-stat__badge--atypical'}">${esc(t(typical ? 'health.cycle.trends.typical' : 'health.cycle.trends.atypical'))}</span>`
    : '';
  const sourceText = cycleStatsSourceText(stats);
  tiles.push(`
    <div class="cycle-stat cycle-stat--dual">
      <div class="cycle-stat__pair-row">
        <div class="cycle-stat__pair-item">
          <span class="cycle-stat__head"><i data-lucide="repeat" aria-hidden="true"></i>${esc(t('health.cycle.status.avgCycle'))}</span>
          <span class="cycle-stat__value">${esc(t('health.cycle.unit.days', { value: fmtNum(stats.avgCycle) }))}${typicalBadge}</span>
        </div>
        <div class="cycle-stat__pair-item">
          <span class="cycle-stat__head"><i data-lucide="droplet" aria-hidden="true"></i>${esc(t('health.cycle.status.avgPeriod'))}</span>
          <span class="cycle-stat__value">${esc(t('health.cycle.unit.days', { value: fmtNum(stats.avgPeriod) }))}</span>
        </div>
      </div>
      ${sourceText ? `<span class="cycle-stat__sub">${esc(sourceText)}</span>` : ''}
    </div>`);

  return `<div class="cycle-stats">${tiles.join('')}</div>`;
}

// Erklärt, worauf Ø Zyklus/Periode gerade beruhen — sonst nicht von der UI
// unterscheidbar, ob ein Wert aus echter Historie stammt oder (zufällig
// identisch mit dem Default) nur die Kaltstart-Annahme ist.
function cycleStatsSourceText(stats) {
  if (stats.source === 'settings') return '';
  if (stats.source === 'history') {
    return t('health.cycle.stats.source.history', { count: stats.count });
  }
  if (stats.source === 'insufficient_history') {
    const gapsSoFar = Math.max(0, stats.count - 1);
    const remaining = Math.max(1, MIN_HISTORY_GAPS - gapsSoFar);
    return t('health.cycle.stats.source.insufficientHistory', { count: remaining });
  }
  return t('health.cycle.stats.source.default');
}

// --------------------------------------------------------
// Schnellerfassung „Heute"
// --------------------------------------------------------

function cycleOpenPeriod() {
  // Jüngste laufende Periode (kein Enddatum), deren Start nicht in der Zukunft liegt.
  const today = todayKey();
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
  const today = todayKey();
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
    await api.patch(`/health/cycle/periods/${open.id}`, { end_date: todayKey() });
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

  // Symptom-Wahrscheinlichkeits-Overlay (Phase 4e): nur Zusatzmarker auf
  // DEMSELBEN Monatskalender, keine zweite Kalenderflaeche - "getrackt"
  // (Symptom an diesem Tag tatsaechlich geloggt) vs. "wahrscheinlich"
  // (Zyklustag-Muster, aber nicht geloggt), derselbe Voll-/Umriss-Kontrast
  // wie geloggte vs. vorhergesagte Periode.
  let trackedDates = null;
  let predictedDates = null;
  if (cycle.likelihoodSymptom) {
    const settings = cycleSettings();
    trackedDates = new Set(
      (cycle.logs || [])
        .filter((l) => normalizeSymptomEntries(l.symptoms).some((e) => e.key === cycle.likelihoodSymptom))
        .map((l) => String(l.log_date).slice(0, 10)),
    );
    predictedDates = new Set(predictSymptomLikelihood(cycle.logs, cycle.periods, settings, cycle.likelihoodSymptom).likelyDates);
  }

  const weekdays = CYCLE_WEEKDAY_LABEL_KEYS
    .map((k) => `<span class="cycle-cal__wd">${esc(t(k))}</span>`).join('');

  const cells = cal.weeks.flat().map((c) => {
    const cls = ['cycle-cal__day'];
    if (!c.inMonth) cls.push('is-out');
    if (c.isToday) cls.push('is-today');
    if (c.phase) cls.push(`is-${c.phase}`);
    if (c.predicted) cls.push('is-predicted');
    if (c.hasLog) cls.push('has-log');
    if (trackedDates?.has(c.dateKey)) cls.push('is-symptom-tracked');
    else if (predictedDates?.has(c.dateKey)) cls.push('is-symptom-predicted');
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
        <h3 class="cycle-section__title u-section-title">${esc(t('health.cycle.calendar.title'))}</h3>
        <div class="cycle-cal__nav">
          <button class="btn btn--icon" data-cycle-month="-1" aria-label="${esc(t('health.cycle.calendar.prevMonth'))}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
          <span class="cycle-cal__month">${esc(cycleMonthLabel(cycle.anchor))}</span>
          <button class="btn btn--icon" data-cycle-month="1" aria-label="${esc(t('health.cycle.calendar.nextMonth'))}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="cycle-cal__weekdays" aria-hidden="true">${weekdays}</div>
      <!-- Bewusst OHNE role=grid: die Rolle verlangt row/gridcell-Struktur und
           verspricht Pfeiltasten-Navigation, die es hier nicht gibt. Die Tage
           sind eigenstaendige Buttons mit Datums-Label. -->
      <div class="cycle-cal__grid">${cells}</div>
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
  if (cycle.likelihoodSymptom) {
    items.push(
      { cls: 'is-symptom-tracked', key: 'health.cycle.trends.symptomTracked' },
      { cls: 'is-symptom-predicted', key: 'health.cycle.trends.symptomPredicted' },
    );
  }
  return `<div class="cycle-legend">${items.map((i) => `
    <span class="cycle-legend__item"><span class="cycle-legend__swatch ${i.cls}"></span>${esc(t(i.key))}</span>`).join('')}</div>`;
}

// --------------------------------------------------------
// Trends (Phase 4) — rein additiv über bereits vorhandenen Daten, deshalb
// zuletzt gebaut: erst ab genug Historie zeigt ein Trend etwas.
// --------------------------------------------------------

// Drei Eimer statt der fünf Ring-/Kalender-Phasen (siehe symptomFrequencyByPhase()
// im Util) - Menstruation und Luteal beantworten die eigentlich gefragten
// Muster, "other" ist eine bewusste Sammelkategorie, kein eigener Phasenwert.
// Farben: --cycle-period ist schon etabliert; Luteal bekommt den Modul-Akzent
// statt eines neuen, unvalidierten Tons; "other" bleibt neutral/gedämpft, wie
// eine Sammelkategorie es sein sollte.
const SYMPTOM_PHASE_COLOR = {
  [PHASE.MENSTRUATION]: 'var(--cycle-period)',
  [PHASE.LUTEAL]: 'var(--module-health)',
  other: 'var(--color-text-secondary)',
};
// BBT-Werte tragen 2 Nachkommastellen (0,01 °C ist die uebliche Aufloesung
// eines Basalthermometers); fmtNum()s Standard (1 Stelle) wuerde die Ziffer
// verschlucken, die detectTemperatureShift() tatsaechlich auswertet.
const BBT_DECIMALS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

const SYMPTOM_PHASE_LABEL_KEYS = {
  [PHASE.MENSTRUATION]: 'health.cycle.phase.menstruation',
  [PHASE.LUTEAL]: 'health.cycle.phase.luteal',
  other: 'health.cycle.trends.phaseOther',
};

/**
 * Ein einzelnes, unaufgefülltes Liniendiagramm (Zykluslänge, BBT) - dieselbe
 * Geometrie wie die Vitalwerte-Charts (utils/chart.js), aber ohne deren
 * Mehrkanal-/Zeitraum-Maschinerie, die hier keine Entsprechung hat: ein Trend
 * zeigt die GESAMTE Historie, keinen gewählten Ausschnitt.
 */
function simpleLineChartMarkup({ points, titleText, formatPointTooltip, formatTableValue, tableHeader, formatTick }) {
  if (points.length < 2) return '';
  const { W, H } = CHART;
  const { top, bottom } = chartScales();

  const values = points.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;

  const x = (i) => chartX(i, points.length);
  const y = (v) => chartY(v, min, max);

  const spine = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `<polygon class="health-chart__area" points="${x(0).toFixed(1)},${bottom.toFixed(1)} ${spine} ${x(points.length - 1).toFixed(1)},${bottom.toFixed(1)}" />`;
  const dots = points.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="var(--module-health)"><title>${esc(formatPointTooltip(p))}</title></circle>`).join('');

  const grid = chartGridMarkup(min, max, (val, wholeTicks) => (formatTick ? formatTick(val, wholeTicks) : String(wholeTicks ? Math.round(val) : val.toFixed(1))));
  const xLabels = chartXLabelsMarkup(points.map((p) => formatDate(p.date)));
  const table = chartTableMarkup(titleText, [t('health.cycle.trends.date'), tableHeader],
    points.map((p) => [formatDate(p.date), formatTableValue(p.value)]));

  return `
    <div class="health-chart-section">
      <div class="health-chart-section__head"><div class="health-chart-section__title">${esc(titleText)}</div></div>
      <svg class="health-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titleText)}">
        ${grid}
        ${area}
        <polyline fill="none" stroke="var(--module-health)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${spine}" />
        ${dots}
        ${xLabels}
      </svg>
      ${table}
    </div>`;
}

/**
 * Zykluslänge als Balkendiagramm mit typisch/untypisch-Färbung (Phase 4d,
 * ersetzt das vorherige Linien-/Flächendiagramm) - ein Balken pro Wert macht
 * "wie weicht DIESER Zyklus ab" direkter lesbar als eine Linie, deren Sinn
 * (Anstieg/Abfall) hier ohnehin nicht die eigentliche Aussage ist. Nullbasiert
 * (min=0), nicht um die Daten herum gepolstert wie simpleLineChartMarkup() -
 * ein Balkendiagramm mit verkürzter Achse würde Unterschiede verzerren, eine
 * Linie nicht (siehe dataviz-Anti-Pattern "truncated bar baseline").
 * Dieselbe geteilte Geometrie (chart.js), nur <rect> statt <polyline>+<circle>.
 */
function cycleLengthTrendChartMarkup(trend) {
  const { W, H } = CHART;
  const { left, right, bottom } = chartScales();
  const n = trend.length;

  const min = 0;
  const max = Math.max(...trend.map((e) => e.days), TYPICAL_CYCLE_RANGE.max) * 1.08;
  const y = (v) => chartY(v, min, max);

  // Referenzband für den allgemein üblichen Bereich - dieselbe Klasse/Optik
  // wie das Laborwert-Normband (analyteTrendChartMarkup), keine neue Farbe.
  const yHigh = y(TYPICAL_CYCLE_RANGE.max);
  const yLow = y(TYPICAL_CYCLE_RANGE.min);
  const band = `
    <rect class="health-chart__band" x="${left}" y="${yHigh.toFixed(1)}" width="${(right - left).toFixed(1)}" height="${(yLow - yHigh).toFixed(1)}" />
    <line class="health-chart__band-line" x1="${left}" y1="${yHigh.toFixed(1)}" x2="${right}" y2="${yHigh.toFixed(1)}" />
    <line class="health-chart__band-line" x1="${left}" y1="${yLow.toFixed(1)}" x2="${right}" y2="${yLow.toFixed(1)}" />`;

  // Bandskala statt chartX(): das teilt sich eine Geometrie mit den Linien-
  // Charts, deren Punkte am Rand (chartX(0,n) === left) genau auf die
  // Plotgrenze fallen duerfen, weil ein Punkt kein Volumen hat. Ein Balken hat
  // welches - an derselben Stelle zentriert ragt er zur Haelfte seiner Breite
  // ueber die Plotgrenze hinaus (Befund: der erste Balken uebermalte die
  // rechte Haelfte der "10"-Beschriftung, "10" sah wie "1" aus) und beruehrt
  // ohne Abstand die Achse. Jeder Balken bekommt stattdessen eine eigene,
  // gleich breite Bahn (bandWidth); der Balken selbst nimmt nur einen Teil
  // davon ein, der Rest ist Polsterung zu beiden Seiten - auch zu den
  // Plotgrenzen hin, nicht nur zwischen den Balken.
  const bandWidth = (right - left) / n;
  const barW = Math.max(6, Math.min(28, bandWidth * 0.5));
  const xFor = (i) => left + bandWidth * (i + 0.5);
  const typicalLabel = (typical) => t(typical ? 'health.cycle.trends.typical' : 'health.cycle.trends.atypical');

  const bars = trend.map((e, i) => {
    const cx = xFor(i);
    const by = y(e.days);
    const typical = isTypicalCycleLength(e.days);
    const color = typical ? 'var(--module-health)' : 'var(--color-warning)';
    const label = `${formatDate(e.date)}: ${t('health.cycle.unit.days', { value: fmtNum(e.days) })} (${typicalLabel(typical)})`;
    return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${(bottom - by).toFixed(1)}" rx="2" fill="${color}"><title>${esc(label)}</title></rect>`;
  }).join('');

  const grid = chartGridMarkup(min, max, (val) => String(Math.round(val)));
  // Eine eigene Beschriftung statt chartXLabelsMarkup() (dessen "erstes/
  // mittleres/letztes"-Auswahl fuer eine LINIE gedacht ist, deren Punkte
  // zwischen den drei Marken nur den Verlauf, keine eigene Kategorie tragen):
  // ein Balken IST eine eigene Kategorie und will grundsaetzlich sein eigenes
  // Datum darunter. Erst ab mehr Balken, als der 600 Einheiten breite Plot
  // ueberlappungsfrei beschriften kann, duennt eine feste Schrittweite aus -
  // Anfang und Ende bleiben dabei immer beschriftet.
  const MAX_BAR_LABELS = 8;
  const dense = n > MAX_BAR_LABELS;
  const labelStride = dense ? Math.ceil(n / MAX_BAR_LABELS) : 1;
  // Bei wenigen Balken (der Normalfall) darf jedes Label mittig unter seinem
  // eigenen Balken stehen - die Bandpolsterung schuetzt schon vor einem
  // Ueberlauf ueber die Plotgrenze. Erst wenn viele Balken die Baender schmal
  // machen, brauchen die beiden aeussersten Labels wieder den alten
  // Rand-Anker (start/end), sonst liefe der ausgeduennte erste/letzte Wert
  // ueber den Rand hinaus.
  const xLabels = trend.map((e, i) => {
    if (i !== 0 && i !== n - 1 && i % labelStride !== 0) return '';
    const anchor = i === 0 ? (dense ? 'start' : 'middle') : i === n - 1 ? (dense ? 'end' : 'middle') : 'middle';
    return `<text x="${xFor(i).toFixed(1)}" y="${H - 7}" class="chart__axis" text-anchor="${anchor}">${esc(formatDate(e.date))}</text>`;
  }).join('');
  const titleText = t('health.cycle.trends.cycleLength');
  const table = chartTableMarkup(titleText, [t('health.cycle.trends.date'), titleText],
    trend.map((e) => [formatDate(e.date), `${t('health.cycle.unit.days', { value: fmtNum(e.days) })} (${typicalLabel(isTypicalCycleLength(e.days))})`]));
  // Ohne Legende war die Bar-Farbe die einzige Auskunft "typisch/untypisch" -
  // sichtbar nur im Hover-Tooltip, auf einem Touch-Geraet also gar nicht.
  // Dieselbe .cycle-legend-Komponente wie Kalender und Symptom-Haeufigkeit,
  // keine neue Legenden-Optik erfunden.
  const legend = `
    <div class="cycle-legend">
      <span class="cycle-legend__item"><span class="cycle-legend__swatch" style="background:var(--module-health)"></span>${esc(typicalLabel(true))}</span>
      <span class="cycle-legend__item"><span class="cycle-legend__swatch" style="background:var(--color-warning)"></span>${esc(typicalLabel(false))}</span>
    </div>`;

  return `
    <div class="health-chart-section">
      <div class="health-chart-section__head"><div class="health-chart-section__title">${esc(titleText)}</div></div>
      <p class="health-chart-section__caption">${esc(t('health.cycle.trends.typicalRangeLabel', { min: TYPICAL_CYCLE_RANGE.min, max: TYPICAL_CYCLE_RANGE.max }))}</p>
      <svg class="health-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titleText)}">
        ${grid}
        ${band}
        ${bars}
        ${xLabels}
      </svg>
      ${legend}
      ${table}
    </div>`;
}

function bbtTrendChartMarkup(series) {
  return simpleLineChartMarkup({
    points: series.map((e) => ({ date: e.date, value: e.celsius })),
    titleText: t('health.cycle.bbt.label'),
    formatPointTooltip: (p) => `${formatDate(p.date)}: ${fmtNum(p.value, BBT_DECIMALS)} ${t('health.cycle.bbt.celsius')}`,
    formatTableValue: (v) => `${fmtNum(v, BBT_DECIMALS)} ${t('health.cycle.bbt.celsius')}`,
    tableHeader: t('health.cycle.bbt.label'),
    // BBT-Spannen liegen typischerweise unter 1 °C - hier ist die Nachkommastelle
    // die eigentliche Auskunft, nicht Pseudo-Präzision (siehe chart.js-Kommentar).
    formatTick: (val) => fmtNum(val, BBT_DECIMALS),
  });
}

/**
 * Symptom-Häufigkeit je Phase als gestapelte Anteilsbalken (DESIGN.md: ein
 * Verhältnis als Anteil am Element via flex-grow, eine Bahn, die Farbe traegt
 * die Fuellung) - Top 8 nach Gesamthäufigkeit, damit die Liste nicht alle
 * 20 Presets zeigt, auch wenn sie irgendwann alle mal vorkamen.
 */
/**
 * Schweregrad-Verlauf eines Symptoms (Phase 4b) - dieselbe simpleLineChartMarkup()-
 * Geometrie wie Zykluslänge/BBT, nur mit 1-3 statt Tagen/Grad als Werteachse.
 */
function symptomIntensityTrendChartMarkup(trend, symptomLabel) {
  return simpleLineChartMarkup({
    points: trend.map((e) => ({ date: e.date, value: e.intensity })),
    titleText: symptomLabel,
    formatPointTooltip: (p) => `${formatDate(p.date)}: ${t(symptomIntensityLabelKey(p.value))}`,
    formatTableValue: (v) => t(symptomIntensityLabelKey(v)),
    tableHeader: t('health.cycle.trends.severity'),
    formatTick: (val) => (Number.isInteger(val) && val >= 1 && val <= 3 ? String(val) : ''),
  });
}

/**
 * Zyklustag-Muster eines Symptoms (Phase 4c) - Satz + kompaktes Raster (ein
 * Balken je Zyklus, Tageszellen phasengefaerbt, Ring um die Zelle markiert
 * ein tatsaechliches Vorkommen). Kein eigener Farbcode fuer "Treffer" - eine
 * Umrandung bleibt auch fuer Farbfehlsichtige von der Fuellfarbe unterscheidbar,
 * ausserdem traegt title="" denselben Zyklustag als Text.
 */
function symptomCyclePatternMarkup(pattern, symptomLabel) {
  if (pattern.totalCount < 2) return '';
  const phaseLabel = pattern.mostCommonPhase ? t(SYMPTOM_PHASE_LABEL_KEYS[pattern.mostCommonPhase]) : null;
  // "N Tage vor der Periode" ist konkreter als "in der Lutealphase" und
  // gewinnt deshalb, wenn typicalDaysBeforePeriod ein echtes Muster gefunden
  // hat (mind. 2 Zyklen mit demselben Wert - siehe symptomCyclePattern()).
  // Sonst faellt es auf die grobe Phasen-Aussage zurueck, die immer verfuegbar
  // ist, sobald das Symptom ueberhaupt einmal vorkam.
  const sentence = pattern.typicalDaysBeforePeriod != null
    ? t('health.cycle.trends.cyclePatternDaysBefore', { symptom: symptomLabel, days: pattern.typicalDaysBeforePeriod })
    : phaseLabel
      ? t('health.cycle.trends.cyclePatternSentence', { symptom: symptomLabel, phase: phaseLabel, occurred: pattern.occurredCount, total: pattern.totalCount })
      : t('health.cycle.trends.cyclePatternNone', { symptom: symptomLabel, total: pattern.totalCount });

  const rows = pattern.cycles.map((c) => {
    const cells = c.phaseByDay.map((phase, i) => {
      const day = i + 1;
      const hit = c.occurredOnDays.includes(day);
      return `<span class="cycle-pattern-grid__cell${hit ? ' cycle-pattern-grid__cell--hit' : ''}" style="background:${SYMPTOM_PHASE_COLOR[phase]}" title="${esc(t('health.cycle.ring.cycleDay', { day }))}"></span>`;
    }).join('');
    return `
      <div class="cycle-pattern-grid__row">
        <span class="cycle-pattern-grid__label">${esc(formatDate(c.cycleStart))}</span>
        <div class="cycle-pattern-grid__days">${cells}</div>
      </div>`;
  }).join('');

  return `
    <div class="cycle-pattern">
      <p class="cycle-pattern__sentence">${esc(sentence)}</p>
      <div class="cycle-pattern-grid">${rows}</div>
    </div>`;
}

function symptomFrequencyChartMarkup(freq, dayLogs, periods, settings) {
  const top = freq.slice(0, 8);
  const legend = Object.keys(SYMPTOM_PHASE_COLOR).map((key) => `
    <span class="cycle-legend__item"><span class="cycle-legend__swatch" style="background:${SYMPTOM_PHASE_COLOR[key]}"></span>${esc(t(SYMPTOM_PHASE_LABEL_KEYS[key]))}</span>`).join('');

  const rows = top.map((row) => {
    const label = symptomType(row.key)?.labelKey ? t(symptomType(row.key).labelKey) : row.key;
    const segs = Object.keys(SYMPTOM_PHASE_COLOR)
      .map((key) => ({ key, count: row[key] || 0 }))
      .filter((s) => s.count > 0)
      .map((s) => `<span class="cycle-symptom-row__seg" style="--seg-share:${s.count};background:${SYMPTOM_PHASE_COLOR[s.key]}" title="${esc(`${t(SYMPTOM_PHASE_LABEL_KEYS[s.key])}: ${fmtNum(s.count)}`)}"></span>`)
      .join('');
    // Schweregrad-Punkte (Phase 4b): dieselbe Punkt-Komponente wie im Tages-Log-
    // Editor, gerundet auf die naechste Stufe - "nicht gradiert" zeigt bewusst
    // keine Punkte statt einer erfundenen Nullstufe.
    const dots = row.avgIntensity != null ? symptomIntensityDotsHTML(Math.round(row.avgIntensity)) : '';
    const trend = symptomIntensityTrend(dayLogs, row.key);
    const trendChart = trend.length >= 2
      ? advancedSection(symptomIntensityTrendChartMarkup(trend, label), { label: t('health.cycle.trends.severityTrend') })
      : '';
    // Zyklustag-Muster (Phase 4c): eigener, zweiter Aufklapper neben dem
    // Schweregrad-Verlauf - beide beantworten verschiedene Fragen und schliessen
    // sich nicht gegenseitig aus.
    const pattern = symptomCyclePattern(dayLogs, periods, settings, row.key);
    const patternMarkup = symptomCyclePatternMarkup(pattern, label);
    const patternSection = patternMarkup
      ? advancedSection(patternMarkup, { label: t('health.cycle.trends.cyclePattern') })
      : '';
    return `
      <div class="cycle-symptom-row">
        <div class="cycle-symptom-row__head">
          <span class="cycle-symptom-row__name">${esc(label)}${dots}</span>
          <strong>${esc(fmtNum(row.total))}</strong>
        </div>
        <div class="cycle-symptom-row__track">${segs}</div>
        ${trendChart}
        ${patternSection}
      </div>`;
  }).join('');

  return `
    <div class="health-chart-section">
      <div class="health-chart-section__head"><div class="health-chart-section__title">${esc(t('health.cycle.trends.symptomFrequency'))}</div></div>
      <div class="cycle-legend">${legend}</div>
      <div class="cycle-symptom-list">${rows}</div>
    </div>`;
}

/**
 * Symptom-Wahrscheinlichkeit (Phase 4e) - Symptom-Wahl treibt einen "heute
 * wahrscheinlich"-Hinweis und das Overlay auf dem Monatskalender (siehe
 * cycleCalendarMarkup). Die Auswahl selbst ist EIN globaler UI-Zustand
 * (cycle.likelihoodSymptom), kein Prop dieser Funktion, weil sie den
 * Kalender an anderer Stelle auf der Seite mitbestimmt.
 *
 * Nur Symptome mit genug betrachtbarer Zyklus-Historie (dieselbe
 * MIN_HISTORY_GAPS-Schwelle wie Phase 0/4e) UND mindestens einem
 * tatsaechlichen Vorkommen erscheinen im Wahl-Chips - ein Chip, der immer
 * "zu wenig Daten" sagt, waere kein nuetzlicher Chip.
 */
function symptomLikelihoodMarkup() {
  const settings = cycleSettings();
  const candidates = SYMPTOM_TYPES.filter((s) => {
    const p = symptomCyclePattern(cycle.logs, cycle.periods, settings, s.value);
    return p.totalCount >= MIN_HISTORY_GAPS && p.occurredCount > 0;
  });
  if (!candidates.length) return '';

  const selected = candidates.some((s) => s.value === cycle.likelihoodSymptom) ? cycle.likelihoodSymptom : null;
  const chips = candidates.map((s) => `
    <button type="button" class="health-choice" data-likelihood-symptom="${esc(s.value)}" aria-pressed="${s.value === selected}">${esc(t(s.labelKey))}</button>`).join('');

  let callout = '';
  if (selected) {
    const result = predictSymptomLikelihood(cycle.logs, cycle.periods, settings, selected);
    if (result.isLikelyToday) {
      const label = t(symptomType(selected)?.labelKey || selected);
      callout = `
        <p class="cycle-likelihood__callout"><i data-lucide="sparkles" aria-hidden="true"></i>${esc(t('health.cycle.trends.likelyToday', { symptom: label }))}</p>`;
    }
  }

  return `
    <div class="health-chart-section cycle-likelihood">
      <div class="health-chart-section__head"><div class="health-chart-section__title">${esc(t('health.cycle.trends.likelihoodTitle'))}</div></div>
      <p class="health-chart-section__caption">${esc(t('health.cycle.trends.likelihoodCaption'))}</p>
      <div class="cycle-likelihood__picker" role="group" aria-label="${esc(t('health.cycle.trends.likelihoodTitle'))}">${chips}</div>
      ${callout}
    </div>`;
}

function cycleTrendsMarkup() {
  const lengthTrend = cycleLengthTrend(cycle.periods);
  const settings = cycleSettings();
  const symptomFreq = symptomFrequencyByPhase(cycle.logs, cycle.periods, settings);
  const bbt = bbtSeries(cycle.logs);

  const sections = [
    lengthTrend.length >= 2 ? cycleLengthTrendChartMarkup(lengthTrend) : '',
    symptomFreq.length ? symptomFrequencyChartMarkup(symptomFreq, cycle.logs, cycle.periods, settings) : '',
    bbt.length >= 2 ? bbtTrendChartMarkup(bbt) : '',
    symptomLikelihoodMarkup(),
  ].filter(Boolean);

  // Kein leerer Abschnitt: ohne genug Historie für auch nur EINEN Trend
  // gibt es hier nichts zu zeigen - der Haupt-Leerzustand deckt das schon.
  if (!sections.length) return '';

  return `
    <section class="cycle-trends">
      <h3 class="cycle-section__title u-section-title">${esc(t('health.cycle.trends.title'))}</h3>
      ${sections.join('')}
    </section>`;
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
      <h3 class="cycle-section__title u-section-title">${esc(t('health.cycle.history.title'))}</h3>
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
  installPopoverMenus(cycle.root);
  wirePersonSwitcher(cycle, switchCyclePerson);

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
  cycle.root.querySelector('[data-action="cycle-log-today"]')?.addEventListener('click', () => openDayLogModal(todayKey()));
  cycle.root.querySelector('[data-action="cycle-settings"]')?.addEventListener('click', () => openCycleSettingsModal());

  // Symptom-Wahrscheinlichkeits-Chip (Phase 4e): erneutes Antippen des schon
  // gewaehlten Chips waehlt ab (Overlay aus) - dieselbe Toggle-Geste wie ein
  // aktiver Filter, kein Extra-"Zuruecksetzen"-Knopf noetig.
  cycle.root.querySelectorAll('[data-likelihood-symptom]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const key = btn.dataset.likelihoodSymptom;
      cycle.likelihoodSymptom = cycle.likelihoodSymptom === key ? null : key;
      renderCycleShell();
    }));
}

// Sichtbarkeit für ein Zyklus-Event vorauswählen: bestehender Wert gewinnt,
// sonst greift die persönliche Default-Preference aus den Cycle-Settings,
// sonst 'private'. Pro Event bleibt die Auswahl im Modal überschreibbar.
function cycleVisibilityFor(row) {
  return row?.visibility || cycle.settings?.default_visibility || 'private';
}

// --------------------------------------------------------
// Perioden-Modal (Anlegen/Bearbeiten inkl. Löschen)
// --------------------------------------------------------

function openPeriodModal(period) {
  const isEdit = Boolean(period && period.id);
  const startVal = isEdit ? String(period.start_date).slice(0, 10) : todayKey();
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
            <option value="private" ${cycleVisibilityFor(period) === 'family' ? '' : 'selected'}>${esc(t('health.cycle.visibility.private'))}</option>
            <option value="family" ${cycleVisibilityFor(period) === 'family' ? 'selected' : ''}>${esc(t('health.cycle.visibility.family'))}</option>
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
          refocusAfterRender();
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
  // Eigener Folgentext je Ziel: der Confirm-Titel ist für Periode und Tages-Log
  // derselbe, die Folgen sind es nicht (Vorhersage vs. Tageswerte).
  if (!(await confirmOverModal(t('health.cycle.deleteConfirm'),
    { danger: true, confirmLabel: t('common.delete'), detail: t('health.cycle.periodDeleteConfirmDetail') }))) return;
  try {
    await api.delete(`/health/cycle/periods/${period.id}`);
    window.yuvomi?.showToast(t('health.cycle.deleted'), 'success');
    await reloadCycle();
    refocusAfterRender();
  } catch (err) {
    console.error('[Health] cycle period delete error:', err);
    window.yuvomi?.showToast(err?.data?.error || t('health.cycle.deleteError'), 'danger');
  }
}

// --------------------------------------------------------
// Tages-Log-Modal (Flow, Symptome, Stimmung)
// --------------------------------------------------------

/** Drei feste Punkte, von links bis `level` gefuellt (0 = keiner). */
function symptomIntensityDotsHTML(level) {
  if (!level) return '';
  const dots = [1, 2, 3].map((n) => `<span class="health-choice__dot${n <= level ? ' health-choice__dot--filled' : ''}"></span>`).join('');
  const labelKey = symptomIntensityLabelKey(level);
  return `<span class="health-choice__dots" role="img" aria-label="${esc(labelKey ? t(labelKey) : '')}">${dots}</span>`;
}

function openDayLogModal(dateKey) {
  const key = String(dateKey).slice(0, 10);
  const existing = cycle.logs.find((l) => String(l.log_date).slice(0, 10) === key) || null;
  // Intensitaet je Symptom-Wert (0 = nicht ausgewaehlt, sonst 1-3) - die
  // einzige Quelle, die der Chip fuer seinen Zustand braucht.
  const activeIntensity = new Map(normalizeSymptomEntries(existing?.symptoms).map((e) => [e.key, e.intensity ?? 1]));
  const currentFlow = existing?.flow || '';
  const currentMood = existing?.mood || '';

  const flowButtons = [{ value: '', labelKey: 'health.cycle.flow.none' }, ...FLOW_LEVELS.map((f) => ({ value: f.value, labelKey: f.labelKey }))]
    .map((f) => `<button type="button" class="health-choice" data-flow="${esc(f.value)}" aria-pressed="${f.value === currentFlow}">${esc(t(f.labelKey))}</button>`).join('');

  // Ein Tap zyklisch durch 0 (aus) -> 1 -> 2 -> 3 -> 0: Auswahl UND Abstufung
  // sind derselbe Antipper, kein zweites Steuerelement je Chip.
  const symptomButtons = SYMPTOM_TYPES.map((s) => {
    const level = activeIntensity.get(s.value) || 0;
    return `<button type="button" class="health-choice health-choice--chip" data-symptom="${esc(s.value)}" data-intensity="${level}" aria-pressed="${level > 0}">
      <i data-lucide="${esc(s.icon)}" aria-hidden="true"></i>${esc(t(s.labelKey))}${symptomIntensityDotsHTML(level)}</button>`;
  }).join('');

  const moodOptions = [`<option value="" ${currentMood ? '' : 'selected'}>${esc(t('health.cycle.mood.none'))}</option>`,
    ...MOOD_TYPES.map((m) => `<option value="${esc(m.value)}" ${m.value === currentMood ? 'selected' : ''}>${esc(t(m.labelKey))}</option>`)].join('');

  const bbtUnit = existing?.basal_temp_unit === 'f' ? 'f' : 'c';
  const bbtValue = existing?.basal_temp != null ? String(existing.basal_temp) : '';

  openModal({
    title: `${t('health.cycle.dayLog.title')} · ${formatDate(key)}`,
    size: 'md',
    content: `
      <form id="cycle-log-form" class="form-stack">
        <div class="form-field">
          <span class="label">${esc(t('health.cycle.flow.label'))}</span>
          <div class="health-choices" data-group="flow" role="group" aria-label="${esc(t('health.cycle.flow.label'))}">${flowButtons}</div>
        </div>
        <div class="form-field">
          <span class="label">${esc(t('health.cycle.symptom.label'))}</span>
          <div class="health-choices health-choices--wrap" data-group="symptoms">${symptomButtons}</div>
        </div>
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="cycle-bbt">${esc(t('health.cycle.bbt.label'))}</label>
            <input class="input" id="cycle-bbt" type="number" inputmode="decimal" step="0.01" placeholder="${esc(t('health.cycle.bbt.placeholder'))}" value="${esc(bbtValue)}">
          </div>
          <div class="form-field">
            <label class="label" for="cycle-bbt-unit">${esc(t('health.cycle.bbt.unitLabel'))}</label>
            <select class="input" id="cycle-bbt-unit">
              <option value="c" ${bbtUnit === 'c' ? 'selected' : ''}>${esc(t('health.cycle.bbt.celsius'))}</option>
              <option value="f" ${bbtUnit === 'f' ? 'selected' : ''}>${esc(t('health.cycle.bbt.fahrenheit'))}</option>
            </select>
          </div>
        </div>
        <p class="cycle-hint">${esc(t('health.cycle.bbt.hint'))}</p>
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="cycle-mood">${esc(t('health.cycle.mood.label'))}</label>
            <select class="input" id="cycle-mood">${moodOptions}</select>
          </div>
          <div class="form-field">
            <label class="label" for="cycle-log-visibility">${esc(t('health.cycle.field.visibility'))}</label>
            <select class="input" id="cycle-log-visibility">
              <option value="private" ${cycleVisibilityFor(existing) === 'family' ? '' : 'selected'}>${esc(t('health.cycle.visibility.private'))}</option>
              <option value="family" ${cycleVisibilityFor(existing) === 'family' ? 'selected' : ''}>${esc(t('health.cycle.visibility.family'))}</option>
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
      // Flow: Einfachauswahl (Toggle). Symptome: Mehrfachauswahl mit Stufe -
      // ein Tap zyklisch durch aus -> mild -> maessig -> stark -> aus.
      wireChoiceGroup(panel, 'flow');
      panel.querySelectorAll('[data-symptom]').forEach((btn) => btn.addEventListener('click', () => {
        const next = (Number(btn.dataset.intensity) + 1) % 4;
        btn.dataset.intensity = String(next);
        btn.setAttribute('aria-pressed', String(next > 0));
        btn.querySelector('.health-choice__dots')?.remove();
        btn.insertAdjacentHTML('beforeend', symptomIntensityDotsHTML(next));
      }));

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="cycle-delete-log"]')?.addEventListener('click', () => deleteDayLog(existing));

      panel.querySelector('#cycle-log-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const flowBtn = panel.querySelector('[data-group="flow"] .health-choice[aria-pressed="true"]');
        const symptoms = [...panel.querySelectorAll('[data-symptom][aria-pressed="true"]')]
          .map((b) => ({ key: b.dataset.symptom, intensity: Number(b.dataset.intensity) || null }));
        const bbtRaw = panel.querySelector('#cycle-bbt').value.trim();
        const body = {
          log_date: key,
          flow: flowBtn?.dataset.flow || '',
          symptoms,
          basal_temp: bbtRaw === '' ? null : Number(bbtRaw),
          basal_temp_unit: bbtRaw === '' ? null : panel.querySelector('#cycle-bbt-unit').value,
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
          refocusAfterRender();
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
  if (!(await confirmOverModal(t('health.cycle.deleteConfirm'),
    { danger: true, confirmLabel: t('common.delete'), detail: t('health.cycle.logDeleteConfirmDetail') }))) return;
  try {
    await api.delete(`/health/cycle/logs/${log.id}`);
    window.yuvomi?.showToast(t('health.cycle.deleted'), 'success');
    await reloadCycle();
    refocusAfterRender();
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
  const dueTodayKey = todayKey();
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
            aria-describedby="cs-auto-hint"
            placeholder="${esc(fmtNum(stats.avgCycle))}" value="${esc(val(s.cycle_length_avg))}">
        </div>
        <div class="form-field">
          <label class="label" for="cs-period">${esc(t('health.cycle.settings.periodLength'))}</label>
          <input class="input" id="cs-period" type="number" inputmode="numeric" min="1" max="15" step="1"
            aria-describedby="cs-auto-hint"
            placeholder="${esc(fmtNum(stats.avgPeriod))}" value="${esc(val(s.period_length_avg))}">
        </div>
        <div class="form-field">
          <label class="label" for="cs-luteal">${esc(t('health.cycle.settings.lutealLength'))}</label>
          <input class="input" id="cs-luteal" type="number" inputmode="numeric" min="8" max="18" step="1"
            aria-describedby="cs-auto-hint"
            value="${esc(val(s.luteal_length ?? 14))}">
        </div>
        <label class="cycle-toggle">
          <input type="checkbox" id="cs-fertility" ${s.track_fertility === 0 ? '' : 'checked'}>
          <span>${esc(t('health.cycle.settings.trackFertility'))}</span>
        </label>
        <p class="cycle-hint" id="cs-auto-hint">${esc(t('health.cycle.settings.autoHint'))}</p>
        <div class="form-field">
          <label class="label" for="cs-default-visibility">${esc(t('health.cycle.settings.defaultVisibility'))}</label>
          <select class="input" id="cs-default-visibility" aria-describedby="cs-default-visibility-hint">
            <option value="private" ${s.default_visibility === 'family' ? '' : 'selected'}>${esc(t('health.cycle.visibility.private'))}</option>
            <option value="family" ${s.default_visibility === 'family' ? 'selected' : ''}>${esc(t('health.cycle.visibility.family'))}</option>
          </select>
          <p class="cycle-hint" id="cs-default-visibility-hint">${esc(t('health.cycle.settings.defaultVisibilityHint'))}</p>
        </div>
        <hr class="cycle-settings__sep">
        <div class="form-field">
          <label class="label" for="cs-remind-days">${esc(t('health.cycle.settings.remindPeriodDaysBefore'))}</label>
          <select class="input" id="cs-remind-days" aria-describedby="cs-remind-days-hint">
            <option value="" ${s.remind_period_days_before == null ? 'selected' : ''}>${esc(t('health.cycle.settings.remindOff'))}</option>
            ${[0, 1, 2, 3, 5, 7, 10, 14].map((d) => `<option value="${d}" ${Number(s.remind_period_days_before) === d ? 'selected' : ''}>${esc(d === 0 ? t('health.cycle.settings.remindSameDay') : t('health.cycle.unit.days', { value: d }))}</option>`).join('')}
          </select>
          <p class="cycle-hint" id="cs-remind-days-hint">${esc(t('health.cycle.settings.remindPeriodDaysBeforeHint'))}</p>
        </div>
        <label class="cycle-toggle">
          <input type="checkbox" id="cs-remind-log" ${s.remind_log_daily ? 'checked' : ''}>
          <span>${esc(t('health.cycle.settings.remindLogDaily'))}</span>
        </label>
        <div class="form-field cycle-bulk">
          <button type="button" class="btn btn--secondary" data-action="cycle-apply-visibility"
            aria-describedby="cs-bulk-hint">${esc(t('health.cycle.settings.applyToAll'))}</button>
          <p class="cycle-hint" id="cs-bulk-hint">${esc(t('health.cycle.settings.applyToAllHint'))}</p>
          <div class="cycle-bulk__confirm" data-role="bulk-confirm" role="group" aria-labelledby="cs-bulk-question" hidden>
            <p class="cycle-hint cycle-bulk__question" id="cs-bulk-question" data-role="bulk-confirm-text"></p>
            <div class="cycle-bulk__actions">
              <button type="button" class="btn btn--ghost" data-action="cycle-apply-cancel">${esc(t('common.cancel'))}</button>
              <button type="button" class="btn btn--primary" data-action="cycle-apply-run" aria-describedby="cs-bulk-question">${esc(t('common.confirm'))}</button>
            </div>
          </div>
        </div>
        <hr class="cycle-settings__sep">
        <label class="cycle-toggle">
          <input type="checkbox" id="cs-pregnancy" aria-describedby="cs-pregnancy-hint" ${s.pregnancy_mode ? 'checked' : ''}>
          <span>${esc(t('health.cycle.settings.pregnancyMode'))}</span>
        </label>
        <div class="form-field" id="cs-due-field" ${s.pregnancy_mode ? '' : 'hidden'}>
          <label class="label" for="cs-due">${esc(t('health.cycle.settings.dueDate'))}</label>
          <yuvomi-datepicker id="cs-due" type="date" value="${esc(s.pregnancy_due_date || '')}" min="${esc(dueMin)}" max="${esc(dueMax)}"></yuvomi-datepicker>
        </div>
        <p class="cycle-hint" id="cs-pregnancy-hint">${esc(t('health.cycle.settings.pregnancyHint'))}</p>
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

      // Bulk-Sichtbarkeit: setzt alle bestehenden Einträge auf den oben gewählten
      // Wert. Inline-Bestätigung statt confirmModal - das Modal-System stapelt
      // nicht, ein verschachteltes confirmModal würde die Settings mitsamt noch
      // ungespeicherter Eingaben schließen. Betrifft nur die eigenen Daten.
      const bulkBtn     = panel.querySelector('[data-action="cycle-apply-visibility"]');
      const bulkConfirm = panel.querySelector('[data-role="bulk-confirm"]');
      const bulkText    = panel.querySelector('[data-role="bulk-confirm-text"]');
      const bulkRun     = panel.querySelector('[data-action="cycle-apply-run"]');
      const visSelect   = panel.querySelector('#cs-default-visibility');
      const selectedVisibility = () => visSelect.value || 'private';
      const visLabel = () => t(`health.cycle.visibility.${selectedVisibility()}`);
      const showBulk = (confirming) => { bulkConfirm.hidden = !confirming; bulkBtn.hidden = confirming; };
      // Button-Label nennt den Zielwert und folgt dem Dropdown - so ist vor dem
      // Klick klar, worauf „alle" gesetzt werden.
      const syncBulkLabel = () => { bulkBtn.textContent = t('health.cycle.settings.applyToAllValue', { visibility: visLabel() }); };
      syncBulkLabel();
      visSelect.addEventListener('change', syncBulkLabel);
      bulkBtn?.addEventListener('click', () => {
        bulkText.textContent = t('health.cycle.settings.applyToAllConfirm', { visibility: visLabel() });
        showBulk(true);
        bulkRun.focus(); // Fokus auf die Bestätigung; SR liest die Frage via aria-describedby
      });
      panel.querySelector('[data-action="cycle-apply-cancel"]')?.addEventListener('click', () => { showBulk(false); bulkBtn.focus(); });
      bulkRun?.addEventListener('click', async () => {
        bulkRun.disabled = true;
        try {
          const { data } = await api.patch('/health/cycle/visibility', { visibility: selectedVisibility() });
          const count = (data?.periods || 0) + (data?.logs || 0);
          showBulk(false);
          window.yuvomi?.showToast(t('health.cycle.settings.applyToAllDone', { count }), 'success');
          await reloadCycle();
        } catch (err) {
          console.error('[Health] cycle bulk visibility error:', err);
          window.yuvomi?.showToast(err?.data?.error || t('health.cycle.saveError'), 'danger');
        } finally {
          bulkRun.disabled = false;
        }
      });

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
          default_visibility: panel.querySelector('#cs-default-visibility').value || 'private',
          remind_period_days_before: numOr('#cs-remind-days'),
          remind_log_daily: panel.querySelector('#cs-remind-log').checked,
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

export const __test = {
  canEditFor,
  // Testseam fuer #1031: setzt `careFor` fuer die drei Berechtigungsfaelle
  // (eigene Daten, betreute Person, unbeteiligtes Mitglied), ohne das Array
  // selbst nach aussen zu geben - Tests koennen die Betreuungsliste nur ganz
  // ersetzen, nicht das Modul-interne Array direkt mutieren.
  setCareForForTest(list) {
    careFor = Array.isArray(list) ? [...list] : [];
  },
};
