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
 *            5. The budget rule against data (owner, stranger, NULL and TEXT owner)
 *               per mode, against a written-out expectation.
 *            6. isOwnRow: a viewer given as a string owns nothing.
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

// ── 4. The row form of the rules (B8b) ──────────────────────────────────────────
//
// rowVisible(), householdVisible() and canEditQuickLink()
// answer for ONE row the routes already loaded. Held against the SQL fragment of
// the same type over a seed with every level, own, foreign and assigned rows
// (the row_rules seed of test/visibility-matrix-seed.js is the model), for every
// viewer; rowVisible with the assignments handed in against rowVisible reading them.

/**
 * @param {string} name
 * @returns {(...args: any[]) => any}
 */
function rowApi(name) {
  const fn = /** @type {any} */ (authorizeApi)[name];
  assert.equal(typeof fn, 'function', `${name} is exported from server/authorize/index.ts`);
  return fn;
}

const display = seedUser();
const VIEWERS = [owner, assignee, stranger, display];
const CREATORS = [owner, assignee, stranger];

/**
 * A value outside all | assignees | private. tasks.visibility and
 * calendar_events.visibility carry no CHECK, so a restored file or a direct write can
 * store one; the SQL fragment shows such a row to its creator only, and so must the
 * row form - an assignment must not open it.
 */
const OFF_DOMAIN = 'family';

/**
 * One row per level and creator; 'all', 'assignees' and the off-domain rows are
 * assigned to the next creator in the list, one 'assignees' row per creator has no
 * assignment.
 * @param {string} table
 * @param {string} assignTable
 * @param {string} assignCol
 * @param {(creator: number, visibility: string) => number} mk
 * @returns {number[]} the ids
 */
function seedLevels(table, assignTable, assignCol, mk) {
  /** @type {number[]} */
  const ids = [];
  CREATORS.forEach((creator, i) => {
    const other = CREATORS[(i + 1) % CREATORS.length];
    for (const visibility of ['all', 'assignees', 'private', OFF_DOMAIN]) {
      const id = mk(creator, visibility);
      ids.push(id);
      if (visibility !== 'private') {
        db.prepare(`INSERT INTO ${assignTable} (${assignCol}, user_id) VALUES (?, ?)`).run(id, other);
      }
    }
    ids.push(mk(creator, 'assignees'));
  });
  return ids;
}

const eqTasks = seedLevels('tasks', 'task_assignments', 'task_id', (creator, visibility) => Number(db.prepare(
  "INSERT INTO tasks (title, created_by, visibility) VALUES ('eq', ?, ?)",
).run(creator, visibility).lastInsertRowid));
const eqEvents = seedLevels('calendar_events', 'event_assignments', 'event_id', (creator, visibility) => Number(db.prepare(
  "INSERT INTO calendar_events (title, start_datetime, created_by, visibility) VALUES ('eq', '2026-01-01T10:00', ?, ?)",
).run(creator, visibility).lastInsertRowid));
// quick_links.created_by is nullable: a tile without a creator (NULL) per level is
// nobody's own tile, as SQL `created_by = @me` never matches NULL.
const eqLinks = [...CREATORS, null].flatMap((creator) => ['all', 'private'].map((visibility) => Number(db.prepare(
  "INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('eq', 'https://eq.example/', ?, ?, 0)",
).run(visibility, creator).lastInsertRowid)));
/** The quick link viewers: every account, and no account at all. */
const LINK_VIEWERS = [...VIEWERS, null];

/**
 * created_by is INTEGER without CHECK on all three tables: with foreign keys off (a
 * restore, direct database access) it can hold TEXT. '0x<id>' stays TEXT in SQLite
 * ('<id>', ' <id>', '<id>.0' become the integer on write), SQL `created_by = @v`
 * never matches it, Number('0x<id>') does. One row per creator and level, creator
 * written as the hex of that account; one 'assignees' row is assigned to it.
 * @param {string} table
 * @param {(creator: string, visibility: string) => number} mk
 * @param {string[]} levels
 * @param {[string, string] | null} assign
 * @returns {number[]}
 */
function seedTextCreators(table, mk, levels, assign) {
  /** @type {number[]} */
  const ids = [];
  db.pragma('foreign_keys = OFF');
  try {
    for (const creator of CREATORS) {
      const hex = `0x${creator.toString(16)}`;
      for (const visibility of levels) ids.push(mk(hex, visibility));
      if (assign) {
        const id = mk(hex, 'assignees');
        ids.push(id);
        db.prepare(`INSERT INTO ${assign[0]} (${assign[1]}, user_id) VALUES (?, ?)`).run(id, creator);
      }
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return ids;
}
const textCreators = /** @type {const} */ ([
  ['tasks', 'tasks', seedTextCreators('tasks', (c, v) => Number(db.prepare(
    "INSERT INTO tasks (title, created_by, visibility) VALUES ('hex', ?, ?)",
  ).run(c, v).lastInsertRowid), ['all', 'assignees', 'private', OFF_DOMAIN], ['task_assignments', 'task_id'])],
  ['events', 'calendar_events', seedTextCreators('calendar_events', (c, v) => Number(db.prepare(
    "INSERT INTO calendar_events (title, start_datetime, created_by, visibility) VALUES ('hex', '2026-01-01T10:00', ?, ?)",
  ).run(c, v).lastInsertRowid), ['all', 'assignees', 'private', OFF_DOMAIN], ['event_assignments', 'event_id'])],
  ['quick_links', 'quick_links', seedTextCreators('quick_links', (c, v) => Number(db.prepare(
    "INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('hex', 'https://hex.example/', ?, ?, 0)",
  ).run(v, c).lastInsertRowid), ['all', 'private', OFF_DOMAIN], null)],
]);

/**
 * The ids among `ids` the SQL fragment lets through for `viewer`.
 * @param {string} table @param {string} where @param {number[]} ids @param {number | null} viewer
 */
function sqlIds(table, where, ids, viewer) {
  return db.prepare(`SELECT x.id FROM ${table} x WHERE x.id IN (${ids.join(',')}) AND ${where} ORDER BY x.id`)
    .all({ v: viewer }).map((/** @type {any} */ r) => r.id);
}

/** @param {string} table @param {number[]} ids @returns {any[]} */
function rowsById(table, ids) {
  return db.prepare(`SELECT * FROM ${table} WHERE id IN (${ids.join(',')}) ORDER BY id`).all();
}

/** A connection that counts its prepare() calls. */
function counting() {
  let calls = 0;
  return {
    database: { prepare: (/** @type {string} */ sql) => { calls += 1; return db.prepare(sql); } },
    get calls() { return calls; },
  };
}

for (const [type, table, assignTable, assignCol, ids] of /** @type {const} */ ([
  ['tasks', 'tasks', 'task_assignments', 'task_id', eqTasks],
  ['events', 'calendar_events', 'event_assignments', 'event_id', eqEvents],
])) {
  test(`rowVisible(${type}): the same rows as visibleWhere for every viewer`, () => {
    const rowVisible = rowApi('rowVisible');
    const rows = rowsById(table, ids);
    for (const viewer of VIEWERS) {
      const js = rows.filter((row) => rowVisible(db, type, row, viewer)).map((row) => row.id);
      assert.deepEqual(js, sqlIds(table, visibleWhere(type, 'x', '@v'), ids, viewer), `${type}: viewer ${viewer}`);
    }
  });

  test(`rowVisible(${type}): assignedIds handed in answer as the table does, without a read`, () => {
    const rowVisible = rowApi('rowVisible');
    for (const row of rowsById(table, ids)) {
      const assignedIds = db.prepare(`SELECT user_id FROM ${assignTable} WHERE ${assignCol} = ?`)
        .all(row.id).map((/** @type {any} */ r) => r.user_id);
      for (const viewer of VIEWERS) {
        const c = counting();
        assert.equal(
          rowVisible(c.database, type, row, viewer, { assignedIds }),
          rowVisible(db, type, row, viewer),
          `${type} ${row.id} viewer ${viewer}`,
        );
        assert.equal(c.calls, 0, 'assignedIds: no read');
        // Ids as strings (a request body) count the same.
        assert.equal(
          rowVisible(c.database, type, row, viewer, { assignedIds: assignedIds.map(String) }),
          rowVisible(db, type, row, viewer),
        );
      }
    }
  });

  test(`rowVisible(${type}): reads ${assignTable} only on the assignees branch`, () => {
    const rowVisible = rowApi('rowVisible');
    for (const row of rowsById(table, ids)) {
      for (const viewer of VIEWERS) {
        const c = counting();
        rowVisible(c.database, type, row, viewer);
        const expected = row.visibility === 'assignees' && row.created_by !== viewer ? 1 : 0;
        assert.equal(c.calls, expected, `${type} ${row.id} (${row.visibility}) viewer ${viewer}`);
      }
    }
  });
}

test('rowVisible(quick_links): the same rows as visibleWhere for every viewer, a NULL creator included', () => {
  const rowVisible = rowApi('rowVisible');
  const rows = rowsById('quick_links', eqLinks);
  assert.ok(rows.some((row) => row.created_by === null && row.visibility === 'private'), 'the seed holds a private tile without creator');
  for (const viewer of LINK_VIEWERS) {
    const c = counting();
    const js = rows.filter((row) => rowVisible(c.database, 'quick_links', row, viewer)).map((row) => row.id);
    assert.deepEqual(js, sqlIds('quick_links', visibleWhere('quick_links', 'x', '@v'), eqLinks, viewer), `viewer ${viewer}`);
    assert.equal(c.calls, 0, 'quick links read nothing');
  }
});

test('rowVisible: a TEXT creator that reads as an account id is nobody\'s own row, as in SQL', () => {
  const rowVisible = rowApi('rowVisible');
  for (const [type, table, ids] of textCreators) {
    const rows = rowsById(table, ids);
    assert.ok(rows.every((row) => typeof row.created_by === 'string'), `${type}: the creators are stored as TEXT`);
    for (const viewer of LINK_VIEWERS) {
      const js = rows.filter((row) => rowVisible(db, type, row, viewer)).map((row) => row.id);
      assert.deepEqual(js, sqlIds(table, visibleWhere(type, 'x', '@v'), ids, viewer), `${type}: viewer ${viewer}`);
    }
  }
});

test('rowVisible with assignedIds (the Outlook target) keeps the Number() creator comparison - held', () => {
  // Deliberately not aligned: a narrower answer here means "no auto-sync target" and
  // makes a series eligible for occurrence overrides (see assignableRowVisible).
  const rowVisible = rowApi('rowVisible');
  const row = { id: 0, created_by: `0x${owner.toString(16)}`, visibility: 'private' };
  assert.equal(rowVisible(db, 'events', row, owner, { assignedIds: [] }), true, 'Outlook path: as before B8b');
  assert.equal(rowVisible(db, 'events', row, owner), false, 'every other path: as in SQL');
});

test('rowVisible: an unknown type or one without a row check throws, a missing row is not visible', () => {
  const rowVisible = rowApi('rowVisible');
  const [row] = rowsById('tasks', eqTasks);
  assert.throws(() => rowVisible(db, 'contacts', row, owner), /unknown row type/);
  assert.throws(() => rowVisible(db, 'toString', row, owner), /unknown row type/);
  assert.throws(() => rowVisible(db, 'notes', row, owner), /no row check/);
  assert.equal(rowVisible(db, 'tasks', null, owner), false);
  assert.equal(rowVisible(db, 'events', undefined, owner), false);
});

test('householdVisible: the same rows as householdVisibleWhere', () => {
  const householdVisible = rowApi('householdVisible');
  const rows = rowsById('tasks', eqTasks);
  const js = rows.filter((row) => householdVisible(row)).map((row) => row.id);
  const sql = db.prepare(`SELECT x.id FROM tasks x WHERE x.id IN (${eqTasks.join(',')}) AND ${authorizeApi.householdVisibleWhere('x')} ORDER BY x.id`)
    .all().map((/** @type {any} */ r) => r.id);
  assert.deepEqual(js, sql);
  assert.ok(js.length > 0 && js.length < rows.length, 'the seed holds both answers');
  assert.ok(rows.some((row) => row.visibility === OFF_DOMAIN), 'the seed holds an off-domain level');
});

test('canEditQuickLink: own tiles, and shared tiles for an admin; never a foreign private one', () => {
  const canEditQuickLink = rowApi('canEditQuickLink');
  const own = { created_by: owner, visibility: 'private' };
  const shared = { created_by: owner, visibility: 'all' };
  assert.equal(canEditQuickLink(own, owner, false), true, 'own private');
  assert.equal(canEditQuickLink(shared, owner, false), true, 'own shared');
  assert.equal(canEditQuickLink(shared, stranger, true), true, 'shared, admin');
  assert.equal(canEditQuickLink(shared, stranger, false), false, 'shared, member');
  assert.equal(canEditQuickLink(own, stranger, true), false, 'foreign private, admin');
  assert.equal(canEditQuickLink(shared, stranger, 1), false, 'only isAdmin === true counts');
  // Every seeded tile, every viewer, both roles: an editable tile is a visible one.
  const rowVisible = rowApi('rowVisible');
  for (const row of rowsById('quick_links', eqLinks)) {
    for (const viewer of VIEWERS) {
      for (const isAdmin of [false, true]) {
        if (canEditQuickLink(row, viewer, isAdmin)) assert.equal(rowVisible(db, 'quick_links', row, viewer), true);
      }
    }
  }
});

test('rowVisible(quick_links): a third visibility value is the creator\'s alone, as in visibleWhere (the 404 of PUT/DELETE)', () => {
  // quick_links.visibility has no CHECK: a value other than 'all' and 'private'
  // (not writable through the route, possible in a restored file). PUT and DELETE
  // answer 404 through rowVisible, so they hide such a tile exactly as the list.
  const rowVisible = rowApi('rowVisible');
  const odd = [...CREATORS, null].map((creator) => Number(db.prepare(
    "INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('odd', 'https://odd.example/', ?, ?, 0)",
  ).run(OFF_DOMAIN, creator).lastInsertRowid));
  try {
    const rows = rowsById('quick_links', odd);
    for (const viewer of LINK_VIEWERS) {
      const js = rows.filter((row) => rowVisible(db, 'quick_links', row, viewer)).map((row) => row.id);
      assert.deepEqual(js, sqlIds('quick_links', visibleWhere('quick_links', 'x', '@v'), odd, viewer), `viewer ${viewer}`);
    }
    assert.equal(rowVisible(db, 'quick_links', { id: 0, created_by: owner, visibility: OFF_DOMAIN }, owner), true, 'own');
    assert.equal(rowVisible(db, 'quick_links', { id: 0, created_by: owner, visibility: OFF_DOMAIN }, stranger), false, 'foreign');
    // The second wording of the 404 is gone: one rule, no facade.
    assert.equal(Object.hasOwn(authorizeApi, 'quickLinkHiddenFrom'), false);
  } finally {
    db.prepare(`DELETE FROM quick_links WHERE id IN (${odd.join(',')})`).run();
  }
});

// ── 5. The budget rule against data, not only as its own text ──────────────────
//
// budget_entries.owner_id is INTEGER without CHECK: NULL (an owner removed, ON
// DELETE SET NULL) and, with foreign keys off, TEXT such as '0x<id>' (SQLite keeps
// it as TEXT, SQL `owner_id = @v` never matches it). One row per visibility and
// owner kind; the expectation is written out, not taken from the fragment.

/** @type {Array<{ id: number, visibility: string, owner: number | string | null }>} */
const budgetRows = [];
db.pragma('foreign_keys = OFF');
try {
  for (const owner_ of [owner, stranger, null, `0x${owner.toString(16)}`]) {
    for (const visibility of ['private', 'shared', 'shared_amount']) {
      const id = Number(db.prepare(`
        INSERT INTO budget_entries (title, amount, date, created_by, owner_id, visibility)
        VALUES ('b', 1, '2026-01-01', ?, ?, ?)
      `).run(owner, owner_, visibility).lastInsertRowid);
      budgetRows.push({ id, visibility, owner: owner_ });
    }
  }
} finally {
  db.pragma('foreign_keys = ON');
}

/**
 * The written-out rule: shared mode shows everything; personal mode shows a row
 * unless it is private and not the viewer's own - and only an integer owner equal
 * to the viewer is own (NULL and TEXT are nobody's).
 * @param {string} mode @param {number} viewer
 */
function budgetExpected(mode, viewer) {
  return budgetRows
    .filter((row) => mode !== 'personal' || row.visibility !== 'private'
      || (typeof row.owner === 'number' && row.owner === viewer))
    .map((row) => row.id);
}

test('budget: visibleWhere lets through exactly the written-out rows, per mode and viewer', () => {
  const ids = budgetRows.map((row) => row.id);
  const stored = db.prepare(`SELECT typeof(owner_id) AS t FROM budget_entries WHERE id IN (${ids.join(',')})`).all()
    .map((/** @type {any} */ r) => r.t);
  assert.deepEqual([...new Set(stored)].sort(), ['integer', 'null', 'text'], 'the seed holds every owner kind');
  for (const mode of ['personal', 'shared']) {
    for (const viewer of [owner, assignee, stranger]) {
      const sql = db.prepare(`SELECT x.id FROM budget_entries x WHERE x.id IN (${ids.join(',')}) AND ${visibleWhere('budget', 'x', '@v', { mode })} ORDER BY x.id`)
        .all({ v: viewer }).map((/** @type {any} */ r) => r.id);
      assert.deepEqual(sql, budgetExpected(mode, viewer), `${mode}: viewer ${viewer}`);
    }
  }
  assert.ok(budgetExpected('personal', stranger).length < budgetRows.length, 'personal mode hides rows');
});

// ── 6. isOwnRow: a viewer as a string owns nothing ─────────────────────────────

test('isOwnRow: a viewer given as a string (\'2\') is deliberately not the owner', async () => {
  const { isOwnRow } = await import('../server/authorize/rows/creator.ts');
  assert.equal(isOwnRow(owner, owner), true, 'number and number');
  assert.equal(isOwnRow(owner, String(owner)), false, 'viewer as a string');
  assert.equal(isOwnRow(String(owner), owner), false, 'creator as a string');
  // The same through the row form: a private tile is hidden from its creator's id as a string.
  const rowVisible = rowApi('rowVisible');
  assert.equal(rowVisible(db, 'quick_links', { id: 0, created_by: owner, visibility: 'private' }, String(owner)), false);
  assert.equal(rowVisible(db, 'tasks', { id: 0, created_by: owner, visibility: 'private' }, String(owner)), false);
});
