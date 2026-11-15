/**
 * Module: the admin rule (phase 2, section C1)
 * Purpose: THE ONE place where a role is compared with 'admin' as the right to
 *          manage the household. authorize(actor, 'manage', { household: true })
 *          (modules.ts) answers with it; the few questions that run before an
 *          actor may be built (resolveRequestModuleAccess in actor.ts, inside
 *          requireAuth) or that hold a `users` row instead of an actor
 *          (resolvePermissions in catalog.ts, userHasCapability in modules.ts)
 *          ask it directly.
 *
 * Its own file, not modules.ts: catalog.ts asks it, and modules.ts imports
 * catalog.ts - the rule there would close a cycle (dependency-cruiser
 * `no-circular`).
 *
 * Not this rule: an admin of a split-expense group (a group role) and the role
 * of ANOTHER account a route reads or writes (account administration). Those
 * compare a row's own field.
 *
 * No imports. Erasable TS syntax only (runs through type stripping, no build).
 */

/** Does this role manage the household? `admin` does; every other value, null included, does not. */
export function managesHousehold(role: string | null | undefined): boolean {
  return role === 'admin';
}
