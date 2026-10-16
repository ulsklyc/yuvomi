/**
 * Modul: Routines
 * Zweck: Morgendliche und abendliche Checklisten pro Haushaltsmitglied.
 * Abhängigkeiten: express, server/db.js
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { str, collectErrors } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { householdMemberSql } from '../services/household-members.js';
import { todayKey } from '../utils/timezone.js';

const log = createLogger('Routines');
const router = express.Router();

const MAX_NAME = 100;
const MAX_LABEL = 200;
const VALID_SLOTS = new Set(['morning', 'evening']);

function actorId(req) {
  return req.authUserId || req.session.userId;
}

function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Admin access required.', code: 403 });
  }
  next();
}

function loadRoutinesForUser(userId) {
  const conn = db.get();
  const today = todayKey(conn);

  const routines = conn.prepare(`
    SELECT r.id, r.name, r.slot, r.user_id, r.position, r.created_at
    FROM routines r
    WHERE r.user_id IS NULL OR r.user_id = ?
    ORDER BY r.slot ASC, r.position ASC, r.id ASC
  `).all(userId);

  const stepsByRoutine = new Map();
  if (routines.length > 0) {
    const ids = routines.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const steps = conn.prepare(`
      SELECT s.id, s.routine_id, s.label, s.position,
             CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END AS checked
      FROM routine_steps s
      LEFT JOIN routine_checks c
        ON c.step_id = s.id AND c.user_id = ? AND c.checked_date = ?
      WHERE s.routine_id IN (${placeholders})
      ORDER BY s.routine_id ASC, s.position ASC, s.id ASC
    `).all(userId, today, ...ids);
    for (const step of steps) {
      if (!stepsByRoutine.has(step.routine_id)) stepsByRoutine.set(step.routine_id, []);
      stepsByRoutine.get(step.routine_id).push({
        id: step.id,
        label: step.label,
        position: step.position,
        checked: step.checked === 1,
      });
    }
  }

  return routines.map((r) => ({
    id: r.id,
    name: r.name,
    slot: r.slot,
    user_id: r.user_id,
    position: r.position,
    created_at: r.created_at,
    steps: stepsByRoutine.get(r.id) ?? [],
  }));
}

// GET /api/v1/routines
router.get('/', (req, res) => {
  try {
    res.json({ data: loadRoutinesForUser(actorId(req)) });
  } catch (err) {
    log.error('GET /routines', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /api/v1/routines  (admin)
router.post('/', requireAdmin, (req, res) => {
  try {
    const errors = collectErrors([
      str(req.body?.name, 'name', { required: true, max: MAX_NAME }),
    ]);
    if (errors) return res.status(400).json({ error: errors, code: 400 });

    const slot = VALID_SLOTS.has(req.body?.slot) ? req.body.slot : 'morning';
    const userId = req.body?.user_id ?? null;

    if (userId !== null) {
      const member = db.get().prepare(`SELECT id FROM users WHERE id = ? AND ${householdMemberSql('users')}`).get(userId);
      if (!member) return res.status(404).json({ error: 'Member not found.', code: 404 });
    }

    const maxPos = db.get().prepare(
      `SELECT COALESCE(MAX(position), -1) AS m FROM routines WHERE slot = ?`
    ).get(slot).m;

    const result = db.get().prepare(
      `INSERT INTO routines (name, slot, user_id, position) VALUES (?, ?, ?, ?)`
    ).run(req.body.name.trim(), slot, userId, maxPos + 1);

    const routine = db.get().prepare(`SELECT * FROM routines WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ data: { ...routine, steps: [] } });
  } catch (err) {
    log.error('POST /routines', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PUT /api/v1/routines/:id  (admin)
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const routine = db.get().prepare(`SELECT * FROM routines WHERE id = ?`).get(req.params.id);
    if (!routine) return res.status(404).json({ error: 'Routine not found.', code: 404 });

    const errors = collectErrors([
      str(req.body?.name, 'name', { required: true, max: MAX_NAME }),
    ]);
    if (errors) return res.status(400).json({ error: errors, code: 400 });

    const slot = VALID_SLOTS.has(req.body?.slot) ? req.body.slot : routine.slot;
    const userId = req.body?.user_id !== undefined ? (req.body.user_id ?? null) : routine.user_id;

    if (userId !== null) {
      const member = db.get().prepare(`SELECT id FROM users WHERE id = ? AND ${householdMemberSql('users')}`).get(userId);
      if (!member) return res.status(404).json({ error: 'Member not found.', code: 404 });
    }

    db.get().prepare(
      `UPDATE routines SET name = ?, slot = ?, user_id = ? WHERE id = ?`
    ).run(req.body.name.trim(), slot, userId, routine.id);

    res.json({ data: { ...routine, name: req.body.name.trim(), slot, user_id: userId } });
  } catch (err) {
    log.error('PUT /routines/:id', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /api/v1/routines/:id  (admin)
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const routine = db.get().prepare(`SELECT id FROM routines WHERE id = ?`).get(req.params.id);
    if (!routine) return res.status(404).json({ error: 'Routine not found.', code: 404 });
    db.get().prepare(`DELETE FROM routines WHERE id = ?`).run(routine.id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /routines/:id', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /api/v1/routines/:id/steps  (admin)
router.post('/:id/steps', requireAdmin, (req, res) => {
  try {
    const routine = db.get().prepare(`SELECT id FROM routines WHERE id = ?`).get(req.params.id);
    if (!routine) return res.status(404).json({ error: 'Routine not found.', code: 404 });

    const errors = collectErrors([
      str(req.body?.label, 'label', { required: true, max: MAX_LABEL }),
    ]);
    if (errors) return res.status(400).json({ error: errors, code: 400 });

    const maxPos = db.get().prepare(
      `SELECT COALESCE(MAX(position), -1) AS m FROM routine_steps WHERE routine_id = ?`
    ).get(routine.id).m;

    const result = db.get().prepare(
      `INSERT INTO routine_steps (routine_id, label, position) VALUES (?, ?, ?)`
    ).run(routine.id, req.body.label.trim(), maxPos + 1);

    const step = db.get().prepare(`SELECT * FROM routine_steps WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ data: { ...step, checked: false } });
  } catch (err) {
    log.error('POST /routines/:id/steps', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PUT /api/v1/routines/:id/steps/:stepId  (admin)
router.put('/:id/steps/:stepId', requireAdmin, (req, res) => {
  try {
    const step = db.get().prepare(
      `SELECT * FROM routine_steps WHERE id = ? AND routine_id = ?`
    ).get(req.params.stepId, req.params.id);
    if (!step) return res.status(404).json({ error: 'Step not found.', code: 404 });

    const errors = collectErrors([
      str(req.body?.label, 'label', { required: true, max: MAX_LABEL }),
    ]);
    if (errors) return res.status(400).json({ error: errors, code: 400 });

    const position = typeof req.body?.position === 'number' ? Math.trunc(req.body.position) : step.position;
    db.get().prepare(
      `UPDATE routine_steps SET label = ?, position = ? WHERE id = ?`
    ).run(req.body.label.trim(), position, step.id);

    res.json({ data: { ...step, label: req.body.label.trim(), position } });
  } catch (err) {
    log.error('PUT /routines/:id/steps/:stepId', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /api/v1/routines/:id/steps/:stepId  (admin)
router.delete('/:id/steps/:stepId', requireAdmin, (req, res) => {
  try {
    const step = db.get().prepare(
      `SELECT id FROM routine_steps WHERE id = ? AND routine_id = ?`
    ).get(req.params.stepId, req.params.id);
    if (!step) return res.status(404).json({ error: 'Step not found.', code: 404 });
    db.get().prepare(`DELETE FROM routine_steps WHERE id = ?`).run(step.id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /routines/:id/steps/:stepId', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /api/v1/routines/:id/steps/:stepId/check  (any member)
router.post('/:id/steps/:stepId/check', (req, res) => {
  try {
    const step = db.get().prepare(
      `SELECT s.id FROM routine_steps s
       JOIN routines r ON r.id = s.routine_id
       WHERE s.id = ? AND s.routine_id = ?
         AND (r.user_id IS NULL OR r.user_id = ?)`
    ).get(req.params.stepId, req.params.id, actorId(req));
    if (!step) return res.status(404).json({ error: 'Step not found.', code: 404 });

    const today = todayKey(db.get());
    db.get().prepare(
      `INSERT OR IGNORE INTO routine_checks (step_id, user_id, checked_date) VALUES (?, ?, ?)`
    ).run(step.id, actorId(req), today);
    res.status(204).end();
  } catch (err) {
    log.error('POST /routines/:id/steps/:stepId/check', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /api/v1/routines/:id/steps/:stepId/check  (any member)
router.delete('/:id/steps/:stepId/check', (req, res) => {
  try {
    const today = todayKey(db.get());
    db.get().prepare(
      `DELETE FROM routine_checks WHERE step_id = ? AND user_id = ? AND checked_date = ?`
    ).run(req.params.stepId, actorId(req), today);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /routines/:id/steps/:stepId/check', err);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
