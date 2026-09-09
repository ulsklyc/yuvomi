/**
 * Modul: Vorrat (Pantry)
 * Zweck: Bestand, Lagerort und Mindesthaltbarkeit der Vorräte verwalten (#596)
 * Abhängigkeiten: /api.js
 *
 * Die vierte Seite des Küchen-Kreislaufs: Mahlzeiten planen, Rezepte kochen,
 * Einkauf besorgen - und hier steht, was tatsächlich im Haus ist.
 */

import { api } from '/api.js';
import { t, getFormatLocale, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import {
  openModal as openSharedModal,
  closeModal as closeSharedModal,
  advancedSection,
  wireBlurValidation,
  reportFieldError,
} from '/components/modal.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer } from '/utils/kitchen-transfer.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
// Alias, weil dieses Modul selbst eine `emptyStateEl()`-Funktion hat, die den
// Renderer mit den Vorrats-Texten füllt.
import { emptyStateEl as emptyStateComponentEl, mountLoadError } from '/utils/empty-state.js';
import { scheduleUndoableDelete, vibrate, wireScrollFade } from '/utils/ux.js';
import { todayKey } from '/utils/date.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';
import { locationLabel } from '/utils/pantry-locations.js';
import { setBulkPill, clearBulkPill } from '/utils/bulk-pill.js';
import { PANTRY_UNITS, normalizePantryQuantity, pantryUnitStep } from '/utils/pantry-units.js';
import {
  PANTRY_FILTERS,
  daysUntil,
  matchesPantryFilter,
  pantryFilterCounts,
  pantryItemStatus,
} from '/utils/pantry-status.js';

let _container = null;
/** Handle des geteilten Suchfelds (setValue/clear), gesetzt in render(). */
let _search = null;

const state = {
  items: [],
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

/** Ausstehende Mengen-PATCHes je Artikel (Stepper-Entprellung). */
const pendingQuantity = new Map();
const QUANTITY_DEBOUNCE_MS = 450;
/** Monotone Folgenummer, die überholte PATCH-Antworten erkennbar macht. */
let _quantitySeq = 0;

// --------------------------------------------------------
// Formatierung
// --------------------------------------------------------

/**
 * Menge ohne überflüssige Nachkommastellen: 2 bleibt "2", 2,5 wird lokalisiert.
 * getFormatLocale() statt getLocale() - die Zahlenformat-Präferenz ist von der
 * UI-Sprache entkoppelt (#521).
 */
function formatQuantity(value) {
  return new Intl.NumberFormat(getFormatLocale(), { maximumFractionDigits: 2 }).format(Number(value) || 0);
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

function quantityText(item) {
  return `${formatQuantity(item.quantity)} ${unitLabel(item.unit)}`;
}

/**
 * Ablauf-Badge als { text, tone } oder null. Bewusst nur für abgelaufen/bald:
 * ein Badge auf jeder Zeile wäre Ornament und würde genau die Zeilen entwerten,
 * die wirklich Aufmerksamkeit brauchen.
 */
function expiryBadge(item) {
  const { expiry } = pantryItemStatus(item, state.todayKey);
  if (!expiry) return null;

  const days = daysUntil(item.expires_on, state.todayKey);
  if (expiry === 'expired') {
    return {
      tone: 'danger',
      text: days === -1 ? t('pantry.badgeExpiredYesterday') : t('pantry.badgeExpiredDays', { count: Math.abs(days) }),
    };
  }
  if (days === 0) return { tone: 'warning', text: t('pantry.badgeExpiresToday') };
  if (days === 1) return { tone: 'warning', text: t('pantry.badgeExpiresTomorrow') };
  return { tone: 'warning', text: t('pantry.badgeExpiresDays', { count: days }) };
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
  const res = await api.get('/pantry');
  state.items = res.data ?? [];
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

function visibleItems() {
  const q = state.query.toLowerCase();
  return state.items.filter((item) => {
    if (!matchesPantryFilter(item, state.filter, state.todayKey)) return false;
    if (!q) return true;
    return item.name?.toLowerCase().includes(q)
      || item.notes?.toLowerCase().includes(q)
      || (item.location_name && locationLabel(item.location_name).toLowerCase().includes(q));
  });
}

/**
 * Ohne Filter nach Lagerort gruppiert („wo liegt was?"). Sobald ein Filter
 * aktiv ist, ist der Ort nicht mehr die Frage - dann ist eine flache, nach
 * Dringlichkeit sortierte Liste die ehrlichere Antwort. Der Ort wandert in
 * die Meta-Zeile und geht dabei nicht verloren.
 */
function groupedItems(items) {
  if (state.filter !== 'all') {
    const flat = [...items];
    if (state.filter === 'expired' || state.filter === 'soon') {
      flat.sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
    } else {
      flat.sort((a, b) => Number(a.quantity) - Number(b.quantity));
    }
    return [{ key: 'flat', label: null, items: flat }];
  }

  const byLocation = new Map();
  for (const item of items) {
    const key = item.location_id ?? 'none';
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key).push(item);
  }

  const groups = [];
  for (const loc of state.locations) {
    const rows = byLocation.get(loc.id);
    if (rows?.length) groups.push({ key: loc.id, label: locationLabel(loc.name), icon: loc.icon, items: rows });
  }
  const orphans = byLocation.get('none');
  if (orphans?.length) {
    groups.push({ key: 'none', label: t('pantry.unlocated'), icon: 'package', items: orphans });
  }
  return groups;
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

export async function render(container) {
  _container = container;
  state.todayKey = todayKey();
  // Frische Seite: die Chip-Leiste darf beim ersten Zeichnen wieder scrollen.
  _scrolledFilter = null;

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
  // --narrow: der Kopf endet beim Lesemaß der Liste darunter (.list-scroller),
  // nicht an der Content-Spalte. Siehe layout.css.
  toolbar.className = 'page-toolbar page-toolbar--in-group page-toolbar--narrow';
  toolbar.insertAdjacentHTML('beforeend', `
    <div class="page-toolbar__center">
      ${renderPageSearch({
        id: 'pantry-search',
        // Label und Placeholder aus demselben Key: „Vorrat durchsuchen" benennt
        // das Feld vollständig, wie in notes/contacts/documents. Ein eigener
        // Label-Key wäre ein Schlüssel über 23 Locales ohne zusätzliche Aussage.
        label: t('pantry.searchPlaceholder'),
        placeholder: t('pantry.searchPlaceholder'),
        value: state.query,
        clearLabel: t('common.searchClear'),
        className: 'pantry-search',
      })}
    </div>
    <div class="page-toolbar__actions">
      <button class="btn btn--ghost btn--icon" data-action="manage-locations"
              aria-label="${esc(t('pantry.manageLocations'))}" title="${esc(t('pantry.manageLocations'))}">
        <i data-lucide="archive" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>`);

  const filters = document.createElement('div');
  filters.className = 'pantry-filters';
  filters.id = 'pantry-filters';

  // Hier stand der Slot für die Sammelaktions-Leiste. Sie ist seit Etappe 5
  // eine Pille in der unteren Shell-Zone (utils/bulk-pill.js) und braucht in
  // dieser Seite gar keinen Platz mehr - weder im Scroller, wo sie bis
  // 2026-07-30 wegscrollte, noch darüber, wo sie eine Zeile kostete.

  const list = document.createElement('div');
  list.className = 'list-scroller page-scrollport pantry-list';
  list.id = 'pantry-list';
  list.setAttribute('aria-busy', 'true');
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));

  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.id = 'fab-new-pantry-item';
  fab.setAttribute('aria-label', t('pantry.addItem'));
  fab.dataset.dockLabel = t('newLabel.pantry');
  fab.insertAdjacentHTML('beforeend', '<i data-lucide="plus" aria-hidden="true"></i>');

  page.append(title, live, toolbar, filters, list, fab);
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

  toolbar.querySelector('[data-action="manage-locations"]').addEventListener('click', openLocationManager);
  fab.addEventListener('click', () => openItemModal('create'));

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderFilters();
    renderList();
  });

  list.addEventListener('click', onListClick);

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

  const counts = pantryFilterCounts(state.items, state.todayKey);
  const active = PANTRY_FILTERS.filter((key) => counts[key] > 0);

  // Der aktive Filter hat gerade seinen letzten Treffer verloren → zurück auf Alle.
  const previousFilter = state.filter;
  if (state.filter !== 'all' && !active.includes(state.filter)) state.filter = 'all';
  const wasReset = state.filter !== previousFilter;

  // replaceChildren zerstört den fokussierten Chip; ohne Rettung landet der
  // Tastatur-Fokus auf <body> und der Tab-Weg beginnt wieder ganz oben.
  const hadFocus = bar.contains(document.activeElement);

  bar.replaceChildren();
  if (!active.length || !state.items.length) {
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

  bar.insertAdjacentHTML('beforeend', chips.map((chip) => `
    <button type="button" class="filter-chip${chip.id === state.filter ? ' filter-chip--active' : ''}"
            data-filter="${esc(chip.id)}" aria-pressed="${chip.id === state.filter}">
      <i data-lucide="${esc(chip.icon)}" class="icon-sm" aria-hidden="true"></i>
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
  if (state.filter !== 'low' || !state.items.length || !items.length) {
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

function renderList() {
  const list = _container?.querySelector('#pantry-list');
  if (!list) return;
  list.removeAttribute('aria-busy');
  list.replaceChildren();
  renderBulkBar();

  if (!state.items.length) {
    list.appendChild(emptyStateEl());
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  const items = visibleItems();
  // Filtern und Suchen ändern die Liste, ohne dass sich der Fokus bewegt -
  // ohne Ansage bleibt die neue Trefferzahl für Screenreader unsichtbar.
  if (state.filter !== 'all' || state.query) {
    announce(t('pantry.resultCount', { count: items.length }));
  }

  if (!items.length) {
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

  for (const group of groupedItems(items)) {
    const section = document.createElement('section');
    // Geteilte Gruppen-Grammatik (styles/list-row.css): die Gruppe trägt die
    // weiße Fläche, die Zeilen darin nur Trennlinien.
    section.className = 'list-group pantry-group';

    if (group.label) {
      const heading = document.createElement('h2');
      heading.className = 'list-group__title';
      heading.insertAdjacentHTML('beforeend',
        `<i data-lucide="${esc(group.icon || 'package')}" class="icon-sm" aria-hidden="true"></i>`);
      const name = document.createElement('span');
      name.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'list-group__count';
      count.textContent = String(group.items.length);
      heading.append(name, count);
      section.appendChild(heading);
    }

    const rows = document.createElement('ul');
    rows.className = 'list-rows pantry-rows';
    for (const item of group.items) rows.appendChild(rowEl(item));
    section.appendChild(rows);
    list.appendChild(section);
  }

  if (window.lucide) window.lucide.createIcons({ el: list });
}

/**
 * Kein Treffer für Suche und/oder Filter. Benennt beide Ursachen, statt nur die
 * Suche zu erwähnen: war zusätzlich ein Filter aktiv, blieb er vorher unsichtbar
 * und der Nutzer suchte den Fehler beim Suchbegriff.
 */
function noResultsEl() {
  const active = [];
  if (state.query) active.push(`„${state.query}"`);
  if (state.filter !== 'all') {
    active.push(t({ expired: 'pantry.filterExpired', soon: 'pantry.filterSoon', low: 'pantry.filterLow' }[state.filter]));
  }

  return emptyStateComponentEl({
    variant: 'no-results',
    title: t('pantry.noResultsTitle'),
    description: t('pantry.noResultsDescription'),
    hint: active.length ? active.join(' · ') : undefined,
    action: {
      label: t('pantry.resetFilters'),
      onClick: () => {
        state.query = '';
        state.filter = 'all';
        // clear() versteckt zugleich den Leeren-Knopf des geteilten Suchfelds;
        // ein blankes `value = ''` ließe ihn über dem leeren Feld stehen.
        _search?.clear();
        renderFilters();
        renderList();
        _search?.input.focus();
      },
    },
  });
}

function emptyStateEl() {
  return emptyStateComponentEl({
    icon: 'archive',
    title: t('pantry.emptyTitle'),
    description: t('pantry.emptyDescription'),
    hint: t('emptyHint.pantry'),
    action: {
      label: t('pantry.emptyAction'),
      icon: 'plus',
      onClick: () => openItemModal('create'),
    },
  });
}

/** Eine Vorratszeile. */
function rowEl(item) {
  const status = pantryItemStatus(item, state.todayKey);

  const li = document.createElement('li');
  // Geteilte Zeilen-Grammatik (styles/list-row.css). Ohne --reserve-end: der
  // Warenkorb sitzt nicht mehr an der Zeilenkante, sondern in einem festen Slot
  // am Anfang der Bedienzone (siehe unten).
  li.className = 'list-row pantry-row';
  li.dataset.id = String(item.id);
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
  main.dataset.action = 'edit';

  // Name und Status in EINER Zeile: das Badge qualifiziert den Artikel, es ist
  // keine eigene Information. Auf einer eigenen Zeile wuchs jede betroffene
  // Zeile um ~25px, während rechts neben dem Namen Platz frei blieb.
  const headline = document.createElement('span');
  headline.className = 'pantry-row__headline';

  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = item.name;
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
  if (item.expires_on) {
    const expiry = document.createElement('span');
    expiry.className = 'pantry-row__expiry';
    expiry.textContent = ` · ${t('pantry.bestBefore', { date: formatDate(item.expires_on) })}`;
    meta.appendChild(expiry);
  }
  // Im gefilterten (flachen) Modus trägt die Meta-Zeile den Lagerort, den sonst
  // die Gruppen-Überschrift zeigt.
  if (state.filter !== 'all') {
    const place = document.createElement('span');
    place.className = 'pantry-row__place';
    place.textContent = ` · ${item.location_name ? locationLabel(item.location_name) : t('pantry.unlocated')}`;
    meta.appendChild(place);
  }
  main.appendChild(meta);

  // Was der Button tut - nur für Screenreader, am Ende des Namens.
  const action = document.createElement('span');
  action.className = 'sr-only';
  action.textContent = t('common.edit');
  main.appendChild(action);

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
  if (status.out || status.low) cartSlot.appendChild(cartEl(item));
  actions.appendChild(cartSlot);

  const stepper = document.createElement('div');
  stepper.className = 'pantry-stepper';
  const step = pantryUnitStep(item.unit);

  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'pantry-stepper__btn';
  minus.dataset.action = 'decrease';
  minus.disabled = Number(item.quantity) <= 0;
  minus.setAttribute('aria-label', `${t('pantry.decrease')}: ${item.name}`);
  minus.insertAdjacentHTML('beforeend', '<i data-lucide="minus" class="icon-sm" aria-hidden="true"></i>');

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
  plus.setAttribute('aria-label', `${t('pantry.increase')}: ${item.name}`);
  plus.insertAdjacentHTML('beforeend', '<i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>');

  stepper.dataset.step = String(step);
  stepper.append(minus, plus);
  actions.appendChild(stepper);

  // Name zuerst, Bedienung danach: eine Vorratsliste wird nach Namen gescannt,
  // nicht nach Zahlen. Vorher las sich die Zeile „− 500 g + Naturjoghurt" und
  // damit gegen die Leserichtung und gegen alle drei Geschwistermodule, die
  // ausnahmslos mit dem Namen führen. Nebeneffekt: die Namenskante steht jetzt
  // von selbst, statt mit der Stepper-Breite zu wandern (Critique 2026-07-29).
  li.append(main, actions);
  return li;
}

/** Kontextuelle Einkaufs-Aktion einer Zeile; nur bei leeren/knappen Artikeln. */
function cartEl(item) {
  const cart = document.createElement('button');
  cart.type = 'button';
  cart.className = 'row-action pantry-row__cart';
  cart.dataset.action = 'to-shopping';
  cart.setAttribute('aria-label', `${t('common.toShoppingList')}: ${item.name}`);
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
  const row = btn.closest('.pantry-row[data-id]');
  if (!row) return;
  const item = state.items.find((i) => i.id === Number(row.dataset.id));
  if (!item) return;

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
  const step = Number(row.querySelector('.pantry-stepper')?.dataset.step) || 1;
  const previous = Number(item.quantity);
  const next = normalizePantryQuantity(previous + direction * step, { fallback: previous });
  if (next === previous) return;

  item.quantity = next;
  vibrate(8);
  refreshRowQuantity(row, item);
  if (renderFilters().wasReset) renderList();

  const pending = pendingQuantity.get(item.id);
  if (pending) clearTimeout(pending.timer);
  // Rollback ist der letzte serverbestätigte Wert, nicht der letzte optimistische:
  // der Eintrag bleibt bis zum Settle in der Map, deshalb überlebt er auch einen
  // Tap während des laufenden Requests.
  const rollback = pending?.rollback ?? previous;
  const seq = ++_quantitySeq;

  const timer = setTimeout(async () => {
    try {
      const res = await api.patch(`/pantry/${item.id}`, { quantity: item.quantity });
      // Überholte Antwort verwerfen. Ohne diese Prüfung überschrieb eine
      // langsame Antwort den neueren optimistischen Stand, die Menge sprang
      // sichtbar zurück und der nächste PATCH schrieb die veraltete Zahl fest.
      if (pendingQuantity.get(item.id)?.seq !== seq) return;
      pendingQuantity.delete(item.id);
      Object.assign(item, res.data);
      refreshRowQuantity(row, item);
    } catch (err) {
      if (pendingQuantity.get(item.id)?.seq !== seq) return;
      pendingQuantity.delete(item.id);
      item.quantity = rollback;
      // Die Seite wurde inzwischen verlassen: kein Zurückzeichnen einer
      // abgehängten Zeile und kein Vorrats-Toast auf einer fremden Seite.
      if (!row.isConnected) return;
      refreshRowQuantity(row, item);
      if (renderFilters().wasReset) renderList();
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  }, QUANTITY_DEBOUNCE_MS);

  // `flush` schickt den gedebouncten Wert sofort ab, wenn die Seite verschwindet.
  pendingQuantity.set(item.id, {
    timer,
    rollback,
    seq,
    flush: () => {
      clearTimeout(timer);
      pendingQuantity.delete(item.id);
      // keepalive: der Request muss den Seitenwechsel überleben. Ohne ihn
      // bricht der Browser ihn mit dem Dokument ab.
      api.patch(`/pantry/${item.id}`, { quantity: item.quantity }, { keepalive: true })
        .catch(() => { /* Die Seite ist weg; ein Toast hätte kein Ziel mehr. */ });
    },
  });
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
    for (const entry of [...pendingQuantity.values()]) entry.flush?.();
  });
}

/** Sagt eine Bestandsänderung über die eine geteilte Live-Region der Seite an. */
function announce(message) {
  const region = _container?.querySelector('#pantry-live');
  if (region) region.textContent = message;
}

/** Aktualisiert Menge, Badges und Leer-Zustand einer Zeile ohne Listen-Rebuild. */
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

  if (window.lucide) window.lucide.createIcons({ el: row });
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
  return `${formatQuantity(missing)} ${unitLabel(item.unit)}`;
}

async function sendToShopping(items, btn) {
  if (!items.length) return;

  let lists;
  try {
    lists = await ensureLists();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
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
      items: items.map((item) => ({ pantry_item_id: item.id, quantity: shortfallText(item) })),
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
    const message = skipped
      ? `${t('pantry.toShoppingDone', { count: added, list: target.name })} ${t('pantry.toShoppingSkipped', { count: skipped })}`
      : t('pantry.toShoppingDone', { count: added, list: target.name });

    // Meldung, Standzeit, Tab-Zahl und Rücknahme kommen aus dem geteilten
    // Baustein. Der Warenkorb ist der Pfad, den man am leichtesten versehentlich
    // nimmt - er sitzt in der Zeile direkt neben „Menge erhöhen", und die beiden
    // bedeuten das Gegenteil voneinander (Critique 2026-07-30).
    announceTransfer({ message, addedIds });
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --------------------------------------------------------
// Artikel-Formular
// --------------------------------------------------------

function openItemModal(mode, item = null) {
  const isEdit = mode === 'edit';
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
    title: isEdit ? t('common.editItem') : t('pantry.addItem'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="pantry-name">${esc(t('common.nameLabel'))}</label>
        <input id="pantry-name" class="form-input" type="text" required
               placeholder="${esc(t('pantry.namePlaceholder'))}">
      </div>
      <div class="pantry-form-row">
        <div class="form-group">
          <label class="form-label" for="pantry-quantity">${esc(t('pantry.quantityLabel'))}</label>
          <input id="pantry-quantity" class="form-input" type="number" min="0" step="any" inputmode="decimal">
        </div>
        <div class="form-group">
          <label class="form-label" for="pantry-unit">${esc(t('pantry.unitLabel'))}</label>
          <select id="pantry-unit" class="form-input">${unitOptions}</select>
        </div>
      </div>
      <div class="pantry-form-row">
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
        ${isEdit ? `<button type="button" class="btn btn--danger-ghost pantry-form__delete" id="pantry-delete">${esc(t('common.delete'))}</button>` : ''}
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
      });

      wireBlurValidation(panel);
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

async function saveItem(panel, mode, item) {
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
    await loadPantry();
    closeSharedModal({ force: true });
    renderFilters();
    renderList();
    window.yuvomi?.showToast(mode === 'create' ? t('pantry.created') : t('pantry.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

async function removeItem(item) {
  const rowEl_ = _container?.querySelector(`.pantry-row[data-id="${item.id}"]`);
  if (rowEl_) rowEl_.style.display = 'none';

  scheduleUndoableDelete({
    message: t('pantry.deleted'),
    commit: async ({ keepalive }) => {
      await api.delete(`/pantry/${item.id}`, { keepalive });
      if (keepalive) return;
      state.items = state.items.filter((i) => i.id !== item.id);
      renderFilters();
      renderList();
    },
    restore: (err) => {
      if (rowEl_) rowEl_.style.display = '';
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

// --------------------------------------------------------
// Lagerort-Verwaltung
// --------------------------------------------------------

async function openLocationManager() {
  await import('/components/category-manager.js');

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
    } catch (err) {
      // NICHT „meldet der Manager selbst": der quittiert nur seine eigene
      // Mutation, und `_notifyChanged()` kommt erst nach deren Erfolg. Was hier
      // ankommt, ist immer ein Fehler DIESER Auffrischung - und der erklaert als
      // einziger, warum die Seite den alten Stand behaelt.
      console.error('[Pantry] Auffrischen nach Ort-Aenderung fehlgeschlagen:', err);
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
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
