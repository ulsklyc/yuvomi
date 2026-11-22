/**
 * Test: request validation in the budget and the subscriptions (#2810, phase 2
 *       section E, group 9)
 * Purpose: the seven budget route files under server/routes/budget/ (39
 *          routes) and server/routes/subscriptions.js (17) check every request
 *          against the schema of its operation in the OpenAPI document
 *          (`validateRequest()` in every route) before the handler runs. Held
 *          here against the real routers at their real prefixes, in the order
 *          of server/index.js (express.json, defaultEmptyBody, the
 *          subscriptions before the budget, the central error handler;
 *          test/budget-app.js):
 *            - THE OWN CALLERS: the requests public/pages/budget.js,
 *              budget-plans.js, budget-stats.js, inventory.js,
 *              components/budget-transfer-dialog.js, category-manager.js and
 *              pages/subscriptions.js send pass - switches as 0/1 on entries
 *              and as booleans on transfers, `null` where the page sends it;
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              and `fields`: a path id that is not plain decimal digits
 *              (`DELETE /accounts/1abc` deleted account 1), a non-text in a
 *              text field (`name: {}` was stored as `[object Object]`),
 *              `null` as an amount (read as 0), a month 13 (`GET
 *              /budget?month=2026-13` wrote an entry dated `2026-13-05`), an
 *              unknown `interest_mode` or `visibility` (silently the default),
 *              `order: [{}]` (a 500), query garbage and doubled values;
 *            - THE SUBSCRIPTIONS ROUTER: its own error handler is gone, so the
 *              400 of the schema arrives as a 400 (it was a 500
 *              `Internal error.`), and an unexpected error is the 500 of the
 *              central handler;
 *            - ORDER: a malformed request is a 400 before the 404 and the 403
 *              of the handler; with a valid body, a member without the right
 *              still meets the 403 at the nine routes with a body;
 *            - THE SINK: the logo search reaches the network finder only with
 *              text (`query: 5` was looked up as the host `5`);
 *            - ONE SOURCE: every value list of the schemas is the constant the
 *              handler reads (server/services/budget-fields.js), equal to the
 *              visibility lists of the rights.
 *          The household zone is pinned; no answer asserted here carries a
 *          date of the clock, and every date sent lies in a fixed year.
 * Run: npm run test:validate-budget
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-validate-budget-');
delete process.env.FIXER_API_KEY;

import test from 'node:test';
import assert from 'node:assert/strict';
import rateLimit from 'express-rate-limit';
import { createBudgetApp } from './budget-app.js';

const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const fields = await import('../server/services/budget-fields.js');
const rows = await import('../server/authorize/rows/budget.ts');
const subscriptionService = await import('../server/services/subscriptions.js');
const helpers = await import('../server/routes/budget/helpers.js');
const subscriptionRoutes = await import('../server/routes/subscriptions.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';

/** @param {string} config @param {string} value */
function setConfig(config, value) {
  db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(config, value);
}
/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, 'parent')")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('admin9', 'admin');
const MEM = user('mem9', 'member');
const OTHER = user('other9', 'member');
setConfig('household_timezone', 'Europe/Berlin');
setConfig('currency', 'EUR');
setConfig('budget_mode', 'shared');

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = { admin: { id: ADMIN, role: 'admin' }, mem: { id: MEM, role: 'member' }, other: { id: OTHER, role: 'member' } };

// No network: the logo finder and the exchange rates are stand-ins.
/** @type {unknown[]} */
const logoQueries = [];
subscriptionRoutes._setLogoFinderForTest(async (/** @type {unknown} */ q) => {
  logoQueries.push(q);
  return [{ logo_data: 'data:image/png;base64,iVBORw0KGgo=' }];
});
subscriptionRoutes._setRatesForTest(async () => ({ rates: {}, fetched_at: '2030-01-01T00:00:00Z' }));

const app = await createBudgetApp({
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.session = { userId: actor.id, role: actor.role };
    next();
  },
  // The routes check rights per row; in server/index.js the general API
  // limiter stands in front of them, here a generous one does.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  jsonLimit: '2mb',
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => {
  subscriptionRoutes._setLogoFinderForTest(null);
  subscriptionRoutes._setRatesForTest(null);
  server.close();
});

/**
 * @param {string} method
 * @param {string} route under /api/v1/budget
 * @param {{ json?: unknown, actor?: string }} [options] json left out: no body
 */
async function call(method, route, { json, actor } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor !== undefined) headers['x-actor'] = actor;
  /** @type {any} */
  let payload;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}/api/v1/budget${route}`, { method, headers, body: payload });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no JSON body */ }
  return { status: res.status, body, text };
}

/**
 * A 400 of the schema check naming `path` (and `rule`, when given) among its fields.
 * @param {{ status: number, body: any }} r
 * @param {string} path
 * @param {string} [rule]
 * @param {string} [label]
 */
function assertRefused(r, path, rule, label = path) {
  assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error, SENTENCE, label);
  assert.equal(r.body?.reason, 'validation', label);
  const hit = (r.body?.fields ?? []).find((/** @type {any} */ f) => f.path === path && (rule === undefined || f.rule === rule));
  assert.ok(hit, `${label}: field ${path}${rule ? ` (${rule})` : ''} in ${JSON.stringify(r.body?.fields)}`);
}

/** Passed the schema check: whatever the handler answers, it is not its 400 and no 500. */
function assertPassed(/** @type {{ status: number, body: any }} */ r, /** @type {string} */ label) {
  assert.ok(r.status !== 400 || r.body?.reason !== 'validation', `${label}: ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.status < 500, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** @param {number} status @param {{ status: number, body: any }} r @param {string} label */
function assertStatus(status, r, label) {
  assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
}

/** @param {Record<string, unknown>} [over] */
async function newAccount(over = {}) {
  const r = await call('POST', '/accounts', { json: { name: `Konto ${Math.random()}`, type: 'checking', starting_balance: 0, color: null, credit_bank: null, credit_limit: null, ...over } });
  assertStatus(201, r, 'account');
  return r.body.data.id;
}
/** @param {Record<string, unknown>} [over] @param {string} [actor] */
async function newEntry(over = {}, actor = 'admin') {
  const r = await call('POST', '', { actor, json: { title: 'Strom', amount: -50, category: 'housing', subcategory: '', date: '2030-03-05', is_recurring: 0, recurrence_interval: 'monthly', recurrence_interval_count: 1, recurrence_virtual: 0, recurrence_confirm: 0, ...over } });
  assertStatus(201, r, 'entry');
  return r.body.data.id;
}
const LOAN = { borrower: 'Bank', title: 'Auto', start_month: '2030-01', notes: '', interest_mode: 'none', total_amount: 1200, installment_count: 12, due_day: null, currency: 'EUR', exchange_rate: 1, direction: 'borrowed' };
/** @param {string} [actor] */
async function newLoan(actor = 'admin') {
  const r = await call('POST', '/loans', { actor, json: LOAN });
  assertStatus(201, r, 'loan');
  return r.body.data.id;
}
const SUBSCRIPTION = {
  name: 'Video', description: null, amount: 9.99, currency: 'EUR', billing_cycle: 'monthly', cycle_interval: 1,
  next_payment_date: '2030-02-01', reminder_days: 3, reminder_enabled: true, category_id: null, payment_method_id: null,
  website_url: null, brand_color: '#123456', logo_data: null, notes: null, account_username: null, enabled: true,
  end_type: 'never', end_date: null, occurrence_count: null,
};
/** @param {string} [actor] */
async function newSubscription(actor = 'admin') {
  const r = await call('POST', '/subscriptions', { actor, json: SUBSCRIPTION });
  assertStatus(201, r, 'subscription');
  return r.body.data.id;
}

// --------------------------------------------------------------------------
// The own callers
// --------------------------------------------------------------------------

test('accounts and categories: the budget page and the category manager pass', async () => {
  const account = await newAccount();
  await newAccount({ name: 'Visa', type: 'credit', color: 'var(--chart-series-2)', credit_bank: 'Bank', credit_limit: 2000 });
  for (const [method, route, json, label] of /** @type {Array<[string, string, any, string]>} */ ([
    ['PUT', `/accounts/${account}`, { name: 'Giro', type: 'checking', starting_balance: 12.5, color: null, credit_bank: null, credit_limit: null }, 'account dialog'],
    ['PUT', `/accounts/${account}`, { archived: true }, 'archive'],
    ['PUT', `/accounts/${account}`, { archived: false }, 'restore'],
    ['POST', '/categories', { name: 'Hobby', type: 'expense' }, 'category add'],
    ['POST', '/categories/hobby/subcategories', { name: 'Modellbau' }, 'subcategory add'],
    ['PUT', '/categories/hobby', { name: 'Hobbys' }, 'category rename'],
    ['PATCH', '/categories/reorder', { order: ['hobby', 'food'], type: 'expense' }, 'category order'],
    ['PATCH', '/categories/hobby/subcategories/reorder', { order: ['modellbau'] }, 'subcategory order'],
  ])) {
    assertPassed(await call(method, route, { json }), label);
  }
  for (const route of ['/accounts', '/accounts?include_archived=1', '/meta', '/categories', '/categories?lang=de', '/categories?lang=xx', '/categories/food/subcategories?lang=en']) {
    assertStatus(200, await call('GET', route), route);
  }
});

test('entries: the ledger, the dialog, the series and the confirmation pass', async () => {
  const account = await newAccount();
  const body = { title: 'Miete', amount: -800, category: 'housing', subcategory: '', date: '2030-03-01', is_recurring: 1, recurrence_interval: 'monthly', recurrence_interval_count: 1, recurrence_virtual: 0, recurrence_confirm: 1, account_id: account, responsible_user_ids: [MEM], visibility: 'shared', attachment_document_ids: [] };
  const created = await call('POST', '', { json: body });
  assertStatus(201, created, 'dialog create');
  const id = created.body.data.id;
  assertPassed(await call('PUT', `/${id}`, { json: { ...body, is_recurring: 1, account_id: null } }), 'dialog edit, account cleared');
  assertPassed(await call('PUT', `/${id}/series`, { json: { title: 'Kaltmiete', amount: -750, start_date: '2030-03-02' } }), 'series edit (changed fields)');
  const pending = await newEntry({ recurrence_confirm: 1 });
  db.prepare('UPDATE budget_entries SET is_pending = 1 WHERE id = ?').run(pending);
  assertPassed(await call('PATCH', `/${pending}/confirm`, { json: { amount: -49.5, date: '2030-03-06' } }), 'confirm with values');
  const pending2 = await newEntry();
  db.prepare('UPDATE budget_entries SET is_pending = 1 WHERE id = ?').run(pending2);
  assertPassed(await call('PATCH', `/${pending2}/confirm`, { json: { amount: -50 } }), 'confirm, date left out');
  const pending3 = await newEntry();
  db.prepare('UPDATE budget_entries SET is_pending = 1 WHERE id = ?').run(pending3);
  assertStatus(200, await call('PATCH', `/${pending3}/confirm`), 'confirm without a body');
  const loan = await newLoan();
  for (const route of [
    '?month=2030-03', `?month=2030-03&account_id=${account}&scope=household`, '?q=Miete', `?q=Miete&account_id=${account}&scope=mine`,
    `?loan_id=${loan}`, '/summary?month=2030-03', `/summary?month=2030-02&account_id=${account}&scope=household`,
    '/export?month=2030-03&scope=mine', '/export?from=2030-01-01&to=2030-12-31', '/stats?range=month&anchor=2030-03-15&scope=mine',
    '/stats?range=year&anchor=2030-03-15', '/plans?month=2030-03&scope=household', '/loans',
  ]) {
    assertStatus(200, await call('GET', route), route);
  }
  assertStatus(204, await call('DELETE', `/${await newEntry()}`), 'delete');
  assertStatus(204, await call('DELETE', `/${id}/series`), 'delete series');
});

test('loans, plans and transfers: the loan dialog, the plan page and the transfer dialog pass', async () => {
  const account = await newAccount();
  const { total_amount: _total, installment_count: _count, ...noTerms } = LOAN;
  const fixed = { ...noTerms, interest_mode: 'fixed', principal: 100000, fixed_rate: 3, initial_repayment_rate: 2, account_id: account, due_day: 15 };
  assertStatus(200, await call('POST', '/loans/preview', { json: { interest_mode: 'fixed_then_variable', principal: 100000, fixed_rate: 3, initial_repayment_rate: 2, fixed_period_months: 120, followup_rate: 4 } }), 'preview');
  assertStatus(200, await call('POST', '/loans/preview', { json: { ...fixed, paid_installments: 2 } }), 'preview with the full save body');
  const loan = await call('POST', '/loans', { json: { ...LOAN, account_id: null, paid_installments: 1 } });
  assertStatus(201, loan, 'loan');
  assertStatus(201, await call('POST', '/loans', { json: fixed }), 'loan with interest');
  assertStatus(200, await call('PUT', `/loans/${loan.body.data.id}`, { json: { ...LOAN, account_id: account, due_day: 3 } }), 'loan edit');
  const pay = await call('POST', `/loans/${loan.body.data.id}/payments`, { json: { installment_number: 2, amount: 100, paid_date: '2030-02-03' } });
  assertStatus(201, pay, 'mark paid');
  assertStatus(204, await call('DELETE', `/loans/${loan.body.data.id}/payments/${pay.body.data.payment.id}`), 'undo payment');
  assertStatus(204, await call('DELETE', `/loans/${loan.body.data.id}`), 'delete loan');

  assertStatus(200, await call('PUT', '/plans/food', { json: { amount: 300 } }), 'plan');
  assertStatus(200, await call('DELETE', '/plans/food'), 'plan removed');

  const other = await newAccount();
  const transfer = { title: 'Sparen', amount: 100, category: 'financial_other', subcategory: '', date: '2030-03-10', from_account_id: account, to_account_id: other, visibility: 'shared', is_recurring: true, recurrence_interval: 'monthly', recurrence_interval_count: 1, recurrence_confirm: false };
  const made = await call('POST', '/transfers', { json: transfer });
  assertStatus(201, made, 'transfer');
  assertStatus(200, await call('GET', `/transfers/${made.body.data.id}`), 'transfer read');
  assertPassed(await call('PUT', `/transfers/${made.body.data.id}/series`, { json: { ...transfer, amount: 120 } }), 'transfer series');
  const once = await call('POST', '/transfers', { json: { ...transfer, is_recurring: false } });
  assertStatus(201, once, 'single transfer');
  const { is_recurring: _r, recurrence_interval: _i, recurrence_interval_count: _c, recurrence_confirm: _f, ...plain } = transfer;
  assertStatus(200, await call('PUT', `/transfers/${once.body.data.id}`, { json: { ...plain, amount: 90 } }), 'transfer edit');
});

test('subscriptions: the page, its dialogs and the meta manager pass', async () => {
  const category = await call('POST', '/subscriptions/categories', { json: { name: 'Medien', color: '#0F766E' } });
  assertStatus(201, category, 'category');
  const method = await call('POST', '/subscriptions/payment-methods', { json: { name: 'Karte 9' } });
  assertStatus(201, method, 'payment method');
  const account = await newAccount();
  const created = await call('POST', '/subscriptions', { json: { ...SUBSCRIPTION, category_id: category.body.data.id, payment_method_id: method.body.data.id, account_id: account, visibility: 'shared' } });
  assertStatus(201, created, 'create');
  const id = created.body.data.id;
  for (const [verb, route, json, label] of /** @type {Array<[string, string, any, string]>} */ ([
    ['PUT', `/subscriptions/${id}`, { ...SUBSCRIPTION, amount: 10.99, account_id: null, end_type: 'after_count', occurrence_count: 12 }, 'edit'],
    ['PUT', '/subscriptions/settings', { monthly_budget: 50, base_currency: 'EUR' }, 'settings'],
    ['PUT', `/subscriptions/categories/${category.body.data.id}`, { name: 'Filme', color: '#112233' }, 'category rename'],
    ['PUT', `/subscriptions/payment-methods/${method.body.data.id}`, { name: 'Kreditkarte 9' }, 'method rename'],
    ['PUT', '/subscriptions/meta/order', { categories: [category.body.data.id] }, 'category order'],
    ['PUT', '/subscriptions/meta/order', { payment_methods: [method.body.data.id] }, 'method order'],
    ['POST', '/subscriptions/logo-search', { query: 'example.com' }, 'logo search'],
  ])) {
    assertPassed(await call(verb, route, { json }), label);
  }
  const renewed = await call('POST', `/subscriptions/${id}/renew`, { json: {} });
  assertStatus(200, renewed, 'renew');
  assertStatus(200, await call('POST', `/subscriptions/${id}/renew/undo`, { json: renewed.body.undo }), 'undo');
  for (const route of ['/subscriptions', `/subscriptions?q=Vid&category_id=${category.body.data.id}&payment_method_id=${method.body.data.id}&status=active&refresh_rates=true`, '/subscriptions?status=completed', '/subscriptions?enabled=true', '/subscriptions/meta', '/subscriptions/settings']) {
    assertStatus(200, await call('GET', route), route);
  }
  assertStatus(204, await call('DELETE', `/subscriptions/${id}`), 'delete');
  assertStatus(200, await call('DELETE', `/subscriptions/categories/${category.body.data.id}`), 'category delete');
  assertStatus(200, await call('DELETE', `/subscriptions/payment-methods/${method.body.data.id}`), 'method delete');
});

// --------------------------------------------------------------------------
// Refused: garbage per field
// --------------------------------------------------------------------------

test('garbage in a body field is a 400 that names the field, before the handler reads it', async () => {
  const account = await newAccount();
  const entry = await newEntry({ is_recurring: 1 });
  const loan = await newLoan();
  const subscription = await newSubscription();
  const other = await newAccount();
  const transfer = (await call('POST', '/transfers', { json: { title: 'T', amount: 5, date: '2030-03-10', category: 'financial_other', from_account_id: account, to_account_id: other } })).body.data.id;
  /** @type {string[]} */
  const failures = [];
  for (const [method, route, json, path, rule] of /** @type {Array<[string, string, any, string, string]>} */ ([
    ['POST', '/accounts', { name: {} }, 'body/name', 'type'],
    ['POST', '/accounts', { name: 5 }, 'body/name', 'type'],
    ['POST', '/accounts', { name: 'A', type: '' }, 'body/type', 'enum'],
    ['POST', '/accounts', { name: 'A', starting_balance: '12' }, 'body/starting_balance', 'type'],
    ['POST', '/accounts', { name: 'A', starting_balance: true }, 'body/starting_balance', 'type'],
    ['PUT', `/accounts/${account}`, { starting_balance: null }, 'body/starting_balance', 'type'],
    ['PUT', `/accounts/${account}`, { type: '' }, 'body/type', 'enum'],
    ['PUT', `/accounts/${account}`, { archived: 'false' }, 'body/archived', 'type'],
    ['PUT', `/accounts/${account}`, { credit_limit: '' }, 'body/credit_limit', 'type'],
    ['POST', '/categories', { name: {} }, 'body/name', 'type'],
    ['POST', '/categories', { name: 'X', type: '' }, 'body/type', 'enum'],
    ['PATCH', '/categories/reorder', { order: [{}] }, 'body/order/0', 'type'],
    ['PATCH', '/categories/reorder', { order: [true] }, 'body/order/0', 'type'],
    ['PATCH', '/categories/reorder', { order: [] }, 'body/order', 'minItems'],
    ['PATCH', '/categories/reorder', {}, 'body/order', 'required'],
    ['PATCH', '/categories/food/subcategories/reorder', { order: [{}] }, 'body/order/0', 'type'],
    ['POST', '/categories/food/subcategories', { name: 5 }, 'body/name', 'type'],
    ['POST', '', { title: {}, amount: -5, date: '2030-03-01' }, 'body/title', 'type'],
    ['POST', '', { title: 'T', amount: null, date: '2030-03-01' }, 'body/amount', 'type'],
    ['POST', '', { title: 'T', amount: '-5', date: '2030-03-01' }, 'body/amount', 'type'],
    ['POST', '', { title: 'T', amount: [5], date: '2030-03-01' }, 'body/amount', 'type'],
    ['POST', '', { title: 'T', amount: -5, date: '2030-03-01', is_recurring: 'false' }, 'body/is_recurring', 'anyOf'],
    ['POST', '', { title: 'T', amount: -5, date: '2030-03-01', visibility: 'bad' }, 'body/visibility', 'enum'],
    ['POST', '', { title: 'T', amount: -5, date: '2030-03-01', account_id: '' }, 'body/account_id', 'type'],
    ['POST', '', { title: 'T', amount: -5, date: '2030-03-01', account_id: '1' }, 'body/account_id', 'type'],
    ['POST', '', { title: 'T', amount: -5, date: '2030-03-01', responsible_user_ids: ['x'] }, 'body/responsible_user_ids/0', 'type'],
    ['POST', '', { title: 'T', amount: -5, date: '2030-03-01', attachment_document_ids: [{}] }, 'body/attachment_document_ids/0', 'type'],
    ['POST', '', { title: 'T', amount: -5, date: '20300301' }, 'body/date', 'pattern'],
    ['PUT', `/${entry}`, { title: 5 }, 'body/title', 'type'],
    ['PUT', `/${entry}`, { amount: '' }, 'body/amount', 'type'],
    ['PUT', `/${entry}`, { date: '' }, 'body/date', 'pattern'],
    ['PUT', `/${entry}`, { recurrence_interval: null }, 'body/recurrence_interval', 'type'],
    ['PUT', `/${entry}/series`, { title: null }, 'body/title', 'type'],
    ['PUT', `/${entry}/series`, { amount: null }, 'body/amount', 'type'],
    ['PATCH', `/${entry}/confirm`, { amount: null }, 'body/amount', 'type'],
    ['PATCH', `/${entry}/confirm`, { date: '' }, 'body/date', 'pattern'],
    ['POST', '/loans', { ...LOAN, interest_mode: 'bad' }, 'body/interest_mode', 'enum'],
    ['POST', '/loans', { ...LOAN, start_month: '2026-13' }, 'body/start_month', 'pattern'],
    ['POST', '/loans', { ...LOAN, title: {} }, 'body/title', 'type'],
    ['POST', '/loans', { ...LOAN, visibility: 'shared_amount' }, 'body/visibility', 'enum'],
    ['PUT', `/loans/${loan}`, { start_month: '' }, 'body/start_month', 'pattern'],
    ['PUT', `/loans/${loan}`, { notes: 5 }, 'body/notes', 'type'],
    ['POST', '/loans/preview', { interest_mode: 'fixed', principal: {} }, 'body/principal', 'type'],
    ['POST', `/loans/${loan}/payments`, { amount: 'x', paid_date: '2030-01-01' }, 'body/amount', 'type'],
    ['PUT', '/plans/food', { amount: true }, 'body/amount', 'type'],
    ['POST', '/transfers', { title: {}, amount: 5, date: '2030-03-10', category: 'financial_other', from_account_id: account, to_account_id: other }, 'body/title', 'type'],
    ['POST', '/transfers', { title: 'T', amount: 5, date: '2030-03-10', category: 'financial_other', from_account_id: true, to_account_id: other }, 'body/from_account_id', 'type'],
    ['PUT', `/transfers/${transfer}`, { visibility: 5 }, 'body/visibility', 'type'],
    ['PUT', '/subscriptions/settings', { monthly_budget: null, base_currency: 'EUR' }, 'body/monthly_budget', 'type'],
    ['POST', '/subscriptions/categories', { name: {} }, 'body/name', 'type'],
    ['POST', '/subscriptions/payment-methods', { name: 5 }, 'body/name', 'type'],
    ['PUT', '/subscriptions/meta/order', { categories: [{}] }, 'body/categories/0', 'type'],
    ['PUT', '/subscriptions/meta/order', { categories: ['abc'] }, 'body/categories/0', 'type'],
    ['POST', '/subscriptions', { ...SUBSCRIPTION, name: 5 }, 'body/name', 'type'],
    ['POST', '/subscriptions', { ...SUBSCRIPTION, billing_cycle: undefined }, 'body/billing_cycle', 'required'],
    ['POST', '/subscriptions', { ...SUBSCRIPTION, billing_cycle: '' }, 'body/billing_cycle', 'enum'],
    ['POST', '/subscriptions', { ...SUBSCRIPTION, category_id: true }, 'body/category_id', 'type'],
    ['POST', '/subscriptions', { ...SUBSCRIPTION, enabled: 1 }, 'body/enabled', 'type'],
    ['POST', '/subscriptions', { ...SUBSCRIPTION, visibility: 'bad' }, 'body/visibility', 'enum'],
    ['PUT', `/subscriptions/${subscription}`, { notes: {} }, 'body/notes', 'type'],
    ['PUT', `/subscriptions/${subscription}`, { account_username: 5 }, 'body/account_username', 'type'],
    ['POST', `/subscriptions/${subscription}/renew/undo`, { token: 5 }, 'body/token', 'type'],
  ])) {
    const label = `${method} ${route} ${JSON.stringify(json)}`;
    try {
      assertRefused(await call(method, route, { json }), path, rule, label);
    } catch (err) {
      failures.push(/** @type {Error} */ (err).message.split('\n')[0]);
    }
  }
  assert.deepEqual(failures, []);
});

test('a PUT, the PATCH of the categories and a POST without a body are a 400; the confirmation takes none', async () => {
  const account = await newAccount();
  const entry = await newEntry();
  assertRefused(await call('PUT', `/accounts/${account}`), 'body', 'required', 'account PUT');
  assertRefused(await call('PUT', `/${entry}`), 'body', 'required', 'entry PUT');
  assertRefused(await call('POST', '/subscriptions'), 'body', 'required', 'subscription POST');
  assertRefused(await call('PATCH', '/categories/reorder'), 'body', 'required', 'category order');
  db.prepare('UPDATE budget_entries SET is_pending = 1 WHERE id = ?').run(entry);
  assertStatus(200, await call('PATCH', `/${entry}/confirm`), 'confirm without a body');
});

test('query garbage and doubled values are a 400', async () => {
  for (const [route, path] of [
    ['?month=2026-13', 'query/month'], ['?month=abc', 'query/month'], ['?month=2030-01&month=2030-02', 'query/month'],
    ['?scope=x', 'query/scope'], ['?account_id=abc', 'query/account_id'], ['?account_id=1.5', 'query/account_id'],
    ['?loan_id=abc', 'query/loan_id'], ['/summary?month=2026-13', 'query/month'], ['/summary?account_id=0', 'query/account_id'],
    ['/export?month=abc', 'query/month'], ['/export?from=2030-1-1&to=2030-12-31', 'query/from'],
    ['/plans?month=2026-5', 'query/month'], ['/stats?range=day', 'query/range'], ['/stats?anchor=2026-13', 'query/anchor'],
    ['/accounts?include_archived=yes', 'query/include_archived'],
    ['/subscriptions?status=bad', 'query/status'], ['/subscriptions?category_id=abc', 'query/category_id'],
    ['/subscriptions?payment_method_id=1x', 'query/payment_method_id'], ['/subscriptions?enabled=1', 'query/enabled'],
    ['/subscriptions?refresh_rates=yes', 'query/refresh_rates'],
  ]) {
    assertRefused(await call('GET', route), path, undefined, route);
  }
});

test('a path id that is not plain decimal digits is a 400 and deletes nothing', async () => {
  const account = await newAccount();
  const entry = await newEntry();
  const loan = await newLoan();
  const subscription = await newSubscription();
  for (const [route, table, id] of /** @type {Array<[string, string, number]>} */ ([
    [`/accounts/${account}abc`, 'budget_accounts', account], [`/accounts/${account}.0`, 'budget_accounts', account],
    [`/${entry}.0`, 'budget_entries', entry], [`/loans/${loan}.0`, 'budget_loans', loan],
    [`/subscriptions/0x${subscription.toString(16)}`, 'budget_subscriptions', subscription],
    [`/subscriptions/${subscription}e0`, 'budget_subscriptions', subscription],
  ])) {
    const r = await call('DELETE', route);
    assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id), `${route}: the row is still there (${r.status})`);
    assertRefused(r, 'path/id', 'type', route);
  }
  const before = db.prepare('SELECT next_payment_date FROM budget_subscriptions WHERE id = ?').get(subscription);
  const renewed = await call('POST', `/subscriptions/${subscription}.0/renew`, { json: {} });
  assert.deepEqual(db.prepare('SELECT next_payment_date FROM budget_subscriptions WHERE id = ?').get(subscription), before, 'renew 1.0 books nothing');
  assertRefused(renewed, 'path/id', 'type', 'renew 1.0');
});

test('a month 13 in the list writes no entry any more', async () => {
  // A running series: reading a month books its occurrence there.
  await newEntry({ title: 'Serie 13', date: '2026-01-05', is_recurring: 1, recurrence_interval: 'monthly' });
  const r = await call('GET', '?month=2026-13');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_entries WHERE date LIKE '2026-13-%'").get().n, 0, `no entry dated 2026-13 (${r.status})`);
  assertRefused(r, 'query/month', 'pattern');
});

// --------------------------------------------------------------------------
// The subscriptions router
// --------------------------------------------------------------------------

test('subscriptions: a schema violation is a 400, an unexpected error the 500 of the central handler', async () => {
  const r = await call('POST', '/subscriptions/categories', { json: { name: {} } });
  assert.notEqual(r.status, 500, `name {}: ${JSON.stringify(r.body)}`);
  assertRefused(r, 'body/name', 'type', 'name {}');
  // A schema violation inside the try of a route (it reached the router's own
  // handler as a 500 `Internal error.` too).
  assertRefused(await call('PUT', '/subscriptions/meta/order', { json: { categories: [{}] } }), 'body/categories/0', 'type');
  // A database error after the check: the router has no handler of its own
  // any more, the central one answers with its fixed sentence.
  db.exec("CREATE TEMP TRIGGER boom_9 BEFORE INSERT ON subscription_categories BEGIN SELECT RAISE(ABORT, 'boom'); END");
  try {
    const failed = await call('POST', '/subscriptions/categories', { json: { name: 'Kaputt' } });
    assert.deepEqual([failed.status, failed.body], [500, { error: 'Internal server error.', code: 500 }]);
  } finally {
    db.exec('DROP TRIGGER boom_9');
  }
});

test('the logo search reaches the finder only with text', async () => {
  logoQueries.length = 0;
  assertRefused(await call('POST', '/subscriptions/logo-search', { json: { query: 5 } }), 'body/query', 'type');
  assertRefused(await call('POST', '/subscriptions/logo-search', { json: { query: {} } }), 'body/query', 'type');
  assertRefused(await call('POST', '/subscriptions/logo-search', { json: { website_url: ['https://a.test'] } }), 'body/website_url', 'type');
  assert.deepEqual(logoQueries, [], 'no lookup for a number, an object or a list');
  assertStatus(200, await call('POST', '/subscriptions/logo-search', { json: { query: 'example.com' } }), 'text');
  assert.deepEqual(logoQueries, ['example.com']);
});

// --------------------------------------------------------------------------
// Order: 400 before 404 and 403; without the right a valid body meets the 403
// --------------------------------------------------------------------------

test('a malformed request is a 400 before the 404 and the 403; a valid one meets them', async () => {
  setConfig('budget_mode', 'personal');
  try {
    const account = await call('POST', '/accounts', { actor: 'mem', json: { name: 'Mem-Konto', type: 'checking', starting_balance: 0 } });
    const own = account.body.data.id;
    const other = (await call('POST', '/accounts', { actor: 'mem', json: { name: 'Mem-Spar', type: 'savings', starting_balance: 0 } })).body.data.id;
    const entry = await newEntry({ visibility: 'shared', is_recurring: 1 }, 'mem');
    const pending = await newEntry({ visibility: 'shared' }, 'mem');
    db.prepare('UPDATE budget_entries SET is_pending = 1 WHERE id = ?').run(pending);
    const transfer = (await call('POST', '/transfers', { actor: 'mem', json: { title: 'T', amount: 5, date: '2030-03-10', category: 'financial_other', from_account_id: own, to_account_id: other, visibility: 'shared', is_recurring: true } })).body.data.id;
    const loanResponse = await call('POST', '/loans', { actor: 'mem', json: { ...LOAN, visibility: 'shared' } });
    assertStatus(201, loanResponse, 'loan of mem');
    const loan = loanResponse.body.data.id;
    const subscriptionResponse = await call('POST', '/subscriptions', { actor: 'mem', json: { ...SUBSCRIPTION, visibility: 'shared' } });
    assertStatus(201, subscriptionResponse, 'subscription of mem');
    const subscription = subscriptionResponse.body.data.id;
    const GONE = 987654;
    // [route, a valid body, a malformed one, method]
    const NINE = /** @type {Array<[string, string, any, any]>} */ ([
      ['PUT', `/${entry}`, { title: 'Neu' }, { title: {} }],
      ['PUT', `/${entry}/series`, { title: 'Neu' }, { title: {} }],
      ['PATCH', `/${pending}/confirm`, { amount: -5 }, { amount: null }],
      ['PUT', `/transfers/${transfer}`, { title: 'Neu' }, { title: {} }],
      ['PUT', `/transfers/${transfer}/series`, { title: 'Neu' }, { title: {} }],
      ['PUT', `/loans/${loan}`, { title: 'Neu' }, { title: {} }],
      ['POST', `/loans/${loan}/payments`, { amount: 100, paid_date: '2030-01-05' }, { amount: 'x', paid_date: '2030-01-05' }],
      ['PUT', `/subscriptions/${subscription}`, { name: 'Neu' }, { name: {} }],
      ['POST', `/subscriptions/${subscription}/renew/undo`, { token: 'x' }, { token: 5 }],
    ]);
    for (const [method, route, valid, malformed] of NINE) {
      const refused = await call(method, route, { actor: 'other', json: malformed });
      assert.equal(refused.status, 400, `${method} ${route} malformed, no right: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.reason, 'validation');
      const forbidden = await call(method, route, { actor: 'other', json: valid });
      assert.equal(forbidden.status, 403, `${method} ${route} valid, no right: ${JSON.stringify(forbidden.body)}`);
      const gone = route.replace(/\/\d+/, `/${GONE}`);
      assert.equal((await call(method, gone, { actor: 'other', json: malformed })).status, 400, `${method} ${gone} malformed, unknown`);
      assert.equal((await call(method, gone, { actor: 'other', json: valid })).status, 404, `${method} ${gone} valid, unknown`);
    }
    // DELETE without a body: only the path id decides between 400 and 404/403.
    assertRefused(await call('DELETE', `/subscriptions/${subscription}.0`, { actor: 'other' }), 'path/id', 'type');
    assertStatus(403, await call('DELETE', `/subscriptions/${subscription}`, { actor: 'other' }), 'delete of another');
    assertStatus(404, await call('DELETE', `/subscriptions/${GONE}`, { actor: 'other' }), 'delete unknown');
  } finally {
    setConfig('budget_mode', 'shared');
  }
});

// --------------------------------------------------------------------------
// One source
// --------------------------------------------------------------------------

test('one source: the value lists of the schemas are the lists the handlers read', () => {
  assert.deepEqual([...fields.ENTRY_VISIBILITIES], [...rows.BUDGET_VISIBILITY_VALUES]);
  assert.deepEqual([...fields.OBJECT_VISIBILITIES], [...rows.BUDGET_OBJECT_VISIBILITY_VALUES]);
  assert.equal(subscriptionService.BILLING_CYCLES, fields.BILLING_CYCLES);
  assert.equal(subscriptionService.END_TYPES, fields.END_TYPES);
  assert.equal(helpers.ACCOUNT_TYPE_KEYS, fields.ACCOUNT_TYPE_KEYS);
  assert.equal(helpers.RECURRENCE_INTERVAL_KEYS, fields.RECURRENCE_INTERVAL_KEYS);
  assert.equal(helpers.LOAN_DIRECTIONS, fields.LOAN_DIRECTIONS);
  assert.deepEqual([...helpers.STATS_RANGES], [...fields.STATS_RANGES]);

  const spec = buildOpenApiSpec(null, 'test');
  const props = (/** @type {string} */ path, /** @type {string} */ method) => spec.paths[path][method].requestBody.content['application/json'].schema.properties;
  const queryOf = (/** @type {string} */ path, /** @type {string} */ name) => spec.paths[path].get.parameters.find((/** @type {any} */ p) => p.name === name).schema;
  assert.deepEqual(props('/api/v1/budget/accounts', 'post').type.enum, [...fields.ACCOUNT_TYPE_KEYS]);
  assert.deepEqual(props('/api/v1/budget/categories', 'post').type.enum, [...fields.CATEGORY_TYPES]);
  assert.deepEqual(props('/api/v1/budget', 'post').recurrence_interval.enum, [...fields.RECURRENCE_INTERVAL_KEYS]);
  assert.deepEqual(props('/api/v1/budget', 'post').visibility.enum, [...fields.ENTRY_VISIBILITIES]);
  assert.deepEqual(props('/api/v1/budget/loans', 'post').interest_mode.enum, [...fields.INTEREST_MODES]);
  assert.deepEqual(props('/api/v1/budget/loans', 'post').direction.enum, [...fields.LOAN_DIRECTIONS]);
  assert.deepEqual(props('/api/v1/budget/loans', 'post').visibility.enum, [...fields.OBJECT_VISIBILITIES]);
  assert.deepEqual(props('/api/v1/budget/subscriptions', 'post').billing_cycle.enum, [...fields.BILLING_CYCLES]);
  assert.deepEqual(props('/api/v1/budget/subscriptions', 'post').end_type.enum, [...fields.END_TYPES]);
  assert.deepEqual(queryOf('/api/v1/budget/stats', 'range').enum, [...fields.STATS_RANGES]);
  assert.deepEqual(queryOf('/api/v1/budget/summary', 'scope').enum, [...fields.BUDGET_SCOPES]);
  assert.deepEqual(queryOf('/api/v1/budget/subscriptions', 'status').enum, [...fields.SUBSCRIPTION_STATUSES]);
});
