/**
 * Test: Admin gates - what a member, an admin and an admin's device get at every admin gate (phase 2, C1 and C2)
 * Purpose: every admin gate of the server is one row in
 *          test/admin-gates-table.js with the answer a MEMBER gets (status 403
 *          and the whole body: `error`, `code`, `reason` or its absence). C1
 *          recorded the answers as they were and moved the admin question
 *          into server/authorize/; C2 gave every pure admin gate one refusal,
 *          `403 { error: 'Admin access required.', code: 403, reason:
 *          'admin_required' }`, sent by refuseAdmin() in
 *          server/middleware/require-admin.js.
 *
 *          Measured over the REAL server (test/server-ready.js) on an
 *          in-memory database: session, CSRF, the /api/v1 gate chain and the
 *          auth router mounted before it are part of what a member meets.
 *
 *          Two more groups: an admin gets through (not 403) once per form;
 *          an admin on a signed-in device gets `device_credential` at every
 *          form (the same function sends both refusals).
 *
 *          COMPLETENESS: one case counts the gate sites in the source -
 *          `requireAdmin` as a route argument or in `router.use`, every
 *          `assertAdmin(` call, every `refuseAdmin(` call, every other 403
 *          within three lines behind a negated admin question - per file and
 *          route, and compares that multiset
 *          with the table plus its EXCEPTIONS and MIXED lists. A new gate
 *          without a row is red. PUT /preferences (C3): the gates stand in
 *          the settings registry as data, so the route's one `refuseAdmin(`
 *          counts as one site per admin field of settingsCatalog() and one
 *          per `gate` group (weather, holidays).
 *
 *          Every row sends input that is invalid or harmless where the route
 *          would act, and every request ends after a timeout: a mutant that
 *          opens the gate lets a member reach the handler, and the run has to
 *          end with that row red, not hang or wreck the rows after it.
 * Run: npm run test:admin-gates
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startTestServer, cookieHeader } from './server-ready.js';
import { withoutCommentsKeepingLines } from './source-text.js';
import { ROWS, EXCEPTIONS, MIXED, ADMIN_PASSES, DEVICE_CASES } from './admin-gates-table.js';
import { settingsCatalog } from '../server/settings/registry.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const { baseUrl: BASE } = await startTestServer({
  name: 'admin-gates',
  env: {
    SESSION_SECRET: 'test-admin-gates-secret-32-characters',
    DB_PATH: ':memory:',
    // No outbound integration may be configured from a developer's .env: a row
    // whose gate a mutant opens must end locally.
    MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', MS_REDIRECT_URI: '',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '',
  },
});

const db = (await import('../server/db.js')).get();

// --------------------------------------------------------------------------
// HTTP: one client address per request (apiLimiter keys on it), a timeout
// --------------------------------------------------------------------------

let address = 0;
/**
 * @param {string} method
 * @param {string} path
 * @param {{ headers?: Record<string, string>, body?: unknown }} [options]
 * @returns {Promise<{ status: number | string, body: any, headers?: Headers }>}
 */
async function http(method, path, { headers = {}, body } = {}) {
  address += 1;
  const xff = `10.31.${Math.floor(address / 250) % 250}.${(address % 250) + 1}`;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'X-Forwarded-For': xff, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  } catch (err) {
    return { status: `no answer (${/** @type {Error} */ (err).name})`, body: null };
  }
}

// --------------------------------------------------------------------------
// Seed: admin and member through the real routes, an admin device, the state
// the stateful gates need (straight into the database)
// --------------------------------------------------------------------------

const setup = await http('POST', '/api/v1/auth/setup', {
  body: { username: 'admin', display_name: 'Admin', password: 'admin-pass-123' },
});
assert.equal(setup.status, 201, `household setup: ${JSON.stringify(setup.body)}`);

/** @param {string} username @param {string} password */
async function login(username, password) {
  const res = await http('POST', '/api/v1/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, `login ${username}: ${JSON.stringify(res.body)}`);
  return { Cookie: cookieHeader(res.headers?.get('set-cookie')), 'X-CSRF-Token': res.body.csrfToken };
}

const adminHeaders = await login('admin', 'admin-pass-123');
// The member straight into the database, not through POST /auth/users: that
// route is itself an admin gate, and the seed must not depend on the rule the
// suite measures (under the mutant "the admin rule says no" it would refuse).
const { hashPassword } = await import('../server/utils/password.js');
const memberId = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('member', 'Member', ?, 'member', 'parent') RETURNING id
`).get(await hashPassword('member-pass-123')).id;
const memberHeaders = await login('member', 'member-pass-123');

const device = await http('POST', '/api/v1/auth/devices', {
  headers: adminHeaders,
  body: { name: 'admin phone', platform: 'ios', device_id: 'admin-gates-device' },
});
assert.equal(device.status, 201, `admin device: ${JSON.stringify(device.body)}`);
const deviceHeaders = { Authorization: `Bearer ${device.body.credential}` };

/** @type {Record<string, number>} */
const ids = {
  admin: db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id,
  member: memberId,
};

// A done task of the member whose payment visit is paid (tasks.js reopensSettledVisit,
// housekeeping.js assertMayTouchSettled).
const staff = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('helper', 'Helper', 'x', 'member') RETURNING id",
).get().id;
const worker = db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?) RETURNING id').get(staff).id;
ids.settledTask = db.prepare(`
  INSERT INTO tasks (title, status, visibility, created_by) VALUES ('settled payment', 'done', 'all', ?) RETURNING id
`).get(ids.member).id;
ids.paidVisit = db.prepare(`
  INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, created_by, worker_id, payment_task_id, paid_at)
  VALUES ('2026-01-05T08:00', '2026-01-05T12:00', 10, ?, ?, ?, '2026-01-06T00:00:00Z') RETURNING id
`).get(ids.admin, worker, ids.settledTask).id;
// Two reward redemptions of the member: one pending, and one the member
// decided itself AFTER requesting it (no auto-fulfilment): rewards.js lets only
// the decider take a decision back, and of deciders only an admin.
ids.pendingRedemption = db.prepare(`
  INSERT INTO reward_redemptions (user_id, reward_name, cost, status, requested_by) VALUES (?, 'pending', 1, 'pending', ?) RETURNING id
`).get(ids.member, ids.member).id;
ids.decidedRedemption = db.prepare(`
  INSERT INTO reward_redemptions (user_id, reward_name, cost, status, requested_by, decided_by, decided_at, created_at)
  VALUES (?, 'decided', 1, 'fulfilled', ?, ?, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z') RETURNING id
`).get(ids.member, ids.member, ids.member).id;
// A local calendar with a feed token (local-calendars.js, DELETE /calendars/:id).
ids.feedCalendar = db.prepare(`
  INSERT INTO local_calendars (name, is_default, feed_token, created_by) VALUES ('with feed', 0, 'admin-gates-feed-token', ?) RETURNING id
`).get(ids.admin).id;

const seed = { ids };

/** @param {Pick<import('./admin-gates-table.js').GateRow, 'path'>} row */
const pathOf = (row) => (typeof row.path === 'function' ? row.path(seed) : row.path);
/** @param {import('./admin-gates-table.js').GateRow} row */
const nameOf = (row) => `${row.form} ${row.file.replace(/^server\//, '')} ${row.key}${row.field ? ` [${row.field}]` : ''}`;

// --------------------------------------------------------------------------
// The cases
// --------------------------------------------------------------------------

test('an admin gets through, once per form', async () => {
  const failed = [];
  for (const c of ADMIN_PASSES) {
    const res = await http(c.method, pathOf(c), { headers: adminHeaders, body: c.body });
    if (res.status === 403 || typeof res.status !== 'number') failed.push(`${c.form} ${c.method} ${pathOf(c)}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.deepEqual(failed, []);
});

test("an admin's signed-in device: every form names the device", async () => {
  const failed = [];
  for (const c of DEVICE_CASES) {
    const res = await http(c.method, c.path, { headers: deviceHeaders });
    if (res.status !== 403 || JSON.stringify(res.body) !== JSON.stringify(c.expect)) {
      failed.push(`${c.form} ${c.method} ${c.path}: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
  assert.deepEqual(failed, []);
});

for (const row of ROWS) {
  test(`member: ${nameOf(row)}`, async () => {
    const res = await http(row.method, pathOf(row), { headers: memberHeaders, body: row.body });
    assert.deepEqual({ status: res.status, body: res.body }, { status: 403, body: row.expect },
      `${row.method} ${pathOf(row)}`);
  });
}

test('the seeded state the stateful gates read is still there', () => {
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(ids.settledTask).status, 'done');
  assert.ok(db.prepare('SELECT paid_at FROM housekeeping_work_sessions WHERE id = ?').get(ids.paidVisit).paid_at);
  assert.equal(db.prepare('SELECT status FROM reward_redemptions WHERE id = ?').get(ids.pendingRedemption).status, 'pending');
  assert.equal(db.prepare('SELECT status FROM reward_redemptions WHERE id = ?').get(ids.decidedRedemption).status, 'fulfilled');
  assert.ok(db.prepare('SELECT 1 FROM local_calendars WHERE id = ?').get(ids.feedCalendar));
});

// --------------------------------------------------------------------------
// Completeness: the gate sites in the source against the table
// --------------------------------------------------------------------------

const ROUTE_START = /\b(?:router|targetRouter|app)\.(get|post|put|patch|delete|use)\(\s*(?:\[\s*)?(?:'([^']*)')?/g;
const FUNCTION_START = /\bfunction\s+([\w$]+)\s*\(/g;
/** The definitions of a gate: their own refusal is counted at their uses. */
const GATE_DEFINITIONS = new Set(['requireAdmin', 'assertAdmin']);
/** The one refusal of an admin gate (C2): a call of it is an inline site. */
const REFUSE_CALL = /\brefuseAdmin\(/;
/**
 * Routes whose admin gates stand in the settings registry (C3): the route
 * sends the registry's `forbidden` through ONE `refuseAdmin(` call, the gates
 * themselves are data. That one text site stands for one site per admin field
 * of settingsCatalog() without a `gate` group, plus one per `gate` group
 * (weather, holidays). Without the text site the catalog sites fall too.
 */
const REGISTRY_GATE_SITES = new Set(['inline|server/routes/preferences.js|PUT /']);

/** The admin gates of the settings registry, one site per field or `gate` group. */
function catalogGateSites() {
  const admin = settingsCatalog().filter((entry) => entry.write === 'admin');
  const groups = new Set(admin.filter((entry) => entry.gate).map((entry) => entry.gate));
  return [...admin.filter((entry) => !entry.gate).map((entry) => entry.field), ...groups];
}

/** @param {string} dir */
function serverFiles(dir = join(ROOT, 'server')) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...serverFiles(full));
    else if (/\.[jt]s$/.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * The route or function an offset stands in: the later of the last route
 * start and the last function start before it.
 * @param {string} src
 * @param {number} index
 */
function enclosing(src, index) {
  let best = { at: -1, key: '' };
  for (const m of src.matchAll(ROUTE_START)) {
    if (m.index >= index) break;
    best = { at: m.index, key: `${m[1].toUpperCase()} ${m[2] ?? ''}` };
  }
  for (const m of src.matchAll(FUNCTION_START)) {
    if (m.index >= index) break;
    if (m.index > best.at) best = { at: m.index, key: `function ${m[1]}` };
  }
  return best.key;
}

/**
 * A site inside a helper function counts once per route that calls the helper
 * (one level; assertMayTouchSettled -> assertAdmin, reopenRedemption).
 * @param {string} src @param {string} key
 * @returns {string[]}
 */
function routeKeys(src, key) {
  if (!key.startsWith('function ')) return [key];
  const name = key.slice('function '.length);
  const calls = [...src.matchAll(new RegExp(`(?<!function\\s+)\\b${name}\\(`, 'g'))];
  return calls.map((m) => enclosing(src, m.index)).filter((k) => !k.startsWith('function '));
}

/** Every gate site of the server as `form|file|key`. */
function gateSites() {
  /** @type {string[]} */
  const sites = [];
  for (const full of serverFiles()) {
    const file = relative(ROOT, full).split('\\').join('/');
    if (file === 'server/middleware/require-admin.js') continue;
    const src = withoutCommentsKeepingLines(readFileSync(full, 'utf8'));
    const lines = src.split('\n');
    const lineStart = (/** @type {number} */ n) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
    for (const m of src.matchAll(/\brequireAdmin\b/g)) {
      const line = lines[src.slice(0, m.index).split('\n').length - 1];
      if (/^\s*(?:import|export)\b/.test(line) || /function\s+requireAdmin\b/.test(line)) continue;
      for (const key of routeKeys(src, enclosing(src, m.index))) sites.push(`requireAdmin|${file}|${key}`);
    }
    for (const m of src.matchAll(/\bassertAdmin\(/g)) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
      for (const key of routeKeys(src, enclosing(src, m.index))) sites.push(`assertAdmin|${file}|${key}`);
    }
    lines.forEach((line, i) => {
      if (/^\s*(?:import|export)\b/.test(line) || /function\s+refuseAdmin\b/.test(line)) return;
      if (!REFUSE_CALL.test(line)) {
        if (!/status\(403\)/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
        if (!/!\s*(?:isAdminRequest\(req\)|isAdmin\b)/.test(window)) return;
      }
      const key = enclosing(src, lineStart(i));
      if (GATE_DEFINITIONS.has(key.replace(/^function /, ''))) return;
      for (const k of routeKeys(src, key)) sites.push(`inline|${file}|${k}`);
    });
  }
  // The registry's refusal: its one text site per route becomes the catalog's sites.
  for (const site of REGISTRY_GATE_SITES) {
    const at = sites.indexOf(site);
    if (at === -1) continue;
    sites.splice(at, 1, ...catalogGateSites().map(() => site));
  }
  return sites;
}

/** @param {string[]} list */
function multiset(list) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

test('every admin gate in the source has a row (or a listed exception)', () => {
  const found = gateSites();
  assert.ok(found.length >= 140, `only ${found.length} gate sites found - the scan no longer reaches the server`);
  const listed = [...ROWS, ...EXCEPTIONS, ...MIXED].map((r) => `${r.form}|${r.file}|${r.key}`);
  const want = multiset(found);
  const have = multiset(listed);
  const problems = [];
  for (const key of new Set([...want.keys(), ...have.keys()])) {
    const w = want.get(key) ?? 0;
    const h = have.get(key) ?? 0;
    if (w > h) problems.push(`${w - h} gate site(s) without a row: ${key}`);
    if (h > w) problems.push(`${h - w} row(s) without a gate site: ${key}`);
  }
  assert.deepEqual(problems, []);
});

test('every exception and every mixed site carries a reason', () => {
  for (const entry of [...EXCEPTIONS, ...MIXED]) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length >= 20, `${entry.file} ${entry.key}: reason`);
  }
});
