/**
 * Modul: Rezepte (Recipes)
 * Zweck: Gespeicherte Rezepte verwalten und in den Essensplan uebernehmen
 */

import { api } from '/api.js';
import { t, formatDate, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, advancedSection, wireBlurValidation, reportFieldError } from '/components/modal.js';
import { DEFAULT_CATEGORY_NAME } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer } from '/utils/kitchen-transfer.js';
import { popoverMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import { ingredientRowHTML } from '/utils/ingredient-row.js';
import { scheduleUndoableDelete } from '/utils/ux.js';
import { normalizeRecipeMealTypes, RECIPE_MEAL_TYPE_KEYS } from '/utils/recipe-meal-types.js';
import { mealPayloadFromRecipe } from '/utils/recipe-to-meal.js';
import { toLocalDateKey } from '/utils/date.js';
import '/components/datepicker.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { mountEmptyState, mountLoadError } from '/utils/empty-state.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';

let _container = null;
/** Handle des geteilten Suchfelds (setValue/clear), gesetzt in render(). */
let _search = null;

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
};

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

// Vorschaubild für ein gespiegeltes Rezept. Ohne Bild in Mealie (kein
// provider_has_image aus dem letzten Sync) direkt der Platzhalter - kein
// Thumbnail-Request, der ohnehin nur in einem 404 endet (bekannter Mealie-
// eigener Logspam, siehe mealie-recipes/mealie#4804). Mit Bild wird echt
// geladen, fällt aber per onerror auf denselben Platzhalter zurück, falls das
// Bild zwischen dem letzten Sync und jetzt in Mealie gelöscht wurde - sonst
// stünde ein kaputtes Bild-Icon in der Zeile, bis der nächste Sync es merkt.
function recipeThumb(recipe) {
  const slot = document.createElement('span');
  slot.className = 'recipe-row__thumb';
  if (!recipe.provider_has_image) {
    slot.classList.add('recipe-row__thumb--placeholder');
    slot.insertAdjacentHTML('beforeend', '<i data-lucide="utensils" class="icon-sm" aria-hidden="true"></i>');
    return slot;
  }
  const img = document.createElement('img');
  img.className = 'recipe-row__thumb-img';
  img.src = `/api/v1/recipes/${recipe.id}/provider-thumbnail`;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    img.remove();
    slot.classList.add('recipe-row__thumb--placeholder');
    slot.insertAdjacentHTML('beforeend', '<i data-lucide="utensils" class="icon-sm" aria-hidden="true"></i>');
    if (window.lucide) window.lucide.createIcons({ el: slot });
  }, { once: true });
  slot.appendChild(img);
  return slot;
}

function mealTypeOptions() {
  return [
    { key: 'breakfast', label: t('meals.typeBreakfast') },
    { key: 'lunch', label: t('meals.typeLunch') },
    { key: 'dinner', label: t('meals.typeDinner') },
    { key: 'snack', label: t('meals.typeSnack') },
  ];
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

export async function render(container) {
  _container = container;

  const page = document.createElement('div');
  page.className = 'recipes-page';

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
  // --narrow: der Kopf endet beim Lesemaß der Liste darunter (.kitchen-list),
  // nicht an der Content-Spalte. Siehe layout.css.
  toolbar.className = 'page-toolbar page-toolbar--in-group page-toolbar--narrow';
  const center = document.createElement('div');
  center.className = 'page-toolbar__center';
  // Geteilter Baustein (utils/page-search.js) statt eines eigenen Inputs. Er
  // bringt Lupe, Leeren-Knopf, `<label for>` und die mobilen Eingabe-Attribute
  // mit; der Nachbau hatte keines davon und ließ den Placeholder die
  // Beschriftung tragen, die beim ersten Zeichen verschwindet.
  center.insertAdjacentHTML('beforeend', renderPageSearch({
    id: 'recipes-search',
    // Label und Placeholder aus demselben Key, wie im Vorrat und in den drei
    // Referenzmodulen: „Rezepte durchsuchen" benennt das Feld vollständig.
    label: t('recipes.searchPlaceholder'),
    placeholder: t('recipes.searchPlaceholder'),
    value: state.query,
    clearLabel: t('common.searchClear'),
    className: 'recipes-search',
  }));
  toolbar.appendChild(center);

  // Trigger im __actions-Slot statt einer eigenen Pillen-Zeile darunter -
  // dieselbe Behandlung wie „Lagerorte verwalten" im Vorrat (btn--icon im
  // Kopf, kein zusätzliches Kopf-Element). Die frühere Chip-Reihe brauchte auf
  // schmalen Bildschirmen eine ganze eigene Zeile, nur für drei Optionen, von
  // denen fast immer "Alle" aktiv ist. Nur sichtbar, sobald mindestens ein
  // gespiegeltes Rezept existiert (renderSourceFilter füllt/versteckt sie nach
  // dem Laden).
  const actions = document.createElement('div');
  actions.className = 'page-toolbar__actions';
  actions.id = 'recipes-source-filter';
  actions.hidden = true;
  toolbar.appendChild(actions);

  const list = document.createElement('div');
  list.className = 'kitchen-list recipes-list';
  list.id = 'recipes-list';
  // Lade-Skeleton bis loadRecipes() aufgelöst ist (Router blendet den Wrapper
  // bereits vor dem Daten-await ein).
  list.setAttribute('aria-busy', 'true');
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 5, lines: 2 }));
  // Kein wireScrollFade mehr: die Liste kachelt nicht länger mit 320px-Mindest-
  // breite, sondern ist eine Zeilenliste in der 720er-Lesespalte. Der frühere
  // 32px-Überlauf bei 320px war eine Eigenschaft des Rasters und ist mit ihm weg.

  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.id = 'fab-new-recipe';
  fab.setAttribute('aria-label', t('recipes.addRecipe'));
  const fabIcon = document.createElement('i');
  fabIcon.dataset.lucide = 'plus';
  fabIcon.setAttribute('aria-hidden', 'true');
  fab.appendChild(fabIcon);

  page.append(title, toolbar, list, fab);
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/recipes');
  // Positionierung und Schliessen der Zeilen-Ueberlaufmenues. Idempotent, haengt an
  // der stabilen Seitenwurzel - die Liste darin wird bei jedem Filter neu gebaut.
  installPopoverMenus(page);

  if (window.lucide) window.lucide.createIcons({ el: container });

  await Promise.all([loadRecipes(), loadCategories(), loadShoppingLists()]);
  renderSourceFilter();
  renderRecipeList();

  fab.addEventListener('click', () => openRecipeModal('create'));

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

  list.addEventListener('click', async (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;

    // Aufklappen: der Zustand lebt am Button (aria-expanded) und am Panel
    // (hidden). `hidden` statt max-height-Transition, weil ein per Transition
    // versteckter Inhalt in headless-Renderern und auf inaktiven Tabs nie
    // erscheint - der Reveal muss einen sichtbaren Default verbessern, nicht
    // Sichtbarkeit an eine Animation binden.
    if (actionBtn.dataset.action === 'toggle-detail') {
      const panel = _container?.querySelector(`#recipe-detail-${actionBtn.dataset.id}`);
      if (!panel) return;
      const open = actionBtn.getAttribute('aria-expanded') === 'true';
      actionBtn.setAttribute('aria-expanded', String(!open));
      panel.hidden = open;
      return;
    }

    const recipeId = Number(actionBtn.dataset.id);
    const recipe = state.recipes.find((r) => r.id === recipeId);
    if (!recipe) return;

    if (actionBtn.dataset.action === 'edit') {
      openRecipeModal('edit', recipe);
      return;
    }

    if (actionBtn.dataset.action === 'delete') {
      await removeRecipe(recipe);
      return;
    }

    if (actionBtn.dataset.action === 'duplicate') {
      await duplicateRecipe(recipe);
      return;
    }

    if (actionBtn.dataset.action === 'to-shopping') {
      await transferRecipe(recipe, actionBtn);
      return;
    }

    if (actionBtn.dataset.action === 'add-to-meals') {
      await planRecipe(recipe, actionBtn);
    }
  });

  // Kein eigener keydown-Handler mehr: das Aufklappen sitzt auf einem echten
  // <button>, der Enter und Space von sich aus verarbeitet. Der frühere Handler
  // gehörte zur Karte, die role="button" trug und damit ein Bedienelement mit
  // Bedienelementen darin war.
}

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
            popovertarget="recipes-source-filter-menu"
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

function renderRecipeList() {
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
    mountEmptyState(list, {
      icon: 'book-text',
      title: t('recipes.emptyTitle'),
      description: t('recipes.emptyDescription'),
      hint: t('emptyHint.recipes'),
      action: {
        label: t('recipes.emptyAction'),
        icon: 'plus',
        onClick: () => document.querySelector('.page-fab')?.click(),
      },
    });
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
  rows.className = 'kitchen-rows';

  for (const recipe of visible) {
    // Mirror-Rezepte sind read-only (der Provider bleibt Quelle der Wahrheit); steuert
    // weiter unten sowohl die Zeilenaktionen als auch das Aufklapp-Detail.
    const isMirrored = recipe.source !== 'native';
    const ingredients = recipe.ingredients ?? [];
    const detailId = `recipe-detail-${recipe.id}`;
    const hasDetail = Boolean(ingredients.length || recipe.notes || recipe.recipe_url);

    const li = document.createElement('li');
    li.className = 'recipe-row-item';
    li.dataset.id = String(recipe.id);

    const row = document.createElement('div');
    row.className = 'kitchen-row recipe-row';

    // Kanonisches Accordion-Muster: Überschrift umschließt den Button. Die
    // Überschrift trägt die Dokumentstruktur, der Button den Zustand - vorher
    // war die ganze Karte ein role="button" MIT Buttons darin, was für
    // Hilfsmittel ein verschachteltes Bedienelement ist.
    const heading = document.createElement('h2');
    heading.className = 'kitchen-row__main recipe-row__heading';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kitchen-row__main--interactive recipe-row__toggle';
    toggle.dataset.action = 'toggle-detail';
    toggle.dataset.id = String(recipe.id);

    // Herkunft ist Teil der Identität der Zeile, nicht erst ein Detail: wer
    // durch eine gemischte Liste scrollt, muss vor dem Aufklappen sehen können,
    // welche Rezepte gespiegelt (und schreibgeschützt) sind, nicht erst
    // danach.
    if (isMirrored) toggle.appendChild(recipeThumb(recipe));

    const name = document.createElement('span');
    name.className = 'kitchen-row__name';
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
    // IMMER gerendert, auch bei 0: die Mindestbreite von .kitchen-row__meta
    // (15ch, siehe recipes.css) hält alles davor - das Mealie/Tandoor-Badge -
    // an derselben Stelle. Fehlte das Element ganz, würde der Name per
    // flex-grow den freiwerdenden Platz schlucken und das Badge nach rechts
    // schieben, sobald ein Rezept ganz ohne Zutaten in der Liste steht.
    const meta = document.createElement('span');
    meta.className = 'kitchen-row__meta';
    meta.textContent = t('meals.ingredientCount', { count: ingredients.length });
    toggle.appendChild(meta);

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
      toggle.classList.remove('kitchen-row__main--interactive');
      toggle.tabIndex = -1;
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
    const ROW_ACTIONS = [
      !isMirrored && { action: 'edit',      icon: 'pencil',  label: t('common.edit') },
      { action: 'duplicate', icon: 'copy',    label: t('recipes.duplicate') },
      !isMirrored && { action: 'delete',    icon: 'trash-2', label: t('common.delete'), danger: true },
    ].filter(Boolean);

    const actions = document.createElement('div');
    actions.className = 'kitchen-row__actions';

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

    row.appendChild(actions);
    li.appendChild(row);

    if (hasDetail) {
      const detail = document.createElement('div');
      detail.className = 'recipe-detail';
      detail.id = detailId;
      detail.hidden = true;

      const mealTypes = normalizeRecipeMealTypes(recipe.meal_types);
      // Chips nur, wenn sie unterscheiden: gilt ein Rezept für alle Mahlzeiten,
      // ist die volle Chip-Reihe reine Ornamentik (Audit A1-21). Das
      // Herkunfts-Badge sitzt jetzt schon in der Zeilenüberschrift (immer sichtbar,
      // nicht erst nach dem Aufklappen) und wird hier nicht noch einmal gezeigt.
      const showMealTypeBadges = mealTypes.length && mealTypes.length < mealTypeOptions().length;
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
      }

      // VOLLSTÄNDIGE Zutatenliste, nicht die ersten vier: das Kürzen war nur
      // nötig, um die Kartenhöhe zu bändigen. Ein Detail, das sich öffnet, hat
      // keinen Grund, etwas zu verschweigen.
      if (ingredients.length) {
        const ul = document.createElement('ul');
        ul.className = 'recipe-detail__ingredients';
        for (const ing of ingredients) {
          const item = document.createElement('li');
          item.className = 'recipe-detail__ingredient';
          item.textContent = ing.quantity ? `${ing.quantity} · ${ing.name}` : ing.name;
          ul.appendChild(item);
        }
        detail.appendChild(ul);
      }

      if (recipe.notes) {
        const notes = document.createElement('p');
        notes.className = 'recipe-detail__notes';
        notes.textContent = recipe.notes;
        detail.appendChild(notes);
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

      const addToMeals = document.createElement('button');
      addToMeals.className = 'btn btn--primary';
      addToMeals.type = 'button';
      addToMeals.dataset.action = 'add-to-meals';
      addToMeals.dataset.id = String(recipe.id);
      addToMeals.textContent = t('recipes.addToMeals');
      detailActions.appendChild(addToMeals);

      if (state.lists.length && ingredients.length) {
        const addToShopping = document.createElement('button');
        addToShopping.className = 'btn btn--secondary';
        addToShopping.type = 'button';
        addToShopping.dataset.action = 'to-shopping';
        addToShopping.dataset.id = String(recipe.id);
        addToShopping.textContent = t('common.toShoppingList');
        detailActions.appendChild(addToShopping);
      }

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

      detail.appendChild(detailActions);
      li.appendChild(detail);
    }

    rows.appendChild(li);
  }

  list.appendChild(rows);

  if (window.lucide) window.lucide.createIcons({ el: list });
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

function openRecipeModal(mode, recipe = null) {
  const isEdit = mode === 'edit';

  openSharedModal({
    title: isEdit ? t('recipes.editRecipe') : t('recipes.addRecipe'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="recipe-title">${t('common.nameLabel')}</label>
        <input id="recipe-title" class="form-input" type="text" required placeholder="${t('recipes.titlePlaceholder')}">
      </div>
      <div class="form-group">
        <label class="form-label">${t('meals.mealTypeLabel')}</label>
        <div class="recipe-meal-types" id="recipe-meal-types">
          ${mealTypeOptions().map((option) => `
            <label class="form-check recipe-meal-types__option">
              <input type="checkbox" value="${option.key}" checked>
              <span class="meal-type-badge meal-type-badge--${option.key}">${option.label}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('recipes.ingredientsLabel')}</label>
        <div class="recipe-ingredient-list" id="recipe-ingredient-list"></div>
        <button class="btn btn--secondary recipe-add-ingredient" type="button" id="recipe-add-ingredient">${t('meals.addIngredient')}</button>
      </div>
      ${advancedSection(`
        <div class="form-group">
          <label class="form-label" for="recipe-notes">${t('recipes.notesLabel')}</label>
          <textarea id="recipe-notes" class="form-input" rows="3" placeholder="${t('recipes.notesPlaceholder')}"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label" for="recipe-url">${t('recipes.urlLabel')}</label>
          <input id="recipe-url" class="form-input" type="url" placeholder="${t('recipes.urlPlaceholder')}">
        </div>`,
        { open: isEdit && (!!recipe.notes || !!recipe.recipe_url) })}
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button class="btn btn--secondary" id="recipe-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="recipe-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    `,
    onSave(panel) {
      panel.querySelector('#recipe-title').value = isEdit ? recipe.title : '';
      panel.querySelector('#recipe-notes').value = isEdit && recipe.notes ? recipe.notes : '';
      panel.querySelector('#recipe-url').value = isEdit && recipe.recipe_url ? recipe.recipe_url : '';
      const selectedMealTypes = normalizeRecipeMealTypes(isEdit ? recipe.meal_types : RECIPE_MEAL_TYPE_KEYS);
      panel.querySelectorAll('#recipe-meal-types input[type="checkbox"]').forEach((input) => {
        input.checked = selectedMealTypes.includes(input.value);
      });

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
  const saveBtn = panel.querySelector('#recipe-save');
  const title = panel.querySelector('#recipe-title')?.value.trim() || '';
  const notes = panel.querySelector('#recipe-notes')?.value.trim() || null;
  const recipe_url = panel.querySelector('#recipe-url')?.value.trim() || null;
  const meal_types = [...panel.querySelectorAll('#recipe-meal-types input[type="checkbox"]:checked')].map((input) => input.value);

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

  saveBtn.disabled = true;

  try {
    if (mode === 'create') {
      const res = await api.post('/recipes', { title, notes, recipe_url, meal_types, ingredients });
      state.recipes.push(res.data);
    } else {
      const res = await api.put(`/recipes/${recipe.id}`, { title, notes, recipe_url, meal_types, ingredients });
      const idx = state.recipes.findIndex((r) => r.id === recipe.id);
      if (idx >= 0) state.recipes[idx] = res.data;
    }

    closeModal({ force: true });
    renderRecipeList();
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
  const types = normalizeRecipeMealTypes(recipe.meal_types);
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

  const today = toLocalDateKey(new Date());

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

async function transferRecipe(recipe, btn) {
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
  const itemEl = _container.querySelector(`.recipe-row-item[data-id="${recipe.id}"]`);
  if (itemEl) itemEl.style.display = 'none';

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
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

async function duplicateRecipe(recipe) {
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
    window.yuvomi?.showToast(t('recipes.duplicated'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}
