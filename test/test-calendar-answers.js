/**
 * Test: the answers of the calendar core and the overview stay byte-equal
 *       (#2810, phase 2 section E, group 10a, step b)
 * Purpose: server/routes/calendar/{read,crud,local-calendars,feed,sync-targets,
 *          subscriptions}.js (3, 10, 7, 5, 1, 6 operations) and
 *          server/routes/dashboard.js (1) dropped the hand checks the schema of
 *          their operation already covers (`validateRequest()` runs before
 *          every handler since #2881), the rights lines the middlewares in
 *          front of the check already answer (`requireCalendarWrite`,
 *          `refuseUploadWithoutDocumentsWrite`) and the try/catch blocks that
 *          answered an unexpected error with a 500 of their own. This suite
 *          holds that refactor:
 *
 *          (1) A table of requests to all 33 operations - valid, every refusal
 *          of the handler that stays (each `reason`, empty or too long after
 *          trimming, the calendar run of a date, the RRULE check and its
 *          exception for the stored rule (#756), a series that ends before its
 *          start or has no occurrence, the attachment refusals, visibility, a
 *          calendar or subscription that does not exist, path ids `0`, `-1`,
 *          `-0` and with a leading zero), every input a dropped hand check
 *          refused (now the schema's 400), not found and rights - for an
 *          admin, a member, a second member, a member who may only read the
 *          calendar, a member who may only read documents, a child and a
 *          paired display; it pins status and the WHOLE body. The
 *          expectations were written before the refactor (eacebb6a2) and are
 *          literal values in test/calendar-answers-expected.js (a module of
 *          its own only for the line limit), no fixture file, no update mode.
 *          The ICS feeds come from a local server on 127.0.0.1 (no request
 *          leaves the machine), the holidays from the holiday cache. SQLite
 *          stamps rows with its own clock, which mock.timers does not reach:
 *          test triggers pin `created_at`; `updated_at`, the random tokens,
 *          the sync stamps and the port of the local feed are masked. The
 *          clock stands still (`mock.timers`, 18.11.2026 12:00 UTC), the
 *          household lives in Europe/Berlin.
 *
 *          (2) An unexpected error in every route that answered its own 500
 *          reaches the central error handler - 500 with its fixed sentence and
 *          its log line `Unhandled error: <METHOD> <pattern> -> 500` - and the
 *          process keeps answering; async handlers (a rejected promise)
 *          included. An unexpected error AFTER an attachment was staged still
 *          removes the staged file (and a staged clone) before it goes on.
 *
 *          (3) What stays the route's own - the occurrence errors, the refused
 *          non-member, the feed cases of a subscription and the import, the
 *          502 of an unreachable feed, the foreign subscription, the private
 *          address, the restore gate - keeps its answer and never reaches the
 *          central handler; the rights the middlewares answer keep their 403.
 *
 *          (4) Each handler alone (without `validateRequest()`) keeps the type
 *          checks in front of a loop, `.length`, a string method or a value
 *          bound into SQL (sink, not route).
 * Run: npm run test:calendar-answers
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = 'calendar-answers-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js): the attachments of the events.
const STORAGE = tempDir('yuvomi-calendar-answers-');
process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
process.env.DOCUMENT_STORAGE_LOCAL_PATH = STORAGE;
process.env.MODULES_DIR = tempDir('yuvomi-calendar-answers-modules-');
// The feeds of the subscriptions come from 127.0.0.1.
process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK = 'true';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import rateLimit from 'express-rate-limit';
import { createCalendarApp } from './calendar-app.js';
import { EXPECTED, CHANGED } from './calendar-answers-expected.js';

const dbmod = await import('../server/db.js');
const restoreState = await import('../server/utils/restore-state.js');
const { applyChildStartPermissions } = await import('../server/authorize/index.ts');
const database = () => dbmod.get();

/** @param {string} key @param {string} value */
function setConfig(key, value) {
  database().prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
setConfig('household_timezone', 'Europe/Berlin');
setConfig('holiday_country', 'DE');
setConfig('holiday_subdivision', 'DE-BY');
setConfig('holiday_show_public', '1');
database().prepare("INSERT INTO holiday_cache (country, subdivision, year, type, start_date, end_date, name) VALUES ('DE', NULL, 2026, 'public', '2026-12-25', '2026-12-25', 'Weihnachten')").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

// SQLite stamps rows with its own clock, which mock.timers does not reach.
const STAMP = '2026-11-18T12:00:00Z';
for (const { name } of database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'search_index%'").all()) {
  const columns = database().prepare(`PRAGMA table_info(${name})`).all().map((/** @type {any} */ c) => c.name);
  if (!columns.includes('created_at')) continue;
  database().exec(`CREATE TRIGGER test_pin_${name}_created_at AFTER INSERT ON ${name} FOR EACH ROW BEGIN UPDATE ${name} SET created_at = '${STAMP}' WHERE rowid = NEW.rowid; END;`);
}

/** @param {string} username @param {string} role @param {string} [familyRole] */
function user(username, role, familyRole = 'parent') {
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role, avatar_color) VALUES (?, ?, 'x', ?, ?, '#336699')")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const MEM = user('tom', 'member');
const OTHER = user('ole', 'member');
const CHILD = user('kim', 'member', 'child');
applyChildStartPermissions(database(), { id: CHILD, role: 'member', family_role: 'child' });
const DISPLAY = user('wand', 'member', 'other');
const GUEST = user('gast', 'member', 'other');
// A split-expense guest: a users row that is no household member.
const GROUP = Number(database().prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(ADMIN).lastInsertRowid);
database().prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(GUEST, GROUP, ADMIN);

/** @type {Record<string, { id: number, role: string, access?: Record<string, string>, method?: string, scopes?: string[] }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  other: { id: OTHER, role: 'member' },
  reader: { id: MEM, role: 'member', access: { calendar: 'read' } },
  docread: { id: MEM, role: 'member', access: { documents: 'read' } },
  child: { id: CHILD, role: 'member' },
  display: { id: DISPLAY, role: 'member', method: 'display', scopes: ['calendar:read', 'dashboard:read'] },
};

// Local feeds: no request leaves the machine. The port is masked in the answers.
const FEED = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:feed-1@test\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261125T090000Z\r\nDTEND:20261125T100000Z\r\nSUMMARY:Feed Termin\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const feedServer = http.createServer((req, res) => {
  if (req.url === '/missing.ics') { res.writeHead(404); res.end('gone'); return; }
  res.writeHead(200, { 'Content-Type': 'text/calendar' });
  res.end(FEED);
});
await new Promise((r) => feedServer.listen(0, '127.0.0.1', () => r(null)));
const FEED_PORT = /** @type {any} */ (feedServer.address()).port;
const FEED_URL = `http://127.0.0.1:${FEED_PORT}/feed.ics`;
const MISSING_URL = `http://127.0.0.1:${FEED_PORT}/missing.ics`;
// A port nobody listens on: the fetch fails as a remote failure.
const closed = http.createServer();
await new Promise((r) => closed.listen(0, '127.0.0.1', () => r(null)));
const CLOSED_PORT = /** @type {any} */ (closed.address()).port;
await new Promise((r) => closed.close(() => r(null)));
const CLOSED_URL = `http://127.0.0.1:${CLOSED_PORT}/feed.ics`;

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createCalendarApp({
  log,
  jsonLimit: '10mb',
  // A generous limiter in front of the routes, as the app has one.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = actor.method ?? 'session';
    req.authScopes = actor.scopes ?? null;
    req.session = { userId: actor.id, role: actor.role };
    req.sessionModuleAccess = actor.access ?? null;
    // An unexpected error: the first answer of the handler throws.
    if (req.get('x-fail') === 'answer') {
      let thrown = false;
      for (const name of ['json', 'send', 'end', 'setHeader']) {
        const original = res[name];
        res[name] = function (/** @type {unknown[]} */ ...args) {
          if (!thrown) { thrown = true; throw new Error(`${name} broke`); }
          return original.apply(this, args);
        };
      }
    }
    next();
  },
});

const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
const APP_PORT = /** @type {any} */ (server.address()).port;
test.after(() => {
  server.close();
  feedServer.close();
});

// ── Requests ─────────────────────────────────────────────────────────────────
const NO_BODY = Symbol('no body');

/** @typedef {{ actor?: string, fail?: boolean }} CallOptions */

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {unknown} body a JSON value or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, route, body, { actor, fail } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {any} */
  let payload;
  if (body !== NO_BODY) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (actor !== undefined) headers['x-actor'] = actor;
  if (fail) headers['x-fail'] = 'answer';
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: payload });
  const text = await res.text();
  if (!text) return { status: res.status, body: null };
  return { status: res.status, body: JSON.parse(text) };
}

// Stamps of SQLite's own clock the triggers do not pin, the random tokens and
// what carries them, and the sync bookkeeping of a subscription.
const VOLATILE = new Set(['updated_at', 'token', 'feed_token', 'feed_url', 'url', 'last_sync', 'last_synced_at', 'last_sync_at', 'etag', 'last_modified', 'ical_uid', 'external_uid', 'uid']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (typeof v !== 'string') return v;
    if (VOLATILE.has(key) && v !== STAMP) return '<volatile>';
    return v.replaceAll(`:${FEED_PORT}/`, ':<feed>/').replaceAll(`:${APP_PORT}/`, ':<app>/').replaceAll(`:${CLOSED_PORT}`, ':<closed>');
  });
}

/** @type {Record<string, any>} */
const answered = {};
const LONG = (/** @type {number} */ n) => 'x'.repeat(n);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const C = '/calendar';
/** The id of a row the table created, by its row name. @param {string} row */
const idOf = (row) => answered[row]?.body?.data?.id;
const EV = (/** @type {Record<string, unknown>} */ over = {}) => ({
  title: 'Zahnarzt', description: null, start_datetime: '2026-11-20T09:00', end_datetime: '2026-11-20T10:00',
  all_day: false, location: null, color: null, icon: 'calendar', assigned_to: [ADMIN], visibility: 'all',
  countdown: false, recurrence_rule: null, ...over,
});
const SERIES = (/** @type {Record<string, unknown>} */ over = {}) => EV({ title: 'Training', start_datetime: '2026-11-19T08:00', end_datetime: '2026-11-19T09:00', recurrence_rule: 'FREQ=DAILY;COUNT=5', ...over });
const SUBSCRIPTION = (/** @type {Record<string, unknown>} */ over = {}) => ({ name: 'Schule', url: FEED_URL, color: '#336699', shared: true, ...over });
const ICS = FEED.replace('feed-1@test', 'import-1@test').replace('Feed Termin', 'Importiert');
// The occurrence keys of the daily series at 08:00 (floating wall time, #2034).
const KEY = (/** @type {number} */ day) => `2026-11-${String(day).padStart(2, '0')}T08:00:00`;

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ LOCAL CALENDARS (local-calendars.js) ═══════════════════════════════════
  ['lc list', 'GET', `${C}/calendars`, NO_BODY],
  ['lc list display', 'GET', `${C}/calendars`, NO_BODY, { actor: 'display' }],
  ['lc create', 'POST', `${C}/calendars`, { name: ' Arbeit ', color: '#112233' }],
  ['lc create default color', 'POST', `${C}/calendars`, { name: 'Verein' }],
  ['lc create mem', 'POST', `${C}/calendars`, { name: 'Sport', color: '#445566' }, { actor: 'mem' }],
  ['lc create child', 'POST', `${C}/calendars`, { name: 'Kinder' }, { actor: 'child' }],
  ['lc create name spaces', 'POST', `${C}/calendars`, { name: '   ' }],
  ['lc create name long', 'POST', `${C}/calendars`, { name: LONG(101) }],
  ['lc create name missing', 'POST', `${C}/calendars`, { color: '#112233' }],
  ['lc create name number', 'POST', `${C}/calendars`, { name: 5 }],
  ['lc create color word', 'POST', `${C}/calendars`, { name: 'Farbe', color: 'blue' }],
  ['lc create color null', 'POST', `${C}/calendars`, { name: 'Farbe', color: null }],
  ['lc create color short', 'POST', `${C}/calendars`, { name: 'Farbe', color: '#123' }],
  ['lc create no body', 'POST', `${C}/calendars`, NO_BODY],
  ['lc create reader', 'POST', `${C}/calendars`, { name: 'Lesend' }, { actor: 'reader' }],
  ['lc create reader bad body', 'POST', `${C}/calendars`, { name: 5 }, { actor: 'reader' }],
  ['lc reorder', 'PATCH', `${C}/calendars/reorder`, { order: [3, 1, 2, 4, 5] }],
  ['lc reorder missing one', 'PATCH', `${C}/calendars/reorder`, { order: [1, 2, 3] }],
  ['lc reorder unknown', 'PATCH', `${C}/calendars/reorder`, { order: [1, 2, 3, 4, 99] }],
  ['lc reorder text', 'PATCH', `${C}/calendars/reorder`, { order: ['1', '2'] }],
  ['lc reorder twice', 'PATCH', `${C}/calendars/reorder`, { order: [1, 1, 2, 3, 4] }],
  ['lc reorder no list', 'PATCH', `${C}/calendars/reorder`, { order: 'x' }],
  ['lc reorder zero', 'PATCH', `${C}/calendars/reorder`, { order: [0, 1, 2, 3, 4] }],
  ['lc reorder empty', 'PATCH', `${C}/calendars/reorder`, {}],
  ['lc reorder reader', 'PATCH', `${C}/calendars/reorder`, { order: [1, 2, 3, 4, 5] }, { actor: 'reader' }],
  ['lc reorder reader bad', 'PATCH', `${C}/calendars/reorder`, { order: 'x' }, { actor: 'reader' }],
  ['lc update name', 'PUT', `${C}/calendars/2`, { name: ' Büro ' }],
  ['lc update color', 'PUT', `${C}/calendars/2`, { color: '#aabbcc' }],
  ['lc update order', 'PUT', `${C}/calendars/2`, { sort_order: 7 }],
  ['lc update order zero', 'PUT', `${C}/calendars/3`, { sort_order: 0 }],
  ['lc update order minus', 'PUT', `${C}/calendars/2`, { sort_order: -1 }],
  ['lc update order text', 'PUT', `${C}/calendars/2`, { sort_order: '3' }],
  ['lc update order fraction', 'PUT', `${C}/calendars/2`, { sort_order: 1.5 }],
  ['lc update order null', 'PUT', `${C}/calendars/2`, { sort_order: null }],
  ['lc update order true', 'PUT', `${C}/calendars/2`, { sort_order: true }],
  ['lc update empty', 'PUT', `${C}/calendars/2`, {}],
  ['lc update no body', 'PUT', `${C}/calendars/2`, NO_BODY],
  ['lc update name spaces', 'PUT', `${C}/calendars/2`, { name: '  ' }],
  ['lc update name long', 'PUT', `${C}/calendars/2`, { name: LONG(101) }],
  ['lc update name and color bad', 'PUT', `${C}/calendars/2`, { name: '', color: '#zzzzzz' }],
  ['lc update color bad', 'PUT', `${C}/calendars/2`, { color: 'red' }],
  ['lc update gone', 'PUT', `${C}/calendars/999`, { name: 'Weg' }],
  ['lc update zero', 'PUT', `${C}/calendars/0`, { name: 'Null' }],
  ['lc update minus', 'PUT', `${C}/calendars/-1`, { name: 'Minus' }],
  ['lc update minus zero', 'PUT', `${C}/calendars/-0`, { name: 'Minus Null' }],
  ['lc update leading zero', 'PUT', `${C}/calendars/02`, { name: 'Büro 2' }],
  ['lc update letters', 'PUT', `${C}/calendars/abc`, { name: 'Text' }],
  ['lc update fraction', 'PUT', `${C}/calendars/1.5`, { name: 'Bruch' }],
  ['lc update hex', 'PUT', `${C}/calendars/0x2`, { name: 'Hex' }],
  ['lc update reader', 'PUT', `${C}/calendars/2`, { name: 'Lesend' }, { actor: 'reader' }],
  ['lc update reader letters', 'PUT', `${C}/calendars/abc`, { name: 5 }, { actor: 'reader' }],
  ['lc feed regenerate', 'POST', `${C}/calendars/2/feed/regenerate`, NO_BODY],
  ['lc feed regenerate mem', 'POST', `${C}/calendars/2/feed/regenerate`, NO_BODY, { actor: 'mem' }],
  ['lc feed regenerate gone', 'POST', `${C}/calendars/999/feed/regenerate`, NO_BODY],
  ['lc feed regenerate zero', 'POST', `${C}/calendars/0/feed/regenerate`, NO_BODY],
  ['lc feed regenerate letters', 'POST', `${C}/calendars/abc/feed/regenerate`, NO_BODY],
  ['lc feed regenerate 4', 'POST', `${C}/calendars/4/feed/regenerate`, NO_BODY],
  ['lc list admin feeds', 'GET', `${C}/calendars`, NO_BODY],
  ['lc list mem', 'GET', `${C}/calendars`, NO_BODY, { actor: 'mem' }],
  ['lc delete feed mem', 'DELETE', `${C}/calendars/4`, NO_BODY, { actor: 'mem' }],
  ['lc feed delete', 'DELETE', `${C}/calendars/2/feed`, NO_BODY],
  ['lc feed delete mem', 'DELETE', `${C}/calendars/2/feed`, NO_BODY, { actor: 'mem' }],
  ['lc feed delete gone', 'DELETE', `${C}/calendars/999/feed`, NO_BODY],
  ['lc feed delete minus', 'DELETE', `${C}/calendars/-1/feed`, NO_BODY],
  ['lc delete default', 'DELETE', `${C}/calendars/1`, NO_BODY],
  ['lc delete gone', 'DELETE', `${C}/calendars/999`, NO_BODY],
  ['lc delete zero', 'DELETE', `${C}/calendars/0`, NO_BODY],
  ['lc delete minus', 'DELETE', `${C}/calendars/-1`, NO_BODY],
  ['lc delete minus zero', 'DELETE', `${C}/calendars/-0`, NO_BODY],
  ['lc delete letters', 'DELETE', `${C}/calendars/abc`, NO_BODY],
  ['lc delete hex', 'DELETE', `${C}/calendars/0x5`, NO_BODY],
  ['lc delete reader', 'DELETE', `${C}/calendars/5`, NO_BODY, { actor: 'reader' }],
  ['lc delete reader letters', 'DELETE', `${C}/calendars/abc`, NO_BODY, { actor: 'reader' }],
  ['lc delete leading zero', 'DELETE', `${C}/calendars/05`, NO_BODY],

  // ══ EVENTS: CREATE (crud.js POST /) ════════════════════════════════════════
  ['ev create', 'POST', C, EV()],
  ['ev create private mem', 'POST', C, EV({ title: 'Geheim', visibility: 'private', assigned_to: [MEM] }), { actor: 'mem' }],
  ['ev create assignees only', 'POST', C, EV({ title: 'Nur wir', visibility: 'assignees', assigned_to: [MEM, OTHER] }), { actor: 'mem' }],
  ['ev create all day', 'POST', C, EV({ title: 'Urlaub', start_datetime: '2026-11-21', end_datetime: '2026-11-22', all_day: true, countdown: true, icon: 'plane' })],
  ['ev create series', 'POST', C, SERIES()],
  ['ev create series two', 'POST', C, SERIES({ title: 'Lauf', assigned_to: [MEM] })],
  ['ev create series three', 'POST', C, SERIES({ title: 'Yoga' })],
  ['ev create in calendar', 'POST', C, EV({ title: 'Meeting', local_calendar_id: 2, color: '#123456', location: 'Raum 1', description: 'Text' })],
  ['ev create offset', 'POST', C, EV({ title: 'Flug', start_datetime: '2026-11-22T08:00:00Z', end_datetime: '2026-11-22T10:00:00+01:00' })],
  ['ev create child', 'POST', C, EV({ title: 'Kind', assigned_to: [CHILD] }), { actor: 'child' }],
  ['ev create attachment', 'POST', C, EV({ title: 'Mit Anhang', attachment_data: PNG, attachment_name: 'bild.png' })],
  ['ev create series attachment', 'POST', C, SERIES({ title: 'Kurs', attachment_data: PNG, attachment_name: 'kurs.png' })],
  ['ev create series four', 'POST', C, SERIES({ title: 'Pilates' })],
  ['ev create series five', 'POST', C, SERIES({ title: 'Schwimmen' })],
  ['ev create title missing', 'POST', C, { start_datetime: '2026-11-20T09:00' }],
  ['ev create title number', 'POST', C, EV({ title: 5 })],
  ['ev create title null', 'POST', C, EV({ title: null })],
  ['ev create title empty', 'POST', C, EV({ title: '' })],
  ['ev create title spaces', 'POST', C, EV({ title: '   ' })],
  ['ev create title long', 'POST', C, EV({ title: LONG(201) })],
  ['ev create description number', 'POST', C, EV({ description: 5 })],
  ['ev create description long', 'POST', C, EV({ description: LONG(5001) })],
  ['ev create location number', 'POST', C, EV({ location: 5 })],
  ['ev create location long', 'POST', C, EV({ location: LONG(201) })],
  ['ev create start missing', 'POST', C, { title: 'Ohne Start' }],
  ['ev create start empty', 'POST', C, EV({ start_datetime: '' })],
  ['ev create start null', 'POST', C, EV({ start_datetime: null })],
  ['ev create start feb 30', 'POST', C, EV({ start_datetime: '2026-02-30', all_day: true, end_datetime: null })],
  ['ev create start feb 30 time', 'POST', C, EV({ start_datetime: '2026-02-30T09:00', end_datetime: null })],
  ['ev create start hour 25', 'POST', C, EV({ start_datetime: '2026-11-20T25:00', end_datetime: null })],
  ['ev create start text', 'POST', C, EV({ start_datetime: 'morgen' })],
  // Stored as sent (decision 8): out of the table again, their expansion reads the process zone.
  ['ev delete feb 30', 'DELETE', () => `${C}/${idOf('ev create start feb 30 time')}`, NO_BODY],
  ['ev delete hour 25', 'DELETE', () => `${C}/${idOf('ev create start hour 25')}`, NO_BODY],
  ['ev create end empty', 'POST', C, EV({ end_datetime: '' })],
  ['ev create end before start', 'POST', C, EV({ end_datetime: '2026-11-20T08:00' })],
  ['ev create color empty', 'POST', C, EV({ color: '' })],
  ['ev create color word', 'POST', C, EV({ color: 'red' })],
  ['ev create icon unknown', 'POST', C, EV({ icon: 'nope' })],
  ['ev create icon number', 'POST', C, EV({ icon: 5 })],
  ['ev create icon null', 'POST', C, EV({ icon: null })],
  ['ev create icon blank', 'POST', C, EV({ title: 'Leeres Icon', icon: '  ' })],
  ['ev create all day text', 'POST', C, EV({ all_day: 'yes' })],
  ['ev create all day number', 'POST', C, EV({ all_day: 1 })],
  ['ev create countdown number', 'POST', C, EV({ countdown: 1 })],
  ['ev create visibility bad', 'POST', C, EV({ visibility: 'bad' })],
  ['ev create visibility null', 'POST', C, EV({ visibility: null })],
  ['ev create assigned text', 'POST', C, EV({ assigned_to: '2' })],
  ['ev create assigned fraction', 'POST', C, EV({ assigned_to: [1.5] })],
  ['ev create assigned zero', 'POST', C, EV({ assigned_to: [0] })],
  ['ev create assigned twice', 'POST', C, EV({ assigned_to: [MEM, MEM] })],
  ['ev create assigned single', 'POST', C, EV({ title: 'Einzeln', assigned_to: MEM })],
  ['ev create assigned null', 'POST', C, EV({ title: 'Niemand', assigned_to: null })],
  ['ev create assigned guest', 'POST', C, EV({ assigned_to: [GUEST] })],
  ['ev create assigned unknown', 'POST', C, EV({ assigned_to: [999] })],
  ['ev create rule invalid', 'POST', C, EV({ recurrence_rule: 'FREQ=BOGUS' })],
  ['ev create rule long', 'POST', C, EV({ recurrence_rule: `FREQ=DAILY;${LONG(300)}` })],
  ['ev create rule number', 'POST', C, EV({ recurrence_rule: 5 })],
  ['ev create rule no occurrence', 'POST', C, EV({ start_datetime: '2026-01-15', end_datetime: null, all_day: true, recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120' })],
  ['ev create rule ends before', 'POST', C, EV({ recurrence_rule: 'FREQ=DAILY;UNTIL=20261101' })],
  ['ev create calendar gone', 'POST', C, EV({ local_calendar_id: 999 })],
  ['ev create calendar text', 'POST', C, EV({ local_calendar_id: '2' })],
  ['ev create calendar zero', 'POST', C, EV({ local_calendar_id: 0 })],
  ['ev create calendar null', 'POST', C, EV({ title: 'Standard', local_calendar_id: null })],
  ['ev create calendar and google', 'POST', C, EV({ local_calendar_id: 2, target_google_calendar_id: 'fam@group.calendar.google.com' })],
  ['ev create google long', 'POST', C, EV({ target_google_calendar_id: LONG(2049) })],
  ['ev create google number', 'POST', C, EV({ target_google_calendar_id: 5 })],
  ['ev create caldav no url', 'POST', C, EV({ target_caldav_account_id: 1 })],
  ['ev create caldav not offered', 'POST', C, EV({ target_caldav_account_id: 1, target_caldav_calendar_url: 'https://dav.example/cal/' })],
  ['ev create caldav text', 'POST', C, EV({ target_caldav_account_id: '1', target_caldav_calendar_url: 'https://dav.example/cal/' })],
  ['ev create caldav empty', 'POST', C, EV({ target_caldav_account_id: '' })],
  ['ev create outlook no calendar', 'POST', C, EV({ target_outlook_account_id: 1 })],
  ['ev create outlook zero', 'POST', C, EV({ target_outlook_account_id: 0 })],
  ['ev create attachment number', 'POST', C, EV({ attachment_data: 5 })],
  ['ev create attachment broken', 'POST', C, EV({ title: 'Kaputt', attachment_data: 'data:image/png;base64,???' })],
  ['ev create attachment zip', 'POST', C, EV({ title: 'Zip', attachment_data: 'data:application/zip;base64,UEsDBA==' })],
  ['ev create attachment docread', 'POST', C, EV({ attachment_data: PNG }), { actor: 'docread' }],
  ['ev create attachment docread bad', 'POST', C, EV({ title: 5, attachment_data: PNG }), { actor: 'docread' }],
  ['ev create attachment docread empty', 'POST', C, EV({ title: 'Ohne Anhang', attachment_data: '' }), { actor: 'docread' }],
  ['ev create no body', 'POST', C, NO_BODY],
  ['ev create array body', 'POST', C, [EV()]],

  // ══ EVENTS: READ ONE (crud.js GET /{id}) ═══════════════════════════════════
  ['ev get', 'GET', `${C}/1`, NO_BODY],
  ['ev get private own', 'GET', `${C}/2`, NO_BODY, { actor: 'mem' }],
  ['ev get private foreign', 'GET', `${C}/2`, NO_BODY],
  ['ev get private display', 'GET', `${C}/2`, NO_BODY, { actor: 'display' }],
  ['ev get assignees other', 'GET', `${C}/3`, NO_BODY, { actor: 'other' }],
  ['ev get assignees child', 'GET', `${C}/3`, NO_BODY, { actor: 'child' }],
  ['ev get display', 'GET', `${C}/1`, NO_BODY, { actor: 'display' }],
  ['ev get attachment', 'GET', () => `${C}/${idOf('ev create attachment')}`, NO_BODY],
  ['ev get attachment docread', 'GET', () => `${C}/${idOf('ev create attachment')}`, NO_BODY, { actor: 'docread' }],
  ['ev get gone', 'GET', `${C}/999`, NO_BODY],
  ['ev get zero', 'GET', `${C}/0`, NO_BODY],
  ['ev get minus', 'GET', `${C}/-1`, NO_BODY],
  ['ev get minus zero', 'GET', `${C}/-0`, NO_BODY],
  ['ev get leading zero', 'GET', `${C}/01`, NO_BODY],
  ['ev get letters', 'GET', `${C}/1abc`, NO_BODY],
  ['ev get fraction', 'GET', `${C}/1.0`, NO_BODY],
  ['ev get exponent', 'GET', `${C}/1e0`, NO_BODY],

  // ══ EVENTS: UPDATE (crud.js PUT /{id}) ═════════════════════════════════════
  ['ev update title', 'PUT', `${C}/1`, { title: ' Zahnarzt neu ' }],
  ['ev update full', 'PUT', `${C}/1`, EV({ title: 'Zahnarzt voll', description: 'Kontrolle', location: 'Praxis', color: '#654321', icon: 'tooth', visibility: 'assignees', countdown: true })],
  ['ev update clear', 'PUT', `${C}/1`, { description: null, location: null, color: null, end_datetime: null }],
  ['ev update start offset', 'PUT', `${C}/1`, { start_datetime: '2026-11-20T08:30:00Z' }],
  ['ev update all day', 'PUT', `${C}/1`, { all_day: true, start_datetime: '2026-11-20' }],
  ['ev update back timed', 'PUT', `${C}/1`, { all_day: false, start_datetime: '2026-11-20T09:00', end_datetime: '2026-11-20T10:00' }],
  ['ev update assignees', 'PUT', `${C}/1`, { assigned_to: [MEM, ADMIN] }],
  ['ev update move calendar', 'PUT', `${C}/1`, { local_calendar_id: 2 }],
  ['ev update title empty', 'PUT', `${C}/1`, { title: '' }],
  ['ev update title spaces', 'PUT', `${C}/1`, { title: '   ' }],
  ['ev update title number', 'PUT', `${C}/1`, { title: 5 }],
  ['ev update title null', 'PUT', `${C}/1`, { title: null }],
  ['ev update title long', 'PUT', `${C}/1`, { title: LONG(201) }],
  ['ev update description number', 'PUT', `${C}/1`, { description: 5 }],
  ['ev update location number', 'PUT', `${C}/1`, { location: 5 }],
  ['ev update start null', 'PUT', `${C}/1`, { start_datetime: null }],
  ['ev update start empty', 'PUT', `${C}/1`, { start_datetime: '' }],
  ['ev update start feb 30', 'PUT', `${C}/1`, { start_datetime: '2026-02-30T09:00' }],
  ['ev update start back', 'PUT', `${C}/1`, { start_datetime: '2026-11-20T09:00' }],
  ['ev update end empty', 'PUT', `${C}/1`, { end_datetime: '' }],
  ['ev update color empty', 'PUT', `${C}/1`, { color: '' }],
  ['ev update color word', 'PUT', `${C}/1`, { color: 'red' }],
  ['ev update all day text', 'PUT', `${C}/1`, { all_day: 'x' }],
  ['ev update countdown number', 'PUT', `${C}/1`, { countdown: 0 }],
  ['ev update visibility bad', 'PUT', `${C}/1`, { visibility: 'bad' }],
  ['ev update icon unknown', 'PUT', `${C}/1`, { icon: 'nope' }],
  ['ev update icon number', 'PUT', `${C}/1`, { icon: 5 }],
  ['ev update orphan count series-less', 'PUT', `${C}/1`, { confirmed_orphan_count: 3 }],
  ['ev update orphan count minus', 'PUT', `${C}/1`, { confirmed_orphan_count: -1 }],
  ['ev update orphan count fraction', 'PUT', `${C}/5`, { confirmed_orphan_count: 1.5 }],
  ['ev update orphan count text', 'PUT', `${C}/5`, { confirmed_orphan_count: '1' }],
  ['ev update orphan count null', 'PUT', `${C}/5`, { confirmed_orphan_count: null }],
  ['ev update remove attachment text', 'PUT', `${C}/1`, { remove_attachment: 'yes' }],
  ['ev update remove attachment number', 'PUT', `${C}/1`, { remove_attachment: 1 }],
  ['ev update attachment contradiction', 'PUT', () => `${C}/${idOf('ev create attachment')}`, { attachment_data: PNG, remove_attachment: true }],
  ['ev update attachment replace', 'PUT', () => `${C}/${idOf('ev create attachment')}`, { attachment_data: PNG, attachment_name: 'neu.png' }],
  ['ev update attachment remove', 'PUT', () => `${C}/${idOf('ev create attachment')}`, { remove_attachment: true }],
  ['ev update attachment docread', 'PUT', `${C}/1`, { attachment_data: PNG }, { actor: 'docread' }],
  ['ev update attachment docread gone', 'PUT', `${C}/999`, { title: 5, attachment_data: PNG }, { actor: 'docread' }],
  ['ev update attachment docread remove', 'PUT', `${C}/1`, { remove_attachment: true }, { actor: 'docread' }],
  ['ev update calendar gone', 'PUT', `${C}/1`, { local_calendar_id: 999 }],
  ['ev update calendar null', 'PUT', `${C}/1`, { local_calendar_id: null }],
  ['ev update calendar text', 'PUT', `${C}/1`, { local_calendar_id: '2' }],
  ['ev update calendar and google', 'PUT', `${C}/1`, { local_calendar_id: 2, target_google_calendar_id: 'fam@group.calendar.google.com' }],
  ['ev update caldav no url', 'PUT', `${C}/1`, { target_caldav_account_id: 1 }],
  ['ev update assigned guest', 'PUT', `${C}/1`, { assigned_to: [GUEST] }],
  ['ev update assigned unknown', 'PUT', `${C}/1`, { assigned_to: [999] }],
  ['ev update assigned text', 'PUT', `${C}/1`, { assigned_to: ['2'] }],
  ['ev update rule invalid', 'PUT', `${C}/1`, { recurrence_rule: 'FREQ=BOGUS' }],
  ['ev update rule long', 'PUT', `${C}/1`, { recurrence_rule: `FREQ=DAILY;${LONG(300)}` }],
  ['ev update rule ends before', 'PUT', `${C}/1`, { recurrence_rule: 'FREQ=DAILY;UNTIL=20261101' }],
  ['ev update rule no occurrence', 'PUT', `${C}/1`, { start_datetime: '2026-01-15', all_day: true, end_datetime: null, recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120' }],
  () => {
    // A synced series stores a rule the form never writes (#756): longer than
    // 300 characters and outside the vocabulary of rrule().
    database().prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = 7').run(`RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=TH;X-NAME=${LONG(300)}`);
  },
  ['ev update stored rule kept', 'PUT', `${C}/7`, () => ({ title: 'Yoga neu', recurrence_rule: `RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=TH;X-NAME=${LONG(300)}` })],
  ['ev update stored rule changed', 'PUT', `${C}/7`, { recurrence_rule: 'RRULE:FREQ=WEEKLY;WKST=MO' }],
  ['ev update child foreign', 'PUT', `${C}/4`, { title: 'Kind' }, { actor: 'child' }],
  ['ev update child foreign bad', 'PUT', `${C}/4`, { title: 5 }, { actor: 'child' }],
  ['ev update child own', 'PUT', () => `${C}/${idOf('ev create child')}`, { title: 'Kind neu' }, { actor: 'child' }],
  ['ev update other private', 'PUT', `${C}/2`, { title: 'Fremd' }, { actor: 'other' }],
  ['ev update gone', 'PUT', `${C}/999`, { title: 'Weg' }],
  ['ev update gone bad', 'PUT', `${C}/999`, { title: 5 }],
  ['ev update no body', 'PUT', `${C}/1`, NO_BODY],
  ['ev update zero', 'PUT', `${C}/0`, { title: 'Null' }],
  ['ev update minus', 'PUT', `${C}/-1`, { title: 'Minus' }],
  ['ev update minus zero', 'PUT', `${C}/-0`, { title: 'Minus Null' }],
  ['ev update leading zero', 'PUT', `${C}/01`, { title: 'Führende Null' }],
  ['ev update letters', 'PUT', `${C}/1abc`, { title: 'Text' }],

  // ══ OCCURRENCES (crud.js PUT/DELETE /{seriesId}/occurrences/{recurrenceId}) ═
  ['occ update', 'PUT', `${C}/5/occurrences/${KEY(20)}`, { title: 'Training spät', start_datetime: '2026-11-20T18:00', end_datetime: '2026-11-20T19:00', reminder_offsets: [10, 60] }],
  ['occ update assignees', 'PUT', `${C}/5/occurrences/${KEY(21)}`, { assigned_to: [MEM], visibility: 'assignees', color: '#abcdef', countdown: true, all_day: false }],
  ['occ update clear', 'PUT', `${C}/5/occurrences/${KEY(21)}`, { description: null, location: null, color: null, assigned_to: null }],
  ['occ update calendar', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { local_calendar_id: 2 }],
  ['occ update calendar bad', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { local_calendar_id: 'x', title: 5 }],
  ['occ update title number', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { title: 5 }],
  ['occ update title null', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { title: null }],
  ['occ update title spaces', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { title: '   ' }],
  ['occ update title long', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { title: LONG(201) }],
  ['occ update description number', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { description: 5 }],
  ['occ update location number', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { location: false }],
  ['occ update start empty', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { start_datetime: '' }],
  ['occ update start number', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { start_datetime: 5 }],
  ['occ update start null', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { start_datetime: null }],
  ['occ update start feb 30', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { start_datetime: '2026-02-30T08:00' }],
  ['occ update start hour 25', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { start_datetime: '2026-11-22T25:00' }],
  ['occ update end before start', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { start_datetime: '2026-11-22T10:00', end_datetime: '2026-11-22T09:00' }],
  ['occ update end empty', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { end_datetime: '' }],
  ['occ update color number', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { color: 5 }],
  ['occ update color word', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { color: 'red' }],
  ['occ update all day text', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { all_day: 'x' }],
  ['occ update countdown number', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { countdown: 1 }],
  ['occ update visibility bad', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { visibility: 'everyone' }],
  ['occ update icon unknown', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { icon: 'nope' }],
  ['occ update icon number', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { icon: 5 }],
  ['occ update assigned unknown', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { assigned_to: [999] }],
  ['occ update assigned guest', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { assigned_to: [GUEST] }],
  ['occ update assigned text', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { assigned_to: ['2'] }],
  ['occ update assigned twice', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { assigned_to: [MEM, MEM] }],
  ['occ update assigned zero', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { assigned_to: 0 }],
  ['occ update reminders twice', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { reminder_offsets: [5, 5] }],
  ['occ update reminders six', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { reminder_offsets: [1, 2, 3, 4, 5, 6] }],
  ['occ update reminders minus', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { reminder_offsets: [-1] }],
  ['occ update reminders text', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { reminder_offsets: 'x' }],
  ['occ update reminders fraction', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { reminder_offsets: [1.5] }],
  ['occ update remove attachment text', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { remove_attachment: 'yes' }],
  ['occ update attachment contradiction', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { attachment_data: PNG, remove_attachment: true }],
  ['occ update attachment', 'PUT', `${C}/5/occurrences/${KEY(23)}`, { attachment_data: PNG, attachment_name: 'vorkommen.png' }],
  ['occ update attachment docread', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { attachment_data: PNG }, { actor: 'docread' }],
  ['occ update attachment docread calendar', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { local_calendar_id: 2, attachment_data: PNG }, { actor: 'docread' }],
  ['occ update key malformed', 'PUT', `${C}/5/occurrences/xyz`, { title: 'X' }],
  ['occ update key day', 'PUT', `${C}/5/occurrences/2026-11-23`, { title: 'Alte Form' }],
  ['occ update key elsewhere', 'PUT', `${C}/5/occurrences/${KEY(29)}`, { title: 'Daneben' }],
  ['occ update not a series', 'PUT', `${C}/1/occurrences/${KEY(20)}`, { title: 'Einzeln' }],
  ['occ update series gone', 'PUT', `${C}/999/occurrences/${KEY(20)}`, { title: 'Weg' }],
  ['occ update series gone bad', 'PUT', `${C}/999/occurrences/${KEY(20)}`, { title: 5 }],
  ['occ update series zero', 'PUT', `${C}/0/occurrences/${KEY(20)}`, { title: 'Null' }],
  ['occ update series minus', 'PUT', `${C}/-1/occurrences/${KEY(20)}`, { title: 'Minus' }],
  ['occ update series minus zero', 'PUT', `${C}/-0/occurrences/${KEY(20)}`, { title: 'Minus Null' }],
  ['occ update series leading zero', 'PUT', `${C}/05/occurrences/${KEY(20)}`, { title: 'Training Null' }],
  ['occ update series letters', 'PUT', `${C}/5x/occurrences/${KEY(20)}`, { title: 'Text' }],
  ['occ update child', 'PUT', `${C}/5/occurrences/${KEY(22)}`, { title: 'Kind' }, { actor: 'child' }],
  ['occ update other assigned', 'PUT', `${C}/6/occurrences/${KEY(22)}`, { title: 'Lauf Ole' }, { actor: 'other' }],
  ['occ update no body', 'PUT', `${C}/5/occurrences/${KEY(22)}`, NO_BODY],
  ['occ update empty', 'PUT', `${C}/5/occurrences/${KEY(20)}`, {}],
  ['occ delete', 'DELETE', `${C}/5/occurrences/${KEY(23)}`, NO_BODY],
  ['occ delete again', 'DELETE', `${C}/5/occurrences/${KEY(23)}`, NO_BODY],
  ['occ delete key malformed', 'DELETE', `${C}/5/occurrences/abc`, NO_BODY],
  ['occ delete key elsewhere', 'DELETE', `${C}/5/occurrences/${KEY(29)}`, NO_BODY],
  ['occ delete not a series', 'DELETE', `${C}/1/occurrences/${KEY(20)}`, NO_BODY],
  ['occ delete series gone', 'DELETE', `${C}/999/occurrences/${KEY(20)}`, NO_BODY],
  ['occ delete series zero', 'DELETE', `${C}/0/occurrences/${KEY(20)}`, NO_BODY],
  ['occ delete series minus', 'DELETE', `${C}/-1/occurrences/${KEY(20)}`, NO_BODY],
  ['occ delete series letters', 'DELETE', `${C}/abc/occurrences/${KEY(20)}`, NO_BODY],
  ['occ delete child', 'DELETE', `${C}/5/occurrences/${KEY(22)}`, NO_BODY, { actor: 'child' }],
  ['occ delete private foreign', 'DELETE', `${C}/2/occurrences/${KEY(20)}`, NO_BODY],
  ['ev delete linked occurrence', 'DELETE', () => `${C}/${database().prepare('SELECT id FROM calendar_events WHERE recurrence_parent_id = 5 ORDER BY id LIMIT 1').get().id}`, NO_BODY],
  ['ev update linked occurrence', 'PUT', () => `${C}/${database().prepare('SELECT id FROM calendar_events WHERE recurrence_parent_id = 5 ORDER BY id LIMIT 1').get().id}`, { title: 'Direkt' }],

  // ══ EVENTS: ORPHANS OF A SERIES (crud.js PUT /{id}) ════════════════════════
  ['ev update series orphans', 'PUT', `${C}/5`, { recurrence_rule: 'FREQ=DAILY;COUNT=2' }],
  ['ev update series orphans confirmed', 'PUT', `${C}/5`, { recurrence_rule: 'FREQ=DAILY;COUNT=2', confirmed_orphan_count: 1 }],

  // ══ FOLLOWING (crud.js PUT/DELETE .../following) ═══════════════════════════
  ['fol update', 'PUT', `${C}/6/occurrences/${KEY(21)}/following`, { title: 'Lauf neu', reminder_offsets: [15], recurrence_rule: 'FREQ=DAILY;COUNT=2' }],
  ['fol update whole', 'PUT', () => `${C}/${idOf('ev create series four')}/occurrences/${KEY(19)}/following`, { title: 'Kurs neu' }],
  ['fol update attachment series', 'PUT', () => `${C}/${idOf('ev create series attachment')}/occurrences/${KEY(21)}/following`, { location: 'Halle' }],
  ['fol update rule invalid', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { recurrence_rule: 'FREQ=BOGUS' }],
  ['fol update rule number', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { recurrence_rule: 5 }],
  ['fol update rule long', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { recurrence_rule: `FREQ=DAILY;${LONG(300)}` }],
  ['fol update rule no occurrence', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { recurrence_rule: 'FREQ=DAILY;UNTIL=20261101' }],
  ['fol update orphan minus', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { confirmed_orphan_count: -1 }],
  ['fol update orphan text', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { confirmed_orphan_count: '0' }],
  ['fol update calendar gone', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { local_calendar_id: 999 }],
  ['fol update calendar and google', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { local_calendar_id: 2, target_google_calendar_id: 'fam@group.calendar.google.com' }],
  ['fol update caldav no url', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { target_caldav_account_id: 1 }],
  ['fol update google number', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { target_google_calendar_id: 5 }],
  ['fol update title number', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { title: 5 }],
  ['fol update title spaces', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { title: '  ' }],
  ['fol update all day text', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { all_day: 'no' }],
  ['fol update visibility bad', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { visibility: 'x' }],
  ['fol update start feb 30', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { start_datetime: '2026-02-30T08:00' }],
  ['fol update reminders twice', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { reminder_offsets: [5, 5] }],
  ['fol update remove attachment text', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { remove_attachment: 'no' }],
  ['fol update icon unknown', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { icon: 'nope' }],
  ['fol update attachment contradiction', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { attachment_data: PNG, remove_attachment: true }],
  ['fol update assigned unknown', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { assigned_to: [999] }],
  ['fol update assigned guest', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { assigned_to: [GUEST] }],
  ['fol update key malformed', 'PUT', `${C}/6/occurrences/zzz/following`, { title: 'X' }],
  ['fol update key elsewhere', 'PUT', `${C}/6/occurrences/${KEY(29)}/following`, { title: 'X' }],
  ['fol update series gone', 'PUT', `${C}/999/occurrences/${KEY(20)}/following`, { title: 'X' }],
  ['fol update series minus zero', 'PUT', `${C}/-0/occurrences/${KEY(20)}/following`, { title: 'X' }],
  ['fol update series letters', 'PUT', `${C}/x/occurrences/${KEY(20)}/following`, { title: 'X' }],
  ['fol update child', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { title: 'Kind' }, { actor: 'child' }],
  ['fol update docread', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, { attachment_data: PNG }, { actor: 'docread' }],
  ['fol update no body', 'PUT', `${C}/6/occurrences/${KEY(20)}/following`, NO_BODY],
  ['fol delete', 'DELETE', () => `${C}/${idOf('ev create series four')}/occurrences/${KEY(21)}/following`, NO_BODY],
  ['fol delete key elsewhere', 'DELETE', () => `${C}/${idOf('ev create series four')}/occurrences/${KEY(29)}/following`, NO_BODY],
  ['fol delete key malformed', 'DELETE', () => `${C}/${idOf('ev create series four')}/occurrences/x/following`, NO_BODY],
  ['fol delete series gone', 'DELETE', `${C}/999/occurrences/${KEY(20)}/following`, NO_BODY],
  ['fol delete series zero', 'DELETE', `${C}/0/occurrences/${KEY(20)}/following`, NO_BODY],
  ['fol delete series letters', 'DELETE', `${C}/1.5/occurrences/${KEY(20)}/following`, NO_BODY],
  ['fol delete child', 'DELETE', () => `${C}/${idOf('ev create series four')}/occurrences/${KEY(20)}/following`, NO_BODY, { actor: 'child' }],

  // ══ EXCEPTIONS (crud.js POST /{id}/exceptions) ═════════════════════════════
  ['exc create', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { recurrence_id: KEY(20) }],
  ['exc create again', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { recurrence_id: KEY(20) }],
  ['exc create date', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { date: '2026-11-19' }],
  ['exc create malformed', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { recurrence_id: 'morgen' }],
  ['exc create date malformed', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { date: '19.11.2026' }],
  ['exc create empty', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, {}],
  ['exc create no body', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, NO_BODY],
  ['exc create number', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { recurrence_id: 5 }],
  ['exc create null', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { recurrence_id: null, date: '2026-11-19' }],
  ['exc create elsewhere', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { recurrence_id: KEY(29) }],
  ['exc create not a series', 'POST', `${C}/1/exceptions`, { recurrence_id: KEY(20) }],
  ['exc create gone', 'POST', `${C}/999/exceptions`, { recurrence_id: KEY(20) }],
  ['exc create gone malformed', 'POST', `${C}/999/exceptions`, { recurrence_id: 'x' }],
  ['exc create zero', 'POST', `${C}/0/exceptions`, { recurrence_id: KEY(20) }],
  ['exc create minus', 'POST', `${C}/-1/exceptions`, { recurrence_id: KEY(20) }],
  ['exc create minus zero', 'POST', `${C}/-0/exceptions`, { recurrence_id: KEY(20) }],
  ['exc create leading zero', 'POST', () => `${C}/0${idOf('ev create series five')}/exceptions`, { recurrence_id: KEY(22) }],
  ['exc create letters', 'POST', () => `${C}/${idOf('ev create series five')}a/exceptions`, { recurrence_id: KEY(20) }],
  ['exc create child', 'POST', () => `${C}/${idOf('ev create series five')}/exceptions`, { recurrence_id: KEY(22) }, { actor: 'child' }],
  ['exc create private foreign', 'POST', `${C}/2/exceptions`, { recurrence_id: KEY(22) }],

  // ══ FEED (feed.js) ═════════════════════════════════════════════════════════
  ['feed get none', 'GET', `${C}/feed`, NO_BODY],
  ['feed regenerate', 'POST', `${C}/feed/regenerate`, NO_BODY],
  ['feed get', 'GET', `${C}/feed`, NO_BODY],
  ['feed options assignees', 'PUT', `${C}/feed`, { showAssignees: true }],
  ['feed options birthdays', 'PUT', `${C}/feed`, { includeBirthdays: false }],
  ['feed options both', 'PUT', `${C}/feed`, { showAssignees: false, includeBirthdays: true }],
  ['feed options empty', 'PUT', `${C}/feed`, {}],
  ['feed options no body', 'PUT', `${C}/feed`, NO_BODY],
  ['feed options text', 'PUT', `${C}/feed`, { showAssignees: 'true' }],
  ['feed options number', 'PUT', `${C}/feed`, { includeBirthdays: 0 }],
  ['feed options null', 'PUT', `${C}/feed`, { showAssignees: null }],
  ['feed options other only', 'PUT', `${C}/feed`, { other: true }],
  ['feed options mem', 'PUT', `${C}/feed`, { showAssignees: true }, { actor: 'mem' }],
  ['feed get after', 'GET', `${C}/feed`, NO_BODY],
  ['feed get mem', 'GET', `${C}/feed`, NO_BODY, { actor: 'mem' }],
  ['feed delete', 'DELETE', `${C}/feed`, NO_BODY],
  ['feed get deleted', 'GET', `${C}/feed`, NO_BODY],
  ['holidays', 'GET', `${C}/holidays?from=2026-12-01&to=2026-12-31`, NO_BODY],
  ['holidays none', 'GET', `${C}/holidays?from=2026-11-01&to=2026-11-30`, NO_BODY],
  ['holidays reversed', 'GET', `${C}/holidays?from=2026-12-31&to=2026-12-01`, NO_BODY],
  ['holidays no from', 'GET', `${C}/holidays?to=2026-12-31`, NO_BODY],
  ['holidays no query', 'GET', `${C}/holidays`, NO_BODY],
  ['holidays month 13', 'GET', `${C}/holidays?from=2026-13-01&to=2026-12-31`, NO_BODY],
  ['holidays short', 'GET', `${C}/holidays?from=2026-1-1&to=2026-12-31`, NO_BODY],
  ['holidays twice', 'GET', `${C}/holidays?from=2026-12-01&from=2026-12-02&to=2026-12-31`, NO_BODY],
  ['holidays display', 'GET', `${C}/holidays?from=2026-12-01&to=2026-12-31`, NO_BODY, { actor: 'display' }],

  // ══ SYNC TARGETS (sync-targets.js) ═════════════════════════════════════════
  ['sync targets', 'GET', `${C}/sync-targets`, NO_BODY],
  ['sync targets mem', 'GET', `${C}/sync-targets`, NO_BODY, { actor: 'mem' }],
  ['sync targets reader', 'GET', `${C}/sync-targets`, NO_BODY, { actor: 'reader' }],
  ['sync targets display', 'GET', `${C}/sync-targets`, NO_BODY, { actor: 'display' }],

  // ══ SUBSCRIPTIONS AND IMPORT (subscriptions.js) ════════════════════════════
  ['sub list empty', 'GET', `${C}/subscriptions`, NO_BODY],
  ['sub create', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ default_assignee_user_ids: [MEM] })],
  ['sub create mem', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ name: ' Verein ', shared: false, default_assignee_user_id: MEM }), { actor: 'mem' }],
  ['sub create missing feed', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ name: 'Fehlt', url: MISSING_URL })],
  ['sub create webcal', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ name: 'Webcal', url: `webcal://127.0.0.1:${FEED_PORT}/feed.ics`, shared: false })],
  ['sub create name spaces', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ name: '   ' })],
  ['sub create name long', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ name: LONG(101) })],
  ['sub create name missing', 'POST', `${C}/subscriptions`, { url: FEED_URL, color: '#336699' }],
  ['sub create name number', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ name: 5 })],
  ['sub create url missing', 'POST', `${C}/subscriptions`, { name: 'Ohne', color: '#336699' }],
  ['sub create url empty', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ url: '' })],
  ['sub create url number', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ url: 5 })],
  ['sub create url invalid', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ url: 'kein link' })],
  ['sub create url scheme', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ url: 'ftp://127.0.0.1/feed.ics' })],
  ['sub create color missing', 'POST', `${C}/subscriptions`, { name: 'Farblos', url: FEED_URL }],
  ['sub create color word', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ color: 'red' })],
  ['sub create shared number', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ shared: 1 })],
  ['sub create assignees text', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ default_assignee_user_ids: ['x'] })],
  ['sub create assignees guest', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ default_assignee_user_ids: [GUEST] })],
  ['sub create assignees unknown', 'POST', `${C}/subscriptions`, SUBSCRIPTION({ default_assignee_user_ids: [999] })],
  ['sub create no body', 'POST', `${C}/subscriptions`, NO_BODY],
  ['sub list', 'GET', `${C}/subscriptions`, NO_BODY],
  ['sub list other', 'GET', `${C}/subscriptions`, NO_BODY, { actor: 'other' }],
  ['sub list display', 'GET', `${C}/subscriptions`, NO_BODY, { actor: 'display' }],
  ['sub update', 'PATCH', `${C}/subscriptions/1`, { name: ' Schule neu ', color: '#aabbcc', shared: false, default_assignee_user_ids: [MEM, OTHER] }],
  ['sub update shared', 'PATCH', `${C}/subscriptions/1`, { shared: true }],
  ['sub update name empty', 'PATCH', `${C}/subscriptions/1`, { name: '' }],
  ['sub update name long', 'PATCH', `${C}/subscriptions/1`, { name: LONG(101) }],
  ['sub update name number', 'PATCH', `${C}/subscriptions/1`, { name: 5 }],
  ['sub update color word', 'PATCH', `${C}/subscriptions/1`, { color: 'red' }],
  ['sub update color null', 'PATCH', `${C}/subscriptions/1`, { color: null }],
  ['sub update shared text', 'PATCH', `${C}/subscriptions/1`, { shared: 'x' }],
  ['sub update shared null', 'PATCH', `${C}/subscriptions/1`, { shared: null }],
  ['sub update assignees guest', 'PATCH', `${C}/subscriptions/1`, { default_assignee_user_ids: [GUEST] }],
  ['sub update assignee single null', 'PATCH', `${C}/subscriptions/1`, { default_assignee_user_id: null }],
  ['sub update foreign', 'PATCH', `${C}/subscriptions/1`, { name: 'Fremd' }, { actor: 'other' }],
  ['sub update foreign bad', 'PATCH', `${C}/subscriptions/1`, { shared: 'x' }, { actor: 'other' }],
  ['sub update gone', 'PATCH', `${C}/subscriptions/999`, { name: 'Weg' }],
  ['sub update no body', 'PATCH', `${C}/subscriptions/1`, NO_BODY],
  ['sub update zero', 'PATCH', `${C}/subscriptions/0`, { name: 'Null' }],
  ['sub update minus', 'PATCH', `${C}/subscriptions/-1`, { name: 'Minus' }],
  ['sub update minus zero', 'PATCH', `${C}/subscriptions/-0`, { name: 'Minus Null' }],
  ['sub update leading zero', 'PATCH', `${C}/subscriptions/01`, { name: 'Schule Null' }],
  ['sub update letters', 'PATCH', `${C}/subscriptions/1abc`, { name: 'Text' }],
  ['sub sync', 'POST', `${C}/subscriptions/1/sync`, NO_BODY],
  ['sub sync missing feed', 'POST', `${C}/subscriptions/3/sync`, NO_BODY],
  ['sub sync foreign', 'POST', `${C}/subscriptions/1/sync`, NO_BODY, { actor: 'other' }],
  ['sub sync own mem', 'POST', `${C}/subscriptions/2/sync`, NO_BODY, { actor: 'mem' }],
  ['sub sync gone', 'POST', `${C}/subscriptions/999/sync`, NO_BODY],
  ['sub sync zero', 'POST', `${C}/subscriptions/0/sync`, NO_BODY],
  ['sub sync minus zero', 'POST', `${C}/subscriptions/-0/sync`, NO_BODY],
  ['sub sync letters', 'POST', `${C}/subscriptions/x/sync`, NO_BODY],
  ['ics events', 'GET', `${C}?from=2026-11-24&to=2026-11-26`, NO_BODY],
  ['reset local', 'POST', `${C}/1/reset`, NO_BODY],
  () => {
    database().prepare("UPDATE calendar_events SET title = 'Geändert', user_modified = 1 WHERE external_source = 'ics' AND subscription_id = 1").run();
  },
  ['reset ics', 'POST', () => `${C}/${database().prepare("SELECT id FROM calendar_events WHERE external_source = 'ics' AND subscription_id = 1").get().id}/reset`, NO_BODY],
  ['reset ics mem', 'POST', () => `${C}/${database().prepare("SELECT id FROM calendar_events WHERE external_source = 'ics' AND subscription_id = 1").get().id}/reset`, NO_BODY, { actor: 'mem' }],
  ['reset ics unshared other', 'POST', () => `${C}/${database().prepare("SELECT id FROM calendar_events WHERE external_source = 'ics' AND subscription_id = 2").get().id}/reset`, NO_BODY, { actor: 'other' }],
  ['reset gone', 'POST', `${C}/999/reset`, NO_BODY],
  ['reset private foreign', 'POST', `${C}/2/reset`, NO_BODY],
  ['reset zero', 'POST', `${C}/0/reset`, NO_BODY],
  ['reset minus', 'POST', `${C}/-1/reset`, NO_BODY],
  ['reset minus zero', 'POST', `${C}/-0/reset`, NO_BODY],
  ['reset leading zero', 'POST', `${C}/01/reset`, NO_BODY],
  ['reset letters', 'POST', `${C}/1.0/reset`, NO_BODY],
  ['import ics', 'POST', `${C}/import`, { ics: ICS, color: '#224466', local_calendar_id: 2, assignee_user_ids: [MEM] }],
  ['import ics again', 'POST', `${C}/import`, { ics: ICS, assignee_user_id: OTHER }],
  ['import url', 'POST', `${C}/import`, { url: FEED_URL }],
  ['import url missing feed', 'POST', `${C}/import`, { url: MISSING_URL }],
  ['import url unreachable', 'POST', `${C}/import`, { url: CLOSED_URL }],
  ['import url invalid', 'POST', `${C}/import`, { url: 'kein link' }],
  ['import url scheme', 'POST', `${C}/import`, { url: 'ftp://127.0.0.1/x.ics' }],
  ['import url spaces', 'POST', `${C}/import`, { url: '   ' }],
  ['import ics spaces', 'POST', `${C}/import`, { ics: '   ' }],
  ['import ics garbage', 'POST', `${C}/import`, { ics: 'kein kalender' }],
  ['import both', 'POST', `${C}/import`, { ics: ICS, url: FEED_URL }],
  ['import neither', 'POST', `${C}/import`, {}],
  ['import no body', 'POST', `${C}/import`, NO_BODY],
  ['import ics number', 'POST', `${C}/import`, { ics: 5 }],
  ['import color word', 'POST', `${C}/import`, { ics: ICS, color: 'red' }],
  ['import color empty', 'POST', `${C}/import`, { ics: ICS, color: '' }],
  ['import calendar gone', 'POST', `${C}/import`, { ics: ICS, local_calendar_id: 999 }],
  ['import calendar text', 'POST', `${C}/import`, { ics: ICS, local_calendar_id: '2' }],
  ['import assignees guest', 'POST', `${C}/import`, { ics: ICS, assignee_user_ids: [GUEST] }],
  ['import assignees text', 'POST', `${C}/import`, { ics: ICS, assignee_user_ids: ['x'] }],
  ['import mem', 'POST', `${C}/import`, { ics: ICS.replace('import-1@test', 'import-2@test') }, { actor: 'mem' }],
  ['sub delete foreign', 'DELETE', `${C}/subscriptions/1`, NO_BODY, { actor: 'other' }],
  ['sub delete gone', 'DELETE', `${C}/subscriptions/999`, NO_BODY],
  ['sub delete zero', 'DELETE', `${C}/subscriptions/0`, NO_BODY],
  ['sub delete minus', 'DELETE', `${C}/subscriptions/-1`, NO_BODY],
  ['sub delete minus zero', 'DELETE', `${C}/subscriptions/-0`, NO_BODY],
  ['sub delete letters', 'DELETE', `${C}/subscriptions/1abc`, NO_BODY],
  ['sub delete leading zero', 'DELETE', `${C}/subscriptions/04`, NO_BODY],
  ['sub delete', 'DELETE', `${C}/subscriptions/3`, NO_BODY],
  ['sub delete again', 'DELETE', `${C}/subscriptions/3`, NO_BODY],

  // ══ READS (read.js) ════════════════════════════════════════════════════════
  ['list', 'GET', C, NO_BODY],
  ['list mem', 'GET', `${C}?from=2026-11-22&to=2026-11-22`, NO_BODY, { actor: 'mem' }],
  ['list other', 'GET', `${C}?from=2026-11-22&to=2026-11-22`, NO_BODY, { actor: 'other' }],
  ['list child', 'GET', `${C}?from=2026-11-22&to=2026-11-22`, NO_BODY, { actor: 'child' }],
  ['list display', 'GET', `${C}?from=2026-11-22&to=2026-11-22`, NO_BODY, { actor: 'display' }],
  ['list window', 'GET', `${C}?from=2026-11-21&to=2026-11-22`, NO_BODY],
  ['list assigned', 'GET', `${C}?from=2026-11-19&to=2026-11-23&assigned_to=${MEM}`, NO_BODY],
  ['list source local', 'GET', `${C}?from=2026-11-22&to=2026-11-22&source=local`, NO_BODY],
  ['list source ics', 'GET', `${C}?from=2026-11-19&to=2026-11-30&source=ics`, NO_BODY],
  ['list source unknown', 'GET', `${C}?from=2026-11-22&to=2026-11-22&source=caldav`, NO_BODY],
  ['list from only', 'GET', `${C}?from=2026-11-24`, NO_BODY],
  ['list from feb 30', 'GET', `${C}?from=2026-02-30&to=2026-03-01`, NO_BODY],
  ['list from short', 'GET', `${C}?from=2026-3-1`, NO_BODY],
  ['list from empty', 'GET', `${C}?from=&to=`, NO_BODY],
  ['list from twice', 'GET', `${C}?from=2026-11-01&from=2026-11-02`, NO_BODY],
  ['list assigned text', 'GET', `${C}?assigned_to=abc`, NO_BODY],
  ['list assigned zero', 'GET', `${C}?assigned_to=0`, NO_BODY],
  ['list assigned fraction', 'GET', `${C}?assigned_to=1.5`, NO_BODY],
  ['upcoming', 'GET', `${C}/upcoming`, NO_BODY],
  ['upcoming two', 'GET', `${C}/upcoming?limit=2`, NO_BODY],
  ['upcoming cut', 'GET', `${C}/upcoming?limit=99`, NO_BODY],
  ['upcoming mem', 'GET', `${C}/upcoming?limit=3`, NO_BODY, { actor: 'mem' }],
  ['upcoming display', 'GET', `${C}/upcoming?limit=3`, NO_BODY, { actor: 'display' }],
  ['upcoming zero', 'GET', `${C}/upcoming?limit=0`, NO_BODY],
  ['upcoming minus', 'GET', `${C}/upcoming?limit=-1`, NO_BODY],
  ['upcoming text', 'GET', `${C}/upcoming?limit=abc`, NO_BODY],
  ['upcoming fraction', 'GET', `${C}/upcoming?limit=1.5`, NO_BODY],
  ['upcoming empty', 'GET', `${C}/upcoming?limit=`, NO_BODY],
  ['search', 'GET', `${C}/search?q=Training`, NO_BODY],
  ['search part', 'GET', `${C}/search?q=zahn`, NO_BODY],
  ['search mem private', 'GET', `${C}/search?q=Geheim`, NO_BODY, { actor: 'mem' }],
  ['search other private', 'GET', `${C}/search?q=Geheim`, NO_BODY, { actor: 'other' }],
  ['search display', 'GET', `${C}/search?q=Training`, NO_BODY, { actor: 'display' }],
  ['search short', 'GET', `${C}/search?q=a`, NO_BODY],
  ['search missing', 'GET', `${C}/search`, NO_BODY],
  ['search twice', 'GET', `${C}/search?q=a&q=b`, NO_BODY],
  ['search symbols', 'GET', `${C}/search?q=%22%2A%28%29`, NO_BODY],

  // ══ DELETE (crud.js DELETE /{id}) ══════════════════════════════════════════
  ['ev delete child foreign', 'DELETE', `${C}/4`, NO_BODY, { actor: 'child' }],
  ['ev delete private foreign', 'DELETE', `${C}/2`, NO_BODY],
  ['ev delete gone', 'DELETE', `${C}/999`, NO_BODY],
  ['ev delete zero', 'DELETE', `${C}/0`, NO_BODY],
  ['ev delete minus', 'DELETE', `${C}/-1`, NO_BODY],
  ['ev delete minus zero', 'DELETE', `${C}/-0`, NO_BODY],
  ['ev delete letters', 'DELETE', `${C}/1abc`, NO_BODY],
  ['ev delete fraction', 'DELETE', `${C}/1.0`, NO_BODY],
  ['ev delete leading zero', 'DELETE', `${C}/04`, NO_BODY],
  ['ev delete', 'DELETE', `${C}/1`, NO_BODY],
  ['ev delete again', 'DELETE', `${C}/1`, NO_BODY],
  ['ev delete child own', 'DELETE', () => `${C}/${idOf('ev create child')}`, NO_BODY, { actor: 'child' }],

  // ══ OVERVIEW (dashboard.js) ════════════════════════════════════════════════
  ['dashboard', 'GET', '/dashboard', NO_BODY],
  ['dashboard household', 'GET', '/dashboard?audience=household', NO_BODY],
  ['dashboard tolerant', 'GET', '/dashboard?audience=x&events_limit=abc&events_scope=&events_calendar=local:01&events_calendar=sub:99&task_categories=a,b&include_birthdays=maybe', NO_BODY],
  ['dashboard limit', 'GET', '/dashboard?events_limit=12&events_scope=mine&events_calendar=local:2', NO_BODY, { actor: 'mem' }],
  ['dashboard display', 'GET', '/dashboard', NO_BODY, { actor: 'display' }],

  // The last state of the calendars, after every write above.
  ['lc list end', 'GET', `${C}/calendars`, NO_BODY],
];

/** @param {Record<string, { status: number, body: unknown }>} answers */
async function runTable(answers) {
  for (const step of STEPS) {
    if (typeof step === 'function') { await step(); continue; }
    const [name, method, route, body, opts] = step;
    assert.ok(!Object.hasOwn(answers, name), `duplicate row name ${name}`);
    const actual = await call(method, typeof route === 'function' ? route() : route, typeof body === 'function' ? body() : body, opts);
    answered[name] = actual;
    answers[name] = { status: actual.status, body: normalized(actual.body) };
  }
  return answers;
}

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  logged.error.length = 0;
  /** @type {Record<string, { status: number, body: unknown }>} */
  const answers = {};
  try {
    await runTable(answers);
  } finally {
    if (process.env.G10_DUMP) fs.writeFileSync(process.env.G10_DUMP, JSON.stringify({ answers, logged: logged.error }));
  }
  for (const [name, answer] of Object.entries(answers)) {
    if (Object.hasOwn(CHANGED, name)) {
      assert.deepEqual(answer, CHANGED[name].now, `${name} (changed on purpose)`);
      continue;
    }
    assert.ok(Object.hasOwn(EXPECTED, name), `no expectation for ${name}`);
    assert.deepEqual(answer, EXPECTED[name], name);
  }
  assert.equal(Object.keys(answers).length, Object.keys(EXPECTED).length + Object.keys(CHANGED).length, 'every expectation has its row');
  // The rows that changed on purpose are the 500s the central handler answers now.
  assert.deepEqual(logged.error, Object.values(CHANGED).map((row) => row.log), 'only the changed rows reached the central handler');
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
 * Each request in turn with a handler whose first answer throws.
 * @param {Array<[string, string, unknown, string]>} rows [method, path under /api/v1, body, route pattern]
 */
async function assertAllCentral(rows) {
  for (const [method, route, body, pattern] of rows) {
    assertCentral(await call(method, route, body, { fail: true }), method, pattern);
  }
}

/** A new row through the route, its id. @param {string} route @param {unknown} body */
async function created(route, body) {
  const res = await call('POST', route, body);
  assert.ok(res.status === 201 || res.status === 200, `${route}: ${JSON.stringify(res.body)}`);
  return /** @type {any} */ (res.body).data.id;
}

const C_ = '/api/v1/calendar';

test('an unexpected error in each read route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  await assertAllCentral([
    ['GET', `${C}?from=2026-11-20&to=2026-11-20`, NO_BODY, `${C_}/`],
    ['GET', `${C}/upcoming`, NO_BODY, `${C_}/upcoming`],
    ['GET', `${C}/search?q=Training`, NO_BODY, `${C_}/search`],
  ]);
  assert.equal((await call('GET', `${C}/upcoming`, NO_BODY)).status, 200);
});

test('an unexpected error in each event route is a 500 of the central handler (async POST and PUT: a rejected promise), and the process goes on', async () => {
  logged.error.length = 0;
  const event = await created(C, EV({ title: 'Probe' }));
  const series = await created(C, SERIES({ title: 'Probe Serie' }));
  const other = await created(C, SERIES({ title: 'Probe Serie 2' }));
  await assertAllCentral([
    ['GET', `${C}/${event}`, NO_BODY, `${C_}/:id`],
    ['POST', C, EV({ title: 'Probe 2' }), `${C_}/`],
    ['PUT', `${C}/${event}`, { title: 'Probe 3' }, `${C_}/:id`],
    ['PUT', `${C}/${series}/occurrences/${KEY(20)}`, { title: 'Probe 4' }, `${C_}/:seriesId/occurrences/:recurrenceId`],
    ['PUT', `${C}/${other}/occurrences/${KEY(21)}/following`, { title: 'Probe 5' }, `${C_}/:seriesId/occurrences/:recurrenceId/following`],
    ['DELETE', `${C}/${series}/occurrences/${KEY(22)}`, NO_BODY, `${C_}/:seriesId/occurrences/:recurrenceId`],
    ['DELETE', `${C}/${series}/occurrences/${KEY(23)}/following`, NO_BODY, `${C_}/:seriesId/occurrences/:recurrenceId/following`],
    ['POST', `${C}/${event}/reset`, NO_BODY, `${C_}/:id/reset`],
    ['POST', `${C}/${series}/exceptions`, { recurrence_id: KEY(19) }, `${C_}/:id/exceptions`],
    ['DELETE', `${C}/${event}`, NO_BODY, `${C_}/:id`],
  ]);
  assert.equal((await call('GET', `${C}/${series}`, NO_BODY)).status, 200);
});

test('an unexpected error in each local calendar route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const calendar = await created(`${C}/calendars`, { name: 'Probe' });
  const ids = database().prepare('SELECT id FROM local_calendars ORDER BY sort_order, id').all().map((/** @type {any} */ row) => row.id);
  await assertAllCentral([
    ['GET', `${C}/calendars`, NO_BODY, `${C_}/calendars`],
    ['POST', `${C}/calendars`, { name: 'Probe 2' }, `${C_}/calendars`],
    ['PATCH', `${C}/calendars/reorder`, { order: ids }, `${C_}/calendars/reorder`],
    ['PUT', `${C}/calendars/${calendar}`, { name: 'Probe 3' }, `${C_}/calendars/:id`],
    ['POST', `${C}/calendars/${calendar}/feed/regenerate`, NO_BODY, `${C_}/calendars/:id/feed/regenerate`],
    ['DELETE', `${C}/calendars/${calendar}/feed`, NO_BODY, `${C_}/calendars/:id/feed`],
    ['DELETE', `${C}/calendars/${calendar}`, NO_BODY, `${C_}/calendars/:id`],
  ]);
  assert.equal((await call('GET', `${C}/calendars`, NO_BODY)).status, 200);
});

test('an unexpected error in each feed route and the holidays is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  await assertAllCentral([
    ['GET', `${C}/feed`, NO_BODY, `${C_}/feed`],
    ['PUT', `${C}/feed`, { showAssignees: true }, `${C_}/feed`],
    ['POST', `${C}/feed/regenerate`, NO_BODY, `${C_}/feed/regenerate`],
    ['DELETE', `${C}/feed`, NO_BODY, `${C_}/feed`],
    ['GET', `${C}/holidays?from=2026-12-01&to=2026-12-31`, NO_BODY, `${C_}/holidays`],
  ]);
  assert.equal((await call('GET', `${C}/feed`, NO_BODY)).status, 200);
});

test('an unexpected error in the sync targets (async) and the overview is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  await assertAllCentral([
    ['GET', `${C}/sync-targets`, NO_BODY, `${C_}/sync-targets`],
    ['GET', '/dashboard', NO_BODY, '/api/v1/dashboard/'],
  ]);
  assert.equal((await call('GET', `${C}/sync-targets`, NO_BODY)).status, 200);
  assert.equal((await call('GET', '/dashboard', NO_BODY)).status, 200);
});

test('an unexpected error in each subscription route is a 500 of the central handler (async routes: a rejected promise), and the process goes on', async () => {
  logged.error.length = 0;
  const sub = await created(`${C}/subscriptions`, SUBSCRIPTION({ name: 'Probe' }));
  await assertAllCentral([
    ['GET', `${C}/subscriptions`, NO_BODY, `${C_}/subscriptions`],
    ['POST', `${C}/subscriptions`, SUBSCRIPTION({ name: 'Probe 2' }), `${C_}/subscriptions`],
    ['PATCH', `${C}/subscriptions/${sub}`, { name: 'Probe 3' }, `${C_}/subscriptions/:id`],
    ['POST', `${C}/subscriptions/${sub}/sync`, NO_BODY, `${C_}/subscriptions/:id/sync`],
    ['POST', `${C}/import`, { ics: ICS.replace('import-1@test', 'probe@test') }, `${C_}/import`],
    ['DELETE', `${C}/subscriptions/${sub}`, NO_BODY, `${C_}/subscriptions/:id`],
  ]);
  assert.equal((await call('GET', `${C}/subscriptions`, NO_BODY)).status, 200);
});

// ── Staging: an unexpected error after the upload still removes it ──────────
/** Every file under the document storage, relative. */
function storedFiles() {
  return fs.readdirSync(STORAGE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(STORAGE, path.join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * A database error after the staging: an event row titled `Boom` cannot be
 * written. Runs `fn` with the two triggers in place.
 * @param {() => Promise<void>} fn
 */
async function withBoom(fn) {
  database().exec(`
    CREATE TRIGGER test_boom_insert BEFORE INSERT ON calendar_events WHEN NEW.title = 'Boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;
    CREATE TRIGGER test_boom_update BEFORE UPDATE ON calendar_events WHEN NEW.title = 'Boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;
  `);
  try {
    await fn();
  } finally {
    database().exec('DROP TRIGGER test_boom_insert; DROP TRIGGER test_boom_update;');
  }
}

test('an unexpected error after an attachment was staged removes the staged file (and the staged clone) before it reaches the central handler', async () => {
  logged.error.length = 0;
  const event = await created(C, EV({ title: 'Staging' }));
  const series = await created(C, SERIES({ title: 'Staging Serie' }));
  const withAttachment = await created(C, SERIES({ title: 'Staging Anhang', attachment_data: PNG, attachment_name: 'serie.png' }));
  const before = storedFiles();
  assert.ok(before.length > 0, 'the attachment of the series is stored');
  await withBoom(async () => {
    assertCentral(await call('POST', C, EV({ title: 'Boom', attachment_data: PNG })), 'POST', `${C_}/`);
    assert.deepEqual(storedFiles(), before, 'POST: no staged file is left');
    assertCentral(await call('PUT', `${C}/${event}`, { title: 'Boom', attachment_data: PNG }), 'PUT', `${C_}/:id`);
    assert.deepEqual(storedFiles(), before, 'PUT: no staged file is left');
    assertCentral(await call('PUT', `${C}/${series}/occurrences/${KEY(20)}`, { title: 'Boom', attachment_data: PNG }), 'PUT', `${C_}/:seriesId/occurrences/:recurrenceId`);
    assert.deepEqual(storedFiles(), before, 'PUT occurrence: no staged file is left');
    // The successor of a series with an attachment gets a staged clone; with a new attachment both are staged.
    assertCentral(await call('PUT', `${C}/${withAttachment}/occurrences/${KEY(21)}/following`, { title: 'Boom' }), 'PUT', `${C_}/:seriesId/occurrences/:recurrenceId/following`);
    assert.deepEqual(storedFiles(), before, 'PUT following: no staged clone is left');
    assertCentral(await call('PUT', `${C}/${withAttachment}/occurrences/${KEY(21)}/following`, { title: 'Boom', attachment_data: PNG }), 'PUT', `${C_}/:seriesId/occurrences/:recurrenceId/following`);
    assert.deepEqual(storedFiles(), before, 'PUT following: no staged file and no staged clone is left');
  });
  assert.equal((await call('PUT', `${C}/${event}`, { title: 'Staging weiter' })).status, 200);
});

// ── Handled cases ───────────────────────────────────────────────────────────
test('the handled cases keep their own answer and never reach the central handler', async () => {
  logged.error.length = 0;
  // A storage that cannot be written: the route's 502 with the storage code.
  const event = await created(C, EV({ title: 'Speicher' }));
  const series = await created(C, SERIES({ title: 'Speicher Serie' }));
  const dirs = [STORAGE, ...fs.readdirSync(STORAGE, { recursive: true, withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(e.parentPath, e.name))];
  for (const dir of dirs) fs.chmodSync(dir, 0o500);
  try {
    const refused = { error: 'Calendar attachment storage upload failed.', code: 502, storage_code: 'DOCUMENT_STORAGE_UPLOAD_FAILED' };
    assert.deepEqual(await call('POST', C, EV({ title: 'Speicher 2', attachment_data: PNG })), { status: 502, body: refused }, 'POST');
    assert.deepEqual(await call('PUT', `${C}/${event}`, { attachment_data: PNG }), { status: 502, body: refused }, 'PUT');
    assert.deepEqual(await call('PUT', `${C}/${series}/occurrences/${KEY(20)}`, { attachment_data: PNG }), { status: 502, body: refused }, 'PUT occurrence');
    assert.deepEqual(await call('PUT', `${C}/${series}/occurrences/${KEY(21)}/following`, { attachment_data: PNG }), { status: 502, body: refused }, 'PUT following');
  } finally {
    for (const dir of dirs) fs.chmodSync(dir, 0o700);
  }
  // A private address while the private network is not allowed.
  process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK = 'false';
  try {
    const sub = await call('POST', `${C}/subscriptions`, SUBSCRIPTION({ name: 'Privat', url: 'https://127.0.0.1/feed.ics' }));
    assert.equal(sub.status, 400, JSON.stringify(sub.body));
    assert.equal(/** @type {any} */ (sub.body).reason, 'calendar_ics_private_address');
    const imported = await call('POST', `${C}/import`, { url: 'https://127.0.0.1/feed.ics' });
    assert.equal(imported.status, 400);
    assert.equal(/** @type {any} */ (imported.body).reason, 'calendar_ics_private_address');
    // The feed of subscription 1 is http:// on 127.0.0.1: without the private network only https:// is taken.
    const synced = await call('POST', `${C}/subscriptions/1/sync`, NO_BODY);
    assert.equal(synced.status, 400);
    assert.equal(/** @type {any} */ (synced.body).reason, 'calendar_ics_url_scheme');
  } finally {
    process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK = 'true';
  }
  // The restore gate in front of the sync targets.
  restoreState.setRestoreRunning(true);
  try {
    assert.equal((await call('GET', `${C}/sync-targets`, NO_BODY)).status, 503);
  } finally {
    restoreState.setRestoreRunning(false);
  }
  assert.deepEqual(logged.error, [], 'nothing reached the central handler');
});

test('the rights the middlewares answer in front of the check keep their 403 (the handler lines are gone)', async () => {
  const write = { error: 'Write access to the calendar is required.', code: 403, reason: 'cross_module_access' };
  const upload = { error: 'Attaching a file needs write access to documents.', code: 403, reason: 'ATTACHMENT_UPLOAD_REFUSED' };
  const series = await created(C, SERIES({ title: 'Rechte' }));
  for (const [method, route, body] of /** @type {Array<[string, string, unknown]>} */ ([
    ['POST', `${C}/calendars`, { name: 'Lesend' }],
    ['PATCH', `${C}/calendars/reorder`, { order: [1] }],
    ['PUT', `${C}/calendars/2`, { name: 'Lesend' }],
    ['DELETE', `${C}/calendars/2`, NO_BODY],
  ])) {
    assert.deepEqual(await call(method, route, body, { actor: 'reader' }), { status: 403, body: write }, `${method} ${route}`);
  }
  for (const [method, route] of [['POST', C], ['PUT', `${C}/${series}`], ['PUT', `${C}/${series}/occurrences/${KEY(20)}`], ['PUT', `${C}/${series}/occurrences/${KEY(21)}/following`]]) {
    assert.deepEqual(await call(method, route, { title: 'Anhang', start_datetime: '2026-11-20T09:00', attachment_data: PNG }, { actor: 'docread' }), { status: 403, body: upload }, `${method} ${route}`);
  }
});

// ── Sinks ───────────────────────────────────────────────────────────────────
/**
 * The handler of a route alone, without validateRequest() and whatever stands
 * in front of it in the route: the last function of its route layer.
 * @param {string} file the router module under server/routes/
 * @param {string} method lower case
 * @param {string} routePath the Express pattern of the router
 */
async function bareHandler(file, method, routePath) {
  const { default: router } = await import(`../server/routes/${file}`);
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
  }
  throw new Error(`no route ${method} ${routePath} in ${file}`);
}

/**
 * Runs a bare handler with a raw body, query and params as the admin; returns its answer.
 * @param {string} file
 * @param {string} method
 * @param {string} routePath
 * @param {{ body?: unknown, query?: Record<string, unknown>, params?: Record<string, string> }} input
 */
async function callBare(file, method, routePath, { body = {}, query = {}, params = {} }) {
  const handler = await bareHandler(file, method, routePath);
  const req = {
    method: method.toUpperCase(), body, query, params, protocol: 'http', get: () => 'localhost',
    authUserId: ADMIN, authRole: 'admin', authMethod: 'session', authScopes: null, session: { userId: ADMIN, role: 'admin' }, sessionModuleAccess: null,
  };
  /** @type {{ status: number, body: unknown }} */
  const out = { status: 200, body: undefined };
  const res = {
    status(/** @type {number} */ code) { out.status = code; return res; },
    json(/** @type {unknown} */ value) { out.body = value; return res; },
    send(/** @type {unknown} */ value) { out.body = value; return res; },
    end() { return res; },
    setHeader() {},
  };
  await handler(req, res, (/** @type {unknown} */ err) => { throw err; });
  return out;
}

// The schema refuses each of these in front (the table holds that). Behind it
// a loop, `.length`, a string method or an SQL bind runs over the raw value,
// so the handler keeps its own type check there (sink, not route; CodeQL
// js/loop-bound-injection in #2860): called without validateRequest(), each
// answers as it did instead of throwing or looping.
const RAW = [{ length: 1e9 }, 'x', 5];
const NOT_TEXT = [{ length: 1e9 }, 5, ['x']];

test('sink: the occurrence routes keep the check of the reminder lead times in front of new Set() and .some()', async () => {
  const series = await created(C, SERIES({ title: 'Senke Erinnerung' }));
  const sentence = { error: 'reminder_offsets: at most five distinct lead times in whole minutes from 0.', code: 400 };
  for (const raw of RAW) {
    for (const routePath of ['/:seriesId/occurrences/:recurrenceId', '/:seriesId/occurrences/:recurrenceId/following']) {
      assert.deepEqual(await callBare('calendar/crud.js', 'put', routePath, { body: { reminder_offsets: raw }, params: { seriesId: String(series), recurrenceId: KEY(20) } }),
        { status: 400, body: sentence }, `${routePath} ${JSON.stringify(raw)}`);
    }
  }
});

test('sink: the occurrence routes keep the check of the assignee ids in front of the SQL bind', async () => {
  const series = await created(C, SERIES({ title: 'Senke Personen' }));
  const sentence = { error: 'Assignment: choose people by valid positive user IDs.', code: 400 };
  for (const raw of [[{}], ['x'], [1.5], { length: 1e9 }]) {
    for (const routePath of ['/:seriesId/occurrences/:recurrenceId', '/:seriesId/occurrences/:recurrenceId/following']) {
      assert.deepEqual(await callBare('calendar/crud.js', 'put', routePath, { body: { assigned_to: raw }, params: { seriesId: String(series), recurrenceId: KEY(20) } }),
        { status: 400, body: sentence }, `${routePath} ${JSON.stringify(raw)}`);
    }
  }
});

test('sink: the occurrence routes keep the type check of a date in front of .trim()', async () => {
  const series = await created(C, SERIES({ title: 'Senke Datum' }));
  for (const raw of [5, { length: 1e9 }, ['2026-11-20']]) {
    for (const routePath of ['/:seriesId/occurrences/:recurrenceId', '/:seriesId/occurrences/:recurrenceId/following']) {
      assert.deepEqual(await callBare('calendar/crud.js', 'put', routePath, { body: { start_datetime: raw }, params: { seriesId: String(series), recurrenceId: KEY(20) } }),
        { status: 400, body: { error: 'start_datetime: enter a date with an optional time.', code: 400 } }, `${routePath} ${JSON.stringify(raw)}`);
    }
  }
});

test('sink: PUT of an event keeps the type check of the title in front of .trim()', async () => {
  const event = await created(C, EV({ title: 'Senke Titel' }));
  for (const raw of [5, { length: 1e9 }, ['x']]) {
    assert.deepEqual(await callBare('calendar/crud.js', 'put', '/:id', { body: { title: raw }, params: { id: String(event) } }),
      { status: 400, body: { error: 'title must be text.', code: 400 } }, JSON.stringify(raw));
  }
});

test('sink: the calendar reorder keeps its list check in front of .every() and .forEach()', async () => {
  for (const raw of RAW) {
    assert.deepEqual(await callBare('calendar/local-calendars.js', 'patch', '/calendars/reorder', { body: { order: raw } }),
      { status: 400, body: { error: 'Order: list every calendar exactly once.', code: 400 } }, JSON.stringify(raw));
  }
});

test('sink: the calendar list and the holidays keep the day check in front of the window', async () => {
  for (const raw of [{ length: 1e9 }, 5]) {
    assert.deepEqual(await callBare('calendar/read.js', 'get', '/', { query: { from: raw, to: '2026-11-30' } }),
      { status: 400, body: { error: 'from and to must be in YYYY-MM-DD format.', code: 400 } }, `list ${JSON.stringify(raw)}`);
    assert.deepEqual(await callBare('calendar/feed.js', 'get', '/holidays', { query: { from: raw, to: '2026-11-30' } }),
      { status: 400, body: { error: 'Query params from and to (YYYY-MM-DD) required.', code: 400 } }, `holidays ${JSON.stringify(raw)}`);
  }
});

test('sink: the import reads its ICS text and its address as text only', async () => {
  for (const raw of NOT_TEXT) {
    assert.deepEqual(await callBare('calendar/subscriptions.js', 'post', '/import', { body: { ics: raw, url: raw } }),
      { status: 400, body: { error: 'Either an ICS file or a URL is required.', code: 400 } }, JSON.stringify(raw));
  }
});

test('sink: a subscription keeps the type check of its address in front of .replace()', async () => {
  for (const raw of NOT_TEXT) {
    assert.deepEqual(await callBare('calendar/subscriptions.js', 'post', '/subscriptions', { body: { name: 'Senke', url: raw, color: '#336699' } }),
      { status: 400, body: { error: 'url is required.', code: 400 } }, JSON.stringify(raw));
  }
});
