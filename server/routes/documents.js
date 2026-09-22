/**
 * Module: Family Documents
 * Purpose: REST API for locally stored family documents with per-member visibility.
 * Dependencies: express, server/db.js
 */

import express from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { str, date as validateDate, num, collectErrors, id as validateId, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { reminderDateBefore, reminderIsInThePast } from '../utils/reminder-schedule.js';
import { canManageDocument, documentVisibleSql } from '../services/document-access.js';
import { newNonMembers, nonMemberMessage } from '../services/household-members.js';
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
import { contentMatchesMime } from '../utils/file-signature.js';
import { todayKey } from '../utils/timezone.js';

let dmsAdapterFactory = defaultGetDmsAdapter;
export function _setDmsAdapterFactory(fn) { dmsAdapterFactory = fn || defaultGetDmsAdapter; }

function loadDmsAccount(id) {
  return db.get().prepare('SELECT * FROM dms_accounts WHERE id = ?').get(id);
}

class DmsDocumentUnavailableError extends Error {}

const log = createLogger('Documents');
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

const CATEGORIES = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];
const VISIBILITIES = ['family', 'restricted', 'private'];
const STATUSES = ['active', 'archived'];
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

function userId(req) {
  return req.authUserId || req.session.userId;
}

// Schreiben darf, wer das Dokument angelegt hat, oder ein Admin. Die Regel steht
// neben der Sichtbarkeit in services/document-access.js (#989).
function mayManage(req, document) {
  return canManageDocument(document, { userId: userId(req), isAdmin: isAdminRequest(req) });
}

function canSeeSql(alias = 'd') {
  return documentVisibleSql(alias);
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
 * Erinnerungs-Sync fuer den Ablauf eines Dokuments, identisches Muster wie
 * server/routes/inventory/items.js#syncReminder: bei jedem Schreiben erst
 * loeschen, dann - falls die Bedingungen greifen - neu anlegen. Eigentuemer ist
 * `created_by` (der Anlegende), nicht die gerade schreibende Person - gleiche
 * Regel wie bei den Inventar-Fristen.
 */
function syncDocumentExpiryReminder(document) {
  const database = db.get();
  database.prepare(`
    DELETE FROM reminders WHERE entity_type = 'document_expiry' AND entity_id = ?
  `).run(document.id);

  if (!document.expires_at || document.expiry_reminder_days == null || !document.created_by) return;

  const remindAt = reminderDateBefore(document.expires_at, document.expiry_reminder_days);
  if (reminderIsInThePast(remindAt)) return;

  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('document_expiry', ?, ?, ?)
  `).run(document.id, remindAt, document.created_by);
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

function parseMemberIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

function parseDataUrl(dataUrl) {
  const raw = String(dataUrl || '');
  const match = raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return { error: 'File content must be a valid base64 data URL.' };
  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return { error: 'File type is not allowed.' };
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return { error: 'File content is empty.' };
  if (buffer.length > MAX_FILE_BYTES) return { error: `File may be at most ${MAX_UPLOAD_MB} MB.` };
  // Bis hier war nur GEPRUEFT, was der Absender BEHAUPTET: der Typ steht im
  // data-URL-Praefix und kommt aus seinem Browser. Ein Dokument, das sich als
  // PDF ausgibt und keins ist, faellt sonst erst auf, wenn es jemand braucht
  // (#937). Typen ohne Signatur - text/plain, text/csv - passieren weiter.
  if (!contentMatchesMime(buffer, mime)) {
    return { error: 'File content does not match its declared type.' };
  }
  return { mime, base64, size: buffer.length, buffer };
}

function documentSelect() {
  return `
    SELECT d.id, d.name, d.description, d.category, d.status, d.visibility,
           d.original_name, d.mime_type, d.file_size, d.storage_provider,
           d.storage_backend, d.storage_key, d.dms_account_id, d.external_url,
           d.external_meta, d.folder_id, d.created_by, d.created_at, d.updated_at,
           d.expires_at, d.expiry_reminder_days,
           f.name AS folder_name,
           u.display_name AS creator_name, u.avatar_color AS creator_color,
           da.provider AS dms_provider,
           GROUP_CONCAT(a.user_id) AS allowed_member_ids
    FROM family_documents d
    LEFT JOIN family_document_folders f ON f.id = d.folder_id
    LEFT JOIN users u ON u.id = d.created_by
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
  const columns = includeContent ? 'd.*' : 'd.id, d.created_by, d.visibility, d.description, d.folder_id, d.status, d.expires_at, d.expiry_reminder_days';
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

function sendThumbnail(res, thumb, cacheSeconds) {
  res.setHeader('Content-Type', thumb.mime);
  res.setHeader('Content-Length', String(thumb.buffer.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', `private, max-age=${cacheSeconds}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.end(thumb.buffer);
}

function sendStorageError(res, error, fallbackMessage) {
  if (!(error instanceof StorageError)) return false;
  const status = error.storageCode === 'DOCUMENT_STORAGE_CONFIG_PROTECTED'
    ? 409
    : (
        error.storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
        || error.storageCode === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
      )
      ? 400
      : 502;
  res.status(status).json({
    error: fallbackMessage,
    code: status,
    storage_code: error.storageCode,
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

router.get('/storage/config', (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Not authorized.', code: 403 });
    }
    res.json({ data: storageConfigStatus() });
  } catch (err) {
    log.error('GET /storage/config error:', err);
    if (sendStorageError(res, err, err.message)) return;
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.put('/storage/config', async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Not authorized.', code: 403 });
    }
    if (
      req.body.selected_upload_backend !== undefined
      && !['local', 'webdav', 'google_drive'].includes(req.body.selected_upload_backend)
    ) {
      return res.status(400).json({
        error: 'selected_upload_backend must be local, webdav, or google_drive.',
        code: 400,
      });
    }
    if (
      req.body.confirm_existing_access !== undefined
      && typeof req.body.confirm_existing_access !== 'boolean'
    ) {
      return res.status(400).json({
        error: 'confirm_existing_access must be a boolean.',
        code: 400,
      });
    }
    if (
      req.body.clear_password !== undefined
      && typeof req.body.clear_password !== 'boolean'
    ) {
      return res.status(400).json({
        error: 'clear_password must be a boolean.',
        code: 400,
      });
    }

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
    log.error('PUT /storage/config error:', err);
    if (sendStorageError(res, err, err.message)) return;
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/storage/test', async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Not authorized.', code: 403 });
    }
    await assertWebdavTargetAllowed(resolveConfig(req.body));
    const result = await testStorageConnection(req.body);
    res.json({ data: result });
  } catch (err) {
    log.error('POST /storage/test error:', err);
    if (sendStorageError(res, err, err.message)) return;
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/meta/options', (req, res) => {
  try {
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
        // nur ein, wenn sie auch erreichbar sind — kein toter Link für Mitglieder.
        is_admin: isAdminRequest(req),
        dms_accounts: isAdminRequest(req) ? dmsAccounts : [],
      },
    });
  } catch (err) {
    log.error('GET /meta/options error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
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

/** Exact link identities affected by deleting the selected documents. */
function folderDeleteLinkedState(documentIds) {
  if (!documentIds.length) {
    return {
      calendar_events: [], housekeeping_work_sessions: [], expense_groups: [],
      settlements: [], expense_attachments: [], task_documents: [],
      budget_entry_attachments: [], inventory_item_documents: [],
    };
  }
  const params = Object.fromEntries(documentIds.map((value, index) => [`d${index}`, value]));
  const placeholders = documentIds.map((_value, index) => `@d${index}`).join(',');
  const ids = (table, column, identity = 'id') => db.get().prepare(`
    SELECT ${identity} AS identity
      FROM ${table}
     WHERE ${column} IN (${placeholders})
     ORDER BY ${identity}
  `).all(params).map((row) => row.identity);
  return {
    calendar_events: ids('calendar_events', 'attachment_document_id'),
    housekeeping_work_sessions: ids('housekeeping_work_sessions', 'receipt_document_id'),
    expense_groups: ids('expense_groups', 'avatar_document_id'),
    settlements: ids('settlements', 'proof_document_id'),
    expense_attachments: ids('expense_attachments', 'document_id'),
    task_documents: ids('task_documents', 'document_id', "printf('%d:%d', task_id, document_id)"),
    budget_entry_attachments: ids('budget_entry_attachments', 'document_id'),
    inventory_item_documents: ids('inventory_item_documents', 'document_id'),
  };
}

function folderDeleteLinkedRecords(state) {
  return {
    calendar: state.calendar_events.length,
    housekeeping: state.housekeeping_work_sessions.length,
    split_expenses: state.expense_groups.length + state.settlements.length + state.expense_attachments.length,
    tasks: state.task_documents.length,
    budget: state.budget_entry_attachments.length,
    inventory: state.inventory_item_documents.length,
  };
}

/** Die Absage der Baumpruefung als Satz, den jemand lesen kann. */
const MOVE_ISSUE_MESSAGES = {
  'self':           'A folder cannot be inside itself.',
  'descendant':     'A folder cannot be moved into its own subfolder.',
  'missing-parent': 'Parent folder not found.',
  'too-deep':       `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
};

/**
 * Darf dieser Ordner dorthin? Gibt die Meldung, oder null.
 * @returns {string|null}
 */
function folderMoveError(folderId, parentId) {
  const issue = folderMoveIssue(allFolders(), folderId, parentId);
  return issue ? MOVE_ISSUE_MESSAGES[issue] : null;
}

/**
 * Liest `parent_id` aus einem Request-Body.
 * @returns {{ value: number|null, error: string|null }}
 */
function parentId(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return { value: null, error: 'Invalid parent folder id.' };
  return { value: num, error: null };
}

router.get('/folders', (_req, res) => {
  try {
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
  } catch (err) {
    log.error('GET /folders error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/folders/:id/delete-impact', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid folder id.', code: 400 });
    }
    const existing = db.get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Folder not found.', code: 404 });

    const subtree = [...subtreeIds(allFolders(), id)];
    const folderParams = Object.fromEntries(subtree.map((value, i) => [`f${i}`, value]));
    const folderPlaceholders = subtree.map((_v, i) => `@f${i}`).join(',');
    const documents = db.get()
      .prepare(`SELECT id, created_by FROM family_documents WHERE folder_id IN (${folderPlaceholders})`)
      .all(folderParams);
    const visibleDocuments = db.get()
      .prepare(`
        SELECT d.id, d.created_by
        FROM family_documents d
        WHERE d.folder_id IN (${folderPlaceholders})
          AND ${documentVisibleSql('d')}
      `)
      .all({ ...folderParams, userId: userId(req) });
    const canDeleteDocuments = visibleDocuments.length === documents.length
      && visibleDocuments.every((document) => mayManage(req, document));

    // DER SNAPSHOT DECKT NUR, WAS DIE FRAGENDE PERSON SIEHT (#1355). Ueber
    // alle Dokumente gebildet, aenderte er sich mit jedem unsichtbaren
    // Dokument, das in den Zweig kam, ging oder verknuepft wurde - zweimal
    // fragen verriet Aktivitaet an fremden privaten Dokumenten. Die Sicherheit
    // haengt nicht am Hash: das DELETE verweigert (403), solange irgendetwas
    // im Zweig unsichtbar oder fremd ist.
    const visibleIds = visibleDocuments.map((document) => document.id);
    const visibleLinkedState = folderDeleteLinkedState(visibleIds);
    res.json({ data: {
      id,
      removed_folders: subtree.length,
      documents: visibleDocuments.length,
      can_delete_documents: canDeleteDocuments,
      linked_records: folderDeleteLinkedRecords(visibleLinkedState),
      snapshot: folderDeleteSnapshot(subtree, visibleIds, visibleLinkedState),
    } });
  } catch (err) {
    log.error('GET /folders/:id/delete-impact error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/** Die Spalten, die eine Ordner-Antwort traegt - eine Schreibweise fuer alle Wege. */
const FOLDER_COLUMNS = 'id, name, parent_id, module_key, created_by, created_at, updated_at';

router.post('/folders', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
    const vParent = parentId(req.body.parent_id);
    if (vParent.error) return res.status(400).json({ error: vParent.error, code: 400 });
    if (vParent.value !== null && activeFolderTreeDeletes.has(vParent.value)) {
      return deletionInProgress(res);
    }

    const moveError = folderMoveError(null, vParent.value);
    if (moveError) return res.status(400).json({ error: moveError, code: 400 });

    const result = db.get().prepare('INSERT INTO family_document_folders (name, parent_id, created_by) VALUES (?, ?, ?)')
      .run(vName.value, vParent.value, userId(req));
    const row = db.get().prepare(`SELECT ${FOLDER_COLUMNS} FROM family_document_folders WHERE id = ?`)
      .get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      // Der Name kollidiert ab jetzt nur noch mit den GESCHWISTERN (Migration
      // v164) - "Rechnungen" darf unter "Auto" und unter "Wohnung" stehen.
      return res.status(409).json({ error: 'A folder with this name already exists here.', code: 409 });
    }
    log.error('POST /folders error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.put('/folders/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid folder id.', code: 400 });
    }
    if (activeFolderTreeDeletes.has(id)) return deletionInProgress(res);
    const existing = db.get().prepare('SELECT id, name, parent_id FROM family_document_folders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Folder not found.', code: 404 });

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
      const vParent = parentId(req.body.parent_id);
      if (vParent.error) return res.status(400).json({ error: vParent.error, code: 400 });
      if (vParent.value !== null && activeFolderTreeDeletes.has(vParent.value)) {
        return deletionInProgress(res);
      }
      const moveError = folderMoveError(id, vParent.value);
      if (moveError) return res.status(400).json({ error: moveError, code: 400 });
      parent = vParent.value;
    }

    db.get().prepare('UPDATE family_document_folders SET name = ?, parent_id = ? WHERE id = ?')
      .run(name, parent, id);
    const row = db.get().prepare(`SELECT ${FOLDER_COLUMNS} FROM family_document_folders WHERE id = ?`).get(id);
    res.json({ data: row });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A folder with this name already exists here.', code: 409 });
    }
    log.error('PUT /folders/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/folders/:id', async (req, res) => {
  let deletionLock = null;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid folder id.', code: 400 });
    }
    const documentAction = req.query.documents || 'unfile';
    if (!['unfile', 'delete'].includes(documentAction)) {
      return res.status(400).json({ error: 'Invalid folder document action.', code: 400 });
    }
    const parseExpectedCount = (value) => {
      if (value === undefined) return null;
      const count = Number(value);
      return Number.isInteger(count) && count >= 0 ? count : Number.NaN;
    };
    const expectedDocuments = parseExpectedCount(req.query.expected_documents);
    const expectedFolders = parseExpectedCount(req.query.expected_folders);
    const expectedSnapshot = req.query.expected_snapshot === undefined
      ? null
      : String(req.query.expected_snapshot);
    if (Number.isNaN(expectedDocuments) || Number.isNaN(expectedFolders)) {
      return res.status(400).json({ error: 'Invalid expected folder impact.', code: 400 });
    }
    if (expectedSnapshot !== null && !/^[a-f0-9]{64}$/.test(expectedSnapshot)) {
      return res.status(400).json({ error: 'Invalid expected folder snapshot.', code: 400 });
    }
    const existing = db.get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Folder not found.', code: 404 });

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
    const subtree = [...subtreeIds(allFolders(), id)];
    const folderParams = Object.fromEntries(subtree.map((value, i) => [`f${i}`, value]));
    const folderPlaceholders = subtree.map((_v, i) => `@f${i}`).join(',');
    const documents = db.get()
      // content_data bleibt bewusst draussen: Legacy-BLOBs koennen bis zum
      // Uploadlimit gross sein, fuer das Loeschen braucht der Storage-Adapter
      // aber nur Backend und Key.
      .prepare(`
        SELECT id, name, storage_backend, storage_key, created_by
        FROM family_documents
        WHERE folder_id IN (${folderPlaceholders})
        ORDER BY id ASC
      `)
      .all(folderParams);
    const visibleDocumentIds = new Set(db.get()
      .prepare(`
        SELECT d.id
        FROM family_documents d
        WHERE d.folder_id IN (${folderPlaceholders})
          AND ${documentVisibleSql('d')}
      `)
      .all({ ...folderParams, userId: userId(req) })
      .map((document) => document.id));
    const deleteDocuments = documentAction === 'delete';

    if (deleteDocuments && expectedSnapshot === null) {
      return res.status(400).json({
        error: 'A current folder deletion preview is required.',
        code: 400,
      });
    }

    // ERST DIE BERECHTIGUNG, DANN DER VERGLEICH (#1355). Die Besitzpruefung
    // laeuft ueber den GANZEN Zweig, bevor ein externer Speicher angefasst
    // wird - sonst koennte ein Mitglied erst eigene Dateien loeschen und beim
    // ersten fremden Dokument in einem halben Baum stranden. Und sie laeuft
    // vor dem Snapshot-Vergleich: wer den Zweig ohnehin nicht loeschen darf,
    // bekommt nie ein 409 "Inhalt geaendert", das nur ueber unsichtbare
    // Dokumente zustande kaeme.
    if (deleteDocuments && (visibleDocumentIds.size !== documents.length
        || !documents.every((document) => mayManage(req, document)))) {
      return res.status(403).json({
        error: 'Not authorized to delete every document in this folder.',
        code: 403,
        reason: 'FOLDER_DOCUMENTS_NOT_MANAGEABLE',
      });
    }

    // Der Dialog bestaetigt konkrete Zahlen UND Identitaeten. Hat sich der
    // sichtbare Zweig seit seinem Impact-GET veraendert, darf der folgende
    // Klick nicht still andere Inhalte loeschen als angezeigt. Der destruktive
    // Modus ist neu und verlangt den Snapshot; der sichere Unfile-Default
    // bleibt fuer alte Clients ohne Erwartungswerte kompatibel. Der Snapshot
    // wird wie im GET nur ueber die sichtbaren Dokumente gebildet.
    const visibleIds = documents
      .map((document) => document.id)
      .filter((documentId) => visibleDocumentIds.has(documentId));
    const currentSnapshot = folderDeleteSnapshot(
      subtree,
      visibleIds,
      folderDeleteLinkedState(visibleIds),
    );
    if ((expectedDocuments !== null && expectedDocuments !== visibleDocumentIds.size)
        || (expectedFolders !== null && expectedFolders !== subtree.length)
        || (expectedSnapshot !== null && expectedSnapshot !== currentSnapshot)) {
      return res.status(409).json({
        error: 'Folder contents changed. Review the deletion impact and try again.',
        code: 409,
        reason: 'FOLDER_CONTENT_CHANGED',
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
    // wird nicht nebenher entordnet. Pruefung und Schreiben laufen ohne
    // await dazwischen.
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
      const currentSubtree = [...subtreeIds(allFolders(), id)];
      const currentFolderParams = Object.fromEntries(currentSubtree.map((value, i) => [`f${i}`, value]));
      const currentFolderPlaceholders = currentSubtree.map((_v, i) => `@f${i}`).join(',');
      const remainingDocuments = db.get()
        .prepare(`
          SELECT id, name
          FROM family_documents
          WHERE folder_id IN (${currentFolderPlaceholders})
          ORDER BY id ASC
        `)
        .all(currentFolderParams);
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
      unfiled_documents: deleteDocuments ? 0 : visibleDocumentIds.size,
      deleted_documents: deleteDocuments ? documents.length : 0,
      failed_documents: [],
      folder_deleted: true,
    } });
  } catch (err) {
    log.error('DELETE /folders/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  } finally {
    deletionLock?.folderIds.forEach((folderId) => activeFolderTreeDeletes.delete(folderId));
    unlockDocumentDeletes(deletionLock?.documentIds);
  }
});

router.get('/', (req, res) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'active';
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const folderId = req.query.folder_id !== undefined && req.query.folder_id !== ''
      ? Number(req.query.folder_id)
      : null;
    // `?expiring=<days>` - Dokumente, deren Ablauf innerhalb der naechsten N Tage
    // liegt oder bereits vergangen ist (dieselbe "faellig ODER ueberfaellig"-
    // Lesart wie der Chip von public/utils/date-status.js). Ein ungueltiger Wert
    // wird still uebersprungen (Filter bleibt aus, volle Liste) statt mit 400
    // abgelehnt - derselbe Umgang wie beim Rest dieser Route (`status`/`category`
    // fallen ebenso auf "kein Filter" zurueck statt einen Request abzulehnen).
    const expiringDays = req.query.expiring !== undefined && req.query.expiring !== ''
      ? Number(req.query.expiring)
      : null;
    const expiringWithinDays = Number.isInteger(expiringDays) && expiringDays >= 0 ? expiringDays : null;

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
    if (folderId != null && Number.isInteger(folderId) && folderId > 0) {
      const exists = db.get().prepare('SELECT id FROM family_document_folders WHERE id = ?').get(folderId);
      subtree = exists ? [...subtreeIds(allFolders(), folderId)] : [folderId];
    }

    /* Benannte Platzhalter auch fuer die Liste: die uebrige Abfrage laeuft
     * ueber `@userId`/`@status`, und better-sqlite3 nimmt benannte und
     * positionelle Parameter nicht im selben Aufruf. */
    const folderParams = Object.fromEntries((subtree ?? []).map((value, i) => [`f${i}`, value]));
    const folderClause = subtree
      ? `AND d.folder_id IN (${subtree.map((_v, i) => `@f${i}`).join(',')})`
      : '';
    const params = {
      userId: userId(req), status, category, expiringWithinDays,
      // `expires_at` ist ein lokal eingegebener Kalendertag, kein Instant -
      // `date('now')` waere der UTC-Tag und oestlich von UTC am fruehen Abend,
      // westlich davon am fruehen Morgen der falsche (server/services/
      // task-scope.js hat dieselbe Falle). `todayKey()` bindet stattdessen den
      // Haushalts-Tagesschluessel als Parameter.
      today: todayKey(db.get()),
      ...folderParams,
    };
    const expiringClause = expiringWithinDays !== null
      ? "AND d.expires_at IS NOT NULL AND date(d.expires_at) <= date(@today, '+' || @expiringWithinDays || ' days')"
      : '';
    const rows = db.get().prepare(`
      ${documentSelect()}
      WHERE ${canSeeSql('d')}
        AND d.status = @status
        AND (@category IS NULL OR d.category = @category)
        ${folderClause}
        ${expiringClause}
      GROUP BY d.id
      ORDER BY d.updated_at DESC
    `).all(params);
    res.json({ data: rows.map(normalizeDocument) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/', async (req, res) => {
  let stagedUpload;
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vDescription = str(req.body.description, 'Description', { max: MAX_TEXT, required: false });
    const vOriginalName = str(req.body.original_name, 'Original filename', { max: MAX_TITLE });
    const vFolderName = str(req.body.folder_name, 'Folder name', { max: MAX_TITLE, required: false });
    const vExpiresAtField = vExpiresAt(req.body.expires_at);
    const vExpiryReminderDaysField = vExpiryReminderDays(req.body.expiry_reminder_days);
    const errors = collectErrors([vName, vDescription, vOriginalName, vFolderName, vExpiresAtField, vExpiryReminderDaysField]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // `folder_key` benennt den Systemordner eines Moduls, `folder_name` nur
    // seine Beschriftung. Ein unbekannter Schluessel wird still verworfen und
    // faellt auf den Namen zurueck - eine aeltere App-Version, die ihn noch
    // nicht mitschickt, legt weiter ueber den Namen ab (Migration v157).
    const folderKey = isModuleFolderKey(req.body.folder_key) ? req.body.folder_key : null;

    const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
    const visibility = VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : 'family';
    const vFolderId = req.body.folder_id !== undefined && req.body.folder_id !== null && req.body.folder_id !== ''
      ? validateId(req.body.folder_id, 'folder_id')
      : { value: null, error: null };
    if (vFolderId.error) return res.status(400).json({ error: vFolderId.error, code: 400 });
    if (req.body.folder_id !== undefined && vFolderId.value !== null
        && activeFolderTreeDeletes.has(vFolderId.value)) {
      return deletionInProgress(res);
    }
    const parsed = parseDataUrl(req.body.content_data);
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: 400 });

    const allowedIds = visibility === 'restricted' ? parseMemberIds(req.body.allowed_member_ids) : [];
    // Freigeben laesst sich ein neues Dokument nur Haushaltsmitgliedern (#1207).
    const strangers = newNonMembers(allowedIds);
    if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });
    stagedUpload = await stageDocumentUpload({
      buffer: parsed.buffer,
      mime: parsed.mime,
      category,
      originalName: vOriginalName.value,
    });
    const database = db.get();
    const row = database.transaction(() => {
      const folderId = vFolderId.value ?? ensureFolder(folderKey, vFolderName.value, userId(req));
      const expiresAt = vExpiresAtField.value ?? null;
      const expiryReminderDays = vExpiryReminderDaysField.value ?? null;
      const result = database.prepare(`
        INSERT INTO family_documents (
          name, description, category, visibility, folder_id, original_name,
          mime_type, file_size, content_data, storage_provider, storage_backend,
          storage_key, created_by, expires_at, expiry_reminder_days
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vName.value,
        vDescription.value,
        category,
        visibility,
        folderId,
        vOriginalName.value,
        parsed.mime,
        parsed.size,
        stagedUpload.content_data,
        stagedUpload.storage_provider,
        stagedUpload.storage_backend,
        stagedUpload.storage_key,
        userId(req),
        expiresAt,
        expiryReminderDays
      );
      if (visibility === 'restricted') replaceAccess(result.lastInsertRowid, allowedIds);
      syncDocumentExpiryReminder({
        id: result.lastInsertRowid,
        expires_at: expiresAt,
        expiry_reminder_days: expiryReminderDays,
        created_by: userId(req),
      });
      return database.prepare(`
        ${documentSelect()}
        WHERE d.id = ?
        GROUP BY d.id
      `).get(result.lastInsertRowid);
    })();
    res.status(201).json({ data: normalizeDocument(row) });
  } catch (err) {
    if (err instanceof StorageError) {
      log.error('POST / storage error:', err);
      return sendStorageError(res, err, 'Document storage upload failed.');
    }
    log.error('POST / error:', err);
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
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = getVisibleDocument(id, req);
    if (!existing) return res.status(404).json({ error: 'Document not found.', code: 404 });
    if (!mayManage(req, existing)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    if (documentDeleteIsActive(id)) return documentDeletionInProgress(res);

    const vName = req.body.name !== undefined ? str(req.body.name, 'Name', { max: MAX_TITLE }) : { value: null };
    const vDescription = req.body.description !== undefined ? str(req.body.description, 'Description', { max: MAX_TEXT, required: false }) : { value: null };
    const vExpiresAtField = vExpiresAt(req.body.expires_at);
    const vExpiryReminderDaysField = vExpiryReminderDays(req.body.expiry_reminder_days);
    const errors = collectErrors([vName, vDescription, vExpiresAtField, vExpiryReminderDaysField]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const category = req.body.category !== undefined && CATEGORIES.includes(req.body.category) ? req.body.category : null;
    const visibility = req.body.visibility !== undefined && VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : null;
    const status = req.body.status !== undefined && STATUSES.includes(req.body.status) ? req.body.status : null;
    const vFolderId = req.body.folder_id !== undefined && req.body.folder_id !== null && req.body.folder_id !== ''
      ? validateId(req.body.folder_id, 'folder_id')
      : { value: null, error: null };
    if (vFolderId.error) return res.status(400).json({ error: vFolderId.error, code: 400 });
    if (req.body.folder_id !== undefined && vFolderId.value !== null
        && activeFolderTreeDeletes.has(vFolderId.value)) {
      return deletionInProgress(res);
    }
    const allowedIds = (visibility || existing.visibility) === 'restricted' ? parseMemberIds(req.body.allowed_member_ids) : [];
    // Neu freigeben laesst sich nur Haushaltsmitgliedern (#1207). Wer schon
    // freigegeben ist - auch Hauspersonal oder ein Gast -, bleibt speicherbar.
    // Geprueft vor dem UPDATE: eine abgelehnte Anfrage aendert nichts.
    const storedAccess = db.get().prepare('SELECT user_id FROM family_document_access WHERE document_id = ?')
      .all(id).map((row) => row.user_id);
    const strangers = newNonMembers(allowedIds, { stored: storedAccess });
    if (strangers.length) return res.status(400).json({ error: nonMemberMessage(strangers), code: 400 });
    const expiresAt = req.body.expires_at !== undefined ? vExpiresAtField.value : existing.expires_at;
    const expiryReminderDays = req.body.expiry_reminder_days !== undefined ? vExpiryReminderDaysField.value : existing.expiry_reminder_days;
    db.get().prepare(`
      UPDATE family_documents
      SET name = COALESCE(?, name),
          description = ?,
          category = COALESCE(?, category),
          visibility = COALESCE(?, visibility),
          status = COALESCE(?, status),
          folder_id = ?,
          expires_at = ?,
          expiry_reminder_days = ?
      WHERE id = ?
    `).run(
      req.body.name !== undefined ? vName.value : null,
      req.body.description !== undefined ? vDescription.value : existing.description,
      category,
      visibility,
      status,
      req.body.folder_id !== undefined ? vFolderId.value : existing.folder_id,
      expiresAt,
      expiryReminderDays,
      id
    );
    replaceAccess(id, allowedIds);

    // Ein archiviertes Dokument darf nicht mehr nagen (ein archiviertes
    // Passfoto etwa) - dieselbe Teardown-Regel wie DELETE/Ordner-Loeschen.
    const finalStatus = status ?? existing.status;
    if (finalStatus === 'archived') {
      removeDocumentExpiryReminder(id);
    } else {
      syncDocumentExpiryReminder({ id, expires_at: expiresAt, expiry_reminder_days: expiryReminderDays, created_by: existing.created_by });
    }

    const row = db.get().prepare(`${documentSelect()} WHERE d.id = ? GROUP BY d.id`).get(id);
    res.json({ data: normalizeDocument(row) });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.patch('/:id/archive', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = getVisibleDocument(id, req);
    if (!existing) return res.status(404).json({ error: 'Document not found.', code: 404 });
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
        id, expires_at: existing.expires_at, expiry_reminder_days: existing.expiry_reminder_days, created_by: existing.created_by,
      });
    }
    res.json({ data: { id, status } });
  } catch (err) {
    log.error('PATCH /:id/archive error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/:id/thumbnail', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const doc = getVisibleDocument(id, req, true);
    if (!doc) return res.status(404).json({ error: 'Document not found.', code: 404 });
    if (doc.storage_backend !== 'dms') {
      return res.status(415).json({ error: 'Thumbnail not available for this document.', code: 415 });
    }
    const account = loadDmsAccount(doc.dms_account_id);
    if (!account) return res.status(404).json({ error: 'Linked DMS account is gone.', code: 404 });
    const thumb = await resolveDmsThumbnail(account, doc.storage_key);
    sendThumbnail(res, thumb, 300);
  } catch (err) {
    if (err instanceof ThumbnailUnavailableError) {
      return res.status(415).json({ error: 'Thumbnail not available for this document.', code: 415 });
    }
    log.error('GET /:id/thumbnail error:', err);
    res.status(502).json({ error: 'Failed to load thumbnail.', code: 502 });
  }
});

router.get('/:id/preview', async (req, res) => {
  try {
    const id = Number(req.params.id);
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
    res.setHeader('Cache-Control', doc.storage_backend === 'dms'
      ? 'private, max-age=60'
      : 'private, max-age=300');
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
    log.error('GET /:id/preview error:', err);
    if (sendStorageError(res, err, 'Document storage read failed.')) return;
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/:id/download', async (req, res) => {
  try {
    const id = Number(req.params.id);
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
    log.error('GET /:id/download error:', err);
    if (sendStorageError(res, err, 'Document storage read failed.')) return;
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/:id', async (req, res) => {
  let lockedId = null;
  try {
    const id = Number(req.params.id);
    const existing = getVisibleDocument(id, req, true);
    if (!existing) return res.status(404).json({ error: 'Document not found.', code: 404 });
    if (!mayManage(req, existing)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    if (documentDeleteIsActive(id)) return documentDeletionInProgress(res);
    lockDocumentDeletes([id]);
    lockedId = id;
    await deleteDocumentContent(existing);
    db.get().prepare('DELETE FROM family_documents WHERE id = ?').run(id);
    removeDocumentExpiryReminder(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    if (sendStorageError(res, err, 'Document storage delete failed.')) return;
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  } finally {
    if (lockedId !== null) unlockDocumentDeletes([lockedId]);
  }
});

export default router;
