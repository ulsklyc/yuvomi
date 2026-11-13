/**
 * Module: the actor's types (phase 2, section B2)
 * Purpose: The shape of the actor, apart from the code that builds it (actor.ts)
 *          and the code that decides with it (modules.ts). actor.ts imports values
 *          from modules.ts; were the type in actor.ts, modules.ts would import it
 *          back and close a cycle (dependency-cruiser `no-circular`, type imports
 *          included). Types only: this file has no runtime content.
 * Erasable TS syntax only (runs through type stripping, no build).
 */

export type ActorKind = 'session' | 'token' | 'display' | 'guest' | 'system' | 'household';

export type ModuleAccess = Readonly<Record<string, 'none' | 'read'>>;

export type Actor = Readonly<{
  kind: ActorKind;
  /** null only for 'household' - and for a request without an account id, see kindOf(). */
  userId: number | null;
  /** The role as it counts in THIS request: a device token of an admin is a member. */
  role: 'admin' | 'member' | null;
  familyRole: string | null;
  /** null = no scoping. */
  scopes: readonly string[] | null;
  /** null = unrestricted (admin, or nothing restricted). */
  moduleAccess: ModuleAccess | null;
  deviceId: number | null;
  /**
   * A lookup that decides the kind failed, the two lookups contradict each other
   * (a split guest that is also a display), or the request carries no account /
   * never passed requireAuth. A caller that must fail closed treats it as closed.
   * Always false for actorForUser() and householdAudience().
   */
  unresolved: boolean;
}>;
