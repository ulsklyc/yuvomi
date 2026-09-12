/**
 * Module: Waste collection routes - types
 * Purpose: HTTP layer over server/services/waste-store.js's type functions.
 *          Validation, identity, and archive/delete-refusal all live in the
 *          store/domain layers; this file only translates HTTP <-> service calls.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { id as validateId } from '../../middleware/validate.js';
import { wasteErrorResponse, currentUserId } from './helpers.js';

const log = createLogger('Waste');
const router = express.Router();

router.get('/', (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    res.json({ data: store.listTypes(db.get(), { includeArchived }) });
  } catch (err) {
    log.error('GET /waste/types error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/', (req, res) => {
  try {
    const type = store.createType(db.get(), req.body ?? {}, currentUserId(req));
    res.status(201).json({ data: type });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/types error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const type = store.getType(db.get(), vId.value);
    if (!type) return res.status(404).json({ error: 'Waste type not found.', code: 404 });
    res.json({ data: type });
  } catch (err) {
    log.error('GET /waste/types/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const type = store.updateType(db.get(), vId.value, req.body ?? {});
    res.json({ data: type });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('PUT /waste/types/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    store.deleteType(db.get(), vId.value);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('DELETE /waste/types/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
