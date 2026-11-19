/**
 * Test helper: the health router as server/index.js mounts it (#2810)
 * Purpose: validateRequest() finds the operation of a route by its mount
 *          (`req.baseUrl + route.path`), and it refuses through `next(err)`,
 *          so a health test needs the real prefix `/api/v1/health` and the
 *          central error handler to see the JSON 400 the app answers. Before
 *          this helper twelve suites built their own app, three at `/health`
 *          and nine without `defaultEmptyBody` and the error handler.
 *
 *          The order is that of server/index.js: the JSON parser,
 *          `defaultEmptyBody`, the suite's own sign-in stand-in, what the
 *          suite puts in front of the routes (`before`, e.g. the idempotency
 *          middleware at `/api/v1`), the health router at `/api/v1/health`,
 *          further routers (`after`, e.g. the dashboard), the error handler.
 *
 *          The router is imported here on the first call, after the suite has
 *          set DB_PATH and its database.
 * Run: imported by the health suites, no suite of its own.
 */

// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

/**
 * @param {{
 *   auth: (req: any, res: any, next: () => void) => void,
 *   jsonLimit?: string,
 *   before?: Array<[string, any]>,
 *   after?: Array<[string, any]>,
 *   log?: { warn: (...args: any[]) => void, error: (...args: any[]) => void },
 * }} options
 * @returns {Promise<any>} the express app, not listening yet
 */
export async function createHealthApp({ auth, jsonLimit, before = [], after = [], log }) {
  const { default: healthRouter } = await import('../server/routes/health.js');
  const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
  const { createErrorHandler } = await import('../server/middleware/error-handler.js');
  const app = express();
  app.use(express.json(jsonLimit ? { limit: jsonLimit } : undefined));
  app.use(defaultEmptyBody);
  app.use(auth);
  for (const [path, middleware] of before) app.use(path, middleware);
  app.use('/api/v1/health', healthRouter);
  for (const [path, router] of after) app.use(path, router);
  app.use(createErrorHandler(log ?? { warn: () => {}, error: () => {} }));
  return app;
}
