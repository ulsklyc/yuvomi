/**
 * Module: the actor (phase 2, section B1)
 * Purpose: ONE place where the actor of a permission question is built - who asks,
 *          in which kind, with which role, scopes and module rights. Every later
 *          question of server/authorize/ starts from this value.
 *
 * Three builders:
 *   - actorFromRequest(req): the actor of an authenticated request, built once per
 *     request from the fields requireAuth set (server/auth.js), plus the two
 *     lookups that decide the kind (split guest, display account).
 *   - actorForUser(database, userId): the actor without a request (scheduler, push,
 *     feeds), from the `users` row and the permission matrix.
 *   - householdAudience(): the household as a whole, no account behind it.
 *
 * resolveRequestModuleAccess(database, req) is the module-rights resolution
 * requireAuth runs for every branch; it moved here from `applyRoleModuleAccess` in
 * server/auth.js, which still sets `req.sessionModuleAccess` from its result.
 *
 * `req.authRole`, `req.authUserId` and their siblings stay where they are: B1 adds
 * the actor next to them and moves no reader over.
 *
 * THIS MODULE NEVER LOADS server/db.js, NOT EVEN TRANSITIVELY. db.js opens the
 * database on import, and server/openapi.js reaches this file through
 * services/reminder-origins.js: a static import here would open (or create) a
 * database for every importer of the OpenAPI spec. The connection comes in as a
 * parameter - from requireAuth for a request, from the caller for actorForUser().
 * test:authorize-actor holds this in a child process.
 *
 * Dependencies: server/logger.js, server/middleware/require-admin.js,
 *   catalog.ts, modules.ts, types.ts (none of them loads db.js).
 * Erasable TS syntax only (runs through type stripping, no build).
 */

import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { resolvePermissions } from './catalog.ts';
import { buildSessionModuleAccess, userForRequest } from './modules.ts';
import type { Actor, ActorKind, ModuleAccess } from './types.ts';

// The logger of server/auth.js: the resolution moved, its log line did not change.
const log = createLogger('Auth');

/** The fields requireAuth sets on a request; nothing else is read here. */
type AuthenticatedRequest = {
  authMethod?: string;
  authUserId?: number | null;
  authRole?: string | null;
  authScopes?: readonly string[] | null;
  authDeviceId?: number | null;
  sessionModuleAccess?: ModuleAccess | null;
};

type Database = Parameters<typeof resolvePermissions>[0];

// `family_role` is NULL in the database for some accounts; typed optional to match resolvePermissions().
type UserRow = { id: number; role: string; family_role?: string };

// Kept per request object, not as a field on it: nothing else can read or overwrite
// them, and they go with the request. `requests` is written by
// resolveRequestModuleAccess(), i.e. by requireAuth: the connection the request was
// authenticated on, and the family role from its `users` lookup.
const actors = new WeakMap<object, Actor>();
const requests = new WeakMap<object, { database: Database; familyRole: string | null }>();

function roleOf(role: string | null | undefined): Actor['role'] {
  return role === 'admin' || role === 'member' ? role : null;
}

/**
 * The module rights of an authenticated request (#467): `null` = unrestricted.
 *
 * Role and member rights hold whether the subject signed in interactively or
 * through an integration token. Admins: null = full access. Token scopes stay an
 * additional least-privilege limit and can never widen these rights.
 *
 * Safe to skip the lookup for an admin: for every path `authRole` comes from the
 * database or is fixed to `member` (session and token read `users`, devices and
 * displays are members), never from a stored session (#2611).
 *
 * A failure is logged and answers `null`, as before the move: requireAuth does not
 * turn a failed resolution into a refused request.
 *
 * THE CONNECTION AND THE FAMILY ROLE ARE RECORDED HERE, for actorFromRequest():
 * the connection for every request, admins included; the family role from the one
 * `users` lookup this already makes.
 * For an admin there is no lookup, so an admin's actor carries `familyRole: null`;
 * reading it would cost a further query per request. Merging this lookup into the
 * session branch's own `SELECT u.role FROM users` is not done: that one is not
 * guarded, and a failure there (a database without `family_role`) would turn
 * today's swallowed error into a 500.
 */
export function resolveRequestModuleAccess(database: Database, req: AuthenticatedRequest): ModuleAccess | null {
  const entry = { database, familyRole: null as string | null };
  requests.set(req, entry);
  if (isAdminRequest(req)) return null;
  try {
    const user = database
      .prepare('SELECT id, role, family_role FROM users WHERE id = ?')
      .get(req.authUserId) as UserRow | undefined;
    if (!user) return null;
    entry.familyRole = user.family_role ?? null;
    return buildSessionModuleAccess(
      resolvePermissions(database, userForRequest(req, user), { isDisplay: req.authMethod === 'display' }),
    );
  } catch (err) {
    log.error('Permission resolution failed:', (err as Error).message);
    return null;
  }
}

type Lookup = 'yes' | 'no' | 'failed';

/**
 * A split guest? `failed` when the lookup throws.
 *
 * The table belongs to auth (server/table-owners.ts). isSplitGuestAccount()
 * (server/split-guest-scope.js) asks the same question for the auth router, which
 * runs before requireAuth; it answers a failure with `true` and cannot tell it
 * apart, and the actor needs the third state for `unresolved`.
 */
function guestLookup(database: Database, userId: number): Lookup {
  try {
    return database.prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(userId) ? 'yes' : 'no';
  } catch (err) {
    log.error('Split-guest lookup failed:', (err as Error).message);
    return 'failed';
  }
}

/**
 * A display account? `failed` when the lookup throws.
 *
 * The table belongs to the display module (services/display-accounts.js), whose
 * isDisplayAccount() asks the same question through the db.js singleton. It is
 * asked here with the request's own connection, so this module does not load
 * db.js (see the header).
 */
function displayAccountLookup(database: Database, userId: number): Lookup {
  try {
    return database.prepare('SELECT 1 FROM display_accounts WHERE user_id = ?').get(userId) ? 'yes' : 'no';
  } catch (err) {
    log.error('Display lookup failed:', (err as Error).message);
    return 'failed';
  }
}

/**
 * The kind of a request, and whether it is `unresolved`.
 *
 *   1. guest lookup (always, also for the display cookie): yes or failed -> guest
 *   2. display cookie                                                     -> display
 *   3. display-account lookup (not for the cookie): yes or failed        -> display
 *   4. api token                                                          -> token
 *   5. otherwise                                                          -> session
 *
 * The display-account lookup runs for a guest as well, so that its failure is
 * seen. `unresolved` is true when a lookup failed, and when a guest is also a
 * display (cookie or display row) - a row that cannot exist by construction.
 * No account id, or no connection (requireAuth did not run): `display`,
 * unresolved, without a lookup.
 *
 * THE TWO CALLERS READ IT LIKE THIS, AND GIVE THE ANSWERS THEY GAVE BEFORE B1:
 *   - the /api/v1 guest gate (server/index.js) closes on `kind === 'guest'`:
 *     guest lookup yes or failed, whatever the display side says; no account id
 *     stays open (isSplitGuestAccount said false on null);
 *   - /mcp (toolAllowed in server/mcp/tools.js) closes every tool on `display`
 *     or `unresolved`, and the core tools on `guest`: every tool closed for the
 *     display cookie, a display row, a failed display lookup or no account id;
 *     otherwise the core tools closed for a guest.
 * test:authorize-actor holds every combination against both old rules.
 *
 * WHERE IT DIFFERS FROM BEFORE B1 (only under a read error, or for a request that
 * never passed requireAuth - both callers sit behind it):
 *   a. guest lookup failed, display lookup no: /mcp closed the core tools and left
 *      the three bridge tools open; now every tool is closed. Narrower, and the
 *      bridge would have been refused at the guest gate anyway.
 *   c. an account id without a requireAuth entry: no lookup can run. /mcp closes
 *      every tool; the guest gate stays open for it, also for an account that is
 *      a guest (logged as an error in actorFromRequest).
 */
function kindOf(req: AuthenticatedRequest, userId: number | null): { kind: ActorKind; unresolved: boolean } {
  const entry = requests.get(req);
  if (userId == null || !entry) return { kind: 'display', unresolved: true };
  const cookie = req.authMethod === 'display';
  const guest = guestLookup(entry.database, userId);
  const display: Lookup = cookie ? 'yes' : displayAccountLookup(entry.database, userId);
  const unresolved = guest === 'failed' || display === 'failed' || (guest === 'yes' && display === 'yes');
  if (guest !== 'no') return { kind: 'guest', unresolved };
  if (display !== 'no') return { kind: 'display', unresolved };
  return { kind: req.authMethod === 'api_token' ? 'token' : 'session', unresolved };
}

/**
 * The actor of an authenticated request. Built once per request and remembered;
 * call it only after requireAuth, which sets every field read here and hands in
 * the connection (see resolveRequestModuleAccess).
 */
export function actorFromRequest(req: AuthenticatedRequest): Actor {
  const known = actors.get(req);
  if (known) return known;
  const userId = req.authUserId ?? null;
  if (userId != null && !requests.has(req)) {
    log.error('actorFromRequest called before requireAuth: the actor stays closed (display, unresolved).');
  }
  const { kind, unresolved } = kindOf(req, userId);
  const actor: Actor = Object.freeze({
    kind,
    userId,
    role: roleOf(req.authRole),
    familyRole: requests.get(req)?.familyRole ?? null,
    scopes: req.authScopes ?? null,
    moduleAccess: req.sessionModuleAccess ?? null,
    deviceId: req.authDeviceId ?? null,
    unresolved,
  });
  actors.set(req, actor);
  return actor;
}

/**
 * The actor without a request (scheduler, push, feeds): `kind: 'system'`, role and
 * family role from `users`, module rights from the permission matrix. `null` if
 * the account does not exist (any more).
 *
 * KNOWN DIVERGENCE: this actor is NOT classified as display or guest. A display
 * account or a split guest resolves here like a member through the matrix, without
 * the display flag and without the guest gate, while every REST path narrows it.
 * The visibility matrix holds this as `divergent` in four cells (due_reminders /
 * medications and ics_feed / events, for display and split_guest); a later
 * behaviour PR turns it. B1 only moves the place, not the answer.
 */
export function actorForUser(database: Database, userId: number | null | undefined): Actor | null {
  const user = database
    .prepare('SELECT id, role, family_role FROM users WHERE id = ?')
    .get(userId) as UserRow | undefined;
  if (!user) return null;
  return Object.freeze({
    kind: 'system',
    userId: user.id,
    role: roleOf(user.role),
    familyRole: user.family_role ?? null,
    scopes: null,
    moduleAccess: buildSessionModuleAccess(resolvePermissions(database, user)),
    deviceId: null,
    unresolved: false,
  });
}

const HOUSEHOLD: Actor = Object.freeze({
  kind: 'household',
  userId: null,
  role: null,
  familyRole: null,
  scopes: null,
  moduleAccess: null,
  deviceId: null,
  unresolved: false,
});

/** The household as a whole: no account, no role, no rights of its own. */
export function householdAudience(): Actor {
  return HOUSEHOLD;
}
