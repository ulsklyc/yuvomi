/**
 * Modul: Essensplan (Meals)
 * Zweck: Wochenansicht mit Mahlzeit-CRUD, Zutaten-Verwaltung und Einkaufslisten-Integration
 * Abhängigkeiten: /api.js, /router.js (window.oikos)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, selectModal, confirmModal } from '/components/modal.js';
import { stagger } from '/utils/ux.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';

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
};

// Container-Referenz für Hilfsfunktionen (wird in render() gesetzt)
let _container = null;

// --------------------------------------------------------
// Datumshelfer
// --------------------------------------------------------

function getMondayOf(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatWeekLabel(monday) {
  const sunday = addDays(monday, 6);
  return `${formatDate(monday)} – ${formatDate(sunday)}`;
}

function isToday(dateStr) {
  return dateStr === new Date().toISOString().slice(0, 10);
}

function formatDayDate(dateStr) {
  return formatDate(dateStr);
}

function mealCategories() {
  return state.categories.filter((c) => !EXCLUDED_MEAL_CATEGORY_NAMES.has(c.name));
}

// --------------------------------------------------------
// API-Wrapper
// --------------------------------------------------------

async function loadWeek(week) {
  try {
    const res = await api.get(`/meals?week=${week}`);
    state.meals       = res.data;
    state.currentWeek = getMondayOf(week);
  } catch (err) {
    console.error('[Meals] loadWeek Fehler:', err);
    state.meals       = [];
    state.currentWeek = getMondayOf(week);
    window.oikos?.showToast(t('meals.loadError'), 'danger');
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
  container.innerHTML = `
    <div class="meals-page">
      <h1 class="sr-only">${t('meals.title')}</h1>
      <div class="week-nav">
        <button class="btn btn--icon" id="week-prev" aria-label="${t('meals.prevWeek')}">
          <i data-lucide="chevron-left" aria-hidden="true"></i>
        </button>
        <span class="week-nav__label" id="week-label"></span>
        <button class="week-nav__today" id="week-today">${t('meals.today')}</button>
        <button class="btn btn--icon" id="week-next" aria-label="${t('meals.nextWeek')}">
          <i data-lucide="chevron-right" aria-hidden="true"></i>
        </button>
      </div>
      <div class="week-grid" id="week-grid">
        <div style="margin:auto;padding:2rem;text-align:center;color:var(--color-text-disabled)">${t('meals.loadingIndicator')}</div>
      </div>
      <button class="page-fab" id="fab-new-meal" aria-label="${t('meals.addMealTitle')}">
        <i data-lucide="plus" style="width:24px;height:24px" aria-hidden="true"></i>
      </button>
    </div>
  `;

  if (window.lucide) lucide.createIcons();

  const today  = new Date().toISOString().slice(0, 10);
  const monday = getMondayOf(today);

  await Promise.all([loadWeek(monday), loadLists(), loadPreferences(), loadCategories(), loadRecipes()]);
  renderWeekGrid();
  wireNav();

  const selectedRecipeId = Number(new URLSearchParams(window.location.search).get('recipe'));
  if (selectedRecipeId) {
    const selectedRecipe = state.recipes.find((r) => r.id === selectedRecipeId);
    if (selectedRecipe) {
      const firstType = state.visibleMealTypes[0] ?? 'lunch';
      openMealModal({ mode: 'create', date: today, mealType: firstType, presetRecipeId: selectedRecipe.id });
    }
  }

  container.querySelector('#fab-new-meal').addEventListener('click', () => {
    const firstType = state.visibleMealTypes[0] ?? 'lunch';
    openMealModal({ mode: 'create', date: today, mealType: firstType });
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

  const days = Array.from({ length: 7 }, (_, i) => addDays(state.currentWeek, i));
  const dayNames = DAY_NAMES();

  grid.innerHTML = days.map((date, idx) => {
    const mealsForDay = state.meals.filter((m) => m.date === date);
    const todayClass  = isToday(date) ? 'day-header--today' : '';

    return `
      <div class="day-column">
        <div class="day-header ${todayClass}">
          <span class="day-header__name">${dayNames[idx]}</span>
          <span class="day-header__date">${formatDayDate(date)}</span>
        </div>
        <div class="day-slots">
          ${MEAL_TYPES().filter((type) => state.visibleMealTypes.includes(type.key)).map((type) => renderSlot(date, type, mealsForDay)).join('')}
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
  stagger(grid.querySelectorAll('.meal-card'));
  wireGrid(grid);
}

function renderSlot(date, type, mealsForDay) {
  const meal = mealsForDay.find((m) => m.meal_type === type.key);

  if (!meal) {
    return `
      <div class="meal-slot meal-slot--empty" data-date="${date}" data-type="${type.key}">
        <div class="meal-slot__type-label">${type.label}</div>
        <div class="empty-state empty-state--compact">
          <div class="empty-state__description">${t('meals.noMealPlanned')}</div>
        </div>
        <button
          class="meal-slot__add-btn"
          data-action="add-meal"
          data-date="${date}"
          data-type="${type.key}"
          aria-label="${t('meals.addMeal', { type: type.label })}"
        >
          <i data-lucide="plus" style="width:16px;height:16px;" aria-hidden="true"></i>
        </button>
      </div>
    `;
  }

  const ingCount = meal.ingredients?.length ?? 0;
  const ingDone  = meal.ingredients?.filter((i) => i.on_shopping_list).length ?? 0;
  const ingLabel = ingCount > 0 ? (ingCount !== 1 ? t('meals.ingredientCountPlural', { count: ingCount }) : t('meals.ingredientCount', { count: ingCount })) : '';
  const ingDoneLabel = ingCount > 0 && ingDone === ingCount ? ' ✓' : '';
  const canTransfer  = ingCount > 0 && ingDone < ingCount;

  return `
    <div class="meal-slot meal-slot--has-meal" data-meal-id="${meal.id}" data-date="${meal.date}" data-type="${type.key}">
      <div class="meal-slot__type-label">${type.label}</div>
      <div class="meal-card"
           data-action="edit-meal"
           data-meal-id="${meal.id}"
           role="button" tabindex="0">
        <div class="meal-card__title">${esc(meal.title)}</div>
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
          ><i data-lucide="link" style="width:14px;height:14px;" aria-hidden="true"></i></a>` : ''}
          ${canTransfer ? `<button class="meal-card__action-btn meal-card__action-btn--shopping"
            data-action="transfer-meal"
            data-meal-id="${meal.id}"
            aria-label="${t('meals.transferToShoppingList')}"
          ><i data-lucide="shopping-cart" style="width:14px;height:14px;" aria-hidden="true"></i></button>` : ''}
          <button class="meal-card__action-btn"
            data-action="delete-meal"
            data-meal-id="${meal.id}"
            aria-label="${t('meals.deleteMeal')}"
          ><i data-lucide="trash-2" style="width:14px;height:14px;" aria-hidden="true"></i></button>
        </div>
      </div>
    </div>
  `;
}

// --------------------------------------------------------
// Event-Delegation
// --------------------------------------------------------

function wireNav() {
  _container.querySelector('#week-prev')?.addEventListener('click', async () => {
    await loadWeek(addDays(state.currentWeek, -7));
    renderWeekGrid();
  });

  _container.querySelector('#week-next')?.addEventListener('click', async () => {
    await loadWeek(addDays(state.currentWeek, 7));
    renderWeekGrid();
  });

  _container.querySelector('#week-today')?.addEventListener('click', async () => {
    const monday = getMondayOf(new Date().toISOString().slice(0, 10));
    if (monday === state.currentWeek) return;
    await loadWeek(monday);
    renderWeekGrid();
  });
}

function wireGrid(grid) {
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
      await transferMeal(parseInt(btn.dataset.mealId, 10));
    }
  });

  grid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('[data-action="edit-meal"]');
      if (card) { e.preventDefault(); card.click(); }
    }
  });

  wireDragDrop(grid);
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

    const mealId     = parseInt(slot.dataset.mealId, 10);
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
        const targetDate    = targetSlot.dataset.date;
        const targetType    = targetSlot.dataset.type;
        const targetMealId  = targetSlot.dataset.mealId ? parseInt(targetSlot.dataset.mealId, 10) : null;
        _suppressNextClick = true;
        setTimeout(() => { _suppressNextClick = false; }, 300);
        await moveMeal(mealId, sourceDate, sourceType, targetDate, targetType, targetMealId);
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

async function moveMeal(mealId, sourceDate, sourceType, targetDate, targetType, targetMealId) {
  try {
    if (targetMealId) {
      // Swap: move both meals to each other's slots
      await Promise.all([
        api.put(`/meals/${mealId}`,       { date: targetDate, meal_type: targetType }),
        api.put(`/meals/${targetMealId}`, { date: sourceDate, meal_type: sourceType }),
      ]);
      const m1 = state.meals.find((m) => m.id === mealId);
      const m2 = state.meals.find((m) => m.id === targetMealId);
      if (m1) { m1.date = targetDate; m1.meal_type = targetType; }
      if (m2) { m2.date = sourceDate; m2.meal_type = sourceType; }
    } else {
      // Move to empty slot
      await api.put(`/meals/${mealId}`, { date: targetDate, meal_type: targetType });
      const m = state.meals.find((m) => m.id === mealId);
      if (m) { m.date = targetDate; m.meal_type = targetType; }
    }
    renderWeekGrid();
  } catch {
    // Re-render to restore visual state
    renderWeekGrid();
  }
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

function openMealModal(opts) {
  state.modal = opts;
  const { mode, date, mealType, meal, presetRecipeId = null } = opts;
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
            acDropdown.innerHTML = res.data.map((s) => `
              <div class="meal-modal__autocomplete-item" data-title="${esc(s.title)}">${esc(s.title)}</div>
            `).join('');
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

        ingList.innerHTML = (recipe.ingredients || [])
          .map((ing) => {
            const scaledQty = scaleQuantityText(ing.quantity ?? '', factor);
            return ingredientRowHTML(ing.name, scaledQty, null, ing.category ?? DEFAULT_CATEGORY_NAME);
          })
          .join('');

        if (window.lucide) lucide.createIcons();
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

        ingList.innerHTML = (currentAppliedRecipe.ingredients || [])
          .map((ing) => ingredientRowHTML(
            ing.name,
            scaleQuantityText(ing.quantity ?? '', Math.max(factor, 0.1)),
            null,
            ing.category ?? DEFAULT_CATEGORY_NAME
          ))
          .join('');

        if (window.lucide) lucide.createIcons();
      });

      saveAsRecipeBtn?.addEventListener('click', async () => {
        const title = panel.querySelector('#modal-title').value.trim();
        if (!title) {
          window.oikos?.showToast(t('meals.titleRequired'), 'error');
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

          if (recipeSelect) {
            const option = document.createElement('option');
            option.value = String(created.data.id);
            option.textContent = created.data.title;
            recipeSelect.appendChild(option);
            recipeSelect.value = String(created.data.id);
          }

          window.oikos?.showToast(t('recipes.created'), 'success');
        } catch (err) {
          window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
        } finally {
          saveAsRecipeBtn.disabled = false;
        }
      });

      if (presetRecipeId && recipeSelect) {
        recipeSelect.value = String(presetRecipeId);
        applyRecipe(presetRecipeId);
      }

      addIngBtn.addEventListener('click', () => {
        const tmp  = document.createElement('div');
        tmp.innerHTML = ingredientRowHTML('', '', null);
        const row = tmp.firstElementChild;
        ingList.appendChild(row);
        if (window.lucide) lucide.createIcons();
        row.querySelector('input').focus();
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (btn) btn.closest('.ingredient-row').remove();
      });

      // Einkaufslisten-Transfer
      panel.querySelector('#transfer-btn')?.addEventListener('click', async () => {
        const selectEl = panel.querySelector('#transfer-list-select');
        const listId   = parseInt(selectEl?.value, 10);
        if (!listId || !state.modal?.meal) return;
        const btn = panel.querySelector('#transfer-btn');
        btn.disabled = true;
        try {
          const res = await api.post(`/meals/${state.modal.meal.id}/to-shopping-list`, { listId });
          if (res.data.transferred > 0) {
            window.oikos?.showToast(res.data.transferred !== 1 ? t('meals.transferSuccessPlural', { count: res.data.transferred }) : t('meals.transferSuccess', { count: res.data.transferred }), 'success');
            await loadWeek(state.currentWeek);
            closeModal();
            renderWeekGrid();
          } else {
            window.oikos?.showToast(t('meals.transferAlreadyDone'), 'info');
            btn.disabled = false;
          }
        } catch (err) {
          window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'error');
          btn.disabled = false;
        }
      });

      panel.querySelector('#modal-cancel').addEventListener('click', closeModal);
      panel.querySelector('#modal-save').addEventListener('click', () => saveModal(panel));
    },
  });
}

function buildModalContent({ mode, date, mealType, meal }) {
  const isEdit   = mode === 'edit';
  const typeOpts = MEAL_TYPES().map((mt) =>
    `<option value="${mt.key}" ${mt.key === mealType ? 'selected' : ''}>${mt.label}</option>`
  ).join('');

  const listOpts = state.lists.length
    ? state.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')
    : `<option value="" disabled>${t('meals.noShoppingLists')}</option>`;

  const ingRows = isEdit && meal.ingredients?.length
    ? meal.ingredients.map((ing) => ingredientRowHTML(ing.name, ing.quantity ?? '', ing.id, ing.category ?? DEFAULT_CATEGORY_NAME)).join('')
    : '';

  const hasIngOpen = isEdit && meal.ingredients?.some((i) => !i.on_shopping_list);

  const recipeOptions = [
    `<option value="">${t('meals.savedRecipePlaceholder')}</option>`,
    ...state.recipes.map((r) => `<option value="${r.id}" ${isEdit && meal.recipe_id === r.id ? 'selected' : ''}>${esc(r.title)}</option>`),
  ].join('');

  return `
    <div class="modal-grid modal-grid--2">
      <div class="form-group">
        <label class="form-label" for="modal-date">${t('meals.dateLabel')}</label>
        <input type="date" class="form-input" id="modal-date" value="${date}">
      </div>
      <div class="form-group">
        <label class="form-label" for="modal-type">${t('meals.mealTypeLabel')}</label>
        <select class="form-input" id="modal-type">${typeOpts}</select>
      </div>
    </div>

    <div class="form-group" style="position:relative;">
      <label class="form-label" for="modal-title">${t('meals.titleLabel')}</label>
      <input type="text" class="form-input" id="modal-title"
             placeholder="${t('meals.titlePlaceholder')}"
             value="${esc(isEdit ? meal.title : '')}"
             autocomplete="off">
      <div id="modal-autocomplete" class="meal-modal__autocomplete" hidden></div>
    </div>

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

    <div class="form-group">
      <label class="form-label">${t('meals.ingredientsLabel')}</label>
      <div class="ingredient-list" id="ingredient-list">${ingRows}</div>
      <button class="add-ingredient-btn" id="add-ingredient-btn" type="button">
        <i data-lucide="plus" style="width:14px;height:14px;" aria-hidden="true"></i>
        ${t('meals.addIngredient')}
      </button>
    </div>

    ${isEdit && hasIngOpen ? `
    <div class="shopping-transfer">
      <div class="shopping-transfer__label">
        <i data-lucide="shopping-cart" style="width:14px;height:14px;" aria-hidden="true"></i>
        ${t('meals.transferLabel')}
      </div>
      <select class="shopping-transfer__select" id="transfer-list-select">${listOpts}</select>
      <button class="btn btn--secondary shopping-transfer__btn" id="transfer-btn" type="button">
        ${t('meals.transferNow')}
      </button>
    </div>` : ''}

    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      <button class="btn btn--secondary" id="modal-cancel">${t('common.cancel')}</button>
      <button class="btn btn--primary" id="modal-save">${isEdit ? t('common.save') : t('common.add')}</button>
    </div>`;
}

function ingredientRowHTML(name, qty, id, category = DEFAULT_CATEGORY_NAME) {
  const availableCategories = mealCategories();
  const resolvedCategory = availableCategories.some((c) => c.name === category)
    ? category
    : (availableCategories[0]?.name ?? DEFAULT_CATEGORY_NAME);
  const catOptions = availableCategories.length
    ? availableCategories.map((c) => `<option value="${esc(c.name)}" ${c.name === resolvedCategory ? 'selected' : ''}>${esc(categoryLabel(c.name))}</option>`).join('')
    : `<option value="${DEFAULT_CATEGORY_NAME}" selected>${t('meals.ingredientCategoryDefault')}</option>`;

  return `
    <div class="ingredient-row" data-ing-id="${id ?? ''}">
      <input type="text" class="form-input ingredient-row__name" placeholder="${t('meals.ingredientNamePlaceholder')}" value="${esc(name)}">
      <input type="text" class="form-input ingredient-row__qty" placeholder="${t('meals.ingredientQtyPlaceholder')}" value="${esc(qty)}">
      <select class="form-input ingredient-row__cat" aria-label="${t('meals.ingredientCategoryLabel')}">${catOptions}</select>
      <button class="ingredient-row__remove" data-action="remove-ingredient" type="button" aria-label="${t('meals.removeIngredient')}">
        <i data-lucide="x" style="width:14px;height:14px;" aria-hidden="true"></i>
      </button>
    </div>
  `;
}

function closeModal() {
  closeSharedModal();
  state.modal = null;
}

async function saveModal(overlay) {
  const saveBtn   = overlay.querySelector('#modal-save');
  const date      = overlay.querySelector('#modal-date').value;
  const meal_type = overlay.querySelector('#modal-type').value;
  const title     = overlay.querySelector('#modal-title').value.trim();
  const notes     = overlay.querySelector('#modal-notes').value.trim() || null;
  const recipe_url = overlay.querySelector('#modal-recipe-url').value.trim() || null;
  const recipe_id = overlay.querySelector('#modal-recipe-id')?.value || null;

  if (!title) {
    window.oikos?.showToast(t('meals.titleRequired'), 'error');
    return;
  }

  const ingredients = collectModalIngredients(overlay);

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    const { mode, meal } = state.modal;

    if (mode === 'create') {
      const res     = await api.post('/meals', { date, meal_type, title, notes, recipe_url, recipe_id, ingredients });
      state.meals.push(res.data);
    } else {
      // Update meal meta
      await api.put(`/meals/${meal.id}`, { date, meal_type, title, notes, recipe_url, recipe_id });

      // Sync ingredients
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

      // Reload updated meal
      await loadWeek(state.currentWeek);
    }

    closeModal();
    renderWeekGrid();
    window.oikos?.showToast(mode === 'create' ? t('meals.addMealTitle') : t('meals.editMeal'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
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
  if (!await confirmModal(t('meals.deleteMeal') + '?', { danger: true, confirmLabel: t('common.delete') })) return;
  try {
    await api.delete(`/meals/${mealId}`);
    state.meals = state.meals.filter((m) => m.id !== mealId);
    renderWeekGrid();
    window.oikos?.showToast(t('meals.deleteMeal'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
  }
}

// --------------------------------------------------------
// Zutaten → Einkaufsliste (Quick-Transfer vom Slot aus)
// --------------------------------------------------------

async function transferMeal(mealId) {
  if (!state.lists.length) {
    window.oikos?.showToast(t('meals.noShoppingLists'), 'error');
    return;
  }

  let listId = state.lists[0].id;

  if (state.lists.length > 1) {
    const options = state.lists.map((l) => ({ value: l.id, label: l.name }));
    const choice = await selectModal(t('meals.transferToShoppingList'), options);
    if (choice === null) return;
    listId = Number(choice);
  }

  try {
    const res = await api.post(`/meals/${mealId}/to-shopping-list`, { listId });
    if (res.data.transferred > 0) {
      window.oikos?.showToast(res.data.transferred !== 1 ? t('meals.transferSuccessPlural', { count: res.data.transferred }) : t('meals.transferSuccess', { count: res.data.transferred }), 'success');
      await loadWeek(state.currentWeek);
      renderWeekGrid();
    } else {
      window.oikos?.showToast(t('meals.transferAlreadyDone'), 'info');
    }
  } catch (err) {
    window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
  }
}

// --------------------------------------------------------
// Hilfsfunktion
// --------------------------------------------------------

