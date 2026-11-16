/**
 * Module: the central error handler of the app
 * Purpose: the last stop of every error a route does not answer itself
 *          (Phase 1b section E, roadmap decision 19). Pulled out of
 *          server/index.js so the test runs it as a program (#1431).
 *
 *          - A 4xx whose thrower marked it as safe to show (`expose: true`)
 *            keeps its status. Its sentence and `reason` reach the client only
 *            from an HttpError (server/utils/http-error.js), whose message we
 *            write ourselves. The HTTP libraries mark their own errors exposed
 *            too, and body-parser wraps Node's zlib text ("incorrect header
 *            check") that way; such a 4xx gets a fixed sentence per status.
 *          - A path parameter that does not decode (`%ZZ`) is a 400 with a
 *            fixed sentence. The router writes the raw segment into its
 *            message, and that segment can be a feed token, so the message is
 *            not logged.
 *          - Everything else is a 500 with a fixed sentence; the raw text goes
 *            to the log only.
 *          - During a restore (#1431) a session that cannot be saved arrives
 *            here (`reason: 'restore_in_progress'`): that becomes a 503 with the
 *            same reason, which the client translates.
 *
 *          The log names the method and the route PATTERN, never the path:
 *          feed URLs carry a token in a path segment.
 *
 *          If the response is already on its way - express-session reports an
 *          error only after writing - the error belongs to Express: its default
 *          handler ends the connection. A bare `return` would leave the half
 *          response open until the client gives up (review #1431).
 */

import { STATUS_CODES } from 'node:http';
import { HttpError } from '../utils/http-error.js';

const FIXED_SENTENCE = 'Internal server error.';
const UNDECODABLE_PARAM_SENTENCE = 'The address contains an invalid percent-encoding.';

/**
 * The status a client may see, or null: an exposed 4xx only.
 * @param {any} err whatever was thrown or passed to next()
 * @returns {number | null}
 */
function exposedStatus(err) {
  if (err?.expose !== true) return null;
  const status = err.status ?? err.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 499 ? status : null;
}

/**
 * A fixed sentence for a 4xx whose text is not ours.
 * @param {number} status
 */
function sentenceFor(status) {
  return `The request was refused (${STATUS_CODES[status] ?? `HTTP ${status}`}).`;
}

/**
 * ` (cause: <name>: <message>)` for the log, or '' without a cause. The
 * logger keeps only name, message and stack of an Error, never its cause.
 * @param {any} err
 */
function causeNote(err) {
  const cause = err?.cause;
  if (cause === undefined || cause === null) return '';
  return cause instanceof Error ? ` (cause: ${cause.name}: ${cause.message})` : ` (cause: ${String(cause)})`;
}

/**
 * The route pattern of the request, with its mount.
 *
 * Express 5 resets `req.baseUrl` when the error leaves a router, so
 * `req.baseUrl + req.route.path` lacks the mount here. `req.route` survives:
 * its path has as many segments as the end of the URL it matched, so the
 * mount is the URL without them. The mount is used only where every literal
 * segment of the pattern sits unchanged at its place in the URL (Express
 * matches case-insensitively); otherwise the count could be off by a segment
 * and a raw one would land in the log. A pattern whose segment count is not
 * fixed (a wildcard, an optional group) gets no mount rather than a guessed
 * one. Without a matched route there is no pattern, and no path is logged.
 * @param {{ route?: { path?: unknown }, originalUrl?: string }} req
 * @returns {string}
 */
function routePattern(req) {
  const pattern = req.route?.path;
  if (typeof pattern !== 'string') return '(no route)';
  const unmounted = `(mount) ${pattern}`;
  if (/[*{}()?]/.test(pattern)) return unmounted;
  const own = pattern.split('/').filter(Boolean);
  const segments = String(req.originalUrl ?? '').split(/[?#]/)[0].split('/').filter(Boolean);
  if (segments.length < own.length) return unmounted;
  const tail = segments.slice(segments.length - own.length);
  if (own.some((part, i) => !part.includes(':') && part !== tail[i])) return unmounted;
  const mount = segments.slice(0, segments.length - own.length).join('/');
  return `${mount ? `/${mount}` : ''}${pattern}`;
}

/**
 * @param {{ warn: Function, error: Function }} log
 * @returns {import('express').ErrorRequestHandler}
 */
export function createErrorHandler(log) {
  return function errorHandler(err, req, res, next) {
    const where = `${req.method} ${routePattern(req)}`;
    if (err?.reason === 'restore_in_progress') {
      log.warn(`Request refused during a restore: ${where} -> 503`);
      if (res.headersSent) return next(err);
      res.setHeader('Retry-After', '30');
      return res.status(503).json({ error: err.message, code: 503, reason: err.reason });
    }
    if (err instanceof URIError && /** @type {{ status?: unknown }} */ (err).status === 400) {
      log.warn(`Request refused: ${where} -> 400: a path parameter does not decode`);
      if (res.headersSent) return next(err);
      return res.status(400).json({ error: UNDECODABLE_PARAM_SENTENCE, code: 400 });
    }
    const status = exposedStatus(err);
    if (status !== null) {
      log.warn(`Request refused: ${where} -> ${status}: ${err.message}${causeNote(err)}`);
      if (res.headersSent) return next(err);
      if (!(err instanceof HttpError)) return res.status(status).json({ error: sentenceFor(status), code: status });
      const withReason = typeof err.reason === 'string' && err.reason !== '';
      return res.status(status).json({ error: err.message, code: status, ...(withReason ? { reason: err.reason } : {}) });
    }
    log.error(`Unhandled error: ${where} -> 500${causeNote(err)}`, err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: FIXED_SENTENCE, code: 500 });
  };
}
