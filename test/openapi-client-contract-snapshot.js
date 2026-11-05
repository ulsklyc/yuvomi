/**
 * Was eine installierte App aus den Antworten der Client-Operationen liest: die
 * Operationen, die Pflichtfelder und die Enum-Werte jeder 2xx-Antwort. Die Liste
 * liegt in `openapi-client-contract.json`, `test:openapi-client-contract` vergleicht
 * sie mit der Spec (DECISIONS 18, "Der Client-Vertrag waechst nur").
 *
 * Die Pfade gehen durch `$ref` hindurch. `allOf` beschreibt dasselbe Objekt und
 * bekommt deshalb keinen eigenen Pfadteil, `oneOf` und `anyOf` bekommen den Index
 * des Zweigs. Ein Feld ist `.name`, ein Array-Element `[]`, ein freier Schluessel `.*`.
 *
 * Nachziehen, nachdem die Aenderung bewusst entschieden ist:
 *   node test/openapi-client-contract-snapshot.js --write
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiSpec } from '../server/openapi.js';
import { CLIENT_OPERATIONS } from './openapi-client-operations.js';

export const SNAPSHOT_FILE = fileURLToPath(new URL('./openapi-client-contract.json', import.meta.url));

function resolver(spec) {
  return (schema) => {
    let current = schema;
    const seen = new Set();
    while (current?.$ref && !seen.has(current.$ref)) {
      seen.add(current.$ref);
      current = current.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], spec);
    }
    return current;
  };
}

function collect(schema, path, out, resolve, seen) {
  if (schema?.$ref) {
    if (seen.has(schema.$ref)) return;
    seen = new Set(seen).add(schema.$ref);
  }
  const node = resolve(schema);
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node.enum)) {
    for (const value of node.enum) out.enums.push(`${path} = ${JSON.stringify(value)}`);
  }
  if ('const' in node) out.enums.push(`${path} = ${JSON.stringify(node.const)}`);
  for (const name of node.required ?? []) out.required.push(`${path}.${name}`);

  (node.allOf ?? []).forEach((part) => collect(part, path, out, resolve, seen));
  for (const key of ['oneOf', 'anyOf']) {
    (node[key] ?? []).forEach((part, i) => collect(part, `${path}.${key}[${i}]`, out, resolve, seen));
  }
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    collect(property, `${path}.${name}`, out, resolve, seen);
  }
  if (node.items) collect(node.items, `${path}[]`, out, resolve, seen);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    collect(node.additionalProperties, `${path}.*`, out, resolve, seen);
  }
}

/** Baut den Vertrag aus einer Spec: `{ "<METHOD> <Pfad>": { required, enums } }`. */
export function buildClientContract(spec, operations = CLIENT_OPERATIONS) {
  const resolve = resolver(spec);
  const contract = {};
  for (const [method, path] of operations) {
    const operation = spec.paths[path]?.[method];
    if (!operation) continue;
    const out = { required: [], enums: [] };
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (!/^2/.test(status)) continue;
      const schema = resolve(response)?.content?.['application/json']?.schema;
      if (schema) collect(schema, `response ${status}`, out, resolve, new Set());
    }
    contract[`${method.toUpperCase()} ${path}`] = {
      required: [...new Set(out.required)].sort(),
      enums: [...new Set(out.enums)].sort(),
    };
  }
  return contract;
}

export function currentSpec() {
  return buildOpenApiSpec({ protocol: 'http', get: () => 'localhost' }, '0.0.0');
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(buildClientContract(currentSpec()), null, 2)}\n`);
  console.log(`geschrieben: ${SNAPSHOT_FILE}`);
}
