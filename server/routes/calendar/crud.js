/**
 * Modul: Kalender (Calendar) - Termin-CRUD (lokale Events)
 * GET /:id, POST /, PUT /:id, POST /:id/reset, POST /:id/exceptions, DELETE /:id.
 */

import { createLogger } from '../../logger.js';
import express from 'express';
import * as db from '../../db.js';
import { str, color, datetime, rrule, collectErrors, MAX_TITLE, MAX_TEXT, DATE_RE } from '../../middleware/validate.js';
import { normalizeVisibility, visibilityWhere } from '../../services/visibility.js';
import { hasAnyOccurrence } from '../../services/recurrence.js';
import { resolveProjectedEventRows } from '../../services/calendar-event-reader.js';
import { utcToWall } from '../../utils/timezone.js';
import {
  StorageError,
  cleanupStagedUpload,
  readDocumentContent,
  stageDocumentUpload,
} from '../../services/document-storage.js';
import { queueEventDeletion, markEventOutbound, flushOutbound } from '../../services/calendar-outbound.js';
import { SOURCE_CALENDAR_COLUMNS, SOURCE_CALENDAR_JOIN } from '../../services/calendar-events.js';
import {
  assertSuccessorHasOccurrence,
  baseOccurrenceFor,
  CalendarAttachmentCloneRequiredError,
  CalendarOccurrenceError,
  deleteOccurrence,
  isEligibleLocalSeries,
  isLocallyOwnedSeries,
  splitSeries,
  truncateSeries,
  upsertOccurrenceOverride,
  updateSeriesWithOverrides,
} from '../../services/calendar-occurrence-overrides.js';
import {
  ASSIGNED_USERS_SQL,
  getUserId,
  isAdminUser,
  eventIcon,
  parseAttachment,
  caldavTarget,
  cloneAttachmentDocument,
  googleTarget,
  outlookTarget,
  createAttachmentDocument,
  parseAssignedTo,
  setEventAssignments,
  serializeEvent,
  sendStorageError,
} from './helpers.js';

const log = createLogger('Calendar');
const router = express.Router();

async function runWithAttachmentClonePlan(database, actorId, stagedClones, operation) {
  try {
    return operation({});
  } catch (error) {
    if (!(error instanceof CalendarAttachmentCloneRequiredError)) throw error;

    const contents = new Map();
    const prepared = [];
    for (const request of error.requests) {
      const sourceDocument = database.prepare('SELECT * FROM family_documents WHERE id = ?')
        .get(request.sourceDocumentId);
      if (!sourceDocument) throw new Error('Attachment clone source document no longer exists.');
      if (!contents.has(request.sourceDocumentId)) {
        contents.set(request.sourceDocumentId, await readDocumentContent(sourceDocument));
      }
      const content = contents.get(request.sourceDocumentId);
      const staged = await stageDocumentUpload({
        buffer: content.buffer,
        mime: content.mime,
        category: sourceDocument.category,
        originalName: sourceDocument.original_name,
      });
      stagedClones.push(staged);
      prepared.push({ request, sourceDocument, staged, used: false });
    }

    const consume = (owner, childId, sourceDocumentId) => {
      const clone = prepared.find((entry) => !entry.used
        && entry.request.owner === owner
        && (owner !== 'detached' || Number(entry.request.childId) === Number(childId))
        && Number(entry.request.sourceDocumentId) === Number(sourceDocumentId));
      if (!clone) throw new Error('No staged attachment clone matches the detached owner.');
      clone.used = true;
      return {
        ...clone.request.attachment,
        attachment_document_id: cloneAttachmentDocument(
          database,
          clone.sourceDocument,
          clone.staged,
          actorId,
        ),
      };
    };

    const result = operation({
      cloneAttachment: (sourceDocumentId) =>
        consume('successor', null, sourceDocumentId),
      cloneDetachedAttachment: (childId, sourceDocumentId) =>
        consume('detached', childId, sourceDocumentId),
    });
    for (const clone of prepared) {
      const index = stagedClones.indexOf(clone.staged);
      if (index >= 0) stagedClones.splice(index, 1);
      if (!clone.used) {
        try {
          await cleanupStagedUpload(clone.staged);
        } catch (cleanupError) {
          log.warn('Unused attachment clone cleanup failed after calendar commit:', cleanupError);
        }
      }
    }
    return result;
  }
}

async function cleanupCalendarUploads(uploads) {
  let firstError = null;
  for (const staged of [...new Set(uploads.filter(Boolean))]) {
    try {
      await cleanupStagedUpload(staged);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

function validateOccurrenceAssignments(database, value) {
  if (value === undefined) return { value: undefined, error: null };
  if (value === null) return { value: [], error: null };
  const ids = Array.isArray(value) ? value : [value];
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) {
    return { value: null, error: 'Zuweisung: Wähle Personen mit gültigen positiven Benutzer-IDs aus.' };
  }
  if (new Set(ids).size !== ids.length) {
    return { value: null, error: 'Zuweisung: Wähle jede Person höchstens einmal aus.' };
  }
  if (ids.length > 0) {
    const found = database.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE id IN (${ids.map(() => '?').join(',')})
    `).get(...ids).count;
    if (Number(found) !== ids.length) {
      return { value: null, error: 'Eine zugewiesene Person existiert nicht mehr. Lade die Personenauswahl erneut.' };
    }
  }
  return { value: ids, error: null };
}

function isPossibleCalendarDateTime(value) {
  const match = String(value).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (parsed.getUTCFullYear() !== Number(year)
      || parsed.getUTCMonth() !== Number(month) - 1
      || parsed.getUTCDate() !== Number(day)) return false;
  if (hour === undefined) return true;
  return Number(hour) <= 23
    && Number(minute) <= 59
    && (second === undefined || Number(second) <= 59)
    && (offsetHour === undefined || Number(offsetHour) <= 23)
    && (offsetMinute === undefined || Number(offsetMinute) <= 59);
}

function validateOccurrenceMutationBody(database, body, { following = false } = {}) {
  const values = {};
  const errors = [];
  const validateString = (field, label, options = {}) => {
    if (!Object.hasOwn(body, field)) return;
    const nullable = options.nullable === true;
    if (body[field] === null && nullable) {
      values[field] = null;
      return;
    }
    if (typeof body[field] !== 'string') {
      errors.push(`${label} muss als Text angegeben werden${nullable ? ' oder leer bleiben' : ''}.`);
      return;
    }
    const result = str(body[field], label, {
      max: options.max,
      required: options.required !== false,
    });
    if (result.error) errors.push(`${label}: Gib einen gültigen Text mit höchstens ${options.max} Zeichen ein.`);
    else values[field] = result.value;
  };
  const validateDateTime = (field, label, { nullable = false } = {}) => {
    if (!Object.hasOwn(body, field)) return;
    if (body[field] === null && nullable) {
      values[field] = null;
      return;
    }
    if (typeof body[field] !== 'string' || body[field].trim() === '') {
      errors.push(`${label}: Gib ein Datum mit optionaler Uhrzeit an${nullable ? ' oder lasse das Feld leer' : ''}.`);
      return;
    }
    const result = datetime(body[field], label, true);
    if (result.error) errors.push(`${label}: Gib ein gültiges Datum mit optionaler Uhrzeit an.`);
    else if (!isPossibleCalendarDateTime(body[field])) {
      errors.push(`${label}: Gib ein gültiges Datum mit optionaler Uhrzeit an.`);
    } else values[field] = result.value;
  };

  validateString('title', 'Titel', { max: MAX_TITLE });
  validateString('description', 'Beschreibung', { max: MAX_TEXT, required: false, nullable: true });
  validateDateTime('start_datetime', 'Startdatum');
  validateDateTime('end_datetime', 'Enddatum', { nullable: true });
  validateString('location', 'Ort', { max: MAX_TITLE, required: false, nullable: true });

  if (Object.hasOwn(body, 'color')) {
    if (body.color !== null && typeof body.color !== 'string') {
      errors.push('Farbe muss als Text angegeben werden oder leer bleiben.');
    } else {
      const result = color(body.color, 'Farbe');
      if (result.error) errors.push('Farbe: Wähle eine gültige Farbe im Format #RRGGBB aus.');
      else values.color = result.value;
    }
  }
  if (following && Object.hasOwn(body, 'recurrence_rule')) {
    if (body.recurrence_rule !== null && typeof body.recurrence_rule !== 'string') {
      errors.push('Die Wiederholungsregel muss als Text angegeben werden oder leer bleiben.');
    } else {
      const result = rrule(body.recurrence_rule, 'Wiederholung');
      if (result.error) errors.push('Die Wiederholungsregel ist ungültig. Prüfe die Wiederholungseinstellungen.');
      else values.recurrence_rule = result.value;
    }
  }
  for (const field of ['all_day', 'countdown']) {
    if (Object.hasOwn(body, field)) {
      if (typeof body[field] !== 'boolean') errors.push(`${field === 'all_day' ? 'Ganztägig' : 'Countdown'} muss aktiviert oder deaktiviert sein (true oder false).`);
      else values[field] = body[field];
    }
  }
  if (Object.hasOwn(body, 'visibility')) {
    if (!['all', 'assignees', 'private'].includes(body.visibility)) {
      errors.push('Sichtbarkeit: Wähle alle Personen, zugewiesene Personen oder privat (all, assignees, private).');
    } else values.visibility = body.visibility;
  }
  const assignments = validateOccurrenceAssignments(database, body.assigned_to);
  if (assignments.error) errors.push(assignments.error);

  return { values, assignments: assignments.value, errors };
}

// --------------------------------------------------------
// GET /api/v1/calendar/:id
// Einzelnen Termin abrufen.
// Response: { data: Event }
// --------------------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const event = db.get().prepare(`
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             u_created.display_name  AS creator_name,
             -- Derselbe Name und dieselbe geerbte Farbe wie im Lesepfad, damit
             -- jede Antwort dieses Moduls dasselbe Event-Objekt liefert:
             -- CalDAV/Google ueber calendar_ref_id, ICS-Abos ueber
             -- subscription_id (#891). Der Name fehlte hier ganz (#1064): die
             -- Zusage dieser Zeilen galt nur der Farbe, und ein frisch
             -- angelegter oder geaenderter Termin kam ohne ihn zurueck.
             COALESCE(ec.name, isub.name)   AS cal_name,
             COALESCE(ec.color, isub.color) AS cal_color,
             ${SOURCE_CALENDAR_COLUMNS},
             COALESCE(bd.name, nd.name) AS birthday_name,
             bd.birth_date AS birthday_date,
             nd.name_day   AS name_day,
             CASE WHEN nd.id IS NOT NULL THEN 'name_day'
                  WHEN bd.id IS NOT NULL THEN 'birthday' END AS birthday_event_kind,
             ${ASSIGNED_USERS_SQL},
             (SELECT hws.id FROM housekeeping_work_sessions hws WHERE hws.calendar_event_id = e.id LIMIT 1) AS housekeeping_visit_id
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
      ${SOURCE_CALENDAR_JOIN}
      LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
      LEFT JOIN birthdays bd ON bd.calendar_event_id = e.id
      LEFT JOIN birthdays nd ON nd.name_day_calendar_event_id = e.id
      WHERE e.id = ?
        AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
    `).get(id, getUserId(req), getUserId(req));

    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    const database = db.get();
    const resolved = resolveProjectedEventRows(database, [event])[0];
    res.json({ data: serializeEvent(resolved, {
      database,
      actorId: getUserId(req),
      isAdmin: isAdminUser(req),
    }) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/calendar
// Neuen Termin anlegen.
// Body: { title, description?, start_datetime, end_datetime?,
//         all_day?, location?, color?, icon?, assigned_to?,
//         recurrence_rule?, countdown? }
// Response: { data: Event }
// --------------------------------------------------------
router.post('/', async (req, res) => {
  let stagedUpload;
  try {
    const userId = getUserId(req);
    if (!userId) {
      log.warn('Rejecting calendar create without resolved authenticated user id', {
        authMethod: req.authMethod || null,
        authUserId: req.authUserId || null,
        reqUserId: req.user?.id || null,
        sessionUserId: req.session?.userId || null,
      });
      return res.status(401).json({ error: 'Not authenticated.', code: 401 });
    }

    const vTitle = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vDesc  = str(req.body.description, 'Beschreibung', { max: MAX_TEXT, required: false });
    const vStart = datetime(req.body.start_datetime, 'Startdatum', true);
    const vEnd   = datetime(req.body.end_datetime, 'Enddatum');
    // Kein Fallback auf eine Palettenfarbe: fehlt die Angabe, bekommt der Termin
    // KEINE eigene Farbe (NULL) und leiht sich die der zugewiesenen Person
    // (#891). `color()` liefert fuer undefined/null/'' bereits value: null.
    const vColor = color(req.body.color, 'Farbe');
    const vIcon  = eventIcon(req.body.icon);
    const vLoc   = str(req.body.location, 'Ort', { max: MAX_TITLE, required: false });
    const vRrule = rrule(req.body.recurrence_rule, 'Wiederholung');
    const vCaldav = caldavTarget(req.body);
    const vGoogle = googleTarget(req.body);
    const vOutlook = outlookTarget(req.body);
    const errors = collectErrors([vTitle, vDesc, vStart, vEnd, vColor, vLoc, vRrule, vCaldav, vGoogle, vOutlook]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!vIcon) return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });

    // EINE SERIE OHNE EIN EINZIGES VORKOMMEN WIRD NICHT GESPEICHERT (#960).
    // `FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120` ab dem 15. Januar nimmt der
    // Validator an, und trotzdem liegt der erste Monatsletzte hinter dem UNTIL:
    // ein Termin, den niemand je zu sehen bekaeme, weder hier noch im Feed.
    //
    // DAS GESPEICHERTE DATUM BLEIBT DAGEGEN, WAS EINGEGEBEN WURDE. Der Server
    // zieht es NICHT auf das erste Vorkommen - er hat es einmal getan, und jede
    // Stelle, die `start_datetime` weiterverarbeitet, ohne davon zu wissen, hat
    // dabei etwas verschoben: die Erinnerung rechnete auf dem alten Tag, ein
    // Titel-Edit bewegte eine eingelesene Serie. Welcher Tag der erste ist,
    // beantwortet die Expansion (`expandRecurringEvents`); nach aussen bleibt
    // das DTSTART damit uneindeutig, das ist bekannt und ein eigener Vorgang.
    if (!hasAnyOccurrence(vStart.value, vRrule.value)) {
      return res.status(400).json({
        error: 'recurrence_rule: the rule has no occurrence on or after the start date.',
        code: 400,
      });
    }

    const { all_day = 0 } = req.body;
    const userIds  = parseAssignedTo(req.body.assigned_to);
    const firstUid = userIds[0] ?? null;

    const attachment = req.body.attachment_data
      ? parseAttachment(req.body.attachment_data)
      : { mime: null, size: null, buffer: null };
    if (attachment.buffer) {
      stagedUpload = await stageDocumentUpload({
        buffer: attachment.buffer,
        mime: attachment.mime,
        category: 'other',
        originalName: req.body.attachment_name || 'Attachment',
      });
    }

    const eventId = db.get().transaction(() => {
      const documentId = createAttachmentDocument(
        db.get(),
        attachment,
        stagedUpload,
        req.body,
        userId
      );
      const result = db.get().prepare(`
        INSERT INTO calendar_events
          (title, description, start_datetime, end_datetime, all_day,
           location, color, icon, assigned_to, created_by, recurrence_rule,
           attachment_name, attachment_mime, attachment_size, attachment_data, attachment_document_id,
           target_caldav_account_id, target_caldav_calendar_url, target_google_calendar_id,
           target_outlook_account_id, target_outlook_calendar_id, visibility,
           countdown)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vTitle.value, vDesc.value,
        vStart.value, vEnd.value,
        all_day ? 1 : 0, vLoc.value,
        vColor.value, vIcon, firstUid,
        userId, vRrule.value,
        req.body.attachment_name || null,
        attachment.mime,
        attachment.size,
        null,
        documentId,
        vCaldav.value.accountId,
        vCaldav.value.calendarUrl,
        vGoogle.value,
        vOutlook.value.accountId,
        vOutlook.value.calendarId,
        normalizeVisibility(req.body.visibility),
        req.body.countdown ? 1 : 0
      );
      setEventAssignments(db.get(), result.lastInsertRowid, userIds);
      return result.lastInsertRowid;
    })();

    const event = db.get().prepare(`
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             u_created.display_name  AS creator_name,
             -- Derselbe Name und dieselbe geerbte Farbe wie im Lesepfad, damit
             -- jede Antwort dieses Moduls dasselbe Event-Objekt liefert:
             -- CalDAV/Google ueber calendar_ref_id, ICS-Abos ueber
             -- subscription_id (#891). Der Name fehlte hier ganz (#1064): die
             -- Zusage dieser Zeilen galt nur der Farbe, und ein frisch
             -- angelegter oder geaenderter Termin kam ohne ihn zurueck.
             COALESCE(ec.name, isub.name)   AS cal_name,
             COALESCE(ec.color, isub.color) AS cal_color,
             ${SOURCE_CALENDAR_COLUMNS},
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
      ${SOURCE_CALENDAR_JOIN}
      LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
      WHERE e.id = ?
    `).get(eventId);

    res.status(201).json({ data: serializeEvent(event, {
      database: db.get(),
      actorId: getUserId(req),
      isAdmin: isAdminUser(req),
      master: event,
    }) });
  } catch (err) {
    if (err instanceof StorageError && !stagedUpload) {
      log.error('POST / storage error:', err);
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    log.error('', err);
    if (stagedUpload) {
      try {
        await cleanupStagedUpload(stagedUpload);
      } catch (cleanupError) {
        log.error('POST / cleanup error after database failure:', cleanupError);
        return sendStorageError(
          res,
          cleanupError,
          'Calendar attachment storage cleanup failed.'
        );
      }
    }
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// Ein Termin, den die aufrufende Person nicht sehen darf, existiert fuer sie
// auch zum Aendern und Loeschen nicht (GHSA-fmrw-mmjw-5v9c). PUT und DELETE
// luden den Termin bisher nur per ID: jedes Mitglied konnte einen fremden
// privaten Termin umschreiben, per `visibility: 'all'` sichtbar machen (die
// Antwort des PUT trug schon Titel und Beschreibung) oder loeschen, waehrend
// GET /:id ihn korrekt verbarg. Dieselbe Klausel wie dort, derselbe 404 wie bei
// den Aufgaben - ein 403 verriete, dass es den Termin gibt. Kein Admin-Bypass,
// wie bei jeder Sichtbarkeitsregel (#474).
function loadVisibleEvent(id, req) {
  const me = getUserId(req);
  return db.get().prepare(`
    SELECT e.* FROM calendar_events e
    WHERE e.id = ?
      AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
  `).get(id, me, me);
}

const CALENDAR_OCCURRENCE_ERRORS = {
  calendar_series_not_found: 'Terminserie nicht gefunden. Lade den Kalender erneut.',
  not_authorized: 'Du darfst diese Terminserie nicht bearbeiten.',
  ineligible_series: 'Einzelausnahmen sind nur für lokale Terminserien ohne aktive externe Synchronisierung verfügbar. Hat eine lokale Serie bereits verknüpfte Einzelausnahmen, deaktiviere zuerst ihren Outlook-Zielkalender. Danach kannst du sie wieder bearbeiten, ohne Ausnahmen zu löschen.',
  invalid_recurrence_id: 'Der ausgewählte Serientermin gehört nicht zu diesem Datum. Lade den Kalender erneut und wähle den Termin noch einmal aus.',
  invalid_override_fields: 'Die Angaben zur Einzelausnahme sind ungültig. Prüfe die geänderten Felder.',
  invalid_occurrence_interval: 'Das Ende darf nicht vor dem Beginn liegen. Prüfe Datum und Uhrzeit der Einzelausnahme.',
  calendar_override_orphans: 'Die Änderung benötigt eine aktuelle Bestätigung. Prüfe die Anzahl der betroffenen Einzelausnahmen und bestätige, dass sie als eigenständige Termine erhalten bleiben sollen.',
  calendar_occurrence_route_required: 'Öffne den Serientermin im Kalender und wähle den gewünschten Änderungsumfang, um diese Einzelausnahme zu bearbeiten.',
  empty_successor_series: 'Die Folgeserie enthält ab ihrem Startdatum keinen Termin. Passe das Startdatum oder die Wiederholungsregel an.',
  invalid_successor_override: 'Eine Einzelausnahme passt nicht zur Folgeserie. Prüfe die Wiederholungsregel und die betroffene Einzelausnahme.',
};

function sendCalendarOccurrenceError(res, error) {
  return res.status(error.status).json({
    error: CALENDAR_OCCURRENCE_ERRORS[error.code] || 'Die Einzelausnahme konnte nicht geändert werden. Lade den Kalender erneut und prüfe deine Angaben.',
    code: error.status,
    ...(error.conflict ? { conflict: error.conflict } : { reason: error.code }),
    ...(error.orphanedOverrideCount !== undefined
      ? { orphaned_override_count: error.orphanedOverrideCount }
      : {}),
  });
}

function rejectLinkedOccurrenceResource(res, event, req) {
  if (event.recurrence_parent_id == null) return false;
  const parent = loadVisibleEvent(Number(event.recurrence_parent_id), req);
  if (!parent) {
    sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
      'Calendar series not found.',
      { status: 404, code: 'calendar_series_not_found' },
    ));
    return true;
  }
  const eligibility = isEligibleLocalSeries(
    db.get(),
    parent,
    getUserId(req),
  );
  if (!eligibility.eligible) {
    const unauthorized = eligibility.reason === 'not_authorized';
    sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
      unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
      { status: unauthorized ? 403 : 400, code: eligibility.reason },
    ));
    return true;
  }
  sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
    'Use the occurrence endpoint to modify a linked recurring occurrence.',
    { status: 400, code: 'calendar_occurrence_route_required' },
  ));
  return true;
}

// --------------------------------------------------------
// PUT /api/v1/calendar/:id
// Termin vollständig aktualisieren.
// Body: alle Felder optional außer title + start_datetime
// Response: { data: Event }
// --------------------------------------------------------
router.put('/:id', async (req, res) => {
  let stagedUpload;
  const stagedClones = [];
  try {
    const id    = parseInt(req.params.id, 10);
    const event = loadVisibleEvent(id, req);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    if (rejectLinkedOccurrenceResource(res, event, req)) return;

    const checks = [];
    if (req.body.title          !== undefined) checks.push(str(req.body.title, 'Titel', { max: MAX_TITLE, required: false }));
    if (req.body.description    !== undefined) checks.push(str(req.body.description, 'Beschreibung', { max: MAX_TEXT, required: false }));
    if (req.body.start_datetime !== undefined) checks.push(datetime(req.body.start_datetime, 'Startdatum'));
    if (req.body.end_datetime   !== undefined) checks.push(datetime(req.body.end_datetime, 'Enddatum'));
    if (req.body.color          !== undefined) checks.push(color(req.body.color, 'Farbe'));
    if (req.body.location       !== undefined) checks.push(str(req.body.location, 'Ort', { max: MAX_TITLE, required: false }));
    // Der unveränderte Bestandswert kommt ohne Prüfung durch: Die Regel steht
    // bereits so in der Datenbank, und der Validator kennt nur das Vokabular der
    // eigenen Oberfläche (FREQ/INTERVAL/BYDAY/UNTIL/COUNT, ohne „RRULE:"-Präfix).
    // Eine aus CalDAV eingelesene Serie trägt regelmäßig mehr als das - Präfix,
    // WKST, BYMONTHDAY. Ohne diese Ausnahme scheiterte jede Änderung an einem
    // anderen Feld (Zuweisung, Titel) an der Wiederholung, die der Nutzer gar
    // nicht angefasst hat (#756). Geändert wird weiterhin nur, was der Validator
    // zulässt.
    if (req.body.recurrence_rule !== undefined
        && req.body.recurrence_rule !== event.recurrence_rule) {
      checks.push(rrule(req.body.recurrence_rule, 'Wiederholung'));
    }
    // CalDAV-Ziel nur prüfen, wenn der Client es mitschickt; sonst bestehenden Wert behalten.
    const caldavProvided = req.body.target_caldav_account_id !== undefined
      || req.body.target_caldav_calendar_url !== undefined;
    const vCaldav = caldavProvided ? caldavTarget(req.body) : null;
    if (vCaldav) checks.push(vCaldav);
    // Google-Ziel nur prüfen, wenn der Client es mitschickt; sonst bestehenden Wert behalten.
    const googleProvided = req.body.target_google_calendar_id !== undefined;
    const vGoogle = googleProvided ? googleTarget(req.body) : null;
    if (vGoogle) checks.push(vGoogle);
    // Outlook-Ziel nur prüfen, wenn der Client es mitschickt; sonst bestehenden Wert behalten.
    const outlookProvided = req.body.target_outlook_account_id !== undefined
      || req.body.target_outlook_calendar_id !== undefined;
    const vOutlook = outlookProvided ? outlookTarget(req.body) : null;
    if (vOutlook) checks.push(vOutlook);
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (event.recurrence_rule && req.body.confirmed_orphan_count !== undefined
        && (!Number.isInteger(req.body.confirmed_orphan_count)
          || req.body.confirmed_orphan_count < 0)) {
      return res.status(400).json({
        error: 'Die bestätigte Anzahl der betroffenen Einzelausnahmen muss eine ganze Zahl ab 0 sein. Prüfe die aktuelle Anzahl und bestätige erneut.',
        code: 400,
      });
    }
    const vIcon = req.body.icon !== undefined ? eventIcon(req.body.icon) : event.icon;
    if (!vIcon) return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });
    if (
      req.body.remove_attachment !== undefined
      && typeof req.body.remove_attachment !== 'boolean'
    ) {
      return res.status(400).json({
        error: 'remove_attachment: muss ein Boolean sein.',
        code: 400,
      });
    }
    const {
      title, description, start_datetime, end_datetime,
      all_day, location, color: colorVal, recurrence_rule,
    } = req.body;

    // AUCH BEIM BEARBEITEN DARF KEINE LEERE SERIE ENTSTEHEN (#960) - aber nur
    // dann abweisen, wenn DIESE Anfrage sie leer macht.
    //
    // NICHT DIE ANWESENHEIT DER FELDER PRUEFEN, SONDERN IHRE WERTE. Beide
    // Formulare schicken bei jedem Speichern das ganze Objekt mit
    // (`public/pages/calendar.js`, `public/pages/tasks.js`); "hat der Aufrufer
    // das Feld geschickt?" ist deshalb immer wahr und taugt nicht als Frage.
    // Wer nur den Titel aendert, wuerde sonst an einer eingelesenen Serie
    // scheitern, die schon vorher kein Vorkommen hatte - ein Datensatz, den
    // niemand mehr bearbeiten koennte.
    //
    // `null` heisst dabei "nicht anfassen", nicht "leer": der Validator laesst
    // es durch, und das UPDATE unten behandelt es ueber COALESCE ebenso. Der
    // Tagesvergleich reicht, weil `hasAnyOccurrence` ohnehin nur den Tag liest.
    // DIESELBE FORMEL WIE DAS UPDATE UNTEN, sonst prueft der Guard einen
    // Zustand, den es nie geben wird. `recurrence_rule` steht NICHT unter
    // COALESCE: `null` loescht die Regel, statt sie stehen zu lassen. Wer die
    // Wiederholung abschaltet und dabei das Startdatum aendert, wurde sonst
    // gegen die ALTE Regel geprueft und mit 400 abgewiesen - fuer eine Serie,
    // die es nach dem Speichern gar nicht mehr gibt.
    const regelDanach = recurrence_rule !== undefined
      ? (recurrence_rule || null)
      : event.recurrence_rule;
    const startDanach = start_datetime !== undefined && start_datetime !== null
      ? start_datetime
      : event.start_datetime;
    const serieBeruehrt = regelDanach !== event.recurrence_rule
      || String(startDanach ?? '').slice(0, 10) !== String(event.start_datetime ?? '').slice(0, 10);
    // DER GUARD MUSS DENSELBEN KALENDERTAG MEINEN WIE DIE EXPANSION. Ein
    // eingelesener Termin kann eine eigene Zone tragen: 31. Januar 20:00 in New
    // York steht als 1. Februar 01:00 UTC in der Zeile. Fuer "am letzten Tag des
    // Monats" zaehlt der Ortstag, also der 31. - ohne den Hinweis sah der Guard
    // den Ersten, hielt die Serie fuer leer und wies eine gueltige Bearbeitung
    // mit 400 ab. `expandRecurringEvents` nimmt die Pruefung im selben Fall
    // zurueck (`zonenUnsicher`); nur `tzid` kann diesen Zustand erzeugen, die
    // Route selbst nimmt das Feld nicht entgegen.
    const wandUhr = event.tzid ? utcToWall(String(startDanach ?? ''), event.tzid) : null;
    const zonenUnsicher = !!event.tzid
      && !(wandUhr && wandUhr.date === String(startDanach ?? '').slice(0, 10));
    if (serieBeruehrt
      && !hasAnyOccurrence(startDanach, regelDanach, { utcDiffersFromLocal: zonenUnsicher })) {
      return res.status(400).json({
        error: 'recurrence_rule: the rule has no occurrence on or after the start date.',
        code: 400,
      });
    }

    // JEDE ABWEISUNG GEHOERT VOR DAS STAGING. Ab hier laedt
    // `stageDocumentUpload` den Anhang in den Speicher (lokaler Ordner, WebDAV
    // oder Cloud); aufgeraeumt wird er nur im catch-Block ganz unten. Ein
    // fruehes `return` dazwischen laesst die hochgeladene Datei als Waise
    // liegen - sichtbar wird das nie, weil der Aufrufer seine 400 bekommt.
    // Der Serien-Guard oben stand genau deshalb schon einmal falsch herum.
    const attachmentDataProvided = Object.hasOwn(req.body, 'attachment_data');
    const replacementRequested = typeof req.body.attachment_data === 'string'
      && req.body.attachment_data.trim() !== '';
    const removalRequested = req.body.remove_attachment === true
      || (attachmentDataProvided && req.body.attachment_data === null);
    if (replacementRequested && removalRequested) {
      return res.status(400).json({
        error: 'attachment_data und remove_attachment widersprechen sich.',
        code: 400,
      });
    }
    const attachment = replacementRequested
      ? parseAttachment(req.body.attachment_data)
      : null;
    if (attachment?.buffer) {
      stagedUpload = await stageDocumentUpload({
        buffer: attachment.buffer,
        mime: attachment.mime,
        category: 'other',
        originalName: req.body.attachment_name || 'Attachment',
      });
    }

    // `color` ueberhaupt mitgeschickt? Nur dann wird die Spalte angefasst - der
    // Wert selbst darf dann auch null sein und heisst "keine eigene Farbe" (#891).
    const colorTouched = Object.hasOwn(req.body, 'color');

    const assignedTouched = req.body.assigned_to !== undefined;
    const userIds  = assignedTouched
      ? parseAssignedTo(req.body.assigned_to)
      : db.get().prepare('SELECT user_id FROM event_assignments WHERE event_id = ?')
          .all(id).map((r) => r.user_id);

    // `assigned_to` ist die PRIMAERE Zuweisung, nicht bloss die erste Zeile: das
    // Formular schickt seine Reihenfolge mit, und `userIds[0]` traegt sie. Beim
    // Nachladen oben gibt es diese Reihenfolge aber nicht - die Abfrage hat kein
    // `ORDER BY`, ihre Reihenfolge ist die der `event_assignments`-Zeilen. Ein
    // PUT, das `assigned_to` gar nicht mitschickt (der Serien-Split etwa sendet
    // nur `recurrence_rule`), wuerde die primaere Zuweisung sonst auf gut Glueck
    // neu bestimmen und dabei still auf ein anderes Mitglied umlegen.
    //
    // Seit #891 ist das sichtbar: `resolveEventColor()` nimmt die Farbe der in
    // `assigned_to` genannten Person, ein Termin ohne eigene Farbe wechselt also
    // die Farbe, ohne dass jemand die Zuweisung angefasst hat. Dieselbe Regel wie
    // bei `color`: nicht mitgeschickt heisst nicht angefasst.
    const firstUid = assignedTouched
      ? (userIds[0] ?? null)
      : (userIds.includes(event.assigned_to) ? event.assigned_to : (userIds[0] ?? null));

    const userModified = event.external_source !== 'local' ? 1 : event.user_modified;

    // Die Farbe führt ihren eigenen Zustand (#899). `user_modified` bedeutet
    // "an diesem Termin wurde etwas bearbeitet" und wird oben bei JEDEM Feld
    // gesetzt; der Inbound der Anbieter las es trotzdem als "die Farbe wird ab
    // jetzt lokal geführt". Eine Titeländerung fror damit die Farbspalte
    // dauerhaft ein - eine Umfärbung auf dem Server kam nie mehr an.
    //
    // Gesetzt wird deshalb nur bei einer ECHTEN Umfärbung: `color` mitgeschickt
    // UND ein anderer Wert als bisher. Ein Formular, das die unveränderte Farbe
    // brav mitschickt, ist keine. Einmal gesetzt bleibt das Flag stehen, auch
    // wenn die Farbe später wieder geleert wird - genau dieser Zustand
    // (`color IS NULL AND color_modified = 1`) ist das ausdrückliche Leeren, das
    // der Ausgang spiegeln darf.
    //
    // Verglichen wird ohne Rücksicht auf die Schreibweise: `#ff6347` und
    // `#FF6347` sind dieselbe Farbe, und die beiden treffen wirklich
    // aufeinander - der Sync legt seinen Hex in Großbuchstaben ab
    // (`utils/ical-color.js`). Der Farbwähler im Client vergleicht aus
    // demselben Grund über `sameColor()`.
    const asColorKey = (c) => (c == null ? null : String(c).toLowerCase());
    const colorModified = (colorTouched && asColorKey(colorVal) !== asColorKey(event.color))
      ? 1
      : event.color_modified;

    const caldavAccountId = vCaldav ? vCaldav.value.accountId : event.target_caldav_account_id;
    const caldavCalendarUrl = vCaldav ? vCaldav.value.calendarUrl : event.target_caldav_calendar_url;
    const googleTargetId = vGoogle ? vGoogle.value : event.target_google_calendar_id;
    const outlookAccountId = vOutlook ? vOutlook.value.accountId : event.target_outlook_account_id;
    const outlookCalendarId = vOutlook ? vOutlook.value.calendarId : event.target_outlook_calendar_id;

    const applyUpdate = () => {
      const documentId = replacementRequested
        ? createAttachmentDocument(
            db.get(),
            attachment,
            stagedUpload,
            req.body,
            event.created_by
          )
        : removalRequested
          ? null
          : event.attachment_document_id;
      const attachmentName = replacementRequested
        ? (req.body.attachment_name || 'Attachment')
        : removalRequested
          ? null
          : event.attachment_name;
      const attachmentMime = replacementRequested
        ? attachment.mime
        : removalRequested
          ? null
          : event.attachment_mime;
      const attachmentSize = replacementRequested
        ? attachment.size
        : removalRequested
          ? null
          : event.attachment_size;
      const attachmentData = replacementRequested || removalRequested
        ? null
        : event.attachment_data;
      db.get().prepare(`
        UPDATE calendar_events
        SET title           = COALESCE(?, title),
            description     = ?,
            start_datetime  = COALESCE(?, start_datetime),
            end_datetime    = ?,
            all_day         = COALESCE(?, all_day),
            location        = ?,
            -- Nicht COALESCE: der Wert NULL ist hier eine AUSSAGE ("dieser Termin
            -- hat keine eigene Farbe", #891) und kein fehlender Parameter.
            -- COALESCE kann beides nicht auseinanderhalten und wuerde die
            -- Loeschung schlucken. Der Schalter traegt die Unterscheidung, die
            -- der Body macht: color fehlt = nicht angefasst, color: null =
            -- ausdruecklich geleert. Damit bleibt die Regel der Nachbarfelder
            -- erhalten - das PUT eines Clients, der das Feld nicht kennt, darf
            -- eine gesetzte Farbe nicht stillschweigend loeschen.
            color           = CASE WHEN ? THEN ? ELSE color END,
            icon            = COALESCE(?, icon),
            assigned_to     = ?,
            recurrence_rule = ?,
            attachment_name = ?,
            attachment_mime  = ?,
            attachment_size  = ?,
            attachment_data  = ?,
            attachment_document_id = ?,
            target_caldav_account_id   = ?,
            target_caldav_calendar_url = ?,
            target_google_calendar_id  = ?,
            target_outlook_account_id  = ?,
            target_outlook_calendar_id = ?,
            visibility      = ?,
            -- Anzeigeeinstellung, kein gespiegeltes Feld (#647): sie steht nicht
            -- in MIRRORED_FIELDS und löst deshalb keinen Push aus. Wie bei den
            -- Nachbarfeldern gilt „nicht mitgeschickt" als „nicht angefasst" -
            -- das PUT eines Clients, der das Feld nicht kennt (Modul, ältere
            -- App), darf eine gesetzte Markierung nicht stillschweigend löschen.
            countdown       = ?,
            user_modified   = ?,
            color_modified  = ?
        WHERE id = ?
      `).run(
        title?.trim()  ?? null,
        description !== undefined ? (description || null) : event.description,
        start_datetime ?? null,
        end_datetime !== undefined ? (end_datetime || null) : event.end_datetime,
        all_day !== undefined ? (all_day ? 1 : 0) : null,
        location !== undefined ? (location || null) : event.location,
        colorTouched ? 1 : 0, colorVal ?? null,
        req.body.icon !== undefined ? vIcon : null,
        firstUid !== undefined ? firstUid : event.assigned_to,
        recurrence_rule !== undefined ? (recurrence_rule || null) : event.recurrence_rule,
        attachmentName,
        attachmentMime,
        attachmentSize,
        attachmentData,
        documentId,
        caldavAccountId,
        caldavCalendarUrl,
        googleTargetId,
        outlookAccountId,
        outlookCalendarId,
        req.body.visibility !== undefined
          ? normalizeVisibility(req.body.visibility, event.visibility)
          : event.visibility,
        req.body.countdown !== undefined ? (req.body.countdown ? 1 : 0) : event.countdown,
        userModified,
        colorModified,
        id
      );
      setEventAssignments(db.get(), id, userIds);
    };

    const linkedOverrideCount = db.get().prepare(`
      SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?
    `).get(id).count;
    const occurrenceBoundaryTouched = Boolean(event.recurrence_rule) && [
      'start_datetime',
      'recurrence_rule',
      'target_google_calendar_id',
      'target_caldav_account_id',
      'target_caldav_calendar_url',
      'target_outlook_account_id',
      'target_outlook_calendar_id',
    ].some((field) => Object.hasOwn(req.body, field));
    const canUseOccurrenceTransaction = occurrenceBoundaryTouched
      && isEligibleLocalSeries(
        db.get(),
        event,
        getUserId(req),
      ).eligible;
    if (linkedOverrideCount > 0
        || (event.recurrence_rule && Object.hasOwn(req.body, 'confirmed_orphan_count'))
        || canUseOccurrenceTransaction) {
      const seriesChanges = {};
      if (title !== undefined) seriesChanges.title = title?.trim() || null;
      if (description !== undefined) seriesChanges.description = description || null;
      if (start_datetime !== undefined) seriesChanges.start_datetime = start_datetime;
      if (end_datetime !== undefined) seriesChanges.end_datetime = end_datetime || null;
      if (all_day !== undefined) seriesChanges.all_day = all_day ? 1 : 0;
      if (location !== undefined) seriesChanges.location = location || null;
      if (colorTouched) seriesChanges.color = colorVal ?? null;
      if (req.body.icon !== undefined) seriesChanges.icon = vIcon;
      if (recurrence_rule !== undefined) seriesChanges.recurrence_rule = recurrence_rule || null;
      if (caldavProvided) {
        seriesChanges.target_caldav_account_id = caldavAccountId;
        seriesChanges.target_caldav_calendar_url = caldavCalendarUrl;
      }
      if (googleProvided) seriesChanges.target_google_calendar_id = googleTargetId;
      if (outlookProvided) {
        seriesChanges.target_outlook_account_id = outlookAccountId;
        seriesChanges.target_outlook_calendar_id = outlookCalendarId;
      }
      if (req.body.visibility !== undefined) {
        seriesChanges.visibility = normalizeVisibility(req.body.visibility, event.visibility);
      }
      if (req.body.countdown !== undefined) seriesChanges.countdown = req.body.countdown ? 1 : 0;
      await runWithAttachmentClonePlan(
        db.get(),
        event.created_by,
        stagedClones,
        (cloneOptions) => updateSeriesWithOverrides(db.get(), {
          seriesId: id,
          actorId: getUserId(req),
          isAdmin: isAdminUser(req),
          changes: seriesChanges,
          assignments: assignedTouched ? userIds : undefined,
          confirmedOrphanCount: req.body.confirmed_orphan_count,
          applyUpdate,
          authorizeActor: false,
          ...cloneOptions,
        }),
      );
    } else {
      db.get().transaction(applyUpdate)();
    }
    stagedUpload = null;

    // Änderung an einem synchronisierten Termin beim Provider nachziehen (#593):
    // geänderte Felder als Patch, ein gewechselter Zielkalender als Umzug.
    // Wie beim Löschen: vormerken, antworten, danach best effort ausführen.
    // Vorgemerkt wird VOR dem Lesen der Antwort: deren Quelle folgt einem
    // anstehenden Umzug, und ohne ihn filterte die Seite den Termin bis zum
    // nächsten Laden weiter als Teil des alten Kalenders (#1064).
    const pending = markEventOutbound(
      event,
      db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id),
    );

    const updated = db.get().prepare(`
      SELECT e.*,
             u_assigned.display_name AS assigned_name,
             u_assigned.avatar_color AS assigned_color,
             u_created.display_name  AS creator_name,
             -- Derselbe Name und dieselbe geerbte Farbe wie im Lesepfad, damit
             -- jede Antwort dieses Moduls dasselbe Event-Objekt liefert:
             -- CalDAV/Google ueber calendar_ref_id, ICS-Abos ueber
             -- subscription_id (#891). Der Name fehlte hier ganz (#1064): die
             -- Zusage dieser Zeilen galt nur der Farbe, und ein frisch
             -- angelegter oder geaenderter Termin kam ohne ihn zurueck.
             COALESCE(ec.name, isub.name)   AS cal_name,
             COALESCE(ec.color, isub.color) AS cal_color,
             ${SOURCE_CALENDAR_COLUMNS},
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
      ${SOURCE_CALENDAR_JOIN}
      LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
      WHERE e.id = ?
    `).get(id);

    res.json({ data: serializeEvent(updated, {
      database: db.get(),
      actorId: getUserId(req),
      isAdmin: isAdminUser(req),
      master: updated,
    }) });

    if (pending) {
      flushOutbound()
        .catch((e) => log.warn('Änderung vorgemerkt, Sofortversuch fehlgeschlagen:', e.message));
    }
  } catch (err) {
    const staged = [stagedUpload, ...stagedClones].filter(Boolean);
    if (err instanceof CalendarOccurrenceError && staged.length === 0) {
      return sendCalendarOccurrenceError(res, err);
    }
    if (err instanceof StorageError && staged.length === 0) {
      log.error('PUT /:id storage error:', err);
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    log.error('', err);
    if (staged.length > 0) {
      try {
        await cleanupCalendarUploads(staged);
      } catch (cleanupError) {
        log.error('PUT /:id cleanup error after database failure:', cleanupError);
        return sendStorageError(
          res,
          cleanupError,
          'Calendar attachment storage cleanup failed.'
        );
      }
    }
    if (err instanceof StorageError) {
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/calendar/:seriesId/occurrences/:recurrenceId
// Creates or updates one linked local recurrence replacement atomically.
// --------------------------------------------------------
router.put('/:seriesId/occurrences/:recurrenceId', async (req, res) => {
  let stagedUpload;
  try {
    const seriesId = parseInt(req.params.seriesId, 10);
    const actorId = getUserId(req);
    const isAdmin = isAdminUser(req);
    const master = Number.isInteger(seriesId) ? loadVisibleEvent(seriesId, req) : null;
    if (!master) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'Calendar series not found.',
        { status: 404, code: 'calendar_series_not_found' },
      ));
    }
    const eligibility = isEligibleLocalSeries(db.get(), master, actorId);
    if (!eligibility.eligible) {
      const unauthorized = eligibility.reason === 'not_authorized';
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
        { status: unauthorized ? 403 : 400, code: eligibility.reason },
      ));
    }
    baseOccurrenceFor(master, req.params.recurrenceId);

    const mutation = validateOccurrenceMutationBody(db.get(), req.body);
    const { values: validated, errors } = mutation;
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const vIcon = req.body.icon !== undefined ? eventIcon(req.body.icon) : undefined;
    if (req.body.icon !== undefined && !vIcon) {
      return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });
    }
    if (req.body.remove_attachment !== undefined && typeof req.body.remove_attachment !== 'boolean') {
      return res.status(400).json({ error: 'remove_attachment: muss ein Boolean sein.', code: 400 });
    }
    if (req.body.reminder_offsets !== undefined
        && (!Array.isArray(req.body.reminder_offsets)
          || req.body.reminder_offsets.length > 5
          || new Set(req.body.reminder_offsets).size !== req.body.reminder_offsets.length
          || req.body.reminder_offsets.some((value) =>
            !Number.isInteger(value) || value < 0))) {
      return res.status(400).json({
        error: 'Erinnerungen: Wähle höchstens fünf unterschiedliche Vorlaufzeiten in ganzen Minuten ab 0.',
        code: 400,
      });
    }

    const attachmentDataProvided = Object.hasOwn(req.body, 'attachment_data');
    const replacementRequested = typeof req.body.attachment_data === 'string'
      && req.body.attachment_data.trim() !== '';
    const removalRequested = req.body.remove_attachment === true
      || (attachmentDataProvided && req.body.attachment_data === null);
    if (replacementRequested && removalRequested) {
      return res.status(400).json({
        error: 'attachment_data und remove_attachment widersprechen sich.',
        code: 400,
      });
    }
    const parsedAttachment = replacementRequested
      ? parseAttachment(req.body.attachment_data)
      : null;
    if (parsedAttachment?.buffer) {
      stagedUpload = await stageDocumentUpload({
        buffer: parsedAttachment.buffer,
        mime: parsedAttachment.mime,
        category: 'other',
        originalName: req.body.attachment_name || 'Attachment',
      });
    }

    const changes = {};
    for (const field of [
      'title', 'description', 'start_datetime', 'end_datetime', 'all_day',
      'location', 'color', 'visibility', 'countdown',
    ]) {
      if (Object.hasOwn(req.body, field)) {
        changes[field] = validated[field];
      }
    }
    if (vIcon !== undefined) changes.icon = vIcon;

    const result = upsertOccurrenceOverride(db.get(), {
      seriesId,
      recurrenceId: req.params.recurrenceId,
      actorId,
      isAdmin,
      changes,
      assignments: mutation.assignments,
      attachment: removalRequested ? null : undefined,
      createAttachment: replacementRequested
        ? () => ({
            attachment_name: req.body.attachment_name || 'Attachment',
            attachment_mime: parsedAttachment.mime,
            attachment_size: parsedAttachment.size,
            attachment_data: null,
            attachment_document_id: createAttachmentDocument(
              db.get(),
              parsedAttachment,
              stagedUpload,
              req.body,
              master.created_by,
            ),
          })
        : undefined,
      reminderOffsets: req.body.reminder_offsets === undefined
        ? undefined
        : [...new Set(req.body.reminder_offsets)],
    });

    res.json({
      data: serializeEvent(result.event, {
        database: db.get(),
        actorId,
        isAdmin,
        master,
      }),
    });
  } catch (err) {
    if (err instanceof CalendarOccurrenceError && !stagedUpload) {
      return sendCalendarOccurrenceError(res, err);
    }
    if (err instanceof StorageError && !stagedUpload) {
      log.error('PUT occurrence storage error:', err);
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    log.error('PUT occurrence failed:', err);
    if (stagedUpload) {
      try {
        await cleanupStagedUpload(stagedUpload);
      } catch (cleanupError) {
        log.error('PUT occurrence cleanup error after database failure:', cleanupError);
        return sendStorageError(
          res,
          cleanupError,
          'Calendar attachment storage cleanup failed.',
        );
      }
    }
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.put('/:seriesId/occurrences/:recurrenceId/following', async (req, res) => {
  let stagedUpload;
  const stagedClones = [];
  try {
    const seriesId = parseInt(req.params.seriesId, 10);
    const actorId = getUserId(req);
    const isAdmin = isAdminUser(req);
    const master = Number.isInteger(seriesId) ? loadVisibleEvent(seriesId, req) : null;
    if (!master) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'Calendar series not found.',
        { status: 404, code: 'calendar_series_not_found' },
      ));
    }
    const eligibility = isEligibleLocalSeries(db.get(), master, actorId);
    if (!eligibility.eligible) {
      const unauthorized = eligibility.reason === 'not_authorized';
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
        { status: unauthorized ? 403 : 400, code: eligibility.reason },
      ));
    }
    const selectedBase = baseOccurrenceFor(master, req.params.recurrenceId);

    const mutation = validateOccurrenceMutationBody(db.get(), req.body, { following: true });
    const { values: validated } = mutation;
    const caldavProvided = req.body.target_caldav_account_id !== undefined
      || req.body.target_caldav_calendar_url !== undefined;
    const googleProvided = req.body.target_google_calendar_id !== undefined;
    const outlookProvided = req.body.target_outlook_account_id !== undefined
      || req.body.target_outlook_calendar_id !== undefined;
    const vCaldav = caldavProvided ? caldavTarget(req.body) : null;
    const vGoogle = googleProvided ? googleTarget(req.body) : null;
    const vOutlook = outlookProvided ? outlookTarget(req.body) : null;
    const errors = [
      ...mutation.errors,
      ...[vCaldav, vGoogle, vOutlook].filter(Boolean),
    ].flatMap((result) => typeof result === 'string' ? [result] : (result.error ? [result.error] : []));
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const vIcon = req.body.icon !== undefined ? eventIcon(req.body.icon) : undefined;
    if (req.body.icon !== undefined && !vIcon) {
      return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });
    }
    if (req.body.remove_attachment !== undefined && typeof req.body.remove_attachment !== 'boolean') {
      return res.status(400).json({ error: 'remove_attachment: muss ein Boolean sein.', code: 400 });
    }
    if (req.body.confirmed_orphan_count !== undefined
        && (!Number.isInteger(req.body.confirmed_orphan_count)
          || req.body.confirmed_orphan_count < 0)) {
      return res.status(400).json({
        error: 'Die bestätigte Anzahl der betroffenen Einzelausnahmen muss eine ganze Zahl ab 0 sein. Prüfe die aktuelle Anzahl und bestätige erneut.',
        code: 400,
      });
    }
    if (req.body.reminder_offsets !== undefined
        && (!Array.isArray(req.body.reminder_offsets)
          || req.body.reminder_offsets.length > 5
          || new Set(req.body.reminder_offsets).size !== req.body.reminder_offsets.length
          || req.body.reminder_offsets.some((value) =>
            !Number.isInteger(value) || value < 0))) {
      return res.status(400).json({
        error: 'Erinnerungen: Wähle höchstens fünf unterschiedliche Vorlaufzeiten in ganzen Minuten ab 0.',
        code: 400,
      });
    }

    assertSuccessorHasOccurrence({
      ...master,
      start_datetime: validated.start_datetime ?? selectedBase.start_datetime,
      recurrence_rule: Object.hasOwn(req.body, 'recurrence_rule')
        ? validated.recurrence_rule
        : master.recurrence_rule,
    });

    const replacementRequested = typeof req.body.attachment_data === 'string'
      && req.body.attachment_data.trim() !== '';
    const removalRequested = req.body.remove_attachment === true
      || (Object.hasOwn(req.body, 'attachment_data') && req.body.attachment_data === null);
    if (replacementRequested && removalRequested) {
      return res.status(400).json({
        error: 'attachment_data und remove_attachment widersprechen sich.',
        code: 400,
      });
    }
    const parsedAttachment = replacementRequested
      ? parseAttachment(req.body.attachment_data)
      : null;
    if (parsedAttachment?.buffer) {
      stagedUpload = await stageDocumentUpload({
        buffer: parsedAttachment.buffer,
        mime: parsedAttachment.mime,
        category: 'other',
        originalName: req.body.attachment_name || 'Attachment',
      });
    }

    const changes = {};
    for (const field of [
      'title', 'description', 'start_datetime', 'end_datetime', 'all_day',
      'location', 'color', 'visibility', 'countdown', 'recurrence_rule',
    ]) {
      if (Object.hasOwn(req.body, field)) {
        changes[field] = validated[field];
      }
    }
    if (caldavProvided) {
      changes.target_caldav_account_id = vCaldav.value.accountId;
      changes.target_caldav_calendar_url = vCaldav.value.calendarUrl;
    }
    if (googleProvided) changes.target_google_calendar_id = vGoogle.value;
    if (outlookProvided) {
      changes.target_outlook_account_id = vOutlook.value.accountId;
      changes.target_outlook_calendar_id = vOutlook.value.calendarId;
    }
    if (vIcon !== undefined) changes.icon = vIcon;
    const commonOptions = {
      seriesId,
      recurrenceId: req.params.recurrenceId,
      actorId,
      isAdmin,
      changes,
      assignments: mutation.assignments,
      attachment: removalRequested ? null : undefined,
      createAttachment: replacementRequested
        ? () => ({
            attachment_name: req.body.attachment_name || 'Attachment',
            attachment_mime: parsedAttachment.mime,
            attachment_size: parsedAttachment.size,
            attachment_data: null,
            attachment_document_id: createAttachmentDocument(
              db.get(),
              parsedAttachment,
              stagedUpload,
              req.body,
              master.created_by,
            ),
          })
        : undefined,
      reminderOffsets: req.body.reminder_offsets === undefined
        ? undefined
        : [...new Set(req.body.reminder_offsets)],
      confirmedOrphanCount: req.body.confirmed_orphan_count,
    };
    const result = await runWithAttachmentClonePlan(
      db.get(),
      master.created_by,
      stagedClones,
      (cloneOptions) => splitSeries(db.get(), { ...commonOptions, ...cloneOptions }),
    );
    stagedUpload = null;
    res.status(result.wholeSeries ? 200 : 201).json({
      data: serializeEvent(result.series, {
        database: db.get(),
        actorId,
        isAdmin,
      }),
    });
  } catch (err) {
    const staged = [stagedUpload, ...stagedClones].filter(Boolean);
    if (err instanceof CalendarOccurrenceError && staged.length === 0) {
      return sendCalendarOccurrenceError(res, err);
    }
    if (err instanceof StorageError && staged.length === 0) {
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    log.error('PUT occurrence following failed:', err);
    if (staged.length > 0) {
      try {
        await cleanupCalendarUploads(staged);
      } catch (cleanupError) {
        return sendStorageError(
          res,
          cleanupError,
          'Calendar attachment storage cleanup failed.',
        );
      }
    }
    if (err instanceof StorageError) {
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.delete('/:seriesId/occurrences/:recurrenceId', (req, res) => {
  try {
    const seriesId = parseInt(req.params.seriesId, 10);
    if (!Number.isInteger(seriesId) || !loadVisibleEvent(seriesId, req)) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'Calendar series not found.',
        { status: 404, code: 'calendar_series_not_found' },
      ));
    }
    deleteOccurrence(db.get(), {
      seriesId,
      recurrenceId: req.params.recurrenceId,
      actorId: getUserId(req),
      isAdmin: isAdminUser(req),
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    log.error('DELETE occurrence failed:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.delete('/:seriesId/occurrences/:recurrenceId/following', (req, res) => {
  try {
    const seriesId = parseInt(req.params.seriesId, 10);
    if (!Number.isInteger(seriesId) || !loadVisibleEvent(seriesId, req)) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'Calendar series not found.',
        { status: 404, code: 'calendar_series_not_found' },
      ));
    }
    truncateSeries(db.get(), {
      seriesId,
      recurrenceId: req.params.recurrenceId,
      actorId: getUserId(req),
      isAdmin: isAdminUser(req),
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    log.error('DELETE occurrence following failed:', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/calendar/:id/reset
// ICS-Event auf Original zurücksetzen (user_modified = 0).
// Nur Event-Creator, Subscription-Creator oder Admin.
// Response: { data: { reset: true } }
// --------------------------------------------------------
router.post('/:id/reset', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });
    const event = db.get().prepare(`
      SELECT e.*, s.created_by AS sub_created_by
      FROM calendar_events e
      LEFT JOIN ics_subscriptions s ON s.id = e.subscription_id
      WHERE e.id = ?
    `).get(id);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    if (event.external_source !== 'ics')
      return res.status(400).json({ error: 'Nur ICS-Events können zurückgesetzt werden.', code: 400 });

    const userId  = getUserId(req);
    const isAdmin = isAdminUser(req);
    if (!isAdmin && event.created_by !== userId && event.sub_created_by !== userId)
      return res.status(403).json({ error: 'Nicht autorisiert.', code: 403 });

    // `color_modified` geht mit: Zurücksetzen heisst "der Feed führt diesen
    // Termin wieder", und das schliesst seine Farbe ein (#899).
    db.get().prepare('UPDATE calendar_events SET user_modified = 0, color_modified = 0 WHERE id = ?').run(id);
    res.json({ data: { reset: true } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/calendar/:id/exceptions
// Nimmt ein einzelnes Vorkommen einer lokalen Serie aus (EXDATE, #489).
// Body: { date: 'YYYY-MM-DD' } — Start-Datum der auszunehmenden Instanz.
// Nur lokale (nicht extern synchronisierte) wiederkehrende Termine.
// Response: 201 { data: { event_id, exception_date } }
// --------------------------------------------------------
router.post('/:id/exceptions', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const date = req.body?.date;
    if (!DATE_RE.test(date || ''))
      return res.status(400).json({ error: 'date muss YYYY-MM-DD sein.', code: 400 });

    const event = loadVisibleEvent(id, req);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    const eligibility = isEligibleLocalSeries(db.get(), event, getUserId(req));
    if (!isLocallyOwnedSeries(db.get(), event)) {
      const notSeries = !event.recurrence_rule;
      return res.status(400).json({
        error: notSeries
          ? 'Termin ist keine Serie.'
          : 'Diese Serie kann keine einzelnen Ausnahmen verwenden.',
        code: 400,
        reason: eligibility.reason,
      });
    }

    db.get().prepare(
      'INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)'
    ).run(id, date);

    res.status(201).json({ data: { event_id: id, exception_date: date } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/calendar/:id
// Termin löschen. Ein nach Google gespiegelter Termin wird dort ebenfalls
// gelöscht (#593) - vorgemerkt vor dem lokalen DELETE (danach ist die Zeile
// mitsamt der Google-Event-ID weg), ausgeführt asynchron nach der Antwort.
// Response: 204 No Content
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const event = loadVisibleEvent(id, req);
    if (!event) return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });
    if (rejectLinkedOccurrenceResource(res, event, req)) return;
    const queued = queueEventDeletion(event);

    const result = db.get().transaction(() => {
      const ownedIds = db.get().prepare(`
        SELECT id FROM calendar_events
        WHERE id = ? OR recurrence_parent_id = ?
      `).all(id, id).map((row) => Number(row.id));
      if (ownedIds.length) {
        db.get().prepare(`
          DELETE FROM reminders
          WHERE entity_type = 'event'
            AND entity_id IN (${ownedIds.map(() => '?').join(',')})
        `).run(...ownedIds);
      }
      return db.get().prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
    })();
    if (result.changes === 0)
      return res.status(404).json({ error: 'Termin nicht gefunden', code: 404 });

    res.status(204).end();

    // Bewusst nach der Antwort: der Provider-Aufruf darf das lokale Löschen weder
    // verzögern noch scheitern lassen. Schlägt er fehl, bleibt der Tombstone
    // liegen und der nächste Sync-Lauf holt die Löschung nach.
    if (queued) {
      flushOutbound()
        .catch((err) => log.warn('Löschung vorgemerkt, Sofortversuch fehlgeschlagen:', err.message));
    }
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
