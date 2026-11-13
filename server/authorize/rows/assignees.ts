/**
 * Module: row visibility of tasks and events (phase 2, section B3; until then
 *         server/services/visibility.js)
 * Purpose: the rule all / assignees / private that tasks and events carry, as an SQL
 *          fragment for every read path. The viewer is a bind token the caller names
 *          ('?', '@me', a column expression, NULL), not a value.
 *
 *          rowVisible() in rows/index.ts asks the same rule of ONE row a caller has
 *          already loaded: assignableRowVisible() below, next to the fragment (B8b).
 *
 * Dependencies: catalog.ts for the Database type only; never server/db.js. Erasable
 * TS syntax only (runs through type stripping, no build).
 */

import type { Database } from '../catalog.ts';
import { isOwnRow } from './creator.ts';

// --------------------------------------------------------
// Sichtbarkeit pro Aufgabe/Termin (#474): all | assignees | private.
//
//   all       – für alle Familienmitglieder sichtbar (Default, Altverhalten)
//   assignees – nur für Ersteller:in und zugewiesene Personen
//   private   – nur für die Ersteller:in
//
// Die Durchsetzung ist rein serverseitig (kein Admin-Bypass): jeder Lesepfad,
// der Aufgaben/Termine an eine betrachtende Person ausliefert, hängt das
// entsprechende WHERE-Fragment an. Der Kalender-Export (ICS-Feed) bleibt bewusst
// ungefiltert — Sichtbarkeit ist eine In-App-Kontrolle (#474, bestätigt).
// --------------------------------------------------------

export const VISIBILITY_VALUES = ['all', 'assignees', 'private'];

/** Normalisiert einen eingehenden Wert auf eine gültige Stufe. */
export function normalizeVisibility(value: unknown, fallback: string = 'all'): string {
  return VISIBILITY_VALUES.includes(value as string) ? value as string : fallback;
}

/**
 * WHERE-Fragment für die Sichtbarkeits-Durchsetzung.
 *
 * @param {string} alias        Tabellen-Alias der Aufgaben/Termine (z. B. 't' oder 'e')
 * @param {string} assignTable  Zuweisungs-Tabelle ('task_assignments' | 'event_assignments')
 * @param {string} assignCol    FK-Spalte darin ('task_id' | 'event_id')
 * @param {string} bind         Parameter-Platzhalter der betrachtenden User-ID.
 *                              '?' (positional, zwei Binds nötig) oder benannt wie '@me'
 *                              (dann genügt ein einzelner benannter Bind).
 * @returns {string} SQL-Fragment (ohne führendes AND)
 */
export function visibilityWhere(alias: string, assignTable: string, assignCol: string, bind: string = '?'): string {
  return `(
    ${alias}.visibility = 'all'
    OR ${alias}.created_by = ${bind}
    OR (${alias}.visibility = 'assignees' AND EXISTS (
          SELECT 1 FROM ${assignTable} vx
          WHERE vx.${assignCol} = ${alias}.id AND vx.user_id = ${bind}))
  )`;
}

/** The columns of a task or event row the row rule reads. */
export type AssignableRow = { id?: unknown; visibility?: unknown; created_by?: unknown };

/**
 * The row form of visibilityWhere(): does `viewerId` see this loaded task or event?
 * Same three branches as the fragment - 'all', the creator, an assignment on an
 * 'assignees' row - with no admin bypass (#474).
 *
 * Why the write paths ask it (#748/#769): PUT and DELETE of a task loaded the row
 * by id and worked on it without asking; whoever knew a foreign id could change or
 * delete someone else's private task. The rule is deliberately the read rule and
 * no narrower one: who sees a task may edit it in the household, that is the
 * module's standing promise. New was only that the invisible is also untouchable.
 *
 * The creator is compared as SQL compares `created_by = @me` (isOwnRow): a TEXT
 * creator such as '0x5' (only a restore or direct database access writes one) is
 * nobody's own row. Number() on both sides, as B8b had it, read '0x5' as account 5
 * and opened a private task the list hides.
 *
 * EXCEPT with `assignedIds` (the Outlook target, hasConfiguredOutlookAutoSyncTarget):
 * there the creator stays compared through Number(), as before B8b. A narrower
 * answer there says "no auto-sync target", which makes the series eligible for
 * occurrence overrides - a capability nobody had before. Changing that is a
 * decision of its own, not part of this alignment.
 *
 * `assignedIds` given (account ids, numbers or numeric strings): the assignments
 * are those, nothing is read - the row may carry values that are not stored yet
 * (the Outlook target of a proposed series). Without it the assignment table is
 * read once, and only on the 'assignees' branch of a row neither open nor own.
 */
export function assignableRowVisible(
  database: Database,
  assignTable: string,
  assignCol: string,
  row: AssignableRow,
  viewerId: unknown,
  assignedIds?: readonly unknown[],
): boolean {
  if (row.visibility === 'all') return true;
  const own = assignedIds === undefined
    ? isOwnRow(row.created_by, viewerId)
    : Number(row.created_by) === Number(viewerId);
  if (own) return true;
  if (row.visibility !== 'assignees') return false;
  if (assignedIds !== undefined) return assignedIds.map(Number).includes(Number(viewerId));
  return !!database.prepare(
    `SELECT 1 FROM ${assignTable} WHERE ${assignCol} = ? AND user_id = ?`
  ).get(row.id, viewerId);
}
