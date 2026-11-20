/**
 * Module: Waste collection routes - types
 * Purpose: HTTP layer over server/services/waste-store.js's type functions.
 *          Validation, identity, and archive/delete-refusal all live in the
 *          store/domain layers; this file only translates HTTP <-> service calls.
 *          A catch answers only the typed waste errors; anything else reaches
 *          the central error handler (#2810).
 */

import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { id as validateId } from '../../middleware/validate.js';
import { wasteErrorResponse, currentUserId } from './helpers.js';

const router = express.Router();

router.get('/', validateRequest(), (req, res) => {
  const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
  res.json({ data: store.listTypes(db.get(), { includeArchived }) });
});

router.post('/', validateRequest(), (req, res) => {
  try {
    const type = store.createType(db.get(), req.body ?? {}, currentUserId(req));
    res.status(201).json({ data: type });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

router.get('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  const type = store.getType(db.get(), vId.value);
  if (!type) return res.status(404).json({ error: 'Waste type not found.', code: 404, reason: 'waste_type_not_found' });
  res.json({ data: type });
});

router.put('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  try {
    const type = store.updateType(db.get(), vId.value, req.body ?? {});
    res.json({ data: type });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

router.delete('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  try {
    store.deleteType(db.get(), vId.value);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

export default router;
