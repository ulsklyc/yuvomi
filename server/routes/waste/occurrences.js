/**
 * Module: Waste collection routes - resolved occurrences
 * Purpose: the two read-only projections every consumer (module page,
 *          Dashboard, Calendar) is meant to call into - never rebuild the
 *          resolver themselves. A catch answers only the typed waste errors;
 *          anything else reaches the central error handler (#2810).
 */

import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { wasteErrorResponse } from './helpers.js';

const router = express.Router();

router.get('/next', validateRequest(), (req, res) => {
  res.json({ data: store.getNextPerType(db.get(), {}) });
});

router.get('/', validateRequest(), (req, res) => {
  try {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    res.json({ data: store.getOccurrences(db.get(), { from, to }) });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

export default router;
