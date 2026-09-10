/** Schedule API: patterns are computed into entries, never calendar events. */
import express from 'express';
import * as db from '../db.js';
import { bool, color, collectErrors, date, id, num, str, time } from '../middleware/validate.js';
import { createLogger } from '../logger.js';
import { dateKeysInRange, scheduleData, fieldsForShiftTypes, fieldValuesFor, typeColumns } from '../services/schedule.js';
// Re-Export fuer bestehende Importe (routes/schedule-extras.js, Tests): die
// Definitionen liegen seit dem Zyklus-Bruch in services/schedule.js - dieser
// Router importiert den Reminder-Sync, der Sync braucht scheduleData(), und
// beides aus DIESER Datei waere genau der Rueckimport-Zyklus, den
// routes/schedule-extras.js' eigener Kopfkommentar seit jeher vermeidet.
export { scheduleData, fieldValuesFor } from '../services/schedule.js';
import { daysBetweenDateKeys } from '../utils/timezone.js';
import { isHouseholdMember } from '../services/member-email.js';
import { syncScheduleRemindersForUser } from '../services/schedule-reminders.js';

const router = express.Router();
const log = createLogger('Schedule');
const actorId = (req) => req.authUserId || req.session?.userId;
export const isAdmin = (req) => req.authRole === 'admin' || req.session?.role === 'admin';
const fail = (res, code, error) => res.status(code).json({ error, code });
const userExists = (value) => !!db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(value);
const typeExists = (value) => !!db.get().prepare('SELECT 1 FROM schedule_shift_types WHERE id = ?').get(value);
const customFieldExists = (value) => !!db.get().prepare('SELECT 1 FROM schedule_custom_fields WHERE id = ?').get(value);
const mineOrAdmin = (req, userId) => isAdmin(req) || actorId(req) === userId;

// Wer darf als eigene Spalte in der Uebersicht (Overview-Tab) auftauchen? Nur
// echte Haushaltsmitglieder - Haushaltshilfen (housekeeping_workers) und
// Split-Expense-Gaeste (split_expense_guest_users) sollen nie eine leere Spur
// bekommen. isHouseholdMember() ist die einzige Kopie dieser Regel im ganzen
// Repo (server/services/member-email.js) - hier absichtlich wiederverwendet,
// nicht neu geschrieben.
router.get('/household-members', (_req, res) => {
  const rows = db.get()
    .prepare('SELECT id, display_name, avatar_color, avatar_data FROM users ORDER BY display_name COLLATE NOCASE')
    .all();
  res.json({ data: rows.filter((row) => isHouseholdMember(row.id)) });
});

/** Lucides laengster Name liegt bei 34 Zeichen; 48 laesst Luft nach oben - dieselbe Grenze wie bei den Schnellzugriffen (quick-links.js). */
const MAX_ICON_NAME_LENGTH = 48;
const ICON_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Wie iconName() in quick-links.js: der Name ist zur Laufzeit gewaehlt, geprueft wird nur die Form, nicht gegen Lucides Vorrat - das Vorrat-Modul (utils/lucide-icons.js) liegt auf `window.lucide` und ist serverseitig nicht erreichbar. */
function shiftIcon(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  if (typeof value !== 'string') return { value: null, error: 'icon must be a string.' };
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: null };
  if (trimmed.length > MAX_ICON_NAME_LENGTH) return { value: null, error: 'icon is too long.' };
  if (!ICON_NAME_RE.test(trimmed)) return { value: null, error: 'icon must contain only lowercase letters, digits, and hyphens.' };
  return { value: trimmed, error: null };
}

/**
 * Ein Schichttyp gehoert dem Haushalt, nicht einer Person: er taucht in den
 * Mustern aller Mitglieder auf. Anlegen darf ihn deshalb jeder - das nimmt
 * niemandem etwas weg -, aendern und loeschen nur, wer ihn angelegt hat, oder
 * ein Admin. Sonst benennt ein Mitglied die Fruehschicht der ganzen Familie um.
 *
 * `created_by` ist `ON DELETE SET NULL`: ein Typ, dessen Ersteller nicht mehr
 * da ist, wird verwaist und liegt damit bei den Admins - nicht bei allen.
 */
const ownTypeOrAdmin = (req, type) => isAdmin(req) || (type.created_by != null && type.created_by === actorId(req));

/**
 * Hat SQLite das Loeschen wegen einer bestehenden Referenz abgelehnt?
 *
 * Steht als benannte Funktion hier und nicht als Ausdruck im Handler, damit ein
 * Test sie direkt befragen kann: der Handler antwortete vorher auf JEDEN Fehler
 * mit "noch in Benutzung", und ein Test auf den Statuscode allein bleibt dabei
 * gruen - er misst das Ergebnis, nicht den Grund.
 *
 * Gemessen und nicht geraten: ein abgelehntes `ON DELETE RESTRICT` kommt als
 * `SQLITE_CONSTRAINT_TRIGGER` an, NICHT als `_FOREIGNKEY` - die Meldung lautet
 * "FOREIGN KEY constraint failed", der Code sagt etwas anderes. Deshalb das
 * Praefix ueber alle Constraint-Varianten; ein DELETE kann ohnehin keinen
 * UNIQUE- oder CHECK-Verstoss ausloesen.
 */
export function isStillReferenced(err) {
  return String(err?.code || '').startsWith('SQLITE_CONSTRAINT');
}

// Der Zeitraum von `/entries` muss eine Obergrenze haben: `dateKeysInRange()`
// baut EINEN String je Tag, und `resolveEntries()` laeuft ihn je Haushaltsmitglied
// durch. `from=1000-01-01&to=9999-12-31` sind rund 3,3 Millionen Tage - synchron,
// je Mitglied, bei jedem Aufruf. Ein angemeldetes Mitglied oder ein Token mit
// `schedule:read` koennte den Server damit anhalten.
//
// Zwei Jahre und ein Tag: die Statistik-Ansicht bietet hoechstens ein Jahr an,
// und ein Jahreswechsel-Zeitraum ueber zwei Kalenderjahre bleibt darin bequem.
// Wie MAX_ITER in calendar-events.js begrenzt das die ARBEIT und nicht die
// Gueltigkeit der Eingabe - deshalb 400 mit Begruendung statt stiller Kuerzung.
const MAX_RANGE_DAYS = 731;

// `/overrides/fill` schreibt echte Zeilen, `/entries` liest nur - MAX_RANGE_DAYS
// gehoert deshalb nicht hierher, so verlockend die Wiederverwendung waere. Die
// Modul-Idee (SPEC.md, "Schedule") ist ausdruecklich "computed on read, never
// materialised" - ein Zwei-Jahre-Fuellen wuerde Overrides zu einem zweiten Weg
// machen, ein Muster zu bauen, nur ohne dessen Zyklus-Arithmetik. Die Grenze
// ist deshalb eigens gesetzt, nicht geerbt: gross genug fuer eine Abwesenheit
// (Urlaub, Elternzeit, eine Vertretung ueber ein Quartal), klein genug, dass
// sie keine Schatten-Rotation traegt.
const MAX_FILL_DAYS = 100;

// `PUT /patterns/:id/days` ersetzt IMMER das ganze Muster in einem Rutsch, und
// `scheduleData()` (services/schedule.js) loest jede Zeile fuer jeden passenden Zyklustag zu
// einem eigenen Entry auf - das trifft GET /entries, den ICS-Feed, den
// Kalender-Overlay und das Dashboard gleichermassen. Ein Stundenplan (der
// Grund fuer "mehrere Zeilen je Position", siehe unten) hat hoechstens rund
// zehn Zeilen je Tag ueber hoechstens rund vierzehn Positionen (zwei Wochen,
// A/B) - einige hundert Zeilen decken das grosszuegig, ohne eine Zeile je
// Position ueber den vollen 366-Tage-Zyklus zuzulassen, was keine echte
// Zeitplanung mehr waere, sondern gespeicherte Lese-Verstaerkung.
const MAX_PATTERN_DAY_ROWS = 500;


router.get('/entries', (req, res) => {
  const from = date(req.query.from, 'from', true); const to = date(req.query.to, 'to', true);
  const requested = req.query.user_id == null ? null : id(req.query.user_id, 'user_id');
  const errors = collectErrors([from, to, requested].filter(Boolean));
  if (errors.length || (from.value && to.value && from.value > to.value)) return fail(res, 400, errors.join(' ') || 'from must be before to.');
  const span = daysBetweenDateKeys(from.value, to.value);
  if (span === null || span + 1 > MAX_RANGE_DAYS) {
    return fail(res, 400, `The range must not exceed ${MAX_RANGE_DAYS} days.`);
  }
  if (requested && !userExists(requested.value)) return fail(res, 404, 'User not found.');
  try { res.json({ data: scheduleData(from.value, to.value, requested?.value ?? null) }); }
  catch (err) {
    log.error('Error resolving schedule entries:', err.message);
    return fail(res, 500, 'Schedule entries could not be resolved.');
  }
});

// Bettet die eigenen Felder in EINE Schichttyp-Zeile ein - dasselbe fieldsForShiftTypes(), nur fuer
// den Ein-Zeilen-Fall (create/update), damit eine Antwort nach POST/PUT dieselbe Form traegt wie
// eine Zeile aus der Liste, statt "fields" nur dort zu zeigen, wo ohnehin schon gelistet wird.
function withFields(type) {
  return { ...type, fields: fieldsForShiftTypes([type.id]).get(type.id) ?? [] };
}

const MAX_FIELD_VALUE_LENGTH = 500;
function fieldValue(v) {
  if (v === undefined || v === null || v === '') return { value: null, error: null };
  const s = String(v).trim();
  if (!s) return { value: null, error: null };
  if (s.length > MAX_FIELD_VALUE_LENGTH) return { value: null, error: `value may be at most ${MAX_FIELD_VALUE_LENGTH} characters long.` };
  return { value: s, error: null };
}
/**
 * Validiert ein `field_values`-Objekt ({custom_field_id: Wert}) gegen die Felder, die WIRKLICH an
 * `shiftTypeId` haengen - ein Feld, das nicht angeheftet ist, waere ein Wert ohne Definition dahinter.
 * Leere Werte werden stillschweigend uebersprungen (siehe schedule_custom_field_values' eigenem
 * CHECK: "keine Zeile" heisst "nicht gesetzt", nie eine leere Zeichenkette).
 * @returns {{ values: Array<[number, string]>, error: string|null }}
 */
export function validateFieldValues(raw, shiftTypeId) {
  if (raw === undefined || raw === null) return { values: [], error: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { values: [], error: 'field_values must be an object.' };
  const keys = Object.keys(raw);
  if (!keys.length) return { values: [], error: null };
  if (shiftTypeId == null) return { values: [], error: 'field_values requires a shift_type_id.' };
  const attached = new Set(db.get().prepare('SELECT custom_field_id FROM schedule_shift_type_fields WHERE shift_type_id = ?').all(shiftTypeId).map((r) => r.custom_field_id));
  const values = [];
  // `id()` normalisiert per parseInt - "1" und "01" liefern denselben
  // Schluessel. Ungeprueft wuerden beide Zeilen bis zum insert kommen und dort
  // an UNIQUE(entry_type,entry_id,custom_field_id) scheitern, als roher 500er,
  // nachdem der Aufrufer schon einen Teil geschrieben hat - deshalb hier
  // vorher abgewiesen, wie das Anheften bei shift-types/:id/fields es auch tut.
  const seen = new Set();
  for (const key of keys) {
    const fieldId = id(key, 'field_values key');
    if (fieldId.error) return { values: [], error: fieldId.error };
    if (seen.has(fieldId.value)) return { values: [], error: `field ${key} must not repeat.` };
    seen.add(fieldId.value);
    if (!attached.has(fieldId.value)) return { values: [], error: `field ${key} is not attached to this shift type.` };
    const parsed = fieldValue(raw[key]);
    if (parsed.error) return { values: [], error: parsed.error };
    if (parsed.value != null) values.push([fieldId.value, parsed.value]);
  }
  return { values, error: null };
}
/**
 * Ersetzt alle Werte eines Vorkommens (loeschen, neu anlegen) - dieselbe
 * delete-then-insert-Regel wie ueberall sonst in diesem Modul, hier fuer eine
 * einzelne Zeile statt einer ganzen Menge.
 */
export function replaceFieldValues(entryType, entryId, values) {
  db.get().prepare('DELETE FROM schedule_custom_field_values WHERE entry_type = ? AND entry_id = ?').run(entryType, entryId);
  if (!values.length) return;
  const insert = db.get().prepare('INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES (?, ?, ?, ?)');
  for (const [fieldId, value] of values) insert.run(entryType, entryId, fieldId, value);
}
router.get('/shift-types', (_req, res) => {
  const types = db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types ORDER BY name COLLATE NOCASE`).all();
  const fields = fieldsForShiftTypes(types.map((type) => type.id));
  res.json({ data: types.map((type) => ({ ...type, fields: fields.get(type.id) ?? [] })) });
});
router.post('/shift-types', (req, res) => {
  const name = str(req.body?.name, 'name'); const shortCode = str(req.body?.short_code, 'short_code', { required: false, max: 12 });
  const start = time(req.body?.start_time, 'start_time'); const end = time(req.body?.end_time, 'end_time'); const shade = color(req.body?.color || '#6C3AED', 'color');
  const icon = shiftIcon(req.body?.icon);
  const errors = collectErrors([name, shortCode, start, end, shade, icon]);
  if ((start.value == null) !== (end.value == null)) errors.push('start_time and end_time must be provided together.');
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
  const result = db.get().prepare('INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, icon, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name.value, shortCode.value, start.value, end.value, shade.value, icon.value, actorId(req));
  res.status(201).json({ data: withFields(db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(result.lastInsertRowid)) });
});
router.delete('/shift-types/:id', (req, res) => {
  const shiftType = id(req.params.id, 'id');
  if (shiftType.error) return fail(res, 400, shiftType.error);
  const existing = db.get().prepare('SELECT id, created_by FROM schedule_shift_types WHERE id = ?').get(shiftType.value);
  if (!existing) return fail(res, 404, 'Shift type not found.');
  if (!ownTypeOrAdmin(req, existing)) return fail(res, 403, 'Forbidden.');
  try {
    db.get().prepare('DELETE FROM schedule_shift_types WHERE id = ?').run(existing.id);
    return res.status(204).end();
  } catch (err) {
    // Nur der Fremdschluessel wird als "in Benutzung" gedeutet. Vorher fing der
    // Zweig JEDEN Fehler und nannte denselben Grund - ein Schreibfehler im SQL
    // haette dem Aufrufer erzaehlt, der Typ sei noch im Einsatz.
    if (isStillReferenced(err)) return fail(res, 409, 'Shift type is in use.');
    log.error('Error deleting shift type:', err.message);
    return fail(res, 500, 'Internal error.');
  }
});

const customFieldColumns = 'id, name, created_by, created_at, updated_at';

// Definiert einmal, angeheftet an beliebig viele Schichttypen (schedule_shift_type_fields,
// siehe Migration 189) - derselbe "gehoert dem Haushalt, nicht einer Person"-Gedanke wie bei
// Schichttypen: anlegen darf jeder, aendern/loeschen nur wer ihn angelegt hat oder ein Admin.
router.get('/custom-fields', (_req, res) => res.json({ data: db.get().prepare(`SELECT ${customFieldColumns} FROM schedule_custom_fields ORDER BY name COLLATE NOCASE`).all() }));
router.post('/custom-fields', (req, res) => {
  const name = str(req.body?.name, 'name', { max: 100 });
  if (name.error) return fail(res, 400, name.error);
  const result = db.get().prepare('INSERT INTO schedule_custom_fields (name, created_by) VALUES (?, ?)').run(name.value, actorId(req));
  res.status(201).json({ data: db.get().prepare(`SELECT ${customFieldColumns} FROM schedule_custom_fields WHERE id = ?`).get(result.lastInsertRowid) });
});
router.put('/custom-fields/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare(`SELECT ${customFieldColumns} FROM schedule_custom_fields WHERE id = ?`).get(key.value);
  if (!old) return fail(res, 404, 'Custom field not found.');
  if (!ownTypeOrAdmin(req, old)) return fail(res, 403, 'Forbidden.');
  const name = req.body?.name === undefined ? { value: old.name, error: null } : str(req.body.name, 'name', { max: 100 });
  if (name.error) return fail(res, 400, name.error);
  db.get().prepare('UPDATE schedule_custom_fields SET name=? WHERE id=?').run(name.value, key.value);
  res.json({ data: db.get().prepare(`SELECT ${customFieldColumns} FROM schedule_custom_fields WHERE id = ?`).get(key.value) });
});
router.delete('/custom-fields/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT id, created_by FROM schedule_custom_fields WHERE id = ?').get(key.value);
  if (!old) return fail(res, 404, 'Custom field not found.');
  if (!ownTypeOrAdmin(req, old)) return fail(res, 403, 'Forbidden.');
  // Kaskadiert ueber schedule_shift_type_fields/schedule_custom_field_values (ON DELETE CASCADE) -
  // anders als ein Schichttyp (der `isStillReferenced`-409-Schutz) ist ein geloeschtes Feld eine
  // bewusste, vom Frontend bestaetigte Aktion (siehe delete-pattern), kein Unfall.
  db.get().prepare('DELETE FROM schedule_custom_fields WHERE id = ?').run(old.id);
  return res.status(204).end();
});

router.get('/patterns', (req, res) => {
  const requested = req.query.user_id == null ? null : id(req.query.user_id, 'user_id');
  if (requested?.error) return fail(res, 400, requested.error);
  if (requested && !userExists(requested.value)) return fail(res, 404, 'User not found.');
  const rows = requested ? db.get().prepare('SELECT * FROM schedule_patterns WHERE user_id = ? ORDER BY valid_from DESC, id DESC').all(requested.value) : db.get().prepare('SELECT * FROM schedule_patterns ORDER BY user_id, valid_from DESC, id DESC').all();
  res.json({ data: rows });
});
router.post('/patterns', (req, res) => {
  const user = id(req.body?.user_id ?? actorId(req), 'user_id'); const name = str(req.body?.name, 'name'); const anchor = date(req.body?.anchor_date, 'anchor_date', true);
  const length = num(req.body?.cycle_length, 'cycle_length', { required: true }); const from = date(req.body?.valid_from, 'valid_from'); const until = date(req.body?.valid_until, 'valid_until');
  const active = req.body?.is_active === undefined ? { value: true, error: null } : bool(req.body.is_active, 'is_active');
  const errors = collectErrors([user, name, anchor, length, from, until, active]); if (!Number.isInteger(length.value) || length.value < 1 || length.value > 366) errors.push('cycle_length must be between 1 and 366.'); if (user.value && !userExists(user.value)) errors.push('user_id does not exist.');
  if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.'); if (from.value && until.value && from.value > until.value) errors.push('valid_from must be before valid_until.');
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  const result = db.get().prepare('INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length, valid_from, valid_until, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.value, name.value, anchor.value, length.value, from.value, until.value, Number(active.value));
  res.status(201).json({ data: db.get().prepare('SELECT * FROM schedule_patterns WHERE id = ?').get(result.lastInsertRowid) });
});
router.put('/overrides/:dateKey', (req, res) => {
  const key = date(req.params.dateKey, 'date_key', true); const user = id(req.body?.user_id ?? actorId(req), 'user_id'); const typeId = req.body?.shift_type_id == null ? null : id(req.body.shift_type_id, 'shift_type_id'); const note = str(req.body?.note, 'note', { required: false, max: 5000 });
  const errors = collectErrors([key, user, typeId, note].filter(Boolean)); if (user.value && !userExists(user.value)) errors.push('user_id does not exist.'); if (typeId && !typeExists(typeId.value)) errors.push('shift_type_id does not exist.'); if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.');
  const fields = validateFieldValues(req.body?.field_values, typeId?.value ?? null); if (fields.error) errors.push(fields.error);
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  // Upsert und replaceFieldValues() in EINER Transaktion: ohne sie stand der
  // Override schon geschrieben, bevor replaceFieldValues() ueberhaupt lief -
  // ein Wurf dazwischen (z.B. eine spaeter doch noch durchrutschende doppelte
  // Feld-Id) liess die erste Zeile committed und den Aufruf trotzdem mit einem
  // 500er scheitern. `field_values` fehlt im Body ganz = gespeicherte Werte
  // bleiben unangetastet (wie PUT /extras/:id); nur ein ausdruecklich
  // mitgeschicktes Objekt, auch `{}`, ersetzt sie.
  const row = db.get().transaction(() => {
    const upserted = db.get().prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id, note) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date_key) DO UPDATE SET shift_type_id = excluded.shift_type_id, note = excluded.note RETURNING *').get(user.value, key.value, typeId?.value ?? null, note.value);
    if (req.body?.field_values !== undefined) replaceFieldValues('override', upserted.id, fields.values);
    return upserted;
  })();
  try { syncScheduleRemindersForUser(db.get(), user.value); }
  catch (err) { log.error('Error resyncing schedule reminders after override write:', err.message); }
  res.json({ data: { ...row, field_values: fieldValuesFor('override', [row.id]).get(row.id) ?? {} } });
});

router.put('/shift-types/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(key.value);
  if (!old) return fail(res, 404, 'Shift type not found.');
  if (!ownTypeOrAdmin(req, old)) return fail(res, 403, 'Forbidden.');
  const name = req.body?.name === undefined ? { value: old.name } : str(req.body.name, 'name');
  const shortCode = req.body?.short_code === undefined ? { value: old.short_code } : str(req.body.short_code, 'short_code', { required: false, max: 12 });
  const start = req.body?.start_time === undefined ? { value: old.start_time } : time(req.body.start_time, 'start_time');
  const end = req.body?.end_time === undefined ? { value: old.end_time } : time(req.body.end_time, 'end_time');
  // `color()` antwortet auf jeden falsy Wert mit {value: null, error: null}, und
  // die Spalte ist NOT NULL - ein `{"color": ""}` schriebe also NULL und flöge als
  // roher 500er zurueck. Der Ruecksetzer ist die bestehende Farbe und nicht der
  // Palettenerste: die Anfrage sagt "nicht anfassen", nicht "auf Anfang".
  const shade = req.body?.color === undefined || !req.body.color
    ? { value: old.color, error: null }
    : color(req.body.color, 'color');
  const icon = req.body?.icon === undefined ? { value: old.icon, error: null } : shiftIcon(req.body.icon);
  const errors = collectErrors([name, shortCode, start, end, shade, icon]);
  if ((start.value == null) !== (end.value == null)) errors.push('start_time and end_time must be provided together.');
  if (errors.length) return fail(res, 400, errors.join(' '));
  db.get().prepare('UPDATE schedule_shift_types SET name=?, short_code=?, start_time=?, end_time=?, color=?, icon=? WHERE id=?').run(name.value, shortCode.value, start.value, end.value, shade.value, icon.value, key.value);
  return res.json({ data: withFields(db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(key.value)) });
});
// Ersetzt IMMER die gesamte Feldzuordnung eines Schichttyps in einem Rutsch (loeschen, neu
// anlegen) - derselbe Grund wie PUT /patterns/:id/days: kein natuerliches Merkmal, an dem sich
// "unveraendert" von "entfernt" unterscheiden liesse.
router.put('/shift-types/:id/fields', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT id, created_by FROM schedule_shift_types WHERE id = ?').get(key.value);
  if (!old) return fail(res, 404, 'Shift type not found.');
  if (!ownTypeOrAdmin(req, old)) return fail(res, 403, 'Forbidden.');
  if (!Array.isArray(req.body?.fields)) return fail(res, 400, 'fields must be an array.');
  const seen = new Set();
  const rows = [];
  for (const row of req.body.fields) {
    const fieldId = id(row?.custom_field_id, 'custom_field_id');
    const position = num(row?.position, 'position', { required: true });
    const showInOverlay = row?.show_in_overlay === undefined ? { value: false, error: null } : bool(row.show_in_overlay, 'show_in_overlay');
    if (fieldId.error || position.error || !Number.isInteger(position.value) || position.value < 0 || showInOverlay.error) return fail(res, 400, 'Invalid field entry.');
    if (!customFieldExists(fieldId.value)) return fail(res, 400, 'custom_field_id does not exist.');
    if (seen.has(fieldId.value)) return fail(res, 400, 'custom_field_id must not repeat.');
    seen.add(fieldId.value);
    rows.push([fieldId.value, position.value, Number(showInOverlay.value)]);
  }
  db.get().transaction(() => {
    db.get().prepare('DELETE FROM schedule_shift_type_fields WHERE shift_type_id=?').run(old.id);
    const add = db.get().prepare('INSERT INTO schedule_shift_type_fields (shift_type_id,custom_field_id,position,show_in_overlay) VALUES (?,?,?,?)');
    rows.forEach((row) => add.run(old.id, ...row));
  })();
  return res.json({ data: withFields(db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(old.id)) });
});
router.put('/patterns/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  const name = req.body?.name === undefined ? { value: old.name } : str(req.body.name, 'name');
  const anchor = req.body?.anchor_date === undefined ? { value: old.anchor_date } : date(req.body.anchor_date, 'anchor_date', true);
  const length = req.body?.cycle_length === undefined ? { value: old.cycle_length } : num(req.body.cycle_length, 'cycle_length', { required: true });
  const from = req.body?.valid_from === undefined ? { value: old.valid_from } : date(req.body.valid_from, 'valid_from');
  const until = req.body?.valid_until === undefined ? { value: old.valid_until } : date(req.body.valid_until, 'valid_until');
  const active = req.body?.is_active === undefined ? { value: Boolean(old.is_active) } : bool(req.body.is_active, 'is_active');
  const errors = collectErrors([name, anchor, length, from, until, active]);
  if (!Number.isInteger(length.value) || length.value < 1 || length.value > 366) errors.push('cycle_length must be between 1 and 366.');
  if (from.value && until.value && from.value > until.value) errors.push('valid_from must be before valid_until.');
  if (db.get().prepare('SELECT 1 FROM schedule_pattern_days WHERE pattern_id=? AND position>=?').get(old.id, length.value)) errors.push('cycle_length cannot exclude existing pattern days.');
  if (errors.length) return fail(res, 400, errors.join(' '));
  db.get().prepare('UPDATE schedule_patterns SET name=?,anchor_date=?,cycle_length=?,valid_from=?,valid_until=?,is_active=? WHERE id=?').run(name.value, anchor.value, length.value, from.value, until.value, Number(active.value), old.id);
  return res.json({ data: db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(old.id) });
});
router.delete('/patterns/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  // Die Zyklustage kaskadieren mit dem Muster weg (FK CASCADE), ihre
  // schedule_custom_field_values-Zeilen nicht (polymorph, kein echter
  // Fremdschluessel, siehe Migration 189) - deshalb hier dieselbe Reihenfolge
  // wie PUT /patterns/:id/days: Werte ueber die NOCH bekannten Tag-Ids zuerst
  // weg, dann das Muster (das die Tage mitreisst), alles in einer Transaktion.
  db.get().transaction(() => {
    const dayIds = db.get().prepare('SELECT id FROM schedule_pattern_days WHERE pattern_id=?').all(old.id).map((row) => row.id);
    if (dayIds.length) db.get().prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='pattern_day' AND entry_id IN (${dayIds.map(() => '?').join(',')})`).run(...dayIds);
    db.get().prepare('DELETE FROM schedule_patterns WHERE id=?').run(old.id);
  })();
  return res.status(204).end();
});
router.get('/patterns/:id/days', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  if (!db.get().prepare('SELECT 1 FROM schedule_patterns WHERE id=?').get(key.value)) return fail(res, 404, 'Pattern not found.');
  const rows = db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position, id').all(key.value);
  const values = fieldValuesFor('pattern_day', rows.map((row) => row.id));
  return res.json({ data: rows.map((row) => ({ ...row, field_values: values.get(row.id) ?? {} })) });
});
// Ersetzt IMMER alle Zyklustage des Musters in einem Rutsch (loeschen, neu
// anlegen) statt einzelner Upserts - es gibt kein natuerliches Merkmal, an dem
// sich "unveraendert" von "geloescht" unterscheiden liesse (derselbe Grund wie
// server/routes/inventory/item-dates.js). Dieselbe Position darf jetzt
// MEHRFACH vorkommen - ein Zyklustag kann mehrere Klassen zu verschiedenen
// Zeiten tragen (Stundenplan) statt hoechstens einer. Das bedeutet: JEDES
// Speichern vergibt allen Zeilen des Musters frische Ids, auch unveraenderten -
// server/services/schedule-reminders.js's Anker-Sync und die ICS-UIDs
// (server/services/schedule-ics.js) sind bewusst so gebaut, dass sie das
// verkraften (Selbstheilung beim naechsten Sync-Lauf statt einer Kaskade).
router.put('/patterns/:id/days', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  if (!Array.isArray(req.body?.days)) return fail(res, 400, 'days must be an array.');
  if (req.body.days.length > MAX_PATTERN_DAY_ROWS) return fail(res, 400, `days must not exceed ${MAX_PATTERN_DAY_ROWS} rows.`);
  const days = [];
  for (const row of req.body.days) {
    const position = num(row?.position, 'position', { required: true }); const shiftType = row?.shift_type_id == null ? null : id(row.shift_type_id, 'shift_type_id');
    if (position.error || !Number.isInteger(position.value) || position.value < 0 || position.value >= old.cycle_length || shiftType?.error) return fail(res, 400, 'Invalid pattern day.');
    if (shiftType && !typeExists(shiftType.value)) return fail(res, 400, 'shift_type_id does not exist.');
    const fields = validateFieldValues(row?.field_values, shiftType?.value ?? null);
    if (fields.error) return fail(res, 400, fields.error);
    days.push({ position: position.value, shiftTypeId: shiftType?.value ?? null, fieldValues: fields.values });
  }
  // entry_id-Werte fuer schedule_custom_field_values haengen an KEINEM echten
  // Fremdschluessel (polymorph, siehe Migration 189) - das Loeschen der alten
  // Zyklustage kaskadiert also nicht automatisch zu ihren Werten. Beides in
  // derselben Transaktion, in dieser Reihenfolge: alte Werte weg (ueber die
  // NOCH bekannten alten Ids), alte Tage weg, neue Tage rein, neue Werte fuer
  // die frischen Ids rein.
  db.get().transaction(() => {
    const oldIds = db.get().prepare('SELECT id FROM schedule_pattern_days WHERE pattern_id=?').all(old.id).map((row) => row.id);
    if (oldIds.length) db.get().prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='pattern_day' AND entry_id IN (${oldIds.map(() => '?').join(',')})`).run(...oldIds);
    db.get().prepare('DELETE FROM schedule_pattern_days WHERE pattern_id=?').run(old.id);
    const add = db.get().prepare('INSERT INTO schedule_pattern_days (pattern_id,position,shift_type_id) VALUES (?,?,?)');
    for (const day of days) {
      const newId = add.run(old.id, day.position, day.shiftTypeId).lastInsertRowid;
      if (day.fieldValues.length) replaceFieldValues('pattern_day', newId, day.fieldValues);
    }
  })();
  const rows = db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position').all(old.id);
  const values = fieldValuesFor('pattern_day', rows.map((row) => row.id));
  return res.json({ data: rows.map((row) => ({ ...row, field_values: values.get(row.id) ?? {} })) });
});
router.get('/overrides', (req, res) => {
  const user = req.query.user_id == null ? null : id(req.query.user_id, 'user_id'); const from = date(req.query.from, 'from'); const to = date(req.query.to, 'to');
  const errors = collectErrors([user, from, to].filter(Boolean)); if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (errors.length) return fail(res, 400, errors.join(' ')); if (user && !userExists(user.value)) return fail(res, 404, 'User not found.');
  const where = []; const args = []; if (user) { where.push('user_id=?'); args.push(user.value); } if (from.value) { where.push('date_key>=?'); args.push(from.value); } if (to.value) { where.push('date_key<=?'); args.push(to.value); }
  const rows = db.get().prepare(`SELECT * FROM schedule_overrides${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY user_id,date_key`).all(...args);
  const values = fieldValuesFor('override', rows.map((row) => row.id));
  return res.json({ data: rows.map((row) => ({ ...row, field_values: values.get(row.id) ?? {} })) });
});
/**
 * Fuellt einen Zeitraum in einem Aufruf statt einem PUT je Tag - fuer eine
 * Abwesenheit (Urlaub, Vertretung), nicht als Ersatz fuer ein Muster (siehe
 * MAX_FILL_DAYS oben). `from`/`to` sind hier PFLICHT: ein unvollstaendiger
 * Bereich soll mit 400 scheitern, nicht mit `dateKeysInRange()`s stillem
 * leeren Array bei einem invertierten Bereich durchrutschen.
 */
router.post('/overrides/fill', (req, res) => {
  const user = id(req.body?.user_id ?? actorId(req), 'user_id');
  const from = date(req.body?.from, 'from', true);
  const to = date(req.body?.to, 'to', true);
  const typeId = req.body?.shift_type_id == null ? null : id(req.body.shift_type_id, 'shift_type_id');
  const note = str(req.body?.note, 'note', { required: false, max: 5000 });
  const fields = validateFieldValues(req.body?.field_values, typeId?.value ?? null);
  const errors = collectErrors([user, from, to, typeId, note].filter(Boolean));
  if (fields.error) errors.push(fields.error);
  if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (user.value && !userExists(user.value)) errors.push('user_id does not exist.');
  if (typeId && !typeExists(typeId.value)) errors.push('shift_type_id does not exist.');
  if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.');
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  const span = daysBetweenDateKeys(from.value, to.value);
  if (span === null || span + 1 > MAX_FILL_DAYS) {
    return fail(res, 400, `The range must not exceed ${MAX_FILL_DAYS} days.`);
  }
  const keys = dateKeysInRange(from.value, to.value);
  // `note = excluded.note` REPLACES an existing note on every day in the
  // range, including one the caller didn't type themselves - a fill sends one
  // note (or none) for the whole span, and a day inside it keeps whatever it
  // had otherwise. Deliberate: the client's confirm dialog already says
  // "replacing any existing entries in that range", and a fill is meant to
  // read as one action overwriting a span, not a merge that could leave a
  // stale note from before the range was last edited (PR #930 review).
  // Dieselbe Regel gilt jetzt fuer field_values: EIN Satz Werte fuer den
  // ganzen Zeitraum, nicht je Tag verschieden.
  const upsert = db.get().prepare(`INSERT INTO schedule_overrides (user_id, date_key, shift_type_id, note)
    VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date_key) DO UPDATE SET shift_type_id = excluded.shift_type_id, note = excluded.note RETURNING id`);
  db.get().transaction(() => {
    for (const key of keys) {
      const row = upsert.get(user.value, key, typeId?.value ?? null, note.value);
      replaceFieldValues('override', row.id, fields.values);
    }
  })();
  try { syncScheduleRemindersForUser(db.get(), user.value); }
  catch (err) { log.error('Error resyncing schedule reminders after override fill:', err.message); }
  res.json({ data: { updated: keys.length } });
});

/**
 * Loescht einen Zeitraum in einem Aufruf - das Gegenstueck zu `/overrides/fill`,
 * fuer den Fall, dass eine als Gruppe angezeigte Reihe (Client: `overrideGroups()`)
 * ganz oder in einem Randabschnitt wieder verschwinden soll. Anders als beim
 * Fuellen gilt hier NICHT MAX_FILL_DAYS: ein DELETE ueber `date_key BETWEEN`
 * ist eine einzelne indizierte Anweisung, keine Schleife ueber N Zeilen - die
 * Kosten skalieren nicht mit der Spanne, deshalb der groessere Lese-Deckel.
 */
router.delete('/overrides', (req, res) => {
  const user = id(req.query.user_id ?? actorId(req), 'user_id');
  const from = date(req.query.from, 'from', true);
  const to = date(req.query.to, 'to', true);
  const errors = collectErrors([user, from, to]);
  if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (user.value && !userExists(user.value)) errors.push('user_id does not exist.');
  if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.');
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  const span = daysBetweenDateKeys(from.value, to.value);
  if (span === null || span + 1 > MAX_RANGE_DAYS) {
    return fail(res, 400, `The range must not exceed ${MAX_RANGE_DAYS} days.`);
  }
  // entry_id ist polymorph (kein echter Fremdschluessel, siehe Migration 189) -
  // die Werte muessen VOR den Overrides selbst weg, solange die Unterabfrage
  // sie noch findet.
  const result = db.get().transaction(() => {
    db.get().prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='override' AND entry_id IN (SELECT id FROM schedule_overrides WHERE user_id=? AND date_key BETWEEN ? AND ?)`).run(user.value, from.value, to.value);
    return db.get().prepare('DELETE FROM schedule_overrides WHERE user_id=? AND date_key BETWEEN ? AND ?').run(user.value, from.value, to.value);
  })();
  if (result.changes) {
    try { syncScheduleRemindersForUser(db.get(), user.value); }
    catch (err) { log.error('Error resyncing schedule reminders after override range delete:', err.message); }
  }
  res.json({ data: { deleted: result.changes } });
});

router.delete('/overrides/:dateKey', (req, res) => {
  const key = date(req.params.dateKey, 'date_key', true); const user = id(req.query.user_id ?? actorId(req), 'user_id'); const errors = collectErrors([key, user]);
  if (!mineOrAdmin(req, user.value)) return fail(res, 403, 'Forbidden.'); if (errors.length) return fail(res, 400, errors.join(' '));
  const result = db.get().transaction(() => {
    db.get().prepare(`DELETE FROM schedule_custom_field_values WHERE entry_type='override' AND entry_id IN (SELECT id FROM schedule_overrides WHERE user_id=? AND date_key=?)`).run(user.value, key.value);
    return db.get().prepare('DELETE FROM schedule_overrides WHERE user_id=? AND date_key=?').run(user.value, key.value);
  })();
  if (!result.changes) return fail(res, 404, 'Override not found.');
  try { syncScheduleRemindersForUser(db.get(), user.value); }
  catch (err) { log.error('Error resyncing schedule reminders after override delete:', err.message); }
  return res.status(204).end();
});

export default router;
