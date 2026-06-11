/**
 * Module: DMS Integration Routes
 * Purpose: Manage DMS connections (admin) and proxy search/link/upload against a DMS.
 * Dependencies: express, server/db.js, server/services/dms/index.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { str, MAX_TITLE } from '../middleware/validate.js';
import { getAdapter as defaultGetAdapter, SUPPORTED_PROVIDERS } from '../services/dms/index.js';
import { StorageError, readDocumentContent } from '../services/document-storage.js';

let adapterFactory = defaultGetAdapter;
export function _setAdapterFactory(fn) { adapterFactory = fn || defaultGetAdapter; }

const log = createLogger('DMS');
const router = express.Router();

const CATEGORIES = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];
const VISIBILITIES = ['family', 'restricted', 'private'];

// Bestmögliche MIME-Ableitung aus der DMS-Dateiendung beim Verlinken. Der echte
// Content-Type wird ohnehin beim Preview/Download live aus dem DMS geliefert; dieser
// Wert steuert nur Listen-Icon/Viewer-Renderer. Unbekannt → octet-stream (Download-only).
function mimeFromFilename(filename) {
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const map = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', txt: 'text/plain', csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || 'application/octet-stream';
}

function userId(req) { return req.authUserId || req.session?.userId; }
function isAdmin(req) { return req.authRole === 'admin' || req.session?.role === 'admin'; }

function publicAccount(row) {
  if (!row) return null;
  const { api_token, ...rest } = row;
  return { ...rest, has_token: Boolean(api_token) };
}

function getAccount(id) {
  return db.get().prepare('SELECT * FROM dms_accounts WHERE id = ?').get(id);
}

router.get('/accounts', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const rows = db.get().prepare('SELECT * FROM dms_accounts ORDER BY name COLLATE NOCASE').all();
    res.json({ data: rows.map(publicAccount) });
  } catch (err) {
    log.error('GET /accounts error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/accounts', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const provider = SUPPORTED_PROVIDERS.includes(req.body.provider) ? req.body.provider : 'paperless';
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vUrl = str(req.body.base_url, 'Base URL', { max: 500 });
    const vToken = str(req.body.api_token, 'API token', { max: 500 });
    for (const v of [vName, vUrl, vToken]) if (v.error) return res.status(400).json({ error: v.error, code: 400 });
    if (!/^https?:\/\//i.test(vUrl.value)) return res.status(400).json({ error: 'Base URL must start with http(s)://', code: 400 });

    const result = db.get().prepare(`
      INSERT INTO dms_accounts (provider, name, base_url, api_token) VALUES (?, ?, ?, ?)
    `).run(provider, vName.value, vUrl.value.replace(/\/+$/, ''), vToken.value);
    res.status(201).json({ data: publicAccount(getAccount(result.lastInsertRowid)) });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A DMS account with this URL already exists.', code: 409 });
    }
    log.error('POST /accounts error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/accounts/:id', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const id = Number(req.params.id);
    const existing = getAccount(id);
    if (!existing) return res.status(404).json({ error: 'DMS account not found.', code: 404 });
    db.get().prepare('DELETE FROM dms_accounts WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /accounts/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/accounts/:id/test', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const account = getAccount(Number(req.params.id));
    if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404 });
    const result = await adapterFactory(account).testConnection();
    db.get().prepare("UPDATE dms_accounts SET last_check = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(account.id);
    res.json({ data: result });
  } catch (err) {
    log.error('POST /accounts/:id/test error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.get('/search', async (req, res) => {
  try {
    // Admin-only: DMS search proxies the entire Paperless instance ungescoped, which would
    // bypass the per-document restricted/private visibility boundaries of the documents module.
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const account = getAccount(Number(req.query.account_id));
    if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404 });
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Query is required.', code: 400 });
    const results = await adapterFactory(account).search(q, { limit: 20 });
    res.json({ data: results });
  } catch (err) {
    log.error('GET /search error:', err);
    res.status(502).json({ error: 'DMS search failed.', code: 502 });
  }
});

router.post('/link', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const account = getAccount(Number(req.body.account_id));
    if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404 });
    const dmsId = String(req.body.dms_document_id || '').trim();
    if (!dmsId) return res.status(400).json({ error: 'dms_document_id is required.', code: 400 });

    const dupe = db.get().prepare(`
      SELECT id FROM family_documents
      WHERE storage_backend = 'dms' AND dms_account_id = ? AND storage_key = ?
    `).get(account.id, dmsId);
    if (dupe) return res.status(409).json({ error: 'This DMS document is already linked.', code: 409 });

    const doc = await adapterFactory(account).getDocument(dmsId);
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
    const visibility = VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : 'family';
    const meta = JSON.stringify({ correspondent: doc.correspondent ?? null, tags: doc.tags ?? [] });

    const result = db.get().prepare(`
      INSERT INTO family_documents
        (name, category, visibility, original_name, mime_type, file_size, content_data,
         storage_provider, storage_backend, storage_key, dms_account_id, external_url, external_meta, created_by)
      VALUES (?, ?, ?, ?, ?, 0, '', 'external', 'dms', ?, ?, ?, ?, ?)
    `).run(doc.title, category, visibility, doc.filename, mimeFromFilename(doc.filename), dmsId, account.id, doc.url, meta, userId(req));

    const row = db.get().prepare('SELECT * FROM family_documents WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'DMS document not found.', code: 404 });
    log.error('POST /link error:', err);
    res.status(502).json({ error: 'Failed to link DMS document.', code: 502 });
  }
});

router.post('/push', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const account = getAccount(Number(req.body.account_id));
    if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404 });
    const docId = Number(req.body.document_id);
    const doc = db.get().prepare(`
      SELECT d.* FROM family_documents d
      WHERE d.id = @id AND (
        d.created_by = @userId OR d.visibility = 'family'
        OR EXISTS (SELECT 1 FROM family_document_access a WHERE a.document_id = d.id AND a.user_id = @userId)
      )
    `).get({ id: docId, userId: userId(req) });
    if (!doc) return res.status(404).json({ error: 'Document not found.', code: 404 });
    if (doc.storage_backend === 'dms') {
      return res.status(400).json({ error: 'Document is already stored in a DMS.', code: 400 });
    }

    const content = await readDocumentContent(doc, {
      dmsResolver: async (dmsDocument) => {
        const sourceAccount = getAccount(dmsDocument.dms_account_id);
        if (!sourceAccount) throw new Error('DMS account is unavailable.');
        return adapterFactory(sourceAccount).fetchContent(dmsDocument.storage_key);
      },
    });
    const out = await adapterFactory(account).upload({
      buffer: content.buffer,
      filename: doc.original_name,
      mime: content.mime,
      title: doc.name,
    });
    res.status(202).json({ data: { taskId: out.taskId } });
  } catch (err) {
    log.error('POST /push error:', err);
    if (err instanceof StorageError) {
      return res.status(502).json({
        error: 'Failed to read document from storage.',
        code: 502,
        storage_code: err.storageCode,
      });
    }
    res.status(502).json({ error: 'Failed to upload document to DMS.', code: 502 });
  }
});

export default router;
