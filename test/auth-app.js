/**
 * Test helper: the auth router as server/index.js mounts it (#2810, group 12a)
 * Purpose: validateRequest() finds the operation of a route by its mount
 *          (`req.baseUrl + route.path`), and it refuses through `next(err)`,
 *          so a test of the auth router (server/auth.js) or of one of its
 *          builders (buildResetRoutes, buildInviteRoutes, buildGravatarRoute)
 *          needs the real prefix and the central error handler to see the
 *          JSON 400 the app answers. Before this helper the suites mounted the
 *          router or a builder at `/`, `/auth`, `/t` or `/api/v1/auth`, most
 *          without `defaultEmptyBody`, the form parser or the error handler.
 *
 *          The order is that of server/index.js: the JSON parser, the form
 *          parser (`POST /auth/setup` is called form-encoded by the YunoHost
 *          package), `defaultEmptyBody`, the session (`session`, the real
 *          sessionMiddleware or a stand-in), the suite's own sign-in
 *          stand-in (`auth`, one middleware or several in their order), what
 *          the suite puts in front of the routes (`before`), the routers at
 *          `/api/v1/auth`, further routers (`after`), the error handler. An
 *          entry of `before` and `after` is the argument list of one
 *          `app.use(...)`: a path and its middlewares, or middlewares alone.
 *
 *          `routers` are the routers mounted at `/api/v1/auth`, in their
 *          order; by default the real router of server/auth.js. A suite that
 *          builds its routes through a builder with injected services hands
 *          in the router it built, alone or in front of the real one.
 *
 *          server/auth.js is imported here on the first call, after the suite
 *          has set DB_PATH and its database.
 * Run: imported by the auth suites, no suite of its own.
 */

// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

/** The prefix server/index.js mounts the auth router at. */
export const AUTH_PREFIX = '/api/v1/auth';

/**
 * @typedef {(req: any, res: any, next: (err?: unknown) => void) => void} Middleware
 */

/**
 * @param {{
 *   session?: Middleware | null,
 *   auth?: Middleware | Array<Middleware>,
 *   before?: Array<Array<any>>,
 *   routers?: Array<any>,
 *   after?: Array<Array<any>>,
 *   jsonLimit?: string,
 *   log?: { warn: (...args: any[]) => void, error: (...args: any[]) => void },
 * }} [options]
 * @returns {Promise<any>} the express app, not listening yet
 */
export async function createAuthApp({ session = null, auth = [], before = [], routers, after = [], jsonLimit, log } = {}) {
  const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
  const { createErrorHandler } = await import('../server/middleware/error-handler.js');
  const mounted = routers ?? [(await import('../server/auth.js')).router];
  const app = express();
  app.use(express.json(jsonLimit ? { limit: jsonLimit } : undefined));
  app.use(express.urlencoded({ extended: true }));
  app.use(defaultEmptyBody);
  if (session) app.use(session);
  for (const middleware of [auth].flat()) app.use(middleware);
  for (const entry of before) app.use(...entry);
  for (const router of mounted) app.use(AUTH_PREFIX, router);
  for (const entry of after) app.use(...entry);
  app.use(createErrorHandler(log ?? { warn: () => {}, error: () => {} }));
  return app;
}
