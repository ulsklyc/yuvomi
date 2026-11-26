/**
 * Test helper: the ICS feeds router as server/index.js mounts it (#2810,
 * group 13)
 * Purpose: the six feeds `/feed/<kind>/<token>.ics` were inline routes in
 *          server/index.js until group 13 moved them into
 *          server/routes/ics-feeds.js; a suite can now run them in-process.
 *          validateRequest() finds the operation by the mount
 *          (`req.baseUrl + route.path`) and refuses through `next(err)`, and
 *          a feed without its own catch hands an error to the central error
 *          handler, so the router needs its real prefix and that handler.
 *
 *          The order is that of server/index.js: `trust proxy` as the app's
 *          default (one hop, so a suite can give each request an address of
 *          its own through `X-Forwarded-For` and the feed limiter counts per
 *          address as in the app), the JSON parser, `defaultEmptyBody`, what
 *          the suite puts in front (`before`), the feeds router at `/feed`
 *          (with its own limiter, the one instance the app uses), further
 *          routers (`after`), the error handler with the suite's `log`. An
 *          entry of `before` and `after` is the argument list of one
 *          `app.use(...)`.
 *
 *          The router is imported on the first call, after the suite has set
 *          DB_PATH and its database.
 * Run: imported by the feed suites, no suite of its own.
 */

// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

/** The prefix server/index.js mounts the feeds router at. */
export const FEED_PREFIX = '/feed';

/**
 * @param {{
 *   before?: Array<Array<any>>,
 *   after?: Array<Array<any>>,
 *   log?: { warn: (...args: any[]) => void, error: (...args: any[]) => void },
 * }} [options]
 * @returns {Promise<any>} the express app, not listening yet
 */
export async function createFeedsApp({ before = [], after = [], log } = {}) {
  const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
  const { createErrorHandler } = await import('../server/middleware/error-handler.js');
  const { default: icsFeedsRouter } = await import('../server/routes/ics-feeds.js');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(defaultEmptyBody);
  for (const entry of before) app.use(...entry);
  app.use(FEED_PREFIX, icsFeedsRouter);
  for (const entry of after) app.use(...entry);
  app.use(createErrorHandler(log ?? { warn: () => {}, error: () => {} }));
  return app;
}
