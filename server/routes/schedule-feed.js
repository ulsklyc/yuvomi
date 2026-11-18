/**
 * Modul: Schichtplan-Feed — Verwaltung
 * Zweck: Status/Regenerieren/Deaktivieren des Feed-Tokens. Der eigentliche
 *        ICS-Inhalt wird unauthentifiziert außerhalb von /api/v1 ausgeliefert
 *        (siehe server/index.js), spiegelt server/routes/inventory/deadlines-feed.js.
 *        Ein unerwarteter Fehler geht an den zentralen Fehlerhandler (#2810).
 *
 * Eigene Datei statt in routes/schedule.js: server/services/schedule-ics.js
 * importiert scheduleData aus routes/schedule.js für den Feed-Inhalt - ein
 * Rückimport hier hätte einen Zyklus ergeben.
 *
 * Keine Admin-Gate, wie schon der Inventar-Feed: das Token hängt an der
 * eigenen users-Zeile, jeder angemeldete Nutzer verwaltet nur sein eigenes.
 */

import express from 'express';
import { validateRequest } from '../api/validate-request.ts';
import * as db from '../db.js';
import * as scheduleIcs from '../services/schedule-ics.js';

const router = express.Router();

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
  return `${base}/feed/schedule/${token}.ics`;
}

// GET /api/v1/schedule/feed → eigener Feed-Status
router.get('/', validateRequest(), (req, res) => {
  const token = scheduleIcs.getFeedToken(db.get(), getUserId(req));
  if (!token) return res.json({ data: null });
  res.json({ data: { token, url: feedUrl(req, token) } });
});

// POST /api/v1/schedule/feed/regenerate → eigenen Token neu erzeugen
router.post('/regenerate', validateRequest(), (req, res) => {
  const token = scheduleIcs.regenerateFeedToken(db.get(), getUserId(req));
  res.json({ data: { token, url: feedUrl(req, token) } });
});

// DELETE /api/v1/schedule/feed → eigenen Feed deaktivieren
router.delete('/', validateRequest(), (req, res) => {
  scheduleIcs.clearFeedToken(db.get(), getUserId(req));
  res.json({ data: { token: null } });
});

export default router;
