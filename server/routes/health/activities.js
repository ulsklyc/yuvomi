/**
 * Modul: Gesundheit (Health) - Aktivitäten
 * Zweck: REST-API für Aktivitäten (health_activities): Liste, Anlage, Teil-Update, Löschung.
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../middleware/validate.js';
import { defaultVisibilityFor } from './visibility-defaults.js';
import {
  log, VISIBILITIES, MAX_UNIT,
  viewerId, careAwareClause, applyUpdate, badRequest,
  resolveOwner, writableClause, wallClockInput,
} from './helpers.js';

const router = express.Router();

// GET /activities?user_id=&type=&from=&to=
router.get('/activities', (req, res) => {
  try {
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
  } catch (err) {
    log.error('Error listing activities:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /activities
router.post('/activities', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const type        = v.str(b.type, 'type', { max: 50 });
    const duration    = v.num(b.duration_min, 'duration_min');
    const distance    = v.num(b.distance_km, 'distance_km');
    const intensity   = v.str(b.intensity, 'intensity', { max: MAX_UNIT, required: false });
    const calories    = v.num(b.calories, 'calories');
    const performedAt = v.datetime(b.performed_at, 'performed_at', true, wallClockInput());
    const note        = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility  = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([type, duration, distance, intensity, calories, performedAt, note, visibility]);
    if (errors.length) return badRequest(res, errors);

    // Optionales user_id: eine betreuende Person trägt für die betreute ein (#584).
    const owner = resolveOwner(req, viewer);
    if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

    const result = db.get().prepare(`
      INSERT INTO health_activities (user_id, type, duration_min, distance_km, intensity, calories, performed_at, note, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(owner.ownerId, type.value, duration.value, distance.value, intensity.value, calories.value,
           performedAt.value, note.value,
           visibility.value || defaultVisibilityFor(db.get(), owner.ownerId, 'activities'));

    const row = db.get().prepare('SELECT * FROM health_activities WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating activity:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /activities/:id
router.patch('/activities/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const w = writableClause('', viewer);
    const existing = db.get().prepare(`SELECT * FROM health_activities WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
    if (!existing) return res.status(404).json({ error: 'Aktivität nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.type !== undefined)         { const r = v.str(b.type, 'type', { max: 50 });                          checks.push(r); if (!r.error) fields.type = r.value; }
    if (b.duration_min !== undefined) { const r = v.num(b.duration_min, 'duration_min');                       checks.push(r); if (!r.error) fields.duration_min = r.value; }
    if (b.distance_km !== undefined)  { const r = v.num(b.distance_km, 'distance_km');                         checks.push(r); if (!r.error) fields.distance_km = r.value; }
    if (b.intensity !== undefined)    { const r = v.str(b.intensity, 'intensity', { max: MAX_UNIT, required: false }); checks.push(r); if (!r.error) fields.intensity = r.value; }
    if (b.calories !== undefined)     { const r = v.num(b.calories, 'calories');                               checks.push(r); if (!r.error) fields.calories = r.value; }
    if (b.performed_at !== undefined) { const r = v.datetime(b.performed_at, 'performed_at', true, wallClockInput()); checks.push(r); if (!r.error) fields.performed_at = r.value; }
    if (b.note !== undefined)         { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
    if (b.visibility !== undefined)   { const r = v.oneOf(b.visibility, VISIBILITIES, 'visibility');           checks.push(r); if (!r.error && r.value) fields.visibility = r.value; }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    applyUpdate('health_activities', id, fields);
    res.json({ data: db.get().prepare('SELECT * FROM health_activities WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating activity:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /activities/:id
router.delete('/activities/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const w = writableClause('', viewer);
    const existing = db.get().prepare(`SELECT id FROM health_activities WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
    if (!existing) return res.status(404).json({ error: 'Aktivität nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM health_activities WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting activity:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
