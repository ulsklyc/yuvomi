/**
 * Model primitives for linked local recurrence overrides (#975).
 *
 * The route layer deliberately consumes these small, dependency-free helpers so
 * every occurrence mutation applies the same ownership and eligibility rules.
 */

import { hasAnyOccurrence, parseRRule } from './recurrence.js';
import {
  ASSIGNED_USERS_SQL, expandRecurringEvents, MAX_EXPANSION_ITERATIONS,
} from './calendar-events.js';
import {
  dropInheritedEventReminders, eventAuthorId, fanOutEventReminders,
} from './event-reminder-fanout.js';
import { utcToWall, shiftDateKey } from '../utils/timezone.js';
import { createLogger } from '../logger.js';

const log = createLogger('CalendarOccurrenceOverrides');

export const OVERRIDE_FIELDS = Object.freeze([
  'title',
  'description',
  'start_datetime',
  'end_datetime',
  'all_day',
  'location',
  'color',
  'icon',
  'assignments',
  'visibility',
  'countdown',
  'attachment',
  'reminders',
]);

const OVERRIDE_FIELD_SET = new Set(OVERRIDE_FIELDS);
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CalendarOccurrenceError extends Error {
  constructor(message, {
    status = 400,
    code = 'invalid_override_fields',
    conflict = null,
    orphanedOverrideCount = null,
  } = {}) {
    super(message);
    this.name = 'CalendarOccurrenceError';
    this.status = status;
    this.code = code;
    if (conflict) this.conflict = conflict;
    if (orphanedOverrideCount !== null) {
      this.orphanedOverrideCount = orphanedOverrideCount;
    }
  }
}

/** Internal two-phase signal: storage copies must be staged before the write transaction. */
export class CalendarAttachmentCloneRequiredError extends Error {
  constructor(requests) {
    super('Independent attachment copies must be staged before detaching recurrence owners.');
    this.name = 'CalendarAttachmentCloneRequiredError';
    this.requests = requests;
  }
}

function invalidOverrideFields(message) {
  return new CalendarOccurrenceError(message, {
    status: 400,
    code: 'invalid_override_fields',
  });
}

function invalidRecurrenceIdentity(message, { status = 400 } = {}) {
  return new CalendarOccurrenceError(message, {
    status,
    code: 'invalid_recurrence_id',
  });
}

/**
 * Parses the persisted closed override vocabulary into canonical order of first
 * appearance. Empty, partial, or unknown metadata cannot identify an override.
 */
export function parseOverrideFields(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidOverrideFields('overridden_fields must be a non-empty JSON array.');
  }

  let fields;
  try {
    fields = JSON.parse(value);
  } catch {
    throw invalidOverrideFields('overridden_fields must be valid JSON.');
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw invalidOverrideFields('overridden_fields must be a non-empty JSON array.');
  }

  const unique = [];
  for (const field of fields) {
    if (typeof field !== 'string' || !OVERRIDE_FIELD_SET.has(field)) {
      throw invalidOverrideFields('overridden_fields contains an unsupported field.');
    }
    if (!unique.includes(field)) unique.push(field);
  }
  return unique;
}

export function isLinkedOccurrence(row) {
  const hasIdentity = Number.isInteger(Number(row?.recurrence_parent_id))
    && Number(row.recurrence_parent_id) > 0
    && typeof row.recurrence_id === 'string'
    && row.recurrence_id.trim() !== ''
    && typeof row.overridden_fields === 'string'
    && row.overridden_fields.trim() !== '';
  if (!hasIdentity) return false;
  try {
    parseOverrideFields(row.overridden_fields);
    return true;
  } catch {
    return false;
  }
}

export function seriesIdFor(row) {
  return isLinkedOccurrence(row) ? Number(row.recurrence_parent_id) : row?.id ?? null;
}

export function recurrenceIdFor(row) {
  if (isLinkedOccurrence(row)) return row.recurrence_id;
  if (!row?.recurrence_rule) return null;
  if (typeof row.recurrence_identity === 'string' && row.recurrence_identity.trim() !== '') {
    return row.recurrence_identity;
  }
  return typeof row.start_datetime === 'string' ? row.start_datetime.slice(0, 10) : null;
}

function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function exactLookupIterationLimit(master, recurrenceId) {
  const start = new Date(`${master.start_datetime.slice(0, 10)}T00:00:00Z`).getTime();
  const requested = new Date(`${recurrenceId}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || requested < start) return 1;
  const calendarDays = Math.floor((requested - start) / 86400000);
  return Math.min(calendarDays + 2, MAX_EXPANSION_ITERATIONS);
}

/**
 * Expands one original recurrence slot without applying the master's EXDATEs.
 * The displayed child start is deliberately irrelevant to this lookup.
 */
export function baseOccurrenceFor(master, recurrenceId) {
  if (!master?.recurrence_rule || !isDateKey(recurrenceId)) {
    throw invalidRecurrenceIdentity('recurrence_id must identify a recurring series date.');
  }

  // EIN TAG LUFT AUF BEIDEN SEITEN, und zwar seit #985: das Fenster [from, to]
  // wird in UTC-Tagen gefuehrt, die Expansionsschleife laeuft bei einer Serie,
  // deren lokaler und UTC-Tag auseinandergehen, aber auf dem LOKALEN Datum.
  // Ein Punktfenster [recurrenceId, recurrenceId] verfehlt das gesuchte
  // Vorkommen dann um genau einen Tag - `while (currentDate <= to)` bricht ab,
  // bevor es entsteht. Gemessen an der Tokio-Probe in test-ics-export.js:
  // Master 07.01. 08:00 Tokio = 06.01. 23:00 UTC, gesucht `2026-01-07`, die
  // Schleife steht bei diesem Vorkommen auf dem lokalen `2026-01-08`.
  // Mehr als ein Tag kann es nicht sein: weiter als um einen Kalendertag
  // koennen UTC und Ortszeit nicht auseinanderliegen. Die AUSWAHL bleibt exakt -
  // gefiltert wird unveraendert auf `recurrence_identity === recurrenceId`, das
  // groessere Fenster liefert nur die Kandidaten.
  const occurrences = expandRecurringEvents(
    [master],
    shiftDateKey(recurrenceId, -1),
    shiftDateKey(recurrenceId, 1),
    new Map(),
    {
      includeRecurrenceIdentity: true,
      maxIterations: exactLookupIterationLimit(master, recurrenceId),
    },
  );
  const occurrence = occurrences.find((candidate) => candidate.recurrence_identity === recurrenceId);
  if (!occurrence) {
    throw invalidRecurrenceIdentity('recurrence_id is not an occurrence of this series.');
  }
  return occurrence;
}

function assertOccurrenceSlotCanBeMutated(database, seriesId, recurrenceId) {
  const state = database.prepare(`
    SELECT
      EXISTS(
        SELECT 1 FROM calendar_event_exceptions
        WHERE event_id = ? AND exception_date = ?
      ) AS excluded,
      EXISTS(
        SELECT 1 FROM calendar_events
        WHERE recurrence_parent_id = ? AND recurrence_id = ?
      ) AS has_linked_child
  `).get(seriesId, recurrenceId, seriesId, recurrenceId);
  if (state.excluded && !state.has_linked_child) {
    throw invalidRecurrenceIdentity(
      'recurrence_id identifies an excluded slot without a linked occurrence.',
    );
  }
}

const OVERRIDE_PROPERTIES = Object.freeze({
  title: ['title'],
  description: ['description'],
  start_datetime: ['start_datetime'],
  end_datetime: ['end_datetime'],
  all_day: ['all_day'],
  location: ['location'],
  color: ['color'],
  icon: ['icon'],
  assignments: [
    'assigned_to', 'assigned_name', 'assigned_color', 'assigned_users_json', 'assigned_users',
  ],
  visibility: ['visibility'],
  countdown: ['countdown'],
  attachment: [
    'attachment_name', 'attachment_mime', 'attachment_size', 'attachment_data',
    'attachment_document_id', 'attachment_preview_url', 'attachment_download_url',
  ],
  reminders: [],
});

function copyMarkedProperties(target, child, fields) {
  for (const field of fields) {
    for (const property of OVERRIDE_PROPERTIES[field]) {
      if (Object.hasOwn(child, property)) target[property] = child[property];
    }
  }
}

function loadOccurrenceMasters(database, parentIds) {
  if (parentIds.length === 0) return [];
  const placeholders = parentIds.map(() => '?').join(',');
  return database.prepare(`
    SELECT e.*,
           u_assigned.display_name AS assigned_name,
           u_assigned.avatar_color AS assigned_color,
           ${ASSIGNED_USERS_SQL}
    FROM calendar_events e
    LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
    WHERE e.id IN (${placeholders})
  `).all(...parentIds);
}

/**
 * Composes one linked replacement from its current series defaults and the
 * child's explicit override markers.
 */
export function resolveOccurrence(database, child, master = null) {
  if (!isLinkedOccurrence(child)) {
    throw invalidRecurrenceIdentity('The event is not a linked occurrence override.');
  }

  const parentId = Number(child.recurrence_parent_id);
  if (master && Number(master.id) !== parentId) {
    throw invalidRecurrenceIdentity('The recurrence parent does not match the linked occurrence.');
  }
  const hasAssignmentProjection = master
    && Object.hasOwn(master, 'assigned_name')
    && Object.hasOwn(master, 'assigned_color')
    && Object.hasOwn(master, 'assigned_users_json');
  const parent = hasAssignmentProjection ? master : loadOccurrenceMasters(database, [parentId])[0];
  if (!parent) {
    throw invalidRecurrenceIdentity('The recurrence parent does not exist.', { status: 404 });
  }
  if (Number(parent.id) !== parentId) {
    throw invalidRecurrenceIdentity('The recurrence parent does not match the linked occurrence.');
  }

  const fields = parseOverrideFields(child.overridden_fields);
  const base = baseOccurrenceFor(parent, child.recurrence_id);
  const resolved = {
    ...base,
    id: child.id,
    recurrence_parent_id: parentId,
    recurrence_id: child.recurrence_id,
    recurrence_identity: child.recurrence_id,
    overridden_fields: child.overridden_fields,
  };
  copyMarkedProperties(resolved, child, fields);

  const ownsAssignments = fields.includes('assignments');
  const ownsAttachment = fields.includes('attachment');
  const ownsReminders = fields.includes('reminders');
  return {
    ...resolved,
    series_id: Number(parent.id),
    recurrence_id: child.recurrence_id,
    is_occurrence_override: true,
    is_recurring_instance: 1,
    assignment_owner_id: ownsAssignments ? Number(child.id) : Number(parent.id),
    attachment_owner_id: ownsAttachment ? Number(child.id) : Number(parent.id),
    reminder_owner_id: ownsReminders ? Number(child.id) : Number(parent.id),
    reminder_anchor_start: ownsReminders ? resolved.start_datetime : parent.start_datetime,
  };
}

/**
 * Resolves a mixed row set while loading every referenced parent once.
 * Reader orchestration may supply a projection-aware loader; the authoritative
 * merge and recurrence model remain here regardless of row shape.
 */
export function resolveEventRows(database, rows, { loadMasters = loadOccurrenceMasters } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const parentIds = [...new Set(rows
    .filter(isLinkedOccurrence)
    .map((row) => Number(row.recurrence_parent_id)))];
  if (parentIds.length === 0) return rows;

  const masters = loadMasters(database, parentIds);
  const mastersById = new Map(masters.map((master) => [Number(master.id), master]));
  return rows.map((row) => {
    if (!isLinkedOccurrence(row)) return row;
    try {
      return resolveOccurrence(database, row, mastersById.get(Number(row.recurrence_parent_id)));
    } catch (error) {
      if (!(error instanceof CalendarOccurrenceError)
          || error.code !== 'invalid_recurrence_id') throw error;
      log.warn('Linked calendar occurrence is no longer reachable; serving it standalone.', {
        eventId: row.id,
        recurrenceParentId: row.recurrence_parent_id,
        recurrenceId: row.recurrence_id,
        error: error.message,
      });
      return {
        ...row,
        recurrence_parent_id: null,
        recurrence_id: null,
        overridden_fields: null,
        recurrence_rule: null,
        series_id: Number(row.id),
        is_occurrence_override: false,
        occurrence_override_unreachable: true,
        assignment_owner_id: Number(row.id),
        attachment_owner_id: Number(row.id),
        reminder_owner_id: Number(row.id),
        reminder_anchor_start: row.start_datetime,
      };
    }
  });
}

/** Loads linked replacements by series owner and their displayed overlap. */
export function loadLinkedOverrides(database, parentIds, from = null, to = null) {
  const ids = [...new Set((parentIds ?? [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];

  const where = [`recurrence_parent_id IN (${ids.map(() => '?').join(',')})`];
  const params = [...ids];
  if (from) {
    where.push('DATE(COALESCE(end_datetime, start_datetime)) >= DATE(?)');
    params.push(from);
  }
  if (to) {
    where.push('DATE(start_datetime) <= DATE(?)');
    params.push(to);
  }
  return database.prepare(`
    SELECT * FROM calendar_events
    WHERE ${where.join('\n      AND ')}
    ORDER BY start_datetime ASC, id ASC
  `).all(...params);
}

const schemaColumnsByDatabase = new WeakMap();

function tableColumns(database, table) {
  let databaseCache = schemaColumnsByDatabase.get(database);
  if (!databaseCache) {
    databaseCache = new Map();
    schemaColumnsByDatabase.set(database, databaseCache);
  }
  if (!databaseCache.has(table)) {
    databaseCache.set(
      table,
      new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name)),
    );
  }
  return databaseCache.get(table);
}

function hasColumn(database, table, column) {
  return tableColumns(database, table).has(column);
}

function configuredOutlookWritableTargets(database) {
  const requiredColumns = [
    ['outlook_accounts', 'id'],
    ['outlook_accounts', 'auto_sync_calendar_id'],
    ['outlook_accounts', 'owner_user_id'],
    ['outlook_calendar_selection', 'account_id'],
    ['outlook_calendar_selection', 'calendar_id'],
    ['outlook_calendar_selection', 'enabled'],
    ['outlook_calendar_selection', 'can_edit'],
    ['calendar_events', 'visibility'],
    ['calendar_events', 'created_by'],
    ['event_assignments', 'event_id'],
    ['event_assignments', 'user_id'],
  ];
  if (!requiredColumns.every(([table, column]) => hasColumn(database, table, column))) return [];
  // needs_reauth ist nur vorübergehend: ein Reconnect darf die Serie nicht
  // unbemerkt mit verknüpften Einzelausnahmen an ein beschreibbares Ziel senden.
  return database.prepare(`
    SELECT a.id, a.owner_user_id, a.auto_sync_calendar_id, c.calendar_id
    FROM outlook_accounts a
    JOIN outlook_calendar_selection c ON c.account_id = a.id
    WHERE a.auto_sync_calendar_id IS NOT NULL AND a.owner_user_id IS NOT NULL
      AND c.enabled = 1 AND c.can_edit = 1
  `).all();
}

function hasConfiguredOutlookAutoSyncTarget(database, row, assignments,
  targets = configuredOutlookWritableTargets(database)) {
  if (!row || row.external_source !== 'local') return false;
  const assignedIds = assignments === undefined
    ? canonicalIds(assignmentIds(database, row.id))
    : canonicalIds(assignments);
  const assigned = new Set(assignedIds.map(Number));
  return targets.some((target) => {
    const calendarId = Number(row.target_outlook_account_id) === Number(target.id)
      ? row.target_outlook_calendar_id
      : target.auto_sync_calendar_id;
    return calendarId === target.calendar_id && (
      row.visibility === 'all'
      || Number(row.created_by) === Number(target.owner_user_id)
      || (row.visibility === 'assignees' && assigned.has(Number(target.owner_user_id)))
    );
  });
}

function hasLocalSeriesOrigin(row) {
  return !!row?.recurrence_rule
    && row.external_source === 'local'
    && row.external_calendar_id == null
    && row.calendar_ref_id == null
    && row.subscription_id == null
    && row.external_object_url == null
    && row.recurrence_parent_id == null;
}

function structurallyIneligible(row) {
  return !row?.recurrence_rule
    || row.external_source !== 'local'
    || row.external_calendar_id != null
    || row.calendar_ref_id != null
    || row.subscription_id != null
    || row.external_object_url != null
    || row.target_google_calendar_id != null
    || row.target_caldav_account_id != null
    || row.target_caldav_calendar_url != null
    || row.target_outlook_account_id != null
    || row.target_outlook_calendar_id != null
    || row.recurrence_parent_id != null;
}

/** Classifies distinct persisted masters with shared schema and ownership queries. */
export function classifyLocalSeriesBatch(database, rows) {
  const masters = [...new Map((rows ?? [])
    .filter((row) => row && Number.isInteger(Number(row.id)))
    .map((row) => [Number(row.id), row])).values()];
  const result = new Map(masters.map((row) => [
    Number(row.id),
    !hasLocalSeriesOrigin(row)
      ? { eligible: false, reason: 'ineligible_series', local: false }
      : null,
  ]));
  const candidates = masters.filter((row) => result.get(Number(row.id)) === null);
  if (candidates.length === 0) return result;

  const ids = candidates.map((row) => Number(row.id));
  const placeholders = ids.map(() => '?').join(',');
  const disqualified = new Set();
  const generatedOwnerColumns = [
    ['birthdays', 'calendar_event_id'],
    ['birthdays', 'name_day_calendar_event_id'],
    ['housekeeping_work_sessions', 'calendar_event_id'],
  ].filter(([table, column]) => hasColumn(database, table, column));
  if (generatedOwnerColumns.length > 0) {
    const unions = generatedOwnerColumns.map(([table, column]) =>
      `SELECT ${column} AS event_id FROM ${table} WHERE ${column} IN (${placeholders})`);
    const params = generatedOwnerColumns.flatMap(() => ids);
    for (const row of database.prepare(unions.join('\nUNION\n')).all(...params)) {
      disqualified.add(Number(row.event_id));
    }
  }
  if (hasColumn(database, 'outlook_event_links', 'event_id')) {
    for (const row of database.prepare(`
      SELECT DISTINCT event_id FROM outlook_event_links
      WHERE event_id IN (${placeholders})
    `).all(...ids)) disqualified.add(Number(row.event_id));
  }

  const autoSyncTargets = configuredOutlookWritableTargets(database);
  if (autoSyncTargets.length > 0) {
    const assignments = new Map();
    for (const row of database.prepare(`
      SELECT event_id, user_id FROM event_assignments
      WHERE event_id IN (${placeholders})
    `).all(...ids)) {
      if (!assignments.has(Number(row.event_id))) assignments.set(Number(row.event_id), []);
      assignments.get(Number(row.event_id)).push(Number(row.user_id));
    }
    for (const row of candidates) {
      if (hasConfiguredOutlookAutoSyncTarget(database, row,
        assignments.get(Number(row.id)) ?? [], autoSyncTargets)) {
        disqualified.add(Number(row.id));
      }
    }
  }

  for (const row of candidates) {
    const eligible = !structurallyIneligible(row) && !disqualified.has(Number(row.id));
    result.set(Number(row.id), {
      eligible,
      reason: eligible ? null : 'ineligible_series',
      local: true,
    });
  }
  return result;
}

/** Classifies persisted series ownership independently of the requesting actor. */
export function classifyLocalSeries(database, row) {
  if (!row || !Number.isInteger(Number(row.id))) {
    return { eligible: false, reason: 'ineligible_series' };
  }
  const { eligible, reason } = classifyLocalSeriesBatch(database, [row]).get(Number(row.id));
  return { eligible, reason };
}

/** Local origin is independent of whether the provider can carry linked overrides. */
export function isLocallyOwnedSeries(database, row) {
  return classifyLocalSeriesBatch(database, [row]).get(Number(row?.id))?.local === true;
}

function actorCanSeeSeries(database, row, actorId) {
  // Visibility deliberately has no admin bypass (#474). Occurrence mutations
  // must use the same policy as the whole-series routes that loaded the row.
  if (Number(row.created_by) === Number(actorId) || row.visibility === 'all') return true;
  if (row.visibility !== 'assignees') return false;
  return !!database.prepare(`
    SELECT 1 FROM event_assignments WHERE event_id = ? AND user_id = ?
  `).get(row.id, actorId);
}

/** Builds request-local capability metadata once per distinct recurring master. */
export function buildRecurrenceCapabilityMap(database, events, {
  actorId = null,
} = {}) {
  const mastersById = new Map();
  for (const event of events ?? []) {
    const linked = event?.is_occurrence_override === true || isLinkedOccurrence(event);
    if (!linked && !event?.recurrence_rule) continue;
    const seriesId = Number(event.series_id ?? seriesIdFor(event));
    if (!Number.isInteger(seriesId) || seriesId < 1) continue;
    if (!linked && Number(event.id) === seriesId) mastersById.set(seriesId, event);
    else if (!mastersById.has(seriesId)) mastersById.set(seriesId, null);
  }
  const missing = [...mastersById].filter(([, master]) => !master).map(([id]) => id);
  if (missing.length > 0) {
    const loaded = database.prepare(`
      SELECT * FROM calendar_events WHERE id IN (${missing.map(() => '?').join(',')})
    `).all(...missing);
    for (const master of loaded) mastersById.set(Number(master.id), master);
  }

  const masters = [...mastersById.values()].filter(Boolean);
  const classifications = classifyLocalSeriesBatch(database, masters);
  // Provider write access can change outside our configuration endpoints. A
  // linked series must never fall back to the standalone+EXDATE workflow: that
  // workflow cannot remove or replace an existing linked child.
  const legacyCandidates = masters.filter((master) => {
    const classification = classifications.get(Number(master.id));
    return classification?.local && !classification.eligible;
  }).map((master) => Number(master.id));
  const linkedParents = new Set(legacyCandidates.length === 0 ? [] : database.prepare(`
    SELECT DISTINCT recurrence_parent_id FROM calendar_events
    WHERE recurrence_parent_id IN (${legacyCandidates.map(() => '?').join(',')})
  `).all(...legacyCandidates).map((row) => Number(row.recurrence_parent_id)));
  const capabilities = new Map();
  for (const [seriesId, master] of mastersById) {
    if (!master) continue;
    const classification = classifications.get(seriesId)
      ?? { eligible: false, reason: 'ineligible_series' };
    capabilities.set(seriesId, {
      master,
      isLocalRecurringSeries: classification.local === true,
      canOverrideOccurrence: classification.eligible
        && actorCanSeeSeries(database, master, actorId),
      canDetachOccurrence: classification.local === true && !classification.eligible
        && !linkedParents.has(seriesId)
        && actorCanSeeSeries(database, master, actorId),
    });
  }
  return capabilities;
}

/** Returns structural eligibility; route visibility supplies actor authorization. */
export function isEligibleLocalSeries(database, row, actorId) {
  const classification = classifyLocalSeries(database, row);
  if (!classification.eligible) return classification;
  if (!actorCanSeeSeries(database, row, actorId)) {
    return { eligible: false, reason: 'not_authorized' };
  }
  return classification;
}

const SCALAR_OVERRIDE_FIELDS = Object.freeze([
  'title', 'description', 'start_datetime', 'end_datetime', 'all_day', 'location',
  'color', 'icon', 'visibility', 'countdown',
]);

let fallbackTransactionId = 0;

function runTransaction(database, work) {
  if (typeof database.transaction === 'function') return database.transaction(work)();
  // node:sqlite fixtures do not expose better-sqlite3's transaction helper.
  // SAVEPOINT preserves identical atomicity and remains valid inside an outer
  // transaction, unlike a raw BEGIN/COMMIT fallback.
  const savepoint = `calendar_occurrence_${++fallbackTransactionId}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = work();
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

function loadSeriesForMutation(database, seriesId, actorId, isAdmin, authorizeActor = true) {
  const id = Number(seriesId);
  const master = Number.isInteger(id) && id > 0
    ? database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id)
    : null;
  if (!master) {
    throw new CalendarOccurrenceError('Calendar series not found.', {
      status: 404,
      code: 'calendar_series_not_found',
    });
  }
  const eligibility = authorizeActor
    ? isEligibleLocalSeries(database, master, actorId)
    : classifyLocalSeries(database, master);
  if (!eligibility.eligible) {
    const unauthorized = eligibility.reason === 'not_authorized';
    throw new CalendarOccurrenceError(
      unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
      {
        status: unauthorized ? 403 : 400,
        code: eligibility.reason,
      },
    );
  }
  return master;
}

function normalizeScalar(field, value) {
  if (field === 'all_day' || field === 'countdown') return value ? 1 : 0;
  if (['description', 'end_datetime', 'location', 'color'].includes(field)) return value || null;
  return value;
}

function assertValidEffectiveInterval(values) {
  if (!values.end_datetime) return;
  const start = wallTimeMs(values.start_datetime);
  const end = wallTimeMs(values.end_datetime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new CalendarOccurrenceError(
      'end_datetime must not precede the effective start_datetime.',
      { status: 400, code: 'invalid_occurrence_interval' },
    );
  }
}

function sameScalar(left, right) {
  return (left ?? null) === (right ?? null);
}

function orderedIds(values) {
  return [...new Set((values ?? [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
}

function canonicalIds(values) {
  return orderedIds(values).sort((left, right) => left - right);
}

function canonicalOffsets(values) {
  return [...new Set((values ?? [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0))]
    .sort((left, right) => left - right);
}

function assignmentIds(database, eventId) {
  return database.prepare(`
    SELECT user_id FROM event_assignments
    WHERE event_id = ?
    ORDER BY user_id
  `).all(eventId).map((row) => Number(row.user_id));
}

function assignmentPrimary(row, ids) {
  const stored = Number(row?.assigned_to);
  return ids.includes(stored) ? stored : (ids[0] ?? null);
}

function loadProjectedEvent(database, eventId) {
  return database.prepare(`
    SELECT e.*,
           u_assigned.display_name AS assigned_name,
           u_assigned.avatar_color AS assigned_color,
           ${ASSIGNED_USERS_SQL}
    FROM calendar_events e
    LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
    WHERE e.id = ?
  `).get(eventId);
}

function sameNumberSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const ATTACHMENT_PROPERTIES = Object.freeze([
  'attachment_name', 'attachment_mime', 'attachment_size', 'attachment_data',
  'attachment_document_id',
]);

function attachmentValues(source) {
  const result = {};
  for (const property of ATTACHMENT_PROPERTIES) result[property] = source?.[property] ?? null;
  return result;
}

function sameAttachment(left, right) {
  return ATTACHMENT_PROPERTIES.every((property) => sameScalar(left[property], right[property]));
}

function attachmentDocumentExists(database, documentId) {
  return Number(documentId) > 0
    && hasColumn(database, 'family_documents', 'id')
    && Boolean(database.prepare('SELECT 1 FROM family_documents WHERE id = ?').get(documentId));
}

function detachedAttachmentCloneRequests(database, children, master) {
  const sourceDocumentId = Number(master.attachment_document_id);
  if (!attachmentDocumentExists(database, sourceDocumentId)) return [];
  return children
    .filter((child) => !parseOverrideFields(child.overridden_fields).includes('attachment'))
    .map((child) => ({
      owner: 'detached',
      childId: Number(child.id),
      sourceDocumentId,
      attachment: attachmentValues(master),
    }));
}

function independentAttachmentValues(database, cloned, sourceDocumentId, claimedDocumentIds) {
  const values = attachmentValues(cloned);
  const documentId = Number(values.attachment_document_id);
  if (!Number.isInteger(documentId)
      || documentId < 1
      || documentId === Number(sourceDocumentId)
      || claimedDocumentIds.has(documentId)
      || !attachmentDocumentExists(database, documentId)) {
    throw new Error('Attachment clone callback must create a distinct document row.');
  }
  claimedDocumentIds.add(documentId);
  return values;
}

function syncOwnedAttachmentAccess(database, documentId, visibility, userIds) {
  if (!documentId
      || !hasColumn(database, 'family_documents', 'visibility')
      || !hasColumn(database, 'family_document_access', 'document_id')
      || !hasColumn(database, 'family_document_access', 'user_id')) return;
  const documentVisibility = visibility === 'private'
    ? 'private'
    : visibility === 'assignees'
      ? 'restricted'
      : 'family';
  database.prepare('UPDATE family_documents SET visibility = ? WHERE id = ?')
    .run(documentVisibility, documentId);
  database.prepare('DELETE FROM family_document_access WHERE document_id = ?').run(documentId);
  if (documentVisibility !== 'restricted') return;
  const insert = database.prepare(`
    INSERT OR IGNORE INTO family_document_access (document_id, user_id) VALUES (?, ?)
  `);
  for (const userId of userIds) insert.run(documentId, userId);
}

function wallTimeMs(value) {
  const raw = String(value ?? '');
  const normalized = raw.includes('T') ? raw : `${raw}T09:00:00`;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  return Date.parse(zoned ? normalized : `${normalized}Z`);
}

function shiftedDateTimeLike(value, shiftMs) {
  const shifted = new Date(wallTimeMs(value) + shiftMs).toISOString();
  const source = String(value);
  if (DATE_ONLY_RE.test(source)) return shifted.slice(0, 10);
  const local = shifted.slice(0, /T\d{2}:\d{2}:\d{2}/.test(source) ? 19 : 16);
  return /Z$/.test(source) ? `${local}Z` : local;
}

function firstSlotSeriesChanges(master, selected, changes) {
  const normalized = { ...changes };
  const slotShift = wallTimeMs(master.start_datetime) - wallTimeMs(selected.start_datetime);
  for (const field of ['start_datetime', 'end_datetime']) {
    if (!Object.hasOwn(changes, field) || changes[field] === null) continue;
    if (Number.isFinite(slotShift)) {
      const shifted = shiftedDateTimeLike(changes[field], slotShift);
      const representationChanged = DATE_ONLY_RE.test(String(master[field] ?? ''))
        !== DATE_ONLY_RE.test(String(changes[field]));
      normalized[field] = !representationChanged
          && wallTimeMs(shifted) === wallTimeMs(master[field])
        ? master[field]
        : shifted;
    }
  }
  return normalized;
}

function reminderState(database, eventId, anchorStart) {
  const anchor = wallTimeMs(anchorStart);
  if (!Number.isFinite(anchor)) return [];
  return database.prepare(`
    SELECT remind_at, dismissed, created_by, assigned_from
    FROM reminders
    WHERE entity_type = 'event' AND entity_id = ?
    ORDER BY created_by, assigned_from, remind_at, dismissed
  `).all(eventId).map((row) => ({
    offsetMs: anchor - wallTimeMs(row.remind_at),
    dismissed: Number(row.dismissed),
    createdBy: Number(row.created_by),
    assignedFrom: row.assigned_from === null ? null : Number(row.assigned_from),
  }));
}

function sameReminderState(left, right) {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index];
    return row.offsetMs === other.offsetMs
      && row.dismissed === other.dismissed
      && row.createdBy === other.createdBy
      && row.assignedFrom === other.assignedFrom;
  });
}

function remindAtForOffset(anchorStart, offset) {
  const anchor = wallTimeMs(anchorStart);
  const result = new Date(anchor - offset * 60000).toISOString();
  return /Z$/.test(String(anchorStart)) ? result : result.slice(0, 19);
}

function replaceAssignments(database, eventId, userIds) {
  const before = assignmentIds(database, eventId);
  database.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(eventId);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)
  `);
  for (const userId of userIds) insert.run(eventId, userId);
  const removed = before.filter((userId) => !userIds.includes(userId));
  dropInheritedEventReminders(database, eventId, removed);
  const authorId = eventAuthorId(database, eventId);
  if (authorId !== null) fanOutEventReminders(database, eventId, authorId, { dropDerivedWhenOwn: true });
}

function replaceReminders(database, eventId, actorId, anchorStart, offsets) {
  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  `).run(eventId, actorId);
  const insert = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, ?, ?)
  `);
  for (const offset of offsets) {
    insert.run(eventId, remindAtForOffset(anchorStart, offset), actorId);
  }
}

function copyReminderState(database, sourceId, targetId, sourceAnchor, targetAnchor) {
  const sourceStart = wallTimeMs(sourceAnchor);
  const targetStart = wallTimeMs(targetAnchor);
  const shift = targetStart - sourceStart;
  if (!Number.isFinite(shift)) return;
  const insert = database.prepare(`
    INSERT INTO reminders
      (entity_type, entity_id, remind_at, dismissed, created_by, assigned_from)
    VALUES ('event', ?, ?, ?, ?, ?)
  `);
  for (const row of database.prepare(`
    SELECT remind_at, dismissed, created_by, assigned_from
    FROM reminders WHERE entity_type = 'event' AND entity_id = ?
  `).all(sourceId)) {
    const shifted = new Date(wallTimeMs(row.remind_at) + shift).toISOString();
    insert.run(
      targetId,
      /Z$/.test(String(row.remind_at)) ? shifted : shifted.slice(0, 19),
      row.dismissed,
      row.created_by,
      row.assigned_from,
    );
  }
}

function pruneInheritedRemindersToAssignments(database, eventId, userIds) {
  const effective = new Set(userIds.map(Number));
  const removedRecipients = database.prepare(`
    SELECT DISTINCT created_by FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND assigned_from IS NOT NULL
  `).all(eventId)
    .map((row) => Number(row.created_by))
    .filter((userId) => !effective.has(userId));
  dropInheritedEventReminders(database, eventId, removedRecipients);
}

/**
 * Creates or updates one local replacement and its EXDATE in one transaction.
 * `changes` is already validated route data; omitted properties retain the
 * existing replacement value or continue inheriting from the master.
 */
export function upsertOccurrenceOverride(database, {
  seriesId,
  recurrenceId,
  actorId,
  isAdmin = false,
  changes = {},
  assignments,
  attachment,
  createAttachment,
  reminderOffsets: requestedReminderOffsets,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    const base = baseOccurrenceFor(master, recurrenceId);
    assertOccurrenceSlotCanBeMutated(database, master.id, recurrenceId);
    const existing = database.prepare(`
      SELECT * FROM calendar_events
      WHERE recurrence_parent_id = ? AND recurrence_id = ?
    `).get(master.id, recurrenceId);
    const current = existing ? resolveOccurrence(database, existing, master) : base;
    const existingFields = existing ? parseOverrideFields(existing.overridden_fields) : [];
    const materialized = { ...current };
    for (const field of SCALAR_OVERRIDE_FIELDS) {
      if (Object.hasOwn(changes, field)) {
        materialized[field] = normalizeScalar(field, changes[field]);
      }
    }
    assertValidEffectiveInterval(materialized);

    const baseAssignments = canonicalIds(assignmentIds(database, master.id));
    const currentAssignments = existingFields.includes('assignments')
      ? canonicalIds(assignmentIds(database, existing.id))
      : baseAssignments;
    const requestedAssignments = assignments === undefined ? undefined : orderedIds(assignments);
    const effectiveAssignments = assignments === undefined
      ? currentAssignments
      : requestedAssignments;
    const basePrimary = assignmentPrimary(master, baseAssignments);
    const currentPrimary = existingFields.includes('assignments')
      ? assignmentPrimary(existing, currentAssignments)
      : basePrimary;
    const effectivePrimary = requestedAssignments === undefined
      ? currentPrimary
      : requestedAssignments[0] ?? null;

    const baseAttachment = attachmentValues(master);
    const currentAttachment = existingFields.includes('attachment')
      ? attachmentValues(existing)
      : baseAttachment;
    const createdAttachment = typeof createAttachment === 'function'
      ? createAttachment()
      : attachment;
    const effectiveAttachment = createdAttachment === undefined
      ? currentAttachment
      : attachmentValues(createdAttachment);

    const remindersWereOwned = existingFields.includes('reminders');

    const scalarDifferences = new Set(SCALAR_OVERRIDE_FIELDS.filter((field) =>
      !sameScalar(materialized[field], base[field])
    ));
    const assignmentsDiffer = !sameNumberSet(
      canonicalIds(effectiveAssignments),
      baseAssignments,
    ) || effectivePrimary !== basePrimary;
    const remindersMayDiffer = remindersWereOwned
      || requestedReminderOffsets !== undefined
      || assignmentsDiffer;
    const attachmentDiffers = !sameAttachment(effectiveAttachment, baseAttachment);
    let fields = OVERRIDE_FIELDS.filter((field) =>
      scalarDifferences.has(field)
      || (field === 'assignments' && assignmentsDiffer)
      || (field === 'attachment' && attachmentDiffers)
      || (field === 'reminders' && remindersMayDiffer)
    );
    if (fields.length === 0) {
      if (existing) {
        deleteEventReminders(database, [existing.id]);
        database.prepare('DELETE FROM calendar_events WHERE id = ?').run(existing.id);
        database.prepare(`
          DELETE FROM calendar_event_exceptions
          WHERE event_id = ? AND exception_date = ?
        `).run(master.id, recurrenceId);
      }
      return { event: base, restored: true };
    }

    const overriddenFields = JSON.stringify(fields);
    let childId;
    if (existing) {
      database.prepare(`
        UPDATE calendar_events
        SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
            all_day = ?, location = ?, color = ?, icon = ?, assigned_to = ?,
            visibility = ?, countdown = ?, attachment_name = ?,
            attachment_mime = ?, attachment_size = ?, attachment_data = ?,
            attachment_document_id = ?, recurrence_parent_id = ?, recurrence_id = ?,
            overridden_fields = ?
        WHERE id = ?
      `).run(
        materialized.title,
        materialized.description ?? null,
        materialized.start_datetime,
        materialized.end_datetime ?? null,
        materialized.all_day ? 1 : 0,
        materialized.location ?? null,
        materialized.color ?? null,
        materialized.icon ?? 'calendar',
        assignmentsDiffer ? effectivePrimary : (materialized.assigned_to ?? null),
        materialized.visibility ?? 'all',
        materialized.countdown ? 1 : 0,
        effectiveAttachment.attachment_name,
        effectiveAttachment.attachment_mime,
        effectiveAttachment.attachment_size,
        effectiveAttachment.attachment_data,
        effectiveAttachment.attachment_document_id,
        master.id,
        recurrenceId,
        overriddenFields,
        existing.id,
      );
      childId = existing.id;
    } else {
      childId = database.prepare(`
        INSERT INTO calendar_events (
          title, description, start_datetime, end_datetime, all_day, location,
          color, icon, assigned_to, created_by, external_source, recurrence_rule,
          visibility, countdown, attachment_name, attachment_mime, attachment_size,
          attachment_data, attachment_document_id, recurrence_parent_id,
          recurrence_id, overridden_fields
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        materialized.title,
        materialized.description ?? null,
        materialized.start_datetime,
        materialized.end_datetime ?? null,
        materialized.all_day ? 1 : 0,
        materialized.location ?? null,
        materialized.color ?? null,
        materialized.icon ?? 'calendar',
        assignmentsDiffer ? effectivePrimary : (materialized.assigned_to ?? null),
        master.created_by,
        materialized.visibility ?? 'all',
        materialized.countdown ? 1 : 0,
        effectiveAttachment.attachment_name,
        effectiveAttachment.attachment_mime,
        effectiveAttachment.attachment_size,
        effectiveAttachment.attachment_data,
        effectiveAttachment.attachment_document_id,
        master.id,
        recurrenceId,
        overriddenFields,
      ).lastInsertRowid;
    }

    replaceAssignments(database, childId, effectiveAssignments);
    if (remindersWereOwned) {
      shiftOwnedReminders(database, childId, current.start_datetime, materialized.start_datetime);
    } else if (remindersMayDiffer) {
      deleteEventReminders(database, [childId]);
      copyReminderState(
        database,
        master.id,
        childId,
        master.start_datetime,
        materialized.start_datetime,
      );
    }
    if (requestedReminderOffsets !== undefined) {
      replaceReminders(
        database,
        childId,
        actorId,
        materialized.start_datetime,
        canonicalOffsets(requestedReminderOffsets),
      );
    }
    if (remindersMayDiffer) {
      pruneInheritedRemindersToAssignments(database, childId, effectiveAssignments);
    }
    if (remindersMayDiffer) fanOutEventReminders(database, childId, master.created_by, { dropDerivedWhenOwn: true });

    if (remindersMayDiffer && sameReminderState(
      reminderState(database, childId, materialized.start_datetime),
      reminderState(database, master.id, master.start_datetime),
    )) {
      deleteEventReminders(database, [childId]);
      fields = fields.filter((field) => field !== 'reminders');
      if (fields.length === 0) {
        database.prepare('DELETE FROM calendar_events WHERE id = ?').run(childId);
        if (existing) {
          database.prepare(`
            DELETE FROM calendar_event_exceptions
            WHERE event_id = ? AND exception_date = ?
          `).run(master.id, recurrenceId);
        }
        return { event: base, restored: true };
      }
      database.prepare('UPDATE calendar_events SET overridden_fields = ? WHERE id = ?')
        .run(JSON.stringify(fields), childId);
    }

    database.prepare(`
      INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
      VALUES (?, ?)
    `).run(master.id, recurrenceId);
    const child = loadProjectedEvent(database, childId);
    if (attachmentDiffers) {
      syncOwnedAttachmentAccess(
        database,
        child.attachment_document_id,
        child.visibility,
        effectiveAssignments,
      );
    }
    return { event: resolveOccurrence(database, child, master), restored: false };
  });
}

function deleteEventReminders(database, eventIds) {
  const ids = [...new Set(eventIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return;
  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id IN (${ids.map(() => '?').join(',')})
  `).run(...ids);
}

function previousDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function recurrenceIsEmptyAtAnchor(source) {
  const start = String(source.start_datetime ?? '');
  const wall = source.tzid ? utcToWall(start, source.tzid) : null;
  const utcDiffersFromLocal = Boolean(source.tzid)
    && !(wall && wall.date === start.slice(0, 10));
  return !hasAnyOccurrence(start, source.recurrence_rule, { utcDiffersFromLocal });
}

export function assertSuccessorHasOccurrence(source) {
  if (recurrenceIsEmptyAtAnchor(source)) {
    throw new CalendarOccurrenceError(
      'The successor recurrence rule has no occurrence on or after its start date.',
      { status: 400, code: 'empty_successor_series' },
    );
  }
}

function remainingCountRule(master, recurrenceId) {
  const count = parseRRule(master.recurrence_rule)?.count ?? null;
  if (count === null) return master.recurrence_rule;
  const occurrences = expandRecurringEvents(
    [master],
    master.start_datetime.slice(0, 10),
    recurrenceId,
    new Map(),
    {
      includeRecurrenceIdentity: true,
      maxIterations: exactLookupIterationLimit(master, recurrenceId),
    },
  );
  const selectedIndex = occurrences.findIndex((row) => row.recurrence_identity === recurrenceId);
  if (selectedIndex < 0) {
    throw invalidRecurrenceIdentity(
      'The validated recurrence_id could not be indexed within the bounded series reach.',
    );
  }
  return String(master.recurrence_rule).replace(/COUNT=\d+/i, `COUNT=${count - selectedIndex}`);
}

function truncateRuleBefore(rule, recurrenceId) {
  const raw = String(rule ?? '').replace(/^RRULE:/, '');
  const kept = raw.split(';').filter((segment) =>
    !/^UNTIL=/i.test(segment) && !/^COUNT=/i.test(segment)
  );
  return [...kept, `UNTIL=${previousDateKey(recurrenceId).replaceAll('-', '')}`].join(';');
}

function linkedChildren(database, seriesId, fromRecurrenceId = null) {
  if (fromRecurrenceId) {
    return database.prepare(`
      SELECT * FROM calendar_events
      WHERE recurrence_parent_id = ? AND recurrence_id >= ?
      ORDER BY recurrence_id, id
    `).all(seriesId, fromRecurrenceId);
  }
  return database.prepare(`
    SELECT * FROM calendar_events
    WHERE recurrence_parent_id = ?
    ORDER BY recurrence_id, id
  `).all(seriesId);
}

/** Deletes one original slot while leaving the master's EXDATE in place. */
export function deleteOccurrence(database, {
  seriesId,
  recurrenceId,
  actorId,
  isAdmin = false,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    baseOccurrenceFor(master, recurrenceId);
    const child = database.prepare(`
      SELECT id FROM calendar_events
      WHERE recurrence_parent_id = ? AND recurrence_id = ?
    `).get(master.id, recurrenceId);
    if (child) {
      deleteEventReminders(database, [child.id]);
      database.prepare('DELETE FROM calendar_events WHERE id = ?').run(child.id);
    }
    database.prepare(`
      INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
      VALUES (?, ?)
    `).run(master.id, recurrenceId);
    return { eventId: Number(master.id), recurrenceId };
  });
}

/** Truncates immediately before an original slot, or deletes from the first slot. */
export function truncateSeries(database, {
  seriesId,
  recurrenceId,
  actorId,
  isAdmin = false,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    const selected = baseOccurrenceFor(master, recurrenceId);
    const futureChildren = linkedChildren(database, master.id, recurrenceId);
    if (selected.is_series_start) {
      const allChildren = linkedChildren(database, master.id);
      deleteEventReminders(database, [master.id, ...allChildren.map((row) => row.id)]);
      database.prepare('DELETE FROM calendar_events WHERE id = ?').run(master.id);
      return { wholeSeries: true, eventId: Number(master.id) };
    }

    deleteEventReminders(database, futureChildren.map((row) => row.id));
    database.prepare(`
      DELETE FROM calendar_events
      WHERE recurrence_parent_id = ? AND recurrence_id >= ?
    `).run(master.id, recurrenceId);
    const recurrenceRule = truncateRuleBefore(master.recurrence_rule, recurrenceId);
    database.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?')
      .run(recurrenceRule, master.id);
    return { wholeSeries: false, eventId: Number(master.id), recurrenceRule };
  });
}

function insertSeriesRow(database, source) {
  return Number(database.prepare(`
    INSERT INTO calendar_events (
      title, description, start_datetime, end_datetime, all_day, location,
      color, icon, assigned_to, created_by, external_source, recurrence_rule,
      visibility, countdown, attachment_name, attachment_mime, attachment_size,
      attachment_data, attachment_document_id, tzid, target_google_calendar_id,
      target_caldav_account_id, target_caldav_calendar_url,
      target_outlook_account_id, target_outlook_calendar_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.title,
    source.description ?? null,
    source.start_datetime,
    source.end_datetime ?? null,
    source.all_day ? 1 : 0,
    source.location ?? null,
    source.color ?? null,
    source.icon ?? 'calendar',
    source.assigned_to ?? null,
    source.created_by,
    source.recurrence_rule,
    source.visibility ?? 'all',
    source.countdown ? 1 : 0,
    source.attachment_name ?? null,
    source.attachment_mime ?? null,
    source.attachment_size ?? null,
    source.attachment_data ?? null,
    source.attachment_document_id ?? null,
    source.tzid ?? null,
    source.target_google_calendar_id ?? null,
    source.target_caldav_account_id ?? null,
    source.target_caldav_calendar_url ?? null,
    source.target_outlook_account_id ?? null,
    source.target_outlook_calendar_id ?? null,
  ).lastInsertRowid);
}

function scalarDifferencesFromBase(values, base, limitedTo = SCALAR_OVERRIDE_FIELDS) {
  return limitedTo.filter((field) => !sameScalar(values[field], base[field]));
}

function refreshReparentedChild(database, child, oldResolved, successor, successorAssignments) {
  let newBase;
  try {
    newBase = baseOccurrenceFor(successor, child.recurrence_id);
  } catch {
    throw new CalendarOccurrenceError(
      'A linked occurrence cannot belong to the successor recurrence rule.',
      { status: 400, code: 'invalid_successor_override' },
    );
  }
  const oldFields = parseOverrideFields(child.overridden_fields);
  const values = { ...newBase };
  for (const field of oldFields) {
    if (SCALAR_OVERRIDE_FIELDS.includes(field)) values[field] = oldResolved[field];
  }

  const fields = scalarDifferencesFromBase(values, newBase, oldFields.filter((field) =>
    SCALAR_OVERRIDE_FIELDS.includes(field)
  ));
  const effectiveAssignments = oldFields.includes('assignments')
    ? canonicalIds(assignmentIds(database, child.id))
    : successorAssignments;
  const childPrimary = assignmentPrimary(child, effectiveAssignments);
  const successorPrimary = assignmentPrimary(successor, successorAssignments);
  if (!sameNumberSet(effectiveAssignments, successorAssignments)
      || childPrimary !== successorPrimary) fields.push('assignments');
  const effectiveAttachment = oldFields.includes('attachment')
    ? attachmentValues(child)
    : attachmentValues(successor);
  if (!sameAttachment(effectiveAttachment, attachmentValues(successor))) fields.push('attachment');
  if (oldFields.includes('reminders')) {
    const childState = reminderState(database, child.id, oldResolved.start_datetime);
    const seriesState = reminderState(database, successor.id, successor.start_datetime);
    if (!sameReminderState(childState, seriesState)) {
      fields.push('reminders');
      shiftOwnedReminders(database, child.id, oldResolved.start_datetime, values.start_datetime);
    } else {
      deleteEventReminders(database, [child.id]);
    }
  }
  const orderedFields = OVERRIDE_FIELDS.filter((field) => fields.includes(field));

  if (orderedFields.length === 0) {
    deleteEventReminders(database, [child.id]);
    database.prepare('DELETE FROM calendar_events WHERE id = ?').run(child.id);
    database.prepare(`
      DELETE FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date = ?
    `).run(successor.id, child.recurrence_id);
    return true;
  }

  database.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
        all_day = ?, location = ?, color = ?, icon = ?, assigned_to = ?,
        visibility = ?, countdown = ?, attachment_name = ?, attachment_mime = ?,
        attachment_size = ?, attachment_data = ?, attachment_document_id = ?,
        recurrence_parent_id = ?, overridden_fields = ?
    WHERE id = ?
  `).run(
    values.title,
    values.description ?? null,
    values.start_datetime,
    values.end_datetime ?? null,
    values.all_day ? 1 : 0,
    values.location ?? null,
    values.color ?? null,
    values.icon ?? 'calendar',
    orderedFields.includes('assignments') ? child.assigned_to : successor.assigned_to,
    values.visibility ?? 'all',
    values.countdown ? 1 : 0,
    effectiveAttachment.attachment_name,
    effectiveAttachment.attachment_mime,
    effectiveAttachment.attachment_size,
    effectiveAttachment.attachment_data,
    effectiveAttachment.attachment_document_id,
    successor.id,
    JSON.stringify(orderedFields),
    child.id,
  );
  replaceAssignments(database, child.id, effectiveAssignments);
  if (orderedFields.includes('attachment')) {
    syncOwnedAttachmentAccess(
      database,
      effectiveAttachment.attachment_document_id,
      values.visibility,
      effectiveAssignments,
    );
  }
  return true;
}

/** Splits a series at one original slot and reparents all later override state. */
export function splitSeries(database, {
  seriesId,
  recurrenceId,
  actorId,
  isAdmin = false,
  changes = {},
  assignments,
  attachment,
  createAttachment,
  cloneAttachment,
  cloneDetachedAttachment,
  reminderOffsets: requestedReminderOffsets,
  confirmedOrphanCount,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    const selectedBase = baseOccurrenceFor(master, recurrenceId);
    assertOccurrenceSlotCanBeMutated(database, master.id, recurrenceId);
    if (selectedBase.is_series_start) {
      const normalizedChanges = firstSlotSeriesChanges(master, selectedBase, changes);
      assertValidEffectiveInterval({ ...master, ...normalizedChanges });
      const result = updateSeriesWithOverrides(database, {
        seriesId,
        actorId,
        isAdmin,
        changes: normalizedChanges,
        assignments,
        attachment,
        createAttachment,
        cloneDetachedAttachment,
        reminderOffsets: requestedReminderOffsets,
        confirmedOrphanCount,
      });
      return { series: result.series, wholeSeries: true };
    }

    const children = linkedChildren(database, master.id, recurrenceId);
    const resolvedById = new Map(children.map((row) => [
      Number(row.id),
      resolveOccurrence(database, row, master),
    ]));
    const selectedChild = children.find((row) => row.recurrence_id === recurrenceId);
    const selectedResolved = selectedChild
      ? resolvedById.get(Number(selectedChild.id))
      : selectedBase;
    const successorValues = { ...selectedResolved };
    for (const field of SCALAR_OVERRIDE_FIELDS) {
      if (Object.hasOwn(changes, field)) successorValues[field] = normalizeScalar(field, changes[field]);
    }
    for (const field of [
      'target_google_calendar_id',
      'target_caldav_account_id',
      'target_caldav_calendar_url',
      'target_outlook_account_id',
      'target_outlook_calendar_id',
    ]) {
      if (Object.hasOwn(changes, field)) successorValues[field] = changes[field] ?? null;
    }
    successorValues.recurrence_rule = Object.hasOwn(changes, 'recurrence_rule')
      && changes.recurrence_rule !== master.recurrence_rule
      ? changes.recurrence_rule
      : remainingCountRule(master, recurrenceId);
    successorValues.recurrence_parent_id = null;
    successorValues.recurrence_id = null;
    successorValues.overridden_fields = null;
    successorValues.created_by = master.created_by;

    const selectedFields = selectedChild ? parseOverrideFields(selectedChild.overridden_fields) : [];
    const requestedAssignments = assignments === undefined ? undefined : orderedIds(assignments);
    const successorAssignments = requestedAssignments === undefined
      ? selectedFields.includes('assignments')
        ? canonicalIds(assignmentIds(database, selectedChild.id))
        : canonicalIds(assignmentIds(database, master.id))
      : requestedAssignments;
    successorValues.assigned_to = requestedAssignments === undefined
      ? selectedFields.includes('assignments')
        ? assignmentPrimary(selectedChild, successorAssignments)
        : assignmentPrimary(master, successorAssignments)
      : requestedAssignments[0] ?? null;

    assertValidEffectiveInterval(successorValues);
    assertSuccessorHasOccurrence(successorValues);
    const futureChildren = children.filter((child) =>
      !selectedChild || Number(child.id) !== Number(selectedChild.id));
    const orphans = classifyOrphans(
      futureChildren,
      successorValues,
      hasOutboundTarget(successorValues)
        || hasConfiguredOutlookAutoSyncTarget(database, successorValues, successorAssignments),
    );
    const confirmationSupplied = confirmedOrphanCount !== undefined;
    if ((orphans.length > 0 || confirmationSupplied)
        && confirmedOrphanCount !== orphans.length) {
      throw orphanConflict(orphans.length);
    }
    const orphanIds = new Set(orphans.map((child) => Number(child.id)));
    const futureExceptions = database.prepare(`
      SELECT exception_date FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date >= ?
      ORDER BY exception_date
    `).all(master.id, recurrenceId);
    const transferableExceptions = futureExceptions.filter((exception) =>
      exception.exception_date !== recurrenceId);

    const inheritedDocumentId = !selectedFields.includes('attachment')
      ? Number(master.attachment_document_id)
      : null;
    const inheritedDocumentExists = attachmentDocumentExists(database, inheritedDocumentId);
    const detachedCloneRequests = detachedAttachmentCloneRequests(database, orphans, master);
    const cloneRequests = [];
    const successorInheritsDocument = createAttachment === undefined
      && attachment === undefined
      && inheritedDocumentExists;
    if (successorInheritsDocument && typeof cloneAttachment !== 'function') {
      cloneRequests.push({
        owner: 'successor',
        sourceDocumentId: inheritedDocumentId,
        attachment: attachmentValues(master),
      });
    }
    if (detachedCloneRequests.length > 0 && typeof cloneDetachedAttachment !== 'function') {
      cloneRequests.push(...detachedCloneRequests);
    }
    if (cloneRequests.length > 0) {
      throw new CalendarAttachmentCloneRequiredError(cloneRequests);
    }
    const claimedDocumentIds = new Set([
      Number(master.attachment_document_id),
      ...children.map((child) => Number(child.attachment_document_id)),
    ].filter((documentId) => Number.isInteger(documentId) && documentId > 0));
    const createdAttachment = typeof createAttachment === 'function'
      ? createAttachment()
      : attachment;
    const clonedAttachment = createdAttachment === undefined && inheritedDocumentExists
      ? independentAttachmentValues(
          database,
          cloneAttachment(inheritedDocumentId),
          inheritedDocumentId,
          claimedDocumentIds,
        )
      : undefined;
    const successorAttachment = createdAttachment === undefined
      ? selectedFields.includes('attachment')
        ? attachmentValues(selectedChild)
        : attachmentValues(clonedAttachment ?? master)
      : attachmentValues(createdAttachment);
    Object.assign(successorValues, successorAttachment);

    for (const child of orphans) {
      materializeDetachedChild(database, child, master, {
        cloneDetachedAttachment,
        claimedDocumentIds,
      });
    }
    database.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?')
      .run(truncateRuleBefore(master.recurrence_rule, recurrenceId), master.id);
    const successorId = insertSeriesRow(database, successorValues);
    replaceAssignments(database, successorId, successorAssignments);
    const reminderSource = selectedFields.includes('reminders') ? selectedChild : master;
    copyResolvedReminderState(database, {
      sourceEventId: reminderSource.id,
      targetEventId: successorId,
      sourceAnchor: selectedFields.includes('reminders')
        ? selectedResolved.start_datetime
        : master.start_datetime,
      targetAnchor: successorValues.start_datetime,
    });
    if (requestedReminderOffsets !== undefined) {
      replaceReminders(
        database,
        successorId,
        actorId,
        successorValues.start_datetime,
        canonicalOffsets(requestedReminderOffsets),
      );
    }
    fanOutEventReminders(database, successorId, master.created_by, { dropDerivedWhenOwn: true });
    const insertException = database.prepare(`
      INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
      VALUES (?, ?)
    `);
    for (const exception of transferableExceptions) {
      insertException.run(successorId, exception.exception_date);
    }
    database.prepare(`
      DELETE FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date >= ?
    `).run(master.id, recurrenceId);
    database.prepare(`
      UPDATE calendar_events SET recurrence_parent_id = ?
      WHERE recurrence_parent_id = ? AND recurrence_id >= ?
    `).run(successorId, master.id, recurrenceId);

    const successor = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(successorId);
    syncOwnedAttachmentAccess(
      database,
      successor.attachment_document_id,
      successor.visibility,
      successorAssignments,
    );
    for (const child of children) {
      if (orphanIds.has(Number(child.id))) continue;
      if (selectedChild && Number(child.id) === Number(selectedChild.id)) {
        deleteEventReminders(database, [child.id]);
        database.prepare('DELETE FROM calendar_events WHERE id = ?').run(child.id);
        database.prepare(`
          DELETE FROM calendar_event_exceptions
          WHERE event_id = ? AND exception_date = ?
        `).run(successorId, recurrenceId);
        continue;
      }
      refreshReparentedChild(
        database,
        { ...child, recurrence_parent_id: successorId },
        resolvedById.get(Number(child.id)),
        successor,
        successorAssignments,
      );
    }
    return {
      series: loadProjectedEvent(database, successorId),
      wholeSeries: false,
      orphanedOverrideCount: orphans.length,
    };
  });
}

const SERIES_UPDATE_FIELDS = Object.freeze([
  ...SCALAR_OVERRIDE_FIELDS,
  'recurrence_rule',
  'target_google_calendar_id',
  'target_caldav_account_id',
  'target_caldav_calendar_url',
  'target_outlook_account_id',
  'target_outlook_calendar_id',
]);

function hasOutboundTarget(row) {
  return row.target_google_calendar_id != null
    || row.target_caldav_account_id != null
    || row.target_caldav_calendar_url != null
    || row.target_outlook_account_id != null
    || row.target_outlook_calendar_id != null;
}

function orphanConflict(count) {
  return new CalendarOccurrenceError(
    'Edited occurrences no longer fit this recurrence rule.',
    {
      status: 409,
      code: 'calendar_override_orphans',
      conflict: 'calendar_override_orphans',
      orphanedOverrideCount: count,
    },
  );
}

function classifyOrphans(children, proposed, detachAll) {
  if (detachAll) return children;
  return children.filter((child) => {
    try {
      baseOccurrenceFor(proposed, child.recurrence_id);
      return false;
    } catch {
      return true;
    }
  });
}

function copyResolvedReminderState(database, {
  sourceEventId,
  targetEventId,
  sourceAnchor,
  targetAnchor,
}) {
  const rows = database.prepare(`
    SELECT remind_at, dismissed, created_by, assigned_from
    FROM reminders
    WHERE entity_type = 'event' AND entity_id = ?
    ORDER BY id
  `).all(sourceEventId);
  const targetOwn = new Set(database.prepare(`
    SELECT DISTINCT created_by
    FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND assigned_from IS NULL
  `).all(targetEventId).map((row) => Number(row.created_by)));
  const targetAssignees = new Set(assignmentIds(database, targetEventId).map(Number));
  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND assigned_from IS NOT NULL
  `).run(targetEventId);
  const shift = wallTimeMs(targetAnchor) - wallTimeMs(sourceAnchor);
  const insert = database.prepare(`
    INSERT INTO reminders
      (entity_type, entity_id, remind_at, dismissed, created_by, assigned_from)
    VALUES ('event', ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const createdBy = Number(row.created_by);
    if (targetOwn.has(createdBy)) continue;
    if (row.assigned_from !== null && !targetAssignees.has(createdBy)) continue;
    const shifted = new Date(wallTimeMs(row.remind_at) + shift).toISOString();
    insert.run(
      targetEventId,
      /Z$/.test(String(row.remind_at)) ? shifted : shifted.slice(0, 19),
      row.dismissed,
      createdBy,
      row.assigned_from,
    );
  }
}

function materializeDetachedChild(database, child, master, {
  cloneDetachedAttachment,
  claimedDocumentIds,
} = {}) {
  const fields = parseOverrideFields(child.overridden_fields);
  const resolved = resolveOccurrence(database, child, master);
  const effectiveAssignments = fields.includes('assignments')
    ? canonicalIds(assignmentIds(database, child.id))
    : canonicalIds(assignmentIds(database, master.id));
  if (!fields.includes('assignments')) {
    replaceAssignments(database, child.id, effectiveAssignments);
  }
  if (!fields.includes('reminders')) {
    copyResolvedReminderState(database, {
      sourceEventId: master.id,
      targetEventId: child.id,
      sourceAnchor: master.start_datetime,
      targetAnchor: resolved.start_datetime,
    });
  }
  fanOutEventReminders(database, child.id, master.created_by, { dropDerivedWhenOwn: true });
  const inheritsAttachment = !fields.includes('attachment')
    && attachmentDocumentExists(database, resolved.attachment_document_id);
  const detachedAttachment = inheritsAttachment
    ? independentAttachmentValues(
        database,
        cloneDetachedAttachment(child.id, Number(resolved.attachment_document_id)),
        resolved.attachment_document_id,
        claimedDocumentIds,
      )
    : attachmentValues(resolved);
  database.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
        all_day = ?, location = ?, color = ?, icon = ?, assigned_to = ?,
        visibility = ?, countdown = ?, attachment_name = ?, attachment_mime = ?,
        attachment_size = ?, attachment_data = ?, attachment_document_id = ?,
        recurrence_parent_id = NULL, recurrence_id = NULL, overridden_fields = NULL
    WHERE id = ?
  `).run(
    resolved.title,
    resolved.description ?? null,
    resolved.start_datetime,
    resolved.end_datetime ?? null,
    resolved.all_day ? 1 : 0,
    resolved.location ?? null,
    resolved.color ?? null,
    resolved.icon ?? 'calendar',
    resolved.assigned_to ?? null,
    resolved.visibility ?? 'all',
    resolved.countdown ? 1 : 0,
    detachedAttachment.attachment_name,
    detachedAttachment.attachment_mime,
    detachedAttachment.attachment_size,
    detachedAttachment.attachment_data,
    detachedAttachment.attachment_document_id,
    child.id,
  );
  if (inheritsAttachment) {
    syncOwnedAttachmentAccess(
      database,
      detachedAttachment.attachment_document_id,
      resolved.visibility,
      effectiveAssignments,
    );
  }
}

function applySeriesChanges(database, seriesId, changes) {
  const entries = SERIES_UPDATE_FIELDS
    .filter((field) => Object.hasOwn(changes, field))
    .map((field) => [field, normalizeScalar(field, changes[field])]);
  if (entries.length === 0) return;
  database.prepare(`
    UPDATE calendar_events
    SET ${entries.map(([field]) => `${field} = ?`).join(', ')}
    WHERE id = ?
  `).run(...entries.map(([, value]) => value), seriesId);
}

function shiftOwnedReminders(database, eventId, oldAnchor, newAnchor) {
  const shift = wallTimeMs(newAnchor) - wallTimeMs(oldAnchor);
  if (!Number.isFinite(shift) || shift === 0) return;
  const rows = database.prepare(`
    SELECT id, remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ?
  `).all(eventId);
  const update = database.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?');
  for (const row of rows) {
    const shifted = new Date(wallTimeMs(row.remind_at) + shift).toISOString();
    update.run(/Z$/.test(String(row.remind_at)) ? shifted : shifted.slice(0, 19), row.id);
  }
}

function refreshInheritedChild(database, child, oldResolved, updatedMaster) {
  const fields = parseOverrideFields(child.overridden_fields);
  const newBase = baseOccurrenceFor(updatedMaster, child.recurrence_id);
  const values = { ...newBase };
  for (const field of fields) {
    if (SCALAR_OVERRIDE_FIELDS.includes(field)) values[field] = oldResolved[field];
  }
  const ownsAssignments = fields.includes('assignments');
  const ownsAttachment = fields.includes('attachment');
  const effectiveAssignments = ownsAssignments
    ? canonicalIds(assignmentIds(database, child.id))
    : canonicalIds(assignmentIds(database, updatedMaster.id));
  if (!ownsAssignments) {
    replaceAssignments(database, child.id, effectiveAssignments);
  }
  if (fields.includes('reminders')) {
    shiftOwnedReminders(database, child.id, oldResolved.start_datetime, values.start_datetime);
  }
  const effectiveAttachment = ownsAttachment
    ? attachmentValues(child)
    : attachmentValues(updatedMaster);

  database.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
        all_day = ?, location = ?, color = ?, icon = ?, assigned_to = ?,
        visibility = ?, countdown = ?, attachment_name = ?, attachment_mime = ?,
        attachment_size = ?, attachment_data = ?, attachment_document_id = ?
    WHERE id = ?
  `).run(
    values.title,
    values.description ?? null,
    values.start_datetime,
    values.end_datetime ?? null,
    values.all_day ? 1 : 0,
    values.location ?? null,
    values.color ?? null,
    values.icon ?? 'calendar',
    ownsAssignments ? child.assigned_to : (updatedMaster.assigned_to ?? null),
    values.visibility ?? 'all',
    values.countdown ? 1 : 0,
    effectiveAttachment.attachment_name,
    effectiveAttachment.attachment_mime,
    effectiveAttachment.attachment_size,
    effectiveAttachment.attachment_data,
    effectiveAttachment.attachment_document_id,
    child.id,
  );
  if (ownsAttachment) {
    syncOwnedAttachmentAccess(
      database,
      effectiveAttachment.attachment_document_id,
      values.visibility,
      effectiveAssignments,
    );
  }
}

/** Applies a whole-series update with exact-count orphan confirmation. */
export function updateSeriesWithOverrides(database, {
  seriesId,
  actorId,
  isAdmin = false,
  changes = {},
  assignments,
  attachment,
  createAttachment,
  cloneDetachedAttachment,
  reminderOffsets: requestedReminderOffsets,
  confirmedOrphanCount,
  applyUpdate,
  authorizeActor = true,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin, authorizeActor);
    const current = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(master.id);
    const proposed = { ...current };
    for (const field of SERIES_UPDATE_FIELDS) {
      if (Object.hasOwn(changes, field)) proposed[field] = normalizeScalar(field, changes[field]);
    }
    const children = linkedChildren(database, master.id);
    const resolvedById = new Map(children.map((child) => [
      Number(child.id),
      resolveOccurrence(database, child, current),
    ]));
    const currentAssignments = canonicalIds(assignmentIds(database, master.id));
    const proposedAssignments = assignments === undefined
      ? currentAssignments
      : orderedIds(assignments);
    const detachAll = (!hasOutboundTarget(current) && hasOutboundTarget(proposed))
      || (!hasConfiguredOutlookAutoSyncTarget(database, current, currentAssignments)
        && hasConfiguredOutlookAutoSyncTarget(database, proposed, proposedAssignments));
    const orphans = classifyOrphans(children, proposed, detachAll);
    const confirmationSupplied = confirmedOrphanCount !== undefined;
    if ((orphans.length > 0 || confirmationSupplied)
        && confirmedOrphanCount !== orphans.length) {
      throw orphanConflict(orphans.length);
    }

    const detachedCloneRequests = detachedAttachmentCloneRequests(database, orphans, current);
    if (detachedCloneRequests.length > 0 && typeof cloneDetachedAttachment !== 'function') {
      throw new CalendarAttachmentCloneRequiredError(detachedCloneRequests);
    }
    const claimedDocumentIds = new Set([
      Number(current.attachment_document_id),
      ...children.map((child) => Number(child.attachment_document_id)),
    ].filter((documentId) => Number.isInteger(documentId) && documentId > 0));

    for (const child of orphans) {
      materializeDetachedChild(database, child, current, {
        cloneDetachedAttachment,
        claimedDocumentIds,
      });
    }
    if (typeof applyUpdate === 'function') applyUpdate(database, current);
    else applySeriesChanges(database, master.id, changes);
    const updatedAnchor = database.prepare(
      'SELECT start_datetime FROM calendar_events WHERE id = ?'
    ).get(master.id).start_datetime;
    shiftOwnedReminders(database, master.id, current.start_datetime, updatedAnchor);
    if (assignments !== undefined) {
      const userIds = orderedIds(assignments);
      database.prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ?')
        .run(userIds[0] ?? null, master.id);
      replaceAssignments(database, master.id, userIds);
    }
    const createdAttachment = typeof createAttachment === 'function'
      ? createAttachment()
      : attachment;
    if (createdAttachment !== undefined) {
      const values = attachmentValues(createdAttachment);
      database.prepare(`
        UPDATE calendar_events
        SET attachment_name = ?, attachment_mime = ?, attachment_size = ?,
            attachment_data = ?, attachment_document_id = ?
        WHERE id = ?
      `).run(
        values.attachment_name,
        values.attachment_mime,
        values.attachment_size,
        values.attachment_data,
        values.attachment_document_id,
        master.id,
      );
    }
    if (requestedReminderOffsets !== undefined) {
      const anchor = database.prepare('SELECT start_datetime FROM calendar_events WHERE id = ?')
        .get(master.id).start_datetime;
      replaceReminders(
        database,
        master.id,
        actorId,
        anchor,
        canonicalOffsets(requestedReminderOffsets),
      );
      fanOutEventReminders(database, master.id, master.created_by, { dropDerivedWhenOwn: true });
    }
    const updated = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(master.id);
    if (createdAttachment !== undefined) {
      syncOwnedAttachmentAccess(
        database,
        updated.attachment_document_id,
        updated.visibility,
        canonicalIds(assignmentIds(database, master.id)),
      );
    }
    const orphanIds = new Set(orphans.map((child) => Number(child.id)));
    for (const child of children) {
      if (!orphanIds.has(Number(child.id))) {
        refreshInheritedChild(database, child, resolvedById.get(Number(child.id)), updated);
      }
    }

    // A deleted or detached slot stays suppressed even if a temporary rule
    // cannot reach it; a later rule change must not resurrect the master slot.

    return {
      series: loadProjectedEvent(database, master.id),
      orphanedOverrideCount: orphans.length,
    };
  });
}
