/**
 * Test helper: the tasks router as server/index.js mounts it (#2810, group 11a)
 * Purpose: validateRequest() finds the operation of a route by its mount
 *          (`req.baseUrl + route.path`), and it refuses through `next(err)`,
 *          so a test of the tasks router needs the real prefix and the central
 *          error handler to see the JSON 400 the app answers. Before this
 *          helper the task suites mounted the router at `/api/v1/tasks`,
 *          `/tasks`, `/tasks-api` or `/`, and fewer than half had
 *          `defaultEmptyBody` or the error handler.
 *
 *          The order is that of server/index.js: the JSON parser,
 *          `defaultEmptyBody`, the suite's own sign-in stand-in (`auth`, one
 *          middleware or several in their order, none for a suite that signs
 *          in through the real auth router in `before`), what the suite puts in
 *          front of the tasks (`before`), the tasks router at
 *          `/api/v1/tasks`, further routers (`after`), the error handler.
 *          An entry of `before` and `after` is the argument list of one
 *          `app.use(...)`: a path and its middlewares, or middlewares alone.
 *
 *          The router is imported here on the first call, after the suite has
 *          set DB_PATH and its database.
 * Run: imported by the task suites, no suite of its own.
 */

// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

/** The prefix server/index.js mounts the tasks router at. */
export const TASKS_PREFIX = '/api/v1/tasks';

/**
 * @param {{
 *   auth?: ((req: any, res: any, next: () => void) => void) | Array<(req: any, res: any, next: () => void) => void>,
 *   jsonLimit?: string,
 *   before?: Array<Array<any>>,
 *   after?: Array<Array<any>>,
 *   log?: { warn: (...args: any[]) => void, error: (...args: any[]) => void },
 * }} options
 * @returns {Promise<any>} the express app, not listening yet
 */
export async function createTasksApp({ auth = [], jsonLimit, before = [], after = [], log }) {
  const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
  const { createErrorHandler } = await import('../server/middleware/error-handler.js');
  const { default: tasksRouter } = await import('../server/routes/tasks.js');
  const app = express();
  app.use(express.json(jsonLimit ? { limit: jsonLimit } : undefined));
  app.use(defaultEmptyBody);
  for (const middleware of [auth].flat()) app.use(middleware);
  for (const entry of before) app.use(...entry);
  app.use(TASKS_PREFIX, tasksRouter);
  for (const entry of after) app.use(...entry);
  app.use(createErrorHandler(log ?? { warn: () => {}, error: () => {} }));
  return app;
}
