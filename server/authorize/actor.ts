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
 *   server/permissions.js, server/split-guest-scope.js (none of them loads db.js).
 * Erasable TS syntax only (runs through type stripping, no build).
 */

import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { buildSessionModuleAccess, resolvePermissions, userForRequest } from '../permissions.js';
import { isSplitGuestAccount } from '../split-guest-scope.js';

// The logger of server/auth.js: the resolution moved, its log line did not change.
const log = createLogger('Auth');

// Not exported yet: knip counts an exported type without an importer as a finding.
// The first module that names the type exports it here and from index.ts.
type ActorKind = 'session' | 'token' | 'display' | 'guest' | 'system' | 'household';

type ModuleAccess = Readonly<Record<string, 'none' | 'read'>>;

type Actor = Readonly<{
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
}>;

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

/**
 * A display account? `failed` when the lookup throws.
 *
 * The table belongs to the display module (services/display-accounts.js), whose
 * isDisplayAccount() asks the same question through the db.js singleton. It is
 * asked here with the request's own connection, so this module does not load
 * db.js (see the header).
 */
function displayAccountLookup(database: Database, userId: number): 'yes' | 'no' | 'failed' {
  try {
    return database.prepare('SELECT 1 FROM display_accounts WHERE user_id = ?').get(userId) ? 'yes' : 'no';
  } catch (err) {
    log.error('Display lookup failed:', (err as Error).message);
    return 'failed';
  }
}

/**
 * The narrowest kind that applies. Both lookups always run (split guest first,
 * then display account), except for the display cookie, which needs neither:
 *
 *   1. display cookie                                 -> display
 *   2. display-account lookup says yes                -> display
 *   3. guest lookup says yes OR fails                 -> guest
 *   4. display-account lookup failed                  -> display
 *   5. api token                                      -> token
 *   6. otherwise                                      -> session
 *
 * So the /api/v1 guest gate closes on a guest or a failed guest lookup, as before
 * B1, and /mcp closes a display account entirely even when the guest lookup fails.
 * ONE CASE DIFFERS FROM BEFORE B1: the display lookup fails AND the account is a
 * guest. /mcp then closed every tool; now the account is a guest, and the three
 * bridge tools stay open - they call back into /api/v1, whose guest gate refuses
 * everything outside /split-expenses.
 *
 * NO ACCOUNT ID, OR NO CONNECTION (requireAuth did not run), READS AS `display`,
 * without a lookup. For a missing id the two callers answered differently before
 * B1 and still do: the /api/v1 guest gate let such a request through
 * (isSplitGuestAccount says false on null), /mcp closed every tool (its own
 * lookups said true for guest and display alike, and display closes everything).
 * `display` is the one kind that keeps both answers: it is not `guest`, and
 * toolAllowed() refuses a display every tool.
 */
function kindOf(req: AuthenticatedRequest, userId: number | null): ActorKind {
  if (req.authMethod === 'display') return 'display';
  const entry = requests.get(req);
  if (userId == null || !entry) return 'display';
  const guest = isSplitGuestAccount(entry.database, userId);
  const display = displayAccountLookup(entry.database, userId);
  if (display === 'yes') return 'display';
  if (guest) return 'guest';
  if (display === 'failed') return 'display';
  if (req.authMethod === 'api_token') return 'token';
  return 'session';
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
  const actor: Actor = Object.freeze({
    kind: kindOf(req, userId),
    userId,
    role: roleOf(req.authRole),
    familyRole: requests.get(req)?.familyRole ?? null,
    scopes: req.authScopes ?? null,
    moduleAccess: req.sessionModuleAccess ?? null,
    deviceId: req.authDeviceId ?? null,
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
});

/** The household as a whole: no account, no role, no rights of its own. */
export function householdAudience(): Actor {
  return HOUSEHOLD;
}
