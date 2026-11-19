/**
 * Test: request validation in split expenses, backup and the core routes (#2810, phase 2 section E, group 5)
 * Purpose: server/routes/split-expenses.js (28 routes), server/routes/backup.js
 *          (10), server/routes/system.js (1) and server/routes/changelog.js (1)
 *          check every request against the schema of its operation in the
 *          OpenAPI document (`validateRequest()` in every route) before the
 *          handler runs. Held here against the real routers at their real
 *          prefixes, in the order of server/index.js (express.json,
 *          defaultEmptyBody, the routers, the central error handler):
 *            - THE OWN CALLERS: every request public/pages/split-expenses.js,
 *              public/settings/pages/admin-backup.js and admin-system.js send
 *              passes, ids as numbers and as legacy digit text;
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              and `fields`: a path id that is not plain decimal digits
 *              (`0x10` read group 16 before), an unknown value of a list
 *              (silently replaced before), a number or an object in a text
 *              field (`password: {}` became "[object Object]"), a doubled
 *              query value, `attachment_document_ids` that is not a list (it
 *              removed every receipt), `username: 5` at the WebDAV config (a
 *              500 before);
 *            - ORDER: a malformed request is a 400 before the 404, 403 and 409
 *              of the handler, a valid one meets the old answer;
 *            - RIGHTS ORDER: requireAdmin (backup, system) and the refusal of a
 *              split guest at POST /groups stand in front of the check: 403
 *              stays 403, also for a broken body;
 *            - ONE SOURCE: every list of the schema is the constant the handler
 *              reads (server/services/split-expense-fields.js,
 *              public/utils/currency-codes.js), and GET /meta hands out the
 *              same lists.
 *          The household zone is pinned; no answer asserted here carries a
 *          date of the clock.
 * Run: npm run test:validate-split-backup-core
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');
const { default: backupRouter } = await import('../server/routes/backup.js');
const { default: systemRouter } = await import('../server/routes/system.js');
const { default: changelogRouter, buildRouter: buildChangelogRouter } = await import('../server/routes/changelog.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const fields = await import('../server/services/split-expense-fields.js');
const { CURRENCY_CODES } = await import('../public/utils/currency-codes.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const ADMIN_REQUIRED = { error: 'Admin access required.', code: 403, reason: 'admin_required' };

/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, 'parent')")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('admin5', 'admin');
const OWNER = user('owner5', 'member');
const MEM = user('mem5', 'member');
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  owner: { id: OWNER, role: 'member' },
  mem: { id: MEM, role: 'member' },
};

const quiet = { warn: () => {}, error: () => {} };
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const name = req.get('x-actor') ?? 'owner';
  const actor = ACTORS[name] ?? { id: Number(name), role: 'member' };
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = 'session';
  req.authScopes = null;
  req.session = { userId: actor.id, role: actor.role };
  req.sessionModuleAccess = null;
  next();
});
// The mounts of server/index.js. The changelog router is the real one, built
// with a fetch that fails, so it answers from the bundled CHANGELOG.md.
app.use('/api/v1/changelog', buildChangelogRouter({ fetchFn: async () => { throw new Error('offline'); }, appVersion: '0.0.0-test' }));
app.use('/api/v1/split-expenses', splitRouter);
app.use('/api/v1/backup', backupRouter);
app.use('/api/v1/system', systemRouter);
app.use(createErrorHandler(quiet));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {{ json?: unknown, actor?: string | number, raw?: Buffer }} [options] json left out: no body
 */
async function call(method, route, { json, actor, raw } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor !== undefined) headers['x-actor'] = String(actor);
  /** @type {any} */
  let payload;
  if (raw !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = raw;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: payload });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, body };
}

/**
 * The 400 of the middleware with this field among its fields.
 * @param {{ status: number, body: any }} res
 * @param {string} path
 * @param {string} [rule]
 * @param {string} [label]
 */
function assertRefusedAt(res, path, rule, label = '') {
  assert.equal(res.status, 400, `${label} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path && (!rule || f.rule === rule)), `${label}: ${JSON.stringify(res.body.fields)}`);
}

/** @param {{ status: number, body: any }} res @param {number} status @param {string} [label] */
function assertPassed(res, status, label = '') {
  assert.equal(res.status, status, `${label} ${JSON.stringify(res.body)}`);
}

const NOT_DIGITS = ['0x10', '1e1', '7abc', '1.5', '%205'];

// ════════════════════════════════════════════════════════════════════════════
// SEED - all before the first test
// ════════════════════════════════════════════════════════════════════════════

/**
 * The group form of openGroupModal (create): FormData as text.
 * @param {string} name
 */
const groupForm = (name) => ({ name, description: '', type: 'household', default_currency: 'EUR' });

const created = await call('POST', '/split-expenses/groups', { json: groupForm('WG') });
assert.equal(created.status, 201, JSON.stringify(created.body));
const GROUP = created.body.data.id;
assert.equal((await call('POST', `/split-expenses/groups/${GROUP}/members`, { json: { user_id: MEM, role: 'guest' } })).status, 201);

// A group with id 16 the owner belongs to: `0x10` read it before #2810.
db.prepare("INSERT INTO expense_groups (id, name, type, default_currency, created_by) VALUES (16, 'Sechzehn', 'general', 'EUR', ?)").run(OWNER);
db.prepare("INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (16, ?, 'owner', ?)").run(OWNER, OWNER);

const archivedGroup = await call('POST', '/split-expenses/groups', { json: groupForm('Archiv') });
const ARCHIVED = archivedGroup.body.data.id;
await call('POST', `/split-expenses/groups/${ARCHIVED}/members`, { json: { user_id: MEM, role: 'guest' } });
assert.equal((await call('POST', `/split-expenses/groups/${ARCHIVED}/archive`, { json: {} })).status, 200);

/**
 * The expense form of openExpenseModal after #2810: FormData as text, the
 * payer as a number, participants and splits from collectSplitPayload.
 * @param {Record<string, unknown>} [over]
 */
const expenseForm = (over = {}) => ({
  amount: '12.50',
  currency: 'EUR',
  title: 'Einkauf',
  expense_date: '2026-05-04',
  payer_id: OWNER,
  split_method: 'equal',
  budget_category: '',
  [`split_value_${OWNER}`]: '',
  [`split_value_${MEM}`]: '',
  description: '',
  participants: [OWNER, MEM],
  splits: [],
  ...over,
});

const firstExpense = await call('POST', `/split-expenses/groups/${GROUP}/expenses`, { json: expenseForm() });
assert.equal(firstExpense.status, 201, JSON.stringify(firstExpense.body));
const EXPENSE = firstExpense.body.data.id;

/** @param {string} name */
function insertDocument(name) {
  return Number(db.prepare(`
    INSERT INTO family_documents (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'finance', 'family', ?, 'application/pdf', 999, 'data:application/pdf;base64,AA==', ?)
  `).run(name, `${name}.pdf`, OWNER).lastInsertRowid);
}
const RECEIPT = insertDocument('Beleg');
const withReceipt = await call('POST', `/split-expenses/groups/${GROUP}/expenses`, { json: expenseForm({ title: 'Mit Beleg', attachment_document_ids: [RECEIPT] }) });
assert.equal(withReceipt.status, 201, JSON.stringify(withReceipt.body));
const RECEIPT_EXPENSE = withReceipt.body.data.id;
/** @param {number} expenseId */
const receiptsOf = (expenseId) => db.prepare('SELECT document_id FROM expense_attachments WHERE expense_id = ?').all(expenseId).map((/** @type {any} */ r) => r.document_id);

/** The recurring form of readRecurringForm after #2810. */
const recurringForm = (over = {}) => ({
  title: 'Miete',
  amount: '800.00',
  currency: 'EUR',
  payer_id: OWNER,
  frequency: 'monthly',
  next_run_date: '2099-01-15',
  split_method: 'equal',
  budget_category: null,
  description: '',
  participants: [OWNER, MEM],
  splits: [],
  ...over,
});
const firstRecurring = await call('POST', `/split-expenses/groups/${GROUP}/recurring`, { json: recurringForm() });
assert.equal(firstRecurring.status, 201, JSON.stringify(firstRecurring.body));
const RECURRING = firstRecurring.body.data.id;

const guest = await call('POST', `/split-expenses/groups/${GROUP}/guests`, {
  json: { display_name: 'Gast', username: '', password: 'gast-passwort', phone: '', email: '', birth_date: null },
});
assert.equal(guest.status, 201, JSON.stringify(guest.body));
const GUEST = guest.body.data.id;

// ════════════════════════════════════════════════════════════════════════════
// SPLIT EXPENSES
// ════════════════════════════════════════════════════════════════════════════

test('split expenses: every route carries validateRequest(), 28 in all', () => {
  const routes = splitRouter.stack.filter((/** @type {any} */ l) => l.route);
  assert.equal(routes.length, 28);
  for (const layer of routes) {
    assert.ok(layer.route.stack.some((/** @type {any} */ l) => l.name === 'validateRequestMiddleware'), layer.route.path);
  }
});

test('path ids: not plain decimal digits is a 400 at every kind of id; `0x10` no longer reads group 16', async () => {
  for (const value of NOT_DIGITS) {
    assertRefusedAt(await call('GET', `/split-expenses/groups/${value}/members`), 'path/id', undefined, `group ${value}`);
    assertRefusedAt(await call('DELETE', `/split-expenses/expenses/${value}`), 'path/id', undefined, `expense ${value}`);
    assertRefusedAt(await call('DELETE', `/split-expenses/recurring/${value}`), 'path/id', undefined, `recurring ${value}`);
    assertRefusedAt(await call('DELETE', `/split-expenses/groups/${GROUP}/members/${value}`), 'path/userId', undefined, `member ${value}`);
    assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/settlements/${value}/reverse`, { json: {} }), 'path/settlementId', undefined, `settlement ${value}`);
  }
  // The group itself answers under its plain id.
  assertPassed(await call('GET', '/split-expenses/groups/16/members'), 200, 'plain 16');
  // 0 and negative stay the handler's 404.
  assert.equal((await call('GET', '/split-expenses/groups/0/members')).status, 404);
});

test('GET /meta hands out the lists the schema holds (one source)', async () => {
  const meta = await call('GET', '/split-expenses/meta');
  assertPassed(meta, 200);
  assert.deepEqual(meta.body.data.group_types, fields.GROUP_TYPES);
  assert.deepEqual(meta.body.data.group_roles, fields.GROUP_ROLES);
  assert.deepEqual(meta.body.data.split_methods, fields.SPLIT_METHODS);
  assert.deepEqual(meta.body.data.categories, fields.CATEGORIES);
  assert.deepEqual(meta.body.data.frequencies, fields.FREQUENCIES);
  assert.deepEqual(meta.body.data.currencies, [...CURRENCY_CODES]);

  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const bodyOf = (/** @type {string} */ path, /** @type {string} */ method) => spec.paths[path][method].requestBody.content['application/json'].schema.properties;
  const group = bodyOf('/api/v1/split-expenses/groups', 'post');
  assert.deepEqual(group.type.enum, fields.GROUP_TYPES);
  assert.deepEqual(group.default_currency.enum, [...CURRENCY_CODES]);
  assert.deepEqual(group.default_split_method.enum, fields.SPLIT_METHODS);
  const expense = bodyOf('/api/v1/split-expenses/groups/{id}/expenses', 'post');
  assert.deepEqual(expense.category.enum, fields.CATEGORIES);
  assert.deepEqual(expense.currency.enum, [...CURRENCY_CODES]);
  assert.deepEqual(expense.converted_currency.enum, [...CURRENCY_CODES]);
  assert.deepEqual(expense.split_method.enum, fields.SPLIT_METHODS);
  assert.deepEqual(bodyOf('/api/v1/split-expenses/expenses/{id}', 'put').category.enum, [...fields.CATEGORIES, null]);
  const recurring = bodyOf('/api/v1/split-expenses/groups/{id}/recurring', 'post');
  assert.deepEqual(recurring.frequency.enum, fields.FREQUENCIES);
  assert.deepEqual(recurring.missed.enum, [...fields.MISSED_MODES, null]);
  assert.deepEqual(bodyOf('/api/v1/split-expenses/groups/{id}/members', 'post').role.enum, fields.GROUP_ROLES);
  assert.deepEqual(bodyOf('/api/v1/split-expenses/groups/{id}/guests', 'post').family_role.enum, fields.FAMILY_ROLES);
  const list = spec.paths['/api/v1/split-expenses/groups/{id}/expenses'].get.parameters;
  assert.deepEqual(list.find((/** @type {any} */ p) => p.name === 'category').schema.enum, fields.CATEGORIES);
  const groups = spec.paths['/api/v1/split-expenses/groups'].get.parameters;
  assert.deepEqual(groups.find((/** @type {any} */ p) => p.name === 'status').schema.enum, fields.GROUP_STATUSES);
});

test('groups: the own forms pass, unknown list values and wrong types are a 400 (no silent fallback)', async () => {
  assertPassed(await call('GET', '/split-expenses/dashboard'), 200);
  assertPassed(await call('GET', '/split-expenses/groups?status=active&q='), 200);
  assertPassed(await call('GET', '/split-expenses/groups?status=archived&q=Arch'), 200);
  assertRefusedAt(await call('GET', '/split-expenses/groups?status=deleted'), 'query/status', 'enum');
  assertRefusedAt(await call('GET', '/split-expenses/groups?q=a&q=b'), 'query/q', 'type');
  assertRefusedAt(await call('GET', '/split-expenses/search?q=a&q=b'), 'query/q', 'type');
  assertPassed(await call('GET', '/split-expenses/search?q=WG'), 200);

  for (const [over, path, rule] of /** @type {Array<[Record<string, unknown>, string, string]>} */ ([
    [{ name: 5 }, 'body/name', 'type'],
    [{ name: 'x'.repeat(201) }, 'body/name', 'maxLength'],
    [{ type: 'trip' }, 'body/type', 'enum'],
    [{ default_currency: 'XXX' }, 'body/default_currency', 'enum'],
    [{ default_split_method: 'thirds' }, 'body/default_split_method', 'enum'],
    [{ description: ['a'] }, 'body/description', 'type'],
  ])) {
    assertRefusedAt(await call('POST', '/split-expenses/groups', { json: { ...groupForm('Neu'), ...over } }), path, rule, JSON.stringify(over));
  }
  assertRefusedAt(await call('POST', '/split-expenses/groups', { json: { description: 'ohne Namen' } }), 'body/name', 'required');

  // The edit form: text fields plus the preset (collectGroupDefaults).
  const edit = {
    ...groupForm('WG'), group_members: `user:${MEM}`, default_split_method: 'shares',
    default_split_config: [{ user_id: OWNER, shares: 2 }, { user_id: MEM, shares: 1 }],
  };
  assertPassed(await call('PATCH', `/split-expenses/groups/${GROUP}`, { json: edit }), 200, 'edit form');
  assertPassed(await call('PATCH', `/split-expenses/groups/${GROUP}`, { json: { default_split_config: [{ user_id: String(OWNER), percentage: '50' }] } }), 200, 'legacy digit text');
  assertPassed(await call('PATCH', `/split-expenses/groups/${GROUP}`, { json: {} }), 200, '{} sent on purpose');
  assertRefusedAt(await call('PATCH', `/split-expenses/groups/${GROUP}`), 'body', 'required');
  assertRefusedAt(await call('PATCH', `/split-expenses/groups/${GROUP}`, { json: { default_split_config: [{ user_id: OWNER, shares: '2' }] } }), 'body/default_split_config/0/shares', 'type');
  assertRefusedAt(await call('PATCH', `/split-expenses/groups/${GROUP}`, { json: { type: 'trip' } }), 'body/type', 'enum');
});

test('members and guests: own forms pass, garbage is a 400; `password: {}` no longer passes as "[object Object]"', async () => {
  assertPassed(await call('GET', `/split-expenses/groups/${GROUP}/members`), 200);
  assertPassed(await call('GET', `/split-expenses/groups/${GROUP}/member-candidates`), 200);
  for (const [json, path] of /** @type {Array<[Record<string, unknown>, string]>} */ ([
    [{ user_id: '7abc', role: 'guest' }, 'body/user_id'],
    [{ user_id: 1.5 }, 'body/user_id'],
    [{ contact_id: true }, 'body/contact_id'],
    [{ user_id: MEM, role: 'boss' }, 'body/role'],
  ])) {
    assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/members`, { json }), path, undefined, JSON.stringify(json));
  }
  // The member form (openMemberModal) and the legacy digit text.
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/members`, { json: { role: 'admin', user_id: MEM } }), 201, 'member form');
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/members`, { json: { user_id: String(MEM), role: 'guest' } }), 201, 'digit text');

  const guestForm = { display_name: 'Zweiter Gast', username: '', password: 'gast-passwort', phone: '', email: '', birth_date: null };
  assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/guests`, { json: { ...guestForm, password: {} } }), 'body/password', 'type');
  assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/guests`, { json: { ...guestForm, family_role: 'uncle' } }), 'body/family_role', 'enum');
  assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/guests`, { json: { ...guestForm, display_name: 7 } }), 'body/display_name', 'type');
  assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/guests`, { json: { ...guestForm, password: undefined } }), 'body/password', 'required');
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/guests`, { json: guestForm }), 201, 'guest form');
});

test('expenses: the own form passes (payer as number or digit text), garbage per field is a 400', async () => {
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/expenses`, { json: expenseForm({ payer_id: String(OWNER), participants: [String(OWNER)] }) }), 201, 'legacy digit text');
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
    json: expenseForm({ split_method: 'percentage', splits: [{ user_id: OWNER, percentage: '60' }, { user_id: MEM, percentage: '40' }] }),
  }), 201, 'percentage');
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/expenses`, {
    json: expenseForm({ split_method: 'shares', splits: [{ user_id: OWNER, shares: 2 }, { user_id: MEM, shares: 1 }] }),
  }), 201, 'shares');
  for (const [over, path] of /** @type {Array<[Record<string, unknown>, string]>} */ ([
    [{ amount: 12.5 }, 'body/amount'],
    [{ currency: 'XYZ' }, 'body/currency'],
    [{ converted_currency: 'XYZ' }, 'body/converted_currency'],
    [{ split_method: 'thirds' }, 'body/split_method'],
    [{ category: 'casino' }, 'body/category'],
    [{ title: ['a'] }, 'body/title'],
    [{ title: 'x'.repeat(201) }, 'body/title'],
    [{ payer_id: '3abc' }, 'body/payer_id'],
    [{ participants: String(OWNER) }, 'body/participants'],
    [{ splits: [{ user_id: OWNER, shares: '2' }], split_method: 'shares' }, 'body/splits/0/shares'],
    [{ attachment_document_ids: null }, 'body/attachment_document_ids'],
    [{ expense_date: 20260504 }, 'body/expense_date'],
  ])) {
    assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/expenses`, { json: expenseForm(over) }), path, undefined, JSON.stringify(over));
  }
  assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/expenses`, { json: { title: 'ohne Betrag' } }), 'body/amount', 'required');

  // The list: the app's query, the capped values, and garbage.
  assertPassed(await call('GET', `/split-expenses/groups/${GROUP}/expenses?limit=30&budget_category=haushalt`), 200);
  assertPassed(await call('GET', `/split-expenses/groups/${GROUP}/expenses?limit=150&offset=-3`), 200, 'capped, as documented');
  assertPassed(await call('GET', `/split-expenses/groups/${GROUP}/expenses?limit=1&before_date=2026-05-04&before_at=2026-05-04T00:00:00Z&before_id=${EXPENSE}`), 200, 'cursor');
  assertRefusedAt(await call('GET', `/split-expenses/groups/${GROUP}/expenses?limit=abc`), 'query/limit');
  assertRefusedAt(await call('GET', `/split-expenses/groups/${GROUP}/expenses?limit=1&limit=2`), 'query/limit');
  assertRefusedAt(await call('GET', `/split-expenses/groups/${GROUP}/expenses?recurring=0`), 'query/recurring', 'enum');
  assertRefusedAt(await call('GET', `/split-expenses/groups/${GROUP}/expenses?category=casino`), 'query/category', 'enum');
  assertRefusedAt(await call('GET', `/split-expenses/groups/${GROUP}/expenses?before_id=1e1`), 'query/before_id');
  assertPassed(await call('GET', `/split-expenses/groups/${GROUP}/activity?limit=12`), 200);
  assertRefusedAt(await call('GET', `/split-expenses/groups/${GROUP}/activity?before_id=0&before_at=x`), 'query/before_id', 'minimum');
  assertRefusedAt(await call('GET', `/split-expenses/groups/${GROUP}/activity?offset=x`), 'query/offset');
  assertPassed(await call('GET', `/split-expenses/groups/${GROUP}/balances`), 200);
});

test('PUT /expenses/{id}: a non-list `attachment_document_ids` is a 400 and the receipts stay; left out they stay too', async () => {
  assert.deepEqual(receiptsOf(RECEIPT_EXPENSE), [RECEIPT]);
  for (const value of [null, 'x', 5, {}]) {
    assertRefusedAt(await call('PUT', `/split-expenses/expenses/${RECEIPT_EXPENSE}`, { json: expenseForm({ title: 'Mit Beleg', attachment_document_ids: value }) }),
      'body/attachment_document_ids', 'type', JSON.stringify(value));
    assert.deepEqual(receiptsOf(RECEIPT_EXPENSE), [RECEIPT], `receipts after ${JSON.stringify(value)}`);
  }
  assertPassed(await call('PUT', `/split-expenses/expenses/${RECEIPT_EXPENSE}`, { json: expenseForm({ title: 'Mit Beleg', category: null }) }), 200, 'left out');
  assert.deepEqual(receiptsOf(RECEIPT_EXPENSE), [RECEIPT]);
  assertPassed(await call('PUT', `/split-expenses/expenses/${RECEIPT_EXPENSE}`, { json: expenseForm({ title: 'Mit Beleg', attachment_document_ids: [String(RECEIPT)] }) }), 200, 'digit text');
  assert.deepEqual(receiptsOf(RECEIPT_EXPENSE), [RECEIPT]);
  assertRefusedAt(await call('PUT', `/split-expenses/expenses/${RECEIPT_EXPENSE}`), 'body', 'required');
});

test('comments, settlements, recurring: own forms pass, garbage is a 400', async () => {
  assertPassed(await call('POST', `/split-expenses/expenses/${EXPENSE}/comments`, { json: { comment: 'Danke' } }), 201);
  assertRefusedAt(await call('POST', `/split-expenses/expenses/${EXPENSE}/comments`, { json: { comment: 5 } }), 'body/comment', 'type');
  assertRefusedAt(await call('POST', `/split-expenses/expenses/${EXPENSE}/comments`), 'body', 'required');

  // The settlement form (openSettlementModal) after #2810, and the legacy text.
  const settlement = { payer_id: MEM, payee_id: OWNER, amount: '5.00', currency: 'EUR', notes: '' };
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/settlements`, { json: settlement }), 201, 'settlement form');
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/settlements`, { json: { ...settlement, payer_id: String(MEM), payee_id: String(OWNER) } }), 201, 'digit text');
  for (const [over, path] of /** @type {Array<[Record<string, unknown>, string]>} */ ([
    [{ amount: 5 }, 'body/amount'],
    [{ payer_id: 'x' }, 'body/payer_id'],
    [{ currency: 'eur' }, 'body/currency'],
    [{ notes: 5 }, 'body/notes'],
    [{ proof_document_id: 'abc' }, 'body/proof_document_id'],
  ])) {
    assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/settlements`, { json: { ...settlement, ...over } }), path, undefined, JSON.stringify(over));
  }

  assertPassed(await call('GET', `/split-expenses/groups/${GROUP}/recurring`), 200);
  assertPassed(await call('POST', `/split-expenses/groups/${GROUP}/recurring`, { json: recurringForm({ payer_id: String(OWNER), missed: 'skip' }) }), 201, 'digit text + missed');
  assertRefusedAt(await call('POST', `/split-expenses/groups/${GROUP}/recurring`, { json: recurringForm({ frequency: 'daily' }) }), 'body/frequency', 'enum');
  const missed = await call('POST', `/split-expenses/groups/${GROUP}/recurring`, { json: recurringForm({ missed: 'all' }) });
  assertRefusedAt(missed, 'body/missed', 'enum');
  assert.equal(missed.body.reason, 'invalid_missed', 'the reason the app translates stays');
  // changedRecurringFields: only what changed.
  assertPassed(await call('PUT', `/split-expenses/recurring/${RECURRING}`, { json: { title: 'Miete neu' } }), 200, 'title only');
  assertPassed(await call('PUT', `/split-expenses/recurring/${RECURRING}`, { json: { payer_id: MEM, missed: null } }), 200, 'payer only');
  assertRefusedAt(await call('PUT', `/split-expenses/recurring/${RECURRING}`, { json: { next_run_date: 5 } }), 'body/next_run_date', 'type');
  assertRefusedAt(await call('PUT', `/split-expenses/recurring/${RECURRING}`, { json: { category: 'casino' } }), 'body/category', 'enum');
  // The pause toggle: `{}`, a body-less call, `book`, `null`; anything else is invalid_missed.
  assertPassed(await call('POST', `/split-expenses/recurring/${RECURRING}/pause`, { json: {} }), 200, 'pause');
  assertPassed(await call('POST', `/split-expenses/recurring/${RECURRING}/pause`, { json: { missed: 'book' } }), 200, 'resume book');
  assertPassed(await call('POST', `/split-expenses/recurring/${RECURRING}/pause`), 200, 'pause without body');
  assertPassed(await call('POST', `/split-expenses/recurring/${RECURRING}/pause`, { json: { missed: null } }), 200, 'resume null');
  const pause = await call('POST', `/split-expenses/recurring/${RECURRING}/pause`, { json: { missed: 0 } });
  assertRefusedAt(pause, 'body/missed', 'type');
  assert.equal(pause.body.reason, 'invalid_missed');
});

test('order: a malformed request is a 400 before 404, 403 and 409; a valid one meets the old answer', async () => {
  const UNKNOWN = 999999;
  for (const [method, route, broken, valid, old] of /** @type {Array<[string, string, Record<string, unknown>, Record<string, unknown>, number]>} */ ([
    ['PATCH', `/split-expenses/groups/${UNKNOWN}`, { name: 5 }, { name: 'x' }, 404],
    ['POST', `/split-expenses/groups/${UNKNOWN}/expenses`, expenseForm({ amount: 5 }), expenseForm(), 404],
    ['POST', `/split-expenses/groups/${UNKNOWN}/settlements`, { payer_id: 'x' }, { payer_id: MEM, payee_id: OWNER, amount: '1.00' }, 404],
    ['POST', `/split-expenses/groups/${UNKNOWN}/recurring`, recurringForm({ frequency: 'daily' }), recurringForm(), 404],
    ['POST', `/split-expenses/groups/${UNKNOWN}/members`, { user_id: 'x' }, { user_id: MEM }, 404],
    ['POST', `/split-expenses/groups/${UNKNOWN}/guests`, { display_name: 1 }, { display_name: 'G', password: 'gast-passwort' }, 404],
    ['PUT', `/split-expenses/expenses/${UNKNOWN}`, expenseForm({ currency: 'XYZ' }), expenseForm(), 404],
    ['POST', `/split-expenses/expenses/${UNKNOWN}/comments`, { comment: 1 }, { comment: 'x' }, 404],
    ['PUT', `/split-expenses/recurring/${UNKNOWN}`, { frequency: 'daily' }, { title: 'x' }, 404],
    ['POST', `/split-expenses/recurring/${UNKNOWN}/pause`, { missed: 'all' }, {}, 404],
    // A member who does not manage the group (403 in the handler).
    ['PATCH', `/split-expenses/groups/${GROUP}`, { type: 'trip' }, { type: 'event' }, 403],
    ['POST', `/split-expenses/groups/${GROUP}/members`, { role: 'boss' }, { user_id: OWNER }, 403],
    // The archived group (409 in the handler).
    ['POST', `/split-expenses/groups/${ARCHIVED}/expenses`, expenseForm({ split_method: 'thirds' }), expenseForm(), 409],
    ['POST', `/split-expenses/groups/${ARCHIVED}/settlements`, { amount: 5 }, { payer_id: MEM, payee_id: OWNER, amount: '1.00' }, 409],
    ['POST', `/split-expenses/groups/${ARCHIVED}/guests`, { password: {} }, { display_name: 'G', password: 'kurz' }, 409],
  ])) {
    const actor = old === 403 ? 'mem' : 'owner';
    const refused = await call(method, route, { json: broken, actor });
    assert.equal(refused.status, 400, `${method} ${route} broken: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, SENTENCE, `${method} ${route} broken`);
    assert.ok(refused.body.fields.every((/** @type {any} */ f) => f.path.startsWith('body')), `${method} ${route} broken`);
    const res = await call(method, route, { json: valid, actor });
    assert.equal(res.status, old, `${method} ${route} valid: ${JSON.stringify(res.body)}`);
  }
});

test('rights order: a split guest is refused at POST /groups with 403, also with a broken body', async () => {
  for (const json of [{ name: 'Eigene' }, { name: 5 }, {}]) {
    const res = await call('POST', '/split-expenses/groups', { json, actor: GUEST });
    assert.deepEqual([res.status, res.body], [403, { error: 'Not authorized.', code: 403 }], JSON.stringify(json));
  }
});

test('archive, unarchive, delete: the own calls pass', async () => {
  const extra = await call('POST', '/split-expenses/groups', { json: groupForm('Weg') });
  const id = extra.body.data.id;
  assertPassed(await call('POST', `/split-expenses/groups/${id}/archive`, { json: {} }), 200);
  assertPassed(await call('POST', `/split-expenses/groups/${id}/unarchive`, { json: {} }), 200);
  assertPassed(await call('DELETE', `/split-expenses/groups/${GROUP}/members/${GUEST}`), 200);
  assertPassed(await call('DELETE', `/split-expenses/recurring/${RECURRING}`), 200);
  assertPassed(await call('DELETE', `/split-expenses/expenses/${EXPENSE}`), 200);
  assertPassed(await call('DELETE', `/split-expenses/groups/${id}`), 200);
});

// ════════════════════════════════════════════════════════════════════════════
// BACKUP
// ════════════════════════════════════════════════════════════════════════════

test('backup: every route carries validateRequest() behind requireAdmin; a member gets the 403, also with a broken body', async () => {
  const routes = backupRouter.stack.filter((/** @type {any} */ l) => l.route);
  assert.equal(routes.length, 10);
  for (const layer of routes) {
    const names = layer.route.stack.map((/** @type {any} */ l) => l.name);
    assert.ok(names.includes('validateRequestMiddleware'), layer.route.path);
    assert.ok(names.indexOf('requireAdmin') < names.indexOf('validateRequestMiddleware'), `${layer.route.path}: requireAdmin first`);
  }
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['GET', '/backup/status', undefined],
    ['GET', '/backup/webdav/config', undefined],
    ['PUT', '/backup/webdav/config', { url: 1 }],
    ['POST', '/backup/webdav/test', { url: 1 }],
    ['POST', '/backup/trigger', undefined],
    ['GET', '/system/diagnostics', undefined],
  ])) {
    const res = await call(method, route, { json, actor: 'mem' });
    assert.deepEqual([res.status, res.body], [403, ADMIN_REQUIRED], `${method} ${route}`);
  }
});

test('PUT /backup/webdav/config: the settings form passes, wrong types are a 400 (`username: 5` was a 500), the route keeps its errorCode cases', async () => {
  const form = { enabled: false, url: null, username: null, remotePath: '/yuvomi/backups/', keep: 7 };
  assertPassed(await call('PUT', '/backup/webdav/config', { json: form, actor: 'admin' }), 200, 'settings form');
  for (const [over, path, rule] of /** @type {Array<[Record<string, unknown>, string, string]>} */ ([
    [{ username: 5 }, 'body/username', 'type'],
    [{ password: 5 }, 'body/password', 'type'],
    [{ remotePath: ['a'] }, 'body/remotePath', 'type'],
    [{ keep: 7.5 }, 'body/keep', 'type'],
    [{ keep: 0 }, 'body/keep', 'minimum'],
    [{ enabled: 'yes' }, 'body/enabled', 'type'],
    [{ url: 1 }, 'body/url', 'type'],
  ])) {
    const res = await call('PUT', '/backup/webdav/config', { json: { ...form, ...over }, actor: 'admin' });
    assertRefusedAt(res, path, rule, JSON.stringify(over));
    assert.equal(res.body.errorCode, undefined);
  }
  assertRefusedAt(await call('PUT', '/backup/webdav/config', { actor: 'admin' }), 'body', 'required');
  const badUrl = await call('PUT', '/backup/webdav/config', { json: { ...form, url: 'ftp://x' }, actor: 'admin' });
  assert.deepEqual([badUrl.status, badUrl.body.errorCode], [400, 'url_invalid']);
  // The connection test: the app's overrides, garbage, and its own case.
  const incomplete = await call('POST', '/backup/webdav/test', { json: {}, actor: 'admin' });
  assert.deepEqual([incomplete.status, incomplete.body.errorCode], [400, 'config_incomplete']);
  assertRefusedAt(await call('POST', '/backup/webdav/test', { json: { url: 5 }, actor: 'admin' }), 'body/url', 'type');
});

test('backup: status, restore and the WebDAV config read pass the check', async () => {
  assertPassed(await call('GET', '/backup/status', { actor: 'admin' }), 200);
  assertPassed(await call('GET', '/backup/webdav/config', { actor: 'admin' }), 200);
  // The restore body is octet-stream: the check leaves it to the handler.
  const restore = await call('POST', '/backup/restore', { raw: Buffer.alloc(0), actor: 'admin' });
  assert.deepEqual([restore.status, restore.body.reason], [400, 'backup_file_empty']);
});

// ════════════════════════════════════════════════════════════════════════════
// CORE
// ════════════════════════════════════════════════════════════════════════════

test('core: diagnostics and changelog carry validateRequest() and answer the own calls', async () => {
  for (const router of [systemRouter, changelogRouter]) {
    const routes = router.stack.filter((/** @type {any} */ l) => l.route);
    assert.equal(routes.length, 1);
    assert.ok(routes[0].route.stack.some((/** @type {any} */ l) => l.name === 'validateRequestMiddleware'));
  }
  const diagnostics = await call('GET', '/system/diagnostics', { actor: 'admin' });
  assertPassed(diagnostics, 200);
  const changelog = await call('GET', '/changelog');
  assertPassed(changelog, 200);
  assert.ok(changelog.body.data);
});
