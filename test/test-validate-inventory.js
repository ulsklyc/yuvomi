/**
 * Test: request validation in the inventory module (#2810, phase 2 section E, group 2B)
 * Purpose: the five route files of server/routes/inventory/ (locations,
 *          categories, items, entries, deadlines-feed - 31 routes) check every
 *          request against the schema of its operation in the OpenAPI document
 *          (`validateRequest()` in every route) before the handler runs. Held
 *          here against the real router server/routes/inventory/index.js at its
 *          real prefix, in the order of server/index.js (express.json,
 *          defaultEmptyBody, the router, the central error handler):
 *            - REFUSED: each input of the decided list is a 400 with
 *              `reason: 'validation'` and `fields`, and the 400 comes before the
 *              404 and the 409 of the handler; the three reorder routes answer
 *              400 where `[{}]` and `[true]` were a 500;
 *            - DESTRUCTIVE TOLERANCES CLOSED: `tracked_dates: null` and
 *              `attachment_document_ids: null` on a replace are a 400 and leave
 *              the stored dates and links standing (they emptied them);
 *            - RIGHTS ORDER: `not_owner` is a right on the loaded row and stays
 *              in the handler behind the check - a non-owner with a malformed
 *              request gets 400, with a valid one the same 403 as before;
 *            - KEPT: what the routes lived with goes through as before, and
 *              what the schema cannot say (calendar day, category from the
 *              table, location existence, `inventory_selected_location_not_found`)
 *              still gets the handler's answer;
 *            - THE OWN FRONTEND: every request the app sends to these routes
 *              passes, the legacy digit text included;
 *            - ONE SOURCE: the enums are the lists of
 *              server/routes/inventory/fields.js, the day patterns those of
 *              server/utils/datetime-pattern.js, the photo length and the
 *              number of tracked dates the route's own limits.
 *          No answer asserted here carries a date; the household zone is
 *          pinned anyway, since the items write reminders.
 * Run: npm run test:validate-inventory
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: inventoryRouter } = await import('../server/routes/inventory/index.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { validateRequest } = await import('../server/api/validate-request.ts');
const { applyChildStartPermissions } = await import('../server/authorize/index.ts');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const NOT_OWNER = { error: 'You can only change entries you created.', code: 403, reason: 'not_owner' };

/** @param {string} username @param {string} role @param {string} familyRole */
function user(username, role, familyRole) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('admin2b', 'admin', 'parent');
// A child starts without `inventory_edit_others` and `inventory_view_prices`.
const CHILD = user('child2b', 'member', 'child');
applyChildStartPermissions(db, { id: CHILD, role: 'member', family_role: 'child' });
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
db.prepare("INSERT INTO sync_config (key, value) VALUES ('budget_mode', 'shared') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

const quiet = { warn: () => {}, error: () => {} };
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const child = req.get('x-actor') === 'child';
  const id = child ? CHILD : ADMIN;
  req.authUserId = id;
  req.authRole = child ? 'member' : 'admin';
  req.authMethod = 'session';
  req.session = { userId: id, role: req.authRole };
  req.sessionModuleAccess = null;
  next();
});
// The mount of server/index.js.
app.use('/api/v1/inventory', inventoryRouter);
app.use(createErrorHandler(quiet));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} route under /api/v1/inventory
 * @param {{ json?: unknown, actor?: 'child' }} [options] json left out: no body
 */
async function call(method, route, { json, actor } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor) headers['x-actor'] = actor;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/v1/inventory${route}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, body };
}

/**
 * The 400 of the middleware: exactly these fields.
 * @param {{ status: number, body: any }} res
 * @param {Array<{ path: string, rule: string }>} fields
 * @param {string} [label]
 */
function assertRefused(res, fields, label = '') {
  assert.equal(res.status, 400, `${label} ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { error: SENTENCE, code: 400, reason: 'validation', fields }, label);
}

/**
 * The 400 of the middleware with this field among its fields (an `anyOf`
 * names the failing branches too).
 * @param {{ status: number, body: any }} res
 * @param {string} path
 * @param {string} rule
 * @param {string} [label]
 */
function assertRefusedAt(res, path, rule, label = '') {
  assert.equal(res.status, 400, `${label} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.equal(res.body?.reason, 'validation', label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path && f.rule === rule), `${label}: ${JSON.stringify(res.body.fields)}`);
}

/**
 * A 400 of the handler, not of the schema: no `fields`.
 * @param {{ status: number, body: any }} res
 * @param {string | undefined} [reason]
 * @param {string} [label]
 */
function assertHandlerRefused(res, reason, label = '') {
  assert.equal(res.status, 400, `${label} ${JSON.stringify(res.body)}`);
  assert.notEqual(res.body?.error, SENTENCE, `${label} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.fields, undefined, label);
  assert.equal(res.body?.reason, reason, label);
}

/** @param {{ status: number, body: any }} res @param {number} status @param {string} [label] */
function assertPassed(res, status, label = '') {
  assert.equal(res.status, status, `${label} ${JSON.stringify(res.body)}`);
}

const NOT_DIGITS = ['12abc', '5.0', '1e2', '0x10', '%201'];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// ── Seed ────────────────────────────────────────────────────────────────────

/** @param {Record<string, unknown>} [fields] */
async function newItem(fields = {}) {
  const res = await call('POST', '/items', { json: { name: 'Bohrmaschine', ...fields } });
  assertPassed(res, 201, 'seed item');
  return res.body.data;
}

/** @param {string} name */
async function newLocation(name) {
  const res = await call('POST', '/locations', { json: { name } });
  assertPassed(res, 201, 'seed location');
  return res.body.data;
}

/** A visible budget booking, created by the admin. */
function newEntry() {
  return Number(db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, is_recurring, is_pending, created_by, owner_id, visibility)
    VALUES ('Kauf', -120, 'food', '2026-11-01', 0, 0, ?, ?, 'shared')
  `).run(ADMIN, ADMIN).lastInsertRowid);
}

/** A document of the Documents module, visible to the family. */
function newDocument() {
  return Number(db.prepare(`
    INSERT INTO family_documents (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES ('Beleg', 'warranty', 'family', 'beleg.pdf', 'application/pdf', 1234, 'data:application/pdf;base64,AA==', ?)
  `).run(ADMIN).lastInsertRowid);
}

const LOCATION = await newLocation('Keller');
const SUB = (await call('POST', `/locations/${LOCATION.id}/subcategories`, { json: { name: 'Regal 1' } })).body.data;
const ITEM = await newItem({ category: 'vehicles', odometer: 1000, odometer_unit: 'km', odometer_on: '2026-10-01', tracked_dates: [{ label: 'TÜV', date: '2027-03-01' }] });
const DATE_ID = ITEM.tracked_dates[0].id;
const LOG = (await call('POST', `/items/${ITEM.id}/service-log`, { json: { label: 'Ölwechsel', performed_on: '2026-10-02', odometer: 1100 } })).body.data;

// ── PATH IDS ────────────────────────────────────────────────────────────────

test('path ids: anything but plain decimal digits is a 400 naming the parameter, on every operation with an id', async () => {
  /** @type {Array<[string, (bad: string) => string, string, unknown]>} */
  const routes = [
    ['PUT', (b) => `/locations/${b}`, 'path/id', { name: 'X' }],
    ['DELETE', (b) => `/locations/${b}`, 'path/id', undefined],
    ['POST', (b) => `/locations/${b}/subcategories`, 'path/parentId', { name: 'X' }],
    ['PATCH', (b) => `/locations/${b}/subcategories/reorder`, 'path/parentId', { order: [] }],
    ['PUT', (b) => `/locations/${LOCATION.id}/subcategories/${b}`, 'path/id', { name: 'X' }],
    ['DELETE', (b) => `/locations/${b}/subcategories/${SUB.id}`, 'path/parentId', undefined],
    ['GET', (b) => `/items/${b}`, 'path/id', undefined],
    ['PUT', (b) => `/items/${b}`, 'path/id', { name: 'X' }],
    ['DELETE', (b) => `/items/${b}`, 'path/id', undefined],
    ['POST', (b) => `/items/${b}/entries`, 'path/id', { entry_id: 1 }],
    ['DELETE', (b) => `/items/${ITEM.id}/entries/${b}`, 'path/entryId', undefined],
    ['POST', (b) => `/items/${ITEM.id}/dates/${b}/complete`, 'path/dateId', { performed_on: '2026-11-01' }],
    ['GET', (b) => `/items/${b}/service-log`, 'path/id', undefined],
    ['POST', (b) => `/items/${b}/service-log`, 'path/id', { label: 'X', performed_on: '2026-11-01' }],
    ['PUT', (b) => `/items/${ITEM.id}/service-log/${b}`, 'path/logId', { label: 'X', performed_on: '2026-11-01' }],
    ['DELETE', (b) => `/items/${ITEM.id}/service-log/${b}`, 'path/logId', undefined],
    ['GET', (b) => `/items/${b}/history`, 'path/id', undefined],
    ['GET', (b) => `/entries/${b}/items`, 'path/entryId', undefined],
  ];
  for (const [method, route, path, json] of routes) {
    for (const bad of NOT_DIGITS) {
      assertRefused(await call(method, route(bad), { json }), [{ path, rule: 'type' }], `${method} ${route(bad)}`);
    }
  }
  // `DELETE /items/12abc` deleted item 12 before; the item is still there.
  assertPassed(await call('GET', `/items/${ITEM.id}`), 200);
});

test('path ids: 0 and below stay the handler\'s (items 400, locations 404), leading zeros still pass', async () => {
  assertHandlerRefused(await call('GET', '/items/0'));
  assertHandlerRefused(await call('GET', '/items/-1'));
  assertHandlerRefused(await call('GET', '/entries/0/items'));
  assert.equal((await call('PUT', '/locations/0', { json: { name: 'X' } })).status, 404);
  assert.equal((await call('DELETE', '/locations/-1')).status, 404);
  assertPassed(await call('GET', `/items/0${ITEM.id}`), 200);
});

// ── LOCATIONS ───────────────────────────────────────────────────────────────

test('locations: name and icon are text within their length, the body an object', async () => {
  for (const [route, method] of [['/locations', 'POST'], [`/locations/${LOCATION.id}`, 'PUT'], [`/locations/${LOCATION.id}/subcategories`, 'POST'], [`/locations/${LOCATION.id}/subcategories/${SUB.id}`, 'PUT']]) {
    for (const name of [5, ['x'], { a: 1 }, true, null]) {
      assertRefused(await call(method, route, { json: { name } }), [{ path: 'body/name', rule: 'type' }], `${method} ${route} ${JSON.stringify(name)}`);
    }
    assertRefused(await call(method, route, { json: { name: ` ${'x'.repeat(100)}` } }), [{ path: 'body/name', rule: 'maxLength' }], `${method} ${route} raw 101`);
    assertRefused(await call(method, route, { json: { name: 'Neu', icon: 5 } }), [{ path: 'body/icon', rule: 'type' }], `${method} ${route} icon`);
    assertRefused(await call(method, route, { json: {} }), [{ path: 'body/name', rule: 'required' }], `${method} ${route} {}`);
    assertRefused(await call(method, route, { json: [] }), [{ path: 'body', rule: 'type' }], `${method} ${route} []`);
    assertRefused(await call(method, route), [{ path: 'body', rule: 'required' }], `${method} ${route} no body`);
    // Empty after trim stays the handler's sentence.
    assertHandlerRefused(await call(method, route, { json: { name: '   ' } }), undefined, `${method} ${route} blank`);
  }
  assertPassed(await call('POST', '/locations', { json: { name: 'Garage', icon: null } }), 201);
  assertPassed(await call('POST', '/locations', { json: { name: 'Dachboden', icon: '' } }), 201);
});

test('locations: the 400 comes before the 404 of an unknown location or parent', async () => {
  assertRefused(await call('PUT', '/locations/999999', { json: {} }), [{ path: 'body/name', rule: 'required' }]);
  assertRefused(await call('POST', '/locations/999999/subcategories', { json: {} }), [{ path: 'body/name', rule: 'required' }]);
  assertRefused(await call('PUT', `/locations/999999/subcategories/${SUB.id}`, { json: { name: 5 } }), [{ path: 'body/name', rule: 'type' }]);
  // A valid body still meets the 404 and the 409.
  assert.equal((await call('PUT', '/locations/999999', { json: { name: 'X' } })).body.reason, 'inventory_location_not_found');
  assert.equal((await call('POST', '/locations', { json: { name: 'keller' } })).body.reason, 'inventory_location_exists');
});

test('locations reorder: a non-empty list of ids; [{}] and [true] are a 400, no longer a 500', async () => {
  for (const order of [[{}], [true], [null], [[1]], [1.5], ['abc'], ['1x']]) {
    assertRefusedAt(await call('PATCH', '/locations/reorder', { json: { order } }), 'body/order/0', 'anyOf', JSON.stringify(order));
  }
  assertRefused(await call('PATCH', '/locations/reorder', { json: { order: [] } }), [{ path: 'body/order', rule: 'minItems' }]);
  assertRefused(await call('PATCH', '/locations/reorder', { json: { order: 'abc' } }), [{ path: 'body/order', rule: 'type' }]);
  assertRefused(await call('PATCH', '/locations/reorder', { json: {} }), [{ path: 'body/order', rule: 'required' }]);
  assertPassed(await call('PATCH', '/locations/reorder', { json: { order: [LOCATION.id] } }), 200);
  assertPassed(await call('PATCH', '/locations/reorder', { json: { order: [String(LOCATION.id)] } }), 200);
});

test('child locations reorder: a list of ids, the empty list still a no-op; [{}] and [true] are a 400', async () => {
  const route = `/locations/${LOCATION.id}/subcategories/reorder`;
  for (const order of [[{}], [true], [null], [1.5], ['abc']]) {
    assertRefusedAt(await call('PATCH', route, { json: { order } }), 'body/order/0', 'anyOf', JSON.stringify(order));
  }
  assertRefused(await call('PATCH', route, { json: {} }), [{ path: 'body/order', rule: 'required' }]);
  assertRefused(await call('PATCH', route), [{ path: 'body', rule: 'required' }]);
  assertPassed(await call('PATCH', route, { json: { order: [] } }), 200);
  assertPassed(await call('PATCH', route, { json: { order: [SUB.id] } }), 200);
  assertPassed(await call('PATCH', route, { json: { order: [String(SUB.id)] } }), 200);
});

// ── CATEGORIES ──────────────────────────────────────────────────────────────

test('categories: name and icon are text, the key stays text, `other` stays protected by the handler', async () => {
  for (const [route, method] of [['/categories', 'POST'], ['/categories/sports', 'PUT']]) {
    for (const name of [5, { a: 1 }, true]) {
      assertRefused(await call(method, route, { json: { name } }), [{ path: 'body/name', rule: 'type' }], `${method} ${route}`);
    }
    assertRefused(await call(method, route, { json: { name: 'Neu', icon: ['x'] } }), [{ path: 'body/icon', rule: 'type' }]);
    assertRefused(await call(method, route, { json: { name: 'x'.repeat(101) } }), [{ path: 'body/name', rule: 'maxLength' }]);
  }
  // 400 before 404.
  assertRefused(await call('PUT', '/categories/nope', { json: {} }), [{ path: 'body/name', rule: 'required' }]);
  assertHandlerRefused(await call('DELETE', '/categories/other'));
  assertPassed(await call('POST', '/categories', { json: { name: 'Werkzeug' } }), 201);
});

test('categories reorder: a non-empty list of key texts; [{}] and [true] are a 400, no longer a 500', async () => {
  for (const order of [[{}], [true], [5], [null], [['sports']]]) {
    assertRefused(await call('PATCH', '/categories/reorder', { json: { order } }), [{ path: 'body/order/0', rule: 'type' }], JSON.stringify(order));
  }
  assertRefused(await call('PATCH', '/categories/reorder', { json: { order: [] } }), [{ path: 'body/order', rule: 'minItems' }]);
  assertRefused(await call('PATCH', '/categories/reorder', { json: {} }), [{ path: 'body/order', rule: 'required' }]);
  // An unknown key stays the handler's 400.
  assertHandlerRefused(await call('PATCH', '/categories/reorder', { json: { order: ['nope'] } }));
  assertPassed(await call('PATCH', '/categories/reorder', { json: { order: ['other'] } }), 200);
});

// ── ITEMS: the body ─────────────────────────────────────────────────────────

/** Each field with the inputs the schema now refuses, and the rule. */
const ITEM_REFUSALS = /** @type {Array<[string, unknown, string]>} */ ([
  ['name', 5, 'type'], ['name', ['x'], 'type'], ['name', { a: 1 }, 'type'], ['name', true, 'type'], ['name', ` ${'x'.repeat(200)}`, 'maxLength'],
  ['brand', 5, 'type'], ['brand', ['a'], 'type'], ['brand', 'x'.repeat(101), 'maxLength'],
  ['model', { a: 1 }, 'type'], ['serial_number', 7, 'type'], ['vendor', true, 'type'], ['account_username', 5, 'type'],
  ['notes', 5, 'type'], ['notes', 'x'.repeat(5001), 'maxLength'],
  ['category', 5, 'type'], ['category', ['other'], 'type'],
  ['purchase_date', ['2026-01-31'], 'type'], ['purchase_date', '20260131', 'pattern'], ['purchase_date', '2026-01-31T10:00', 'pattern'], ['purchase_date', ' 2026-01-31', 'pattern'],
  ['purchase_price', '12.5', 'type'], ['purchase_price', true, 'type'], ['purchase_price', [5], 'type'], ['purchase_price', '', 'type'],
  ['currency', 5, 'type'], ['currency', ['EUR'], 'type'],
  ['warranty_months', '24', 'type'], ['warranty_months', 2.5, 'type'], ['warranty_months', false, 'type'], ['warranty_months', 601, 'maximum'], ['warranty_months', -1, 'minimum'], ['warranty_months', '', 'type'],
  ['condition', 'nope', 'enum'], ['condition', 'NEW', 'enum'], ['condition', false, 'type'], ['condition', 0, 'type'], ['condition', ['new'], 'type'],
  ['status', 'bogus', 'enum'], ['status', false, 'type'], ['status', 5, 'type'],
  ['photo_data', 5, 'type'], ['photo_data', [PNG], 'type'],
  ['odometer', '1000', 'type'], ['odometer', 1.5, 'type'], ['odometer', true, 'type'], ['odometer', [5], 'type'],
  ['odometer_unit', 'miles', 'enum'], ['odometer_unit', 'KM', 'enum'], ['odometer_unit', 5, 'type'],
  ['odometer_on', '2026-1-3', 'pattern'], ['odometer_on', ['2026-01-03'], 'type'],
  ['tracked_dates', null, 'type'], ['tracked_dates', 'abc', 'type'], ['tracked_dates', {}, 'type'],
  ['attachment_document_ids', null, 'type'], ['attachment_document_ids', 'abc', 'type'], ['attachment_document_ids', {}, 'type'],
]);

test('items: each field outside its schema is a 400 naming it, on create and replace', async () => {
  for (const [field, value, rule] of ITEM_REFUSALS) {
    const json = { name: 'Ding', [field]: value };
    assertRefused(await call('POST', '/items', { json }), [{ path: `body/${field}`, rule }], `POST ${field} ${JSON.stringify(value)?.slice(0, 40)}`);
    assertRefused(await call('PUT', `/items/${ITEM.id}`, { json }), [{ path: `body/${field}`, rule }], `PUT ${field} ${JSON.stringify(value)?.slice(0, 40)}`);
  }
  // The types hold in every category: a reading on a category without one was dropped silently.
  assertRefused(await call('POST', '/items', { json: { name: 'Ding', category: 'other', odometer: 'abc' } }), [{ path: 'body/odometer', rule: 'type' }]);
  assertRefused(await call('POST', '/items', { json: { name: 'Ding', photo_data: `data:image/png;base64,${'A'.repeat(6_990_507)}` } }), [{ path: 'body/photo_data', rule: 'maxLength' }]);
  assertRefused(await call('POST', '/items', { json: {} }), [{ path: 'body/name', rule: 'required' }]);
  assertRefused(await call('POST', '/items', { json: [] }), [{ path: 'body', rule: 'type' }]);
  assertRefused(await call('POST', '/items'), [{ path: 'body', rule: 'required' }]);
  assertRefused(await call('PUT', `/items/${ITEM.id}`, { json: { brand: 'x' } }), [{ path: 'body/name', rule: 'required' }]);
});

test('items: location_id is a whole number, digit text (legacy) or null - nothing else', async () => {
  for (const value of ['1abc', 1.9, [1], true, {}, 'abc', '']) {
    assertRefusedAt(await call('POST', '/items', { json: { name: 'Ding', location_id: value } }), 'body/location_id', 'anyOf', JSON.stringify(value));
  }
  for (const value of [LOCATION.id, String(LOCATION.id), null]) {
    const res = await call('POST', '/items', { json: { name: 'Ding', location_id: value } });
    assertPassed(res, 201, JSON.stringify(value));
    assert.equal(res.body.data.location_id, value === null ? null : LOCATION.id);
  }
});

test('items: a location that does not exist keeps its reason, sent as a number and as digit text', async () => {
  for (const value of [999999, '999999']) {
    for (const [method, route] of [['POST', '/items'], ['PUT', `/items/${ITEM.id}`]]) {
      const res = await call(method, route, { json: { name: 'Ding', location_id: value } });
      assertHandlerRefused(res, 'inventory_selected_location_not_found', `${method} ${JSON.stringify(value)}`);
    }
  }
  // 0 is well-typed: the handler's sentence.
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', location_id: 0 } }));
});

test('items: tracked dates are rows of label, day and whole numbers within their bounds', async () => {
  /** @type {Array<[unknown, string, string]>} */
  const cases = [
    [[null], 'body/tracked_dates/0', 'type'],
    [['x'], 'body/tracked_dates/0', 'type'],
    [[{ label: 'a' }], 'body/tracked_dates/0/date', 'required'],
    [[{ date: '2027-01-01' }], 'body/tracked_dates/0/label', 'required'],
    [[{ label: 5, date: '2027-01-01' }], 'body/tracked_dates/0/label', 'type'],
    [[{ label: 'x'.repeat(101), date: '2027-01-01' }], 'body/tracked_dates/0/label', 'maxLength'],
    [[{ label: 'a', date: '2027-1-1' }], 'body/tracked_dates/0/date', 'pattern'],
    [[{ label: 'a', date: null }], 'body/tracked_dates/0/date', 'type'],
    [[{ label: 'a', date: '2027-01-01', reminder_offset_days: '30' }], 'body/tracked_dates/0/reminder_offset_days', 'type'],
    [[{ label: 'a', date: '2027-01-01', reminder_offset_days: 366 }], 'body/tracked_dates/0/reminder_offset_days', 'maximum'],
    [[{ label: 'a', date: '2027-01-01', reminder_offset_days: -1 }], 'body/tracked_dates/0/reminder_offset_days', 'minimum'],
    [[{ label: 'a', date: '2027-01-01', interval_months: 0 }], 'body/tracked_dates/0/interval_months', 'minimum'],
    [[{ label: 'a', date: '2027-01-01', interval_months: '12' }], 'body/tracked_dates/0/interval_months', 'type'],
    [[{ label: 'a', date: '2027-01-01', interval_distance: 15000.5 }], 'body/tracked_dates/0/interval_distance', 'type'],
    [[{ label: 'a', date: '2027-01-01', interval_distance: 0 }], 'body/tracked_dates/0/interval_distance', 'minimum'],
    [Array.from({ length: 11 }, (_, i) => ({ label: `F${i}`, date: '2027-01-01' })), 'body/tracked_dates', 'maxItems'],
  ];
  for (const [rows, path, rule] of cases) {
    assertRefused(await call('POST', '/items', { json: { name: 'Ding', tracked_dates: rows } }), [{ path, rule }], JSON.stringify(rows).slice(0, 60));
  }
  // A day that does not exist stays the handler's.
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', tracked_dates: [{ label: 'a', date: '2027-02-30' }] } }));
  const res = await call('POST', '/items', { json: { name: 'Ding', tracked_dates: [{ label: 'a', date: '2027-01-01', reminder_offset_days: 0, interval_months: null, interval_distance: null }] } });
  assertPassed(res, 201);
  assert.equal(res.body.data.tracked_dates[0].reminder_offset_days, 0);
});

test('items: what the schema cannot say stays the handler\'s answer', async () => {
  assertHandlerRefused(await call('POST', '/items', { json: { name: '   ' } }));
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', category: 'nope' } }));
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', purchase_date: '2026-02-30' } }));
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', purchase_price: -1 } }));
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', currency: 'EURO' } }));
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', photo_data: 'data:text/html;base64,AA==' } }));
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', category: 'vehicles', odometer: -5 } }));
  assertHandlerRefused(await call('POST', '/items', { json: { name: 'Ding', entry_id: 0 } }));
  assert.equal((await call('POST', '/items', { json: { name: 'Ding', entry_id: 999999 } })).body.reason, 'inventory_booking_not_found');
});

test('items: the defaults and none-values the routes lived with still pass', async () => {
  const res = await call('POST', '/items', {
    json: {
      name: 'Ding', category: null, condition: '', status: null, currency: 'eur', purchase_date: '', odometer_on: '', photo_data: '',
      brand: '', model: null, odometer_unit: '', purchase_price: null, warranty_months: null, unknown_key: 1,
    },
  });
  assertPassed(res, 201);
  assert.equal(res.body.data.category, 'other');
  assert.equal(res.body.data.condition, 'good');
  assert.equal(res.body.data.status, 'active');
  assert.equal(res.body.data.currency, 'EUR');
  // A child without the price right sends no price; the replace keeps the stored one.
  const priced = await newItem({ purchase_price: 99 });
  db.prepare('UPDATE inventory_items SET created_by = ? WHERE id = ?').run(CHILD, priced.id);
  assertPassed(await call('PUT', `/items/${priced.id}`, { json: { name: 'Ding' }, actor: 'child' }), 200);
  assert.equal(db.prepare('SELECT purchase_price FROM inventory_items WHERE id = ?').get(priced.id).purchase_price, 99);
});

test('items: replace with tracked_dates or attachment_document_ids as null is a 400 and leaves them standing', async () => {
  const doc = newDocument();
  const item = await newItem({ tracked_dates: [{ label: 'Service', date: '2027-05-01' }], attachment_document_ids: [doc] });
  const dates = () => db.prepare('SELECT COUNT(*) AS n FROM inventory_item_dates WHERE item_id = ?').get(item.id).n;
  const links = () => db.prepare('SELECT COUNT(*) AS n FROM inventory_item_documents WHERE item_id = ?').get(item.id).n;
  assert.equal(dates(), 1);
  assert.equal(links(), 1);
  for (const json of [{ name: 'Ding', tracked_dates: null }, { name: 'Ding', tracked_dates: 'abc' }, { name: 'Ding', attachment_document_ids: null }, { name: 'Ding', attachment_document_ids: 'abc' }]) {
    const res = await call('PUT', `/items/${item.id}`, { json });
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.equal(dates(), 1, `tracked dates still there after ${JSON.stringify(json)}`);
    assert.equal(links(), 1, `document links still there after ${JSON.stringify(json)}`);
  }
  // Left out: untouched; an empty list: the documented way to clear.
  assertPassed(await call('PUT', `/items/${item.id}`, { json: { name: 'Ding' } }), 200);
  assert.equal(dates(), 1);
  assert.equal(links(), 1);
  assertPassed(await call('PUT', `/items/${item.id}`, { json: { name: 'Ding', tracked_dates: [], attachment_document_ids: [] } }), 200);
  assert.equal(dates(), 0);
  assert.equal(links(), 0);
});

test('items: attachment_document_ids holds whole numbers only; a bad element on a replace leaves the links standing', async () => {
  // The app sends the ids it got from the server as numbers
  // (public/components/document-attach.js, commit()); numbers as text are no form of an own caller.
  const doc = newDocument();
  const item = await newItem({ attachment_document_ids: [doc] });
  const links = () => db.prepare('SELECT COUNT(*) AS n FROM inventory_item_documents WHERE item_id = ?').get(item.id).n;
  assert.equal(links(), 1);
  for (const ids of [['abc'], [1.5], [null], [String(doc)], [doc, 'x'], [true], [{ id: doc }], [[doc]]]) {
    const at = ids.length === 2 ? 1 : 0;
    const field = [{ path: `body/attachment_document_ids/${at}`, rule: 'type' }];
    assertRefused(await call('POST', '/items', { json: { name: 'Ding', attachment_document_ids: ids } }), field, `POST ${JSON.stringify(ids)}`);
    assertRefused(await call('PUT', `/items/${item.id}`, { json: { name: 'Ding', attachment_document_ids: ids } }), field, `PUT ${JSON.stringify(ids)}`);
    assert.equal(links(), 1, `the document link still there after PUT ${JSON.stringify(ids)}`);
  }
  assertPassed(await call('PUT', `/items/${item.id}`, { json: { name: 'Ding', attachment_document_ids: [doc] } }), 200);
  assert.equal(links(), 1);
});

// ── ITEMS: the query of the list ────────────────────────────────────────────

test('GET /items: the four filters are typed, a filter given twice is a 400', async () => {
  assertRefused(await call('GET', '/items?status=bogus'), [{ path: 'query/status', rule: 'enum' }]);
  assertRefused(await call('GET', '/items?location_id=1abc'), [{ path: 'query/location_id', rule: 'type' }]);
  assertRefused(await call('GET', '/items?location_id=%201'), [{ path: 'query/location_id', rule: 'type' }]);
  for (const name of ['status', 'category', 'q', 'location_id']) {
    const value = name === 'status' ? 'active' : '1';
    assertRefused(await call('GET', `/items?${name}=${value}&${name}=${value}`), [{ path: `query/${name}`, rule: 'type' }], name);
  }
  // 0 and below stay the handler's 400; a long search text is cut, not refused.
  assertHandlerRefused(await call('GET', '/items?location_id=0'));
  assertHandlerRefused(await call('GET', '/items?location_id=-1'));
  assertPassed(await call('GET', `/items?q=${'a'.repeat(300)}`), 200);
  const res = await call('GET', `/items?status=active&category=vehicles&location_id=${LOCATION.id}&q=`);
  assertPassed(res, 200);
  assertPassed(await call('GET', '/items?category=&unknown=1'), 200);
});

// ── ITEMS: entries, completion, service log ─────────────────────────────────

test('link a booking: entry_id a whole number and required, role from its list, amount_share a number of at least 0', async () => {
  const route = `/items/${ITEM.id}/entries`;
  for (const [json, path, rule] of /** @type {Array<[unknown, string, string]>} */ ([
    [{}, 'body/entry_id', 'required'],
    [{ entry_id: '1' }, 'body/entry_id', 'type'],
    [{ entry_id: 1.9 }, 'body/entry_id', 'type'],
    [{ entry_id: [1] }, 'body/entry_id', 'type'],
    [{ entry_id: null }, 'body/entry_id', 'type'],
    [{ entry_id: 1, role: 'bogus' }, 'body/role', 'enum'],
    [{ entry_id: 1, role: false }, 'body/role', 'type'],
    [{ entry_id: 1, role: ['refund'] }, 'body/role', 'type'],
    [{ entry_id: 1, amount_share: '5.5' }, 'body/amount_share', 'type'],
    [{ entry_id: 1, amount_share: true }, 'body/amount_share', 'type'],
    [{ entry_id: 1, amount_share: -1 }, 'body/amount_share', 'minimum'],
  ])) {
    assertRefused(await call('POST', route, { json }), [{ path, rule }], JSON.stringify(json));
  }
  assertRefused(await call('POST', route), [{ path: 'body', rule: 'required' }]);
  // 400 before the 404 of an unknown item.
  assertRefused(await call('POST', '/items/999999/entries', { json: {} }), [{ path: 'body/entry_id', rule: 'required' }]);
  const entry = newEntry();
  const res = await call('POST', route, { json: { entry_id: entry, role: '', amount_share: null } });
  assertPassed(res, 201);
  assert.equal(res.body.data.linked_entries.at(-1).role, 'purchase');
  assertHandlerRefused(await call('POST', route, { json: { entry_id: 0 } }));
  assertPassed(await call('DELETE', `${route}/${entry}`), 200);
});

test('complete a tracked date and the service log: a day as text, whole numbers, text fields', async () => {
  const complete = `/items/${ITEM.id}/dates/${DATE_ID}/complete`;
  const log = `/items/${ITEM.id}/service-log`;
  const logEntry = `${log}/${LOG.id}`;
  /** @type {Array<[string, string, Record<string, unknown>]>} */
  const routes = [['POST', complete, {}], ['POST', log, { label: 'Öl' }], ['PUT', logEntry, { label: 'Öl' }]];
  for (const [method, route, base] of routes) {
    for (const [extra, path, rule] of /** @type {Array<[Record<string, unknown>, string, string]>} */ ([
      [{}, 'body/performed_on', 'required'],
      [{ performed_on: ['2026-11-01'] }, 'body/performed_on', 'type'],
      [{ performed_on: null }, 'body/performed_on', 'type'],
      [{ performed_on: '20261101' }, 'body/performed_on', 'pattern'],
      [{ performed_on: '' }, 'body/performed_on', 'pattern'],
      [{ performed_on: '2026-11-01', odometer: '2000' }, 'body/odometer', 'type'],
      [{ performed_on: '2026-11-01', odometer: [2000] }, 'body/odometer', 'type'],
      [{ performed_on: '2026-11-01', odometer: true }, 'body/odometer', 'type'],
      [{ performed_on: '2026-11-01', odometer: -1 }, 'body/odometer', 'minimum'],
      [{ performed_on: '2026-11-01', vendor: 5 }, 'body/vendor', 'type'],
      [{ performed_on: '2026-11-01', vendor: 'x'.repeat(101) }, 'body/vendor', 'maxLength'],
      [{ performed_on: '2026-11-01', note: ['a'] }, 'body/note', 'type'],
      [{ performed_on: '2026-11-01', note: 'x'.repeat(5001) }, 'body/note', 'maxLength'],
    ])) {
      assertRefused(await call(method, route, { json: { ...base, ...extra } }), [{ path, rule }], `${method} ${route} ${JSON.stringify(extra).slice(0, 50)}`);
    }
  }
  for (const [method, route] of [['POST', log], ['PUT', logEntry]]) {
    assertRefused(await call(method, route, { json: { performed_on: '2026-11-01' } }), [{ path: 'body/label', rule: 'required' }]);
    assertRefused(await call(method, route, { json: { label: 5, performed_on: '2026-11-01' } }), [{ path: 'body/label', rule: 'type' }]);
  }
  // The handler keeps the calendar day and the odometer regression.
  assertHandlerRefused(await call('POST', complete, { json: { performed_on: '2026-02-30' } }));
  assertHandlerRefused(await call('POST', log, { json: { label: 'Öl', performed_on: '2026-11-01', odometer: 500 } }));
  // 400 before the 404 of an unknown entry (it was a 400 of the handler, now the schema's).
  assertRefused(await call('PUT', `${log}/999999`, { json: {} }), [{ path: 'body/label', rule: 'required' }]);
  assertPassed(await call('PUT', logEntry, { json: { label: 'Ölwechsel', performed_on: '2026-10-02', odometer: 1100, vendor: null, note: null } }), 200);
  assertPassed(await call('POST', complete, { json: { performed_on: '2026-11-01', odometer: null, vendor: null, note: null } }), 201);
});

// ── RIGHTS ORDER ────────────────────────────────────────────────────────────

test('not_owner stays behind the check: a malformed request of a non-owner is a 400, a valid one the same 403 as before', async () => {
  const item = await newItem({ tracked_dates: [{ label: 'Frist', date: '2027-04-01' }] });
  const dateId = item.tracked_dates[0].id;
  const entry = newEntry();
  assertPassed(await call('POST', `/items/${item.id}/entries`, { json: { entry_id: entry } }), 201);
  const logId = (await call('POST', `/items/${item.id}/service-log`, { json: { label: 'Prüfung', performed_on: '2026-11-01' } })).body.data.id;
  /** @type {Array<[string, string, string, { json?: unknown }, { json?: unknown }]>} */
  const routes = [
    ['PUT', `/items/${item.id}`, `/items/${item.id}`, { json: { name: 5 } }, { json: { name: 'Ding' } }],
    ['DELETE', `/items/${item.id}abc`, `/items/${item.id}`, {}, {}],
    ['POST', `/items/${item.id}/entries`, `/items/${item.id}/entries`, { json: { entry_id: String(entry) } }, { json: { entry_id: entry } }],
    ['DELETE', `/items/${item.id}/entries/${entry}abc`, `/items/${item.id}/entries/${entry}`, {}, {}],
    ['POST', `/items/${item.id}/dates/${dateId}/complete`, `/items/${item.id}/dates/${dateId}/complete`, { json: {} }, { json: { performed_on: '2026-11-01' } }],
    ['POST', `/items/${item.id}/service-log`, `/items/${item.id}/service-log`, { json: { label: 'Öl' } }, { json: { label: 'Öl', performed_on: '2026-11-01' } }],
    ['PUT', `/items/${item.id}/service-log/${logId}`, `/items/${item.id}/service-log/${logId}`, { json: [] }, { json: { label: 'Öl', performed_on: '2026-11-01' } }],
    ['DELETE', `/items/${item.id}/service-log/${logId}abc`, `/items/${item.id}/service-log/${logId}`, {}, {}],
  ];
  for (const [method, badRoute, route, bad, good] of routes) {
    const refused = await call(method, badRoute, { ...bad, actor: 'child' });
    assert.equal(refused.status, 400, `${method} ${badRoute} malformed: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.reason, 'validation', `${method} ${badRoute}`);
    const forbidden = await call(method, route, { ...good, actor: 'child' });
    assert.equal(forbidden.status, 403, `${method} ${route} valid: ${JSON.stringify(forbidden.body)}`);
    assert.deepEqual(forbidden.body, NOT_OWNER, `${method} ${route}`);
  }
  // Nothing of the item changed.
  assertPassed(await call('GET', `/items/${item.id}`), 200);
});

// ── DEADLINES FEED ──────────────────────────────────────────────────────────

test('deadlines feed: the three routes carry the check, a body is still ignored', async () => {
  assertPassed(await call('GET', '/deadlines-feed?x=1'), 200);
  assertPassed(await call('POST', '/deadlines-feed/regenerate', { json: [1] }), 200);
  assertPassed(await call('POST', '/deadlines-feed/regenerate'), 200);
  assertPassed(await call('DELETE', '/deadlines-feed', { json: { x: 1 } }), 200);
});

// ── THE OWN FRONTEND ────────────────────────────────────────────────────────

/**
 * The middleware of the app document for one operation, called as Express
 * would: true when it lets the request through.
 * @param {string} method
 * @param {string} mount
 * @param {string} pattern
 * @param {{ params?: Record<string, unknown>, query?: Record<string, unknown>, body?: unknown }} request
 */
function passes(method, mount, pattern, { params = {}, query = {}, body } = {}) {
  /** @type {unknown} */
  let outcome = 'not called';
  const req = { method, baseUrl: mount, route: { path: pattern }, params, query, body };
  validateRequest()(req, {}, (/** @type {unknown} */ err) => { outcome = err; });
  if (outcome === undefined) return true;
  const fields = /** @type {any} */ (outcome)?.fields ?? /** @type {any} */ (outcome)?.details?.fields;
  return JSON.stringify(fields ?? outcome);
}

// saveItem() of public/pages/inventory.js (create and edit): the location as a
// number, the price only with the price right, readings only for a category
// with a reading, tracked dates filtered to rows with label and day.
const ITEM_FORM = {
  name: 'Auto', category: 'vehicles', location_id: 3, purchase_date: '2026-01-31', purchase_price: 18999.5,
  status: 'active', brand: 'VW', model: null, serial_number: null, vendor: 'Händler', account_username: null,
  warranty_months: 24, condition: 'good', notes: null,
  tracked_dates: [{ label: 'TÜV', date: '2027-03-01', reminder_offset_days: 30, interval_months: 24, interval_distance: null }, { label: 'Öl', date: '2027-01-01', reminder_offset_days: 0, interval_months: null, interval_distance: 15000 }],
  photo_data: PNG, odometer: 42000, odometer_unit: 'km', odometer_on: '2026-11-01',
};
const PLAIN_FORM = {
  name: 'Lampe', category: 'other', location_id: null, purchase_date: null, status: 'active', brand: null, model: null,
  serial_number: null, vendor: null, account_username: null, warranty_months: null, condition: 'new', notes: null,
  tracked_dates: [], photo_data: null, odometer: null, odometer_unit: null, odometer_on: null,
};
const I = '/api/v1/inventory/items';
const L = '/api/v1/inventory/locations';
const C = '/api/v1/inventory/categories';
const F = '/api/v1/inventory/deadlines-feed';

/**
 * Each entry: where it is sent from, the operation and the request exactly as
 * that call site builds it (the inventory of #2810, "Frontend callers").
 * @type {Array<[string, string, string, string, { params?: Record<string, unknown>, query?: Record<string, unknown>, body?: unknown }]>}
 */
const FRONTEND_CALLS = [
  ['inventory.js list', 'GET', I, '/', {}],
  ['inventory.js locations', 'GET', L, '/', {}],
  ['inventory.js categories', 'GET', C, '/', {}],
  ['inventory.js create with everything', 'POST', I, '/', { body: { ...ITEM_FORM, attachment_document_ids: [4, 5], entry_id: 9 } }],
  ['inventory.js create, plain, without price right', 'POST', I, '/', { body: PLAIN_FORM }],
  ['inventory.js create with price null', 'POST', I, '/', { body: { ...PLAIN_FORM, purchase_price: null } }],
  ['inventory.js edit', 'PUT', I, '/:id', { params: { id: '7' }, body: { ...ITEM_FORM, attachment_document_ids: [] } }],
  ['inventory.js edit without attachments component', 'PUT', I, '/:id', { params: { id: '7' }, body: PLAIN_FORM }],
  ['inventory.js delete', 'DELETE', I, '/:id', { params: { id: '7' } }],
  ['inventory.js history', 'GET', I, '/:id/history', { params: { id: '7' } }],
  ['inventory.js complete', 'POST', I, '/:id/dates/:dateId/complete', { params: { id: '7', dateId: '3' }, body: { performed_on: '2026-11-18', odometer: 43000, vendor: 'Werkstatt', note: null } }],
  ['inventory.js complete without reading', 'POST', I, '/:id/dates/:dateId/complete', { params: { id: '7', dateId: '3' }, body: { performed_on: '2026-11-18', odometer: null, vendor: null, note: 'ok' } }],
  ['inventory.js link a booking', 'POST', I, '/:id/entries', { params: { id: '7' }, body: { entry_id: 12, role: 'maintenance' } }],
  ['inventory.js unlink a booking', 'DELETE', I, '/:id/entries/:entryId', { params: { id: '7', entryId: '12' } }],
  ['category-manager.js add location', 'POST', L, '/', { body: { name: 'Keller' } }],
  ['category-manager.js rename location', 'PUT', L, '/:id', { params: { id: '3' }, body: { name: 'Vorratskeller' } }],
  ['category-manager.js delete location', 'DELETE', L, '/:id', { params: { id: '3' } }],
  ['category-manager.js reorder locations (numbers)', 'PATCH', L, '/reorder', { body: { order: [5, 3, 1] } }],
  ['category-manager.js add child location', 'POST', L, '/:parentId/subcategories', { params: { parentId: '3' }, body: { name: 'Regal' } }],
  ['category-manager.js rename child location', 'PUT', L, '/:parentId/subcategories/:id', { params: { parentId: '3', id: '8' }, body: { name: 'Regal 2' } }],
  ['category-manager.js delete child location', 'DELETE', L, '/:parentId/subcategories/:id', { params: { parentId: '3', id: '8' } }],
  ['category-manager.js reorder child locations (numbers)', 'PATCH', L, '/:parentId/subcategories/reorder', { params: { parentId: '3' }, body: { order: [8, 9] } }],
  ['category-manager.js add category', 'POST', C, '/', { body: { name: 'Werkzeug' } }],
  ['category-manager.js rename category', 'PUT', C, '/:key', { params: { key: 'tools' }, body: { name: 'Werkzeuge' } }],
  ['category-manager.js delete category', 'DELETE', C, '/:key', { params: { key: 'tools' } }],
  ['category-manager.js reorder categories (keys)', 'PATCH', C, '/reorder', { body: { order: ['vehicles', 'other'] } }],
  ['personal-feeds.js status', 'GET', F, '/', {}],
  ['personal-feeds.js regenerate', 'POST', F, '/regenerate', {}],
  ['personal-feeds.js disable', 'DELETE', F, '/', {}],
  // Service workers of older app versions: digit text, a legacy form.
  ['legacy inventory.js create (digit text)', 'POST', I, '/', { body: { ...PLAIN_FORM, location_id: '3' } }],
  ['legacy inventory.js edit (digit text)', 'PUT', I, '/:id', { params: { id: '7' }, body: { ...ITEM_FORM, location_id: '3' } }],
  ['legacy category-manager.js reorder locations (digit text)', 'PATCH', L, '/reorder', { body: { order: ['5', '3', '1'] } }],
  ['legacy category-manager.js reorder child locations (digit text)', 'PATCH', L, '/:parentId/subcategories/reorder', { params: { parentId: '3' }, body: { order: ['8', '9'] } }],
];

for (const [site, method, mount, pattern, request] of FRONTEND_CALLS) {
  test(`the own frontend passes the schema: ${site}`, () => {
    assert.equal(passes(method, mount, pattern, request), true);
  });
}

// That the app sends these numbers is held where its code runs: the save of
// the item form and the configuration of the location manager
// (test:inventory-notes-errors), the order of rows and sub rows as numbers
// (test:category-manager).

// ── ONE SOURCE ──────────────────────────────────────────────────────────────

const { buildOpenApiSpec } = await import('../server/openapi.js');
const fields = await import('../server/routes/inventory/fields.js');
const { ROLES } = await import('../server/routes/inventory/entry-links.js');
const { MAX_TRACKED_DATES_PER_ITEM } = await import('../server/routes/inventory/item-dates.js');
const { DATE_PATTERN, OPTIONAL_DATE_PATTERN } = await import('../server/utils/datetime-pattern.js');
const SPEC = buildOpenApiSpec();

/** @param {string} path @param {string} method */
const bodySchema = (path, method) => SPEC.paths[path][method].requestBody.content['application/json'].schema;
/** @param {unknown[]} values */
const asSet = (values) => [...new Set(values.filter((v) => v !== null && v !== ''))].sort();
const ITEMS = '/api/v1/inventory/items';
const ITEM_ID = '/api/v1/inventory/items/{id}';

test('one source: condition, status, odometer_unit and role are the lists the handlers check', async () => {
  for (const [path, method] of [[ITEMS, 'post'], [ITEM_ID, 'put']]) {
    const props = bodySchema(path, method).properties;
    assert.deepEqual(asSet(props.condition.enum), asSet(fields.CONDITIONS), `${method} condition`);
    assert.deepEqual(asSet(props.status.enum), asSet(fields.STATUSES), `${method} status`);
    assert.deepEqual(asSet(props.odometer_unit.enum), asSet(fields.ODOMETER_UNITS), `${method} odometer_unit`);
    for (const name of ['condition', 'status', 'odometer_unit']) {
      assert.ok(props[name].enum.includes(null) && props[name].enum.includes(''), `${name}: null and "" are the default`);
    }
  }
  const status = SPEC.paths[ITEMS].get.parameters.find((/** @type {any} */ p) => p.name === 'status');
  assert.deepEqual(asSet(status.schema.enum), asSet(fields.STATUSES), 'query status');
  assert.deepEqual(asSet(bodySchema('/api/v1/inventory/items/{id}/entries', 'post').properties.role.enum), asSet(ROLES), 'role');
  assert.equal(ROLES, fields.ROLES, 'entry-links.js hands on the one list');
  // The handler accepts exactly these values (a value outside is its 400).
  for (const condition of fields.CONDITIONS) {
    assertPassed(await call('POST', '/items', { json: { name: 'Ding', condition } }), 201, condition);
  }
});

test('one source: the photo length, the number of tracked dates and the day patterns are the handlers\' own', () => {
  for (const [path, method] of [[ITEMS, 'post'], [ITEM_ID, 'put']]) {
    const props = bodySchema(path, method).properties;
    assert.equal(props.photo_data.maxLength, fields.MAX_PHOTO_LENGTH);
    assert.equal(props.tracked_dates.maxItems, MAX_TRACKED_DATES_PER_ITEM);
    assert.equal(props.tracked_dates.items.properties.date.pattern, DATE_PATTERN);
    assert.equal(props.purchase_date.pattern, OPTIONAL_DATE_PATTERN);
    assert.equal(props.odometer_on.pattern, OPTIONAL_DATE_PATTERN);
  }
  for (const [path, method] of [['/api/v1/inventory/items/{id}/dates/{dateId}/complete', 'post'], ['/api/v1/inventory/items/{id}/service-log', 'post'], ['/api/v1/inventory/items/{id}/service-log/{logId}', 'put']]) {
    assert.equal(bodySchema(path, method).properties.performed_on.pattern, DATE_PATTERN, `${method} ${path}`);
  }
});

test('the document: real success codes, the 400 on every operation with a parameter or body, no x-reason', () => {
  /** @type {Record<string, string>} */
  const created = {
    'post /api/v1/inventory/locations': '201',
    'post /api/v1/inventory/locations/{parentId}/subcategories': '201',
    'post /api/v1/inventory/categories': '201',
    'post /api/v1/inventory/items': '201',
    'post /api/v1/inventory/items/{id}/entries': '201',
    'post /api/v1/inventory/items/{id}/dates/{dateId}/complete': '201',
    'post /api/v1/inventory/items/{id}/service-log': '201',
    'delete /api/v1/inventory/items/{id}': '204',
    'delete /api/v1/inventory/items/{id}/service-log/{logId}': '204',
  };
  let operations = 0;
  for (const [path, item] of Object.entries(SPEC.paths)) {
    if (!path.startsWith('/api/v1/inventory/')) continue;
    for (const [method, operation] of Object.entries(/** @type {Record<string, any>} */ (item))) {
      operations += 1;
      const key = `${method} ${path}`;
      const success = created[key] ?? '200';
      assert.ok(operation.responses[success], `${key} documents ${success}`);
      const hasInput = (operation.parameters ?? []).some((/** @type {any} */ p) => p.in !== 'header') || operation.requestBody;
      if (hasInput) assert.ok(operation.responses[400], `${key} documents the 400`);
      assert.ok(!JSON.stringify(operation).includes('x-reason'), `${key} carries no x-reason`);
    }
  }
  assert.equal(operations, 31);
});

// ── 500 GONE ────────────────────────────────────────────────────────────────

test('nothing of this suite reached the error handler with a 500', async () => {
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['PATCH', '/locations/reorder', { order: [{}] }],
    ['PATCH', '/locations/reorder', { order: [true] }],
    ['PATCH', `/locations/${LOCATION.id}/subcategories/reorder`, { order: [{ a: 1 }] }],
    ['PATCH', '/categories/reorder', { order: [{}] }],
    ['PATCH', '/categories/reorder', { order: [true] }],
  ])) {
    const res = await call(method, route, { json });
    assert.equal(res.status, 400, `${route} ${JSON.stringify(json)} was a 500`);
  }
});
