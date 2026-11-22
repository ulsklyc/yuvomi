/** Household Live-folder policy; users can manage only their own DMS token. */
import express from '../utils/http-router.ts';
import { validateRequest } from '../api/validate-request.ts';
import { PaperlessHttpError, paperlessStatus } from '../services/dms/paperless-errors.js';
import { paperlessErrorHandler } from '../middleware/paperless-errors.js';
import { actorFromRequest } from '../authorize/index.ts';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest, requireAdmin } from '../middleware/require-admin.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import { mayWriteModule } from '../authorize/index.ts';
import { getAdapter } from '../services/dms/index.js';
import { positiveId } from '../services/dms/paperless-views.js';
import { liveSettings, paperlessAccount, LIVE_DISPLAY_FIELDS } from '../services/paperless-live-settings.js';

const router = express.Router();
const log = createLogger('PaperlessSettings');
/** @type {(account: object) => import('../services/dms/paperless.js').PaperlessAdapter} */
let adapterFactory = (account) => /** @type {import('../services/dms/paperless.js').PaperlessAdapter} */ (getAdapter(account));
/** @param {((account: import("../../types/paperless.d.ts").Account) => unknown) | null} fn */
export function _setAdapterFactory(fn) { adapterFactory = /** @type {typeof adapterFactory | null} */ (fn) || ((account) => /** @type {import('../services/dms/paperless.js').PaperlessAdapter} */ (getAdapter(account))); }
/** @param {import('../utils/http-router.ts').Request} req */
const actor = (req) => actorFromRequest(req).userId;
/** @param {number} status @param {string} reason */
const problem = (status, reason) => new PaperlessHttpError(status, { reason });

/** @param {import("../utils/http-router.ts").Request} req */
function account(req) {
  const id = positiveId(req.params.id);
  if (!id) throw problem(404, 'paperless_account_not_found');
  return paperlessAccount(id);
}

/** @param {number} accountId @param {number | null} userId */
function hasToken(accountId, userId) {
  return Boolean(db.get().prepare('SELECT 1 FROM paperless_user_tokens WHERE account_id = ? AND user_id = ?')
    .get(accountId, userId));
}
/** @param {import("../utils/http-router.ts").Request} req */
function personalActor(req) {
  const principal = actorFromRequest(req);
  if (!positiveId(principal.userId) || principal.unresolved || ['display', 'guest'].includes(principal.kind)) throw problem(403, 'Permission denied.');
  return actor(req);
}

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/live-settings', validateRequest(), (req, res) => {

    const rows = db.get().prepare("SELECT id, name FROM dms_accounts WHERE provider = 'paperless' ORDER BY name COLLATE NOCASE").all();
    const canManage = isAdminRequest(req) && mayWriteModule(req, 'documents');
    res.json({ data: rows.map((/** @type {{id: number, name: string}} */ row) => {
      const settings = liveSettings(row.id);
      return { ...row, token_mode: settings.token_mode, display_fields: settings.display_fields, has_personal_token: hasToken(row.id, actor(req)),
        ...(canManage ? { allowed_tag_ids: settings.allowed_tag_ids, revision: settings.revision } : {}) };
    }), meta: { can_manage: canManage } });

});

router.put('/live-settings/:id', requireAdmin, validateRequest(), (req, res) => {

    if (!mayWriteModule(req, 'documents')) throw problem(403, 'Permission denied.');
    const source = account(req);
    const { token_mode, allowed_tag_ids, expected_revision } = req.body || {};
    const displayFields = req.body?.display_fields === undefined ? liveSettings(source.id).display_fields : req.body.display_fields;
    if (!['shared', 'personal'].includes(token_mode) || !Number.isSafeInteger(expected_revision)
      || !Array.isArray(displayFields) || displayFields.length > LIVE_DISPLAY_FIELDS.length
      || displayFields.some((field) => !LIVE_DISPLAY_FIELDS.includes(field))
      || (allowed_tag_ids !== null && (!Array.isArray(allowed_tag_ids) || allowed_tag_ids.length > 1000
        || allowed_tag_ids.some((id) => !Number.isSafeInteger(id) || id < 1)))) {
      throw problem(400, 'paperless_live_settings_invalid');
    }
    const tags = allowed_tag_ids === null ? null : [...new Set(allowed_tag_ids)].sort((a, b) => a - b);
    db.get().transaction(() => {
      if (liveSettings(source.id).revision !== expected_revision) throw problem(409, 'paperless_folder_changed');
      db.get().prepare(`INSERT INTO paperless_live_settings (account_id, token_mode, allowed_tag_ids, display_fields, revision)
        VALUES (?, ?, ?, ?, 1) ON CONFLICT(account_id) DO UPDATE SET token_mode = excluded.token_mode,
        allowed_tag_ids = excluded.allowed_tag_ids, display_fields = excluded.display_fields, revision = paperless_live_settings.revision + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
        .run(source.id, token_mode, tags === null ? null : JSON.stringify(tags), JSON.stringify([...new Set(displayFields)]));
    })();
    res.json({ data: liveSettings(source.id) });

});

router.get('/live-settings/:id/tags', requireAdmin, validateRequest(), refuseWhileRestoring, async (req, res) => {

    if (!mayWriteModule(req, 'documents')) throw problem(403, 'Permission denied.');
    const source = account(req);
    const page = positiveId(req.query.page ?? 1);
    if (!page || page > 100000) throw problem(400, 'paperless_live_settings_invalid');
    let result;
    try { result = await adapterFactory(source).listTags({ page }); }
    catch (err) {
      if (Number.isInteger(paperlessStatus(err))) log.warn(`Paperless settings upstream request failed (status ${paperlessStatus(err)}).`);
      throw problem(502, [401, 403].includes(paperlessStatus(err) || 0) ? 'paperless_tag_names_unavailable' : 'paperless_unavailable');
    }
    const current = account(req);
    if (current.api_token !== source.api_token || current.base_url !== source.base_url) throw problem(409, 'paperless_folder_changed');
    res.json({ data: result.results, meta: { page, count: result.count, has_more: result.has_more } });

});

router.put('/live-settings/:id/token', validateRequest(), (req, res) => {

    const userId = personalActor(req), source = account(req);
    const token = req.body?.api_token;
    if (typeof token !== 'string' || !token.trim() || token.length > 500 || [...token].some((char) => [0, 10, 13].includes(char.charCodeAt(0)))) {
      throw problem(400, 'paperless_personal_token_invalid');
    }
    db.get().prepare(`INSERT INTO paperless_user_tokens (account_id, user_id, api_token) VALUES (?, ?, ?)
      ON CONFLICT(account_id, user_id) DO UPDATE SET api_token = excluded.api_token,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(source.id, userId, token.trim());
    res.json({ data: { has_personal_token: true } });

});

router.delete('/live-settings/:id/token', validateRequest(), (req, res) => {

    const userId = personalActor(req), source = account(req);
    db.get().prepare('DELETE FROM paperless_user_tokens WHERE account_id = ? AND user_id = ?').run(source.id, userId);
    res.status(204).end();

});

router.use(paperlessErrorHandler);
export default router;
