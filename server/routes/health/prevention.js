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
 * Sichtbarkeit/Betreuung folgen exakt dem Muster von vitals.js - `helpers.js`
 * ist die einzige Stelle, an der die Klausel gebaut werden darf (#884).
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/require-admin.js';
import { todayKey } from '../../utils/timezone.js';
import { defaultVisibilityFor } from './visibility-defaults.js';
import { computeDueForUser } from '../../services/prevention-due.js';
import { syncPreventionRemindersForSubject } from '../../services/prevention-reminders.js';
import {
  log, VISIBILITIES,
  viewerId, careAwareClause, applyUpdate, badRequest,
  resolveOwner, writableClause, canWriteFor,
} from './helpers.js';

const router = express.Router();

const KINDS = ['vaccination', 'checkup'];
const MAX_MONTHS = 600;
const MAX_OFFSET_DAYS = 365;

// --------------------------------------------------------
// Validierungs-Helfer
// --------------------------------------------------------

/** 1-600, ganzzahlig; NULL = einmalig (kein Intervall). */
function vIntervalMonths(value, field = 'default_interval_months') {
  if (value === undefined) return { value: undefined, error: null };
  if (value === null || value === '') return { value: null, error: null };
  const parsed = v.num(value, field);
  if (parsed.error) return parsed;
  if (!Number.isInteger(parsed.value) || parsed.value < 1 || parsed.value > MAX_MONTHS) {
    return { value: null, error: `${field} must be an integer between 1 and ${MAX_MONTHS}.` };
  }
  return { value: parsed.value, error: null };
}

/** 0-365, ganzzahlig; NULL = Modul-Standard (siehe prevention-due.js). */
function vOffsetDays(value) {
  if (value === undefined) return { value: undefined, error: null };
  if (value === null || value === '') return { value: null, error: null };
  const parsed = v.num(value, 'reminder_offset_days');
  if (parsed.error) return parsed;
  if (!Number.isInteger(parsed.value) || parsed.value < 0 || parsed.value > MAX_OFFSET_DAYS) {
    return { value: null, error: `reminder_offset_days must be an integer between 0 and ${MAX_OFFSET_DAYS}.` };
  }
  return { value: parsed.value, error: null };
}

// --------------------------------------------------------
// Typen-Register (household-owned, D2) - Schreiben nur Admins
// --------------------------------------------------------

// GET /prevention/types - allen Mitgliedern zugänglich (Lesen)
router.get('/prevention/types', (req, res) => {
  try {
    const rows = db.get().prepare(
      'SELECT * FROM health_prevention_types ORDER BY sort_order ASC, id ASC'
    ).all();
    res.json({ data: rows });
  } catch (err) {
    log.error('Error listing prevention types:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.post('/prevention/types', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const name = v.str(b.name, 'name', { max: v.MAX_TITLE });
    const kind = v.oneOf(b.kind, KINDS, 'kind');
    const defaultIntervalMonths = vIntervalMonths(b.default_interval_months);
    const icon = v.str(b.icon, 'icon', { max: 50, required: false });
    const sortOrder = v.num(b.sort_order, 'sort_order');

    const errors = v.collectErrors([name, defaultIntervalMonths, icon, sortOrder]);
    if (!kind.value) errors.push('kind is required.');
    if (errors.length) return badRequest(res, errors);

    const result = db.get().prepare(`
      INSERT INTO health_prevention_types (name, kind, default_interval_months, icon, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name.value, kind.value, defaultIntervalMonths.value ?? null,
      icon.value || 'syringe', sortOrder.value ?? 0,
    );

    const row = db.get().prepare('SELECT * FROM health_prevention_types WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating prevention type:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

router.patch('/prevention/types/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

    const existing = db.get().prepare('SELECT id FROM health_prevention_types WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Type not found.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.name !== undefined) { const r = v.str(b.name, 'name', { max: v.MAX_TITLE }); checks.push(r); if (!r.error) fields.name = r.value; }
    if (b.kind !== undefined) {
      const r = v.oneOf(b.kind, KINDS, 'kind');
      checks.push(r.value ? r : { value: null, error: 'kind is invalid.' });
      if (r.value) fields.kind = r.value;
    }
    if (b.default_interval_months !== undefined) {
      const r = vIntervalMonths(b.default_interval_months); checks.push(r); if (!r.error) fields.default_interval_months = r.value;
    }
    if (b.icon !== undefined) { const r = v.str(b.icon, 'icon', { max: 50, required: false }); checks.push(r); if (!r.error) fields.icon = r.value || 'syringe'; }
    if (b.sort_order !== undefined) { const r = v.num(b.sort_order, 'sort_order'); checks.push(r); if (!r.error) fields.sort_order = r.value ?? 0; }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    applyUpdate('health_prevention_types', id, fields);
    res.json({ data: db.get().prepare('SELECT * FROM health_prevention_types WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating prevention type:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /prevention/types/:id - die Historie bleibt (SET NULL + name-Momentaufnahme).
router.delete('/prevention/types/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

    const type = db.get().prepare('SELECT * FROM health_prevention_types WHERE id = ?').get(id);
    if (!type) return res.status(404).json({ error: 'Type not found.', code: 404 });

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
  } catch (err) {
    log.error('Error deleting prevention type:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Protokoll (health_prevention_records)
// --------------------------------------------------------

// GET /prevention/records?user_id=&type_id=&from=&to=
router.get('/prevention/records', (req, res) => {
  try {
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
  } catch (err) {
    log.error('Error listing prevention records:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /prevention/records
router.post('/prevention/records', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};

    const typeId = b.type_id != null && b.type_id !== '' ? parseInt(b.type_id, 10) : null;
    let type = null;
    if (b.type_id != null && b.type_id !== '') {
      if (!typeId) return badRequest(res, ['type_id is invalid.']);
      type = db.get().prepare('SELECT * FROM health_prevention_types WHERE id = ?').get(typeId);
      if (!type) return badRequest(res, ['Unknown type.']);
    }

    const name          = v.str(b.name, 'name', { max: v.MAX_TITLE, required: !type });
    const givenOn       = v.date(b.given_on, 'given_on', true);
    const doseNumber    = v.num(b.dose_number, 'dose_number');
    const batch         = v.str(b.batch, 'batch', { max: v.MAX_SHORT, required: false });
    const provider      = v.str(b.provider, 'provider', { max: v.MAX_SHORT, required: false });
    const note          = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const intervalMonths = vIntervalMonths(b.interval_months, 'interval_months');
    const nextDueOn      = v.date(b.next_due_on, 'next_due_on', false);
    const reminderOffsetDays = vOffsetDays(b.reminder_offset_days);
    const visibility     = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([
      name, givenOn, doseNumber, batch, provider, note,
      intervalMonths, nextDueOn, reminderOffsetDays, visibility,
    ]);
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
      owner.ownerId, typeId, name.value, givenOn.value, doseNumber.value, batch.value, provider.value, note.value,
      intervalMonths.value ?? null, nextDueOn.value, reminderOffsetDays.value ?? null,
      // Fehlt das Feld, gilt die Wahl des EIGENTUEMERS (#958) - nicht die der
      // erfassenden Person: die Zeile gehoert ihm.
      visibility.value || defaultVisibilityFor(db.get(), owner.ownerId, 'prevention'),
      viewer,
    );

    const row = db.get().prepare('SELECT * FROM health_prevention_records WHERE id = ?').get(result.lastInsertRowid);
    try { syncPreventionRemindersForSubject(db.get(), owner.ownerId); } catch (err) {
      log.error('Error syncing prevention reminders after write:', err.message);
    }
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating prevention record:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /prevention/records/:id
router.patch('/prevention/records/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

    const w = writableClause('', viewer);
    const existing = db.get().prepare(`SELECT * FROM health_prevention_records WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
    if (!existing) return res.status(404).json({ error: 'Record not found.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.type_id !== undefined) {
      if (b.type_id === null || b.type_id === '') {
        fields.type_id = null;
      } else {
        const typeId = parseInt(b.type_id, 10);
        const type = typeId ? db.get().prepare('SELECT id FROM health_prevention_types WHERE id = ?').get(typeId) : null;
        if (!type) checks.push({ value: null, error: 'Unknown type.' });
        else fields.type_id = typeId;
      }
    }
    if (b.name !== undefined) { const r = v.str(b.name, 'name', { max: v.MAX_TITLE, required: false }); checks.push(r); if (!r.error) fields.name = r.value; }
    if (b.given_on !== undefined) { const r = v.date(b.given_on, 'given_on', true); checks.push(r); if (!r.error) fields.given_on = r.value; }
    if (b.dose_number !== undefined) { const r = v.num(b.dose_number, 'dose_number'); checks.push(r); if (!r.error) fields.dose_number = r.value; }
    if (b.batch !== undefined) { const r = v.str(b.batch, 'batch', { max: v.MAX_SHORT, required: false }); checks.push(r); if (!r.error) fields.batch = r.value; }
    if (b.provider !== undefined) { const r = v.str(b.provider, 'provider', { max: v.MAX_SHORT, required: false }); checks.push(r); if (!r.error) fields.provider = r.value; }
    if (b.note !== undefined) { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
    if (b.interval_months !== undefined) { const r = vIntervalMonths(b.interval_months, 'interval_months'); checks.push(r); if (!r.error) fields.interval_months = r.value; }
    if (b.next_due_on !== undefined) { const r = v.date(b.next_due_on, 'next_due_on', false); checks.push(r); if (!r.error) fields.next_due_on = r.value; }
    if (b.reminder_offset_days !== undefined) { const r = vOffsetDays(b.reminder_offset_days); checks.push(r); if (!r.error) fields.reminder_offset_days = r.value; }
    if (b.visibility !== undefined) { const r = v.oneOf(b.visibility, VISIBILITIES, 'visibility'); checks.push(r); if (!r.error && r.value) fields.visibility = r.value; }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    applyUpdate('health_prevention_records', id, fields);
    const row = db.get().prepare('SELECT * FROM health_prevention_records WHERE id = ?').get(id);
    try { syncPreventionRemindersForSubject(db.get(), row.user_id); } catch (err) {
      log.error('Error syncing prevention reminders after write:', err.message);
    }
    res.json({ data: row });
  } catch (err) {
    log.error('Error updating prevention record:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /prevention/records/:id
router.delete('/prevention/records/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

    const w = writableClause('', viewer);
    const existing = db.get().prepare(`SELECT * FROM health_prevention_records WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
    if (!existing) return res.status(404).json({ error: 'Record not found.', code: 404 });

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
  } catch (err) {
    log.error('Error deleting prevention record:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /prevention/due?user_id= - die abgeleitete Liste
// --------------------------------------------------------
router.get('/prevention/due', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : viewer;

    const today = todayKey(db.get(), new Date());
    let items = computeDueForUser(db.get(), personId, today);

    if (!canWriteFor(viewer, personId)) {
      // Ohne Betreuung nur, was der Eigentuemer als familiensichtbar markiert
      // hat - dieselbe Grenze wie careAwareClause() fuer die Datensaetze
      // selbst (helpers.js), hier auf den je Typ juengsten Datensatz
      // angewandt statt sie ein zweites Mal zu formulieren. computeDueForUser()
      // liest die Sichtbarkeit ohnehin schon je Datensatz mit, kein zweiter
      // Query pro Eintrag noetig.
      items = items.filter((item) => item.visibility === 'family');
    }

    res.json({ data: items });
  } catch (err) {
    log.error('Error computing prevention due list:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
