/**
 * Test: the request validator (Phase 2, section E, #2810)
 * Purpose: validateRequest() checks a request against the schema of its
 *          operation in the OpenAPI document and refuses it with a 400 and
 *          `fields`, before the handler runs:
 *            - every route the routers hang (test/openapi-routes.js) resolves
 *              from mount and Express pattern to exactly one operation of the
 *              document - the key the middleware uses at runtime;
 *            - path and query are checked with coercion on a COPY, the handler
 *              still reads the strings Express gave it;
 *            - the body is checked as it is and stays byte-equal: no coercion,
 *              no defaults, no removed fields;
 *            - a route without an operation is a programming error (500), never
 *              a silent pass;
 *            - neither the answer nor the log carries a value of the request or
 *              a message text of Ajv.
 *          The behaviour runs against a small document behind a real Express
 *          app, so `req.baseUrl`, `req.route` and the error handler behave as
 *          in the server.
 * Run: npm run test:validate-request
 */

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016); new code type-checks clean
import express from 'express';
import { buildOpenApiSpec } from '../server/openapi.js';
import { createErrorHandler } from '../server/middleware/error-handler.js';
import { defaultEmptyBody } from '../server/middleware/empty-body.js';
import { createRequestValidator, resolveOperation, validateRequest as boundValidateRequest } from '../server/api/validate-request.ts';
import { allRoutes } from './openapi-routes.js';

const SECRET = 'SECRET-VALUE-4711';
const SENTENCE = 'The request does not match the documented schema.';

// ── Every route resolves to exactly one operation ────────────────────────────

/**
 * Routes whose Express pattern cannot name one OpenAPI path. Each entry is
 * `METHOD mount+pattern` with the reason; a resolvable entry here is red.
 * @type {Map<string, string>}
 */
const UNRESOLVABLE = new Map([]);

test('every route of the routers resolves to exactly one operation of the document', () => {
  const spec = buildOpenApiSpec(null, '0.0.0');
  const routes = allRoutes();
  assert.ok(routes.length >= 600, `only ${routes.length} routes read`);
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const staleExceptions = [];
  for (const route of routes) {
    const label = `${route.verb.toUpperCase()} ${route.mount}${route.pattern}`;
    const hit = resolveOperation(spec, route.verb, route.mount, route.pattern);
    if (UNRESOLVABLE.has(label)) {
      if (hit) staleExceptions.push(label);
      continue;
    }
    if (!hit) failures.push(`${label} (${route.file})`);
    else assert.equal(hit.path, route.path, `${label} resolved to ${hit.path}`);
  }
  assert.deepEqual(failures, [], 'these routes resolve to no operation of the document');
  assert.deepEqual(staleExceptions, [], 'these exceptions resolve now: remove them from UNRESOLVABLE');
});

/**
 * The route files whose every route checks its request (#2810, pilot): the
 * middleware is the first handler of each route, so no handler of these files
 * runs on a request the document refuses. Their behaviour against the real
 * routers holds test:validate-pilot-modules.
 */
const VALIDATED_FILES = ['server/routes/notes.js', 'server/routes/birthdays.js', 'server/routes/quick-links.js'];

test('every route of the pilot files carries validateRequest() as its first handler', () => {
  /** @type {Map<string, number>} */
  const counted = new Map(VALIDATED_FILES.map((file) => [file, 0]));
  /** @type {string[]} */
  const missing = [];
  for (const route of allRoutes()) {
    const file = VALIDATED_FILES.find((f) => route.file.endsWith(f));
    if (!file) continue;
    counted.set(file, (counted.get(file) ?? 0) + 1);
    if (!/^\w*[Rr]outer\.\w+\(\s*'[^']*'\s*,\s*validateRequest\(\)\s*,/.test(route.body)) {
      missing.push(`${route.verb.toUpperCase()} ${route.mount}${route.pattern}`);
    }
  }
  assert.deepEqual(Object.fromEntries(counted), {
    'server/routes/notes.js': 11,
    'server/routes/birthdays.js': 8,
    'server/routes/quick-links.js': 5,
  }, 'the routes read from the pilot files');
  assert.deepEqual(missing, [], 'these routes of the pilot files run without validateRequest()');
});

test('the resolution converts the Express pattern and the mount', () => {
  const spec = {
    paths: {
      '/api/v1/things': { get: { responses: {} }, post: { responses: {} } },
      '/api/v1/things/{id}/parts/{partId}': { delete: { responses: {} } },
      '/api/v1/files/{rest}': { get: { responses: {} } },
    },
  };
  assert.equal(resolveOperation(spec, 'get', '/api/v1/things', '/')?.path, '/api/v1/things');
  assert.equal(resolveOperation(spec, 'POST', '/api/v1/things', '/')?.method, 'post');
  assert.equal(resolveOperation(spec, 'delete', '/api/v1/things', '/:id/parts/:partId')?.path, '/api/v1/things/{id}/parts/{partId}');
  assert.equal(resolveOperation(spec, 'get', '/api/v1/files', '/{*rest}')?.path, '/api/v1/files/{rest}');
  assert.equal(resolveOperation(spec, 'head', '/api/v1/things', '/')?.method, 'get', 'HEAD falls back to GET as in Express');
  assert.equal(resolveOperation(spec, 'get', '/API/V1/Things', '/')?.path, '/api/v1/things', 'Express matches the mount case-insensitively');
  assert.equal(resolveOperation(spec, 'delete', '/api/v1/things', '/:id/parts/:partid'), null, 'a parameter name is matched exactly: the check reads it');
  assert.equal(resolveOperation(spec, 'put', '/api/v1/things', '/'), null, 'no operation for the method');
  assert.equal(resolveOperation(spec, 'get', '/api/v1/things', '/:id'), null, 'no path');
  assert.equal(resolveOperation(spec, 'get', '/api/v1/things', '/{:id}'), null, 'an optional group names no single path');
  assert.equal(resolveOperation(spec, 'get', '/api/v1/things', /x/), null, 'a regular expression names no path');
});

test('two paths of the document that differ only in the case of a literal part resolve to none', () => {
  const spec = { paths: { '/api/v1/a/{id}': { get: { responses: {} } }, '/api/v1/A/{id}': { get: { responses: {} } } } };
  assert.equal(resolveOperation(spec, 'get', '/api/v1', '/a/:id'), null);
});

// ── Behaviour behind a small app ─────────────────────────────────────────────

const MINI = {
  openapi: '3.1.0',
  info: { title: 'mini', version: '0' },
  paths: {
    '/api/v1/things': {
      get: {
        parameters: [
          { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1 } },
          { in: 'header', name: 'X-Count', required: true, schema: { type: 'integer' } },
        ],
        responses: {},
      },
      post: {
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ThingInput' } } } },
        responses: {},
      },
    },
    '/api/v1/things/{id}': {
      get: { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }], responses: {} },
      patch: {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: { title: { type: 'string' } } } } } },
        responses: {},
      },
    },
    '/api/v1/things/{id}/open': {
      post: {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: {} } } },
        responses: {},
      },
    },
    '/api/v1/things/{id}/file': {
      put: {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', contentMediaType: 'application/octet-stream' } } } },
        responses: {},
      },
    },
    '/api/v1/things/files/{rest}': {
      get: { parameters: [{ in: 'path', name: 'rest', required: true, schema: { type: 'string', pattern: '^[a-z/]+$' } }], responses: {} },
    },
    '/api/v1/things/kinds': {
      get: {
        parameters: [
          { in: 'query', name: 'types', style: 'form', explode: false, schema: { type: 'array', minItems: 1, items: { type: 'string', enum: ['task', 'event'] } } },
          { in: 'query', name: 'tags', style: 'form', explode: true, schema: { type: 'array', maxItems: 1, items: { type: 'string' } } },
          { in: 'query', name: 'labels', schema: { type: ['array', 'null'], maxItems: 1, items: { type: 'string' } } },
          { in: 'query', name: 'ids', style: 'form', explode: false, schema: { type: ['array', 'null'], items: { type: 'integer' } } },
        ],
        responses: {},
      },
    },
    '/api/v1/things/proto': {
      get: { parameters: [{ in: 'query', name: 'length', required: true, schema: { type: 'integer' } }], responses: {} },
    },
    '/api/v1/things/deep': {
      get: { parameters: [{ in: 'query', name: 'filter', style: 'deepObject', explode: true, schema: { type: 'object' } }], responses: {} },
    },
    '/api/v1/things/shared': {
      get: { parameters: [{ $ref: '#/components/parameters/Limit' }], responses: {} },
    },
    '/api/v1/things/many': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { anyOf: Array.from({ length: 30 }, (_, i) => ({ type: 'object', required: [`k${i}`], properties: { [`k${i}`]: { type: 'integer' } } })) },
            },
          },
        },
        responses: {},
      },
    },
  },
  components: {
    parameters: { Limit: { in: 'query', name: 'limit', schema: { type: 'integer' } } },
    schemas: {
      ThingInput: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', maxLength: 20 },
          due: { type: 'string', format: 'date' },
          meta: { type: 'object', additionalProperties: { type: 'integer' } },
        },
      },
    },
  },
};

/** @typedef {{ lines: string[], warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} RecordingLog */

/** @returns {RecordingLog} */
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
 * @param {RecordingLog} log
 */
function miniApp(log) {
  const validateRequest = createRequestValidator(MINI);
  const app = express();
  // The order of the app (server/index.js): the parser, then `{}` for a request without a body.
  app.use(express.json());
  app.use(defaultEmptyBody);
  const router = express.Router();
  /** @param {any} req @param {any} res */
  const echo = (req, res) => res.json({ query: req.query, params: req.params, body: req.body ?? null });
  router.get('/', validateRequest(), echo);
  router.post('/', validateRequest(), echo);
  router.post('/many', validateRequest(), echo);
  router.get('/kinds', validateRequest(), echo);
  router.get('/proto', validateRequest(), echo);
  router.get('/deep', validateRequest(), echo);
  router.get('/shared', validateRequest(), echo);
  router.get('/files/{*rest}', validateRequest(), echo);
  router.get('/missing', validateRequest(), echo);
  router.get('/:id', validateRequest(), echo);
  router.patch('/:id', validateRequest(), echo);
  router.post('/:id/open', validateRequest(), echo);
  router.put('/:id/file', validateRequest(), echo);
  router.use(validateRequest());
  router.delete('/:id', echo);
  app.use('/api/v1/things', router);
  app.use(createErrorHandler(log));
  return app;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{ json?: unknown, raw?: string, headers?: Record<string, string> }} [options]
 */
async function call(method, path, options = {}) {
  return callApp(miniApp, method, path, options);
}

/**
 * @param {(log: RecordingLog) => any} appFor
 * @param {string} method
 * @param {string} path
 * @param {{ json?: unknown, raw?: string, headers?: Record<string, string> }} [options]
 */
async function callApp(appFor, method, path, { json, raw, headers = {} } = {}) {
  const log = recordingLog();
  const server = appFor(log).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    /** @type {RequestInit} */
    const init = { method, headers: { ...headers } };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers = { 'content-type': 'application/json', ...headers };
    } else if (raw !== undefined) {
      init.body = raw;
    }
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text, log: log.lines };
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/**
 * @param {{ status: number, body: any }} res
 * @param {{ path: string, rule: string }[]} fields
 */
function assertRefused(res, fields) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: SENTENCE, code: 400, reason: 'validation', fields });
}

test('a valid request goes through to the handler', async () => {
  const res = await call('GET', '/api/v1/things/12');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.params, { id: '12' });
});

test('a path id that is no integer is a 400 naming path/id and the rule', async () => {
  assertRefused(await call('GET', '/api/v1/things/12abc'), [{ path: 'path/id', rule: 'type' }]);
});

test('an integer parameter must be written as plain decimal digits: 1e2 and 0x10 are 400, before Ajv coerces them', async () => {
  // Ajv's coercion reads `1e2` as 100 and `0x10` as 16; the handler's parseInt
  // reads 1 and 0. Checked and used would be two different numbers.
  for (const id of ['1e2', '0x10', '1.0', '+5', ' 5', '5 ']) {
    assertRefused(await call('GET', `/api/v1/things/${encodeURIComponent(id)}`), [{ path: 'path/id', rule: 'type' }]);
  }
  assertRefused(await call('GET', '/api/v1/things?limit=1e2'), [{ path: 'query/limit', rule: 'type' }]);
  assertRefused(await call('GET', '/api/v1/things?limit=0x10'), [{ path: 'query/limit', rule: 'type' }]);
  const negative = await call('GET', '/api/v1/things/-5');
  assert.equal(negative.status, 200, 'an optional minus stays plain digits');
  assert.deepEqual(negative.body.params, { id: '-5' });
  assert.equal((await call('GET', '/api/v1/things/007')).status, 200, 'leading zeros are digits');
});

test('a query number written as text goes through, and the handler still reads the string', async () => {
  const res = await call('GET', '/api/v1/things?limit=5');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.query, { limit: '5' }, 'coercion works on a copy, req.query stays as Express parsed it');
});

test('a query value outside its schema is a 400 naming query/limit', async () => {
  assertRefused(await call('GET', '/api/v1/things?limit=0'), [{ path: 'query/limit', rule: 'minimum' }]);
  assertRefused(await call('GET', '/api/v1/things?limit=many'), [{ path: 'query/limit', rule: 'type' }]);
});

test('headers are not checked', async () => {
  const res = await call('GET', '/api/v1/things', { headers: { 'X-Count': 'not a number' } });
  assert.equal(res.status, 200);
});

test('a number in a text field of the body is a 400 with fields', async () => {
  assertRefused(await call('POST', '/api/v1/things', { json: { title: 42 } }), [{ path: 'body/title', rule: 'type' }]);
});

test('a missing required property names its own path', async () => {
  assertRefused(await call('POST', '/api/v1/things', { json: { due: '2026-11-18' } }), [{ path: 'body/title', rule: 'required' }]);
});

test('a format of the document is checked (ajv-formats)', async () => {
  assertRefused(await call('POST', '/api/v1/things', { json: { title: 'x', due: '18.11.2026' } }), [{ path: 'body/due', rule: 'format' }]);
});

test('the body behind a $ref is resolved, and stays unchanged after a passing check', async () => {
  const sent = { title: '7', unknown: { nested: [1, '2'] }, meta: { a: 1 } };
  const res = await call('POST', '/api/v1/things', { json: sent });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.body, sent, 'no coercion, no defaults, no removed field');
  assert.equal(typeof res.body.body.title, 'string');
});

test('a required body that is missing is a 400, though the app put {} in its place', async () => {
  assertRefused(await call('POST', '/api/v1/things'), [{ path: 'body', rule: 'required' }]);
  assertRefused(await call('POST', '/api/v1/things', { json: {} }), [{ path: 'body/title', rule: 'required' }]);
});

test('an optional body may be missing (the {} of the app is not checked), a present one is checked', async () => {
  assert.equal((await call('PATCH', '/api/v1/things/3')).status, 200);
  assertRefused(await call('PATCH', '/api/v1/things/3', { json: {} }), [{ path: 'body', rule: 'minProperties' }]);
  assertRefused(await call('PATCH', '/api/v1/things/3', { json: { title: 1 } }), [{ path: 'body/title', rule: 'type' }]);
});

test('an empty body schema checks nothing, and a body that is not JSON is not checked', async () => {
  assert.equal((await call('POST', '/api/v1/things/3/open', { json: [1, 'x'] })).status, 200);
  assert.equal((await call('PUT', '/api/v1/things/3/file', { raw: 'binary', headers: { 'content-type': 'application/octet-stream' } })).status, 200);
});

test('a wildcard path parameter is checked as the joined path', async () => {
  assert.equal((await call('GET', '/api/v1/things/files/a/b')).status, 200);
  assertRefused(await call('GET', '/api/v1/things/files/a/B9'), [{ path: 'path/rest', rule: 'pattern' }]);
});

test('a query array with explode: false is split at the comma on the copy, the handler reads the string', async () => {
  const ok = await call('GET', '/api/v1/things/kinds?types=task,event');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.query, { types: 'task,event' });
  assertRefused(await call('GET', '/api/v1/things/kinds?types=task,nope'), [{ path: 'query/types/1', rule: 'enum' }]);
  assert.equal((await call('GET', '/api/v1/things/kinds?ids=1,2')).status, 200, 'a type list with array counts as an array');
  assertRefused(await call('GET', '/api/v1/things/kinds?ids=1,x'), [{ path: 'query/ids/1', rule: 'type' }]);
});

test('a query array with explode: true, or without style, keeps a comma inside one element', async () => {
  assert.equal((await call('GET', '/api/v1/things/kinds?tags=a,b')).status, 200);
  assert.equal((await call('GET', '/api/v1/things/kinds?labels=a,b')).status, 200);
  assertRefused(await call('GET', '/api/v1/things/kinds?tags=a&tags=b'), [{ path: 'query/tags', rule: 'maxItems' }]);
});

test('a query style other than form is a programming error (500)', async () => {
  const res = await call('GET', '/api/v1/things/deep?filter[a]=1');
  assert.equal(res.status, 500);
  assert.ok(res.log.join(' | ').includes('deepObject'), res.log.join(' | '));
});

test('a parameter given as $ref is a programming error (500), never skipped', async () => {
  const res = await call('GET', '/api/v1/things/shared?limit=x');
  assert.equal(res.status, 500);
  assert.ok(res.log.join(' | ').includes('$ref'), res.log.join(' | '));
});

test('a __proto__ key in the query does not set the prototype of the copy', async () => {
  // Repeated, the key is an array; on a plain object it would become the
  // prototype, and its inherited `length` would answer the required check.
  assertRefused(await call('GET', '/api/v1/things/proto?__proto__=a&__proto__=b'), [{ path: 'query/length', rule: 'required' }]);
});

test('Express matches the mount case-insensitively, so does the validator', async () => {
  const res = await call('GET', '/API/V1/THINGS/12');
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('a route without an operation in the document is a 500, never a silent pass', async () => {
  const res = await call('GET', '/api/v1/things/missing');
  assert.equal(res.status, 500);
  assert.ok(res.log.join(' | ').includes('GET /api/v1/things/missing'), res.log.join(' | '));
});

test('outside a route (router.use) the validator is a 500', async () => {
  const res = await call('DELETE', '/api/v1/things/1');
  assert.equal(res.status, 500);
  assert.ok(res.log.join(' | ').includes('must sit in the stack of a route'), res.log.join(' | '));
});

test('neither answer nor log carries a value of the request or a text of Ajv', async () => {
  const runs = [
    await call('GET', `/api/v1/things/${SECRET}`),
    await call('GET', `/api/v1/things?limit=${SECRET}`),
    await call('POST', '/api/v1/things', { json: { title: `${SECRET}-much-too-long-for-the-limit` } }),
    await call('POST', '/api/v1/things', { json: { title: 'x', due: SECRET } }),
  ];
  for (const run of runs) {
    assert.equal(run.status, 400, run.text);
    const seen = `${run.text} | ${run.log.join(' | ')}`;
    assert.ok(!seen.includes(SECRET), `a value of the request leaked: ${seen}`);
    assert.ok(!/must (be|have|match|NOT)/.test(seen), `an Ajv message leaked: ${seen}`);
  }
  assert.deepEqual(runs[2].body.fields, [{ path: 'body/title', rule: 'maxLength' }]);
  const line = runs[2].log.join(' | ');
  assert.ok(line.includes('maxLength') && line.includes('body/title'), `the log names rule and path: ${line}`);
});

test('a path built from a foreign key is cut, and so is the number of fields', async () => {
  const key = 'k'.repeat(500);
  const res = await call('POST', '/api/v1/things', { json: { title: 'x', meta: { [key]: 'x' } } });
  assert.equal(res.status, 400);
  assert.equal(res.body.fields.length, 1);
  assert.equal(res.body.fields[0].rule, 'type');
  assert.ok(res.body.fields[0].path.startsWith('body/meta/kkk'), res.body.fields[0].path);
  assert.ok(res.body.fields[0].path.length <= 120, `path of ${res.body.fields[0].path.length} characters`);

  const many = await call('POST', '/api/v1/things/many', { json: { none: true } });
  assert.equal(many.status, 400);
  assert.ok(many.body.fields.length >= 1 && many.body.fields.length <= 10, `${many.body.fields.length} fields`);
});

test('the bound validator reads the app document lazily: creating it compiles nothing', () => {
  const middleware = boundValidateRequest();
  assert.equal(typeof middleware, 'function');
  assert.equal(middleware.length, 3);
});

test('the bound validator compiles the checks of every route of the app document', () => {
  const middleware = boundValidateRequest();
  /** @type {string[]} */
  const failures = [];
  for (const route of allRoutes()) {
    const label = `${route.verb.toUpperCase()} ${route.mount}${route.pattern}`;
    if (UNRESOLVABLE.has(label)) continue;
    const req = { method: route.verb.toUpperCase(), baseUrl: route.mount, route: { path: route.pattern }, params: {}, query: {}, body: undefined };
    try {
      let called = false;
      middleware(req, {}, () => { called = true; });
      if (!called) failures.push(`${label}: next() not called`);
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  assert.deepEqual(failures, [], 'these routes fail to compile their checks');
});

// ── The route's own reason through x-reason ─────────────────────────────────

const REASONED = {
  openapi: '3.1.0',
  info: { title: 'reasoned', version: '0' },
  paths: {
    '/api/v1/r/items/{id}': {
      get: {
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1, 'x-reason': 'item_id_invalid' } },
          { in: 'query', name: 'limit', schema: { type: 'integer', maximum: 50, 'x-reason': { maximum: 'limit_too_high', default: 'limit_invalid' } } },
          { in: 'query', name: 'plain', schema: { type: 'integer' } },
        ],
        responses: {},
      },
    },
    '/api/v1/r/items': {
      post: {
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemInput' } } } },
        responses: {},
      },
    },
    '/api/v1/r/parent': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                'x-reason': { required: 'parent_incomplete' },
                required: ['a', 'b'],
                properties: { a: { type: 'string', 'x-reason': 'a_invalid' }, b: { type: 'string' } },
              },
            },
          },
        },
        responses: {},
      },
    },
    '/api/v1/r/fallback': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                'x-reason': 'whole_invalid',
                required: ['a', 'c'],
                properties: { a: { type: 'string', 'x-reason': 'a_invalid' }, c: { type: 'string' } },
              },
            },
          },
        },
        responses: {},
      },
    },
  },
  components: {
    schemas: {
      ItemInput: {
        type: 'object',
        required: ['title', 'color'],
        properties: {
          title: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[a-z-]+$', 'x-reason': 'title_invalid' },
          color: { $ref: '#/components/schemas/Color' },
          count: { type: 'integer', minimum: 0, 'x-reason': { minimum: 'count_negative', default: 'count_invalid' } },
          size: { type: 'integer', minimum: 1, 'x-reason': { minimum: 'size_too_small' } },
          note: { type: 'string', maxLength: 3 },
        },
      },
      Color: { type: 'string', enum: ['red', 'blue'], 'x-reason': { enum: 'color_unknown', required: 'color_missing' } },
    },
  },
};

/** @param {RecordingLog} log */
function reasonedApp(log) {
  const validateRequest = createRequestValidator(REASONED);
  const app = express();
  app.use(express.json());
  app.use(defaultEmptyBody);
  const router = express.Router();
  /** @param {any} _req @param {any} res */
  const ok = (_req, res) => res.json({ ok: true });
  router.get('/items/:id', validateRequest(), ok);
  router.post('/items', validateRequest(), ok);
  router.post('/parent', validateRequest(), ok);
  router.post('/fallback', validateRequest(), ok);
  app.use('/api/v1/r', router);
  app.use(createErrorHandler(log));
  return app;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{ json?: unknown }} [options]
 */
function callReasoned(method, path, options) {
  return callApp(reasonedApp, method, path, options);
}

/**
 * @param {{ status: number, body: any }} res
 * @param {string} reason
 * @param {{ path: string, rule: string, reason?: string }[]} fields
 */
function assertRefusedAs(res, reason, fields) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: SENTENCE, code: 400, reason, fields });
}

const ITEM = { title: 'pen', color: 'red' };

test('x-reason as a string answers every keyword failing at its node', async () => {
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, title: 5 } }), 'title_invalid',
    [{ path: 'body/title', rule: 'type', reason: 'title_invalid' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, title: 'p' } }), 'title_invalid',
    [{ path: 'body/title', rule: 'minLength', reason: 'title_invalid' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, title: 'Pen' } }), 'title_invalid',
    [{ path: 'body/title', rule: 'pattern', reason: 'title_invalid' }]);
  assert.equal((await callReasoned('POST', '/api/v1/r/items', { json: ITEM })).status, 200, 'the annotation refuses nothing itself');
});

test('x-reason as an object answers per keyword, falls back to default, else to none', async () => {
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, count: -1 } }), 'count_negative',
    [{ path: 'body/count', rule: 'minimum', reason: 'count_negative' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, count: 'x' } }), 'count_invalid',
    [{ path: 'body/count', rule: 'type', reason: 'count_invalid' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, size: 0 } }), 'size_too_small',
    [{ path: 'body/size', rule: 'minimum', reason: 'size_too_small' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, size: 'x' } }), 'validation',
    [{ path: 'body/size', rule: 'type' }]);
});

test('a missing property answers with its own reason, behind a $ref too', async () => {
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { color: 'red' } }), 'title_invalid',
    [{ path: 'body/title', rule: 'required', reason: 'title_invalid' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { title: 'pen' } }), 'color_missing',
    [{ path: 'body/color', rule: 'required', reason: 'color_missing' }]);
});

test('an annotation behind a $ref answers for its own keywords', async () => {
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, color: 'pink' } }), 'color_unknown',
    [{ path: 'body/color', rule: 'enum', reason: 'color_unknown' }]);
});

test('a required entry of the parent wins over the property, and a missing body reads it', async () => {
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/parent', { json: { b: 'x' } }), 'parent_incomplete',
    [{ path: 'body/a', rule: 'required', reason: 'parent_incomplete' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/parent', { json: { a: 1, b: 'x' } }), 'a_invalid',
    [{ path: 'body/a', rule: 'type', reason: 'a_invalid' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/parent'), 'parent_incomplete',
    [{ path: 'body', rule: 'required', reason: 'parent_incomplete' }]);
});

test('the parent string covers its own keywords and a missing property without a reason of its own', async () => {
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/fallback', { json: { c: 'x' } }), 'a_invalid',
    [{ path: 'body/a', rule: 'required', reason: 'a_invalid' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/fallback', { json: { a: 'x' } }), 'whole_invalid',
    [{ path: 'body/c', rule: 'required', reason: 'whole_invalid' }]);
  assertRefusedAs(await callReasoned('POST', '/api/v1/r/fallback', { json: ['x'] }), 'whole_invalid',
    [{ path: 'body', rule: 'type', reason: 'whole_invalid' }]);
});

test('path and query parameters carry their reason, the decimal-integer check too', async () => {
  assertRefusedAs(await callReasoned('GET', '/api/v1/r/items/0'), 'item_id_invalid',
    [{ path: 'path/id', rule: 'minimum', reason: 'item_id_invalid' }]);
  assertRefusedAs(await callReasoned('GET', '/api/v1/r/items/1e2'), 'item_id_invalid',
    [{ path: 'path/id', rule: 'type', reason: 'item_id_invalid' }]);
  assertRefusedAs(await callReasoned('GET', '/api/v1/r/items/1?limit=99'), 'limit_too_high',
    [{ path: 'query/limit', rule: 'maximum', reason: 'limit_too_high' }]);
  assertRefusedAs(await callReasoned('GET', '/api/v1/r/items/1?limit=0x10'), 'limit_invalid',
    [{ path: 'query/limit', rule: 'type', reason: 'limit_invalid' }]);
  assertRefusedAs(await callReasoned('GET', '/api/v1/r/items/1?plain=0x10'), 'validation',
    [{ path: 'query/plain', rule: 'type' }]);
});

test('the first field decides the reason of the answer, a field without one keeps none', async () => {
  assertRefusedAs(await callReasoned('GET', '/api/v1/r/items/0?limit=99'), 'item_id_invalid', [
    { path: 'path/id', rule: 'minimum', reason: 'item_id_invalid' },
    { path: 'query/limit', rule: 'maximum', reason: 'limit_too_high' },
  ]);
  assertRefusedAs(await callReasoned('GET', '/api/v1/r/items/1?plain=0x10&limit=99'), 'validation', [
    { path: 'query/plain', rule: 'type' },
    { path: 'query/limit', rule: 'maximum', reason: 'limit_too_high' },
  ]);
});

test('a malformed x-reason throws when the operation is compiled', () => {
  /** @param {unknown} note @param {'body' | 'path' | 'ref' | 'beside'} where */
  const specWith = (note, where) => {
    const annotated = { type: 'integer', 'x-reason': note };
    return {
      paths: {
        '/api/v1/m/{id}': {
          post: {
            parameters: [{ in: 'path', name: 'id', required: true, schema: where === 'path' ? annotated : { type: 'integer' } }],
            requestBody: {
              content: {
                'application/json': {
                  schema: where === 'body' ? annotated
                    : where === 'beside' ? { $ref: '#/components/schemas/N', 'x-reason': note }
                      : { $ref: '#/components/schemas/N' },
                },
              },
            },
          },
        },
      },
      components: { schemas: { N: where === 'ref' ? annotated : { type: 'integer' } } },
    };
  };
  /** @param {object} spec */
  const compile = (spec) => {
    const middleware = createRequestValidator(spec)();
    middleware({ method: 'POST', baseUrl: '/api/v1/m', route: { path: '/:id' }, params: { id: '1' }, query: {}, body: 1 }, {}, () => {});
  };
  for (const where of /** @type {const} */ (['body', 'path', 'ref'])) {
    for (const note of [7, 'Name_Invalid', 'too short', '', {}, { minimum: 'Too_Small' }, { minimum: 3 }, ['a_b'], { 'not-a-keyword': 'a_b' }]) {
      assert.throws(() => compile(specWith(note, where)), /validateRequest\(\): POST \/api\/v1\/m\/\{id\} does not compile: .*x-reason/,
        `${where}: ${JSON.stringify(note)} passed`);
    }
    assert.doesNotThrow(() => compile(specWith({ minimum: 'too_small', default: 'id_invalid' }, where)), `${where}: a valid annotation`);
  }
  assert.throws(() => compile(specWith('a_b', 'beside')), /x-reason beside a \$ref/);
});

test('with a reason, neither answer nor log carries a value; the log names the reason', async () => {
  const runs = [
    await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, title: `${SECRET}` } }),
    await callReasoned('POST', '/api/v1/r/items', { json: { ...ITEM, color: SECRET } }),
    await callReasoned('GET', `/api/v1/r/items/${SECRET}`),
  ];
  for (const run of runs) {
    assert.equal(run.status, 400, run.text);
    const seen = `${run.text} | ${run.log.join(' | ')}`;
    assert.ok(!seen.includes(SECRET), `a value of the request leaked: ${seen}`);
    assert.ok(!/must (be|have|match|NOT)/.test(seen), `an Ajv message leaked: ${seen}`);
    assert.deepEqual(Object.keys(run.body.fields[0]).sort(), ['path', 'reason', 'rule']);
  }
  const line = runs[0].log.join(' | ');
  assert.ok(line.includes('pattern at body/title as title_invalid'), `the log names rule, path and reason: ${line}`);
});
