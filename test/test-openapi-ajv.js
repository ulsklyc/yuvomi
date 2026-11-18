/**
 * Module: OpenAPI document against real validators (Phase 2, section E, #2810)
 * Purpose: the document from buildOpenApiSpec() is valid OpenAPI 3.1 according
 *          to @seriousme/openapi-schema-validator, and every schema in it
 *          compiles with Ajv (draft 2020-12, strict mode, ajv-formats): each
 *          one under components.schemas and each inline schema of a path -
 *          request bodies, parameters and responses of every status.
 *          No schema carries the OpenAPI 3.0 keywords `nullable` or `example`:
 *          null belongs in the type list, samples in `examples`.
 *          No `pattern` backtracks super-linearly on long adversarial input.
 *          Every `x-reason` annotation (the route's own reason for a schema
 *          refusal, server/api/validate-request.ts) is a reason or an object
 *          of keyword -> reason, each `^[a-z][a-z0-9_]*$`, never beside a
 *          `$ref`; the Ajv here knows the keyword with the runtime's check.
 *          server/openapi.js itself never imports Ajv: it must stay loadable
 *          without node_modules.
 * Run: node --test test/test-openapi-ajv.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { Validator } from '@seriousme/openapi-schema-validator';
import { buildOpenApiSpec } from '../server/openapi.js';
import { X_REASON_KEYWORD } from '../server/api/validate-request.ts';

// ajv-formats is CommonJS: the default import is module.exports, whose
// `.default` is the plugin both at runtime and for the type checker.
const addFormats = ajvFormats.default;

const spec = buildOpenApiSpec({}, '0.0.0');

/**
 * A deep copy of an inline schema whose local `$ref`s point into the
 * document registered under the id `spec`.
 * @param {unknown} schema
 * @returns {object}
 */
function rebase(schema) {
  return JSON.parse(JSON.stringify(schema), (key, value) => (
    key === '$ref' && typeof value === 'string' && value.startsWith('#/') ? `spec${value}` : value
  ));
}

/**
 * Every schema of the document, labelled by where it sits.
 * @returns {{ kind: 'component' | 'body' | 'parameter' | 'response', label: string, schema: object }[]}
 */
function collectSchemas() {
  /** @type {{ kind: 'component' | 'body' | 'parameter' | 'response', label: string, schema: object }[]} */
  const out = [];
  for (const name of Object.keys(spec.components.schemas)) {
    out.push({ kind: 'component', label: `components.schemas.${name}`, schema: { $ref: `spec#/components/schemas/${name}` } });
  }
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      for (const param of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        if (param.schema) out.push({ kind: 'parameter', label: `${where} parameter ${param.in}:${param.name}`, schema: rebase(param.schema) });
      }
      for (const [type, media] of Object.entries(operation.requestBody?.content ?? {})) {
        if (media.schema) out.push({ kind: 'body', label: `${where} requestBody ${type}`, schema: rebase(media.schema) });
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const [type, media] of Object.entries(response.content ?? {})) {
          if (media.schema) out.push({ kind: 'response', label: `${where} response ${status} ${type}`, schema: rebase(media.schema) });
        }
      }
    }
  }
  return out;
}

test('the document is valid OpenAPI 3.1', async () => {
  const validator = new Validator();
  const result = await validator.validate(structuredClone(spec));
  assert.equal(validator.version, '3.1');
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});

test('every schema of the document compiles with Ajv 2020 in strict mode', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  // The components wrapper only makes local $refs resolvable inside one document.
  ajv.addKeyword('components');
  // The annotation x-reason, with the same shape check as at runtime.
  ajv.addKeyword(X_REASON_KEYWORD);
  ajv.addSchema({ $id: 'spec', components: spec.components }, 'spec');

  const schemas = collectSchemas();
  /** @param {string} kind */
  const count = (kind) => schemas.filter((entry) => entry.kind === kind).length;
  assert.ok(count('component') >= 200, `only ${count('component')} component schemas read`);
  assert.ok(count('body') >= 250, `only ${count('body')} request body schemas read`);
  assert.ok(count('parameter') >= 900, `only ${count('parameter')} parameter schemas read`);
  assert.ok(count('response') >= 400, `only ${count('response')} response schemas read`);

  /** @type {string[]} */
  const failures = [];
  for (const { label, schema } of schemas) {
    try {
      ajv.compile(schema);
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  assert.deepEqual(failures, [], 'these schemas fail Ajv strict mode');
});

/**
 * Visits every key of the document - components, request bodies, parameters
 * and responses alike - with its value and the JSON pointer of its parent.
 * @param {(key: string, child: unknown, where: string) => void} visit
 * @param {unknown} [root] another document, for a synthetic case
 */
function walkSpec(visit, root = spec) {
  /**
   * @param {unknown} node
   * @param {string} where
   */
  const walk = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${where}/${index}`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      visit(key, child, where);
      walk(child, `${where}/${key}`);
    }
  };
  walk(root, '#');
}

const REASON = /^[a-z][a-z0-9_]*$/;
const KEYWORD_NAME = /^[a-zA-Z$][a-zA-Z0-9]*$/;

/**
 * Every `x-reason` annotation of a document that has no allowed shape: a
 * reason string, or a non-empty object of keyword -> reason (key `default`
 * included), each reason matching `^[a-z][a-z0-9_]*$`; never beside a `$ref`.
 * A property named `x-reason` (key under `properties`) is no annotation.
 * @param {unknown} root
 * @returns {{ seen: number, wrong: string[] }}
 */
function xReasonFindings(root) {
  let seen = 0;
  /** @type {string[]} */
  const wrong = [];
  walkSpec((key, child, where) => {
    if (key !== 'x-reason' || where.endsWith('/properties')) return;
    seen += 1;
    const at = `${where}/x-reason`;
    if (typeof child === 'string') {
      if (!REASON.test(child)) wrong.push(`${at}: ${JSON.stringify(child)} is no reason`);
      return;
    }
    if (!child || typeof child !== 'object' || Array.isArray(child) || Object.keys(child).length === 0) {
      wrong.push(`${at}: neither a reason nor a non-empty object of keyword -> reason`);
      return;
    }
    for (const [keyword, reason] of Object.entries(child)) {
      if (!KEYWORD_NAME.test(keyword)) wrong.push(`${at}/${keyword}: no keyword name`);
      if (typeof reason !== 'string' || !REASON.test(reason)) wrong.push(`${at}/${keyword}: ${JSON.stringify(reason)} is no reason`);
    }
  }, root);
  walkSpec((key, child, where) => {
    // The `properties` map itself holds property names, not keywords.
    if (key === 'properties' || !child || typeof child !== 'object') return;
    if (Object.hasOwn(child, 'x-reason') && Object.hasOwn(child, '$ref')) {
      wrong.push(`${where}/${key}: x-reason beside a $ref is never read`);
    }
  }, root);
  return { seen, wrong };
}

test('every x-reason of the document has the allowed shape and reasons', () => {
  // The walker on a synthetic document first: the document itself carries no
  // annotation yet (#2810 builds the mechanism only), and a check that reads
  // nothing would pass for that reason alone.
  const synthetic = {
    components: {
      schemas: {
        Good: {
          type: 'object',
          'x-reason': { required: 'good_missing', default: 'good_invalid' },
          properties: { name: { type: 'string', 'x-reason': 'name_too_short' }, 'x-reason': { type: 'string' } },
        },
        Upper: { type: 'string', 'x-reason': 'Name_Invalid' },
        Spaced: { type: 'string', 'x-reason': { minLength: 'too short' } },
        Number: { type: 'string', 'x-reason': 7 },
        Empty: { type: 'string', 'x-reason': {} },
        Ref: { $ref: '#/components/schemas/Good', 'x-reason': 'ref_reason' },
      },
    },
  };
  const probe = xReasonFindings(synthetic);
  assert.equal(probe.seen, 7, 'the walker sees each annotation, and a property named x-reason is none');
  assert.deepEqual(probe.wrong, [
    '#/components/schemas/Upper/x-reason: "Name_Invalid" is no reason',
    '#/components/schemas/Spaced/x-reason/minLength: "too short" is no reason',
    '#/components/schemas/Number/x-reason: neither a reason nor a non-empty object of keyword -> reason',
    '#/components/schemas/Empty/x-reason: neither a reason nor a non-empty object of keyword -> reason',
    '#/components/schemas/Ref: x-reason beside a $ref is never read',
  ]);

  const real = xReasonFindings(spec);
  assert.deepEqual(real.wrong, [], 'these x-reason annotations have no allowed shape');
  // Today the document carries none; the count is printed so a reader of the
  // run sees that the case is the synthetic one above until a schema has one.
  if (real.seen === 0) console.log('# x-reason: the document carries no annotation yet, the shape check ran on the synthetic document only');
});

test('no schema carries the OpenAPI 3.0 keywords nullable or example', () => {
  /** @type {string[]} */
  const found = [];
  walkSpec((key, _child, where) => {
    // `example` beside `schema` on a media type or parameter is valid OpenAPI;
    // only the schema keyword is meant, so only keys inside a schema count,
    // and a property that happens to be named so is no keyword.
    if ((key === 'nullable' || key === 'example') && /\/(schema|schemas\/[^/]+)(\/|$)/.test(where)
      && !where.endsWith('/properties')) {
      found.push(`${where}/${key}`);
    }
  });
  assert.deepEqual(found, [], 'use a type list with "null" instead of nullable, and examples: [...] instead of example');
});

// Request bodies may be 7 MB, and Ajv runs every `pattern` on the raw string
// before any handler sees it. A pattern that backtracks super-linearly (two
// `\s*` around an optional group, nested quantifiers) blocks the single
// event loop for seconds on one request (#2810: 40,000 spaces + "x" took
// 2.5 s). Each probe is 50,000 characters: a linear pattern answers in well
// under 10 ms even on a slow runner, a quadratic one needs seconds. The
// 250 ms budget sits between the two with a margin of more than 25x on both
// sides, so CI noise cannot flip it.
const REDOS_BUDGET_MS = 250;
const REDOS_LENGTH = 50_000;
const REDOS_PROBES = [[' ', 'x'], ['\t', 'x'], ['0', 'x'], ['a', '!'], ['-', 'x'], ['#', 'x'], ['0-', 'x'], ['01-02 ', 'x']]
  .flatMap(([unit, odd]) => {
    const run = unit.repeat(Math.ceil(REDOS_LENGTH / unit.length)).slice(0, REDOS_LENGTH);
    return [run + odd, odd + run];
  });

test('no pattern of the document backtracks super-linearly on long input', () => {
  /** @type {{ pattern: string, where: string }[]} */
  const patterns = [];
  walkSpec((key, child, where) => {
    // A property named `pattern` is an object; the keyword is a string.
    if (key === 'pattern' && typeof child === 'string' && !where.endsWith('/properties')) {
      patterns.push({ pattern: child, where: `${where}/pattern` });
    }
  });
  assert.ok(patterns.length >= 30, `only ${patterns.length} patterns read`);

  /** @type {string[]} */
  const slow = [];
  for (const { pattern, where } of patterns) {
    // Ajv compiles `pattern` with the `u` flag (option unicodeRegExp, on by default).
    const re = new RegExp(pattern, 'u');
    for (const probe of REDOS_PROBES) {
      const start = process.hrtime.bigint();
      re.test(probe);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (ms > REDOS_BUDGET_MS) {
        slow.push(`${where} ${JSON.stringify(pattern)}: ${ms.toFixed(0)} ms on ${JSON.stringify(probe.slice(0, 8))}... (${probe.length} chars)`);
        break;
      }
    }
  }
  assert.deepEqual(slow, [], `these patterns take longer than ${REDOS_BUDGET_MS} ms on a ${REDOS_LENGTH}-character probe`);
});
