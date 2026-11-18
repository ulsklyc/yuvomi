/**
 * Test: the answers of the six small modules of group 1A stay byte-equal (#2810, phase 2 section E)
 * Purpose: reminders, notifications, modules, permissions, email and weather
 *          dropped the hand checks the schema of their operation already
 *          covers (`validateRequest()` runs before every handler since #2819)
 *          and the try/catch blocks that answered an unexpected error with a
 *          500 of their own. That is a pure refactor, and this suite holds it:
 *          for a table of requests per route - valid, every refusal of the
 *          handler that stays, every refusal of the schema that replaced a
 *          hand check, not found, gated, conflict - it pins status and the
 *          WHOLE answer body. The expectations were written at the state
 *          before the refactor (253aebd0a) and are literal here, no fixture
 *          file, no update mode. Only values that follow a clock this suite
 *          does not hold (SQLite's own `now`) or the host (the temporary
 *          modules folder, whether its disk is persistent) are replaced by a
 *          marker before the comparison.
 *
 *          The clock stands still (`mock.timers`, 18.11.2026 12:00 UTC) and the
 *          household lives in Europe/Berlin (`household_timezone`): without it
 *          "today" follows the process TZ, and from UTC+12 on noon UTC is
 *          already the next day.
 *
 *          The second part: an unexpected error in each file reaches the
 *          central error handler - 500 with its fixed sentence and its log line
 *          `Unhandled error: <METHOD> <pattern> -> 500` - and the process keeps
 *          answering. What a catch did besides answering (a failed channel
 *          test stores its `last_error`) still happens. Weather has no such
 *          path: every failure there is a 200 `upstream_error` or a 502.
 * Run: npm run test:small-modules-a-answers
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_ALLOW_WEB_INSTALL = 'true';
// Removed at process exit (test/tmp-dir.js).
const MODULES_DIR = tempDir('yuvomi-answers-1a-');
process.env.MODULES_DIR = MODULES_DIR;

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { buildRouter: buildNotificationsRouter } = await import('../server/routes/notifications.js');
const { default: modulesRouter } = await import('../server/routes/modules.js');
const { default: permissionsRouter } = await import('../server/routes/permissions.js');
const { buildRouter: buildEmailRouter } = await import('../server/routes/email.js');
const { buildRouter: buildWeatherRouter } = await import('../server/routes/weather.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const modulesSvc = await import('../server/services/modules.js');
const installSvc = await import('../server/services/module-install.js');
const db = dbmod.get();

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

const ADMIN = user('linda', 'admin', 'mom');
const MEMBER = user('tom', 'member', 'dad');

// ── Stubs: only what the routes call ───────────────────────────────────────

const emailState = { failConfig: false, failSend: false };
const emailService = {
  getPublicConfig: () => {
    if (emailState.failConfig) throw new Error('config store is gone');
    /** @type {Record<string, string>} */
    const stored = {};
    for (const row of db.prepare("SELECT key, value FROM sync_config WHERE key LIKE 'email_%' ORDER BY key").all()) {
      stored[row.key] = row.key === 'email_smtp_pass' ? (row.value ? '<set>' : '') : row.value;
    }
    return stored;
  },
  isEnvControlled: (/** @type {string} */ field) => field === 'fromName',
  sendTest: async (/** @type {string} */ to) => {
    if (emailState.failSend) throw new Error('smtp exploded');
    return { ok: true, to };
  },
};

const notificationState = { failTest: false };
const notificationService = {
  providers: {
    ntfy: {},
    gotify: { isAvailable: () => true },
    email: { isAvailable: () => false },
    webhook: { isAvailable: () => { throw new Error('probe failed'); } },
  },
  testChannel: async (/** @type {{ channel: { id: number } }} */ { channel }) => {
    if (notificationState.failTest) throw new TypeError('provider crashed');
    return { ok: true, channel: channel.id };
  },
};

/** @type {Record<string, string | null>} */
const weatherConfig = {};
const weatherState = { mode: 'ok', failConfig: false };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const OPEN_METEO = {
  utc_offset_seconds: 3600,
  current: { temperature_2m: 7.4, apparent_temperature: 4.6, relative_humidity_2m: 81, is_day: 1, weather_code: 3, wind_speed_10m: 12.6 },
  daily: {
    time: ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'],
    weather_code: [3, 61, 0, 2, 45, 71],
    temperature_2m_max: [8.2, 6.9, 9.5, 10.1, 5.5, 2.4],
    temperature_2m_min: [2.1, 1.4, 3.3, 4.0, 0.6, -1.2],
  },
};
const GEOCODE = {
  results: [
    { name: 'Berlin', admin1: 'Land Berlin', country: 'Deutschland', country_code: 'DE', latitude: 52.52, longitude: 13.41, timezone: 'Europe/Berlin' },
    { name: 'Berlin', admin1: 'New Hampshire', admin2: 'Coos', country: 'USA', country_code: 'US', latitude: 44.47, longitude: -71.19, timezone: 'America/New_York' },
    { name: 'No coordinates' },
  ],
};
/** @param {string} url */
async function weatherFetch(url) {
  if (weatherState.mode === 'throw') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  if (weatherState.mode === 'http') return { ok: false, status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  if (url.includes('/img/wn/')) return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) };
  if (url.includes('geocoding-api')) return { ok: true, status: 200, json: async () => GEOCODE };
  return { ok: true, status: 200, json: async () => OPEN_METEO };
}

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = {
  warn: (/** @type {string} */ line) => { logged.warn.push(line); },
  error: (/** @type {string} */ line) => { logged.error.push(line); },
};
const quiet = { warn: () => {}, error: () => {} };

// The install routes count every request per user (10 installs, 30 attempts in
// 10 minutes): each admin request to them gets an id of its own, in order.
let nextLimiterId = 1000;
const app = express();
app.use(express.json());
app.use(defaultEmptyBody);
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const member = req.get('x-as') === 'member';
  const id = member ? MEMBER : ADMIN;
  req.authUserId = req.path.startsWith('/api/v1/modules/install/') && !member ? nextLimiterId++ : id;
  req.authRole = member ? 'member' : 'admin';
  req.authMethod = req.get('x-method') ?? 'session';
  req.session = { userId: id, role: req.authRole };
  const scopes = req.get('x-scopes');
  if (scopes) req.authScopes = JSON.parse(scopes);
  next();
});
// The order of server/index.js.
app.use('/api/v1/weather', buildWeatherRouter(/** @type {any} */ ({
  cfgGet: (/** @type {string} */ key) => {
    if (weatherState.failConfig) throw new Error('config store is gone');
    return weatherConfig[key] ?? null;
  },
  fetchFn: weatherFetch,
  logger: quiet,
})));
app.use('/api/v1/reminders', remindersRouter);
app.use('/api/v1/modules', modulesRouter);
app.use('/api/v1/email', buildEmailRouter(/** @type {any} */ ({ emailService, resolveUserEmail: () => null })));
app.use('/api/v1/notifications', buildNotificationsRouter(/** @type {any} */ ({ notificationService })));
app.use('/api/v1/permissions', permissionsRouter);
app.use(createErrorHandler(log));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

const NO_BODY = Symbol('no body');

/**
 * @typedef {{ as?: string, scopes?: string[], token?: boolean, zip?: boolean }} CallOptions
 */

/**
 * A JSON answer as it is; anything else as its type and length.
 * @param {string} method
 * @param {string} path
 * @param {unknown} body a JSON value, a Buffer (sent as application/zip) or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, path, body, { as, scopes, token } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (Buffer.isBuffer(body)) headers['Content-Type'] = 'application/zip';
  else if (body !== NO_BODY) headers['Content-Type'] = 'application/json';
  if (as) headers['x-as'] = as;
  if (scopes) headers['x-scopes'] = JSON.stringify(scopes);
  if (token) headers['x-method'] = 'token';
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: body === NO_BODY ? undefined : Buffer.isBuffer(body) ? /** @type {any} */ (body) : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  if (buf.length === 0) return { status: res.status, body: null };
  if (type.startsWith('application/json')) return { status: res.status, body: JSON.parse(buf.toString('utf8')) };
  return { status: res.status, body: { type, length: buf.length } };
}

// Timestamps SQLite writes from its own clock ('now'), not from Date.
const VOLATILE = new Set(['created_at', 'updated_at', 'createdAt', 'updatedAt', 'lastTestAt', 'lastSuccessAt']);
// Whether the temporary folder lies on a persistent disk is the host's answer.
const HOST = new Set(['persistent']);

/** @param {unknown} value */
function normalized(value) {
  const text = JSON.stringify(value).split(MODULES_DIR).join('<modules>');
  return JSON.parse(text, (key, v) => {
    if (VOLATILE.has(key) && v !== null) return '<clock>';
    if (HOST.has(key)) return '<host>';
    return v;
  });
}

// ── A small ZIP writer (deflate), as in test-module-install.js ─────────────
/** @param {Record<string, string>} files */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    const chunk = Buffer.concat([local, nameBuf, comp]);
    locals.push(chunk);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += chunk.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** @param {string} id */
function moduleZip(id) {
  return makeZip({
    'module.json': JSON.stringify({ id, name: `Mod ${id}`, version: '1.0.0', entry: 'index.js' }),
    'index.js': `export default { id: '${id}' };\n`,
  });
}

// ── Seed: the database starts empty, so every id below is the same on every run ──

const TASK = Number(db.prepare("INSERT INTO tasks (title, category, status, created_by) VALUES ('Steuer', 'Sonstiges', 'open', ?)").run(ADMIN).lastInsertRowid);
const TASK2 = Number(db.prepare("INSERT INTO tasks (title, category, status, created_by) VALUES ('Garten', 'Sonstiges', 'open', ?)").run(ADMIN).lastInsertRowid);
const EVENT = Number(db.prepare("INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('Elternabend', '2026-11-20T18:00', ?)").run(ADMIN).lastInsertRowid);
// A derived origin, written as its module would: far in the future, outside every window below.
const DERIVED = Number(db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('pantry_item', 1, '2099-01-01T08:00:00', ?)").run(ADMIN).lastInsertRowid);

const NTFY = { provider: 'ntfy', name: 'Family', enabled: true, config: { baseUrl: 'https://ntfy.example', topic: 'family', priority: 'default', authType: 'none' } };
const PERMS = { modules: { tasks: 'read', budget: 'none' }, widgets: {}, capabilities: { notes_edit_others: 'allow' } };
const SIX = ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'];

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions.
 * @type {Array<[string, string, string, unknown, CallOptions?] | (() => void)>}
 */
const STEPS = [
  // ── reminders ─────────────────────────────────────────────────────────────
  ['rem pending empty', 'GET', '/reminders/pending', NO_BODY],
  ['rem post task', 'POST', '/reminders', { entity_type: 'task', entity_id: TASK, remind_at: '2026-11-18T10:00:00' }],
  ['rem post event offset', 'POST', '/reminders', { entity_type: 'event', entity_id: String(EVENT), remind_at: '2026-11-19T08:00:00+01:00' }],
  ['rem post derived', 'POST', '/reminders', { entity_type: 'pantry_item', entity_id: 1, remind_at: '2026-11-19' }],
  ['rem post derived waste', 'POST', '/reminders', { entity_type: 'waste_pickup', entity_id: 1, remind_at: '2026-11-19' }],
  ['rem post unknown type', 'POST', '/reminders', { entity_type: 'nope', entity_id: TASK, remind_at: '2026-11-19' }],
  ['rem post type number', 'POST', '/reminders', { entity_type: 5, entity_id: TASK, remind_at: '2026-11-19' }],
  ['rem post type empty', 'POST', '/reminders', { entity_type: '', entity_id: TASK, remind_at: '2026-11-19' }],
  ['rem post no type', 'POST', '/reminders', { entity_id: TASK, remind_at: '2026-11-19' }],
  ['rem post zero id', 'POST', '/reminders', { entity_type: 'task', entity_id: 0, remind_at: '2026-11-19' }],
  ['rem post zero id and derived', 'POST', '/reminders', { entity_type: 'pantry_item', entity_id: '0', remind_at: '2026-02-31' }],
  // The handler takes 31 February as it is (no calendar check); this POST
  // replaces reminder 2 of the task with reminder 4, the one dismissed below.
  ['rem post bad day', 'POST', '/reminders', { entity_type: 'task', entity_id: TASK, remind_at: '2026-02-31T10:00:00' }],
  ['rem post bad shape', 'POST', '/reminders', { entity_type: 'task', entity_id: TASK, remind_at: 'tomorrow' }],
  ['rem post unknown target', 'POST', '/reminders', { entity_type: 'task', entity_id: 999, remind_at: '2026-11-19' }],
  ['rem post module denied', 'POST', '/reminders', { entity_type: 'task', entity_id: TASK, remind_at: '2026-11-19' }, { scopes: ['calendar:write'] }],
  ['rem post no body', 'POST', '/reminders', NO_BODY],
  ['rem pending', 'GET', '/reminders/pending', NO_BODY],
  ['rem pending household', 'GET', '/reminders/pending?audience=household', NO_BODY],
  ['rem pending member', 'GET', '/reminders/pending', NO_BODY, { as: 'member' }],
  ['rem pending calendar token', 'GET', '/reminders/pending', NO_BODY, { scopes: ['calendar:read'] }],
  ['rem upcoming', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25', NO_BODY],
  ['rem upcoming types', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25&types=task,event', NO_BODY],
  ['rem upcoming types task', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25&types=task', NO_BODY],
  ['rem upcoming types unknown', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25&types=nope', NO_BODY],
  ['rem upcoming types empty', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25&types=', NO_BODY],
  ['rem upcoming types repeated', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25&types=task&types=event', NO_BODY],
  ['rem upcoming reversed', 'GET', '/reminders/upcoming?from=2026-11-25&to=2026-11-18', NO_BODY],
  ['rem upcoming too wide', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-12-18', NO_BODY],
  ['rem upcoming bad day', 'GET', '/reminders/upcoming?from=2026-02-31&to=2026-03-02', NO_BODY],
  ['rem upcoming bad day and types', 'GET', '/reminders/upcoming?from=2026-02-31&to=2026-02-30&types=task&types=event', NO_BODY],
  ['rem upcoming no from', 'GET', '/reminders/upcoming?to=2026-11-25', NO_BODY],
  ['rem upcoming bad shape', 'GET', '/reminders/upcoming?from=soon&to=2026-11-25', NO_BODY],
  ['rem upcoming household', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25&audience=household', NO_BODY],
  ['rem all', 'GET', `/reminders/all?entity_type=event&entity_id=${EVENT}`, NO_BODY],
  ['rem all none', 'GET', `/reminders/all?entity_type=task&entity_id=${TASK2}`, NO_BODY],
  ['rem all zero', 'GET', '/reminders/all?entity_type=task&entity_id=0', NO_BODY],
  ['rem all unknown type', 'GET', `/reminders/all?entity_type=nope&entity_id=${TASK}`, NO_BODY],
  ['rem all no type', 'GET', `/reminders/all?entity_id=${TASK}`, NO_BODY],
  ['rem all no id', 'GET', '/reminders/all?entity_type=task', NO_BODY],
  ['rem all denied', 'GET', `/reminders/all?entity_type=task&entity_id=${TASK}`, NO_BODY, { scopes: ['calendar:read'] }],
  ['rem get', 'GET', `/reminders?entity_type=task&entity_id=${TASK}`, NO_BODY],
  ['rem get none', 'GET', `/reminders?entity_type=task&entity_id=${TASK2}`, NO_BODY],
  ['rem get negative', 'GET', '/reminders?entity_type=task&entity_id=-1', NO_BODY],
  ['rem get zero', 'GET', '/reminders?entity_type=task&entity_id=0', NO_BODY],
  ['rem get unknown type', 'GET', `/reminders?entity_type=Task&entity_id=${TASK}`, NO_BODY],
  ['rem get denied', 'GET', `/reminders?entity_type=task&entity_id=${TASK}`, NO_BODY, { scopes: ['calendar:read'] }],
  ['rem put', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, { remind_ats: ['2026-11-20T09:00', '2026-11-20T10:00:00+01:00', '2026-11-21'] }],
  ['rem put same again', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, { remind_ats: ['2026-11-21T00:00:00Z', '2026-11-20T09:00:00'] }],
  ['rem put derived', 'PUT', '/reminders?entity_type=pantry_item&entity_id=1', { remind_ats: [] }],
  ['rem put derived not a list', 'PUT', '/reminders?entity_type=pantry_item&entity_id=1', { remind_ats: 'x' }],
  ['rem put not a list', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, { remind_ats: '2026-11-20' }],
  ['rem put object', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, { remind_ats: { 0: '2026-11-20' } }],
  ['rem put no list', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, {}],
  ['rem put no body', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, NO_BODY],
  ['rem put zero id', 'PUT', '/reminders?entity_type=task&entity_id=0', { remind_ats: [] }],
  ['rem put unknown target', 'PUT', '/reminders?entity_type=task&entity_id=999', { remind_ats: [] }],
  ['rem put bad entry', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, { remind_ats: ['2026-11-20', '2026-02-31'] }],
  ['rem put too many', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, { remind_ats: SIX }],
  ['rem put denied', 'PUT', `/reminders?entity_type=task&entity_id=${TASK2}`, { remind_ats: [] }, { scopes: ['calendar:write'] }],
  ['rem upcoming after put', 'GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25', NO_BODY],
  ['rem dismiss', 'PATCH', '/reminders/4/dismiss', {}],
  ['rem dismiss no body', 'PATCH', '/reminders/4/dismiss', NO_BODY],
  ['rem dismiss zero', 'PATCH', '/reminders/0/dismiss', {}],
  ['rem dismiss unknown', 'PATCH', '/reminders/999/dismiss', {}],
  ['rem dismiss text id', 'PATCH', '/reminders/abc/dismiss', {}],
  ['rem dismiss of other', 'PATCH', '/reminders/4/dismiss', {}, { as: 'member' }],
  ['rem dismiss denied', 'PATCH', '/reminders/4/dismiss', {}, { scopes: ['calendar:write'] }],
  ['rem dismiss derived', 'PATCH', `/reminders/${DERIVED}/dismiss`, {}],
  ['rem delete derived', 'DELETE', `/reminders/${DERIVED}`, NO_BODY],
  ['rem delete zero', 'DELETE', '/reminders/0', NO_BODY],
  ['rem delete unknown', 'DELETE', '/reminders/999', NO_BODY],
  ['rem delete text id', 'DELETE', '/reminders/1x', NO_BODY],
  ['rem delete denied', 'DELETE', '/reminders/4', NO_BODY, { scopes: ['calendar:write'] }],
  ['rem delete', 'DELETE', '/reminders/4', NO_BODY],
  ['rem delete again', 'DELETE', '/reminders/4', NO_BODY],
  ['rem delete filter derived', 'DELETE', '/reminders?entity_type=pantry_item&entity_id=1', NO_BODY],
  ['rem delete filter zero', 'DELETE', '/reminders?entity_type=task&entity_id=0', NO_BODY],
  ['rem delete filter unknown type', 'DELETE', `/reminders?entity_type=nope&entity_id=${TASK2}`, NO_BODY],
  ['rem delete filter denied', 'DELETE', `/reminders?entity_type=task&entity_id=${TASK2}`, NO_BODY, { scopes: ['calendar:write'] }],
  ['rem delete filter', 'DELETE', `/reminders?entity_type=task&entity_id=${TASK2}`, NO_BODY],
  ['rem get after delete filter', 'GET', `/reminders/all?entity_type=task&entity_id=${TASK2}`, NO_BODY],

  // ── notifications ─────────────────────────────────────────────────────────
  ['notif providers', 'GET', '/notifications/providers', NO_BODY],
  ['notif providers member', 'GET', '/notifications/providers', NO_BODY, { as: 'member' }],
  ['notif list empty', 'GET', '/notifications/channels', NO_BODY],
  ['notif create', 'POST', '/notifications/channels', NTFY],
  ['notif create gotify', 'POST', '/notifications/channels', { provider: 'gotify', name: 'Gotify', config: { baseUrl: 'https://gotify.example' }, secrets: { appToken: 'secret' } }],
  ['notif create blank name', 'POST', '/notifications/channels', { ...NTFY, name: '   ' }],
  ['notif create no topic', 'POST', '/notifications/channels', { ...NTFY, config: { baseUrl: 'https://ntfy.example' } }],
  ['notif create bad scheme', 'POST', '/notifications/channels', { ...NTFY, config: { ...NTFY.config, baseUrl: 'file:///etc/passwd' } }],
  ['notif create gotify no token', 'POST', '/notifications/channels', { provider: 'gotify', name: 'G', config: { baseUrl: 'https://gotify.example' } }],
  ['notif create unknown provider', 'POST', '/notifications/channels', { ...NTFY, provider: 'smtp' }],
  ['notif create name number', 'POST', '/notifications/channels', { ...NTFY, name: 5 }],
  ['notif create no config', 'POST', '/notifications/channels', { provider: 'ntfy', name: 'x' }],
  ['notif create scope ignored', 'POST', '/notifications/channels', { ...NTFY, name: 'Mine', scope: 'user', userId: MEMBER }],
  ['notif create no body', 'POST', '/notifications/channels', NO_BODY],
  ['notif create member', 'POST', '/notifications/channels', NTFY, { as: 'member' }],
  () => {
    createNotificationChannelStore({ db }).createChannel({ ...NTFY, name: 'Personal', scope: 'user', userId: MEMBER });
  },
  ['notif list', 'GET', '/notifications/channels', NO_BODY],
  ['notif update', 'PUT', '/notifications/channels/1', { enabled: false, name: 'Familie' }],
  ['notif update empty', 'PUT', '/notifications/channels/1', {}],
  ['notif update clear secret', 'PUT', '/notifications/channels/2', { clearSecrets: ['appToken'] }],
  ['notif update blank name', 'PUT', '/notifications/channels/1', { name: ' ' }],
  ['notif update bad config', 'PUT', '/notifications/channels/1', { config: { baseUrl: 'ftp://x' } }],
  ['notif update unknown', 'PUT', '/notifications/channels/999', { enabled: true }],
  ['notif update zero', 'PUT', '/notifications/channels/0', { enabled: true }],
  ['notif update text id', 'PUT', '/notifications/channels/x1', { enabled: true }],
  ['notif update personal', 'PUT', '/notifications/channels/4', { enabled: false }],
  ['notif update enabled text', 'PUT', '/notifications/channels/1', { enabled: 'no' }],
  ['notif update no body', 'PUT', '/notifications/channels/1', NO_BODY],
  ['notif test', 'POST', '/notifications/channels/1/test', {}],
  ['notif test unknown', 'POST', '/notifications/channels/999/test', {}],
  ['notif test zero', 'POST', '/notifications/channels/0/test', {}],
  ['notif list after test', 'GET', '/notifications/channels', NO_BODY],
  ['notif delete personal', 'DELETE', '/notifications/channels/4', NO_BODY],
  ['notif delete', 'DELETE', '/notifications/channels/2', NO_BODY],
  ['notif delete again', 'DELETE', '/notifications/channels/2', NO_BODY],
  ['notif delete zero', 'DELETE', '/notifications/channels/0', NO_BODY],
  ['notif delete text id', 'DELETE', '/notifications/channels/abc', NO_BODY],

  // ── modules ───────────────────────────────────────────────────────────────
  ['mod info', 'GET', '/modules/install/info', NO_BODY],
  ['mod info member', 'GET', '/modules/install/info', NO_BODY, { as: 'member' }],
  ['mod list empty', 'GET', '/modules', NO_BODY],
  ['mod install zip', 'POST', '/modules/install/zip', moduleZip('eq-mod')],
  ['mod install zip exists', 'POST', '/modules/install/zip', moduleZip('eq-mod')],
  ['mod install zip overwrite', 'POST', '/modules/install/zip?overwrite=1', moduleZip('eq-mod')],
  ['mod install zip overwrite word', 'POST', '/modules/install/zip?overwrite=true', moduleZip('eq-mod')],
  ['mod install zip empty', 'POST', '/modules/install/zip', Buffer.alloc(0)],
  ['mod install zip garbage', 'POST', '/modules/install/zip', Buffer.from('not a zip')],
  ['mod install zip no module', 'POST', '/modules/install/zip', makeZip({ 'readme.txt': 'hi' })],
  ['mod install zip token', 'POST', '/modules/install/zip', moduleZip('eq-mod'), { token: true }],
  ['mod install zip member', 'POST', '/modules/install/zip', moduleZip('eq-mod'), { as: 'member' }],
  ['mod install github blank', 'POST', '/modules/install/github', { url: '   ' }],
  ['mod install github empty', 'POST', '/modules/install/github', { url: '' }],
  ['mod install github not github', 'POST', '/modules/install/github', { url: 'https://gitlab.com/a/b' }],
  ['mod install github no url', 'POST', '/modules/install/github', {}],
  ['mod install github url number', 'POST', '/modules/install/github', { url: 5 }],
  ['mod install github list', 'POST', '/modules/install/github', []],
  ['mod install github no body', 'POST', '/modules/install/github', NO_BODY],
  ['mod list', 'GET', '/modules', NO_BODY],
  ['mod list admin', 'GET', '/modules?admin=1', NO_BODY],
  ['mod list member admin', 'GET', '/modules?admin=1', NO_BODY, { as: 'member' }],
  ['mod enable token', 'PATCH', '/modules/eq-mod', { enabled: true }, { token: true }],
  ['mod enable', 'PATCH', '/modules/eq-mod', { enabled: true }],
  ['mod enable unknown', 'PATCH', '/modules/nope-mod', { enabled: true }],
  ['mod enable text', 'PATCH', '/modules/eq-mod', { enabled: 'yes' }],
  ['mod enable number', 'PATCH', '/modules/eq-mod', { enabled: 1 }],
  ['mod enable null', 'PATCH', '/modules/eq-mod', { enabled: null }],
  ['mod enable missing', 'PATCH', '/modules/eq-mod', {}],
  ['mod enable no body', 'PATCH', '/modules/eq-mod', NO_BODY],
  ['mod enable member', 'PATCH', '/modules/eq-mod', { enabled: true }, { as: 'member' }],
  ['mod asset', 'GET', '/modules/assets/eq-mod/index.js', NO_BODY],
  ['mod asset member', 'GET', '/modules/assets/eq-mod/index.js', NO_BODY, { as: 'member' }],
  ['mod asset missing file', 'GET', '/modules/assets/eq-mod/nope.js', NO_BODY],
  ['mod asset unknown module', 'GET', '/modules/assets/nope-mod/index.js', NO_BODY],
  ['mod asset manifest', 'GET', '/modules/assets/eq-mod/module.json', NO_BODY],
  ['mod asset no path', 'GET', '/modules/assets/eq-mod/', NO_BODY],
  ['mod disable token', 'PATCH', '/modules/eq-mod', { enabled: false }, { token: true }],
  ['mod list after disable', 'GET', '/modules?admin=1', NO_BODY],
  ['mod delete token', 'DELETE', '/modules/eq-mod', NO_BODY, { token: true }],
  ['mod delete member', 'DELETE', '/modules/eq-mod', NO_BODY, { as: 'member' }],
  ['mod delete', 'DELETE', '/modules/eq-mod', NO_BODY],
  ['mod delete again', 'DELETE', '/modules/eq-mod', NO_BODY],

  // ── permissions ───────────────────────────────────────────────────────────
  ['perm catalog', 'GET', '/permissions/catalog', NO_BODY],
  ['perm catalog member', 'GET', '/permissions/catalog', NO_BODY, { as: 'member' }],
  ['perm role get', 'GET', '/permissions/role/child', NO_BODY],
  ['perm role get capital', 'GET', '/permissions/role/Child', NO_BODY],
  ['perm role get unknown', 'GET', '/permissions/role/aunt', NO_BODY],
  ['perm role put', 'PUT', '/permissions/role/dad', PERMS],
  ['perm role get after put', 'GET', '/permissions/role/dad', NO_BODY],
  ['perm role put unknown role', 'PUT', '/permissions/role/aunt', PERMS],
  ['perm role put unknown module', 'PUT', '/permissions/role/dad', { modules: { nope: 'read' } }],
  ['perm role put unknown widget', 'PUT', '/permissions/role/dad', { widgets: { nope: 'allow' } }],
  ['perm role put unknown capability', 'PUT', '/permissions/role/dad', { capabilities: { nope: 'allow' } }],
  ['perm role put invalid module access', 'PUT', '/permissions/role/dad', { modules: { tasks: 'bogus' } }],
  ['perm role put invalid widget access', 'PUT', '/permissions/role/dad', { widgets: { 'core:tasks': 'read' } }],
  ['perm role put invalid capability access', 'PUT', '/permissions/role/dad', { capabilities: { notes_edit_others: 'write' } }],
  ['perm role put access number', 'PUT', '/permissions/role/dad', { modules: { tasks: 1 } }],
  ['perm role put no body', 'PUT', '/permissions/role/dad', NO_BODY],
  ['perm role put list', 'PUT', '/permissions/role/dad', []],
  ['perm role put member', 'PUT', '/permissions/role/dad', PERMS, { as: 'member' }],
  ['perm role put empty maps', 'PUT', '/permissions/role/dad', { modules: {}, widgets: {} }],
  ['perm user get', 'GET', `/permissions/user/${MEMBER}`, NO_BODY],
  ['perm user get unknown', 'GET', '/permissions/user/999', NO_BODY],
  ['perm user get negative', 'GET', '/permissions/user/-5', NO_BODY],
  ['perm user get zero', 'GET', '/permissions/user/0', NO_BODY],
  ['perm user get text', 'GET', '/permissions/user/abc', NO_BODY],
  ['perm user get decimal', 'GET', '/permissions/user/1.5', NO_BODY],
  ['perm user put', 'PUT', `/permissions/user/${MEMBER}`, PERMS],
  ['perm user get after put', 'GET', `/permissions/user/${MEMBER}`, NO_BODY],
  ['perm user put admin', 'PUT', `/permissions/user/${ADMIN}`, PERMS],
  ['perm user put unknown', 'PUT', '/permissions/user/999', PERMS],
  ['perm user put text', 'PUT', '/permissions/user/x', PERMS],
  ['perm user put unknown module', 'PUT', `/permissions/user/${MEMBER}`, { modules: { nope: 'none' } }],
  ['perm user put invalid access', 'PUT', `/permissions/user/${MEMBER}`, { modules: { tasks: 'all' } }],
  ['perm user put clear', 'PUT', `/permissions/user/${MEMBER}`, { modules: {}, widgets: {}, capabilities: {} }],

  // ── email ─────────────────────────────────────────────────────────────────
  ['email get', 'GET', '/email/config', NO_BODY],
  ['email get member', 'GET', '/email/config', NO_BODY, { as: 'member' }],
  ['email put', 'PUT', '/email/config', { host: ' smtp.example ', port: 587, secure: 'starttls', user: 'u', pass: 'p', fromAddress: 'yuvomi@nas', fromName: 'Locked' }],
  ['email put bad secure', 'PUT', '/email/config', { secure: 'tls' }],
  ['email put secure null', 'PUT', '/email/config', { secure: null }],
  ['email put secure number', 'PUT', '/email/config', { secure: 1 }],
  ['email put port text', 'PUT', '/email/config', { port: '587' }],
  ['email put port empty', 'PUT', '/email/config', { port: '' }],
  ['email put port zero', 'PUT', '/email/config', { port: 0 }],
  ['email put port big', 'PUT', '/email/config', { port: 70000 }],
  ['email put port fraction', 'PUT', '/email/config', { port: 25.5 }],
  ['email put port list', 'PUT', '/email/config', { port: [25] }],
  ['email put port and from', 'PUT', '/email/config', { port: 0, fromAddress: 'nope' }],
  ['email put from bad', 'PUT', '/email/config', { fromAddress: 'keine-mail' }],
  ['email put from two at', 'PUT', '/email/config', { fromAddress: 'a@b@c' }],
  ['email put from number', 'PUT', '/email/config', { fromAddress: 5 }],
  ['email put bad secure and from', 'PUT', '/email/config', { secure: 'tls', fromAddress: 'nope' }],
  ['email put port null', 'PUT', '/email/config', { port: null, fromAddress: '  ', host: null }],
  ['email put clear password', 'PUT', '/email/config', { clearPassword: true }],
  ['email put empty', 'PUT', '/email/config', {}],
  ['email put no body', 'PUT', '/email/config', NO_BODY],
  ['email put list', 'PUT', '/email/config', []],
  ['email put member', 'PUT', '/email/config', { port: 25 }, { as: 'member' }],
  ['email test', 'POST', '/email/test', { to: ' admin@example.org ' }],
  ['email test no recipient', 'POST', '/email/test', {}],
  ['email test blank', 'POST', '/email/test', { to: '  ' }],
  ['email test no body', 'POST', '/email/test', NO_BODY],
  ['email test number', 'POST', '/email/test', { to: 5 }],
  ['email test member', 'POST', '/email/test', { to: 'a@b' }, { as: 'member' }],

  // ── weather ───────────────────────────────────────────────────────────────
  ['wx not configured', 'GET', '/weather', NO_BODY],
  () => { weatherConfig.weather_provider = 'open-meteo'; },
  ['wx no coordinates', 'GET', '/weather', NO_BODY],
  () => {
    weatherConfig.weather_lat = '52.52';
    weatherConfig.weather_lon = '13.41';
    weatherConfig.weather_city = 'Berlin';
    weatherConfig.weather_units = 'metric';
  },
  ['wx open-meteo', 'GET', '/weather', NO_BODY],
  ['wx cached', 'GET', '/weather?lang=de', NO_BODY],
  ['wx member', 'GET', '/weather', NO_BODY, { as: 'member' }],
  () => { weatherConfig.weather_units = 'imperial'; weatherState.mode = 'http'; },
  ['wx upstream http', 'GET', '/weather', NO_BODY],
  () => { weatherState.mode = 'throw'; },
  ['wx upstream throw', 'GET', '/weather', NO_BODY],
  () => { weatherState.mode = 'ok'; },
  ['wx imperial', 'GET', '/weather', NO_BODY],
  ['wx city repeated', 'GET', '/weather?city=a&city=b', NO_BODY],
  ['wx geocode', 'GET', '/weather/geocode?name=Berlin&lang=de', NO_BODY],
  ['wx geocode cached', 'GET', '/weather/geocode?name=%20berlin%20&lang=de-AT', NO_BODY],
  ['wx geocode short', 'GET', '/weather/geocode?name=%20a%20', NO_BODY],
  ['wx geocode blank', 'GET', '/weather/geocode?name=%20%20%20', NO_BODY],
  ['wx geocode empty', 'GET', '/weather/geocode?name=', NO_BODY],
  ['wx geocode missing', 'GET', '/weather/geocode', NO_BODY],
  ['wx geocode repeated', 'GET', '/weather/geocode?name=ab&name=cd', NO_BODY],
  ['wx geocode long', 'GET', `/weather/geocode?name=${'x'.repeat(101)}`, NO_BODY],
  ['wx geocode long padded', 'GET', `/weather/geocode?name=%20${'x'.repeat(100)}%20`, NO_BODY],
  () => { weatherState.mode = 'http'; },
  ['wx geocode upstream http', 'GET', '/weather/geocode?name=Hamburg', NO_BODY],
  () => { weatherState.mode = 'throw'; },
  ['wx geocode upstream throw', 'GET', '/weather/geocode?name=Hamburg', NO_BODY],
  ['wx icon throw', 'GET', '/weather/icon/10d', NO_BODY],
  () => { weatherState.mode = 'http'; },
  ['wx icon upstream http', 'GET', '/weather/icon/10d', NO_BODY],
  () => { weatherState.mode = 'ok'; },
  ['wx icon', 'GET', '/weather/icon/10d', NO_BODY],
  ['wx icon short', 'GET', '/weather/icon/1', NO_BODY],
  ['wx icon long', 'GET', '/weather/icon/10dxx', NO_BODY],
  ['wx icon symbol', 'GET', '/weather/icon/1_d', NO_BODY],
  ['wx icon encoded', 'GET', '/weather/icon/%31%30d', NO_BODY],
];

/** @type {Record<string, { status: number, body: unknown }>} */
const EXPECTED = {
  "rem pending empty": {"status":200,"body":{"data":[]}},
  "rem post task": {"status":201,"body":{"data":{"id":2,"entity_type":"task","entity_id":1,"remind_at":"2026-11-18T10:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null}}},
  "rem post event offset": {"status":201,"body":{"data":{"id":3,"entity_type":"event","entity_id":1,"remind_at":"2026-11-19T07:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null}}},
  "rem post derived": {"status":400,"body":{"error":"Reminders for pantry_item are derived from the item itself and cannot be set here.","code":400}},
  "rem post derived waste": {"status":400,"body":{"error":"Reminders for waste_pickup are derived from the item itself and cannot be set here.","code":400}},
  "rem post unknown type": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entity_type","rule":"enum"}]}},
  "rem post type number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entity_type","rule":"type"}]}},
  "rem post type empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entity_type","rule":"enum"}]}},
  "rem post no type": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/entity_type","rule":"required"}]}},
  "rem post zero id": {"status":400,"body":{"error":"entity_id must be a positive number.","code":400}},
  "rem post zero id and derived": {"status":400,"body":{"error":"entity_id must be a positive number. Reminders for pantry_item are derived from the item itself and cannot be set here.","code":400}},
  "rem post bad day": {"status":201,"body":{"data":{"id":4,"entity_type":"task","entity_id":1,"remind_at":"2026-02-31T10:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null}}},
  "rem post bad shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/remind_at","rule":"pattern"}]}},
  "rem post unknown target": {"status":404,"body":{"error":"Entity not found.","code":404}},
  "rem post module denied": {"status":403,"body":{"error":"You do not have access to this module.","code":403,"reason":"module_access_denied"}},
  "rem post no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rem pending": {"status":200,"body":{"data":[{"id":4,"entity_type":"task","entity_id":1,"remind_at":"2026-02-31T10:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null,"entity_title":"Steuer","cycle_anchor_kind":null}]}},
  "rem pending household": {"status":200,"body":{"data":[]}},
  "rem pending member": {"status":200,"body":{"data":[]}},
  "rem pending calendar token": {"status":200,"body":{"data":[]}},
  "rem upcoming": {"status":200,"body":{"data":[{"id":3,"entity_type":"event","entity_id":1,"remind_at":"2026-11-19T07:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null,"entity_title":"Elternabend","cycle_anchor_kind":null,"fires_at":"2026-11-19T07:00:00Z"}]}},
  "rem upcoming types": {"status":200,"body":{"data":[{"id":3,"entity_type":"event","entity_id":1,"remind_at":"2026-11-19T07:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null,"entity_title":"Elternabend","cycle_anchor_kind":null,"fires_at":"2026-11-19T07:00:00Z"}]}},
  "rem upcoming types task": {"status":200,"body":{"data":[]}},
  "rem upcoming types unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/types/0","rule":"enum"}]}},
  "rem upcoming types empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/types/0","rule":"enum"}]}},
  "rem upcoming types repeated": {"status":400,"body":{"error":"types must be a comma-separated list of: task, event, subscription, inventory_item, inventory_tracked_date, pantry_item, cycle_period, cycle_log_nudge, schedule_entry, schedule_extra_entry, waste_pickup, document_expiry, health_prevention_due, fasting_goal, fasting_next_start, shopping_move_returned.","code":400}},
  "rem upcoming reversed": {"status":400,"body":{"error":"to must not be before from.","code":400}},
  "rem upcoming too wide": {"status":400,"body":{"error":"The window may span at most 14 days.","code":400}},
  "rem upcoming bad day": {"status":400,"body":{"error":"from must be a valid date and time.","code":400}},
  "rem upcoming bad day and types": {"status":400,"body":{"error":"from must be a valid date and time. to must be a valid date and time. types must be a comma-separated list of: task, event, subscription, inventory_item, inventory_tracked_date, pantry_item, cycle_period, cycle_log_nudge, schedule_entry, schedule_extra_entry, waste_pickup, document_expiry, health_prevention_due, fasting_goal, fasting_next_start, shopping_move_returned.","code":400}},
  "rem upcoming no from": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/from","rule":"required"}]}},
  "rem upcoming bad shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/from","rule":"pattern"}]}},
  "rem upcoming household": {"status":200,"body":{"data":[]}},
  "rem all": {"status":200,"body":{"data":[{"id":3,"entity_type":"event","entity_id":1,"remind_at":"2026-11-19T07:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null}]}},
  "rem all none": {"status":200,"body":{"data":[]}},
  "rem all zero": {"status":400,"body":{"error":"entity_type and entity_id are required.","code":400}},
  "rem all unknown type": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/entity_type","rule":"enum"}]}},
  "rem all no type": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/entity_type","rule":"required"}]}},
  "rem all no id": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/entity_id","rule":"required"}]}},
  "rem all denied": {"status":403,"body":{"error":"You do not have access to this module.","code":403,"reason":"module_access_denied"}},
  "rem get": {"status":200,"body":{"data":{"id":4,"entity_type":"task","entity_id":1,"remind_at":"2026-02-31T10:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null}}},
  "rem get none": {"status":200,"body":{"data":null}},
  "rem get negative": {"status":200,"body":{"data":null}},
  "rem get zero": {"status":400,"body":{"error":"entity_type and entity_id are required.","code":400}},
  "rem get unknown type": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/entity_type","rule":"enum"}]}},
  "rem get denied": {"status":403,"body":{"error":"You do not have access to this module.","code":403,"reason":"module_access_denied"}},
  "rem put": {"status":200,"body":{"data":[{"id":5,"entity_type":"task","entity_id":2,"remind_at":"2026-11-20T09:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null},{"id":6,"entity_type":"task","entity_id":2,"remind_at":"2026-11-21T00:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null}]}},
  "rem put same again": {"status":200,"body":{"data":[{"id":5,"entity_type":"task","entity_id":2,"remind_at":"2026-11-20T09:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null},{"id":6,"entity_type":"task","entity_id":2,"remind_at":"2026-11-21T00:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null}]}},
  "rem put derived": {"status":400,"body":{"error":"Reminders for pantry_item are derived from the item itself and cannot be set here.","code":400}},
  "rem put derived not a list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/remind_ats","rule":"type"}]}},
  "rem put not a list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/remind_ats","rule":"type"}]}},
  "rem put object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/remind_ats","rule":"type"}]}},
  "rem put no list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/remind_ats","rule":"required"}]}},
  "rem put no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rem put zero id": {"status":400,"body":{"error":"entity_type and entity_id are required.","code":400}},
  "rem put unknown target": {"status":404,"body":{"error":"Entity not found.","code":404}},
  "rem put bad entry": {"status":200,"body":{"data":[{"id":8,"entity_type":"task","entity_id":2,"remind_at":"2026-02-31T00:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null},{"id":7,"entity_type":"task","entity_id":2,"remind_at":"2026-11-20T00:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null}]}},
  "rem put too many": {"status":400,"body":{"error":"At most 5 reminders per entity.","code":400}},
  "rem put denied": {"status":403,"body":{"error":"You do not have access to this module.","code":403,"reason":"module_access_denied"}},
  "rem upcoming after put": {"status":200,"body":{"data":[{"id":3,"entity_type":"event","entity_id":1,"remind_at":"2026-11-19T07:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null,"entity_title":"Elternabend","cycle_anchor_kind":null,"fires_at":"2026-11-19T07:00:00Z"},{"id":7,"entity_type":"task","entity_id":2,"remind_at":"2026-11-20T00:00:00","dismissed":0,"created_by":1,"created_at":"<clock>","pushed_at":null,"assigned_from":null,"entity_title":"Garten","cycle_anchor_kind":null,"fires_at":"2026-11-20T00:00:00Z"}]}},
  "rem dismiss": {"status":200,"body":{"data":{"id":4}}},
  "rem dismiss no body": {"status":200,"body":{"data":{"id":4}}},
  "rem dismiss zero": {"status":400,"body":{"error":"Invalid reminder ID.","code":400}},
  "rem dismiss unknown": {"status":404,"body":{"error":"Reminder not found.","code":404}},
  "rem dismiss text id": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rem dismiss of other": {"status":404,"body":{"error":"Reminder not found.","code":404}},
  "rem dismiss denied": {"status":403,"body":{"error":"You do not have access to this module.","code":403,"reason":"module_access_denied"}},
  "rem dismiss derived": {"status":200,"body":{"data":{"id":1}}},
  "rem delete derived": {"status":400,"body":{"error":"Reminders for pantry_item are derived from the item itself and cannot be set here.","code":400}},
  "rem delete zero": {"status":400,"body":{"error":"Invalid reminder ID.","code":400}},
  "rem delete unknown": {"status":404,"body":{"error":"Reminder not found.","code":404}},
  "rem delete text id": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rem delete denied": {"status":403,"body":{"error":"You do not have access to this module.","code":403,"reason":"module_access_denied"}},
  "rem delete": {"status":204,"body":null},
  "rem delete again": {"status":404,"body":{"error":"Reminder not found.","code":404}},
  "rem delete filter derived": {"status":400,"body":{"error":"Reminders for pantry_item are derived from the item itself and cannot be set here.","code":400}},
  "rem delete filter zero": {"status":400,"body":{"error":"entity_type and entity_id are required.","code":400}},
  "rem delete filter unknown type": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/entity_type","rule":"enum"}]}},
  "rem delete filter denied": {"status":403,"body":{"error":"You do not have access to this module.","code":403,"reason":"module_access_denied"}},
  "rem delete filter": {"status":204,"body":null},
  "rem get after delete filter": {"status":200,"body":{"data":[]}},
  "notif providers": {"status":200,"body":{"data":[{"id":"gotify","name":"Gotify","ready":true},{"id":"ntfy","name":"ntfy"},{"id":"webhook","name":"Webhook","ready":false},{"id":"email","name":"Email","ready":false}]}},
  "notif providers member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "notif list empty": {"status":200,"body":{"data":[]}},
  "notif create": {"status":201,"body":{"data":{"id":1,"provider":"ntfy","name":"Family","enabled":true,"scope":"household","userId":null,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"}}},
  "notif create gotify": {"status":201,"body":{"data":{"id":2,"provider":"gotify","name":"Gotify","enabled":false,"scope":"household","userId":null,"config":{"baseUrl":"https://gotify.example","priority":5},"secretSet":true,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"}}},
  "notif create blank name": {"status":400,"body":{"error":"Notification channel name is required.","code":400}},
  "notif create no topic": {"status":400,"body":{"error":"ntfy topic is required.","code":400}},
  "notif create bad scheme": {"status":400,"body":{"error":"Notification channel URL scheme must be http or https.","code":400}},
  "notif create gotify no token": {"status":400,"body":{"error":"Gotify app token is required.","code":400}},
  "notif create unknown provider": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/provider","rule":"enum"}]}},
  "notif create name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "notif create no config": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/config","rule":"required"}]}},
  "notif create scope ignored": {"status":201,"body":{"data":{"id":3,"provider":"ntfy","name":"Mine","enabled":true,"scope":"household","userId":null,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"}}},
  "notif create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "notif create member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "notif list": {"status":200,"body":{"data":[{"id":2,"provider":"gotify","name":"Gotify","enabled":false,"scope":"household","userId":null,"config":{"baseUrl":"https://gotify.example","priority":5},"secretSet":true,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"},{"id":1,"provider":"ntfy","name":"Family","enabled":true,"scope":"household","userId":null,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"},{"id":3,"provider":"ntfy","name":"Mine","enabled":true,"scope":"household","userId":null,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"},{"id":4,"provider":"ntfy","name":"Personal","enabled":true,"scope":"user","userId":2,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"}]}},
  "notif update": {"status":200,"body":{"data":{"id":1,"provider":"ntfy","name":"Familie","enabled":false,"scope":"household","userId":null,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"}}},
  "notif update empty": {"status":200,"body":{"data":{"id":1,"provider":"ntfy","name":"Familie","enabled":false,"scope":"household","userId":null,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"}}},
  "notif update clear secret": {"status":200,"body":{"data":{"id":2,"provider":"gotify","name":"Gotify","enabled":false,"scope":"household","userId":null,"config":{"baseUrl":"https://gotify.example","priority":5},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"}}},
  "notif update blank name": {"status":400,"body":{"error":"Notification channel name is required.","code":400}},
  "notif update bad config": {"status":400,"body":{"error":"Notification channel URL scheme must be http or https.","code":400}},
  "notif update unknown": {"status":404,"body":{"error":"Notification channel not found.","code":404}},
  "notif update zero": {"status":400,"body":{"error":"Invalid channel id.","code":400}},
  "notif update text id": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "notif update personal": {"status":409,"body":{"error":"Only household notification channels can be changed here.","code":409}},
  "notif update enabled text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "notif update no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "notif test": {"status":200,"body":{"data":{"ok":true,"channel":1}}},
  "notif test unknown": {"status":404,"body":{"error":"Notification channel not found.","code":404}},
  "notif test zero": {"status":400,"body":{"error":"Invalid channel id.","code":400}},
  "notif list after test": {"status":200,"body":{"data":[{"id":2,"provider":"gotify","name":"Gotify","enabled":false,"scope":"household","userId":null,"config":{"baseUrl":"https://gotify.example","priority":5},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"},{"id":1,"provider":"ntfy","name":"Familie","enabled":false,"scope":"household","userId":null,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":"<clock>","lastSuccessAt":"<clock>","lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"},{"id":3,"provider":"ntfy","name":"Mine","enabled":true,"scope":"household","userId":null,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"},{"id":4,"provider":"ntfy","name":"Personal","enabled":true,"scope":"user","userId":2,"config":{"baseUrl":"https://ntfy.example","topic":"family","priority":"default","authType":"none"},"secretSet":false,"lastTestAt":null,"lastSuccessAt":null,"lastError":null,"createdAt":"<clock>","updatedAt":"<clock>"}]}},
  "notif delete personal": {"status":200,"body":{"data":{"deleted":true}}},
  "notif delete": {"status":200,"body":{"data":{"deleted":true}}},
  "notif delete again": {"status":404,"body":{"error":"Notification channel not found.","code":404}},
  "notif delete zero": {"status":400,"body":{"error":"Invalid channel id.","code":400}},
  "notif delete text id": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "mod info": {"status":200,"body":{"data":{"writable":true,"persistent":"<host>","webInstall":true,"maxZipMb":20}}},
  "mod info member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "mod list empty": {"status":200,"body":{"data":[]}},
  "mod install zip": {"status":201,"body":{"data":{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0","manifestVersion":1,"description":"","icon":"box","accent":"#6366F1","entry":"index.js","style":null,"settings":null,"page":{"composition":"reading","width":"reading","navigation":"standard","responsive":"standard"},"route":{"path":"/m/eq-mod","entry":"/api/v1/modules/assets/eq-mod/index.js","style":null},"menu":{"show":true,"label":"Mod eq-mod","icon":"box","order":1000},"i18n":{"defaultLocale":"en","availableLocales":[],"coreLocales":["ar","cs","de","el","en","es","fa","fil","fr","hi","hu","id","it","ja","ko","nb","nl","pl","pt","pt-BR","ru","sv","tr","uk","vi","zh","zh-Hant"]},"capabilities":null,"install":{"source":"zip","url":null,"ref":null,"commit":null,"path":null,"installedAt":"2026-11-18T12:00:00.000Z","approved":false,"installedByName":null},"enabled":false,"status":"disabled","error":null},"replaced":false,"skipped":[]}},
  "mod install zip exists": {"status":409,"body":{"error":"A module with the id \"eq-mod\" is already installed.","code":409,"reason":"exists","existing":{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0","install":{"source":"zip","url":null,"ref":null,"commit":null,"path":null,"installedAt":"2026-11-18T12:00:00.000Z","approved":false}},"incoming":{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0"}}},
  "mod install zip overwrite": {"status":201,"body":{"data":{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0","manifestVersion":1,"description":"","icon":"box","accent":"#6366F1","entry":"index.js","style":null,"settings":null,"page":{"composition":"reading","width":"reading","navigation":"standard","responsive":"standard"},"route":{"path":"/m/eq-mod","entry":"/api/v1/modules/assets/eq-mod/index.js","style":null},"menu":{"show":true,"label":"Mod eq-mod","icon":"box","order":1000},"i18n":{"defaultLocale":"en","availableLocales":[],"coreLocales":["ar","cs","de","el","en","es","fa","fil","fr","hi","hu","id","it","ja","ko","nb","nl","pl","pt","pt-BR","ru","sv","tr","uk","vi","zh","zh-Hant"]},"capabilities":null,"install":{"source":"zip","url":null,"ref":null,"commit":null,"path":null,"installedAt":"2026-11-18T12:00:00.000Z","approved":false,"installedByName":null},"enabled":false,"status":"disabled","error":null},"replaced":true,"skipped":[]}},
  "mod install zip overwrite word": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/overwrite","rule":"enum"}]}},
  "mod install zip empty": {"status":400,"body":{"error":"Send the module ZIP file as the request body with Content-Type application/zip.","code":400,"reason":"not_zip"}},
  "mod install zip garbage": {"status":400,"body":{"error":"The file is not a ZIP archive.","code":400,"reason":"not_zip"}},
  "mod install zip no module": {"status":400,"body":{"error":"The archive does not contain a module.json.","code":400,"reason":"no_manifest"}},
  "mod install zip token": {"status":403,"body":{"error":"Installing or deleting modules is only possible from a signed-in browser session, not with an API token.","code":403,"reason":"module_session_required"}},
  "mod install zip member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "mod install github blank": {"status":400,"body":{"error":"Enter a GitHub repository URL such as https://github.com/owner/repo.","code":400,"reason":"bad_url"}},
  "mod install github empty": {"status":400,"body":{"error":"Enter a GitHub repository URL such as https://github.com/owner/repo.","code":400,"reason":"bad_url"}},
  "mod install github not github": {"status":400,"body":{"error":"Only repositories on github.com can be installed.","code":400,"reason":"bad_url"}},
  "mod install github no url": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"bad_url","fields":[{"path":"body/url","rule":"required","reason":"bad_url"}]}},
  "mod install github url number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"bad_url","fields":[{"path":"body/url","rule":"type","reason":"bad_url"}]}},
  "mod install github list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"bad_url","fields":[{"path":"body","rule":"type","reason":"bad_url"}]}},
  "mod install github no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"bad_url","fields":[{"path":"body","rule":"required","reason":"bad_url"}]}},
  "mod list": {"status":200,"body":{"data":[]}},
  "mod list admin": {"status":200,"body":{"data":[{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0","manifestVersion":1,"description":"","icon":"box","accent":"#6366F1","entry":"index.js","style":null,"settings":null,"page":{"composition":"reading","width":"reading","navigation":"standard","responsive":"standard"},"route":{"path":"/m/eq-mod","entry":"/api/v1/modules/assets/eq-mod/index.js","style":null},"menu":{"show":true,"label":"Mod eq-mod","icon":"box","order":1000},"i18n":{"defaultLocale":"en","availableLocales":[],"coreLocales":["ar","cs","de","el","en","es","fa","fil","fr","hi","hu","id","it","ja","ko","nb","nl","pl","pt","pt-BR","ru","sv","tr","uk","vi","zh","zh-Hant"]},"capabilities":null,"install":{"source":"zip","url":null,"ref":null,"commit":null,"path":null,"installedAt":"2026-11-18T12:00:00.000Z","approved":false,"installedByName":null},"enabled":false,"status":"disabled","error":null}]}},
  "mod list member admin": {"status":200,"body":{"data":[]}},
  "mod enable token": {"status":403,"body":{"error":"Enabling a module is only possible from a signed-in browser session, not with an API token.","code":403,"reason":"module_session_required"}},
  "mod enable": {"status":200,"body":{"data":{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0","manifestVersion":1,"description":"","icon":"box","accent":"#6366F1","entry":"index.js","style":null,"settings":null,"page":{"composition":"reading","width":"reading","navigation":"standard","responsive":"standard"},"route":{"path":"/m/eq-mod","entry":"/api/v1/modules/assets/eq-mod/index.js","style":null},"menu":{"show":true,"label":"Mod eq-mod","icon":"box","order":1000},"i18n":{"defaultLocale":"en","availableLocales":[],"coreLocales":["ar","cs","de","el","en","es","fa","fil","fr","hi","hu","id","it","ja","ko","nb","nl","pl","pt","pt-BR","ru","sv","tr","uk","vi","zh","zh-Hant"]},"capabilities":null,"install":{"source":"zip","url":null,"ref":null,"commit":null,"path":null,"installedAt":"2026-11-18T12:00:00.000Z","approved":true,"installedByName":null},"enabled":true,"status":"enabled","error":null}}},
  "mod enable unknown": {"status":404,"body":{"error":"Module not found.","code":404}},
  "mod enable text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "mod enable number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "mod enable null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "mod enable missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"required"}]}},
  "mod enable no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "mod enable member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "mod asset": {"status":200,"body":{"type":"text/javascript; charset=utf-8","length":33}},
  "mod asset member": {"status":200,"body":{"type":"text/javascript; charset=utf-8","length":33}},
  "mod asset missing file": {"status":404,"body":{"error":"Module asset not found.","code":404}},
  "mod asset unknown module": {"status":404,"body":{"error":"Module not found or disabled.","code":404}},
  "mod asset manifest": {"status":200,"body":{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0","entry":"index.js"}},
  "mod asset no path": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/assetPath","rule":"required"}]}},
  "mod disable token": {"status":200,"body":{"data":{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0","manifestVersion":1,"description":"","icon":"box","accent":"#6366F1","entry":"index.js","style":null,"settings":null,"page":{"composition":"reading","width":"reading","navigation":"standard","responsive":"standard"},"route":{"path":"/m/eq-mod","entry":"/api/v1/modules/assets/eq-mod/index.js","style":null},"menu":{"show":true,"label":"Mod eq-mod","icon":"box","order":1000},"i18n":{"defaultLocale":"en","availableLocales":[],"coreLocales":["ar","cs","de","el","en","es","fa","fil","fr","hi","hu","id","it","ja","ko","nb","nl","pl","pt","pt-BR","ru","sv","tr","uk","vi","zh","zh-Hant"]},"capabilities":null,"install":{"source":"zip","url":null,"ref":null,"commit":null,"path":null,"installedAt":"2026-11-18T12:00:00.000Z","approved":false,"installedByName":null},"enabled":false,"status":"disabled","error":null}}},
  "mod list after disable": {"status":200,"body":{"data":[{"id":"eq-mod","name":"Mod eq-mod","version":"1.0.0","manifestVersion":1,"description":"","icon":"box","accent":"#6366F1","entry":"index.js","style":null,"settings":null,"page":{"composition":"reading","width":"reading","navigation":"standard","responsive":"standard"},"route":{"path":"/m/eq-mod","entry":"/api/v1/modules/assets/eq-mod/index.js","style":null},"menu":{"show":true,"label":"Mod eq-mod","icon":"box","order":1000},"i18n":{"defaultLocale":"en","availableLocales":[],"coreLocales":["ar","cs","de","el","en","es","fa","fil","fr","hi","hu","id","it","ja","ko","nb","nl","pl","pt","pt-BR","ru","sv","tr","uk","vi","zh","zh-Hant"]},"capabilities":null,"install":{"source":"zip","url":null,"ref":null,"commit":null,"path":null,"installedAt":"2026-11-18T12:00:00.000Z","approved":false,"installedByName":null},"enabled":false,"status":"disabled","error":null}]}},
  "mod delete token": {"status":403,"body":{"error":"Installing or deleting modules is only possible from a signed-in browser session, not with an API token.","code":403,"reason":"module_session_required"}},
  "mod delete member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "mod delete": {"status":200,"body":{"data":{"id":"eq-mod","deleted":true}}},
  "mod delete again": {"status":404,"body":{"error":"Module not found.","code":404,"reason":"not_found"}},
  "perm catalog": {"status":200,"body":{"data":{"modules":[{"key":"calendar","labelKey":"nav.calendar","label":null,"icon":"calendar","extensionModuleId":null},{"key":"tasks","labelKey":"nav.tasks","label":null,"icon":"check-square","extensionModuleId":null},{"key":"notes","labelKey":"nav.notes","label":null,"icon":"sticky-note","extensionModuleId":null},{"key":"contacts","labelKey":"nav.contacts","label":null,"icon":"book-user","extensionModuleId":null},{"key":"meals","labelKey":"nav.kitchen","label":null,"icon":"utensils","extensionModuleId":null},{"key":"shopping","labelKey":"nav.shopping","label":null,"icon":"shopping-cart","extensionModuleId":null},{"key":"pantry","labelKey":"nav.pantry","label":null,"icon":"archive","extensionModuleId":null},{"key":"inventory","labelKey":"nav.inventory","label":null,"icon":"package","extensionModuleId":null},{"key":"budget","labelKey":"nav.budget","label":null,"icon":"wallet","extensionModuleId":null},{"key":"documents","labelKey":"nav.documents","label":null,"icon":"folder-lock","extensionModuleId":null},{"key":"housekeeping","labelKey":"nav.housekeeping","label":null,"icon":"paintbrush","extensionModuleId":null},{"key":"waste","labelKey":"nav.waste","label":null,"icon":"trash-2","extensionModuleId":null},{"key":"rewards","labelKey":"nav.rewards","label":null,"icon":"award","extensionModuleId":null},{"key":"health","labelKey":"nav.health","label":null,"icon":"heart-pulse","extensionModuleId":null},{"key":"schedule","labelKey":"nav.schedule","label":null,"icon":"calendar-clock","extensionModuleId":null}],"widgets":[{"id":"tasks","module":"tasks","label":null,"labelKey":null},{"id":"calendar","module":"calendar","label":null,"labelKey":null},{"id":"meals","module":"meals","label":null,"labelKey":null},{"id":"shopping","module":"shopping","label":null,"labelKey":null},{"id":"birthdays","module":"calendar","label":null,"labelKey":null},{"id":"budget","module":"budget","label":null,"labelKey":null},{"id":"rewards","module":"rewards","label":null,"labelKey":null},{"id":"health","module":"health","label":null,"labelKey":null},{"id":"cycle","module":"health","label":null,"labelKey":null},{"id":"fasting","module":"health","label":null,"labelKey":null},{"id":"nutrition","module":"health","label":null,"labelKey":null},{"id":"housekeeping","module":"housekeeping","label":null,"labelKey":null},{"id":"schedule","module":"schedule","label":null,"labelKey":null},{"id":"waste","module":"waste","label":null,"labelKey":null},{"id":"pantry","module":"pantry","label":null,"labelKey":null},{"id":"notes","module":"notes","label":null,"labelKey":null},{"id":"family","module":null,"label":null,"labelKey":null},{"id":"weather","module":null,"label":null,"labelKey":null},{"id":"clock","module":null,"label":null,"labelKey":null},{"id":"metrics","module":null,"label":null,"labelKey":null},{"id":"countdown","module":null,"label":null,"labelKey":null},{"id":"quicklinks","module":null,"label":null,"labelKey":null}],"capabilities":[{"key":"notes_manage_household_categories","module":"notes","labelKey":"noteCategories.permissionLabel","default":"none"},{"key":"health_use_fasting","module":"health","labelKey":"health.fasting.permissionLabel","default":"allow"},{"key":"housekeeping_view_amounts","module":"housekeeping","labelKey":"housekeeping.amountsPermissionLabel","default":"allow"},{"key":"calendar_edit_others","module":"calendar","labelKey":"settings.permCapabilityCalendarEditOthers","default":"allow"},{"key":"notes_edit_others","module":"notes","labelKey":"settings.permCapabilityNotesEditOthers","default":"allow"},{"key":"inventory_edit_others","module":"inventory","labelKey":"settings.permCapabilityInventoryEditOthers","default":"allow"},{"key":"inventory_view_prices","module":"inventory","labelKey":"settings.permCapabilityInventoryPrices","default":"allow"},{"key":"tasks_reorder_family","module":"tasks","labelKey":"settings.permCapabilityTasksReorder","default":"allow"}],"roles":["dad","mom","parent","child","grandparent","relative","other"],"moduleAccessLevels":["none","read","write"],"widgetAccessLevels":["none","allow"],"capabilityAccessLevels":["none","allow"],"defaults":{"module":"write","widget":"allow","capability":"none"},"invitePresets":{"values":["restricted","role"],"default":"restricted","restrictedModules":["health","budget","documents"]},"childStart":{"modules":{"budget":"none","housekeeping":"read","waste":"read"},"capabilities":{"health_use_fasting":"none","housekeeping_view_amounts":"none","calendar_edit_others":"none","notes_edit_others":"none","inventory_edit_others":"none","inventory_view_prices":"none","tasks_reorder_family":"none"}},"scopeModuleKeys":["tasks","shopping","meals","pantry","inventory","calendar","notes","contacts","schedule","budget","documents","health","rewards","housekeeping","waste","weather","family","dashboard","search"],"members":[{"id":1,"display_name":"linda","username":"linda","avatar_color":"#007AFF","avatar_data":null,"role":"admin","family_role":"mom","access_scope":"family"},{"id":2,"display_name":"tom","username":"tom","avatar_color":"#007AFF","avatar_data":null,"role":"member","family_role":"dad","access_scope":"family"}]}}},
  "perm catalog member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "perm role get": {"status":200,"body":{"data":{"modules":{},"widgets":{},"capabilities":{}}}},
  "perm role get capital": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/familyRole","rule":"enum"}]}},
  "perm role get unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/familyRole","rule":"enum"}]}},
  "perm role put": {"status":200,"body":{"data":{"modules":{"tasks":"read","budget":"none"},"widgets":{},"capabilities":{}}}},
  "perm role get after put": {"status":200,"body":{"data":{"modules":{"tasks":"read","budget":"none"},"widgets":{},"capabilities":{}}}},
  "perm role put unknown role": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/familyRole","rule":"enum"}]}},
  "perm role put unknown module": {"status":400,"body":{"error":"Unknown module: nope","code":400}},
  "perm role put unknown widget": {"status":400,"body":{"error":"Unknown widget: nope","code":400}},
  "perm role put unknown capability": {"status":400,"body":{"error":"Unknown capability: nope","code":400}},
  "perm role put invalid module access": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/modules/tasks","rule":"enum"}]}},
  "perm role put invalid widget access": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/widgets/core:tasks","rule":"enum"}]}},
  "perm role put invalid capability access": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/capabilities/notes_edit_others","rule":"enum"}]}},
  "perm role put access number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/modules/tasks","rule":"type"}]}},
  "perm role put no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "perm role put list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "perm role put member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "perm role put empty maps": {"status":200,"body":{"data":{"modules":{},"widgets":{},"capabilities":{}}}},
  "perm user get": {"status":200,"body":{"data":{"modules":{},"widgets":{},"capabilities":{}}}},
  "perm user get unknown": {"status":404,"body":{"error":"User not found.","code":404}},
  "perm user get negative": {"status":404,"body":{"error":"User not found.","code":404}},
  "perm user get zero": {"status":404,"body":{"error":"User not found.","code":404}},
  "perm user get text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/userId","rule":"type"}]}},
  "perm user get decimal": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/userId","rule":"type"}]}},
  "perm user put": {"status":200,"body":{"data":{"modules":{"tasks":"read","budget":"none"},"widgets":{},"capabilities":{"notes_edit_others":"allow"}}}},
  "perm user get after put": {"status":200,"body":{"data":{"modules":{"tasks":"read","budget":"none"},"widgets":{},"capabilities":{"notes_edit_others":"allow"}}}},
  "perm user put admin": {"status":400,"body":{"error":"Administrators always have full access; per-member restrictions do not apply.","code":400}},
  "perm user put unknown": {"status":404,"body":{"error":"User not found.","code":404}},
  "perm user put text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/userId","rule":"type"}]}},
  "perm user put unknown module": {"status":400,"body":{"error":"Unknown module: nope","code":400}},
  "perm user put invalid access": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/modules/tasks","rule":"enum"}]}},
  "perm user put clear": {"status":200,"body":{"data":{"modules":{},"widgets":{},"capabilities":{}}}},
  "email get": {"status":200,"body":{"data":{}}},
  "email get member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "email put": {"status":200,"body":{"data":{"email_from_address":"yuvomi@nas","email_smtp_host":"smtp.example","email_smtp_pass":"<set>","email_smtp_port":"587","email_smtp_secure":"starttls","email_smtp_user":"u"}}},
  "email put bad secure": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/secure","rule":"enum"}]}},
  "email put secure null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/secure","rule":"type"}]}},
  "email put secure number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/secure","rule":"type"}]}},
  "email put port text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"email_port_invalid","fields":[{"path":"body/port","rule":"type","reason":"email_port_invalid"}]}},
  "email put port empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"email_port_invalid","fields":[{"path":"body/port","rule":"type","reason":"email_port_invalid"}]}},
  "email put port zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"email_port_invalid","fields":[{"path":"body/port","rule":"minimum","reason":"email_port_invalid"}]}},
  "email put port big": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"email_port_invalid","fields":[{"path":"body/port","rule":"maximum","reason":"email_port_invalid"}]}},
  "email put port fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"email_port_invalid","fields":[{"path":"body/port","rule":"type","reason":"email_port_invalid"}]}},
  "email put port list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"email_port_invalid","fields":[{"path":"body/port","rule":"type","reason":"email_port_invalid"}]}},
  "email put port and from": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"email_port_invalid","fields":[{"path":"body/port","rule":"minimum","reason":"email_port_invalid"}]}},
  "email put from bad": {"status":400,"body":{"error":"Sender address must be an e-mail address.","code":400,"reason":"email_from_invalid"}},
  "email put from two at": {"status":400,"body":{"error":"Sender address must be an e-mail address.","code":400,"reason":"email_from_invalid"}},
  "email put from number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"email_from_invalid","fields":[{"path":"body/fromAddress","rule":"type","reason":"email_from_invalid"}]}},
  "email put bad secure and from": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/secure","rule":"enum"}]}},
  "email put port null": {"status":200,"body":{"data":{"email_from_address":"","email_smtp_host":"","email_smtp_pass":"<set>","email_smtp_port":"","email_smtp_secure":"starttls","email_smtp_user":"u"}}},
  "email put clear password": {"status":200,"body":{"data":{"email_from_address":"","email_smtp_host":"","email_smtp_pass":"","email_smtp_port":"","email_smtp_secure":"starttls","email_smtp_user":"u"}}},
  "email put empty": {"status":200,"body":{"data":{"email_from_address":"","email_smtp_host":"","email_smtp_pass":"","email_smtp_port":"","email_smtp_secure":"starttls","email_smtp_user":"u"}}},
  "email put no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "email put list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "email put member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "email test": {"status":200,"body":{"data":{"ok":true,"to":"admin@example.org"}}},
  "email test no recipient": {"status":400,"body":{"error":"No recipient email available for this account.","code":400,"reason":"email_no_recipient"}},
  "email test blank": {"status":400,"body":{"error":"No recipient email available for this account.","code":400,"reason":"email_no_recipient"}},
  "email test no body": {"status":400,"body":{"error":"No recipient email available for this account.","code":400,"reason":"email_no_recipient"}},
  "email test number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/to","rule":"type"}]}},
  "email test member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "wx not configured": {"status":200,"body":{"data":null,"reason":"not_configured"}},
  "wx no coordinates": {"status":200,"body":{"data":null,"reason":"not_configured"}},
  "wx open-meteo": {"status":200,"body":{"data":{"provider":"open-meteo","city":"Berlin","units":"metric","current":{"temp":7,"feels_like":5,"humidity":81,"icon":"cloud","desc":"wmo.3","wind_speed":13},"today":{"date":"2026-11-18","temp_min":2,"temp_max":8,"icon":"cloud","desc":"wmo.3"},"forecast":[{"date":"2026-11-19","temp_min":1,"temp_max":7,"icon":"cloud-rain","desc":"wmo.61"},{"date":"2026-11-20","temp_min":3,"temp_max":10,"icon":"sun","desc":"wmo.0"},{"date":"2026-11-21","temp_min":4,"temp_max":10,"icon":"cloud-sun","desc":"wmo.2"},{"date":"2026-11-22","temp_min":1,"temp_max":6,"icon":"cloud","desc":"wmo.45"},{"date":"2026-11-23","temp_min":-1,"temp_max":2,"icon":"cloud-snow","desc":"wmo.71"}]}}},
  "wx cached": {"status":200,"body":{"data":{"provider":"open-meteo","city":"Berlin","units":"metric","current":{"temp":7,"feels_like":5,"humidity":81,"icon":"cloud","desc":"wmo.3","wind_speed":13},"today":{"date":"2026-11-18","temp_min":2,"temp_max":8,"icon":"cloud","desc":"wmo.3"},"forecast":[{"date":"2026-11-19","temp_min":1,"temp_max":7,"icon":"cloud-rain","desc":"wmo.61"},{"date":"2026-11-20","temp_min":3,"temp_max":10,"icon":"sun","desc":"wmo.0"},{"date":"2026-11-21","temp_min":4,"temp_max":10,"icon":"cloud-sun","desc":"wmo.2"},{"date":"2026-11-22","temp_min":1,"temp_max":6,"icon":"cloud","desc":"wmo.45"},{"date":"2026-11-23","temp_min":-1,"temp_max":2,"icon":"cloud-snow","desc":"wmo.71"}]}}},
  "wx member": {"status":200,"body":{"data":{"provider":"open-meteo","city":"Berlin","units":"metric","current":{"temp":7,"feels_like":5,"humidity":81,"icon":"cloud","desc":"wmo.3","wind_speed":13},"today":{"date":"2026-11-18","temp_min":2,"temp_max":8,"icon":"cloud","desc":"wmo.3"},"forecast":[{"date":"2026-11-19","temp_min":1,"temp_max":7,"icon":"cloud-rain","desc":"wmo.61"},{"date":"2026-11-20","temp_min":3,"temp_max":10,"icon":"sun","desc":"wmo.0"},{"date":"2026-11-21","temp_min":4,"temp_max":10,"icon":"cloud-sun","desc":"wmo.2"},{"date":"2026-11-22","temp_min":1,"temp_max":6,"icon":"cloud","desc":"wmo.45"},{"date":"2026-11-23","temp_min":-1,"temp_max":2,"icon":"cloud-snow","desc":"wmo.71"}]}}},
  "wx upstream http": {"status":200,"body":{"data":null,"reason":"upstream_error"}},
  "wx upstream throw": {"status":200,"body":{"data":null,"reason":"upstream_error"}},
  "wx imperial": {"status":200,"body":{"data":{"provider":"open-meteo","city":"Berlin","units":"imperial","current":{"temp":7,"feels_like":5,"humidity":81,"icon":"cloud","desc":"wmo.3","wind_speed":13},"today":{"date":"2026-11-18","temp_min":2,"temp_max":8,"icon":"cloud","desc":"wmo.3"},"forecast":[{"date":"2026-11-19","temp_min":1,"temp_max":7,"icon":"cloud-rain","desc":"wmo.61"},{"date":"2026-11-20","temp_min":3,"temp_max":10,"icon":"sun","desc":"wmo.0"},{"date":"2026-11-21","temp_min":4,"temp_max":10,"icon":"cloud-sun","desc":"wmo.2"},{"date":"2026-11-22","temp_min":1,"temp_max":6,"icon":"cloud","desc":"wmo.45"},{"date":"2026-11-23","temp_min":-1,"temp_max":2,"icon":"cloud-snow","desc":"wmo.71"}]}}},
  "wx city repeated": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/city","rule":"type"}]}},
  "wx geocode": {"status":200,"body":{"data":[{"name":"Berlin","admin1":"Land Berlin","admin2":null,"country":"Deutschland","country_code":"DE","latitude":52.52,"longitude":13.41,"timezone":"Europe/Berlin"},{"name":"Berlin","admin1":"New Hampshire","admin2":"Coos","country":"USA","country_code":"US","latitude":44.47,"longitude":-71.19,"timezone":"America/New_York"}]}},
  "wx geocode cached": {"status":200,"body":{"data":[{"name":"Berlin","admin1":"Land Berlin","admin2":null,"country":"Deutschland","country_code":"DE","latitude":52.52,"longitude":13.41,"timezone":"Europe/Berlin"},{"name":"Berlin","admin1":"New Hampshire","admin2":"Coos","country":"USA","country_code":"US","latitude":44.47,"longitude":-71.19,"timezone":"America/New_York"}]}},
  "wx geocode short": {"status":400,"body":{"error":"Name too short.","code":400,"reason":"name_too_short"}},
  "wx geocode blank": {"status":400,"body":{"error":"Name too short.","code":400,"reason":"name_too_short"}},
  "wx geocode empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"name_too_short","fields":[{"path":"query/name","rule":"minLength","reason":"name_too_short"}]}},
  "wx geocode missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"name_too_short","fields":[{"path":"query/name","rule":"required","reason":"name_too_short"}]}},
  "wx geocode repeated": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"name_too_short","fields":[{"path":"query/name","rule":"type","reason":"name_too_short"}]}},
  "wx geocode long": {"status":400,"body":{"error":"Name too long.","code":400,"reason":"name_too_long"}},
  "wx geocode long padded": {"status":200,"body":{"data":[{"name":"Berlin","admin1":"Land Berlin","admin2":null,"country":"Deutschland","country_code":"DE","latitude":52.52,"longitude":13.41,"timezone":"Europe/Berlin"},{"name":"Berlin","admin1":"New Hampshire","admin2":"Coos","country":"USA","country_code":"US","latitude":44.47,"longitude":-71.19,"timezone":"America/New_York"}]}},
  "wx geocode upstream http": {"status":200,"body":{"data":null,"reason":"upstream_error"}},
  "wx geocode upstream throw": {"status":200,"body":{"data":null,"reason":"upstream_error"}},
  "wx icon throw": {"status":502,"body":{"error":"Icon proxy failed.","code":502}},
  "wx icon upstream http": {"status":502,"body":{"error":"Icon not available.","code":502}},
  "wx icon": {"status":200,"body":{"type":"image/png","length":70}},
  "wx icon short": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/code","rule":"pattern"}]}},
  "wx icon long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/code","rule":"pattern"}]}},
  "wx icon symbol": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/code","rule":"pattern"}]}},
  "wx icon encoded": {"status":200,"body":{"type":"image/png","length":70}},
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
 * The answer and the log line of the central handler, then the next request
 * is answered again.
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
 * Runs `request` while `table` is renamed away.
 * @template T
 * @param {string} table
 * @param {() => Promise<T>} request
 */
async function withoutTable(table, request) {
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_away`);
  try {
    return await request();
  } finally {
    db.exec(`ALTER TABLE ${table}_away RENAME TO ${table}`);
  }
}

test('reminders: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const routes = /** @type {Array<[string, string, unknown, string]>} */ ([
    ['GET', '/reminders/pending', NO_BODY, '/api/v1/reminders/pending'],
    ['GET', '/reminders/upcoming?from=2026-11-18&to=2026-11-25', NO_BODY, '/api/v1/reminders/upcoming'],
    ['GET', `/reminders/all?entity_type=task&entity_id=${TASK}`, NO_BODY, '/api/v1/reminders/all'],
    ['GET', `/reminders?entity_type=task&entity_id=${TASK}`, NO_BODY, '/api/v1/reminders/'],
    ['POST', '/reminders', { entity_type: 'task', entity_id: TASK, remind_at: '2026-11-19' }, '/api/v1/reminders/'],
    ['PUT', `/reminders?entity_type=task&entity_id=${TASK}`, { remind_ats: ['2026-11-19'] }, '/api/v1/reminders/'],
    ['PATCH', '/reminders/1/dismiss', {}, '/api/v1/reminders/:id/dismiss'],
    ['DELETE', '/reminders/1', NO_BODY, '/api/v1/reminders/:id'],
    ['DELETE', `/reminders?entity_type=task&entity_id=${TASK}`, NO_BODY, '/api/v1/reminders/'],
  ]);
  for (const [method, path, body, pattern] of routes) {
    assertCentral(await withoutTable('reminders', () => call(method, path, body)), method, pattern);
  }
  assert.equal((await call('GET', '/reminders/pending', NO_BODY)).status, 200, 'answers again');
});

test('notifications: an unexpected error is a 500 of the central handler; a failed test still stores its last_error', async () => {
  logged.error.length = 0;
  const created = await call('POST', '/notifications/channels', { ...NTFY, name: 'Probe' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  for (const [method, path, body, pattern] of /** @type {Array<[string, string, unknown, string]>} */ ([
    ['GET', '/notifications/channels', NO_BODY, '/api/v1/notifications/channels'],
    ['POST', '/notifications/channels', NTFY, '/api/v1/notifications/channels'],
    ['PUT', `/notifications/channels/${id}`, { enabled: false }, '/api/v1/notifications/channels/:id'],
    ['DELETE', `/notifications/channels/${id}`, NO_BODY, '/api/v1/notifications/channels/:id'],
  ])) {
    assertCentral(await withoutTable('notification_channels', () => call(method, path, body)), method, pattern);
  }
  notificationState.failTest = true;
  try {
    assertCentral(await call('POST', `/notifications/channels/${id}/test`, {}), 'POST', '/api/v1/notifications/channels/:id/test');
  } finally {
    notificationState.failTest = false;
  }
  const stored = createNotificationChannelStore({ db }).getChannel(id);
  assert.equal(stored.lastError, 'The test notification could not be delivered.', 'the failed test is stored on the channel');
  assert.equal((await call('GET', '/notifications/channels', NO_BODY)).status, 200, 'answers again');
});

test('modules: an unexpected error is a 500 of the central handler; known failures keep their own answer', async () => {
  logged.error.length = 0;
  const installed = await call('POST', '/modules/install/zip', moduleZip('raw-mod'));
  assert.equal(installed.status, 201, JSON.stringify(installed.body));

  // A raw filesystem error while installing (EIO on the final rename).
  /** @type {() => unknown} */
  let restore = installSvc.__setInstallFsOpsForTests({
    rename: async () => { throw Object.assign(new Error(`EIO: i/o error, rename '${MODULES_DIR}/x'`), { code: 'EIO' }); },
  });
  try {
    assertCentral(await call('POST', '/modules/install/zip', moduleZip('raw2-mod')), 'POST', '/api/v1/modules/install/zip');
  } finally {
    restore();
  }
  // A known one keeps its status, sentence and reason.
  const exists = await call('POST', '/modules/install/zip', moduleZip('raw-mod'));
  assert.equal(exists.status, 409);
  assert.equal(exists.body.reason, 'exists');

  // Enabling, when writing the install record fails without a known cause.
  restore = modulesSvc.__setModulesFsOpsForTests({
    writeFile: async () => { throw Object.assign(new Error(`ENOENT: no such file, open '${MODULES_DIR}/raw-mod'`), { code: 'ENOENT' }); },
  });
  try {
    assertCentral(await call('PATCH', '/modules/raw-mod', { enabled: true }), 'PATCH', '/api/v1/modules/:id');
  } finally {
    restore();
  }
  // ... and with a known cause it stays the service's own answer.
  restore = modulesSvc.__setModulesFsOpsForTests({
    writeFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
  });
  try {
    const refused = await call('PATCH', '/modules/raw-mod', { enabled: true });
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.reason, 'not_writable');
  } finally {
    restore();
  }

  // modules/ replaced by a FILE: listing, the asset route and deleting fail
  // with a raw filesystem error.
  const aside = `${MODULES_DIR}.aside`;
  fs.renameSync(MODULES_DIR, aside);
  fs.writeFileSync(MODULES_DIR, 'not a directory');
  try {
    assertCentral(await call('GET', '/modules', NO_BODY), 'GET', '/api/v1/modules/');
    // The asset pattern has a wildcard: the central handler names it without its mount.
    assertCentral(await call('GET', '/modules/assets/raw-mod/index.js', NO_BODY), 'GET', '(mount) /assets/:id/{*assetPath}');
    assertCentral(await call('DELETE', '/modules/raw-mod', NO_BODY), 'DELETE', '/api/v1/modules/:id');
  } finally {
    fs.rmSync(MODULES_DIR, { force: true });
    fs.renameSync(aside, MODULES_DIR);
  }
  assert.equal((await call('GET', '/modules', NO_BODY)).status, 200, 'answers again');
  assert.equal((await call('GET', '/modules/assets/raw-mod/nope.js', NO_BODY)).status, 404, 'a known asset failure keeps its 404');
});

test('permissions: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  assertCentral(await withoutTable('access_permissions', () => call('GET', '/permissions/role/child', NO_BODY)), 'GET', '/api/v1/permissions/role/:familyRole');
  assertCentral(await withoutTable('access_permissions', () => call('PUT', `/permissions/user/${MEMBER}`, PERMS)), 'PUT', '/api/v1/permissions/user/:userId');
  assert.equal((await call('GET', '/permissions/role/child', NO_BODY)).status, 200, 'answers again');
});

test('email: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  emailState.failConfig = true;
  try {
    assertCentral(await call('GET', '/email/config', NO_BODY), 'GET', '/api/v1/email/config');
    assertCentral(await call('PUT', '/email/config', { port: 25 }), 'PUT', '/api/v1/email/config');
  } finally {
    emailState.failConfig = false;
  }
  emailState.failSend = true;
  try {
    assertCentral(await call('POST', '/email/test', { to: 'a@b' }), 'POST', '/api/v1/email/test');
  } finally {
    emailState.failSend = false;
  }
  assert.equal((await call('GET', '/email/config', NO_BODY)).status, 200, 'answers again');
});

test('weather: no failure reaches the central handler - the tile says upstream_error, the icon proxy 502', async () => {
  logged.error.length = 0;
  weatherState.failConfig = true;
  try {
    assert.deepEqual(await call('GET', '/weather', NO_BODY), { status: 200, body: { data: null, reason: 'upstream_error' } });
  } finally {
    weatherState.failConfig = false;
  }
  weatherState.mode = 'throw';
  try {
    assert.deepEqual(await call('GET', '/weather/icon/01n', NO_BODY), { status: 502, body: { error: 'Icon proxy failed.', code: 502 } });
  } finally {
    weatherState.mode = 'ok';
  }
  assert.deepEqual(logged.error, []);
});
