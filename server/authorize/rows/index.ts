/**
 * Module: row visibility by data type (phase 2, section B3)
 * Purpose: ONE entry point for "the rows of this type a viewer sees": visibleWhere()
 *          as an SQL fragment, filterVisible() as a list of ids derived from it. The
 *          rule of each type stays in its own file (rows/<type>.ts); this file only
 *          names the fixed tables and the default viewer per type, so a caller does
 *          not pick an assignment table or a parameter spelling itself.
 *
 *          The viewer is a bind token the caller names ('?', '@me', '@userId', a
 *          column expression, 'NULL'), not a value: the fragments stay plain text and
 *          no caller's bind list changes.
 *
 * Dependencies: the rule files next to this one. Erasable TS syntax only (runs
 * through type stripping, no build).
 */

import type { Database } from '../catalog.ts';
import { assignableRowVisible, visibilityWhere } from './assignees.ts';
import { budgetVisibilityWhere } from './budget.ts';
import { documentVisibleWhere, filterVisibleIds } from './documents.ts';
import { icsSubscriptionVisibleWhere } from './ics-subscriptions.ts';
import { categoryVisibleWhere, noteVisibleWhere } from './notes.ts';
import { quickLinkRowVisible, quickLinkVisibleWhere } from './quick-links.ts';
import { reminderTargetVisibleSql } from './reminders.ts';

/** The data types with a "visible to this viewer" rule. */
type RowType =
  | 'tasks'
  | 'events'
  | 'notes'
  | 'note_categories'
  | 'documents'
  | 'budget'
  | 'reminders'
  | 'ics_subscriptions'
  | 'quick_links';

/**
 * `mode` is the household budget mode (required for 'budget'); `database` is the
 * connection the reminder rule reads the budget mode from (required for 'reminders').
 */
type VisibleWhereOptions = { mode?: string | null; database?: Database };

type RowRule = (alias: string, viewer: string | undefined, options: VisibleWhereOptions) => string;

function required<T>(value: T | null | undefined, what: string, type: string): T {
  if (value === undefined || value === null) {
    throw new TypeError(`visibleWhere('${type}'): ${what} is required`);
  }
  return value;
}

/**
 * The assignment table and its key column per assignable type: the one list both
 * visibleWhere() and rowVisible() read.
 */
const ASSIGNMENTS = Object.freeze({
  tasks: Object.freeze(['task_assignments', 'task_id'] as const),
  events: Object.freeze(['event_assignments', 'event_id'] as const),
});

/** Per type: the rule with its fixed tables and the default viewer of the old function. */
const ROW_RULES: Readonly<Record<RowType, RowRule>> = Object.freeze({
  tasks: (alias, viewer = '?') => visibilityWhere(alias, ...ASSIGNMENTS.tasks, viewer),
  events: (alias, viewer = '?') => visibilityWhere(alias, ...ASSIGNMENTS.events, viewer),
  notes: (alias, viewer = '?') => noteVisibleWhere(alias, viewer),
  note_categories: (alias, viewer = '?') => categoryVisibleWhere(alias, viewer),
  documents: (alias, viewer = '@userId') => documentVisibleWhere(alias, viewer),
  budget: (alias, viewer, { mode }) => budgetVisibilityWhere(
    alias,
    required(viewer, 'a viewer', 'budget'),
    { mode: required(mode, 'options.mode', 'budget') },
  ),
  reminders: (alias, viewer = `${alias}.created_by`, { database }) =>
    reminderTargetVisibleSql(required(database, 'options.database', 'reminders'), alias, viewer),
  ics_subscriptions: (alias, viewer = '?') => icsSubscriptionVisibleWhere(alias, viewer),
  quick_links: (alias, viewer = '@me') => quickLinkVisibleWhere(alias, viewer),
});

/**
 * The tables filterVisible() can name. Budget (three tables), reminders (the viewer
 * is a column of the row) and ICS subscriptions (a rule over events) have none.
 */
const ROW_TABLES: Readonly<Partial<Record<RowType, string>>> = Object.freeze({
  tasks: 'tasks',
  events: 'calendar_events',
  notes: 'notes',
  note_categories: 'note_categories',
  documents: 'family_documents',
  quick_links: 'quick_links',
});

/**
 * WHERE fragment (without a leading AND): the rows of `type` under `alias` that the
 * viewer bound as `viewer` sees. Throws for an unknown type and a missing required
 * option instead of answering.
 */
export function visibleWhere(type: RowType, alias: string, viewer?: string, options: VisibleWhereOptions = {}): string {
  const rule = Object.hasOwn(ROW_RULES, type) ? ROW_RULES[type] : undefined;
  if (!rule) throw new TypeError(`visibleWhere: unknown row type '${String(type)}'`);
  return rule(alias, viewer, options);
}

/**
 * Reduces a list of ids of `type` to those `viewerId` sees, through the fragment of
 * visibleWhere() - no second rule. Unknown and invisible ids drop out silently; the
 * order is the given one, without duplicates.
 */
export function filterVisible(
  database: Database,
  type: RowType,
  ids: readonly unknown[] | null | undefined,
  viewerId: unknown,
  options: VisibleWhereOptions = {},
): number[] {
  const visible = visibleWhere(type, 'd', '@userId', options);
  const table = Object.hasOwn(ROW_TABLES, type) ? ROW_TABLES[type] : undefined;
  if (!table) throw new TypeError(`filterVisible: no table for row type '${String(type)}'`);
  return filterVisibleIds(database, table, visible, ids, viewerId);
}

/** `assignedIds`: the assignments of a task or event row, handed in instead of read. */
type RowVisibleOptions = { assignedIds?: readonly unknown[] };

type RowCheck = (database: Database, row: Record<string, unknown>, viewerId: unknown, options: RowVisibleOptions) => boolean;

/**
 * Per type: the row form of the rule in ROW_RULES, from the same rule file. Only the
 * types a caller asks about one loaded row (B8b) have one.
 */
const ROW_CHECKS: Readonly<Partial<Record<RowType, RowCheck>>> = Object.freeze({
  tasks: (database, row, viewerId, { assignedIds }) =>
    assignableRowVisible(database, ...ASSIGNMENTS.tasks, row, viewerId, assignedIds),
  events: (database, row, viewerId, { assignedIds }) =>
    assignableRowVisible(database, ...ASSIGNMENTS.events, row, viewerId, assignedIds),
  quick_links: (_database, row, viewerId) => quickLinkRowVisible(row, viewerId),
});

/**
 * Does `viewerId` see this row of `type`, already loaded by the caller? The row
 * form of visibleWhere() - the same rule, the same answer (test:authorize-rows
 * holds both against each other) - for the write paths that load a row by id and
 * must not act on one the viewer cannot see.
 *
 * Throws for an unknown type and for a type without a row form instead of
 * answering; a missing row is not visible. `options.assignedIds` (tasks, events):
 * see assignableRowVisible() - with it nothing is read; without it the assignment
 * table is read at most once, on the 'assignees' branch.
 */
export function rowVisible(
  database: Database,
  type: RowType,
  row: Record<string, unknown> | null | undefined,
  viewerId: unknown,
  options: RowVisibleOptions = {},
): boolean {
  if (!Object.hasOwn(ROW_RULES, type)) throw new TypeError(`rowVisible: unknown row type '${String(type)}'`);
  const check = Object.hasOwn(ROW_CHECKS, type) ? ROW_CHECKS[type] : undefined;
  if (!check) throw new TypeError(`rowVisible: no row check for row type '${String(type)}'`);
  if (row == null) return false;
  return check(database, row, viewerId, options);
}
