/**
 * Module: Kitchen handover to a shopping list (R23, D2)
 * Purpose: The ONE rule for what a kitchen path puts on a shopping list - recipe,
 *          meal card, meal-plan import (week and date range) and pantry. Plus the
 *          meal-plan source those paths share: which ingredients a range of meals
 *          has, including meals planned from a recipe.
 * Dependencies: public/utils/ingredient-match-key.js (isomorphic),
 *               server/services/shopping-import.js (aggregation)
 *
 * WHY ONE FUNCTION. Until R23 there were three rules at four handovers: the recipe
 * skipped open items of the same name, the pantry did the same with SQLite's
 * NOCASE (ASCII only - "Öl" and "öl" were two items), and the meal card and both
 * meal-plan imports wrote everything again. Planning Monday's and Tuesday's dish
 * from the same recipe put "Zwiebeln" on the list twice; importing the week after
 * tapping a card did it again (Critique R23, G3 P1). The rule now lives here:
 *
 *   An OPEN (unchecked) item on the target list with the same normalised name
 *   means the row is skipped and counted. A checked item does not count - it was
 *   bought, and the next dish needs it again.
 *
 * The name is normalised like every other kitchen identity (ingredientMatchKey:
 * trimmed, inner whitespace collapsed, toLowerCase - which, unlike SQLite's
 * lower(), knows "Ö"). No stemming, no synonyms: "Zwiebel" and "Zwiebeln" stay two
 * names (docs/DECISIONS.md, 7 - a guessed identity is a catalogue).
 *
 * TWO ROWS OF ONE NAME IN ONE BATCH are not a duplicate, they are one item: they
 * merge into one row, and their quantities are joined ("2 + 1 Stück") when the
 * aggregation could not add them up. Skipping the second one would lose its
 * amount and count it as "already on the list", which it was not.
 *
 * Every function takes the database handle and runs synchronously; the callers
 * wrap them in their transaction (no await anywhere near this).
 */

import { ingredientMatchKey } from '../../public/utils/ingredient-match-key.js';
import { aggregateMealIngredients } from './shopping-import.js';

/** The key a shopping item is compared under; '' when nothing is left. */
export const shoppingNameKey = (name) => ingredientMatchKey(name);

/**
 * Rows of one batch with the same name become one row.
 * @param {Array<{name: string, quantity?: string|null, category?: string, added_from_meal?: number|null, ingredientIds?: number[]}>} rows
 */
export function mergeSameName(rows = []) {
  const merged = new Map();
  for (const row of rows) {
    const key = shoppingNameKey(row?.name);
    if (!key) continue;
    const quantity = String(row.quantity ?? '').trim() || null;
    const ingredientIds = Array.isArray(row.ingredientIds) ? row.ingredientIds : [];
    const known = merged.get(key);
    if (!known) {
      merged.set(key, {
        name: String(row.name).trim(),
        quantity,
        category: row.category || 'Sonstiges',
        added_from_meal: row.added_from_meal ?? null,
        ingredientIds: [...ingredientIds],
        quantities: quantity ? [quantity] : [],
      });
      continue;
    }
    if (quantity && !known.quantities.includes(quantity)) known.quantities.push(quantity);
    known.quantity = known.quantities.length ? known.quantities.join(' + ') : null;
    if (known.added_from_meal !== (row.added_from_meal ?? null)) known.added_from_meal = null;
    known.ingredientIds.push(...ingredientIds);
  }
  return [...merged.values()].map(({ quantities: _q, ...row }) => row);
}

/** Keys of the open items of a list. */
function openItemKeys(database, listId) {
  const rows = database.prepare('SELECT name FROM shopping_items WHERE list_id = ? AND is_checked = 0').all(listId);
  return new Set(rows.map((r) => shoppingNameKey(r.name)).filter(Boolean));
}

/**
 * What a handover WOULD do, without writing: for the preview of the meal-plan
 * import ("5 new, 2 already on the list").
 * @returns {{ added: number, skipped: number }}
 */
export function previewHandover(database, listId, rows) {
  const present = openItemKeys(database, listId);
  let added = 0;
  let skipped = 0;
  for (const row of mergeSameName(rows)) {
    if (present.has(shoppingNameKey(row.name))) skipped += 1;
    else added += 1;
  }
  return { added, skipped };
}

/**
 * Put rows on a shopping list under the one rule above.
 *
 * Meal ingredients (`ingredientIds`) are marked `on_shopping_list = 1` both when
 * their row was added AND when it was skipped: the ingredient is on the list
 * either way, and the card stops offering a transfer it would only answer with
 * "already there". `ingredient_ids` names every ingredient this call marked, so
 * the undo can unmark exactly these (POST /shopping/items/undo-transfer) - until
 * R23 it guessed them back from meal id and name, which missed every row the
 * meal-plan import had summed over two meals.
 *
 * @returns {{ added_ids: number[], skipped: number, ingredient_ids: number[] }}
 */
export function handOverToShoppingList(database, listId, rows) {
  const present = openItemKeys(database, listId);
  const insert = database.prepare(`
    INSERT INTO shopping_items (list_id, name, quantity, category, added_from_meal)
    VALUES (?, ?, ?, ?, ?)
  `);
  const mark = database.prepare('UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ? AND on_shopping_list = 0');

  const addedIds = [];
  const ingredientIds = [];
  let skipped = 0;
  for (const row of mergeSameName(rows)) {
    const key = shoppingNameKey(row.name);
    if (present.has(key)) {
      skipped += 1;
    } else {
      const info = insert.run(listId, row.name, row.quantity, row.category || 'Sonstiges', row.added_from_meal ?? null);
      addedIds.push(Number(info.lastInsertRowid));
      present.add(key);
    }
    for (const id of row.ingredientIds) {
      if (mark.run(id).changes) ingredientIds.push(Number(id));
    }
  }
  return { added_ids: addedIds, skipped, ingredient_ids: ingredientIds };
}

/**
 * A meal planned from a recipe has no ingredients of its own, only its recipe_id.
 * On the first transfer its recipe's ingredients become real meal_ingredients, so
 * that the `on_shopping_list` flag can protect the MEAL from a second transfer
 * (the recipe is a template and gets no flag). The condition is "no ingredients at
 * all", not "none open": after a full transfer nothing is copied again.
 *
 * Until R23 only the meal card did this; the week import and the shopping list's
 * "From the meal plan" read meal_ingredients alone and missed every meal planned
 * from a recipe (Critique R23, G3: 5 of 8 meals, 27 ingredients missing).
 */
export function materializeRecipeIngredients(database, mealIds) {
  const meals = database.prepare(`
    SELECT m.id, m.recipe_id FROM meals m
    WHERE m.id = ? AND m.recipe_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM meal_ingredients mi WHERE mi.meal_id = m.id)
  `);
  const recipeIngredients = database.prepare(
    'SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC',
  );
  const copy = database.prepare(
    'INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, ?, ?, ?)',
  );
  for (const mealId of mealIds) {
    const meal = meals.get(mealId);
    if (!meal) continue;
    for (const ing of recipeIngredients.all(meal.recipe_id)) {
      copy.run(meal.id, ing.name, ing.quantity, ing.category || 'Sonstiges');
    }
  }
}

/**
 * The open ingredients of the meals in a date range, aggregated for the list.
 *
 * `materialize: false` is the preview: recipe meals are read from their recipe
 * instead of being copied, so a preview writes nothing and still counts them.
 *
 * @returns {{ ingredients: object[], rows: object[], meals: number }}
 *   `ingredients` the open source rows, `rows` what goes onto the list,
 *   `meals` how many meals contribute.
 */
export function mealPlanSource(database, { from, to, mealId = null }, { materialize = true } = {}) {
  const mealRows = mealId != null
    ? database.prepare('SELECT id, recipe_id FROM meals WHERE id = ?').all(mealId)
    : database.prepare('SELECT id, recipe_id FROM meals WHERE date BETWEEN ? AND ? ORDER BY date ASC, id ASC').all(from, to);

  if (materialize) materializeRecipeIngredients(database, mealRows.map((m) => m.id));

  const ownIngredients = database.prepare(`
    SELECT id, meal_id, name, quantity, category FROM meal_ingredients
    WHERE meal_id = ? AND on_shopping_list = 0 ORDER BY id ASC
  `);
  const hasAny = database.prepare('SELECT 1 FROM meal_ingredients WHERE meal_id = ? LIMIT 1');
  const fromRecipe = database.prepare(
    'SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC',
  );

  const ingredients = [];
  for (const meal of mealRows) {
    if (!materialize && meal.recipe_id && !hasAny.get(meal.id)) {
      for (const ing of fromRecipe.all(meal.recipe_id)) ingredients.push({ id: null, meal_id: meal.id, ...ing });
      continue;
    }
    ingredients.push(...ownIngredients.all(meal.id));
  }

  const rows = aggregateMealIngredients(ingredients);
  return { ingredients, rows, meals: new Set(ingredients.map((i) => i.meal_id)).size };
}
