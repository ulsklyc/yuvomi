/** Live Paperless tags, scoped to a visible link or current saved-view member. */
import express from 'express';
import * as db from '../db.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import { mayWriteModule } from '../permissions.js';
import { documentVisibleSql } from '../services/document-access.js';
import { getAdapter } from '../services/dms/index.js';
import { positiveId } from '../services/dms/paperless-views.js';

const router = express.Router();
let adapterFactory = getAdapter;
export function _setAdapterFactory(fn) { adapterFactory = fn || getAdapter; }
const actor = (req) => req.authUserId || req.session?.userId;
const problem = (status, reason) => Object.assign(new Error(reason), { httpStatus: status, reason });
const writable = (req) => isAdminRequest(req) && mayWriteModule(req, 'documents');
function ids(value) {
  if (!Array.isArray(value) || value.length > 1000
    || value.some((id) => !Number.isSafeInteger(id) || id < 1)) throw problem(400, 'paperless_tags_invalid');
  return [...new Set(value)].sort((a, b) => a - b);
}
function account(id) {
  const row = db.get().prepare("SELECT * FROM dms_accounts WHERE id = ? AND provider = 'paperless'").get(id);
  if (!row) throw problem(404, 'paperless_account_not_found');
  return row;
}
async function remote(promise) {
  try { return await promise; }
  catch (err) {
    if (err.status === 403) throw problem(403, 'Permission denied.');
    if (err.status === 404) throw problem(404, 'paperless_document_not_found');
    if (err.status === 400) throw problem(400, 'paperless_tags_invalid');
    throw problem(502, 'paperless_unavailable');
  }
}
function fail(res, err) {
  if (err.httpStatus === 403) return res.status(403).json({ error: 'Permission denied.', code: 403 });
  const status = err.httpStatus || 500;
  const reason = status === 500 ? 'internal_error' : err.reason;
  res.status(status).json({ error: reason, reason, code: status });
}

function resolve(req) {
  if (!positiveId(req.params.id)) throw problem(404, 'paperless_document_not_found');
  let row;
  let documentId;
  let canEdit;
  let identity;
  if (req.params.documentId !== undefined) {
    documentId = positiveId(req.params.documentId);
    if (!documentId) throw problem(404, 'paperless_document_not_found');
    row = db.get().prepare(`SELECT * FROM paperless_view_folders WHERE id = ?
      AND (visibility = 'family' OR created_by = ?)`).get(req.params.id, actor(req));
    if (!row) throw problem(404, 'paperless_folder_not_found');
    canEdit = writable(req) && row.created_by === actor(req);
    identity = [row.account_id, row.view_id, row.created_by, row.visibility];
  } else {
    row = db.get().prepare(`SELECT d.* FROM family_documents d WHERE d.id = @id
      AND d.storage_backend = 'dms' AND ${documentVisibleSql('d')}`).get({ id: req.params.id, userId: actor(req) });
    if (!row || !positiveId(row.storage_key)) throw problem(404, 'paperless_document_not_found');
    documentId = positiveId(row.storage_key);
    canEdit = writable(req);
    identity = [row.dms_account_id, row.storage_key, row.created_by, row.visibility];
  }
  const source = account(row.account_id ?? row.dms_account_id);
  // Include credentials in the internal identity, never in a response.
  identity.push(source.base_url, source.api_token);
  return { row, source, documentId, canEdit, identity: JSON.stringify(identity) };
}
function recheck(req, before, write = false) {
  const now = resolve(req);
  if (now.identity !== before.identity) throw problem(409, 'paperless_folder_changed');
  if (write && !now.canEdit) throw problem(403, 'Permission denied.');
}
async function inView(adapter, context) {
  if (context.row.view_id === undefined) return;
  const result = await remote(adapter.listViewDocuments(context.row.view_id, { documentId: context.documentId, pageSize: 1 }));
  if (!result.results.some((doc) => String(doc.id) === String(context.documentId))) {
    throw problem(404, 'paperless_document_not_found');
  }
}

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// The global tag catalogue is account-wide, so only administrators may browse it.
router.get('/tags', refuseWhileRestoring, async (req, res) => {
  try {
    if (!writable(req)) throw problem(403, 'Permission denied.');
    const accountId = positiveId(req.query.account_id);
    const page = positiveId(req.query.page ?? 1);
    if (!accountId || !page || page > 100000) throw problem(400, 'paperless_tags_invalid');
    const source = account(accountId);
    const result = await remote(adapterFactory(source).listTags({ page }));
    const current = account(accountId);
    if (current.api_token !== source.api_token || current.base_url !== source.base_url) throw problem(409, 'paperless_folder_changed');
    res.json({ data: result.results, meta: { page, has_more: result.has_more, count: result.count } });
  } catch (err) { fail(res, err); }
});

async function readTags(req, res) {
    try {
      const context = resolve(req);
      const adapter = adapterFactory(context.source);
      await inView(adapter, context);
      const document = await remote(adapter.getDocument(context.documentId));
      const tagIds = ids(document.tags);
      // Only names of tags actually assigned to the delegated document are shared.
      const tags = [];
      for (const id of tagIds) {
        try { tags.push(await remote(adapter.getTag(id))); }
        catch (err) {
          // Object permissions may hide a tag while leaving its ID on the document.
          if (![403, 404].includes(err.httpStatus)) throw err;
          tags.push({ id, name: `#${id}` });
        }
      }
      await inView(adapter, context);
      recheck(req, context);
      res.json({ data: { tags, tag_ids: tagIds, can_edit: context.canEdit,
        ...(context.canEdit ? { account_id: context.source.id } : {}) } });
    } catch (err) { fail(res, err); }
}
async function writeTags(req, res) {
    try {
      const context = resolve(req);
      if (!context.canEdit) throw problem(403, 'Permission denied.');
      const wanted = ids(req.body?.tags);
      const expected = ids(req.body?.expected_tags);
      const adapter = adapterFactory(context.source);
      await inView(adapter, context);
      const document = await remote(adapter.getDocument(context.documentId));
      if (JSON.stringify(ids(document.tags)) !== JSON.stringify(expected)) throw problem(409, 'paperless_tags_changed');
      await inView(adapter, context);
      recheck(req, context, true);
      const updated = await remote(adapter.setDocumentTags(context.documentId, wanted));
      recheck(req, context, true);
      // A successful tag change may intentionally remove the document from its view.
      res.json({ data: { tag_ids: ids(updated.tags) } });
    } catch (err) { fail(res, err); }
}
router.get('/folders/:id/documents/:documentId/tags', refuseWhileRestoring, readTags);
router.put('/folders/:id/documents/:documentId/tags', refuseWhileRestoring, writeTags);
router.get('/documents/:id/tags', refuseWhileRestoring, readTags);
router.put('/documents/:id/tags', refuseWhileRestoring, writeTags);
export default router;
