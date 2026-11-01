/**
 * Modul: OpenAPI - der Vertrag, gegen den ein nativer Client gebaut wird (Refs #255)
 * Zweck: Die Spec waechst um rund 14 Operationen pro Woche, ein einmaliges
 * Aufraeumen hielte also nicht. Dieser Guard nennt die Operationen, aus denen ein
 * Client seine Modelle erzeugt, und verlangt von jeder drei Dinge: eine
 * `operationId`, eine 2xx-Antwort mit Schema und, wenn sie einen Body nimmt, ein
 * Schema fuer ihn.
 *
 * WARUM NICHT test:openapi-coverage. Der prueft, DASS eine Route dokumentiert ist,
 * nicht ob ein Generator daraus etwas bauen kann. `{ type: 'object' }` ist fuer
 * ihn eine Dokumentation, fuer einen Client ein leeres Modell.
 *
 * "OPAK" HEISST: ein Objekt ohne `properties` und ohne Schema in
 * `additionalProperties`, oder ein Array ohne `items`. Die Pruefung geht durch
 * `$ref`, `allOf`, `oneOf` und `anyOf` bis in jedes Feld und jede 2xx-Antwort.
 * Dazu zaehlen ein kaputter `$ref`, ein unbekannter `type`, `nullable` (in OpenAPI
 * 3.1 entfallen) und `required` auf ein Feld, das es nicht gibt. Felder, die der
 * Client bewusst nicht liest, stehen in CLIENT_OPAQUE_FIELDS mit Begruendung.
 *
 * GEGENPROBE: `operationId` an einer Operation entfernen oder ein Schema durch
 * `{ type: 'object' }` ersetzen macht den ersten Test rot und nennt die Operation.
 *
 * Ausfuehren: npm run test:openapi-client-contract
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenApiSpec } from '../server/openapi.js';
import { CLIENT_OPERATIONS } from './openapi-client-operations.js';

// Der Client liest diese Felder bewusst nicht, ein Schema waere reine Pflege.
// Schluessel: `<METHOD> <Pfad>#<Feldpfad>`.
const CLIENT_OPAQUE_FIELDS = new Map([]);

const spec = buildOpenApiSpec({ protocol: 'http', get: () => 'localhost' }, '0.0.0');

function resolve(schema) {
  let current = schema;
  const seen = new Set();
  while (current?.$ref && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = current.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], spec);
  }
  return current;
}

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** Sammelt die Pfade der Stellen, an denen ein Generator nur "irgendetwas" sieht. */
function opaquePaths(schema, path, out, seen = new Set()) {
  if (schema?.$ref) {
    if (seen.has(schema.$ref)) return out;
    seen.add(schema.$ref);
  }
  const node = resolve(schema);
  if (!node) {
    out.push(`${path} (Ziel fehlt)`);
    return out;
  }
  // `nullable` gibt es in OpenAPI 3.1 nicht mehr, ein Generator liest es nicht.
  if ('nullable' in node) out.push(`${path} (nullable statt null im type)`);
  const unknown = [node.type].flat().filter((type) => type !== undefined && !SCHEMA_TYPES.has(type));
  if (unknown.length) out.push(`${path} (unbekannter type ${unknown.join(', ')})`);

  const missing = (node.required ?? []).filter((name) => !(name in (node.properties ?? {})));
  if (node.properties && missing.length) out.push(`${path} (required ohne Feld: ${missing.join(', ')})`);

  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    if (!node[key]) continue;
    if (node[key].length === 0) out.push(`${path}.${key} (leer)`);
    node[key].forEach((part, i) => opaquePaths(part, `${path}.${key}[${i}]`, out, new Set(seen)));
    // Felder neben `allOf` gehoeren zum selben Objekt und zaehlen mit.
    if (key === 'allOf' && node.properties) {
      for (const [name, property] of Object.entries(node.properties)) {
        opaquePaths(property, `${path}.${name}`, out, new Set(seen));
      }
    }
    return out;
  }
  const types = [node.type].flat();
  if (types.includes('array')) {
    if (!node.items) out.push(`${path}[]`);
    else opaquePaths(node.items, `${path}[]`, out, new Set(seen));
    return out;
  }
  if (types.includes('object') || node.properties) {
    const extra = node.additionalProperties;
    const named = Object.keys(node.properties ?? {}).length > 0;
    if (!named && !(extra && typeof extra === 'object')) {
      out.push(path);
      return out;
    }
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      opaquePaths(property, `${path}.${name}`, out, new Set(seen));
    }
    if (extra && typeof extra === 'object') opaquePaths(extra, `${path}.*`, out, new Set(seen));
    return out;
  }
  if (!node.type && !node.enum && !('const' in node)) out.push(path);
  return out;
}

function jsonSchema(holder) {
  return resolve(holder)?.content?.['application/json']?.schema ?? null;
}

function problemsOf(method, path) {
  const label = `${method.toUpperCase()} ${path}`;
  const operation = spec.paths[path]?.[method];
  if (!operation) return [`${label}: fehlt in der Spec`];
  const problems = [];
  if (!operation.operationId) problems.push(`${label}: keine operationId`);
  else if (!/^[a-z][A-Za-z0-9]+$/.test(operation.operationId)) problems.push(`${label}: operationId nicht camelCase`);

  const declared = new Set((operation.parameters ?? []).map((param) => resolve(param)).filter((param) => param?.in === 'path')
    .map((param) => param.name));
  for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
    if (!declared.has(name)) problems.push(`${label}: Pfadparameter ${name} nicht deklariert`);
  }

  const successes = Object.entries(operation.responses ?? {}).filter(([code]) => /^2/.test(code));
  if (!successes.length) problems.push(`${label}: keine 2xx-Antwort`);
  for (const [status, success] of successes) {
    const schema = jsonSchema(success);
    if (status === '204') {
      if (resolve(success)?.content) problems.push(`${label}: 204 mit Inhalt`);
    } else if (!schema) {
      problems.push(`${label}: ${status} ohne JSON-Schema`);
    } else {
      opaquePaths(schema, 'response', []).forEach((p) => problems.push(`${label}: opak ${p}`));
    }
  }

  if (operation.requestBody) {
    const schema = jsonSchema(operation.requestBody);
    if (!schema) problems.push(`${label}: Body ohne JSON-Schema`);
    else opaquePaths(schema, 'body', []).forEach((p) => problems.push(`${label}: opak ${p}`));
  }
  return problems;
}

test('die Liste nennt jede Operation einmal', () => {
  const keys = CLIENT_OPERATIONS.map(([method, path]) => `${method} ${path}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 39);
});

test('jede Client-Operation hat operationId, typisierte Antwort und typisierten Body', () => {
  const problems = CLIENT_OPERATIONS.flatMap(([method, path]) => problemsOf(method, path))
    .filter((problem) => {
      const [label, rest] = problem.split(': opak ');
      return !rest || !CLIENT_OPAQUE_FIELDS.has(`${label}#${rest}`);
    });
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('die operationId ist in der ganzen Spec eindeutig', () => {
  const ids = Object.values(spec.paths).flatMap((item) => Object.values(item))
    .map((operation) => operation?.operationId).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

test('jede Ausnahme in CLIENT_OPAQUE_FIELDS gehoert zu einer Client-Operation', () => {
  const labels = new Set(CLIENT_OPERATIONS.map(([method, path]) => `${method.toUpperCase()} ${path}`));
  const stale = [...CLIENT_OPAQUE_FIELDS.keys()].filter((key) => !labels.has(key.split('#')[0]));
  assert.deepEqual(stale, []);
});
