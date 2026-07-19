/**
 * Modul: Rezepte (Recipes)
 * Zweck: Gespeicherte Rezepte verwalten und in den Essensplan uebernehmen
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, advancedSection } from '/components/modal.js';
import { DEFAULT_CATEGORY_NAME } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { ingredientRowHTML } from '/utils/ingredient-row.js';
import { scheduleUndoableDelete } from '/utils/ux.js';
import { normalizeRecipeMealTypes, RECIPE_MEAL_TYPE_KEYS } from '/utils/recipe-meal-types.js';
import { renderSkeletonList } from '/utils/skeleton.js';

let _container = null;

const state = {
  recipes: [],
  categories: [],
};

function mealCategories() {
  return state.categories.filter((c) => c.name !== 'Haushalt' && c.name !== 'Drogerie');
}

function mealTypeOptions() {
  return [
    { key: 'breakfast', label: t('meals.typeBreakfast') },
    { key: 'lunch', label: t('meals.typeLunch') },
    { key: 'dinner', label: t('meals.typeDinner') },
    { key: 'snack', label: t('meals.typeSnack') },
  ];
}

async function loadRecipes() {
  const res = await api.get('/recipes');
  state.recipes = res.data;
}

async function loadCategories() {
  try {
    const res = await api.get('/shopping/categories');
    state.categories = res.data;
  } catch {
    state.categories = [];
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
  title.textContent = t('recipes.title');

  const list = document.createElement('div');
  list.className = 'recipes-list';
  list.id = 'recipes-list';
  // Lade-Skeleton bis loadRecipes() aufgelöst ist (Router blendet den Wrapper
  // bereits vor dem Daten-await ein).
  list.setAttribute('aria-busy', 'true');
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 5, lines: 2 }));

  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.id = 'fab-new-recipe';
  fab.setAttribute('aria-label', t('recipes.addRecipe'));
  const fabIcon = document.createElement('i');
  fabIcon.dataset.lucide = 'plus';
  fabIcon.setAttribute('aria-hidden', 'true');
  fab.appendChild(fabIcon);

  page.append(title, list, fab);
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/recipes');

  if (window.lucide) window.lucide.createIcons({ el: container });

  await Promise.all([loadRecipes(), loadCategories()]);
  renderRecipeList();

  fab.addEventListener('click', () => openRecipeModal('create'));

  list.addEventListener('click', async (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;

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

    if (actionBtn.dataset.action === 'add-to-meals') {
      window.yuvomi?.navigate(`/meals?recipe=${recipe.id}`);
    }
  });
}

function renderRecipeList() {
  const list = _container.querySelector('#recipes-list');
  if (!list) return;
  list.removeAttribute('aria-busy');

  list.replaceChildren();

  if (!state.recipes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';

    const emptyTitle = document.createElement('div');
    emptyTitle.className = 'empty-state__title';
    emptyTitle.textContent = t('recipes.emptyTitle');

    const emptyDesc = document.createElement('div');
    emptyDesc.className = 'empty-state__description';
    emptyDesc.textContent = t('recipes.emptyDescription');

    const emptyHint = document.createElement('p');
    emptyHint.className = 'empty-state__hint';
    emptyHint.textContent = t('emptyHint.recipes');
    const emptyCta = document.createElement('button');
    emptyCta.className = 'btn btn--primary empty-state__cta';
    emptyCta.insertAdjacentHTML('afterbegin', '<i data-lucide="plus" aria-hidden="true" class="icon-md"></i>');
    emptyCta.append(document.createTextNode(t('recipes.emptyAction')));
    emptyCta.addEventListener('click', () => {
      document.querySelector('.page-fab')?.click();
    });
    empty.append(emptyTitle, emptyDesc, emptyHint, emptyCta);
    list.appendChild(empty);
    if (window.lucide) window.lucide.createIcons({ el: empty });
    return;
  }

  for (const recipe of state.recipes) {
    const card = document.createElement('article');
    card.className = 'recipe-card';
    card.dataset.id = String(recipe.id);

    const h = document.createElement('h2');
    h.className = 'recipe-card__title';
    h.textContent = recipe.title;

    card.appendChild(h);

    if (recipe.notes) {
      const notes = document.createElement('p');
      notes.className = 'recipe-card__notes';
      notes.textContent = recipe.notes;
      card.appendChild(notes);
    }

    const mealTypes = normalizeRecipeMealTypes(recipe.meal_types);
    const badges = document.createElement('div');
    badges.className = 'recipe-card__meal-types';
    badges.replaceChildren(...mealTypeOptions()
      .filter((option) => mealTypes.includes(option.key))
      .map((option) => {
        const badge = document.createElement('span');
        badge.className = `meal-type-badge meal-type-badge--${option.key}`;
        badge.textContent = option.label;
        return badge;
      }));
    card.appendChild(badges);

    if (recipe.recipe_url) {
      const link = document.createElement('a');
      link.className = 'btn btn--ghost recipe-card__link';
      link.href = recipe.recipe_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      // Explizites Icon macht die Zeile als externen Link erkennbar, statt wie
      // Fließtext zu wirken (Audit F10).
      link.insertAdjacentHTML('beforeend', '<i data-lucide="external-link" class="icon-sm" aria-hidden="true"></i>');
      const linkLabel = document.createElement('span');
      linkLabel.textContent = t('recipes.openLink');
      link.appendChild(linkLabel);
      card.appendChild(link);
    }

    const ingredients = recipe.ingredients ?? [];
    if (ingredients.length) {
      const ul = document.createElement('ul');
      ul.className = 'recipe-card__ingredients';
      // Auf die ersten 4 kürzen: begrenzt die Kartenhöhe → ruhigeres Raster.
      // Vollständige Liste bleibt über „Bearbeiten" erreichbar.
      const MAX_INGREDIENTS = 4;
      for (const ing of ingredients.slice(0, MAX_INGREDIENTS)) {
        const li = document.createElement('li');
        li.className = 'recipe-card__ingredient';
        const qty = ing.quantity ? `${ing.quantity} · ` : '';
        li.textContent = `${qty}${ing.name}`;
        ul.appendChild(li);
      }
      if (ingredients.length > MAX_INGREDIENTS) {
        const more = document.createElement('li');
        more.className = 'recipe-card__ingredient recipe-card__ingredient--more';
        // Sprachneutraler Rest-Indikator (kein neuer Locale-Key nötig).
        more.textContent = `+${ingredients.length - MAX_INGREDIENTS}`;
        ul.appendChild(more);
      }
      card.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'recipe-card__actions';

    // Primäraktion sichtbar; die selteneren/gefährlicheren Aktionen als
    // de-emphasierte Icon-Buttons — konsistent mit dem Icon-Action-Muster
    // des Einkaufs (statt vier gleichrangiger Buttons inkl. lautem roten Delete).
    const addToMeals = document.createElement('button');
    addToMeals.className = 'btn recipe-card__primary';
    addToMeals.type = 'button';
    addToMeals.dataset.action = 'add-to-meals';
    addToMeals.dataset.id = String(recipe.id);
    addToMeals.textContent = t('recipes.addToMeals');

    const iconActions = document.createElement('div');
    iconActions.className = 'row-actions recipe-card__icon-actions';
    const secondaryActions = [
      { action: 'edit',      icon: 'pencil',  label: t('common.edit') },
      { action: 'duplicate', icon: 'copy',    label: t('recipes.duplicate') },
      { action: 'delete',    icon: 'trash-2', label: t('common.delete'), danger: true },
    ];
    for (const a of secondaryActions) {
      const btn = document.createElement('button');
      btn.className = `row-action${a.danger ? ' row-action--danger' : ''}`;
      btn.type = 'button';
      btn.dataset.action = a.action;
      btn.dataset.id = String(recipe.id);
      btn.setAttribute('aria-label', a.label);
      btn.title = a.label;
      const ic = document.createElement('i');
      ic.dataset.lucide = a.icon;
      ic.className = 'icon-md';
      ic.setAttribute('aria-hidden', 'true');
      btn.appendChild(ic);
      iconActions.appendChild(btn);
    }

    actions.append(addToMeals, iconActions);
    card.appendChild(actions);

    list.appendChild(card);
  }

  if (window.lucide) window.lucide.createIcons({ el: list });
}

function openRecipeModal(mode, recipe = null) {
  const isEdit = mode === 'edit';

  openSharedModal({
    title: isEdit ? t('recipes.editRecipe') : t('recipes.addRecipe'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="recipe-title">${t('recipes.titleLabel')}</label>
        <input id="recipe-title" class="form-input" type="text" placeholder="${t('recipes.titlePlaceholder')}">
      </div>
      <div class="form-group">
        <label class="form-label">${t('meals.mealTypeLabel')}</label>
        <div class="recipe-meal-types" id="recipe-meal-types">
          ${mealTypeOptions().map((option) => `
            <label class="recipe-meal-types__option">
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
      <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
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
    window.yuvomi?.showToast(t('recipes.titleRequired'), 'danger');
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

async function removeRecipe(recipe) {
  const itemEl = _container.querySelector(`.recipe-card[data-id="${recipe.id}"]`);
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
