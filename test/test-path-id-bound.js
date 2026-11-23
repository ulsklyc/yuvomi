/**
 * Test: numeric path ids end at Number.MAX_SAFE_INTEGER (#2810, phase 2 section E)
 * Purpose: a path id above 2^53-1 is no longer the id the client sent once
 *          JavaScript reads it, and a run of some hundred digits reads as
 *          Infinity. The OpenAPI document gives every integer path parameter
 *          `maximum: 9007199254740991` through idParam() in
 *          server/openapi/helpers.js, without a `minimum` (0 and a negative id
 *          stay the route's own answer), and validateRequest() refuses a value
 *          Ajv would turn into Infinity (Ajv skips `maximum` for it).
 *
 *          Part one, the document: every path parameter of type integer
 *          carries exactly that bound and no lower one.
 *
 *          Part two, the routes: every route file that carries
 *          validateRequest() is mounted at its real prefix, its routes are
 *          read from the router stacks at runtime, and every route with an
 *          integer path parameter is asked three times per parameter:
 *            - 9007199254740992 -> 400 with a field `path/<name>`, rule `maximum`;
 *            - 400 digits       -> 400 with a field `path/<name>`, rule `type`;
 *            - 9007199254740991 -> no field on that parameter, and no 500: it
 *              reaches the handler (or another check of the request).
 *          Each migrated file with an integer path parameter must have been
 *          asked at least once, and the files without one are named.
 * Run: npm run test:path-id-bound
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-path-id-bound-');
for (const key of ['IMMICH_URL', 'IMMICH_API_KEY', 'IMMICH_SCREENSAVER_ALBUM_ID']) delete process.env[key];

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const { resolveOperation } = await import('../server/api/validate-request.ts');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const db = dbmod.get();

const MAX = '9007199254740991';
const ABOVE = '9007199254740992';
const HUGE = '9'.repeat(400);

const ADMIN = Number(db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('linda', 'linda', 'x', 'admin', 'mom')
`).run().lastInsertRowid);

/**
 * The route files that carry validateRequest(), at the prefix server/index.js
 * (or server/routes/inventory/index.js) mounts them under. `exports` names the
 * routers of a file; the default export unless said otherwise.
 * @type {Array<{ file: string, mount: string, exports?: string[] }>}
 */
const MOUNTS = [
  { file: 'notes.js', mount: '/api/v1/notes' },
  { file: 'birthdays.js', mount: '/api/v1/birthdays' },
  { file: 'quick-links.js', mount: '/api/v1/quick-links' },
  { file: 'reminders.js', mount: '/api/v1/reminders' },
  { file: 'notifications.js', mount: '/api/v1/notifications' },
  { file: 'modules.js', mount: '/api/v1/modules' },
  { file: 'permissions.js', mount: '/api/v1/permissions' },
  { file: 'email.js', mount: '/api/v1/email' },
  { file: 'weather.js', mount: '/api/v1/weather' },
  { file: 'family.js', mount: '/api/v1/family' },
  { file: 'people.js', mount: '/api/v1/people' },
  { file: 'search.js', mount: '/api/v1/search' },
  { file: 'kitchen.js', mount: '/api/v1/kitchen' },
  { file: 'screensaver.js', mount: '/api/v1/screensaver' },
  { file: 'displays.js', mount: '/api/v1/displays', exports: ['pairingRouter', 'peopleRouter', 'default'] },
  { file: 'recipes.js', mount: '/api/v1/recipes' },
  { file: 'recipe-providers.js', mount: '/api/v1/recipe-providers' },
  { file: 'pantry.js', mount: '/api/v1/pantry' },
  { file: 'inventory/locations.js', mount: '/api/v1/inventory/locations' },
  { file: 'inventory/categories.js', mount: '/api/v1/inventory/categories' },
  { file: 'inventory/items.js', mount: '/api/v1/inventory/items' },
  { file: 'inventory/entries.js', mount: '/api/v1/inventory/entries' },
  { file: 'inventory/deadlines-feed.js', mount: '/api/v1/inventory/deadlines-feed' },
  { file: 'housekeeping.js', mount: '/api/v1/housekeeping' },
  { file: 'rewards.js', mount: '/api/v1/rewards' },
  { file: 'waste/types.js', mount: '/api/v1/waste/types' },
  { file: 'waste/schedules.js', mount: '/api/v1/waste/schedules' },
  { file: 'waste/pickups.js', mount: '/api/v1/waste/pickups' },
  { file: 'waste/occurrences.js', mount: '/api/v1/waste/occurrences' },
  { file: 'waste/sources.js', mount: '/api/v1/waste/sources' },
  { file: 'waste/import.js', mount: '/api/v1/waste/import' },
  { file: 'waste/reminder-settings.js', mount: '/api/v1/waste/reminder-settings' },
  { file: 'waste/feed.js', mount: '/api/v1/waste/feed' },
  // In der Reihenfolge von server/index.js: die Unterpfade vor /schedule.
  { file: 'schedule-feed.js', mount: '/api/v1/schedule/feed' },
  { file: 'schedule-preferences.js', mount: '/api/v1/schedule/preferences' },
  { file: 'schedule-extras.js', mount: '/api/v1/schedule/extras' },
  { file: 'schedule.js', mount: '/api/v1/schedule' },
  { file: 'split-expenses.js', mount: '/api/v1/split-expenses' },
  { file: 'backup.js', mount: '/api/v1/backup' },
  { file: 'system.js', mount: '/api/v1/system' },
  { file: 'changelog.js', mount: '/api/v1/changelog' },
  // Gesundheit: die zwoelf Unterrouter haengen ohne eigenen Pfad unter
  // /api/v1/health (server/routes/health.js), in dessen Reihenfolge.
  ...['vitals', 'medications', 'labs', 'activities', 'export', 'cycle', 'cycle-feed', 'caregivers',
    'visibility-defaults', 'fasting', 'prevention', 'nutrition'].map((name) => ({ file: `health/${name}.js`, mount: '/api/v1/health' })),
  // In der Reihenfolge von server/index.js: CardDAV vor den Kontakten.
  { file: 'meals.js', mount: '/api/v1/meals' },
  { file: 'cardav.js', mount: '/api/v1/contacts/cardav' },
  { file: 'contacts.js', mount: '/api/v1/contacts' },
  // In der Reihenfolge von server/index.js: Google Drive und DMS vor den
  // Dokumenten (sonst faenge `/:id/thumbnail` den DMS-Pfad `/dms/thumbnail`).
  { file: 'shopping.js', mount: '/api/v1/shopping' },
  { file: 'document-storage-google-drive.js', mount: '/api/v1/documents/storage/google-drive' },
  { file: 'dms.js', mount: '/api/v1/documents/dms' },
  { file: 'documents.js', mount: '/api/v1/documents' },
  // In der Reihenfolge von server/index.js: die Abos VOR dem Budget (sonst
  // faenge `/:id` der Buchungen `/subscriptions/...`), die sieben Budget-
  // Router in der Reihenfolge von server/routes/budget.js.
  { file: 'subscriptions.js', mount: '/api/v1/budget/subscriptions' },
  ...['categories', 'loans', 'accounts', 'plans', 'stats', 'transfers', 'entries']
    .map((name) => ({ file: `budget/${name}.js`, mount: '/api/v1/budget' })),
  // In der Reihenfolge von server/index.js: die Uebersicht, dann die zehn
  // Kalender-Router (Gruppen 10a und 10b) in der Reihenfolge von
  // server/routes/calendar.js (die Termine mit `/:id` nach allen
  // Einsegment-Pfaden, CalDAV und Outlook mit ihren Mehrsegment-Pfaden
  // danach). Ein unbekanntes Konto antwortet dort 404 (#2810, Entscheidung 11).
  { file: 'dashboard.js', mount: '/api/v1/dashboard' },
  // Die Aufgaben (Gruppe 11a) stehen in server/index.js gleich hinter der
  // Uebersicht; die festen Pfade vor `/:id`.
  { file: 'tasks.js', mount: '/api/v1/tasks' },
  ...['read', 'google', 'apple', 'subscriptions', 'feed', 'local-calendars', 'sync-targets', 'crud', 'caldav', 'outlook']
    .map((name) => ({ file: `calendar/${name}.js`, mount: '/api/v1/calendar' })),
];

/** Migrated files whose routes have no integer path parameter (a text key, or none at all). */
const WITHOUT_INTEGER_PATH_ID = [
  'budget/categories.js', 'budget/plans.js', 'budget/stats.js',
  'email.js', 'family.js', 'inventory/categories.js', 'inventory/deadlines-feed.js', 'kitchen.js',
  'modules.js', 'schedule-feed.js', 'schedule-preferences.js', 'screensaver.js', 'search.js',
  'waste/feed.js', 'waste/import.js', 'waste/occurrences.js', 'weather.js',
  'backup.js', 'system.js', 'changelog.js',
  'health/export.js', 'health/cycle-feed.js', 'health/visibility-defaults.js',
  'document-storage-google-drive.js',
  'dashboard.js', 'calendar/read.js', 'calendar/feed.js', 'calendar/sync-targets.js',
  'calendar/google.js', 'calendar/apple.js',
];

const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));

const app = express();
app.use(express.json());
app.use(defaultEmptyBody);
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  req.authUserId = ADMIN;
  req.authRole = 'admin';
  req.authMethod = 'session';
  req.session = { userId: ADMIN, role: 'admin', destroy: (/** @type {(err?: unknown) => void} */ done) => done() };
  next();
});

/**
 * Every route of the mounted routers: file, method, Express pattern, mount.
 * @type {Array<{ file: string, method: string, pattern: string, mount: string }>}
 */
const routes = [];
for (const { file, mount, exports = ['default'] } of MOUNTS) {
  const mod = await import(`../server/routes/${file}`);
  for (const name of exports) {
    const router = mod[name];
    assert.equal(typeof router, 'function', `${file} exports ${name}`);
    app.use(mount, router);
    for (const layer of router.stack) {
      if (!layer.route || typeof layer.route.path !== 'string') continue;
      for (const method of Object.keys(layer.route.methods).filter((m) => layer.route.methods[m])) {
        routes.push({ file, method, pattern: layer.route.path, mount });
      }
    }
  }
}
/** @type {string[]} */
const errorLog = [];
app.use(createErrorHandler({ warn: () => {}, error: (/** @type {string} */ line) => { errorLog.push(line); } }));

const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => {
  server.close();
});

/**
 * The path parameters of an operation whose schema type is integer.
 * @param {any} operation
 * @param {any} pathItem
 * @returns {any[]}
 */
function integerPathParams(operation, pathItem) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .filter((p) => p.in === 'path' && p.schema?.type === 'integer');
}

/**
 * The cases: one per route and integer path parameter.
 * @type {Array<{ file: string, method: string, pattern: string, mount: string, name: string }>}
 */
const cases = [];
for (const route of routes) {
  const resolved = resolveOperation(spec, route.method, route.mount, route.pattern);
  assert.ok(resolved, `${route.method.toUpperCase()} ${route.mount}${route.pattern} has an operation`);
  for (const p of integerPathParams(resolved.operation, resolved.pathItem)) cases.push({ ...route, name: p.name });
}

/**
 * The URL of a route with `name` set to `value` and every other parameter to a
 * valid stand-in (`1` for a number, `x` for text, `a` for a wildcard).
 * @param {{ pattern: string, mount: string }} route
 * @param {string} name
 * @param {string} value
 */
function urlOf({ pattern, mount }, name, value) {
  const path = pattern
    .replace(/\{\*(\w+)\}/g, 'a')
    .replace(/:(\w+)/g, (_m, param) => (param === name ? value : (/id$/i.test(param) ? '1' : 'x')));
  return `${baseUrl}${mount}${path}`;
}

/**
 * @param {string} method
 * @param {string} url
 */
async function call(method, url) {
  const res = await fetch(url, { method: method.toUpperCase(), headers: { 'Content-Type': 'application/json' }, body: method === 'get' || method === 'head' ? undefined : '{}' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

test('the document: every integer path parameter ends at Number.MAX_SAFE_INTEGER, with no lower bound', () => {
  let seen = 0;
  const wrong = [];
  for (const [path, item] of Object.entries(/** @type {Record<string, any>} */ (spec.paths))) {
    for (const [method, operation] of Object.entries(item)) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
      for (const p of integerPathParams(operation, method === 'parameters' ? {} : item)) {
        seen++;
        if (p.schema.maximum !== Number.MAX_SAFE_INTEGER || 'minimum' in p.schema || 'exclusiveMaximum' in p.schema) {
          wrong.push(`${method.toUpperCase()} ${path} {${p.name}}: ${JSON.stringify(p.schema)}`);
        }
      }
    }
  }
  assert.ok(seen > 250, `${seen} integer path parameters read`);
  assert.deepEqual(wrong, [], 'an integer path id goes through idParam() in server/openapi/helpers.js');
});

test('the routes: every migrated file with an integer path id is asked, the others are named', () => {
  const asked = new Set(cases.map((c) => c.file));
  const files = MOUNTS.map((m) => m.file);
  assert.deepEqual(files.filter((f) => !asked.has(f)).sort(), [...WITHOUT_INTEGER_PATH_ID].sort());
  assert.ok(cases.length >= 50, `${cases.length} cases`);
});

test('a path id above the bound is a 400 before the handler, the bound itself is not', async () => {
  const failures = [];
  for (const c of cases) {
    const where = `${c.method.toUpperCase()} ${c.mount}${c.pattern} {${c.name}}`;
    const field = `path/${c.name}`;
    for (const [value, rule] of /** @type {const} */ ([[ABOVE, 'maximum'], [HUGE, 'type']])) {
      const { status, body } = await call(c.method, urlOf(c, c.name, value));
      const hit = body?.fields?.find((/** @type {any} */ f) => f.path === field);
      if (status !== 400 || hit?.rule !== rule) {
        failures.push(`${where} = ${value.length > 20 ? `${value.length} digits` : value}: ${status} ${JSON.stringify(body)}`);
      }
    }
    const { status, body } = await call(c.method, urlOf(c, c.name, MAX));
    const hit = body?.fields?.find((/** @type {any} */ f) => f.path === field);
    if (status === 500 || hit) failures.push(`${where} = ${MAX}: ${status} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errorLog, [], 'no unexpected error reached the central handler');
});
