/**
 * Module: Family Documents
 * Purpose: REST API for locally stored family documents with per-member visibility.
 * Dependencies: express, server/db.js
 */

import express from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import * as db from '../db.js';
import { withTx } from '../db/tx.ts';
import { createLogger } from '../logger.js';
import { str, date as validateDate, num, collectErrors, MAX_TEXT, MAX_TITLE } from '../api/formats.ts';
import { isAdminRequest, requireAdmin } from '../middleware/require-admin.js';
import { validateRequest } from '../api/validate-request.ts';
import { sqlInList } from '../utils/sql-in-list.ts';
import {
  DOCUMENT_CATEGORIES, DOCUMENT_STATUSES, DOCUMENT_VISIBILITIES,
} from '../services/document-fields.js';
import {
  mayReadModule,
  budgetDetailsVisibleWhere,
  resolveBudgetMode,
  canManageDocument,
  visibleWhere,
} from '../authorize/index.ts';
import { reminderDateBefore, reminderIsInThePast } from '../utils/reminder-schedule.js';
import { isHouseholdMember, newNonMembers, nonMemberMessage } from '../services/household-members.js';
import {
  DocumentDeletionInProgressError,
  documentDeleteIsActive,
  lockDocumentDeletes,
  sendDocumentDeletionConflict,
  unlockDocumentDeletes,
} from '../services/document-deletion-lock.js';
import { ensureModuleFolder, isModuleFolderKey } from '../services/document-folders.js';
import { subtreeIds, folderMoveIssue, MAX_FOLDER_DEPTH } from '../../public/utils/folder-tree.js';
import { getAdapter as defaultGetDmsAdapter } from '../services/dms/index.js';
import { getStatus as getGoogleDriveStatus } from '../services/google-drive-storage.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import {
  StorageError,
  assertWebdavTargetAllowed,
  cleanupStagedUpload,
  deleteDocumentContent,
  getActiveUploadBackend,
  getConfig as getStorageConfig,
  getEffectiveTarget,
  getLocalStorageConfig,
  getSelectedUploadBackend,
  getStatus as getStorageStatus,
  isUploadBackendSelectionExplicit,
  readDocumentContent,
  resolveConfig,
  saveConfig as saveStorageConfig,
  setSelectedUploadBackend,
  stageDocumentUpload,
  testConnection as testStorageConnection,
  verifyExistingWebdavDocument,
} from '../services/document-storage.js';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '../utils/upload-limit.js';
import { readDataUrlFile } from '../utils/data-url-file.js';
import { todayKey } from '../utils/timezone.js';
import { remoteFailure } from '../utils/http.js';

let dmsAdapterFactory = defaultGetDmsAdapter;
export function _setDmsAdapterFactory(fn) { dmsAdapterFactory = fn || defaultGetDmsAdapter; }

function loadDmsAccount(id) {
  return db.get().prepare('SELECT * FROM dms_accounts WHERE id = ?').get(id);
}

class DmsDocumentUnavailableError extends Error {}

/** Der Zielordner verschwand, waehrend die Datei abgelegt wurde (#1909). */
class SelectedFolderGoneError extends Error {}

const log = createLogger('Documents');

// Das Ablegen einer hochgeladenen Datei, austauschbar fuer test:documents-errors:
// dort verschwindet der Zielordner genau waehrend dieses await.
let stageUpload = stageDocumentUpload;
export function _setStageUploadForTest(fn) { stageUpload = fn || stageDocumentUpload; }
const router = express.Router();

// External storage deletion yields back to Express between documents. Keep the
// exact previewed identities stable during that window so a later request
// cannot move a confirmed document or child folder out from under the batch.
// Yuvomi runs one Node process per instance; the database remains the durable
// source of truth, while these sets serialize in-flight route mutations.
const activeFolderTreeDeletes = new Set();
const folderDeleteSnapshotKey = process.env.SESSION_SECRET || randomBytes(32);

function deletionInProgress(res) {
  return res.status(409).json({
    error: 'The document folder is currently being deleted. Try again when the operation finishes.',
    code: 409,
    reason: 'FOLDER_DELETE_IN_PROGRESS',
  });
}

function documentDeletionInProgress(res) {
  sendDocumentDeletionConflict(res, new DocumentDeletionInProgressError());
  return res;
}

// Die Wertelisten kommen aus server/services/document-fields.js, aus derselben
// Quelle liest das Schema (#2810): ein unbekannter Wert ist dort schon 400.
const CATEGORIES = DOCUMENT_CATEGORIES;
const VISIBILITIES = DOCUMENT_VISIBILITIES;
const STATUSES = DOCUMENT_STATUSES;
const MAX_FILE_BYTES = MAX_UPLOAD_BYTES;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// Nur diese Typen werden mit `Content-Disposition: inline` ausgeliefert. Bewusst
// eine zweite, engere Allowlist (zusätzlich zur Upload-Prüfung): Sie schützt den
// Preview-Endpunkt davor, jemals skriptfähige Inhalte (HTML, SVG) inline zu
// rendern — selbst falls ALLOWED_MIME künftig erweitert wird. Das Client-Pendant
// steht in public/utils/document-preview.js; die beiden Listen bleiben bewusst
// unabhängig voneinander gepflegt, damit keine Frontend-Änderung mitentscheidet,
// was inline ausgeliefert wird.
const PREVIEWABLE_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
]);

// Bild-Typen, die als kompaktes DMS-Thumbnail (Issue #533) inline ausgeliefert
// werden dürfen. Bewusst nur nicht-skriptfähige Rasterformate — SVG ist NICHT
// enthalten, da es Skripte ausführen könnte. Liefert das DMS etwas anderes
// (z. B. octet-stream), wird die Vorschau verworfen und der Client fällt auf das
// Kategorie-Icon zurück.
const THUMBNAIL_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function normalizeMime(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

// Effektiver MIME-Typ für Preview/Download. Manche DMS (Papra) liefern ihre Datei
// aus XSS-Schutz stets als application/octet-stream aus; in dem Fall ist der beim
// Verlinken gespeicherte spezifische MIME-Typ verlässlicher (Issue #451).
function effectiveMime(content, doc) {
  const live = normalizeMime(content.mime);
  const stored = normalizeMime(doc.mime_type);
  if (live && live !== 'application/octet-stream') return live;
  if (stored) return stored;
  return live || 'application/octet-stream';
}

/**
 * A path id as the number the schema checked: plain decimal digits with an
 * optional minus, at most MAX_PATH_ID (validateRequest(), #2810). `0`, `-0`
 * and `-1` find no document (404); the folder routes keep their own 400 for
 * them. A leading zero reaches the row.
 * @param {any} req
 * @param {string} [name]
 * @returns {number}
 */
function pathId(req, name = 'id') {
  return Number(req.params[name]);
}

function userId(req) {
  return req.authUserId || req.session.userId;
}

// Schreiben darf, wer das Dokument angelegt hat, oder ein Admin. Die Regel steht
// neben der Sichtbarkeit in authorize/rows/documents.ts (#989).
function mayManage(req, document) {
  return canManageDocument(document, { userId: userId(req), isAdmin: isAdminRequest(req) });
}

function canSeeSql(alias = 'd') {
  return visibleWhere('documents', alias, '@userId');
}

const EXPIRY_REMINDER_MIN_DAYS = 0;
const EXPIRY_REMINDER_MAX_DAYS = 365;

/**
 * `expires_at` ist optional und einfach `undefined` (nicht mitgeschickt) vs.
 * `null`/`''` (bewusst geloescht) unterscheidbar - PATCH lässt ein Feld sonst
 * nicht einzeln weglassbar.
 */
function vExpiresAt(value) {
  if (value === undefined) return { value: undefined, error: null };
  if (value === null || value === '') return { value: null, error: null };
  return validateDate(value, 'Expiry date');
}

/**
 * 0-365, mirroring `inventory_item_dates.reminder_offset_days`. Anders als dort
 * gibt es hier keinen Default - `null`/nicht mitgeschickt heisst "keine
 * Erinnerung", nicht "30 Tage". Ein explizites `0` bleibt `0` (Range-Check
 * unterscheidet nicht per Wahrheitswert, sondern per `undefined`/`null`/`''`).
 */
function vExpiryReminderDays(value) {
  if (value === undefined) return { value: undefined, error: null };
  if (value === null || value === '') return { value: null, error: null };
  const parsed = num(value, 'Reminder lead time');
  if (parsed.error) return parsed;
  if (!Number.isInteger(parsed.value) || parsed.value < EXPIRY_REMINDER_MIN_DAYS || parsed.value > EXPIRY_REMINDER_MAX_DAYS) {
    return { value: null, error: `Reminder lead time must be an integer between ${EXPIRY_REMINDER_MIN_DAYS} and ${EXPIRY_REMINDER_MAX_DAYS}.` };
  }
  return { value: parsed.value, error: null };
}

/**
 * Die Person, um die es geht (#1705): eine aus der einen Mitgliederliste
 * (DECISIONS 4). `stored` bleibt gueltig, auch wenn die Person inzwischen kein
 * Mitglied mehr ist - sonst liesse sich das Dokument nicht mehr speichern, ohne
 * sie zu entfernen. Anders als `newNonMembers()` lehnt das auch ein Konto ab,
 * das es nicht gibt: der Fremdschluessel machte daraus sonst eine 500.
 */
function vSubjectUserId(value, stored = null) {
  if (value === undefined) return { value: undefined, error: null };
  if (value === null || value === '') return { value: null, error: null };
  // A positive integer or its digits: the schema checked it (#2810).
  const subjectUserId = Number(value);
  if (subjectUserId !== stored && !isHouseholdMember(subjectUserId)) {
    return { value: null, error: nonMemberMessage([subjectUserId]) };
  }
  return { value: subjectUserId, error: null };
}

/**
 * Erinnerungs-Sync fuer den Ablauf eines Dokuments, identisches Muster wie
 * server/routes/inventory/items.js#syncReminder: bei jedem Schreiben erst
 * loeschen, dann - falls die Bedingungen greifen - neu anlegen. Eigentuemer ist
 * `created_by` (der Anlegende), nicht die gerade schreibende Person - gleiche
 * Regel wie bei den Inventar-Fristen.
 *
 * JE EMPFAENGER EINE ZEILE, BEI DERSELBEN PERSON EINE (#1705): die Ablegende und
 * die Person, um die es geht. Geschrieben wird ohne Blick auf die Sichtbarkeit.
 * Ob jemand das Dokument oeffnen darf, aendert sich auch ohne diesen Weg (der
 * Kalender gleicht Anhang-Rechte ab, ein Modulrecht faellt weg), also fragen
 * Zustellung und `/pending` (reminderTargetVisibleSql(), Modulrecht): eine
 * verborgene Zeile wartet, statt verloren zu gehen.
 */
function syncDocumentExpiryReminder(document) {
  const database = db.get();
  database.prepare(`
    DELETE FROM reminders WHERE entity_type = 'document_expiry' AND entity_id = ?
  `).run(document.id);

  if (!document.expires_at || document.expiry_reminder_days == null || !document.created_by) return;

  const remindAt = reminderDateBefore(document.expires_at, document.expiry_reminder_days);
  if (reminderIsInThePast(remindAt)) return;

  const insert = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('document_expiry', ?, ?, ?)
  `);
  const recipients = new Set([document.created_by, document.subject_user_id].filter(Boolean));
  for (const recipient of recipients) insert.run(document.id, remindAt, recipient);
}

/**
 * Abraeumen, wo ein Dokument den aktiven Bestand verlaesst: geloescht, im
 * Ordnerbaum mitgeloescht, oder archiviert. `reminders.entity_id` hat keinen
 * FK, also ist das explizit noetig - gleiches Muster wie
 * item-dates.js#removeTrackedDateReminders.
 */
function removeDocumentExpiryReminder(documentId) {
  db.get().prepare(`
    DELETE FROM reminders WHERE entity_type = 'document_expiry' AND entity_id = ?
  `).run(documentId);
}

/**
 * Wem ein Dokument freigegeben werden soll und der dafuer nicht in Frage
 * kommt: wer kein Haushaltsmitglied ist (`newNonMembers`, ausser den schon
 * gespeicherten) und - seit #2810 - wer gar kein Konto hat. Eine solche id lief
 * bis dahin in `replaceAccess()` auf den Fremdschluessel und endete als 500;
 * jetzt nennt sie dieselbe 400 wie ein Nicht-Mitglied.
 * @param {number[]} ids
 * @param {number[]} [stored]
 * @returns {number[]}
 */
function accessStrangers(ids, stored = []) {
  const exists = db.get().prepare('SELECT 1 FROM users WHERE id = ?');
  const unknown = ids.filter((id) => !exists.get(id));
  return [...new Set([...unknown, ...newNonMembers(ids, { stored })])];
}

function parseMemberIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

// Der Satz und Grund je Befund von readDataUrlFile (#1909); der Ablauf selbst
// ist mit dem Termin-Anhang geteilt (server/utils/data-url-file.js, #2810).
const DATA_URL_REFUSALS = {
  shape: { error: 'File content must be a valid base64 data URL.' },
  type: { error: 'File type is not allowed.', reason: 'documents_file_type_not_allowed' },
  empty: { error: 'File content is empty.', reason: 'documents_file_empty' },
  size: { error: `File may be at most ${MAX_UPLOAD_MB} MB.` },
  content: { error: 'File content does not match its declared type.', reason: 'documents_file_content_mismatch' },
};

/**
 * @param {unknown} dataUrl
 * @returns {{ file: import('../utils/data-url-file.js').DataUrlFile, error?: undefined, reason?: undefined }
 *   | { file?: undefined, error: string, reason?: string }}
 */
function parseDataUrl(dataUrl) {
  const read = readDataUrlFile(String(dataUrl || ''), { allowed: ALLOWED_MIME, maxBytes: MAX_FILE_BYTES });
  return read.fault === null ? { file: read.file } : DATA_URL_REFUSALS[read.fault];
}

function documentSelect() {
  return `
    SELECT d.id, d.name, d.description, d.category, d.status, d.visibility,
           d.original_name, d.mime_type, d.file_size, d.storage_provider,
           d.storage_backend, d.storage_key, d.dms_account_id, d.external_url,
           d.external_meta, d.folder_id, d.created_by, d.created_at, d.updated_at,
           d.expires_at, d.expiry_reminder_days, d.subject_user_id,
           f.name AS folder_name,
           u.display_name AS creator_name, u.avatar_color AS creator_color,
           subject.display_name AS subject_name, subject.avatar_color AS subject_color,
           da.provider AS dms_provider,
           GROUP_CONCAT(a.user_id) AS allowed_member_ids
    FROM family_documents d
    LEFT JOIN family_document_folders f ON f.id = d.folder_id
    LEFT JOIN users u ON u.id = d.created_by
    LEFT JOIN users subject ON subject.id = d.subject_user_id
    LEFT JOIN dms_accounts da ON da.id = d.dms_account_id
    LEFT JOIN family_document_access a ON a.document_id = d.id
  `;
}

function normalizeDocument(row) {
  if (!row) return null;
  return {
    ...row,
    allowed_member_ids: row.allowed_member_ids
      ? row.allowed_member_ids.split(',').map((id) => Number(id)).filter(Boolean)
      : [],
  };
}

function getVisibleDocument(id, req, includeContent = false) {
  const columns = includeContent ? 'd.*' : 'd.id, d.created_by, d.visibility, d.description, d.folder_id, d.status, d.expires_at, d.expiry_reminder_days, d.subject_user_id';
  return db.get().prepare(`
    SELECT ${columns}
    FROM family_documents d
    WHERE d.id = @id AND ${canSeeSql('d')}
  `).get({ id, userId: userId(req) });
}

function replaceAccess(documentId, memberIds) {
  const database = db.get();
  database.prepare('DELETE FROM family_document_access WHERE document_id = ?').run(documentId);
  const insert = database.prepare('INSERT OR IGNORE INTO family_document_access (document_id, user_id) VALUES (?, ?)');
  for (const memberId of memberIds) insert.run(documentId, memberId);
}

function ensureFolder(key, name, actorId) {
  return ensureModuleFolder(db.get(), { key, name }, actorId);
}

async function resolveDocumentContent(document) {
  let dmsResolver;
  if (document.storage_backend === 'dms') {
    const account = loadDmsAccount(document.dms_account_id);
    if (!account) throw new DmsDocumentUnavailableError();
    dmsResolver = async () => dmsAdapterFactory(account).fetchContent(document.storage_key);
  }
  return readDocumentContent(document, { dmsResolver });
}

// Kompaktes Vorschaubild (Issue #533). Nur für DMS-verknüpfte Dokumente, deren
// Adapter Thumbnails liefert (Paperless). Wirft ThumbnailUnavailableError, wenn
// kein Bild erzeugt werden kann — der Client fällt dann auf das Icon zurück.
class ThumbnailUnavailableError extends Error {}

async function resolveDmsThumbnail(account, storageKey) {
  const adapter = dmsAdapterFactory(account);
  if (typeof adapter.fetchThumbnail !== 'function') throw new ThumbnailUnavailableError();
  const thumb = await adapter.fetchThumbnail(storageKey);
  const mime = normalizeMime(thumb?.mime);
  if (!thumb?.buffer?.length || !THUMBNAIL_MIME.has(mime)) throw new ThumbnailUnavailableError();
  return { buffer: thumb.buffer, mime };
}

// no-store wie beim Viewer: ein Vorschaubild zeigt die erste Seite eines
// Dokuments, und der Browser-Cache ueberlebt das Abmelden.
function sendThumbnail(res, thumb) {
  res.setHeader('Content-Type', thumb.mime);
  res.setHeader('Content-Length', String(thumb.buffer.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.end(thumb.buffer);
}

function sendStorageError(res, error, fallbackMessage, { configText = false, adminDetail = false } = {}) {
  if (!(error instanceof StorageError)) return false;
  const status = error.storageCode === 'DOCUMENT_STORAGE_CONFIG_PROTECTED'
    ? 409
    : (
        error.storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
        || error.storageCode === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
      )
      ? 400
      : 502;
  // Phase 0 section H: the storage settings may show the service's own
  // sentence for a misconfiguration (400/409, `configText`). A failure of the
  // store itself (502) never carries its text - the WebDAV test wrote the
  // server's or fetch's message into it, with URL and status line - but its
  // class in `detail`, which the settings page shows the admin.
  // Only where the admin reads the answer (`adminDetail`: storage config and
  // connection test, #2622); a member uploading, previewing or deleting gets
  // the case without the class.
  const detail = status === 502 && adminDetail ? remoteFailure(error)?.detail : undefined;
  res.status(status).json({
    error: configText && status !== 502 ? error.message : fallbackMessage,
    code: status,
    storage_code: error.storageCode,
    // Der Speicher hat nicht mitgespielt (#1909): ein Fall, den jeder Nutzer
    // beim Hochladen oder Loeschen erreicht, wenn WebDAV, Google Drive oder
    // der Mount ausfallen. Eine Fehlkonfiguration (400/409) bleibt ohne Grund.
    ...(status === 502 ? { reason: 'documents_storage_failed' } : {}),
    ...(detail ? { detail } : {}),
  });
  return true;
}

function storageConfigStatus() {
  const config = getStorageConfig();
  const status = getStorageStatus();
  const local = getLocalStorageConfig();
  const selectedBackend = getSelectedUploadBackend();
  const activeBackend = getActiveUploadBackend();
  const webdavCount = db.get().prepare(`
    SELECT COUNT(*) AS count
    FROM family_documents
    WHERE storage_backend = 'webdav'
  `).get().count;
  const googleDrive = getGoogleDriveStatus();
  const effectiveTarget = activeBackend === 'local_folder'
    ? local.basePath
    : activeBackend === 'webdav'
      ? getEffectiveTarget(config)
      : activeBackend === 'google_drive'
        ? googleDrive.folder_name
        : null;
  return {
    enabled: status.enabled,
    configured: status.configured,
    selected_upload_backend: selectedBackend,
    active_upload_backend: activeBackend,
    effective_target: effectiveTarget,
    local_enabled: local.enabled,
    local_path: local.basePath,
    webdav_document_count: webdavCount,
    google_drive_document_count: googleDrive.document_count,
    google_drive: googleDrive,
    last_test: status.lastTest,
    last_error: status.lastError,
    url: status.url,
    username: status.username,
    base_path: status.basePath,
    password_configured: status.passwordConfigured,
    env_controlled: status.envControlled,
  };
}

function configProtected(message, options = {}) {
  return new StorageError(
    'DOCUMENT_STORAGE_CONFIG_PROTECTED',
    message,
    options
  );
}

// Die Speicher-Einstellungen sind Sache der Admins. `requireAdmin` steht VOR
// validateRequest() (#2810, Gruppe 8): ein Mitglied bekommt seine 403 vor jeder
// Pruefung der Anfrage und liest am 400 das Schema der Einstellungen nicht ab.
// Bis dahin stand die Pruefung als erste Zeile im Handler.
router.get('/storage/config', requireAdmin, validateRequest(), (req, res) => {
  try {
    res.json({ data: storageConfigStatus() });
  } catch (err) {
    // Only the store's own refusal is answered here; anything else goes to
    // the central error handler (#2810).
    if (!(err instanceof StorageError)) throw err;
    log.error('GET /storage/config storage error:', err);
    sendStorageError(res, err, 'The document storage refused the request or could not be reached.', { configText: true, adminDetail: true });
  }
});

router.put('/storage/config', requireAdmin, validateRequest(), async (req, res) => {
  try {
    // `selected_upload_backend` (one of DOCUMENT_UPLOAD_BACKENDS),
    // `confirm_existing_access` and `clear_password` (booleans) are the
    // schema's checks (#2810); the service checks the backend again.
    const existing = db.get().prepare(`
      SELECT *
      FROM family_documents
      WHERE storage_backend = 'webdav'
      ORDER BY id
      LIMIT 1
    `).get();
    const current = getStorageConfig();
    const proposed = resolveConfig(req.body);
    const targetChanged = (
      (!current.envControlled.url && Object.hasOwn(req.body, 'url'))
      || (!current.envControlled.path
        && (Object.hasOwn(req.body, 'path') || Object.hasOwn(req.body, 'basePath')))
    );
    if (targetChanged && proposed.url) {
      await assertWebdavTargetAllowed(proposed);
    }

    if (existing) {
      const deletingRequiredField = (
        (!current.envControlled.url
          && Object.hasOwn(req.body, 'url')
          && String(req.body.url ?? '').trim() === '')
        || (!current.envControlled.username
          && Object.hasOwn(req.body, 'username')
          && String(req.body.username ?? '').trim() === '')
        || (!current.envControlled.password && req.body.clear_password === true)
        || (!current.envControlled.path
          && (Object.hasOwn(req.body, 'path') || Object.hasOwn(req.body, 'basePath'))
          && String(req.body.path ?? req.body.basePath ?? '').trim() === '')
      );
      if (
        deletingRequiredField
        || !proposed.url
        || !proposed.username
        || !proposed.password
        || !proposed.basePath
      ) {
        throw configProtected(
          'Required WebDAV connection data cannot be removed while documents exist.'
        );
      }

      const connectionChanged = (
        getEffectiveTarget(proposed) !== getEffectiveTarget(current)
        || proposed.username !== current.username
        || proposed.password !== current.password
      );
      if (connectionChanged) {
        if (req.body.confirm_existing_access !== true) {
          throw configProtected(
            'Changing WebDAV connection data requires explicit confirmation.'
          );
        }
        try {
          await verifyExistingWebdavDocument(existing, proposed);
        } catch (error) {
          if (error instanceof StorageError
            && error.storageCode === 'DOCUMENT_STORAGE_CONFIG_PROTECTED') {
            throw error;
          }
          throw configProtected(
            'The proposed WebDAV configuration cannot read an existing document.',
            { cause: error }
          );
        }
      }
    }

    const selectorProvided = Object.hasOwn(req.body, 'selected_upload_backend');
    const selectedBackend = selectorProvided
      ? req.body.selected_upload_backend
      : (isUploadBackendSelectionExplicit() ? getSelectedUploadBackend() : null);
    if (selectedBackend === 'webdav' && (
      !proposed.enabled
      || !proposed.url
      || !proposed.username
      || !proposed.password
      || !proposed.basePath
    )) {
      throw new StorageError(
        'DOCUMENT_STORAGE_NOT_CONFIGURED',
        'WebDAV must be enabled and fully configured while it is selected.'
      );
    }
    if (selectedBackend === 'google_drive') {
      const driveStatus = getGoogleDriveStatus();
      if (!driveStatus.configured || !driveStatus.connected) {
        throw new StorageError(
          'DOCUMENT_STORAGE_NOT_CONFIGURED',
          'Google Drive must be connected before it can be selected.'
        );
      }
    }

    saveStorageConfig(req.body);
    if (selectorProvided) setSelectedUploadBackend(req.body.selected_upload_backend);
    res.json({ data: storageConfigStatus() });
  } catch (err) {
    // Only the store's own refusal is answered here; anything else goes to
    // the central error handler (#2810).
    if (!(err instanceof StorageError)) throw err;
    log.error('PUT /storage/config storage error:', err);
    sendStorageError(res, err, 'The document storage refused the request or could not be reached.', { configText: true, adminDetail: true });
  }
});

router.post('/storage/test', requireAdmin, validateRequest(), async (req, res) => {
  try {
    await assertWebdavTargetAllowed(resolveConfig(req.body));
    const result = await testStorageConnection(req.body);
    res.json({ data: result });
  } catch (err) {
    // Only the store's own refusal is answered here; anything else goes to
    // the central error handler (#2810).
    if (!(err instanceof StorageError)) throw err;
    log.error('POST /storage/test storage error:', err);
    sendStorageError(res, err, 'The document storage refused the request or could not be reached.', { configText: true, adminDetail: true });
  }
});

router.get('/meta/options', validateRequest(), (req, res) => {
  const dmsAccounts = db.get().prepare('SELECT id, name, provider FROM dms_accounts ORDER BY name COLLATE NOCASE').all();
  res.json({
    data: {
      categories: CATEGORIES,
      visibilities: VISIBILITIES,
      statuses: STATUSES,
      max_file_size: MAX_FILE_BYTES,
      allowed_mime_types: Array.from(ALLOWED_MIME),
      storage_providers: ['local', 'external'],
      active_upload_backend: getActiveUploadBackend(),
      // Der Client blendet Deep-Links in die (admin-only) Dokument-Einstellungen
      // nur ein, wenn sie auch erreichbar sind - kein toter Link für Mitglieder.
      is_admin: isAdminRequest(req),
      dms_accounts: isAdminRequest(req) ? dmsAccounts : [],
    },
  });
});

/**
 * Die Ordner, ueber die eine Baumfrage laeuft.
 *
 * DIE GANZE LISTE UND KEINE TEILABFRAGE: die geteilten Regeln
 * (public/utils/folder-tree.js) rechnen auf einer Liste, nicht auf einer
 * Verbindung - das ist der Preis dafuer, dass Browser und Server dieselbe
 * Regel benutzen statt zweier, die auseinanderlaufen. Er ist klein: die Tiefe
 * ist auf fuenf begrenzt, und ein Haushalt fuehrt Dutzende Ordner, nicht
 * Tausende.
 */
function allFolders() {
  return db.get().prepare('SELECT id, name, parent_id FROM family_document_folders').all();
}

/**
 * Die Dokumente eines Zweigs, die diese Person sieht - fuer Vorschau und
 * DELETE dieselbe Abfrage, damit beide ueber dieselbe Menge urteilen.
 * content_data bleibt bewusst draussen: Legacy-BLOBs koennen bis zum
 * Uploadlimit gross sein, fuer das Loeschen braucht der Storage-Adapter aber
 * nur Backend und Key.
 */
function visibleFolderDocuments(req, folderIds) {
  const folderList = sqlInList(folderIds, 'folders');
  return db.get()
    .prepare(`
      SELECT d.id, d.name, d.storage_backend, d.storage_key, d.created_by
      FROM family_documents d
      WHERE d.folder_id IN (${folderList.sql})
        AND ${visibleWhere('documents', 'd', '@userId')}
      ORDER BY d.id ASC
    `)
    .all({ folders: folderList.param, userId: userId(req) });
}

/** Bind a destructive confirmation to exact folder and document identities. */
function folderDeleteSnapshot(folderIds, documentIds, linkedState) {
  const numericSort = (a, b) => a - b;
  const payload = JSON.stringify({
    folders: Array.from(folderIds || [], Number).sort(numericSort),
    documents: Array.from(documentIds || [], Number).sort(numericSort),
    links: linkedState,
  });
  return createHmac('sha256', folderDeleteSnapshotKey)
    .update('yuvomi:folder-delete:v1\0')
    .update(payload)
    .digest('hex');
}

/**
 * Die Verknuepfungen, die das Loeschen der sichtbaren Dokumente mitnimmt -
 * exakt, als IDs, damit der Snapshot sie binden kann.
 *
 * NUR, WAS DIE FRAGENDE PERSON IN DEM ANDEREN MODUL SIEHT. Die Vorschau zaehlte
 * jede Verknuepfung ohne Blick auf das Modul: ein Mitglied mit `budget: none`
 * oder ein Token mit nur `documents:read` erfuhr, wie viele Buchungen,
 * Aufgaben oder Termine an einem Dokument haengen, und wer das Modul lesen
 * durfte, erfuhr von Verknuepfungen aus fremden privaten Terminen und
 * Aufgaben - und der Snapshot aenderte sich mit ihnen. Jetzt gilt je Modul:
 *   - ohne Leserecht (Sitzung UND Token-Scope, `mayReadModule()`) steht dort
 *     `null` - nicht erzaehlt, nicht 0 (wie `attachments` seit #1358);
 *   - mit Leserecht zaehlt nur, was die Leseregel des Moduls zeigt: Termine
 *     und Aufgaben ueber `visibilityWhere()` (Termine dazu nur aus geteilten
 *     oder eigenen Abos, wie GET /calendar), Buchungen ueber
 *     `budgetDetailsVisibleWhere()` (eine maskierte Buchung zeigt keine
 *     Belege), Ausgabengruppen samt Ausgaben und Ausgleichen nur fuer
 *     Mitglieder der Gruppe oder Admins (`requireGroupAccess()`). Besuche und
 *     Inventar gehoeren dem Haushalt und kennen keine Zeilen-Sichtbarkeit.
 * Die geteilten Ausgaben haengen am Modulrecht `budget` (scopes.js).
 */
function folderDeleteLinkedState(req, documentIds) {
  const documentList = sqlInList(documentIds, 'documents');
  const ids = (sql) => (documentIds.length
    ? db.get().prepare(sql).all({ documents: documentList.param, userId: userId(req) }).map((row) => row.identity)
    : []);
  const reads = (moduleKey) => mayReadModule(req, moduleKey);
  const groupVisible = (column) => (isAdminRequest(req) ? '1=1' : `EXISTS (
    SELECT 1 FROM expense_group_members gm WHERE gm.group_id = ${column} AND gm.user_id = @userId
  )`);
  const readsCalendar = reads('calendar');
  const readsBudget = reads('budget');
  const readsTasks = reads('tasks');
  return {
    calendar_events: readsCalendar ? ids(`
      SELECT e.id AS identity FROM calendar_events e
       WHERE e.attachment_document_id IN (${documentList.sql})
         AND ${visibleWhere('ics_subscriptions', 'e', '@userId')}
         AND ${visibleWhere('events', 'e', '@userId')}
       ORDER BY e.id
    `) : null,
    housekeeping_work_sessions: reads('housekeeping') ? ids(`
      SELECT h.id AS identity FROM housekeeping_work_sessions h
       WHERE h.receipt_document_id IN (${documentList.sql})
       ORDER BY h.id
    `) : null,
    expense_groups: readsBudget ? ids(`
      SELECT g.id AS identity FROM expense_groups g
       WHERE g.avatar_document_id IN (${documentList.sql}) AND ${groupVisible('g.id')}
       ORDER BY g.id
    `) : null,
    settlements: readsBudget ? ids(`
      SELECT s.id AS identity FROM settlements s
       WHERE s.proof_document_id IN (${documentList.sql}) AND ${groupVisible('s.group_id')}
       ORDER BY s.id
    `) : null,
    expense_attachments: readsBudget ? ids(`
      SELECT a.id AS identity FROM expense_attachments a
        JOIN expenses x ON x.id = a.expense_id
       WHERE a.document_id IN (${documentList.sql}) AND ${groupVisible('x.group_id')}
       ORDER BY a.id
    `) : null,
    task_documents: readsTasks ? ids(`
      SELECT printf('%d:%d', td.task_id, td.document_id) AS identity FROM task_documents td
        JOIN tasks t ON t.id = td.task_id
       WHERE td.document_id IN (${documentList.sql})
         AND ${visibleWhere('tasks', 't', '@userId')}
       ORDER BY identity
    `) : null,
    budget_entry_attachments: readsBudget ? ids(`
      SELECT a.id AS identity FROM budget_entry_attachments a
        JOIN budget_entries b ON b.id = a.entry_id
       WHERE a.document_id IN (${documentList.sql})
         AND ${budgetDetailsVisibleWhere('b', '@userId', { mode: resolveBudgetMode(db.get()) })}
       ORDER BY a.id
    `) : null,
    inventory_item_documents: reads('inventory') ? ids(`
      SELECT i.id AS identity FROM inventory_item_documents i
       WHERE i.document_id IN (${documentList.sql})
       ORDER BY i.id
    `) : null,
  };
}

/** Die Zaehler der Vorschau; ein Modul ohne Leserecht bleibt `null`. */
function folderDeleteLinkedRecords(state) {
  const count = (...lists) => (lists.some((list) => list === null)
    ? null
    : lists.reduce((sum, list) => sum + list.length, 0));
  return {
    calendar: count(state.calendar_events),
    housekeeping: count(state.housekeeping_work_sessions),
    split_expenses: count(state.expense_groups, state.settlements, state.expense_attachments),
    tasks: count(state.task_documents),
    budget: count(state.budget_entry_attachments),
    inventory: count(state.inventory_item_documents),
  };
}

/**
 * Die Absage der Baumpruefung als Antwortrumpf. Was ein Nutzer erreicht, nennt
 * seinen Fall (#1909): der gewaehlte Elternordner wurde inzwischen geloescht,
 * oder der Zweig waere zu tief. "In sich selbst" bietet die Auswahl gar nicht
 * an - das erreicht nur ein Aufrufer der API und bleibt ohne Grund.
 */
const MOVE_ISSUES = {
  'self':           { error: 'A folder cannot be inside itself.' },
  'descendant':     { error: 'A folder cannot be moved into its own subfolder.' },
  'missing-parent': { error: 'Parent folder not found.', reason: 'documents_selected_folder_not_found' },
  'too-deep':       {
    error: `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
    reason: 'documents_folder_too_deep',
    params: { limit: MAX_FOLDER_DEPTH },
  },
};

/**
 * Darf dieser Ordner dorthin? Gibt den Rumpf der Absage, oder null.
 * @returns {{ error: string, reason?: string, params?: object }|null}
 */
function folderMoveError(folderId, parentId) {
  const issue = folderMoveIssue(allFolders(), folderId, parentId);
  return issue ? MOVE_ISSUES[issue] : null;
}

/**
 * Liest `parent_id` aus einem Request-Body: eine positive Ganzzahl oder ihre
 * Ziffern, oder null - das prueft das Schema davor (#2810).
 * @param {unknown} value
 * @returns {number|null}
 */
function parentId(value) {
  if (value === undefined || value === null || value === '') return null;
  return Number(value);
}

router.get('/folders', validateRequest(), (_req, res) => {
  // Flach mit `parent_id`, nicht verschachtelt: der Baum wird im Browser
  // gebaut, weil dort ohnehin die Zaehler und der aufgeklappte Zustand
  // dazukommen. Eine geschachtelte Antwort waere derselbe Inhalt in einer
  // Form, die der Client wieder auseinandernehmen muss.
  //
  // Die Sortierung ist die Geschwisterfolge - der Aufbau haengt sie unter
  // ihre Eltern, die Reihenfolge innerhalb einer Ebene steht damit schon
  // hier fest und nicht in zwei Clients verschieden.
  const rows = db.get().prepare(`
    SELECT id, name, parent_id, module_key, created_by, created_at, updated_at
    FROM family_document_folders
    ORDER BY name COLLATE NOCASE ASC
  `).all();
  res.json({ data: rows });
});

router.get('/folders/:id/delete-impact', validateRequest(), (req, res) => {
  const id = pathId(req);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid folder id.', code: 400 });
  }
  const existing = db.get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Folder not found.', code: 404, reason: 'documents_folder_not_found' });

  const subtree = [...subtreeIds(allFolders(), id)];
  const visibleDocuments = visibleFolderDocuments(req, subtree);
  // AUCH DAS URTEIL SIEHT NUR DAS SICHTBARE (#1358). `can_delete_documents`
  // fragte, ob ALLE Dokumente im Zweig sichtbar sind - fuer einen Admin, der
  // jedes sichtbare Dokument loeschen darf, hiess `false` genau: hier liegt
  // ein privates Dokument, das du nicht siehst. Die Vorschau ist mit und
  // ohne unsichtbares Dokument dieselbe, und das DELETE ebenso: es loescht
  // nur das Sichtbare, ein unsichtbares Dokument verliert nur den Ordner.
  const canDeleteDocuments = visibleDocuments.every((document) => mayManage(req, document));

  // DER SNAPSHOT DECKT NUR, WAS DIE FRAGENDE PERSON SIEHT (#1355). Ueber
  // alle Dokumente gebildet, aenderte er sich mit jedem unsichtbaren
  // Dokument, das in den Zweig kam, ging oder verknuepft wurde - zweimal
  // fragen verriet Aktivitaet an fremden privaten Dokumenten. Dasselbe gilt
  // fuer die Verknuepfungen: nur aus lesbaren Modulen, nur sichtbare
  // Datensaetze (folderDeleteLinkedState).
  const visibleIds = visibleDocuments.map((document) => document.id);
  const visibleLinkedState = folderDeleteLinkedState(req, visibleIds);
  res.json({ data: {
    id,
    removed_folders: subtree.length,
    documents: visibleDocuments.length,
    can_delete_documents: canDeleteDocuments,
    linked_records: folderDeleteLinkedRecords(visibleLinkedState),
    snapshot: folderDeleteSnapshot(subtree, visibleIds, visibleLinkedState),
  } });
});

/**
 * Gibt es den Ordner, in den ein Dokument soll? Ein Ordner, der zwischen dem
 * Oeffnen des Dialogs und dem Speichern geloescht wurde, liess das Einfuegen
 * bis #1909 am Fremdschluessel scheitern - als 500. Jetzt ist es der Fall, den
 * der Dialog erklaert (der gewaehlte Ordner fehlt).
 */
function selectedFolderMissing(folderId) {
  if (folderId === null || folderId === undefined) return false;
  return !db.get().prepare('SELECT 1 FROM family_document_folders WHERE id = ?').get(folderId);
}

function selectedFolderGone(res) {
  return res.status(400).json({ error: 'Folder not found.', code: 400, reason: 'documents_selected_folder_not_found' });
}

/** Die Spalten, die eine Ordner-Antwort traegt - eine Schreibweise fuer alle Wege. */
const FOLDER_COLUMNS = 'id, name, parent_id, module_key, created_by, created_at, updated_at';

router.post('/folders', validateRequest(), (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
    const parent = parentId(req.body.parent_id);
    if (parent !== null && activeFolderTreeDeletes.has(parent)) {
      return deletionInProgress(res);
    }

    const moveError = folderMoveError(null, parent);
    if (moveError) return res.status(400).json({ ...moveError, code: 400 });

    const result = db.get().prepare('INSERT INTO family_document_folders (name, parent_id, created_by) VALUES (?, ?, ?)')
      .run(vName.value, parent, userId(req));
    const row = db.get().prepare(`SELECT ${FOLDER_COLUMNS} FROM family_document_folders WHERE id = ?`)
      .get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      // Der Name kollidiert ab jetzt nur noch mit den GESCHWISTERN (Migration
      // v164) - "Rechnungen" darf unter "Auto" und unter "Wohnung" stehen.
      return res.status(409).json({ error: 'A folder with this name already exists here.', code: 409, reason: 'documents_folder_exists' });
    }
    throw err;
  }
});

router.put('/folders/:id', validateRequest(), (req, res) => {
  try {
    const id = pathId(req);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid folder id.', code: 400 });
    }
    if (activeFolderTreeDeletes.has(id)) return deletionInProgress(res);
    const existing = db.get().prepare('SELECT id, name, parent_id FROM family_document_folders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Folder not found.', code: 404, reason: 'documents_folder_not_found' });

    // Umbenennen und Verschieben sind derselbe Schreibvorgang, und beide sind
    // einzeln weglassbar: ein Feld, das nicht mitkommt, ist keine Ansage.
    // Ohne diese Trennung nimmt ein reines Umbenennen den Ordner an die Wurzel
    // mit, weil `parent_id` dann als "nicht gesetzt" gelesen wuerde.
    let name = existing.name;
    if (req.body.name !== undefined) {
      const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
      if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
      name = vName.value;
    }

    let parent = existing.parent_id;
    if (req.body.parent_id !== undefined) {
      const newParent = parentId(req.body.parent_id);
      if (newParent !== null && activeFolderTreeDeletes.has(newParent)) {
        return deletionInProgress(res);
      }
      const moveError = folderMoveError(id, newParent);
      if (moveError) return res.status(400).json({ ...moveError, code: 400 });
      parent = newParent;
    }

    db.get().prepare('UPDATE family_document_folders SET name = ?, parent_id = ? WHERE id = ?')
      .run(name, parent, id);
    const row = db.get().prepare(`SELECT ${FOLDER_COLUMNS} FROM family_document_folders WHERE id = ?`).get(id);
    res.json({ data: row });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A folder with this name already exists here.', code: 409, reason: 'documents_folder_exists' });
    }
    throw err;
  }
});

router.delete('/folders/:id', validateRequest(), async (req, res) => {
  let deletionLock = null;
  try {
    const id = pathId(req);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid folder id.', code: 400 });
    }
    // `documents` (unfile|delete), the expected counts (integers from 0) and
    // the snapshot (64 hex digits) are the schema's checks (#2810).
    const documentAction = req.query.documents || 'unfile';
    const expectedCount = (/** @type {unknown} */ value) => (value === undefined ? null : Number(value));
    const expectedDocuments = expectedCount(req.query.expected_documents);
    const expectedFolders = expectedCount(req.query.expected_folders);
    const expectedSnapshot = req.query.expected_snapshot === undefined
      ? null
      : String(req.query.expected_snapshot);
    const existing = db.get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Folder not found.', code: 404, reason: 'documents_folder_not_found' });

    // WAS MITGEHT, WIRD VORHER GEZAEHLT UND NICHT NUR GELOESCHT. Ein Ordner
    // nimmt seinen ganzen Teilbaum mit (ON DELETE CASCADE, Migration v164),
    // und wer ihn loescht, sieht in der Seitenleiste nur die zugeklappte
    // Wurzel - die Antwort sagt deshalb, was verschwunden ist, damit die
    // Oberflaeche vorher fragen kann.
    //
    // Ohne explizite Dokument-Aktion bleibt der kompatible sichere Default:
    // folder_id traegt ON DELETE SET NULL und die Dokumente landen unter
    // "ohne Ordner". `documents=delete` ist eine eigene, vorab bestaetigte
    // Aktion und loescht Inhalt plus Zeile nacheinander.
    //
    // BEIDE MODI SEHEN NUR DAS SICHTBARE. Ein Dokument, das die Person nicht
    // sieht, wird nie gelesen, gezaehlt, gesperrt oder geloescht - es verliert
    // mit dem Ordner nur seine Ordnerbindung, im destruktiven Modus genau wie
    // beim Entordnen. Bis dahin verweigerte `documents=delete` einen Zweig mit
    // unsichtbarem Dokument (403 FOLDER_DOCUMENTS_NOT_MANAGEABLE), und jede
    // Absage, die an einem unsichtbaren Dokument haengt, sagt, dass es da ist:
    // vor dem Snapshot-Vergleich stand sie 403 gegen 409, danach waere es 403
    // gegen 200 gewesen. Der Schutz aus DECISIONS.md Eintrag 1 bleibt: ein
    // unsichtbares Dokument loescht auch ein Admin ueber einen Ordner nie.
    const subtree = [...subtreeIds(allFolders(), id)];
    const documents = visibleFolderDocuments(req, subtree);
    const deleteDocuments = documentAction === 'delete';

    if (deleteDocuments && expectedSnapshot === null) {
      return res.status(400).json({
        error: 'A current folder deletion preview is required.',
        code: 400,
      });
    }

    // ERST DER VERGLEICH, DANN DIE BESITZPRUEFUNG. Der Dialog bestaetigt
    // konkrete Zahlen UND Identitaeten. Hat sich der sichtbare Zweig seit
    // seinem Impact-GET veraendert, darf der folgende Klick nicht still andere
    // Inhalte loeschen als angezeigt. Der destruktive Modus verlangt den
    // Snapshot; der sichere Unfile-Default bleibt fuer alte Clients ohne
    // Erwartungswerte kompatibel. Der Snapshot wird wie im GET nur ueber das
    // Sichtbare gebildet. Die Reihenfolge ist seit #1355 umgekehrt: dort stand
    // die Besitzpruefung vorn, damit kein 409 ueber unsichtbare Dokumente
    // zustande kam - das kann es nicht mehr, und ein veraenderter Zweig
    // bekommt so zuerst die frische Vorschau statt einer Absage.
    const visibleIds = documents.map((document) => document.id);
    const currentSnapshot = folderDeleteSnapshot(
      subtree,
      visibleIds,
      folderDeleteLinkedState(req, visibleIds),
    );
    if ((expectedDocuments !== null && expectedDocuments !== documents.length)
        || (expectedFolders !== null && expectedFolders !== subtree.length)
        || (expectedSnapshot !== null && expectedSnapshot !== currentSnapshot)) {
      return res.status(409).json({
        error: 'Folder contents changed. Review the deletion impact and try again.',
        code: 409,
        reason: 'FOLDER_CONTENT_CHANGED',
      });
    }

    // Die Besitzpruefung laeuft ueber jedes sichtbare Dokument des Zweigs,
    // bevor ein externer Speicher angefasst wird - sonst koennte ein Mitglied
    // erst eigene Dateien loeschen und beim ersten fremden Dokument in einem
    // halben Baum stranden. Sie sieht nur Sichtbares, die Absage verraet also
    // nichts, was die Vorschau nicht schon zeigt (`can_delete_documents`).
    if (deleteDocuments && !documents.every((document) => mayManage(req, document))) {
      return res.status(403).json({
        error: 'Not authorized to delete every document in this folder.',
        code: 403,
        reason: 'FOLDER_DOCUMENTS_NOT_MANAGEABLE',
      });
    }

    // Die Dokumentsperre gilt nur fuer das destruktive Loeschen (#1355).
    // Entordnen loescht allein die Ordnerzeile, folder_id faellt per
    // ON DELETE SET NULL - ein Dokument, dessen Einzel-Loeschung gerade
    // laeuft, verliert dabei nur seinen Ordner und verschwindet danach wie
    // geplant. Auf dessen Sperre zu warten hiess, an einer fremden Loeschung
    // zu scheitern, die das Entordnen gar nicht beruehrt, und bei einem
    // unsichtbaren Dokument verriet das 409 fremde Aktivitaet. Die
    // Ordnersperre bleibt fuer beide Modi: ein Zweig im destruktiven Loeschen
    // wird nicht nebenher entordnet. Im destruktiven Modus zaehlen nur die
    // sichtbaren Dokumente, die er loescht - ein unsichtbares wird ohnehin
    // nur entordnet. Pruefung und Schreiben laufen ohne await dazwischen.
    const overlapsActiveDeletion = subtree.some((folderId) => activeFolderTreeDeletes.has(folderId))
      || (deleteDocuments && documents.some((document) => documentDeleteIsActive(document.id)));
    if (overlapsActiveDeletion) return deletionInProgress(res);

    if (deleteDocuments) {
      deletionLock = {
        folderIds: [...subtree],
        documentIds: documents.map((document) => document.id),
      };
      deletionLock.folderIds.forEach((folderId) => activeFolderTreeDeletes.add(folderId));
      lockDocumentDeletes(deletionLock.documentIds);
    }

    if (deleteDocuments) {
      let deletedDocuments = 0;
      const failedDocuments = [];
      const storageDeletedDocuments = [];
      for (const document of documents) {
        try {
          await deleteDocumentContent(document);
          storageDeletedDocuments.push(document);
        } catch (err) {
          log.error(`DELETE /folders/:id document ${document.id} storage error:`, err);
          failedDocuments.push({
            id: document.id,
            name: document.name,
            failure_stage: 'storage',
            storage_code: err instanceof StorageError ? err.storageCode : 'DOCUMENT_DELETE_FAILED',
          });
        }
      }

      // Keep every row visible for the whole asynchronous storage phase. Link
      // writers can then distinguish an in-flight target from a missing one
      // and return the stable 409 without exposing hidden document IDs. SQLite
      // row deletion is synchronous, so no writer can interleave once this
      // second phase starts.
      for (const document of storageDeletedDocuments) {
        try {
          db.get().prepare('DELETE FROM family_documents WHERE id = ?').run(document.id);
          removeDocumentExpiryReminder(document.id);
          deletedDocuments += 1;
        } catch (err) {
          log.error(`DELETE /folders/:id document ${document.id} database error:`, err);
          failedDocuments.push({
            id: document.id,
            name: document.name,
            failure_stage: 'database',
            error_code: 'DOCUMENT_DATABASE_DELETE_FAILED',
          });
        }
      }

      // Externe Speicherlöschungen können dauern. Prüfe deshalb nach der
      // Schleife noch einmal, ob währenddessen neue Dokumente oder Unterordner
      // hinzugekommen sind. Der neu hinzugekommene Inhalt war nicht Teil der
      // bestätigten Vorschau und darf weder mitgelöscht noch durch das folgende
      // ON DELETE SET NULL überraschend entordnet werden.
      //
      // Auch hier nur das Sichtbare: die Antwort nannte jedes neue Dokument
      // mit ID und Namen, auch ein fremdes privates. Ein unsichtbares
      // Neuankoemmling aendert nichts, was die Person sieht, und wird wie jedes
      // unsichtbare Dokument im Zweig nur entordnet.
      const currentSubtree = [...subtreeIds(allFolders(), id)];
      const remainingDocuments = visibleFolderDocuments(req, currentSubtree);
      const originalFolderIds = new Set(subtree);
      const originalDocumentIds = new Set(documents.map((document) => document.id));
      const contentsChanged = currentSubtree.length !== subtree.length
        || currentSubtree.some((folderId) => !originalFolderIds.has(folderId))
        || remainingDocuments.some((document) => !originalDocumentIds.has(document.id));
      const knownFailures = new Set(failedDocuments.map((document) => document.id));
      for (const document of remainingDocuments) {
        if (!knownFailures.has(document.id)) {
          failedDocuments.push({
            id: document.id,
            name: document.name,
            failure_stage: 'concurrency',
            error_code: 'FOLDER_CONTENT_CHANGED',
          });
        }
      }

      // Bei einem Speicherfehler oder einer parallelen Änderung bleibt die
      // Struktur um die verbleibenden Dokumente stehen. Erfolgreich gelöschte
      // Dateien können nicht atomar in WebDAV/Drive zurückgerollt werden; ein
      // ehrlicher 207-Sammelstatus macht den Teilfortschritt sichtbar.
      if (failedDocuments.length || contentsChanged) {
        return res.status(207).json({ data: {
          id,
          removed_folders: 0,
          deleted_documents: deletedDocuments,
          failed_documents: failedDocuments,
          contents_changed: contentsChanged,
          folder_deleted: false,
        } });
      }
    }

    db.get().prepare('DELETE FROM family_document_folders WHERE id = ?').run(id);
    res.json({ data: {
      id,
      removed_folders: subtree.length,
      unfiled_documents: deleteDocuments ? 0 : documents.length,
      deleted_documents: deleteDocuments ? documents.length : 0,
      failed_documents: [],
      folder_deleted: true,
    } });
  } finally {
    // Also when the error goes on to the central handler (#2810).
    deletionLock?.folderIds.forEach((folderId) => activeFolderTreeDeletes.delete(folderId));
    unlockDocumentDeletes(deletionLock?.documentIds);
  }
});

router.get('/', validateRequest(), (req, res) => {
  // Every query value is the schema's check (#2810): `status` and `category`
  // from their lists, `folder_id` and `subject_user_id` positive integers,
  // `expiring` an integer from 0. An unknown value fell back on "no filter"
  // until v2.93; it is a 400 now. Left out is still no filter (`active` for
  // the status).
  const status = req.query.status ?? 'active';
  const category = req.query.category ?? null;
  const folderId = req.query.folder_id === undefined ? null : Number(req.query.folder_id);
  // `?expiring=<days>` - Dokumente, deren Ablauf innerhalb der naechsten N Tage
  // liegt oder bereits vergangen ist (dieselbe "faellig ODER ueberfaellig"-
  // Lesart wie der Chip von public/utils/date-status.js).
  const expiringWithinDays = req.query.expiring === undefined ? null : Number(req.query.expiring);
  // Ein Filter ueber die sichtbaren Dokumente, kein Weg an ihnen vorbei: er
  // steht in derselben Abfrage wie `canSeeSql`. Nur fuer eine API-Anfrage; die
  // Seite filtert ihre geladene Liste im Browser (`matchesPerson`).
  const subjectUserId = req.query.subject_user_id === undefined ? null : Number(req.query.subject_user_id);

  /* EIN ORDNER ZEIGT AUCH, WAS UNTER IHM LIEGT (#785).
   *
   * In der flachen Ablage waren "Ordner" und "Filter" dasselbe. In einem
   * Baum ist die alte Antwort die falsche: wer "Wohnung" oeffnet und alle
   * zwoelf Dokumente in "Wohnung/Miete" abgelegt hat, saehe eine leere
   * Ansicht und muesste raten, wo sie sind.
   *
   * Die ids kommen als Liste in die Abfrage und nicht als rekursives CTE:
   * die Tiefe ist auf fuenf begrenzt, es sind also eine Handvoll Zeilen -
   * und die Liste wird ohnehin gebraucht, um zu erkennen, dass der Ordner
   * gar nicht existiert (dann darf die Antwort nicht stillschweigend ALLE
   * Dokumente zeigen, was ein blosses `IS NULL` taete).
   */
  let subtree = null;
  if (folderId !== null) {
    const exists = db.get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folderId);
    subtree = exists ? [...subtreeIds(allFolders(), folderId)] : [folderId];
  }

  /* Benannte Platzhalter auch fuer die Liste: die uebrige Abfrage laeuft
   * ueber `@userId`/`@status`, und better-sqlite3 nimmt benannte und
   * positionelle Parameter nicht im selben Aufruf. */
  const folderList = sqlInList(subtree ?? [], 'folders');
  const folderClause = subtree
    ? `AND d.folder_id IN (${folderList.sql})`
    : '';
  const params = {
    userId: userId(req), status, category, expiringWithinDays, subjectUserId,
    // `expires_at` ist ein lokal eingegebener Kalendertag, kein Instant -
    // `date('now')` waere der UTC-Tag und oestlich von UTC am fruehen Abend,
    // westlich davon am fruehen Morgen der falsche (server/services/
    // task-scope.js hat dieselbe Falle). `todayKey()` bindet stattdessen den
    // Haushalts-Tagesschluessel als Parameter.
    today: todayKey(db.get()),
    ...(subtree ? { folders: folderList.param } : {}),
  };
  const expiringClause = expiringWithinDays !== null
    ? "AND d.expires_at IS NOT NULL AND date(d.expires_at) <= date(@today, '+' || @expiringWithinDays || ' days')"
    : '';
  const rows = db.get().prepare(`
    ${documentSelect()}
    WHERE ${canSeeSql('d')}
      AND d.status = @status
      AND (@category IS NULL OR d.category = @category)
      AND (@subjectUserId IS NULL OR d.subject_user_id = @subjectUserId)
      ${folderClause}
      ${expiringClause}
    GROUP BY d.id
    ORDER BY d.updated_at DESC
  `).all(params);
  res.json({ data: rows.map(normalizeDocument) });
});

router.post('/', validateRequest(), async (req, res) => {
  let stagedUpload;
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vDescription = str(req.body.description, 'Description', { max: MAX_TEXT, required: false });
    const vOriginalName = str(req.body.original_name, 'Original filename', { max: MAX_TITLE });
    const vFolderName = str(req.body.folder_name, 'Folder name', { max: MAX_TITLE, required: false });
    const vExpiresAtField = vExpiresAt(req.body.expires_at);
    const vExpiryReminderDaysField = vExpiryReminderDays(req.body.expiry_reminder_days);
    const vSubjectField = vSubjectUserId(req.body.subject_user_id);
    const errors = collectErrors([vName, vDescription, vOriginalName, vFolderName, vExpiresAtField, vExpiryReminderDaysField, vSubjectField]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // `folder_key` benennt den Systemordner eines Moduls, `folder_name` nur
    // seine Beschriftung. Ohne Schluessel legt eine aeltere App-Version weiter
    // ueber den Namen ab (Migration v157). Einen unbekannten Schluessel weist
    // seit #2810 das Schema ab; die Pruefung hier bleibt, weil der Schluessel
    // in ensureModuleFolder() eine Liste nachschlaegt.
    const folderKey = isModuleFolderKey(req.body.folder_key) ? req.body.folder_key : null;

    // `category` und `visibility` aus ihren Listen, `folder_id` als positive
    // Ganzzahl oder ihre Ziffern: das prueft das Schema davor (#2810). Bis
    // v2.93 wurde ein unbekannter Wert still zu `other` bzw. `family`.
    const category = req.body.category ?? 'other';
    const visibility = req.body.visibility ?? 'family';
    const selectedFolderId = req.body.folder_id !== undefined && req.body.folder_id !== null && req.body.folder_id !== ''
      ? Number(req.body.folder_id)
      : null;
    if (req.body.folder_id !== undefined && selectedFolderId !== null
        && activeFolderTreeDeletes.has(selectedFolderId)) {
      return deletionInProgress(res);
    }
    if (selectedFolderMissing(selectedFolderId)) return selectedFolderGone(res);
    const parsed = parseDataUrl(req.body.content_data);
    if (!parsed.file) {
      return res.status(400).json({ error: parsed.error, code: 400, ...(parsed.reason ? { reason: parsed.reason } : {}) });
    }
    const upload = parsed.file;

    const allowedIds = visibility === 'restricted' ? parseMemberIds(req.body.allowed_member_ids) : [];
    // Freigeben laesst sich ein neues Dokument nur Haushaltsmitgliedern (#1207).
    const strangers = accessStrangers(allowedIds);
    if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });
    stagedUpload = await stageUpload({
      buffer: upload.buffer,
      mime: upload.mime,
      category,
      originalName: vOriginalName.value,
    });
    const database = db.get();
    const row = withTx(database, () => {
      // NOCHMAL, OHNE YIELD DAZWISCHEN: die Pruefung oben lag vor dem await des
      // Ablegens, und dort kann ein anderes Loeschen den Ordner nehmen (Review
      // zu #1994). Erst hier ist das Ergebnis bis zum INSERT verbindlich.
      if (selectedFolderMissing(selectedFolderId)) throw new SelectedFolderGoneError();
      const folderId = selectedFolderId ?? ensureFolder(folderKey, vFolderName.value, userId(req));
      const expiresAt = vExpiresAtField.value ?? null;
      const expiryReminderDays = vExpiryReminderDaysField.value ?? null;
      const subjectUserId = vSubjectField.value ?? null;
      const result = database.prepare(`
        INSERT INTO family_documents (
          name, description, category, visibility, folder_id, original_name,
          mime_type, file_size, content_data, storage_provider, storage_backend,
          storage_key, created_by, expires_at, expiry_reminder_days, subject_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vName.value,
        vDescription.value,
        category,
        visibility,
        folderId,
        vOriginalName.value,
        upload.mime,
        upload.size,
        stagedUpload.content_data,
        stagedUpload.storage_provider,
        stagedUpload.storage_backend,
        stagedUpload.storage_key,
        userId(req),
        expiresAt,
        expiryReminderDays,
        subjectUserId
      );
      if (visibility === 'restricted') replaceAccess(result.lastInsertRowid, allowedIds);
      syncDocumentExpiryReminder({
        id: result.lastInsertRowid,
        expires_at: expiresAt,
        expiry_reminder_days: expiryReminderDays,
        created_by: userId(req),
        subject_user_id: subjectUserId,
      });
      return database.prepare(`
        ${documentSelect()}
        WHERE d.id = ?
        GROUP BY d.id
      `).get(result.lastInsertRowid);
    });
    res.status(201).json({ data: normalizeDocument(row) });
  } catch (err) {
    if (err instanceof StorageError) {
      log.error('POST / storage error:', err);
      return sendStorageError(res, err, 'Document storage upload failed.');
    }
    const folderGone = err instanceof SelectedFolderGoneError;
    // The staged file goes in every case, also before an unexpected error
    // goes on to the central error handler (#2810).
    if (stagedUpload) {
      try {
        await cleanupStagedUpload(stagedUpload);
      } catch (cleanupError) {
        log.error('POST / cleanup error after database failure:', cleanupError);
        return sendStorageError(
          res,
          cleanupError,
          'Document storage cleanup failed.'
        );
      }
    }
    if (folderGone) return selectedFolderGone(res);
    throw err;
  }
});

router.put('/:id', validateRequest(), (req, res) => {
  const id = pathId(req);
  const existing = getVisibleDocument(id, req);
  if (!existing) return res.status(404).json({ error: 'Document not found.', code: 404, reason: 'documents_document_not_found' });
  if (!mayManage(req, existing)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
  if (documentDeleteIsActive(id)) return documentDeletionInProgress(res);

  const vName = req.body.name !== undefined ? str(req.body.name, 'Name', { max: MAX_TITLE }) : { value: null };
  const vDescription = req.body.description !== undefined ? str(req.body.description, 'Description', { max: MAX_TEXT, required: false }) : { value: null };
  const vExpiresAtField = vExpiresAt(req.body.expires_at);
  const vExpiryReminderDaysField = vExpiryReminderDays(req.body.expiry_reminder_days);
  const vSubjectField = vSubjectUserId(req.body.subject_user_id, existing.subject_user_id);
  const errors = collectErrors([vName, vDescription, vExpiresAtField, vExpiryReminderDaysField, vSubjectField]);
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

  // The lists and the folder id are the schema's checks (#2810); an unknown
  // value was ignored until v2.93. Left out still keeps what is stored.
  const category = req.body.category ?? null;
  const visibility = req.body.visibility ?? null;
  const status = req.body.status ?? null;
  const selectedFolderId = req.body.folder_id !== undefined && req.body.folder_id !== null && req.body.folder_id !== ''
    ? Number(req.body.folder_id)
    : null;
  if (req.body.folder_id !== undefined && selectedFolderId !== null
      && activeFolderTreeDeletes.has(selectedFolderId)) {
    return deletionInProgress(res);
  }
  if (selectedFolderMissing(selectedFolderId)) return selectedFolderGone(res);
  // The schema requires `allowed_member_ids` on PUT (full representation,
  // #2810): replaceAccess() below always replaces the list, and left out it
  // emptied a restricted document's access silently.
  const allowedIds = (visibility || existing.visibility) === 'restricted' ? parseMemberIds(req.body.allowed_member_ids) : [];
  // Neu freigeben laesst sich nur Haushaltsmitgliedern (#1207). Wer schon
  // freigegeben ist - auch Hauspersonal oder ein Gast -, bleibt speicherbar.
  // Geprueft vor dem UPDATE: eine abgelehnte Anfrage aendert nichts.
  const storedAccess = db.get().prepare('SELECT user_id FROM family_document_access WHERE document_id = ?')
    .all(id).map((row) => row.user_id);
  const strangers = accessStrangers(allowedIds, storedAccess);
  if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });
  const expiresAt = req.body.expires_at !== undefined ? vExpiresAtField.value : existing.expires_at;
  const expiryReminderDays = req.body.expiry_reminder_days !== undefined ? vExpiryReminderDaysField.value : existing.expiry_reminder_days;
  const subjectUserId = req.body.subject_user_id !== undefined ? vSubjectField.value : existing.subject_user_id;
  db.get().prepare(`
    UPDATE family_documents
    SET name = COALESCE(?, name),
        description = ?,
        category = COALESCE(?, category),
        visibility = COALESCE(?, visibility),
        status = COALESCE(?, status),
        folder_id = ?,
        expires_at = ?,
        expiry_reminder_days = ?,
        subject_user_id = ?
    WHERE id = ?
  `).run(
    req.body.name !== undefined ? vName.value : null,
    req.body.description !== undefined ? vDescription.value : existing.description,
    category,
    visibility,
    status,
    req.body.folder_id !== undefined ? selectedFolderId : existing.folder_id,
    expiresAt,
    expiryReminderDays,
    subjectUserId,
    id
  );
  replaceAccess(id, allowedIds);

  // Ein archiviertes Dokument darf nicht mehr nagen (ein archiviertes
  // Passfoto etwa) - dieselbe Teardown-Regel wie DELETE/Ordner-Loeschen.
  const finalStatus = status ?? existing.status;
  if (finalStatus === 'archived') {
    removeDocumentExpiryReminder(id);
  } else {
    syncDocumentExpiryReminder({
      id, expires_at: expiresAt, expiry_reminder_days: expiryReminderDays, created_by: existing.created_by, subject_user_id: subjectUserId,
    });
  }

  const row = db.get().prepare(`${documentSelect()} WHERE d.id = ? GROUP BY d.id`).get(id);
  res.json({ data: normalizeDocument(row) });
});

router.patch('/:id/archive', validateRequest(), (req, res) => {
  const id = pathId(req);
  const existing = getVisibleDocument(id, req);
  if (!existing) return res.status(404).json({ error: 'Document not found.', code: 404, reason: 'documents_document_not_found' });
  if (!mayManage(req, existing)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
  if (documentDeleteIsActive(id)) return documentDeletionInProgress(res);
  const status = req.body.archived === false ? 'active' : 'archived';
  db.get().prepare('UPDATE family_documents SET status = ? WHERE id = ?').run(status, id);
  // Ein archiviertes Dokument darf nicht mehr nagen (ein archiviertes
  // Passfoto etwa). Reaktivieren stellt die Erinnerung wieder her, falls die
  // Ablauf-Angaben noch stehen.
  if (status === 'archived') {
    removeDocumentExpiryReminder(id);
  } else {
    syncDocumentExpiryReminder({
      id,
      expires_at: existing.expires_at,
      expiry_reminder_days: existing.expiry_reminder_days,
      created_by: existing.created_by,
      subject_user_id: existing.subject_user_id,
    });
  }
  res.json({ data: { id, status } });
});

router.get('/:id/thumbnail', validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
    const doc = getVisibleDocument(id, req, true);
    if (!doc) return res.status(404).json({ error: 'Document not found.', code: 404 });
    if (doc.storage_backend !== 'dms') {
      return res.status(415).json({ error: 'Thumbnail not available for this document.', code: 415 });
    }
    const account = loadDmsAccount(doc.dms_account_id);
    if (!account) return res.status(404).json({ error: 'Linked DMS account is gone.', code: 404 });
    const thumb = await resolveDmsThumbnail(account, doc.storage_key);
    sendThumbnail(res, thumb);
  } catch (err) {
    if (err instanceof ThumbnailUnavailableError) {
      return res.status(415).json({ error: 'Thumbnail not available for this document.', code: 415 });
    }
    log.error('GET /:id/thumbnail error:', err);
    res.status(502).json({ error: 'Failed to load thumbnail.', code: 502 });
  }
});

// Preview und Download lesen ein Drive-Dokument ueber den Google-Client, dessen
// `tokens`-Listener ein erneuertes Token nach dem Warten speichert: waehrend
// eines Restores 503, sonst festgehalten wie eine schreibende Anfrage (#1551).
router.get('/:id/preview', refuseWhileRestoring, validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
    const doc = getVisibleDocument(id, req, true);
    if (!doc) return res.status(404).json({ error: 'Document not found.', code: 404 });
    const content = await resolveDocumentContent(doc);
    const rawMime = effectiveMime(content, doc);
    // Inline-Auslieferung nur für nicht-skriptfähige Typen. Alles andere kann über
    // /download (als attachment) geholt werden.
    if (!PREVIEWABLE_MIME.has(rawMime)) {
      return res.status(415).json({ error: 'Preview not supported for this file type.', code: 415 });
    }
    const filename = encodeURIComponent((doc.original_name || `${doc.id}`).replace(/[/\\]/g, '_'));
    res.setHeader('Content-Type', rawMime);
    res.setHeader('Content-Length', String(content.buffer.length));
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    // no-store statt private, max-age: der Viewer zeigt Arztbriefe und Ausweise,
    // und der Browser-Cache ueberlebt das Abmelden. Ein Dokument soll nach dem
    // Schliessen nicht als Kopie auf dem Geraet liegen bleiben.
    res.setHeader('Cache-Control', 'no-store');
    // Defense-in-Depth: MIME-Sniffing unterbinden und jegliche Skriptausführung im
    // Antwortdokument verbieten, falls ein Inhalt je fehlklassifiziert würde.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Chromium rendert PDFs über den internen Plugin-Viewer, der same-origin-Ressourcen
    // und Inline-Styles benötigt. Ein `default-src 'none'` blockiert diesen Viewer komplett
    // ("This page was blocked by Chrome"). Da `nosniff` + fester Content-Type application/pdf
    // jede HTML/JS-Ausführung verhindern, ist die gelockerte Policy für PDFs unbedenklich.
    if (rawMime === 'application/pdf') {
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; object-src 'self'");
    } else {
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    }
    res.end(content.buffer);
  } catch (err) {
    if (err instanceof DmsDocumentUnavailableError) {
      return res.status(404).json({ error: 'Linked DMS account is gone.', code: 404 });
    }
    if (!(err instanceof StorageError)) throw err;
    log.error('GET /:id/preview storage error:', err);
    sendStorageError(res, err, 'Document storage read failed.');
  }
});

router.get('/:id/download', refuseWhileRestoring, validateRequest(), async (req, res) => {
  try {
    const id = pathId(req);
    const doc = getVisibleDocument(id, req, true);
    if (!doc) return res.status(404).json({ error: 'Document not found.', code: 404 });
    const content = await resolveDocumentContent(doc);
    const rawMime = effectiveMime(content, doc);
    const filename = encodeURIComponent((doc.original_name || `${doc.id}`).replace(/[/\\]/g, '_'));
    res.setHeader('Content-Type', rawMime);
    res.setHeader('Content-Length', String(content.buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(content.buffer);
  } catch (err) {
    if (err instanceof DmsDocumentUnavailableError) {
      return res.status(404).json({ error: 'Linked DMS account is gone.', code: 404 });
    }
    if (!(err instanceof StorageError)) throw err;
    log.error('GET /:id/download storage error:', err);
    sendStorageError(res, err, 'Document storage read failed.');
  }
});

router.delete('/:id', validateRequest(), async (req, res) => {
  let lockedId = null;
  try {
    const id = pathId(req);
    const existing = getVisibleDocument(id, req, true);
    if (!existing) return res.status(404).json({ error: 'Document not found.', code: 404, reason: 'documents_document_not_found' });
    if (!mayManage(req, existing)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    if (documentDeleteIsActive(id)) return documentDeletionInProgress(res);
    lockDocumentDeletes([id]);
    lockedId = id;
    await deleteDocumentContent(existing);
    db.get().prepare('DELETE FROM family_documents WHERE id = ?').run(id);
    removeDocumentExpiryReminder(id);
    res.status(204).end();
  } catch (err) {
    if (!(err instanceof StorageError)) throw err;
    log.error('DELETE /:id storage error:', err);
    sendStorageError(res, err, 'Document storage delete failed.');
  } finally {
    // Also when the error goes on to the central handler (#2810).
    if (lockedId !== null) unlockDocumentDeletes([lockedId]);
  }
});

export default router;
