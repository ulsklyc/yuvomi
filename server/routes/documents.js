/**
 * Module: Family Documents
 * Purpose: REST API for locally stored family documents with per-member visibility.
 * Dependencies: express, server/db.js
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { str, collectErrors, id as validateId, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';

const log = createLogger('Documents');
const router = express.Router();

const CATEGORIES = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];
const VISIBILITIES = ['family', 'restricted', 'private'];
const STATUSES = ['active', 'archived'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
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

function userId(req) {
  return req.authUserId || req.session.userId;
}

function isAdmin(req) {
  return req.authRole === 'admin' || req.session?.role === 'admin';
}

function canSeeSql(alias = 'd') {
  return `(
    ${alias}.created_by = @userId
    OR ${alias}.visibility = 'family'
    OR EXISTS (
      SELECT 1 FROM family_document_access a
      WHERE a.document_id = ${alias}.id AND a.user_id = @userId
    )
  )`;
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
  if (buffer.length > MAX_FILE_BYTES) return { error: 'File may be at most 5 MB.' };
  return { mime, base64, size: buffer.length, buffer };
}

function documentSelect() {
  return `
    SELECT d.id, d.name, d.description, d.category, d.status, d.visibility,
           d.original_name, d.mime_type, d.file_size, d.storage_provider,
           d.storage_key, d.folder_id, d.created_by, d.created_at, d.updated_at,
           f.name AS folder_name,
           u.display_name AS creator_name, u.avatar_color AS creator_color,
           GROUP_CONCAT(a.user_id) AS allowed_member_ids
    FROM family_documents d
    LEFT JOIN family_document_folders f ON f.id = d.folder_id
    LEFT JOIN users u ON u.id = d.created_by
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
  const columns = includeContent ? 'd.*' : 'd.id, d.created_by, d.visibility, d.description, d.folder_id';
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

function ensureFolder(name, actorId) {
  const folderName = typeof name === 'string' ? name.trim() : '';
  if (!folderName) return null;
  const existing = db.get().prepare('SELECT id FROM family_document_folders WHERE name = ? COLLATE NOCASE').get(folderName);
  if (existing) return existing.id;
  const result = db.get().prepare('INSERT INTO family_document_folders (name, created_by) VALUES (?, ?)').run(folderName, actorId);
  return result.lastInsertRowid;
}

router.get('/meta/options', (_req, res) => {
  res.json({
    data: {
      categories: CATEGORIES,
      visibilities: VISIBILITIES,
      statuses: STATUSES,
      max_file_size: MAX_FILE_BYTES,
      allowed_mime_types: Array.from(ALLOWED_MIME),
      storage_providers: ['local'],
    },
  });
});

router.get('/folders', (_req, res) => {
  try {
    const rows = db.get().prepare(`
      SELECT id, name, created_by, created_at, updated_at
      FROM family_document_folders
      ORDER BY name COLLATE NOCASE ASC
    `).all();
    res.json({ data: rows });
  } catch (err) {
    log.error('GET /folders error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/folders', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
    const result = db.get().prepare('INSERT INTO family_document_folders (name, created_by) VALUES (?, ?)')
      .run(vName.value, userId(req));
    const row = db.get().prepare('SELECT id, name, created_by, created_at, updated_at FROM family_document_folders WHERE id = ?')
      .get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Folder already exists.', code: 409 });
    }
    log.error('POST /folders error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/', (req, res) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'active';
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const folderId = req.query.folder_id !== undefined && req.query.folder_id !== ''
      ? Number(req.query.folder_id)
      : null;
    const params = { userId: userId(req), status, category, folderId };
    const rows = db.get().prepare(`
      ${documentSelect()}
      WHERE ${canSeeSql('d')}
        AND d.status = @status
        AND (@category IS NULL OR d.category = @category)
        AND (@folderId IS NULL OR d.folder_id = @folderId)
      GROUP BY d.id
      ORDER BY d.updated_at DESC
    `).all(params);
    res.json({ data: rows.map(normalizeDocument) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vDescription = str(req.body.description, 'Description', { max: MAX_TEXT, required: false });
    const vOriginalName = str(req.body.original_name, 'Original filename', { max: MAX_TITLE });
    const vFolderName = str(req.body.folder_name, 'Folder name', { max: MAX_TITLE, required: false });
    const errors = collectErrors([vName, vDescription, vOriginalName, vFolderName]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
    const visibility = VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : 'family';
    const vFolderId = req.body.folder_id !== undefined && req.body.folder_id !== null && req.body.folder_id !== ''
      ? validateId(req.body.folder_id, 'folder_id')
      : { value: null, error: null };
    if (vFolderId.error) return res.status(400).json({ error: vFolderId.error, code: 400 });
    const parsed = parseDataUrl(req.body.content_data);
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: 400 });

    const allowedIds = visibility === 'restricted' ? parseMemberIds(req.body.allowed_member_ids) : [];
    const folderId = vFolderId.value ?? ensureFolder(vFolderName.value, userId(req));
    const database = db.get();
    const result = database.prepare(`
      INSERT INTO family_documents
        (name, description, category, visibility, folder_id, original_name, mime_type, file_size, content_data, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(vName.value, vDescription.value, category, visibility, folderId, vOriginalName.value, parsed.mime, parsed.size, parsed.base64, userId(req));
    if (visibility === 'restricted') replaceAccess(result.lastInsertRowid, allowedIds);

    const row = database.prepare(`
      ${documentSelect()}
      WHERE d.id = ?
      GROUP BY d.id
    `).get(result.lastInsertRowid);
    res.status(201).json({ data: normalizeDocument(row) });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = getVisibleDocument(id, req);
    if (!existing) return res.status(404).json({ error: 'Document not found.', code: 404 });
    if (existing.created_by !== userId(req) && !isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });

    const vName = req.body.name !== undefined ? str(req.body.name, 'Name', { max: MAX_TITLE }) : { value: null };
    const vDescription = req.body.description !== undefined ? str(req.body.description, 'Description', { max: MAX_TEXT, required: false }) : { value: null };
    const errors = collectErrors([vName, vDescription]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const category = req.body.category !== undefined && CATEGORIES.includes(req.body.category) ? req.body.category : null;
    const visibility = req.body.visibility !== undefined && VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : null;
    const status = req.body.status !== undefined && STATUSES.includes(req.body.status) ? req.body.status : null;
    const vFolderId = req.body.folder_id !== undefined && req.body.folder_id !== null && req.body.folder_id !== ''
      ? validateId(req.body.folder_id, 'folder_id')
      : { value: null, error: null };
    if (vFolderId.error) return res.status(400).json({ error: vFolderId.error, code: 400 });
    db.get().prepare(`
      UPDATE family_documents
      SET name = COALESCE(?, name),
          description = ?,
          category = COALESCE(?, category),
          visibility = COALESCE(?, visibility),
          status = COALESCE(?, status),
          folder_id = ?
      WHERE id = ?
    `).run(
      req.body.name !== undefined ? vName.value : null,
      req.body.description !== undefined ? vDescription.value : existing.description,
      category,
      visibility,
      status,
      req.body.folder_id !== undefined ? vFolderId.value : existing.folder_id,
      id
    );
    if ((visibility || existing.visibility) === 'restricted') replaceAccess(id, parseMemberIds(req.body.allowed_member_ids));
    else replaceAccess(id, []);

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
    if (existing.created_by !== userId(req) && !isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const status = req.body.archived === false ? 'active' : 'archived';
    db.get().prepare('UPDATE family_documents SET status = ? WHERE id = ?').run(status, id);
    res.json({ data: { id, status } });
  } catch (err) {
    log.error('PATCH /:id/archive error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/:id/preview', (req, res) => {
  try {
    const id = Number(req.params.id);
    const doc = getVisibleDocument(id, req, true);
    if (!doc) return res.status(404).json({ error: 'Document not found.', code: 404 });
    const filename = encodeURIComponent(doc.original_name.replace(/[/\\]/g, '_'));
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Length', String(doc.file_size));
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(Buffer.from(doc.content_data, 'base64'));
  } catch (err) {
    log.error('GET /:id/preview error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/:id/download', (req, res) => {
  try {
    const id = Number(req.params.id);
    const doc = getVisibleDocument(id, req, true);
    if (!doc) return res.status(404).json({ error: 'Document not found.', code: 404 });
    const filename = encodeURIComponent(doc.original_name.replace(/[/\\]/g, '_'));
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Length', String(doc.file_size));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(Buffer.from(doc.content_data, 'base64'));
  } catch (err) {
    log.error('GET /:id/download error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = getVisibleDocument(id, req);
    if (!existing) return res.status(404).json({ error: 'Document not found.', code: 404 });
    if (existing.created_by !== userId(req) && !isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    db.get().prepare('DELETE FROM family_documents WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
