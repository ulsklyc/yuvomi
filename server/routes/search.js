/**
 * Modul: Globale Suche (Search)
 * Zweck: Volltext-Suche über Aufgaben, Kalender-Events, Notizen, Kontakte und Einkaufsartikel.
 *        Nutzt den FTS5-Index `search_index` (Migration 44) statt LIKE '%q%'-Scans.
 * Abhängigkeiten: express, server/db.js, server/services/search.js
 */

import express from 'express';
import * as db from '../db.js';
import { runSearch } from '../services/search.js';

const router = express.Router();

/**
 * GET /api/v1/search?q=<query>
 * Durchsucht Aufgaben, Kalender-Events, Notizen, Kontakte und Einkaufsartikel.
 * Response: { tasks: Task[], events: Event[], notes: Note[], contacts: Contact[], items: Item[] }
 */
router.get('/', (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ tasks: [], events: [], notes: [], contacts: [], items: [] });

    const userId = req.session.userId;
    res.json(runSearch(db.get(), q, userId));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
