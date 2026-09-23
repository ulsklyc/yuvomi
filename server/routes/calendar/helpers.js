/**
 * Modul: Kalender (Calendar) - geteilte Helfer & Konstanten
 * Zweck: Zustandslose Helfer und Konstanten, die von mehreren Kalender-Sub-Routern
 *        genutzt werden. Aufgeteilt aus server/routes/calendar.js (God-File-Split).
 */

import { StorageError } from '../../services/document-storage.js';
import { ensureModuleFolder } from '../../services/document-folders.js';
import { applyDocumentAccess, filterVisibleDocumentIds } from '../../services/document-access.js';
import { documentViewer } from '../../services/document-links.js';
import { mayWriteModule } from '../../permissions.js';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '../../utils/upload-limit.js';
import { contentMatchesMime } from '../../utils/file-signature.js';
import { isAdminRequest } from '../../middleware/require-admin.js';
import {
  fanOutEventReminders, dropInheritedEventReminders, eventAuthorId,
} from '../../services/event-reminder-fanout.js';
import {
  buildRecurrenceCapabilityMap, isLinkedOccurrence,
  parseOverrideFields, recurrenceIdFor, seriesIdFor,
} from '../../services/calendar-occurrence-overrides.js';

export const VALID_SOURCES  = ['local', 'google', 'apple', 'ics'];
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

/** Bleibt als Name fuer die Kalender-Router und das Dashboard; die Regel steht in isAdminRequest(). */
export function isAdminUser(req) {
  return isAdminRequest(req);
}

export function eventIcon(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'calendar';
  const icon = raw === 'drill' ? 'tooth' : raw;
  return VALID_EVENT_ICONS.has(icon) ? icon : null;
}

export function parseAttachment(dataUrl) {
  const raw = typeof dataUrl === 'string' ? dataUrl.trim() : '';
  if (!raw) return { mime: null, size: null, buffer: null };
  const match = raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error('attachment_data: ungültiges Dateiformat.');
  const mime = match[1].toLowerCase();
  if (!ATTACHMENT_MIME.has(mime)) throw new Error('attachment_data: Dateityp nicht erlaubt.');
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('attachment_data: Datei ist leer.');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`attachment_data: Datei darf höchstens ${MAX_UPLOAD_MB} MB groß sein.`);
  // Bis hier war nur geprueft, was der Absender BEHAUPTET (#937).
  if (!contentMatchesMime(buffer, mime)) throw new Error('attachment_data: Inhalt passt nicht zum angegebenen Dateityp.');
  return { mime, size: buffer.length, buffer };
}

// CalDAV-Ziel eines Events validieren (Issue #241). Liefert {value, error}
// im Stil der validate.js-Helfer, damit collectErrors 400 statt 500 erzeugt.
// Leere/fehlende account_id bedeutet "Lokal" (kein Outbound-Sync).
export function caldavTarget(body) {
  const rawId  = body.target_caldav_account_id;
  const rawUrl = body.target_caldav_calendar_url;
  if (rawId === null || rawId === undefined || rawId === '') {
    return { value: { accountId: null, calendarUrl: null }, error: null };
  }
  const accountId = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return { value: null, error: 'target_caldav_account_id: ungültige Konto-ID.' };
  }
  const calendarUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!calendarUrl) {
    return { value: null, error: 'target_caldav_calendar_url: fehlt für CalDAV-Ziel.' };
  }
  if (calendarUrl.length > 2048) {
    return { value: null, error: 'target_caldav_calendar_url: zu lang.' };
  }
  return { value: { accountId, calendarUrl }, error: null };
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
    return { value: null, error: 'target_outlook_account_id: ungültige Konto-ID.' };
  }
  const calendarId = typeof rawCal === 'string' ? rawCal.trim() : '';
  if (!calendarId) {
    return { value: null, error: 'target_outlook_calendar_id: fehlt für Outlook-Ziel.' };
  }
  if (calendarId.length > 2048) {
    return { value: null, error: 'target_outlook_calendar_id: zu lang.' };
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
    return { value: null, error: 'target_google_calendar_id: zu lang.' };
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
export const ATTACHMENT_UPLOAD_REFUSAL = 'Attaching a file needs write access to documents.';

/** Bringt der Body einen neuen Anhang mit? Jeder nicht leere Wert zaehlt. */
function bodyUploadsAttachment(body) {
  const value = body?.attachment_data;
  if (value === undefined || value === null) return false;
  return !(typeof value === 'string' && value.trim() === '');
}

/** `true`, wenn der Body hochlaedt und der Aufrufer Dokumente nicht schreiben darf. */
export function attachmentUploadRefused(req) {
  return bodyUploadsAttachment(req.body) && !mayWriteModule(req, 'documents');
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
  return filterVisibleDocumentIds(database, [storedDocumentId], viewer.userId).length === 0;
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
    'avatar_data', u.avatar_data
  ))
  FROM event_assignments ea JOIN users u ON u.id = ea.user_id
  WHERE ea.event_id = e.id
) AS assigned_users_json`;

export function parseAssignedTo(val) {
  if (Array.isArray(val)) return val.map(Number).filter(Boolean);
  if (val !== null && val !== undefined && val !== '') return [Number(val)].filter(Boolean);
  return [];
}

/**
 * Das Anhang-Dokument folgt Sichtbarkeit und Zuweisung des Termins - weiter
 * oeffnen darf es aber nur, wem `mayWiden(documentId)` das zugesteht
 * (Dokumente schreiben UND das Dokument sehen, #1358). Ohne Urteil wird nur
 * verengt: `applyDocumentAccess()` in services/document-access.js.
 */
export function syncAttachmentDocumentAccess(d, documentId, eventVisibility, userIds, {
  mayWiden = () => false, grantAssignees = false,
} = {}) {
  if (!documentId) return;
  const visibility = eventVisibility === 'private'
    ? 'private'
    : eventVisibility === 'assignees'
      ? 'restricted'
      : 'family';
  applyDocumentAccess(d, documentId, {
    visibility, userIds, mayWiden: mayWiden(documentId) === true, grantAssignees,
  });
}

/**
 * `options.mayWidenAttachment` kommt vom Aufrufer (`documentWidenPredicate()`);
 * ohne ihn wird das Anhang-Dokument nur verengt, nie weiter geoeffnet.
 * `options.grantAssigneesOnly` (Standard-Zuweisung der Kalender-Syncs): der
 * Sync aendert Dokumentrechte nie, ausser dass an einem Termin fuer
 * Zugewiesene ein schon eingeschraenktes Dokument die Zugewiesenen als
 * Freigabe dazubekommt - nichts wird `family`, nichts Privates geht auf,
 * nichts wird enger, keine Freigabe faellt weg.
 */
export function setEventAssignments(d, eventId, userIds, { mayWidenAttachment, grantAssigneesOnly = false } = {}) {
  // Wer VORHER dranstand - gebraucht wird das eine Zeile weiter unten, um die
  // Erinnerungen derer abzuraeumen, die nicht mehr dranstehen (#921). Deshalb
  // hier und nicht erst nach dem DELETE, das die Auskunft vernichtet.
  const before = d.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?')
    .all(eventId).map((r) => r.user_id);

  d.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(eventId);
  const ins = d.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(eventId, uid);

  /* DIE ERINNERUNGEN FOLGEN DER ZUWEISUNG (#921).
   *
   * Hier und nicht in den beiden Routen, die diese Funktion rufen: eine
   * Zuweisung, die die Erinnerung NICHT mitbringt, meldet sich nicht - sie
   * aeussert sich als ein Termin, von dem jemand nichts erfahren hat. Genau so
   * war der Fall gemeldet. An der einen Schreibstelle kann kein Aufrufer sie
   * vergessen.
   *
   * Beim ANLEGEN eines Termins ist hier noch nichts zu verteilen: das Formular
   * speichert erst den Termin und dann die Erinnerungen, und der zweite Schritt
   * fuehrt denselben Abgleich noch einmal aus. Beide Wege enden gleich. */
  const author = eventAuthorId(d, eventId);
  const removed = before.filter((uid) => !userIds.includes(uid));
  dropInheritedEventReminders(d, eventId, removed);
  if (author !== null) fanOutEventReminders(d, eventId, author);

  const event = d.prepare(`
    SELECT attachment_document_id, visibility
    FROM calendar_events
    WHERE id = ?
  `).get(eventId);
  syncAttachmentDocumentAccess(
    d,
    event?.attachment_document_id,
    event?.visibility,
    userIds,
    { mayWiden: mayWidenAttachment, grantAssignees: grantAssigneesOnly },
  );
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
    recurrence_id: event.recurrence_id ?? recurrenceIdFor(event),
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
  return new Set(filterVisibleDocumentIds(context.database, ids, viewer.userId));
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
