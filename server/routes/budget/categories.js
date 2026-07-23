/**
 * Modul: Budget-Tracker – Kategorien & Subkategorien
 * Zweck: Meta-Liste, lokalisierte Kategorien/Subkategorien, CRUD + Reihenfolge.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { str, oneOf, collectErrors, MAX_SHORT } from '../../middleware/validate.js';
import {
  loadBudgetMeta, normalizeLang, localizedCategory, localizedSubcategory,
  uniqueKey, categoryInUseCount, subcategoryInUseCount,
  categoryCountByType, subcategoryCountForCategory,
} from './helpers.js';

const log = createLogger('Budget');
const router = express.Router();

/**
 * GET /api/v1/budget/meta
 * Kategorien-Liste für Dropdowns.
 * Response: { data: { categories } }
 */
router.get('/meta', (req, res) => {
  try {
    res.json({ data: loadBudgetMeta() });
  } catch (err) {
    log.error('GET /meta error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/categories', (req, res) => {
  try {
    const lang = normalizeLang(req.query.lang);
    const categories = db.get().prepare(`
      SELECT key, name, type, sort_order
      FROM budget_categories
      ORDER BY type DESC, sort_order ASC, name COLLATE NOCASE ASC
    `).all();
    const subRows = db.get().prepare(`
      SELECT key, category_key, name, sort_order
      FROM budget_subcategories
      ORDER BY sort_order ASC, name COLLATE NOCASE ASC
    `).all();

    res.json({
      data: categories.map((category) => ({
        ...localizedCategory(category, lang),
        subcategories: subRows
          .filter((s) => s.category_key === category.key)
          .map((s) => localizedSubcategory(s, lang)),
      })),
      lang,
    });
  } catch (err) {
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/categories/:categoryKey/subcategories', (req, res) => {
  try {
    const lang = normalizeLang(req.query.lang);
    const category = db.get().prepare(`
      SELECT key, name, type, sort_order
      FROM budget_categories
      WHERE key = ?
    `).get(req.params.categoryKey);
    if (!category) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const subcategories = db.get().prepare(`
      SELECT key, category_key, name, sort_order
      FROM budget_subcategories
      WHERE category_key = ?
      ORDER BY sort_order ASC, name COLLATE NOCASE ASC
    `).all(category.key);

    res.json({
      data: subcategories.map((subcategory) => localizedSubcategory(subcategory, lang)),
      category: localizedCategory(category, lang),
      lang,
    });
  } catch (err) {
    log.error('GET /categories/:categoryKey/subcategories error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/categories', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    const vType = oneOf(req.body.type || 'expense', ['expense', 'income'], 'Typ');
    const errors = collectErrors([vName, vType]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM budget_categories WHERE type = ? AND name = ? COLLATE NOCASE
    `).get(vType.value, vName.value);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    const maxOrder = db.get().prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS m FROM budget_categories WHERE type = ?
    `).get(vType.value).m;
    const key = uniqueKey('budget_categories', vName.value);

    db.get().prepare(`
      INSERT INTO budget_categories (key, name, type, sort_order) VALUES (?, ?, ?, ?)
    `).run(key, vName.value, vType.value, maxOrder + 1);

    const cat = db.get().prepare('SELECT key, name, type, sort_order FROM budget_categories WHERE key = ?').get(key);
    res.status(201).json({ data: cat });
  } catch (err) {
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM budget_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM budget_categories WHERE type = ? AND name = ? COLLATE NOCASE AND key != ?
    `).get(cat.type, vName.value, cat.key);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    db.get().prepare('UPDATE budget_categories SET name = ? WHERE key = ?').run(vName.value, cat.key);
    const updated = db.get().prepare('SELECT key, name, type, sort_order FROM budget_categories WHERE key = ?').get(cat.key);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /categories/:key error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM budget_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const inUse = categoryInUseCount(db.get(), cat.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Category is in use by ${inUse} entr${inUse === 1 ? 'y' : 'ies'}.`, code: 409, count: inUse, reason: 'category_in_use' });
    }
    const subcategoryCount = subcategoryCountForCategory(db.get(), cat.key);
    if (subcategoryCount > 0) {
      return res.status(409).json({ error: 'Cannot delete a category that still has subcategories.', code: 409, reason: 'category_has_subcategories' });
    }
    if (categoryCountByType(db.get(), cat.type) <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last category.', code: 409, reason: 'category_last' });
    }
    db.get().prepare('DELETE FROM budget_categories WHERE key = ?').run(cat.key);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /categories/:key error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.patch('/categories/reorder', (req, res) => {
  try {
    const vType = oneOf(req.body.type || 'expense', ['expense', 'income'], 'Typ');
    if (vType.error) return res.status(400).json({ error: vType.error, code: 400 });
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const tx = db.get().transaction((keys) => {
      keys.forEach((key, i) => {
        db.get().prepare('UPDATE budget_categories SET sort_order = ? WHERE key = ? AND type = ?').run(i, key, vType.value);
      });
    });
    tx(order);
    res.json({ data: true });
  } catch (err) {
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/categories/:categoryKey/subcategories', (req, res) => {
  try {
    const cat = db.get().prepare(`
      SELECT * FROM budget_categories WHERE key = ? AND type = 'expense'
    `).get(req.params.categoryKey);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM budget_subcategories WHERE category_key = ? AND name = ? COLLATE NOCASE
    `).get(cat.key, vName.value);
    if (conflict) return res.status(409).json({ error: 'Subcategory already exists.', code: 409, reason: 'subcategory_exists' });

    const maxOrder = db.get().prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS m FROM budget_subcategories WHERE category_key = ?
    `).get(cat.key).m;
    const key = uniqueKey('budget_subcategories', `${cat.key}_${vName.value}`);

    db.get().prepare(`
      INSERT INTO budget_subcategories (key, category_key, name, sort_order) VALUES (?, ?, ?, ?)
    `).run(key, cat.key, vName.value, maxOrder + 1);

    const sub = db.get().prepare(`
      SELECT key, category_key, name, sort_order FROM budget_subcategories WHERE key = ?
    `).get(key);
    res.status(201).json({ data: sub });
  } catch (err) {
    log.error('POST /categories/:categoryKey/subcategories error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/categories/:key/subcategories/:subKey', (req, res) => {
  try {
    const sub = db.get().prepare('SELECT * FROM budget_subcategories WHERE key = ? AND category_key = ?').get(req.params.subKey, req.params.key);
    if (!sub) return res.status(404).json({ error: 'Subcategory not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM budget_subcategories WHERE category_key = ? AND name = ? COLLATE NOCASE AND key != ?
    `).get(sub.category_key, vName.value, sub.key);
    if (conflict) return res.status(409).json({ error: 'Subcategory already exists.', code: 409, reason: 'subcategory_exists' });

    db.get().prepare('UPDATE budget_subcategories SET name = ? WHERE key = ?').run(vName.value, sub.key);
    const updated = db.get().prepare('SELECT key, category_key, name, sort_order FROM budget_subcategories WHERE key = ?').get(sub.key);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT subcategory error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/categories/:key/subcategories/:subKey', (req, res) => {
  try {
    const sub = db.get().prepare('SELECT * FROM budget_subcategories WHERE key = ? AND category_key = ?').get(req.params.subKey, req.params.key);
    if (!sub) return res.status(404).json({ error: 'Subcategory not found.', code: 404 });

    const inUse = subcategoryInUseCount(db.get(), sub.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Subcategory is in use by ${inUse} entr${inUse === 1 ? 'y' : 'ies'}.`, code: 409, count: inUse, reason: 'subcategory_in_use' });
    }
    if (subcategoryCountForCategory(db.get(), sub.category_key) <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last subcategory.', code: 409, reason: 'subcategory_last' });
    }
    db.get().prepare('DELETE FROM budget_subcategories WHERE key = ?').run(sub.key);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE subcategory error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.patch('/categories/:key/subcategories/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const tx = db.get().transaction((keys) => {
      keys.forEach((key, i) => {
        db.get().prepare('UPDATE budget_subcategories SET sort_order = ? WHERE key = ? AND category_key = ?').run(i, key, req.params.key);
      });
    });
    tx(order);
    res.json({ data: true });
  } catch (err) {
    log.error('PATCH subcategory reorder error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
