/**
 * Test: password hashes with Argon2id (#2810, group 12, decision 21)
 * Purpose: server/utils/password.js hashes with Argon2id over `node:crypto`
 *          (RFC 9106, OWASP parameters m=19456 KiB, t=2, p=1, 16-byte salt,
 *          32-byte tag) as a PHC string, and checks old bcrypt hashes only to
 *          migrate them. Held here:
 *            - NODE COMPUTES REAL ARGON2ID v19: the test vector of RFC 9106
 *              section 5.3 (with secret and associated data);
 *            - FORMAT: the PHC string, a fresh salt per hash;
 *            - 72 BYTES: bcrypt read only the first 72 bytes, two passwords
 *              differing from byte 73 on were the same password; Argon2id
 *              tells them apart. Emoji and NFD input against an NFC hash;
 *            - LEGACY: a bcrypt hash (also from NFD input) is valid with
 *              `needsRehash`, a wrong password is not;
 *            - PARAMETER UPGRADE: weaker parameters are valid with
 *              `needsRehash`, the current ones without;
 *            - BROKEN: `$oidc$`, empty, null, a wrong version, a salt that
 *              does not decode, a short tag are `valid: false`, no throw;
 *            - LOGIN (real router, real session): a bcrypt account signs in
 *              and carries an Argon2id hash afterwards, the second sign-in
 *              rewrites nothing; a password set while the migration hashes is
 *              not overwritten; an SSO-only and an unknown account answer as
 *              before;
 *            - TIMING: an unknown account, an SSO-only account and a wrong
 *              password at an Argon2id account cost one Argon2id computation
 *              each (counted by a spy on `crypto.argon2`, no wall clock);
 *            - NO PROCESS WARNING from `crypto.argon2` (CI runs Node 24 and 26,
 *              the package contract reads the start logs).
 * Run: npm run test:password-hash
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-password-hash';
process.env.DB_PATH = ':memory:';
process.env.RATE_LIMIT_MAX_ATTEMPTS = '1000000';
for (const key of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'GRAVATAR_BASE_URL', 'AUTH_ALLOW_PASSWORD_LOGIN']) delete process.env[key];

// Registered before anything touches crypto.argon2: Node emits a warning once per process.
/** @type {string[]} */
const warnings = [];
process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`));

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// @ts-expect-error bcrypt ships no type declarations (TS7016)
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { AUTH_PREFIX, createAuthApp } from './auth-app.js';

const dbmod = await import('../server/db.js');
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { ARGON2_PARAMS, hashPassword, verifyPassword } = await import('../server/utils/password.js');
const { OIDC_PASSWORD_SENTINEL } = await import('../server/services/oidc.js');
const db = dbmod.get();

const PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;
const NOT_VALID = { valid: false, needsRehash: false };

/**
 * @param {string} message @param {Buffer} nonce
 * @param {{ memory: number, passes: number, parallelism: number, tagLength: number }} params
 * @returns {Promise<Buffer>}
 */
function rawArgon2id(message, nonce, params) {
  return new Promise((resolve, reject) => {
    crypto.argon2('argon2id', { message, nonce, ...params }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * A PHC string with free parameters, built by hand (base64 without padding).
 * @param {string} password
 * @param {{ memory: number, passes: number, parallelism: number, tagLength: number }} params
 */
async function phc(password, { memory, passes, parallelism, tagLength }) {
  const salt = crypto.randomBytes(16);
  const tag = await rawArgon2id(password.normalize('NFC'), salt, { memory, passes, parallelism, tagLength });
  const b64 = (/** @type {Buffer} */ b) => b.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
}

/**
 * Counts the calls of `crypto.argon2` (server/utils/password.js reads it from
 * the shared module object at call time). `during` runs once, at the start of
 * the first call.
 * @param {() => Promise<unknown>} action
 * @param {() => void} [during]
 */
async function countArgon2(action, during) {
  const original = crypto.argon2;
  let calls = 0;
  crypto.argon2 = /** @type {any} */ (/** @this {any} */ function spy(/** @type {any[]} */ ...args) {
    calls += 1;
    if (calls === 1 && during) during();
    return /** @type {any} */ (original).apply(this, args);
  });
  try {
    const result = await action();
    return { calls, result };
  } finally {
    crypto.argon2 = original;
  }
}

// --------------------------------------------------------------------------
// Node computes Argon2id v19
// --------------------------------------------------------------------------

test('RFC 9106 section 5.3: crypto.argon2 yields the Argon2id test vector', async () => {
  const tag = await new Promise((resolve, reject) => {
    crypto.argon2('argon2id', {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      memory: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
  assert.equal(/** @type {Buffer} */ (tag).toString('hex'), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
});

test('the parameters are those of OWASP', () => {
  assert.deepEqual({ ...ARGON2_PARAMS }, { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 });
});

// --------------------------------------------------------------------------
// Format
// --------------------------------------------------------------------------

test('hashPassword yields a PHC string, a fresh salt each time, over the NFC form', async () => {
  const nfd = 'Bärenstark1'.normalize('NFD');
  const a = await hashPassword(nfd);
  const b = await hashPassword(nfd);
  assert.match(a, PHC);
  assert.match(b, PHC);
  assert.notEqual(a, b, 'two hashes of one password differ by their salt');
  // Recomputed by hand: the tag is that of the NFC form, not of the NFD bytes.
  const [, , , , salt, tag] = a.split('$');
  const nonce = Buffer.from(salt, 'base64');
  assert.equal((await rawArgon2id(nfd.normalize('NFC'), nonce, ARGON2_PARAMS)).toString('base64').replace(/=+$/, ''), tag);
  assert.notEqual((await rawArgon2id(nfd, nonce, ARGON2_PARAMS)).toString('base64').replace(/=+$/, ''), tag);
});

test('hashPassword takes no cost argument any more: a second argument changes nothing', async () => {
  // @ts-expect-error the old signature hashPassword(password, rounds)
  assert.match(await hashPassword('correct-horse-1', 4), PHC);
});

// --------------------------------------------------------------------------
// 72 bytes, emoji, normal forms
// --------------------------------------------------------------------------

test('72 bytes: passwords differing from byte 73 on are different passwords', async () => {
  const head = 'a'.repeat(72);
  const one = `${head}one`;
  const two = `${head}two`;
  assert.equal(Buffer.byteLength(head), 72);
  // The reason: bcrypt reads only the first 72 bytes and takes one for the other.
  assert.equal(await bcrypt.compare(two, await bcrypt.hash(one, 4)), true, 'bcrypt conflates them');
  const hash = await hashPassword(one);
  assert.deepEqual(await verifyPassword(one, hash), { valid: true, needsRehash: false });
  assert.deepEqual(await verifyPassword(two, hash), NOT_VALID);
});

test('an emoji password counts in full, NFD input matches an NFC hash', async () => {
  const emoji = '🔒'.repeat(20);
  const other = `${'🔒'.repeat(19)}🔑`;
  assert.ok(Buffer.byteLength(emoji) > 72);
  const hash = await hashPassword(emoji);
  assert.deepEqual(await verifyPassword(emoji, hash), { valid: true, needsRehash: false });
  assert.deepEqual(await verifyPassword(other, hash), NOT_VALID);

  const umlaut = await hashPassword('Grüßgott42'.normalize('NFC'));
  assert.deepEqual(await verifyPassword('Grüßgott42'.normalize('NFD'), umlaut), { valid: true, needsRehash: false });
});

// --------------------------------------------------------------------------
// Legacy bcrypt
// --------------------------------------------------------------------------

test('legacy: a bcrypt hash is valid and asks for a rehash, also from NFD input', async () => {
  const nfc = 'Bärenstark1'.normalize('NFC');
  const nfd = 'Bärenstark1'.normalize('NFD');
  const plain = await bcrypt.hash(nfc, 4);
  assert.deepEqual(await verifyPassword(nfc, plain), { valid: true, needsRehash: true });
  assert.deepEqual(await verifyPassword(nfd, plain), { valid: true, needsRehash: true });
  const fromNfd = await bcrypt.hash(nfd, 4);
  assert.deepEqual(await verifyPassword(nfc, fromNfd), { valid: true, needsRehash: true });
  assert.deepEqual(await verifyPassword('Bärenschwach1', plain), NOT_VALID);
  assert.deepEqual(await verifyPassword('', plain), NOT_VALID);
  for (const prefix of ['$2a$']) {
    assert.deepEqual(await verifyPassword(nfc, plain.replace('$2b$', prefix)), { valid: true, needsRehash: true }, prefix);
  }
});

// --------------------------------------------------------------------------
// Parameter upgrade
// --------------------------------------------------------------------------

test('parameter upgrade: weaker parameters are valid and ask for a rehash, current ones do not', async () => {
  const pw = 'correct-horse-1';
  for (const params of [
    { ...ARGON2_PARAMS, memory: 8192 },
    { ...ARGON2_PARAMS, passes: 1 },
    { ...ARGON2_PARAMS, tagLength: 16 },
  ]) {
    assert.deepEqual(await verifyPassword(pw, await phc(pw, params)), { valid: true, needsRehash: true }, JSON.stringify(params));
  }
  assert.deepEqual(await verifyPassword(pw, await phc(pw, ARGON2_PARAMS)), { valid: true, needsRehash: false });
  assert.deepEqual(await verifyPassword(pw, await phc(pw, { ...ARGON2_PARAMS, memory: 32768 })), { valid: true, needsRehash: false });
  assert.deepEqual(await verifyPassword('wrong-horse-1', await phc(pw, { ...ARGON2_PARAMS, passes: 1 })), NOT_VALID);
});

// --------------------------------------------------------------------------
// Broken hashes
// --------------------------------------------------------------------------

test('broken hashes are valid: false and never throw', async () => {
  const pw = 'correct-horse-1';
  const good = await hashPassword(pw);
  const [, , , params, salt, tag] = good.split('$');
  for (const hash of [
    OIDC_PASSWORD_SENTINEL,
    '',
    null,
    undefined,
    42,
    '$argon2i$v=19$' + `${params}$${salt}$${tag}`,
    `$argon2id$v=16$${params}$${salt}$${tag}`,
    `$argon2id$${params}$${salt}$${tag}`,
    `$argon2id$v=19$${params}$${salt}!$${tag}`,
    `$argon2id$v=19$${params}$${salt}==$${tag}`,
    `$argon2id$v=19$${params}$${salt}$${tag.slice(0, 6)}`,
    `$argon2id$v=19$m=19456,t=2$${salt}$${tag}`,
    `$argon2id$v=19$m=x,t=2,p=1$${salt}$${tag}`,
    `$argon2id$v=19$m=0,t=2,p=1$${salt}$${tag}`,
    `$argon2id$v=19$${params}$${salt}$${tag}$`,
    '$2b$12$x',
  ]) {
    assert.deepEqual(await verifyPassword(pw, /** @type {any} */ (hash)), NOT_VALID, String(hash));
  }
});

test('timing: a hash that is not one costs one Argon2id computation', async () => {
  for (const hash of [OIDC_PASSWORD_SENTINEL, '', null, '$argon2id$v=16$m=1,t=1,p=1$AAAA$AAAA']) {
    const { calls } = await countArgon2(() => verifyPassword('correct-horse-1', /** @type {any} */ (hash)));
    assert.equal(calls, 1, String(hash));
  }
  const { calls } = await countArgon2(async () => verifyPassword('wrong', await hashPassword('correct-horse-1')));
  assert.equal(calls, 2, 'one to hash, one to verify');
});

// --------------------------------------------------------------------------
// Sign-in (real router, real session)
// --------------------------------------------------------------------------

const app = await createAuthApp({
  session: sessionMiddleware,
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  routers: [authRouter],
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const origin = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => server.close());

/** @param {string} username @param {string} password */
async function login(username, password) {
  const res = await fetch(`${origin}${AUTH_PREFIX}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json() };
}

/** @param {string} username @param {string} hash */
function account(username, hash) {
  db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')").run(username, username, hash);
}

/** @param {string} username @returns {string} */
function hashOf(username) {
  return db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username).password_hash;
}

test('login: a bcrypt account signs in and carries an Argon2id hash afterwards; the second sign-in rewrites nothing', async () => {
  const pw = 'Bärenstark1-über-zweiundsiebzig'.normalize('NFC');
  const legacy = await bcrypt.hash(pw.normalize('NFD'), 4);
  account('legacy', legacy);

  const first = await login('legacy', pw);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const migrated = hashOf('legacy');
  assert.match(migrated, PHC);
  assert.deepEqual(await verifyPassword(pw, migrated), { valid: true, needsRehash: false });

  const { calls, result } = await countArgon2(() => login('legacy', pw.normalize('NFD')));
  assert.equal(/** @type {any} */ (result).status, 200);
  assert.equal(calls, 1, 'one computation to verify, none to rewrite');
  assert.equal(hashOf('legacy'), migrated, 'the second sign-in leaves the row alone');
});

test('login: a password set while the migration hashes is not overwritten', async () => {
  const pw = 'old-password-1';
  account('racer', await bcrypt.hash(pw, 4));
  const newer = await hashPassword('new-password-1');
  // The first Argon2id computation of a bcrypt sign-in is the rehash.
  const { calls, result } = await countArgon2(
    () => login('racer', pw),
    () => db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(newer, 'racer'),
  );
  assert.equal(/** @type {any} */ (result).status, 200);
  assert.equal(calls, 1);
  assert.equal(hashOf('racer'), newer, 'the newer password stays');
});

test('login: an SSO-only and an unknown account answer as before, a wrong password too', async () => {
  account('sso', OIDC_PASSWORD_SENTINEL);
  account('argon', await hashPassword('correct-horse-1'));
  const expected = { error: 'Invalid credentials.', code: 401 };
  for (const [username, password] of [['sso', 'anything-1'], ['nobody', 'anything-1'], ['argon', 'wrong-horse-1']]) {
    const res = await login(username, password);
    assert.equal(res.status, 401, username);
    assert.deepEqual(res.body, expected, username);
  }
  assert.equal(hashOf('sso'), OIDC_PASSWORD_SENTINEL);
});

test('timing: unknown account, SSO-only account and a wrong password cost one Argon2id computation each', async () => {
  for (const [username, password] of [['nobody', 'anything-1'], ['sso', 'anything-1'], ['argon', 'wrong-horse-1'], ['argon', 'correct-horse-1']]) {
    const { calls } = await countArgon2(() => login(username, password));
    assert.equal(calls, 1, `${username} / ${password}`);
  }
});

test('crypto.argon2 emits no process warning', async () => {
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(warnings, []);
});
