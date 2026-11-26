/**
 * Module: DMS Integration Routes
 * Purpose: Manage DMS connections (admin) and proxy search/link/upload against a DMS.
 * Dependencies: express, server/db.js, server/services/dms/index.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { str, MAX_TITLE } from '../api/formats.ts';
import { requireAdmin } from '../middleware/require-admin.js';
import { validateRequest } from '../api/validate-request.ts';
import { getAdapter as defaultGetAdapter } from '../services/dms/index.js';
import { visibleWhere } from '../authorize/index.ts';
import { StorageError, readDocumentContent } from '../services/document-storage.js';
import paperlessFoldersRouter from './paperless-folders.js';

let adapterFactory = defaultGetAdapter;
export function _setAdapterFactory(fn) { adapterFactory = fn || defaultGetAdapter; }

const log = createLogger('DMS');
const router = express.Router();
router.use('/paperless', paperlessFoldersRouter);

// Paperless prueft den Zugriff in seinen eigenen Routen. Die Routen unter
// diesem Riegel sind Sache der Admins: Konten verwalten, und das
// DMS ungefiltert durchsuchen, wodurch die Sichtbarkeitsgrenzen des
// Dokumente-Moduls umgangen wuerden. Als Router-Riegel und nicht je Route
// (#2810, Gruppe 8): eine neue Route erbt ihn, statt ihn vergessen zu koennen,
// und er steht vor validateRequest() in jeder Route - ein Mitglied bekommt
// seine 403 vor jeder Pruefung der Anfrage, wie zuvor aus der ersten Zeile
// jedes Handlers.
router.use(requireAdmin);

// Bild-Typen, die als Vorschau im Verknüpfungs-Picker (Issue #533) inline
// ausgeliefert werden dürfen. Nur nicht-skriptfähige Rasterformate (kein SVG).
const THUMBNAIL_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function normalizeMime(value) { return String(value || '').split(';')[0].trim().toLowerCase(); }

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

/**
 * A path id as the number the schema checked: plain decimal digits with an
 * optional minus, at most MAX_PATH_ID (validateRequest(), #2810). `0`, `-0`
 * and `-1` find no account (404), a leading zero reaches the row.
 * @param {any} req
 * @param {string} [name]
 * @returns {number}
 */
function pathId(req, name = 'id') {
  return Number(req.params[name]);
}

function userId(req) { return req.authUserId || req.session?.userId; }

function publicAccount(row) {
  if (!row) return null;
  const { api_token, ...rest } = row;
  return { ...rest, has_token: Boolean(api_token) };
}

function getAccount(id) {
  return db.get().prepare('SELECT * FROM dms_accounts WHERE id = ?').get(id);
}

router.get('/accounts', validateRequest(), (req, res) => {
  const rows = db.get().prepare('SELECT * FROM dms_accounts ORDER BY name COLLATE NOCASE').all();
  res.json({ data: rows.map(publicAccount) });
});

router.post('/accounts', validateRequest(), (req, res) => {
  try {
    // One of DMS_PROVIDERS: the schema's check (#2810; an unknown value was
    // `paperless` until v2.93). Left out it still is.
    const provider = req.body.provider ?? 'paperless';
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vUrl = str(req.body.base_url, 'Base URL', { max: 500 });
    const vToken = str(req.body.api_token, 'API token', { max: 500 });
    const vOrgId = provider === 'papra' ? str(req.body.org_id, 'Organization ID', { max: 200 }) : { value: '', error: null };
    // #1909: das Formular der Einstellungen prueft selbst nichts. Ein leeres
    // Pflichtfeld und eine Adresse ohne Schema nennen ihren Fall; ein zu langer
    // Wert bleibt ohne Grund (das Formular begrenzt Name und Organisation).
    const required = [req.body.name, req.body.base_url, req.body.api_token];
    if (provider === 'papra') required.push(req.body.org_id);
    const missing = required.some((value) => String(value ?? '').trim() === '');
    for (const v of [vName, vUrl, vToken, vOrgId]) {
      if (v.error) return res.status(400).json({ error: v.error, code: 400, ...(missing ? { reason: 'dms_field_required' } : {}) });
    }
    if (!/^https?:\/\//i.test(vUrl.value)) {
      return res.status(400).json({ error: 'Base URL must start with http(s)://', code: 400, reason: 'dms_url_invalid' });
    }

    const result = db.get().prepare(`
      INSERT INTO dms_accounts (provider, name, base_url, org_id, api_token) VALUES (?, ?, ?, ?, ?)
    `).run(provider, vName.value, vUrl.value.replace(/\/+$/, ''), vOrgId.value, vToken.value);
    res.status(201).json({ data: publicAccount(getAccount(result.lastInsertRowid)) });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A DMS account with this URL already exists.', code: 409, reason: 'dms_account_exists' });
    }
    throw err;
  }
});

router.delete('/accounts/:id', validateRequest(), (req, res) => {
  const id = pathId(req);
  const existing = getAccount(id);
  if (!existing) return res.status(404).json({ error: 'DMS account not found.', code: 404, reason: 'dms_account_not_found' });
  db.get().prepare('DELETE FROM dms_accounts WHERE id = ?').run(id);
  res.status(204).end();
});

router.post('/accounts/:id/test', validateRequest(), async (req, res) => {
  const account = getAccount(pathId(req));
  if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404, reason: 'dms_account_not_found' });
  const result = await adapterFactory(account).testConnection();
  db.get().prepare("UPDATE dms_accounts SET last_check = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(account.id);
  res.json({ data: result });
});

router.get('/search', validateRequest(), async (req, res) => {
  try {
    // Admin-only (router.use above): DMS search proxies the entire Paperless instance ungescoped, which would
    // bypass the per-document restricted/private visibility boundaries of the documents module.
    const account = getAccount(Number(req.query.account_id));
    if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404, reason: 'dms_account_not_found' });
    // Leerer Query ist erlaubt: er listet alle Dokumente des DMS, damit der Nutzer
    // durchblättern und verlinken kann, ohne exakte Suchbegriffe zu kennen (Issue #449).
    const q = String(req.query.q || '').trim();
    const results = await adapterFactory(account).search(q, { limit: 20 });
    res.json({ data: results });
  } catch (err) {
    log.error('GET /search error:', err);
    res.status(502).json({ error: 'DMS search failed.', code: 502 });
  }
});

router.get('/thumbnail', validateRequest(), async (req, res) => {
  try {
    // Admin-only wie /search (router.use oben): der Picker durchsucht das gesamte DMS ungescoped,
    // bevor ein Dokument in die sichtbarkeitsgebundene Dokumentenliste übernommen wird.
    const account = getAccount(Number(req.query.account_id));
    if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404, reason: 'dms_account_not_found' });
    const dmsId = String(req.query.dms_document_id || '').trim();
    if (!dmsId) return res.status(400).json({ error: 'dms_document_id is required.', code: 400 });

    const adapter = adapterFactory(account);
    if (typeof adapter.fetchThumbnail !== 'function') {
      return res.status(415).json({ error: 'Thumbnail not available for this document.', code: 415 });
    }
    const thumb = await adapter.fetchThumbnail(dmsId);
    const mime = normalizeMime(thumb?.mime);
    if (!thumb?.buffer?.length || !THUMBNAIL_MIME.has(mime)) {
      return res.status(415).json({ error: 'Thumbnail not available for this document.', code: 415 });
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(thumb.buffer.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Vorschaubild = Dokumentinhalt: kein Rest im HTTP-Cache des Geraets.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.end(thumb.buffer);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'DMS document not found.', code: 404 });
    log.error('GET /thumbnail error:', err);
    res.status(502).json({ error: 'Failed to load thumbnail.', code: 502 });
  }
});

router.post('/link', validateRequest(), async (req, res) => {
  const account = getAccount(Number(req.body.account_id));
  if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404, reason: 'dms_account_not_found' });
  const dmsId = String(req.body.dms_document_id || '').trim();
  if (!dmsId) return res.status(400).json({ error: 'dms_document_id is required.', code: 400 });

  const linked = () => db.get().prepare(`
    SELECT id FROM family_documents
    WHERE storage_backend = 'dms' AND dms_account_id = ? AND storage_key = ?
  `).get(account.id, dmsId);
  const alreadyLinked = () => res.status(409).json({ error: 'This DMS document is already linked.', code: 409, reason: 'dms_document_already_linked' });
  if (linked()) return alreadyLinked();

  // NUR DIE ANFRAGE AN DAS DMS ist "nicht erreichbar" (#1909, Codex an #1994).
  // Was danach lokal scheitert, ist ein Fehler dieses Servers und bleibt 500.
  let doc;
  try {
    doc = await adapterFactory(account).getDocument(dmsId);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'DMS document not found.', code: 404, reason: 'dms_document_not_found' });
    log.error('POST /link DMS error:', err);
    return res.status(502).json({ error: 'Failed to link DMS document.', code: 502, reason: 'dms_unreachable' });
  }
  // Waehrend der Anfrage kann ein Admin das Konto entfernt oder jemand
  // dasselbe Dokument verknuepft haben: erst hier, ohne await bis zum
  // INSERT, ist das verbindlich.
  if (!getAccount(account.id)) return res.status(404).json({ error: 'DMS account not found.', code: 404, reason: 'dms_account_not_found' });
  if (linked()) return alreadyLinked();
  // From their lists: the schema's check (#2810; an unknown value became
  // `other` and `family` until v2.93). Left out they still are.
  const category = req.body.category ?? 'other';
  const visibility = req.body.visibility ?? 'family';
  const meta = JSON.stringify({ correspondent: doc.correspondent ?? null, tags: doc.tags ?? [] });

  // Echten MIME-Typ und Dateigröße aus dem DMS übernehmen, falls der Adapter sie
  // liefert (Papra), sonst aus dem Dateinamen ableiten bzw. 0 (Issue #451).
  const mimeType = doc.mime || mimeFromFilename(doc.filename);
  const fileSize = Number.isFinite(doc.size) && doc.size >= 0 ? doc.size : 0;

  const result = db.get().prepare(`
    INSERT INTO family_documents
      (name, category, visibility, original_name, mime_type, file_size, content_data,
       storage_provider, storage_backend, storage_key, dms_account_id, external_url, external_meta, created_by)
    VALUES (?, ?, ?, ?, ?, ?, '', 'external', 'dms', ?, ?, ?, ?, ?)
  `).run(doc.title, category, visibility, doc.filename, mimeType, fileSize, dmsId, account.id, doc.url, meta, userId(req));

  const row = db.get().prepare('SELECT * FROM family_documents WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ data: row });
});

router.post('/push', validateRequest(), async (req, res) => {
  try {
    const account = getAccount(Number(req.body.account_id));
    if (!account) return res.status(404).json({ error: 'DMS account not found.', code: 404, reason: 'dms_account_not_found' });
    const docId = Number(req.body.document_id);
    const doc = db.get().prepare(`
      SELECT d.* FROM family_documents d
      WHERE d.id = @id AND ${visibleWhere('documents', 'd', '@userId')}
    `).get({ id: docId, userId: userId(req) });
    if (!doc) return res.status(404).json({ error: 'Document not found.', code: 404, reason: 'documents_document_not_found' });
    if (doc.storage_backend === 'dms') {
      return res.status(400).json({ error: 'Document is already stored in a DMS.', code: 400, reason: 'dms_document_already_stored' });
    }

    const content = await readDocumentContent(doc, {
      dmsResolver: async (dmsDocument) => {
        const sourceAccount = getAccount(dmsDocument.dms_account_id);
        if (!sourceAccount) throw new Error('DMS account is unavailable.');
        return adapterFactory(sourceAccount).fetchContent(dmsDocument.storage_key);
      },
    });
    // Nur das Hochladen ins DMS ist "nicht erreichbar" (#1909, Codex an #1994).
    let out;
    try {
      out = await adapterFactory(account).upload({
        buffer: content.buffer,
        filename: doc.original_name,
        mime: content.mime,
        title: doc.name,
      });
    } catch (err) {
      log.error('POST /push DMS error:', err);
      return res.status(502).json({ error: 'Failed to upload document to DMS.', code: 502, reason: 'dms_unreachable' });
    }
    res.status(202).json({ data: { taskId: out.taskId } });
  } catch (err) {
    // Only the store's refusal is answered here; anything else goes to the
    // central error handler (#2810).
    if (!(err instanceof StorageError)) throw err;
    log.error('POST /push storage error:', err);
    res.status(502).json({
      error: 'Failed to read document from storage.',
      code: 502,
      storage_code: err.storageCode,
      reason: 'documents_storage_failed',
    });
  }
});

export default router;
