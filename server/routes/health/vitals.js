/**
 * Modul: Gesundheit (Health) - Vitalwerte
 * Zweck: REST-API für Vitalwerte (health_vitals): Liste, Anlage, Teil-Update, Löschung.
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../middleware/validate.js';
import { defaultVisibilityFor, vitalScopeKey } from './visibility-defaults.js';
import {
  log, VISIBILITIES, MAX_UNIT,
  viewerId, careAwareClause, applyUpdate, badRequest,
  resolveOwner, writableClause, wallClockInput,
} from './helpers.js';

const router = express.Router();

// GET /vitals?user_id=&type=&from=&to=
router.get('/vitals', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = careAwareClause('v', viewer, personId);
    const params   = [...clause.params];
    let sql = `SELECT v.* FROM health_vitals v WHERE ${clause.sql}`;

    if (req.query.type) { sql += ' AND v.type = ?'; params.push(String(req.query.type)); }
    if (req.query.from) { sql += ' AND v.measured_at >= ?'; params.push(String(req.query.from)); }
    if (req.query.to)   { sql += ' AND v.measured_at <= ?'; params.push(String(req.query.to)); }

    sql += ' ORDER BY v.measured_at DESC, v.id DESC';
    res.json({ data: db.get().prepare(sql).all(...params) });
  } catch (err) {
    log.error('Error listing vitals:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /vitals
router.post('/vitals', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const type       = v.str(b.type, 'type', { max: 50 });
    const valueNum   = v.num(b.value_num,  'value_num');
    const valueNum2  = v.num(b.value_num2, 'value_num2');
    const valueNum3  = v.num(b.value_num3, 'value_num3');
    const unit       = v.str(b.unit, 'unit', { max: MAX_UNIT, required: false });
    const measuredAt = v.datetime(b.measured_at, 'measured_at', true, wallClockInput());
    const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([type, valueNum, valueNum2, valueNum3, unit, measuredAt, note, visibility]);
    if (errors.length) return badRequest(res, errors);

    // Optionales user_id: eine betreuende Person trägt für die betreute ein (#584).
    const owner = resolveOwner(req, viewer);
    if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

    const result = db.get().prepare(`
      INSERT INTO health_vitals (user_id, type, value_num, value_num2, value_num3, unit, measured_at, note, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(owner.ownerId, type.value, valueNum.value, valueNum2.value, valueNum3.value,
           unit.value, measuredAt.value, note.value,
           // Fehlt das Feld, gilt die Wahl des EIGENTUEMERS fuer diese Metrik
           // (#958) - nicht die der erfassenden Person: die Zeile gehoert ihm.
           visibility.value || defaultVisibilityFor(db.get(), owner.ownerId, vitalScopeKey(type.value)));

    const row = db.get().prepare('SELECT * FROM health_vitals WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating vital:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /vitals/:id
router.patch('/vitals/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const w = writableClause('', viewer);
    const existing = db.get().prepare(`SELECT * FROM health_vitals WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
    if (!existing) return res.status(404).json({ error: 'Vitalwert nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.type !== undefined)        { const r = v.str(b.type, 'type', { max: 50 });               checks.push(r); if (!r.error) fields.type = r.value; }
    if (b.value_num !== undefined)   { const r = v.num(b.value_num,  'value_num');                 checks.push(r); if (!r.error) fields.value_num = r.value; }
    if (b.value_num2 !== undefined)  { const r = v.num(b.value_num2, 'value_num2');                checks.push(r); if (!r.error) fields.value_num2 = r.value; }
    if (b.value_num3 !== undefined)  { const r = v.num(b.value_num3, 'value_num3');                checks.push(r); if (!r.error) fields.value_num3 = r.value; }
    if (b.unit !== undefined)        { const r = v.str(b.unit, 'unit', { max: MAX_UNIT, required: false }); checks.push(r); if (!r.error) fields.unit = r.value; }
    if (b.measured_at !== undefined) { const r = v.datetime(b.measured_at, 'measured_at', true, wallClockInput()); checks.push(r); if (!r.error) fields.measured_at = r.value; }
    if (b.note !== undefined)        { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
    if (b.visibility !== undefined)  { const r = v.oneOf(b.visibility, VISIBILITIES, 'visibility'); checks.push(r); if (!r.error && r.value) fields.visibility = r.value; }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    applyUpdate('health_vitals', id, fields);
    res.json({ data: db.get().prepare('SELECT * FROM health_vitals WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating vital:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /vitals/:id
router.delete('/vitals/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const w = writableClause('', viewer);
    const existing = db.get().prepare(`SELECT id FROM health_vitals WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
    if (!existing) return res.status(404).json({ error: 'Vitalwert nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM health_vitals WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting vital:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
