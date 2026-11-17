/**
 * Module: tasks overview slice (phase 2, section D, contract E10)
 * Purpose: holds the contract of server/services/tasks-slices.ts and of the
 *          route's error isolation (server/services/slice-runner.ts):
 *
 *          1. NO CLOCK. The system clock is frozen at a deliberately wrong instant
 *             (2031); two calls with two different `ctx` answer what fits `ctx`,
 *             never what fits the system clock. A slice that read `new Date()`,
 *             `Date.now()` or todayKey() itself would answer for 2031.
 *          2. ONE FORM. emptyTasksOverview() and the failure values carry exactly
 *             the keys of the slice.
 *          3. ISOLATION. runSlice() logs `<name> error:` and answers the failure
 *             value; through the slice, each failing read answers its own failure
 *             value under its old name, and without a guard a failure throws.
 *
 *          The whole GET /dashboard answer is held byte for byte by
 *          test:overview-golden; this suite holds what that one cannot see.
 *
 * Run: npm run test:tasks-slices
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The production driver, migrated by server/db.js itself, in memory.
process.env.DB_PATH = ':memory:';

const { get } = await import('../server/db.js');
const { personReader, rowReader } = await import('../server/authorize/index.ts');
const {
  emptyTasksOverview, tasksOverviewSlice, TASKS_BLOCK_FAILED,
} = await import('../server/services/tasks-slices.ts');
const { sliceRunner } = await import('../server/services/slice-runner.ts');

const db = get();
test.after(() => db.close());

const ANNA = Number(db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES ('slice-anna', 'Anna', 'hash', '#7C3AED', 'admin', 'parent')
`).run().lastInsertRowid);

/**
 * @param {string} title
 * @param {{ due: string, dueTime?: string | null, status?: string, completedAt?: string | null }} fields
 */
function addTask(title, { due, dueTime = null, status = 'open', completedAt = null }) {
  const id = Number(db.prepare(`
    INSERT INTO tasks (title, status, due_date, due_time, created_by, visibility)
    VALUES (?, ?, ?, ?, ?, 'all')
  `).run(title, status, due, dueTime, ANNA).lastInsertRowid);
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, ANNA);
  if (completedAt) {
    db.prepare('INSERT INTO task_completions (task_id, series_id, user_id, completed_at) VALUES (?, ?, ?, ?)')
      .run(id, id, ANNA, completedAt);
  }
  return id;
}

// Wednesday 11.03.2026 and Thursday 12.03.2026 in Berlin (UTC+1).
addTask('due wednesday', { due: '2026-03-11', dueTime: '10:00' });
addTask('due thursday', { due: '2026-03-12' });
// Overdue since Tuesday, ticked on Wednesday morning (Berlin): on the wall of
// Wednesday it stands under "done", on Thursday it is gone.
addTask('ticked wednesday', { due: '2026-03-10', status: 'done', completedAt: '2026-03-11T07:00:00.000Z' });
addTask('done thursday', { due: '2026-03-12', status: 'done', completedAt: '2026-03-12T07:00:00.000Z' });

const ZONE = 'Europe/Berlin';
const WEDNESDAY = Object.freeze({ today: '2026-03-11', zone: ZONE, now: new Date('2026-03-11T09:30:00.000Z') });
const THURSDAY = Object.freeze({ today: '2026-03-12', zone: ZONE, now: new Date('2026-03-12T09:30:00.000Z') });

const reader = personReader(ANNA);
/** @param {Record<string, unknown>[]} list */
const titles = (list) => list.map((task) => task.title);
/** @param {import('../server/services/tasks-slices.ts').TasksOverview} answer */
const wallOf = (answer) => answer.wallTasks.map(({ open, done }) => ({
  open: open.map((task) => task.title), done: done.map((task) => task.title),
}));

test('the slice reads no clock: two ctx, a wrong system clock, two answers that fit ctx', () => {
  // A system clock years away: any reading of it lands on no seeded day.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2031-07-01T03:00:00.000Z') });
  try {
    const wednesday = tasksOverviewSlice(db, reader, WEDNESDAY);
    const thursday = tasksOverviewSlice(db, reader, THURSDAY);

    assert.deepEqual(titles(wednesday.urgentTasks), ['due wednesday', 'due thursday']);
    assert.equal(wednesday.openTaskCount, 2);
    assert.equal(wednesday.overdueTaskCount, 0);
    assert.deepEqual(wednesday.memberTodayTasks, [{ user_id: ANNA, open_count: 1 }]);
    assert.equal(wednesday.tasksDoneToday, 0);
    assert.deepEqual(wallOf(wednesday), [{ open: ['due wednesday'], done: ['ticked wednesday'] }]);

    assert.equal(thursday.openTaskCount, 2);
    assert.equal(thursday.overdueTaskCount, 1);
    assert.deepEqual(thursday.memberTodayTasks, [{ user_id: ANNA, open_count: 2 }]);
    assert.equal(thursday.tasksDoneToday, 1);
    assert.deepEqual(wallOf(thursday), [{ open: ['due wednesday', 'due thursday'], done: ['done thursday'] }]);
  } finally {
    mock.timers.reset();
  }
});

test('the wall reader narrows the task blocks to visibility all', () => {
  const privateId = Number(db.prepare(`
    INSERT INTO tasks (title, status, due_date, created_by, visibility) VALUES ('private', 'open', '2026-03-11', ?, 'private')
  `).run(ANNA).lastInsertRowid);
  try {
    const person = tasksOverviewSlice(db, reader, WEDNESDAY);
    const wall = tasksOverviewSlice(db, rowReader({ authUserId: ANNA }, { household: true }), WEDNESDAY);
    assert.equal(person.openTaskCount, 3);
    assert.equal(wall.openTaskCount, 2);
  } finally {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(privateId);
  }
});

test('an undated task: open, never overdue, never due today, sorted last', () => {
  // The blocks drop `due_date IS NOT NULL` where a NULL comparison is not true
  // anyway (WHERE, CASE WHEN); this task holds that NULL stays "no date".
  const undated = addTask('undated', { due: /** @type {any} */ (null) });
  const undatedDone = addTask('undated done', { due: /** @type {any} */ (null), status: 'done', completedAt: '2026-03-11T08:00:00.000Z' });
  try {
    const wednesday = tasksOverviewSlice(db, reader, WEDNESDAY);
    // 'due wednesday' (10:00) is overdue at 10:30, 'due thursday' is not; the
    // undated one is not overdue and stands after every dated one.
    assert.deepEqual(titles(wednesday.urgentTasks), ['due wednesday', 'due thursday', 'undated']);
    assert.equal(wednesday.openTaskCount, 3, 'an undated task is open');
    assert.equal(wednesday.overdueTaskCount, 0, 'an undated task is not overdue');
    assert.deepEqual(wednesday.memberTodayTasks, [{ user_id: ANNA, open_count: 1 }], 'nor due today');
    assert.deepEqual(wallOf(wednesday), [{ open: ['due wednesday'], done: ['ticked wednesday'] }],
      'the wall names no undated task, open or done');
    assert.equal(wednesday.tasksDoneToday, 0);

    const thursday = tasksOverviewSlice(db, reader, THURSDAY);
    assert.deepEqual(titles(thursday.urgentTasks), ['due wednesday', 'due thursday', 'undated']);
    assert.equal(thursday.overdueTaskCount, 1);
    assert.deepEqual(thursday.memberTodayTasks, [{ user_id: ANNA, open_count: 2 }]);
  } finally {
    db.prepare('DELETE FROM tasks WHERE id IN (?, ?)').run(undated, undatedDone);
  }
});

test('the category filter of the options reaches every block', () => {
  const answer = tasksOverviewSlice(db, reader, WEDNESDAY, { categories: ['no-such-category'] });
  assert.deepEqual(answer.urgentTasks, []);
  assert.equal(answer.openTaskCount, 0);
  assert.deepEqual(answer.memberTodayTasks, []);
  assert.deepEqual(answer.wallTasks, []);
});

test('the empty form and the failure values carry exactly the keys of the slice', () => {
  const keys = Object.keys(tasksOverviewSlice(db, reader, WEDNESDAY)).sort();
  assert.deepEqual(Object.keys(emptyTasksOverview()).sort(), keys);
  assert.deepEqual(Object.keys(TASKS_BLOCK_FAILED).sort(), keys);
  // The empty form keeps the key order the route has always written.
  assert.deepEqual(Object.keys(emptyTasksOverview()), [
    'urgentTasks', 'openTaskCount', 'overdueTaskCount', 'memberTodayTasks', 'tasksDoneToday', 'wallTasks',
  ]);
  assert.notEqual(emptyTasksOverview(), emptyTasksOverview(), 'a fresh object per call');
});

/** A logger that keeps what runSlice() writes. */
function capturingLog() {
  /** @type {unknown[][]} */
  const lines = [];
  return { lines, error: (/** @type {unknown[]} */ ...args) => { lines.push(args); } };
}

test('runSlice: a throwing slice answers the empty form and logs `<name> error:`', () => {
  const log = capturingLog();
  const runSlice = sliceRunner(log);
  const answer = runSlice('tasks', () => { throw new Error('boom'); }, emptyTasksOverview());
  assert.deepEqual(answer, emptyTasksOverview());
  assert.deepEqual(log.lines, [['tasks error:', 'boom']]);
  assert.equal(runSlice('tasks', () => 'read', 'failed'), 'read');
  assert.equal(log.lines.length, 1, 'a read that works logs nothing');
});

test('through the slice each failing read answers its own failure value under its old name', () => {
  const broken = { prepare() { throw new Error('no such table: tasks'); }, exec() {} };
  const log = capturingLog();
  const answer = tasksOverviewSlice(broken, reader, WEDNESDAY, {}, sliceRunner(log));
  assert.deepEqual(answer, { ...TASKS_BLOCK_FAILED });
  assert.deepEqual(log.lines.map(([name]) => name), [
    'urgentTasks error:', 'openTaskCount error:', 'overdueTaskCount error:',
    'memberTodayTasks error:', 'wallTasks error:', 'tasksDoneToday error:',
  ]);
  assert.ok(log.lines.every(([, message]) => message === 'no such table: tasks'));
  assert.throws(() => tasksOverviewSlice(broken, reader, WEDNESDAY), /no such table/,
    'without a guard a failing read throws');
});
