/**
 * Modul: Schichtplan — Extras (zusaetzliche Schichten)
 * Zweck: Additiv zu Muster/Override (server/services/schedule.js#scheduleData),
 *        nie ein Ersatz - beliebig viele Zeilen je Nutzer und Tag, auch mit
 *        demselben shift_type_id (z.B. Bereitschaft NEBEN einer regulaeren
 *        Schicht). Adressiert ueber die eigene id, nie ueber
 *        (user_id, date_key) wie bei den Overrides - es gibt nichts, worauf
 *        eine zweite Zeile fuer denselben Tag treffen koennte.
 *
 * Eigene Datei statt in routes/schedule.js: historisch, weil der Reminder-Sync
 * scheduleData damals aus routes/schedule.js importierte und ein Rückimport
 * dort einen Zyklus ergeben hätte (gleicher Grund wie routes/schedule-feed.js
 * und routes/schedule-preferences.js). scheduleData lebt inzwischen in
 * services/schedule.js; die Datei-Trennung bleibt, sie hält den Hauptrouter
 * lesbar.
 */

import express from 'express';
import * as db from '../db.js';
import { collectErrors, date, id, str } from '../middleware/validate.js';
import { dateKeysInRange } from '../services/schedule.js';
import { daysBetweenDateKeys } from '../utils/timezone.js';
import { syncScheduleRemindersForUser } from '../services/schedule-reminders.js';
import { validateFieldValues, replaceFieldValues, fieldValuesFor, isAdmin } from './schedule.js';
import { createLogger } from '../logger.js';

const router = express.Router();
const log = createLogger('Schedule');
const actorId = (req) => req.authUserId || req.session?.userId;
const fail = (res, code, error) => res.status(code).json({ error, code });
const userExists = (value) => !!db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(value);
const typeExists = (value) => !!db.get().prepare('SELECT 1 FROM schedule_shift_types WHERE id = ?').get(value);
const mineOrAdmin = (req, userId) => isAdmin(req) || actorId(req) === userId;
// Ein committeter Schreibvorgang darf nicht an einem werfenden Resync
// scheitern - der Aufrufer hat sein Extra bereits, ein 500er hier wuerde ihm
// das Gegenteil vorspiegeln und einen idempotenten Retry zur Dublette machen.
// Deshalb protokolliert dieser Wrapper nur und laesst die Antwort in Ruhe -
// derselbe Schutz, den PUT/DELETE /overrides in schedule.js jetzt auch haben.
function resyncQuietly(userId) {
  try { syncScheduleRemindersForUser(db.get(), userId); }
  catch (err) { log.error('Error resyncing schedule reminders after extra shift write:', err.message); }
}

// Gleiche Grenze wie schedule-preferences.js's MAX_OFFSET_MINUTES: NULL heisst
// "kein eigener Vorlauf fuer dieses Extra" (siehe schedule-reminders.js).
const MAX_REMINDER_OFFSET_MINUTES = 24 * 60;
function reminderOffset(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_REMINDER_OFFSET_MINUTES) return { value: null, error: `reminder_offset_minutes must be an integer between 0 and ${MAX_REMINDER_OFFSET_MINUTES}, or null.` };
  return { value: n, error: null };
}

// Gleiche Begruendung wie routes/schedule.js#MAX_FILL_DAYS: /extras/fill
// schreibt echte Zeilen, deshalb ein eigener, kleinerer Deckel statt des
// groesseren Lese-Deckels.
const MAX_FILL_DAYS = 100;

router.get('/', (req, res) => {
  const user = req.query.user_id == null ? null : id(req.query.user_id, 'user_id'); const from = date(req.query.from, 'from'); const to = date(req.query.to, 'to');
  const errors = collectErrors([user, from, to].filter(Boolean)); if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (errors.length) return fail(res, 400, errors.join(' ')); if (user && !userExists(user.value)) return fail(res, 404, 'User not found.');
  const where = []; const args = []; if (user) { where.push('user_id=?'); args.push(user.value); } if (from.value) { where.push('date_key>=?'); args.push(from.value); } if (to.value) { where.push('date_key<=?'); args.push(to.value); }
  const rows = db.get().prepare(`SELECT * FROM schedule_extra_shifts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY user_id,date_key`).all(...args);
  const values = fieldValuesFor('extra_shift', rows.map((row) => row.id));
  return res.json({ data: rows.map((row) => ({ ...row, field_values: values.get(row.id) ?? {} })) });
});

router.post('/', (req, res) => {
  const key = date(req.body?.date_key, 'date_key', true); const user = id(req.body?.user_id ?? actorId(req), 'user_id'); const typeId = id(req.body?.shift_type_id, 'shift_type_id'); const note = str(req.body?.note, 'note', { required: false, max: 5000 }); const offset = reminderOffset(req.body?.reminder_offset_minutes);
  const fields = validateFieldValues(req.body?.field_values, typeId.value ?? null);
  const errors = collectErrors([key, user, typeId, note, offset].filter(Boolean)); if (fields.error) errors.push(fields.error); if (user.value && !userExists(user.value)) errors.push('user_id does not exist.'); if (typeId.value && !typeExists(typeId.value)) errors.push('shift_type_id does not exist.'); if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.'); if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  // Anlegen und replaceFieldValues() in EINER Transaktion: sonst stand die
  // Zeile schon committed, bevor ihre Werte geschrieben waren, und ein Wurf
  // dazwischen liess einen 500er auf eine bereits vorhandene Zeile antworten -
  // ein idempotenter Retry (siehe idempotency-keys) haette sie dann verdoppelt.
  const insertedId = db.get().transaction(() => {
    const result = db.get().prepare('INSERT INTO schedule_extra_shifts (user_id, date_key, shift_type_id, note, reminder_offset_minutes, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(user.value, key.value, typeId.value, note.value, offset.value, actorId(req));
    replaceFieldValues('extra_shift', result.lastInsertRowid, fields.values);
    return result.lastInsertRowid;
  })();
  resyncQuietly(user.value);
  const row = db.get().prepare('SELECT * FROM schedule_extra_shifts WHERE id = ?').get(insertedId);
  res.status(201).json({ data: { ...row, field_values: fieldValuesFor('extra_shift', [row.id]).get(row.id) ?? {} } });
});

/**
 * Fuellt einen Zeitraum in einem Aufruf - einfacher als /overrides/fill: kein
 * ON CONFLICT noetig, jede Zeile ist unabhaengig, es gibt nichts zu ersetzen.
 */
router.post('/fill', (req, res) => {
  const user = id(req.body?.user_id ?? actorId(req), 'user_id');
  const from = date(req.body?.from, 'from', true);
  const to = date(req.body?.to, 'to', true);
  const typeId = id(req.body?.shift_type_id, 'shift_type_id');
  const note = str(req.body?.note, 'note', { required: false, max: 5000 });
  const offset = reminderOffset(req.body?.reminder_offset_minutes);
  const fields = validateFieldValues(req.body?.field_values, typeId.value ?? null);
  const errors = collectErrors([user, from, to, typeId, note, offset].filter(Boolean));
  if (fields.error) errors.push(fields.error);
  if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (user.value && !userExists(user.value)) errors.push('user_id does not exist.');
  if (typeId.value && !typeExists(typeId.value)) errors.push('shift_type_id does not exist.');
  if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.');
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  const span = daysBetweenDateKeys(from.value, to.value);
  if (span === null || span + 1 > MAX_FILL_DAYS) {
    return fail(res, 400, `The range must not exceed ${MAX_FILL_DAYS} days.`);
  }
  const keys = dateKeysInRange(from.value, to.value);
  const insert = db.get().prepare('INSERT INTO schedule_extra_shifts (user_id, date_key, shift_type_id, note, reminder_offset_minutes, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id');
  db.get().transaction(() => {
    for (const key of keys) {
      const row = insert.get(user.value, key, typeId.value, note.value, offset.value, actorId(req));
      replaceFieldValues('extra_shift', row.id, fields.values);
    }
  })();
  resyncQuietly(user.value);
  res.json({ data: { created: keys.length } });
});

router.put('/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_extra_shifts WHERE id = ?').get(key.value);
  if (!old) return fail(res, 404, 'Extra shift not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  const dateKey = req.body?.date_key === undefined ? { value: old.date_key } : date(req.body.date_key, 'date_key', true);
  const typeId = req.body?.shift_type_id === undefined ? { value: old.shift_type_id } : id(req.body.shift_type_id, 'shift_type_id');
  const note = req.body?.note === undefined ? { value: old.note } : str(req.body.note, 'note', { required: false, max: 5000 });
  const offset = req.body?.reminder_offset_minutes === undefined ? { value: old.reminder_offset_minutes, error: null } : reminderOffset(req.body.reminder_offset_minutes);
  // Gegen den EFFEKTIVEN Schichttyp validieren (den neuen, falls ersetzt -
  // sonst den bisherigen): field_values muessen zu dem Typ passen, der nach
  // diesem Speichern tatsaechlich gilt, nicht zu einem, der gerade verlassen wird.
  const fields = validateFieldValues(req.body?.field_values, typeId.value ?? null);
  const errors = collectErrors([dateKey, typeId, note, offset]);
  if (fields.error) errors.push(fields.error);
  if (typeId.value && !typeExists(typeId.value)) errors.push('shift_type_id does not exist.');
  if (errors.length) return fail(res, 400, errors.join(' '));
  db.get().prepare('UPDATE schedule_extra_shifts SET date_key=?, shift_type_id=?, note=?, reminder_offset_minutes=? WHERE id=?').run(dateKey.value, typeId.value, note.value, offset.value, old.id);
  if (req.body?.field_values !== undefined) replaceFieldValues('extra_shift', old.id, fields.values);
  resyncQuietly(old.user_id);
  const row = db.get().prepare('SELECT * FROM schedule_extra_shifts WHERE id=?').get(old.id);
  return res.json({ data: { ...row, field_values: fieldValuesFor('extra_shift', [row.id]).get(row.id) ?? {} } });
});

router.delete('/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_extra_shifts WHERE id = ?').get(key.value);
  if (!old) return fail(res, 404, 'Extra shift not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  db.get().transaction(() => {
    db.get().prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='extra_shift' AND entry_id=?`).run(old.id);
    db.get().prepare('DELETE FROM schedule_extra_shifts WHERE id=?').run(old.id);
  })();
  resyncQuietly(old.user_id);
  return res.status(204).end();
});

export default router;
