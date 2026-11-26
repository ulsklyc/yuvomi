/**
 * Test: request validation in the tasks routes (#2810, phase 2 section E,
 *       group 11a)
 * Purpose: server/routes/tasks.js checks every request against the schema of
 *          its operation in the OpenAPI document (`validateRequest()` in every
 *          route, 32) before the handler runs. Held here against the real
 *          router at its real prefix (test/tasks-app.js):
 *            - THE OWN CALLERS: the requests public/pages/tasks.js,
 *              public/components/task-detail.js, the category and tag
 *              managers and the rewards settings send pass - the task form
 *              with its switches as 1/0, `null` in the empty fields and
 *              `sync_target: ''`, and GET /tasks with two values per filter.
 *              The document refused both before this group: its switches
 *              were booleans only and its filters single values;
 *            - REFUSED: garbage per field is a 400 with `reason:
 *              'validation'` and `fields`;
 *            - 500 NOW 400: values of the wrong type that ran into the
 *              database (`parent_task_id: 0`, `sync_target: 5`, `PUT status:
 *              null`, `?limit=1.5`, `order: [5, {}]`), and an assignee
 *              without an account (decision 11, a check in the handler);
 *            - SILENT READINGS NOW REFUSED: a path id `1.0` deleted task 1,
 *              `comment: 5` was stored as the text "5";
 *            - ORDER: the rights without a row (`requireAdmin` at the point
 *              routes, the capability `tasks_reorder_family` at the order
 *              routes) stand in front of the check, a 403 meets a malformed
 *              request too (decision 7); the check stands in front of the row
 *              lookup and its 404 and 403 (decision 8);
 *            - ONE SOURCE: the value lists of the schemas are the constants of
 *              server/services/task-fields.js, which the handlers, the
 *              rotation service, the MCP tools and the settings read, and
 *              equal the rights' visibility levels and the CHECK constraints
 *              of `tasks`;
 *            - FULL REPRESENTATION (step c): `PUT /{id}/documents` requires
 *              `document_ids` (left out, every visible link was removed); the
 *              PUT of public/pages/tasks.js sends it;
 *            - THE DOCUMENT: 32 operations, each with input answering the 400.
 *          No network: no CalDAV server is asked (no task here has a sync
 *          target).
 * Run: npm run test:validate-tasks
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import rateLimit from 'express-rate-limit';
import { createTasksApp } from './tasks-app.js';
import { assertArrayLimit } from './array-limit-cases.js';
import { MAX_ATTACHMENTS, MAX_MEMBER_IDS, MAX_RAW_ENTRIES } from '../server/openapi/array-limits.js';

const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const fields = await import('../server/services/task-fields.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';

/** @param {string} username @param {string} role @param {string} familyRole */
function user(username, role, familyRole) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('admin11a', 'admin', 'mom');
const MEM = user('mem11a', 'member', 'dad');
const MEM2 = user('mem11b', 'member', 'other');
const KID = user('kid11a', 'member', 'child');
// The household order is not the child's (R23): the capability is off.
db.prepare(`INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
  VALUES ('user', ?, 'capability', 'tasks_reorder_family', 'none')`).run(String(KID));

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  mem2: { id: MEM2, role: 'member' },
  kid: { id: KID, role: 'member' },
};

const app = await createTasksApp({
  auth: (/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = 'session';
    req.session = { userId: actor.id, role: actor.role };
    req.sessionModuleAccess = null;
    req.authScopes = null;
    next();
  },
  // server/index.js puts the general API limiter in front; a generous one here.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api/v1/tasks`)));
test.after(() => { server.close(); });

/**
 * @param {string} method
 * @param {string} route under /api/v1/tasks
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
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const text = await res.text();
  /** @type {any} */
  let body = null;
  try { body = JSON.parse(text); } catch { /* no JSON body */ }
  return { status: res.status, body };
}

/**
 * The 400 of the schema, naming the field.
 * @param {{ status: number, body: any }} res
 * @param {string} path the expected `fields[].path`
 * @param {string} label
 */
function assertRefused(res, path, label) {
  assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.equal(res.body?.reason, 'validation', label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path), `${label}: ${JSON.stringify(res.body.fields)}`);
}

/** A task stored by hand. @param {Record<string, unknown>} [over] */
function task(over = {}) {
  const row = { title: 'Aufgabe', created_by: ADMIN, visibility: 'all', locked: 0, parent_task_id: null, ...over };
  return Number(db.prepare(`INSERT INTO tasks (title, category, priority, status, created_by, visibility, locked, parent_task_id)
    VALUES (?, 'misc', 'none', 'open', ?, ?, ?, ?)`).run(row.title, row.created_by, row.visibility, row.locked, row.parent_task_id).lastInsertRowid);
}
/** @param {number} id */
const exists = (id) => Boolean(db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id));
const taskCount = () => /** @type {any} */ (db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).n;

/**
 * The body the task form of public/pages/tasks.js sends (saveTask, the
 * `body` literal): the switches as 1/0, `null` in the empty fields, the sync
 * target field as its select value ('' = local only), the status only in the
 * edit form.
 * @param {Record<string, unknown>} [over]
 */
const formBody = (over = {}) => ({
  title: 'Formular',
  description: null,
  priority: 'medium',
  category: 'misc',
  tags: ['garten'],
  start_date: null,
  due_date: '2030-05-01',
  assigned_to: [MEM],
  visibility: 'all',
  is_recurring: 1,
  recurrence_rule: 'FREQ=WEEKLY',
  recurrence_from_completion: 0,
  countdown: 0,
  locked: 0,
  points: 5,
  sync_target: '',
  due_time: null,
  ...over,
});

test('the own callers: the task form of public/pages/tasks.js passes POST and PUT', async () => {
  const created = await call('POST', '', { json: formBody() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.is_recurring, 1);
  const id = created.body.data.id;

  // The other forms the dialog builds: no repetition, an empty category list
  // (category ''), a time, the rotation section, and the edit form with status.
  const variants = [
    formBody({ is_recurring: 0, recurrence_rule: null, category: '', due_time: '09:30', countdown: 1, locked: 1, points: 0 }),
    formBody({ rotation_mode: 'round_robin', rotation_pool: [ADMIN, MEM] }),
    formBody({ rotation_mode: null, priority: '' }),
  ];
  for (const body of variants) {
    const res = await call('POST', '', { json: body });
    assert.equal(res.status, 201, `POST ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
  }
  for (const body of [formBody({ status: 'in_progress' }), formBody({ status: 'open', is_recurring: 0, recurrence_rule: null }), { title: 'Umbenannt' }]) {
    const res = await call('PUT', `/${id}`, { json: body });
    assert.equal(res.status, 200, `PUT ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
  }

  // iOS and MCP send booleans; the server still cuts the points.
  const ios = await call('POST', '', { json: { title: 'iOS', is_recurring: false, countdown: true, locked: false, points: 1e9 } });
  assert.equal(ios.status, 201, JSON.stringify(ios.body));
  assert.equal(ios.body.data.points, fields.TASK_MAX_POINTS, 'cut rather than refused, as the description says');
  const fraction = await call('POST', '', { json: { title: 'Bruch', points: 5.7 } });
  assert.equal(fraction.body.data.points, 5);
});

test('the own callers: GET /tasks takes two values for status, priority, assigned_to and category', async () => {
  const query = new URLSearchParams();
  for (const [name, value] of [['status', 'open'], ['status', 'done'], ['priority', 'low'], ['priority', 'high'],
    ['assigned_to', String(ADMIN)], ['assigned_to', String(MEM)], ['category', 'misc'], ['category', 'household'],
    ['tag', 'a'], ['tag', 'b']]) query.append(name, value);
  const res = await call('GET', `?${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // The kanban and the calendar.
  for (const q of ['?archived=1', '?archived=only', '?archived=true', '?include_future=1', '?status=archived&status=open']) {
    assert.equal((await call('GET', q)).status, 200, q);
  }
  // An unknown value stays a filter without a hit (the description says so).
  const unknown = await call('GET', '?status=nope&priority=nope');
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body.data, []);
});

test('the own callers: the detail, the managers and the settings reach the handler', async () => {
  const parent = (await call('POST', '', { json: { title: 'Eltern' } })).body.data.id;
  // task-detail.js
  assert.equal((await call('POST', '', { json: { title: 'Schritt', parent_task_id: parent } })).status, 201);
  assert.equal((await call('PATCH', `/${parent}/status`, { json: { status: 'in_progress' } })).status, 200);
  assert.equal((await call('PATCH', `/${parent}/status`, { json: { status: 'done', done_by_user_id: MEM } })).status, 200);
  assert.equal((await call('PATCH', `/${parent}/archive`, { json: { archived: true } })).status, 200);
  assert.equal((await call('PATCH', `/${parent}/archive`, { json: { archived: false } })).status, 200);
  assert.equal((await call('PATCH', `/${parent}/archive`)).status, 200, 'no body archives (required: false)');
  const checklist = task({ title: 'Liste' });
  db.prepare("UPDATE tasks SET description = '- [ ] Milch' WHERE id = ?").run(checklist);
  assert.equal((await call('PATCH', `/${checklist}/check`, { json: { line: 0, checked: true, expect: '- [ ] Milch' } })).status, 200);
  const comment = await call('POST', `/${parent}/comments`, { json: { comment: 'Hallo @mem11a' } });
  assert.equal(comment.status, 201);
  assert.equal((await call('GET', `/${parent}/comments`)).status, 200);
  assert.equal((await call('PATCH', `/${parent}/comments/${comment.body.data.id}`, { json: { comment: 'Neu' } })).status, 200);
  assert.equal((await call('DELETE', `/${parent}/comments/${comment.body.data.id}`)).status, 200);
  assert.equal((await call('GET', `/${parent}/completions?limit=10`)).status, 200);
  assert.equal((await call('PUT', `/${parent}/documents`, { json: { document_ids: [] } })).status, 200);
  assert.equal((await call('GET', `/${parent}/documents`)).status, 200);
  assert.equal((await call('GET', `/${parent}`)).status, 200);

  // tasks.js: history, bulk actions, hand order, inline rename, delete.
  const page = await call('GET', `/completions?limit=50&user_id=${MEM}`);
  assert.equal(page.status, 200);
  assert.equal((await call('GET', '/completions?limit=50&before_at=2030-01-01T00:00:00Z&before_id=5')).status, 200);
  const a = task({ title: 'A' });
  const b = task({ title: 'B' });
  assert.equal((await call('POST', '/tags/apply', { json: { ids: [a, b], add: ['x'] } })).status, 200);
  assert.equal((await call('POST', '/tags/apply', { json: { ids: [a], remove: ['x'] } })).status, 200);
  assert.equal((await call('PATCH', '/reorder', { json: { order: [b, a] } })).status, 200);
  assert.equal((await call('POST', '/reorder/reset', { json: { ids: [a, b] } })).status, 200);
  assert.equal((await call('POST', '/archive', { json: { ids: [a, b] } })).status, 200);
  assert.equal((await call('PUT', `/${a}`, { json: { title: 'A neu' } })).status, 200);
  assert.equal((await call('DELETE', `/${b}`)).status, 200);

  // category-manager.js and tag-manager.js.
  const cat = await call('POST', '/categories', { json: { name: 'Garten' } });
  assert.equal(cat.status, 201);
  assert.equal((await call('PUT', `/categories/${cat.body.data.key}`, { json: { name: 'Hof' } })).status, 200);
  assert.equal((await call('PATCH', '/categories/reorder', { json: { order: [cat.body.data.key, 'misc'] } })).status, 200);
  assert.equal((await call('DELETE', `/categories/${cat.body.data.key}`)).status, 204);
  await call('POST', '/tags/apply', { json: { ids: [a], add: ['alt'] } });
  assert.equal((await call('PUT', '/tags/alt', { json: { name: 'neu' } })).status, 200);
  assert.equal((await call('DELETE', '/tags/neu')).status, 200);

  // modules-rewards.js (admin) and the reads of the page.
  assert.equal((await call('GET', '/points/affected?points=5')).status, 200);
  assert.equal((await call('POST', '/points/rebase', { json: { from: 5, to: 8 } })).status, 200);
  for (const route of ['/meta/options', '/categories', '/tags', '/sync-targets']) {
    assert.equal((await call('GET', route)).status, 200, route);
  }
});

test('refused: garbage per field is a 400 of the schema', async () => {
  const id = task();
  /** @type {Array<[string, string, unknown, string]>} */
  const cases = [
    ['POST', '', { title: 'X', is_recurring: 'false' }, 'body/is_recurring'],
    ['POST', '', { title: 'X', countdown: 5 }, 'body/countdown'],
    ['PUT', `/${id}`, { locked: null }, 'body/locked'],
    ['POST', '', { title: 'X', recurrence_from_completion: 'x' }, 'body/recurrence_from_completion'],
    ['POST', '', { title: 'X', points: '5' }, 'body/points'],
    ['POST', '', { title: 'X', points: true }, 'body/points'],
    ['POST', '', { title: 'X', points: '' }, 'body/points'],
    ['POST', '', { title: 'X', visibility: 'x' }, 'body/visibility'],
    ['POST', '', { title: 'X', due_date: '' }, 'body/due_date'],
    ['POST', '', { title: 'X', due_time: '24:00' }, 'body/due_time'],
    ['POST', '', { title: 'X', status: '' }, 'body/status'],
    ['POST', '', { title: 'X', assigned_to: '2' }, 'body/assigned_to'],
    ['POST', '', { title: 'X', assigned_to: [MEM, MEM] }, 'body/assigned_to'],
    ['POST', '', { title: 'X', parent_task_id: '1' }, 'body/parent_task_id'],
    ['POST', '', { title: 'X', tags: [5] }, 'body/tags'],
    ['POST', '', { title: 'X', rotation_pool: ['2', '3'] }, 'body/rotation_pool/0'],
    ['POST', '', {}, 'body/title'],
    ['PUT', `/${id}`, { status: 'x' }, 'body/status'],
    ['PATCH', `/${id}/status`, { status: 'done', done_by_user_id: true }, 'body/done_by_user_id'],
    ['PATCH', `/${id}/status`, { status: 'open', done_by_user_id: 'x' }, 'body/done_by_user_id'],
    ['PATCH', `/${id}/archive`, { archived: 0 }, 'body/archived'],
    ['PATCH', `/${id}/check`, { line: 'x', checked: true }, 'body/line'],
    ['POST', '/tags/apply', { ids: ['1'], add: ['x'] }, 'body/ids/0'],
    ['POST', '/tags/apply', { ids: [], add: ['x'] }, 'body/ids'],
    ['POST', '/archive', { ids: 'x' }, 'body/ids'],
    ['POST', '/archive', { ids: Array.from({ length: fields.MAX_BULK_TASKS + 1 }, (_, i) => i + 1) }, 'body/ids'],
    ['PUT', '/tags/x', { name: 5 }, 'body/name'],
    ['POST', '/categories', { name: 5 }, 'body/name'],
    ['PUT', '/categories/misc', { name: ['x'] }, 'body/name'],
    ['PATCH', '/categories/reorder', { order: 'x' }, 'body/order'],
    ['PATCH', '/categories/reorder', {}, 'body/order'],
    ['PATCH', '/reorder', { order: [1, 1] }, 'body/order'],
    ['PATCH', '/reorder', { order: ['1'] }, 'body/order/0'],
    ['POST', '/reorder/reset', { ids: [1.5] }, 'body/ids/0'],
    ['PUT', `/${id}/documents`, { document_ids: 'x' }, 'body/document_ids'],
    ['PUT', `/${id}/documents`, { document_ids: [0] }, 'body/document_ids/0'],
    ['PATCH', `/${id}/comments/1`, { comment: null }, 'body/comment'],
    ['POST', '/points/rebase', { from: 0, to: 5 }, 'body/from'],
    ['POST', '/points/rebase', { from: 5, to: null }, 'body/to'],
  ];
  for (const [method, route, json, path] of cases) {
    assertRefused(await call(method, route, { json }), path, `${method} ${route} ${JSON.stringify(json).slice(0, 80)}`);
  }
  // Query and path.
  for (const [route, path] of [
    ['?assigned_to=abc', 'query/assigned_to/0'],
    ['/completions?limit=0', 'query/limit'],
    ['/completions?limit=201', 'query/limit'],
    ['/completions?user_id=abc', 'query/user_id'],
    ['/completions?before_id=x', 'query/before_id'],
    [`/${id}/completions?limit=101`, 'query/limit'],
    ['/points/affected?points=x', 'query/points'],
    ['/points/affected', 'query/points'],
    ['/points/affected?points=5&points=6', 'query/points'],
    ['/1abc', 'path/id'],
  ]) {
    assertRefused(await call('GET', route), path, `GET ${route}`);
  }
  // Missing bodies (decision 15): every body is required but that of PATCH /{id}/archive.
  for (const [method, route] of [['PUT', `/${id}`], ['PUT', `/${id}/documents`], ['POST', `/${id}/comments`], ['PATCH', '/categories/reorder']]) {
    assertRefused(await call(method, route), 'body', `${method} ${route} without a body`);
  }
});

test('500 now 400: a value of the wrong type no longer reaches the database', async () => {
  const id = task();
  const before = taskCount();
  for (const [json, path] of /** @type {Array<[Record<string, unknown>, string]>} */ ([
    [{ title: 'X', parent_task_id: 0 }, 'body/parent_task_id'],
    [{ title: 'X', parent_task_id: true }, 'body/parent_task_id'],
    [{ title: 'X', sync_target: 5 }, 'body/sync_target'],
  ])) {
    assertRefused(await call('POST', '', { json }), path, JSON.stringify(json));
  }
  assert.equal(taskCount(), before, 'nothing was created');
  for (const status of [null, '']) {
    assertRefused(await call('PUT', `/${id}`, { json: { status } }), 'body/status', `PUT status ${JSON.stringify(status)}`);
  }
  assert.equal(/** @type {any} */ (db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).status, 'open');
  assertRefused(await call('GET', '/completions?limit=1.5'), 'query/limit', 'limit=1.5');
  assertRefused(await call('PATCH', '/categories/reorder', { json: { order: [5, {}] } }), 'body/order/0', 'order [5, {}]');
});

test('an assignee without an account is the 400 of a non-member, not a 500 (decision 11)', async () => {
  const before = taskCount();
  const created = await call('POST', '', { json: { title: 'Niemand', assigned_to: [999] } });
  assert.equal(created.status, 400, JSON.stringify(created.body));
  assert.match(created.body.error, /user 999 is not a household member/);
  assert.equal(taskCount(), before);
  const id = task();
  const updated = await call('PUT', `/${id}`, { json: { assigned_to: [MEM, 999] } });
  assert.equal(updated.status, 400, JSON.stringify(updated.body));
  assert.match(updated.body.error, /user 999 is not a household member/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ?').get(id).n, 0, 'nothing assigned');
});

test('a path id that is not plain digits deletes nothing', async () => {
  const id = task({ title: 'Bleibt' });
  for (const form of [`${id}.0`, `${id}e0`, `%20${id}`]) {
    assertRefused(await call('DELETE', `/${form}`), 'path/id', `DELETE /${form}`);
  }
  assert.ok(exists(id), 'the task is still there');
  const comment = (await call('POST', `/${id}/comments`, { json: { comment: 'Bleibt' } })).body.data.id;
  assertRefused(await call('DELETE', `/${id}/comments/${comment}.0`), 'path/commentId', 'DELETE comment 1.0');
  assert.ok(db.prepare('SELECT 1 FROM task_comments WHERE id = ?').get(comment), 'the comment is still there');
});

test('a comment is text: comment: 5 is refused, not stored as "5"', async () => {
  const id = task();
  assertRefused(await call('POST', `/${id}/comments`, { json: { comment: 5 } }), 'body/comment', 'comment: 5');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(id).n, 0);
});

test('order: the rights without a row stand in front of the check (decision 7)', async () => {
  const a = task();
  // The child without `tasks_reorder_family`: 403 whatever the body.
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['PATCH', '/reorder', { order: 'x' }], ['PATCH', '/reorder', {}], ['PATCH', '/reorder', { order: [a] }],
    ['POST', '/reorder/reset', { ids: 'x' }], ['POST', '/reorder/reset', { ids: [a] }],
  ])) {
    const res = await call(method, route, { json, actor: 'kid' });
    assert.equal(res.status, 403, `${method} ${route} ${JSON.stringify(json)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'reorder_not_allowed');
  }
  assertRefused(await call('PATCH', '/reorder', { json: { order: 'x' }, actor: 'mem' }), 'body/order', 'a member with the capability meets the check');

  // A member at the admin routes: 403 whatever the query or body.
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['GET', '/points/affected?points=x', undefined], ['GET', '/points/affected', undefined], ['GET', '/points/affected?points=5', undefined],
    ['POST', '/points/rebase', { from: 'x', to: 'x' }], ['POST', '/points/rebase', { from: 5, to: 6 }],
  ])) {
    const res = await call(method, route, { json, actor: 'mem' });
    assert.equal(res.status, 403, `${method} ${route}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'admin_required');
  }
  assertRefused(await call('GET', '/points/affected?points=x'), 'query/points', 'the admin meets the check');
});

test('order: the check stands in front of the row - 400 before 404 and 403 (decision 8)', async () => {
  // An unknown task.
  assertRefused(await call('PUT', '/999999', { json: { title: 5 } }), 'body/title', 'PUT unknown + title 5');
  assert.equal((await call('PUT', '/999999', { json: { title: 'x' } })).status, 404);
  assertRefused(await call('POST', '/999999/comments', { json: { comment: 5 } }), 'body/comment', 'POST comment unknown + 5');
  assert.equal((await call('POST', '/999999/comments', { json: { comment: 'x' } })).status, 404);
  // A private task of another member: 404 with a valid body.
  const hidden = task({ created_by: MEM2, visibility: 'private' });
  assertRefused(await call('PATCH', `/${hidden}/check`, { json: { line: 'x', checked: true }, actor: 'mem' }), 'body/line', 'check hidden + line x');
  assert.equal((await call('PATCH', `/${hidden}/check`, { json: { line: 0, checked: true }, actor: 'mem' })).status, 404);

  // A locked task of the admin: 403 with a valid body.
  const locked = task({ locked: 1 });
  assertRefused(await call('PATCH', `/${locked}/archive`, { json: { archived: 'x' }, actor: 'mem' }), 'body/archived', 'locked + archived x');
  const lockedRes = await call('PATCH', `/${locked}/archive`, { json: { archived: true }, actor: 'mem' });
  assert.equal(lockedRes.status, 403);
  assert.equal(lockedRes.body.reason, 'task_locked');
  assertRefused(await call('PUT', `/${locked}/documents`, { json: { document_ids: 'x' }, actor: 'mem' }), 'body/document_ids', 'locked + document_ids x');
  assert.equal((await call('PUT', `/${locked}/documents`, { json: { document_ids: [] }, actor: 'mem' })).status, 403);

  // A comment of another member: 403 with a valid body.
  const open = task();
  const theirs = (await call('POST', `/${open}/comments`, { json: { comment: 'Meins' }, actor: 'mem2' })).body.data.id;
  assertRefused(await call('PATCH', `/${open}/comments/${theirs}`, { json: { comment: 5 }, actor: 'mem' }), 'body/comment', 'foreign comment + 5');
  assert.equal((await call('PATCH', `/${open}/comments/${theirs}`, { json: { comment: 'Fremd' }, actor: 'mem' })).status, 403);
  assert.equal((await call('DELETE', `/${open}/comments/${theirs}`, { actor: 'mem' })).status, 403);
});

test('one source: the value lists of the schemas are those of task-fields.js, the rights and the columns', async () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schemas = spec.components.schemas;
  const { VISIBILITY_VALUES } = await import('../server/authorize/index.ts');
  assert.deepEqual([...fields.TASK_VISIBILITY], [...VISIBILITY_VALUES], 'the visibility levels of the rights');
  for (const name of ['TaskCreateInput', 'TaskUpdateInput']) {
    const p = schemas[name].properties;
    assert.deepEqual(p.priority.enum, [...fields.TASK_PRIORITIES, ''], `${name}.priority`);
    assert.deepEqual(p.visibility.enum, [...fields.TASK_VISIBILITY], `${name}.visibility`);
    assert.deepEqual(p.rotation_mode.enum, [...fields.ROTATION_MODES, null], `${name}.rotation_mode`);
    assert.equal(p.rotation_pool.maxItems, fields.MAX_ROTATION_POOL, `${name}.rotation_pool`);
  }
  assert.deepEqual(schemas.TaskCreateInput.properties.status.enum, [...fields.TASK_STATUSES, null]);
  assert.deepEqual(schemas.TaskUpdateInput.properties.status.enum, [...fields.TASK_STATUSES]);
  assert.deepEqual(schemas.TaskStatusInput.properties.status.enum, [...fields.TASK_STATUSES]);
  assert.deepEqual(schemas.Task.properties.status.enum, [...fields.TASK_REAL_STATUSES]);
  assert.deepEqual(schemas.Task.properties.priority.enum, [...fields.TASK_PRIORITIES]);
  for (const name of ['TaskTagsApplyInput', 'TaskArchiveManyInput', 'TaskReorderResetInput']) {
    assert.equal(schemas[name].properties.ids.maxItems, fields.MAX_BULK_TASKS, name);
  }
  assert.equal(schemas.TaskReorderInput.properties.order.maxItems, fields.MAX_BULK_TASKS);

  // The CHECK constraints of the table as the database holds them.
  const sql = String(/** @type {any} */ (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()).sql);
  const listOf = (/** @type {string} */ column) => {
    const m = sql.match(new RegExp(`CHECK\\s*\\(\\s*${column} IN \\(([^)]*)\\)`));
    assert.ok(m, `CHECK of ${column}`);
    return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  };
  assert.deepEqual(listOf('priority'), [...fields.TASK_PRIORITIES], 'tasks.priority CHECK');
  assert.deepEqual(listOf('status').filter((s) => s !== fields.ARCHIVE_STATUS), [...fields.TASK_REAL_STATUSES], 'tasks.status CHECK');

  // The readers of the lists.
  const { TOOL_DEFINITIONS } = await import('../server/mcp/tools.js');
  const createTask = /** @type {any} */ (TOOL_DEFINITIONS.find((t) => t.name === 'create_task'));
  assert.deepEqual(createTask.inputSchema.properties.priority.enum, [...fields.TASK_PRIORITIES], 'MCP create_task');
  const { MAX_TASK_POINTS } = await import('../server/settings/values.ts');
  assert.equal(MAX_TASK_POINTS, fields.TASK_MAX_POINTS, 'tasks_default_points');
  const { isRotationMode } = await import('../server/services/task-rotation.js');
  for (const mode of fields.ROTATION_MODES) assert.equal(isRotationMode(mode), true, mode);
  assert.equal(isRotationMode('random'), false);
  const options = await call('GET', '/meta/options');
  assert.deepEqual(options.body.priorities, [...fields.TASK_PRIORITIES]);
  assert.deepEqual(options.body.statuses, [...fields.TASK_STATUSES]);
});

// --------------------------------------------------------------------------
// Full representation (group 11a c)
// --------------------------------------------------------------------------

/** A family document stored by hand. */
function documentRow() {
  return Number(db.prepare(`INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES ('Zettel', 'file.pdf', 'application/pdf', 5, ?, 'other', 'family', 'active', ?)`)
    .run(Buffer.from('bytes'), ADMIN).lastInsertRowid);
}
/** A task with the given documents linked. @param {number[]} docIds */
function linkedTask(docIds) {
  const id = task({ title: 'Mit Anhang' });
  const ins = db.prepare('INSERT INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)');
  for (const doc of docIds) ins.run(id, doc, ADMIN);
  return id;
}
/** The stored links of a task, in id order. @param {number} id */
function linkedIds(id) {
  return db.prepare('SELECT document_id FROM task_documents WHERE task_id = ? ORDER BY document_id')
    .all(id).map((/** @type {any} */ r) => r.document_id);
}

test('full representation: PUT /{id}/documents requires document_ids', async () => {
  // Left out, the route replaced the visible links with nothing: two linked
  // documents became none with a 200.
  const [a, b, c] = [documentRow(), documentRow(), documentRow()];
  const id = linkedTask([a, b]);
  const without = await call('PUT', `/${id}/documents`, { json: {} });
  assert.equal(without.status, 400, JSON.stringify(without.body));
  assert.equal(without.body.error, SENTENCE);
  assert.equal(without.body.reason, 'validation');
  assert.deepEqual(without.body.fields, [{ path: 'body/document_ids', rule: 'required' }]);
  assert.deepEqual(linkedIds(id), [a, b], 'refused: the links stay');
  // No body at all: the same refusal, the links stay.
  assertRefused(await call('PUT', `/${id}/documents`), 'body', 'no body');
  assert.deepEqual(linkedIds(id), [a, b], 'no body: the links stay');
  // Before the 404 of an unknown task and the 403 of a locked one.
  const unknown = await call('PUT', '/987654/documents', { json: {} });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  const locked = task({ locked: 1 });
  const lockedRes = await call('PUT', `/${locked}/documents`, { json: {}, actor: 'mem' });
  assert.equal(lockedRes.status, 400, JSON.stringify(lockedRes.body));

  // The list replaces the links.
  const list = await call('PUT', `/${id}/documents`, { json: { document_ids: [b, c] } });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(linkedIds(id), [b, c]);
  // `[]` empties them on purpose.
  const emptied = await call('PUT', `/${id}/documents`, { json: { document_ids: [] } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
  assert.deepEqual(emptied.body.data, []);
  assert.deepEqual(linkedIds(id), []);
});

test('the own caller: the body tasks.js builds links exactly the documents it sends', async () => {
  const [a, b, c] = [documentRow(), documentRow(), documentRow()];
  const id = linkedTask([a, b]);
  // handleFormSubmit(): `{ document_ids: documentIds }`, the ids commit() returns.
  const res = await call('PUT', `/${id}/documents`, { json: { document_ids: [a, c] } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.map((/** @type {any} */ d) => d.id).sort((/** @type {number} */ x, /** @type {number} */ y) => x - y), [a, c]);
  assert.deepEqual(linkedIds(id), [a, c]);
});

/**
 * The top-level keys of every `api.put(`/tasks/${...}/documents`, {...})` of
 * the page.
 * @param {string} source public/pages/tasks.js
 * @returns {string[][]}
 */
function taskDocumentPuts(source) {
  const found = [];
  for (const match of source.matchAll(/api\.put\(`\/tasks\/\$\{[^`]*\}\/documents`\s*,\s*\{/g)) {
    const open = /** @type {number} */ (match.index) + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if ('({['.includes(source[i])) depth++;
      else if (')}]'.includes(source[i]) && --depth === 0) { end = i; break; }
    }
    const text = source.slice(open, end + 1).replace(/^\s*\/\/.*$/gm, '');
    const keys = [];
    depth = 0;
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];
      if ('({['.includes(ch)) depth++;
      else if (')}]'.includes(ch)) depth--;
      if (depth === 1 && (ch === '{' || ch === ',')) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*[:,}]/.exec(text.slice(j + 1));
        if (m) keys.push(m[1]);
      }
    }
    found.push(keys);
  }
  return found;
}

test('the own caller: the PUT of tasks.js sends every required field of TaskDocumentsInput', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schema = spec.components.schemas.TaskDocumentsInput;
  assert.deepEqual(schema.required, ['document_ids']);
  const calls = taskDocumentPuts(readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8'));
  assert.equal(calls.length, 1, `the PUTs found ${JSON.stringify(calls)}`);
  for (const keys of calls) {
    for (const key of schema.required) assert.ok(keys.includes(key), `sends ${key}: ${JSON.stringify(keys)}`);
  }
});

test('the document: 32 task operations, each with input answering the 400', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const ops = Object.entries(spec.paths)
    .filter(([path]) => path === '/api/v1/tasks' || path.startsWith('/api/v1/tasks/'))
    .flatMap(([path, item]) => Object.entries(/** @type {Record<string, any>} */ (item)).map(([method, op]) => ({ path, method, op })));
  assert.equal(ops.length, 32);
  for (const { path, method, op } of ops) {
    const where = `${method.toUpperCase()} ${path}`;
    const input = (op.parameters ?? []).some((/** @type {any} */ p) => p.in !== 'header') || op.requestBody;
    if (input) assert.ok(op.responses[400], `${where} answers 400`);
    if (op.requestBody) {
      const schema = op.requestBody.content['application/json'].schema;
      assert.ok(schema.$ref, `${where}: a named body schema, not an open object`);
      assert.equal(op.requestBody.required, !(method === 'patch' && path.endsWith('/archive')), `${where}: required`);
    }
  }
  const affected = spec.paths['/api/v1/tasks/points/affected'].get;
  assert.deepEqual(affected.parameters.find((/** @type {any} */ p) => p.name === 'points').schema,
    { type: 'integer', minimum: 0, maximum: fields.TASK_MAX_POINTS });
  // Step (c): `document_ids` is required, `[]` removes the visible links.
  assert.match(spec.paths['/api/v1/tasks/{id}/documents'].put.description, /`document_ids` is required; `\[\]` removes every visible link/);
  assert.doesNotMatch(spec.paths['/api/v1/tasks/{id}/documents'].put.description, /Omitting document_ids/);
  assert.deepEqual(spec.components.schemas.TaskDocumentsInput.required, ['document_ids']);
  assert.doesNotMatch(spec.components.schemas.TaskDocumentsInput.properties.document_ids.description, /Omitting/);
  assert.equal(spec.paths['/api/v1/tasks/categories'].post.responses[201] !== undefined, true);
  assert.equal(spec.paths['/api/v1/tasks/categories/{key}'].delete.responses[204] !== undefined, true);
  assert.equal(spec.paths['/api/v1/tasks/{id}/comments'].post.responses[201] !== undefined, true);
});

// Since group 11a step (b) the schema is the only guard for these: the task
// handlers dropped their own check (#2810). So the types, lists, bounds and
// the pattern are pinned here as literal values - a looser type, a lost
// `required`, a value added to a list (also to the constant in
// server/services/task-fields.js the list is read from), a lost bound or a
// wider pattern turns this red.
test('only guard: the types, lists and bounds the task handlers no longer check are the document\'s, as values', async () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schemas = spec.components.schemas;
  const { TIME_PATTERN } = await import('../server/utils/datetime-pattern.js');
  // The constants as they stand.
  assert.deepEqual([...fields.TASK_PRIORITIES], ['none', 'low', 'medium', 'high', 'urgent']);
  assert.deepEqual([...fields.TASK_STATUSES], ['open', 'in_progress', 'done', 'archived']);
  assert.deepEqual([...fields.ROTATION_MODES], ['round_robin']);
  assert.equal(fields.MAX_BULK_TASKS, 500);
  assert.equal(fields.MAX_ROTATION_POOL, 10);
  assert.equal(fields.TASK_MAX_POINTS, 10000);
  assert.equal(TIME_PATTERN, '^(?:[01]\\d|2[0-3]):[0-5]\\d$');
  const TAGS = { oneOf: [{ type: 'array', maxItems: MAX_RAW_ENTRIES, items: { type: 'string' } }, { type: 'string' }, { type: 'null' }] };
  // POST / and PUT /{id}: validateTaskInput() dropped textShape/str of the
  // description, textShape/oneOf of priority, oneOf of status, time, num and
  // validateTags.
  assert.deepEqual(schemas.TaskCreateInput.required, ['title']);
  for (const name of ['TaskCreateInput', 'TaskUpdateInput']) {
    const p = schemas[name].properties;
    assert.deepEqual({ type: p.title.type, minLength: p.title.minLength, maxLength: p.title.maxLength }, { type: 'string', minLength: 1, maxLength: 200 }, `${name}.title`);
    assert.deepEqual({ type: p.description.type, maxLength: p.description.maxLength }, { type: ['string', 'null'], maxLength: 5000 }, `${name}.description`);
    assert.deepEqual({ type: p.priority.type, enum: p.priority.enum }, { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent', ''] }, `${name}.priority`);
    assert.equal(p.category.type, 'string', `${name}.category`);
    assert.deepEqual({ type: p.due_time.type, pattern: p.due_time.pattern }, { type: ['string', 'null'], pattern: TIME_PATTERN }, `${name}.due_time`);
    for (const day of ['start_date', 'due_date']) assert.deepEqual({ type: p[day].type, format: p[day].format }, { type: ['string', 'null'], format: 'date' }, `${name}.${day}`);
    assert.deepEqual(p.points.type, ['number', 'null'], `${name}.points`);
    assert.deepEqual({ oneOf: p.tags.oneOf }, TAGS, `${name}.tags`);
    assert.deepEqual({ type: p.rotation_mode.type, enum: p.rotation_mode.enum }, { type: ['string', 'null'], enum: ['round_robin', null] }, `${name}.rotation_mode`);
    assert.deepEqual({ type: p.rotation_pool.type, maxItems: p.rotation_pool.maxItems, items: p.rotation_pool.items }, { type: 'array', maxItems: 10, items: { type: 'integer', minimum: 1 } }, `${name}.rotation_pool`);
  }
  assert.deepEqual(schemas.TaskCreateInput.properties.status.enum, ['open', 'in_progress', 'done', 'archived', null]);
  assert.deepEqual({ type: schemas.TaskUpdateInput.properties.status.type, enum: schemas.TaskUpdateInput.properties.status.enum }, { type: 'string', enum: ['open', 'in_progress', 'done', 'archived'] });
  // PATCH /{id}/status: `Invalid status. Allowed: ...` and `Invalid done_by_user_id.`
  assert.deepEqual(schemas.TaskStatusInput.required, ['status']);
  assert.deepEqual(schemas.TaskStatusInput.properties.status, { type: 'string', enum: ['open', 'in_progress', 'done', 'archived'] });
  const doneBy = schemas.TaskStatusInput.properties.done_by_user_id;
  assert.deepEqual({ type: doneBy.type, minimum: doneBy.minimum }, { type: ['integer', 'null'], minimum: 1 });
  // PATCH /{id}/archive: `archived must be a boolean.`
  assert.equal(schemas.TaskArchiveInput.properties.archived.type, 'boolean');
  // PATCH /{id}/check: `Invalid line number.`, `Invalid state.`, `Invalid line check.`
  const check = schemas.TaskCheckInput;
  assert.deepEqual(check.required, ['line', 'checked']);
  assert.deepEqual({ type: check.properties.line.type, minimum: check.properties.line.minimum }, { type: 'integer', minimum: 0 });
  assert.deepEqual(check.properties.checked, { type: 'boolean' });
  assert.deepEqual(check.properties.expect.type, ['string', 'null']);
  // POST /tags/apply and POST /archive: `ids must be a non-empty array of task IDs.`,
  // `At most 500 tasks at a time.`, `tags must be an array or a comma-separated string.`
  const BULK = { type: 'array', minItems: 1, maxItems: 500, items: { type: 'integer', minimum: 1 } };
  const bulk = (/** @type {any} */ s) => ({ type: s.type, minItems: s.minItems, maxItems: s.maxItems, items: s.items });
  for (const name of ['TaskTagsApplyInput', 'TaskArchiveManyInput']) {
    assert.deepEqual(schemas[name].required, ['ids'], name);
    assert.deepEqual(bulk(schemas[name].properties.ids), BULK, `${name}.ids`);
  }
  assert.deepEqual(schemas.TaskTagsApplyInput.properties.add, TAGS);
  assert.deepEqual(schemas.TaskTagsApplyInput.properties.remove, TAGS);
  // PATCH /reorder and POST /reorder/reset: the bound, the integers, the duplicates of parseReorderIds().
  for (const [name, key] of [['TaskReorderInput', 'order'], ['TaskReorderResetInput', 'ids']]) {
    assert.deepEqual(schemas[name].required, [key], name);
    assert.deepEqual(bulk(schemas[name].properties[key]), BULK, `${name}.${key}`);
    assert.equal(schemas[name].properties[key].uniqueItems, true, `${name}.${key} uniqueItems`);
  }
  // GET /points/affected and POST /points/rebase: their range sentences and `from must be greater than 0.`
  const affected = spec.paths['/api/v1/tasks/points/affected'].get.parameters.find((/** @type {any} */ p) => p.name === 'points');
  assert.equal(affected.required, true);
  assert.deepEqual(affected.schema, { type: 'integer', minimum: 0, maximum: 10000 });
  const rebase = schemas.TaskPointsRebaseInput;
  assert.deepEqual(rebase.required, ['from', 'to']);
  assert.deepEqual({ type: rebase.properties.from.type, minimum: rebase.properties.from.minimum, maximum: rebase.properties.from.maximum }, { type: 'integer', minimum: 1, maximum: 10000 });
  assert.deepEqual({ type: rebase.properties.to.type, minimum: rebase.properties.to.minimum, maximum: rebase.properties.to.maximum }, { type: 'integer', minimum: 0, maximum: 10000 });
  // The path ids pathId() reads with Number(): whole numbers only, no lower bound (0 and below answer 404).
  const ID = { type: 'integer', maximum: 9007199254740991 };
  let ids = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!path.startsWith('/api/v1/tasks/{id}')) continue;
    for (const [method, op] of Object.entries(/** @type {Record<string, any>} */ (item))) {
      for (const p of op.parameters.filter((/** @type {any} */ q) => q.in === 'path')) {
        assert.deepEqual(p.schema, ID, `${method} ${path} ${p.name}`);
        ids++;
      }
    }
  }
  assert.equal(ids, 15, 'the 13 {id} operations, two of them with a commentId');
});

test('array limits: assignees, tags and linked documents, at the limit and one above (#2810)', async () => {
  const seq = (/** @type {number} */ n, /** @type {number} */ from) => Array.from({ length: n }, (_, i) => from + i);
  await assertArrayLimit((body) => call('POST', '', { json: body }),
    (n) => ({ title: 'Viele', assigned_to: seq(n, 900000) }), MAX_MEMBER_IDS, 'body/assigned_to');
  const tagged = await assertArrayLimit((body) => call('POST', '', { json: body }),
    (n) => ({ title: 'Etiketten', tags: seq(n, 0).map((i) => `t${i}`) }), MAX_RAW_ENTRIES, 'body/tags');
  assert.equal(tagged.status, 201, 'the route keeps its own cap of distinct tags');
  const id = task();
  const linked = await assertArrayLimit((body) => call('PUT', `/${id}/documents`, { json: body }),
    (n) => ({ document_ids: seq(n, 900000) }), MAX_ATTACHMENTS, 'body/document_ids');
  assert.ok(linked.status < 500);
});
