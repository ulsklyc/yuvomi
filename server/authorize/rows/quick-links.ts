/**
 * Module: row visibility of quick links (phase 2, section B3; until then the
 *         constant VISIBLE_WHERE in server/routes/quick-links.js)
 * Purpose: which quick links a viewer sees: the shared ones and their own.
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
