/**
 * Modul: Inventar – Ruckrichtung Buchung -> Gegenstaende
 * Zweck: GET /inventory/entries/:entryId/items, fuer eine kuenftige
 *        Budget-Seiten-Integration (noch nicht verdrahtet - siehe
 *        docs/superpowers/specs/2026-08-09-inventory-stage3-entries-design.md
 *        §3). Eigenes Router-File, weil der Pfad unter einem anderen
 *        Top-Level-Segment liegt (/inventory/entries, nicht /inventory/items).
 */

import express from 'express';
import * as db from '../../db.js';
import { createLogger } from '../../logger.js';
import { id as idParam } from '../../middleware/validate.js';
import { budgetViewer, visibleEntry } from './entry-links.js';

const log = createLogger('Inventory');
const router = express.Router();

// --------------------------------------------------------
// GET /api/v1/inventory/entries/:entryId/items
// --------------------------------------------------------
router.get('/:entryId/items', (req, res) => {
  try {
    const vEntryId = idParam(req.params.entryId, 'Buchung-ID');
    if (vEntryId.error) return res.status(400).json({ error: vEntryId.error, code: 400 });
    const entry = visibleEntry(vEntryId.value, budgetViewer(req));
    if (!entry) return res.status(404).json({ error: 'Booking not found.', code: 404 });

    const items = db.get().prepare(`
      SELECT ii.id, ii.name, iie.role
      FROM inventory_item_entries iie
      JOIN inventory_items ii ON ii.id = iie.item_id
      WHERE iie.entry_id = ?
      ORDER BY ii.name COLLATE NOCASE ASC
    `).all(vEntryId.value);

    res.json({ data: items });
  } catch (err) {
    log.error('GET /:entryId/items error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
