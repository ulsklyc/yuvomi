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
import { esc } from '/utils/html.js';
import {
  openModal as openSharedModal,
  closeModal as closeSharedModal,
  advancedSection,
  wireBlurValidation,
  reportFieldError,
  confirmModal,
} from '/components/modal.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateEl } from '/utils/empty-state.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { formatMoney } from '/utils/money.js';
import { todayKey } from '/utils/date.js';
import { formatDate, getLocale } from '/i18n.js';
import { renderDocumentAttachField, bindDocumentAttachField } from '/components/document-attach.js';
import { warrantyStatus, hasUpcomingDeadline, dateStatus, countUpcomingDeadlines } from '/utils/inventory-warranty.js';
import { openDetailView } from '/components/detail-view.js';
import { wireScrollFade } from '/utils/ux.js';
import { attachOverlay } from '/utils/overlay-history.js';
import { setNavBadge } from '/utils/nav-badges.js';

let _container = null;
let _search = null;
let _householdCurrency = 'EUR';

const state = {
  items: [],
  locations: [],
  categories: [],
  query: '',
  filterAttention: false,
  view: 'browse',        // 'browse' | 'category'
  activeCategory: null,  // category key, when view === 'category'
};

async function loadLocations() {
  const res = await api.get('/inventory/locations');
  state.locations = res.data;
}

async function loadCategories() {
  const res = await api.get('/inventory/categories');
  state.categories = res.data;
}

// --------------------------------------------------------
// Ort-Verwaltung (zwei Ebenen ueber dieselbe Komponente wie Budget-Kategorien)
// --------------------------------------------------------
async function openLocationManager() {
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
      renderList();
      updateAttentionBadge();
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
      renderList();
      updateAttentionBadge();
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

function openCategory(key) {
  state.view = 'category';
  state.activeCategory = key;
  state.query = '';
  state.filterAttention = false;
  _search?.clear();
  renderList();
  scrollListToTop();
}

function backToBrowse() {
  state.view = 'browse';
  state.activeCategory = null;
  state.query = '';
  state.filterAttention = false;
  _search?.clear();
  renderList();
  scrollListToTop();
}

/** Gleicher Scroll-Container wie router.js bei echten Routenwechseln
 *  (#main-content) - ein Ebenenwechsel hier fuehlt sich sonst wie eine neue
 *  Seite an, springt aber nicht wie eine. */
function scrollListToTop() {
  const main = document.getElementById('main-content');
  if (main) main.scrollTop = 0;
}

/**
 * Fuellt die Filter-Zeile neu - eigene Funktion statt Teil von renderList(),
 * weil die Zeile ausserhalb von #inventory-list liegt (gleiches Muster wie
 * public/pages/documents.js#renderCategoryChips fuer #documents-category).
 * `items` ist der Massstab fuer den Zaehler - die UNGEFILTERTE Menge des
 * aktuellen Geltungsbereichs (ganzes Inventar auf der Kategorie-Detailseite
 * gibt es nicht mehr direkt - dort ist der Geltungsbereich immer eine
 * Kategorie).
 */
function updateFilterChips(items) {
  const host = _container?.querySelector('#inventory-filters');
  if (!host) return;
  host.hidden = false;
  const needsAttention = countUpcomingDeadlines(items);
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <button type="button" class="filter-chip filter-chip--sm${!state.filterAttention ? ' filter-chip--active' : ''}"
            data-filter="all" aria-pressed="${!state.filterAttention}">
      ${esc(t('common.all'))}
    </button>
    <button type="button" class="filter-chip filter-chip--sm${state.filterAttention ? ' filter-chip--active' : ''}"
            data-filter="attention" aria-pressed="${state.filterAttention}">
      ${esc(t('inventory.metricAttentionLabel'))}<span class="filter-chip__count">${needsAttention}</span>
    </button>`);
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

function renderMetrics() {
  const { count, totalValue, needsAttention } = computeMetrics(state.items);
  return `
    <div class="metric-grid">
      <div class="metric-card">
        <div class="metric-card__label">${esc(t('inventory.metricItemsLabel'))}</div>
        <div class="metric-card__value">${count}</div>
      </div>
      <div class="metric-card">
        <div class="metric-card__label">${esc(t('inventory.metricValueLabel'))}</div>
        <div class="metric-card__value">${esc(formatMoney(totalValue, _householdCurrency))}</div>
      </div>
      <button type="button" class="metric-card metric-card--select${state.filterAttention ? ' is-active' : ''}"
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
      <div class="list-rows">
        ${g.items.map(renderItemRow).join('')}
      </div>
    </div>`).join('');
}

/**
 * Zeile ueber die geteilte Grammatik (styles/list-row.css) statt eigener
 * Geometrie: .list-row traegt Flaeche/Trennlinie/Hoehe, .list-row__main
 * (--interactive) den Klickbereich, .list-row__name/.list-row__meta Name und
 * Ort - exakt wie pantry.js#rowEl, damit Inventar optisch nicht vom Vorrat
 * abweicht (Groesse, Abstand, Trennlinie sind app-weit EIN Wert, nicht
 * modulweise nachgebaut). Nur Statusbadge und Kaufpreis sind Inventar-eigen
 * (Vorrat hat kein Aequivalent zu beidem).
 */
function renderItemRow(item) {
  const hasAttachments = (item.attachments?.length ?? 0) > 0;
  const hasBookings = (item.linked_entries?.length ?? 0) > 0;
  const deadlineAlert = hasUpcomingDeadline(item);
  return `
    <div class="list-row" data-id="${item.id}">
      <button type="button" class="list-row__main list-row__main--interactive" data-action="open-detail">
        <span class="inventory-row__headline">
          <span class="list-row__name">${esc(item.name)}</span>
          ${hasAttachments ? `<i data-lucide="paperclip" class="icon-sm" aria-hidden="true"></i><span class="sr-only">${esc(t('inventory.hasAttachmentsLabel'))}</span>` : ''}
          ${hasBookings ? `<i data-lucide="receipt" class="icon-sm" aria-hidden="true"></i><span class="sr-only">${esc(t('inventory.hasBookingsLabel'))}</span>` : ''}
          ${deadlineAlert ? `<i data-lucide="shield-alert" class="icon-sm" aria-hidden="true"></i><span class="sr-only">${esc(t('inventory.warrantyAlertLabel'))}</span>` : ''}
          <span class="inventory-status-badge inventory-status-badge--${esc(item.status)}">${esc(statusLabel(item.status))}</span>
        </span>
        ${item.location_path ? `<span class="list-row__meta">${esc(item.location_path)}</span>` : ''}
      </button>
      <span class="inventory-row__value">${item.purchase_price != null ? esc(formatMoney(item.purchase_price, item.currency)) : ''}</span>
    </div>`;
}

/**
 * Landing-Zeile je Kategorie: Icon, Name, Item-Anzahl - dieselbe .list-row-
 * Grammatik wie jede andere Zeile in diesem Modul. Kein Modul-"Siegel"
 * (anders als das Dashboard-Cockpit): dies ist EIN Modul, keine
 * modulübergreifende Mischstelle, also traegt die Zeile die Kategorie-Ikone
 * direkt, wie .list-group__title es heute schon tut.
 */
function renderCategoryRow(category, itemCount) {
  return `
    <div class="list-row" data-category="${esc(category.key)}">
      <button type="button" class="list-row__main list-row__main--interactive" data-action="open-category">
        <span class="inventory-row__headline">
          <i data-lucide="${esc(category.icon)}" class="icon-sm" aria-hidden="true"></i>
          <span class="list-row__name">${esc(categoryLabel(category))}</span>
        </span>
      </button>
      <span class="list-group__count">${itemCount}</span>
    </div>`;
}

/**
 * Nur Kategorien mit mindestens einem Gegenstand werden zur Zeile - gleiches
 * Verhalten wie groupItemsByCategory, das eine leere Kategorie heute schon
 * nie als eigene Gruppe zeigt. Ein Item, dessen category-Key in keiner
 * geladenen Kategorie mehr steckt (z.B. waehrend eine andere Session sie
 * gerade geloescht hat), bekam bislang GAR KEINE Zeile - unerreichbar beim
 * Browsen, obwohl dieselben Items in einer Suchtrefferliste (die
 * groupItemsByCategory's eigenen "unbekannt"-Eimer nutzt) durchaus
 * auftauchen. Gleicher Fallback wie dort: category_name/category_icon vom
 * Item selbst, sonst der rohe Key/"package".
 */
function renderCategoryList() {
  const counts = new Map();
  const unknownSample = new Map();
  for (const item of state.items) {
    counts.set(item.category, (counts.get(item.category) || 0) + 1);
    if (!unknownSample.has(item.category)) unknownSample.set(item.category, item);
  }
  const categoriesByKey = new Map(state.categories.map((c) => [c.key, c]));
  const knownKeys = state.categories.map((c) => c.key).filter((k) => counts.has(k));
  const unknownKeys = [...counts.keys()].filter((k) => !categoriesByKey.has(k));
  const rows = [
    ...knownKeys.map((k) => renderCategoryRow(categoriesByKey.get(k), counts.get(k))),
    ...unknownKeys.map((k) => {
      const sample = unknownSample.get(k);
      const fallback = { key: k, name: itemCategoryLabel(sample), icon: sample.category_icon || 'package' };
      return renderCategoryRow(fallback, counts.get(k));
    }),
  ];
  return `
    <div class="list-rows">
      ${rows.join('')}
    </div>`;
}

/** Verdrahtet Klicks auf Gegenstands-Zeilen - geteilt zwischen der
 *  Such-Trefferliste (Browse-Ansicht) und der Kategorie-Detailansicht. */
/**
 * Suchfeld-Text passend zum Geltungsbereich - sonst signalisiert nichts,
 * dass die Suche in der Kategorie-Detailansicht nur INNERHALB dieser
 * Kategorie greift, obwohl sie sich global anfuehlt (gleiches Feld, gleiche
 * Position wie auf der Startseite). Placeholder UND sr-only-Label, nicht nur
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
      if (item) openItemDetail(item);
    });
  });
}

function renderList() {
  const list = _container?.querySelector('#inventory-list');
  if (!list) return;

  if (!state.items.length) {
    // Sonst wuerde ein spaeter neu angelegtes Item (in JEDER Kategorie) diese
    // Detailansicht wiederbeleben, statt auf der Startseite zu landen.
    state.view = 'browse';
    state.activeCategory = null;
    const filtersHost = _container?.querySelector('#inventory-filters');
    if (filtersHost) filtersHost.hidden = true;
    list.replaceChildren(emptyStateEl({
      title: t('inventory.emptyTitle'),
      description: t('inventory.emptyDescription'),
      action: { label: t('inventory.addItem'), icon: 'plus', onClick: () => openItemModal('create') },
    }));
    return;
  }

  if (state.view === 'category') {
    renderCategoryDetail(list);
  } else {
    renderBrowse(list);
  }
}

/**
 * Landing-Ansicht: Kennzahlen + Kategorie-Liste. Bei aktiver Suche stattdessen
 * eine flache, nach Kategorie gruppierte Trefferliste ueber ALLE
 * Gegenstaende - gleiches Verhalten wie die fruehere Einzelseite, nur jetzt
 * hinter der Suche statt permanent sichtbar.
 */
function renderBrowse(list) {
  const filtersHost = _container?.querySelector('#inventory-filters');
  if (filtersHost) filtersHost.hidden = true;
  updateSearchScope(t('inventory.searchPlaceholder'));

  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', renderMetrics());
  list.querySelector('[data-action="toggle-attention-filter"]')?.addEventListener('click', () => {
    state.filterAttention = !state.filterAttention;
    renderList();
  });

  if (!state.query && !state.filterAttention) {
    list.insertAdjacentHTML('beforeend', renderCategoryList());
    list.querySelectorAll('[data-action="open-category"]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.closest('[data-category]')?.dataset.category;
        if (key) openCategory(key);
      });
    });
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  const filtered = state.items.filter((item) => matchesQuery(item) && matchesAttentionFilter(item));
  if (!filtered.length) {
    const reset = () => { state.query = ''; state.filterAttention = false; _search?.clear(); renderList(); };
    list.appendChild(emptyStateEl(
      state.query
        ? {
            variant: 'no-results',
            title: t('inventory.noResultsTitle'),
            description: t('inventory.noResultsDescription'),
            hint: `"${state.query}"`,
            action: { label: t('inventory.resetSearch'), onClick: reset },
          }
        : {
            variant: 'no-results',
            title: t('inventory.attentionEmptyTitle'),
            description: t('inventory.attentionEmptyDescription'),
            action: { label: t('inventory.clearAttentionFilter'), onClick: reset },
          },
    ));
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  list.insertAdjacentHTML('beforeend', renderGroupedItems(groupItemsByCategory(filtered)));
  wireItemRows(list);
  if (window.lucide) window.lucide.createIcons({ el: list });
}

/**
 * Kategorie-Detail: Zurueck-Link, Kategorie-Name, Filter-Chips (skaliert auf
 * diese Kategorie), nach Ort gruppierte Gegenstaende dieser einen Kategorie.
 * Eigene Such-Zeile lebt im Toolbar (unveraendert) - hier wird nur gefiltert,
 * was schon in state.items steht, nicht neu geladen.
 */
function renderCategoryDetail(list) {
  const category = state.categories.find((c) => c.key === state.activeCategory);
  // Die aktive Kategorie kann verschwunden sein, waehrend diese Ansicht offen
  // war (ueber manage-categories geloescht - der Server haengt ihre Items auf
  // 'other' um). Kein Geister-Detail fuer eine Kategorie, die es nicht mehr
  // gibt: zurueck zur Startseite statt den rohen Key als Titel zu zeigen.
  if (!category) { backToBrowse(); return; }
  const categoryItems = state.items.filter((item) => item.category === state.activeCategory);

  updateFilterChips(categoryItems);
  updateSearchScope(t('inventory.searchInCategoryPlaceholder', { category: categoryLabel(category) }));

  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', `
    <button type="button" class="inventory-back-link" id="inventory-back-link">
      <i data-lucide="arrow-left" class="inventory-back-link__icon" aria-hidden="true"></i>
      ${esc(t('inventory.backToInventory'))}
    </button>
    <h2 class="inventory-category-title">${esc(category ? categoryLabel(category) : state.activeCategory)}</h2>`);
  list.querySelector('#inventory-back-link').addEventListener('click', backToBrowse);

  const filtered = categoryItems.filter((item) => matchesQuery(item) && matchesAttentionFilter(item));
  if (!filtered.length) {
    const active = [];
    if (state.query) active.push(`"${state.query}"`);
    if (state.filterAttention) active.push(t('inventory.metricAttentionLabel'));
    list.appendChild(emptyStateEl({
      variant: 'no-results',
      title: t('inventory.noResultsTitle'),
      description: t('inventory.noResultsDescription'),
      hint: active.length ? active.join(' · ') : undefined,
      action: {
        label: t('inventory.resetSearch'),
        onClick: () => {
          state.query = '';
          state.filterAttention = false;
          _search?.clear();
          renderList();
        },
      },
    }));
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  list.insertAdjacentHTML('beforeend', renderGroupedItems(groupItemsByLocation(filtered)));
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

/** Garantie-Zeile: kombiniert die reine Monatsangabe mit dem berechneten
 *  Status, wenn ein Kaufdatum vorliegt - sonst nur "X Monate". */
function warrantyDetailValue(item) {
  if (item.warranty_months == null) return '';
  const status = warrantyStatus(item);
  if (!status) return t('inventory.warrantyMonthsValue', { count: item.warranty_months });
  // Der Key direkt, ohne Date-Umweg: `new Date(key + 'T00:00:00')` ist
  // Mitternacht der BROWSER-Zone, und in einer Haushaltszone westlich davon
  // faellt der angezeigte Tag dann auf den Vortag (#829 Teil 3).
  const formattedDate = formatDate(status.endDateKey);
  if (status.state === 'expired') return t('inventory.warrantyStatusExpired', { date: formattedDate });
  if (status.state === 'expiring') return t('inventory.warrantyStatusExpiringSoon', { count: status.days });
  return t('inventory.warrantyStatusValid', { date: formattedDate });
}

/** Fristen-Zeile je getrackter Frist: Bezeichnung + Datum + Countdown. */
function trackedDateDetailEntries(item) {
  return (item.tracked_dates || []).map((d) => {
    const status = dateStatus(d.date);
    const countdown = !status ? '' : status.days < 0
      ? t('inventory.trackedDateOverdueDays', { count: Math.abs(status.days) })
      : status.days === 0 ? t('inventory.trackedDateDueToday')
      : t('inventory.trackedDateInDays', { count: status.days });
    return { text: d.label, sub: countdown ? `${formatDate(d.date)} · ${countdown}` : formatDate(d.date) };
  });
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
 * Lese-Zeilen fuer die Detailansicht. Zeilen ohne Inhalt fallen selbst weg
 * (detailRowEl), also keine Fallunterscheidung hier noetig.
 * @returns {Array} Sections fuer openDetailView
 */
function renderItemDetail(item) {
  const bookingEntries = (item.linked_entries || []).map((link) => ({
    text: `${link.title} · ${formatMoney(link.amount, _householdCurrency)}`,
    sub: `${roleLabel(link.role)} · ${formatDate(link.date)}`,
  }));
  const attachmentEntries = (item.attachments || []).map((doc) => ({
    text: doc.name || doc.original_name || '',
    href: `/api/v1/documents/${doc.document_id}/preview`,
  }));

  return [
    { icon: 'image', label: t('inventory.photoLabel'), node: photoDetailNode(item.photo_data) },
    { icon: item.category_icon, label: t('inventory.categoryLabel'), value: itemCategoryLabel(item) },
    { icon: 'map-pin', label: t('inventory.locationLabel'), value: item.location_path || '' },
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
    { icon: 'shield', label: t('inventory.warrantyMonthsLabel'), value: warrantyDetailValue(item) },
    { icon: 'gauge', label: t('inventory.conditionLabel'), value: t(`inventory.condition${item.condition.charAt(0).toUpperCase()}${item.condition.slice(1)}`) },
    { icon: 'info', label: t('inventory.statusLabel'), value: statusLabel(item.status) },
    { icon: 'align-left', label: t('inventory.notesLabel'), value: item.notes || '', multiline: true },
    { icon: 'calendar-clock', label: t('inventory.trackedDatesLabel'), node: inventoryDetailListNode(trackedDateDetailEntries(item)) },
    { icon: 'receipt', label: t('inventory.linkedBookingsLabel'), node: inventoryDetailListNode(bookingEntries) },
    { icon: 'paperclip', label: t('inventory.attachmentsLabel'), node: inventoryDetailListNode(attachmentEntries) },
  ];
}

/**
 * Antippen zeigt den Gegenstand, bevor es ihn bearbeiten laesst - gleiches
 * Muster wie public/pages/contacts.js#openContactDetail. Kein Anker, damit
 * die Ansicht immer als Sheet erscheint statt als Desktop-Popover: das ist,
 * was "Bearbeiten" das Formular INLINE mounten laesst (Design-Doc §3),
 * anstatt einen zweiten Weg fuer den Popover-Fall zu brauchen.
 *
 * Die Liste liefert bereits das volle Item (Anhaenge, Buchungen, Fristen) -
 * kein Einzelabruf noetig, anders als bei Kontakten.
 */
function openItemDetail(item) {
  openDetailView({
    title: item.name,
    accentColor: 'var(--module-inventory)',
    size: 'md',
    sections: renderItemDetail(item),
    actions: [{
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
    edit: {
      label: t('common.edit'),
      title: t('common.editItem'),
      mount: (panel, pane) => {
        const form = buildItemForm({ mode: 'edit', item });
        pane.insertAdjacentHTML('beforeend', form.content);
        form.wire(panel);
      },
    },
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
        <div class="inventory-booking-picker__header">
          <strong>${esc(t('inventory.bookingPickerTitle'))}</strong>
          <button class="btn btn--icon" type="button" data-picker-close
                  aria-label="${esc(t('common.cancel'))}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </div>
        <div class="inventory-booking-picker__nav">
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
          <div class="inventory-booking-picker__role-footer">
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

function trackedDateRowHtml({ label = '', date = '', reminder_offset_days = 30 } = {}) {
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
    return {
      label: row.querySelector('.js-tracked-date-label').value.trim(),
      date: row.querySelector('.js-tracked-date-date').value || null,
      reminder_offset_days: rawOffset === '' || !Number.isFinite(offset) ? 30 : offset,
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
        <label class="form-label" for="inv-name">${esc(t('common.nameLabel'))}</label>
        <input id="inv-name" class="form-input" type="text" required placeholder="${esc(t('inventory.namePlaceholder'))}">
      </div>
      <div class="inventory-form-row">
        <div class="form-group">
          <label class="form-label" for="inv-category">${esc(t('inventory.categoryLabel'))}</label>
          <select id="inv-category" class="form-input">${categoryOptions}</select>
        </div>
        <div class="form-group">
          <label class="form-label" for="inv-location">${esc(t('inventory.locationLabel'))}</label>
          <select id="inv-location" class="form-input">${locationOptions.join('')}</select>
        </div>
      </div>
      <div class="inventory-form-row">
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
      ${!isEdit ? `
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
      ${isEdit ? `
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
            <input class="sr-only" id="inv-photo" type="file" accept="image/png,image/jpeg,image/webp">
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
        <div class="inventory-form-row">
          <div class="form-group">
            <label class="form-label" for="inv-brand">${esc(t('inventory.brandLabel'))}</label>
            <input id="inv-brand" class="form-input" type="text">
          </div>
          <div class="form-group">
            <label class="form-label" for="inv-model">${esc(t('inventory.modelLabel'))}</label>
            <input id="inv-model" class="form-input" type="text">
          </div>
        </div>
        <div class="inventory-form-row">
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
        <div class="inventory-form-row">
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
      { open: isEdit && (!!item.brand || !!item.model || !!item.serial_number || !!item.notes || !!item.photo_data || (item.attachments?.length ?? 0) > 0) })}
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
    if (isEdit) {
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
          renderList();
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
          renderList();
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
    } else {
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
  const form = buildItemForm({ mode, item });
  openSharedModal({ title: form.title, size: 'md', content: form.content, onSave: form.wire });
}

async function saveItem(panel, mode, item, attachments, pickedBooking, photoData) {
  const saveBtn = panel.querySelector('#inv-save');
  const nameInput = panel.querySelector('#inv-name');
  const name = nameInput.value.trim();
  if (!name) { reportFieldError(nameInput, t('common.nameRequired')); return; }

  const priceRaw = panel.querySelector('#inv-purchase-price').value.trim();
  const warrantyRaw = panel.querySelector('#inv-warranty').value.trim();

  const payload = {
    name,
    category: panel.querySelector('#inv-category').value,
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
  };

  saveBtn.disabled = true;
  try {
    if (attachments) payload.attachment_document_ids = await attachments.commit();
    if (pickedBooking) payload.entry_id = pickedBooking.entry.id;
    if (mode === 'create') await api.post('/inventory/items', payload);
    else await api.put(`/inventory/items/${item.id}`, payload);
    await loadItems();
    closeSharedModal({ force: true });
    renderList();
    updateAttentionBadge();
    window.yuvomi?.showToast(mode === 'create' ? t('inventory.created') : t('inventory.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

async function removeItem(item) {
  const ok = await confirmModal(t('inventory.deleteConfirm', { name: item.name }), {
    danger: true,
    detail: t('inventory.deleteConfirmDetail'),
  });
  if (!ok) return;
  try {
    await api.delete(`/inventory/items/${item.id}`);
    await loadItems();
    renderList();
    updateAttentionBadge();
    window.yuvomi?.showToast(t('inventory.deleted'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

export async function render(container) {
  _container = container;

  const page = document.createElement('div');
  // app-page--data: die Seite setzt --layout-content; die Zeilentraeger lesen
  // es (Guard in test-frontend-audit.js). Ohne die Rolle enden Kopf und
  // Bedienzeilen neben ihrem eigenen Koerper. Die Regel kam mit v2.8.0, also
  // nach der Basis, auf der dieser Zweig gebaut wurde.
  page.className = 'inventory-page app-page app-page--data';
  page.dataset.composition = 'data';

  // Sichtbarer Seitentitel statt sr-only: nur ein echtes .page-toolbar__title
  // loest das Absender-Siegel der Shell aus (router.js#wireToolbar,
  // headSealIcon), das jedes andere Modul schon automatisch zeigt - Icon +
  // Name, direkt vor dem Titel, aus derselben Quelle wie der Sidebar-Eintrag.
  const toolbar = document.createElement('div');
  toolbar.className = 'page-toolbar page-toolbar--narrow page-toolbar--wrap';
  toolbar.insertAdjacentHTML('beforeend', `
    <div class="page-toolbar__actions">
      <button class="btn btn--ghost btn--icon" data-action="manage-locations"
              aria-label="${esc(t('inventory.manageLocations'))}" title="${esc(t('inventory.manageLocations'))}">
        <i data-lucide="map-pin" class="icon-md" aria-hidden="true"></i>
      </button>
      <button class="btn btn--ghost btn--icon" data-action="manage-categories"
              aria-label="${esc(t('inventory.manageCategories'))}" title="${esc(t('inventory.manageCategories'))}">
        <i data-lucide="tags" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>`);
  toolbar.insertAdjacentHTML('afterbegin', `
    <div class="page-toolbar__center">
      ${renderPageSearch({
        id: 'inventory-search',
        label: t('inventory.searchPlaceholder'),
        placeholder: t('inventory.searchPlaceholder'),
        value: state.query,
        clearLabel: t('common.searchClear'),
        className: 'inventory-search',
      })}
    </div>`);
  toolbar.insertAdjacentHTML('afterbegin', `<h1 class="page-toolbar__title">${esc(t('nav.inventory'))}</h1>`);

  const filters = document.createElement('div');
  filters.className = 'inventory-filters';
  filters.id = 'inventory-filters';
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', t('inventory.filterGroupLabel'));
  filters.hidden = true;

  const list = document.createElement('div');
  list.className = 'inventory-list';
  list.id = 'inventory-list';
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 4, lines: 2 }));

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

  page.append(toolbar, filters, list, fab);
  container.replaceChildren(page);

  if (window.lucide) window.lucide.createIcons({ el: container });

  toolbar.querySelector('[data-action="manage-locations"]').addEventListener('click', openLocationManager);
  toolbar.querySelector('[data-action="manage-categories"]').addEventListener('click', openCategoryManager);

  _search = wirePageSearch(toolbar, {
    id: 'inventory-search',
    onQuery: (value) => { state.query = value.trim(); renderList(); },
  });

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    const next = chip.dataset.filter === 'attention';
    if (next === state.filterAttention) return;
    state.filterAttention = next;
    renderList();
  });
  wireScrollFade(filters);

  fab.addEventListener('click', () => openItemModal('create'));

  try {
    await Promise.all([
      loadLocations(),
      loadCategories(),
      loadItems(),
      api.get('/preferences').then((res) => { _householdCurrency = res.data?.currency ?? 'EUR'; }).catch(() => {}),
    ]);
    renderList();
    updateAttentionBadge();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    list.replaceChildren();
  }
}

export const __test = {
  categoryLabel,
  itemCategoryLabel,
  categoryOptionsHtml,
};
