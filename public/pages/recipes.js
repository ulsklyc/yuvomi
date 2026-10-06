/**
 * Modul: Rezepte (Recipes)
 * Zweck: Gespeicherte Rezepte verwalten und in den Essensplan uebernehmen
 */

import { api } from '/api.js';
import { t, formatDate, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, advancedSection, wireBlurValidation, reportFieldError, refocusAfterRender } from '/components/modal.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer, mayTransferRecipeToShopping } from '/utils/kitchen-transfer.js';
import { popoverMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import { ingredientRowHTML } from '/utils/ingredient-row.js';
import { scheduleUndoableDelete, expandIn, collapseOut } from '/utils/ux.js';
import { normalizeRecipeMealTypes, RECIPE_MEAL_TYPE_KEYS } from '/utils/recipe-meal-types.js';
import { mealPayloadFromRecipe } from '/utils/recipe-to-meal.js';
import { todayKey } from '/utils/date.js';
import '/components/datepicker.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { mountEmptyState, mountLoadError } from '/utils/empty-state.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { mealTypeList, ensureMealTypeNames } from '/utils/meal-types.js';
import { recipeThumbEl, recipeHeroEl } from '/utils/recipe-thumb.js';
import { navModuleAccess } from '/permissions.js';
import { mountMasterDetail, splitViewDetailHtml, detailPaneHeaderEl } from '/utils/master-detail.js';
import { mayWritePath } from '/utils/module-access.js';

let _container = null;
/** Handle des geteilten Suchfelds (setValue/clear), gesetzt in render(). */
let _search = null;
/** Handle von Liste + Detail (utils/master-detail.js), gesetzt in render(). */
let _md = null;

const state = {
  recipes: [],
  categories: [],
  // Einkaufslisten für „Auf die Einkaufsliste": nur die Auswahl, keine Artikel.
  lists: [],
  query: '',
  /** Gefangener Fehler des letzten Rezept-Ladevorgangs, sonst null. */
  loadError: null,
  // 'all' | 'native' | 'mealie' | 'tandoor' | ... - Filter-Pille ist nur
  // sichtbar, sobald mindestens ein gespiegeltes Rezept existiert (siehe
  // renderSourceFilter).
  sourceFilter: 'all',
  // Rezept-IDs, die im Wochenplan der AKTUELLEN Woche stehen (loadPlannedRecipes).
  plannedRecipeIds: new Set(),
};

/**
 * Darf dieses Konto Rezepte schreiben? Regel 1 in utils/module-access.js
 * (`/recipes` gehoert dem Scope-Modul `meals`). Als Funktion, damit jedes
 * Neuzeichnen neu fragt.
 *
 * WAS BEI `read` BLEIBT: Suche, Quellenfilter, die Zeile mit Bild, Herkunft,
 * Zutatenzahl und „Diese Woche geplant" - und der Tipp auf sie. Der fuehrt
 * hier schon immer in eine Leseansicht: den Aufklapper der Zeile bzw. die
 * Detailspalte. Was sonst nur im Formular stand (die Mahlzeiten, wenn alle
 * gelten, und die Einkaufskategorie je Zutat), steht bei `read` deshalb DORT -
 * einen eigenen Lese-Dialog gibt es nicht (Regel 9, zweiter Absatz).
 * WAS GEHT: Anlegen (FAB, Leerzustand), Bearbeiten, Duplizieren, Loeschen in
 * Zeile, Ueberlaufmenue und Detailkopf, „In den Essensplan" und die
 * Vorrats-Zuordnung. „AUF DIE EINKAUFSLISTE" FOLGT NICHT DIESEM RECHT: der
 * Server senkt den Pfad-Guard dafuer auf `meals: read` und verlangt
 * `shopping: write` (Regel 8, `mayTransferRecipeToShopping()`) - mit
 * `meals: read` und `shopping: write` bleibt der Knopf also stehen.
 *
 * KEIN WANDTABLETT: siehe readOnly() in meals.js.
 */
function readOnly() {
  return !mayWritePath('/recipes');
}

/**
 * „In den Essensplan" legt eine Mahlzeit an (`POST /meals`). Dasselbe
 * Scope-Modul wie die Rezepte, gefragt wird trotzdem mit dem Pfad, den der
 * Knopf schreibt (Regel 1).
 */
function mayPlanRecipe() {
  return mayWritePath('/meals');
}

/**
 * Die `data-action`s der Seite, die NICHT in die Kueche schreiben - eine
 * Positivliste wie in pantry.js: eine morgen ergaenzte Schreib-Aktion ist bei
 * `read` zu, bis sie hier ausdruecklich steht. `to-shopping` schreibt in den
 * Einkauf und traegt seinen eigenen Riegel (`transferRecipe`).
 */
const READ_SAFE_ACTIONS = new Set(['toggle-detail', 'to-shopping']);

// Client-seitige Suche über Titel, Notizen und Zutaten (Audit A1-21):
// die Rezeptliste ist vollständig geladen, ein Server-Roundtrip wäre Umweg.
function filteredRecipes() {
  const q = state.query.toLowerCase();
  return state.recipes.filter((r) => {
    if (state.sourceFilter !== 'all' && r.source !== state.sourceFilter) return false;
    if (!q) return true;
    return r.title?.toLowerCase().includes(q)
      || r.notes?.toLowerCase().includes(q)
      || (r.ingredients ?? []).some((i) => i.name?.toLowerCase().includes(q));
  });
}

function mealCategories() {
  return state.categories.filter((c) => c.name !== 'Haushalt' && c.name !== 'Drogerie');
}

// Kleines Badge für gespiegelte Rezepte (source: 'mealie'/'tandoor'/...). Der
// Account-Name als Tooltip hilft bei mehreren Accounts desselben Providers zu
// unterscheiden.
function sourceBadge(recipe) {
  const badge = document.createElement('span');
  badge.className = `source-badge source-badge--${recipe.source}`;
  badge.textContent = t(`recipes.source${recipe.source[0].toUpperCase()}${recipe.source.slice(1)}`);
  if (recipe.provider_account_name) badge.title = recipe.provider_account_name;
  return badge;
}

// Vorschaubild fuer ein gespiegeltes Rezept. Die beiden Faelle - kein Bild beim
// Provider, Bild seit dem letzten Sync verschwunden - stehen samt Begruendung in
// utils/recipe-thumb.js; seit #1059 zeigen auch Planer und Uebersichtskachel
// dasselbe Bild und teilen sich denselben Ruecksturz.
function recipeThumb(recipe) {
  return recipeThumbEl({
    recipeId: recipe.id,
    hasImage: recipe.provider_has_image,
    hasOwnImage: recipe.has_own_image,
    className: 'recipe-row__thumb',
  });
}

/**
 * Traegt die Zeile ein Vorschaubild?
 *
 * DIE FRAGE IST "HAT ES EIN BILD", NICHT "WOHER KOMMT ES" (Critique 2026-10-05,
 * R16). Die Bedingung war `isMirrored`: ein eigenes Rezept bekam im Editor ein
 * Bild, der Wochenplan zeigte es, die Rezeptliste nicht. Gespiegelte Rezepte
 * behalten ihre Regel aus #1059 (Bild oder Platzhalter - die Herkunft ist Teil
 * der Zeile); ein eigenes Rezept ohne Bild bleibt eine Textzeile.
 */
function rowShowsThumb(recipe) {
  return recipe.source !== 'native' || Boolean(recipe.has_own_image);
}

function mealTypeOptions() {
  return mealTypeList().map(({ key, label }) => ({ key, label }));
}

/**
 * Der Ladefehler bleibt im Modul, statt aus `render()` heraus zu propagieren.
 *
 * Vorher hatte diese Funktion als einzige der vier Küchen-Loader kein
 * try/catch: ein HTTP 500 auf `/recipes` riss die gesamte App in den globalen
 * Fehlerbildschirm - Navigation weg, die drei anderen Tabs unerreichbar, obwohl
 * nur eine Liste fehlte (Critique P0, 2026-07-30). Ein Modul, das seine Daten
 * nicht bekommt, darf höchstens sich selbst verlieren.
 */
async function loadRecipes() {
  try {
    const res = await api.get('/recipes');
    state.recipes = res.data ?? [];
    state.loadError = null;
  } catch (err) {
    console.error('[Recipes] loadRecipes Fehler:', err);
    state.recipes = [];
    state.loadError = err;
  }
}

async function loadCategories() {
  try {
    const res = await api.get('/shopping/categories');
    state.categories = res.data;
  } catch {
    state.categories = [];
  }
}

// Ist das Einkaufsmodul deaktiviert oder gibt es keine Liste, bleibt state.lists
// leer und die Karte zeigt die Übernahme-Aktion gar nicht erst an.
async function loadShoppingLists() {
  if (window.yuvomi?.isModuleDisabled?.('shopping')) {
    state.lists = [];
    return;
  }
  try {
    const res = await api.get('/shopping');
    state.lists = res.data ?? [];
  } catch {
    state.lists = [];
  }
}

// „Diese Woche geplant": die Rezepteliste kannte ihren eigenen Wochenplan
// nicht - die Verbindung der beiden Kuechen-Raeume war nur im Meals-Tab
// sichtbar, und die Liste las sich als kontextlose CRUD-Ablage (Critique
// 2026-08-27, P2). Die Zuordnung steht laengst in meals.recipe_id; der Server
// liefert ohne week-Parameter die aktuelle Woche. Ein Fehler laesst die
// Angabe schlicht weg - die Liste haengt nicht an ihr.
async function loadPlannedRecipes() {
  if (window.yuvomi?.isModuleDisabled?.('meals')) {
    state.plannedRecipeIds = new Set();
    return;
  }
  try {
    const res = await api.get('/meals');
    state.plannedRecipeIds = new Set((res.data ?? []).map((m) => m.recipe_id).filter(Boolean));
  } catch {
    state.plannedRecipeIds = new Set();
  }
}

/**
 * Oeffnet das per ?open=<id> benannte Rezept, wenn es in der geladenen Liste steht.
 *
 * Aufklappen statt Bearbeiten: wer aus dem Essensplan kommt, will kochen, nicht
 * aendern - dieselbe Entscheidung wie beim Antippen einer Zeile.
 *
 * Ein Rezept ohne Detailinhalt (keine Zutaten, keine Notiz, keine Quelle) hat
 * gar kein Aufklapp-Panel. Dann bleibt das Scrollen als das, was zu holen ist:
 * die Zeile zeigen, statt still nichts zu tun.
 */
function openRecipeFromQuery() {
  const raw = new URLSearchParams(window.location.search).get('open');
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(id)) return;

  const row = _container?.querySelector(`.recipe-row-item[data-id="${id}"]`);
  if (!row) return;

  // In der Detailspalte hat der Baustein das Rezept beim Einhaengen schon
  // ausgewaehlt - er liest denselben Parameter (`param: 'open'` in
  // mountRecipeDetail). Aufzuklappen gibt es dort nichts: die Liste zeigt
  // keine Aufklapper, das Detail steht rechts.
  if (_md?.isSplit()) {
    row.scrollIntoView({ block: 'nearest' });
    return;
  }

  const toggle = row.querySelector('[data-action="toggle-detail"]');
  const panel = _container.querySelector(`#recipe-detail-${id}`);
  if (toggle && panel) {
    toggle.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
  }
  row.scrollIntoView({ block: 'nearest' });
}

/**
 * Der Anlegeknopf - oder `null` bei `read`: der Knopf steht dann nicht im
 * Markup, statt per CSS (html[data-module-readonly]) nur ausgeblendet zu sein.
 */
function fabEl() {
  if (readOnly()) return null;
  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.id = 'fab-new-recipe';
  fab.setAttribute('aria-label', t('recipes.addRecipe'));
  fab.dataset.dockLabel = t('newLabel.recipes');
  const fabIcon = document.createElement('i');
  fabIcon.dataset.lucide = 'plus';
  fabIcon.setAttribute('aria-hidden', 'true');
  fab.appendChild(fabIcon);
  return fab;
}

export async function render(container, { signal } = {}) {
  _container = container;
  _md = null;

  // `state` ueberlebt den Seitenwechsel. Wer zuletzt nach "Suppe" gesucht oder
  // auf Mealie gefiltert hat, kaeme sonst per Deep-Link auf eine Liste zurueck,
  // in der das verlangte Rezept gar nicht steht - und der Sprung endete
  // wortlos im Nichts. Ein benanntes Ziel schlaegt einen alten Filter, also
  // faellt der weg, und zwar VOR dem Bau des Suchfelds, damit die Zeile darueber
  // nicht einen Begriff zeigt, nach dem die Liste nicht mehr filtert (#936).
  if (new URLSearchParams(window.location.search).has('open')) {
    state.query = '';
    state.sourceFilter = 'all';
  }

  const page = document.createElement('div');
  // `app-page--list-detail`: Regime „Liste + Detail" der Breitenregel
  // (DESIGN.md). Unter der Schwelle bleibt es Lesemass, ab 65rem Modulflaeche
  // steht rechts das ausgewaehlte Rezept (utils/master-detail.js).
  page.className = 'recipes-page app-page app-page--reading app-page--list-detail page-measure--narrow';
  page.dataset.composition = 'reading';

  // sr-only Titel: die geteilte Kitchen-Tabs-Leiste labelt das Modul bereits
  // sichtbar — konsistent mit Mahlzeiten/Einkauf. Der FAB ist die einzige
  // Create-Affordanz (kein redundanter sichtbarer Kopf-Titel mehr).
  const title = document.createElement('h1');
  title.className = 'sr-only';
  title.textContent = t('nav.recipes');

  // Suchfeld über der Liste: Rezepte waren als einziges Kitchen-Modul nicht
  // durchsuchbar (Audit A1-21).
  // Kanonischer Kopf in der Gruppen-Variante: --in-group gibt Akzentstreifen und
  // oberste Sticky-Position an die .kitchen-tabs-bar darüber ab, die beides schon
  // trägt. Genau der Doppelstreifen aus Issue #577 war der Grund, warum diese
  // Zeile vorher als eigene .recipes-toolbar gebaut war - mit dem Ergebnis, dass
  // alle vier Küchen-Tabs eine andere Kopf-Grammatik hatten (Critique
  // 2026-07-29). Die Variante löst den Konflikt, ohne den Kopf zu meiden.
  const toolbar = document.createElement('div');
  // Kein --narrow (Re-Critique 2026-09-27, D3): der Kuechenkopf gehoert der
  // Kuechen-Leiste und endet an ihrer Kante wie in den drei Geschwister-Tabs -
  // sonst sprang die angedockte Primaeraktion beim Tabwechsel zwischen
  // Lesemass (x 865) und Leistenkante (x 1288). Test: test-meals.js (D3).
  toolbar.className = 'page-toolbar page-toolbar--in-group';
  // Geteilter Baustein (utils/page-search.js) statt eines eigenen Inputs. Er
  // bringt Lupe, Leeren-Knopf, `<label for>` und die mobilen Eingabe-Attribute
  // mit; der Nachbau hatte keines davon und ließ den Placeholder die
  // Beschriftung tragen, die beim ersten Zeichen verschwindet.
  // Die Suche IST der Center-Slot (Re-Critique 2026-09-27, D4): Breite und
  // Stelle traegt page-search.css, wie in Dokumenten - kein Wrapper, keine
  // Modulbreite.
  toolbar.insertAdjacentHTML('beforeend', renderPageSearch({
    id: 'recipes-search',
    // Label und Placeholder aus demselben Key, wie im Vorrat und in den drei
    // Referenzmodulen: „Rezepte durchsuchen" benennt das Feld vollständig.
    label: t('recipes.searchPlaceholder'),
    placeholder: t('recipes.searchPlaceholder'),
    value: state.query,
    clearLabel: t('common.searchClear'),
    className: 'recipes-search page-toolbar__center',
  }));

  // Trigger im __actions-Slot statt einer eigenen Pillen-Zeile darunter -
  // dieselbe Behandlung wie „Lagerorte verwalten" im Vorrat (btn--icon im
  // Kopf, kein zusätzliches Kopf-Element). Die frühere Chip-Reihe brauchte auf
  // schmalen Bildschirmen eine ganze eigene Zeile, nur für drei Optionen, von
  // denen fast immer "Alle" aktiv ist. Nur sichtbar, sobald mindestens ein
  // gespiegeltes Rezept existiert (renderSourceFilter füllt/versteckt sie nach
  // dem Laden).
  //
  // SLOT UND FILTER SIND ZWEI KNOTEN. In `.page-toolbar__actions` dockt der
  // Router auf dem Desktop den FAB an (dockFabIntoToolbar in router.js). Solange
  // der Slot selbst der Filter war, stand der „Neues Rezept"-Knopf ohne
  // gespiegelte Rezepte in einem `hidden`-Container, und mit ihnen warf
  // renderSourceFilter() ihn per replaceChildren() aus dem DOM. Der Slot wird
  // deshalb nie ausgeblendet und nie geleert; der Filter hat seinen eigenen
  // Container darin (test:hidden-cascade haelt beides).
  const actions = document.createElement('div');
  actions.className = 'page-toolbar__actions';
  const sourceFilter = document.createElement('div');
  sourceFilter.className = 'recipes-source-filter';
  sourceFilter.id = 'recipes-source-filter';
  sourceFilter.hidden = true;
  actions.appendChild(sourceFilter);
  toolbar.appendChild(actions);

  const list = document.createElement('div');
  list.className = 'list-scroller page-scrollport recipes-list split-view__list';
  list.id = 'recipes-list';
  // Lade-Skeleton bis loadRecipes() aufgelöst ist (Router blendet den Wrapper
  // bereits vor dem Daten-await ein).
  list.setAttribute('aria-busy', 'true');
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 5, lines: 2 }));
  // Kein wireScrollFade mehr: die Liste kachelt nicht länger mit 320px-Mindest-
  // breite, sondern ist eine Zeilenliste in der 720er-Lesespalte. Der frühere
  // 32px-Überlauf bei 320px war eine Eigenschaft des Rasters und ist mit ihm weg.

  const fab = fabEl();

  // Liste + Detail: der Scrollport wird `.split-view__list` und steht mit der
  // Detailspalte in einer Huelle an seinem bisherigen Platz. Unter der
  // Schwelle ist die Spalte `display: none` und die Huelle eine Flex-Spalte -
  // die Liste steht wie vorher. Der Kuechenkopf (kitchen-tabs) sitzt ausserhalb
  // der Seitenwurzel und laeuft damit ueber beide Spalten.
  const split = document.createElement('div');
  split.className = 'split-view';
  split.appendChild(list);
  split.insertAdjacentHTML('beforeend', splitViewDetailHtml({
    id: 'recipes',
    label: t('recipes.detailPaneLabel'),
    empty: { icon: 'book-text', title: t('recipes.pickOne'), hint: t('recipes.pickOneHint') },
  }));

  page.append(...[title, toolbar, split, fab].filter(Boolean));
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/recipes');
  // Positionierung und Schliessen der Zeilen-Ueberlaufmenues. Idempotent, haengt an
  // der stabilen Seitenwurzel - die Liste darin wird bei jedem Filter neu gebaut.
  installPopoverMenus(page);

  if (window.lucide) window.lucide.createIcons({ el: container });

  await Promise.all([loadRecipes(), loadCategories(), loadShoppingLists(), loadPlannedRecipes(), ensureMealTypeNames()]);
  // Ein Seitenwechsel waehrend des Ladens: die Seite ist schon abgebaut, ein
  // Einhaengen jetzt schriebe in eine fremde Adresse.
  if (signal?.aborted || !page.isConnected) return;
  renderSourceFilter();
  // VOR dem ersten Listenbau: der Baustein loest `?open=` beim Einhaengen ein
  // und braucht dafuer die geladenen Rezepte, nicht die Zeilen -
  // renderRecipeList() setzt danach die Markierung (refresh).
  _md = mountRecipeDetail(split, signal);
  renderRecipeList();

  // Deep-Link: ?open=<id> klappt das Rezept auf und scrollt es ins Bild.
  // Dieselbe Schreibweise wie in Kontakten und auf der Startseite, damit nicht
  // jedes Modul seinen eigenen Parameter erfindet.
  //
  // Gebraucht wird er von den Essenskarten (#936): ein Essen liess sich mit
  // einem Rezept verknuepfen, aber die Verknuepfung hatte keinen Ausgang - der
  // Aktionsknopf gab es nur fuer eine externe `recipe_url`, nicht fuer ein
  // Rezept aus dem eigenen Haus.
  openRecipeFromQuery();

  // Bei `read` gibt es keinen FAB (fabEl). Der Riegel selbst sitzt in
  // openRecipeModal() - dort muenden alle Anlege- und Bearbeitungswege.
  fab?.addEventListener('click', () => openRecipeModal('create'));

  // Handle im Modul halten: der Zurücksetzen-Pfad des Suchtreffer-Leerzustands
  // braucht `clear()`, nicht nur `input.value = ''` - sonst bliebe der
  // Leeren-Knopf über einem leeren Feld stehen.
  _search = wirePageSearch(toolbar, {
    id: 'recipes-search',
    onQuery: (value) => {
      state.query = value.trim();
      renderRecipeList();
    },
  });

  // An der Huelle, nicht an der Liste: die Kreislauf-Ausgaenge und die
  // Vorrats-Zuordnung stehen in der Spalten-Darstellung in der Detailspalte,
  // mit denselben `data-action`-Knoepfen wie im Aufklapper.
  split.addEventListener('click', (e) => onSplitClick(e, list));

  // Kein eigener keydown-Handler mehr: das Aufklappen sitzt auf einem echten
  // <button>, der Enter und Space von sich aus verarbeitet. Der frühere Handler
  // gehörte zur Karte, die role="button" trug und damit ein Bedienelement mit
  // Bedienelementen darin war.
}

async function onSplitClick(e, list) {
  // Der Hauptknopf der Zeile: in der Spalte waehlt er aus, darunter klappt
  // er auf oder oeffnet das Formular - der Baustein entscheidet ueber open().
  // Auswaehlen und Aufklappen sind Lesen; den Weg ins Formular schliesst
  // openRecipeModal() selbst.
  const main = e.target.closest('.recipe-row__toggle');
  if (main && list.contains(main)) {
    if (_md) _md.open(main.dataset.id, main);
    else openRecipeNarrow(main.dataset.id, main);
    return;
  }

  const actionBtn = e.target.closest('[data-action]');
  if (!actionBtn) return;

  // Der eine Riegel fuer alle Aktionen darunter (siehe READ_SAFE_ACTIONS): das
  // Markup nimmt die Affordanz, die Positivliste den Effekt - auch fuer einen
  // Knoten, der einen Rechtewechsel ueberlebt hat.
  if (readOnly() && !READ_SAFE_ACTIONS.has(actionBtn.dataset.action)) return;

  const run = SPLIT_ACTIONS[actionBtn.dataset.action];
  if (!run) return;

  const recipeId = Number(actionBtn.dataset.id);
  const recipe = state.recipes.find((r) => r.id === recipeId);
  if (!recipe) return;

  await run(recipe, actionBtn);
}

/**
 * Was eine `data-action` der Seite TUT - eine Tabelle statt einer Kette aus
 * `if`, damit der Riegel davor (`READ_SAFE_ACTIONS` in onSplitClick) an EINER
 * Stelle ueber alle Eintraege urteilt, auch ueber einen, der morgen dazukommt
 * und noch keinen eigenen Riegel traegt. `toggle-detail` fehlt hier: der
 * Hauptknopf der Zeile ist vorher abgezweigt.
 */
const SPLIT_ACTIONS = {
  edit: (recipe) => openRecipeModal('edit', recipe),
  'match-ingredient': (recipe, btn) => openPantryMatchModal(recipe, btn.dataset.ingredient),
  'match-ingredients': (recipe) => openPantryBulkMatchModal(recipe),
  delete: (recipe) => removeRecipe(recipe),
  duplicate: (recipe) => duplicateRecipe(recipe),
  'to-shopping': (recipe, btn) => transferRecipe(recipe, btn),
  'add-to-meals': (recipe, btn) => planRecipe(recipe, btn),
};

// Mehrwege-Filter (Alle/Nativ/pro Provider) als Trigger + Popover-Menü im
// __actions-Slot, dieselbe Behandlung wie „Lagerorte verwalten" im Vorrat -
// ein btn--icon im Kopf statt einer eigenen Zeile, die auf schmalen
// Bildschirmen für wenige Optionen (fast immer "Alle" aktiv) eine ganze
// Kopf-Zeile kostete. Bleibt versteckt, solange kein Provider-Account
// gespiegelte Rezepte liefert - der Filter wäre sonst leere Ornamentik.
function renderSourceFilter() {
  const el = _container.querySelector('#recipes-source-filter');
  if (!el) return;

  const hasMirrored = state.recipes.some((r) => r.source !== 'native');
  if (!hasMirrored) {
    el.hidden = true;
    state.sourceFilter = 'all';
    return;
  }

  el.hidden = false;
  const options = [
    { value: 'all', label: t('recipes.sourceAll') },
    { value: 'native', label: t('recipes.sourceNative') },
    ...[...new Set(state.recipes.map((r) => r.source).filter((s) => s !== 'native'))].sort().map((s) => ({
      value: s, label: t(`recipes.source${s[0].toUpperCase()}${s.slice(1)}`),
    })),
  ];
  const activeLabel = options.find((o) => o.value === state.sourceFilter)?.label ?? '';

  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', `
    <button type="button" class="btn btn--ghost btn--icon popover-menu__trigger"
            popovertarget="recipes-source-filter-menu" aria-haspopup="menu" aria-expanded="false"
            aria-label="${esc(t('recipes.sourceFilterLabel'))}: ${esc(activeLabel)}"
            title="${esc(t('recipes.sourceFilterLabel'))}: ${esc(activeLabel)}">
      <i data-lucide="filter" class="icon-md" aria-hidden="true"></i>
    </button>
    <div class="popover-menu recipes-source-filter-menu" id="recipes-source-filter-menu" popover role="menu"
         aria-label="${esc(t('recipes.sourceFilterLabel'))}">
      ${options.map((opt) => {
        const active = state.sourceFilter === opt.value;
        return `
          <button type="button" role="menuitemradio" aria-checked="${active}"
                  class="popover-menu__item" data-source-value="${esc(opt.value)}">
            <i data-lucide="check" class="icon-md popover-menu__item-check${active ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>
            <span>${esc(opt.label)}</span>
          </button>`;
      }).join('')}
    </div>`);

  for (const btn of el.querySelectorAll('[data-source-value]')) {
    btn.addEventListener('click', () => {
      const value = btn.dataset.sourceValue;
      if (state.sourceFilter === value) return;
      state.sourceFilter = value;
      renderSourceFilter();
      renderRecipeList();
    });
  }
  if (window.lucide) window.lucide.createIcons({ el });
}

/**
 * Baut die Liste neu und gleicht danach Liste + Detail ab - auf JEDEM Weg,
 * auch dem Leer-, Fehler- und Kein-Treffer-Zustand: sonst stuende rechts ein
 * Rezept, das die Liste links gerade nicht mehr zeigt.
 *
 * `repaint` nach dem Speichern: das Detail rechts zeigte sonst den Stand vor
 * dem Formular.
 */
function renderRecipeList({ repaint = false } = {}) {
  buildRecipeList();
  syncRowMode();
  _md?.refresh({ repaint });
}

/* LISTE + DETAIL (Breitenregel, Regime 2 - DESIGN.md)
 *
 * Ab 65rem Modulflaeche steht links die Liste, rechts das ausgewaehlte Rezept
 * mit eigenem Kopf (Titel, Bearbeiten, Duplizieren, Loeschen) und dem
 * Aufklapper-Inhalt darunter - wie Notizen und Erinnerungen auf dem Mac.
 * Darunter bleibt alles, wie es war: die Zeile klappt auf, und ein Rezept
 * ohne Detail oeffnet das Formular.
 *
 * DER PARAMETER IST `open` (Standard des Bausteins, hier ausdruecklich).
 * `/recipes?open=<id>` ist der Deep-Link, den die Essenskarten schon setzen
 * (#936). Die Auswahl schreibt
 * dieselbe Schreibweise, damit ein Rezept genau EINE Adresse hat - ein
 * zweiter Parameter hiesse zwei Adressen fuer dieselbe Sache und einen Link
 * aus dem Essensplan, der rechts nichts auswaehlt.
 */
function mountRecipeDetail(root, signal) {
  const md = mountMasterDetail({
    root,
    param: 'open',
    signal,
    renderDetail: (id, body) => renderRecipePane(id, body),
    openNarrow: (id, trigger) => openRecipeNarrow(id, trigger),
    // Unter der Schwelle loest openRecipeFromQuery() den Link ein, NACH dem
    // Listenbau - beim Einhaengen gibt es noch keine Zeile zum Aufklappen.
    deepLinkNarrow: false,
    // Darunter ist die Zeile ein Aufklapper, kein Blatt: mehrere Rezepte
    // stehen offen, und Aufklappen schreibt keine Adresse.
    narrow: 'accordion',
    // Und bei Zurueck/Vor auf `?open=` (Eintraege aus der Spalte, Fenster
    // inzwischen schmal) dieselbe Einloesung: die Zeilen stehen, der
    // Aufklapper geht auf (Codex an #1477).
    onNarrowSync: () => openRecipeFromQuery(),
  });
  // Der Moduswechsel (Fenster, Seitenleiste) aendert, was der Hauptknopf der
  // Zeile IST: Aufklapper darunter, Auswahl in der Spalte. Seine ARIA-Angaben
  // ziehen hier nach; die Geometrie entscheidet das CSS.
  if (typeof ResizeObserver === 'function') {
    let last = md.isSplit();
    const ro = new ResizeObserver(() => {
      const now = md.isSplit();
      if (now === last) return;
      last = now;
      syncRowMode();
    });
    ro.observe(root);
    signal?.addEventListener('abort', () => ro.disconnect(), { once: true });
  }
  return md;
}

/**
 * Das ausgewaehlte Rezept in der Detailspalte. `false` heisst: diese ID gibt es
 * (nicht mehr) - der Baustein faellt dann auf den Leerzustand zurueck.
 */
function renderRecipePane(id, body) {
  const recipe = state.recipes.find((r) => String(r.id) === String(id));
  if (!recipe) return false;
  // Dieselbe Regel wie die Zeilenaktionen: gespiegelte Rezepte sind
  // schreibgeschuetzt, Duplizieren legt eine eigene Kopie an.
  const isMirrored = recipe.source !== 'native';
  // Bei `read` traegt der Kopf nur den Titel: alle drei Knoepfe schreiben.
  const actions = readOnly() ? [] : [
    !isMirrored && {
      label: t('common.edit'), icon: 'pencil', id: 'recipes-detail-edit',
      onClick: () => openRecipeModal('edit', recipe),
    },
    {
      label: t('recipes.duplicate'), icon: 'copy', variant: 'ghost', iconOnly: true,
      onClick: () => duplicateRecipe(recipe),
    },
    !isMirrored && {
      label: t('common.delete'), icon: 'trash-2', variant: 'ghost', iconOnly: true,
      onClick: () => removeRecipe(recipe),
    },
  ].filter(Boolean);

  const detail = document.createElement('div');
  detail.className = 'recipe-detail recipe-detail--pane';
  fillRecipeDetail(detail, recipe);
  body.replaceChildren(detailPaneHeaderEl({ title: recipe.title, actions }), detail);
  return undefined;
}

/**
 * Unter der Schwelle: der bisherige Weg der Zeile. Aufklappen, wenn es ein
 * Detail gibt, sonst das Formular - ein gespiegeltes Rezept ohne Detail tut
 * nichts (siehe buildRecipeList).
 */
function openRecipeNarrow(id, trigger) {
  const btn = trigger
    ?? _container?.querySelector(`.recipe-row__toggle[data-id="${CSS.escape(String(id))}"]`);
  if (!btn) return;

  // Aufklappen: der Zustand lebt am Button (aria-expanded) und am Panel
  // (hidden). `hidden` statt max-height-Transition, weil ein per Transition
  // versteckter Inhalt in headless-Renderern und auf inaktiven Tabs nie
  // erscheint - der Reveal muss einen sichtbaren Default verbessern, nicht
  // Sichtbarkeit an eine Animation binden.
  // BEWEGUNG OBENDRAUF (Re-Critique 2026-09-28, A4 P2-8): der Aufklapper
  // oeffnete hart. Der Zustand bleibt `hidden` (siehe oben), die Bewegung kommt
  // aus dem geteilten Paar expandIn/collapseOut (utils/ux.js, reduzierte
  // Bewegung springt): Oeffnen macht sichtbar und zieht auf, Schliessen klappt
  // erst ein und versteckt dann.
  if (btn.dataset.action === 'toggle-detail') {
    const panel = _container?.querySelector(`#recipe-detail-${btn.dataset.id}`);
    if (!panel) return;
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    if (!open) {
      panel.getAnimations?.().forEach((a) => a.cancel());
      panel.hidden = false;
      expandIn(panel);
      return;
    }
    collapseOut(panel).then(() => {
      // Nur verstecken, wenn inzwischen niemand wieder aufgeklappt hat.
      if (btn.getAttribute('aria-expanded') !== 'true') panel.hidden = true;
      // collapseOut haelt die Hoehe 0 (fill: forwards) - verwerfen, sonst
      // oeffnete das Panel beim naechsten Mal auf Hoehe 0.
      panel.getAnimations?.().forEach((a) => a.cancel());
      panel.style.overflow = '';
    });
    return;
  }

  if (btn.dataset.action === 'edit') {
    const recipe = state.recipes.find((r) => String(r.id) === String(id));
    if (recipe) openRecipeModal('edit', recipe);
  }
}

/**
 * ARIA des Hauptknopfs je Darstellung. Unter der Schwelle ist er ein
 * Aufklapper (`aria-expanded` + `aria-controls` aufs Panel); in der Spalte
 * waehlt er aus - ein „eingeklappt", das nie aufklappt, waere eine falsche
 * Ansage. Dort zeigt `aria-controls` auf die Detailspalte, und die Auswahl
 * traegt der Baustein als `aria-current`.
 */
function syncRowMode() {
  const list = _container?.querySelector('#recipes-list');
  if (!list) return;
  const split = _md?.isSplit() ?? false;
  // Die Klasse traegt die Darstellung ins Stylesheet (Aufklapper und Chevron
  // weg, recipes.css). Sie folgt der gerechneten Darstellung der Spalte statt
  // einer eigenen Abfrage: eine zweite `@container`-Schwelle hier liefe der in
  // layout.css davon, und PAGE-019 bewacht nur die eine.
  list.classList.toggle('recipes-list--split', split);
  for (const btn of list.querySelectorAll('.recipe-row__toggle')) {
    if (split) {
      btn.removeAttribute('aria-expanded');
      btn.setAttribute('aria-controls', 'recipes-detail');
    } else if (btn.dataset.action === 'toggle-detail') {
      const panelId = `recipe-detail-${btn.dataset.id}`;
      const panel = list.querySelector(`#${CSS.escape(panelId)}`);
      btn.setAttribute('aria-expanded', String(Boolean(panel && !panel.hidden)));
      btn.setAttribute('aria-controls', panelId);
    } else {
      btn.removeAttribute('aria-controls');
    }
    if ('narrowInert' in btn.dataset) {
      btn.tabIndex = split ? 0 : -1;
      btn.classList.toggle('list-row__main--interactive', split);
    }
  }
}

/**
 * Der Leerzustand der Rezeptliste. Bei `read` nur der ZUSTAND (Regel 9): Knopf,
 * Beschreibung („Speichere ...") und Hinweis laden alle zu einer Handlung ein,
 * die es dann nicht gibt.
 */
function emptyListOptions() {
  if (readOnly()) return { icon: 'book-text', title: t('recipes.emptyTitle') };
  return {
    icon: 'book-text',
    title: t('recipes.emptyTitle'),
    description: t('recipes.emptyDescription'),
    hint: t('emptyHint.recipes'),
    action: {
      label: t('recipes.emptyAction'),
      icon: 'plus',
      onClick: () => document.querySelector('.page-fab')?.click(),
    },
  };
}

function buildRecipeList() {
  const list = _container.querySelector('#recipes-list');
  if (!list) return;
  list.removeAttribute('aria-busy');

  list.replaceChildren();

  // Fehlerzustand vor Leerzustand: nach einem Fehler ist `state.recipes`
  // ebenfalls leer, und nur die Reihenfolge trennt „nichts angelegt" von
  // „nicht geladen".
  if (state.loadError) {
    mountLoadError(list, {
      title: t('recipes.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        list.setAttribute('aria-busy', 'true');
        await loadRecipes();
        renderRecipeList();
      },
    });
    return;
  }

  if (!state.recipes.length) {
    // Geteilter Renderer (utils/empty-state.js): erzwingt Reihenfolge und
    // ARIA-Rolle. Vorher fehlte hier als einzigem Küchen-Leerzustand das Icon.
    mountEmptyState(list, emptyListOptions());
    return;
  }

  const visible = filteredRecipes();
  if (!visible.length) {
    // Geteilter Renderer, Variante 'no-results' (role="status", sekundärer CTA).
    // Vorher war das hier ein nacktes <p class="recipes-search-empty"> - die eine
    // Stelle im Modul, die den erzwingenden Baustein umging, während die
    // Schwester im Vorrat im identischen Zustand Icon, Überschrift, den
    // Suchbegriff und einen Zurücksetzen-Pfad lieferte (Critique 2026-07-30).
    mountEmptyState(list, {
      variant: 'no-results',
      title: t('recipes.noResultsTitle'),
      description: t('recipes.searchNoResults'),
      hint: state.query ? `„${state.query}"` : undefined,
      action: {
        // Geteilter Key: „Suche leeren" existiert in allen 23 Locales. Der
        // Vorrat sagt „Suche und Filter zurücksetzen", weil er beides hat -
        // Rezepte haben nur die Suche, und das Label soll nicht mehr versprechen
        // als es tut.
        label: t('common.searchClear'),
        onClick: () => {
          state.query = '';
          // clear() versteckt zugleich den Leeren-Knopf; ein blankes
          // `value = ''` ließe ihn über dem leeren Feld stehen.
          _search?.clear();
          renderRecipeList();
          _search?.input.focus();
        },
      },
    });
    return;
  }

  // Eine Zeilenliste, keine Kacheln: das Kartenraster war der letzte Tab mit
  // eigener Zeilen-Grammatik (20px Radius, 408px Höhe, drei CTA-Grundlinien,
  // 48px Bodenversatz in derselben Rasterzeile). Als Zeile teilt es Fläche,
  // Trennlinie, Textspalte und Bedienzone mit Einkauf und Vorrat.
  const rows = document.createElement('ul');
  rows.className = 'row-carrier';

  for (const recipe of visible) {
    // Mirror-Rezepte sind read-only (der Provider bleibt Quelle der Wahrheit); steuert
    // weiter unten sowohl die Zeilenaktionen als auch das Aufklapp-Detail.
    const isMirrored = recipe.source !== 'native';
    const ro = readOnly();
    const ingredients = recipe.ingredients ?? [];
    const detailId = `recipe-detail-${recipe.id}`;
    // Bei `read` hat JEDE Zeile ein Detail: dort stehen dann immer die
    // Mahlzeiten (fillRecipeDetail), und der Weg „ohne Detail direkt ins
    // Formular" ist zu - die Zeile waere sonst ein Knopf, der nichts tut.
    const hasDetail = ro || Boolean(ingredients.length || recipe.notes || recipe.recipe_url);

    const li = document.createElement('li');
    li.className = 'recipe-row-item';
    li.dataset.id = String(recipe.id);
    // Liste + Detail: die Zeile ist auswaehlbar, ihr Hauptknopf traegt den Fokus
    // der Pfeiltasten (utils/master-detail.js).
    li.dataset.mdId = String(recipe.id);

    const row = document.createElement('div');
    row.className = 'list-row recipe-row';

    // Kanonisches Accordion-Muster: Überschrift umschließt den Button. Die
    // Überschrift trägt die Dokumentstruktur, der Button den Zustand - vorher
    // war die ganze Karte ein role="button" MIT Buttons darin, was für
    // Hilfsmittel ein verschachteltes Bedienelement ist.
    const heading = document.createElement('h2');
    heading.className = 'list-row__main recipe-row__heading';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'list-row__main--interactive recipe-row__toggle';
    toggle.dataset.action = 'toggle-detail';
    toggle.dataset.id = String(recipe.id);
    toggle.dataset.mdFocus = "";

    // Herkunft ist Teil der Identität der Zeile, nicht erst ein Detail: wer
    // durch eine gemischte Liste scrollt, muss vor dem Aufklappen sehen können,
    // welche Rezepte gespiegelt (und schreibgeschützt) sind, nicht erst
    // danach.
    if (rowShowsThumb(recipe)) toggle.appendChild(recipeThumb(recipe));

    const name = document.createElement('span');
    name.className = 'list-row__name';
    name.textContent = recipe.title;
    toggle.appendChild(name);

    if (isMirrored) {
      // Eigener, unsichtbarer Slot statt das Badge selbst als Flex-Item zu
      // verwenden: unter der Container-Query unten braucht das Badge eine
      // erzwungene eigene Zeile (wie die Zutatenzahl), aber ein `flex-basis:
      // 100%` DIREKT am Badge würde die Pille selbst auf volle Zeilenbreite
      // dehnen (sie trägt einen sichtbaren Hintergrund, anders als der reine
      // Text der Zutatenzahl). Der Slot dehnt sich, die Pille darin bleibt
      // ihrer Inhaltsbreite treu.
      const badgeSlot = document.createElement('span');
      badgeSlot.className = 'recipe-row__badge-slot';
      badgeSlot.appendChild(sourceBadge(recipe));
      toggle.appendChild(badgeSlot);
    }

    // Die Zutatenzahl ersetzt das frühere „+N": dort stand ein <li> mit
    // cursor: pointer, ohne role, ohne tabindex, ohne aria-expanded, dessen
    // Klick nachweislich nichts tat (Kartenhöhe 408 → 408px an sechs Karten
    // gemessen, Critique 2026-07-30). Jetzt ist die Zahl die Beschriftung
    // dessen, was das Aufklappen zeigt.
    //
    // IMMER gerendert, auch bei 0: die Mindestbreite von .list-row__meta
    // (15ch, siehe recipes.css) hält alles davor - das Mealie/Tandoor-Badge -
    // an derselben Stelle. Fehlte das Element ganz, würde der Name per
    // flex-grow den freiwerdenden Platz schlucken und das Badge nach rechts
    // schieben, sobald ein Rezept ganz ohne Zutaten in der Liste steht.
    const meta = document.createElement('span');
    meta.className = 'list-row__meta';
    meta.textContent = t('meals.ingredientCount', { count: ingredients.length });
    // Zutatenzahl und „Diese Woche geplant" teilen sich einen Slot: breit
    // nimmt er per `display: contents` nicht am Layout teil, schmal wird er
    // die zweite Zeile unter dem Namen - BEIDE Angaben darin, statt dass die
    // zweite allein neben dem Namen haengen bleibt (recipes.css).
    const sub = document.createElement('span');
    sub.className = 'recipe-row__sub';
    sub.appendChild(meta);

    // Zweite Meta-Angabe, getrennt ueber den Mittelpunkt des +-Kombinators
    // (Hausform, Vorrat): neutraler Sekundaertext, keine Flaeche - der
    // Zustand ist eine Meldung, keine Identitaet (Skalen-Regel).
    if (state.plannedRecipeIds.has(recipe.id)) {
      const planned = document.createElement('span');
      planned.className = 'recipe-row__planned';
      planned.textContent = t('recipes.plannedThisWeek');
      sub.appendChild(planned);
    }
    toggle.appendChild(sub);

    if (hasDetail) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', detailId);
      toggle.insertAdjacentHTML('beforeend',
        '<i data-lucide="chevron-down" class="icon-sm recipe-row__chevron" aria-hidden="true"></i>');
    } else if (!isMirrored) {
      // Ohne Detail kein Versprechen: kein Chevron, kein aria-expanded. Der
      // Button öffnet dann direkt das Bearbeiten-Formular.
      toggle.dataset.action = 'edit';
    } else {
      // Gespiegelt UND ohne Detail (kein Slug-Link, keine Zutaten, keine
      // Notiz - selten, aber möglich, wenn Mealies /users/self keinen
      // groupSlug liefert): weder aufklappbar noch bearbeitbar. Der Button
      // bliebe sonst interaktiv aussehend, ohne dass ein Klick etwas täte -
      // oder schlimmer, er würde über den generischen edit-Handler ein
      // Bearbeitungsformular öffnen, dessen Speichern serverseitig ohnehin
      // mit 403 abgewiesen wird (provider_account_id-Guard, routes/recipes.js).
      delete toggle.dataset.action;
      toggle.classList.remove('list-row__main--interactive');
      toggle.tabIndex = -1;
      // Nur unter der Schwelle stumm: in der Spalte zeigt auch dieses Rezept
      // sein Detail rechts, also ist die Zeile dort ein Knopf wie jede andere
      // (syncRowMode).
      toggle.dataset.narrowInert = "";
      // Trotzdem einen (unsichtbaren) Chevron-Platzhalter einfügen: sonst
      // wächst der Name per flex-grow um genau dessen Breite, und das Badge
      // vor ihm rutscht gegenüber jeder anderen gespiegelten Zeile nach
      // rechts - derselbe Mechanismus wie bei der Zutatenzahl oben.
      toggle.insertAdjacentHTML('beforeend',
        '<i data-lucide="chevron-down" class="icon-sm recipe-row__chevron recipe-row__chevron--placeholder" aria-hidden="true"></i>');
    }

    heading.appendChild(toggle);
    row.appendChild(heading);

    // Mirror-Rezepte sind read-only (der Provider bleibt Quelle der Wahrheit) - Edit
    // und Delete entfallen, Duplizieren bleibt: das legt eine eigenständige,
    // frei bearbeitbare Kopie an (duplicateRecipe() postet immer als natives
    // Rezept, unabhängig von der Quelle des Originals). Eine Liste speist
    // sowohl die Inline-Buttons als auch das Überlaufmenü weiter unten, damit
    // beide Fassungen nie auseinanderlaufen.
    // Bei `read` bleibt keine: alle drei schreiben (Duplizieren legt ein
    // Rezept an). Die Bedienzone entfaellt dann samt Ueberlaufmenue.
    const ROW_ACTIONS = ro ? [] : [
      !isMirrored && { action: 'edit',      icon: 'pencil',  label: t('common.edit') },
      { action: 'duplicate', icon: 'copy',    label: t('recipes.duplicate') },
      !isMirrored && { action: 'delete',    icon: 'trash-2', label: t('common.delete'), danger: true },
    ].filter(Boolean);

    const actions = document.createElement('div');
    actions.className = 'list-row__actions';

    // Drei Zeilenaktionen kosten 152px von 262px Zeilenbreite bei 320px - 58% der
    // Zeile für Sekundäraktionen. Für den Namen blieben 98px, und weil er in einem
    // Flex-Elternteil steht, fiel er auf min-content: 8px, Zeilenhöhe 448px
    // (Critique 2026-07-30, P0).
    //
    // Unter 30rem Zeilenbreite wandern sie deshalb in dasselbe Überlaufmenü, das der
    // Einkaufs-Kopf benutzt - mit Labels, und ein 48px-Trigger statt drei Knöpfen.
    // Die Container-Query dazu steht in recipes.css; hier stehen beide Fassungen im
    // DOM, CSS entscheidet. Dieselbe Mechanik wie beim Kopf: `display: none` nimmt
    // die ungenutzte Fassung auch aus der Tabfolge.
    const inline = document.createElement('div');
    inline.className = 'recipe-row__inline-actions';
    for (const a of ROW_ACTIONS) {
      const btn = document.createElement('button');
      btn.className = `row-action${a.danger ? ' row-action--danger' : ''}`;
      btn.type = 'button';
      btn.dataset.action = a.action;
      btn.dataset.id = String(recipe.id);
      btn.setAttribute('aria-label', `${a.label}: ${recipe.title}`);
      btn.title = a.label;
      btn.insertAdjacentHTML('beforeend',
        `<i data-lucide="${a.icon}" class="icon-md" aria-hidden="true"></i>`);
      inline.appendChild(btn);
    }
    actions.appendChild(inline);

    const more = document.createElement('div');
    more.className = 'recipe-row__more';
    more.insertAdjacentHTML('beforeend', popoverMenuHtml({
      id: `recipe-menu-${recipe.id}`,
      label: t('common.moreActions'),
      triggerClass: 'row-action',
      items: ROW_ACTIONS.map((a) => ({ ...a, id: recipe.id })),
    }));
    actions.appendChild(more);

    if (ROW_ACTIONS.length) row.appendChild(actions);
    li.appendChild(row);

    if (hasDetail) {
      const detail = document.createElement('div');
      detail.className = 'recipe-detail';
      detail.id = detailId;
      detail.hidden = true;

      fillRecipeDetail(detail, recipe);
      li.appendChild(detail);
    }

    rows.appendChild(li);
  }

  list.appendChild(rows);

  if (window.lucide) window.lucide.createIcons({ el: list });
}

/**
 * Der Inhalt eines Rezeptdetails: Mahlzeit-Chips, Zutaten samt Vorrats-
 * Zuordnung, Notizen und die beiden Kreislauf-Ausgaenge. EINE Quelle fuer
 * zwei Orte - den Aufklapper der Zeile (unter der Schwelle) und die
 * Detailspalte (Liste + Detail), damit beide nie auseinanderlaufen.
 */
function fillRecipeDetail(detail, recipe) {
  // Das eigene Bild als Kopf des Details (R16) - ohne Bild kein Element, also
  // auch kein Platzhalterblock (utils/recipe-thumb.js).
  const hero = recipeHeroEl({ recipeId: recipe.id, hasOwnImage: recipe.has_own_image });
  if (hero) detail.appendChild(hero);

  const ingredients = recipe.ingredients ?? [];
  const mealTypes = normalizeRecipeMealTypes(recipe.meal_types);
  // Chips nur, wenn sie unterscheiden: gilt ein Rezept für alle Mahlzeiten,
  // ist die volle Chip-Reihe reine Ornamentik (Audit A1-21). Das
  // Herkunfts-Badge sitzt jetzt schon in der Zeilenüberschrift (immer sichtbar,
  // nicht erst nach dem Aufklappen) und wird hier nicht noch einmal gezeigt.
  //
  // BEI `read` IMMER (Regel 9 in utils/module-access.js): im Formular stehen
  // die Mahlzeiten als Chips, und wer es nicht oeffnen darf, saehe „gilt fuer
  // alle" sonst nur daran, dass hier nichts steht.
  const showMealTypeBadges = mealTypes.length && (readOnly() || mealTypes.length < mealTypeOptions().length);
  if (showMealTypeBadges) {
    const badges = document.createElement('div');
    badges.className = 'recipe-card__meal-types';
    badges.append(...mealTypeOptions()
      .filter((option) => mealTypes.includes(option.key))
      .map((option) => {
        const badge = document.createElement('span');
        badge.className = `meal-type-badge meal-type-badge--${option.key}`;
        badge.textContent = option.label;
        return badge;
      }));
    detail.appendChild(badges);
  } else if (!mealTypes.length) {
    // Keine Mahlzeit ist eine Aussage und braucht ein Wort: Das Rezept fällt
    // aus Menüplan und Zufallsauswahl heraus (#750). Ohne Hinweis wäre der
    // Zustand von „gilt für alle" nur daran zu unterscheiden, dass hier
    // nichts steht - und genau diese Stille war der gemeldete Fehler.
    const none = document.createElement('div');
    none.className = 'recipe-card__meal-types';
    const badge = document.createElement('span');
    badge.className = 'meal-type-badge meal-type-badge--none';
    badge.textContent = t('recipes.mealTypeNone');
    none.appendChild(badge);
    detail.appendChild(none);
  }

  // VOLLSTÄNDIGE Zutatenliste, nicht die ersten vier: das Kürzen war nur
  // nötig, um die Kartenhöhe zu bändigen. Ein Detail, das sich öffnet, hat
  // keinen Grund, etwas zu verschweigen.
  if (ingredients.length) detail.appendChild(ingredientsSectionEl(recipe));

  if (recipe.notes) {
    const section = detailSectionEl(t('recipes.notesLabel'));
    const notes = document.createElement('p');
    notes.className = 'recipe-detail__notes';
    notes.textContent = recipe.notes;
    section.appendChild(notes);
    detail.appendChild(section);
  }

  // Die beiden Kreislauf-Ausgänge stehen im Detail, nicht in der Zeile, und
  // sind dort BESCHRIFTET. Grund: derselbe Weg hieß im Modul dreimal etwas
  // anderes - ein 24px-Glyph im Essensplan, ein 48px-Glyph im Vorrat, ein
  // 167px-Pill in den Rezepten (Critique 2026-07-30). Und man entscheidet
  // sich fürs Einplanen, nachdem man gesehen hat, was drin ist. Der Preis
  // ist ein zusätzlicher Tap für den häufigsten Weg; die Zeile bleibt dafür
  // scanbar und auf 393px ohne fünf konkurrierende Bedienelemente.
  const detailActions = document.createElement('div');
  detailActions.className = 'recipe-detail__actions';

  // „In den Essensplan" legt eine Mahlzeit an - ohne Schreibrecht entfaellt
  // der Knopf (Regel 2), der Riegel dazu steht in planRecipe().
  if (mayPlanRecipe()) {
    const addToMeals = document.createElement('button');
    addToMeals.className = 'btn btn--primary';
    addToMeals.type = 'button';
    addToMeals.dataset.action = 'add-to-meals';
    addToMeals.dataset.id = String(recipe.id);
    addToMeals.textContent = t('recipes.addToMeals');
    detailActions.appendChild(addToMeals);
  }

  const addToShopping = shoppingTransferButton(recipe, ingredients);
  if (addToShopping) detailActions.appendChild(addToShopping);

  if (recipe.recipe_url) {
    const link = document.createElement('a');
    link.className = 'btn btn--ghost';
    link.href = recipe.recipe_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.insertAdjacentHTML('beforeend',
      '<i data-lucide="external-link" class="icon-sm" aria-hidden="true"></i>');
    const linkLabel = document.createElement('span');
    linkLabel.textContent = t('recipes.openLink');
    link.appendChild(linkLabel);
    detailActions.appendChild(link);
  }

  // Bei `read` ohne Einkaufsrecht und ohne Link bliebe eine leere Leiste.
  if (detailActions.childNodes.length) detail.appendChild(detailActions);
}

/* ABSCHNITTSKOEPFE, DIE MAN ANSPRINGEN KANN (Re-Critique 2026-09-27, W2).
 *
 * Zutaten und Notizen standen als zwei gleich graue 17px-Bloecke untereinander,
 * ohne Wort dafuer, was sie sind - das Detail las sich wie ein Formular-Nachdruck,
 * nicht wie ein Rezept, und die Ueberschriften-Navigation eines Screenreaders
 * fand darin nichts. Jetzt traegt jeder Abschnitt eine echte Ueberschrift in der
 * Bereichsrolle (`u-section-title u-compact`, typography.css). Eine Stufe unter
 * dem Rezepttitel: der ist im Aufklapper wie in der Detailspalte ein <h2>
 * (`recipe-row__heading`, `detailPaneHeaderEl`). Die Worte sind die Feldnamen
 * des Formulars - dieselbe Sache heisst an beiden Stellen gleich. */
function detailSectionEl(title) {
  const section = document.createElement('section');
  section.className = 'recipe-detail__section';
  const heading = document.createElement('h3');
  heading.className = 'recipe-detail__section-title u-section-title u-compact';
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

/**
 * Der Zutaten-Abschnitt als EIN Element mit Rezept-ID, damit eine geaenderte
 * Zuordnung ihn an beiden Orten (Aufklapper und Detailspalte) als Ganzes neu
 * bauen kann - samt Sammelknopf, dessen Zahl sich mitaendert.
 */
function ingredientsSectionEl(recipe) {
  const ingredients = recipe.ingredients ?? [];
  const section = detailSectionEl(t('recipes.ingredientsLabel'));
  section.classList.add('recipe-detail__ingredients-section');
  section.dataset.recipeId = String(recipe.id);
  const ul = document.createElement('ul');
  ul.className = 'recipe-detail__ingredients';
  for (const ing of ingredients) {
    const item = document.createElement('li');
    item.className = 'recipe-detail__ingredient';
    const label = document.createElement('span');
    label.className = 'recipe-detail__ingredient-name';
    label.textContent = ing.quantity ? `${ing.quantity} · ${ing.name}` : ing.name;
    item.appendChild(label);
    // Die Einkaufskategorie steht sonst NUR im Formular. Bei `read` deshalb
    // hier, wo der Tipp landet (Regel 9) - als Text, nicht als Auswahl.
    // IM Namen statt als drittes Kind: die Zeile verteilt ihre Kinder auf die
    // beiden Raender (Zutat links, Zuordnung rechts, recipes.css).
    if (readOnly() && ing.category) {
      const category = document.createElement('span');
      category.className = 'recipe-detail__ingredient-category';
      category.textContent = categoryLabel(ing.category);
      label.append(' ', category);
    }
    item.appendChild(pantryMatchEl(recipe, ing));
    ul.appendChild(item);
  }
  section.appendChild(ul);
  const bulk = pantryMatchBulkEl(recipe);
  if (bulk) section.appendChild(bulk);
  return section;
}

/** Baut jeden Zutaten-Abschnitt dieses Rezepts neu (Aufklapper + Spalte). */
function renderIngredientSections(recipe) {
  const sections = _container?.querySelectorAll(
    `.recipe-detail__ingredients-section[data-recipe-id="${CSS.escape(String(recipe.id))}"]`) ?? [];
  for (const el of sections) el.replaceWith(ingredientsSectionEl(recipe));
  if (sections.length && window.lucide) window.lucide.createIcons({ el: _container });
}

/* DIE BESTAETIGTE ZUORDNUNG ZU EINER VORRATSZEILE (#1314, Stufe 1).
 *
 * Sie steht im Rezeptdetail, neben der Zutat, und nirgends sonst: eine eigene
 * Zuordnungsseite oeffnet niemand ein zweites Mal (#1314, Punkt 2). Yuvomi
 * schlaegt dabei NICHTS vor - auch dann nicht, wenn eine Vorratszeile genauso
 * heisst. Ein geratener Treffer waere der gepflegte Katalog, eine Ableitung
 * nach der anderen (docs/DECISIONS.md Abschnitt 7).
 *
 * UND DAS WORT ZAEHLT. Eine Zutat ohne Zuordnung heisst „nicht zugeordnet",
 * niemals „fehlt": Stufe 1 weiss nur, worauf der Haushalt gezeigt hat, und
 * nichts ueber den Bestand. Ein „fehlt" waere eine vollstaendige Auskunft auf
 * halber Datenlage - genau das, was der Abschnitt unter „What counts as undoing
 * it" nennt.
 */

/** 'none' | 'read' | 'write' - was dieses Konto mit dem Vorrat darf. */
function pantryAccess() {
  if (window.yuvomi?.isModuleDisabled?.('pantry')) return 'none';
  return navModuleAccess('pantry');
}

/**
 * Darf dieses Konto eine Zutat zuordnen? ZWEI RIEGEL, wie beim Transfer in den
 * Einkauf (Regel 8): `PUT /recipes/:id/ingredient-match` misst der Pfad-Guard
 * als `meals`, und die Route verlangt dazu `pantry: write`
 * (server/routes/recipes.js). Bis #1265 fragte die Oberflaeche nur den Vorrat -
 * mit `meals: read` und `pantry: write` standen Knopf und Dialog da, und das
 * Speichern endete im 403.
 *
 * @param {number|string} recipeId
 */
function mayMatchIngredient(recipeId) {
  return pantryAccess() === 'write' && mayWritePath(`/recipes/${recipeId}/ingredient-match`);
}

/**
 * Der Zuordnungs-Zustand einer Zutat als Element.
 *
 * Bei `read` bleibt der ZUSTAND stehen und nur die HANDLUNG geht (die Regel aus
 * #467): ein Mitglied, das den Vorrat nur ansehen darf, sieht die Zuordnung,
 * kann sie aber nicht aendern. Bei `none` steht hier gar nichts - wer den
 * Vorrat nicht sehen darf, erfaehrt auch nicht, dass es dort eine Zeile gibt.
 *
 * NUR DIE BESTEHENDE ZUORDNUNG STEHT AN DER ZEILE (Re-Critique 2026-09-27, W2).
 * Hier stand an jeder offenen Zutat „Nicht zugeordnet" - sechsmal je Rezept,
 * unterstrichen, lauter als die Menge. Die Zuordnung ist ein Werkzeug fuer den
 * Vorrat, kein Zustand des Rezepts; ihr Fehlen ist der Normalfall und braucht
 * kein Wort je Zeile. Der Weg dorthin steht EINMAL unter der Liste
 * (`pantryMatchBulkEl`). Das Wort „fehlt" bleibt weiter ausgeschlossen (Kopf
 * dieses Abschnitts): wo nichts steht, behauptet die Zeile auch nichts.
 */
function pantryMatchEl(recipe, ing) {
  const access = pantryAccess();
  if (access === 'none') return document.createDocumentFragment();

  const matched = Boolean(ing.pantry_item_id);
  if (!matched) return document.createDocumentFragment();
  const text = ing.pantry_item_name;

  if (!mayMatchIngredient(recipe.id)) {
    const span = document.createElement('span');
    span.className = 'recipe-detail__ingredient-match';
    span.textContent = text;
    return span;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'recipe-detail__ingredient-match';
  btn.dataset.action = 'match-ingredient';
  btn.dataset.id = String(recipe.id);
  btn.dataset.ingredient = ing.name;
  btn.textContent = text;
  // Der sichtbare Text ist der Zustand, nicht die Handlung - deshalb sagt das
  // Zugaengliche-Name-Feld, was der Knopf TUT, und nennt die Zutat dazu: in
  // einer Liste aus acht Zutaten waere „Zuordnen" achtmal derselbe Name.
  btn.setAttribute('aria-label', t('recipes.ingredientMatchAction', { name: ing.name }));
  return btn;
}

/**
 * DER EINE WEG ZU DEN OFFENEN ZUORDNUNGEN: ein stiller Knopf unter der Liste,
 * der sagt, wie viele Zutaten noch keine Vorratszeile haben, und sie in EINEM
 * Dialog zuordnen laesst. Nur fuer Konten, die den Vorrat schreiben duerfen -
 * Nur-Lesende sehen die bestehenden Zuordnungen und keine Handlung (#467).
 * `null`, wenn es nichts zu tun gibt.
 */
function pantryMatchBulkEl(recipe) {
  if (!mayMatchIngredient(recipe.id)) return null;
  const open = (recipe.ingredients ?? []).filter((ing) => !ing.pantry_item_id);
  if (!open.length) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--ghost recipe-detail__match-open';
  btn.dataset.action = 'match-ingredients';
  btn.dataset.id = String(recipe.id);
  btn.insertAdjacentHTML('beforeend', '<i data-lucide="link" class="icon-sm" aria-hidden="true"></i>');
  const label = document.createElement('span');
  label.textContent = t('recipes.ingredientMatchOpen', { count: open.length });
  btn.appendChild(label);
  return btn;
}

/** Eine Vorratszeile im Auswahlfeld: Name, Ort und MHD unterscheiden Chargen. */
function pantryOptionLabel(item) {
  const teile = [item.name];
  if (item.location_name) teile.push(item.location_name);
  if (item.expires_on) teile.push(formatDate(item.expires_on));
  return teile.join(' · ');
}

async function openPantryMatchModal(recipe, ingredientName) {
  // Zweite Linie hinter dem Markup, VOR dem Laden des Vorrats.
  if (!mayMatchIngredient(recipe.id)) return;
  const ing = (recipe.ingredients ?? []).find((i) => i.name === ingredientName);
  if (!ing) return;

  let items = [];
  try {
    const res = await api.get('/pantry');
    items = res.data ?? [];
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('recipes.ingredientMatchLoadError'), 'danger');
    return;
  }

  const options = items.map((item) => `<option value="${esc(String(item.id))}"${
    item.id === ing.pantry_item_id ? ' selected' : ''
  }>${esc(pantryOptionLabel(item))}</option>`).join('');

  openSharedModal({
    title: t('recipes.ingredientMatchTitle', { name: ingredientName }),
    size: 'sm',
    content: `
      <p class="form-hint">${t('recipes.ingredientMatchHint')}</p>
      ${items.length ? `
        <div class="form-group">
          <label class="form-label" for="pantry-match-select">${t('recipes.ingredientMatchLabel')}</label>
          <select id="pantry-match-select" class="form-input">
            <option value="">${t('recipes.ingredientMatchNone')}</option>
            ${options}
          </select>
        </div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-match-cancel" type="button">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="pantry-match-save" type="button">${t('common.save')}</button>
        </div>
      ` : `
        <p class="form-hint">${t('recipes.ingredientMatchEmpty')}</p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-match-cancel" type="button">${t('common.close')}</button>
        </div>
      `}
    `,
    onSave(panel) {
      panel.querySelector('#pantry-match-cancel')?.addEventListener('click', () => closeSharedModal());
      panel.querySelector('#pantry-match-save')?.addEventListener('click', async () => {
        const raw = panel.querySelector('#pantry-match-select')?.value ?? '';
        const pantryItemId = raw === '' ? null : Number(raw);
        // Die Rechte koennen sich aendern, waehrend der Dialog offen steht.
        if (!mayMatchIngredient(recipe.id)) return;
        try {
          const res = await api.put(`/recipes/${recipe.id}/ingredient-match`, {
            name: ingredientName,
            pantryItemId,
          });
          // Den geladenen Stand nachziehen statt neu zu holen: die Antwort
          // traegt genau die beiden Felder, die sich geaendert haben.
          ing.pantry_item_id = res.data.pantry_item_id;
          ing.pantry_item_name = res.data.pantry_item_name;
          // force: der Schreibvorgang ist durch, eine Verwerfen-Frage waere
          // eine Frage nach etwas, das schon gespeichert ist.
          closeSharedModal({ force: true });
          // NUR DEN ZUTATEN-ABSCHNITT NEU BAUEN, kein renderRecipeList(): das
          // Zutaten-Detail ist gerade aufgeklappt, und ein Neuaufbau der Liste
          // klappte es zu - der Nutzer stuende nach dem Speichern vor der
          // geschlossenen Zeile, aus der er kam.
          //
          // Die Zutat steht an ZWEI Stellen - im Aufklapper der Zeile und in
          // der Detailspalte. Beide ziehen nach, sonst zeigte der Aufklapper
          // nach dem naechsten Schmalerziehen den alten Stand. Als ganzer
          // Abschnitt, weil der Sammelknopf darunter seine Zahl mitaendert.
          renderIngredientSections(recipe);
          // Der Ausloeser ist mit dem Abschnitt ersetzt: den Fokus auf seinen
          // Nachfolger tragen (gleiches data-action/data-id).
          refocusAfterRender();
          window.yuvomi?.showToast(
            pantryItemId === null ? t('recipes.ingredientMatchCleared') : t('recipes.ingredientMatchSaved'),
            'success',
          );
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

/**
 * Alle offenen Zuordnungen eines Rezepts in EINEM Dialog: je Zutat ein
 * Auswahlfeld, beschriftet mit der Zutat. Gespeichert wird nur, was sich
 * geaendert hat, Zutat fuer Zutat ueber denselben Endpunkt wie der
 * Einzeldialog - er kennt keine Sammelform, und eine eigene waere eine zweite
 * Fassung derselben Regel (Yuvomi raet nichts, es gilt nur Bestaetigtes).
 */
async function openPantryBulkMatchModal(recipe) {
  if (!mayMatchIngredient(recipe.id)) return;
  const open = (recipe.ingredients ?? []).filter((ing) => !ing.pantry_item_id);
  if (!open.length) return;

  let items = [];
  try {
    const res = await api.get('/pantry');
    items = res.data ?? [];
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('recipes.ingredientMatchLoadError'), 'danger');
    return;
  }

  const options = items.map((item) => `<option value="${esc(String(item.id))}">${esc(pantryOptionLabel(item))}</option>`).join('');
  const fields = open.map((ing, i) => `
        <div class="form-group">
          <label class="form-label" for="pantry-bulk-match-${i}">${esc(ing.quantity ? `${ing.quantity} · ${ing.name}` : ing.name)}</label>
          <select id="pantry-bulk-match-${i}" class="form-input" data-ingredient-index="${i}">
            <option value="">${esc(t('recipes.ingredientMatchNone'))}</option>
            ${options}
          </select>
        </div>`).join('');

  openSharedModal({
    title: t('recipes.ingredientMatchBulkTitle'),
    size: 'sm',
    content: `
      <p class="form-hint">${t('recipes.ingredientMatchBulkHint')}</p>
      ${items.length ? `${fields}
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-bulk-match-cancel" type="button">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="pantry-bulk-match-save" type="button">${t('common.save')}</button>
        </div>
      ` : `
        <p class="form-hint">${t('recipes.ingredientMatchEmpty')}</p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-bulk-match-cancel" type="button">${t('common.close')}</button>
        </div>
      `}
    `,
    onSave(panel) {
      panel.querySelector('#pantry-bulk-match-cancel')?.addEventListener('click', () => closeSharedModal());
      const save = panel.querySelector('#pantry-bulk-match-save');
      save?.addEventListener('click', async () => {
        const chosen = [...panel.querySelectorAll('select[data-ingredient-index]')]
          .filter((sel) => sel.value !== '')
          .map((sel) => ({ ing: open[Number(sel.dataset.ingredientIndex)], pantryItemId: Number(sel.value) }));
        if (!chosen.length) { closeSharedModal({ force: true }); return; }
        if (!mayMatchIngredient(recipe.id)) return;
        save.disabled = true;
        let saved = 0;
        try {
          for (const { ing, pantryItemId } of chosen) {
            const res = await api.put(`/recipes/${recipe.id}/ingredient-match`, { name: ing.name, pantryItemId });
            ing.pantry_item_id = res.data.pantry_item_id;
            ing.pantry_item_name = res.data.pantry_item_name;
            saved += 1;
          }
          closeSharedModal({ force: true });
          renderIngredientSections(recipe);
          refocusAfterRender();
          window.yuvomi?.showToast(t('recipes.ingredientMatchSaved'), 'success');
        } catch (err) {
          // Was bis zum Fehler gespeichert ist, bleibt gespeichert und steht
          // gleich in der Liste; der Dialog bleibt fuer den Rest offen.
          if (saved) renderIngredientSections(recipe);
          save.disabled = false;
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

/* ENTFERNT: openRecipeReadModal (Nur-Lese-Modal fürs Kochen, Audit A1-21).
 *
 * Es zeigte volle Zutatenliste, Notizen und Link - genau das, was jetzt das
 * Aufklapp-Detail der Zeile zeigt, nur ohne Kontextverlust, ohne Overlay und
 * ohne einen zweiten Weg zur selben Information (Kriterium aus distill:
 * „wenn es woanders steht, wiederhole es nicht"). Sein Auslöser war zusätzlich
 * eine Karte mit role="button", die Buttons enthielt.
 *
 * Der Zweck bleibt erfüllt: Lesen erzwingt weiter kein Bearbeiten-Formular. Das
 * Herkunfts-Badge, das hier stand, sitzt jetzt in der Zeilenüberschrift selbst -
 * sichtbar, bevor man überhaupt aufklappt (siehe sourceBadge() weiter oben).
 */

/**
 * Fuss des Rezept-Dialogs nach dem Kanon `[Loeschen links] ... [Abbrechen]
 * [Primaer]` (R8 H10). Loeschen gab es bis dahin nur im Detailkopf und im
 * Zeilenmenue. Gespiegelte Rezepte bleiben ohne: sie gehoeren dem Provider,
 * dieselbe Regel wie in `ROW_ACTIONS`.
 */
function recipeModalFooterHtml(isEdit, recipe) {
  const canDelete = isEdit && recipe?.source === 'native';
  return `
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${canDelete ? `<button type="button" class="btn btn--danger-outline" id="recipe-delete" style="margin-inline-end:auto"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}</button>` : ''}
        <button class="btn btn--secondary" id="recipe-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="recipe-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>`;
}

function openRecipeModal(mode, recipe = null) {
  // Der Riegel steht VOR jeder Vorbereitung, und er steht HIER, weil FAB,
  // Leerzustand, Zeile, Ueberlaufmenue und Detailkopf alle diesen Weg nehmen.
  // Eine eigene Leseansicht geht nicht auf: die ist der Aufklapper der Zeile
  // bzw. die Detailspalte (siehe readOnly()).
  if (readOnly()) return;
  const isEdit = mode === 'edit';

  openSharedModal({
    title: isEdit ? t('recipes.editRecipe') : t('recipes.addRecipe'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="recipe-title">${t('common.nameLabel')}${REQUIRED_MARK}</label>
        <input id="recipe-title" class="form-input" type="text" required placeholder="${t('recipes.titlePlaceholder')}">
      </div>
      <div class="form-group">
        <span class="form-label" id="recipe-meal-types-label">${t('meals.mealTypeLabel')}</span>
        <!-- UMSCHALT-CHIPS STATT CHECKBOX PLUS BADGE (Re-Critique 2026-09-28,
             A4 P2-7): jede Option trug eine native Checkbox UND ein Farbbadge -
             zwei Zeichen fuer eine Wahl; der Kanon fuehrt die native Checkbox
             fuer Mehrfachauswahl unter "Nicht mehr". -->
        <div class="recipe-meal-types" id="recipe-meal-types" role="group" aria-labelledby="recipe-meal-types-label">
          ${mealTypeOptions().map((option) => `
            <button type="button" class="filter-chip recipe-meal-types__chip" data-meal-type="${option.key}" aria-pressed="false">${esc(option.label)}</button>
          `).join('')}
          <input type="hidden" id="recipe-meal-types-value" value="">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('recipes.ingredientsLabel')}</label>
        <div class="recipe-ingredient-list" id="recipe-ingredient-list"></div>
        <button class="btn btn--secondary recipe-add-ingredient" type="button" id="recipe-add-ingredient"><i data-lucide="plus" class="icon-md" aria-hidden="true"></i>${t('meals.addIngredient')}</button>
      </div>
      ${advancedSection(`
        <div class="form-group">
          <label class="form-label" for="recipe-notes">${t('recipes.notesLabel')}</label>
          <textarea id="recipe-notes" class="form-input" rows="3" placeholder="${t('recipes.notesPlaceholder')}"></textarea>
        </div>
        ${/* Ein eigenes Bild (#1059, Schritt 2) - fuer gespiegelte Rezepte
            * ausgeblendet: die sind hier ohnehin schreibgeschuetzt, ihr Inhalt
            * gehoert dem Provider. */ ''}
        <div class="form-group" id="recipe-image-group"${isEdit && recipe?.source !== 'native' ? ' hidden' : ''}>
          <label class="form-label">${t('recipes.imageLabel')}</label>
          <div class="recipe-image-editor">
            <button type="button" class="recipe-image-preview" id="recipe-image-preview"
                    aria-label="${esc(t('recipes.imageLabel'))}"></button>
            <input class="sr-only" id="recipe-image" type="file" accept="image/png,image/jpeg,image/webp"
                   aria-label="${esc(t('recipes.imageLabel'))}" tabindex="-1">
            <button type="button" class="btn btn--secondary btn--sm" id="recipe-image-pick">${t('recipes.imageChoose')}</button>
            <button type="button" class="btn btn--ghost btn--sm" id="recipe-image-remove">${t('recipes.imageRemove')}</button>
          </div>
          <p class="form-hint">${t('recipes.imageHint')}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="recipe-url">${t('recipes.urlLabel')}</label>
          <input id="recipe-url" class="form-input" type="url" placeholder="${t('recipes.urlPlaceholder')}">
        </div>`,
        { open: isEdit && (!!recipe.notes || !!recipe.recipe_url) })}
      ${recipeModalFooterHtml(isEdit, recipe)}
    `,
    onSave(panel) {
      panel.querySelector('#recipe-title').value = isEdit ? recipe.title : '';
      panel.querySelector('#recipe-notes').value = isEdit && recipe.notes ? recipe.notes : '';
      panel.querySelector('#recipe-url').value = isEdit && recipe.recipe_url ? recipe.recipe_url : '';

      /* BILD (#1059, Schritt 2) - dasselbe Vorgehen wie beim Gegenstandsfoto:
       * Auswahl, Zuschnitt und Groessenpruefung macht `pickCroppedImage`.
       *
       * `bildStand` traegt DREI Zustaende, und die dritte ist der Grund fuer die
       * Fallunterscheidung beim Speichern: `undefined` heisst "nicht angefasst"
       * (der Server laesst das gespeicherte Bild stehen), `null` heisst "entfernt",
       * eine Data-URL heisst "das hier". Ohne den Unterschied schickte jedes
       * Speichern eines bebilderten Rezepts entweder null (Bild weg) oder muesste
       * die ganze Data-URL erneut hochladen. */
      let bildStand;
      const bildVorschau = panel.querySelector('#recipe-image-preview');
      const bildInput = panel.querySelector('#recipe-image');
      const zeigeBild = () => {
        if (!bildVorschau) return;
        bildVorschau.replaceChildren();
        // Beim Bearbeiten kommt das gespeicherte Bild ueber die Route, nicht aus
        // den Listendaten - dort steht nur das Flag (die Data-URL waere zu gross).
        const quelle = bildStand !== undefined
          ? bildStand
          : (isEdit && recipe?.has_own_image ? `/api/v1/recipes/${recipe.id}/image` : null);
        if (quelle) {
          const img = document.createElement('img');
          img.className = 'recipe-image-preview__img';
          img.src = quelle;
          img.alt = '';
          bildVorschau.appendChild(img);
        } else {
          bildVorschau.insertAdjacentHTML('beforeend', '<i data-lucide="image-plus" class="icon-md" aria-hidden="true"></i>');
          if (window.lucide) window.lucide.createIcons({ el: bildVorschau });
        }
      };
      zeigeBild();
      bildVorschau?.addEventListener('click', () => bildInput?.click());
      panel.querySelector('#recipe-image-pick')?.addEventListener('click', () => bildInput?.click());
      bildInput?.addEventListener('change', async (e) => {
        const datei = e.target.files?.[0];
        // Sofort zuruecksetzen: sonst feuert dieselbe Datei nach einem
        // abgebrochenen Zuschnitt kein zweites `change`.
        e.target.value = '';
        try {
          const { pickCroppedImage } = await import('/utils/avatar-crop.js');
          const zugeschnitten = await pickCroppedImage(datei, {
            messageKeys: { dataTooLarge: 'recipes.imageTooLarge' },
          });
          if (zugeschnitten === undefined) return; // abgebrochen
          bildStand = zugeschnitten;
          zeigeBild();
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
        }
      });
      panel.querySelector('#recipe-image-remove')?.addEventListener('click', () => {
        bildStand = null;
        zeigeBild();
      });
      panel.dataset.bildGesetzt = '';
      panel._bildStand = () => bildStand;
      const selectedMealTypes = normalizeRecipeMealTypes(isEdit ? recipe.meal_types : RECIPE_MEAL_TYPE_KEYS);
      // Der Dialog vergleicht fuer "Aenderungen verwerfen?" die Werte seiner
      // Felder (modal.js); ein Knopf hat keinen. Das versteckte Feld traegt die
      // Auswahl als Wert - ohne es verwarf Schliessen eine geaenderte Auswahl still.
      const typesValue = panel.querySelector('#recipe-meal-types-value');
      const syncTypesValue = () => {
        typesValue.value = [...panel.querySelectorAll('#recipe-meal-types [aria-pressed="true"]')]
          .map((chip) => chip.dataset.mealType).join(',');
      };
      panel.querySelectorAll('#recipe-meal-types [data-meal-type]').forEach((chip) => {
        const setPressed = (on) => {
          chip.setAttribute('aria-pressed', String(on));
          chip.classList.toggle('filter-chip--active', on);
        };
        setPressed(selectedMealTypes.includes(chip.dataset.mealType));
        chip.addEventListener('click', () => {
          setPressed(chip.getAttribute('aria-pressed') !== 'true');
          syncTypesValue();
        });
      });
      syncTypesValue();

      const ingList = panel.querySelector('#recipe-ingredient-list');
      if (isEdit && recipe.ingredients?.length) {
        ingList.insertAdjacentHTML('beforeend', recipe.ingredients.map((i) => ingredientRowHTML({
          name: i.name,
          quantity: i.quantity ?? '',
          category: i.category ?? DEFAULT_CATEGORY_NAME,
          categories: mealCategories(),
        })).join(''));
      }

      panel.querySelector('#recipe-add-ingredient')?.addEventListener('click', () => {
        ingList.insertAdjacentHTML('beforeend', ingredientRowHTML({ categories: mealCategories() }));
        if (window.lucide) window.lucide.createIcons({ el: ingList });
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (!btn) return;
        btn.closest('.ingredient-row')?.remove();
      });

      panel.querySelector('#recipe-cancel')?.addEventListener('click', closeModal);
      panel.querySelector('#recipe-delete')?.addEventListener('click', () => {
        closeModal({ force: true });
        removeRecipe(recipe);
      });
      panel.querySelector('#recipe-save')?.addEventListener('click', () => saveRecipe(panel, mode, recipe));
      // Pflichtfelder melden sich beim Verlassen inline (geteiltes Muster).
      wireBlurValidation(panel);

      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

function closeModal({ force = false } = {}) {
  closeSharedModal({ force });
}

async function saveRecipe(panel, mode, recipe) {
  // Die Rechte koennen sich aendern, waehrend der Dialog offen steht.
  if (readOnly()) return;
  const saveBtn = panel.querySelector('#recipe-save');
  const title = panel.querySelector('#recipe-title')?.value.trim() || '';
  const notes = panel.querySelector('#recipe-notes')?.value.trim() || null;
  const recipe_url = panel.querySelector('#recipe-url')?.value.trim() || null;
  const meal_types = [...panel.querySelectorAll('#recipe-meal-types [aria-pressed="true"]')].map((chip) => chip.dataset.mealType);

  if (!title) {
    // Fehler am Feld statt als ortloser Toast (geteiltes Muster, Critique P1).
    reportFieldError(panel.querySelector('#recipe-title'), t('common.nameRequired'));
    return;
  }

  const ingredients = [];
  panel.querySelectorAll('.ingredient-row').forEach((row) => {
    const name = row.querySelector('.ingredient-row__name')?.value.trim() || '';
    const quantity = row.querySelector('.ingredient-row__qty')?.value.trim() || null;
    const category = row.querySelector('.ingredient-row__cat')?.value || DEFAULT_CATEGORY_NAME;
    if (name) ingredients.push({ name, quantity, category });
  });

  // Nur mitschicken, wenn der Nutzer das Bild angefasst hat: ein fehlendes Feld
  // laesst das gespeicherte stehen (#1059).
  const bildStand = panel._bildStand?.();
  const bildFeld = bildStand === undefined ? {} : { image_data: bildStand };

  saveBtn.disabled = true;

  try {
    let createdId = null;
    if (mode === 'create') {
      const res = await api.post('/recipes', { title, notes, recipe_url, meal_types, ingredients, ...bildFeld });
      state.recipes.push(res.data);
      createdId = res.data?.id ?? null;
    } else {
      const res = await api.put(`/recipes/${recipe.id}`, { title, notes, recipe_url, meal_types, ingredients, ...bildFeld });
      const idx = state.recipes.findIndex((r) => r.id === recipe.id);
      if (idx >= 0) state.recipes[idx] = res.data;
    }

    closeModal({ force: true });
    renderRecipeList({ repaint: true });
    // In der Spalte steht das neue Rezept gleich rechts - wie eine neue Notiz
    // in Notizen. Darunter bleibt die Liste, wie sie war.
    if (createdId != null) selectOwnRecipe(createdId);
    window.yuvomi?.showToast(mode === 'create' ? t('recipes.created') : t('recipes.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

// --------------------------------------------------------
// Zutaten → Einkaufsliste
// --------------------------------------------------------

/**
 * Übernimmt die Zutaten eines Rezepts auf eine Einkaufsliste. Bei genau einer
 * Liste ohne Rückfrage, sonst über die geteilte Auswahl - dasselbe Muster wie
 * transferMeal() im Essensplan, damit sich der Weg in beiden Modulen gleich
 * anfühlt. Der Server überspringt Zutaten, die schon unabgehakt auf der Liste
 * liegen; die Rückmeldung nennt beide Zahlen.
 */
/**
 * Rezept in den Essensplan übernehmen: fragt „Für wann?" hier und legt die
 * Mahlzeit direkt an.
 *
 * Vorher navigierte dieser Weg auf `/meals?recipe=<id>`, wo ein Formular mit 27
 * Feldern aufging - Titel „Mahlzeit hinzufügen" ohne das Rezept zu nennen, das
 * Datumsfeld leer, 42 % des Dialogs unter der Sichtkante. Nach Escape blieb
 * `?recipe=` in der URL und ein Reload öffnete das Formular erneut, beliebig oft
 * (Critique 2026-07-29). Als einziger der fünf Transfers folgte er nicht dem
 * Muster der anderen.
 *
 * Jetzt zwei Entscheidungen statt neun Feldern, kein Seitenwechsel, und der
 * Query-Parameter existiert nicht mehr - der Zombie ist damit strukturell weg,
 * nicht per `replaceState` kaschiert. Details lassen sich danach im Essensplan
 * bearbeiten, wie bei jeder anderen Mahlzeit.
 */
async function planRecipe(recipe, btn) {
  if (!mayPlanRecipe()) return;
  const declared = normalizeRecipeMealTypes(recipe.meal_types);
  // Erklärt das Rezept keine Mahlzeit, stehen hier trotzdem alle zur Wahl: Der
  // leere Zustand hält es aus der Zufallsauswahl heraus (#750), nicht aus dem
  // Menüplan. Ohne diesen Rückgriff bliebe das Auswahlfeld leer und der Dialog
  // hätte nichts anzubieten, was der Nutzer bestätigen könnte.
  const types = declared.length ? declared : RECIPE_MEAL_TYPE_KEYS.slice();
  // Vorauswahl: erklärt das Rezept genau einen Typ, ist die Sache klar. Erklärt
  // es mehrere - was der Default ist, wenn niemand etwas gesetzt hat -, dann
  // stand bisher „Frühstück" da, weil es in der Liste zuerst kommt: der Dialog
  // schlug für ein Curry das Frühstück vor (Critique 2026-07-30). Ohne Signal
  // vom Rezept ist das Abendessen die ehrlichere Annahme, es ist die Mahlzeit,
  // die Haushalte am häufigsten planen.
  const vorauswahl = types.length === 1 ? types[0] : (types.includes('dinner') ? 'dinner' : types[0]);
  const typeOpts = mealTypeOptions()
    .filter(({ key }) => types.includes(key))
    .map(({ key, label }) =>
      `<option value="${key}"${key === vorauswahl ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');

  const today = todayKey();

  openSharedModal({
    title: t('recipes.planTitle', { name: recipe.title }),
    size: 'sm',
    content: `
      <div class="form-group">
        <label class="form-label" for="plan-date">${t('meals.dateLabel')}</label>
        <yuvomi-datepicker type="date" id="plan-date" value="${esc(formatDateInput(today))}"></yuvomi-datepicker>
      </div>
      <div class="form-group">
        <label class="form-label" for="plan-type">${t('meals.mealTypeLabel')}</label>
        <select class="form-input" id="plan-type">${typeOpts}</select>
      </div>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <!-- „Übernehmen", nicht die Wiederholung des Auslöser-Labels: die drei
             anderen Transfer-Dialoge bestätigen genauso, und der Dialogtitel
             nennt Rezept und Ziel bereits (Critique 2026-07-30). -->
        <button type="button" class="btn btn--primary" id="plan-confirm">${esc(t('common.apply'))}</button>
      </div>`,
    onSave(panel) {
      panel.querySelector('#plan-confirm').addEventListener('click', async (e) => {
        const confirmBtn = e.currentTarget;
        const dateField = panel.querySelector('#plan-date');
        if (!isDateInputValid(dateField.value)) {
          reportFieldError(dateField, t('calendar.invalidDate'));
          return;
        }
        const date = parseDateInput(dateField.value);
        const mealType = panel.querySelector('#plan-type').value;

        if (!mayPlanRecipe()) return;
        confirmBtn.disabled = true;
        try {
          await api.post('/meals', mealPayloadFromRecipe(recipe, date, mealType));
          closeSharedModal({ force: true });
          window.yuvomi?.showToast(
            t('recipes.planSuccess', { name: recipe.title, date: formatDate(date) }),
            'success',
          );
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
          confirmBtn.disabled = false;
        }
      });
    },
  });

  if (btn) btn.blur();
}

/**
 * Der Knopf „Auf die Einkaufsliste" im Rezeptdetail - oder `null`, wenn er
 * nichts ausloesen koennte: ohne Liste, ohne Zutaten, oder weil der Server ihn
 * abwiese. Das sind ZWEI Riegel (#1290): `/recipes` misst der Pfad-Guard als
 * `meals`, die Route verlangt dazu `shopping`. Mit `shopping: read` laedt
 * `state.lists` trotzdem - die Liste allein ist also keine Erlaubnis.
 */
function shoppingTransferButton(recipe, ingredients) {
  if (!state.lists.length || !ingredients.length) return null;
  if (!mayTransferRecipeToShopping(recipe.id)) return null;
  const btn = document.createElement('button');
  btn.className = 'btn btn--secondary';
  btn.type = 'button';
  btn.dataset.action = 'to-shopping';
  btn.dataset.id = String(recipe.id);
  btn.textContent = t('common.toShoppingList');
  return btn;
}

async function transferRecipe(recipe, btn) {
  // Zweite Linie hinter dem Markup (Regel 2 in utils/module-access.js).
  if (!mayTransferRecipeToShopping(recipe.id)) return;
  // Vorprüfung, Listenwahl und die Antwort auf „es gibt keine Liste" liegen im
  // geteilten Baustein. Vorher lieh sich diese Stelle `meals.noShoppingLists` -
  // der Text der Rezepte hing damit an einem fremden Modul, und ein Refactor im
  // Essensplan hätte ihn stillschweigend mitgenommen (Audit 2026-07-30, P1-A).
  const target = await resolveShoppingTarget(state.lists);
  if (!target) return;

  if (btn) btn.disabled = true;
  try {
    const res = await api.post(`/recipes/${recipe.id}/to-shopping-list`, { listId: target.id });
    const added = res.data?.transferred ?? 0;
    const skipped = res.data?.skipped ?? 0;

    if (added > 0) {
      // t() wählt die _one-Form selbst, sobald count numerisch ist (i18n.js).
      // `list` nennt das Ziel: „5 Zutaten übernommen." sagte nicht, in welche der
      // Listen (Critique 2026-07-30, P1).
      //
      // Rücknahme über den geteilten Baustein: dieser Pfad überträgt am meisten
      // auf einmal - eine ganze Zutatenliste - in eine Liste, die der Nutzer
      // gerade nicht ansieht (Audit 2026-07-30, P1-B).
      announceTransfer({
        message: t('recipes.toShoppingSuccess', { count: added, list: target.name }),
        addedIds: res.data?.added_ids ?? [],
      });
    } else if (skipped > 0) {
      window.yuvomi?.showToast(t('recipes.toShoppingAllPresent'), 'info');
    } else {
      window.yuvomi?.showToast(t('recipes.toShoppingNoIngredients'), 'info');
    }
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeRecipe(recipe) {
  // Vor dem Ausblenden der Zeile: sonst verschwaende sie, und das
  // Rueckgaengig-Fenster endete im 403.
  if (readOnly()) return;
  const itemEl = _container.querySelector(`.recipe-row-item[data-id="${recipe.id}"]`);
  if (itemEl) itemEl.style.display = 'none';
  // Steht das Rezept rechts in der Detailspalte, geht es dort mit: sonst
  // zeigte die Spalte ein Rezept, das die Liste schon nicht mehr fuehrt.
  // Rueckgaengig waehlt es wieder aus.
  const wasSelected = _md?.selectedId() === String(recipe.id);
  if (wasSelected) {
    _md.clear({ history: 'replace' });
    _container?.querySelector('#recipes-detail')?.focus();
  }

  scheduleUndoableDelete({
    message: t('recipes.deleted'),
    commit: async ({ keepalive }) => {
      await api.delete(`/recipes/${recipe.id}`, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      state.recipes = state.recipes.filter((r) => r.id !== recipe.id);
      renderRecipeList();
    },
    restore: (err) => {
      if (itemEl) itemEl.style.display = '';
      if (wasSelected && _md?.isSplit()) _md.select(recipe.id, { history: 'replace' });
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

/**
 * Waehlt in der Spalte ein Rezept aus, das die Seite gerade selbst angelegt
 * hat (Neu, Duplizieren).
 *
 * Ein benanntes Ziel schlaegt einen alten Filter (#936, dort fuer den
 * Deep-Link). Die Kopie eines Mealie-Rezepts ist nativ und faellt aus dem
 * Quellenfilter "Mealie"; ein neues Rezept passt nicht zwingend zur Suche.
 * Unbedingt ausgewaehlt stand rechts ein Rezept ohne Zeile links (Codex an
 * #1477). Also fallen Suche und Filter weg, BEVOR ausgewaehlt wird - und nur
 * dann, wenn das Rezept sonst fehlte: wer unter "Suppe" eine Suppe anlegt,
 * behaelt seine Suche.
 */
function selectOwnRecipe(id) {
  if (!_md?.isSplit()) return;
  if (!filteredRecipes().some((r) => String(r.id) === String(id))) {
    state.query = '';
    state.sourceFilter = 'all';
    _search?.clear();
    renderSourceFilter();
    renderRecipeList();
  }
  _md.select(id);
}

async function duplicateRecipe(recipe) {
  if (readOnly()) return;
  const copySuffix = t('recipes.copySuffix');
  const title = `${recipe.title} (${copySuffix})`;
  const notes = recipe.notes || null;
  const recipe_url = recipe.recipe_url || null;
  const ingredients = (recipe.ingredients || []).map((ing) => ({
    name: ing.name,
    quantity: ing.quantity || null,
    category: ing.category || DEFAULT_CATEGORY_NAME,
  }));

  try {
    const res = await api.post('/recipes', { title, notes, recipe_url, ingredients });
    state.recipes.push(res.data);
    renderRecipeList();
    // Die Kopie ist das, was man als Naechstes bearbeitet: in der Spalte steht
    // sie deshalb gleich rechts.
    if (res.data?.id != null) selectOwnRecipe(res.data.id);
    window.yuvomi?.showToast(t('recipes.duplicated'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

export const __test = {
  // #1290: der Transfer in den Einkauf braucht BEIDE Schreibrechte - Knopf und
  // Handler werden als Programm gefahren (test-kitchen-transfer-ui.js).
  state,
  shoppingTransferButton,
  transferRecipe,
  // R8 H10: Loeschen links im Dialogfuss.
  recipeModalFooterHtml,
  // R16: eigene Rezepte zeigen ihr Bild in Liste und Detail.
  rowShowsThumb, fillRecipeDetail,
  // #1265: Nur-lesen in den Rezepten - Zeile, Detail, Positivliste und jeder
  // Schreibweg als Programm (test-kitchen-readonly-ui.js).
  READ_SAFE_ACTIONS,
  SPLIT_ACTIONS,
  fabEl,
  emptyListOptions,
  buildRecipeList,
  setContainerForTest(container) { _container = container; },
  renderRecipePane,
  onSplitClick,
  openRecipeModal,
  saveRecipe,
  planRecipe,
  removeRecipe,
  duplicateRecipe,
  openPantryMatchModal,
  openPantryBulkMatchModal,
  pantryMatchEl,
  pantryMatchBulkEl,
};
