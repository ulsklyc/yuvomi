/**
 * Test: the answers of the calendar provider routes stay byte-equal
 *       (#2810, phase 2 section E, group 10b, step b)
 * Purpose: server/routes/calendar/{google,apple,caldav,outlook}.js (12, 5, 12,
 *          9 operations) dropped the hand checks the schema of their
 *          operation already covers on every input (`validateRequest()` runs
 *          before every handler since #2890) and the try/catch blocks that
 *          answered an unexpected error with a 500 of their own. This suite
 *          holds that refactor:
 *
 *          (1) A table of requests to all 38 operations - valid, every refusal
 *          of the handler that stays (each `reason`, `apple_url_invalid`,
 *          fields empty after trimming, the lengths of `secret()`, the
 *          default assignees and their reasons, `reminder_list_assignee_not_tasks`,
 *          "at least one field" of a reminder list, the backfill count and
 *          token (409), the refusals of `parseMoves()`, an unknown account
 *          (404), `outlook_not_configured`, an expired sign-in, a refusal of
 *          the foreign server as its class (`remote_*` with `detail`), the
 *          restore gate (503), the OAuth callbacks with their `state`), every
 *          input a dropped hand check refused (now the schema's 400), path ids
 *          `0`, `-1`, `-0` and with a leading zero, for an admin, a member, a
 *          child and a paired display; it pins status and the WHOLE body
 *          (and the target of a redirect). The expectations were written
 *          before the refactor (7d9eddb01) and are literal values in
 *          test/calendar-provider-answers-expected.js, no fixture file, no
 *          update mode.
 *
 *          No request leaves the machine: CalDAV and iCloud are two fake DAV
 *          servers on 127.0.0.1 (test/caldav-fake-server.js), Microsoft Graph
 *          and its token endpoint answer from a stand-in for `fetch`, Google
 *          from a stand-in `fetchImplementation` of googleapis (only while the
 *          Google variables are set; without them the service stops before
 *          any request). Every foreign request is counted and asserted.
 *          SQLite stamps rows with its own clock, which mock.timers does not
 *          reach: test triggers pin `created_at`, other stamps are masked. The
 *          clock stands still (`mock.timers`, 18.11.2026 12:00 UTC), the
 *          household lives in Europe/Berlin.
 *
 *          (2) An unexpected error in every route that answered its own 500
 *          reaches the central error handler - 500 with its fixed sentence and
 *          its log line `Unhandled error: <METHOD> <pattern> -> 500` - and the
 *          process keeps answering; async handlers (a rejected promise)
 *          included. A database error behind the failure helpers
 *          (`sendGoogleError`, `send*Failure`, which take every other error
 *          for a refusal of the foreign server) goes the same way; the Apple
 *          connection still clears the stored access first.
 *
 *          (3) What stays the route's own - the 409 of an expired sign-in or
 *          a missing configuration, the 502 of a foreign refusal with its
 *          `detail`, the 503 of the restore gate, the redirects of the OAuth
 *          callbacks (a failing callback goes back to the settings, never to
 *          JSON) - keeps its answer and never reaches the central handler.
 *
 *          (4) Each handler alone (without `validateRequest()`) keeps the type
 *          checks in front of a loop, `.length` or a string method (sink, not
 *          route).
 * Run: npm run test:calendar-provider-answers
 */

process.env.SESSION_SECRET = 'calendar-provider-answers-secret';
process.env.DB_PATH = ':memory:';
const MS_ENV = {
  MS_CLIENT_ID: 'test-client',
  MS_CLIENT_SECRET: 'test-secret-value',
  MS_REDIRECT_URI: 'http://127.0.0.1/api/v1/calendar/outlook/callback',
};
const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'test-google-client',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1/api/v1/calendar/google/callback',
};
Object.assign(process.env, MS_ENV);
for (const key of Object.keys(GOOGLE_ENV)) delete process.env[key];

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { google } from 'googleapis';
import { createCalendarApp } from './calendar-app.js';
import { startFakeDavServer } from './caldav-fake-server.js';
import { EXPECTED, CHANGED, CENTRAL } from './calendar-provider-answers-expected.js';

const dbmod = await import('../server/db.js');
const restoreState = await import('../server/utils/restore-state.js');
const { movedCandidatesLimit } = await import('../server/services/sync-assignment.js');
const { BODY_LIMIT } = await import('../server/utils/upload-limit.js');
const database = () => dbmod.get();

/** @param {string} key @param {string} value */
function setConfig(key, value) {
  database().prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
setConfig('household_timezone', 'Europe/Berlin');
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });
const FROZEN = '2026-11-18T12:00';

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
const CHILD = user('kim', 'member', 'child');
const DISPLAY = user('wand', 'member', 'other');
const GUEST = user('gast', 'member', 'other');
// A split-expense guest: a users row that is no household member.
const GROUP = Number(database().prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(ADMIN).lastInsertRowid);
database().prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(GUEST, GROUP, ADMIN);

/** @type {Record<string, { id: number, role: string, method?: string, scopes?: string[] }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  child: { id: CHILD, role: 'member' },
  display: { id: DISPLAY, role: 'member', method: 'display', scopes: ['calendar:read', 'dashboard:read'] },
};

// ── Foreign servers, all on this machine ────────────────────────────────────
// CalDAV and iCloud: two fake DAV servers, one with collections, one empty.
const dav = /** @type {any} */ (await startFakeDavServer());
const empty = /** @type {any} */ (await startFakeDavServer());
const DAV_PORT = new URL(dav.url).port;
const EMPTY_PORT = new URL(empty.url).port;
const CAL_URL = dav.addCollection('family', { name: 'Familie' });
const LIST_URL = dav.addCollection('todo', { name: 'Erinnerungen', components: ['VTODO'] });

// Microsoft Graph and its token endpoint: a stand-in for the global fetch the
// Outlook service calls. Every other address goes to the real fetch (the test
// client asks the app and the DAV servers on 127.0.0.1).
const realFetch = globalThis.fetch;
/** @type {{ graph: string[], google: string[] }} */
const foreign = { graph: [], google: [] };
/** @type {{ mode: 'ok' | 'http500' }} */
const graph = { mode: 'ok' };
const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === 'login.microsoftonline.com') {
    foreign.graph.push(`POST ${url.pathname}`);
    const params = new URLSearchParams(String(init?.body ?? ''));
    if (params.get('grant_type') === 'refresh_token') return json({ error: 'invalid_grant', error_description: 'expired' }, 400);
    if (params.get('code') === 'refused') return json({ error: 'invalid_request' }, 400);
    return json({ access_token: 'ms-access', refresh_token: 'ms-refresh', expires_in: 3600 });
  }
  if (url.hostname === 'graph.microsoft.com') {
    foreign.graph.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (graph.mode === 'http500') return json({ error: { code: 'InternalServerError' } }, 500);
    if (url.pathname === '/v1.0/me') return json({ id: 'ms-callback', displayName: 'Rückruf', mail: 'rueckruf@example.invalid' });
    if (url.pathname === '/v1.0/me/calendars') {
      return json({ value: [
        { id: 'cal-A', name: 'Kalender A', canEdit: true, isDefaultCalendar: true },
        { id: 'cal-B', name: 'Kalender B', canEdit: false },
      ] });
    }
    return json({ value: [] });
  }
  if (/googleapis\.com$/.test(url.hostname)) throw new Error(`Google asked through the global fetch: ${url.hostname}`);
  return realFetch(input, init);
});
// Google: googleapis asks node-fetch, unless an implementation is given.
/** @type {{ mode: 'ok' | 'http500' }} */
const googleMode = { mode: 'ok' };
google.options({
  retry: false,
  fetchImplementation: /** @type {any} */ (async (/** @type {string} */ input) => {
    const url = new URL(String(input));
    foreign.google.push(url.pathname);
    if (googleMode.mode === 'http500') return json({ error: { code: 500, message: 'backend' } }, 500);
    if (url.pathname.endsWith('/users/me/calendarList')) {
      return json({ items: [{ id: 'fam@group.calendar.google.com', summary: 'Familie', accessRole: 'owner', backgroundColor: '#336699' }] });
    }
    return json({ items: [], nextSyncToken: 'sync-1' });
  }),
});

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createCalendarApp({
  log,
  mount: ['calendar'],
  // The body limit of server/index.js: the list of moves above its maximum fits.
  jsonLimit: BODY_LIMIT,
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
    // The state an OAuth start left in the session.
    const state = req.get('x-oauth-state');
    if (state) Object.assign(req.session, { googleOAuthState: state, outlookOAuthState: state });
    req.sessionModuleAccess = null;
    // An unexpected error: the first answer of the handler throws.
    if (req.get('x-fail') === 'answer') {
      let thrown = false;
      for (const name of ['json', 'send', 'end', 'setHeader', 'redirect']) {
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
test.after(async () => {
  server.close();
  await dav.close();
  await empty.close();
  globalThis.fetch = realFetch;
});

// ── Requests ─────────────────────────────────────────────────────────────────
const NO_BODY = Symbol('no body');

/** @typedef {{ actor?: string, fail?: boolean, state?: string }} CallOptions */

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {unknown} body a JSON value or NO_BODY
 * @param {CallOptions} [opts]
 * @returns {Promise<{ status: number, body: any, location?: string }>}
 */
async function call(method, route, body, { actor, fail, state } = {}) {
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
  if (state) headers['x-oauth-state'] = state;
  const res = await realFetch(`${baseUrl}/api/v1${route}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  const location = res.headers.get('location');
  /** @type {any} */
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = '<text>'; }
  }
  return location ? { status: res.status, body: parsed, location } : { status: res.status, body: parsed };
}

/** @param {string} value */
function masked(value) {
  // A stamp of SQLite's own clock (the frozen one stays) and the ports of this run.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) && !value.startsWith(FROZEN) && !value.startsWith(STAMP.slice(0, 16))) return '<stamp>';
  return value.replaceAll(`:${DAV_PORT}/`, ':<dav>/').replaceAll(`:${EMPTY_PORT}/`, ':<empty>/').replace(/state=[0-9a-f]{64}/, 'state=<state>');
}

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (_key, v) => (typeof v === 'string' ? masked(v) : v));
}

/** @type {Record<string, any>} */
const answered = {};
const LONG = (/** @type {number} */ n) => 'x'.repeat(n);
const C = '/calendar';
const HEX = 'a'.repeat(64);
/** @param {boolean} on */
function googleEnv(on) {
  for (const [key, value] of Object.entries(GOOGLE_ENV)) {
    if (on) process.env[key] = value; else delete process.env[key];
  }
}
/** @param {boolean} on */
function msEnv(on) {
  for (const [key, value] of Object.entries(MS_ENV)) {
    if (on) process.env[key] = value; else delete process.env[key];
  }
}
/** @param {boolean} on */
const restore = (on) => () => { restoreState.setRestoreRunning(on); };
const caldavId = (/** @type {string} */ name) => Number(database().prepare('SELECT id FROM caldav_accounts WHERE name = ?').get(name)?.id);
const outlookId = (/** @type {string} */ name) => Number(database().prepare('SELECT id FROM outlook_accounts WHERE name = ?').get(name)?.id);
const CD = (/** @type {string} */ tail = '') => () => `${C}/caldav/accounts/${caldavId('Familie')}${tail}`;
const OL = (/** @type {string} */ tail = '') => () => `${C}/outlook/accounts/${outlookId('Papa')}${tail}`;
const MOVE = (/** @type {Record<string, unknown>} */ over = {}) => ({ event_id: 1, from_user_ids: [ADMIN], to_user_ids: [MEM], ...over });

/** A Google calendar the selection offers, so PATCH /external-calendars may create its row. */
function seedGoogle() {
  database().prepare("INSERT INTO google_calendar_selection (calendar_id, name, color, enabled) VALUES ('offered@group.calendar.google.com', 'Angeboten', '#112233', 0)").run();
  database().prepare("INSERT INTO external_calendars (source, external_id, name, color) VALUES ('google', 'synced@group.calendar.google.com', 'Synchron', '#445566')").run();
}
/** Google connected with tokens (no expiry: no refresh is asked). */
function connectGoogle() {
  setConfig('google_access_token', 'g-access');
  setConfig('google_refresh_token', 'g-refresh');
}
/** An Outlook account whose access token is valid for years, and one whose token expired. */
function seedOutlook() {
  for (const [name, expiry] of [['Papa', '2099-01-01T00:00:00Z'], ['Abgelaufen', '2000-01-01T00:00:00Z']]) {
    const id = Number(database().prepare(`INSERT INTO outlook_accounts (name, ms_user_id, email, access_token, refresh_token, token_expiry)
      VALUES (?, ?, ?, 'tok', 'ref', ?)`).run(name, `ms-${name}`, `${name.toLowerCase()}@example.invalid`, expiry).lastInsertRowid);
    database().prepare("INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled) VALUES (?, 'cal-A', 'Kalender A', 1, 0)").run(id);
  }
}
/** A local series aimed at Outlook calendar cal-A with an override: switching cal-A on is refused (409). */
function seedOverride() {
  const parent = Number(database().prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, external_source, target_outlook_account_id, target_outlook_calendar_id, recurrence_rule)
    VALUES ('Serie', '2026-11-20T09:00', ?, 'local', ?, 'cal-A', 'FREQ=DAILY;COUNT=3')`).run(ADMIN, outlookId('Papa')).lastInsertRowid);
  database().prepare("INSERT INTO calendar_events (title, start_datetime, created_by, external_source, recurrence_parent_id) VALUES ('Ausnahme', '2026-11-21T10:00', ?, 'local', ?)").run(ADMIN, parent);
}
function dropOverride() {
  database().prepare("DELETE FROM calendar_events WHERE title IN ('Ausnahme', 'Serie')").run();
}

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ GOOGLE without its variables (google.js) ═══════════════════════════════
  seedGoogle,
  ['g status', 'GET', `${C}/google/status`, NO_BODY],
  ['g status mem', 'GET', `${C}/google/status`, NO_BODY, { actor: 'mem' }],
  ['g status child', 'GET', `${C}/google/status`, NO_BODY, { actor: 'child' }],
  ['g status display', 'GET', `${C}/google/status`, NO_BODY, { actor: 'display' }],
  ['g auth unconfigured', 'GET', `${C}/google/auth`, NO_BODY],
  ['g auth mem', 'GET', `${C}/google/auth`, NO_BODY, { actor: 'mem' }],
  ['g auth display', 'GET', `${C}/google/auth`, NO_BODY, { actor: 'display' }],
  ['g callback error', 'GET', `${C}/google/callback?error=access_denied&scope=x`, NO_BODY],
  ['g callback no code', 'GET', `${C}/google/callback`, NO_BODY],
  ['g callback no state', 'GET', `${C}/google/callback?code=abc`, NO_BODY],
  ['g callback wrong state', 'GET', `${C}/google/callback?code=abc&state=other`, NO_BODY, { state: 'right' }],
  ['g callback two codes', 'GET', `${C}/google/callback?code=a&code=b&state=s`, NO_BODY, { state: 's' }],
  // The state matches; the exchange fails (no client without the variables): back to the settings.
  ['g callback exchange fails', 'GET', `${C}/google/callback?code=abc&state=right`, NO_BODY, { state: 'right' }],
  ['g sync unconfigured', 'POST', `${C}/google/sync`, {}],
  ['g sync no body', 'POST', `${C}/google/sync`, NO_BODY],
  ['g sync mem', 'POST', `${C}/google/sync`, {}, { actor: 'mem' }],
  ['g calendars unconfigured', 'GET', `${C}/google/calendars`, NO_BODY],
  ['g calendars mem', 'GET', `${C}/google/calendars`, NO_BODY, { actor: 'mem' }],
  ['g select unconfigured', 'PATCH', `${C}/google/calendars`, { calendarId: 'offered@group.calendar.google.com', enabled: true }],
  ['g select id empty', 'PATCH', `${C}/google/calendars`, { calendarId: '', enabled: true }],
  ['g select id spaces', 'PATCH', `${C}/google/calendars`, { calendarId: '   ', enabled: true }],
  ['g select id number', 'PATCH', `${C}/google/calendars`, { calendarId: 5, enabled: true }],
  ['g select id null', 'PATCH', `${C}/google/calendars`, { calendarId: null, enabled: true }],
  ['g select id missing', 'PATCH', `${C}/google/calendars`, { enabled: true }],
  ['g select enabled text', 'PATCH', `${C}/google/calendars`, { calendarId: 'x', enabled: 'false' }],
  ['g select enabled number', 'PATCH', `${C}/google/calendars`, { calendarId: 'x', enabled: 0 }],
  ['g select enabled null', 'PATCH', `${C}/google/calendars`, { calendarId: 'x', enabled: null }],
  ['g select enabled missing', 'PATCH', `${C}/google/calendars`, { calendarId: 'x' }],
  ['g select id spaces enabled text', 'PATCH', `${C}/google/calendars`, { calendarId: '  ', enabled: 'x' }],
  ['g select no body', 'PATCH', `${C}/google/calendars`, NO_BODY],
  ['g select mem', 'PATCH', `${C}/google/calendars`, { calendarId: 'x', enabled: true }, { actor: 'mem' }],
  ['g select mem bad body', 'PATCH', `${C}/google/calendars`, { calendarId: 5 }, { actor: 'mem' }],
  ['g readonly on', 'PUT', `${C}/google/readonly`, { readonly: true }],
  ['g readonly off', 'PUT', `${C}/google/readonly`, { readonly: false }],
  ['g readonly number', 'PUT', `${C}/google/readonly`, { readonly: 1 }],
  ['g readonly text', 'PUT', `${C}/google/readonly`, { readonly: 'true' }],
  ['g readonly null', 'PUT', `${C}/google/readonly`, { readonly: null }],
  ['g readonly missing', 'PUT', `${C}/google/readonly`, {}],
  ['g readonly no body', 'PUT', `${C}/google/readonly`, NO_BODY],
  ['g readonly mem', 'PUT', `${C}/google/readonly`, { readonly: true }, { actor: 'mem' }],
  ['g disconnect', 'DELETE', `${C}/google/disconnect`, NO_BODY],
  ['g disconnect events', 'DELETE', `${C}/google/disconnect?deleteEvents=true`, NO_BODY],
  ['g disconnect keep', 'DELETE', `${C}/google/disconnect?deleteEvents=false`, NO_BODY],
  ['g disconnect yes', 'DELETE', `${C}/google/disconnect?deleteEvents=yes`, NO_BODY],
  ['g disconnect mem', 'DELETE', `${C}/google/disconnect`, NO_BODY, { actor: 'mem' }],
  ['g mirrored', 'DELETE', `${C}/google/mirrored-events`, NO_BODY],
  ['g mirrored mem', 'DELETE', `${C}/google/mirrored-events`, NO_BODY, { actor: 'mem' }],
  restore(true),
  ['g auth restore', 'GET', `${C}/google/auth`, NO_BODY],
  ['g callback restore', 'GET', `${C}/google/callback?code=abc&state=s`, NO_BODY, { state: 's' }],
  ['g calendars restore', 'GET', `${C}/google/calendars`, NO_BODY],
  restore(false),

  // ══ DEFAULT ASSIGNEES OF A CALENDAR (google.js PATCH /external-calendars) ═══
  ['ext set synced', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com', default_assignee_user_ids: [MEM, ADMIN] }],
  ['ext set offered', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'offered@group.calendar.google.com', default_assignee_user_id: MEM }],
  ['ext clear', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com' }],
  ['ext set single null', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com', default_assignee_user_id: null }],
  ['ext unknown', 'PATCH', `${C}/external-calendars`, { source: 'caldav', external_id: 'https://nowhere.invalid/cal/' }],
  ['ext apple unknown', 'PATCH', `${C}/external-calendars`, { source: 'apple', external_id: 'apple-1' }],
  ['ext source bad', 'PATCH', `${C}/external-calendars`, { source: 'outlook', external_id: 'x' }],
  ['ext id spaces', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: '   ' }],
  ['ext id number', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 5 }],
  ['ext ids text', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com', default_assignee_user_ids: ['2'] }],
  ['ext ids guest', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com', default_assignee_user_ids: [GUEST] }],
  ['ext ids unknown', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com', default_assignee_user_ids: [999] }],
  ['ext ids twice', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com', default_assignee_user_ids: [MEM, MEM] }],
  ['ext both forms', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com', default_assignee_user_ids: [MEM], default_assignee_user_id: ADMIN }],
  ['ext no body', 'PATCH', `${C}/external-calendars`, NO_BODY],
  ['ext mem', 'PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com' }, { actor: 'mem' }],

  // ══ BACKFILL OF THE DEFAULT ASSIGNEES (google.js) ══════════════════════════
  ['bf count', 'GET', `${C}/external-calendars/default-assignee-backfill`, NO_BODY],
  ['bf count cursor bad', 'GET', `${C}/external-calendars/default-assignee-backfill?moved_after=abc`, NO_BODY],
  ['bf count cursor empty', 'GET', `${C}/external-calendars/default-assignee-backfill?moved_after=`, NO_BODY],
  ['bf count cursor twice', 'GET', `${C}/external-calendars/default-assignee-backfill?moved_after=a&moved_after=b`, NO_BODY],
  ['bf count mem', 'GET', `${C}/external-calendars/default-assignee-backfill`, NO_BODY, { actor: 'mem' }],
  ['bf confirm', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0 }],
  ['bf confirm token', 'POST', `${C}/external-calendars/default-assignee-backfill`, () => ({ expected_count: 0, expected_token: answered['bf count'].body.data.token, moves: [] })],
  ['bf confirm token null', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, expected_token: null, moves: null }],
  ['bf confirm count changed', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 3 }],
  ['bf confirm token changed', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, expected_token: HEX }],
  ['bf confirm move not offered', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [MOVE()] }],
  ['bf confirm move legacy', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [{ event_id: 1, from_user_id: ADMIN, to_user_id: MEM }] }],
  ['bf confirm count text', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: '0' }],
  ['bf confirm count minus', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: -1 }],
  ['bf confirm count fraction', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 1.5 }],
  ['bf confirm count null', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: null }],
  ['bf confirm count missing', 'POST', `${C}/external-calendars/default-assignee-backfill`, {}],
  ['bf confirm no body', 'POST', `${C}/external-calendars/default-assignee-backfill`, NO_BODY],
  ['bf confirm token short', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, expected_token: 'abc' }],
  ['bf confirm token upper', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, expected_token: 'A'.repeat(64) }],
  ['bf confirm token number', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, expected_token: 5 }],
  ['bf confirm token long', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, expected_token: `${HEX}a` }],
  ['bf confirm token empty', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, expected_token: '' }],
  ['bf confirm moves text', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: 'x' }],
  ['bf confirm moves object', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: {} }],
  ['bf confirm move empty', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [{}] }],
  ['bf confirm move id text', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [MOVE({ event_id: '1' })] }],
  ['bf confirm move id zero', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [MOVE({ event_id: 0 })] }],
  ['bf confirm move no people', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [{ event_id: 1 }] }],
  ['bf confirm move no target', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [{ event_id: 1, from_user_ids: [ADMIN] }] }],
  ['bf confirm move twice', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [MOVE(), MOVE()] }],
  ['bf confirm move people empty', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [MOVE({ to_user_ids: [] })] }],
  ['bf confirm move people text', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [MOVE({ to_user_ids: ['2'] })] }],
  ['bf confirm move people many', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: [MOVE({ to_user_ids: Array.from({ length: 101 }, (_, i) => i + 1) })] }],
  ['bf confirm moves too many', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0, moves: Array.from({ length: movedCandidatesLimit.max + 1 }, (_, i) => MOVE({ event_id: i + 1 })) }],
  ['bf confirm mem', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0 }, { actor: 'mem' }],
  ['bf confirm mem bad', 'POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 'x' }, { actor: 'mem' }],

  // ══ GOOGLE with its variables: requests to the stand-in ════════════════════
  () => { googleEnv(true); },
  ['g status configured', 'GET', `${C}/google/status`, NO_BODY],
  ['g status configured mem', 'GET', `${C}/google/status`, NO_BODY, { actor: 'mem' }],
  ['g status configured display', 'GET', `${C}/google/status`, NO_BODY, { actor: 'display' }],
  ['g auth', 'GET', `${C}/google/auth`, NO_BODY],
  ['g calendars not connected', 'GET', `${C}/google/calendars`, NO_BODY],
  ['g sync not connected', 'POST', `${C}/google/sync`, {}],
  connectGoogle,
  ['g calendars', 'GET', `${C}/google/calendars`, NO_BODY],
  ['g select', 'PATCH', `${C}/google/calendars`, { calendarId: 'fam@group.calendar.google.com', enabled: true }],
  ['g select trimmed', 'PATCH', `${C}/google/calendars`, { calendarId: ' fam@group.calendar.google.com ', enabled: true }],
  ['g sync', 'POST', `${C}/google/sync`, {}],
  () => { googleMode.mode = 'http500'; },
  ['g calendars refused', 'GET', `${C}/google/calendars`, NO_BODY],
  ['g sync refused', 'POST', `${C}/google/sync`, {}],
  ['g select refused', 'PATCH', `${C}/google/calendars`, { calendarId: 'fam@group.calendar.google.com', enabled: false }],
  () => { googleMode.mode = 'ok'; setConfig('google_needs_reauth', '1'); },
  ['g status reauth', 'GET', `${C}/google/status`, NO_BODY],
  ['g calendars reauth', 'GET', `${C}/google/calendars`, NO_BODY],
  ['g select reauth', 'PATCH', `${C}/google/calendars`, { calendarId: 'fam@group.calendar.google.com', enabled: true }],
  ['g sync reauth', 'POST', `${C}/google/sync`, {}],
  ['g disconnect connected', 'DELETE', `${C}/google/disconnect?deleteEvents=true`, NO_BODY],
  () => { googleEnv(false); },

  // ══ APPLE (apple.js) ═══════════════════════════════════════════════════════
  ['a status', 'GET', `${C}/apple/status`, NO_BODY],
  ['a status mem', 'GET', `${C}/apple/status`, NO_BODY, { actor: 'mem' }],
  ['a status display', 'GET', `${C}/apple/status`, NO_BODY, { actor: 'display' }],
  ['a sync not connected', 'POST', `${C}/apple/sync`, {}],
  ['a sync mem', 'POST', `${C}/apple/sync`, {}, { actor: 'mem' }],
  ['a connect url ftp', 'POST', `${C}/apple/connect`, { url: 'ftp://caldav.invalid', username: 'me@example.invalid', password: 'app-pass' }],
  ['a connect url empty', 'POST', `${C}/apple/connect`, { url: '', username: 'me@example.invalid', password: 'app-pass' }],
  ['a connect url number', 'POST', `${C}/apple/connect`, { url: 5, username: 'me@example.invalid', password: 'app-pass' }],
  ['a connect url missing', 'POST', `${C}/apple/connect`, { username: 'me@example.invalid', password: 'app-pass' }],
  ['a connect user empty', 'POST', `${C}/apple/connect`, { url: dav.url, username: '', password: 'app-pass' }],
  ['a connect user long', 'POST', `${C}/apple/connect`, { url: dav.url, username: LONG(255), password: 'app-pass' }],
  ['a connect user number', 'POST', `${C}/apple/connect`, { url: dav.url, username: 5, password: 'app-pass' }],
  ['a connect user missing', 'POST', `${C}/apple/connect`, { url: dav.url, password: 'app-pass' }],
  ['a connect password empty', 'POST', `${C}/apple/connect`, { url: dav.url, username: 'me@example.invalid', password: '' }],
  ['a connect password spaces', 'POST', `${C}/apple/connect`, { url: dav.url, username: 'me@example.invalid', password: '   ' }],
  ['a connect password long', 'POST', `${C}/apple/connect`, { url: dav.url, username: 'me@example.invalid', password: LONG(4097) }],
  ['a connect password number', 'POST', `${C}/apple/connect`, { url: dav.url, username: 'me@example.invalid', password: 5 }],
  ['a connect password missing', 'POST', `${C}/apple/connect`, { url: dav.url, username: 'me@example.invalid' }],
  ['a connect no body', 'POST', `${C}/apple/connect`, NO_BODY],
  ['a connect mem', 'POST', `${C}/apple/connect`, { url: dav.url, username: 'me@example.invalid', password: 'app-pass' }, { actor: 'mem' }],
  ['a connect mem bad', 'POST', `${C}/apple/connect`, { url: 5 }, { actor: 'mem' }],
  ['a connect no calendars', 'POST', `${C}/apple/connect`, { url: empty.url, username: 'me@example.invalid', password: 'app-pass' }],
  () => { empty.refuse({ method: 'PROPFIND', status: 401 }); },
  ['a connect refused', 'POST', `${C}/apple/connect`, { url: empty.url, username: 'me@example.invalid', password: 'wrong' }],
  () => { empty.allowAll(); },
  ['a status after refused', 'GET', `${C}/apple/status`, NO_BODY],
  ['a connect url leading space', 'POST', `${C}/apple/connect`, { url: ` ${dav.url}`, username: 'me@example.invalid', password: 'app-pass' }],
  ['a connect', 'POST', `${C}/apple/connect`, { url: `${dav.url} `, username: ' me@example.invalid ', password: ' app-pass ' }],
  ['a status connected', 'GET', `${C}/apple/status`, NO_BODY],
  ['a status connected display', 'GET', `${C}/apple/status`, NO_BODY, { actor: 'display' }],
  ['a sync', 'POST', `${C}/apple/sync`, {}],
  ['a sync no body', 'POST', `${C}/apple/sync`, NO_BODY],
  () => { dav.refuse({ method: 'PROPFIND', status: 503 }); },
  ['a sync refused', 'POST', `${C}/apple/sync`, {}],
  () => { dav.allowAll(); },
  ['a mirrored', 'DELETE', `${C}/apple/mirrored-events`, NO_BODY],
  ['a mirrored mem', 'DELETE', `${C}/apple/mirrored-events`, NO_BODY, { actor: 'mem' }],
  ['a disconnect one', 'DELETE', `${C}/apple/disconnect?deleteEvents=1`, NO_BODY],
  ['a disconnect mem', 'DELETE', `${C}/apple/disconnect`, NO_BODY, { actor: 'mem' }],
  ['a disconnect', 'DELETE', `${C}/apple/disconnect?deleteEvents=true`, NO_BODY],
  ['a disconnect again', 'DELETE', `${C}/apple/disconnect?deleteEvents=false`, NO_BODY],

  // ══ CALDAV ACCOUNTS (caldav.js) ════════════════════════════════════════════
  ['cd add', 'POST', `${C}/caldav/accounts`, { name: 'Familie', caldavUrl: dav.url, username: 'u', password: ' p ' }],
  ['cd add duplicate', 'POST', `${C}/caldav/accounts`, { name: 'Doppelt', caldavUrl: dav.url, username: 'u', password: 'p' }],
  ['cd add second', 'POST', `${C}/caldav/accounts`, { name: 'Zweites', caldavUrl: dav.url, username: 'v', password: 'p' }],
  ['cd add no calendars', 'POST', `${C}/caldav/accounts`, { name: 'Leer', caldavUrl: empty.url, username: 'u', password: 'p' }],
  () => { empty.refuse({ method: 'PROPFIND', status: 401 }); },
  ['cd add refused', 'POST', `${C}/caldav/accounts`, { name: 'Abgelehnt', caldavUrl: empty.url, username: 'u', password: 'p' }],
  () => { empty.allowAll(); },
  ['cd add name empty', 'POST', `${C}/caldav/accounts`, { name: '', caldavUrl: dav.url, username: 'u', password: 'p' }],
  ['cd add url empty', 'POST', `${C}/caldav/accounts`, { name: 'N', caldavUrl: '', username: 'u', password: 'p' }],
  ['cd add password empty', 'POST', `${C}/caldav/accounts`, { name: 'N', caldavUrl: dav.url, username: 'u', password: '' }],
  ['cd add password spaces', 'POST', `${C}/caldav/accounts`, { name: 'N', caldavUrl: dav.url, username: 'u', password: '   ' }],
  ['cd add password long', 'POST', `${C}/caldav/accounts`, { name: 'N', caldavUrl: dav.url, username: 'u', password: LONG(4097) }],
  ['cd add name number', 'POST', `${C}/caldav/accounts`, { name: 5, caldavUrl: dav.url, username: 'u', password: 'p' }],
  ['cd add name missing', 'POST', `${C}/caldav/accounts`, { caldavUrl: dav.url, username: 'u', password: 'p' }],
  ['cd add password number', 'POST', `${C}/caldav/accounts`, { name: 'N', caldavUrl: dav.url, username: 'u', password: 5 }],
  ['cd add no body', 'POST', `${C}/caldav/accounts`, NO_BODY],
  ['cd add mem', 'POST', `${C}/caldav/accounts`, { name: 'N', caldavUrl: dav.url, username: 'u', password: 'p' }, { actor: 'mem' }],
  ['cd add mem bad', 'POST', `${C}/caldav/accounts`, { name: 5 }, { actor: 'mem' }],
  ['cd accounts', 'GET', `${C}/caldav/accounts`, NO_BODY],
  ['cd accounts mem', 'GET', `${C}/caldav/accounts`, NO_BODY, { actor: 'mem' }],
  ['cd update name', 'PUT', CD(), { name: 'Familie' }],
  ['cd update same password', 'PUT', CD(), { password: ' p ' }],
  ['cd update new server no password', 'PUT', CD(), { caldavUrl: empty.url }],
  ['cd update new user no password', 'PUT', CD(), { username: 'w' }],
  ['cd update password long', 'PUT', CD(), { password: LONG(4097) }],
  ['cd update password spaces', 'PUT', CD(), { password: '   ' }],
  ['cd update password empty', 'PUT', CD(), { password: '' }],
  ['cd update empty', 'PUT', CD(), {}],
  ['cd update name number', 'PUT', CD(), { name: 5 }],
  ['cd update no body', 'PUT', CD(), NO_BODY],
  () => { empty.refuse({ method: 'PROPFIND', status: 401 }); },
  ['cd update refused', 'PUT', CD(), { caldavUrl: empty.url, password: 'p' }],
  () => { empty.allowAll(); },
  ['cd update unknown', 'PUT', `${C}/caldav/accounts/999`, { name: 'Weg' }],
  ['cd update unknown password long', 'PUT', `${C}/caldav/accounts/999`, { password: LONG(4097) }],
  ['cd update zero', 'PUT', `${C}/caldav/accounts/0`, { name: 'Null' }],
  ['cd update minus', 'PUT', `${C}/caldav/accounts/-1`, { name: 'Minus' }],
  ['cd update minus zero', 'PUT', `${C}/caldav/accounts/-0`, { name: 'Minus Null' }],
  ['cd update leading zero', 'PUT', () => `${C}/caldav/accounts/0${caldavId('Familie')}`, { name: 'Familie' }],
  ['cd update letters', 'PUT', `${C}/caldav/accounts/1abc`, { name: 'Text' }],
  ['cd update fraction', 'PUT', `${C}/caldav/accounts/1.0`, { name: 'Bruch' }],
  ['cd update mem', 'PUT', CD(), { name: 'Mitglied' }, { actor: 'mem' }],
  ['cd update mem bad', 'PUT', `${C}/caldav/accounts/abc`, { name: 5 }, { actor: 'mem' }],

  // ══ CALDAV CALENDARS (caldav.js) ═══════════════════════════════════════════
  ['cd calendars', 'GET', CD('/calendars'), NO_BODY],
  ['cd calendars refresh', 'GET', CD('/calendars?refresh=true'), NO_BODY],
  ['cd calendars refresh false', 'GET', CD('/calendars?refresh=false'), NO_BODY],
  ['cd calendars refresh one', 'GET', CD('/calendars?refresh=1'), NO_BODY],
  ['cd calendars unknown', 'GET', `${C}/caldav/accounts/999/calendars`, NO_BODY],
  ['cd calendars zero', 'GET', `${C}/caldav/accounts/0/calendars`, NO_BODY],
  ['cd calendars minus zero', 'GET', `${C}/caldav/accounts/-0/calendars`, NO_BODY],
  ['cd calendars leading zero', 'GET', () => `${C}/caldav/accounts/0${caldavId('Familie')}/calendars`, NO_BODY],
  ['cd calendars letters', 'GET', `${C}/caldav/accounts/abc/calendars`, NO_BODY],
  ['cd calendars mem', 'GET', CD('/calendars'), NO_BODY, { actor: 'mem' }],
  () => { dav.refuse({ method: 'PROPFIND', status: 401 }); },
  ['cd calendars refresh refused', 'GET', CD('/calendars?refresh=true'), NO_BODY],
  () => { dav.allowAll(); },
  ['cd select on', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL, enabled: true }],
  ['cd select off', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL, enabled: false, deleteEvents: true }],
  ['cd select off keep', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL, enabled: false, deleteEvents: false }],
  ['cd select url empty', 'PATCH', CD('/calendars'), { calendarUrl: '', enabled: true }],
  ['cd select url number', 'PATCH', CD('/calendars'), { calendarUrl: 5, enabled: true }],
  ['cd select url missing', 'PATCH', CD('/calendars'), { enabled: true }],
  ['cd select enabled missing', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL }],
  ['cd select enabled text', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL, enabled: 'false' }],
  ['cd select enabled null', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL, enabled: null }],
  ['cd select delete text', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL, enabled: false, deleteEvents: 'true' }],
  ['cd select delete null', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL, enabled: false, deleteEvents: null }],
  ['cd select url empty delete text', 'PATCH', CD('/calendars'), { calendarUrl: '', enabled: true, deleteEvents: 'x' }],
  ['cd select calendar unknown', 'PATCH', CD('/calendars'), { calendarUrl: 'https://nowhere.invalid/cal/', enabled: true }],
  ['cd select unknown', 'PATCH', `${C}/caldav/accounts/999/calendars`, { calendarUrl: CAL_URL, enabled: true }],
  ['cd select unknown url empty', 'PATCH', `${C}/caldav/accounts/999/calendars`, { calendarUrl: '', enabled: true }],
  ['cd select zero', 'PATCH', `${C}/caldav/accounts/0/calendars`, { calendarUrl: CAL_URL, enabled: true }],
  ['cd select minus', 'PATCH', `${C}/caldav/accounts/-1/calendars`, { calendarUrl: CAL_URL, enabled: true }],
  ['cd select letters', 'PATCH', `${C}/caldav/accounts/x/calendars`, { calendarUrl: CAL_URL, enabled: true }],
  ['cd select no body', 'PATCH', CD('/calendars'), NO_BODY],
  ['cd select mem', 'PATCH', CD('/calendars'), { calendarUrl: CAL_URL, enabled: true }, { actor: 'mem' }],
  ['cd sync', 'POST', `${C}/caldav/sync`, NO_BODY],
  ['cd sync body', 'POST', `${C}/caldav/sync`, {}],
  ['cd sync mem', 'POST', `${C}/caldav/sync`, NO_BODY, { actor: 'mem' }],
  ['cd status', 'GET', `${C}/caldav/status`, NO_BODY],
  ['cd status mem', 'GET', `${C}/caldav/status`, NO_BODY, { actor: 'mem' }],
  ['cd status child', 'GET', `${C}/caldav/status`, NO_BODY, { actor: 'child' }],
  ['cd status display', 'GET', `${C}/caldav/status`, NO_BODY, { actor: 'display' }],
  restore(true),
  ['cd calendars restore', 'GET', CD('/calendars?refresh=true'), NO_BODY],
  ['cd lists restore', 'GET', CD('/reminder-lists'), NO_BODY],
  restore(false),

  // ══ CALDAV REMINDER LISTS (caldav.js) ══════════════════════════════════════
  ['cd lists', 'GET', CD('/reminder-lists'), NO_BODY],
  ['cd lists refresh', 'GET', CD('/reminder-lists?refresh=true'), NO_BODY],
  ['cd lists refresh one', 'GET', CD('/reminder-lists?refresh=1'), NO_BODY],
  ['cd lists unknown', 'GET', `${C}/caldav/accounts/999/reminder-lists`, NO_BODY],
  ['cd lists minus', 'GET', `${C}/caldav/accounts/-1/reminder-lists`, NO_BODY],
  ['cd lists letters', 'GET', `${C}/caldav/accounts/1e0/reminder-lists`, NO_BODY],
  ['cd lists mem', 'GET', CD('/reminder-lists'), NO_BODY, { actor: 'mem' }],
  () => { dav.refuse({ method: 'PROPFIND', status: 503 }); },
  ['cd lists refresh refused', 'GET', CD('/reminder-lists?refresh=true'), NO_BODY],
  () => { dav.allowAll(); },
  ['cd list on', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, enabled: true }],
  ['cd list target shopping', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, targetModule: 'shopping' }],
  ['cd list assignees on shopping', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserIds: [MEM] }],
  ['cd list target tasks', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, targetModule: 'tasks' }],
  ['cd list assignees', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserIds: [MEM, ADMIN] }],
  ['cd list assignee single', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserId: MEM }],
  ['cd list assignee null', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserId: null }],
  ['cd list assignees guest', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserIds: [GUEST] }],
  ['cd list assignees unknown', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserIds: [999] }],
  ['cd list assignees zero', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserIds: [0] }],
  ['cd list assignees text', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserIds: ['2'] }],
  ['cd list both forms', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, defaultAssigneeUserIds: [MEM], defaultAssigneeUserId: ADMIN }],
  ['cd list target bad', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, targetModule: 'x' }],
  ['cd list target number', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, targetModule: 5 }],
  ['cd list enabled number', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, enabled: 0 }],
  ['cd list only url', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL }],
  ['cd list url empty', 'PATCH', CD('/reminder-lists'), { listUrl: '', enabled: true }],
  ['cd list url number', 'PATCH', CD('/reminder-lists'), { listUrl: 5, enabled: true }],
  ['cd list url missing', 'PATCH', CD('/reminder-lists'), { enabled: true }],
  ['cd list list unknown', 'PATCH', CD('/reminder-lists'), { listUrl: 'https://nowhere.invalid/list/', enabled: true }],
  ['cd list unknown', 'PATCH', `${C}/caldav/accounts/999/reminder-lists`, { listUrl: LIST_URL, enabled: true }],
  ['cd list unknown assignees guest', 'PATCH', `${C}/caldav/accounts/999/reminder-lists`, { listUrl: LIST_URL, defaultAssigneeUserIds: [GUEST] }],
  ['cd list zero', 'PATCH', `${C}/caldav/accounts/0/reminder-lists`, { listUrl: LIST_URL, enabled: true }],
  ['cd list no body', 'PATCH', CD('/reminder-lists'), NO_BODY],
  ['cd list mem', 'PATCH', CD('/reminder-lists'), { listUrl: LIST_URL, enabled: true }, { actor: 'mem' }],
  ['cd reminders sync', 'POST', `${C}/caldav/reminders/sync`, NO_BODY],
  ['cd reminders sync mem', 'POST', `${C}/caldav/reminders/sync`, NO_BODY, { actor: 'mem' }],
  ['cd reminders status', 'GET', `${C}/caldav/reminders/status`, NO_BODY],
  ['cd reminders status mem', 'GET', `${C}/caldav/reminders/status`, NO_BODY, { actor: 'mem' }],
  ['cd reminders status display', 'GET', `${C}/caldav/reminders/status`, NO_BODY, { actor: 'display' }],

  // ══ CALDAV DELETE (caldav.js) ══════════════════════════════════════════════
  ['cd delete unknown', 'DELETE', `${C}/caldav/accounts/999`, NO_BODY],
  ['cd delete zero', 'DELETE', `${C}/caldav/accounts/0`, NO_BODY],
  ['cd delete minus', 'DELETE', `${C}/caldav/accounts/-1`, NO_BODY],
  ['cd delete minus zero', 'DELETE', `${C}/caldav/accounts/-0`, NO_BODY],
  ['cd delete letters', 'DELETE', `${C}/caldav/accounts/1abc`, NO_BODY],
  ['cd delete query bad', 'DELETE', () => `${C}/caldav/accounts/${caldavId('Zweites')}?deleteEvents=TRUE`, NO_BODY],
  ['cd delete mem', 'DELETE', CD(), NO_BODY, { actor: 'mem' }],
  ['cd delete leading zero', 'DELETE', () => `${C}/caldav/accounts/0${caldavId('Zweites')}?deleteEvents=false`, NO_BODY],
  ['cd delete', 'DELETE', CD('?deleteEvents=true'), NO_BODY],
  ['cd accounts end', 'GET', `${C}/caldav/accounts`, NO_BODY],

  // ══ OUTLOOK (outlook.js) ═══════════════════════════════════════════════════
  seedOutlook,
  ['o status', 'GET', `${C}/outlook/status`, NO_BODY],
  ['o status mem', 'GET', `${C}/outlook/status`, NO_BODY, { actor: 'mem' }],
  ['o status display', 'GET', `${C}/outlook/status`, NO_BODY, { actor: 'display' }],
  ['o auth', 'GET', `${C}/outlook/auth`, NO_BODY],
  ['o auth mem', 'GET', `${C}/outlook/auth`, NO_BODY, { actor: 'mem' }],
  ['o callback error', 'GET', `${C}/outlook/callback?error=access_denied`, NO_BODY],
  ['o callback no code', 'GET', `${C}/outlook/callback`, NO_BODY],
  ['o callback no state', 'GET', `${C}/outlook/callback?code=abc`, NO_BODY],
  ['o callback wrong state', 'GET', `${C}/outlook/callback?code=abc&state=other`, NO_BODY, { state: 'right' }],
  ['o callback refused', 'GET', `${C}/outlook/callback?code=refused&state=right`, NO_BODY, { state: 'right' }],
  ['o callback', 'GET', `${C}/outlook/callback?code=good&state=right`, NO_BODY, { state: 'right' }],
  ['o accounts', 'GET', `${C}/outlook/accounts`, NO_BODY],
  ['o accounts mem', 'GET', `${C}/outlook/accounts`, NO_BODY, { actor: 'mem' }],
  ['o update name', 'PUT', OL(), { name: 'Papa' }],
  ['o update owner', 'PUT', OL(), { ownerUserId: MEM }],
  ['o update auto sync', 'PUT', OL(), { autoSyncCalendarId: 'cal-A' }],
  ['o update auto sync off', 'PUT', OL(), { autoSyncCalendarId: null, ownerUserId: null }],
  ['o update auto sync empty', 'PUT', OL(), { autoSyncCalendarId: '' }],
  ['o update owner guest', 'PUT', OL(), { ownerUserId: GUEST }],
  ['o update owner unknown', 'PUT', OL(), { ownerUserId: 999 }],
  ['o update owner text', 'PUT', OL(), { ownerUserId: '2' }],
  ['o update owner empty', 'PUT', OL(), { ownerUserId: '' }],
  ['o update name number', 'PUT', OL(), { name: 5 }],
  ['o update name empty', 'PUT', OL(), { name: '' }],
  ['o update auto sync unknown', 'PUT', OL(), { autoSyncCalendarId: 'nope' }],
  ['o update empty', 'PUT', OL(), {}],
  ['o update no body', 'PUT', OL(), NO_BODY],
  ['o update unknown', 'PUT', `${C}/outlook/accounts/999`, { name: 'Weg' }],
  ['o update zero', 'PUT', `${C}/outlook/accounts/0`, { name: 'Null' }],
  ['o update minus', 'PUT', `${C}/outlook/accounts/-1`, { name: 'Minus' }],
  ['o update minus zero', 'PUT', `${C}/outlook/accounts/-0`, { name: 'Minus Null' }],
  ['o update leading zero', 'PUT', () => `${C}/outlook/accounts/0${outlookId('Papa')}`, { name: 'Papa' }],
  ['o update letters', 'PUT', `${C}/outlook/accounts/1abc`, { name: 'Text' }],
  ['o update mem', 'PUT', OL(), { name: 'Mitglied' }, { actor: 'mem' }],
  ['o calendars', 'GET', OL('/calendars'), NO_BODY],
  ['o calendars refresh', 'GET', OL('/calendars?refresh=true'), NO_BODY],
  ['o calendars refresh one', 'GET', OL('/calendars?refresh=1'), NO_BODY],
  ['o calendars expired refresh', 'GET', () => `${C}/outlook/accounts/${outlookId('Abgelaufen')}/calendars?refresh=true`, NO_BODY],
  () => { graph.mode = 'http500'; },
  ['o calendars refused', 'GET', OL('/calendars?refresh=true'), NO_BODY],
  ['o sync refused', 'POST', `${C}/outlook/sync`, NO_BODY],
  () => { graph.mode = 'ok'; },
  ['o calendars unknown', 'GET', `${C}/outlook/accounts/999/calendars`, NO_BODY],
  ['o calendars zero', 'GET', `${C}/outlook/accounts/0/calendars`, NO_BODY],
  ['o calendars leading zero', 'GET', () => `${C}/outlook/accounts/0${outlookId('Papa')}/calendars`, NO_BODY],
  ['o calendars letters', 'GET', `${C}/outlook/accounts/x/calendars`, NO_BODY],
  ['o calendars mem', 'GET', OL('/calendars'), NO_BODY, { actor: 'mem' }],
  seedOverride,
  ['o select overrides', 'PATCH', OL('/calendars'), { calendarId: 'cal-A', enabled: true }],
  ['o update auto sync overrides', 'PUT', OL(), { autoSyncCalendarId: 'cal-A', ownerUserId: ADMIN }],
  dropOverride,
  ['o select', 'PATCH', OL('/calendars'), { calendarId: 'cal-A', enabled: true }],
  ['o select off', 'PATCH', OL('/calendars'), { calendarId: 'cal-A', enabled: false }],
  ['o select id empty', 'PATCH', OL('/calendars'), { calendarId: '', enabled: true }],
  ['o select id spaces', 'PATCH', OL('/calendars'), { calendarId: '  ', enabled: true }],
  ['o select id number', 'PATCH', OL('/calendars'), { calendarId: 5, enabled: true }],
  ['o select id missing', 'PATCH', OL('/calendars'), { enabled: true }],
  ['o select enabled text', 'PATCH', OL('/calendars'), { calendarId: 'cal-A', enabled: 'true' }],
  ['o select enabled missing', 'PATCH', OL('/calendars'), { calendarId: 'cal-A' }],
  ['o select id empty enabled text', 'PATCH', OL('/calendars'), { calendarId: '', enabled: 'x' }],
  ['o select calendar unknown', 'PATCH', OL('/calendars'), { calendarId: 'nope', enabled: true }],
  ['o select unknown', 'PATCH', `${C}/outlook/accounts/999/calendars`, { calendarId: 'cal-A', enabled: true }],
  ['o select unknown id empty', 'PATCH', `${C}/outlook/accounts/999/calendars`, { calendarId: '', enabled: true }],
  ['o select zero', 'PATCH', `${C}/outlook/accounts/0/calendars`, { calendarId: 'cal-A', enabled: true }],
  ['o select no body', 'PATCH', OL('/calendars'), NO_BODY],
  ['o select mem', 'PATCH', OL('/calendars'), { calendarId: 'cal-A', enabled: true }, { actor: 'mem' }],
  ['o sync', 'POST', `${C}/outlook/sync`, NO_BODY],
  ['o sync mem', 'POST', `${C}/outlook/sync`, NO_BODY, { actor: 'mem' }],
  ['o status accounts', 'GET', `${C}/outlook/status`, NO_BODY],
  ['o status accounts display', 'GET', `${C}/outlook/status`, NO_BODY, { actor: 'display' }],
  restore(true),
  ['o auth restore', 'GET', `${C}/outlook/auth`, NO_BODY],
  ['o callback restore', 'GET', `${C}/outlook/callback?code=good&state=s`, NO_BODY, { state: 's' }],
  ['o calendars restore', 'GET', OL('/calendars?refresh=true'), NO_BODY],
  restore(false),
  ['o delete unknown', 'DELETE', `${C}/outlook/accounts/999`, NO_BODY],
  ['o delete zero', 'DELETE', `${C}/outlook/accounts/0`, NO_BODY],
  ['o delete minus zero', 'DELETE', `${C}/outlook/accounts/-0`, NO_BODY],
  ['o delete letters', 'DELETE', `${C}/outlook/accounts/1.0`, NO_BODY],
  ['o delete mem', 'DELETE', OL(), NO_BODY, { actor: 'mem' }],
  ['o delete leading zero', 'DELETE', () => `${C}/outlook/accounts/0${outlookId('Abgelaufen')}`, NO_BODY],
  ['o delete', 'DELETE', OL(), NO_BODY],
  () => { msEnv(false); },
  ['o auth unconfigured', 'GET', `${C}/outlook/auth`, NO_BODY],
  ['o accounts unconfigured', 'GET', `${C}/outlook/accounts`, NO_BODY],
  ['o calendars unconfigured', 'GET', `${C}/outlook/accounts/999/calendars`, NO_BODY],
  ['o sync unconfigured', 'POST', `${C}/outlook/sync`, NO_BODY],
  ['o status unconfigured', 'GET', `${C}/outlook/status`, NO_BODY],
  () => { msEnv(true); },
  ['o accounts end', 'GET', `${C}/outlook/accounts`, NO_BODY],
];

/**
 * @param {Record<string, { status: number, body: unknown, location?: string }>} answers
 * @param {Record<string, string[]>} logs the lines of the central handler per row
 */
async function runTable(answers, logs) {
  for (const step of STEPS) {
    if (typeof step === 'function') { await step(); continue; }
    const [name, method, route, body, opts] = step;
    assert.ok(!Object.hasOwn(answers, name), `duplicate row name ${name}`);
    logged.error.length = 0;
    const actual = await call(method, typeof route === 'function' ? route() : route, typeof body === 'function' ? body() : body, opts);
    answered[name] = actual;
    answers[name] = actual.location === undefined
      ? { status: actual.status, body: normalized(actual.body) }
      : { status: actual.status, body: normalized(actual.body), location: masked(actual.location) };
    if (logged.error.length) logs[name] = logged.error.splice(0);
  }
  return answers;
}

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  /** @type {Record<string, { status: number, body: unknown }>} */
  const answers = {};
  /** @type {Record<string, string[]>} */
  const logs = {};
  try {
    await runTable(answers, logs);
  } finally {
    if (process.env.G10B_DUMP) fs.writeFileSync(process.env.G10B_DUMP, JSON.stringify({ answers, logs, foreign }));
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
  // The rows that changed on purpose are the 500s the central handler answers
  // now; the CENTRAL rows reached it already before.
  /** @type {Record<string, string[]>} */
  const central = {};
  for (const [name, row] of Object.entries(CHANGED)) central[name] = [row.log];
  for (const [name, line] of Object.entries(CENTRAL)) central[name] = [line];
  assert.deepEqual(logs, Object.fromEntries(Object.keys(answers).filter((n) => central[n]).map((n) => [n, central[n]])), 'only these rows reached the central handler');
  // The stand-ins were asked, nothing else outside this machine.
  assert.ok(foreign.google.length > 0, 'the Google stand-in was asked');
  assert.ok(foreign.graph.length > 0, 'the Graph stand-in was asked');
});

// ── Unexpected errors: the central error handler ────────────────────────────
/**
 * The answer and the log line of the central handler.
 * @param {{ status: number, body: unknown }} res
 * @param {string} method
 * @param {string} pattern
 */
function assertCentral(res, method, pattern) {
  assert.deepEqual({ status: res.status, body: res.body }, { status: 500, body: { error: 'Internal server error.', code: 500 } }, `${method} ${pattern}`);
  assert.deepEqual(logged.error, [`Unhandled error: ${method} ${pattern} -> 500`], `${method} ${pattern}: the central handler logged it`);
  logged.error.length = 0;
}

/**
 * Each request in turn with a handler whose first answer throws.
 * @param {Array<[string, string | (() => string), unknown, string]>} rows [method, path under /api/v1, body, route pattern]
 */
async function assertAllCentral(rows) {
  for (const [method, route, body, pattern] of rows) {
    assertCentral(await call(method, typeof route === 'function' ? route() : route, body, { fail: true }), method, pattern);
  }
}

const C_ = '/api/v1/calendar';
/** A CalDAV account on the fake server with one calendar and one reminder list, stored by hand. */
function caldavAccount(name = 'Probe') {
  const id = Number(database().prepare("INSERT INTO caldav_accounts (name, caldav_url, username, password, reminders_discovered_at) VALUES (?, ?, ?, 'p', '2035-01-01T00:00:00Z')")
    .run(name, dav.url, `u-${name}`).lastInsertRowid);
  database().prepare('INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled) VALUES (?, ?, \'Cal\', \'#336699\', 0)').run(id, CAL_URL);
  database().prepare("INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled) VALUES (?, ?, 'List', 'tasks', 0)").run(id, LIST_URL);
  return id;
}
function outlookAccount(name = 'Probe') {
  const id = Number(database().prepare(`INSERT INTO outlook_accounts (name, ms_user_id, email, access_token, refresh_token, token_expiry)
    VALUES (?, ?, 'probe@example.invalid', 'tok', 'ref', '2099-01-01T00:00:00Z')`).run(name, `ms-probe-${name}`).lastInsertRowid);
  database().prepare("INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled) VALUES (?, 'cal-A', 'Kalender A', 1, 0)").run(id);
  return id;
}

/**
 * A database error: the trigger refuses each write of `event` on `table` (only
 * the rows `when` names, if given).
 * @param {string} table
 * @param {'INSERT' | 'UPDATE'} event
 * @param {() => Promise<void>} fn
 * @param {string} [when] an SQL condition on NEW
 */
async function withRefusedWrite(table, event, fn, when) {
  database().exec(`CREATE TRIGGER test_refuse BEFORE ${event} ON ${table} ${when ? `WHEN ${when} ` : ''}BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;`);
  try {
    await fn();
  } finally {
    database().exec('DROP TRIGGER test_refuse;');
  }
}

test('an unexpected error in each Google route that answered its own 500 is a 500 of the central handler (async POST: a rejected promise), and the process goes on', async () => {
  logged.error.length = 0;
  await assertAllCentral([
    ['GET', `${C}/google/status`, NO_BODY, `${C_}/google/status`],
    ['PATCH', `${C}/external-calendars`, { source: 'google', external_id: 'synced@group.calendar.google.com' }, `${C_}/external-calendars`],
    ['GET', `${C}/external-calendars/default-assignee-backfill`, NO_BODY, `${C_}/external-calendars/default-assignee-backfill`],
    ['POST', `${C}/external-calendars/default-assignee-backfill`, { expected_count: 0 }, `${C_}/external-calendars/default-assignee-backfill`],
    ['DELETE', `${C}/google/disconnect`, NO_BODY, `${C_}/google/disconnect`],
    ['DELETE', `${C}/google/mirrored-events`, NO_BODY, `${C_}/google/mirrored-events`],
    ['PUT', `${C}/google/readonly`, { readonly: true }, `${C_}/google/readonly`],
  ]);
  assert.equal((await call('GET', `${C}/google/status`, NO_BODY)).status, 200);
});

test('an unexpected error in each Apple route that answered its own 500 is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  await assertAllCentral([
    ['GET', `${C}/apple/status`, NO_BODY, `${C_}/apple/status`],
    ['DELETE', `${C}/apple/disconnect`, NO_BODY, `${C_}/apple/disconnect`],
    ['DELETE', `${C}/apple/mirrored-events`, NO_BODY, `${C_}/apple/mirrored-events`],
  ]);
  assert.equal((await call('GET', `${C}/apple/status`, NO_BODY)).status, 200);
});

test('an unexpected error in each CalDAV route that answered its own 500 is a 500 of the central handler (async syncs: a rejected promise), and the process goes on', async () => {
  logged.error.length = 0;
  const id = caldavAccount('Fehler');
  await assertAllCentral([
    ['GET', `${C}/caldav/accounts`, NO_BODY, `${C_}/caldav/accounts`],
    ['PATCH', `${C}/caldav/accounts/${id}/calendars`, { calendarUrl: CAL_URL, enabled: false }, `${C_}/caldav/accounts/:id/calendars`],
    ['POST', `${C}/caldav/sync`, NO_BODY, `${C_}/caldav/sync`],
    ['GET', `${C}/caldav/status`, NO_BODY, `${C_}/caldav/status`],
    ['PATCH', `${C}/caldav/accounts/${id}/reminder-lists`, { listUrl: LIST_URL, enabled: false }, `${C_}/caldav/accounts/:id/reminder-lists`],
    ['POST', `${C}/caldav/reminders/sync`, NO_BODY, `${C_}/caldav/reminders/sync`],
    ['GET', `${C}/caldav/reminders/status`, NO_BODY, `${C_}/caldav/reminders/status`],
    ['DELETE', `${C}/caldav/accounts/${id}`, NO_BODY, `${C_}/caldav/accounts/:id`],
  ]);
  assert.equal((await call('GET', `${C}/caldav/accounts`, NO_BODY)).status, 200);
});

test('an unexpected error in each Outlook route that answered its own 500 is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const id = outlookAccount('Fehler');
  await assertAllCentral([
    ['GET', `${C}/outlook/accounts`, NO_BODY, `${C_}/outlook/accounts`],
    ['PUT', `${C}/outlook/accounts/${id}`, { name: 'Fehler 2' }, `${C_}/outlook/accounts/:id`],
    ['PATCH', `${C}/outlook/accounts/${id}/calendars`, { calendarId: 'cal-A', enabled: false }, `${C_}/outlook/accounts/:id/calendars`],
    ['GET', `${C}/outlook/status`, NO_BODY, `${C_}/outlook/status`],
    ['DELETE', `${C}/outlook/accounts/${id}`, NO_BODY, `${C_}/outlook/accounts/:id`],
  ]);
  assert.equal((await call('GET', `${C}/outlook/accounts`, NO_BODY)).status, 200);
});

test('a database error behind the failure helpers is a 500 of the central handler, not a refusal of the foreign server', async () => {
  logged.error.length = 0;
  // sendGoogleError(): PATCH /google/calendars writes the selection.
  googleEnv(true);
  connectGoogle();
  database().prepare("DELETE FROM sync_config WHERE key = 'google_needs_reauth'").run();
  try {
    await withRefusedWrite('google_calendar_selection', 'INSERT', async () => {
      assertCentral(await call('PATCH', `${C}/google/calendars`, { calendarId: 'probe@group.calendar.google.com', enabled: true }), 'PATCH', `${C_}/google/calendars`);
    });
  } finally {
    googleEnv(false);
  }
  // sendAppleFailure(): the third value of the access cannot be stored. The two
  // stored before it are cleared again on the way to the central handler.
  await withRefusedWrite('sync_config', 'INSERT', async () => {
    assertCentral(await call('POST', `${C}/apple/connect`, { url: dav.url, username: 'probe@example.invalid', password: 'app-pass' }), 'POST', `${C_}/apple/connect`);
  }, "NEW.key = 'apple_app_password'");
  assert.equal(database().prepare("SELECT COUNT(*) AS n FROM sync_config WHERE key LIKE 'apple_%'").get().n, 0, 'the Apple access is cleared');
  // sendCaldavFailure(): a new account, a changed account, a fetched calendar list and reminder list.
  await withRefusedWrite('caldav_accounts', 'INSERT', async () => {
    assertCentral(await call('POST', `${C}/caldav/accounts`, { name: 'Probe', caldavUrl: dav.url, username: 'probe', password: 'p' }), 'POST', `${C_}/caldav/accounts`);
  });
  const id = caldavAccount('Helfer');
  await withRefusedWrite('caldav_accounts', 'UPDATE', async () => {
    assertCentral(await call('PUT', `${C}/caldav/accounts/${id}`, { name: 'Helfer 2' }), 'PUT', `${C_}/caldav/accounts/:id`);
  });
  await withRefusedWrite('caldav_calendar_selection', 'UPDATE', async () => {
    assertCentral(await call('GET', `${C}/caldav/accounts/${id}/calendars?refresh=true`, NO_BODY), 'GET', `${C_}/caldav/accounts/:id/calendars`);
  });
  await withRefusedWrite('caldav_reminder_selection', 'UPDATE', async () => {
    assertCentral(await call('GET', `${C}/caldav/accounts/${id}/reminder-lists?refresh=true`, NO_BODY), 'GET', `${C_}/caldav/accounts/:id/reminder-lists`);
  });
  // sendOutlookFailure(): the fetched calendar list cannot be stored.
  const ol = outlookAccount('Helfer');
  await withRefusedWrite('outlook_calendar_selection', 'UPDATE', async () => {
    assertCentral(await call('GET', `${C}/outlook/accounts/${ol}/calendars?refresh=true`, NO_BODY), 'GET', `${C_}/outlook/accounts/:id/calendars`);
  });
  // Each route answers again.
  assert.equal((await call('GET', `${C}/caldav/accounts/${id}/calendars`, NO_BODY)).status, 200);
  assert.equal((await call('GET', `${C}/outlook/accounts/${ol}/calendars`, NO_BODY)).status, 200);
});

// ── Handled cases ───────────────────────────────────────────────────────────
test('a failing OAuth callback goes back to the settings, never to JSON or the central handler', async () => {
  logged.error.length = 0;
  // The exchange succeeds, storing the account (known from the table) fails: a database error inside the callback.
  await withRefusedWrite('outlook_accounts', 'UPDATE', async () => {
    const res = await call('GET', `${C}/outlook/callback?code=good&state=probe`, NO_BODY, { state: 'probe' });
    assert.deepEqual(res, { status: 302, body: '<text>', location: '/settings?sync_error=outlook' });
  });
  // Google without its variables: the exchange throws.
  const res = await call('GET', `${C}/google/callback?code=abc&state=probe`, NO_BODY, { state: 'probe' });
  assert.deepEqual(res, { status: 302, body: '<text>', location: '/settings?sync_error=google' });
  // An unexpected error while answering (the redirect itself throws once): still the way back.
  const failed = await call('GET', `${C}/outlook/callback?error=access_denied`, NO_BODY, { fail: true });
  assert.deepEqual(failed, { status: 302, body: '<text>', location: '/settings?sync_error=outlook' });
  assert.deepEqual(logged.error, [], 'nothing reached the central handler');
});

test('the refusals of the foreign servers keep their class and detail, and never reach the central handler', async () => {
  logged.error.length = 0;
  const id = caldavAccount('Absage');
  dav.refuse({ method: 'PROPFIND', status: 401 });
  try {
    for (const route of [`${C}/caldav/accounts/${id}/calendars?refresh=true`, `${C}/caldav/accounts/${id}/reminder-lists?refresh=true`]) {
      assert.deepEqual(await call('GET', route, NO_BODY), { status: 502, body: { error: 'The CalDAV server refused the request or could not be reached.', code: 502, reason: 'remote_auth_failed', detail: 'HTTP 401' } }, route);
    }
    const apple = await call('POST', `${C}/apple/connect`, { url: dav.url, username: 'probe@example.invalid', password: 'app-pass' });
    assert.deepEqual(apple, { status: 502, body: { error: 'iCloud refused the request or could not be reached.', code: 502, reason: 'remote_auth_failed', detail: 'HTTP 401' } });
  } finally {
    dav.allowAll();
  }
  googleEnv(true);
  connectGoogle();
  googleMode.mode = 'http500';
  try {
    assert.deepEqual(await call('GET', `${C}/google/calendars`, NO_BODY), { status: 502, body: { error: 'Google refused the request or could not be reached.', code: 502, reason: 'remote_http_status', detail: 'HTTP 500', params: { status: 500 } } });
    setConfig('google_needs_reauth', '1');
    assert.deepEqual(await call('GET', `${C}/google/calendars`, NO_BODY), { status: 409, body: { error: 'Google sign-in expired - reconnect required.', code: 409, reason: 'google_reauth_required' } });
  } finally {
    googleMode.mode = 'ok';
    database().prepare("DELETE FROM sync_config WHERE key = 'google_needs_reauth'").run();
    googleEnv(false);
  }
  assert.deepEqual(await call('POST', `${C}/google/sync`, {}), { status: 409, body: { error: 'Google Calendar is not connected.', code: 409, reason: 'google_not_configured' } });
  msEnv(false);
  try {
    assert.deepEqual(await call('POST', `${C}/outlook/sync`, NO_BODY), { status: 503, body: { error: 'Outlook is not configured on this server.', code: 503, reason: 'outlook_not_configured' } });
  } finally {
    msEnv(true);
  }
  assert.deepEqual(logged.error, [], 'nothing reached the central handler');
});

// ── Sinks ───────────────────────────────────────────────────────────────────
/**
 * The handler of a route alone, without validateRequest() and whatever stands
 * in front of it in the route: the last function of its route layer.
 * @param {string} file the router module under server/routes/calendar/
 * @param {string} method lower case
 * @param {string} routePath the Express pattern of the router
 */
async function bareHandler(file, method, routePath) {
  const { default: router } = await import(`../server/routes/calendar/${file}`);
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
  }
  throw new Error(`no route ${method} ${routePath} in ${file}`);
}

/**
 * Runs a bare handler with a raw body and query as the admin; returns its answer.
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
    redirect() { return res; },
    setHeader() {},
  };
  await handler(req, res, (/** @type {unknown} */ err) => { throw err; });
  return out;
}

// The schema refuses each of these in front (the table holds that). Behind it
// a loop, `.length` or a string method runs over the raw value, so the handler
// keeps its own type check there (sink, not route; CodeQL
// js/loop-bound-injection in #2860): called without validateRequest(), each
// answers as it did instead of throwing or looping.
const NOT_TEXT = [{ length: 1e9 }, 5, ['x']];

test('sink: PATCH /google/calendars keeps the type check of calendarId in front of .trim()', async () => {
  for (const calendarId of NOT_TEXT) {
    assert.deepEqual(await callBare('google.js', 'patch', '/google/calendars', { body: { calendarId, enabled: true } }),
      { status: 400, body: { error: 'calendarId is missing or invalid.', code: 400 } }, JSON.stringify(calendarId));
  }
});

test('sink: the backfill keeps parseMoves() in front of its loop over the moves and their people', async () => {
  const route = '/external-calendars/default-assignee-backfill';
  for (const moves of [{ length: 1e9 }, 'x', 5, [5], [{ event_id: 1, from_user_ids: { length: 1e9 }, to_user_ids: [MEM] }], [{ event_id: 1, from_user_ids: [ADMIN], to_user_ids: 'x' }]]) {
    assert.deepEqual(await callBare('google.js', 'post', route, { body: { expected_count: 0, moves } }),
      { status: 400, body: { error: 'moves is invalid.', code: 400 } }, JSON.stringify(moves));
  }
  assert.deepEqual(await callBare('google.js', 'get', route, { query: { moved_after: ['a', 'b'] } }),
    { status: 400, body: { error: 'moved_after is invalid.', code: 400 } }, 'moved_after as a list');
});

test('sink: POST /apple/connect keeps the type checks of url, username and password in front of .startsWith(), .length and .trim()', async () => {
  const valid = { url: dav.url, username: 'probe@example.invalid', password: 'app-pass' };
  for (const value of NOT_TEXT) {
    assert.deepEqual(await callBare('apple.js', 'post', '/apple/connect', { body: { ...valid, url: value } }),
      { status: 400, body: { error: 'url must be a valid HTTP(S) URL.', code: 400, reason: 'apple_url_invalid' } }, `url ${JSON.stringify(value)}`);
    assert.deepEqual(await callBare('apple.js', 'post', '/apple/connect', { body: { ...valid, username: value } }),
      { status: 400, body: { error: 'username is missing or invalid.', code: 400 } }, `username ${JSON.stringify(value)}`);
    assert.deepEqual(await callBare('apple.js', 'post', '/apple/connect', { body: { ...valid, password: value } }),
      { status: 400, body: { error: 'password is missing.', code: 400 } }, `password ${JSON.stringify(value)}`);
  }
});

test('sink: the default assignees of a reminder list keep their check in front of new Set() and the lookup', async () => {
  const id = caldavAccount('Senke');
  for (const ids of [{ length: 1e9 }, 'x', [{ length: 1e9 }]]) {
    const res = await callBare('caldav.js', 'patch', '/caldav/accounts/:id/reminder-lists', { params: { id: String(id) }, body: { listUrl: LIST_URL, defaultAssigneeUserIds: ids } });
    assert.equal(res.status, 400, JSON.stringify(ids));
    assert.equal(/** @type {any} */ (res.body).reason, 'calendar_assignee_invalid', JSON.stringify(ids));
  }
});
