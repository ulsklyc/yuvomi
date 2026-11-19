/**
 * Test: Overview golden master - the full mixed answers of GET /dashboard and GET /search
 *       (phase 2, section D, step 1)
 * Purpose: a CHARACTERISATION, not a target. Section D cuts the dashboard
 *          route and the search into one slice per module; every cut must
 *          leave both answers byte-identical. This suite records them TODAY,
 *          on the visibility matrix seed plus a small extension
 *          (test/overview-golden-seed.js), for every matrix role:
 *
 *            <role>.session.json    GET /dashboard
 *            <role>.household.json  GET /dashboard?audience=household (the wall)
 *            <role>.search.json     ten GET /search queries
 *            admin.options.json     GET /dashboard with 51 `shopping_list` and
 *                                   51 `notes_category` values (the widget
 *                                   options; the only answer with `shoppingTile`)
 *
 *          The seed puts cap + 2 visible rows behind every capped list of
 *          both answers, so the caps and the order that decides which rows
 *          fall out are part of the master (sweep in the PR: every fixed
 *          `LIMIT n` and `.slice(0, n)` lowered by one turns the suite red).
 *
 *          under test/fixtures/overview-golden/, and compares them byte for
 *          byte: `JSON.stringify(value, null, 2)` plus a final newline, keys
 *          in the order the answer carries them. Each entry is
 *          `{ status, body }`, so a refusal (403, 401) is part of the master.
 *
 *          Rewrite the files after a deliberate change:
 *            UPDATE_GOLDEN=1 npm run test:overview-golden
 *          Without the switch the suite never writes.
 *
 * DETERMINISM - what is held and how:
 *   - Clock: `mock.timers` fakes `Date` (the same seam test:session-sliding
 *     and test:budget-month-zone use) at FROZEN_NOW, before the server is
 *     imported. Nothing in production changes; `setTimeout` stays real.
 *   - Zone: `household_timezone` is Europe/Berlin, so the household day is
 *     the same whatever `TZ` the process runs in (checked with TZ=UTC,
 *     Pacific/Auckland and America/Los_Angeles).
 *   - IDs: a fresh in-memory database on the cipher driver, seeded strictly
 *     one write after the other: AUTOINCREMENT ids are the same every run.
 *   - SQLite's own clock: column defaults and the `trg_*_updated_at`
 *     triggers stamp `strftime(..., 'now')`, which no JavaScript fake
 *     reaches. After seeding, `settleSqliteClock()` rewrites every text
 *     value within two days of SQLite's real "now" to FROZEN_NOW minus two
 *     days plus `rowid` seconds, in the value's own format (insert order is
 *     kept, no two rows of a table tie on `ORDER BY updated_at`). The update
 *     triggers are dropped for that one statement batch and recreated from
 *     their stored SQL. A value in an unknown format fails the suite instead
 *     of passing through.
 *   - Random member colours: `POST /auth/users` draws `avatar_color` at
 *     random; the seed sets one colour per account from a fixed list.
 *   - Rate limits: every role reads from its own `X-Forwarded-For`.
 *   - Background schedulers start after 10 s (server/index.js); the suite
 *     reads after about 1 s. Should a slow runner reach them, none changes
 *     an answer: the ICS sync stops before its first write (private network
 *     off), push has no subscription, pocket money has no allowance, and the
 *     medication scheduler only adds `pending` logs, which the dose count
 *     treats like a missing log.
 *
 * MASKING: none. No field of either answer is masked or dropped.
 *
 * A block whose query throws is logged as `[Dashboard] ...` and answers in
 * its empty form - that would land in the master as a quiet empty block. The
 * suite collects those log lines and fails on any.
 *
 * Run: npm run test:overview-golden
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

// None of these loads the server or reads the clock at import time:
// server/index.js is imported inside startTestServer(), after the fake below.
import { startTestServer } from './server-ready.js';
import { seedMatrix, ROLES } from './visibility-matrix-seed.js';
import { seedOverviewExtras, GOLDEN_TOKEN, INFIX_TOKEN } from './overview-golden-seed.js';

/** The one instant this suite lives in: a Wednesday, 10:30 in Berlin. */
const FROZEN_NOW = Date.parse('2026-03-11T09:30:00.000Z');
mock.timers.enable({ apis: ['Date'], now: FROZEN_NOW });

const FIXTURE_DIR = new URL('./fixtures/overview-golden/', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const HOUSEHOLD_ZONE = 'Europe/Berlin';

const { baseUrl: BASE } = await startTestServer({
  name: 'overview-golden',
  env: {
    SESSION_SECRET: 'test-overview-golden-secret-32chars!',
    DB_PATH: ':memory:',
    // Same pins as test:visibility-matrix: the seeded ICS subscriptions and
    // the Outlook target can never reach the network.
    ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK: 'false',
    MS_CLIENT_ID: '',
    MS_CLIENT_SECRET: '',
    MS_REDIRECT_URI: '',
  },
});
process.env.MCP_INTERNAL_BASE_URL = BASE;

const db = (await import('../server/db.js')).get();
const { todayKey, shiftDateKey } = await import('../server/utils/timezone.js');
const { PERMISSION_MODULES } = await import('../server/authorize/index.ts');
const { MODULE_KEYS } = await import('../server/scopes.js');
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');

db.prepare(`
  INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(HOUSEHOLD_ZONE);

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------

/** @type {string[]} */
const seen429 = [];

/**
 * @param {string} xff
 * @param {string} method
 * @param {string} path
 * @param {{ headers?: Record<string, string>, body?: unknown }} [options]
 * @returns {Promise<{ status: number, body: any, headers: Headers }>}
 */
async function http(xff, method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-Forwarded-For': xff, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) seen429.push(`${method} ${path} (${xff})`);
  const text = await res.text();
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

// --------------------------------------------------------------------------
// Seed
// --------------------------------------------------------------------------

const today = todayKey(db);
assert.equal(today, '2026-03-11', 'the frozen clock and the household zone give the expected day');
const nowIso = new Date(FROZEN_NOW).toISOString();
const dates = {
  today,
  inTwoDays: shiftDateKey(today, 2),
  inTenDays: shiftDateKey(today, 10),
  month: today.slice(0, 7),
  dueInstant: new Date(FROZEN_NOW - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
const seed = await seedMatrix({
  db, http, dates,
  permissionModules: PERMISSION_MODULES.map((m) => m.key),
  scopeModules: MODULE_KEYS,
  displayCookie: DISPLAY_COOKIE,
});
let extraIp = 0;
const { optionsQuery } = await seedOverviewExtras({
  db,
  call: (method, path, options) => http(`10.31.250.${++extraIp}`, method, path, options),
  adminHeaders: { Cookie: seed.sessions.admin.cookie, 'X-CSRF-Token': seed.sessions.admin.csrf },
  ids: seed.ids,
  rows: seed.rows,
  shift: shiftDateKey,
  dates: {
    today,
    yesterday: shiftDateKey(today, -1),
    monthStart: `${today.slice(0, 7)}-01`,
    inThreeDays: shiftDateKey(today, 3),
    nowIso,
    oneHourAgoIso: new Date(FROZEN_NOW - 60 * 60 * 1000).toISOString(),
    inOneHourIso: new Date(FROZEN_NOW + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  },
});

/** Fixed member colours instead of the random draw of `POST /auth/users`. */
const PALETTE = ['#2563EB', '#DB2777', '#059669', '#D97706', '#7C3AED', '#0891B2', '#DC2626', '#4B5563', '#65A30D', '#9333EA', '#EA580C'];
for (const { id } of db.prepare('SELECT id FROM users ORDER BY id').all()) {
  db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run(PALETTE[id % PALETTE.length], id);
}

/**
 * Formats a SQLite clock stamp can have, and the strftime pattern that writes
 * the settled value in the same shape.
 * @type {Array<[string, string]>}
 */
const STAMP_FORMATS = [
  ['[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z', '%Y-%m-%dT%H:%M:%fZ'],
  ['[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z', '%Y-%m-%dT%H:%M:%SZ'],
  ['[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]', '%Y-%m-%d %H:%M:%S'],
  ['[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]', '%Y-%m-%d'],
];

/**
 * Rewrites every value SQLite stamped with its real clock (see the header).
 * @returns {number} the number of settled cells
 */
function settleSqliteClock() {
  const base = new Date(FROZEN_NOW - 2 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nearNow = (/** @type {string} */ col) => `typeof("${col}") = 'text'
    AND julianday("${col}") BETWEEN julianday('now', '-2 days') AND julianday('now', '+2 days')`;
  const triggers = db.prepare(`
    SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%''now''%' ORDER BY name
  `).all();
  /** @type {string[]} */
  const virtual = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all()
    .map((/** @type {any} */ r) => r.name);
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all().map((/** @type {any} */ r) => r.name)
    .filter((/** @type {string} */ name) => !virtual.some((v) => name === v || name.startsWith(`${v}_`)));
  let settled = 0;
  /** @type {string[]} */
  const unknown = [];
  db.transaction(() => {
    for (const t of triggers) db.prepare(`DROP TRIGGER "${t.name}"`).run();
    for (const table of tables) {
      for (const { name: col } of db.prepare(`PRAGMA table_info("${table}")`).all()) {
        const cases = STAMP_FORMATS
          .map(([glob, fmt]) => `WHEN "${col}" GLOB '${glob}' THEN strftime('${fmt}', @base, '+' || rowid || ' seconds')`)
          .join(' ');
        settled += db.prepare(`UPDATE "${table}" SET "${col}" = CASE ${cases} ELSE "${col}" END WHERE ${nearNow(col)}`)
          .run({ base }).changes;
        const left = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${nearNow(col)}`).get().n;
        if (left) unknown.push(`${table}.${col}: ${left} value(s) in an unknown stamp format`);
      }
    }
    for (const t of triggers) db.prepare(t.sql).run();
  })();
  assert.deepEqual(unknown, [], 'every SQLite clock stamp is settled');
  return settled;
}
const settledCells = settleSqliteClock();

// --------------------------------------------------------------------------
// Roles, forms, queries
// --------------------------------------------------------------------------

/**
 * Auth headers of a role (tokens act for the member).
 * @param {string} role
 * @returns {Record<string, string>}
 */
function authHeaders(role) {
  if (role.startsWith('token_')) return { Authorization: `Bearer ${seed.tokens[role]}` };
  if (role === 'display') return { Cookie: `${DISPLAY_COOKIE}=${seed.displayToken}` };
  const session = seed.sessions[role];
  return { Cookie: session.cookie, 'X-CSRF-Token': session.csrf };
}

/** The two audiences of the overview. */
const FORMS = Object.freeze({ session: '/dashboard', household: '/dashboard?audience=household' });

/**
 * Ten searches per role. Each hit type of the search is found by at least
 * one; the last one finds nothing.
 */
const QUERIES = Object.freeze([
  'private',
  'mxtaskmember',
  'mxevtchild',
  'mxnoteadmin',
  'mxdocchild',
  'mxbudgetmember',
  'mxmedmember',
  INFIX_TOKEN,
  GOLDEN_TOKEN,
  'zzqxnohitzz',
]);
/** The role whose overview is also read with widget options. */
const OPTIONS_ROLE = 'admin';
const NO_HIT_QUERY = QUERIES[QUERIES.length - 1];

/** @type {(role: string, slot: number) => string} */
const xffOf = (role, slot) => `10.30.${ROLES.indexOf(role) + 1}.${slot}`;

// --------------------------------------------------------------------------
// Measure (blocks that fail log `[Dashboard]`; collected while reading)
// --------------------------------------------------------------------------

/** @type {string[]} */
const blockErrors = [];
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && /^\[(Dashboard|Search)\]/.test(args[0])) blockErrors.push(args.map(String).join(' '));
  originalError(...args);
};

/** @type {Map<string, any>} file name -> value */
const answers = new Map();
// `performance.now()` is not faked: the real time the reads took.
const started = performance.now();
for (const role of ROLES) {
  for (const [form, url] of Object.entries(FORMS)) {
    const res = await http(xffOf(role, form === 'session' ? 1 : 2), 'GET', `/api/v1${url}`, { headers: authHeaders(role) });
    answers.set(`${role}.${form}.json`, { status: res.status, body: res.body });
  }
  /** @type {Record<string, { status: number, body: any }>} */
  const searches = {};
  for (const q of QUERIES) {
    const res = await http(xffOf(role, 3), 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`, { headers: authHeaders(role) });
    searches[q] = { status: res.status, body: res.body };
  }
  answers.set(`${role}.search.json`, searches);
}
// The widget options of the overview (shopping list and note category
// selection, each one value above its cap of 50), read once by the admin:
// the only answer that carries `shoppingTile`.
{
  const res = await http(xffOf(OPTIONS_ROLE, 4), 'GET', `/api/v1/dashboard?${optionsQuery}`, { headers: authHeaders(OPTIONS_ROLE) });
  answers.set(`${OPTIONS_ROLE}.options.json`, { status: res.status, body: res.body });
}
const measureMs = Math.round(performance.now() - started);
console.error = originalError;

/** @param {unknown} value */
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

if (UPDATE) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [file, value] of answers) writeFileSync(new URL(file, FIXTURE_DIR), serialize(value));
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test('setup: no 429, no block error, every SQLite clock stamp settled', (t) => {
  assert.deepEqual(seen429, [], 'no request ran into a rate limit');
  assert.deepEqual(blockErrors, [], 'no dashboard block fell back to its empty form through an error');
  assert.ok(settledCells > 0, 'the settle pass found the stamps it exists for');
  t.diagnostic(`settled cells: ${settledCells}, ${answers.size} answers read in ${measureMs} ms`);
});

test('the fixture directory holds exactly one file per role and form', () => {
  assert.ok(existsSync(FIXTURE_DIR), 'test/fixtures/overview-golden/ exists (UPDATE_GOLDEN=1 writes it)');
  const onDisk = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(onDisk, [...answers.keys()].sort());
});

for (const [file, value] of answers) {
  test(`golden: ${file}`, () => {
    const url = new URL(file, FIXTURE_DIR);
    assert.ok(existsSync(url), `${file} exists (UPDATE_GOLDEN=1 writes it)`);
    assert.equal(serialize(value), readFileSync(url, 'utf8'), `${file} differs from the golden master`);
  });
}

/**
 * Strings that stand in a block even when it is empty: the month of the
 * budget, the clock and zone mode of the fasting widget, the day of the
 * nutrition balance.
 */
const FRAME_KEYS = new Set(['month', 'clock_mode', 'zone_mode', 'date']);

/**
 * True when a block carries anything: a non-empty list, a non-zero number,
 * `true` or a non-empty string outside FRAME_KEYS somewhere inside.
 * @param {unknown} value
 * @param {string} [key]
 * @returns {boolean}
 */
function carries(value, key = '') {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && !FRAME_KEYS.has(key);
  if (value === true) return true;
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => carries(v, k));
  return false;
}

test('seed coverage: every dashboard block carries data for at least one role and form', () => {
  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {Set<string>} */
  const filled = new Set();
  for (const [file, value] of answers) {
    if (file.endsWith('.search.json') || value.status !== 200) continue;
    for (const [key, block] of Object.entries(value.body)) {
      keys.add(key);
      if (carries(block, key)) filled.add(key);
    }
  }
  assert.ok(keys.size > 0, 'at least one dashboard answer is a 200');
  assert.deepEqual([...keys].filter((k) => !filled.has(k)).sort(), [], 'blocks without data in any answer');
});

test('seed coverage: every search hit type is found at least once, the last query never', () => {
  /** @type {Set<string>} */
  const buckets = new Set();
  /** @type {Set<string>} */
  const hit = new Set();
  for (const [file, searches] of answers) {
    if (!file.endsWith('.search.json')) continue;
    for (const [q, res] of Object.entries(searches)) {
      if (res.status !== 200) continue;
      for (const [bucket, list] of Object.entries(res.body)) {
        buckets.add(bucket);
        if (q === NO_HIT_QUERY) assert.deepEqual(list, [], `${file} / ${q} / ${bucket} stays empty`);
        else if (Array.isArray(list) && list.length) hit.add(bucket);
      }
    }
  }
  assert.ok(buckets.size > 0, 'at least one search answer is a 200');
  assert.deepEqual([...buckets].filter((b) => !hit.has(b)).sort(), [], 'hit types never found');
});
