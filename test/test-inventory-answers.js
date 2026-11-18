/**
 * Test: the answers of the inventory module stay byte-equal (#2810, phase 2 section E, group 2B)
 * Purpose: the five route files of server/routes/inventory/ dropped the hand
 *          checks the schema of their operation already covers
 *          (`validateRequest()` runs before every handler since #2828) and the
 *          try/catch blocks that answered an unexpected error with a 500 of
 *          their own. That is a refactor, and this suite holds it: for a table
 *          of requests to all 31 routes - valid, every refusal of the handler
 *          that stays, every input a dropped hand check refused (now the
 *          schema's 400), not found, not owner, conflict - it pins status and
 *          the WHOLE answer body. The expectations were written at the state
 *          before the refactor (0462caa00) and are literal here, no fixture
 *          file, no update mode. Only values that follow a clock this suite
 *          does not hold (SQLite's own `now`) and the random feed token are
 *          replaced by a marker before the comparison.
 *
 *          The clock stands still (`mock.timers`, 18.11.2026 12:00 UTC) and the
 *          household lives in Europe/Berlin (`household_timezone`): items write
 *          warranty and tracked-date reminders from "now", and a reading
 *          without a day takes "today".
 *
 *          The second part: an unexpected error in each file with routes that
 *          had a catch (items, entries, deadlines-feed) reaches the central
 *          error handler - 500 with its fixed sentence and its log line
 *          `Unhandled error: <METHOD> <pattern> -> 500` - and the process keeps
 *          answering. What stays the route's own: the 409 of a document being
 *          deleted and the 403 of a document link without the right, on create
 *          and on replace.
 * Run: npm run test:inventory-answers
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: inventoryRouter } = await import('../server/routes/inventory/index.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { applyChildStartPermissions } = await import('../server/authorize/index.ts');
const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
const { MAX_PHOTO_LENGTH } = await import('../server/routes/inventory/fields.js');
const db = dbmod.get();

db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('budget_mode', 'shared')").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

/**
 * @param {string} username
 * @param {string} role
 * @param {string} familyRole
 */
function user(username, role, familyRole) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', ?, ?)
  `).run(username, username, role, familyRole).lastInsertRowid);
}

const ADMIN = user('linda', 'admin', 'parent');
// A child starts without `inventory_edit_others` and `inventory_view_prices`.
const CHILD = user('mia', 'member', 'child');
applyChildStartPermissions(db, { id: CHILD, role: 'member', family_role: 'child' });

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = {
  warn: (/** @type {string} */ line) => { logged.warn.push(line); },
  error: (/** @type {string} */ line) => { logged.error.push(line); },
};

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read. `x-access` is the
// session's module access (sessionModuleAccess), e.g. {"documents":"none"}.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const child = req.get('x-actor') === 'child';
  const id = child ? CHILD : ADMIN;
  req.authUserId = id;
  req.authRole = child ? 'member' : 'admin';
  req.authMethod = 'session';
  req.session = { userId: id, role: req.authRole };
  req.sessionModuleAccess = req.get('x-access') ? JSON.parse(req.get('x-access')) : null;
  next();
});
// The mount of server/index.js.
app.use('/api/v1/inventory', inventoryRouter);
app.use(createErrorHandler(log));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

const NO_BODY = Symbol('no body');

/**
 * @typedef {{ actor?: 'child', access?: Record<string, string>, raw?: boolean }} CallOptions
 */

/**
 * A JSON answer as it is; anything else as its type and length.
 * @param {string} method
 * @param {string} path under /api/v1/inventory
 * @param {unknown} body a JSON value, raw JSON text (`raw`) or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, path, body, { actor, access, raw } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== NO_BODY) headers['Content-Type'] = 'application/json';
  if (actor) headers['x-actor'] = actor;
  if (access) headers['x-access'] = JSON.stringify(access);
  const res = await fetch(`${baseUrl}/api/v1/inventory${path}`, {
    method,
    headers,
    body: body === NO_BODY ? undefined : raw ? /** @type {string} */ (body) : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  if (buf.length === 0) return { status: res.status, body: null };
  if (type.startsWith('application/json')) return { status: res.status, body: JSON.parse(buf.toString('utf8')) };
  return { status: res.status, body: { type, length: buf.length } };
}

// Timestamps SQLite writes from its own clock ('now'), not from Date; the
// feed token is random, and its address names the port of this run.
const VOLATILE = new Set(['created_at', 'updated_at', 'token', 'url']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => (VOLATILE.has(key) && v !== null ? '<volatile>' : v));
}

// ── Seed: the database starts with the seeded categories only ──

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_LABEL_JPEG = 'data:image/png;base64,/9j/4AABAgP/2Q==';
// MAX_PHOTO_LENGTH code points (the schema's count), one UTF-16 unit more (the route's).
const PHOTO_EMOJI = `data:image/png;base64,${'A'.repeat(MAX_PHOTO_LENGTH - 23)}😀`;
const EMOJI_60 = '😀'.repeat(60); // 60 code points, 120 UTF-16 units

/** A visible budget booking of the admin. @param {number} amount */
function entry(amount) {
  return Number(db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, is_recurring, is_pending, created_by, owner_id, visibility)
    VALUES ('Kauf', ?, 'food', '2026-11-01', 0, 0, ?, ?, 'shared')
  `).run(amount, ADMIN, ADMIN).lastInsertRowid);
}
const BOOKING = entry(-120);
const BOOKING_2 = entry(-35.5);
const BOOKING_3 = entry(-80);
const DOC = Number(db.prepare(`
  INSERT INTO family_documents (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
  VALUES ('Beleg', 'warranty', 'family', 'beleg.pdf', 'application/pdf', 1234, 'data:application/pdf;base64,AA==', ?)
`).run(ADMIN).lastInsertRowid);

const CAR = {
  name: 'Auto', category: 'vehicles', odometer: 1000, odometer_unit: 'km', odometer_on: '2026-10-01',
  tracked_dates: [{ label: 'TÜV', date: '2027-03-01', interval_months: 24 }, { label: 'Reifen', date: '2026-12-01' }],
};
const DRILL = {
  name: ' Bohrmaschine ', brand: 'Bosch', model: 'PSB', serial_number: 'SN1', category: 'electronics', location_id: '__KELLER__',
  purchase_date: '2026-06-01', purchase_price: 89.9, currency: 'eur', vendor: 'Baumarkt', account_username: 'linda@example.org',
  warranty_months: 24, condition: 'new', status: 'active', notes: 'Mit Koffer', photo_data: PNG, attachment_document_ids: [DOC],
};
const day = (/** @type {string} */ date) => ({ label: 'Frist', date });

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a body that is a function is called when its row runs.
 * @type {Array<[string, string, string, unknown, CallOptions?] | (() => void)>}
 */
const STEPS = [
  // ── locations ─────────────────────────────────────────────────────────────
  ['loc list empty', 'GET', '/locations', NO_BODY],
  ['loc create', 'POST', '/locations', { name: ' Keller ', icon: 'box' }],
  ['loc create plain', 'POST', '/locations', { name: 'Garage' }],
  ['loc create third', 'POST', '/locations', { name: 'Dachboden', icon: null }],
  ['loc create no body', 'POST', '/locations', NO_BODY],
  ['loc create array body', 'POST', '/locations', []],
  ['loc create empty object', 'POST', '/locations', {}],
  ['loc create name empty', 'POST', '/locations', { name: '' }],
  ['loc create name spaces', 'POST', '/locations', { name: '   ' }],
  ['loc create name number', 'POST', '/locations', { name: 5 }],
  ['loc create name null', 'POST', '/locations', { name: null }],
  ['loc create name 101', 'POST', '/locations', { name: 'a'.repeat(101) }],
  ['loc create name emoji', 'POST', '/locations', { name: EMOJI_60 }],
  ['loc create icon number', 'POST', '/locations', { name: 'x', icon: 5 }],
  ['loc create duplicate', 'POST', '/locations', { name: 'keller' }],
  ['loc create duplicate icon too long', 'POST', '/locations', { name: 'keller', icon: '😀'.repeat(60) }],
  ['loc create icon emoji', 'POST', '/locations', { name: 'Neu', icon: '😀'.repeat(60) }],
  ['loc put', 'PUT', '/locations/__GARAGE__', { name: 'Carport' }],
  ['loc put icon', 'PUT', '/locations/__GARAGE__', { name: 'Carport', icon: 'car' }],
  ['loc put duplicate', 'PUT', '/locations/__GARAGE__', { name: 'KELLER' }],
  ['loc put no name', 'PUT', '/locations/__GARAGE__', { icon: 'car' }],
  ['loc put name spaces', 'PUT', '/locations/__GARAGE__', { name: '  ' }],
  ['loc put unknown', 'PUT', '/locations/999', { name: 'x' }],
  ['loc put unknown empty', 'PUT', '/locations/999', {}],
  ['loc put letters', 'PUT', '/locations/12abc', { name: 'x' }],
  ['loc put zero', 'PUT', '/locations/0', { name: 'x' }],
  ['loc sub create', 'POST', '/locations/__KELLER__/subcategories', { name: 'Regal 1' }],
  ['loc sub create second', 'POST', '/locations/__KELLER__/subcategories', { name: 'Regal 2', icon: 'archive' }],
  ['loc sub create duplicate', 'POST', '/locations/__KELLER__/subcategories', { name: 'regal 1' }],
  ['loc sub create unknown parent', 'POST', '/locations/999/subcategories', { name: 'x' }],
  ['loc sub create unknown parent empty', 'POST', '/locations/999/subcategories', {}],
  ['loc sub create name number', 'POST', '/locations/__KELLER__/subcategories', { name: 7 }],
  ['loc sub create letters', 'POST', '/locations/abc/subcategories', { name: 'x' }],
  ['loc sub put', 'PUT', '/locations/__KELLER__/subcategories/__REGAL1__', { name: 'Regal A' }],
  ['loc sub put duplicate', 'PUT', '/locations/__KELLER__/subcategories/__REGAL1__', { name: 'REGAL 2' }],
  ['loc sub put wrong parent', 'PUT', '/locations/__GARAGE__/subcategories/__REGAL1__', { name: 'x' }],
  ['loc sub put empty', 'PUT', '/locations/__KELLER__/subcategories/__REGAL1__', {}],
  ['loc reorder', 'PATCH', '/locations/reorder', { order: ['__DACHBODEN__', '__KELLER__', '__GARAGE__'].map((k) => k) }],
  ['loc reorder numbers', 'PATCH', '/locations/reorder', () => ({ order: [Number(resolved('__GARAGE__')), Number(resolved('__KELLER__')), 999] })],
  ['loc reorder empty list', 'PATCH', '/locations/reorder', { order: [] }],
  ['loc reorder no order', 'PATCH', '/locations/reorder', {}],
  ['loc reorder order text', 'PATCH', '/locations/reorder', { order: 'abc' }],
  ['loc reorder order object', 'PATCH', '/locations/reorder', { order: { 0: 1 } }],
  ['loc reorder order null', 'PATCH', '/locations/reorder', { order: null }],
  ['loc reorder no body', 'PATCH', '/locations/reorder', NO_BODY],
  ['loc reorder array body', 'PATCH', '/locations/reorder', [1]],
  ['loc reorder entry object', 'PATCH', '/locations/reorder', { order: [{}] }],
  ['loc reorder entry letters', 'PATCH', '/locations/reorder', { order: ['abc'] }],
  ['loc sub reorder', 'PATCH', '/locations/__KELLER__/subcategories/reorder', () => ({ order: [resolved('__REGAL2__'), resolved('__REGAL1__')] })],
  ['loc sub reorder empty list', 'PATCH', '/locations/__KELLER__/subcategories/reorder', { order: [] }],
  ['loc sub reorder no order', 'PATCH', '/locations/__KELLER__/subcategories/reorder', {}],
  ['loc sub reorder order text', 'PATCH', '/locations/__KELLER__/subcategories/reorder', { order: 'abc' }],
  ['loc sub reorder order null', 'PATCH', '/locations/__KELLER__/subcategories/reorder', { order: null }],
  ['loc sub reorder no body', 'PATCH', '/locations/__KELLER__/subcategories/reorder', NO_BODY],
  ['loc sub reorder unknown parent', 'PATCH', '/locations/999/subcategories/reorder', { order: [1] }],
  ['loc sub reorder letters', 'PATCH', '/locations/1x/subcategories/reorder', { order: [] }],
  ['loc list', 'GET', '/locations', NO_BODY],

  // ── categories ────────────────────────────────────────────────────────────
  ['cat list', 'GET', '/categories', NO_BODY],
  ['cat create', 'POST', '/categories', { name: ' Spiele ', icon: 'dice' }],
  ['cat create plain', 'POST', '/categories', { name: 'Sport' }],
  ['cat create no body', 'POST', '/categories', NO_BODY],
  ['cat create empty object', 'POST', '/categories', {}],
  ['cat create name spaces', 'POST', '/categories', { name: '  ' }],
  ['cat create name number', 'POST', '/categories', { name: 5 }],
  ['cat create name emoji', 'POST', '/categories', { name: EMOJI_60 }],
  ['cat create duplicate', 'POST', '/categories', { name: 'spiele' }],
  ['cat create icon list', 'POST', '/categories', { name: 'x', icon: ['a'] }],
  ['cat put', 'PUT', '/categories/__SPIELE__', { name: 'Brettspiele', icon: 'puzzle' }],
  ['cat put duplicate', 'PUT', '/categories/__SPIELE__', { name: 'Sport' }],
  ['cat put unknown', 'PUT', '/categories/nope', { name: 'x' }],
  ['cat put unknown empty', 'PUT', '/categories/nope', {}],
  ['cat put name null', 'PUT', '/categories/__SPIELE__', { name: null }],
  ['cat reorder', 'PATCH', '/categories/reorder', () => ({ order: [resolved('__SPORT__'), 'other', resolved('__SPIELE__')] })],
  ['cat reorder unknown key', 'PATCH', '/categories/reorder', { order: ['other', 'nope', 'gibtsnicht'] }],
  ['cat reorder empty list', 'PATCH', '/categories/reorder', { order: [] }],
  ['cat reorder no order', 'PATCH', '/categories/reorder', {}],
  ['cat reorder order text', 'PATCH', '/categories/reorder', { order: 'other' }],
  ['cat reorder order null', 'PATCH', '/categories/reorder', { order: null }],
  ['cat reorder no body', 'PATCH', '/categories/reorder', NO_BODY],
  ['cat reorder entry number', 'PATCH', '/categories/reorder', { order: [5] }],
  ['cat delete other', 'DELETE', '/categories/other', NO_BODY],
  ['cat delete unknown', 'DELETE', '/categories/nope', NO_BODY],

  // ── items: create ─────────────────────────────────────────────────────────
  ['item list empty', 'GET', '/items', NO_BODY],
  ['item create', 'POST', '/items', () => ({ ...DRILL, location_id: resolved('__KELLER__') })],
  ['item create car', 'POST', '/items', CAR],
  ['item create plain', 'POST', '/items', { name: 'Lampe', location_id: null, condition: '', status: null, odometer_unit: '', purchase_date: '', photo_data: '', currency: '', category: '' }],
  ['item create no body', 'POST', '/items', NO_BODY],
  ['item create array body', 'POST', '/items', []],
  ['item create empty object', 'POST', '/items', {}],
  ['item create name spaces', 'POST', '/items', { name: '   ' }],
  ['item create name emoji', 'POST', '/items', { name: '😀'.repeat(150) }],
  ['item create name number', 'POST', '/items', { name: 5 }],
  ['item create brand list', 'POST', '/items', { name: 'x', brand: ['a'] }],
  ['item create category unknown', 'POST', '/items', { name: 'x', category: 'nope' }],
  ['item create category number', 'POST', '/items', { name: 'x', category: 5 }],
  ['item create location missing', 'POST', '/items', { name: 'x', location_id: 999 }],
  ['item create location missing text', 'POST', '/items', { name: 'x', location_id: '999' }],
  ['item create location missing and name', 'POST', '/items', { name: '  ', location_id: 999 }],
  ['item create location zero', 'POST', '/items', { name: 'x', location_id: 0 }],
  ['item create location zero text', 'POST', '/items', { name: 'x', location_id: '0' }],
  ['item create location negative', 'POST', '/items', { name: 'x', location_id: -1 }],
  ['item create location empty', 'POST', '/items', { name: 'x', location_id: '' }],
  ['item create location letters', 'POST', '/items', { name: 'x', location_id: '1abc' }],
  ['item create location fraction', 'POST', '/items', { name: 'x', location_id: 1.5 }],
  ['item create location true', 'POST', '/items', { name: 'x', location_id: true }],
  ['item create location list', 'POST', '/items', { name: 'x', location_id: [1] }],
  ['item create location huge', 'POST', '/items', { name: 'Riesig', location_id: '9'.repeat(30) }],
  ['item create purchase date bad day', 'POST', '/items', { name: 'x', purchase_date: '2026-02-30' }],
  ['item create purchase date form', 'POST', '/items', { name: 'x', purchase_date: '2026-2-3' }],
  ['item create purchase date list', 'POST', '/items', { name: 'x', purchase_date: ['2026-01-31'] }],
  ['item create price negative', 'POST', '/items', { name: 'x', purchase_price: -1 }],
  ['item create price text', 'POST', '/items', { name: 'x', purchase_price: '12.5' }],
  ['item create price empty', 'POST', '/items', { name: 'x', purchase_price: '' }],
  ['item create price true', 'POST', '/items', { name: 'x', purchase_price: true }],
  ['item create price child', 'POST', '/items', { name: 'Kinderrad', purchase_price: 50, currency: 'USD' }, { actor: 'child' }],
  ['item create price negative child', 'POST', '/items', { name: 'Kinderball', purchase_price: -5 }, { actor: 'child' }],
  ['item create price text child', 'POST', '/items', { name: 'x', purchase_price: '5' }, { actor: 'child' }],
  ['item create currency long', 'POST', '/items', { name: 'x', currency: 'EURO' }],
  ['item create currency number', 'POST', '/items', { name: 'x', currency: 5 }],
  ['item create warranty 600', 'POST', '/items', { name: 'Ewig', warranty_months: 600, purchase_date: '2026-11-01' }],
  ['item create warranty 0', 'POST', '/items', { name: 'Kurz', warranty_months: 0, purchase_date: '2026-11-01' }],
  ['item create warranty 601', 'POST', '/items', { name: 'x', warranty_months: 601 }],
  ['item create warranty negative', 'POST', '/items', { name: 'x', warranty_months: -1 }],
  ['item create warranty fraction', 'POST', '/items', { name: 'x', warranty_months: 2.5 }],
  ['item create warranty text', 'POST', '/items', { name: 'x', warranty_months: '12' }],
  ['item create warranty empty', 'POST', '/items', { name: 'x', warranty_months: '' }],
  ['item create warranty true', 'POST', '/items', { name: 'x', warranty_months: true }],
  ['item create warranty infinite', 'POST', '/items', '{"name":"x","warranty_months":1e400}', { raw: true }],
  ['item create warranty 24.0', 'POST', '/items', '{"name":"Zwei Jahre","warranty_months":24.0}', { raw: true }],
  ['item create condition unknown', 'POST', '/items', { name: 'x', condition: 'broken' }],
  ['item create condition upper', 'POST', '/items', { name: 'x', condition: 'GOOD' }],
  ['item create condition false', 'POST', '/items', { name: 'x', condition: false }],
  ['item create condition zero', 'POST', '/items', { name: 'x', condition: 0 }],
  ['item create condition poor', 'POST', '/items', { name: 'Alt', condition: 'poor', status: 'lost' }],
  ['item create status unknown', 'POST', '/items', { name: 'x', status: 'gone' }],
  ['item create status number', 'POST', '/items', { name: 'x', status: 1 }],
  ['item create odometer non-vehicle', 'POST', '/items', { name: 'Fahrrad', odometer: 500, odometer_unit: 'mi', odometer_on: '2026-11-01' }],
  ['item create odometer text non-vehicle', 'POST', '/items', { name: 'x', odometer: '500' }],
  ['item create odometer negative', 'POST', '/items', { name: 'x', category: 'vehicles', odometer: -5 }],
  ['item create odometer negative non-vehicle', 'POST', '/items', { name: 'Roller', odometer: -5 }],
  ['item create odometer fraction', 'POST', '/items', { name: 'x', category: 'vehicles', odometer: 1.5 }],
  ['item create odometer text', 'POST', '/items', { name: 'x', category: 'vehicles', odometer: '100' }],
  ['item create odometer empty', 'POST', '/items', { name: 'x', category: 'vehicles', odometer: '' }],
  ['item create odometer no unit', 'POST', '/items', { name: 'Moped', category: 'vehicles', odometer: 20 }],
  ['item create odometer null', 'POST', '/items', { name: 'Anhaenger', category: 'vehicles', odometer: null, odometer_unit: null }],
  ['item create odometer mi', 'POST', '/items', { name: 'Oldtimer', category: 'vehicles', odometer: 70000, odometer_unit: 'mi', odometer_on: '2026-05-05' }],
  ['item create odometer unit unknown', 'POST', '/items', { name: 'x', category: 'vehicles', odometer: 1, odometer_unit: 'miles' }],
  ['item create odometer unit upper', 'POST', '/items', { name: 'x', category: 'vehicles', odometer_unit: 'KM' }],
  ['item create odometer unit false', 'POST', '/items', { name: 'x', category: 'vehicles', odometer_unit: false }],
  ['item create odometer on bad day', 'POST', '/items', { name: 'x', category: 'vehicles', odometer: 1, odometer_on: '2026-02-30' }],
  ['item create photo number', 'POST', '/items', { name: 'x', photo_data: 5 }],
  ['item create photo text', 'POST', '/items', { name: 'x', photo_data: 'data:text/plain;base64,AAAA' }],
  ['item create photo mismatch', 'POST', '/items', { name: 'x', photo_data: PNG_LABEL_JPEG }],
  ['item create photo emoji over length', 'POST', '/items', { name: 'x', photo_data: PHOTO_EMOJI }],
  ['item create photo too long', 'POST', '/items', { name: 'x', photo_data: `${PHOTO_EMOJI.slice(0, -2)}AA` }],
  ['item create notes 5001', 'POST', '/items', { name: 'x', notes: 'a'.repeat(5001) }],
  ['item create tracked null', 'POST', '/items', { name: 'x', tracked_dates: null }],
  ['item create tracked text', 'POST', '/items', { name: 'x', tracked_dates: 'abc' }],
  ['item create tracked eleven', 'POST', '/items', { name: 'x', tracked_dates: Array.from({ length: 11 }, () => day('2027-01-01')) }],
  ['item create tracked row text', 'POST', '/items', { name: 'x', tracked_dates: ['TÜV'] }],
  ['item create tracked no label', 'POST', '/items', { name: 'x', tracked_dates: [{ date: '2027-01-01' }] }],
  ['item create tracked label spaces', 'POST', '/items', { name: 'x', tracked_dates: [{ label: '  ', date: '2027-01-01' }] }],
  ['item create tracked bad day', 'POST', '/items', { name: 'x', tracked_dates: [day('2027-02-30')] }],
  ['item create tracked offset 366', 'POST', '/items', { name: 'x', tracked_dates: [{ ...day('2027-01-01'), reminder_offset_days: 366 }] }],
  ['item create tracked offset text', 'POST', '/items', { name: 'x', tracked_dates: [{ ...day('2027-01-01'), reminder_offset_days: '10' }] }],
  ['item create tracked offset empty', 'POST', '/items', { name: 'x', tracked_dates: [{ ...day('2027-01-01'), reminder_offset_days: '' }] }],
  ['item create tracked interval 0', 'POST', '/items', { name: 'x', tracked_dates: [{ ...day('2027-01-01'), interval_months: 0 }] }],
  ['item create tracked interval 601', 'POST', '/items', { name: 'x', tracked_dates: [{ ...day('2027-01-01'), interval_months: 601 }] }],
  ['item create tracked distance 0', 'POST', '/items', { name: 'x', tracked_dates: [{ ...day('2027-01-01'), interval_distance: 0 }] }],
  ['item create tracked distance fraction', 'POST', '/items', { name: 'x', tracked_dates: [{ ...day('2027-01-01'), interval_distance: 1.5 }] }],
  ['item create tracked bounds', 'POST', '/items', { name: 'Grenzen', tracked_dates: [{ ...day('2027-01-01'), reminder_offset_days: 365, interval_months: 600, interval_distance: 1 }, { ...day('2027-02-01'), reminder_offset_days: 0, interval_months: 1, interval_distance: null }] }],
  ['item create attachments null', 'POST', '/items', { name: 'x', attachment_document_ids: null }],
  ['item create attachments text', 'POST', '/items', { name: 'x', attachment_document_ids: 'abc' }],
  ['item create attachments unknown', 'POST', '/items', { name: 'Ohne Beleg', attachment_document_ids: [999] }],
  ['item create attachments no documents', 'POST', '/items', { name: 'x', attachment_document_ids: [DOC] }, { access: { documents: 'none' } }],
  ['item create entry', 'POST', '/items', { name: 'Kamera', entry_id: BOOKING }],
  ['item create entry already linked', 'POST', '/items', { name: 'Objektiv', entry_id: BOOKING }],
  ['item create entry with price', 'POST', '/items', { name: 'Stativ', entry_id: BOOKING_2, purchase_price: 10 }],
  ['item create entry unknown', 'POST', '/items', { name: 'x', entry_id: 999 }],
  ['item create entry zero', 'POST', '/items', { name: 'x', entry_id: 0 }],
  ['item create entry negative', 'POST', '/items', { name: 'x', entry_id: -3 }],
  ['item create entry empty', 'POST', '/items', { name: 'x', entry_id: '' }],
  ['item create entry text', 'POST', '/items', { name: 'x', entry_id: '1' }],
  ['item create entry null', 'POST', '/items', { name: 'Ohne Buchung', entry_id: null }],
  ['item create entry no budget', 'POST', '/items', { name: 'x', entry_id: BOOKING_3 }, { access: { budget: 'none' } }],
  ['item create several findings', 'POST', '/items', { name: '  ', purchase_price: -1, currency: 'EURO', category: 'nope' }],

  // ── items: read ───────────────────────────────────────────────────────────
  ['item list', 'GET', '/items', NO_BODY],
  ['item list child', 'GET', '/items?status=active&category=electronics', NO_BODY, { actor: 'child' }],
  ['item list no documents no budget', 'GET', '/items?category=vehicles', NO_BODY, { access: { documents: 'none', budget: 'none' } }],
  ['item list status', 'GET', '/items?status=lost', NO_BODY],
  ['item list status unknown', 'GET', '/items?status=bogus', NO_BODY],
  ['item list status empty', 'GET', '/items?status=', NO_BODY],
  ['item list status upper', 'GET', '/items?status=ACTIVE', NO_BODY],
  ['item list status twice', 'GET', '/items?status=active&status=lost', NO_BODY],
  ['item list category', 'GET', '/items?category=electronics', NO_BODY],
  ['item list category empty', 'GET', '/items?category=', NO_BODY],
  ['item list category twice', 'GET', '/items?category=electronics&category=other', NO_BODY],
  ['item list location', 'GET', '/items?location_id=__KELLER__', NO_BODY],
  ['item list location zero', 'GET', '/items?location_id=0', NO_BODY],
  ['item list location negative', 'GET', '/items?location_id=-1', NO_BODY],
  ['item list location empty', 'GET', '/items?location_id=', NO_BODY],
  ['item list location letters', 'GET', '/items?location_id=1abc', NO_BODY],
  ['item list location twice', 'GET', '/items?location_id=1&location_id=2', NO_BODY],
  ['item list q', 'GET', '/items?q=%20bosch%20', NO_BODY],
  ['item list q account', 'GET', '/items?q=linda@', NO_BODY],
  ['item list q empty', 'GET', '/items?q=', NO_BODY],
  ['item list q long', 'GET', `/items?q=${'B'.repeat(150)}`, NO_BODY],
  ['item list q twice', 'GET', '/items?q=a&q=b', NO_BODY],
  ['item get', 'GET', '/items/__DRILL__', NO_BODY],
  ['item get child', 'GET', '/items/__DRILL__', NO_BODY, { actor: 'child' }],
  ['item get unknown', 'GET', '/items/999', NO_BODY],
  ['item get zero', 'GET', '/items/0', NO_BODY],
  ['item get letters', 'GET', '/items/abc', NO_BODY],
  ['item get leading zero', 'GET', '/items/0__DRILL__', NO_BODY],

  // ── items: replace ────────────────────────────────────────────────────────
  ['item put', 'PUT', '/items/__DRILL__', () => ({ ...DRILL, name: 'Akkubohrer', location_id: Number(resolved('__REGAL1__')), warranty_months: 36, condition: 'fair' })],
  ['item put partial', 'PUT', '/items/__LAMPE__', { name: 'Stehlampe' }],
  ['item put child foreign', 'PUT', '/items/__DRILL__', { name: 'x' }, { actor: 'child' }],
  ['item put child foreign malformed', 'PUT', '/items/__DRILL__', { name: 'x', warranty_months: 601 }, { actor: 'child' }],
  ['item put child own', 'PUT', '/items/__KINDERRAD__', { name: 'Kinderrad blau', purchase_price: 99, currency: 'GBP' }, { actor: 'child' }],
  ['item put unknown', 'PUT', '/items/999', { name: 'x' }],
  ['item put zero', 'PUT', '/items/0', { name: 'x' }],
  ['item put no body', 'PUT', '/items/__DRILL__', NO_BODY],
  ['item put empty object', 'PUT', '/items/__DRILL__', {}],
  ['item put warranty 601', 'PUT', '/items/__DRILL__', { name: 'x', warranty_months: 601 }],
  ['item put warranty text', 'PUT', '/items/__DRILL__', { name: 'x', warranty_months: '6' }],
  ['item put condition unknown', 'PUT', '/items/__DRILL__', { name: 'x', condition: 'broken' }],
  ['item put status unknown', 'PUT', '/items/__DRILL__', { name: 'x', status: 'gone' }],
  ['item put location missing', 'PUT', '/items/__DRILL__', { name: 'x', location_id: 999 }],
  ['item put location empty', 'PUT', '/items/__DRILL__', { name: 'x', location_id: '' }],
  ['item put tracked null', 'PUT', '/items/__CAR__', { ...CAR, tracked_dates: null }],
  ['item put tracked text', 'PUT', '/items/__CAR__', { ...CAR, tracked_dates: {} }],
  ['item put tracked eleven', 'PUT', '/items/__CAR__', { ...CAR, tracked_dates: Array.from({ length: 11 }, () => day('2027-01-01')) }],
  ['item put tracked offset negative', 'PUT', '/items/__CAR__', { ...CAR, tracked_dates: [{ ...day('2027-01-01'), reminder_offset_days: -1 }] }],
  ['item put tracked bad day', 'PUT', '/items/__CAR__', { ...CAR, tracked_dates: [day('2027-13-01')] }],
  ['item put attachments null', 'PUT', '/items/__DRILL__', { name: 'x', attachment_document_ids: null }],
  ['item put attachments text entry', 'PUT', '/items/__DRILL__', { name: 'x', attachment_document_ids: ['1'] }],
  ['item put attachments no documents', 'PUT', '/items/__DRILL__', { name: 'x', attachment_document_ids: [DOC] }, { access: { documents: 'none' } }],
  ['item put odometer negative', 'PUT', '/items/__CAR__', { ...CAR, odometer: -1 }],
  ['item put odometer text', 'PUT', '/items/__CAR__', { ...CAR, odometer: '1000' }],
  ['item put odometer unit unknown', 'PUT', '/items/__CAR__', { ...CAR, odometer_unit: 'm' }],
  ['item put car without tracked', 'PUT', '/items/__CAR__', { name: 'Auto', category: 'vehicles', odometer: 1200, odometer_unit: 'mi' }],
  ['item put car to other category', 'PUT', '/items/__OLDTIMER__', { name: 'Oldtimer', category: 'other', odometer: 5, odometer_unit: 'km' }],

  // ── items: bookings ───────────────────────────────────────────────────────
  ['link', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, role: 'maintenance', amount_share: 40 }],
  ['link default role', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3 }],
  ['link again', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, role: 'maintenance' }],
  ['link role empty', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, role: '', amount_share: null }],
  ['link role null share zero', 'POST', '/items/__LAMPE__/entries', { entry_id: BOOKING_3, role: null, amount_share: 0 }],
  ['link share fraction', 'POST', '/items/__LAMPE__/entries', { entry_id: BOOKING_3, role: 'accessory', amount_share: 2.5 }],
  ['link role unknown', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, role: 'gift' }],
  ['link role false', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, role: false }],
  ['link role upper', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, role: 'PURCHASE' }],
  ['link share negative', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, amount_share: -1 }],
  ['link share text', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, amount_share: '5' }],
  ['link share empty', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, amount_share: '' }],
  ['link share true', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, amount_share: true }],
  ['link entry text', 'POST', '/items/__DRILL__/entries', { entry_id: String(BOOKING_3) }],
  ['link entry null', 'POST', '/items/__DRILL__/entries', { entry_id: null }],
  ['link entry missing', 'POST', '/items/__DRILL__/entries', { role: 'purchase' }],
  ['link entry zero', 'POST', '/items/__DRILL__/entries', { entry_id: 0 }],
  ['link entry negative', 'POST', '/items/__DRILL__/entries', { entry_id: -2 }],
  ['link entry unknown', 'POST', '/items/__DRILL__/entries', { entry_id: 999 }],
  ['link no budget', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_2 }, { access: { budget: 'none' } }],
  ['link item unknown', 'POST', '/items/999/entries', { entry_id: BOOKING_3 }],
  ['link item zero', 'POST', '/items/0/entries', { entry_id: BOOKING_3 }],
  ['link child foreign', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3 }, { actor: 'child' }],
  ['link child foreign malformed', 'POST', '/items/__DRILL__/entries', { entry_id: BOOKING_3, role: 'gift' }, { actor: 'child' }],
  ['link no body', 'POST', '/items/__DRILL__/entries', NO_BODY],
  ['unlink', 'DELETE', `/items/__LAMPE__/entries/${BOOKING_3}`, NO_BODY],
  ['unlink again', 'DELETE', `/items/__LAMPE__/entries/${BOOKING_3}`, NO_BODY],
  ['unlink entry zero', 'DELETE', '/items/__LAMPE__/entries/0', NO_BODY],
  ['unlink entry letters', 'DELETE', '/items/__LAMPE__/entries/abc', NO_BODY],
  ['unlink item unknown', 'DELETE', `/items/999/entries/${BOOKING_3}`, NO_BODY],
  ['unlink child foreign', 'DELETE', `/items/__DRILL__/entries/${BOOKING_3}`, NO_BODY, { actor: 'child' }],
  ['entries items', 'GET', `/entries/${BOOKING_3}/items`, NO_BODY],
  ['entries items purchase', 'GET', `/entries/${BOOKING}/items`, NO_BODY],
  ['entries items none', 'GET', `/entries/${BOOKING_2 + 100}/items`, NO_BODY],
  ['entries items zero', 'GET', '/entries/0/items', NO_BODY],
  ['entries items letters', 'GET', '/entries/abc/items', NO_BODY],
  ['entries items no budget', 'GET', `/entries/${BOOKING}/items`, NO_BODY, { access: { budget: 'none' } }],

  // ── items: tracked dates, service log, history ────────────────────────────
  ['complete', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-11-10', odometer: 1500, vendor: 'Dekra', note: 'ok' }],
  ['complete once', 'POST', '/items/__GRENZEN__/dates/__GRENZEN_DATE__/complete', { performed_on: '2026-11-11', odometer: null, vendor: null, note: null }],
  ['complete again gone', 'POST', '/items/__GRENZEN__/dates/__GRENZEN_DATE__/complete', { performed_on: '2026-11-11' }],
  ['complete regression', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-11-19', odometer: 1100 }],
  ['complete backdated lower', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-01-02', odometer: 100 }],
  ['complete odometer negative', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-11-12', odometer: -1 }],
  ['complete odometer fraction', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-11-12', odometer: 1.5 }],
  ['complete odometer text', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-11-12', odometer: '2000' }],
  ['complete odometer empty', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-11-12', odometer: '' }],
  ['complete day missing', 'POST', '/items/__CAR__/dates/__TUEV__/complete', {}],
  ['complete day empty', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '' }],
  ['complete day null', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: null }],
  ['complete bad day', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-02-30' }],
  ['complete note emoji', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-11-12', vendor: EMOJI_60 }],
  ['complete date unknown', 'POST', '/items/__CAR__/dates/999/complete', { performed_on: '2026-11-12' }],
  ['complete date zero', 'POST', '/items/__CAR__/dates/0/complete', { performed_on: '2026-11-12' }],
  ['complete item unknown', 'POST', '/items/999/dates/__TUEV__/complete', { performed_on: '2026-11-12' }],
  ['complete child foreign', 'POST', '/items/__CAR__/dates/__TUEV__/complete', { performed_on: '2026-11-12' }, { actor: 'child' }],
  ['complete no body', 'POST', '/items/__CAR__/dates/__TUEV__/complete', NO_BODY],
  ['log list', 'GET', '/items/__CAR__/service-log', NO_BODY],
  ['log list unknown', 'GET', '/items/999/service-log', NO_BODY],
  ['log list zero', 'GET', '/items/0/service-log', NO_BODY],
  ['log create', 'POST', '/items/__CAR__/service-log', { label: ' Ölwechsel ', performed_on: '2026-11-15', odometer: 1600, vendor: 'ATU' }],
  ['log create backdated', 'POST', '/items/__CAR__/service-log', { label: 'Reparatur', performed_on: '2026-02-01', odometer: 10, note: 'alt' }],
  ['log create no odometer', 'POST', '/items/__CAR__/service-log', { label: 'Waesche', performed_on: '2026-11-16', odometer: null }],
  ['log create regression', 'POST', '/items/__CAR__/service-log', { label: 'x', performed_on: '2026-11-19', odometer: 1 }],
  ['log create odometer negative', 'POST', '/items/__CAR__/service-log', { label: 'x', performed_on: '2026-11-17', odometer: -1 }],
  ['log create odometer fraction', 'POST', '/items/__CAR__/service-log', { label: 'x', performed_on: '2026-11-17', odometer: 1.5 }],
  ['log create odometer text', 'POST', '/items/__CAR__/service-log', { label: 'x', performed_on: '2026-11-17', odometer: '1700' }],
  ['log create odometer empty', 'POST', '/items/__CAR__/service-log', { label: 'x', performed_on: '2026-11-17', odometer: '' }],
  ['log create odometer true', 'POST', '/items/__CAR__/service-log', { label: 'x', performed_on: '2026-11-17', odometer: true }],
  ['log create label missing', 'POST', '/items/__CAR__/service-log', { performed_on: '2026-11-17' }],
  ['log create label spaces', 'POST', '/items/__CAR__/service-log', { label: '  ', performed_on: '2026-11-17' }],
  ['log create label emoji', 'POST', '/items/__CAR__/service-log', { label: EMOJI_60, performed_on: '2026-11-17' }],
  ['log create label number', 'POST', '/items/__CAR__/service-log', { label: 5, performed_on: '2026-11-17' }],
  ['log create day missing', 'POST', '/items/__CAR__/service-log', { label: 'x' }],
  ['log create bad day', 'POST', '/items/__CAR__/service-log', { label: 'x', performed_on: '2026-04-31' }],
  ['log create several findings', 'POST', '/items/__CAR__/service-log', { label: '  ', performed_on: '2026-04-31', note: 'a'.repeat(5000) }],
  ['log create non-vehicle', 'POST', '/items/__LAMPE__/service-log', { label: 'Birne', performed_on: '2026-11-17', odometer: 3 }],
  ['log create child foreign', 'POST', '/items/__CAR__/service-log', { label: 'x', performed_on: '2026-11-17' }, { actor: 'child' }],
  ['log create item unknown', 'POST', '/items/999/service-log', { label: 'x', performed_on: '2026-11-17' }],
  ['log put', 'PUT', '/items/__CAR__/service-log/__OELWECHSEL__', { label: 'Ölwechsel gross', performed_on: '2026-11-15', odometer: 1550 }],
  ['log put clears', 'PUT', '/items/__CAR__/service-log/__OELWECHSEL__', { label: 'Ölwechsel', performed_on: '2026-11-15' }],
  ['log put odometer negative', 'PUT', '/items/__CAR__/service-log/__OELWECHSEL__', { label: 'x', performed_on: '2026-11-15', odometer: -3 }],
  ['log put odometer text', 'PUT', '/items/__CAR__/service-log/__OELWECHSEL__', { label: 'x', performed_on: '2026-11-15', odometer: '3' }],
  ['log put unknown', 'PUT', '/items/__CAR__/service-log/999', { label: 'x', performed_on: '2026-11-15' }],
  ['log put unknown empty', 'PUT', '/items/__CAR__/service-log/999', {}],
  ['log put zero', 'PUT', '/items/__CAR__/service-log/0', { label: 'x', performed_on: '2026-11-15' }],
  ['log put child foreign', 'PUT', '/items/__CAR__/service-log/__OELWECHSEL__', { label: 'x', performed_on: '2026-11-15' }, { actor: 'child' }],
  ['history', 'GET', '/items/__CAR__/history', NO_BODY],
  ['history drill', 'GET', '/items/__DRILL__/history', NO_BODY],
  ['history no budget no documents', 'GET', '/items/__DRILL__/history', NO_BODY, { access: { budget: 'none', documents: 'none' } }],
  ['history unknown', 'GET', '/items/999/history', NO_BODY],
  ['history zero', 'GET', '/items/0/history', NO_BODY],
  ['log delete child foreign', 'DELETE', '/items/__CAR__/service-log/__OELWECHSEL__', NO_BODY, { actor: 'child' }],
  ['log delete', 'DELETE', '/items/__CAR__/service-log/__OELWECHSEL__', NO_BODY],
  ['log delete again', 'DELETE', '/items/__CAR__/service-log/__OELWECHSEL__', NO_BODY],
  ['log delete zero', 'DELETE', '/items/__CAR__/service-log/0', NO_BODY],
  ['log delete item unknown', 'DELETE', '/items/999/service-log/1', NO_BODY],
  ['item get car', 'GET', '/items/__CAR__', NO_BODY],

  // ── deadlines feed ────────────────────────────────────────────────────────
  ['feed status none', 'GET', '/deadlines-feed', NO_BODY],
  ['feed regenerate', 'POST', '/deadlines-feed/regenerate', NO_BODY],
  ['feed regenerate with body', 'POST', '/deadlines-feed/regenerate', { anything: 1 }],
  ['feed status', 'GET', '/deadlines-feed', NO_BODY],
  ['feed status child', 'GET', '/deadlines-feed', NO_BODY, { actor: 'child' }],
  ['feed delete', 'DELETE', '/deadlines-feed', NO_BODY],
  ['feed status after delete', 'GET', '/deadlines-feed', NO_BODY],

  // ── deletes at the end ────────────────────────────────────────────────────
  ['item delete child foreign', 'DELETE', '/items/__DRILL__', NO_BODY, { actor: 'child' }],
  ['item delete child own', 'DELETE', '/items/__KINDERRAD__', NO_BODY, { actor: 'child' }],
  ['item delete', 'DELETE', '/items/__LAMPE__', NO_BODY],
  ['item delete again', 'DELETE', '/items/__LAMPE__', NO_BODY],
  ['item delete zero', 'DELETE', '/items/0', NO_BODY],
  ['item delete letters', 'DELETE', '/items/12abc', NO_BODY],
  ['cat delete', 'DELETE', '/categories/electronics', NO_BODY],
  ['cat delete again', 'DELETE', '/categories/electronics', NO_BODY],
  ['loc sub delete', 'DELETE', '/locations/__KELLER__/subcategories/__REGAL1__', NO_BODY],
  ['loc sub delete again', 'DELETE', '/locations/__KELLER__/subcategories/__REGAL1__', NO_BODY],
  ['loc sub delete letters', 'DELETE', '/locations/__KELLER__/subcategories/abc', NO_BODY],
  ['loc delete', 'DELETE', '/locations/__KELLER__', NO_BODY],
  ['loc delete again', 'DELETE', '/locations/__KELLER__', NO_BODY],
  ['loc delete fraction', 'DELETE', '/locations/1.0', NO_BODY],
  ['item list end', 'GET', '/items', NO_BODY],
  ['loc list end', 'GET', '/locations', NO_BODY],
  ['cat list end', 'GET', '/categories', NO_BODY],
];

const locationId = (/** @type {string} */ name) => db.prepare('SELECT id FROM inventory_locations WHERE name = ?').get(name).id;
const itemId = (/** @type {string} */ name) => db.prepare('SELECT id FROM inventory_items WHERE name = ? ORDER BY id').get(name).id;

/** Ids that exist only once their row ran, by placeholder. */
const PLACEHOLDERS = {
  __KELLER__: () => locationId('Keller'),
  __GARAGE__: () => locationId('Garage'),
  __DACHBODEN__: () => locationId('Dachboden'),
  __REGAL1__: () => locationId('Regal 1'),
  __REGAL2__: () => locationId('Regal 2'),
  __SPIELE__: () => db.prepare("SELECT key FROM inventory_categories WHERE name = 'Spiele'").get().key,
  __SPORT__: () => db.prepare("SELECT key FROM inventory_categories WHERE name = 'Sport'").get().key,
  __DRILL__: () => itemId('Bohrmaschine'),
  __CAR__: () => itemId('Auto'),
  __LAMPE__: () => itemId('Lampe'),
  __KINDERRAD__: () => itemId('Kinderrad'),
  __OLDTIMER__: () => itemId('Oldtimer'),
  __GRENZEN__: () => itemId('Grenzen'),
  __GRENZEN_DATE__: () => db.prepare("SELECT id FROM inventory_item_dates WHERE item_id = ? AND date = '2027-02-01'").get(resolvedId('__GRENZEN__')).id,
  __TUEV__: () => db.prepare("SELECT id FROM inventory_item_dates WHERE label = 'TÜV'").get().id,
  __OELWECHSEL__: () => db.prepare("SELECT id FROM inventory_item_service_log WHERE label = 'Ölwechsel'").get().id,
};

/** @type {Map<string, number | string>} */
const resolvedIds = new Map();

/** @param {string} key */
function resolvedId(key) {
  if (!resolvedIds.has(key)) resolvedIds.set(key, /** @type {Record<string, () => number | string>} */ (PLACEHOLDERS)[key]());
  return /** @type {number | string} */ (resolvedIds.get(key));
}

/** A path or value with its placeholders as ids, each read once and kept: a row after its delete names the same id. @param {string} text */
function resolved(text) {
  return text.replace(/__[A-Z0-9_]+__/g, (key) => String(resolvedId(key)));
}

/** A body with its placeholders resolved (strings only, one level deep into lists). @param {unknown} body */
function resolvedBody(body) {
  if (typeof body === 'function') return body();
  if (Array.isArray(body)) return body.map((v) => (typeof v === 'string' ? resolved(v) : v));
  if (body && typeof body === 'object' && typeof body !== 'symbol') {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k,
      typeof v === 'string' ? resolved(v) : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? resolved(x) : x)) : v]));
  }
  return body;
}

// Written at 0462caa00 (before the refactor), literal.
/** @type {Record<string, { status: number, body: unknown }>} */
const EXPECTED = {
  "loc list empty": {"status":200,"body":{"data":[]}},
  "loc create": {"status":201,"body":{"data":{"id":1,"name":"Keller","parent_id":null,"icon":"box","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "loc create plain": {"status":201,"body":{"data":{"id":2,"name":"Garage","parent_id":null,"icon":"package","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "loc create third": {"status":201,"body":{"data":{"id":3,"name":"Dachboden","parent_id":null,"icon":"package","sort_order":2,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "loc create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "loc create array body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "loc create empty object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "loc create name empty": {"status":400,"body":{"error":"Name is required.","code":400}},
  "loc create name spaces": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  "loc create name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "loc create name null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "loc create name 101": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"maxLength"}]}},
  "loc create name emoji": {"status":400,"body":{"error":"Name may be at most 100 characters long.","code":400}},
  "loc create icon number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon","rule":"type"}]}},
  "loc create duplicate": {"status":409,"body":{"error":"Location already exists.","code":409,"reason":"inventory_location_exists"}},
  "loc create duplicate icon too long": {"status":409,"body":{"error":"Location already exists.","code":409,"reason":"inventory_location_exists"}},
  "loc create icon emoji": {"status":400,"body":{"error":"Icon may be at most 100 characters long.","code":400}},
  "loc put": {"status":200,"body":{"data":{"id":2,"name":"Carport","parent_id":null,"icon":"package","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "loc put icon": {"status":200,"body":{"data":{"id":2,"name":"Carport","parent_id":null,"icon":"car","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "loc put duplicate": {"status":409,"body":{"error":"Location already exists.","code":409,"reason":"inventory_location_exists"}},
  "loc put no name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "loc put name spaces": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  "loc put unknown": {"status":404,"body":{"error":"Location not found.","code":404,"reason":"inventory_location_not_found"}},
  "loc put unknown empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "loc put letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "loc put zero": {"status":404,"body":{"error":"Location not found.","code":404,"reason":"inventory_location_not_found"}},
  "loc sub create": {"status":201,"body":{"data":{"id":4,"name":"Regal 1","parent_id":1,"icon":"package","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "loc sub create second": {"status":201,"body":{"data":{"id":5,"name":"Regal 2","parent_id":1,"icon":"archive","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "loc sub create duplicate": {"status":409,"body":{"error":"Location already exists.","code":409,"reason":"inventory_location_exists"}},
  "loc sub create unknown parent": {"status":404,"body":{"error":"Location not found.","code":404,"reason":"inventory_location_not_found"}},
  "loc sub create unknown parent empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "loc sub create name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "loc sub create letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/parentId","rule":"type"}]}},
  "loc sub put": {"status":200,"body":{"data":{"id":4,"name":"Regal A","parent_id":1,"icon":"package","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "loc sub put duplicate": {"status":409,"body":{"error":"Location already exists.","code":409,"reason":"inventory_location_exists"}},
  "loc sub put wrong parent": {"status":404,"body":{"error":"Location not found.","code":404,"reason":"inventory_location_not_found"}},
  "loc sub put empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "loc reorder": {"status":200,"body":{"data":[{"id":3,"name":"Dachboden","parent_id":null,"icon":"package","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]},{"id":1,"name":"Keller","parent_id":null,"icon":"box","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[{"id":4,"name":"Regal A","parent_id":1,"icon":"package","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":5,"name":"Regal 2","parent_id":1,"icon":"archive","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":2,"name":"Carport","parent_id":null,"icon":"car","sort_order":2,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]}]}},
  "loc reorder numbers": {"status":200,"body":{"data":[{"id":2,"name":"Carport","parent_id":null,"icon":"car","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]},{"id":3,"name":"Dachboden","parent_id":null,"icon":"package","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]},{"id":1,"name":"Keller","parent_id":null,"icon":"box","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[{"id":4,"name":"Regal A","parent_id":1,"icon":"package","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":5,"name":"Regal 2","parent_id":1,"icon":"archive","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}]}},
  "loc reorder empty list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"minItems"}]}},
  "loc reorder no order": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"required"}]}},
  "loc reorder order text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "loc reorder order object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "loc reorder order null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "loc reorder no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "loc reorder array body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "loc reorder entry object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order/0","rule":"type"},{"path":"body/order/0","rule":"anyOf"}]}},
  "loc reorder entry letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order/0","rule":"type"},{"path":"body/order/0","rule":"pattern"},{"path":"body/order/0","rule":"anyOf"}]}},
  "loc sub reorder": {"status":200,"body":{"data":true}},
  "loc sub reorder empty list": {"status":200,"body":{"data":true}},
  "loc sub reorder no order": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"required"}]}},
  "loc sub reorder order text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "loc sub reorder order null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "loc sub reorder no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "loc sub reorder unknown parent": {"status":200,"body":{"data":true}},
  "loc sub reorder letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/parentId","rule":"type"}]}},
  "loc list": {"status":200,"body":{"data":[{"id":2,"name":"Carport","parent_id":null,"icon":"car","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]},{"id":3,"name":"Dachboden","parent_id":null,"icon":"package","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]},{"id":1,"name":"Keller","parent_id":null,"icon":"box","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[{"id":5,"name":"Regal 2","parent_id":1,"icon":"archive","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"name":"Regal A","parent_id":1,"icon":"package","sort_order":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}]}},
  "cat list": {"status":200,"body":{"data":[{"id":1,"key":"electronics","name":null,"label_key":"inventory.categoryElectronics","icon":"cpu","sort_order":0,"created_at":"<volatile>","tracks_odometer":0},{"id":2,"key":"vehicles","name":null,"label_key":"inventory.categoryVehicles","icon":"car","sort_order":1,"created_at":"<volatile>","tracks_odometer":1},{"id":3,"key":"household","name":null,"label_key":"inventory.categoryHousehold","icon":"home","sort_order":2,"created_at":"<volatile>","tracks_odometer":0},{"id":4,"key":"sports","name":null,"label_key":"inventory.categorySports","icon":"dumbbell","sort_order":3,"created_at":"<volatile>","tracks_odometer":0},{"id":5,"key":"other","name":null,"label_key":"inventory.categoryOther","icon":"package","sort_order":4,"created_at":"<volatile>","tracks_odometer":0}]}},
  "cat create": {"status":201,"body":{"data":{"id":6,"key":"spiele","name":"Spiele","label_key":null,"icon":"dice","sort_order":5,"created_at":"<volatile>","tracks_odometer":0}}},
  "cat create plain": {"status":201,"body":{"data":{"id":7,"key":"sport","name":"Sport","label_key":null,"icon":"package","sort_order":6,"created_at":"<volatile>","tracks_odometer":0}}},
  "cat create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "cat create empty object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "cat create name spaces": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  "cat create name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "cat create name emoji": {"status":400,"body":{"error":"Name may be at most 100 characters long.","code":400}},
  "cat create duplicate": {"status":409,"body":{"error":"Category already exists.","code":409,"reason":"category_exists"}},
  "cat create icon list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon","rule":"type"}]}},
  "cat put": {"status":200,"body":{"data":{"id":6,"key":"spiele","name":"Brettspiele","label_key":null,"icon":"puzzle","sort_order":5,"created_at":"<volatile>","tracks_odometer":0}}},
  "cat put duplicate": {"status":409,"body":{"error":"Category already exists.","code":409,"reason":"category_exists"}},
  "cat put unknown": {"status":404,"body":{"error":"Category not found.","code":404,"reason":"inventory_category_not_found"}},
  "cat put unknown empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "cat put name null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "cat reorder": {"status":200,"body":{"data":[{"id":7,"key":"sport","name":"Sport","label_key":null,"icon":"package","sort_order":0,"created_at":"<volatile>","tracks_odometer":0},{"id":5,"key":"other","name":null,"label_key":"inventory.categoryOther","icon":"package","sort_order":1,"created_at":"<volatile>","tracks_odometer":0},{"id":6,"key":"spiele","name":"Brettspiele","label_key":null,"icon":"puzzle","sort_order":2,"created_at":"<volatile>","tracks_odometer":0}]}},
  "cat reorder unknown key": {"status":400,"body":{"error":"Unknown category key(s): nope, gibtsnicht.","code":400}},
  "cat reorder empty list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"minItems"}]}},
  "cat reorder no order": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"required"}]}},
  "cat reorder order text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "cat reorder order null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "cat reorder no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "cat reorder entry number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order/0","rule":"type"}]}},
  "cat delete other": {"status":400,"body":{"error":"The 'other' category cannot be deleted.","code":400}},
  "cat delete unknown": {"status":404,"body":{"error":"Category not found.","code":404,"reason":"inventory_category_not_found"}},
  "item list empty": {"status":200,"body":{"data":[]}},
  "item create": {"status":201,"body":{"data":{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"electronics","category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create car": {"status":201,"body":{"data":{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1000,"odometer_unit":"km","odometer_on":"2026-10-01","category_name":"vehicles","category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2027-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]}}},
  "item create plain": {"status":201,"body":{"data":{"id":3,"name":"Lampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "item create array body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "item create empty object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "item create name spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "item create name emoji": {"status":400,"body":{"error":"name may be at most 200 characters long.","code":400}},
  "item create name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "item create brand list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/brand","rule":"type"}]}},
  "item create category unknown": {"status":400,"body":{"error":"category must be one of: electronics, household, other, spiele, sport, sports, vehicles.","code":400}},
  "item create category number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/category","rule":"type"}]}},
  "item create location missing": {"status":400,"body":{"error":"Location not found.","code":400,"reason":"inventory_selected_location_not_found"}},
  "item create location missing text": {"status":400,"body":{"error":"Location not found.","code":400,"reason":"inventory_selected_location_not_found"}},
  "item create location missing and name": {"status":400,"body":{"error":"name must not be empty. Location not found.","code":400}},
  "item create location zero": {"status":400,"body":{"error":"location_id must be a positive number.","code":400}},
  "item create location zero text": {"status":400,"body":{"error":"location_id must be a positive number.","code":400}},
  "item create location negative": {"status":400,"body":{"error":"location_id must be a positive number.","code":400}},
  "item create location empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/location_id","rule":"type"},{"path":"body/location_id","rule":"pattern"},{"path":"body/location_id","rule":"anyOf"}]}},
  "item create location letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/location_id","rule":"type"},{"path":"body/location_id","rule":"pattern"},{"path":"body/location_id","rule":"anyOf"}]}},
  "item create location fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/location_id","rule":"type"},{"path":"body/location_id","rule":"anyOf"}]}},
  "item create location true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/location_id","rule":"type"},{"path":"body/location_id","rule":"anyOf"}]}},
  "item create location list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/location_id","rule":"type"},{"path":"body/location_id","rule":"anyOf"}]}},
  "item create location huge": {"status":400,"body":{"error":"Location not found.","code":400,"reason":"inventory_selected_location_not_found"}},
  "item create purchase date bad day": {"status":400,"body":{"error":"purchase_date must be a valid calendar date.","code":400}},
  "item create purchase date form": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/purchase_date","rule":"pattern"}]}},
  "item create purchase date list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/purchase_date","rule":"type"}]}},
  "item create price negative": {"status":400,"body":{"error":"purchase_price must not be negative.","code":400}},
  "item create price text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/purchase_price","rule":"type"}]}},
  "item create price empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/purchase_price","rule":"type"}]}},
  "item create price true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/purchase_price","rule":"type"}]}},
  "item create price child": {"status":201,"body":{"data":{"id":4,"name":"Kinderrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create price negative child": {"status":201,"body":{"data":{"id":5,"name":"Kinderball","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create price text child": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/purchase_price","rule":"type"}]}},
  "item create currency long": {"status":400,"body":{"error":"Currency must be a three-letter ISO code.","code":400}},
  "item create currency number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/currency","rule":"type"}]}},
  "item create warranty 600": {"status":201,"body":{"data":{"id":6,"name":"Ewig","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":600,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create warranty 0": {"status":201,"body":{"data":{"id":7,"name":"Kurz","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":0,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create warranty 601": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"maximum"}]}},
  "item create warranty negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"minimum"}]}},
  "item create warranty fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"type"}]}},
  "item create warranty text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"type"}]}},
  "item create warranty empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"type"}]}},
  "item create warranty true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"type"}]}},
  "item create warranty infinite": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"type"}]}},
  "item create warranty 24.0": {"status":201,"body":{"data":{"id":8,"name":"Zwei Jahre","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":24,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create condition unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/condition","rule":"enum"}]}},
  "item create condition upper": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/condition","rule":"enum"}]}},
  "item create condition false": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/condition","rule":"type"}]}},
  "item create condition zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/condition","rule":"type"}]}},
  "item create condition poor": {"status":201,"body":{"data":{"id":9,"name":"Alt","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"poor","status":"lost","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create status unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/status","rule":"enum"}]}},
  "item create status number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/status","rule":"type"}]}},
  "item create odometer non-vehicle": {"status":201,"body":{"data":{"id":10,"name":"Fahrrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create odometer text non-vehicle": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "item create odometer negative": {"status":400,"body":{"error":"odometer must be a whole number of at least 0.","code":400}},
  "item create odometer negative non-vehicle": {"status":201,"body":{"data":{"id":11,"name":"Roller","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create odometer fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "item create odometer text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "item create odometer empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "item create odometer no unit": {"status":201,"body":{"data":{"id":12,"name":"Moped","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":20,"odometer_unit":"km","odometer_on":"2026-11-18","category_name":"vehicles","category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create odometer null": {"status":201,"body":{"data":{"id":13,"name":"Anhaenger","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"vehicles","category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create odometer mi": {"status":201,"body":{"data":{"id":14,"name":"Oldtimer","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":70000,"odometer_unit":"mi","odometer_on":"2026-05-05","category_name":"vehicles","category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create odometer unit unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer_unit","rule":"enum"}]}},
  "item create odometer unit upper": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer_unit","rule":"enum"}]}},
  "item create odometer unit false": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer_unit","rule":"type"}]}},
  "item create odometer on bad day": {"status":400,"body":{"error":"odometer_on must be a valid calendar date.","code":400}},
  "item create photo number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/photo_data","rule":"type"}]}},
  "item create photo text": {"status":400,"body":{"error":"Photo must be a valid image data URL.","code":400}},
  "item create photo mismatch": {"status":400,"body":{"error":"Photo content does not match its image type.","code":400}},
  "item create photo emoji over length": {"status":400,"body":{"error":"Photo is too large.","code":400}},
  "item create photo too long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/photo_data","rule":"maxLength"}]}},
  "item create notes 5001": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/notes","rule":"maxLength"}]}},
  "item create tracked null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates","rule":"type"}]}},
  "item create tracked text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates","rule":"type"}]}},
  "item create tracked eleven": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates","rule":"maxItems"}]}},
  "item create tracked row text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0","rule":"type"}]}},
  "item create tracked no label": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/label","rule":"required"}]}},
  "item create tracked label spaces": {"status":400,"body":{"error":"label must not be empty.","code":400}},
  "item create tracked bad day": {"status":400,"body":{"error":"date must be a valid calendar date.","code":400}},
  "item create tracked offset 366": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/reminder_offset_days","rule":"maximum"}]}},
  "item create tracked offset text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/reminder_offset_days","rule":"type"}]}},
  "item create tracked offset empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/reminder_offset_days","rule":"type"}]}},
  "item create tracked interval 0": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/interval_months","rule":"minimum"}]}},
  "item create tracked interval 601": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/interval_months","rule":"maximum"}]}},
  "item create tracked distance 0": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/interval_distance","rule":"minimum"}]}},
  "item create tracked distance fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/interval_distance","rule":"type"}]}},
  "item create tracked bounds": {"status":201,"body":{"data":{"id":15,"name":"Grenzen","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":3,"item_id":15,"label":"Frist","date":"2027-01-01","reminder_offset_days":365,"interval_months":600,"interval_distance":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"item_id":15,"label":"Frist","date":"2027-02-01","reminder_offset_days":0,"interval_months":1,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]}}},
  "item create attachments null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/attachment_document_ids","rule":"type"}]}},
  "item create attachments text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/attachment_document_ids","rule":"type"}]}},
  "item create attachments unknown": {"status":201,"body":{"data":{"id":16,"name":"Ohne Beleg","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create attachments no documents": {"status":403,"body":{"error":"Linking a document requires access to documents.","code":403,"reason":"cross_module_access"}},
  "item create entry": {"status":201,"body":{"data":{"id":17,"name":"Kamera","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":120,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":1,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]}}},
  "item create entry already linked": {"status":201,"body":{"data":{"id":18,"name":"Objektiv","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":2,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]}}},
  "item create entry with price": {"status":201,"body":{"data":{"id":19,"name":"Stativ","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":10,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":3,"entry_id":2,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-35.5,"date":"2026-11-01"}],"linked_entries_total":-35.5,"tracked_dates":[]}}},
  "item create entry unknown": {"status":404,"body":{"error":"Booking not found.","code":404,"reason":"inventory_booking_not_found"}},
  "item create entry zero": {"status":400,"body":{"error":"entry_id must be a positive number.","code":400}},
  "item create entry negative": {"status":400,"body":{"error":"entry_id must be a positive number.","code":400}},
  "item create entry empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entry_id","rule":"type"}]}},
  "item create entry text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entry_id","rule":"type"}]}},
  "item create entry null": {"status":201,"body":{"data":{"id":20,"name":"Ohne Buchung","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item create entry no budget": {"status":404,"body":{"error":"Booking not found.","code":404,"reason":"inventory_booking_not_found"}},
  "item create several findings": {"status":400,"body":{"error":"name must not be empty. category must be one of: electronics, household, other, spiele, sport, sports, vehicles. purchase_price must not be negative. Currency must be a three-letter ISO code.","code":400}},
  "item list": {"status":200,"body":{"data":[{"id":9,"name":"Alt","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"poor","status":"lost","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":13,"name":"Anhaenger","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1000,"odometer_unit":"km","odometer_on":"2026-10-01","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2027-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":6,"name":"Ewig","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":600,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":10,"name":"Fahrrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":15,"name":"Grenzen","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":3,"item_id":15,"label":"Frist","date":"2027-01-01","reminder_offset_days":365,"interval_months":600,"interval_distance":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"item_id":15,"label":"Frist","date":"2027-02-01","reminder_offset_days":0,"interval_months":1,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":17,"name":"Kamera","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":120,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":1,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]},{"id":5,"name":"Kinderball","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":4,"name":"Kinderrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":7,"name":"Kurz","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":0,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":3,"name":"Lampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":12,"name":"Moped","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":20,"odometer_unit":"km","odometer_on":"2026-11-18","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":18,"name":"Objektiv","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":2,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]},{"id":16,"name":"Ohne Beleg","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":20,"name":"Ohne Buchung","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":14,"name":"Oldtimer","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":70000,"odometer_unit":"mi","odometer_on":"2026-05-05","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":11,"name":"Roller","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":19,"name":"Stativ","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":10,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":3,"entry_id":2,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-35.5,"date":"2026-11-01"}],"linked_entries_total":-35.5,"tracked_dates":[]},{"id":8,"name":"Zwei Jahre","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":24,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list child": {"status":200,"body":{"data":[{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list no documents no budget": {"status":200,"body":{"data":[{"id":13,"name":"Anhaenger","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":null,"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1000,"odometer_unit":"km","odometer_on":"2026-10-01","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":null,"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2027-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":12,"name":"Moped","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":20,"odometer_unit":"km","odometer_on":"2026-11-18","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":null,"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":14,"name":"Oldtimer","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":70000,"odometer_unit":"mi","odometer_on":"2026-05-05","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":null,"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list status": {"status":200,"body":{"data":[{"id":9,"name":"Alt","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"poor","status":"lost","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list status unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"enum"}]}},
  "item list status empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"enum"}]}},
  "item list status upper": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"enum"}]}},
  "item list status twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"type"}]}},
  "item list category": {"status":200,"body":{"data":[{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list category empty": {"status":200,"body":{"data":[{"id":9,"name":"Alt","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"poor","status":"lost","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":13,"name":"Anhaenger","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1000,"odometer_unit":"km","odometer_on":"2026-10-01","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2027-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":6,"name":"Ewig","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":600,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":10,"name":"Fahrrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":15,"name":"Grenzen","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":3,"item_id":15,"label":"Frist","date":"2027-01-01","reminder_offset_days":365,"interval_months":600,"interval_distance":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"item_id":15,"label":"Frist","date":"2027-02-01","reminder_offset_days":0,"interval_months":1,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":17,"name":"Kamera","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":120,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":1,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]},{"id":5,"name":"Kinderball","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":4,"name":"Kinderrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":7,"name":"Kurz","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":0,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":3,"name":"Lampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":12,"name":"Moped","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":20,"odometer_unit":"km","odometer_on":"2026-11-18","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":18,"name":"Objektiv","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":2,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]},{"id":16,"name":"Ohne Beleg","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":20,"name":"Ohne Buchung","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":14,"name":"Oldtimer","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":70000,"odometer_unit":"mi","odometer_on":"2026-05-05","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":11,"name":"Roller","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":19,"name":"Stativ","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":10,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":3,"entry_id":2,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-35.5,"date":"2026-11-01"}],"linked_entries_total":-35.5,"tracked_dates":[]},{"id":8,"name":"Zwei Jahre","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":24,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list category twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/category","rule":"type"}]}},
  "item list location": {"status":200,"body":{"data":[{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list location zero": {"status":400,"body":{"error":"location_id must be a positive number.","code":400}},
  "item list location negative": {"status":400,"body":{"error":"location_id must be a positive number.","code":400}},
  "item list location empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/location_id","rule":"type"}]}},
  "item list location letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/location_id","rule":"type"}]}},
  "item list location twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/location_id","rule":"type"}]}},
  "item list q": {"status":200,"body":{"data":[{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list q account": {"status":200,"body":{"data":[{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list q empty": {"status":200,"body":{"data":[{"id":9,"name":"Alt","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"poor","status":"lost","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":13,"name":"Anhaenger","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1000,"odometer_unit":"km","odometer_on":"2026-10-01","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2027-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":6,"name":"Ewig","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":600,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":10,"name":"Fahrrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":15,"name":"Grenzen","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":3,"item_id":15,"label":"Frist","date":"2027-01-01","reminder_offset_days":365,"interval_months":600,"interval_distance":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"item_id":15,"label":"Frist","date":"2027-02-01","reminder_offset_days":0,"interval_months":1,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":17,"name":"Kamera","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":120,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":1,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]},{"id":5,"name":"Kinderball","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":4,"name":"Kinderrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":7,"name":"Kurz","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":0,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":3,"name":"Lampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":12,"name":"Moped","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":20,"odometer_unit":"km","odometer_on":"2026-11-18","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":18,"name":"Objektiv","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":2,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]},{"id":16,"name":"Ohne Beleg","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":20,"name":"Ohne Buchung","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":14,"name":"Oldtimer","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":70000,"odometer_unit":"mi","odometer_on":"2026-05-05","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":11,"name":"Roller","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":19,"name":"Stativ","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":10,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":3,"entry_id":2,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-35.5,"date":"2026-11-01"}],"linked_entries_total":-35.5,"tracked_dates":[]},{"id":8,"name":"Zwei Jahre","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":24,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "item list q long": {"status":200,"body":{"data":[]}},
  "item list q twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/q","rule":"type"}]}},
  "item get": {"status":200,"body":{"data":{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"electronics","category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item get child": {"status":200,"body":{"data":{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"electronics","category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item get unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "item get zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "item get letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "item get leading zero": {"status":200,"body":{"data":{"id":1,"name":"Bohrmaschine","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":1,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":24,"condition":"new","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"electronics","category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item put": {"status":200,"body":{"data":{"id":1,"name":"Akkubohrer","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":4,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":36,"condition":"fair","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"electronics","category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller · Regal A","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item put partial": {"status":200,"body":{"data":{"id":3,"name":"Stehlampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item put child foreign": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "item put child foreign malformed": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"maximum"}]}},
  "item put child own": {"status":200,"body":{"data":{"id":4,"name":"Kinderrad blau","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "item put unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "item put zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "item put no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "item put empty object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "item put warranty 601": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"maximum"}]}},
  "item put warranty text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/warranty_months","rule":"type"}]}},
  "item put condition unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/condition","rule":"enum"}]}},
  "item put status unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/status","rule":"enum"}]}},
  "item put location missing": {"status":400,"body":{"error":"Location not found.","code":400,"reason":"inventory_selected_location_not_found"}},
  "item put location empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/location_id","rule":"type"},{"path":"body/location_id","rule":"pattern"},{"path":"body/location_id","rule":"anyOf"}]}},
  "item put tracked null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates","rule":"type"}]}},
  "item put tracked text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates","rule":"type"}]}},
  "item put tracked eleven": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates","rule":"maxItems"}]}},
  "item put tracked offset negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/tracked_dates/0/reminder_offset_days","rule":"minimum"}]}},
  "item put tracked bad day": {"status":400,"body":{"error":"date must be a valid calendar date.","code":400}},
  "item put attachments null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/attachment_document_ids","rule":"type"}]}},
  "item put attachments text entry": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/attachment_document_ids/0","rule":"type"}]}},
  "item put attachments no documents": {"status":403,"body":{"error":"Linking a document requires access to documents.","code":403,"reason":"cross_module_access"}},
  "item put odometer negative": {"status":400,"body":{"error":"odometer must be a whole number of at least 0.","code":400}},
  "item put odometer text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "item put odometer unit unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer_unit","rule":"enum"}]}},
  "item put car without tracked": {"status":200,"body":{"data":{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1200,"odometer_unit":"mi","odometer_on":"2026-11-18","category_name":"vehicles","category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2027-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]}}},
  "item put car to other category": {"status":200,"body":{"data":{"id":14,"name":"Oldtimer","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "link": {"status":201,"body":{"data":{"id":1,"name":"Akkubohrer","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":4,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":36,"condition":"fair","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"electronics","category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller · Regal A","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[{"id":4,"entry_id":3,"role":"maintenance","amount_share":40,"created_at":"<volatile>","title":"Kauf","amount":-80,"date":"2026-11-01"}],"linked_entries_total":-80,"tracked_dates":[]}}},
  "link default role": {"status":201,"body":{"data":{"id":1,"name":"Akkubohrer","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"electronics","location_id":4,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":36,"condition":"fair","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"electronics","category_icon":"cpu","category_label_key":"inventory.categoryElectronics","location_path":"Keller · Regal A","attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[{"id":5,"entry_id":3,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-80,"date":"2026-11-01"},{"id":4,"entry_id":3,"role":"maintenance","amount_share":40,"created_at":"<volatile>","title":"Kauf","amount":-80,"date":"2026-11-01"}],"linked_entries_total":-160,"tracked_dates":[]}}},
  "link again": {"status":409,"body":{"error":"This booking is already linked with this role.","code":409,"reason":"inventory_booking_already_linked"}},
  "link role empty": {"status":409,"body":{"error":"This booking is already linked with this role.","code":409,"reason":"inventory_booking_already_linked"}},
  "link role null share zero": {"status":201,"body":{"data":{"id":3,"name":"Stehlampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":6,"entry_id":3,"role":"purchase","amount_share":0,"created_at":"<volatile>","title":"Kauf","amount":-80,"date":"2026-11-01"}],"linked_entries_total":-80,"tracked_dates":[]}}},
  "link share fraction": {"status":201,"body":{"data":{"id":3,"name":"Stehlampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":7,"entry_id":3,"role":"accessory","amount_share":2.5,"created_at":"<volatile>","title":"Kauf","amount":-80,"date":"2026-11-01"},{"id":6,"entry_id":3,"role":"purchase","amount_share":0,"created_at":"<volatile>","title":"Kauf","amount":-80,"date":"2026-11-01"}],"linked_entries_total":-160,"tracked_dates":[]}}},
  "link role unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/role","rule":"enum"}]}},
  "link role false": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/role","rule":"type"}]}},
  "link role upper": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/role","rule":"enum"}]}},
  "link share negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount_share","rule":"minimum"}]}},
  "link share text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount_share","rule":"type"}]}},
  "link share empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount_share","rule":"type"}]}},
  "link share true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount_share","rule":"type"}]}},
  "link entry text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entry_id","rule":"type"}]}},
  "link entry null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entry_id","rule":"type"}]}},
  "link entry missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entry_id","rule":"required"}]}},
  "link entry zero": {"status":400,"body":{"error":"entry_id must be a positive number.","code":400}},
  "link entry negative": {"status":400,"body":{"error":"entry_id must be a positive number.","code":400}},
  "link entry unknown": {"status":404,"body":{"error":"Booking not found.","code":404,"reason":"inventory_booking_not_found"}},
  "link no budget": {"status":404,"body":{"error":"Booking not found.","code":404,"reason":"inventory_booking_not_found"}},
  "link item unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "link item zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "link child foreign": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "link child foreign malformed": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/role","rule":"enum"}]}},
  "link no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "unlink": {"status":200,"body":{"data":{"id":3,"name":"Stehlampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "unlink again": {"status":200,"body":{"data":{"id":3,"name":"Stehlampe","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}}},
  "unlink entry zero": {"status":400,"body":{"error":"entryId must be a positive number.","code":400}},
  "unlink entry letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/entryId","rule":"type"}]}},
  "unlink item unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "unlink child foreign": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "entries items": {"status":200,"body":{"data":[{"id":1,"name":"Akkubohrer","role":"maintenance"},{"id":1,"name":"Akkubohrer","role":"purchase"}]}},
  "entries items purchase": {"status":200,"body":{"data":[{"id":17,"name":"Kamera","role":"purchase"},{"id":18,"name":"Objektiv","role":"purchase"}]}},
  "entries items none": {"status":404,"body":{"error":"Booking not found.","code":404}},
  "entries items zero": {"status":400,"body":{"error":"entryId must be a positive number.","code":400}},
  "entries items letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/entryId","rule":"type"}]}},
  "entries items no budget": {"status":404,"body":{"error":"Booking not found.","code":404}},
  "complete": {"status":201,"body":{"data":{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1200,"odometer_unit":"mi","odometer_on":"2026-11-18","category_name":"vehicles","category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2029-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]}}},
  "complete once": {"status":201,"body":{"data":{"id":15,"name":"Grenzen","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":3,"item_id":15,"label":"Frist","date":"2027-01-01","reminder_offset_days":365,"interval_months":600,"interval_distance":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"item_id":15,"label":"Frist","date":"2027-03-01","reminder_offset_days":0,"interval_months":1,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]}}},
  "complete again gone": {"status":201,"body":{"data":{"id":15,"name":"Grenzen","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":"other","category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":3,"item_id":15,"label":"Frist","date":"2027-01-01","reminder_offset_days":365,"interval_months":600,"interval_distance":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"item_id":15,"label":"Frist","date":"2027-04-01","reminder_offset_days":0,"interval_months":1,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]}}},
  "complete regression": {"status":400,"body":{"error":"odometer must not fall below the last recorded reading (1200).","code":400}},
  "complete backdated lower": {"status":201,"body":{"data":{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1200,"odometer_unit":"mi","odometer_on":"2026-11-18","category_name":"vehicles","category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2031-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]}}},
  "complete odometer negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"minimum"}]}},
  "complete odometer fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "complete odometer text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "complete odometer empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "complete day missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/performed_on","rule":"required"}]}},
  "complete day empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/performed_on","rule":"pattern"}]}},
  "complete day null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/performed_on","rule":"type"}]}},
  "complete bad day": {"status":400,"body":{"error":"performed_on must be a valid calendar date.","code":400}},
  "complete note emoji": {"status":400,"body":{"error":"vendor may be at most 100 characters long.","code":400}},
  "complete date unknown": {"status":404,"body":{"error":"Tracked date not found.","code":404,"reason":"inventory_tracked_date_not_found"}},
  "complete date zero": {"status":400,"body":{"error":"dateId must be a positive number.","code":400}},
  "complete item unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "complete child foreign": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "complete no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "log list": {"status":200,"body":{"data":[{"id":1,"item_id":2,"item_date_id":1,"label":"TÜV","performed_on":"2026-11-10","odometer":1500,"vendor":"Dekra","note":"ok","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"item_id":2,"item_date_id":1,"label":"TÜV","performed_on":"2026-01-02","odometer":100,"vendor":null,"note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "log list unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "log list zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "log create": {"status":201,"body":{"data":{"id":5,"item_id":2,"item_date_id":null,"label":"Ölwechsel","performed_on":"2026-11-15","odometer":1600,"vendor":"ATU","note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "log create backdated": {"status":201,"body":{"data":{"id":6,"item_id":2,"item_date_id":null,"label":"Reparatur","performed_on":"2026-02-01","odometer":10,"vendor":null,"note":"alt","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "log create no odometer": {"status":201,"body":{"data":{"id":7,"item_id":2,"item_date_id":null,"label":"Waesche","performed_on":"2026-11-16","odometer":null,"vendor":null,"note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "log create regression": {"status":400,"body":{"error":"odometer must not fall below the last recorded reading (1200).","code":400}},
  "log create odometer negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"minimum"}]}},
  "log create odometer fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "log create odometer text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "log create odometer empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "log create odometer true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "log create label missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/label","rule":"required"}]}},
  "log create label spaces": {"status":400,"body":{"error":"label must not be empty.","code":400}},
  "log create label emoji": {"status":400,"body":{"error":"label may be at most 100 characters long.","code":400}},
  "log create label number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/label","rule":"type"}]}},
  "log create day missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/performed_on","rule":"required"}]}},
  "log create bad day": {"status":400,"body":{"error":"performed_on must be a valid calendar date.","code":400}},
  "log create several findings": {"status":400,"body":{"error":"label must not be empty. performed_on must be a valid calendar date.","code":400}},
  "log create non-vehicle": {"status":201,"body":{"data":{"id":8,"item_id":3,"item_date_id":null,"label":"Birne","performed_on":"2026-11-17","odometer":3,"vendor":null,"note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "log create child foreign": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "log create item unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "log put": {"status":200,"body":{"data":{"id":5,"item_id":2,"item_date_id":null,"label":"Ölwechsel gross","performed_on":"2026-11-15","odometer":1550,"vendor":null,"note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "log put clears": {"status":200,"body":{"data":{"id":5,"item_id":2,"item_date_id":null,"label":"Ölwechsel","performed_on":"2026-11-15","odometer":null,"vendor":null,"note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "log put odometer negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"minimum"}]}},
  "log put odometer text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/odometer","rule":"type"}]}},
  "log put unknown": {"status":404,"body":{"error":"Service log entry not found.","code":404}},
  "log put unknown empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/label","rule":"required"}]}},
  "log put zero": {"status":400,"body":{"error":"logId must be a positive number.","code":400}},
  "log put child foreign": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "history": {"status":200,"body":{"data":{"timeline":[{"type":"service_log","id":7,"date":"2026-11-16","label":"Waesche","odometer":null,"vendor":null,"note":null},{"type":"service_log","id":5,"date":"2026-11-15","label":"Ölwechsel","odometer":null,"vendor":null,"note":null},{"type":"service_log","id":1,"date":"2026-11-10","label":"TÜV","odometer":1500,"vendor":"Dekra","note":"ok"},{"type":"service_log","id":6,"date":"2026-02-01","label":"Reparatur","odometer":10,"vendor":null,"note":"alt"},{"type":"service_log","id":4,"date":"2026-01-02","label":"TÜV","odometer":100,"vendor":null,"note":null}],"total":0}}},
  "history drill": {"status":200,"body":{"data":{"timeline":[{"type":"document","id":1,"date":"2026-11-18","label":"Beleg"},{"type":"budget_entry","id":3,"date":"2026-11-01","label":"Kauf","role":"maintenance","amount":-80}],"total":-80}}},
  "history no budget no documents": {"status":200,"body":{"data":{"timeline":[],"total":0}}},
  "history unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "history zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "log delete child foreign": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "log delete": {"status":204,"body":null},
  "log delete again": {"status":404,"body":{"error":"Service log entry not found.","code":404}},
  "log delete zero": {"status":400,"body":{"error":"logId must be a positive number.","code":400}},
  "log delete item unknown": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "item get car": {"status":200,"body":{"data":{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1200,"odometer_unit":"mi","odometer_on":"2026-11-18","category_name":"vehicles","category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2031-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]}}},
  "feed status none": {"status":200,"body":{"data":null}},
  "feed regenerate": {"status":200,"body":{"data":{"token":"<volatile>","url":"<volatile>"}}},
  "feed regenerate with body": {"status":200,"body":{"data":{"token":"<volatile>","url":"<volatile>"}}},
  "feed status": {"status":200,"body":{"data":{"token":"<volatile>","url":"<volatile>"}}},
  "feed status child": {"status":200,"body":{"data":null}},
  "feed delete": {"status":200,"body":{"data":{"token":null}}},
  "feed status after delete": {"status":200,"body":{"data":null}},
  "item delete child foreign": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "item delete child own": {"status":204,"body":null},
  "item delete": {"status":204,"body":null},
  "item delete again": {"status":404,"body":{"error":"Item not found.","code":404,"reason":"inventory_item_not_found"}},
  "item delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "item delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "cat delete": {"status":200,"body":{"ok":true,"reassigned":1}},
  "cat delete again": {"status":404,"body":{"error":"Category not found.","code":404,"reason":"inventory_category_not_found"}},
  "loc sub delete": {"status":200,"body":{"ok":true,"orphanedItems":1}},
  "loc sub delete again": {"status":404,"body":{"error":"Location not found.","code":404,"reason":"inventory_location_not_found"}},
  "loc sub delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "loc delete": {"status":200,"body":{"ok":true,"orphanedItems":0,"orphanedChildren":1}},
  "loc delete again": {"status":404,"body":{"error":"Location not found.","code":404,"reason":"inventory_location_not_found"}},
  "loc delete fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "item list end": {"status":200,"body":{"data":[{"id":1,"name":"Akkubohrer","brand":"Bosch","model":"PSB","serial_number":"SN1","category":"other","location_id":null,"purchase_date":"2026-06-01","purchase_price":89.9,"currency":"EUR","vendor":"Baumarkt","warranty_months":36,"condition":"fair","status":"active","notes":"Mit Koffer","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","account_username":"linda@example.org","odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[{"id":1,"document_id":1,"created_at":"<volatile>","name":"Beleg","original_name":"beleg.pdf","mime_type":"application/pdf","file_size":1234}],"linked_entries":[{"id":5,"entry_id":3,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-80,"date":"2026-11-01"},{"id":4,"entry_id":3,"role":"maintenance","amount_share":40,"created_at":"<volatile>","title":"Kauf","amount":-80,"date":"2026-11-01"}],"linked_entries_total":-160,"tracked_dates":[]},{"id":9,"name":"Alt","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"poor","status":"lost","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":13,"name":"Anhaenger","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":2,"name":"Auto","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":1200,"odometer_unit":"mi","odometer_on":"2026-11-18","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":2,"item_id":2,"label":"Reifen","date":"2026-12-01","reminder_offset_days":30,"interval_months":null,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"item_id":2,"label":"TÜV","date":"2031-03-01","reminder_offset_days":30,"interval_months":24,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":6,"name":"Ewig","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":600,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":10,"name":"Fahrrad","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":15,"name":"Grenzen","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[{"id":3,"item_id":15,"label":"Frist","date":"2027-01-01","reminder_offset_days":365,"interval_months":600,"interval_distance":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"item_id":15,"label":"Frist","date":"2027-04-01","reminder_offset_days":0,"interval_months":1,"interval_distance":null,"created_at":"<volatile>","updated_at":"<volatile>"}]},{"id":17,"name":"Kamera","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":120,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":1,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]},{"id":5,"name":"Kinderball","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":7,"name":"Kurz","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":"2026-11-01","purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":0,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":12,"name":"Moped","brand":null,"model":null,"serial_number":null,"category":"vehicles","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":20,"odometer_unit":"km","odometer_on":"2026-11-18","category_name":null,"category_icon":"car","category_label_key":"inventory.categoryVehicles","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":18,"name":"Objektiv","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":2,"entry_id":1,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-120,"date":"2026-11-01"}],"linked_entries_total":-120,"tracked_dates":[]},{"id":16,"name":"Ohne Beleg","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":20,"name":"Ohne Buchung","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":14,"name":"Oldtimer","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":11,"name":"Roller","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]},{"id":19,"name":"Stativ","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":10,"currency":"EUR","vendor":null,"warranty_months":null,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[{"id":3,"entry_id":2,"role":"purchase","amount_share":null,"created_at":"<volatile>","title":"Kauf","amount":-35.5,"date":"2026-11-01"}],"linked_entries_total":-35.5,"tracked_dates":[]},{"id":8,"name":"Zwei Jahre","brand":null,"model":null,"serial_number":null,"category":"other","location_id":null,"purchase_date":null,"purchase_price":null,"currency":"EUR","vendor":null,"warranty_months":24,"condition":"good","status":"active","notes":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","photo_data":null,"account_username":null,"odometer":null,"odometer_unit":null,"odometer_on":null,"category_name":null,"category_icon":"package","category_label_key":"inventory.categoryOther","location_path":null,"attachments":[],"linked_entries":[],"linked_entries_total":0,"tracked_dates":[]}]}},
  "loc list end": {"status":200,"body":{"data":[{"id":2,"name":"Carport","parent_id":null,"icon":"car","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]},{"id":3,"name":"Dachboden","parent_id":null,"icon":"package","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]},{"id":5,"name":"Regal 2","parent_id":null,"icon":"archive","sort_order":0,"created_at":"<volatile>","updated_at":"<volatile>","subcategories":[]}]}},
  "cat list end": {"status":200,"body":{"data":[{"id":7,"key":"sport","name":"Sport","label_key":null,"icon":"package","sort_order":0,"created_at":"<volatile>","tracks_odometer":0},{"id":5,"key":"other","name":null,"label_key":"inventory.categoryOther","icon":"package","sort_order":1,"created_at":"<volatile>","tracks_odometer":0},{"id":2,"key":"vehicles","name":null,"label_key":"inventory.categoryVehicles","icon":"car","sort_order":1,"created_at":"<volatile>","tracks_odometer":1},{"id":6,"key":"spiele","name":"Brettspiele","label_key":null,"icon":"puzzle","sort_order":2,"created_at":"<volatile>","tracks_odometer":0},{"id":3,"key":"household","name":null,"label_key":"inventory.categoryHousehold","icon":"home","sort_order":2,"created_at":"<volatile>","tracks_odometer":0},{"id":4,"key":"sports","name":null,"label_key":"inventory.categorySports","icon":"dumbbell","sort_order":3,"created_at":"<volatile>","tracks_odometer":0}]}},
};

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  const seen = new Set();
  for (const step of STEPS) {
    if (typeof step === 'function') { step(); continue; }
    const [name, method, path, body, opts] = step;
    assert.ok(!seen.has(name), `duplicate row name ${name}`);
    seen.add(name);
    const actual = await call(method, resolved(path), resolvedBody(body), opts);
    const expected = EXPECTED[name];
    assert.ok(expected, `no expectation for ${name}`);
    assert.deepEqual({ status: actual.status, body: normalized(actual.body) }, expected, name);
  }
  assert.equal(seen.size, Object.keys(EXPECTED).length, 'every expectation has its row');
  assert.deepEqual(logged.error, [], 'no row of the table reached the central handler');
});

/**
 * The answer and the log line of the central handler.
 * @param {{ status: number, body: unknown }} res
 * @param {string} method
 * @param {string} pattern
 */
function assertCentral(res, method, pattern) {
  assert.deepEqual(res, { status: 500, body: { error: 'Internal server error.', code: 500 } }, `${method} ${pattern}`);
  assert.deepEqual(logged.error, [`Unhandled error: ${method} ${pattern} -> 500`], `${method} ${pattern}: the central handler logged it`);
  logged.error.length = 0;
}

/**
 * Runs `request` while every statement whose SQL matches `sql` fails to prepare,
 * as a broken or locked database would.
 * @template T
 * @param {RegExp} sql
 * @param {() => Promise<T>} request
 */
async function withFailingSql(sql, request) {
  const prepare = db.prepare;
  db.prepare = function (/** @type {string} */ text) {
    if (sql.test(text)) throw new Error('SQLITE_IOERR: disk I/O error');
    return prepare.call(this, text);
  };
  try {
    return await request();
  } finally {
    delete db.prepare;
  }
}

test('items: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const item = (await call('POST', '/items', { name: 'Probe', category: 'vehicles', tracked_dates: [day('2027-05-01')] })).body.data;
  const dateId = item.tracked_dates[0].id;
  const log = (await call('POST', `/items/${item.id}/service-log`, { label: 'Probe', performed_on: '2026-11-01' })).body.data;
  const base = '/api/v1/inventory/items';
  for (const [sql, method, path, body, pattern] of /** @type {Array<[RegExp, string, string, unknown, string]>} */ ([
    [/FROM inventory_items ii/, 'GET', '/items', NO_BODY, `${base}/`],
    [/SELECT \* FROM inventory_items WHERE id/, 'GET', `/items/${item.id}`, NO_BODY, `${base}/:id`],
    [/INSERT INTO inventory_items/, 'POST', '/items', { name: 'x' }, `${base}/`],
    [/UPDATE inventory_items/, 'PUT', `/items/${item.id}`, { name: 'x', category: 'vehicles' }, `${base}/:id`],
    [/FROM inventory_items WHERE id/, 'POST', `/items/${item.id}/entries`, { entry_id: BOOKING_3 }, `${base}/:id/entries`],
    [/FROM inventory_items WHERE id/, 'DELETE', `/items/${item.id}/entries/${BOOKING_3}`, NO_BODY, `${base}/:id/entries/:entryId`],
    [/FROM inventory_items WHERE id/, 'POST', `/items/${item.id}/dates/${dateId}/complete`, { performed_on: '2026-11-02' }, `${base}/:id/dates/:dateId/complete`],
    [/FROM inventory_items WHERE id/, 'GET', `/items/${item.id}/service-log`, NO_BODY, `${base}/:id/service-log`],
    [/FROM inventory_items WHERE id/, 'POST', `/items/${item.id}/service-log`, { label: 'x', performed_on: '2026-11-02' }, `${base}/:id/service-log`],
    [/FROM inventory_items WHERE id/, 'PUT', `/items/${item.id}/service-log/${log.id}`, { label: 'x', performed_on: '2026-11-02' }, `${base}/:id/service-log/:logId`],
    [/FROM inventory_items WHERE id/, 'DELETE', `/items/${item.id}/service-log/${log.id}`, NO_BODY, `${base}/:id/service-log/:logId`],
    [/FROM inventory_items WHERE id/, 'GET', `/items/${item.id}/history`, NO_BODY, `${base}/:id/history`],
    [/FROM inventory_items WHERE id/, 'DELETE', `/items/${item.id}`, NO_BODY, `${base}/:id`],
  ])) {
    assertCentral(await withFailingSql(sql, () => call(method, path, body)), method, pattern);
  }
  assert.equal((await call('GET', `/items/${item.id}`, NO_BODY)).status, 200, 'answers again');
  assert.equal((await call('DELETE', `/items/${item.id}`, NO_BODY)).status, 204);
});

test('entries: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  assertCentral(await withFailingSql(/FROM inventory_item_entries iie/, () => call('GET', `/entries/${BOOKING}/items`, NO_BODY)),
    'GET', '/api/v1/inventory/entries/:entryId/items');
  assert.equal((await call('GET', `/entries/${BOOKING}/items`, NO_BODY)).status, 200, 'answers again');
});

test('deadlines feed: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const base = '/api/v1/inventory/deadlines-feed';
  for (const [method, path] of [['GET', '/deadlines-feed'], ['POST', '/deadlines-feed/regenerate'], ['DELETE', '/deadlines-feed']]) {
    assertCentral(await withFailingSql(/inventory_deadlines_feed_token/, () => call(method, path, NO_BODY)),
      method, path === '/deadlines-feed' ? `${base}/` : `${base}/regenerate`);
  }
  assert.equal((await call('GET', '/deadlines-feed', NO_BODY)).status, 200, 'answers again');
});

test('items: a document being deleted keeps its 409 and a link without the right its 403, on create and on replace', async () => {
  logged.error.length = 0;
  const item = (await call('POST', '/items', { name: 'Belegprobe' })).body.data;
  const DELETING = {
    status: 409,
    body: { error: 'The document is currently being deleted. Try again when the operation finishes.', code: 409, reason: 'DOCUMENT_DELETE_IN_PROGRESS' },
  };
  const REFUSED = { status: 403, body: { error: 'Linking a document requires access to documents.', code: 403, reason: 'cross_module_access' } };
  lockDocumentDeletes([DOC]);
  try {
    assert.deepEqual(await call('POST', '/items', { name: 'Neu', attachment_document_ids: [DOC] }), DELETING, 'create');
    assert.deepEqual(await call('PUT', `/items/${item.id}`, { name: 'Neu', attachment_document_ids: [DOC] }), DELETING, 'replace');
  } finally {
    unlockDocumentDeletes([DOC]);
  }
  const noDocuments = { access: { documents: 'none' } };
  assert.deepEqual(await call('POST', '/items', { name: 'Neu', attachment_document_ids: [DOC] }, noDocuments), REFUSED, 'create');
  assert.deepEqual(await call('PUT', `/items/${item.id}`, { name: 'Neu', attachment_document_ids: [DOC] }, noDocuments), REFUSED, 'replace');
  assert.deepEqual(logged.error, [], 'none reached the central handler');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_items WHERE name = 'Neu'").get().n, 0, 'nothing was written');
  assert.equal((await call('DELETE', `/items/${item.id}`, NO_BODY)).status, 204);
});
