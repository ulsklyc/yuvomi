/**
 * Modul: Rezepte (Recipes)
 * Zweck: REST-API-Routen fuer Rezept-CRUD inkl. Zutaten
 * Abhaengigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, num, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT } from '../middleware/validate.js';

const log = createLogger('Recipes');
const router = express.Router();

function loadRecipeWithIngredients(id) {
  const recipe = db.get().prepare(`
    SELECT r.*, u.display_name AS creator_name, u.avatar_color AS creator_color
    FROM recipes r
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.id = ?
  `).get(id);

  if (!recipe) return null;

  const ingredients = db.get().prepare(`
    SELECT * FROM recipe_ingredients
    WHERE recipe_id = ?
    ORDER BY id ASC
  `).all(id);

  return { ...recipe, ingredients };
}

router.get('/', (_req, res) => {
  try {
    const recipes = db.get().prepare(`
      SELECT r.*, u.display_name AS creator_name, u.avatar_color AS creator_color
      FROM recipes r
      LEFT JOIN users u ON u.id = r.created_by
      ORDER BY r.title COLLATE NOCASE ASC, r.id DESC
    `).all();

    const ids = recipes.map((r) => r.id);
    let ingredientMap = {};

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const ingredients = db.get().prepare(`
        SELECT * FROM recipe_ingredients
        WHERE recipe_id IN (${placeholders})
        ORDER BY id ASC
      `).all(...ids);

      for (const ing of ingredients) {
        if (!ingredientMap[ing.recipe_id]) ingredientMap[ing.recipe_id] = [];
        ingredientMap[ing.recipe_id].push(ing);
      }
    }

    res.json({ data: recipes.map((r) => ({ ...r, ingredients: ingredientMap[r.id] || [] })) });
  } catch (err) {
    log.error('GET / Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/', (req, res) => {
  try {
    const { ingredients = [] } = req.body;

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });

    const errors = collectErrors([vTitle, vNotes, vRecipeUrl]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const recipeId = db.transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO recipes (title, notes, recipe_url, created_by)
        VALUES (?, ?, ?, ?)
      `).run(vTitle.value, vNotes.value, vRecipeUrl.value, req.session.userId);

      const rid = Number(result.lastInsertRowid);
      const insertIng = db.get().prepare(`
        INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      for (const ing of ingredients) {
        const name = String(ing.name || '').trim().slice(0, MAX_TITLE);
        const quantity = String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null;
        const category = String(ing.category || '').trim().slice(0, MAX_SHORT) || 'Sonstiges';
        if (name) insertIng.run(rid, name, quantity, category);
      }

      return rid;
    });

    const created = loadRecipeWithIngredients(recipeId);
    res.status(201).json({ data: created });
  } catch (err) {
    log.error('POST / Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungueltige Rezept-ID', code: 400 });

    const existing = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Rezept nicht gefunden', code: 404 });

    const { ingredients = [] } = req.body;

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    const errors = collectErrors([vTitle, vNotes, vRecipeUrl]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.transaction(() => {
      db.get().prepare(`
        UPDATE recipes
        SET title = ?, notes = ?, recipe_url = ?
        WHERE id = ?
      `).run(vTitle.value, vNotes.value, vRecipeUrl.value, id);

      db.get().prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);

      const insertIng = db.get().prepare(`
        INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
        VALUES (?, ?, ?, ?)
      `);

      for (const ing of ingredients) {
        const name = String(ing.name || '').trim().slice(0, MAX_TITLE);
        const quantity = String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null;
        const category = String(ing.category || '').trim().slice(0, MAX_SHORT) || 'Sonstiges';
        if (name) insertIng.run(id, name, quantity, category);
      }
    });

    const updated = loadRecipeWithIngredients(id);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:id Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = num(id, 'Rezept-ID', { required: true });
    if (existing.error) return res.status(400).json({ error: existing.error, code: 400 });

    const result = db.get().prepare('DELETE FROM recipes WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Rezept nicht gefunden', code: 404 });

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
