/**
 * Test: Echte Antworten gegen die Schemas des Client-Vertrags (Refs #255)
 *
 * Zweck: `test:openapi-client-contract` prueft, dass ein Schema da ist, nicht ob es
 *        stimmt. Ein erzeugtes Modell, das am ersten echten Datensatz scheitert,
 *        ist schlimmer als keines. Diese Suite faehrt jede Lese- und Schreib-
 *        Operation des Vertrags gegen einen echten Server und haelt die Antwort
 *        gegen die Spec. Felder, die das Schema nicht nennt, sind rot.
 *
 * Ausfuehren: npm run test:openapi-client-responses
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';
import { schemaProblems } from './openapi-schema-check.js';
import { buildOpenApiSpec } from '../server/openapi.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'openapi-client-responses',
  env: { SESSION_SECRET: 'test-openapi-client-responses-min32chars', RATE_LIMIT_MAX_ATTEMPTS: 200 },
});

const API = `${BASE}/api/v1`;
const json = { 'Content-Type': 'application/json' };
const spec = buildOpenApiSpec({ protocol: 'http', get: () => 'localhost' }, '0.0.0');

await fetch(`${API}/auth/setup`, {
  method: 'POST', headers: json, body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: json, body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
});
const cookie = cookieHeader(loginRes.headers.get('set-cookie'));
const { csrfToken } = await (await fetch(`${API}/auth/me`, { headers: { Cookie: cookie } })).json();
const session = { ...json, Cookie: cookie, 'X-CSRF-Token': csrfToken };

/**
 * Ruft eine Operation auf und prueft die Antwort gegen ihr Schema.
 * @param {string} method klein, wie in der Spec
 * @param {string} template der Pfad der Spec, etwa `/api/v1/tasks/{id}`
 * @param {object} [options] `params` fuer den Pfad, `query`, `body`, `headers`, `ignore`
 * @returns die geparste Antwort, fuer den naechsten Schritt
 */
async function call(method, template, { params = {}, query = '', body, headers = session, ignore = [] } = {}) {
  const label = `${method.toUpperCase()} ${template}`;
  const path = template.replace(/\{(\w+)\}/g, (_, name) => params[name]);
  const res = await fetch(`${BASE}${path}${query}`, {
    method: method.toUpperCase(), headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  const response = spec.paths[template]?.[method]?.responses?.[res.status];
  assert.ok(response, `${label}: Status ${res.status} nicht in der Spec. ${text.slice(0, 200)}`);
  assert.ok(res.status < 300, `${label}: ${res.status} ${text.slice(0, 200)}`);
  const resolved = response.$ref
    ? response.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], spec)
    : response;
  const schema = resolved.content?.['application/json']?.schema;
  assert.ok(schema, `${label}: ${res.status} ohne Schema`);
  assert.deepEqual(schemaProblems(spec, schema, data, '$', { ignore }), [], label);
  return data;
}

// Die Abschnitte fuellen je Modul die Fixtures und rufen `call()`. Sie teilen sich
// den Server, jeder legt seine Daten selbst an.

// --- Anmeldung, Geraete, Instanz, Uebersicht, Erinnerungen ---

// --- Aufgaben, Kalender ---

// --- Einkauf ---

test('die Spec ist geladen', () => assert.ok(spec.paths['/api/v1/tasks']));
