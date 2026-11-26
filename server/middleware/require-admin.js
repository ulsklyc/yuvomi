/**
 * Module: requireAdmin middleware
 * Purpose: the admin gate for routes that write configuration, and the request
 *          adapter for the admin question.
 *
 * The rule itself lives in server/authorize/ (phase 2, C1): authorize(actor,
 * 'manage', { household: true }) answers "may this actor manage the household",
 * and managesHousehold() in server/authorize/manage.ts is the one place that
 * compares a role with 'admin'. This file only turns a request into that
 * question - the name isAdminRequest() stays because about ninety call sites
 * ask it.
 *
 * Kept here on purpose and not in server/auth.js: this module has no side
 * effects. auth.js checks SESSION_SECRET on load and throws without it, so any
 * router that pulled only the admin gate from there would force a complete
 * environment on its tests although it needs none of it. server/authorize/
 * does not load server/db.js or server/auth.js either, not even transitively
 * (test:authorize-actor holds that in a child process). auth.js re-exports
 * requireAdmin unchanged - existing imports stay valid.
 */

import { actorFromRequest, authorize } from '../authorize/index.ts';

/**
 * The admin verdict of a request. Call it only after requireAuth: the actor is
 * built once per request from the fields requireAuth set and remembered (see
 * actorFromRequest in server/authorize/actor.ts). requireAuth fixes the role of
 * a signed-in device and of a wall display to `member`.
 * @param {object} req
 */
function manageVerdict(req) {
  return authorize(actorFromRequest(req), 'manage', { household: true });
}

/**
 * Whether the request comes with the admin role - for session and API token
 * alike (requireAuth puts the role that counts into `req.authRole`).
 * @param {object} req
 * @returns {boolean}
 */
export function isAdminRequest(req) {
  return manageVerdict(req).allowed;
}

/**
 * THE refusal of an admin gate (phase 2, C2) - every route that answers "only
 * for administrators" sends it through here, so there is one text and one
 * reason: `403 { error: 'Admin access required.', code: 403, reason:
 * 'admin_required' }`. A signed-in device gets its own reason instead: the
 * person may be an admin, only not from this device (see requireAuth in
 * server/auth.js). Call it only where the admin question said no.
 * @param {object} req
 * @param {{ status(code: number): { json(body: unknown): unknown } }} res
 */
export function refuseAdmin(req, res) {
  if (manageVerdict(req).reason === 'device_credential') {
    return res.status(403).json({ error: 'This is not available on a signed-in device.', code: 403, reason: 'device_credential' });
  }
  return res.status(403).json({ error: 'Admin access required.', code: 403, reason: 'admin_required' });
}

/**
 * THE 401 of requireAuth (server/auth.js): no valid sign-in, or an account
 * that is no longer active. Also the answer when the account was deactivated
 * while a request waited for an await and is asked again at the write (#2947,
 * server/middleware/gate-now.js) - the app signs out on it.
 * @param {{ status(code: number): { json(body: unknown): unknown } }} res
 */
export function sendNotAuthenticated(res) {
  return res.status(401).json({ error: 'Not authenticated.', code: 401 });
}

/**
 * Lets only admins through; everyone else gets the one refusal (refuseAdmin).
 */
export function requireAdmin(req, res, next) {
  if (manageVerdict(req).allowed) {
    return next();
  }
  return refuseAdmin(req, res);
}
