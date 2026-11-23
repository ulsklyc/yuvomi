/**
 * Test: the answers of the task routes stay byte-equal
 *       (#2810, phase 2 section E, group 11a, step b)
 * Purpose: server/routes/tasks.js (32 operations) dropped the hand checks the
 *          schema of their operation already covers on every input
 *          (`validateRequest()` runs before every handler since #2897) and
 *          the try/catch blocks that answered an unexpected error with a 500
 *          of their own. This suite holds that refactor:
 *
 *          (1) A table of requests to all 32 operations - valid, every refusal
 *          the handler keeps (each `reason`: `task_locked`,
 *          `task_foreign_series`, `reorder_not_allowed`, `tasks_task_not_found`,
 *          `tasks_parent_not_found`, `tasks_comment_not_found`,
 *          `tasks_category_not_found`, `tasks_tag_not_found`, `category_exists`,
 *          `category_in_use`, `category_last`, `stale`/`out_of_range` at the
 *          check, `display_action`, `cross_module_access`,
 *          `DOCUMENT_DELETE_IN_PROGRESS`, `admin_required`), a non-member or an
 *          unknown person at `assigned_to`, `done_by_user_id` and
 *          `rotation_pool`, the RRULE rule, an unknown category, a title or a
 *          comment empty after trimming, a rotation without recurrence or with
 *          a pool below two, an unknown or a subtask parent, a read-only or a
 *          disabled sync list, the reorder 404 (invisible, subtask), the
 *          points cut (`99999` -> 10000, `5.7` -> 5), every input a dropped
 *          check refused (the schema's 400 before and after), path ids `0`,
 *          `-1`, `-0` and with a leading zero - for an admin, a member, a
 *          child, a paired display and an API token without the documents
 *          scope where it makes a difference. It pins status and the WHOLE
 *          body. The expectations were written before the refactor
 *          (bdf485f4c) and are literal values in
 *          test/task-answers-expected.js, no fixture file, no update mode.
 *
 *          No network: the CalDAV account of the sync lists points at an
 *          address that is never asked (every sync target in the table is
 *          refused before anything is pushed, and no task here is mirrored
 *          except the foreign series, which every write refuses first).
 *          SQLite stamps rows with its own clock, which mock.timers does not
 *          reach: test triggers pin `created_at`, other stamps are masked.
 *          The clock stands still (`mock.timers`, 18.11.2026 12:00 UTC), the
 *          household lives in Europe/Berlin.
 *
 *          (2) An unexpected error in each of the 32 routes reaches the
 *          central error handler - 500 with its fixed sentence and its log
 *          line `Unhandled error: <METHOD> <pattern> -> 500` - and the router
 *          keeps answering; `GET /sync-targets` among them, whose own
 *          sentence was `Failed to list sync targets.`. The handlers are
 *          synchronous (no promise to reject). `PUT /{id}/documents` keeps its
 *          409 and its 403 (handled in its catch) and rethrows the rest.
 *
 *          (3) Each handler alone (without `validateRequest()`) keeps the type
 *          checks in front of a loop, `.length` or a string method on the raw
 *          value (sink, not route).
 * Run: npm run test:task-answers
 */

process.env.SESSION_SECRET = 'task-answers-secret';
process.env.DB_PATH = ':memory:';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { createTasksApp } from './tasks-app.js';
import { EXPECTED, CHANGED } from './task-answers-expected.js';

const dbmod = await import('../server/db.js');
const { DISPLAY_SCOPES } = await import('../server/services/display-accounts.js');
const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
const { resolveRequestModuleAccess } = await import('../server/authorize/index.ts');
const database = () => dbmod.get();

/** @param {string} key @param {string} value */
function setConfig(key, value) {
  database().prepare('INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
setConfig('household_timezone', 'Europe/Berlin');
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });
const FROZEN = '2026-11-18T12:00';

// SQLite stamps rows with its own clock, which mock.timers does not reach.
const STAMP = '2026-11-18T12:00:00Z';
for (const { name } of database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'search_index%'").all()) {
  const columns = database().prepare(`PRAGMA table_info(${name})`).all().map((/** @type {any} */ c) => c.name);
  if (!columns.includes('created_at')) continue;
  database().exec(`CREATE TRIGGER test_pin_${name}_created_at AFTER INSERT ON ${name} FOR EACH ROW BEGIN UPDATE ${name} SET created_at = '${STAMP}' WHERE rowid = NEW.rowid; END;`);
}

// ── People ───────────────────────────────────────────────────────────────────
/** @param {string} username @param {string} role @param {string} [familyRole] */
function user(username, role, familyRole = 'parent') {
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role, avatar_color) VALUES (?, ?, 'x', ?, ?, '#336699')")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const MEM = user('tom', 'member');
const MEM2 = user('ida', 'member');
const KID = user('kim', 'member', 'child');
const DISPLAY = user('wand', 'member', 'other');
const GUEST = user('gast', 'member', 'other');
database().prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(DISPLAY, ADMIN);
// A split-expense guest: a users row that is no household member.
const GROUP = Number(database().prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(ADMIN).lastInsertRowid);
database().prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(GUEST, GROUP, ADMIN);
// The household order is not the child's (R23): the capability is off.
database().prepare(`INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
  VALUES ('user', ?, 'capability', 'tasks_reorder_family', 'none')`).run(String(KID));
const NOBODY = 999;

/** @type {Record<string, { id: number, role: string, method?: string, scopes?: string[] | null }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  mem2: { id: MEM2, role: 'member' },
  kid: { id: KID, role: 'member' },
  display: { id: DISPLAY, role: 'member', method: 'display', scopes: [...DISPLAY_SCOPES] },
  // An API token of a member without the documents scope.
  token: { id: MEM, role: 'member', method: 'api_token', scopes: ['tasks:read', 'tasks:write'] },
};

// ── Stored rows ──────────────────────────────────────────────────────────────
/** A task stored by hand. @param {Record<string, unknown>} [over] */
function task(over = {}) {
  const row = {
    title: 'Aufgabe', description: null, category: 'misc', status: 'open', created_by: ADMIN, visibility: 'all', locked: 0,
    parent_task_id: null, is_recurring: 0, recurrence_rule: null, due_date: null, external_source: 'local', external_rrule: null,
    points: 0, ...over,
  };
  return Number(database().prepare(`INSERT INTO tasks (title, description, category, priority, status, created_by, visibility, locked,
      parent_task_id, is_recurring, recurrence_rule, due_date, external_source, external_rrule, points)
    VALUES (@title, @description, @category, 'none', @status, @created_by, @visibility, @locked,
      @parent_task_id, @is_recurring, @recurrence_rule, @due_date, @external_source, @external_rrule, @points)`).run(row).lastInsertRowid);
}
const T1 = task({ title: 'Wäsche' });
const TSUB = task({ title: 'Socken', parent_task_id: T1 });
const TPRIV = task({ title: 'Privat', visibility: 'private' });
const TLOCK = task({ title: 'Vor dem Abendessen', locked: 1 });
const TLSUB = task({ title: 'Tisch decken', parent_task_id: TLOCK });
const TREC = task({ title: 'Müll', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', due_date: '2026-11-18' });
const TFOREIGN = task({ title: 'Fremde Serie', external_source: 'caldav', external_rrule: 'FREQ=DAILY;BYSETPOS=1' });
const TCHECK = task({ title: 'Liste', description: '- [ ] Brot\n- [x] Milch' });
const TDEL = task({ title: 'Weg damit' });
const TDEL0 = task({ title: 'Weg mit Null' });
// A task on 10000 points, for the rebase rows.
task({ title: 'Punkte', points: 10000 });
database().prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(T1, MEM);
database().prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(MEM, T1);
const COMMENT = Number(database().prepare('INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, ?, ?)').run(T1, MEM, 'Erster').lastInsertRowid);
const COMMENT2 = Number(database().prepare('INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, ?, ?)').run(T1, MEM, 'Zweiter').lastInsertRowid);
/** @param {string} visibility */
function documentRow(visibility) {
  return Number(database().prepare(`INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES (?, 'file.pdf', 'application/pdf', 10, ?, 'other', ?, 'active', ?)`).run(`Doc-${visibility}`, Buffer.from('bytes'), visibility, ADMIN).lastInsertRowid);
}
const DOC = documentRow('family');
const DOC_PRIV = documentRow('private');
// CalDAV: one account, never asked. A list enabled for tasks and writable, one
// read-only, one switched off, one aimed at shopping.
const ACC = Number(database().prepare("INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Familie', 'http://caldav.invalid/', 'u', 'p')").run().lastInsertRowid);
for (const [url, name, enabled, writable, target] of [['w', 'Schreibbar', 1, 1, 'tasks'], ['r', 'Nur lesen', 1, 0, 'tasks'], ['off', 'Aus', 0, 1, 'tasks'], ['s', 'Einkauf', 1, 1, 'shopping']]) {
  database().prepare('INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, writable) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ACC, `http://caldav.invalid/${url}/`, name, target, enabled, writable);
}
const LIST = (/** @type {string} */ url) => `caldav:${ACC}|http://caldav.invalid/${url}/`;

// ── The app ──────────────────────────────────────────────────────────────────
/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createTasksApp({
  log,
  // server/index.js puts the general API limiter in front; a generous one here.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = actor.method ?? 'session';
    req.authScopes = actor.scopes ?? null;
    req.session = { userId: actor.id, role: actor.role };
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
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api/v1/tasks`)));
test.after(() => { server.close(); });

// ── Requests ─────────────────────────────────────────────────────────────────
const NO_BODY = Symbol('no body');

/** @typedef {{ actor?: string, fail?: boolean }} CallOptions */

/**
 * @param {string} method
 * @param {string} route under /api/v1/tasks
 * @param {unknown} body a JSON value or NO_BODY
 * @param {CallOptions} [opts]
 * @returns {Promise<{ status: number, body: any }>}
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
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
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
  // A stamp of SQLite's own clock (the frozen and the pinned one stay).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) && !value.startsWith(FROZEN)) return '<stamp>';
  return value;
}

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (_key, v) => (typeof v === 'string' ? masked(v) : v));
}

const LONG = (/** @type {number} */ n) => 'x'.repeat(n);
const IDS = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => i + 1);
const created = (/** @type {string} */ title) => Number(/** @type {any} */ (database().prepare('SELECT id FROM tasks WHERE title = ? ORDER BY id DESC').get(title))?.id);
/** @param {boolean} on */
const docLock = (on) => () => { (on ? lockDocumentDeletes : unlockDocumentDeletes)([DOC]); };
const CHECK_BODY = { line: 0, checked: true };
const CHECK_URL = `/${TCHECK}/check`;

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ READING ════════════════════════════════════════════════════════════════
  ['categories', 'GET', '/categories', NO_BODY],
  ['categories display', 'GET', '/categories', NO_BODY, { actor: 'display' }],
  ['sync-targets', 'GET', '/sync-targets', NO_BODY],
  ['sync-targets mem', 'GET', '/sync-targets', NO_BODY, { actor: 'mem' }],
  ['sync-targets display', 'GET', '/sync-targets', NO_BODY, { actor: 'display' }],
  // A database error: the one own 500 sentence of the file (CHANGED).
  () => { database().exec('ALTER TABLE caldav_reminder_selection RENAME TO test_moved_selection'); },
  ['sync-targets database error', 'GET', '/sync-targets', NO_BODY],
  () => { database().exec('ALTER TABLE test_moved_selection RENAME TO caldav_reminder_selection'); },
  ['tags empty', 'GET', '/tags', NO_BODY],
  ['meta options', 'GET', '/meta/options', NO_BODY],
  ['meta options display', 'GET', '/meta/options', NO_BODY, { actor: 'display' }],
  ['list', 'GET', '/', NO_BODY],
  ['list mem', 'GET', '/', NO_BODY, { actor: 'mem' }],
  ['list display', 'GET', '/', NO_BODY, { actor: 'display' }],
  ['list token', 'GET', '/', NO_BODY, { actor: 'token' }],
  ['list two statuses', 'GET', '/?status=open&status=done', NO_BODY],
  ['list status unknown', 'GET', '/?status=nope', NO_BODY],
  ['list status archived', 'GET', '/?status=archived', NO_BODY],
  ['list archived only', 'GET', '/?archived=only', NO_BODY],
  ['list archived 1', 'GET', '/?archived=1', NO_BODY],
  ['list priority', 'GET', '/?priority=high&priority=none', NO_BODY],
  ['list assignee', 'GET', `/?assigned_to=${MEM}`, NO_BODY],
  ['list assignee text', 'GET', '/?assigned_to=abc', NO_BODY],
  ['list assignee zero', 'GET', '/?assigned_to=0', NO_BODY],
  ['list categories', 'GET', '/?category=misc&category=household', NO_BODY],
  ['list future', 'GET', '/?include_future=1', NO_BODY],
  ['list tag none', 'GET', '/?tag=Garten', NO_BODY],
  ['one', 'GET', `/${T1}`, NO_BODY],
  ['one mem', 'GET', `/${T1}`, NO_BODY, { actor: 'mem' }],
  ['one display', 'GET', `/${T1}`, NO_BODY, { actor: 'display' }],
  ['one token', 'GET', `/${T1}`, NO_BODY, { actor: 'token' }],
  ['one private mem', 'GET', `/${TPRIV}`, NO_BODY, { actor: 'mem' }],
  ['one private display', 'GET', `/${TPRIV}`, NO_BODY, { actor: 'display' }],
  ['one subtask', 'GET', `/${TSUB}`, NO_BODY],
  ['one unknown', 'GET', '/999999', NO_BODY],
  ['one id 0', 'GET', '/0', NO_BODY],
  ['one id -1', 'GET', '/-1', NO_BODY],
  ['one id -0', 'GET', '/-0', NO_BODY],
  ['one id leading zero', 'GET', `/00${T1}`, NO_BODY],
  ['one id text', 'GET', '/abc', NO_BODY],
  ['one id fraction', 'GET', `/${T1}.0`, NO_BODY],
  ['one id exponent', 'GET', '/1e0', NO_BODY],
  ['completions', 'GET', '/completions', NO_BODY],
  ['completions limit', 'GET', '/completions?limit=5', NO_BODY],
  ['completions limit 0', 'GET', '/completions?limit=0', NO_BODY],
  ['completions limit 201', 'GET', '/completions?limit=201', NO_BODY],
  ['completions limit text', 'GET', '/completions?limit=abc', NO_BODY],
  ['completions user text', 'GET', '/completions?user_id=abc', NO_BODY],
  ['completions before id text', 'GET', '/completions?before_id=x', NO_BODY],
  ['completions display', 'GET', '/completions', NO_BODY, { actor: 'display' }],
  ['task completions', 'GET', `/${T1}/completions`, NO_BODY],
  ['task completions limit 101', 'GET', `/${T1}/completions?limit=101`, NO_BODY],
  ['task completions private mem', 'GET', `/${TPRIV}/completions`, NO_BODY, { actor: 'mem' }],
  ['task completions id 0', 'GET', '/0/completions', NO_BODY],
  ['task completions id -1', 'GET', '/-1/completions', NO_BODY],
  ['task completions id -0', 'GET', '/-0/completions', NO_BODY],
  ['task completions leading zero', 'GET', `/0${T1}/completions`, NO_BODY],
  ['documents', 'GET', `/${T1}/documents`, NO_BODY],
  ['documents token', 'GET', `/${T1}/documents`, NO_BODY, { actor: 'token' }],
  ['documents private mem', 'GET', `/${TPRIV}/documents`, NO_BODY, { actor: 'mem' }],
  ['documents display', 'GET', `/${T1}/documents`, NO_BODY, { actor: 'display' }],
  ['documents id 0', 'GET', '/0/documents', NO_BODY],
  ['documents id -0', 'GET', '/-0/documents', NO_BODY],
  ['documents leading zero', 'GET', `/0${T1}/documents`, NO_BODY],
  ['comments', 'GET', `/${T1}/comments`, NO_BODY],
  ['comments display', 'GET', `/${T1}/comments`, NO_BODY, { actor: 'display' }],
  ['comments private mem', 'GET', `/${TPRIV}/comments`, NO_BODY, { actor: 'mem' }],
  ['comments id -1', 'GET', '/-1/comments', NO_BODY],
  ['comments leading zero', 'GET', `/0${T1}/comments`, NO_BODY],

  // ══ CREATE (POST /) ════════════════════════════════════════════════════════
  ['create', 'POST', '/', { title: '  Neu  ', description: '  Text  ', priority: 'high', category: 'household', due_date: '2026-11-20', due_time: '08:30', assigned_to: [MEM, ADMIN], tags: ['Garten', 'Haus, Hof'] }],
  ['create minimal', 'POST', '/', { title: 'Minimal' }],
  ['create form', 'POST', '/', { title: 'Formular', description: null, priority: '', category: '', start_date: null, due_date: null, due_time: null, assigned_to: null, is_recurring: 0, recurrence_rule: null, recurrence_from_completion: 0, points: null, visibility: 'all', countdown: 1, locked: 0, sync_target: '', tags: 'a, b' }],
  ['create done', 'POST', '/', { title: 'Schon erledigt', status: 'done' }],
  ['create archived status', 'POST', '/', { title: 'Abgelegt angelegt', status: 'archived' }],
  ['create status null', 'POST', '/', { title: 'Status null', status: null }],
  ['create status empty', 'POST', '/', { title: 'x', status: '' }],
  ['create status unknown', 'POST', '/', { title: 'x', status: 'nope' }],
  ['create no title', 'POST', '/', {}],
  ['create no body', 'POST', '/', NO_BODY],
  ['create title empty', 'POST', '/', { title: '' }],
  ['create title spaces', 'POST', '/', { title: '   ' }],
  ['create title number', 'POST', '/', { title: 5 }],
  ['create title null', 'POST', '/', { title: null }],
  ['create title list', 'POST', '/', { title: ['x'] }],
  ['create title 201', 'POST', '/', { title: LONG(201) }],
  ['create title 200', 'POST', '/', { title: LONG(200) }],
  ['create title 200 padded', 'POST', '/', { title: ` ${LONG(198)} ` }],
  ['create description 5001', 'POST', '/', { title: 'x', description: LONG(5001) }],
  ['create description number', 'POST', '/', { title: 'x', description: 5 }],
  ['create description spaces', 'POST', '/', { title: 'Leere Beschreibung', description: '   ' }],
  ['create priority unknown', 'POST', '/', { title: 'x', priority: 'sofort' }],
  ['create priority number', 'POST', '/', { title: 'x', priority: 1 }],
  ['create priority null', 'POST', '/', { title: 'x', priority: null }],
  ['create category unknown', 'POST', '/', { title: 'x', category: 'nope' }],
  ['create category number', 'POST', '/', { title: 'x', category: 5 }],
  ['create category null', 'POST', '/', { title: 'x', category: null }],
  ['create date invalid', 'POST', '/', { title: 'x', due_date: '2026-02-30' }],
  ['create date leap', 'POST', '/', { title: 'Schalttag', due_date: '2028-02-29' }],
  ['create date year 50', 'POST', '/', { title: 'x', due_date: '0050-01-01' }],
  ['create date format', 'POST', '/', { title: 'x', start_date: '18.11.2026' }],
  ['create date empty', 'POST', '/', { title: 'x', start_date: '' }],
  ['create date number', 'POST', '/', { title: 'x', due_date: 20261118 }],
  ['create time invalid', 'POST', '/', { title: 'x', due_time: '25:00' }],
  ['create time seconds', 'POST', '/', { title: 'x', due_time: '08:30:00' }],
  ['create time empty', 'POST', '/', { title: 'x', due_time: '' }],
  ['create rrule invalid', 'POST', '/', { title: 'x', recurrence_rule: 'FREQ=HOURLY' }],
  ['create rrule 301', 'POST', '/', { title: 'x', recurrence_rule: `FREQ=DAILY;${LONG(290)}` }],
  ['create recurring', 'POST', '/', { title: 'Jede Woche', is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', due_date: '2026-11-23' }],
  ['create errors joined', 'POST', '/', { title: '  ', category: 'nope', recurrence_rule: 'FREQ=HOURLY' }],
  ['create points cut', 'POST', '/', { title: 'Viele Punkte', points: 99999 }],
  ['create points fraction', 'POST', '/', { title: 'Bruch', points: 5.7 }],
  ['create points negative', 'POST', '/', { title: 'Minus', points: -3 }],
  ['create points null', 'POST', '/', { title: 'Null Punkte', points: null }],
  ['create points text', 'POST', '/', { title: 'x', points: '5' }],
  ['create points bool', 'POST', '/', { title: 'x', points: true }],
  ['create flag text', 'POST', '/', { title: 'x', is_recurring: 'false' }],
  ['create visibility unknown', 'POST', '/', { title: 'x', visibility: 'x' }],
  ['create private', 'POST', '/', { title: 'Nur ich', visibility: 'private' }],
  ['create tags number', 'POST', '/', { title: 'x', tags: 5 }],
  ['create tags list number', 'POST', '/', { title: 'x', tags: [5] }],
  ['create assignee guest', 'POST', '/', { title: 'x', assigned_to: [GUEST] }],
  ['create assignee display', 'POST', '/', { title: 'x', assigned_to: DISPLAY }],
  ['create assignee unknown', 'POST', '/', { title: 'x', assigned_to: [NOBODY] }],
  ['create assignee text', 'POST', '/', { title: 'x', assigned_to: '2' }],
  ['create assignee twice', 'POST', '/', { title: 'x', assigned_to: [MEM, MEM] }],
  ['create assignee single', 'POST', '/', { title: 'Einzeln', assigned_to: MEM2 }],
  ['create rotation without recurrence', 'POST', '/', { title: 'x', rotation_mode: 'round_robin', rotation_pool: [MEM, MEM2] }],
  ['create rotation pool of one', 'POST', '/', { title: 'x', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', rotation_mode: 'round_robin', rotation_pool: [MEM] }],
  ['create rotation no pool', 'POST', '/', { title: 'x', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', rotation_mode: 'round_robin' }],
  ['create rotation guest', 'POST', '/', { title: 'x', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', rotation_mode: 'round_robin', rotation_pool: [MEM, GUEST] }],
  ['create rotation unknown', 'POST', '/', { title: 'x', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', rotation_mode: 'round_robin', rotation_pool: [MEM, NOBODY] }],
  ['create rotation mode unknown', 'POST', '/', { title: 'x', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', rotation_mode: 'random', rotation_pool: [MEM, MEM2] }],
  ['create rotation pool text', 'POST', '/', { title: 'x', rotation_pool: 'x' }],
  ['create rotation pool zero', 'POST', '/', { title: 'x', rotation_pool: [0] }],
  ['create rotation pool 11', 'POST', '/', { title: 'x', rotation_pool: IDS(11) }],
  ['create rotation', 'POST', '/', { title: 'Reihum', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', due_date: '2026-11-20', rotation_mode: 'round_robin', rotation_pool: [MEM2, MEM] }],
  ['create subtask', 'POST', '/', { title: 'Unterpunkt', parent_task_id: T1, sync_target: LIST('r') }],
  ['create subtask of subtask', 'POST', '/', { title: 'x', parent_task_id: TSUB }],
  ['create parent unknown', 'POST', '/', { title: 'x', parent_task_id: 999999 }],
  ['create parent private mem', 'POST', '/', { title: 'x', parent_task_id: TPRIV }, { actor: 'mem' }],
  ['create parent locked mem', 'POST', '/', { title: 'x', parent_task_id: TLOCK }, { actor: 'mem' }],
  ['create parent locked admin', 'POST', '/', { title: 'Admin darf', parent_task_id: TLOCK }],
  ['create parent zero', 'POST', '/', { title: 'x', parent_task_id: 0 }],
  ['create parent text', 'POST', '/', { title: 'x', parent_task_id: '1' }],
  ['create sync read-only', 'POST', '/', { title: 'x', sync_target: LIST('r') }],
  ['create sync off', 'POST', '/', { title: 'x', sync_target: LIST('off') }],
  ['create sync shopping', 'POST', '/', { title: 'x', sync_target: LIST('s') }],
  ['create sync google', 'POST', '/', { title: 'x', sync_target: 'google:primary' }],
  ['create sync garbage', 'POST', '/', { title: 'x', sync_target: 'garbage' }],
  ['create sync number', 'POST', '/', { title: 'x', sync_target: 5 }],
  ['create sync null', 'POST', '/', { title: 'Nur lokal', sync_target: null }],
  ['create locked', 'POST', '/', { title: 'Gesperrt neu', locked: true }, { actor: 'mem' }],
  ['create kid', 'POST', '/', { title: 'Kind legt an' }, { actor: 'kid' }],

  // ══ UPDATE (PUT /{id}) ═════════════════════════════════════════════════════
  ['update', 'PUT', `/${T1}`, { title: 'Wäsche waschen', description: ' - [ ] Weiß ', priority: 'medium', points: 3, tags: ['Garten'] }],
  ['update empty body', 'PUT', `/${T1}`, {}],
  ['update no body', 'PUT', `/${T1}`, NO_BODY],
  ['update title spaces', 'PUT', `/${T1}`, { title: '   ' }],
  ['update title empty', 'PUT', `/${T1}`, { title: '' }],
  ['update title number', 'PUT', `/${T1}`, { title: 5 }],
  ['update title null', 'PUT', `/${T1}`, { title: null }],
  ['update description 5001', 'PUT', `/${T1}`, { description: LONG(5001) }],
  ['update description null', 'PUT', `/${T1}`, { description: null }],
  ['update priority unknown', 'PUT', `/${T1}`, { priority: 'x' }],
  ['update priority empty', 'PUT', `/${T1}`, { priority: '' }],
  ['update status unknown', 'PUT', `/${T1}`, { status: 'x' }],
  ['update status null', 'PUT', `/${T1}`, { status: null }],
  ['update status empty', 'PUT', `/${T1}`, { status: '' }],
  ['update category unknown', 'PUT', `/${T1}`, { category: 'nope' }],
  ['update category empty', 'PUT', `/${T1}`, { category: '' }],
  ['update date invalid', 'PUT', `/${T1}`, { start_date: '2026-13-01' }],
  ['update date year 50', 'PUT', `/${T1}`, { start_date: '0050-06-01' }],
  ['update time invalid', 'PUT', `/${T1}`, { due_time: '8:30' }],
  ['update rrule invalid', 'PUT', `/${T1}`, { recurrence_rule: 'BOGUS' }],
  ['update points cut', 'PUT', `/${T1}`, { points: 1e9 }],
  ['update points null', 'PUT', `/${T1}`, { points: null }],
  ['update points text', 'PUT', `/${T1}`, { points: '' }],
  ['update flag null', 'PUT', `/${T1}`, { countdown: null }],
  ['update assignee guest', 'PUT', `/${T1}`, { assigned_to: [MEM, GUEST] }],
  ['update assignee unknown', 'PUT', `/${T1}`, { assigned_to: NOBODY }],
  ['update assignee none', 'PUT', `/${T1}`, { assigned_to: null }],
  ['update assignee back', 'PUT', `/${T1}`, { assigned_to: [MEM] }],
  ['update rotation without recurrence', 'PUT', `/${T1}`, { rotation_mode: 'round_robin', rotation_pool: [MEM, MEM2] }],
  ['update rotation pool text', 'PUT', `/${T1}`, { rotation_pool: 'x' }],
  ['update rotation on series', 'PUT', `/${TREC}`, { rotation_mode: 'round_robin', rotation_pool: [MEM, MEM2] }],
  ['update rotation pool of one', 'PUT', `/${TREC}`, { rotation_pool: [MEM] }],
  ['update rotation off', 'PUT', `/${TREC}`, { rotation_mode: null }],
  ['update sync read-only', 'PUT', `/${T1}`, { sync_target: LIST('r') }],
  ['update sync off', 'PUT', `/${T1}`, { sync_target: LIST('off') }],
  ['update sync local', 'PUT', `/${T1}`, { sync_target: '' }],
  ['update visibility unknown', 'PUT', `/${T1}`, { visibility: 'x' }],
  ['update unknown', 'PUT', '/999999', { title: 'x' }],
  ['update unknown bad body', 'PUT', '/999999', { title: 5 }],
  ['update private mem', 'PUT', `/${TPRIV}`, { title: 'x' }, { actor: 'mem' }],
  ['update locked mem title', 'PUT', `/${TLOCK}`, { title: 'Anders' }, { actor: 'mem' }],
  ['update locked mem unlock', 'PUT', `/${TLOCK}`, { locked: 0 }, { actor: 'mem' }],
  ['update locked mem own assignee', 'PUT', `/${TLOCK}`, { assigned_to: [MEM] }, { actor: 'mem' }],
  ['update locked mem status', 'PUT', `/${TLOCK}`, { status: 'in_progress' }, { actor: 'mem' }],
  ['update locked subtask mem', 'PUT', `/${TLSUB}`, { title: 'Anders' }, { actor: 'mem' }],
  ['update locked kid status back', 'PUT', `/${TLOCK}`, { status: 'open' }, { actor: 'kid' }],
  ['update locked admin', 'PUT', `/${TLOCK}`, { description: 'Admin schreibt' }],
  ['update foreign done', 'PUT', `/${TFOREIGN}`, { status: 'done' }],
  ['update foreign in progress', 'PUT', `/${TFOREIGN}`, { status: 'in_progress' }],
  ['update series done', 'PUT', `/${TREC}`, { status: 'done' }],
  ['update id 0', 'PUT', '/0', { title: 'x' }],
  ['update id -1', 'PUT', '/-1', { title: 'x' }],
  ['update id -0', 'PUT', '/-0', { title: 'x' }],
  ['update id leading zero', 'PUT', `/0${T1}`, { title: 'Mit Null' }],
  ['update id fraction', 'PUT', `/${T1}.0`, { title: 'x' }],

  // ══ STATUS (PATCH /{id}/status) ════════════════════════════════════════════
  ['status in progress', 'PATCH', `/${T1}/status`, { status: 'in_progress' }],
  ['status unknown', 'PATCH', `/${T1}/status`, { status: 'x' }],
  ['status missing', 'PATCH', `/${T1}/status`, {}],
  ['status null', 'PATCH', `/${T1}/status`, { status: null }],
  ['status empty', 'PATCH', `/${T1}/status`, { status: '' }],
  ['status number', 'PATCH', `/${T1}/status`, { status: 1 }],
  ['status no body', 'PATCH', `/${T1}/status`, NO_BODY],
  ['status unknown task', 'PATCH', '/999999/status', { status: 'done' }],
  ['status unknown task bad status', 'PATCH', '/999999/status', { status: 'x' }],
  ['status private mem', 'PATCH', `/${TPRIV}/status`, { status: 'done' }, { actor: 'mem' }],
  ['status done by guest', 'PATCH', `/${T1}/status`, { status: 'done', done_by_user_id: GUEST }],
  ['status done by unknown', 'PATCH', `/${T1}/status`, { status: 'done', done_by_user_id: NOBODY }],
  ['status done by text', 'PATCH', `/${T1}/status`, { status: 'done', done_by_user_id: 'x' }],
  ['status done by zero', 'PATCH', `/${T1}/status`, { status: 'done', done_by_user_id: 0 }],
  ['status done by empty', 'PATCH', `/${T1}/status`, { status: 'done', done_by_user_id: '' }],
  ['status open done by guest', 'PATCH', `/${T1}/status`, { status: 'open', done_by_user_id: GUEST }],
  ['status done by mem2', 'PATCH', `/${T1}/status`, { status: 'done', done_by_user_id: MEM2 }],
  ['status done again', 'PATCH', `/${T1}/status`, { status: 'done', done_by_user_id: GUEST }],
  ['status reopen', 'PATCH', `/${T1}/status`, { status: 'open' }],
  ['status locked mem done', 'PATCH', `/${TLOCK}/status`, { status: 'done' }, { actor: 'mem' }],
  ['status foreign done', 'PATCH', `/${TFOREIGN}/status`, { status: 'done' }],
  ['status foreign archived', 'PATCH', `/${TFOREIGN}/status`, { status: 'archived' }],
  ['status series done', 'PATCH', () => `/${created('Jede Woche')}/status`, { status: 'done' }],
  ['status display done', 'PATCH', `/${T1}/status`, { status: 'done', done_by_user_id: MEM }, { actor: 'display' }],
  ['status display open', 'PATCH', `/${T1}/status`, { status: 'open', done_by_user_id: MEM }, { actor: 'display' }],
  ['status display no person', 'PATCH', `/${TCHECK}/status`, { status: 'done' }, { actor: 'display' }],
  ['status display guest', 'PATCH', `/${TCHECK}/status`, { status: 'done', done_by_user_id: GUEST }, { actor: 'display' }],
  ['status display private', 'PATCH', `/${TPRIV}/status`, { status: 'done', done_by_user_id: MEM }, { actor: 'display' }],
  ['status display private open', 'PATCH', `/${TPRIV}/status`, { status: 'open' }, { actor: 'display' }],
  ['status display archived', 'PATCH', `/${TCHECK}/status`, { status: 'archived', done_by_user_id: MEM }, { actor: 'display' }],
  ['status reopen after display', 'PATCH', `/${T1}/status`, { status: 'open' }],
  ['status id 0', 'PATCH', '/0/status', { status: 'done' }],
  ['status id -1', 'PATCH', '/-1/status', { status: 'done' }],
  ['status id -0', 'PATCH', '/-0/status', { status: 'done' }],
  ['status id leading zero', 'PATCH', `/0${T1}/status`, { status: 'in_progress' }],
  ['status archived', 'PATCH', () => `/${created('Minimal')}/status`, { status: 'archived' }],

  // ══ ARCHIVE (PATCH /{id}/archive) ══════════════════════════════════════════
  ['archive', 'PATCH', () => `/${created('Formular')}/archive`, { archived: true }],
  ['archive restore', 'PATCH', () => `/${created('Formular')}/archive`, { archived: false }],
  ['archive no body', 'PATCH', () => `/${created('Formular')}/archive`, NO_BODY],
  ['archive empty body', 'PATCH', () => `/${created('Formular')}/archive`, {}],
  ['archive text', 'PATCH', () => `/${created('Formular')}/archive`, { archived: 'x' }],
  ['archive zero', 'PATCH', () => `/${created('Formular')}/archive`, { archived: 0 }],
  ['archive null', 'PATCH', () => `/${created('Formular')}/archive`, { archived: null }],
  ['archive unknown', 'PATCH', '/999999/archive', { archived: true }],
  ['archive unknown text', 'PATCH', '/999999/archive', { archived: 'x' }],
  ['archive private mem', 'PATCH', `/${TPRIV}/archive`, {}, { actor: 'mem' }],
  ['archive locked mem', 'PATCH', `/${TLOCK}/archive`, {}, { actor: 'mem' }],
  ['archive locked mem text', 'PATCH', `/${TLOCK}/archive`, { archived: 'x' }, { actor: 'mem' }],
  ['archive id 0', 'PATCH', '/0/archive', {}],
  ['archive id -1', 'PATCH', '/-1/archive', {}],
  ['archive id -0', 'PATCH', '/-0/archive', {}],
  ['archive id leading zero', 'PATCH', () => `/0${created('Formular')}/archive`, { archived: false }],

  // ══ CHECK (PATCH /{id}/check) ══════════════════════════════════════════════
  ['check', 'PATCH', CHECK_URL, CHECK_BODY],
  ['check again', 'PATCH', CHECK_URL, CHECK_BODY],
  ['check expect stale', 'PATCH', CHECK_URL, { line: 1, checked: false, expect: '- [ ] Milch' }],
  ['check expect right', 'PATCH', CHECK_URL, { line: 1, checked: false, expect: '- [x] Milch' }],
  ['check expect null', 'PATCH', CHECK_URL, { line: 0, checked: false, expect: null }],
  ['check out of range', 'PATCH', CHECK_URL, { line: 9, checked: true }],
  ['check line text', 'PATCH', CHECK_URL, { line: 'x', checked: true }],
  ['check line minus', 'PATCH', CHECK_URL, { line: -1, checked: true }],
  ['check line fraction', 'PATCH', CHECK_URL, { line: 0.5, checked: true }],
  ['check line missing', 'PATCH', CHECK_URL, { checked: true }],
  ['check checked text', 'PATCH', CHECK_URL, { line: 0, checked: 'yes' }],
  ['check checked missing', 'PATCH', CHECK_URL, { line: 0 }],
  ['check expect number', 'PATCH', CHECK_URL, { line: 0, checked: true, expect: 5 }],
  ['check no body', 'PATCH', CHECK_URL, NO_BODY],
  ['check no checklist', 'PATCH', `/${TREC}/check`, CHECK_BODY],
  ['check unknown', 'PATCH', '/999999/check', CHECK_BODY],
  ['check unknown bad body', 'PATCH', '/999999/check', { line: 'x' }],
  ['check private mem', 'PATCH', `/${TPRIV}/check`, CHECK_BODY, { actor: 'mem' }],
  ['check locked mem', 'PATCH', `/${TLOCK}/check`, CHECK_BODY, { actor: 'mem' }],
  ['check id 0', 'PATCH', '/0/check', CHECK_BODY],
  ['check id -1', 'PATCH', '/-1/check', CHECK_BODY],
  ['check id -0', 'PATCH', '/-0/check', CHECK_BODY],
  ['check id leading zero', 'PATCH', `/00${TCHECK}/check`, { line: 0, checked: false }],

  // ══ DOCUMENTS (PUT /{id}/documents) ════════════════════════════════════════
  ['link', 'PUT', `/${T1}/documents`, { document_ids: [DOC, DOC_PRIV] }],
  ['link mem private invisible', 'PUT', `/${T1}/documents`, { document_ids: [DOC_PRIV] }, { actor: 'mem' }],
  ['link empty', 'PUT', `/${TREC}/documents`, { document_ids: [] }],
  ['link text', 'PUT', `/${T1}/documents`, { document_ids: 'x' }],
  ['link zero', 'PUT', `/${T1}/documents`, { document_ids: [0] }],
  ['link no body', 'PUT', `/${T1}/documents`, NO_BODY],
  docLock(true),
  ['link while deleting', 'PUT', `/${T1}/documents`, { document_ids: [DOC] }],
  docLock(false),
  ['link token', 'PUT', `/${T1}/documents`, { document_ids: [DOC] }, { actor: 'token' }],
  ['link token empty', 'PUT', `/${T1}/documents`, { document_ids: [] }, { actor: 'token' }],
  ['link token none', 'PUT', `/${T1}/documents`, {}, { actor: 'token' }],
  ['link unknown', 'PUT', '/999999/documents', { document_ids: [DOC] }],
  ['link private mem', 'PUT', `/${TPRIV}/documents`, { document_ids: [] }, { actor: 'mem' }],
  ['link locked mem', 'PUT', `/${TLOCK}/documents`, { document_ids: [DOC] }, { actor: 'mem' }],
  ['link id 0', 'PUT', '/0/documents', { document_ids: [] }],
  ['link id -1', 'PUT', '/-1/documents', { document_ids: [] }],
  ['link id leading zero', 'PUT', `/0${TREC}/documents`, { document_ids: [DOC] }],
  ['one with documents', 'GET', `/${T1}`, NO_BODY],

  // ══ COMMENTS ═══════════════════════════════════════════════════════════════
  ['comment', 'POST', `/${T1}/comments`, { comment: '  Mache ich  ' }, { actor: 'mem2' }],
  ['comment empty', 'POST', `/${T1}/comments`, { comment: '' }],
  ['comment spaces', 'POST', `/${T1}/comments`, { comment: '   ' }],
  ['comment 5001', 'POST', `/${T1}/comments`, { comment: LONG(5001) }],
  ['comment number', 'POST', `/${T1}/comments`, { comment: 5 }],
  ['comment missing', 'POST', `/${T1}/comments`, {}],
  ['comment no body', 'POST', `/${T1}/comments`, NO_BODY],
  ['comment unknown task', 'POST', '/999999/comments', { comment: 'x' }],
  ['comment private mem', 'POST', `/${TPRIV}/comments`, { comment: 'x' }, { actor: 'mem' }],
  ['comment locked kid', 'POST', `/${TLOCK}/comments`, { comment: 'Darf ich' }, { actor: 'kid' }],
  ['comment id 0', 'POST', '/0/comments', { comment: 'x' }],
  ['comment id -0', 'POST', '/-0/comments', { comment: 'x' }],
  ['comment id leading zero', 'POST', `/0${T1}/comments`, { comment: 'Mit Null' }],
  ['comment edit', 'PATCH', `/${T1}/comments/${COMMENT}`, { comment: ' Geändert ' }, { actor: 'mem' }],
  ['comment edit spaces', 'PATCH', `/${T1}/comments/${COMMENT}`, { comment: '  ' }, { actor: 'mem' }],
  ['comment edit number', 'PATCH', `/${T1}/comments/${COMMENT}`, { comment: 5 }, { actor: 'mem' }],
  ['comment edit foreign', 'PATCH', `/${T1}/comments/${COMMENT}`, { comment: 'x' }, { actor: 'mem2' }],
  ['comment edit foreign bad body', 'PATCH', `/${T1}/comments/${COMMENT}`, { comment: 5 }, { actor: 'mem2' }],
  ['comment edit admin', 'PATCH', `/${T1}/comments/${COMMENT}`, { comment: 'x' }],
  ['comment edit unknown comment', 'PATCH', `/${T1}/comments/999999`, { comment: 'x' }, { actor: 'mem' }],
  ['comment edit other task', 'PATCH', `/${TREC}/comments/${COMMENT}`, { comment: 'x' }, { actor: 'mem' }],
  ['comment edit private task', 'PATCH', `/${TPRIV}/comments/${COMMENT}`, { comment: 'x' }, { actor: 'mem' }],
  ['comment edit comment id 0', 'PATCH', `/${T1}/comments/0`, { comment: 'x' }, { actor: 'mem' }],
  ['comment edit comment id -1', 'PATCH', `/${T1}/comments/-1`, { comment: 'x' }, { actor: 'mem' }],
  ['comment edit comment id -0', 'PATCH', `/${T1}/comments/-0`, { comment: 'x' }, { actor: 'mem' }],
  ['comment edit comment leading zero', 'PATCH', `/${T1}/comments/0${COMMENT}`, { comment: 'Null davor' }, { actor: 'mem' }],
  ['comment edit comment id text', 'PATCH', `/${T1}/comments/x`, { comment: 'x' }, { actor: 'mem' }],
  ['comment delete foreign', 'DELETE', `/${T1}/comments/${COMMENT}`, NO_BODY, { actor: 'mem2' }],
  ['comment delete id -1', 'DELETE', `/${T1}/comments/-1`, NO_BODY],
  ['comment delete leading zero', 'DELETE', `/0${T1}/comments/0${COMMENT2}`, NO_BODY, { actor: 'mem' }],
  ['comment delete admin', 'DELETE', `/${T1}/comments/${COMMENT}`, NO_BODY],
  ['comment delete gone', 'DELETE', `/${T1}/comments/${COMMENT}`, NO_BODY],
  ['comments after', 'GET', `/${T1}/comments`, NO_BODY],

  // ══ TAGS ═══════════════════════════════════════════════════════════════════
  ['tags', 'GET', '/tags', NO_BODY],
  ['tags display', 'GET', '/tags', NO_BODY, { actor: 'display' }],
  ['apply', 'POST', '/tags/apply', { ids: [T1, TREC, TPRIV], add: ['Bad'], remove: 'Garten' }],
  ['apply mem locked skipped', 'POST', '/tags/apply', { ids: [T1, TLOCK, TPRIV], add: 'Wichtig' }, { actor: 'mem' }],
  ['apply ids repeat', 'POST', '/tags/apply', { ids: [T1, T1], add: ['Bad'] }],
  ['apply nothing', 'POST', '/tags/apply', { ids: [T1], add: [], remove: ' , ' }],
  ['apply nothing given', 'POST', '/tags/apply', { ids: [T1] }],
  ['apply ids empty', 'POST', '/tags/apply', { ids: [], add: ['x'] }],
  ['apply ids missing', 'POST', '/tags/apply', { add: ['x'] }],
  ['apply ids text', 'POST', '/tags/apply', { ids: 'x', add: ['x'] }],
  ['apply ids text items', 'POST', '/tags/apply', { ids: ['1'], add: ['x'] }],
  ['apply ids fraction', 'POST', '/tags/apply', { ids: [1.5], add: ['x'] }],
  ['apply ids zero', 'POST', '/tags/apply', { ids: [0], add: ['x'] }],
  ['apply ids 501', 'POST', '/tags/apply', { ids: IDS(501), add: ['x'] }],
  ['apply ids 500 unknown', 'POST', '/tags/apply', { ids: IDS(500).map((n) => n + 100000), add: ['x'] }],
  ['apply add number', 'POST', '/tags/apply', { ids: [T1], add: 5 }],
  ['apply add object', 'POST', '/tags/apply', { ids: [T1], add: { a: 1 } }],
  ['apply no body', 'POST', '/tags/apply', NO_BODY],
  ['rename', 'PUT', '/tags/Bad', { name: 'Badezimmer, oben' }],
  ['rename merge', 'PUT', '/tags/Wichtig', { name: 'badezimmer, oben' }],
  ['rename empty', 'PUT', '/tags/Haus%2C%20Hof', { name: '' }],
  ['rename spaces', 'PUT', '/tags/Haus%2C%20Hof', { name: '   ' }],
  ['rename number', 'PUT', '/tags/Haus%2C%20Hof', { name: 5 }],
  ['rename missing', 'PUT', '/tags/Haus%2C%20Hof', {}],
  ['rename unknown', 'PUT', '/tags/Nirgends', { name: 'x' }],
  ['rename private mem', 'PUT', '/tags/Bad', { name: 'x' }, { actor: 'mem' }],
  ['untag unknown', 'DELETE', '/tags/Nirgends', NO_BODY],
  ['untag', 'DELETE', '/tags/Haus%2C%20Hof', NO_BODY],
  ['untag mem locked', 'DELETE', '/tags/a', NO_BODY, { actor: 'mem' }],
  ['tags after', 'GET', '/tags', NO_BODY],
  ['list tag', 'GET', '/?tag=Badezimmer%2C%20oben', NO_BODY],

  // ══ BULK ARCHIVE (POST /archive) ═══════════════════════════════════════════
  ['bulk archive', 'POST', '/archive', () => ({ ids: [created('Bruch'), created('Minus'), created('Bruch'), TPRIV] })],
  ['bulk archive mem locked', 'POST', '/archive', () => ({ ids: [TLOCK, TPRIV, created('Null Punkte')] }), { actor: 'mem' }],
  ['bulk archive again', 'POST', '/archive', () => ({ ids: [created('Bruch')] })],
  ['bulk archive empty', 'POST', '/archive', { ids: [] }],
  ['bulk archive missing', 'POST', '/archive', {}],
  ['bulk archive text', 'POST', '/archive', { ids: '1,2' }],
  ['bulk archive text items', 'POST', '/archive', { ids: ['1'] }],
  ['bulk archive 501', 'POST', '/archive', { ids: IDS(501) }],
  ['bulk archive no body', 'POST', '/archive', NO_BODY],

  // ══ ORDER (PATCH /reorder, POST /reorder/reset) ════════════════════════════
  ['reorder', 'PATCH', '/reorder', { order: [TREC, T1, TLOCK] }],
  ['reorder again', 'PATCH', '/reorder', { order: [T1, TREC] }],
  ['reorder mem', 'PATCH', '/reorder', { order: [TLOCK, T1] }, { actor: 'mem' }],
  ['reorder subtask', 'PATCH', '/reorder', { order: [T1, TSUB] }],
  ['reorder unknown', 'PATCH', '/reorder', { order: [T1, 999999] }],
  ['reorder private mem', 'PATCH', '/reorder', { order: [T1, TPRIV] }, { actor: 'mem' }],
  ['reorder empty', 'PATCH', '/reorder', { order: [] }],
  ['reorder missing', 'PATCH', '/reorder', {}],
  ['reorder text', 'PATCH', '/reorder', { order: 'x' }],
  ['reorder text items', 'PATCH', '/reorder', { order: ['1'] }],
  ['reorder bool items', 'PATCH', '/reorder', { order: [true] }],
  ['reorder fraction', 'PATCH', '/reorder', { order: [1.5] }],
  ['reorder twice', 'PATCH', '/reorder', { order: [T1, T1] }],
  ['reorder 501', 'PATCH', '/reorder', { order: IDS(501) }],
  ['reorder no body', 'PATCH', '/reorder', NO_BODY],
  ['reorder kid', 'PATCH', '/reorder', { order: [T1] }, { actor: 'kid' }],
  ['reorder kid bad body', 'PATCH', '/reorder', { order: 'x' }, { actor: 'kid' }],
  ['reset', 'POST', '/reorder/reset', { ids: [TREC] }],
  ['reset subtask', 'POST', '/reorder/reset', { ids: [TSUB] }],
  ['reset private mem', 'POST', '/reorder/reset', { ids: [TPRIV] }, { actor: 'mem' }],
  ['reset empty', 'POST', '/reorder/reset', { ids: [] }],
  ['reset twice', 'POST', '/reorder/reset', { ids: [T1, T1] }],
  ['reset text', 'POST', '/reorder/reset', { ids: 'x' }],
  ['reset 501', 'POST', '/reorder/reset', { ids: IDS(501) }],
  ['reset kid', 'POST', '/reorder/reset', { ids: [T1] }, { actor: 'kid' }],
  ['reset kid bad body', 'POST', '/reorder/reset', {}, { actor: 'kid' }],

  // ══ CATEGORIES ═════════════════════════════════════════════════════════════
  ['category create', 'POST', '/categories', { name: '  Garten  ' }],
  ['category create taken', 'POST', '/categories', { name: 'GARTEN' }],
  ['category create taken key', 'POST', '/categories', { name: 'household' }],
  ['category create empty', 'POST', '/categories', { name: '' }],
  ['category create spaces', 'POST', '/categories', { name: '   ' }],
  ['category create 101', 'POST', '/categories', { name: LONG(101) }],
  ['category create 100 padded', 'POST', '/categories', { name: ` ${LONG(100)} ` }],
  ['category create number', 'POST', '/categories', { name: 5 }],
  ['category create missing', 'POST', '/categories', {}],
  ['category create mem', 'POST', '/categories', { name: 'Keller' }, { actor: 'mem' }],
  ['category rename', 'PUT', '/categories/garten', { name: 'Garten & Hof' }],
  ['category rename taken', 'PUT', '/categories/garten', { name: 'Keller' }],
  ['category rename same', 'PUT', '/categories/garten', { name: 'garten & hof' }],
  ['category rename empty', 'PUT', '/categories/garten', { name: '' }],
  ['category rename spaces', 'PUT', '/categories/garten', { name: '  ' }],
  ['category rename 101', 'PUT', '/categories/garten', { name: LONG(101) }],
  ['category rename number', 'PUT', '/categories/garten', { name: 5 }],
  ['category rename unknown', 'PUT', '/categories/nope', { name: 'x' }],
  ['category rename unknown bad body', 'PUT', '/categories/nope', { name: 5 }],
  ['category reorder', 'PATCH', '/categories/reorder', { order: ['garten', 'misc', 'unknown'] }],
  ['category reorder empty', 'PATCH', '/categories/reorder', { order: [] }],
  ['category reorder text', 'PATCH', '/categories/reorder', { order: 'x' }],
  ['category reorder items', 'PATCH', '/categories/reorder', { order: [5, {}] }],
  ['category reorder missing', 'PATCH', '/categories/reorder', {}],
  ['category use', 'POST', '/', { title: 'Im Garten', category: 'garten' }],
  ['category in use', 'DELETE', '/categories/garten', NO_BODY],
  ['category delete unknown', 'DELETE', '/categories/nope', NO_BODY],
  ['category delete', 'DELETE', `/categories/${'keller'}`, NO_BODY],

  // ══ POINTS (admin only) ════════════════════════════════════════════════════
  ['points affected', 'GET', '/points/affected?points=10000', NO_BODY],
  ['points affected zero', 'GET', '/points/affected?points=0', NO_BODY],
  ['points affected minus', 'GET', '/points/affected?points=-1', NO_BODY],
  ['points affected above', 'GET', '/points/affected?points=10001', NO_BODY],
  ['points affected fraction', 'GET', '/points/affected?points=1.5', NO_BODY],
  ['points affected text', 'GET', '/points/affected?points=abc', NO_BODY],
  ['points affected exponent', 'GET', '/points/affected?points=1e1', NO_BODY],
  ['points affected leading zero', 'GET', '/points/affected?points=010000', NO_BODY],
  ['points affected missing', 'GET', '/points/affected', NO_BODY],
  ['points affected twice', 'GET', '/points/affected?points=1&points=2', NO_BODY],
  ['points affected mem', 'GET', '/points/affected?points=5', NO_BODY, { actor: 'mem' }],
  ['points affected mem bad', 'GET', '/points/affected?points=x', NO_BODY, { actor: 'mem' }],
  ['points affected display', 'GET', '/points/affected?points=5', NO_BODY, { actor: 'display' }],
  ['rebase same', 'POST', '/points/rebase', { from: 5, to: 5 }],
  ['rebase from zero', 'POST', '/points/rebase', { from: 0, to: 5 }],
  ['rebase to above', 'POST', '/points/rebase', { from: 5, to: 10001 }],
  ['rebase from above', 'POST', '/points/rebase', { from: 10001, to: 5 }],
  ['rebase to minus', 'POST', '/points/rebase', { from: 5, to: -1 }],
  ['rebase to null', 'POST', '/points/rebase', { from: 5, to: null }],
  ['rebase from text', 'POST', '/points/rebase', { from: '5', to: 3 }],
  ['rebase to fraction', 'POST', '/points/rebase', { from: 5, to: 2.5 }],
  ['rebase missing', 'POST', '/points/rebase', { from: 5 }],
  ['rebase no body', 'POST', '/points/rebase', NO_BODY],
  ['rebase mem', 'POST', '/points/rebase', { from: 5, to: 3 }, { actor: 'mem' }],
  ['rebase mem bad', 'POST', '/points/rebase', { from: 'x' }, { actor: 'mem' }],
  ['rebase', 'POST', '/points/rebase', { from: 10000, to: 3 }],
  ['points affected after', 'GET', '/points/affected?points=3', NO_BODY],

  // ══ DELETE (DELETE /{id}) ══════════════════════════════════════════════════
  ['delete unknown', 'DELETE', '/999999', NO_BODY],
  ['delete private mem', 'DELETE', `/${TPRIV}`, NO_BODY, { actor: 'mem' }],
  ['delete locked mem', 'DELETE', `/${TLOCK}`, NO_BODY, { actor: 'mem' }],
  ['delete locked subtask mem', 'DELETE', `/${TLSUB}`, NO_BODY, { actor: 'mem' }],
  ['delete id 0', 'DELETE', '/0', NO_BODY],
  ['delete id -1', 'DELETE', '/-1', NO_BODY],
  ['delete id -0', 'DELETE', '/-0', NO_BODY],
  ['delete id fraction', 'DELETE', `/${TDEL}.0`, NO_BODY],
  ['delete', 'DELETE', `/${TDEL}`, NO_BODY],
  ['delete gone', 'DELETE', `/${TDEL}`, NO_BODY],
  ['delete id leading zero', 'DELETE', `/0${TDEL0}`, NO_BODY],

  // ══ THE LAST CATEGORY ══════════════════════════════════════════════════════
  () => {
    database().prepare("INSERT INTO task_categories (key, name, label_key, sort_order) VALUES ('solo', 'Solo', NULL, 99)").run();
    database().prepare("DELETE FROM task_categories WHERE key != 'solo'").run();
  },
  ['category last', 'DELETE', '/categories/solo', NO_BODY],
  ['list end', 'GET', '/?archived=1', NO_BODY],
];

/** @param {Record<string, { status: number, body: unknown }>} answers @param {Record<string, string[]>} logs */
async function runTable(answers, logs) {
  for (const step of STEPS) {
    if (typeof step === 'function') { step(); continue; }
    const [name, method, route, body, opts] = step;
    assert.ok(!Object.hasOwn(answers, name), `row name twice: ${name}`);
    logged.error.length = 0;
    const actual = await call(method, typeof route === 'function' ? route() : route, typeof body === 'function' ? body() : body, opts);
    answers[name] = { status: actual.status, body: normalized(actual.body) };
    if (logged.error.length) logs[name] = logged.error.splice(0);
  }
  return answers;
}

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  /** @type {Record<string, { status: number, body: unknown }>} */
  const answers = {};
  /** @type {Record<string, string[]>} */
  const logs = {};
  try {
    await runTable(answers, logs);
  } finally {
    if (process.env.TASK_ANSWERS_DUMP) fs.writeFileSync(process.env.TASK_ANSWERS_DUMP, JSON.stringify({ answers, logs }));
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
  // other row is an answer of the route itself.
  assert.deepEqual(logs, Object.fromEntries(Object.entries(CHANGED).map(([name, row]) => [name, [row.log]])), 'only these rows reached the central handler');
});

// ── Unexpected errors: the central error handler ────────────────────────────
const P = '/api/v1/tasks';

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

test('an unexpected error in each of the 32 routes is a 500 of the central handler, and the router goes on', async () => {
  logged.error.length = 0;
  const victim = task({ title: 'Opfer' });
  const subject = task({ title: 'Subjekt', description: '- [ ] a' });
  const comment = Number(database().prepare('INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, ?, ?)').run(subject, ADMIN, 'c').lastInsertRowid);
  const comment2 = Number(database().prepare('INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, ?, ?)').run(subject, ADMIN, 'd').lastInsertRowid);
  database().prepare("INSERT INTO task_categories (key, name, label_key, sort_order) VALUES ('frei', 'Frei', NULL, 5), ('frei2', 'Frei2', NULL, 6)").run();
  database().prepare("INSERT INTO task_tags (task_id, tag, tag_key) VALUES (?, 'Etikett', 'etikett')").run(subject);
  /** @type {Array<[string, string, unknown, string]>} [method, path under /api/v1/tasks, body, route pattern] */
  const rows = [
    ['GET', '/categories', NO_BODY, `${P}/categories`],
    ['GET', '/sync-targets', NO_BODY, `${P}/sync-targets`],
    ['GET', '/completions', NO_BODY, `${P}/completions`],
    ['GET', '/tags', NO_BODY, `${P}/tags`],
    ['POST', '/tags/apply', { ids: [subject], add: ['Neu'] }, `${P}/tags/apply`],
    ['POST', '/archive', { ids: [victim] }, `${P}/archive`],
    ['PUT', '/tags/Etikett', { name: 'Etikett2' }, `${P}/tags/:tag`],
    ['DELETE', '/tags/Etikett2', NO_BODY, `${P}/tags/:tag`],
    ['POST', '/categories', { name: 'Fehler' }, `${P}/categories`],
    ['PATCH', '/categories/reorder', { order: ['frei'] }, `${P}/categories/reorder`],
    ['PATCH', '/reorder', { order: [subject] }, `${P}/reorder`],
    ['POST', '/reorder/reset', { ids: [subject] }, `${P}/reorder/reset`],
    ['PUT', '/categories/frei', { name: 'Frei neu' }, `${P}/categories/:key`],
    ['DELETE', '/categories/frei2', NO_BODY, `${P}/categories/:key`],
    ['GET', '/', NO_BODY, `${P}/`],
    ['GET', `/${subject}`, NO_BODY, `${P}/:id`],
    ['POST', '/', { title: 'Fehler beim Anlegen' }, `${P}/`],
    ['PUT', `/${subject}`, { title: 'Subjekt neu' }, `${P}/:id`],
    ['PATCH', `/${subject}/status`, { status: 'in_progress' }, `${P}/:id/status`],
    ['PATCH', `/${subject}/archive`, { archived: false }, `${P}/:id/archive`],
    ['PATCH', `/${subject}/check`, { line: 0, checked: true }, `${P}/:id/check`],
    ['DELETE', `/${victim}`, NO_BODY, `${P}/:id`],
    ['GET', `/${subject}/completions`, NO_BODY, `${P}/:id/completions`],
    ['GET', `/${subject}/documents`, NO_BODY, `${P}/:id/documents`],
    ['PUT', `/${subject}/documents`, { document_ids: [DOC] }, `${P}/:id/documents`],
    ['GET', `/${subject}/comments`, NO_BODY, `${P}/:id/comments`],
    ['POST', `/${subject}/comments`, { comment: 'neu' }, `${P}/:id/comments`],
    ['PATCH', `/${subject}/comments/${comment}`, { comment: 'anders' }, `${P}/:id/comments/:commentId`],
    ['DELETE', `/${subject}/comments/${comment2}`, NO_BODY, `${P}/:id/comments/:commentId`],
    ['GET', '/meta/options', NO_BODY, `${P}/meta/options`],
    ['GET', '/points/affected?points=1', NO_BODY, `${P}/points/affected`],
    ['POST', '/points/rebase', { from: 1, to: 2 }, `${P}/points/rebase`],
  ];
  assert.equal(rows.length, 32, 'one row per route');
  for (const [method, route, body, pattern] of rows) {
    assertCentral(await call(method, route, body, { fail: true }), method, pattern);
  }
  assert.equal((await call('GET', '/categories', NO_BODY)).status, 200, 'the router answers again');
});

test('GET /sync-targets: a database error is the 500 of the central handler, not "Failed to list sync targets."', async () => {
  logged.error.length = 0;
  database().exec('ALTER TABLE caldav_reminder_selection RENAME TO test_moved_selection');
  try {
    assertCentral(await call('GET', '/sync-targets', NO_BODY), 'GET', `${P}/sync-targets`);
  } finally {
    database().exec('ALTER TABLE test_moved_selection RENAME TO caldav_reminder_selection');
  }
  assert.equal((await call('GET', '/sync-targets', NO_BODY)).status, 200, 'the route answers again');
});

test('PUT /{id}/documents keeps its 409 and its 403 out of the central handler, and a database error reaches it', async () => {
  logged.error.length = 0;
  const id = task({ title: 'Dokumente' });
  lockDocumentDeletes([DOC]);
  try {
    assert.deepEqual(await call('PUT', `/${id}/documents`, { document_ids: [DOC] }), {
      status: 409, body: { error: 'The document is currently being deleted. Try again when the operation finishes.', code: 409, reason: 'DOCUMENT_DELETE_IN_PROGRESS' },
    });
  } finally {
    unlockDocumentDeletes([DOC]);
  }
  assert.deepEqual(await call('PUT', `/${id}/documents`, { document_ids: [DOC] }, { actor: 'token' }), {
    status: 403, body: { error: 'Linking a document requires access to documents.', code: 403, reason: 'cross_module_access' },
  });
  assert.deepEqual(logged.error, [], 'neither reached the central handler');
  database().exec("CREATE TRIGGER test_refuse BEFORE INSERT ON task_documents BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;");
  try {
    assertCentral(await call('PUT', `/${id}/documents`, { document_ids: [DOC] }), 'PUT', `${P}/:id/documents`);
  } finally {
    database().exec('DROP TRIGGER test_refuse;');
  }
});

// ── Sinks ───────────────────────────────────────────────────────────────────
/**
 * The handler of a route alone, without validateRequest() and whatever stands
 * in front of it in the route: the last function of its route layer.
 * @param {string} method lower case
 * @param {string} routePath the Express pattern of the router
 */
async function bareHandler(method, routePath) {
  const { default: router } = await import('../server/routes/tasks.js');
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
  }
  throw new Error(`no route ${method} ${routePath}`);
}

/**
 * Runs a bare handler with a raw body as the admin; returns its answer. An
 * error the handler throws fails the test (it would be a 500).
 * @param {string} method
 * @param {string} routePath
 * @param {{ body?: unknown, params?: Record<string, string> }} input
 */
async function callBare(method, routePath, { body = {}, params = {} }) {
  const handler = await bareHandler(method, routePath);
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
  logged.error.length = 0;
  await handler(req, res, (/** @type {unknown} */ err) => { throw err; });
  return out;
}

// The schema refuses each of these in front (the table holds that). Behind it
// a loop, `.length`, `.map` or a string method runs over the raw value, so the
// handler keeps its own type check there (sink, not route; CodeQL
// js/loop-bound-injection in #2860): called without validateRequest(), each
// answers 400 or reads the value as empty instead of throwing or looping.
const NOT_A_LIST = [{ length: 1e9 }, 'x', 5];

test('sink: POST / and PUT /{id} keep the type check of the title in front of .trim()', async () => {
  const id = task({ title: 'Senke' });
  for (const title of [{ length: 1e9 }, 5, ['x']]) {
    const wanted = { status: 400, body: { error: 'title must be text.', code: 400 } };
    assert.deepEqual(await callBare('post', '/', { body: { title } }), wanted, `POST ${JSON.stringify(title)}`);
    assert.deepEqual(await callBare('put', '/:id', { body: { title }, params: { id: String(id) } }), wanted, `PUT ${JSON.stringify(title)}`);
  }
});

test('sink: the rotation keeps the list check of rotation_pool in front of .map() and new Set()', async () => {
  for (const pool of NOT_A_LIST) {
    assert.deepEqual(await callBare('post', '/', { body: { title: 'x', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', rotation_pool: pool } }),
      { status: 400, body: { error: 'rotation_pool must be an array of user ids.', code: 400 } }, JSON.stringify(pool));
  }
});

test('sink: both order routes keep the list check in front of .length, .some() and the id lookup', async () => {
  for (const list of NOT_A_LIST) {
    const wanted = { status: 400, body: { error: 'A non-empty array of task IDs is required.', code: 400 } };
    assert.deepEqual(await callBare('patch', '/reorder', { body: { order: list } }), wanted, `order ${JSON.stringify(list)}`);
    assert.deepEqual(await callBare('post', '/reorder/reset', { body: { ids: list } }), wanted, `ids ${JSON.stringify(list)}`);
  }
});

test('sink: tags/apply, archive and the category order read a raw value that is no list as empty, without .map() or .forEach() on it', async () => {
  for (const list of NOT_A_LIST) {
    // Read as an empty list, nothing is changed (the route's schema refuses it
    // in front; before #2810 group 11a b the handler answered 400 itself).
    const apply = /** @type {any} */ (await callBare('post', '/tags/apply', { body: { ids: list, add: ['x'] } }));
    assert.ok(apply.status === 400 || (apply.status === 200 && apply.body.data.updated === 0), `apply ${JSON.stringify(list)}: ${JSON.stringify(apply)}`);
    const archive = /** @type {any} */ (await callBare('post', '/archive', { body: { ids: list } }));
    assert.ok(archive.status === 400 || (archive.status === 200 && archive.body.data.archived === 0), `archive ${JSON.stringify(list)}: ${JSON.stringify(archive)}`);
    const order = await callBare('patch', '/categories/reorder', { body: { order: list } });
    assert.equal(order.status, 200, `category order ${JSON.stringify(list)}`);
  }
});
