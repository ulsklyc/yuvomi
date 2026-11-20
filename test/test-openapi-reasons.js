/**
 * Modul: OpenAPI - die `reason`-Werte, die eine Route sendet, stehen an ihrer Operation
 * Zweck: Ein Grund, den der Server schickt und die Spec nicht nennt, existiert
 * fuer einen Integrator nicht (#2002).
 *
 * WARUM DAS EIN EIGENER GUARD IST. Die #1909-Scheiben dokumentieren die Gruende
 * je Operation ueber `withCaseReasons` (server/openapi/helpers.js). Gemessen beim
 * Bau von #2001: den Aufruf zu entfernen liess test:openapi-structure und
 * test:openapi-coverage gruen - beide pruefen, DASS eine Operation steht, nicht
 * WAS sie sagt. Nichts hielt die dokumentierten Gruende.
 *
 * WIE GELESEN WIRD. Dieselben Routen wie test:openapi-coverage (der geteilte
 * Router-Verfolger in test/openapi-routes.js), je Route ihr Handler-Quelltext
 * ohne Kommentare, und darin jedes `reason: '<code>'` - die Form, in der auch
 * test:friendly-error die Routen liest. Ein Grund zaehlt als dokumentiert, wenn
 * er als ganzes Wort irgendwo an seiner Operation steht (Beschreibung oder
 * Antworten).
 *
 * SCHEMA-GRUENDE (#2810): ein `x-reason` im Anfrage-Schema einer Operation
 * (Pfad- und Query-Parameter, Body, `$ref` aufgeloest) sendet validateRequest(),
 * sobald die Regel daneben verletzt ist. Er zaehlt wie ein Grund im Handler und
 * muss ebenso in Beschreibung oder Antworten stehen; die Annotation selbst
 * zaehlt nicht als Doku. Haelt ein synthetischer Fall (das Dokument traegt beim
 * Bau noch keine Annotation).
 *
 * BLINDSTELLEN, bewusst: ein Grund, den ein Helfer ausserhalb des Handlers oder
 * ein Dienst baut (`reason: err.reason`, `WEATHER_REASON.X`), und ein Grund, den
 * eine Middleware vor dem Handler sendet, liegen nicht im gelesenen Text. Der
 * Guard sieht dort weniger, nie Falsches.
 *
 * DAS IST EIN RATCHET. Beim Bau (26.10.2026) sandten 229 Operationen einen
 * Grund; an 68 davon fehlten 82 in der Spec - vor allem die Absagen
 * (`cross_module_access`, `module_access_denied`), die Kategorie-Verwaltung und
 * die Einkaufslisten, die vor #1909 entstanden. Sie stehen unten in
 * UNDOCUMENTED_REASONS, und die Liste darf nur schrumpfen: ein neuer Grund ohne
 * Doku ist rot, und ein Eintrag, der inzwischen dokumentiert ist (oder nicht
 * mehr gesendet wird), ist ebenfalls rot, bis er hier gestrichen ist.
 *
 * LOG-ZEILEN (#2267): ein `reason` in einem Aufruf von `log.*` geht ins Log,
 * nicht an den Client - die Anmeldung schreibt `user_not_found` und
 * `invalid_password` nur dorthin und antwortet beiden gleich. Der Leser nimmt
 * Logger-Aufrufe deshalb vorher heraus. GEGENPROBE (27.10.2026): ohne das
 * Herausnehmen ist der Leser-Test rot und nennt beide Gruende der Anmeldung.
 *
 * GEGENPROBE (26.10.2026): den `withCaseReasons`-Aufruf in
 * server/openapi/paths/recipes.js entfernt - der erste Test wird rot und nennt
 * PUT/DELETE /api/v1/recipes/{id} mit `recipes_recipe_not_found`.
 *
 * Ausfuehren: npm run test:openapi-reasons
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildOpenApiSpec } from '../server/openapi.js';
import { allRoutes } from './openapi-routes.js';
import { withoutCommentsKeepingLines } from './source-text.js';

const spec = buildOpenApiSpec({});

const SENT = /\breason:\s*'([a-z0-9_]+)'/g;
// Ein Aufruf des Loggers bis zu seinem Semikolon: was darin steht, geht ins
// Log, nicht in die Antwort.
const LOG_CALL = /\blog\.(?:debug|info|warn|error)\s*\([^;]*;/g;

function sentReasons(body) {
  return [...new Set([...body.replace(LOG_CALL, '').matchAll(SENT)].map((m) => m[1]))].sort();
}

// Die Annotation selbst ist keine Doku: ein Integrator liest den Grund in der
// Beschreibung oder den Antworten, nicht in einem Schema-Knoten.
function documents(operation, reason) {
  const prose = JSON.stringify(operation ?? {}, (key, value) => (key === 'x-reason' ? undefined : value));
  return new RegExp(`(?<![a-z0-9_])${reason}(?![a-z0-9_])`).test(prose);
}

/**
 * Die Gruende, die das Anfrage-Schema einer Operation als `x-reason` traegt
 * (Pfad- und Query-Parameter, Body; `$ref` aufgeloest): validateRequest()
 * sendet sie, sobald die Regel daneben verletzt ist
 * (server/api/validate-request.ts). Sie zaehlen wie ein Grund im Handler.
 * @param {any} document
 * @param {any} pathItem
 * @param {any} operation
 * @returns {string[]}
 */
function schemaReasons(document, pathItem, operation) {
  /** @type {Set<string>} */
  const found = new Set();
  const seen = new Set();
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [key, child] of Object.entries(node)) {
      // Unter `properties` sind Schluessel Feldnamen, kein Schluesselwort.
      if (key === 'properties' && child && typeof child === 'object') {
        Object.values(child).forEach(walk);
        continue;
      }
      if (key === 'x-reason') {
        for (const reason of typeof child === 'string' ? [child] : Object.values(child ?? {})) {
          if (typeof reason === 'string') found.add(reason);
        }
      } else if (key === '$ref' && typeof child === 'string' && child.startsWith('#/')) {
        walk(child.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
          .reduce((at, part) => at?.[part], document));
      } else {
        walk(child);
      }
    }
  };
  for (const param of [...(pathItem?.parameters ?? []), ...(operation?.parameters ?? [])]) {
    if (param.in === 'path' || param.in === 'query') walk(param.schema);
  }
  for (const media of Object.values(operation?.requestBody?.content ?? {})) walk(media.schema);
  return [...found];
}

/**
 * `METHOD /pfad` -> die gesendeten Gruende, die an der Operation fehlen.
 * @param {{ routes?: { verb: string, path: string, body: string }[], document?: any }} [options]
 *   ein synthetischer Fall gibt eigene Routen und ein eigenes Dokument
 */
function undocumented({ routes = allRoutes(), document = spec } = {}) {
  const out = new Map();
  for (const route of routes) {
    const pathItem = document.paths[route.path];
    const operation = pathItem?.[route.verb];
    const sent = [...new Set([...sentReasons(route.body), ...schemaReasons(document, pathItem, operation)])].sort();
    const missing = sent.filter((reason) => !documents(operation, reason));
    if (!missing.length) continue;
    const label = `${route.verb.toUpperCase()} ${route.path}`;
    out.set(label, [...new Set([...(out.get(label) ?? []), ...missing])].sort());
  }
  return out;
}

/**
 * Heute undokumentiert, Stand 26.10.2026. NUR STREICHEN: wer einen Grund an
 * seiner Operation dokumentiert, nimmt ihn hier heraus - der Test verlangt es.
 */
const UNDOCUMENTED_REASONS = new Map([
]);

test('jeder Grund, den eine Route sendet, steht an ihrer Operation in der Spec', () => {
  const found = undocumented();
  const fresh = [];
  for (const [label, reasons] of found) {
    const known = new Set(UNDOCUMENTED_REASONS.get(label) ?? []);
    for (const reason of reasons) if (!known.has(reason)) fresh.push(`${label}: ${reason}`);
  }
  assert.deepEqual(fresh, [],
    'Diese Routen senden einen `reason`, den ihre Operation in der Spec nicht nennt. Den Grund '
    + 'ueber withCaseReasons (server/openapi/helpers.js) an der Operation dokumentieren:\n  '
    + fresh.join('\n  '));
});

test('die Liste der undokumentierten Gruende schrumpft nur', () => {
  const found = undocumented();
  const stale = [];
  for (const [label, reasons] of UNDOCUMENTED_REASONS) {
    const still = new Set(found.get(label) ?? []);
    for (const reason of reasons) if (!still.has(reason)) stale.push(`${label}: ${reason}`);
  }
  assert.deepEqual(stale, [],
    'Diese Eintraege in UNDOCUMENTED_REASONS sind inzwischen dokumentiert oder werden nicht mehr '
    + 'gesendet - streichen, damit sie nicht als Freibrief stehen bleiben:\n  ' + stale.join('\n  '));
});

test('der Leser findet die Gruende und ordnet sie der richtigen Route zu', () => {
  const routes = allRoutes();
  const withReasons = routes.filter((route) => sentReasons(route.body).length);
  // Gegen einen Guard, der gruen ist, weil er nichts mehr liest.
  assert.ok(withReasons.length > 200,
    `nur ${withReasons.length} Routen mit einem gesendeten Grund - der Leser greift nicht mehr`);
  const body = (verb, path) => routes.find((route) => route.verb === verb && route.path === path)?.body ?? '';
  // Ein Grund aus einer Unterdatei (routes/inventory/) und einer aus einer
  // Fabrik mit eingerueckten Routen (routes/weather.js).
  assert.ok(sentReasons(body('put', '/api/v1/recipes/{id}')).includes('recipes_recipe_not_found'));
  assert.ok(sentReasons(body('post', '/api/v1/inventory/items/{id}/service-log')).includes('inventory_item_not_found'));
  assert.ok(sentReasons(body('get', '/api/v1/weather/geocode')).includes('name_too_short'));
  // Der Kommentar ueber /geocode steht eingerueckt im Bereich von GET /weather;
  // er sendet nichts.
  assert.equal(sentReasons(body('get', '/api/v1/weather')).includes('name_too_short'), false,
    'ein Kommentar zaehlt als gesendeter Grund');
  // Ein `reason` in einer Log-Zeile geht ins Log, nicht an den Client: die
  // Anmeldung antwortet auf unbekanntes Konto und falsches Passwort gleich
  // (401 ohne Grund) und schreibt den Unterschied nur ins Log (#2267).
  const login = sentReasons(body('post', '/api/v1/auth/login'));
  assert.ok(login.includes('account_cannot_sign_in'), 'die Absagen der Anmeldung werden gelesen');
  assert.deepEqual(login.filter((reason) => ['user_not_found', 'invalid_password'].includes(reason)), [],
    'ein Grund aus einer Log-Zeile zaehlt als gesendet');
});

test('ein x-reason im Anfrage-Schema zaehlt als gesendet und braucht Doku an der Operation', () => {
  // Synthetisch: das echte Dokument traegt noch keine Annotation (#2810 baut
  // nur den Mechanismus), ohne diesen Fall waere der Leser ungeprueft.
  /** @type {any} */
  const document = {
    paths: {
      '/api/v1/x/{id}': {
        parameters: [{ in: 'path', name: 'id', schema: { type: 'integer', 'x-reason': 'x_id_invalid' } }],
        post: {
          parameters: [{ in: 'query', name: 'q', schema: { type: 'string', 'x-reason': { maxLength: 'x_query_too_long' } } }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/XInput' } } } },
          responses: { 400: { description: 'Refused' } },
        },
      },
    },
    components: {
      schemas: {
        XInput: {
          type: 'object',
          properties: {
            name: { type: 'string', 'x-reason': { minLength: 'name_too_short', default: 'x_name_invalid' } },
            'x-reason': { type: 'string' },
            tags: { type: 'array', items: { $ref: '#/components/schemas/XTag' } },
          },
        },
        XTag: { type: 'string', 'x-reason': 'x_tag_invalid' },
      },
    },
  };
  const routes = [{ verb: 'post', path: '/api/v1/x/{id}', body: "res.status(404).json({ reason: 'x_not_found' })" }];
  assert.deepEqual(Object.fromEntries(undocumented({ routes, document })), {
    'POST /api/v1/x/{id}': ['name_too_short', 'x_id_invalid', 'x_name_invalid', 'x_not_found', 'x_query_too_long', 'x_tag_invalid'],
  }, 'die Gruende aus Parametern, Body und $ref zaehlen als gesendet, die Annotation allein dokumentiert nicht');

  const operation = document.paths['/api/v1/x/{id}'].post;
  operation.responses[400].description = 'Refused: x_id_invalid, x_query_too_long, name_too_short, x_name_invalid, x_tag_invalid.';
  operation.responses[404] = { description: 'x_not_found' };
  assert.deepEqual(Object.fromEntries(undocumented({ routes, document })), {}, 'in der Prosa genannt, ist jeder Grund dokumentiert');
});

test('withCaseReasons gibt es genau einmal, in server/openapi/helpers.js', () => {
  const dir = new URL('../server/openapi/paths/', import.meta.url);
  const copies = [];
  const unshared = [];
  // .ts too: a path module written in TypeScript (phase 2 onward) is a path module.
  for (const name of readdirSync(dir).filter((file) => /\.(js|ts)$/.test(file))) {
    const src = withoutCommentsKeepingLines(readFileSync(new URL(name, dir), 'utf8'));
    if (/\bfunction\s+withCaseReasons\b|\bwithCaseReasons\s*=/.test(src)) copies.push(name);
    if (/\bwithCaseReasons\s*\(/.test(src) && !/import\s*\{[^}]*\bwithCaseReasons\b[^}]*\}\s*from\s*'\.\.\/helpers\.js'/.test(src)) {
      unshared.push(name);
    }
  }
  assert.deepEqual(copies, [], `eigene Kopie von withCaseReasons statt des geteilten Helfers: ${copies.join(', ')}`);
  assert.deepEqual(unshared, [], `withCaseReasons nicht aus ../helpers.js: ${unshared.join(', ')}`);
});
