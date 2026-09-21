/**
 * Modul: Gesundheit (Health) - Medikamente
 * Zweck: REST-API für Medikamente (medications), deren Einnahmeplan
 *        (medication_schedules) sowie das Dosis-Log (medication_logs) inkl.
 *        take/skip-Statuswechsel.
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../middleware/validate.js';
import { defaultVisibilityFor } from './visibility-defaults.js';
import {
  log, VISIBILITIES, LOG_STATUS, MAX_UNIT,
  viewerId, careAwareClause, toBit, applyUpdate, badRequest,
  resolveOwner, writableClause, writableChild, wallClockInput,
} from './helpers.js';

const router = express.Router();

// Ein Mindestabstand von mehr als vier Wochen beschreibt keine Bedarfsdosis
// mehr, sondern einen Zeitplan - und ein negativer oder 0 ergaebe einen
// Countdown, der immer abgelaufen ist. Die Grenze liegt deshalb hier und nicht
// erst im Formular (#700).
const MAX_INTERVAL_HOURS = 24 * 28;

/**
 * Bedarfsdosis: leer erlaubt, sonst nicht negativ.
 *
 * `v.num` nimmt negative Zahlen ausdruecklich an (Budget rechnet damit), und der
 * Bestandsabzug rechnet `stock_qty - dose`: eine Dosis von -2 wuerde den Bestand
 * bei jeder Einnahme ERHOEHEN. Das Formularfeld sperrt das ohnehin, ein
 * API-Token oder MCP-Client nicht.
 */
function prnDose(raw) {
  const r = v.num(raw, 'prn_dose_qty');
  if (r.error || r.value === null) return r;
  if (r.value < 0) return { value: null, error: 'prn_dose_qty must not be negative.' };
  return r;
}

/** Mindestabstand in Stunden: leer erlaubt, sonst > 0 und hoechstens 28 Tage. */
function prnInterval(raw) {
  const r = v.num(raw, 'min_interval_hours');
  if (r.error || r.value === null) return r;
  if (r.value <= 0 || r.value > MAX_INTERVAL_HOURS) {
    return { value: null, error: `min_interval_hours must be greater than 0 and at most ${MAX_INTERVAL_HOURS}.` };
  }
  return r;
}

// Diese beiden Helfer sind der einzige Zugang zu einem Medikament: Plaene und
// Einnahmeprotokolle haengen daran und erben ihr Scoping von hier. Die Betreuung
// (#584) greift deshalb an genau zwei Stellen statt in jeder der neun
// Schreibrouten.

/** Lädt ein Medikament, wenn der Betrachter es lesen darf; sonst null. */
function medicationForRead(medId, viewer) {
  const w = writableClause('', viewer);
  return db.get().prepare(
    `SELECT * FROM medications WHERE id = ? AND (visibility = 'family' OR ${w.sql})`
  ).get(medId, ...w.params) || null;
}

/** Lädt ein Medikament, das der Betrachter ändern darf (eigenes oder betreutes). */
function medicationWritable(medId, viewer) {
  const w = writableClause('', viewer);
  return db.get().prepare(`SELECT * FROM medications WHERE id = ? AND ${w.sql}`)
    .get(medId, ...w.params) || null;
}

// GET /medications?user_id=&active=
router.get('/medications', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = careAwareClause('m', viewer, personId);
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
    const interval   = prnInterval(b.min_interval_hours);
    const prnDoseQty = prnDose(b.prn_dose_qty);

    const errors = v.collectErrors([name, dosageText, form, stockQty, stockUnit, refill, note, visibility, interval, prnDoseQty]);
    if (errors.length) return badRequest(res, errors);

    const active = toBit(b.active); // undefined → default 1
    const prn    = toBit(b.prn);    // undefined → default 0

    // Optionales user_id: eine betreuende Person legt das Medikament fuer die
    // betreute an (#584) - der Alltagsfall aus der Meldung.
    const owner = resolveOwner(req, viewer);
    if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

    const result = db.get().prepare(`
      INSERT INTO medications (user_id, name, dosage_text, form, active, prn, stock_qty, stock_unit, refill_threshold, note, visibility,
                               min_interval_hours, prn_dose_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(owner.ownerId, name.value, dosageText.value, form.value,
           active === undefined ? 1 : active, prn === undefined ? 0 : prn,
           stockQty.value, stockUnit.value, refill.value, note.value,
           visibility.value || defaultVisibilityFor(db.get(), owner.ownerId, 'meds'),
           interval.value, prnDoseQty.value);

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

    const existing = medicationWritable(id, viewer);
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
    if (b.min_interval_hours !== undefined) { const r = prnInterval(b.min_interval_hours); checks.push(r); if (!r.error) fields.min_interval_hours = r.value; }
    if (b.prn_dose_qty !== undefined)       { const r = prnDose(b.prn_dose_qty); checks.push(r); if (!r.error) fields.prn_dose_qty = r.value; }

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

    const existing = medicationWritable(id, viewer);
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
    if (!medicationWritable(medId, viewer)) return res.status(404).json({ error: 'Medikament nicht gefunden.', code: 404 });

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

    const existing = writableChild(`
      SELECT s.* FROM medication_schedules s
      JOIN medications m ON m.id = s.medication_id
      WHERE s.id = ?
    `, 'm', id, viewer);
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

    const existing = writableChild(`
      SELECT s.id FROM medication_schedules s
      JOIN medications m ON m.id = s.medication_id
      WHERE s.id = ?
    `, 'm', id, viewer);
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

    // Gefiltert wird ueber denselben Ausdruck, nach dem auch sortiert wird.
    // Vorher stand hier `scheduled_at`, und weil eine Bedarfsdosis keinen
    // Zeitplan hat, ist die Spalte bei ihr NULL - jeder Vergleich damit ist
    // unbekannt, also fiel sie aus JEDEM Zeitraum heraus. Sichtbar war das
    // bisher kaum, weil sich eine Bedarfsdosis gar nicht buchen liess (#700);
    // seit sie es tut, waere ihr Eintrag im Protokoll unauffindbar und der
    // Countdown haette nichts, woraus er rechnet.
    //
    // Verglichen wird auf 'YYYY-MM-DDTHH:MM' zugeschnitten, weil in derselben
    // Spalte zwei Schreibweisen liegen: `scheduled_at` fuehrt Wanduhrzeit ohne
    // Zone, `created_at` endet auf 'Z' und traegt Sekunden. Ohne den Schnitt
    // waere '…T23:59:30Z' groesser als die Obergrenze '…T23:59' und die Dosis
    // der letzten Minute des Tages fiele aus ihrem eigenen Tag heraus.
    const WHEN = 'COALESCE(scheduled_at, taken_at, created_at)';
    const params = [medId];
    let sql = `SELECT * FROM medication_logs WHERE medication_id = ?`;
    if (req.query.from) { sql += ` AND substr(${WHEN}, 1, 16) >= ?`; params.push(String(req.query.from).slice(0, 16)); }
    if (req.query.to)   { sql += ` AND substr(${WHEN}, 1, 16) <= ?`; params.push(String(req.query.to).slice(0, 16)); }
    sql += ` ORDER BY ${WHEN} DESC, id DESC`;

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
    if (!medicationWritable(medId, viewer)) return res.status(404).json({ error: 'Medikament nicht gefunden.', code: 404 });

    const b = req.body || {};
    const wall        = wallClockInput();
    const scheduledAt = v.datetime(b.scheduled_at, 'scheduled_at', false, wall);
    const status      = v.oneOf(b.status, LOG_STATUS, 'status');
    const takenAt     = v.datetime(b.taken_at, 'taken_at', false, wall);
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

  const logRow = ownLogRow(id, viewer);
  if (!logRow) return res.status(404).json({ error: 'Dosis-Eintrag nicht gefunden.', code: 404 });

  const b = req.body || {};
  if (newStatus === 'taken') {
    const takenAt = v.datetime(b.taken_at, 'taken_at', false, wallClockInput());
    if (takenAt.error) return badRequest(res, [takenAt.error]);
    const when = takenAt.value || new Date().toISOString();
    db.get().prepare('UPDATE medication_logs SET status = ?, taken_at = ? WHERE id = ?').run('taken', when, id);
  } else {
    db.get().prepare('UPDATE medication_logs SET status = ?, taken_at = NULL WHERE id = ?').run('skipped', id);
  }

  res.json({ data: db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(id) });
}

/**
 * Der Log-Eintrag samt Besitzer, oder null.
 *
 * Bewusst über das Schreibrecht am Medikament und nicht über die Sichtbarkeit:
 * ein Dosis-Eintrag ist eine Aufzeichnung über den eigenen Körper. Wer ein
 * Medikament sehen darf, darf deshalb noch lange nicht in seinem Protokoll
 * korrigieren - dieselbe Grenze, die take/skip seit jeher ziehen. Die Betreuung
 * (#584) liegt innerhalb dieser Grenze: sie ist ausdrücklich erteilt, und ohne
 * sie könnte ein Elternteil die Dosis, die es selbst eingetragen hat, nicht
 * abhaken (#884).
 */
function ownLogRow(id, viewer) {
  return writableChild(`
    SELECT l.*, m.user_id AS owner_id FROM medication_logs l
    JOIN medications m ON m.id = l.medication_id
    WHERE l.id = ?
  `, 'm', id, viewer);
}

// --------------------------------------------------------
// PATCH /logs/:id (#701)
// Body: { status?, taken_at?, dose_qty?, note? }
//
// Einen Fehlgriff korrigieren, statt mit ihm zu leben. Vorher gab es nur
// take/skip, also zwei Einbahnstraßen: die falsche Uhrzeit blieb stehen, und
// zwar nicht nur in der App - sie steht genauso im Export, den jemand
// ausdruckt und einer Ärztin hinlegt.
//
// `status: 'pending'` ist das Zurücknehmen: der Eintrag steht wieder aus, als
// wäre nichts angehakt worden.
// --------------------------------------------------------
router.patch('/logs/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const logRow = ownLogRow(id, viewer);
    if (!logRow) return res.status(404).json({ error: 'Dosis-Eintrag nicht gefunden.', code: 404 });

    const b = req.body || {};
    const status  = v.oneOf(b.status, LOG_STATUS, 'status');
    const takenAt = v.datetime(b.taken_at, 'taken_at', false, wallClockInput());
    const dose    = v.num(b.dose_qty, 'dose_qty');
    const note    = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });

    const errors = v.collectErrors([status, takenAt, dose, note]);
    if (errors.length) return badRequest(res, errors);

    const nextStatus = status.value || logRow.status;

    // Der Zeitpunkt gehört zum Status und wird mit ihm gesetzt, nicht daneben:
    // ein „nicht genommen" mit Einnahmezeit wäre ein Eintrag, der sich selbst
    // widerspricht, und genau so einer stünde nachher im Export.
    let nextTakenAt;
    if (nextStatus === 'taken') {
      nextTakenAt = takenAt.value ?? logRow.taken_at ?? new Date().toISOString();
    } else {
      nextTakenAt = null;
    }

    db.get().prepare(`
      UPDATE medication_logs
         SET status = ?, taken_at = ?,
             dose_qty = COALESCE(?, dose_qty),
             note     = CASE WHEN ? THEN ? ELSE note END
       WHERE id = ?
    `).run(
      nextStatus, nextTakenAt, dose.value ?? null,
      b.note === undefined ? 0 : 1, note.value ?? null,
      id,
    );

    res.json({ data: db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating log:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /logs/:id (#701)
//
// Nur für Einträge ohne Zeitplan, also für die von Hand oder als Bedarfsdosis
// erfassten. Ein geplanter Eintrag lässt sich nicht löschen, und das ist keine
// Bequemlichkeitsgrenze: der Scheduler legt ihn beim nächsten Lauf wieder an,
// weil die Dosis ja weiterhin für diesen Zeitpunkt geplant ist. Das Löschen
// sähe aus wie ein Erfolg und wäre eine Rückkehr auf Raten. Zurücknehmen heißt
// dort `PATCH { status: 'pending' }`, und darauf verweist die Antwort auch.
// --------------------------------------------------------
router.delete('/logs/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const logRow = ownLogRow(id, viewer);
    if (!logRow) return res.status(404).json({ error: 'Dosis-Eintrag nicht gefunden.', code: 404 });

    if (logRow.schedule_id) {
      return res.status(409).json({
        error: 'Ein geplanter Dosis-Eintrag lässt sich nicht löschen, nur zurücknehmen.',
        code: 409,
      });
    }

    db.get().prepare('DELETE FROM medication_logs WHERE id = ?').run(id);
    res.json({ data: { id } });
  } catch (err) {
    log.error('Error deleting log:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

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

export default router;
