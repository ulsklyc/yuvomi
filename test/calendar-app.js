/**
 * Test helper: the calendar and dashboard routers as server/index.js mounts
 * them (#2810, group 10)
 * Purpose: validateRequest() finds the operation of a route by its mount
 *          (`req.baseUrl + route.path`), and it refuses through `next(err)`,
 *          so a test of these routers needs the real prefixes and the central
 *          error handler to see the JSON 400 the app answers. Before this
 *          helper the calendar suites mounted the router at `/`, `/calendar`
 *          or `/api/v1/calendar`, the dashboard suites at `/`, `/dashboard`
 *          or `/api/v1/dashboard`, and only a few had `defaultEmptyBody` or
 *          the error handler.
 *
 *          The order is that of server/index.js: the JSON parser,
 *          `defaultEmptyBody`, the suite's own sign-in stand-in, what the
 *          suite puts in front of the routes (`before`), the dashboard at
 *          `/api/v1/dashboard`, the calendar at `/api/v1/calendar` (the
 *          collecting router server/routes/calendar.js with its ten part
 *          routers in their order), further routers (`after`), the error
 *          handler.
 *
 *          `mount` names the routers a suite needs (both by default). They
 *          are imported here on the first call, after the suite has set
 *          DB_PATH and its database.
 * Run: imported by the calendar and dashboard suites, no suite of its own.
 */

// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

/** The routers in the order of server/index.js, at their prefix. */
const ROUTERS = [
  ['dashboard', '/api/v1/dashboard', '../server/routes/dashboard.js'],
  ['calendar', '/api/v1/calendar', '../server/routes/calendar.js'],
];

/**
 * @param {{
 *   auth: (req: any, res: any, next: () => void) => void,
 *   mount?: Array<'calendar' | 'dashboard'>,
 *   jsonLimit?: string,
 *   before?: Array<[string, any]>,
 *   after?: Array<[string, any]>,
 *   log?: { warn: (...args: any[]) => void, error: (...args: any[]) => void },
 * }} options
 * @returns {Promise<any>} the express app, not listening yet
 */
export async function createCalendarApp({ auth, mount = ['calendar', 'dashboard'], jsonLimit, before = [], after = [], log }) {
  const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
  const { createErrorHandler } = await import('../server/middleware/error-handler.js');
  const app = express();
  app.use(express.json(jsonLimit ? { limit: jsonLimit } : undefined));
  app.use(defaultEmptyBody);
  app.use(auth);
  for (const [path, middleware] of before) app.use(path, middleware);
  for (const [name, prefix, file] of ROUTERS) {
    if (!mount.includes(/** @type {any} */ (name))) continue;
    const { default: router } = await import(file);
    app.use(prefix, router);
  }
  for (const [path, router] of after) app.use(path, router);
  app.use(createErrorHandler(log ?? { warn: () => {}, error: () => {} }));
  return app;
}
