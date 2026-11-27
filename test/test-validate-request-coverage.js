/**
 * Test: every route of a migrated route file carries validateRequest() (#2810)
 * Purpose: phase 2 section E moves the route files one group at a time onto
 *          the request check against the OpenAPI document. A route added later
 *          to a migrated file without `validateRequest()` would take any body
 *          again, unseen. This guard loads every file under server/routes,
 *          reads the stack of each exported router at runtime (not the text:
 *          a comment or a string would count there) and holds:
 *            - a file NOT on NOT_MIGRATED: every route has the middleware in
 *              its own stack;
 *            - a file ON NOT_MIGRATED: it still has a route without it. A file
 *              that is complete turns the guard red, so the list is pulled in
 *              the PR that finishes it - the list only shrinks;
 *            - a file without a route of its own (an orchestrator that mounts
 *              sub-routers, a helper) is on neither side.
 *          Migrated so far: the pilot (notes, birthdays, quick-links), group 1A
 *          (reminders, notifications, modules, permissions, email, weather),
 *          1B (family, people, search, kitchen, screensaver, displays), 2A
 *          (recipes, recipe-providers, pantry), 2B (the five route files of
 *          inventory: locations, categories, items, entries, deadlines-feed),
 *          3 (housekeeping, rewards), 4 (the eight route files of waste,
 *          schedule, schedule-extras, schedule-feed, schedule-preferences),
 *          5 (split-expenses, backup, and of the core system and changelog),
 *          6 (the twelve route files of health under server/routes/health/), 7
 *          (contacts, cardav, meals), 8 (shopping, documents,
 *          document-storage-google-drive, dms) and 9 (the seven route files
 *          of the budget under server/routes/budget/, and subscriptions) and
 *          10a (the calendar core under server/routes/calendar/: read, crud,
 *          local-calendars, feed, sync-targets, subscriptions; and the
 *          dashboard) and 10b (the provider routes under
 *          server/routes/calendar/: google, apple, caldav, outlook) and 11a
 *          (tasks) and 11b (preferences, push).
 *
 *          Beside server/routes the guard reads server/auth.js (EXTRA_FILES):
 *          the auth router, with the routes its builders (buildResetRoutes,
 *          buildInviteRoutes, buildGravatarRoute) put on it. Group 12a
 *          migrated its 34 routes of sign-in, session and own account, 12b
 *          (a) the 13 administration routes (`requireAdmin`): all 47 carry
 *          validateRequest(), and server/auth.js is on MIGRATED.
 *
 *          A file migrated in part could stand on PARTIAL by route
 *          (`<export> <METHOD> <path>`), which only shrinks: a listed route
 *          that carries validateRequest() turns the guard red, and every
 *          other route of the file must carry it. The list is empty since 12b
 *          (a) (server/auth.js was its only entry).
 *
 *          End state since group 13 (a): the birthday feed administration
 *          (server/routes/birthday-feed.js) and the six ICS feeds, moved out
 *          of server/index.js into server/routes/ics-feeds.js, carry it too;
 *          NOT_MIGRATED is empty and stays as a ratchet for a route file that
 *          a later PR adds without the check - server/routes/availability.js
 *          (#1591) goes straight to MIGRATED on that ratchet. Two more checks
 *          keep a route
 *          from hiding where the stack walk above does not look:
 *            - every `Router()` under server/ stands in a file the guard reads
 *              (server/routes/**, EXTRA_FILES) or on ROUTER_OUTSIDE with a
 *              reason - only server/mcp/server.js, whose protocol errors must
 *              stay JSON-RPC;
 *            - every inline route of server/index.js (`app.get(...)` and the
 *              other methods, read from the text: importing the file would
 *              start the server) stands on INLINE_ROUTES with a reason. A new
 *              inline route turns the guard red; the two addresses of the
 *              OpenAPI document are listed as "inline, validated" and must
 *              carry validateRequest() in their registration.
 * Run: npm run test:validate-request-coverage
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROUTES = join(ROOT, 'server', 'routes');

/** Files outside server/routes whose exported routers the guard reads as well. */
const EXTRA_FILES = [join(ROOT, 'server', 'auth.js')];

/**
 * Files migrated in part: per file the routes (`<export> <METHOD> <path>`)
 * that may still lack validateRequest(). Only shrinks; every other route of
 * the file must carry it. Empty since group 12b (a) (#2810) migrated the 13
 * administration routes of server/auth.js, its only entry.
 * @type {Record<string, string[]>}
 */
const PARTIAL = {};

/**
 * The route files that do not carry validateRequest() on every route yet.
 * Only shrinks: a file leaves the list in the PR that migrates it. Empty since
 * group 13 (a) (#2810) migrated server/routes/birthday-feed.js, its last
 * entry; it stays as a ratchet - a new route file goes straight to MIGRATED.
 * @type {string[]}
 */
const NOT_MIGRATED = [];

/**
 * Files under server/ with a `Router()` that the guard does not read, each
 * with its reason. Any other file with a router must be read (server/routes/**
 * or EXTRA_FILES), or the guard is red.
 */
const ROUTER_OUTSIDE = new Map([
  ['server/mcp/server.js', 'JSON-RPC envelope, protocol errors must stay JSON-RPC (decision 4 of group 13)'],
]);

/** The value of an INLINE_ROUTES entry for a route that must carry validateRequest(). */
const INLINE_VALIDATED = 'inline, validated';

/**
 * The inline routes of server/index.js, by the path argument as written there,
 * each with its reason for standing outside a route file (decision 1 of group
 * 13). A new inline route is red until it is listed here or moved to a file
 * under server/routes.
 */
const INLINE_ROUTES = new Map([
  ["'/readyz'", 'before the sessions, answers the restore without the database; no input'],
  ["['/docs', '/docs/']", 'an array pattern resolves to no operation; no input'],
  ["'/sw.js'", 'not in the document (file delivery); no input'],
  ["'/api/v1/version'", 'no input; iOS contract, stays in front of requireAuth'],
  ["'/manifest.webmanifest'", 'not in the document (file delivery); no input'],
  ["'/api/v1/openapi.json'", INLINE_VALIDATED],
  ["'/openapi.json'", INLINE_VALIDATED],
  ["'/health'", 'package contract (container healthchecks); must not depend on building the document'],
  ["'/{*path}'", 'SPA fallback, wildcard, not in the document'],
]);

/** The files the groups so far migrated: they must be found complete. */
const MIGRATED = [
  'server/routes/notes.js', 'server/routes/birthdays.js', 'server/routes/quick-links.js',
  'server/routes/reminders.js', 'server/routes/notifications.js', 'server/routes/modules.js',
  'server/routes/permissions.js', 'server/routes/email.js', 'server/routes/weather.js',
  'server/routes/family.js', 'server/routes/people.js', 'server/routes/search.js',
  'server/routes/kitchen.js', 'server/routes/screensaver.js', 'server/routes/displays.js',
  'server/routes/recipes.js', 'server/routes/recipe-providers.js', 'server/routes/pantry.js',
  'server/routes/inventory/locations.js', 'server/routes/inventory/categories.js', 'server/routes/inventory/items.js',
  'server/routes/inventory/entries.js', 'server/routes/inventory/deadlines-feed.js',
  'server/routes/housekeeping.js', 'server/routes/rewards.js',
  'server/routes/waste/types.js', 'server/routes/waste/schedules.js', 'server/routes/waste/pickups.js',
  'server/routes/waste/occurrences.js', 'server/routes/waste/sources.js', 'server/routes/waste/import.js',
  'server/routes/waste/reminder-settings.js', 'server/routes/waste/feed.js',
  'server/routes/schedule.js', 'server/routes/schedule-extras.js', 'server/routes/schedule-feed.js',
  'server/routes/schedule-preferences.js',
  'server/routes/split-expenses.js', 'server/routes/backup.js', 'server/routes/system.js', 'server/routes/changelog.js',
  'server/routes/health/vitals.js', 'server/routes/health/medications.js', 'server/routes/health/labs.js',
  'server/routes/health/activities.js', 'server/routes/health/export.js', 'server/routes/health/cycle.js',
  'server/routes/health/cycle-feed.js', 'server/routes/health/caregivers.js', 'server/routes/health/visibility-defaults.js',
  'server/routes/health/fasting.js', 'server/routes/health/prevention.js', 'server/routes/health/nutrition.js',
  'server/routes/contacts.js', 'server/routes/cardav.js', 'server/routes/meals.js',
  'server/routes/shopping.js', 'server/routes/documents.js', 'server/routes/document-storage-google-drive.js',
  'server/routes/dms.js',
  'server/routes/budget/accounts.js', 'server/routes/budget/categories.js', 'server/routes/budget/entries.js',
  'server/routes/budget/loans.js', 'server/routes/budget/plans.js', 'server/routes/budget/stats.js',
  'server/routes/budget/transfers.js', 'server/routes/subscriptions.js',
  'server/routes/calendar/read.js', 'server/routes/calendar/crud.js', 'server/routes/calendar/local-calendars.js',
  'server/routes/calendar/feed.js', 'server/routes/calendar/sync-targets.js', 'server/routes/calendar/subscriptions.js',
  'server/routes/dashboard.js',
  'server/routes/calendar/google.js', 'server/routes/calendar/apple.js', 'server/routes/calendar/caldav.js',
  'server/routes/calendar/outlook.js',
  'server/routes/tasks.js',
  'server/routes/preferences.js', 'server/routes/push.js',
  'server/auth.js',
  'server/routes/birthday-feed.js', 'server/routes/ics-feeds.js', 'server/routes/availability.js',
];

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(js|ts)$/.test(name) ? [path] : [];
  });
}

/**
 * Per route file: each route of each exported router (`<export> <METHOD> <path>`)
 * and whether validateRequest() stands in its own stack.
 * @type {Map<string, Array<{ route: string, validated: boolean }>>}
 */
const files = new Map();
for (const path of [...sourceFiles(ROUTES).sort(), ...EXTRA_FILES]) {
  const mod = await import(pathToFileURL(path).href);
  const routes = [];
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function' || !Array.isArray(/** @type {any} */ (value).stack)) continue;
    for (const layer of /** @type {any} */ (value).stack) {
      if (!layer.route) continue;
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase()).join(',');
      routes.push({
        route: `${name} ${methods} ${layer.route.path}`,
        validated: layer.route.stack.some((/** @type {any} */ l) => l.name === 'validateRequestMiddleware'),
      });
    }
  }
  files.set(relative(ROOT, path).split('\\').join('/'), routes);
}

test('the guard sees the routers: the route files load and carry routes', () => {
  const withRoutes = [...files.values()].filter((routes) => routes.length > 0);
  assert.ok(files.size >= 90, `${files.size} route files read`);
  assert.ok(withRoutes.length >= 80, `${withRoutes.length} route files with routes`);
});

test('every route of a migrated route file carries validateRequest()', () => {
  const missing = [];
  for (const [file, routes] of files) {
    if (NOT_MIGRATED.includes(file)) continue;
    const allowed = PARTIAL[file] ?? [];
    for (const { route, validated } of routes) if (!validated && !allowed.includes(route)) missing.push(`${file}: ${route}`);
  }
  assert.deepEqual(missing, [], 'add validateRequest() to these routes, or (only for a file not migrated yet) keep the file on NOT_MIGRATED');
});

test('the groups migrated so far are complete and off the list', () => {
  for (const file of MIGRATED) {
    assert.ok(files.has(file), `${file} exists`);
    assert.ok(!NOT_MIGRATED.includes(file), `${file} must not be on NOT_MIGRATED`);
    const routes = files.get(file) ?? [];
    assert.ok(routes.length > 0, `${file} has routes`);
    assert.ok(routes.every((r) => r.validated), `${file} is complete`);
  }
});

test('NOT_MIGRATED only shrinks: every entry exists and still has a route without validateRequest()', () => {
  assert.equal(new Set(NOT_MIGRATED).size, NOT_MIGRATED.length, 'no entry twice');
  assert.deepEqual([...NOT_MIGRATED].sort(), NOT_MIGRATED, 'sorted, so a removal reads as one line');
  for (const file of NOT_MIGRATED) {
    const routes = files.get(file);
    assert.ok(routes, `${file} on NOT_MIGRATED does not exist (any more): take it off the list`);
    assert.ok(routes.length > 0, `${file} on NOT_MIGRATED has no route of its own: take it off the list`);
    assert.ok(routes.some((r) => !r.validated), `${file} is complete now: take it off NOT_MIGRATED`);
  }
});

test('server/auth.js: all 47 routes of groups 12a and 12b carry validateRequest()', () => {
  const routes = files.get('server/auth.js') ?? [];
  const validated = routes.filter((r) => r.validated).map((r) => r.route);
  assert.equal(routes.length, 47, 'the auth router and its builders register 47 routes');
  assert.equal(validated.length, 47, `${validated.length} routes of server/auth.js carry validateRequest()`);
  assert.ok(MIGRATED.includes('server/auth.js') && !NOT_MIGRATED.includes('server/auth.js') && !('server/auth.js' in PARTIAL), 'server/auth.js is on MIGRATED only');
});

test('PARTIAL only shrinks: every listed route exists and still lacks validateRequest()', () => {
  for (const [file, listed] of Object.entries(PARTIAL)) {
    const routes = files.get(file);
    assert.ok(routes, `${file} on PARTIAL does not exist (any more)`);
    assert.equal(new Set(listed).size, listed.length, `${file}: no entry twice`);
    for (const route of listed) {
      const found = routes.find((r) => r.route === route);
      assert.ok(found, `${file}: ${route} on PARTIAL has no route (any more): take it off the list`);
      assert.ok(!found.validated, `${file}: ${route} carries validateRequest() now: take it off PARTIAL`);
    }
  }
});

/** @param {string} path relative to the root, with forward slashes */
const readSource = (path) => readFileSync(join(ROOT, path), 'utf8');

test('every Router() under server/ stands in a file the guard reads, or on ROUTER_OUTSIDE with its reason', () => {
  const withRouter = sourceFiles(join(ROOT, 'server'))
    .map((path) => relative(ROOT, path).split('\\').join('/'))
    // `express.Router()` or a bare `Router()`; not "Auth-Router (" in a comment.
    .filter((file) => /(?:^|[^\w-])Router\(/m.test(readSource(file)));
  assert.ok(withRouter.length >= 90, `${withRouter.length} files with a Router() found`);
  const unread = withRouter.filter((file) => !files.has(file) && !ROUTER_OUTSIDE.has(file));
  assert.deepEqual(unread, [], 'a router the guard does not read: put its file under server/routes, on EXTRA_FILES, or on ROUTER_OUTSIDE with a reason');
  const stale = [...ROUTER_OUTSIDE.keys()].filter((file) => !withRouter.includes(file));
  assert.deepEqual(stale, [], 'ROUTER_OUTSIDE names a file without a router (any more)');
  for (const file of ROUTER_OUTSIDE.keys()) assert.ok(!files.has(file), `${file} is read by the guard: take it off ROUTER_OUTSIDE`);
});

test('every inline route of server/index.js stands on INLINE_ROUTES with its reason', () => {
  const source = readSource('server/index.js');
  /** @type {Array<{ path: string, call: string }>} */
  const inline = [];
  const register = /\bapp\.(?:get|post|put|patch|delete|all|head|options|route)\(\s*('[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\])/g;
  for (const match of source.matchAll(register)) {
    const end = source.indexOf(');', match.index);
    inline.push({ path: match[1], call: source.slice(match.index, end === -1 ? undefined : end) });
  }
  assert.ok(inline.length >= INLINE_ROUTES.size, `${inline.length} inline routes read`);
  const unlisted = [...new Set(inline.map((r) => r.path))].filter((path) => !INLINE_ROUTES.has(path));
  assert.deepEqual(unlisted, [], 'a new inline route in server/index.js: move it into a route file under server/routes with validateRequest(), or list it here with a reason');
  const stale = [...INLINE_ROUTES.keys()].filter((path) => !inline.some((r) => r.path === path));
  assert.deepEqual(stale, [], 'INLINE_ROUTES names a route server/index.js does not register (any more)');
  for (const [path, reason] of INLINE_ROUTES) {
    if (reason !== INLINE_VALIDATED) continue;
    const calls = inline.filter((r) => r.path === path);
    assert.ok(calls.every((r) => r.call.includes('validateRequest()')), `${path} is listed as validated but registers without validateRequest()`);
  }
});

test.after(() => {
  // Route modules may start timers on load (schedulers); this suite has no server to close.
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
