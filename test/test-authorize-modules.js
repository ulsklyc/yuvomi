/**
 * Test: the module verdict (phase 2, section B2) - authorize() in server/authorize/
 *
 * Purpose: ONE function answers "may this actor read, write or receive from this
 *          module". Before B2 the same answer stood in three spellings: MCP's
 *          toolAllowed (token scopes, then the module rights), the reminder
 *          delivery and the feeds (`deniedModules()` of the recipient), and seven
 *          reminder sources that compared `resolvePermissions(...).modules.<key>`
 *          with 'none' themselves. Held here through the module's interface
 *          (server/authorize/index.ts), against real SQLite with every migration:
 *            1. A table: actor {admin, member with write / read / none, token with
 *               and without the matching scope, display, null} x action {read,
 *               write, receive} x every permission module, compared with the OLD
 *               rules written out as the oracle - tokenAllows() + moduleAccessVerdict()
 *               for read/write, deniedModules() for receive.
 *            2. `receive` asks no token scope: a delivery is not a request.
 *            3. `null` (an account that does not exist) may nothing: 'no_actor'.
 *            4. What B2 does not answer (`manage`, a record instead of a module)
 *               throws instead of answering silently.
 *            5. MCP keeps its one null-actor answer: listToolDefinitions(null)
 *               lists every tool, as before (toolAllowed catches null itself).
 *
 * Run: npm run test:authorize-modules
 */

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'authorize-modules-test-secret-32ch!';
process.env.LOG_LEVEL = 'error';

// server/db.js opens `:memory:` on import and runs every migration on it.
const { get } = await import('../server/db.js');
const authorizeApi = await import('../server/authorize/index.ts');
const {
  actorForUser, actorFromRequest, resolveRequestModuleAccess,
  deniedModules, moduleAccessVerdict, MODULE_ACCESS_ALLOW, MODULE_ACCESS_DENIED, PERMISSION_MODULES,
} = authorizeApi;
const { tokenAllows } = await import('../server/scopes.js');
const { listToolDefinitions, TOOL_DEFINITIONS } = await import('../server/mcp/tools.js');
const { DISPLAY_SCOPES } = await import('../server/display-scopes.js');

/**
 * Read as a property, not destructured: before authorize() exists the suite turns
 * red on its tests instead of failing on import.
 * @type {(actor: any, action: string, resource: any) => { allowed: boolean, reason: string|null }}
 */
const authorize = (actor, action, resource) => {
  const fn = /** @type {any} */ (authorizeApi).authorize;
  assert.equal(typeof fn, 'function', 'authorize is exported from server/authorize/index.ts');
  return fn(actor, action, resource);
};

const db = get();
test.after(() => db.close());

let seq = 0;
/** @param {string} role @returns {number} */
function seedUser(role) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#007AFF', ?, 'other')
  `).run(`modules-user-${++seq}`, `User ${seq}`, role).lastInsertRowid);
}
/** @param {number} userId @param {string} key @param {string} access */
function setModule(userId, key, access) {
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, ?)
  `).run(String(userId), key, access);
}

const MODULES = PERMISSION_MODULES.map((m) => m.key);
// Every level on one account, so each module key meets write, read and none.
const LEVELS = ['write', 'read', 'none'];

const ADMIN = seedUser('admin');
// An admin's own deny row counts for nothing: an admin resolves to "unrestricted".
setModule(ADMIN, 'tasks', 'none');
const MEMBER_WRITE = seedUser('member');
const MEMBER_READ = seedUser('member');
const MEMBER_NONE = seedUser('member');
const MEMBER_MIXED = seedUser('member');
for (const key of MODULES) {
  setModule(MEMBER_READ, key, 'read');
  setModule(MEMBER_NONE, key, 'none');
}
MODULES.forEach((key, i) => setModule(MEMBER_MIXED, key, LEVELS[i % LEVELS.length]));
const DISPLAY = seedUser('member');
db.prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(DISPLAY, ADMIN);

/**
 * A request as requireAuth leaves it, then its actor.
 * @param {{ authMethod: string, authUserId: number, authRole?: string, authScopes: string[]|null }} fields
 */
function requestActor(fields) {
  /** @type {any} */
  const req = { authRole: 'member', authDeviceId: null, ...fields };
  req.sessionModuleAccess = resolveRequestModuleAccess(db, req);
  return actorFromRequest(req);
}

// A scope on every second module, in both strengths: the other half has none.
const TOKEN_SCOPES = MODULES.flatMap((key, i) => (i % 2 ? [] : [`${key}:${i % 4 ? 'read' : 'write'}`]));

/** @type {Array<[string, any]>} */
const ACTORS = [
  ['admin', actorForUser(db, ADMIN)],
  ['member write', actorForUser(db, MEMBER_WRITE)],
  ['member read', actorForUser(db, MEMBER_READ)],
  ['member none', actorForUser(db, MEMBER_NONE)],
  ['member mixed', actorForUser(db, MEMBER_MIXED)],
  ['token, unscoped, member mixed', requestActor({ authMethod: 'api_token', authUserId: MEMBER_MIXED, authScopes: null })],
  ['token, scoped, member write', requestActor({ authMethod: 'api_token', authUserId: MEMBER_WRITE, authScopes: TOKEN_SCOPES })],
  ['token, scoped, member mixed', requestActor({ authMethod: 'api_token', authUserId: MEMBER_MIXED, authScopes: TOKEN_SCOPES })],
  ['token, scoped, admin', requestActor({ authMethod: 'api_token', authUserId: ADMIN, authRole: 'admin', authScopes: TOKEN_SCOPES })],
  ['display', requestActor({ authMethod: 'display', authUserId: DISPLAY, authScopes: [...DISPLAY_SCOPES] })],
  ['null', null],
];

/**
 * THE OLD RULES, written out: what toolAllowed (server/mcp/tools.js) asked for
 * read/write, and what recipientDeniedModules() + deniedModules() said to the
 * delivery and the feeds for receive.
 * @param {any} actor @param {string} action @param {string} key
 */
function oracle(actor, action, key) {
  if (actor == null) return { allowed: false, reason: 'no_actor' };
  if (action === 'receive') {
    const denied = deniedModules(actor.moduleAccess).has(key);
    return { allowed: !denied, reason: denied ? 'module_none' : null };
  }
  if (!tokenAllows(actor.scopes, key, /** @type {'read'|'write'} */ (action))) return { allowed: false, reason: 'scope' };
  const verdict = moduleAccessVerdict(actor.moduleAccess, key, action);
  if (verdict === MODULE_ACCESS_ALLOW) return { allowed: true, reason: null };
  return { allowed: false, reason: verdict === MODULE_ACCESS_DENIED ? 'module_none' : 'module_read_only' };
}

test('precondition: the actors span every answer', () => {
  const seen = new Set();
  for (const [, actor] of ACTORS) {
    for (const action of ['read', 'write', 'receive']) {
      for (const key of MODULES) seen.add(`${action}:${oracle(actor, action, key).reason}`);
    }
  }
  for (const cell of ['read:null', 'read:scope', 'read:module_none', 'read:no_actor',
    'write:null', 'write:scope', 'write:module_none', 'write:module_read_only',
    'receive:null', 'receive:module_none', 'receive:no_actor']) {
    assert.ok(seen.has(cell), `no actor answers ${cell}`);
  }
});

test('authorize answers every actor x action x module as the old rules did', () => {
  const diffs = [];
  for (const [name, actor] of ACTORS) {
    for (const action of ['read', 'write', 'receive']) {
      for (const key of MODULES) {
        const got = authorize(actor, action, { module: key });
        const want = oracle(actor, action, key);
        if (got.allowed !== want.allowed || got.reason !== want.reason) {
          diffs.push(`${name} / ${action} / ${key}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        }
      }
    }
  }
  assert.deepEqual(diffs, []);
});

test('receive: read is enough, none is not, an admin always receives', () => {
  for (const key of MODULES) {
    assert.equal(authorize(actorForUser(db, MEMBER_READ), 'receive', { module: key }).allowed, true, `read / ${key}`);
    assert.equal(authorize(actorForUser(db, MEMBER_NONE), 'receive', { module: key }).allowed, false, `none / ${key}`);
    assert.equal(authorize(actorForUser(db, ADMIN), 'receive', { module: key }).allowed, true, `admin / ${key}`);
  }
});

test('receive asks no token scope: a delivery is not a request', () => {
  const actor = requestActor({ authMethod: 'api_token', authUserId: MEMBER_WRITE, authScopes: [] });
  for (const key of MODULES) {
    assert.equal(authorize(actor, 'read', { module: key }).reason, 'scope', `read / ${key}`);
    assert.deepEqual(authorize(actor, 'receive', { module: key }), { allowed: true, reason: null }, `receive / ${key}`);
  }
});

test('an account that does not exist may nothing', () => {
  const ghost = actorForUser(db, 999999);
  assert.equal(ghost, null);
  for (const action of ['read', 'write', 'receive']) {
    assert.deepEqual(authorize(ghost, action, { module: 'tasks' }), { allowed: false, reason: 'no_actor' });
  }
});

test('the verdict is frozen', () => {
  assert.ok(Object.isFrozen(authorize(actorForUser(db, ADMIN), 'read', { module: 'tasks' })));
  assert.ok(Object.isFrozen(authorize(null, 'receive', { module: 'tasks' })));
});

test('what B2 does not answer throws instead of answering silently', () => {
  const actor = actorForUser(db, ADMIN);
  assert.throws(() => authorize(actor, 'manage', { module: 'tasks' }), /not implemented in B2/);
  assert.throws(() => authorize(actor, 'read', { type: 'task', id: 1 }), /not implemented in B2/);
  assert.throws(() => authorize(actor, 'write', { type: 'task', ownerId: 1 }), /not implemented in B2/);
  assert.throws(() => authorize(null, 'manage', { module: 'tasks' }), /not implemented in B2/);
});

test('MCP keeps its null-actor answer: every tool is listed', () => {
  assert.equal(listToolDefinitions(null).length, TOOL_DEFINITIONS.length);
  assert.equal(listToolDefinitions().length, TOOL_DEFINITIONS.length);
});
