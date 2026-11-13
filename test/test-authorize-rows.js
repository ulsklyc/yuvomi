/**
 * Test: row visibility through one interface (phase 2, section B3) -
 *       visibleWhere() and filterVisible() from server/authorize/index.ts
 *
 * Purpose: every "rows this viewer sees" rule has ONE entry point keyed by the data
 *          type. Held here:
 *            1. Per type, visibleWhere(type, alias, viewer, options) is the SAME SQL
 *               text as the inner rule with its fixed tables (rows/*.ts), for the
 *               default viewer and for an explicit one. The callers were switched
 *               over on that equality; a change in the text is a change in the rule.
 *            2. An unknown type, a missing budget mode, a missing budget viewer and a
 *               missing reminders database throw instead of answering.
 *            3. filterVisible() against real SQLite with every migration, per type it
 *               serves: a row visible to all, a foreign private one, and (tasks,
 *               events) one the viewer is assigned to; unknown and invalid ids drop
 *               out silently, order as given, no duplicates.
 *
 * Run: npm run test:authorize-rows
 */

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'authorize-rows-test-secret-32chars!';
process.env.LOG_LEVEL = 'error';

// server/db.js opens `:memory:` on import and runs every migration on it.
const { get } = await import('../server/db.js');
const authorizeApi = await import('../server/authorize/index.ts');
const { visibilityWhere } = await import('../server/authorize/rows/assignees.ts');
const { noteVisibleWhere, categoryVisibleWhere } = await import('../server/authorize/rows/notes.ts');
const { icsSubscriptionVisibleWhere } = await import('../server/authorize/rows/ics-subscriptions.ts');
const { documentVisibleSql } = await import('../server/authorize/rows/documents.ts');
const { budgetVisibilityWhere } = await import('../server/authorize/rows/budget.ts');
const { reminderTargetVisibleSql } = await import('../server/authorize/rows/reminders.ts');

/**
 * Read as properties, not destructured: before they exist the suite turns red on
 * its tests instead of failing on import.
 * @type {(type: string, alias: string, viewer?: string, options?: object) => string}
 */
const visibleWhere = (...args) => {
  const fn = /** @type {any} */ (authorizeApi).visibleWhere;
  assert.equal(typeof fn, 'function', 'visibleWhere is exported from server/authorize/index.ts');
  return fn(...args);
};
/** @type {(database: any, type: string, ids: any[], viewerId: number, options?: object) => number[]} */
const filterVisible = (...args) => {
  const fn = /** @type {any} */ (authorizeApi).filterVisible;
  assert.equal(typeof fn, 'function', 'filterVisible is exported from server/authorize/index.ts');
  return fn(...args);
};

const db = get();
test.after(() => db.close());

let seq = 0;
/** @returns {number} */
function seedUser() {
  seq += 1;
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'x', '#007AFF', 'member')
  `).run(`rows-${seq}`, `Rows ${seq}`).lastInsertRowid);
}

const owner = seedUser();
const assignee = seedUser();
const stranger = seedUser();

// ── 1. The same SQL text as the inner rule ──────────────────────────────────────

test('tasks: the task rule with task_assignments/task_id, default viewer ?', () => {
  assert.equal(visibleWhere('tasks', 't'), visibilityWhere('t', 'task_assignments', 'task_id'));
  assert.equal(visibleWhere('tasks', 't', '?'), visibilityWhere('t', 'task_assignments', 'task_id', '?'));
  assert.equal(visibleWhere('tasks', 's', '@me'), visibilityWhere('s', 'task_assignments', 'task_id', '@me'));
});

test('events: the same rule with event_assignments/event_id, default viewer ?', () => {
  assert.equal(visibleWhere('events', 'e'), visibilityWhere('e', 'event_assignments', 'event_id'));
  assert.equal(visibleWhere('events', 'e', '@userId'), visibilityWhere('e', 'event_assignments', 'event_id', '@userId'));
  assert.equal(visibleWhere('events', 'e', 'NULL'), visibilityWhere('e', 'event_assignments', 'event_id', 'NULL'));
  assert.notEqual(visibleWhere('events', 'e'), visibleWhere('tasks', 'e'), 'events do not read the task assignments');
});

test('notes and note_categories: their own rules, default viewer ?', () => {
  assert.equal(visibleWhere('notes', 'n'), noteVisibleWhere('n'));
  assert.equal(visibleWhere('notes', 'n', '@me'), noteVisibleWhere('n', '@me'));
  assert.equal(visibleWhere('note_categories', ''), categoryVisibleWhere(''));
  assert.equal(visibleWhere('note_categories', 'nc', '@me'), categoryVisibleWhere('nc', '@me'));
});

test('documents: default viewer @userId, a named token is the old parameter name', () => {
  assert.equal(visibleWhere('documents', 'd'), documentVisibleSql('d'));
  assert.equal(visibleWhere('documents', 'd', '@userId'), documentVisibleSql('d', 'userId'));
  assert.equal(visibleWhere('documents', 'x', '@me'), documentVisibleSql('x', 'me'));
});

test('ics_subscriptions: the subscription rule of an event, default viewer ?', () => {
  assert.equal(visibleWhere('ics_subscriptions', 'e'), icsSubscriptionVisibleWhere('e'));
  assert.equal(visibleWhere('ics_subscriptions', 'e', '@userId'), icsSubscriptionVisibleWhere('e', '@userId'));
});

test('budget: the owner rule in the given mode', () => {
  assert.equal(visibleWhere('budget', 's', '?', { mode: 'personal' }), budgetVisibilityWhere('s', '?', { mode: 'personal' }));
  assert.equal(visibleWhere('budget', 'b', '@me', { mode: 'shared' }), budgetVisibilityWhere('b', '@me', { mode: 'shared' }));
});

test('reminders: the target rule, default viewer <alias>.created_by', () => {
  assert.equal(visibleWhere('reminders', 'r', undefined, { database: db }), reminderTargetVisibleSql(db, 'r'));
  assert.equal(visibleWhere('reminders', 'r', 'r.created_by', { database: db }), reminderTargetVisibleSql(db, 'r'));
  assert.equal(visibleWhere('reminders', 'r', 'NULL', { database: db }), reminderTargetVisibleSql(db, 'r', 'NULL'));
});

test('quick_links: shared or own, the text the quick links route used', () => {
  assert.equal(visibleWhere('quick_links', 'q', '@me'), "(q.visibility = 'all' OR q.created_by = @me)");
  assert.equal(visibleWhere('quick_links', 'q'), "(q.visibility = 'all' OR q.created_by = @me)");
});

// ── 2. Refusals ─────────────────────────────────────────────────────────────────

test('an unknown type throws', () => {
  assert.throws(() => visibleWhere('contacts', 'c', '?'), /unknown row type/);
  assert.throws(() => visibleWhere('toString', 'c', '?'), /unknown row type/);
  assert.throws(() => filterVisible(db, 'contacts', [1], owner), /unknown row type|no table/);
});

test('budget without mode or viewer throws', () => {
  assert.throws(() => visibleWhere('budget', 'b', '?'), /mode/);
  assert.throws(() => visibleWhere('budget', 'b', '?', {}), /mode/);
  assert.throws(() => visibleWhere('budget', 'b', undefined, { mode: 'personal' }), /viewer/);
});

test('reminders without a database throws', () => {
  assert.throws(() => visibleWhere('reminders', 'r'), /database/);
  assert.throws(() => visibleWhere('reminders', 'r', 'r.created_by', {}), /database/);
});

test('filterVisible serves no type whose rows it cannot name', () => {
  for (const type of ['budget', 'reminders', 'ics_subscriptions']) {
    assert.throws(() => filterVisible(db, type, [1], owner, { mode: 'personal', database: db }), /no table/, type);
  }
});

// ── 3. filterVisible against real SQLite ────────────────────────────────────────

/**
 * Asserts the three viewers of one type: the owner sees all three rows, the
 * stranger only the open one, the assignee the open and (when given) the assigned
 * one. Garbage ids, duplicates and order hold as filterVisibleDocumentIds did.
 * @param {string} type
 * @param {{ open: number, foreignPrivate: number, assigned?: number | null }} rows
 */
function assertViewers(type, { open, foreignPrivate, assigned = null }) {
  const all = assigned ? [open, foreignPrivate, assigned] : [open, foreignPrivate];
  assert.deepEqual(filterVisible(db, type, all, owner), all, `${type}: owner`);
  assert.deepEqual(filterVisible(db, type, all, stranger), [open], `${type}: stranger`);
  assert.deepEqual(
    filterVisible(db, type, all, assignee),
    assigned ? [open, assigned] : [open],
    `${type}: assignee`,
  );
  assert.deepEqual(
    filterVisible(db, type, [foreignPrivate, open, open, 0, -1, 'x', null, 999999], stranger),
    [open],
    `${type}: garbage`,
  );
  assert.deepEqual(filterVisible(db, type, [], owner), [], `${type}: empty`);
}

test('filterVisible: tasks', () => {
  const mk = (/** @type {string} */ visibility) => Number(db.prepare(
    "INSERT INTO tasks (title, created_by, visibility) VALUES ('t', ?, ?)",
  ).run(owner, visibility).lastInsertRowid);
  const open = mk('all');
  const foreignPrivate = mk('private');
  const assigned = mk('assignees');
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(assigned, assignee);
  assertViewers('tasks', { open, foreignPrivate, assigned });
});

test('filterVisible: events', () => {
  const mk = (/** @type {string} */ visibility) => Number(db.prepare(
    "INSERT INTO calendar_events (title, start_datetime, created_by, visibility) VALUES ('e', '2026-01-01T10:00', ?, ?)",
  ).run(owner, visibility).lastInsertRowid);
  const open = mk('all');
  const foreignPrivate = mk('private');
  const assigned = mk('assignees');
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(assigned, assignee);
  assertViewers('events', { open, foreignPrivate, assigned });
});

test('filterVisible: notes', () => {
  const mk = (/** @type {string} */ visibility) => Number(db.prepare(
    "INSERT INTO notes (content, created_by, visibility) VALUES ('n', ?, ?)",
  ).run(owner, visibility).lastInsertRowid);
  assertViewers('notes', { open: mk('all'), foreignPrivate: mk('private') });
});

test('filterVisible: note_categories', () => {
  const open = Number(db.prepare(
    "INSERT INTO note_categories (name, name_key, scope, owner_user_id) VALUES ('Haushalt', 'haushalt', 'household', NULL)",
  ).run().lastInsertRowid);
  const foreignPrivate = Number(db.prepare(
    "INSERT INTO note_categories (name, name_key, scope, owner_user_id) VALUES ('Meins', 'meins', 'personal', ?)",
  ).run(owner).lastInsertRowid);
  assertViewers('note_categories', { open, foreignPrivate });
});

test('filterVisible: documents (family, private, shared by access list)', () => {
  const mk = (/** @type {string} */ visibility) => Number(db.prepare(`
    INSERT INTO family_documents
      (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES ('d', 'finance', ?, 'd.pdf', 'application/pdf', 1, 'data:application/pdf;base64,AA==', ?)
  `).run(visibility, owner).lastInsertRowid);
  const open = mk('family');
  const foreignPrivate = mk('private');
  const assigned = mk('restricted');
  db.prepare('INSERT INTO family_document_access (document_id, user_id) VALUES (?, ?)').run(assigned, assignee);
  assertViewers('documents', { open, foreignPrivate, assigned });
});

test('filterVisible: quick_links', () => {
  const mk = (/** @type {string} */ visibility) => Number(db.prepare(
    "INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('q', 'https://q.example/', ?, ?, 0)",
  ).run(visibility, owner).lastInsertRowid);
  assertViewers('quick_links', { open: mk('all'), foreignPrivate: mk('private') });
});
