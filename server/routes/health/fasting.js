import express from 'express';
import * as db from '../../db.js';
import {
  acknowledgeSafety, createFast, finishFast, updateFast, deleteFast,
  getFastingState, updateFastingSettings, FastingError,
  getFastingStats,
  getFastingHistory, getAllFastingHistory,
} from '../../services/fasting.js';
import { fastingToCsv } from '../../services/fasting-export.js';
import { viewerId, log } from './helpers.js';

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

function sendError(res, error) {
  if (error instanceof FastingError) {
    const body = { error: error.message, code: error.status, reason: error.reason };
    if (error.current !== undefined) body.current = error.current;
    return res.status(error.status).json(body);
  }
  log.error('Error handling fasting request:', error?.message || error);
  return res.status(500).json({ error: 'Internal server error.', code: 500 });
}

router.get('/fasting/state', (req, res) => {
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
router.get('/fasting/history', history);

router.get('/fasting/stats', (req, res) => {
  try { return res.json({ data: getFastingStats(db.get(), { id: viewerId(req) }, subject(req)) }); } catch (error) { return sendError(res, error); }
});

router.get('/fasting', history);

router.post('/fasting', (req, res) => {
  try { return res.status(201).json({ data: createFast(db.get(), { id: viewerId(req) }, input(req.body)) }); } catch (error) { return sendError(res, error); }
});

router.post('/fasting/acknowledge-safety', (req, res) => {
  try { return res.json({ data: acknowledgeSafety(db.get(), { id: viewerId(req) }, subject(req)) }); } catch (error) { return sendError(res, error); }
});

router.post('/fasting/:id/finish', (req, res) => {
  try { return res.json({ data: finishFast(db.get(), { id: viewerId(req) }, req.params.id, { expectedRevision: req.body?.expected_revision, endAt: req.body?.end_at }) }); } catch (error) { return sendError(res, error); }
});

router.patch('/fasting/:id', (req, res) => {
  try { return res.json({ data: updateFast(db.get(), { id: viewerId(req) }, req.params.id, { ...input(req.body), expectedRevision: req.body?.expected_revision }) }); } catch (error) { return sendError(res, error); }
});

router.delete('/fasting/:id', (req, res) => {
  try { deleteFast(db.get(), { id: viewerId(req) }, req.params.id, { expectedRevision: req.body?.expected_revision ?? req.query.expected_revision }); return res.status(204).end(); } catch (error) { return sendError(res, error); }
});

router.get('/fasting/settings', (req, res) => {
  try { return res.json({ data: getFastingState(db.get(), { id: viewerId(req) }, subject(req)).settings }); } catch (error) { return sendError(res, error); }
});

router.put('/fasting/settings', (req, res) => {
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

router.get('/export/fasting', (req, res) => {
  try {
    const rows = getAllFastingHistory(db.get(), { id: viewerId(req) }, subject(req), { from: req.query.from, to: req.query.to });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="yuvomi-fasting.csv"');
    return res.send(`\ufeff${fastingToCsv(rows)}\n`);
  } catch (error) { return sendError(res, error); }
});

export default router;
