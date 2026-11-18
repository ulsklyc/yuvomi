/**
 * Module: request validation against the OpenAPI document (phase 2, section E, #2810)
 * Purpose: validateRequest() is a middleware that checks a request against the
 *          schema of its operation in the OpenAPI document - path, query and a
 *          JSON body - and refuses it with a 400 before the handler runs:
 *            { error, code: 400, reason: 'validation', fields: [{ path, rule }] }
 *          `path` is the place plus a pointer (`body/title`, `query/limit`,
 *          `path/id`), `rule` the Ajv keyword (`type`, `required`, `maxLength`).
 *          Never a value of the request and never a message text of Ajv.
 *
 *          A route hangs it in its own stack:
 *            router.post('/', validateRequest(), handler)
 *          The operation comes from the route, not from an operationId (most
 *          operations have none): `req.baseUrl + req.route.path`, with `:id`
 *          written as `{id}`, plus the method. A route without an operation is
 *          a programming error and throws (500 through the central handler),
 *          it never passes silently.
 *
 *          The checks of an operation are compiled on its first request and
 *          kept per method and pattern, not at server start: the whole
 *          document costs about half a second, and test:openapi-ajv already
 *          holds that every schema of it compiles in strict mode.
 *
 *          Two Ajv instances, both draft 2020-12 in strict mode with
 *          ajv-formats:
 *            - path and query with `coerceTypes: 'array'`, on a COPY of
 *              req.params and req.query (Express 5: req.query is a getter);
 *              the handler keeps reading the strings Express gave it;
 *            - the body without coercion, defaults or removed fields: it stays
 *              byte-equal, a handler may still read the keys that are there.
 *              A body is missing when Express left it undefined or the app's
 *              defaultEmptyBody put `{}` in its place (hadNoBody).
 *          A query array with `style: form, explode: false` is split at the
 *          comma on the copy; another query style, or a parameter given as
 *          `$ref`, throws when the operation is compiled.
 *          Headers are not checked. `allErrors` stays off (Ajv's advice for
 *          untrusted input).
 *
 *          server/openapi.js never imports Ajv (it must load without
 *          node_modules); Ajv lives here.
 */

import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { buildOpenApiSpec } from '../openapi.js';
import { hadNoBody } from '../middleware/empty-body.js';
import { HttpError } from '../utils/http-error.js';

// ajv-formats is CommonJS: the default import is module.exports, whose
// `.default` is the plugin both at runtime and for the type checker.
const addFormats = ajvFormats.default;

const SENTENCE = 'The request does not match the documented schema.';
const MAX_FIELDS = 10;
const MAX_PATH_LENGTH = 120;
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

type Schema = Record<string, unknown>;
type Parameter = { in?: string; name?: string; required?: boolean; schema?: Schema; style?: string; explode?: boolean; $ref?: string };
type MediaType = { schema?: Schema };
type Operation = {
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
};
type PathItem = Record<string, unknown> & { parameters?: Parameter[] };
type OpenApiDocument = { paths?: Record<string, PathItem>; components?: Record<string, unknown> };

type ResolvedOperation = { method: string; path: string; operation: Operation; pathItem: PathItem };
type Field = { path: string; rule: string };

type RouteRequest = {
  method: string;
  baseUrl?: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
};
type Next = (err?: unknown) => void;
type Middleware = (req: RouteRequest, res: unknown, next: Next) => void;

type Checks = {
  path: ValidateFunction | null;
  query: ValidateFunction | null;
  commaLists: string[];
  body: ValidateFunction | null;
  bodyRequired: boolean;
  wildcards: string[];
};

/**
 * The OpenAPI path of an Express pattern under its mount, or null when the
 * pattern names no single path (a regular expression, an optional group).
 */
function openApiPath(mount: string, pattern: unknown): string | null {
  if (typeof pattern !== 'string') return null;
  const converted = pattern
    .replace(/\{\*(\w+)\}/g, ':$1')
    .replace(/:(\w+)/g, '{$1}');
  const full = `${mount}${converted}`.replace(/\/+$/, '');
  return full === '' ? '/' : full;
}

/**
 * A path with its literal parts in lower case and its `{name}`s as they are:
 * Express matches the literal parts case-insensitively, but a parameter name
 * is the key the schema check reads, so it must match exactly.
 */
function folded(path: string): string {
  return path.replace(/\{\w+\}|[^{]+/g, (part) => (part.startsWith('{') ? part : part.toLowerCase()));
}

const pathIndexes = new WeakMap<object, Map<string, string[]>>();

/** The paths of a document by their folded spelling. */
function pathIndex(spec: OpenApiDocument): Map<string, string[]> {
  let index = pathIndexes.get(spec);
  if (!index) {
    index = new Map();
    for (const path of Object.keys(spec.paths ?? {})) {
      const key = folded(path);
      index.set(key, [...(index.get(key) ?? []), path]);
    }
    pathIndexes.set(spec, index);
  }
  return index;
}

/**
 * The operation of the document a route answers: method, mount (`req.baseUrl`)
 * and Express pattern (`req.route.path`) -> exactly one operation, or null.
 * A pattern that names no single path (a regular expression, an optional
 * group) finds none. HEAD falls back to GET, as Express routes it.
 */
export function resolveOperation(spec: OpenApiDocument, method: string, mount: string, pattern: unknown): ResolvedOperation | null {
  const full = openApiPath(mount, pattern);
  if (full === null) return null;
  const candidates = pathIndex(spec).get(folded(full)) ?? [];
  if (candidates.length !== 1) return null;
  const path = candidates[0];
  const pathItem = spec.paths?.[path];
  if (!pathItem) return null;
  const verb = method.toLowerCase();
  for (const name of verb === 'head' ? ['head', 'get'] : [verb]) {
    const operation = pathItem[name];
    if (METHODS.has(name) && operation && typeof operation === 'object') {
      return { method: name, path, operation: operation as Operation, pathItem };
    }
  }
  return null;
}

/** A deep copy of a schema whose local `$ref`s point into the document registered as `spec`. */
function rebase(schema: unknown): Schema {
  return JSON.parse(JSON.stringify(schema), (key, value) => (
    key === '$ref' && typeof value === 'string' && value.startsWith('#/') ? `spec${value}` : value
  ));
}

function newAjv(options: { coerceTypes?: 'array' }, spec: OpenApiDocument): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, ...options });
  addFormats(ajv);
  // The components wrapper only makes local $refs resolvable inside one document.
  ajv.addKeyword('components');
  ajv.addSchema({ $id: 'spec', components: spec.components ?? {} }, 'spec');
  return ajv;
}

/**
 * Path-level parameters, overridden by the operation's own of the same place
 * and name. A parameter given as `$ref` is not resolved (the document has
 * none): it throws instead of being skipped, so no check goes missing silently.
 */
function parametersOf(resolved: ResolvedOperation): Parameter[] {
  const all = [...(resolved.pathItem.parameters ?? []), ...(resolved.operation.parameters ?? [])];
  if (all.some((p) => p.$ref !== undefined)) {
    throw new Error(`validateRequest(): ${resolved.method.toUpperCase()} ${resolved.path} has a parameter given as $ref, which is not supported`);
  }
  const own = resolved.operation.parameters ?? [];
  const shared = (resolved.pathItem.parameters ?? [])
    .filter((p) => !own.some((o) => o.in === p.in && o.name === p.name));
  return [...shared, ...own];
}

/**
 * The query parameters whose array arrives as one comma-separated value
 * (`style: form, explode: false`, e.g. `types=task,event`). Form is the only
 * query style the copy knows; any other would be checked wrongly, so it throws.
 */
function commaListsOf(resolved: ResolvedOperation, parameters: Parameter[]): string[] {
  const query = parameters.filter((p) => p.in === 'query' && typeof p.name === 'string');
  const foreign = query.find((p) => p.style !== undefined && p.style !== 'form');
  if (foreign) {
    throw new Error(`validateRequest(): ${resolved.method.toUpperCase()} ${resolved.path} uses query style ${foreign.style}, only form is supported`);
  }
  const isArray = (schema: Schema | undefined) => {
    const type = schema?.type;
    return type === 'array' || (Array.isArray(type) && type.includes('array'));
  };
  return query.filter((p) => p.explode === false && isArray(p.schema)).map((p) => p.name as string);
}

function compileParameters(ajv: Ajv2020, parameters: Parameter[], place: 'path' | 'query'): ValidateFunction | null {
  const mine = parameters.filter((p) => p.in === place && typeof p.name === 'string' && p.schema);
  if (mine.length === 0) return null;
  const properties: Record<string, Schema> = {};
  for (const p of mine) properties[p.name as string] = rebase(p.schema);
  const required = mine.filter((p) => p.required === true).map((p) => p.name as string);
  return ajv.compile({ type: 'object', properties, ...(required.length ? { required } : {}) });
}

/** One entry of `fields`: place plus pointer, cut to a fixed length, and the keyword. */
function fieldOf(place: string, error: ErrorObject): Field {
  const missing = error.keyword === 'required' ? (error.params as { missingProperty?: unknown }).missingProperty : undefined;
  const pointer = `${error.instancePath}${typeof missing === 'string' ? `/${missing}` : ''}`;
  return { path: `${place}${pointer}`.slice(0, MAX_PATH_LENGTH), rule: error.keyword };
}

function refusal(fields: Field[]): HttpError {
  const unique = fields.filter((f, i) => fields.findIndex((g) => g.path === f.path && g.rule === f.rule) === i);
  return new HttpError(400, SENTENCE, { reason: 'validation', fields: unique.slice(0, MAX_FIELDS) });
}

/**
 * A deep copy of req.params / req.query for coercion, without a prototype (a
 * key `__proto__` stays a key). A wildcard parameter becomes its joined path,
 * a comma list (`explode: false`) its items.
 */
function copyOf(
  source: Record<string, unknown> | undefined,
  { wildcards = [], commaLists = [] }: { wildcards?: string[]; commaLists?: string[] } = {},
): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(source ?? {})) {
    if (wildcards.includes(key) && Array.isArray(value)) copy[key] = value.join('/');
    else if (commaLists.includes(key) && typeof value === 'string') copy[key] = value.split(',');
    else copy[key] = structuredClone(value);
  }
  return copy;
}

/**
 * A validateRequest() for a document handed in as a function, read on the
 * first request that needs it.
 */
function validatorFor(loadSpec: () => OpenApiDocument): () => Middleware {
  let state: { spec: OpenApiDocument; params: Ajv2020; body: Ajv2020 } | null = null;
  const cache = new Map<string, Checks>();

  const checksFor = (req: RouteRequest): Checks => {
    const pattern = req.route?.path;
    if (pattern === undefined) {
      throw new Error('validateRequest() must sit in the stack of a route, not in router.use()');
    }
    const mount = req.baseUrl ?? '';
    const key = `${req.method.toLowerCase()} ${mount.toLowerCase()}${String(pattern)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    state ??= (() => {
      const spec = loadSpec();
      return { spec, params: newAjv({ coerceTypes: 'array' }, spec), body: newAjv({}, spec) };
    })();
    const resolved = resolveOperation(state.spec, req.method, mount, pattern);
    if (!resolved) {
      throw new Error(`validateRequest(): no operation in the OpenAPI document for ${req.method} ${mount}${String(pattern)}`);
    }
    const parameters = parametersOf(resolved);
    const requestBody = resolved.operation.requestBody;
    const bodySchema = requestBody?.content?.['application/json']?.schema;
    const hasBodySchema = !!bodySchema && Object.keys(bodySchema).length > 0;
    const checks: Checks = {
      path: compileParameters(state.params, parameters, 'path'),
      query: compileParameters(state.params, parameters, 'query'),
      commaLists: commaListsOf(resolved, parameters),
      body: hasBodySchema ? state.body.compile(rebase(bodySchema)) : null,
      bodyRequired: hasBodySchema && requestBody?.required === true,
      wildcards: [...String(pattern).matchAll(/\{\*(\w+)\}/g)].map((m) => m[1]),
    };
    cache.set(key, checks);
    return checks;
  };

  return function validateRequest(): Middleware {
    return function validateRequestMiddleware(req, _res, next) {
      const checks = checksFor(req);
      const fields: Field[] = [];
      for (const [place, check, data] of [
        ['path', checks.path, () => copyOf(req.params, { wildcards: checks.wildcards })],
        ['query', checks.query, () => copyOf(req.query, { commaLists: checks.commaLists })],
      ] as const) {
        if (check && !check(data())) fields.push(...(check.errors ?? []).map((e) => fieldOf(place, e)));
      }
      if (checks.body) {
        // server/index.js puts `{}` in place of a missing body (defaultEmptyBody):
        // missing is either, and that `{}` is never held against the schema.
        if (req.body === undefined || hadNoBody(req)) {
          if (checks.bodyRequired) fields.push({ path: 'body', rule: 'required' });
        } else if (!checks.body(req.body)) {
          fields.push(...(checks.body.errors ?? []).map((e) => fieldOf('body', e)));
        }
      }
      if (fields.length > 0) return next(refusal(fields));
      return next();
    };
  };
}

/**
 * validateRequest() against a given document - for tests with a small one.
 * The document is not copied: it must not change after the first request.
 */
export function createRequestValidator(spec: OpenApiDocument): () => Middleware {
  return validatorFor(() => spec);
}

/**
 * validateRequest() against the app's own document, built on the first
 * request that reaches a validated route.
 */
export const validateRequest: () => Middleware = validatorFor(() => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return buildOpenApiSpec(null, pkg.version) as OpenApiDocument;
});
