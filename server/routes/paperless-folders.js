/** Virtual folders with scoped media and tags. No local file copies. */
import express from 'express';
import liveSettingsRouter from './paperless-live-settings.js';
import { liveAccount, recheckLiveAccount } from '../services/paperless-live-settings.js';
import paperlessTagsRouter from './paperless-tags.js';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import { paperlessFolderVisibleSql } from '../services/document-access.js';
import { getAdapter } from '../services/dms/index.js';
import { PaperlessViewError, positiveId } from '../services/dms/paperless-views.js';

const router = express.Router();
router.use(liveSettingsRouter);
router.use(paperlessTagsRouter);
const log = createLogger('PaperlessFolders');
const COLUMNS = 'id, name, account_id, view_id, visibility, created_by, created_at, updated_at';
const PREVIEW_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain']);
const THUMB_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
let adapterFactory = getAdapter;
export function _setAdapterFactory(fn) { adapterFactory = fn || getAdapter; }
const actor = (req) => req.authUserId || req.session?.userId;

function problem(status, reason) {
  const err = new Error(reason);
  err.httpStatus = status;
  err.reason = reason;
  return err;
}

function fail(res, err) {
  log.warn(`Paperless folder operation failed (status ${err.httpStatus || (err instanceof PaperlessViewError ? 422 : 500)}).`);
  if (err.httpStatus === 403 && !['paperless_personal_token_required', 'paperless_dms_forbidden'].includes(err.reason)) return res.status(403).json({ error: 'Permission denied.', code: 403 });
  const status = err.httpStatus || (err instanceof PaperlessViewError ? 422 : 500);
  if (status === 500) {
    return res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
  const reason = err.reason || (err instanceof PaperlessViewError ? 'paperless_view_unsupported' : 'paperless_unavailable');
  // Never send upstream response bodies, URLs or credentials to the browser.
  return res.status(status).json({ error: reason, code: status, reason });
}

async function remote(promise) {
  try { return await promise; }
  catch (err) {
    if (Number.isInteger(err.status)) log.warn(`Paperless folders upstream request failed (status ${err.status}).`);
    if (err instanceof PaperlessViewError) throw err;
    if (err.status === 403 || err.status === 401) throw Object.assign(new Error('DMS permission denied.'), { httpStatus: 403, reason: 'paperless_dms_forbidden' });
    throw problem(502, 'paperless_unavailable');
  }
}

function visibleFolder(req, id) {
  if (!positiveId(id)) throw problem(404, 'paperless_folder_not_found');
  const row = db.get().prepare(`SELECT ${COLUMNS} FROM paperless_view_folders f
    WHERE id = @id AND ${paperlessFolderVisibleSql()}`).get({ id, userId: actor(req) });
  if (!row) throw problem(404, 'paperless_folder_not_found');
  return withAccess(row);
}

function withAccess(row) {
  return { ...row, allowed_member_ids: db.get().prepare(
    'SELECT user_id FROM paperless_view_folder_access WHERE folder_id = ? ORDER BY user_id'
  ).all(row.id).map((entry) => entry.user_id) };
}

function replaceAccess(id, memberIds) {
  const database = db.get();
  database.prepare('DELETE FROM paperless_view_folder_access WHERE folder_id = ?').run(id);
  const insert = database.prepare('INSERT INTO paperless_view_folder_access (folder_id, user_id) VALUES (?, ?)');
  for (const memberId of memberIds) insert.run(id, memberId);
}

function unchangedFolder(req, before, source) {
  if (source) recheckLiveAccount(source, actor(req));
  const now = visibleFolder(req, before.id);
  if (now.account_id !== before.account_id || now.view_id !== before.view_id
    || now.visibility !== before.visibility || now.created_by !== before.created_by
    || JSON.stringify(now.allowed_member_ids) !== JSON.stringify(before.allowed_member_ids)) {
    throw problem(409, 'paperless_folder_changed');
  }
  return now;
}


function admin(req) {
  if (!isAdminRequest(req)) throw problem(403, 'Permission denied.');
}

function fields(body) {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200
    || !['private', 'restricted', 'family'].includes(body.visibility)) {
    throw problem(400, 'paperless_folder_invalid');
  }
  const allowed = body.visibility === 'restricted' ? body.allowed_member_ids : [];
  if (!Array.isArray(allowed) || allowed.length > 1000 || allowed.some((id) => !positiveId(id))) {
    throw problem(400, 'paperless_folder_invalid');
  }
  const memberIds = [...new Set(allowed.map(Number))].sort((a, b) => a - b);
  for (const id of memberIds) {
    if (!db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw problem(400, 'paperless_folder_invalid');
  }
  return { name: body.name.trim(), visibility: body.visibility, allowed_member_ids: memberIds };
}

function shareConsent(body, before = null) {
  const wider = before?.visibility !== 'family' && (
    body.visibility === 'family' || (body.visibility === 'restricted'
      && body.allowed_member_ids.some((id) => id !== before?.created_by
        && !before?.allowed_member_ids.includes(id)))
  );
  if (wider && body.confirm_share !== true) throw problem(400, 'paperless_share_confirmation');
}

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Hold the DB identity across remote awaits: a concurrent restore must wait
// for these responses, just as it waits for the core document media routes.
router.get('/saved-views', refuseWhileRestoring, async (req, res) => {
  try {
    admin(req);
    const accountId = positiveId(req.query.account_id);
    const page = positiveId(req.query.page ?? 1);
    if (!accountId || !page || page > 100000) throw problem(400, 'paperless_folder_invalid');
    const source = liveAccount(accountId, actor(req));
    const result = await remote(adapterFactory(source).listSavedViews({ page, pageSize: 50 }));
    recheckLiveAccount(source, actor(req));
    res.json({ data: result.results.map((view) => ({ id: view.id, name: view.name })),
      meta: { page, count: result.count, has_more: result.has_more } });
  } catch (err) { fail(res, err); }
});

router.get('/folders', (req, res) => {
  try {
    const rows = db.get().prepare(`SELECT ${COLUMNS} FROM paperless_view_folders f
      WHERE ${paperlessFolderVisibleSql()} ORDER BY name COLLATE NOCASE, id`).all({ userId: actor(req) });
    res.json({ data: rows.map((row) => ({ ...withAccess(row), can_manage: isAdminRequest(req) && row.created_by === actor(req) })) });
  } catch (err) { fail(res, err); }
});

router.post('/folders', async (req, res) => {
  try {
    admin(req);
    const body = req.body || {};
    const values = fields({ visibility: 'private', ...body });
    shareConsent({ ...body, ...values }, { visibility: 'private', created_by: actor(req), allowed_member_ids: [] });
    const accountId = positiveId(body.account_id);
    const viewId = positiveId(body.view_id);
    if (!accountId || !viewId) throw problem(400, 'paperless_folder_invalid');
    const source = liveAccount(accountId, actor(req));
    await remote(adapterFactory(source).getSavedView(viewId));
    recheckLiveAccount(source, actor(req));
    const result = db.get().transaction(() => {
      const result = db.get().prepare(`INSERT INTO paperless_view_folders
      (name, account_id, view_id, visibility, created_by) VALUES (?, ?, ?, ?, ?)`)
      .run(values.name, accountId, viewId, values.visibility, actor(req));
      replaceAccess(result.lastInsertRowid, values.allowed_member_ids);
      return result;
    })();
    res.status(201).json({ data: visibleFolder(req, result.lastInsertRowid) });
  } catch (err) { fail(res, err); }
});

router.put('/folders/:id', (req, res) => {
  try {
    admin(req);
    const before = visibleFolder(req, req.params.id);
    if (before.created_by !== actor(req)) throw problem(403, 'Permission denied.');
    const values = fields(req.body || {});
    shareConsent({ ...req.body, ...values }, before);
    // Account and view are immutable. A different view is a new delegation.
    if (req.body.account_id !== undefined || req.body.view_id !== undefined) {
      throw problem(400, 'paperless_folder_invalid');
    }
    db.get().transaction(() => {
      db.get().prepare(`UPDATE paperless_view_folders SET name = ?, visibility = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(values.name, values.visibility, before.id);
      replaceAccess(before.id, values.allowed_member_ids);
    })();
    res.json({ data: visibleFolder(req, before.id) });
  } catch (err) { fail(res, err); }
});

router.delete('/folders/:id', (req, res) => {
  try {
    admin(req);
    const folder = visibleFolder(req, req.params.id);
    if (folder.created_by !== actor(req)) throw problem(403, 'Permission denied.');
    db.get().prepare('DELETE FROM paperless_view_folders WHERE id = ?').run(folder.id);
    res.status(204).end();
  } catch (err) { fail(res, err); }
});

router.get('/folders/:id/documents', refuseWhileRestoring, async (req, res) => {
  try {
    const folder = visibleFolder(req, req.params.id);
    const page = positiveId(req.query.page ?? 1);
    if (!page || page > 100000) throw problem(400, 'paperless_folder_invalid');
    const source = liveAccount(folder.account_id, actor(req));
    const result = await remote(adapterFactory(source).listViewDocuments(folder.view_id, { page, pageSize: 50 }));
    unchangedFolder(req, folder, source);
    res.json({ data: result.results, meta: { page, count: result.count, has_more: result.has_more } });
  } catch (err) { fail(res, err); }
});

router.get('/folders/:id/documents/:documentId/:action', refuseWhileRestoring, async (req, res) => {
  try {
    const { documentId, action } = req.params;
    if (!positiveId(documentId) || !['preview', 'download', 'thumbnail'].includes(action)) {
      throw problem(404, 'paperless_document_not_found');
    }
    const folder = visibleFolder(req, req.params.id);
    const source = liveAccount(folder.account_id, actor(req));
    const adapter = adapterFactory(source);
    // Intersect the current view with the requested ID at Paperless. A
    // valid ID alone never authorizes media, even if an old page contained it.
    const result = await remote(adapter.listViewDocuments(folder.view_id, { documentId, pageSize: 1 }));
    const doc = result.results.find((row) => String(row.id) === documentId);
    if (!doc) throw problem(404, 'paperless_document_not_found');
    unchangedFolder(req, folder, source);
    const file = await remote(action === 'thumbnail'
      ? adapter.fetchThumbnail(documentId) : adapter.fetchContent(documentId));
    unchangedFolder(req, folder, source); // Sharing can be revoked while content loads.
    const mime = String(file.mime || '').split(';')[0].trim().toLowerCase();
    if (action === 'thumbnail' && !THUMB_MIME.has(mime)) throw problem(415, 'paperless_preview_unsupported');
    if (action === 'preview' && !PREVIEW_MIME.has(mime)) throw problem(415, 'paperless_preview_unsupported');
    res.set('X-Content-Type-Options', 'nosniff');
    res.attachment(doc.filename || `${documentId}.bin`);
    if (action !== 'download') {
      res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    res.type(mime || 'application/octet-stream').send(file.buffer);
  } catch (err) { fail(res, err); }
});

export default router;
