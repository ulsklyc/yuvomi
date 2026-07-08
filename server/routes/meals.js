/**
 * Modul: Essensplan (Meals)
 * Zweck: REST-API-Routen für Mahlzeiten, Zutaten und Einkaufslisten-Integration
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, date, num, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT, DATE_RE } from '../middleware/validate.js';
import { addDays, mealWeekday, datesForTemplateInRange } from '../services/meal-recurrence.js';

const log = createLogger('Meals');

const router  = express.Router();

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = Monday, 6 = Sunday

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

/**
 * Gibt den ISO-Datumstring (YYYY-MM-DD) für den Montag einer Woche zurück.
 * @param {string} dateStr - beliebiges Datum der Woche (YYYY-MM-DD)
 */
function weekStart(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();          // 0 = So, 1 = Mo, …
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Gibt den ISO-Datumstring für den Sonntag einer Woche zurück.
 */
function weekEnd(dateStr) {
  const start = weekStart(dateStr);
  const d     = new Date(start + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function insertMealIngredients(mealId, ingredients) {
  const insertIng = db.get().prepare(`
    INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, ?, ?, ?)
  `);

  for (const ing of ingredients) {
    insertIng.run(mealId, ing.name, ing.quantity, ing.category || 'Sonstiges');
  }
}

function sanitizedIngredients(ingredients) {
  return ingredients
    .map((ing) => ({
      name: String(ing.name || '').trim().slice(0, MAX_TITLE),
      quantity: String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null,
      category: String(ing.category || '').trim().slice(0, MAX_SHORT) || 'Sonstiges',
    }))
    .filter((ing) => ing.name);
}

function loadMealWithIngredients(id) {
  const meal = db.get().prepare(`
    SELECT m.*, u.display_name AS creator_name, u.avatar_color AS creator_color
    FROM meals m
    LEFT JOIN users u ON u.id = m.created_by
    WHERE m.id = ?
  `).get(id);
  if (!meal) return null;
  const ingredients = db.get().prepare('SELECT * FROM meal_ingredients WHERE meal_id = ? ORDER BY id ASC').all(id);
  return { ...meal, ingredients }; 
}

function deleteMealOccurrence(meal, actorId) {
  if (!meal) return;
  if (meal.recurrence_template_id) {
    db.get().prepare(`
      INSERT OR IGNORE INTO meal_recurrence_exceptions (template_id, date, created_by)
      VALUES (?, ?, ?)
    `).run(meal.recurrence_template_id, meal.date, actorId);
  }
  db.get().prepare('DELETE FROM meals WHERE id = ?').run(meal.id);
}

function createMealRecord({ date, meal_type, title, notes, recipe_url, recipe_id, ingredients = [] }, actorId) {
  const cleanIngredients = sanitizedIngredients(ingredients);
  const result = db.get().prepare(`
    INSERT INTO meals (date, meal_type, title, notes, recipe_url, recipe_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(date, meal_type, title, notes, recipe_url, recipe_id, actorId);
  insertMealIngredients(result.lastInsertRowid, cleanIngredients);
  return loadMealWithIngredients(result.lastInsertRowid);
}

function materializeRecurringMeals(from, to) {
  const templates = db.get().prepare(`
    SELECT *
    FROM meal_recurrence_templates
    WHERE start_date <= ?
    ORDER BY id ASC
  `).all(to);

  if (!templates.length) return;

  const createMeals = db.get().transaction(() => {
    const hasException = db.get().prepare(`
      SELECT 1
      FROM meal_recurrence_exceptions
      WHERE template_id = ? AND date = ?
    `);
    const hasMeal = db.get().prepare(`
      SELECT 1
      FROM meals
      WHERE recurrence_template_id = ? AND date = ?
    `);
    const templateIngredients = db.get().prepare(`
      SELECT name, quantity, category
      FROM meal_recurrence_ingredients
      WHERE template_id = ?
      ORDER BY id ASC
    `);
    const insertMeal = db.get().prepare(`
      INSERT INTO meals (date, meal_type, title, notes, recipe_url, recipe_id, recurrence_template_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const template of templates) {
      if (!VALID_WEEKDAYS.includes(template.weekday)) continue;
      const ingredients = templateIngredients.all(template.id);
      for (const date of datesForTemplateInRange(template, from, to)) {
        if (hasException.get(template.id, date) || hasMeal.get(template.id, date)) continue;
        const result = insertMeal.run(
          date,
          template.meal_type,
          template.title,
          template.notes,
          template.recipe_url,
          template.recipe_id,
          template.id,
          template.created_by
        );
        insertMealIngredients(result.lastInsertRowid, ingredients);
      }
    }
  });

  createMeals();
}

// --------------------------------------------------------
// Routen - Mahlzeiten-Vorschläge (vor dynamischen Routen!)
// --------------------------------------------------------

/**
 * GET /api/v1/meals/suggestions
 * Autocomplete für Mahlzeit-Titel aus der Historie.
 * Query: ?q=<string>
 * Response: { data: [{ title, meal_type }] }
 */
router.get('/suggestions', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ data: [] });

    const rows = db.get().prepare(`
      SELECT DISTINCT title, meal_type
      FROM meals
      WHERE title LIKE ? COLLATE NOCASE
      ORDER BY title ASC
      LIMIT 10
    `).all(`${q}%`);

    res.json({ data: rows });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// Routen - Wochenübersicht
// --------------------------------------------------------

/**
 * GET /api/v1/meals
 * Alle Mahlzeiten einer Woche inkl. Zutaten.
 * Query: ?week=YYYY-MM-DD  (beliebiges Datum der gewünschten Woche; default: aktuelle Woche)
 * Response: { data: Meal[], weekStart: string, weekEnd: string }
 *
 * Meal: { id, date, meal_type, title, notes, created_by, ingredients: Ingredient[] }
 * Ingredient: { id, meal_id, name, quantity, on_shopping_list }
 */
router.get('/', (req, res) => {
  try {
    const refDate = req.query.week && DATE_RE.test(req.query.week)
      ? req.query.week
      : new Date().toISOString().slice(0, 10);

    const from = weekStart(refDate);
    const to   = weekEnd(refDate);

    materializeRecurringMeals(from, to);

    const meals = db.get().prepare(`
      SELECT m.*, u.display_name AS creator_name, u.avatar_color AS creator_color
      FROM meals m
      LEFT JOIN users u ON u.id = m.created_by
      WHERE m.date BETWEEN ? AND ?
      ORDER BY m.date ASC,
        CASE m.meal_type
          WHEN 'breakfast' THEN 0
          WHEN 'lunch'     THEN 1
          WHEN 'dinner'    THEN 2
          WHEN 'snack'     THEN 3
          ELSE 4
        END ASC
    `).all(from, to);

    // Zutaten für alle Mahlzeiten in einer Abfrage holen
    const mealIds = meals.map((m) => m.id);
    let ingredientMap = {};

    if (mealIds.length > 0) {
      const placeholders = mealIds.map(() => '?').join(',');
      const ingredients  = db.get().prepare(`
        SELECT * FROM meal_ingredients
        WHERE meal_id IN (${placeholders})
        ORDER BY id ASC
      `).all(...mealIds);

      for (const ing of ingredients) {
        if (!ingredientMap[ing.meal_id]) ingredientMap[ing.meal_id] = [];
        ingredientMap[ing.meal_id].push(ing);
      }
    }

    const result = meals.map((m) => ({
      ...m,
      ingredients: ingredientMap[m.id] || [],
    }));

    res.json({ data: result, weekStart: from, weekEnd: to });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// CRUD - Mahlzeiten
// --------------------------------------------------------

/**
 * POST /api/v1/meals
 * Neue Mahlzeit anlegen.
 * Body: { date, meal_type, title, notes?, ingredients?: [{ name, quantity? }] }
 * Response: { data: Meal }
 */
router.post('/', (req, res) => {
  try {
    const { ingredients = [] } = req.body;
    const vDate       = date(req.body.date, 'Datum', true);
    const vType       = oneOf(req.body.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ');
    const vTitle      = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes      = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl  = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    const vRecipeId   = num(req.body.recipe_id, 'Rezept-ID', { required: false });
    const repeatWeekly = req.body.repeat_weekly === true;
    const errors = collectErrors([vDate, vType, vTitle, vNotes, vRecipeUrl, vRecipeId]);
    if (!req.body.meal_type) errors.push('Mahlzeit-Typ ist erforderlich.');
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    if (vRecipeId.value !== null) {
      const recipeExists = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(vRecipeId.value);
      if (!recipeExists) return res.status(400).json({ error: 'Rezept nicht gefunden.', code: 400 });
    }

    const meal = db.transaction(() => {
      const cleanIngredients = sanitizedIngredients(ingredients);
      let recurrenceTemplateId = null;

      if (repeatWeekly) {
        const template = db.get().prepare(`
          INSERT INTO meal_recurrence_templates
            (start_date, weekday, meal_type, title, notes, recipe_url, recipe_id, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          vDate.value,
          mealWeekday(vDate.value),
          vType.value,
          vTitle.value,
          vNotes.value,
          vRecipeUrl.value,
          vRecipeId.value,
          req.authUserId || req.session.userId
        );
        recurrenceTemplateId = template.lastInsertRowid;

        const insertTemplateIng = db.get().prepare(`
          INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category)
          VALUES (?, ?, ?, ?)
        `);
        for (const ing of cleanIngredients) {
          insertTemplateIng.run(recurrenceTemplateId, ing.name, ing.quantity, ing.category);
        }
      }

      const result = db.get().prepare(`
        INSERT INTO meals (date, meal_type, title, notes, recipe_url, recipe_id, recurrence_template_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vDate.value, vType.value, vTitle.value, vNotes.value, vRecipeUrl.value, vRecipeId.value, recurrenceTemplateId, req.authUserId || req.session.userId);

      const mealId = result.lastInsertRowid;

      insertMealIngredients(mealId, cleanIngredients);

      return loadMealWithIngredients(mealId);
    });

    res.status(201).json({ data: meal });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/apply-plan', (req, res) => {
  try {
    const assignments = Array.isArray(req.body.assignments) ? req.body.assignments : [];
    const replaceExisting = req.body.replace_existing === true;
    if (!assignments.length) {
      return res.status(400).json({ error: 'Mindestens eine Mahlzeit ist erforderlich.', code: 400 });
    }

    const prepared = [];
    const recipeIds = new Set();
    for (const assignment of assignments) {
      const vDate = date(assignment.date, 'Datum', true);
      const vType = oneOf(assignment.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ');
      const vTitle = str(assignment.title, 'Titel', { max: MAX_TITLE });
      const vNotes = str(assignment.notes, 'Notizen', { max: MAX_TEXT, required: false });
      const vRecipeUrl = str(assignment.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
      const vRecipeId = num(assignment.recipe_id, 'Rezept-ID', { required: false });
      const errors = collectErrors([vDate, vType, vTitle, vNotes, vRecipeUrl, vRecipeId]);
      if (!assignment.meal_type) errors.push('Mahlzeit-Typ ist erforderlich.');
      if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
      if (vRecipeId.value !== null) recipeIds.add(vRecipeId.value);
      prepared.push({
        date: vDate.value,
        meal_type: vType.value,
        title: vTitle.value,
        notes: vNotes.value,
        recipe_url: vRecipeUrl.value,
        recipe_id: vRecipeId.value,
        ingredients: assignment.ingredients || [],
      });
    }

    for (const recipeId of recipeIds) {
      const recipeExists = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId);
      if (!recipeExists) return res.status(400).json({ error: 'Rezept nicht gefunden.', code: 400 });
    }

    const created = db.transaction(() => {
      const actorId = req.authUserId || req.session.userId;
      if (replaceExisting) {
        const slots = [...new Set(prepared.map((assignment) => `${assignment.date}\u0000${assignment.meal_type}`))];
        const selectMeals = db.get().prepare('SELECT * FROM meals WHERE date = ? AND meal_type = ? ORDER BY id ASC');
        for (const slot of slots) {
          const [slotDate, slotType] = slot.split('\u0000');
          const existingMeals = selectMeals.all(slotDate, slotType);
          for (const meal of existingMeals) deleteMealOccurrence(meal, actorId);
        }
      }

      return prepared.map((assignment) => createMealRecord(assignment, actorId));
    });

    res.status(201).json({ data: created });
  } catch (err) {
    log.error('POST /apply-plan', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PUT /api/v1/meals/:id
 * Mahlzeit bearbeiten (Titel, Notizen, Datum, Typ).
 * Body: { date?, meal_type?, title?, notes? }
 * Response: { data: Meal }
 */
router.put('/:id', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const meal = db.get().prepare('SELECT * FROM meals WHERE id = ?').get(id);
    if (!meal) return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });

    const checks = [];
    if (req.body.date       !== undefined) checks.push(date(req.body.date, 'Datum'));
    if (req.body.meal_type  !== undefined) checks.push(oneOf(req.body.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ'));
    if (req.body.title      !== undefined) checks.push(str(req.body.title, 'Titel', { max: MAX_TITLE, required: false }));
    if (req.body.notes      !== undefined) checks.push(str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false }));
    if (req.body.recipe_url !== undefined) checks.push(str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false }));
    if (req.body.recipe_id  !== undefined) checks.push(num(req.body.recipe_id, 'Rezept-ID', { required: false }));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    if (req.body.recipe_id !== undefined && req.body.recipe_id !== null && req.body.recipe_id !== '') {
      const recipeExists = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(req.body.recipe_id);
      if (!recipeExists) return res.status(400).json({ error: 'Rezept nicht gefunden.', code: 400 });
    }

    // scope=series schreibt die inhaltlichen Felder (nicht das Datum) auf das Template
    // und auf alle bereits materialisierten Instanzen zurück; Zutaten werden – falls
    // mitgeschickt – überall vollständig ersetzt.
    if (req.query.scope === 'series' && meal.recurrence_template_id) {
      const templateId = meal.recurrence_template_id;
      const tpl = db.get().prepare('SELECT * FROM meal_recurrence_templates WHERE id = ?').get(templateId);

      const nMealType  = req.body.meal_type  !== undefined ? req.body.meal_type                 : tpl.meal_type;
      const nTitle     = req.body.title      !== undefined ? (req.body.title?.trim() || tpl.title) : tpl.title;
      const nNotes     = req.body.notes      !== undefined ? (req.body.notes      || null)       : tpl.notes;
      const nRecipeUrl = req.body.recipe_url !== undefined ? (req.body.recipe_url || null)       : tpl.recipe_url;
      const nRecipeId  = req.body.recipe_id  !== undefined ? (req.body.recipe_id  || null)       : tpl.recipe_id;

      db.transaction(() => {
        db.get().prepare(`
          UPDATE meal_recurrence_templates
          SET meal_type = ?, title = ?, notes = ?, recipe_url = ?, recipe_id = ?
          WHERE id = ?
        `).run(nMealType, nTitle, nNotes, nRecipeUrl, nRecipeId, templateId);

        db.get().prepare(`
          UPDATE meals
          SET meal_type = ?, title = ?, notes = ?, recipe_url = ?, recipe_id = ?
          WHERE recurrence_template_id = ?
        `).run(nMealType, nTitle, nNotes, nRecipeUrl, nRecipeId, templateId);

        if (Array.isArray(req.body.ingredients)) {
          const cleanIngredients = sanitizedIngredients(req.body.ingredients);

          db.get().prepare('DELETE FROM meal_recurrence_ingredients WHERE template_id = ?').run(templateId);
          const insertTemplateIng = db.get().prepare(`
            INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category)
            VALUES (?, ?, ?, ?)
          `);
          for (const ing of cleanIngredients) {
            insertTemplateIng.run(templateId, ing.name, ing.quantity, ing.category);
          }

          const instances = db.get().prepare('SELECT id FROM meals WHERE recurrence_template_id = ?').all(templateId);
          const deleteIng  = db.get().prepare('DELETE FROM meal_ingredients WHERE meal_id = ?');
          for (const inst of instances) {
            deleteIng.run(inst.id);
            insertMealIngredients(inst.id, cleanIngredients);
          }
        }
      });

      return res.json({ data: loadMealWithIngredients(id) });
    }

    if (meal.recurrence_template_id && req.body.date !== undefined && req.body.date !== meal.date) {
      db.get().prepare(`
        INSERT OR IGNORE INTO meal_recurrence_exceptions (template_id, date, created_by)
        VALUES (?, ?, ?)
      `).run(meal.recurrence_template_id, meal.date, req.authUserId || req.session.userId);
    }

    db.get().prepare(`
      UPDATE meals
      SET date       = COALESCE(?, date),
          meal_type  = COALESCE(?, meal_type),
          title      = COALESCE(?, title),
          notes      = ?,
          recipe_url = ?,
          recipe_id  = ?
      WHERE id = ?
    `).run(
      req.body.date      ?? null,
      req.body.meal_type ?? null,
      req.body.title?.trim() ?? null,
      req.body.notes       !== undefined ? (req.body.notes || null)       : meal.notes,
      req.body.recipe_url  !== undefined ? (req.body.recipe_url || null)  : meal.recipe_url,
      req.body.recipe_id   !== undefined ? (req.body.recipe_id || null)   : meal.recipe_id,
      id
    );

    res.json({ data: loadMealWithIngredients(id) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/meals/:id
 * Mahlzeit löschen (Zutaten werden per CASCADE mitgelöscht).
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const meal   = db.get().prepare('SELECT * FROM meals WHERE id = ?').get(id);
    if (!meal) return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });

    // scope=series entfernt die gesamte Serie: alle materialisierten Instanzen plus
    // das Template (CASCADE räumt Template-Zutaten und Ausnahmen ab). Da
    // meals.recurrence_template_id ON DELETE SET NULL ist, müssen die Instanzen vor
    // dem Template explizit gelöscht werden, sonst blieben sie als Einzel-Mahlzeiten zurück.
    if (req.query.scope === 'series' && meal.recurrence_template_id) {
      const templateId = meal.recurrence_template_id;
      db.transaction(() => {
        db.get().prepare('DELETE FROM meals WHERE recurrence_template_id = ?').run(templateId);
        db.get().prepare('DELETE FROM meal_recurrence_templates WHERE id = ?').run(templateId);
      });
      return res.status(204).end();
    }

    deleteMealOccurrence(meal, req.authUserId || req.session.userId);
    const result = { changes: 1 };
    if (result.changes === 0)
      return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// CRUD - Zutaten
// --------------------------------------------------------

/**
 * POST /api/v1/meals/:id/ingredients
 * Zutat zur Mahlzeit hinzufügen.
 * Body: { name, quantity? }
 * Response: { data: Ingredient }
 */
router.post('/:id/ingredients', (req, res) => {
  try {
    const mealId = parseInt(req.params.id, 10);
    const meal   = db.get().prepare('SELECT id FROM meals WHERE id = ?').get(mealId);
    if (!meal) return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });

    const { name, quantity = null, category = 'Sonstiges' } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: 'Name ist erforderlich', code: 400 });

    const result = db.get().prepare(`
      INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, ?, ?, ?)
    `).run(mealId, name.trim(), quantity?.trim() || null, String(category || '').trim() || 'Sonstiges');

    const ing = db.get().prepare(
      'SELECT * FROM meal_ingredients WHERE id = ?'
    ).get(result.lastInsertRowid);

    res.status(201).json({ data: ing });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PATCH /api/v1/meals/ingredients/:ingId
 * Zutat bearbeiten (Name, Menge, on_shopping_list-Flag).
 * Body: { name?, quantity?, on_shopping_list? }
 * Response: { data: Ingredient }
 */
router.patch('/ingredients/:ingId', (req, res) => {
  try {
    const ingId = parseInt(req.params.ingId, 10);
    const ing   = db.get().prepare('SELECT * FROM meal_ingredients WHERE id = ?').get(ingId);
    if (!ing) return res.status(404).json({ error: 'Zutat nicht gefunden', code: 404 });

    const { name, quantity, on_shopping_list, category } = req.body;

    db.get().prepare(`
      UPDATE meal_ingredients
      SET name             = COALESCE(?, name),
          quantity         = ?,
          category         = COALESCE(?, category),
          on_shopping_list = COALESCE(?, on_shopping_list)
      WHERE id = ?
    `).run(
      name?.trim() ?? null,
      quantity !== undefined ? (quantity?.trim() || null) : ing.quantity,
      category !== undefined ? (String(category || '').trim() || 'Sonstiges') : null,
      on_shopping_list !== undefined ? (on_shopping_list ? 1 : 0) : null,
      ingId
    );

    const updated = db.get().prepare(
      'SELECT * FROM meal_ingredients WHERE id = ?'
    ).get(ingId);

    res.json({ data: updated });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/meals/ingredients/:ingId
 * Zutat löschen.
 * Response: 204 No Content
 */
router.delete('/ingredients/:ingId', (req, res) => {
  try {
    const ingId  = parseInt(req.params.ingId, 10);
    const result = db.get().prepare('DELETE FROM meal_ingredients WHERE id = ?').run(ingId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Zutat nicht gefunden', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// Integration: Zutaten → Einkaufsliste (Phase 2, Schritt 12)
// --------------------------------------------------------

/**
 * POST /api/v1/meals/:id/to-shopping-list
 * Alle noch nicht übertragenen Zutaten einer Mahlzeit auf eine Einkaufsliste übernehmen.
 * Body: { listId: number, category?: string }
 * Response: { data: { transferred: number } }
 */
router.post('/:id/to-shopping-list', (req, res) => {
  try {
    const mealId = parseInt(req.params.id, 10);
    const meal   = db.get().prepare('SELECT id FROM meals WHERE id = ?').get(mealId);
    if (!meal) return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });

    const { listId } = req.body;
    if (!listId)
      return res.status(400).json({ error: 'listId ist erforderlich', code: 400 });

    const list = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(listId);
    if (!list) return res.status(404).json({ error: 'Einkaufsliste nicht gefunden', code: 404 });

    const ingredients = db.get().prepare(`
      SELECT * FROM meal_ingredients
      WHERE meal_id = ? AND on_shopping_list = 0
    `).all(mealId);

    if (ingredients.length === 0)
      return res.json({ data: { transferred: 0 } });

    const transferred = db.transaction(() => {
      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category, added_from_meal)
        VALUES (?, ?, ?, ?, ?)
      `);
      const markDone = db.get().prepare(`
        UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ?
      `);

      let count = 0;
      for (const ing of ingredients) {
        insertItem.run(listId, ing.name, ing.quantity, ing.category || 'Sonstiges', mealId);
        markDone.run(ing.id);
        count++;
      }
      return count;
    });

    res.json({ data: { transferred } });
  } catch (err) {
    log.error('POST /:id/to-shopping-list', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/meals/week-to-shopping-list
 * Alle noch nicht übertragenen Zutaten einer ganzen Woche auf eine Einkaufsliste übernehmen.
 * Body: { listId, week: YYYY-MM-DD, category? }
 * Response: { data: { transferred: number } }
 */
router.post('/week-to-shopping-list', (req, res) => {
  try {
    const { listId, week } = req.body;

    if (!listId)
      return res.status(400).json({ error: 'listId ist erforderlich', code: 400 });
    if (!week || !DATE_RE.test(week))
      return res.status(400).json({ error: 'Gültiges Datum (YYYY-MM-DD) erforderlich', code: 400 });

    const list = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(listId);
    if (!list) return res.status(404).json({ error: 'Einkaufsliste nicht gefunden', code: 404 });

    const from = weekStart(week);
    const to   = weekEnd(week);

    const ingredients = db.get().prepare(`
      SELECT mi.* FROM meal_ingredients mi
      JOIN meals m ON m.id = mi.meal_id
      WHERE m.date BETWEEN ? AND ?
        AND mi.on_shopping_list = 0
    `).all(from, to);

    if (ingredients.length === 0)
      return res.json({ data: { transferred: 0 } });

    const transferred = db.transaction(() => {
      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category, added_from_meal)
        VALUES (?, ?, ?, ?, ?)
      `);
      const markDone = db.get().prepare(`
        UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ?
      `);

      let count = 0;
      for (const ing of ingredients) {
        insertItem.run(listId, ing.name, ing.quantity, ing.category || 'Sonstiges', ing.meal_id);
        markDone.run(ing.id);
        count++;
      }
      return count;
    });

    res.json({ data: { transferred } });
  } catch (err) {
    log.error('POST /week-to-shopping-list', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
