/**
 * Module: who reads a task or an event (phase 2, wall rule at every task and event read)
 * Purpose: the one place that decides which row rule a task or event read applies to
 *          the request: a paired display reads under the wall rule (what the whole
 *          household sees, rows/household.ts and rows/ics-subscriptions.ts), every
 *          other account under the row rule of the type (rows/assignees.ts and
 *          rows/ics-subscriptions.ts through rows/index.ts). Before this file the reads
 *          asked the row rule with the display account as the viewer; a read that did
 *          so showed the display a task or an event that named it as an assignee.
 *
 * The wall rule is a subset of the row rule for every viewer (`all` and a shared
 * subscription are visible to everyone), so the reader only ever narrows what a
 * display gets; people keep the row rule unchanged.
 *
 * The task names (taskReader, taskVisibleWhere, taskRowVisible) are the same reader
 * for the type 'tasks', kept with their signatures for the task reads.
 *
 * Dependencies: rows/index.ts, rows/household.ts, rows/ics-subscriptions.ts. Erasable
 * TS syntax only (runs through type stripping, no build).
 */

import type { Database } from '../catalog.ts';
import { householdVisible, householdVisibleWhere } from './household.ts';
import { icsSubscriptionSharedWhere } from './ics-subscriptions.ts';
import { rowVisible, visibleWhere } from './index.ts';

/**
 * A row reader: the account that asks, and whether it reads as the wall.
 * `userId` is the viewer of the row rule; the wall rule has no viewer.
 */
export type RowReader = Readonly<{ userId: unknown; wall: boolean }>;
export type TaskReader = RowReader;

/**
 * The types a reader reads. 'ics_subscriptions' is the second axis of an event (the
 * subscription it comes from), asked next to 'events' at every event read.
 */
type ReaderType = 'tasks' | 'events' | 'ics_subscriptions';

/** The request fields rowReader() reads (set by requireAuth). */
type ReaderRequest = {
  authMethod?: unknown;
  authUserId?: unknown;
  session?: { userId?: unknown } | null;
} | null | undefined;

/** The wall fragment per type: no viewer, nothing bound. */
const WALL_WHERE: Readonly<Record<ReaderType, (alias: string) => string>> = Object.freeze({
  tasks: householdVisibleWhere,
  events: householdVisibleWhere,
  ics_subscriptions: icsSubscriptionSharedWhere,
});

function checkedType(type: ReaderType, what: string): ReaderType {
  if (!Object.hasOwn(WALL_WHERE, type)) throw new TypeError(`${what}: unknown reader type '${String(type)}'`);
  return type;
}

/**
 * The reader of a request. A paired display (`req.authMethod === 'display'`, the same
 * flag requireAuth sets and isDisplayRequest() reads) reads as the wall; so does any
 * account when `household` is set (the wall audience of GET /dashboard, which only
 * narrows).
 */
export function rowReader(req: ReaderRequest, { household = false }: { household?: boolean } = {}): RowReader {
  return Object.freeze({
    userId: req?.authUserId || req?.session?.userId,
    wall: household === true || req?.authMethod === 'display',
  });
}

/** The reader of the person rule for `userId`: for callers without a request. */
export function personReader(userId: unknown): RowReader {
  return Object.freeze({ userId, wall: false });
}

/**
 * WHERE fragment (without a leading AND): the rows of `type` under `alias` this
 * reader sees. For people the row rule of the type with the viewer bound as `viewer`;
 * for the wall a fragment that binds nothing - a named bind object that still carries
 * the viewer is fine, positional binds take readerBinds().
 */
export function readerVisibleWhere(reader: RowReader, type: ReaderType, alias: string, viewer: string): string {
  const checked = checkedType(type, 'readerVisibleWhere');
  return reader.wall ? WALL_WHERE[checked](alias) : visibleWhere(checked, alias, viewer);
}

/**
 * The positional values readerVisibleWhere(reader, type, alias, '?') takes, in order:
 * the viewer once per placeholder of the person fragment, none for the wall.
 */
export function readerBinds(reader: RowReader, type: ReaderType): unknown[] {
  if (reader.wall) {
    checkedType(type, 'readerBinds');
    return [];
  }
  const placeholders = readerVisibleWhere(reader, type, 'x', '?').split('?').length - 1;
  return Array.from({ length: placeholders }, () => reader.userId);
}

/** The row form of readerVisibleWhere() for one task or event row the caller has loaded. */
export function readerRowVisible(
  database: Database,
  reader: RowReader,
  type: 'tasks' | 'events',
  row: Record<string, unknown> | null | undefined,
): boolean {
  if (type !== 'tasks' && type !== 'events') throw new TypeError(`readerRowVisible: no row check for '${String(type)}'`);
  if (row == null) return false;
  return reader.wall ? householdVisible(row) : rowVisible(database, type, row, reader.userId);
}

/** The reader of a task read: rowReader(). */
export function taskReader(req: ReaderRequest): TaskReader {
  return rowReader(req);
}

/** readerVisibleWhere() for tasks, the viewer bound as `viewer` (default '@me'). */
export function taskVisibleWhere(reader: TaskReader, alias: string, viewer = '@me'): string {
  return readerVisibleWhere(reader, 'tasks', alias, viewer);
}

/** readerRowVisible() for one task row. */
export function taskRowVisible(
  database: Database,
  reader: TaskReader,
  row: Record<string, unknown> | null | undefined,
): boolean {
  return readerRowVisible(database, reader, 'tasks', row);
}
