/**
 * Modul: Zyklus-Feed — Verwaltung
 * Zweck: Status/Regenerieren/Deaktivieren des Feed-Tokens. Der eigentliche
 *        ICS-Inhalt wird unauthentifiziert außerhalb von /api/v1 ausgeliefert
 *        (siehe server/index.js), spiegelt server/routes/inventory/deadlines-feed.js.
 *
 * Kein Betreuungs-Zugriff (anders als der Rest des Cycle-Routers erlaubt es
 * für andere Betreuung-relevante Felder gar nicht erst): der Feed ist "mein
 * eigener Kalender-Link", genau wie viewerId() ihn überall sonst in cycle.js
 * für den Zyklus-Tab selbst durchsetzt (siehe helpers.js-Dokblock: "Der
 * Zyklus-Tab ist von der Betreuung ausgenommen").
 */

import express from 'express';
import * as db from '../../db.js';
import { viewerId } from './helpers.js';
import * as cycleIcs from '../../services/cycle-ics.js';
import { validateRequest } from '../../api/validate-request.ts';

const router = express.Router();

function feedUrl(req, token) {
  const base = process.env.BASE_URL?.replace(/\/+$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/cycle/${token}.ics`;
}

// GET /api/v1/health/cycle/feed → eigener Feed-Status
router.get('/cycle/feed', validateRequest(), (req, res) => {
  const token = cycleIcs.getFeedToken(db.get(), viewerId(req));
  if (!token) return res.json({ data: null });
  res.json({ data: { token, url: feedUrl(req, token) } });
});

// POST /api/v1/health/cycle/feed/regenerate → eigenen Token neu erzeugen
router.post('/cycle/feed/regenerate', validateRequest(), (req, res) => {
  const token = cycleIcs.regenerateFeedToken(db.get(), viewerId(req));
  res.json({ data: { token, url: feedUrl(req, token) } });
});

// DELETE /api/v1/health/cycle/feed → eigenen Feed deaktivieren
router.delete('/cycle/feed', validateRequest(), (req, res) => {
  cycleIcs.clearFeedToken(db.get(), viewerId(req));
  res.json({ data: { token: null } });
});

export default router;
