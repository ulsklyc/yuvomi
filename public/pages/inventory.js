/**
 * Modul: Inventar (Inventory)
 * Zweck: Besitz erfassen - Ort, Kategorie, Kaufpreis, Fristen (Stufe 1:
 *        kein Verknuepfen mit Buchungen/Dokumenten/Abos, das kommt in spaeteren
 *        Stufen). Orte (zwei Ebenen) und Kategorien werden ueber dieselbe
 *        yuvomi-category-manager-Komponente verwaltet, die Budget fuer seine
 *        Kategorien/Unterkategorien nutzt.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { metricGlanceHtml, wireMetricGlance } from '/utils/metric-glance.js';
import {
  openModal as openSharedModal,
  closeModal as closeSharedModal,
  advancedSection,
  wireBlurValidation,
  reportFieldError,
  confirmModal,
  refocusAfterRender,
} from '/components/modal.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateEl } from '/utils/empty-state.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { pageToolsMenuHtml, pageToolsActionEl, installPopoverMenus } from '/utils/popover-menu.js';
import { formatMoney } from '/utils/money.js';
import { todayKey } from '/utils/date.js';
import { formatDate, getLocale, getNumberFormat } from '/i18n.js';
import { renderDocumentAttachField, bindDocumentAttachField } from '/components/document-attach.js';
import { pathAccess, mayWritePath } from '/utils/module-access.js';
import { warrantyStatus, hasUpcomingDeadline, dateStatus, countUpcomingDeadlines, deadlineChipSpec } from '/utils/inventory-warranty.js';
import { openDetailView, closeDetailView } from '/components/detail-view.js';
import { mountMasterDetail, splitViewDetailHtml } from '/utils/master-detail.js';
import { wireScrollFade } from '/utils/ux.js';
import { redrawList, collapseRow } from '/utils/list-motion.js';
import { attachOverlay, whenHistorySettled } from '/utils/overlay-history.js';
import { setNavBadge } from '/utils/nav-badges.js';
import { CHART, chartScales, chartY, chartGridMarkup, niceDomain, chartTimePositions, chartTimeLabelsMarkup } from '/utils/chart.js';

let _container = null;
let _search = null;
let _householdCurrency = 'EUR';
/** Liste + Detail (utils/master-detail.js); null vor dem ersten Laden. */
let _md = null;

const state = {
  items: [],
  locations: [],
  categories: [],
  query: '',
  filterAttention: false,
  activeCategory: null,  // Kategorie-Chip; null = alle
};

/**
 * Darf dieses Konto ins Inventar schreiben? Regel 1 in utils/module-access.js.
 * Als Funktion, damit jedes Neuzeichnen neu fragt (ein Rechtewechsel kommt
 * ohne Reload an).
 *
 * WAS BEI `read` BLEIBT: Suche, Kennzahlen, Fristen-Filter, Kategorien, die
 * Zeile mit Status und Frist als ZEICHEN - und der Tipp auf sie, der die
 * Detailansicht oeffnet. Die war schon immer eine Leseansicht (Regel 9); bei
 * `read` nennt sie zusaetzlich, was sonst nur das Formular zeigte: den
 * Erinnerungs-Vorlauf und das Monats-Intervall einer Frist.
 * WAS GEHT: Anlegen (FAB, Leerzustand samt Einladungstext), „Bearbeiten" und
 * „Loeschen" der Detailansicht, „Erledigt" an einer faelligen Frist und die
 * Verwaltung von Orten und Kategorien (Regel 7). Belege lesen und oeffnen
 * folgt weiter dem Dokumente-Recht (attachmentDetailEntries), verknuepfte
 * Buchungen dem Budget-Recht (showsBookings).
 *
 * KEIN WANDTABLETT: ein Display fuehrt `inventory` nicht in seiner Scope-Liste
 * (server/display-scopes.js) und erreicht diese Seite nicht; ein
 * `actingAsDisplay()` davor braucht es hier nicht.
 */
function readOnly() {
  return !mayWritePath('/inventory');
}

async function loadLocations() {
  const res = await api.get('/inventory/locations');
  state.locations = res.data;
}

async function loadCategories() {
  const res = await api.get('/inventory/categories');
  state.categories = res.data;
}

/** Client-Spiegel von items.js#categoryTracksOdometer - dieselbe Flagge (state.categories),
 *  kein hartcodierter 'vehicles'-Vergleich mehr (Review #1257). */
function categoryTracksOdometer(categoryKey) {
  return state.categories.find((c) => c.key === categoryKey)?.tracks_odometer === 1;
}

// --------------------------------------------------------
// Ort-Verwaltung (zwei Ebenen ueber dieselbe Komponente wie Budget-Kategorien)
// --------------------------------------------------------
async function openLocationManager() {
  if (readOnly()) return;
  await import('/components/category-manager.js');

  // Die Auffrischung haengt am Ereignis, nicht am Schliessen: beim Loeschen
  // raeumt `confirmOverModal` das Modal darunter ab, bevor `api.delete` laeuft
  // (siehe `_notifyChanged` in components/category-manager.js). Ein in onClose
  // ausgewerteter Merker stuende hier auf false - und genau das Loeschen ist
  // der Fall, der die Liste veralten laesst.
  const onChanged = async () => {
    try {
      await loadLocations();
      // Loeschen einer Location NULLt location_id betroffener Items
      // server-seitig - die Liste muss neu geladen werden, sonst zeigt sie
      // veraltete location_path-Werte bis zum naechsten vollen Reload.
      await loadItems();
      renderList({ repaint: true });
      updateAttentionBadge();
      refocusAfterRender();
    } catch (err) {
      // NICHT „meldet der Manager selbst": der meldet nur seine eigene
      // Mutation, und die ist hier schon durch - `_notifyChanged()` kommt erst
      // nach ihrem Erfolg. Was hier ankommt, ist ein Fehler DIESER
      // Auffrischung, und ohne Meldung zeigte die Seite den alten Stand
      // weiter, obwohl der Server die Gegenstaende bereits umgehaengt hat.
      console.error('[Inventory] Auffrischen nach Ort-Aenderung fehlgeschlagen:', err);
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  };

  openSharedModal({
    title: t('inventory.manageLocations'),
    size: 'lg',
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    onSave: (panel) => {
      const manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/inventory/locations',
        groups: [{ key: '', labelKey: '', addLabelKey: 'inventory.addLocation', subcategories: true }],
        supportsSubcategories: true,
        titleKey: 'inventory.manageLocations',
        hintKey: 'inventory.manageLocationsHint',
        addPlaceholderKey: 'inventory.addLocation',
        deleteDetailKey: 'inventory.locationDeleteConfirmDetail',
        subDeleteDetailKey: 'inventory.locationDeleteConfirmDetail',
      });
    },
    // Bewusst KEIN onClose, das den Listener abmeldet - es liefe vor dem
    // Loeschen. Das Element entsteht je Oeffnen neu und geht mit dem Overlay.
  });
}

// --------------------------------------------------------
// Kategorie-Verwaltung (flach, keine Unterebene)
// --------------------------------------------------------
async function openCategoryManager() {
  if (readOnly()) return;
  await import('/components/category-manager.js');

  // Wie bei den Orten: das Ereignis traegt die Auffrischung, nicht das
  // Schliessen (siehe `_notifyChanged` in components/category-manager.js).
  const onChanged = async () => {
    try {
      await loadCategories();
      // Loeschen einer Kategorie weist betroffene Items server-seitig
      // 'other' zu - die Liste muss neu geladen werden, sonst zeigt sie
      // veraltete category_name-Werte bis zum naechsten vollen Reload.
      await loadItems();
      renderList({ repaint: true });
      updateAttentionBadge();
      refocusAfterRender();
    } catch (err) {
      // Wie beim Ort-Manager: hier landet nur ein Fehler der Auffrischung,
      // nie einer der Mutation - die hat der Manager schon quittiert.
      console.error('[Inventory] Auffrischen nach Kategorie-Aenderung fehlgeschlagen:', err);
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  };

  openSharedModal({
    title: t('inventory.manageCategories'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    onSave: (panel) => {
      const manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/inventory/categories',
        groups: [{ key: '', labelKey: '', addLabelKey: 'inventory.addCategory' }],
        labelResolver: categoryLabel,
        titleKey: 'inventory.manageCategories',
        hintKey: 'inventory.manageCategoriesHint',
        addPlaceholderKey: 'inventory.addCategory',
        deleteDetailKey: 'inventory.categoryDeleteConfirmDetail',
      });
    },
    // Bewusst KEIN onClose, das den Listener abmeldet - es liefe vor dem
    // Loeschen. Das Element entsteht je Oeffnen neu und geht mit dem Overlay.
  });
}

// --------------------------------------------------------
// Gegenstands-Liste
// --------------------------------------------------------

function statusLabel(status) {
  return t(`inventory.status${status.charAt(0).toUpperCase()}${status.slice(1)}`);
}

// Label einer Kategorie aufloesen: Seed-Kategorien tragen label_key (i18n),
// benutzerdefinierte tragen name - gleiches Muster wie tasks.js#catLabel.
function categoryLabel(category) {
  if (!category) return '';
  return category.label_key ? t(category.label_key) : (category.name || category.key);
}

// Gleiche Aufloesung fuer die vom Server denormalisierten category_name/
// category_label_key-Felder eines Items (JOIN in server/routes/inventory/items.js).
function itemCategoryLabel(item) {
  return item.category_label_key ? t(item.category_label_key) : (item.category_name || item.category);
}

// Kategorie-Auswahl des Gegenstands-Formulars. Eigene Funktion, damit der Guard
// sie mit einer Seed-Kategorie (name = NULL) fuettern kann: genau die stand
// zuvor unbeschriftet in der Liste, weil hier c.name statt categoryLabel() las
// (#783).
function categoryOptionsHtml(categories) {
  return categories
    .map((c) => `<option value="${esc(c.key)}">${esc(categoryLabel(c))}</option>`).join('');
}

function matchesQuery(item) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [item.name, item.brand, item.model, item.serial_number]
    .some((v) => v && String(v).toLowerCase().includes(q));
}

function matchesAttentionFilter(item) {
  return !state.filterAttention || hasUpcomingDeadline(item);
}

// --------------------------------------------------------
// EINE LISTE, DIE KATEGORIE IST EIN FILTER (Critique R17, E3)
//
// Bis R17 war `/inventory` eine Kategorienliste ohne einen einzigen Gegenstand
// (1280x800: vier Zeilen, 460px leer, zwei Klicks bis zum Detail) und
// `/inventory?category=<key>` eine zweite Ebene mit eigenem Kopf. Jetzt steht
// links IMMER die Liste aller Gegenstaende, nach Kategorie gruppiert, darueber
// die Kategorien als Filter-Chips; rechts das Detail. Mobil dieselbe Liste,
// das Detail als Blatt.
//
// Die Adresse bleibt, wie sie war: `?category=<key>` waehlt den Chip vor,
// `?open=<id>` die Auswahl (utils/master-detail.js). Ein Chip ist ein Filter
// und kein Schritt fuer die Zurueck-Taste - er ERSETZT die Adresse. Der
// Baustein bekommt ueber `mdAddress` gesagt, dass jeder Filterstand dieselbe
// Seite ist - sonst hielte er eine andere Kategorie fuer eine fremde Adresse,
// und der Router zeichnete bei jedem Zurueck die ganze Seite neu.
// --------------------------------------------------------

const INVENTORY_PATH = '/inventory';

/** Die Kategorie, die die Adresse nennt (`null` = alle). */
function categoryFromAddress(loc = globalThis.location) {
  return new URLSearchParams(loc?.search ?? '').get('category');
}

function inventoryHref({ category = null, open = null } = {}) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (open != null && open !== '') params.set('open', String(open));
  const query = params.toString();
  return query ? `${INVENTORY_PATH}?${query}` : INVENTORY_PATH;
}

/**
 * Den Filterstand in die Adresse schreiben - ersetzt, nie gestapelt. `path` im
 * State, weil der Router ihn bei popstate liest.
 */
function writeFilterAddress({ category = state.activeCategory, open = null } = {}) {
  const hist = globalThis.history;
  if (typeof hist?.replaceState !== 'function') return;
  const path = inventoryHref({ category, open });
  hist.replaceState({ ...(hist.state ?? {}), path }, '', path);
}

/** Adresse der Auswahl fuer den Baustein: `?open=` neben dem Filter. */
const mdAddress = {
  read: (loc) => (loc?.pathname === INVENTORY_PATH ? new URLSearchParams(loc.search ?? '').get('open') : undefined),
  href: (id) => inventoryHref({ category: state.activeCategory, open: id }),
};

/** Eine Kategorie ist waehlbar, solange ein Gegenstand in ihr steht. */
function isShownCategory(key) {
  return Boolean(key) && state.items.some((item) => item.category === key);
}

/**
 * Der Klick auf einen Chip (`null` = „Alle"). Suche und Fristen-Filter
 * bleiben stehen: die drei Fragen kombinieren sich, statt einander zu
 * loeschen. Die Auswahl rechts folgt der Liste (renderList -> refresh): steht
 * ihre Zeile noch da, bleibt sie, sonst waehlt der Baustein die erste.
 */
function selectCategory(key) {
  const next = isShownCategory(key) ? key : null;
  if (next === state.activeCategory) return;
  state.activeCategory = next;
  // ERST die Adresse, dann die Liste: der Neuaufbau schreibt die Auswahl
  // (`?open=`) ueber `mdAddress.href` NEBEN die Kategorie, die dann gilt.
  writeFilterAddress({ category: next, open: _md?.selectedId?.() ?? null });
  renderList();
  scrollListToTop();
}

/**
 * Zurueck/Vor: der Chip folgt der Adresse. Laeuft am popstate der Seite; die
 * Auswahl zieht die Seite danach selbst aus `?open=` nach (siehe dort).
 * @returns {boolean} ob sich der Filter geaendert hat
 */
function syncCategoryFromAddress() {
  const key = categoryFromAddress();
  const next = isShownCategory(key) ? key : null;
  if (next === state.activeCategory) return false;
  state.activeCategory = next;
  return true;
}

/** Gleicher Scroll-Container wie router.js bei echten Routenwechseln
 *  (#main-content) - ein anderer Filter beginnt oben. */
function scrollListToTop() {
  const main = globalThis.document?.getElementById('main-content');
  if (main) main.scrollTop = 0;
}

/**
 * Kategorien als Chips, in der Reihenfolge von state.categories; eine
 * Kategorie ohne Gegenstand bekommt keinen (wie sie keine Gruppe bekommt), ein
 * Gegenstand mit einer Kategorie, die es nicht mehr gibt, behaelt seinen ueber
 * `category_name` am Gegenstand selbst (wie groupItemsByCategory).
 * @returns {{key: string, name: string, count: number}[]}
 */
function categoryChips() {
  return groupItemsByCategory(state.items).map((g) => ({ key: g.key, name: g.name, count: g.items.length }));
}

function categoryChipHtml({ key, name, count }, active) {
  return `
    <button type="button" class="filter-chip filter-chip--sm${active ? ' filter-chip--active' : ''}"
            data-category="${esc(key)}" aria-pressed="${active}">
      ${esc(name)}<span class="filter-chip__count">${count}</span>
    </button>`;
}

/**
 * Fuellt die Chip-Zeile neu - eigene Funktion statt Teil von renderListBody(),
 * weil die Zeile ausserhalb von #inventory-list liegt (gleiches Muster wie
 * public/pages/documents.js#renderCategoryChips): sie behaelt so ihren
 * Scrollstand, wenn die Liste darunter neu steht. Die Zaehler nennen den
 * BESTAND der Kategorie, nicht die Treffer der Suche - ein Chip ist ein Ort,
 * keine Trefferzahl.
 */
function updateFilterChips() {
  const host = _container?.querySelector('#inventory-filters');
  if (!host) return;
  const chips = categoryChips();
  host.hidden = chips.length === 0;
  host.replaceChildren();
  if (!chips.length) return;
  host.insertAdjacentHTML('beforeend', `
    <button type="button" class="filter-chip filter-chip--sm${state.activeCategory == null ? ' filter-chip--active' : ''}"
            data-category="" aria-pressed="${state.activeCategory == null}">
      ${esc(t('common.all'))}<span class="filter-chip__count">${state.items.length}</span>
    </button>
    ${chips.map((chip) => categoryChipHtml(chip, chip.key === state.activeCategory)).join('')}`);
}

/**
 * Kennzahlen fuer die drei Karten oben auf der Liste - immer aus der
 * UNGEFILTERTEN Menge berechnet (wie budget-stats.js: eine Kennzahlzeile
 * bezieht sich auf den ganzen Bestand, nicht auf einen aktiven Filter).
 */
function computeMetrics(items) {
  // Summe der Kaufpreise, nicht eines Zeitwerts - siehe Diskussion #696:
  // eine manuell gepflegte Wertschaetzung veraltet unbemerkt, der Kaufpreis
  // ist und bleibt ein Fakt. Nur Items in der Haushaltswaehrung fliessen ein
  // - eine Fremdwaehrung ohne Umrechnung mitzusummieren waere schlicht
  // falsch, nicht nur ungenau. Seltener Randfall (die meisten Haushalte
  // fuehren Inventar in einer Waehrung), deshalb ausgeschlossen statt
  // umgerechnet.
  const totalValue = items.reduce((sum, item) => (
    item.purchase_price != null && item.currency === _householdCurrency
      ? sum + item.purchase_price
      : sum
  ), 0);
  return {
    count: items.length,
    totalValue,
    needsAttention: countUpcomingDeadlines(items),
  };
}

/**
 * Zaehler-Badge am Inventar-Nav-Icon - gleiches Muster wie
 * public/pages/tasks.js#updateOverdueBadge. Rein clientseitig aus der schon
 * geladenen Item-Liste berechnet, keine eigene Abfrage.
 */
function updateAttentionBadge() {
  // Ablaufende Frist = Warnung, nicht Alarm (Valenz siehe nav-badges.js).
  setNavBadge('/inventory', countUpcomingDeadlines(state.items),
    (count) => (count > 0 ? t('inventory.navLabelAttention', { count }) : t('nav.inventory')),
    'warning');
}

// Mobil ist die Kennzahl-Zeile EINE Kurzzeile (utils/metric-glance.js), die
// die Karten aufklappt (R16): drei Kacheln standen als 136px vor der ersten
// Kategorie, eine davon fuer „0". Der Merker haelt den Zustand ueber den
// Neuaufbau der Liste.
let _metricsExpanded = false;

function renderMetrics() {
  const { count, totalValue, needsAttention } = computeMetrics(state.items);
  // Ein aktiver Filter bleibt sichtbar: seine Kachel ist der Schalter, also
  // steht die Zeile dann aufgeklappt.
  const expanded = _metricsExpanded || state.filterAttention;
  const attentionEmpty = needsAttention === 0 && !state.filterAttention;
  return `
    ${metricGlanceHtml({
    id: 'inventory-glance-more',
    controls: 'inventory-metrics',
    expanded,
    label: t('inventory.metricItemsLabel'),
    value: String(count),
    flows: [
      { label: t('inventory.metricValueLabel'), amount: formatMoney(totalValue, _householdCurrency) },
      // Eine leere Kennzahl entfaellt in der Kurzzeile.
      needsAttention > 0 ? { label: t('inventory.metricAttentionLabel'), amount: String(needsAttention) } : null,
    ],
  })}
    <div class="metric-grid budget-glance-details${expanded ? ' is-expanded' : ''}" id="inventory-metrics">
      <div class="metric-card">
        <div class="metric-card__label">${esc(t('inventory.metricItemsLabel'))}</div>
        <div class="metric-card__value">${count}</div>
      </div>
      <div class="metric-card">
        <div class="metric-card__label">${esc(t('inventory.metricValueLabel'))}</div>
        <div class="metric-card__value">${esc(formatMoney(totalValue, _householdCurrency))}</div>
      </div>
      <button type="button" class="metric-card metric-card--select${state.filterAttention ? ' is-active' : ''}${attentionEmpty ? ' metric-card--empty' : ''}"
              data-action="toggle-attention-filter" aria-pressed="${state.filterAttention}">
        <div class="metric-card__label">${esc(t('inventory.metricAttentionLabel'))}</div>
        <div class="metric-card__value">${needsAttention}</div>
      </button>
    </div>`;
}

/**
 * Gruppiert nach Kategorie, in der Reihenfolge von state.categories
 * (DB-Sortierung), unbekannte Kategorien ans Ende - gleiches Muster wie
 * public/pages/shopping.js#groupItemsByCategory. Anders als dort liefert
 * die API bereits category_name/category_icon je Item mit (JOIN gegen
 * inventory_categories), also keine separate catIcon()-Nachschau noetig.
 */
function groupItemsByCategory(items) {
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.category)) {
      grouped.set(item.category, { key: item.category, name: itemCategoryLabel(item), icon: item.category_icon || 'package', items: [] });
    }
    grouped.get(item.category).items.push(item);
  }
  const orderedKeys = state.categories.map((c) => c.key);
  const known = orderedKeys.filter((k) => grouped.has(k));
  const unknown = [...grouped.keys()].filter((k) => !orderedKeys.includes(k));
  return [...known, ...unknown].map((k) => grouped.get(k));
}

/**
 * Nachschau von jeder Orts-ID (Wurzel UND Unterort) auf ihre TOP-LEVEL-Wurzel -
 * Grundlage der flachen Orts-Gruppierung (ein Level, wie bei Kategorien). Ein
 * Unterort zaehlt zu seiner Wurzel, nicht zu sich selbst (Design-Doc §2:
 * "Keller", nicht "Keller · Regal 2").
 */
function topLevelLocationLookup() {
  const map = new Map();
  for (const root of state.locations) {
    map.set(root.id, root);
    for (const child of root.subcategories || []) {
      map.set(child.id, root);
    }
  }
  return map;
}

/**
 * Gruppiert nach Top-Level-Ort, ortlose Gegenstaende in einer eigenen
 * "Unlocated"-Gruppe am Ende - gleiche Form wie groupItemsByCategory, damit
 * renderGroupedItems beide Gruppierungen unverändert rendern kann.
 */
function groupItemsByLocation(items) {
  const lookup = topLevelLocationLookup();
  const UNLOCATED_KEY = '__unlocated__';
  const grouped = new Map();
  for (const item of items) {
    const root = item.location_id != null ? lookup.get(item.location_id) : null;
    const key = root ? String(root.id) : UNLOCATED_KEY;
    if (!grouped.has(key)) {
      grouped.set(key, { key, name: root ? root.name : t('inventory.unlocated'), icon: 'map-pin', items: [] });
    }
    grouped.get(key).items.push(item);
  }
  // Kein "unbekannt"-Zweig wie bei groupItemsByCategory noetig: jeder Key in
  // `grouped` ist entweder eine echte Wurzel-ID (aus topLevelLocationLookup)
  // oder UNLOCATED_KEY - ein dritter Fall existiert strukturell nicht.
  const orderedKeys = state.locations.map((r) => String(r.id));
  const known = orderedKeys.filter((k) => grouped.has(k));
  const result = known.map((k) => grouped.get(k));
  if (grouped.has(UNLOCATED_KEY)) result.push(grouped.get(UNLOCATED_KEY));
  return result;
}

/** Geteilte Gruppen-Grammatik (styles/list-row.css), identisch zu
 *  public/pages/shopping.js#renderItems. Nimmt bereits gruppierte Daten
 *  entgegen (groupItemsByCategory ODER groupItemsByLocation), rendert beide
 *  gleich - die Gruppierungsstrategie ist Sache des Aufrufers. */
function renderGroupedItems(groups) {
  return groups.map((g) => `
    <div class="list-group" data-group-key="${esc(g.key)}">
      <div class="list-group__title">
        <i data-lucide="${esc(g.icon)}" class="icon-sm" aria-hidden="true"></i>
        ${esc(g.name)}
        <span class="list-group__count">${g.items.length}</span>
      </div>
      <div class="row-carrier">
        ${g.items.map(renderItemRow).join('')}
      </div>
    </div>`).join('');
}

/**
 * Fristen-Chip der Zeile - derselbe Baustein wie der Ablauf-Chip in Dokumente
 * (`.doc-badge`, list-row.css), damit eine Frist app-weit gleich aussieht.
 * Vorher stand hier ein 12px-`shield-alert` mit einem sr-only-Satz, der weder
 * Frist noch Datum nannte (Critique 2026-09-26). Welche Frist er zeigt und in
 * welchem Ton, entscheidet deadlineChipSpec() - dieselbe Regel, aus der Filter,
 * Kennzahl und Nav-Badge zaehlen. Die Garantie nennt ihr Enddatum ("bis"),
 * eine getrackte Frist den Abstand ("TUeV in 12 Tagen"); das Datum steht
 * zusaetzlich im title.
 */
function deadlineChipHtml(item) {
  const spec = deadlineChipSpec(item);
  if (!spec) return '';
  const date = formatDate(spec.endDateKey);
  let text;
  if (spec.kind === 'warranty') {
    text = spec.state === 'expired' ? t('inventory.warrantyChipExpired') : t('inventory.warrantyChipUntil', { date });
  } else if (spec.state === 'expired') {
    text = t('inventory.deadlineChipOverdue', { label: spec.label });
  } else {
    text = spec.days === 0
      ? t('inventory.deadlineChipToday', { label: spec.label })
      : t('inventory.deadlineChipInDays', { label: spec.label, count: spec.days });
  }
  return `<span class="doc-badge doc-badge--${spec.tone}" title="${esc(date)}"><i data-lucide="calendar-clock" aria-hidden="true"></i>${esc(text)}</span>`;
}

/**
 * Zeile ueber die geteilte Grammatik (styles/list-row.css) statt eigener
 * Geometrie: .list-row traegt Flaeche/Trennlinie/Hoehe, .list-row__main
 * (--interactive) den Klickbereich, .list-row__name/.list-row__meta Name und
 * Ort - exakt wie pantry.js#rowEl, damit Inventar optisch nicht vom Vorrat
 * abweicht (Groesse, Abstand, Trennlinie sind app-weit EIN Wert, nicht
 * modulweise nachgebaut). Nur Statusbadge und Kaufpreis sind Inventar-eigen
 * (Vorrat hat kein Aequivalent zu beidem).
 *
 * Der Status steht nur, wenn er vom Normalfall abweicht: „Vorhanden" in jeder
 * Zeile war Rauschen, das die Ausnahmen (Verkauft, Verloren) verdeckte (R10 L3,
 * A6 P3-3). Die Detailansicht nennt ihn weiter immer.
 */
function renderItemRow(item) {
  const hasAttachments = (item.attachments?.length ?? 0) > 0;
  const hasBookings = (item.linked_entries?.length ?? 0) > 0;
  return `
    <div class="list-row" data-id="${item.id}" data-md-id="${item.id}">
      <button type="button" class="list-row__main list-row__main--interactive" data-action="open-detail" data-md-focus>
        <span class="inventory-row__headline">
          <span class="list-row__name">${esc(item.name)}</span>
          ${hasAttachments ? `<i data-lucide="paperclip" class="icon-sm" aria-hidden="true"></i><span class="sr-only">${esc(t('inventory.hasAttachmentsLabel'))}</span>` : ''}
          ${hasBookings ? `<i data-lucide="receipt" class="icon-sm" aria-hidden="true"></i><span class="sr-only">${esc(t('inventory.hasBookingsLabel'))}</span>` : ''}
          ${item.status !== 'active' ? `<span class="inventory-status-badge inventory-status-badge--${esc(item.status)}">${esc(statusLabel(item.status))}</span>` : ''}
          ${deadlineChipHtml(item)}
        </span>
        ${item.location_path ? `<span class="list-row__meta">${esc(item.location_path)}</span>` : ''}
      </button>
      <span class="inventory-row__value">${item.purchase_price != null ? esc(formatMoney(item.purchase_price, item.currency)) : ''}</span>
    </div>`;
}

/**
 * Suchfeld-Text passend zum Geltungsbereich - sonst signalisiert nichts,
 * dass die Suche unter einem gewaehlten Kategorie-Chip nur INNERHALB dieser
 * Kategorie greift, obwohl sie sich global anfuehlt. Placeholder UND sr-only-Label, nicht nur
 * der sichtbare Platzhaltertext - sonst haert eine Screenreader-Nutzerin den
 * globalen Anspruch weiter.
 */
function updateSearchScope(text) {
  if (!_search?.input) return;
  _search.input.placeholder = text;
  const label = _search.input.closest('.page-search')?.querySelector('.page-search__label');
  if (label) label.textContent = text;
}

function wireItemRows(list) {
  list.querySelectorAll('[data-action="open-detail"]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.closest('.list-row')?.dataset.id);
      const item = state.items.find((i) => i.id === id);
      if (!item) return;
      // Ab der Schwelle waehlt der Klick aus (Detailspalte), darunter oeffnet
      // er das Sheet wie bisher - das entscheidet der Baustein, nicht wir.
      if (_md) _md.open(String(item.id), button);
      else openItemDetail(item);
    });
  });
}

/** Verdrahtet Klicks auf Gegenstands-Zeilen. */
const INVENTORY_ITEM_ROW = '.list-row[data-id]';

/* `motion: true` setzt, wer einen GEGENSTAND angelegt, gespeichert oder
 * geloescht hat: seine Zeile zieht auf, und was dadurch die Stelle wechselt,
 * gleitet (utils/list-motion.js). Die Bewegung haengt an zwei Dingen: dem
 * Traeger `#inventory-list` (er bleibt ueber jedes Zeichnen stehen) und
 * `data-id` an der Zeile des Gegenstands (renderItemRow). Chip, Suche und
 * Fristen-Filter zeichnen ohne Bewegung neu - dort wechselt die Frage, nicht
 * die Liste.
 *
 * `repaint` nach einer Datenaenderung (Speichern, Loeschen, Frist erledigt):
 * die Detailspalte zeichnet den ausgewaehlten Gegenstand neu. Ohne (Suche,
 * Filter) bleibt sie stehen - jeder Tastendruck in der Suche holte sonst den
 * Verlauf neu. */
function renderList({ repaint = false, motion = false } = {}) {
  const host = motion ? _container?.querySelector('#inventory-list') : null;
  if (host) redrawList(host, renderListBody, { selector: INVENTORY_ITEM_ROW, keyAttr: 'data-id' });
  else renderListBody();
  // Wie in Mail: verschwindet die ausgewaehlte Zeile aus der Liste (anderer
  // Ordner, Suche, geloescht), faellt die Spalte auf den Leerzustand zurueck.
  _md?.refresh({ repaint });
  // Die Chip-Zeile kommt und geht mit dem Bestand - die Spalte darunter misst neu.
  const page = _container?.querySelector('.inventory-page');
  syncDetailTop(page, page?.querySelector('.split-view__detail'));
}

/**
 * DIE DETAILSPALTE MISST, WO SIE STEHT (Runde 5, 2026-09-26).
 *
 * Ihre Hoehe rechnete nur den Kopf (`--inventory-head-block`). In Ruhe steht
 * unter dem Kopf aber noch die Filterzeile der Kategorie-Ebene, und die Spalte
 * ragte um deren Hoehe unter den Falz - gemessen bei 1440x900: Oberkante 133,
 * Hoehe 803, Unterkante 936. Beim Kleben ist die Filterzeile weggescrollt und
 * die alte Rechnung stimmt; dazwischen liegt jeder Zwischenstand. Statt die
 * Zustaende zu raten, setzt die Seite die gemessene Oberkante der Spalte als
 * `--inventory-detail-top`, und inventory.css rechnet die Hoehe von dort bis
 * zur Luft ueber dem Fensterrand. Eine ausgeblendete Spalte (unter der
 * Schwelle) misst nichts und laesst den Wert stehen.
 *
 * @param {HTMLElement|null|undefined} page    `.inventory-page`
 * @param {HTMLElement|null|undefined} detail  `.split-view__detail`
 */
function syncDetailTop(page, detail) {
  if (!page || !detail || !detail.getClientRects().length) return;
  page.style.setProperty('--inventory-detail-top', `${Math.round(detail.getBoundingClientRect().top)}px`);
}

/**
 * Der Leerzustand der Seite. Bei `read` nur die Auskunft: die Beschreibung
 * („Trage ein, was du besitzt ...") laedt zu der Handlung ein, die der Knopf
 * darunter meint, und faellt mit ihm weg (Regel 9).
 */
function emptyInventoryState() {
  if (readOnly()) return { title: t('inventory.emptyTitle') };
  return {
    title: t('inventory.emptyTitle'),
    description: t('inventory.emptyDescription'),
    action: { label: t('inventory.addItem'), icon: 'plus', onClick: () => openItemModal('create') },
  };
}

/**
 * Was die Liste zeigt: unter „Alle" jeder Gegenstand in der Gruppe seiner
 * Kategorie, unter einem Chip nur dessen Kategorie, nach Ort gruppiert. Suche
 * und Fristen-Filter greifen darin. Leer = nichts trifft.
 */
function visibleGroups() {
  const inCategory = state.activeCategory != null;
  const scoped = inCategory ? state.items.filter((item) => item.category === state.activeCategory) : state.items;
  const filtered = scoped.filter((item) => matchesQuery(item) && matchesAttentionFilter(item));
  if (!filtered.length) return [];
  return inCategory ? groupItemsByLocation(filtered) : groupItemsByCategory(filtered);
}

function resetFilters() {
  state.query = '';
  state.filterAttention = false;
  _search?.clear();
  renderList();
}

/**
 * Die EINE Liste: Kennzahlen, dann alle Gegenstaende nach Kategorie gruppiert.
 * Unter einem gewaehlten Chip steht nur dessen Kategorie - dann nach ORT
 * gruppiert, weil der Kategoriename als Gruppentitel nur den Chip
 * wiederholte. Suche und Fristen-Filter greifen in dem, was der Chip zeigt.
 */
function renderListBody() {
  const list = _container?.querySelector('#inventory-list');
  if (!list) return;

  // Die gewaehlte Kategorie kann verschwunden sein (ihr letzter Gegenstand
  // geloescht oder umgehaengt, die Kategorie selbst geloescht - der Server
  // haengt ihre Gegenstaende auf 'other' um): dann gilt wieder „Alle".
  if (state.activeCategory != null && !isShownCategory(state.activeCategory)) {
    state.activeCategory = null;
    writeFilterAddress({ category: null, open: _md?.selectedId?.() ?? null });
  }
  updateFilterChips();

  if (!state.items.length) {
    if (categoryFromAddress()) writeFilterAddress({ category: null });
    updateSearchScope(t('inventory.searchPlaceholder'));
    list.replaceChildren(emptyStateEl(emptyInventoryState()));
    return;
  }

  const category = state.activeCategory == null
    ? null
    : state.categories.find((c) => c.key === state.activeCategory)
      ?? { key: state.activeCategory, name: itemCategoryLabel(state.items.find((i) => i.category === state.activeCategory)) };
  updateSearchScope(category
    ? t('inventory.searchInCategoryPlaceholder', { category: categoryLabel(category) })
    : t('inventory.searchPlaceholder'));

  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', renderMetrics());
  wireMetricGlance(list, 'inventory-glance-more', (expanded) => { _metricsExpanded = expanded; });
  list.querySelector('[data-action="toggle-attention-filter"]')?.addEventListener('click', () => {
    state.filterAttention = !state.filterAttention;
    renderList();
  });

  const groups = visibleGroups();
  if (!groups.length) {
    list.appendChild(emptyStateEl(
      state.query
        ? {
            variant: 'no-results',
            title: t('inventory.noResultsTitle'),
            description: t('inventory.noResultsDescription'),
            hint: [`"${state.query}"`, state.filterAttention ? t('inventory.metricAttentionLabel') : null].filter(Boolean).join(' · '),
            action: { label: t('inventory.resetSearch'), onClick: resetFilters },
          }
        : {
            variant: 'no-results',
            title: t('inventory.attentionEmptyTitle'),
            description: t('inventory.attentionEmptyDescription'),
            action: { label: t('inventory.clearAttentionFilter'), onClick: resetFilters },
          },
    ));
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  list.insertAdjacentHTML('beforeend', renderGroupedItems(groups));
  wireItemRows(list);
  if (window.lucide) window.lucide.createIcons({ el: list });
}

async function loadItems() {
  const res = await api.get('/inventory/items');
  state.items = res.data;
}

// --------------------------------------------------------
// Detailansicht (nur Lesen, mit Inline-Wechsel ins Formular)
// --------------------------------------------------------

/**
 * Eine Liste aus Text(+Link)/Unterzeile-Paaren fuer eine Detail-Zeile -
 * gleiches Muster wie public/pages/contacts.js#contactLinksNode, wiederverwendet
 * fuer Anhaenge, verknuepfte Buchungen und getrackte Fristen (alle drei sind
 * strukturell "eine Liste aus Eintraegen mit optionalem Link und Unterzeile").
 * @param {{href?: string, text: string, sub?: string}[]} entries
 * @returns {HTMLElement|null}
 */
function inventoryDetailListNode(entries) {
  if (!entries.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'inventory-detail-list';
  entries.forEach(({ href, text, sub }) => {
    const line = document.createElement('div');
    line.className = 'inventory-detail-list__item';

    if (href) {
      const a = document.createElement('a');
      a.className = 'inventory-detail-list__link';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = text;
      line.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'inventory-detail-list__text';
      span.textContent = text;
      line.appendChild(span);
    }

    if (sub) {
      const s = document.createElement('span');
      s.className = 'inventory-detail-list__sub';
      s.textContent = sub;
      line.appendChild(s);
    }
    wrap.appendChild(line);
  });
  return wrap;
}

/**
 * Garantie-Zeile: die Dauer, und mit Kaufdatum dahinter der berechnete Stand
 * („24 Monate · Garantie gueltig bis ..."). Bis R17 stand der Stand ALLEIN
 * unter dem Formular-Label „Garantie (Monate)" - das Label versprach eine
 * Zahl, der Wert nannte ein Datum. Die Zeile heisst jetzt „Garantie" und nennt
 * beides.
 */
function warrantyDetailValue(item) {
  if (item.warranty_months == null) return '';
  const months = t('inventory.warrantyMonthsValue', { count: item.warranty_months });
  const status = warrantyStatus(item);
  if (!status) return months;
  // Der Key direkt, ohne Date-Umweg: `new Date(key + 'T00:00:00')` ist
  // Mitternacht der BROWSER-Zone, und in einer Haushaltszone westlich davon
  // faellt der angezeigte Tag dann auf den Vortag (#829 Teil 3).
  const formattedDate = formatDate(status.endDateKey);
  let stand;
  if (status.state === 'expired') stand = t('inventory.warrantyStatusExpired', { date: formattedDate });
  else if (status.state === 'expiring') stand = t('inventory.warrantyStatusExpiringSoon', { count: status.days });
  else stand = t('inventory.warrantyStatusValid', { date: formattedDate });
  return `${months} · ${stand}`;
}

/**
 * Was an einer Frist sonst nur das Formular zeigt: der Erinnerungs-Vorlauf und
 * das Monats-Intervall. Wer schreiben darf, findet beides hinter „Bearbeiten";
 * bei `read` gibt es das Formular nicht, also stehen die Werte in der Zeile
 * (Regel 9) - mit den Beschriftungen des Formulars, damit beide dasselbe sagen.
 */
function trackedDateFormOnlyValues(d) {
  if (!readOnly()) return [];
  return [
    d.reminder_offset_days != null ? `${t('inventory.trackedDateRemindBeforeLabel')}: ${d.reminder_offset_days}` : '',
    d.interval_months ? `${t('inventory.trackedDateIntervalMonthsLabel')}: ${d.interval_months}` : '',
  ];
}

/** Fristen-Zeile je getrackter Frist: Bezeichnung + Datum + Countdown. */
function trackedDateDetailEntries(item) {
  return (item.tracked_dates || []).map((d) => {
    const status = dateStatus(d.date);
    const countdown = !status ? '' : status.days < 0
      ? t('inventory.trackedDateOverdueDays', { count: Math.abs(status.days) })
      : status.days === 0 ? t('inventory.trackedDateDueToday')
      : t('inventory.trackedDateInDays', { count: status.days });
    const distanceHint = d.interval_distance
      ? t('inventory.trackedDateDistanceHint', { value: formatOdometer(d.interval_distance), count: d.interval_distance, unit: odometerUnitLabel(item.odometer_unit) })
      : '';
    const sub = [countdown ? `${formatDate(d.date)} · ${countdown}` : formatDate(d.date), distanceHint, ...trackedDateFormOnlyValues(d)]
      .filter(Boolean).join(' · ');
    return { text: d.label, sub };
  });
}

/**
 * Fristen-Zeilen der Detailansicht MIT "Erledigt"-Aktion auf einer faelligen
 * Zeile - eigener Knoten statt inventoryDetailListNode, weil dort keine
 * Aktion je Zeile vorgesehen ist. `onDone` bekommt die einzelne getrackte
 * Frist und loest die Abschluss-Karte aus (siehe openCompletionSheet).
 */
function trackedDatesDetailNode(item, onDone) {
  const rows = item.tracked_dates || [];
  if (!rows.length) return null;
  const entries = trackedDateDetailEntries(item);
  const wrap = document.createElement('div');
  wrap.className = 'inventory-detail-list';
  rows.forEach((d, i) => {
    const { text, sub } = entries[i];
    const status = dateStatus(d.date);
    const due = !!status && status.state !== 'valid';

    const line = document.createElement('div');
    line.className = 'inventory-tracked-date-detail-row';
    const main = document.createElement('div');
    main.className = 'inventory-detail-list__item';
    const span = document.createElement('span');
    span.className = 'inventory-detail-list__text';
    span.textContent = text;
    main.appendChild(span);
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'inventory-detail-list__sub';
      subEl.textContent = sub;
      main.appendChild(subEl);
    }
    line.appendChild(main);

    // „Erledigt" ist eine Handlung und faellt bei `read` weg; dass die Frist
    // faellig ist, sagt die Zeile selbst (Countdown in `sub`).
    if (due && typeof onDone === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--secondary btn--sm inventory-tracked-date-detail-row__done';
      btn.textContent = t('inventory.markDoneAction');
      btn.addEventListener('click', () => onDone(d));
      line.appendChild(btn);
    }
    wrap.appendChild(line);
  });
  return wrap;
}

/** Eine Zeile der Verlaufs-Ansicht (Service-Log-Eintrag, verknuepfte Buchung
 *  oder verknuepftes Dokument) - eine Zeitleiste aus drei Quellen, die es
 *  schon gibt (server/routes/inventory/service-log.js#loadHistory). */
function historyEntryLine(entry, odometerUnit) {
  const line = document.createElement('div');
  line.className = 'inventory-history-entry';
  const main = document.createElement('div');
  main.className = 'inventory-history-entry__main';

  const label = document.createElement('span');
  label.className = 'inventory-history-entry__label';
  label.textContent = entry.label;
  main.appendChild(label);

  const subParts = [formatDate(entry.date)];
  if (entry.type === 'service_log') {
    if (entry.vendor) subParts.push(entry.vendor);
    if (entry.odometer != null) {
      subParts.push(t('inventory.historyOdometerValue', { value: formatOdometer(entry.odometer), count: entry.odometer, unit: odometerUnit }));
    }
    if (entry.note) subParts.push(entry.note);
  } else if (entry.type === 'budget_entry') {
    subParts.push(roleLabel(entry.role));
  }
  const sub = document.createElement('span');
  sub.className = 'inventory-history-entry__sub';
  sub.textContent = subParts.join(' · ');
  main.appendChild(sub);
  line.appendChild(main);

  if (entry.type === 'budget_entry') {
    const amount = document.createElement('span');
    amount.className = 'inventory-history-entry__amount';
    amount.textContent = formatMoney(entry.amount, _householdCurrency);
    line.appendChild(amount);
  }
  return line;
}

/** Barrierefreie Tabelle unter dem Chart - lokales Gegenstueck zu
 *  health.js#chartTableMarkup (dort ebenfalls nicht geteilt: die Geometrie in
 *  utils/chart.js ist gemeinsam, das Vokabular je Modul eigen). */
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

/** Kilometerstand-Trend ueber die Zeit - dieselbe Geometrie wie die
 *  Health-Charts (utils/chart.js#simpleLineChartMarkup-Muster), hier fuer die
 *  eine Zeitreihe, die ein Gegenstand hat. Mindestens zwei Punkte, sonst ist
 *  "ueber die Zeit" gar keine Aussage. */
function odometerChartMarkup(points, unit) {
  if (points.length < 2) return '';
  const { W, H } = CHART;
  const { top, bottom } = chartScales();

  // Runde Achse und Zeitachse nach Datum (C4, utils/chart.js): Wartungen
  // liegen in ungleichen Abstaenden, der Zaehlerstand je Tag ist die Aussage.
  const values = points.map((p) => p.value);
  const { min, max, steps } = niceDomain(Math.min(...values), Math.max(...values));
  const from = points[0].date;
  const to = points[points.length - 1].date;
  // Zwei Wartungen am selben Tag: chartTimePositions verteilt sie, statt sie
  // auf die linke Kante zu legen.
  const xs = chartTimePositions(points.map((p) => p.date));
  const x = (i) => xs[i];
  const y = (v) => chartY(v, min, max);

  const spine = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `<polygon class="inventory-chart__area" points="${x(0).toFixed(1)},${bottom.toFixed(1)} ${spine} ${x(points.length - 1).toFixed(1)},${bottom.toFixed(1)}" />`;
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="var(--module-inventory)"><title>${esc(`${formatDate(p.date)}: ${formatOdometer(p.value)} ${unit}`)}</title></circle>`).join('');

  const grid = chartGridMarkup(min, max, (val) => formatOdometer(Math.round(val)), CHART, steps);
  const xLabels = chartTimeLabelsMarkup(from, to, formatDate);
  const titleText = t('inventory.odometerChartTitle');
  const table = chartTableMarkup(titleText, [t('inventory.completePerformedOnLabel'), t('inventory.odometerLabel')],
    points.map((p) => [formatDate(p.date), `${formatOdometer(p.value)} ${unit}`]));

  return `
    <div class="inventory-chart-section">
      <div class="inventory-chart-section__title">${esc(titleText)}</div>
      <svg class="chart inventory-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titleText)}">
        ${grid}
        ${area}
        <polyline fill="none" stroke="var(--module-inventory)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${spine}" />
        ${dots}
        ${xLabels}
      </svg>
      ${table}
    </div>`;
}

/** Kilometerstand-Messpunkte: jede Service-Log-Zeile mit eigenem Wert, plus
 *  die aktuelle Ablesung des Items selbst, falls sie zu keiner Log-Zeile
 *  gehoert (z. B. direkt im Formular eingetragen, nie ueber "Erledigt"). */
function odometerChartPoints(history, item) {
  const points = (history?.timeline || [])
    .filter((e) => e.type === 'service_log' && e.odometer != null)
    .map((e) => ({ date: e.date, value: e.odometer }));
  if (item.odometer != null && item.odometer_on && !points.some((p) => p.date === item.odometer_on)) {
    points.push({ date: item.odometer_on, value: item.odometer });
  }
  return points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Verlaufs-Knoten: Kilometerstand-Trend (falls genug Messpunkte) + Zeitleiste
 *  + Gesamtkosten - reine Anzeige, keine eigene Datenhaltung (server-seitig
 *  eine Zusammenfuehrung, kein neuer Speicher). */
function historyDetailNode(history, item, historyLoadFailed) {
  // Ein Ladefehler sieht sonst genauso aus wie "nichts protokolliert" - beides
  // liefert history === null (Review #1257).
  if (historyLoadFailed) {
    const error = document.createElement('p');
    error.className = 'form-error';
    error.setAttribute('role', 'alert');
    error.textContent = t('inventory.historyLoadError');
    return error;
  }

  const odometerUnit = odometerUnitLabel(item.odometer_unit);
  const chartHtml = odometerChartMarkup(odometerChartPoints(history, item), odometerUnit);
  const hasTimeline = !!(history && history.timeline.length);
  if (!chartHtml && !hasTimeline) return null;

  const wrap = document.createElement('div');
  if (chartHtml) wrap.insertAdjacentHTML('beforeend', chartHtml);

  if (hasTimeline) {
    const list = document.createElement('div');
    list.className = 'inventory-history-list';
    history.timeline.forEach((entry) => list.appendChild(historyEntryLine(entry, odometerUnit)));
    wrap.appendChild(list);
    if (history.total) {
      const total = document.createElement('div');
      total.className = 'inventory-history-total';
      const label = document.createElement('span');
      label.textContent = t('inventory.historyTotalLabel');
      const value = document.createElement('span');
      value.textContent = formatMoney(history.total, _householdCurrency);
      total.append(label, value);
      wrap.appendChild(total);
    }
  }
  return wrap;
}

/** Detail-Vorschau: eigenes DOM-Element statt Text/Link, gleiche Rolle wie
 *  inventoryDetailListNode fuer die anderen komplexen Zeilen. Kein `node:` in
 *  openDetailView's `sections` erzwingt ein Label/Value-Paar (detailBodyEl
 *  schickt jeden Eintrag durch detailRowEl) - ein eigener Top-Level-Bild-Slot
 *  existiert in der geteilten Komponente nicht, deshalb als erste Zeile statt
 *  als Kopfbild. */
function photoDetailNode(photoData) {
  if (!photoData) return null;
  const img = document.createElement('img');
  img.className = 'inventory-detail-photo';
  img.src = photoData;
  img.alt = '';
  return img;
}

/**
 * Die Belege fuer die Detailansicht. Sie gehoeren dem Dokumente-Modul: bei
 * `documents: none` gibt es keine Zeile, jeder Link ginge ins 403 (dieselbe
 * Antwort wie attachmentLinksNode in components/document-attach.js). Ohne
 * Leserecht kommt vom Server `attachments: null` (#1358) - dann gibt es keine
 * Zeile und keinen Hinweis; eine Zeile ohne ID wird nie zum Link.
 */
function attachmentDetailEntries(attachments) {
  if (pathAccess('/documents') === 'none') return [];
  return (attachments || []).filter((doc) => doc?.document_id).map((doc) => ({
    text: doc.name || doc.original_name || '',
    href: `/api/v1/documents/${Number(doc.document_id)}/preview`,
  }));
}

/**
 * Lese-Zeilen fuer die Detailansicht. Zeilen ohne Inhalt fallen selbst weg
 * (detailRowEl), also keine Fallunterscheidung hier noetig.
 * @returns {Array} Sections fuer openDetailView
 */
function renderItemDetail(item, history, onDoneTrackedDate, historyLoadFailed) {
  const bookingEntries = (item.linked_entries || []).map((link) => ({
    text: `${link.title} · ${formatMoney(link.amount, _householdCurrency)}`,
    sub: `${roleLabel(link.role)} · ${formatDate(link.date)}`,
  }));
  const attachmentEntries = attachmentDetailEntries(item.attachments);

  // GEGLIEDERT STATT DREIZEHN LOSER ZEILEN (R10 L3, A6 P3-3). Oben, was das
  // Ding ist und wo es steht; darunter benannte Gruppen wie die Abschnitte
  // einer Kontaktkarte - Kauf, Garantie und Fristen, Zustand, Belege. Eine
  // Gruppe ohne Inhalt faellt samt Titel weg (detail-view.js, detailGroupEl).
  return [
    { icon: 'image', label: t('inventory.photoLabel'), node: photoDetailNode(item.photo_data) },
    { icon: item.category_icon, label: t('inventory.categoryLabel'), value: itemCategoryLabel(item) },
    { icon: 'map-pin', label: t('inventory.locationLabel'), value: item.location_path || '' },
    {
      group: t('inventory.detailGroupPurchase'),
      rows: [
        { icon: 'building-2', label: t('inventory.brandLabel'), value: item.brand || '' },
        { icon: 'package', label: t('inventory.modelLabel'), value: item.model || '' },
        { icon: 'hash', label: t('inventory.serialNumberLabel'), value: item.serial_number || '' },
        { icon: 'calendar', label: t('inventory.purchaseDateLabel'), value: item.purchase_date ? formatDate(item.purchase_date) : '' },
        { icon: 'banknote', label: t('inventory.purchasePriceLabel'), value: item.purchase_price != null ? formatMoney(item.purchase_price, item.currency) : '' },
        { icon: 'store', label: t('inventory.vendorLabel'), value: item.vendor || '' },
        // Konto, unter dem das Geraet registriert ist (#1004) - eine Adresse oder ein
        // Benutzername, nie ein Passwort. Steht bei den uebrigen Herkunftsangaben,
        // weil es dieselbe Art Frage beantwortet: woher kommt das Ding, und unter
        // wessen Namen laeuft es.
        { icon: 'at-sign', label: t('inventory.accountUsernameLabel'), value: item.account_username || '' },
      ],
    },
    {
      group: t('inventory.detailGroupWarranty'),
      rows: [
        // „Garantie" ist dasselbe Wort wie die Dokument-Kategorie (ein Key, eine
        // Uebersetzung); „Garantie (Monate)" bleibt das Label des Formularfelds.
        { icon: 'shield', label: t('documents.category.warranty'), value: warrantyDetailValue(item) },
        { icon: 'calendar-clock', label: t('inventory.trackedDatesLabel'), node: trackedDatesDetailNode(item, onDoneTrackedDate) },
      ],
    },
    {
      group: t('inventory.detailGroupCondition'),
      rows: [
        { icon: 'sparkles', label: t('inventory.conditionLabel'), value: t(`inventory.condition${item.condition.charAt(0).toUpperCase()}${item.condition.slice(1)}`) },
        { icon: 'info', label: t('inventory.statusLabel'), value: statusLabel(item.status) },
        { icon: 'gauge', label: t('inventory.odometerLabel'), value: odometerDetailValue(item) },
        { icon: 'align-left', label: t('inventory.notesLabel'), value: item.notes || '', multiline: true },
      ],
    },
    {
      group: t('inventory.detailGroupRecords'),
      rows: [
        { icon: 'receipt', label: t('inventory.linkedBookingsLabel'), node: inventoryDetailListNode(bookingEntries) },
        { icon: 'paperclip', label: t('inventory.attachmentsLabel'), node: inventoryDetailListNode(attachmentEntries) },
        { icon: 'history', label: t('inventory.historyLabel'), node: historyDetailNode(history, item, historyLoadFailed) },
      ],
    },
  ];
}

/** Uebersetzte Einheit statt des rohen DB-Codes ('km'/'mi') - jede Stelle, die
 *  eine Kilometerstand-Zahl anzeigt, muss hierueber gehen (Review #1257: eine
 *  Stelle blieb roh und zeigte "1400 km" auf Russisch statt "1400 км"). */
function odometerUnitLabel(unit) {
  return t(`inventory.odometerUnit${unit === 'mi' ? 'Mi' : 'Km'}`);
}

/** Tausendertrennzeichen der Locale statt einer rohen Ziffernfolge - dasselbe
 *  Muster wie budget.js/dashboard.js/housekeeping.js (Review #1257). */
function formatOdometer(value) {
  return getNumberFormat().format(value);
}

/** Kilometerstand-Zeile: Wert + Einheit + Ablesedatum, oder leer ohne Wert. */
function odometerDetailValue(item) {
  if (item.odometer == null) return '';
  const value = `${formatOdometer(item.odometer)} ${odometerUnitLabel(item.odometer_unit)}`;
  return item.odometer_on ? `${value} · ${formatDate(item.odometer_on)}` : value;
}

/**
 * Antippen zeigt den Gegenstand, bevor es ihn bearbeiten laesst - gleiches
 * Muster wie public/pages/contacts.js#openContactDetail. Kein Anker, damit
 * die Ansicht immer als Sheet erscheint statt als Desktop-Popover: das ist,
 * was "Bearbeiten" das Formular INLINE mounten laesst (Design-Doc §3),
 * anstatt einen zweiten Weg fuer den Popover-Fall zu brauchen.
 *
 * Die Liste liefert bereits das volle Item (Anhaenge, Buchungen, Fristen) -
 * kein Einzelabruf noetig, anders als bei Kontakten. Die Verlaufs-Ansicht ist
 * ein eigener Endpunkt (server/routes/inventory/service-log.js#loadHistory,
 * reine Aggregation, kein Teil des Item-Datensatzes) und wird deshalb separat
 * nachgeladen, bevor die Ansicht aufgeht.
 */
async function openItemDetail(item, { pane = null, signal = null } = {}) {
  let history = null;
  let historyLoadFailed = false;
  try {
    const res = await api.get(`/inventory/items/${item.id}/history`);
    history = res.data;
  } catch (err) {
    console.error('[Inventory] Verlauf konnte nicht geladen werden:', err);
    historyLoadFailed = true;
  }
  // In der Detailspalte kann waehrend des Ladens schon eine andere Zeile
  // gewaehlt sein - dann gehoert die Spalte ihr, nicht diesem Gegenstand.
  if (signal?.aborted) return;

  const ro = readOnly();
  const onDoneTrackedDate = ro ? null : async (trackedDate) => {
    if (pane) {
      // In der Spalte liegt kein Overlay offen: die Abschluss-Karte geht direkt
      // auf, und ein closeDetailView() schloesse hier ein fremdes Modal. Nach
      // dem Abschluss zeichnet der Baustein die Spalte neu (repaint).
      const completed = await openCompletionSheet(item, trackedDate);
      if (completed) {
        await loadItems();
        renderList({ repaint: true });
        updateAttentionBadge();
      }
      return;
    }
    // Die Detailansicht MUSS zu sein, BEVOR die Abschluss-Karte aufgeht: beide
    // sind openModal()-Overlays, und ein zweiter Overlay ueber einem noch
    // offenen zwingt dessen erzwungenes Schliessen (modal.js#openModal) - das
    // reisst die Verlaufs-/Zurueck-Verwaltung der Detailansicht
    // (overlay-history.js) mit, und die gerade erst geoeffnete Karte faellt
    // im selben Zug wieder zu.
    await closeDetailView({ force: true });
    const completed = await openCompletionSheet(item, trackedDate);
    if (completed) {
      await loadItems();
      renderList({ repaint: true });
      updateAttentionBadge();
    }
    // Ein voller Neu-Öffnen ist einfacher und robuster als ein In-Place-Update
    // der Detailansicht - openDetailView bietet dafür keine Aktualisierungs-API,
    // und das Item hat sich bei einem Abschluss an mehreren Stellen zugleich
    // geändert (Frist, Erinnerung, ggf. Kilometerstand, Verlauf). Ohne
    // Abschluss (abgebrochen) geht dieselbe, unveränderte Ansicht wieder auf.
    const refreshed = (completed && state.items.find((i) => i.id === item.id)) || item;
    // Bewusst nicht awaited: openItemDetail() laedt selbst erst die Historie
    // nach, bevor es die Ansicht oeffnet, und ohne diesen await haengt sich
    // ein erneutes "Erledigt" in der neu geoeffneten Ansicht nicht mehr eine
    // Ebene tiefer in eine wachsende Kette wartender Aufrufe (Review #1257).
    // refocusAfterRender() braucht dieses Warten ohnehin nicht - siehe deren
    // eigener Kommentar in modal.js.
    openItemDetail(refreshed);
    refocusAfterRender();
  };

  openDetailView({
    title: item.name,
    key: `inventory:${item.id}`,
    accentColor: 'var(--module-inventory)',
    size: 'md',
    pane,
    sections: renderItemDetail(item, history, onDoneTrackedDate, historyLoadFailed),
    // OHNE SCHREIBRECHT WEDER „LOESCHEN" NOCH „BEARBEITEN": `openDetailView`
    // baut beide nur, wenn der Schluessel steht (detail-view.js) - weglassen
    // ist die ganze Antwort, die Leseansicht bleibt vollstaendig.
    actions: ro ? [] : [{
      id: 'inventory-detail-delete',
      label: t('common.delete'),
      variant: 'danger-ghost',
      icon: 'trash-2',
      align: 'start',
      onClick: async ({ close }) => {
        await close({ force: true });
        await removeItem(item);
      },
    }],
    edit: ro ? null : {
      label: t('common.edit'),
      title: t('common.editItem'),
      // Im Sheet ist Bearbeiten die Hauptaktion und steht unten in der
      // Daumenzone; Loeschen bleibt zurueckgenommen am Anfang und fragt
      // weiter nach (removeItem), wie im Kalender (#1460, #1463).
      primary: true,
      mount: (panel, editPane) => {
        const form = buildItemForm({ mode: 'edit', item });
        editPane.insertAdjacentHTML('beforeend', form.content);
        form.wire(panel);
      },
      // Aus der Detailspalte: das regulaere Formular-Modal (detail-view.js,
      // openInPane) - dasselbe Formular, das „Neu" oeffnet.
      standalone: () => openItemModal('edit', item),
    },
  });
}

/**
 * Abschluss-Karte fuer eine faellige getrackte Frist ("Erledigt"): Datum
 * (Vorgabe heute), Kilometerstand, Haendler, Notiz - alle bis auf das Datum
 * optional. Eigenes kleines Formular statt buildItemForm-Musters, weil es
 * nichts mit dem Item-Formular teilt.
 * @returns {Promise<boolean>} true, wenn die Frist erledigt wurde
 */
function openCompletionSheet(item, trackedDate) {
  if (readOnly()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    // Kilometerstand nur bei odometer-tragenden Kategorien abfragen - dieselbe
    // Einschraenkung wie im Item-Formular.
    const tracksOdometer = categoryTracksOdometer(item.category);
    const content = `
      <div class="form-group">
        <label class="form-label" for="inv-complete-date">${esc(t('inventory.completePerformedOnLabel'))}</label>
        <yuvomi-datepicker id="inv-complete-date" type="date" value="${esc(todayKey())}"></yuvomi-datepicker>
      </div>
      ${tracksOdometer ? `
      <div class="form-group">
        <label class="form-label" for="inv-complete-odometer">${esc(t('inventory.odometerLabel'))}</label>
        <input id="inv-complete-odometer" class="form-input" type="number" min="0" step="1" inputmode="numeric">
      </div>` : ''}
      <div class="form-group">
        <label class="form-label" for="inv-complete-vendor">${esc(t('inventory.vendorLabel'))}</label>
        <input id="inv-complete-vendor" class="form-input" type="text">
      </div>
      <div class="form-group">
        <label class="form-label" for="inv-complete-note">${esc(t('inventory.notesLabel'))}</label>
        <textarea id="inv-complete-note" class="form-input" rows="3"></textarea>
      </div>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="inv-complete-save">${esc(t('inventory.markDoneAction'))}</button>
      </div>`;

    openSharedModal({
      title: t('inventory.completeSheetTitle', { label: trackedDate.label }),
      size: 'sm',
      content,
      onSave: (panel) => {
        panel.querySelector('.modal-panel__footer [data-action="close-modal"]')
          ?.addEventListener('click', () => { closeSharedModal(); });
        panel.querySelector('#inv-complete-save').addEventListener('click', async () => {
          const saveBtn = panel.querySelector('#inv-complete-save');
          const performedOn = panel.querySelector('#inv-complete-date').value;
          if (!performedOn) return;
          const odometerRaw = tracksOdometer ? panel.querySelector('#inv-complete-odometer').value.trim() : '';
          const payload = {
            performed_on: performedOn,
            odometer: odometerRaw === '' ? null : Number(odometerRaw),
            vendor: panel.querySelector('#inv-complete-vendor').value.trim() || null,
            note: panel.querySelector('#inv-complete-note').value.trim() || null,
          };
          saveBtn.disabled = true;
          try {
            await api.post(`/inventory/items/${item.id}/dates/${trackedDate.id}/complete`, payload);
            // ERST settle(true), DANN das Modal schliessen: das Schliessen
            // loest selbst den registrierten onClose-Callback aus (modal.js),
            // auch bei einem erfolgreichen, selbst ausgeloesten Schliessen -
            // ohne diese Reihenfolge wuerde dessen settle(false) zuerst
            // greifen (settle() ist idempotent, "wer zuerst kommt" gewinnt)
            // und der Abschluss saehe fuer den Aufrufer wie ein Abbruch aus,
            // obwohl die Frist bereits serverseitig erledigt ist.
            settle(true);
            await closeSharedModal({ force: true });
            window.yuvomi?.showToast(t('inventory.completed'), 'success');
          } catch (err) {
            saveBtn.disabled = false;
            window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
          }
        });
        if (window.lucide) window.lucide.createIcons({ el: panel });
      },
      onClose: () => settle(false),
    });
  });
}

// --------------------------------------------------------
// Gegenstands-Formular (Anlegen/Bearbeiten, ausserdem inline in die
// Detailansicht oben gemountet, siehe buildItemForm/openItemDetail)
// --------------------------------------------------------

const CONDITIONS = ['new', 'good', 'fair', 'poor'];
const STATUSES = ['active', 'sold', 'disposed', 'lost'];

// Muss mit server/routes/inventory/entry-links.js#ROLES uebereinstimmen.
const ROLES = ['purchase', 'refund', 'instalment', 'maintenance', 'accessory'];

// Muss mit server/routes/inventory/item-dates.js#MAX_TRACKED_DATES_PER_ITEM uebereinstimmen.
const MAX_TRACKED_DATES_PER_ITEM = 10;

function roleLabel(role) {
  return t(`inventory.role${role.charAt(0).toUpperCase()}${role.slice(1)}`);
}

// Lokale Kopien der gleichnamigen (nicht exportierten) Helfer aus
// public/pages/budget.js - keine gemeinsame Datei, da nur diese beiden
// Module Monatsnavigation brauchen und ein Export-Refactor von budget.js
// ausserhalb dieses Plans liegt.
function getMonthName(monthIndex) {
  const monthDate = new Date(2000, monthIndex, 1);
  return new Intl.DateTimeFormat(getLocale(), { month: 'long' }).format(monthDate);
}

function formatMonthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${getMonthName(parseInt(m, 10) - 1)} ${y}`;
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const shifted = new Date(y, m - 1 + n, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;
}

// Der laufende Monat der ANZEIGEZONE, nicht der des Browsers - dasselbe wie in
// budget.js (#829, Nachlese #851).
function currentMonthStr() {
  return todayKey().slice(0, 7);
}

// Gleiche Liste wie public/pages/documents.js#CATEGORIES - dort hardcodiert
// statt aus GET /documents/meta/options geladen, hier aus Konsistenz genauso.
const DOCUMENT_CATEGORIES = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];

// --------------------------------------------------------
// Buchungs-Auswahl (Overlay im Modal-Panel, wie openDocumentPicker in
// document-attach.js - ein zweites Modal wuerde das Formular darunter
// schliessen). Monatsweise geblaettert wie die Budget-Seite selbst statt
// Volltextsuche - es gibt keine bestehende Suche ueber Buchungen im Projekt.
//
// `includeRole: true` fragt nach der Auswahl noch die Rolle ab (fuer
// "Buchung hinzufuegen" am bestehenden Gegenstand); `false` loest sofort
// mit role:'purchase' auf (Anlegen-Fluss, Kaufpreis-Vorbelegung).
//
// @returns {Promise<{entry: object, role: string}|null>}
// --------------------------------------------------------
function openBookingPicker(panel, { initialMonth, includeRole = false } = {}) {
  return new Promise((resolve) => {
    let month = initialMonth || currentMonthStr();
    let entries = [];
    let picked = null;

    const overlay = document.createElement('div');
    overlay.className = 'inventory-booking-picker';
    overlay.insertAdjacentHTML('afterbegin', `
      <div class="inventory-booking-picker__panel" role="dialog" aria-modal="true"
           aria-label="${esc(t('inventory.bookingPickerTitle'))}">
        <div class="inventory-booking-picker__header" data-dialog-actions>
          <strong>${esc(t('inventory.bookingPickerTitle'))}</strong>
          <button class="btn btn--icon" type="button" data-picker-close
                  aria-label="${esc(t('common.cancel'))}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </div>
        <div class="inventory-booking-picker__nav" data-dialog-actions>
          <button class="btn btn--icon" type="button" data-picker-prev
                  aria-label="${esc(t('inventory.bookingPickerPrevMonth'))}">
            <i data-lucide="chevron-left" aria-hidden="true"></i>
          </button>
          <strong data-picker-month></strong>
          <button class="btn btn--icon" type="button" data-picker-next
                  aria-label="${esc(t('inventory.bookingPickerNextMonth'))}">
            <i data-lucide="chevron-right" aria-hidden="true"></i>
          </button>
        </div>
        <div class="inventory-booking-picker__list" data-picker-list>
          <p class="inventory-booking-picker__status">${esc(t('common.loading'))}</p>
        </div>
        <div class="inventory-booking-picker__role" data-picker-role hidden>
          <div class="form-group">
            <label class="form-label" for="inv-picker-role-select">${esc(t('inventory.roleLabel'))}</label>
            <select id="inv-picker-role-select" class="form-input">
              ${ROLES.map((r) => `<option value="${r}">${esc(roleLabel(r))}</option>`).join('')}
            </select>
          </div>
          <div class="inventory-booking-picker__role-footer" data-dialog-actions>
            <button class="btn btn--secondary" type="button" data-picker-role-back>${esc(t('common.back'))}</button>
            <button class="btn btn--primary" type="button" data-picker-role-confirm>${esc(t('inventory.addBooking'))}</button>
          </div>
        </div>
      </div>`);
    panel.append(overlay);
    if (window.lucide) window.lucide.createIcons({ el: overlay });
    const opener = document.activeElement;
    overlay.querySelector('[data-picker-close]').focus();

    const listEl = overlay.querySelector('[data-picker-list]');
    const monthEl = overlay.querySelector('[data-picker-month]');
    const roleEl = overlay.querySelector('[data-picker-role]');
    const navEl = overlay.querySelector('.inventory-booking-picker__nav');

    const close = (result) => {
      overlay.remove();
      if (opener?.isConnected) opener.focus();
      resolve(result);
    };
    // Liegt ueber einem offenen Modal - die Zurueck-Geste meint zuerst ihn
    // (#871). Ohne Auswahl heisst zu: abgebrochen.
    attachOverlay(overlay, () => close(null));

    const renderList = () => {
      monthEl.textContent = formatMonthLabel(month);
      listEl.replaceChildren();
      if (!entries.length) {
        listEl.insertAdjacentHTML('afterbegin',
          `<p class="inventory-booking-picker__status">${esc(t('inventory.noBookingsThisMonth'))}</p>`);
        return;
      }
      for (const entry of entries) {
        listEl.insertAdjacentHTML('beforeend', `
          <button class="inventory-booking-picker__item" type="button" data-picker-item="${entry.id}">
            <span class="inventory-booking-picker__item-title">${esc(entry.title)}</span>
            <span class="inventory-booking-picker__item-meta">${esc(formatDate(entry.date))}</span>
            <span class="inventory-booking-picker__item-amount">${esc(formatMoney(entry.amount, _householdCurrency))}</span>
          </button>`);
      }
    };

    const loadMonth = () => {
      listEl.replaceChildren();
      listEl.insertAdjacentHTML('afterbegin', `<p class="inventory-booking-picker__status">${esc(t('common.loading'))}</p>`);
      api.get(`/budget?month=${month}`).then((res) => {
        entries = (res.data || []).filter((e) => !e.recurrence_parent_id && !e.is_pending);
        renderList();
      }).catch(() => {
        listEl.replaceChildren();
        listEl.insertAdjacentHTML('afterbegin',
          `<p class="inventory-booking-picker__status">${esc(t('common.errorGeneric'))}</p>`);
      });
    };

    listEl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-picker-item]');
      if (!button) return;
      picked = entries.find((e) => e.id === Number(button.dataset.pickerItem));
      if (!picked) return;
      if (!includeRole) { close({ entry: picked, role: 'purchase' }); return; }
      roleEl.hidden = false;
      listEl.hidden = true;
      navEl.hidden = true;
    });

    overlay.querySelector('[data-picker-prev]').addEventListener('click', () => { month = addMonths(month, -1); loadMonth(); });
    overlay.querySelector('[data-picker-next]').addEventListener('click', () => { month = addMonths(month, 1); loadMonth(); });
    overlay.querySelectorAll('[data-picker-close]').forEach((button) => button.addEventListener('click', () => close(null)));
    overlay.querySelector('[data-picker-role-back]').addEventListener('click', () => {
      picked = null;
      roleEl.hidden = true;
      listEl.hidden = false;
      navEl.hidden = false;
    });
    overlay.querySelector('[data-picker-role-confirm]').addEventListener('click', () => {
      const role = overlay.querySelector('#inv-picker-role-select').value;
      close({ entry: picked, role });
    });
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(null); });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(null); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll('button, select')].filter((el) => !el.disabled && !el.closest('[hidden]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    loadMonth();
  });
}

/** (Re-)rendert die "Verknuepfte Buchungen"-Sektion im Bearbeiten-Formular. */
function renderLinkedEntries(panel, item) {
  const container = panel.querySelector('[data-linked-entries]');
  if (!container) return;
  const links = item.linked_entries || [];

  if (!links.length) {
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', `<p class="form-hint">${esc(t('inventory.noLinkedBookings'))}</p>`);
    return;
  }

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', links.map((link) => `
    <div class="inventory-linked-entry-row" data-entry-id="${link.entry_id}">
      <span class="inventory-linked-entry-row__title">${esc(link.title)}</span>
      <span class="inventory-linked-entry-row__role">${esc(roleLabel(link.role))}</span>
      <span class="inventory-linked-entry-row__date">${esc(formatDate(link.date))}</span>
      <span class="inventory-linked-entry-row__amount">${esc(formatMoney(link.amount, _householdCurrency))}</span>
      <button class="btn btn--icon btn--sm" type="button" data-remove-entry="${link.entry_id}"
              aria-label="${esc(t('inventory.removeBookingAction', { title: link.title }))}">
        <i data-lucide="x" aria-hidden="true"></i>
      </button>
    </div>`).join(''));
  container.insertAdjacentHTML('beforeend', `
    <div class="inventory-linked-entry-total">
      <span>${esc(t('inventory.totalLinkedLabel'))}</span>
      <span>${esc(formatMoney(item.linked_entries_total, _householdCurrency))}</span>
    </div>`);

  if (window.lucide) window.lucide.createIcons({ el: container });
}

function updateWarrantyStatus(panel) {
  const statusEl = panel.querySelector('#inv-warranty-status');
  const purchaseDate = panel.querySelector('#inv-purchase-date').value;
  const warrantyRaw = panel.querySelector('#inv-warranty').value.trim();
  const status = warrantyStatus({
    purchase_date: purchaseDate || null,
    warranty_months: warrantyRaw === '' ? null : Number(warrantyRaw),
  });

  if (!status) {
    statusEl.hidden = true;
    statusEl.className = 'inventory-warranty-status';
    return;
  }

  statusEl.hidden = false;
  statusEl.className = `inventory-warranty-status inventory-warranty-status--${status.state}`;
  // Der Key direkt, ohne Date-Umweg: `new Date(key + 'T00:00:00')` ist
  // Mitternacht der BROWSER-Zone, und in einer Haushaltszone westlich davon
  // faellt der angezeigte Tag dann auf den Vortag (#829 Teil 3).
  const formattedDate = formatDate(status.endDateKey);
  if (status.state === 'expired') {
    statusEl.textContent = t('inventory.warrantyStatusExpired', { date: formattedDate });
  } else if (status.state === 'expiring') {
    // Parameter heisst `count`, nicht `days`: nur ein numerischer `count` waehlt
    // in public/i18n.js die Pluralvariante (_one/_other). Mit `days` stand hier
    // "in 1 Tagen" (#534, gleiche Fehlerklasse).
    statusEl.textContent = t('inventory.warrantyStatusExpiringSoon', { count: status.days });
  } else {
    statusEl.textContent = t('inventory.warrantyStatusValid', { date: formattedDate });
  }
}

function trackedDateRowHtml({
  label = '', date = '', reminder_offset_days = 30, interval_months = '', interval_distance = '',
} = {}) {
  return `
    <div class="inventory-tracked-date-row" data-tracked-date-row>
      <input class="form-input js-tracked-date-label" type="text" maxlength="100"
             placeholder="${esc(t('inventory.trackedDateLabelPlaceholder'))}" value="${esc(label)}">
      <yuvomi-datepicker class="js-tracked-date-date" type="date" value="${esc(date)}"></yuvomi-datepicker>
      <input class="form-input js-tracked-date-offset" type="number" min="0" max="365" step="1"
             value="${reminder_offset_days}" aria-label="${esc(t('inventory.trackedDateRemindBeforeLabel'))}">
      <span class="inventory-tracked-date-row__countdown" data-countdown></span>
      <button type="button" class="btn btn--ghost btn--icon js-tracked-date-remove"
              aria-label="${esc(t('inventory.removeTrackedDateAction'))}">
        <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
      </button>
      <div class="inventory-tracked-date-row__intervals">
        <input class="form-input js-tracked-date-interval-months" type="number" min="1" max="600" step="1"
               placeholder="${esc(t('inventory.trackedDateIntervalMonthsPlaceholder'))}"
               aria-label="${esc(t('inventory.trackedDateIntervalMonthsLabel'))}"
               value="${interval_months === null ? '' : esc(String(interval_months))}">
        <input class="form-input js-tracked-date-interval-distance" type="number" min="1" step="1"
               placeholder="${esc(t('inventory.trackedDateIntervalDistancePlaceholder'))}"
               aria-label="${esc(t('inventory.trackedDateIntervalDistanceLabel'))}"
               value="${interval_distance === null ? '' : esc(String(interval_distance))}">
      </div>
    </div>`;
}

function updateTrackedDateRowCountdown(row) {
  const countdownEl = row.querySelector('[data-countdown]');
  const dateVal = row.querySelector('.js-tracked-date-date').value;
  const status = dateStatus(dateVal || null);
  if (!status) { countdownEl.textContent = ''; return; }
  if (status.days < 0) countdownEl.textContent = t('inventory.trackedDateOverdueDays', { count: Math.abs(status.days) });
  else if (status.days === 0) countdownEl.textContent = t('inventory.trackedDateDueToday');
  else countdownEl.textContent = t('inventory.trackedDateInDays', { count: status.days });
}

/** Verdrahtet Hinzufuegen/Entfernen der Fristen-Zeilen, gleiches Muster wie
 *  public/pages/calendar.js#wireReminderRows (Mehrfach-Erinnerungen). */
function wireTrackedDateRows(panel) {
  const rowsEl = panel.querySelector('#inv-tracked-dates-rows');
  const addBtn = panel.querySelector('#inv-tracked-dates-add');
  if (!rowsEl) return;

  const rowCount = () => rowsEl.querySelectorAll('[data-tracked-date-row]').length;
  const syncAddState = () => { if (addBtn) addBtn.disabled = rowCount() >= MAX_TRACKED_DATES_PER_ITEM; };

  const wireRow = (row) => {
    updateTrackedDateRowCountdown(row);
    row.querySelector('.js-tracked-date-date').addEventListener('input', () => updateTrackedDateRowCountdown(row));
  };

  rowsEl.querySelectorAll('[data-tracked-date-row]').forEach(wireRow);

  const appendRow = () => {
    rowsEl.insertAdjacentHTML('beforeend', trackedDateRowHtml());
    const newRow = rowsEl.lastElementChild;
    if (window.lucide && newRow) lucide.createIcons({ el: newRow });
    wireRow(newRow);
    syncAddState();
  };

  rowsEl.addEventListener('click', (e) => {
    const rm = e.target.closest('.js-tracked-date-remove');
    if (!rm) return;
    rm.closest('[data-tracked-date-row]')?.remove();
    syncAddState();
  });

  addBtn?.addEventListener('click', () => {
    if (rowCount() >= MAX_TRACKED_DATES_PER_ITEM) return;
    appendRow();
  });

  syncAddState();
}

function collectTrackedDates(panel) {
  return [...panel.querySelectorAll('[data-tracked-date-row]')].map((row) => {
    // Kein `|| 30`: eine explizite 0 ("am Tag selbst erinnern") ist falsy und
    // wuerde sonst still zu 30 umgeschrieben. 0 ist ueberall sonst gueltig
    // (input min="0", Server-Validator >= 0, DB-CHECK BETWEEN 0 AND 365).
    const rawOffset = row.querySelector('.js-tracked-date-offset').value.trim();
    const offset = Number(rawOffset);
    const rawIntervalMonths = row.querySelector('.js-tracked-date-interval-months').value.trim();
    const rawIntervalDistance = row.querySelector('.js-tracked-date-interval-distance').value.trim();
    return {
      label: row.querySelector('.js-tracked-date-label').value.trim(),
      date: row.querySelector('.js-tracked-date-date').value || null,
      reminder_offset_days: rawOffset === '' || !Number.isFinite(offset) ? 30 : offset,
      // Leer bleibt NULL (heutiges Einmal-Verhalten) - kein Default wie beim
      // Vorlauf oben, siehe server/routes/inventory/item-dates.js.
      interval_months: rawIntervalMonths === '' ? null : Number(rawIntervalMonths),
      interval_distance: rawIntervalDistance === '' ? null : Number(rawIntervalDistance),
    };
  }).filter((d) => d.label && d.date);
}

/** Vorschau im Formular-Editor: Bild oder ein neutrales Platzhalter-Icon -
 *  anders als birthdays.js's Initialen, die fuer einen Gegenstand keinen
 *  Sinn ergeben. */
function photoPreviewHtml(photoData) {
  if (photoData) return `<img class="inventory-photo-preview__image" src="${esc(photoData)}" alt="">`;
  return `<span class="inventory-photo-preview__fallback"><i data-lucide="image" aria-hidden="true"></i></span>`;
}

/**
 * Baut Titel, Markup und Verdrahtung des Gegenstands-Formulars in einem
 * Stueck. Eigene Funktion, weil dasselbe Formular an zwei Stellen entsteht:
 * im regulaeren Modal (Neuanlage/Bearbeiten ueber den Listen-Klick) und
 * nachtraeglich gemountet im Formular-Pane der Detailansicht (Task 5).
 * Gleiches Muster wie public/pages/contacts.js#buildContactForm.
 *
 * @returns {{title: string, content: string, wire: (panel: HTMLElement) => void}}
 */
function buildItemForm({ mode, item = null }) {
  const isEdit = mode === 'edit';
  // Verknuepfte Buchungen kommen aus dem Budget: ohne dessen Leserecht liefert
  // der Server keine und antwortet auf jedes Nachschlagen mit 404. Abschnitt
  // und Knoepfe fallen dann weg - "keine verknuepften Buchungen" waere falsch,
  // und "Buchung hinzufuegen" endete im Fehler (Regel 1 in
  // utils/module-access.js, Muster wie attachmentDetailEntries()).
  const showsBookings = pathAccess('/budget') !== 'none';
  let pickedBooking = null; // nur im Anlegen-Fluss: {entry, role:'purchase'} vor dem Speichern
  let photoData = isEdit && item.photo_data ? item.photo_data : null;

  const categoryOptions = categoryOptionsHtml(state.categories);
  const locationOptions = [`<option value="">${esc(t('inventory.unlocated'))}</option>`];
  for (const root of state.locations) {
    locationOptions.push(`<option value="${root.id}">${esc(root.name)}</option>`);
    for (const child of root.subcategories || []) {
      locationOptions.push(`<option value="${child.id}">${esc(root.name)} · ${esc(child.name)}</option>`);
    }
  }
  const conditionOptions = CONDITIONS.map((c) => `<option value="${c}">${esc(t(`inventory.condition${c.charAt(0).toUpperCase()}${c.slice(1)}`))}</option>`).join('');
  const statusOptions = STATUSES.map((s) => `<option value="${s}">${esc(t(`inventory.status${s.charAt(0).toUpperCase()}${s.slice(1)}`))}</option>`).join('');
  const documentCategoryOptions = DOCUMENT_CATEGORIES
    .map((c) => `<option value="${c}" ${c === 'warranty' ? 'selected' : ''}>${esc(t(`documents.category.${c}`))}</option>`).join('');

  const content = `
      <div class="form-group">
        <label class="form-label" for="inv-name">${esc(t('common.nameLabel'))}${REQUIRED_MARK}</label>
        <input id="inv-name" class="form-input" type="text" required placeholder="${esc(t('inventory.namePlaceholder'))}">
      </div>
      <div class="form-pair form-pair--wide">
        <div class="form-group">
          <label class="form-label" for="inv-category">${esc(t('inventory.categoryLabel'))}</label>
          <select id="inv-category" class="form-input">${categoryOptions}</select>
        </div>
        <div class="form-group">
          <label class="form-label" for="inv-location">${esc(t('inventory.locationLabel'))}</label>
          <select id="inv-location" class="form-input">${locationOptions.join('')}</select>
        </div>
      </div>
      <div class="form-pair form-pair--wide">
        <div class="form-group">
          <label class="form-label" for="inv-purchase-date">${esc(t('inventory.purchaseDateLabel'))}</label>
          <yuvomi-datepicker id="inv-purchase-date" type="date"
                             value="${esc(isEdit && item.purchase_date ? item.purchase_date : '')}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="form-label" for="inv-purchase-price">${esc(t('inventory.purchasePriceLabel'))}</label>
          <input id="inv-purchase-price" class="form-input" type="number" min="0" step="0.01" inputmode="decimal">
        </div>
      </div>
      ${!isEdit && showsBookings ? `
      <div class="form-group">
        <button class="btn btn--secondary btn--sm" type="button" data-action="link-booking">
          <i data-lucide="link" aria-hidden="true"></i> ${esc(t('inventory.linkBooking'))}
        </button>
        <div data-picked-booking-chip hidden></div>
      </div>` : ''}
      <div class="form-group">
        <label class="form-label" for="inv-status">${esc(t('inventory.statusLabel'))}</label>
        <select id="inv-status" class="form-input">${statusOptions}</select>
      </div>
      ${isEdit && showsBookings ? `
      <div class="form-group">
        <span class="form-label">${esc(t('inventory.linkedBookingsLabel'))}</span>
        <div class="inventory-linked-entries" data-linked-entries></div>
        <button class="btn btn--secondary btn--sm" type="button" data-action="add-booking">
          <i data-lucide="plus" aria-hidden="true"></i> ${esc(t('inventory.addBooking'))}
        </button>
      </div>` : ''}
      ${advancedSection(`
        <div class="form-group">
          <span class="form-label">${esc(t('inventory.photoLabel'))}</span>
          <div class="inventory-photo-wrap">
            <button type="button" class="inventory-photo-editor" id="inv-photo-preview" aria-label="${esc(t('inventory.photoLabel'))}">
              ${photoPreviewHtml(photoData)}
            </button>
            <input class="sr-only" id="inv-photo" type="file" accept="image/png,image/jpeg,image/webp"
                   aria-label="${esc(t('inventory.photoLabel'))}" tabindex="-1">
            <div class="inventory-photo-actions">
              <button type="button" class="inventory-photo-action" id="inv-photo-edit"
                      aria-label="${esc(t('inventory.photoLabel'))}" title="${esc(t('inventory.photoLabel'))}">
                <i data-lucide="pencil" aria-hidden="true"></i>
              </button>
              <button type="button" class="inventory-photo-action inventory-photo-action--danger" id="inv-remove-photo"
                      aria-label="${esc(t('inventory.removePhoto'))}" title="${esc(t('inventory.removePhoto'))}">
                <i data-lucide="trash-2" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </div>
        <div class="form-pair form-pair--wide">
          <div class="form-group">
            <label class="form-label" for="inv-brand">${esc(t('inventory.brandLabel'))}</label>
            <input id="inv-brand" class="form-input" type="text">
          </div>
          <div class="form-group">
            <label class="form-label" for="inv-model">${esc(t('inventory.modelLabel'))}</label>
            <input id="inv-model" class="form-input" type="text">
          </div>
        </div>
        <div class="form-pair form-pair--wide">
          <div class="form-group">
            <label class="form-label" for="inv-serial">${esc(t('inventory.serialNumberLabel'))}</label>
            <input id="inv-serial" class="form-input" type="text">
          </div>
          <div class="form-group">
            <label class="form-label" for="inv-vendor">${esc(t('inventory.vendorLabel'))}</label>
            <input id="inv-vendor" class="form-input" type="text">
          </div>
          <div class="form-group">
            <label class="form-label" for="inv-account">${esc(t('inventory.accountUsernameLabel'))}</label>
            <input id="inv-account" class="form-input" type="text" maxlength="200"
                   autocomplete="off" spellcheck="false">
            <p class="form-hint">${esc(t('inventory.accountUsernameHint'))}</p>
          </div>
        </div>
        <div class="form-pair form-pair--wide">
          <div class="form-group">
            <label class="form-label" for="inv-warranty">${esc(t('inventory.warrantyMonthsLabel'))}</label>
            <input id="inv-warranty" class="form-input" type="number" min="0" max="600" step="1" inputmode="numeric">
            <p class="inventory-warranty-status" id="inv-warranty-status" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label" for="inv-condition">${esc(t('inventory.conditionLabel'))}</label>
            <select id="inv-condition" class="form-input">${conditionOptions}</select>
          </div>
        </div>
        <div class="form-pair form-pair--wide" id="inv-odometer-group" ${categoryTracksOdometer(isEdit ? item.category : 'other') ? '' : 'hidden'}>
          <div class="form-group">
            <label class="form-label" for="inv-odometer">${esc(t('inventory.odometerLabel'))}</label>
            <input id="inv-odometer" class="form-input" type="number" min="0" step="1" inputmode="numeric">
          </div>
          <div class="form-group">
            <label class="form-label" for="inv-odometer-unit">${esc(t('inventory.odometerUnitLabel'))}</label>
            <select id="inv-odometer-unit" class="form-input">
              <option value="km">${esc(t('inventory.odometerUnitKm'))}</option>
              <option value="mi">${esc(t('inventory.odometerUnitMi'))}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="inv-odometer-on">${esc(t('inventory.odometerOnLabel'))}</label>
            <yuvomi-datepicker id="inv-odometer-on" type="date"
                               value="${esc(isEdit && item.odometer_on ? item.odometer_on : '')}"></yuvomi-datepicker>
          </div>
        </div>
        <div class="form-group">
          <span class="form-label">${esc(t('inventory.trackedDatesLabel'))}</span>
          <p class="inventory-tracked-dates-hint">${esc(t('inventory.trackedDatesHint'))}</p>
          <div class="inventory-tracked-dates-rows" id="inv-tracked-dates-rows">
            ${(isEdit ? (item.tracked_dates || []) : []).map(trackedDateRowHtml).join('')}
          </div>
          <button type="button" class="btn btn--secondary btn--sm" id="inv-tracked-dates-add">
            <i data-lucide="plus" aria-hidden="true"></i> ${esc(t('inventory.addTrackedDate'))}
          </button>
        </div>
        <div class="form-group">
          <label class="form-label" for="inv-notes">${esc(t('inventory.notesLabel'))}</label>
          <textarea id="inv-notes" class="form-input" rows="3" placeholder="${esc(t('inventory.notesPlaceholder'))}"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label" for="inv-attachment-category">${esc(t('inventory.attachmentCategoryLabel'))}</label>
          <select id="inv-attachment-category" class="form-input">${documentCategoryOptions}</select>
        </div>
        ${renderDocumentAttachField({
          attachments: isEdit ? (item.attachments || []) : [],
          label: t('inventory.attachmentsLabel'),
          hint: t('inventory.attachmentsHint'),
        })}`,
      {
        open: isEdit && (!!item.brand || !!item.model || !!item.serial_number || !!item.notes
          || !!item.photo_data || (item.attachments?.length ?? 0) > 0
          // Kilometerstand auf einen Blick zeigen: entweder schon gesetzt,
          // oder die Kategorie, fuer die er am haeufigsten gebraucht wird.
          || item.odometer != null || categoryTracksOdometer(item.category)),
      })}
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `<button type="button" class="btn btn--danger-ghost" id="inv-delete">${esc(t('common.delete'))}</button>` : ''}
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="inv-save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
      </div>`;

  function wire(panel) {
    panel.querySelector('#inv-name').value = isEdit ? item.name : '';
    panel.querySelector('#inv-category').value = isEdit ? item.category : 'other';
    panel.querySelector('#inv-location').value = isEdit && item.location_id ? String(item.location_id) : '';
    panel.querySelector('#inv-purchase-price').value = isEdit && item.purchase_price != null ? String(item.purchase_price) : '';
    panel.querySelector('#inv-status').value = isEdit ? item.status : 'active';
    panel.querySelector('#inv-brand').value = isEdit && item.brand ? item.brand : '';
    panel.querySelector('#inv-model').value = isEdit && item.model ? item.model : '';
    panel.querySelector('#inv-serial').value = isEdit && item.serial_number ? item.serial_number : '';
    panel.querySelector('#inv-vendor').value = isEdit && item.vendor ? item.vendor : '';
    panel.querySelector('#inv-account').value = isEdit && item.account_username ? item.account_username : '';
    panel.querySelector('#inv-warranty').value = isEdit && item.warranty_months != null ? String(item.warranty_months) : '';
    panel.querySelector('#inv-condition').value = isEdit ? item.condition : 'good';
    panel.querySelector('#inv-notes').value = isEdit && item.notes ? item.notes : '';
    panel.querySelector('#inv-odometer').value = isEdit && item.odometer != null ? String(item.odometer) : '';
    panel.querySelector('#inv-odometer-unit').value = isEdit && item.odometer_unit ? item.odometer_unit : 'km';

    // Kilometerstand ist auf odometer-tragende Kategorien begrenzt (per
    // Voreinstellung nur "Fahrzeuge", Nutzer-Entscheidung 2026-09-17) - andere
    // Gegenstandsarten brauchen keinen Kilometerstand, und ein Kategoriewechsel
    // weg davon blendet die Gruppe wieder aus (saveItem() sendet dann ohnehin
    // null, siehe dort).
    const odometerGroup = panel.querySelector('#inv-odometer-group');
    panel.querySelector('#inv-category').addEventListener('change', (e) => {
      odometerGroup.hidden = !categoryTracksOdometer(e.target.value);
    });

    updateWarrantyStatus(panel);
    panel.querySelector('#inv-purchase-date').addEventListener('input', () => updateWarrantyStatus(panel));
    panel.querySelector('#inv-warranty').addEventListener('input', () => updateWarrantyStatus(panel));

    wireTrackedDateRows(panel);

    const photoPreview = panel.querySelector('#inv-photo-preview');
    const photoInput = panel.querySelector('#inv-photo');
    const renderPhotoPreview = () => {
      photoPreview.replaceChildren();
      photoPreview.insertAdjacentHTML('beforeend', photoPreviewHtml(photoData));
      if (window.lucide) window.lucide.createIcons({ el: photoPreview });
    };
    photoPreview?.addEventListener('click', () => photoInput?.click());
    panel.querySelector('#inv-photo-edit')?.addEventListener('click', () => photoInput?.click());
    photoInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      // Sofort zurücksetzen: ohne Reset feuert dieselbe Datei kein zweites
      // `change`-Event - nach einem abgebrochenen Zuschnitt ließe sie sich
      // nicht erneut wählen.
      e.target.value = '';
      try {
        const { pickCroppedImage } = await import('/utils/avatar-crop.js');
        const cropped = await pickCroppedImage(file, {
          // Nur der Ergebnis-Text ist inventarspezifisch: „Profilbild" wäre
          // für ein Gegenstandsfoto die falsche Vokabel.
          messageKeys: { dataTooLarge: 'inventory.photoTooLarge' },
        });
        // Abgebrochener Zuschnitt: das bisherige Foto bleibt stehen.
        if (cropped === undefined) return;
        photoData = cropped;
        renderPhotoPreview();
      } catch (err) {
        window.yuvomi?.showToast(err.message, 'danger');
      }
    });
    panel.querySelector('#inv-remove-photo')?.addEventListener('click', () => {
      photoData = null;
      if (photoInput) photoInput.value = '';
      renderPhotoPreview();
    });

    wireBlurValidation(panel);
    const attachments = bindDocumentAttachField(panel, {
      category: () => panel.querySelector('#inv-attachment-category').value,
      folderKey: 'inventory',
      folderName: t('documents.inventoryFolder'),
      documentName: (file) => t('inventory.attachmentDocumentName', {
        name: panel.querySelector('#inv-name').value.trim() || file.name,
      }),
    });
    if (showsBookings && isEdit) {
      renderLinkedEntries(panel, item);
      panel.querySelector('[data-action="add-booking"]').addEventListener('click', async () => {
        const picked = await openBookingPicker(panel, {
          includeRole: true,
          initialMonth: item.purchase_date ? item.purchase_date.slice(0, 7) : undefined,
        });
        if (!picked) return;
        try {
          const res = await api.post(`/inventory/items/${item.id}/entries`, {
            entry_id: picked.entry.id, role: picked.role,
          });
          item = res.data;
          renderLinkedEntries(panel, item);
          await loadItems();
          renderList({ repaint: true });
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
      panel.querySelector('[data-linked-entries]').addEventListener('click', async (event) => {
        const button = event.target.closest('[data-remove-entry]');
        if (!button) return;
        try {
          const res = await api.delete(`/inventory/items/${item.id}/entries/${button.dataset.removeEntry}`);
          item = res.data;
          renderLinkedEntries(panel, item);
          await loadItems();
          renderList({ repaint: true });
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
    } else if (showsBookings) {
      panel.querySelector('[data-action="link-booking"]').addEventListener('click', async () => {
        const picked = await openBookingPicker(panel, { includeRole: false });
        if (!picked) return;
        pickedBooking = picked;
        const chip = panel.querySelector('[data-picked-booking-chip]');
        chip.hidden = false;
        chip.replaceChildren();
        chip.insertAdjacentHTML('beforeend', `
          <span class="inventory-picked-booking-chip">
            ${esc(t('inventory.pendingBookingLabel', { title: picked.entry.title }))}
            <button type="button" data-clear-picked-booking
                    aria-label="${esc(t('inventory.removeBookingAction', { title: picked.entry.title }))}">
              <i data-lucide="x" aria-hidden="true"></i>
            </button>
          </span>`);
        chip.querySelector('[data-clear-picked-booking]').addEventListener('click', () => {
          pickedBooking = null;
          chip.hidden = true;
          chip.replaceChildren();
        });
        if (window.lucide) window.lucide.createIcons({ el: chip });
        const priceInput = panel.querySelector('#inv-purchase-price');
        if (!priceInput.value.trim()) priceInput.value = String(Math.abs(picked.entry.amount));
      });
    }

    panel.querySelector('#inv-save').addEventListener('click', () => saveItem(panel, mode, item, attachments, pickedBooking, photoData));
    panel.querySelector('#inv-delete')?.addEventListener('click', async () => {
      await closeSharedModal({ force: true });
      await removeItem(item);
      refocusAfterRender();
    });
    // `.modal-panel__footer` scoped, NICHT der ganze panel: sonst matcht dies
    // zuerst den Header-X (`.modal-panel__close`, gleiches data-action), der
    // ueber modal.js's eigenen Scan schon verdrahtet ist - ein zweiter
    // Listener dort fuehrt bei ungespeicherten Aenderungen zu einem
    // Doppel-Close-Rennen gegen den "verwerfen?"-Dialog.
    panel.querySelector('.modal-panel__footer [data-action="close-modal"]')?.addEventListener('click', () => closeSharedModal());

    if (window.lucide) window.lucide.createIcons({ el: panel });
  }

  return { title: isEdit ? t('common.editItem') : t('inventory.addItem'), content, wire };
}

function openItemModal(mode, item = null) {
  // DER EINE RIEGEL: jeder Anlege- und Bearbeitungsweg endet hier - FAB,
  // Leerzustand, Tastenkuerzel „n" (klickt den FAB), Enter auf der Zeile und
  // „Bearbeiten" aus der Detailspalte.
  if (readOnly()) return;
  const form = buildItemForm({ mode, item });
  openSharedModal({ title: form.title, size: 'md', content: form.content, onSave: form.wire });
}

async function saveItem(panel, mode, item, attachments, pickedBooking, photoData) {
  if (readOnly()) return;
  const saveBtn = panel.querySelector('#inv-save');
  const nameInput = panel.querySelector('#inv-name');
  const name = nameInput.value.trim();
  if (!name) { reportFieldError(nameInput, t('common.nameRequired')); return; }

  const priceRaw = panel.querySelector('#inv-purchase-price').value.trim();
  const warrantyRaw = panel.querySelector('#inv-warranty').value.trim();
  const category = panel.querySelector('#inv-category').value;
  // Kilometerstand ist auf odometer-tragende Kategorien begrenzt - unabhaengig
  // vom (bei anderen Kategorien versteckten) Feldinhalt zaehlt hier nur die
  // aktuelle Kategorie, sonst ueberlebte ein vor dem Kategoriewechsel
  // eingetragener Wert unsichtbar.
  const odometerRaw = categoryTracksOdometer(category) ? panel.querySelector('#inv-odometer').value.trim() : '';

  const payload = {
    name,
    category,
    location_id: panel.querySelector('#inv-location').value || null,
    purchase_date: panel.querySelector('#inv-purchase-date').value || null,
    purchase_price: priceRaw === '' ? null : Number(priceRaw),
    status: panel.querySelector('#inv-status').value,
    brand: panel.querySelector('#inv-brand').value.trim() || null,
    model: panel.querySelector('#inv-model').value.trim() || null,
    serial_number: panel.querySelector('#inv-serial').value.trim() || null,
    vendor: panel.querySelector('#inv-vendor').value.trim() || null,
    account_username: panel.querySelector('#inv-account').value.trim() || null,
    warranty_months: warrantyRaw === '' ? null : Number(warrantyRaw),
    condition: panel.querySelector('#inv-condition').value,
    notes: panel.querySelector('#inv-notes').value.trim() || null,
    tracked_dates: collectTrackedDates(panel),
    photo_data: photoData,
    odometer: odometerRaw === '' ? null : Number(odometerRaw),
    odometer_unit: odometerRaw === '' ? null : panel.querySelector('#inv-odometer-unit').value,
    odometer_on: categoryTracksOdometer(category) ? (panel.querySelector('#inv-odometer-on').value || null) : null,
  };

  saveBtn.disabled = true;
  try {
    if (attachments) payload.attachment_document_ids = await attachments.commit();
    if (pickedBooking) payload.entry_id = pickedBooking.entry.id;
    if (mode === 'create') await api.post('/inventory/items', payload);
    else await api.put(`/inventory/items/${item.id}`, payload);
    await loadItems();
    closeSharedModal({ force: true });
    renderList({ repaint: true, motion: true });
    updateAttentionBadge();
    window.yuvomi?.showToast(mode === 'create' ? t('inventory.created') : t('inventory.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

async function removeItem(item) {
  if (readOnly()) return;
  const ok = await confirmModal(t('inventory.deleteConfirm', { name: item.name }), {
    danger: true,
    detail: t('inventory.deleteConfirmDetail'),
  });
  if (!ok) return;
  try {
    await api.delete(`/inventory/items/${item.id}`);
    await loadItems();
    // Die Zeile klappt aus, die Nachbarn ruecken nach - erst dann steht die
    // Liste ohne sie neu (ohne Bewegung loest collapseRow sofort auf).
    await collapseRow(_container?.querySelector(`#inventory-list .list-row[data-id="${item.id}"]`) ?? null);
    // ERST WENN DIE HISTORY WIEDER DER SEITE GEHOERT (R17). Die Rueckfrage
    // gibt ihren Marker per `history.back()` zurueck, und das kommt erst nach
    // ihrem Ausblenden an (~220ms). Antwortet der Server schneller, raeumte der
    // Listenaufbau `?open=<id>` vom MARKER-Eintrag ab - das `back()` trug den
    // Browser danach auf den Eintrag darunter, und in der Adresse stand wieder
    // der geloeschte Gegenstand (gemessen bei aktiver Suche: Spalte leer,
    // Adresse `?open=9`; ein Neuladen zeigte „nicht gefunden").
    await whenHistorySettled();
    renderList({ repaint: true, motion: true });
    refocusAfterRender();
    updateAttentionBadge();
    window.yuvomi?.showToast(t('inventory.deleted'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * Das Werkzeugmenue im Kopf. Beide Eintraege sind Verwaltung (Orte,
 * Kategorien) und schreiben - bei `read` faellt das Menue ganz weg, der
 * Aufrufer versteckt den Ausloeser (Regel 7 in utils/module-access.js).
 */
function inventoryToolsHtml() {
  if (readOnly()) return '';
  return `
    <div class="page-toolbar__actions">
      ${pageToolsMenuHtml({
        id: 'inventory-tools-menu',
        label: t('common.moreActions'),
        items: [
          { action: 'manage-locations', label: t('inventory.manageLocations'), icon: 'map-pin' },
          { action: 'manage-categories', label: t('inventory.manageCategories'), icon: 'tags' },
        ],
      })}
    </div>`;
}

export async function render(container, { signal } = {}) {
  _container = container;
  _md = null;

  const page = document.createElement('div');
  // Breitenregel (DESIGN.md, 2026-09-26): Inventar gehoert zu Liste + Detail,
  // weil es eine Leseansicht hat (openDetailView). Unter der Schwelle steht es
  // auf dem Lesemass (`reading` bleibt die Modusrolle), ab der Schwelle stehen
  // Liste und Detailspalte nebeneinander (utils/master-detail.js). Das
  // fruehere 960er-Mass (`data`) ist abgeschafft. Die Zeilentraeger lesen das
  // Mass der Seite (Guard in test-frontend-audit.js); ohne die Rolle enden Kopf
  // und Bedienzeilen neben ihrem eigenen Koerper.
  page.className = 'inventory-page app-page app-page--reading app-page--list-detail';
  page.dataset.composition = 'reading';

  // Sichtbarer Seitentitel statt sr-only: nur ein echtes .page-toolbar__title
  // loest das Absender-Siegel der Shell aus (router.js#wireToolbar,
  // headSealIcon), das jedes andere Modul schon automatisch zeigt - Icon +
  // Name, direkt vor dem Titel, aus derselben Quelle wie der Sidebar-Eintrag.
  const toolbar = document.createElement('div');
  // Werkzeuge in der Titelzeile (DESIGN.md, Kopfregel mobil 1a; Critique R17):
  // Such-Icon und Werkzeugmenue sind zwei Icon-Knoepfe und keine eigene Zeile
  // wert - mobil stand der Kopf dreizeilig (114px, in einer Kategorie 154px)
  // neben Dokumente und Gesundheit mit 65px.
  toolbar.className = 'page-toolbar page-toolbar--narrow page-toolbar--wrap page-toolbar--title-tools inventory-toolbar';
  // Kopfregel mobil (DESIGN.md, 2026-09-26): Lagerorte und Kategorien sind
  // Verwaltung, nicht Ansicht - sie stehen im EINEN Werkzeugmenue mit Icon UND
  // Text statt als zwei unbeschriftete Icons in einer eigenen Kopfzeile. Die
  // Suche ist selbst der Slot (`page-toolbar__center`), nicht in einen Wrapper
  // geschachtelt: so greift ihre Icon-Form mobil wie in den Dokumenten (A6 P1-1).
  toolbar.insertAdjacentHTML('beforeend', `
    ${renderPageSearch({
      id: 'inventory-search',
      label: t('inventory.searchPlaceholder'),
      placeholder: t('inventory.searchPlaceholder'),
      value: state.query,
      clearLabel: t('common.searchClear'),
      className: 'inventory-search page-toolbar__center',
    })}
    ${inventoryToolsHtml()}`);
  toolbar.insertAdjacentHTML('afterbegin', `<h1 class="page-toolbar__title">${esc(t('nav.inventory'))}</h1>`);

  const filters = document.createElement('div');
  filters.className = 'inventory-filters';
  filters.id = 'inventory-filters';
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', t('inventory.filterGroupLabel'));
  filters.hidden = true;

  const list = document.createElement('div');
  list.className = 'inventory-list split-view__list';
  list.id = 'inventory-list';
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 4, lines: 2 }));

  // Liste + Detail: die Liste bleibt, wie sie war, und bekommt rechts die
  // Detailspalte. Unter der Schwelle ist die Spalte `display: none` und die
  // Huelle ein unsichtbarer Block (layout.css, `.split-view`).
  const split = document.createElement('div');
  split.className = 'split-view';
  split.append(list);
  split.insertAdjacentHTML('beforeend', splitViewDetailHtml({
    id: 'inventory',
    label: t('inventory.detailPaneLabel'),
    empty: { icon: 'package', title: t('inventory.pickOne'), hint: t('inventory.pickOneHint') },
  }));

  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', t('inventory.addItem'));
  // Am Zeigergeraet dockt der FAB als beschrifteter Knopf in den Modulkopf; ohne
  // dockLabel bleibt er dort still leer (Guard in test-frontend-audit.js). Das
  // Substantiv kommt aus dem gemeinsamen newLabel-Register, damit alle Module
  // ihre primaere Aktion gleich benennen. Regel aus v2.8.0, also nach der Basis
  // dieses Zweigs.
  fab.dataset.dockLabel = t('newLabel.inventory');
  fab.insertAdjacentHTML('beforeend', '<i data-lucide="plus" aria-hidden="true"></i>');

  page.append(toolbar, filters, split, fab);
  container.replaceChildren(page);

  if (window.lucide) window.lucide.createIcons({ el: container });

  installPopoverMenus(container);
  // Zurueck/Vor ueber Eintraege mit verschiedenem Chip (eine Auswahl legt
  // ihren Eintrag samt `?category=` an). Der Router fragt danach den Baustein
  // (`handleMasterDetailPopstate`), der dank `mdAddress` jeden Filterstand als
  // dieselbe Seite erkennt und nur die Auswahl aus `?open=` nachzieht.
  //
  // DIE REIHENFOLGE ZWISCHEN DIESEM HOERER UND DEM BAUSTEIN IST NICHT FEST:
  // der Router fragt den Baustein in einem `.then`, und der Browser leert die
  // Microtasks nach JEDEM Hoerer - gemessen lief der Baustein ZUERST, noch auf
  // der alten Liste. Deshalb zieht die Seite die Auswahl nach dem Neuaufbau
  // selbst aus der Adresse nach - dasselbe Ziel, in welcher Reihenfolge auch
  // immer.
  window.addEventListener('popstate', () => {
    if (location.pathname !== INVENTORY_PATH || !state.items.length) return;
    if (!syncCategoryFromAddress()) return;
    renderListBody();
    syncDetailTop(page, split.querySelector('.split-view__detail'));
    scrollListToTop();
    if (!_md?.isSplit()) return;
    const open = mdAddress.read(location);
    if (open) _md.select(open, { history: 'none' });
    else _md.clear({ history: 'none' });
  }, { signal });
  toolbar.addEventListener('click', (e) => {
    const item = pageToolsActionEl(e.target);
    if (!item || item.disabled || readOnly()) return;
    if (item.dataset.action === 'manage-locations') openLocationManager();
    else if (item.dataset.action === 'manage-categories') openCategoryManager();
  });

  _search = wirePageSearch(toolbar, {
    id: 'inventory-search',
    onQuery: (value) => { state.query = value.trim(); renderList(); },
  });

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    selectCategory(chip.dataset.category || null);
  });
  wireScrollFade(filters);

  fab.addEventListener('click', () => openItemModal('create'));

  // Die Detailspalte klebt unter dem Kopf, waehrend die Liste mit der Seite
  // scrollt (inventory.css). Inventar hat keinen eigenen Scrollport - der Kopf
  // klebt in #main-content -, also braucht die Spalte seine Hoehe als Versatz.
  // Gemessen statt als Token, weil der Kopf in langen Locales umbricht.
  const syncHeadBlock = () => {
    page.style.setProperty('--inventory-head-block', `${toolbar.offsetHeight}px`);
    syncDetailTop(page, split.querySelector('.split-view__detail'));
  };
  syncHeadBlock();
  // Beim Scrollen wandert die Oberkante der Spalte vom Ruhe- zum Klebestand
  // (syncDetailTop); ein Messwert je Frame reicht.
  let detailTopFrame = 0;
  document.getElementById('main-content')?.addEventListener('scroll', () => {
    if (detailTopFrame) return;
    detailTopFrame = requestAnimationFrame(() => {
      detailTopFrame = 0;
      syncDetailTop(page, split.querySelector('.split-view__detail'));
    });
  }, { passive: true, signal });
  if (typeof ResizeObserver === 'function') {
    const headRo = new ResizeObserver(syncHeadBlock);
    headRo.observe(toolbar);
    signal?.addEventListener('abort', () => headRo.disconnect(), { once: true });
  }

  try {
    await Promise.all([
      loadLocations(),
      loadCategories(),
      loadItems(),
      api.get('/preferences').then((res) => { _householdCurrency = res.data?.currency ?? 'EUR'; }).catch(() => {}),
    ]);
    if (signal?.aborted) return;
    // Der Chip steht in der Adresse, nicht im Modulzustand vom letzten Besuch.
    if (isShownCategory(categoryFromAddress())) {
      state.activeCategory = categoryFromAddress();
    } else {
      if (categoryFromAddress()) writeFilterAddress({ category: null, open: new URLSearchParams(location.search).get('open') });
      state.activeCategory = null;
    }
    revealDeepLinkedItem(split);
    renderList();
    _md = mountMasterDetail({
      root: split,
      signal,
      address: mdAddress,
      renderDetail: (id, body, ctx) => {
        const item = state.items.find((i) => String(i.id) === id);
        if (!item) return false;
        return openItemDetail(item, { pane: body, signal: ctx.signal });
      },
      openNarrow: openItemNarrow,
      onEnter: (id) => {
        const item = state.items.find((i) => String(i.id) === id);
        if (item && !readOnly()) openItemModal('edit', item);
      },
      onModeChange: onInventoryModeChange,
    });
    signal?.addEventListener('abort', () => { _md = null; }, { once: true });
    updateAttentionBadge();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    list.replaceChildren();
  }
}

/**
 * Deep-Link `?open=` in der Spaltenform: die Zeile des Gegenstands muss in der
 * Liste stehen, sonst waere die Auswahl ohne Markierung und fiele beim
 * naechsten Neuaufbau weg (master-detail.js#refresh). Unter der Schwelle loest
 * niemand den Link ein (kein Blatt, das beim Laden aufspringt), und der Filter
 * bleibt, wie die Adresse ihn nennt.
 */
function revealDeepLinkedItem(split) {
  const id = new URLSearchParams(location.search).get('open');
  if (!id) return;
  const detail = split.querySelector('.split-view__detail');
  if (!detail || getComputedStyle(detail).display === 'none') return;
  revealItem(id);
}

/**
 * Dafuer sorgen, dass die Zeile eines Gegenstands in der Liste steht. Suche
 * und Fristen-Filter fallen weg - beide ueberleben den Seitenwechsel im
 * Modulzustand, und stuende ein alter davon noch, fehlte die Zeile, und rechts
 * stuende ein Detail, das der naechste Listenaufbau samt Adresse abraeumt. Der
 * Chip bleibt, wenn der Gegenstand in seiner Kategorie liegt (eine
 * Kategorie-Adresse waehlt ihn vor); nennt die Adresse eine ANDERE Kategorie,
 * gewinnt der Gegenstand und es gilt „Alle".
 * @returns {boolean} ob es den Gegenstand gibt
 */
function revealItem(id) {
  const item = state.items.find((i) => String(i.id) === String(id));
  if (!item) return false;
  state.query = '';
  state.filterAttention = false;
  _search?.clear();
  if (state.activeCategory != null && state.activeCategory !== item.category) {
    state.activeCategory = null;
    // Ersetzt: ein Deep-Link oder ein breiter gezogenes Fenster ist kein
    // Schritt fuer die Zurueck-Taste.
    writeFilterAddress({ category: null, open: id });
  }
  return true;
}

/**
 * Unter der Schwelle: das Blatt eines Gegenstands (utils/master-detail.js,
 * `openNarrow`). openItemDetail() laedt erst den Verlauf - das Signal des
 * Bausteins bricht ab, wenn in der Zeit Zurueck gedrueckt, das Fenster breit
 * oder die Seite verlassen wurde; dann geht kein altes Blatt mehr auf.
 */
function openItemNarrow(id, _trigger, { signal } = {}) {
  const item = state.items.find((i) => String(i.id) === String(id));
  if (item) return openItemDetail(item, { signal });
  return undefined;
}

/**
 * Die Darstellung hat gewechselt (utils/master-detail.js, `onModeChange`).
 *
 * Ein `?open=` vom Telefon oeffnet nichts (kein Blatt beim Laden), der
 * Baustein merkt sich die ID. Wird das Fenster breiter, zeichnet er das
 * Detail - vorher muss links die Zeile stehen, wie beim Deep-Link in der
 * Spaltenform (eine Suche vom Telefon kann sie verbergen).
 */
function onInventoryModeChange({ split, selectedId }) {
  if (!split || selectedId == null) return;
  const list = _container?.querySelector('#inventory-list');
  if (list?.querySelector(`[data-md-id="${CSS.escape(String(selectedId))}"]`)) return;
  if (revealItem(selectedId)) renderList();
}

export const __test = {
  state,
  // R17 (E3): eine Liste, die Kategorie ist ein Filter mit Adresse.
  selectCategory,
  syncCategoryFromAddress,
  categoryChips,
  visibleGroups,
  warrantyDetailValue,
  mdAddress,
  renderItemRow,
  renderItemDetail,
  revealDeepLinkedItem,
  syncDetailTop,
  onInventoryModeChange,
  openItemNarrow,
  categoryLabel,
  itemCategoryLabel,
  categoryOptionsHtml,
  attachmentDetailEntries,
  buildItemForm,
  // #1265: Nur-lesen. Die Suite faehrt Markup und Handler, nicht den Quelltext.
  readOnly,
  emptyInventoryState,
  inventoryToolsHtml,
  trackedDateDetailEntries,
  trackedDatesDetailNode,
  openItemDetail,
  openItemModal,
  openCompletionSheet,
  openLocationManager,
  openCategoryManager,
  saveItem,
  removeItem,
  // Review R11: Kilometerstand-Trend auf der Zeitachse, auch am selben Tag.
  odometerChartMarkup,
};
