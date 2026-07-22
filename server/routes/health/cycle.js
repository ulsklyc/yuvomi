/**
 * Modul: Gesundheit (Health) - Zyklus (Menstruation)
 * Zweck: Drei Ressourcen, alle mit dem üblichen Visibility-Scoping (Eigentümer +
 *        optional 'family' für den Personen-Umschalter): Perioden-Episoden
 *        (cycle_periods), Tages-Logs (cycle_day_logs, genau ein Eintrag je
 *        Person/Tag → Upsert) und die per-Person-Einstellungen (cycle_settings,
 *        nur der Eigentümer selbst) plus der Perioden-CSV-Export. Die
 *        Vorhersage-Logik (nächste Periode, Eisprung, fruchtbares Fenster) liegt
 *        bewusst rein clientseitig in public/utils/health-cycle.js - der Server
 *        speichert nur.
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../middleware/validate.js';
import { cycleToCsv } from '../../services/health-export.js';
import {
  log, VISIBILITIES, FLOW_LEVELS, MAX_UNIT, MAX_SYMPTOMS,
  viewerId, visibilityClause, toBit, applyUpdate, badRequest,
  exportFilename, sendCsv, exportRange,
} from './helpers.js';

const router = express.Router();

/** Normalisiert Symptome (Array oder Komma-String) zu einer bereinigten Komma-Liste. */
function normalizeSymptoms(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null, error: null };
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const tokens = list
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => /^[a-z0-9_]{1,32}$/.test(s));
  const joined = [...new Set(tokens)].join(',');
  if (joined.length > MAX_SYMPTOMS) return { value: null, error: `symptoms may be at most ${MAX_SYMPTOMS} characters long.` };
  return { value: joined || null, error: null };
}

// ---- Perioden-Episoden ----

// GET /cycle/periods?user_id=&from=&to=
router.get('/cycle/periods', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('p', viewer, personId);
    const params   = [...clause.params];
    let sql = `SELECT p.* FROM cycle_periods p WHERE ${clause.sql}`;
    if (req.query.from) { sql += ' AND p.start_date >= ?'; params.push(String(req.query.from)); }
    if (req.query.to)   { sql += ' AND p.start_date <= ?'; params.push(String(req.query.to)); }
    sql += ' ORDER BY p.start_date DESC, p.id DESC';
    res.json({ data: db.get().prepare(sql).all(...params) });
  } catch (err) {
    log.error('Error listing cycle periods:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /cycle/periods
router.post('/cycle/periods', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const startDate  = v.date(b.start_date, 'start_date', true);
    const endDate    = v.date(b.end_date, 'end_date');
    const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([startDate, endDate, note, visibility]);
    if (endDate.value && startDate.value && endDate.value < startDate.value) {
      errors.push('end_date must not be before start_date.');
    }
    if (errors.length) return badRequest(res, errors);

    const result = db.get().prepare(`
      INSERT INTO cycle_periods (user_id, start_date, end_date, note, visibility)
      VALUES (?, ?, ?, ?, ?)
    `).run(viewer, startDate.value, endDate.value, note.value, visibility.value || 'private');

    res.status(201).json({ data: db.get().prepare('SELECT * FROM cycle_periods WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    log.error('Error creating cycle period:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /cycle/periods/:id
router.patch('/cycle/periods/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare('SELECT * FROM cycle_periods WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Periode nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.start_date !== undefined) { const r = v.date(b.start_date, 'start_date', true); checks.push(r); if (!r.error) fields.start_date = r.value; }
    if (b.end_date !== undefined)   { const r = v.date(b.end_date, 'end_date');           checks.push(r); if (!r.error) fields.end_date = r.value; }
    if (b.note !== undefined)       { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
    if (b.visibility !== undefined) { const r = v.oneOf(b.visibility, VISIBILITIES, 'visibility'); checks.push(r); if (!r.error && r.value) fields.visibility = r.value; }

    const errors = v.collectErrors(checks);
    const nextStart = fields.start_date !== undefined ? fields.start_date : existing.start_date;
    const nextEnd   = fields.end_date   !== undefined ? fields.end_date   : existing.end_date;
    if (nextEnd && nextStart && nextEnd < nextStart) errors.push('end_date must not be before start_date.');
    if (errors.length) return badRequest(res, errors);

    applyUpdate('cycle_periods', id, fields);
    res.json({ data: db.get().prepare('SELECT * FROM cycle_periods WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating cycle period:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /cycle/periods/:id
router.delete('/cycle/periods/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare('SELECT id FROM cycle_periods WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Periode nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM cycle_periods WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting cycle period:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ---- Tages-Logs (Upsert je Person/Tag) ----

// GET /cycle/logs?user_id=&from=&to=
router.get('/cycle/logs', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('l', viewer, personId);
    const params   = [...clause.params];
    let sql = `SELECT l.* FROM cycle_day_logs l WHERE ${clause.sql}`;
    if (req.query.from) { sql += ' AND l.log_date >= ?'; params.push(String(req.query.from)); }
    if (req.query.to)   { sql += ' AND l.log_date <= ?'; params.push(String(req.query.to)); }
    sql += ' ORDER BY l.log_date DESC, l.id DESC';
    res.json({ data: db.get().prepare(sql).all(...params) });
  } catch (err) {
    log.error('Error listing cycle logs:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /cycle/logs  (Upsert: ein Eintrag je user_id + log_date)
router.post('/cycle/logs', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const logDate    = v.date(b.log_date, 'log_date', true);
    const flow       = v.oneOf(b.flow, FLOW_LEVELS, 'flow');
    const mood       = v.str(b.mood, 'mood', { max: MAX_UNIT, required: false });
    const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility = v.oneOf(b.visibility, VISIBILITIES, 'visibility');
    const symptoms   = normalizeSymptoms(b.symptoms);

    const errors = v.collectErrors([logDate, flow, mood, note, visibility, symptoms]);
    if (errors.length) return badRequest(res, errors);

    db.get().prepare(`
      INSERT INTO cycle_day_logs (user_id, log_date, flow, symptoms, mood, note, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, log_date) DO UPDATE SET
        flow = excluded.flow, symptoms = excluded.symptoms, mood = excluded.mood,
        note = excluded.note, visibility = excluded.visibility
    `).run(viewer, logDate.value, flow.value, symptoms.value, mood.value, note.value, visibility.value || 'private');

    const row = db.get().prepare('SELECT * FROM cycle_day_logs WHERE user_id = ? AND log_date = ?').get(viewer, logDate.value);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error saving cycle log:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /cycle/logs/:id
router.delete('/cycle/logs/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare('SELECT id FROM cycle_day_logs WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Eintrag nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM cycle_day_logs WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting cycle log:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ---- Einstellungen (nur eigene) ----

/** Voreinstellungen, falls die Person noch keine Zeile hat. */
function defaultCycleSettings(userId) {
  return { user_id: userId, cycle_length_avg: null, period_length_avg: null, luteal_length: 14, track_fertility: 1, pregnancy_mode: 0, pregnancy_due_date: null, default_visibility: 'private' };
}

// GET /cycle/settings  (immer die eigenen; Vorhersagen sind persönlich)
router.get('/cycle/settings', (req, res) => {
  try {
    const viewer = viewerId(req);
    const row = db.get().prepare('SELECT * FROM cycle_settings WHERE user_id = ?').get(viewer);
    res.json({ data: row || defaultCycleSettings(viewer) });
  } catch (err) {
    log.error('Error loading cycle settings:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PUT /cycle/settings
router.put('/cycle/settings', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};

    const intInRange = (val, field, lo, hi) => {
      if (val === undefined || val === null || val === '') return { value: null, error: null };
      const n = Number(val);
      if (!Number.isInteger(n) || n < lo || n > hi) return { value: null, error: `${field} must be an integer between ${lo} and ${hi}.` };
      return { value: n, error: null };
    };
    const cycleLen  = intInRange(b.cycle_length_avg, 'cycle_length_avg', 15, 60);
    const periodLen = intInRange(b.period_length_avg, 'period_length_avg', 1, 15);
    const luteal    = intInRange(b.luteal_length, 'luteal_length', 8, 18);
    const track     = toBit(b.track_fertility);
    const pregnancy = toBit(b.pregnancy_mode);
    const dueDate   = v.date(b.pregnancy_due_date, 'pregnancy_due_date');
    const defVis    = v.oneOf(b.default_visibility, VISIBILITIES, 'default_visibility');

    const errors = v.collectErrors([cycleLen, periodLen, luteal, dueDate, defVis]);
    if (b.track_fertility !== undefined && track === undefined) errors.push('track_fertility must be a boolean.');
    if (b.pregnancy_mode !== undefined && pregnancy === undefined) errors.push('pregnancy_mode must be a boolean.');
    if (errors.length) return badRequest(res, errors);

    db.get().prepare(`
      INSERT INTO cycle_settings (user_id, cycle_length_avg, period_length_avg, luteal_length, track_fertility, pregnancy_mode, pregnancy_due_date, default_visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        cycle_length_avg = excluded.cycle_length_avg,
        period_length_avg = excluded.period_length_avg,
        luteal_length = excluded.luteal_length,
        track_fertility = excluded.track_fertility,
        pregnancy_mode = excluded.pregnancy_mode,
        pregnancy_due_date = excluded.pregnancy_due_date,
        default_visibility = excluded.default_visibility
    `).run(viewer, cycleLen.value, periodLen.value, luteal.value === null ? 14 : luteal.value,
           track === undefined ? 1 : track,
           pregnancy === undefined ? 0 : pregnancy,
           dueDate.value,
           defVis.value || 'private');

    res.json({ data: db.get().prepare('SELECT * FROM cycle_settings WHERE user_id = ?').get(viewer) });
  } catch (err) {
    log.error('Error saving cycle settings:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /cycle/visibility  — Bulk: setzt ALLE eigenen Zyklus-Einträge (Perioden +
// Tageslogs) auf eine Sichtbarkeit. Betrifft ausschließlich user_id = viewer;
// fremde Einträge bleiben unberührt. Ein Transaktions-Wrapper hält Perioden und
// Logs konsistent (entweder beide oder keine).
router.patch('/cycle/visibility', (req, res) => {
  try {
    const viewer = viewerId(req);
    const vis = v.oneOf(req.body?.visibility, VISIBILITIES, 'visibility');
    if (vis.error || !vis.value) return badRequest(res, [vis.error || 'visibility is required.']);

    const database = db.get();
    const applyBulk = database.transaction((value) => {
      const p = database.prepare('UPDATE cycle_periods  SET visibility = ? WHERE user_id = ?').run(value, viewer);
      const l = database.prepare('UPDATE cycle_day_logs SET visibility = ? WHERE user_id = ?').run(value, viewer);
      return { periods: p.changes, logs: l.changes };
    });
    res.json({ data: applyBulk(vis.value) });
  } catch (err) {
    log.error('Error bulk-updating cycle visibility:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /export/cycle?user_id=&from=&to=  (Perioden-Historie als CSV, chronologisch)
router.get('/export/cycle', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('p', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `SELECT p.* FROM cycle_periods p WHERE ${clause.sql}`;
    if (from) { sql += ' AND p.start_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND p.start_date <= ?'; params.push(to); }
    sql += ' ORDER BY p.start_date ASC, p.id ASC';

    const rows = db.get().prepare(sql).all(...params);
    sendCsv(res, exportFilename('cycle', from, to), cycleToCsv(rows));
  } catch (err) {
    log.error('Error exporting cycle:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
