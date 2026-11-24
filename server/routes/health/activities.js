/**
 * Modul: Gesundheit (Health) - Aktivitäten
 * Zweck: REST-API für Aktivitäten (health_activities): Liste, Anlage, Teil-Update, Löschung.
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../api/formats.ts';
import { defaultVisibilityFor } from './visibility-defaults.js';
import {
  MAX_UNIT,
  viewerId, pathId, applyUpdate, badRequest,
  resolveOwner, wallClockInput,
} from './helpers.js';
import { careAwareClause, writableClause } from '../../authorize/index.ts';
import { validateRequest } from '../../api/validate-request.ts';
import { MAX_TYPE } from '../../services/health-fields.js';

const router = express.Router();

// GET /activities?user_id=&type=&from=&to=
router.get('/activities', validateRequest(), (req, res) => {
  const viewer   = viewerId(req);
  const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  const clause   = careAwareClause('a', viewer, personId);
  const params   = [...clause.params];
  let sql = `SELECT a.* FROM health_activities a WHERE ${clause.sql}`;

  if (req.query.type) { sql += ' AND a.type = ?'; params.push(String(req.query.type)); }
  if (req.query.from) { sql += ' AND a.performed_at >= ?'; params.push(String(req.query.from)); }
  if (req.query.to)   { sql += ' AND a.performed_at <= ?'; params.push(String(req.query.to)); }
  sql += ' ORDER BY a.performed_at DESC, a.id DESC';

  res.json({ data: db.get().prepare(sql).all(...params) });
});

// POST /activities
router.post('/activities', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const b = req.body || {};
  const type        = v.str(b.type, 'type', { max: MAX_TYPE });
  const intensity   = v.str(b.intensity, 'intensity', { max: MAX_UNIT, required: false });
  const performedAt = v.datetime(b.performed_at, 'performed_at', true, wallClockInput());
  const note        = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });

  // Zahlen und Sichtbarkeit prueft das Schema vor der Route (#2810).
  const errors = v.collectErrors([type, intensity, performedAt, note]);
  if (errors.length) return badRequest(res, errors);

  // Optionales user_id: eine betreuende Person trägt für die betreute ein (#584).
  const owner = resolveOwner(req, viewer);
  if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

  const result = db.get().prepare(`
    INSERT INTO health_activities (user_id, type, duration_min, distance_km, intensity, calories, performed_at, note, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(owner.ownerId, type.value, b.duration_min ?? null, b.distance_km ?? null, intensity.value, b.calories ?? null,
         performedAt.value, note.value,
         b.visibility || defaultVisibilityFor(db.get(), owner.ownerId, 'activities'));

  const row = db.get().prepare('SELECT * FROM health_activities WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ data: row });
});

// PATCH /activities/:id
router.patch('/activities/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const w = writableClause('', viewer);
  const existing = db.get().prepare(`SELECT * FROM health_activities WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
  if (!existing) return res.status(404).json({ error: 'Activity not found.', code: 404, reason: 'health_activity_not_found' });

  const b = req.body || {};
  const fields = {};
  const checks = [];

  if (b.type !== undefined)         { const r = v.str(b.type, 'type', { max: MAX_TYPE });                          checks.push(r); if (!r.error) fields.type = r.value; }
  if (b.duration_min !== undefined) fields.duration_min = b.duration_min;
  if (b.distance_km !== undefined)  fields.distance_km = b.distance_km;
  if (b.intensity !== undefined)    { const r = v.str(b.intensity, 'intensity', { max: MAX_UNIT, required: false }); checks.push(r); if (!r.error) fields.intensity = r.value; }
  if (b.calories !== undefined)     fields.calories = b.calories;
  if (b.performed_at !== undefined) { const r = v.datetime(b.performed_at, 'performed_at', true, wallClockInput()); checks.push(r); if (!r.error) fields.performed_at = r.value; }
  if (b.note !== undefined)         { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
  // null laesst die Sichtbarkeit stehen.
  if (b.visibility)                 fields.visibility = b.visibility;

  const errors = v.collectErrors(checks);
  if (errors.length) return badRequest(res, errors);

  applyUpdate('health_activities', id, fields);
  res.json({ data: db.get().prepare('SELECT * FROM health_activities WHERE id = ?').get(id) });
});

// DELETE /activities/:id
router.delete('/activities/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const w = writableClause('', viewer);
  const existing = db.get().prepare(`SELECT id FROM health_activities WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
  if (!existing) return res.status(404).json({ error: 'Activity not found.', code: 404, reason: 'health_activity_not_found' });

  db.get().prepare('DELETE FROM health_activities WHERE id = ?').run(id);
  res.status(204).end();
});

export default router;
