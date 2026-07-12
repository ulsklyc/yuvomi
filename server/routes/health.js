/**
 * Modul: Gesundheit (Health)
 * Zweck: REST-API für Vitalwerte, Medikamente (+ Einnahmeplan/Dosis-Log),
 *        Laborbefunde (+ Analyten) und Aktivitäten.
 * Abhängigkeiten: express, server/db.js, server/middleware/validate.js
 *
 * Scoping/Visibility-Modell:
 *   - Jede Zeile gehört einem Nutzer (`user_id`, "Eigentümer").
 *   - Lesen: erlaubt für den Eigentümer ODER wenn `visibility = 'family'`.
 *   - Schreiben/Ändern/Löschen: ausschließlich der Eigentümer.
 *   - Verschachtelte Entitäten (Schedules/Logs, Lab-Results) erben Scoping/Visibility
 *     von ihrem Eltern-Datensatz (Medikament bzw. Befund).
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import * as v from '../middleware/validate.js';
import { vitalsToCsv, activitiesToCsv, labsToCsv, medLogsToCsv, cycleToCsv } from '../services/health-export.js';

const log    = createLogger('Health');
const router = express.Router();

const VISIBILITIES = ['private', 'family'];
const LOG_STATUS   = ['taken', 'skipped', 'pending'];
const FLOW_LEVELS  = ['spotting', 'light', 'medium', 'heavy'];
const MAX_UNIT     = 30;
const MAX_SYMPTOMS = 300;

// --------------------------------------------------------
// Helfer
// --------------------------------------------------------

function viewerId(req) {
  return req.authUserId || req.session.userId;
}

/**
 * Baut eine WHERE-Teilbedingung für Sichtbarkeit/Personen-Filter.
 * @param {string} alias         - Tabellen-Alias mit user_id + visibility
 * @param {number} viewer        - eingeloggter Nutzer
 * @param {number|null} personId  - optionaler Personen-Filter (?user_id=)
 * @returns {{ sql: string, params: any[] }}
 */
function visibilityClause(alias, viewer, personId) {
  if (personId) {
    if (personId === viewer) return { sql: `${alias}.user_id = ?`, params: [viewer] };
    return { sql: `${alias}.user_id = ? AND ${alias}.visibility = 'family'`, params: [personId] };
  }
  return { sql: `(${alias}.user_id = ? OR ${alias}.visibility = 'family')`, params: [viewer] };
}

/** Koerziert einen Boolean/0/1-Wert zu 0|1 oder undefined (= nicht gesetzt). */
function toBit(val) {
  if (val === undefined || val === null || val === '') return undefined;
  if (val === true  || val === 1 || val === '1' || val === 'true')  return 1;
  if (val === false || val === 0 || val === '0' || val === 'false') return 0;
  return undefined;
}

/** Führt ein partielles UPDATE mit einer Whitelist bereits validierter Felder aus. */
function applyUpdate(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  db.get().prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

/** Leitet ein Referenz-Flag (low/normal/high) ab, sofern nicht explizit gesetzt. */
function deriveFlag(value, refLow, refHigh, provided) {
  if (provided) return provided;
  if (value === null || value === undefined) return null;
  if (refLow !== null && refLow !== undefined && value < refLow)  return 'low';
  if (refHigh !== null && refHigh !== undefined && value > refHigh) return 'high';
  if ((refLow !== null && refLow !== undefined) || (refHigh !== null && refHigh !== undefined)) return 'normal';
  return null;
}

/** Lädt ein Medikament, wenn der Betrachter es lesen darf; sonst null. */
function medicationForRead(medId, viewer) {
  return db.get().prepare(
    `SELECT * FROM medications WHERE id = ? AND (user_id = ? OR visibility = 'family')`
  ).get(medId, viewer) || null;
}

/** Lädt ein dem Betrachter gehörendes Medikament; sonst null. */
function medicationOwned(medId, viewer) {
  return db.get().prepare('SELECT * FROM medications WHERE id = ? AND user_id = ?')
    .get(medId, viewer) || null;
}

/** Lädt einen Laborbefund, wenn der Betrachter ihn lesen darf; sonst null. */
function reportForRead(reportId, viewer) {
  return db.get().prepare(
    `SELECT * FROM health_lab_reports WHERE id = ? AND (user_id = ? OR visibility = 'family')`
  ).get(reportId, viewer) || null;
}

/** Lädt einen dem Betrachter gehörenden Laborbefund; sonst null. */
function reportOwned(reportId, viewer) {
  return db.get().prepare('SELECT * FROM health_lab_reports WHERE id = ? AND user_id = ?')
    .get(reportId, viewer) || null;
}

function badRequest(res, errors) {
  return res.status(400).json({ error: errors.join(' '), code: 400 });
}

// ========================================================
// VITALWERTE
// ========================================================

// GET /vitals?user_id=&type=&from=&to=
router.get('/vitals', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('v', viewer, personId);
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
    const measuredAt = v.datetime(b.measured_at, 'measured_at', true);
    const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([type, valueNum, valueNum2, valueNum3, unit, measuredAt, note, visibility]);
    if (errors.length) return badRequest(res, errors);

    const result = db.get().prepare(`
      INSERT INTO health_vitals (user_id, type, value_num, value_num2, value_num3, unit, measured_at, note, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(viewer, type.value, valueNum.value, valueNum2.value, valueNum3.value,
           unit.value, measuredAt.value, note.value, visibility.value || 'private');

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

    const existing = db.get().prepare('SELECT * FROM health_vitals WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Vitalwert nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.type !== undefined)        { const r = v.str(b.type, 'type', { max: 50 });               checks.push(r); if (!r.error) fields.type = r.value; }
    if (b.value_num !== undefined)   { const r = v.num(b.value_num,  'value_num');                 checks.push(r); if (!r.error) fields.value_num = r.value; }
    if (b.value_num2 !== undefined)  { const r = v.num(b.value_num2, 'value_num2');                checks.push(r); if (!r.error) fields.value_num2 = r.value; }
    if (b.value_num3 !== undefined)  { const r = v.num(b.value_num3, 'value_num3');                checks.push(r); if (!r.error) fields.value_num3 = r.value; }
    if (b.unit !== undefined)        { const r = v.str(b.unit, 'unit', { max: MAX_UNIT, required: false }); checks.push(r); if (!r.error) fields.unit = r.value; }
    if (b.measured_at !== undefined) { const r = v.datetime(b.measured_at, 'measured_at', true);   checks.push(r); if (!r.error) fields.measured_at = r.value; }
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

    const existing = db.get().prepare('SELECT id FROM health_vitals WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Vitalwert nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM health_vitals WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting vital:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ========================================================
// MEDIKAMENTE
// ========================================================

// GET /medications?user_id=&active=
router.get('/medications', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('m', viewer, personId);
    const params   = [...clause.params];
    let sql = `SELECT m.* FROM medications m WHERE ${clause.sql}`;

    const activeBit = toBit(req.query.active);
    if (activeBit !== undefined) { sql += ' AND m.active = ?'; params.push(activeBit); }

    sql += ' ORDER BY m.active DESC, m.name COLLATE NOCASE ASC, m.id DESC';
    res.json({ data: db.get().prepare(sql).all(...params) });
  } catch (err) {
    log.error('Error listing medications:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /medications
router.post('/medications', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const name       = v.str(b.name, 'name', { max: v.MAX_TITLE });
    const dosageText = v.str(b.dosage_text, 'dosage_text', { max: v.MAX_SHORT, required: false });
    const form       = v.str(b.form, 'form', { max: MAX_UNIT, required: false });
    const stockQty   = v.num(b.stock_qty, 'stock_qty');
    const stockUnit  = v.str(b.stock_unit, 'stock_unit', { max: MAX_UNIT, required: false });
    const refill     = v.num(b.refill_threshold, 'refill_threshold');
    const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([name, dosageText, form, stockQty, stockUnit, refill, note, visibility]);
    if (errors.length) return badRequest(res, errors);

    const active = toBit(b.active); // undefined → default 1
    const prn    = toBit(b.prn);    // undefined → default 0

    const result = db.get().prepare(`
      INSERT INTO medications (user_id, name, dosage_text, form, active, prn, stock_qty, stock_unit, refill_threshold, note, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(viewer, name.value, dosageText.value, form.value,
           active === undefined ? 1 : active, prn === undefined ? 0 : prn,
           stockQty.value, stockUnit.value, refill.value, note.value, visibility.value || 'private');

    const row = db.get().prepare('SELECT * FROM medications WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating medication:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /medications/:id
router.patch('/medications/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = medicationOwned(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Medikament nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.name !== undefined)             { const r = v.str(b.name, 'name', { max: v.MAX_TITLE });                      checks.push(r); if (!r.error) fields.name = r.value; }
    if (b.dosage_text !== undefined)      { const r = v.str(b.dosage_text, 'dosage_text', { max: v.MAX_SHORT, required: false }); checks.push(r); if (!r.error) fields.dosage_text = r.value; }
    if (b.form !== undefined)             { const r = v.str(b.form, 'form', { max: MAX_UNIT, required: false });        checks.push(r); if (!r.error) fields.form = r.value; }
    if (b.stock_qty !== undefined)        { const r = v.num(b.stock_qty, 'stock_qty');                                  checks.push(r); if (!r.error) fields.stock_qty = r.value; }
    if (b.stock_unit !== undefined)       { const r = v.str(b.stock_unit, 'stock_unit', { max: MAX_UNIT, required: false }); checks.push(r); if (!r.error) fields.stock_unit = r.value; }
    if (b.refill_threshold !== undefined) { const r = v.num(b.refill_threshold, 'refill_threshold');                    checks.push(r); if (!r.error) fields.refill_threshold = r.value; }
    if (b.note !== undefined)             { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });      checks.push(r); if (!r.error) fields.note = r.value; }
    if (b.visibility !== undefined)       { const r = v.oneOf(b.visibility, VISIBILITIES, 'visibility');                checks.push(r); if (!r.error && r.value) fields.visibility = r.value; }
    if (b.active !== undefined) { const bit = toBit(b.active); if (bit === undefined) checks.push({ error: 'active must be a boolean.' }); else fields.active = bit; }
    if (b.prn !== undefined)    { const bit = toBit(b.prn);    if (bit === undefined) checks.push({ error: 'prn must be a boolean.' });    else fields.prn = bit; }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    applyUpdate('medications', id, fields);
    res.json({ data: db.get().prepare('SELECT * FROM medications WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating medication:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /medications/:id
router.delete('/medications/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = medicationOwned(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Medikament nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM medications WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting medication:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ---- Einnahmeplan (Schedules) ----

// GET /medications/:id/schedules
router.get('/medications/:id/schedules', (req, res) => {
  try {
    const viewer = viewerId(req);
    const medId = parseInt(req.params.id, 10);
    if (!medId) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    if (!medicationForRead(medId, viewer)) return res.status(404).json({ error: 'Medikament nicht gefunden.', code: 404 });

    const rows = db.get().prepare(
      'SELECT * FROM medication_schedules WHERE medication_id = ? ORDER BY time_of_day ASC, id ASC'
    ).all(medId);
    res.json({ data: rows });
  } catch (err) {
    log.error('Error listing schedules:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /medications/:id/schedules
router.post('/medications/:id/schedules', (req, res) => {
  try {
    const viewer = viewerId(req);
    const medId = parseInt(req.params.id, 10);
    if (!medId) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    if (!medicationOwned(medId, viewer)) return res.status(404).json({ error: 'Medikament nicht gefunden.', code: 404 });

    const b = req.body || {};
    const timeOfDay = v.time(b.time_of_day, 'time_of_day');
    const dose      = v.num(b.dose_qty, 'dose_qty');
    const startDate = v.date(b.start_date, 'start_date');
    const endDate   = v.date(b.end_date, 'end_date');

    const checks = [timeOfDay, dose, startDate, endDate];
    if (!b.time_of_day) checks.push({ error: 'time_of_day is required.' });

    let daysMask = null;
    if (b.days_mask !== undefined && b.days_mask !== null && b.days_mask !== '') {
      const n = Number(b.days_mask);
      if (!Number.isInteger(n) || n < 0 || n > 127) checks.push({ error: 'days_mask must be an integer between 0 and 127.' });
      else daysMask = n;
    }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    const active = toBit(b.active);
    const result = db.get().prepare(`
      INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, dose_qty, start_date, end_date, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(medId, timeOfDay.value, daysMask, dose.value, startDate.value, endDate.value,
           active === undefined ? 1 : active);

    const row = db.get().prepare('SELECT * FROM medication_schedules WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating schedule:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /schedules/:id
router.patch('/schedules/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare(`
      SELECT s.* FROM medication_schedules s
      JOIN medications m ON m.id = s.medication_id
      WHERE s.id = ? AND m.user_id = ?
    `).get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Einnahmeplan nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.time_of_day !== undefined) { const r = v.time(b.time_of_day, 'time_of_day'); checks.push(r); if (!b.time_of_day) checks.push({ error: 'time_of_day must not be empty.' }); else if (!r.error) fields.time_of_day = r.value; }
    if (b.dose_qty !== undefined)    { const r = v.num(b.dose_qty, 'dose_qty');    checks.push(r); if (!r.error) fields.dose_qty = r.value; }
    if (b.start_date !== undefined)  { const r = v.date(b.start_date, 'start_date'); checks.push(r); if (!r.error) fields.start_date = r.value; }
    if (b.end_date !== undefined)    { const r = v.date(b.end_date, 'end_date');   checks.push(r); if (!r.error) fields.end_date = r.value; }
    if (b.active !== undefined)      { const bit = toBit(b.active); if (bit === undefined) checks.push({ error: 'active must be a boolean.' }); else fields.active = bit; }
    if (b.days_mask !== undefined) {
      if (b.days_mask === null || b.days_mask === '') { fields.days_mask = null; }
      else {
        const n = Number(b.days_mask);
        if (!Number.isInteger(n) || n < 0 || n > 127) checks.push({ error: 'days_mask must be an integer between 0 and 127.' });
        else fields.days_mask = n;
      }
    }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    applyUpdate('medication_schedules', id, fields);
    res.json({ data: db.get().prepare('SELECT * FROM medication_schedules WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating schedule:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /schedules/:id
router.delete('/schedules/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare(`
      SELECT s.id FROM medication_schedules s
      JOIN medications m ON m.id = s.medication_id
      WHERE s.id = ? AND m.user_id = ?
    `).get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Einnahmeplan nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM medication_schedules WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting schedule:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ---- Dosis-Log (Logs) ----

// GET /medications/:id/logs?from=&to=
router.get('/medications/:id/logs', (req, res) => {
  try {
    const viewer = viewerId(req);
    const medId = parseInt(req.params.id, 10);
    if (!medId) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    if (!medicationForRead(medId, viewer)) return res.status(404).json({ error: 'Medikament nicht gefunden.', code: 404 });

    const params = [medId];
    let sql = 'SELECT * FROM medication_logs WHERE medication_id = ?';
    if (req.query.from) { sql += ' AND scheduled_at >= ?'; params.push(String(req.query.from)); }
    if (req.query.to)   { sql += ' AND scheduled_at <= ?'; params.push(String(req.query.to)); }
    sql += ' ORDER BY COALESCE(scheduled_at, created_at) DESC, id DESC';

    res.json({ data: db.get().prepare(sql).all(...params) });
  } catch (err) {
    log.error('Error listing logs:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /medications/:id/logs
router.post('/medications/:id/logs', (req, res) => {
  try {
    const viewer = viewerId(req);
    const medId = parseInt(req.params.id, 10);
    if (!medId) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    if (!medicationOwned(medId, viewer)) return res.status(404).json({ error: 'Medikament nicht gefunden.', code: 404 });

    const b = req.body || {};
    const scheduledAt = v.datetime(b.scheduled_at, 'scheduled_at');
    const status      = v.oneOf(b.status, LOG_STATUS, 'status');
    const takenAt     = v.datetime(b.taken_at, 'taken_at');
    const dose        = v.num(b.dose_qty, 'dose_qty');
    const note        = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });

    const checks = [scheduledAt, status, takenAt, dose, note];
    let scheduleId = null;
    if (b.schedule_id !== undefined && b.schedule_id !== null && b.schedule_id !== '') {
      const sid = parseInt(b.schedule_id, 10);
      const owned = db.get().prepare(
        'SELECT id FROM medication_schedules WHERE id = ? AND medication_id = ?'
      ).get(sid, medId);
      if (!owned) checks.push({ error: 'schedule_id does not belong to this medication.' });
      else scheduleId = sid;
    }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    const result = db.get().prepare(`
      INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, taken_at, dose_qty, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(medId, scheduleId, scheduledAt.value, status.value || 'pending', takenAt.value, dose.value, note.value);

    const row = db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating log:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

/** Gemeinsame Logik für take/skip: Status setzen und Log zurückgeben. */
function updateLogStatus(req, res, newStatus) {
  const viewer = viewerId(req);
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

  const logRow = db.get().prepare(`
    SELECT l.*, m.user_id AS owner_id FROM medication_logs l
    JOIN medications m ON m.id = l.medication_id
    WHERE l.id = ? AND m.user_id = ?
  `).get(id, viewer);
  if (!logRow) return res.status(404).json({ error: 'Dosis-Eintrag nicht gefunden.', code: 404 });

  const b = req.body || {};
  if (newStatus === 'taken') {
    const takenAt = v.datetime(b.taken_at, 'taken_at');
    if (takenAt.error) return badRequest(res, [takenAt.error]);
    const when = takenAt.value || new Date().toISOString();
    db.get().prepare('UPDATE medication_logs SET status = ?, taken_at = ? WHERE id = ?').run('taken', when, id);
  } else {
    db.get().prepare('UPDATE medication_logs SET status = ?, taken_at = NULL WHERE id = ?').run('skipped', id);
  }

  res.json({ data: db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(id) });
}

// POST /logs/:id/take
router.post('/logs/:id/take', (req, res) => {
  try { updateLogStatus(req, res, 'taken'); }
  catch (err) { log.error('Error taking dose:', err.message); res.status(500).json({ error: 'Internal error.', code: 500 }); }
});

// POST /logs/:id/skip
router.post('/logs/:id/skip', (req, res) => {
  try { updateLogStatus(req, res, 'skipped'); }
  catch (err) { log.error('Error skipping dose:', err.message); res.status(500).json({ error: 'Internal error.', code: 500 }); }
});

// ========================================================
// LABORWERTE
// ========================================================

function attachResults(report) {
  if (!report) return report;
  report.results = db.get().prepare(
    'SELECT * FROM health_lab_results WHERE report_id = ? ORDER BY analyte COLLATE NOCASE ASC, id ASC'
  ).all(report.id);
  return report;
}

// GET /labs?user_id=&from=&to=
router.get('/labs', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('r', viewer, personId);
    const params   = [...clause.params];
    let sql = `SELECT r.* FROM health_lab_reports r WHERE ${clause.sql}`;

    if (req.query.from) { sql += ' AND r.report_date >= ?'; params.push(String(req.query.from)); }
    if (req.query.to)   { sql += ' AND r.report_date <= ?'; params.push(String(req.query.to)); }
    sql += ' ORDER BY r.report_date DESC, r.id DESC';

    const reports = db.get().prepare(sql).all(...params).map(attachResults);
    res.json({ data: reports });
  } catch (err) {
    log.error('Error listing lab reports:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /labs/:id
router.get('/labs/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const report = reportForRead(id, viewer);
    if (!report) return res.status(404).json({ error: 'Befund nicht gefunden.', code: 404 });
    res.json({ data: attachResults(report) });
  } catch (err) {
    log.error('Error loading lab report:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

/** Validiert eine einzelne Analyt-Zeile; gibt { row, error } zurück. */
function validateResult(raw) {
  const analyte = v.str(raw.analyte, 'analyte', { max: v.MAX_SHORT });
  const value   = v.num(raw.value_num, 'value_num');
  const unit    = v.str(raw.unit, 'unit', { max: MAX_UNIT, required: false });
  const refLow  = v.num(raw.ref_low, 'ref_low');
  const refHigh = v.num(raw.ref_high, 'ref_high');
  const flag    = v.oneOf(raw.flag, ['low', 'normal', 'high'], 'flag');

  const errors = v.collectErrors([analyte, value, unit, refLow, refHigh, flag]);
  if (errors.length) return { row: null, error: errors.join(' ') };

  return {
    row: {
      analyte: analyte.value,
      value_num: value.value,
      unit: unit.value,
      ref_low: refLow.value,
      ref_high: refHigh.value,
      flag: deriveFlag(value.value, refLow.value, refHigh.value, flag.value),
    },
    error: null,
  };
}

// POST /labs  (body: report_date, lab_name?, note?, visibility?, results?[])
router.post('/labs', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const reportDate = v.date(b.report_date, 'report_date', true);
    const labName    = v.str(b.lab_name, 'lab_name', { max: v.MAX_TITLE, required: false });
    const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([reportDate, labName, note, visibility]);
    if (errors.length) return badRequest(res, errors);

    const rawResults = Array.isArray(b.results) ? b.results : [];
    const preparedResults = [];
    for (const raw of rawResults) {
      const { row, error } = validateResult(raw || {});
      if (error) return badRequest(res, [error]);
      preparedResults.push(row);
    }

    const insertReport = db.get().prepare(`
      INSERT INTO health_lab_reports (user_id, report_date, lab_name, note, visibility)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertResult = db.get().prepare(`
      INSERT INTO health_lab_results (report_id, analyte, value_num, unit, ref_low, ref_high, flag)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.get().transaction(() => {
      const rep = insertReport.run(viewer, reportDate.value, labName.value, note.value, visibility.value || 'private');
      const reportId = rep.lastInsertRowid;
      for (const r of preparedResults) {
        insertResult.run(reportId, r.analyte, r.value_num, r.unit, r.ref_low, r.ref_high, r.flag);
      }
      return reportId;
    });
    const reportId = tx();

    const report = attachResults(db.get().prepare('SELECT * FROM health_lab_reports WHERE id = ?').get(reportId));
    res.status(201).json({ data: report });
  } catch (err) {
    log.error('Error creating lab report:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /labs/:id  (Kopf-Felder; Analyten via nested endpoints)
router.patch('/labs/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = reportOwned(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Befund nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.report_date !== undefined) { const r = v.date(b.report_date, 'report_date', true); checks.push(r); if (!r.error) fields.report_date = r.value; }
    if (b.lab_name !== undefined)    { const r = v.str(b.lab_name, 'lab_name', { max: v.MAX_TITLE, required: false }); checks.push(r); if (!r.error) fields.lab_name = r.value; }
    if (b.note !== undefined)        { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
    if (b.visibility !== undefined)  { const r = v.oneOf(b.visibility, VISIBILITIES, 'visibility'); checks.push(r); if (!r.error && r.value) fields.visibility = r.value; }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    applyUpdate('health_lab_reports', id, fields);
    res.json({ data: attachResults(db.get().prepare('SELECT * FROM health_lab_reports WHERE id = ?').get(id)) });
  } catch (err) {
    log.error('Error updating lab report:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /labs/:id
router.delete('/labs/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = reportOwned(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Befund nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM health_lab_reports WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting lab report:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /labs/:id/results
router.post('/labs/:id/results', (req, res) => {
  try {
    const viewer = viewerId(req);
    const reportId = parseInt(req.params.id, 10);
    if (!reportId) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    if (!reportOwned(reportId, viewer)) return res.status(404).json({ error: 'Befund nicht gefunden.', code: 404 });

    const { row, error } = validateResult(req.body || {});
    if (error) return badRequest(res, [error]);

    const result = db.get().prepare(`
      INSERT INTO health_lab_results (report_id, analyte, value_num, unit, ref_low, ref_high, flag)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reportId, row.analyte, row.value_num, row.unit, row.ref_low, row.ref_high, row.flag);

    res.status(201).json({ data: db.get().prepare('SELECT * FROM health_lab_results WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    log.error('Error creating lab result:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /results/:id
router.delete('/results/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare(`
      SELECT res.id FROM health_lab_results res
      JOIN health_lab_reports r ON r.id = res.report_id
      WHERE res.id = ? AND r.user_id = ?
    `).get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Analyt nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM health_lab_results WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting lab result:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ========================================================
// AKTIVITÄTEN
// ========================================================

// GET /activities?user_id=&type=&from=&to=
router.get('/activities', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('a', viewer, personId);
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
    const performedAt = v.datetime(b.performed_at, 'performed_at', true);
    const note        = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility  = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([type, duration, distance, intensity, calories, performedAt, note, visibility]);
    if (errors.length) return badRequest(res, errors);

    const result = db.get().prepare(`
      INSERT INTO health_activities (user_id, type, duration_min, distance_km, intensity, calories, performed_at, note, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(viewer, type.value, duration.value, distance.value, intensity.value, calories.value,
           performedAt.value, note.value, visibility.value || 'private');

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

    const existing = db.get().prepare('SELECT * FROM health_activities WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Aktivität nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.type !== undefined)         { const r = v.str(b.type, 'type', { max: 50 });                          checks.push(r); if (!r.error) fields.type = r.value; }
    if (b.duration_min !== undefined) { const r = v.num(b.duration_min, 'duration_min');                       checks.push(r); if (!r.error) fields.duration_min = r.value; }
    if (b.distance_km !== undefined)  { const r = v.num(b.distance_km, 'distance_km');                         checks.push(r); if (!r.error) fields.distance_km = r.value; }
    if (b.intensity !== undefined)    { const r = v.str(b.intensity, 'intensity', { max: MAX_UNIT, required: false }); checks.push(r); if (!r.error) fields.intensity = r.value; }
    if (b.calories !== undefined)     { const r = v.num(b.calories, 'calories');                               checks.push(r); if (!r.error) fields.calories = r.value; }
    if (b.performed_at !== undefined) { const r = v.datetime(b.performed_at, 'performed_at', true);            checks.push(r); if (!r.error) fields.performed_at = r.value; }
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

    const existing = db.get().prepare('SELECT id FROM health_activities WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Aktivität nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM health_activities WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting activity:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ========================================================
// CSV-EXPORT (Übersicht)
// ========================================================
//
// Je Bereich ein GET-Endpunkt, der text/csv als Download liefert. Scoping und
// Visibility greifen identisch zu den List-Routen (visibilityClause); der
// optionale ?from=&to=-Zeitraum filtert auf das jeweilige Datumsfeld. Die
// CSV-Serialisierung liegt im testbaren Helfer server/services/health-export.js.

/** Baut den Dateinamen aus Bereich + optionalem Zeitraum. */
function exportFilename(area, from, to) {
  const range = from && to ? `-${from}_${to}` : '';
  return `health-${area}${range}.csv`;
}

/** Sendet eine CSV-Nutzlast als Download (BOM für Excel). */
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${csv}`);
}

/** Liest optionale from/to-Query als YYYY-MM-DD (nur wenn plausibel). */
function exportRange(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : null;
  return { from, to };
}

// GET /export/vitals?user_id=&from=&to=
router.get('/export/vitals', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('v', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `SELECT v.* FROM health_vitals v WHERE ${clause.sql}`;
    if (from) { sql += ' AND v.measured_at >= ?'; params.push(`${from}T00:00`); }
    if (to)   { sql += ' AND v.measured_at <= ?'; params.push(`${to}T23:59`); }
    sql += ' ORDER BY v.measured_at ASC, v.id ASC';

    const rows = db.get().prepare(sql).all(...params);
    sendCsv(res, exportFilename('vitals', from, to), vitalsToCsv(rows));
  } catch (err) {
    log.error('Error exporting vitals:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /export/activities?user_id=&from=&to=
router.get('/export/activities', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('a', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `SELECT a.* FROM health_activities a WHERE ${clause.sql}`;
    if (from) { sql += ' AND a.performed_at >= ?'; params.push(`${from}T00:00`); }
    if (to)   { sql += ' AND a.performed_at <= ?'; params.push(`${to}T23:59`); }
    sql += ' ORDER BY a.performed_at ASC, a.id ASC';

    const rows = db.get().prepare(sql).all(...params);
    sendCsv(res, exportFilename('activities', from, to), activitiesToCsv(rows));
  } catch (err) {
    log.error('Error exporting activities:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /export/labs?user_id=&from=&to=
router.get('/export/labs', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('r', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `SELECT r.* FROM health_lab_reports r WHERE ${clause.sql}`;
    if (from) { sql += ' AND r.report_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND r.report_date <= ?'; params.push(to); }
    sql += ' ORDER BY r.report_date ASC, r.id ASC';

    const reports = db.get().prepare(sql).all(...params).map(attachResults);
    sendCsv(res, exportFilename('labs', from, to), labsToCsv(reports));
  } catch (err) {
    log.error('Error exporting labs:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /export/meds-logs?user_id=&from=&to=
router.get('/export/meds-logs', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('m', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `
      SELECT l.*, m.name AS medication_name FROM medication_logs l
      JOIN medications m ON m.id = l.medication_id
      WHERE ${clause.sql}`;
    if (from) { sql += ' AND l.scheduled_at >= ?'; params.push(`${from}T00:00`); }
    if (to)   { sql += ' AND l.scheduled_at <= ?'; params.push(`${to}T23:59`); }
    sql += ' ORDER BY COALESCE(l.scheduled_at, l.created_at) ASC, l.id ASC';

    const rows = db.get().prepare(sql).all(...params);
    sendCsv(res, exportFilename('meds-logs', from, to), medLogsToCsv(rows));
  } catch (err) {
    log.error('Error exporting medication logs:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ========================================================
// ZYKLUS (Menstruation)
// ========================================================
//
// Drei Ressourcen, alle mit dem üblichen Visibility-Scoping (Eigentümer + optional
// 'family' für den Personen-Umschalter): Perioden-Episoden (cycle_periods),
// Tages-Logs (cycle_day_logs, genau ein Eintrag je Person/Tag → Upsert) und die
// per-Person-Einstellungen (cycle_settings, nur der Eigentümer selbst). Die
// Vorhersage-Logik (nächste Periode, Eisprung, fruchtbares Fenster) liegt bewusst
// rein clientseitig in public/utils/health-cycle.js — der Server speichert nur.

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
  return { user_id: userId, cycle_length_avg: null, period_length_avg: null, luteal_length: 14, track_fertility: 1, pregnancy_mode: 0, pregnancy_due_date: null };
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

    const errors = v.collectErrors([cycleLen, periodLen, luteal, dueDate]);
    if (b.track_fertility !== undefined && track === undefined) errors.push('track_fertility must be a boolean.');
    if (b.pregnancy_mode !== undefined && pregnancy === undefined) errors.push('pregnancy_mode must be a boolean.');
    if (errors.length) return badRequest(res, errors);

    db.get().prepare(`
      INSERT INTO cycle_settings (user_id, cycle_length_avg, period_length_avg, luteal_length, track_fertility, pregnancy_mode, pregnancy_due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        cycle_length_avg = excluded.cycle_length_avg,
        period_length_avg = excluded.period_length_avg,
        luteal_length = excluded.luteal_length,
        track_fertility = excluded.track_fertility,
        pregnancy_mode = excluded.pregnancy_mode,
        pregnancy_due_date = excluded.pregnancy_due_date
    `).run(viewer, cycleLen.value, periodLen.value, luteal.value === null ? 14 : luteal.value,
           track === undefined ? 1 : track,
           pregnancy === undefined ? 0 : pregnancy,
           pregnancy ? dueDate.value : null);

    res.json({ data: db.get().prepare('SELECT * FROM cycle_settings WHERE user_id = ?').get(viewer) });
  } catch (err) {
    log.error('Error saving cycle settings:', err.message);
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
