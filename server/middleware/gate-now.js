/**
 * Module: the gates of a request asked again at the write (#2947)
 * Purpose: requireAuth reads role and module rights once, when the request
 *          arrives; the module gate in server/index.js and requireAdmin answer
 *          on that snapshot. A route that awaits (an upload, a feed, a CalDAV
 *          query, a password hash) and writes afterwards asks here, in the same
 *          synchronous step as the write, whether the same gates still let the
 *          account through. Only narrowing: the verdict at entry stood, this
 *          adds the verdict from the account as it is now (`requestAsOfNow`).
 *
 * The answer on refusal is the one the gate gives at entry:
 *   - module gate: `module_access_denied` / `module_read_only`
 *     (sendModuleGateRefusal, also used by server/index.js);
 *   - admin gate: refuseAdmin() from ./require-admin.js.
 *
 * The connection is handed in: like require-admin.js, this module loads no
 * database.
 */

import { sessionModuleAccessRequirement } from '../scopes.js';
import {
  MODULE_ACCESS_DENIED,
  MODULE_ACCESS_READ_ONLY,
  moduleAccessVerdict,
  requestAsOfNow,
} from '../authorize/index.ts';
import { isAdminRequest, refuseAdmin } from './require-admin.js';

/**
 * The module gate's refusal for a verdict, or null when it lets through.
 * @param {any} res
 * @param {unknown} verdict a result of moduleAccessVerdict()
 * @returns {boolean} true when the refusal was sent
 */
export function sendModuleGateRefusal(res, verdict) {
  if (verdict === MODULE_ACCESS_DENIED) {
    res.status(403).json({ error: 'You do not have access to this module.', code: 403, reason: 'module_access_denied' });
    return true;
  }
  if (verdict === MODULE_ACCESS_READ_ONLY) {
    res.status(403).json({ error: 'You have read-only access to this module.', code: 403, reason: 'module_read_only' });
    return true;
  }
  return false;
}

/**
 * A refusal decided after an await: the route catches it, removes what it
 * staged and sends `respond(res)`.
 */
export class RefusedNowError extends Error {
  /** @param {(res: any) => unknown} respond */
  constructor(respond) {
    super('A gate of the request refuses at the write.');
    this.name = 'RefusedNowError';
    this.respond = respond;
  }
}

/**
 * Do the gates of this request still let it through? `null` if yes, else the
 * answer the refusing gate gives at entry.
 *
 * `admin`: the route sits behind requireAdmin. The module gate is asked for
 * the path and method of the request, as server/index.js asks it; a wall
 * display keeps its own two exceptions there and is not asked here (it never
 * reaches a route that awaits and writes).
 * @param {any} database
 * @param {any} req
 * @param {{ admin?: boolean }} [options]
 * @returns {((res: any) => unknown) | null}
 */
export function gateRefusalNow(database, req, { admin = false } = {}) {
  if (admin && !isAdminRequest(req)) return (res) => refuseAdmin(req, res);
  const now = requestAsOfNow(database, req);
  if (admin && !(now && isAdminRequest(now))) return (res) => refuseAdmin(req, res);
  if (req.authMethod === 'display') return null;
  const path = `${req.baseUrl || ''}${req.path || ''}`.replace(/^\/api\/v1(?=\/|$)/, '');
  const { moduleKey, access } = sessionModuleAccessRequirement(path, req.method);
  const atEntry = moduleAccessVerdict(req.sessionModuleAccess, moduleKey, access);
  const verdict = atEntry === MODULE_ACCESS_DENIED || atEntry === MODULE_ACCESS_READ_ONLY
    ? atEntry
    : (now ? moduleAccessVerdict(now.sessionModuleAccess, moduleKey, access) : MODULE_ACCESS_DENIED);
  if (verdict === MODULE_ACCESS_DENIED || verdict === MODULE_ACCESS_READ_ONLY) {
    return (res) => sendModuleGateRefusal(res, verdict);
  }
  return null;
}

/**
 * Throws RefusedNowError when a gate refuses now (see gateRefusalNow).
 * @param {any} database
 * @param {any} req
 * @param {{ admin?: boolean }} [options]
 */
export function assertGatesNow(database, req, options) {
  const respond = gateRefusalNow(database, req, options);
  if (respond) throw new RefusedNowError(respond);
}
