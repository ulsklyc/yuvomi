/**
 * Modul: Globale Suche (Search)
 * Zweck: Volltext-Suche über Aufgaben, Kalender-Events, Notizen, Kontakte,
 *        Einkaufsartikel sowie Gesundheits-Medikamente und -Aktivitäten.
 *        Nutzt den FTS5-Index `search_index` (Migration 44/66) statt LIKE '%q%'-Scans.
 * Abhängigkeiten: express, server/db.js, server/services/search.js
 */

import express from 'express';
import * as db from '../db.js';
import { runSearch, emptySearchResults, SEARCH_MODULES } from '../services/search.js';
import { hiddenModulesFor } from '../permissions.js';

const router = express.Router();

/**
 * GET /api/v1/search?q=<query>
 * Durchsucht Aufgaben, Kalender-Events, Notizen, Kontakte, Einkaufsartikel,
 * Gesundheits-Medikamente und -Aktivitäten (Health: nur eigene oder family-sichtbare Zeilen).
 * Response: { tasks, events, notes, contacts, items, meds, activities }
 *
 * Module, die dem Betrachter entzogen sind (#467), werden gar nicht erst
 * durchsucht - die Zuordnung Trefferart→Modul steht in services/search.js.
 * Hier steht sie nicht, weil die Route nur weitergibt, was die Auth-Schicht
 * ohnehin schon aufgelöst hat (`req.sessionModuleAccess`); eine zweite
 * Auflösung wäre eine zweite Wahrheit über dieselben Rechte.
 *
 * Dasselbe gilt für ein gescoptes API-Token: `search:read` öffnet die Suche,
 * nicht die Module dahinter. Eine Trefferart kommt nur, wenn das Token auch ihr
 * Modul lesen darf - sonst las ein Token mit `search:read` Notizen, Kontakte und
 * Medikamente, die seine Scopes gar nicht nennen.
 */
router.get('/', (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json(emptySearchResults());

    const userId = req.authUserId || req.session.userId;
    res.json(runSearch(db.get(), q, userId, {
      hiddenModules: hiddenModulesFor(req, SEARCH_MODULES),
    }));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
