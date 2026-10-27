/**
 * Modul: Vorrat (Pantry)
 * Zweck: Bestand, Lagerort und Mindesthaltbarkeit der Vorräte verwalten (#596)
 * Abhängigkeiten: /api.js
 *
 * Die vierte Seite des Küchen-Kreislaufs: Mahlzeiten planen, Rezepte kochen,
 * Einkauf besorgen - und hier steht, was tatsächlich im Haus ist.
 */

import { api } from '/api.js';
import { t, getNumberFormat } from '/i18n.js';
import { dateText } from '/utils/date-format.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { readRowHtml, readRowHintEl } from '/utils/read-row.js';
import {
  openModal as openSharedModal,
  closeModal as closeSharedModal,
  captureModalContext,
  captureOpenContext,
  isModalContextCurrent,
  advancedSection,
  wireBlurValidation,
  reportFieldError,
  refocusAfterRender,
} from '/components/modal.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer, transferMessage, mayTransferPantryToShopping } from '/utils/kitchen-transfer.js';
import { mayWritePath } from '/utils/module-access.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { pageToolsMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import { rowMenuHtml } from '/utils/row-action.js';
import { errorSentence } from '/utils/friendly-error.js';
// Alias, weil dieses Modul selbst eine `emptyStateEl()`-Funktion hat, die den
// Renderer mit den Vorrats-Texten füllt.
import { emptyStateEl as emptyStateComponentEl, mountLoadError, searchEmptyEl } from '/utils/empty-state.js';
import { scheduleUndoableDelete, vibrate, wireScrollFade, collapseOut, expandIn, toggleRegion } from '/utils/ux.js';
import { redrawList } from '/utils/list-motion.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { todayKey } from '/utils/date.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';
import { locationLabel } from '/utils/pantry-locations.js';
import { setBulkPill, clearBulkPill } from '/utils/bulk-pill.js';
import { PANTRY_UNITS, normalizePantryQuantity, pantryUnitStep, pantryQuantityLabel } from '/utils/pantry-units.js';
import {
  PANTRY_FILTERS,
  daysUntil,
  matchesPantryFilter,
  pantryExpiryPhrase,
  pantryFilterCounts,
  pantryFilterFromSearch,
  pantryItemStatus,
} from '/utils/pantry-status.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';

let _container = null;
/** Handle des geteilten Suchfelds (setValue/clear), gesetzt in render(). */
let _search = null;

const state = {
  items: [],
  /** Die Haushaltsprodukte ueber den Chargen (#1448), auch die ohne Charge. */
  products: [],
  locations: [],
  categories: [],
  /** Einkaufslisten - erst beim ersten „Auf die Einkaufsliste" nachgeladen. */
  lists: null,
  query: '',
  filter: 'all',
  /** Einmal pro Render eingefroren: sonst könnte ein über Mitternacht offener
   *  Tab Zeilen unterschiedlich bewerten, je nachdem wann sie gezeichnet wurden. */
  todayKey: todayKey(),
};

/**
 * DIE ABSICHT, NICHT DER STAND - dieselbe Trennung wie im Einkauf.
 *
 * `state.items` traegt ausschliesslich, was der Server zuletzt gesagt hat. Was
 * der Nutzer WILL, steht hier: id -> { quantity, seq, timer, flush }. Die Zeile
 * zeigt die Ueberlagerung (`withIntent`).
 *
 * Der Vorlaeufer vermischte beides in `item.quantity`. Dann braucht ein
 * Fehlschlag eine Ruecksprung-Grundlage, und die wurde ueber vier
 * Review-Runden hinweg immer wieder falsch: mal vom alten Schnappschuss
 * ueberschrieben, mal am bestaetigten Wert vorbei, mal aus dem Offline-Cache.
 * Getrennt gehalten gibt es sie nicht mehr - ein Ruecksprung ist das ENTFERNEN
 * der Absicht.
 *
 * Drei Regeln:
 *   - Ein Schritt setzt die Absicht (entprellt, deshalb Timer und `flush`).
 *   - Scheitert der Schreibvorgang, faellt sie.
 *   - Bestaetigt der Server, wandert der Wert in den Serverstand und die
 *     Absicht faellt - geschuetzt von `settledAt`, damit eine Antwort, die
 *     vorher losgeschickt wurde, ihn nicht zurueckdreht.
 */
const intents = new Map();

/**
 * Products whose batches are open (product keys, see productKeyOf). Held for
 * the visit of the page only, like the open overdue group on the dashboard:
 * a redraw after a step or a save keeps it, a new visit starts collapsed.
 */
const expandedProducts = new Set();

/**
 * Batches deleted but still inside the undo window (removeItem). They stay in
 * `state.items` until the delete commits, so a product row would otherwise go
 * on counting the batch the user has just swiped away.
 */
const pendingDeletes = new Set();

/**
 * Products without batches deleted but still inside the undo window
 * (removeProduct). productSections() leaves them out, so a redraw in the window
 * (a search, a chip) does not bring the row back before the delete commits.
 */
const pendingProductDeletes = new Set();
let QUANTITY_DEBOUNCE_MS_OVERRIDE = null; // nur fuer Tests, siehe __test unten
const QUANTITY_DEBOUNCE_MS = 450;
/** Monotone Folgenummer, die überholte PATCH-Antworten erkennbar macht. */
let _quantitySeq = 0;
/** Monotone Nummer je Ladevorgang, und wann ein Artikel zuletzt bestaetigt wurde. */
let _pantryLoadSeq = 0;
let _pantryAppliedLoad = 0;
const settledAt = new Map();

/** Die Menge, die die Zeile ZEIGT: die Absicht, sonst der Serverstand. */
function quantityOf(item) {
  const intent = intents.get(item?.id);
  return intent ? intent.quantity : Number(item?.quantity ?? 0);
}

/**
 * Der Artikel, wie ihn die Zeile zeigt.
 *
 * Als Kopie statt als Einzelwert, weil die Menge in abgeleitete Angaben
 * einfliesst - Badges, Bestandsstatus, Fehlmenge. So bleiben `quantityText`,
 * `pantryItemStatus` und `shortfallText` unveraendert und bekommen einfach den
 * ueberlagerten Artikel.
 */
function withIntent(item) {
  const intent = intents.get(item?.id);
  return intent ? { ...item, quantity: intent.quantity } : item;
}

// --------------------------------------------------------
// Formatierung
// --------------------------------------------------------

/**
 * Menge ohne überflüssige Nachkommastellen: 2 bleibt "2", 2,5 wird lokalisiert.
 * getNumberFormat() formatiert in der Format-Locale der Region - die
 * Zahlenformat-Präferenz ist von der UI-Sprache entkoppelt (#521).
 */
function formatQuantity(value) {
  return getNumberFormat({ maximumFractionDigits: 2 }).format(Number(value) || 0);
}

/**
 * Einheit übersetzen, mit Rückfall auf den Rohwert. Alle Schreibpfade der App
 * normalisieren über normalizePantryUnit() auf die zehn kanonischen Einheiten,
 * ein unbekannter Wert ist also nicht über die Oberfläche erreichbar - wohl
 * aber über einen direkten Datenbankzugriff, einen Fremdimport oder eine
 * künftige Einheit, deren Locale-Key noch fehlt. Ohne diesen Rückfall stünde
 * dann der nackte Schlüssel in der Zeile („1 pantry.units.Stk"), und zwar an
 * der Stelle, an der die Menge steht. Der Rohwert ist immer noch lesbar.
 */
function unitLabel(unit) {
  const key = `pantry.units.${unit}`;
  const label = t(key);
  return label === key ? String(unit ?? '') : label;
}

/** „6 Dosen", nicht „6 Dose": die Einheit flektiert mit der Menge (W2). */
function quantityText(item) {
  return pantryQuantityLabel(item.quantity, item.unit, { t, formatNumber: formatQuantity });
}

/**
 * Ablauf-Badge als { text, tone } oder null. Bewusst nur für abgelaufen/bald:
 * ein Badge auf jeder Zeile wäre Ornament und würde genau die Zeilen entwerten,
 * die wirklich Aufmerksamkeit brauchen.
 */
function expiryBadge(item) {
  const { expiry } = pantryItemStatus(item, state.todayKey);
  if (!expiry) return null;

  // Der Satz kommt aus pantryExpiryPhrase(), den auch die Dashboard-Kachel
  // „Läuft bald ab" spricht - dieselbe Charge heisst an beiden Orten gleich.
  const phrase = pantryExpiryPhrase(daysUntil(item.expires_on, state.todayKey));
  return {
    tone: expiry === 'expired' ? 'danger' : 'warning',
    text: phrase.count === undefined ? t(phrase.key) : t(phrase.key, { count: phrase.count }),
  };
}

function stockBadge(item) {
  const { out, low } = pantryItemStatus(item, state.todayKey);
  if (out) return { tone: 'danger', text: t('pantry.badgeOut') };
  if (low) return { tone: 'warning', text: t('pantry.badgeLow') };
  return null;
}

// --------------------------------------------------------
// Laden
// --------------------------------------------------------


async function loadPantry() {
  const startedAt = ++_pantryLoadSeq;
  const res = await api.get('/pantry');
  // Wer aelter ist als das, was schon steht, fasst den Stand nicht mehr an.
  if (startedAt < _pantryAppliedLoad) return;
  _pantryAppliedLoad = startedAt;
  // Anders als der Einkauf liest der Vorrat mit `api.get`: `/pantry` steht
  // NICHT in `API_CACHE_WHITELIST` (sw.js), es gibt hier also keine Antwort aus
  // dem Cache. Haelt der Guard in `test-frontend-audit.js` fest.

  // EIN BESTAETIGTER ARTIKEL WIRD VON EINER AELTEREN ANTWORT NICHT
  // ZURUECKGEDREHT - alles andere an ihr wird gebraucht und landet.
  const vorherige = new Map(state.items.map((i) => [i.id, i]));
  const frisch = res.data ?? [];
  for (const item of frisch) {
    const bestaetigt = settledAt.get(item.id);
    if (bestaetigt != null && bestaetigt >= startedAt) {
      const alt = vorherige.get(item.id);
      if (alt) item.quantity = alt.quantity;
    }
  }
  state.items = frisch;
  state.products = res.products ?? [];
  state.locations = res.locations ?? [];
  state.categories = res.categories ?? [];
}

/** Einkaufslisten nachladen (erst wenn eine Übergabe ansteht). */
async function ensureLists() {
  if (state.lists) return state.lists;
  const res = await api.get('/shopping');
  state.lists = res.data ?? [];
  return state.lists;
}

// --------------------------------------------------------
// Auswahl / Gruppierung
// --------------------------------------------------------

/** The storage location of a place chip ("place:3"), or null for the other filters. */
function placeFilterId(filter = state.filter) {
  const match = /^place:(\d+)$/.exec(String(filter ?? ''));
  return match ? Number(match[1]) : null;
}

function visibleItems() {
  const q = state.query.toLowerCase();
  const place = placeFilterId();
  // Gefiltert wird nach dem, was die Zeile ZEIGT - sonst faellt ein Artikel aus
  // „Fast leer", waehrend die Zeile ihn noch dort zeigt.
  return state.items.map(withIntent).filter((item) => {
    // A place chip (#1448) asks "what is in the freezer?": the batches there.
    if (place != null ? item.location_id !== place : !matchesPantryFilter(item, state.filter, state.todayKey)) return false;
    if (!q) return true;
    return item.name?.toLowerCase().includes(q)
      || item.notes?.toLowerCase().includes(q)
      || (item.location_name && locationLabel(item.location_name).toLowerCase().includes(q));
  });
}

/**
 * Mit einem Filter eine flache, nach Dringlichkeit sortierte Chargenliste: die
 * Chips fragen „welche Packung", und die Antwort ist eine Charge. Der Ort steht
 * in der Meta-Zeile, bei mehreren Chargen eines Produkts auch dessen Summe.
 */
function flatItems(items) {
  const flat = [...items];
  if (placeFilterId() != null) {
    // A place lists its batches like the page lists products: by name, then
    // best-before (none last), then id.
    flat.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' })
      || (a.expires_on ? 0 : 1) - (b.expires_on ? 0 : 1)
      || String(a.expires_on ?? '').localeCompare(String(b.expires_on ?? ''))
      || a.id - b.id);
  } else if (state.filter === 'expired' || state.filter === 'soon') {
    flat.sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
  } else {
    flat.sort((a, b) => Number(a.quantity) - Number(b.quantity));
  }
  return flat;
}

/** The product a batch belongs to; a batch without one stands for itself. */
function productKeyOf(item) {
  return item.product_id != null ? `p${item.product_id}` : `b${item.id}`;
}

/** Every batch of the household per product, as the rows show them (with intent). */
function batchesByProduct() {
  const byProduct = new Map();
  for (const item of state.items) {
    const key = productKeyOf(item);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(withIntent(item));
  }
  return byProduct;
}

/** Sum of the batches' quantities, as the product's total. */
function productTotal(batches) {
  return normalizePantryQuantity(batches.reduce((sum, b) => sum + Number(b.quantity || 0), 0), { fallback: 0 });
}

/** "4 l in all": the total in the product's unit, inflected like a row's quantity. */
function productTotalText(total, unit) {
  return t('pantry.productTotal', { quantity: quantityText({ quantity: total, unit }) });
}

/** " · 2 places", or " · 2 batches · Pantry cupboard" when all share one place. */
function productWhereText(batches) {
  const places = new Set(batches.map((b) => b.location_id ?? 'none')).size;
  return places > 1
    ? ` · ${t('pantry.productPlaces', { count: places })}`
    : ` · ${t('pantry.productBatches', { count: batches.length })} · ${placeText(batches[0])}`;
}

/**
 * The most urgent expiry among a product's batches, as the batch row says it
 * ("Expired yesterday", "3 days left"): the earliest best-before date that is
 * expired or soon, so expired beats soon. Only the expiry: low and out over
 * the product come with the minimum on the product (#1448, step 3).
 */
function productExpiryBadge(batches) {
  const urgent = batches
    .filter((b) => b.expires_on && pantryItemStatus(b, state.todayKey).expiry)
    .sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
  return urgent.length ? expiryBadge(urgent[0]) : null;
}

/** Fills the badge slot of a product row (empty when nothing is urgent). */
function fillProductBadge(slot, batches) {
  slot.replaceChildren();
  const badge = productExpiryBadge(batches);
  if (!badge) return;
  const el = document.createElement('span');
  el.className = `pantry-badge pantry-badge--${badge.tone}`;
  el.textContent = badge.text;
  slot.appendChild(el);
}

/**
 * Without a filter the page lists PRODUCTS, in sections by category (#1448,
 * step 2): "the total on top and the batches underneath" (discussion #1077).
 * Category, not place: a product with batches in the fridge and the cellar has
 * one place in the list only this way, and the food / household view (#1756)
 * keys on the same category. The place moves into the row.
 *
 * A product is shown whole when its name, or the name, note or place of one of
 * its batches, matches the search. A product without batches (it outlives its
 * last one) is listed with its name only. Sections follow the category order
 * of Shopping (`sort_order`), a category without a known entry goes last, and
 * no category means the default one ("Other"). Products sort by name like the
 * server sorts batches (case-insensitive); batches by place order, best-before
 * (none last) and id.
 *
 * @returns {Array<{ key: string, label: string, products: object[] }>}
 */
function productSections(matching) {
  const byProduct = batchesByProduct();
  const known = new Map(state.products.map((p) => [`p${p.id}`, p]));
  const q = state.query.toLowerCase();
  const keys = new Set(matching.map(productKeyOf));
  for (const p of state.products) {
    if (pendingProductDeletes.has(p.id)) continue;
    if (!byProduct.has(`p${p.id}`) && (!q || p.name?.toLowerCase().includes(q))) keys.add(`p${p.id}`);
  }

  const placeOrder = new Map(state.locations.map((loc, idx) => [loc.id, idx]));
  const last = state.locations.length;
  const placeRank = (item) => (item.location_id == null ? last + 1 : (placeOrder.get(item.location_id) ?? last));
  // Best-before ascending, a batch without a date after the dated ones.
  const dateRank = (a, b) => (a.expires_on ? 0 : 1) - (b.expires_on ? 0 : 1)
    || String(a.expires_on ?? '').localeCompare(String(b.expires_on ?? ''));
  const byBatchOrder = (a, b) => (placeRank(a) - placeRank(b)) || dateRank(a, b) || (a.id - b.id);

  const products = [...keys].map((key) => {
    const batches = [...(byProduct.get(key) ?? [])].sort(byBatchOrder);
    const product = known.get(key);
    const first = batches[0];
    return {
      key,
      id: product?.id ?? null,
      name: product?.name ?? first?.name ?? '',
      unit: product?.unit ?? first?.unit,
      category: product?.category || first?.category || DEFAULT_CATEGORY_NAME,
      batches,
      // Matched through a batch only (a place, a note): open it, so the hit is
      // visible. The remembered state stays as it is.
      openForSearch: Boolean(q) && batches.length > 1 && !(product?.name ?? first?.name ?? '').toLowerCase().includes(q),
    };
  });

  const catOrder = new Map(state.categories.map((c, idx) => [c.name, idx]));
  const sections = new Map();
  for (const product of products) {
    if (!sections.has(product.category)) sections.set(product.category, []);
    sections.get(product.category).push(product);
  }
  const rank = (name) => catOrder.get(name) ?? state.categories.length;
  const nameOrder = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return [...sections.entries()]
    .sort(([a], [b]) => (rank(a) - rank(b)) || nameOrder(a, b))
    .map(([category, list]) => ({
      key: category,
      label: categoryLabel(category),
      products: list.sort((a, b) => nameOrder(a.name, b.name) || ((a.id ?? 0) - (b.id ?? 0))),
    }));
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

export async function render(container) {
  _container = container;
  state.todayKey = todayKey();
  // Frische Seite: die Chip-Leiste darf beim ersten Zeichnen wieder scrollen.
  _scrolledFilter = null;
  expandedProducts.clear();
  // Deep-Link der Dashboard-Kachel „Läuft bald ab" (`?filter=expired|soon`).
  // Trifft der Chip gerade nichts, setzt die Chip-Leiste ohnehin auf „Alle"
  // zurück - ein veralteter Link endet nie in einer leeren Liste.
  const linkedFilter = pantryFilterFromSearch(window.location.search);
  if (linkedFilter) state.filter = linkedFilter;

  const page = document.createElement('div');
  page.className = 'pantry-page app-page app-page--reading page-measure--narrow';
  page.dataset.composition = 'reading';

  // sr-only: die Küchen-Tab-Leiste benennt das Modul bereits sichtbar -
  // dieselbe Kopf-Grammatik wie Mahlzeiten/Rezepte/Einkauf.
  const title = document.createElement('h1');
  title.className = 'sr-only';
  title.textContent = t('nav.pantry');

  // Eine geteilte Live-Region für die ganze Seite statt einer je Zeile.
  const live = document.createElement('div');
  live.id = 'pantry-live';
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  // Kanonischer Kopf, Gruppen-Variante (siehe .page-toolbar--in-group in
  // layout.css): Suche im __center-Slot, Lagerort-Verwaltung im __actions-Slot -
  // dieselbe Slot-Ordnung wie in den drei Geschwister-Tabs.
  const toolbar = document.createElement('div');
  // Kein --narrow (Re-Critique 2026-09-27, D3): der Kuechenkopf gehoert der
  // Kuechen-Leiste und endet an ihrer Kante wie in den drei Geschwister-Tabs -
  // sonst sprang die angedockte Primaeraktion beim Tabwechsel zwischen
  // Lesemass (x 865) und Leistenkante (x 1288). Test: test-meals.js (D3).
  toolbar.className = 'page-toolbar page-toolbar--in-group';
  // Die Suche IST der Center-Slot (Re-Critique 2026-09-27, D4): Breite und
  // Stelle traegt page-search.css, wie in Dokumenten - kein Wrapper.
  toolbar.insertAdjacentHTML('beforeend', `
    ${renderPageSearch({
      id: 'pantry-search',
      // Label und Placeholder aus demselben Key: „Vorrat durchsuchen" benennt
      // das Feld vollständig, wie in notes/contacts/documents. Ein eigener
      // Label-Key wäre ein Schlüssel über 23 Locales ohne zusätzliche Aussage.
      label: t('pantry.searchPlaceholder'),
      placeholder: t('pantry.searchPlaceholder'),
      value: state.query,
      clearLabel: t('common.searchClear'),
      // FELD STATT LUPE AUCH MOBIL (R20, Re-Critique 2026-10-17 a2 P2-4):
      // die Zeile unter der Kuechen-Leiste trug nur Lupe und Ortsnadel, 65px
      // fuer zwei Icons. Wie bei den Rezepten (R19) fuellt das Feld die Zeile,
      // die Lagerorte bleiben daneben.
      className: 'pantry-search page-toolbar__center page-search--field',
    })}
    ${readOnly() ? '' : `<div class="page-toolbar__actions">
      ${pageToolsMenuHtml({
        id: 'pantry-tools-menu',
        label: t('common.moreActions'),
        // KUECHENKOPF (Kopfregel mobil, 2026-09-26): die Verwaltung steht im
        // EINEN Werkzeugmenue. Mit einem einzigen Eintrag wird daraus der
        // direkte Knopf (pageToolsMenuHtml, R16): "Lagerorte verwalten" mit
        // map-pin wie im Inventar - "archive" war dasselbe Zeichen wie der
        // Vorrat-Tab darueber (A4, P3). Kommt ein zweiter Eintrag dazu, ist es
        // von selbst wieder das Menue.
        // Regel 7 in utils/module-access.js: der AUFRUFER nimmt den Ausloeser
        // weg. Bei `pantry: read` endete jede Handlung im Verwalter (anlegen,
        // umbenennen, sortieren, loeschen) im 403.
        items: [{ action: 'manage-locations', label: t('pantry.manageLocations'), icon: 'map-pin' }],
      })}
    </div>`}`);

  // DIE CHIPREIHE STEHT IM SCROLLPORT (Kopfregel mobil, Regel 3): als erstes
  // Kind von #pantry-list scrollt sie mit der Liste weg, statt dauerhaft 60px
  // ueber dem Port zu belegen (A8: fix bis y181). renderList() ersetzt nur,
  // was HINTER ihr steht.
  const filters = document.createElement('div');
  filters.className = 'page-chip-row pantry-filters';
  filters.id = 'pantry-filters';
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', t('common.filters'));
  filters.hidden = true;

  // Hier stand der Slot für die Sammelaktions-Leiste. Sie ist seit Etappe 5
  // eine Pille in der unteren Shell-Zone (utils/bulk-pill.js) und braucht in
  // dieser Seite gar keinen Platz mehr - weder im Scroller, wo sie bis
  // 2026-07-30 wegscrollte, noch darüber, wo sie eine Zeile kostete.

  const list = document.createElement('div');
  list.className = 'list-scroller page-scrollport pantry-list';
  list.dataset.scrollPort = 'pantry';
  list.id = 'pantry-list';
  list.setAttribute('aria-busy', 'true');
  list.append(filters);
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));

  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.id = 'fab-new-pantry-item';
  fab.setAttribute('aria-label', t('pantry.addItem'));
  fab.dataset.dockLabel = t('newLabel.pantry');
  fab.insertAdjacentHTML('beforeend', '<i data-lucide="plus" aria-hidden="true"></i>');

  // DAS NEBENPANEL „IM BLICK" (Re-Critique 2026-09-27, A4 P1 / R10 L4): am
  // Desktop steht neben der Liste fest, was bald ablaeuft oder knapp wird -
  // dieselben drei Fragen wie die Filterchips, nur ohne dass man sie stellen
  // muss. Unter der Schwelle blendet es CSS aus; dort tragen die Chips die
  // Frage. Liste und Panel teilen einen Koerper, weil ein Container sich
  // selbst nicht umstellen kann (die Abfrage steht an `.pantry-page`).
  const body = document.createElement('div');
  body.className = 'pantry-body';
  const watch = document.createElement('aside');
  watch.className = 'pantry-watch';
  watch.id = 'pantry-watch';
  watch.setAttribute('aria-label', t('pantry.watchLabel'));
  watch.hidden = true;
  body.append(list, watch);

  page.append(title, live, toolbar, body, fab);
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/pantry');

  if (window.lucide) window.lucide.createIcons({ el: container });

  // Geteilter Baustein statt eigenem Input (utils/page-search.js): Lupe,
  // Leeren-Knopf, `<label for>` und die mobilen Eingabe-Attribute liegen dort
  // einmal. Der Vorrat baute sie privat nach und hatte keines davon; die
  // Beschriftung trug der Placeholder, der beim Tippen verschwindet.
  // Die Debounce (Default 200ms) ist hier der eigentliche Gewinn: renderList()
  // zeichnet die gesamte Liste neu, vorher bei jedem Tastendruck.
  // Handle im Modul halten: der Zurücksetzen-Pfad des Treffer-Leerzustands
  // braucht `clear()`, nicht nur `input.value = ''`.
  _search = wirePageSearch(toolbar, {
    id: 'pantry-search',
    onQuery: (value) => {
      state.query = value.trim();
      renderList();
    },
  });

  installPopoverMenus(toolbar);
  toolbar.querySelector('[data-action="manage-locations"]')?.addEventListener('click', openLocationManager);
  fab.addEventListener('click', () => openItemModal('create'));

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderFilters();
    renderList();
  });

  list.addEventListener('click', onListClick);
  // The row menu of a product without batches (its delete) is a popover menu.
  installPopoverMenus(list);
  watch.addEventListener('click', onWatchClick);

  try {
    await loadPantry();
  } catch (err) {
    renderLoadError(list, err);
    return;
  }

  renderFilters();
  renderList();
}

/**
 * Der Vorrat war der einzige Tab mit einem echten Fehlerzustand - und zeigte
 * als Erklärung `[object Object]`, weil die Beschreibung den rohen Servertext
 * durchreichte (Critique P0, 2026-07-30). `mountLoadError()` nimmt jetzt das
 * Fehlerobjekt selbst entgegen und liest daraus nur den Statuscode.
 */
function renderLoadError(list, err) {
  list.removeAttribute('aria-busy');
  mountLoadError(list, {
    title: t('pantry.loadErrorTitle'),
    description: t('common.loadErrorDescription'),
    error: err,
    retryLabel: t('common.retry'),
    onRetry: () => render(_container),
  });
}

/**
 * Filter-Chips. Ein Zustand ohne Treffer bekommt keine Chip: eine Chip, die
 * garantiert auf eine leere Liste führt, ist eine Sackgasse. Bleibt nur „Alle"
 * übrig, entfällt die Zeile ganz - eine einzelne Chip filtert nichts.
 */
/**
 * Zuletzt ins Sichtfeld geholter Filter. Ohne dieses Gedächtnis rief jeder
 * Re-Render `scrollIntoView` auf - und weil `adjustQuantity` die Leiste bei
 * jedem ±-Tap neu zeichnet, riss ein einziger Tap die manuell zurückgescrollte
 * Leiste wieder weg und schob den „Alle"-Ausgang aus dem Bild (Critique P1).
 */
let _scrolledFilter = null;

/**
 * @returns {{ wasReset: boolean }} `wasReset` ist true, wenn der aktive Filter
 * seinen letzten Treffer verloren hat und automatisch auf „Alle" zurückfiel -
 * dann muss der Aufrufer auch die Liste neu zeichnen, sonst zeigen die Chips
 * „Alle" und die Liste weiter die alte gefilterte Teilmenge.
 */
function renderFilters() {
  const bar = _container?.querySelector('#pantry-filters');
  if (!bar) return { wasReset: false };

  // Kanten-Anriss der Chip-Leiste. Sie scrollt horizontal (gemessen 135px
  // Überhang bei 393px, 208px bei 320px), blendet ihre Scrollbar per CSS aus
  // und hatte damit NULL Affordanz: der vierte Filter „Fast leer" begann bei
  // x=394 in einem 393px-Viewport und existierte für Mobilnutzer nicht
  // (Critique 2026-07-30). wireScrollFade setzt die geteilten has-fade-*-
  // Klassen aus filter-chip.css - dasselbe Werkzeug, das das Wochenboard und
  // die Kontakte-Filter schon nutzen. Einmal binden; der MutationObserver
  // deckt die replaceChildren-Rerenders darunter ab.
  if (!bar.dataset.fadeWired) {
    bar.dataset.fadeWired = 'true';
    wireScrollFade(bar);
  }

  const shown = state.items.map(withIntent);
  const counts = pantryFilterCounts(shown, state.todayKey);
  const active = PANTRY_FILTERS.filter((key) => counts[key] > 0);
  const places = placeChips(shown);
  const ids = [...active, ...places.map((chip) => chip.id)];

  // Der aktive Filter hat gerade seinen letzten Treffer verloren → zurück auf Alle.
  const previousFilter = state.filter;
  if (state.filter !== 'all' && !ids.includes(state.filter)) state.filter = 'all';
  const wasReset = state.filter !== previousFilter;

  // replaceChildren zerstört den fokussierten Chip; ohne Rettung landet der
  // Tastatur-Fokus auf <body> und der Tab-Weg beginnt wieder ganz oben.
  const hadFocus = bar.contains(document.activeElement);

  bar.replaceChildren();
  if (!ids.length || !state.items.length) {
    bar.hidden = true;
    return { wasReset };
  }
  bar.hidden = false;

  const labels = {
    expired: { key: 'pantry.filterExpired', icon: 'circle-alert' },
    soon: { key: 'pantry.filterSoon', icon: 'clock' },
    low: { key: 'pantry.filterLow', icon: 'package-open' },
  };

  const chips = [{ id: 'all', label: t('pantry.filterAll'), icon: 'boxes', count: null }];
  for (const key of active) {
    chips.push({ id: key, label: t(labels[key].key), icon: labels[key].icon, count: counts[key] });
  }
  chips.push(...places);

  bar.insertAdjacentHTML('beforeend', chips.map((chip) => `
    <button type="button" class="filter-chip filter-chip--sm${chip.id === state.filter ? ' filter-chip--active' : ''}"
            data-filter="${esc(chip.id)}" aria-pressed="${chip.id === state.filter}">
      <i data-lucide="${esc(chip.icon)}" class="icon-md" aria-hidden="true"></i>
      <span>${esc(chip.label)}</span>
      ${chip.count != null ? `<span class="filter-chip__count">${chip.count}</span>` : ''}
    </button>`).join(''));

  if (window.lucide) window.lucide.createIcons({ el: bar });

  const activeChip = bar.querySelector('.filter-chip--active');
  if (hadFocus) activeChip?.focus({ preventScroll: true });

  // Die Chip-Leiste scrollt horizontal; ein aktiver Chip außerhalb des
  // Sichtfelds nimmt der Liste ihre wichtigste Erklärung ("warum sehe ich nur
  // drei Artikel?"). Aber NUR beim echten Wechsel - sonst kämpft jeder ±-Tap
  // gegen die Scrollposition, die der Nutzer gerade selbst gesetzt hat.
  if (_scrolledFilter !== state.filter) {
    activeChip?.scrollIntoView({ inline: 'center', block: 'nearest' });
    _scrolledFilter = state.filter;
  }

  return { wasReset };
}

/**
 * One chip per storage location that holds a batch (#1448): grouped by
 * category, the page no longer answers "what is in the freezer?" at a glance,
 * so the place gets a direct way in. Same chips as expired, soon and low, in
 * the same single-select bar: a tap on a place replaces a status filter, the
 * search narrows either. In the order of the locations (`sort_order`, as the
 * server sends them), with the number of batches there. Every place that holds
 * a batch gets its chip, also when it is the only one (as asked on #2085); no
 * chip for a place without a batch (a dead end), and batches without a place
 * get none either.
 */
function placeChips(items) {
  const counts = new Map();
  for (const item of items) {
    if (item.location_id != null) counts.set(item.location_id, (counts.get(item.location_id) ?? 0) + 1);
  }
  return state.locations
    .filter((loc) => counts.has(loc.id))
    .map((loc) => ({ id: `place:${loc.id}`, label: locationLabel(loc.name), icon: loc.icon || 'map-pin', count: counts.get(loc.id) }));
}

/**
 * Sammelaktion des „Fast leer"-Filters, seit Etappe 5 als Pille in der unteren
 * Shell-Zone (utils/bulk-pill.js) statt als Block über der Liste. Sie lag davor
 * schon zweimal falsch: zuerst als letztes Element der Chip-Leiste (hinter dem
 * horizontalen Scroll, faktisch unsichtbar), dann als eigene Zeile darüber, die
 * dem Einkauf gemessene 103px Listenfläche kostete.
 *
 * DAS LABEL IST DIE ZAHL, NICHT DIE ERKLÄRUNG. Es stand hier „Diese Artikel
 * sind aufgebraucht oder unter dem Mindestbestand." - ein Satz, den der aktive
 * Filterchip („Fast leer") daneben schon sagt, und der auf einer einzeiligen
 * Fläche nichts als eine Ellipse hinterlässt. Was die Pille beitragen muss,
 * ist der Umfang von „Alles": worauf der Knopf wirkt. Dieselbe Antwort gibt der
 * Einkauf mit „3 Artikel abgehakt".
 *
 * UND BEI 320px IST GENAU DIESER UMFANG WEG (Etappe 7, 2026-08-13). Dort fällt
 * das Subjekt weg - gemessen verlangt „10 Artikel fast leer" 116,2px, frei
 * bleiben neben der Kapsel 86,9 von 264px Innenbreite. Übrig steht dann „Alles
 * auf die Einkaufsliste" allein auf einer dunklen Fläche: ein Quantor ohne
 * Bezugswort, lesbar als „der ganze Vorrat" statt als die zehn Artikel des
 * aktiven Filters.
 *
 * DIE GEFAHR IST EINE ANDERE ALS IM EINKAUF, DIE LÜCKE DIESELBE. Dort trägt die
 * Löschen-Kapsel die Marke, weil ein fehlendes Objekt vor einer nicht
 * rückfragenden Löschung teuer ist; hier ist die Aktion harmlos und trotzdem
 * mehrdeutig - „In den Vorrat" wäre es nicht, „Alles" ist es. Gemessen misst
 * die Kapsel mit Marke rund 194 von 264px, die Pille bleibt einzeilig.
 *
 * Die Zahl ist dieselbe, die das Subjekt nennt: `visibleItems()` ist der
 * gefilterte UND gesuchte Satz, und `sendToShopping` bekommt genau ihn.
 */
function renderBulkBar() {
  const items = visibleItems();
  // Die Pille traegt genau EINE Aktion, und die schreibt in den EINKAUF
  // (#1265): ohne Schreibrecht dort endete sie im 403 - also keine Pille.
  if (state.filter !== 'low' || !state.items.length || !items.length || !mayTransferPantryToShopping()) {
    clearBulkPill();
    return;
  }
  setBulkPill({
    label: t('pantry.bulkPillLabel', { count: items.length }),
    actions: [{
      label: t('pantry.toShoppingAll'),
      count: items.length,
      onClick: (btn) => sendToShopping(visibleItems(), btn),
    }],
  });
}

/**
 * Darf dieses Konto in den Vorrat schreiben? Regel 1 in utils/module-access.js.
 * Als Funktion, damit jedes Neuzeichnen neu fragt.
 *
 * WAS BEI `read` BLEIBT: Suche, Filterchips, das Nebenpanel, die Zeile mit
 * Menge, MHD und Badges als ZEICHEN - und der Tipp auf sie, der dann die
 * Leseansicht oeffnet (Regel 9). WAS GEHT: der Stepper, der Bearbeiten-Dialog
 * samt Loeschen, das Anlegen (FAB und Leerzustand), die Lagerort-Verwaltung und
 * der Loesch-Wisch (Regel 3). DER WARENKORB FOLGT NICHT DIESEM RECHT: er
 * schreibt in den Einkauf und fragt `mayTransferPantryToShopping()` (Regel 8) -
 * mit `pantry: read` und `shopping: write` bleibt er also stehen, und der
 * Server nimmt den Uebertrag an.
 *
 * KEIN WANDTABLETT: ein Display fuehrt `pantry` nicht in seiner Scope-Liste
 * (server/display-scopes.js) und erreicht diese Seite nicht; ein
 * `actingAsDisplay()` davor braucht es hier nicht.
 */
function readOnly() {
  return !mayWritePath('/pantry');
}

/**
 * Die `data-action`s der Liste, die NICHT in den Vorrat schreiben - eine
 * Positivliste wie in shopping.js: eine morgen ergaenzte Schreib-Aktion ist bei
 * `read` zu, bis sie hier ausdruecklich steht. `to-shopping` schreibt in den
 * Einkauf und traegt seinen eigenen Riegel (`sendToShopping`).
 */
const READ_SAFE_ACTIONS = new Set(['details', 'to-shopping', 'toggle-product', 'to-shopping-product']);

const PANTRY_ROW = '.pantry-swipe[data-swipe-id]';

/* `motion: true` setzt, wer die DATEN geaendert hat (Artikel angelegt,
 * gespeichert, geloescht): dann zieht die neue Zeile auf, und was dadurch die
 * Stelle wechselt, gleitet (utils/list-motion.js). Filter und Suche zeichnen
 * ohne Bewegung neu - dort wechselt die Frage, nicht die Liste, und jede
 * hinzukommende Zeile einzeln aufzuziehen waere Unruhe. */
function renderList({ motion = false } = {}) {
  const list = _container?.querySelector('#pantry-list');
  if (!list) return;
  if (motion) redrawList(list, () => drawList(list), { selector: PANTRY_ROW, keyAttr: 'data-swipe-id' });
  else drawList(list);
}

function drawList(list) {
  list.removeAttribute('aria-busy');
  // Die Chipreihe ist das erste Kind des Ports und ueberlebt den Neuaufbau.
  const chipRow = list.querySelector(':scope > #pantry-filters');
  // Taking the row out and back in resets its scroll position, the one
  // renderFilters() has just set to show the active chip. With a chip per place
  // the active one often sits beyond the edge at 375px (#1448), so keep it.
  const chipScroll = chipRow?.scrollLeft ?? 0;
  list.replaceChildren(...(chipRow ? [chipRow] : []));
  if (chipRow && chipScroll) chipRow.scrollLeft = chipScroll;
  renderBulkBar();
  renderWatch();

  // A product outlives its last batch (#1448): with products left, the page is
  // not empty, it shows them as out of stock.
  if (!state.items.length && !state.products.length) {
    list.appendChild(emptyStateEl());
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  const items = visibleItems();
  const sections = state.filter === 'all' ? productSections(items) : null;
  const shown = sections ? sections.reduce((n, s) => n + s.products.length, 0) : items.length;
  // Filtern und Suchen ändern die Liste, ohne dass sich der Fokus bewegt -
  // ohne Ansage bleibt die neue Trefferzahl für Screenreader unsichtbar.
  if (state.filter !== 'all' || state.query) {
    announce(t('pantry.resultCount', { count: shown }));
  }

  if (!shown) {
    // Dieselbe .empty-state-Grammatik wie der leere Vorrat: davor stand hier ein
    // nackter Satz in einer großen Leere, direkt neben einem reich gestalteten
    // Nachbarzustand - und ohne Ausweg (Critique P2).
    list.appendChild(noResultsEl());
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  // Die Sammelaktions-Leiste hängt jetzt im Slot ÜBER dem Scroller
  // (renderBulkBar oben), nicht mehr als erstes Kind der Liste - dort scrollte
  // sie weg, obwohl sie die ganze gefilterte Liste betrifft.

  const groups = sections ?? [{ key: 'flat', label: null, items: flatItems(items) }];
  for (const group of groups) {
    const section = document.createElement('section');
    // Geteilte Gruppen-Grammatik (styles/list-row.css): die Gruppe trägt die
    // weiße Fläche, die Zeilen darin nur Trennlinien.
    section.className = 'list-group pantry-group';

    if (group.label) {
      const heading = document.createElement('h2');
      heading.className = 'list-group__title';
      const name = document.createElement('span');
      name.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'list-group__count';
      count.textContent = String(group.products.length);
      heading.append(name, count);
      section.appendChild(heading);
    }

    const rows = document.createElement('ul');
    rows.className = 'row-carrier pantry-rows';
    if (group.products) {
      for (const product of group.products) rows.appendChild(productEl(product));
    } else {
      const byProduct = batchesByProduct();
      for (const item of group.items) rows.appendChild(rowEl(withIntent(item), rowOptions(item, byProduct)));
    }
    section.appendChild(rows);
    list.appendChild(section);
  }

  wirePantrySwipe(list);
  if (window.lucide) window.lucide.createIcons({ el: list });
}

// --------------------------------------------------------
// Nebenpanel „Im Blick" (Desktop)
// --------------------------------------------------------

// NUR ZEITKRITISCHES (Re-Critique 2026-09-28, P7 / A4 P2-6). Hier stand auch
// "Fast leer": dieselbe Aussage stand damit dreimal da (Zeilen-Badge, Chip mit
// Zaehler, Panel), 14 von 21 Artikeln rechts ein zweites Mal, und "Fast leer
// 10" uebertoente die Fristen. Das Panel beantwortet jetzt nur, was nicht
// warten kann; "Fast leer" bleibt Chip plus Warenkorb an der Zeile.
const WATCH_SECTIONS = [
  { key: 'expired', label: 'pantry.filterExpired', tone: 'danger' },
  { key: 'soon', label: 'pantry.filterSoon', tone: 'warning' },
];

/**
 * Die drei Abschnitte des Panels, mit genau der Zuordnung der Filterchips
 * (`matchesPantryFilter`) - ein Artikel steht im Panel, wenn und weil ihn der
 * gleichnamige Chip traefe. Unabhaengig von Suche und aktivem Filter: das
 * Panel beantwortet „was braucht Aufmerksamkeit", nicht „was zeigt die Liste".
 * Sortiert wie die flache Filterliste: Ablauf nach Datum, Bestand nach Menge.
 */
function pantryWatchGroups(items, today) {
  return WATCH_SECTIONS.map((section) => {
    const rows = items.filter((item) => matchesPantryFilter(item, section.key, today));
    rows.sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
    return { ...section, items: rows };
  }).filter((section) => section.items.length);
}

function watchRowEl(item, section) {
  const li = document.createElement('li');
  li.className = 'list-row pantry-watch__row';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'list-row__main list-row__main--interactive';
  main.dataset.watchId = String(item.id);
  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = item.name;
  const meta = document.createElement('span');
  meta.className = 'list-row__meta';
  // Der Satz der Zeile („Laeuft morgen ab"), in der Tinte seiner Dringlichkeit.
  const expiry = expiryBadge(item);
  const lead = document.createElement('span');
  lead.className = `pantry-watch__due pantry-watch__due--${expiry ? expiry.tone : section.tone}`;
  lead.textContent = expiry ? expiry.text : quantityText(item);
  meta.appendChild(lead);
  if (item.location_name) meta.append(` · ${locationLabel(item.location_name)}`);
  main.append(name, meta);
  li.appendChild(main);
  return li;
}

/** Zeichnet das Panel neu; ohne Artikel bleibt es verborgen. */
function renderWatch() {
  const watch = _container?.querySelector('#pantry-watch');
  if (!watch) return;
  watch.replaceChildren();
  if (!state.items.length) {
    watch.hidden = true;
    return;
  }
  watch.hidden = false;
  const groups = pantryWatchGroups(state.items.map(withIntent), state.todayKey);
  if (!groups.length) {
    const calm = document.createElement('p');
    calm.className = 'pantry-watch__empty';
    calm.textContent = t('pantry.watchEmpty');
    watch.appendChild(calm);
    return;
  }
  for (const section of groups) {
    const el = document.createElement('section');
    el.className = 'list-group pantry-watch__group';
    const heading = document.createElement('h2');
    heading.className = 'list-group__title';
    const label = document.createElement('span');
    label.textContent = t(section.label);
    const count = document.createElement('span');
    count.className = 'list-group__count';
    count.textContent = String(section.items.length);
    heading.append(label, count);
    const rows = document.createElement('ul');
    rows.className = 'row-carrier';
    for (const item of section.items) rows.appendChild(watchRowEl(item, section));
    el.append(heading, rows);
    watch.appendChild(el);
  }
  if (window.lucide) window.lucide.createIcons({ el: watch });
}

/** Eine Panelzeile oeffnet denselben Dialog wie ihre Zeile in der Liste. */
function onWatchClick(e) {
  const btn = e.target.closest('[data-watch-id]');
  if (!btn) return;
  const item = state.items.find((i) => i.id === Number(btn.dataset.watchId));
  if (item) openItemModal('edit', item);
}

/**
 * Kein Treffer für Suche und/oder Filter. Benennt beide Ursachen, statt nur die
 * Suche zu erwähnen: war zusätzlich ein Filter aktiv, blieb er vorher unsichtbar
 * und der Nutzer suchte den Fehler beim Suchbegriff.
 */
function noResultsEl() {
  // Der geteilte Leerzustand einer leeren Suche (R19): Begriff und Filter als
  // Chips, EIN Knopf hebt beide auf.
  const place = placeFilterId();
  const placeName = state.locations.find((loc) => loc.id === place)?.name;
  const filters = state.filter === 'all' ? []
    : place != null ? [placeName ? locationLabel(placeName) : t('pantry.unlocated')]
      : [t({ expired: 'pantry.filterExpired', soon: 'pantry.filterSoon', low: 'pantry.filterLow' }[state.filter])];
  return searchEmptyEl({
    query: state.query,
    filters,
    onReset: () => {
      state.query = '';
      state.filter = 'all';
      // clear() versteckt zugleich den Leeren-Knopf des geteilten Suchfelds;
      // ein blankes `value = ''` ließe ihn über dem leeren Feld stehen.
      _search?.clear();
      renderFilters();
      renderList();
      _search?.input.focus();
    },
  });
}

function emptyStateEl() {
  // Bei `read` nur der Zustand (Regel 9): Beschreibung („Trage ein ...") und
  // Hinweis (Artikel aus dem Einkauf uebernehmen) laden beide zu einer
  // Handlung ein, die es dann nicht gibt.
  const ro = readOnly();
  return emptyStateComponentEl({
    icon: 'archive',
    title: t('pantry.emptyTitle'),
    description: ro ? undefined : t('pantry.emptyDescription'),
    hint: ro ? undefined : t('emptyHint.pantry'),
    action: ro ? null : {
      label: t('pantry.emptyAction'),
      icon: 'plus',
      onClick: () => openItemModal('create'),
    },
  });
}

/** The place of a batch as the row names it. */
function placeText(item) {
  return item.location_name ? locationLabel(item.location_name) : t('pantry.unlocated');
}

/**
 * How a batch row is drawn, from the state alone, so a row rebuilt after a step
 * (refreshRowQuantity) reads like the one it replaces. `batch`: the row stands
 * under its product (several batches, no filter). `byDate`: all batches of the
 * product share one place, which the product row already names; the batch is
 * then titled by its best-before date, otherwise by its place. `total`: the
 * product's total, when it has several batches.
 */
function rowOptions(item, byProduct = batchesByProduct()) {
  const siblings = byProduct.get(productKeyOf(item)) ?? [item];
  const several = siblings.length > 1;
  const batch = several && state.filter === 'all';
  return {
    batch,
    byDate: batch && new Set(siblings.map((b) => b.location_id ?? 'none')).size === 1,
    total: several ? productTotal(siblings) : null,
  };
}

/** The title of a batch under its product: its date when the place is the same for all. */
function batchTitle(item, opts) {
  if (!opts.byDate) return placeText(item);
  return item.expires_on
    ? t('pantry.bestBefore', { date: dateText(item.expires_on) })
    : t('pantry.noBestBefore');
}

/** Eine Vorratszeile (eine Charge). */
function rowEl(item, opts = rowOptions(item)) {
  const status = pantryItemStatus(item, state.todayKey);
  const place = placeText(item);
  // Under its product a batch is told apart by its place; the controls name
  // both, or "Increase: Milk" would be said for every batch alike.
  const controlName = opts.batch ? `${item.name}, ${batchTitle(item, opts)}` : item.name;

  // DIE ZEILE LAESST SICH WEGWISCHEN (R16 Schritt 2b, Kuechenregel in
  // DESIGN.md: Loeschen = Wisch mobil + ein fester Ort am Desktop). Der Vorrat
  // war der letzte Kuechen-Reiter ohne die Geste; Loeschen stand nur im
  // Dialogfuss. Das `li` ist die Buehne (`.swipe-row`) mit dem Reveal-Panel am
  // Zeilenende, die Zeile selbst liegt als `div` darin. Nur EINE Seite: am
  // Zeilenanfang gibt es im Vorrat nichts Positives zu erledigen. Stepper und
  // Warenkorb sind Ausnahmezone (wirePantrySwipe, `ignore`) - wer dort tippt
  // und dabei rutscht, loescht nichts.
  const ro = readOnly();
  const wrap = document.createElement('li');
  // `.swipe-row--static`: ohne Geste auch kein Wisch-Chevron (layout.css).
  wrap.className = ro ? 'swipe-row swipe-row--static pantry-swipe' : 'swipe-row pantry-swipe';
  wrap.dataset.swipeId = String(item.id);
  // Nur-lesen: die Buehne bleibt (Zeilenschluessel fuer Neuzeichnen und
  // Auffrischung), das Loeschen-Panel entfaellt - es verspraeche ein DELETE,
  // das im 403 endet (Regel 3 in utils/module-access.js).
  if (!ro) {
    wrap.insertAdjacentHTML('beforeend', `
    <div class="swipe-reveal swipe-reveal--delete swipe-reveal--trailing" aria-hidden="true">
      <i data-lucide="trash-2" class="icon-md"></i>
      <span>${esc(t('common.delete'))}</span>
    </div>`);
  }

  const li = document.createElement('div');
  // Geteilte Zeilen-Grammatik (styles/list-row.css). Ohne --reserve-end: der
  // Warenkorb sitzt nicht mehr an der Zeilenkante, sondern in einem festen Slot
  // am Anfang der Bedienzone (siehe unten).
  li.className = opts.batch ? 'list-row pantry-row pantry-row--batch' : 'list-row pantry-row';
  li.dataset.id = String(item.id);
  li.dataset.productKey = productKeyOf(item);
  if (status.out) li.classList.add('pantry-row--out');

  // Klickfläche: öffnet das Bearbeiten-Formular. Die Stepper-Buttons daneben
  // sind eigene Stops und dürfen nicht durchschlagen.
  // BEWUSST kein aria-label: es hätte den Namen aus dem Inhalt überschrieben
  // und damit genau die Information verschluckt, die sehende Nutzer auf einen
  // Blick bekommen - „Vor 2 Tagen abgelaufen", „Fast leer", das MHD. Ein
  // Screenreader hörte nur „Bearbeiten: Milch" (Critique P1, WCAG 1.3.1/4.1.2).
  // Stattdessen trägt der Inhalt den Namen, und die Aktion kommt als sr-only
  // Zusatz ans Ende.
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'list-row__main list-row__main--interactive pantry-row__main';
  // Bei `read` oeffnet derselbe Tipp die Leseansicht (Regel 9) - unter einem
  // eigenen Namen, damit die Positivliste im Handler ihn durchlaesst.
  main.dataset.action = ro ? 'details' : 'edit';

  // Name und Status in EINER Zeile: das Badge qualifiziert den Artikel, es ist
  // keine eigene Information. Auf einer eigenen Zeile wuchs jede betroffene
  // Zeile um ~25px, während rechts neben dem Namen Platz frei blieb.
  const headline = document.createElement('span');
  headline.className = 'pantry-row__headline';

  const name = document.createElement('span');
  name.className = 'list-row__name';
  if (opts.batch) {
    // The product row above says the name once; a screen reader that lands on
    // the batch still hears whose batch it is.
    const product = document.createElement('span');
    product.className = 'sr-only';
    product.textContent = `${item.name}: `;
    name.append(product, batchTitle(item, opts));
  } else {
    name.textContent = item.name;
  }
  headline.appendChild(name);

  // DIE BADGES SIND EIN PAAR, ALSO EIN KNOTEN (Critique 2026-08-13).
  // Ohne ihn entscheidet die Restbreite, WIE VIELE von ihnen umbrechen: gemessen
  // stand „Vollmilch" mit „Läuft heute ab" in Zeile zwei und „Fast leer" in
  // Zeile drei, also 109,5px gegen 86,3px derselben Liste mit zwei Badges
  // nebeneinander. Was zusammen gelesen wird, bricht zusammen um.
  const badges = [expiryBadge(item), stockBadge(item)].filter(Boolean);
  if (badges.length) {
    const wrap = document.createElement('span');
    wrap.className = 'pantry-row__badges';
    for (const badge of badges) {
      const el = document.createElement('span');
      el.className = `pantry-badge pantry-badge--${badge.tone}`;
      el.textContent = badge.text;
      wrap.appendChild(el);
    }
    headline.appendChild(wrap);
  }
  main.appendChild(headline);

  // Meta-Zeile trägt nur, was hier orientiert. Die Kategorie steht bewusst NICHT
  // darin: sie ordnet die Einkaufsliste nach Supermarkt-Gängen, für "was habe
  // ich und wie lange noch" sagt sie nichts - und als dritter Teil kürzte sie
  // das MHD weg ("MHD 24.02.2027 · Ba…"). Sie bleibt im Formular sichtbar.
  // Das MHD steht VOR dem Lagerort: die Zeile ellipsiert am Ende, und bei einem
  // langen Ortsnamen fiel sonst genau das Kerndatum weg - dieselbe Trunkierung,
  // gegen die die Kategorie hier schon gewichen ist (Critique, Riley-Fund).
  // DIE MENGE FÜHRT DIE META-ZEILE, sie steht nicht mehr zwischen den Knöpfen.
  //
  // Bis zum 12.08.2026 sass sie im Stepper und rückte unter 30rem Trägerbreite
  // ÜBER die beiden Knöpfe (`flex-wrap` an .pantry-stepper). Das gab dem Namen
  // die Breite, die er braucht, kostete aber rund 25px Höhe in JEDER Zeile:
  // gemessen 89,4px bei 390x844, die höchste Zeile der App nach dem Budget.
  //
  // Der Umzug kostet KEINEN Pixel Breite. Der umgebrochene Stepper war bereits
  // exakt so breit wie seine Knopfzeile (100px), und ohne den Wert ist er es
  // weiterhin - die Bedienzone bleibt gleich breit, der Name behält seine
  // 168px. Was wegfällt, ist nur die zweite Zeile.
  //
  // UND DER EINKAUF MACHT ES SEIT JEHER SO: `.list-row__meta` trägt dort
  // `item.quantity`. Zwei Tabs derselben Küchenleiste schrieben dieselbe Angabe
  // an zwei Orte.
  //
  // Sie steht VORN, obwohl das MHD dahinter dadurch seitlich wandert, wenn sich
  // die Menge ändert: die Menge ist die Frage, die eine Vorratsliste
  // beantwortet, und die Zeile ellipsiert am Ende. Hinten stünde sie genau
  // dort, wo bei langem Ortsnamen gekappt wird.
  const meta = document.createElement('span');
  meta.className = 'list-row__meta';
  const quantity = document.createElement('span');
  quantity.className = 'pantry-row__quantity';
  quantity.textContent = quantityText(item);
  meta.appendChild(quantity);

  /* MHD und Lagerort sind EIGENE Knoten, keine zusammengefügte Zeichenkette.
   *
   * Grund ist die Regel gleich daneben (pantry.css): auf einer schmalen Zeile
   * MIT Warenkorb bleiben 168px statt 220px, und dort passt das MHD nicht mehr.
   * Weggelassen wird es dann, nicht abgeschnitten - ein halbes Datum
   * („MHD 23.12….") ist keine Angabe, sondern sieht aus wie ein Fehler. Damit
   * CSS das entscheiden kann, muss es ein eigenes Element sein.
   *
   * Das Trennzeichen steht IM Knoten, sonst bliebe es beim Weglassen als
   * einsames „·" zurück. */
  // Titled by its date (one place for all batches), the meta line has only the
  // quantity: the date stands in the title, the place in the product row.
  if (item.expires_on && opts.batch && !opts.byDate) {
    // UNDER ITS PRODUCT THE DATE IS WHAT TELLS TWO BATCHES OF ONE PLACE APART,
    // so it may not be dropped on a narrow row like `.pantry-row__expiry` (two
    // "Fridge" rows would be left that differ in nothing). It stands as the
    // bare date, which fits beside cart and stepper at 375px; the words come
    // along for screen readers.
    const date = document.createElement('span');
    date.className = 'pantry-row__date';
    const shown = document.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    shown.textContent = ` · ${dateText(item.expires_on)}`;
    const spoken = document.createElement('span');
    spoken.className = 'sr-only';
    spoken.textContent = `, ${t('pantry.bestBefore', { date: dateText(item.expires_on) })}`;
    date.append(shown, spoken);
    meta.appendChild(date);
  } else if (item.expires_on && !opts.batch) {
    const expiry = document.createElement('span');
    expiry.className = 'pantry-row__expiry';
    expiry.textContent = ` · ${t('pantry.bestBefore', { date: dateText(item.expires_on) })}`;
    meta.appendChild(expiry);
  }
  // Seit die Seite nach Produkten statt nach Lagerort gliedert (#1448), traegt
  // jede Zeile ihren Ort selbst - wie vorher nur im gefilterten Modus. Unter
  // ihrem Produkt steht er schon als Name der Zeile, unter einem Ort-Chip im Chip.
  if (!opts.batch && placeFilterId() == null) {
    const placeEl = document.createElement('span');
    placeEl.className = 'pantry-row__place';
    placeEl.textContent = ` · ${place}`;
    meta.appendChild(placeEl);
  }
  // In the flat filter list a batch of a product with several batches says the
  // product's total: "1 l" alone does not tell that 3 more are in the cellar.
  if (!opts.batch && opts.total != null) {
    const total = document.createElement('span');
    total.className = 'pantry-row__total';
    total.textContent = ` · ${productTotalText(opts.total, item.unit)}`;
    meta.appendChild(total);
  }
  main.appendChild(meta);

  // Was der Button tut - nur für Screenreader, am Ende des Namens. Bei `read`
  // waere „Bearbeiten" ein Versprechen, das der Tipp nicht haelt; dort sagt
  // der geteilte Zusatz, dass die Zeile ihre Details zeigt (#1682).
  if (ro) {
    main.appendChild(readRowHintEl());
  } else {
    const action = document.createElement('span');
    action.className = 'sr-only';
    action.textContent = t('common.edit');
    main.appendChild(action);
  }

  // Warenkorb und Stepper bilden EINE Gruppe: als getrennte Flex-Kinder brach
  // nur der Stepper um und der Warenkorb blieb allein oben rechts stehen - der
  // Umbruch sah nach Fehler aus statt nach Absicht. Als Gruppe wandert die
  // ganze Bedienung geschlossen in die zweite Zeile.
  //
  // Die Gruppe steht VOR dem Namen - im DOM wie visuell. Rechts unten sitzt der
  // FAB, und dort lagen zuvor sämtliche „+"-Buttons in seiner Spalte: ein
  // Fehltap öffnete das Anlegen-Formular statt die Menge zu erhöhen (Critique).
  // Nur die CSS-Reihenfolge zu drehen hätte Lese- und Fokusabfolge entkoppelt,
  // deshalb wandert der Knoten selbst. Jeder Button trägt den Artikelnamen im
  // Label, die Tab-Folge bleibt also auch ohne vorangehenden Namen eindeutig.
  const actions = document.createElement('div');
  actions.className = 'list-row__actions';

  // Der Warenkorb sitzt am ANFANG der Bedienzone, nicht an der rechten
  // Zeilenkante.
  //
  // Vorher lag er dort absolut positioniert - und damit genau in der Ecke, die
  // der FAB besetzt: gemessen 87% Überdeckung im Ruhezustand bei 393px, der
  // höchste Einzelwert des Moduls (Critique 2026-07-30). Ein Fehltap dort schickt
  // einen Artikel auf die Einkaufsliste des ganzen Haushalts.
  //
  // Was jetzt in der FAB-Ecke liegt, ist der Stepper-„+". Ein abgefangener Tap
  // dort ändert keine Daten, sondern öffnet das Anlegen-Formular, das man mit Esc
  // schließt. Der Tausch ist bewusst: dieselbe Restüberdeckung, aber auf der
  // harmlosen Aktion statt auf der folgenreichen.
  //
  // Der Slot ist IMMER da, auch ohne Warenkorb. Sonst wäre die Bedienzone in
  // jeder Zeile anders breit und die Minus-Buttons stünden pro Zeile woanders -
  // genau der Grund, aus dem der Knopf ursprünglich an die Zeilenkante wanderte.
  const cartSlot = document.createElement('div');
  cartSlot.className = 'pantry-row__cart-slot';
  // Der Warenkorb schreibt in den EINKAUF, gefragt wird also dessen Recht
  // (#1265, Regel 1 in utils/module-access.js). Der Slot bleibt trotzdem.
  if ((status.out || status.low) && mayTransferPantryToShopping()) cartSlot.appendChild(cartEl(item, controlName));
  actions.appendChild(cartSlot);

  // Nur-lesen: KEIN Stepper (Regel 2). Die Menge steht als Zeichen in der
  // Meta-Zeile; Plus und Minus aenderten sie optimistisch, der PATCH endete im
  // 403, und die Zeile sprang zurueck. Die Bedienzone traegt dann nur noch den
  // Warenkorb-Slot - und entfaellt ganz, wenn auch der Einkauf nicht
  // beschreibbar ist: eine leere Zone naehme dem Namen nur die Breite.
  if (ro) {
    li.appendChild(main);
    if (mayTransferPantryToShopping()) li.appendChild(actions);
    wrap.appendChild(li);
    return wrap;
  }

  // Die Zeichen in --icon-md (R20, Re-Critique 2026-10-17 a2 P3): als
  // --icon-sm (12px, Inline-Marker) standen sie in der 48px-Flaeche wie Staub;
  // 16px ist das Mass jeder Knopf-Glyphe. Die Haut bleibt ruhig (pantry.css).
  const stepper = document.createElement('div');
  stepper.className = 'pantry-stepper';
  const step = pantryUnitStep(item.unit);

  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'pantry-stepper__btn';
  minus.dataset.action = 'decrease';
  minus.disabled = Number(item.quantity) <= 0;
  minus.setAttribute('aria-label', `${t('pantry.decrease')}: ${controlName}`);
  minus.insertAdjacentHTML('beforeend', '<i data-lucide="minus" class="icon-md" aria-hidden="true"></i>');

  // Der Wert steht in der Meta-Zeile (siehe dort). BEWUSST keine eigene
  // Live-Region je Zeile: bei 60 Artikeln wären das 60 Live-Regionen, und
  // Screenreader behandeln eine solche Wolke unzuverlässig. Die Ansage
  // übernimmt die eine geteilte Region der Seite (#pantry-live) - sie ist auch
  // der Grund, aus dem der Wert nicht neben den Knöpfen stehen MUSS, um die
  // Änderung zu melden.

  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'pantry-stepper__btn';
  plus.dataset.action = 'increase';
  plus.setAttribute('aria-label', `${t('pantry.increase')}: ${controlName}`);
  plus.insertAdjacentHTML('beforeend', '<i data-lucide="plus" class="icon-md" aria-hidden="true"></i>');

  stepper.dataset.step = String(step);
  stepper.append(minus, plus);
  actions.appendChild(stepper);

  // Name zuerst, Bedienung danach: eine Vorratsliste wird nach Namen gescannt,
  // nicht nach Zahlen. Vorher las sich die Zeile „− 500 g + Naturjoghurt" und
  // damit gegen die Leserichtung und gegen alle drei Geschwistermodule, die
  // ausnahmslos mit dem Namen führen. Nebeneffekt: die Namenskante steht jetzt
  // von selbst, statt mit der Stepper-Breite zu wandern (Critique 2026-07-29).
  li.append(main, actions);
  wrap.appendChild(li);
  return wrap;
}

/**
 * A product of the stock list (#1448, step 2), in one of three shapes:
 *
 * - ONE BATCH: exactly today's row, with its place in the meta line. Grouping
 *   must not cost the common case anything.
 * - SEVERAL BATCHES: a product row with the total ("4 l in all") and where it
 *   is ("2 places", or "2 batches" in one place), and the batches underneath,
 *   each one today's row named by its place, or by its best-before date when
 *   all of them share one place (the product row names it once). The product
 *   row only opens and closes, the dashboard's overdue group is the pattern (a
 *   button with
 *   `aria-expanded`/`aria-controls`, the region switched in place by
 *   `toggleRegion`, the open state kept for the visit). Its one badge is the
 *   most urgent expiry of its batches, so a collapsed product still says that
 *   a batch has expired. No stepper, no cart, no swipe, no "Running low" on it
 *   yet: a step on a total has no batch to book, and low and out over the
 *   product come with the minimum on the product (step 3).
 * - NO BATCH: the product outlived its last batch. It reads as out of stock,
 *   with the cart that hands its name to Shopping (emptyProductEl).
 */
function productEl(product) {
  if (!product.batches.length) return emptyProductEl(product);
  if (product.batches.length === 1) return rowEl(product.batches[0], { batch: false, total: null });

  const open = expandedProducts.has(product.key) || product.openForSearch;
  const regionId = `pantry-batches-${product.key}`;
  const total = productTotal(product.batches);
  const places = new Set(product.batches.map((b) => b.location_id ?? 'none')).size;

  const li = document.createElement('li');
  li.className = 'pantry-product';
  li.dataset.productKey = product.key;

  const row = document.createElement('div');
  row.className = 'list-row pantry-product__row';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'list-row__main list-row__main--interactive pantry-product__toggle';
  toggle.dataset.action = 'toggle-product';
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.setAttribute('aria-controls', regionId);

  const text = document.createElement('span');
  text.className = 'pantry-product__text';
  // Name and the most urgent expiry in one line, like a batch row: collapsed,
  // the product row is the only place that can say a batch has expired.
  const headline = document.createElement('span');
  headline.className = 'pantry-row__headline';
  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = product.name;
  const badges = document.createElement('span');
  badges.className = 'pantry-row__badges pantry-product__badges';
  fillProductBadge(badges, product.batches);
  headline.append(name, badges);
  const meta = document.createElement('span');
  meta.className = 'list-row__meta';
  const totalEl = document.createElement('span');
  totalEl.className = 'pantry-product__total';
  totalEl.textContent = productTotalText(total, product.unit);
  const where = document.createElement('span');
  where.className = 'pantry-product__where';
  where.textContent = productWhereText(product.batches);
  meta.append(totalEl, where);
  text.append(headline, meta);

  toggle.append(text);
  toggle.insertAdjacentHTML('beforeend',
    `<i data-lucide="chevron-down" class="icon-sm list-group__chevron${open ? '' : ' list-group__chevron--collapsed'}" aria-hidden="true"></i>`);
  row.appendChild(toggle);

  const batches = document.createElement('ul');
  batches.className = 'pantry-batches';
  batches.id = regionId;
  batches.hidden = !open;
  for (const batch of product.batches) batches.appendChild(rowEl(batch, { batch: true, byDate: places === 1, total }));

  li.append(row, batches);
  return li;
}

/**
 * A product without batches: out of stock, with 0 in its unit. Nothing to step
 * and nothing to edit yet (editing a product is step 5); the cart hands its
 * name and category to Shopping without a quantity, like an empty batch without
 * a minimum. The minimum it will show comes in step 3.
 *
 * It can be deleted (brought forward from step 5, only while it has no batch):
 * the same swipe to the row end as a batch on touch, and, since it has no
 * dialog whose footer would be the fixed place, the row's more button with
 * "Delete" (component canon: destructive actions sit behind it). Both with
 * the undo toast of a batch (removeProduct).
 */
function emptyProductEl(product) {
  const deletable = !readOnly() && product.id != null;
  const li = document.createElement('li');
  li.className = deletable
    ? 'swipe-row pantry-swipe pantry-product pantry-product--empty'
    : 'pantry-product pantry-product--empty';
  li.dataset.productKey = product.key;
  if (deletable) {
    // Its own key space: a batch's swipe id is its id, and the ids may meet.
    li.dataset.swipeId = `product-${product.id}`;
    li.insertAdjacentHTML('beforeend', `
    <div class="swipe-reveal swipe-reveal--delete swipe-reveal--trailing" aria-hidden="true">
      <i data-lucide="trash-2" class="icon-md"></i>
      <span>${esc(t('common.delete'))}</span>
    </div>`);
  }

  const row = document.createElement('div');
  row.className = 'list-row pantry-row pantry-row--out';

  const main = document.createElement('div');
  main.className = 'list-row__main pantry-row__main';
  const headline = document.createElement('span');
  headline.className = 'pantry-row__headline';
  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = product.name;
  const badges = document.createElement('span');
  badges.className = 'pantry-row__badges';
  const badge = document.createElement('span');
  badge.className = 'pantry-badge pantry-badge--danger';
  badge.textContent = t('pantry.badgeOut');
  badges.appendChild(badge);
  headline.append(name, badges);
  const meta = document.createElement('span');
  meta.className = 'list-row__meta';
  const quantity = document.createElement('span');
  quantity.className = 'pantry-row__quantity';
  quantity.textContent = quantityText({ quantity: 0, unit: product.unit });
  meta.appendChild(quantity);
  main.append(headline, meta);
  row.appendChild(main);

  // Der Warenkorb schreibt in den EINKAUF: gefragt wird dessen Recht (#1265).
  const cartAllowed = product.id != null && mayTransferPantryToShopping();
  if (cartAllowed || deletable) {
    const actions = document.createElement('div');
    actions.className = 'list-row__actions';
    const cartSlot = document.createElement('div');
    cartSlot.className = 'pantry-row__cart-slot';
    if (cartAllowed) {
      const cart = cartEl(product);
      cart.dataset.action = 'to-shopping-product';
      cart.dataset.productId = String(product.id);
      cartSlot.appendChild(cart);
    }
    actions.appendChild(cartSlot);
    if (deletable) {
      actions.insertAdjacentHTML('beforeend', rowMenuHtml({
        id: `pantry-product-menu-${product.id}`,
        label: t('common.moreActionsNamed', { name: product.name }),
        items: [{ action: 'delete-product', id: product.id, icon: 'trash-2', label: t('common.delete'), danger: true }],
      }));
    }
    row.appendChild(actions);
  }

  li.appendChild(row);
  return li;
}

/** Opens or closes a product's batches in place; the button keeps the focus. */
function toggleProduct(btn) {
  const li = btn.closest('.pantry-product');
  const region = li?.querySelector(':scope > .pantry-batches');
  if (!li || !region) return;
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.querySelector('.list-group__chevron')?.classList.toggle('list-group__chevron--collapsed', !open);
  if (open) expandedProducts.add(li.dataset.productKey);
  else expandedProducts.delete(li.dataset.productKey);
  toggleRegion(region, open);
}

/**
 * After a step the product's total follows: on the product row and, in the flat
 * filter list, on every batch row of that product that names it.
 */
function refreshProductTotals(item, { speak = true } = {}) {
  const key = productKeyOf(item);
  // What the user sees: a batch in its undo window is gone from the list.
  const batches = (batchesByProduct().get(key) ?? []).filter((b) => !pendingDeletes.has(b.id));
  if (!batches.length || !_container) return;
  const text = productTotalText(productTotal(batches), item.unit);
  const head = `.pantry-product[data-product-key="${key}"] > .pantry-product__row`;
  for (const el of _container.querySelectorAll(`${head} .pantry-product__total`)) el.textContent = text;
  for (const el of _container.querySelectorAll(`${head} .pantry-product__where`)) el.textContent = productWhereText(batches);
  for (const el of _container.querySelectorAll(`${head} .pantry-product__badges`)) fillProductBadge(el, batches);
  for (const el of _container.querySelectorAll(`.pantry-row[data-product-key="${key}"] .pantry-row__total`)) {
    el.textContent = ` · ${text}`;
  }
  // The one live region says the new total with the batch's quantity.
  if (speak && batches.length > 1) announce(`${item.name}: ${quantityText(item)}, ${text}`);
}

/**
 * Wisch zum Zeilenende loescht - mit dem Rueckweg, den removeItem() schon hat
 * (Undo-Toast). Die Karte federt zurueck statt hinauszufliegen: removeItem()
 * blendet die Zeile selbst aus und holt sie bei "Rueckgaengig" wieder.
 */
function wirePantrySwipe(list) {
  // Regel 3 in utils/module-access.js: bei Nur-lesen bleibt die VERDRAHTUNG
  // aus, samt Wisch-Hinweis. Ein Riegel in `run` kaeme zu spaet - die Zeile
  // waere schon weggewischt, bevor jemand fragt.
  if (readOnly()) return null;
  const optionen = {
    card: '.pantry-row',
    ignore: '.pantry-stepper, .pantry-row__cart, .popover-menu__trigger',
    trailing: {
      reveal: '.swipe-reveal--delete',
      run: (row) => {
        // A product without batches carries `product-<id>` (emptyProductEl).
        const product = state.products.find((p) => `product-${p.id}` === row.dataset.swipeId);
        if (product) { removeProduct(product); return; }
        const item = state.items.find((i) => String(i.id) === row.dataset.swipeId);
        if (item) removeItem(item);
      },
    },
  };
  wireSwipeRows(list, optionen);
  maybeShowSwipeHint(list);
  return optionen;
}

/** Kontextuelle Einkaufs-Aktion einer Zeile; nur bei leeren/knappen Artikeln. */
function cartEl(item, label = item.name) {
  const cart = document.createElement('button');
  cart.type = 'button';
  cart.className = 'row-action pantry-row__cart';
  cart.dataset.action = 'to-shopping';
  cart.setAttribute('aria-label', `${t('common.toShoppingList')}: ${label}`);
  cart.title = t('common.toShoppingList');
  cart.insertAdjacentHTML('beforeend', '<i data-lucide="shopping-cart" class="icon-md" aria-hidden="true"></i>');
  return cart;
}

// --------------------------------------------------------
// Interaktion
// --------------------------------------------------------

function onListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  // Der eine Riegel fuer alle Aktionen darunter (siehe READ_SAFE_ACTIONS): das
  // Markup nimmt die Affordanz, diese Zeile den Effekt eines Knotens, den ein
  // Rechtewechsel ueberholt hat.
  if (readOnly() && !READ_SAFE_ACTIONS.has(btn.dataset.action)) return;

  // The product row and the cart of a product without batches carry no batch.
  if (btn.dataset.action === 'toggle-product') { toggleProduct(btn); return; }
  if (btn.dataset.action === 'to-shopping-product') {
    const product = state.products.find((p) => p.id === Number(btn.dataset.productId));
    if (product) sendToShopping([product], btn, [{ pantry_product_id: product.id }]);
    return;
  }
  if (btn.dataset.action === 'delete-product') {
    const product = state.products.find((p) => p.id === Number(btn.dataset.id));
    if (product) removeProduct(product);
    return;
  }

  const row = btn.closest('.pantry-row[data-id]');
  if (!row) return;
  const item = state.items.find((i) => i.id === Number(row.dataset.id));
  if (!item) return;

  if (btn.dataset.action === 'details') { openItemReadModal(item); return; }
  if (btn.dataset.action === 'edit') { openItemModal('edit', item); return; }
  if (btn.dataset.action === 'to-shopping') { sendToShopping([item], btn); return; }
  if (btn.dataset.action === 'increase') { adjustQuantity(item, +1, row); return; }
  if (btn.dataset.action === 'decrease') { adjustQuantity(item, -1, row); }
}

/**
 * Optimistischer ±-Schritt. Der PATCH wird entprellt, damit mehrfaches Tippen
 * einen Request auslöst statt fünf; beim Fehlschlag kehrt die Zeile auf den
 * Serverstand zurück.
 *
 * Die Zeile wird bewusst NICHT neu gefiltert: verschwände ein Artikel unter
 * dem Finger, sobald er den aktiven Filter verlässt, wäre der nächste Tap ein
 * Fehltap. Die Auswahl aktualisiert sich beim nächsten vollen Render.
 */
function adjustQuantity(item, direction, row) {
  // Zweite Linie hinter dem fehlenden Stepper: ohne Schreibrecht keine
  // optimistische Menge und kein PATCH.
  if (readOnly()) return;
  const step = Number(row.querySelector('.pantry-stepper')?.dataset.step) || 1;
  // Der Ausgangspunkt ist, was die Zeile ZEIGT - eine schon laufende Absicht
  // eingeschlossen, sonst zaehlte jeder Schritt vom Serverstand aus neu.
  const previous = quantityOf(item);
  const next = normalizePantryQuantity(previous + direction * step, { fallback: previous });
  if (next === previous) return;

  const vorher = intents.get(item.id);
  if (vorher) clearTimeout(vorher.timer);
  const seq = ++_quantitySeq;

  const timer = setTimeout(async () => {
    try {
      const res = await api.patch(`/pantry/${item.id}`, { quantity: next });
      // Ueberholt: ein spaeterer Schritt hat die Absicht ersetzt, sein Ausgang
      // entscheidet. Der Server steht trotzdem auf `next` - das gehoert in den
      // SERVERSTAND, damit ein Fehlschlag des spaeteren nicht daran vorbei
      // zurueckfaellt.
      const aktuell = intents.get(item.id);
      // NUR die Menge aus der Antwort. Sie ist ein Schnappschuss vom Zeitpunkt
      // DIESES Schreibvorgangs und fuer nichts anderes autoritativ - hat jemand
      // Name, Ort oder Notiz geaendert, holt die naechste Auffrischung das.
      const bestaetigt = normalizePantryQuantity(res.data?.quantity, { fallback: next });
      const current = state.items.find((i) => i.id === item.id);
      if (current) current.quantity = bestaetigt;
      settledAt.set(item.id, _pantryLoadSeq);
      if (aktuell?.seq !== seq) return;
      // Die eigene Absicht ist erfuellt und faellt - was die Zeile danach
      // zeigt, ist der bestaetigte Serverstand.
      intents.delete(item.id);
      const rowNow = liveRow(item.id, row);
      if (rowNow && current) refreshRowQuantity(rowNow, withIntent(current));
    } catch (err) {
      const aktuell = intents.get(item.id);
      if (aktuell?.seq !== seq) return;
      // DIE ABSICHT FAELLT, mehr passiert nicht. Was die Zeile danach zeigt,
      // ist der Serverstand - der aktuellste, den wir haben. Es gibt keinen
      // gemerkten Ruecksprungwert mehr, der dabei veralten koennte.
      intents.delete(item.id);
      const current = state.items.find((i) => i.id === item.id);
      // Die Seite wurde inzwischen verlassen: kein Zurückzeichnen einer
      // abgehängten Zeile und kein Vorrats-Toast auf einer fremden Seite.
      const rowNow = liveRow(item.id, row);
      if (!rowNow) return;
      if (current) refreshRowQuantity(rowNow, withIntent(current));
      if (renderFilters().wasReset) renderList();
      window.yuvomi?.showToast(errorSentence(err), 'danger');
    }
  }, QUANTITY_DEBOUNCE_MS_OVERRIDE ?? QUANTITY_DEBOUNCE_MS);

  intents.set(item.id, {
    quantity: next,
    seq,
    timer,
    // `flush` schickt den gedebouncten Wert sofort ab, wenn die Seite
    // verschwindet. Die Absicht faellt dabei nicht - der Rundlauf laeuft ja
    // noch, nur ohne Timer.
    flush: () => {
      clearTimeout(timer);
      // keepalive: der Request muss den Seitenwechsel überleben. Ohne ihn
      // bricht der Browser ihn mit dem Dokument ab.
      api.patch(`/pantry/${item.id}`, { quantity: next }, { keepalive: true })
        .catch(() => { /* Die Seite ist weg; ein Toast hätte kein Ziel mehr. */ });
    },
  });

  vibrate(8);
  refreshRowQuantity(row, withIntent(item));
  if (renderFilters().wasReset) renderList();
  bindQuantityFlush();
}

let _quantityFlushBound = false;

/**
 * Offene Mengenänderungen beim Verschwinden der Seite noch abschicken.
 *
 * Der Stepper schreibt 450ms gedebounced. Genau in diesem Fenster ist der
 * typische Ablauf: am Vorratsschrank stehen, „+" tippen, Telefon sperren. Der
 * Timer feuerte dann nie, die UI hatte den neuen Wert aber schon optimistisch
 * gezeigt - beim nächsten Öffnen stand der alte Bestand da, ohne jede Meldung.
 *
 * Dasselbe Muster wie `bindDeleteFlush` in utils/ux.js (Audit F-13): einmal
 * global gebunden, `pagehide` deckt Tab-Schließen, Reload und den
 * App-Wechsel auf iOS ab.
 */
function bindQuantityFlush() {
  if (_quantityFlushBound) return;
  _quantityFlushBound = true;
  window.addEventListener('pagehide', () => {
    for (const intent of [...intents.values()]) intent.flush?.();
  });
}

/** Sagt eine Bestandsänderung über die eine geteilte Live-Region der Seite an. */
function announce(message) {
  const region = _container?.querySelector('#pantry-live');
  if (region) region.textContent = message;
}

/** Aktualisiert Menge, Badges und Leer-Zustand einer Zeile ohne Listen-Rebuild. */
/**
 * Die Zeile eines Artikels, wie sie JETZT im Dokument steht.
 *
 * Nach einer Auffrischung hat `renderList()` die Liste neu gebaut; die beim
 * Schritt festgehaltene Zeile haengt dann an nichts mehr, und ein
 * Zurueckzeichnen darauf waere unsichtbar. Findet sich keine angehaengte
 * Zeile, ist die Seite verlassen - dann bleibt es beim State.
 */
function liveRow(id, fallback) {
  const el = _container?.querySelector(`.pantry-row[data-id="${id}"]`);
  if (el?.isConnected) return el;
  return fallback?.isConnected ? fallback : null;
}

function refreshRowQuantity(row, item) {
  const value = row.querySelector('.pantry-row__quantity');
  if (value) value.textContent = quantityText(item);
  announce(`${item.name}: ${quantityText(item)}`);

  const minus = row.querySelector('[data-action="decrease"]');
  if (minus) {
    const willDisable = Number(item.quantity) <= 0;
    // Einen fokussierten Button zu deaktivieren wirft den Fokus auf <body>.
    // Vorher auf „+" ausweichen - das ist ohnehin die einzige Aktion, die auf
    // einem leeren Artikel noch sinnvoll ist.
    if (willDisable && !minus.disabled && document.activeElement === minus) {
      row.querySelector('[data-action="increase"]')?.focus();
    }
    minus.disabled = willDisable;
  }

  const status = pantryItemStatus(item, state.todayKey);
  row.classList.toggle('pantry-row--out', status.out);

  // Bestands-Badge und Einkaufs-Aktion hängen an der Menge und müssen mitgehen.
  // Der Warenkorb-Slot wird als GANZES getauscht, nicht der Knopf darin: der Slot
  // hält die Breite der Bedienzone konstant, auch wenn er leer ist.
  const fresh = rowEl(item);
  row.querySelector('.pantry-row__main')?.replaceWith(fresh.querySelector('.pantry-row__main'));
  row.querySelector('.pantry-row__cart-slot')?.replaceWith(fresh.querySelector('.pantry-row__cart-slot'));
  refreshProductTotals(item);

  if (window.lucide) window.lucide.createIcons({ el: row });
  // Das Panel spricht von denselben Mengen: ein Schritt, der einen Artikel
  // unter den Mindestbestand bringt, gehoert sofort unter „Fast leer".
  renderWatch();
}

// --------------------------------------------------------
// Einkaufsliste
// --------------------------------------------------------

/**
 * Fehlmenge als Anzeigetext: bis zum Mindestbestand auffüllen. Ohne
 * Mindestbestand bleibt die Menge offen - im Laden entscheidet man selbst.
 */
function shortfallText(item) {
  if (item.min_quantity == null) return null;
  const missing = normalizePantryQuantity(Number(item.min_quantity) - Number(item.quantity), { fallback: 0 });
  if (missing <= 0) return null;
  // Derselbe Helfer wie die Zeile: auch auf dem Einkaufszettel „2 Dosen".
  return pantryQuantityLabel(missing, item.unit, { t, formatNumber: formatQuantity });
}

/**
 * `entries` overrides what goes over: a product without batches is handed over
 * by its product id (`pantry_product_id`), without a quantity.
 */
async function sendToShopping(items, btn, entries = null) {
  if (!items.length) return;
  // Zweite Linie hinter Warenkorb und Pille - auch fuer einen Knoten, den ein
  // Rechtewechsel ueberholt hat.
  if (!mayTransferPantryToShopping()) return;

  let lists;
  try {
    lists = await ensureLists();
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
    return;
  }

  // Vorprüfung, Listenwahl und die Antwort auf „es gibt keine Liste" liegen im
  // geteilten Baustein (utils/kitchen-transfer.js) - dieselbe Abfolge stand
  // vorher in allen drei erzeugenden Tabs, mit drei Ergebnissen.
  const target = await resolveShoppingTarget(lists);
  if (!target) return;

  // Während des Transfers gesperrt, wie im Rezepte-Tab. Ohne das lässt sich der
  // Warenkorb mehrfach antippen, und jeder Klick erzeugt einen eigenen Toast mit
  // eigenem Undo - von denen nur der letzte etwas zurücknimmt.
  if (btn) btn.disabled = true;
  try {
    const res = await api.post(`/shopping/${target.id}/import-pantry`, {
      items: entries ?? items.map((item) => ({ pantry_item_id: item.id, quantity: shortfallText(item) })),
    });
    const { added = 0, skipped = 0, added_ids: addedIds = [] } = res.data ?? {};
    if (!added) {
      window.yuvomi?.showToast(t('pantry.toShoppingNone'), 'info');
      return;
    }
    // Zwei vollständige Sätze, mit Leerzeichen verbunden. Vorher stand ein
    // Interpunkt dazwischen: das ergab einen zusammengesetzten Satz, der in
    // Sprachen mit anderer Satzstellung bricht, und ein Screenreader liest das
    // Zeichen mit (Critique 2026-07-29). Ein einziger Key mit beiden Zahlen
    // wäre die Alternative - der müsste dann aber zwei Plurale in einem String
    // beugen, was Intl.PluralRules nicht kann.
    // `list` nennt das ZIEL. „… auf die Einkaufsliste übernommen." benannte den
    // Typ, nicht die Liste - bei mehreren Listen bleibt damit offen, auf welche
    // (Critique 2026-07-30, P1). Der Name steht hier ohnehin fest: entweder gibt es
    // nur eine Liste, oder der Nutzer hat sie gerade ausgewählt.
    const message = transferMessage('pantry.toShoppingDone', { added, skipped, list: target.name });

    // Meldung, Standzeit, Tab-Zahl und Rücknahme kommen aus dem geteilten
    // Baustein. Der Warenkorb ist der Pfad, den man am leichtesten versehentlich
    // nimmt - er sitzt in der Zeile direkt neben „Menge erhöhen", und die beiden
    // bedeuten das Gegenteil voneinander (Critique 2026-07-30).
    announceTransfer({ message, addedIds });
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --------------------------------------------------------
// Artikel-Formular
// --------------------------------------------------------

/**
 * Der Artikel bei `pantry: read`: Leseansicht, sonst nichts (Regel 9, Bauart
 * `openItemReadModal()` in shopping.js und `openNoteReadModal()` in notes.js).
 * Alles, was der Bearbeiten-Dialog zeigt - Menge mit Einheit, Lagerort,
 * Kategorie, MHD, Mindestbestand, Notiz -, als Wert statt als Eingabe; der Name
 * steht im Titel. Kategorie, Mindestbestand und Notiz stehen NUR im Editor, die
 * Zeile zeigt sie nie. Kein Fusszeilen-Knopf, das X schliesst.
 */
function itemReadHtml(item) {
  const amount = (value) => pantryQuantityLabel(Number(value) || 0, item.unit, { t, formatNumber: formatQuantity });
  return `
    <div class="pantry-item-read detail-view" data-view="read" data-item-id="${esc(String(item.id))}">
      <div class="detail-view__rows">
        ${readRowHtml({ icon: 'hash', label: t('pantry.quantityLabel'), value: amount(item.quantity) })}
        ${readRowHtml({ icon: 'map-pin', label: t('pantry.locationLabel'), value: item.location_name ? locationLabel(item.location_name) : t('pantry.unlocated') })}
        ${readRowHtml({ icon: 'tag', label: t('pantry.categoryLabel'), value: item.category ? categoryLabel(item.category) : '' })}
        ${readRowHtml({ icon: 'calendar', label: t('pantry.expiresLabel'), value: item.expires_on ? dateText(item.expires_on) : '' })}
        ${readRowHtml({ icon: 'triangle-alert', label: t('pantry.minQuantityLabel'), value: item.min_quantity != null ? amount(item.min_quantity) : '' })}
        ${readRowHtml({ icon: 'align-left', label: t('pantry.notesLabel'), value: item.notes || '', multiline: true })}
      </div>
    </div>`;
}

function openItemReadModal(item) {
  openSharedModal({
    title: item.name,
    size: 'md',
    content: itemReadHtml(item),
    onSave(panel) {
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

function openItemModal(mode, item = null) {
  const isEdit = mode === 'edit';
  // Der Riegel steht VOR jeder Vorbereitung, und er steht HIER, weil Liste,
  // Nebenpanel, FAB und Leerzustand alle diesen Weg nehmen: bei `read` geht
  // fuer einen Artikel die Leseansicht auf, und Anlegen gibt es nicht. Den FAB
  // blendet CSS aus (html[data-module-readonly]) - ausgeblendet ist nicht
  // unerreichbar.
  if (readOnly()) {
    if (isEdit && item) openItemReadModal(withIntent(item));
    return;
  }
  // Der Dialog zeigt den Artikel, wie ihn die Zeile zeigt: mit der Absicht
  // eines Stepper-Schritts, dessen PATCH noch im Entprell-Fenster steht. Aus
  // dem nackten Serverstand gefuellt stuende dort die alte Menge, und wer dann
  // ein anderes Feld speichert, schriebe sie per PUT zurueck - der Schritt
  // waere still verloren. Hier statt beim Aufrufer, weil Liste und Nebenpanel
  // denselben Weg nehmen.
  if (isEdit) item = withIntent(item);
  const locations = state.locations;
  const categories = state.categories;

  const unitOptions = PANTRY_UNITS
    .map((unit) => `<option value="${esc(unit)}">${esc(unitLabel(unit))}</option>`)
    .join('');
  const locationOptions = [
    `<option value="">${esc(t('pantry.unlocated'))}</option>`,
    ...locations.map((loc) => `<option value="${loc.id}">${esc(locationLabel(loc.name))}</option>`),
  ].join('');
  const categoryOptions = categories
    .map((cat) => `<option value="${esc(cat.name)}">${esc(categoryLabel(cat.name))}</option>`)
    .join('');

  openSharedModal({
    staged: !isEdit, // Buehne zuerst, Felder nach dem ersten Bild (modal.js, R21 a6)
    title: isEdit ? t('common.editItem') : t('pantry.addItem'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="pantry-name">${esc(t('common.nameLabel'))}${REQUIRED_MARK}</label>
        <input id="pantry-name" class="form-input" type="text" required
               placeholder="${esc(t('pantry.namePlaceholder'))}">
      </div>
      <div class="form-pair">
        <div class="form-group">
          <label class="form-label" for="pantry-quantity">${esc(t('pantry.quantityLabel'))}</label>
          <input id="pantry-quantity" class="form-input" type="number" min="0" step="any" inputmode="decimal">
        </div>
        <div class="form-group">
          <label class="form-label" for="pantry-unit">${esc(t('pantry.unitLabel'))}</label>
          <select id="pantry-unit" class="form-input">${unitOptions}</select>
        </div>
      </div>
      <div class="form-pair">
        <div class="form-group">
          <label class="form-label" for="pantry-location">${esc(t('pantry.locationLabel'))}</label>
          <select id="pantry-location" class="form-input">${locationOptions}</select>
        </div>
        <div class="form-group">
          <label class="form-label" for="pantry-category">${esc(t('pantry.categoryLabel'))}</label>
          <select id="pantry-category" class="form-input">${categoryOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="pantry-expires">${esc(t('pantry.expiresLabel'))}</label>
        <yuvomi-datepicker id="pantry-expires" type="date"
                           value="${esc(isEdit && item.expires_on ? item.expires_on : '')}"></yuvomi-datepicker>
        <p class="form-hint">${esc(t('pantry.expiresHint'))}</p>
      </div>
      ${advancedSection(`
        <div class="form-group">
          <label class="form-label" for="pantry-min">${esc(t('pantry.minQuantityLabel'))}</label>
          <input id="pantry-min" class="form-input" type="number" min="0" step="any" inputmode="decimal">
          <p class="form-hint">${esc(t('pantry.minQuantityHint'))}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="pantry-notes">${esc(t('pantry.notesLabel'))}</label>
          <textarea id="pantry-notes" class="form-input" rows="3"
                    placeholder="${esc(t('pantry.notesPlaceholder'))}"></textarea>
        </div>`,
      { open: isEdit && (item.min_quantity != null || !!item.notes) })}
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `<button type="button" class="btn btn--danger-outline pantry-form__delete" id="pantry-delete"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}</button>` : ''}
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="pantry-save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
      </div>`,
    onSave(panel) {
      panel.querySelector('#pantry-name').value = isEdit ? item.name : '';
      panel.querySelector('#pantry-quantity').value = isEdit ? String(item.quantity) : '1';
      panel.querySelector('#pantry-unit').value = isEdit ? item.unit : 'pcs';
      panel.querySelector('#pantry-location').value = isEdit && item.location_id ? String(item.location_id) : '';
      panel.querySelector('#pantry-category').value = isEdit
        ? item.category
        : (categories.find((c) => c.name === DEFAULT_CATEGORY_NAME)?.name ?? categories[0]?.name ?? DEFAULT_CATEGORY_NAME);
      panel.querySelector('#pantry-min').value = isEdit && item.min_quantity != null ? String(item.min_quantity) : '';
      panel.querySelector('#pantry-notes').value = isEdit && item.notes ? item.notes : '';

      panel.querySelector('#pantry-save').addEventListener('click', () => saveItem(panel, mode, item));
      panel.querySelector('#pantry-delete')?.addEventListener('click', async () => {
        closeSharedModal({ force: true });
        await removeItem(item);
        refocusAfterRender();
      });

      wireBlurValidation(panel);
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

async function saveItem(panel, mode, item) {
  // Ein Dialog, den ein Rechtewechsel ueberholt hat: POST und PUT endeten im 403.
  if (readOnly()) return;
  const saveBtn = panel.querySelector('#pantry-save');
  const nameInput = panel.querySelector('#pantry-name');
  const name = nameInput.value.trim();

  if (!name) {
    reportFieldError(nameInput, t('common.nameRequired'));
    return;
  }

  const minRaw = panel.querySelector('#pantry-min').value.trim();
  const payload = {
    name,
    quantity: normalizePantryQuantity(panel.querySelector('#pantry-quantity').value, { fallback: 1 }),
    unit: panel.querySelector('#pantry-unit').value,
    location_id: panel.querySelector('#pantry-location').value || null,
    category: panel.querySelector('#pantry-category').value,
    expires_on: panel.querySelector('#pantry-expires').value || null,
    min_quantity: minRaw === '' ? null : normalizePantryQuantity(minRaw, { fallback: 0 }),
    notes: panel.querySelector('#pantry-notes').value.trim() || null,
  };

  saveBtn.disabled = true;
  try {
    // Nur diesen Dialog schliessen, nicht einen, der waehrend der Anfrage
    // aufgegangen ist (#1997).
    const dialog = captureModalContext();
    if (mode === 'create') {
      const res = await api.post('/pantry', payload);
      state.items.push(res.data);
    } else {
      const res = await api.put(`/pantry/${item.id}`, payload);
      const idx = state.items.findIndex((i) => i.id === item.id);
      if (idx >= 0) state.items[idx] = res.data;
    }
    // location_name/location_icon kommen aus dem JOIN der Liste, nicht aus der
    // Einzel-Antwort - deshalb nach dem Speichern einmal frisch laden, damit
    // Gruppierung und Meta-Zeile stimmen.
    await reloadAfterSave(() => loadPantry());
    closeSharedModal({ force: true, context: dialog });
    renderFilters();
    renderList({ motion: true });
    window.yuvomi?.showToast(mode === 'create' ? t('pantry.created') : t('pantry.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.yuvomi?.showToast(errorSentence(err), 'danger');
  }
}

async function removeItem(item) {
  // VOR dem Ausklappen: sonst verschwaende die Zeile, das DELETE endete im
  // 403, und sie kaeme mit Fehlermeldung zurueck.
  if (readOnly()) return;
  // Die Buehne (`li.swipe-row`), nicht nur die Zeile darin: sonst bliebe ein
  // leeres Listenelement samt Trennlinie stehen.
  const inner = _container?.querySelector(`.pantry-row[data-id="${item.id}"]`);
  const rowEl_ = inner?.closest('.swipe-row') ?? inner;
  // Die Zeile klappt aus, die Nachbarn ruecken nach (vorher `display: none`:
  // sie war weg, der Rest sprang). `display: none` folgt erst DANACH und bleibt
  // das Netz fuer alles, was nicht animiert (reduzierte Bewegung, kein
  // `animate`): der Zustand "weg" haengt an keiner Animation.
  let restored = false;
  if (rowEl_) collapseOut(rowEl_).then(() => { if (!restored) rowEl_.style.display = 'none'; });
  // The product row above counts what is left (#1448); undo gives it back.
  pendingDeletes.add(item.id);
  refreshProductTotals(item, { speak: false });

  scheduleUndoableDelete({
    message: t('pantry.deleted'),
    commit: async ({ keepalive }) => {
      await api.delete(`/pantry/${item.id}`, { keepalive });
      if (keepalive) return;
      state.items = state.items.filter((i) => i.id !== item.id);
      pendingDeletes.delete(item.id);
      renderFilters();
      renderList();
    },
    restore: (err) => {
      restored = true;
      pendingDeletes.delete(item.id);
      refreshProductTotals(item, { speak: false });
      if (rowEl_) {
        rowEl_.style.display = '';
        // collapseOut haelt die Hoehe 0 (fill: forwards) - verwerfen, dann aufziehen.
        rowEl_.getAnimations?.().forEach((anim) => anim.cancel());
        rowEl_.style.overflow = '';
        expandIn(rowEl_);
      }
      if (err) window.yuvomi?.showToast(errorSentence(err), 'danger');
    },
  });
}

/**
 * Deletes a product without batches (#1448, brought forward from step 5), with
 * the undo window of a batch: the row folds away at once, undo brings it back,
 * and only the commit calls the server. The server refuses a product that has
 * batches again (409, `pantry_product_has_batches`, say someone booked one in
 * meanwhile): then the row comes back, the toast says why, and the page reloads
 * to show the new batch.
 */
function removeProduct(product) {
  if (readOnly()) return;
  const stage = _container?.querySelector(`.pantry-product[data-product-key="p${product.id}"]`);
  let restored = false;
  if (stage) collapseOut(stage).then(() => { if (!restored) stage.style.display = 'none'; });
  pendingProductDeletes.add(product.id);

  scheduleUndoableDelete({
    message: t('pantry.deleted'),
    commit: async ({ keepalive }) => {
      await api.delete(`/pantry/products/${product.id}`, { keepalive });
      if (keepalive) return;
      state.products = state.products.filter((p) => p.id !== product.id);
      pendingProductDeletes.delete(product.id);
      renderFilters();
      renderList();
    },
    restore: (err) => {
      restored = true;
      pendingProductDeletes.delete(product.id);
      if (stage?.isConnected) {
        stage.style.display = '';
        stage.getAnimations?.().forEach((anim) => anim.cancel());
        stage.style.overflow = '';
        expandIn(stage);
      } else {
        // Redrawn in the window (search, chip): the row is drawn anew.
        renderList();
      }
      if (!err) return;
      // The sentence of the app, not the server's (#1909, CASE_MESSAGES).
      window.yuvomi?.showToast(errorSentence(err, 'common.unknownError'), 'danger');
      if (err.data?.reason === 'pantry_product_has_batches') {
        loadPantry().then(() => { renderFilters(); renderList(); }).catch(() => {});
      }
    },
  });
}

// --------------------------------------------------------
// Lagerort-Verwaltung
// --------------------------------------------------------

async function openLocationManager() {
  // Zweite Linie hinter dem fehlenden Knopf im Kopf (Regel 7).
  if (readOnly()) return;
  // Laedt die Komponente erst, nachdem der Nutzer einen anderen Dialog
  // geoeffnet oder die Seite verlassen hat, geht die Verwaltung nicht mehr auf (#1997).
  const context = captureOpenContext();
  await import('/components/category-manager.js');
  if (!isModalContextCurrent(context)) return;

  // Die Auffrischung haengt am Ereignis, nicht am Schliessen: beim Loeschen
  // raeumt `confirmOverModal` das Modal darunter ab, bevor `api.delete` laeuft
  // (siehe `_notifyChanged` in components/category-manager.js). Ein in onClose
  // ausgewerteter Merker stuende hier auf false, und die Filterleiste boete
  // weiter einen Lagerort an, den es nicht mehr gibt.
  const onChanged = async () => {
    try {
      await loadPantry();
      renderFilters();
      renderList();
      refocusAfterRender();
    } catch (err) {
      // NICHT „meldet der Manager selbst": der quittiert nur seine eigene
      // Mutation, und `_notifyChanged()` kommt erst nach deren Erfolg. Was hier
      // ankommt, ist immer ein Fehler DIESER Auffrischung - und der erklaert als
      // einziger, warum die Seite den alten Stand behaelt.
      console.error('[Pantry] Auffrischen nach Ort-Aenderung fehlgeschlagen:', err);
      window.yuvomi?.showToast(errorSentence(err), 'danger');
    }
  };

  openSharedModal({
    title: t('pantry.manageLocations'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    onSave: (panel) => {
      const manager = panel.querySelector('yuvomi-category-manager');
      if (!manager) return;
      manager.addEventListener('category-manager-changed', onChanged);
      // Dieselbe geteilte Komponente wie Einkaufskategorien: die Lagerort-API
      // bietet exakt deren CRUD-Vertrag (GET/POST basePath, PUT/DELETE :id,
      // PATCH /reorder).
      manager.configure({
        basePath: '/pantry/locations',
        labelResolver: (loc) => locationLabel(loc.name),
        titleKey: 'pantry.manageLocations',
        hintKey: 'pantry.manageLocationsHint',
        addPlaceholderKey: 'pantry.addLocation',
        // Lagerorte, keine Kategorien: der Server loescht auch belegte und
        // laesst die Artikel unzugeordnet zurueck (`orphaned` in der Antwort).
        deleteDetailKey: 'pantry.locationDeleteConfirmDetail',
        groups: [{ key: '', labelKey: '', addLabelKey: 'common.add' }],
      });
    },
    // Bewusst KEIN onClose, das den Listener abmeldet - es liefe vor dem
    // Loeschen. Das Element entsteht je Oeffnen neu und geht mit dem Overlay.
  });
}

// Testfläche: die Mengen-Entprellung ist nur verhaltensgetrieben pruefbar - der
// Fehler steckt in der REIHENFOLGE von Schritt und Auffrischung, nicht im
// Vorhandensein einer Wache. `state` bleibt ERREICHBAR, nicht ERSETZBAR
// (dasselbe Muster wie in shopping.js).
export const __test = {
  state,
  adjustQuantity,
  // Kopfregel mobil: die Chipreihe ist das erste Kind des Ports und muss den
  // Neuaufbau der Liste ueberleben (test-pantry-ux.js).
  renderList,
  loadPantry,
  intents,
  quantityOf,
  withIntent,
  setContainerForTest: (el) => { _container = el; },
  // Eine echte, aber knapp bemessene Frist statt eines Uhr-Objekts - wie beim
  // Sammelaktions-Automaten des Einkaufs.
  setQuantityDebounceMsForTest: (ms) => { QUANTITY_DEBOUNCE_MS_OVERRIDE = ms; },
  // Aufraeumen am ANFANG: `_pantryLoadSeq` waechst global weiter, und eine
  // Bestaetigung aus einem frueheren Fall schuetzt sonst den Artikel des
  // naechsten vor seiner eigenen Auffrischung.
  resetLoadOrderForTest: () => { _pantryAppliedLoad = 0; settledAt.clear(); },
  // #1265 P4: der Warenkorb der Zeile und sein Handler schreiben in den
  // Einkauf - gemessen am echten Knoten und als Programm
  // (test-shopping-readonly-ui.js).
  rowEl,
  sendToShopping,
  // #1448 step 2: products in sections by category, the product row and the
  // product without batches (test-pantry-ux.js).
  productSections,
  productEl,
  rowOptions,
  toggleProduct,
  expandedProducts,
  pendingDeletes,
  refreshProductTotals,
  // Review of #2085: the product without batches can be deleted, a step
  // refreshes the product total, and one chip per place.
  removeProduct,
  pendingProductDeletes,
  emptyProductEl,
  renderFilters,
  visibleItems,
  flatItems,
  placeChips,
  noResultsEl,
  refreshRowQuantity,
  // R10 L4: das Nebenpanel ordnet wie die Filterchips (test-pantry-ux.js).
  pantryWatchGroups,
  renderWatch,
  // Beide Wege in den Bearbeiten-Dialog (test-pantry-ux.js).
  onListClick,
  onWatchClick,
  // R16 2b: der Lösch-Wisch der Vorratszeile (test-pantry-ux.js).
  wirePantrySwipe,
  removeItem,
  // Nur-lesen im Vorrat: Leseansicht, Anlegen, Leerzustand und
  // Lagerort-Verwaltung (test-shopping-readonly-ui.js).
  READ_SAFE_ACTIONS,
  openItemModal,
  itemReadHtml,
  emptyStateEl,
  openLocationManager,
};
