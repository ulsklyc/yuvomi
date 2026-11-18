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
 *          1B (family, people, search, kitchen, screensaver, displays) and 2A
 *          (recipes, recipe-providers, pantry).
 * Run: npm run test:validate-request-coverage
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROUTES = join(ROOT, 'server', 'routes');

/**
 * The route files that do not carry validateRequest() on every route yet.
 * Only shrinks: a file leaves the list in the PR that migrates it.
 */
const NOT_MIGRATED = [
  'server/routes/backup.js',
  'server/routes/birthday-feed.js',
  'server/routes/budget/accounts.js',
  'server/routes/budget/categories.js',
  'server/routes/budget/entries.js',
  'server/routes/budget/loans.js',
  'server/routes/budget/plans.js',
  'server/routes/budget/stats.js',
  'server/routes/budget/transfers.js',
  'server/routes/calendar/apple.js',
  'server/routes/calendar/caldav.js',
  'server/routes/calendar/crud.js',
  'server/routes/calendar/feed.js',
  'server/routes/calendar/google.js',
  'server/routes/calendar/local-calendars.js',
  'server/routes/calendar/outlook.js',
  'server/routes/calendar/read.js',
  'server/routes/calendar/subscriptions.js',
  'server/routes/calendar/sync-targets.js',
  'server/routes/cardav.js',
  'server/routes/changelog.js',
  'server/routes/contacts.js',
  'server/routes/dashboard.js',
  'server/routes/dms.js',
  'server/routes/document-storage-google-drive.js',
  'server/routes/documents.js',
  'server/routes/health/activities.js',
  'server/routes/health/caregivers.js',
  'server/routes/health/cycle-feed.js',
  'server/routes/health/cycle.js',
  'server/routes/health/export.js',
  'server/routes/health/fasting.js',
  'server/routes/health/labs.js',
  'server/routes/health/medications.js',
  'server/routes/health/nutrition.js',
  'server/routes/health/prevention.js',
  'server/routes/health/visibility-defaults.js',
  'server/routes/health/vitals.js',
  'server/routes/housekeeping.js',
  'server/routes/inventory/categories.js',
  'server/routes/inventory/deadlines-feed.js',
  'server/routes/inventory/entries.js',
  'server/routes/inventory/items.js',
  'server/routes/inventory/locations.js',
  'server/routes/meals.js',
  'server/routes/preferences.js',
  'server/routes/push.js',
  'server/routes/rewards.js',
  'server/routes/schedule-extras.js',
  'server/routes/schedule-feed.js',
  'server/routes/schedule-preferences.js',
  'server/routes/schedule.js',
  'server/routes/shopping.js',
  'server/routes/split-expenses.js',
  'server/routes/subscriptions.js',
  'server/routes/system.js',
  'server/routes/tasks.js',
  'server/routes/waste/feed.js',
  'server/routes/waste/import.js',
  'server/routes/waste/occurrences.js',
  'server/routes/waste/pickups.js',
  'server/routes/waste/reminder-settings.js',
  'server/routes/waste/schedules.js',
  'server/routes/waste/sources.js',
  'server/routes/waste/types.js',
];

/** The files the groups so far migrated: they must be found complete. */
const MIGRATED = [
  'server/routes/notes.js', 'server/routes/birthdays.js', 'server/routes/quick-links.js',
  'server/routes/reminders.js', 'server/routes/notifications.js', 'server/routes/modules.js',
  'server/routes/permissions.js', 'server/routes/email.js', 'server/routes/weather.js',
  'server/routes/family.js', 'server/routes/people.js', 'server/routes/search.js',
  'server/routes/kitchen.js', 'server/routes/screensaver.js', 'server/routes/displays.js',
  'server/routes/recipes.js', 'server/routes/recipe-providers.js', 'server/routes/pantry.js',
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
for (const path of sourceFiles(ROUTES).sort()) {
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
    for (const { route, validated } of routes) if (!validated) missing.push(`${file}: ${route}`);
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

test.after(() => {
  // Route modules may start timers on load (schedulers); this suite has no server to close.
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
