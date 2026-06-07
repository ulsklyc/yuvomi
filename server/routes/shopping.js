/**
 * Modul: Einkaufslisten (Shopping)
 * Zweck: REST-API-Routen für Einkaufslisten, Artikel, Kategorien, Autocomplete
 * Abhängigkeiten: express, server/db.js
 *
 * Routen-Reihenfolge: Statische Pfade (/suggestions, /categories, /items/:id) müssen
 * vor dynamischen (/:listId) registriert sein, damit Express korrekt matcht.
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, num, collectErrors, MAX_TITLE, MAX_SHORT } from '../middleware/validate.js';

const log = createLogger('Shopping');

const router  = express.Router();

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

/** Alle Kategorien aus DB laden (nach sort_order sortiert). */
function loadCategories() {
  return db.get().prepare('SELECT * FROM shopping_categories ORDER BY sort_order ASC').all();
}

/** Kategorie-Namen-Array für Validierung. */
function validCategoryNames() {
  return loadCategories().map((c) => c.name);
}

// --------------------------------------------------------
// GET /api/v1/shopping/categories
// Alle Kategorien zurückgeben.
// Response: { data: ShoppingCategory[] }
// --------------------------------------------------------
router.get('/categories', (_req, res) => {
  try {
    res.json({ data: loadCategories() });
  } catch (err) {
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/categories
// Neue Kategorie erstellen.
// Body: { name }
// Response: { data: ShoppingCategory }
// --------------------------------------------------------
router.post('/categories', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const existing = db.get()
      .prepare('SELECT id FROM shopping_categories WHERE name = ? COLLATE NOCASE')
      .get(vName.value);
    if (existing) return res.status(409).json({ error: 'Category already exists.', code: 409 });

    const maxOrder = db.get()
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM shopping_categories')
      .get().m;

    const result = db.get()
      .prepare('INSERT INTO shopping_categories (name, icon, sort_order) VALUES (?, ?, ?)')
      .run(vName.value, 'tag', maxOrder + 1);

    const cat = db.get()
      .prepare('SELECT * FROM shopping_categories WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json({ data: cat });
  } catch (err) {
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/shopping/categories/:catId
// Kategorie umbenennen.
// Body: { name }
// Response: { data: ShoppingCategory }
// --------------------------------------------------------
router.put('/categories/:catId', (req, res) => {
  try {
    const cat = db.get()
      .prepare('SELECT * FROM shopping_categories WHERE id = ?')
      .get(req.params.catId);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get()
      .prepare('SELECT id FROM shopping_categories WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(vName.value, cat.id);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409 });

    // Artikel, die die alte Kategorie nutzen, mitumbenennen
    db.get().transaction(() => {
      db.get()
        .prepare('UPDATE shopping_items SET category = ? WHERE category = ?')
        .run(vName.value, cat.name);
      db.get()
        .prepare('UPDATE shopping_categories SET name = ? WHERE id = ?')
        .run(vName.value, cat.id);
    })();

    const updated = db.get()
      .prepare('SELECT * FROM shopping_categories WHERE id = ?')
      .get(cat.id);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /categories/:catId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/shopping/categories/:catId
// Kategorie löschen (Artikel werden zu "Sonstiges" verschoben).
// Die letzte verbleibende Kategorie kann nicht gelöscht werden.
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/categories/:catId', (req, res) => {
  try {
    const cat = db.get()
      .prepare('SELECT * FROM shopping_categories WHERE id = ?')
      .get(req.params.catId);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const total = db.get()
      .prepare('SELECT COUNT(*) AS c FROM shopping_categories')
      .get().c;
    if (total <= 1) return res.status(400).json({ error: 'The last category cannot be deleted.', code: 400 });

    // Fallback-Kategorie: erste andere Kategorie nach sort_order
    const fallback = db.get()
      .prepare('SELECT name FROM shopping_categories WHERE id != ? ORDER BY sort_order ASC LIMIT 1')
      .get(cat.id);

    db.get().transaction(() => {
      db.get()
        .prepare('UPDATE shopping_items SET category = ? WHERE category = ?')
        .run(fallback.name, cat.name);
      db.get()
        .prepare('DELETE FROM shopping_categories WHERE id = ?')
        .run(cat.id);
    })();

    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE /categories/:catId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/shopping/categories/reorder
// Reihenfolge der Kategorien ändern.
// Body: { order: number[] }  (Array von IDs in gewünschter Reihenfolge)
// Response: { data: ShoppingCategory[] }
// --------------------------------------------------------
router.patch('/categories/reorder', (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0)
      return res.status(400).json({ error: 'order muss ein nicht-leeres Array von IDs sein.', code: 400 });

    const update = db.get().prepare('UPDATE shopping_categories SET sort_order = ? WHERE id = ?');
    db.get().transaction(() => {
      order.forEach((id, idx) => update.run(idx, id));
    })();

    res.json({ data: loadCategories() });
  } catch (err) {
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/shopping/suggestions?q=…
// Autocomplete-Vorschläge aus bisherigen Artikelnamen.
// Response: { data: string[] }
// --------------------------------------------------------
router.get('/suggestions', (req, res) => {
  try {
    const q = (req.query.q ?? '').trim();
    if (q.length < 1) return res.json({ data: [] });

    const rows = db.get().prepare(`
      SELECT DISTINCT name FROM shopping_items
      WHERE name LIKE ? COLLATE NOCASE
      ORDER BY name ASC
      LIMIT 8
    `).all(`${q}%`);

    res.json({ data: rows.map((r) => r.name) });
  } catch (err) {
    log.error('suggestions error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/shopping/items/:itemId
// Artikel aktualisieren (is_checked, name, quantity, category).
// Body: { is_checked?, name?, quantity?, category? }
// Response: { data: ShoppingItem }
// --------------------------------------------------------
router.patch('/items/:itemId', (req, res) => {
  try {
    const item = db.get()
      .prepare('SELECT * FROM shopping_items WHERE id = ?')
      .get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const {
      is_checked = item.is_checked,
      name       = item.name,
      quantity   = item.quantity,
      category   = item.category,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'name darf nicht leer sein.', code: 400 });

    const validNames = validCategoryNames();
    if (category && !validNames.includes(category))
      return res.status(400).json({ error: 'Invalid category.', code: 400 });

    db.get().prepare(`
      UPDATE shopping_items
      SET is_checked = ?, name = ?, quantity = ?, category = ?
      WHERE id = ?
    `).run(is_checked ? 1 : 0, name.trim(), quantity ?? null, category, req.params.itemId);

    const updated = db.get()
      .prepare('SELECT * FROM shopping_items WHERE id = ?')
      .get(req.params.itemId);
    res.json({ data: updated });
  } catch (err) {
    log.error('PATCH items/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/shopping/items/:itemId
// Einzelnen Artikel löschen.
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/items/:itemId', (req, res) => {
  try {
    const result = db.get()
      .prepare('DELETE FROM shopping_items WHERE id = ?')
      .run(req.params.itemId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Item not found.', code: 404 });
    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE items/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/shopping
// Alle Einkaufslisten mit Artikel-Zähler.
// Response: { data: ShoppingList[] }
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const lists = db.get().prepare(`
      SELECT
        sl.*,
        COUNT(si.id)                                          AS item_total,
        SUM(CASE WHEN si.is_checked = 1 THEN 1 ELSE 0 END)   AS item_checked
      FROM shopping_lists sl
      LEFT JOIN shopping_items si ON si.list_id = sl.id
      GROUP BY sl.id
      ORDER BY sl.created_at ASC
    `).all();
    res.json({ data: lists });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping
// Neue Einkaufsliste erstellen.
// Body: { name }
// Response: { data: ShoppingList }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const result = db.get()
      .prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
      .run(vName.value, req.authUserId || req.session.userId);

    const list = db.get()
      .prepare('SELECT * FROM shopping_lists WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json({ data: list });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/shopping/:listId
// Einkaufsliste umbenennen.
// Body: { name }
// Response: { data: ShoppingList }
// --------------------------------------------------------
router.put('/:listId', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const result = db.get()
      .prepare('UPDATE shopping_lists SET name = ? WHERE id = ?')
      .run(vName.value, req.params.listId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'List not found.', code: 404 });

    const list = db.get()
      .prepare('SELECT * FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    res.json({ data: list });
  } catch (err) {
    log.error('PUT /:listId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/shopping/:listId
// Liste und alle Artikel löschen (CASCADE).
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/:listId', (req, res) => {
  try {
    const result = db.get()
      .prepare('DELETE FROM shopping_lists WHERE id = ?')
      .run(req.params.listId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'List not found.', code: 404 });
    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE /:listId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/shopping/:listId/items
// Alle Artikel einer Liste, sortiert nach Supermarkt-Gang-Logik.
// Abgehakte Artikel ans Ende innerhalb ihrer Kategorie.
// Response: { data: ShoppingItem[], list: ShoppingList, categories: ShoppingCategory[] }
// --------------------------------------------------------
router.get('/:listId/items', (req, res) => {
  try {
    const list = db.get()
      .prepare('SELECT * FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const categories = loadCategories();
    const categoryOrder = categories.map((c, i) => `WHEN '${c.name.replace(/'/g, "''")}' THEN ${i}`).join(' ');

    const items = db.get().prepare(`
      SELECT * FROM shopping_items
      WHERE list_id = ?
      ORDER BY
        CASE category ${categoryOrder} ELSE ${categories.length} END,
        is_checked ASC,
        created_at ASC
    `).all(req.params.listId);

    res.json({ data: items, list, categories });
  } catch (err) {
    log.error('GET /:listId/items error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/shopping/:listId/items
// Artikel zur Liste hinzufügen.
// Body: { name, quantity?, category? }
// Response: { data: ShoppingItem }
// --------------------------------------------------------
router.post('/:listId/items', (req, res) => {
  try {
    const list = db.get()
      .prepare('SELECT id FROM shopping_lists WHERE id = ?')
      .get(req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.', code: 404 });

    const validNames = validCategoryNames();
    const defaultCat = validNames[0] ?? 'Sonstiges';
    const requestedCat = req.body.category || defaultCat;

    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vQty  = str(req.body.quantity, 'Menge', { max: MAX_SHORT, required: false });
    const vCat  = oneOf(requestedCat, validNames, 'Kategorie');
    const errors = collectErrors([vName, vQty, vCat]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO shopping_items (list_id, name, quantity, category)
      VALUES (?, ?, ?, ?)
    `).run(req.params.listId, vName.value, vQty.value, vCat.value || defaultCat);

    const item = db.get()
      .prepare('SELECT * FROM shopping_items WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json({ data: item });
  } catch (err) {
    log.error('POST /:listId/items error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/shopping/:listId/items/checked
// Alle abgehakten Artikel aus einer Liste löschen.
// Response: { deleted: number }
// --------------------------------------------------------
router.delete('/:listId/items/checked', (req, res) => {
  try {
    const result = db.get().prepare(`
      DELETE FROM shopping_items WHERE list_id = ? AND is_checked = 1
    `).run(req.params.listId);
    res.json({ deleted: result.changes });
  } catch (err) {
    log.error('DELETE /:listId/items/checked error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
