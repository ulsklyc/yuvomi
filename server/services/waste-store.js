/**
 * Module: Waste collection store
 * Purpose: all Waste SQL and transactions for the manual-domain tables
 *          (#1063 Phase 1). Accepts an injected database handle throughout, the
 *          same pattern as server/services/countdowns.js. Routes call into this
 *          file only - they never reproduce its queries.
 * Dependencies: server/services/waste-domain.js
 */

import crypto from 'node:crypto';
import { todayKey, shiftDateKey, householdTimeZone } from '../utils/timezone.js';
import { str } from '../middleware/validate.js';
import {
  validateType, validateOneOff, validateScheduleRecurrence, validateOverride, validateRange,
  resolveOccurrences, nextPerType, expandSchedule, WEEKDAY_CODES, OCCURRENCE_RANGE_MAX_DAYS,
} from './waste-domain.js';
import { buildImportPreview, computeDigest, WasteImportError } from './waste-import.js';

export class WasteValidationError extends Error {
  constructor(errors) {
    super(errors.join(' '));
    this.name = 'WasteValidationError';
    this.errors = errors;
  }
}

export class WasteConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WasteConflictError';
  }
}

export class WasteNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WasteNotFoundError';
  }
}

function isUniqueViolation(err) {
  return typeof err?.message === 'string' && err.message.includes('UNIQUE');
}

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export function listTypes(d, { includeArchived = false } = {}) {
  const where = includeArchived ? '' : 'WHERE archived = 0';
  return d.prepare(`SELECT * FROM waste_types ${where} ORDER BY sort_order, id`).all();
}

export function getType(d, id) {
  return d.prepare('SELECT * FROM waste_types WHERE id = ?').get(id) ?? null;
}

function nextTypeSortOrder(d) {
  return d.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM waste_types').get().n;
}

export function createType(d, input, userId) {
  const { value, errors } = validateType(input);
  if (errors.length) throw new WasteValidationError(errors);

  const result = d.prepare(`
    INSERT INTO waste_types (name, icon, color, sort_order, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(value.name, value.icon, value.color, nextTypeSortOrder(d), userId ?? null);
  return getType(d, Number(result.lastInsertRowid));
}

export function updateType(d, id, input) {
  const existing = getType(d, id);
  if (!existing) throw new WasteNotFoundError('Waste type not found.');
  const { value, errors } = validateType(input, { partial: true });
  if (errors.length) throw new WasteValidationError(errors);

  const merged = { ...existing, ...value };
  d.prepare(`
    UPDATE waste_types SET name = ?, icon = ?, color = ?, archived = ?, sort_order = ? WHERE id = ?
  `).run(merged.name, merged.icon, merged.color, merged.archived ? 1 : 0, merged.sort_order, id);
  return getType(d, id);
}

/**
 * Every user's stored feed type selection (waste_feed_type_ids, Migration 205)
 * is a bare JSON array of ids with no foreign key of its own (see
 * waste-ics.js) - deleting a type left a dangling id inside it, benign today
 * (the read-time filter just never matches it) but a live drift risk since
 * SQLite reuses rowids without AUTOINCREMENT: a future type could silently
 * reuse the same id and inherit a stranger's old subscription. Pruned here so
 * the id can never come back to mean something else.
 */
function pruneFeedTypeSelections(d, typeId) {
  const rows = d.prepare(`SELECT id, waste_feed_type_ids AS v FROM users WHERE waste_feed_type_ids IS NOT NULL`).all();
  for (const row of rows) {
    let ids;
    try { ids = JSON.parse(row.v); } catch { continue; }
    if (!Array.isArray(ids) || !ids.includes(typeId)) continue;
    d.prepare('UPDATE users SET waste_feed_type_ids = ? WHERE id = ?')
      .run(JSON.stringify(ids.filter((existingId) => existingId !== typeId)), row.id);
  }
}

/**
 * Refuses deletion when the type has any schedule or one-off pickup
 * referencing it (invariant #5 - "archived or deletion is refused"). The
 * foreign keys on waste_schedules.type_id / waste_one_off_pickups.type_id
 * carry no ON DELETE clause, so an unchecked DELETE would fail the same way
 * via SQLITE_CONSTRAINT anyway; this check exists to give a clean, typed
 * error instead of a raw driver exception.
 */
export function deleteType(d, id) {
  const existing = getType(d, id);
  if (!existing) throw new WasteNotFoundError('Waste type not found.');

  const scheduleCount = d.prepare('SELECT COUNT(*) AS n FROM waste_schedules WHERE type_id = ?').get(id).n;
  const oneOffCount = d.prepare('SELECT COUNT(*) AS n FROM waste_one_off_pickups WHERE type_id = ?').get(id).n;
  const importedCount = d.prepare('SELECT COUNT(*) AS n FROM waste_imported_pickups WHERE type_id = ?').get(id).n;
  if (scheduleCount > 0 || oneOffCount > 0 || importedCount > 0) {
    throw new WasteConflictError('Waste type has schedules, pickups, or imported data and cannot be deleted; archive it instead.');
  }

  d.transaction(() => {
    // waste_reminder_entries cascades from waste_types (ON DELETE CASCADE),
    // but reminders.entity_id carries no real foreign key onto it (the same
    // polymorphic pattern every entity_type uses) - so the cascade silently
    // orphaned any pending reminders.entity_type='waste_pickup' row pointing
    // at this type's anchors. Deleted here, before the cascade removes the
    // anchors those rows point at, the same way waste-reminders.js's own
    // dropAllForUser() already cleans up per-user.
    const anchorIds = d.prepare('SELECT id FROM waste_reminder_entries WHERE type_id = ?').all(id).map((r) => r.id);
    if (anchorIds.length) {
      d.prepare(`DELETE FROM reminders WHERE entity_type = 'waste_pickup' AND entity_id IN (${anchorIds.map(() => '?').join(',')})`)
        .run(...anchorIds);
    }
    pruneFeedTypeSelections(d, id);
    d.prepare('DELETE FROM waste_types WHERE id = ?').run(id);
  })();
}

// -------------------------------------------------------------------------
// Schedules
// -------------------------------------------------------------------------

export function listSchedules(d, { typeId = null, includeInactive = true } = {}) {
  const clauses = [];
  const params = [];
  if (typeId !== null) { clauses.push('type_id = ?'); params.push(typeId); }
  if (!includeInactive) clauses.push('active = 1');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return d.prepare(`SELECT * FROM waste_schedules ${where} ORDER BY id`).all(...params);
}

export function getSchedule(d, id) {
  return d.prepare('SELECT * FROM waste_schedules WHERE id = ?').get(id) ?? null;
}

/** Merges partial PUT input onto an existing row (or POST defaults) before validation. */
function normalizeScheduleInput(input, existing = null) {
  const merged = {
    type_id: input.type_id !== undefined ? input.type_id : existing?.type_id,
    recurrence_kind: input.recurrence_kind !== undefined ? input.recurrence_kind : existing?.recurrence_kind,
    anchor_date: input.anchor_date !== undefined ? input.anchor_date : existing?.anchor_date,
    interval: input.interval !== undefined ? Number(input.interval) : (existing?.interval ?? 1),
    weekdays: input.weekdays !== undefined ? input.weekdays : (existing?.weekdays ?? null),
    month_day: input.month_day !== undefined ? input.month_day : (existing?.month_day ?? null),
    valid_until: input.valid_until !== undefined ? input.valid_until : (existing?.valid_until ?? null),
    active: input.active !== undefined ? (input.active ? 1 : 0) : (existing?.active ?? 1),
  };
  // A caller may pass weekdays as an array ['MO', 'TH'] instead of the stored
  // "MO,TH" string; normalize + dedupe + sort into WEEKDAY_CODES order so the
  // same set always serializes identically regardless of input order.
  if (Array.isArray(merged.weekdays)) {
    merged.weekdays = [...new Set(merged.weekdays)]
      .sort((a, b) => WEEKDAY_CODES.indexOf(a) - WEEKDAY_CODES.indexOf(b))
      .join(',');
  }
  if (merged.recurrence_kind === 'weekly' && merged.month_day !== undefined) merged.month_day = null;
  if (merged.recurrence_kind === 'monthly_fixed_day') merged.weekdays = null;
  return merged;
}

export function createSchedule(d, input, userId) {
  if (!getType(d, input.type_id)) {
    throw new WasteValidationError(['type_id must reference an existing waste type.']);
  }
  const schedule = normalizeScheduleInput(input);
  const errors = validateScheduleRecurrence(schedule);
  if (errors.length) throw new WasteValidationError(errors);

  const result = d.prepare(`
    INSERT INTO waste_schedules
      (type_id, recurrence_kind, anchor_date, interval, weekdays, month_day, valid_until, active, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    schedule.type_id, schedule.recurrence_kind, schedule.anchor_date, schedule.interval,
    schedule.weekdays, schedule.month_day, schedule.valid_until, schedule.active, userId ?? null
  );
  return getSchedule(d, Number(result.lastInsertRowid));
}

export function updateSchedule(d, id, input) {
  const existing = getSchedule(d, id);
  if (!existing) throw new WasteNotFoundError('Waste schedule not found.');
  if (input.type_id !== undefined && !getType(d, input.type_id)) {
    throw new WasteValidationError(['type_id must reference an existing waste type.']);
  }
  const schedule = normalizeScheduleInput(input, existing);
  const errors = validateScheduleRecurrence(schedule);
  if (errors.length) throw new WasteValidationError(errors);

  d.prepare(`
    UPDATE waste_schedules SET
      type_id = ?, recurrence_kind = ?, anchor_date = ?, interval = ?, weekdays = ?,
      month_day = ?, valid_until = ?, active = ?
    WHERE id = ?
  `).run(
    schedule.type_id, schedule.recurrence_kind, schedule.anchor_date, schedule.interval,
    schedule.weekdays, schedule.month_day, schedule.valid_until, schedule.active, id
  );
  return getSchedule(d, id);
}

/** Overrides cascade via ON DELETE CASCADE (invariant #5) - nothing extra to clean up here. */
export function deleteSchedule(d, id) {
  const existing = getSchedule(d, id);
  if (!existing) throw new WasteNotFoundError('Waste schedule not found.');
  d.prepare('DELETE FROM waste_schedules WHERE id = ?').run(id);
}

// -------------------------------------------------------------------------
// Overrides
// -------------------------------------------------------------------------

export function listOverrides(d, scheduleId) {
  return d.prepare('SELECT * FROM waste_schedule_overrides WHERE schedule_id = ? ORDER BY original_date')
    .all(scheduleId);
}

/** schedule_id -> overrides[], for bulk range reads. */
function loadOverridesBySchedule(d, scheduleIds) {
  const map = new Map();
  if (!scheduleIds.length) return map;
  const placeholders = scheduleIds.map(() => '?').join(',');
  const rows = d.prepare(
    `SELECT * FROM waste_schedule_overrides WHERE schedule_id IN (${placeholders})`
  ).all(...scheduleIds);
  for (const row of rows) {
    if (!map.has(row.schedule_id)) map.set(row.schedule_id, []);
    map.get(row.schedule_id).push(row);
  }
  return map;
}

/**
 * Creates or replaces the override for one calculated occurrence
 * (schedule_id, original_date). `replacement_date: null` records an explicit
 * skip. Refuses an original_date that isn't actually one of the schedule's
 * own calculated occurrences (checked against the RAW rule, ignoring any
 * other existing override, since an override always targets a genuine
 * calculated date - never another override's replacement).
 */
export function upsertOverride(d, scheduleId, input) {
  const schedule = getSchedule(d, scheduleId);
  if (!schedule) throw new WasteNotFoundError('Waste schedule not found.');

  const errors = validateOverride(input);
  if (errors.length) throw new WasteValidationError(errors);

  const raw = expandSchedule(schedule, [], input.original_date, input.original_date);
  if (raw.length === 0) {
    throw new WasteValidationError(['original_date is not a calculated occurrence of this schedule.']);
  }

  d.prepare(`
    INSERT INTO waste_schedule_overrides (schedule_id, original_date, replacement_date, note)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(schedule_id, original_date) DO UPDATE SET
      replacement_date = excluded.replacement_date, note = excluded.note
  `).run(scheduleId, input.original_date, input.replacement_date ?? null, input.note ?? null);

  return d.prepare('SELECT * FROM waste_schedule_overrides WHERE schedule_id = ? AND original_date = ?')
    .get(scheduleId, input.original_date);
}

export function deleteOverride(d, scheduleId, originalDate) {
  const result = d.prepare('DELETE FROM waste_schedule_overrides WHERE schedule_id = ? AND original_date = ?')
    .run(scheduleId, originalDate);
  if (result.changes === 0) throw new WasteNotFoundError('Override not found.');
}

// -------------------------------------------------------------------------
// One-off pickups
// -------------------------------------------------------------------------

export function listOneOffs(d, { typeId = null } = {}) {
  if (typeId !== null) {
    return d.prepare('SELECT * FROM waste_one_off_pickups WHERE type_id = ? ORDER BY date').all(typeId);
  }
  return d.prepare('SELECT * FROM waste_one_off_pickups ORDER BY date').all();
}

export function getOneOff(d, id) {
  return d.prepare('SELECT * FROM waste_one_off_pickups WHERE id = ?').get(id) ?? null;
}

export function createOneOff(d, input, userId) {
  if (!getType(d, input.type_id)) {
    throw new WasteValidationError(['type_id must reference an existing waste type.']);
  }
  const { value, errors } = validateOneOff(input);
  if (errors.length) throw new WasteValidationError(errors);

  try {
    const result = d.prepare(`
      INSERT INTO waste_one_off_pickups (type_id, date, note, created_by)
      VALUES (?, ?, ?, ?)
    `).run(input.type_id, value.date, value.note, userId ?? null);
    return getOneOff(d, Number(result.lastInsertRowid));
  } catch (err) {
    if (isUniqueViolation(err)) throw new WasteConflictError('A one-off pickup already exists for this type and date.');
    throw err;
  }
}

export function updateOneOff(d, id, input) {
  const existing = getOneOff(d, id);
  if (!existing) throw new WasteNotFoundError('One-off pickup not found.');
  const { value, errors } = validateOneOff(input, { partial: true });
  if (errors.length) throw new WasteValidationError(errors);

  const merged = { ...existing, ...value };
  try {
    d.prepare('UPDATE waste_one_off_pickups SET date = ?, note = ? WHERE id = ?')
      .run(merged.date, merged.note, id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new WasteConflictError('A one-off pickup already exists for this type and date.');
    throw err;
  }
  return getOneOff(d, id);
}

export function deleteOneOff(d, id) {
  const result = d.prepare('DELETE FROM waste_one_off_pickups WHERE id = ?').run(id);
  if (result.changes === 0) throw new WasteNotFoundError('One-off pickup not found.');
}

// -------------------------------------------------------------------------
// Range / next-per-type reads - the only two entry points Dashboard and
// Calendar (and later reminders/feed) are meant to call into.
// -------------------------------------------------------------------------

/**
 * Coalesced occurrences in [from, to] across every active schedule and every
 * one-off pickup, for every type (archived types included - archived only
 * blocks deletion and hides a type from "next per type", never from a range
 * read that already includes its history).
 */
/** source_id -> source name, for attaching a human-readable label to import origins. */
function sourceNamesById(d) {
  const map = new Map();
  for (const row of d.prepare('SELECT id, name FROM waste_sources').all()) map.set(row.id, row.name);
  return map;
}

// DAS DATUMSFENSTER GEHOERT IN DIE ABFRAGE, nicht erst in die Schleife.
// resolveOccurrences() verwirft Einmal- und Import-Termine ausserhalb
// [from, to] ohnehin wieder (`if (x.date_key < from || x.date_key > to)
// continue;`), aber vorher lagen sie alle im Speicher: eine Haushalts-Historie
// von Jahren wurde bei jedem Dashboard-Render, jedem Kalender-Monat und jedem
// Erinnerungslauf komplett gelesen, um ein paar Wochen davon zu behalten.
// `idx_waste_imported_pickups_type_date` und `idx_waste_one_off_pickups_type_date`
// standen dafuer schon da und wurden von keiner Abfrage benutzt. Das Ergebnis
// ist unveraendert - nur die verworfenen Zeilen entstehen gar nicht erst.
function loadImportedPickups(d, { from, to }) {
  const names = sourceNamesById(d);
  return d.prepare('SELECT * FROM waste_imported_pickups WHERE date_key >= ? AND date_key <= ?')
    .all(from, to)
    .map((row) => ({ ...row, source_name: names.get(row.source_id) ?? null }));
}

function loadOneOffs(d, { from, to }) {
  return d.prepare('SELECT * FROM waste_one_off_pickups WHERE date >= ? AND date <= ?').all(from, to);
}

export function getOccurrences(d, { from, to }) {
  const errors = validateRange(from, to);
  if (errors.length) throw new WasteValidationError(errors);

  const types = listTypes(d, { includeArchived: true });
  const schedules = d.prepare('SELECT * FROM waste_schedules').all();
  const overridesBySchedule = loadOverridesBySchedule(d, schedules.map((s) => s.id));
  const oneOffs = loadOneOffs(d, { from, to });
  const importedPickups = loadImportedPickups(d, { from, to });

  return resolveOccurrences({ types, schedules, overridesBySchedule, oneOffs, importedPickups, from, to });
}

/** One next occurrence per active (non-archived) type, from today onward. */
export function getNextPerType(d, { now = new Date() } = {}) {
  const today = todayKey(d, now);
  const types = listTypes(d, { includeArchived: false });
  const schedules = d.prepare('SELECT * FROM waste_schedules').all();
  const overridesBySchedule = loadOverridesBySchedule(d, schedules.map((s) => s.id));
  // Dasselbe Fenster, das nextPerType() intern aufspannt (heute .. heute +
  // horizonDays - 1, invariant #7) - hier einmal ausgerechnet, damit die
  // beiden Abfragen es kennen.
  const horizonEnd = shiftDateKey(today, OCCURRENCE_RANGE_MAX_DAYS - 1);
  const oneOffs = loadOneOffs(d, { from: today, to: horizonEnd });
  const importedPickups = loadImportedPickups(d, { from: today, to: horizonEnd });

  return nextPerType({ types, schedules, overridesBySchedule, oneOffs, importedPickups, todayKey: today });
}

// -------------------------------------------------------------------------
// Import sources, mappings, and committed imported pickups (#1063 Phase 3)
// -------------------------------------------------------------------------

/**
 * "Needs refresh" is derived from the absence of a future MAPPED pickup for
 * this source as of household-local today (invariant #6) - not from file age,
 * and not from the source's own declared coverage_end, which reflects every
 * parsed candidate date (including labels the household chose to ignore) and
 * would otherwise misreport a source whose only remaining dates are all
 * ignored labels as still healthy.
 */
function decorateSourceHealth(d, source, today) {
  if (!source) return source;
  const n = d.prepare('SELECT COUNT(*) AS n FROM waste_imported_pickups WHERE source_id = ? AND date_key >= ?')
    .get(source.id, today).n;
  return { ...source, needs_refresh: n === 0 };
}

/**
 * EIN Aggregat fuer alle Quellen statt einer Zaehlabfrage je Quelle.
 *
 * `decorateSourceHealth` bereitet exakt dieselbe Frage je Zeile auf - und
 * `d.prepare()` stand dabei INNERHALB des map(), was den Anweisungs-Cache
 * jedes Mal neu bemuehte. Bei zehn Quellen waren das elf Abfragen und zehn
 * Praeparierungen, und das nicht nur auf der Abfuhr-Seite: das
 * Dashboard-Widget ruft listSources() bei jedem Render mit auf
 * (public/pages/dashboard.js). Der Wahrheitswert ist derselbe - `needs_refresh`
 * ist "kein zukuenftiger zugeordneter Termin mehr" -, nur eben einmal
 * gefragt.
 */
export function listSources(d) {
  const today = todayKey(d);
  const rows = d.prepare('SELECT * FROM waste_sources ORDER BY name, id').all();
  if (!rows.length) return rows;
  const futureBySource = new Map(
    d.prepare(`
      SELECT source_id, COUNT(*) AS n FROM waste_imported_pickups
      WHERE date_key >= ? GROUP BY source_id
    `).all(today).map((r) => [r.source_id, r.n]),
  );
  return rows.map((s) => ({ ...s, needs_refresh: (futureBySource.get(s.id) ?? 0) === 0 }));
}

export function getSource(d, id) {
  const row = d.prepare('SELECT * FROM waste_sources WHERE id = ?').get(id) ?? null;
  return decorateSourceHealth(d, row, todayKey(d));
}

export function listMappings(d, sourceId) {
  return d.prepare('SELECT * FROM waste_source_mappings WHERE source_id = ? ORDER BY normalized_label')
    .all(sourceId);
}

/** normalized_label -> { type_id, ignored } for an existing source, used to prefill a re-import preview. */
export function mappingsByLabel(d, sourceId) {
  const map = new Map();
  for (const row of listMappings(d, sourceId)) {
    map.set(row.normalized_label, { type_id: row.type_id, ignored: !!row.ignored, original_label: row.original_label });
  }
  return map;
}

export function renameSource(d, id, name) {
  const existing = getSource(d, id);
  if (!existing) throw new WasteNotFoundError('Waste import source not found.');
  const v = str(name, 'name', { max: 150 });
  if (v.error) throw new WasteValidationError([v.error]);
  d.prepare('UPDATE waste_sources SET name = ? WHERE id = ?').run(v.value, id);
  return getSource(d, id);
}

/** Mappings/imported pickups cascade via ON DELETE CASCADE (invariant #5); other sources and manual data are untouched. */
export function deleteSource(d, id) {
  const existing = getSource(d, id);
  if (!existing) throw new WasteNotFoundError('Waste import source not found.');
  d.prepare('DELETE FROM waste_sources WHERE id = ?').run(id);
}

// --------------------------------------------------------
// URL sources (#1063 Phase 7)
// --------------------------------------------------------

/**
 * Inserts the placeholder row for a new URL source - version 0, no content
 * yet. server/services/waste-url-source.js immediately performs the first
 * fetch/preview/commit against this row (commitImport's existing-source
 * branch handles version 0 -> 1 like any other re-import); this function
 * only owns the SQL insert, never the network fetch.
 */
export function createUrlSourcePlaceholder(d, { name, url, refreshIntervalMinutes, userId }) {
  const nameV = str(name, 'name', { max: 150 });
  if (nameV.error) throw new WasteValidationError([nameV.error]);
  const result = d.prepare(`
    INSERT INTO waste_sources
      (kind, name, content_hash, version, url, refresh_interval_minutes, next_attempt_at, created_by)
    VALUES ('url', ?, '', 0, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
  `).run(nameV.value, url, refreshIntervalMinutes, userId ?? null);
  return getSource(d, Number(result.lastInsertRowid));
}

/**
 * Records the outcome of one fetch attempt against a URL source - never
 * touches waste_source_mappings/waste_imported_pickups (that's commitImport's
 * job, called separately when the fetch yields a fully-mapped commit).
 */
export function recordUrlSourceAttempt(d, id, {
  etag = undefined, lastModified = undefined, needsMapping = undefined,
  errorMessage = undefined, nextAttemptAt = undefined, consecutiveFailures = undefined,
} = {}) {
  const sets = ["last_import_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')"];
  const params = [];
  if (etag !== undefined) { sets.push('etag = ?'); params.push(etag); }
  if (lastModified !== undefined) { sets.push('last_modified = ?'); params.push(lastModified); }
  if (needsMapping !== undefined) { sets.push('needs_mapping = ?'); params.push(needsMapping ? 1 : 0); }
  if (errorMessage !== undefined) { sets.push('last_error = ?'); params.push(errorMessage); }
  if (nextAttemptAt !== undefined) { sets.push('next_attempt_at = ?'); params.push(nextAttemptAt); }
  if (consecutiveFailures !== undefined) { sets.push('consecutive_failures = ?'); params.push(consecutiveFailures); }
  params.push(id);
  d.prepare(`UPDATE waste_sources SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getSource(d, id);
}

/** Sources the scheduler should attempt now: URL kind, not stuck in "needs mapping", and due. */
export function listDueUrlSources(d) {
  return d.prepare(`
    SELECT * FROM waste_sources
    WHERE kind = 'url' AND needs_mapping = 0
      AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ORDER BY id
  `).all();
}

/**
 * Edits one mapping's decision after commit, without requiring a full
 * re-import - a household correcting a label's mapping shouldn't have to
 * re-upload and re-review the whole file. Only the
 * mapping row changes; already-committed waste_imported_pickups for labels
 * whose type changes are NOT retroactively reassigned here (that would
 * silently rewrite import history outside the atomic-commit path) - the next
 * re-import commit is what applies a changed mapping to the data.
 */
export function updateMapping(d, sourceId, mappingId, { type_id = null, ignored = false }) {
  const source = getSource(d, sourceId);
  if (!source) throw new WasteNotFoundError('Waste import source not found.');
  const existing = d.prepare('SELECT * FROM waste_source_mappings WHERE id = ? AND source_id = ?').get(mappingId, sourceId);
  if (!existing) throw new WasteNotFoundError('Mapping not found.');

  if (ignored) {
    d.prepare('UPDATE waste_source_mappings SET type_id = NULL, ignored = 1 WHERE id = ?').run(mappingId);
  } else {
    if (!type_id || !getType(d, type_id)) {
      throw new WasteValidationError(['type_id must reference an existing waste type when a mapping is not ignored.']);
    }
    d.prepare('UPDATE waste_source_mappings SET type_id = ?, ignored = 0 WHERE id = ?').run(type_id, mappingId);
  }
  return d.prepare('SELECT * FROM waste_source_mappings WHERE id = ?').get(mappingId);
}

/** Splits an inclusive date-key range into chunks no wider than the occurrence-range ceiling (invariant #7), so a wide import coverage window never violates getOccurrences' own bound. */
function chunkDateRange(start, end) {
  if (!start || !end) return [];
  const chunks = [];
  let from = start;
  while (from <= end) {
    const chunkEnd = shiftDateKey(from, OCCURRENCE_RANGE_MAX_DAYS - 1);
    const to = chunkEnd > end ? end : chunkEnd;
    chunks.push([from, to]);
    from = shiftDateKey(to, 1);
  }
  return chunks;
}

/**
 * Builds a stateless import preview - fresh (sourceId null) or a re-import of
 * an existing source. Never writes anything; server/routes/waste/import.js and
 * .../sources.js are the only callers of both this and commitImport.
 */
export function previewImport(d, { sourceId = null, icsText } = {}) {
  const source = sourceId ? getSource(d, sourceId) : null;
  if (sourceId && !source) throw new WasteNotFoundError('Waste import source not found.');

  const today = todayKey(d);
  // The pickup DAY is a household-local fact, not a UTC one (see
  // waste-import.js#pickupDateKey) - an early-morning TZID pickup imports a day
  // early without this.
  const timeZone = householdTimeZone(d);
  const existingTypes = listTypes(d, { includeArchived: true });
  const existingMappings = source ? mappingsByLabel(d, sourceId) : new Map();

  try {
    const preview = buildImportPreview(icsText, { today, timeZone, existingTypes, existingMappings });
    return { ...preview, source_id: source?.id ?? null, expected_version: source?.version ?? null };
  } catch (err) {
    if (err instanceof WasteImportError) throw new WasteValidationError([err.message]);
    throw err;
  }
}

/**
 * Reparses `icsText` (never trusts a client-supplied candidate list - invariant
 * #9), verifies the preview digest and, for a re-import, the source version,
 * requires an explicit decision for every label, and atomically applies the
 * new source/mappings/imported-pickups snapshot. A failure throws before any
 * write, so the last good snapshot is always preserved.
 *
 * @param {object} opts
 * @param {number|null} opts.sourceId null for a fresh import, an existing source id for a re-import
 * @param {string} opts.name required for a fresh import; defaults to the existing name on a re-import
 * @param {string} opts.icsText
 * @param {Array<{normalized_label:string, type_id?:number, new_type?:object, ignored?:boolean}>} opts.mappingDecisions one decision per distinct label
 * @param {string[]} [opts.skipEventKeys] blocking-diagnostic event keys the caller explicitly acknowledges and excludes
 * @param {number|null} [opts.expectedVersion] the source's version as last seen in a preview (re-import concurrency guard)
 * @param {string|null} [opts.previewDigest] the digest the preview returned for this same file - a
 *   digest of what the preview SHOWED (candidates/labels/diagnostics), not of the raw bytes, so a
 *   URL source re-fetched between preview and commit still matches as long as the parsed result
 *   didn't actually change (see waste-import.js#computeReviewDigest)
 * @param {number|null} opts.userId
 */
export function commitImport(d, {
  sourceId = null, name, icsText, mappingDecisions = [], skipEventKeys = [],
  expectedVersion = null, previewDigest = null, userId = null,
} = {}) {
  const source = sourceId ? getSource(d, sourceId) : null;
  if (sourceId && !source) throw new WasteNotFoundError('Waste import source not found.');
  if (source && expectedVersion !== source.version) {
    throw new WasteConflictError('This source changed since you last previewed it; preview again before committing.');
  }

  // content_hash storage only - NOT the commit concurrency guard below (see
  // waste-import.js#computeReviewDigest for why: a URL source's preview and
  // this commit each fetch the URL independently, and raw bytes can differ
  // between the two fetches - e.g. a request-time DTSTAMP - even when the
  // parsed result is identical).
  const digest = computeDigest(icsText);

  const today = todayKey(d);
  // The pickup DAY is a household-local fact, not a UTC one (see
  // waste-import.js#pickupDateKey) - an early-morning TZID pickup imports a day
  // early without this.
  const timeZone = householdTimeZone(d);
  const existingTypes = listTypes(d, { includeArchived: true });
  const existingMappings = source ? mappingsByLabel(d, sourceId) : new Map();

  let preview;
  try {
    preview = buildImportPreview(icsText, { today, timeZone, existingTypes, existingMappings });
  } catch (err) {
    if (err instanceof WasteImportError) throw new WasteValidationError([err.message]);
    throw err;
  }

  // Compares against what the preview actually SHOWED (candidates/labels/
  // diagnostics), not the raw bytes behind it - a URL source's preview and
  // this commit each fetch the URL independently, and two fetches of the
  // same underlying feed routinely differ in bytes that don't change the
  // parsed result (a request-time DTSTAMP, incidental whitespace, ...).
  // Comparing raw bytes made every such source refuse every commit forever.
  if (previewDigest && previewDigest !== preview.digest) {
    throw new WasteConflictError('The file content changed since you last previewed it; preview again before committing.');
  }

  const skipSet = new Set(skipEventKeys);
  const unresolved = preview.diagnostics.filter((diag) => diag.severity === 'blocking' && !skipSet.has(diag.event_key));
  if (unresolved.length) {
    throw new WasteValidationError(unresolved.map((diag) => diag.message));
  }

  const nameValidation = str(name ?? source?.name, 'name', { max: 150 });
  if (nameValidation.error) throw new WasteValidationError([nameValidation.error]);

  // Every label present in this parse needs exactly one decision - map to an
  // existing type, create a new type inline, or be explicitly ignored.
  // Suggestions and remembered decisions never become decisions on their own.
  const decisionsByLabel = new Map(mappingDecisions.map((m) => [m.normalized_label, m]));
  for (const label of preview.labels) {
    const decision = decisionsByLabel.get(label.normalized_label);
    if (!decision) throw new WasteValidationError([`No mapping decision was given for label "${label.original_label}".`]);
    const hasType = decision.type_id != null;
    const hasNewType = decision.new_type && typeof decision.new_type === 'object';
    const isIgnored = !!decision.ignored;
    if ([hasType, hasNewType, isIgnored].filter(Boolean).length !== 1) {
      throw new WasteValidationError([`Label "${label.original_label}" must be mapped to exactly one of: an existing type, a new type, or ignored.`]);
    }
  }

  return d.transaction(() => {
    const resolvedTypeIdByLabel = new Map();
    // Two labels that both say "create a new type" with the same name (after
    // trim/case-fold) mean the same type, not two - the household edited one
    // label's new-type name to match another's precisely so they would merge
    // (e.g. a provider's own footnote marker this importer doesn't already
    // strip). Scoped to THIS commit's own decisions only: it never redirects
    // a "create new" decision onto a type that already existed before this
    // commit - that reuse path is the suggested_type_id dropdown, an active
    // choice, not an automatic name match.
    const newTypeIdByName = new Map();
    for (const [normalizedLabel, decision] of decisionsByLabel) {
      if (decision.ignored) continue;
      if (decision.new_type) {
        const nameKey = String(decision.new_type.name ?? '').trim().toLowerCase();
        let typeId = newTypeIdByName.get(nameKey);
        if (typeId === undefined) {
          typeId = createType(d, decision.new_type, userId).id;
          newTypeIdByName.set(nameKey, typeId);
        }
        resolvedTypeIdByLabel.set(normalizedLabel, typeId);
      } else {
        if (!getType(d, decision.type_id)) {
          throw new WasteValidationError([`type_id ${decision.type_id} does not reference an existing waste type.`]);
        }
        resolvedTypeIdByLabel.set(normalizedLabel, decision.type_id);
      }
    }

    let resolvedSourceId = source?.id ?? null;
    const newVersion = (source?.version ?? 0) + 1;
    if (source) {
      // COMPARE-AND-SWAP, nicht nur die Vorpruefung oben. Jene liest `version`
      // AUSSERHALB dieser Transaktion, und zwischen Lesen und Schreiben liegt
      // bei beiden Aufrufern ein `await` (die Route ist async, der
      // URL-Refresh holt vorher die Datei). Genau dort passte ein zweiter
      // Commit hinein: beide sahen version=3, beide schrieben version=4, und
      // der zweite ueberschrieb die Zuordnungen und Termine des ersten
      // klaglos - eine verlorene Aenderung mit korrekt aussehendem Ergebnis.
      // Das `AND version = ?` macht das Fenster zu: nur EIN Schreiber trifft
      // die Zeile, der andere sieht changes === 0 und bekommt denselben 409,
      // den er auch vor dem Rennen bekommen haette.
      const swapped = d.prepare(`
        UPDATE waste_sources SET
          name = ?, content_hash = ?, version = ?, coverage_start = ?, coverage_end = ?,
          last_import_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
          last_success_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), last_error = NULL
        WHERE id = ? AND version = ?
      `).run(nameValidation.value, digest, newVersion, preview.coverage.start, preview.coverage.end, source.id, source.version);
      // Wirft INNERHALB der Transaktion, rollt also alles bereits Geschriebene
      // dieses Commits zurueck - der letzte gute Stand bleibt unberuehrt.
      if (swapped.changes !== 1) {
        throw new WasteConflictError('This source changed since you last previewed it; preview again before committing.');
      }
    } else {
      const result = d.prepare(`
        INSERT INTO waste_sources
          (kind, name, content_hash, version, coverage_start, coverage_end, last_import_at, last_success_at, created_by)
        VALUES ('file', ?, ?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
      `).run(nameValidation.value, digest, preview.coverage.start, preview.coverage.end, userId ?? null);
      resolvedSourceId = Number(result.lastInsertRowid);
    }

    for (const label of preview.labels) {
      const decision = decisionsByLabel.get(label.normalized_label);
      const typeId = decision.ignored ? null : resolvedTypeIdByLabel.get(label.normalized_label);
      d.prepare(`
        INSERT INTO waste_source_mappings (source_id, original_label, normalized_label, type_id, ignored)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_id, normalized_label) DO UPDATE SET
          original_label = excluded.original_label, type_id = excluded.type_id, ignored = excluded.ignored
      `).run(resolvedSourceId, label.original_label, label.normalized_label, typeId, decision.ignored ? 1 : 0);
    }

    const existingRows = d.prepare('SELECT * FROM waste_imported_pickups WHERE source_id = ?').all(resolvedSourceId);
    const existingByIdentity = new Map(existingRows.map((r) => [r.identity_key, r]));
    const keptCandidates = preview.candidates.filter((c) => {
      const decision = decisionsByLabel.get(c.normalized_label);
      return decision && !decision.ignored;
    });
    const nextIdentities = new Set();
    let added = 0, changed = 0, removed = 0;

    const insertStmt = d.prepare(`
      INSERT INTO waste_imported_pickups (source_id, type_id, identity_key, external_uid, original_summary, date_key, tz_note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = d.prepare(`
      UPDATE waste_imported_pickups SET type_id = ?, external_uid = ?, original_summary = ?, date_key = ?, tz_note = ? WHERE id = ?
    `);
    for (const c of keptCandidates) {
      nextIdentities.add(c.identity_key);
      const typeId = resolvedTypeIdByLabel.get(c.normalized_label);
      const existingRow = existingByIdentity.get(c.identity_key);
      if (!existingRow) {
        insertStmt.run(resolvedSourceId, typeId, c.identity_key, c.external_uid, c.original_summary, c.date_key, c.tz_note);
        added++;
      } else if (existingRow.type_id !== typeId || existingRow.date_key !== c.date_key
        || existingRow.original_summary !== c.original_summary || existingRow.tz_note !== c.tz_note) {
        updateStmt.run(typeId, c.external_uid, c.original_summary, c.date_key, c.tz_note, existingRow.id);
        changed++;
      }
    }
    for (const row of existingRows) {
      if (!nextIdentities.has(row.identity_key)) {
        d.prepare('DELETE FROM waste_imported_pickups WHERE id = ?').run(row.id);
        removed++;
      }
    }

    // Informational only: how many of the accepted candidates land on a date
    // a manual schedule or one-off (or another source's import) already
    // provides for the same type. The resolver already coalesces these
    // correctly at read time regardless (invariant #3); this count just
    // makes the overlap visible at commit time.
    let coalesced = 0;
    if (keptCandidates.length && preview.coverage.start && preview.coverage.end) {
      const touched = new Set(keptCandidates.map((c) => `${resolvedTypeIdByLabel.get(c.normalized_label)}:${c.date_key}`));
      for (const [from, to] of chunkDateRange(preview.coverage.start, preview.coverage.end)) {
        for (const occ of getOccurrences(d, { from, to })) {
          if (touched.has(`${occ.type_id}:${occ.date_key}`) && occ.origins.some((o) => o.kind !== 'import' || o.source_id !== resolvedSourceId)) {
            coalesced++;
          }
        }
      }
    }

    return { source: getSource(d, resolvedSourceId), diff: { added, changed, removed, coalesced } };
  })();
}

// -------------------------------------------------------------------------
// Per-user reminder settings (#1063 Phase 8)
// -------------------------------------------------------------------------
//
// routes/waste/reminder-settings.js used to run these statements directly,
// the one route in this module that didn't go through this file (every
// other Waste route is a thin pass-through to waste-store.js) - the
// transaction boundary its write needed belonged here for the same reason.

export function listReminderSettingsForUser(d, userId) {
  const types = listTypes(d, { includeArchived: false });
  const rows = d.prepare('SELECT * FROM waste_reminder_settings WHERE user_id = ?').all(userId);
  const byTypeId = new Map(rows.map((r) => [r.type_id, r]));
  return { types, byTypeId };
}

export function getReminderSetting(d, userId, typeId) {
  return d.prepare('SELECT * FROM waste_reminder_settings WHERE user_id = ? AND type_id = ?').get(userId, typeId) ?? null;
}

export function upsertReminderSetting(d, userId, typeId, { enabled, offsetDays, deliveryTime }) {
  if (!getType(d, typeId)) throw new WasteNotFoundError('Waste type not found.');
  d.prepare(`
    INSERT INTO waste_reminder_settings (user_id, type_id, enabled, offset_days, delivery_time)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, type_id) DO UPDATE SET
      enabled = excluded.enabled, offset_days = excluded.offset_days, delivery_time = excluded.delivery_time
  `).run(userId, typeId, enabled ? 1 : 0, offsetDays, deliveryTime);
  return getReminderSetting(d, userId, typeId);
}

// -------------------------------------------------------------------------
// Mapping profile export/import (#1063 Phase 10)
// -------------------------------------------------------------------------
//
// A "profile" is a portable snapshot of one source's label -> type mappings:
// {version, mappings: [{pattern, type_name}]}. Deliberately decoupled from
// local ids (source_id, type_id) so it can be exported from one source or
// household and applied to another where the ids differ but the type NAMES
// still match. No municipal/provider catalog ships with the app, by design -
// this only ever round-trips a household's OWN previously-made decisions.
//
// Reuses waste_source_mappings as-is (already exactly "one source's label ->
// type profile", just not portable) rather than adding a new table, and
// mirrors the existing import preview/commit/digest shape (server/services/
// waste-import.js) at a much smaller scale: no ICS reparsing, no imported
// pickups touched - only mapping rows for the target source change, same
// restraint as updateMapping() (a changed mapping never retroactively
// rewrites already-committed pickups).

function sameLabelNormalization(label) {
  return String(label || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function assertProfileShape(profile) {
  if (!profile || typeof profile !== 'object' || !Array.isArray(profile.mappings)) {
    throw new WasteValidationError(['profile must be an object with a mappings array.']);
  }
  for (const entry of profile.mappings) {
    if (typeof entry?.pattern !== 'string' || !entry.pattern.trim()
      || typeof entry?.type_name !== 'string' || !entry.type_name.trim()) {
      throw new WasteValidationError(['Each mapping profile entry needs a non-empty pattern and type_name.']);
    }
  }
}

/** Deterministic hash of a profile's content, independent of entry order (same guard shape as computeDigest for an ICS file). */
export function computeMappingProfileDigest(profile) {
  const canonical = [...(profile?.mappings ?? [])]
    .map((m) => ({ pattern: sameLabelNormalization(m.pattern), type_name: String(m.type_name || '').trim() }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern) || a.type_name.localeCompare(b.type_name));
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** Exports the current, resolved (non-ignored, mapped) label -> type-name mappings of one source as a portable profile. */
export function exportMappingProfile(d, sourceId) {
  const source = getSource(d, sourceId);
  if (!source) throw new WasteNotFoundError('Waste import source not found.');
  const typesById = new Map(listTypes(d, { includeArchived: true }).map((t) => [t.id, t]));
  const mappings = listMappings(d, sourceId)
    .filter((m) => !m.ignored && m.type_id && typesById.has(m.type_id))
    .map((m) => ({ pattern: m.normalized_label, type_name: typesById.get(m.type_id).name }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
  return { version: 1, source_name: source.name, mappings };
}

/**
 * Stateless preview: resolves each profile entry against the target source's
 * OWN mapping rows (by normalized pattern) and the target household's OWN
 * types (by name, case-insensitive) - never creates a mapping row or type
 * that doesn't already exist, so an unrelated/foreign profile just reports
 * everything as unmatched rather than fabricating new local state.
 */
export function previewMappingProfileImport(d, sourceId, profile) {
  const source = getSource(d, sourceId);
  if (!source) throw new WasteNotFoundError('Waste import source not found.');
  assertProfileShape(profile);

  const existingMappingsByLabel = new Map(listMappings(d, sourceId).map((m) => [m.normalized_label, m]));
  // A name is not unique (two custom types can share one) - grouped into
  // arrays rather than overwritten, so a collision is detected instead of
  // silently resolving to whichever type happened to load last.
  const typesByLowerName = new Map();
  for (const type of listTypes(d, { includeArchived: true })) {
    const key = type.name.trim().toLowerCase();
    if (!typesByLowerName.has(key)) typesByLowerName.set(key, []);
    typesByLowerName.get(key).push(type);
  }

  const entries = profile.mappings.map((entry) => {
    const pattern = sameLabelNormalization(entry.pattern);
    const mappingRow = existingMappingsByLabel.get(pattern) ?? null;
    const candidates = typesByLowerName.get(entry.type_name.trim().toLowerCase()) ?? [];
    // A name collision resolves to the mapping's OWN current type when that
    // type is one of the candidates (the idempotent, "keep pointing at what
    // it already points at" reading) rather than guessing between look-alikes.
    const type = candidates.length <= 1
      ? (candidates[0] ?? null)
      : (candidates.find((c) => c.id === mappingRow?.type_id) ?? null);
    let status;
    if (!mappingRow) status = 'unmatched_pattern';
    else if (!candidates.length) status = 'unmatched_type';
    else if (!type) status = 'ambiguous_type';
    else if (!mappingRow.ignored && mappingRow.type_id === type.id) status = 'unchanged';
    else status = 'applicable';
    return {
      pattern, type_name: entry.type_name,
      mapping_id: mappingRow?.id ?? null, original_label: mappingRow?.original_label ?? null,
      resolved_type_id: type?.id ?? null, status,
    };
  });

  return {
    source_id: source.id,
    entries,
    applicable_count: entries.filter((e) => e.status === 'applicable').length,
    profile_digest: computeMappingProfileDigest(profile),
  };
}

/**
 * Applies every 'applicable' entry from a fresh preview of the SAME profile
 * (profileDigest guards against committing a profile the caller never
 * actually previewed, or one edited since - same purpose as commitImport's
 * own previewDigest). Source state (mappings) may have shifted between
 * preview and commit; re-running the preview here (not trusting the client's
 * copy of it) means a stale mapping decision can never be replayed onto a
 * mapping row that has since changed underfoot.
 */
export function commitMappingProfileImport(d, sourceId, profile, profileDigest) {
  if (!getSource(d, sourceId)) throw new WasteNotFoundError('Waste import source not found.');
  assertProfileShape(profile);
  if (profileDigest !== computeMappingProfileDigest(profile)) {
    throw new WasteConflictError('The mapping profile changed since it was last previewed; preview it again before committing.');
  }
  const preview = previewMappingProfileImport(d, sourceId, profile);
  const applied = d.transaction(() => {
    let count = 0;
    for (const entry of preview.entries) {
      if (entry.status !== 'applicable') continue;
      d.prepare('UPDATE waste_source_mappings SET type_id = ?, ignored = 0 WHERE id = ?')
        .run(entry.resolved_type_id, entry.mapping_id);
      count++;
    }
    return count;
  })();
  return { applied_count: applied, entries: preview.entries };
}
