/**
 * Module: Waste collection routes - resolved occurrences
 * Purpose: the two read-only projections every consumer (module page,
 *          Dashboard, Calendar) is meant to call into - never rebuild the
 *          resolver themselves.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { wasteErrorResponse } from './helpers.js';

const log = createLogger('Waste');
const router = express.Router();

router.get('/next', (req, res) => {
  try {
    res.json({ data: store.getNextPerType(db.get(), {}) });
  } catch (err) {
    log.error('GET /waste/occurrences/next error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/', (req, res) => {
  try {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    res.json({ data: store.getOccurrences(db.get(), { from, to }) });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('GET /waste/occurrences error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
