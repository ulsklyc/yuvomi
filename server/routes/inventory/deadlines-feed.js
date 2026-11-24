/**
 * Modul: Inventar-Fristen-Feed — Verwaltung
 * Zweck: Status/Regenerieren/Deaktivieren des Feed-Tokens. Der eigentliche
 *        ICS-Inhalt wird unauthentifiziert außerhalb von /api/v1 ausgeliefert
 *        (siehe server/index.js), spiegelt server/routes/calendar/feed.js.
 *
 * Keine Admin-Gate, ebenfalls wie server/routes/calendar/feed.js: das Token
 * hängt an der eigenen users-Zeile, jeder angemeldete Nutzer verwaltet nur sein
 * eigenes. Genau das ist der Zweck des personengebundenen Tokens - ein Abo
 * einzeln zurückziehen zu können, statt es allen gleichzeitig zu nehmen. Ein
 * Modul-Gate wäre hier ohnehin die falsche Ebene: /api/v1 kennt für Sessions
 * keine Modulrechte (nur API-Token tragen Scopes), GET /api/v1/inventory/items
 * steht jedem Mitglied genauso offen.
 */

import express from 'express';
import * as db from '../../db.js';
import * as deadlinesIcs from '../../services/inventory-deadlines-ics.js';
import { validateRequest } from '../../api/validate-request.ts';

const router = express.Router();

// Kein try/catch je Route: ein unerwarteter Fehler (SQLite) geht an den
// zentralen Fehlerhandler (server/middleware/error-handler.js). Der loggt ihn
// mit Methode und Routenmuster und antwortet 500 mit dem festen Satz.

// Gleiche Auflösung wie server/routes/calendar/helpers.js#getUserId; hier lokal
// gehalten statt quer aus dem Kalender-Modul importiert, wie schon feedUrl.
// requireAuth (server/index.js) hängt vor /api/v1, eine Session ist also sicher.
function getUserId(req) {
  const candidates = [req.authUserId, req.user?.id, req.session?.userId];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function feedUrl(req, token) {
  const base = process.env.BASE_URL?.replace(/\/+$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/inventory-deadlines/${token}.ics`;
}

// GET /api/v1/inventory/deadlines-feed → eigener Feed-Status
router.get('/', validateRequest(), (req, res) => {
  const token = deadlinesIcs.getFeedToken(db.get(), getUserId(req));
  if (!token) return res.json({ data: null });
  res.json({ data: { token, url: feedUrl(req, token) } });
});

// POST /api/v1/inventory/deadlines-feed/regenerate → eigenen Token neu erzeugen
router.post('/regenerate', validateRequest(), (req, res) => {
  const token = deadlinesIcs.regenerateFeedToken(db.get(), getUserId(req));
  res.json({ data: { token, url: feedUrl(req, token) } });
});

// DELETE /api/v1/inventory/deadlines-feed → eigenen Feed deaktivieren
router.delete('/', validateRequest(), (req, res) => {
  deadlinesIcs.clearFeedToken(db.get(), getUserId(req));
  res.json({ data: { token: null } });
});

export default router;
