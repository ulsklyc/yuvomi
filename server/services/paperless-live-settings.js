/** Live-folder policy and write-only personal credentials. */
import * as db from '../db.js';
import { PaperlessHttpError } from './dms/paperless-errors.js';

/** @param {number} status @param {string} reason */
const problem = (status, reason) => new PaperlessHttpError(status, { reason });

export const LIVE_DISPLAY_FIELDS = ['created', 'added', 'modified', 'correspondent', 'document_type', 'tags', 'archive_serial_number', 'filename'];

/** @param {number} accountId @returns {import("../../types/paperless.d.ts").LiveSettings} */
export function liveSettings(accountId) {
  const row = db.get().prepare('SELECT * FROM paperless_live_settings WHERE account_id = ?').get(accountId);
  return { token_mode: row?.token_mode ?? 'shared',
    allowed_tag_ids: row?.allowed_tag_ids == null ? null : JSON.parse(row.allowed_tag_ids),
    display_fields: row?.display_fields == null ? [] : JSON.parse(row.display_fields),
    revision: row?.revision ?? 0 };
}

/** @param {number} accountId @returns {import("../../types/paperless.d.ts").Account} */
export function paperlessAccount(accountId) {
  const row = db.get().prepare("SELECT * FROM dms_accounts WHERE id = ? AND provider = 'paperless'").get(accountId);
  if (!row) throw problem(404, 'paperless_account_not_found');
  return row;
}

/** @param {number} accountId @param {number | null} userId @returns {import("../../types/paperless.d.ts").LiveAccount} */
export function liveAccount(accountId, userId) {
  const account = paperlessAccount(accountId);
  const settings = liveSettings(accountId);
  if (settings.token_mode === 'personal') {
    const personal = db.get().prepare('SELECT api_token FROM paperless_user_tokens WHERE account_id = ? AND user_id = ?')
      .get(accountId, userId);
    if (!personal) throw new PaperlessHttpError(403, { reason: 'paperless_personal_token_required' });
    account.api_token = personal.api_token;
  }
  return { ...account, live_settings: settings };
}

/** @param {import("../../types/paperless.d.ts").Account} account */
export function liveIdentity(account) {
  return JSON.stringify([account.id, account.base_url, account.api_token, account.live_settings]);
}

/** @param {import("../../types/paperless.d.ts").Account} before @param {number | null} userId */
export function recheckLiveAccount(before, userId) {
  if (liveIdentity(liveAccount(before.id, userId)) !== liveIdentity(before)) {
    throw problem(409, 'paperless_folder_changed');
  }
}

/** Existing assignments outside the allowlist must survive an edit intact. */
/** @param {number[]} before @param {number[]} after @param {number[] | null} allowed */
export function checkLiveTagChanges(before, after, allowed) {
  if (allowed === null) return;
  const permitted = new Set(allowed), old = new Set(before), wanted = new Set(after);
  if ([...old, ...wanted].some((id) => old.has(id) !== wanted.has(id) && !permitted.has(id))) {
    throw problem(400, 'paperless_tags_restricted');
  }
}
