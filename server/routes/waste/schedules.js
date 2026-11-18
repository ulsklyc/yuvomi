/**
 * Module: Waste collection routes - schedules and their per-occurrence overrides
 * Purpose: HTTP layer over server/services/waste-store.js's schedule/override
 *          functions. Overrides live nested under a schedule
 *          (PUT/DELETE /:id/overrides/:originalDate) because an override only
 *          ever makes sense in the context of the schedule it moves/skips one
 *          occurrence of - there is no separate top-level router for them.
 *          A catch answers only the typed waste errors; anything else reaches
 *          the central error handler (#2810).
 */

import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { id as validateId } from '../../middleware/validate.js';
import { wasteErrorResponse, currentUserId, queryTypeId } from './helpers.js';

const router = express.Router();

router.get('/', validateRequest(), (req, res) => {
  const includeInactive = req.query.include_inactive !== '0' && req.query.include_inactive !== 'false';
  res.json({ data: store.listSchedules(db.get(), { typeId: queryTypeId(req), includeInactive }) });
});

router.post('/', validateRequest(), (req, res) => {
  try {
    const schedule = store.createSchedule(db.get(), req.body ?? {}, currentUserId(req));
    res.status(201).json({ data: schedule });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

router.get('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  const schedule = store.getSchedule(db.get(), vId.value);
  if (!schedule) return res.status(404).json({ error: 'Waste schedule not found.', code: 404, reason: 'waste_schedule_not_found' });
  res.json({ data: schedule });
});

router.put('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  try {
    const schedule = store.updateSchedule(db.get(), vId.value, req.body ?? {});
    res.json({ data: schedule });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

router.delete('/:id', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  try {
    store.deleteSchedule(db.get(), vId.value);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

// Moving, skipping (replacement_date: null), and restoring (DELETE) one
// calculated occurrence. upsertOverride() refuses an original_date that isn't
// really one of the schedule's own calculated dates.
router.put('/:id/overrides/:originalDate', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  try {
    const override = store.upsertOverride(db.get(), vId.value, {
      original_date: req.params.originalDate,
      replacement_date: req.body?.replacement_date ?? null,
      note: req.body?.note ?? null,
    });
    res.json({ data: override });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

router.delete('/:id/overrides/:originalDate', validateRequest(), (req, res) => {
  const vId = validateId(req.params.id, 'id');
  if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
  try {
    store.deleteOverride(db.get(), vId.value, req.params.originalDate);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

export default router;
