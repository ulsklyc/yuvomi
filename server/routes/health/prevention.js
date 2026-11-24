/**
 * Modul: Gesundheit (Health) - Vorsorge & Impfungen
 * Zweck: REST-API für den Vorsorge-/Impf-Katalog (health_prevention_types) und
 *        das Protokoll (health_prevention_records), plus die abgeleitete
 *        "als nächstes fällig"-Liste.
 *
 * EIN MODELL, NICHT ZWEI (D1/DECISIONS #6): eine Tetanus-Auffrischung alle 10
 * Jahre und ein Zahnarzttermin alle 6 Monate sind dieselbe Zeile - Person + Art
 * + wann es war + Intervall zum nächsten Mal.
 *
 * Sichtbarkeit/Betreuung folgen exakt dem Muster von vitals.js - `authorize/care.ts`
 * ist die einzige Stelle, an der die Klausel gebaut werden darf (#884).
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../api/formats.ts';
import { requireAdmin } from '../../middleware/require-admin.js';
import { todayKey } from '../../utils/timezone.js';
import { defaultVisibilityFor } from './visibility-defaults.js';
import { computeDueForUser } from '../../services/prevention-due.js';
import { syncPreventionRemindersForSubject } from '../../services/prevention-reminders.js';
import {
  log,
  viewerId, pathId, applyUpdate, badRequest,
  resolveOwner,
} from './helpers.js';
import { careAwareClause, readableRows, writableClause } from '../../authorize/index.ts';
import { validateRequest } from '../../api/validate-request.ts';
import { MAX_ICON } from '../../services/health-fields.js';

const router = express.Router();

// Art (`vaccination`/`checkup`, PREVENTION_KINDS), Intervall in Monaten
// (1-MAX_INTERVAL_MONTHS, ganzzahlig, NULL = einmalig), Erinnerungsvorlauf in
// Tagen (0-MAX_OFFSET_DAYS, ganzzahlig, NULL = Modul-Standard, siehe
// prevention-due.js) und die Zahlen prueft das Schema vor jeder Route (#2810).

// --------------------------------------------------------
// Typen-Register (household-owned, D2) - Schreiben nur Admins
// --------------------------------------------------------

// GET /prevention/types - allen Mitgliedern zugänglich (Lesen)
router.get('/prevention/types', validateRequest(), (req, res) => {
  const rows = db.get().prepare(
    'SELECT * FROM health_prevention_types ORDER BY sort_order ASC, id ASC'
  ).all();
  res.json({ data: rows });
});

router.post('/prevention/types', requireAdmin, validateRequest(), (req, res) => {
  const b = req.body || {};
  const name = v.str(b.name, 'name', { max: v.MAX_TITLE });
  const icon = v.str(b.icon, 'icon', { max: MAX_ICON, required: false });

  const errors = v.collectErrors([name, icon]);
  if (errors.length) return badRequest(res, errors);

  const result = db.get().prepare(`
    INSERT INTO health_prevention_types (name, kind, default_interval_months, icon, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name.value, b.kind, b.default_interval_months ?? null,
    icon.value || 'syringe', b.sort_order ?? 0,
  );

  const row = db.get().prepare('SELECT * FROM health_prevention_types WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ data: row });
});

router.patch('/prevention/types/:id', requireAdmin, validateRequest(), (req, res) => {
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

  const existing = db.get().prepare('SELECT id FROM health_prevention_types WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Type not found.', code: 404, reason: 'health_prevention_type_not_found' });

  const b = req.body || {};
  const fields = {};
  const checks = [];

  if (b.name !== undefined) { const r = v.str(b.name, 'name', { max: v.MAX_TITLE }); checks.push(r); if (!r.error) fields.name = r.value; }
  if (b.kind !== undefined) fields.kind = b.kind;
  if (b.default_interval_months !== undefined) fields.default_interval_months = b.default_interval_months;
  if (b.icon !== undefined) { const r = v.str(b.icon, 'icon', { max: MAX_ICON, required: false }); checks.push(r); if (!r.error) fields.icon = r.value || 'syringe'; }
  if (b.sort_order !== undefined) fields.sort_order = b.sort_order ?? 0;

  const errors = v.collectErrors(checks);
  if (errors.length) return badRequest(res, errors);

  applyUpdate('health_prevention_types', id, fields);
  res.json({ data: db.get().prepare('SELECT * FROM health_prevention_types WHERE id = ?').get(id) });
});

// DELETE /prevention/types/:id - die Historie bleibt (SET NULL + name-Momentaufnahme).
router.delete('/prevention/types/:id', requireAdmin, validateRequest(), (req, res) => {
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

  const type = db.get().prepare('SELECT * FROM health_prevention_types WHERE id = ?').get(id);
  if (!type) return res.status(404).json({ error: 'Type not found.', code: 404, reason: 'health_prevention_type_not_found' });

  const affectedUserIds = db.get().prepare(
    'SELECT DISTINCT user_id FROM health_prevention_records WHERE type_id = ?'
  ).all(id).map((r) => r.user_id);

  db.get().transaction(() => {
    // Momentaufnahme JETZT ziehen - danach ist der Typname weg, der
    // FK-ON-DELETE-SET-NULL nullt type_id automatisch, kennt aber keinen Namen.
    db.get().prepare(
      "UPDATE health_prevention_records SET name = ? WHERE type_id = ? AND (name IS NULL OR name = '')"
    ).run(type.name, id);
    db.get().prepare('DELETE FROM health_prevention_types WHERE id = ?').run(id);
  })();

  for (const userId of affectedUserIds) {
    try { syncPreventionRemindersForSubject(db.get(), userId); } catch (err) {
      log.error('Error re-syncing prevention reminders after type delete:', err.message);
    }
  }

  res.status(204).end();
});

/**
 * Die gewaehlte Art gibt es nicht (mehr): jemand hat sie geloescht, waehrend der
 * Dialog offen war (#1909). Status 400 wie bisher; der Grund laesst die Seite
 * die Auswahl auffrischen, statt den Text des Servers zu zeigen.
 */
function unknownSelectedType(res) {
  return res.status(400).json({ error: 'Unknown type.', code: 400, reason: 'health_prevention_selected_type_not_found' });
}

// --------------------------------------------------------
// Protokoll (health_prevention_records)
// --------------------------------------------------------

// GET /prevention/records?user_id=&type_id=&from=&to=
router.get('/prevention/records', validateRequest(), (req, res) => {
  const viewer   = viewerId(req);
  const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  const clause   = careAwareClause('r', viewer, personId);
  const params   = [...clause.params];
  let sql = `SELECT r.* FROM health_prevention_records r WHERE ${clause.sql}`;

  if (req.query.type_id) { sql += ' AND r.type_id = ?'; params.push(parseInt(req.query.type_id, 10)); }
  if (req.query.from)    { sql += ' AND r.given_on >= ?'; params.push(String(req.query.from)); }
  if (req.query.to)      { sql += ' AND r.given_on <= ?'; params.push(String(req.query.to)); }

  sql += ' ORDER BY r.given_on DESC, r.id DESC';
  res.json({ data: db.get().prepare(sql).all(...params) });
});

// POST /prevention/records
router.post('/prevention/records', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const b = req.body || {};

  const typeId = b.type_id != null && b.type_id !== '' ? parseInt(b.type_id, 10) : null;
  let type = null;
  if (b.type_id != null && b.type_id !== '') {
    if (!typeId) return badRequest(res, ['type_id is invalid.']);
    type = db.get().prepare('SELECT * FROM health_prevention_types WHERE id = ?').get(typeId);
    // Die im Formular gewaehlte Art wurde inzwischen geloescht (#1909).
    if (!type) return unknownSelectedType(res);
  }

  const name          = v.str(b.name, 'name', { max: v.MAX_TITLE, required: !type });
  const givenOn       = v.date(b.given_on, 'given_on', true);
  const batch         = v.str(b.batch, 'batch', { max: v.MAX_SHORT, required: false });
  const provider      = v.str(b.provider, 'provider', { max: v.MAX_SHORT, required: false });
  const note          = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
  const nextDueOn      = v.date(b.next_due_on, 'next_due_on', false);

  const errors = v.collectErrors([name, givenOn, batch, provider, note, nextDueOn]);
  if (errors.length) return badRequest(res, errors);

  // Optionales user_id: eine betreuende Person trägt für die betreute ein (#584).
  const owner = resolveOwner(req, viewer);
  if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

  const result = db.get().prepare(`
    INSERT INTO health_prevention_records (
      user_id, type_id, name, given_on, dose_number, batch, provider, note,
      interval_months, next_due_on, reminder_offset_days, visibility, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    owner.ownerId, typeId, name.value, givenOn.value, b.dose_number ?? null, batch.value, provider.value, note.value,
    b.interval_months ?? null, nextDueOn.value, b.reminder_offset_days ?? null,
    // Fehlt das Feld, gilt die Wahl des EIGENTUEMERS (#958) - nicht die der
    // erfassenden Person: die Zeile gehoert ihm.
    b.visibility || defaultVisibilityFor(db.get(), owner.ownerId, 'prevention'),
    viewer,
  );

  const row = db.get().prepare('SELECT * FROM health_prevention_records WHERE id = ?').get(result.lastInsertRowid);
  try { syncPreventionRemindersForSubject(db.get(), owner.ownerId); } catch (err) {
    log.error('Error syncing prevention reminders after write:', err.message);
  }
  res.status(201).json({ data: row });
});

// PATCH /prevention/records/:id
router.patch('/prevention/records/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

  const w = writableClause('', viewer);
  const existing = db.get().prepare(`SELECT * FROM health_prevention_records WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
  if (!existing) return res.status(404).json({ error: 'Record not found.', code: 404, reason: 'health_prevention_record_not_found' });

  const b = req.body || {};
  const fields = {};
  const checks = [];

  if (b.type_id !== undefined) {
    if (b.type_id === null || b.type_id === '') {
      fields.type_id = null;
    } else {
      const typeId = parseInt(b.type_id, 10);
      const type = typeId ? db.get().prepare('SELECT id FROM health_prevention_types WHERE id = ?').get(typeId) : null;
      if (!type) return unknownSelectedType(res);
      fields.type_id = typeId;
    }
  }
  if (b.name !== undefined) { const r = v.str(b.name, 'name', { max: v.MAX_TITLE, required: false }); checks.push(r); if (!r.error) fields.name = r.value; }
  if (b.given_on !== undefined) { const r = v.date(b.given_on, 'given_on', true); checks.push(r); if (!r.error) fields.given_on = r.value; }
  if (b.dose_number !== undefined) fields.dose_number = b.dose_number;
  if (b.batch !== undefined) { const r = v.str(b.batch, 'batch', { max: v.MAX_SHORT, required: false }); checks.push(r); if (!r.error) fields.batch = r.value; }
  if (b.provider !== undefined) { const r = v.str(b.provider, 'provider', { max: v.MAX_SHORT, required: false }); checks.push(r); if (!r.error) fields.provider = r.value; }
  if (b.note !== undefined) { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
  if (b.interval_months !== undefined) fields.interval_months = b.interval_months;
  if (b.next_due_on !== undefined) { const r = v.date(b.next_due_on, 'next_due_on', false); checks.push(r); if (!r.error) fields.next_due_on = r.value; }
  if (b.reminder_offset_days !== undefined) fields.reminder_offset_days = b.reminder_offset_days;
  // null laesst die Sichtbarkeit stehen.
  if (b.visibility) fields.visibility = b.visibility;

  const errors = v.collectErrors(checks);
  if (errors.length) return badRequest(res, errors);

  applyUpdate('health_prevention_records', id, fields);
  const row = db.get().prepare('SELECT * FROM health_prevention_records WHERE id = ?').get(id);
  try { syncPreventionRemindersForSubject(db.get(), row.user_id); } catch (err) {
    log.error('Error syncing prevention reminders after write:', err.message);
  }
  res.json({ data: row });
});

// DELETE /prevention/records/:id
router.delete('/prevention/records/:id', validateRequest(), (req, res) => {
  const viewer = viewerId(req);
  const id = pathId(req);
  if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

  const w = writableClause('', viewer);
  const existing = db.get().prepare(`SELECT * FROM health_prevention_records WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
  if (!existing) return res.status(404).json({ error: 'Record not found.', code: 404, reason: 'health_prevention_record_not_found' });

  db.get().transaction(() => {
    // Explizit abraeumen statt sich allein auf den periodischen Sync zu
    // verlassen (reminders.entity_id hat keine FK) - gleiches Muster wie
    // documents.js und item-dates.js#removeTrackedDateReminders folgen demselben Muster.
    db.get().prepare(`
      DELETE FROM reminders WHERE entity_type = 'health_prevention_due' AND entity_id = ?
    `).run(id);
    db.get().prepare('DELETE FROM health_prevention_records WHERE id = ?').run(id);
  })();

  try { syncPreventionRemindersForSubject(db.get(), existing.user_id); } catch (err) {
    log.error('Error syncing prevention reminders after delete:', err.message);
  }
  res.status(204).end();
});

// --------------------------------------------------------
// GET /prevention/due?user_id= - die abgeleitete Liste
// --------------------------------------------------------
router.get('/prevention/due', validateRequest(), (req, res) => {
  const viewer   = viewerId(req);
  const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : viewer;

  const today = todayKey(db.get(), new Date());
  let items = computeDueForUser(db.get(), personId, today);

  // Ohne Betreuung nur, was der Eigentuemer als familiensichtbar markiert
  // hat - dieselbe Grenze wie careAwareClause() fuer die Datensaetze
  // selbst (authorize/care.ts), hier auf den je Typ juengsten Datensatz
  // angewandt statt sie ein zweites Mal zu formulieren. computeDueForUser()
  // liest die Sichtbarkeit ohnehin schon je Datensatz mit, kein zweiter
  // Query pro Eintrag noetig.
  items = readableRows(db.get(), items, viewer, personId);

  res.json({ data: items });
});

export default router;
