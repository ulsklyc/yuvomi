/**
 * Module: Waste collection routes - fresh ICS import
 * Purpose: the two endpoints that create a brand-new source. Re-import of an
 *          existing source lives in ./sources.js, sharing the same
 *          previewImport/commitImport service calls.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { wasteErrorResponse, currentUserId } from './helpers.js';
import { icsFromBody } from './sources.js';

const log = createLogger('Waste');
const router = express.Router();

router.post('/preview', (req, res) => {
  try {
    const ics = icsFromBody(req, res);
    if (ics === null) return;
    const preview = store.previewImport(db.get(), { sourceId: null, icsText: ics });
    res.json({ data: preview });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/import/preview error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/commit', (req, res) => {
  try {
    const ics = icsFromBody(req, res);
    if (ics === null) return;
    const body = req.body ?? {};
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(400).json({ error: 'name is required.', code: 400 });
    }
    const result = store.commitImport(db.get(), {
      sourceId: null,
      name: body.name,
      icsText: ics,
      mappingDecisions: Array.isArray(body.mappings) ? body.mappings : [],
      skipEventKeys: Array.isArray(body.skip_event_keys) ? body.skip_event_keys : [],
      expectedVersion: null,
      previewDigest: body.preview_digest ?? null,
      userId: currentUserId(req),
    });
    res.status(201).json({ data: result });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/import/commit error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
