/**
 * Modul: Rezepte (Recipes)
 * Zweck: Gespeicherte Rezepte verwalten und in den Essensplan uebernehmen
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, confirmModal } from '/components/modal.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';

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

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn--primary';
  addBtn.type = 'button';
  addBtn.id = 'recipes-add';
  addBtn.textContent = t('recipes.addRecipe');

  header.append(title, addBtn);

  const list = document.createElement('div');
  list.className = 'recipes-list';
  list.id = 'recipes-list';

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

  if (window.lucide) window.lucide.createIcons();

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

    empty.append(emptyTitle, emptyDesc);
    list.appendChild(empty);
    return;
  }

  for (const recipe of state.recipes) {
    const card = document.createElement('article');
    card.className = 'recipe-card';

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

function recipeIngredientRowHTML(name, qty, category = DEFAULT_CATEGORY_NAME) {
  const categories = mealCategories();
  const resolvedCategory = categories.some((c) => c.name === category)
    ? category
    : (categories[0]?.name ?? DEFAULT_CATEGORY_NAME);
  const catOptions = categories.length
    ? categories.map((c) => `<option value="${esc(c.name)}" ${c.name === resolvedCategory ? 'selected' : ''}>${esc(categoryLabel(c.name))}</option>`).join('')
    : `<option value="${DEFAULT_CATEGORY_NAME}" selected>${t('meals.ingredientCategoryDefault')}</option>`;

  return `
    <div class="recipe-ingredient-row">
      <input type="text" class="form-input recipe-ingredient-row__name" placeholder="${t('meals.ingredientNamePlaceholder')}" value="${esc(name)}">
      <input type="text" class="form-input recipe-ingredient-row__qty" placeholder="${t('meals.ingredientQtyPlaceholder')}" value="${esc(qty)}">
      <select class="form-input recipe-ingredient-row__cat" aria-label="${t('meals.ingredientCategoryLabel')}">${catOptions}</select>
      <button class="recipe-ingredient-row__remove" data-action="remove-ingredient" type="button" aria-label="${t('meals.removeIngredient')}">
        <i data-lucide="x" style="width:14px;height:14px;" aria-hidden="true"></i>
      </button>
    </div>
  `;
}

function openRecipeModal(mode, recipe = null) {
  const isEdit = mode === 'edit';
  const ingredientRows = isEdit && recipe.ingredients?.length
    ? recipe.ingredients.map((i) => recipeIngredientRowHTML(i.name, i.quantity ?? '', i.category ?? DEFAULT_CATEGORY_NAME)).join('')
    : '';

  openSharedModal({
    title: isEdit ? t('recipes.editRecipe') : t('recipes.addRecipe'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="recipe-title">${t('recipes.titleLabel')}</label>
        <input id="recipe-title" class="form-input" type="text" value="${esc(isEdit ? recipe.title : '')}" placeholder="${t('recipes.titlePlaceholder')}">
      </div>
      <div class="form-group">
        <label class="form-label" for="recipe-notes">${t('recipes.notesLabel')}</label>
        <textarea id="recipe-notes" class="form-input" rows="3" placeholder="${t('recipes.notesPlaceholder')}">${esc(isEdit && recipe.notes ? recipe.notes : '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label" for="recipe-url">${t('recipes.urlLabel')}</label>
        <input id="recipe-url" class="form-input" type="url" value="${esc(isEdit && recipe.recipe_url ? recipe.recipe_url : '')}" placeholder="${t('recipes.urlPlaceholder')}">
      </div>
      <div class="form-group">
        <label class="form-label">${t('recipes.ingredientsLabel')}</label>
        <div class="recipe-ingredient-list" id="recipe-ingredient-list">${ingredientRows}</div>
        <button class="btn btn--secondary recipe-add-ingredient" type="button" id="recipe-add-ingredient">${t('meals.addIngredient')}</button>
      </div>
      <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
        <button class="btn btn--secondary" id="recipe-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="recipe-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    `,
    onSave(panel) {
      const ingList = panel.querySelector('#recipe-ingredient-list');
      panel.querySelector('#recipe-add-ingredient')?.addEventListener('click', () => {
        const tmp = document.createElement('div');
        tmp.innerHTML = recipeIngredientRowHTML('', '', null);
        const row = tmp.firstElementChild;
        ingList.appendChild(row);
        if (window.lucide) window.lucide.createIcons();
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (!btn) return;
        btn.closest('.recipe-ingredient-row')?.remove();
      });

      panel.querySelector('#recipe-cancel')?.addEventListener('click', closeModal);
      panel.querySelector('#recipe-save')?.addEventListener('click', () => saveRecipe(panel, mode, recipe));

      if (window.lucide) window.lucide.createIcons();
    },
  });
}

function closeModal() {
  closeSharedModal();
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

    closeModal();
    renderRecipeList();
    window.oikos?.showToast(mode === 'create' ? t('recipes.created') : t('recipes.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
  }
}

async function removeRecipe(recipe) {
  const ok = await confirmModal(t('recipes.deleteConfirm', { title: recipe.title }), {
    danger: true,
    confirmLabel: t('common.delete'),
  });

  if (!ok) return;

  try {
    await api.delete(`/recipes/${recipe.id}`);
    state.recipes = state.recipes.filter((r) => r.id !== recipe.id);
    renderRecipeList();
    window.oikos?.showToast(t('recipes.deleted'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
  }
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
    await api.post('/recipes', { title, notes, recipe_url, ingredients });
    await loadRecipes();
    renderRecipeList();
    window.oikos?.showToast(t('recipes.duplicated'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error ?? t('common.errorGeneric'), 'error');
  }
}
