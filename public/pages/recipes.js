/**
 * Modul: Rezepte (Recipes)
 * Zweck: Gespeicherte Rezepte verwalten und in den Essensplan uebernehmen
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { openModal as openSharedModal, closeModal as closeSharedModal } from '/components/modal.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { renderSkeletonList } from '/utils/skeleton.js';

let _container = null;

const state = {
  recipes: [],
  categories: [],
};

function mealCategories() {
  return state.categories.filter((c) => c.name !== 'Haushalt' && c.name !== 'Drogerie');
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

  const header = document.createElement('div');
  header.className = 'recipes-header';

  const title = document.createElement('h1');
  title.className = 'recipes-header__title';
  title.textContent = t('recipes.title');

  // toolbar-new-btn: global per CSS ausgeblendet (Audit 1.9) — der FAB ist die
  // einzige Create-Affordanz, konsistent mit allen anderen Modulen.
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn--primary toolbar-new-btn';
  addBtn.type = 'button';
  addBtn.id = 'recipes-add';
  addBtn.textContent = t('recipes.addRecipe');

  header.append(title, addBtn);

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
  fab.id = 'recipes-fab';
  fab.setAttribute('aria-label', t('recipes.addRecipe'));
  const fabIcon = document.createElement('i');
  fabIcon.dataset.lucide = 'plus';
  fabIcon.setAttribute('aria-hidden', 'true');
  fab.appendChild(fabIcon);

  page.append(header, list, fab);
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/recipes');

  if (window.lucide) window.lucide.createIcons({ el: container });

  await Promise.all([loadRecipes(), loadCategories()]);
  renderRecipeList();

  addBtn.addEventListener('click', () => openRecipeModal('create'));
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
      window.oikos?.navigate(`/meals?recipe=${recipe.id}`);
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

    if (recipe.recipe_url) {
      const link = document.createElement('a');
      link.className = 'btn btn--ghost';
      link.href = recipe.recipe_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = t('recipes.openLink');
      card.appendChild(link);
    }

    const ingredients = recipe.ingredients ?? [];
    if (ingredients.length) {
      const ul = document.createElement('ul');
      ul.className = 'recipe-card__ingredients';
      for (const ing of ingredients) {
        const li = document.createElement('li');
        li.className = 'recipe-card__ingredient';
        const qty = ing.quantity ? `${ing.quantity} · ` : '';
        li.textContent = `${qty}${ing.name}`;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'recipe-card__actions';

    const addToMeals = document.createElement('button');
    addToMeals.className = 'btn btn--secondary';
    addToMeals.type = 'button';
    addToMeals.dataset.action = 'add-to-meals';
    addToMeals.dataset.id = String(recipe.id);
    addToMeals.textContent = t('recipes.addToMeals');

    const edit = document.createElement('button');
    edit.className = 'btn btn--secondary';
    edit.type = 'button';
    edit.dataset.action = 'edit';
    edit.dataset.id = String(recipe.id);
    edit.textContent = t('common.edit');

    const del = document.createElement('button');
    del.className = 'btn btn--danger';
    del.type = 'button';
    del.dataset.action = 'delete';
    del.dataset.id = String(recipe.id);
    del.textContent = t('common.delete');

    const duplicate = document.createElement('button');
    duplicate.className = 'btn btn--secondary';
    duplicate.type = 'button';
    duplicate.dataset.action = 'duplicate';
    duplicate.dataset.id = String(recipe.id);
    duplicate.textContent = t('recipes.duplicate');

    actions.append(addToMeals, edit, duplicate, del);
    card.appendChild(actions);

    list.appendChild(card);
  }
}

function buildIngredientRow(name, qty, category = DEFAULT_CATEGORY_NAME) {
  const categories = mealCategories();
  const resolvedCategory = categories.some((c) => c.name === category)
    ? category
    : (categories[0]?.name ?? DEFAULT_CATEGORY_NAME);

  const row = document.createElement('div');
  row.className = 'recipe-ingredient-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'form-input recipe-ingredient-row__name';
  nameInput.placeholder = t('meals.ingredientNamePlaceholder');
  nameInput.value = name;

  const qtyInput = document.createElement('input');
  qtyInput.type = 'text';
  qtyInput.className = 'form-input recipe-ingredient-row__qty';
  qtyInput.placeholder = t('meals.ingredientQtyPlaceholder');
  qtyInput.value = qty;

  const catSelect = document.createElement('select');
  catSelect.className = 'form-input recipe-ingredient-row__cat';
  catSelect.setAttribute('aria-label', t('meals.ingredientCategoryLabel'));
  if (categories.length) {
    for (const c of categories) {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = categoryLabel(c.name);
      if (c.name === resolvedCategory) opt.selected = true;
      catSelect.appendChild(opt);
    }
  } else {
    const opt = document.createElement('option');
    opt.value = DEFAULT_CATEGORY_NAME;
    opt.textContent = t('meals.ingredientCategoryDefault');
    opt.selected = true;
    catSelect.appendChild(opt);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'recipe-ingredient-row__remove';
  removeBtn.dataset.action = 'remove-ingredient';
  removeBtn.type = 'button';
  removeBtn.setAttribute('aria-label', t('meals.removeIngredient'));
  const icon = document.createElement('i');
  icon.dataset.lucide = 'x';
  icon.className = 'icon-sm';
  icon.setAttribute('aria-hidden', 'true');
  removeBtn.appendChild(icon);

  row.append(nameInput, qtyInput, catSelect, removeBtn);
  return row;
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
        <label class="form-label" for="recipe-notes">${t('recipes.notesLabel')}</label>
        <textarea id="recipe-notes" class="form-input" rows="3" placeholder="${t('recipes.notesPlaceholder')}"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label" for="recipe-url">${t('recipes.urlLabel')}</label>
        <input id="recipe-url" class="form-input" type="url" placeholder="${t('recipes.urlPlaceholder')}">
      </div>
      <div class="form-group">
        <label class="form-label">${t('recipes.ingredientsLabel')}</label>
        <div class="recipe-ingredient-list" id="recipe-ingredient-list"></div>
        <button class="btn btn--secondary recipe-add-ingredient" type="button" id="recipe-add-ingredient">${t('meals.addIngredient')}</button>
      </div>
      <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
        <button class="btn btn--secondary" id="recipe-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="recipe-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    `,
    onSave(panel) {
      panel.querySelector('#recipe-title').value = isEdit ? recipe.title : '';
      panel.querySelector('#recipe-notes').value = isEdit && recipe.notes ? recipe.notes : '';
      panel.querySelector('#recipe-url').value = isEdit && recipe.recipe_url ? recipe.recipe_url : '';

      const ingList = panel.querySelector('#recipe-ingredient-list');
      if (isEdit && recipe.ingredients?.length) {
        for (const i of recipe.ingredients) {
          ingList.appendChild(buildIngredientRow(i.name, i.quantity ?? '', i.category ?? DEFAULT_CATEGORY_NAME));
        }
      }

      panel.querySelector('#recipe-add-ingredient')?.addEventListener('click', () => {
        ingList.appendChild(buildIngredientRow('', '', null));
        if (window.lucide) window.lucide.createIcons({ el: ingList });
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (!btn) return;
        btn.closest('.recipe-ingredient-row')?.remove();
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

  if (!title) {
    window.oikos?.showToast(t('recipes.titleRequired'), 'error');
    return;
  }

  const ingredients = [];
  panel.querySelectorAll('.recipe-ingredient-row').forEach((row) => {
    const name = row.querySelector('.recipe-ingredient-row__name')?.value.trim() || '';
    const quantity = row.querySelector('.recipe-ingredient-row__qty')?.value.trim() || null;
    const category = row.querySelector('.recipe-ingredient-row__cat')?.value || DEFAULT_CATEGORY_NAME;
    if (name) ingredients.push({ name, quantity, category });
  });

  saveBtn.disabled = true;

  try {
    if (mode === 'create') {
      const res = await api.post('/recipes', { title, notes, recipe_url, ingredients });
      state.recipes.push(res.data);
    } else {
      const res = await api.put(`/recipes/${recipe.id}`, { title, notes, recipe_url, ingredients });
      const idx = state.recipes.findIndex((r) => r.id === recipe.id);
      if (idx >= 0) state.recipes[idx] = res.data;
    }

    closeModal({ force: true });
    renderRecipeList();
    window.oikos?.showToast(mode === 'create' ? t('recipes.created') : t('recipes.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
  }
}

async function removeRecipe(recipe) {
  const itemEl = _container.querySelector(`.recipe-card[data-id="${recipe.id}"]`);
  if (itemEl) itemEl.style.display = 'none';

  let undone = false;
  window.oikos?.showToast(t('recipes.deleted'), 'default', 5000, () => {
    undone = true;
    if (itemEl) itemEl.style.display = '';
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/recipes/${recipe.id}`);
      state.recipes = state.recipes.filter((r) => r.id !== recipe.id);
      renderRecipeList();
    } catch (err) {
      if (itemEl) itemEl.style.display = '';
      window.oikos?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }, 5000);
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
    window.oikos?.showToast(t('recipes.duplicated'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
  }
}
