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
 * `$ref`, `allOf`, `oneOf` und `anyOf` bis in jedes Feld. Felder, die der Client
 * bewusst nicht liest, stehen in CLIENT_OPAQUE_FIELDS mit Begruendung.
 *
 * GEGENPROBE: `operationId` an einer Operation entfernen oder ein Schema durch
 * `{ type: 'object' }` ersetzen macht den ersten Test rot und nennt die Operation.
 *
 * Ausfuehren: npm run test:openapi-client-contract
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenApiSpec } from '../server/openapi.js';

const CLIENT_OPERATIONS = [
  // Instanz
  ['get', '/api/v1/version'],
  // Anmeldung
  ['post', '/api/v1/auth/login'],
  ['post', '/api/v1/auth/2fa/verify'],
  ['get', '/api/v1/auth/me'],
  ['get', '/api/v1/auth/oidc/config'],
  // Geraete
  ['post', '/api/v1/auth/devices'],
  ['get', '/api/v1/auth/devices'],
  ['delete', '/api/v1/auth/devices/current'],
  ['delete', '/api/v1/auth/devices/{id}'],
  ['post', '/api/v1/auth/devices/pair/redeem'],
  // Uebersicht
  ['get', '/api/v1/dashboard'],
  // Aufgaben
  ['get', '/api/v1/tasks'],
  ['post', '/api/v1/tasks'],
  ['get', '/api/v1/tasks/meta/options'],
  ['get', '/api/v1/tasks/{id}'],
  ['put', '/api/v1/tasks/{id}'],
  ['delete', '/api/v1/tasks/{id}'],
  ['patch', '/api/v1/tasks/{id}/status'],
  ['patch', '/api/v1/tasks/{id}/check'],
  // Einkauf
  ['get', '/api/v1/shopping'],
  ['post', '/api/v1/shopping'],
  ['get', '/api/v1/shopping/versions'],
  ['get', '/api/v1/shopping/suggestions'],
  ['get', '/api/v1/shopping/categories'],
  ['get', '/api/v1/shopping/{listId}/items'],
  ['post', '/api/v1/shopping/{listId}/items'],
  ['patch', '/api/v1/shopping/items/{itemId}'],
  ['delete', '/api/v1/shopping/items/{itemId}'],
  ['delete', '/api/v1/shopping/{listId}/items/checked'],
  // Kalender
  ['get', '/api/v1/calendar'],
  ['post', '/api/v1/calendar'],
  ['get', '/api/v1/calendar/upcoming'],
  ['get', '/api/v1/calendar/calendars'],
  ['get', '/api/v1/calendar/{id}'],
  ['put', '/api/v1/calendar/{id}'],
  ['delete', '/api/v1/calendar/{id}'],
  // Erinnerungen
  ['get', '/api/v1/reminders/upcoming'],
  ['get', '/api/v1/reminders/pending'],
  ['patch', '/api/v1/reminders/{id}/dismiss'],
];

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

/** Sammelt die Pfade der Stellen, an denen ein Generator nur "irgendetwas" sieht. */
function opaquePaths(schema, path, out, seen = new Set()) {
  if (schema?.$ref) {
    if (seen.has(schema.$ref)) return out;
    seen.add(schema.$ref);
  }
  const node = resolve(schema);
  if (!node) return out.concat(`${path} (Ziel fehlt)`);
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    if (node[key]) {
      node[key].forEach((part, i) => opaquePaths(part, `${path}.${key}[${i}]`, out, new Set(seen)));
      return out;
    }
  }
  const types = [node.type].flat();
  if (types.includes('array')) {
    if (!node.items) out.push(`${path}[]`);
    else opaquePaths(node.items, `${path}[]`, out, new Set(seen));
    return out;
  }
  if (types.includes('object') || node.properties) {
    const extra = node.additionalProperties;
    if (!node.properties && !(extra && typeof extra === 'object')) {
      out.push(path);
      return out;
    }
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      opaquePaths(property, `${path}.${name}`, out, new Set(seen));
    }
    if (extra && typeof extra === 'object') opaquePaths(extra, `${path}.*`, out, new Set(seen));
    return out;
  }
  if (!node.type && !node.enum && !node.const) out.push(path);
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

  const [status, success] = Object.entries(operation.responses ?? {}).find(([code]) => /^2/.test(code)) ?? [];
  if (!success) {
    problems.push(`${label}: keine 2xx-Antwort`);
  } else if (status !== '204') {
    const schema = jsonSchema(success);
    if (!schema) problems.push(`${label}: ${status} ohne JSON-Schema`);
    else opaquePaths(schema, 'response', []).forEach((p) => problems.push(`${label}: opak ${p}`));
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
