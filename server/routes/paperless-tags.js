/** Live Paperless tags, scoped to a visible link or current saved-view member. */
import express from '../utils/http-router.ts';
import { validateRequest } from '../api/validate-request.ts';
import { PaperlessHttpError, paperlessStatus } from '../services/dms/paperless-errors.js';
import { paperlessErrorHandler } from '../middleware/paperless-errors.js';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest, requireAdmin } from '../middleware/require-admin.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import { mayWriteModule } from '../authorize/index.ts';
import { actorFromRequest, visibleWhere } from '../authorize/index.ts';
import { getAdapter } from '../services/dms/index.js';
import { liveAccount, liveIdentity, checkLiveTagChanges } from '../services/paperless-live-settings.js';
import { positiveId, listFolderDocuments } from '../services/dms/paperless-views.js';

const router = express.Router();
const log = createLogger('PaperlessTags');
/** @type {(account: object) => import('../services/dms/paperless.js').PaperlessAdapter} */
let adapterFactory = (account) => /** @type {import('../services/dms/paperless.js').PaperlessAdapter} */ (getAdapter(account));
/** @param {((account: import("../../types/paperless.d.ts").Account) => unknown) | null} fn */
export function _setAdapterFactory(fn) { adapterFactory = /** @type {typeof adapterFactory | null} */ (fn) || ((account) => /** @type {import('../services/dms/paperless.js').PaperlessAdapter} */ (getAdapter(account))); }
/** @param {import('../utils/http-router.ts').Request} req */
const actor = (req) => actorFromRequest(req).userId;
/** @param {number} status @param {string} reason */
const problem = (status, reason) => new PaperlessHttpError(status, { reason });
/** @param {import("../utils/http-router.ts").Request} req */
const writable = (req) => isAdminRequest(req) && mayWriteModule(req, 'documents');
/** @param {unknown} value @returns {number[]} */
function ids(value) {
  if (!Array.isArray(value) || value.length > 1000
    || value.some((id) => !Number.isSafeInteger(id) || id < 1)) throw problem(400, 'paperless_tags_invalid');
  return [...new Set(value)].sort((a, b) => a - b);
}
/** @param {number} id @returns {import("../../types/paperless.d.ts").Account} */
function account(id) {
  const row = db.get().prepare("SELECT * FROM dms_accounts WHERE id = ? AND provider = 'paperless'").get(id);
  if (!row) throw problem(404, 'paperless_account_not_found');
  return row;
}
/** @template T @param {Promise<T>} promise @returns {Promise<T>} */
async function remote(promise) {
  try { return await promise; }
  catch (err) {
    if (Number.isInteger(paperlessStatus(err))) log.warn(`Paperless tags upstream request failed (status ${paperlessStatus(err)}).`);
    if (paperlessStatus(err) === 403) throw problem(403, 'Permission denied.');
    if (paperlessStatus(err) === 404) throw problem(404, 'paperless_document_not_found');
    if (paperlessStatus(err) === 400) throw problem(400, 'paperless_tags_invalid');
    throw problem(502, 'paperless_unavailable');
  }
}


/** @param {import("../utils/http-router.ts").Request} req */
function resolve(req) {
  if (!positiveId(req.params.id)) throw problem(404, 'paperless_document_not_found');
  let row;
  let documentId = 0;
  let canEdit;
  let identity;
  if (req.params.documentId !== undefined) {
    documentId = positiveId(req.params.documentId) || 0;
    if (!documentId) throw problem(404, 'paperless_document_not_found');
    row = db.get().prepare(`SELECT f.* FROM paperless_view_folders f WHERE f.id = @id
      AND ${visibleWhere('paperless_folders', 'f', '@userId')}`).get({ id: req.params.id, userId: actor(req) });
    if (!row) throw problem(404, 'paperless_folder_not_found');
    canEdit = writable(req) && row.created_by === actor(req);
    identity = [row.account_id, row.view_id, row.tag_filter, row.created_by, row.visibility];
  } else {
    row = db.get().prepare(`SELECT d.* FROM family_documents d WHERE d.id = @id
      AND d.storage_backend = 'dms' AND ${visibleWhere('documents', 'd', '@userId')}`).get({ id: req.params.id, userId: actor(req) });
    if (!row || !positiveId(row.storage_key)) throw problem(404, 'paperless_document_not_found');
    documentId = positiveId(row.storage_key) || 0;
    canEdit = writable(req);
    identity = [row.dms_account_id, row.storage_key, row.created_by, row.visibility];
  }
  const source = row.view_id === undefined ? account(row.dms_account_id) : liveAccount(row.account_id, actor(req));
  // Include credentials in the internal identity, never in a response.
  identity.push(source.base_url, source.api_token, source.live_settings);
  return { row, source, documentId, canEdit, identity: JSON.stringify(identity) };
}
/** @param {import("../utils/http-router.ts").Request} req @param {ReturnType<typeof resolve>} before @param {boolean} write */
function recheck(req, before, write = false) {
  const now = resolve(req);
  if (now.identity !== before.identity) throw problem(409, 'paperless_folder_changed');
  if (write && !now.canEdit) throw problem(403, 'Permission denied.');
}
/** @param {import("../services/dms/paperless.js").PaperlessAdapter} adapter @param {ReturnType<typeof resolve>} context */
async function inView(adapter, context) {
  if (context.row.view_id === undefined) return;
  const result = await remote(listFolderDocuments(adapter, context.row, { documentId: context.documentId, pageSize: 1 }));
  if (!result.results.some((/** @type {{id: string | number}} */ doc) => String(doc.id) === String(context.documentId))) {
    throw problem(404, 'paperless_document_not_found');
  }
}

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// The global tag catalogue is account-wide, so only administrators may browse it.
router.get('/tags', requireAdmin, validateRequest(), refuseWhileRestoring, async (req, res) => {
  
    if (!writable(req)) throw problem(403, 'Permission denied.');
    const accountId = positiveId(req.query.account_id);
    const page = positiveId(req.query.page ?? 1);
    if (!accountId || !page || page > 100000) throw problem(400, 'paperless_tags_invalid');
    let context;
    if (req.query.folder_id !== undefined) {
      const folderId = positiveId(req.query.folder_id);
      const folder = folderId && db.get().prepare(`SELECT f.* FROM paperless_view_folders f WHERE f.id = @id AND ${visibleWhere('paperless_folders', 'f', '@userId')}`)
        .get({ id: folderId, userId: actor(req) });
      if (!folder || folder.account_id !== accountId || folder.created_by !== actor(req)) throw problem(404, 'paperless_folder_not_found');
      context = folder;
    }
    const source = context ? liveAccount(accountId, actor(req)) : account(accountId);
    const result = await remote(adapterFactory(source).listTags({ page }));
    const current = context ? liveAccount(accountId, actor(req)) : account(accountId);
    if (liveIdentity(current) !== liveIdentity(source)) throw problem(409, 'paperless_folder_changed');
    if (context) {
      const folder = db.get().prepare('SELECT * FROM paperless_view_folders WHERE id = ?').get(context.id);
      if (!folder || folder.created_by !== actor(req) || folder.account_id !== accountId) throw problem(404, 'paperless_folder_not_found');
    }
    const allowed = source.live_settings?.allowed_tag_ids ?? null;
    const results = allowed === null ? result.results : result.results.filter((tag) => allowed.includes(tag.id));
    res.json({ data: results, meta: { page, has_more: result.has_more, count: result.count } });
  
});

/** @param {import("../utils/http-router.ts").Request} req @param {import("../utils/http-router.ts").Response} res */
async function readTags(req, res) {
    
      const context = resolve(req);
      const adapter = adapterFactory(context.source);
      await inView(adapter, context);
      const document = await remote(adapter.getDocument(context.documentId));
      const tagIds = ids(document.tags);
      // Only names of tags actually assigned to the delegated document are shared.
      let named = [];
      try { named = await remote(adapter.getTags(tagIds)); }
      catch (err) {
        if (!(err instanceof PaperlessHttpError) || ![403, 404].includes(err.httpStatus)) throw err;
      }
      const names = new Map(named.map((tag) => [tag.id, tag.name]));
      const tags = tagIds.map((id) => ({ id, name: names.get(id) ?? `#${id}` }));
      recheck(req, context);
      res.json({ data: { tags, tag_ids: tagIds, unresolved_tag_ids: tagIds.filter((id) => !names.has(id)), can_edit: context.canEdit,
        ...(context.canEdit ? { account_id: context.source.id,
          ...(context.row.view_id !== undefined ? { catalogue_folder_id: context.row.id,
            editable_tag_ids: context.source.live_settings?.allowed_tag_ids ?? null } : {}) } : {}) } });
    
}
/** @param {import("../utils/http-router.ts").Request} req @param {import("../utils/http-router.ts").Response} res */
async function writeTags(req, res) {
    
      const context = resolve(req);
      if (!context.canEdit) throw problem(403, 'Permission denied.');
      const wanted = ids(req.body?.tags);
      const expected = ids(req.body?.expected_tags);
      const adapter = adapterFactory(context.source);
      await inView(adapter, context);
      const document = await remote(adapter.getDocument(context.documentId));
      if (JSON.stringify(ids(document.tags)) !== JSON.stringify(expected)) throw problem(409, 'paperless_tags_changed');
      if (context.row.view_id !== undefined) {
        checkLiveTagChanges(ids(document.tags), wanted, context.source.live_settings?.allowed_tag_ids ?? null);
      }
      await inView(adapter, context);
      recheck(req, context, true);
      const updated = await remote(adapter.setDocumentTags(context.documentId, wanted));
      recheck(req, context, true);
      // A successful tag change may intentionally remove the document from its view.
      res.json({ data: { tag_ids: ids(updated.tags) } });
    
}
router.get('/folders/:id/documents/:documentId/tags', validateRequest(), refuseWhileRestoring, readTags);
router.put('/folders/:id/documents/:documentId/tags', validateRequest(), refuseWhileRestoring, writeTags);
router.get('/documents/:id/tags', validateRequest(), refuseWhileRestoring, readTags);
router.put('/documents/:id/tags', validateRequest(), refuseWhileRestoring, writeTags);
router.use(paperlessErrorHandler);
export default router;
