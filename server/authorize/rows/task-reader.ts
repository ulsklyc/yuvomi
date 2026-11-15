/**
 * Module: who reads a task (phase 2, wall rule at every task read)
 * Purpose: the one place that decides which row rule a task read applies to the
 *          request: a paired display reads under the wall rule (what the whole
 *          household sees, rows/household.ts), every other account under the task
 *          row rule (rows/assignees.ts through rows/index.ts). Before this file the
 *          routes asked `isDisplayRequest(req) ? householdVisible : rowVisible` at each
 *          read; a read that forgot the branch showed the display a task that named it
 *          as an assignee.
 *
 * The wall rule is a subset of the row rule for every viewer (`all` is visible to
 * everyone), so the reader only ever narrows what a display gets; people keep the
 * row rule unchanged.
 *
 * Dependencies: rows/index.ts, rows/household.ts. Erasable TS syntax only (runs
 * through type stripping, no build).
 */

import type { Database } from '../catalog.ts';
import { householdVisible, householdVisibleWhere } from './household.ts';
import { rowVisible, visibleWhere } from './index.ts';

/**
 * A task reader: the account that asks, and whether it reads as the wall.
 * `userId` is the viewer of the row rule; the wall rule has no viewer.
 */
export type TaskReader = Readonly<{ userId: unknown; wall: boolean }>;

/** The request fields taskReader() reads (set by requireAuth). */
type ReaderRequest = {
  authMethod?: unknown;
  authUserId?: unknown;
  session?: { userId?: unknown } | null;
} | null | undefined;

/**
 * The reader of a request. A paired display (`req.authMethod === 'display'`, the same
 * flag requireAuth sets and isDisplayRequest() reads) reads as the wall.
 */
export function taskReader(req: ReaderRequest): TaskReader {
  return Object.freeze({
    userId: req?.authUserId || req?.session?.userId,
    wall: req?.authMethod === 'display',
  });
}

/**
 * WHERE fragment (without a leading AND): the tasks under `alias` this reader sees.
 * For people the task row rule with the viewer bound as `viewer` (default '@me');
 * for the wall householdVisibleWhere(), which binds nothing - a named bind object
 * that still carries `me` is fine, positional binds must leave the viewer out.
 */
export function taskVisibleWhere(reader: TaskReader, alias: string, viewer = '@me'): string {
  return reader.wall ? householdVisibleWhere(alias) : visibleWhere('tasks', alias, viewer);
}

/** The row form of taskVisibleWhere() for one task row the caller has loaded. */
export function taskRowVisible(
  database: Database,
  reader: TaskReader,
  row: Record<string, unknown> | null | undefined,
): boolean {
  if (row == null) return false;
  return reader.wall ? householdVisible(row) : rowVisible(database, 'tasks', row, reader.userId);
}
