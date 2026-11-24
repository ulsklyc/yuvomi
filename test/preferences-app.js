/**
 * Test helper: the preferences and push routers as server/index.js mounts
 * them (#2810, group 11b)
 * Purpose: validateRequest() finds the operation of a route by its mount
 *          (`req.baseUrl + route.path`), and it refuses through `next(err)`,
 *          so a test of these routers needs the real prefixes and the central
 *          error handler to see the JSON 400 the app answers. Before this
 *          helper the preferences suites mounted the router at `/`,
 *          `/preferences` or `/api/v1/preferences`, the push suites at `/` or
 *          `/push`, and few had `defaultEmptyBody` or the error handler.
 *
 *          The order is that of server/index.js: the JSON parser,
 *          `defaultEmptyBody`, the suite's own sign-in stand-in (`auth`, one
 *          middleware or several in their order), what the suite puts in
 *          front of the routes (`before`), the preferences router at
 *          `/api/v1/preferences`, the push router at `/api/v1/push`, further
 *          routers (`after`), the error handler. An entry of `before` and
 *          `after` is the argument list of one `app.use(...)`: a path and its
 *          middlewares, or middlewares alone.
 *
 *          `mount` names the routers a suite needs (both by default). A suite
 *          that builds the push router through its factory
 *          (`buildRouter({ pushService, database })`) leaves `push` out of
 *          `mount` and hands it in through `after` at `PUSH_PREFIX`.
 *
 *          The routers are imported here on the first call, after the suite
 *          has set DB_PATH and its database.
 * Run: imported by the preferences and push suites, no suite of its own.
 */

// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

/** The prefix server/index.js mounts the preferences router at. */
export const PREFERENCES_PREFIX = '/api/v1/preferences';
/** The prefix server/index.js mounts the push router at. */
export const PUSH_PREFIX = '/api/v1/push';

/** The routers in the order of server/index.js, at their prefix. */
const ROUTERS = [
  ['preferences', PREFERENCES_PREFIX, '../server/routes/preferences.js'],
  ['push', PUSH_PREFIX, '../server/routes/push.js'],
];

/**
 * @param {{
 *   auth?: ((req: any, res: any, next: () => void) => void) | Array<(req: any, res: any, next: () => void) => void>,
 *   mount?: Array<'preferences' | 'push'>,
 *   jsonLimit?: string,
 *   before?: Array<Array<any>>,
 *   after?: Array<Array<any>>,
 *   log?: { warn: (...args: any[]) => void, error: (...args: any[]) => void },
 * }} options
 * @returns {Promise<any>} the express app, not listening yet
 */
export async function createPreferencesApp({ auth = [], mount = ['preferences', 'push'], jsonLimit, before = [], after = [], log }) {
  const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
  const { createErrorHandler } = await import('../server/middleware/error-handler.js');
  const app = express();
  app.use(express.json(jsonLimit ? { limit: jsonLimit } : undefined));
  app.use(defaultEmptyBody);
  for (const middleware of [auth].flat()) app.use(middleware);
  for (const entry of before) app.use(...entry);
  for (const [name, prefix, file] of ROUTERS) {
    if (!mount.includes(/** @type {any} */ (name))) continue;
    const { default: router } = await import(file);
    app.use(prefix, router);
  }
  for (const entry of after) app.use(...entry);
  app.use(createErrorHandler(log ?? { warn: () => {}, error: () => {} }));
  return app;
}
