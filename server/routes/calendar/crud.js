/**
 * Modul: Kalender (Calendar) - Termin-CRUD (lokale Events)
 * GET /:id, POST /, PUT /:id, POST /:id/reset, POST /:id/exceptions, DELETE /:id.
 */

import { createLogger } from '../../logger.js';
import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import { sqlInList } from '../../utils/sql-in-list.ts';
import { MAX_REMINDER_OFFSETS } from '../../services/calendar-fields.js';
import * as db from '../../db.js';
import { withTx } from '../../db/tx.ts';
import { str, color, datetime, rrule, textShape, collectErrors, MAX_TITLE, MAX_TEXT, DATE_RE } from '../../api/formats.ts';
import { hasAnyOccurrence, endsBeforeStart } from '../../services/recurrence.js';
import { startOrRuleChanged } from '../../services/outbound-dtstart.js';
import { resolveProjectedEventRows } from '../../services/calendar-event-reader.js';
import {
  hasExplicitZone, householdTimeZone, shiftDateKey, storedDayDiffersFromSeriesDay, storedToWall, utcToWall,
} from '../../utils/timezone.js';
import {
  StorageError,
  cleanupStagedUpload,
  readDocumentContent,
  stageDocumentUpload,
} from '../../services/document-storage.js';
import { queueEventDeletion, markEventOutbound, flushOutbound, waitsForUpload } from '../../services/calendar-outbound.js';
import { uploadsLocalEvents } from '../../services/apple-calendar.js';
import {
  isOccurrenceKey, occurrenceSlotOf, SOURCE_CALENDAR_COLUMNS, SOURCE_CALENDAR_JOIN,
} from '../../services/calendar-events.js';
import { newNonMembers, nonMemberMessage } from '../../services/household-members.js';
import { documentDeleteIsActive } from '../../services/document-deletion-lock.js';
import { documentViewer } from '../../services/document-links.js';
import {
  mayChangeRecord,
  mayWriteModule,
  sendNotOwner,
  normalizeVisibility,
  ATTACHMENT_NARROW_ONLY,
  documentClonePredicate,
  documentWidenPredicate,
  readerBinds,
  readerVisibleWhere,
  rowReader,
  visibleWhere,
} from '../../authorize/index.ts';
import { recordLocalColorChoice } from '../../services/legacy-color-snapshot.js';
import { localCalendarColorSql, localCalendarIdSql, localCalendarProjection, resolveLocalCalendarId, validateCalendarId } from '../../services/local-calendars.js';
import {
  assertSuccessorHasOccurrence,
  baseOccurrenceFor,
  CalendarAttachmentCloneRequiredError,
  CalendarOccurrenceError,
  deleteOccurrence,
  isEligibleLocalSeries,
  isLocallyOwnedSeries,
  linkedOccurrenceChild,
  parseOverrideFields,
  rekeySeriesAfterUpdate,
  splitSeries,
  truncateSeries,
  upsertOccurrenceOverride,
  updateSeriesWithOverrides,
  followInboundStartChange,
} from '../../services/calendar-occurrence-overrides.js';
import { isAdminRequest } from '../../middleware/require-admin.js';
import {
  ASSIGNED_USERS_SQL,
  getUserId,
  eventIcon,
  parseAttachment,
  refuseUploadWithoutDocumentsWrite, storedAttachmentLocked,
  ATTACHMENT_CHANGE_REFUSAL,
  caldavTarget,
  caldavTargetOffered,
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

/**
 * Die Kennung im Pfad: das Schema laesst nur Dezimalziffern durch (#2810).
 * @param {any} req
 * @param {string} [name]
 */
function pathId(req, name = 'id') {
  return Number(req.params[name]);
}

// #1909: die Faelle, die ein Nutzer beim Speichern, Zuruecksetzen oder Loeschen
// eines Termins erreicht, tragen einen `reason`; die App sagt dazu ihren Satz
// (utils/friendly-error.js, pages/calendar.js). `error` bleibt englisch fuer
// API-Clients und Logs.
function sendEventGone(res) {
  return res.status(404).json({ error: 'Event not found.', code: 404, reason: 'calendar_event_not_found' });
}

// Der im Dialog gewaehlte Kalender ist inzwischen geloescht (validateCalendarId):
// nur dieser Fall einer Pruefung traegt einen Grund, alles andere schickt nur
// ein Aufrufer an der Oberflaeche vorbei.
function selectedCalendarGone(checks) {
  return checks.some((check) => check?.reason === 'calendar_selected_calendar_not_found');
}

function sendValidationErrors(res, checks) {
  return res.status(400).json({
    error: collectErrors(checks).join(' '),
    code: 400,
    ...(selectedCalendarGone(checks) ? { reason: 'calendar_selected_calendar_not_found' } : {}),
  });
}

// Eine Serie ohne ein einziges Vorkommen (#960) erreicht das Formular mit einer
// Regel wie "am Monatsletzten, bis zum 20." ab dem 15.
function sendSeriesWithoutOccurrence(res) {
  return res.status(400).json({
    error: 'recurrence_rule: the rule has no occurrence on or after the start date.',
    code: 400,
    reason: 'calendar_series_no_occurrence',
  });
}

/**
 * Was dieser Aufrufer mit Anhang-Dokumenten tun darf (#1358): die Sichtbarkeit
 * des Termins aufs Dokument uebertragen nur mit Dokumente-Schreibrecht, Sicht
 * UND Verwaltungsrecht (Erstellerin oder Admin); kopieren (Split, Abloesen) mit
 * Schreibrecht und Sicht auf die Quelle. Sonst bleiben die Rechte des Dokuments,
 * wie die Besitzerin sie gesetzt hat (#1443), und ein Nachfolger bekommt keine
 * Kopie - ohne 403, damit der Termin bearbeitbar bleibt; der Anhang bleibt an
 * der alten Serie.
 *
 * EIN OBJEKT JE REQUEST: `createAttachmentDocument` merkt sich, welches Dokument
 * dieses Schreiben selbst angelegt hat. Ein neuer Anhang entsteht als `family`
 * und gehoert der Terminerstellerin; laedt eine Zugewiesene ihn hoch, darf der
 * Abgleich ihn trotzdem auf den Termin verengen (`ATTACHMENT_NARROW_ONLY`) -
 * sonst saehe die ganze Familie den Anhang eines Termins fuer Zugewiesene.
 */
function attachmentRights(req) {
  const actor = {
    actorId: getUserId(req),
    isAdmin: isAdminRequest(req),
    documentsWritable: mayWriteModule(req, 'documents'),
  };
  const mayManage = documentWidenPredicate(db.get(), actor);
  const createdHere = new Set();
  return {
    // Voll abgleichen: nur wer das Dokument auch verwalten darf; ein hier neu
    // angelegtes nur verengen; alles andere bleibt unangetastet.
    mayWidenAttachment: (documentId) => {
      if (mayManage(documentId)) return true;
      return createdHere.has(Number(documentId)) ? ATTACHMENT_NARROW_ONLY : false;
    },
    // Kopieren: wer es sieht und Dokumente schreiben darf.
    mayCloneAttachment: documentClonePredicate(db.get(), actor),
    createAttachmentDocument: (...args) => {
      const documentId = createAttachmentDocument(...args);
      if (documentId) createdHere.add(Number(documentId));
      return documentId;
    },
  };
}

/**
 * Der Plan der Kopien gilt nicht mehr (#2956): das zweite Speichern verlangt
 * eine Kopie, die vor dem await niemand verlangt hatte. Die Transaktion rollt
 * zurueck, und der Plan wird gegen die Zeile von jetzt neu gemacht.
 */
class ClonePlanChangedError extends Error {}

/** Wie oft der Plan neu gemacht wird, bevor die Anfrage aufgibt. */
const CLONE_PLAN_ROUNDS = 3;

async function runWithAttachmentClonePlan(database, stagedClones, operation, { mayClone = () => false } = {}) {
  let requests;
  try {
    return operation({});
  } catch (error) {
    if (!(error instanceof CalendarAttachmentCloneRequiredError)) throw error;
    requests = error.requests;
  }

  // LESEN, AWAIT, SCHREIBEN (#2956). Zwischen dem Plan (welche Ausnahme
  // braucht welche Kopie) und dem zweiten Speichern liegen Lesen und Hochladen
  // der Kopien (await); eine zweite Anfrage kann in dieser Zeit die Ausnahmen
  // der Serie austauschen. Das zweite Speichern fragt deshalb wieder die Zeile
  // von jetzt; verlangt es eine Kopie, die nicht bereitliegt, wird neu geplant.
  // Bereitgestellte Dateien derselben Quelle werden dabei wiederverwendet.
  // Puffer und Dateien gelten ueber alle Runden: den Inhalt einer Dokument-ID
  // (storage_key, storage_backend, storage_provider, content_data, mime_type,
  // file_size) schreibt nach dem Anlegen
  // niemand mehr um - die Dokument-Route aendert nur Metadaten, und die nimmt
  // `consume` aus der frisch gelesenen Zeile. Erzwungen von der harten
  // Lint-Regel DOC-CONTENT (scripts/generate-oxlint-overrides.mjs): ein UPDATE
  // auf eine Inhaltsspalte von family_documents unter server/ ist rot, die
  // Migrationen ausgenommen. Eine geloeschte ID kommt nicht
  // wieder: family_documents zaehlt mit AUTOINCREMENT (baseline.sql).
  const contents = new Map();
  /** @type {{ sourceDocumentId: number, staged: any, written?: boolean }[]} */
  const files = [];
  for (let round = 1; ; round += 1) {
    const prepared = [];
    const reserved = new Set();
    for (const request of requests) {
      const sourceId = Number(request.sourceDocumentId);
      // Keine Kopie ohne Recht und keine ohne Quelle: weder gelesen noch
      // gestaged, `consume` liefert `null`. Die Zeile wird nach den awaits der
      // Anfragen davor gelesen; ein inzwischen geloeschtes Dokument ist wie
      // eine verweigerte Kopie, nicht ein Serverfehler (wie `fresh` in `consume`).
      // Ebenso eines, dessen Loeschung laeuft: DELETE /documents/:id sperrt es,
      // loescht erst die Datei (await) und dann die Zeile.
      const sourceGone = () => !database.prepare('SELECT 1 FROM family_documents WHERE id = ?').get(sourceId)
        || !mayClone(request.sourceDocumentId)
        || documentDeleteIsActive(sourceId);
      const sourceDocument = database.prepare('SELECT * FROM family_documents WHERE id = ?')
        .get(request.sourceDocumentId);
      if (!sourceDocument || sourceGone()) {
        prepared.push({ request, refused: true, used: false });
        continue;
      }
      let file = files.find((entry) => entry.sourceDocumentId === sourceId && !reserved.has(entry));
      if (!file) {
        // Kategorie und Name bestimmen hier nur den Speicherpfad der Datei;
        // was die Kopie zeigt (Name, Kategorie, Dateiname, Typ, Groesse),
        // nimmt cloneAttachmentDocument aus der frisch gelesenen Zeile.
        let staged;
        try {
          if (!contents.has(sourceId)) {
            contents.set(sourceId, await readDocumentContent(sourceDocument));
          }
          const content = contents.get(sourceId);
          staged = await stageDocumentUpload({
            buffer: content.buffer,
            mime: content.mime,
            category: sourceDocument.category,
            originalName: sourceDocument.original_name,
          });
        } catch (error) {
          // Ist die Quelle waehrend des Lesens oder Bereitstellens verschwunden
          // (oder in Loeschung), ist das dieselbe verweigerte Kopie wie davor;
          // gefragt synchron nach dem await. Sonst bleibt es der Speicherfehler.
          if (!sourceGone()) throw error;
          prepared.push({ request, refused: true, used: false });
          continue;
        }
        stagedClones.push(staged);
        file = { sourceDocumentId: sourceId, staged };
        files.push(file);
      }
      reserved.add(file);
      prepared.push({ request, file, staged: file.staged, used: false });
    }

    const consume = (owner, childId, sourceDocumentId) => {
      const clone = prepared.find((entry) => !entry.used
        && entry.request.owner === owner
        && (owner !== 'detached' || Number(entry.request.childId) === Number(childId))
        && Number(entry.request.sourceDocumentId) === Number(sourceDocumentId));
      if (!clone) throw new ClonePlanChangedError('No staged attachment clone matches the owner.');
      clone.used = true;
      if (clone.refused) return null;
      // KEIN AWAIT ZWISCHEN LESEN UND SCHREIBEN (CLAUDE.md, #1358). Die Quelle
      // und das Recht wurden VOR dem Lesen und Bereitstellen der Datei geprueft;
      // dazwischen lag ein await, in dem die Besitzerin das Dokument privat
      // stellen oder die Freigabe entziehen konnte. Deshalb hier, synchron und
      // in der Transaktion, die Zeile frisch lesen und das Recht neu fragen.
      // Faellt eines weg, entsteht keine Kopie - die bereitgestellte Datei
      // raeumt die Schleife unten weg (`written` bleibt false).
      const fresh = database.prepare('SELECT * FROM family_documents WHERE id = ?').get(sourceDocumentId);
      if (!fresh || !mayClone(sourceDocumentId)) return null;
      clone.written = true;
      return {
        ...clone.request.attachment,
        attachment_document_id: cloneAttachmentDocument(
          database,
          fresh,
          clone.staged,
        ),
      };
    };

    /** @type {Set<any>} */
    let written;
    let result;
    try {
      result = operation({
        cloneAttachment: (sourceDocumentId) =>
          consume('successor', null, sourceDocumentId),
        cloneDetachedAttachment: (childId, sourceDocumentId) =>
          consume('detached', childId, sourceDocumentId),
      });
      written = new Set(prepared.filter((clone) => clone.written).map((clone) => clone.file));
    } catch (error) {
      if (!(error instanceof ClonePlanChangedError)) throw error;
      // Nach der letzten Runde ist es ein Konflikt mit dem Stand der Serie,
      // kein Serverfehler: 409, gespeichert ist nichts (die Transaktion ist
      // zurueckgerollt), die Kopien raeumt der catch der Route weg, und die
      // Anfrage darf wiederholt werden.
      if (round >= CLONE_PLAN_ROUNDS) {
        throw new CalendarOccurrenceError('The series changed while attachment copies were uploaded.', {
          status: 409,
          code: 'calendar_series_changed',
        });
      }
      // Neu planen gegen die Zeile von jetzt, synchron: braucht sie gar keine
      // Kopie mehr, ist dieser Aufruf schon das Speichern.
      try {
        result = operation({});
        written = new Set();
      } catch (replan) {
        if (!(replan instanceof CalendarAttachmentCloneRequiredError)) throw replan;
        requests = replan.requests;
        continue;
      }
    }
    for (const file of files) {
      const index = stagedClones.indexOf(file.staged);
      if (index >= 0) stagedClones.splice(index, 1);
      if (!written.has(file)) {
        try {
          await cleanupStagedUpload(file.staged);
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
    return { value: null, error: 'Assignment: choose people by valid positive user IDs.' };
  }
  if (new Set(ids).size !== ids.length) {
    return { value: null, error: 'Assignment: choose each person at most once.' };
  }
  if (ids.length > 0) {
    const idList = sqlInList(ids);
    const found = database.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE id IN (${idList.sql})
    `).get(idList.param).count;
    if (Number(found) !== ids.length) {
      return { value: null, error: 'An assigned person no longer exists.' };
    }
  }
  return { value: ids, error: null };
}

/**
 * Der gespeicherte Stand eines Vorkommens - nach derselben Regel wie
 * upsertOccurrenceOverride() und splitSeries(): besitzt ein bestehendes
 * Vorkommen seine Zuweisungen (`overridden_fields` enthaelt `assignments`),
 * gelten dessen, sonst die der Serie. Wer das Vorkommen schon entfernt hat,
 * steht damit nicht mehr auf der Bestandsliste.
 */
function storedOccurrenceAssignees(database, master, recurrenceId) {
  // In exakter oder alter Schluesselform gespeichert (#2034).
  const existing = linkedOccurrenceChild(database, master, recurrenceId, householdTimeZone(database));
  const ownsAssignments = existing && parseOverrideFields(existing.overridden_fields).includes('assignments');
  return storedEventAssignees(database, ownsAssignments ? existing.id : master.id);
}

/**
 * Das Anhang-Dokument, das an diesem Serientermin gerade gilt: das der
 * Ausnahme, wenn sie den Anhang selbst fuehrt, sonst das der Serie.
 */
function storedOccurrenceAttachmentDocument(database, master, recurrenceId) {
  const existing = linkedOccurrenceChild(database, master, recurrenceId, householdTimeZone(database));
  const ownsAttachment = existing && parseOverrideFields(existing.overridden_fields).includes('attachment');
  return ownsAttachment ? existing.attachment_document_id : master.attachment_document_id;
}

/** Wer am Termin steht, so wie es der Schreibvorgang gerade vorfindet. */
function storedEventAssignees(database, eventId) {
  return database.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?')
    .all(eventId).map((row) => row.user_id);
}

/**
 * Eine Personenwahl, die erst unmittelbar vor dem Schreiben abgelehnt wird
 * (#1207). Eigene Klasse, damit die Catch-Bloecke gestagte Uploads wegraeumen
 * und dann mit ihrer Meldung 400 antworten.
 */
class NonMemberAssignmentError extends Error {}

/**
 * Neu nur Haushaltsmitglieder, gegen den gespeicherten Stand - gefragt dort,
 * wo geschrieben wird, synchron nach dem letzten await des Handlers.
 */
function assertNoNewNonMembers(database, userIds, stored) {
  if (userIds === undefined) return;
  const strangers = newNonMembers(userIds, { stored, db: database });
  if (strangers.length) throw new NonMemberAssignmentError(nonMemberMessage(strangers));
}

/**
 * Die Sperrpruefung fuer einen Anhang (#1358), wiederholt DORT, wo geschrieben
 * wird. Die fruehe Pruefung vor dem Hochladen bleibt als billiger Abbruch; sie
 * allein genuegt nicht, denn zwischen ihr und dem Schreiben liegt das
 * Bereitstellen der neuen Datei (await), und in dieser Zeit kann die Besitzerin
 * das Dokument privat stellen oder die Freigabe entziehen. Deshalb synchron
 * nach dem letzten await, mit frisch gelesener `attachment_document_id`.
 */
class AttachmentLockedError extends Error {}

function assertAttachmentStillChangeable(req, database, storedDocumentId, { replacementRequested, removalRequested }) {
  if (!(replacementRequested || removalRequested)) return;
  if (storedAttachmentLocked(req, database, storedDocumentId)) throw new AttachmentLockedError();
}

/** Anhang inzwischen gesperrt: gestagte Uploads wegraeumen, dann dieselbe 403 wie die fruehe Pruefung. */
async function sendAttachmentLocked(res, staged) {
  if (staged.length > 0) {
    try {
      await cleanupCalendarUploads(staged);
    } catch (cleanupError) {
      return sendStorageError(res, cleanupError, 'Calendar attachment storage cleanup failed.');
    }
  }
  return res.status(403).json({ error: ATTACHMENT_CHANGE_REFUSAL, code: 403, reason: 'ATTACHMENT_CHANGE_REFUSED' });
}

/** Eine abgelehnte Personenwahl: gestagte Uploads wegraeumen, dann 400 mit ihrer Meldung. */
async function sendNonMemberAssignment(res, err, staged) {
  if (staged.length > 0) {
    try {
      await cleanupCalendarUploads(staged);
    } catch (cleanupError) {
      return sendStorageError(res, cleanupError, 'Calendar attachment storage cleanup failed.');
    }
  }
  return res.status(400).json({ error: err.message, code: 400 });
}

/**
 * Eine Absage, die erst gegen die Zeile beim Schreiben faellt (#2940): der
 * Termin ist weg, nicht mehr sichtbar oder aenderbar, oder eine Pruefung des
 * PUT faellt gegen den neuen Stand anders aus. Eigene Klasse wie die beiden
 * darueber: gestagte Uploads wegraeumen, dann dieselbe Antwort wie vor dem
 * Upload (`respond` ist die Antwortfunktion der Pruefung).
 */
class RefusedAfterUploadError extends Error {
  /** @param {(res: any) => any} respond */
  constructor(respond) {
    super('Refused against the row the write found.');
    this.respond = respond;
  }
}

/**
 * @param {any} res
 * @param {(res: any) => any} respond
 * @param {any[]} staged
 */
async function sendRefusalAfterUpload(res, respond, staged) {
  if (staged.length > 0) {
    try {
      await cleanupCalendarUploads(staged);
    } catch (cleanupError) {
      return sendStorageError(res, cleanupError, 'Calendar attachment storage cleanup failed.');
    }
  }
  return respond(res);
}

/**
 * Der Ort, der nach einer Bearbeitung gilt (#2202).
 *
 * Ein ueber die Apple-Ortssuche gewaehlter Ort steht mehrzeilig in der Zeile
 * ("Name\nStrasse\nOrt"). Ein einzeiliges Eingabefeld - das Formular nimmt
 * <input type="text"> - entfernt beim Setzen des Werts jeden Zeilenumbruch,
 * und das Formular schickt `location` bei jedem Speichern mit. Eine reine
 * Zuweisung kam so als geaenderter Ort an, wurde als PUT zum Anbieter
 * vorgemerkt, und iOS verlor die Verknuepfung zum Ort.
 *
 * Unterscheidet sich der geschickte Wert vom gespeicherten nur um
 * Zeilenumbrueche und Raender, hat niemand den Ort angefasst: es gilt der
 * gespeicherte. Die Regel haengt bewusst nicht am Eingabefeld, sondern an dem,
 * was ankommt - jeder Client mit einzeiligem Feld macht dasselbe.
 */
function locationAfterEdit(sent, stored) {
  if (typeof sent !== 'string' || typeof stored !== 'string') return sent;
  const flat = (value) => value.replace(/[\r\n]/g, '').trim();
  return flat(sent) === flat(stored) ? stored : sent;
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

function validateOccurrenceMutationBody(database, body, { following = false, master } = {}) {
  const values = {};
  const errors = [];
  // Ein Offset wird in die Haushaltszone umgerechnet (#1364); ganztaegig zaehlt
  // nur das Datum. Schickt der Body `all_day` nicht mit, gilt der Wert der Serie.
  const zone = householdTimeZone(database);
  const allDay = typeof body.all_day === 'boolean' ? body.all_day : !!master?.all_day;
  const validateString = (field, label, options = {}) => {
    if (!Object.hasOwn(body, field)) return;
    const nullable = options.nullable === true;
    if (body[field] === null && nullable) {
      values[field] = null;
      return;
    }
    // Text (oder null, wo erlaubt) sagt das Schema davor (#2810).
    const result = str(body[field], label, {
      max: options.max,
      required: options.required !== false,
    });
    if (result.error) errors.push(`${label}: enter valid text of at most ${options.max} characters.`);
    else values[field] = result.value;
  };
  const validateDateTime = (field, label, { nullable = false } = {}) => {
    if (!Object.hasOwn(body, field)) return;
    if (body[field] === null && nullable) {
      values[field] = null;
      return;
    }
    if (typeof body[field] !== 'string' || body[field].trim() === '') {
      errors.push(`${label}: enter a date with an optional time${nullable ? ', or null' : ''}.`);
      return;
    }
    const result = datetime(body[field], label, true, { to: 'wall', zone, allDay });
    if (result.error) errors.push(`${label}: enter a valid date with an optional time.`);
    else if (!isPossibleCalendarDateTime(body[field])) {
      errors.push(`${label}: enter a valid date with an optional time.`);
    } else values[field] = result.value;
  };

  validateString('title', 'title', { max: MAX_TITLE });
  validateString('description', 'description', { max: MAX_TEXT, required: false, nullable: true });
  validateDateTime('start_datetime', 'start_datetime');
  validateDateTime('end_datetime', 'end_datetime', { nullable: true });
  validateString('location', 'location', { max: MAX_TITLE, required: false, nullable: true });

  // Die Form der Felder - Text oder null, `all_day`/`countdown` als Boolean,
  // `visibility` aus EVENT_VISIBILITY - sagt das Schema beider Routen davor
  // (CalendarOccurrenceOnlyMutation, CalendarOccurrenceFollowingMutation,
  // #2810); hier bleibt der Inhalt.
  if (Object.hasOwn(body, 'color')) {
    const result = color(body.color, 'color');
    if (result.error) errors.push('color: choose a valid color in the format #RRGGBB.');
    else values.color = result.value;
  }
  if (following && Object.hasOwn(body, 'recurrence_rule')) {
    const result = rrule(body.recurrence_rule, 'recurrence_rule');
    if (result.error) errors.push('recurrence_rule is invalid.');
    else values.recurrence_rule = result.value;
  }
  for (const field of ['all_day', 'countdown', 'visibility']) {
    if (Object.hasOwn(body, field)) values[field] = body[field];
  }
  const assignments = validateOccurrenceAssignments(database, body.assigned_to);
  if (assignments.error) errors.push(assignments.error);
  const localCalendar = validateCalendarId(database, body.local_calendar_id);
  if (localCalendar.error) errors.push(localCalendar.error);
  if (localCalendar.value !== undefined) values.local_calendar_id = localCalendar.value;

  return { values, assignments: assignments.value, errors, calendarGone: selectedCalendarGone([localCalendar]) };
}

// --------------------------------------------------------
// GET /api/v1/calendar/:id
// Einzelnen Termin abrufen.
// Response: { data: Event }
// --------------------------------------------------------
router.get('/:id', validateRequest(), (req, res) => {
  const id    = pathId(req);
  // A paired display reads under the wall rule (rowReader), people under the row rule.
  const reader = rowReader(req);
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
           lc.id AS local_calendar_id,
           lc.name  AS local_calendar_name,
           ${localCalendarColorSql()} AS local_calendar_color,
           ${SOURCE_CALENDAR_COLUMNS},
           COALESCE(bd.name, nd.name) AS birthday_name,
           CASE WHEN bd.year_unknown = 1 THEN NULL ELSE bd.birth_date END AS birthday_date,
           nd.name_day   AS name_day,
           CASE WHEN nd.id IS NOT NULL THEN 'name_day'
                WHEN bd.id IS NOT NULL THEN 'birthday' END AS birthday_event_kind,
           ${ASSIGNED_USERS_SQL},
           (SELECT hws.id FROM housekeeping_work_sessions hws WHERE hws.calendar_event_id = e.id LIMIT 1) AS housekeeping_visit_id
    FROM calendar_events e
    LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
    LEFT JOIN users u_created  ON u_created.id  = e.created_by
    LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
    LEFT JOIN local_calendars lc ON lc.id = ${localCalendarIdSql()}
    ${SOURCE_CALENDAR_JOIN}
    LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
    LEFT JOIN birthdays bd ON bd.calendar_event_id = e.id
    LEFT JOIN birthdays nd ON nd.name_day_calendar_event_id = e.id
    WHERE e.id = ?
      AND ${readerVisibleWhere(reader, 'ics_subscriptions', 'e', '?')}
      AND ${readerVisibleWhere(reader, 'events', 'e', '?')}
  `).get(id, ...readerBinds(reader, 'ics_subscriptions'), ...readerBinds(reader, 'events'));

  if (!event) return sendEventGone(res);
  const database = db.get();
  const resolved = resolveProjectedEventRows(database, [event])[0];
  res.json({ data: serializeEvent(resolved, {
    viewer: documentViewer(req),
    database,
    actorId: getUserId(req),
    isAdmin: isAdminRequest(req),
  }) });
});

// --------------------------------------------------------
const SERIES_ENDS_BEFORE_START = 'recurrence_rule: the series ends before the start date.';

/**
 * Die beiden Absagen der Seriengrenzen im PUT (#960, #1607), aus einer Stelle,
 * damit die Absage nach dem Upload (#2940) dieselbe ist wie die davor.
 * @param {any} res
 * @param {string} refusal
 */
function sendSeriesRefusal(res, refusal) {
  if (refusal === 'no_occurrence') return sendSeriesWithoutOccurrence(res);
  return res.status(400).json({ error: SERIES_ENDS_BEFORE_START, code: 400, reason: 'calendar_series_ends_before_start' });
}

// POST /api/v1/calendar
// Neuen Termin anlegen.
// Body: { title, description?, start_datetime, end_datetime?,
//         all_day?, location?, color?, icon?, assigned_to?,
//         recurrence_rule?, countdown? }
// Response: { data: Event }
// --------------------------------------------------------
router.post('/', refuseUploadWithoutDocumentsWrite, validateRequest(), async (req, res) => {
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
    // Hochladen braucht das Dokumente-Schreibrecht (DECISIONS.md Eintrag 10):
    // `refuseUploadWithoutDocumentsWrite` steht vor der Pruefung der Anfrage.

    const vTitle = str(req.body.title, 'title', { max: MAX_TITLE });
    const vDesc  = str(req.body.description, 'description', { max: MAX_TEXT, required: false });
    // Ein Wert mit `Z` oder Offset wird in die Haushaltszone umgerechnet statt
    // abgeschnitten (#1364); ganztaegig zaehlt nur sein Datum.
    const zoneOpts = { to: 'wall', zone: householdTimeZone(db.get()), allDay: !!req.body.all_day };
    const vStart = datetime(req.body.start_datetime, 'start_datetime', true, zoneOpts);
    const vEnd   = datetime(req.body.end_datetime, 'end_datetime', false, zoneOpts);
    // Kein Fallback auf eine Palettenfarbe: fehlt die Angabe, bekommt der Termin
    // KEINE eigene Farbe (NULL) und leiht sich die der zugewiesenen Person
    // (#891). `color()` liefert fuer undefined/null/'' bereits value: null.
    const vColor = color(req.body.color, 'color');
    const vIcon  = eventIcon(req.body.icon);
    const vLoc   = str(req.body.location, 'location', { max: MAX_TITLE, required: false });
    const vRrule = rrule(req.body.recurrence_rule, 'recurrence_rule');
    // Erst die Form, dann der Inhalt: ein Paar aus der eingeschalteten Auswahl (#1860).
    const vCaldavForm = caldavTarget(req.body);
    const vCaldav = vCaldavForm.error ? vCaldavForm : caldavTargetOffered(db.get(), vCaldavForm.value);
    const vGoogle = googleTarget(req.body);
    const vOutlook = outlookTarget(req.body);
    const vLocalCalendar = validateCalendarId(db.get(), req.body.local_calendar_id);
    // Eine Person ohne Konto lief bis in den Fremdschluessel von
    // `event_assignments` (500); dieselbe Pruefung wie an den Vorkommen (#2810).
    const vAssigned = validateOccurrenceAssignments(db.get(), req.body.assigned_to);
    // Ein Anhang, den die Route nicht nehmen kann, ist eine 400 vor jedem
    // Schreiben (#2810); bis dahin warf parseAttachment, und es wurde 500.
    const vAttachment = parseAttachment(req.body.attachment_data);
    // Die Form (Text, bei Beschreibung und Ort auch null) prueft das Schema
    // davor (CalendarEventCreateInput, #2810); `str()` prueft den Inhalt.
    const checks = [vTitle, vDesc, vStart, vEnd, vColor, vLoc, vRrule, vCaldav, vGoogle, vOutlook, vLocalCalendar, vAssigned, vAttachment];
    if (collectErrors(checks).length) return sendValidationErrors(res, checks);
    if (req.body.local_calendar_id !== undefined
        && ((req.body.external_source && req.body.external_source !== 'local')
          || vCaldav.value.accountId || vGoogle.value)) {
      return res.status(400).json({ error: 'Local calendars can only hold local events.', code: 400 });
    }
    if (!vIcon) return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });
    // Teilnehmen lassen nur Haushaltsmitglieder (#1207).
    const strangers = newNonMembers(parseAssignedTo(req.body.assigned_to));
    if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });

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
      return sendSeriesWithoutOccurrence(res);
    }
    // EIN ENDE VOR DEM START IST EIN WIDERSPRUCH, KEINE SERIE (#1607). Der
    // Validator sieht nur die Form der Regel; gespeichert stand der Termin
    // danach als "taeglich, bis 30.09." an einem 2. Oktober.
    if (endsBeforeStart(vStart.value, vRrule.value)) {
      return res.status(400).json({ error: SERIES_ENDS_BEFORE_START, code: 400, reason: 'calendar_series_ends_before_start' });
    }

    const { all_day = 0 } = req.body;
    const userIds  = parseAssignedTo(req.body.assigned_to);
    const firstUid = userIds[0] ?? null;

    // Ein Befund ist oben schon eine 400 geworden.
    const attachment = /** @type {import('./helpers.js').Attachment} */ (vAttachment.value);
    if (attachment.buffer) {
      stagedUpload = await stageDocumentUpload({
        buffer: attachment.buffer,
        mime: attachment.mime,
        category: 'other',
        originalName: req.body.attachment_name || 'Attachment',
      });
    }

    // Was an der Datenbank haengt, gilt nach dem Upload wieder (#2956): der
    // Kalender, das angebotene CalDAV-Ziel und die Personen koennen sich in
    // der Zwischenzeit geaendert haben. Dieselbe Absage wie ohne Upload.
    const checksNow = [
      validateCalendarId(db.get(), vLocalCalendar.value),
      ...(vCaldavForm.error ? [] : [caldavTargetOffered(db.get(), /** @type {any} */ (vCaldavForm.value))]),
      validateOccurrenceAssignments(db.get(), req.body.assigned_to),
    ];
    const checkErrorsNow = collectErrors(checksNow).length > 0;
    const strangersNow = checkErrorsNow ? [] : newNonMembers(parseAssignedTo(req.body.assigned_to));
    if (checkErrorsNow || strangersNow.length) {
      if (stagedUpload) await cleanupStagedUpload(stagedUpload);
      if (strangersNow.length) return res.status(400).json({ error: nonMemberMessage(strangersNow), code: 400 });
      return sendValidationErrors(res, checksNow);
    }
    const rights = attachmentRights(req);
    const eventId = withTx(db.get(), () => {
      const documentId = rights.createAttachmentDocument(
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
           countdown, local_calendar_id, series_authored)
        -- series_authored = 1: Start und Regel stammen aus Yuvomi und bleiben
        -- es, auch wenn der Upload die Zeile zum Spiegel macht (#1935).
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
        req.body.countdown ? 1 : 0,
        vLocalCalendar.value
      );
      setEventAssignments(db.get(), result.lastInsertRowid, userIds, {
        mayWidenAttachment: rights.mayWidenAttachment,
        previous: null, // neuer Termin: das Dokument bekommt seine Rechte hier
      });
      return result.lastInsertRowid;
    });

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
             lc.id AS local_calendar_id,
             lc.name  AS local_calendar_name,
             ${localCalendarColorSql()} AS local_calendar_color,
             ${SOURCE_CALENDAR_COLUMNS},
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
      LEFT JOIN local_calendars lc ON lc.id = ${localCalendarIdSql()}
      ${SOURCE_CALENDAR_JOIN}
      LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
      WHERE e.id = ?
    `).get(eventId);

    res.status(201).json({ data: serializeEvent(event, {
      viewer: documentViewer(req),
      database: db.get(),
      actorId: getUserId(req),
      isAdmin: isAdminRequest(req),
      master: event,
    }) });

    // Ein neuer Termin mit Sync-Ziel geht sofort hinauf (#2565), nicht erst mit
    // dem nächsten Lauf - wie eine Änderung: antworten, danach best effort.
    // Scheitert der Versuch, wartet der Termin weiter auf den Lauf. Die
    // iCloud-Einzelkonto-Verbindung lädt jeden lokalen Termin hoch, daher die
    // zweite Bedingung.
    if (waitsForUpload(event) || uploadsLocalEvents()) {
      flushOutbound()
        .catch((e) => log.warn('Neuer Termin angelegt, Sofortversuch fehlgeschlagen:', e.message));
    }
  } catch (err) {
    if (err instanceof StorageError && !stagedUpload) {
      log.error('POST / storage error:', err);
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    // Ein unerwarteter Fehler geht an den zentralen Handler (#2810) - aber
    // erst, wenn der bereitgestellte Anhang wieder weg ist.
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
    // A storage refusal after the upload (#2946: the settings changed meanwhile).
    if (err instanceof StorageError) {
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    throw err;
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
      AND ${visibleWhere('ics_subscriptions', 'e', '?')}
      AND ${visibleWhere('events', 'e', '?')}
  `).get(id, me, me, me);
}

// FREMDE TERMINE NUR LESEN (R23, D5). Ohne `calendar_edit_others` aendert und
// loescht ein Konto nur Termine, die es angelegt hat oder denen es zugewiesen
// ist (Einzelzuweisung `assigned_to` oder `event_assignments`). Gilt fuer jeden
// Schreibweg auf einen bestehenden Termin - auch Einzelausnahmen und Kuerzen
// einer Serie, gemessen an der Serie. Nach `loadVisibleEvent()`: wer den
// Termin nicht sieht, bekommt weiter 404, nie diese 403.
function ownsEvent(event, req) {
  const me = getUserId(req);
  if (me == null || !event) return false;
  if (Number(event.created_by) === Number(me) || Number(event.assigned_to) === Number(me)) return true;
  return !!db.get().prepare('SELECT 1 FROM event_assignments WHERE event_id = ? AND user_id = ?').get(event.id, me);
}

function refuseForeignEvent(req, res, event) {
  if (mayChangeRecord(db.get(), req, 'calendar_edit_others', ownsEvent(event, req))) return false;
  sendNotOwner(res);
  return true;
}

const CALENDAR_OCCURRENCE_ERRORS = {
  calendar_series_not_found: 'Calendar series not found.',
  not_authorized: 'Not authorized to change this calendar series.',
  ineligible_series: 'Occurrence overrides are only available for local series without an active external sync. A local series that already has linked overrides needs its Outlook target calendar switched off first.',
  invalid_recurrence_id: 'The selected occurrence does not belong to this series.',
  malformed_recurrence_id: 'The occurrence key is malformed.',
  ambiguous_recurrence_id: 'Two occurrences of the series fall on this day (clock change); send the exact recurrence_id.',
  invalid_override_fields: 'The occurrence override fields are invalid.',
  invalid_occurrence_interval: 'The end of the occurrence must not lie before its start.',
  calendar_override_orphans: 'This change needs a current confirmation of the affected occurrence overrides (confirmed_orphan_count).',
  calendar_occurrence_route_required: 'Use the occurrence endpoint to change a linked recurring occurrence.',
  empty_successor_series: 'The successor series has no occurrence on or after its start date.',
  invalid_successor_override: 'An occurrence override does not fit the successor series.',
  calendar_series_changed: 'The series changed while attachment copies were uploaded. Nothing was saved; send the request again.',
};

function sendCalendarOccurrenceError(res, error) {
  return res.status(error.status).json({
    error: CALENDAR_OCCURRENCE_ERRORS[error.code] || 'The occurrence could not be changed.',
    code: error.status,
    ...(error.conflict ? { conflict: error.conflict } : { reason: error.code }),
    ...(error.orphanedOverrideCount !== undefined
      ? { orphaned_override_count: error.orphanedOverrideCount }
      : {}),
  });
}

/**
 * Die Absage fuer ein verknuepftes Vorkommen (404, 403 oder 400), gebaut aus
 * der Serie, wie sie JETZT steht. Synchron gelesen, damit eine Absage nach
 * einem await beschreibt, was die Pruefung sah (#2956).
 * @param {any} event
 * @param {any} req
 */
function linkedOccurrenceRefusal(event, req) {
  const parent = loadVisibleEvent(Number(event.recurrence_parent_id), req);
  if (!parent) {
    return new CalendarOccurrenceError(
      'Calendar series not found.',
      { status: 404, code: 'calendar_series_not_found' },
    );
  }
  const eligibility = isEligibleLocalSeries(
    db.get(),
    parent,
    getUserId(req),
  );
  if (!eligibility.eligible) {
    const unauthorized = eligibility.reason === 'not_authorized';
    return new CalendarOccurrenceError(
      unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
      { status: unauthorized ? 403 : 400, code: eligibility.reason },
    );
  }
  return new CalendarOccurrenceError(
    'Use the occurrence endpoint to modify a linked recurring occurrence.',
    { status: 400, code: 'calendar_occurrence_route_required' },
  );
}

/**
 * Die Serie, wie sie nach dem letzten await steht (#2956): geloescht oder fuer
 * die Person nicht mehr sichtbar ist dieselbe 404 wie vor dem Upload. Synchron
 * gelesen; den Upload raeumt der catch der Route weg.
 * @param {number} seriesId
 * @param {any} req
 */
function seriesAfterUpload(seriesId, req) {
  const current = loadVisibleEvent(seriesId, req);
  if (!current) {
    throw new CalendarOccurrenceError('Calendar series not found.', {
      status: 404,
      code: 'calendar_series_not_found',
    });
  }
  return current;
}

const LOCAL_NEXT_TO_TARGET = 'Choose either a sync target or a local calendar.';

/**
 * Die Folge-Route je Lauf (#2956): die Serie von jetzt, ob sie Ausnahmen
 * tragen kann und Sync-Ziel gegen lokalen Kalender - in der Reihenfolge der
 * Pruefung vor dem Upload. Gibt die Serie und die Aenderungen dieses Laufs
 * zurueck (`local_calendar_id` nach dem Ziel), ohne `baseChanges` anzufassen.
 * @param {{ seriesId: number, req: any, actorId: any, baseChanges: Record<string, any>, syncTargetOf: (row: any) => any }} args
 * @returns {{ now: any, changes: Record<string, any> }}
 */
function followingSeriesNow({ seriesId, req, actorId, baseChanges, syncTargetOf }) {
  const now = seriesAfterUpload(seriesId, req);
  const eligibility = isEligibleLocalSeries(db.get(), now, actorId);
  if (!eligibility.eligible) {
    const unauthorized = eligibility.reason === 'not_authorized';
    throw new CalendarOccurrenceError(
      unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
      { status: unauthorized ? 403 : 400, code: eligibility.reason },
    );
  }
  const syncTarget = syncTargetOf(now);
  const localAsked = Object.hasOwn(req.body, 'local_calendar_id');
  if (localAsked && syncTarget) {
    throw new RefusedAfterUploadError((r) => r.status(400).json({ error: LOCAL_NEXT_TO_TARGET, code: 400 }));
  }
  // Je Lauf eine eigene Kopie der Aenderungen: das Ziel dieses Laufs entscheidet
  // ueber den lokalen Kalender, nichts davon bleibt fuer den naechsten Lauf stehen.
  const runChanges = { ...baseChanges };
  if (syncTarget) runChanges.local_calendar_id = null;
  return { now, changes: runChanges };
}

function rejectLinkedOccurrenceResource(res, event, req) {
  if (event.recurrence_parent_id == null) return false;
  sendCalendarOccurrenceError(res, linkedOccurrenceRefusal(event, req));
  return true;
}

// --------------------------------------------------------
// PUT /api/v1/calendar/:id
// Termin vollständig aktualisieren.
// Body: alle Felder optional außer title + start_datetime
// Response: { data: Event }
// --------------------------------------------------------
router.put('/:id', refuseUploadWithoutDocumentsWrite, validateRequest(), async (req, res) => {
  let stagedUpload;
  const stagedClones = [];
  try {
    // Das Dokumente-Schreibrecht fragt `refuseUploadWithoutDocumentsWrite` vor
    // der Suche: die Absage verraet nicht, ob es den Termin gibt.
    const id    = pathId(req);
    const rights = attachmentRights(req);
    const {
      title, description,
      all_day, color: colorVal, recurrence_rule,
    } = req.body;
    const attachmentDataProvided = Object.hasOwn(req.body, 'attachment_data');
    const replacementRequested = typeof req.body.attachment_data === 'string'
      && req.body.attachment_data.trim() !== '';
    const removalRequested = req.body.remove_attachment === true
      || (attachmentDataProvided && req.body.attachment_data === null);
    const vAttachment = parseAttachment(req.body.attachment_data);

    // EINE PRUEFUNG, ZWEI STAENDE (#2940). Jede Pruefung und jeder Wert, der an
    // der Zeile haengt, steht in `evaluate(row)`: einmal gegen den geladenen
    // Termin fuer die schnelle Absage vor dem Upload, einmal im synchronen Teil
    // des Schreibens gegen die Zeile, die es vorfindet - waehrend des Uploads
    // (await) kann eine zweite Anfrage sie geaendert oder geloescht haben. Eine
    // Absage ist eine Antwortfunktion: davor wird sie gesendet, danach als
    // `RefusedAfterUploadError` geworfen, der catch raeumt den Upload weg und
    // sendet dieselbe Antwort.
    /** @param {(r: any) => any} respond */
    const refuse = (respond) => ({ refuse: respond });
    const evaluate = (/** @type {any} */ row) => {
      if (!row) return refuse((r) => sendEventGone(r));
      if (!mayChangeRecord(db.get(), req, 'calendar_edit_others', ownsEvent(row, req))) {
        return refuse((r) => sendNotOwner(r));
      }
      // Ein verknuepftes Vorkommen hat seinen eigenen Weg; die Absage (404, 403
      // oder 400) liest die Serie hier, nicht erst beim Senden: nach dem Upload
      // liegt davor noch das Aufraeumen (await, #2956).
      if (row.recurrence_parent_id != null) {
        const answer = linkedOccurrenceRefusal(row, req);
        return refuse((r) => sendCalendarOccurrenceError(r, answer));
      }

      /** @type {any[]} */
      const checks = [];
      // GESPEICHERT WIRD DER GEPRUEFTE WERT, NICHT DER ROHE (#1364). Bis hierher
      // pruefte PUT mit `datetime()` und schrieb dann `req.body.start_datetime`:
      // dieselbe Eingabe landete per POST gekuerzt und per PUT roh in der Zeile,
      // und eine Serie mit rohem `Z`-Start wiederholte ihren UTC-Suffix und
      // rutschte ueber die Zeitumstellung um eine Stunde. Ganztaegig ist, was der
      // Body sagt, sonst was schon gespeichert ist.
      //
      // DER START IST PFLICHT, AUCH HIER. Mitgeschickt als '' oder `null` ist er
      // ein 400 mit derselben Meldung wie bei POST: '' landete bis v2.68.0 roh in
      // der Zeile, und mit dem geprueften Wert haette es den Start still stehen
      // lassen - eine Anfrage, die leeren will, bekaeme 200, und nichts geschaehe.
      // Das Ende ist optional und darf geleert werden (ein Termin ohne Ende ist
      // gueltig, das Formular schickt dann `null`).
      const zoneOpts = {
        to: 'wall',
        zone: householdTimeZone(db.get()),
        allDay: req.body.all_day !== undefined ? !!req.body.all_day : !!row.all_day,
      };
      const vStart = req.body.start_datetime !== undefined
        ? datetime(req.body.start_datetime, 'start_datetime', true, zoneOpts) : null;
      const vEnd = req.body.end_datetime !== undefined
        ? datetime(req.body.end_datetime, 'end_datetime', false, zoneOpts) : null;
      // Ein mitgeschickter Titel muss Text sein und darf nicht leer sein: eine Zahl
      // lief in `.trim()` auf einen 500, '' wurde gespeichert, und `null` blieb
      // still ohne Wirkung. Fehlt er, bleibt der alte (Kuerzen einer Serie).
      // Die Form von Beschreibung und Ort prueft das Schema davor (#2810); die
      // des Titels bleibt, weil das Update unten `title.trim()` auf dem Rohwert
      // ruft (Senke, nicht Route).
      checks.push(textShape(req.body.title, 'title'));
      if (req.body.title          !== undefined) checks.push(str(req.body.title, 'title', { max: MAX_TITLE, required: typeof req.body.title === 'string' }));
      if (req.body.description    !== undefined) checks.push(str(req.body.description, 'description', { max: MAX_TEXT, required: false }));
      if (vStart) checks.push(vStart);
      if (vEnd)   checks.push(vEnd);
      if (req.body.color          !== undefined) checks.push(color(req.body.color, 'color'));
      if (req.body.location       !== undefined) checks.push(str(req.body.location, 'location', { max: MAX_TITLE, required: false }));
      // Der unveränderte Bestandswert kommt ohne Prüfung durch: Die Regel steht
      // bereits so in der Datenbank, und der Validator kennt nur das Vokabular der
      // eigenen Oberfläche (FREQ/INTERVAL/BYDAY/UNTIL/COUNT, ohne „RRULE:"-Präfix).
      // Eine aus CalDAV eingelesene Serie trägt regelmäßig mehr als das - Präfix,
      // WKST, BYMONTHDAY. Ohne diese Ausnahme scheiterte jede Änderung an einem
      // anderen Feld (Zuweisung, Titel) an der Wiederholung, die der Nutzer gar
      // nicht angefasst hat (#756). Geändert wird weiterhin nur, was der Validator
      // zulässt.
      if (req.body.recurrence_rule !== undefined
          && req.body.recurrence_rule !== row.recurrence_rule) {
        checks.push(rrule(req.body.recurrence_rule, 'recurrence_rule'));
      }
      // CalDAV-Ziel nur prüfen, wenn der Client es mitschickt; sonst bestehenden Wert behalten.
      const caldavProvided = req.body.target_caldav_account_id !== undefined
        || req.body.target_caldav_calendar_url !== undefined;
      const vCaldav = caldavProvided ? caldavTarget(req.body) : null;
      if (vCaldav) checks.push(vCaldav);
      // Ein NEUES Ziel muss angeboten sein; das unveränderte kommt durch (#1860).
      if (vCaldav && !vCaldav.error) checks.push(caldavTargetOffered(db.get(), vCaldav.value, row));
      // Google-Ziel nur prüfen, wenn der Client es mitschickt; sonst bestehenden Wert behalten.
      const googleProvided = req.body.target_google_calendar_id !== undefined;
      const vGoogle = googleProvided ? googleTarget(req.body) : null;
      if (vGoogle) checks.push(vGoogle);
      // Outlook-Ziel nur prüfen, wenn der Client es mitschickt; sonst bestehenden Wert behalten.
      const outlookProvided = req.body.target_outlook_account_id !== undefined
        || req.body.target_outlook_calendar_id !== undefined;
      const vOutlook = outlookProvided ? outlookTarget(req.body) : null;
      if (vOutlook) checks.push(vOutlook);
      const localCalendarProvided = req.body.local_calendar_id !== undefined;
      if (localCalendarProvided && resolveLocalCalendarId(db.get(), row.id) === null) {
        return refuse((r) => r.status(400).json({ error: 'Local calendars can only hold local events.', code: 400 }));
      }
      const vLocalCalendar = localCalendarProvided
        ? validateCalendarId(db.get(), req.body.local_calendar_id, { required: true })
        : null;
      if (vLocalCalendar) checks.push(vLocalCalendar);
      // Eine Person ohne Konto und ein unlesbarer Anhang endeten als 500 (#2810).
      if (req.body.assigned_to !== undefined) checks.push(validateOccurrenceAssignments(db.get(), req.body.assigned_to));
      checks.push(vAttachment);
      if (collectErrors(checks).length) return refuse((r) => sendValidationErrors(r, checks));
      const vIcon = req.body.icon !== undefined ? eventIcon(req.body.icon) : row.icon;
      if (!vIcon) return refuse((r) => r.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 }));
      // `undefined` = nicht mitgeschickt. Ein Start ist danach nie leer (siehe
      // oben), ein Ende mit '' oder `null` kommt als null an und leert es.
      const start_datetime = vStart ? vStart.value : undefined;
      const end_datetime   = vEnd ? vEnd.value : undefined;

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
      // Ein leerer Start kommt hier nicht mehr an, er ist oben schon ein 400
      // (#1364); fehlt das Feld, gilt der gespeicherte. Der Tagesvergleich
      // reicht, weil `hasAnyOccurrence` ohnehin nur den Tag liest.
      // DIESELBE FORMEL WIE DAS UPDATE UNTEN, sonst prueft der Guard einen
      // Zustand, den es nie geben wird. `recurrence_rule` steht NICHT unter
      // COALESCE: `null` loescht die Regel, statt sie stehen zu lassen. Wer die
      // Wiederholung abschaltet und dabei das Startdatum aendert, wurde sonst
      // gegen die ALTE Regel geprueft und mit 400 abgewiesen - fuer eine Serie,
      // die es nach dem Speichern gar nicht mehr gibt.
      // SERIENGRENZEN gegen eine Zeile (#2940): hier gegen den geladenen
      // Termin, in applyUpdate noch einmal gegen die Zeile, die das Schreiben
      // vorfindet - waehrend des Uploads kann eine zweite Anfrage Regel oder
      // Start geaendert haben.
      const seriesCheck = (/** @type {any} */ row) => {
        const regelDanach = recurrence_rule !== undefined
          ? (recurrence_rule || null)
          : row.recurrence_rule;
        const startDanach = start_datetime !== undefined && start_datetime !== null
          ? start_datetime
          : row.start_datetime;
        const serieBeruehrt = regelDanach !== row.recurrence_rule
          || String(startDanach ?? '').slice(0, 10) !== String(row.start_datetime ?? '').slice(0, 10);
        // DER GUARD MUSS DENSELBEN KALENDERTAG MEINEN WIE DIE EXPANSION. Ein
        // eingelesener Termin kann eine eigene Zone tragen: 31. Januar 20:00 in New
        // York steht als 1. Februar 01:00 UTC in der Zeile. Fuer "am letzten Tag des
        // Monats" zaehlt der Ortstag, also der 31. - ohne den Hinweis sah der Guard
        // den Ersten, hielt die Serie fuer leer und wies eine gueltige Bearbeitung
        // mit 400 ab. `expandRecurringEvents` nimmt die Pruefung im selben Fall
        // zurueck (`zonenUnsicher`); nur `tzid` kann diesen Zustand erzeugen, die
        // Route selbst nimmt das Feld nicht entgegen.
        // Zonenlose Ziffern sind Wanduhr des Haushalts, nie der Prozesszone (#1993).
        const wandUhr = row.tzid ? storedToWall(String(startDanach ?? ''), row.tzid, zoneOpts.zone) : null;
        const zonenUnsicher = storedDayDiffersFromSeriesDay(String(startDanach ?? ''), row.tzid, zoneOpts.zone);
        if (serieBeruehrt
          && !hasAnyOccurrence(startDanach, regelDanach, { utcDiffersFromLocal: zonenUnsicher })) {
          return { regelDanach, startDanach, refusal: 'no_occurrence' };
        }
        // EIN ENDE VOR DEM START (#1607): nur wenn DIESE Anfrage Regel oder
        // Starttag aendert. Eine eingelesene Serie, die schon so in der Zeile
        // steht, bleibt bearbeitbar.
        //
        // "STARTTAG GEAENDERT" WIRD IN EINER DARSTELLUNG VERGLICHEN, anders als
        // `serieBeruehrt` oben. Das Formular schickt die Wanduhrzeit des Haushalts;
        // ein synchronisierter Termin liegt als Instant in der Zeile, und dessen
        // UTC-Tag kann der Nachbartag sein. Am rohen Text verglichen waere ein
        // reiner Titel-Edit dort eine Startaenderung. Fuer die Pruefung darueber
        // ist das unschaedlich (sie wird dadurch nur OEFTER gefragt und nimmt sich
        // im Zweifel selbst zurueck), hier wuerde es eine Bearbeitung abweisen.
        const gespeicherterStart = String(row.start_datetime ?? '');
        const gespeicherterTag = hasExplicitZone(gespeicherterStart)
          ? (utcToWall(gespeicherterStart, zoneOpts.zone)?.date ?? gespeicherterStart.slice(0, 10))
          : gespeicherterStart.slice(0, 10);
        const startTag = String(startDanach ?? '').slice(0, 10);
        const regelGeaendert = regelDanach !== row.recurrence_rule;
        const startTagGeaendert = start_datetime !== undefined && start_datetime !== null
          && startTag !== gespeicherterTag;
        // WO DER STARTTAG VON DER LESART ABHAENGT, WIRD NICHT GERATEN - ABER AUCH
        // NICHT WEGGESEHEN. Ein Termin mit eigener Zone hat zwei Kandidaten (der
        // UTC-Tag der Zeile und der Ortstag); ohne aufloesbare Zone liegt der Ortstag
        // hoechstens einen Tag daneben. Abgewiesen wird dort nur ein Ende, das vor
        // JEDEM Kandidaten liegt, und nur bei geaenderter REGEL: die ist in jeder
        // Darstellung dieselbe Zeichenkette.
        const startKandidaten = zonenUnsicher
          ? [startTag, wandUhr?.date ?? shiftDateKey(startTag, -1)]
          : [startTag];
        const endeGefragt = zonenUnsicher ? regelGeaendert : (regelGeaendert || startTagGeaendert);
        if (endeGefragt && startKandidaten.every((tag) => endsBeforeStart(tag, regelDanach))) {
          return { regelDanach, startDanach, refusal: 'ends_before_start' };
        }
        return { regelDanach, startDanach, refusal: null };
      };
      const { regelDanach, startDanach, refusal: seriesRefusal } = seriesCheck(row);
      if (seriesRefusal) return refuse((r) => sendSeriesRefusal(r, seriesRefusal));

      if (replacementRequested && removalRequested) {
        return refuse((r) => r.status(400).json({
          error: 'attachment_data and remove_attachment contradict each other.',
          code: 400,
        }));
      }
      if ((replacementRequested || removalRequested)
          && storedAttachmentLocked(req, db.get(), row.attachment_document_id)) {
        return refuse((r) => r.status(403).json({ error: ATTACHMENT_CHANGE_REFUSAL, code: 403, reason: 'ATTACHMENT_CHANGE_REFUSED' }));
      }

      // WER START ODER REGEL IN YUVOMI AENDERT, HAT SIE VERFASST (#1935) - auch
      // an einer eingelesenen Serie. Die Marke entscheidet, ob der ausgehende
      // Weg den Start auf die eigene Regel ausrichtet (services/outbound-dtstart.js).
      // Verglichen wird der BEGINN, nicht der Text: das Formular schickt die
      // Wanduhrzeit des Haushalts, ein eingelesener Termin liegt als Zeitpunkt in
      // der Zeile. Am Text gemessen setzte jede Titelaenderung die Marke, und die
      // eingelesene Serie ginge danach mit einem anderen DTSTART zurueck (#756).
      const seriesAuthoredHere = startOrRuleChanged(row, {
        start_datetime: startDanach,
        all_day: all_day !== undefined ? all_day : row.all_day,
        recurrence_rule: regelDanach,
      }, zoneOpts.zone);

      // NICHT MITGESCHICKT HEISST: WIE DIE ZEILE (#2940).
      const targetsOf = () => {
        const caldavAccountId = vCaldav ? vCaldav.value.accountId : row.target_caldav_account_id;
        const googleTargetId = vGoogle ? vGoogle.value : row.target_google_calendar_id;
        return {
          caldavAccountId,
          caldavCalendarUrl: vCaldav ? vCaldav.value.calendarUrl : row.target_caldav_calendar_url,
          googleTargetId,
          outlookAccountId: vOutlook ? vOutlook.value.accountId : row.target_outlook_account_id,
          outlookCalendarId: vOutlook ? vOutlook.value.calendarId : row.target_outlook_calendar_id,
          localCalendarId: (caldavAccountId || googleTargetId) ? null
            : vLocalCalendar ? vLocalCalendar.value : row.local_calendar_id,
        };
      };
      const targets = targetsOf();
      if (localCalendarProvided && (targets.caldavAccountId || targets.googleTargetId)) {
        return refuse((r) => r.status(400).json({ error: 'Choose either a sync target or a local calendar.', code: 400 }));
      }

      return {
        row, vIcon, start_datetime, end_datetime, regelDanach, startDanach,
        seriesAuthoredHere, targets, caldavProvided, googleProvided, outlookProvided,
        localCalendarProvided, locationNow: locationAfterEdit(req.body.location, row.location),
      };
    };
    const checked = evaluate(loadVisibleEvent(id, req));
    if ('refuse' in checked) return checked.refuse(res);
    const event = checked.row;

    // JEDE ABWEISUNG GEHOERT VOR DAS STAGING. Ab hier laedt
    // `stageDocumentUpload` den Anhang in den Speicher (lokaler Ordner, WebDAV
    // oder Cloud); aufgeraeumt wird er nur im catch-Block ganz unten. Ein
    // fruehes `return` dazwischen laesst die hochgeladene Datei als Waise
    // liegen - sichtbar wird das nie, weil der Aufrufer seine 400 bekommt.
    // Der Serien-Guard oben stand genau deshalb schon einmal falsch herum.
    // Ein Befund ist oben schon eine 400 geworden.
    const attachment = replacementRequested
      ? /** @type {import('./helpers.js').Attachment} */ (vAttachment.value)
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
    // Nicht mitgeschickt: die Zuweisungen liest applyUpdate aus der Zeile, die
    // es vorfindet (#2940).
    const userIds = assignedTouched ? parseAssignedTo(req.body.assigned_to) : undefined;

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
    const firstUidOf = (/** @type {any} */ row, /** @type {number[]} */ ids) => (assignedTouched
      ? (ids[0] ?? null)
      : (ids.includes(row.assigned_to) ? row.assigned_to : (ids[0] ?? null)));

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
    const colorChangedFrom = (/** @type {any} */ row) => colorTouched && asColorKey(colorVal) !== asColorKey(row.color);

    /** @type {any} */
    let rowBeforeWrite = null;
    const applyUpdate = () => {
      // Der Anhang gegen den Stand, den dieses Schreiben vorfindet (#1358) -
      // und die Sichtbarkeit davor, gegen die setEventAssignments() prueft, ob
      // sich das Publikum des Anhangs aendert (#1443).
      // Und jedes Feld, das diese Anfrage nicht mitschickt (#2940): es gilt,
      // wie es JETZT in der Zeile steht. `event` wurde vor dem Upload geladen;
      // ein PUT, das in der Zwischenzeit Beschreibung oder Ort aenderte, ginge
      // sonst still verloren. Ist der Termin inzwischen geloescht, antwortet
      // die Route 404 und schreibt nichts nach.
      // Dieselbe Pruefung wie vor dem Upload, gegen die Zeile von jetzt.
      const fresh = evaluate(loadVisibleEvent(id, req));
      if ('refuse' in fresh) throw new RefusedAfterUploadError(fresh.refuse);
      const stored = fresh.row;
      rowBeforeWrite = stored;
      const storedAssignees = storedEventAssignees(db.get(), id);
      // Neu nur Haushaltsmitglieder (#1207), gegen den Stand, den dieses Schreiben vorfindet.
      if (assignedTouched) assertNoNewNonMembers(db.get(), userIds, storedAssignees);
      const assignees = assignedTouched ? userIds : storedAssignees;
      const firstUid = firstUidOf(stored, assignees);
      const colorChanged = colorChangedFrom(stored);
      const { targets, locationNow } = fresh;
      const documentId = replacementRequested
        ? rights.createAttachmentDocument(
            db.get(),
            attachment,
            stagedUpload,
            req.body,
            stored.created_by
          )
        : removalRequested
          ? null
          : stored.attachment_document_id;
      const attachmentName = replacementRequested
        ? (req.body.attachment_name || 'Attachment')
        : removalRequested
          ? null
          : stored.attachment_name;
      const attachmentMime = replacementRequested
        ? attachment.mime
        : removalRequested
          ? null
          : stored.attachment_mime;
      const attachmentSize = replacementRequested
        ? attachment.size
        : removalRequested
          ? null
          : stored.attachment_size;
      const attachmentData = replacementRequested || removalRequested
        ? null
        : stored.attachment_data;
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
            local_calendar_id = ?,
            visibility      = ?,
            -- Anzeigeeinstellung, kein gespiegeltes Feld (#647): sie steht nicht
            -- in MIRRORED_FIELDS und löst deshalb keinen Push aus. Wie bei den
            -- Nachbarfeldern gilt „nicht mitgeschickt" als „nicht angefasst" -
            -- das PUT eines Clients, der das Feld nicht kennt (Modul, ältere
            -- App), darf eine gesetzte Markierung nicht stillschweigend löschen.
            countdown       = ?,
            user_modified   = ?,
            color_modified  = ?,
            -- Wer Start oder Regel hier aendert, hat sie ab jetzt verfasst
            -- (#1935); jede andere Bearbeitung laesst die Marke, wie sie ist.
            series_authored = CASE WHEN ? THEN 1 ELSE series_authored END
        WHERE id = ?
      `).run(
        title?.trim()  ?? null,
        description !== undefined ? (description || null) : stored.description,
        fresh.start_datetime ?? null,
        fresh.end_datetime !== undefined ? (fresh.end_datetime || null) : stored.end_datetime,
        all_day !== undefined ? (all_day ? 1 : 0) : null,
        locationNow !== undefined ? (locationNow || null) : stored.location,
        colorTouched ? 1 : 0, colorVal ?? null,
        req.body.icon !== undefined ? fresh.vIcon : null,
        firstUid,
        recurrence_rule !== undefined ? (recurrence_rule || null) : stored.recurrence_rule,
        attachmentName,
        attachmentMime,
        attachmentSize,
        attachmentData,
        documentId,
        targets.caldavAccountId,
        targets.caldavCalendarUrl,
        targets.googleTargetId,
        targets.outlookAccountId,
        targets.outlookCalendarId,
        targets.localCalendarId,
        req.body.visibility !== undefined
          ? normalizeVisibility(req.body.visibility, stored.visibility)
          : stored.visibility,
        req.body.countdown !== undefined ? (req.body.countdown ? 1 : 0) : stored.countdown,
        stored.external_source !== 'local' ? 1 : stored.user_modified,
        colorChanged ? 1 : stored.color_modified,
        fresh.seriesAuthoredHere ? 1 : 0,
        id
      );
      // Eine lokale Farbwahl macht einen gespiegelten Termin dauerhaft zu
      // keiner Altlast der Farb-Heilung mehr (#1270), auch wenn er spaeter
      // wieder die alte Farbe bekommt oder die Wahl den Server nie erreicht.
      if (colorChanged && stored.external_source === 'caldav') recordLocalColorChoice(db.get(), [id]);
      setEventAssignments(db.get(), id, assignees, {
        mayWidenAttachment: rights.mayWidenAttachment,
        previous: { visibility: stored.visibility },
        attachmentSet: replacementRequested,
      });
      return stored;
    };

    // Der Weg (Serie mit Ausnahmen oder einfaches Update) nach der Zeile von
    // jetzt, nicht der von vor dem Upload - und nicht der von vor den Kopien:
    // braucht eine Ausnahme eine eigene Kopie des Anhangs, speichert
    // runWithAttachmentClonePlan nach deren Upload (await) ein zweites Mal,
    // und dieses Speichern waehlt den Weg wieder selbst (#2956).
    const usesSeriesPath = (/** @type {any} */ current) => {
      const linkedOverrideCount = db.get().prepare(`
        SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?
      `).get(id).count;
      const occurrenceBoundaryTouched = Boolean(current.recurrence_rule) && [
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
          current,
          getUserId(req),
        ).eligible;
      return linkedOverrideCount > 0
        || Boolean(current.recurrence_rule && Object.hasOwn(req.body, 'confirmed_orphan_count'))
        || canUseOccurrenceTransaction;
    };
    // WAS AN DIE AUSNAHMEN GEHT, KOMMT AUS DER ZEILE BEIM SCHREIBEN (#2940),
    // wie beim Master in applyUpdate: Kalender, Ort und Sichtbarkeit haengen
    // an ihr, und waehrend des Uploads kann eine zweite Anfrage die Serie in
    // einen anderen Kalender gelegt haben. Geprueft und gelesen wird im
    // Aufruf unten, nach dem letzten await und vor der Transaktion, ohne
    // await dazwischen.
    const seriesChangesFor = (/** @type {any} */ v) => {
      const { targets, locationNow, row, start_datetime, end_datetime, vIcon } = v;
      const { caldavProvided, googleProvided, outlookProvided, localCalendarProvided } = v;
      /** @type {Record<string, any>} */
      const seriesChanges = {};
      if (title !== undefined) seriesChanges.title = title?.trim() || null;
      if (description !== undefined) seriesChanges.description = description || null;
      if (start_datetime !== undefined) seriesChanges.start_datetime = start_datetime;
      if (end_datetime !== undefined) seriesChanges.end_datetime = end_datetime || null;
      if (all_day !== undefined) seriesChanges.all_day = all_day ? 1 : 0;
      if (locationNow !== undefined) seriesChanges.location = locationNow || null;
      if (colorTouched) seriesChanges.color = colorVal ?? null;
      if (req.body.icon !== undefined) seriesChanges.icon = vIcon;
      if (recurrence_rule !== undefined) seriesChanges.recurrence_rule = recurrence_rule || null;
      if (caldavProvided) {
        seriesChanges.target_caldav_account_id = targets.caldavAccountId;
        seriesChanges.target_caldav_calendar_url = targets.caldavCalendarUrl;
      }
      if (googleProvided) seriesChanges.target_google_calendar_id = targets.googleTargetId;
      if (outlookProvided) {
        seriesChanges.target_outlook_account_id = targets.outlookAccountId;
        seriesChanges.target_outlook_calendar_id = targets.outlookCalendarId;
      }
      if (localCalendarProvided || caldavProvided || googleProvided) seriesChanges.local_calendar_id = targets.localCalendarId;
      if (req.body.visibility !== undefined) {
        seriesChanges.visibility = normalizeVisibility(req.body.visibility, row.visibility);
      }
      if (req.body.countdown !== undefined) seriesChanges.countdown = req.body.countdown ? 1 : 0;
      return seriesChanges;
    };
    // Der einfache Weg braucht keine Kopie und laeuft im ersten Aufruf, ohne
    // await davor; der Serienweg kann einen zweiten Aufruf nach den Kopien
    // brauchen. Beide fragen Pruefung und Weg gegen die Zeile von jetzt.
    await runWithAttachmentClonePlan(
      db.get(),
      stagedClones,
      (cloneOptions) => {
        const now = evaluate(loadVisibleEvent(id, req));
        if ('refuse' in now) throw new RefusedAfterUploadError(now.refuse);
        if (!usesSeriesPath(now.row)) {
          withTx(db.get(), () => {
            const before = applyUpdate();
            // Ausnahmen tragen den Originalstart (#2034, Format A): aendert sich
            // die Uhr der Serie, wandern sie in derselben Transaktion mit.
            if (before.recurrence_rule) {
              const after = db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
              rekeySeriesAfterUpdate(db.get(), before, after, householdTimeZone(db.get()));
            }
          });
          return undefined;
        }
        return updateSeriesWithOverrides(db.get(), {
          mayWidenAttachment: rights.mayWidenAttachment,
          seriesId: id,
          actorId: getUserId(req),
          isAdmin: isAdminRequest(req),
          changes: seriesChangesFor(now),
          assignments: assignedTouched ? userIds : undefined,
          confirmedOrphanCount: req.body.confirmed_orphan_count,
          applyUpdate,
          authorizeActor: false,
          ...cloneOptions,
        });
      },
      { mayClone: rights.mayCloneAttachment },
    );
    stagedUpload = null;

    // Änderung an einem synchronisierten Termin beim Provider nachziehen (#593):
    // geänderte Felder als Patch, ein gewechselter Zielkalender als Umzug.
    // Wie beim Löschen: vormerken, antworten, danach best effort ausführen.
    // Vorgemerkt wird VOR dem Lesen der Antwort: deren Quelle folgt einem
    // anstehenden Umzug, und ohne ihn filterte die Seite den Termin bis zum
    // nächsten Laden weiter als Teil des alten Kalenders (#1064).
    const pending = markEventOutbound(
      rowBeforeWrite ?? event,
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
             lc.id AS local_calendar_id,
             lc.name  AS local_calendar_name,
             ${localCalendarColorSql()} AS local_calendar_color,
             ${SOURCE_CALENDAR_COLUMNS},
             ${ASSIGNED_USERS_SQL}
      FROM calendar_events e
      LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
      LEFT JOIN users u_created  ON u_created.id  = e.created_by
      LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
      LEFT JOIN local_calendars lc ON lc.id = ${localCalendarIdSql()}
      ${SOURCE_CALENDAR_JOIN}
      LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
      WHERE e.id = ?
    `).get(id);

    res.json({ data: serializeEvent(updated, {
      viewer: documentViewer(req),
      database: db.get(),
      actorId: getUserId(req),
      isAdmin: isAdminRequest(req),
      master: updated,
    }) });

    // Ein lokaler Termin, der erst jetzt ein Sync-Ziel bekam oder noch auf
    // seinen Upload wartet, geht ebenfalls sofort hinauf (#2565).
    if (pending || waitsForUpload(updated)) {
      flushOutbound()
        .catch((e) => log.warn('Änderung vorgemerkt, Sofortversuch fehlgeschlagen:', e.message));
    }
  } catch (err) {
    const staged = [stagedUpload, ...stagedClones].filter(Boolean);
    if (err instanceof CalendarOccurrenceError && staged.length === 0) {
      return sendCalendarOccurrenceError(res, err);
    }
    if (err instanceof NonMemberAssignmentError) return sendNonMemberAssignment(res, err, staged);
    if (err instanceof RefusedAfterUploadError) return sendRefusalAfterUpload(res, err.respond, staged);
    if (err instanceof StorageError && staged.length === 0) {
      log.error('PUT /:id storage error:', err);
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    // Ein unerwarteter Fehler geht an den zentralen Handler (#2810) - aber
    // erst, wenn Anhang und Kopien wieder weg sind.
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
    throw err;
  }
});

// --------------------------------------------------------
// PUT /api/v1/calendar/:seriesId/occurrences/:recurrenceId
// Creates or updates one linked local recurrence replacement atomically.
// --------------------------------------------------------
router.put('/:seriesId/occurrences/:recurrenceId', refuseUploadWithoutDocumentsWrite, validateRequest(), async (req, res) => {
  if (Object.hasOwn(req.body, 'local_calendar_id')) {
    return res.status(400).json({ error: 'Calendar membership applies to the whole series.', code: 400 });
  }
  let stagedUpload;
  try {
    const seriesId = pathId(req, 'seriesId');
    const actorId = getUserId(req);
    const isAdmin = isAdminRequest(req);
    const master = loadVisibleEvent(seriesId, req);
    if (!master) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'Calendar series not found.',
        { status: 404, code: 'calendar_series_not_found' },
      ));
    }
    if (refuseForeignEvent(req, res, master)) return;
    const eligibility = isEligibleLocalSeries(db.get(), master, actorId);
    if (!eligibility.eligible) {
      const unauthorized = eligibility.reason === 'not_authorized';
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
        { status: unauthorized ? 403 : 400, code: eligibility.reason },
      ));
    }
    // Beide Schluesselformen (#2034); trifft die alte zwei Vorkommen, 409.
    baseOccurrenceFor(master, req.params.recurrenceId, householdTimeZone(db.get()), { ambiguous: 'reject' });

    const mutation = validateOccurrenceMutationBody(db.get(), req.body, { master });
    const { values: validated } = mutation;
    // Ein Anhang, den die Route nicht nehmen kann, ist eine 400 vor jedem
    // Hochladen und Schreiben (#2810); bis dahin warf parseAttachment (500).
    const vAttachment = parseAttachment(req.body.attachment_data);
    const errors = vAttachment.error ? [...mutation.errors, vAttachment.error] : mutation.errors;
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const vIcon = req.body.icon !== undefined ? eventIcon(req.body.icon) : undefined;
    if (req.body.icon !== undefined && !vIcon) {
      return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });
    }
    if (req.body.reminder_offsets !== undefined
        && (!Array.isArray(req.body.reminder_offsets)
          || req.body.reminder_offsets.length > MAX_REMINDER_OFFSETS
          || new Set(req.body.reminder_offsets).size !== req.body.reminder_offsets.length
          || req.body.reminder_offsets.some((value) =>
            !Number.isInteger(value) || value < 0))) {
      return res.status(400).json({
        error: 'reminder_offsets: at most five distinct lead times in whole minutes from 0.',
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
        error: 'attachment_data and remove_attachment contradict each other.',
        code: 400,
      });
    }
    if ((replacementRequested || removalRequested)
        && storedAttachmentLocked(req, db.get(), storedOccurrenceAttachmentDocument(db.get(), master, req.params.recurrenceId))) {
      return res.status(403).json({ error: ATTACHMENT_CHANGE_REFUSAL, code: 403, reason: 'ATTACHMENT_CHANGE_REFUSED' });
    }
    // Ein Befund ist oben schon eine 400 geworden.
    const parsedAttachment = replacementRequested
      ? /** @type {import('./helpers.js').Attachment} */ (vAttachment.value)
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

    // Synchron nach dem letzten await: die Serie, Bestandsliste und Anhang,
    // wie sie JETZT stehen (#1358, #2956) - nicht die Zeile von vor dem Upload.
    const current = seriesAfterUpload(seriesId, req);
    assertNoNewNonMembers(db.get(), mutation.assignments, storedOccurrenceAssignees(db.get(), current, req.params.recurrenceId));
    assertAttachmentStillChangeable(req, db.get(),
      storedOccurrenceAttachmentDocument(db.get(), current, req.params.recurrenceId),
      { replacementRequested, removalRequested });
    const rights = attachmentRights(req);
    const result = upsertOccurrenceOverride(db.get(), {
      mayWidenAttachment: rights.mayWidenAttachment,
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
            attachment_document_id: rights.createAttachmentDocument(
              db.get(),
              parsedAttachment,
              stagedUpload,
              req.body,
              current.created_by,
            ),
          })
        : undefined,
      reminderOffsets: req.body.reminder_offsets === undefined
        ? undefined
        : [...new Set(req.body.reminder_offsets)],
    });

    res.json({
      data: serializeEvent({ ...result.event, ...localCalendarProjection(db.get(), result.event.id) }, {
        viewer: documentViewer(req),
        database: db.get(),
        actorId,
        isAdmin,
        master: current,
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
    if (err instanceof NonMemberAssignmentError) return sendNonMemberAssignment(res, err, [stagedUpload].filter(Boolean));
    if (err instanceof AttachmentLockedError) return sendAttachmentLocked(res, [stagedUpload].filter(Boolean));
    // Ein unerwarteter Fehler geht an den zentralen Handler (#2810) - aber
    // erst, wenn der bereitgestellte Anhang wieder weg ist.
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
    // A storage refusal after the upload (#2946: the settings changed meanwhile).
    if (err instanceof StorageError) {
      return sendStorageError(res, err, 'Calendar attachment storage upload failed.');
    }
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    throw err;
  }
});

router.put('/:seriesId/occurrences/:recurrenceId/following', refuseUploadWithoutDocumentsWrite, validateRequest(), async (req, res) => {
  let stagedUpload;
  const stagedClones = [];
  try {
    const seriesId = pathId(req, 'seriesId');
    const actorId = getUserId(req);
    const isAdmin = isAdminRequest(req);
    const master = loadVisibleEvent(seriesId, req);
    if (!master) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'Calendar series not found.',
        { status: 404, code: 'calendar_series_not_found' },
      ));
    }
    if (refuseForeignEvent(req, res, master)) return;
    const eligibility = isEligibleLocalSeries(db.get(), master, actorId);
    if (!eligibility.eligible) {
      const unauthorized = eligibility.reason === 'not_authorized';
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
        { status: unauthorized ? 403 : 400, code: eligibility.reason },
      ));
    }
    const seriesZone = householdTimeZone(db.get());
    const selectedBase = baseOccurrenceFor(master, req.params.recurrenceId, seriesZone, { ambiguous: 'reject' });

    const mutation = validateOccurrenceMutationBody(db.get(), req.body, { following: true, master });
    const { values: validated } = mutation;
    const caldavProvided = req.body.target_caldav_account_id !== undefined
      || req.body.target_caldav_calendar_url !== undefined;
    const googleProvided = req.body.target_google_calendar_id !== undefined;
    const outlookProvided = req.body.target_outlook_account_id !== undefined
      || req.body.target_outlook_calendar_id !== undefined;
    const vCaldav = caldavProvided ? caldavTarget(req.body) : null;
    const vGoogle = googleProvided ? googleTarget(req.body) : null;
    const vOutlook = outlookProvided ? outlookTarget(req.body) : null;
    // Ein Anhang, den die Route nicht nehmen kann, ist eine 400 vor jedem
    // Hochladen und Schreiben (#2810); bis dahin warf parseAttachment (500).
    const vAttachment = parseAttachment(req.body.attachment_data);
    const errors = [
      ...mutation.errors,
      ...[vCaldav, vGoogle, vOutlook, vAttachment].filter(Boolean),
      // Ein NEUES Ziel muss angeboten sein; das der Serie kommt durch (#1860).
      ...(vCaldav && !vCaldav.error ? [caldavTargetOffered(db.get(), vCaldav.value, master)] : []),
    ].flatMap((result) => typeof result === 'string' ? [result] : (result.error ? [result.error] : []));
    if (errors.length) {
      return res.status(400).json({
        error: errors.join(' '),
        code: 400,
        ...(mutation.calendarGone ? { reason: 'calendar_selected_calendar_not_found' } : {}),
      });
    }
    const vIcon = req.body.icon !== undefined ? eventIcon(req.body.icon) : undefined;
    if (req.body.icon !== undefined && !vIcon) {
      return res.status(400).json({ error: 'icon: invalid calendar event icon.', code: 400 });
    }
    if (req.body.reminder_offsets !== undefined
        && (!Array.isArray(req.body.reminder_offsets)
          || req.body.reminder_offsets.length > MAX_REMINDER_OFFSETS
          || new Set(req.body.reminder_offsets).size !== req.body.reminder_offsets.length
          || req.body.reminder_offsets.some((value) =>
            !Number.isInteger(value) || value < 0))) {
      return res.status(400).json({
        error: 'reminder_offsets: at most five distinct lead times in whole minutes from 0.',
        code: 400,
      });
    }

    assertSuccessorHasOccurrence({
      ...master,
      start_datetime: validated.start_datetime ?? selectedBase.start_datetime,
      recurrence_rule: Object.hasOwn(req.body, 'recurrence_rule')
        ? validated.recurrence_rule
        : master.recurrence_rule,
    }, seriesZone);

    const replacementRequested = typeof req.body.attachment_data === 'string'
      && req.body.attachment_data.trim() !== '';
    const removalRequested = req.body.remove_attachment === true
      || (Object.hasOwn(req.body, 'attachment_data') && req.body.attachment_data === null);
    if (replacementRequested && removalRequested) {
      return res.status(400).json({
        error: 'attachment_data and remove_attachment contradict each other.',
        code: 400,
      });
    }
    if ((replacementRequested || removalRequested)
        && storedAttachmentLocked(req, db.get(), storedOccurrenceAttachmentDocument(db.get(), master, req.params.recurrenceId))) {
      return res.status(403).json({ error: ATTACHMENT_CHANGE_REFUSAL, code: 403, reason: 'ATTACHMENT_CHANGE_REFUSED' });
    }
    // Ziel oder lokaler Kalender: hier gegen die geladene Zeile, je Lauf gegen die von jetzt (#2956).
    const syncTargetOf = (/** @type {any} */ row) => (caldavProvided ? vCaldav.value.accountId : row.target_caldav_account_id)
      || (googleProvided ? vGoogle.value : row.target_google_calendar_id);
    if (Object.hasOwn(req.body, 'local_calendar_id') && syncTargetOf(master)) return res.status(400).json({ error: LOCAL_NEXT_TO_TARGET, code: 400 });
    // Ein Befund ist oben schon eine 400 geworden.
    const parsedAttachment = replacementRequested
      ? /** @type {import('./helpers.js').Attachment} */ (vAttachment.value)
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
      'local_calendar_id',
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
    const rights = attachmentRights(req);
    let seriesNow = /** @type {any} */ (master);
    const commonOptions = {
      mayWidenAttachment: rights.mayWidenAttachment,
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
            attachment_document_id: rights.createAttachmentDocument(
              db.get(),
              parsedAttachment,
              stagedUpload,
              req.body,
              seriesNow.created_by,
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
      stagedClones,
      (cloneOptions) => {
        // Je Lauf, synchron nach dem letzten await: alles, wie es JETZT steht (#1358, #2956).
        const run = followingSeriesNow({ seriesId, req, actorId, baseChanges: changes, syncTargetOf }); seriesNow = run.now;
        assertNoNewNonMembers(db.get(), mutation.assignments, storedOccurrenceAssignees(db.get(), seriesNow, req.params.recurrenceId));
        assertAttachmentStillChangeable(req, db.get(),
          storedOccurrenceAttachmentDocument(db.get(), seriesNow, req.params.recurrenceId),
          { replacementRequested, removalRequested });
        return splitSeries(db.get(), { ...commonOptions, changes: run.changes, ...cloneOptions });
      },
      { mayClone: rights.mayCloneAttachment },
    );
    stagedUpload = null;
    res.status(result.wholeSeries ? 200 : 201).json({
      data: serializeEvent({ ...result.series, ...localCalendarProjection(db.get(), result.series.id) }, {
        viewer: documentViewer(req),
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
    if (err instanceof NonMemberAssignmentError) return sendNonMemberAssignment(res, err, staged);
    if (err instanceof AttachmentLockedError) return sendAttachmentLocked(res, staged);
    if (err instanceof RefusedAfterUploadError) return sendRefusalAfterUpload(res, err.respond, staged);
    // Ein unerwarteter Fehler geht an den zentralen Handler (#2810) - aber
    // erst, wenn Anhang und Kopien wieder weg sind.
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
    throw err;
  }
});

router.delete('/:seriesId/occurrences/:recurrenceId', validateRequest(), (req, res) => {
  try {
    const seriesId = pathId(req, 'seriesId');
    const master = loadVisibleEvent(seriesId, req);
    if (!master) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'Calendar series not found.',
        { status: 404, code: 'calendar_series_not_found' },
      ));
    }
    if (refuseForeignEvent(req, res, master)) return;
    deleteOccurrence(db.get(), {
      seriesId,
      recurrenceId: req.params.recurrenceId,
      actorId: getUserId(req),
      isAdmin: isAdminRequest(req),
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    throw err;
  }
});

router.delete('/:seriesId/occurrences/:recurrenceId/following', validateRequest(), (req, res) => {
  try {
    const seriesId = pathId(req, 'seriesId');
    const master = loadVisibleEvent(seriesId, req);
    if (!master) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'Calendar series not found.',
        { status: 404, code: 'calendar_series_not_found' },
      ));
    }
    if (refuseForeignEvent(req, res, master)) return;
    truncateSeries(db.get(), {
      seriesId,
      recurrenceId: req.params.recurrenceId,
      actorId: getUserId(req),
      isAdmin: isAdminRequest(req),
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    throw err;
  }
});

// --------------------------------------------------------
// POST /api/v1/calendar/:id/reset
// ICS-Event auf Original zurücksetzen (user_modified = 0).
// Nur Event-Creator, Subscription-Creator oder Admin.
// Response: { data: { reset: true } }
// --------------------------------------------------------
router.post('/:id/reset', validateRequest(), (req, res) => {
  const id    = pathId(req);
  const event = db.get().prepare(`
    SELECT e.*, s.created_by AS sub_created_by
    FROM calendar_events e
    LEFT JOIN ics_subscriptions s ON s.id = e.subscription_id
    WHERE e.id = ?
  `).get(id);
  // Unsichtbar heisst auch hier "gibt es nicht" (wie GET/PUT/DELETE /:id):
  // sonst verriete die 400 einen fremden privaten Termin und die 403 einen
  // Termin aus einem fremden ungeteilten Abo, und ein Admin setzte einen
  // Termin zurueck, den er nicht sieht. Die Rechteregel darunter bleibt.
  if (!event || !loadVisibleEvent(id, req)) return sendEventGone(res);
  if (event.external_source !== 'ics')
    return res.status(400).json({ error: 'Only events from an ICS subscription can be reset.', code: 400 });

  const userId  = getUserId(req);
  const isAdmin = isAdminRequest(req);
  if (!isAdmin && event.created_by !== userId && event.sub_created_by !== userId)
    return res.status(403).json({ error: 'Not authorized.', code: 403 });

  // D#2330: der gespeicherte Feed-Stand stellt den Termin sofort her, ohne Netz.
  // Fehlt er (Altbestand vor Migration 273 oder unlesbar), wird nur das Flag
  // zurückgenommen und restored=false gemeldet: der nächste Abgleich schreibt
  // den Stand, bis dahin ist der Reset nicht vollständig.
  let feed = null;
  if (event.feed_original) {
    try { feed = JSON.parse(event.feed_original); } catch { feed = null; }
  }

  // `color_modified` geht mit: Zurücksetzen heisst "der Feed führt diesen
  // Termin wieder", und das schliesst seine Farbe ein (#899).
  withTx(db.get(), () => {
    if (feed) {
      // Titel und Start sind NOT NULL: fehlt der Wert im Feed-Stand, bleibt der aktuelle.
      const startDt = feed.start_datetime ?? event.start_datetime;
      db.get().prepare(`
        UPDATE calendar_events
        SET user_modified = 0, color_modified = 0,
            title = ?, description = ?, start_datetime = ?, end_datetime = ?,
            all_day = ?, location = ?, color = ?
        WHERE id = ?
      `).run(
        feed.title ?? event.title, feed.description ?? null, startDt, feed.end_datetime ?? null,
        feed.all_day ? 1 : 0, feed.location ?? null, feed.color ?? null, id,
      );
      // Ein verlegter Start zieht die Erinnerungen mit, wie beim Abgleich (#1377).
      if (startDt !== event.start_datetime)
        followInboundStartChange(db.get(), id, event.start_datetime, startDt);
    } else {
      db.get().prepare('UPDATE calendar_events SET user_modified = 0, color_modified = 0 WHERE id = ?').run(id);
    }
  });
  res.json({ data: { reset: true, restored: feed !== null } });
});

// --------------------------------------------------------
// POST /api/v1/calendar/:id/exceptions
// Nimmt ein einzelnes Vorkommen einer lokalen Serie aus (EXDATE, #489).
// Body: { recurrence_id } - das Vorkommen, wie GET /calendar es nennt (#2034,
// Format A: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SSZ` oder `YYYY-MM-DDTHH:MM:SS`).
// Weiter angenommen: { date: 'YYYY-MM-DD' } in der alten Lesart; trifft sie
// zwei Vorkommen (Umstellungsnacht), 409 `ambiguous_recurrence_id`.
// Gespeichert wird immer der exakte Schluessel des getroffenen Vorkommens.
// Nur lokale (nicht extern synchronisierte) wiederkehrende Termine.
// Response: 201 { data: { event_id, exception_date } }
// --------------------------------------------------------
router.post('/:id/exceptions', validateRequest(), (req, res) => {
  try {
    const id = pathId(req);

    const requested = req.body?.recurrence_id ?? req.body?.date;
    // Beide Formfehler tragen einen Grund (#1909-Muster): der Browser sagt dazu
    // einen eigenen Satz statt des Servertexts.
    const malformed = req.body?.recurrence_id === undefined
      ? !DATE_RE.test(requested || '')
      : !isOccurrenceKey(requested);
    if (malformed) {
      return sendCalendarOccurrenceError(res, new CalendarOccurrenceError(
        'recurrence_id (or date) is not an occurrence key.',
        { status: 400, code: 'malformed_recurrence_id' },
      ));
    }

    const event = loadVisibleEvent(id, req);
    if (!event) return sendEventGone(res);
    if (refuseForeignEvent(req, res, event)) return;
    const eligibility = isEligibleLocalSeries(db.get(), event, getUserId(req));
    if (!isLocallyOwnedSeries(db.get(), event)) {
      const notSeries = !event.recurrence_rule;
      return res.status(400).json({
        error: notSeries
          ? 'The event is not a series.'
          : 'This series cannot use single exceptions.',
        code: 400,
        reason: eligibility.reason,
      });
    }

    // Das Vorkommen aufloesen und seinen exakten Schluessel speichern: eine
    // Ausnahme in Format A blendet genau dieses aus, auch in der
    // Umstellungsnacht (#2034). Kein Vorkommen: 400; alte Form mit zwei
    // Treffern: 409.
    const slot = baseOccurrenceFor(event, requested, householdTimeZone(db.get()), { ambiguous: 'reject' });
    const exceptionKey = occurrenceSlotOf(slot)?.key ?? requested;
    db.get().prepare(
      'INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)'
    ).run(id, exceptionKey);

    res.status(201).json({ data: { event_id: id, exception_date: exceptionKey, recurrence_id: exceptionKey } });
  } catch (err) {
    if (err instanceof CalendarOccurrenceError) return sendCalendarOccurrenceError(res, err);
    throw err;
  }
});

// --------------------------------------------------------
// DELETE /api/v1/calendar/:id
// Termin löschen. Ein nach Google gespiegelter Termin wird dort ebenfalls
// gelöscht (#593) - vorgemerkt vor dem lokalen DELETE (danach ist die Zeile
// mitsamt der Google-Event-ID weg), ausgeführt asynchron nach der Antwort.
// Response: 204 No Content
// --------------------------------------------------------
router.delete('/:id', validateRequest(), (req, res) => {
  const id    = pathId(req);
  const event = loadVisibleEvent(id, req);
  if (!event) return sendEventGone(res);
  if (refuseForeignEvent(req, res, event)) return;
  if (rejectLinkedOccurrenceResource(res, event, req)) return;
  const queued = queueEventDeletion(event);

  // Die Erinnerungen abzuraeumen ist seit Migration v217 Sache eines
  // AFTER-DELETE-Triggers auf `calendar_events` - dieser Block hier ist
  // seitdem der Guertel zum Hosentraeger und findet im Normalfall nichts
  // mehr. Er bleibt stehen, weil er die Absicht an der Stelle ausspricht, an
  // der sie entsteht; die Regel selbst darf nur nicht in dieser Route WOHNEN
  // (Google-/ICS-/CalDAV-Sync und calendar-prune.js loeschen Termine ohne je
  // hier vorbeizukommen).
  const result = withTx(db.get(), () => {
    const ownedIds = db.get().prepare(`
      SELECT id FROM calendar_events
      WHERE id = ? OR recurrence_parent_id = ?
    `).all(id, id).map((row) => Number(row.id));
    if (ownedIds.length) {
      const ownedList = sqlInList(ownedIds);
      db.get().prepare(`
        DELETE FROM reminders
        WHERE entity_type = 'event'
          AND entity_id IN (${ownedList.sql})
      `).run(ownedList.param);
    }
    return db.get().prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  });
  if (result.changes === 0) return sendEventGone(res);

  res.status(204).end();

  // Bewusst nach der Antwort: der Provider-Aufruf darf das lokale Löschen weder
  // verzögern noch scheitern lassen. Schlägt er fehl, bleibt der Tombstone
  // liegen und der nächste Sync-Lauf holt die Löschung nach.
  if (queued) {
    flushOutbound()
      .catch((err) => log.warn('Löschung vorgemerkt, Sofortversuch fehlgeschlagen:', err.message));
  }
});

export default router;
