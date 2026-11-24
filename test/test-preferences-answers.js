/**
 * Test: the answers of the preferences and push routes stay byte-equal
 *       (#2810, phase 2 section E, group 11b, step b)
 * Purpose: server/routes/preferences.js (7 operations) and
 *          server/routes/push.js (5 operations) dropped the hand checks the
 *          schema of their operation already covers on every input
 *          (`validateRequest()` runs before every handler since #2900) and
 *          the try/catch blocks that answered an unexpected error with a 500
 *          of their own. This suite holds that refactor:
 *
 *          (1) A table of requests to all 12 operations - valid, every refusal
 *          the handlers keep (each refusal of the settings registry at
 *          `PUT /preferences`: 400 with its own sentence, 403
 *          `admin_required` for a member or a child, also with an invalid
 *          value; `checkPushEndpoint` for http, a private or local host,
 *          credentials, no URL; `unsubscribe` with `endpoint: ''`; a foreign
 *          or unknown endpoint at `unsubscribe` and `wall-mode` changing
 *          nothing; `POST /holidays/sync` for a member, a child and a display;
 *          the holiday lists with a failing service (502) and the local GB
 *          lists), every input a dropped check refused (the schema's 400
 *          before and after), the display allowlist at `GET /preferences` -
 *          for an admin, a member, a child and a paired display where it makes
 *          a difference. It pins status and the WHOLE body; probe rows pin
 *          what is stored. The expectations were written before the refactor
 *          (c8bb2f31c) and are literal values in
 *          test/preferences-answers-expected.js, no fixture file, no update
 *          mode.
 *
 *          No network: OpenHolidays is stubbed (holidays.__setFetchImpl), the
 *          push service is a stand-in that sends nothing. The clock stands
 *          still (`mock.timers`, 18.11.2026 12:00 UTC), the household lives
 *          in Europe/Berlin.
 *
 *          (2) An unexpected error reaches the central error handler - 500
 *          with its fixed sentence and its log line
 *          `Unhandled error: <METHOD> <pattern> -> 500` - and the routers keep
 *          answering: `GET /preferences`, `PUT /preferences`, a database error
 *          at `POST /holidays/sync` (a rejected promise, Express 5 hands it
 *          on), all 5 push routes (they said `Internal error.` before) and a
 *          push service whose send rejects. What the routes handle keeps its
 *          answer: the holiday lists their 502, the holiday sync its 502 with
 *          the failure class.
 *
 *          (3) `PUT /preferences` keeps its transaction: an error after the
 *          first field was written is the central handler's 500, nothing of
 *          the patch is stored, and the birthday retitle runs all the same.
 *
 *          (4) Each handler alone (without `validateRequest()`) keeps the type
 *          checks in front of a string method, `new URL()` or `.length` on the
 *          raw value (sink, not route).
 * Run: npm run test:preferences-answers
 */

process.env.SESSION_SECRET = 'preferences-answers-secret';
process.env.DB_PATH = ':memory:';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { createPreferencesApp, PREFERENCES_PREFIX, PUSH_PREFIX } from './preferences-app.js';
import { EXPECTED, CHANGED } from './preferences-answers-expected.js';

const dbmod = await import('../server/db.js');
const holidays = await import('../server/services/holidays.js');
const { buildRouter: buildPushRouter } = await import('../server/routes/push.js');
const { DISPLAY_SCOPES } = await import('../server/services/display-accounts.js');
const { resolveRequestModuleAccess } = await import('../server/authorize/index.ts');
const database = () => dbmod.get();

/** @param {string} key @param {string} value */
function setConfig(key, value) {
  database().prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
/** @param {string} key */
function dropConfig(key) {
  database().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}
/** @param {string} key */
function readConfig(key) {
  return /** @type {any} */ (database().prepare('SELECT value FROM sync_config WHERE key = ?').get(key))?.value ?? null;
}
setConfig('household_timezone', 'Europe/Berlin');
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });
const FROZEN = '2026-11-18T12:00';

// ── People ───────────────────────────────────────────────────────────────────
/** @param {string} username @param {string} role @param {string} [familyRole] */
function user(username, role, familyRole = 'parent') {
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role, avatar_color) VALUES (?, ?, 'x', ?, ?, '#336699')")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const MEM = user('tom', 'member');
const KID = user('kim', 'member', 'child');
const DISPLAY = user('wand', 'member', 'other');
database().prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(DISPLAY, ADMIN);

/** @type {Record<string, { id: number, role: string, method?: string, scopes?: string[] | null }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  kid: { id: KID, role: 'member' },
  display: { id: DISPLAY, role: 'member', method: 'display', scopes: [...DISPLAY_SCOPES] },
};

// ── Stand-ins: OpenHolidays and the push service ────────────────────────────
/** 'ok' answers, 'down' cannot connect, 'http' answers 503, 'shape' answers an object. */
let holidayMode = 'ok';
/** @param {string} lang @param {string} text */
const named = (lang, text) => ({ language: lang, text });
/** @type {Record<string, unknown>} */
const HOLIDAY_ANSWERS = {
  '/Countries': [{ isoCode: 'DE', name: [named('EN', 'Germany'), named('DE', 'Deutschland')] }, { isoCode: 'CH', name: [named('EN', 'Switzerland')] }],
  '/Subdivisions?countryIsoCode=DE': [{ code: 'DE-BY', isoCode: 'DE-BY', name: [named('EN', 'Bavaria'), named('DE', 'Bayern')], groups: [] }],
  '/Subdivisions?countryIsoCode=CH': [{ code: 'CH-BE', isoCode: 'CH-BE', name: [named('EN', 'Bern')], groups: [{ code: 'CH-BE-VS', shortName: 'VS' }, { code: 'CH-BE-EO', shortName: 'EO' }] }],
  '/Subdivisions?countryIsoCode=BE': [],
  '/Groups?countryIsoCode=BE': [{ code: 'BE-DE', name: [named('EN', 'German-speaking Community')] }, { code: 'BE-FR', name: [named('EN', 'French Community')] }],
};
holidays.__setFetchImpl(async (/** @type {unknown} */ url) => {
  const path = String(url).replace(/^https?:\/\/[^/]+(\/v1)?/, '');
  if (holidayMode === 'down') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  if (holidayMode === 'http') return { ok: false, status: 503, json: async () => ({}) };
  if (holidayMode === 'shape') return { ok: true, status: 200, json: async () => ({ unexpected: true }) };
  if (path.startsWith('/PublicHolidays')) {
    const year = /validFrom=(\d{4})/.exec(path)?.[1];
    return { ok: true, status: 200, json: async () => [{ startDate: `${year}-12-25`, endDate: `${year}-12-25`, name: [named('EN', 'Christmas Day'), named('DE', 'Weihnachtstag')] }] };
  }
  return { ok: true, status: 200, json: async () => HOLIDAY_ANSWERS[path] ?? [] };
});
const holidaysIn = (/** @type {string} */ mode) => () => { holidayMode = mode; };

/** What the stand-in push service was asked to send. @type {Array<{ userId: number, payload: any }>} */
const sentPushes = [];
let pushFails = false;
const pushService = {
  getPublicKey: () => 'PUBLIC_KEY',
  sendPushToUser: async (/** @type {number} */ userId, /** @type {any} */ payload) => {
    if (pushFails) throw new Error('the push service broke');
    sentPushes.push({ userId, payload });
    return 1;
  },
};

// ── The app ──────────────────────────────────────────────────────────────────
/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createPreferencesApp({
  log,
  mount: ['preferences'],
  // server/index.js puts the general API limiter in front; a generous one here.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  after: [[PUSH_PREFIX, buildPushRouter({ pushService, database: database() })]],
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = actor.method ?? 'session';
    req.authScopes = actor.scopes ?? null;
    req.session = { userId: actor.id, role: actor.role };
    if (actor.method === 'display') {
      req.displayShowsScreensaver = true;
      req.displayDeviceSettings = { theme: 'dark' };
    }
    req.sessionModuleAccess = resolveRequestModuleAccess(database(), req);
    // An unexpected error: the first answer of the handler throws.
    if (req.get('x-fail') === 'answer') {
      let thrown = false;
      for (const name of ['json', 'send', 'end']) {
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
const origin = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => { server.close(); holidays.__setFetchImpl(null); });

// ── Requests ─────────────────────────────────────────────────────────────────
const NO_BODY = Symbol('no body');

/** @typedef {{ actor?: string, fail?: boolean, raw?: string }} CallOptions */

/**
 * @param {string} method
 * @param {string} route the full path, `/api/v1/...`
 * @param {unknown} body a JSON value or NO_BODY
 * @param {CallOptions} [opts] `raw`: the body as sent text
 * @returns {Promise<{ status: number, body: any }>}
 */
async function call(method, route, body, { actor, fail, raw } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {any} */
  let payload;
  if (raw !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = raw;
  } else if (body !== NO_BODY) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (actor !== undefined) headers['x-actor'] = actor;
  if (fail) headers['x-fail'] = 'answer';
  const res = await fetch(`${origin}${route}`, { method, headers, body: payload });
  const text = await res.text();
  /** @type {any} */
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = '<text>'; }
  }
  return { status: res.status, body: parsed };
}

/** @param {string} value */
function masked(value) {
  // A stamp of SQLite's own clock (the frozen one stays).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) && !value.startsWith(FROZEN)) return '<stamp>';
  return value;
}

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (_key, v) => (typeof v === 'string' ? masked(v) : v));
}

const PREFS = PREFERENCES_PREFIX;
const PUSH = PUSH_PREFIX;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-admin';
const ENDPOINT_MEM = 'https://updates.push.services.mozilla.com/wpush/v2/device-mem';
const KEYS = { p256dh: 'BPublicKeyOfTheDevice', auth: 'AuthSecret' };
/** PushSubscription.toJSON() as public/push.js sends it. @param {string} endpoint */
const subscription = (endpoint) => ({ endpoint, expirationTime: null, keys: KEYS });
/** The stored subscriptions, for the probe rows. */
const subscriptions = () => database().prepare('SELECT user_id, endpoint, p256dh, auth, wall_paused_at IS NOT NULL AS paused FROM push_subscriptions ORDER BY id').all()
  .map((/** @type {any} */ row) => ({ ...row, endpoint: row.endpoint.length > 80 ? `<${row.endpoint.length} characters>` : row.endpoint }));
/** The household keys a probe row reads. */
const stored = (/** @type {string[]} */ ...keys) => Object.fromEntries(keys.map((key) => [key, readConfig(key)]));
const sent = () => sentPushes.splice(0).map(({ userId, payload }) => ({ userId, payload }));

/**
 * One row of the table: [name, method, path, body, opts?] for a request,
 * [name, 'PROBE', fn] for what is stored. Setup rows are functions.
 * @type {Array<[string, string, string, unknown, CallOptions?] | [string, 'PROBE', () => unknown] | (() => unknown)>}
 */
const STEPS = [
  // ══ GET /preferences ═══════════════════════════════════════════════════════
  ['read admin', 'GET', PREFS, NO_BODY],
  ['read mem', 'GET', PREFS, NO_BODY, { actor: 'mem' }],
  ['read kid', 'GET', PREFS, NO_BODY, { actor: 'kid' }],
  // The display allowlist (#1208).
  ['read display', 'GET', PREFS, NO_BODY, { actor: 'display' }],

  // ══ PUT /preferences: the registry stays the validator and the gate ══════
  ['put week start', 'PUT', PREFS, { week_start: 'sunday' }],
  ['put week start mem', 'PUT', PREFS, { week_start: 'monday' }, { actor: 'mem' }],
  ['put own reminders mem', 'PUT', PREFS, { calendar_default_reminders: [15, 60] }, { actor: 'mem' }],
  ['put own reminders kid', 'PUT', PREFS, { calendar_default_reminders: [30] }, { actor: 'kid' }],
  ['put date format unknown', 'PUT', PREFS, { date_format: 'xx' }],
  ['put week start number', 'PUT', PREFS, { week_start: 1 }],
  ['put reminders text', 'PUT', PREFS, { calendar_default_reminders: 'x' }],
  ['put timezone unknown', 'PUT', PREFS, { timezone: 'Mars/Base' }],
  ['put weather lat above', 'PUT', PREFS, { weather_lat: 100 }],
  ['put school color', 'PUT', PREFS, { holiday_school_color: 'kein-hex' }],
  ['put currency mem', 'PUT', PREFS, { currency: 'USD' }, { actor: 'mem' }],
  ['put currency number mem', 'PUT', PREFS, { currency: 5 }, { actor: 'mem' }],
  ['put currency text mem', 'PUT', PREFS, { currency: 'x' }, { actor: 'mem' }],
  ['put weather lat mem', 'PUT', PREFS, { weather_lat: 100 }, { actor: 'mem' }],
  ['put points text mem', 'PUT', PREFS, { tasks_default_points: 'x' }, { actor: 'mem' }],
  ['put currency kid', 'PUT', PREFS, { currency: 'USD' }, { actor: 'kid' }],
  ['put language display', 'PUT', PREFS, { language: 'en' }, { actor: 'display' }],
  ['put week start display', 'PUT', PREFS, { week_start: 'sunday' }, { actor: 'display' }],
  // The first refused field ends the patch, nothing of it is stored (#1622).
  () => { dropConfig('week_start'); },
  ['put second field refused', 'PUT', PREFS, { week_start: 'saturday', holiday_school_color: 'kein-hex' }],
  ['put second field refused stored', 'PROBE', () => stored('week_start', 'holiday_school_color')],
  ['put unknown key', 'PUT', PREFS, { not_a_setting: 1 }],
  ['put empty', 'PUT', PREFS, {}],
  // The schema's 400 (#2900), before and after.
  ['put no body', 'PUT', PREFS, NO_BODY],
  ['put list', 'PUT', PREFS, []],
  ['put list of patches', 'PUT', PREFS, [{ week_start: 'sunday' }]],
  ['put null', 'PUT', PREFS, NO_BODY, { raw: 'null' }],
  ['put text', 'PUT', PREFS, NO_BODY, { raw: '"x"' }],
  ['put broken json', 'PUT', PREFS, NO_BODY, { raw: '{"week_start":' }],
  ['put currency', 'PUT', PREFS, { currency: 'USD', week_start: 'monday' }],
  ['put stored', 'PROBE', () => stored('week_start', 'currency')],

  // ══ Holiday lists ══════════════════════════════════════════════════════════
  ['countries', 'GET', `${PREFS}/holidays/countries`, NO_BODY],
  ['countries mem', 'GET', `${PREFS}/holidays/countries`, NO_BODY, { actor: 'mem' }],
  ['subdivisions', 'GET', `${PREFS}/holidays/subdivisions/DE`, NO_BODY],
  ['subdivisions lang de', 'GET', `${PREFS}/holidays/subdivisions/DE?lang=de`, NO_BODY],
  ['subdivisions lang pt-BR', 'GET', `${PREFS}/holidays/subdivisions/DE?lang=pt-BR`, NO_BODY],
  ['subdivisions lang unknown', 'GET', `${PREFS}/holidays/subdivisions/DE?lang=xx`, NO_BODY],
  ['subdivisions lang path', 'GET', `${PREFS}/holidays/subdivisions/DE?lang=..%2Fde`, NO_BODY],
  ['subdivisions lang empty', 'GET', `${PREFS}/holidays/subdivisions/DE?lang=`, NO_BODY],
  ['subdivisions lang twice', 'GET', `${PREFS}/holidays/subdivisions/DE?lang=de&lang=fr`, NO_BODY],
  ['subdivisions GB', 'GET', `${PREFS}/holidays/subdivisions/GB`, NO_BODY],
  ['subdivisions unknown country', 'GET', `${PREFS}/holidays/subdivisions/ZZ`, NO_BODY],
  ['subdivisions lower case', 'GET', `${PREFS}/holidays/subdivisions/de`, NO_BODY],
  ['subdivisions one letter', 'GET', `${PREFS}/holidays/subdivisions/D`, NO_BODY],
  ['subdivisions three letters', 'GET', `${PREFS}/holidays/subdivisions/DEU`, NO_BODY],
  ['subdivisions digit', 'GET', `${PREFS}/holidays/subdivisions/1A`, NO_BODY],
  ['subdivisions encoded', 'GET', `${PREFS}/holidays/subdivisions/D%45`, NO_BODY],
  ['subdivisions encoded slash', 'GET', `${PREFS}/holidays/subdivisions/D%2F`, NO_BODY],
  ['groups BE', 'GET', `${PREFS}/holidays/groups/BE`, NO_BODY],
  ['groups DE', 'GET', `${PREFS}/holidays/groups/DE`, NO_BODY],
  ['groups GB', 'GET', `${PREFS}/holidays/groups/GB`, NO_BODY],
  ['groups lower case', 'GET', `${PREFS}/holidays/groups/be`, NO_BODY],
  ['groups three letters', 'GET', `${PREFS}/holidays/groups/BEL`, NO_BODY],
  ['region groups', 'GET', `${PREFS}/holidays/groups/CH/CH-BE`, NO_BODY],
  ['region groups single', 'GET', `${PREFS}/holidays/groups/DE/DE-BY`, NO_BODY],
  ['region groups unknown', 'GET', `${PREFS}/holidays/groups/DE/DE-XX`, NO_BODY],
  ['region groups GB', 'GET', `${PREFS}/holidays/groups/GB/GB-ENG`, NO_BODY],
  ['region groups country lower', 'GET', `${PREFS}/holidays/groups/de/DE-BY`, NO_BODY],
  ['region groups one letter', 'GET', `${PREFS}/holidays/groups/DE/x`, NO_BODY],
  ['region groups bare country', 'GET', `${PREFS}/holidays/groups/DE/DE`, NO_BODY],
  ['region groups lower', 'GET', `${PREFS}/holidays/groups/DE/de-by`, NO_BODY],
  ['region groups dash', 'GET', `${PREFS}/holidays/groups/DE/DE-`, NO_BODY],
  ['region groups too long', 'GET', `${PREFS}/holidays/groups/DE/DE-ABCDEFGHIJK`, NO_BODY],
  ['region groups both wrong', 'GET', `${PREFS}/holidays/groups/de/x`, NO_BODY],
  // The service fails: the lists answer 502, countries fall back to the local ones.
  holidaysIn('down'),
  ['countries down', 'GET', `${PREFS}/holidays/countries`, NO_BODY],
  ['subdivisions down', 'GET', `${PREFS}/holidays/subdivisions/DE`, NO_BODY],
  ['subdivisions GB down', 'GET', `${PREFS}/holidays/subdivisions/GB`, NO_BODY],
  ['groups down', 'GET', `${PREFS}/holidays/groups/BE`, NO_BODY],
  ['groups GB down', 'GET', `${PREFS}/holidays/groups/GB`, NO_BODY],
  ['region groups down', 'GET', `${PREFS}/holidays/groups/CH/CH-BE`, NO_BODY],
  ['region groups refused down', 'GET', `${PREFS}/holidays/groups/DE/x`, NO_BODY],
  holidaysIn('http'),
  ['subdivisions 503', 'GET', `${PREFS}/holidays/subdivisions/DE`, NO_BODY],
  ['groups 503', 'GET', `${PREFS}/holidays/groups/BE`, NO_BODY],
  holidaysIn('shape'),
  ['groups shape', 'GET', `${PREFS}/holidays/groups/BE`, NO_BODY],
  ['region groups shape', 'GET', `${PREFS}/holidays/groups/CH/CH-BE`, NO_BODY],
  holidaysIn('ok'),

  // ══ POST /holidays/sync ════════════════════════════════════════════════════
  ['sync without country', 'POST', `${PREFS}/holidays/sync`, {}],
  ['sync without body', 'POST', `${PREFS}/holidays/sync`, NO_BODY],
  ['sync mem', 'POST', `${PREFS}/holidays/sync`, {}, { actor: 'mem' }],
  ['sync mem with body', 'POST', `${PREFS}/holidays/sync`, { a: 1 }, { actor: 'mem' }],
  ['sync mem with list', 'POST', `${PREFS}/holidays/sync`, [1], { actor: 'mem' }],
  ['sync kid', 'POST', `${PREFS}/holidays/sync`, NO_BODY, { actor: 'kid' }],
  ['sync display', 'POST', `${PREFS}/holidays/sync`, NO_BODY, { actor: 'display' }],
  () => { setConfig('holiday_country', 'DE'); setConfig('holiday_show_public', '1'); setConfig('holiday_show_school', '0'); },
  ['sync', 'POST', `${PREFS}/holidays/sync`, {}],
  ['sync stored', 'PROBE', () => ({ ...stored('holiday_last_sync', 'holiday_last_sync_scope', 'holiday_retry_scope'), rows: /** @type {any} */ (database().prepare('SELECT COUNT(*) AS n FROM holiday_cache').get()).n })],
  // An unreachable service: the sync records the gap and answers 200.
  holidaysIn('down'),
  ['sync down', 'POST', `${PREFS}/holidays/sync`, {}],
  ['sync down stored', 'PROBE', () => stored('holiday_last_sync_scope', 'holiday_retry_scope')],
  holidaysIn('ok'),
  // A failure that is not the database's: 502 with its class (Phase 0 H).
  ['sync failing answer', 'POST', `${PREFS}/holidays/sync`, {}, { fail: true }],
  () => { dropConfig('holiday_country'); },

  // ══ Push ══════════════════════════════════════════════════════════════════
  ['vapid key', 'GET', `${PUSH}/vapid-public-key`, NO_BODY],
  ['vapid key mem', 'GET', `${PUSH}/vapid-public-key`, NO_BODY, { actor: 'mem' }],
  ['subscribe', 'POST', `${PUSH}/subscribe`, subscription(ENDPOINT)],
  ['subscribe again', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: { p256dh: 'BNewKey', auth: 'NewSecret' } }],
  ['subscribe mem', 'POST', `${PUSH}/subscribe`, subscription(ENDPOINT_MEM), { actor: 'mem' }],
  ['subscribe extra fields', 'POST', `${PUSH}/subscribe`, { ...subscription('https://web.push.apple.com/device-extra'), keys: { ...KEYS, extra: 1 }, other: true }],
  ['subscribe 2048', 'POST', `${PUSH}/subscribe`, subscription(`https://fcm.googleapis.com/${'x'.repeat(2048 - 'https://fcm.googleapis.com/'.length)}`)],
  ['subscribed', 'PROBE', () => subscriptions()],
  // checkPushEndpoint stays in the handler.
  ['subscribe empty endpoint', 'POST', `${PUSH}/subscribe`, subscription('')],
  ['subscribe http', 'POST', `${PUSH}/subscribe`, subscription('http://fcm.googleapis.com/fcm/send/x')],
  ['subscribe loopback', 'POST', `${PUSH}/subscribe`, subscription('https://127.0.0.1/push')],
  ['subscribe localhost', 'POST', `${PUSH}/subscribe`, subscription('https://localhost/push')],
  ['subscribe private', 'POST', `${PUSH}/subscribe`, subscription('https://192.168.1.20/push')],
  ['subscribe lan name', 'POST', `${PUSH}/subscribe`, subscription('https://nas.local/push')],
  ['subscribe credentials', 'POST', `${PUSH}/subscribe`, subscription('https://user:pass@fcm.googleapis.com/fcm/send/x')],
  ['subscribe no url', 'POST', `${PUSH}/subscribe`, subscription('nicht eine Adresse')],
  ['subscribe blank', 'POST', `${PUSH}/subscribe`, subscription(' ')],
  // The schema's 400 (#2900), before and after.
  ['subscribe 2049', 'POST', `${PUSH}/subscribe`, subscription(`https://fcm.googleapis.com/${'x'.repeat(2049 - 'https://fcm.googleapis.com/'.length)}`)],
  ['subscribe endpoint number', 'POST', `${PUSH}/subscribe`, { endpoint: 5, keys: KEYS }],
  ['subscribe endpoint object', 'POST', `${PUSH}/subscribe`, { endpoint: {}, keys: KEYS }],
  ['subscribe endpoint list', 'POST', `${PUSH}/subscribe`, { endpoint: [ENDPOINT], keys: KEYS }],
  ['subscribe endpoint null', 'POST', `${PUSH}/subscribe`, { endpoint: null, keys: KEYS }],
  ['subscribe endpoint missing', 'POST', `${PUSH}/subscribe`, { keys: KEYS }],
  ['subscribe keys missing', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT }],
  ['subscribe keys text', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: 'x' }],
  ['subscribe keys null', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: null }],
  ['subscribe keys list', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: ['p', 'a'] }],
  ['subscribe keys empty', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: {} }],
  ['subscribe p256dh number', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: { ...KEYS, p256dh: 5 } }],
  ['subscribe p256dh empty', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: { ...KEYS, p256dh: '' } }],
  ['subscribe auth empty', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: { ...KEYS, auth: '' } }],
  ['subscribe auth missing', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: { p256dh: 'P' } }],
  ['subscribe auth object', 'POST', `${PUSH}/subscribe`, { endpoint: ENDPOINT, keys: { ...KEYS, auth: {} } }],
  ['subscribe no body', 'POST', `${PUSH}/subscribe`, NO_BODY],
  ['subscribe list', 'POST', `${PUSH}/subscribe`, [subscription(ENDPOINT)]],
  ['nothing more subscribed', 'PROBE', () => subscriptions()],

  // ── wall-mode ──
  ['wall pause', 'PUT', `${PUSH}/wall-mode`, { endpoint: ENDPOINT, active: true }],
  ['wall pause mem', 'PUT', `${PUSH}/wall-mode`, { endpoint: ENDPOINT_MEM, active: true }, { actor: 'mem' }],
  ['wall paused', 'PROBE', () => subscriptions()],
  // A foreign or unknown endpoint changes nothing.
  ['wall resume foreign', 'PUT', `${PUSH}/wall-mode`, { endpoint: ENDPOINT_MEM, active: false }],
  ['wall unknown', 'PUT', `${PUSH}/wall-mode`, { endpoint: 'https://fcm.googleapis.com/unknown', active: true }],
  ['wall empty endpoint', 'PUT', `${PUSH}/wall-mode`, { endpoint: '', active: true }],
  ['wall unchanged', 'PROBE', () => subscriptions()],
  // The schema's 400.
  ['wall active text', 'PUT', `${PUSH}/wall-mode`, { endpoint: ENDPOINT, active: 'yes' }],
  ['wall active number', 'PUT', `${PUSH}/wall-mode`, { endpoint: ENDPOINT, active: 1 }],
  ['wall active null', 'PUT', `${PUSH}/wall-mode`, { endpoint: ENDPOINT, active: null }],
  ['wall active missing', 'PUT', `${PUSH}/wall-mode`, { endpoint: ENDPOINT }],
  ['wall endpoint number', 'PUT', `${PUSH}/wall-mode`, { endpoint: 5, active: true }],
  ['wall endpoint object', 'PUT', `${PUSH}/wall-mode`, { endpoint: {}, active: true }],
  ['wall endpoint missing', 'PUT', `${PUSH}/wall-mode`, { active: true }],
  ['wall no body', 'PUT', `${PUSH}/wall-mode`, NO_BODY],

  // ── test push ──
  () => { sentPushes.length = 0; },
  ['test push', 'POST', `${PUSH}/test`, { title: 'Test', body: 'Hallo' }],
  ['test push no body', 'POST', `${PUSH}/test`, NO_BODY],
  ['test push empty', 'POST', `${PUSH}/test`, {}],
  ['test push empty texts', 'POST', `${PUSH}/test`, { title: '', body: '' }],
  ['test push extra', 'POST', `${PUSH}/test`, { other: 1 }],
  ['test push foreign endpoint', 'POST', `${PUSH}/test`, { endpoint: ENDPOINT_MEM }],
  ['foreign pause stays', 'PROBE', () => subscriptions()],
  ['test push own endpoint', 'POST', `${PUSH}/test`, { title: 'Test', endpoint: ENDPOINT }],
  ['own pause lifted', 'PROBE', () => subscriptions()],
  ['test push mem', 'POST', `${PUSH}/test`, NO_BODY, { actor: 'mem' }],
  ['test push kid', 'POST', `${PUSH}/test`, NO_BODY, { actor: 'kid' }],
  ['sent', 'PROBE', () => sent()],
  // The schema's 400; nothing is sent.
  ['test push title number', 'POST', `${PUSH}/test`, { title: 5 }],
  ['test push title null', 'POST', `${PUSH}/test`, { title: null }],
  ['test push body list', 'POST', `${PUSH}/test`, { body: ['x'] }],
  ['test push endpoint number', 'POST', `${PUSH}/test`, { endpoint: 5 }],
  ['test push list', 'POST', `${PUSH}/test`, []],
  ['nothing sent', 'PROBE', () => sent()],

  // ── unsubscribe ──
  ['unsubscribe empty endpoint', 'POST', `${PUSH}/unsubscribe`, { endpoint: '' }],
  ['unsubscribe unknown', 'POST', `${PUSH}/unsubscribe`, { endpoint: 'https://fcm.googleapis.com/unknown' }],
  ['unsubscribe foreign', 'POST', `${PUSH}/unsubscribe`, { endpoint: ENDPOINT_MEM }],
  ['foreign stays', 'PROBE', () => subscriptions()],
  ['unsubscribe endpoint number', 'POST', `${PUSH}/unsubscribe`, { endpoint: 5 }],
  ['unsubscribe endpoint object', 'POST', `${PUSH}/unsubscribe`, { endpoint: {} }],
  ['unsubscribe endpoint missing', 'POST', `${PUSH}/unsubscribe`, {}],
  ['unsubscribe no body', 'POST', `${PUSH}/unsubscribe`, NO_BODY],
  ['unsubscribe', 'POST', `${PUSH}/unsubscribe`, { endpoint: ENDPOINT }],
  ['unsubscribe mem', 'POST', `${PUSH}/unsubscribe`, { endpoint: ENDPOINT_MEM }, { actor: 'mem' }],
  ['unsubscribed', 'PROBE', () => subscriptions()],
  // Taking an endpoint over from another account: the wall pause falls.
  ['subscribe mem back', 'POST', `${PUSH}/subscribe`, subscription(ENDPOINT_MEM), { actor: 'mem' }],
  ['wall pause mem again', 'PUT', `${PUSH}/wall-mode`, { endpoint: ENDPOINT_MEM, active: true }, { actor: 'mem' }],
  ['subscribe taken over', 'POST', `${PUSH}/subscribe`, subscription(ENDPOINT_MEM)],
  ['taken over', 'PROBE', () => subscriptions()],

  // ── An unexpected error: the sentence of the push routes (CHANGED) ──
  ['vapid key failing answer', 'GET', `${PUSH}/vapid-public-key`, NO_BODY, { fail: true }],
  ['subscribe failing answer', 'POST', `${PUSH}/subscribe`, subscription('https://fcm.googleapis.com/fcm/send/failing'), { fail: true }],
  ['wall failing answer', 'PUT', `${PUSH}/wall-mode`, { endpoint: 'https://fcm.googleapis.com/fcm/send/failing', active: true }, { fail: true }],
  ['unsubscribe failing answer', 'POST', `${PUSH}/unsubscribe`, { endpoint: 'https://fcm.googleapis.com/fcm/send/failing' }, { fail: true }],
  ['test push failing answer', 'POST', `${PUSH}/test`, {}, { fail: true }],
  () => { pushFails = true; },
  ['test push service fails', 'POST', `${PUSH}/test`, {}],
  () => { pushFails = false; sentPushes.length = 0; },

  // ══ Reading again ══════════════════════════════════════════════════════════
  ['read admin end', 'GET', PREFS, NO_BODY],
  ['read display end', 'GET', PREFS, NO_BODY, { actor: 'display' }],
];

/** @param {Record<string, { status?: number, body?: unknown, probe?: unknown }>} answers @param {Record<string, string[]>} logs */
async function runTable(answers, logs) {
  for (const step of STEPS) {
    if (typeof step === 'function') { step(); continue; }
    const [name, method] = step;
    assert.ok(!Object.hasOwn(answers, name), `row name twice: ${name}`);
    if (method === 'PROBE') {
      answers[name] = { probe: normalized(/** @type {() => unknown} */ (step[2])()) };
      continue;
    }
    const [, , route, body, opts] = /** @type {[string, string, string, unknown, CallOptions?]} */ (step);
    logged.error.length = 0;
    const actual = await call(method, route, body, opts);
    answers[name] = { status: actual.status, body: normalized(actual.body) };
    if (logged.error.length) logs[name] = logged.error.splice(0);
  }
  return answers;
}

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  /** @type {Record<string, { status?: number, body?: unknown, probe?: unknown }>} */
  const answers = {};
  /** @type {Record<string, string[]>} */
  const logs = {};
  try {
    await runTable(answers, logs);
  } finally {
    if (process.env.PREFERENCES_ANSWERS_DUMP) fs.writeFileSync(process.env.PREFERENCES_ANSWERS_DUMP, JSON.stringify({ answers, logs }));
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
  // Only the rows that changed on purpose reach the central handler; every
  // other row is an answer of the route itself (the 400 of the schema and of
  // the JSON parser log nothing).
  assert.deepEqual(logs, Object.fromEntries(Object.entries(CHANGED).filter(([, row]) => row.log).map(([name, row]) => [name, [row.log]])), 'only these rows reached the central handler');
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

test('an unexpected error in GET and PUT /preferences and in each of the 5 push routes is a 500 of the central handler, and the routers go on', async () => {
  logged.error.length = 0;
  /** @type {Array<[string, string, unknown, string]>} [method, path, body, route pattern] */
  const rows = [
    ['GET', PREFS, NO_BODY, `${PREFS}/`],
    ['PUT', PREFS, { week_start: 'monday' }, `${PREFS}/`],
    ['GET', `${PUSH}/vapid-public-key`, NO_BODY, `${PUSH}/vapid-public-key`],
    ['POST', `${PUSH}/subscribe`, subscription('https://fcm.googleapis.com/fcm/send/failing'), `${PUSH}/subscribe`],
    ['PUT', `${PUSH}/wall-mode`, { endpoint: 'https://fcm.googleapis.com/fcm/send/failing', active: true }, `${PUSH}/wall-mode`],
    ['POST', `${PUSH}/test`, {}, `${PUSH}/test`],
    ['POST', `${PUSH}/unsubscribe`, { endpoint: 'https://fcm.googleapis.com/fcm/send/failing' }, `${PUSH}/unsubscribe`],
  ];
  for (const [method, route, body, pattern] of rows) {
    assertCentral(await call(method, route, body, { fail: true }), method, pattern);
  }
  assert.equal((await call('GET', PREFS, NO_BODY)).status, 200, 'the preferences router answers again');
  assert.equal((await call('GET', `${PUSH}/vapid-public-key`, NO_BODY)).status, 200, 'the push router answers again');
});

test('POST /push/test: a rejected send is the 500 of the central handler (Express 5 hands the promise on)', async () => {
  logged.error.length = 0;
  pushFails = true;
  try {
    assertCentral(await call('POST', `${PUSH}/test`, { title: 'x' }), 'POST', `${PUSH}/test`);
  } finally {
    pushFails = false;
  }
  assert.equal((await call('POST', `${PUSH}/test`, {})).status, 200, 'the route answers again');
  sentPushes.length = 0;
});

test('POST /holidays/sync: a database error is the 500 of the central handler, a foreign failure keeps its 502', async () => {
  logged.error.length = 0;
  setConfig('holiday_country', 'DE');
  setConfig('holiday_show_public', '1');
  database().exec('ALTER TABLE holiday_cache RENAME TO test_moved_holiday_cache');
  try {
    assertCentral(await call('POST', `${PREFS}/holidays/sync`, {}), 'POST', `${PREFS}/holidays/sync`);
  } finally {
    database().exec('ALTER TABLE test_moved_holiday_cache RENAME TO holiday_cache');
  }
  assert.deepEqual(await call('POST', `${PREFS}/holidays/sync`, {}, { fail: true }), {
    status: 502, body: { error: 'Holiday sync failed.', code: 502, reason: 'remote_failed' },
  });
  assert.deepEqual(logged.error, [], 'the 502 is the route\'s own answer');
  assert.equal((await call('POST', `${PREFS}/holidays/sync`, {})).status, 200, 'the route answers again');
  dropConfig('holiday_country');
});

test('the holiday lists keep their 502, a failing answer included', async () => {
  logged.error.length = 0;
  const lists = [
    [`${PREFS}/holidays/subdivisions/DE`, 'The region list could not be loaded.'],
    [`${PREFS}/holidays/groups/BE`, 'The school holiday groups could not be loaded.'],
    [`${PREFS}/holidays/groups/CH/CH-BE`, 'The school holiday groups could not be loaded.'],
    [`${PREFS}/holidays/countries`, 'The country list could not be loaded.'],
  ];
  for (const [route, error] of lists) {
    assert.deepEqual(await call('GET', route, NO_BODY, { fail: true }), { status: 502, body: { error, code: 502 } }, route);
  }
  assert.deepEqual(logged.error, [], 'none reached the central handler');
});

// ── PUT /preferences: the transaction ───────────────────────────────────────
test('PUT /preferences: an error after the first field was written is the 500 of the central handler, nothing of the patch is stored, the retitle runs', async () => {
  logged.error.length = 0;
  setConfig('week_start', 'monday');
  setConfig('language', 'de');
  // A birthday whose stored title is not the one of the data language: the
  // retitle in the finally writes it.
  const eventId = Number(database().prepare(`INSERT INTO calendar_events (title, start_datetime, all_day, created_by)
    VALUES ('Alter Titel', '2026-05-10', 1, ?)`).run(ADMIN).lastInsertRowid);
  database().prepare('INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES (?, ?, ?, ?)')
    .run('Oma', '1950-05-10', eventId, ADMIN);
  const title = () => /** @type {any} */ (database().prepare('SELECT title FROM calendar_events WHERE id = ?').get(eventId)).title;
  // `week_start` comes before `language` in the registry: the first is
  // written, the second throws.
  database().exec(`CREATE TRIGGER test_refuse_language BEFORE INSERT ON sync_config WHEN NEW.key = 'language'
    BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;`);
  database().exec(`CREATE TRIGGER test_refuse_language_update BEFORE UPDATE ON sync_config WHEN NEW.key = 'language'
    BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;`);
  let res;
  try {
    res = await call('PUT', PREFS, { week_start: 'sunday', language: 'en' });
  } finally {
    database().exec('DROP TRIGGER test_refuse_language; DROP TRIGGER test_refuse_language_update;');
  }
  // (b) and (c) first: they held before the refactor as well.
  assert.equal(database().inTransaction, false, 'no transaction left open');
  assert.equal(readConfig('week_start'), 'monday', 'the first field of the patch was rolled back');
  assert.equal(readConfig('language'), 'de');
  assert.notEqual(title(), 'Alter Titel', 'the retitle ran after the rollback');
  // (a) the central handler answers.
  assertCentral(res, 'PUT', `${PREFS}/`);
  assert.equal((await call('PUT', PREFS, { week_start: 'sunday' })).status, 200, 'the route answers again');
  assert.equal(readConfig('week_start'), 'sunday');
  dropConfig('week_start');
});

// ── Sinks ───────────────────────────────────────────────────────────────────
/**
 * The handler of a route alone, without validateRequest() and whatever stands
 * in front of it in the route: the last function of its route layer.
 * @param {any} router
 * @param {string} method lower case
 * @param {string} routePath the Express pattern of the router
 */
function bareHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
  }
  throw new Error(`no route ${method} ${routePath}`);
}

/**
 * Runs a bare handler with a raw body as the admin; returns its answer. An
 * error the handler throws fails the test (it would be a 500).
 * @param {any} router
 * @param {string} method
 * @param {string} routePath
 * @param {{ body?: unknown, params?: Record<string, string> }} input
 */
async function callBare(router, method, routePath, { body = {}, params = {} }) {
  const handler = bareHandler(router, method, routePath);
  const req = {
    method: method.toUpperCase(), body, query: {}, params, get: () => undefined,
    authUserId: ADMIN, authRole: 'admin', authMethod: 'session', authScopes: null, session: { userId: ADMIN, role: 'admin' }, sessionModuleAccess: null,
  };
  /** @type {{ status: number, body: unknown }} */
  const out = { status: 200, body: undefined };
  const res = {
    status(/** @type {number} */ code) { out.status = code; return res; },
    json(/** @type {unknown} */ value) { out.body = value; return res; },
    send(/** @type {unknown} */ value) { out.body = value; return res; },
    end() { return res; },
  };
  await handler(req, res, (/** @type {unknown} */ err) => { throw err; });
  return out;
}

// The schema refuses each of these in front (the table holds that). Behind it
// a string method, `new URL()` or `.length` runs over the raw value, so the
// type check stays there (sink, not route; CodeQL js/loop-bound-injection in
// #2860): called without validateRequest(), each answers 400 instead of
// throwing or reading a length it was handed.
/** @type {unknown[]} */
const NOT_TEXT = [{ length: 1e9 }, 5, ['https://fcm.googleapis.com/x'], { toString: 'x' }];

test('sink: subscribe keeps checkPushEndpoint (type, length, new URL) in front of the stored row', async () => {
  const router = buildPushRouter({ pushService, database: database() });
  const before = subscriptions();
  for (const endpoint of NOT_TEXT) {
    assert.deepEqual(await callBare(router, 'post', '/subscribe', { body: { endpoint, keys: KEYS } }),
      { status: 400, body: { error: 'endpoint must be a public https address.', code: 400 } }, JSON.stringify(endpoint));
  }
  assert.deepEqual(subscriptions(), before, 'nothing stored');
});

test('sink: the holiday lists read the path codes only as text that the service encodes', async () => {
  // Path parameters are text by construction (Express decodes them); the
  // service puts them through encodeURIComponent into the query of a fixed
  // host. Without the schema an odd code reaches OpenHolidays as a query
  // value, never as a host or a path.
  /** @type {string[]} */
  const urls = [];
  holidays.__setFetchImpl(async (/** @type {unknown} */ url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => [] }; });
  try {
    const { default: router } = await import('../server/routes/preferences.js');
    const res = await callBare(router, 'get', '/holidays/subdivisions/:countryCode', { params: { countryCode: '../x?y=1#' } });
    assert.deepEqual(res, { status: 200, body: { data: [] } });
    assert.deepEqual(urls, ['https://openholidaysapi.org/Subdivisions?countryIsoCode=..%2Fx%3Fy%3D1%23']);
  } finally {
    holidays.__setFetchImpl(null);
  }
});
