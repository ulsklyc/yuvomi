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

function sentReasons(body) {
  return [...new Set([...body.matchAll(SENT)].map((m) => m[1]))].sort();
}

function documents(operation, reason) {
  return new RegExp(`(?<![a-z0-9_])${reason}(?![a-z0-9_])`).test(JSON.stringify(operation ?? {}));
}

/** `METHOD /pfad` -> die gesendeten Gruende, die an der Operation fehlen. */
function undocumented() {
  const out = new Map();
  for (const route of allRoutes()) {
    const operation = spec.paths[route.path]?.[route.verb];
    const missing = sentReasons(route.body).filter((reason) => !documents(operation, reason));
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
  ['POST /api/v1/auth/2fa/disable', ['invalid_code', 'not_enabled']],
  ['POST /api/v1/auth/2fa/enable', ['invalid_code']],
  ['POST /api/v1/auth/2fa/recovery-codes', ['invalid_code', 'not_enabled']],
  ['POST /api/v1/auth/api-tokens', ['account_deactivated']],
  ['POST /api/v1/auth/login', ['account_cannot_sign_in', 'invalid_password', 'password_login_disabled', 'user_not_found']],
  ['POST /api/v1/auth/logout-others', ['browser_session_required']],
  ['GET /api/v1/auth/oidc/callback', ['user_gone']],
  ['POST /api/v1/auth/setup', ['setup_completed']],
  ['PATCH /api/v1/auth/users/{id}', ['account_deactivated']],
  ['POST /api/v1/birthdays/import', ['cross_module_access']],
  ['GET /api/v1/birthdays/import/candidates', ['cross_module_access']],
  ['POST /api/v1/budget/categories', ['category_exists']],
  ['POST /api/v1/budget/categories/{categoryKey}/subcategories', ['subcategory_exists']],
  ['DELETE /api/v1/budget/categories/{key}', ['category_in_use', 'category_last']],
  ['PUT /api/v1/budget/categories/{key}', ['category_exists']],
  ['DELETE /api/v1/budget/categories/{key}/subcategories/{subKey}', ['subcategory_in_use', 'subcategory_last']],
  ['PUT /api/v1/budget/categories/{key}/subcategories/{subKey}', ['subcategory_exists']],
  ['POST /api/v1/calendar/calendars', ['cross_module_access']],
  ['PATCH /api/v1/calendar/calendars/reorder', ['cross_module_access']],
  ['DELETE /api/v1/calendar/calendars/{id}', ['cross_module_access']],
  ['PUT /api/v1/calendar/calendars/{id}', ['cross_module_access']],
  ['GET /api/v1/calendar/sync-targets', ['cross_module_access']],
  ['POST /api/v1/contacts/categories', ['category_exists']],
  ['DELETE /api/v1/contacts/categories/{key}', ['category_in_use', 'category_last']],
  ['PUT /api/v1/contacts/categories/{key}', ['category_exists']],
  ['DELETE /api/v1/contacts/{id}', ['family_member_contact']],
  ['PUT /api/v1/contacts/{id}', ['contact_email_protected']],
  ['GET /api/v1/contacts/{id}/vcard', ['contacts_contact_not_found']],
  ['GET /api/v1/displays/people', ['display_only']],
  ['PUT /api/v1/health/caregivers/{subjectId}', ['account_deactivated']],
  ['POST /api/v1/housekeeping/supply-requests', ['cross_module_access']],
  ['GET /api/v1/inventory/items/{id}/history', ['inventory_item_not_found']],
  ['GET /api/v1/inventory/items/{id}/service-log', ['inventory_item_not_found']],
  ['POST /api/v1/inventory/items/{id}/service-log', ['inventory_item_not_found']],
  ['DELETE /api/v1/inventory/items/{id}/service-log/{logId}', ['inventory_item_not_found']],
  ['PUT /api/v1/inventory/items/{id}/service-log/{logId}', ['inventory_item_not_found']],
  ['POST /api/v1/meals/week-to-shopping-list', ['cross_module_access']],
  ['POST /api/v1/meals/{id}/to-shopping-list', ['cross_module_access']],
  ['POST /api/v1/pantry/import-shopping', ['cross_module_access']],
  ['DELETE /api/v1/recipes/{id}', ['recipe_mirrored']],
  ['PUT /api/v1/recipes/{id}', ['recipe_mirrored']],
  ['PUT /api/v1/recipes/{id}/ingredient-match', ['cross_module_access']],
  ['POST /api/v1/recipes/{id}/to-shopping-list', ['cross_module_access']],
  ['DELETE /api/v1/reminders', ['module_access_denied']],
  ['GET /api/v1/reminders', ['module_access_denied']],
  ['POST /api/v1/reminders', ['module_access_denied']],
  ['PUT /api/v1/reminders', ['module_access_denied']],
  ['GET /api/v1/reminders/all', ['module_access_denied']],
  ['DELETE /api/v1/reminders/{id}', ['module_access_denied']],
  ['PATCH /api/v1/reminders/{id}/dismiss', ['module_access_denied']],
  ['POST /api/v1/shopping/items/undo-transfer', ['cross_module_access']],
  ['DELETE /api/v1/shopping/items/{itemId}', ['shopping_item_not_found']],
  ['DELETE /api/v1/shopping/{listId}', ['shopping_list_not_found']],
  ['PUT /api/v1/shopping/{listId}', ['shopping_list_not_found']],
  ['POST /api/v1/shopping/{listId}/duplicate', ['shopping_list_not_found']],
  ['POST /api/v1/shopping/{listId}/import-meal-plan', ['cross_module_access', 'shopping_list_not_found']],
  ['POST /api/v1/shopping/{listId}/import-pantry', ['cross_module_access', 'shopping_list_not_found']],
  ['GET /api/v1/shopping/{listId}/items', ['shopping_list_not_found']],
  ['POST /api/v1/shopping/{listId}/items', ['shopping_list_not_found']],
  ['PATCH /api/v1/shopping/{listId}/items/reorder', ['shopping_list_not_found']],
  ['POST /api/v1/shopping/{listId}/send', ['nothing_open', 'recipient_no_email', 'shopping_list_not_found', 'smtp_unconfigured']],
  ['POST /api/v1/split-expenses/groups/{id}/members', ['cross_module_access']],
  ['POST /api/v1/tasks/categories', ['category_exists']],
  ['DELETE /api/v1/tasks/categories/{key}', ['category_in_use', 'category_last']],
  ['PUT /api/v1/tasks/categories/{key}', ['category_exists']],
  ['GET /api/v1/tasks/sync-targets', ['cross_module_access']],
  ['GET /api/v1/tasks/{id}/documents', ['cross_module_access']],
  ['PATCH /api/v1/tasks/{id}/status', ['display_action']],
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
});

test('withCaseReasons gibt es genau einmal, in server/openapi/helpers.js', () => {
  const dir = new URL('../server/openapi/paths/', import.meta.url);
  const copies = [];
  const unshared = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.js'))) {
    const src = withoutCommentsKeepingLines(readFileSync(new URL(name, dir), 'utf8'));
    if (/\bfunction\s+withCaseReasons\b|\bwithCaseReasons\s*=/.test(src)) copies.push(name);
    if (/\bwithCaseReasons\s*\(/.test(src) && !/import\s*\{[^}]*\bwithCaseReasons\b[^}]*\}\s*from\s*'\.\.\/helpers\.js'/.test(src)) {
      unshared.push(name);
    }
  }
  assert.deepEqual(copies, [], `eigene Kopie von withCaseReasons statt des geteilten Helfers: ${copies.join(', ')}`);
  assert.deepEqual(unshared, [], `withCaseReasons nicht aus ../helpers.js: ${unshared.join(', ')}`);
});
