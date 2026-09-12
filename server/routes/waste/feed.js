/**
 * Module: Waste collection feed - management
 * Purpose: status/regenerate/revoke of the feed token plus the optional
 *          per-type selection. The ICS content itself is served
 *          unauthenticated outside /api/v1 (see server/index.js), mirroring
 *          server/routes/inventory/deadlines-feed.js.
 *
 * No admin/module gate, same reasoning as the inventory deadlines feed: the
 * token hangs off the caller's own users row, so every member manages only
 * their own subscription. GET /api/v1/waste/types is already open to any
 * member regardless of module access level, so gating the feed more tightly
 * than the data it feeds from would be the wrong layer.
 */

import express from 'express';
import * as db from '../../db.js';
import { createLogger } from '../../logger.js';
import * as wasteIcs from '../../services/waste-ics.js';
import * as store from '../../services/waste-store.js';
import { currentUserId } from './helpers.js';

const log = createLogger('Waste');
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
router.get('/', (req, res) => {
  try {
    res.json({ data: feedStatus(req, currentUserId(req)) });
  } catch (err) {
    log.error('GET /waste/feed error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/waste/feed/regenerate -> issue a new token (keeps the type selection)
router.post('/regenerate', (req, res) => {
  try {
    wasteIcs.regenerateFeedToken(db.get(), currentUserId(req));
    res.json({ data: feedStatus(req, currentUserId(req)) });
  } catch (err) {
    log.error('POST /waste/feed/regenerate error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// DELETE /api/v1/waste/feed -> revoke own subscription
router.delete('/', (req, res) => {
  try {
    wasteIcs.clearFeedToken(db.get(), currentUserId(req));
    res.json({ data: null });
  } catch (err) {
    log.error('DELETE /waste/feed error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/waste/feed/types { type_ids: number[] | null } -> optional type
// selection, stored alongside the token (see server/services/waste-ics.js for
// why this isn't a query parameter on the public feed URL). Requires an
// existing token - there is nothing to filter before the feed itself exists.
router.put('/types', (req, res) => {
  try {
    const userId = currentUserId(req);
    if (!wasteIcs.getFeedToken(db.get(), userId)) {
      return res.status(404).json({ error: 'Enable the feed before selecting types.', code: 404 });
    }
    const body = req.body ?? {};
    if (body.type_ids === null) {
      wasteIcs.setFeedTypeIds(db.get(), userId, null);
      return res.json({ data: feedStatus(req, userId) });
    }
    if (!Array.isArray(body.type_ids) || !body.type_ids.every((n) => Number.isInteger(n))) {
      return res.status(400).json({ error: 'type_ids must be an array of integers, or null.', code: 400 });
    }
    const existingIds = new Set(store.listTypes(db.get(), { includeArchived: true }).map((t) => t.id));
    const unknown = body.type_ids.filter((id) => !existingIds.has(id));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown waste type id(s): ${unknown.join(', ')}.`, code: 400 });
    }
    wasteIcs.setFeedTypeIds(db.get(), userId, body.type_ids);
    res.json({ data: feedStatus(req, userId) });
  } catch (err) {
    log.error('PUT /waste/feed/types error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
