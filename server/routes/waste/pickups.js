/**
 * Module: Waste collection routes - manual one-off pickups
 * Purpose: HTTP layer over server/services/waste-store.js's one-off functions.
 *          API path is /pickups (PLAN.md's stable contract); the underlying
 *          table is waste_one_off_pickups.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { id as validateId } from '../../middleware/validate.js';
import { wasteErrorResponse, currentUserId, queryTypeId } from './helpers.js';

const log = createLogger('Waste');
const router = express.Router();

router.get('/', (req, res) => {
  try {
    res.json({ data: store.listOneOffs(db.get(), { typeId: queryTypeId(req) }) });
  } catch (err) {
    log.error('GET /waste/pickups error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/', (req, res) => {
  try {
    const pickup = store.createOneOff(db.get(), req.body ?? {}, currentUserId(req));
    res.status(201).json({ data: pickup });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/pickups error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const pickup = store.getOneOff(db.get(), vId.value);
    if (!pickup) return res.status(404).json({ error: 'One-off pickup not found.', code: 404 });
    res.json({ data: pickup });
  } catch (err) {
    log.error('GET /waste/pickups/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const pickup = store.updateOneOff(db.get(), vId.value, req.body ?? {});
    res.json({ data: pickup });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('PUT /waste/pickups/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    store.deleteOneOff(db.get(), vId.value);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('DELETE /waste/pickups/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
