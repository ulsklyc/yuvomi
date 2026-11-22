/**
 * Test helper: the shopping, Google Drive storage, DMS and documents routers
 * as server/index.js mounts them (#2810, group 8)
 * Purpose: validateRequest() finds the operation of a route by its mount
 *          (`req.baseUrl + route.path`), and it refuses through `next(err)`,
 *          so a test of these routers needs the real prefixes and the central
 *          error handler to see the JSON 400 the app answers. Before this
 *          helper the shopping suites mounted the router at `/` or
 *          `/shopping`, the Google Drive suite at `/`, and most document
 *          suites had neither `defaultEmptyBody` nor the error handler.
 *
 *          The order is that of server/index.js: the JSON parser,
 *          `defaultEmptyBody`, the suite's own sign-in stand-in, what the
 *          suite puts in front of the routes (`before`), the shopping list at
 *          `/api/v1/shopping`, Google Drive at
 *          `/api/v1/documents/storage/google-drive` and the DMS at
 *          `/api/v1/documents/dms` BEFORE the documents at `/api/v1/documents`,
 *          further routers (`after`, e.g. the reminders), the error handler.
 *
 *          `mount` names the routers a suite needs (all four by default).
 *          They are imported here on the first call, after the suite has set
 *          DB_PATH and its database.
 * Run: imported by the shopping and documents suites, no suite of its own.
 */

// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

/** The routers in the order of server/index.js, at their prefix. */
const ROUTERS = [
  ['shopping', '/api/v1/shopping', '../server/routes/shopping.js'],
  ['google-drive', '/api/v1/documents/storage/google-drive', '../server/routes/document-storage-google-drive.js'],
  ['dms', '/api/v1/documents/dms', '../server/routes/dms.js'],
  ['documents', '/api/v1/documents', '../server/routes/documents.js'],
];

/**
 * @param {{
 *   auth: (req: any, res: any, next: () => void) => void,
 *   mount?: Array<'shopping' | 'google-drive' | 'dms' | 'documents'>,
 *   jsonLimit?: string,
 *   before?: Array<[string, any]>,
 *   after?: Array<[string, any]>,
 *   log?: { warn: (...args: any[]) => void, error: (...args: any[]) => void },
 * }} options
 * @returns {Promise<any>} the express app, not listening yet
 */
export async function createShoppingDocumentsApp({ auth, mount = ['shopping', 'google-drive', 'dms', 'documents'], jsonLimit, before = [], after = [], log }) {
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
