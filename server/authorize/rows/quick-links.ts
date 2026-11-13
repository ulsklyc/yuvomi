/**
 * Module: row visibility of quick links (phase 2, section B3; until then the
 *         constant VISIBLE_WHERE in server/routes/quick-links.js)
 * Purpose: which quick links a viewer sees: the shared ones and their own.
 *
 *          The row forms (B8b, until then server/routes/quick-links.js): the same
 *          rule for one loaded tile, who may edit a tile, and the 404 of PUT/DELETE.
 *
 * Dependencies: none. Erasable TS syntax only (runs through type stripping, no build).
 */

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

/** The row form of quickLinkVisibleWhere(): shared, or the viewer's own. */
export function quickLinkRowVisible(row: QuickLinkRow, viewerId: unknown): boolean {
  return row.visibility === 'all' || Number(row.created_by) === Number(viewerId);
}

/**
 * Is the tile hidden from `viewerId` for PUT and DELETE (their 404)? A foreign
 * private tile does not exist for this person - 404 and not 403, or the answer
 * gives its existence away.
 *
 * NOT written as !quickLinkRowVisible(): quick_links.visibility has no CHECK, and
 * for a value other than 'all' and 'private' (the route writes neither, a restored
 * file could carry one) the fragment hides the tile while this check lets it on to
 * canEditQuickLink(), which answers 403. Kept as it was (B8b changes no answer);
 * for the two stored levels both are the same set (test:authorize-rows).
 */
export function quickLinkHiddenFrom(row: QuickLinkRow, viewerId: unknown): boolean {
  return row.visibility === 'private' && row.created_by !== viewerId;
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
