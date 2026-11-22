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
  MAX_UNIT,
  viewerId, pathId, toBit, applyUpdate, badRequest,
  resolveOwner, wallClockInput, wallClockNow,
} from './helpers.js';
import { careAwareClause, readableClause, writableChild, writableClause } from '../../authorize/index.ts';
import { validateRequest } from '../../api/validate-request.ts';
import { MAX_SCHEDULES_ON_CREATE } from '../../services/health-fields.js';

const router = express.Router();

// Die Grenzen der Zahlen prueft das Schema vor jeder Route (#2810), aus
// health-fields.js:
//  - min_interval_hours: ueber 0 und hoechstens MAX_INTERVAL_HOURS. Ein
//    Mindestabstand von mehr als vier Wochen beschreibt keine Bedarfsdosis
//    mehr, sondern einen Zeitplan - und ein negativer oder 0 ergaebe einen
//    Countdown, der immer abgelaufen ist (#700).
//  - prn_dose_qty, stock_deduct, stock_credit: nicht negativ. Der Bestandsabzug
//    rechnet `stock_qty - dose`: eine Dosis von -2 wuerde den Bestand bei jeder
//    Einnahme ERHOEHEN. Das Formularfeld sperrt das ohnehin, ein API-Token oder
//    MCP-Client nicht.
//  - schedules: hoechstens MAX_SCHEDULES_ON_CREATE Zeitfenster beim Anlegen,
//    days_mask 0 bis 127, die Schalter true/false oder 1/0.

/** Zeitpunkt eines Dosis-Eintrags fuer Filter und Reihenfolge (GET .../logs). */
const LOG_WHEN = 'COALESCE(scheduled_at, taken_at, created_at)';

/**
 * Zieht `qty` vom erfassten Bestand ab, nie unter 0. Ohne erfassten Bestand
 * (stock_qty NULL) bleibt alles, wie es ist - wer keinen Bestand fuehrt,
 * bekommt keinen. Laeuft in der Transaktion des Aufrufers.
 *
 * Dosis und Abzug sind EINE Aktion (#2069). Bis dahin schickte der Client sie
 * als zwei Anfragen (Log, dann PATCH stock_qty mit einem selbst gerechneten
 * Rest): scheiterte die zweite, stand die Dosis im Protokoll und der Bestand
 * nicht gezaehlt, und der Rest kam aus einem Stand, den eine zweite Buchung
 * inzwischen ueberholt haben konnte. Jetzt rechnet der Server in derselben
 * Transaktion wie das Log, und zwar vom gespeicherten Bestand aus.
 */
function deductStock(medId, qty) {
  if (!(qty > 0)) return 0;
  const before = db.get().prepare('SELECT stock_qty FROM medications WHERE id = ?').get(medId)?.stock_qty;
  if (before == null) return 0;
  db.get().prepare(
    'UPDATE medications SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ? AND stock_qty IS NOT NULL'
  ).run(qty, medId);
  // WAS WIRKLICH ABGING, nicht was verlangt war (R23, D6): bei 0,5 Tabletten
  // Rest und einer Dosis von 1 gehen 0,5 ab. Genau das schreibt das
  // Zuruecknehmen wieder gut - sonst stuende danach mehr da als vorher.
  return before - Math.max(0, before - qty);
}

/**
 * Prueft ein Zeitfenster des Einnahmeplans. Geteilt von POST /schedules und
 * dem Anlegen eines Medikaments samt Plan (#2054), damit beide dieselben
 * Grenzen ziehen. Form und Bereich (`time_of_day` Pflicht als HH:MM, days_mask
 * 0-127 oder null, Zahl oder null, Schalter) prueft das Schema vor der Route
 * (#2810); hier bleibt der Kalendertag.
 */
function parseSchedule(b) {
  const startDate = v.date(b.start_date, 'start_date');
  const endDate   = v.date(b.end_date, 'end_date');

  const active = toBit(b.active);
  return {
    errors: v.collectErrors([startDate, endDate]),
    values: {
      timeOfDay: b.time_of_day, daysMask: b.days_mask ?? null, dose: b.dose_qty ?? null,
      startDate: startDate.value, endDate: endDate.value,
      active: active === undefined ? 1 : active,
    },
  };
}

/** Legt ein geprueftes Zeitfenster an und gibt seine id zurueck. */
function insertSchedule(medId, s) {
  return db.get().prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, dose_qty, start_date, end_date, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(medId, s.timeOfDay, s.daysMask, s.dose, s.startDate, s.endDate, s.active).lastInsertRowid;
}

// Diese beiden Helfer sind der einzige Zugang zu einem Medikament: Plaene und
// Einnahmeprotokolle haengen daran und erben ihr Scoping von hier. Die Betreuung
// (#584) greift deshalb an genau zwei Stellen statt in jeder der neun
// Schreibrouten.

/** Lädt ein Medikament, wenn der Betrachter es lesen darf; sonst null. */
function medicationForRead(medId, viewer) {
  const r = readableClause('', viewer);
  return db.get().prepare(
    `SELECT * FROM medications WHERE id = ? AND ${r.sql}`
  ).get(medId, ...r.params) || null;
}

/** Lädt ein Medikament, das der Betrachter ändern darf (eigenes oder betreutes). */
function medicationWritable(medId, viewer) {
  const w = writableClause('', viewer);
  return db.get().prepare(`SELECT * FROM medications WHERE id = ? AND ${w.sql}`)
    .get(medId, ...w.params) || null;
}

/**
 * `?include=schedules,logs` (R23 S11, N+1): die Liste bringt Plaene und
 * Dosis-Eintraege ihrer Medikamente gleich mit, je zwei Abfragen fuer ALLE
 * statt zwei Anfragen je Medikament. Gemessen schickte der Einstieg in die
 * Gesundheit 27 Anfragen, sechs davon nur fuer drei Medikamente; mit jedem
 * weiteren wuchs die Zahl um zwei.
 *
 * Die Rechte erben die Zeilen vom Medikament: in der Liste steht nur, was der
 * Betrachter lesen darf (careAwareClause, dieselbe Menge wie
 * medicationForRead), und Plaene und Eintraege werden nur fuer genau diese Ids
 * gelesen. `logs_from`/`logs_to` filtern wie GET /medications/:id/logs.
 */
function attachPlansAndLogs(meds, query) {
  const include = new Set(String(query.include || '').split(',').map((part) => part.trim()));
  const withSchedules = include.has('schedules');
  const withLogs = include.has('logs');
  if (!meds.length || (!withSchedules && !withLogs)) return;
  const ids = meds.map((m) => m.id);
  const marks = ids.map(() => '?').join(',');
  const byMed = (rows) => {
    const out = new Map(ids.map((id) => [id, []]));
    for (const row of rows) out.get(row.medication_id)?.push(row);
    return out;
  };
  if (withSchedules) {
    const rows = byMed(db.get().prepare(
      `SELECT * FROM medication_schedules WHERE medication_id IN (${marks}) ORDER BY time_of_day ASC, id ASC`
    ).all(...ids));
    for (const med of meds) med.schedules = rows.get(med.id);
  }
  if (withLogs) {
    const params = [...ids];
    let sql = `SELECT * FROM medication_logs WHERE medication_id IN (${marks})`;
    if (query.logs_from) { sql += ` AND substr(${LOG_WHEN}, 1, 16) >= ?`; params.push(String(query.logs_from).slice(0, 16)); }
    if (query.logs_to)   { sql += ` AND substr(${LOG_WHEN}, 1, 16) <= ?`; params.push(String(query.logs_to).slice(0, 16)); }
    sql += ` ORDER BY ${LOG_WHEN} DESC, id DESC`;
    const rows = byMed(db.get().prepare(sql).all(...params));
    for (const med of meds) med.logs = rows.get(med.id);
  }
}

// GET /medications?user_id=&active=&include=schedules,logs&logs_from=&logs_to=
router.get('/medications', validateRequest(), (req, res) => {
  const viewer   = viewerId(req);
  const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  const clause   = careAwareClause('m', viewer, personId);
  const params   = [...clause.params];
  let sql = `SELECT m.* FROM medications m WHERE ${clause.sql}`;

  const activeBit = toBit(req.query.active);
  if (activeBit !== undefined) { sql += ' AND m.active = ?'; params.push(activeBit); }

  sql += ' ORDER BY m.active DESC, m.name COLLATE NOCASE ASC, m.id DESC';
  const meds = db.get().prepare(sql).all(...params);
  attachPlansAndLogs(meds, req.query);
  res.json({ data: meds });
});

// POST /medications
router.post('/medications', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const b = req.body || {};
  const name       = v.str(b.name, 'name', { max: v.MAX_TITLE });
  const dosageText = v.str(b.dosage_text, 'dosage_text', { max: v.MAX_SHORT, required: false });
  const form       = v.str(b.form, 'form', { max: MAX_UNIT, required: false });
  const stockUnit  = v.str(b.stock_unit, 'stock_unit', { max: MAX_UNIT, required: false });
  const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });

  const errors = v.collectErrors([name, dosageText, form, stockUnit, note]);

  // Optionaler Einnahmeplan (#2054): das Formular legt ein neues Medikament
  // und seine Zeitfenster in EINEM Request an. Vorher waren es mehrere, und
  // scheiterte ein Zeitfenster, stand das Medikament schon - ein Abbrechen
  // liess es dann ohne Plan zurueck. Jetzt gilt alles oder nichts: erst
  // werden alle Zeitfenster geprueft, dann schreibt eine Transaktion.
  // `schedules`: eine Liste von hoechstens MAX_SCHEDULES_ON_CREATE Objekten
  // oder null prueft das Schema (#2810). Die Schleife prueft trotzdem selbst,
  // worueber sie laeuft und wie weit (Senke statt Route).
  const schedules = [];
  if (b.schedules !== undefined && b.schedules !== null) {
    if (!Array.isArray(b.schedules)) errors.push('schedules must be an array.');
    else if (b.schedules.length > MAX_SCHEDULES_ON_CREATE) errors.push(`schedules must not contain more than ${MAX_SCHEDULES_ON_CREATE} entries.`);
    else {
      b.schedules.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`schedules[${i}] must be an object.`); return; }
        const parsed = parseSchedule(raw);
        for (const e of parsed.errors) errors.push(`schedules[${i}]: ${e}`);
        schedules.push(parsed.values);
      });
    }
  }
  if (errors.length) return badRequest(res, errors);

  const active = toBit(b.active); // undefined → default 1
  const prn    = toBit(b.prn);    // undefined → default 0

  // Optionales user_id: eine betreuende Person legt das Medikament fuer die
  // betreute an (#584) - der Alltagsfall aus der Meldung.
  const owner = resolveOwner(req, viewer);
  if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

  const medId = db.get().transaction(() => {
    const result = db.get().prepare(`
      INSERT INTO medications (user_id, name, dosage_text, form, active, prn, stock_qty, stock_unit, refill_threshold, note, visibility,
                               min_interval_hours, prn_dose_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(owner.ownerId, name.value, dosageText.value, form.value,
           active === undefined ? 1 : active, prn === undefined ? 0 : prn,
           b.stock_qty ?? null, stockUnit.value, b.refill_threshold ?? null, note.value,
           b.visibility || defaultVisibilityFor(db.get(), owner.ownerId, 'meds'),
           b.min_interval_hours ?? null, b.prn_dose_qty ?? null);
    for (const sched of schedules) insertSchedule(result.lastInsertRowid, sched);
    return result.lastInsertRowid;
  })();

  const row = db.get().prepare('SELECT * FROM medications WHERE id = ?').get(medId);
  // Die angelegten Zeitfenster nur, wenn welche mitkamen: ohne `schedules`
  // bleibt die Antwort genau die bisherige Zeile.
  if (Array.isArray(b.schedules)) {
    row.schedules = db.get().prepare(
      'SELECT * FROM medication_schedules WHERE medication_id = ? ORDER BY time_of_day ASC, id ASC'
    ).all(medId);
  }
  res.status(201).json({ data: row });
});

// PATCH /medications/:id
router.patch('/medications/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const existing = medicationWritable(id, viewer);
  if (!existing) return res.status(404).json({ error: 'Medication not found.', code: 404, reason: 'health_medication_not_found' });

  const b = req.body || {};
  const fields = {};
  const checks = [];

  if (b.name !== undefined)             { const r = v.str(b.name, 'name', { max: v.MAX_TITLE });                      checks.push(r); if (!r.error) fields.name = r.value; }
  if (b.dosage_text !== undefined)      { const r = v.str(b.dosage_text, 'dosage_text', { max: v.MAX_SHORT, required: false }); checks.push(r); if (!r.error) fields.dosage_text = r.value; }
  if (b.form !== undefined)             { const r = v.str(b.form, 'form', { max: MAX_UNIT, required: false });        checks.push(r); if (!r.error) fields.form = r.value; }
  if (b.stock_qty !== undefined)        fields.stock_qty = b.stock_qty;
  if (b.stock_unit !== undefined)       { const r = v.str(b.stock_unit, 'stock_unit', { max: MAX_UNIT, required: false }); checks.push(r); if (!r.error) fields.stock_unit = r.value; }
  if (b.refill_threshold !== undefined) fields.refill_threshold = b.refill_threshold;
  if (b.note !== undefined)             { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });      checks.push(r); if (!r.error) fields.note = r.value; }
  // null laesst die Sichtbarkeit stehen; die Schalter sind true/false oder 1/0 (Schema).
  if (b.visibility)                     fields.visibility = b.visibility;
  if (b.active !== undefined)           fields.active = toBit(b.active);
  if (b.prn !== undefined)              fields.prn = toBit(b.prn);
  if (b.min_interval_hours !== undefined) fields.min_interval_hours = b.min_interval_hours;
  if (b.prn_dose_qty !== undefined)       fields.prn_dose_qty = b.prn_dose_qty;

  const errors = v.collectErrors(checks);
  if (errors.length) return badRequest(res, errors);

  applyUpdate('medications', id, fields);
  res.json({ data: db.get().prepare('SELECT * FROM medications WHERE id = ?').get(id) });
});

// DELETE /medications/:id
router.delete('/medications/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const existing = medicationWritable(id, viewer);
  if (!existing) return res.status(404).json({ error: 'Medication not found.', code: 404, reason: 'health_medication_not_found' });

  db.get().prepare('DELETE FROM medications WHERE id = ?').run(id);
  res.status(204).end();
});

// ---- Einnahmeplan (Schedules) ----

// GET /medications/:id/schedules
router.get('/medications/:id/schedules', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const medId = pathId(req);
  if (!medId) return res.status(400).json({ error: 'Invalid id.', code: 400 });
  if (!medicationForRead(medId, viewer)) return res.status(404).json({ error: 'Medication not found.', code: 404, reason: 'health_medication_not_found' });

  const rows = db.get().prepare(
    'SELECT * FROM medication_schedules WHERE medication_id = ? ORDER BY time_of_day ASC, id ASC'
  ).all(medId);
  res.json({ data: rows });
});

// POST /medications/:id/schedules
router.post('/medications/:id/schedules', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const medId = pathId(req);
  if (!medId) return res.status(400).json({ error: 'Invalid id.', code: 400 });
  if (!medicationWritable(medId, viewer)) return res.status(404).json({ error: 'Medication not found.', code: 404, reason: 'health_medication_not_found' });

  const sched = parseSchedule(req.body || {});
  if (sched.errors.length) return badRequest(res, sched.errors);

  const id = insertSchedule(medId, sched.values);
  const row = db.get().prepare('SELECT * FROM medication_schedules WHERE id = ?').get(id);
  res.status(201).json({ data: row });
});

// PATCH /schedules/:id
router.patch('/schedules/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const existing = writableChild(db.get(), `
    SELECT s.* FROM medication_schedules s
    JOIN medications m ON m.id = s.medication_id
    WHERE s.id = ?
  `, 'm', id, viewer);
  if (!existing) return res.status(404).json({ error: 'Schedule not found.', code: 404, reason: 'health_schedule_not_found' });

  const b = req.body || {};
  const fields = {};
  const checks = [];

  // HH:MM, eine Zahl oder null, 0-127 oder null, ein Schalter: das Schema (#2810).
  if (b.time_of_day !== undefined) fields.time_of_day = b.time_of_day;
  if (b.dose_qty !== undefined)    fields.dose_qty = b.dose_qty;
  if (b.start_date !== undefined)  { const r = v.date(b.start_date, 'start_date'); checks.push(r); if (!r.error) fields.start_date = r.value; }
  if (b.end_date !== undefined)    { const r = v.date(b.end_date, 'end_date');   checks.push(r); if (!r.error) fields.end_date = r.value; }
  if (b.active !== undefined)      fields.active = toBit(b.active);
  if (b.days_mask !== undefined)   fields.days_mask = b.days_mask;

  const errors = v.collectErrors(checks);
  if (errors.length) return badRequest(res, errors);

  applyUpdate('medication_schedules', id, fields);
  res.json({ data: db.get().prepare('SELECT * FROM medication_schedules WHERE id = ?').get(id) });
});

// DELETE /schedules/:id
router.delete('/schedules/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const existing = writableChild(db.get(), `
    SELECT s.id FROM medication_schedules s
    JOIN medications m ON m.id = s.medication_id
    WHERE s.id = ?
  `, 'm', id, viewer);
  if (!existing) return res.status(404).json({ error: 'Schedule not found.', code: 404, reason: 'health_schedule_not_found' });

  db.get().prepare('DELETE FROM medication_schedules WHERE id = ?').run(id);
  res.status(204).end();
});

// ---- Dosis-Log (Logs) ----

// GET /medications/:id/logs?from=&to=
router.get('/medications/:id/logs', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const medId = pathId(req);
  if (!medId) return res.status(400).json({ error: 'Invalid id.', code: 400 });
  if (!medicationForRead(medId, viewer)) return res.status(404).json({ error: 'Medication not found.', code: 404, reason: 'health_medication_not_found' });

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
  const WHEN = LOG_WHEN;
  const params = [medId];
  let sql = `SELECT * FROM medication_logs WHERE medication_id = ?`;
  if (req.query.from) { sql += ` AND substr(${WHEN}, 1, 16) >= ?`; params.push(String(req.query.from).slice(0, 16)); }
  if (req.query.to)   { sql += ` AND substr(${WHEN}, 1, 16) <= ?`; params.push(String(req.query.to).slice(0, 16)); }
  sql += ` ORDER BY ${WHEN} DESC, id DESC`;

  res.json({ data: db.get().prepare(sql).all(...params) });
});

// POST /medications/:id/logs
router.post('/medications/:id/logs', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const medId = pathId(req);
  if (!medId) return res.status(400).json({ error: 'Invalid id.', code: 400 });
  if (!medicationWritable(medId, viewer)) return res.status(404).json({ error: 'Medication not found.', code: 404, reason: 'health_medication_not_found' });

  const b = req.body || {};
  const wall        = wallClockInput();
  const scheduledAt = v.datetime(b.scheduled_at, 'scheduled_at', false, wall);
  const takenAt     = v.datetime(b.taken_at, 'taken_at', false, wall);
  const note        = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
  // status aus LOG_STATUS oder null, Zahlen oder null, stock_deduct nicht
  // negativ: das Schema (#2810).
  const dose        = b.dose_qty ?? null;

  const checks = [scheduledAt, takenAt, note];
  let scheduleId = null;
  if (b.schedule_id !== undefined && b.schedule_id !== null && b.schedule_id !== '') {
    const sid = parseInt(b.schedule_id, 10);
    const owned = db.get().prepare(
      'SELECT id FROM medication_schedules WHERE id = ? AND medication_id = ?'
    ).get(sid, medId);
    if (!owned) checks.push({ value: null, error: 'schedule_id does not belong to this medication.' });
    else scheduleId = sid;
  }

  const errors = v.collectErrors(checks);
  if (errors.length) return badRequest(res, errors);

  // Wie /take und PATCH: eine genommene Dosis ohne Zeit bekommt "jetzt" als
  // Wanduhrzeit des Haushalts. NULL neben `taken` waere eine Einnahme ohne
  // Einnahmezeit - im CSV-Export stuende die Spalte leer, und die Anzeige
  // muesste auf `created_at` ausweichen, einen UTC-Instant. Umgekehrt traegt
  // nur `taken` eine Einnahmezeit: ein mitgeschicktes `taken_at` neben
  // pending/skipped faellt weg, wie bei PATCH und skip.
  const nextStatus  = b.status || 'pending';
  const nextTakenAt = nextStatus === 'taken' ? (takenAt.value || wallClockNow()) : null;

  // Log und Bestandsabzug in EINER Transaktion (#2069): beides oder nichts.
  // Abgezogen wird nur bei einer genommenen Dosis.
  //
  // EIN EINTRAG JE GEPLANTEM VORKOMMEN: steht fuer schedule_id + scheduled_at
  // schon einer (vom Scheduler angelegt oder von einem frueheren POST, dessen
  // Antwort unterwegs verloren ging), wird er aktualisiert statt verdoppelt -
  // dieselbe Regel, nach der der Scheduler selbst nur einmal anlegt. Abgezogen
  // wird dann nur beim Wechsel nach `taken`, sonst zoege ein wiederholter Tipp
  // die Dosis zweimal vom Bestand.
  const { row, created, deducted } = db.get().transaction(() => {
    const existing = scheduleId && scheduledAt.value
      ? db.get().prepare(
        'SELECT * FROM medication_logs WHERE medication_id = ? AND schedule_id = ? AND scheduled_at = ?',
      ).get(medId, scheduleId, scheduledAt.value)
      : null;
    if (existing) {
      db.get().prepare(`
        UPDATE medication_logs
           SET status = ?, taken_at = ?,
               dose_qty = COALESCE(?, dose_qty),
               note     = CASE WHEN ? THEN ? ELSE note END
         WHERE id = ?
      `).run(
        nextStatus,
        nextStatus === 'taken' ? (existing.status === 'taken' && !takenAt.value ? existing.taken_at : nextTakenAt) : null,
        dose, b.note === undefined ? 0 : 1, note.value ?? null, existing.id,
      );
      const deducted = nextStatus === 'taken' && existing.status !== 'taken' ? deductStock(medId, b.stock_deduct) : 0;
      return { row: db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(existing.id), created: false, deducted };
    }
    const result = db.get().prepare(`
      INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, taken_at, dose_qty, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(medId, scheduleId, scheduledAt.value, nextStatus, nextTakenAt, dose, note.value);
    const deducted = nextStatus === 'taken' ? deductStock(medId, b.stock_deduct) : 0;
    return { row: db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(result.lastInsertRowid), created: true, deducted };
  })();
  res.status(created ? 201 : 200).json({ data: row, stock_deducted: deducted });
});

/** Gemeinsame Logik für take/skip: Status setzen und Log zurückgeben. */
function updateLogStatus(req, res, newStatus) {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const logRow = ownLogRow(id, viewer);
  if (!logRow) return res.status(404).json({ error: 'Dose entry not found.', code: 404, reason: 'health_dose_not_found' });

  const b = req.body || {};
  if (newStatus === 'taken') {
    const takenAt = v.datetime(b.taken_at, 'taken_at', false, wallClockInput());
    const errors  = v.collectErrors([takenAt]);
    if (errors.length) return badRequest(res, errors);
    const when = takenAt.value || wallClockNow();
    // Abhaken und Bestandsabzug in EINER Transaktion (#2069). Ein schon
    // genommener Eintrag zieht nicht ein zweites Mal ab: ein wiederholtes
    // /take (Doppelklick, Wiederholung nach einem Netzfehler) bucht sonst die
    // Dosis doppelt vom Bestand.
    const deducted = db.get().transaction(() => {
      db.get().prepare('UPDATE medication_logs SET status = ?, taken_at = ? WHERE id = ?').run('taken', when, id);
      return logRow.status !== 'taken' ? deductStock(logRow.medication_id, b.stock_deduct) : 0;
    })();
    return res.json({ data: db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(id), stock_deducted: deducted });
  }
  db.get().prepare('UPDATE medication_logs SET status = ?, taken_at = NULL WHERE id = ?').run('skipped', id);
  res.json({ data: db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(id), stock_deducted: 0 });
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
  return writableChild(db.get(), `
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
router.patch('/logs/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const logRow = ownLogRow(id, viewer);
  if (!logRow) return res.status(404).json({ error: 'Dose entry not found.', code: 404, reason: 'health_dose_not_found' });

  const b = req.body || {};
  const takenAt = v.datetime(b.taken_at, 'taken_at', false, wallClockInput());
  const note    = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });

  const errors = v.collectErrors([takenAt, note]);
  if (errors.length) return badRequest(res, errors);

  // status aus LOG_STATUS oder null (bleibt), dose_qty eine Zahl oder null: das Schema (#2810).
  const nextStatus = b.status || logRow.status;

  // Der Zeitpunkt gehört zum Status und wird mit ihm gesetzt, nicht daneben:
  // ein „nicht genommen" mit Einnahmezeit wäre ein Eintrag, der sich selbst
  // widerspricht, und genau so einer stünde nachher im Export.
  let nextTakenAt;
  if (nextStatus === 'taken') {
    nextTakenAt = takenAt.value ?? logRow.taken_at ?? wallClockNow();
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
    nextStatus, nextTakenAt, b.dose_qty ?? null,
    b.note === undefined ? 0 : 1, note.value ?? null,
    id,
  );

  res.json({ data: db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(id) });
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
router.delete('/logs/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const logRow = ownLogRow(id, viewer);
  if (!logRow) return res.status(404).json({ error: 'Dose entry not found.', code: 404, reason: 'health_dose_not_found' });

  if (logRow.schedule_id) {
    return res.status(409).json({
      error: 'A scheduled dose entry cannot be deleted, only reset to pending.',
      code: 409,
    });
  }

  db.get().prepare('DELETE FROM medication_logs WHERE id = ?').run(id);
  res.json({ data: { id } });
});

// --------------------------------------------------------
// POST /logs/:id/undo (R23, D6)
// Body: { stock_credit? }  - was die Buchung abgezogen hat (`stock_deducted`)
//
// DER RUECKWEG DES TOASTS nach "Eingenommen"/"Ausgelassen". Bis R23 korrigierte
// das Zuruecknehmen nur den Eintrag, nie den Bestand (#701) - eine versehentlich
// getippte Dosis kostete eine Tablette, die im Schrank noch lag. Jetzt geht
// beides in EINER Transaktion zurueck:
//  - ein geplanter Eintrag steht wieder aus (`pending`, ohne Einnahmezeit) -
//    loeschen hiesse, der Scheduler legte ihn beim naechsten Lauf neu an;
//  - ein Eintrag ohne Plan (Bedarfsdosis) geht ganz, er war die Tat selbst;
//  - der Bestand bekommt `stock_credit` gut, aber nur, wo einer gefuehrt wird.
// Die Gutschrift ist gedeckelt auf die Dosis des Eintrags, und nur, wer das
// Medikament schreiben darf, kommt hierher (writableChild).
// --------------------------------------------------------
router.post('/logs/:id/undo', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });
  const logRow = ownLogRow(id, viewer);
  if (!logRow) return res.status(404).json({ error: 'Dose entry not found.', code: 404, reason: 'health_dose_not_found' });
  // Eine Zahl ab 0 oder null (Schema, #2810).
  const credit = req.body.stock_credit ?? null;
  if (logRow.status === 'pending') {
    return res.status(409).json({ error: 'This dose is not recorded.', code: 409, reason: 'health_dose_pending' });
  }
  // NIE MEHR ALS DIE DOSIS DES EINTRAGS (Sicherheitspruefung zu R23): die
  // Gutschrift kommt vom Client, und ohne Deckel liesse sich ueber das
  // Zuruecknehmen ein beliebiger Bestand buchen. Abgezogen hat die Buchung
  // hoechstens ihre Dosis (die des Eintrags, sonst die des Zeitfensters).
  const planned = logRow.schedule_id
    ? db.get().prepare('SELECT dose_qty FROM medication_schedules WHERE id = ?').get(logRow.schedule_id)?.dose_qty
    : null;
  const cap = Number(logRow.dose_qty ?? planned ?? 0) || 0;
  const credited = logRow.status === 'taken' && credit > 0 ? Math.min(credit, cap) : 0;
  const removed = db.get().transaction(() => {
    if (credited > 0) {
      db.get().prepare('UPDATE medications SET stock_qty = stock_qty + ? WHERE id = ? AND stock_qty IS NOT NULL')
        .run(credited, logRow.medication_id);
    }
    if (!logRow.schedule_id) {
      db.get().prepare('DELETE FROM medication_logs WHERE id = ?').run(id);
      return true;
    }
    db.get().prepare("UPDATE medication_logs SET status = 'pending', taken_at = NULL WHERE id = ?").run(id);
    return false;
  })();
  res.json({ data: removed ? { id, removed: true } : db.get().prepare('SELECT * FROM medication_logs WHERE id = ?').get(id) });
});

// POST /logs/:id/take
router.post('/logs/:id/take', validateRequest(), (req, res) => {
  updateLogStatus(req, res, 'taken');
});

// POST /logs/:id/skip
router.post('/logs/:id/skip', validateRequest(), (req, res) => {
  updateLogStatus(req, res, 'skipped');
});

export default router;
