/**
 * Test: the central error handler (Phase 1b section E, roadmap decision 19)
 * Purpose: an error a route does not answer itself reaches one place. That
 *          place answers it and logs it:
 *            - a 4xx the thrower marked as safe to show (`expose: true`)
 *              keeps its status; its sentence and `reason` only from an
 *              HttpError, a library's 4xx gets a fixed sentence (body-parser
 *              wraps zlib's text that way);
 *            - a path parameter that does not decode is a 400, its raw
 *              segment (maybe a token) stays out of the log;
 *            - everything else is a 500 with the fixed sentence, the raw text
 *              stays in the log;
 *            - the log names the method and the route PATTERN, never the
 *              path: feed URLs carry a token in a path segment;
 *            - a response that is already on its way goes back to Express.
 *          Runs the handler behind a real Express app, so `req.route` and
 *          the mount behave as in the server.
 *
 * Run: npm run test:error-handler
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// @ts-expect-error express 5 ships no type declarations (TS7016); new code type-checks clean
import express from 'express';
import { createErrorHandler } from '../server/middleware/error-handler.js';
import { HttpError } from '../server/utils/http-error.js';

const FIXED = 'Internal server error.';
const TOKEN = 'feedtoken-0123456789abcdef';

/** @typedef {(req: any, res: any, next: (err?: unknown) => void) => void} Handler */
/** @typedef {{ lines: string[], warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} RecordingLog */

/**
 * A log that keeps every line as one string.
 * @returns {RecordingLog}
 */
function recordingLog() {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} level */
  const keep = (level) => /** @param {...unknown} args */ (...args) => {
    lines.push(`${level} ${args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ')}`);
  };
  return { lines, warn: keep('warn'), error: keep('error') };
}

/**
 * An app with one router mounted under /api/v1/things whose routes fail in
 * every way the handler tells apart, plus a failing middleware before any route.
 * @param {RecordingLog} log
 */
function appWith(log) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.post('/echo', /** @type {Handler} */ ((req, res) => res.json(req.body)));
  router.get('/caused', () => {
    throw new HttpError(422, 'This thing cannot be read.', { cause: new Error('parser said: bad byte at 7') });
  });
  router.get('/caused-500', () => {
    throw new Error('wrapper', { cause: new Error('SQLITE_BUSY: database is locked') });
  });
  router.get('/conflict', async () => {
    throw new HttpError(409, 'This thing changed in the meantime.', { reason: 'thing_changed' });
  });
  router.get('/plain-conflict', () => {
    throw Object.assign(new Error('Taken.'), { statusCode: 409, expose: true });
  });
  router.get('/hidden-404', async () => {
    throw Object.assign(new Error('SQLITE_ERROR: no such table: secret_table'), { status: 404 });
  });
  router.get('/exposed-503', () => {
    throw Object.assign(new Error('upstream at 10.0.0.7:8080 down'), { status: 503, expose: true });
  });
  router.get('/plain', /** @type {Handler} */ ((req, res, next) => {
    next(new Error('ENOENT: no such file or directory, open /data/secret.db'));
  }));
  router.get('/feed/:token', async () => {
    throw new Error('feed broke');
  });
  router.get('/assets/:id/{*assetPath}', () => {
    throw new Error('asset broke');
  });
  router.get('/restore/:token', () => {
    throw Object.assign(new Error('A restore is running.'), { reason: 'restore_in_progress' });
  });
  router.get('/half', /** @type {Handler} */ ((req, res, next) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('started');
    next(new HttpError(409, 'Too late.'));
  }));
  app.use('/api/v1/broken', () => {
    throw new Error('middleware broke');
  });
  app.use('/api/v1/things', router);
  app.use(createErrorHandler(log));
  return app;
}

/**
 * @param {RecordingLog} log
 * @param {(base: string) => Promise<any>} run
 */
async function withServer(log, run) {
  const server = appWith(log).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/**
 * @param {string} path
 * @returns {Promise<{ status: number, body: any, text: string, headers: Headers, log: string[] }>}
 */
async function get(path) {
  const log = recordingLog();
  return withServer(log, async (base) => {
    const res = await fetch(`${base}${path}`);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text, headers: res.headers, log: log.lines };
  });
}

// ── Status and body ──────────────────────────────────────────────────────────

test('an exposed 4xx keeps its status, its sentence and its reason', async () => {
  const { status, body } = await get('/api/v1/things/conflict');
  assert.equal(status, 409);
  assert.deepEqual(body, { error: 'This thing changed in the meantime.', code: 409, reason: 'thing_changed' });
});

test('an exposed 4xx that is not an HttpError keeps its status (statusCode counts too) with a fixed sentence', async () => {
  const { status, body, log } = await get('/api/v1/things/plain-conflict');
  assert.equal(status, 409);
  assert.deepEqual(body, { error: 'The request was refused (Conflict).', code: 409 });
  assert.ok(log.join(' | ').includes('Taken.'), 'the text of the error stays in the log');
});

test('a corrupt gzip body is a 400 without the text of zlib', async () => {
  const log = recordingLog();
  const { status, body } = await withServer(log, async (base) => {
    const res = await fetch(`${base}/api/v1/things/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: 'this is not gzip',
    });
    return { status: res.status, body: await res.json() };
  });
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'The request was refused (Bad Request).', code: 400 });
  assert.ok(log.lines.join(' | ').includes('-> 400'), log.lines.join(' | '));
});

test('an HttpError without reason carries none', async () => {
  const { status, body } = await get('/api/v1/things/caused');
  assert.equal(status, 422);
  assert.deepEqual(body, { error: 'This thing cannot be read.', code: 422 });
});

test('a 4xx without expose is a 500 with the fixed sentence, its text stays in the log', async () => {
  const { status, body, log } = await get('/api/v1/things/hidden-404');
  assert.equal(status, 500);
  assert.deepEqual(body, { error: FIXED, code: 500 });
  assert.ok(log.some((line) => line.includes('no such table')), `the raw text belongs in the log: ${log.join(' | ')}`);
});

test('expose on a status outside 4xx does not open the text', async () => {
  const { status, body } = await get('/api/v1/things/exposed-503');
  assert.equal(status, 500);
  assert.deepEqual(body, { error: FIXED, code: 500 });
});

test('an error without status is a 500 with the fixed sentence', async () => {
  const { status, body, text } = await get('/api/v1/things/plain');
  assert.equal(status, 500);
  assert.deepEqual(body, { error: FIXED, code: 500 });
  assert.ok(!text.includes('/data/secret.db'));
});

test('a restore keeps its 503 with Retry-After and reason', async () => {
  const { status, body, headers } = await get('/api/v1/things/restore/x');
  assert.equal(status, 503);
  assert.equal(headers.get('retry-after'), '30');
  assert.deepEqual(body, { error: 'A restore is running.', code: 503, reason: 'restore_in_progress' });
});

// ── The log ──────────────────────────────────────────────────────────────────

test('the log names method, route pattern and status, never the token in the path', async () => {
  const { log } = await get(`/api/v1/things/feed/${TOKEN}?x=1`);
  const line = log.join(' | ');
  assert.ok(line.includes('GET /api/v1/things/feed/:token'), `pattern with mount in the log: ${line}`);
  assert.ok(line.includes('500'), `status in the log: ${line}`);
  assert.ok(line.includes('feed broke'), `the error in the log: ${line}`);
  assert.ok(!line.includes(TOKEN), `the token must not reach the log: ${line}`);
});

test('a token in the query string does not reach the log', async () => {
  const { log } = await get(`/api/v1/things/feed/x?token=${TOKEN}`);
  const line = log.join(' | ');
  assert.ok(line.includes('GET /api/v1/things/feed/:token'), line);
  assert.ok(!line.includes(TOKEN), line);
});

test('a path parameter that does not decode is a 400 with a fixed sentence, and its raw segment stays out of the log', async () => {
  const { status, body, log } = await get(`/api/v1/things/feed/${TOKEN}%ZZ`);
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'The address contains an invalid percent-encoding.', code: 400 });
  const line = log.join(' | ');
  assert.ok(line.includes('-> 400'), line);
  assert.ok(!line.includes(TOKEN), `the token must not reach the log: ${line}`);
});

test('the cause of an error reaches the log, on a 4xx and on a 500', async () => {
  const exposed = await get('/api/v1/things/caused');
  assert.ok(exposed.log.join(' | ').includes('parser said: bad byte at 7'), exposed.log.join(' | '));
  assert.ok(!exposed.text.includes('bad byte'), 'the cause stays out of the body');
  const hidden = await get('/api/v1/things/caused-500');
  assert.equal(hidden.status, 500);
  assert.ok(hidden.log.join(' | ').includes('SQLITE_BUSY'), hidden.log.join(' | '));
  assert.ok(!hidden.text.includes('SQLITE_BUSY'));
});

test('an exposed 4xx is logged with pattern and status too', async () => {
  const { log } = await get('/api/v1/things/conflict');
  const line = log.join(' | ');
  assert.ok(line.includes('GET /api/v1/things/conflict'), line);
  assert.ok(line.includes('409'), line);
});

test('the restore branch logs the pattern, not the path', async () => {
  const { log } = await get(`/api/v1/things/restore/${TOKEN}`);
  const line = log.join(' | ');
  assert.ok(line.includes('GET /api/v1/things/restore/:token'), line);
  assert.ok(!line.includes(TOKEN), line);
});

test('a wildcard route logs its pattern without the matched segments', async () => {
  const { log } = await get(`/api/v1/things/assets/7/${TOKEN}/deep/file.js`);
  const line = log.join(' | ');
  assert.ok(line.includes('/assets/:id/{*assetPath}'), line);
  assert.ok(!line.includes(TOKEN), line);
});

test('an error after a route called next() still logs the pattern, not the token', async () => {
  const router = express.Router();
  router.get('/:id', /** @type {Handler} */ ((req, res, next) => next()));
  router.use(() => { throw new Error('after a route'); });
  const app = express();
  app.use('/api/v1/feeds', router);
  const log = recordingLog();
  app.use(createErrorHandler(log));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/feeds/${TOKEN}`);
    assert.equal(res.status, 500);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  const line = log.lines.join(' | ');
  assert.ok(line.includes('after a route'), line);
  assert.ok(line.includes('/api/v1/feeds/:id'), line);
  assert.ok(!line.includes(TOKEN), `the token must not reach the log: ${line}`);
});

test('a URL that differs from the pattern in a literal segment gets no mount', async () => {
  const { log } = await get(`/api/v1/things/FEED/${TOKEN}`);
  const line = log.join(' | ');
  assert.ok(line.includes('GET (mount) /feed/:token'), line);
  assert.ok(!line.includes(TOKEN), line);
});

test('an error before any route logs no path at all', async () => {
  const { status, log } = await get(`/api/v1/broken/${TOKEN}`);
  assert.equal(status, 500);
  const line = log.join(' | ');
  assert.ok(line.includes('GET (no route)'), line);
  assert.ok(line.includes('middleware broke'), line);
  assert.ok(!line.includes(TOKEN), `the path must not reach the log: ${line}`);
});

// ── A response on its way ────────────────────────────────────────────────────

test('a response whose head is already sent goes back to Express, which ends it', async () => {
  const log = recordingLog();
  const outcome = await withServer(log, (base) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve('hangs'), 3000);
    const done = () => { clearTimeout(timer); resolve('ended'); };
    http.get(`${base}/api/v1/things/half`, (res) => {
      res.on('data', () => {});
      res.on('end', done);
      res.on('aborted', done);
      res.on('error', done);
    }).on('error', done);
  }));
  assert.equal(outcome, 'ended');
});

test('headersSent hands the error to next untouched', () => {
  const handler = createErrorHandler(recordingLog());
  const err = new HttpError(409, 'Too late.');
  let passed;
  const res = { headersSent: true, status() { throw new Error('must not answer'); } };
  handler(err, { method: 'GET' }, res, /** @param {unknown} e */ (e) => { passed = e; });
  assert.equal(passed, err);
});

// ── HttpError ────────────────────────────────────────────────────────────────

test('HttpError carries status, reason and expose for a 4xx', () => {
  const err = new HttpError(404, 'Not found.', { reason: 'thing_missing' });
  assert.ok(err instanceof Error);
  assert.equal(err.status, 404);
  assert.equal(err.reason, 'thing_missing');
  assert.equal(err.expose, true);
  assert.equal(err.message, 'Not found.');
});

test('HttpError is never exposed outside 4xx', () => {
  assert.equal(new HttpError(500, 'x').expose, false);
  assert.equal(new HttpError(302, 'x').expose, false);
  assert.equal(new HttpError(400, 'x').reason, undefined);
});
