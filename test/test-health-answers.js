/**
 * Test: the answers of health stay byte-equal (#2810, phase 2 section E, group 6)
 * Purpose: the twelve route files under server/routes/health/ (85 routes) dropped
 *          the hand checks the schema of their operation already covers
 *          (`validateRequest()` runs before every handler since #2843) and the
 *          try/catch blocks that answered an unexpected error with a 500 of their
 *          own. This suite holds that refactor: for a table of requests to all 85
 *          operations - valid, every refusal of the handler that stays (empty
 *          after trimming, a calendar day that does not exist, a wall-clock time,
 *          cross-field rules, the vital limits and units, care, revisions and the
 *          fasting state, `user_id` 0 and below, path ids `0`, `-1`, `-0` and with
 *          a leading zero), every input a dropped hand check refused or silently
 *          replaced (the schema's 400), not found and rights - for the owner of
 *          the rows, a caregiver, a household member outside, an admin, a member
 *          without the fasting capability and a split-expense guest, it pins
 *          status and the WHOLE body (a CSV export: its text and file name). The
 *          expectations were written before the refactor (17171ed1a) and are
 *          literal values in test/health-answers-expected.js (a module of its
 *          own only for the line limit), no fixture file, no update mode. A few
 *          rows were added afterwards; each was run against the old route files
 *          (file copy) and answers the same there. SQLite stamps rows with
 *          its own clock, which mock.timers does not reach: test triggers pin
 *          `created_at`, `updated_at` is masked, and so are the feed token and its
 *          address. The clock stands still (`mock.timers`, 18.11.2026 12:00 UTC),
 *          the household lives in Europe/Berlin.
 *
 *          The second part: an unexpected error in every route without an own
 *          answer for it reaches the central error handler - 500 with its fixed
 *          sentence and its log line `Unhandled error: <METHOD> <pattern> -> 500` -
 *          and the process keeps answering. The one visible change: vitals,
 *          medications, labs, activities, export, cycle, caregivers, prevention
 *          and nutrition answered `Internal error.`; they answer the central
 *          sentence now. cycle-feed, fasting and the visibility defaults answered
 *          that sentence already, only the log line is the central one now.
 *
 *          The third part: what stays the route's own - `FastingError` with
 *          `reason` and `current`, `health_dose_pending`, the cycle import reasons
 *          with `params`, the vital limits and the 403 of `resolveOwner` keep their
 *          answer and never reach the central handler.
 * Run: npm run test:health-answers
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-health-answers-');
delete process.env.BASE_URL;

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthApp } from './health-app.js';
import { EXPECTED } from './health-answers-expected.js';

const dbmod = await import('../server/db.js');
const { MAX_TITLE, MAX_TEXT } = await import('../server/middleware/validate.js');
const { MAX_TYPE, MAX_UNIT, MAX_SYMPTOMS_COUNT } = await import('../server/services/health-fields.js');
const database = () => dbmod.get();

database().prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

// SQLite stamps rows with its own clock, which mock.timers does not reach. The
// lists sort by these stamps (the dose log by `created_at` when an entry has no
// time); a test trigger pins `created_at` on insert, so the order is the
// insertion order on every run.
const STAMP = '2026-11-18T12:00:00Z';
for (const { name } of database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'health%' OR name LIKE 'cycle%' OR name LIKE 'medication%')").all()) {
  const columns = database().prepare(`PRAGMA table_info(${name})`).all().map((/** @type {any} */ c) => c.name);
  if (!columns.includes('created_at')) continue;
  database().exec(`CREATE TRIGGER test_pin_${name} AFTER INSERT ON ${name} FOR EACH ROW BEGIN UPDATE ${name} SET created_at = '${STAMP}' WHERE rowid = NEW.rowid; END;`);
}

/** @param {string} username @param {string} role @param {string} [familyRole] */
function user(username, role, familyRole = 'parent') {
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const OWN = user('tom', 'member');
const CARE = user('mia', 'member');
const OUT = user('ole', 'member');
const NOFAST = user('nina', 'member');
const KID = user('kai', 'member', 'child');
const FORMER = user('fritz', 'member');
const GUEST = user('gast', 'member', 'other');
const MISSING = 987654;
database().prepare("UPDATE users SET deactivated_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(FORMER);
database().prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'capability', 'health_use_fasting', 'none')")
  .run(String(NOFAST));
// A split-expense guest: a users row that belongs to one expense group only.
const GROUP = Number(database().prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(ADMIN).lastInsertRowid);
database().prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(GUEST, GROUP, ADMIN);
// Care: mia records for tom (#584).
database().prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(OWN, CARE);

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  own: { id: OWN, role: 'member' },
  care: { id: CARE, role: 'member' },
  out: { id: OUT, role: 'member' },
  nofast: { id: NOFAST, role: 'member' },
  guest: { id: GUEST, role: 'member' },
};

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createHealthApp({
  jsonLimit: '10mb',
  log,
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'own'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = 'session';
    req.authScopes = null;
    req.session = { userId: actor.id, role: actor.role };
    req.sessionModuleAccess = null;
    // An unexpected error: the first answer of the handler throws - a JSON
    // answer, an empty one, or the first header of a CSV download (before
    // it set its type, as a failing query would).
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
test.after(() => server.close());

const NO_BODY = Symbol('no body');

/** @typedef {{ actor?: string, fail?: boolean }} CallOptions */

/**
 * @param {string} method
 * @param {string} route under /api/v1/health
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
  const res = await fetch(`${baseUrl}/api/v1/health${route}`, { method, headers, body: payload });
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (type.includes('text/csv')) return { status: res.status, body: { csv: text, file: res.headers.get('content-disposition') } };
  if (!type.includes('application/json')) return { status: res.status, body: text === '' ? null : `<${text.slice(0, 15)}>` };
  return { status: res.status, body: JSON.parse(text) };
}

// Stamps of SQLite's own clock the triggers do not pin, and the feed token.
const VOLATILE = new Set(['updated_at', 'safety_acknowledged_at']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (VOLATILE.has(key) && typeof v === 'string' && v !== STAMP) return '<volatile>';
    if (key === 'token' && typeof v === 'string') return '<token>';
    if (key === 'url' && typeof v === 'string') return v.replace(/\/feed\/cycle\/[^/]+\.ics$/, '/feed/cycle/<token>.ics').split(baseUrl.replace('http://', '')).join('<host>');
    return v;
  });
}

// ── Seed and rows ──

/** Ids that exist only once their row ran, filled by setup rows. @type {Record<string, number>} */
const ids = {};
const lastId = (/** @type {string} */ table) => database().prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`).get().id;
const LONG = (/** @type {number} */ n) => 'x'.repeat(n);
const SPACES = '   ';
const VITAL = (/** @type {Record<string, unknown>} */ over = {}) => ({ type: 'weight', value_num: 70.5, unit: 'kg', measured_at: '2026-11-10T08:00', ...over });
const MED = (/** @type {Record<string, unknown>} */ over = {}) => ({ name: 'Ibuprofen', dosage_text: '400 mg', form: 'tablet', stock_qty: 20, stock_unit: 'Stk', refill_threshold: 5, ...over });
const SCHED = (/** @type {Record<string, unknown>} */ over = {}) => ({ time_of_day: '08:00', days_mask: 127, dose_qty: 1, start_date: '2026-11-01', ...over });
const ACT = (/** @type {Record<string, unknown>} */ over = {}) => ({ type: 'run', duration_min: 30, distance_km: 5.2, intensity: 'mittel', calories: 300, performed_at: '2026-11-10T07:00', ...over });
const LAB = (/** @type {Record<string, unknown>} */ over = {}) => ({ report_date: '2026-11-05', lab_name: 'Labor Nord', ...over });
const RESULT = (/** @type {Record<string, unknown>} */ over = {}) => ({ analyte: 'Hb', value_num: 14.2, unit: 'g/dL', ref_low: 12, ref_high: 16, ...over });
// The full representations of #2810 (group 6, step c): every field a replace
// or upsert overwrites, with the value leaving it out stood for up to v2.93,
// so each answer stays the one written before.
const DAY_FIELDS = (/** @type {Record<string, unknown>} */ over = {}) => ({
  flow: null, note: null, visibility: null, symptoms: null, basal_temp: null, basal_temp_unit: null,
  cervix_mucus: null, lh_test: null, pregnancy_test: null, intimacy: null, ...over,
});
const DAYLOG = (/** @type {Record<string, unknown>} */ over = {}) => DAY_FIELDS({ log_date: '2026-11-12', flow: 'medium', ...over });
const SETTINGS = (/** @type {Record<string, unknown>} */ over = {}) => ({
  cycle_length_avg: null, period_length_avg: null, luteal_length: null, track_fertility: true, pregnancy_mode: false,
  pregnancy_due_date: null, default_visibility: null, remind_period_days_before: null, remind_log_daily: false,
  contraception: null, perimenopause_mode: false, show_pms: true, notify_partner_user_id: null, notify_partner_days_before: null, ...over,
});
const TARGET = (/** @type {Record<string, unknown>} */ over = {}) => ({
  energy_kcal: null, fat_g: null, saturated_fat_g: null, carbs_g: null, sugar_g: null, protein_g: null, salt_g: null, fiber_g: null, ...over,
});
const TYPE = (/** @type {Record<string, unknown>} */ over = {}) => ({ name: 'Tetanus', kind: 'vaccination', default_interval_months: 120, ...over });
const RECORD = (/** @type {Record<string, unknown>} */ over = {}) => ({ given_on: '2026-10-01', type_id: ids.type1, ...over });
const ENTRY = (/** @type {Record<string, unknown>} */ over = {}) => ({ title: 'Muesli', consumed_at: '2026-11-18T08:00', meal_type: 'breakfast', energy_kcal: 350, protein_g: 12, ...over });
const FAST = (/** @type {Record<string, unknown>} */ over = {}) => ({ start_at: '2026-11-17T08:00:00Z', end_at: '2026-11-17T20:00:00Z', start_tzid: 'Europe/Berlin', ...over });
const csvRows = (/** @type {number} */ n) => ['start_date,end_date', ...Array.from({ length: n }, (_, i) => `20${String(10 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}-01,`)].join('\n');

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ VITALS ═════════════════════════════════════════════════════════════════
  ['v list empty', 'GET', '/vitals', NO_BODY],
  ['v create', 'POST', '/vitals', VITAL({ note: ' Morgens ', visibility: 'family' })],
  () => { ids.v1 = lastId('health_vitals'); },
  ['v create bp', 'POST', '/vitals', { type: 'bp', value_num: 120, value_num2: 80, value_num3: 60, unit: 'mmHg', measured_at: '2026-11-11T08:00' }],
  () => { ids.v2 = lastId('health_vitals'); },
  ['v create zoned', 'POST', '/vitals', VITAL({ measured_at: '2026-11-10T07:00:00Z', value_num: null })],
  ['v create date only', 'POST', '/vitals', VITAL({ measured_at: '2026-11-09' })],
  ['v create for cared', 'POST', '/vitals', VITAL({ user_id: OWN, value_num: 71 }), { actor: 'care' }],
  ['v create for cared text', 'POST', '/vitals', VITAL({ user_id: String(OWN), value_num: 72 }), { actor: 'care' }],
  ['v create for other', 'POST', '/vitals', VITAL({ user_id: OWN }), { actor: 'out' }],
  ['v create guest for own', 'POST', '/vitals', VITAL({ user_id: OWN }), { actor: 'guest' }],
  ['v create user zero', 'POST', '/vitals', VITAL({ user_id: 0 })],
  ['v create user zero text', 'POST', '/vitals', VITAL({ user_id: '0' })],
  ['v create user negative', 'POST', '/vitals', VITAL({ user_id: -1 })],
  ['v create user null', 'POST', '/vitals', VITAL({ user_id: null, value_num: 69 })],
  ['v create user letters', 'POST', '/vitals', VITAL({ user_id: '7abc' })],
  ['v create type spaces', 'POST', '/vitals', VITAL({ type: SPACES })],
  ['v create type empty', 'POST', '/vitals', VITAL({ type: '' })],
  ['v create type missing', 'POST', '/vitals', { value_num: 1, measured_at: '2026-11-10T08:00' }],
  ['v create type long', 'POST', '/vitals', VITAL({ type: LONG(MAX_TYPE + 1) })],
  ['v create type number', 'POST', '/vitals', VITAL({ type: 5 })],
  ['v create value text', 'POST', '/vitals', VITAL({ value_num: '70' })],
  ['v create value hex', 'POST', '/vitals', VITAL({ value_num: '0x10' })],
  ['v create value true', 'POST', '/vitals', VITAL({ value_num: true })],
  ['v create value list', 'POST', '/vitals', VITAL({ value_num: [] })],
  ['v create value empty', 'POST', '/vitals', VITAL({ value_num: '' })],
  ['v create unit long', 'POST', '/vitals', VITAL({ unit: LONG(MAX_UNIT + 1) })],
  ['v create unit empty', 'POST', '/vitals', VITAL({ unit: '', type: 'mood', value_num: 3 })],
  ['v create unit invalid', 'POST', '/vitals', VITAL({ unit: 'furlong' })],
  ['v create unit case', 'POST', '/vitals', VITAL({ unit: 'KG', value_num: 68 })],
  ['v create out of range', 'POST', '/vitals', VITAL({ value_num: 9999 })],
  ['v create grams out of range', 'POST', '/vitals', VITAL({ unit: 'g', value_num: 700001 })],
  ['v create bp order', 'POST', '/vitals', { type: 'bp', value_num: 80, value_num2: 120, unit: 'mmHg', measured_at: '2026-11-11T08:00' }],
  ['v create pulse range', 'POST', '/vitals', { type: 'bp', value_num: 120, value_num2: 80, value_num3: 500, unit: 'mmHg', measured_at: '2026-11-11T08:00' }],
  ['v create measured missing', 'POST', '/vitals', { type: 'weight', value_num: 70, unit: 'kg' }],
  ['v create measured empty', 'POST', '/vitals', VITAL({ measured_at: '' })],
  ['v create measured garbage', 'POST', '/vitals', VITAL({ measured_at: 'gestern' })],
  ['v create measured bad offset', 'POST', '/vitals', VITAL({ measured_at: '2026-02-30T08:00:00Z' })],
  ['v create note long', 'POST', '/vitals', VITAL({ note: LONG(MAX_TEXT + 1) })],
  ['v create note spaces', 'POST', '/vitals', VITAL({ note: SPACES, value_num: 67 })],
  ['v create visibility unknown', 'POST', '/vitals', VITAL({ visibility: 'public' })],
  ['v create visibility empty', 'POST', '/vitals', VITAL({ visibility: '' })],
  ['v create visibility proto', 'POST', '/vitals', VITAL({ visibility: '__proto__' })],
  ['v create visibility null', 'POST', '/vitals', VITAL({ visibility: null, value_num: 66 })],
  ['v create no body', 'POST', '/vitals', NO_BODY],
  ['v create list body', 'POST', '/vitals', []],
  ['v list', 'GET', '/vitals', NO_BODY],
  ['v list type', 'GET', '/vitals?type=bp', NO_BODY],
  ['v list range', 'GET', '/vitals?from=2026-11-10&to=2026-11-10T23:59', NO_BODY],
  ['v list care', 'GET', `/vitals?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['v list out', 'GET', `/vitals?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['v list admin', 'GET', `/vitals?user_id=${OWN}`, NO_BODY, { actor: 'admin' }],
  ['v list guest', 'GET', `/vitals?user_id=${OWN}`, NO_BODY, { actor: 'guest' }],
  ['v list user zero', 'GET', '/vitals?user_id=0', NO_BODY],
  ['v list user letters', 'GET', '/vitals?user_id=abc', NO_BODY],
  ['v list type doubled', 'GET', '/vitals?type=a&type=b', NO_BODY],
  ['v patch note', 'PATCH', () => `/vitals/${ids.v1}`, { note: ' neu ' }],
  ['v patch value', 'PATCH', () => `/vitals/${ids.v1}`, { value_num: 71.5 }],
  ['v patch value null', 'PATCH', () => `/vitals/${ids.v1}`, { value_num: null }],
  ['v patch value text', 'PATCH', () => `/vitals/${ids.v1}`, { value_num: '71' }],
  ['v patch value back', 'PATCH', () => `/vitals/${ids.v1}`, { value_num: 70 }],
  ['v patch unit invalid', 'PATCH', () => `/vitals/${ids.v1}`, { unit: 'furlong' }],
  ['v patch out of range', 'PATCH', () => `/vitals/${ids.v1}`, { value_num: 9999 }],
  ['v patch dia above sys', 'PATCH', () => `/vitals/${ids.v2}`, { value_num2: 130 }],
  ['v patch type spaces', 'PATCH', () => `/vitals/${ids.v1}`, { type: SPACES }],
  ['v patch type null', 'PATCH', () => `/vitals/${ids.v1}`, { type: null }],
  ['v patch measured null', 'PATCH', () => `/vitals/${ids.v1}`, { measured_at: null }],
  ['v patch measured zoned', 'PATCH', () => `/vitals/${ids.v1}`, { measured_at: '2026-11-10T06:30:00+01:00' }],
  ['v patch visibility null', 'PATCH', () => `/vitals/${ids.v1}`, { visibility: null }],
  ['v patch visibility private', 'PATCH', () => `/vitals/${ids.v1}`, { visibility: 'private' }],
  ['v patch visibility unknown', 'PATCH', () => `/vitals/${ids.v1}`, { visibility: 'all' }],
  ['v patch empty', 'PATCH', () => `/vitals/${ids.v1}`, {}],
  ['v patch no body', 'PATCH', () => `/vitals/${ids.v1}`, NO_BODY],
  ['v patch care', 'PATCH', () => `/vitals/${ids.v1}`, { note: 'von mia' }, { actor: 'care' }],
  ['v patch out', 'PATCH', () => `/vitals/${ids.v1}`, { note: 'x' }, { actor: 'out' }],
  ['v patch admin', 'PATCH', () => `/vitals/${ids.v1}`, { note: 'x' }, { actor: 'admin' }],
  ['v patch missing', 'PATCH', `/vitals/${MISSING}`, { note: 'x' }],
  ['v patch zero', 'PATCH', '/vitals/0', { note: 'x' }],
  ['v patch negative', 'PATCH', '/vitals/-1', { note: 'x' }],
  ['v patch minus zero', 'PATCH', '/vitals/-0', { note: 'x' }],
  ['v patch leading zero', 'PATCH', () => `/vitals/00${ids.v1}`, { note: 'null-vorn' }],
  ['v patch letters', 'PATCH', '/vitals/7abc', { note: 'x' }],
  ['v patch broken missing', 'PATCH', `/vitals/${MISSING}`, { value_num: 'x' }],
  ['v delete out', 'DELETE', () => `/vitals/${ids.v2}`, NO_BODY, { actor: 'out' }],
  ['v delete zero', 'DELETE', '/vitals/0', NO_BODY],
  ['v delete negative', 'DELETE', '/vitals/-1', NO_BODY],
  ['v delete minus zero', 'DELETE', '/vitals/-0', NO_BODY],
  ['v delete', 'DELETE', () => `/vitals/00${ids.v2}`, NO_BODY],
  ['v delete again', 'DELETE', () => `/vitals/${ids.v2}`, NO_BODY],

  // ══ MEDICATIONS ════════════════════════════════════════════════════════════
  ['m list empty', 'GET', '/medications', NO_BODY],
  ['m create', 'POST', '/medications', MED({ note: ' zum Essen ', visibility: 'family' })],
  () => { ids.m1 = lastId('medications'); },
  ['m create with schedules', 'POST', '/medications', MED({ name: 'Vitamin D', schedules: [SCHED(), SCHED({ time_of_day: '20:00', days_mask: null, active: false })] })],
  () => { ids.m2 = lastId('medications'); ids.s1 = database().prepare('SELECT id FROM medication_schedules WHERE medication_id = ? ORDER BY id LIMIT 1').get(ids.m2).id; },
  ['m create prn', 'POST', '/medications', MED({ name: 'Paracetamol', prn: true, active: 1, min_interval_hours: 6, prn_dose_qty: 1 })],
  () => { ids.m3 = lastId('medications'); },
  ['m create schedules null', 'POST', '/medications', MED({ name: 'Ohne Plan', schedules: null, active: 0, prn: 0 })],
  ['m create schedules empty', 'POST', '/medications', MED({ name: 'Leerer Plan', schedules: [] })],
  ['m create for cared', 'POST', '/medications', MED({ user_id: OWN, name: 'Fuer Tom' }), { actor: 'care' }],
  () => { ids.mCare = lastId('medications'); },
  ['m create for other', 'POST', '/medications', MED({ user_id: OWN }), { actor: 'out' }],
  ['m create user zero', 'POST', '/medications', MED({ user_id: 0 })],
  ['m create name spaces', 'POST', '/medications', MED({ name: SPACES })],
  ['m create name missing', 'POST', '/medications', { form: 'x' }],
  ['m create name long', 'POST', '/medications', MED({ name: LONG(MAX_TITLE + 1) })],
  ['m create dosage spaces', 'POST', '/medications', MED({ name: 'Dosis leer', dosage_text: SPACES })],
  ['m create stock text', 'POST', '/medications', MED({ stock_qty: '20' })],
  ['m create stock hex', 'POST', '/medications', MED({ stock_qty: '0x10' })],
  ['m create refill true', 'POST', '/medications', MED({ refill_threshold: true })],
  ['m create stock negative', 'POST', '/medications', MED({ name: 'Minus', stock_qty: -3 })],
  ['m create visibility unknown', 'POST', '/medications', MED({ visibility: 'public' })],
  ['m create visibility proto', 'POST', '/medications', MED({ visibility: 'constructor' })],
  ['m create active yes', 'POST', '/medications', MED({ active: 'yes' })],
  ['m create active true text', 'POST', '/medications', MED({ active: 'true' })],
  ['m create active null', 'POST', '/medications', MED({ active: null })],
  ['m create active two', 'POST', '/medications', MED({ active: 2 })],
  ['m create prn empty', 'POST', '/medications', MED({ prn: '' })],
  ['m create interval zero', 'POST', '/medications', MED({ min_interval_hours: 0 })],
  ['m create interval negative', 'POST', '/medications', MED({ min_interval_hours: -1 })],
  ['m create interval too long', 'POST', '/medications', MED({ min_interval_hours: 24 * 28 + 1 })],
  ['m create interval max', 'POST', '/medications', MED({ name: 'Max', min_interval_hours: 24 * 28 })],
  ['m create interval text', 'POST', '/medications', MED({ min_interval_hours: '6' })],
  ['m create prn dose negative', 'POST', '/medications', MED({ prn_dose_qty: -1 })],
  ['m create prn dose zero', 'POST', '/medications', MED({ name: 'Null', prn_dose_qty: 0 })],
  ['m create schedules object', 'POST', '/medications', MED({ schedules: {} })],
  ['m create schedules text', 'POST', '/medications', MED({ schedules: 'x' })],
  ['m create schedules too many', 'POST', '/medications', MED({ schedules: Array.from({ length: 49 }, () => SCHED()) })],
  ['m create schedule not object', 'POST', '/medications', MED({ schedules: [5] })],
  ['m create schedule list', 'POST', '/medications', MED({ schedules: [[]] })],
  ['m create schedule null', 'POST', '/medications', MED({ schedules: [null] })],
  ['m create schedule no time', 'POST', '/medications', MED({ schedules: [{ dose_qty: 1 }] })],
  ['m create schedule time bad', 'POST', '/medications', MED({ schedules: [SCHED({ time_of_day: '25:00' })] })],
  ['m create schedule mask high', 'POST', '/medications', MED({ schedules: [SCHED({ days_mask: 128 })] })],
  ['m create schedule mask negative', 'POST', '/medications', MED({ schedules: [SCHED({ days_mask: -1 })] })],
  ['m create schedule mask fraction', 'POST', '/medications', MED({ schedules: [SCHED({ days_mask: 1.5 })] })],
  ['m create schedule mask text', 'POST', '/medications', MED({ schedules: [SCHED({ days_mask: '3' })] })],
  ['m create schedule mask empty', 'POST', '/medications', MED({ schedules: [SCHED({ days_mask: '' })] })],
  ['m create schedule active text', 'POST', '/medications', MED({ schedules: [SCHED({ active: 'yes' })] })],
  ['m create schedule dose text', 'POST', '/medications', MED({ schedules: [SCHED({ dose_qty: '1' })] })],
  ['m create schedule date bad', 'POST', '/medications', MED({ schedules: [SCHED({ start_date: '2026-02-30' })] })],
  ['m create schedule second bad', 'POST', '/medications', MED({ schedules: [SCHED(), SCHED({ end_date: '2026-13-01' })] })],
  ['m create no body', 'POST', '/medications', NO_BODY],
  ['m list', 'GET', '/medications', NO_BODY],
  ['m list active', 'GET', '/medications?active=1', NO_BODY],
  ['m list inactive', 'GET', '/medications?active=false', NO_BODY],
  ['m list active maybe', 'GET', '/medications?active=maybe', NO_BODY],
  ['m list include', 'GET', '/medications?include=schedules,logs,other', NO_BODY],
  ['m list include range', 'GET', '/medications?include=logs&logs_from=2026-11-01&logs_to=2026-11-30T23:59', NO_BODY],
  ['m list care', 'GET', `/medications?user_id=${OWN}&include=schedules`, NO_BODY, { actor: 'care' }],
  ['m list out', 'GET', `/medications?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['m list user zero', 'GET', '/medications?user_id=0', NO_BODY],
  ['m patch', 'PATCH', () => `/medications/${ids.m1}`, { name: ' Ibu 600 ', stock_qty: 18, note: null }],
  ['m patch name spaces', 'PATCH', () => `/medications/${ids.m1}`, { name: SPACES }],
  ['m patch name null', 'PATCH', () => `/medications/${ids.m1}`, { name: null }],
  ['m patch stock null', 'PATCH', () => `/medications/${ids.m1}`, { stock_qty: null }],
  ['m patch stock text', 'PATCH', () => `/medications/${ids.m1}`, { stock_qty: '5' }],
  ['m patch stock empty', 'PATCH', () => `/medications/${ids.m1}`, { stock_qty: '' }],
  ['m patch refill', 'PATCH', () => `/medications/${ids.m1}`, { refill_threshold: 3, stock_qty: 12 }],
  ['m patch active false', 'PATCH', () => `/medications/${ids.m1}`, { active: false }],
  ['m patch active one', 'PATCH', () => `/medications/${ids.m1}`, { active: 1 }],
  ['m patch active text', 'PATCH', () => `/medications/${ids.m1}`, { active: 'true' }],
  ['m patch active null', 'PATCH', () => `/medications/${ids.m1}`, { active: null }],
  ['m patch prn text', 'PATCH', () => `/medications/${ids.m1}`, { prn: 'no' }],
  ['m patch prn', 'PATCH', () => `/medications/${ids.m1}`, { prn: 0 }],
  ['m patch interval zero', 'PATCH', () => `/medications/${ids.m3}`, { min_interval_hours: 0 }],
  ['m patch interval null', 'PATCH', () => `/medications/${ids.m3}`, { min_interval_hours: null }],
  ['m patch interval', 'PATCH', () => `/medications/${ids.m3}`, { min_interval_hours: 8 }],
  ['m patch prn dose negative', 'PATCH', () => `/medications/${ids.m3}`, { prn_dose_qty: -2 }],
  ['m patch visibility null', 'PATCH', () => `/medications/${ids.m1}`, { visibility: null }],
  ['m patch visibility unknown', 'PATCH', () => `/medications/${ids.m1}`, { visibility: 'all' }],
  ['m patch empty', 'PATCH', () => `/medications/${ids.m1}`, {}],
  ['m patch no body', 'PATCH', () => `/medications/${ids.m1}`, NO_BODY],
  ['m patch care', 'PATCH', () => `/medications/${ids.mCare}`, { stock_qty: 9 }, { actor: 'care' }],
  ['m patch out', 'PATCH', () => `/medications/${ids.m1}`, { stock_qty: 9 }, { actor: 'out' }],
  ['m patch missing', 'PATCH', `/medications/${MISSING}`, { stock_qty: 9 }],
  ['m patch zero', 'PATCH', '/medications/0', { stock_qty: 9 }],
  ['m patch negative', 'PATCH', '/medications/-1', { stock_qty: 9 }],
  ['m patch minus zero', 'PATCH', '/medications/-0', { stock_qty: 9 }],
  ['m patch leading zero', 'PATCH', () => `/medications/0${ids.m1}`, { stock_qty: 10 }],
  ['m patch broken missing', 'PATCH', `/medications/${MISSING}`, { active: 'x' }],
  // schedules
  ['s list', 'GET', () => `/medications/${ids.m2}/schedules`, NO_BODY],
  ['s list out', 'GET', () => `/medications/${ids.m2}/schedules`, NO_BODY, { actor: 'out' }],
  ['s list family', 'GET', () => `/medications/${ids.m1}/schedules`, NO_BODY, { actor: 'out' }],
  ['s list zero', 'GET', '/medications/0/schedules', NO_BODY],
  ['s list minus zero', 'GET', '/medications/-0/schedules', NO_BODY],
  ['s list negative', 'GET', '/medications/-1/schedules', NO_BODY],
  ['s list leading zero', 'GET', () => `/medications/00${ids.m2}/schedules`, NO_BODY],
  ['s create', 'POST', () => `/medications/${ids.m1}/schedules`, SCHED({ end_date: '2026-12-31', active: 1 })],
  () => { ids.s2 = lastId('medication_schedules'); },
  ['s create minimal', 'POST', () => `/medications/${ids.m1}/schedules`, { time_of_day: '12:00' }],
  ['s create no time', 'POST', () => `/medications/${ids.m1}/schedules`, { dose_qty: 1 }],
  ['s create time empty', 'POST', () => `/medications/${ids.m1}/schedules`, { time_of_day: '' }],
  ['s create time bad', 'POST', () => `/medications/${ids.m1}/schedules`, { time_of_day: '8:00' }],
  ['s create time 24', 'POST', () => `/medications/${ids.m1}/schedules`, { time_of_day: '24:00' }],
  ['s create mask high', 'POST', () => `/medications/${ids.m1}/schedules`, SCHED({ days_mask: 200 })],
  ['s create mask null', 'POST', () => `/medications/${ids.m1}/schedules`, SCHED({ days_mask: null, time_of_day: '13:00' })],
  ['s create date bad', 'POST', () => `/medications/${ids.m1}/schedules`, SCHED({ end_date: '2026-02-30' })],
  ['s create date empty', 'POST', () => `/medications/${ids.m1}/schedules`, SCHED({ end_date: '', time_of_day: '14:00' })],
  ['s create active text', 'POST', () => `/medications/${ids.m1}/schedules`, SCHED({ active: 'no' })],
  ['s create no body', 'POST', () => `/medications/${ids.m1}/schedules`, NO_BODY],
  ['s create out', 'POST', () => `/medications/${ids.m1}/schedules`, SCHED(), { actor: 'out' }],
  ['s create care', 'POST', () => `/medications/${ids.mCare}/schedules`, SCHED({ time_of_day: '09:30' }), { actor: 'care' }],
  ['s create zero', 'POST', '/medications/0/schedules', SCHED()],
  ['s create negative', 'POST', '/medications/-1/schedules', SCHED()],
  ['s patch', 'PATCH', () => `/schedules/${ids.s2}`, { time_of_day: '07:30', dose_qty: 2, days_mask: 31 }],
  ['s patch time empty', 'PATCH', () => `/schedules/${ids.s2}`, { time_of_day: '' }],
  ['s patch time null', 'PATCH', () => `/schedules/${ids.s2}`, { time_of_day: null }],
  ['s patch mask null', 'PATCH', () => `/schedules/${ids.s2}`, { days_mask: null }],
  ['s patch mask empty', 'PATCH', () => `/schedules/${ids.s2}`, { days_mask: '' }],
  ['s patch mask high', 'PATCH', () => `/schedules/${ids.s2}`, { days_mask: 128 }],
  ['s patch mask fraction', 'PATCH', () => `/schedules/${ids.s2}`, { days_mask: 2.5 }],
  ['s patch active', 'PATCH', () => `/schedules/${ids.s2}`, { active: false }],
  ['s patch active text', 'PATCH', () => `/schedules/${ids.s2}`, { active: 'false' }],
  ['s patch active null', 'PATCH', () => `/schedules/${ids.s2}`, { active: null }],
  ['s patch dose text', 'PATCH', () => `/schedules/${ids.s2}`, { dose_qty: 'eins' }],
  ['s patch date bad', 'PATCH', () => `/schedules/${ids.s2}`, { start_date: '2026-04-31' }],
  ['s patch date null', 'PATCH', () => `/schedules/${ids.s2}`, { end_date: null }],
  ['s patch empty', 'PATCH', () => `/schedules/${ids.s2}`, {}],
  ['s patch out', 'PATCH', () => `/schedules/${ids.s2}`, { dose_qty: 3 }, { actor: 'out' }],
  ['s patch missing', 'PATCH', `/schedules/${MISSING}`, { dose_qty: 3 }],
  ['s patch zero', 'PATCH', '/schedules/0', { dose_qty: 3 }],
  ['s patch negative', 'PATCH', '/schedules/-1', { dose_qty: 3 }],
  ['s patch minus zero', 'PATCH', '/schedules/-0', { dose_qty: 3 }],
  ['s patch leading zero', 'PATCH', () => `/schedules/0${ids.s2}`, { dose_qty: 1 }],
  // dose log
  ['l create scheduled', 'POST', () => `/medications/${ids.m2}/logs`, () => ({ schedule_id: ids.s1, scheduled_at: '2026-11-18T08:00', status: 'taken', taken_at: '2026-11-18T08:05', dose_qty: 1, stock_deduct: 1 })],
  () => { ids.l1 = lastId('medication_logs'); },
  ['l create scheduled repeat', 'POST', () => `/medications/${ids.m2}/logs`, () => ({ schedule_id: String(ids.s1), scheduled_at: '2026-11-18T08:00', status: 'taken', stock_deduct: 1 })],
  ['l create scheduled reset missing', 'POST', () => `/medications/${ids.m2}/logs`, () => ({ schedule_id: ids.s1, scheduled_at: '2026-11-18T08:00' })],
  ['l create scheduled reset', 'POST', () => `/medications/${ids.m2}/logs`, () => ({ schedule_id: ids.s1, scheduled_at: '2026-11-18T08:00', status: null })],
  ['l create adhoc taken', 'POST', () => `/medications/${ids.m3}/logs`, { status: 'taken', dose_qty: 1, note: ' Kopfweh ', stock_deduct: 1 }],
  () => { ids.l2 = lastId('medication_logs'); },
  ['l create adhoc pending', 'POST', () => `/medications/${ids.m3}/logs`, { taken_at: '2026-11-18T09:00', status: 'skipped' }],
  () => { ids.l3 = lastId('medication_logs'); },
  ['l create adhoc pending empty', 'POST', () => `/medications/${ids.m1}/logs`, { status: null }],
  () => { ids.l4 = lastId('medication_logs'); },
  ['l create taken zoned', 'POST', () => `/medications/${ids.m1}/logs`, { status: 'taken', taken_at: '2026-11-18T07:00:00Z' }],
  ['l create status unknown', 'POST', () => `/medications/${ids.m1}/logs`, { status: 'done' }],
  ['l create status null', 'POST', () => `/medications/${ids.m1}/logs`, { status: null, note: 'null status' }],
  ['l create status proto', 'POST', () => `/medications/${ids.m1}/logs`, { status: 'toString' }],
  ['l create deduct negative', 'POST', () => `/medications/${ids.m1}/logs`, { status: 'taken', stock_deduct: -1 }],
  ['l create deduct text', 'POST', () => `/medications/${ids.m1}/logs`, { status: 'taken', stock_deduct: '1' }],
  ['l create dose text', 'POST', () => `/medications/${ids.m1}/logs`, { status: null, dose_qty: '1' }],
  ['l create schedule foreign', 'POST', () => `/medications/${ids.m1}/logs`, () => ({ status: null, schedule_id: ids.s1 })],
  ['l create schedule zero', 'POST', () => `/medications/${ids.m1}/logs`, { status: null, schedule_id: 0 }],
  ['l create schedule letters', 'POST', () => `/medications/${ids.m1}/logs`, { status: null, schedule_id: '3a' }],
  ['l create schedule empty', 'POST', () => `/medications/${ids.m1}/logs`, { status: null, schedule_id: '' }],
  ['l create scheduled_at bad', 'POST', () => `/medications/${ids.m1}/logs`, { status: null, scheduled_at: 'morgen' }],
  ['l create note long', 'POST', () => `/medications/${ids.m1}/logs`, { status: null, note: LONG(MAX_TEXT + 1) }],
  ['l create no body', 'POST', () => `/medications/${ids.m1}/logs`, NO_BODY],
  ['l create out', 'POST', () => `/medications/${ids.m1}/logs`, { status: null }, { actor: 'out' }],
  ['l create care', 'POST', () => `/medications/${ids.mCare}/logs`, { status: 'taken', taken_at: '2026-11-18T10:00' }, { actor: 'care' }],
  ['l create zero', 'POST', '/medications/0/logs', { status: null }],
  ['l create minus zero', 'POST', '/medications/-0/logs', { status: null }],
  ['l list', 'GET', () => `/medications/${ids.m3}/logs`, NO_BODY],
  ['l list range', 'GET', () => `/medications/${ids.m2}/logs?from=2026-11-18T00:00&to=2026-11-18T23:59`, NO_BODY],
  ['l list out', 'GET', () => `/medications/${ids.m3}/logs`, NO_BODY, { actor: 'out' }],
  ['l list zero', 'GET', '/medications/0/logs', NO_BODY],
  ['l list negative', 'GET', '/medications/-1/logs', NO_BODY],
  ['l patch taken', 'PATCH', () => `/logs/${ids.l3}`, { status: 'taken', taken_at: '2026-11-18T09:30', dose_qty: 2, note: 'doch' }],
  ['l patch pending', 'PATCH', () => `/logs/${ids.l3}`, { status: 'pending' }],
  ['l patch taken keeps none', 'PATCH', () => `/logs/${ids.l3}`, { status: 'taken' }],
  ['l patch status unknown', 'PATCH', () => `/logs/${ids.l3}`, { status: 'eaten' }],
  ['l patch status null', 'PATCH', () => `/logs/${ids.l3}`, { status: null, note: null }],
  ['l patch dose text', 'PATCH', () => `/logs/${ids.l3}`, { dose_qty: 'x' }],
  ['l patch taken bad', 'PATCH', () => `/logs/${ids.l3}`, { taken_at: '2026-11-18 09:00' }],
  ['l patch empty', 'PATCH', () => `/logs/${ids.l3}`, {}],
  ['l patch no body', 'PATCH', () => `/logs/${ids.l3}`, NO_BODY],
  ['l patch out', 'PATCH', () => `/logs/${ids.l3}`, { note: 'x' }, { actor: 'out' }],
  ['l patch missing', 'PATCH', `/logs/${MISSING}`, { note: 'x' }],
  ['l patch zero', 'PATCH', '/logs/0', { note: 'x' }],
  ['l patch negative', 'PATCH', '/logs/-1', { note: 'x' }],
  ['l patch minus zero', 'PATCH', '/logs/-0', { note: 'x' }],
  ['l take', 'POST', () => `/logs/${ids.l4}/take`, { taken_at: '2026-11-18T11:00', stock_deduct: 2 }],
  ['l take again', 'POST', () => `/logs/${ids.l4}/take`, { stock_deduct: 2 }],
  ['l take deduct negative', 'POST', () => `/logs/${ids.l4}/take`, { stock_deduct: -2 }],
  ['l take taken bad', 'POST', () => `/logs/${ids.l4}/take`, { taken_at: 'jetzt' }],
  ['l take no body', 'POST', () => `/logs/${ids.l4}/take`, NO_BODY],
  ['l take out', 'POST', () => `/logs/${ids.l4}/take`, {}, { actor: 'out' }],
  ['l take zero', 'POST', '/logs/0/take', {}],
  ['l take leading zero', 'POST', () => `/logs/00${ids.l4}/take`, {}],
  ['l skip', 'POST', () => `/logs/${ids.l4}/skip`, NO_BODY],
  ['l skip body ignored', 'POST', () => `/logs/${ids.l4}/skip`, { status: 'x' }],
  ['l skip missing', 'POST', `/logs/${MISSING}/skip`, NO_BODY],
  ['l skip zero', 'POST', '/logs/0/skip', NO_BODY],
  ['l skip minus zero', 'POST', '/logs/-0/skip', NO_BODY],
  ['l undo pending', 'POST', () => `/logs/${ids.l1}/undo`, {}],
  ['l undo credit negative', 'POST', () => `/logs/${ids.l2}/undo`, { stock_credit: -1 }],
  ['l undo credit text', 'POST', () => `/logs/${ids.l2}/undo`, { stock_credit: '1' }],
  ['l undo no body', 'POST', () => `/logs/${ids.l2}/undo`, NO_BODY],
  ['l undo out', 'POST', () => `/logs/${ids.l2}/undo`, {}, { actor: 'out' }],
  ['l undo zero', 'POST', '/logs/0/undo', {}],
  ['l undo negative', 'POST', '/logs/-1/undo', {}],
  ['l undo adhoc', 'POST', () => `/logs/${ids.l2}/undo`, { stock_credit: 5 }],
  ['l undo skipped scheduled', 'POST', () => `/logs/${ids.l4}/undo`, { stock_credit: 1 }],
  ['l delete scheduled', 'DELETE', () => `/logs/${ids.l1}`, NO_BODY],
  ['l delete out', 'DELETE', () => `/logs/${ids.l3}`, NO_BODY, { actor: 'out' }],
  ['l delete zero', 'DELETE', '/logs/0', NO_BODY],
  ['l delete minus zero', 'DELETE', '/logs/-0', NO_BODY],
  ['l delete', 'DELETE', () => `/logs/${ids.l3}`, NO_BODY],
  ['l delete again', 'DELETE', () => `/logs/${ids.l3}`, NO_BODY],
  ['s delete out', 'DELETE', () => `/schedules/${ids.s2}`, NO_BODY, { actor: 'out' }],
  ['s delete zero', 'DELETE', '/schedules/0', NO_BODY],
  ['s delete negative', 'DELETE', '/schedules/-1', NO_BODY],
  ['s delete', 'DELETE', () => `/schedules/${ids.s2}`, NO_BODY],
  ['s delete again', 'DELETE', () => `/schedules/${ids.s2}`, NO_BODY],
  ['m list after', 'GET', '/medications?include=schedules,logs', NO_BODY],
  ['m delete out', 'DELETE', () => `/medications/${ids.m3}`, NO_BODY, { actor: 'out' }],
  ['m delete zero', 'DELETE', '/medications/0', NO_BODY],
  ['m delete minus zero', 'DELETE', '/medications/-0', NO_BODY],
  ['m delete', 'DELETE', () => `/medications/${ids.m3}`, NO_BODY],
  ['m delete again', 'DELETE', () => `/medications/${ids.m3}`, NO_BODY],

  // ══ LABS ═══════════════════════════════════════════════════════════════════
  ['lab list empty', 'GET', '/labs', NO_BODY],
  ['lab create', 'POST', '/labs', LAB({ note: ' nuechtern ', visibility: 'family', results: [RESULT(), RESULT({ analyte: 'Ferritin', value_num: 5, ref_low: 10, ref_high: null, unit: 'ng/mL' }), RESULT({ analyte: 'CRP', value_num: null, ref_low: null, ref_high: null, flag: 'high' })] })],
  () => { ids.lab1 = lastId('health_lab_reports'); ids.res1 = database().prepare('SELECT id FROM health_lab_results WHERE report_id = ? ORDER BY id LIMIT 1').get(ids.lab1).id; },
  ['lab create plain', 'POST', '/labs', LAB({ report_date: '2026-11-06' })],
  () => { ids.lab2 = lastId('health_lab_reports'); },
  ['lab create results null', 'POST', '/labs', LAB({ report_date: '2026-11-07', results: null })],
  ['lab create for cared', 'POST', '/labs', LAB({ user_id: OWN }), { actor: 'care' }],
  ['lab create for other', 'POST', '/labs', LAB({ user_id: OWN }), { actor: 'out' }],
  ['lab create user zero', 'POST', '/labs', LAB({ user_id: 0 })],
  ['lab create date bad', 'POST', '/labs', LAB({ report_date: '2026-02-30' })],
  ['lab create date missing', 'POST', '/labs', { lab_name: 'x' }],
  ['lab create date shape', 'POST', '/labs', LAB({ report_date: '5.11.2026' })],
  ['lab create name long', 'POST', '/labs', LAB({ lab_name: LONG(MAX_TITLE + 1) })],
  ['lab create visibility unknown', 'POST', '/labs', LAB({ visibility: 'all' })],
  ['lab create results object', 'POST', '/labs', LAB({ results: {} })],
  ['lab create results text', 'POST', '/labs', LAB({ results: 'Hb' })],
  ['lab create result not object', 'POST', '/labs', LAB({ results: ['Hb'] })],
  ['lab create result no analyte', 'POST', '/labs', LAB({ results: [{ value_num: 1 }] })],
  ['lab create result analyte spaces', 'POST', '/labs', LAB({ results: [RESULT({ analyte: SPACES })] })],
  ['lab create result value text', 'POST', '/labs', LAB({ results: [RESULT({ value_num: '14' })] })],
  ['lab create result flag unknown', 'POST', '/labs', LAB({ results: [RESULT({ flag: 'critical' })] })],
  ['lab create result flag proto', 'POST', '/labs', LAB({ results: [RESULT({ flag: '__proto__' })] })],
  ['lab create result flag empty', 'POST', '/labs', LAB({ results: [RESULT({ flag: '' })] })],
  ['lab create result ref text', 'POST', '/labs', LAB({ results: [RESULT({ ref_low: '12' })] })],
  ['lab create no body', 'POST', '/labs', NO_BODY],
  ['lab list', 'GET', '/labs', NO_BODY],
  ['lab list range', 'GET', '/labs?from=2026-11-06&to=2026-11-06', NO_BODY],
  ['lab list care', 'GET', `/labs?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['lab list out', 'GET', `/labs?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['lab get', 'GET', () => `/labs/${ids.lab1}`, NO_BODY],
  ['lab get out family', 'GET', () => `/labs/${ids.lab1}`, NO_BODY, { actor: 'out' }],
  ['lab get out private', 'GET', () => `/labs/${ids.lab2}`, NO_BODY, { actor: 'out' }],
  ['lab get care private', 'GET', () => `/labs/${ids.lab2}`, NO_BODY, { actor: 'care' }],
  ['lab get zero', 'GET', '/labs/0', NO_BODY],
  ['lab get negative', 'GET', '/labs/-1', NO_BODY],
  ['lab get minus zero', 'GET', '/labs/-0', NO_BODY],
  ['lab get leading zero', 'GET', () => `/labs/00${ids.lab2}`, NO_BODY],
  ['lab get letters', 'GET', '/labs/1e2', NO_BODY],
  ['lab patch', 'PATCH', () => `/labs/${ids.lab2}`, { report_date: '2026-11-08', lab_name: ' Praxis ', note: '' }],
  ['lab patch date bad', 'PATCH', () => `/labs/${ids.lab2}`, { report_date: '2026-11-31' }],
  ['lab patch date null', 'PATCH', () => `/labs/${ids.lab2}`, { report_date: null }],
  ['lab patch visibility null', 'PATCH', () => `/labs/${ids.lab2}`, { visibility: null }],
  ['lab patch visibility unknown', 'PATCH', () => `/labs/${ids.lab2}`, { visibility: 'x' }],
  ['lab patch empty', 'PATCH', () => `/labs/${ids.lab2}`, {}],
  ['lab patch out', 'PATCH', () => `/labs/${ids.lab1}`, { note: 'x' }, { actor: 'out' }],
  ['lab patch zero', 'PATCH', '/labs/0', { note: 'x' }],
  ['lab patch minus zero', 'PATCH', '/labs/-0', { note: 'x' }],
  ['res create', 'POST', () => `/labs/${ids.lab2}/results`, RESULT({ analyte: ' TSH ', value_num: 5, ref_low: 0.4, ref_high: 4 })],
  () => { ids.res2 = lastId('health_lab_results'); },
  ['res create no value', 'POST', () => `/labs/${ids.lab2}/results`, { analyte: 'Notiz' }],
  () => { ids.res3 = lastId('health_lab_results'); },
  ['res create analyte missing', 'POST', () => `/labs/${ids.lab2}/results`, { value_num: 1 }],
  ['res create analyte spaces', 'POST', () => `/labs/${ids.lab2}/results`, RESULT({ analyte: SPACES })],
  ['res create flag unknown', 'POST', () => `/labs/${ids.lab2}/results`, RESULT({ flag: 'bad' })],
  ['res create value list', 'POST', () => `/labs/${ids.lab2}/results`, RESULT({ value_num: [1] })],
  ['res create no body', 'POST', () => `/labs/${ids.lab2}/results`, NO_BODY],
  ['res create out', 'POST', () => `/labs/${ids.lab1}/results`, RESULT(), { actor: 'out' }],
  ['res create zero', 'POST', '/labs/0/results', RESULT()],
  ['res create negative', 'POST', '/labs/-1/results', RESULT()],
  ['res patch value', 'PATCH', () => `/results/${ids.res2}`, { value_num: 3 }],
  ['res patch unit', 'PATCH', () => `/results/${ids.res2}`, { unit: 'mU/L' }],
  ['res patch flag', 'PATCH', () => `/results/${ids.res2}`, { flag: 'low' }],
  ['res patch flag null', 'PATCH', () => `/results/${ids.res2}`, { flag: null, ref_high: 2 }],
  ['res patch flag unknown', 'PATCH', () => `/results/${ids.res2}`, { flag: 'x' }],
  ['res patch value null', 'PATCH', () => `/results/${ids.res2}`, { value_num: null }],
  ['res patch value empty', 'PATCH', () => `/results/${ids.res2}`, { value_num: '' }],
  ['res patch value null empty row', 'PATCH', () => `/results/${ids.res3}`, { value_num: null }],
  ['res patch value text', 'PATCH', () => `/results/${ids.res2}`, { value_num: '3' }],
  ['res patch analyte null', 'PATCH', () => `/results/${ids.res2}`, { analyte: null }],
  ['res patch analyte spaces', 'PATCH', () => `/results/${ids.res2}`, { analyte: SPACES }],
  ['res patch empty', 'PATCH', () => `/results/${ids.res2}`, {}],
  ['res patch out', 'PATCH', () => `/results/${ids.res1}`, { value_num: 1 }, { actor: 'out' }],
  ['res patch missing', 'PATCH', `/results/${MISSING}`, { value_num: 1 }],
  ['res patch zero', 'PATCH', '/results/0', { value_num: 1 }],
  ['res patch minus zero', 'PATCH', '/results/-0', { value_num: 1 }],
  ['res patch leading zero', 'PATCH', () => `/results/0${ids.res2}`, { value_num: 4 }],
  ['res delete out', 'DELETE', () => `/results/${ids.res1}`, NO_BODY, { actor: 'out' }],
  ['res delete zero', 'DELETE', '/results/0', NO_BODY],
  ['res delete negative', 'DELETE', '/results/-1', NO_BODY],
  ['res delete', 'DELETE', () => `/results/${ids.res3}`, NO_BODY],
  ['lab delete out', 'DELETE', () => `/labs/${ids.lab1}`, NO_BODY, { actor: 'out' }],
  ['lab delete zero', 'DELETE', '/labs/0', NO_BODY],
  ['lab delete negative', 'DELETE', '/labs/-1', NO_BODY],

  // ══ ACTIVITIES ═════════════════════════════════════════════════════════════
  ['a list empty', 'GET', '/activities', NO_BODY],
  ['a create', 'POST', '/activities', ACT({ note: ' Park ', visibility: 'family' })],
  () => { ids.a1 = lastId('health_activities'); },
  ['a create minimal', 'POST', '/activities', { type: 'yoga', performed_at: '2026-11-11' }],
  () => { ids.a2 = lastId('health_activities'); },
  ['a create zoned', 'POST', '/activities', ACT({ performed_at: '2026-11-12T06:00:00+01:00' })],
  ['a create for cared', 'POST', '/activities', ACT({ user_id: OWN }), { actor: 'care' }],
  ['a create for other', 'POST', '/activities', ACT({ user_id: OWN }), { actor: 'out' }],
  ['a create user zero', 'POST', '/activities', ACT({ user_id: '0' })],
  ['a create type spaces', 'POST', '/activities', ACT({ type: SPACES })],
  ['a create type long', 'POST', '/activities', ACT({ type: LONG(MAX_TYPE + 1) })],
  ['a create duration text', 'POST', '/activities', ACT({ duration_min: '30' })],
  ['a create distance true', 'POST', '/activities', ACT({ distance_km: true })],
  ['a create calories list', 'POST', '/activities', ACT({ calories: [300] })],
  ['a create intensity number', 'POST', '/activities', ACT({ intensity: 3 })],
  ['a create intensity long', 'POST', '/activities', ACT({ intensity: LONG(MAX_UNIT + 1) })],
  ['a create performed missing', 'POST', '/activities', { type: 'run' }],
  ['a create performed bad', 'POST', '/activities', ACT({ performed_at: '2026-11-10 07:00' })],
  ['a create visibility unknown', 'POST', '/activities', ACT({ visibility: 'friends' })],
  ['a create no body', 'POST', '/activities', NO_BODY],
  ['a list', 'GET', '/activities', NO_BODY],
  ['a list type', 'GET', '/activities?type=yoga', NO_BODY],
  ['a list range', 'GET', '/activities?from=2026-11-10&to=2026-11-10T23:59', NO_BODY],
  ['a list out', 'GET', `/activities?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['a list care', 'GET', `/activities?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['a list user negative', 'GET', '/activities?user_id=-1', NO_BODY],
  ['a patch', 'PATCH', () => `/activities/${ids.a1}`, { duration_min: 45, distance_km: null, intensity: '' }],
  ['a patch type spaces', 'PATCH', () => `/activities/${ids.a1}`, { type: SPACES }],
  ['a patch duration text', 'PATCH', () => `/activities/${ids.a1}`, { duration_min: '45' }],
  ['a patch performed null', 'PATCH', () => `/activities/${ids.a1}`, { performed_at: null }],
  ['a patch performed', 'PATCH', () => `/activities/${ids.a1}`, { performed_at: '2026-11-10T07:15:30' }],
  ['a patch visibility null', 'PATCH', () => `/activities/${ids.a1}`, { visibility: null }],
  ['a patch visibility unknown', 'PATCH', () => `/activities/${ids.a1}`, { visibility: 'x' }],
  ['a patch empty', 'PATCH', () => `/activities/${ids.a1}`, {}],
  ['a patch out', 'PATCH', () => `/activities/${ids.a1}`, { note: 'x' }, { actor: 'out' }],
  ['a patch missing', 'PATCH', `/activities/${MISSING}`, { note: 'x' }],
  ['a patch zero', 'PATCH', '/activities/0', { note: 'x' }],
  ['a patch negative', 'PATCH', '/activities/-1', { note: 'x' }],
  ['a patch minus zero', 'PATCH', '/activities/-0', { note: 'x' }],
  ['a patch leading zero', 'PATCH', () => `/activities/00${ids.a1}`, { note: 'vorn' }],
  ['a delete out', 'DELETE', () => `/activities/${ids.a2}`, NO_BODY, { actor: 'out' }],
  ['a delete zero', 'DELETE', '/activities/0', NO_BODY],
  ['a delete minus zero', 'DELETE', '/activities/-0', NO_BODY],
  ['a delete', 'DELETE', () => `/activities/${ids.a2}`, NO_BODY],

  // ══ NUTRITION ══════════════════════════════════════════════════════════════
  ['n target empty', 'GET', '/nutrition/targets', NO_BODY],
  ['n target put', 'PUT', '/nutrition/targets', TARGET({ energy_kcal: 2000, protein_g: 60, fat_g: 0 })],
  ['n target put cared', 'PUT', '/nutrition/targets', TARGET({ user_id: OWN, carbs_g: 250 }), { actor: 'care' }],
  ['n target put other', 'PUT', '/nutrition/targets', TARGET({ user_id: OWN, carbs_g: 250 }), { actor: 'out' }],
  ['n target put user zero', 'PUT', '/nutrition/targets', TARGET({ user_id: 0, carbs_g: 250 })],
  ['n target put negative', 'PUT', '/nutrition/targets', TARGET({ energy_kcal: -1 })],
  ['n target put too much', 'PUT', '/nutrition/targets', TARGET({ energy_kcal: 100001 })],
  ['n target put text', 'PUT', '/nutrition/targets', TARGET({ energy_kcal: '2000' })],
  ['n target put empty text', 'PUT', '/nutrition/targets', TARGET({ energy_kcal: '' })],
  ['n target get', 'GET', '/nutrition/targets', NO_BODY],
  ['n target get care', 'GET', `/nutrition/targets?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['n target get out', 'GET', `/nutrition/targets?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['n target get user zero', 'GET', '/nutrition/targets?user_id=0', NO_BODY],
  ['n target get user letters', 'GET', '/nutrition/targets?user_id=abc', NO_BODY],
  ['n target get user negative', 'GET', '/nutrition/targets?user_id=-1', NO_BODY],
  ['n target put missing', 'PUT', '/nutrition/targets', { user_id: OWN, carbs_g: 250 }, { actor: 'care' }],
  ['n target put clear', 'PUT', '/nutrition/targets', TARGET({ user_id: OWN }), { actor: 'care' }],
  ['n target put no body', 'PUT', '/nutrition/targets', NO_BODY],
  ['n entry create', 'POST', '/nutrition/entries', ENTRY({ note: ' lecker ', visibility: 'all', fat_g: 0 })],
  () => { ids.n1 = lastId('health_nutrition_entries'); },
  ['n entry create minimal', 'POST', '/nutrition/entries', { title: 'Apfel', consumed_at: '2026-11-18T10:00:00Z' }],
  () => { ids.n2 = lastId('health_nutrition_entries'); },
  ['n entry create meal null', 'POST', '/nutrition/entries', ENTRY({ meal_type: null, title: 'Snack' })],
  ['n entry create for cared', 'POST', '/nutrition/entries', ENTRY({ user_id: OWN }), { actor: 'care' }],
  ['n entry create for other', 'POST', '/nutrition/entries', ENTRY({ user_id: OWN }), { actor: 'out' }],
  ['n entry create title spaces', 'POST', '/nutrition/entries', ENTRY({ title: SPACES })],
  ['n entry create consumed bad', 'POST', '/nutrition/entries', ENTRY({ consumed_at: '2026-11-18' })],
  ['n entry create meal unknown', 'POST', '/nutrition/entries', ENTRY({ meal_type: 'brunch' })],
  ['n entry create meal empty', 'POST', '/nutrition/entries', ENTRY({ meal_type: '' })],
  ['n entry create visibility family', 'POST', '/nutrition/entries', ENTRY({ visibility: 'family' })],
  ['n entry create nutrient negative', 'POST', '/nutrition/entries', ENTRY({ protein_g: -1 })],
  ['n entry create nutrient text', 'POST', '/nutrition/entries', ENTRY({ protein_g: '12' })],
  ['n entry create nutrient max', 'POST', '/nutrition/entries', ENTRY({ title: 'Viel', protein_g: 100000 })],
  ['n entry create no body', 'POST', '/nutrition/entries', NO_BODY],
  ['n entry list', 'GET', '/nutrition/entries', NO_BODY],
  ['n entry list range', 'GET', '/nutrition/entries?from=2026-11-18&to=2026-11-18&meal_type=breakfast', NO_BODY],
  ['n entry list meal unknown', 'GET', '/nutrition/entries?meal_type=brunch', NO_BODY],
  ['n entry list from time', 'GET', '/nutrition/entries?from=2026-11-18T00:00', NO_BODY],
  ['n entry list out', 'GET', `/nutrition/entries?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['n entry list guest', 'GET', `/nutrition/entries?user_id=${OWN}`, NO_BODY, { actor: 'guest' }],
  ['n entry patch', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { title: ' Muesli gross ', energy_kcal: 500, fat_g: null, meal_type: 'lunch' }],
  ['n entry patch meal null', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { meal_type: null }],
  ['n entry patch meal empty', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { meal_type: '' }],
  ['n entry patch meal unknown', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { meal_type: 'brunch' }],
  ['n entry patch meal proto', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { meal_type: 'constructor' }],
  ['n entry patch nutrient negative', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { sugar_g: -5 }],
  ['n entry patch nutrient too much', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { sugar_g: 100001 }],
  ['n entry patch title null', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { title: null }],
  ['n entry patch consumed', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { consumed_at: '2026-11-18T09:00:00+01:00' }],
  ['n entry patch visibility null', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { visibility: null }],
  ['n entry patch visibility family', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { visibility: 'family' }],
  ['n entry patch empty', 'PATCH', () => `/nutrition/entries/${ids.n1}`, {}],
  ['n entry patch out', 'PATCH', () => `/nutrition/entries/${ids.n1}`, { title: 'x' }, { actor: 'out' }],
  ['n entry patch zero', 'PATCH', '/nutrition/entries/0', { title: 'x' }],
  ['n entry patch negative', 'PATCH', '/nutrition/entries/-1', { title: 'x' }],
  ['n entry patch minus zero', 'PATCH', '/nutrition/entries/-0', { title: 'x' }],
  ['n entry patch leading zero', 'PATCH', () => `/nutrition/entries/00${ids.n1}`, { note: 'vorn' }],
  ['n summary', 'GET', '/nutrition/summary', NO_BODY],
  ['n summary date', 'GET', '/nutrition/summary?date=2026-11-17', NO_BODY],
  ['n summary date bad', 'GET', '/nutrition/summary?date=2026-02-30', NO_BODY],
  ['n summary date shape', 'GET', '/nutrition/summary?date=18.11.2026', NO_BODY],
  ['n summary care', 'GET', `/nutrition/summary?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['n summary out', 'GET', `/nutrition/summary?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['n summary user zero', 'GET', '/nutrition/summary?user_id=0', NO_BODY],
  ['n summary user letters', 'GET', '/nutrition/summary?user_id=abc', NO_BODY],
  ['n summary user negative', 'GET', '/nutrition/summary?user_id=-1', NO_BODY],
  ['n entry delete out', 'DELETE', () => `/nutrition/entries/${ids.n2}`, NO_BODY, { actor: 'out' }],
  ['n entry delete zero', 'DELETE', '/nutrition/entries/0', NO_BODY],
  ['n entry delete', 'DELETE', () => `/nutrition/entries/${ids.n2}`, NO_BODY],

  // ══ PREVENTION ═════════════════════════════════════════════════════════════
  ['p types', 'GET', '/prevention/types', NO_BODY],
  ['p type create', 'POST', '/prevention/types', TYPE({ icon: 'syringe', sort_order: 5 }), { actor: 'admin' }],
  () => { ids.type1 = lastId('health_prevention_types'); },
  ['p type create minimal', 'POST', '/prevention/types', { name: 'Zahnarzt', kind: 'checkup' }, { actor: 'admin' }],
  () => { ids.type2 = lastId('health_prevention_types'); },
  ['p type create member', 'POST', '/prevention/types', TYPE(), { actor: 'own' }],
  ['p type create member broken', 'POST', '/prevention/types', { kind: 'x' }, { actor: 'own' }],
  ['p type create name spaces', 'POST', '/prevention/types', TYPE({ name: SPACES }), { actor: 'admin' }],
  ['p type create kind missing', 'POST', '/prevention/types', { name: 'X' }, { actor: 'admin' }],
  ['p type create kind unknown', 'POST', '/prevention/types', TYPE({ kind: 'exam' }), { actor: 'admin' }],
  ['p type create kind null', 'POST', '/prevention/types', TYPE({ kind: null }), { actor: 'admin' }],
  ['p type create interval zero', 'POST', '/prevention/types', TYPE({ default_interval_months: 0 }), { actor: 'admin' }],
  ['p type create interval high', 'POST', '/prevention/types', TYPE({ default_interval_months: 601 }), { actor: 'admin' }],
  ['p type create interval fraction', 'POST', '/prevention/types', TYPE({ default_interval_months: 1.5 }), { actor: 'admin' }],
  ['p type create interval text', 'POST', '/prevention/types', TYPE({ default_interval_months: '12' }), { actor: 'admin' }],
  ['p type create interval empty', 'POST', '/prevention/types', TYPE({ default_interval_months: '' }), { actor: 'admin' }],
  ['p type create interval null', 'POST', '/prevention/types', TYPE({ name: 'Einmalig', default_interval_months: null, icon: '' }), { actor: 'admin' }],
  ['p type create sort text', 'POST', '/prevention/types', TYPE({ sort_order: '1' }), { actor: 'admin' }],
  ['p type create icon long', 'POST', '/prevention/types', TYPE({ icon: LONG(51) }), { actor: 'admin' }],
  ['p type create no body', 'POST', '/prevention/types', NO_BODY, { actor: 'admin' }],
  ['p type patch', 'PATCH', () => `/prevention/types/${ids.type2}`, { name: ' Zahnarzt Kontrolle ', default_interval_months: 6, icon: null, sort_order: null }, { actor: 'admin' }],
  ['p type patch kind', 'PATCH', () => `/prevention/types/${ids.type2}`, { kind: 'vaccination' }, { actor: 'admin' }],
  ['p type patch kind unknown', 'PATCH', () => `/prevention/types/${ids.type2}`, { kind: 'x' }, { actor: 'admin' }],
  ['p type patch kind null', 'PATCH', () => `/prevention/types/${ids.type2}`, { kind: null }, { actor: 'admin' }],
  ['p type patch kind empty', 'PATCH', () => `/prevention/types/${ids.type2}`, { kind: '' }, { actor: 'admin' }],
  ['p type patch interval null', 'PATCH', () => `/prevention/types/${ids.type2}`, { default_interval_months: null }, { actor: 'admin' }],
  ['p type patch interval zero', 'PATCH', () => `/prevention/types/${ids.type2}`, { default_interval_months: 0 }, { actor: 'admin' }],
  ['p type patch sort text', 'PATCH', () => `/prevention/types/${ids.type2}`, { sort_order: 'eins' }, { actor: 'admin' }],
  ['p type patch name spaces', 'PATCH', () => `/prevention/types/${ids.type2}`, { name: SPACES }, { actor: 'admin' }],
  ['p type patch empty', 'PATCH', () => `/prevention/types/${ids.type2}`, {}, { actor: 'admin' }],
  ['p type patch member', 'PATCH', () => `/prevention/types/${ids.type2}`, { name: 'x' }, { actor: 'own' }],
  ['p type patch missing', 'PATCH', `/prevention/types/${MISSING}`, { name: 'x' }, { actor: 'admin' }],
  ['p type patch zero', 'PATCH', '/prevention/types/0', { name: 'x' }, { actor: 'admin' }],
  ['p type patch negative', 'PATCH', '/prevention/types/-1', { name: 'x' }, { actor: 'admin' }],
  ['p type patch minus zero', 'PATCH', '/prevention/types/-0', { name: 'x' }, { actor: 'admin' }],
  ['p type patch leading zero', 'PATCH', () => `/prevention/types/00${ids.type2}`, { sort_order: 2 }, { actor: 'admin' }],
  ['p rec create', 'POST', '/prevention/records', () => RECORD({ dose_number: 2, batch: ' AB12 ', provider: 'Dr. X', note: 'gut', reminder_offset_days: 30, visibility: 'family' })],
  () => { ids.rec1 = lastId('health_prevention_records'); },
  ['p rec create named', 'POST', '/prevention/records', { given_on: '2026-09-01', name: 'Grippe', interval_months: 12, next_due_on: '2027-09-01' }],
  () => { ids.rec2 = lastId('health_prevention_records'); },
  ['p rec create type text', 'POST', '/prevention/records', () => RECORD({ type_id: String(ids.type2), given_on: '2026-08-01' })],
  ['p rec create type zero', 'POST', '/prevention/records', () => RECORD({ type_id: 0 })],
  ['p rec create type zero text', 'POST', '/prevention/records', () => RECORD({ type_id: '0' })],
  ['p rec create type unknown', 'POST', '/prevention/records', () => RECORD({ type_id: MISSING })],
  ['p rec create type letters', 'POST', '/prevention/records', () => RECORD({ type_id: '3a' })],
  ['p rec create type empty', 'POST', '/prevention/records', () => RECORD({ type_id: '', name: 'Leer' })],
  ['p rec create no type no name', 'POST', '/prevention/records', { given_on: '2026-10-01' }],
  ['p rec create name spaces', 'POST', '/prevention/records', { given_on: '2026-10-01', name: SPACES }],
  ['p rec create given bad', 'POST', '/prevention/records', () => RECORD({ given_on: '2026-02-29' })],
  ['p rec create given missing', 'POST', '/prevention/records', { type_id: 1 }],
  ['p rec create dose text', 'POST', '/prevention/records', () => RECORD({ dose_number: '2' })],
  ['p rec create interval zero', 'POST', '/prevention/records', () => RECORD({ interval_months: 0 })],
  ['p rec create interval high', 'POST', '/prevention/records', () => RECORD({ interval_months: 601 })],
  ['p rec create offset negative', 'POST', '/prevention/records', () => RECORD({ reminder_offset_days: -1 })],
  ['p rec create offset high', 'POST', '/prevention/records', () => RECORD({ reminder_offset_days: 366 })],
  ['p rec create offset fraction', 'POST', '/prevention/records', () => RECORD({ reminder_offset_days: 1.5 })],
  ['p rec create next bad', 'POST', '/prevention/records', () => RECORD({ next_due_on: '2027-02-30' })],
  ['p rec create visibility unknown', 'POST', '/prevention/records', () => RECORD({ visibility: 'all' })],
  ['p rec create for cared', 'POST', '/prevention/records', () => RECORD({ user_id: OWN }), { actor: 'care' }],
  ['p rec create for other', 'POST', '/prevention/records', () => RECORD({ user_id: OWN }), { actor: 'out' }],
  ['p rec create user zero', 'POST', '/prevention/records', () => RECORD({ user_id: 0 })],
  ['p rec create no body', 'POST', '/prevention/records', NO_BODY],
  ['p rec list', 'GET', '/prevention/records', NO_BODY],
  ['p rec list type', 'GET', () => `/prevention/records?type_id=${ids.type1}`, NO_BODY],
  ['p rec list type letters', 'GET', '/prevention/records?type_id=x', NO_BODY],
  ['p rec list range', 'GET', '/prevention/records?from=2026-09-01&to=2026-09-30', NO_BODY],
  ['p rec list out', 'GET', `/prevention/records?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['p rec patch', 'PATCH', () => `/prevention/records/${ids.rec2}`, { name: ' Grippe 2026 ', dose_number: null, interval_months: null, reminder_offset_days: 7, next_due_on: null }],
  ['p rec patch type', 'PATCH', () => `/prevention/records/${ids.rec2}`, () => ({ type_id: ids.type1 })],
  ['p rec patch type null', 'PATCH', () => `/prevention/records/${ids.rec2}`, { type_id: null }],
  ['p rec patch type empty', 'PATCH', () => `/prevention/records/${ids.rec2}`, { type_id: '' }],
  ['p rec patch type zero', 'PATCH', () => `/prevention/records/${ids.rec2}`, { type_id: 0 }],
  ['p rec patch type unknown', 'PATCH', () => `/prevention/records/${ids.rec2}`, { type_id: String(MISSING) }],
  ['p rec patch given null', 'PATCH', () => `/prevention/records/${ids.rec2}`, { given_on: null }],
  ['p rec patch given bad', 'PATCH', () => `/prevention/records/${ids.rec2}`, { given_on: '2026-06-31' }],
  ['p rec patch interval zero', 'PATCH', () => `/prevention/records/${ids.rec2}`, { interval_months: 0 }],
  ['p rec patch offset text', 'PATCH', () => `/prevention/records/${ids.rec2}`, { reminder_offset_days: '7' }],
  ['p rec patch visibility null', 'PATCH', () => `/prevention/records/${ids.rec2}`, { visibility: null }],
  ['p rec patch empty', 'PATCH', () => `/prevention/records/${ids.rec2}`, {}],
  ['p rec patch out', 'PATCH', () => `/prevention/records/${ids.rec1}`, { note: 'x' }, { actor: 'out' }],
  ['p rec patch missing', 'PATCH', `/prevention/records/${MISSING}`, { note: 'x' }],
  ['p rec patch zero', 'PATCH', '/prevention/records/0', { note: 'x' }],
  ['p rec patch negative', 'PATCH', '/prevention/records/-1', { note: 'x' }],
  ['p rec patch minus zero', 'PATCH', '/prevention/records/-0', { note: 'x' }],
  ['p rec patch leading zero', 'PATCH', () => `/prevention/records/0${ids.rec2}`, { note: 'vorn' }],
  ['p due', 'GET', '/prevention/due', NO_BODY],
  ['p due care', 'GET', `/prevention/due?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['p due out', 'GET', `/prevention/due?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['p due user zero', 'GET', '/prevention/due?user_id=0', NO_BODY],
  ['p rec delete out', 'DELETE', () => `/prevention/records/${ids.rec2}`, NO_BODY, { actor: 'out' }],
  ['p rec delete zero', 'DELETE', '/prevention/records/0', NO_BODY],
  ['p rec delete minus zero', 'DELETE', '/prevention/records/-0', NO_BODY],
  ['p rec delete', 'DELETE', () => `/prevention/records/${ids.rec2}`, NO_BODY],
  ['p type delete member', 'DELETE', () => `/prevention/types/${ids.type1}`, NO_BODY, { actor: 'own' }],
  ['p type delete zero', 'DELETE', '/prevention/types/0', NO_BODY, { actor: 'admin' }],
  ['p type delete negative', 'DELETE', '/prevention/types/-1', NO_BODY, { actor: 'admin' }],
  ['p type delete missing', 'DELETE', `/prevention/types/${MISSING}`, NO_BODY, { actor: 'admin' }],
  ['p type delete', 'DELETE', () => `/prevention/types/${ids.type1}`, NO_BODY, { actor: 'admin' }],
  ['p rec list after type delete', 'GET', '/prevention/records', NO_BODY],

  // ══ CYCLE ══════════════════════════════════════════════════════════════════
  ['c periods empty', 'GET', '/cycle/periods', NO_BODY],
  ['c period create', 'POST', '/cycle/periods', { start_date: '2026-10-20', end_date: '2026-10-24', note: ' normal ', visibility: 'family' }],
  () => { ids.cp1 = lastId('cycle_periods'); },
  ['c period create open', 'POST', '/cycle/periods', { start_date: '2026-11-16' }],
  () => { ids.cp2 = lastId('cycle_periods'); },
  ['c period create end before', 'POST', '/cycle/periods', { start_date: '2026-11-16', end_date: '2026-11-15' }],
  ['c period create start bad', 'POST', '/cycle/periods', { start_date: '2026-02-30' }],
  ['c period create start missing', 'POST', '/cycle/periods', { end_date: '2026-11-15' }],
  ['c period create end empty', 'POST', '/cycle/periods', { start_date: '2026-09-20', end_date: '' }],
  ['c period create visibility unknown', 'POST', '/cycle/periods', { start_date: '2026-09-20', visibility: 'all' }],
  ['c period create visibility null', 'POST', '/cycle/periods', { start_date: '2026-09-21', visibility: null }],
  ['c period create no body', 'POST', '/cycle/periods', NO_BODY],
  ['c periods', 'GET', '/cycle/periods', NO_BODY],
  ['c periods range', 'GET', '/cycle/periods?from=2026-10-01&to=2026-10-31', NO_BODY],
  ['c periods out', 'GET', `/cycle/periods?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['c periods care', 'GET', `/cycle/periods?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['c periods user zero', 'GET', '/cycle/periods?user_id=0', NO_BODY],
  ['c period patch', 'PATCH', () => `/cycle/periods/${ids.cp2}`, { end_date: '2026-11-20', note: 'fertig' }],
  ['c period patch end before', 'PATCH', () => `/cycle/periods/${ids.cp2}`, { end_date: '2026-11-10' }],
  ['c period patch start after end', 'PATCH', () => `/cycle/periods/${ids.cp2}`, { start_date: '2026-11-25' }],
  ['c period patch start null', 'PATCH', () => `/cycle/periods/${ids.cp2}`, { start_date: null }],
  ['c period patch end null', 'PATCH', () => `/cycle/periods/${ids.cp2}`, { end_date: null }],
  ['c period patch visibility null', 'PATCH', () => `/cycle/periods/${ids.cp2}`, { visibility: null }],
  ['c period patch visibility unknown', 'PATCH', () => `/cycle/periods/${ids.cp2}`, { visibility: 'x' }],
  ['c period patch empty', 'PATCH', () => `/cycle/periods/${ids.cp2}`, {}],
  ['c period patch care', 'PATCH', () => `/cycle/periods/${ids.cp2}`, { note: 'x' }, { actor: 'care' }],
  ['c period patch zero', 'PATCH', '/cycle/periods/0', { note: 'x' }],
  ['c period patch negative', 'PATCH', '/cycle/periods/-1', { note: 'x' }],
  ['c period patch minus zero', 'PATCH', '/cycle/periods/-0', { note: 'x' }],
  ['c period patch leading zero', 'PATCH', () => `/cycle/periods/00${ids.cp2}`, { note: 'vorn' }],
  ['c log create', 'POST', '/cycle/logs', DAYLOG({ note: ' Bauch ', visibility: 'family', symptoms: [{ key: 'cramps', intensity: 2 }, 'headache', 'cramps'], basal_temp: 36.6, basal_temp_unit: 'c', cervix_mucus: 'creamy', lh_test: 'negative', pregnancy_test: '', intimacy: 'protected', feelings: ['good', 'anxious', 'good'] })],
  () => { ids.cl1 = lastId('cycle_day_logs'); },
  ['c log create repeat missing', 'POST', '/cycle/logs', { log_date: '2026-11-12', flow: 'light' }],
  ['c log create repeat', 'POST', '/cycle/logs', DAYLOG({ flow: 'light' })],
  ['c log create mood', 'POST', '/cycle/logs', DAY_FIELDS({ log_date: '2026-11-13', mood: 'sad', symptoms: 'cramps, bloating', basal_temp: 98.2, basal_temp_unit: 'f' })],
  () => { ids.cl2 = lastId('cycle_day_logs'); },
  ['c log create empty choices', 'POST', '/cycle/logs', DAY_FIELDS({ log_date: '2026-11-14', flow: '', cervix_mucus: null, mood: '', basal_temp: null, basal_temp_unit: null, symptoms: null })],
  ['c log create flow unknown', 'POST', '/cycle/logs', DAYLOG({ flow: 'heavyish' })],
  ['c log create flow proto', 'POST', '/cycle/logs', DAYLOG({ flow: 'constructor' })],
  ['c log create date bad', 'POST', '/cycle/logs', DAYLOG({ log_date: '2026-11-31' })],
  ['c log create date missing', 'POST', '/cycle/logs', DAY_FIELDS({ flow: 'light' })],
  ['c log create visibility unknown', 'POST', '/cycle/logs', DAYLOG({ visibility: 'all' })],
  ['c log create mucus unknown', 'POST', '/cycle/logs', DAYLOG({ cervix_mucus: 'wet' })],
  ['c log create lh unknown', 'POST', '/cycle/logs', DAYLOG({ lh_test: 'maybe' })],
  ['c log create pregnancy unknown', 'POST', '/cycle/logs', DAYLOG({ pregnancy_test: 'maybe' })],
  ['c log create intimacy unknown', 'POST', '/cycle/logs', DAYLOG({ intimacy: 'yes' })],
  ['c log create symptoms number', 'POST', '/cycle/logs', DAYLOG({ symptoms: 5 })],
  ['c log create symptoms object', 'POST', '/cycle/logs', DAYLOG({ symptoms: { key: 'cramps' } })],
  ['c log create symptoms intensity', 'POST', '/cycle/logs', DAYLOG({ symptoms: [{ key: 'cramps', intensity: 4 }] })],
  ['c log create symptoms too many', 'POST', '/cycle/logs', DAYLOG({ symptoms: Array.from({ length: MAX_SYMPTOMS_COUNT + 1 }, (_, i) => `sym_${i}`) })],
  ['c log create temp no unit', 'POST', '/cycle/logs', DAYLOG({ basal_temp: 36.5 })],
  ['c log create temp out of range', 'POST', '/cycle/logs', DAYLOG({ basal_temp: 45, basal_temp_unit: 'c' })],
  ['c log create temp unit upper', 'POST', '/cycle/logs', DAYLOG({ basal_temp: 36.5, basal_temp_unit: 'C' })],
  ['c log create temp unit proto', 'POST', '/cycle/logs', DAYLOG({ basal_temp: 99999, basal_temp_unit: 'constructor' })],
  ['c log create temp text', 'POST', '/cycle/logs', DAYLOG({ basal_temp: '36.5', basal_temp_unit: 'c' })],
  ['c log create unit without temp', 'POST', '/cycle/logs', DAY_FIELDS({ log_date: '2026-11-15', basal_temp_unit: 'c' })],
  ['c log create feelings unknown', 'POST', '/cycle/logs', DAYLOG({ feelings: ['grumpy'] })],
  ['c log create feelings text', 'POST', '/cycle/logs', DAYLOG({ feelings: 'good' })],
  ['c log create feelings upper', 'POST', '/cycle/logs', DAYLOG({ feelings: ['Good'] })],
  ['c log create mood unknown', 'POST', '/cycle/logs', DAYLOG({ mood: 'grumpy' })],
  ['c log create feelings null', 'POST', '/cycle/logs', DAY_FIELDS({ log_date: '2026-11-13', feelings: null })],
  ['c log create no body', 'POST', '/cycle/logs', NO_BODY],
  ['c logs', 'GET', '/cycle/logs', NO_BODY],
  ['c logs range', 'GET', '/cycle/logs?from=2026-11-13&to=2026-11-13', NO_BODY],
  ['c logs out', 'GET', `/cycle/logs?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['c logs user letters', 'GET', '/cycle/logs?user_id=x', NO_BODY],
  ['c log delete out', 'DELETE', () => `/cycle/logs/${ids.cl2}`, NO_BODY, { actor: 'out' }],
  ['c log delete zero', 'DELETE', '/cycle/logs/0', NO_BODY],
  ['c log delete negative', 'DELETE', '/cycle/logs/-1', NO_BODY],
  ['c log delete minus zero', 'DELETE', '/cycle/logs/-0', NO_BODY],
  ['c log delete', 'DELETE', () => `/cycle/logs/0${ids.cl2}`, NO_BODY],
  ['c settings default', 'GET', '/cycle/settings', NO_BODY],
  ['c settings put', 'PUT', '/cycle/settings', SETTINGS({ cycle_length_avg: 28, period_length_avg: 5, luteal_length: 13, track_fertility: false, pregnancy_mode: 0, default_visibility: 'family', remind_period_days_before: 2, remind_log_daily: true, contraception: 'pill', perimenopause_mode: false, show_pms: 1, notify_partner_user_id: CARE, notify_partner_days_before: 1 })],
  ['c settings get', 'GET', '/cycle/settings', NO_BODY],
  ['c settings put empty', 'PUT', '/cycle/settings', {}],
  ['c settings put partner text', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: String(CARE) })],
  ['c settings put partner self', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: OWN })],
  ['c settings put partner zero', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: 0 })],
  ['c settings put partner zero text', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: '0' })],
  ['c settings put partner negative', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: -3 })],
  ['c settings put partner child', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: KID })],
  ['c settings put partner guest', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: GUEST })],
  ['c settings put partner missing', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: MISSING })],
  ['c settings put partner letters', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: '12abc' })],
  ['c settings put partner true', 'PUT', '/cycle/settings', SETTINGS({ notify_partner_user_id: true })],
  ['c settings put length low', 'PUT', '/cycle/settings', SETTINGS({ cycle_length_avg: 14 })],
  ['c settings put length high', 'PUT', '/cycle/settings', SETTINGS({ cycle_length_avg: 100 })],
  ['c settings put length text', 'PUT', '/cycle/settings', SETTINGS({ cycle_length_avg: '28' })],
  ['c settings put length fraction', 'PUT', '/cycle/settings', SETTINGS({ cycle_length_avg: 28.5 })],
  ['c settings put length empty', 'PUT', '/cycle/settings', SETTINGS({ cycle_length_avg: '' })],
  ['c settings put luteal null', 'PUT', '/cycle/settings', SETTINGS({ luteal_length: null })],
  ['c settings put remind high', 'PUT', '/cycle/settings', SETTINGS({ remind_period_days_before: 99 })],
  ['c settings put track text', 'PUT', '/cycle/settings', SETTINGS({ track_fertility: 'yes' })],
  ['c settings put track null', 'PUT', '/cycle/settings', SETTINGS({ track_fertility: null })],
  ['c settings put pregnancy two', 'PUT', '/cycle/settings', SETTINGS({ pregnancy_mode: 2 })],
  ['c settings put remind text', 'PUT', '/cycle/settings', SETTINGS({ remind_log_daily: '1' })],
  ['c settings put peri text', 'PUT', '/cycle/settings', SETTINGS({ perimenopause_mode: 'false' })],
  ['c settings put pms text', 'PUT', '/cycle/settings', SETTINGS({ show_pms: 'on' })],
  ['c settings put due bad', 'PUT', '/cycle/settings', SETTINGS({ pregnancy_due_date: '2027-02-29' })],
  ['c settings put due', 'PUT', '/cycle/settings', SETTINGS({ pregnancy_mode: true, pregnancy_due_date: '2027-05-01' })],
  ['c settings put visibility unknown', 'PUT', '/cycle/settings', SETTINGS({ default_visibility: 'all' })],
  ['c settings put contraception unknown', 'PUT', '/cycle/settings', SETTINGS({ contraception: 'luck' })],
  ['c settings put contraception proto', 'PUT', '/cycle/settings', SETTINGS({ contraception: 'toString' })],
  ['c settings put no body', 'PUT', '/cycle/settings', NO_BODY],
  ['c settings put back', 'PUT', '/cycle/settings', SETTINGS({ default_visibility: 'family', cycle_length_avg: 30 })],
  ['c settings other', 'GET', '/cycle/settings', NO_BODY, { actor: 'out' }],
  ['c visibility', 'PATCH', '/cycle/visibility', { visibility: 'private' }],
  ['c visibility family', 'PATCH', '/cycle/visibility', { visibility: 'family' }],
  ['c visibility missing', 'PATCH', '/cycle/visibility', {}],
  ['c visibility null', 'PATCH', '/cycle/visibility', { visibility: null }],
  ['c visibility empty', 'PATCH', '/cycle/visibility', { visibility: '' }],
  ['c visibility unknown', 'PATCH', '/cycle/visibility', { visibility: 'all' }],
  ['c visibility no body', 'PATCH', '/cycle/visibility', NO_BODY],
  ['c visibility out', 'PATCH', '/cycle/visibility', { visibility: 'private' }, { actor: 'out' }],
  ['c import', 'POST', '/cycle/import', { csv: 'start_date,end_date\n2026-07-01,2026-07-05\n02.08.2026;06.08.2026\n2026-10-20,\n' }],
  ['c import semicolon', 'POST', '/cycle/import', { csv: 'start_date;end_date\n01.06.2026;05.06.2026\n01.06.2026;05.06.2026' }],
  ['c import no header', 'POST', '/cycle/import', { csv: '2026-05-01,2026-05-04' }],
  ['c import empty', 'POST', '/cycle/import', { csv: '' }],
  ['c import spaces', 'POST', '/cycle/import', { csv: '  \n ' }],
  ['c import missing', 'POST', '/cycle/import', {}],
  ['c import number', 'POST', '/cycle/import', { csv: 5 }],
  ['c import no body', 'POST', '/cycle/import', NO_BODY],
  ['c import header only', 'POST', '/cycle/import', { csv: 'start_date,end_date\n' }],
  ['c import too large', 'POST', '/cycle/import', { csv: `start_date\n${'2026-01-01\n'.repeat(10000)}` }],
  ['c import too many', 'POST', '/cycle/import', { csv: csvRows(501) }],
  ['c import bad rows', 'POST', '/cycle/import', { csv: 'start_date,end_date\nx,\n2026-02-30,\n2026-03-01,2026-02-01\n2026-04-01,y\n"2026-05-01","2026-05-03"' }],
  ['c import many bad rows', 'POST', '/cycle/import', { csv: Array.from({ length: 12 }, (_, i) => `bad${i},`).join('\n') }],
  ['c export', 'GET', '/export/cycle', NO_BODY],
  ['c export range', 'GET', '/export/cycle?from=2026-10-01&to=2026-11-30', NO_BODY],
  ['c export from bad', 'GET', '/export/cycle?from=2026-02-30', NO_BODY],
  ['c export to shape', 'GET', '/export/cycle?to=x', NO_BODY],
  ['c export out', 'GET', `/export/cycle?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['c export user zero', 'GET', '/export/cycle?user_id=0', NO_BODY],
  ['c period delete care', 'DELETE', () => `/cycle/periods/${ids.cp1}`, NO_BODY, { actor: 'care' }],
  ['c period delete zero', 'DELETE', '/cycle/periods/0', NO_BODY],
  ['c period delete negative', 'DELETE', '/cycle/periods/-1', NO_BODY],
  ['c period delete', 'DELETE', () => `/cycle/periods/${ids.cp1}`, NO_BODY],
  ['c period delete again', 'DELETE', () => `/cycle/periods/${ids.cp1}`, NO_BODY],

  // ══ CYCLE FEED ═════════════════════════════════════════════════════════════
  ['cf get none', 'GET', '/cycle/feed', NO_BODY],
  ['cf regenerate', 'POST', '/cycle/feed/regenerate', NO_BODY],
  ['cf regenerate body', 'POST', '/cycle/feed/regenerate', { x: 1 }],
  ['cf get', 'GET', '/cycle/feed', NO_BODY],
  ['cf delete', 'DELETE', '/cycle/feed', NO_BODY],
  ['cf get after delete', 'GET', '/cycle/feed', NO_BODY],

  // ══ CAREGIVERS ═════════════════════════════════════════════════════════════
  ['cg me care', 'GET', '/caregivers/me', NO_BODY, { actor: 'care' }],
  ['cg me own', 'GET', '/caregivers/me', NO_BODY],
  ['cg list', 'GET', '/caregivers', NO_BODY, { actor: 'admin' }],
  ['cg list member', 'GET', '/caregivers', NO_BODY],
  ['cg put', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: [OWN, String(CARE), `00${CARE}`, OUT] }, { actor: 'admin' }],
  ['cg put empty', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: [] }, { actor: 'admin' }],
  ['cg put member', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: [OWN] }],
  ['cg put member broken', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: 'x' }],
  ['cg put not list', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: OWN }, { actor: 'admin' }],
  ['cg put null', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: null }, { actor: 'admin' }],
  ['cg put missing field', 'PUT', `/caregivers/${OUT}`, {}, { actor: 'admin' }],
  ['cg put letters', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: ['abc'] }, { actor: 'admin' }],
  ['cg put zero', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: [0] }, { actor: 'admin' }],
  ['cg put zero text', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: ['0'] }, { actor: 'admin' }],
  ['cg put unknown user', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: [MISSING] }, { actor: 'admin' }],
  ['cg put former', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: [FORMER] }, { actor: 'admin' }],
  ['cg put to former', 'PUT', `/caregivers/${FORMER}`, { caregiver_ids: [OWN] }, { actor: 'admin' }],
  ['cg put guest', 'PUT', `/caregivers/${OUT}`, { caregiver_ids: [GUEST] }, { actor: 'admin' }],
  ['cg put no body', 'PUT', `/caregivers/${OUT}`, NO_BODY, { actor: 'admin' }],
  ['cg put subject missing', 'PUT', `/caregivers/${MISSING}`, { caregiver_ids: [] }, { actor: 'admin' }],
  ['cg put subject zero', 'PUT', '/caregivers/0', { caregiver_ids: [] }, { actor: 'admin' }],
  ['cg put subject negative', 'PUT', '/caregivers/-1', { caregiver_ids: [] }, { actor: 'admin' }],
  ['cg put subject minus zero', 'PUT', '/caregivers/-0', { caregiver_ids: [] }, { actor: 'admin' }],
  ['cg put subject leading zero', 'PUT', `/caregivers/00${OUT}`, { caregiver_ids: [] }, { actor: 'admin' }],
  ['cg put subject letters', 'PUT', '/caregivers/abc', { caregiver_ids: [] }, { actor: 'admin' }],
  ['cg list after', 'GET', '/caregivers', NO_BODY, { actor: 'admin' }],

  // ══ VISIBILITY DEFAULTS ════════════════════════════════════════════════════
  ['vd get empty', 'GET', '/visibility-defaults', NO_BODY],
  ['vd put', 'PUT', '/visibility-defaults', { defaults: { 'vital:bp': 'family', meds: 'family', labs: 'private', nutrition: 'family' } }],
  ['vd get', 'GET', '/visibility-defaults', NO_BODY],
  ['vd put empty', 'PUT', '/visibility-defaults', { defaults: {} }],
  ['vd put unknown scope', 'PUT', '/visibility-defaults', { defaults: { cycle: 'family' } }],
  ['vd put proto scope', 'PUT', '/visibility-defaults', { defaults: { constructor: 'family' } }],
  ['vd put vital upper', 'PUT', '/visibility-defaults', { defaults: { 'vital:BP': 'family' } }],
  ['vd put visibility unknown', 'PUT', '/visibility-defaults', { defaults: { meds: 'all' } }],
  ['vd put visibility null', 'PUT', '/visibility-defaults', { defaults: { meds: null } }],
  ['vd put defaults list', 'PUT', '/visibility-defaults', { defaults: [] }],
  ['vd put defaults text', 'PUT', '/visibility-defaults', { defaults: 'meds' }],
  ['vd put defaults missing', 'PUT', '/visibility-defaults', {}],
  ['vd put no body', 'PUT', '/visibility-defaults', NO_BODY],
  ['vd put fasting', 'PUT', '/visibility-defaults', { defaults: { fasting: 'family' } }],
  ['vd put fasting nofast', 'PUT', '/visibility-defaults', { defaults: { fasting: 'family' } }, { actor: 'nofast' }],
  ['vd put fasting nofast broken', 'PUT', '/visibility-defaults', { defaults: { fasting: 'x' } }, { actor: 'nofast' }],
  ['vd put meds nofast', 'PUT', '/visibility-defaults', { defaults: { meds: 'family' } }, { actor: 'nofast' }],
  ['vd apply', 'PATCH', '/visibility-defaults/apply', { scope: 'meds', visibility: 'family' }],
  ['vd apply vital', 'PATCH', '/visibility-defaults/apply', { scope: 'vital:weight', visibility: 'private' }],
  ['vd apply nutrition', 'PATCH', '/visibility-defaults/apply', { scope: 'nutrition', visibility: 'family' }],
  ['vd apply fasting', 'PATCH', '/visibility-defaults/apply', { scope: 'fasting', visibility: 'private' }],
  ['vd apply fasting nofast', 'PATCH', '/visibility-defaults/apply', { scope: 'fasting', visibility: 'private' }, { actor: 'nofast' }],
  ['vd apply unknown scope', 'PATCH', '/visibility-defaults/apply', { scope: 'cycle', visibility: 'private' }],
  ['vd apply proto scope', 'PATCH', '/visibility-defaults/apply', { scope: '__proto__', visibility: 'private' }],
  ['vd apply scope list', 'PATCH', '/visibility-defaults/apply', { scope: ['meds'], visibility: 'private' }],
  ['vd apply scope missing', 'PATCH', '/visibility-defaults/apply', { visibility: 'private' }],
  ['vd apply visibility unknown', 'PATCH', '/visibility-defaults/apply', { scope: 'meds', visibility: 'all' }],
  ['vd apply visibility missing', 'PATCH', '/visibility-defaults/apply', { scope: 'meds' }],
  ['vd apply no body', 'PATCH', '/visibility-defaults/apply', NO_BODY],

  // ══ FASTING ════════════════════════════════════════════════════════════════
  ['f state', 'GET', '/fasting/state', NO_BODY],
  ['f state nofast', 'GET', '/fasting/state', NO_BODY, { actor: 'nofast' }],
  ['f state nofast broken', 'GET', '/fasting/state?user_id=abc', NO_BODY, { actor: 'nofast' }],
  ['f state user letters', 'GET', '/fasting/state?user_id=abc', NO_BODY],
  ['f state care', 'GET', `/fasting/state?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['f state out', 'GET', `/fasting/state?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['f state guest', 'GET', '/fasting/state', NO_BODY, { actor: 'guest' }],
  ['f create no ack', 'POST', '/fasting', FAST()],
  ['f ack', 'POST', '/fasting/acknowledge-safety', {}],
  ['f ack no body', 'POST', '/fasting/acknowledge-safety', NO_BODY],
  ['f ack for other', 'POST', '/fasting/acknowledge-safety', { user_id: OWN }, { actor: 'care' }],
  ['f ack user zero', 'POST', '/fasting/acknowledge-safety', { user_id: 0 }],
  ['f create', 'POST', '/fasting', FAST({ goal_minutes: 720, rating: 4, note: 'gut', visibility: 'family' })],
  () => { ids.f1 = lastId('health_fasts'); },
  ['f create overlap', 'POST', '/fasting', FAST({ start_at: '2026-11-17T10:00:00Z', end_at: '2026-11-17T11:00:00Z' })],
  ['f create active', 'POST', '/fasting', { start_at: '2026-11-18T06:00:00Z', start_tzid: 'Europe/Berlin', goal_minutes: 960 }],
  () => { ids.f2 = lastId('health_fasts'); },
  ['f create second active', 'POST', '/fasting', { start_at: '2026-11-18T07:00:00Z', start_tzid: 'Europe/Berlin' }],
  ['f create future', 'POST', '/fasting', FAST({ start_at: '2026-11-19T08:00:00Z', end_at: null })],
  ['f create goal odd', 'POST', '/fasting', FAST({ goal_minutes: 61 })],
  ['f create goal text', 'POST', '/fasting', FAST({ goal_minutes: '720' })],
  ['f create rating high', 'POST', '/fasting', FAST({ rating: 6 })],
  ['f create zone bad', 'POST', '/fasting', FAST({ start_tzid: 'Mars/Base' })],
  ['f create tzid missing', 'POST', '/fasting', { start_at: '2026-11-16T08:00:00Z', end_at: '2026-11-16T12:00:00Z' }],
  ['f create start no offset', 'POST', '/fasting', FAST({ start_at: '2026-11-16T08:00:00' })],
  ['f create start garbage offset', 'POST', '/fasting', FAST({ start_at: 'yesterdayZ' })],
  ['f create visibility null', 'POST', '/fasting', FAST({ visibility: null })],
  ['f create for cared', 'POST', '/fasting', FAST({ user_id: OWN, start_at: '2026-11-15T08:00:00Z', end_at: '2026-11-15T12:00:00Z' }), { actor: 'care' }],
  ['f create for other', 'POST', '/fasting', FAST({ user_id: OWN }), { actor: 'out' }],
  ['f create no body', 'POST', '/fasting', NO_BODY],
  ['f history', 'GET', '/fasting/history', NO_BODY],
  ['f list', 'GET', '/fasting?limit=1', NO_BODY],
  ['f history range', 'GET', '/fasting/history?from=2026-11-17&to=2026-11-17', NO_BODY],
  ['f history reversed', 'GET', '/fasting/history?from=2026-11-18&to=2026-11-17', NO_BODY],
  ['f history from bad', 'GET', '/fasting/history?from=2026-02-30', NO_BODY],
  ['f history half cursor', 'GET', '/fasting/history?before_id=1', NO_BODY],
  ['f history limit high', 'GET', '/fasting/history?limit=101', NO_BODY],
  ['f history out', 'GET', `/fasting/history?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['f stats', 'GET', '/fasting/stats', NO_BODY],
  ['f stats nofast', 'GET', '/fasting/stats', NO_BODY, { actor: 'nofast' }],
  ['f settings', 'GET', '/fasting/settings', NO_BODY],
  ['f settings out', 'GET', `/fasting/settings?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['f settings put', 'PUT', '/fasting/settings', { default_goal_minutes: 960, clock_mode: 'remaining', remind_goal: true }],
  ['f settings put clock bad', 'PUT', '/fasting/settings', { clock_mode: 'x' }],
  ['f settings put other', 'PUT', `/fasting/settings?user_id=${OWN}`, { clock_mode: 'elapsed' }, { actor: 'care' }],
  ['f settings put active revision', 'PUT', '/fasting/settings', { default_goal_minutes: 1200, active_id: 1, expected_revision: 99 }],
  ['f finish revision', 'POST', () => `/fasting/${ids.f2}/finish`, { expected_revision: 99 }],
  ['f finish missing revision', 'POST', () => `/fasting/${ids.f2}/finish`, {}],
  ['f finish finished', 'POST', () => `/fasting/${ids.f1}/finish`, { expected_revision: 1 }],
  ['f finish missing', 'POST', `/fasting/${MISSING}/finish`, { expected_revision: 1 }],
  ['f finish zero', 'POST', '/fasting/0/finish', { expected_revision: 1 }],
  ['f finish negative', 'POST', '/fasting/-1/finish', { expected_revision: 1 }],
  ['f finish minus zero', 'POST', '/fasting/-0/finish', { expected_revision: 1 }],
  ['f finish letters', 'POST', '/fasting/0x10/finish', { expected_revision: 1 }],
  ['f finish', 'POST', () => `/fasting/00${ids.f2}/finish`, { expected_revision: 1, end_at: '2026-11-18T11:00:00Z' }],
  ['f patch', 'PATCH', () => `/fasting/${ids.f1}`, { expected_revision: 1, note: 'bearbeitet', rating: 5 }],
  ['f patch stale', 'PATCH', () => `/fasting/${ids.f1}`, { expected_revision: 1, note: 'alt' }],
  ['f patch visibility null', 'PATCH', () => `/fasting/${ids.f1}`, { expected_revision: 2, visibility: null }],
  ['f patch revision text', 'PATCH', () => `/fasting/${ids.f1}`, { expected_revision: '2', note: 'x' }],
  ['f patch no revision', 'PATCH', () => `/fasting/${ids.f1}`, { note: 'x' }],
  ['f patch out', 'PATCH', () => `/fasting/${ids.f1}`, { expected_revision: 2, note: 'x' }, { actor: 'out' }],
  ['f patch zero', 'PATCH', '/fasting/0', { expected_revision: 1 }],
  ['f patch negative', 'PATCH', '/fasting/-1', { expected_revision: 1 }],
  ['f patch leading zero', 'PATCH', () => `/fasting/0${ids.f1}`, { expected_revision: 2, note: 'vorn' }],
  ['f export', 'GET', '/export/fasting', NO_BODY],
  ['f export range', 'GET', '/export/fasting?from=2026-11-17&to=2026-11-17', NO_BODY],
  ['f export nofast', 'GET', '/export/fasting', NO_BODY, { actor: 'nofast' }],
  ['f export to bad', 'GET', '/export/fasting?to=2026-13-01', NO_BODY],
  ['f delete stale', 'DELETE', () => `/fasting/${ids.f1}`, { expected_revision: 1 }],
  ['f delete no revision', 'DELETE', () => `/fasting/${ids.f1}`, NO_BODY],
  ['f delete zero', 'DELETE', '/fasting/0?expected_revision=1', NO_BODY],
  ['f delete minus zero', 'DELETE', '/fasting/-0?expected_revision=1', NO_BODY],
  ['f delete nofast', 'DELETE', () => `/fasting/${ids.f1}?expected_revision=3`, NO_BODY, { actor: 'nofast' }],
  ['f delete', 'DELETE', () => `/fasting/${ids.f1}?expected_revision=3`, NO_BODY],
  ['f delete again', 'DELETE', () => `/fasting/${ids.f1}?expected_revision=3`, NO_BODY],

  // ══ EXPORTS ════════════════════════════════════════════════════════════════
  ['x vitals', 'GET', '/export/vitals', NO_BODY],
  ['x vitals range', 'GET', '/export/vitals?from=2026-11-10&to=2026-11-10', NO_BODY],
  ['x vitals care', 'GET', `/export/vitals?user_id=${OWN}`, NO_BODY, { actor: 'care' }],
  ['x vitals out', 'GET', `/export/vitals?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['x vitals from bad', 'GET', '/export/vitals?from=2026-02-30', NO_BODY],
  ['x vitals from shape', 'GET', '/export/vitals?from=10.11.2026', NO_BODY],
  ['x vitals from empty', 'GET', '/export/vitals?from=', NO_BODY],
  ['x vitals to doubled', 'GET', '/export/vitals?to=2026-11-10&to=2026-11-11', NO_BODY],
  ['x vitals user zero', 'GET', '/export/vitals?user_id=0', NO_BODY],
  ['x activities', 'GET', '/export/activities', NO_BODY],
  ['x activities range', 'GET', '/export/activities?from=2026-11-12&to=2026-11-12', NO_BODY],
  ['x activities to bad', 'GET', '/export/activities?to=x', NO_BODY],
  ['x labs', 'GET', '/export/labs', NO_BODY],
  ['x labs range', 'GET', '/export/labs?from=2026-11-05&to=2026-11-05', NO_BODY],
  ['x labs out', 'GET', `/export/labs?user_id=${OWN}`, NO_BODY, { actor: 'out' }],
  ['x nutrition', 'GET', '/export/nutrition', NO_BODY],
  ['x nutrition range', 'GET', '/export/nutrition?from=2026-11-18&to=2026-11-18', NO_BODY],
  ['x nutrition guest', 'GET', `/export/nutrition?user_id=${OWN}`, NO_BODY, { actor: 'guest' }],
  ['x meds logs', 'GET', '/export/meds-logs', NO_BODY],
  ['x meds logs range', 'GET', '/export/meds-logs?from=2026-11-18&to=2026-11-18', NO_BODY],
  ['x meds logs to bad', 'GET', '/export/meds-logs?to=2026-11-31', NO_BODY],
];

// Written against 17171ed1a, before the refactor: test/health-answers-expected.js.

/** Runs the table and returns each row's answer, normalized. */
async function runTable() {
  /** @type {Record<string, { status: number, body: unknown }>} */
  const answers = {};
  for (const step of STEPS) {
    if (typeof step === 'function') { await step(); continue; }
    const [name, method, route, body, opts] = step;
    assert.ok(!Object.hasOwn(answers, name), `duplicate row name ${name}`);
    const actual = await call(method, typeof route === 'function' ? route() : route, typeof body === 'function' ? body() : body, opts);
    answers[name] = { status: actual.status, body: normalized(actual.body) };
  }
  return answers;
}

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  logged.error.length = 0;
  const answers = await runTable();
  for (const [name, answer] of Object.entries(answers)) {
    assert.ok(Object.hasOwn(EXPECTED, name), `no expectation for ${name}`);
    assert.deepEqual(answer, EXPECTED[name], name);
  }
  assert.equal(Object.keys(answers).length, Object.keys(EXPECTED).length, 'every expectation has its row');
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
 * @param {Array<[string, string, unknown, string, string?]>} rows [method, path under /api/v1/health, body, route pattern under /api/v1/health, actor]
 */
async function assertAllCentral(rows) {
  for (const [method, route, body, pattern, actor] of rows) {
    assertCentral(await call(method, route, body, { fail: true, actor: actor ?? 'own' }), method, `/api/v1/health${pattern}`);
  }
}

/** A new row through the route, its id. @param {string} route @param {unknown} body @param {string} [actor] */
async function created(route, body, actor = 'own') {
  const res = await call('POST', route, body, { actor });
  assert.ok(res.status === 201 || res.status === 200, `${route}: ${JSON.stringify(res.body)}`);
  return /** @type {any} */ (res.body).data.id;
}

test('an unexpected error in each of the 85 routes is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  // Vitals, activities
  const vital = await created('/vitals', VITAL());
  const activity = await created('/activities', ACT());
  await assertAllCentral([
    ['GET', '/vitals', NO_BODY, '/vitals'],
    ['POST', '/vitals', VITAL(), '/vitals'],
    ['PATCH', `/vitals/${vital}`, { note: 'x' }, '/vitals/:id'],
    ['DELETE', `/vitals/${vital}`, NO_BODY, '/vitals/:id'],
    ['GET', '/activities', NO_BODY, '/activities'],
    ['POST', '/activities', ACT(), '/activities'],
    ['PATCH', `/activities/${activity}`, { note: 'x' }, '/activities/:id'],
    ['DELETE', `/activities/${activity}`, NO_BODY, '/activities/:id'],
  ]);
  // Medications, schedules, dose log
  const med = await created('/medications', MED({ name: 'Probe' }));
  const schedule = await created(`/medications/${med}/schedules`, SCHED());
  const dose = await created(`/medications/${med}/logs`, { status: 'taken', dose_qty: 1 });
  const pending = await created(`/medications/${med}/logs`, { status: null });
  await assertAllCentral([
    ['GET', '/medications', NO_BODY, '/medications'],
    ['POST', '/medications', MED({ name: 'Probe 2' }), '/medications'],
    ['PATCH', `/medications/${med}`, { note: 'x' }, '/medications/:id'],
    ['GET', `/medications/${med}/schedules`, NO_BODY, '/medications/:id/schedules'],
    ['POST', `/medications/${med}/schedules`, SCHED({ time_of_day: '21:00' }), '/medications/:id/schedules'],
    ['PATCH', `/schedules/${schedule}`, { dose_qty: 2 }, '/schedules/:id'],
    ['GET', `/medications/${med}/logs`, NO_BODY, '/medications/:id/logs'],
    ['POST', `/medications/${med}/logs`, { status: null }, '/medications/:id/logs'],
    ['PATCH', `/logs/${dose}`, { note: 'x' }, '/logs/:id'],
    ['POST', `/logs/${pending}/take`, {}, '/logs/:id/take'],
    ['POST', `/logs/${pending}/skip`, NO_BODY, '/logs/:id/skip'],
    ['POST', `/logs/${dose}/undo`, {}, '/logs/:id/undo'],
    ['DELETE', `/logs/${pending}`, NO_BODY, '/logs/:id'],
    ['DELETE', `/schedules/${schedule}`, NO_BODY, '/schedules/:id'],
    ['DELETE', `/medications/${med}`, NO_BODY, '/medications/:id'],
  ]);
  // Labs
  const report = await created('/labs', LAB({ results: [RESULT()] }));
  const result = await created(`/labs/${report}/results`, RESULT({ analyte: 'Probe' }));
  await assertAllCentral([
    ['GET', '/labs', NO_BODY, '/labs'],
    ['GET', `/labs/${report}`, NO_BODY, '/labs/:id'],
    ['POST', '/labs', LAB(), '/labs'],
    ['PATCH', `/labs/${report}`, { note: 'x' }, '/labs/:id'],
    ['POST', `/labs/${report}/results`, RESULT(), '/labs/:id/results'],
    ['PATCH', `/results/${result}`, { value_num: 1 }, '/results/:id'],
    ['DELETE', `/results/${result}`, NO_BODY, '/results/:id'],
    ['DELETE', `/labs/${report}`, NO_BODY, '/labs/:id'],
  ]);
  // Exports
  await assertAllCentral([
    ['GET', '/export/vitals', NO_BODY, '/export/vitals'],
    ['GET', '/export/activities', NO_BODY, '/export/activities'],
    ['GET', '/export/labs', NO_BODY, '/export/labs'],
    ['GET', '/export/nutrition', NO_BODY, '/export/nutrition'],
    ['GET', '/export/meds-logs', NO_BODY, '/export/meds-logs'],
  ]);
  // Cycle and its feed
  const period = await created('/cycle/periods', { start_date: '2026-08-01' });
  const dayLog = await created('/cycle/logs', DAY_FIELDS({ log_date: '2026-08-02' }));
  await assertAllCentral([
    ['GET', '/cycle/periods', NO_BODY, '/cycle/periods'],
    ['POST', '/cycle/periods', { start_date: '2026-07-01' }, '/cycle/periods'],
    ['PATCH', `/cycle/periods/${period}`, { note: 'x' }, '/cycle/periods/:id'],
    ['DELETE', `/cycle/periods/${period}`, NO_BODY, '/cycle/periods/:id'],
    ['GET', '/cycle/logs', NO_BODY, '/cycle/logs'],
    ['POST', '/cycle/logs', DAY_FIELDS({ log_date: '2026-08-03' }), '/cycle/logs'],
    ['DELETE', `/cycle/logs/${dayLog}`, NO_BODY, '/cycle/logs/:id'],
    ['GET', '/cycle/settings', NO_BODY, '/cycle/settings'],
    ['PUT', '/cycle/settings', SETTINGS(), '/cycle/settings'],
    ['PATCH', '/cycle/visibility', { visibility: 'private' }, '/cycle/visibility'],
    ['GET', '/export/cycle', NO_BODY, '/export/cycle'],
    ['POST', '/cycle/import', { csv: '2026-06-01,2026-06-04' }, '/cycle/import'],
    ['GET', '/cycle/feed', NO_BODY, '/cycle/feed'],
    ['POST', '/cycle/feed/regenerate', NO_BODY, '/cycle/feed/regenerate'],
    ['DELETE', '/cycle/feed', NO_BODY, '/cycle/feed'],
  ]);
  // Caregivers, visibility defaults
  await assertAllCentral([
    ['GET', '/caregivers/me', NO_BODY, '/caregivers/me'],
    ['GET', '/caregivers', NO_BODY, '/caregivers', 'admin'],
    ['PUT', `/caregivers/${OUT}`, { caregiver_ids: [] }, '/caregivers/:subjectId', 'admin'],
    ['GET', '/visibility-defaults', NO_BODY, '/visibility-defaults'],
    ['PUT', '/visibility-defaults', { defaults: { meds: 'private' } }, '/visibility-defaults'],
    ['PATCH', '/visibility-defaults/apply', { scope: 'meds', visibility: 'private' }, '/visibility-defaults/apply'],
  ]);
  // Fasting
  const fast = await created('/fasting', FAST({ start_at: '2026-11-10T08:00:00Z', end_at: '2026-11-10T12:00:00Z' }));
  const active = await created('/fasting', { start_at: '2026-11-18T11:30:00Z', start_tzid: 'Europe/Berlin' });
  await assertAllCentral([
    ['GET', '/fasting/state', NO_BODY, '/fasting/state'],
    ['GET', '/fasting/history', NO_BODY, '/fasting/history'],
    ['GET', '/fasting/stats', NO_BODY, '/fasting/stats'],
    ['GET', '/fasting', NO_BODY, '/fasting'],
    ['POST', '/fasting', FAST({ start_at: '2026-11-09T08:00:00Z', end_at: '2026-11-09T12:00:00Z' }), '/fasting'],
    ['POST', '/fasting/acknowledge-safety', {}, '/fasting/acknowledge-safety'],
    ['GET', '/fasting/settings', NO_BODY, '/fasting/settings'],
    ['PUT', '/fasting/settings', { clock_mode: 'elapsed' }, '/fasting/settings'],
    ['POST', `/fasting/${active}/finish`, { expected_revision: 1 }, '/fasting/:id/finish'],
    ['PATCH', `/fasting/${fast}`, { expected_revision: 1, note: 'x' }, '/fasting/:id'],
    ['DELETE', `/fasting/${fast}?expected_revision=2`, NO_BODY, '/fasting/:id'],
    ['GET', '/export/fasting', NO_BODY, '/export/fasting'],
  ]);
  // Prevention
  const type = await created('/prevention/types', TYPE({ name: 'Probe' }), 'admin');
  const record = await created('/prevention/records', { given_on: '2026-10-01', type_id: type });
  await assertAllCentral([
    ['GET', '/prevention/types', NO_BODY, '/prevention/types'],
    ['POST', '/prevention/types', TYPE({ name: 'Probe 2' }), '/prevention/types', 'admin'],
    ['PATCH', `/prevention/types/${type}`, { sort_order: 1 }, '/prevention/types/:id', 'admin'],
    ['GET', '/prevention/records', NO_BODY, '/prevention/records'],
    ['POST', '/prevention/records', { given_on: '2026-10-02', name: 'Probe' }, '/prevention/records'],
    ['PATCH', `/prevention/records/${record}`, { note: 'x' }, '/prevention/records/:id'],
    ['GET', '/prevention/due', NO_BODY, '/prevention/due'],
    ['DELETE', `/prevention/records/${record}`, NO_BODY, '/prevention/records/:id'],
    ['DELETE', `/prevention/types/${type}`, NO_BODY, '/prevention/types/:id', 'admin'],
  ]);
  // Nutrition
  const entry = await created('/nutrition/entries', ENTRY());
  await assertAllCentral([
    ['GET', '/nutrition/targets', NO_BODY, '/nutrition/targets'],
    ['PUT', '/nutrition/targets', TARGET({ energy_kcal: 1800 }), '/nutrition/targets'],
    ['GET', '/nutrition/entries', NO_BODY, '/nutrition/entries'],
    ['POST', '/nutrition/entries', ENTRY(), '/nutrition/entries'],
    ['PATCH', `/nutrition/entries/${entry}`, { note: 'x' }, '/nutrition/entries/:id'],
    ['DELETE', `/nutrition/entries/${entry}`, NO_BODY, '/nutrition/entries/:id'],
    ['GET', '/nutrition/summary', NO_BODY, '/nutrition/summary'],
  ]);
  assert.equal((await call('GET', '/vitals', NO_BODY)).status, 200, 'answers again');
});

test('the 500 sentence of health is the central one (the visible change of #2810 group 6)', async () => {
  // Before: { error: 'Internal error.', code: 500 } with an own log line from
  // vitals, medications, labs, activities, export, cycle, caregivers,
  // prevention and nutrition; { error: 'Internal server error.', code: 500 }
  // with an own log line from cycle-feed, fasting and the visibility defaults.
  logged.error.length = 0;
  const answers = [];
  for (const route of ['/vitals', '/medications', '/labs', '/activities', '/export/vitals', '/cycle/periods', '/caregivers/me',
    '/prevention/types', '/nutrition/entries', '/cycle/feed', '/fasting/state', '/visibility-defaults']) {
    answers.push([`GET ${route}`, await call('GET', route, NO_BODY, { fail: true })]);
  }
  const central = { status: 500, body: { error: 'Internal server error.', code: 500 } };
  assert.deepEqual(answers, [
    ['GET /vitals', central],
    ['GET /medications', central],
    ['GET /labs', central],
    ['GET /activities', central],
    ['GET /export/vitals', central],
    ['GET /cycle/periods', central],
    ['GET /caregivers/me', central],
    ['GET /prevention/types', central],
    ['GET /nutrition/entries', central],
    ['GET /cycle/feed', central],
    ['GET /fasting/state', central],
    ['GET /visibility-defaults', central],
  ]);
  assert.equal(logged.error.length, 12, 'each logged by the central handler');
  logged.error.length = 0;
});

test('the handled cases keep their own answer and never reach the central handler', async () => {
  logged.error.length = 0;
  // FastingError with reason and the current record (overlap), and the capability.
  const fast = await call('POST', '/fasting', FAST({ start_at: '2026-11-05T08:00:00Z', end_at: '2026-11-05T20:00:00Z' }));
  assert.equal(fast.status, 201);
  const overlap = await call('POST', '/fasting', FAST({ start_at: '2026-11-05T10:00:00Z', end_at: '2026-11-05T11:00:00Z' }));
  assert.equal(overlap.status, 409);
  assert.equal(/** @type {any} */ (overlap.body).reason, 'FASTING_OVERLAP');
  assert.deepEqual(/** @type {any} */ (overlap.body).current, /** @type {any} */ (fast.body).data);
  assert.deepEqual(await call('GET', '/fasting/state', NO_BODY, { actor: 'nofast' }), EXPECTED['f state nofast']);
  assert.deepEqual(await call('GET', '/fasting/history?from=2026-11-18&to=2026-11-17', NO_BODY), EXPECTED['f history reversed']);
  // health_dose_pending: undo of a pending entry.
  const med = await created('/medications', MED({ name: 'Handfall' }));
  const pending = await created(`/medications/${med}/logs`, { status: null });
  assert.deepEqual(await call('POST', `/logs/${pending}/undo`, {}), EXPECTED['l undo pending']);
  // The cycle import reasons with params.
  assert.deepEqual(await call('POST', '/cycle/import', { csv: `start_date\n${'2026-01-01\n'.repeat(10000)}` }), EXPECTED['c import too large']);
  assert.deepEqual(await call('POST', '/cycle/import', { csv: csvRows(501) }), EXPECTED['c import too many']);
  assert.deepEqual(await call('POST', '/cycle/import', { csv: 'start_date,end_date\n' }), EXPECTED['c import header only']);
  // The vital limits and units.
  assert.deepEqual(await call('POST', '/vitals', VITAL({ value_num: 9999 })), EXPECTED['v create out of range']);
  assert.deepEqual(await call('POST', '/vitals', VITAL({ unit: 'furlong' })), EXPECTED['v create unit invalid']);
  assert.deepEqual(await call('POST', '/vitals', { type: 'bp', value_num: 80, value_num2: 120, unit: 'mmHg', measured_at: '2026-11-11T08:00' }), EXPECTED['v create bp order']);
  // resolveOwner: 403 for a person the caller may not record for, 400 for user_id 0.
  assert.deepEqual(await call('POST', '/vitals', VITAL({ user_id: OWN }), { actor: 'out' }), EXPECTED['v create for other']);
  assert.deepEqual(await call('POST', '/vitals', VITAL({ user_id: 0 })), EXPECTED['v create user zero']);
  // A deactivated account of the care grants.
  assert.deepEqual(await call('PUT', `/caregivers/${OUT}`, { caregiver_ids: [FORMER] }, { actor: 'admin' }), EXPECTED['cg put former']);
  assert.deepEqual(logged.error, [], 'none reached the central handler');
});

/**
 * The handler of a route alone, without validateRequest() and whatever stands
 * in front of it in the route: the last function of its route layer.
 * @param {string} method lower case
 * @param {string} path the Express pattern under /api/v1/health
 */
async function bareHandler(method, path) {
  const { default: healthRouter } = await import('../server/routes/health.js');
  for (const outer of healthRouter.stack) {
    for (const layer of outer.handle.stack ?? []) {
      if (layer.route?.path === path && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
    }
  }
  throw new Error(`no route ${method} ${path}`);
}

/**
 * Runs a bare handler with a raw body and query and returns its answer.
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, query?: Record<string, unknown>, actor?: string }} input
 */
async function callBare(method, path, { body = {}, query = {}, actor = 'own' }) {
  const handler = await bareHandler(method, path);
  const who = ACTORS[actor];
  const req = { method: method.toUpperCase(), body, query, params: {}, authUserId: who.id, authRole: who.role, session: { userId: who.id, role: who.role } };
  /** @type {{ status: number, body: unknown, headers: Record<string, string> }} */
  const out = { status: 200, body: undefined, headers: {} };
  const res = {
    status(/** @type {number} */ code) { out.status = code; return res; },
    json(/** @type {unknown} */ value) { out.body = value; return res; },
    send(/** @type {unknown} */ value) { out.body = value; return res; },
    end() { return res; },
    setHeader(/** @type {string} */ name, /** @type {string} */ value) { out.headers[name] = value; },
  };
  handler(req, res, (/** @type {unknown} */ err) => { throw err; });
  return out;
}

// The schema refuses each of these in front (the table holds that). Behind it
// a loop, a `.length`, a string method or a lookup runs over the raw value, so
// the handler keeps its own type check there (sink, not route; CodeQL
// js/loop-bound-injection on splitCsvLine): called without validateRequest(),
// each answers its old sentence instead of throwing or looping.
test('the sinks check their own input: each handler alone refuses a raw value of the wrong type', async () => {
  const sentence = (/** @type {string} */ error) => ({ error, code: 400 });
  for (const csv of [5, ['2026-01-01'], { length: 1e9 }, null]) {
    assert.deepEqual((await callBare('post', '/cycle/import', { body: { csv } })).body, sentence('csv is required.'), `csv ${JSON.stringify(csv)}`);
  }
  assert.deepEqual((await callBare('post', '/medications', { body: { name: 'X', schedules: 'x' } })).body, sentence('schedules must be an array.'));
  assert.deepEqual((await callBare('post', '/medications', { body: { name: 'X', schedules: { length: 1e9 } } })).body, sentence('schedules must be an array.'));
  assert.deepEqual((await callBare('post', '/medications', { body: { name: 'X', schedules: Array.from({ length: 49 }, () => ({ time_of_day: '08:00' })) } })).body,
    sentence('schedules must not contain more than 48 entries.'));
  assert.deepEqual((await callBare('post', '/medications', { body: { name: 'X', schedules: [5] } })).body, sentence('schedules[0] must be an object.'));
  assert.deepEqual((await callBare('post', '/labs', { body: { report_date: '2026-11-01', results: { length: 1e9 } } })).status, 201, 'results that are no list are none');
  const care = await bareHandler('put', '/caregivers/:subjectId');
  /** @type {any} */
  const careAnswer = {};
  care({ body: { caregiver_ids: { length: 1e9 } }, params: { subjectId: String(OUT) }, query: {} },
    { status(/** @type {number} */ c) { careAnswer.status = c; return this; }, json(/** @type {unknown} */ v) { careAnswer.body = v; return this; } });
  assert.deepEqual(careAnswer, { status: 400, body: sentence('caregiver_ids must be an array.') });
  assert.deepEqual((await callBare('put', '/visibility-defaults', { body: { defaults: 'meds' } })).body, sentence('defaults must be an object.'));
  assert.deepEqual((await callBare('put', '/visibility-defaults', { body: { defaults: ['meds'] } })).body, sentence('defaults must be an object.'));
  assert.deepEqual((await callBare('patch', '/visibility-defaults/apply', { body: { scope: { startsWith: 1 }, visibility: 'private' } })).body, sentence('Unknown scope: [object Object]'));
  assert.deepEqual((await callBare('post', '/cycle/logs', { body: { log_date: '2026-11-20', feelings: 'good' } })).body, sentence('feelings must be an array.'));
  assert.deepEqual((await callBare('post', '/cycle/logs', { body: { log_date: '2026-11-20', feelings: [{}] } })).body, sentence('feelings must be an array.'));
  const csvAnswer = await callBare('get', '/export/vitals', { query: { from: ['2026-01-01', '2026-12-31'], to: { length: 5 } } });
  assert.equal(csvAnswer.status, 200, 'a doubled or odd day is no range');
  assert.equal(csvAnswer.headers['Content-Disposition'], 'attachment; filename="health-vitals.csv"');
});
