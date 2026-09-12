/**
 * Module: Waste collection routes - shared helpers
 * Purpose: dispatch the three typed waste-store errors onto the same JSON
 *          error envelope every route in this app uses, and read the current
 *          user id the same way every other route does.
 */

import { WasteValidationError, WasteConflictError, WasteNotFoundError } from '../../services/waste-store.js';
import { tokenAllows } from '../../scopes.js';
import { moduleAccessVerdict, MODULE_ACCESS_ALLOW } from '../../permissions.js';

/**
 * Maps a caught error onto a response if it's one of the typed Waste errors.
 * @returns {boolean} true if a response was sent (caller must not fall through to 500)
 */
export function wasteErrorResponse(res, err) {
  if (err instanceof WasteValidationError) {
    res.status(400).json({ error: err.errors.join(' '), code: 400 });
    return true;
  }
  if (err instanceof WasteConflictError) {
    res.status(409).json({ error: err.message, code: 409 });
    return true;
  }
  if (err instanceof WasteNotFoundError) {
    res.status(404).json({ error: err.message, code: 404 });
    return true;
  }
  return false;
}

export function currentUserId(req) {
  return req.authUserId || req.session.userId;
}

/**
 * Does the calling identity have WRITE access to the waste module - not just
 * the read access this GET route itself already required to be reached? A
 * source's subscription URL is a credential (Phase 7): every list/detail
 * response must redact it for a read-only caller, mirroring the mount-point
 * middleware's own read/write primitives rather than reimplementing them.
 *
 * The mount point (server/index.js) applies BOTH gates to an API token, in
 * order: the token's own scope, then the calling member's actual module
 * rights via sessionModuleAccess (a token is always issued for a member, and
 * inherits that member's rights on top of whatever the token itself scopes
 * down to - a token cannot grant MORE than its owner has). Checking only
 * scope here let an unscoped token, or one scoped waste:write, still read a
 * read-only member's own source URL/last_error unredacted, even though the
 * exact same write would 403 at the mount point.
 */
export function hasWasteWriteAccess(req) {
  if (req.authMethod === 'api_token' && !tokenAllows(req.authScopes ?? null, 'waste', 'write')) return false;
  return moduleAccessVerdict(req.sessionModuleAccess, 'waste', 'write') === MODULE_ACCESS_ALLOW;
}

/**
 * Strips a source's subscription URL AND its last_error for a caller without
 * write access (see hasWasteWriteAccess) - a read-only member could otherwise
 * read a resolved internal address straight out of last_error even though the
 * SSRF guard itself correctly blocked the fetch (e.g. "URL resolves to a
 * private IP address: 169.254.169.254", verified live against the metadata
 * endpoint). url was already redacted for exactly this class of caller;
 * last_error is the same credential-adjacent leak by a different name.
 */
export function redactSourceForReader(source, req) {
  if (!source || hasWasteWriteAccess(req)) return source;
  const { url, last_error, ...rest } = source;
  return rest;
}

/** A query-string type_id filter, or null if absent/malformed. */
export function queryTypeId(req) {
  const raw = req.query.type_id;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}
