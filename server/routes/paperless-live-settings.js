/** Household Live-folder policy; users can manage only their own DMS token. */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { refuseWhileRestoring } from '../middleware/restore-gate.js';
import { mayWriteModule } from '../permissions.js';
import { getAdapter } from '../services/dms/index.js';
import { positiveId } from '../services/dms/paperless-views.js';
import { liveSettings, paperlessAccount } from '../services/paperless-live-settings.js';

const router = express.Router();
const log = createLogger('PaperlessSettings');
let adapterFactory = getAdapter;
export function _setAdapterFactory(fn) { adapterFactory = fn || getAdapter; }
const actor = (req) => req.authUserId || req.session?.userId;
const problem = (status, reason) => Object.assign(new Error(reason), { httpStatus: status, reason });
const admin = (req) => {
  if (!isAdminRequest(req) || !mayWriteModule(req, 'documents')) throw problem(403, 'Permission denied.');
};
function account(req) {
  const id = positiveId(req.params.id);
  if (!id) throw problem(404, 'paperless_account_not_found');
  return paperlessAccount(id);
}
function fail(res, err) {
  const status = err.httpStatus || 500;
  log.warn(`Paperless settings operation failed (status ${status}).`);
  if (status === 403) return res.status(403).json({ error: 'Permission denied.', code: 403 });
  const reason = status === 500 ? 'internal_error' : err.reason;
  return res.status(status).json({ error: reason, reason, code: status });
}
function hasToken(accountId, userId) {
  return Boolean(db.get().prepare('SELECT 1 FROM paperless_user_tokens WHERE account_id = ? AND user_id = ?')
    .get(accountId, userId));
}
function personalActor(req) {
  if (!positiveId(actor(req)) || req.authMethod === 'display') throw problem(403, 'Permission denied.');
  return actor(req);
}

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/live-settings', (req, res) => {
  try {
    const rows = db.get().prepare("SELECT id, name FROM dms_accounts WHERE provider = 'paperless' ORDER BY name COLLATE NOCASE").all();
    const canManage = isAdminRequest(req) && mayWriteModule(req, 'documents');
    res.json({ data: rows.map((row) => {
      const settings = liveSettings(row.id);
      return { ...row, token_mode: settings.token_mode, has_personal_token: hasToken(row.id, actor(req)),
        ...(canManage ? { allowed_tag_ids: settings.allowed_tag_ids, revision: settings.revision } : {}) };
    }), meta: { can_manage: canManage } });
  } catch (err) { fail(res, err); }
});

router.put('/live-settings/:id', (req, res) => {
  try {
    admin(req);
    const source = account(req);
    const { token_mode, allowed_tag_ids, expected_revision } = req.body || {};
    if (!['shared', 'personal'].includes(token_mode) || !Number.isSafeInteger(expected_revision)
      || (allowed_tag_ids !== null && (!Array.isArray(allowed_tag_ids) || allowed_tag_ids.length > 1000
        || allowed_tag_ids.some((id) => !Number.isSafeInteger(id) || id < 1)))) {
      throw problem(400, 'paperless_live_settings_invalid');
    }
    const tags = allowed_tag_ids === null ? null : [...new Set(allowed_tag_ids)].sort((a, b) => a - b);
    db.get().transaction(() => {
      if (liveSettings(source.id).revision !== expected_revision) throw problem(409, 'paperless_folder_changed');
      db.get().prepare(`INSERT INTO paperless_live_settings (account_id, token_mode, allowed_tag_ids, revision)
        VALUES (?, ?, ?, 1) ON CONFLICT(account_id) DO UPDATE SET token_mode = excluded.token_mode,
        allowed_tag_ids = excluded.allowed_tag_ids, revision = paperless_live_settings.revision + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
        .run(source.id, token_mode, tags === null ? null : JSON.stringify(tags));
    })();
    res.json({ data: liveSettings(source.id) });
  } catch (err) { fail(res, err); }
});

router.get('/live-settings/:id/tags', refuseWhileRestoring, async (req, res) => {
  try {
    admin(req);
    const source = account(req);
    const page = positiveId(req.query.page ?? 1);
    if (!page || page > 100000) throw problem(400, 'paperless_live_settings_invalid');
    let result;
    try { result = await adapterFactory(source).listTags({ page }); }
    catch (err) {
      if (Number.isInteger(err.status)) log.warn(`Paperless settings upstream request failed (status ${err.status}).`);
      throw problem(502, [401, 403].includes(err.status) ? 'paperless_tag_names_unavailable' : 'paperless_unavailable');
    }
    const current = account(req);
    if (current.api_token !== source.api_token || current.base_url !== source.base_url) throw problem(409, 'paperless_folder_changed');
    res.json({ data: result.results, meta: { page, count: result.count, has_more: result.has_more } });
  } catch (err) { fail(res, err); }
});

router.put('/live-settings/:id/token', (req, res) => {
  try {
    const userId = personalActor(req), source = account(req);
    const token = req.body?.api_token;
    if (typeof token !== 'string' || !token.trim() || token.length > 500 || /[\r\n\x00]/.test(token)) {
      throw problem(400, 'paperless_personal_token_invalid');
    }
    db.get().prepare(`INSERT INTO paperless_user_tokens (account_id, user_id, api_token) VALUES (?, ?, ?)
      ON CONFLICT(account_id, user_id) DO UPDATE SET api_token = excluded.api_token,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(source.id, userId, token.trim());
    res.json({ data: { has_personal_token: true } });
  } catch (err) { fail(res, err); }
});

router.delete('/live-settings/:id/token', (req, res) => {
  try {
    const userId = personalActor(req), source = account(req);
    db.get().prepare('DELETE FROM paperless_user_tokens WHERE account_id = ? AND user_id = ?').run(source.id, userId);
    res.status(204).end();
  } catch (err) { fail(res, err); }
});

export default router;
