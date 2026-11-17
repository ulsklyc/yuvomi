/**
 * Module: OpenAPI document against real validators (Phase 2, section E, #2810)
 * Purpose: the document from buildOpenApiSpec() is valid OpenAPI 3.1 according
 *          to @seriousme/openapi-schema-validator, and every schema in it
 *          compiles with Ajv (draft 2020-12, strict mode, ajv-formats): each
 *          one under components.schemas and each inline schema of a path -
 *          request bodies, parameters and responses of every status.
 *          No schema carries the OpenAPI 3.0 keywords `nullable` or `example`:
 *          null belongs in the type list, samples in `examples`.
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

test('no schema carries the OpenAPI 3.0 keywords nullable or example', () => {
  /** @type {string[]} */
  const found = [];
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
      // `example` beside `schema` on a media type or parameter is valid OpenAPI;
      // only the schema keyword is meant, so only keys inside a schema count,
      // and a property that happens to be named so is no keyword.
      if ((key === 'nullable' || key === 'example') && /\/(schema|schemas\/[^/]+)(\/|$)/.test(where)
        && !where.endsWith('/properties')) {
        found.push(`${where}/${key}`);
      }
      walk(child, `${where}/${key}`);
    }
  };
  walk(spec, '#');
  assert.deepEqual(found, [], 'use a type list with "null" instead of nullable, and examples: [...] instead of example');
});
