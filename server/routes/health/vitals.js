/**
 * Modul: Gesundheit (Health) - Vitalwerte
 * Zweck: REST-API für Vitalwerte (health_vitals): Liste, Anlage, Teil-Update, Löschung.
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../api/formats.ts';
import { defaultVisibilityFor, vitalScopeKey } from './visibility-defaults.js';
import { vitalLimitError, refuseImpossibleVital, vitalUnitError, refuseVitalUnit } from './vital-limits.js';
import {
  MAX_UNIT,
  viewerId, pathId, applyUpdate, badRequest,
  resolveOwner, wallClockInput,
} from './helpers.js';
import { careAwareClause, writableClause } from '../../authorize/index.ts';
import { validateRequest } from '../../api/validate-request.ts';
import { MAX_TYPE } from '../../services/health-fields.js';

const router = express.Router();

// GET /vitals?user_id=&type=&from=&to=
router.get('/vitals', validateRequest(), (req, res) => {
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
});

// POST /vitals
router.post('/vitals', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const b = req.body || {};
  const type       = v.str(b.type, 'type', { max: MAX_TYPE });
  const unit       = v.str(b.unit, 'unit', { max: MAX_UNIT, required: false });
  const measuredAt = v.datetime(b.measured_at, 'measured_at', true, wallClockInput());
  const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
  // Zahlen und Sichtbarkeit prueft das Schema vor der Route (#2810): eine
  // Zahl oder null, `private`/`family` oder null.
  const valueNum   = b.value_num ?? null;
  const valueNum2  = b.value_num2 ?? null;
  const valueNum3  = b.value_num3 ?? null;

  const errors = v.collectErrors([type, unit, measuredAt, note]);
  if (errors.length) return badRequest(res, errors);

  const accepted = vitalUnitError({ type: type.value, unit: unit.value });
  if (accepted) return refuseVitalUnit(res, accepted);

  // Unmoegliches gar nicht erst speichern (Critique R19, vital-limits.js).
  const impossible = vitalLimitError({
    type: type.value, unit: unit.value,
    value_num: valueNum, value_num2: valueNum2, value_num3: valueNum3,
  });
  if (impossible) return refuseImpossibleVital(res, impossible);

  // Optionales user_id: eine betreuende Person trägt für die betreute ein (#584).
  const owner = resolveOwner(req, viewer);
  if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

  const result = db.get().prepare(`
    INSERT INTO health_vitals (user_id, type, value_num, value_num2, value_num3, unit, measured_at, note, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(owner.ownerId, type.value, valueNum, valueNum2, valueNum3,
         unit.value, measuredAt.value, note.value,
         // Fehlt das Feld, gilt die Wahl des EIGENTUEMERS fuer diese Metrik
         // (#958) - nicht die der erfassenden Person: die Zeile gehoert ihm.
         b.visibility || defaultVisibilityFor(db.get(), owner.ownerId, vitalScopeKey(type.value)));

  const row = db.get().prepare('SELECT * FROM health_vitals WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ data: row });
});

// PATCH /vitals/:id
router.patch('/vitals/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const w = writableClause('', viewer);
  const existing = db.get().prepare(`SELECT * FROM health_vitals WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
  if (!existing) return res.status(404).json({ error: 'Measurement not found.', code: 404, reason: 'health_vital_not_found' });

  const b = req.body || {};
  const fields = {};
  const checks = [];

  if (b.type !== undefined)        { const r = v.str(b.type, 'type', { max: MAX_TYPE });               checks.push(r); if (!r.error) fields.type = r.value; }
  if (b.value_num !== undefined)   fields.value_num = b.value_num;
  if (b.value_num2 !== undefined)  fields.value_num2 = b.value_num2;
  if (b.value_num3 !== undefined)  fields.value_num3 = b.value_num3;
  if (b.unit !== undefined)        { const r = v.str(b.unit, 'unit', { max: MAX_UNIT, required: false }); checks.push(r); if (!r.error) fields.unit = r.value; }
  if (b.measured_at !== undefined) { const r = v.datetime(b.measured_at, 'measured_at', true, wallClockInput()); checks.push(r); if (!r.error) fields.measured_at = r.value; }
  if (b.note !== undefined)        { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
  // null laesst die Sichtbarkeit stehen.
  if (b.visibility)                fields.visibility = b.visibility;

  const errors = v.collectErrors(checks);
  if (errors.length) return badRequest(res, errors);

  // Bestand bleibt bearbeitbar (#2375): die Einheit zaehlt nur, wenn dieser
  // Aufruf sie oder den Typ aendert, die Grenzen nur, wenn er die Messung
  // aendert. Eine Altzeile in "furlong" oder mit 9.000.000 g nimmt so weiter
  // eine Notiz an, auch wenn der Dialog alle Werte unveraendert mitschickt.
  const next = { ...existing, ...fields };
  const changed = (key) => next[key] !== existing[key];
  if (changed('unit') || changed('type')) {
    const accepted = vitalUnitError(next);
    if (accepted) return refuseVitalUnit(res, accepted);
  }

  // Geprueft wird die Messung, wie sie NACH dem Speichern stuende: eine
  // Diastole, die einzeln ueber die Systole gehoben wird, ist derselbe Fehler.
  if (['type', 'unit', 'value_num', 'value_num2', 'value_num3'].some(changed)) {
    const impossible = vitalLimitError(next);
    if (impossible) return refuseImpossibleVital(res, impossible);
  }

  applyUpdate('health_vitals', id, fields);
  res.json({ data: db.get().prepare('SELECT * FROM health_vitals WHERE id = ?').get(id) });
});

// DELETE /vitals/:id
router.delete('/vitals/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid id.', code: 400 });

  const w = writableClause('', viewer);
  const existing = db.get().prepare(`SELECT id FROM health_vitals WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
  if (!existing) return res.status(404).json({ error: 'Measurement not found.', code: 404, reason: 'health_vital_not_found' });

  db.get().prepare('DELETE FROM health_vitals WHERE id = ?').run(id);
  res.status(204).end();
});

export default router;
