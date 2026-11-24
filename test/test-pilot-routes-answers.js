/**
 * Test: the answers of the three pilot modules stay byte-equal (#2810, phase 2 section E)
 * Purpose: notes, birthdays and quick links dropped the hand checks the schema
 *          of their operation already covers and the try/catch blocks that
 *          answered a 500 themselves. That was a pure refactor, and this suite
 *          holds it: for a table of requests per route - valid, every refusal
 *          of the handler, every refusal of the schema, not found, foreign or
 *          locked, conflict - it pins status and the WHOLE answer body. The
 *          expectations were written at the state before the refactor
 *          (80f4700ce) and are literal here, no fixture file, no update mode.
 *          Only fields that follow the clock (timestamps, days until a
 *          birthday) are replaced by a marker before the comparison.
 *
 *          The second part: an unexpected error (a table that is gone) in each
 *          file reaches the central error handler - 500 with its fixed
 *          sentence and its log line `Unhandled error: <METHOD> <pattern> -> 500`
 *          - and the process keeps answering.
 * Run: npm run test:pilot-routes-answers
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const { default: quickLinksRouter } = await import('../server/routes/quick-links.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { applyChildStartPermissions } = await import('../server/authorize/index.ts');
const db = dbmod.get();

// Days until a birthday, its next date and the order of the lists follow the
// clock and "today" of the household zone (todayKey, server/utils/timezone.js).
// Both are pinned: the clock stands still at noon UTC, and the household lives
// in Europe/Berlin - without the setting the zone falls back to the process
// TZ, and from UTC+12 on noon UTC is already the next day.
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
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

/** @type {Record<string, { id: number, role: string }>} */
const USERS = {
  admin: { id: user('linda', 'admin', 'mom'), role: 'admin' },
  parent: { id: user('tom', 'member', 'dad'), role: 'member' },
  child: { id: user('emma', 'member', 'child'), role: 'member' },
};
applyChildStartPermissions(db, { id: USERS.child.id, role: 'member', family_role: 'child' });

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = {
  warn: (/** @type {string} */ line) => { logged.warn.push(line); },
  error: (/** @type {string} */ line) => { logged.error.push(line); },
};

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(defaultEmptyBody);
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const who = USERS[req.get('x-as') ?? 'parent'];
  req.authUserId = who.id;
  req.authRole = who.role;
  req.session = { userId: who.id, role: who.role };
  const scopes = req.get('x-scopes');
  if (scopes) req.authScopes = JSON.parse(scopes);
  next();
});
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/quick-links', quickLinksRouter);
app.use('/api/v1/birthdays', birthdaysRouter);
app.use(createErrorHandler(log));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

const NO_BODY = Symbol('no body');

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} body
 * @param {{ as?: string, scopes?: string[] }} [opts]
 */
async function call(method, path, body, { as, scopes } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== NO_BODY) headers['Content-Type'] = 'application/json';
  if (as) headers['x-as'] = as;
  if (scopes) headers['x-scopes'] = JSON.stringify(scopes);
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: body !== NO_BODY ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

// Timestamps SQLite writes from its own clock ('now'), not from Date.
const VOLATILE = new Set(['created_at', 'updated_at']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => (VOLATILE.has(key) && v !== null ? '<clock>' : v));
}

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const LONG_EMOJI = (/** @type {number} */ count) => '\u{1F600}'.repeat(count);

/** @param {string} name */
function addContact(name) {
  return Number(db.prepare("INSERT INTO contacts (name, category, birthday) VALUES (?, 'Sonstiges', '1980-03-03')").run(name).lastInsertRowid);
}

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions. Paths and bodies use the ids the rows before them created; the
 * database starts empty, so they are the same on every run.
 * @type {Array<[string, string, string, unknown, ({ as?: string, scopes?: string[] })?] | (() => void)>}
 */
const STEPS = [
  // ── notes: categories ─────────────────────────────────────────────────────
  ['cat list empty', 'GET', '/notes/categories', NO_BODY],
  ['cat create', 'POST', '/notes/categories', { name: 'Einkauf' }],
  ['cat create second', 'POST', '/notes/categories', { name: 'Schule' }],
  ['cat create duplicate', 'POST', '/notes/categories', { name: ' einkauf ' }],
  ['cat create blank', 'POST', '/notes/categories', { name: '   ' }],
  ['cat create long emoji', 'POST', '/notes/categories', { name: LONG_EMOJI(80) }],
  ['cat create name number', 'POST', '/notes/categories', { name: 5 }],
  ['cat create no name', 'POST', '/notes/categories', {}],
  ['cat create no body', 'POST', '/notes/categories', NO_BODY],
  ['cat create scope unknown', 'POST', '/notes/categories', { name: 'A', scope: 'nope' }],
  ['cat create scope null', 'POST', '/notes/categories', { name: 'A', scope: null }],
  ['cat create scope number', 'POST', '/notes/categories', { name: 'A', scope: 1 }],
  ['cat create household by child', 'POST', '/notes/categories', { name: 'Haus', scope: 'household' }, { as: 'child' }],
  ['cat create household by admin', 'POST', '/notes/categories', { name: 'Haus', scope: 'household' }, { as: 'admin' }],
  ['cat create personal of child', 'POST', '/notes/categories', { name: 'Kind' }, { as: 'child' }],
  ['cat create personal of admin', 'POST', '/notes/categories', { name: 'Admin' }, { as: 'admin' }],
  ['cat list', 'GET', '/notes/categories', NO_BODY],
  ['cat reorder', 'PATCH', '/notes/categories/reorder', { order: [2, '1'] }],
  ['cat reorder empty', 'PATCH', '/notes/categories/reorder', { order: [] }],
  ['cat reorder not a list', 'PATCH', '/notes/categories/reorder', { order: 'x' }],
  ['cat reorder missing', 'PATCH', '/notes/categories/reorder', {}],
  ['cat reorder too long', 'PATCH', '/notes/categories/reorder', { order: Array.from({ length: 501 }, (_, i) => i + 1) }],
  ['cat reorder zero', 'PATCH', '/notes/categories/reorder', { order: [0] }],
  ['cat reorder negative', 'PATCH', '/notes/categories/reorder', { order: [-1] }],
  ['cat reorder float', 'PATCH', '/notes/categories/reorder', { order: [1.5] }],
  ['cat reorder text', 'PATCH', '/notes/categories/reorder', { order: ['x'] }],
  ['cat reorder duplicate', 'PATCH', '/notes/categories/reorder', { order: [1, 1] }],
  ['cat reorder duplicate as text', 'PATCH', '/notes/categories/reorder', { order: [1, '1'] }],
  ['cat reorder unknown', 'PATCH', '/notes/categories/reorder', { order: [999] }],
  ['cat reorder foreign personal', 'PATCH', '/notes/categories/reorder', { order: [4] }],
  ['cat reorder mixed scopes', 'PATCH', '/notes/categories/reorder', { order: [3, 5] }, { as: 'admin' }],
  ['cat reorder household by parent', 'PATCH', '/notes/categories/reorder', { order: [3] }],
  ['cat rename', 'PUT', '/notes/categories/1', { name: ' Einkaufen ' }],
  ['cat rename duplicate', 'PUT', '/notes/categories/1', { name: 'schule' }],
  ['cat rename blank', 'PUT', '/notes/categories/1', { name: '  ' }],
  ['cat rename number', 'PUT', '/notes/categories/1', { name: 5 }],
  ['cat rename no body', 'PUT', '/notes/categories/1', NO_BODY],
  ['cat rename id zero', 'PUT', '/notes/categories/0', { name: 'x' }],
  ['cat rename id negative', 'PUT', '/notes/categories/-1', { name: 'x' }],
  ['cat rename id text', 'PUT', '/notes/categories/abc', { name: 'x' }],
  ['cat rename unknown', 'PUT', '/notes/categories/999', { name: 'x' }],
  ['cat rename foreign personal', 'PUT', '/notes/categories/4', { name: 'x' }],
  ['cat rename household by parent', 'PUT', '/notes/categories/3', { name: 'x' }],
  ['cat delete id zero', 'DELETE', '/notes/categories/0', NO_BODY],
  ['cat delete unknown', 'DELETE', '/notes/categories/999', NO_BODY],
  ['cat delete household by parent', 'DELETE', '/notes/categories/3', NO_BODY],
  ['cat delete', 'DELETE', '/notes/categories/2', NO_BODY],

  // ── notes ─────────────────────────────────────────────────────────────────
  ['note list empty', 'GET', '/notes', NO_BODY],
  ['note create', 'POST', '/notes', { content: 'Liste\n- [ ] Milch\n- [x] Brot', title: ' Einkauf ', category_ids: [1, 1] }],
  ['note create defaults', 'POST', '/notes', { content: ' x ', title: '  ', color: '', pinned: null, visibility: 'family' }],
  ['note create private locked', 'POST', '/notes', { content: 'privat', color: '#123456', pinned: true, visibility: 'private', locked: 1 }],
  ['note create locked open', 'POST', '/notes', { content: 'gesperrt', locked: true }],
  ['note create blank content', 'POST', '/notes', { content: '   ' }],
  ['note create empty content', 'POST', '/notes', { content: '' }],
  ['note create no content', 'POST', '/notes', {}],
  ['note create no body', 'POST', '/notes', NO_BODY],
  ['note create content too long', 'POST', '/notes', { content: 'x'.repeat(5001) }],
  ['note create content emoji long', 'POST', '/notes', { content: LONG_EMOJI(5000) }],
  ['note create title emoji long', 'POST', '/notes', { content: 'a', title: LONG_EMOJI(200) }],
  ['note create color word', 'POST', '/notes', { content: 'a', color: 'rot' }],
  ['note create color short hex', 'POST', '/notes', { content: 'a', color: '#fff' }],
  ['note create visibility unknown', 'POST', '/notes', { content: 'a', visibility: 'assignees' }],
  ['note create visibility null', 'POST', '/notes', { content: 'a', visibility: null }],
  ['note create locked text', 'POST', '/notes', { content: 'a', locked: 'yes' }],
  ['note create locked null', 'POST', '/notes', { content: 'a', locked: null }],
  ['note create locked two', 'POST', '/notes', { content: 'a', locked: 2 }],
  ['note create category unknown', 'POST', '/notes', { content: 'a', category_ids: [999] }],
  ['note create category foreign', 'POST', '/notes', { content: 'a', category_ids: [4] }],
  ['note create by child', 'POST', '/notes', { content: 'Kind' }, { as: 'child' }],
  // The list sorts by updated_at, which SQLite writes to the second: spread it.
  () => db.exec("UPDATE notes SET updated_at = '2026-01-01T00:00:0' || id || 'Z'"),
  ['note list', 'GET', '/notes', NO_BODY],
  ['note list by child', 'GET', '/notes', NO_BODY, { as: 'child' }],
  ['note update', 'PUT', '/notes/1', { title: 'Neu', content: ' Liste\n- [ ] Milch\n- [x] Brot ', color: '#00FF00', pinned: 1 }],
  ['note update nulls', 'PUT', '/notes/1', { content: null, title: null, color: null }],
  ['note update empty colour', 'PUT', '/notes/2', { color: '' }],
  ['note update content blank', 'PUT', '/notes/2', { content: '   ' }],
  ['note update content emoji long', 'PUT', '/notes/2', { content: LONG_EMOJI(5000) }],
  ['note update title emoji long', 'PUT', '/notes/2', { title: LONG_EMOJI(200) }],
  ['note update color word', 'PUT', '/notes/2', { color: 'rot' }],
  ['note update visibility unknown', 'PUT', '/notes/2', { visibility: 'assignees' }],
  ['note update visibility null', 'PUT', '/notes/2', { visibility: null }],
  ['note update locked text', 'PUT', '/notes/2', { locked: 'x' }],
  ['note update visibility same', 'PUT', '/notes/2', { visibility: 'all', locked: 0 }],
  ['note update visibility by admin', 'PUT', '/notes/2', { visibility: 'private' }, { as: 'admin' }],
  ['note update lock by admin', 'PUT', '/notes/2', { locked: true }, { as: 'admin' }],
  ['note update unknown', 'PUT', '/notes/999', { title: 'x' }],
  ['note update private of other', 'PUT', '/notes/3', { title: 'x' }, { as: 'child' }],
  ['note update by child', 'PUT', '/notes/1', { title: 'x' }, { as: 'child' }],
  ['note update categories by child', 'PUT', '/notes/1', { category_ids: [] }, { as: 'child' }],
  ['note update locked by child', 'PUT', '/notes/4', { category_ids: [] }, { as: 'child' }],
  ['note update category unknown', 'PUT', '/notes/1', { category_ids: [999] }],
  ['note update category set', 'PUT', '/notes/1', { category_ids: [1] }],
  ['note update no body', 'PUT', '/notes/1', NO_BODY],
  ['note pin', 'PATCH', '/notes/2/pin', NO_BODY],
  ['note pin with body', 'PATCH', '/notes/2/pin', {}],
  ['note pin unknown', 'PATCH', '/notes/999/pin', NO_BODY],
  ['note pin by child', 'PATCH', '/notes/1/pin', NO_BODY, { as: 'child' }],
  ['note pin locked by child', 'PATCH', '/notes/4/pin', NO_BODY, { as: 'child' }],
  ['note check', 'PATCH', '/notes/1/check', { line: 1, checked: true, expect: '- [ ] Milch' }],
  ['note check same', 'PATCH', '/notes/1/check', { line: 1, checked: true }],
  ['note check by child', 'PATCH', '/notes/1/check', { line: 2, checked: false, expect: null }, { as: 'child' }],
  ['note check line negative', 'PATCH', '/notes/1/check', { line: -1, checked: true }],
  ['note check line text', 'PATCH', '/notes/1/check', { line: '1', checked: true }],
  ['note check checked text', 'PATCH', '/notes/1/check', { line: 1, checked: 'yes' }],
  ['note check expect number', 'PATCH', '/notes/1/check', { line: 1, checked: true, expect: 5 }],
  ['note check stale', 'PATCH', '/notes/1/check', { line: 1, checked: false, expect: '- [ ] Brot' }],
  ['note check out of range', 'PATCH', '/notes/1/check', { line: 40, checked: true }],
  ['note check not a checklist line', 'PATCH', '/notes/1/check', { line: 0, checked: true }],
  ['note check unknown', 'PATCH', '/notes/999/check', { line: 1, checked: true }],
  ['note check locked by child', 'PATCH', '/notes/4/check', { line: 0, checked: true }, { as: 'child' }],
  ['note check no body', 'PATCH', '/notes/1/check', NO_BODY],
  ['note delete unknown', 'DELETE', '/notes/999', NO_BODY],
  ['note delete by child', 'DELETE', '/notes/1', NO_BODY, { as: 'child' }],
  ['note delete locked by child', 'DELETE', '/notes/4', NO_BODY, { as: 'child' }],
  ['note delete id text', 'DELETE', '/notes/2x', NO_BODY],
  ['note delete', 'DELETE', '/notes/2', NO_BODY],
  ['note delete again', 'DELETE', '/notes/2', NO_BODY],

  // ── birthdays ─────────────────────────────────────────────────────────────
  () => {
    addContact('Ada Lovelace');
    addContact('Grace Hopper');
    addContact('Alan Turing');
    addContact('Konrad Zuse');
  },
  ['bday list empty', 'GET', '/birthdays', NO_BODY],
  ['bday create', 'POST', '/birthdays', { name: ' Ada ', birth_date: '1990-05-01', notes: ' Kuchen ', name_day: ' 03-04 ', reminder_offset: '1440' }],
  ['bday create yearless', 'POST', '/birthdays', { name: 'Bea', birth_date: '1999-02-29', year_unknown: true, reminder_offset: 'custom', reminder_custom_amount: '2', reminder_custom_unit: 'weeks' }],
  ['bday create photo', 'POST', '/birthdays', { name: 'Cem', birth_date: '1985-12-24', photo_data: PNG_1PX, year_unknown: null, notes: '', name_day: '' }],
  ['bday create linked', 'POST', '/birthdays', { name: 'Grace', birth_date: '1906-12-09', contact_id: 2 }],
  ['bday create no name', 'POST', '/birthdays', { birth_date: '1990-05-01' }],
  ['bday create blank name', 'POST', '/birthdays', { name: '   ', birth_date: '1990-05-01' }],
  ['bday create name emoji long', 'POST', '/birthdays', { name: LONG_EMOJI(200), birth_date: '1990-05-01' }],
  ['bday create no date', 'POST', '/birthdays', { name: 'X' }],
  ['bday create date not a day', 'POST', '/birthdays', { name: 'X', birth_date: '1990-02-30' }],
  ['bday create date shape', 'POST', '/birthdays', { name: 'X', birth_date: '1.5.1990' }],
  ['bday create year unknown text', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', year_unknown: 'yes' }],
  ['bday create notes emoji long', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', notes: LONG_EMOJI(5000) }],
  ['bday create photo bad', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', photo_data: 'data:image/png;base64,AAAA' }],
  ['bday create photo not data', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', photo_data: 'hello' }],
  ['bday create name day shape', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', name_day: '3-4' }],
  ['bday create name day not a day', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', name_day: '13-40' }],
  ['bday create reminder negative', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', reminder_offset: -5 }],
  ['bday create reminder word', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', reminder_offset: 'soon' }],
  ['bday create reminder amount zero', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', reminder_custom_amount: 0 }],
  ['bday create reminder unit', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', reminder_custom_unit: 'years' }],
  ['bday create reminder bool', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', reminder_offset: true }],
  ['bday create contact text', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', contact_id: '1' }],
  ['bday create contact huge', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', contact_id: 1e20 }],
  ['bday create contact unknown', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', contact_id: 999 }],
  ['bday create contact taken', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', contact_id: 2 }],
  ['bday create contact hidden', 'POST', '/birthdays', { name: 'X', birth_date: '1990-05-01', contact_id: 3 }, { scopes: ['calendar:write'] }],
  ['bday create contact empty', 'POST', '/birthdays', { name: 'Dora', birth_date: '1990-05-02', contact_id: '' }],
  ['bday create no body', 'POST', '/birthdays', NO_BODY],
  ['bday create list body', 'POST', '/birthdays', []],
  ['bday list', 'GET', '/birthdays', NO_BODY],
  ['bday list query', 'GET', '/birthdays?q=%20ad%20', NO_BODY],
  ['bday list hidden contacts', 'GET', '/birthdays', NO_BODY, { scopes: ['calendar:read'] }],
  ['bday upcoming', 'GET', '/birthdays/upcoming?limit=2', NO_BODY],
  ['bday upcoming no limit', 'GET', '/birthdays/upcoming', NO_BODY],
  ['bday upcoming limit text', 'GET', '/birthdays/upcoming?limit=x', NO_BODY],
  ['bday candidates', 'GET', '/birthdays/import/candidates', NO_BODY],
  ['bday candidates hidden', 'GET', '/birthdays/import/candidates', NO_BODY, { scopes: ['calendar:read'] }],
  ['bday import', 'POST', '/birthdays/import', { contact_ids: [1, 3] }],
  ['bday import again', 'POST', '/birthdays/import', { contact_ids: [1, 999] }],
  ['bday import empty', 'POST', '/birthdays/import', { contact_ids: [] }],
  ['bday import missing', 'POST', '/birthdays/import', {}],
  ['bday import not a list', 'POST', '/birthdays/import', { contact_ids: 1 }],
  ['bday import too many', 'POST', '/birthdays/import', { contact_ids: Array.from({ length: 501 }, (_, i) => i + 1) }],
  ['bday import text', 'POST', '/birthdays/import', { contact_ids: ['x'] }],
  ['bday import hidden', 'POST', '/birthdays/import', { contact_ids: [1] }, { scopes: ['calendar:write'] }],
  ['bday import no body', 'POST', '/birthdays/import', NO_BODY],
  () => {
    db.prepare("INSERT INTO birthdays (name, birth_date, family_user_id, created_by, reminder_offset, reminder_custom_amount, reminder_custom_unit) VALUES ('Tom', '1980-01-02', ?, ?, '15', 0, 'fortnights')").run(USERS.parent.id, USERS.parent.id);
  },
  ['bday update', 'PUT', '/birthdays/1', { name: ' Ada L. ', notes: ' neu ', name_day: null, reminder_offset: '', photo_data: PNG_1PX }],
  ['bday update date', 'PUT', '/birthdays/1', { birth_date: '1991-06-02' }],
  ['bday update yearless on', 'PUT', '/birthdays/1', { year_unknown: 1 }],
  ['bday update yearless off without date', 'PUT', '/birthdays/1', { year_unknown: false }],
  ['bday update yearless off', 'PUT', '/birthdays/1', { year_unknown: 0, birth_date: '1991-06-02' }],
  ['bday update nulls', 'PUT', '/birthdays/1', { name: null, birth_date: null, notes: null, photo_data: null }],
  ['bday update empty date', 'PUT', '/birthdays/3', { birth_date: '' }],
  ['bday update empty name', 'PUT', '/birthdays/1', { name: '' }],
  ['bday update blank name', 'PUT', '/birthdays/1', { name: '   ' }],
  ['bday update name number', 'PUT', '/birthdays/1', { name: 5 }],
  ['bday update date not a day', 'PUT', '/birthdays/1', { birth_date: '1991-02-30' }],
  ['bday update photo bad', 'PUT', '/birthdays/1', { photo_data: 'data:image/gif;base64,AAAA' }],
  ['bday update name day not a day', 'PUT', '/birthdays/1', { name_day: '02-30' }],
  ['bday update legacy reminder kept', 'PUT', '/birthdays/8', { reminder_offset: '15', reminder_custom_amount: 0, reminder_custom_unit: 'fortnights' }],
  ['bday update legacy reminder changed', 'PUT', '/birthdays/8', { reminder_offset: '16', reminder_custom_amount: 1000, reminder_custom_unit: 'months' }],
  ['bday update member link', 'PUT', '/birthdays/8', { contact_id: 4 }],
  ['bday update link', 'PUT', '/birthdays/2', { contact_id: 4 }],
  ['bday update link taken', 'PUT', '/birthdays/2', { contact_id: 2 }],
  ['bday update link same', 'PUT', '/birthdays/4', { contact_id: 2 }],
  ['bday update link hidden', 'PUT', '/birthdays/2', { contact_id: 1 }, { scopes: ['calendar:write'] }],
  ['bday update unlink', 'PUT', '/birthdays/2', { contact_id: null }],
  ['bday update unknown', 'PUT', '/birthdays/999', { name: 'x' }],
  ['bday update id text', 'PUT', '/birthdays/1x', { name: 'x' }],
  ['bday update no body', 'PUT', '/birthdays/1', NO_BODY],
  ['bday options', 'GET', '/birthdays/meta/options', NO_BODY],
  ['bday delete unknown', 'DELETE', '/birthdays/999', NO_BODY],
  ['bday delete', 'DELETE', '/birthdays/3', NO_BODY],
  ['bday delete again', 'DELETE', '/birthdays/3', NO_BODY],

  // ── quick links ───────────────────────────────────────────────────────────
  ['link list empty', 'GET', '/quick-links', NO_BODY],
  ['link create', 'POST', '/quick-links', { name: ' NAS ', url: '192.168.1.5:8096', color: '#112233', icon_name: ' server ' }],
  ['link create private', 'POST', '/quick-links', { name: 'Bank', url: 'https://bank.example/', visibility: 'private', icon_data: PNG_1PX, color: '' }],
  ['link create null visibility', 'POST', '/quick-links', { name: 'Wiki', url: 'http://wiki.example', visibility: null, icon_name: '', icon_data: null }],
  ['link create by child', 'POST', '/quick-links', { name: 'Spiel', url: 'https://game.example' }, { as: 'child' }],
  ['link create no name', 'POST', '/quick-links', { url: 'https://x.example' }],
  ['link create blank name', 'POST', '/quick-links', { name: '   ', url: 'https://x.example' }],
  ['link create name emoji long', 'POST', '/quick-links', { name: LONG_EMOJI(100), url: 'https://x.example' }],
  ['link create no url', 'POST', '/quick-links', { name: 'X' }],
  ['link create blank url', 'POST', '/quick-links', { name: 'X', url: '   ' }],
  ['link create url protocol', 'POST', '/quick-links', { name: 'X', url: 'javascript:alert(1)' }],
  ['link create url malformed', 'POST', '/quick-links', { name: 'X', url: 'http://' }],
  ['link create color word', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', color: 'rot' }],
  ['link create color false', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', color: false }],
  ['link create icon number', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', icon_data: 5 }],
  ['link create icon bad', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', icon_data: 'data:image/gif;base64,AAAA' }],
  ['link create icon mismatch', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', icon_data: 'data:image/png;base64,AAAA' }],
  ['link create icon too big', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', icon_data: `data:image/png;base64,${'A'.repeat(140 * 1024)}` }],
  ['link create glyph number', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', icon_name: 5 }],
  ['link create glyph bad', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', icon_name: 'Bad Name' }],
  ['link create glyph long', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', icon_name: 'a'.repeat(49) }],
  ['link create glyph blank', 'POST', '/quick-links', { name: 'Leer', url: 'https://leer.example', icon_name: '   ' }],
  ['link create visibility unknown', 'POST', '/quick-links', { name: 'X', url: 'https://x.example', visibility: 'family' }],
  ['link create several errors', 'POST', '/quick-links', { name: '  ', url: 'ftp://x', icon_name: 'Bad Name' }],
  ['link create no body', 'POST', '/quick-links', NO_BODY],
  ['link list', 'GET', '/quick-links', NO_BODY],
  ['link list by child', 'GET', '/quick-links', NO_BODY, { as: 'child' }],
  ['link order', 'PUT', '/quick-links/order', { ids: [3, 1, 2, 999, 1] }],
  ['link order by child', 'PUT', '/quick-links/order', { ids: [2, 4] }, { as: 'child' }],
  ['link order empty', 'PUT', '/quick-links/order', { ids: [] }],
  ['link order missing', 'PUT', '/quick-links/order', {}],
  ['link order not a list', 'PUT', '/quick-links/order', { ids: 'x' }],
  ['link order text', 'PUT', '/quick-links/order', { ids: ['1'] }],
  ['link order no body', 'PUT', '/quick-links/order', NO_BODY],
  ['link update', 'PUT', '/quick-links/1', { name: 'NAS 2', url: 'nas.local', color: null, icon_name: null, visibility: 'private' }],
  ['link update keep', 'PUT', '/quick-links/1', { visibility: null }],
  ['link update colour empty', 'PUT', '/quick-links/3', { color: '', icon_data: '' }],
  ['link update blank name', 'PUT', '/quick-links/3', { name: '  ' }],
  ['link update url bad', 'PUT', '/quick-links/3', { url: 'mailto:x@example.org' }],
  ['link update color word', 'PUT', '/quick-links/3', { color: 'rot' }],
  ['link update icon number', 'PUT', '/quick-links/3', { icon_data: 5 }],
  ['link update visibility unknown', 'PUT', '/quick-links/3', { visibility: 'x' }],
  ['link update unknown', 'PUT', '/quick-links/999', { name: 'x' }],
  ['link update private of other', 'PUT', '/quick-links/2', { name: 'x' }, { as: 'child' }],
  ['link update by child', 'PUT', '/quick-links/3', { name: 'x' }, { as: 'child' }],
  ['link update by admin', 'PUT', '/quick-links/3', { name: 'Wiki 2' }, { as: 'admin' }],
  ['link update id text', 'PUT', '/quick-links/3x', { name: 'x' }],
  ['link update no body', 'PUT', '/quick-links/3', NO_BODY],
  ['link delete unknown', 'DELETE', '/quick-links/999', NO_BODY],
  ['link delete private of other', 'DELETE', '/quick-links/2', NO_BODY, { as: 'admin' }],
  ['link delete by child', 'DELETE', '/quick-links/3', NO_BODY, { as: 'child' }],
  ['link delete', 'DELETE', '/quick-links/3', NO_BODY],
  ['link delete again', 'DELETE', '/quick-links/3', NO_BODY],
  () => {
    const insert = db.prepare("INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('Fill', 'https://fill.example/', 'all', ?, 99)");
    while (db.prepare('SELECT COUNT(*) AS n FROM quick_links').get().n < 24) insert.run(USERS.parent.id);
  },
  ['link create limit', 'POST', '/quick-links', { name: 'X', url: 'https://x.example' }],
  ['link create limit and invalid', 'POST', '/quick-links', { name: '  ', url: 'https://x.example' }],
];

/** @type {Record<string, { status: number, body: unknown }>} */
// Written at 80f4700ce, before the refactor.
const EXPECTED = {
  "cat list empty": {"status":200,"body":{"data":[],"meta":{"can_manage_household":false}}},
  "cat create": {"status":201,"body":{"data":{"id":1,"name":"Einkauf","scope":"personal","owner_user_id":2,"sort_order":0}}},
  "cat create second": {"status":201,"body":{"data":{"id":2,"name":"Schule","scope":"personal","owner_user_id":2,"sort_order":1}}},
  "cat create duplicate": {"status":409,"body":{"error":"A category with this name already exists.","code":409,"reason":"category_exists"}},
  "cat create blank": {"status":400,"body":{"error":"Category name must contain 1 to 80 characters","code":400}},
  "cat create long emoji": {"status":400,"body":{"error":"Category name must contain 1 to 80 characters","code":400}},
  "cat create name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "cat create no name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "cat create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "cat create scope unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/scope","rule":"enum"}]}},
  "cat create scope null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/scope","rule":"type"}]}},
  "cat create scope number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/scope","rule":"type"}]}},
  "cat create household by child": {"status":403,"body":{"error":"Household category management is not allowed.","code":403}},
  "cat create household by admin": {"status":201,"body":{"data":{"id":3,"name":"Haus","scope":"household","owner_user_id":null,"sort_order":0}}},
  "cat create personal of child": {"status":201,"body":{"data":{"id":4,"name":"Kind","scope":"personal","owner_user_id":3,"sort_order":0}}},
  "cat create personal of admin": {"status":201,"body":{"data":{"id":5,"name":"Admin","scope":"personal","owner_user_id":1,"sort_order":0}}},
  "cat list": {"status":200,"body":{"data":[{"id":3,"name":"Haus","scope":"household","owner_user_id":null,"sort_order":0},{"id":1,"name":"Einkauf","scope":"personal","owner_user_id":2,"sort_order":0},{"id":2,"name":"Schule","scope":"personal","owner_user_id":2,"sort_order":1}],"meta":{"can_manage_household":false}}},
  "cat reorder": {"status":200,"body":{"data":[{"id":3,"name":"Haus","scope":"household","owner_user_id":null,"sort_order":0},{"id":2,"name":"Schule","scope":"personal","owner_user_id":2,"sort_order":0},{"id":1,"name":"Einkauf","scope":"personal","owner_user_id":2,"sort_order":1}],"meta":{"can_manage_household":false}}},
  "cat reorder empty": {"status":200,"body":{"data":[{"id":3,"name":"Haus","scope":"household","owner_user_id":null,"sort_order":0},{"id":2,"name":"Schule","scope":"personal","owner_user_id":2,"sort_order":0},{"id":1,"name":"Einkauf","scope":"personal","owner_user_id":2,"sort_order":1}],"meta":{"can_manage_household":false}}},
  "cat reorder not a list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "cat reorder missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"required"}]}},
  "cat reorder too long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"maxItems"}]}},
  "cat reorder zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order/0","rule":"minimum"},{"path":"body/order/0","rule":"type"},{"path":"body/order/0","rule":"anyOf"}]}},
  "cat reorder negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order/0","rule":"minimum"},{"path":"body/order/0","rule":"type"},{"path":"body/order/0","rule":"anyOf"}]}},
  "cat reorder float": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order/0","rule":"type"},{"path":"body/order/0","rule":"anyOf"}]}},
  "cat reorder text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order/0","rule":"type"},{"path":"body/order/0","rule":"pattern"},{"path":"body/order/0","rule":"anyOf"}]}},
  "cat reorder duplicate": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"uniqueItems"}]}},
  "cat reorder duplicate as text": {"status":400,"body":{"error":"Invalid category order.","code":400}},
  "cat reorder unknown": {"status":404,"body":{"error":"Category not found.","code":404,"reason":"notes_category_not_found"}},
  "cat reorder foreign personal": {"status":404,"body":{"error":"Category not found.","code":404,"reason":"notes_category_not_found"}},
  "cat reorder mixed scopes": {"status":400,"body":{"error":"Categories can only be reordered within one scope.","code":400}},
  "cat reorder household by parent": {"status":403,"body":{"error":"Household category management is not allowed.","code":403}},
  "cat rename": {"status":200,"body":{"data":{"id":1,"name":"Einkaufen","scope":"personal","owner_user_id":2,"sort_order":1}}},
  "cat rename duplicate": {"status":409,"body":{"error":"A category with this name already exists.","code":409,"reason":"category_exists"}},
  "cat rename blank": {"status":400,"body":{"error":"Category name must contain 1 to 80 characters","code":400}},
  "cat rename number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "cat rename no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "cat rename id zero": {"status":400,"body":{"error":"Invalid category id.","code":400}},
  "cat rename id negative": {"status":400,"body":{"error":"Invalid category id.","code":400}},
  "cat rename id text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "cat rename unknown": {"status":404,"body":{"error":"Category not found.","code":404,"reason":"notes_category_not_found"}},
  "cat rename foreign personal": {"status":404,"body":{"error":"Category not found.","code":404,"reason":"notes_category_not_found"}},
  "cat rename household by parent": {"status":403,"body":{"error":"Household category management is not allowed.","code":403}},
  "cat delete id zero": {"status":400,"body":{"error":"Invalid category id.","code":400}},
  "cat delete unknown": {"status":404,"body":{"error":"Category not found.","code":404,"reason":"notes_category_not_found"}},
  "cat delete household by parent": {"status":403,"body":{"error":"Household category management is not allowed.","code":403}},
  "cat delete": {"status":204,"body":null},
  "note list empty": {"status":200,"body":{"data":[]}},
  "note create": {"status":201,"body":{"data":{"id":1,"title":"Einkauf","content":"Liste\n- [ ] Milch\n- [x] Brot","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[{"id":1,"name":"Einkaufen","scope":"personal","owner_user_id":2,"sort_order":1}]}}},
  "note create defaults": {"status":201,"body":{"data":{"id":2,"title":null,"content":"x","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note create private locked": {"status":201,"body":{"data":{"id":3,"title":null,"content":"privat","color":"#123456","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"private","locked":1,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note create locked open": {"status":201,"body":{"data":{"id":4,"title":null,"content":"gesperrt","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":1,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note create blank content": {"status":400,"body":{"error":"content must not be empty.","code":400}},
  "note create empty content": {"status":400,"body":{"error":"content is required.","code":400}},
  "note create no content": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/content","rule":"required"}]}},
  "note create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "note create content too long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/content","rule":"maxLength"}]}},
  "note create content emoji long": {"status":400,"body":{"error":"content may be at most 5000 characters long.","code":400}},
  "note create title emoji long": {"status":400,"body":{"error":"title may be at most 200 characters long.","code":400}},
  "note create color word": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"pattern"}]}},
  "note create color short hex": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"pattern"}]}},
  "note create visibility unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/visibility","rule":"enum"}]}},
  "note create visibility null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/visibility","rule":"type"}]}},
  "note create locked text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/locked","rule":"type"},{"path":"body/locked","rule":"enum"},{"path":"body/locked","rule":"oneOf"}]}},
  "note create locked null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/locked","rule":"type"},{"path":"body/locked","rule":"enum"},{"path":"body/locked","rule":"oneOf"}]}},
  "note create locked two": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/locked","rule":"enum"},{"path":"body/locked","rule":"type"},{"path":"body/locked","rule":"oneOf"}]}},
  "note create category unknown": {"status":400,"body":{"error":"Category is not available","code":400,"reason":"notes_selected_category_not_found"}},
  "note create category foreign": {"status":400,"body":{"error":"Category is not available","code":400,"reason":"notes_selected_category_not_found"}},
  "note create by child": {"status":201,"body":{"data":{"id":5,"title":null,"content":"Kind","color":"#FFEB3B","pinned":0,"created_by":3,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"emma","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note list": {"status":200,"body":{"data":[{"id":3,"title":null,"content":"privat","color":"#123456","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"private","locked":1,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]},{"id":5,"title":null,"content":"Kind","color":"#FFEB3B","pinned":0,"created_by":3,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"emma","creator_color":"#007AFF","creator_avatar":null,"categories":[]},{"id":4,"title":null,"content":"gesperrt","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":1,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]},{"id":2,"title":null,"content":"x","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]},{"id":1,"title":"Einkauf","content":"Liste\n- [ ] Milch\n- [x] Brot","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[{"id":1,"name":"Einkaufen","scope":"personal","owner_user_id":2,"sort_order":1}]}]}},
  "note list by child": {"status":200,"body":{"data":[{"id":5,"title":null,"content":"Kind","color":"#FFEB3B","pinned":0,"created_by":3,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"emma","creator_color":"#007AFF","creator_avatar":null,"categories":[]},{"id":4,"title":null,"content":"gesperrt","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":1,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]},{"id":2,"title":null,"content":"x","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]},{"id":1,"title":"Einkauf","content":"Liste\n- [ ] Milch\n- [x] Brot","color":"#FFEB3B","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}]}},
  "note update": {"status":200,"body":{"data":{"id":1,"title":"Neu","content":"Liste\n- [ ] Milch\n- [x] Brot","color":"#00FF00","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[{"id":1,"name":"Einkaufen","scope":"personal","owner_user_id":2,"sort_order":1}]}}},
  "note update nulls": {"status":200,"body":{"data":{"id":1,"title":null,"content":"Liste\n- [ ] Milch\n- [x] Brot","color":"#00FF00","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[{"id":1,"name":"Einkaufen","scope":"personal","owner_user_id":2,"sort_order":1}]}}},
  "note update empty colour": {"status":200,"body":{"data":{"id":2,"title":null,"content":"x","color":"","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note update content blank": {"status":200,"body":{"data":{"id":2,"title":null,"content":"","color":"","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note update content emoji long": {"status":400,"body":{"error":"content may be at most 5000 characters long.","code":400}},
  "note update title emoji long": {"status":400,"body":{"error":"title may be at most 200 characters long.","code":400}},
  "note update color word": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"pattern"}]}},
  "note update visibility unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/visibility","rule":"enum"}]}},
  "note update visibility null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/visibility","rule":"type"}]}},
  "note update locked text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/locked","rule":"type"},{"path":"body/locked","rule":"enum"},{"path":"body/locked","rule":"oneOf"}]}},
  "note update visibility same": {"status":200,"body":{"data":{"id":2,"title":null,"content":"","color":"","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note update visibility by admin": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "note update lock by admin": {"status":200,"body":{"data":{"id":2,"title":null,"content":"","color":"","pinned":0,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":1,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note update unknown": {"status":404,"body":{"error":"Note not found.","code":404,"reason":"notes_note_not_found"}},
  "note update private of other": {"status":404,"body":{"error":"Note not found.","code":404,"reason":"notes_note_not_found"}},
  "note update by child": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "note update categories by child": {"status":200,"body":{"data":{"id":1,"title":null,"content":"Liste\n- [ ] Milch\n- [x] Brot","color":"#00FF00","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note update locked by child": {"status":403,"body":{"error":"This note is locked; only its creator and administrators can change it.","code":403,"reason":"note_locked"}},
  "note update category unknown": {"status":400,"body":{"error":"Category is not available","code":400,"reason":"notes_selected_category_not_found"}},
  "note update category set": {"status":200,"body":{"data":{"id":1,"title":null,"content":"Liste\n- [ ] Milch\n- [x] Brot","color":"#00FF00","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[{"id":1,"name":"Einkaufen","scope":"personal","owner_user_id":2,"sort_order":1}]}}},
  "note update no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "note pin": {"status":200,"body":{"data":{"id":2,"pinned":1}}},
  "note pin with body": {"status":200,"body":{"data":{"id":2,"pinned":0}}},
  "note pin unknown": {"status":404,"body":{"error":"Note not found.","code":404,"reason":"notes_note_not_found"}},
  "note pin by child": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "note pin locked by child": {"status":403,"body":{"error":"This note is locked; only its creator and administrators can change it.","code":403,"reason":"note_locked"}},
  "note check": {"status":200,"body":{"data":{"id":1,"title":null,"content":"Liste\n- [x] Milch\n- [x] Brot","color":"#00FF00","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[{"id":1,"name":"Einkaufen","scope":"personal","owner_user_id":2,"sort_order":1}]}}},
  "note check same": {"status":200,"body":{"data":{"id":1,"title":null,"content":"Liste\n- [x] Milch\n- [x] Brot","color":"#00FF00","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[{"id":1,"name":"Einkaufen","scope":"personal","owner_user_id":2,"sort_order":1}]}}},
  "note check by child": {"status":200,"body":{"data":{"id":1,"title":null,"content":"Liste\n- [x] Milch\n- [ ] Brot","color":"#00FF00","pinned":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","visibility":"all","locked":0,"creator_name":"tom","creator_color":"#007AFF","creator_avatar":null,"categories":[]}}},
  "note check line negative": {"status":400,"body":{"error":"Invalid line number.","code":400}},
  "note check line text": {"status":400,"body":{"error":"Invalid line number.","code":400}},
  "note check checked text": {"status":400,"body":{"error":"checked must be true or false.","code":400}},
  "note check expect number": {"status":400,"body":{"error":"expect must be a string.","code":400}},
  "note check stale": {"status":409,"body":{"error":"The note has changed in the meantime. Refresh and try again.","code":409,"reason":"stale"}},
  "note check out of range": {"status":409,"body":{"error":"The note has changed in the meantime. Refresh and try again.","code":409,"reason":"out_of_range"}},
  "note check not a checklist line": {"status":409,"body":{"error":"The note has changed in the meantime. Refresh and try again.","code":409,"reason":"not_a_checklist_line"}},
  "note check unknown": {"status":404,"body":{"error":"Note not found.","code":404,"reason":"notes_note_not_found"}},
  "note check locked by child": {"status":403,"body":{"error":"This note is locked; only its creator and administrators can change it.","code":403,"reason":"note_locked"}},
  "note check no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "note delete unknown": {"status":404,"body":{"error":"Note not found.","code":404,"reason":"notes_note_not_found"}},
  "note delete by child": {"status":403,"body":{"error":"You can only change entries you created.","code":403,"reason":"not_owner"}},
  "note delete locked by child": {"status":403,"body":{"error":"This note is locked; only its creator and administrators can change it.","code":403,"reason":"note_locked"}},
  "note delete id text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "note delete": {"status":204,"body":null},
  "note delete again": {"status":404,"body":{"error":"Note not found.","code":404,"reason":"notes_note_not_found"}},
  "bday list empty": {"status":200,"body":{"data":[]}},
  "bday create": {"status":201,"body":{"data":{"id":1,"name":"Ada","birth_date":"1990-05-01","notes":"Kuchen","photo_data":null,"calendar_event_id":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"1440","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":"03-04","name_day_calendar_event_id":2,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-01","next_age":37,"days_until":164,"next_name_day":"2027-03-04","name_day_days_until":106}}},
  "bday create yearless": {"status":201,"body":{"data":{"id":2,"name":"Bea","birth_date":"2000-02-29","notes":null,"photo_data":null,"calendar_event_id":3,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"custom","reminder_custom_amount":2,"reminder_custom_unit":"weeks","contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":1,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-02-28","next_age":null,"days_until":102,"next_name_day":null,"name_day_days_until":null}}},
  "bday create photo": {"status":201,"body":{"data":{"id":3,"name":"Cem","birth_date":"1985-12-24","notes":null,"photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":4,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-24","next_age":41,"days_until":36,"next_name_day":null,"name_day_days_until":null}}},
  "bday create linked": {"status":201,"body":{"data":{"id":4,"name":"Grace","birth_date":"1906-12-09","notes":null,"photo_data":null,"calendar_event_id":5,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":2,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-09","next_age":120,"days_until":21,"next_name_day":null,"name_day_days_until":null}}},
  "bday create no name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "bday create blank name": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  "bday create name emoji long": {"status":400,"body":{"error":"Name may be at most 200 characters long.","code":400}},
  "bday create no date": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/birth_date","rule":"required"}]}},
  "bday create date not a day": {"status":400,"body":{"error":"Birth date must be a valid calendar date.","code":400}},
  "bday create date shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/birth_date","rule":"pattern"}]}},
  "bday create year unknown text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/year_unknown","rule":"type"},{"path":"body/year_unknown","rule":"enum"},{"path":"body/year_unknown","rule":"oneOf"}]}},
  "bday create notes emoji long": {"status":400,"body":{"error":"Notes may be at most 5000 characters long.","code":400}},
  "bday create photo bad": {"status":400,"body":{"error":"Profile picture content does not match its image type.","code":400}},
  "bday create photo not data": {"status":400,"body":{"error":"Profile picture must be a valid image data URL.","code":400}},
  "bday create name day shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name_day","rule":"pattern"}]}},
  "bday create name day not a day": {"status":400,"body":{"error":"Name day must be a valid month and day.","code":400}},
  "bday create reminder negative": {"status":400,"body":{"error":"Reminder must be empty, \"custom\" or whole minutes from 0 to 10069920.","code":400}},
  "bday create reminder word": {"status":400,"body":{"error":"Reminder must be empty, \"custom\" or whole minutes from 0 to 10069920.","code":400}},
  "bday create reminder amount zero": {"status":400,"body":{"error":"Custom reminder amount must be a whole number from 1 to 999.","code":400}},
  "bday create reminder unit": {"status":400,"body":{"error":"Custom reminder unit must be one of: minutes, hours, days, weeks.","code":400}},
  "bday create reminder bool": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset","rule":"type"},{"path":"body/reminder_offset","rule":"anyOf"}]}},
  "bday create contact text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/contact_id","rule":"type"},{"path":"body/contact_id","rule":"maxLength"},{"path":"body/contact_id","rule":"anyOf"}]}},
  "bday create contact huge": {"status":400,"body":{"error":"contact_id must be a contact id or null.","code":400}},
  "bday create contact unknown": {"status":400,"body":{"error":"Contact not found.","code":400,"reason":"birthdays_selected_contact_not_found"}},
  "bday create contact taken": {"status":409,"body":{"error":"This contact is already linked to another birthday.","code":409,"reason":"birthdays_contact_linked"}},
  "bday create contact hidden": {"status":403,"body":{"error":"Contact access is required to link a birthday to a contact.","code":403,"reason":"cross_module_access"}},
  "bday create contact empty": {"status":201,"body":{"data":{"id":5,"name":"Dora","birth_date":"1990-05-02","notes":null,"photo_data":null,"calendar_event_id":6,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-02","next_age":37,"days_until":165,"next_name_day":null,"name_day_days_until":null}}},
  "bday create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "bday create list body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "bday list": {"status":200,"body":{"data":[{"id":4,"name":"Grace","birth_date":"1906-12-09","notes":null,"photo_data":null,"calendar_event_id":5,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":2,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-09","next_age":120,"days_until":21,"next_name_day":null,"name_day_days_until":null,"contact_name":"Grace Hopper"},{"id":3,"name":"Cem","birth_date":"1985-12-24","notes":null,"photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":4,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-24","next_age":41,"days_until":36,"next_name_day":null,"name_day_days_until":null},{"id":2,"name":"Bea","birth_date":"2000-02-29","notes":null,"photo_data":null,"calendar_event_id":3,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"custom","reminder_custom_amount":2,"reminder_custom_unit":"weeks","contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":1,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-02-28","next_age":null,"days_until":102,"next_name_day":null,"name_day_days_until":null},{"id":1,"name":"Ada","birth_date":"1990-05-01","notes":"Kuchen","photo_data":null,"calendar_event_id":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"1440","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":"03-04","name_day_calendar_event_id":2,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-01","next_age":37,"days_until":164,"next_name_day":"2027-03-04","name_day_days_until":106},{"id":5,"name":"Dora","birth_date":"1990-05-02","notes":null,"photo_data":null,"calendar_event_id":6,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-02","next_age":37,"days_until":165,"next_name_day":null,"name_day_days_until":null}]}},
  "bday list query": {"status":200,"body":{"data":[{"id":1,"name":"Ada","birth_date":"1990-05-01","notes":"Kuchen","photo_data":null,"calendar_event_id":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"1440","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":"03-04","name_day_calendar_event_id":2,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-01","next_age":37,"days_until":164,"next_name_day":"2027-03-04","name_day_days_until":106}]}},
  "bday list hidden contacts": {"status":200,"body":{"data":[{"id":4,"name":"Grace","birth_date":"1906-12-09","notes":null,"photo_data":null,"calendar_event_id":5,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":2,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-09","next_age":120,"days_until":21,"next_name_day":null,"name_day_days_until":null},{"id":3,"name":"Cem","birth_date":"1985-12-24","notes":null,"photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":4,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-24","next_age":41,"days_until":36,"next_name_day":null,"name_day_days_until":null},{"id":2,"name":"Bea","birth_date":"2000-02-29","notes":null,"photo_data":null,"calendar_event_id":3,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"custom","reminder_custom_amount":2,"reminder_custom_unit":"weeks","contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":1,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-02-28","next_age":null,"days_until":102,"next_name_day":null,"name_day_days_until":null},{"id":1,"name":"Ada","birth_date":"1990-05-01","notes":"Kuchen","photo_data":null,"calendar_event_id":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"1440","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":"03-04","name_day_calendar_event_id":2,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-01","next_age":37,"days_until":164,"next_name_day":"2027-03-04","name_day_days_until":106},{"id":5,"name":"Dora","birth_date":"1990-05-02","notes":null,"photo_data":null,"calendar_event_id":6,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-02","next_age":37,"days_until":165,"next_name_day":null,"name_day_days_until":null}]}},
  "bday upcoming": {"status":200,"body":{"data":[{"id":4,"name":"Grace","birth_date":"1906-12-09","notes":null,"photo_data":null,"calendar_event_id":5,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":2,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-09","next_age":120,"days_until":21,"next_name_day":null,"name_day_days_until":null},{"id":3,"name":"Cem","birth_date":"1985-12-24","notes":null,"photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":4,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-24","next_age":41,"days_until":36,"next_name_day":null,"name_day_days_until":null}]}},
  "bday upcoming no limit": {"status":200,"body":{"data":[{"id":4,"name":"Grace","birth_date":"1906-12-09","notes":null,"photo_data":null,"calendar_event_id":5,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":2,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-09","next_age":120,"days_until":21,"next_name_day":null,"name_day_days_until":null},{"id":3,"name":"Cem","birth_date":"1985-12-24","notes":null,"photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":4,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-24","next_age":41,"days_until":36,"next_name_day":null,"name_day_days_until":null},{"id":2,"name":"Bea","birth_date":"2000-02-29","notes":null,"photo_data":null,"calendar_event_id":3,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"custom","reminder_custom_amount":2,"reminder_custom_unit":"weeks","contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":1,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-02-28","next_age":null,"days_until":102,"next_name_day":null,"name_day_days_until":null},{"id":1,"name":"Ada","birth_date":"1990-05-01","notes":"Kuchen","photo_data":null,"calendar_event_id":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"1440","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":"03-04","name_day_calendar_event_id":2,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-01","next_age":37,"days_until":164,"next_name_day":"2027-03-04","name_day_days_until":106},{"id":5,"name":"Dora","birth_date":"1990-05-02","notes":null,"photo_data":null,"calendar_event_id":6,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-02","next_age":37,"days_until":165,"next_name_day":null,"name_day_days_until":null}]}},
  "bday upcoming limit text": {"status":200,"body":{"data":[{"id":4,"name":"Grace","birth_date":"1906-12-09","notes":null,"photo_data":null,"calendar_event_id":5,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":2,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-09","next_age":120,"days_until":21,"next_name_day":null,"name_day_days_until":null},{"id":3,"name":"Cem","birth_date":"1985-12-24","notes":null,"photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":4,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-24","next_age":41,"days_until":36,"next_name_day":null,"name_day_days_until":null},{"id":2,"name":"Bea","birth_date":"2000-02-29","notes":null,"photo_data":null,"calendar_event_id":3,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"custom","reminder_custom_amount":2,"reminder_custom_unit":"weeks","contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":1,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-02-28","next_age":null,"days_until":102,"next_name_day":null,"name_day_days_until":null},{"id":1,"name":"Ada","birth_date":"1990-05-01","notes":"Kuchen","photo_data":null,"calendar_event_id":1,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"1440","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":"03-04","name_day_calendar_event_id":2,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-01","next_age":37,"days_until":164,"next_name_day":"2027-03-04","name_day_days_until":106},{"id":5,"name":"Dora","birth_date":"1990-05-02","notes":null,"photo_data":null,"calendar_event_id":6,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-02","next_age":37,"days_until":165,"next_name_day":null,"name_day_days_until":null}]}},
  "bday candidates": {"status":200,"body":{"data":{"withBirthday":[{"id":1,"name":"Ada Lovelace","birthday":"1980-03-03","birthday_year_unknown":false,"already_imported":false},{"id":3,"name":"Alan Turing","birthday":"1980-03-03","birthday_year_unknown":false,"already_imported":false},{"id":2,"name":"Grace Hopper","birthday":"1980-03-03","birthday_year_unknown":false,"already_imported":true},{"id":4,"name":"Konrad Zuse","birthday":"1980-03-03","birthday_year_unknown":false,"already_imported":false}],"withoutBirthday":[]}}},
  "bday candidates hidden": {"status":403,"body":{"error":"Contact access is required to import birthdays.","code":403,"reason":"cross_module_access"}},
  "bday import": {"status":201,"body":{"data":{"imported":2,"skipped":0}}},
  "bday import again": {"status":201,"body":{"data":{"imported":0,"skipped":2}}},
  "bday import empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/contact_ids","rule":"minItems"}]}},
  "bday import missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/contact_ids","rule":"required"}]}},
  "bday import not a list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/contact_ids","rule":"type"}]}},
  "bday import too many": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/contact_ids","rule":"maxItems"}]}},
  "bday import text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/contact_ids/0","rule":"type"}]}},
  "bday import hidden": {"status":403,"body":{"error":"Contact access is required to import birthdays.","code":403,"reason":"cross_module_access"}},
  "bday import no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "bday update": {"status":200,"body":{"data":{"id":1,"name":"Ada L.","birth_date":"1990-05-01","notes":"neu","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":null,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-05-01","next_age":37,"days_until":164,"next_name_day":null,"name_day_days_until":null}}},
  "bday update date": {"status":200,"body":{"data":{"id":1,"name":"Ada L.","birth_date":"1991-06-02","notes":"neu","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":null,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-06-02","next_age":36,"days_until":196,"next_name_day":null,"name_day_days_until":null}}},
  "bday update yearless on": {"status":200,"body":{"data":{"id":1,"name":"Ada L.","birth_date":"2000-06-02","notes":"neu","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":null,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":1,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-06-02","next_age":null,"days_until":196,"next_name_day":null,"name_day_days_until":null}}},
  "bday update yearless off without date": {"status":400,"body":{"error":"Birth date with its year is required when year_unknown is turned off.","code":400}},
  "bday update yearless off": {"status":200,"body":{"data":{"id":1,"name":"Ada L.","birth_date":"1991-06-02","notes":"neu","photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":null,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-06-02","next_age":36,"days_until":196,"next_name_day":null,"name_day_days_until":null}}},
  "bday update nulls": {"status":200,"body":{"data":{"id":1,"name":"Ada L.","birth_date":"1991-06-02","notes":null,"photo_data":null,"calendar_event_id":null,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-06-02","next_age":36,"days_until":196,"next_name_day":null,"name_day_days_until":null}}},
  "bday update empty date": {"status":200,"body":{"data":{"id":3,"name":"Cem","birth_date":"","notes":null,"photo_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","calendar_event_id":null,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-NaN-NaN","next_age":null,"days_until":null,"next_name_day":null,"name_day_days_until":null}}},
  "bday update empty name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"minLength"}]}},
  "bday update blank name": {"status":200,"body":{"data":{"id":1,"name":"","birth_date":"1991-06-02","notes":null,"photo_data":null,"calendar_event_id":null,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"","reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-06-02","next_age":36,"days_until":196,"next_name_day":null,"name_day_days_until":null}}},
  "bday update name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "bday update date not a day": {"status":400,"body":{"error":"Birth date must be a valid calendar date.","code":400}},
  "bday update photo bad": {"status":400,"body":{"error":"Profile picture content does not match its image type.","code":400}},
  "bday update name day not a day": {"status":400,"body":{"error":"Name day must be a valid month and day.","code":400}},
  "bday update legacy reminder kept": {"status":200,"body":{"data":{"id":8,"name":"Tom","birth_date":"1980-01-02","notes":null,"photo_data":null,"calendar_event_id":9,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":2,"reminder_offset":"15","reminder_custom_amount":0,"reminder_custom_unit":"fortnights","contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":"tom","family_avatar_color":"#007AFF","family_avatar_data":null,"next_birthday":"2027-01-02","next_age":47,"days_until":45,"next_name_day":null,"name_day_days_until":null}}},
  "bday update legacy reminder changed": {"status":400,"body":{"error":"Custom reminder amount must be a whole number from 1 to 999. Custom reminder unit must be one of: minutes, hours, days, weeks.","code":400}},
  "bday update member link": {"status":400,"body":{"error":"The birthday of a household member cannot be linked to a contact.","code":400,"reason":"birthdays_member_not_linkable"}},
  "bday update link": {"status":200,"body":{"data":{"id":2,"name":"Bea","birth_date":"2000-02-29","notes":null,"photo_data":null,"calendar_event_id":3,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"custom","reminder_custom_amount":2,"reminder_custom_unit":"weeks","contact_id":4,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":1,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-02-28","next_age":null,"days_until":102,"next_name_day":null,"name_day_days_until":null}}},
  "bday update link taken": {"status":409,"body":{"error":"This contact is already linked to another birthday.","code":409,"reason":"birthdays_contact_linked"}},
  "bday update link same": {"status":200,"body":{"data":{"id":4,"name":"Grace","birth_date":"1906-12-09","notes":null,"photo_data":null,"calendar_event_id":5,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":null,"reminder_custom_amount":null,"reminder_custom_unit":null,"contact_id":2,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":0,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2026-12-09","next_age":120,"days_until":21,"next_name_day":null,"name_day_days_until":null}}},
  "bday update link hidden": {"status":403,"body":{"error":"Contact access is required to link a birthday to a contact.","code":403,"reason":"cross_module_access"}},
  "bday update unlink": {"status":200,"body":{"data":{"id":2,"name":"Bea","birth_date":"2000-02-29","notes":null,"photo_data":null,"calendar_event_id":3,"created_by":2,"created_at":"<clock>","updated_at":"<clock>","family_user_id":null,"reminder_offset":"custom","reminder_custom_amount":2,"reminder_custom_unit":"weeks","contact_id":null,"name_day":null,"name_day_calendar_event_id":null,"year_unknown":1,"family_display_name":null,"family_avatar_color":null,"family_avatar_data":null,"next_birthday":"2027-02-28","next_age":null,"days_until":102,"next_name_day":null,"name_day_days_until":null}}},
  "bday update unknown": {"status":404,"body":{"error":"Birthday not found.","code":404,"reason":"birthdays_birthday_not_found"}},
  "bday update id text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "bday update no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "bday options": {"status":200,"body":{"data":{"photoMaxBytes":6990507,"acceptedImageTypes":["image/png","image/jpeg","image/webp","image/gif"]}}},
  "bday delete unknown": {"status":404,"body":{"error":"Birthday not found.","code":404,"reason":"birthdays_birthday_not_found"}},
  "bday delete": {"status":204,"body":null},
  "bday delete again": {"status":404,"body":{"error":"Birthday not found.","code":404,"reason":"birthdays_birthday_not_found"}},
  "link list empty": {"status":200,"body":{"data":[]}},
  "link create": {"status":201,"body":{"data":{"id":1,"name":"NAS","url":"https://192.168.1.5:8096/","icon_data":null,"icon_name":"server","color":"#112233","visibility":"all","created_by":2,"position":0,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link create private": {"status":201,"body":{"data":{"id":2,"name":"Bank","url":"https://bank.example/","icon_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","icon_name":null,"color":null,"visibility":"private","created_by":2,"position":1,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link create null visibility": {"status":201,"body":{"data":{"id":3,"name":"Wiki","url":"http://wiki.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":2,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link create by child": {"status":201,"body":{"data":{"id":4,"name":"Spiel","url":"https://game.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":3,"position":3,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link create no name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "link create blank name": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  "link create name emoji long": {"status":400,"body":{"error":"Name may be at most 100 characters long.","code":400}},
  "link create no url": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/url","rule":"required"}]}},
  "link create blank url": {"status":400,"body":{"error":"Address is required.","code":400}},
  "link create url protocol": {"status":400,"body":{"error":"Address must start with http:// or https://.","code":400}},
  "link create url malformed": {"status":400,"body":{"error":"Address must be a valid URL.","code":400}},
  "link create color word": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"pattern"}]}},
  "link create color false": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"type"}]}},
  "link create icon number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon_data","rule":"type"}]}},
  "link create icon bad": {"status":400,"body":{"error":"Icon must be PNG, JPEG, or WebP.","code":400}},
  "link create icon mismatch": {"status":400,"body":{"error":"Icon content does not match its image type.","code":400}},
  "link create icon too big": {"status":400,"body":{"error":"Icon image is too large.","code":400}},
  "link create glyph number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon_name","rule":"type"}]}},
  "link create glyph bad": {"status":400,"body":{"error":"Icon name must contain only lowercase letters, digits, and hyphens.","code":400}},
  "link create glyph long": {"status":400,"body":{"error":"Icon name is too long.","code":400}},
  "link create glyph blank": {"status":201,"body":{"data":{"id":5,"name":"Leer","url":"https://leer.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":4,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link create visibility unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/visibility","rule":"enum"}]}},
  "link create several errors": {"status":400,"body":{"error":"Name must not be empty. Icon name must contain only lowercase letters, digits, and hyphens. Address must start with http:// or https://.","code":400}},
  "link create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "link list": {"status":200,"body":{"data":[{"id":1,"name":"NAS","url":"https://192.168.1.5:8096/","icon_data":null,"icon_name":"server","color":"#112233","visibility":"all","created_by":2,"position":0,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":2,"name":"Bank","url":"https://bank.example/","icon_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","icon_name":null,"color":null,"visibility":"private","created_by":2,"position":1,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":3,"name":"Wiki","url":"http://wiki.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":2,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":4,"name":"Spiel","url":"https://game.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":3,"position":3,"created_at":"<clock>","updated_at":"<clock>","can_edit":false},{"id":5,"name":"Leer","url":"https://leer.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":4,"created_at":"<clock>","updated_at":"<clock>","can_edit":true}]}},
  "link list by child": {"status":200,"body":{"data":[{"id":1,"name":"NAS","url":"https://192.168.1.5:8096/","icon_data":null,"icon_name":"server","color":"#112233","visibility":"all","created_by":2,"position":0,"created_at":"<clock>","updated_at":"<clock>","can_edit":false},{"id":3,"name":"Wiki","url":"http://wiki.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":2,"created_at":"<clock>","updated_at":"<clock>","can_edit":false},{"id":4,"name":"Spiel","url":"https://game.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":3,"position":3,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":5,"name":"Leer","url":"https://leer.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":4,"created_at":"<clock>","updated_at":"<clock>","can_edit":false}]}},
  "link order": {"status":200,"body":{"data":[{"id":3,"name":"Wiki","url":"http://wiki.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":0,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":2,"name":"Bank","url":"https://bank.example/","icon_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","icon_name":null,"color":null,"visibility":"private","created_by":2,"position":2,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":1,"name":"NAS","url":"https://192.168.1.5:8096/","icon_data":null,"icon_name":"server","color":"#112233","visibility":"all","created_by":2,"position":3,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":4,"name":"Spiel","url":"https://game.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":3,"position":3,"created_at":"<clock>","updated_at":"<clock>","can_edit":false},{"id":5,"name":"Leer","url":"https://leer.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":4,"created_at":"<clock>","updated_at":"<clock>","can_edit":true}]}},
  "link order by child": {"status":200,"body":{"data":[{"id":3,"name":"Wiki","url":"http://wiki.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":0,"created_at":"<clock>","updated_at":"<clock>","can_edit":false},{"id":4,"name":"Spiel","url":"https://game.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":3,"position":0,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":1,"name":"NAS","url":"https://192.168.1.5:8096/","icon_data":null,"icon_name":"server","color":"#112233","visibility":"all","created_by":2,"position":3,"created_at":"<clock>","updated_at":"<clock>","can_edit":false},{"id":5,"name":"Leer","url":"https://leer.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":4,"created_at":"<clock>","updated_at":"<clock>","can_edit":false}]}},
  "link order empty": {"status":200,"body":{"data":[{"id":3,"name":"Wiki","url":"http://wiki.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":0,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":4,"name":"Spiel","url":"https://game.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":3,"position":0,"created_at":"<clock>","updated_at":"<clock>","can_edit":false},{"id":2,"name":"Bank","url":"https://bank.example/","icon_data":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","icon_name":null,"color":null,"visibility":"private","created_by":2,"position":2,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":1,"name":"NAS","url":"https://192.168.1.5:8096/","icon_data":null,"icon_name":"server","color":"#112233","visibility":"all","created_by":2,"position":3,"created_at":"<clock>","updated_at":"<clock>","can_edit":true},{"id":5,"name":"Leer","url":"https://leer.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":4,"created_at":"<clock>","updated_at":"<clock>","can_edit":true}]}},
  "link order missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ids","rule":"required"}]}},
  "link order not a list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ids","rule":"type"}]}},
  "link order text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ids/0","rule":"type"}]}},
  "link order no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "link update": {"status":200,"body":{"data":{"id":1,"name":"NAS 2","url":"https://nas.local/","icon_data":null,"icon_name":null,"color":null,"visibility":"private","created_by":2,"position":3,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link update keep": {"status":200,"body":{"data":{"id":1,"name":"NAS 2","url":"https://nas.local/","icon_data":null,"icon_name":null,"color":null,"visibility":"private","created_by":2,"position":3,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link update colour empty": {"status":200,"body":{"data":{"id":3,"name":"Wiki","url":"http://wiki.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":0,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link update blank name": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  "link update url bad": {"status":400,"body":{"error":"Address must start with http:// or https://.","code":400}},
  "link update color word": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"pattern"}]}},
  "link update icon number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon_data","rule":"type"}]}},
  "link update visibility unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/visibility","rule":"enum"}]}},
  "link update unknown": {"status":404,"body":{"error":"Quick link not found.","code":404,"reason":"quick_links_link_not_found"}},
  "link update private of other": {"status":404,"body":{"error":"Quick link not found.","code":404,"reason":"quick_links_link_not_found"}},
  "link update by child": {"status":403,"body":{"error":"You cannot modify this entry.","code":403}},
  "link update by admin": {"status":200,"body":{"data":{"id":3,"name":"Wiki 2","url":"http://wiki.example/","icon_data":null,"icon_name":null,"color":null,"visibility":"all","created_by":2,"position":0,"created_at":"<clock>","updated_at":"<clock>"}}},
  "link update id text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "link update no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "link delete unknown": {"status":404,"body":{"error":"Quick link not found.","code":404,"reason":"quick_links_link_not_found"}},
  "link delete private of other": {"status":404,"body":{"error":"Quick link not found.","code":404,"reason":"quick_links_link_not_found"}},
  "link delete by child": {"status":403,"body":{"error":"You cannot modify this entry.","code":403}},
  "link delete": {"status":204,"body":null},
  "link delete again": {"status":404,"body":{"error":"Quick link not found.","code":404,"reason":"quick_links_link_not_found"}},
  "link create limit": {"status":400,"body":{"error":"At most 24 quick links can be created.","code":400,"reason":"quick_links_limit_reached","params":{"limit":24}}},
  "link create limit and invalid": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
};

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  const seen = new Set();
  for (const step of STEPS) {
    if (typeof step === 'function') { step(); continue; }
    const [name, method, path, body, opts] = step;
    assert.ok(!seen.has(name), `duplicate row name ${name}`);
    seen.add(name);
    const actual = await call(method, path, body, opts);
    assert.ok(Object.hasOwn(EXPECTED, name), `no expectation for ${name}`);
    assert.deepEqual({ status: actual.status, body: normalized(actual.body) }, EXPECTED[name], name);
  }
  assert.equal(seen.size, Object.keys(EXPECTED).length, 'every expectation has its row');
});

/**
 * An unexpected error: the table the route reads is renamed away for one
 * request. It must reach the central handler - its 500, its sentence, its log
 * line - and the next request is answered again.
 * @param {string} table
 * @param {string} method
 * @param {string} path
 * @param {string} pattern
 */
async function assertUnexpectedErrorIsCentral(table, method, path, pattern) {
  logged.error.length = 0;
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_away`);
  let res;
  try {
    res = await call(method, path, NO_BODY);
  } finally {
    db.exec(`ALTER TABLE ${table}_away RENAME TO ${table}`);
  }
  assert.deepEqual(res, { status: 500, body: { error: 'Internal server error.', code: 500 } }, `${method} ${path}`);
  assert.deepEqual(logged.error, [`Unhandled error: ${method} ${pattern} -> 500`], `${method} ${path}: the central handler logged it`);
  const again = await call(method, path, NO_BODY);
  assert.equal(again.status, 200, `${method} ${path} answers again`);
}

test('notes: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  await assertUnexpectedErrorIsCentral('notes', 'GET', '/notes', '/api/v1/notes/');
  await assertUnexpectedErrorIsCentral('note_categories', 'GET', '/notes/categories', '/api/v1/notes/categories');
});

test('birthdays: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  await assertUnexpectedErrorIsCentral('birthdays', 'GET', '/birthdays/upcoming', '/api/v1/birthdays/upcoming');
  await assertUnexpectedErrorIsCentral('contacts', 'GET', '/birthdays/import/candidates', '/api/v1/birthdays/import/candidates');
});

test('quick links: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  await assertUnexpectedErrorIsCentral('quick_links', 'GET', '/quick-links', '/api/v1/quick-links/');
});
