/**
 * Module: Waste collection routes - manual one-off pickups
 * Purpose: HTTP layer over server/services/waste-store.js's one-off functions.
 *          API path is /pickups (the short, stable public name); the
 *          underlying table is waste_one_off_pickups. A catch answers only the
 *          typed waste errors; anything else reaches the central error
 *          handler (#2810).
 */

import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { id as validateId } from '../../api/formats.ts';
import { wasteErrorResponse, currentUserId, queryTypeId } from './helpers.js';

const router = express.Router();

router.get('/', validateRequest(), (req, res) => {
  res.json({ data: store.listOneOffs(db.get(), { typeId: queryTypeId(req) }) });
});

router.post('/', validateRequest(), (req, res) => {
  try {
    const pickup = store.createOneOff(db.get(), req.body ?? {}, currentUserId(req));
    res.status(201).json({ data: pickup });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

router.get('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  const pickup = store.getOneOff(db.get(), vId.value);
  if (!pickup) return res.status(404).json({ error: 'One-off pickup not found.', code: 404, reason: 'waste_pickup_not_found' });
  res.json({ data: pickup });
});

router.put('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  try {
    const pickup = store.updateOneOff(db.get(), vId.value, req.body ?? {});
    res.json({ data: pickup });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

router.delete('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  try {
    store.deleteOneOff(db.get(), vId.value);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

export default router;
