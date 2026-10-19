/**
 * Modul: Inventar – Kategorien
 * Zweck: Verwaltbare Kategorie-Liste (statt fester Code-Liste), exaktes Vorbild
 *        Budget-Kategorien: eigene Tabelle, Key-Identitaet, Reihenfolge, geteilte
 *        yuvomi-category-manager-Komponente ohne Unterkategorien-Modus.
 *
 * 'other' ist der garantierte Rueckfallwert fuer inventory_items.category (siehe
 * server/routes/inventory/items.js) und kann deshalb nicht geloescht werden - eine
 * andere Regel als bei Vorrats-/Einkaufs-Kategorien ("die letzte verbleibende"),
 * bewusst so, weil 'other' als Ziel des Umhaengens immer existieren muss.
 */

import express from 'express';
import * as db from '../../db.js';
import { createLogger } from '../../logger.js';
import { str, MAX_SHORT } from '../../middleware/validate.js';
import { uniqueKey } from './helpers.js';

const log = createLogger('Inventory');
const router = express.Router();

const PROTECTED_KEY = 'other';

function loadCategories() {
  return db.get().prepare('SELECT * FROM inventory_categories ORDER BY sort_order ASC, COALESCE(name, key) COLLATE NOCASE ASC').all();
}

// --------------------------------------------------------
// GET /api/v1/inventory/categories
// --------------------------------------------------------
router.get('/', (_req, res) => {
  try {
    res.json({ data: loadCategories() });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/inventory/categories   Body: { name, icon? }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare('SELECT id FROM inventory_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE').get(vName.value);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    const vIcon = str(req.body.icon, 'Icon', { max: MAX_SHORT, required: false });
    if (vIcon.error) return res.status(400).json({ error: vIcon.error, code: 400 });

    const maxOrder = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM inventory_categories').get().m;
    const key = uniqueKey('inventory_categories', vName.value);

    db.get().prepare(`
      INSERT INTO inventory_categories (key, name, icon, sort_order) VALUES (?, ?, ?, ?)
    `).run(key, vName.value, vIcon.value ?? 'package', maxOrder + 1);

    res.status(201).json({ data: db.get().prepare('SELECT * FROM inventory_categories WHERE key = ?').get(key) });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/inventory/categories/:key   Body: { name?, icon? }
// --------------------------------------------------------
router.put('/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM inventory_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404, reason: 'inventory_category_not_found' });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
    const vIcon = str(req.body.icon, 'Icon', { max: MAX_SHORT, required: false });
    if (vIcon.error) return res.status(400).json({ error: vIcon.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT id FROM inventory_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE AND key != ?
    `).get(vName.value, cat.key);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    // Umbenennen macht eine Seed-Kategorie effektiv custom: label_key faellt weg,
    // sonst ueberschriebe der naechste Sprachwechsel den getippten Namen wieder
    // mit der Uebersetzung (gleiches Muster wie server/routes/tasks.js).
    db.get().prepare('UPDATE inventory_categories SET name = ?, icon = ?, label_key = NULL WHERE key = ?')
      .run(vName.value, vIcon.value ?? cat.icon, cat.key);

    res.json({ data: db.get().prepare('SELECT * FROM inventory_categories WHERE key = ?').get(cat.key) });
  } catch (err) {
    log.error('PUT /:key error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/inventory/categories/:key
// 'other' ist geschuetzt. Betroffene Gegenstaende fallen auf 'other' zurueck.
// Response: { ok: true, reassigned: number }
// --------------------------------------------------------
router.delete('/:key', (req, res) => {
  try {
    if (req.params.key === PROTECTED_KEY) {
      return res.status(400).json({ error: "The 'other' category cannot be deleted.", code: 400 });
    }
    const cat = db.get().prepare('SELECT * FROM inventory_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404, reason: 'inventory_category_not_found' });

    const result = db.get().transaction(() => {
      const reassigned = db.get()
        .prepare("UPDATE inventory_items SET category = 'other' WHERE category = ?")
        .run(cat.key).changes;
      db.get().prepare('DELETE FROM inventory_categories WHERE key = ?').run(cat.key);
      return { reassigned };
    })();

    res.json({ ok: true, reassigned: result.reassigned });
  } catch (err) {
    log.error('DELETE /:key error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/inventory/categories/reorder   Body: { order: string[] }  (Keys)
// --------------------------------------------------------
router.patch('/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    if (!order.length) return res.status(400).json({ error: 'order must be a non-empty array of keys.', code: 400 });

    // Jeder Key muss existieren, sonst liefert stmt.get(key) weiter unten
    // undefined -> null in der JSON-Antwort (stale Client, Tippfehler, Race mit
    // gleichzeitigem Loeschen). Vorab pruefen und bei Luecken gar nichts
    // anwenden, statt eine teilweise Umsortierung durchzufuehren.
    const existsStmt = db.get().prepare('SELECT 1 FROM inventory_categories WHERE key = ?');
    const unknown = order.filter((key) => !existsStmt.get(key));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown category key(s): ${unknown.join(', ')}.`, code: 400 });
    }

    const update = db.get().prepare('UPDATE inventory_categories SET sort_order = ? WHERE key = ?');
    db.get().transaction(() => { order.forEach((key, i) => update.run(i, key)); })();
    // Return categories in the specified order
    const stmt = db.get().prepare('SELECT * FROM inventory_categories WHERE key = ?');
    const result = order.map(key => stmt.get(key));
    res.json({ data: result });
  } catch (err) {
    log.error('PATCH /reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
