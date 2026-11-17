/**
 * Module: OpenAPI document against real validators (Phase 2, section E, #2810)
 * Purpose: the document from buildOpenApiSpec() is valid OpenAPI 3.1 according
 *          to @seriousme/openapi-schema-validator, and every schema under
 *          components.schemas compiles with Ajv (draft 2020-12, strict mode,
 *          ajv-formats). Schemas that strict mode rejects today are a named
 *          list that may only shrink: a new failure is red, and so is a listed
 *          entry that compiles by now.
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

/**
 * Schemas that Ajv strict mode rejects today, name -> short reason. The list
 * only shrinks: fix the schema, then delete its entry here.
 * @type {Record<string, string>}
 */
const KNOWN_STRICT_DEFECTS = {
  CalendarImportInput: 'strictRequired: oneOf branch requires "ics" without defining it',
  DevicePairingRequest: 'unknown keyword "example" (OpenAPI-only, not JSON Schema)',
  HealthResponse: 'unknown keyword "example" (OpenAPI-only, not JSON Schema)',
  SystemDiagnostics: 'unknown keyword "example" (OpenAPI-only, not JSON Schema)',
  SystemDiagnosticsResponse: 'unknown keyword "example" (OpenAPI-only, not JSON Schema)',
};

const spec = buildOpenApiSpec({}, '0.0.0');

test('the document is valid OpenAPI 3.1', async () => {
  const validator = new Validator();
  const result = await validator.validate(structuredClone(spec));
  assert.equal(validator.version, '3.1');
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});

test('every component schema compiles with Ajv 2020 in strict mode, apart from the known defects', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  // The components wrapper only makes local $refs resolvable inside one document.
  ajv.addKeyword('components');
  ajv.addSchema({ $id: 'spec', components: spec.components }, 'spec');

  const names = Object.keys(spec.components.schemas);
  assert.ok(names.length >= 200, `only ${names.length} component schemas read`);

  /** @type {Record<string, string>} */
  const failures = {};
  for (const name of names) {
    try {
      ajv.compile({ $ref: `spec#/components/schemas/${name}` });
    } catch (err) {
      failures[name] = err instanceof Error ? err.message : String(err);
    }
  }

  const unexpected = Object.keys(failures).filter((name) => !(name in KNOWN_STRICT_DEFECTS));
  assert.deepEqual(unexpected.map((name) => `${name}: ${failures[name]}`), [],
    'these schemas fail Ajv strict mode and are not in KNOWN_STRICT_DEFECTS');

  const healed = Object.keys(KNOWN_STRICT_DEFECTS).filter((name) => !(name in failures));
  assert.deepEqual(healed, [],
    'these schemas compile by now (or no longer exist): delete them from KNOWN_STRICT_DEFECTS');
});
