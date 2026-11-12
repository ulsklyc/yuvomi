/**
 * Test: the actor (phase 2, section B1) - server/authorize/
 *
 * Purpose: ONE place builds the actor every permission question starts from.
 *          Held here through the module's interface (server/authorize/index.ts),
 *          against real SQLite with every migration:
 *            1. `kind` is the narrowest kind that applies, in this order:
 *               display cookie -> split guest -> display account -> token -> session.
 *            2. A failed lookup counts as the narrower kind (guest, display).
 *            3. A missing user id reads as `display`, the one kind that keeps both
 *               of today's callers as they were (the /api/v1 guest gate: not a
 *               guest; /mcp: every tool closed).
 *            4. A device token of an admin is a member, as requireAuth decides.
 *            5. `actorFromRequest` builds once per request; a second call runs no
 *               query and returns the same object.
 *            6. `actorForUser` is `null` for an unknown account and does NOT
 *               classify a display account (see the comment at that test).
 *            7. `householdAudience` is the actor without an account.
 *
 * Run: npm run test:authorize-actor
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'authorize-actor-test-secret-32chars!';
process.env.LOG_LEVEL = 'error';

// server/db.js opens `:memory:` on import and runs every migration on it, on the
// production driver; the actor reads through that same connection.
const { get } = await import('../server/db.js');
const { actorFromRequest, actorForUser, householdAudience } = await import('../server/authorize/index.ts');
const { requireAuth } = await import('../server/auth.js');

const db = get();
test.after(() => db.close());

let seq = 0;
/** @param {string} role @param {string} [familyRole] @returns {number} */
function seedUser(role, familyRole = 'other') {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#007AFF', ?, ?)
  `).run(`user-${++seq}`, `User ${seq}`, role, familyRole).lastInsertRowid);
}

const ADMIN = seedUser('admin', 'parent');
const MEMBER = seedUser('member', 'parent');
const KID = seedUser('member', 'child');
const GUEST = seedUser('member');
const DISPLAY = seedUser('member');
const BOTH = seedUser('member'); // guest row AND display row: guest is narrower

const groupId = db.prepare('INSERT INTO expense_groups (name, created_by) VALUES (?, ?)').run('Trip', ADMIN).lastInsertRowid;
for (const id of [GUEST, BOTH]) {
  db.prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(id, groupId, ADMIN);
}
for (const id of [DISPLAY, BOTH]) {
  db.prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(id, ADMIN);
}
db.prepare(`
  INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
  VALUES ('user', ?, 'module', 'tasks', 'none')
`).run(String(KID));

/**
 * The fields requireAuth sets, as each of its branches sets them.
 * @typedef {{ authMethod?: string, authUserId?: number|null, authRole?: string, authScopes?: string[]|null,
 *   authDeviceId?: number|null, sessionModuleAccess?: Record<string, 'none'|'read'>|null,
 *   headers?: Record<string, string> }} Req
 */
/** @param {number|null} userId @param {string} [role] @returns {Req} */
function sessionReq(userId, role = 'member') {
  return { authMethod: 'session', authUserId: userId, authRole: role, authScopes: null, sessionModuleAccess: null };
}
/** @param {number|null} userId @param {string} [role] @returns {Req} */
function tokenReq(userId, role = 'member') {
  return { authMethod: 'api_token', authUserId: userId, authRole: role, authScopes: null, authDeviceId: null, sessionModuleAccess: null };
}
/** @param {number} userId @returns {Req} */
function displayReq(userId) {
  return { authMethod: 'display', authUserId: userId, authRole: 'member', authScopes: ['tasks:read'], sessionModuleAccess: { tasks: 'read' } };
}

/**
 * Counts the statements run on the test database while `fn` runs.
 * @template T
 * @param {() => T} fn
 * @returns {{ result: T, queries: string[] }}
 */
function countQueries(fn) {
  const original = db.prepare;
  /** @type {string[]} */
  const seen = [];
  db.prepare = function prepare(/** @type {string} */ sql) {
    seen.push(sql);
    return original.call(this, sql);
  };
  try {
    return { result: fn(), queries: seen };
  } finally {
    db.prepare = original;
  }
}

/**
 * Runs `fn` while `table` is renamed away, so a lookup on it throws.
 * @template T
 * @param {string} table
 * @param {() => T} fn
 * @returns {T}
 */
function withTableMissing(table, fn) {
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_away`);
  try {
    return fn();
  } finally {
    db.exec(`ALTER TABLE ${table}_away RENAME TO ${table}`);
  }
}

// --------------------------------------------------------------------------
// The order of `kind`
// --------------------------------------------------------------------------

test('kind: the display cookie wins over everything, even over a guest row', () => {
  assert.equal(actorFromRequest(displayReq(DISPLAY)).kind, 'display');
  assert.equal(actorFromRequest(displayReq(GUEST)).kind, 'display');
});

test('kind: a split guest is a guest, by session and by token', () => {
  assert.equal(actorFromRequest(sessionReq(GUEST)).kind, 'guest');
  assert.equal(actorFromRequest(tokenReq(GUEST)).kind, 'guest');
});

test('kind: a guest row outranks a display account row', () => {
  assert.equal(actorFromRequest(tokenReq(BOTH)).kind, 'guest');
});

test('kind: a display account reached by token or session is a display', () => {
  assert.equal(actorFromRequest(tokenReq(DISPLAY)).kind, 'display');
  assert.equal(actorFromRequest(sessionReq(DISPLAY)).kind, 'display');
});

test('kind: a plain token is a token, a plain session a session', () => {
  assert.equal(actorFromRequest(tokenReq(MEMBER)).kind, 'token');
  assert.equal(actorFromRequest(sessionReq(MEMBER)).kind, 'session');
  assert.equal(actorFromRequest(sessionReq(ADMIN, 'admin')).kind, 'session');
});

test('kind: the guest lookup runs first and a guest skips the display lookup', () => {
  const { queries } = countQueries(() => actorFromRequest(sessionReq(GUEST)));
  assert.equal(queries.length, 1);
  assert.match(queries[0], /split_expense_guest_users/);
  const plain = countQueries(() => actorFromRequest(sessionReq(MEMBER))).queries;
  assert.equal(plain.length, 2);
  assert.match(plain[0], /split_expense_guest_users/);
  assert.match(plain[1], /display_accounts/);
});

// --------------------------------------------------------------------------
// When in doubt, closed
// --------------------------------------------------------------------------

test('a failed guest lookup counts as a guest', () => {
  const actor = withTableMissing('split_expense_guest_users', () => actorFromRequest(tokenReq(MEMBER)));
  assert.equal(actor.kind, 'guest');
});

test('a failed display lookup counts as a display', () => {
  const actor = withTableMissing('display_accounts', () => actorFromRequest(tokenReq(MEMBER)));
  assert.equal(actor.kind, 'display');
});

test('a missing user id reads as a display, without a query', () => {
  // Today the /api/v1 guest gate lets such a request through (isSplitGuestAccount
  // says false on null) and /mcp closes every tool (its own lookups said true for
  // both). `display` is the one kind that keeps both answers.
  const { result, queries } = countQueries(() => actorFromRequest(tokenReq(null)));
  assert.equal(result.kind, 'display');
  assert.equal(result.userId, null);
  assert.equal(queries.length, 0);
});

// --------------------------------------------------------------------------
// The fields
// --------------------------------------------------------------------------

test('the fields come from what requireAuth set', () => {
  /** @type {Req} */
  const req = { ...tokenReq(KID), authScopes: ['tasks:read'], sessionModuleAccess: { tasks: 'none' } };
  const actor = actorFromRequest(req);
  assert.deepEqual({ ...actor }, {
    kind: 'token',
    userId: KID,
    role: 'member',
    familyRole: null,
    scopes: ['tasks:read'],
    moduleAccess: { tasks: 'none' },
    deviceId: null,
  });
  assert.ok(Object.isFrozen(actor));
});

test('a device token of an admin is a member, through the real requireAuth', () => {
  const credential = crypto.randomBytes(24).toString('hex');
  const tokenId = Number(db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id, kind, platform, device_id)
    VALUES ('phone', ?, ?, ?, ?, 'device', 'ios', 'device-1')
  `).run(crypto.createHash('sha256').update(credential, 'utf8').digest('hex'), credential.slice(0, 12), ADMIN, ADMIN).lastInsertRowid);
  /** @type {Req} */
  const req = { headers: { authorization: `Bearer ${credential}` } };
  let passed = false;
  requireAuth(req, {}, () => { passed = true; });
  assert.equal(passed, true);
  const actor = actorFromRequest(req);
  assert.equal(actor.kind, 'token');
  assert.equal(actor.userId, ADMIN);
  assert.equal(actor.role, 'member');
  assert.equal(actor.deviceId, tokenId);
  // requireAuth resolved the admin's rights as a member's and kept the family role.
  assert.equal(actor.familyRole, 'parent');
});

test('the family role comes along for a member, from the lookup requireAuth already makes', () => {
  const credential = crypto.randomBytes(24).toString('hex');
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id)
    VALUES ('kid', ?, ?, ?, ?)
  `).run(crypto.createHash('sha256').update(credential, 'utf8').digest('hex'), credential.slice(0, 12), ADMIN, KID);
  /** @type {Req} */
  const req = { headers: { authorization: `Bearer ${credential}` } };
  requireAuth(req, {}, () => {});
  const actor = actorFromRequest(req);
  assert.equal(actor.familyRole, 'child');
  assert.deepEqual(actor.moduleAccess, req.sessionModuleAccess);
  assert.equal(actor.moduleAccess?.tasks, 'none');
});

// --------------------------------------------------------------------------
// Once per request
// --------------------------------------------------------------------------

test('actorFromRequest builds once per request', () => {
  const req = sessionReq(MEMBER);
  const first = countQueries(() => actorFromRequest(req));
  assert.equal(first.queries.length, 2);
  const second = countQueries(() => actorFromRequest(req));
  assert.equal(second.queries.length, 0, 'the second call runs no query');
  assert.equal(second.result, first.result, 'and returns the same actor');
  // A new request is a new actor.
  assert.notEqual(actorFromRequest(sessionReq(MEMBER)), first.result);
});

// --------------------------------------------------------------------------
// Without a request
// --------------------------------------------------------------------------

test('actorForUser: an unknown account has no actor', () => {
  assert.equal(actorForUser(db, 999999), null);
  assert.equal(actorForUser(db, null), null);
});

test('actorForUser: role, family role and module rights from users and the matrix', () => {
  assert.deepEqual({ ...actorForUser(db, KID) }, {
    kind: 'system', userId: KID, role: 'member', familyRole: 'child',
    scopes: null, moduleAccess: { tasks: 'none' }, deviceId: null,
  });
  const admin = actorForUser(db, ADMIN);
  assert.ok(admin);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.moduleAccess, null);
  assert.ok(Object.isFrozen(admin));
});

test('actorForUser: a display account is a plain system actor with the matrix rights (known divergence)', () => {
  // KNOWN DIVERGENCE, HELD ON PURPOSE (visibility matrix, `divergent`, four
  // cells: due_reminders and ics_feed for display and split_guest). Without a
  // request the actor is not classified as display or guest, so a display
  // account resolves like an unrestricted member here while every REST path
  // narrows it. A later behaviour PR turns this; until then this test says
  // what is true today.
  const actor = actorForUser(db, DISPLAY);
  assert.ok(actor);
  assert.equal(actor.kind, 'system');
  assert.equal(actor.moduleAccess, null);
  assert.equal(actorForUser(db, GUEST)?.kind, 'system');
});

test('householdAudience: no account, nothing else', () => {
  assert.deepEqual({ ...householdAudience() }, {
    kind: 'household', userId: null, role: null, familyRole: null,
    scopes: null, moduleAccess: null, deviceId: null,
  });
  assert.ok(Object.isFrozen(householdAudience()));
});
