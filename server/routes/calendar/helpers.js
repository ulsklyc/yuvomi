/**
 * Modul: Kalender (Calendar) - geteilte Helfer & Konstanten
 * Zweck: Zustandslose Helfer und Konstanten, die von mehreren Kalender-Sub-Routern
 *        genutzt werden. Aufgeteilt aus server/routes/calendar.js (God-File-Split).
 */

import { StorageError } from '../../services/document-storage.js';
import { ensureModuleFolder } from '../../services/document-folders.js';
import { documentViewer } from '../../services/document-links.js';
import {
  mayWriteModule,
  filterVisible,
} from '../../authorize/index.ts';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '../../utils/upload-limit.js';
import { readDataUrlFile } from '../../utils/data-url-file.js';
import {
  buildRecurrenceCapabilityMap, isLinkedOccurrence,
  parseOverrideFields, recurrenceIdFor, seriesIdFor,
} from '../../services/calendar-occurrence-overrides.js';
import { personAvatarUrlSql } from '../../services/person-avatar.js';
import { seriesReadingZone } from '../../services/calendar-events.js';

// The event assignment write path lives in a service so the calendar syncs reach
// it without importing a route; re-exported here for the calendar routes.
export { setEventAssignments } from '../../services/event-assignments.ts';

// The source filter of `GET /calendar` (server/services/calendar-fields.js, #2810).
export { VALID_SOURCES } from '../../services/calendar-fields.js';
// Ein Termin-Anhang ist ein Upload wie jeder andere und teilt deshalb die
// gemeinsame Grenze (#806).
export const MAX_ATTACHMENT_BYTES = MAX_UPLOAD_BYTES;
// Nur noch die Beschriftung, falls der Client keine mitschickt - die
// Identitaet des Ordners traegt seit v157 der Schluessel `calendarItems`.
export const DEFAULT_ATTACHMENT_FOLDER = 'Calendar items';
export const ATTACHMENT_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
export const ICS_COLOR_RE   = /^#[0-9a-fA-F]{6}$/;
export const VALID_EVENT_ICONS = new Set([
  'calendar', 'tooth', 'drill', 'alarm-clock', 'clock', 'bell', 'map-pin', 'home',
  'house', 'building', 'hospital', 'stethoscope', 'syringe', 'pill',
  'tablets', 'bandage', 'ambulance', 'heart-pulse', 'activity', 'cross',
  'scissors', 'shower-head', 'dumbbell', 'trophy', 'car', 'bus', 'train',
  'tram-front', 'plane', 'plane-takeoff', 'fuel', 'parking-meter',
  'traffic-cone', 'navigation', 'bike', 'route', 'briefcase', 'laptop', 'monitor',
  'presentation', 'school', 'graduation-cap', 'book-open', 'library',
  'pencil', 'notebook-pen', 'calculator', 'utensils', 'cooking-pot',
  'coffee', 'cake', 'croissant', 'pizza', 'ice-cream', 'beer', 'wine',
  'popcorn', 'sandwich', 'salad', 'shopping-bag', 'shopping-cart', 'gift',
  'package', 'shirt', 'tag', 'credit-card', 'wallet', 'banknote', 'coins',
  'piggy-bank', 'receipt', 'landmark', 'music', 'guitar', 'film', 'theater',
  'ticket', 'gamepad-2', 'camera', 'party-popper', 'balloon', 'users', 'baby', 'dog',
  'cat', 'paw-print', 'wrench', 'hammer', 'paintbrush', 'lightbulb', 'sofa',
  'bed', 'bath', 'washing-machine', 'refrigerator', 'star', 'flag', 'target',
  'flame', 'leaf', 'tree-pine', 'flower', 'sun', 'moon', 'cloud-sun',
]);

export function getUserId(req) {
  const candidates = [req.authUserId, req.user?.id, req.session?.userId];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}


export function eventIcon(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'calendar';
  const icon = raw === 'drill' ? 'tooth' : raw;
  return VALID_EVENT_ICONS.has(icon) ? icon : null;
}

/** Der Satz je Befund von readDataUrlFile; Teil der Antwort, deshalb fest. */
const ATTACHMENT_REFUSALS = Object.freeze({
  shape: 'attachment_data must be a base64 data URL.',
  type: 'attachment_data: this file type is not allowed.',
  empty: 'attachment_data: the file is empty.',
  size: `attachment_data: the file may be at most ${MAX_UPLOAD_MB} MB.`,
  content: 'attachment_data: the content does not match the declared file type.',
});

/**
 * Ein gelesener Anhang, oder keiner (leer oder nicht gesendet).
 * @typedef {{ mime: null, size: null, buffer: null } | { mime: string, size: number, buffer: Buffer }} Attachment
 */

/** @type {Attachment} */
const NO_ATTACHMENT = Object.freeze({ mime: null, size: null, buffer: null });

/**
 * Den Anhang eines Termins lesen, im Stil der formats.ts-Helfer (#2810): ein
 * Anhang, den die Route nicht nehmen kann (keine base64-Data-URL, Typ nicht
 * auf der Liste, leer, über der Upload-Grenze, Inhalt passt nicht zum Typ),
 * ist ein Befund für die `checks` der Route und damit eine 400, bevor etwas
 * geschrieben oder hochgeladen wird. Bis #2810 warf diese Funktion, und die
 * Routen antworteten 500. Leer oder kein Text ist kein Anhang und kein Fehler.
 * @param {unknown} dataUrl
 * @returns {{ value: Attachment, error: null } | { value: null, error: string }}
 */
export function parseAttachment(dataUrl) {
  const raw = typeof dataUrl === 'string' ? dataUrl.trim() : '';
  if (!raw) return { value: NO_ATTACHMENT, error: null };
  const read = readDataUrlFile(raw, { allowed: ATTACHMENT_MIME, maxBytes: MAX_ATTACHMENT_BYTES });
  if (read.fault !== null) return { value: null, error: ATTACHMENT_REFUSALS[read.fault] };
  const { mime, size, buffer } = read.file;
  return { value: { mime, size, buffer }, error: null };
}

// CalDAV-Ziel eines Events validieren (Issue #241). Liefert {value, error}
// im Stil der formats.ts-Helfer, damit collectErrors 400 statt 500 erzeugt.
// Leere/fehlende account_id bedeutet "Lokal" (kein Outbound-Sync).
export function caldavTarget(body) {
  const rawId  = body.target_caldav_account_id;
  const rawUrl = body.target_caldav_calendar_url;
  if (rawId === null || rawId === undefined || rawId === '') {
    return { value: { accountId: null, calendarUrl: null }, error: null };
  }
  const accountId = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return { value: null, error: 'target_caldav_account_id is not a valid account id.' };
  }
  const calendarUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!calendarUrl) {
    return { value: null, error: 'target_caldav_calendar_url is required for a CalDAV target.' };
  }
  if (calendarUrl.length > 2048) {
    return { value: null, error: 'target_caldav_calendar_url is too long.' };
  }
  return { value: { accountId, calendarUrl }, error: null };
}

/**
 * Ist das CalDAV-Ziel eines, das angeboten wird (#1860)? `caldavTarget` prüft
 * nur die Form; hier geht es um den Inhalt.
 *
 * EIN ZIEL IST EIN PAAR aus Konto und Kalender, und zwar aus der
 * EINGESCHALTETEN Auswahl dieses Kontos - dieselbe Menge, die
 * `GET /calendar/sync-targets` dem Formular liefert und aus der der Upload
 * seine Termine nimmt (`localUploadsOf` in services/caldav-sync.js). Konto und
 * Kalender einzeln zu prüfen reichte nicht: beides kann es geben, ohne dass
 * der Kalender zu diesem Konto gehört.
 *
 * EIN GESPIEGELTER TERMIN wechselt den Kalender nur innerhalb des Kontos, dem
 * er gehört (`caldav_account_id`): ein Umzug ist ein Anlegen und Löschen über
 * dieses eine Konto.
 *
 * EIN UNVERÄNDERTES ZIEL kommt ohne Prüfung durch, wie die unveränderte
 * Wiederholungsregel in der Route. Das Formular trägt ein gespeichertes Ziel,
 * das die Liste nicht mehr nennt (abgewählt, oder nur lesbar geteilt, #1840),
 * als eigene Option nach und schickt es unverändert zurück, wie API-Clients
 * auch: ein inzwischen abgewählter oder nur lesbarer Kalender verhindert so
 * keine Bearbeitung des Termins und wird nicht still geleert. Gesendet wird an
 * ein solches Ziel trotzdem nichts.
 *
 * @param {object} database
 * @param {{accountId: number|null, calendarUrl: string|null}} target  Ergebnis von `caldavTarget`
 * @param {object|null} [event]  die bestehende Zeile beim Bearbeiten
 * @returns {{value: object, error: string|null}}
 */
export function caldavTargetOffered(database, target, event = null) {
  const ok = { value: target, error: null };
  if (!target || target.accountId === null) return ok;
  if (event
      && event.target_caldav_account_id === target.accountId
      && event.target_caldav_calendar_url === target.calendarUrl) {
    return ok;
  }
  if (event?.external_source === 'caldav' && event.caldav_account_id !== target.accountId) {
    return { value: null, error: 'target_caldav_account_id: a synced event can only move to a calendar of its own account.' };
  }
  const offered = database.prepare(`
    SELECT writable FROM caldav_calendar_selection
    WHERE account_id = ? AND calendar_url = ? AND enabled = 1
  `).get(target.accountId, target.calendarUrl);
  if (!offered) {
    return { value: null, error: 'target_caldav_calendar_url is not an enabled calendar of this account.' };
  }
  // Ein nur lesbarer Kalender wird nicht angeboten (#1840) und auch nicht
  // angenommen: jeder Upload dorthin wäre abgewiesen worden.
  if (offered.writable === 0) {
    return { value: null, error: 'target_caldav_calendar_url: this calendar does not accept new events.' };
  }
  return ok;
}

// Outlook-Push-Ziel eines Events validieren (Muster caldavTarget). Leere/fehlende
// account_id bedeutet "Lokal" (kein Push zu Outlook).
export function outlookTarget(body) {
  const rawId  = body.target_outlook_account_id;
  const rawCal = body.target_outlook_calendar_id;
  if (rawId === null || rawId === undefined || rawId === '') {
    return { value: { accountId: null, calendarId: null }, error: null };
  }
  const accountId = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return { value: null, error: 'target_outlook_account_id is not a valid account id.' };
  }
  const calendarId = typeof rawCal === 'string' ? rawCal.trim() : '';
  if (!calendarId) {
    return { value: null, error: 'target_outlook_calendar_id is required for an Outlook target.' };
  }
  if (calendarId.length > 2048) {
    return { value: null, error: 'target_outlook_calendar_id is too long.' };
  }
  return { value: { accountId, calendarId }, error: null };
}

// Google-Outbound-Ziel eines Events validieren (Issue #237). Leeres/fehlendes
// Feld bedeutet "Lokal" (kein Outbound zu Google).
export function googleTarget(body) {
  const raw = body.target_google_calendar_id;
  if (raw === null || raw === undefined || raw === '') {
    return { value: null, error: null };
  }
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return { value: null, error: null };
  if (id.length > 2048) {
    return { value: null, error: 'target_google_calendar_id is too long.' };
  }
  return { value: id, error: null };
}

/**
 * Termin-Anhaenge landen im Systemordner `calendarItems`. Die Aufloesung
 * kommt aus `services/document-folders.js` - sie stand hier in einer zweiten
 * Kopie neben der in `routes/documents.js`, und beide suchten ueber den
 * uebersetzten Namen statt ueber den Schluessel (Migration v157).
 */
export function ensureDocumentFolder(database, name, actorId) {
  return ensureModuleFolder(database, { key: 'calendarItems', name }, actorId);
}

export function createAttachmentDocument(database, attachment, staged, body, actorId) {
  if (!attachment?.buffer || !staged) return null;
  const originalName = String(body.attachment_name || 'Attachment').trim() || 'Attachment';
  const folderId = ensureDocumentFolder(database, body.document_folder_name || DEFAULT_ATTACHMENT_FOLDER, actorId);
  const result = database.prepare(`
    INSERT INTO family_documents
      (name, description, category, visibility, folder_id, original_name, mime_type,
       file_size, content_data, storage_provider, storage_backend, storage_key, created_by)
    VALUES (?, ?, 'other', 'family', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    body.document_name || originalName.replace(/\.[^.]+$/, ''),
    body.document_description || null,
    folderId,
    originalName,
    attachment.mime,
    attachment.size,
    staged.content_data,
    staged.storage_provider,
    staged.storage_backend,
    staged.storage_key,
    actorId,
  );
  return result.lastInsertRowid;
}

/**
 * Kopie eines Anhang-Dokuments fuer einen Nachfolger oder abgeloesten Termin.
 * Sie erbt Sichtbarkeit UND Freigaben der Quelle (#1358, Review): ohne die
 * Freigaben saehe ein eingeschraenktes Dokument am neuen Termin niemand ausser
 * der Besitzerin - auch nicht die Zugewiesene, die den Split ausgeloest hat.
 * Weiter geoeffnet wird die Kopie danach nur von einer Verwalterin.
 */
export function cloneAttachmentDocument(database, source, staged) {
  if (!source || !staged) return null;
  // Die Kopie gehoert IMMER der Besitzerin der Quelle - nie der Person, die den
  // Split ausloest. Sonst koennte sie ueber die Kopie verwalten, was ihr an der
  // Quelle nicht gehoert.
  const cloneId = insertAttachmentClone(database, source, staged);
  database.prepare(`
    INSERT OR IGNORE INTO family_document_access (document_id, user_id)
    SELECT ?, user_id FROM family_document_access WHERE document_id = ?
  `).run(cloneId, source.id);
  return cloneId;
}

function insertAttachmentClone(database, source, staged) {
  return database.prepare(`
    INSERT INTO family_documents
      (name, description, category, status, visibility, folder_id, original_name,
       mime_type, file_size, content_data, storage_provider, storage_backend,
       storage_key, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.name,
    source.description ?? null,
    source.category,
    source.status,
    source.visibility,
    source.folder_id ?? null,
    source.original_name,
    source.mime_type,
    source.file_size,
    staged.content_data,
    staged.storage_provider,
    staged.storage_backend,
    staged.storage_key,
    source.created_by,
  ).lastInsertRowid;
}

/* EIN ANHANG IST EIN DOKUMENT - HOCHLADEN IST EINE UEBERTRAGUNG (#1358).
 *
 * Ein neuer Anhang legt eine Zeile in family_documents an: das ist keine
 * Folge des Termins, sondern eine Datei, die jemand ausdruecklich ins
 * Dokumente-Modul schickt, benannt am eigenen Bedienelement. Nach
 * docs/DECISIONS.md Eintrag 10 fragt die Route dafuer das Zielrecht,
 * `mayWriteModule(req, 'documents')` (Mitgliedsrecht UND Token-Scope), und
 * zwar als Erstes, vor jeder Suche, die mit 404 antworten koennte. Der Dialog
 * blendet die Ablage aus demselben Grund aus (`eventAttachmentFieldHtml()`).
 */
const ATTACHMENT_UPLOAD_REFUSAL = 'Attaching a file needs write access to documents.';

/** Bringt der Body einen neuen Anhang mit? Jeder nicht leere Wert zaehlt. */
function bodyUploadsAttachment(body) {
  const value = body?.attachment_data;
  if (value === undefined || value === null) return false;
  return !(typeof value === 'string' && value.trim() === '');
}

/** `true`, wenn der Body hochlaedt und der Aufrufer Dokumente nicht schreiben darf. */
function attachmentUploadRefused(req) {
  return bodyUploadsAttachment(req.body) && !mayWriteModule(req, 'documents');
}

/**
 * Dieselbe Absage als Middleware VOR der Pruefung der Anfrage (#2810, Gruppe 10
 * Entscheidung 4): sie liest nur, ob `attachment_data` einen Wert traegt, und
 * steht deshalb vor Schema, Suche und Zeilenrecht - die Absage verraet weder,
 * ob es den Termin gibt, noch, ob der Rest des Rumpfs stimmt (DECISIONS.md
 * Eintrag 10). Seit Schritt (b) die einzige Stelle: die Zeile im Handler ist weg.
 * @param {any} req
 * @param {any} res
 * @param {() => void} next
 */
export function refuseUploadWithoutDocumentsWrite(req, res, next) {
  if (attachmentUploadRefused(req)) {
    return res.status(403).json({ error: ATTACHMENT_UPLOAD_REFUSAL, code: 403, reason: 'ATTACHMENT_UPLOAD_REFUSED' });
  }
  return next();
}

/* WER DEN GESPEICHERTEN ANHANG NICHT SIEHT, LOEST IHN NICHT AB (#1358).
 * Dieselbe Regel wie bei Belegen (services/document-links.js, Regel 2):
 * Ersetzen und Entfernen gehen nur, wenn der Aufrufer das Dokumente-Modul
 * lesen darf und das gespeicherte Dokument sieht. Ohne Leserecht ist jede
 * Aenderung am Anhang dieselbe 403 - auch bei einem Termin ohne Anhang,
 * sonst verriete die Antwort, ob es einen gibt. Ein alter Inline-Anhang ohne
 * Dokument gehoert dem Termin und haelt niemanden mit Leserecht auf. */
export const ATTACHMENT_CHANGE_REFUSAL = 'Changing this attachment needs access to its document.';

export function storedAttachmentLocked(req, database, storedDocumentId) {
  const viewer = documentViewer(req);
  if (!viewer.readsDocuments) return true;
  if (storedDocumentId == null) return false;
  return filterVisible(database, 'documents', [storedDocumentId], viewer.userId).length === 0;
}

export function attachmentDataUrl(event) {
  if (!event?.attachment_data) return event?.attachment_data ?? null;
  if (String(event.attachment_data).startsWith('data:')) return event.attachment_data;
  if (!event.attachment_mime) return event.attachment_data;
  return `data:${event.attachment_mime};base64,${event.attachment_data}`;
}

export const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', ${personAvatarUrlSql('u')}
  ))
  FROM event_assignments ea JOIN users u ON u.id = ea.user_id
  WHERE ea.event_id = e.id
) AS assigned_users_json`;

export function parseAssignedTo(val) {
  if (Array.isArray(val)) return val.map(Number).filter(Boolean);
  if (val !== null && val !== undefined && val !== '') return [Number(val)].filter(Boolean);
  return [];
}

function recurrenceMetadata(event, context) {
  const linked = event.is_occurrence_override === true || isLinkedOccurrence(event);
  const recurring = linked || Boolean(event.recurrence_rule);
  const hasResolvedMetadata = event.series_id != null || event.assignment_owner_id != null;
  if (!recurring || (!context && !hasResolvedMetadata)) return null;

  const seriesId = Number(event.series_id ?? seriesIdFor(event));
  const capability = context?.capabilitiesBySeriesId?.get(seriesId) ?? null;
  let master = context?.master ?? capability?.master ?? null;
  if (!master && linked && context?.database) {
    master = context.database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(seriesId);
  }
  if (!master && !linked) master = event;

  let canOverride = Boolean(event.can_override_occurrence);
  let canDetach = Boolean(event.can_detach_occurrence);
  let isLocalRecurringSeries = Boolean(event.is_local_recurring_series);
  if (capability) {
    isLocalRecurringSeries = capability.isLocalRecurringSeries;
    canOverride = capability.canOverrideOccurrence;
    canDetach = capability.canDetachOccurrence;
  } else if (context?.database && master) {
    const derived = buildRecurrenceCapabilityMap(context.database, [master], {
      actorId: context.actorId,
    }).get(Number(master.id));
    isLocalRecurringSeries = derived?.isLocalRecurringSeries ?? false;
    // Same visibility rights as a whole-series edit, without a creator-only tier.
    canOverride = derived?.canOverrideOccurrence ?? false;
    canDetach = derived?.canDetachOccurrence ?? false;
  }

  let fields = [];
  if (linked && typeof event.overridden_fields === 'string') {
    fields = parseOverrideFields(event.overridden_fields);
  }
  const assignmentOwnerId = event.assignment_owner_id
    ?? (fields.includes('assignments') ? Number(event.id) : seriesId);
  const attachmentOwnerId = event.attachment_owner_id
    ?? (fields.includes('attachment') ? Number(event.id) : seriesId);
  const reminderOwnerId = event.reminder_owner_id
    ?? (fields.includes('reminders') ? Number(event.id) : seriesId);
  const reminderAnchorStart = event.reminder_anchor_start
    ?? (fields.includes('reminders') ? event.start_datetime : master?.start_datetime ?? event.start_datetime);

  return {
    series_id: seriesId,
    // Format A (#2034); eine nicht expandierte Serienzeile nennt ihr erstes
    // Vorkommen, mit der Haushaltszone nur fuer eine #1993-Zeile.
    recurrence_id: event.recurrence_id ?? recurrenceIdFor(
      event,
      context?.database ? seriesReadingZone(context.database, event) : null,
    ),
    is_occurrence_override: linked,
    is_local_recurring_series: isLocalRecurringSeries,
    can_override_occurrence: canOverride,
    can_detach_occurrence: canDetach,
    assignment_owner_id: Number(assignmentOwnerId),
    attachment_owner_id: Number(attachmentOwnerId),
    reminder_owner_id: Number(reminderOwnerId),
    reminder_anchor_start: reminderAnchorStart,
  };
}

export function serializeEvent(event, context = null) {
  if (!event) return event;
  const assigned_users = event.assigned_users_json ? JSON.parse(event.assigned_users_json) : [];
  // birthday_name/birthday_date stammen aus dem LEFT JOIN auf birthdays und sind
  // nur bei Geburtstags-Terminen gesetzt. Nicht-Geburtstage behalten so ihre
  // bisherige Objektform; der Client lokalisiert Titel/Beschreibung anhand von
  // birthday_name (Issue #524).
  const {
    assigned_users_json,
    birthday_name,
    birthday_date,
    birthday_event_kind,
    name_day,
    recurrence_parent_id,
    recurrence_id,
    recurrence_identity,
    overridden_fields,
    // Rohstand des Abos für den Reset (D#2330). Kein Feld der Antwort.
    feed_original,
    // Interne Sync-Zustände (Abgleich, Echo-Erkennung, Rohstand): kein Feld der Antwort.
    outbound_snapshot,
    seen_on_server,
    ...rest
  } = event;
  // DER ANHANG IST EIN DOKUMENT UND FOLGT DEM DOKUMENTENRECHT (#1358). Seit
  // er im Dokumente-Modul liegt, nannte der Termin dessen ID, Name und
  // Vorschau-URL jedem, der den Termin sieht - auch mit `documents: none`,
  // einem Token ohne documents:read oder wenn das Dokument selbst inzwischen
  // privat ist. Wer es nicht sehen darf, bekommt keinen Anhang: ID, URLs,
  // Name, Typ und Groesse sind `null`, der Client zeigt dann nichts. Ohne
  // `context.viewer` (documentViewer(req)) gilt dieselbe verdeckte Form - ein
  // Aufrufer, der ihn vergisst, leakt nichts. Ein alter Inline-Anhang ohne
  // Dokument gehoert dem Termin und bleibt.
  const storedDocumentId = event.attachment_document_id ?? null;
  const visibleDocumentIds = context?.visibleAttachmentDocumentIds
    ?? visibleAttachmentDocumentIds([event], context);
  const documentId = storedDocumentId != null && visibleDocumentIds.has(Number(storedDocumentId))
    ? storedDocumentId
    : null;
  const documentHidden = storedDocumentId != null && documentId == null;
  // `attachment_locked` (#1358): wer Dokumente lesen darf, erfaehrt, DASS hier
  // ein Anhang haengt, den er nicht sieht - ohne ID, Name oder Typ. Der Dialog
  // bietet dann weder Ablage noch Entfernen an (der Server verweigert beides).
  // Ohne Leserecht auf die Dokumente `null` wie die anderen Anhangsfelder.
  const attachmentLocked = context?.viewer?.readsDocuments === true ? documentHidden : null;
  const metadata = recurrenceMetadata(event, context);
  return {
    ...rest,
    ...(birthday_name ? {
      birthday_name,
      birthday_date: birthday_date ?? null,
      birthday_event_kind: birthday_event_kind ?? 'birthday',
      name_day: name_day ?? null,
    } : {}),
    assigned_users,
    ...(documentHidden ? { attachment_name: null, attachment_mime: null, attachment_size: null } : {}),
    attachment_document_id: documentId,
    attachment_locked: attachmentLocked,
    attachment_data: storedDocumentId ? null : attachmentDataUrl(event),
    attachment_preview_url: documentId
      ? `/api/v1/documents/${documentId}/preview`
      : null,
    attachment_download_url: documentId
      ? `/api/v1/documents/${documentId}/download`
      : null,
    housekeeping_visit_id: event.housekeeping_visit_id ?? null,
    ...(metadata ?? {}),
  };
}

/**
 * Die Anhang-Dokumente dieser Termine, die `context.viewer` sehen darf: das
 * Dokumente-Modul lesen (Mitgliedsrecht und Token-Scope) UND das einzelne
 * Dokument sehen. Eine Abfrage fuer die ganze Liste.
 * @returns {Set<number>}
 */
function visibleAttachmentDocumentIds(events, context) {
  const viewer = context?.viewer;
  if (!context?.database || viewer?.readsDocuments !== true) return new Set();
  const ids = events.map((event) => event?.attachment_document_id).filter((id) => id != null);
  return new Set(filterVisible(context.database, 'documents', ids, viewer.userId));
}

/** Serializes a result set with one capability classification per master. */
export function serializeEvents(events, context) {
  if (!Array.isArray(events) || events.length === 0) return [];
  if (!context?.database) return events.map((event) => serializeEvent(event, context));
  const capabilitiesBySeriesId = buildRecurrenceCapabilityMap(
    context.database,
    events,
    { actorId: context.actorId ?? null },
  );
  const bulkContext = {
    ...context,
    capabilitiesBySeriesId,
    visibleAttachmentDocumentIds: visibleAttachmentDocumentIds(events, context),
  };
  return events.map((event) => serializeEvent(event, bulkContext));
}

export function sendStorageError(res, error, fallbackMessage) {
  if (!(error instanceof StorageError)) return false;
  res.status(502).json({
    error: fallbackMessage,
    code: 502,
    storage_code: error.storageCode,
  });
  return true;
}

// feedUrl: aus dem Feed-Cluster hierher gezogen (mehrfach nutzbar).
export function feedUrl(req, token) {
  const base = process.env.BASE_URL?.replace(/\/+$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/calendar/${token}.ics`;
}
