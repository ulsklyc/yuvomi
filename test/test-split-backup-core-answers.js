/**
 * Test: the answers of shared expenses, backup and the core routes stay byte-equal (#2810, phase 2 section E, group 5)
 * Purpose: server/routes/split-expenses.js (28 routes), server/routes/backup.js (10),
 *          server/routes/system.js (1) and server/routes/changelog.js (1) dropped the hand
 *          checks the schema of their operation already covers (`validateRequest()` runs before
 *          every handler since #2838) and the try/catch blocks that answered an unexpected error
 *          with a 500 of their own. This suite holds that refactor: for a table of requests to all
 *          40 operations - valid, every refusal of the handler that stays (empty after trimming, a
 *          calendar day that does not exist, membership, split sums, budget categories, the guest
 *          password, the cursor rules, ids of 0 and below), every input a dropped hand check
 *          refused or silently replaced (now the schema's 400), not found, rights and conflicts,
 *          for an admin, the group owner, a group member, a household member outside the group
 *          and a split-expense guest - it pins status and the WHOLE body. The expectations were
 *          written before the refactor (8834558fa) and are literal here, no fixture file, no
 *          update mode. Values that follow a clock this suite does not hold (SQLite's own `now`
 *          in `updated_at`, `archived_at`, `paused_at`, ...), the temp folder and the port of the
 *          WebDAV stand-in are replaced by a marker; the creation stamps of the split tables are
 *          pinned by test triggers, so the lists keep their order. Diagnostics and the release
 *          notes answer with values of the machine and of CHANGELOG.md: their rows hold status
 *          and the shape of the answer only. The clock stands still (`mock.timers`, 18.11.2026
 *          12:00 UTC), the household lives in Europe/Berlin.
 *
 *          The second part: an unexpected error in every route without an own answer for it
 *          reaches the central error handler - 500 with its fixed sentence and its log line
 *          `Unhandled error: <METHOD> <pattern> -> 500` - and the process keeps answering. The one
 *          visible change: `GET /backup/database` answered `Database backup failed.`,
 *          `POST /backup/trigger` `Backup trigger failed.` and `PUT /backup/webdav/config`
 *          `Failed to save WebDAV config.`; they answer the central sentence now. Shared expenses
 *          answered that sentence already, only the log line is the central one now.
 *
 *          The third part: what stays the route's own - `Refusal` and `SplitInputError` with
 *          their sentence and reason, `backup_verify_failed`, `backup_local_failed`, the 502 of
 *          the WebDAV server, the restore reasons and the WebDAV `errorCode`s.
 * Run: npm run test:split-backup-core-answers
 */

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { tempDir } from './tmp-dir.js';

// Backup and restore need a file database, and a folder of their own.
const TMP_ROOT = tempDir('yuvomi-split-backup-answers-');
fs.mkdirSync(path.join(TMP_ROOT, 'db'));
fs.mkdirSync(path.join(TMP_ROOT, 'backups'));
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = path.join(TMP_ROOT, 'db', 'oikos.db');
process.env.BACKUP_DIR = path.join(TMP_ROOT, 'backups');
process.env.BACKUP_UPLOAD_LIMIT = '4mb';
delete process.env.DB_ENCRYPTION_KEY;
for (const key of ['WEBDAV_BACKUP_ENABLED', 'WEBDAV_BACKUP_URL', 'WEBDAV_BACKUP_USERNAME', 'WEBDAV_BACKUP_PASSWORD', 'WEBDAV_BACKUP_PATH', 'WEBDAV_BACKUP_KEEP']) {
  delete process.env[key];
}

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');
const { default: backupRouter } = await import('../server/routes/backup.js');
const { default: systemRouter } = await import('../server/routes/system.js');
const { buildRouter: buildChangelogRouter } = await import('../server/routes/changelog.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { MAX_TITLE, MAX_TEXT } = await import('../server/middleware/validate.js');
const { MAX_GUEST_NAME, MAX_GUEST_PHONE, MAX_GUEST_EMAIL } = await import('../server/services/split-expense-fields.js');
const database = () => dbmod.get();

database().prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });
// A new guest gets a random avatar color: always the first of the list here.
mock.method(Math, 'random', () => 0);

// SQLite stamps rows with its own clock, which mock.timers does not reach. The
// lists sort by these stamps; a test trigger pins them, so the order is the
// insertion order on every run. The update triggers of the schema are
// replaced by ones that write the same fixed stamp.
const STAMP = '2026-11-18T12:00:00Z';
for (const table of ['expense_groups', 'expense_group_members', 'expenses', 'expense_comments', 'expense_activity', 'expense_ledger_entries', 'settlements', 'recurring_expenses']) {
  const columns = database().prepare(`PRAGMA table_info(${table})`).all().map((/** @type {any} */ c) => c.name);
  const sets = ['created_at', 'updated_at', 'joined_at'].filter((c) => columns.includes(c)).map((c) => `${c} = '${STAMP}'`).join(', ');
  database().exec(`CREATE TRIGGER test_pin_${table} AFTER INSERT ON ${table} FOR EACH ROW BEGIN UPDATE ${table} SET ${sets} WHERE rowid = NEW.rowid; END;`);
}
for (const table of ['expense_groups', 'expenses', 'settlements', 'recurring_expenses']) {
  database().exec(`DROP TRIGGER IF EXISTS trg_${table}_updated_at;
    CREATE TRIGGER trg_${table}_updated_at AFTER UPDATE ON ${table} FOR EACH ROW
    BEGIN UPDATE ${table} SET updated_at = '${STAMP}' WHERE id = OLD.id; END;`);
}

/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, 'parent')")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const OWNER = user('tom', 'member');
const MEM = user('mia', 'member');
const OUT = user('ole', 'member');
const MISSING = 987654;

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  owner: { id: OWNER, role: 'member' },
  mem: { id: MEM, role: 'member' },
  out: { id: OUT, role: 'member' },
};

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

// The WebDAV server: a local stand-in, never the network. It answers by method.
/** @type {string[]} */
const davSeen = [];
const davServer = http.createServer((req, res) => {
  davSeen.push(String(req.method));
  req.resume();
  req.on('end', () => {
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/backups/yuvomi-backup-2026-01-01T00-00-00-000Z.db</D:href>'
        + '<D:propstat><D:prop><D:resourcetype/><D:getlastmodified>Wed, 01 Jan 2026 00:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response></D:multistatus>');
      return;
    }
    if (req.method === 'PUT' || req.method === 'MKCOL') { res.writeHead(201); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    res.writeHead(200); res.end();
  });
});
davServer.listen(0, '127.0.0.1');
/** @type {string} */
const davOrigin = await new Promise((r) => davServer.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (davServer.address()).port}`)));
assert.equal(new URL(`${davOrigin}/backups/`).origin, davOrigin, 'the stand-in is exactly this origin');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read. An actor is a name of
// ACTORS or a user id (a split guest).
app.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
  const name = req.get('x-actor') ?? 'admin';
  const actor = ACTORS[name] ?? { id: Number(name), role: 'member' };
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = 'session';
  req.authScopes = null;
  req.session = { userId: actor.id, role: actor.role };
  req.sessionModuleAccess = null;
  // An unexpected error: the first answer of the handler throws - a JSON
  // answer, an empty one, or the download of the backup.
  if (req.get('x-fail') === 'answer') {
    let thrown = false;
    for (const name of ['json', 'end', 'download']) {
      const original = res[name];
      res[name] = function (/** @type {unknown[]} */ ...args) {
        if (!thrown) { thrown = true; throw new Error(`${name} broke`); }
        return original.apply(this, args);
      };
    }
  }
  next();
});
// The mounts of server/index.js, in its order. The changelog router is the
// real one, built with a fetch that fails, so it answers from CHANGELOG.md.
app.use('/api/v1/changelog', buildChangelogRouter({ fetchFn: async () => { throw new Error('offline'); }, appVersion: '0.0.0-test' }));
app.use('/api/v1/split-expenses', splitRouter);
app.use('/api/v1/backup', backupRouter);
app.use('/api/v1/system', systemRouter);
app.use(createErrorHandler(log));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => { server.close(); davServer.closeAllConnections?.(); davServer.close(); });

const NO_BODY = Symbol('no body');

/** @typedef {{ actor?: string | number, fail?: boolean, raw?: Buffer, headers?: Record<string, string>, shape?: boolean }} CallOptions */

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {unknown} body a JSON value or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, route, body, { actor, fail, raw, headers: extra } = {}) {
  /** @type {Record<string, string>} */
  const headers = { ...extra };
  /** @type {any} */
  let payload;
  if (raw !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = raw;
  } else if (body !== NO_BODY) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (actor !== undefined) headers['x-actor'] = String(actor);
  if (fail) headers['x-fail'] = 'answer';
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: payload });
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: bytes.length === 0 ? null : `<${bytes.subarray(0, 15).toString('latin1')}>` };
  }
  return { status: res.status, body: JSON.parse(await res.text()) };
}

// Stamps of SQLite's own clock that the triggers above do not pin, and the
// machine's folder and the stand-in's port.
const VOLATILE = new Set(['updated_at', 'archived_at', 'deleted_at', 'paused_at', 'reversed_at', 'created_at', 'paid_at']);
const PINNED = new Set([STAMP]);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (VOLATILE.has(key) && typeof v === 'string' && !PINNED.has(v)) return '<volatile>';
    // Grows with every migration, not with this refactor.
    if (key === 'schema_version' && typeof v === 'number') return '<schema version>';
    // The backup schedule runs on the wall clock of the process: TZ, else UTC.
    if (key === 'timezone' && v === (process.env.TZ || 'UTC')) return '<process zone>';
    if (typeof v !== 'string') return v;
    return v.split(TMP_ROOT).join('<tmp>').split(davOrigin).join('<dav>');
  });
}

/**
 * The shape of an answer: its keys two levels deep, with the type of each
 * value - not the values, which follow the machine and CHANGELOG.md.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function shapeOf(value, depth = 0) {
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') {
    if (depth >= 2) return 'object';
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(/** @type {any} */ (value)[k], depth + 1)]));
  }
  return value === null ? 'null' : typeof value;
}

// ── Seed and rows ──

/** Ids that exist only once their row ran, filled by setup rows. @type {Record<string, number>} */
const ids = {};
const lastId = (/** @type {string} */ table) => database().prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`).get().id;
const BUDGET_KEY = database().prepare("SELECT key FROM budget_categories WHERE type = 'expense' ORDER BY sort_order, key LIMIT 1").get().key;
const LONG = (/** @type {number} */ n) => 'x'.repeat(n);
const SPACES = '   ';
const EXPENSE = (/** @type {Record<string, unknown>} */ over = {}) => ({
  title: 'Einkauf', amount: '30.00', payer_id: OWNER, participants: [OWNER, MEM], split_method: 'equal', category: 'groceries', expense_date: '2026-11-10', ...over,
});
// PUT /expenses/{id} takes the whole expense (#2810): the fields a row leaves
// out get the value leaving them out stood for up to v2.93 (no note, no
// exchange snapshot, converted = entered, `equal`, today), so every answer
// below stays the one written before the refactor.
const REPLACE = { description: null, currency: 'EUR', converted_amount: null, converted_currency: 'EUR', exchange_snapshot: null, split_method: 'equal', expense_date: '' };
const EXPENSE_PUT = (/** @type {Record<string, unknown>} */ over = {}) => ({ ...REPLACE, ...EXPENSE(over) });
const RECURRING = (/** @type {Record<string, unknown>} */ over = {}) => ({
  title: 'Miete', amount: '500.00', frequency: 'monthly', next_run_date: '2026-12-01', participants: [OWNER, MEM], ...over,
});
const SETTLE = (/** @type {Record<string, unknown>} */ over = {}) => ({ payer_id: MEM, payee_id: OWNER, amount: '10.00', ...over });
const GUEST_BODY = (/** @type {Record<string, unknown>} */ over = {}) => ({ display_name: 'Gast', password: 'geheim123', ...over });
const DAV = () => ({ enabled: true, url: davOrigin, username: 'dav', password: 's3cret', remotePath: '/backups/', keep: 7 });

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ SPLIT: meta, groups ════════════════════════════════════════════════════
  ['meta', 'GET', '/split-expenses/meta', NO_BODY],
  ['meta guest-less member', 'GET', '/split-expenses/meta', NO_BODY, { actor: 'out' }],
  ['dashboard empty', 'GET', '/split-expenses/dashboard', NO_BODY, { actor: 'owner' }],
  ['g create', 'POST', '/split-expenses/groups', { name: ' WG ', description: 'Wohnung', type: 'household', default_currency: 'EUR', default_split_method: 'equal' }, { actor: 'owner' }],
  () => { ids.g1 = lastId('expense_groups'); },
  ['g create defaults', 'POST', '/split-expenses/groups', { name: 'Reise' }, { actor: 'owner' }],
  () => { ids.g2 = lastId('expense_groups'); },
  ['g create usd shares', 'POST', '/split-expenses/groups', { name: 'Urlaub', type: 'travel', default_currency: 'USD', default_split_method: 'shares' }, { actor: 'admin' }],
  () => { ids.g3 = lastId('expense_groups'); },
  ['g create spaces', 'POST', '/split-expenses/groups', { name: SPACES }, { actor: 'owner' }],
  ['g create no name', 'POST', '/split-expenses/groups', { description: 'x' }, { actor: 'owner' }],
  ['g create empty name', 'POST', '/split-expenses/groups', { name: '' }, { actor: 'owner' }],
  ['g create long name', 'POST', '/split-expenses/groups', { name: LONG(MAX_TITLE + 1) }, { actor: 'owner' }],
  ['g create long padded name', 'POST', '/split-expenses/groups', { name: ` ${LONG(MAX_TITLE)} ` }, { actor: 'owner' }],
  ['g create long description', 'POST', '/split-expenses/groups', { name: 'X', description: LONG(MAX_TEXT + 1) }, { actor: 'owner' }],
  ['g create name number', 'POST', '/split-expenses/groups', { name: 5 }, { actor: 'owner' }],
  ['g create no body', 'POST', '/split-expenses/groups', NO_BODY, { actor: 'owner' }],
  ['g create type unknown', 'POST', '/split-expenses/groups', { name: 'X', type: 'trip' }, { actor: 'owner' }],
  ['g create type null', 'POST', '/split-expenses/groups', { name: 'X', type: null }, { actor: 'owner' }],
  ['g create type empty', 'POST', '/split-expenses/groups', { name: 'X', type: '' }, { actor: 'owner' }],
  ['g create currency unknown', 'POST', '/split-expenses/groups', { name: 'X', default_currency: 'XXX' }, { actor: 'owner' }],
  ['g create currency lower', 'POST', '/split-expenses/groups', { name: 'X', default_currency: 'eur' }, { actor: 'owner' }],
  ['g create currency null', 'POST', '/split-expenses/groups', { name: 'X', default_currency: null }, { actor: 'owner' }],
  ['g create currency proto', 'POST', '/split-expenses/groups', { name: 'X', default_currency: 'constructor' }, { actor: 'owner' }],
  ['g create method unknown', 'POST', '/split-expenses/groups', { name: 'X', default_split_method: 'half' }, { actor: 'owner' }],
  ['g create method null', 'POST', '/split-expenses/groups', { name: 'X', default_split_method: null }, { actor: 'owner' }],
  ['g list', 'GET', '/split-expenses/groups', NO_BODY, { actor: 'owner' }],
  ['g list admin', 'GET', '/split-expenses/groups', NO_BODY],
  ['g list out', 'GET', '/split-expenses/groups', NO_BODY, { actor: 'out' }],
  ['g list q', 'GET', '/split-expenses/groups?q=%20WG%20', NO_BODY, { actor: 'owner' }],
  ['g list q doubled', 'GET', '/split-expenses/groups?q=a&q=b', NO_BODY, { actor: 'owner' }],
  ['g list status active', 'GET', '/split-expenses/groups?status=active', NO_BODY, { actor: 'owner' }],
  ['g list status deleted', 'GET', '/split-expenses/groups?status=deleted', NO_BODY, { actor: 'owner' }],
  ['g list status empty', 'GET', '/split-expenses/groups?status=', NO_BODY, { actor: 'owner' }],
  ['g patch type', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { type: 'couple' }, { actor: 'owner' }],
  ['g patch type unknown', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { type: 'trip' }, { actor: 'owner' }],
  ['g patch type null', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { type: null }, { actor: 'owner' }],
  ['g patch currency', 'PATCH', () => `/split-expenses/groups/${ids.g2}`, { default_currency: 'CHF' }, { actor: 'owner' }],
  ['g patch currency unknown', 'PATCH', () => `/split-expenses/groups/${ids.g2}`, { default_currency: 'XXX' }, { actor: 'owner' }],
  ['g patch currency proto', 'PATCH', () => `/split-expenses/groups/${ids.g2}`, { default_currency: '__proto__' }, { actor: 'owner' }],
  ['g patch method unknown', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { default_split_method: 'half' }, { actor: 'owner' }],
  ['g patch method null', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { default_split_method: null }, { actor: 'owner' }],
  ['g patch config only', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { default_split_config: [{ user_id: OWNER, shares: 2 }] }, { actor: 'owner' }],
  ['g patch name spaces', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { name: SPACES }, { actor: 'owner' }],
  ['g patch name long', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { name: LONG(MAX_TITLE + 1) }, { actor: 'owner' }],
  ['g patch description null', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { description: null }, { actor: 'owner' }],
  ['g patch description back', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { description: ' Wohnung ' }, { actor: 'owner' }],
  ['g patch empty', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, {}, { actor: 'owner' }],
  ['g patch no body', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, NO_BODY, { actor: 'owner' }],
  ['g patch missing', 'PATCH', `/split-expenses/groups/${MISSING}`, { name: 'X' }, { actor: 'owner' }],
  ['g patch zero', 'PATCH', '/split-expenses/groups/0', { name: 'X' }, { actor: 'owner' }],
  ['g patch negative', 'PATCH', '/split-expenses/groups/-1', { name: 'X' }, { actor: 'owner' }],
  ['g patch minus zero', 'PATCH', '/split-expenses/groups/-0', { name: 'X' }, { actor: 'owner' }],
  ['g patch leading zero', 'PATCH', () => `/split-expenses/groups/00${ids.g2}`, { name: 'Reise' }, { actor: 'owner' }],
  ['g patch letters', 'PATCH', '/split-expenses/groups/abc', { name: 'X' }, { actor: 'owner' }],
  ['g patch hex', 'PATCH', '/split-expenses/groups/0x10', { name: 'X' }, { actor: 'owner' }],
  ['g patch out', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { name: 'X' }, { actor: 'out' }],
  ['g patch admin', 'PATCH', () => `/split-expenses/groups/${ids.g2}`, { name: 'Reise' }, { actor: 'admin' }],

  // ══ SPLIT: members, candidates, guests ═════════════════════════════════════
  ['m add', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: MEM }, { actor: 'owner' }],
  ['m add g2', 'POST', () => `/split-expenses/groups/${ids.g2}/members`, { user_id: String(MEM), role: 'guest' }, { actor: 'owner' }],
  ['m add role admin', 'POST', () => `/split-expenses/groups/${ids.g3}/members`, { user_id: OWNER, role: 'admin' }, { actor: 'admin' }],
  ['m add role owner', 'POST', () => `/split-expenses/groups/${ids.g3}/members`, { user_id: MEM, role: 'owner' }, { actor: 'admin' }],
  ['m add role unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: MEM, role: 'boss' }, { actor: 'owner' }],
  ['m add role null', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: MEM, role: null }, { actor: 'owner' }],
  ['m add user zero', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: 0 }, { actor: 'owner' }],
  ['m add user zero text', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: '0' }, { actor: 'owner' }],
  ['m add user negative', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: -3 }, { actor: 'owner' }],
  ['m add user letters', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: '7abc' }, { actor: 'owner' }],
  ['m add user fraction', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: 1.5 }, { actor: 'owner' }],
  ['m add user missing', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: MISSING }, { actor: 'owner' }],
  ['m add contact missing', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { contact_id: MISSING }, { actor: 'owner' }],
  ['m add empty', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, {}, { actor: 'owner' }],
  ['m add no body', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, NO_BODY, { actor: 'owner' }],
  ['m add by member', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: OUT }, { actor: 'mem' }],
  ['m add by out', 'POST', () => `/split-expenses/groups/${ids.g1}/members`, { user_id: OUT }, { actor: 'out' }],
  ['m add group zero', 'POST', '/split-expenses/groups/0/members', { user_id: OUT }, { actor: 'owner' }],
  ['m list', 'GET', () => `/split-expenses/groups/${ids.g1}/members`, NO_BODY, { actor: 'mem' }],
  ['m list out', 'GET', () => `/split-expenses/groups/${ids.g1}/members`, NO_BODY, { actor: 'out' }],
  ['m list missing', 'GET', `/split-expenses/groups/${MISSING}/members`, NO_BODY],
  ['m list negative', 'GET', '/split-expenses/groups/-4/members', NO_BODY],
  ['mc list', 'GET', () => `/split-expenses/groups/${ids.g1}/member-candidates`, NO_BODY, { actor: 'owner' }],
  ['mc list out', 'GET', () => `/split-expenses/groups/${ids.g1}/member-candidates`, NO_BODY, { actor: 'out' }],
  ['mc list zero', 'GET', '/split-expenses/groups/0/member-candidates', NO_BODY],
  ['gu create', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ family_role: 'child', birth_date: '2010-05-01', phone: ' 0123 ', email: 'gast@example.test' }), { actor: 'owner' }],
  () => { ids.guest = Number(database().prepare("SELECT id FROM users WHERE display_name = 'Gast'").get().id); },
  ['gu create username', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ display_name: 'Zweiter Gast', username: 'gast.zwei' }), { actor: 'owner' }],
  ['gu create username taken', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ display_name: 'Dritter', username: 'gast.zwei' }), { actor: 'owner' }],
  ['gu create username short', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ display_name: 'Kurz Name', username: 'ab' }), { actor: 'owner' }],
  ['gu create username null', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ display_name: 'Ohne Name', username: null }), { actor: 'owner' }],
  ['gu create family unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ family_role: 'uncle' }), { actor: 'owner' }],
  ['gu create family null', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ family_role: null }), { actor: 'owner' }],
  ['gu create password short', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ password: 'kurz' }), { actor: 'owner' }],
  ['gu create password empty', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ password: '' }), { actor: 'owner' }],
  ['gu create password object', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ password: {} }), { actor: 'owner' }],
  ['gu create password missing', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, { display_name: 'X' }, { actor: 'owner' }],
  ['gu create name spaces', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ display_name: SPACES }), { actor: 'owner' }],
  ['gu create name long', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ display_name: LONG(MAX_GUEST_NAME + 1) }), { actor: 'owner' }],
  ['gu create phone long', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ phone: LONG(MAX_GUEST_PHONE + 1) }), { actor: 'owner' }],
  ['gu create email long', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ email: LONG(MAX_GUEST_EMAIL + 1) }), { actor: 'owner' }],
  ['gu create birth not a day', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY({ birth_date: '2010-02-30' }), { actor: 'owner' }],
  ['gu create by member', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, GUEST_BODY(), { actor: 'mem' }],
  ['gu create missing group', 'POST', `/split-expenses/groups/${MISSING}/guests`, GUEST_BODY(), { actor: 'owner' }],
  ['gu create no body', 'POST', () => `/split-expenses/groups/${ids.g1}/guests`, NO_BODY, { actor: 'owner' }],
  ['g create by guest', 'POST', '/split-expenses/groups', { name: 'Gastgruppe' }, { actor: 'GUEST' }],
  ['g create by guest broken', 'POST', '/split-expenses/groups', { name: 5 }, { actor: 'GUEST' }],
  ['g list guest', 'GET', '/split-expenses/groups', NO_BODY, { actor: 'GUEST' }],
  ['mc list guest', 'GET', () => `/split-expenses/groups/${ids.g1}/member-candidates`, NO_BODY, { actor: 'GUEST' }],
  ['g patch guest', 'PATCH', () => `/split-expenses/groups/${ids.g1}`, { name: 'X' }, { actor: 'GUEST' }],

  // ══ SPLIT: expenses ════════════════════════════════════════════════════════
  ['e create', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE(), { actor: 'owner' }],
  () => { ids.e1 = lastId('expenses'); },
  ['e create defaults', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, { title: 'Brot', amount: '3.20' }, { actor: 'mem' }],
  () => { ids.e2 = lastId('expenses'); },
  ['e create usd converted', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: 'Kino', currency: 'USD', amount: '20.00', converted_amount: '18.50', converted_currency: 'EUR', expense_date: '2026-11-11' }), { actor: 'owner' }],
  ['e create usd only', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: 'Snack', currency: 'USD', amount: '4.00', expense_date: '2026-11-11' }), { actor: 'owner' }],
  ['e create jpy decimals', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ currency: 'JPY', amount: '100.5' }), { actor: 'owner' }],
  ['e create exact', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: 'Strom', amount: '40.00', split_method: 'exact', splits: [{ user_id: OWNER, amount: '25.00' }, { user_id: MEM, amount: '15.00' }], budget_category: BUDGET_KEY, expense_date: '2026-11-09' }), { actor: 'owner' }],
  ['e create exact wrong sum', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ split_method: 'exact', splits: [{ user_id: OWNER, amount: '1.00' }, { user_id: MEM, amount: '1.00' }] }), { actor: 'owner' }],
  ['e create shares', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: 'Wasser', amount: '9.00', split_method: 'shares', splits: [{ user_id: OWNER, shares: 2 }, { user_id: String(MEM), shares: 1 }], expense_date: '2026-11-08' }), { actor: 'owner' }],
  ['e create shares zero', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ split_method: 'shares', splits: [{ user_id: OWNER, shares: 0 }, { user_id: MEM, shares: 1 }] }), { actor: 'owner' }],
  ['e create percentage', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: 'Gas', amount: '10.00', split_method: 'percentage', splits: [{ user_id: OWNER, percentage: '70' }, { user_id: MEM, percentage: '30' }], expense_date: '2026-11-07' }), { actor: 'owner' }],
  ['e create currency unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ currency: 'XXX' }), { actor: 'owner' }],
  ['e create currency proto', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ currency: 'toString' }), { actor: 'owner' }],
  ['e create converted unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ converted_currency: 'xyz' }), { actor: 'owner' }],
  ['e create method unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ split_method: 'half' }), { actor: 'owner' }],
  ['e create method proto', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ split_method: 'constructor' }), { actor: 'owner' }],
  ['e create category unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ category: 'casino' }), { actor: 'owner' }],
  ['e create category null', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ category: null }), { actor: 'owner' }],
  ['e create amount number', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ amount: 12.5 }), { actor: 'owner' }],
  ['e create amount zero', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ amount: '0' }), { actor: 'owner' }],
  ['e create amount negative', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ amount: '-1.00' }), { actor: 'owner' }],
  ['e create amount places', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ amount: '1.234' }), { actor: 'owner' }],
  ['e create title spaces', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: SPACES }), { actor: 'owner' }],
  ['e create title long', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: LONG(MAX_TITLE + 1) }), { actor: 'owner' }],
  ['e create description long', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ description: LONG(MAX_TEXT + 1) }), { actor: 'owner' }],
  ['e create date not a day', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ expense_date: '2026-02-30' }), { actor: 'owner' }],
  ['e create date empty', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: 'Heute', expense_date: '' }), { actor: 'owner' }],
  ['e create payer out', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ payer_id: OUT }), { actor: 'owner' }],
  ['e create payer zero', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ title: 'Zahler null', payer_id: 0, expense_date: '2026-11-06' }), { actor: 'owner' }],
  ['e create payer zero text', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ payer_id: '0' }), { actor: 'owner' }],
  ['e create payer negative', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ payer_id: -2 }), { actor: 'owner' }],
  ['e create payer letters', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ payer_id: 'x' }), { actor: 'owner' }],
  ['e create participants text', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ participants: String(MEM) }), { actor: 'owner' }],
  ['e create participants null', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ participants: null }), { actor: 'owner' }],
  ['e create participants out', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ participants: [OWNER, OUT] }), { actor: 'owner' }],
  ['e create participants empty', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ participants: [] }), { actor: 'owner' }],
  ['e create budget unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ budget_category: 'nope' }), { actor: 'owner' }],
  ['e create attachments missing', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ attachment_document_ids: [MISSING] }), { actor: 'owner' }],
  ['e create attachments null', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE({ attachment_document_ids: null }), { actor: 'owner' }],
  ['e create no body', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, NO_BODY, { actor: 'owner' }],
  ['e create out', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, EXPENSE(), { actor: 'out' }],
  ['e create missing group', 'POST', `/split-expenses/groups/${MISSING}/expenses`, EXPENSE(), { actor: 'owner' }],
  ['e create group zero', 'POST', '/split-expenses/groups/0/expenses', EXPENSE(), { actor: 'owner' }],
  ['e create guest', 'POST', () => `/split-expenses/groups/${ids.g1}/expenses`, () => EXPENSE({ title: 'Vom Gast', payer_id: ids.guest, participants: [ids.guest, OWNER], expense_date: '2026-11-05' }), { actor: 'GUEST' }],
  ['e list', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses`, NO_BODY, { actor: 'owner' }],
  ['e list guest', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?limit=2`, NO_BODY, { actor: 'GUEST' }],
  ['e list out', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses`, NO_BODY, { actor: 'out' }],
  ['e list limit 2', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?limit=2`, NO_BODY, { actor: 'owner' }],
  ['e list limit 0', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?limit=0`, NO_BODY, { actor: 'owner' }],
  ['e list limit 150', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?limit=150`, NO_BODY, { actor: 'owner' }],
  ['e list limit negative', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?limit=-5&offset=1`, NO_BODY, { actor: 'owner' }],
  ['e list limit letters', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?limit=abc`, NO_BODY, { actor: 'owner' }],
  ['e list offset negative', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?offset=-3&limit=1`, NO_BODY, { actor: 'owner' }],
  ['e list offset 2', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?offset=2&limit=2`, NO_BODY, { actor: 'owner' }],
  ['e list category', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?category=groceries`, NO_BODY, { actor: 'owner' }],
  ['e list category unknown', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?category=casino`, NO_BODY, { actor: 'owner' }],
  ['e list category doubled', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?category=general&category=rent`, NO_BODY, { actor: 'owner' }],
  ['e list budget', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?budget_category=${BUDGET_KEY}`, NO_BODY, { actor: 'owner' }],
  ['e list budget none', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?budget_category=none&limit=1`, NO_BODY, { actor: 'owner' }],
  ['e list budget unknown', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?budget_category=nope&limit=1`, NO_BODY, { actor: 'owner' }],
  ['e list budget empty', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?budget_category=&limit=1`, NO_BODY, { actor: 'owner' }],
  ['e list recurring 1', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?recurring=1`, NO_BODY, { actor: 'owner' }],
  ['e list recurring 0', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?recurring=0`, NO_BODY, { actor: 'owner' }],
  ['e list q', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?q=%20Kino%20`, NO_BODY, { actor: 'owner' }],
  ['e list cursor', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?before_date=2026-11-10&before_at=${STAMP}&before_id=${ids.e1}&limit=2`, NO_BODY, { actor: 'owner' }],
  ['e list cursor half', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?before_date=2026-11-10&before_id=${ids.e1}`, NO_BODY, { actor: 'owner' }],
  ['e list cursor empty part', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?before_date=&before_at=x&before_id=5`, NO_BODY, { actor: 'owner' }],
  ['e list cursor id zero', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?before_date=a&before_at=b&before_id=0`, NO_BODY, { actor: 'owner' }],
  ['e list cursor id letters', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?before_date=a&before_at=b&before_id=x`, NO_BODY, { actor: 'owner' }],
  ['e list cursor id empty', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?before_date=a&before_at=b&before_id=`, NO_BODY, { actor: 'owner' }],
  ['e list cursor long', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?before_date=a&before_at=${LONG(65)}&before_id=5`, NO_BODY, { actor: 'owner' }],
  ['e list cursor and offset', 'GET', () => `/split-expenses/groups/${ids.g1}/expenses?before_date=a&before_at=b&before_id=5&offset=1`, NO_BODY, { actor: 'owner' }],
  ['e list missing', 'GET', `/split-expenses/groups/${MISSING}/expenses`, NO_BODY, { actor: 'owner' }],
  ['e list zero', 'GET', '/split-expenses/groups/0/expenses', NO_BODY, { actor: 'owner' }],
  ['e put', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ title: 'Einkauf groß', amount: '32.00', description: 'Markt' }), { actor: 'owner' }],
  ['e put category null', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ category: null }), { actor: 'owner' }],
  ['e put category absent', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, { ...REPLACE, title: 'Einkauf', amount: '30.00', expense_date: '2026-11-10' }, { actor: 'owner' }],
  ['e put category unknown', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ category: 'casino' }), { actor: 'owner' }],
  ['e put currency unknown', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ currency: 'XXX' }), { actor: 'owner' }],
  ['e put currency usd', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ currency: 'USD', converted_amount: '28.00', converted_currency: 'EUR' }), { actor: 'owner' }],
  ['e put converted unknown', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ converted_currency: 'XXX' }), { actor: 'owner' }],
  ['e put method unknown', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ split_method: 'half' }), { actor: 'owner' }],
  ['e put participants text', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ participants: 'all' }), { actor: 'owner' }],
  ['e put participants absent', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, { ...REPLACE, title: 'Einkauf', amount: '30.00', payer_id: OWNER, category: 'groceries', expense_date: '2026-11-10' }, { actor: 'owner' }],
  ['e put payer out', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ payer_id: OUT }), { actor: 'owner' }],
  ['e put payer zero', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ payer_id: 0 }), { actor: 'owner' }],
  ['e put budget keep', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ budget_category: '' }), { actor: 'owner' }],
  ['e put budget unknown', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ budget_category: 'nope' }), { actor: 'owner' }],
  ['e put attachments null', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ attachment_document_ids: null }), { actor: 'owner' }],
  ['e put attachments empty', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ attachment_document_ids: [] }), { actor: 'owner' }],
  ['e put title spaces', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ title: SPACES }), { actor: 'owner' }],
  ['e put date not a day', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT({ expense_date: '2026-13-01' }), { actor: 'owner' }],
  ['e put no body', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, NO_BODY, { actor: 'owner' }],
  ['e put by member', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT(), { actor: 'mem' }],
  ['e put own by member', 'PUT', () => `/split-expenses/expenses/${ids.e2}`, { ...REPLACE, title: 'Brot', amount: '3.40' }, { actor: 'mem' }],
  ['e put by out', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT(), { actor: 'out' }],
  ['e put by guest', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT(), { actor: 'GUEST' }],
  ['e put missing', 'PUT', `/split-expenses/expenses/${MISSING}`, EXPENSE_PUT(), { actor: 'owner' }],
  ['e put zero', 'PUT', '/split-expenses/expenses/0', EXPENSE_PUT(), { actor: 'owner' }],
  ['e put negative', 'PUT', '/split-expenses/expenses/-1', EXPENSE_PUT(), { actor: 'owner' }],
  ['e put admin', 'PUT', () => `/split-expenses/expenses/${ids.e1}`, EXPENSE_PUT(), { actor: 'admin' }],
  ['c add', 'POST', () => `/split-expenses/expenses/${ids.e1}/comments`, { comment: ' Danke ' }, { actor: 'mem' }],
  ['c add spaces', 'POST', () => `/split-expenses/expenses/${ids.e1}/comments`, { comment: SPACES }, { actor: 'mem' }],
  ['c add empty', 'POST', () => `/split-expenses/expenses/${ids.e1}/comments`, { comment: '' }, { actor: 'mem' }],
  ['c add long', 'POST', () => `/split-expenses/expenses/${ids.e1}/comments`, { comment: LONG(MAX_TEXT + 1) }, { actor: 'mem' }],
  ['c add number', 'POST', () => `/split-expenses/expenses/${ids.e1}/comments`, { comment: 5 }, { actor: 'mem' }],
  ['c add no body', 'POST', () => `/split-expenses/expenses/${ids.e1}/comments`, NO_BODY, { actor: 'mem' }],
  ['c add out', 'POST', () => `/split-expenses/expenses/${ids.e1}/comments`, { comment: 'x' }, { actor: 'out' }],
  ['c add missing', 'POST', `/split-expenses/expenses/${MISSING}/comments`, { comment: 'x' }, { actor: 'mem' }],
  ['c add zero', 'POST', '/split-expenses/expenses/0/comments', { comment: 'x' }, { actor: 'mem' }],
  ['b balances', 'GET', () => `/split-expenses/groups/${ids.g1}/balances`, NO_BODY, { actor: 'mem' }],
  ['b balances out', 'GET', () => `/split-expenses/groups/${ids.g1}/balances`, NO_BODY, { actor: 'out' }],
  ['b balances zero', 'GET', '/split-expenses/groups/0/balances', NO_BODY],

  // ══ SPLIT: settlements, activity ═══════════════════════════════════════════
  ['s create', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ notes: ' bar ' }), { actor: 'owner' }],
  () => { ids.s1 = lastId('settlements'); },
  ['s create by member', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ amount: '2.00', payer_id: String(MEM), currency: 'EUR' }), { actor: 'mem' }],
  () => { ids.s2 = lastId('settlements'); },
  ['s create currency unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ currency: 'XXX' }), { actor: 'owner' }],
  ['s create currency usd', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ currency: 'USD', amount: '1.00' }), { actor: 'owner' }],
  ['s create same person', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ payee_id: MEM }), { actor: 'owner' }],
  ['s create payer out', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ payer_id: OUT }), { actor: 'owner' }],
  ['s create payer zero', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ payer_id: 0 }), { actor: 'owner' }],
  ['s create payer negative', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ payer_id: -1 }), { actor: 'owner' }],
  ['s create payer letters', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ payer_id: 'mia' }), { actor: 'owner' }],
  ['s create amount number', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ amount: 10 }), { actor: 'owner' }],
  ['s create amount zero', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ amount: '0.00' }), { actor: 'owner' }],
  ['s create notes long', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ notes: LONG(MAX_TEXT + 1) }), { actor: 'owner' }],
  ['s create proof missing', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ amount: '0.50', proof_document_id: MISSING }), { actor: 'owner' }],
  ['s create proof letters', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE({ proof_document_id: 'x' }), { actor: 'owner' }],
  ['s create no payee', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, { payer_id: MEM, amount: '1.00' }, { actor: 'owner' }],
  ['s create no body', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, NO_BODY, { actor: 'owner' }],
  ['s create out', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements`, SETTLE(), { actor: 'out' }],
  ['s reverse by member', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements/${ids.s1}/reverse`, NO_BODY, { actor: 'mem' }],
  ['s reverse', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements/${ids.s1}/reverse`, NO_BODY, { actor: 'owner' }],
  ['s reverse again', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements/${ids.s1}/reverse`, NO_BODY, { actor: 'owner' }],
  ['s reverse own by member', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements/${ids.s2}/reverse`, {}, { actor: 'mem' }],
  ['s reverse missing', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements/${MISSING}/reverse`, NO_BODY, { actor: 'owner' }],
  ['s reverse zero', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements/0/reverse`, NO_BODY, { actor: 'owner' }],
  ['s reverse other group', 'POST', () => `/split-expenses/groups/${ids.g2}/settlements/${ids.s2}/reverse`, NO_BODY, { actor: 'owner' }],
  ['s reverse out', 'POST', () => `/split-expenses/groups/${ids.g1}/settlements/${ids.s2}/reverse`, NO_BODY, { actor: 'out' }],
  ['a list', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?limit=5`, NO_BODY, { actor: 'mem' }],
  ['a list all', 'GET', () => `/split-expenses/groups/${ids.g1}/activity`, NO_BODY, { actor: 'owner' }],
  ['a list offset', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?limit=3&offset=4`, NO_BODY, { actor: 'owner' }],
  ['a list cursor', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?limit=3&before_at=${STAMP}&before_id=4`, NO_BODY, { actor: 'owner' }],
  ['a list cursor half', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?before_id=4`, NO_BODY, { actor: 'owner' }],
  ['a list cursor id zero', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?before_at=x&before_id=0`, NO_BODY, { actor: 'owner' }],
  ['a list cursor id letters', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?before_at=x&before_id=x`, NO_BODY, { actor: 'owner' }],
  ['a list cursor long', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?before_at=${LONG(65)}&before_id=3`, NO_BODY, { actor: 'owner' }],
  ['a list cursor and offset', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?before_at=x&before_id=3&offset=2`, NO_BODY, { actor: 'owner' }],
  ['a list limit 0', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?limit=0&offset=40`, NO_BODY, { actor: 'owner' }],
  ['a list limit 1.5', 'GET', () => `/split-expenses/groups/${ids.g1}/activity?limit=1.5`, NO_BODY, { actor: 'owner' }],
  ['a list out', 'GET', () => `/split-expenses/groups/${ids.g1}/activity`, NO_BODY, { actor: 'out' }],
  ['a list zero', 'GET', '/split-expenses/groups/0/activity', NO_BODY, { actor: 'owner' }],

  // ══ SPLIT: recurring ═══════════════════════════════════════════════════════
  ['r create', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ category: 'rent', budget_category: BUDGET_KEY }), { actor: 'owner' }],
  () => { ids.r1 = lastId('recurring_expenses'); },
  ['r create defaults', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, { title: 'Netflix', amount: '12.99', frequency: 'monthly', next_run_date: '2026-11-30' }, { actor: 'mem' }],
  () => { ids.r2 = lastId('recurring_expenses'); },
  ['r create skip past', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ title: 'Versicherung', frequency: 'weekly', next_run_date: '2026-10-01', missed: 'skip' }), { actor: 'owner' }],
  ['r create book past', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ title: 'Abo', frequency: 'yearly', next_run_date: '2026-10-01', missed: 'book', currency: 'USD' }), { actor: 'owner' }],
  ['r create missed null', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ title: 'Ohne Wahl', next_run_date: '2026-10-31', missed: null }), { actor: 'owner' }],
  ['r create missed unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ missed: 'later' }), { actor: 'owner' }],
  ['r create frequency unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ frequency: 'daily' }), { actor: 'owner' }],
  ['r create frequency missing', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, { title: 'X', amount: '1.00' }, { actor: 'owner' }],
  ['r create frequency proto', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ frequency: 'constructor' }), { actor: 'owner' }],
  ['r create method unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ split_method: 'half' }), { actor: 'owner' }],
  ['r create category unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ category: 'casino' }), { actor: 'owner' }],
  ['r create currency unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ currency: 'XXX' }), { actor: 'owner' }],
  ['r create title spaces', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ title: SPACES }), { actor: 'owner' }],
  ['r create date not a day', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ next_run_date: '2026-11-31' }), { actor: 'owner' }],
  ['r create exact wrong', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ split_method: 'exact', splits: [{ user_id: OWNER, amount: '1.00' }] }), { actor: 'owner' }],
  ['r create payer out', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ payer_id: OUT }), { actor: 'owner' }],
  ['r create budget unknown', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ budget_category: 'nope' }), { actor: 'owner' }],
  ['r create amount number', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING({ amount: 500 }), { actor: 'owner' }],
  ['r create no body', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, NO_BODY, { actor: 'owner' }],
  ['r create out', 'POST', () => `/split-expenses/groups/${ids.g1}/recurring`, RECURRING(), { actor: 'out' }],
  ['r create zero', 'POST', '/split-expenses/groups/0/recurring', RECURRING(), { actor: 'owner' }],
  ['r list', 'GET', () => `/split-expenses/groups/${ids.g1}/recurring`, NO_BODY, { actor: 'mem' }],
  ['r list out', 'GET', () => `/split-expenses/groups/${ids.g1}/recurring`, NO_BODY, { actor: 'out' }],
  ['r list zero', 'GET', '/split-expenses/groups/0/recurring', NO_BODY],
  ['r put amount', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { amount: '550.00' }, { actor: 'owner' }],
  ['r put category', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { category: 'utilities' }, { actor: 'owner' }],
  ['r put category null', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { category: null }, { actor: 'owner' }],
  ['r put category unknown', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { category: 'casino' }, { actor: 'owner' }],
  ['r put frequency', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { frequency: 'yearly' }, { actor: 'owner' }],
  ['r put frequency unknown', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { frequency: 'daily' }, { actor: 'owner' }],
  ['r put frequency empty', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { frequency: '' }, { actor: 'owner' }],
  ['r put method unknown', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { split_method: 'half' }, { actor: 'owner' }],
  ['r put method shares', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { split_method: 'shares', splits: [{ user_id: OWNER, shares: 3 }, { user_id: MEM, shares: 1 }] }, { actor: 'owner' }],
  ['r put currency unknown', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { currency: 'XXX' }, { actor: 'owner' }],
  ['r put missed unknown', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { missed: 'later' }, { actor: 'owner' }],
  ['r put move skip', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { next_run_date: '2026-09-15', missed: 'skip' }, { actor: 'owner' }],
  ['r put move book', 'PUT', () => `/split-expenses/recurring/${ids.r2}`, { next_run_date: '2026-10-30', missed: 'book' }, { actor: 'mem' }],
  ['r put participants text', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { participants: 'all' }, { actor: 'owner' }],
  ['r put title spaces', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { title: SPACES }, { actor: 'owner' }],
  ['r put title null', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { title: null }, { actor: 'owner' }],
  ['r put description clear', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { description: null }, { actor: 'owner' }],
  ['r put payer zero', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { payer_id: 0 }, { actor: 'owner' }],
  ['r put payer zero text', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { payer_id: '0' }, { actor: 'owner' }],
  ['r put empty', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, {}, { actor: 'owner' }],
  ['r put no body', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, NO_BODY, { actor: 'owner' }],
  ['r put by member', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { amount: '1.00' }, { actor: 'mem' }],
  ['r put by out', 'PUT', () => `/split-expenses/recurring/${ids.r1}`, { amount: '1.00' }, { actor: 'out' }],
  ['r put missing', 'PUT', `/split-expenses/recurring/${MISSING}`, { amount: '1.00' }, { actor: 'owner' }],
  ['r put zero', 'PUT', '/split-expenses/recurring/0', { amount: '1.00' }, { actor: 'owner' }],
  ['r put negative', 'PUT', '/split-expenses/recurring/-2', { amount: '1.00' }, { actor: 'owner' }],
  ['r pause', 'POST', () => `/split-expenses/recurring/${ids.r1}/pause`, NO_BODY, { actor: 'owner' }],
  ['r pause resume book', 'POST', () => `/split-expenses/recurring/${ids.r1}/pause`, { missed: 'book' }, { actor: 'owner' }],
  ['r pause again', 'POST', () => `/split-expenses/recurring/${ids.r1}/pause`, { missed: null }, { actor: 'owner' }],
  ['r pause resume skip', 'POST', () => `/split-expenses/recurring/${ids.r1}/pause`, {}, { actor: 'owner' }],
  ['r pause missed unknown', 'POST', () => `/split-expenses/recurring/${ids.r1}/pause`, { missed: 'later' }, { actor: 'owner' }],
  ['r pause missed number', 'POST', () => `/split-expenses/recurring/${ids.r1}/pause`, { missed: 1 }, { actor: 'owner' }],
  ['r pause by member', 'POST', () => `/split-expenses/recurring/${ids.r1}/pause`, NO_BODY, { actor: 'mem' }],
  ['r pause missing', 'POST', `/split-expenses/recurring/${MISSING}/pause`, NO_BODY, { actor: 'owner' }],
  ['r pause zero', 'POST', '/split-expenses/recurring/0/pause', NO_BODY, { actor: 'owner' }],
  ['r delete by member', 'DELETE', () => `/split-expenses/recurring/${ids.r1}`, NO_BODY, { actor: 'mem' }],
  ['r delete own by member', 'DELETE', () => `/split-expenses/recurring/${ids.r2}`, NO_BODY, { actor: 'mem' }],
  ['r delete again', 'DELETE', () => `/split-expenses/recurring/${ids.r2}`, NO_BODY, { actor: 'mem' }],
  ['r delete zero', 'DELETE', '/split-expenses/recurring/0', NO_BODY, { actor: 'owner' }],

  // ══ SPLIT: deletes, archive, search, dashboard ═════════════════════════════
  ['e delete by member', 'DELETE', () => `/split-expenses/expenses/${ids.e1}`, NO_BODY, { actor: 'mem' }],
  ['e delete own by member', 'DELETE', () => `/split-expenses/expenses/${ids.e2}`, NO_BODY, { actor: 'mem' }],
  ['e delete again', 'DELETE', () => `/split-expenses/expenses/${ids.e2}`, NO_BODY, { actor: 'mem' }],
  ['e delete zero', 'DELETE', '/split-expenses/expenses/0', NO_BODY, { actor: 'owner' }],
  ['e delete negative', 'DELETE', '/split-expenses/expenses/-9', NO_BODY, { actor: 'owner' }],
  ['m remove owner', 'DELETE', () => `/split-expenses/groups/${ids.g1}/members/${OWNER}`, NO_BODY, { actor: 'owner' }],
  ['m remove by member', 'DELETE', () => `/split-expenses/groups/${ids.g1}/members/${OWNER}`, NO_BODY, { actor: 'mem' }],
  ['m remove missing', 'DELETE', () => `/split-expenses/groups/${ids.g1}/members/${OUT}`, NO_BODY, { actor: 'owner' }],
  ['m remove zero', 'DELETE', () => `/split-expenses/groups/${ids.g1}/members/0`, NO_BODY, { actor: 'owner' }],
  ['m remove negative', 'DELETE', () => `/split-expenses/groups/${ids.g1}/members/-1`, NO_BODY, { actor: 'owner' }],
  ['m remove letters', 'DELETE', () => `/split-expenses/groups/${ids.g1}/members/abc`, NO_BODY, { actor: 'owner' }],
  ['m remove g2', 'DELETE', () => `/split-expenses/groups/${ids.g2}/members/${MEM}`, NO_BODY, { actor: 'owner' }],
  ['g archive by member', 'POST', () => `/split-expenses/groups/${ids.g1}/archive`, NO_BODY, { actor: 'mem' }],
  ['g archive', 'POST', () => `/split-expenses/groups/${ids.g2}/archive`, NO_BODY, { actor: 'owner' }],
  ['g archive zero', 'POST', '/split-expenses/groups/0/archive', NO_BODY, { actor: 'owner' }],
  ['g list archived', 'GET', '/split-expenses/groups?status=archived', NO_BODY, { actor: 'owner' }],
  ['g archived patch', 'PATCH', () => `/split-expenses/groups/${ids.g2}`, { name: 'X' }, { actor: 'owner' }],
  ['g archived patch broken', 'PATCH', () => `/split-expenses/groups/${ids.g2}`, { type: 'trip' }, { actor: 'owner' }],
  ['g archived expense', 'POST', () => `/split-expenses/groups/${ids.g2}/expenses`, EXPENSE(), { actor: 'owner' }],
  ['g archived member', 'POST', () => `/split-expenses/groups/${ids.g2}/members`, {}, { actor: 'owner' }],
  ['g archived guest', 'POST', () => `/split-expenses/groups/${ids.g2}/guests`, { display_name: 'X', password: 'kurz' }, { actor: 'owner' }],
  ['g archived settlement', 'POST', () => `/split-expenses/groups/${ids.g2}/settlements`, SETTLE(), { actor: 'owner' }],
  ['g archived recurring', 'POST', () => `/split-expenses/groups/${ids.g2}/recurring`, RECURRING(), { actor: 'owner' }],
  ['g archived remove member', 'DELETE', () => `/split-expenses/groups/${ids.g2}/members/${OWNER}`, NO_BODY, { actor: 'owner' }],
  ['g unarchive by member', 'POST', () => `/split-expenses/groups/${ids.g2}/unarchive`, NO_BODY, { actor: 'mem' }],
  ['g unarchive', 'POST', () => `/split-expenses/groups/${ids.g2}/unarchive`, NO_BODY, { actor: 'owner' }],
  ['g unarchive again', 'POST', () => `/split-expenses/groups/${ids.g2}/unarchive`, {}, { actor: 'owner' }],
  ['g unarchive missing', 'POST', `/split-expenses/groups/${MISSING}/unarchive`, NO_BODY, { actor: 'owner' }],
  ['g delete history', 'DELETE', () => `/split-expenses/groups/${ids.g1}`, NO_BODY, { actor: 'owner' }],
  ['g delete by member', 'DELETE', () => `/split-expenses/groups/${ids.g1}`, NO_BODY, { actor: 'mem' }],
  ['g delete', 'DELETE', () => `/split-expenses/groups/${ids.g2}`, NO_BODY, { actor: 'owner' }],
  ['g delete again', 'DELETE', () => `/split-expenses/groups/${ids.g2}`, NO_BODY, { actor: 'owner' }],
  ['g delete zero', 'DELETE', '/split-expenses/groups/0', NO_BODY, { actor: 'owner' }],
  ['search', 'GET', '/split-expenses/search?q=%20Ein%20', NO_BODY, { actor: 'owner' }],
  ['search empty', 'GET', '/split-expenses/search', NO_BODY, { actor: 'mem' }],
  ['search guest', 'GET', '/split-expenses/search?q=a', NO_BODY, { actor: 'GUEST' }],
  ['search out', 'GET', '/split-expenses/search?q=a', NO_BODY, { actor: 'out' }],
  ['search doubled', 'GET', '/split-expenses/search?q=a&q=b', NO_BODY, { actor: 'owner' }],
  ['dashboard', 'GET', '/split-expenses/dashboard', NO_BODY, { actor: 'owner' }],
  ['dashboard guest', 'GET', '/split-expenses/dashboard', NO_BODY, { actor: 'GUEST' }],
  ['dashboard admin', 'GET', '/split-expenses/dashboard', NO_BODY],

  // ══ BACKUP ═════════════════════════════════════════════════════════════════
  ['bk status', 'GET', '/backup/status', NO_BODY],
  ['bk status member', 'GET', '/backup/status', NO_BODY, { actor: 'owner' }],
  ['bk key', 'GET', '/backup/database-key', NO_BODY],
  ['bk key member', 'GET', '/backup/database-key', NO_BODY, { actor: 'owner' }],
  ['bk download', 'GET', '/backup/database', NO_BODY],
  ['bk download member', 'GET', '/backup/database', NO_BODY, { actor: 'owner' }],
  ['bk restore empty', 'POST', '/backup/restore', NO_BODY, { raw: Buffer.alloc(0) }],
  ['bk restore garbage', 'POST', '/backup/restore', NO_BODY, { raw: Buffer.from('not a database at all') }],
  ['bk restore bad key', 'POST', '/backup/restore', NO_BODY, { raw: Buffer.from('x'), headers: { 'X-Backup-Key': '***' } }],
  ['bk restore member', 'POST', '/backup/restore', NO_BODY, { raw: Buffer.from('x'), actor: 'owner' }],
  ['bk trigger', 'POST', '/backup/trigger', NO_BODY],
  ['bk trigger member', 'POST', '/backup/trigger', NO_BODY, { actor: 'owner' }],
  ['dav get empty', 'GET', '/backup/webdav/config', NO_BODY],
  ['dav test incomplete', 'POST', '/backup/webdav/test', {}],
  ['dav files unconfigured', 'GET', '/backup/webdav/files', NO_BODY],
  ['dav put', 'PUT', '/backup/webdav/config', () => DAV()],
  ['dav get', 'GET', '/backup/webdav/config', NO_BODY],
  ['dav get member', 'GET', '/backup/webdav/config', NO_BODY, { actor: 'owner' }],
  ['dav put enabled text', 'PUT', '/backup/webdav/config', { enabled: 'yes' }],
  ['dav put enabled null', 'PUT', '/backup/webdav/config', { enabled: null }],
  ['dav put url number', 'PUT', '/backup/webdav/config', { url: 5 }],
  ['dav put url ftp', 'PUT', '/backup/webdav/config', { url: 'ftp://example.test/' }],
  ['dav put url spaces', 'PUT', '/backup/webdav/config', () => ({ url: ` ${davOrigin} ` })],
  ['dav put url empty', 'PUT', '/backup/webdav/config', { url: '' }],
  ['dav put url back', 'PUT', '/backup/webdav/config', () => ({ url: davOrigin, password: 's3cret' })],
  ['dav put keep zero', 'PUT', '/backup/webdav/config', { keep: 0 }],
  ['dav put keep fraction', 'PUT', '/backup/webdav/config', { keep: 7.5 }],
  ['dav put keep text', 'PUT', '/backup/webdav/config', { keep: 'many' }],
  ['dav put keep 3', 'PUT', '/backup/webdav/config', { keep: 3 }],
  ['dav put username number', 'PUT', '/backup/webdav/config', { username: 5 }],
  ['dav put new user no password', 'PUT', '/backup/webdav/config', { username: 'other' }],
  ['dav put remote path', 'PUT', '/backup/webdav/config', { remotePath: '/elsewhere/' }],
  ['dav put remote path list', 'PUT', '/backup/webdav/config', { remotePath: ['a'] }],
  ['dav put empty', 'PUT', '/backup/webdav/config', {}],
  ['dav put no body', 'PUT', '/backup/webdav/config', NO_BODY],
  ['dav put member', 'PUT', '/backup/webdav/config', { enabled: false }, { actor: 'owner' }],
  ['dav put member broken', 'PUT', '/backup/webdav/config', { url: 1 }, { actor: 'owner' }],
  ['dav test', 'POST', '/backup/webdav/test', {}],
  ['dav test url number', 'POST', '/backup/webdav/test', { url: 5 }],
  ['dav test new user no password', 'POST', '/backup/webdav/test', { username: 'other' }],
  ['dav test mask', 'POST', '/backup/webdav/test', { password: '****' }],
  ['dav test no body', 'POST', '/backup/webdav/test', NO_BODY],
  ['dav files', 'GET', '/backup/webdav/files', NO_BODY],
  ['dav trigger', 'POST', '/backup/webdav/trigger', NO_BODY],
  ['dav trigger member', 'POST', '/backup/webdav/trigger', NO_BODY, { actor: 'owner' }],

  // ══ CORE ═══════════════════════════════════════════════════════════════════
  ['sys diagnostics', 'GET', '/system/diagnostics', NO_BODY, { shape: true }],
  ['sys diagnostics member', 'GET', '/system/diagnostics', NO_BODY, { actor: 'owner' }],
  ['changelog', 'GET', '/changelog', NO_BODY, { shape: true }],
  ['changelog member', 'GET', '/changelog', NO_BODY, { actor: 'owner', shape: true }],
];

/**
 * Generated at 8834558fa (before the refactor) from this very table, then
 * written down literally.
 * @type {Record<string, { status: number, body: unknown }>}
 */
const EXPECTED = {
  'meta': {"status":200,"body":{"data":{"group_types":["household","couple","travel","event","shopping","general"],"group_roles":["owner","admin","guest"],"split_methods":["equal","exact","percentage","shares"],"categories":["groceries","rent","utilities","baby","pets","school","travel","shopping","subscriptions","health","home","general"],"currencies":["AED","ARS","AUD","BBD","BOB","BRL","BSD","BYN","BZD","CAD","CHF","CLP","CNY","COP","CRC","CUP","CZK","DKK","DOP","EUR","GBP","GTQ","GYD","HKD","HNL","HTG","HUF","IDR","ILS","INR","IRR","JMD","JPY","KRW","KZT","MOP","MXN","MYR","NIO","NOK","NZD","PAB","PEN","PHP","PLN","PYG","RUB","SAR","SEK","SGD","SRD","TRY","TTD","TWD","UAH","USD","UYU","VES","VND","XCD","ZAR"],"frequencies":["weekly","monthly","yearly"],"default_currency":"EUR"}}},
  'meta guest-less member': {"status":200,"body":{"data":{"group_types":["household","couple","travel","event","shopping","general"],"group_roles":["owner","admin","guest"],"split_methods":["equal","exact","percentage","shares"],"categories":["groceries","rent","utilities","baby","pets","school","travel","shopping","subscriptions","health","home","general"],"currencies":["AED","ARS","AUD","BBD","BOB","BRL","BSD","BYN","BZD","CAD","CHF","CLP","CNY","COP","CRC","CUP","CZK","DKK","DOP","EUR","GBP","GTQ","GYD","HKD","HNL","HTG","HUF","IDR","ILS","INR","IRR","JMD","JPY","KRW","KZT","MOP","MXN","MYR","NIO","NOK","NZD","PAB","PEN","PHP","PLN","PYG","RUB","SAR","SEK","SGD","SRD","TRY","TTD","TWD","UAH","USD","UYU","VES","VND","XCD","ZAR"],"frequencies":["weekly","monthly","yearly"],"default_currency":"EUR"}}},
  'dashboard empty': {"status":200,"body":{"data":{"total_owed":[],"total_owing":[],"groups":[],"recent_expenses":[]}}},
  'g create': {"status":201,"body":{"data":{"id":1,"name":"WG","description":"Wohnung","type":"household","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g create defaults': {"status":201,"body":{"data":{"id":2,"name":"Reise","description":null,"type":"general","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g create usd shares': {"status":201,"body":{"data":{"id":3,"name":"Urlaub","description":null,"type":"travel","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"USD","status":"active","created_by":1,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"shares","default_split_config":null,"creator_name":"linda","member_count":1,"member_role":"owner"}}},
  'g create spaces': {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  'g create no name': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  'g create empty name': {"status":400,"body":{"error":"Name is required.","code":400}},
  'g create long name': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"maxLength"}]}},
  'g create long padded name': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"maxLength"}]}},
  'g create long description': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/description","rule":"maxLength"}]}},
  'g create name number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  'g create no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'g create type unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type","rule":"enum"}]}},
  'g create type null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type","rule":"type"}]}},
  'g create type empty': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type","rule":"enum"}]}},
  'g create currency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_currency","rule":"enum"}]}},
  'g create currency lower': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_currency","rule":"enum"}]}},
  'g create currency null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_currency","rule":"type"}]}},
  'g create currency proto': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_currency","rule":"enum"}]}},
  'g create method unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_split_method","rule":"enum"}]}},
  'g create method null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_split_method","rule":"type"}]}},
  'g list': {"status":200,"body":{"data":[{"id":1,"name":"WG","description":"Wohnung","type":"household","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"},{"id":2,"name":"Reise","description":null,"type":"general","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}]}},
  'g list admin': {"status":200,"body":{"data":[{"id":3,"name":"Urlaub","description":null,"type":"travel","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"USD","status":"active","created_by":1,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"shares","default_split_config":null,"creator_name":"linda","member_count":1,"member_role":"owner"}]}},
  'g list out': {"status":200,"body":{"data":[]}},
  'g list q': {"status":200,"body":{"data":[{"id":1,"name":"WG","description":"Wohnung","type":"household","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}]}},
  'g list q doubled': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/q","rule":"type"}]}},
  'g list status active': {"status":200,"body":{"data":[{"id":1,"name":"WG","description":"Wohnung","type":"household","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"},{"id":2,"name":"Reise","description":null,"type":"general","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}]}},
  'g list status deleted': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"enum"}]}},
  'g list status empty': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/status","rule":"enum"}]}},
  'g patch type': {"status":200,"body":{"data":{"id":1,"name":"WG","description":"Wohnung","type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g patch type unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type","rule":"enum"}]}},
  'g patch type null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type","rule":"type"}]}},
  'g patch currency': {"status":200,"body":{"data":{"id":2,"name":"Reise","description":null,"type":"general","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"CHF","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g patch currency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_currency","rule":"enum"}]}},
  'g patch currency proto': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_currency","rule":"enum"}]}},
  'g patch method unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_split_method","rule":"enum"}]}},
  'g patch method null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/default_split_method","rule":"type"}]}},
  'g patch config only': {"status":200,"body":{"data":{"id":1,"name":"WG","description":"Wohnung","type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g patch name spaces': {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  'g patch name long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"maxLength"}]}},
  'g patch description null': {"status":200,"body":{"data":{"id":1,"name":"WG","description":null,"type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g patch description back': {"status":200,"body":{"data":{"id":1,"name":"WG","description":"Wohnung","type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g patch empty': {"status":200,"body":{"data":{"id":1,"name":"WG","description":"Wohnung","type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g patch no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'g patch missing': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g patch zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g patch negative': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g patch minus zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g patch leading zero': {"status":200,"body":{"data":{"id":2,"name":"Reise","description":null,"type":"general","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"CHF","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}}},
  'g patch letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  'g patch hex': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  'g patch out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g patch admin': {"status":200,"body":{}},
  'm add': {"status":201,"body":{"data":{"group_id":1,"user_id":3,"role":"guest"}}},
  'm add g2': {"status":201,"body":{"data":{"group_id":2,"user_id":3,"role":"guest"}}},
  'm add role admin': {"status":201,"body":{"data":{"group_id":3,"user_id":2,"role":"admin"}}},
  'm add role owner': {"status":201,"body":{"data":{"group_id":3,"user_id":3,"role":"guest"}}},
  'm add role unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/role","rule":"enum"}]}},
  'm add role null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/role","rule":"type"}]}},
  'm add user zero': {"status":400,"body":{"error":"user_id or contact_id is required.","code":400}},
  'm add user zero text': {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  'm add user negative': {"status":400,"body":{"error":"user_id must be a positive number.","code":400}},
  'm add user letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/user_id","rule":"type"},{"path":"body/user_id","rule":"pattern"},{"path":"body/user_id","rule":"anyOf"}]}},
  'm add user fraction': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/user_id","rule":"type"},{"path":"body/user_id","rule":"anyOf"}]}},
  'm add user missing': {"status":404,"body":{"error":"User not found.","code":404}},
  'm add contact missing': {"status":404,"body":{"error":"Contact not found.","code":404}},
  'm add empty': {"status":400,"body":{"error":"user_id or contact_id is required.","code":400}},
  'm add no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'm add by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'm add by out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'm add group zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'm list': {"status":200,"body":{"data":[{"group_id":1,"user_id":2,"role":"owner","joined_at":"2026-11-18T12:00:00Z","display_name":"tom","username":"tom","avatar_color":"#007AFF","avatar_data":null},{"group_id":1,"user_id":3,"role":"guest","joined_at":"2026-11-18T12:00:00Z","display_name":"mia","username":"mia","avatar_color":"#007AFF","avatar_data":null}]}},
  'm list out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'm list missing': {"status":404,"body":{"error":"Group not found.","code":404}},
  'm list negative': {"status":404,"body":{"error":"Group not found.","code":404}},
  'mc list': {"status":200,"body":{"data":[{"source":"user","user_id":1,"contact_id":null,"display_name":"linda","username":"linda","avatar_color":"#007AFF","family_role":"parent","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"in_group":0,"group_role":null,"sort_order":null},{"source":"user","user_id":3,"contact_id":null,"display_name":"mia","username":"mia","avatar_color":"#007AFF","family_role":"parent","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"in_group":1,"group_role":"guest","sort_order":null},{"source":"user","user_id":4,"contact_id":null,"display_name":"ole","username":"ole","avatar_color":"#007AFF","family_role":"parent","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"in_group":0,"group_role":null,"sort_order":null},{"source":"user","user_id":2,"contact_id":null,"display_name":"tom","username":"tom","avatar_color":"#007AFF","family_role":"parent","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"in_group":1,"group_role":"owner","sort_order":null}]}},
  'mc list out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'mc list zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'gu create': {"status":201,"body":{"data":{"id":5,"username":"gast","display_name":"Gast","avatar_color":"#007AFF","avatar_data":null,"family_role":"child","phone":"0123","email":"gast@example.test","birth_date":"2010-05-01","created_at":"<volatile>"}}},
  'gu create username': {"status":201,"body":{"data":{"id":6,"username":"gast.zwei","display_name":"Zweiter Gast","avatar_color":"#007AFF","avatar_data":null,"family_role":"other","phone":null,"email":null,"birth_date":null,"created_at":"<volatile>"}}},
  'gu create username taken': {"status":409,"body":{"error":"Username is already taken.","code":409}},
  'gu create username short': {"status":201,"body":{"data":{"id":7,"username":"kurz.name","display_name":"Kurz Name","avatar_color":"#007AFF","avatar_data":null,"family_role":"other","phone":null,"email":null,"birth_date":null,"created_at":"<volatile>"}}},
  'gu create username null': {"status":201,"body":{"data":{"id":8,"username":"ohne.name","display_name":"Ohne Name","avatar_color":"#007AFF","avatar_data":null,"family_role":"other","phone":null,"email":null,"birth_date":null,"created_at":"<volatile>"}}},
  'gu create family unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/family_role","rule":"enum"}]}},
  'gu create family null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/family_role","rule":"type"}]}},
  'gu create password short': {"status":400,"body":{"error":"Password must be at least 8 characters long.","code":400}},
  'gu create password empty': {"status":400,"body":{"error":"Password must be at least 8 characters long.","code":400}},
  'gu create password object': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/password","rule":"type"}]}},
  'gu create password missing': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/password","rule":"required"}]}},
  'gu create name spaces': {"status":400,"body":{"error":"Display name must not be empty.","code":400}},
  'gu create name long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/display_name","rule":"maxLength"}]}},
  'gu create phone long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/phone","rule":"maxLength"}]}},
  'gu create email long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/email","rule":"maxLength"}]}},
  'gu create birth not a day': {"status":400,"body":{"error":"Birth date must be a valid calendar date.","code":400}},
  'gu create by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'gu create missing group': {"status":404,"body":{"error":"Group not found.","code":404}},
  'gu create no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'g create by guest': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'g create by guest broken': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'g list guest': {"status":200,"body":{"data":[{"id":1,"name":"WG","description":"Wohnung","type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":6,"member_role":"guest"}]}},
  'mc list guest': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'g patch guest': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'e create': {"status":201,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e create defaults': {"status":201,"body":{"data":{"id":2,"group_id":1,"title":"Brot","description":null,"amount_minor":320,"currency":"EUR","converted_amount_minor":320,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":3,"category":"general","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"mia","group_name":"WG","amount":"3.20","converted_amount":"3.20","splits":[{"user_id":3,"amount_minor":320,"currency":"EUR","display_name":"mia","amount":"3.20"}],"attachments":[]}}},
  'e create usd converted': {"status":201,"body":{"data":{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]}}},
  'e create usd only': {"status":201,"body":{"data":{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]}}},
  'e create jpy decimals': {"status":400,"body":{"error":"amount has too many decimal places for JPY.","code":400}},
  'e create exact': {"status":201,"body":{"data":{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","payer_name":"tom","group_name":"WG","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]}}},
  'e create exact wrong sum': {"status":400,"body":{"error":"Exact splits must add up to the expense amount.","code":400}},
  'e create shares': {"status":201,"body":{"data":{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]}}},
  'e create shares zero': {"status":400,"body":{"error":"Shares must be positive integers.","code":400}},
  'e create percentage': {"status":201,"body":{"data":{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]}}},
  'e create currency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/currency","rule":"enum"}]}},
  'e create currency proto': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/currency","rule":"enum"}]}},
  'e create converted unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/converted_currency","rule":"enum"}]}},
  'e create method unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/split_method","rule":"enum"}]}},
  'e create method proto': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/split_method","rule":"enum"}]}},
  'e create category unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/category","rule":"enum"}]}},
  'e create category null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/category","rule":"type"}]}},
  'e create amount number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount","rule":"type"}]}},
  'e create amount zero': {"status":400,"body":{"error":"amount must be greater than zero.","code":400}},
  'e create amount negative': {"status":400,"body":{"error":"amount must be greater than zero.","code":400}},
  'e create amount places': {"status":400,"body":{"error":"amount has too many decimal places for EUR.","code":400}},
  'e create title spaces': {"status":400,"body":{"error":"Title must not be empty.","code":400}},
  'e create title long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/title","rule":"maxLength"}]}},
  'e create description long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/description","rule":"maxLength"}]}},
  'e create date not a day': {"status":400,"body":{"error":"Expense date must be a valid calendar date.","code":400}},
  'e create date empty': {"status":201,"body":{"data":{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e create payer out': {"status":400,"body":{"error":"Payer must be a group member.","code":400}},
  'e create payer zero': {"status":201,"body":{"data":{"id":9,"group_id":1,"title":"Zahler null","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-06","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e create payer zero text': {"status":400,"body":{"error":"Payer must be a group member.","code":400}},
  'e create payer negative': {"status":400,"body":{"error":"Payer must be a group member.","code":400}},
  'e create payer letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/payer_id","rule":"type"},{"path":"body/payer_id","rule":"pattern"},{"path":"body/payer_id","rule":"anyOf"}]}},
  'e create participants text': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/participants","rule":"type"}]}},
  'e create participants null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/participants","rule":"type"}]}},
  'e create participants out': {"status":400,"body":{"error":"All participants must be group members.","code":400}},
  'e create participants empty': {"status":400,"body":{"error":"participants must contain at least one member.","code":400}},
  'e create budget unknown': {"status":400,"body":{"error":"Unknown budget category.","code":400,"reason":"unknown_budget_category"}},
  'e create attachments missing': {"status":201,"body":{"data":{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e create attachments null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/attachment_document_ids","rule":"type"}]}},
  'e create no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'e create out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'e create missing group': {"status":404,"body":{"error":"Group not found.","code":404}},
  'e create group zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'e create guest': {"status":201,"body":{"data":{"id":11,"group_id":1,"title":"Vom Gast","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":5,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-05","recurring_rule_id":null,"created_by":5,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"Gast","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":5,"amount_minor":1500,"currency":"EUR","display_name":"Gast","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e list': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":2,"group_id":1,"title":"Brot","description":null,"amount_minor":320,"currency":"EUR","converted_amount_minor":320,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":3,"category":"general","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"mia","amount":"3.20","converted_amount":"3.20","splits":[{"user_id":3,"amount_minor":320,"currency":"EUR","display_name":"mia","amount":"3.20"}],"attachments":[]},{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]},{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]},{"id":9,"group_id":1,"title":"Zahler null","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-06","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":11,"group_id":1,"title":"Vom Gast","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":5,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-05","recurring_rule_id":null,"created_by":5,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"Gast","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":5,"amount_minor":1500,"currency":"EUR","display_name":"Gast","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"pagination":{"limit":30,"offset":0,"has_more":false,"next_cursor":null}}},
  'e list guest': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":2,"group_id":1,"title":"Brot","description":null,"amount_minor":320,"currency":"EUR","converted_amount_minor":320,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":3,"category":"general","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"mia","amount":"3.20","converted_amount":"3.20","splits":[{"user_id":3,"amount_minor":320,"currency":"EUR","display_name":"mia","amount":"3.20"}],"attachments":[]}],"pagination":{"limit":2,"offset":0,"has_more":true,"next_cursor":{"before_date":"2026-11-18","before_at":"2026-11-18T12:00:00Z","before_id":2}}}},
  'e list out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'e list limit 2': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":2,"group_id":1,"title":"Brot","description":null,"amount_minor":320,"currency":"EUR","converted_amount_minor":320,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":3,"category":"general","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"mia","amount":"3.20","converted_amount":"3.20","splits":[{"user_id":3,"amount_minor":320,"currency":"EUR","display_name":"mia","amount":"3.20"}],"attachments":[]}],"pagination":{"limit":2,"offset":0,"has_more":true,"next_cursor":{"before_date":"2026-11-18","before_at":"2026-11-18T12:00:00Z","before_id":2}}}},
  'e list limit 0': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":2,"group_id":1,"title":"Brot","description":null,"amount_minor":320,"currency":"EUR","converted_amount_minor":320,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":3,"category":"general","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"mia","amount":"3.20","converted_amount":"3.20","splits":[{"user_id":3,"amount_minor":320,"currency":"EUR","display_name":"mia","amount":"3.20"}],"attachments":[]},{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]},{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]},{"id":9,"group_id":1,"title":"Zahler null","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-06","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":11,"group_id":1,"title":"Vom Gast","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":5,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-05","recurring_rule_id":null,"created_by":5,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"Gast","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":5,"amount_minor":1500,"currency":"EUR","display_name":"Gast","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"pagination":{"limit":30,"offset":0,"has_more":false,"next_cursor":null}}},
  'e list limit 150': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":2,"group_id":1,"title":"Brot","description":null,"amount_minor":320,"currency":"EUR","converted_amount_minor":320,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":3,"category":"general","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"mia","amount":"3.20","converted_amount":"3.20","splits":[{"user_id":3,"amount_minor":320,"currency":"EUR","display_name":"mia","amount":"3.20"}],"attachments":[]},{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]},{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]},{"id":9,"group_id":1,"title":"Zahler null","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-06","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":11,"group_id":1,"title":"Vom Gast","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":5,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-05","recurring_rule_id":null,"created_by":5,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"Gast","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":5,"amount_minor":1500,"currency":"EUR","display_name":"Gast","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"pagination":{"limit":100,"offset":0,"has_more":false,"next_cursor":null}}},
  'e list limit negative': {"status":200,"body":{"data":[{"id":2,"group_id":1,"title":"Brot","description":null,"amount_minor":320,"currency":"EUR","converted_amount_minor":320,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":3,"category":"general","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"mia","amount":"3.20","converted_amount":"3.20","splits":[{"user_id":3,"amount_minor":320,"currency":"EUR","display_name":"mia","amount":"3.20"}],"attachments":[]}],"pagination":{"limit":1,"offset":1,"has_more":true,"next_cursor":{"before_date":"2026-11-18","before_at":"2026-11-18T12:00:00Z","before_id":2}}}},
  'e list limit letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/limit","rule":"type"}]}},
  'e list offset negative': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"pagination":{"limit":1,"offset":0,"has_more":true,"next_cursor":{"before_date":"2026-11-18","before_at":"2026-11-18T12:00:00Z","before_id":8}}}},
  'e list offset 2': {"status":200,"body":{"data":[{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]}],"pagination":{"limit":2,"offset":2,"has_more":true,"next_cursor":{"before_date":"2026-11-11","before_at":"2026-11-18T12:00:00Z","before_id":3}}}},
  'e list category': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]},{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]},{"id":9,"group_id":1,"title":"Zahler null","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-06","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":11,"group_id":1,"title":"Vom Gast","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":5,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-05","recurring_rule_id":null,"created_by":5,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"Gast","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":5,"amount_minor":1500,"currency":"EUR","display_name":"Gast","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"pagination":{"limit":30,"offset":0,"has_more":false,"next_cursor":null}}},
  'e list category unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/category","rule":"enum"}]}},
  'e list category doubled': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/category","rule":"type"}]}},
  'e list budget': {"status":200,"body":{"data":[{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]}],"pagination":{"limit":30,"offset":0,"has_more":false,"next_cursor":null}}},
  'e list budget none': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"pagination":{"limit":1,"offset":0,"has_more":true,"next_cursor":{"before_date":"2026-11-18","before_at":"2026-11-18T12:00:00Z","before_id":8}}}},
  'e list budget unknown': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"pagination":{"limit":1,"offset":0,"has_more":true,"next_cursor":{"before_date":"2026-11-18","before_at":"2026-11-18T12:00:00Z","before_id":8}}}},
  'e list budget empty': {"status":200,"body":{"data":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"pagination":{"limit":1,"offset":0,"has_more":true,"next_cursor":{"before_date":"2026-11-18","before_at":"2026-11-18T12:00:00Z","before_id":8}}}},
  'e list recurring 1': {"status":200,"body":{"data":[],"pagination":{"limit":30,"offset":0,"has_more":false,"next_cursor":null}}},
  'e list recurring 0': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/recurring","rule":"enum"}]}},
  'e list q': {"status":200,"body":{"data":[{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]}],"pagination":{"limit":30,"offset":0,"has_more":false,"next_cursor":null}}},
  'e list cursor': {"status":200,"body":{"data":[{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]}],"pagination":{"limit":2,"has_more":true,"next_cursor":{"before_date":"2026-11-08","before_at":"2026-11-18T12:00:00Z","before_id":6}}}},
  'e list cursor half': {"status":400,"body":{"error":"before_date, before_at and before_id belong together: take all three from pagination.next_cursor.","code":400}},
  'e list cursor empty part': {"status":400,"body":{"error":"before_date, before_at and before_id belong together: take all three from pagination.next_cursor.","code":400}},
  'e list cursor id zero': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/before_id","rule":"minimum"}]}},
  'e list cursor id letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/before_id","rule":"type"}]}},
  'e list cursor id empty': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/before_id","rule":"type"}]}},
  'e list cursor long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/before_at","rule":"maxLength"}]}},
  'e list cursor and offset': {"status":400,"body":{"error":"Use either a cursor or offset, not both.","code":400}},
  'e list missing': {"status":404,"body":{"error":"Group not found.","code":404}},
  'e list zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'e put': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf groß","description":"Markt","amount_minor":3200,"currency":"EUR","converted_amount_minor":3200,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"32.00","converted_amount":"32.00","splits":[{"user_id":3,"amount_minor":1600,"currency":"EUR","display_name":"mia","amount":"16.00"},{"user_id":2,"amount_minor":1600,"currency":"EUR","display_name":"tom","amount":"16.00"}],"attachments":[]}}},
  'e put category null': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e put category absent': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e put category unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/category","rule":"enum"}]}},
  'e put currency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/currency","rule":"enum"}]}},
  'e put currency usd': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"USD","converted_amount_minor":2800,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"28.00","splits":[{"user_id":3,"amount_minor":1400,"currency":"EUR","display_name":"mia","amount":"14.00"},{"user_id":2,"amount_minor":1400,"currency":"EUR","display_name":"tom","amount":"14.00"}],"attachments":[]}}},
  'e put converted unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/converted_currency","rule":"enum"}]}},
  'e put method unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/split_method","rule":"enum"}]}},
  'e put participants text': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/participants","rule":"type"}]}},
  'e put participants absent': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e put payer out': {"status":400,"body":{"error":"Payer must be a group member.","code":400}},
  'e put payer zero': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e put budget keep': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e put budget unknown': {"status":400,"body":{"error":"Unknown budget category.","code":400,"reason":"unknown_budget_category"}},
  'e put attachments null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/attachment_document_ids","rule":"type"}]}},
  'e put attachments empty': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'e put title spaces': {"status":400,"body":{"error":"Title must not be empty.","code":400}},
  'e put date not a day': {"status":400,"body":{"error":"Expense date must be a valid calendar date.","code":400}},
  'e put no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'e put by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'e put own by member': {"status":200,"body":{"data":{"id":2,"group_id":1,"title":"Brot","description":null,"amount_minor":340,"currency":"EUR","converted_amount_minor":340,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":3,"category":"general","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"mia","group_name":"WG","amount":"3.40","converted_amount":"3.40","splits":[{"user_id":3,"amount_minor":340,"currency":"EUR","display_name":"mia","amount":"3.40"}],"attachments":[]}}},
  'e put by out': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'e put by guest': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'e put missing': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'e put zero': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'e put negative': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'e put admin': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"payer_name":"tom","group_name":"WG","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}}},
  'c add': {"status":201,"body":{"data":{"id":1,"expense_id":1,"user_id":3,"comment":"Danke"}}},
  'c add spaces': {"status":400,"body":{"error":"Comment must not be empty.","code":400}},
  'c add empty': {"status":400,"body":{"error":"Comment is required.","code":400}},
  'c add long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/comment","rule":"maxLength"}]}},
  'c add number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/comment","rule":"type"}]}},
  'c add no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'c add out': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'c add missing': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'c add zero': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'b balances': {"status":200,"body":{"data":{"balances":[{"currency":"EUR","user_id":5,"display_name":"Gast","net_minor":1500,"net":"15.00"},{"currency":"EUR","user_id":3,"display_name":"mia","net_minor":-9025,"net":"-90.25"},{"currency":"EUR","user_id":2,"display_name":"tom","net_minor":7525,"net":"75.25"},{"currency":"USD","user_id":3,"display_name":"mia","net_minor":-200,"net":"-2.00"},{"currency":"USD","user_id":2,"display_name":"tom","net_minor":200,"net":"2.00"}],"simplified_debts":[{"from_user_id":3,"from_name":"mia","to_user_id":2,"to_name":"tom","currency":"EUR","amount_minor":7525,"amount":"75.25"},{"from_user_id":3,"from_name":"mia","to_user_id":5,"to_name":"Gast","currency":"EUR","amount_minor":1500,"amount":"15.00"},{"from_user_id":3,"from_name":"mia","to_user_id":2,"to_name":"tom","currency":"USD","amount_minor":200,"amount":"2.00"}],"member_totals":[{"currency":"EUR","user_id":5,"display_name":"Gast","paid_minor":3000,"share_minor":1500,"paid":"30.00","share":"15.00"},{"currency":"EUR","user_id":3,"display_name":"mia","paid_minor":340,"share_minor":9365,"paid":"3.40","share":"93.65"},{"currency":"EUR","user_id":2,"display_name":"tom","paid_minor":19750,"share_minor":12225,"paid":"197.50","share":"122.25"},{"currency":"USD","user_id":3,"display_name":"mia","paid_minor":0,"share_minor":200,"paid":"0.00","share":"2.00"},{"currency":"USD","user_id":2,"display_name":"tom","paid_minor":400,"share_minor":200,"paid":"4.00","share":"2.00"}],"category_totals":[{"category":"groceries","currency":"EUR","total_minor":22750,"total":"227.50"},{"category":"general","currency":"EUR","total_minor":340,"total":"3.40"},{"category":"groceries","currency":"USD","total_minor":400,"total":"4.00"}],"budget_category_totals":[{"budget_category":null,"currency":"EUR","total_minor":19090,"total":"190.90"},{"budget_category":"housing","currency":"EUR","total_minor":4000,"total":"40.00"},{"budget_category":null,"currency":"USD","total_minor":400,"total":"4.00"}]}}},
  'b balances out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'b balances zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  's create': {"status":201,"body":{"data":{"id":1,"group_id":1,"payer_id":3,"payee_id":2,"amount_minor":1000,"currency":"EUR","notes":"bar","proof_document_id":null,"status":"active","paid_at":"<volatile>","created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","amount":"10.00"}}},
  's create by member': {"status":201,"body":{"data":{"id":2,"group_id":1,"payer_id":3,"payee_id":2,"amount_minor":200,"currency":"EUR","notes":null,"proof_document_id":null,"status":"active","paid_at":"<volatile>","created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","amount":"2.00"}}},
  's create currency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/currency","rule":"enum"}]}},
  's create currency usd': {"status":201,"body":{"data":{"id":3,"group_id":1,"payer_id":3,"payee_id":2,"amount_minor":100,"currency":"USD","notes":null,"proof_document_id":null,"status":"active","paid_at":"<volatile>","created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","amount":"1.00"}}},
  's create same person': {"status":400,"body":{"error":"Settlement needs two different users.","code":400}},
  's create payer out': {"status":400,"body":{"error":"Settlement users must be group members.","code":400}},
  's create payer zero': {"status":400,"body":{"error":"Settlement users must be group members.","code":400}},
  's create payer negative': {"status":400,"body":{"error":"Settlement users must be group members.","code":400}},
  's create payer letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/payer_id","rule":"type"},{"path":"body/payer_id","rule":"pattern"},{"path":"body/payer_id","rule":"anyOf"}]}},
  's create amount number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount","rule":"type"}]}},
  's create amount zero': {"status":400,"body":{"error":"amount must be greater than zero.","code":400}},
  's create notes long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/notes","rule":"maxLength"}]}},
  's create proof missing': {"status":201,"body":{"data":{"id":4,"group_id":1,"payer_id":3,"payee_id":2,"amount_minor":50,"currency":"EUR","notes":null,"proof_document_id":null,"status":"active","paid_at":"<volatile>","created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","amount":"0.50"}}},
  's create proof letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/proof_document_id","rule":"type"},{"path":"body/proof_document_id","rule":"pattern"},{"path":"body/proof_document_id","rule":"anyOf"}]}},
  's create no payee': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/payee_id","rule":"required"}]}},
  's create no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  's create out': {"status":404,"body":{"error":"Group not found.","code":404}},
  's reverse by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  's reverse': {"status":200,"body":{"data":{"id":1,"group_id":1,"payer_id":3,"payee_id":2,"amount_minor":1000,"currency":"EUR","notes":"bar","proof_document_id":null,"status":"active","paid_at":"<volatile>","created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","amount":"10.00","reversed_at":"2026-11-18T12:00:00Z","reversed_by":2}}},
  's reverse again': {"status":409,"body":{"error":"Settlement is already reversed.","code":409}},
  's reverse own by member': {"status":200,"body":{"data":{"id":2,"group_id":1,"payer_id":3,"payee_id":2,"amount_minor":200,"currency":"EUR","notes":null,"proof_document_id":null,"status":"active","paid_at":"<volatile>","created_by":3,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","amount":"2.00","reversed_at":"2026-11-18T12:00:00Z","reversed_by":3}}},
  's reverse missing': {"status":404,"body":{"error":"Settlement not found.","code":404}},
  's reverse zero': {"status":404,"body":{"error":"Settlement not found.","code":404}},
  's reverse other group': {"status":404,"body":{"error":"Settlement not found.","code":404}},
  's reverse out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'a list': {"status":200,"body":{"data":[{"id":1,"group_id":1,"actor_id":2,"type":"group_created","entity_type":"group","entity_id":1,"metadata":{"name":"WG"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":4,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":6,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":7,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":8,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"}],"pagination":{"limit":5,"offset":0,"has_more":true,"next_cursor":{"before_at":"2026-11-18T12:00:00Z","before_id":8}}}},
  'a list all': {"status":200,"body":{"data":[{"id":1,"group_id":1,"actor_id":2,"type":"group_created","entity_type":"group","entity_id":1,"metadata":{"name":"WG"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":4,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":6,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":7,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":8,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":9,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":12,"group_id":1,"actor_id":2,"type":"member_added","entity_type":"member","entity_id":3,"metadata":{"role":"guest"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":16,"group_id":1,"actor_id":2,"type":"guest_created","entity_type":"member","entity_id":5,"metadata":{"display_name":"Gast"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":17,"group_id":1,"actor_id":2,"type":"guest_created","entity_type":"member","entity_id":6,"metadata":{"display_name":"Zweiter Gast"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":18,"group_id":1,"actor_id":2,"type":"guest_created","entity_type":"member","entity_id":7,"metadata":{"display_name":"Kurz Name"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":19,"group_id":1,"actor_id":2,"type":"guest_created","entity_type":"member","entity_id":8,"metadata":{"display_name":"Ohne Name"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":20,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":1,"deleted_at":null}},{"id":21,"group_id":1,"actor_id":3,"type":"expense_created","entity_type":"expense","entity_id":2,"metadata":{"title":"Brot","amount_minor":320,"currency":"EUR","amount":"3.20"},"created_at":"2026-11-18T12:00:00Z","actor_name":"mia","actor_color":"#007AFF","expense":{"id":2,"deleted_at":null}},{"id":22,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":3,"metadata":{"title":"Kino","amount_minor":2000,"currency":"USD","amount":"20.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":3,"deleted_at":null}},{"id":23,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":4,"metadata":{"title":"Snack","amount_minor":400,"currency":"USD","amount":"4.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":4,"deleted_at":null}},{"id":24,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":5,"metadata":{"title":"Strom","amount_minor":4000,"currency":"EUR","amount":"40.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":5,"deleted_at":null}},{"id":25,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":6,"metadata":{"title":"Wasser","amount_minor":900,"currency":"EUR","amount":"9.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":6,"deleted_at":null}},{"id":26,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":7,"metadata":{"title":"Gas","amount_minor":1000,"currency":"EUR","amount":"10.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":7,"deleted_at":null}},{"id":27,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":8,"metadata":{"title":"Heute","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":8,"deleted_at":null}},{"id":28,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":9,"metadata":{"title":"Zahler null","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":9,"deleted_at":null}},{"id":29,"group_id":1,"actor_id":2,"type":"expense_created","entity_type":"expense","entity_id":10,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF","expense":{"id":10,"deleted_at":null}},{"id":30,"group_id":1,"actor_id":5,"type":"expense_created","entity_type":"expense","entity_id":11,"metadata":{"title":"Vom Gast","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"Gast","actor_color":"#007AFF","expense":{"id":11,"deleted_at":null}},{"id":31,"group_id":1,"actor_id":2,"type":"expense_edited","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf groß","amount_minor":3200,"currency":"EUR","amount":"32.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":32,"group_id":1,"actor_id":2,"type":"expense_edited","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":33,"group_id":1,"actor_id":2,"type":"expense_edited","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":34,"group_id":1,"actor_id":2,"type":"expense_edited","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"USD","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":35,"group_id":1,"actor_id":2,"type":"expense_edited","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":36,"group_id":1,"actor_id":2,"type":"expense_edited","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":37,"group_id":1,"actor_id":2,"type":"expense_edited","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":38,"group_id":1,"actor_id":2,"type":"expense_edited","entity_type":"expense","entity_id":1,"metadata":{"title":"Einkauf","amount_minor":3000,"currency":"EUR","amount":"30.00"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"}],"pagination":{"limit":30,"offset":0,"has_more":true,"next_cursor":{"before_at":"2026-11-18T12:00:00Z","before_id":38}}}},
  'a list offset': {"status":200,"body":{"data":[{"id":8,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":9,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":12,"group_id":1,"actor_id":2,"type":"member_added","entity_type":"member","entity_id":3,"metadata":{"role":"guest"},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"}],"pagination":{"limit":3,"offset":4,"has_more":true,"next_cursor":{"before_at":"2026-11-18T12:00:00Z","before_id":12}}}},
  'a list cursor': {"status":200,"body":{"data":[{"id":6,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":7,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"},{"id":8,"group_id":1,"actor_id":2,"type":"group_updated","entity_type":"group","entity_id":1,"metadata":{},"created_at":"2026-11-18T12:00:00Z","actor_name":"tom","actor_color":"#007AFF"}],"pagination":{"limit":3,"has_more":true,"next_cursor":{"before_at":"2026-11-18T12:00:00Z","before_id":8}}}},
  'a list cursor half': {"status":400,"body":{"error":"before_at and before_id belong together: take both from pagination.next_cursor.","code":400}},
  'a list cursor id zero': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/before_id","rule":"minimum"}]}},
  'a list cursor id letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/before_id","rule":"type"}]}},
  'a list cursor long': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/before_at","rule":"maxLength"}]}},
  'a list cursor and offset': {"status":400,"body":{"error":"Use either a cursor or offset, not both.","code":400}},
  'a list limit 0': {"status":200,"body":{"data":[],"pagination":{"limit":30,"offset":40,"has_more":false,"next_cursor":null}}},
  'a list limit 1.5': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/limit","rule":"type"}]}},
  'a list out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'a list zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'r create': {"status":201,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":50000,"currency":"EUR","payer_id":2,"category":"rent","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-12-01","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"500.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r create defaults': {"status":201,"body":{"data":{"id":2,"group_id":1,"title":"Netflix","description":null,"amount_minor":1299,"currency":"EUR","payer_id":3,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-11-30","paused_at":null,"created_by":3,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":30,"failed_at":null,"budget_category":null,"payer_name":"mia","amount":"12.99","participants":[3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r create skip past': {"status":201,"body":{"data":{"id":3,"group_id":1,"title":"Versicherung","description":null,"amount_minor":50000,"currency":"EUR","payer_id":2,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"weekly","next_run_date":"2026-11-19","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":null,"payer_name":"tom","amount":"500.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r create book past': {"status":201,"body":{"data":{"id":4,"group_id":1,"title":"Abo","description":null,"amount_minor":50000,"currency":"USD","payer_id":2,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"yearly","next_run_date":"2026-10-01","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":null,"payer_name":"tom","amount":"500.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r create missed null': {"status":201,"body":{"data":{"id":5,"group_id":1,"title":"Ohne Wahl","description":null,"amount_minor":50000,"currency":"EUR","payer_id":2,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-10-31","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":31,"failed_at":null,"budget_category":null,"payer_name":"tom","amount":"500.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r create missed unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_missed","fields":[{"path":"body/missed","rule":"enum","reason":"invalid_missed"}]}},
  'r create frequency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency","rule":"enum"}]}},
  'r create frequency missing': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency","rule":"required"}]}},
  'r create frequency proto': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency","rule":"enum"}]}},
  'r create method unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/split_method","rule":"enum"}]}},
  'r create category unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/category","rule":"enum"}]}},
  'r create currency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/currency","rule":"enum"}]}},
  'r create title spaces': {"status":400,"body":{"error":"Title must not be empty.","code":400}},
  'r create date not a day': {"status":400,"body":{"error":"Expense date must be a valid calendar date.","code":400}},
  'r create exact wrong': {"status":400,"body":{"error":"Each participant needs an exact split amount.","code":400}},
  'r create payer out': {"status":400,"body":{"error":"Payer must be a group member.","code":400}},
  'r create budget unknown': {"status":400,"body":{"error":"Unknown budget category.","code":400,"reason":"unknown_budget_category"}},
  'r create amount number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/amount","rule":"type"}]}},
  'r create no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'r create out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'r create zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'r list': {"status":200,"body":{"data":[{"id":4,"group_id":1,"title":"Abo","description":null,"amount_minor":50000,"currency":"USD","payer_id":2,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"yearly","next_run_date":"2026-10-01","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":null,"payer_name":"tom","amount":"500.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":false,"missed_count":0,"resume_date":null},{"id":5,"group_id":1,"title":"Ohne Wahl","description":null,"amount_minor":50000,"currency":"EUR","payer_id":2,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-10-31","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":31,"failed_at":null,"budget_category":null,"payer_name":"tom","amount":"500.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":false,"missed_count":0,"resume_date":null},{"id":3,"group_id":1,"title":"Versicherung","description":null,"amount_minor":50000,"currency":"EUR","payer_id":2,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"weekly","next_run_date":"2026-11-19","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":null,"payer_name":"tom","amount":"500.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":false,"missed_count":0,"resume_date":null},{"id":2,"group_id":1,"title":"Netflix","description":null,"amount_minor":1299,"currency":"EUR","payer_id":3,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-11-30","paused_at":null,"created_by":3,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":30,"failed_at":null,"budget_category":null,"payer_name":"mia","amount":"12.99","participants":[3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null},{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":50000,"currency":"EUR","payer_id":2,"category":"rent","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-12-01","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"500.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":false,"missed_count":0,"resume_date":null}]}},
  'r list out': {"status":404,"body":{"error":"Group not found.","code":404}},
  'r list zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'r put amount': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"rent","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-12-01","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put category': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-12-01","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put category null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/category","rule":"type"}]}},
  'r put category unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/category","rule":"enum"}]}},
  'r put frequency': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"equal","split_snapshot":"{\"participants\":[2,3],\"splits\":[]}","frequency":"yearly","next_run_date":"2026-12-01","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put frequency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency","rule":"enum"}]}},
  'r put frequency empty': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/frequency","rule":"enum"}]}},
  'r put method unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/split_method","rule":"enum"}]}},
  'r put method shares': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2026-12-01","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":1,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put currency unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/currency","rule":"enum"}]}},
  'r put missed unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_missed","fields":[{"path":"body/missed","rule":"enum","reason":"invalid_missed"}]}},
  'r put move skip': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2027-09-15","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":15,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put move book': {"status":200,"body":{"data":{"id":2,"group_id":1,"title":"Netflix","description":null,"amount_minor":1299,"currency":"EUR","payer_id":3,"category":"general","split_method":"equal","split_snapshot":"{\"participants\":[3],\"splits\":[]}","frequency":"monthly","next_run_date":"2026-10-30","paused_at":null,"created_by":3,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":30,"failed_at":null,"budget_category":null,"payer_name":"mia","amount":"12.99","participants":[3],"splits":[],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put participants text': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/participants","rule":"type"}]}},
  'r put title spaces': {"status":400,"body":{"error":"Title must not be empty.","code":400}},
  'r put title null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/title","rule":"type"}]}},
  'r put description clear': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2027-09-15","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":15,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put payer zero': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2027-09-15","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":15,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put payer zero text': {"status":400,"body":{"error":"Payer must be a group member.","code":400}},
  'r put empty': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2027-09-15","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":15,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r put no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'r put by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'r put by out': {"status":404,"body":{"error":"Recurring expense not found.","code":404}},
  'r put missing': {"status":404,"body":{"error":"Recurring expense not found.","code":404}},
  'r put zero': {"status":404,"body":{"error":"Recurring expense not found.","code":404}},
  'r put negative': {"status":404,"body":{"error":"Recurring expense not found.","code":404}},
  'r pause': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2027-09-15","paused_at":"<volatile>","created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":15,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":"2027-09-15"}}},
  'r pause resume book': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2027-09-15","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":15,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r pause again': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2027-09-15","paused_at":"<volatile>","created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":15,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":"2027-09-15"}}},
  'r pause resume skip': {"status":200,"body":{"data":{"id":1,"group_id":1,"title":"Miete","description":null,"amount_minor":55000,"currency":"EUR","payer_id":2,"category":"utilities","split_method":"shares","split_snapshot":"{\"participants\":[2,3],\"splits\":[{\"user_id\":2,\"shares\":3},{\"user_id\":3,\"shares\":1}]}","frequency":"yearly","next_run_date":"2027-09-15","paused_at":null,"created_by":2,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","anchor_day":15,"failed_at":null,"budget_category":"housing","payer_name":"tom","amount":"550.00","participants":[2,3],"splits":[{"user_id":2,"shares":3},{"user_id":3,"shares":1}],"blocked_reason":null,"can_edit":true,"missed_count":0,"resume_date":null}}},
  'r pause missed unknown': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_missed","fields":[{"path":"body/missed","rule":"enum","reason":"invalid_missed"}]}},
  'r pause missed number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_missed","fields":[{"path":"body/missed","rule":"type","reason":"invalid_missed"}]}},
  'r pause by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'r pause missing': {"status":404,"body":{"error":"Recurring expense not found.","code":404}},
  'r pause zero': {"status":404,"body":{"error":"Recurring expense not found.","code":404}},
  'r delete by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'r delete own by member': {"status":200,"body":{"data":{"ok":true}}},
  'r delete again': {"status":404,"body":{"error":"Recurring expense not found.","code":404}},
  'r delete zero': {"status":404,"body":{"error":"Recurring expense not found.","code":404}},
  'e delete by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'e delete own by member': {"status":200,"body":{"data":{"ok":true}}},
  'e delete again': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'e delete zero': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'e delete negative': {"status":404,"body":{"error":"Expense not found.","code":404}},
  'm remove owner': {"status":400,"body":{"error":"Group owner cannot be removed.","code":400}},
  'm remove by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'm remove missing': {"status":404,"body":{"error":"Member not found.","code":404}},
  'm remove zero': {"status":404,"body":{"error":"Member not found.","code":404}},
  'm remove negative': {"status":404,"body":{"error":"Member not found.","code":404}},
  'm remove letters': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/userId","rule":"type"}]}},
  'm remove g2': {"status":200,"body":{"data":{"ok":true}}},
  'g archive by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'g archive': {"status":200,"body":{"data":{"ok":true}}},
  'g archive zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g list archived': {"status":200,"body":{"data":[{"id":2,"name":"Reise","description":null,"type":"general","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"CHF","status":"archived","created_by":2,"archived_at":"<volatile>","created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":1,"member_role":"owner"}]}},
  'g archived patch': {"status":409,"body":{"error":"This group is archived. Restore it to make changes.","code":409,"reason":"group_archived"}},
  'g archived patch broken': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/type","rule":"enum"}]}},
  'g archived expense': {"status":409,"body":{"error":"This group is archived. Restore it to make changes.","code":409,"reason":"group_archived"}},
  'g archived member': {"status":409,"body":{"error":"This group is archived. Restore it to make changes.","code":409,"reason":"group_archived"}},
  'g archived guest': {"status":409,"body":{"error":"This group is archived. Restore it to make changes.","code":409,"reason":"group_archived"}},
  'g archived settlement': {"status":409,"body":{"error":"This group is archived. Restore it to make changes.","code":409,"reason":"group_archived"}},
  'g archived recurring': {"status":409,"body":{"error":"This group is archived. Restore it to make changes.","code":409,"reason":"group_archived"}},
  'g archived remove member': {"status":409,"body":{"error":"This group is archived. Restore it to make changes.","code":409,"reason":"group_archived"}},
  'g unarchive by member': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g unarchive': {"status":200,"body":{"data":{"ok":true}}},
  'g unarchive again': {"status":200,"body":{"data":{"ok":true}}},
  'g unarchive missing': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g delete history': {"status":409,"body":{"error":"Groups with financial history must be archived instead of deleted.","code":409}},
  'g delete by member': {"status":403,"body":{"error":"Not authorized.","code":403}},
  'g delete': {"status":200,"body":{"data":{"ok":true}}},
  'g delete again': {"status":404,"body":{"error":"Group not found.","code":404}},
  'g delete zero': {"status":404,"body":{"error":"Group not found.","code":404}},
  'search': {"status":200,"body":{"data":{"groups":[],"expenses":[{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"people":[]}}},
  'search empty': {"status":200,"body":{"data":{"groups":[{"id":1,"name":"WG","description":"Wohnung","type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":6,"member_role":"guest"},{"id":3,"name":"Urlaub","description":null,"type":"travel","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"USD","status":"active","created_by":1,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"shares","default_split_config":null,"creator_name":"linda","member_count":3,"member_role":"guest"}],"expenses":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]},{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","group_name":"WG","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]},{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]},{"id":9,"group_id":1,"title":"Zahler null","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-06","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":11,"group_id":1,"title":"Vom Gast","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":5,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-05","recurring_rule_id":null,"created_by":5,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"Gast","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":5,"amount_minor":1500,"currency":"EUR","display_name":"Gast","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"people":[{"id":5,"display_name":"Gast","username":"gast","avatar_color":"#007AFF"},{"id":7,"display_name":"Kurz Name","username":"kurz.name","avatar_color":"#007AFF"},{"id":1,"display_name":"linda","username":"linda","avatar_color":"#007AFF"},{"id":3,"display_name":"mia","username":"mia","avatar_color":"#007AFF"},{"id":8,"display_name":"Ohne Name","username":"ohne.name","avatar_color":"#007AFF"},{"id":2,"display_name":"tom","username":"tom","avatar_color":"#007AFF"},{"id":6,"display_name":"Zweiter Gast","username":"gast.zwei","avatar_color":"#007AFF"}]}}},
  'search guest': {"status":200,"body":{"data":{"groups":[],"expenses":[{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]},{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]},{"id":9,"group_id":1,"title":"Zahler null","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-06","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":11,"group_id":1,"title":"Vom Gast","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":5,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-05","recurring_rule_id":null,"created_by":5,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"Gast","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":5,"amount_minor":1500,"currency":"EUR","display_name":"Gast","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]}],"people":[{"id":5,"display_name":"Gast","username":"gast","avatar_color":"#007AFF"},{"id":7,"display_name":"Kurz Name","username":"kurz.name","avatar_color":"#007AFF"},{"id":3,"display_name":"mia","username":"mia","avatar_color":"#007AFF"},{"id":8,"display_name":"Ohne Name","username":"ohne.name","avatar_color":"#007AFF"},{"id":6,"display_name":"Zweiter Gast","username":"gast.zwei","avatar_color":"#007AFF"}]}}},
  'search out': {"status":200,"body":{"data":{"groups":[],"expenses":[],"people":[]}}},
  'search doubled': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/q","rule":"type"}]}},
  'dashboard': {"status":200,"body":{"data":{"total_owed":[{"currency":"EUR","user_id":2,"display_name":"tom","net_minor":7475,"amount_minor":7475,"amount":"74.75"},{"currency":"USD","user_id":2,"display_name":"tom","net_minor":100,"amount_minor":100,"amount":"1.00"}],"total_owing":[],"groups":[{"id":1,"name":"WG","description":"Wohnung","type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":6,"member_role":"owner"},{"id":3,"name":"Urlaub","description":null,"type":"travel","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"USD","status":"active","created_by":1,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"shares","default_split_config":null,"creator_name":"linda","member_count":3,"member_role":"admin"}],"recent_expenses":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]},{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","group_name":"WG","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]},{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]}]}}},
  'dashboard guest': {"status":200,"body":{"data":{"total_owed":[{"currency":"EUR","user_id":5,"display_name":"Gast","net_minor":1500,"amount_minor":1500,"amount":"15.00"}],"total_owing":[],"groups":[{"id":1,"name":"WG","description":"Wohnung","type":"couple","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"EUR","status":"active","created_by":2,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"equal","default_split_config":null,"creator_name":"tom","member_count":6,"member_role":"guest"}],"recent_expenses":[{"id":8,"group_id":1,"title":"Heute","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-18","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":3,"group_id":1,"title":"Kino","description":null,"amount_minor":2000,"currency":"USD","converted_amount_minor":1850,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"20.00","converted_amount":"18.50","splits":[{"user_id":3,"amount_minor":925,"currency":"EUR","display_name":"mia","amount":"9.25"},{"user_id":2,"amount_minor":925,"currency":"EUR","display_name":"tom","amount":"9.25"}],"attachments":[]},{"id":4,"group_id":1,"title":"Snack","description":null,"amount_minor":400,"currency":"USD","converted_amount_minor":400,"converted_currency":"USD","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-11","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"4.00","converted_amount":"4.00","splits":[{"user_id":3,"amount_minor":200,"currency":"USD","display_name":"mia","amount":"2.00"},{"user_id":2,"amount_minor":200,"currency":"USD","display_name":"tom","amount":"2.00"}],"attachments":[]},{"id":1,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":10,"group_id":1,"title":"Einkauf","description":null,"amount_minor":3000,"currency":"EUR","converted_amount_minor":3000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"equal","status":"active","expense_date":"2026-11-10","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"30.00","converted_amount":"30.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":1500,"currency":"EUR","display_name":"tom","amount":"15.00"}],"attachments":[]},{"id":5,"group_id":1,"title":"Strom","description":null,"amount_minor":4000,"currency":"EUR","converted_amount_minor":4000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"exact","status":"active","expense_date":"2026-11-09","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":"housing","group_name":"WG","payer_name":"tom","amount":"40.00","converted_amount":"40.00","splits":[{"user_id":3,"amount_minor":1500,"currency":"EUR","display_name":"mia","amount":"15.00"},{"user_id":2,"amount_minor":2500,"currency":"EUR","display_name":"tom","amount":"25.00"}],"attachments":[]},{"id":6,"group_id":1,"title":"Wasser","description":null,"amount_minor":900,"currency":"EUR","converted_amount_minor":900,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"shares","status":"active","expense_date":"2026-11-08","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"9.00","converted_amount":"9.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":600,"currency":"EUR","display_name":"tom","amount":"6.00"}],"attachments":[]},{"id":7,"group_id":1,"title":"Gas","description":null,"amount_minor":1000,"currency":"EUR","converted_amount_minor":1000,"converted_currency":"EUR","exchange_rate_num":1,"exchange_rate_den":1,"exchange_snapshot":"null","payer_id":2,"category":"groceries","split_method":"percentage","status":"active","expense_date":"2026-11-07","recurring_rule_id":null,"created_by":2,"deleted_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","budget_category":null,"group_name":"WG","payer_name":"tom","amount":"10.00","converted_amount":"10.00","splits":[{"user_id":3,"amount_minor":300,"currency":"EUR","display_name":"mia","amount":"3.00"},{"user_id":2,"amount_minor":700,"currency":"EUR","display_name":"tom","amount":"7.00"}],"attachments":[]}]}}},
  'dashboard admin': {"status":200,"body":{"data":{"total_owed":[],"total_owing":[],"groups":[{"id":3,"name":"Urlaub","description":null,"type":"travel","avatar_color":"#0F766E","avatar_document_id":null,"default_currency":"USD","status":"active","created_by":1,"archived_at":null,"created_at":"2026-11-18T12:00:00Z","updated_at":"2026-11-18T12:00:00Z","default_split_method":"shares","default_split_config":null,"creator_name":"linda","member_count":3,"member_role":"owner"}],"recent_expenses":[]}}},
  'bk status': {"status":200,"body":{"data":{"schema_version":"<schema version>","restore_upload_limit":"4mb","scheduler":{"enabled":true,"schedule":"0 2 * * *","backupDir":"<tmp>/backups","keepCount":7,"running":false,"lastBackup":null,"lastError":null,"lastSuccess":null,"nextRun":null,"timezone":"<process zone>","webdav":{"enabled":false,"configured":false,"url":null,"username":null,"password":null,"remotePath":"/yuvomi/backups/","keep":7,"lastUpload":null,"lastError":null,"envControlled":false}},"database_key":{"origin":null,"encrypted":false}}}},
  'bk status member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'bk key': {"status":200,"body":{"data":{"origin":null,"encrypted":false}}},
  'bk key member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'bk download': {"status":200,"body":"<SQLite format 3>"},
  'bk download member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'bk restore empty': {"status":400,"body":{"error":"Backup file is required.","code":400,"reason":"backup_file_empty"}},
  'bk restore garbage': {"status":400,"body":{"error":"Backup file could not be read: it has no plain SQLite header, so it is likely encrypted - and DB_ENCRYPTION_KEY is not set on this instance, so there is nothing to decrypt it with. A backup carries the encryption of the instance that wrote it: set DB_ENCRYPTION_KEY to that instance's key and restart Yuvomi, then restore again. If the file was never encrypted, it is not a valid Yuvomi database.","code":400,"reason":"own_key_missing"}},
  'bk restore bad key': {"status":400,"body":{"error":"X-Backup-Key must be the backup key encoded as base64 (UTF-8 bytes).","code":400,"reason":"backup_key_invalid"}},
  'bk restore member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'bk trigger': {"status":200,"body":{"data":{"timestamp":"2026-11-18T12:00:00.000Z","file":"yuvomi-backup-2026-11-18T12-00-00-000Z.db","success":true}}},
  'bk trigger member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'dav get empty': {"status":200,"body":{"data":{"enabled":false,"configured":false,"url":null,"username":null,"password":null,"remotePath":"/yuvomi/backups/","keep":7,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav test incomplete': {"status":400,"body":{"error":"URL, username and password are required.","code":400,"errorCode":"config_incomplete"}},
  'dav files unconfigured': {"status":502,"body":{"error":"The WebDAV server refused the request or could not be reached.","code":502,"reason":"remote_failed"}},
  'dav put': {"status":200,"body":{"data":{"enabled":true,"configured":true,"url":"<dav>","username":"dav","password":"****","remotePath":"/backups/","keep":7,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav get': {"status":200,"body":{"data":{"enabled":true,"configured":true,"url":"<dav>","username":"dav","password":"****","remotePath":"/backups/","keep":7,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav get member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'dav put enabled text': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  'dav put enabled null': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  'dav put url number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/url","rule":"type"}]}},
  'dav put url ftp': {"status":400,"body":{"error":"url must start with http:// or https://.","errorCode":"url_invalid","code":400}},
  'dav put url spaces': {"status":200,"body":{"data":{"enabled":true,"configured":true,"url":"<dav>","username":"dav","password":"****","remotePath":"/backups/","keep":7,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav put url empty': {"status":200,"body":{"data":{"enabled":true,"configured":false,"url":null,"username":"dav","password":"****","remotePath":"/backups/","keep":7,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav put url back': {"status":200,"body":{"data":{"enabled":true,"configured":true,"url":"<dav>","username":"dav","password":"****","remotePath":"/backups/","keep":7,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav put keep zero': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/keep","rule":"minimum"}]}},
  'dav put keep fraction': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/keep","rule":"type"}]}},
  'dav put keep text': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/keep","rule":"type"}]}},
  'dav put keep 3': {"status":200,"body":{"data":{"enabled":true,"configured":true,"url":"<dav>","username":"dav","password":"****","remotePath":"/backups/","keep":3,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav put username number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/username","rule":"type"}]}},
  'dav put new user no password': {"status":400,"body":{"error":"A new server or username needs the password again.","errorCode":"password_required","code":400}},
  'dav put remote path': {"status":200,"body":{"data":{"enabled":true,"configured":true,"url":"<dav>","username":"dav","password":"****","remotePath":"/elsewhere/","keep":3,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav put remote path list': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/remotePath","rule":"type"}]}},
  'dav put empty': {"status":200,"body":{"data":{"enabled":true,"configured":true,"url":"<dav>","username":"dav","password":"****","remotePath":"/elsewhere/","keep":3,"lastUpload":null,"lastError":null,"envControlled":false}}},
  'dav put no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'dav put member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'dav put member broken': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'dav test': {"status":200,"body":{"data":{"ok":true,"files":1}}},
  'dav test url number': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/url","rule":"type"}]}},
  'dav test new user no password': {"status":400,"body":{"error":"A new server or username needs the password again.","errorCode":"password_required","code":400}},
  'dav test mask': {"status":200,"body":{"data":{"ok":true,"files":1}}},
  'dav test no body': {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  'dav files': {"status":200,"body":{"data":[{"filename":"yuvomi-backup-2026-01-01T00-00-00-000Z.db","lastmod":"Wed, 01 Jan 2026 00:00:00 GMT","remotePath":"/backups/yuvomi-backup-2026-01-01T00-00-00-000Z.db"}]}},
  'dav trigger': {"status":200,"body":{"data":{"file":"yuvomi-backup-2026-11-18T12-00-00-000Z.db","timestamp":"2026-11-18T12:00:00.000Z"}}},
  'dav trigger member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'sys diagnostics': {"status":200,"body":{"data":{"arch":"string","backup":"object","build_revision":"null","data_dir_free_bytes":"number","database_bytes":"number","key_source":"null","last_migration_at":"string","modules_installed":"number","node":"string","platform":"string","ready":"object","schema_version":"number","sqlite":"object","uptime_seconds":"number","version":"string","wal_bytes":"number"}}},
  'sys diagnostics member': {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  'changelog': {"status":200,"body":{"data":{"current_in_releases":"boolean","current_version":"string","latest_version":"null","releases":"array","source":"string"}}},
  'changelog member': {"status":200,"body":{"data":{"current_in_releases":"boolean","current_version":"string","latest_version":"null","releases":"array","source":"string"}}},
};

/**
 * The actor of a row: `GUEST` is the split guest, created by a row above.
 * @param {CallOptions | undefined} opts
 * @returns {CallOptions | undefined}
 */
function resolved(opts) {
  return opts?.actor === 'GUEST' ? { ...opts, actor: ids.guest } : opts;
}

/** Runs the table and returns each row's answer, normalized. */
async function runTable() {
  /** @type {Record<string, { status: number, body: unknown }>} */
  const answers = {};
  for (const step of STEPS) {
    if (typeof step === 'function') { await step(); continue; }
    const [name, method, route, body, opts] = step;
    assert.ok(!Object.hasOwn(answers, name), `duplicate row name ${name}`);
    const actual = await call(method, typeof route === 'function' ? route() : route, typeof body === 'function' ? body() : body, resolved(opts));
    answers[name] = { status: actual.status, body: opts?.shape ? shapeOf(actual.body) : normalized(actual.body) };
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
 * @param {Array<[string, string, unknown, string, (string | number)?]>} rows [method, path under /api/v1, body, route pattern under /api/v1, actor]
 */
async function assertAllCentral(rows) {
  for (const [method, route, body, pattern, actor] of rows) {
    assertCentral(await call(method, route, body, { fail: true, actor: actor ?? 'admin' }), method, `/api/v1${pattern}`);
  }
}

test('split expenses: an unexpected error in each of the 28 routes is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const S = '/split-expenses';
  await assertAllCentral([
    ['GET', `${S}/meta`, NO_BODY, `${S}/meta`],
    ['GET', `${S}/dashboard`, NO_BODY, `${S}/dashboard`],
    ['GET', `${S}/groups`, NO_BODY, `${S}/groups`],
    ['POST', `${S}/groups`, { name: 'Probe' }, `${S}/groups`, 'owner'],
  ]);
  const group = lastId('expense_groups');
  await assertAllCentral([
    ['PATCH', `${S}/groups/${group}`, { name: 'Probe' }, `${S}/groups/:id`, 'owner'],
    ['POST', `${S}/groups/${group}/members`, { user_id: MEM }, `${S}/groups/:id/members`, 'owner'],
    ['GET', `${S}/groups/${group}/members`, NO_BODY, `${S}/groups/:id/members`, 'owner'],
    ['GET', `${S}/groups/${group}/member-candidates`, NO_BODY, `${S}/groups/:id/member-candidates`, 'owner'],
    ['POST', `${S}/groups/${group}/guests`, { display_name: 'Probegast', password: 'geheim123' }, `${S}/groups/:id/guests`, 'owner'],
    ['POST', `${S}/groups/${group}/expenses`, { title: 'Probe', amount: '5.00', participants: [OWNER, MEM] }, `${S}/groups/:id/expenses`, 'owner'],
  ]);
  const expense = lastId('expenses');
  await assertAllCentral([
    ['GET', `${S}/groups/${group}/expenses`, NO_BODY, `${S}/groups/:id/expenses`, 'owner'],
    ['PUT', `${S}/expenses/${expense}`, { ...REPLACE, title: 'Probe', amount: '6.00' }, `${S}/expenses/:id`, 'owner'],
    ['POST', `${S}/expenses/${expense}/comments`, { comment: 'Probe' }, `${S}/expenses/:id/comments`, 'owner'],
    ['GET', `${S}/groups/${group}/balances`, NO_BODY, `${S}/groups/:id/balances`, 'owner'],
    ['POST', `${S}/groups/${group}/settlements`, { payer_id: MEM, payee_id: OWNER, amount: '1.00' }, `${S}/groups/:id/settlements`, 'owner'],
  ]);
  const settlement = lastId('settlements');
  await assertAllCentral([
    ['POST', `${S}/groups/${group}/settlements/${settlement}/reverse`, NO_BODY, `${S}/groups/:id/settlements/:settlementId/reverse`, 'owner'],
    ['GET', `${S}/groups/${group}/activity`, NO_BODY, `${S}/groups/:id/activity`, 'owner'],
    ['POST', `${S}/groups/${group}/recurring`, { title: 'Probe', amount: '5.00', frequency: 'monthly', next_run_date: '2026-12-01' }, `${S}/groups/:id/recurring`, 'owner'],
  ]);
  const recurring = lastId('recurring_expenses');
  await assertAllCentral([
    ['GET', `${S}/groups/${group}/recurring`, NO_BODY, `${S}/groups/:id/recurring`, 'owner'],
    ['PUT', `${S}/recurring/${recurring}`, { amount: '6.00' }, `${S}/recurring/:id`, 'owner'],
    ['POST', `${S}/recurring/${recurring}/pause`, NO_BODY, `${S}/recurring/:id/pause`, 'owner'],
    ['DELETE', `${S}/recurring/${recurring}`, NO_BODY, `${S}/recurring/:id`, 'owner'],
    ['DELETE', `${S}/expenses/${expense}`, NO_BODY, `${S}/expenses/:id`, 'owner'],
    ['DELETE', `${S}/groups/${group}/members/${MEM}`, NO_BODY, `${S}/groups/:id/members/:userId`, 'owner'],
    ['GET', `${S}/search?q=Probe`, NO_BODY, `${S}/search`, 'owner'],
    ['POST', `${S}/groups/${group}/archive`, NO_BODY, `${S}/groups/:id/archive`, 'owner'],
    ['POST', `${S}/groups/${group}/unarchive`, NO_BODY, `${S}/groups/:id/unarchive`, 'owner'],
  ]);
  const empty = (await call('POST', `${S}/groups`, { name: 'Leer' }, { actor: 'owner' })).body.data.id;
  await assertAllCentral([
    ['DELETE', `${S}/groups/${empty}`, NO_BODY, `${S}/groups/:id`, 'owner'],
  ]);
  assert.equal((await call('GET', `${S}/meta`, NO_BODY)).status, 200, 'answers again');
});

test('backup and core: an unexpected error in each route without an own answer is a 500 of the central handler', async () => {
  logged.error.length = 0;
  await assertAllCentral([
    ['GET', '/backup/status', NO_BODY, '/backup/status'],
    ['GET', '/backup/database-key', NO_BODY, '/backup/database-key'],
    ['GET', '/backup/database', NO_BODY, '/backup/database'],
    ['POST', '/backup/trigger', NO_BODY, '/backup/trigger'],
    ['GET', '/backup/webdav/config', NO_BODY, '/backup/webdav/config'],
    ['PUT', '/backup/webdav/config', { keep: 3 }, '/backup/webdav/config'],
    ['GET', '/system/diagnostics', NO_BODY, '/system/diagnostics'],
    ['GET', '/changelog', NO_BODY, '/changelog/'],
  ]);
  assert.equal((await call('GET', '/backup/status', NO_BODY)).status, 200, 'answers again');
});

test('the 500 sentence of three backup routes is the central one (the visible change of #2810 group 5)', async () => {
  // Before: { error: 'Database backup failed.' }, { error: 'Backup trigger failed.' },
  // { error: 'Failed to save WebDAV config.' }, each with code 500 and an own log line.
  logged.error.length = 0;
  const answers = [];
  for (const [method, route, body] of /** @type {Array<[string, string, unknown]>} */ ([
    ['GET', '/backup/database', NO_BODY],
    ['POST', '/backup/trigger', NO_BODY],
    ['PUT', '/backup/webdav/config', { keep: 3 }],
  ])) {
    answers.push([`${method} ${route}`, await call(method, route, body, { fail: true })]);
  }
  logged.error.length = 0;
  assert.deepEqual(answers, [
    ['GET /backup/database', { status: 500, body: { error: 'Internal server error.', code: 500 } }],
    ['POST /backup/trigger', { status: 500, body: { error: 'Internal server error.', code: 500 } }],
    ['PUT /backup/webdav/config', { status: 500, body: { error: 'Internal server error.', code: 500 } }],
  ]);
});

test('the handled cases keep their own answer and never reach the central handler', async () => {
  logged.error.length = 0;
  const S = '/split-expenses';
  const group = (await call('POST', `${S}/groups`, { name: 'Handfall' }, { actor: 'owner' })).body.data.id;
  await call('POST', `${S}/groups/${group}/members`, { user_id: MEM }, { actor: 'owner' });
  // Refusal: 400 with its reason (budget category), 409 with its reason (archived).
  assert.deepEqual(await call('POST', `${S}/groups/${group}/expenses`, EXPENSE({ budget_category: 'nope' }), { actor: 'owner' }), EXPECTED['e create budget unknown']);
  // SplitInputError: 400 with its sentence.
  assert.deepEqual(await call('POST', `${S}/groups/${group}/expenses`, EXPENSE({ amount: '-1.00' }), { actor: 'owner' }), EXPECTED['e create amount negative']);
  assert.deepEqual(await call('POST', `${S}/groups/${group}/recurring`, RECURRING({ split_method: 'exact', splits: [{ user_id: OWNER, amount: '1.00' }] }), { actor: 'owner' }),
    EXPECTED['r create exact wrong']);
  // Refusal from inside the transaction of PUT /recurring: 400 with reason and last_booked.
  const series = (await call('POST', `${S}/groups/${group}/recurring`, RECURRING({ next_run_date: '2026-12-01' }), { actor: 'owner' })).body.data.id;
  database().prepare("INSERT INTO expenses (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, expense_date, recurring_rule_id, created_by) VALUES (?, 'Gebucht', 100, 'EUR', 100, 'EUR', ?, '2026-12-01', ?, ?)")
    .run(group, OWNER, series, OWNER);
  assert.deepEqual(await call('PUT', `${S}/recurring/${series}`, { next_run_date: '2026-11-25' }, { actor: 'owner' }), {
    status: 400,
    body: { error: 'next_run_date must be after the last booked date (2026-12-01).', code: 400, reason: 'next_run_not_after_last_booking', last_booked: '2026-12-01' },
  });
  await call('POST', `${S}/groups/${group}/archive`, NO_BODY, { actor: 'owner' });
  assert.deepEqual(await call('POST', `${S}/groups/${group}/expenses`, EXPENSE(), { actor: 'owner' }), EXPECTED['g archived expense']);
  assert.deepEqual(await call('PUT', `${S}/recurring/${series}`, { amount: '2.00' }, { actor: 'owner' }), EXPECTED['g archived expense']);

  // backup_local_failed and the 502 of the WebDAV server.
  const closed = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {any} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
  assert.equal((await call('PUT', '/backup/webdav/config', { enabled: true, url: `http://127.0.0.1:${closed}`, username: 'dav', password: 'x', remotePath: '/backups/', keep: 7 })).status, 200);
  const unreachable = await call('GET', '/backup/webdav/files', NO_BODY);
  assert.deepEqual(unreachable, {
    status: 502,
    body: { error: 'The WebDAV server refused the request or could not be reached.', code: 502, reason: 'remote_unreachable', detail: 'ECONNREFUSED' },
  });
  assert.equal((await call('PUT', '/backup/webdav/config', { url: davOrigin, password: 's3cret' })).status, 200);
  // A local failure: the handler's own answer throws inside its try.
  assert.deepEqual(await call('GET', '/backup/webdav/files', NO_BODY, { fail: true }), {
    status: 502, body: { error: 'The WebDAV server refused the request or could not be reached.', code: 502, reason: 'remote_failed' },
  });
  // errorCode: config_incomplete, password_required, url_invalid.
  assert.deepEqual(await call('PUT', '/backup/webdav/config', { url: 'ftp://x' }), EXPECTED['dav put url ftp']);
  assert.deepEqual(await call('PUT', '/backup/webdav/config', { username: 'other' }), EXPECTED['dav put new user no password']);
  // Restore reasons: an empty file, a key header that is not base64.
  assert.deepEqual(await call('POST', '/backup/restore', NO_BODY, { raw: Buffer.alloc(0) }), EXPECTED['bk restore empty']);
  assert.deepEqual(await call('POST', '/backup/restore', NO_BODY, { raw: Buffer.from('x'), headers: { 'X-Backup-Key': '***' } }), EXPECTED['bk restore bad key']);

  // backup_verify_failed: a backup whose integrity check fails (#2520).
  const live = database();
  live.exec('CREATE TABLE probe_answers (x INTEGER, y INTEGER); CREATE INDEX probe_answers_x ON probe_answers (x);');
  const insert = live.prepare('INSERT INTO probe_answers VALUES (?, ?)');
  for (let i = 0; i < 20; i++) insert.run(i, 1000 - i);
  live.unsafeMode(true);
  live.pragma('writable_schema = ON');
  live.prepare("UPDATE sqlite_master SET sql = 'CREATE INDEX probe_answers_x ON probe_answers (y)' WHERE name = 'probe_answers_x'").run();
  live.pragma('writable_schema = OFF');
  live.unsafeMode(false);
  try {
    assert.deepEqual(await call('GET', '/backup/database', NO_BODY, { actor: 'admin' }), {
      status: 500, body: { error: 'Database backup failed.', code: 500, reason: 'backup_verify_failed' },
    });
    const up = await call('POST', '/backup/webdav/trigger', NO_BODY);
    assert.deepEqual(up, { status: 500, body: { error: 'The local backup could not be created.', code: 500, reason: 'backup_local_failed' } });
  } finally {
    live.exec('DROP INDEX probe_answers_x; DROP TABLE probe_answers;');
  }
  assert.deepEqual(logged.error, [], 'none reached the central handler');
});
