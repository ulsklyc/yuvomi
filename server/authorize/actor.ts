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
 * resolveRequestModuleAccess(req) is the module-rights resolution requireAuth runs
 * for every branch; it moved here from `applyRoleModuleAccess` in server/auth.js,
 * which still sets `req.sessionModuleAccess` from its result.
 *
 * `req.authRole`, `req.authUserId` and their siblings stay where they are: B1 adds
 * the actor next to them and moves no reader over.
 *
 * Dependencies: server/db.js, server/logger.js, server/middleware/require-admin.js,
 *   server/permissions.js,
 *   server/split-guest-scope.js, server/services/display-accounts.js.
 * Erasable TS syntax only (runs through type stripping, no build).
 */

import * as dbModule from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { buildSessionModuleAccess, resolvePermissions, userForRequest } from '../permissions.js';
import { isSplitGuestAccount } from '../split-guest-scope.js';
import { isDisplayAccount } from '../services/display-accounts.js';

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
// them, and they go with the request.
const actors = new WeakMap<object, Actor>();
const familyRoles = new WeakMap<object, string | null>();

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
 * THE FAMILY ROLE IS RECORDED HERE, from the one `users` lookup this already makes.
 * For an admin there is no lookup, so an admin's actor carries `familyRole: null`;
 * reading it would cost a further query per request. Merging this lookup into the
 * session branch's own `SELECT u.role FROM users` is not done: that one is not
 * guarded, and a failure there (a database without `family_role`) would turn
 * today's swallowed error into a 500.
 */
export function resolveRequestModuleAccess(req: AuthenticatedRequest): ModuleAccess | null {
  if (isAdminRequest(req)) return null;
  try {
    const database = dbModule.get();
    const user = database
      .prepare('SELECT id, role, family_role FROM users WHERE id = ?')
      .get(req.authUserId) as UserRow | undefined;
    if (!user) return null;
    familyRoles.set(req, user.family_role ?? null);
    return buildSessionModuleAccess(
      resolvePermissions(database, userForRequest(req, user), { isDisplay: req.authMethod === 'display' }),
    );
  } catch (err) {
    log.error('Permission resolution failed:', (err as Error).message);
    return null;
  }
}

/** A split guest? A failure counts as yes (see isSplitGuestAccount); so does no database. */
function isGuest(userId: number): boolean {
  let database;
  try {
    database = dbModule.get();
  } catch {
    return true;
  }
  return isSplitGuestAccount(database, userId);
}

/** A display account? A failure counts as yes: when in doubt, closed. */
function isDisplay(userId: number): boolean {
  try {
    return isDisplayAccount(userId);
  } catch (err) {
    log.error('Display lookup failed:', (err as Error).message);
    return true;
  }
}

/**
 * The narrowest kind that applies, in this order: the display cookie, a split
 * guest, a display account, a token, a session. The guest lookup runs first; when
 * it says yes, the display lookup is skipped.
 *
 * NO ACCOUNT ID READS AS `display`, without a lookup. The two callers answered it
 * differently before B1 and still do: the /api/v1 guest gate let such a request
 * through (isSplitGuestAccount says false on null), /mcp closed every tool (its own
 * lookups said true for guest and display alike, and display closes everything).
 * `display` is the one kind that keeps both answers: it is not `guest`, and
 * toolAllowed() refuses a display every tool.
 */
function kindOf(req: AuthenticatedRequest, userId: number | null): ActorKind {
  if (req.authMethod === 'display') return 'display';
  if (userId == null) return 'display';
  if (isGuest(userId)) return 'guest';
  if (isDisplay(userId)) return 'display';
  if (req.authMethod === 'api_token') return 'token';
  return 'session';
}

/**
 * The actor of an authenticated request. Built once per request and remembered;
 * call it only after requireAuth, which sets every field read here.
 */
export function actorFromRequest(req: AuthenticatedRequest): Actor {
  const known = actors.get(req);
  if (known) return known;
  const userId = req.authUserId ?? null;
  const actor: Actor = Object.freeze({
    kind: kindOf(req, userId),
    userId,
    role: roleOf(req.authRole),
    familyRole: familyRoles.get(req) ?? null,
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
 *
 * No caller in the running server yet besides test:authorize-actor: switching
 * recipientDeniedModules() (services/reminder-origins.js) over would make
 * server/openapi.js load server/db.js through this file, and db.js opens a database
 * on import (it would create one in the repository for the OpenAPI suites).
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
