/**
 * Module: Waste collection feed - management
 * Purpose: status/regenerate/revoke of the feed token plus the optional
 *          per-type selection. The ICS content itself is served
 *          unauthenticated outside /api/v1 (see server/index.js), mirroring
 *          server/routes/inventory/deadlines-feed.js. An unexpected error
 *          reaches the central error handler (#2810).
 *
 * No admin/module gate, same reasoning as the inventory deadlines feed: the
 * token hangs off the caller's own users row, so every member manages only
 * their own subscription. GET /api/v1/waste/types is already open to any
 * member regardless of module access level, so gating the feed more tightly
 * than the data it feeds from would be the wrong layer.
 */

import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as db from '../../db.js';
import * as wasteIcs from '../../services/waste-ics.js';
import * as store from '../../services/waste-store.js';
import { currentUserId } from './helpers.js';

const router = express.Router();

function feedUrl(req, token) {
  const base = process.env.BASE_URL?.replace(/\/+$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/waste/${token}.ics`;
}

function feedStatus(req, userId) {
  const token = wasteIcs.getFeedToken(db.get(), userId);
  if (!token) return null;
  return { token, url: feedUrl(req, token), type_ids: wasteIcs.getFeedTypeIds(db.get(), userId) };
}

// GET /api/v1/waste/feed -> own feed status (null if never enabled)
router.get('/', validateRequest(), (req, res) => {
  res.json({ data: feedStatus(req, currentUserId(req)) });
});

// POST /api/v1/waste/feed/regenerate -> issue a new token (keeps the type selection)
router.post('/regenerate', validateRequest(), (req, res) => {
  wasteIcs.regenerateFeedToken(db.get(), currentUserId(req));
  res.json({ data: feedStatus(req, currentUserId(req)) });
});

// DELETE /api/v1/waste/feed -> revoke own subscription
router.delete('/', validateRequest(), (req, res) => {
  wasteIcs.clearFeedToken(db.get(), currentUserId(req));
  res.json({ data: null });
});

// PUT /api/v1/waste/feed/types { type_ids: number[] | null } -> optional type
// selection, stored alongside the token (see server/services/waste-ics.js for
// why this isn't a query parameter on the public feed URL). Requires an
// existing token - there is nothing to filter before the feed itself exists.
// The schema (WasteFeedTypeSelectionInput) requires `type_ids` as a list of
// integers or null before this handler runs (#2810).
router.put('/types', validateRequest(), (req, res) => {
  const userId = currentUserId(req);
  if (!wasteIcs.getFeedToken(db.get(), userId)) {
    return res.status(404).json({ error: 'Enable the feed before selecting types.', code: 404 });
  }
  const typeIds = req.body.type_ids;
  if (typeIds === null) {
    wasteIcs.setFeedTypeIds(db.get(), userId, null);
    return res.json({ data: feedStatus(req, userId) });
  }
  const existingIds = new Set(store.listTypes(db.get(), { includeArchived: true }).map((t) => t.id));
  const unknown = typeIds.filter((id) => !existingIds.has(id));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown waste type id(s): ${unknown.join(', ')}.`, code: 400 });
  }
  wasteIcs.setFeedTypeIds(db.get(), userId, typeIds);
  res.json({ data: feedStatus(req, userId) });
});

export default router;
