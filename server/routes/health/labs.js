/**
 * Modul: Gesundheit (Health) - Laborwerte
 * Zweck: REST-API für Laborbefunde (health_lab_reports) und deren Analyten
 *        (health_lab_results).
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../middleware/validate.js';
import { defaultVisibilityFor } from './visibility-defaults.js';
import {
  log, VISIBILITIES, MAX_UNIT,
  viewerId, careAwareClause, applyUpdate, badRequest, deriveFlag, attachResults,
  resolveOwner, writableClause, writableChild,
} from './helpers.js';

const router = express.Router();

/** Lädt einen Laborbefund, wenn der Betrachter ihn lesen darf; sonst null. */
function reportForRead(reportId, viewer) {
  const w = writableClause('', viewer);
  return db.get().prepare(
    `SELECT * FROM health_lab_reports WHERE id = ? AND (visibility = 'family' OR ${w.sql})`
  ).get(reportId, ...w.params) || null;
}

/** Lädt einen dem Betrachter gehörenden Laborbefund; sonst null. */
function reportWritable(reportId, viewer) {
  const w = writableClause('', viewer);
  return db.get().prepare(`SELECT * FROM health_lab_reports WHERE id = ? AND ${w.sql}`)
    .get(reportId, ...w.params) || null;
}

// GET /labs?user_id=&from=&to=
router.get('/labs', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = careAwareClause('r', viewer, personId);
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

    // Optionales user_id: eine betreuende Person trägt für die betreute ein (#584).
    const owner = resolveOwner(req, viewer);
    if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

    const insertReport = db.get().prepare(`
      INSERT INTO health_lab_reports (user_id, report_date, lab_name, note, visibility)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertResult = db.get().prepare(`
      INSERT INTO health_lab_results (report_id, analyte, value_num, unit, ref_low, ref_high, flag)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.get().transaction(() => {
      const rep = insertReport.run(owner.ownerId, reportDate.value, labName.value, note.value,
        visibility.value || defaultVisibilityFor(db.get(), owner.ownerId, 'labs'));
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

    const existing = reportWritable(id, viewer);
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

    const existing = reportWritable(id, viewer);
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
    if (!reportWritable(reportId, viewer)) return res.status(404).json({ error: 'Befund nicht gefunden.', code: 404 });

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

// PATCH /results/:id  (einen Analyt korrigieren, Critique R8 H9)
//
// Bis R8 liess sich ein Laborwert nur loeschen und neu erfassen - ein
// Tippfehler kostete die Zeile. Der Body darf Teilfelder tragen; validiert
// wird die ZUSAMMENGEFUEHRTE Zeile mit demselben Validator wie beim Anlegen,
// damit ein Teil-Update keine Kombination erzeugt, die POST abgelehnt haette.
// Das Flag: nennt der Body eins, gilt es. Aendert sich Wert oder Referenz,
// wird es neu abgeleitet - sonst stuende nach einer Wertkorrektur das Urteil
// ueber den alten Wert da. Bleiben beide, bleibt auch das gespeicherte Flag:
// ein per POST gesetztes Urteil ohne Referenzbereich ginge sonst bei jeder
// Einheitenkorrektur verloren (der Dialog hat kein Flag-Feld).
// Ein vorhandener Messwert laesst sich nicht leeren (null/''): das waere
// Datenverlust ueber einen Teil-Update. Ein Analyt ohne Wert bleibt ohne.
router.patch('/results/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = writableChild(`
      SELECT res.* FROM health_lab_results res
      JOIN health_lab_reports r ON r.id = res.report_id
      WHERE res.id = ?
    `, 'r', id, viewer);
    if (!existing) return res.status(404).json({ error: 'Analyt nicht gefunden.', code: 404 });

    const b = req.body || {};
    if ((b.value_num === null || b.value_num === '') && existing.value_num !== null) {
      return badRequest(res, ['value_num kann nicht geleert werden.']);
    }
    const pick = (key) => (b[key] !== undefined ? b[key] : existing[key]);
    const { row, error } = validateResult({
      analyte: pick('analyte'),
      value_num: pick('value_num'),
      unit: pick('unit'),
      ref_low: pick('ref_low'),
      ref_high: pick('ref_high'),
      flag: b.flag,
    });
    if (error) return badRequest(res, [error]);
    const measured = ['value_num', 'ref_low', 'ref_high'].some((k) => row[k] !== existing[k]);
    if (b.flag === undefined && !measured) row.flag = existing.flag;

    db.get().prepare(`
      UPDATE health_lab_results
         SET analyte = ?, value_num = ?, unit = ?, ref_low = ?, ref_high = ?, flag = ?
       WHERE id = ?
    `).run(row.analyte, row.value_num, row.unit, row.ref_low, row.ref_high, row.flag, id);

    res.json({ data: db.get().prepare('SELECT * FROM health_lab_results WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating lab result:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /results/:id
router.delete('/results/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = writableChild(`
      SELECT res.id FROM health_lab_results res
      JOIN health_lab_reports r ON r.id = res.report_id
      WHERE res.id = ?
    `, 'r', id, viewer);
    if (!existing) return res.status(404).json({ error: 'Analyt nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM health_lab_results WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting lab result:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
