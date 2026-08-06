/**
 * Modul: Essensplan (Meals)
 * Zweck: Wochenansicht mit Mahlzeit-CRUD, Zutaten-Verwaltung und Einkaufslisten-Integration
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, selectModal, confirmModal, advancedSection, wireBlurValidation, reportFieldError } from '/components/modal.js';
import { stagger, scheduleUndoableDelete, wireScrollFade } from '/utils/ux.js';
import { t, formatDate, formatDayMonth, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { DEFAULT_CATEGORY_NAME } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer, mountMissingShoppingList } from '/utils/kitchen-transfer.js';
import { ingredientRowHTML } from '/utils/ingredient-row.js';
import { addLocalDays, startOfLocalWeekKey, toLocalDateKey } from '/utils/date.js';
import { normalizeRecipeMealTypes, recipeSupportsMealType } from '/utils/recipe-meal-types.js';
import { mountEmptyState, mountLoadError, emptyStateEl } from '/utils/empty-state.js';
import { mealPayloadFromRecipe } from '/utils/recipe-to-meal.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const MEAL_TYPES = () => [
  { key: 'breakfast', label: t('meals.typeBreakfast'), icon: 'sunrise' },
  { key: 'lunch',     label: t('meals.typeLunch'),     icon: 'sun'     },
  { key: 'dinner',    label: t('meals.typeDinner'),    icon: 'moon'    },
  { key: 'snack',     label: t('meals.typeSnack'),     icon: 'cookie'  },
];

const DAY_NAMES = () => [
  t('meals.dayMo'), t('meals.dayDi'), t('meals.dayMi'), t('meals.dayDo'),
  t('meals.dayFr'), t('meals.daySa'), t('meals.daySo'),
];

const EXCLUDED_MEAL_CATEGORY_NAMES = new Set(['Haushalt', 'Drogerie']);

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  currentWeek:      null,   // YYYY-MM-DD (Montag)
  meals:            [],
  recipes:          [],
  lists:            [],     // Einkaufslisten für Transfer-Dropdown
  categories:       [],     // Einkaufskategorien für Zutaten
  modal:            null,
  visibleMealTypes: ['breakfast', 'lunch', 'dinner', 'snack'],
  /** Gefangener Fehler des letzten Wochen-Ladevorgangs, sonst null.
   *  Ohne dieses Feld ist eine fehlgeschlagene Woche von einer leeren Woche
   *  nicht zu unterscheiden - und der Renderer zeigte den Leerzustand. */
  loadError:        null,
};

// Container-Referenz für Hilfsfunktionen (wird in render() gesetzt)
let _container = null;
let _dragRecipeId = null;

// --------------------------------------------------------
// Datumshelfer
// --------------------------------------------------------

function getMondayOf(dateStr) {
  return startOfLocalWeekKey(dateStr, 1);
}

function addDays(dateStr, n) {
  return addLocalDays(dateStr, n);
}

function formatWeekLabel(monday) {
  const sunday = addDays(monday, 6);
  return `${formatDate(monday)} – ${formatDate(sunday)}`;
}

function isToday(dateStr) {
  return dateStr === toLocalDateKey(new Date());
}

function formatDayDate(dateStr) {
  // Ohne Jahr (Audit F-04): das Wochen-Label in der Nav trägt das Jahr; in den
  // 7 Board-Spalten kollidierte das volle Datum mit dem Wochentagsnamen.
  return formatDayMonth(dateStr);
}

function mealCategories() {
  return state.categories.filter((c) => !EXCLUDED_MEAL_CATEGORY_NAMES.has(c.name));
}

function recipeMealTypeOptions() {
  return [
    { key: 'breakfast', label: t('meals.typeBreakfast') },
    { key: 'lunch', label: t('meals.typeLunch') },
    { key: 'dinner', label: t('meals.typeDinner') },
    { key: 'snack', label: t('meals.typeSnack') },
  ];
}

function buildRandomMealAssignments({ weekStart, visibleMealTypes, meals, recipes, replaceExisting = false, pick = Math.random }) {
  const assignments = [];
  const deleteMealIds = [];
  const previousDayByMealType = new Map();
  let hasOpenSlot = false;
  let hasCompatibleSlot = false;

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const date = addDays(weekStart, dayOffset);
    let previousRecipeIdSameDay = null;
    for (const mealType of visibleMealTypes) {
      const slotMeals = meals.filter((meal) => meal.date === date && meal.meal_type === mealType);
      if (!replaceExisting && slotMeals.length) continue;
      hasOpenSlot = true;
      const compatible = recipes.filter((recipe) => recipeSupportsMealType(recipe, mealType));
      if (!compatible.length) continue;
      hasCompatibleSlot = true;
      const blockedIds = new Set([previousRecipeIdSameDay, previousDayByMealType.get(mealType)].filter(Boolean));
      const preferred = compatible.filter((recipe) => !blockedIds.has(recipe.id));
      const pool = preferred.length ? preferred : compatible;
      const index = Math.floor(Math.max(0, Math.min(0.999999, Number(pick()) || 0)) * pool.length);
      const recipe = pool[index] || pool[0];
      assignments.push({
        date,
        mealType,
        recipe,
        payload: mealPayloadFromRecipe(recipe, date, mealType),
      });
      previousRecipeIdSameDay = recipe.id;
      previousDayByMealType.set(mealType, recipe.id);
      if (replaceExisting) deleteMealIds.push(...slotMeals.map((meal) => meal.id));
    }
  }

  const reason = assignments.length
    ? null
    : !hasOpenSlot
      ? 'week_full'
      : !hasCompatibleSlot
        ? 'no_compatible_recipes'
        : 'no_assignments';

  return { assignments, deleteMealIds: [...new Set(deleteMealIds)], reason };
}

// --------------------------------------------------------
// API-Wrapper
// --------------------------------------------------------

async function loadWeek(week) {
  const currentWeek = getMondayOf(week);
  state.currentWeek = currentWeek;
  try {
    const res = await api.get(`/meals?week=${currentWeek}`);
    state.meals     = Array.isArray(res.data) ? res.data : [];
    state.loadError = null;
  } catch (err) {
    console.error('[Meals] loadWeek Fehler:', err);
    state.meals     = [];
    // Der Fehler wird bis zum Renderer getragen statt in einen Toast gelegt.
    // Ein Toast verschwindet nach Sekunden, der falsche Leerzustand darunter
    // blieb stehen - von den beiden Meldungen überlebte also genau die
    // irreführende (Critique P0, 2026-07-30).
    state.loadError = err;
  }
}

async function loadLists() {
  try {
    const res   = await api.get('/shopping');
    state.lists = res.data;
  } catch {
    state.lists = [];
  }
}

async function loadCategories() {
  try {
    const res       = await api.get('/shopping/categories');
    state.categories = res.data;
  } catch {
    state.categories = [];
  }
}

async function loadRecipes() {
  try {
    const res = await api.get('/recipes');
    state.recipes = res.data;
  } catch {
    state.recipes = [];
  }
}

async function loadPreferences() {
  try {
    const res = await api.get('/preferences');
    state.visibleMealTypes = res.data.visible_meal_types ?? state.visibleMealTypes;
  } catch {
    // Default beibehalten
  }
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

export async function render(container, { user }) {
  _container = container;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="meals-page">
      <h1 class="sr-only">${t('nav.meals')}</h1>
      <!-- Kanonischer Kopf, Gruppen-Variante (.page-toolbar--in-group in
           layout.css): Akzentstreifen und oberste Sticky-Position bleiben bei
           der .kitchen-tabs-bar darüber. Vorher war das hier eine eigene
           .week-nav-Grammatik, eine von vier im Modul (Critique 2026-07-29).

           Die Datums-Navigation liegt geschlossen im __center-Slot. Vorher
           standen „<" und „>" an den beiden Enden der Zeile, mit dem gesamten
           Aktionsblock dazwischen - mobil gemessen 80px und 705px, einhändig
           also nie beide erreichbar. -->
      <div class="page-toolbar page-toolbar--in-group page-toolbar--wrap">
        <div class="page-toolbar__center week-nav">
          <button class="btn btn--icon" id="week-prev" aria-label="${t('meals.prevWeek')}">
            <i data-lucide="chevron-left" aria-hidden="true"></i>
          </button>
          <span class="week-nav__label" id="week-label"></span>
          <button class="btn btn--icon" id="week-next" aria-label="${t('meals.nextWeek')}">
            <i data-lucide="chevron-right" aria-hidden="true"></i>
          </button>
        </div>
        <div class="page-toolbar__actions">
          <button class="week-nav__today" id="week-today">${t('meals.today')}</button>
          <!-- Nur Desktop: klappt die Rezept-Spalte weg, damit alle sieben
               Tagesspalten in voller Breite ins Board passen. -->
          <button class="btn btn--icon week-nav__rail-toggle" id="rail-toggle"
                  aria-expanded="true" aria-controls="recipe-sidebar"
                  aria-label="${t('meals.hideRecipes')}" title="${t('meals.hideRecipes')}">
            <i data-lucide="panel-right-close" class="icon-md" aria-hidden="true"></i>
          </button>
          <!-- Zuletzt und als Ghost: der Zufallsplan kann 28 Slots umschreiben,
               stand aber im teuersten Pixel des Kopfes direkt neben „Heute" -
               in der Gewichtung eines Datumssprungs (Critique 2026-07-29). Er
               bleibt erreichbar, führt den Kopf aber nicht mehr an. -->
          <button class="btn btn--ghost week-nav__randomize" id="week-randomize">${t('meals.randomizePlan')}</button>
        </div>
      </div>
      <div class="meals-layout">
        <div class="week-grid" id="week-grid">
          <div style="grid-column:1/-1">${renderSkeletonList({ rows: 5, lines: 2 })}</div>
        </div>
        <aside class="recipe-sidebar" id="recipe-sidebar"></aside>
      </div>
      <button class="page-fab" id="fab-new-meal" aria-label="${t('meals.addMealTitle')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });
  renderKitchenTabsBar(container, '/meals');

  const today  = toLocalDateKey(new Date());
  const monday = getMondayOf(today);

  await Promise.all([loadWeek(monday), loadLists(), loadPreferences(), loadCategories(), loadRecipes()]);
  renderWeekGrid();
  renderRecipeSidebar();
  wireNav();
  wireRecipeSidebar();
  wireRailToggle();

  container.querySelector('#fab-new-meal').addEventListener('click', () => {
    const firstType = state.visibleMealTypes[0] ?? 'lunch';
    openMealModal({ mode: 'create', date: today, mealType: firstType });
  });
}

// --------------------------------------------------------
// Rezept-Spalte ein-/ausklappen
// --------------------------------------------------------

const RAIL_STORAGE_KEY = 'yuvomi-meals-rail';

/**
 * Klappt die Rezept-Spalte weg. Sie belegt auf 1024-1439px 272px und ab 1440px
 * 320px - genau die Breite, die dem Board für den siebten Tag fehlt: mit ihr
 * sind Samstag und Sonntag nur über horizontales Scrollen erreichbar, ohne sie
 * passen alle sieben Spalten in voller Breite (Critique 2026-07-29). Die
 * Mindestbreite der Tagesspalten bleibt unangetastet, damit die Namen nicht
 * wieder silbenweise brechen (siehe Kommentar an .week-grid in meals.css).
 */
function wireRailToggle() {
  const btn = _container.querySelector('#rail-toggle');
  const layout = _container.querySelector('.meals-layout');
  if (!btn || !layout) return;

  const apply = (hidden) => {
    layout.classList.toggle('meals-layout--rail-hidden', hidden);
    btn.setAttribute('aria-expanded', String(!hidden));
    const label = hidden ? t('meals.showRecipes') : t('meals.hideRecipes');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const icon = btn.querySelector('i, svg');
    if (icon) {
      icon.remove();
      btn.insertAdjacentHTML('afterbegin',
        `<i data-lucide="${hidden ? 'panel-right-open' : 'panel-right-close'}" class="icon-md" aria-hidden="true"></i>`);
      if (window.lucide) lucide.createIcons({ el: btn });
    }
  };

  // Default: gemessen, nicht per Breakpoint.
  //
  // Die Rezept-Spalte kostet 272-320px - genau die Breite, die dem Board für
  // die letzten Tage fehlt. Mit ihr zeigte das Board gemessen 4 von 7 Tagen
  // (Critique 2026-07-30). Eine px-Schwelle wäre hier die falsche Antwort: die
  // Zahl der Spalten hängt an den sichtbaren Mahlzeitstypen, und Zoom sowie
  // Schriftgröße verschieben sie zusätzlich. Stattdessen die Frage stellen, um
  // die es geht - passt die Woche mit offener Spalte? -, und nur dann
  // einklappen. Eine bewusste Entscheidung des Nutzers überschreibt den
  // Default dauerhaft (localStorage).
  let hidden = false;
  let gespeichert = null;
  try { gespeichert = localStorage.getItem(RAIL_STORAGE_KEY); } catch { /* ignore */ }
  if (gespeichert) {
    hidden = gespeichert === 'hidden';
  } else {
    const grid = _container.querySelector('#week-grid');
    const desktop = !window.matchMedia?.('(max-width: 640px)').matches;
    hidden = Boolean(desktop && grid && grid.scrollWidth > grid.clientWidth + 1);
  }
  apply(hidden);

  btn.addEventListener('click', () => {
    hidden = !layout.classList.contains('meals-layout--rail-hidden');
    apply(hidden);
    try { localStorage.setItem(RAIL_STORAGE_KEY, hidden ? 'hidden' : 'shown'); } catch { /* ignore */ }
  });
}

// --------------------------------------------------------
// Wochengitter
// --------------------------------------------------------

function renderWeekGrid() {
  const grid = _container.querySelector('#week-grid');
  if (!grid) return;

  _container.querySelector('#week-label').textContent =
    formatWeekLabel(state.currentWeek);

  // Fehlgeschlagene Woche: Fehlerzustand statt Leerzustand. Muss VOR der
  // Leer-Prüfung stehen - `state.meals` ist nach einem Fehler ebenfalls leer,
  // und die Reihenfolge ist das Einzige, was die beiden Fälle trennt.
  if (state.loadError) {
    grid.removeAttribute('aria-busy');
    mountLoadError(grid, {
      title: t('meals.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        grid.setAttribute('aria-busy', 'true');
        await loadWeek(state.currentWeek);
        renderWeekGrid();
      },
    });
    return;
  }

  // Leere Woche: Leerzustand statt Slot-Raster.
  //
  // Der Essensplan ist die Default-Landung des Küchen-Moduls und war bis hierher
  // der einzige der vier Tabs ohne Leerzustand - ein neuer Haushalt sah bis zu
  // 28 gestrichelte Kästen ohne ein Wort, während die drei Geschwister je einen
  // vollständigen Leerzustand mit CTA hatten (Critique P0, 2026-07-29).
  //
  // Der Hinweis richtet sich danach, was der Haushalt schon hat: ohne Rezepte
  // nennt er die nächste Station des Kreislaufs (der Plan füllt die
  // Einkaufsliste), mit Rezepten den schnelleren Weg (Rezept direkt einplanen).
  // Die Wochennavigation im Kopf bleibt erreichbar - der Leerzustand ersetzt nur
  // das Raster, nicht die Seite.
  if (!state.meals.length) {
    grid.removeAttribute('aria-busy');
    mountEmptyState(grid, {
      icon: 'utensils',
      title: t('meals.emptyTitle'),
      description: t('meals.emptyDescription'),
      hint: state.recipes.length ? t('meals.emptyHintRecipes') : t('emptyHint.meals'),
      action: {
        label: t('meals.emptyAction'),
        icon: 'plus',
        onClick: () => openMealModal({
          mode: 'create',
          date: state.currentWeek,
          mealType: state.visibleMealTypes[0] ?? 'lunch',
        }),
      },
    });
    return;
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(state.currentWeek, i));
  const dayNames = DAY_NAMES();
  // Default-Typ für den mobilen Per-Tag-Add-Button (Modal lässt den Typ ändern).
  const firstType = state.visibleMealTypes[0] ?? 'lunch';
  const visibleTypes = MEAL_TYPES().filter((type) => state.visibleMealTypes.includes(type.key));

  // Desktop-Board: Typ-Label EINMAL pro Zeile in der linken Gutter-Spalte statt
  // in jedem der bis zu 28 Slots (Critique P1: 21 redundante, silbengetrennte
  // Labels pro Woche). Mobil unsichtbar (display:none); die Slot-eigenen Labels
  // bleiben dort sichtbar und am Desktop als Screenreader-Text erhalten —
  // darum ist die Gutter-Spalte fürs Accessibility-Tree ein reines Duplikat
  // und wird mit aria-hidden ausgeblendet.
  const gutterHTML = visibleTypes.map((type, ti) => `
    <div class="week-gutter-label" data-type="${type.key}" style="--type-row: ${ti + 2}" aria-hidden="true">
      <span class="week-gutter-label__text">${type.label}</span>
    </div>
  `).join('');

  grid.replaceChildren();
  grid.insertAdjacentHTML('beforeend', gutterHTML + weekDays.map((date, dayIndex) => {
    const mealsForDay = state.meals.filter((m) => m.date === date);
    const todayClass  = isToday(date) ? 'day-header--today' : '';
    const dayNameIndex = (new Date(`${date}T00:00:00`).getDay() + 6) % 7;
    // Spalte 1 ist die Gutter-Spalte, Zeile 1 die Kopfzeile — Inhalte ab 2.
    const dayCol = dayIndex + 2;

    return `
      <div class="day-column">
        <div class="day-header ${todayClass}" style="--day-col: ${dayCol}">
          <span class="day-header__name">${dayNames[dayNameIndex]}</span>
          <span class="day-header__date">${formatDayDate(date)}</span>
        </div>
        <div class="day-slots">
          ${visibleTypes.map((type, ti) => renderSlot(date, type, mealsForDay, dayCol, ti + 2)).join('')}
        </div>
        <button class="day-add" data-action="add-meal" data-date="${date}" data-type="${firstType}" aria-label="${t('meals.addMealTitle')}">
          <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>
          <span>${t('meals.addMealTitle')}</span>
        </button>
      </div>
    `;
  }).join(''));

  grid.removeAttribute('aria-busy');
  if (window.lucide) lucide.createIcons({ el: grid });
  stagger(grid.querySelectorAll('.meal-card'));
  wireGrid(grid);

  // Scroll-Affordance des Desktop-Boards: End-Anriss signalisiert verborgene
  // Tage rechts (Critique-Folgebefund; Muster wie Tab-Leisten/Chip-Zeilen).
  // Einmal binden — der MutationObserver von wireScrollFade deckt spätere
  // replaceChildren-Rerenders ab.
  if (!grid.dataset.fadeWired) {
    grid.dataset.fadeWired = 'true';
    wireScrollFade(grid);
  }

  // Auf schmalen Viewports (gestapelte Tage) den heutigen Tag in den Blick scrollen.
  if (window.matchMedia?.('(max-width: 640px)').matches) {
    grid.querySelector('.day-header--today')?.closest('.day-column')
      ?.scrollIntoView({ block: 'start' });
  } else if (grid.scrollWidth > grid.clientWidth + 1) {
    // Desktop-Board mit horizontalem Scroll-Fenster: heutigen Tag in den Blick
    // holen - aber NUR, wenn er nicht ohnehin sichtbar ist.
    //
    // Vorher zentrierte diese Zeile unbedingt und erzeugte damit `scrollLeft`
    // von 156px, obwohl heute (Mittwoch) längst im Fenster lag. Der erste
    // Wochentag rutschte dadurch hinter die sticky Gutter-Spalte, deren
    // opaker Hintergrund ihn vollständig verdeckte: Montag war bei jedem Laden
    // reproduzierbar unsichtbar, ohne jeden Hinweis (Critique 2026-07-30).
    // Die Woche beginnt jetzt bei Montag, solange heute im Blick ist.
    const todayHeader = grid.querySelector('.day-header--today');
    if (todayHeader) {
      const gridBox = grid.getBoundingClientRect();
      const todayBox = todayHeader.getBoundingClientRect();
      const gutter = grid.querySelector('.week-gutter-label')?.getBoundingClientRect().width ?? 0;
      const verdeckt = todayBox.left < gridBox.left + gutter || todayBox.right > gridBox.right;
      if (verdeckt) todayHeader.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  }
}

function renderRecipeSidebar() {
  const sidebar = _container.querySelector('#recipe-sidebar');
  if (!sidebar) return;
  sidebar.replaceChildren();

  const title = document.createElement('h2');
  title.className = 'recipe-sidebar__title';
  title.textContent = t('nav.recipes');
  sidebar.appendChild(title);

  // Der Drag-Hinweis erscheint nur, wenn es etwas zu ziehen gibt. Vorher stand
  // „Ziehe Rezepte auf Essens-Slots" unbedingt da - bei leerem Haushalt direkt
  // über „Noch keine Rezepte", also eine Anleitung für etwas, das es nicht gibt.
  // Das war der einzige Text auf dem ersten Screen des Moduls und widersprach
  // sich selbst (Critique P0, 2026-07-29).
  if (!state.recipes.length) {
    // Geteilter Renderer statt nacktem Satz: das Panel war die fünfte Leerfläche
    // im Modul und die einzige, die den Renderer umging - ohne Icon, ohne CTA,
    // direkt neben dem gestalteten Leerzustand des Boards (Critique 2026-07-30).
    sidebar.appendChild(emptyStateEl({
      icon: 'book-text',
      title: t('recipes.emptyTitle'),
      description: t('recipes.emptyDescription'),
      action: {
        label: t('recipes.emptyAction'),
        icon: 'plus',
        onClick: () => window.yuvomi?.navigate('/recipes'),
      },
    }));
    if (window.lucide) window.lucide.createIcons({ el: sidebar });
    return;
  }

  const hint = document.createElement('p');
  hint.className = 'recipe-sidebar__hint';
  hint.textContent = t('recipes.dragToMealsHint');
  sidebar.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'recipe-sidebar__list';

  state.recipes.forEach((recipe) => {
    const card = document.createElement('article');
    card.className = 'recipe-sidebar__card';
    card.draggable = true;
    card.dataset.recipeId = String(recipe.id);

    const titleEl = document.createElement('div');
    titleEl.className = 'recipe-sidebar__card-title';
    titleEl.textContent = recipe.title;
    card.appendChild(titleEl);

    if (recipe.source !== 'native') {
      const sourceBadgeEl = document.createElement('span');
      sourceBadgeEl.className = `source-badge source-badge--${recipe.source}`;
      sourceBadgeEl.textContent = t(`recipes.source${recipe.source[0].toUpperCase()}${recipe.source.slice(1)}`);
      if (recipe.provider_account_name) sourceBadgeEl.title = recipe.provider_account_name;
      card.appendChild(sourceBadgeEl);
    }

    // Mahlzeiten-Chips nur bei echter Teilmenge: ein Rezept, das zu allen (oder
    // keinem) Typ passt, trägt mit "überall"-Chips null Information und ist dann
    // das lauteste Element der Karte (Audit P2, Muster wie recipes.js showBadges).
    const recipeTypes = normalizeRecipeMealTypes(recipe.meal_types);
    const allTypeOptions = recipeMealTypeOptions();
    if (recipeTypes.length && recipeTypes.length < allTypeOptions.length) {
      const types = document.createElement('div');
      types.className = 'recipe-sidebar__card-types';
      allTypeOptions
        .filter((option) => recipeTypes.includes(option.key))
        .forEach((option) => {
          const badge = document.createElement('span');
          badge.className = `meal-type-badge meal-type-badge--${option.key}`;
          badge.textContent = option.label;
          types.appendChild(badge);
        });
      card.appendChild(types);
    }

    list.appendChild(card);
  });

  sidebar.appendChild(list);
}

function renderSlot(date, type, mealsForDay, dayCol, typeRow) {
  const meals = mealsForDay.filter((m) => m.meal_type === type.key);
  // Explizite Grid-Platzierung fürs Desktop-Board (day-column/day-slots werden
  // dort zu display:contents); mobil ohne Wirkung, da die Slots im Fluss liegen.
  const gridPos = `--day-col: ${dayCol}; --type-row: ${typeRow}`;

  if (!meals.length) {
    return `
      <div class="meal-slot meal-slot--empty" data-date="${date}" data-type="${type.key}" style="${gridPos}">
        <div class="meal-slot__type-label"><span class="meal-slot__type-text">${type.label}</span></div>
        <button
          class="meal-slot__add-btn"
          data-action="add-meal"
          data-date="${date}"
          data-type="${type.key}"
          aria-label="${t('meals.addMeal', { type: type.label })}"
        >
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
    `;
  }

  const cardsHTML = meals.map((meal) => {
    const ownCount    = meal.ingredients?.length ?? 0;
    const ingDone     = meal.ingredients?.filter((i) => i.on_shopping_list).length ?? 0;
    // Aus einem Rezept geplante Mahlzeiten haben noch keine eigenen Zutaten;
    // der Server liefert dafür die Zahl aus dem Rezept mit. Sonst bliebe der
    // Einkaufslisten-Button genau dort aus, wo die Zutaten längst bekannt sind
    // (Critique 2026-07-29: sichtbar auf 1 von 22 Karten). Der erste Transfer
    // materialisiert sie, danach zählt wieder ownCount.
    const recipeCount = ownCount === 0 ? (meal.recipe_ingredient_count ?? 0) : 0;
    const ingCount    = ownCount || recipeCount;
    const ingLabel    = ingCount > 0 ? t('meals.ingredientCount', { count: ingCount }) : '';
    const ingDoneLabel = ownCount > 0 && ingDone === ownCount ? ' ✓' : '';
    const canTransfer  = recipeCount > 0 || (ownCount > 0 && ingDone < ownCount);
    const recurrenceBadge = meal.recurrence_template_id
      ? `<span class="meal-card__recurrence" aria-label="${t('meals.recurrenceBadge')}"><i data-lucide="repeat-2" class="icon-sm" aria-hidden="true"></i></span>`
      : '';

    return `
      <div class="meal-card"
           data-action="edit-meal"
           data-meal-id="${meal.id}"
           role="button" tabindex="0">
        <div class="meal-card__title"><span class="meal-card__title-text">${esc(meal.title)}</span>${recurrenceBadge}</div>
        ${ingLabel ? `<div class="meal-card__meta">
          <span class="meal-card__ingredients-count">${ingLabel}${esc(ingDoneLabel)}</span>
        </div>` : ''}
        <div class="meal-card__actions">
          ${meal.recipe_url ? `<a class="meal-card__action-btn meal-card__action-btn--recipe"
            data-action="open-recipe"
            href="${esc(meal.recipe_url)}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="${t('meals.openRecipe')}"
          ><i data-lucide="link" class="icon-sm" aria-hidden="true"></i></a>` : ''}
          ${canTransfer ? `<button class="meal-card__action-btn meal-card__action-btn--shopping"
            data-action="transfer-meal"
            data-meal-id="${meal.id}"
            aria-label="${t('common.toShoppingList')}"
          ><i data-lucide="shopping-cart" class="icon-sm" aria-hidden="true"></i></button>` : ''}
          <button class="meal-card__action-btn"
            data-action="delete-meal"
            data-meal-id="${meal.id}"
            aria-label="${t('meals.deleteMeal')}"
          ><i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i></button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="meal-slot meal-slot--has-meal" data-date="${date}" data-type="${type.key}" style="${gridPos}">
      <div class="meal-slot__type-label"><span class="meal-slot__type-text">${type.label}</span></div>
      ${cardsHTML}
      <button
        class="meal-slot__add-more-btn"
        data-action="add-meal"
        data-date="${date}"
        data-type="${type.key}"
        aria-label="${t('meals.addMeal', { type: type.label })}"
      ><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i></button>
    </div>
  `;
}

// --------------------------------------------------------
// Event-Delegation
// --------------------------------------------------------

function setWeekBusy() {
  // Sichtbares Lade-Feedback beim Wochenwechsel (dimmt das Raster via CSS,
  // meldet Screenreadern „busy"), bis renderWeekGrid das Attribut wieder entfernt.
  _container.querySelector('#week-grid')?.setAttribute('aria-busy', 'true');
}

function wireNav() {
  _container.querySelector('#week-prev')?.addEventListener('click', async () => {
    setWeekBusy();
    await loadWeek(addDays(state.currentWeek, -7));
    renderWeekGrid();
  });

  _container.querySelector('#week-next')?.addEventListener('click', async () => {
    setWeekBusy();
    await loadWeek(addDays(state.currentWeek, 7));
    renderWeekGrid();
  });

  _container.querySelector('#week-today')?.addEventListener('click', async () => {
    const monday = getMondayOf(toLocalDateKey(new Date()));
    if (monday === state.currentWeek) return;
    setWeekBusy();
    await loadWeek(monday);
    renderWeekGrid();
  });

  _container.querySelector('#week-randomize')?.addEventListener('click', openRandomizeModal);
}

function wireGrid(grid) {
  // Delegation am stabilen #week-grid nur EINMAL binden. renderWeekGrid läuft bei
  // jedem Wochenwechsel erneut, ersetzt aber nur die Kinder (replaceChildren) —
  // ohne Guard akkumulierten click/keydown/pointerdown-Listener und feuerten
  // add-/delete-/transfer-meal mehrfach (Muster wie shopping.js#wireListContentEvents).
  if (grid.dataset.eventsWired) return;
  grid.dataset.eventsWired = 'true';

  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;

    if (action === 'add-meal') {
      openMealModal({ mode: 'create', date: btn.dataset.date, mealType: btn.dataset.type });
      return;
    }

    if (action === 'open-recipe') {
      // Link öffnet sich nativ - nur Bubbling stoppen damit kein Edit-Modal aufgeht
      e.stopPropagation();
      return;
    }

    if (action === 'edit-meal') {
      const mealId = parseInt(btn.dataset.mealId, 10);
      const meal   = state.meals.find((m) => m.id === mealId);
      if (meal) openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type });
      return;
    }

    if (action === 'delete-meal') {
      await deleteMeal(parseInt(btn.dataset.mealId, 10));
      return;
    }

    if (action === 'transfer-meal') {
      await transferMeal(parseInt(btn.dataset.mealId, 10), btn);
    }
  });

  grid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('[data-action="edit-meal"]');
      if (card) { e.preventDefault(); card.click(); }
    }
  });

  grid.addEventListener('dragover', (e) => {
    if (!_dragRecipeId) return;
    const slot = e.target.closest('.meal-slot');
    if (!slot) return;
    const recipe = state.recipes.find((entry) => entry.id === _dragRecipeId);
    if (!recipe || !recipeSupportsMealType(recipe, slot.dataset.type)) return;
    e.preventDefault();
    clearRecipeDropTargets();
    slot.classList.add('meal-slot--drop-target');
  });

  grid.addEventListener('drop', async (e) => {
    if (!_dragRecipeId) return;
    const slot = e.target.closest('.meal-slot');
    const recipeId = _dragRecipeId;
    _dragRecipeId = null;
    clearRecipeDropTargets();
    if (!slot) return;
    const recipe = state.recipes.find((entry) => entry.id === recipeId);
    if (!recipe || !recipeSupportsMealType(recipe, slot.dataset.type)) return;
    e.preventDefault();
    const slotMeals = state.meals.filter((meal) => meal.date === slot.dataset.date && meal.meal_type === slot.dataset.type);
    if (slotMeals.length) {
      const confirmed = await confirmModal(t('meals.replaceExistingConfirm'), { confirmLabel: t('common.confirm') });
      if (!confirmed) return;
    }
    await addRecipeToSlot(recipe, slot.dataset.date, slot.dataset.type, { replaceMeals: slotMeals });
  });

  wireDragDrop(grid);
}

function wireRecipeSidebar() {
  const sidebar = _container.querySelector('#recipe-sidebar');
  if (!sidebar || sidebar.dataset.eventsWired) return;
  sidebar.dataset.eventsWired = 'true';

  sidebar.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.recipe-sidebar__card');
    if (!card) return;
    _dragRecipeId = Number(card.dataset.recipeId);
    card.classList.add('recipe-sidebar__card--dragging');
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', card.dataset.recipeId);
  });

  sidebar.addEventListener('dragend', (e) => {
    e.target.closest('.recipe-sidebar__card')?.classList.remove('recipe-sidebar__card--dragging');
    _dragRecipeId = null;
    clearRecipeDropTargets();
  });
}

function clearRecipeDropTargets() {
  _container.querySelectorAll('.meal-slot--drop-target').forEach((slot) => slot.classList.remove('meal-slot--drop-target'));
}

async function addRecipeToSlot(recipe, date, mealType, { replaceMeals = [] } = {}) {
  try {
    const payload = mealPayloadFromRecipe(recipe, date, mealType);
    if (replaceMeals.length) {
      const res = await api.post('/meals/apply-plan', { assignments: [payload], replace_existing: true });
      state.meals = state.meals.filter((entry) => !(entry.date === date && entry.meal_type === mealType));
      state.meals.push(...(res.data || []));
    } else {
      const res = await api.post('/meals', payload);
      state.meals.push(res.data);
    }
    renderWeekGrid();
  } catch (err) {
    window.yuvomi?.showToast(window.yuvomi?.friendlyError?.(err) ?? t('common.errorGeneric'), 'danger');
  }
}

function openRandomizeModal() {
  openSharedModal({
    title: t('meals.randomizeTitle'),
    size: 'sm',
    content: `
      <div class="meal-randomize-modal">
        <label class="toggle meal-randomize-modal__toggle">
          <input type="checkbox" id="meal-randomize-replace">
          <span class="toggle__track"></span>
          <span>${t('meals.randomizeReplaceExisting')}</span>
        </label>
        <!-- Vorschau statt Blindflug: der Lauf füllt bis zu 28 Slots und kann
             eine ganze geplante Woche überschreiben. Vorher nannte der Dialog
             weder das eine noch das andere (Critique 2026-07-29). -->
        <p class="meal-randomize-modal__preview" id="meal-randomize-preview" aria-live="polite"></p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="meal-randomize-cancel">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="meal-randomize-run">${t('meals.randomizePlan')}</button>
        </div>
      </div>`,
    onSave(panel) {
      const replaceBox = panel.querySelector('#meal-randomize-replace');
      const preview = panel.querySelector('#meal-randomize-preview');
      const runBtn = panel.querySelector('#meal-randomize-run');

      // Rein clientseitig: buildRandomMealAssignments rechnet auf dem bereits
      // geladenen Wochen- und Rezeptbestand, kostet also keinen Roundtrip.
      const updatePreview = () => {
        const plan = buildRandomMealAssignments({
          weekStart: state.currentWeek,
          visibleMealTypes: state.visibleMealTypes,
          meals: state.meals,
          recipes: state.recipes,
          replaceExisting: Boolean(replaceBox?.checked),
        });
        const fill = plan.assignments.length;
        const overwrite = plan.deleteMealIds?.length ?? 0;

        if (!fill) {
          preview.textContent = plan.reason === 'week_full'
            ? t('meals.randomizeWeekFull')
            : t('meals.randomizeNoRecipes');
          runBtn.disabled = true;
          return;
        }
        runBtn.disabled = false;
        preview.textContent = overwrite > 0
          ? `${t('meals.randomizePreview', { count: fill })} ${t('meals.randomizePreviewReplace', { count: overwrite })}`
          : t('meals.randomizePreview', { count: fill });
      };

      replaceBox?.addEventListener('change', updatePreview);
      updatePreview();

      panel.querySelector('#meal-randomize-cancel')?.addEventListener('click', closeModal);
      runBtn?.addEventListener('click', () => runRandomize(panel));
    },
  });
}

async function runRandomize(panel) {
  const replaceExisting = Boolean(panel.querySelector('#meal-randomize-replace')?.checked);
  const runBtn = panel.querySelector('#meal-randomize-run');
  const plan = buildRandomMealAssignments({
    weekStart: state.currentWeek,
    visibleMealTypes: state.visibleMealTypes,
    meals: state.meals,
    recipes: state.recipes,
    replaceExisting,
  });

  if (!plan.assignments.length) {
    window.yuvomi?.showToast(
      plan.reason === 'week_full' ? t('meals.randomizeWeekFull') : t('meals.randomizeNoRecipes'),
      'info'
    );
    return;
  }

  runBtn.disabled = true;
  try {
    await api.post('/meals/apply-plan', { assignments: plan.assignments.map((assignment) => assignment.payload), replace_existing: replaceExisting });
    await loadWeek(state.currentWeek);
    closeModal({ force: true });
    renderWeekGrid();
    window.yuvomi?.showToast(t('meals.randomizeSuccess', { count: plan.assignments.length }), 'success');
  } catch (err) {
    runBtn.disabled = false;
    window.yuvomi?.showToast(window.yuvomi?.friendlyError?.(err) ?? t('common.errorGeneric'), 'danger');
  }
}

// --------------------------------------------------------
// Drag & Drop
// --------------------------------------------------------

let _suppressNextClick = false;

function wireDragDrop(grid) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let dragging = null; // { mealId, sourceDate, sourceType, ghost, startX, startY }

  grid.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.meal-card');
    if (!card) return;
    if (e.target.closest('[data-action="delete-meal"], [data-action="transfer-meal"], [data-action="open-recipe"]')) return;

    const slot = card.closest('.meal-slot');
    if (!slot) return;

    const mealId     = parseInt(card.dataset.mealId, 10);
    const sourceDate = slot.dataset.date;
    const sourceType = slot.dataset.type;

    e.preventDefault();
    card.setPointerCapture(e.pointerId);

    let ghost = null;
    if (!reducedMotion) {
      ghost = card.cloneNode(true);
      ghost.classList.add('meal-card--ghost');
      ghost.style.width  = card.offsetWidth + 'px';
      ghost.style.height = card.offsetHeight + 'px';
      ghost.style.left   = (e.clientX - card.offsetWidth / 2) + 'px';
      ghost.style.top    = (e.clientY - card.offsetHeight / 2) + 'px';
      document.body.appendChild(ghost);
    }

    slot.classList.add('meal-slot--dragging');
    dragging = { mealId, sourceDate, sourceType, ghost, card, slot };

    let lastTarget = null;

    function onMove(ev) {
      if (!dragging) return;
      if (ghost) {
        ghost.style.left = (ev.clientX - ghost.offsetWidth / 2) + 'px';
        ghost.style.top  = (ev.clientY - ghost.offsetHeight / 2) + 'px';
      }
      if (ghost) ghost.style.display = 'none';
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (ghost) ghost.style.display = '';

      const targetSlot = el?.closest('.meal-slot');
      if (targetSlot !== lastTarget) {
        lastTarget?.classList.remove('meal-slot--drop-target');
        if (targetSlot && targetSlot !== dragging.slot) {
          targetSlot.classList.add('meal-slot--drop-target');
        }
        lastTarget = targetSlot;
      }
    }

    async function onUp(ev) {
      if (!dragging) return;
      const { mealId, sourceDate, sourceType, slot: sourceSlot } = dragging;
      cleanup(); // setzt dragging = null - Werte daher vorher destrukturieren

      if (ghost) ghost.style.display = 'none';
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (ghost) ghost.style.display = '';

      const targetSlot = el?.closest('.meal-slot');
      if (targetSlot && targetSlot !== sourceSlot) {
        const targetDate = targetSlot.dataset.date;
        const targetType = targetSlot.dataset.type;
        _suppressNextClick = true;
        setTimeout(() => { _suppressNextClick = false; }, 300);
        await moveMeal(mealId, targetDate, targetType);
      }
    }

    function onCancel() { cleanup(); }

    function cleanup() {
      ghost?.remove();
      dragging?.slot?.classList.remove('meal-slot--dragging');
      lastTarget?.classList.remove('meal-slot--drop-target');
      dragging = null;
      card.removeEventListener('pointermove',   onMove);
      card.removeEventListener('pointerup',     onUp);
      card.removeEventListener('pointercancel', onCancel);
    }

    card.addEventListener('pointermove',   onMove);
    card.addEventListener('pointerup',     onUp);
    card.addEventListener('pointercancel', onCancel);
  });

  // Suppress click after a completed drag
  grid.addEventListener('click', (e) => {
    if (_suppressNextClick) {
      e.stopImmediatePropagation();
      _suppressNextClick = false;
    }
  }, true);
}

async function moveMeal(mealId, targetDate, targetType) {
  try {
    await api.put(`/meals/${mealId}`, { date: targetDate, meal_type: targetType });
    const m = state.meals.find((m) => m.id === mealId);
    if (m) { m.date = targetDate; m.meal_type = targetType; }
    renderWeekGrid();
  } catch {
    renderWeekGrid();
  }
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

function openMealModal(opts) {
  state.modal = opts;
  const { mode, date, mealType, meal } = opts;
  const isEdit = mode === 'edit';

  const content = buildModalContent(opts);

  openSharedModal({
    title: isEdit ? t('meals.editMeal') : t('meals.addMealTitle'),
    content,
    size: 'md',
    onSave(panel) {
      // Autocomplete
      const titleInput = panel.querySelector('#modal-title');
      const acDropdown = panel.querySelector('#modal-autocomplete');
      let acIndex = -1;
      let acTimer;

      titleInput.addEventListener('input', () => {
        clearTimeout(acTimer);
        acTimer = setTimeout(async () => {
          const q = titleInput.value.trim();
          if (!q) { acDropdown.hidden = true; return; }
          try {
            const res = await api.get(`/meals/suggestions?q=${encodeURIComponent(q)}`);
            if (!res.data.length) { acDropdown.hidden = true; return; }
            acIndex = -1;
            acDropdown.replaceChildren();
            acDropdown.insertAdjacentHTML('beforeend', res.data.map((s) => `
              <div class="meal-modal__autocomplete-item" data-title="${esc(s.title)}">${esc(s.title)}</div>
            `).join(''));
            acDropdown.hidden = false;
          } catch { acDropdown.hidden = true; }
        }, 200);
      });

      titleInput.addEventListener('keydown', (e) => {
        const items = [...acDropdown.querySelectorAll('.meal-modal__autocomplete-item')];
        if (!items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = Math.min(acIndex + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle('meal-modal__autocomplete-item--active', i === acIndex)); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0);                items.forEach((el, i) => el.classList.toggle('meal-modal__autocomplete-item--active', i === acIndex)); }
        if (e.key === 'Enter' && acIndex >= 0) { e.preventDefault(); titleInput.value = items[acIndex].dataset.title; acDropdown.hidden = true; acIndex = -1; }
        if (e.key === 'Escape') acDropdown.hidden = true;
      });

      acDropdown.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.meal-modal__autocomplete-item');
        if (item) { titleInput.value = item.dataset.title; acDropdown.hidden = true; }
      });

      // Zutaten
      const ingList   = panel.querySelector('#ingredient-list');
      const addIngBtn = panel.querySelector('#add-ingredient-btn');
      const recipeSelect = panel.querySelector('#modal-recipe-id');
      const recipeScaleInput = panel.querySelector('#modal-recipe-scale');
      const saveAsRecipeBtn = panel.querySelector('#modal-save-as-recipe');
      let currentAppliedRecipe = null;

      const scaleQuantityText = (quantity, factor) => {
        if (!quantity || factor === 1) return quantity;

        const formatNumber = (num, useComma = false) => {
          const rounded = Math.round(num * 100) / 100;
          if (Number.isInteger(rounded)) return String(rounded);
          const text = String(rounded);
          return useComma ? text.replace('.', ',') : text;
        };

        const mixed = quantity.match(/^(\d+)\s+(\d+)\/(\d+)(.*)$/);
        if (mixed) {
          const whole = Number(mixed[1]);
          const num = Number(mixed[2]);
          const den = Number(mixed[3]);
          if (den > 0) {
            const value = (whole + (num / den)) * factor;
            return `${formatNumber(value)}${mixed[4]}`;
          }
        }

        const frac = quantity.match(/^(\d+)\/(\d+)(.*)$/);
        if (frac) {
          const num = Number(frac[1]);
          const den = Number(frac[2]);
          if (den > 0) {
            const value = (num / den) * factor;
            return `${formatNumber(value)}${frac[3]}`;
          }
        }

        const dec = quantity.match(/^(\d+(?:[.,]\d+)?)(.*)$/);
        if (dec) {
          const useComma = dec[1].includes(',');
          const base = Number(dec[1].replace(',', '.'));
          if (Number.isFinite(base)) {
            return `${formatNumber(base * factor, useComma)}${dec[2]}`;
          }
        }

        return quantity;
      };

      const applyRecipe = (recipeId) => {
        const id = Number(recipeId);
        const factor = Math.max(Number(recipeScaleInput?.value || 1), 0.1);
        if (!id) {
          currentAppliedRecipe = null;
          return;
        }
        const recipe = state.recipes.find((r) => r.id === id);
        if (!recipe) return;

        currentAppliedRecipe = recipe;

        panel.querySelector('#modal-title').value = recipe.title || '';
        panel.querySelector('#modal-notes').value = recipe.notes || '';
        panel.querySelector('#modal-recipe-url').value = recipe.recipe_url || '';

        ingList.replaceChildren();
        ingList.insertAdjacentHTML('beforeend', (recipe.ingredients || [])
          .map((ing) => ingredientRowHTML({
            name: ing.name,
            quantity: scaleQuantityText(ing.quantity ?? '', factor),
            category: ing.category ?? DEFAULT_CATEGORY_NAME,
            categories: mealCategories(),
          }))
          .join(''));

        if (window.lucide) lucide.createIcons({ el: ingList });
      };

      recipeSelect?.addEventListener('change', () => {
        if (recipeScaleInput) recipeScaleInput.value = '1';
        applyRecipe(recipeSelect.value);
      });

      recipeScaleInput?.addEventListener('input', () => {
        const currentRecipeId = Number(recipeSelect?.value || 0);
        if (!currentRecipeId || !currentAppliedRecipe) return;

        const factor = Number(recipeScaleInput.value || 1);
        if (!Number.isFinite(factor) || factor <= 0) return;

        ingList.replaceChildren();
        ingList.insertAdjacentHTML('beforeend', (currentAppliedRecipe.ingredients || [])
          .map((ing) => ingredientRowHTML({
            name: ing.name,
            quantity: scaleQuantityText(ing.quantity ?? '', Math.max(factor, 0.1)),
            category: ing.category ?? DEFAULT_CATEGORY_NAME,
            categories: mealCategories(),
          }))
          .join(''));

        if (window.lucide) lucide.createIcons({ el: ingList });
      });

      saveAsRecipeBtn?.addEventListener('click', async () => {
        const title = panel.querySelector('#modal-title').value.trim();
        if (!title) {
          reportFieldError(panel.querySelector('#modal-title'), t('common.nameRequired'));
          return;
        }

        const notes = panel.querySelector('#modal-notes').value.trim() || null;
        const recipe_url = panel.querySelector('#modal-recipe-url').value.trim() || null;
        const ingredients = collectModalIngredients(panel).map((ing) => ({
          name: ing.name,
          quantity: ing.quantity,
          category: ing.category,
        }));

        saveAsRecipeBtn.disabled = true;
        try {
          const created = await api.post('/recipes', { title, notes, recipe_url, ingredients });
          state.recipes.push(created.data);
          renderRecipeSidebar();

          if (recipeSelect) {
            const option = document.createElement('option');
            option.value = String(created.data.id);
            option.textContent = created.data.title;
            recipeSelect.appendChild(option);
            recipeSelect.value = String(created.data.id);
          }

          window.yuvomi?.showToast(t('recipes.created'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        } finally {
          saveAsRecipeBtn.disabled = false;
        }
      });


      addIngBtn.addEventListener('click', () => {
        const tmp  = document.createElement('div');
        tmp.insertAdjacentHTML('beforeend', ingredientRowHTML({ categories: mealCategories() }));
        const row = tmp.firstElementChild;
        ingList.appendChild(row);
        if (window.lucide) lucide.createIcons({ el: ingList });
        row.querySelector('input').focus();
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (btn) btn.closest('.ingredient-row').remove();
      });

      // Einkaufslisten-Transfer. Ohne Liste steht hier statt des toten
      // Auswahlfelds die geteilte Antwort samt Ausweg - `beforeLeave` schließt
      // das Modal, sonst bliebe es über dem Einkaufs-Tab stehen.
      mountMissingShoppingList(
        panel.querySelector('#transfer-missing'),
        { beforeLeave: () => closeModal({ force: true }) },
      );

      panel.querySelector('#transfer-btn')?.addEventListener('click', async () => {
        const selectEl = panel.querySelector('#transfer-list-select');
        const listId   = parseInt(selectEl?.value, 10);
        if (!listId || !state.modal?.meal) return;
        const btn = panel.querySelector('#transfer-btn');
        btn.disabled = true;
        try {
          const res = await api.post(`/meals/${state.modal.meal.id}/to-shopping-list`, { listId });
          if (res.data.transferred > 0) {
            await loadWeek(state.currentWeek);
            closeModal({ force: true });
            renderWeekGrid();
            // Dieselbe Meldung, Standzeit und Rücknahme wie am Slot-Knopf: es ist
            // derselbe Transfer, nur ein anderer Auslöser.
            announceTransfer({
              message: t('meals.transferSuccess', {
                count: res.data.transferred,
                list: state.lists.find((l) => l.id === listId)?.name ?? '',
              }),
              addedIds: res.data.added_ids ?? [],
              onUndone: async () => {
                await loadWeek(state.currentWeek);
                renderWeekGrid();
              },
            });
          } else {
            window.yuvomi?.showToast(t('meals.transferAlreadyDone'), 'info');
            btn.disabled = false;
          }
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
          btn.disabled = false;
        }
      });

      // Das Wiederholungs-Ende gehört zur Wiederholung, nicht zur Mahlzeit: es
      // zeigt sich nur, wenn die Serie überhaupt im Spiel ist - beim Anlegen mit
      // gesetztem Schalter, beim Bearbeiten im Serien-Umfang.
      const repeatUntilGroup = panel.querySelector('#modal-repeat-until-group');
      const repeatToggle     = panel.querySelector('#modal-repeat-weekly');
      const editScopeSelect  = panel.querySelector('#modal-edit-scope');

      repeatToggle?.addEventListener('change', () => {
        repeatUntilGroup.hidden = !repeatToggle.checked;
      });
      editScopeSelect?.addEventListener('change', () => {
        repeatUntilGroup.hidden = editScopeSelect.value !== 'series';
      });

      panel.querySelector('#modal-cancel').addEventListener('click', closeModal);
      panel.querySelector('#modal-save').addEventListener('click', () => saveModal(panel));
      // Pflichtfelder melden sich beim Verlassen inline (geteiltes Muster).
      wireBlurValidation(panel);
    },
  });
}

function buildModalContent({ mode, date, mealType, meal }) {
  const isEdit   = mode === 'edit';
  const isRecurring = isEdit && meal.recurrence_template_id;
  const typeOpts = MEAL_TYPES().map((mt) =>
    `<option value="${mt.key}" ${mt.key === mealType ? 'selected' : ''}>${mt.label}</option>`
  ).join('');

  const listOpts = state.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');

  const ingRows = isEdit && meal.ingredients?.length
    ? meal.ingredients.map((ing) => ingredientRowHTML({
        name: ing.name,
        quantity: ing.quantity ?? '',
        id: ing.id,
        category: ing.category ?? DEFAULT_CATEGORY_NAME,
        categories: mealCategories(),
      })).join('')
    : '';

  const hasIngOpen = isEdit && meal.ingredients?.some((i) => !i.on_shopping_list);

  const recipeOptionHtml = (r) => `<option value="${r.id}" ${isEdit && meal.recipe_id === r.id ? 'selected' : ''}>${esc(r.title)}</option>`;
  // Optgroups nur, sobald gespiegelte Rezepte wirklich vorkommen: ohne Mirror-
  // Account bleibt die flache Liste von vorher unverändert (kein UI-Rauschen).
  const hasMirroredRecipes = state.recipes.some((r) => r.source !== 'native');
  const mirroredSources = [...new Set(state.recipes.map((r) => r.source).filter((s) => s !== 'native'))].sort();
  const recipeOptions = hasMirroredRecipes
    ? [
      `<option value="">${t('meals.savedRecipePlaceholder')}</option>`,
      `<optgroup label="${esc(t('recipes.sourceNative'))}">${state.recipes.filter((r) => r.source === 'native').map(recipeOptionHtml).join('')}</optgroup>`,
      ...mirroredSources.map((s) => `<optgroup label="${esc(t(`recipes.source${s[0].toUpperCase()}${s.slice(1)}`))}">${state.recipes.filter((r) => r.source === s).map(recipeOptionHtml).join('')}</optgroup>`),
    ].join('')
    : [
      `<option value="">${t('meals.savedRecipePlaceholder')}</option>`,
      ...state.recipes.map(recipeOptionHtml),
    ].join('');

  const advancedOpen = isEdit && (!!meal.recipe_id || !!meal.notes || !!meal.recipe_url || isRecurring);

  const advancedFieldsHtml = `
    <div class="form-group">
      <label class="form-label" for="modal-recipe-id">${t('meals.savedRecipeLabel')}</label>
      <select class="form-input" id="modal-recipe-id">${recipeOptions}</select>
    </div>

    <div class="modal-grid modal-grid--2">
      <div class="form-group">
        <label class="form-label" for="modal-recipe-scale">${t('meals.recipeScaleLabel')}</label>
        <input type="number" class="form-input" id="modal-recipe-scale" min="0.1" step="0.1" value="1">
      </div>
      <div class="form-group" style="display:flex;align-items:flex-end;">
        <button class="btn btn--secondary" id="modal-save-as-recipe" type="button">${t('meals.saveAsRecipe')}</button>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-notes">${t('meals.notesLabel')}</label>
      <textarea class="form-input" id="modal-notes" rows="2"
                placeholder="${t('meals.notesPlaceholder')}">${esc(isEdit && meal.notes ? meal.notes : '')}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-recipe-url">${t('meals.recipeUrlLabel')}</label>
      <input type="url" class="form-input" id="modal-recipe-url"
             placeholder="${t('meals.recipeUrlPlaceholder')}"
             value="${esc(isEdit && meal.recipe_url ? meal.recipe_url : '')}">
    </div>

    ${isEdit ? (isRecurring ? `
    <div class="meal-recurrence-note">
      <i data-lucide="repeat-2" class="icon-sm" aria-hidden="true"></i>
      <span>${t('meals.recurrenceEditHint')}</span>
    </div>
    <div class="form-group">
      <label class="form-label" for="modal-edit-scope">${t('meals.editScopeLabel')}</label>
      <select class="form-input" id="modal-edit-scope">
        <option value="single">${t('meals.editScopeSingle')}</option>
        <option value="series">${t('meals.editScopeSeries')}</option>
      </select>
    </div>
    <div class="form-group" id="modal-repeat-until-group" hidden>
      <label class="form-label" for="modal-repeat-until">${t('meals.recurrenceUntilLabel')}</label>
      <yuvomi-datepicker type="date" id="modal-repeat-until"
                         value="${meal.recurrence_end_date ? formatDateInput(meal.recurrence_end_date) : ''}"></yuvomi-datepicker>
      <p class="form-hint">${t('meals.recurrenceUntilHint')}</p>
    </div>` : '') : `
    <div class="meal-recurrence-option">
      <label class="toggle">
        <input type="checkbox" id="modal-repeat-weekly">
        <span class="toggle__track"></span>
        <span>${t('meals.recurrenceLabel')}</span>
      </label>
      <p class="form-hint">${t('meals.recurrenceHint')}</p>
      <div class="form-group" id="modal-repeat-until-group" hidden>
        <label class="form-label" for="modal-repeat-until">${t('meals.recurrenceUntilLabel')}</label>
        <yuvomi-datepicker type="date" id="modal-repeat-until" value=""></yuvomi-datepicker>
        <p class="form-hint">${t('meals.recurrenceUntilHint')}</p>
      </div>
    </div>`}`;

  return `
    <div class="modal-grid modal-grid--2">
      <div class="form-group">
        <label class="form-label" for="modal-date">${t('meals.dateLabel')}</label>
        <yuvomi-datepicker type="date" id="modal-date" value="${formatDateInput(date)}"></yuvomi-datepicker>
      </div>
      <div class="form-group">
        <label class="form-label" for="modal-type">${t('meals.mealTypeLabel')}</label>
        <select class="form-input" id="modal-type">${typeOpts}</select>
      </div>
    </div>

    <div class="form-group" style="position:relative;">
      <label class="form-label" for="modal-title">${t('common.nameLabel')}</label>
      <input type="text" class="form-input" id="modal-title" required
             placeholder="${t('meals.titlePlaceholder')}"
             value="${esc(isEdit ? meal.title : '')}"
             autocomplete="off">
      <div id="modal-autocomplete" class="meal-modal__autocomplete" hidden></div>
    </div>

    <div class="form-group">
      <label class="form-label">${t('meals.ingredientsLabel')}</label>
      <div class="ingredient-list" id="ingredient-list">${ingRows}</div>
      <button class="add-ingredient-btn" id="add-ingredient-btn" type="button">
        <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>
        ${t('meals.addIngredient')}
      </button>
    </div>

    ${advancedSection(advancedFieldsHtml, { open: advancedOpen })}

    ${isEdit && hasIngOpen ? `
    <div class="shopping-transfer">
      <div class="shopping-transfer__label">
        <i data-lucide="shopping-cart" class="icon-sm" aria-hidden="true"></i>
        ${t('meals.transferLabel')}
      </div>
      ${state.lists.length ? `
      <select class="shopping-transfer__select" id="transfer-list-select">${listOpts}</select>
      <button class="btn btn--secondary shopping-transfer__btn" id="transfer-btn" type="button">
        ${t('meals.transferNow')}
      </button>`
      // Ohne Liste stand hier ein Auswahlfeld mit einem deaktivierten
      // `<option>` als Begründung und daneben ein Knopf, der nichts tat - ein
      // Bedienelement, das den Grund seiner Nutzlosigkeit in sich trägt, ist die
      // schlechteste der vier Formen dieses Zustands, weil es bedienbar aussieht
      // (Audit 2026-07-30, P1-A). Der Platzhalter wird beim Verdrahten aus dem
      // geteilten Baustein gefüllt.
      : '<div id="transfer-missing" class="shopping-transfer__missing"></div>'}
    </div>` : ''}

    <div class="modal-panel__footer modal-panel__footer--plain">
      <button class="btn btn--secondary" id="modal-cancel">${t('common.cancel')}</button>
      <button class="btn btn--primary" id="modal-save">${isEdit ? t('common.save') : t('common.add')}</button>
    </div>`;
}

function closeModal({ force = false } = {}) {
  closeSharedModal({ force });
  state.modal = null;
}

async function saveModal(overlay) {
  const saveBtn   = overlay.querySelector('#modal-save');
  const dateRaw   = overlay.querySelector('#modal-date').value;
  const date      = parseDateInput(dateRaw);
  const meal_type = overlay.querySelector('#modal-type').value;
  const title     = overlay.querySelector('#modal-title').value.trim();
  const notes     = overlay.querySelector('#modal-notes').value.trim() || null;
  const recipe_url = overlay.querySelector('#modal-recipe-url').value.trim() || null;
  const recipe_id = overlay.querySelector('#modal-recipe-id')?.value || null;
  const repeat_weekly = state.modal?.mode === 'create'
    ? Boolean(overlay.querySelector('#modal-repeat-weekly')?.checked)
    : false;
  const scope = overlay.querySelector('#modal-edit-scope')?.value || 'single';
  // Das Wiederholungs-Ende zählt nur, solange die Serie im Spiel ist: beim
  // Anlegen mit gesetztem Schalter, beim Bearbeiten im Serien-Umfang. Sonst
  // steht im Feld zwar ein Wert, er gehört aber zu keiner der beiden Absichten.
  const seriesScoped   = state.modal?.mode === 'create' ? repeat_weekly : scope === 'series';
  const repeatUntilEl  = overlay.querySelector('#modal-repeat-until');
  const repeatUntilRaw = seriesScoped ? (repeatUntilEl?.value ?? '') : '';
  // Leeres Feld heißt „ohne Ende" und geht als leerer String raus: der Server
  // unterscheidet das ausdrücklich vom fehlenden Feld (Ende bleibt unverändert).
  const repeat_until = repeatUntilRaw ? parseDateInput(repeatUntilRaw) : '';

  if (!date || !isDateInputValid(dateRaw)) {
    reportFieldError(overlay.querySelector('#modal-date'), t('calendar.invalidDate'));
    return;
  }

  if (repeatUntilRaw && (!repeat_until || !isDateInputValid(repeatUntilRaw))) {
    reportFieldError(repeatUntilEl, t('calendar.invalidDate'));
    return;
  }

  if (repeat_until && repeat_until < date) {
    reportFieldError(repeatUntilEl, t('meals.recurrenceUntilBeforeStart'));
    return;
  }

  if (!title) {
    reportFieldError(overlay.querySelector('#modal-title'), t('common.nameRequired'));
    return;
  }

  const ingredients = collectModalIngredients(overlay);

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    const { mode, meal } = state.modal;

    if (mode === 'create') {
      const res     = await api.post('/meals', { date, meal_type, title, notes, recipe_url, recipe_id, ingredients, repeat_weekly, repeat_until });
      state.meals.push(res.data);
    } else {
      if (scope === 'series') {
        // Ganze Serie: Template + alle Instanzen inkl. Zutaten serverseitig aktualisieren.
        await api.put(`/meals/${meal.id}?scope=series`, { meal_type, title, notes, recipe_url, recipe_id, ingredients, repeat_until });
      } else {
        // Nur diese Instanz
        await api.put(`/meals/${meal.id}`, { date, meal_type, title, notes, recipe_url, recipe_id });

        // Zutaten synchronisieren
        const existingIds = new Set((meal.ingredients ?? []).map((i) => i.id));
        const keptIds     = new Set(
          ingredients.filter((i) => i.id).map((i) => parseInt(i.id, 10))
        );

        for (const id of existingIds) {
          if (!keptIds.has(id)) await api.delete(`/meals/ingredients/${id}`);
        }
        for (const ing of ingredients) {
          if (!ing.id) await api.post(`/meals/${meal.id}/ingredients`, { name: ing.name, quantity: ing.quantity, category: ing.category });
        }
      }

      // Aktualisierte Woche laden
      await loadWeek(state.currentWeek);
    }

    closeModal({ force: true });
    renderWeekGrid();
    window.yuvomi?.showToast(mode === 'create' ? t('meals.addMealTitle') : t('meals.editMeal'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    saveBtn.disabled    = false;
    saveBtn.textContent = state.modal?.mode === 'edit' ? t('common.save') : t('common.add');
  }
}

function collectModalIngredients(overlay) {
  const ingredients = [];
  overlay.querySelectorAll('.ingredient-row').forEach((row) => {
    const name = row.querySelector('.ingredient-row__name').value.trim();
    const qty = row.querySelector('.ingredient-row__qty').value.trim() || null;
    const category = row.querySelector('.ingredient-row__cat')?.value || DEFAULT_CATEGORY_NAME;
    if (name) ingredients.push({ name, quantity: qty, category, id: row.dataset.ingId || null });
  });
  return ingredients;
}

// --------------------------------------------------------
// Mahlzeit löschen
// --------------------------------------------------------

async function deleteMeal(mealId) {
  const meal = state.meals.find((m) => m.id === mealId);

  // Wiederkehrende Mahlzeit: Einzeltermin, alles ab hier oder ganze Serie löschen.
  // „Ab hier" ist der Ausweg, wenn die Serie in der Vergangenheit sinnvoll war und
  // nur nach vorn enden soll - ohne ihn blieb nur, jedes künftige Vorkommen
  // einzeln zu löschen, während die nächste Woche schon wieder eines erzeugte (#619).
  if (meal?.recurrence_template_id) {
    const choice = await selectModal(t('meals.deleteRecurringTitle'), [
      { value: 'single', label: t('meals.deleteScopeSingle') },
      { value: 'future', label: t('meals.deleteScopeFuture') },
      { value: 'series', label: t('meals.deleteScopeSeries') },
    ]);
    if (choice === null) return;

    if (choice === 'series' || choice === 'future') {
      try {
        await api.delete(`/meals/${mealId}?scope=${choice}`);
        await loadWeek(state.currentWeek);
        renderWeekGrid();
        window.yuvomi?.showToast(
          choice === 'future' ? t('meals.seriesEndedToast') : t('meals.seriesDeletedToast'),
          'success',
        );
      } catch (err) {
        window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
      }
      return;
    }
    // choice === 'single' → weiter mit der Undo-Löschung unten
  }

  const itemEl = _container.querySelector(`.meal-card[data-meal-id="${mealId}"]`);
  if (itemEl) itemEl.style.display = 'none';

  scheduleUndoableDelete({
    message: t('meals.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/meals/${mealId}`, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      state.meals = state.meals.filter((m) => m.id !== mealId);
      renderWeekGrid();
    },
    restore: (err) => {
      if (itemEl) itemEl.style.display = '';
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

// --------------------------------------------------------
// Zutaten → Einkaufsliste (Quick-Transfer vom Slot aus)
// --------------------------------------------------------

async function transferMeal(mealId, btn) {
  // Vorprüfung, Listenwahl und die Antwort auf „es gibt keine Liste" liegen im
  // geteilten Baustein (utils/kitchen-transfer.js).
  const target = await resolveShoppingTarget(state.lists);
  if (!target) return;

  if (btn) btn.disabled = true;
  try {
    const res = await api.post(`/meals/${mealId}/to-shopping-list`, { listId: target.id });
    if (res.data.transferred > 0) {
      await loadWeek(state.currentWeek);
      renderWeekGrid();
      // Der Toast nennt die ZIEL-Liste. „5 Zutaten übernommen." sagte nicht, wohin -
      // und bei mehreren Listen ist genau das die Frage, die offen bleibt (Critique
      // 2026-07-30, P1). Der Kreislauf endet nicht mit „übernommen", sondern in
      // einer bestimmten Liste.
      //
      // `onUndone` zeichnet die Woche neu: die Rücknahme setzt serverseitig auch
      // `on_shopping_list` zurück, die Zutaten sind danach wieder offen - und die
      // Kachel zeigt den Übernahme-Knopf wieder an.
      announceTransfer({
        message: t('meals.transferSuccess', { count: res.data.transferred, list: target.name }),
        addedIds: res.data.added_ids ?? [],
        onUndone: async () => {
          await loadWeek(state.currentWeek);
          renderWeekGrid();
        },
      });
    } else {
      window.yuvomi?.showToast(t('meals.transferAlreadyDone'), 'info');
    }
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  } finally {
    // Die Kachel wird nach einem Erfolg neu gezeichnet; der Knopf hier ist dann
    // schon ersetzt. Das Zurücksetzen gilt dem Fehlerfall und dem Nichts-zu-tun-Fall.
    if (btn?.isConnected) btn.disabled = false;
  }
}

export const __test = { buildRandomMealAssignments, mealPayloadFromRecipe };

// --------------------------------------------------------
// Hilfsfunktion
// --------------------------------------------------------
