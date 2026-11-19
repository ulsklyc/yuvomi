/**
 * Test: the answers of the waste and schedule modules stay byte-equal (#2810, phase 2 section E, group 4)
 * Purpose: the eight route files of waste (server/routes/waste/, 39 routes) and the four of schedule
 *          (schedule.js, -extras, -feed, -preferences, 32 routes) dropped the hand checks the schema of
 *          their operation already covers (`validateRequest()` runs before every handler since #2833)
 *          and the try/catch blocks that answered an unexpected error with a 500 of their own. This
 *          suite holds that refactor: for a table of requests to all 71 operations - valid, every
 *          refusal of the handler that stays (empty after trimming, a calendar day that does not
 *          exist, the domain rules, ids of 0 and below, bounds outside the schema), every input a
 *          dropped hand check refused (now the schema's 400), not found, rights, conflicts, for an
 *          admin, members and a reader without write access to waste - it pins status and the WHOLE
 *          body. The expectations were written before the refactor (6a703e29f) and are literal here,
 *          no fixture file, no update mode. Only values that follow a clock or a random this suite
 *          does not hold (SQLite's own `now`, feed tokens, the ports of the two local servers) are
 *          replaced by a marker. The clock stands still (`mock.timers`, 18.11.2026 12:00 UTC), the
 *          household lives in Europe/Berlin: the next pickups and the reminders read "today".
 *
 *          The second part: an unexpected error in every one of the 71 routes reaches the central
 *          error handler - 500 with its fixed sentence and its log line `Unhandled error: <METHOD>
 *          <pattern> -> 500` - and the process keeps answering. The one visible change: waste
 *          answered `Internal error`, `DELETE /schedule/shift-types/{id}` `Internal error.` and
 *          `GET /schedule/entries` `Schedule entries could not be resolved.` - all are the central
 *          sentence now. What stays the route's own: the 400, 409 and 404 of the typed waste errors,
 *          the 502 of a URL source without entries and the 409 of a shift type still in use.
 * Run: npm run test:waste-schedule-answers
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// The URL sources below are a local stand-in, never the network: the opt-in
// for a private address (http://127.0.0.1) is on for the whole suite.
process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK = '1';
delete process.env.BASE_URL;

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: wasteRouter } = await import('../server/routes/waste/index.js');
const { default: scheduleRouter } = await import('../server/routes/schedule.js');
const { default: scheduleExtrasRouter } = await import('../server/routes/schedule-extras.js');
const { default: scheduleFeedRouter } = await import('../server/routes/schedule-feed.js');
const { default: schedulePreferencesRouter } = await import('../server/routes/schedule-preferences.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { resolveRequestModuleAccess } = await import('../server/authorize/index.ts');
const { MAX_ICS_BYTES } = await import('../server/services/waste-import.js');
const db = dbmod.get();

db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, 'parent')")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const MEMBER = user('tom', 'member');
const OTHER = user('mia', 'member');
// A users row that is not a household member: a split-expense guest.
const GUEST = user('gast', 'member');
db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(GUEST);
const MISSING = 987654;

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = { admin: { id: ADMIN, role: 'admin' }, member: { id: MEMBER, role: 'member' }, other: { id: OTHER, role: 'member' } };

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = express();
// Above the ICS upload limit in UTF-8 bytes, so that limit is the route's.
app.use(express.json({ limit: MAX_ICS_BYTES * 3 }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read. `x-access` overrides
// the session's module access (e.g. {"waste":"read"}).
app.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
  const actor = ACTORS[req.get('x-actor') ?? 'admin'];
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = 'session';
  req.authScopes = null;
  req.session = { userId: actor.id, role: actor.role };
  req.sessionModuleAccess = req.get('x-access')
    ? { ...resolveRequestModuleAccess(db, req), ...JSON.parse(req.get('x-access')) }
    : resolveRequestModuleAccess(db, req);
  // An unexpected error: the first answer of the handler throws, a JSON
  // answer as well as an empty 204.
  if (req.get('x-fail') === 'answer') {
    let thrown = false;
    for (const name of ['json', 'end']) {
      const original = res[name];
      res[name] = function (/** @type {unknown[]} */ ...args) {
        if (!thrown) { thrown = true; throw new Error(`${name} broke`); }
        return original.apply(this, args);
      };
    }
  }
  next();
});
// The mounts of server/index.js, in its order.
app.use('/api/v1/waste', wasteRouter);
app.use('/api/v1/schedule/feed', scheduleFeedRouter);
app.use('/api/v1/schedule/preferences', schedulePreferencesRouter);
app.use('/api/v1/schedule/extras', scheduleExtrasRouter);
app.use('/api/v1/schedule', scheduleRouter);
app.use(createErrorHandler(log));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));

// The address of a URL source: a local stand-in that answers by path.
const ics = (/** @type {string} */ day, label = 'Restmuell') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${label}-${day}@x\r\nSUMMARY:${label}\r\nDTSTART;VALUE=DATE:${day.replace(/-/g, '')}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const EMPTY_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';
/** @type {Record<string, string>} */
const feeds = { '/cal.ics': ics('2026-12-07', 'Gelbe Tonne') };
const feedServer = http.createServer((req, res) => {
  const text = feeds[String(req.url)];
  if (text === undefined) { res.writeHead(404).end('gone'); return; }
  res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(text);
});
feedServer.listen(0, '127.0.0.1');
/** @type {string} */
const feedOrigin = await new Promise((r) => feedServer.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (feedServer.address()).port}`)));
assert.equal(new URL(`${feedOrigin}/cal.ics`).origin, feedOrigin, 'the stand-in is exactly this origin');
test.after(() => { server.close(); feedServer.closeAllConnections?.(); feedServer.close(); });

const NO_BODY = Symbol('no body');

/** @typedef {{ actor?: string, access?: Record<string, string>, fail?: boolean }} CallOptions */

/**
 * @param {string} method
 * @param {string} path under /api/v1
 * @param {unknown} body a JSON value or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, path, body, { actor, access, fail } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== NO_BODY) headers['Content-Type'] = 'application/json';
  if (actor) headers['x-actor'] = actor;
  if (access) headers['x-access'] = JSON.stringify(access);
  if (fail) headers['x-fail'] = 'answer';
  const res = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, body: body === NO_BODY ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text.length === 0 ? null : JSON.parse(text) };
}

// Timestamps SQLite writes from its own clock ('now'), not from Date, the
// random feed tokens, and the ports of the two local servers.
const VOLATILE = new Set(['created_at', 'updated_at', 'last_import_at', 'last_success_at', 'token']);
const FEED_TOKEN = /\/feed\/(waste|schedule)\/[^/]+\.ics$/;

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (VOLATILE.has(key) && v !== null) return '<volatile>';
    if (typeof v !== 'string') return v;
    return v.split(feedOrigin).join('<feed>').split(baseUrl).join('<api>').replace(FEED_TOKEN, '/feed/$1/<volatile>.ics');
  });
}

// ── Seed and rows ──

/** Ids that exist only once their row ran, filled by setup rows. @type {Record<string, number>} */
const ids = {};
const lastId = (/** @type {string} */ table) => db.prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`).get().id;
const sourceId = (/** @type {string} */ name) => db.prepare('SELECT id FROM waste_sources WHERE name = ?').get(name).id;
const mappingId = (/** @type {number} */ source) => db.prepare('SELECT id FROM waste_source_mappings WHERE source_id = ? ORDER BY id LIMIT 1').get(source).id;
const typeId = (/** @type {string} */ name) => db.prepare('SELECT id FROM waste_types WHERE name = ?').get(name).id;
const shiftTypeId = (/** @type {string} */ name) => db.prepare('SELECT id FROM schedule_shift_types WHERE name = ?').get(name).id;
const fieldId = (/** @type {string} */ name) => db.prepare('SELECT id FROM schedule_custom_fields WHERE name = ?').get(name).id;
const patternId = (/** @type {string} */ name) => db.prepare('SELECT id FROM schedule_patterns WHERE name = ?').get(name).id;
const sourceVersion = (/** @type {number} */ id) => db.prepare('SELECT version FROM waste_sources WHERE id = ?').get(id).version;

const BIG_ICS = 'ä'.repeat(Math.floor(MAX_ICS_BYTES / 2) + 1); // fewer characters than bytes: over the limit in UTF-8 only
const WEEKLY = () => ({ type_id: ids.bio, recurrence_kind: 'weekly', anchor_date: '2026-11-02', interval: 1, valid_until: null, active: true, weekdays: ['MO'] });
const REMIND = { enabled: true, offset_days: 1, delivery_time: '19:30' };
const LONG_TEXT = (/** @type {number} */ n) => 'x'.repeat(n);
/** A text that is short as sent and passes no further check after trimming. */
const SPACES = '   ';

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ WASTE: types ═══════════════════════════════════════════════════════════
  ['wt list empty', 'GET', '/waste/types', NO_BODY],
  ['wt create', 'POST', '/waste/types', { name: 'Bio', icon: 'leaf', color: '#22C55E' }],
  () => { ids.bio = typeId('Bio'); },
  ['wt create second', 'POST', '/waste/types', { name: ' Papier ', icon: 'trash-2', color: '#3B82F6' }],
  () => { ids.papier = typeId('Papier'); },
  ['wt create spaces', 'POST', '/waste/types', { name: SPACES, color: '#3B82F6' }],
  ['wt create no name', 'POST', '/waste/types', { color: '#3B82F6' }],
  ['wt create long name', 'POST', '/waste/types', { name: LONG_TEXT(101), color: '#3B82F6' }],
  ['wt create color empty', 'POST', '/waste/types', { name: 'Leer', color: '' }],
  ['wt create no body', 'POST', '/waste/types', NO_BODY],
  ['wt create duplicate', 'POST', '/waste/types', { name: 'bio', color: '#22C55E' }],
  ['wt get', 'GET', () => `/waste/types/${ids.bio}`, NO_BODY],
  ['wt get missing', 'GET', `/waste/types/${MISSING}`, NO_BODY],
  ['wt get zero', 'GET', '/waste/types/0', NO_BODY],
  ['wt get negative', 'GET', '/waste/types/-1', NO_BODY],
  ['wt get letters', 'GET', '/waste/types/abc', NO_BODY],
  ['wt update', 'PUT', () => `/waste/types/${ids.papier}`, { sort_order: 3 }],
  ['wt update archive', 'PUT', () => `/waste/types/${ids.papier}`, { archived: true }],
  ['wt list archived 1', 'GET', '/waste/types?include_archived=1', NO_BODY],
  ['wt list archived true', 'GET', '/waste/types?include_archived=true', NO_BODY],
  ['wt list archived 0', 'GET', '/waste/types?include_archived=0', NO_BODY],
  ['wt list archived yes', 'GET', '/waste/types?include_archived=yes', NO_BODY],
  ['wt update unarchive', 'PUT', () => `/waste/types/${ids.papier}`, { archived: false }],
  ['wt update spaces', 'PUT', () => `/waste/types/${ids.papier}`, { name: SPACES }],
  ['wt update archived text', 'PUT', () => `/waste/types/${ids.papier}`, { archived: 'true' }],
  ['wt update missing', 'PUT', `/waste/types/${MISSING}`, { name: 'X' }],
  ['wt update zero', 'PUT', '/waste/types/0', { name: 'X' }],
  ['wt update member', 'PUT', () => `/waste/types/${ids.papier}`, { name: 'Papier' }, { actor: 'member' }],

  // ══ WASTE: schedules ═══════════════════════════════════════════════════════
  ['ws list empty', 'GET', '/waste/schedules', NO_BODY],
  ['ws create weekly', 'POST', '/waste/schedules', () => WEEKLY()],
  () => { ids.weekly = lastId('waste_schedules'); },
  ['ws create monthly fixed', 'POST', '/waste/schedules', () => ({ type_id: ids.papier, recurrence_kind: 'monthly_fixed_day', anchor_date: '2026-11-15', interval: 1, valid_until: null, active: true, month_day: 15 })],
  ['ws create ordinal', 'POST', '/waste/schedules', () => ({ type_id: ids.papier, recurrence_kind: 'monthly_ordinal_weekday', anchor_date: '2026-11-10', interval: 1, valid_until: '2027-06-30', active: false, month_day: 2, weekdays: 'TU' })],
  () => { ids.ordinal = lastId('waste_schedules'); },
  ['ws create kind unknown', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), recurrence_kind: 'yearly' })],
  ['ws create anchor not a day', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), anchor_date: '2026-02-30' })],
  ['ws create interval zero', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), interval: 0 })],
  ['ws create interval large', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), interval: 60 })],
  ['ws create interval text', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), interval: '2' })],
  ['ws create weekdays empty', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), weekdays: [] })],
  ['ws create weekday unknown', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), weekdays: ['XX'] })],
  ['ws create weekdays comma text', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), weekdays: 'MO,TH' })],
  ['ws create anchor not weekday', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), anchor_date: '2026-11-03' })],
  ['ws create type missing', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), type_id: MISSING })],
  ['ws create type zero', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), type_id: 0 })],
  ['ws create type true', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), type_id: true })],
  ['ws create type digit text', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), type_id: String(ids.bio), anchor_date: '2026-11-09' })],
  ['ws create fixed day 31 in feb', 'POST', '/waste/schedules', () => ({ type_id: ids.bio, recurrence_kind: 'monthly_fixed_day', anchor_date: '2026-11-15', interval: 1, month_day: 32 })],
  ['ws create ordinal 5', 'POST', '/waste/schedules', () => ({ type_id: ids.bio, recurrence_kind: 'monthly_ordinal_weekday', anchor_date: '2026-11-10', interval: 1, month_day: 5, weekdays: 'TU' })],
  ['ws create until before anchor', 'POST', '/waste/schedules', () => ({ ...WEEKLY(), valid_until: '2026-10-01' })],
  ['ws list', 'GET', '/waste/schedules', NO_BODY],
  ['ws list type', 'GET', () => `/waste/schedules?type_id=${ids.papier}`, NO_BODY],
  ['ws list inactive 0', 'GET', '/waste/schedules?include_inactive=0', NO_BODY],
  ['ws list type letters', 'GET', '/waste/schedules?type_id=abc', NO_BODY],
  ['ws get', 'GET', () => `/waste/schedules/${ids.weekly}`, NO_BODY],
  ['ws get missing', 'GET', `/waste/schedules/${MISSING}`, NO_BODY],
  ['ws get zero', 'GET', '/waste/schedules/0', NO_BODY],
  ['ws update', 'PUT', () => `/waste/schedules/${ids.weekly}`, () => ({ ...WEEKLY(), weekdays: ['MO', 'TH'] })],
  ['ws update interval large', 'PUT', () => `/waste/schedules/${ids.weekly}`, { interval: 99 }],
  ['ws update active text', 'PUT', () => `/waste/schedules/${ids.weekly}`, { active: 'false' }],
  ['ws update missing', 'PUT', `/waste/schedules/${MISSING}`, () => WEEKLY()],
  ['ws update zero', 'PUT', '/waste/schedules/0', () => WEEKLY()],
  ['ws override move', 'PUT', () => `/waste/schedules/${ids.weekly}/overrides/2026-11-23`, { replacement_date: '2026-11-24', note: ' Feiertag ' }],
  ['ws override skip', 'PUT', () => `/waste/schedules/${ids.weekly}/overrides/2026-11-30`, { replacement_date: null, note: null }],
  ['ws override explicit skip', 'PUT', () => `/waste/schedules/${ids.weekly}/overrides/2026-12-07`, { replacement_date: null, note: null }],
  ['ws override not calculated', 'PUT', () => `/waste/schedules/${ids.weekly}/overrides/2026-11-25`, { replacement_date: null, note: null }],
  ['ws override not a day', 'PUT', () => `/waste/schedules/${ids.weekly}/overrides/2026-02-30`, { replacement_date: null, note: null }],
  ['ws override replacement empty', 'PUT', () => `/waste/schedules/${ids.weekly}/overrides/2026-12-14`, { replacement_date: '', note: null }],
  ['ws override note true', 'PUT', () => `/waste/schedules/${ids.weekly}/overrides/2026-12-14`, { replacement_date: null, note: true }],
  ['ws override missing', 'PUT', `/waste/schedules/${MISSING}/overrides/2026-12-14`, { replacement_date: null, note: null }],
  ['ws override zero', 'PUT', '/waste/schedules/0/overrides/2026-12-14', { replacement_date: null, note: null }],
  ['ws get with overrides', 'GET', () => `/waste/schedules/${ids.weekly}`, NO_BODY],
  ['ws override delete', 'DELETE', () => `/waste/schedules/${ids.weekly}/overrides/2026-11-30`, NO_BODY],
  ['ws override delete again', 'DELETE', () => `/waste/schedules/${ids.weekly}/overrides/2026-11-30`, NO_BODY],
  ['ws override delete not a key', 'DELETE', () => `/waste/schedules/${ids.weekly}/overrides/soon`, NO_BODY],
  ['ws override delete zero', 'DELETE', '/waste/schedules/0/overrides/2026-11-30', NO_BODY],

  // ══ WASTE: pickups ═════════════════════════════════════════════════════════
  ['wp list empty', 'GET', '/waste/pickups', NO_BODY],
  ['wp create', 'POST', '/waste/pickups', () => ({ type_id: ids.bio, date: '2026-12-02', note: ' Sperrmuell ' })],
  () => { ids.pickup = lastId('waste_one_off_pickups'); },
  ['wp create not a day', 'POST', '/waste/pickups', () => ({ type_id: ids.bio, date: '2026-02-30' })],
  ['wp create no date', 'POST', '/waste/pickups', () => ({ type_id: ids.bio })],
  ['wp create type missing', 'POST', '/waste/pickups', { type_id: MISSING, date: '2026-12-03' }],
  ['wp create type zero', 'POST', '/waste/pickups', { type_id: 0, date: '2026-12-03' }],
  ['wp create note long', 'POST', '/waste/pickups', () => ({ type_id: ids.bio, date: '2026-12-03', note: LONG_TEXT(501) })],
  ['wp create note spaces', 'POST', '/waste/pickups', () => ({ type_id: ids.papier, date: '2026-12-04', note: SPACES })],
  ['wp list', 'GET', '/waste/pickups', NO_BODY],
  ['wp list type', 'GET', () => `/waste/pickups?type_id=${ids.papier}`, NO_BODY],
  ['wp get', 'GET', () => `/waste/pickups/${ids.pickup}`, NO_BODY],
  ['wp get missing', 'GET', `/waste/pickups/${MISSING}`, NO_BODY],
  ['wp get zero', 'GET', '/waste/pickups/0', NO_BODY],
  ['wp update', 'PUT', () => `/waste/pickups/${ids.pickup}`, () => ({ type_id: ids.bio, date: '2026-12-09', note: 'Sperrmuell' })],
  ['wp update not a day', 'PUT', () => `/waste/pickups/${ids.pickup}`, { date: '2026-13-01' }],
  ['wp update missing', 'PUT', `/waste/pickups/${MISSING}`, { date: '2026-12-09' }],
  ['wp update zero', 'PUT', '/waste/pickups/0', { date: '2026-12-09' }],

  // ══ WASTE: occurrences ═════════════════════════════════════════════════════
  ['wo next', 'GET', '/waste/occurrences/next', NO_BODY],
  ['wo range', 'GET', '/waste/occurrences?from=2026-11-16&to=2026-12-15', NO_BODY],
  ['wo range reversed', 'GET', '/waste/occurrences?from=2026-12-15&to=2026-11-16', NO_BODY],
  ['wo range not a day', 'GET', '/waste/occurrences?from=2026-02-30&to=2026-03-15', NO_BODY],
  ['wo range long', 'GET', '/waste/occurrences?from=2020-01-01&to=2030-12-31', NO_BODY],
  ['wo range no from', 'GET', '/waste/occurrences?to=2026-12-15', NO_BODY],

  // ══ WASTE: file import and sources ═════════════════════════════════════════
  ['wi preview', 'POST', '/waste/import/preview', { ics: ics('2026-12-01') }],
  ['wi preview no ics', 'POST', '/waste/import/preview', {}],
  ['wi preview spaces', 'POST', '/waste/import/preview', { ics: SPACES }],
  ['wi preview too large', 'POST', '/waste/import/preview', { ics: BIG_ICS }],
  ['wi preview no events', 'POST', '/waste/import/preview', { ics: EMPTY_ICS }],
  ['wi commit name spaces', 'POST', '/waste/import/commit', () => ({ ics: ics('2026-12-01'), name: SPACES, mappings: [{ normalized_label: 'restmuell', type_ids: [ids.bio] }] })],
  ['wi commit no ics', 'POST', '/waste/import/commit', { name: 'Kalender' }],
  ['wi commit unmapped', 'POST', '/waste/import/commit', { ics: ics('2026-12-01'), name: 'Kalender', mappings: [] }],
  ['wi commit digest stale', 'POST', '/waste/import/commit', () => ({ ics: ics('2026-12-01'), name: 'Kalender', mappings: [{ normalized_label: 'restmuell', type_ids: [ids.bio] }], preview_digest: 'stale' })],
  ['wi commit', 'POST', '/waste/import/commit', () => ({ ics: ics('2026-12-01'), name: ' Kalender ', mappings: [{ normalized_label: 'restmuell', type_ids: [ids.bio] }], skip_event_keys: [], preview_digest: null })],
  () => { ids.file = sourceId('Kalender'); ids.mapping = mappingId(ids.file); },
  ['wq list', 'GET', '/waste/sources', NO_BODY],
  ['wq get', 'GET', () => `/waste/sources/${ids.file}`, NO_BODY],
  ['wq get missing', 'GET', `/waste/sources/${MISSING}`, NO_BODY],
  ['wq get zero', 'GET', '/waste/sources/0', NO_BODY],
  ['wq rename', 'PUT', () => `/waste/sources/${ids.file}`, { name: ' Kalender 2026 ' }],
  ['wq rename spaces', 'PUT', () => `/waste/sources/${ids.file}`, { name: SPACES }],
  ['wq rename missing', 'PUT', `/waste/sources/${MISSING}`, { name: 'X' }],
  ['wq rename zero', 'PUT', '/waste/sources/0', { name: 'X' }],
  ['wq mapping', 'PUT', () => `/waste/sources/${ids.file}/mappings/${ids.mapping}`, () => ({ type_ids: [ids.bio, ids.papier] })],
  ['wq mapping ignored', 'PUT', () => `/waste/sources/${ids.file}/mappings/${ids.mapping}`, { ignored: true }],
  ['wq mapping both', 'PUT', () => `/waste/sources/${ids.file}/mappings/${ids.mapping}`, () => ({ type_ids: [ids.bio], ignored: true })],
  ['wq mapping type missing', 'PUT', () => `/waste/sources/${ids.file}/mappings/${ids.mapping}`, { type_ids: [MISSING] }],
  ['wq mapping back', 'PUT', () => `/waste/sources/${ids.file}/mappings/${ids.mapping}`, () => ({ type_ids: [ids.bio] })],
  ['wq mapping missing', 'PUT', () => `/waste/sources/${ids.file}/mappings/${MISSING}`, () => ({ type_ids: [ids.bio] })],
  ['wq mapping zero', 'PUT', () => `/waste/sources/${ids.file}/mappings/0`, () => ({ type_ids: [ids.bio] })],
  ['wq mapping source zero', 'PUT', () => `/waste/sources/0/mappings/${ids.mapping}`, () => ({ type_ids: [ids.bio] })],
  ['wq export', 'GET', () => `/waste/sources/${ids.file}/mapping-profile/export`, NO_BODY],
  ['wq export missing', 'GET', `/waste/sources/${MISSING}/mapping-profile/export`, NO_BODY],
  ['wq export zero', 'GET', '/waste/sources/0/mapping-profile/export', NO_BODY],
  ['wq profile preview', 'POST', () => `/waste/sources/${ids.file}/mapping-profile/import/preview`, { profile: { version: 1, mappings: [{ pattern: 'restmuell', type_name: 'Papier' }] } }],
  ['wq profile preview empty', 'POST', () => `/waste/sources/${ids.file}/mapping-profile/import/preview`, { profile: { mappings: [] } }],
  ['wq profile preview missing', 'POST', `/waste/sources/${MISSING}/mapping-profile/import/preview`, { profile: { mappings: [] } }],
  ['wq profile preview zero', 'POST', '/waste/sources/0/mapping-profile/import/preview', { profile: { mappings: [] } }],
  ['wq profile commit stale', 'POST', () => `/waste/sources/${ids.file}/mapping-profile/import/commit`, { profile: { version: 1, mappings: [{ pattern: 'restmuell', type_name: 'Papier' }] }, profile_digest: 'stale' }],
  ['wq profile commit zero', 'POST', '/waste/sources/0/mapping-profile/import/commit', { profile: { mappings: [] }, profile_digest: 'x' }],
  ['wq reimport preview', 'POST', () => `/waste/sources/${ids.file}/reimport/preview`, { ics: ics('2026-12-08') }],
  ['wq reimport preview no ics', 'POST', () => `/waste/sources/${ids.file}/reimport/preview`, {}],
  ['wq reimport preview too large', 'POST', () => `/waste/sources/${ids.file}/reimport/preview`, { ics: BIG_ICS }],
  ['wq reimport preview no events', 'POST', () => `/waste/sources/${ids.file}/reimport/preview`, { ics: EMPTY_ICS }],
  ['wq reimport preview missing', 'POST', `/waste/sources/${MISSING}/reimport/preview`, { ics: ics('2026-12-08') }],
  ['wq reimport preview zero', 'POST', '/waste/sources/0/reimport/preview', { ics: ics('2026-12-08') }],
  ['wq reimport commit stale version', 'POST', () => `/waste/sources/${ids.file}/reimport/commit`, () => ({ ics: ics('2026-12-08'), mappings: [{ normalized_label: 'restmuell', type_ids: [ids.bio] }], expected_version: 99 })],
  ['wq reimport commit', 'POST', () => `/waste/sources/${ids.file}/reimport/commit`, () => ({ ics: ics('2026-12-08'), mappings: [{ normalized_label: 'restmuell', type_ids: [ids.bio] }], skip_event_keys: [], expected_version: sourceVersion(ids.file) })],
  ['wq reimport commit zero', 'POST', '/waste/sources/0/reimport/commit', { ics: ics('2026-12-08'), expected_version: 1 }],
  ['wq refresh file', 'POST', () => `/waste/sources/${ids.file}/refresh`, {}],
  ['wq refresh missing', 'POST', `/waste/sources/${MISSING}/refresh`, {}],
  ['wq refresh zero', 'POST', '/waste/sources/0/refresh', {}],

  // URL sources: the local stand-in.
  ['wq url create', 'POST', '/waste/sources', { name: ' Stadt ', url: `${feedOrigin}/cal.ics`, refresh_interval_minutes: 1440 }],
  () => { ids.url = sourceId('Stadt'); },
  ['wq url create name spaces', 'POST', '/waste/sources', { name: SPACES, url: `${feedOrigin}/cal.ics` }],
  ['wq url create no url', 'POST', '/waste/sources', { name: 'Ohne' }],
  ['wq url create bad url', 'POST', '/waste/sources', { name: 'Kaputt', url: 'ftp://example.org/cal.ics' }],
  ['wq url create interval low', 'POST', '/waste/sources', { name: 'Oft', url: `${feedOrigin}/cal.ics`, refresh_interval_minutes: 30 }],
  ['wq url create interval high', 'POST', '/waste/sources', { name: 'Selten', url: `${feedOrigin}/cal.ics`, refresh_interval_minutes: 50000 }],
  ['wq url create interval fraction', 'POST', '/waste/sources', { name: 'Halb', url: `${feedOrigin}/cal.ics`, refresh_interval_minutes: 90.5 }],
  ['wq url create gone', 'POST', '/waste/sources', { name: 'Weg', url: `${feedOrigin}/gone.ics` }],
  ['wq url list admin', 'GET', '/waste/sources', NO_BODY],
  ['wq url list reader', 'GET', '/waste/sources', NO_BODY, { actor: 'member', access: { waste: 'read' } }],
  ['wq url get admin', 'GET', () => `/waste/sources/${ids.url}`, NO_BODY],
  ['wq url get reader', 'GET', () => `/waste/sources/${ids.url}`, NO_BODY, { actor: 'member', access: { waste: 'read' } }],
  ['wq url reimport preview', 'POST', () => `/waste/sources/${ids.url}/reimport/preview`, {}],
  () => { feeds['/cal.ics'] = ics('2026-12-14', 'Gelbe Tonne'); },
  ['wq url refresh', 'POST', () => `/waste/sources/${ids.url}/refresh`, {}],
  ['wq url refresh reader', 'POST', () => `/waste/sources/${ids.url}/refresh`, {}, { actor: 'member', access: { waste: 'read' } }],
  () => { feeds['/cal.ics'] = EMPTY_ICS; },
  ['wq url reimport preview no events', 'POST', () => `/waste/sources/${ids.url}/reimport/preview`, {}],
  ['wq url reimport commit no events', 'POST', () => `/waste/sources/${ids.url}/reimport/commit`, () => ({ expected_version: sourceVersion(ids.url) })],
  ['wq url reimport commit stale version', 'POST', () => `/waste/sources/${ids.url}/reimport/commit`, { expected_version: 99 }],
  () => { delete feeds['/cal.ics']; },
  ['wq url reimport preview gone', 'POST', () => `/waste/sources/${ids.url}/reimport/preview`, {}],
  ['wq url refresh gone', 'POST', () => `/waste/sources/${ids.url}/refresh`, {}],
  ['wq url get after failure reader', 'GET', () => `/waste/sources/${ids.url}`, NO_BODY, { actor: 'member', access: { waste: 'read' } }],
  () => { feeds['/cal.ics'] = ics('2026-12-21', 'Blaue Tonne'); },
  ['wq url reimport commit unmapped', 'POST', () => `/waste/sources/${ids.url}/reimport/commit`, () => ({ mappings: [], expected_version: sourceVersion(ids.url) })],
  ['wq url reimport commit', 'POST', () => `/waste/sources/${ids.url}/reimport/commit`, () => ({ mappings: [{ normalized_label: 'blaue tonne', type_ids: [ids.papier] }], expected_version: sourceVersion(ids.url) })],

  // ══ WASTE: reminder settings ═══════════════════════════════════════════════
  ['wr list', 'GET', '/waste/reminder-settings', NO_BODY],
  ['wr put', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, REMIND],
  ['wr put member', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { enabled: false, offset_days: 0, delivery_time: '06:05' }, { actor: 'member' }],
  ['wr put max', 'PUT', () => `/waste/reminder-settings/${ids.papier}`, { enabled: true, offset_days: 14, delivery_time: '23:59' }],
  ['wr put offset above', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, offset_days: 15 }],
  ['wr put offset below', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, offset_days: -1 }],
  ['wr put offset fraction', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, offset_days: 1.5 }],
  ['wr put offset text', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, offset_days: '2' }],
  ['wr put offset null', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, offset_days: null }],
  ['wr put time empty', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, delivery_time: '' }],
  ['wr put time 24', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, delivery_time: '24:00' }],
  ['wr put time seconds', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, delivery_time: '08:00:00' }],
  ['wr put time null', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, delivery_time: null }],
  ['wr put enabled text', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, enabled: 'true' }],
  ['wr put enabled number', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, { ...REMIND, enabled: 1 }],
  ['wr put empty', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, {}],
  ['wr put no body', 'PUT', () => `/waste/reminder-settings/${ids.bio}`, NO_BODY],
  ['wr put type missing', 'PUT', `/waste/reminder-settings/${MISSING}`, REMIND],
  ['wr put type zero', 'PUT', '/waste/reminder-settings/0', REMIND],
  ['wr list after', 'GET', '/waste/reminder-settings', NO_BODY],
  ['wr list member', 'GET', '/waste/reminder-settings', NO_BODY, { actor: 'member' }],

  // ══ WASTE: feed ════════════════════════════════════════════════════════════
  ['wf get none', 'GET', '/waste/feed', NO_BODY],
  ['wf types before feed', 'PUT', '/waste/feed/types', () => ({ type_ids: [ids.bio] })],
  ['wf regenerate', 'POST', '/waste/feed/regenerate', {}],
  ['wf types', 'PUT', '/waste/feed/types', () => ({ type_ids: [ids.bio] })],
  ['wf types empty list', 'PUT', '/waste/feed/types', { type_ids: [] }],
  ['wf types unknown', 'PUT', '/waste/feed/types', () => ({ type_ids: [ids.bio, MISSING] })],
  ['wf types fraction', 'PUT', '/waste/feed/types', { type_ids: [1.5] }],
  ['wf types text', 'PUT', '/waste/feed/types', { type_ids: ['1'] }],
  ['wf types not a list', 'PUT', '/waste/feed/types', { type_ids: 1 }],
  ['wf types missing', 'PUT', '/waste/feed/types', {}],
  ['wf types no body', 'PUT', '/waste/feed/types', NO_BODY],
  ['wf get', 'GET', '/waste/feed', NO_BODY],
  ['wf types null', 'PUT', '/waste/feed/types', { type_ids: null }],
  ['wf get member', 'GET', '/waste/feed', NO_BODY, { actor: 'member' }],
  ['wf delete', 'DELETE', '/waste/feed', NO_BODY],
  ['wf get after', 'GET', '/waste/feed', NO_BODY],

  // ══ WASTE: deletes at the end ══════════════════════════════════════════════
  ['wt delete in use', 'DELETE', () => `/waste/types/${ids.bio}`, NO_BODY],
  ['ws delete', 'DELETE', () => `/waste/schedules/${ids.ordinal}`, NO_BODY],
  ['ws delete again', 'DELETE', () => `/waste/schedules/${ids.ordinal}`, NO_BODY],
  ['ws delete zero', 'DELETE', '/waste/schedules/0', NO_BODY],
  ['wp delete', 'DELETE', () => `/waste/pickups/${ids.pickup}`, NO_BODY],
  ['wp delete again', 'DELETE', () => `/waste/pickups/${ids.pickup}`, NO_BODY],
  ['wp delete zero', 'DELETE', '/waste/pickups/0', NO_BODY],
  ['wq delete', 'DELETE', () => `/waste/sources/${ids.url}`, NO_BODY],
  ['wq delete again', 'DELETE', () => `/waste/sources/${ids.url}`, NO_BODY],
  ['wq delete zero', 'DELETE', '/waste/sources/0', NO_BODY],
  ['wt create spare', 'POST', '/waste/types', { name: 'Glas', color: '#16A34A' }],
  ['wt delete', 'DELETE', () => `/waste/types/${typeId('Glas')}`, NO_BODY],
  ['wt delete again', 'DELETE', `/waste/types/${MISSING}`, NO_BODY],
  ['wt delete zero', 'DELETE', '/waste/types/0', NO_BODY],
  ['wt list end', 'GET', '/waste/types?include_archived=1', NO_BODY],

  // ══ SCHEDULE: members, shift types, custom fields ═════════════════════════
  ['sc members', 'GET', '/schedule/household-members', NO_BODY],
  ['sc types empty', 'GET', '/schedule/shift-types', NO_BODY],
  ['sc type create', 'POST', '/schedule/shift-types', { name: ' Frueh ', short_code: ' F ', start_time: '06:00', end_time: '14:00', color: '#0891B2', icon: ' sun ', shift_preset: '' }],
  () => { ids.frueh = shiftTypeId('Frueh'); },
  ['sc type create member', 'POST', '/schedule/shift-types', { name: 'Spaet', short_code: '', start_time: '', end_time: '', color: '', icon: '' }, { actor: 'member' }],
  () => { ids.spaet = shiftTypeId('Spaet'); },
  ['sc type create spaces', 'POST', '/schedule/shift-types', { name: SPACES }],
  ['sc type create no name', 'POST', '/schedule/shift-types', { short_code: 'X' }],
  ['sc type create start only', 'POST', '/schedule/shift-types', { name: 'Halb', start_time: '06:00' }],
  ['sc type create time 25', 'POST', '/schedule/shift-types', { name: 'Nacht', start_time: '25:00', end_time: '06:00' }],
  ['sc type create time single digit', 'POST', '/schedule/shift-types', { name: 'Nacht', start_time: '6:00', end_time: '14:00' }],
  ['sc type create color bad', 'POST', '/schedule/shift-types', { name: 'Nacht', color: 'red' }],
  ['sc type create color short', 'POST', '/schedule/shift-types', { name: 'Nacht', color: '#FFF' }],
  ['sc type create icon upper', 'POST', '/schedule/shift-types', { name: 'Nacht', icon: 'Sun' }],
  ['sc type create icon spaces inside', 'POST', '/schedule/shift-types', { name: 'Nacht', icon: 'sun moon' }],
  ['sc type create icon long', 'POST', '/schedule/shift-types', { name: 'Nacht', icon: LONG_TEXT(49) }],
  ['sc type create icon 48 spaced', 'POST', '/schedule/shift-types', { name: 'Nacht', icon: ` ${LONG_TEXT(46)} ` }],
  ['sc type create icon number', 'POST', '/schedule/shift-types', { name: 'Nacht', icon: 5 }],
  ['sc type create icon spaces', 'POST', '/schedule/shift-types', { name: 'Ruhe', icon: SPACES, color: null, start_time: null, end_time: null }],
  ['sc type create short long', 'POST', '/schedule/shift-types', { name: 'Nacht', short_code: LONG_TEXT(13) }],
  ['sc type create short spaces', 'POST', '/schedule/shift-types', { name: 'Bereit', short_code: SPACES }],
  ['sc type create name number', 'POST', '/schedule/shift-types', { name: 5 }],
  ['sc type update', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { name: 'Frueh', color: '#1D4ED8', icon: 'sunrise' }],
  ['sc type update color empty keeps', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { color: '' }],
  ['sc type update color null keeps', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { color: null }],
  ['sc type update times cleared', 'PUT', () => `/schedule/shift-types/${ids.spaet}`, { start_time: '14:00', end_time: '22:00' }, { actor: 'member' }],
  ['sc type update end only', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { start_time: null }],
  ['sc type update time bad', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { start_time: '7', end_time: '8' }],
  ['sc type update icon upper', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { icon: 'Sun' }],
  ['sc type update icon long', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { icon: LONG_TEXT(49) }],
  ['sc type update icon object', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { icon: {} }],
  ['sc type update icon empty', 'PUT', () => `/schedule/shift-types/${ids.spaet}`, { icon: '' }, { actor: 'member' }],
  ['sc type update name spaces', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { name: SPACES }],
  ['sc type update foreign member', 'PUT', () => `/schedule/shift-types/${ids.frueh}`, { name: 'Meins' }, { actor: 'member' }],
  ['sc type update missing', 'PUT', `/schedule/shift-types/${MISSING}`, { name: 'X' }],
  ['sc type update zero', 'PUT', '/schedule/shift-types/0', { name: 'X' }],
  ['sc type update negative', 'PUT', '/schedule/shift-types/-3', { name: 'X' }],
  ['sc fields list empty', 'GET', '/schedule/custom-fields', NO_BODY],
  ['sc field create', 'POST', '/schedule/custom-fields', { name: ' Station ' }],
  () => { ids.station = fieldId('Station'); },
  ['sc field create member', 'POST', '/schedule/custom-fields', { name: 'Raum' }, { actor: 'member' }],
  () => { ids.raum = fieldId('Raum'); },
  ['sc field create spaces', 'POST', '/schedule/custom-fields', { name: SPACES }],
  ['sc field create long', 'POST', '/schedule/custom-fields', { name: LONG_TEXT(101) }],
  ['sc field create long spaced', 'POST', '/schedule/custom-fields', { name: ` ${LONG_TEXT(99)}` }],
  ['sc field create no name', 'POST', '/schedule/custom-fields', {}],
  ['sc field rename', 'PUT', () => `/schedule/custom-fields/${ids.station}`, { name: 'Station ' }],
  ['sc field rename keep', 'PUT', () => `/schedule/custom-fields/${ids.station}`, {}],
  ['sc field rename null', 'PUT', () => `/schedule/custom-fields/${ids.station}`, { name: null }],
  ['sc field rename spaces', 'PUT', () => `/schedule/custom-fields/${ids.station}`, { name: SPACES }],
  ['sc field rename foreign member', 'PUT', () => `/schedule/custom-fields/${ids.station}`, { name: 'X' }, { actor: 'member' }],
  ['sc field rename missing', 'PUT', `/schedule/custom-fields/${MISSING}`, { name: 'X' }],
  ['sc field rename zero', 'PUT', '/schedule/custom-fields/0', { name: 'X' }],
  ['sc type fields', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, () => ({ fields: [{ custom_field_id: ids.station, position: 0, show_in_overlay: true }, { custom_field_id: String(ids.raum), position: 0 }] })],
  ['sc type fields empty', 'PUT', () => `/schedule/shift-types/${ids.spaet}/fields`, { fields: [] }, { actor: 'member' }],
  ['sc type fields id zero', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, { fields: [{ custom_field_id: 0, position: 0 }] }],
  ['sc type fields id zero text', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, { fields: [{ custom_field_id: '0', position: 0 }] }],
  ['sc type fields id gone', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, { fields: [{ custom_field_id: MISSING, position: 0 }] }],
  ['sc type fields repeat', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, () => ({ fields: [{ custom_field_id: ids.station, position: 0 }, { custom_field_id: `0${ids.station}`, position: 1 }] })],
  ['sc type fields position negative', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, () => ({ fields: [{ custom_field_id: ids.station, position: -1 }] })],
  ['sc type fields position fraction', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, () => ({ fields: [{ custom_field_id: ids.station, position: 1.5 }] })],
  ['sc type fields position text', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, () => ({ fields: [{ custom_field_id: ids.station, position: '1' }] })],
  ['sc type fields position missing', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, () => ({ fields: [{ custom_field_id: ids.station }] })],
  ['sc type fields overlay text', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, () => ({ fields: [{ custom_field_id: ids.station, position: 0, show_in_overlay: 'yes' }] })],
  ['sc type fields overlay null', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, () => ({ fields: [{ custom_field_id: ids.station, position: 0, show_in_overlay: null }] })],
  ['sc type fields row null', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, { fields: [null] }],
  ['sc type fields not a list', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, { fields: {} }],
  ['sc type fields missing', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, {}],
  ['sc type fields no body', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, NO_BODY],
  ['sc type fields foreign member', 'PUT', () => `/schedule/shift-types/${ids.frueh}/fields`, { fields: [] }, { actor: 'member' }],
  ['sc type fields type missing', 'PUT', `/schedule/shift-types/${MISSING}/fields`, { fields: [] }],
  ['sc type fields type zero', 'PUT', '/schedule/shift-types/0/fields', { fields: [] }],
  ['sc types', 'GET', '/schedule/shift-types', NO_BODY],
  ['sc fields list', 'GET', '/schedule/custom-fields', NO_BODY],

  // ══ SCHEDULE: patterns ═════════════════════════════════════════════════════
  ['sp list empty', 'GET', '/schedule/patterns', NO_BODY],
  ['sp create admin for member', 'POST', '/schedule/patterns', { user_id: MEMBER, name: ' Rota ', anchor_date: '2026-11-02', cycle_length: 7, valid_from: '', valid_until: '', is_active: true }],
  () => { ids.rota = patternId('Rota'); },
  ['sp create member own', 'POST', '/schedule/patterns', { user_id: MEMBER, name: 'Eigen', anchor_date: '2026-11-02', cycle_length: 14, valid_from: '2026-11-01', valid_until: '2027-12-31', is_active: false }, { actor: 'member' }],
  ['sp create member own text', 'POST', '/schedule/patterns', { user_id: String(MEMBER), name: 'Text', anchor_date: '2026-11-02', cycle_length: 1 }, { actor: 'member' }],
  ['sp create member own absent', 'POST', '/schedule/patterns', { name: 'Ohne', anchor_date: '2026-11-02', cycle_length: 366 }, { actor: 'other' }],
  () => { ids.ohne = patternId('Ohne'); },
  ['sp create member own null', 'POST', '/schedule/patterns', { user_id: null, name: 'Null', anchor_date: '2026-11-02', cycle_length: 2 }, { actor: 'other' }],
  ['sp create member own leading zero', 'POST', '/schedule/patterns', { user_id: `0${MEMBER}`, name: 'Null-Text', anchor_date: '2026-11-02', cycle_length: 2 }, { actor: 'member' }],
  ['sp create member foreign', 'POST', '/schedule/patterns', { user_id: OTHER, name: 'Fremd', anchor_date: '2026-11-02', cycle_length: 7 }, { actor: 'member' }],
  ['sp create member foreign broken', 'POST', '/schedule/patterns', { user_id: OTHER, cycle_length: 0 }, { actor: 'member' }],
  ['sp create member own broken', 'POST', '/schedule/patterns', { user_id: MEMBER, name: SPACES, anchor_date: '2026-02-30', cycle_length: 7 }, { actor: 'member' }],
  ['sp create member user zero', 'POST', '/schedule/patterns', { user_id: 0, name: 'Null', anchor_date: '2026-11-02', cycle_length: 7 }, { actor: 'member' }],
  ['sp create admin user zero', 'POST', '/schedule/patterns', { user_id: 0, name: 'Null', anchor_date: '2026-11-02', cycle_length: 7 }],
  ['sp create admin user zero text', 'POST', '/schedule/patterns', { user_id: '0', name: 'Null', anchor_date: '2026-11-02', cycle_length: 7 }],
  ['sp create admin user missing', 'POST', '/schedule/patterns', { user_id: MISSING, name: 'Weg', anchor_date: '2026-11-02', cycle_length: 7 }],
  ['sp create admin guest', 'POST', '/schedule/patterns', { user_id: GUEST, name: 'Gast', anchor_date: '2026-11-02', cycle_length: 7 }],
  ['sp create cycle zero', 'POST', '/schedule/patterns', { name: 'Kurz', anchor_date: '2026-11-02', cycle_length: 0 }],
  ['sp create cycle 367', 'POST', '/schedule/patterns', { name: 'Lang', anchor_date: '2026-11-02', cycle_length: 367 }],
  ['sp create cycle fraction', 'POST', '/schedule/patterns', { name: 'Halb', anchor_date: '2026-11-02', cycle_length: 1.5 }],
  ['sp create cycle text', 'POST', '/schedule/patterns', { name: 'Text', anchor_date: '2026-11-02', cycle_length: '7' }],
  ['sp create cycle null', 'POST', '/schedule/patterns', { name: 'Null', anchor_date: '2026-11-02', cycle_length: null }],
  ['sp create cycle missing', 'POST', '/schedule/patterns', { name: 'Ohne', anchor_date: '2026-11-02' }],
  ['sp create active text', 'POST', '/schedule/patterns', { name: 'Aktiv', anchor_date: '2026-11-02', cycle_length: 7, is_active: 'true' }],
  ['sp create active number', 'POST', '/schedule/patterns', { name: 'Aktiv', anchor_date: '2026-11-02', cycle_length: 7, is_active: 1 }],
  ['sp create active null', 'POST', '/schedule/patterns', { name: 'Aktiv', anchor_date: '2026-11-02', cycle_length: 7, is_active: null }],
  ['sp create anchor not a day', 'POST', '/schedule/patterns', { name: 'Feb', anchor_date: '2026-02-29', cycle_length: 7 }],
  ['sp create range reversed', 'POST', '/schedule/patterns', { name: 'Rueck', anchor_date: '2026-11-02', cycle_length: 7, valid_from: '2027-01-01', valid_until: '2026-12-31' }],
  ['sp create name spaces', 'POST', '/schedule/patterns', { name: SPACES, anchor_date: '2026-11-02', cycle_length: 7 }],
  ['sp list', 'GET', '/schedule/patterns', NO_BODY],
  ['sp list user', 'GET', `/schedule/patterns?user_id=${MEMBER}`, NO_BODY],
  ['sp list user zero', 'GET', '/schedule/patterns?user_id=0', NO_BODY],
  ['sp list user negative', 'GET', '/schedule/patterns?user_id=-2', NO_BODY],
  ['sp list user missing', 'GET', `/schedule/patterns?user_id=${MISSING}`, NO_BODY],
  ['sp list user letters', 'GET', '/schedule/patterns?user_id=abc', NO_BODY],
  ['sp days', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, () => ({ days: [{ position: 0, shift_type_id: ids.frueh, field_values: { [ids.station]: ' 3B ' } }, { position: 0, shift_type_id: String(ids.spaet) }, { position: 6, shift_type_id: null }] })],
  ['sp days member', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, () => ({ days: [{ position: 1, shift_type_id: ids.frueh }, { position: 2 }] }), { actor: 'member' }],
  ['sp days position cycle', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [{ position: 7 }] }],
  ['sp days position negative', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [{ position: -1 }] }],
  ['sp days position fraction', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [{ position: 0.5 }] }],
  ['sp days position text', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [{ position: '1' }] }],
  ['sp days position missing', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [{ shift_type_id: null }] }],
  ['sp days row null', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [null] }],
  ['sp days type zero', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [{ position: 0, shift_type_id: 0 }] }],
  ['sp days type gone', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [{ position: 0, shift_type_id: MISSING }] }],
  ['sp days field not attached', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, () => ({ days: [{ position: 0, shift_type_id: ids.spaet, field_values: { [ids.station]: 'x' } }] })],
  ['sp days field without type', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, () => ({ days: [{ position: 0, field_values: { [ids.station]: 'x' } }] })],
  ['sp days field key zero', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, () => ({ days: [{ position: 0, shift_type_id: ids.frueh, field_values: { 0: 'x' } }] })],
  ['sp days field value long', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, () => ({ days: [{ position: 0, shift_type_id: ids.frueh, field_values: { [ids.station]: LONG_TEXT(501) } }] })],
  ['sp days field value number', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, () => ({ days: [{ position: 0, shift_type_id: ids.frueh, field_values: { [ids.station]: 5 } }] })],
  ['sp days field values list', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, () => ({ days: [{ position: 0, shift_type_id: ids.frueh, field_values: [] }] })],
  ['sp days 501 rows', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: Array.from({ length: 501 }, () => ({ position: 0 })) }],
  ['sp days 500 rows', 'PUT', () => `/schedule/patterns/${ids.ohne}/days`, { days: Array.from({ length: 500 }, (_, i) => ({ position: i === 499 ? 366 : i })) }, { actor: 'other' }],
  ['sp days not a list', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: {} }],
  ['sp days missing', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, {}],
  ['sp days foreign member', 'PUT', () => `/schedule/patterns/${ids.rota}/days`, { days: [] }, { actor: 'other' }],
  ['sp days pattern missing', 'PUT', `/schedule/patterns/${MISSING}/days`, { days: [] }],
  ['sp days pattern zero', 'PUT', '/schedule/patterns/0/days', { days: [] }],
  ['sp days get', 'GET', () => `/schedule/patterns/${ids.rota}/days`, NO_BODY],
  ['sp days get missing', 'GET', `/schedule/patterns/${MISSING}/days`, NO_BODY],
  ['sp days get zero', 'GET', '/schedule/patterns/0/days', NO_BODY],
  ['sp update', 'PUT', () => `/schedule/patterns/${ids.rota}`, { name: 'Rota 2', valid_until: '2027-06-30', is_active: false, user_id: OTHER }],
  ['sp update member', 'PUT', () => `/schedule/patterns/${ids.rota}`, { is_active: true }, { actor: 'member' }],
  ['sp update cycle conflict', 'PUT', () => `/schedule/patterns/${ids.rota}`, { cycle_length: 2 }],
  ['sp update cycle grows', 'PUT', () => `/schedule/patterns/${ids.rota}`, { cycle_length: 8 }],
  ['sp update cycle zero', 'PUT', () => `/schedule/patterns/${ids.rota}`, { cycle_length: 0 }],
  ['sp update cycle 367', 'PUT', () => `/schedule/patterns/${ids.rota}`, { cycle_length: 367 }],
  ['sp update cycle fraction', 'PUT', () => `/schedule/patterns/${ids.rota}`, { cycle_length: 7.5 }],
  ['sp update cycle null', 'PUT', () => `/schedule/patterns/${ids.rota}`, { cycle_length: null }],
  ['sp update active text', 'PUT', () => `/schedule/patterns/${ids.rota}`, { is_active: 'false' }],
  ['sp update active null', 'PUT', () => `/schedule/patterns/${ids.rota}`, { is_active: null }],
  ['sp update range reversed', 'PUT', () => `/schedule/patterns/${ids.rota}`, { valid_from: '2027-07-01' }],
  ['sp update anchor not a day', 'PUT', () => `/schedule/patterns/${ids.rota}`, { anchor_date: '2026-04-31' }],
  ['sp update name spaces', 'PUT', () => `/schedule/patterns/${ids.rota}`, { name: SPACES }],
  ['sp update foreign member', 'PUT', () => `/schedule/patterns/${ids.rota}`, { name: 'X' }, { actor: 'other' }],
  ['sp update missing', 'PUT', `/schedule/patterns/${MISSING}`, { name: 'X' }],
  ['sp update zero', 'PUT', '/schedule/patterns/0', { name: 'X' }],
  ['sp update no body', 'PUT', () => `/schedule/patterns/${ids.rota}`, NO_BODY],

  // ══ SCHEDULE: overrides ════════════════════════════════════════════════════
  ['so list empty', 'GET', '/schedule/overrides', NO_BODY],
  ['so put admin', 'PUT', '/schedule/overrides/2026-11-20', () => ({ user_id: MEMBER, shift_type_id: ids.frueh, note: ' Tausch ', field_values: { [ids.station]: '4A' } })],
  ['so put member own', 'PUT', '/schedule/overrides/2026-11-21', () => ({ user_id: MEMBER, shift_type_id: String(ids.spaet), note: null, field_values: {} }), { actor: 'member' }],
  ['so put member explicit free', 'PUT', '/schedule/overrides/2026-11-22', { shift_type_id: null, note: null, field_values: {} }, { actor: 'member' }],
  ['so put member explicit free no user', 'PUT', '/schedule/overrides/2026-11-23', { shift_type_id: null, note: null, field_values: {} }, { actor: 'other' }],
  ['so put member own text', 'PUT', '/schedule/overrides/2026-11-24', { user_id: String(MEMBER), shift_type_id: null, note: 'frei', field_values: {} }, { actor: 'member' }],
  ['so put member foreign', 'PUT', '/schedule/overrides/2026-11-24', { user_id: OTHER }, { actor: 'member' }],
  ['so put member foreign broken', 'PUT', '/schedule/overrides/2026-11-24', { user_id: OTHER, note: true }, { actor: 'member' }],
  ['so put member fraction', 'PUT', '/schedule/overrides/2026-11-24', { user_id: MEMBER + 0.5 }, { actor: 'member' }],
  ['so put admin user zero', 'PUT', '/schedule/overrides/2026-11-24', { user_id: 0, shift_type_id: null, note: null, field_values: {} }],
  ['so put admin user missing', 'PUT', '/schedule/overrides/2026-11-24', { user_id: MISSING, shift_type_id: null, note: null, field_values: {} }],
  ['so put admin guest', 'PUT', '/schedule/overrides/2026-11-24', { user_id: GUEST, shift_type_id: null, note: null, field_values: {} }],
  ['so put type gone', 'PUT', '/schedule/overrides/2026-11-24', { shift_type_id: MISSING, note: null, field_values: {} }],
  ['so put type zero', 'PUT', '/schedule/overrides/2026-11-24', { shift_type_id: 0, note: null, field_values: {} }],
  ['so put type text broken', 'PUT', '/schedule/overrides/2026-11-24', { shift_type_id: '7abc', note: null, field_values: {} }],
  ['so put not a day', 'PUT', '/schedule/overrides/2026-02-29', { shift_type_id: null, note: null, field_values: {} }],
  ['so put not a key', 'PUT', '/schedule/overrides/soon', { shift_type_id: null, note: null, field_values: {} }],
  ['so put note long', 'PUT', '/schedule/overrides/2026-11-24', { shift_type_id: null, note: LONG_TEXT(5001), field_values: {} }],
  ['so put field not attached', 'PUT', '/schedule/overrides/2026-11-24', () => ({ shift_type_id: ids.spaet, note: null, field_values: { [ids.station]: 'x' } })],
  ['so put field repeat', 'PUT', '/schedule/overrides/2026-11-24', () => ({ shift_type_id: ids.frueh, note: null, field_values: { [ids.station]: 'x', [`0${ids.station}`]: 'y' } })],
  ['so put field value spaces', 'PUT', '/schedule/overrides/2026-11-25', () => ({ shift_type_id: ids.frueh, note: null, field_values: { [ids.station]: SPACES } })],
  ['so list', 'GET', '/schedule/overrides', NO_BODY],
  ['so list user range', 'GET', `/schedule/overrides?user_id=${MEMBER}&from=2026-11-21&to=2026-11-23`, NO_BODY],
  ['so list reversed', 'GET', '/schedule/overrides?from=2026-11-23&to=2026-11-21', NO_BODY],
  ['so list not a day', 'GET', '/schedule/overrides?from=2026-02-30', NO_BODY],
  ['so list user zero', 'GET', '/schedule/overrides?user_id=0', NO_BODY],
  ['so list user missing', 'GET', `/schedule/overrides?user_id=${MISSING}`, NO_BODY],
  ['so fill', 'POST', '/schedule/overrides/fill', () => ({ user_id: MEMBER, from: '2026-12-01', to: '2026-12-03', shift_type_id: ids.frueh, note: 'Urlaub', field_values: { [ids.station]: '1' } })],
  ['so fill member own', 'POST', '/schedule/overrides/fill', { from: '2026-12-10', to: '2026-12-10' }, { actor: 'member' }],
  ['so fill member foreign', 'POST', '/schedule/overrides/fill', { user_id: OTHER, from: '2026-12-10', to: '2026-12-11' }, { actor: 'member' }],
  ['so fill reversed', 'POST', '/schedule/overrides/fill', { from: '2026-12-11', to: '2026-12-10' }],
  ['so fill long', 'POST', '/schedule/overrides/fill', { from: '2026-12-01', to: '2027-03-31' }],
  ['so fill not a day', 'POST', '/schedule/overrides/fill', { from: '2026-02-30', to: '2026-03-02' }],
  ['so fill missing to', 'POST', '/schedule/overrides/fill', { from: '2026-12-01' }],
  ['so fill type gone', 'POST', '/schedule/overrides/fill', { from: '2026-12-01', to: '2026-12-02', shift_type_id: MISSING }],
  ['so fill admin user zero', 'POST', '/schedule/overrides/fill', { user_id: 0, from: '2026-12-01', to: '2026-12-02' }],
  ['so fill admin guest', 'POST', '/schedule/overrides/fill', { user_id: GUEST, from: '2026-12-01', to: '2026-12-02' }],
  ['so fill admin user missing', 'POST', '/schedule/overrides/fill', { user_id: MISSING, from: '2026-12-01', to: '2026-12-02' }],
  ['so fill field without type', 'POST', '/schedule/overrides/fill', () => ({ from: '2026-12-01', to: '2026-12-02', field_values: { [ids.station]: 'x' } })],
  ['so delete one', 'DELETE', `/schedule/overrides/2026-11-22?user_id=${MEMBER}`, NO_BODY],
  ['so delete one again', 'DELETE', `/schedule/overrides/2026-11-22?user_id=${MEMBER}`, NO_BODY],
  ['so delete one member own', 'DELETE', '/schedule/overrides/2026-11-21', NO_BODY, { actor: 'member' }],
  ['so delete one member foreign', 'DELETE', `/schedule/overrides/2026-11-23?user_id=${OTHER}`, NO_BODY, { actor: 'member' }],
  ['so delete one member own text', 'DELETE', `/schedule/overrides/2026-11-24?user_id=${MEMBER}`, NO_BODY, { actor: 'member' }],
  ['so delete one admin user zero', 'DELETE', '/schedule/overrides/2026-11-24?user_id=0', NO_BODY],
  ['so delete one not a day', 'DELETE', '/schedule/overrides/2026-02-30', NO_BODY],
  ['so delete range', 'DELETE', `/schedule/overrides?user_id=${MEMBER}&from=2026-12-01&to=2026-12-02`, NO_BODY],
  ['so delete range member own', 'DELETE', '/schedule/overrides?from=2026-12-10&to=2026-12-10', NO_BODY, { actor: 'member' }],
  ['so delete range member foreign', 'DELETE', `/schedule/overrides?user_id=${OTHER}&from=2026-12-01&to=2026-12-02`, NO_BODY, { actor: 'member' }],
  ['so delete range reversed', 'DELETE', '/schedule/overrides?from=2026-12-02&to=2026-12-01', NO_BODY],
  ['so delete range long', 'DELETE', '/schedule/overrides?from=2026-01-01&to=2028-01-01', NO_BODY],
  ['so delete range not a day', 'DELETE', '/schedule/overrides?from=2026-02-30&to=2026-03-01', NO_BODY],
  ['so delete range admin user missing', 'DELETE', `/schedule/overrides?user_id=${MISSING}&from=2026-12-01&to=2026-12-02`, NO_BODY],
  ['so delete range admin user zero', 'DELETE', '/schedule/overrides?user_id=0&from=2026-12-01&to=2026-12-02', NO_BODY],
  ['so delete range missing to', 'DELETE', '/schedule/overrides?from=2026-12-01', NO_BODY],
  ['so list after', 'GET', '/schedule/overrides', NO_BODY],

  // ══ SCHEDULE: extras ═══════════════════════════════════════════════════════
  ['sx list empty', 'GET', '/schedule/extras', NO_BODY],
  ['sx create', 'POST', '/schedule/extras', () => ({ user_id: MEMBER, date_key: '2026-11-26', shift_type_id: ids.frueh, note: ' Bereitschaft ', reminder_offset_minutes: 30, field_values: { [ids.station]: '2C' } })],
  () => { ids.extra = lastId('schedule_extra_shifts'); },
  ['sx create member own', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-27', shift_type_id: String(ids.spaet), reminder_offset_minutes: null, note: '', field_values: {} }), { actor: 'member' }],
  ['sx create member foreign', 'POST', '/schedule/extras', () => ({ user_id: OTHER, date_key: '2026-11-27', shift_type_id: ids.spaet }), { actor: 'member' }],
  ['sx create member own text', 'POST', '/schedule/extras', () => ({ user_id: String(OTHER), date_key: '2026-11-28', shift_type_id: ids.spaet, reminder_offset_minutes: 1440 }), { actor: 'other' }],
  ['sx create offset zero', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-28', shift_type_id: ids.spaet, reminder_offset_minutes: 0 })],
  ['sx create offset negative', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-28', shift_type_id: ids.spaet, reminder_offset_minutes: -5 })],
  ['sx create offset above', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-28', shift_type_id: ids.spaet, reminder_offset_minutes: 1441 })],
  ['sx create offset fraction', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-28', shift_type_id: ids.spaet, reminder_offset_minutes: 2.5 })],
  ['sx create offset text', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-28', shift_type_id: ids.spaet, reminder_offset_minutes: '15' })],
  ['sx create offset empty', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-28', shift_type_id: ids.spaet, reminder_offset_minutes: '' })],
  ['sx create type missing', 'POST', '/schedule/extras', { date_key: '2026-11-28' }],
  ['sx create type null', 'POST', '/schedule/extras', { date_key: '2026-11-28', shift_type_id: null }],
  ['sx create type zero', 'POST', '/schedule/extras', { date_key: '2026-11-28', shift_type_id: 0 }],
  ['sx create type gone', 'POST', '/schedule/extras', { date_key: '2026-11-28', shift_type_id: MISSING }],
  ['sx create not a day', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-31', shift_type_id: ids.spaet })],
  ['sx create no day', 'POST', '/schedule/extras', () => ({ shift_type_id: ids.spaet })],
  ['sx create admin guest', 'POST', '/schedule/extras', () => ({ user_id: GUEST, date_key: '2026-11-28', shift_type_id: ids.spaet })],
  ['sx create admin user zero', 'POST', '/schedule/extras', () => ({ user_id: 0, date_key: '2026-11-28', shift_type_id: ids.spaet })],
  ['sx create admin user missing', 'POST', '/schedule/extras', () => ({ user_id: MISSING, date_key: '2026-11-28', shift_type_id: ids.spaet })],
  ['sx create field not attached', 'POST', '/schedule/extras', () => ({ date_key: '2026-11-28', shift_type_id: ids.spaet, field_values: { [ids.raum]: 'x' } })],
  ['sx fill', 'POST', '/schedule/extras/fill', () => ({ user_id: MEMBER, from: '2026-12-05', to: '2026-12-06', shift_type_id: ids.frueh, reminder_offset_minutes: 60, field_values: { [ids.raum]: 'R1' } })],
  ['sx fill member own', 'POST', '/schedule/extras/fill', () => ({ from: '2026-12-07', to: '2026-12-07', shift_type_id: ids.spaet }), { actor: 'member' }],
  ['sx fill member foreign', 'POST', '/schedule/extras/fill', () => ({ user_id: OTHER, from: '2026-12-07', to: '2026-12-07', shift_type_id: ids.spaet }), { actor: 'member' }],
  ['sx fill reversed', 'POST', '/schedule/extras/fill', () => ({ from: '2026-12-07', to: '2026-12-06', shift_type_id: ids.spaet })],
  ['sx fill long', 'POST', '/schedule/extras/fill', () => ({ from: '2026-12-01', to: '2027-03-31', shift_type_id: ids.spaet })],
  ['sx fill offset above', 'POST', '/schedule/extras/fill', () => ({ from: '2026-12-07', to: '2026-12-07', shift_type_id: ids.spaet, reminder_offset_minutes: 1441 })],
  ['sx fill offset text', 'POST', '/schedule/extras/fill', () => ({ from: '2026-12-07', to: '2026-12-07', shift_type_id: ids.spaet, reminder_offset_minutes: '5' })],
  ['sx fill type missing', 'POST', '/schedule/extras/fill', { from: '2026-12-07', to: '2026-12-07' }],
  ['sx fill type zero', 'POST', '/schedule/extras/fill', { from: '2026-12-07', to: '2026-12-07', shift_type_id: 0 }],
  ['sx fill type gone', 'POST', '/schedule/extras/fill', { from: '2026-12-07', to: '2026-12-07', shift_type_id: MISSING }],
  ['sx fill admin guest', 'POST', '/schedule/extras/fill', () => ({ user_id: GUEST, from: '2026-12-07', to: '2026-12-07', shift_type_id: ids.spaet })],
  ['sx fill not a day', 'POST', '/schedule/extras/fill', () => ({ from: '2026-11-31', to: '2026-12-07', shift_type_id: ids.spaet })],
  ['sx list', 'GET', '/schedule/extras', NO_BODY],
  ['sx list user range', 'GET', `/schedule/extras?user_id=${MEMBER}&from=2026-11-26&to=2026-12-05`, NO_BODY],
  ['sx list reversed', 'GET', '/schedule/extras?from=2026-12-05&to=2026-11-26', NO_BODY],
  ['sx list user zero', 'GET', '/schedule/extras?user_id=0', NO_BODY],
  ['sx list user missing', 'GET', `/schedule/extras?user_id=${MISSING}`, NO_BODY],
  ['sx update', 'PUT', () => `/schedule/extras/${ids.extra}`, () => ({ date_key: '2026-11-29', note: 'Neu', reminder_offset_minutes: null, user_id: OTHER })],
  ['sx update member', 'PUT', () => `/schedule/extras/${ids.extra}`, { reminder_offset_minutes: 45 }, { actor: 'member' }],
  ['sx update type', 'PUT', () => `/schedule/extras/${ids.extra}`, () => ({ shift_type_id: ids.spaet, field_values: {} })],
  ['sx update type zero', 'PUT', () => `/schedule/extras/${ids.extra}`, { shift_type_id: 0 }],
  ['sx update type null', 'PUT', () => `/schedule/extras/${ids.extra}`, { shift_type_id: null }],
  ['sx update type gone', 'PUT', () => `/schedule/extras/${ids.extra}`, { shift_type_id: MISSING }],
  ['sx update offset above', 'PUT', () => `/schedule/extras/${ids.extra}`, { reminder_offset_minutes: 1441 }],
  ['sx update offset negative', 'PUT', () => `/schedule/extras/${ids.extra}`, { reminder_offset_minutes: -1 }],
  ['sx update offset text', 'PUT', () => `/schedule/extras/${ids.extra}`, { reminder_offset_minutes: '10' }],
  ['sx update not a day', 'PUT', () => `/schedule/extras/${ids.extra}`, { date_key: '2026-09-31' }],
  ['sx update field not attached', 'PUT', () => `/schedule/extras/${ids.extra}`, () => ({ field_values: { [ids.station]: 'x' } })],
  ['sx update foreign member', 'PUT', () => `/schedule/extras/${ids.extra}`, { note: 'X' }, { actor: 'other' }],
  ['sx update missing', 'PUT', `/schedule/extras/${MISSING}`, { note: 'X' }],
  ['sx update zero', 'PUT', '/schedule/extras/0', { note: 'X' }],
  ['sx update no body', 'PUT', () => `/schedule/extras/${ids.extra}`, NO_BODY],

  // ══ SCHEDULE: entries ══════════════════════════════════════════════════════
  ['se entries', 'GET', '/schedule/entries?from=2026-11-16&to=2026-12-07', NO_BODY],
  ['se entries user', 'GET', `/schedule/entries?from=2026-11-20&to=2026-11-29&user_id=${MEMBER}`, NO_BODY],
  ['se entries member', 'GET', '/schedule/entries?from=2026-11-20&to=2026-11-22', NO_BODY, { actor: 'member' }],
  ['se entries reversed', 'GET', '/schedule/entries?from=2026-11-29&to=2026-11-20', NO_BODY],
  ['se entries long', 'GET', '/schedule/entries?from=2026-01-01&to=2028-01-02', NO_BODY],
  ['se entries 731', 'GET', `/schedule/entries?from=2026-01-01&to=2028-01-01&user_id=${GUEST}`, NO_BODY, { actor: 'other' }],
  ['se entries not a day', 'GET', '/schedule/entries?from=2026-02-30&to=2026-03-02', NO_BODY],
  ['se entries no to', 'GET', '/schedule/entries?from=2026-11-20', NO_BODY],
  ['se entries user zero', 'GET', '/schedule/entries?from=2026-11-20&to=2026-11-22&user_id=0', NO_BODY],
  ['se entries user missing', 'GET', `/schedule/entries?from=2026-11-20&to=2026-11-22&user_id=${MISSING}`, NO_BODY],

  // ══ SCHEDULE: feed and preferences ═════════════════════════════════════════
  ['sf get none', 'GET', '/schedule/feed', NO_BODY],
  ['sf regenerate', 'POST', '/schedule/feed/regenerate', {}],
  ['sf get', 'GET', '/schedule/feed', NO_BODY],
  ['sf delete', 'DELETE', '/schedule/feed', NO_BODY],
  ['sf get after', 'GET', '/schedule/feed', NO_BODY],
  ['spref get', 'GET', '/schedule/preferences', NO_BODY],
  ['spref put', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: 30, weeklyHours: 38, overtimeEnabled: false }],
  ['spref put partial', 'PUT', '/schedule/preferences', { weeklyHours: 168 }],
  ['spref put member', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: 0, weeklyHours: 1 }, { actor: 'member' }],
  ['spref put nulls', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: null, weeklyHours: null, overtimeEnabled: true }, { actor: 'member' }],
  ['spref put offset above', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: 1441 }],
  ['spref put offset negative', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: -1 }],
  ['spref put offset fraction', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: 1.5 }],
  ['spref put offset text', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: '15' }],
  ['spref put offset empty', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: '' }],
  ['spref put offset false', 'PUT', '/schedule/preferences', { reminderOffsetMinutes: false }],
  ['spref put hours zero', 'PUT', '/schedule/preferences', { weeklyHours: 0 }],
  ['spref put hours above', 'PUT', '/schedule/preferences', { weeklyHours: 169 }],
  ['spref put hours list', 'PUT', '/schedule/preferences', { weeklyHours: [40] }],
  ['spref put hours text', 'PUT', '/schedule/preferences', { weeklyHours: '40' }],
  ['spref put overtime text', 'PUT', '/schedule/preferences', { overtimeEnabled: 'false' }],
  ['spref put overtime number', 'PUT', '/schedule/preferences', { overtimeEnabled: 0 }],
  ['spref put overtime null', 'PUT', '/schedule/preferences', { overtimeEnabled: null }],
  ['spref put empty', 'PUT', '/schedule/preferences', {}],
  ['spref put no body', 'PUT', '/schedule/preferences', NO_BODY],
  ['spref get after', 'GET', '/schedule/preferences', NO_BODY],
  ['spref get member', 'GET', '/schedule/preferences', NO_BODY, { actor: 'member' }],

  // ══ SCHEDULE: deletes at the end ═══════════════════════════════════════════
  ['sx delete foreign member', 'DELETE', () => `/schedule/extras/${ids.extra}`, NO_BODY, { actor: 'other' }],
  ['sx delete', 'DELETE', () => `/schedule/extras/${ids.extra}`, NO_BODY],
  ['sx delete again', 'DELETE', () => `/schedule/extras/${ids.extra}`, NO_BODY],
  ['sx delete zero', 'DELETE', '/schedule/extras/0', NO_BODY],
  ['sp delete foreign member', 'DELETE', () => `/schedule/patterns/${ids.rota}`, NO_BODY, { actor: 'other' }],
  ['sp delete member', 'DELETE', () => `/schedule/patterns/${ids.rota}`, NO_BODY, { actor: 'member' }],
  ['sp delete again', 'DELETE', () => `/schedule/patterns/${ids.rota}`, NO_BODY],
  ['sp delete zero', 'DELETE', '/schedule/patterns/0', NO_BODY],
  ['sc type delete in use', 'DELETE', () => `/schedule/shift-types/${ids.frueh}`, NO_BODY],
  ['sc type delete foreign member', 'DELETE', () => `/schedule/shift-types/${ids.frueh}`, NO_BODY, { actor: 'member' }],
  ['sc type create spare', 'POST', '/schedule/shift-types', { name: 'Frei' }, { actor: 'other' }],
  ['sc type delete', 'DELETE', () => `/schedule/shift-types/${shiftTypeId('Frei')}`, NO_BODY, { actor: 'other' }],
  ['sc type delete again', 'DELETE', `/schedule/shift-types/${MISSING}`, NO_BODY],
  ['sc type delete zero', 'DELETE', '/schedule/shift-types/0', NO_BODY],
  ['sc field delete foreign member', 'DELETE', () => `/schedule/custom-fields/${ids.station}`, NO_BODY, { actor: 'member' }],
  ['sc field delete', 'DELETE', () => `/schedule/custom-fields/${ids.station}`, NO_BODY],
  ['sc field delete again', 'DELETE', () => `/schedule/custom-fields/${ids.station}`, NO_BODY],
  ['sc field delete zero', 'DELETE', '/schedule/custom-fields/0', NO_BODY],
  ['sc types end', 'GET', '/schedule/shift-types', NO_BODY],
];

// Written at 6a703e29f, before the refactor.
/** @type {Record<string, { status: number, body: unknown }>} */
const EXPECTED = {
  "wt list empty": {"status":200,"body":{"data":[]}},
  "wt create": {"status":201,"body":{"data":{"id":1,"name":"Bio","icon":"leaf","color":"#22C55E","archived":0,"sort_order":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wt create second": {"status":201,"body":{"data":{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":0,"sort_order":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wt create spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "wt create no name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "wt create long name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"maxLength"}]}},
  "wt create color empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"pattern"}]}},
  "wt create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "wt create duplicate": {"status":201,"body":{"data":{"id":3,"name":"bio","icon":"trash-2","color":"#22C55E","archived":0,"sort_order":2,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wt get": {"status":200,"body":{"data":{"id":1,"name":"Bio","icon":"leaf","color":"#22C55E","archived":0,"sort_order":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wt get missing": {"status":404,"body":{"error":"Waste type not found.","code":404,"reason":"waste_type_not_found"}},
  "wt get zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wt get negative": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wt get letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "wt update": {"status":200,"body":{"data":{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":0,"sort_order":3,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wt update archive": {"status":200,"body":{"data":{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":1,"sort_order":3,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wt list archived 1": {"status":200,"body":{"data":[{"id":1,"name":"Bio","icon":"leaf","color":"#22C55E","archived":0,"sort_order":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"name":"bio","icon":"trash-2","color":"#22C55E","archived":0,"sort_order":2,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":1,"sort_order":3,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "wt list archived true": {"status":200,"body":{"data":[{"id":1,"name":"Bio","icon":"leaf","color":"#22C55E","archived":0,"sort_order":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"name":"bio","icon":"trash-2","color":"#22C55E","archived":0,"sort_order":2,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":1,"sort_order":3,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "wt list archived 0": {"status":200,"body":{"data":[{"id":1,"name":"Bio","icon":"leaf","color":"#22C55E","archived":0,"sort_order":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"name":"bio","icon":"trash-2","color":"#22C55E","archived":0,"sort_order":2,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "wt list archived yes": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/include_archived","rule":"enum"}]}},
  "wt update unarchive": {"status":200,"body":{"data":{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":0,"sort_order":3,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wt update spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "wt update archived text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/archived","rule":"type"}]}},
  "wt update missing": {"status":404,"body":{"error":"Waste type not found.","code":404,"reason":"waste_type_not_found"}},
  "wt update zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wt update member": {"status":200,"body":{"data":{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":0,"sort_order":3,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws list empty": {"status":200,"body":{"data":[]}},
  "ws create weekly": {"status":201,"body":{"data":{"id":1,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-02","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws create monthly fixed": {"status":201,"body":{"data":{"id":2,"type_id":2,"recurrence_kind":"monthly_fixed_day","anchor_date":"2026-11-15","interval":1,"weekdays":null,"month_day":15,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws create ordinal": {"status":201,"body":{"data":{"id":3,"type_id":2,"recurrence_kind":"monthly_ordinal_weekday","anchor_date":"2026-11-10","interval":1,"weekdays":"TU","month_day":2,"valid_until":"2027-06-30","active":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws create kind unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/recurrence_kind","rule":"enum"}]}},
  "ws create anchor not a day": {"status":400,"body":{"error":"anchor_date must be a valid YYYY-MM-DD date.","code":400,"reason":"waste_schedule_anchor_date_invalid"}},
  "ws create interval zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_schedule_interval_invalid","fields":[{"path":"body/interval","rule":"minimum","reason":"waste_schedule_interval_invalid"}]}},
  "ws create interval large": {"status":400,"body":{"error":"interval must be an integer between 1 and 52 for a weekly schedule.","code":400,"reason":"waste_schedule_interval_invalid"}},
  "ws create interval text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/interval","rule":"type"}]}},
  "ws create weekdays empty": {"status":400,"body":{"error":"weekdays must be a non-empty list of: MO, TU, WE, TH, FR, SA, SU.","code":400,"reason":"waste_schedule_weekdays_required"}},
  "ws create weekday unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/weekdays/0","rule":"enum"},{"path":"body/weekdays","rule":"type"},{"path":"body/weekdays","rule":"enum"},{"path":"body/weekdays","rule":"anyOf"}]}},
  "ws create weekdays comma text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/weekdays","rule":"type"},{"path":"body/weekdays","rule":"enum"},{"path":"body/weekdays","rule":"anyOf"}]}},
  "ws create anchor not weekday": {"status":201,"body":{"data":{"id":4,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-03","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws create type missing": {"status":400,"body":{"error":"type_id must reference an existing waste type.","code":400,"reason":"waste_selected_type_not_found"}},
  "ws create type zero": {"status":400,"body":{"error":"type_id must reference an existing waste type.","code":400,"reason":"waste_selected_type_not_found"}},
  "ws create type true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type_id","rule":"type"},{"path":"body/type_id","rule":"anyOf"}]}},
  "ws create type digit text": {"status":201,"body":{"data":{"id":5,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-09","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws create fixed day 31 in feb": {"status":400,"body":{"error":"month_day must be -1 (last day of month) or an integer between 1 and 31.","code":400,"reason":"waste_schedule_month_day_invalid"}},
  "ws create ordinal 5": {"status":400,"body":{"error":"month_day must be one of -1, 1, 2, 3, 4 (the ordinal position: -1 for last, 1-4 for nth) for an ordinal-weekday schedule.","code":400}},
  "ws create until before anchor": {"status":400,"body":{"error":"valid_until must not be before anchor_date.","code":400,"reason":"waste_schedule_ends_before_anchor"}},
  "ws list": {"status":200,"body":{"data":[{"id":1,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-02","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"type_id":2,"recurrence_kind":"monthly_fixed_day","anchor_date":"2026-11-15","interval":1,"weekdays":null,"month_day":15,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"type_id":2,"recurrence_kind":"monthly_ordinal_weekday","anchor_date":"2026-11-10","interval":1,"weekdays":"TU","month_day":2,"valid_until":"2027-06-30","active":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-03","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":5,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-09","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "ws list type": {"status":200,"body":{"data":[{"id":2,"type_id":2,"recurrence_kind":"monthly_fixed_day","anchor_date":"2026-11-15","interval":1,"weekdays":null,"month_day":15,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"type_id":2,"recurrence_kind":"monthly_ordinal_weekday","anchor_date":"2026-11-10","interval":1,"weekdays":"TU","month_day":2,"valid_until":"2027-06-30","active":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "ws list inactive 0": {"status":200,"body":{"data":[{"id":1,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-02","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"type_id":2,"recurrence_kind":"monthly_fixed_day","anchor_date":"2026-11-15","interval":1,"weekdays":null,"month_day":15,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-03","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":5,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-09","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "ws list type letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/type_id","rule":"type"}]}},
  "ws get": {"status":200,"body":{"data":{"id":1,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-02","interval":1,"weekdays":"MO","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws get missing": {"status":404,"body":{"error":"Waste schedule not found.","code":404,"reason":"waste_schedule_not_found"}},
  "ws get zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "ws update": {"status":200,"body":{"data":{"id":1,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-02","interval":1,"weekdays":"MO,TH","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws update interval large": {"status":400,"body":{"error":"interval must be an integer between 1 and 52 for a weekly schedule.","code":400,"reason":"waste_schedule_interval_invalid"}},
  "ws update active text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/active","rule":"type"}]}},
  "ws update missing": {"status":404,"body":{"error":"Waste schedule not found.","code":404,"reason":"waste_schedule_not_found"}},
  "ws update zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "ws override move": {"status":200,"body":{"data":{"id":1,"schedule_id":1,"original_date":"2026-11-23","replacement_date":"2026-11-24","note":" Feiertag ","created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws override skip": {"status":200,"body":{"data":{"id":2,"schedule_id":1,"original_date":"2026-11-30","replacement_date":null,"note":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws override explicit skip": {"status":200,"body":{"data":{"id":3,"schedule_id":1,"original_date":"2026-12-07","replacement_date":null,"note":null,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws override not calculated": {"status":400,"body":{"error":"original_date is not a calculated occurrence of this schedule.","code":400,"reason":"waste_occurrence_not_found"}},
  "ws override not a day": {"status":400,"body":{"error":"original_date must be a valid YYYY-MM-DD date.","code":400}},
  "ws override replacement empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_override_date_invalid","fields":[{"path":"body/replacement_date","rule":"pattern","reason":"waste_override_date_invalid"}]}},
  "ws override note true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/note","rule":"type"}]}},
  "ws override missing": {"status":404,"body":{"error":"Waste schedule not found.","code":404,"reason":"waste_schedule_not_found"}},
  "ws override zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "ws get with overrides": {"status":200,"body":{"data":{"id":1,"type_id":1,"recurrence_kind":"weekly","anchor_date":"2026-11-02","interval":1,"weekdays":"MO,TH","month_day":null,"valid_until":null,"active":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "ws override delete": {"status":204,"body":null},
  "ws override delete again": {"status":404,"body":{"error":"Override not found.","code":404,"reason":"waste_override_not_found"}},
  "ws override delete not a key": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/originalDate","rule":"pattern"}]}},
  "ws override delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wp list empty": {"status":200,"body":{"data":[]}},
  "wp create": {"status":201,"body":{"data":{"id":1,"type_id":1,"date":"2026-12-02","note":"Sperrmuell","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wp create not a day": {"status":400,"body":{"error":"date must be a valid YYYY-MM-DD date.","code":400,"reason":"waste_pickup_date_invalid"}},
  "wp create no date": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_pickup_date_invalid","fields":[{"path":"body/date","rule":"required","reason":"waste_pickup_date_invalid"}]}},
  "wp create type missing": {"status":400,"body":{"error":"type_id must reference an existing waste type.","code":400,"reason":"waste_selected_type_not_found"}},
  "wp create type zero": {"status":400,"body":{"error":"type_id must reference an existing waste type.","code":400,"reason":"waste_selected_type_not_found"}},
  "wp create note long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/note","rule":"maxLength"}]}},
  "wp create note spaces": {"status":201,"body":{"data":{"id":2,"type_id":2,"date":"2026-12-04","note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wp list": {"status":200,"body":{"data":[{"id":1,"type_id":1,"date":"2026-12-02","note":"Sperrmuell","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"type_id":2,"date":"2026-12-04","note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "wp list type": {"status":200,"body":{"data":[{"id":2,"type_id":2,"date":"2026-12-04","note":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "wp get": {"status":200,"body":{"data":{"id":1,"type_id":1,"date":"2026-12-02","note":"Sperrmuell","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wp get missing": {"status":404,"body":{"error":"One-off pickup not found.","code":404,"reason":"waste_pickup_not_found"}},
  "wp get zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wp update": {"status":200,"body":{"data":{"id":1,"type_id":1,"date":"2026-12-09","note":"Sperrmuell","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wp update not a day": {"status":400,"body":{"error":"date must be a valid YYYY-MM-DD date.","code":400,"reason":"waste_pickup_date_invalid"}},
  "wp update missing": {"status":404,"body":{"error":"One-off pickup not found.","code":404,"reason":"waste_pickup_not_found"}},
  "wp update zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wo next": {"status":200,"body":{"data":[{"type":{"id":1,"name":"Bio","icon":"leaf","color":"#22C55E","archived":0,"sort_order":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},"next":{"key":"1:2026-11-19","date_key":"2026-11-19","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":false,"origins":[{"kind":"schedule","schedule_id":1,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-11-19"}},{"type":{"id":3,"name":"bio","icon":"trash-2","color":"#22C55E","archived":0,"sort_order":2,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},"next":null},{"type":{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":0,"sort_order":3,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},"next":{"key":"2:2026-12-04","date_key":"2026-12-04","type_id":2,"type_name":"Papier","type_icon":"trash-2","type_color":"#3B82F6","type_sort_order":3,"moved":false,"coalesced":false,"origins":[{"kind":"one_off","one_off_id":2,"original_date":null,"moved":false}],"deep_link":"?type=2&date=2026-12-04"}}]}},
  "wo range": {"status":200,"body":{"data":[{"key":"1:2026-11-16","date_key":"2026-11-16","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":true,"origins":[{"kind":"schedule","schedule_id":1,"original_date":null,"moved":false},{"kind":"schedule","schedule_id":4,"original_date":null,"moved":false},{"kind":"schedule","schedule_id":5,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-11-16"},{"key":"1:2026-11-19","date_key":"2026-11-19","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":false,"origins":[{"kind":"schedule","schedule_id":1,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-11-19"},{"key":"1:2026-11-23","date_key":"2026-11-23","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":true,"origins":[{"kind":"schedule","schedule_id":4,"original_date":null,"moved":false},{"kind":"schedule","schedule_id":5,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-11-23"},{"key":"1:2026-11-24","date_key":"2026-11-24","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":true,"coalesced":false,"origins":[{"kind":"schedule","schedule_id":1,"original_date":"2026-11-23","moved":true}],"deep_link":"?type=1&date=2026-11-24"},{"key":"1:2026-11-26","date_key":"2026-11-26","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":false,"origins":[{"kind":"schedule","schedule_id":1,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-11-26"},{"key":"1:2026-11-30","date_key":"2026-11-30","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":true,"origins":[{"kind":"schedule","schedule_id":1,"original_date":null,"moved":false},{"kind":"schedule","schedule_id":4,"original_date":null,"moved":false},{"kind":"schedule","schedule_id":5,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-11-30"},{"key":"1:2026-12-03","date_key":"2026-12-03","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":false,"origins":[{"kind":"schedule","schedule_id":1,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-12-03"},{"key":"2:2026-12-04","date_key":"2026-12-04","type_id":2,"type_name":"Papier","type_icon":"trash-2","type_color":"#3B82F6","type_sort_order":3,"moved":false,"coalesced":false,"origins":[{"kind":"one_off","one_off_id":2,"original_date":null,"moved":false}],"deep_link":"?type=2&date=2026-12-04"},{"key":"1:2026-12-07","date_key":"2026-12-07","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":true,"origins":[{"kind":"schedule","schedule_id":4,"original_date":null,"moved":false},{"kind":"schedule","schedule_id":5,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-12-07"},{"key":"1:2026-12-09","date_key":"2026-12-09","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":false,"origins":[{"kind":"one_off","one_off_id":1,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-12-09"},{"key":"1:2026-12-10","date_key":"2026-12-10","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":false,"origins":[{"kind":"schedule","schedule_id":1,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-12-10"},{"key":"1:2026-12-14","date_key":"2026-12-14","type_id":1,"type_name":"Bio","type_icon":"leaf","type_color":"#22C55E","type_sort_order":0,"moved":false,"coalesced":true,"origins":[{"kind":"schedule","schedule_id":1,"original_date":null,"moved":false},{"kind":"schedule","schedule_id":4,"original_date":null,"moved":false},{"kind":"schedule","schedule_id":5,"original_date":null,"moved":false}],"deep_link":"?type=1&date=2026-12-14"},{"key":"2:2026-12-15","date_key":"2026-12-15","type_id":2,"type_name":"Papier","type_icon":"trash-2","type_color":"#3B82F6","type_sort_order":3,"moved":false,"coalesced":false,"origins":[{"kind":"schedule","schedule_id":2,"original_date":null,"moved":false}],"deep_link":"?type=2&date=2026-12-15"}]}},
  "wo range reversed": {"status":400,"body":{"error":"to must not be before from.","code":400}},
  "wo range not a day": {"status":400,"body":{"error":"from must be a valid YYYY-MM-DD date.","code":400}},
  "wo range long": {"status":400,"body":{"error":"Range must not exceed 731 days.","code":400}},
  "wo range no from": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/from","rule":"required"}]}},
  "wi preview": {"status":200,"body":{"data":{"digest":"04c87b786623da016ca76b1104b22e71207ba77043145bfa1831a895099d25c1","coverage":{"start":"2026-12-01","end":"2026-12-01"},"counts":{"events":1,"candidates":1,"distinct_labels":1},"diagnostics":[],"labels":[{"normalized_label":"restmuell","original_label":"Restmuell","count":1,"sample_summary":"Restmuell","suggested_type_id":null,"remembered_type_ids":[],"remembered_type_id":null,"remembered_ignored":false}],"candidates":[{"identity_key":"uid:Restmuell-2026-12-01@x::2026-12-01","external_uid":"Restmuell-2026-12-01@x","original_summary":"Restmuell","label":"Restmuell","normalized_label":"restmuell","date_key":"2026-12-01","tz_note":"all-day"}],"source_id":null,"expected_version":null}}},
  "wi preview no ics": {"status":400,"body":{"error":"An ICS file is required.","code":400,"reason":"waste_import_empty_file"}},
  "wi preview spaces": {"status":400,"body":{"error":"An ICS file is required.","code":400,"reason":"waste_import_empty_file"}},
  "wi preview too large": {"status":400,"body":{"error":"The file exceeds the 5 MB upload limit.","code":400,"reason":"waste_import_file_too_large","params":{"limit_mb":5}}},
  "wi preview no events": {"status":400,"body":{"error":"The file contains no calendar entries.","code":400,"reason":"waste_import_no_events"}},
  "wi commit name spaces": {"status":400,"body":{"error":"name is required.","code":400}},
  "wi commit no ics": {"status":400,"body":{"error":"An ICS file is required.","code":400,"reason":"waste_import_empty_file"}},
  "wi commit unmapped": {"status":400,"body":{"error":"No mapping decision was given for label \"Restmuell\".","code":400}},
  "wi commit digest stale": {"status":409,"body":{"error":"The calendar content changed since you last previewed it; preview again before committing.","code":409,"reason":"preview_changed"}},
  "wi commit": {"status":201,"body":{"data":{"source":{"id":1,"kind":"file","name":"Kalender","content_hash":"9a468ee332b8b67d8008e0e1262546cb73ae84c79ff99fedb246b747a26c07bb","version":1,"coverage_start":"2026-12-01","coverage_end":"2026-12-01","last_import_at":"<volatile>","last_success_at":"<volatile>","last_error":null,"url":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":false},"diff":{"added":1,"changed":0,"removed":0,"coalesced":0}}}},
  "wq list": {"status":200,"body":{"data":[{"id":1,"kind":"file","name":"Kalender","content_hash":"9a468ee332b8b67d8008e0e1262546cb73ae84c79ff99fedb246b747a26c07bb","version":1,"coverage_start":"2026-12-01","coverage_end":"2026-12-01","last_import_at":"<volatile>","last_success_at":"<volatile>","last_error":null,"url":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":false}]}},
  "wq get": {"status":200,"body":{"data":{"id":1,"kind":"file","name":"Kalender","content_hash":"9a468ee332b8b67d8008e0e1262546cb73ae84c79ff99fedb246b747a26c07bb","version":1,"coverage_start":"2026-12-01","coverage_end":"2026-12-01","last_import_at":"<volatile>","last_success_at":"<volatile>","last_error":null,"url":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":false,"mappings":[{"id":1,"source_id":1,"original_label":"Restmuell","normalized_label":"restmuell","created_at":"<volatile>","updated_at":"<volatile>","type_ids":[1],"type_id":1,"ignored":false}]}}},
  "wq get missing": {"status":404,"body":{"error":"Waste import source not found.","code":404,"reason":"waste_source_not_found"}},
  "wq get zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq rename": {"status":200,"body":{"data":{"id":1,"kind":"file","name":"Kalender 2026","content_hash":"9a468ee332b8b67d8008e0e1262546cb73ae84c79ff99fedb246b747a26c07bb","version":1,"coverage_start":"2026-12-01","coverage_end":"2026-12-01","last_import_at":"<volatile>","last_success_at":"<volatile>","last_error":null,"url":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":false}}},
  "wq rename spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "wq rename missing": {"status":404,"body":{"error":"Waste import source not found.","code":404,"reason":"waste_source_not_found"}},
  "wq rename zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq mapping": {"status":200,"body":{"data":{"id":1,"source_id":1,"original_label":"Restmuell","normalized_label":"restmuell","created_at":"<volatile>","updated_at":"<volatile>","type_ids":[1,2],"type_id":1,"ignored":false}}},
  "wq mapping ignored": {"status":200,"body":{"data":{"id":1,"source_id":1,"original_label":"Restmuell","normalized_label":"restmuell","created_at":"<volatile>","updated_at":"<volatile>","type_ids":[],"type_id":null,"ignored":true}}},
  "wq mapping both": {"status":400,"body":{"error":"A mapping is either ignored or has types, not both.","code":400}},
  "wq mapping type missing": {"status":400,"body":{"error":"type_ids must reference existing waste types.","code":400,"reason":"waste_selected_type_not_found"}},
  "wq mapping back": {"status":200,"body":{"data":{"id":1,"source_id":1,"original_label":"Restmuell","normalized_label":"restmuell","created_at":"<volatile>","updated_at":"<volatile>","type_ids":[1],"type_id":1,"ignored":false}}},
  "wq mapping missing": {"status":404,"body":{"error":"Mapping not found.","code":404,"reason":"waste_mapping_not_found"}},
  "wq mapping zero": {"status":400,"body":{"error":"mappingId must be a positive number.","code":400}},
  "wq mapping source zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq export": {"status":200,"body":{"data":{"version":1,"source_name":"Kalender 2026","mappings":[{"pattern":"restmuell","type_name":"Bio"}]}}},
  "wq export missing": {"status":404,"body":{"error":"Waste import source not found.","code":404,"reason":"waste_source_not_found"}},
  "wq export zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq profile preview": {"status":200,"body":{"data":{"source_id":1,"entries":[{"pattern":"restmuell","type_name":"Papier","mapping_id":1,"original_label":"Restmuell","resolved_type_id":2,"status":"applicable"}],"applicable_count":1,"profile_digest":"fc18b51599fa0e8d13330362b7323367bfa3f882fef33cdce9b207fa0e941243"}}},
  "wq profile preview empty": {"status":200,"body":{"data":{"source_id":1,"entries":[],"applicable_count":0,"profile_digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"}}},
  "wq profile preview missing": {"status":404,"body":{"error":"Waste import source not found.","code":404,"reason":"waste_source_not_found"}},
  "wq profile preview zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq profile commit stale": {"status":409,"body":{"error":"The mapping profile changed since it was last previewed; preview it again before committing.","code":409,"reason":"waste_profile_changed"}},
  "wq profile commit zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq reimport preview": {"status":200,"body":{"data":{"digest":"4e675a16110c16831e9fcd4514b855f16af832b2e17a10c199045c86056d39ca","coverage":{"start":"2026-12-08","end":"2026-12-08"},"counts":{"events":1,"candidates":1,"distinct_labels":1},"diagnostics":[],"labels":[{"normalized_label":"restmuell","original_label":"Restmuell","count":1,"sample_summary":"Restmuell","suggested_type_id":null,"remembered_type_ids":[1],"remembered_type_id":1,"remembered_ignored":false}],"candidates":[{"identity_key":"uid:Restmuell-2026-12-08@x::2026-12-08","external_uid":"Restmuell-2026-12-08@x","original_summary":"Restmuell","label":"Restmuell","normalized_label":"restmuell","date_key":"2026-12-08","tz_note":"all-day"}],"source_id":1,"expected_version":1}}},
  "wq reimport preview no ics": {"status":400,"body":{"error":"An ICS file is required.","code":400,"reason":"waste_import_empty_file"}},
  "wq reimport preview too large": {"status":400,"body":{"error":"The file exceeds the 5 MB upload limit.","code":400,"reason":"waste_import_file_too_large","params":{"limit_mb":5}}},
  "wq reimport preview no events": {"status":400,"body":{"error":"The file contains no calendar entries.","code":400,"reason":"waste_import_no_events"}},
  "wq reimport preview missing": {"status":404,"body":{"error":"Waste import source not found.","code":404,"reason":"waste_source_not_found"}},
  "wq reimport preview zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq reimport commit stale version": {"status":409,"body":{"error":"This source changed since you last previewed it; preview again before committing.","code":409,"reason":"source_changed"}},
  "wq reimport commit": {"status":200,"body":{"data":{"source":{"id":1,"kind":"file","name":"Kalender 2026","content_hash":"b4e20a6ed12c6d38c25c301e54ed84ac1eac05d0f244915f235a480578ac315f","version":2,"coverage_start":"2026-12-08","coverage_end":"2026-12-08","last_import_at":"<volatile>","last_success_at":"<volatile>","last_error":null,"url":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":false},"diff":{"added":1,"changed":0,"removed":1,"coalesced":0}}}},
  "wq reimport commit zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq refresh file": {"status":400,"body":{"error":"Manual refresh only applies to URL sources; use re-import for file sources.","code":400,"reason":"waste_source_not_url"}},
  "wq refresh missing": {"status":404,"body":{"error":"Waste import source not found.","code":404,"reason":"waste_source_not_found"}},
  "wq refresh zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq url create": {"status":201,"body":{"data":{"source":{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"last_error":null,"url":"<feed>/cal.ics","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":true},"outcome":"needs_mapping","preview":{"digest":"17b295d57422230f50e65116ad26d6cfef8f7db75929e9f7b0490b3f01c2e604","coverage":{"start":"2026-12-07","end":"2026-12-07"},"counts":{"events":1,"candidates":1,"distinct_labels":1},"diagnostics":[],"labels":[{"normalized_label":"gelbe tonne","original_label":"Gelbe Tonne","count":1,"sample_summary":"Gelbe Tonne","suggested_type_id":null,"remembered_type_ids":[],"remembered_type_id":null,"remembered_ignored":false}],"candidates":[{"identity_key":"uid:Gelbe Tonne-2026-12-07@x::2026-12-07","external_uid":"Gelbe Tonne-2026-12-07@x","original_summary":"Gelbe Tonne","label":"Gelbe Tonne","normalized_label":"gelbe tonne","date_key":"2026-12-07","tz_note":"all-day"}],"source_id":2,"expected_version":0}}}},
  "wq url create name spaces": {"status":400,"body":{"error":"name is required.","code":400}},
  "wq url create no url": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_source_url_invalid","fields":[{"path":"body/url","rule":"required","reason":"waste_source_url_invalid"}]}},
  "wq url create bad url": {"status":400,"body":{"error":"url must be an http(s) URL.","code":400,"reason":"waste_source_url_invalid"}},
  "wq url create interval low": {"status":400,"body":{"error":"refresh_interval_minutes must be an integer between 60 and 43200.","code":400,"reason":"waste_source_interval_invalid","params":{"min":60,"max":43200}}},
  "wq url create interval high": {"status":400,"body":{"error":"refresh_interval_minutes must be an integer between 60 and 43200.","code":400,"reason":"waste_source_interval_invalid","params":{"min":60,"max":43200}}},
  "wq url create interval fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/refresh_interval_minutes","rule":"type"}]}},
  "wq url create gone": {"status":201,"body":{"data":{"source":{"id":3,"kind":"url","name":"Weg","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"last_error":"HTTP 404","url":"<feed>/gone.ics","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":"2026-11-18T12:30:00Z","consecutive_failures":1,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":"waste_source_fetch_http_status","last_error_params":{"status":404},"needs_refresh":true},"outcome":"error","reason":"waste_source_fetch_http_status","params":{"status":404}}}},
  "wq url list admin": {"status":200,"body":{"data":[{"id":1,"kind":"file","name":"Kalender 2026","content_hash":"b4e20a6ed12c6d38c25c301e54ed84ac1eac05d0f244915f235a480578ac315f","version":2,"coverage_start":"2026-12-08","coverage_end":"2026-12-08","last_import_at":"<volatile>","last_success_at":"<volatile>","last_error":null,"url":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":false},{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"last_error":null,"url":"<feed>/cal.ics","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":true},{"id":3,"kind":"url","name":"Weg","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"last_error":"HTTP 404","url":"<feed>/gone.ics","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":"2026-11-18T12:30:00Z","consecutive_failures":1,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":"waste_source_fetch_http_status","last_error_params":{"status":404},"needs_refresh":true}]}},
  "wq url list reader": {"status":200,"body":{"data":[{"id":1,"kind":"file","name":"Kalender 2026","content_hash":"b4e20a6ed12c6d38c25c301e54ed84ac1eac05d0f244915f235a480578ac315f","version":2,"coverage_start":"2026-12-08","coverage_end":"2026-12-08","last_import_at":"<volatile>","last_success_at":"<volatile>","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","needs_refresh":false},{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","needs_refresh":true},{"id":3,"kind":"url","name":"Weg","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":"2026-11-18T12:30:00Z","consecutive_failures":1,"needs_mapping":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","needs_refresh":true}]}},
  "wq url get admin": {"status":200,"body":{"data":{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"last_error":null,"url":"<feed>/cal.ics","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":true,"mappings":[]}}},
  "wq url get reader": {"status":200,"body":{"data":{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","needs_refresh":true,"mappings":[]}}},
  "wq url reimport preview": {"status":200,"body":{"data":{"digest":"17b295d57422230f50e65116ad26d6cfef8f7db75929e9f7b0490b3f01c2e604","coverage":{"start":"2026-12-07","end":"2026-12-07"},"counts":{"events":1,"candidates":1,"distinct_labels":1},"diagnostics":[],"labels":[{"normalized_label":"gelbe tonne","original_label":"Gelbe Tonne","count":1,"sample_summary":"Gelbe Tonne","suggested_type_id":null,"remembered_type_ids":[],"remembered_type_id":null,"remembered_ignored":false}],"candidates":[{"identity_key":"uid:Gelbe Tonne-2026-12-07@x::2026-12-07","external_uid":"Gelbe Tonne-2026-12-07@x","original_summary":"Gelbe Tonne","label":"Gelbe Tonne","normalized_label":"gelbe tonne","date_key":"2026-12-07","tz_note":"all-day"}],"source_id":2,"expected_version":0}}},
  "wq url refresh": {"status":200,"body":{"data":{"source":{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"last_error":null,"url":"<feed>/cal.ics","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":true},"outcome":"needs_mapping","preview":{"digest":"1898cdd1641bf52b761f2a17901f4fcd6b2370048a3e3c500cbe82f395df5a63","coverage":{"start":"2026-12-14","end":"2026-12-14"},"counts":{"events":1,"candidates":1,"distinct_labels":1},"diagnostics":[],"labels":[{"normalized_label":"gelbe tonne","original_label":"Gelbe Tonne","count":1,"sample_summary":"Gelbe Tonne","suggested_type_id":null,"remembered_type_ids":[],"remembered_type_id":null,"remembered_ignored":false}],"candidates":[{"identity_key":"uid:Gelbe Tonne-2026-12-14@x::2026-12-14","external_uid":"Gelbe Tonne-2026-12-14@x","original_summary":"Gelbe Tonne","label":"Gelbe Tonne","normalized_label":"gelbe tonne","date_key":"2026-12-14","tz_note":"all-day"}],"source_id":2,"expected_version":0}}}},
  "wq url refresh reader": {"status":200,"body":{"data":{"source":{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":null,"consecutive_failures":0,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","needs_refresh":true},"outcome":"needs_mapping","preview":{"digest":"1898cdd1641bf52b761f2a17901f4fcd6b2370048a3e3c500cbe82f395df5a63","coverage":{"start":"2026-12-14","end":"2026-12-14"},"counts":{"events":1,"candidates":1,"distinct_labels":1},"diagnostics":[],"labels":[{"normalized_label":"gelbe tonne","original_label":"Gelbe Tonne","count":1,"sample_summary":"Gelbe Tonne","suggested_type_id":null,"remembered_type_ids":[],"remembered_type_id":null,"remembered_ignored":false}],"candidates":[{"identity_key":"uid:Gelbe Tonne-2026-12-14@x::2026-12-14","external_uid":"Gelbe Tonne-2026-12-14@x","original_summary":"Gelbe Tonne","label":"Gelbe Tonne","normalized_label":"gelbe tonne","date_key":"2026-12-14","tz_note":"all-day"}],"source_id":2,"expected_version":0}}}},
  "wq url reimport preview no events": {"status":502,"body":{"error":"Fetching the source URL failed: No calendar entries in the response","code":502,"reason":"waste_source_fetch_no_events"}},
  "wq url reimport commit no events": {"status":502,"body":{"error":"Fetching the source URL failed: No calendar entries in the response","code":502,"reason":"waste_source_fetch_no_events"}},
  "wq url reimport commit stale version": {"status":409,"body":{"error":"This source changed since you last previewed it; preview again before committing.","code":409,"reason":"source_changed"}},
  "wq url reimport preview gone": {"status":502,"body":{"error":"Fetching the source URL failed: HTTP 404","code":502,"reason":"waste_source_fetch_http_status","params":{"status":404}}},
  "wq url refresh gone": {"status":200,"body":{"data":{"source":{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"last_error":"HTTP 404","url":"<feed>/cal.ics","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":"2026-11-18T12:30:00Z","consecutive_failures":1,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":"waste_source_fetch_http_status","last_error_params":{"status":404},"needs_refresh":true},"outcome":"error","reason":"waste_source_fetch_http_status","params":{"status":404}}}},
  "wq url get after failure reader": {"status":200,"body":{"data":{"id":2,"kind":"url","name":"Stadt","content_hash":"","version":0,"coverage_start":null,"coverage_end":null,"last_import_at":"<volatile>","last_success_at":null,"etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":"2026-11-18T12:30:00Z","consecutive_failures":1,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","needs_refresh":true,"mappings":[]}}},
  "wq url reimport commit unmapped": {"status":400,"body":{"error":"No mapping decision was given for label \"Blaue Tonne\".","code":400}},
  "wq url reimport commit": {"status":200,"body":{"data":{"source":{"id":2,"kind":"url","name":"Stadt","content_hash":"f6b259d6919d071e32afcf76fc0bec540aa53c0dfea612ab586e03cfb1a81ac0","version":1,"coverage_start":"2026-12-21","coverage_end":"2026-12-21","last_import_at":"<volatile>","last_success_at":"<volatile>","last_error":null,"url":"<feed>/cal.ics","etag":null,"last_modified":null,"refresh_interval_minutes":1440,"next_attempt_at":"2026-11-18T12:30:00Z","consecutive_failures":1,"needs_mapping":1,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","last_error_reason":null,"last_error_params":null,"needs_refresh":false},"diff":{"added":1,"changed":0,"removed":0,"coalesced":0}}}},
  "wr list": {"status":200,"body":{"data":[{"type_id":1,"type_name":"Bio","enabled":false,"offset_days":1,"delivery_time":"08:00"},{"type_id":3,"type_name":"bio","enabled":false,"offset_days":1,"delivery_time":"08:00"},{"type_id":2,"type_name":"Papier","enabled":false,"offset_days":1,"delivery_time":"08:00"}]}},
  "wr put": {"status":200,"body":{"data":{"type_id":1,"enabled":true,"offset_days":1,"delivery_time":"19:30"}}},
  "wr put member": {"status":200,"body":{"data":{"type_id":1,"enabled":false,"offset_days":0,"delivery_time":"06:05"}}},
  "wr put max": {"status":200,"body":{"data":{"type_id":2,"enabled":true,"offset_days":14,"delivery_time":"23:59"}}},
  "wr put offset above": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_reminder_offset_invalid","fields":[{"path":"body/offset_days","rule":"maximum","reason":"waste_reminder_offset_invalid"}]}},
  "wr put offset below": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_reminder_offset_invalid","fields":[{"path":"body/offset_days","rule":"minimum","reason":"waste_reminder_offset_invalid"}]}},
  "wr put offset fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/offset_days","rule":"type"}]}},
  "wr put offset text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/offset_days","rule":"type"}]}},
  "wr put offset null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/offset_days","rule":"type"}]}},
  "wr put time empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_reminder_time_invalid","fields":[{"path":"body/delivery_time","rule":"pattern","reason":"waste_reminder_time_invalid"}]}},
  "wr put time 24": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_reminder_time_invalid","fields":[{"path":"body/delivery_time","rule":"pattern","reason":"waste_reminder_time_invalid"}]}},
  "wr put time seconds": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"waste_reminder_time_invalid","fields":[{"path":"body/delivery_time","rule":"pattern","reason":"waste_reminder_time_invalid"}]}},
  "wr put time null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/delivery_time","rule":"type"}]}},
  "wr put enabled text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "wr put enabled number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "wr put empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"required"}]}},
  "wr put no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "wr put type missing": {"status":404,"body":{"error":"Waste type not found.","code":404,"reason":"waste_type_not_found"}},
  "wr put type zero": {"status":400,"body":{"error":"typeId must be a positive number.","code":400}},
  "wr list after": {"status":200,"body":{"data":[{"type_id":1,"type_name":"Bio","enabled":true,"offset_days":1,"delivery_time":"19:30"},{"type_id":3,"type_name":"bio","enabled":false,"offset_days":1,"delivery_time":"08:00"},{"type_id":2,"type_name":"Papier","enabled":true,"offset_days":14,"delivery_time":"23:59"}]}},
  "wr list member": {"status":200,"body":{"data":[{"type_id":1,"type_name":"Bio","enabled":false,"offset_days":0,"delivery_time":"06:05"},{"type_id":3,"type_name":"bio","enabled":false,"offset_days":1,"delivery_time":"08:00"},{"type_id":2,"type_name":"Papier","enabled":false,"offset_days":1,"delivery_time":"08:00"}]}},
  "wf get none": {"status":200,"body":{"data":null}},
  "wf types before feed": {"status":404,"body":{"error":"Enable the feed before selecting types.","code":404}},
  "wf regenerate": {"status":200,"body":{"data":{"token":"<volatile>","url":"<api>/feed/waste/<volatile>.ics","type_ids":null}}},
  "wf types": {"status":200,"body":{"data":{"token":"<volatile>","url":"<api>/feed/waste/<volatile>.ics","type_ids":[1]}}},
  "wf types empty list": {"status":200,"body":{"data":{"token":"<volatile>","url":"<api>/feed/waste/<volatile>.ics","type_ids":[]}}},
  "wf types unknown": {"status":400,"body":{"error":"Unknown waste type id(s): 987654.","code":400}},
  "wf types fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type_ids/0","rule":"type"}]}},
  "wf types text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type_ids/0","rule":"type"}]}},
  "wf types not a list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type_ids","rule":"type"}]}},
  "wf types missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type_ids","rule":"required"}]}},
  "wf types no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "wf get": {"status":200,"body":{"data":{"token":"<volatile>","url":"<api>/feed/waste/<volatile>.ics","type_ids":[]}}},
  "wf types null": {"status":200,"body":{"data":{"token":"<volatile>","url":"<api>/feed/waste/<volatile>.ics","type_ids":null}}},
  "wf get member": {"status":200,"body":{"data":null}},
  "wf delete": {"status":200,"body":{"data":null}},
  "wf get after": {"status":200,"body":{"data":null}},
  "wt delete in use": {"status":409,"body":{"error":"Waste type has schedules, pickups, or imported data and cannot be deleted; archive it instead.","code":409,"reason":"waste_type_in_use"}},
  "ws delete": {"status":204,"body":null},
  "ws delete again": {"status":404,"body":{"error":"Waste schedule not found.","code":404,"reason":"waste_schedule_not_found"}},
  "ws delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wp delete": {"status":204,"body":null},
  "wp delete again": {"status":404,"body":{"error":"One-off pickup not found.","code":404,"reason":"waste_pickup_not_found"}},
  "wp delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wq delete": {"status":204,"body":null},
  "wq delete again": {"status":404,"body":{"error":"Waste import source not found.","code":404,"reason":"waste_source_not_found"}},
  "wq delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wt create spare": {"status":201,"body":{"data":{"id":4,"name":"Glas","icon":"trash-2","color":"#16A34A","archived":0,"sort_order":4,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "wt delete": {"status":204,"body":null},
  "wt delete again": {"status":404,"body":{"error":"Waste type not found.","code":404,"reason":"waste_type_not_found"}},
  "wt delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "wt list end": {"status":200,"body":{"data":[{"id":1,"name":"Bio","icon":"leaf","color":"#22C55E","archived":0,"sort_order":0,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"name":"bio","icon":"trash-2","color":"#22C55E","archived":0,"sort_order":2,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":2,"name":"Papier","icon":"trash-2","color":"#3B82F6","archived":0,"sort_order":3,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "sc members": {"status":200,"body":{"data":[{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":null,"sort_order":null},{"id":3,"display_name":"mia","avatar_color":"#007AFF","avatar_data":null,"sort_order":null},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"sort_order":null}]}},
  "sc types empty": {"status":200,"body":{"data":[]}},
  "sc type create": {"status":201,"body":{"data":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#0891B2","icon":"sun","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type create member": {"status":201,"body":{"data":{"id":2,"name":"Spaet","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type create spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "sc type create no name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "sc type create start only": {"status":400,"body":{"error":"start_time and end_time must be provided together.","code":400}},
  "sc type create time 25": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/start_time","rule":"pattern"}]}},
  "sc type create time single digit": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/start_time","rule":"pattern"}]}},
  "sc type create color bad": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"pattern"}]}},
  "sc type create color short": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/color","rule":"pattern"}]}},
  "sc type create icon upper": {"status":400,"body":{"error":"icon must contain only lowercase letters, digits, and hyphens.","code":400}},
  "sc type create icon spaces inside": {"status":400,"body":{"error":"icon must contain only lowercase letters, digits, and hyphens.","code":400}},
  "sc type create icon long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon","rule":"maxLength"}]}},
  "sc type create icon 48 spaced": {"status":201,"body":{"data":{"id":3,"name":"Nacht","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type create icon number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon","rule":"type"}]}},
  "sc type create icon spaces": {"status":201,"body":{"data":{"id":4,"name":"Ruhe","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type create short long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/short_code","rule":"maxLength"}]}},
  "sc type create short spaces": {"status":201,"body":{"data":{"id":5,"name":"Bereit","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type create name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "sc type update": {"status":200,"body":{"data":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type update color empty keeps": {"status":200,"body":{"data":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type update color null keeps": {"status":200,"body":{"data":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type update times cleared": {"status":200,"body":{"data":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type update end only": {"status":400,"body":{"error":"start_time and end_time must be provided together.","code":400}},
  "sc type update time bad": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/start_time","rule":"pattern"}]}},
  "sc type update icon upper": {"status":400,"body":{"error":"icon must contain only lowercase letters, digits, and hyphens.","code":400}},
  "sc type update icon long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon","rule":"maxLength"}]}},
  "sc type update icon object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/icon","rule":"type"}]}},
  "sc type update icon empty": {"status":200,"body":{"data":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type update name spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "sc type update foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sc type update missing": {"status":404,"body":{"error":"Shift type not found.","code":404,"reason":"schedule_shift_type_not_found"}},
  "sc type update zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sc type update negative": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sc fields list empty": {"status":200,"body":{"data":[]}},
  "sc field create": {"status":201,"body":{"data":{"id":1,"name":"Station","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sc field create member": {"status":201,"body":{"data":{"id":2,"name":"Raum","created_by":2,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sc field create spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "sc field create long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"maxLength"}]}},
  "sc field create long spaced": {"status":201,"body":{"data":{"id":3,"name":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sc field create no name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "sc field rename": {"status":200,"body":{"data":{"id":1,"name":"Station","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sc field rename keep": {"status":200,"body":{"data":{"id":1,"name":"Station","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sc field rename null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "sc field rename spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "sc field rename foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sc field rename missing": {"status":404,"body":{"error":"Custom field not found.","code":404,"reason":"schedule_custom_field_not_found"}},
  "sc field rename zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sc type fields": {"status":200,"body":{"data":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":1,"name":"Station","position":0,"show_in_overlay":true},{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]}}},
  "sc type fields empty": {"status":200,"body":{"data":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type fields id zero": {"status":400,"body":{"error":"Invalid field entry.","code":400}},
  "sc type fields id zero text": {"status":400,"body":{"error":"Invalid field entry.","code":400}},
  "sc type fields id gone": {"status":400,"body":{"error":"custom_field_id does not exist.","code":400,"reason":"schedule_selected_custom_field_not_found"}},
  "sc type fields repeat": {"status":400,"body":{"error":"custom_field_id must not repeat.","code":400}},
  "sc type fields position negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields/0/position","rule":"minimum"}]}},
  "sc type fields position fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields/0/position","rule":"type"}]}},
  "sc type fields position text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields/0/position","rule":"type"}]}},
  "sc type fields position missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields/0/position","rule":"required"}]}},
  "sc type fields overlay text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields/0/show_in_overlay","rule":"type"}]}},
  "sc type fields overlay null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields/0/show_in_overlay","rule":"type"}]}},
  "sc type fields row null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields/0","rule":"type"}]}},
  "sc type fields not a list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields","rule":"type"}]}},
  "sc type fields missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/fields","rule":"required"}]}},
  "sc type fields no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "sc type fields foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sc type fields type missing": {"status":404,"body":{"error":"Shift type not found.","code":404,"reason":"schedule_shift_type_not_found"}},
  "sc type fields type zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sc types": {"status":200,"body":{"data":[{"id":5,"name":"Bereit","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":1,"name":"Station","position":0,"show_in_overlay":true},{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]},{"id":3,"name":"Nacht","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},{"id":4,"name":"Ruhe","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}]}},
  "sc fields list": {"status":200,"body":{"data":[{"id":2,"name":"Raum","created_by":2,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"name":"Station","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"name":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "sp list empty": {"status":200,"body":{"data":[]}},
  "sp create admin for member": {"status":201,"body":{"data":{"id":1,"user_id":2,"name":"Rota","anchor_date":"2026-11-02","cycle_length":7,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp create member own": {"status":201,"body":{"data":{"id":2,"user_id":2,"name":"Eigen","anchor_date":"2026-11-02","cycle_length":14,"valid_from":"2026-11-01","valid_until":"2027-12-31","is_active":0,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp create member own text": {"status":201,"body":{"data":{"id":3,"user_id":2,"name":"Text","anchor_date":"2026-11-02","cycle_length":1,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp create member own absent": {"status":201,"body":{"data":{"id":4,"user_id":3,"name":"Ohne","anchor_date":"2026-11-02","cycle_length":366,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp create member own null": {"status":201,"body":{"data":{"id":5,"user_id":3,"name":"Null","anchor_date":"2026-11-02","cycle_length":2,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp create member own leading zero": {"status":201,"body":{"data":{"id":6,"user_id":2,"name":"Null-Text","anchor_date":"2026-11-02","cycle_length":2,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp create member foreign": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sp create member foreign broken": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sp create member own broken": {"status":400,"body":{"error":"name must not be empty. anchor_date must be a valid calendar date.","code":400}},
  "sp create member user zero": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sp create admin user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "sp create admin user zero text": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "sp create admin user missing": {"status":400,"body":{"error":"user_id does not exist.","code":400}},
  "sp create admin guest": {"status":400,"body":{"error":"Only household members can be chosen here - user 4 is not a household member.","code":400}},
  "sp create cycle zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"minimum"}]}},
  "sp create cycle 367": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"maximum"}]}},
  "sp create cycle fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"type"}]}},
  "sp create cycle text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"type"}]}},
  "sp create cycle null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"type"}]}},
  "sp create cycle missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"required"}]}},
  "sp create active text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/is_active","rule":"type"}]}},
  "sp create active number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/is_active","rule":"type"}]}},
  "sp create active null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/is_active","rule":"type"}]}},
  "sp create anchor not a day": {"status":400,"body":{"error":"anchor_date must be a valid calendar date.","code":400}},
  "sp create range reversed": {"status":400,"body":{"error":"valid_from must be before valid_until.","code":400}},
  "sp create name spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "sp list": {"status":200,"body":{"data":[{"id":2,"user_id":2,"name":"Eigen","anchor_date":"2026-11-02","cycle_length":14,"valid_from":"2026-11-01","valid_until":"2027-12-31","is_active":0,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":6,"user_id":2,"name":"Null-Text","anchor_date":"2026-11-02","cycle_length":2,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"user_id":2,"name":"Text","anchor_date":"2026-11-02","cycle_length":1,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"user_id":2,"name":"Rota","anchor_date":"2026-11-02","cycle_length":7,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":5,"user_id":3,"name":"Null","anchor_date":"2026-11-02","cycle_length":2,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":4,"user_id":3,"name":"Ohne","anchor_date":"2026-11-02","cycle_length":366,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "sp list user": {"status":200,"body":{"data":[{"id":2,"user_id":2,"name":"Eigen","anchor_date":"2026-11-02","cycle_length":14,"valid_from":"2026-11-01","valid_until":"2027-12-31","is_active":0,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":6,"user_id":2,"name":"Null-Text","anchor_date":"2026-11-02","cycle_length":2,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":3,"user_id":2,"name":"Text","anchor_date":"2026-11-02","cycle_length":1,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"},{"id":1,"user_id":2,"name":"Rota","anchor_date":"2026-11-02","cycle_length":7,"valid_from":null,"valid_until":null,"is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}]}},
  "sp list user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "sp list user negative": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "sp list user missing": {"status":404,"body":{"error":"User not found.","code":404}},
  "sp list user letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/user_id","rule":"type"}]}},
  "sp days": {"status":200,"body":{"data":[{"id":1,"pattern_id":1,"position":0,"shift_type_id":1,"field_values":{"1":"3B"}},{"id":2,"pattern_id":1,"position":0,"shift_type_id":2,"field_values":{}},{"id":3,"pattern_id":1,"position":6,"shift_type_id":null,"field_values":{}}]}},
  "sp days member": {"status":200,"body":{"data":[{"id":4,"pattern_id":1,"position":1,"shift_type_id":1,"field_values":{}},{"id":5,"pattern_id":1,"position":2,"shift_type_id":null,"field_values":{}}]}},
  "sp days position cycle": {"status":400,"body":{"error":"Invalid pattern day.","code":400}},
  "sp days position negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days/0/position","rule":"minimum"}]}},
  "sp days position fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days/0/position","rule":"type"}]}},
  "sp days position text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days/0/position","rule":"type"}]}},
  "sp days position missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days/0/position","rule":"required"}]}},
  "sp days row null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days/0","rule":"type"}]}},
  "sp days type zero": {"status":400,"body":{"error":"Invalid pattern day.","code":400}},
  "sp days type gone": {"status":400,"body":{"error":"shift_type_id does not exist.","code":400,"reason":"schedule_selected_shift_type_not_found"}},
  "sp days field not attached": {"status":400,"body":{"error":"field 1 is not attached to this shift type.","code":400}},
  "sp days field without type": {"status":400,"body":{"error":"field_values requires a shift_type_id.","code":400}},
  "sp days field key zero": {"status":400,"body":{"error":"field_values key must be a positive number.","code":400}},
  "sp days field value long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days/0/field_values/1","rule":"maxLength"}]}},
  "sp days field value number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days/0/field_values/1","rule":"type"}]}},
  "sp days field values list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days/0/field_values","rule":"type"}]}},
  "sp days 501 rows": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days","rule":"maxItems"}]}},
  "sp days 500 rows": {"status":400,"body":{"error":"Invalid pattern day.","code":400}},
  "sp days not a list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days","rule":"type"}]}},
  "sp days missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/days","rule":"required"}]}},
  "sp days foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sp days pattern missing": {"status":404,"body":{"error":"Pattern not found.","code":404,"reason":"schedule_pattern_not_found"}},
  "sp days pattern zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sp days get": {"status":200,"body":{"data":[{"id":4,"pattern_id":1,"position":1,"shift_type_id":1,"field_values":{}},{"id":5,"pattern_id":1,"position":2,"shift_type_id":null,"field_values":{}}]}},
  "sp days get missing": {"status":404,"body":{"error":"Pattern not found.","code":404,"reason":"schedule_pattern_not_found"}},
  "sp days get zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sp update": {"status":200,"body":{"data":{"id":1,"user_id":2,"name":"Rota 2","anchor_date":"2026-11-02","cycle_length":7,"valid_from":null,"valid_until":"2027-06-30","is_active":0,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp update member": {"status":200,"body":{"data":{"id":1,"user_id":2,"name":"Rota 2","anchor_date":"2026-11-02","cycle_length":7,"valid_from":null,"valid_until":"2027-06-30","is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp update cycle conflict": {"status":400,"body":{"error":"cycle_length cannot exclude existing pattern days.","code":400,"reason":"schedule_cycle_length_conflict"}},
  "sp update cycle grows": {"status":200,"body":{"data":{"id":1,"user_id":2,"name":"Rota 2","anchor_date":"2026-11-02","cycle_length":8,"valid_from":null,"valid_until":"2027-06-30","is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "sp update cycle zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"minimum"}]}},
  "sp update cycle 367": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"maximum"}]}},
  "sp update cycle fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"type"}]}},
  "sp update cycle null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/cycle_length","rule":"type"}]}},
  "sp update active text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/is_active","rule":"type"}]}},
  "sp update active null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/is_active","rule":"type"}]}},
  "sp update range reversed": {"status":400,"body":{"error":"valid_from must be before valid_until.","code":400}},
  "sp update anchor not a day": {"status":400,"body":{"error":"anchor_date must be a valid calendar date.","code":400}},
  "sp update name spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "sp update foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sp update missing": {"status":404,"body":{"error":"Pattern not found.","code":404,"reason":"schedule_pattern_not_found"}},
  "sp update zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sp update no body": {"status":200,"body":{"data":{"id":1,"user_id":2,"name":"Rota 2","anchor_date":"2026-11-02","cycle_length":8,"valid_from":null,"valid_until":"2027-06-30","is_active":1,"created_at":"<volatile>","updated_at":"<volatile>"}}},
  "so list empty": {"status":200,"body":{"data":[]}},
  "so put admin": {"status":200,"body":{"data":{"id":1,"user_id":2,"date_key":"2026-11-20","shift_type_id":1,"note":"Tausch","created_at":"<volatile>","field_values":{"1":"4A"}}}},
  "so put member own": {"status":200,"body":{"data":{"id":2,"user_id":2,"date_key":"2026-11-21","shift_type_id":2,"note":null,"created_at":"<volatile>","field_values":{}}}},
  "so put member explicit free": {"status":200,"body":{"data":{"id":3,"user_id":2,"date_key":"2026-11-22","shift_type_id":null,"note":null,"created_at":"<volatile>","field_values":{}}}},
  "so put member explicit free no user": {"status":200,"body":{"data":{"id":4,"user_id":3,"date_key":"2026-11-23","shift_type_id":null,"note":null,"created_at":"<volatile>","field_values":{}}}},
  "so put member own text": {"status":200,"body":{"data":{"id":5,"user_id":2,"date_key":"2026-11-24","shift_type_id":null,"note":"frei","created_at":"<volatile>","field_values":{}}}},
  "so put member foreign": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "so put member foreign broken": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "so put member fraction": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "so put admin user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "so put admin user missing": {"status":400,"body":{"error":"user_id does not exist.","code":400}},
  "so put admin guest": {"status":400,"body":{"error":"Only household members can be chosen here - user 4 is not a household member.","code":400}},
  "so put type gone": {"status":400,"body":{"error":"shift_type_id does not exist.","code":400,"reason":"schedule_selected_shift_type_not_found"}},
  "so put type zero": {"status":400,"body":{"error":"shift_type_id must be a positive number. shift_type_id does not exist.","code":400,"reason":"schedule_selected_shift_type_not_found"}},
  "so put type text broken": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/shift_type_id","rule":"type"},{"path":"body/shift_type_id","rule":"pattern"},{"path":"body/shift_type_id","rule":"anyOf"}]}},
  "so put not a day": {"status":400,"body":{"error":"date_key must be a valid calendar date.","code":400}},
  "so put not a key": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/dateKey","rule":"pattern"}]}},
  "so put note long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/note","rule":"maxLength"}]}},
  "so put field not attached": {"status":400,"body":{"error":"field 1 is not attached to this shift type.","code":400}},
  "so put field repeat": {"status":400,"body":{"error":"field 01 must not repeat.","code":400}},
  "so put field value spaces": {"status":200,"body":{"data":{"id":6,"user_id":1,"date_key":"2026-11-25","shift_type_id":1,"note":null,"created_at":"<volatile>","field_values":{}}}},
  "so list": {"status":200,"body":{"data":[{"id":6,"user_id":1,"date_key":"2026-11-25","shift_type_id":1,"note":null,"created_at":"<volatile>","field_values":{}},{"id":1,"user_id":2,"date_key":"2026-11-20","shift_type_id":1,"note":"Tausch","created_at":"<volatile>","field_values":{"1":"4A"}},{"id":2,"user_id":2,"date_key":"2026-11-21","shift_type_id":2,"note":null,"created_at":"<volatile>","field_values":{}},{"id":3,"user_id":2,"date_key":"2026-11-22","shift_type_id":null,"note":null,"created_at":"<volatile>","field_values":{}},{"id":5,"user_id":2,"date_key":"2026-11-24","shift_type_id":null,"note":"frei","created_at":"<volatile>","field_values":{}},{"id":4,"user_id":3,"date_key":"2026-11-23","shift_type_id":null,"note":null,"created_at":"<volatile>","field_values":{}}]}},
  "so list user range": {"status":200,"body":{"data":[{"id":2,"user_id":2,"date_key":"2026-11-21","shift_type_id":2,"note":null,"created_at":"<volatile>","field_values":{}},{"id":3,"user_id":2,"date_key":"2026-11-22","shift_type_id":null,"note":null,"created_at":"<volatile>","field_values":{}}]}},
  "so list reversed": {"status":400,"body":{"error":"from must be before to.","code":400,"reason":"range_reversed"}},
  "so list not a day": {"status":400,"body":{"error":"from must be a valid calendar date.","code":400}},
  "so list user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "so list user missing": {"status":404,"body":{"error":"User not found.","code":404}},
  "so fill": {"status":200,"body":{"data":{"updated":3}}},
  "so fill member own": {"status":200,"body":{"data":{"updated":1}}},
  "so fill member foreign": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "so fill reversed": {"status":400,"body":{"error":"from must be before to.","code":400,"reason":"range_reversed"}},
  "so fill long": {"status":400,"body":{"error":"The range must not exceed 100 days.","code":400}},
  "so fill not a day": {"status":400,"body":{"error":"from must be a valid calendar date.","code":400}},
  "so fill missing to": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/to","rule":"required"}]}},
  "so fill type gone": {"status":400,"body":{"error":"shift_type_id does not exist.","code":400,"reason":"schedule_selected_shift_type_not_found"}},
  "so fill admin user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "so fill admin guest": {"status":400,"body":{"error":"Only household members can be chosen here - user 4 is not a household member.","code":400}},
  "so fill admin user missing": {"status":400,"body":{"error":"user_id does not exist.","code":400}},
  "so fill field without type": {"status":400,"body":{"error":"field_values requires a shift_type_id.","code":400}},
  "so delete one": {"status":204,"body":null},
  "so delete one again": {"status":404,"body":{"error":"Override not found.","code":404,"reason":"schedule_override_not_found"}},
  "so delete one member own": {"status":204,"body":null},
  "so delete one member foreign": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "so delete one member own text": {"status":204,"body":null},
  "so delete one admin user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "so delete one not a day": {"status":400,"body":{"error":"date_key must be a valid calendar date.","code":400}},
  "so delete range": {"status":200,"body":{"data":{"deleted":2}}},
  "so delete range member own": {"status":200,"body":{"data":{"deleted":1}}},
  "so delete range member foreign": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "so delete range reversed": {"status":400,"body":{"error":"from must be before to.","code":400,"reason":"range_reversed"}},
  "so delete range long": {"status":200,"body":{"data":{"deleted":1}}},
  "so delete range not a day": {"status":400,"body":{"error":"from must be a valid calendar date.","code":400}},
  "so delete range admin user missing": {"status":400,"body":{"error":"user_id does not exist.","code":400}},
  "so delete range admin user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "so delete range missing to": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/to","rule":"required"}]}},
  "so list after": {"status":200,"body":{"data":[{"id":1,"user_id":2,"date_key":"2026-11-20","shift_type_id":1,"note":"Tausch","created_at":"<volatile>","field_values":{"1":"4A"}},{"id":9,"user_id":2,"date_key":"2026-12-03","shift_type_id":1,"note":"Urlaub","created_at":"<volatile>","field_values":{"1":"1"}},{"id":4,"user_id":3,"date_key":"2026-11-23","shift_type_id":null,"note":null,"created_at":"<volatile>","field_values":{}}]}},
  "sx list empty": {"status":200,"body":{"data":[]}},
  "sx create": {"status":201,"body":{"data":{"id":1,"user_id":2,"date_key":"2026-11-26","shift_type_id":1,"note":"Bereitschaft","reminder_offset_minutes":30,"created_by":1,"created_at":"<volatile>","field_values":{"1":"2C"}}}},
  "sx create member own": {"status":201,"body":{"data":{"id":2,"user_id":2,"date_key":"2026-11-27","shift_type_id":2,"note":null,"reminder_offset_minutes":null,"created_by":2,"created_at":"<volatile>","field_values":{}}}},
  "sx create member foreign": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sx create member own text": {"status":201,"body":{"data":{"id":3,"user_id":3,"date_key":"2026-11-28","shift_type_id":2,"note":null,"reminder_offset_minutes":1440,"created_by":3,"created_at":"<volatile>","field_values":{}}}},
  "sx create offset zero": {"status":201,"body":{"data":{"id":4,"user_id":1,"date_key":"2026-11-28","shift_type_id":2,"note":null,"reminder_offset_minutes":0,"created_by":1,"created_at":"<volatile>","field_values":{}}}},
  "sx create offset negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"minimum"}]}},
  "sx create offset above": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"maximum"}]}},
  "sx create offset fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"type"}]}},
  "sx create offset text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"type"}]}},
  "sx create offset empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"type"}]}},
  "sx create type missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"schedule_shift_type_required","fields":[{"path":"body/shift_type_id","rule":"required","reason":"schedule_shift_type_required"}]}},
  "sx create type null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/shift_type_id","rule":"type"},{"path":"body/shift_type_id","rule":"anyOf"}]}},
  "sx create type zero": {"status":400,"body":{"error":"shift_type_id must be a positive number.","code":400,"reason":"schedule_shift_type_required"}},
  "sx create type gone": {"status":400,"body":{"error":"shift_type_id does not exist.","code":400,"reason":"schedule_selected_shift_type_not_found"}},
  "sx create not a day": {"status":400,"body":{"error":"date_key must be a valid calendar date.","code":400}},
  "sx create no day": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/date_key","rule":"required"}]}},
  "sx create admin guest": {"status":400,"body":{"error":"Only household members can be chosen here - user 4 is not a household member.","code":400}},
  "sx create admin user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "sx create admin user missing": {"status":400,"body":{"error":"user_id does not exist.","code":400}},
  "sx create field not attached": {"status":400,"body":{"error":"field 2 is not attached to this shift type.","code":400}},
  "sx fill": {"status":200,"body":{"data":{"created":2}}},
  "sx fill member own": {"status":200,"body":{"data":{"created":1}}},
  "sx fill member foreign": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sx fill reversed": {"status":400,"body":{"error":"from must be before to.","code":400,"reason":"range_reversed"}},
  "sx fill long": {"status":400,"body":{"error":"The range must not exceed 100 days.","code":400}},
  "sx fill offset above": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"maximum"}]}},
  "sx fill offset text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"type"}]}},
  "sx fill type missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"schedule_shift_type_required","fields":[{"path":"body/shift_type_id","rule":"required","reason":"schedule_shift_type_required"}]}},
  "sx fill type zero": {"status":400,"body":{"error":"shift_type_id must be a positive number.","code":400,"reason":"schedule_shift_type_required"}},
  "sx fill type gone": {"status":400,"body":{"error":"shift_type_id does not exist.","code":400,"reason":"schedule_selected_shift_type_not_found"}},
  "sx fill admin guest": {"status":400,"body":{"error":"Only household members can be chosen here - user 4 is not a household member.","code":400}},
  "sx fill not a day": {"status":400,"body":{"error":"from must be a valid calendar date.","code":400}},
  "sx list": {"status":200,"body":{"data":[{"id":4,"user_id":1,"date_key":"2026-11-28","shift_type_id":2,"note":null,"reminder_offset_minutes":0,"created_by":1,"created_at":"<volatile>","field_values":{}},{"id":1,"user_id":2,"date_key":"2026-11-26","shift_type_id":1,"note":"Bereitschaft","reminder_offset_minutes":30,"created_by":1,"created_at":"<volatile>","field_values":{"1":"2C"}},{"id":2,"user_id":2,"date_key":"2026-11-27","shift_type_id":2,"note":null,"reminder_offset_minutes":null,"created_by":2,"created_at":"<volatile>","field_values":{}},{"id":5,"user_id":2,"date_key":"2026-12-05","shift_type_id":1,"note":null,"reminder_offset_minutes":60,"created_by":1,"created_at":"<volatile>","field_values":{"2":"R1"}},{"id":6,"user_id":2,"date_key":"2026-12-06","shift_type_id":1,"note":null,"reminder_offset_minutes":60,"created_by":1,"created_at":"<volatile>","field_values":{"2":"R1"}},{"id":7,"user_id":2,"date_key":"2026-12-07","shift_type_id":2,"note":null,"reminder_offset_minutes":null,"created_by":2,"created_at":"<volatile>","field_values":{}},{"id":3,"user_id":3,"date_key":"2026-11-28","shift_type_id":2,"note":null,"reminder_offset_minutes":1440,"created_by":3,"created_at":"<volatile>","field_values":{}}]}},
  "sx list user range": {"status":200,"body":{"data":[{"id":1,"user_id":2,"date_key":"2026-11-26","shift_type_id":1,"note":"Bereitschaft","reminder_offset_minutes":30,"created_by":1,"created_at":"<volatile>","field_values":{"1":"2C"}},{"id":2,"user_id":2,"date_key":"2026-11-27","shift_type_id":2,"note":null,"reminder_offset_minutes":null,"created_by":2,"created_at":"<volatile>","field_values":{}},{"id":5,"user_id":2,"date_key":"2026-12-05","shift_type_id":1,"note":null,"reminder_offset_minutes":60,"created_by":1,"created_at":"<volatile>","field_values":{"2":"R1"}}]}},
  "sx list reversed": {"status":400,"body":{"error":"from must be before to.","code":400,"reason":"range_reversed"}},
  "sx list user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "sx list user missing": {"status":404,"body":{"error":"User not found.","code":404}},
  "sx update": {"status":200,"body":{"data":{"id":1,"user_id":2,"date_key":"2026-11-29","shift_type_id":1,"note":"Neu","reminder_offset_minutes":null,"created_by":1,"created_at":"<volatile>","field_values":{"1":"2C"}}}},
  "sx update member": {"status":200,"body":{"data":{"id":1,"user_id":2,"date_key":"2026-11-29","shift_type_id":1,"note":"Neu","reminder_offset_minutes":45,"created_by":1,"created_at":"<volatile>","field_values":{"1":"2C"}}}},
  "sx update type": {"status":200,"body":{"data":{"id":1,"user_id":2,"date_key":"2026-11-29","shift_type_id":2,"note":"Neu","reminder_offset_minutes":45,"created_by":1,"created_at":"<volatile>","field_values":{}}}},
  "sx update type zero": {"status":400,"body":{"error":"shift_type_id must be a positive number.","code":400,"reason":"schedule_shift_type_required"}},
  "sx update type null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/shift_type_id","rule":"type"},{"path":"body/shift_type_id","rule":"anyOf"}]}},
  "sx update type gone": {"status":400,"body":{"error":"shift_type_id does not exist.","code":400,"reason":"schedule_selected_shift_type_not_found"}},
  "sx update offset above": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"maximum"}]}},
  "sx update offset negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"minimum"}]}},
  "sx update offset text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminder_offset_minutes","rule":"type"}]}},
  "sx update not a day": {"status":400,"body":{"error":"date_key must be a valid calendar date.","code":400}},
  "sx update field not attached": {"status":400,"body":{"error":"field 1 is not attached to this shift type.","code":400}},
  "sx update foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sx update missing": {"status":404,"body":{"error":"Extra shift not found.","code":404,"reason":"schedule_extra_shift_not_found"}},
  "sx update zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sx update no body": {"status":200,"body":{"data":{"id":1,"user_id":2,"date_key":"2026-11-29","shift_type_id":2,"note":"Neu","reminder_offset_minutes":45,"created_by":1,"created_at":"<volatile>","field_values":{}}}},
  "se entries": {"status":200,"body":{"data":{"entries":[{"user_id":1,"date_key":"2026-11-28","source":"extra","extra_id":4,"shift_type_id":2,"note":null,"reminder_offset_minutes":0,"is_free":false,"shift_type":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-16","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-17","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-18","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-19","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-20","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-21","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-22","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-23","source":"override","override_id":4,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-24","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-25","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-26","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-27","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-28","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-29","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-30","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-12-01","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-12-02","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-12-03","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-12-04","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-12-05","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-12-06","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-12-07","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-28","source":"extra","extra_id":3,"shift_type_id":2,"note":null,"reminder_offset_minutes":1440,"is_free":false,"shift_type":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-16","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-17","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-18","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-19","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-20","source":"override","override_id":1,"pattern_day_id":null,"shift_type_id":1,"note":"Tausch","is_free":false,"shift_type":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":1,"name":"Station","position":0,"show_in_overlay":true},{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]},"crosses_midnight":false,"field_values":{"1":"4A"}},{"user_id":2,"date_key":"2026-11-21","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-22","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-23","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-24","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-25","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-26","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-27","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-28","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-29","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-30","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-12-01","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-12-02","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-12-03","source":"override","override_id":9,"pattern_day_id":null,"shift_type_id":1,"note":"Urlaub","is_free":false,"shift_type":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":1,"name":"Station","position":0,"show_in_overlay":true},{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]},"crosses_midnight":false,"field_values":{"1":"1"}},{"user_id":2,"date_key":"2026-12-04","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-12-05","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-12-06","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-12-07","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-27","source":"extra","extra_id":2,"shift_type_id":2,"note":null,"reminder_offset_minutes":null,"is_free":false,"shift_type":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-29","source":"extra","extra_id":1,"shift_type_id":2,"note":"Neu","reminder_offset_minutes":45,"is_free":false,"shift_type":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-12-05","source":"extra","extra_id":5,"shift_type_id":1,"note":null,"reminder_offset_minutes":60,"is_free":false,"shift_type":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":1,"name":"Station","position":0,"show_in_overlay":true},{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]},"crosses_midnight":false,"field_values":{"2":"R1"}},{"user_id":2,"date_key":"2026-12-06","source":"extra","extra_id":6,"shift_type_id":1,"note":null,"reminder_offset_minutes":60,"is_free":false,"shift_type":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":1,"name":"Station","position":0,"show_in_overlay":true},{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]},"crosses_midnight":false,"field_values":{"2":"R1"}},{"user_id":2,"date_key":"2026-12-07","source":"extra","extra_id":7,"shift_type_id":2,"note":null,"reminder_offset_minutes":null,"is_free":false,"shift_type":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},"crosses_midnight":false,"field_values":{}}],"warnings":[{"user_id":3,"date_key":"2026-11-16","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-17","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-18","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-19","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-20","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-21","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-22","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-24","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-25","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-26","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-27","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-28","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-29","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-30","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-12-01","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-12-02","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-12-03","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-12-04","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-12-05","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-12-06","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-12-07","pattern_ids":[5,4]},{"user_id":2,"date_key":"2026-11-16","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-17","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-18","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-19","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-21","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-22","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-23","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-24","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-25","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-26","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-27","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-28","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-29","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-30","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-12-01","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-12-02","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-12-04","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-12-05","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-12-06","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-12-07","pattern_ids":[6,3,1]}]}}},
  "se entries user": {"status":200,"body":{"data":{"entries":[{"user_id":2,"date_key":"2026-11-20","source":"override","override_id":1,"pattern_day_id":null,"shift_type_id":1,"note":"Tausch","is_free":false,"shift_type":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":1,"name":"Station","position":0,"show_in_overlay":true},{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]},"crosses_midnight":false,"field_values":{"1":"4A"}},{"user_id":2,"date_key":"2026-11-21","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-22","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-23","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-24","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-25","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-26","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-27","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-28","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-29","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-27","source":"extra","extra_id":2,"shift_type_id":2,"note":null,"reminder_offset_minutes":null,"is_free":false,"shift_type":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-29","source":"extra","extra_id":1,"shift_type_id":2,"note":"Neu","reminder_offset_minutes":45,"is_free":false,"shift_type":{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},"crosses_midnight":false,"field_values":{}}],"warnings":[{"user_id":2,"date_key":"2026-11-21","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-22","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-23","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-24","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-25","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-26","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-27","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-28","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-29","pattern_ids":[6,3,1]}]}}},
  "se entries member": {"status":200,"body":{"data":{"entries":[{"user_id":3,"date_key":"2026-11-20","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-21","source":"pattern","pattern_id":5,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":3,"date_key":"2026-11-22","source":"pattern","pattern_id":5,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-20","source":"override","override_id":1,"pattern_day_id":null,"shift_type_id":1,"note":"Tausch","is_free":false,"shift_type":{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":1,"name":"Station","position":0,"show_in_overlay":true},{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]},"crosses_midnight":false,"field_values":{"1":"4A"}},{"user_id":2,"date_key":"2026-11-21","source":"pattern","pattern_id":6,"position":1,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}},{"user_id":2,"date_key":"2026-11-22","source":"pattern","pattern_id":6,"position":0,"pattern_day_id":null,"shift_type_id":null,"note":null,"is_free":true,"shift_type":null,"crosses_midnight":false,"field_values":{}}],"warnings":[{"user_id":3,"date_key":"2026-11-20","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-21","pattern_ids":[5,4]},{"user_id":3,"date_key":"2026-11-22","pattern_ids":[5,4]},{"user_id":2,"date_key":"2026-11-21","pattern_ids":[6,3,1]},{"user_id":2,"date_key":"2026-11-22","pattern_ids":[6,3,1]}]}}},
  "se entries reversed": {"status":400,"body":{"error":"from must be before to.","code":400,"reason":"range_reversed"}},
  "se entries long": {"status":400,"body":{"error":"The range must not exceed 731 days.","code":400}},
  "se entries 731": {"status":200,"body":{"data":{"entries":[],"warnings":[]}}},
  "se entries not a day": {"status":400,"body":{"error":"from must be a valid calendar date.","code":400}},
  "se entries no to": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/to","rule":"required"}]}},
  "se entries user zero": {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  "se entries user missing": {"status":404,"body":{"error":"User not found.","code":404}},
  "sf get none": {"status":200,"body":{"data":null}},
  "sf regenerate": {"status":200,"body":{"data":{"token":"<volatile>","url":"<api>/feed/schedule/<volatile>.ics"}}},
  "sf get": {"status":200,"body":{"data":{"token":"<volatile>","url":"<api>/feed/schedule/<volatile>.ics"}}},
  "sf delete": {"status":200,"body":{"data":{"token":null}}},
  "sf get after": {"status":200,"body":{"data":null}},
  "spref get": {"status":200,"body":{"data":{"reminderOffsetMinutes":null,"weeklyHours":null,"overtimeEnabled":true}}},
  "spref put": {"status":200,"body":{"data":{"reminderOffsetMinutes":30,"weeklyHours":38,"overtimeEnabled":false}}},
  "spref put partial": {"status":200,"body":{"data":{"reminderOffsetMinutes":30,"weeklyHours":168,"overtimeEnabled":false}}},
  "spref put member": {"status":200,"body":{"data":{"reminderOffsetMinutes":0,"weeklyHours":1,"overtimeEnabled":true}}},
  "spref put nulls": {"status":200,"body":{"data":{"reminderOffsetMinutes":null,"weeklyHours":null,"overtimeEnabled":true}}},
  "spref put offset above": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminderOffsetMinutes","rule":"maximum"}]}},
  "spref put offset negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminderOffsetMinutes","rule":"minimum"}]}},
  "spref put offset fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminderOffsetMinutes","rule":"type"}]}},
  "spref put offset text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminderOffsetMinutes","rule":"type"}]}},
  "spref put offset empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminderOffsetMinutes","rule":"type"}]}},
  "spref put offset false": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/reminderOffsetMinutes","rule":"type"}]}},
  "spref put hours zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/weeklyHours","rule":"minimum"}]}},
  "spref put hours above": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/weeklyHours","rule":"maximum"}]}},
  "spref put hours list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/weeklyHours","rule":"type"}]}},
  "spref put hours text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/weeklyHours","rule":"type"}]}},
  "spref put overtime text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/overtimeEnabled","rule":"type"}]}},
  "spref put overtime number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/overtimeEnabled","rule":"type"}]}},
  "spref put overtime null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/overtimeEnabled","rule":"type"}]}},
  "spref put empty": {"status":200,"body":{"data":{"reminderOffsetMinutes":30,"weeklyHours":168,"overtimeEnabled":false}}},
  "spref put no body": {"status":200,"body":{"data":{"reminderOffsetMinutes":30,"weeklyHours":168,"overtimeEnabled":false}}},
  "spref get after": {"status":200,"body":{"data":{"reminderOffsetMinutes":30,"weeklyHours":168,"overtimeEnabled":false}}},
  "spref get member": {"status":200,"body":{"data":{"reminderOffsetMinutes":null,"weeklyHours":null,"overtimeEnabled":true}}},
  "sx delete foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sx delete": {"status":204,"body":null},
  "sx delete again": {"status":404,"body":{"error":"Extra shift not found.","code":404,"reason":"schedule_extra_shift_not_found"}},
  "sx delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sp delete foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sp delete member": {"status":204,"body":null},
  "sp delete again": {"status":404,"body":{"error":"Pattern not found.","code":404,"reason":"schedule_pattern_not_found"}},
  "sp delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sc type delete in use": {"status":409,"body":{"error":"Shift type is in use.","code":409,"reason":"schedule_shift_type_in_use"}},
  "sc type delete foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sc type create spare": {"status":201,"body":{"data":{"id":6,"name":"Frei","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":null,"created_by":3,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}}},
  "sc type delete": {"status":204,"body":null},
  "sc type delete again": {"status":404,"body":{"error":"Shift type not found.","code":404,"reason":"schedule_shift_type_not_found"}},
  "sc type delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sc field delete foreign member": {"status":403,"body":{"error":"Forbidden.","code":403}},
  "sc field delete": {"status":204,"body":null},
  "sc field delete again": {"status":404,"body":{"error":"Custom field not found.","code":404,"reason":"schedule_custom_field_not_found"}},
  "sc field delete zero": {"status":400,"body":{"error":"id must be a positive number.","code":400}},
  "sc types end": {"status":200,"body":{"data":[{"id":5,"name":"Bereit","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},{"id":1,"name":"Frueh","short_code":"F","start_time":"06:00","end_time":"14:00","color":"#1D4ED8","icon":"sunrise","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[{"id":2,"name":"Raum","position":0,"show_in_overlay":false}]},{"id":3,"name":"Nacht","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},{"id":4,"name":"Ruhe","short_code":null,"start_time":null,"end_time":null,"color":"#0891B2","icon":null,"created_by":1,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]},{"id":2,"name":"Spaet","short_code":null,"start_time":"14:00","end_time":"22:00","color":"#0891B2","icon":null,"created_by":2,"created_at":"<volatile>","updated_at":"<volatile>","fields":[]}]}},
};

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  logged.error.length = 0;
  const seen = new Set();
  for (const step of STEPS) {
    if (typeof step === 'function') { await step(); continue; }
    const [name, method, path, body, opts] = step;
    assert.ok(!seen.has(name), `duplicate row name ${name}`);
    seen.add(name);
    const actual = await call(method, typeof path === 'function' ? path() : path, typeof body === 'function' ? body() : body, opts);
    const expected = EXPECTED[name];
    assert.ok(expected, `no expectation for ${name}`);
    assert.deepEqual({ status: actual.status, body: normalized(actual.body) }, expected, name); // ROW
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
 * Each request in turn with a handler whose first answer throws; every one is
 * a 500 of the central handler.
 * @param {Array<[string, string, unknown, string]>} rows [method, path under /api/v1, body, route pattern under /api/v1]
 */
async function assertAllCentral(rows) {
  for (const [method, path, body, pattern] of rows) {
    assertCentral(await call(method, path, body, { fail: true }), method, `/api/v1${pattern}`);
  }
}

test('waste: an unexpected error in each of the 39 routes is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  feeds['/probe.ics'] = ics('2026-12-28', 'Probe');
  await assertAllCentral([
    ['GET', '/waste/types', NO_BODY, '/waste/types/'],
    ['POST', '/waste/types', { name: 'Probe', color: '#111111' }, '/waste/types/'],
  ]);
  const type = typeId('Probe');
  const weekly = { type_id: type, recurrence_kind: 'weekly', anchor_date: '2026-11-02', interval: 1, weekdays: ['MO'] };
  await assertAllCentral([
    ['GET', `/waste/types/${type}`, NO_BODY, '/waste/types/:id'],
    ['PUT', `/waste/types/${type}`, { sort_order: 1 }, '/waste/types/:id'],
    ['GET', '/waste/schedules', NO_BODY, '/waste/schedules/'],
    ['POST', '/waste/schedules', weekly, '/waste/schedules/'],
  ]);
  const schedule = lastId('waste_schedules');
  await assertAllCentral([
    ['GET', `/waste/schedules/${schedule}`, NO_BODY, '/waste/schedules/:id'],
    ['PUT', `/waste/schedules/${schedule}`, weekly, '/waste/schedules/:id'],
    ['PUT', `/waste/schedules/${schedule}/overrides/2026-11-23`, { replacement_date: null, note: null }, '/waste/schedules/:id/overrides/:originalDate'],
    ['DELETE', `/waste/schedules/${schedule}/overrides/2026-11-23`, NO_BODY, '/waste/schedules/:id/overrides/:originalDate'],
    ['GET', '/waste/pickups', NO_BODY, '/waste/pickups/'],
    ['POST', '/waste/pickups', { type_id: type, date: '2026-12-02' }, '/waste/pickups/'],
  ]);
  const pickup = lastId('waste_one_off_pickups');
  await assertAllCentral([
    ['GET', `/waste/pickups/${pickup}`, NO_BODY, '/waste/pickups/:id'],
    ['PUT', `/waste/pickups/${pickup}`, { date: '2026-12-03' }, '/waste/pickups/:id'],
    ['DELETE', `/waste/pickups/${pickup}`, NO_BODY, '/waste/pickups/:id'],
    ['GET', '/waste/occurrences/next', NO_BODY, '/waste/occurrences/next'],
    ['GET', '/waste/occurrences?from=2026-11-01&to=2026-11-30', NO_BODY, '/waste/occurrences/'],
    ['POST', '/waste/import/preview', { ics: ics('2026-12-01', 'Datei') }, '/waste/import/preview'],
    ['POST', '/waste/import/commit', { ics: ics('2026-12-01', 'Datei'), name: 'Probe-Datei', mappings: [{ normalized_label: 'datei', type_ids: [type] }] }, '/waste/import/commit'],
    ['POST', '/waste/sources', { name: 'Probe-Adresse', url: `${feedOrigin}/probe.ics` }, '/waste/sources/'],
  ]);
  const file = sourceId('Probe-Datei');
  const url = sourceId('Probe-Adresse');

  await assertAllCentral([
    ['GET', '/waste/sources', NO_BODY, '/waste/sources/'],
    ['GET', `/waste/sources/${file}`, NO_BODY, '/waste/sources/:id'],
    ['PUT', `/waste/sources/${file}`, { name: 'Probe-Datei' }, '/waste/sources/:id'],
    ['POST', `/waste/sources/${url}/refresh`, {}, '/waste/sources/:id/refresh'],
    ['GET', `/waste/sources/${file}/mapping-profile/export`, NO_BODY, '/waste/sources/:id/mapping-profile/export'],
    ['POST', `/waste/sources/${file}/mapping-profile/import/preview`, { profile: { mappings: [] } }, '/waste/sources/:id/mapping-profile/import/preview'],
  ]);
  const profile = { mappings: [] };
  const digest = (await call('POST', `/waste/sources/${file}/mapping-profile/import/preview`, { profile })).body.data.profile_digest;
  await assertAllCentral([
    ['POST', `/waste/sources/${file}/mapping-profile/import/commit`, { profile, profile_digest: digest }, '/waste/sources/:id/mapping-profile/import/commit'],
    ['PUT', `/waste/sources/${file}/mappings/${mappingId(file)}`, { type_ids: [type] }, '/waste/sources/:id/mappings/:mappingId'],
    ['POST', `/waste/sources/${file}/reimport/preview`, { ics: ics('2026-12-01', 'Datei') }, '/waste/sources/:id/reimport/preview'],
    ['POST', `/waste/sources/${file}/reimport/commit`, { ics: ics('2026-12-01', 'Datei'), mappings: [{ normalized_label: 'datei', type_ids: [type] }], expected_version: sourceVersion(file) }, '/waste/sources/:id/reimport/commit'],
    ['GET', '/waste/reminder-settings', NO_BODY, '/waste/reminder-settings/'],
    ['PUT', `/waste/reminder-settings/${type}`, REMIND, '/waste/reminder-settings/:typeId'],
    ['GET', '/waste/feed', NO_BODY, '/waste/feed/'],
    ['POST', '/waste/feed/regenerate', {}, '/waste/feed/regenerate'],
    ['PUT', '/waste/feed/types', { type_ids: null }, '/waste/feed/types'],
    ['DELETE', '/waste/feed', NO_BODY, '/waste/feed/'],
    ['DELETE', `/waste/sources/${url}`, NO_BODY, '/waste/sources/:id'],
    ['DELETE', `/waste/schedules/${schedule}`, NO_BODY, '/waste/schedules/:id'],
  ]);
  await call('DELETE', `/waste/sources/${file}`, NO_BODY);
  await assertAllCentral([
    ['DELETE', `/waste/types/${type}`, NO_BODY, '/waste/types/:id'],
  ]);
  assert.equal((await call('GET', '/waste/types', NO_BODY)).status, 200, 'answers again');
});

test('schedule: an unexpected error in each of the 32 routes is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  await assertAllCentral([
    ['GET', '/schedule/household-members', NO_BODY, '/schedule/household-members'],
    ['GET', '/schedule/entries?from=2026-11-01&to=2026-11-30', NO_BODY, '/schedule/entries'],
    ['GET', '/schedule/shift-types', NO_BODY, '/schedule/shift-types'],
    ['POST', '/schedule/shift-types', { name: 'Probe' }, '/schedule/shift-types'],
    ['GET', '/schedule/custom-fields', NO_BODY, '/schedule/custom-fields'],
    ['POST', '/schedule/custom-fields', { name: 'Probe' }, '/schedule/custom-fields'],
  ]);
  const type = shiftTypeId('Probe');
  const field = fieldId('Probe');
  await assertAllCentral([
    ['PUT', `/schedule/shift-types/${type}`, { name: 'Probe' }, '/schedule/shift-types/:id'],
    ['PUT', `/schedule/shift-types/${type}/fields`, { fields: [] }, '/schedule/shift-types/:id/fields'],
    ['PUT', `/schedule/custom-fields/${field}`, { name: 'Probe' }, '/schedule/custom-fields/:id'],
    ['GET', '/schedule/patterns', NO_BODY, '/schedule/patterns'],
    ['POST', '/schedule/patterns', { name: 'Probe', anchor_date: '2026-11-02', cycle_length: 7 }, '/schedule/patterns'],
  ]);
  const pattern = patternId('Probe');
  await assertAllCentral([
    ['PUT', `/schedule/patterns/${pattern}`, { name: 'Probe' }, '/schedule/patterns/:id'],
    ['GET', `/schedule/patterns/${pattern}/days`, NO_BODY, '/schedule/patterns/:id/days'],
    ['PUT', `/schedule/patterns/${pattern}/days`, { days: [{ position: 0, shift_type_id: type }] }, '/schedule/patterns/:id/days'],
    ['DELETE', `/schedule/patterns/${pattern}`, NO_BODY, '/schedule/patterns/:id'],
    ['GET', '/schedule/overrides', NO_BODY, '/schedule/overrides'],
    ['PUT', '/schedule/overrides/2026-11-30', { shift_type_id: null, note: null, field_values: {} }, '/schedule/overrides/:dateKey'],
    ['DELETE', '/schedule/overrides/2026-11-30', NO_BODY, '/schedule/overrides/:dateKey'],
    ['POST', '/schedule/overrides/fill', { from: '2026-11-30', to: '2026-11-30' }, '/schedule/overrides/fill'],
    ['DELETE', '/schedule/overrides?from=2026-11-30&to=2026-11-30', NO_BODY, '/schedule/overrides'],
    ['GET', '/schedule/extras', NO_BODY, '/schedule/extras/'],
    ['POST', '/schedule/extras', { date_key: '2026-11-30', shift_type_id: type }, '/schedule/extras/'],
    ['POST', '/schedule/extras/fill', { from: '2026-11-30', to: '2026-11-30', shift_type_id: type }, '/schedule/extras/fill'],
  ]);
  const extra = lastId('schedule_extra_shifts');
  await assertAllCentral([
    ['PUT', `/schedule/extras/${extra}`, { note: 'Probe' }, '/schedule/extras/:id'],
    ['DELETE', `/schedule/extras/${extra}`, NO_BODY, '/schedule/extras/:id'],
    ['GET', '/schedule/feed', NO_BODY, '/schedule/feed/'],
    ['POST', '/schedule/feed/regenerate', {}, '/schedule/feed/regenerate'],
    ['DELETE', '/schedule/feed', NO_BODY, '/schedule/feed/'],
    ['GET', '/schedule/preferences', NO_BODY, '/schedule/preferences/'],
    ['PUT', '/schedule/preferences', { weeklyHours: 40 }, '/schedule/preferences/'],
  ]);
  db.prepare('DELETE FROM schedule_extra_shifts WHERE shift_type_id = ?').run(type);
  await assertAllCentral([
    ['DELETE', `/schedule/custom-fields/${field}`, NO_BODY, '/schedule/custom-fields/:id'],
    ['DELETE', `/schedule/shift-types/${type}`, NO_BODY, '/schedule/shift-types/:id'],
  ]);
  assert.equal((await call('GET', '/schedule/shift-types', NO_BODY)).status, 200, 'answers again');
});

test('the handled cases keep their own answer and never reach the central handler', async () => {
  logged.error.length = 0;
  // WasteValidationError: 400 with its reason.
  const type = (await call('POST', '/waste/types', { name: 'Handfall', color: '#222222' })).body.data;
  assert.deepEqual(await call('POST', '/waste/schedules', { type_id: type.id, recurrence_kind: 'weekly', anchor_date: '2026-11-02', interval: 60, weekdays: ['MO'] }),
    EXPECTED['ws create interval large']);
  // WasteNotFoundError: 404 with its reason.
  assert.deepEqual(await call('PUT', `/waste/types/${MISSING}`, { name: 'X' }), EXPECTED['wt update missing']);
  // WasteConflictError: 409 (a profile digest that does not match).
  const file = (await call('POST', '/waste/import/commit', { ics: ics('2026-12-01', 'Hand'), name: 'Handquelle', mappings: [{ normalized_label: 'hand', type_ids: [type.id] }] })).body.data.source.id;
  const conflict = await call('POST', `/waste/sources/${file}/mapping-profile/import/commit`, { profile: { mappings: [] }, profile_digest: 'stale' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.reason, 'waste_profile_changed');
  // A URL source whose answer holds no entry: 502 on preview and commit.
  feeds['/hand.ics'] = ics('2026-12-14', 'Hand');
  const url = (await call('POST', '/waste/sources', { name: 'Handadresse', url: `${feedOrigin}/hand.ics` })).body.data.source.id;
  feeds['/hand.ics'] = EMPTY_ICS;
  const noEvents = {
    status: 502,
    body: { error: 'Fetching the source URL failed: No calendar entries in the response', code: 502, reason: 'waste_source_fetch_no_events' },
  };
  assert.deepEqual(await call('POST', `/waste/sources/${url}/reimport/preview`, {}), noEvents);
  assert.deepEqual(await call('POST', `/waste/sources/${url}/reimport/commit`, { expected_version: sourceVersion(url) }), noEvents);
  // A shift type still in use: 409 with its reason, nothing deleted.
  const shift = (await call('POST', '/schedule/shift-types', { name: 'Handschicht' })).body.data;
  await call('POST', '/schedule/extras', { date_key: '2026-12-01', shift_type_id: shift.id });
  assert.deepEqual(await call('DELETE', `/schedule/shift-types/${shift.id}`, NO_BODY), {
    status: 409, body: { error: 'Shift type is in use.', code: 409, reason: 'schedule_shift_type_in_use' },
  });
  assert.ok(db.prepare('SELECT 1 FROM schedule_shift_types WHERE id = ?').get(shift.id), 'the shift type stays');
  assert.deepEqual(logged.error, [], 'none reached the central handler');
});
