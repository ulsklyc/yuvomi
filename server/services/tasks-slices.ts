/**
 * Module: tasks - the task blocks of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: everything the overview answer carries from the tasks module: the
 *          urgent list, the two counts of the task tile, the "due today" count
 *          per member, the wall titles per member and the "done today" count.
 *
 * THE CONTRACT. tasksOverviewSlice(db, actor, ctx, options, guard) is synchronous
 * and reads no clock: "today", the household zone and "now" come in `ctx`, the
 * same single reading the route takes for every other block, so two blocks never
 * straddle a day boundary. The row rule comes from authorize (taskVisibleWhere for
 * the reader, householdVisibleWhere for the wall titles). The result is a flat
 * object with exactly the keys the route used to write for these blocks.
 *
 * ONE FAILURE PER BLOCK, AS BEFORE. Each of the six reads used to have its own
 * try/catch in the route: one failing read logged `<key> error:` and answered with
 * its own failure value, the other five kept theirs. `guard` carries that: the
 * route passes its one runSlice(), each read goes through it under its old name and
 * with its old failure value (TASKS_BLOCK_FAILED). Without a guard a failure
 * throws.
 *
 * THE SQL IS THE ROUTE'S, minus redundant NULL guards: `due_date IS NOT NULL`
 * next to a comparison on `due_date` in a WHERE conjunction or a CASE WHEN, where
 * NULL is not true either way (an undated task in test:tasks-slices holds it).
 * Several orderings have no unique tiebreak; the golden master
 * (test:overview-golden) holds the answers, not the ties, so an ordering "tidied
 * up" here would change answers silently.
 *
 * Dependencies: server/authorize/index.ts (row rule), services/task-scope.js,
 * services/person-avatar.js, utils/timezone.js. Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import { householdVisibleWhere, taskVisibleWhere } from '../authorize/index.ts';
import { categoryBindings, taskCategoryWhere, taskScopeWhere } from './task-scope.js';
import { personAvatarUrlSql } from './person-avatar.js';
import { utcToWall } from '../utils/timezone.js';

/** The one reading of the clock a route hands every slice. */
export type OverviewContext = Readonly<{
  /** YYYY-MM-DD, the day of the household zone. */
  today: string;
  /** IANA zone of the household. */
  zone: string;
  /** The instant of the request. */
  now: Date;
}>;

/** Query options of the overview that act on the task blocks. */
export type TasksOverviewOptions = Readonly<{
  /** Normalized `tasks_category` filter (normalizeCategoryFilter); empty = all. */
  categories?: readonly string[];
}>;

/** The route's error isolation: run `read`, on a throw log `name` and answer `failed`. */
export type SliceGuard = <T>(name: string, read: () => T, failed: T) => T;

type TaskRow = Record<string, unknown>;
type MemberCount = { user_id: number; open_count: number };
type WallMember = {
  user_id: number;
  open_count: number;
  done_count: number;
  open: { id: number; title: string; due_date: string }[];
  done: { id: number; title: string }[];
};

export type TasksOverview = {
  urgentTasks: TaskRow[];
  openTaskCount: number | null;
  overdueTaskCount: number | null;
  memberTodayTasks: MemberCount[];
  wallTasks: WallMember[];
  tasksDoneToday: number;
};

/**
 * The empty form: a denied or switched-off tasks module (DENIED_PAYLOAD in the
 * route). The key order is the order the route has always written them in.
 */
export function emptyTasksOverview(): TasksOverview {
  return {
    urgentTasks: [], openTaskCount: 0, overdueTaskCount: 0,
    memberTodayTasks: [], tasksDoneToday: 0, wallTasks: [],
  };
}

/**
 * What each block answers when its own read fails. Not the empty form: a failed
 * count is `null` (the tile says "try again" instead of a plausible 0), and the
 * done count falls back to 0. Kept as the route wrote it.
 */
export const TASKS_BLOCK_FAILED: Readonly<TasksOverview> = Object.freeze({
  urgentTasks: [],
  openTaskCount: null,
  overdueTaskCount: null,
  memberTodayTasks: [],
  wallTasks: [],
  tasksDoneToday: 0,
});

const passThrough: SliceGuard = (_name, read) => read();

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', ${personAvatarUrlSql('u')}
  ) ORDER BY ta.user_id IS NOT t.assigned_to, ta.rowid)
  FROM task_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.task_id = t.id
) AS assigned_users_json`;

function addAssignedUsers(task: TaskRow): TaskRow {
  task.assigned_users = task.assigned_users_json ? JSON.parse(String(task.assigned_users_json)) : [];
  delete task.assigned_users_json;
  return task;
}

/** So many titles per member and state travel; the counts next to them are uncapped. */
const WALL_TASKS_PER_MEMBER = 6;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * The task blocks of the overview.
 *
 * @param db      the connection of the request
 * @param actor   the row reader of the request (rowReader(): a paired display and
 *                `audience=household` read under the wall rule)
 * @param ctx     today, zone and now of the request (no clock is read here)
 * @param options the task options of the request (category filter)
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function tasksOverviewSlice(
  db: Database,
  actor: RowReader,
  ctx: OverviewContext,
  options: TasksOverviewOptions = {},
  guard: SliceGuard = passThrough,
): TasksOverview {
  const { today, zone, now } = ctx;
  const userId = actor.userId;
  const taskCategories = [...(options.categories ?? [])];
  const taskCategoryFragment = taskCategoryWhere('t', taskCategories, { named: 'cat' });
  const taskCategoryAnd = taskCategoryFragment ? ` AND ${taskCategoryFragment}` : '';
  const taskCategoryBinds = categoryBindings(taskCategories, 'cat');
  const taskVisibleSql = taskVisibleWhere(actor, 't');

  // Open tasks: ordered in SQL (overdue first, then due date, then priority).
  // Faithful translation of the previous JS comparator:
  //   1. overdue (due_sort < now) before not-overdue
  //   2. within a group: earlier due date/time first; undated tasks last (NULLS LAST)
  //   3. ties broken by priority rank (urgent=0..none=4)
  // due_sort = due_date + due_time, falling back to 23:59:59 when only a date is set,
  // and NULL when there is no due_date at all (`||` with NULL is NULL). A NULL
  // due_sort is not overdue: CASE WHEN takes its branch only when the comparison is
  // true, and `NULL < @now` is NULL.
  const urgentTasks = guard('urgentTasks', () => {
    // Local, not UTC: the comparison is against `due_date || 'T' || due_time`, and
    // both are stored as local input values. A UTC stamp moved the "overdue"
    // boundary by the zone offset.
    const wall = utcToWall(now.toISOString(), zone);
    const nowIso = `${today}T${wall?.time
      ?? `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`}`;
    return (db.prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        ${ASSIGNED_USERS_SQL},
        t.due_date || 'T' || COALESCE(t.due_time, '23:59:59') AS __due_sort
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.status != 'done'
        -- Archived tasks do not belong in "today at a glance" (#688): an archived
        -- task is out of the run, and whoever opened it from here did not find it
        -- in the list again.
        AND t.archived_at IS NULL
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
      ORDER BY
        CASE WHEN __due_sort < @now THEN 0 ELSE 1 END ASC,
        __due_sort IS NULL ASC,
        __due_sort ASC,
        CASE t.priority
          WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
          WHEN 'low' THEN 3 ELSE 4
        END ASC
      LIMIT 5
    `).all({ now: nowIso, me: userId, today, ...taskCategoryBinds }) as TaskRow[])
      .map(({ __due_sort, ...task }) => addAssignedUsers(task));
  }, TASKS_BLOCK_FAILED.urgentTasks);

  // COUNTS FOR THE TILES. They cannot be derived from the lists: `urgentTasks`
  // stops at 5. Visibility as everywhere: the viewer counts only what they see.
  const openTaskCount = guard('openTaskCount', () => (db.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
    `).get({ me: userId, today, ...taskCategoryBinds }) as { n: number }).n, TASKS_BLOCK_FAILED.openTaskCount);

  // Overdue is the second line of the task tile: "7 open" alone does not say
  // whether something is burning.
  const overdueTaskCount = guard('overdueTaskCount', () => (db.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND t.due_date < @today
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
    `).get({ today, me: userId, ...taskCategoryBinds }) as { n: number }).n, TASKS_BLOCK_FAILED.overdueTaskCount);

  // "Due today" card: per member the count of open tasks due today or overdue. Its
  // own aggregation, not a count over urgentTasks, whose cap of 5 would skew the
  // numbers per member.
  const memberTodayTasks = guard('memberTodayTasks', () => db.prepare(`
      SELECT ta.user_id AS user_id, COUNT(*) AS open_count
      FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND t.due_date <= @today
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
      GROUP BY ta.user_id
    `).all({ today, me: userId, ...taskCategoryBinds }) as MemberCount[], TASKS_BLOCK_FAILED.memberTodayTasks);

  // The wall names the tasks (#1817), see wallTasksByMember().
  const wallTasks = guard('wallTasks', () => wallTasksByMember(db, {
    today,
    zone,
    now,
    categoryAnd: taskCategoryAnd,
    categoryBinds: taskCategoryBinds,
  }), TASKS_BLOCK_FAILED.wallTasks);

  // "All done" state of the day program: only with the count of tasks due today and
  // already done can "all done" be told apart from "nothing was due today".
  const tasksDoneToday = guard('tasksDoneToday', () => (db.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status = 'done' AND t.archived_at IS NULL
        AND t.due_date = @today
        AND ${taskScopeWhere('t', { bind: '@today' })}
        AND ${taskVisibleSql}${taskCategoryAnd}
    `).get({ today, me: userId, ...taskCategoryBinds }) as { n: number }).n, TASKS_BLOCK_FAILED.tasksDoneToday);

  return { urgentTasks, openTaskCount, overdueTaskCount, memberTodayTasks, wallTasks, tasksDoneToday };
}

/**
 * Today's tasks per member, WITH TITLES, for the wall (#1817).
 *
 * WHY A READ OF ITS OWN. `urgentTasks` is capped at five household-wide - what
 * stands under one person cannot be read from it. `memberTodayTasks` is uncapped
 * but carries only a number.
 *
 * ONLY `visibility = 'all'`, AND THAT IS NOT THE VIEWER RULE. A wall tablet is no
 * person - it hangs in the kitchen, and wall mode opens from any session. A task
 * set to "assignees only" or private is therefore on no wall, not even when the
 * wall was opened from the assignee's session. `'all'` is a subset of what every
 * viewer sees anyway; the read releases nothing the viewer does not already have.
 *
 * "TODAY" FOR A PERSON: open is what is due today or earlier. Done is what was due
 * today, plus what was overdue and was ticked TODAY, so a task from yesterday gets
 * its tick instead of vanishing. The day of a completion is the HOUSEHOLD's
 * (`completed_at` is a UTC instant).
 *
 * SEVERAL ASSIGNEES: the task stands under each of them, as memberTodayTasks counts
 * it.
 */
function wallTasksByMember(
  d: Database,
  { today, zone, now, categoryAnd = '', categoryBinds = {} }: {
    today: string;
    zone: string;
    now: Date;
    categoryAnd?: string;
    categoryBinds?: Record<string, string>;
  },
): WallMember[] {
  // Coarse preselection in SQL (48 hours cover every zone), the day itself is
  // decided below in the household zone.
  const since = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const rows = d.prepare(`
    SELECT ta.user_id AS user_id, t.id, t.title, t.status, t.due_date, tc.completed_at
    FROM tasks t
    JOIN task_assignments ta ON ta.task_id = t.id
    LEFT JOIN task_completions tc ON tc.task_id = t.id
    WHERE t.archived_at IS NULL
      AND ${householdVisibleWhere('t')}
      AND t.due_date <= @today
      AND ${taskScopeWhere('t', { bind: '@today' })}${categoryAnd}
      AND (t.status != 'done' OR t.due_date = @today OR tc.completed_at >= @since)
    ORDER BY
      t.due_date ASC,
      t.due_time IS NULL ASC, t.due_time ASC,
      CASE t.priority
        WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
        WHEN 'low' THEN 3 ELSE 4
      END ASC,
      t.id ASC
  `).all({ today, since, ...categoryBinds }) as {
    user_id: number; id: number; title: string; status: string; due_date: string; completed_at: string | null;
  }[];

  const byMember = new Map<number, WallMember>();
  for (const row of rows) {
    const isDone = row.status === 'done';
    if (isDone && row.due_date !== today
      && utcToWall(row.completed_at as string, zone)?.date !== today) continue;
    let entry = byMember.get(row.user_id);
    if (!entry) {
      entry = { user_id: row.user_id, open_count: 0, done_count: 0, open: [], done: [] };
      byMember.set(row.user_id, entry);
    }
    if (isDone) {
      entry.done_count += 1;
      if (entry.done.length < WALL_TASKS_PER_MEMBER) entry.done.push({ id: row.id, title: row.title });
    } else {
      entry.open_count += 1;
      if (entry.open.length < WALL_TASKS_PER_MEMBER) {
        entry.open.push({ id: row.id, title: row.title, due_date: row.due_date });
      }
    }
  }
  return [...byMember.values()];
}
