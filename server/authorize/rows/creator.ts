/**
 * Module: the creator comparison of the row forms (B8b follow-up)
 * Purpose: is a loaded row the viewer's own? One comparison for every row form
 *          (quickLinkRowVisible, assignableRowVisible for tasks and events), the
 *          same answer as the SQL fragments' `created_by = @me`.
 *
 * Dependencies: none. Erasable TS syntax only (runs through type stripping, no build).
 * Not exported through server/authorize/index.ts: callers ask rowVisible().
 */

/**
 * Is `createdBy` the account `viewerId`, as SQLite compares `created_by = <id>`?
 *
 * created_by is INTEGER without CHECK. SQLite turns '5', ' 5', '5.0', '05' into the
 * integer 5 on write, so the driver hands back the number; a value it cannot read as
 * a number ('0x5', '0b101', '') stays TEXT and never equals an integer id in SQL.
 * Number() would read '0x5' as 5 - and '' or 0 as the 0 of Number(null). So: a
 * creator that is not a number (NULL, TEXT) is nobody's own row, and only a viewer
 * that is a number owns anything. Every caller passes an account id as a number or
 * null (requireAuth, getUserId, the session); a viewer of null or undefined owns
 * nothing, as `created_by = NULL` matches no row.
 */
export function isOwnRow(createdBy: unknown, viewerId: unknown): boolean {
  return typeof createdBy === 'number' && typeof viewerId === 'number' && createdBy === viewerId;
}
