/**
 * Module: row visibility of quick links (phase 2, section B3; until then the
 *         constant VISIBLE_WHERE in server/routes/quick-links.js)
 * Purpose: which quick links a viewer sees: the shared ones and their own.
 *
 *          The row forms (B8b, until then server/routes/quick-links.js): the same
 *          rule for one loaded tile (also the 404 of PUT/DELETE, through
 *          rowVisible()) and who may edit a tile.
 *
 * Dependencies: creator.ts (the creator comparison). Erasable TS syntax only (runs
 * through type stripping, no build).
 */

import { isOwnRow } from './creator.ts';

/**
 * WHERE-Fragment: was diese Person sehen darf.
 * Geteilte Kacheln sehen alle; private nur ihre Urheberin - auch Admins nicht,
 * wie überall sonst in dieser App (vgl. authorize/rows/assignees.ts).
 *
 * The viewer is a bind token; the route binds `@me`, the default here.
 */
export function quickLinkVisibleWhere(alias: string, viewer: string = '@me'): string {
  return `(${alias}.visibility = 'all' OR ${alias}.created_by = ${viewer})`;
}

/** The columns of a quick link the row rules read. */
export type QuickLinkRow = { visibility?: unknown; created_by?: unknown };

/**
 * The row form of quickLinkVisibleWhere(): shared, or the viewer's own. The creator
 * is compared as SQL compares `created_by = @me` (isOwnRow): a tile without a
 * creator (quick_links.created_by is nullable) or with a TEXT creator is nobody's
 * own, and a viewer of null owns none.
 */
export function quickLinkRowVisible(row: QuickLinkRow, viewerId: unknown): boolean {
  if (row.visibility === 'all') return true;
  return isOwnRow(row.created_by, viewerId);
}

/**
 * May this person change or delete the tile?
 *
 * ANYONE MAY CREATE, NOT ANYONE MAY CHANGE. A shared tile sits on the start page
 * of the whole household; it belongs to the person who set it, and to the admin.
 * A private one belongs to its author alone - an admin allowed to edit it could
 * also read it by the detour "make it shared".
 *
 * (Moved unchanged from mayEdit() in server/routes/quick-links.js, B8b; only
 * `isAdmin === true` counts.)
 */
export function canEditQuickLink(row: QuickLinkRow, userId: unknown, isAdmin: unknown): boolean {
  if (row.created_by === userId) return true;
  return row.visibility === 'all' && isAdmin === true;
}
