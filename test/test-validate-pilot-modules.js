/**
 * Test: request validation in the three pilot modules (#2810, phase 2 section E)
 * Purpose: notes, birthdays and quick links check every request against the
 *          schema of its operation in the OpenAPI document (`validateRequest()`
 *          first in every route) before the handler runs. Held here against
 *          the real routers, mounted at their real prefixes in the order of
 *          the app (express.json, defaultEmptyBody, router, error handler):
 *            - REFUSED: each input of the decided list is a 400 with
 *              `reason: 'validation'` and a `fields` entry naming it - path ids
 *              like `12abc`, `pinned` as text or 5, a number in a text field,
 *              ids written as text, a list as the body, an unknown quick link
 *              visibility, an empty required value on update;
 *            - KEPT: what the routes lived with before goes through as before
 *              (the tolerance went into the schema) - null and "" as "no
 *              value", `year_unknown: null`, the visibility aliases, a pin
 *              without a body, a yearless 29 February, reminders as text and
 *              stored legacy reminders, a URL without a scheme, category ids
 *              written as digit text in a reorder;
 *            - THE OWN FRONTEND: every body the app's pages and components
 *              send to these endpoints passes the middleware of its operation.
 * Run: npm run test:validate-pilot-modules
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const { default: quickLinksRouter } = await import('../server/routes/quick-links.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { validateRequest } = await import('../server/api/validate-request.ts');
const db = dbmod.get();

const USER = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('pilot','Pilot','x','member')").run().lastInsertRowid;

const quiet = { warn: () => {}, error: () => {} };
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(defaultEmptyBody);
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  req.authUserId = USER;
  req.authRole = 'member';
  req.session = { userId: USER, role: 'member' };
  next();
});
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/quick-links', quickLinksRouter);
app.use('/api/v1/birthdays', birthdaysRouter);
app.use(createErrorHandler(quiet));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body] sent as JSON; left out, the request has no body
 */
async function call(method, path, body) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

/**
 * A 400 of the middleware that names `path` among its fields.
 * @param {{ status: number, body: any }} res
 * @param {string} path
 */
function assertRefused(res, path) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body?.reason, 'validation', JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.fields) && res.body.fields.some((/** @type {any} */ f) => f.path === path),
    `no field ${path} in ${JSON.stringify(res.body.fields)}`);
}

/**
 * @param {{ status: number, body: any }} res
 * @param {number} status
 */
function assertPassed(res, status) {
  assert.equal(res.status, status, JSON.stringify(res.body));
}

async function newNote(extra = {}) {
  const res = await call('POST', '/notes', { content: 'Milch', ...extra });
  assertPassed(res, 201);
  return res.body.data;
}

async function newBirthday(extra = {}) {
  const res = await call('POST', '/birthdays', { name: 'Ada', birth_date: '1990-05-01', ...extra });
  assertPassed(res, 201);
  return res.body.data;
}

async function newQuickLink(extra = {}) {
  db.prepare('DELETE FROM quick_links').run();
  const res = await call('POST', '/quick-links', { name: 'NAS', url: 'https://nas.example/', ...extra });
  assertPassed(res, 201);
  return res.body.data;
}

/** @param {string} name */
async function newCategory(name) {
  const res = await call('POST', '/notes/categories', { name });
  assertPassed(res, 201);
  return res.body.data.id;
}

/** @param {string} name */
function addContact(name) {
  return Number(db.prepare("INSERT INTO contacts (name, category, birthday) VALUES (?, 'Sonstiges', '1980-03-03')").run(name).lastInsertRowid);
}

// ── REFUSED: the decided list ───────────────────────────────────────────────

test('a path id like 12abc is a 400 in every module (parseInt read it as 12)', async () => {
  const note = await newNote();
  const birthday = await newBirthday();
  const link = await newQuickLink();
  assertRefused(await call('PUT', `/notes/${note.id}abc`, { title: 'x' }), 'path/id');
  assertRefused(await call('DELETE', `/notes/${note.id}abc`), 'path/id');
  assertRefused(await call('PATCH', `/notes/${note.id}abc/pin`), 'path/id');
  assertRefused(await call('PUT', `/notes/categories/${note.id}abc`, { name: 'x' }), 'path/id');
  assertRefused(await call('PUT', `/birthdays/${birthday.id}abc`, { name: 'x' }), 'path/id');
  assertRefused(await call('DELETE', `/birthdays/${birthday.id}abc`), 'path/id');
  assertRefused(await call('PUT', `/quick-links/${link.id}abc`, { name: 'x' }), 'path/id');
  assertRefused(await call('DELETE', `/quick-links/${link.id}abc`), 'path/id');
  assertRefused(await call('DELETE', `/notes/${note.id}e0`), 'path/id');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes WHERE id = ?').get(note.id).n, 1, 'nothing deleted');
});

test('pinned as "false", 5 or "x" is a 400, and pinned: null on update', async () => {
  for (const pinned of ['false', 5, 'x']) {
    assertRefused(await call('POST', '/notes', { content: 'a', pinned }), 'body/pinned');
  }
  const note = await newNote();
  for (const pinned of ['false', 5, 'x', null]) {
    assertRefused(await call('PUT', `/notes/${note.id}`, { pinned }), 'body/pinned');
  }
});

test('a number in a text field is a 400 (it was stored as text)', async () => {
  assertRefused(await call('POST', '/notes', { content: 'a', title: 5 }), 'body/title');
  assertRefused(await call('POST', '/notes', { content: 5 }), 'body/content');
  const note = await newNote();
  assertRefused(await call('PUT', `/notes/${note.id}`, { title: 5 }), 'body/title');
  assertRefused(await call('POST', '/birthdays', { name: 5, birth_date: '1990-05-01' }), 'body/name');
  assertRefused(await call('POST', '/birthdays', { name: 'Ada', birth_date: '1990-05-01', notes: 5 }), 'body/notes');
  const birthday = await newBirthday();
  assertRefused(await call('PUT', `/birthdays/${birthday.id}`, { notes: 5 }), 'body/notes');
  assertRefused(await call('POST', '/quick-links', { name: 5, url: 'https://x.example/' }), 'body/name');
});

test('ids written as text are a 400: category_ids, contact_id; non-numbers in contact_ids and ids', async () => {
  const category = await newCategory('Text-Ids');
  assertRefused(await call('POST', '/notes', { content: 'a', category_ids: [String(category)] }), 'body/category_ids/0');
  const note = await newNote();
  assertRefused(await call('PUT', `/notes/${note.id}`, { category_ids: [String(category)] }), 'body/category_ids/0');
  const contact = addContact('Text Id');
  assertRefused(await call('POST', '/birthdays', { name: 'Ada', birth_date: '1990-05-01', contact_id: String(contact) }), 'body/contact_id');
  const birthday = await newBirthday();
  assertRefused(await call('PUT', `/birthdays/${birthday.id}`, { contact_id: String(contact) }), 'body/contact_id');
  for (const bad of ['x', String(contact), null, 5.5]) {
    assertRefused(await call('POST', '/birthdays/import', { contact_ids: [bad] }), 'body/contact_ids/0');
  }
  const link = await newQuickLink();
  for (const bad of ['x', String(link.id), null, true, 2.5]) {
    assertRefused(await call('PUT', '/quick-links/order', { ids: [bad] }), 'body/ids/0');
  }
});

test('array limits: a quick-link order, at the limit and one above (#2810)', async () => {
  const { assertArrayLimit } = await import('./array-limit-cases.js');
  const { MAX_QUICK_LINK_ORDER } = await import('../server/openapi/array-limits.js');
  const at = await assertArrayLimit((body) => call('PUT', '/quick-links/order', body),
    (n) => ({ ids: Array.from({ length: n }, (_, i) => 900000 + i) }), MAX_QUICK_LINK_ORDER, 'body/ids');
  assert.equal(at.status, 200, 'ids the caller cannot see are ignored');
});

test('order of a category reorder takes ids and digit text, nothing else (the category manager sends text)', async () => {
  for (const bad of ['x', '', 1.5, null, '3 ', '0', 0, '03']) {
    assertRefused(await call('PATCH', '/notes/categories/reorder', { order: [bad] }), 'body/order/0');
  }
});

test('a list instead of an object as the body is a 400', async () => {
  const note = await newNote();
  const birthday = await newBirthday();
  const link = await newQuickLink();
  assertRefused(await call('POST', '/notes', []), 'body');
  assertRefused(await call('PUT', `/notes/${note.id}`, []), 'body');
  assertRefused(await call('POST', '/birthdays', []), 'body');
  assertRefused(await call('PUT', `/birthdays/${birthday.id}`, []), 'body');
  assertRefused(await call('POST', '/birthdays/import', []), 'body');
  assertRefused(await call('POST', '/quick-links', []), 'body');
  assertRefused(await call('PUT', `/quick-links/${link.id}`, []), 'body');
  assertRefused(await call('PUT', '/quick-links/order', []), 'body');
  assertRefused(await call('PATCH', '/notes/categories/reorder', []), 'body');
});

test('an unknown quick link visibility is a 400 (it became all, or was ignored)', async () => {
  assertRefused(await call('POST', '/quick-links', { name: 'X', url: 'https://x.example/', visibility: 'family' }), 'body/visibility');
  const link = await newQuickLink();
  assertRefused(await call('PUT', `/quick-links/${link.id}`, { visibility: 'x' }), 'body/visibility');
  assert.equal(db.prepare('SELECT visibility FROM quick_links WHERE id = ?').get(link.id).visibility, 'all');
});

test('an empty required value on update is a 400 (a birthday stored an empty name)', async () => {
  const birthday = await newBirthday();
  assertRefused(await call('PUT', `/birthdays/${birthday.id}`, { name: '' }), 'body/name');
  assert.equal(db.prepare('SELECT name FROM birthdays WHERE id = ?').get(birthday.id).name, 'Ada');
  const link = await newQuickLink();
  assertRefused(await call('PUT', `/quick-links/${link.id}`, { name: '' }), 'body/name');
  assertRefused(await call('PUT', `/quick-links/${link.id}`, { url: '' }), 'body/url');
});

test('accepted along the way: the 400 comes before the 404, a missing required body is a 400', async () => {
  assertRefused(await call('PUT', '/notes/999999', { title: 5 }), 'body/title');
  assertRefused(await call('PUT', '/birthdays/999999', { name: '' }), 'body/name');
  assertRefused(await call('PUT', '/quick-links/999999', { visibility: 'x' }), 'body/visibility');
  assertRefused(await call('POST', '/notes'), 'body');
  assertRefused(await call('POST', '/birthdays'), 'body');
  assertRefused(await call('POST', '/quick-links'), 'body');
  assertPassed(await call('PUT', '/notes/999999', { title: 'x' }), 404);
});

// ── KEPT: the lived tolerance is in the schema ──────────────────────────────

test('optional text fields take null and "" as no value: note title and color on create', async () => {
  for (const extra of [{ title: null }, { title: '' }, { color: null }, { color: '' }]) {
    const res = await call('POST', '/notes', { content: 'a', ...extra });
    assertPassed(res, 201);
    assert.equal(res.body.data.title, null);
    assert.equal(res.body.data.color, '#FFEB3B');
  }
});

test('optional text fields take null and "" as no value: name_day and notes of a birthday', async () => {
  for (const extra of [{ name_day: null }, { name_day: '' }, { notes: null }, { notes: '' }]) {
    const res = await call('POST', '/birthdays', { name: 'Bea', birth_date: '1991-01-01', ...extra });
    assertPassed(res, 201);
    assert.equal(res.body.data.name_day, null);
    assert.equal(res.body.data.notes, null);
  }
});

test('a name_day of 50,000 spaces and an x is a quick 400; surrounding spaces stay allowed (#2810)', async () => {
  // The first pattern backtracked quadratically: this one request held the
  // event loop for about 4 s. The budget covers the whole HTTP round trip.
  const long = `${' '.repeat(50_000)}x`;
  const birthday = await newBirthday();
  for (const [method, path] of [['POST', '/birthdays'], ['PUT', `/birthdays/${birthday.id}`]]) {
    const start = performance.now();
    const res = await call(method, path, { name: 'Ada', birth_date: '1990-05-01', name_day: long });
    const ms = performance.now() - start;
    assertRefused(res, 'body/name_day');
    assert.ok(ms < 1000, `${method} ${path} took ${ms.toFixed(0)} ms`);
  }
  const res = await call('POST', '/birthdays', { name: 'Ada', birth_date: '1990-05-01', name_day: ' 01-02 ' });
  assertPassed(res, 201);
  assert.equal(res.body.data.name_day, '01-02');
  assertPassed(await call('PUT', `/birthdays/${birthday.id}`, { name_day: '\t12-31\n' }), 200);
  assert.equal(db.prepare('SELECT name_day FROM birthdays WHERE id = ?').get(birthday.id).name_day, '12-31');
});

test('year_unknown: null counts as false', async () => {
  const res = await call('POST', '/birthdays', { name: 'Cem', birth_date: '1992-02-02', year_unknown: null });
  assertPassed(res, 201);
  assert.equal(res.body.data.year_unknown, 0);
  const put = await call('PUT', `/birthdays/${res.body.data.id}`, { year_unknown: null });
  assertPassed(put, 200);
});

test('the note visibility takes the aliases family and shared (DECISIONS 5)', async () => {
  for (const visibility of ['family', 'shared']) {
    const res = await call('POST', '/notes', { content: 'a', visibility });
    assertPassed(res, 201);
    assert.equal(res.body.data.visibility, 'all');
    assertPassed(await call('PUT', `/notes/${res.body.data.id}`, { visibility }), 200);
  }
});

test('pinning a note needs no body', async () => {
  const note = await newNote();
  const res = await call('PATCH', `/notes/${note.id}/pin`);
  assertPassed(res, 200);
  assert.equal(res.body.data.pinned, 1);
});

test('birth_date has no calendar check in the schema: a yearless 29 February of a common year', async () => {
  const res = await call('POST', '/birthdays', { name: 'Dora', birth_date: '1999-02-29', year_unknown: true });
  assertPassed(res, 201);
  assert.equal(res.body.data.birth_date, '2000-02-29');
  assertPassed(await call('PUT', `/birthdays/${res.body.data.id}`, { birth_date: '2001-02-29' }), 200);
});

test('reminder fields stay wide: text or number, and a stored legacy value goes through unchanged', async () => {
  const res = await call('POST', '/birthdays', {
    name: 'Emil', birth_date: '1993-03-03',
    reminder_offset: 'custom', reminder_custom_amount: '007', reminder_custom_unit: 'hours',
  });
  assertPassed(res, 201);
  assertPassed(await call('POST', '/birthdays', { name: 'Emma', birth_date: '1993-03-03', reminder_offset: 1440, reminder_custom_amount: 2 }), 201);
  const id = res.body.data.id;
  db.prepare("UPDATE birthdays SET reminder_offset = '-5', reminder_custom_amount = 5000, reminder_custom_unit = 'fortnights' WHERE id = ?").run(id);
  const put = await call('PUT', `/birthdays/${id}`, {
    name: 'Emil B', reminder_offset: '-5', reminder_custom_amount: 5000, reminder_custom_unit: 'fortnights',
  });
  assertPassed(put, 200);
  assert.equal(put.body.data.reminder_offset, '-5');
  // The rule itself stays the handler's: a new value outside it is its 400, not the schema's.
  const refused = await call('PUT', `/birthdays/${id}`, { reminder_offset: '-6' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.reason, undefined);
});

test('a quick link URL without a scheme is normalized, not refused as a format', async () => {
  db.prepare('DELETE FROM quick_links').run();
  const res = await call('POST', '/quick-links', { name: 'Jellyfin', url: '192.168.1.5:8096' });
  assertPassed(res, 201);
  assert.equal(res.body.data.url, 'https://192.168.1.5:8096/');
});

test('order of a category reorder takes digit text as the category manager sends it', async () => {
  const a = await newCategory('Reorder A');
  const b = await newCategory('Reorder B');
  const res = await call('PATCH', '/notes/categories/reorder', { order: [String(b), String(a)], scope: 'personal' });
  assertPassed(res, 200);
  assertPassed(await call('PATCH', '/notes/categories/reorder', { order: [a, b] }), 200);
});

test('not decided, kept as before: tolerated inputs outside the decided list', async () => {
  const category = await newCategory('Doppelt');
  assertPassed(await call('POST', '/notes', { content: 'a', pinned: null }), 201);
  assertPassed(await call('POST', '/notes', { content: 'a', category_ids: [category, category] }), 201);
  const note = await newNote();
  assertPassed(await call('PUT', `/notes/${note.id}`, { content: null, color: null }), 200);
  assertPassed(await call('PUT', `/notes/${note.id}`, { color: '' }), 200);
  const birthday = await newBirthday();
  assertPassed(await call('PUT', `/birthdays/${birthday.id}`, { name: null, birth_date: null }), 200);
  assertPassed(await call('PUT', `/birthdays/${birthday.id}`, { name_day: ' 03-04 ' }), 200);
  assertPassed(await call('PUT', `/birthdays/${birthday.id}`, { contact_id: '' }), 200);
  assertPassed(await call('POST', '/birthdays', { name: 'Fritz', birth_date: '1990-05-01', contact_id: '' }), 201);
  db.prepare('DELETE FROM quick_links').run();
  const link = await call('POST', '/quick-links', { name: 'Null', url: 'https://n.example/', visibility: null });
  assertPassed(link, 201);
  assert.equal(link.body.data.visibility, 'all');
  assertPassed(await call('PUT', `/quick-links/${link.body.data.id}`, { visibility: null }), 200);
});

// ── THE OWN FRONTEND: every body it sends passes its operation ─────────────

/**
 * The middleware of the app document for one operation, called as Express
 * would: true when it lets the request through.
 * @param {string} method
 * @param {string} mount
 * @param {string} pattern
 * @param {{ params?: Record<string, string>, body?: unknown }} request
 */
function passes(method, mount, pattern, { params = {}, body } = {}) {
  /** @type {unknown} */
  let outcome = 'not called';
  const req = { method, baseUrl: mount, route: { path: pattern }, params, query: {}, body };
  validateRequest()(req, {}, (/** @type {unknown} */ err) => { outcome = err; });
  if (outcome === undefined) return true;
  const fields = /** @type {any} */ (outcome)?.fields ?? /** @type {any} */ (outcome)?.details?.fields;
  return JSON.stringify(fields ?? outcome);
}

/**
 * Each entry: where it is sent from, the operation and the body exactly as
 * that call site builds it (including the edge cases of the UI).
 * @type {Array<[string, string, string, string, { params?: Record<string, string>, body?: unknown }]>}
 */
const FRONTEND_CALLS = [
  // public/pages/notes.js, note editor (create/edit), with and without the access fields
  ['notes.js create', 'POST', '/api/v1/notes', '/', { body: { title: null, content: 'Milch', color: '#FFEB3B', pinned: 0, category_ids: [] } }],
  ['notes.js create full', 'POST', '/api/v1/notes', '/', { body: { title: 'Einkauf', content: '- [ ] Milch', color: '#81D4FA', pinned: 1, category_ids: [1, 2], visibility: 'private', locked: 1 } }],
  ['notes.js edit', 'PUT', '/api/v1/notes', '/:id', { params: { id: '4' }, body: { title: null, content: 'x', color: '#FFEB3B', pinned: 0, category_ids: [3], visibility: 'all', locked: 0 } }],
  ['notes.js check', 'PATCH', '/api/v1/notes', '/:id/check', { params: { id: '4' }, body: { line: 2, checked: true, expect: '- [ ] Milch' } }],
  ['notes.js pin', 'PATCH', '/api/v1/notes', '/:id/pin', { params: { id: '4' }, body: {} }],
  ['notes.js delete', 'DELETE', '/api/v1/notes', '/:id', { params: { id: '4' } }],
  ['notes.js new category', 'POST', '/api/v1/notes', '/categories', { body: { name: 'Haushalt', scope: 'household' } }],
  // public/components/category-manager.js with basePath /notes/categories (keys are text)
  ['category-manager add', 'POST', '/api/v1/notes', '/categories', { body: { name: 'Privat', scope: 'personal' } }],
  ['category-manager rename', 'PUT', '/api/v1/notes', '/categories/:id', { params: { id: '3' }, body: { name: 'Neu' } }],
  ['category-manager reorder', 'PATCH', '/api/v1/notes', '/categories/reorder', { body: { order: ['3', '1', '2'], scope: 'personal' } }],
  ['category-manager delete', 'DELETE', '/api/v1/notes', '/categories/:id', { params: { id: '3' } }],
  // public/pages/birthdays.js, birthday editor: new with reminder, yearless, edit
  ['birthdays.js create', 'POST', '/api/v1/birthdays', '/', { body: { name: 'Ada', birth_date: '1990-05-01', year_unknown: false, name_day: null, notes: '', photo_data: null, reminder_offset: '1440', reminder_custom_amount: '1', reminder_custom_unit: 'days' } }],
  ['birthdays.js create custom', 'POST', '/api/v1/birthdays', '/', { body: { name: 'Ada', birth_date: '2000-02-29', year_unknown: true, name_day: '03-04', notes: 'Kuchen', photo_data: 'data:image/png;base64,iVBORw0KGgo=', reminder_offset: 'custom', reminder_custom_amount: '3', reminder_custom_unit: 'hours' } }],
  ['birthdays.js create no reminder', 'POST', '/api/v1/birthdays', '/', { body: { name: 'Ada', birth_date: '1990-05-01', year_unknown: false, name_day: null, notes: '', photo_data: null, reminder_offset: '', contact_id: 7 } }],
  ['birthdays.js edit unchanged reminder', 'PUT', '/api/v1/birthdays', '/:id', { params: { id: '2' }, body: { name: 'Ada', birth_date: '1990-05-01', year_unknown: false, name_day: null, notes: '', photo_data: null } }],
  ['birthdays.js edit unlink', 'PUT', '/api/v1/birthdays', '/:id', { params: { id: '2' }, body: { name: 'Ada', birth_date: '1990-05-01', year_unknown: false, name_day: null, notes: '', photo_data: null, contact_id: null, reminder_offset: '' } }],
  ['birthdays.js link suggestion', 'PUT', '/api/v1/birthdays', '/:id', { params: { id: '2' }, body: { contact_id: 7 } }],
  ['birthdays.js import', 'POST', '/api/v1/birthdays', '/import', { body: { contact_ids: [7, 8] } }],
  ['birthdays.js delete', 'DELETE', '/api/v1/birthdays', '/:id', { params: { id: '2' } }],
  // public/pages/contacts.js, the birthday hint of a contact
  ['contacts.js link', 'PUT', '/api/v1/birthdays', '/:id', { params: { id: '2' }, body: { contact_id: 7 } }],
  ['contacts.js import', 'POST', '/api/v1/birthdays', '/import', { body: { contact_ids: [7] } }],
  // public/components/quick-links-manager.js
  ['quick-links-manager create', 'POST', '/api/v1/quick-links', '/', { body: { name: 'NAS', url: 'https://nas.example/', icon_data: null, icon_name: null, color: '#5C6BC0', visibility: 'all' } }],
  ['quick-links-manager edit', 'PUT', '/api/v1/quick-links', '/:id', { params: { id: '5' }, body: { name: 'NAS', url: 'https://nas.example/', icon_data: 'data:image/png;base64,iVBORw0KGgo=', icon_name: 'server', color: '#5C6BC0', visibility: 'private' } }],
  ['quick-links-manager order', 'PUT', '/api/v1/quick-links', '/order', { body: { ids: [3, 1, 2] } }],
  ['quick-links-manager delete', 'DELETE', '/api/v1/quick-links', '/:id', { params: { id: '5' } }],
];

for (const [site, method, mount, pattern, request] of FRONTEND_CALLS) {
  test(`the own frontend passes the schema: ${site}`, () => {
    assert.equal(passes(method, mount, pattern, request), true);
  });
}
