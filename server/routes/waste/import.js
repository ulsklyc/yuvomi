/**
 * Module: Waste collection routes - fresh ICS import
 * Purpose: the two endpoints that create a brand-new source. Re-import of an
 *          existing source lives in ./sources.js, sharing the same
 *          previewImport/commitImport service calls. A catch answers only the
 *          typed waste errors; anything else reaches the central error
 *          handler (#2810).
 */

import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { wasteErrorResponse, currentUserId } from './helpers.js';
import { icsFromBody } from './sources.js';

const router = express.Router();

router.post('/preview', validateRequest(), (req, res) => {
  const ics = icsFromBody(req, res);
  if (ics === null) return;
  try {
    const preview = store.previewImport(db.get(), { sourceId: null, icsText: ics });
    res.json({ data: preview });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

router.post('/commit', validateRequest(), (req, res) => {
  const ics = icsFromBody(req, res);
  if (ics === null) return;
  const body = req.body ?? {};
  // The schema requires `name` as text; empty after trimming is the route's.
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return res.status(400).json({ error: 'name is required.', code: 400 });
  }
  try {
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
    throw err;
  }
});

export default router;
