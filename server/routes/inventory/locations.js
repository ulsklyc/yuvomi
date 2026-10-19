/**
 * Modul: Inventar – Lagerorte
 * Zweck: Zwei-Ebenen-Hierarchie (Ort, Unterort), wiederverwendet ueber dieselbe
 *        yuvomi-category-manager-Komponente wie Budget-Kategorien/-Unterkategorien.
 *        Der Pfad-Abschnitt "/subcategories" ist in der Komponente fest verdrahtet
 *        (public/components/category-manager.js) - hier bewusst NICHT auf
 *        "/sublocations" umbenannt, auch wenn das besser passen wuerde.
 *
 * Loeschsemantik wie Vorrats-Lagerorte, NICHT wie Budget-Kategorien: Loeschen ist
 * nie blockiert. Gegenstaende und Unterorte werden ortlos/elternlos (ON DELETE
 * SET NULL), nicht auf einen Ersatzort verschoben.
 *
 * Kein Umhaengen zwischen Eltern in dieser API (wie bei Budget-Unterkategorien
 * auch) - nur Anlegen/Umbenennen/Loeschen/Umsortieren. Ohne Umhaengen kann
 * parent_id nie einen Zyklus bilden.
 */

import express from 'express';
import * as db from '../../db.js';
import { createLogger } from '../../logger.js';
import { str, MAX_SHORT } from '../../middleware/validate.js';

const log = createLogger('Inventory');
const router = express.Router();

function loadTree() {
  const roots = db.get().prepare(`
    SELECT * FROM inventory_locations WHERE parent_id IS NULL
    ORDER BY sort_order ASC, name COLLATE NOCASE ASC
  `).all();
  const children = db.get().prepare(`
    SELECT * FROM inventory_locations WHERE parent_id IS NOT NULL
    ORDER BY sort_order ASC, name COLLATE NOCASE ASC
  `).all();
  return roots.map((root) => ({
    ...root,
    subcategories: children.filter((c) => c.parent_id === root.id),
  }));
}

// --------------------------------------------------------
// GET /api/v1/inventory/locations
// --------------------------------------------------------
router.get('/', (_req, res) => {
  try {
    res.json({ data: loadTree() });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/inventory/locations   Body: { name, icon? }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT id FROM inventory_locations WHERE parent_id IS NULL AND name = ? COLLATE NOCASE
    `).get(vName.value);
    if (conflict) return res.status(409).json({ error: 'Location already exists.', code: 409, reason: 'inventory_location_exists' });

    const vIcon = str(req.body.icon, 'Icon', { max: MAX_SHORT, required: false });
    if (vIcon.error) return res.status(400).json({ error: vIcon.error, code: 400 });

    const maxOrder = db.get().prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS m FROM inventory_locations WHERE parent_id IS NULL
    `).get().m;

    const result = db.get().prepare(`
      INSERT INTO inventory_locations (name, icon, sort_order) VALUES (?, ?, ?)
    `).run(vName.value, vIcon.value ?? 'package', maxOrder + 1);

    res.status(201).json({
      data: db.get().prepare('SELECT * FROM inventory_locations WHERE id = ?').get(result.lastInsertRowid),
    });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/inventory/locations/:id   Body: { name?, icon? }
// --------------------------------------------------------
router.put('/:id', (req, res) => {
  try {
    const loc = db.get().prepare('SELECT * FROM inventory_locations WHERE id = ?').get(req.params.id);
    if (!loc) return res.status(404).json({ error: 'Location not found.', code: 404, reason: 'inventory_location_not_found' });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
    const vIcon = str(req.body.icon, 'Icon', { max: MAX_SHORT, required: false });
    if (vIcon.error) return res.status(400).json({ error: vIcon.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT id FROM inventory_locations
      WHERE (parent_id IS ?) AND name = ? COLLATE NOCASE AND id != ?
    `).get(loc.parent_id, vName.value, loc.id);
    if (conflict) return res.status(409).json({ error: 'Location already exists.', code: 409, reason: 'inventory_location_exists' });

    db.get().prepare('UPDATE inventory_locations SET name = ?, icon = ? WHERE id = ?')
      .run(vName.value, vIcon.value ?? loc.icon, loc.id);

    res.json({ data: db.get().prepare('SELECT * FROM inventory_locations WHERE id = ?').get(loc.id) });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/inventory/locations/:id
// Nie blockiert. Response: { ok: true, orphanedItems, orphanedChildren }
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const loc = db.get().prepare('SELECT * FROM inventory_locations WHERE id = ?').get(req.params.id);
    if (!loc) return res.status(404).json({ error: 'Location not found.', code: 404, reason: 'inventory_location_not_found' });

    const orphanedItems = db.get().prepare('SELECT COUNT(*) AS c FROM inventory_items WHERE location_id = ?').get(loc.id).c;
    const orphanedChildren = db.get().prepare('SELECT COUNT(*) AS c FROM inventory_locations WHERE parent_id = ?').get(loc.id).c;

    db.get().prepare('DELETE FROM inventory_locations WHERE id = ?').run(loc.id);

    res.json({ ok: true, orphanedItems, orphanedChildren });
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/inventory/locations/reorder   Body: { order: number[] }  (Top-Ebene)
// --------------------------------------------------------
router.patch('/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    if (!order.length) return res.status(400).json({ error: 'order must be a non-empty array of IDs.', code: 400 });
    const update = db.get().prepare('UPDATE inventory_locations SET sort_order = ? WHERE id = ? AND parent_id IS NULL');
    db.get().transaction(() => { order.forEach((id, i) => update.run(i, id)); })();
    res.json({ data: loadTree() });
  } catch (err) {
    log.error('PATCH /reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/inventory/locations/:parentId/subcategories   Body: { name, icon? }
// (Pfadname "subcategories" ist in der geteilten Komponente fest verdrahtet.)
// --------------------------------------------------------
router.post('/:parentId/subcategories', (req, res) => {
  try {
    const parent = db.get().prepare('SELECT * FROM inventory_locations WHERE id = ? AND parent_id IS NULL').get(req.params.parentId);
    if (!parent) return res.status(404).json({ error: 'Location not found.', code: 404, reason: 'inventory_location_not_found' });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT id FROM inventory_locations WHERE parent_id = ? AND name = ? COLLATE NOCASE
    `).get(parent.id, vName.value);
    if (conflict) return res.status(409).json({ error: 'Location already exists.', code: 409, reason: 'inventory_location_exists' });

    const vIcon = str(req.body.icon, 'Icon', { max: MAX_SHORT, required: false });
    if (vIcon.error) return res.status(400).json({ error: vIcon.error, code: 400 });

    const maxOrder = db.get().prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS m FROM inventory_locations WHERE parent_id = ?
    `).get(parent.id).m;

    const result = db.get().prepare(`
      INSERT INTO inventory_locations (name, icon, sort_order, parent_id) VALUES (?, ?, ?, ?)
    `).run(vName.value, vIcon.value ?? 'package', maxOrder + 1, parent.id);

    res.status(201).json({
      data: db.get().prepare('SELECT * FROM inventory_locations WHERE id = ?').get(result.lastInsertRowid),
    });
  } catch (err) {
    log.error('POST /:parentId/subcategories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/inventory/locations/:parentId/subcategories/:id
// --------------------------------------------------------
router.put('/:parentId/subcategories/:id', (req, res) => {
  try {
    const loc = db.get().prepare('SELECT * FROM inventory_locations WHERE id = ? AND parent_id = ?')
      .get(req.params.id, req.params.parentId);
    if (!loc) return res.status(404).json({ error: 'Location not found.', code: 404, reason: 'inventory_location_not_found' });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
    const vIcon = str(req.body.icon, 'Icon', { max: MAX_SHORT, required: false });
    if (vIcon.error) return res.status(400).json({ error: vIcon.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT id FROM inventory_locations WHERE parent_id = ? AND name = ? COLLATE NOCASE AND id != ?
    `).get(loc.parent_id, vName.value, loc.id);
    if (conflict) return res.status(409).json({ error: 'Location already exists.', code: 409, reason: 'inventory_location_exists' });

    db.get().prepare('UPDATE inventory_locations SET name = ?, icon = ? WHERE id = ?')
      .run(vName.value, vIcon.value ?? loc.icon, loc.id);

    res.json({ data: db.get().prepare('SELECT * FROM inventory_locations WHERE id = ?').get(loc.id) });
  } catch (err) {
    log.error('PUT sublocation error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/inventory/locations/:parentId/subcategories/:id
// --------------------------------------------------------
router.delete('/:parentId/subcategories/:id', (req, res) => {
  try {
    const loc = db.get().prepare('SELECT * FROM inventory_locations WHERE id = ? AND parent_id = ?')
      .get(req.params.id, req.params.parentId);
    if (!loc) return res.status(404).json({ error: 'Location not found.', code: 404, reason: 'inventory_location_not_found' });

    const orphanedItems = db.get().prepare('SELECT COUNT(*) AS c FROM inventory_items WHERE location_id = ?').get(loc.id).c;
    db.get().prepare('DELETE FROM inventory_locations WHERE id = ?').run(loc.id);

    res.json({ ok: true, orphanedItems });
  } catch (err) {
    log.error('DELETE sublocation error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/inventory/locations/:parentId/subcategories/reorder   Body: { order: number[] }
// --------------------------------------------------------
router.patch('/:parentId/subcategories/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const update = db.get().prepare('UPDATE inventory_locations SET sort_order = ? WHERE id = ? AND parent_id = ?');
    db.get().transaction(() => {
      order.forEach((id, i) => update.run(i, id, req.params.parentId));
    })();
    res.json({ data: true });
  } catch (err) {
    log.error('PATCH sublocation reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
