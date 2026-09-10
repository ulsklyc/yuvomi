/**
 * Module: Waste collection routes - schedules and their per-occurrence overrides
 * Purpose: HTTP layer over server/services/waste-store.js's schedule/override
 *          functions. Overrides live nested under a schedule
 *          (PUT/DELETE /:id/overrides/:originalDate) per the stable API
 *          contract in PLAN.md - there is no separate top-level router for them.
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
    const includeInactive = req.query.include_inactive !== '0' && req.query.include_inactive !== 'false';
    res.json({ data: store.listSchedules(db.get(), { typeId: queryTypeId(req), includeInactive }) });
  } catch (err) {
    log.error('GET /waste/schedules error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/', (req, res) => {
  try {
    const schedule = store.createSchedule(db.get(), req.body ?? {}, currentUserId(req));
    res.status(201).json({ data: schedule });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/schedules error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const schedule = store.getSchedule(db.get(), vId.value);
    if (!schedule) return res.status(404).json({ error: 'Waste schedule not found.', code: 404 });
    res.json({ data: schedule });
  } catch (err) {
    log.error('GET /waste/schedules/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const schedule = store.updateSchedule(db.get(), vId.value, req.body ?? {});
    res.json({ data: schedule });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('PUT /waste/schedules/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    store.deleteSchedule(db.get(), vId.value);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('DELETE /waste/schedules/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// Moving, skipping (replacement_date: null), and restoring (DELETE) one
// calculated occurrence. upsertOverride() refuses an original_date that isn't
// really one of the schedule's own calculated dates.
router.put('/:id/overrides/:originalDate', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const override = store.upsertOverride(db.get(), vId.value, {
      original_date: req.params.originalDate,
      replacement_date: req.body?.replacement_date ?? null,
      note: req.body?.note ?? null,
    });
    res.json({ data: override });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('PUT /waste/schedules/:id/overrides/:originalDate error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id/overrides/:originalDate', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    store.deleteOverride(db.get(), vId.value, req.params.originalDate);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('DELETE /waste/schedules/:id/overrides/:originalDate error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
