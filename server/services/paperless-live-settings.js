/** Live-folder policy and write-only personal credentials. */
import * as db from '../db.js';

const problem = (status, reason) => Object.assign(new Error(reason), { httpStatus: status, reason });

export function liveSettings(accountId) {
  const row = db.get().prepare('SELECT * FROM paperless_live_settings WHERE account_id = ?').get(accountId);
  return { token_mode: row?.token_mode ?? 'shared',
    allowed_tag_ids: row?.allowed_tag_ids == null ? null : JSON.parse(row.allowed_tag_ids),
    revision: row?.revision ?? 0 };
}

export function paperlessAccount(accountId) {
  const row = db.get().prepare("SELECT * FROM dms_accounts WHERE id = ? AND provider = 'paperless'").get(accountId);
  if (!row) throw problem(404, 'paperless_account_not_found');
  return row;
}

export function liveAccount(accountId, userId) {
  const account = paperlessAccount(accountId);
  const settings = liveSettings(accountId);
  if (settings.token_mode === 'personal') {
    const personal = db.get().prepare('SELECT api_token FROM paperless_user_tokens WHERE account_id = ? AND user_id = ?')
      .get(accountId, userId);
    if (!personal) throw Object.assign(new Error('Personal token required.'), { httpStatus: 403, reason: 'paperless_personal_token_required' });
    account.api_token = personal.api_token;
  }
  return { ...account, live_settings: settings };
}

export function liveIdentity(account) {
  return JSON.stringify([account.id, account.base_url, account.api_token, account.live_settings]);
}

export function recheckLiveAccount(before, userId) {
  if (liveIdentity(liveAccount(before.id, userId)) !== liveIdentity(before)) {
    throw problem(409, 'paperless_folder_changed');
  }
}

/** Existing assignments outside the allowlist must survive an edit intact. */
export function checkLiveTagChanges(before, after, allowed) {
  if (allowed === null) return;
  const permitted = new Set(allowed), old = new Set(before), wanted = new Set(after);
  if ([...old, ...wanted].some((id) => old.has(id) !== wanted.has(id) && !permitted.has(id))) {
    throw problem(400, 'paperless_tags_restricted');
  }
}
