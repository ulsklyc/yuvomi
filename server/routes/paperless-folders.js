/** Virtual folders with scoped media and tags. No local file copies. */
import express from '../utils/http-router.ts';
import { validateRequest } from '../api/validate-request.ts';
import { createLogger } from '../logger.js';
import { PaperlessHttpError, paperlessStatus } from '../services/dms/paperless-errors.js';
import { assertGatesNow } from '../middleware/gate-now.js';
import { paperlessErrorHandler } from '../middleware/paperless-errors.js';
import liveSettingsRouter from './paperless-live-settings.js';
import { liveAccount, recheckLiveAccount } from '../services/paperless-live-settings.js';
import paperlessTagsRouter from './paperless-tags.js';
import * as db from '../db.js';
import { withTx } from '../db/tx.ts';
import { householdMemberSql, nonMemberMessage } from '../services/household-members.js';
import { HttpError } from '../utils/http-error.js';
import { sqlInList } from '../utils/sql-in-list.ts';
import { isAdminRequest, requireAdmin } from '../middleware/require-admin.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import { actorFromRequest, visibleWhere, paperlessFolderAudienceWidens, paperlessFolderMembers } from '../authorize/index.ts';
import { getAdapter } from '../services/dms/index.js';
import { PaperlessViewError, normalizeTagFilter, tagFilter, listFolderDocuments } from '../services/dms/paperless-views.js';

const router = express.Router();
router.use(liveSettingsRouter);
router.use(paperlessTagsRouter);
const log = createLogger('PaperlessFolders');
const COLUMNS = 'id, name, account_id, view_id, tag_filter, visibility, created_by, created_at, updated_at';
const PREVIEW_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain']);
const THUMB_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** @type {(account: object) => import('../services/dms/paperless.js').PaperlessAdapter} */
let adapterFactory = (account) => /** @type {import('../services/dms/paperless.js').PaperlessAdapter} */ (getAdapter(account));
/** @param {((account: import("../../types/paperless.d.ts").Account) => unknown) | null} fn */
export function _setAdapterFactory(fn) { adapterFactory = /** @type {typeof adapterFactory | null} */ (fn) || ((account) => /** @type {import('../services/dms/paperless.js').PaperlessAdapter} */ (getAdapter(account))); }
/** @param {import('../utils/http-router.ts').Request} req */
const actor = (req) => actorFromRequest(req).userId;

/** @param {number} status @param {string} reason */
const problem = (status, reason) => new PaperlessHttpError(status, { reason });

/** @template T @param {Promise<T>} promise @returns {Promise<T>} */
async function remote(promise) {
  try { return await promise; }
  catch (err) {
    if (Number.isInteger(paperlessStatus(err))) log.warn(`Paperless folders upstream request failed (status ${paperlessStatus(err)}).`);
    if (err instanceof PaperlessViewError) throw err;
    if (paperlessStatus(err) === 403 || paperlessStatus(err) === 401) throw new PaperlessHttpError(403, { reason: 'paperless_dms_forbidden' });
    throw problem(502, 'paperless_unavailable');
  }
}

/** @param {import('../utils/http-router.ts').Request} req @param {unknown} id */
function visibleFolder(req, id) {
  const row = db.get().prepare(`SELECT ${COLUMNS} FROM paperless_view_folders f
    WHERE id = @id AND ${visibleWhere('paperless_folders', 'f', '@userId')}`).get({ id, userId: actor(req) });
  if (!row) throw problem(404, 'paperless_folder_not_found');
  return withAccess(row);
}

/** @param {import("../../types/paperless.d.ts").Folder} row */
function withAccess(row) {
  return { ...row, tag_filter: row.tag_filter == null ? null : tagFilter(typeof row.tag_filter === 'string' ? JSON.parse(row.tag_filter) : row.tag_filter), allowed_member_ids: db.get().prepare(
    'SELECT user_id FROM paperless_view_folder_access WHERE folder_id = ? ORDER BY user_id'
  ).all(row.id).map((/** @type {{user_id: number}} */ entry) => entry.user_id) };
}

/** @param {number | bigint} id @param {number[]} memberIds */
function replaceAccess(id, memberIds) {
  const database = db.get();
  database.prepare('DELETE FROM paperless_view_folder_access WHERE folder_id = ?').run(id);
  const insert = database.prepare('INSERT INTO paperless_view_folder_access (folder_id, user_id) VALUES (?, ?)');
  for (const memberId of memberIds) insert.run(id, memberId);
}

/** @param {import("../utils/http-router.ts").Request} req @param {import("../../types/paperless.d.ts").Folder} before @param {import("../../types/paperless.d.ts").Account} source */
function unchangedFolder(req, before, source) {
  if (source) recheckLiveAccount(db.get(), source, actor(req));
  const now = visibleFolder(req, before.id);
  if (now.account_id !== before.account_id || now.view_id !== before.view_id
    || JSON.stringify(now.tag_filter) !== JSON.stringify(before.tag_filter)
    || now.visibility !== before.visibility || now.created_by !== before.created_by
    || JSON.stringify(now.allowed_member_ids) !== JSON.stringify(before.allowed_member_ids)) {
    throw problem(409, 'paperless_folder_changed');
  }
  return now;
}

/** @param {{name: string, visibility?: string, allowed_member_ids?: number[]}} body */
function fields({ name, visibility = 'private', allowed_member_ids = [] }) {
  const memberIds = paperlessFolderMembers(visibility, allowed_member_ids);
  if (memberIds === null) throw problem(400, 'paperless_folder_invalid');
  return { name: name.trim(), visibility, allowed_member_ids: memberIds };
}

/** @param {number[]} ids */
function requireHouseholdMembers(ids) {
  if (ids.length === 0) return;
  const list = sqlInList(ids);
  const members = db.get().prepare(`SELECT u.id FROM users u
    WHERE u.id IN (${list.sql}) AND ${householdMemberSql('u')}`).all(list.param);
  const memberIds = new Set(members.map((/** @type {{id: number}} */ member) => member.id));
  const rejected = ids.filter((id) => !memberIds.has(id));
  if (rejected.length) throw new HttpError(400, nonMemberMessage(rejected));
}

/** @param {import("../../types/paperless.d.ts").FolderAudience & {confirm_share?: unknown}} body @param {import("../../types/paperless.d.ts").FolderAudience} before */
function shareConsent(body, before) {
  const wider = paperlessFolderAudienceWidens(body, before);
  if (wider && body.confirm_share !== true) throw problem(400, 'paperless_share_confirmation');
}

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Hold the DB identity across remote awaits: a concurrent restore must wait
// for these responses, just as it waits for the core document media routes.
router.get('/saved-views', requireAdmin, validateRequest(), refuseWhileRestoring, async (req, res) => {

    const accountId = Number(req.query.account_id);
    const page = Number(req.query.page ?? 1);
    const source = liveAccount(db.get(), accountId, actor(req));
    const result = await remote(adapterFactory(source).listSavedViews({ page, pageSize: 50 }));
    recheckLiveAccount(db.get(), source, actor(req));
    res.json({ data: result.results.map((/** @type {Record<string, any>} */ view) => ({ id: view.id, name: view.name })),
      meta: { page, count: result.count, has_more: result.has_more } });

});

// Filter creation always uses the same credentials as Live-folder reads.
router.get('/filter-tags', requireAdmin, validateRequest(), refuseWhileRestoring, async (req, res) => {
  const accountId = Number(req.query.account_id), page = Number(req.query.page ?? 1);
  const source = liveAccount(db.get(), accountId, actor(req));
  const result = await remote(adapterFactory(source).listTags({ page }));
  recheckLiveAccount(db.get(), source, actor(req));
  res.json({ data: result.results, meta: { page, count: result.count, has_more: result.has_more } });
});

router.get('/folders', validateRequest(), (req, res) => {

    const rows = db.get().prepare(`SELECT ${COLUMNS} FROM paperless_view_folders f
      WHERE ${visibleWhere('paperless_folders', 'f', '@userId')} ORDER BY name COLLATE NOCASE, id`).all({ userId: actor(req) });
    res.json({ data: rows.map((/** @type {import("../../types/paperless.d.ts").Folder} */ row) => ({ ...withAccess(row), can_manage: isAdminRequest(req) && row.created_by === actor(req) })) });

});

router.post('/folders', requireAdmin, validateRequest(), refuseWhileRestoring, async (req, res) => {

    const body = req.body;
    const values = fields(body);
    requireHouseholdMembers(values.allowed_member_ids);
    shareConsent({ ...body, ...values }, { visibility: 'private', created_by: actor(req), allowed_member_ids: [] });
    const { account_id: accountId, view_id: viewId = null } = body;
    const filter = body.tag_filter === undefined ? null : normalizeTagFilter(body.tag_filter);
    const source = liveAccount(db.get(), accountId, actor(req));
    if (filter) {
      // Verify every selected tag with the creator's configured Live-folder token.
      const tags = await remote(adapterFactory(source).getTags(filter.tag_ids));
      if (filter.tag_ids.some((id) => !tags.some((tag) => tag.id === id))) throw problem(400, 'paperless_folder_invalid');
    } else await remote(adapterFactory(source).getSavedView(viewId));
    recheckLiveAccount(db.get(), source, actor(req));
    const database = db.get();
    const result = withTx(database, () => {
      assertGatesNow(database, req, { admin: true });
      requireHouseholdMembers(values.allowed_member_ids);
      const result = database.prepare(`INSERT INTO paperless_view_folders
      (name, account_id, view_id, tag_filter, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(values.name, accountId, viewId, filter ? JSON.stringify(filter) : null, values.visibility, actor(req));
      replaceAccess(result.lastInsertRowid, values.allowed_member_ids);
      return result;
    });
    res.status(201).json({ data: visibleFolder(req, result.lastInsertRowid) });

});

router.put('/folders/:id', requireAdmin, validateRequest(), (req, res) => {

    const before = visibleFolder(req, req.params.id);
    if (before.created_by !== actor(req)) throw problem(403, 'Permission denied.');
    const values = fields(req.body);
    requireHouseholdMembers(values.allowed_member_ids);
    shareConsent({ ...req.body, ...values }, before);
    const database = db.get();
    withTx(database, () => {
      database.prepare(`UPDATE paperless_view_folders SET name = ?, visibility = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(values.name, values.visibility, before.id);
      replaceAccess(before.id, values.allowed_member_ids);
    });
    res.json({ data: visibleFolder(req, before.id) });

});

router.delete('/folders/:id', requireAdmin, validateRequest(), (req, res) => {

    const folder = visibleFolder(req, req.params.id);
    if (folder.created_by !== actor(req)) throw problem(403, 'Permission denied.');
    db.get().prepare('DELETE FROM paperless_view_folders WHERE id = ?').run(folder.id);
    res.status(204).end();

});

router.get('/folders/:id/documents', validateRequest(), refuseWhileRestoring, async (req, res) => {

    const folder = visibleFolder(req, req.params.id);
    const page = Number(req.query.page ?? 1);
    const source = liveAccount(db.get(), folder.account_id, actor(req));
    const displayFields = source.live_settings.display_fields;
    const result = await remote(listFolderDocuments(adapterFactory(source), folder, { page, pageSize: 50, displayFields }));
    unchangedFolder(req, folder, source);
    res.json({ data: result.results, meta: { page, count: result.count, has_more: result.has_more, display_fields: displayFields } });

});

router.get('/folders/:id/documents/:documentId/:action', validateRequest(), refuseWhileRestoring, async (req, res) => {

    const { action } = req.params;
    const id = Number(req.params.documentId);
    if (id < 1) throw problem(404, 'paperless_document_not_found');
    const documentId = String(id);
    const folder = visibleFolder(req, req.params.id);
    const source = liveAccount(db.get(), folder.account_id, actor(req));
    const adapter = adapterFactory(source);
    // Intersect the current view with the requested ID at Paperless. A
    // valid ID alone never authorizes media, even if an old page contained it.
    const result = await remote(listFolderDocuments(adapter, folder, { documentId, pageSize: 1 }));
    const doc = result.results.find((/** @type {import("../../types/paperless.d.ts").Document} */ row) => String(row.id) === documentId);
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
      res.set('Content-Disposition', (res.get('Content-Disposition') || 'attachment').replace(/^attachment/, 'inline'));
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    res.type(mime || 'application/octet-stream').send(file.buffer);

});

router.use(paperlessErrorHandler);
export default router;
