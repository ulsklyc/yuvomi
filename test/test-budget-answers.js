/**
 * Test: the answers of the budget and the subscriptions stay byte-equal
 *       (#2810, phase 2 section E, group 9, step b)
 * Purpose: server/routes/budget/*.js (accounts 4, categories 11, entries 9,
 *          loans 7, plans 3, stats 1, transfers 4 operations) and
 *          server/routes/subscriptions.js (17) dropped the hand checks the
 *          schema of their operation already covers (`validateRequest()` runs
 *          before every handler since #2871) and the try/catch blocks that
 *          answered an unexpected error with a 500 of their own. This suite
 *          holds that refactor: for a table of requests to all 56 operations -
 *          valid, every refusal of the handler that stays (each `reason`, empty
 *          or too long after trimming, ranges, the calendar day, cross-field
 *          rules, an account, category or loan that does not exist, the
 *          personal budget mode, path ids `0`, `-1`, `-0` and with a leading
 *          zero), every input a dropped hand check refused (now the schema's
 *          400), not found and rights - for an admin, a member, a second
 *          member, a member without the documents right and a split-expense
 *          guest, it pins status and the WHOLE body (the CSV export: its type,
 *          disposition and bytes). The expectations were written before the
 *          refactor (71649bee8) and are literal values in
 *          test/budget-answers-expected.js (a module of its own only for the
 *          line limit), no fixture file, no update mode. The logo search and
 *          the exchange rates of a booking are stand-ins (`_setLogoFinderForTest`,
 *          `_setRatesForTest`), FIXER_API_KEY is unset: no network. SQLite
 *          stamps rows with its own clock, which mock.timers does not reach:
 *          test triggers pin `created_at`, `updated_at` is masked, so is the
 *          random undo token. The clock stands still (`mock.timers`,
 *          18.11.2026 12:00 UTC), the household lives in Europe/Berlin.
 *
 *          The second part: an unexpected error in every route that answered
 *          its own 500 reaches the central error handler - 500 with its fixed
 *          sentence and its log line `Unhandled error: <METHOD> <pattern> ->
 *          500` - and the process keeps answering. The budget routes said
 *          `Internal error`, the subscription routes a sentence of their own
 *          (the visible change of this PR); async handlers (a rejected
 *          promise) included.
 *
 *          The third part: what stays the route's own - the `UNIQUE` 409s, the
 *          subscription that went during its booking (404), the renewal that
 *          waits for its exchange rate, the logo search's 400/404/502, the
 *          document link refusal and deletion lock, the restore gate - keeps
 *          its answer and never reaches the central handler.
 *
 *          The fourth part: each handler alone (without `validateRequest()`)
 *          keeps the type checks in front of a loop, `.map()` or a string
 *          method on a raw value (sink, not route).
 * Run: npm run test:budget-answers
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = 'budget-answers-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-budget-answers-');
delete process.env.FIXER_API_KEY;

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { createBudgetApp } from './budget-app.js';
import { EXPECTED, CHANGED } from './budget-answers-expected.js';

const dbmod = await import('../server/db.js');
const { MAX_TITLE, MAX_SHORT } = await import('../server/middleware/validate.js');
const subscriptionRoutes = await import('../server/routes/subscriptions.js');
const restoreState = await import('../server/utils/restore-state.js');
const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
const database = () => dbmod.get();

/** @param {string} key @param {string} value */
function setConfig(key, value) {
  database().prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
setConfig('household_timezone', 'Europe/Berlin');
setConfig('currency', 'EUR');
setConfig('budget_mode', 'shared');
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

// SQLite stamps rows with its own clock, which mock.timers does not reach.
const STAMP = '2026-11-18T12:00:00Z';
for (const { name } of database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'budget%' OR name LIKE 'subscription%' OR name = 'family_documents')").all()) {
  const columns = database().prepare(`PRAGMA table_info(${name})`).all().map((/** @type {any} */ c) => c.name);
  if (!columns.includes('created_at')) continue;
  database().exec(`CREATE TRIGGER test_pin_${name}_created_at AFTER INSERT ON ${name} FOR EACH ROW BEGIN UPDATE ${name} SET created_at = '${STAMP}' WHERE rowid = NEW.rowid; END;`);
}
for (const table of ['subscription_categories', 'subscription_payment_methods', 'budget_categories', 'budget_subcategories']) {
  const columns = database().prepare(`PRAGMA table_info(${table})`).all().map((/** @type {any} */ c) => c.name);
  if (columns.includes('created_at')) database().prepare(`UPDATE ${table} SET created_at = ?`).run(STAMP);
}

/** @param {string} username @param {string} role @param {string} [familyRole] */
function user(username, role, familyRole = 'parent') {
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const MEM = user('tom', 'member');
const OTHER = user('ole', 'member');
const NODOCS = user('ida', 'member');
const GUEST = user('gast', 'member', 'other');
// A split-expense guest: a users row that is no household member.
const GROUP = Number(database().prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(ADMIN).lastInsertRowid);
database().prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(GUEST, GROUP, ADMIN);

/** @param {string} name @param {number} createdBy @param {string} [visibility] */
function documentRow(name, createdBy, visibility = 'family') {
  return Number(database().prepare(`
    INSERT INTO family_documents (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'finance', ?, ?, 'application/pdf', 1234, 'data:application/pdf;base64,AA==', ?)
  `).run(name, visibility, `${name}.pdf`, createdBy).lastInsertRowid);
}
const DOC = documentRow('Beleg', ADMIN);
const DOC_LOCKED = documentRow('Gesperrt', ADMIN);
const DOC_PRIVATE = documentRow('Fremd', MEM, 'private');

/** @type {Record<string, { id: number, role: string, access?: Record<string, string> }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  other: { id: OTHER, role: 'member' },
  nodocs: { id: NODOCS, role: 'member', access: { documents: 'none' } },
  gast: { id: GUEST, role: 'member' },
};

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createBudgetApp({
  log,
  jsonLimit: '2mb',
  // A generous limiter in front of the routes, as the app has one.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = 'session';
    req.authScopes = null;
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
test.after(() => {
  subscriptionRoutes._setLogoFinderForTest(null);
  subscriptionRoutes._setRatesForTest(null);
  server.close();
});

// ── Stand-ins: no network ────────────────────────────────────────────────────
/** What the logo finder answers, chosen by the query. */
async function logoFinder(/** @type {string} */ query) {
  if (query === 'none') return [];
  if (query === 'refused') throw Object.assign(new Error('That address is not allowed.'), { code: 'logo_search_refused' });
  if (query === 'down') throw Object.assign(new Error('getaddrinfo ENOTFOUND logo.example'), { code: 'ENOTFOUND' });
  if (query === 'database') throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  return [{ logo_data: 'data:image/png;base64,iVBORw0KGgo=', source: `https://${query}/favicon.png` }];
}
subscriptionRoutes._setLogoFinderForTest(logoFinder);
/** The exchange rates of a booking: `ok`, `fail` (no rate yet) or `vanish` (the subscription goes meanwhile). */
const rates = { mode: 'ok', vanish: 0 };
subscriptionRoutes._setRatesForTest(async () => {
  if (rates.mode === 'fail') throw new Error('rates unavailable');
  if (rates.mode === 'vanish') database().prepare('DELETE FROM budget_subscriptions WHERE id = ?').run(rates.vanish);
  return { rates: { EUR: 1, USD: 1.1 }, fetchedAt: STAMP, source: 'stub' };
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
  const type = res.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await res.arrayBuffer());
  if (type.includes('application/json')) return { status: res.status, body: JSON.parse(bytes.toString('utf8')) };
  if (bytes.length === 0) return { status: res.status, body: null };
  return {
    status: res.status,
    body: {
      type,
      disposition: res.headers.get('content-disposition'),
      expectedUntil: res.headers.get('x-budget-expected-until'),
      text: bytes.toString('utf8'),
    },
  };
}

// Stamps of SQLite's own clock the triggers do not pin (`updated_at`, the
// `completed_at` of a subscription), and the random undo token.
const VOLATILE = new Set(['updated_at', 'completed_at', 'token']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (VOLATILE.has(key) && typeof v === 'string' && v !== STAMP) return '<volatile>';
    return v;
  });
}

/** @type {Record<string, any>} */
const ids = {};
/** @type {Record<string, any>} */
const answered = {};
const lastId = (/** @type {string} */ table) => database().prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`).get()?.id;
const LONG = (/** @type {number} */ n) => 'x'.repeat(n);
const SPACES = '   ';
const ENTRY = (/** @type {Record<string, unknown>} */ over = {}) => ({ title: 'Einkauf', amount: -20, category: 'food', date: '2026-11-03', ...over });
const LOAN = (/** @type {Record<string, unknown>} */ over = {}) => ({ title: 'Auto', borrower: 'Bank', start_month: '2026-01', total_amount: 1200, installment_count: 12, ...over });
const SUB = (/** @type {Record<string, unknown>} */ over = {}) => ({ name: 'Netflix', amount: 12.99, currency: 'EUR', billing_cycle: 'monthly', next_payment_date: '2026-12-01', ...over });
const TRANSFER = (/** @type {Record<string, unknown>} */ over = {}) => ({ title: 'Sparen', amount: 100, date: '2026-11-10', from_account_id: ids.acc, to_account_id: ids.acc2, ...over });
const PNG_AS_JPEG = 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const B = '/budget';
const S = '/budget/subscriptions';

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ ACCOUNTS ═══════════════════════════════════════════════════════════════
  ['acc list empty', 'GET', `${B}/accounts`, NO_BODY],
  ['acc create', 'POST', `${B}/accounts`, { name: ' Giro ', type: 'checking', starting_balance: 100, currency: 'EUR', color: '#112233' }],
  () => { ids.acc = lastId('budget_accounts'); },
  ['acc create savings', 'POST', `${B}/accounts`, { name: 'Spar', type: 'savings', starting_balance: 0 }],
  () => { ids.acc2 = lastId('budget_accounts'); },
  ['acc create credit', 'POST', `${B}/accounts`, { name: 'Karte', type: 'credit', credit_bank: ' Bank ', credit_limit: 500, color: 'var(--chart-series-3)' }],
  () => { ids.acc3 = lastId('budget_accounts'); },
  ['acc create usd', 'POST', `${B}/accounts`, { name: 'Dollar', currency: 'usd' }],
  () => { ids.accUsd = lastId('budget_accounts'); },
  ['acc create spare', 'POST', `${B}/accounts`, { name: 'Bar', type: 'cash' }, { actor: 'mem' }],
  () => { ids.accSpare = lastId('budget_accounts'); },
  ['acc create name spaces', 'POST', `${B}/accounts`, { name: SPACES }],
  ['acc create name long', 'POST', `${B}/accounts`, { name: LONG(MAX_SHORT + 1) }],
  ['acc create name missing', 'POST', `${B}/accounts`, {}],
  ['acc create name number', 'POST', `${B}/accounts`, { name: 5 }],
  ['acc create name object', 'POST', `${B}/accounts`, { name: {} }],
  ['acc create type bad', 'POST', `${B}/accounts`, { name: 'X', type: 'bad' }],
  ['acc create type empty', 'POST', `${B}/accounts`, { name: 'X', type: '' }],
  ['acc create balance text', 'POST', `${B}/accounts`, { name: 'X', starting_balance: '12' }],
  ['acc create balance true', 'POST', `${B}/accounts`, { name: 'X', starting_balance: true }],
  ['acc create color bad', 'POST', `${B}/accounts`, { name: 'X', color: 'red' }],
  ['acc create limit negative', 'POST', `${B}/accounts`, { name: 'X', credit_limit: -1 }],
  ['acc create limit empty', 'POST', `${B}/accounts`, { name: 'X', credit_limit: '' }],
  ['acc create currency bad', 'POST', `${B}/accounts`, { name: 'X', currency: 'XYZ1' }],
  ['acc create bank long', 'POST', `${B}/accounts`, { name: 'X', credit_bank: LONG(MAX_SHORT + 1) }],
  ['acc create two errors', 'POST', `${B}/accounts`, { name: SPACES, color: 'red' }],
  ['acc create no body', 'POST', `${B}/accounts`, NO_BODY],
  ['acc update', 'PUT', () => `${B}/accounts/${ids.acc}`, { name: ' Giro 2 ', starting_balance: 150 }],
  ['acc update leading zero', 'PUT', () => `${B}/accounts/00${ids.acc}`, { name: 'Giro' }],
  ['acc update zero', 'PUT', `${B}/accounts/0`, { name: 'X' }],
  ['acc update minus', 'PUT', `${B}/accounts/-1`, { name: 'X' }],
  ['acc update minus zero', 'PUT', `${B}/accounts/-0`, { name: 'X' }],
  ['acc update gone', 'PUT', `${B}/accounts/987654`, { name: 'X' }],
  ['acc update letters', 'PUT', `${B}/accounts/abc`, { name: 'X' }],
  ['acc update fraction', 'PUT', `${B}/accounts/1.5`, { name: 'X' }],
  ['acc update trailing letters', 'PUT', `${B}/accounts/1abc`, { name: 'X' }],
  ['acc update name spaces', 'PUT', () => `${B}/accounts/${ids.acc}`, { name: SPACES }],
  ['acc update type bad', 'PUT', () => `${B}/accounts/${ids.acc}`, { type: 'bad' }],
  ['acc update balance null', 'PUT', () => `${B}/accounts/${ids.acc}`, { starting_balance: null }],
  ['acc update color bad', 'PUT', () => `${B}/accounts/${ids.acc}`, { color: 'red' }],
  ['acc update limit negative', 'PUT', () => `${B}/accounts/${ids.acc3}`, { credit_limit: -5 }],
  ['acc update limit clear', 'PUT', () => `${B}/accounts/${ids.acc3}`, { credit_limit: null, credit_bank: null }],
  ['acc update currency bad', 'PUT', () => `${B}/accounts/${ids.acc}`, { currency: 'XYZ1' }],
  ['acc update archived text', 'PUT', () => `${B}/accounts/${ids.acc}`, { archived: 'false' }],
  ['acc update archive', 'PUT', () => `${B}/accounts/${ids.accSpare}`, { archived: true }],
  ['acc update member', 'PUT', () => `${B}/accounts/${ids.accSpare}`, { archived: false }, { actor: 'mem' }],
  ['acc list', 'GET', `${B}/accounts`, NO_BODY],
  ['acc list archived', 'GET', `${B}/accounts?include_archived=1`, NO_BODY],
  ['acc list archived yes', 'GET', `${B}/accounts?include_archived=yes`, NO_BODY],

  // ══ CATEGORIES ═════════════════════════════════════════════════════════════
  ['meta', 'GET', `${B}/meta`, NO_BODY],
  ['cats', 'GET', `${B}/categories`, NO_BODY],
  ['cats en', 'GET', `${B}/categories?lang=en`, NO_BODY],
  ['cats unknown lang', 'GET', `${B}/categories?lang=xx`, NO_BODY],
  ['subcats', 'GET', `${B}/categories/food/subcategories?lang=en`, NO_BODY],
  ['subcats gone', 'GET', `${B}/categories/nope/subcategories`, NO_BODY],
  ['cat create', 'POST', `${B}/categories`, { name: ' Haustier ', type: 'expense' }],
  ['cat create default type', 'POST', `${B}/categories`, { name: 'Garten' }],
  ['cat create income', 'POST', `${B}/categories`, { name: 'Bonus', type: 'income' }],
  ['cat create duplicate', 'POST', `${B}/categories`, { name: 'haustier', type: 'expense' }],
  ['cat create name spaces', 'POST', `${B}/categories`, { name: SPACES }],
  ['cat create name long', 'POST', `${B}/categories`, { name: LONG(MAX_SHORT + 1) }],
  ['cat create name missing', 'POST', `${B}/categories`, {}],
  ['cat create name object', 'POST', `${B}/categories`, { name: {} }],
  ['cat create type bad', 'POST', `${B}/categories`, { name: 'X', type: 'bad' }],
  ['cat create type empty', 'POST', `${B}/categories`, { name: 'X', type: '' }],
  ['cat create type null', 'POST', `${B}/categories`, { name: 'X', type: null }],
  ['cat rename', 'PUT', `${B}/categories/haustier`, { name: 'Haustiere' }],
  ['cat rename conflict', 'PUT', `${B}/categories/haustier`, { name: 'garten' }],
  ['cat rename spaces', 'PUT', `${B}/categories/haustier`, { name: SPACES }],
  ['cat rename gone', 'PUT', `${B}/categories/nope`, { name: 'X' }],
  ['cat rename number', 'PUT', `${B}/categories/haustier`, { name: 5 }],
  ['cat reorder', 'PATCH', `${B}/categories/reorder`, { order: ['food', 'housing', 'unknown'], type: 'expense' }],
  ['cat reorder default type', 'PATCH', `${B}/categories/reorder`, { order: ['housing', 'food'] }],
  ['cat reorder empty', 'PATCH', `${B}/categories/reorder`, { order: [] }],
  ['cat reorder missing', 'PATCH', `${B}/categories/reorder`, {}],
  ['cat reorder objects', 'PATCH', `${B}/categories/reorder`, { order: [{}] }],
  ['cat reorder text', 'PATCH', `${B}/categories/reorder`, { order: 'food' }],
  ['cat reorder type bad', 'PATCH', `${B}/categories/reorder`, { order: ['food'], type: 'bad' }],
  ['sub create', 'POST', `${B}/categories/haustier/subcategories`, { name: ' Futter ' }],
  ['sub create second', 'POST', `${B}/categories/haustier/subcategories`, { name: 'Tierarzt' }],
  ['sub create duplicate', 'POST', `${B}/categories/haustier/subcategories`, { name: 'futter' }],
  ['sub create spaces', 'POST', `${B}/categories/haustier/subcategories`, { name: SPACES }],
  ['sub create gone', 'POST', `${B}/categories/nope/subcategories`, { name: 'X' }],
  ['sub create number', 'POST', `${B}/categories/haustier/subcategories`, { name: 5 }],
  ['sub rename', 'PUT', `${B}/categories/haustier/subcategories/haustier_futter`, { name: 'Tierfutter' }],
  ['sub rename conflict', 'PUT', `${B}/categories/haustier/subcategories/haustier_futter`, { name: 'tierarzt' }],
  ['sub rename spaces', 'PUT', `${B}/categories/haustier/subcategories/haustier_futter`, { name: SPACES }],
  ['sub rename gone', 'PUT', `${B}/categories/haustier/subcategories/nope`, { name: 'X' }],
  ['sub rename wrong category', 'PUT', `${B}/categories/food/subcategories/haustier_futter`, { name: 'X' }],
  ['sub reorder', 'PATCH', `${B}/categories/haustier/subcategories/reorder`, { order: ['haustier_tierarzt', 'haustier_futter'] }],
  ['sub reorder missing', 'PATCH', `${B}/categories/haustier/subcategories/reorder`, {}],
  ['sub reorder numbers', 'PATCH', `${B}/categories/haustier/subcategories/reorder`, { order: [1] }],
  ['subcats haustier', 'GET', `${B}/categories/haustier/subcategories`, NO_BODY],

  // ══ ENTRIES ════════════════════════════════════════════════════════════════
  ['e create', 'POST', B, () => ENTRY({ title: ' Miete ', amount: -800, category: 'housing', subcategory: 'rent_mortgage', date: '2026-11-01', account_id: ids.acc, responsible_user_ids: [MEM], attachment_document_ids: [DOC] })],
  () => { ids.e1 = lastId('budget_entries'); },
  ['e create income', 'POST', B, ENTRY({ title: 'Gehalt', amount: 2500, category: undefined, date: '2026-11-02' })],
  () => { ids.e2 = lastId('budget_entries'); },
  ['e create pet', 'POST', B, ENTRY({ title: 'Futter', category: 'haustier', subcategory: 'haustier_futter' }), { actor: 'mem' }],
  () => { ids.ePet = lastId('budget_entries'); },
  ['e create series', 'POST', B, ENTRY({ title: 'Strom', amount: -50, category: 'housing', date: '2026-10-05', is_recurring: 1, recurrence_interval: 'monthly' })],
  () => { ids.series = lastId('budget_entries'); },
  ['e create confirm series', 'POST', B, ENTRY({ title: 'Wasser', amount: -30, category: 'housing', date: '2026-10-07', is_recurring: true, recurrence_confirm: 1 })],
  () => { ids.confirmSeries = lastId('budget_entries'); },
  ['e create virtual', 'POST', B, ENTRY({ title: 'Versicherung', amount: -120, date: '2026-01-15', is_recurring: 1, recurrence_interval: 'yearly', recurrence_virtual: 1 })],
  ['e create weekly', 'POST', B, ENTRY({ title: 'Markt', date: '2026-11-04', is_recurring: 1, recurrence_interval: 'weekly', recurrence_interval_count: 2 })],
  ['e create private', 'POST', B, ENTRY({ title: 'Geheim', visibility: 'private' }), { actor: 'mem' }],
  () => { ids.ePrivate = lastId('budget_entries'); },
  ['e create title spaces', 'POST', B, ENTRY({ title: SPACES })],
  ['e create title long', 'POST', B, ENTRY({ title: LONG(MAX_TITLE + 1) })],
  ['e create title missing', 'POST', B, ENTRY({ title: undefined })],
  ['e create title object', 'POST', B, ENTRY({ title: {} })],
  ['e create amount missing', 'POST', B, ENTRY({ amount: undefined })],
  ['e create amount text', 'POST', B, ENTRY({ amount: 'x' })],
  ['e create amount null', 'POST', B, ENTRY({ amount: null })],
  ['e create amount true', 'POST', B, ENTRY({ amount: true })],
  ['e create date day', 'POST', B, ENTRY({ date: '2026-02-30' })],
  ['e create date month', 'POST', B, ENTRY({ date: '2026-13-01' })],
  ['e create date missing', 'POST', B, ENTRY({ date: undefined })],
  ['e create date pattern', 'POST', B, ENTRY({ date: '3.11.2026' })],
  ['e create category bad', 'POST', B, ENTRY({ category: 'nope' })],
  ['e create subcategory bad', 'POST', B, ENTRY({ subcategory: 'nope' })],
  ['e create account gone', 'POST', B, ENTRY({ account_id: 987654 })],
  ['e create account zero', 'POST', B, ENTRY({ account_id: 0 })],
  ['e create account empty', 'POST', B, ENTRY({ account_id: '' })],
  ['e create account null', 'POST', B, ENTRY({ account_id: null })],
  ['e create interval count zero', 'POST', B, ENTRY({ is_recurring: 1, recurrence_interval_count: 0 })],
  ['e create interval count fraction', 'POST', B, ENTRY({ is_recurring: 1, recurrence_interval_count: 1.5 })],
  ['e create interval bad', 'POST', B, ENTRY({ is_recurring: 1, recurrence_interval: 'daily' })],
  ['e create rrule bad', 'POST', B, ENTRY({ recurrence_rule: 'FREQ=SECONDLY' })],
  ['e create transfer id', 'POST', B, ENTRY({ transfer_entry_id: 1 })],
  ['e create visibility bad', 'POST', B, ENTRY({ visibility: 'bad' })],
  ['e create recurring text', 'POST', B, ENTRY({ is_recurring: 'false' })],
  ['e create responsible guest', 'POST', B, ENTRY({ responsible_user_ids: [GUEST] })],
  ['e create responsible text', 'POST', B, ENTRY({ responsible_user_ids: ['x'] })],
  ['e create responsible zero', 'POST', B, ENTRY({ responsible_user_ids: [0] })],
  ['e create attachment no docs', 'POST', B, ENTRY({ attachment_document_ids: [DOC] }), { actor: 'nodocs' }],
  ['e create attachment locked', 'POST', B, ENTRY({ attachment_document_ids: [DOC_LOCKED] })],
  ['e create attachment invisible', 'POST', B, ENTRY({ attachment_document_ids: [DOC_PRIVATE] })],
  ['e create attachment object', 'POST', B, ENTRY({ attachment_document_ids: [{}] })],
  ['e create no body', 'POST', B, NO_BODY],
  ['e list', 'GET', `${B}?month=2026-11`, NO_BODY],
  ['e list default', 'GET', B, NO_BODY],
  ['e list october', 'GET', `${B}?month=2026-10`, NO_BODY],
  ['e list month 13', 'GET', `${B}?month=2026-13`, NO_BODY],
  ['e list month empty', 'GET', `${B}?month=`, NO_BODY],
  ['e list month text', 'GET', `${B}?month=abc`, NO_BODY],
  ['e list month day', 'GET', `${B}?month=2026-11-01`, NO_BODY],
  ['e list category', 'GET', `${B}?month=2026-11&category=housing`, NO_BODY],
  ['e list category unknown', 'GET', `${B}?month=2026-11&category=nope`, NO_BODY],
  ['e list account', 'GET', () => `${B}?month=2026-11&account_id=${ids.acc}`, NO_BODY],
  ['e list account text', 'GET', `${B}?month=2026-11&account_id=abc`, NO_BODY],
  ['e list account zero', 'GET', `${B}?month=2026-11&account_id=0`, NO_BODY],
  ['e list scope household', 'GET', `${B}?month=2026-11&scope=household`, NO_BODY],
  ['e list scope bad', 'GET', `${B}?month=2026-11&scope=x`, NO_BODY],
  ['e list member', 'GET', `${B}?month=2026-11`, NO_BODY, { actor: 'mem' }],
  ['e list no docs', 'GET', `${B}?month=2026-11`, NO_BODY, { actor: 'nodocs' }],
  ['e list guest', 'GET', `${B}?month=2026-11`, NO_BODY, { actor: 'gast' }],
  ['e search', 'GET', `${B}?q=miete`, NO_BODY],
  ['e search folded', 'GET', `${B}?q=STROM`, NO_BODY],
  ['e search account', 'GET', () => `${B}?q=e&account_id=${ids.acc}`, NO_BODY],
  ['e search empty', 'GET', `${B}?q=`, NO_BODY],
  ['e search spaces', 'GET', `${B}?q=%20%20`, NO_BODY],
  ['e search long', 'GET', `${B}?q=${LONG(101)}`, NO_BODY],
  ['e search max', 'GET', `${B}?q=${LONG(100)}`, NO_BODY],
  ['summary', 'GET', `${B}/summary?month=2026-11`, NO_BODY],
  ['summary default', 'GET', `${B}/summary`, NO_BODY],
  ['summary month 13', 'GET', `${B}/summary?month=2026-13`, NO_BODY],
  ['summary month empty', 'GET', `${B}/summary?month=`, NO_BODY],
  ['summary month text', 'GET', `${B}/summary?month=abc`, NO_BODY],
  ['summary month day', 'GET', `${B}/summary?month=2026-11-01`, NO_BODY],
  ['summary account', 'GET', () => `${B}/summary?month=2026-11&account_id=${ids.acc}`, NO_BODY],
  ['summary account text', 'GET', `${B}/summary?account_id=abc`, NO_BODY],
  ['summary scope bad', 'GET', `${B}/summary?scope=x`, NO_BODY],
  ['summary member', 'GET', `${B}/summary?month=2026-11`, NO_BODY, { actor: 'mem' }],
  ['export', 'GET', `${B}/export?month=2026-11`, NO_BODY],
  ['export range', 'GET', `${B}/export?from=2026-10-01&to=2026-11-30`, NO_BODY],
  ['export default', 'GET', `${B}/export`, NO_BODY],
  ['export month bad', 'GET', `${B}/export?month=2026-13`, NO_BODY],
  ['export from bad', 'GET', `${B}/export?from=2026-1-1&to=2026-11-30`, NO_BODY],
  ['e put', 'PUT', () => `${B}/${ids.e1}`, { title: ' Miete Nov ', amount: -850 }],
  ['e put leading zero', 'PUT', () => `${B}/0${ids.e1}`, { title: 'Miete' }],
  ['e put zero', 'PUT', `${B}/0`, { title: 'X' }],
  ['e put minus', 'PUT', `${B}/-1`, { title: 'X' }],
  ['e put minus zero', 'PUT', `${B}/-0`, { title: 'X' }],
  ['e put gone', 'PUT', `${B}/987654`, { title: 'X' }],
  ['e put letters', 'PUT', `${B}/abc`, { title: 'X' }],
  ['e put fraction', 'PUT', `${B}/1.5`, { title: 'X' }],
  ['e put gone bad body', 'PUT', `${B}/987654`, { title: 5 }],
  ['e put title spaces', 'PUT', () => `${B}/${ids.e1}`, { title: SPACES }],
  ['e put title number', 'PUT', () => `${B}/${ids.e1}`, { title: 5 }],
  ['e put amount text', 'PUT', () => `${B}/${ids.e1}`, { amount: 'viel' }],
  ['e put amount null', 'PUT', () => `${B}/${ids.e1}`, { amount: null }],
  ['e put date day', 'PUT', () => `${B}/${ids.e1}`, { date: '2026-11-31' }],
  ['e put date empty', 'PUT', () => `${B}/${ids.e1}`, { date: '' }],
  ['e put category bad', 'PUT', () => `${B}/${ids.e1}`, { category: 'nope' }],
  ['e put subcategory bad', 'PUT', () => `${B}/${ids.e1}`, { subcategory: 'nope' }],
  ['e put category and subcategory', 'PUT', () => `${B}/${ids.e1}`, { category: 'food', subcategory: 'groceries' }],
  ['e put account gone', 'PUT', () => `${B}/${ids.e1}`, { account_id: 987654 }],
  ['e put account clear', 'PUT', () => `${B}/${ids.e1}`, { account_id: null }],
  ['e put interval count', 'PUT', () => `${B}/${ids.e1}`, { recurrence_interval_count: 999 }],
  ['e put interval bad', 'PUT', () => `${B}/${ids.e1}`, { recurrence_interval: 'half_year' }],
  ['e put rrule bad', 'PUT', () => `${B}/${ids.e1}`, { recurrence_rule: 'nope' }],
  ['e put transfer id', 'PUT', () => `${B}/${ids.e1}`, { transfer_entry_id: 1 }],
  ['e put responsible guest', 'PUT', () => `${B}/${ids.e1}`, { responsible_user_ids: [GUEST] }],
  ['e put responsible', 'PUT', () => `${B}/${ids.e1}`, { responsible_user_ids: [MEM, OTHER] }],
  ['e put visibility', 'PUT', () => `${B}/${ids.e1}`, { visibility: 'shared_amount' }],
  ['e put visibility bad', 'PUT', () => `${B}/${ids.e1}`, { visibility: 'bad' }],
  ['e put attachments no docs', 'PUT', () => `${B}/${ids.e1}`, { attachment_document_ids: [DOC] }, { actor: 'nodocs' }],
  ['e put attachments locked', 'PUT', () => `${B}/${ids.e1}`, { attachment_document_ids: [DOC_LOCKED] }],
  ['e put attachments clear', 'PUT', () => `${B}/${ids.e1}`, { attachment_document_ids: [] }],
  ['e put member', 'PUT', () => `${B}/${ids.e2}`, { title: 'Gehalt Nov' }, { actor: 'mem' }],
  ['e put start series', 'PUT', () => `${B}/${ids.ePet}`, { is_recurring: 1, recurrence_interval: 'monthly' }],
  ['e list after puts', 'GET', `${B}?month=2026-11`, NO_BODY],
  () => { ids.pending = database().prepare('SELECT id FROM budget_entries WHERE recurrence_parent_id = ? AND is_pending = 1 ORDER BY date LIMIT 1').get(ids.confirmSeries)?.id; },
  ['e confirm', 'PATCH', () => `${B}/${ids.pending}/confirm`, { amount: 31.5, date: '2026-11-08' }],
  ['e confirm again', 'PATCH', () => `${B}/${ids.pending}/confirm`, {}],
  ['e confirm booked', 'PATCH', () => `${B}/${ids.e1}/confirm`, {}],
  ['e confirm amount text', 'PATCH', () => `${B}/${ids.e1}/confirm`, { amount: 'x' }],
  ['e confirm no body', 'PATCH', () => `${B}/${ids.e1}/confirm`, NO_BODY],
  ['e confirm zero', 'PATCH', `${B}/0/confirm`, {}],
  ['e confirm minus', 'PATCH', `${B}/-1/confirm`, {}],
  ['e confirm gone', 'PATCH', `${B}/987654/confirm`, {}],
  ['e confirm letters', 'PATCH', `${B}/abc/confirm`, {}],
  ['e series', 'PUT', () => `${B}/${ids.series}/series`, { title: ' Strom neu ', amount: -55, responsible_user_ids: [OTHER] }],
  ['e series leading zero', 'PUT', () => `${B}/0${ids.series}/series`, { title: 'Strom' }],
  ['e series zero', 'PUT', `${B}/0/series`, { title: 'X' }],
  ['e series minus zero', 'PUT', `${B}/-0/series`, { title: 'X' }],
  ['e series gone', 'PUT', `${B}/987654/series`, { title: 'X' }],
  ['e series not recurring', 'PUT', () => `${B}/${ids.e2}/series`, { title: 'X' }],
  ['e series end refused', 'PUT', () => `${B}/${ids.series}/series`, { is_recurring: false }],
  ['e series start bad', 'PUT', () => `${B}/${ids.series}/series`, { start_date: '2026-02-30' }],
  ['e series start early', 'PUT', () => `${B}/${ids.series}/series`, { start_date: '2026-09-01' }],
  ['e series start', 'PUT', () => `${B}/${ids.series}/series`, { start_date: '2026-10-06' }],
  ['e series title null', 'PUT', () => `${B}/${ids.series}/series`, { title: null }],
  ['e series amount text', 'PUT', () => `${B}/${ids.series}/series`, { amount: 'nope' }],
  ['e series category bad', 'PUT', () => `${B}/${ids.series}/series`, { category: 'nope' }],
  ['e series account gone', 'PUT', () => `${B}/${ids.series}/series`, { account_id: 987654 }],
  ['e series account', 'PUT', () => `${B}/${ids.series}/series`, { account_id: ids.acc }],
  ['e series responsible guest', 'PUT', () => `${B}/${ids.series}/series`, { responsible_user_ids: [GUEST] }],
  ['e series interval count', 'PUT', () => `${B}/${ids.series}/series`, { recurrence_interval_count: 0 }],
  ['e series transfer id', 'PUT', () => `${B}/${ids.series}/series`, { transfer_entry_id: 3 }],
  ['e list after series', 'GET', `${B}?month=2026-12`, NO_BODY],
  // Personal budget mode: own entries, no admin bypass on someone else's.
  () => { setConfig('budget_mode', 'personal'); },
  ['personal e list admin', 'GET', `${B}?month=2026-11`, NO_BODY],
  ['personal e list household', 'GET', `${B}?month=2026-11&scope=household`, NO_BODY, { actor: 'other' }],
  ['personal e put foreign', 'PUT', () => `${B}/${ids.ePrivate}`, { title: 'X' }],
  ['personal e put foreign bad body', 'PUT', () => `${B}/${ids.ePrivate}`, { title: 5 }],
  ['personal e confirm foreign', 'PATCH', () => `${B}/${ids.ePrivate}/confirm`, {}],
  ['personal e series foreign', 'PUT', () => `${B}/${ids.ePet}/series`, { title: 'X' }, { actor: 'other' }],
  ['personal e delete foreign', 'DELETE', () => `${B}/${ids.ePrivate}`, NO_BODY, { actor: 'other' }],
  ['personal e delete series foreign', 'DELETE', () => `${B}/${ids.ePet}/series`, NO_BODY, { actor: 'other' }],
  ['personal e put own', 'PUT', () => `${B}/${ids.ePrivate}`, { title: 'Geheim 2' }, { actor: 'mem' }],
  ['personal summary', 'GET', `${B}/summary?month=2026-11`, NO_BODY, { actor: 'other' }],
  ['personal acc list', 'GET', `${B}/accounts`, NO_BODY, { actor: 'other' }],
  ['personal e create', 'POST', B, ENTRY({ title: 'Privat' }), { actor: 'other' }],
  () => { setConfig('budget_mode', 'shared'); },

  // ══ TRANSFERS ══════════════════════════════════════════════════════════════
  ['t create', 'POST', `${B}/transfers`, () => TRANSFER({ title: ' Sparen ' })],
  () => { ids.t1 = answered['t create'].body.data.id; },
  ['t create recurring', 'POST', `${B}/transfers`, () => TRANSFER({ title: 'Dauerauftrag', date: '2026-10-15', is_recurring: true, recurrence_interval: 'monthly' })],
  () => { ids.t2 = answered['t create recurring'].body.data.id; },
  ['t create same account', 'POST', `${B}/transfers`, () => TRANSFER({ to_account_id: ids.acc })],
  ['t create amount zero', 'POST', `${B}/transfers`, () => TRANSFER({ amount: 0 })],
  ['t create amount negative', 'POST', `${B}/transfers`, () => TRANSFER({ amount: -5 })],
  ['t create amount text', 'POST', `${B}/transfers`, () => TRANSFER({ amount: 'x' })],
  ['t create amount precision', 'POST', `${B}/transfers`, () => TRANSFER({ amount: 1.005 })],
  ['t create title spaces', 'POST', `${B}/transfers`, () => TRANSFER({ title: SPACES })],
  ['t create title object', 'POST', `${B}/transfers`, () => TRANSFER({ title: {} })],
  ['t create date bad', 'POST', `${B}/transfers`, () => TRANSFER({ date: '2026-02-30' })],
  ['t create from gone', 'POST', `${B}/transfers`, () => TRANSFER({ from_account_id: 987654 })],
  ['t create from true', 'POST', `${B}/transfers`, () => TRANSFER({ from_account_id: true })],
  ['t create currency', 'POST', `${B}/transfers`, () => TRANSFER({ to_account_id: ids.accUsd })],
  ['t create archived', 'POST', `${B}/transfers`, () => TRANSFER({ to_account_id: ids.accSpare })],
  ['t create category bad', 'POST', `${B}/transfers`, () => TRANSFER({ category: 'nope' })],
  ['t create category income', 'POST', `${B}/transfers`, () => TRANSFER({ category: 'Bonus' })],
  ['t create virtual', 'POST', `${B}/transfers`, () => TRANSFER({ recurrence_virtual: true })],
  ['t create rule', 'POST', `${B}/transfers`, () => TRANSFER({ recurrence_rule: 'FREQ=MONTHLY' })],
  ['t create transfer id', 'POST', `${B}/transfers`, () => TRANSFER({ transfer_entry_id: 1 })],
  ['t create interval count', 'POST', `${B}/transfers`, () => TRANSFER({ recurrence_interval_count: 0 })],
  ['t create visibility number', 'POST', `${B}/transfers`, () => TRANSFER({ visibility: 5 })],
  ['t create missing', 'POST', `${B}/transfers`, {}],
  ['t get', 'GET', () => `${B}/transfers/${ids.t1}`, NO_BODY],
  ['t get leading zero', 'GET', () => `${B}/transfers/0${ids.t1}`, NO_BODY],
  ['t get zero', 'GET', `${B}/transfers/0`, NO_BODY],
  ['t get minus', 'GET', `${B}/transfers/-1`, NO_BODY],
  ['t get minus zero', 'GET', `${B}/transfers/-0`, NO_BODY],
  ['t get gone', 'GET', `${B}/transfers/987654`, NO_BODY],
  ['t get letters', 'GET', `${B}/transfers/abc`, NO_BODY],
  ['t get hex', 'GET', `${B}/transfers/0x1`, NO_BODY],
  ['t get no transfer', 'GET', () => `${B}/transfers/${ids.e2}`, NO_BODY],
  ['t get recurring', 'GET', () => `${B}/transfers/${ids.t2}`, NO_BODY],
  ['t put', 'PUT', () => `${B}/transfers/${ids.t1}`, { title: 'Sparen 2', amount: 120 }],
  ['t put leading zero', 'PUT', () => `${B}/transfers/0${ids.t1}`, { title: 'Sparen' }],
  ['t put zero', 'PUT', `${B}/transfers/0`, { title: 'X' }],
  ['t put gone', 'PUT', `${B}/transfers/987654`, { title: 'X' }],
  ['t put interval', 'PUT', () => `${B}/transfers/${ids.t1}`, { is_recurring: true }],
  ['t put amount zero', 'PUT', () => `${B}/transfers/${ids.t1}`, { amount: 0 }],
  ['t put same accounts', 'PUT', () => `${B}/transfers/${ids.t1}`, { to_account_id: ids.acc }],
  ['t put title number', 'PUT', () => `${B}/transfers/${ids.t1}`, { title: 5 }],
  ['t series', 'PUT', () => `${B}/transfers/${ids.t2}/series`, { title: 'Dauerauftrag 2', amount: 75 }],
  ['t series not recurring', 'PUT', () => `${B}/transfers/${ids.t1}/series`, { title: 'X' }],
  ['t series end', 'PUT', () => `${B}/transfers/${ids.t2}/series`, { is_recurring: false }],
  ['t series early', 'PUT', () => `${B}/transfers/${ids.t2}/series`, { date: '2026-08-01', recurrence_interval: 'weekly' }],
  ['t series gone', 'PUT', `${B}/transfers/987654/series`, { title: 'X' }],
  ['t series minus zero', 'PUT', `${B}/transfers/-0/series`, { title: 'X' }],
  ['t generic recurrence', 'PUT', () => `${B}/${ids.t1}`, { is_recurring: 1 }],
  ['t generic direction', 'PUT', () => `${B}/${ids.t1}`, { amount: 5 }],
  ['t generic same account', 'PUT', () => `${B}/${ids.t1}`, () => ({ account_id: ids.acc2 })],
  ['t generic category', 'PUT', () => `${B}/${ids.t1}`, { category: 'Bonus' }],
  ['t generic title', 'PUT', () => `${B}/${ids.t1}`, { title: 'Sparen 3' }],
  ['t generic series', 'PUT', () => `${B}/${ids.t2}/series`, { title: 'X' }],
  ['acc delete with transfers', 'DELETE', () => `${B}/accounts/${ids.acc2}`, NO_BODY],

  // ══ LOANS ══════════════════════════════════════════════════════════════════
  ['l preview', 'POST', `${B}/loans/preview`, { interest_mode: 'fixed', principal: 10000, fixed_rate: 3, initial_repayment_rate: 2 }],
  ['l preview variable', 'POST', `${B}/loans/preview`, { interest_mode: 'fixed_then_variable', principal: 10000, fixed_rate: 3, initial_repayment_rate: 2, fixed_period_months: 24, followup_rate: 4 }],
  ['l preview variable period', 'POST', `${B}/loans/preview`, { interest_mode: 'fixed_then_variable', principal: 10000, fixed_rate: 3, initial_repayment_rate: 2 }],
  ['l preview missing mode', 'POST', `${B}/loans/preview`, { principal: 10000 }],
  ['l preview none', 'POST', `${B}/loans/preview`, { interest_mode: 'none' }],
  ['l preview mode bad', 'POST', `${B}/loans/preview`, { interest_mode: 'bad' }],
  ['l preview mode null', 'POST', `${B}/loans/preview`, { interest_mode: null }],
  ['l preview principal zero', 'POST', `${B}/loans/preview`, { interest_mode: 'fixed', principal: 0, fixed_rate: 3, initial_repayment_rate: 2 }],
  ['l preview principal object', 'POST', `${B}/loans/preview`, { interest_mode: 'fixed', principal: {} }],
  ['l preview not amortizing', 'POST', `${B}/loans/preview`, { interest_mode: 'fixed', principal: 10000, fixed_rate: 50, initial_repayment_rate: 0.0001 }],
  ['l preview empty', 'POST', `${B}/loans/preview`, {}],
  ['l create', 'POST', `${B}/loans`, () => LOAN({ account_id: ids.acc, due_day: '15', notes: ' Kredit ' })],
  () => { ids.loan = lastId('budget_loans'); },
  ['l create paid', 'POST', `${B}/loans`, LOAN({ title: 'Sofa', borrower: 'Moebelhaus', total_amount: 600, installment_count: 6, paid_installments: 2, due_day: 5 })],
  () => { ids.loanPaid = lastId('budget_loans'); },
  ['l create interest', 'POST', `${B}/loans`, { title: 'Haus', borrower: 'Bank', start_month: '2026-03', interest_mode: 'fixed', principal: 100000, fixed_rate: 3, initial_repayment_rate: 2, direction: 'borrowed' }],
  () => { ids.loanInterest = lastId('budget_loans'); },
  ['l create foreign', 'POST', `${B}/loans`, LOAN({ title: 'Dollar', currency: 'usd', exchange_rate: 0.9, paid_installments: '' })],
  ['l create private', 'POST', `${B}/loans`, LOAN({ title: 'Privat', visibility: 'private' }), { actor: 'mem' }],
  () => { ids.loanPrivate = lastId('budget_loans'); },
  ['l create title from borrower', 'POST', `${B}/loans`, LOAN({ title: undefined, borrower: 'Oma' })],
  ['l create mode bad', 'POST', `${B}/loans`, LOAN({ interest_mode: 'bad' })],
  ['l create mode null', 'POST', `${B}/loans`, LOAN({ interest_mode: null })],
  ['l create mode none', 'POST', `${B}/loans`, LOAN({ interest_mode: 'none', title: 'Ohne' })],
  ['l create interest missing terms', 'POST', `${B}/loans`, LOAN({ interest_mode: 'fixed' })],
  ['l create start missing', 'POST', `${B}/loans`, LOAN({ start_month: undefined })],
  ['l create start 13', 'POST', `${B}/loans`, LOAN({ start_month: '2026-13' })],
  ['l create start empty', 'POST', `${B}/loans`, LOAN({ start_month: '' })],
  ['l create installments zero', 'POST', `${B}/loans`, LOAN({ installment_count: 0 })],
  ['l create installments many', 'POST', `${B}/loans`, LOAN({ installment_count: 361 })],
  ['l create installments missing', 'POST', `${B}/loans`, LOAN({ installment_count: undefined })],
  ['l create amount zero', 'POST', `${B}/loans`, LOAN({ total_amount: 0 })],
  ['l create amount missing', 'POST', `${B}/loans`, LOAN({ total_amount: undefined })],
  ['l create amount text', 'POST', `${B}/loans`, LOAN({ total_amount: '1200' })],
  ['l create paid exceed', 'POST', `${B}/loans`, LOAN({ paid_installments: 13 })],
  ['l create paid negative', 'POST', `${B}/loans`, LOAN({ paid_installments: -1 })],
  ['l create paid text', 'POST', `${B}/loans`, LOAN({ paid_installments: 'x' })],
  ['l create due day', 'POST', `${B}/loans`, LOAN({ due_day: 32 })],
  ['l create due day true', 'POST', `${B}/loans`, LOAN({ due_day: true })],
  ['l create currency bad', 'POST', `${B}/loans`, LOAN({ currency: 'US' })],
  ['l create rate zero', 'POST', `${B}/loans`, LOAN({ currency: 'USD', exchange_rate: 0 })],
  ['l create direction bad', 'POST', `${B}/loans`, LOAN({ direction: 'sideways' })],
  ['l create account gone', 'POST', `${B}/loans`, LOAN({ account_id: 987654 })],
  ['l create borrower missing', 'POST', `${B}/loans`, LOAN({ borrower: undefined })],
  ['l create notes long', 'POST', `${B}/loans`, LOAN({ notes: LONG(1001) })],
  ['l create visibility bad', 'POST', `${B}/loans`, LOAN({ visibility: 'shared_amount' })],
  ['l create many errors', 'POST', `${B}/loans`, LOAN({ title: SPACES, start_month: undefined, installment_count: 0, due_day: 0 })],
  ['l list', 'GET', `${B}/loans`, NO_BODY],
  ['l list member', 'GET', `${B}/loans`, NO_BODY, { actor: 'other' }],
  ['l put', 'PUT', () => `${B}/loans/${ids.loan}`, { title: ' Auto 2 ', notes: ' Neu ', due_day: null }],
  ['l put leading zero', 'PUT', () => `${B}/loans/0${ids.loan}`, { title: 'Auto' }],
  ['l put zero', 'PUT', `${B}/loans/0`, { title: 'X' }],
  ['l put minus', 'PUT', `${B}/loans/-1`, { title: 'X' }],
  ['l put minus zero', 'PUT', `${B}/loans/-0`, { title: 'X' }],
  ['l put gone', 'PUT', `${B}/loans/987654`, { title: 'X' }],
  ['l put letters', 'PUT', `${B}/loans/abc`, { title: 'X' }],
  ['l put below paid', 'PUT', () => `${B}/loans/${ids.loanPaid}`, { installment_count: 1 }],
  ['l put amount zero', 'PUT', () => `${B}/loans/${ids.loan}`, { total_amount: 0 }],
  ['l put start empty', 'PUT', () => `${B}/loans/${ids.loan}`, { start_month: '' }],
  ['l put direction', 'PUT', () => `${B}/loans/${ids.loanPaid}`, { direction: 'borrowed' }],
  ['l put direction bad', 'PUT', () => `${B}/loans/${ids.loan}`, { direction: 'sideways' }],
  ['l put interest fields', 'PUT', () => `${B}/loans/${ids.loanInterest}`, { total_amount: 5 }],
  ['l put mode', 'PUT', () => `${B}/loans/${ids.loanInterest}`, { interest_mode: 'fixed', principal: 90000, fixed_rate: 3.5, initial_repayment_rate: 2, title: 'Haus 2' }],
  ['l put mode none', 'PUT', () => `${B}/loans/${ids.loan}`, { interest_mode: 'none', total_amount: 1500, installment_count: 15 }],
  ['l put mode bad', 'PUT', () => `${B}/loans/${ids.loan}`, { interest_mode: 'compound' }],
  ['l put mode below paid', 'PUT', () => `${B}/loans/${ids.loanPaid}`, { interest_mode: 'none', total_amount: 100, installment_count: 1 }],
  ['l put title number', 'PUT', () => `${B}/loans/${ids.loan}`, { title: 5 }],
  ['l put account gone', 'PUT', () => `${B}/loans/${ids.loan}`, { account_id: 987654 }],
  ['l pay', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-15' }],
  () => { ids.payment = lastId('budget_loan_payments'); },
  ['l pay again', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-15', installment_number: 1 }],
  ['l pay amount', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-16', amount: 50 }],
  ['l pay too much', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-16', amount: 99999 }],
  ['l pay amount zero', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-16', amount: 0 }],
  ['l pay amount text', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-16', amount: 'abc' }],
  ['l pay date bad', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-31' }],
  ['l pay date missing', 'POST', () => `${B}/loans/${ids.loan}/payments`, {}],
  ['l pay installment', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-16', installment_number: 99 }],
  ['l pay gone', 'POST', `${B}/loans/987654/payments`, { paid_date: '2026-11-16' }],
  ['l pay zero', 'POST', `${B}/loans/0/payments`, { paid_date: '2026-11-16' }],
  ['l pay foreign member', 'POST', () => `${B}/loans/${ids.loan}/payments`, { paid_date: '2026-11-16' }, { actor: 'mem' }],
  ['e list loan', 'GET', () => `${B}?loan_id=${ids.loan}`, NO_BODY],
  ['e list loan text', 'GET', `${B}?loan_id=abc`, NO_BODY],
  ['e put loan payment', 'PUT', () => `${B}/${database().prepare('SELECT budget_entry_id FROM budget_loan_payments WHERE id = ?').get(ids.payment).budget_entry_id}`, { amount: -99999 }],
  ['l pay delete', 'DELETE', () => `${B}/loans/${ids.loan}/payments/${ids.payment}`, NO_BODY],
  ['l pay delete again', 'DELETE', () => `${B}/loans/${ids.loan}/payments/${ids.payment}`, NO_BODY],
  ['l pay delete zero', 'DELETE', () => `${B}/loans/${ids.loan}/payments/0`, NO_BODY],
  ['l pay delete minus zero', 'DELETE', () => `${B}/loans/-0/payments/-0`, NO_BODY],
  ['l pay delete letters', 'DELETE', () => `${B}/loans/${ids.loan}/payments/abc`, NO_BODY],
  ['l pay delete wrong loan', 'DELETE', () => `${B}/loans/${ids.loanPaid}/payments/${lastId('budget_loan_payments')}`, NO_BODY],
  () => { setConfig('budget_mode', 'personal'); },
  ['personal l put foreign', 'PUT', () => `${B}/loans/${ids.loanPrivate}`, { title: 'X' }],
  ['personal l pay foreign', 'POST', () => `${B}/loans/${ids.loanPrivate}/payments`, { paid_date: '2026-11-16' }],
  ['personal l delete foreign', 'DELETE', () => `${B}/loans/${ids.loanPrivate}`, NO_BODY],
  ['personal l list', 'GET', `${B}/loans`, NO_BODY],
  () => { setConfig('budget_mode', 'shared'); },
  ['l settle', 'POST', () => `${B}/loans/${ids.loanPaid}/payments`, { paid_date: '2026-11-16', amount: 400 }],
  ['l settled', 'POST', () => `${B}/loans/${ids.loanPaid}/payments`, { paid_date: '2026-11-17' }],
  ['l delete', 'DELETE', () => `${B}/loans/${ids.loanPaid}`, NO_BODY],
  ['l delete again', 'DELETE', () => `${B}/loans/${ids.loanPaid}`, NO_BODY],
  ['l delete leading zero', 'DELETE', () => `${B}/loans/0${ids.loanInterest}`, NO_BODY],
  ['l delete zero', 'DELETE', `${B}/loans/0`, NO_BODY],
  ['l delete fraction', 'DELETE', `${B}/loans/1.0`, NO_BODY],

  // ══ PLANS & STATS ══════════════════════════════════════════════════════════
  ['p set', 'PUT', `${B}/plans/food`, { amount: 300 }],
  ['p set housing', 'PUT', `${B}/plans/housing`, { amount: 800.555 }],
  ['p set savings', 'PUT', `${B}/plans/__savings__`, { amount: 100 }],
  ['p set unknown', 'PUT', `${B}/plans/nope`, { amount: 10 }],
  ['p set income category', 'PUT', `${B}/plans/Bonus`, { amount: 10 }],
  ['p set zero', 'PUT', `${B}/plans/food`, { amount: 0 }],
  ['p set negative', 'PUT', `${B}/plans/food`, { amount: -1 }],
  ['p set missing', 'PUT', `${B}/plans/food`, {}],
  ['p set null', 'PUT', `${B}/plans/food`, { amount: null }],
  ['p set true', 'PUT', `${B}/plans/food`, { amount: true }],
  ['p set text', 'PUT', `${B}/plans/food`, { amount: '10' }],
  ['p set no body', 'PUT', `${B}/plans/food`, NO_BODY],
  ['p get', 'GET', `${B}/plans?month=2026-11`, NO_BODY],
  ['p get default', 'GET', `${B}/plans`, NO_BODY],
  ['p get past', 'GET', `${B}/plans?month=2026-10`, NO_BODY],
  ['p get month 13', 'GET', `${B}/plans?month=2026-13`, NO_BODY],
  ['p get month text', 'GET', `${B}/plans?month=abc`, NO_BODY],
  ['p get month empty', 'GET', `${B}/plans?month=`, NO_BODY],
  ['p get member', 'GET', `${B}/plans?month=2026-11`, NO_BODY, { actor: 'mem' }],
  ['p delete', 'DELETE', `${B}/plans/housing`, NO_BODY],
  ['p delete unknown', 'DELETE', `${B}/plans/nope`, NO_BODY],
  ['p get after delete', 'GET', `${B}/plans?month=2026-11`, NO_BODY],
  ['st default', 'GET', `${B}/stats`, NO_BODY],
  ['st week', 'GET', `${B}/stats?range=week&anchor=2026-11-18`, NO_BODY],
  ['st year', 'GET', `${B}/stats?range=year&anchor=2026-06-01`, NO_BODY],
  ['st month', 'GET', `${B}/stats?range=month&anchor=2026-10-31`, NO_BODY],
  ['st range bad', 'GET', `${B}/stats?range=day`, NO_BODY],
  ['st anchor pattern', 'GET', `${B}/stats?anchor=2026-1-1`, NO_BODY],
  ['st anchor rolls over', 'GET', `${B}/stats?anchor=2026-02-30`, NO_BODY],
  ['st anchor month 13', 'GET', `${B}/stats?range=month&anchor=2026-13-01`, NO_BODY],
  ['st member', 'GET', `${B}/stats?range=month&anchor=2026-11-01`, NO_BODY, { actor: 'mem' }],

  // ══ SUBSCRIPTIONS: SETTINGS AND META ═══════════════════════════════════════
  ['s settings', 'GET', `${S}/settings`, NO_BODY],
  ['s settings put', 'PUT', `${S}/settings`, { monthly_budget: 50, base_currency: 'eur' }],
  ['s settings negative', 'PUT', `${S}/settings`, { monthly_budget: -1, base_currency: 'EUR' }],
  ['s settings currency', 'PUT', `${S}/settings`, { monthly_budget: 50, base_currency: 'EU' }],
  ['s settings missing', 'PUT', `${S}/settings`, {}],
  ['s settings null', 'PUT', `${S}/settings`, { monthly_budget: null, base_currency: 'EUR' }],
  ['s meta', 'GET', `${S}/meta`, NO_BODY],
  ['s cat create', 'POST', `${S}/categories`, { name: ' Streaming ', color: '#123456' }],
  () => { ids.subCat = lastId('subscription_categories'); },
  ['s cat create default color', 'POST', `${S}/categories`, { name: 'Cloud' }],
  () => { ids.subCat2 = lastId('subscription_categories'); },
  ['s cat create null color', 'POST', `${S}/categories`, { name: 'Spiele', color: null }],
  ['s cat create duplicate', 'POST', `${S}/categories`, { name: 'Streaming' }],
  ['s cat create color empty', 'POST', `${S}/categories`, { name: 'X', color: '' }],
  ['s cat create color bad', 'POST', `${S}/categories`, { name: 'X', color: 'red' }],
  ['s cat create color short', 'POST', `${S}/categories`, { name: 'X', color: '#123' }],
  ['s cat create spaces', 'POST', `${S}/categories`, { name: SPACES }],
  ['s cat create long', 'POST', `${S}/categories`, { name: LONG(MAX_SHORT + 1), color: 'red' }],
  ['s cat create number', 'POST', `${S}/categories`, { name: 5 }],
  ['s cat put', 'PUT', () => `${S}/categories/${ids.subCat}`, { name: 'Video', color: '#654321' }],
  ['s cat put keep color', 'PUT', () => `${S}/categories/${ids.subCat}`, { name: 'Video', color: null }],
  ['s cat put leading zero', 'PUT', () => `${S}/categories/0${ids.subCat}`, { name: 'Video' }],
  ['s cat put conflict', 'PUT', () => `${S}/categories/${ids.subCat}`, { name: 'Cloud' }],
  ['s cat put zero', 'PUT', `${S}/categories/0`, { name: 'X' }],
  ['s cat put minus', 'PUT', `${S}/categories/-1`, { name: 'X' }],
  ['s cat put minus zero', 'PUT', `${S}/categories/-0`, { name: 'X' }],
  ['s cat put gone', 'PUT', `${S}/categories/987654`, { name: 'X' }],
  ['s cat put letters', 'PUT', `${S}/categories/abc`, { name: 'X' }],
  ['s cat put spaces', 'PUT', () => `${S}/categories/${ids.subCat}`, { name: SPACES }],
  ['s cat put color empty', 'PUT', () => `${S}/categories/${ids.subCat}`, { name: 'Video', color: '' }],
  ['s pm create', 'POST', `${S}/payment-methods`, { name: ' Karte X ' }],
  () => { ids.pm = lastId('subscription_payment_methods'); },
  ['s pm create second', 'POST', `${S}/payment-methods`, { name: 'Bar' }],
  () => { ids.pm2 = lastId('subscription_payment_methods'); },
  ['s pm create duplicate', 'POST', `${S}/payment-methods`, { name: 'Karte X' }],
  ['s pm create spaces', 'POST', `${S}/payment-methods`, { name: SPACES }],
  ['s pm create number', 'POST', `${S}/payment-methods`, { name: 5 }],
  ['s pm put', 'PUT', () => `${S}/payment-methods/${ids.pm}`, { name: 'Karte Y' }],
  ['s pm put conflict', 'PUT', () => `${S}/payment-methods/${ids.pm}`, { name: 'Bar' }],
  ['s pm put spaces', 'PUT', () => `${S}/payment-methods/${ids.pm}`, { name: SPACES }],
  ['s pm put zero', 'PUT', `${S}/payment-methods/0`, { name: 'X' }],
  ['s pm put minus zero', 'PUT', `${S}/payment-methods/-0`, { name: 'X' }],
  ['s pm put leading zero', 'PUT', () => `${S}/payment-methods/00${ids.pm}`, { name: 'Karte Y' }],
  ['s pm put gone', 'PUT', `${S}/payment-methods/987654`, { name: 'X' }],
  ['s order', 'PUT', () => `${S}/meta/order`, () => ({ categories: [ids.subCat2, ids.subCat, 1], payment_methods: [ids.pm2, ids.pm] })],
  ['s order methods', 'PUT', `${S}/meta/order`, { payment_methods: [1, 2] }],
  ['s order none', 'PUT', `${S}/meta/order`, {}],
  ['s order objects', 'PUT', `${S}/meta/order`, { categories: [{}] }],
  ['s order text ids', 'PUT', `${S}/meta/order`, { categories: ['abc'] }],
  ['s order text', 'PUT', `${S}/meta/order`, { categories: 'abc' }],
  ['s meta after', 'GET', `${S}/meta`, NO_BODY],
  ['s logo', 'POST', `${S}/logo-search`, { query: ' example.org ' }],
  ['s logo website', 'POST', `${S}/logo-search`, { website_url: 'https://example.org' }],
  ['s logo none', 'POST', `${S}/logo-search`, { query: 'none' }],
  ['s logo refused', 'POST', `${S}/logo-search`, { query: 'refused' }],
  ['s logo down', 'POST', `${S}/logo-search`, { query: 'down' }],
  ['s logo spaces', 'POST', `${S}/logo-search`, { query: SPACES }],
  ['s logo missing', 'POST', `${S}/logo-search`, {}],
  ['s logo long', 'POST', `${S}/logo-search`, { query: LONG(2001) }],
  ['s logo number', 'POST', `${S}/logo-search`, { query: 5 }],
  ['s logo object', 'POST', `${S}/logo-search`, { query: {} }],

  // ══ SUBSCRIPTIONS ══════════════════════════════════════════════════════════
  ['s create', 'POST', S, () => SUB({ name: ' Netflix ', category_id: ids.subCat, payment_method_id: ids.pm, account_id: ids.acc, description: ' Film ', notes: ' Familie ', website_url: 'https://netflix.com', account_username: ' linda ', brand_color: '#E50914', reminder_days: 2 })],
  () => { ids.sub = lastId('budget_subscriptions'); },
  ['s create yearly', 'POST', S, SUB({ name: 'Zeitung', amount: 120, billing_cycle: 'yearly', next_payment_date: '2027-01-15', end_type: 'after_count', occurrence_count: 2, reminder_enabled: false })],
  () => { ids.subYearly = lastId('budget_subscriptions'); },
  ['s create dated end', 'POST', S, SUB({ name: 'Kurs', billing_cycle: 'weekly', cycle_interval: 2, end_type: 'on_date', end_date: '2027-03-01', enabled: false })],
  ['s create private', 'POST', S, SUB({ name: 'Privat', visibility: 'private' }), { actor: 'mem' }],
  () => { ids.subPrivate = lastId('budget_subscriptions'); },
  ['s create usd', 'POST', S, SUB({ name: 'Cloud', currency: 'usd', amount: 5 })],
  ['s create once', 'POST', S, SUB({ name: 'Einmal', end_type: 'after_count', occurrence_count: 1, next_payment_date: '2026-11-20' })],
  () => { ids.subOnce = lastId('budget_subscriptions'); },
  ['s create billing missing', 'POST', S, SUB({ billing_cycle: undefined })],
  ['s create billing empty', 'POST', S, SUB({ billing_cycle: '' })],
  ['s create billing bad', 'POST', S, SUB({ billing_cycle: 'hourly' })],
  ['s create amount null', 'POST', S, SUB({ amount: null })],
  ['s create amount missing', 'POST', S, SUB({ amount: undefined })],
  ['s create amount negative', 'POST', S, SUB({ amount: -1 })],
  ['s create amount text', 'POST', S, SUB({ amount: '12' })],
  ['s create name spaces', 'POST', S, SUB({ name: SPACES })],
  ['s create name missing', 'POST', S, SUB({ name: undefined })],
  ['s create name number', 'POST', S, SUB({ name: 5 })],
  ['s create currency bad', 'POST', S, SUB({ currency: 'EU' })],
  ['s create currency missing', 'POST', S, SUB({ currency: undefined })],
  ['s create interval zero', 'POST', S, SUB({ cycle_interval: 0 })],
  ['s create interval fraction', 'POST', S, SUB({ cycle_interval: 1.5 })],
  ['s create reminder days', 'POST', S, SUB({ reminder_days: 400 })],
  ['s create date day', 'POST', S, SUB({ next_payment_date: '2026-02-30' })],
  ['s create date missing', 'POST', S, SUB({ next_payment_date: undefined })],
  ['s create date pattern', 'POST', S, SUB({ next_payment_date: '1.12.2026' })],
  ['s create url', 'POST', S, SUB({ website_url: 'ftp://example.org' })],
  ['s create logo bad', 'POST', S, SUB({ logo_data: 'abc' })],
  ['s create logo mismatch', 'POST', S, SUB({ logo_data: PNG_AS_JPEG })],
  ['s create brand color', 'POST', S, SUB({ brand_color: 'red' })],
  ['s create description long', 'POST', S, SUB({ description: LONG(5001) })],
  ['s create username long', 'POST', S, SUB({ account_username: LONG(201) })],
  ['s create category gone', 'POST', S, SUB({ category_id: 987654 })],
  ['s create category zero', 'POST', S, SUB({ category_id: 0 })],
  ['s create category text', 'POST', S, SUB({ category_id: 'x' })],
  ['s create category true', 'POST', S, SUB({ category_id: true })],
  ['s create method gone', 'POST', S, SUB({ payment_method_id: 987654 })],
  ['s create method minus', 'POST', S, SUB({ payment_method_id: -1 })],
  ['s create enabled text', 'POST', S, SUB({ enabled: 'yes' })],
  ['s create reminder number', 'POST', S, SUB({ reminder_enabled: 1 })],
  ['s create end type bad', 'POST', S, SUB({ end_type: 'bad' })],
  ['s create end type null', 'POST', S, SUB({ end_type: null })],
  ['s create end date missing', 'POST', S, SUB({ end_type: 'on_date' })],
  ['s create end date early', 'POST', S, SUB({ end_type: 'on_date', end_date: '2026-11-01' })],
  ['s create end date day', 'POST', S, SUB({ end_type: 'on_date', end_date: '2026-02-30' })],
  ['s create end count zero', 'POST', S, SUB({ end_type: 'after_count', occurrence_count: 0 })],
  ['s create account gone', 'POST', S, SUB({ account_id: 987654 })],
  ['s create account zero', 'POST', S, SUB({ account_id: 0 })],
  ['s create visibility bad', 'POST', S, SUB({ visibility: 'bad' })],
  ['s create many errors', 'POST', S, SUB({ name: SPACES, currency: 'EU', cycle_interval: 0, website_url: 'x' })],
  ['s create no body', 'POST', S, NO_BODY],
  ['s list', 'GET', S, NO_BODY],
  ['s list active', 'GET', `${S}?status=active`, NO_BODY],
  ['s list paused', 'GET', `${S}?status=paused`, NO_BODY],
  ['s list completed', 'GET', `${S}?status=completed`, NO_BODY],
  ['s list status bad', 'GET', `${S}?status=bad`, NO_BODY],
  ['s list enabled', 'GET', `${S}?enabled=false`, NO_BODY],
  ['s list category', 'GET', () => `${S}?category_id=${ids.subCat}`, NO_BODY],
  ['s list category text', 'GET', `${S}?category_id=abc`, NO_BODY],
  ['s list method', 'GET', () => `${S}?payment_method_id=${ids.pm}`, NO_BODY],
  ['s list query', 'GET', `${S}?q=net`, NO_BODY],
  ['s list member', 'GET', S, NO_BODY, { actor: 'mem' }],
  ['s put', 'PUT', () => `${S}/${ids.sub}`, { name: ' Netflix HD ', amount: 15.99, notes: null }],
  ['s put leading zero', 'PUT', () => `${S}/0${ids.sub}`, { name: 'Netflix' }],
  ['s put zero', 'PUT', `${S}/0`, { name: 'X' }],
  ['s put minus', 'PUT', `${S}/-1`, { name: 'X' }],
  ['s put minus zero', 'PUT', `${S}/-0`, { name: 'X' }],
  ['s put gone', 'PUT', `${S}/987654`, { name: 'X' }],
  ['s put letters', 'PUT', `${S}/abc`, { name: 'X' }],
  ['s put hex', 'PUT', `${S}/0x1`, { name: 'X' }],
  ['s put billing bad', 'PUT', () => `${S}/${ids.sub}`, { billing_cycle: 'hourly' }],
  ['s put billing empty', 'PUT', () => `${S}/${ids.sub}`, { billing_cycle: '' }],
  ['s put name spaces', 'PUT', () => `${S}/${ids.sub}`, { name: SPACES }],
  ['s put name null', 'PUT', () => `${S}/${ids.sub}`, { name: null }],
  ['s put currency bad', 'PUT', () => `${S}/${ids.sub}`, { currency: 'EU' }],
  ['s put interval', 'PUT', () => `${S}/${ids.sub}`, { cycle_interval: 366 }],
  ['s put enabled text', 'PUT', () => `${S}/${ids.sub}`, { enabled: 'false' }],
  ['s put reminder text', 'PUT', () => `${S}/${ids.sub}`, { reminder_enabled: 'false' }],
  ['s put category gone', 'PUT', () => `${S}/${ids.sub}`, { category_id: 987654 }],
  ['s put category text', 'PUT', () => `${S}/${ids.sub}`, { category_id: '2' }],
  ['s put method gone', 'PUT', () => `${S}/${ids.sub}`, { payment_method_id: 987654 }],
  ['s put method clear', 'PUT', () => `${S}/${ids.sub}`, { payment_method_id: null }],
  ['s put end type bad', 'PUT', () => `${S}/${ids.sub}`, { end_type: 'bad' }],
  ['s put end count', 'PUT', () => `${S}/${ids.sub}`, { end_type: 'after_count', occurrence_count: 1201 }],
  ['s put account gone', 'PUT', () => `${S}/${ids.sub}`, { account_id: 987654 }],
  ['s put account same', 'PUT', () => `${S}/${ids.sub}`, () => ({ account_id: ids.acc })],
  ['s put visibility', 'PUT', () => `${S}/${ids.sub}`, { visibility: 'private' }],
  ['s put visibility bad', 'PUT', () => `${S}/${ids.sub}`, { visibility: 'shared_amount' }],
  ['s put pause', 'PUT', () => `${S}/${ids.subYearly}`, { enabled: false }],
  ['s put resume', 'PUT', () => `${S}/${ids.subYearly}`, { enabled: true, reminder_enabled: true }],
  ['s put gone bad body', 'PUT', `${S}/987654`, { name: 5 }],
  ['s renew', 'POST', () => `${S}/${ids.sub}/renew`, NO_BODY],
  () => { ids.token = answered['s renew'].body.undo.token; },
  ['s renew undo stale token', 'POST', () => `${S}/${ids.sub}/renew/undo`, { token: 'nope' }],
  ['s renew again', 'POST', () => `${S}/${ids.sub}/renew`, NO_BODY],
  () => { ids.token = answered['s renew again'].body.undo.token; },
  ['s renew undo', 'POST', () => `${S}/${ids.sub}/renew/undo`, () => ({ token: ids.token })],
  ['s renew undo again', 'POST', () => `${S}/${ids.sub}/renew/undo`, () => ({ token: ids.token })],
  ['s renew undo no token', 'POST', () => `${S}/${ids.sub}/renew/undo`, {}],
  ['s renew undo token number', 'POST', () => `${S}/${ids.sub}/renew/undo`, { token: 5 }],
  ['s renew undo gone', 'POST', `${S}/987654/renew/undo`, { token: 'x' }],
  ['s renew undo zero', 'POST', `${S}/0/renew/undo`, { token: 'x' }],
  ['s renew once', 'POST', () => `${S}/${ids.subOnce}/renew`, NO_BODY],
  ['s renew completed', 'POST', () => `${S}/${ids.subOnce}/renew`, NO_BODY],
  ['s renew gone', 'POST', `${S}/987654/renew`, NO_BODY],
  ['s renew zero', 'POST', `${S}/0/renew`, NO_BODY],
  ['s renew minus zero', 'POST', `${S}/-0/renew`, NO_BODY],
  ['s renew hex', 'POST', `${S}/0x1/renew`, NO_BODY],
  ['s renew leading zero', 'POST', () => `${S}/0${ids.subYearly}/renew`, NO_BODY],
  () => { setConfig('budget_mode', 'personal'); },
  ['personal s put foreign', 'PUT', () => `${S}/${ids.subPrivate}`, { name: 'X' }],
  ['personal s renew foreign', 'POST', () => `${S}/${ids.subPrivate}/renew`, NO_BODY, { actor: 'other' }],
  ['personal s undo foreign', 'POST', () => `${S}/${ids.subPrivate}/renew/undo`, { token: 'x' }, { actor: 'other' }],
  ['personal s delete foreign', 'DELETE', () => `${S}/${ids.subPrivate}`, NO_BODY],
  ['personal s list', 'GET', S, NO_BODY, { actor: 'other' }],
  ['personal s meta', 'GET', `${S}/meta`, NO_BODY, { actor: 'other' }],
  () => { setConfig('budget_mode', 'shared'); },
  () => { restoreState.setRestoreRunning(true); },
  ['s list restoring', 'GET', S, NO_BODY],
  () => { restoreState.setRestoreRunning(false); },
  ['s list end', 'GET', S, NO_BODY],

  // ══ DELETES ════════════════════════════════════════════════════════════════
  ['s cat delete', 'DELETE', () => `${S}/categories/${ids.subCat}`, NO_BODY],
  ['s cat delete again', 'DELETE', () => `${S}/categories/${ids.subCat}`, NO_BODY],
  ['s cat delete zero', 'DELETE', `${S}/categories/0`, NO_BODY],
  ['s cat delete minus zero', 'DELETE', `${S}/categories/-0`, NO_BODY],
  ['s cat delete fraction', 'DELETE', `${S}/categories/1.0`, NO_BODY],
  ['s pm delete', 'DELETE', () => `${S}/payment-methods/0${ids.pm2}`, NO_BODY],
  ['s pm delete again', 'DELETE', () => `${S}/payment-methods/${ids.pm2}`, NO_BODY],
  ['s pm delete minus', 'DELETE', `${S}/payment-methods/-1`, NO_BODY],
  ['s pm delete letters', 'DELETE', `${S}/payment-methods/abc`, NO_BODY],
  ['s delete', 'DELETE', () => `${S}/${ids.sub}`, NO_BODY],
  ['s delete again', 'DELETE', () => `${S}/${ids.sub}`, NO_BODY],
  ['s delete leading zero', 'DELETE', () => `${S}/00${ids.subYearly}`, NO_BODY],
  ['s delete zero', 'DELETE', `${S}/0`, NO_BODY],
  ['s delete minus', 'DELETE', `${S}/-1`, NO_BODY],
  ['s delete fraction', 'DELETE', `${S}/1.0`, NO_BODY],
  ['e delete series not recurring', 'DELETE', () => `${B}/${ids.e2}/series`, NO_BODY],
  ['e delete series', 'DELETE', () => `${B}/0${ids.series}/series`, NO_BODY],
  ['e delete series again', 'DELETE', () => `${B}/${ids.series}/series`, NO_BODY],
  ['e delete series zero', 'DELETE', `${B}/0/series`, NO_BODY],
  ['e delete series minus', 'DELETE', `${B}/-1/series`, NO_BODY],
  ['e delete series letters', 'DELETE', `${B}/abc/series`, NO_BODY],
  ['t delete series', 'DELETE', () => `${B}/${ids.t2}/series`, NO_BODY],
  ['t delete', 'DELETE', () => `${B}/${ids.t1}`, NO_BODY],
  ['e delete', 'DELETE', () => `${B}/${ids.e1}`, NO_BODY],
  ['e delete again', 'DELETE', () => `${B}/${ids.e1}`, NO_BODY],
  ['e delete leading zero', 'DELETE', () => `${B}/0${ids.e2}`, NO_BODY],
  ['e delete zero', 'DELETE', `${B}/0`, NO_BODY],
  ['e delete minus', 'DELETE', `${B}/-1`, NO_BODY],
  ['e delete minus zero', 'DELETE', `${B}/-0`, NO_BODY],
  ['e delete fraction', 'DELETE', `${B}/1.0`, NO_BODY],
  ['e delete trailing letters', 'DELETE', `${B}/1abc`, NO_BODY],
  ['e delete occurrence', 'DELETE', () => `${B}/${ids.pending}`, NO_BODY],
  ['sub delete in use', 'DELETE', `${B}/categories/haustier/subcategories/haustier_futter`, NO_BODY],
  ['sub delete', 'DELETE', `${B}/categories/haustier/subcategories/haustier_tierarzt`, NO_BODY],
  ['sub create garten', 'POST', `${B}/categories/garten/subcategories`, { name: 'Beet' }],
  ['sub delete last', 'DELETE', `${B}/categories/garten/subcategories/garten_beet`, NO_BODY],
  ['sub delete gone', 'DELETE', `${B}/categories/haustier/subcategories/nope`, NO_BODY],
  ['cat delete in use', 'DELETE', `${B}/categories/haustier`, NO_BODY],
  ['cat delete', 'DELETE', `${B}/categories/garten`, NO_BODY],
  ['cat delete gone', 'DELETE', `${B}/categories/garten`, NO_BODY],
  ['cat delete income', 'DELETE', `${B}/categories/bonus`, NO_BODY],
  ['acc delete', 'DELETE', () => `${B}/accounts/${ids.acc3}`, NO_BODY],
  ['acc delete again', 'DELETE', () => `${B}/accounts/${ids.acc3}`, NO_BODY],
  ['acc delete leading zero', 'DELETE', () => `${B}/accounts/0${ids.accUsd}`, NO_BODY],
  ['acc delete transfers', 'DELETE', () => `${B}/accounts/${ids.accSpare}`, NO_BODY],
  ['acc delete zero', 'DELETE', `${B}/accounts/0`, NO_BODY],
  ['acc delete minus', 'DELETE', `${B}/accounts/-1`, NO_BODY],
  ['acc delete minus zero', 'DELETE', `${B}/accounts/-0`, NO_BODY],
  ['acc delete letters', 'DELETE', `${B}/accounts/abc`, NO_BODY],
  ['acc delete fraction', 'DELETE', `${B}/accounts/1.0`, NO_BODY],
  ['acc list end', 'GET', `${B}/accounts?include_archived=true`, NO_BODY],
  ['e list end', 'GET', `${B}?month=2026-11`, NO_BODY],
];

// The document deletion lock of one row: held while the table runs.
lockDocumentDeletes([DOC_LOCKED]);
test.after(() => unlockDocumentDeletes([DOC_LOCKED]));

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
    if (process.env.G9_DUMP) fs.writeFileSync(process.env.G9_DUMP, JSON.stringify(answers));
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

const B_ = '/api/v1/budget';
const S_ = '/api/v1/budget/subscriptions';

test('an unexpected error in each accounts route is a 500 of the central handler (async PUT and DELETE too), and the process goes on', async () => {
  logged.error.length = 0;
  const account = await created(`${B}/accounts`, { name: 'Probe' });
  await assertAllCentral([
    ['GET', `${B}/accounts`, NO_BODY, `${B_}/accounts`],
    ['POST', `${B}/accounts`, { name: 'Probe 2' }, `${B_}/accounts`],
    ['PUT', `${B}/accounts/${account}`, { name: 'Probe 3' }, `${B_}/accounts/:id`],
    ['DELETE', `${B}/accounts/${account}`, NO_BODY, `${B_}/accounts/:id`],
  ]);
  assert.equal((await call('GET', `${B}/accounts`, NO_BODY)).status, 200);
});

test('an unexpected error in each categories route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  await call('POST', `${B}/categories`, { name: 'Probe' });
  await call('POST', `${B}/categories`, { name: 'Probe Zwei' });
  await call('POST', `${B}/categories/probe/subcategories`, { name: 'Eins' });
  await call('POST', `${B}/categories/probe/subcategories`, { name: 'Zwei' });
  await assertAllCentral([
    ['GET', `${B}/meta`, NO_BODY, `${B_}/meta`],
    ['GET', `${B}/categories`, NO_BODY, `${B_}/categories`],
    ['GET', `${B}/categories/probe/subcategories`, NO_BODY, `${B_}/categories/:categoryKey/subcategories`],
    ['POST', `${B}/categories`, { name: 'Probe Drei' }, `${B_}/categories`],
    ['PUT', `${B}/categories/probe`, { name: 'Probe Vier' }, `${B_}/categories/:key`],
    ['DELETE', `${B}/categories/probe_zwei`, NO_BODY, `${B_}/categories/:key`],
    ['PATCH', `${B}/categories/reorder`, { order: ['probe'] }, `${B_}/categories/reorder`],
    ['POST', `${B}/categories/probe/subcategories`, { name: 'Drei' }, `${B_}/categories/:categoryKey/subcategories`],
    ['PUT', `${B}/categories/probe/subcategories/probe_eins`, { name: 'Vier' }, `${B_}/categories/:key/subcategories/:subKey`],
    ['DELETE', `${B}/categories/probe/subcategories/probe_zwei`, NO_BODY, `${B_}/categories/:key/subcategories/:subKey`],
    ['PATCH', `${B}/categories/probe/subcategories/reorder`, { order: ['probe_eins'] }, `${B_}/categories/:key/subcategories/reorder`],
  ]);
  assert.equal((await call('GET', `${B}/categories`, NO_BODY)).status, 200);
});

test('an unexpected error in each entries route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const entry = await created(B, ENTRY({ title: 'Probe' }));
  const series = await created(B, ENTRY({ title: 'Probe Serie', is_recurring: 1 }));
  const pending = await created(B, ENTRY({ title: 'Probe offen', date: '2026-09-02', is_recurring: 1, recurrence_confirm: 1 }));
  await call('GET', `${B}?month=2026-10`, NO_BODY);
  const occurrence = database().prepare('SELECT id FROM budget_entries WHERE recurrence_parent_id = ? AND is_pending = 1 LIMIT 1').get(pending).id;
  await assertAllCentral([
    ['GET', `${B}/summary`, NO_BODY, `${B_}/summary`],
    ['GET', `${B}/export`, NO_BODY, `${B_}/export`],
    ['GET', `${B}?month=2026-11`, NO_BODY, `${B_}/`],
    ['POST', B, ENTRY({ title: 'Probe 2' }), `${B_}/`],
    ['PUT', `${B}/${series}/series`, { title: 'Probe Serie 2' }, `${B_}/:id/series`],
    ['DELETE', `${B}/${series}/series`, NO_BODY, `${B_}/:id/series`],
    ['PUT', `${B}/${entry}`, { title: 'Probe 3' }, `${B_}/:id`],
    ['PATCH', `${B}/${occurrence}/confirm`, {}, `${B_}/:id/confirm`],
    ['DELETE', `${B}/${entry}`, NO_BODY, `${B_}/:id`],
  ]);
  // The ledger search answers inside the list route.
  assertCentral(await call('GET', `${B}?q=probe`, NO_BODY, { fail: true }), 'GET', `${B_}/`);
  assert.equal((await call('GET', `${B}?month=2026-11`, NO_BODY)).status, 200);
});

test('an unexpected error in each loans route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const loan = await created(`${B}/loans`, LOAN({ title: 'Probe' }));
  const paid = await call('POST', `${B}/loans/${loan}/payments`, { paid_date: '2026-11-01' });
  const payment = /** @type {any} */ (paid.body).data.payment.id;
  await assertAllCentral([
    ['POST', `${B}/loans/preview`, { interest_mode: 'fixed', principal: 1000, fixed_rate: 1, initial_repayment_rate: 5 }, `${B_}/loans/preview`],
    ['GET', `${B}/loans`, NO_BODY, `${B_}/loans`],
    ['POST', `${B}/loans`, LOAN({ title: 'Probe 2' }), `${B_}/loans`],
    ['PUT', `${B}/loans/${loan}`, { title: 'Probe 3' }, `${B_}/loans/:id`],
    ['POST', `${B}/loans/${loan}/payments`, { paid_date: '2026-11-02' }, `${B_}/loans/:id/payments`],
    ['DELETE', `${B}/loans/${loan}/payments/${payment}`, NO_BODY, `${B_}/loans/:id/payments/:paymentId`],
    ['DELETE', `${B}/loans/${loan}`, NO_BODY, `${B_}/loans/:id`],
  ]);
  assert.equal((await call('GET', `${B}/loans`, NO_BODY)).status, 200);
});

test('an unexpected error in each plans and stats route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  await assertAllCentral([
    ['GET', `${B}/plans`, NO_BODY, `${B_}/plans`],
    ['PUT', `${B}/plans/food`, { amount: 5 }, `${B_}/plans/:category`],
    ['DELETE', `${B}/plans/food`, NO_BODY, `${B_}/plans/:category`],
    ['GET', `${B}/stats`, NO_BODY, `${B_}/stats`],
  ]);
  assert.equal((await call('GET', `${B}/plans`, NO_BODY)).status, 200);
  assert.equal((await call('GET', `${B}/stats`, NO_BODY)).status, 200);
});

test('an unexpected error in each transfers route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const from = await created(`${B}/accounts`, { name: 'Probe von' });
  const to = await created(`${B}/accounts`, { name: 'Probe nach' });
  const transfer = await created(`${B}/transfers`, TRANSFER({ from_account_id: from, to_account_id: to }));
  const recurring = await created(`${B}/transfers`, TRANSFER({ from_account_id: from, to_account_id: to, is_recurring: true, date: '2026-12-01' }));
  await assertAllCentral([
    ['GET', `${B}/transfers/${transfer}`, NO_BODY, `${B_}/transfers/:id`],
    ['POST', `${B}/transfers`, TRANSFER({ from_account_id: from, to_account_id: to }), `${B_}/transfers`],
    ['PUT', `${B}/transfers/${transfer}`, { title: 'Probe 2' }, `${B_}/transfers/:id`],
    ['PUT', `${B}/transfers/${recurring}/series`, { title: 'Probe 3' }, `${B_}/transfers/:id/series`],
  ]);
  assert.equal((await call('GET', `${B}/transfers/${transfer}`, NO_BODY)).status, 200);
});

test('an unexpected error in each subscriptions route is a 500 of the central handler (async routes: a rejected promise), and the process goes on', async () => {
  logged.error.length = 0;
  const sub = await created(S, SUB({ name: 'Probe' }));
  const category = await created(`${S}/categories`, { name: 'Probe' });
  const method = await created(`${S}/payment-methods`, { name: 'Probe' });
  const renewed = await call('POST', `${S}/${sub}/renew`, NO_BODY);
  const token = /** @type {any} */ (renewed.body).undo.token;
  await assertAllCentral([
    ['GET', `${S}/meta`, NO_BODY, `${S_}/meta`],
    ['GET', `${S}/settings`, NO_BODY, `${S_}/settings`],
    ['PUT', `${S}/settings`, { monthly_budget: 5, base_currency: 'EUR' }, `${S_}/settings`],
    ['POST', `${S}/categories`, { name: 'Probe 2' }, `${S_}/categories`],
    ['POST', `${S}/payment-methods`, { name: 'Probe 2' }, `${S_}/payment-methods`],
    ['PUT', `${S}/meta/order`, { categories: [category] }, `${S_}/meta/order`],
    ['PUT', `${S}/categories/${category}`, { name: 'Probe 3' }, `${S_}/categories/:id`],
    ['PUT', `${S}/payment-methods/${method}`, { name: 'Probe 3' }, `${S_}/payment-methods/:id`],
    ['GET', S, NO_BODY, `${S_}/`],
    ['POST', S, SUB({ name: 'Probe 2' }), `${S_}/`],
    ['PUT', `${S}/${sub}`, { name: 'Probe 3' }, `${S_}/:id`],
    ['POST', `${S}/${sub}/renew/undo`, { token }, `${S_}/:id/renew/undo`],
    ['POST', `${S}/${sub}/renew`, NO_BODY, `${S_}/:id/renew`],
    ['DELETE', `${S}/categories/${category}`, NO_BODY, `${S_}/categories/:id`],
    ['DELETE', `${S}/payment-methods/${method}`, NO_BODY, `${S_}/payment-methods/:id`],
    ['DELETE', `${S}/${sub}`, NO_BODY, `${S_}/:id`],
  ]);
  // The logo search: a database error is no failure of the website.
  assertCentral(await call('POST', `${S}/logo-search`, { query: 'database' }), 'POST', `${S_}/logo-search`);
  assert.equal((await call('GET', S, NO_BODY)).status, 200);
});

test('the handled cases keep their own answer and never reach the central handler', async () => {
  logged.error.length = 0;
  // A UNIQUE violation is the route's 409, at create and rename.
  await created(`${S}/categories`, { name: 'Doppelt' });
  const category = await created(`${S}/categories`, { name: 'Einzeln' });
  await created(`${S}/payment-methods`, { name: 'Doppelt' });
  const method = await created(`${S}/payment-methods`, { name: 'Einzeln' });
  assert.deepEqual(await call('POST', `${S}/categories`, { name: 'Doppelt' }), { status: 409, body: { error: 'Category already exists.', code: 409, reason: 'subscriptions_category_exists' } });
  assert.deepEqual(await call('PUT', `${S}/categories/${category}`, { name: 'Doppelt' }), { status: 409, body: { error: 'Category already exists.', code: 409, reason: 'subscriptions_category_exists' } });
  assert.deepEqual(await call('POST', `${S}/payment-methods`, { name: 'Doppelt' }), { status: 409, body: { error: 'Payment method already exists.', code: 409, reason: 'subscriptions_payment_method_exists' } });
  assert.deepEqual(await call('PUT', `${S}/payment-methods/${method}`, { name: 'Doppelt' }), { status: 409, body: { error: 'Payment method already exists.', code: 409, reason: 'subscriptions_payment_method_exists' } });
  // The subscription goes while its booking is computed: 404, at create, update and renewal.
  const gone = { status: 404, body: { error: 'Subscription not found.', code: 404, reason: 'subscriptions_subscription_not_found' } };
  try {
    rates.mode = 'vanish';
    rates.vanish = Number(lastId('budget_subscriptions')) + 1;
    assert.deepEqual(await call('POST', S, SUB({ name: 'Weg', currency: 'USD' })), gone, 'create');
    const sub = await (async () => { rates.mode = 'ok'; return created(S, SUB({ name: 'Weg 2', currency: 'USD' })); })();
    rates.mode = 'vanish';
    rates.vanish = sub;
    assert.deepEqual(await call('PUT', `${S}/${sub}`, { name: 'Weg 3' }), gone, 'update');
    rates.mode = 'ok';
    const sub2 = await created(S, SUB({ name: 'Weg 4', currency: 'USD' }));
    rates.mode = 'vanish';
    rates.vanish = sub2;
    assert.deepEqual(await call('POST', `${S}/${sub2}/renew`, NO_BODY), gone, 'renew');
    // The renewal is saved; its booking waits for the exchange rate.
    rates.mode = 'ok';
    const sub3 = await created(S, SUB({ name: 'Kurs fehlt', currency: 'USD' }));
    rates.mode = 'fail';
    const renewed = await call('POST', `${S}/${sub3}/renew`, NO_BODY);
    assert.equal(renewed.status, 200);
    assert.equal(/** @type {any} */ (renewed.body).data.next_payment_date, '2027-01-01');
    const undone = await call('POST', `${S}/${sub3}/renew/undo`, { token: /** @type {any} */ (renewed.body).undo.token });
    assert.equal(undone.status, 200);
    assert.equal(/** @type {any} */ (undone.body).data.next_payment_date, '2026-12-01');
  } finally {
    rates.mode = 'ok';
  }
  // The logo search keeps its 400, 404 and 502.
  assert.deepEqual(await call('POST', `${S}/logo-search`, { query: 'refused' }), { status: 400, body: { error: 'That address is not allowed.', code: 400 } });
  assert.equal((await call('POST', `${S}/logo-search`, { query: 'none' })).status, 404);
  assert.deepEqual(await call('POST', `${S}/logo-search`, { query: 'down' }), { status: 502, body: { error: 'The website could not be reached.', code: 502, reason: 'remote_unreachable', detail: 'ENOTFOUND' } });
  // The document link refusal and the deletion lock of a receipt.
  assert.deepEqual((await call('POST', B, ENTRY({ attachment_document_ids: [DOC] }), { actor: 'nodocs' })).body,
    { error: 'Linking a document requires access to documents.', code: 403, reason: 'cross_module_access' });
  lockDocumentDeletes([DOC]);
  try {
    assert.equal((await call('POST', B, ENTRY({ attachment_document_ids: [DOC] }))).status, 409);
  } finally {
    unlockDocumentDeletes([DOC]);
  }
  // The restore gate stands in front of the list.
  restoreState.setRestoreRunning(true);
  try {
    assert.equal((await call('GET', S, NO_BODY)).status, 503);
  } finally {
    restoreState.setRestoreRunning(false);
  }
  assert.deepEqual(logged.error, [], 'none of them reached the central handler');
});

// ── Sinks ────────────────────────────────────────────────────────────────────

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
  const req = { method: method.toUpperCase(), body, query, params, authUserId: ADMIN, authRole: 'admin', authScopes: null, session: { userId: ADMIN, role: 'admin' }, sessionModuleAccess: null };
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
// a loop, `.map()`, `.length` or a string method runs over the raw value, so
// the handler keeps its own type check there (sink, not route; CodeQL
// js/loop-bound-injection in #2860): called without validateRequest(), each
// answers as it did instead of throwing or looping.

test('sink: the category and subcategory reorder keep their list check', async () => {
  for (const order of ['x', { length: 1e9 }, 5]) {
    assert.deepEqual(await callBare('budget/categories.js', 'patch', '/categories/reorder', { body: { order } }),
      { status: 200, body: { data: true } }, `categories ${JSON.stringify(order)}`);
    assert.deepEqual(await callBare('budget/categories.js', 'patch', '/categories/:key/subcategories/reorder', { body: { order }, params: { key: 'food' } }),
      { status: 200, body: { data: true } }, `subcategories ${JSON.stringify(order)}`);
  }
});

test('sink: the subscription meta order keeps its list check in front of .map()', async () => {
  for (const raw of ['x', { length: 1e9 }, 5]) {
    assert.deepEqual(await callBare('subscriptions.js', 'put', '/meta/order', { body: { categories: raw, payment_methods: raw } }),
      { status: 400, body: { error: 'An order list is required.', code: 400 } }, JSON.stringify(raw));
  }
});

test('sink: an entry keeps the list check of its responsible people', async () => {
  for (const raw of ['x', { length: 1e9 }]) {
    const res = await callBare('budget/entries.js', 'post', '/', { body: ENTRY({ title: 'Senke', responsible_user_ids: raw }) });
    assert.equal(res.status, 201, JSON.stringify(raw));
    assert.deepEqual(/** @type {any} */ (res.body).data.responsible_users, [], JSON.stringify(raw));
  }
  // The series: its definition gets the same list (replaceSeriesResponsibles).
  const series = await callBare('budget/entries.js', 'post', '/', { body: ENTRY({ title: 'Senke Serie', date: '2026-12-02', is_recurring: 1 }) });
  const id = String(/** @type {any} */ (series.body).data.id);
  for (const raw of ['x', { length: 1e9 }]) {
    const res = await callBare('budget/entries.js', 'put', '/:id/series', { body: { responsible_user_ids: raw }, params: { id } });
    assert.equal(res.status, 200, `series ${JSON.stringify(raw)}`);
    assert.deepEqual(/** @type {any} */ (res.body).data.responsible_users, [], `series ${JSON.stringify(raw)}`);
  }
});

test('sink: the ledger search reads its query as text', async () => {
  for (const q of [{ length: 1e9 }, ['miete', 'x'], 5]) {
    const res = await callBare('budget/entries.js', 'get', '/', { query: { q } });
    assert.ok(res.status === 200 || res.status === 400, `${JSON.stringify(q)}: ${res.status}`);
  }
  assert.deepEqual(await callBare('budget/entries.js', 'get', '/', { query: { q: { length: 1e9 } } }).then((r) => /** @type {any} */ (r.body).meta.query), '[object Object]');
});

test('sink: the month list and the summary keep the month check in front of month.split() and the projection', async () => {
  const sentence = { error: 'month must be in YYYY-MM format.', code: 400 };
  for (const month of [{ length: 1e9 }, '2026-1', 5]) {
    assert.deepEqual(await callBare('budget/entries.js', 'get', '/', { query: { month } }), { status: 400, body: sentence }, `list ${JSON.stringify(month)}`);
    assert.deepEqual(await callBare('budget/entries.js', 'get', '/summary', { query: { month } }), { status: 400, body: sentence }, `summary ${JSON.stringify(month)}`);
  }
});

test('sink: the logo search hands the finder text only', async () => {
  /** @type {unknown[]} */
  const seen = [];
  subscriptionRoutes._setLogoFinderForTest(async (/** @type {unknown} */ q) => { seen.push(q); return []; });
  try {
    for (const query of [5, { length: 1e9 }, ['a']]) await callBare('subscriptions.js', 'post', '/logo-search', { body: { query } });
  } finally {
    subscriptionRoutes._setLogoFinderForTest(logoFinder);
  }
  assert.deepEqual(seen.map((q) => typeof q), ['string', 'string', 'string']);
});
