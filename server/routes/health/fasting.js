import express from 'express';
import * as db from '../../db.js';
import {
  acknowledgeSafety, createFast, finishFast, updateFast, deleteFast,
  getFastingState, updateFastingSettings, FastingError,
  getFastingStats,
  getFastingHistory, getAllFastingHistory, requireFastingCapability,
} from '../../services/fasting.js';
import { fastingToCsv } from '../../services/fasting-export.js';
import { viewerId, pathId } from './helpers.js';
import { validateRequest } from '../../api/validate-request.ts';

const router = express.Router();

function input(body = {}) {
  return {
    userId: body.user_id,
    startAt: body.start_at,
    endAt: body.end_at,
    startTzid: body.start_tzid,
    goalMinutes: body.goal_minutes,
    rating: body.rating,
    note: body.note,
    visibility: body.visibility,
    acknowledgeSafety: body.acknowledge_safety,
  };
}

function definedInput(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function subject(req) {
  const value = req.query.user_id ?? req.body?.user_id;
  return value === undefined ? viewerId(req) : Number(value);
}

/**
 * The answer of a refusal of the fasting service: its status, `reason` and,
 * for a revision or overlap conflict, the `current` record. Anything else is
 * not a refusal and goes on to the central error handler (#2810).
 * @param {any} res
 * @param {unknown} error
 */
function sendError(res, error) {
  if (!(error instanceof FastingError)) throw error;
  const body = { error: error.message, code: error.status, reason: error.reason };
  if (error.current !== undefined) body.current = error.current;
  return res.status(error.status).json(body);
}

/**
 * The fasting capability (`health_use_fasting`) is a right without a row: it
 * stands in front of validateRequest() on every fasting route (#2810), so an
 * account without it gets its 403 `FASTING_CAPABILITY_REQUIRED` before any
 * check of the request, as it did from the service before. The service keeps
 * its own check (ensureSubject) behind it.
 * @param {any} req
 * @param {any} res
 * @param {() => void} next
 */
function requireCapability(req, res, next) {
  try {
    requireFastingCapability(db.get(), { id: viewerId(req) });
    return next();
  } catch (error) { return sendError(res, error); }
}

router.get('/fasting/state', requireCapability, validateRequest(), (req, res) => {
  try { return res.json({ data: getFastingState(db.get(), { id: viewerId(req) }, subject(req)) }); } catch (error) { return sendError(res, error); }
});

function history(req, res) {
  try {
    const page = getFastingHistory(db.get(), { id: viewerId(req) }, subject(req), {
      limit: req.query.limit, beforeAt: req.query.before_at, beforeId: req.query.before_id,
      from: req.query.from, to: req.query.to,
    });
    return res.json({ data: page.entries, has_more: page.has_more, next_cursor: page.next_cursor });
  } catch (error) { return sendError(res, error); }
}
router.get('/fasting/history', requireCapability, validateRequest(), history);

router.get('/fasting/stats', requireCapability, validateRequest(), (req, res) => {
  try { return res.json({ data: getFastingStats(db.get(), { id: viewerId(req) }, subject(req)) }); } catch (error) { return sendError(res, error); }
});

router.get('/fasting', requireCapability, validateRequest(), history);

router.post('/fasting', requireCapability, validateRequest(), (req, res) => {
  try { return res.status(201).json({ data: createFast(db.get(), { id: viewerId(req) }, input(req.body)) }); } catch (error) { return sendError(res, error); }
});

router.post('/fasting/acknowledge-safety', requireCapability, validateRequest(), (req, res) => {
  try { return res.json({ data: acknowledgeSafety(db.get(), { id: viewerId(req) }, subject(req)) }); } catch (error) { return sendError(res, error); }
});

router.post('/fasting/:id/finish', requireCapability, validateRequest(), (req, res) => {
  try { return res.json({ data: finishFast(db.get(), { id: viewerId(req) }, pathId(req), { expectedRevision: req.body?.expected_revision, endAt: req.body?.end_at }) }); } catch (error) { return sendError(res, error); }
});

router.patch('/fasting/:id', requireCapability, validateRequest(), (req, res) => {
  try { return res.json({ data: updateFast(db.get(), { id: viewerId(req) }, pathId(req), { ...input(req.body), expectedRevision: req.body?.expected_revision }) }); } catch (error) { return sendError(res, error); }
});

router.delete('/fasting/:id', requireCapability, validateRequest(), (req, res) => {
  try { deleteFast(db.get(), { id: viewerId(req) }, pathId(req), { expectedRevision: req.body?.expected_revision ?? req.query.expected_revision }); return res.status(204).end(); } catch (error) { return sendError(res, error); }
});

router.get('/fasting/settings', requireCapability, validateRequest(), (req, res) => {
  try { return res.json({ data: getFastingState(db.get(), { id: viewerId(req) }, subject(req)).settings }); } catch (error) { return sendError(res, error); }
});

router.put('/fasting/settings', requireCapability, validateRequest(), (req, res) => {
  try {
    const database = db.get();
    const data = updateFastingSettings(database, { id: viewerId(req) }, definedInput([
        ['defaultGoalMinutes', req.body?.default_goal_minutes],
        ['zoneMode', req.body?.zone_mode],
        ['remindGoal', req.body?.remind_goal],
        ['remindNextStart', req.body?.remind_next_start],
        ['acknowledgeSafety', req.body?.acknowledge_safety],
        ['clockMode', req.body?.clock_mode],
        ['activeId', req.body?.active_id],
        ['expectedRevision', req.body?.expected_revision],
      ]), subject(req));
    return res.json({ data });
  } catch (error) { return sendError(res, error); }
});

router.get('/export/fasting', requireCapability, validateRequest(), (req, res) => {
  try {
    const rows = getAllFastingHistory(db.get(), { id: viewerId(req) }, subject(req), { from: req.query.from, to: req.query.to });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="yuvomi-fasting.csv"');
    return res.send(`\ufeff${fastingToCsv(rows)}\n`);
  } catch (error) { return sendError(res, error); }
});

export default router;
