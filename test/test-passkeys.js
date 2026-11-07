import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import test from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'passkey-test-session-secret';
process.env.RATE_LIMIT_MAX_ATTEMPTS = '1000';
process.env.BASE_URL = 'https://planner.example.test';
delete process.env.AUTH_ALLOW_PASSWORD_LOGIN;

const passkeys = await import('../server/services/passkeys.js');
const { get } = await import('../server/db.js');
const database = get();
const digest = value => createHash('sha256').update(value).digest();
const b64 = value => Buffer.from(value).toString('base64url');
const origin = process.env.BASE_URL;
const rpID = new URL(origin).hostname;
let serial = 0;
function user() {
  const n = ++serial;
  return database.prepare("INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, 'hash') RETURNING *").get(`passkey-${n}`, `Person ${n}`);
}
function authenticator() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  return { ...keys, id: b64(randomBytes(32)), cose: isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]])) };
}
function registration(options, device, overrides = {}) {
  const clientDataJSON = b64(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, ...overrides.client }));
  const id = Buffer.from(device.id, 'base64url');
  const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
  const authData = Buffer.concat([digest(rpID), Buffer.from([overrides.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, Buffer.from(device.cose)]);
  return { id: device.id, rawId: device.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, attestationObject: b64(isoCBOR.encode(new Map([['fmt', 'none'], ['authData', new Uint8Array(authData)], ['attStmt', new Map()]]))), transports: ['internal'] } };
}
function assertion(options, device, handle, overrides = {}) {
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, ...overrides.client }));
  const counter = Buffer.alloc(4); counter.writeUInt32BE(overrides.counter ?? 1);
  const authData = Buffer.concat([digest(overrides.rpID ?? rpID), Buffer.from([overrides.flags ?? 0x05]), counter]);
  const signature = sign('sha256', Buffer.concat([authData, digest(clientData)]), device.privateKey);
  if (overrides.badSignature) signature[signature.length - 1] ^= 1;
  return { id: device.id, rawId: device.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: handle } };
}
async function enroll(person, session = `session-${person.id}`) {
  const device = authenticator();
  const options = await passkeys.beginRegistration(database, person, session);
  await passkeys.finishRegistration(database, person.id, session, registration(options, device), 'My phone');
  return { device, handle: options.user.id, session };
}

test('a verified discoverable credential signs in, records use and exposes no public key in the list', async () => {
  const person = user(); const { device, handle, session } = await enroll(person);
  const options = await passkeys.beginAuthentication(database, session);
  assert.deepEqual(options.allowCredentials ?? [], []);
  assert.equal(options.userVerification, 'required');
  const result = await passkeys.finishAuthentication(database, session, assertion(options, device, handle));
  assert.equal(result.userId, person.id);
  const rows = passkeys.list(database, person.id);
  assert.equal(rows[0].name, 'My phone'); assert.ok(rows[0].last_used_at);
  assert.equal(rows[0].public_key, undefined);
});

test('challenge use is session-bound, expires, and is single-use even after failure', async () => {
  const person = user(); const device = authenticator();
  let options = await passkeys.beginRegistration(database, person, 'correct-session');
  await assert.rejects(passkeys.finishRegistration(database, person.id, 'other-session', registration(options, device), 'Phone'));
  options = await passkeys.beginRegistration(database, person, 'correct-session');
  database.prepare('UPDATE passkey_challenges SET expires_at = 0').run();
  await assert.rejects(passkeys.finishRegistration(database, person.id, 'correct-session', registration(options, device), 'Phone'));
  options = await passkeys.beginRegistration(database, person, 'correct-session');
  const response = registration(options, device, { client: { origin: 'https://evil.example.test' } });
  await assert.rejects(passkeys.finishRegistration(database, person.id, 'correct-session', response, 'Phone'));
  await assert.rejects(passkeys.finishRegistration(database, person.id, 'correct-session', registration(options, device), 'Phone'));
});

test('registration requires user verification and never reassigns an existing credential', async () => {
  const person = user(); const other = user(); const { device } = await enroll(person);
  let options = await passkeys.beginRegistration(database, other, 'other');
  await assert.rejects(passkeys.finishRegistration(database, other.id, 'other', registration(options, device), 'Stolen'));
  options = await passkeys.beginRegistration(database, other, 'other');
  await assert.rejects(passkeys.finishRegistration(database, other.id, 'other', registration(options, authenticator(), { flags: 0x41 }), 'No UV'));
  assert.equal(passkeys.list(database, other.id).length, 0);
});

test('assertions reject wrong origin, RP, signature, handle and missing user verification', async () => {
  const person = user(); const { device, handle, session } = await enroll(person);
  for (const override of [{client:{origin:'https://evil.example.test'}}, {rpID:'evil.example.test'}, {badSignature:true}, {flags:1}]) {
    const options = await passkeys.beginAuthentication(database, session);
    await assert.rejects(passkeys.finishAuthentication(database, session, assertion(options, device, handle, override)));
  }
  const options = await passkeys.beginAuthentication(database, session);
  await assert.rejects(passkeys.finishAuthentication(database, session, assertion(options, device, b64('another-user'))));
});

test('assertion replay and a non-increasing authenticator counter are rejected', async () => {
  const person = user(); const { device, handle, session } = await enroll(person);
  const options = await passkeys.beginAuthentication(database, session);
  const response = assertion(options, device, handle);
  await passkeys.finishAuthentication(database, session, response);
  await assert.rejects(passkeys.finishAuthentication(database, session, response));
  const next = await passkeys.beginAuthentication(database, session);
  await assert.rejects(passkeys.finishAuthentication(database, session, assertion(next, device, handle)));
});

test('removal checks ownership, cascades on user deletion, and limits enrollment', async () => {
  const person = user(); const other = user(); await enroll(person);
  const id = passkeys.list(database, person.id)[0].id;
  assert.equal(passkeys.remove(database, other.id, id), false);
  assert.equal(passkeys.list(database, person.id).length, 1);
  assert.equal(passkeys.remove(database, person.id, id), true);
  await enroll(person);
  database.prepare('DELETE FROM users WHERE id = ?').run(person.id);
  assert.equal(passkeys.list(database, person.id).length, 0);
});

test('origin configuration is explicit and never taken from a request Host', () => {
  const saved = process.env.BASE_URL;
  for (const value of ['', 'http://planner.example.test', 'https://user:password@planner.example.test', 'https://planner.example.test/path', 'https://127.0.0.1']) {
    process.env.BASE_URL = value; assert.equal(passkeys.configuration(), null, value);
  }
  process.env.BASE_URL = 'http://localhost:3000'; assert.equal(passkeys.configuration().rpID, 'localhost');
  process.env.BASE_URL = saved;
});

let httpSerial = 0;
async function httpFixture() {
  const { default: express } = await import('express');
  const { router, sessionMiddleware } = await import('../server/auth.js');
  const app = express(); app.set('trust proxy', 'loopback'); app.use(express.json()); app.use(sessionMiddleware);
  const clientIP = `198.51.100.${++httpSerial}`;
  app.post('/__test/stale', (req, res) => { req.session.authenticatedAt = 0; res.json({ ok: true }); });
  app.get('/__test/proof', (req, res) => res.json({ userId: req.session.userId, authenticatedAt: req.session.authenticatedAt, mfaVerifiedAt: req.session.mfaVerifiedAt, sessionId: req.sessionID, csrf: req.session.csrfToken }));
  app.use((req, _res, next) => {
    if ((req.headers['x-test-sso-switch'] || req.headers['x-test-revoke-session']) && req.body?.credential && req.session.userId) {
      const credentialId = req.body.credential.id;
      Object.defineProperty(req.body.credential, 'id', { get() {
        if (req.headers['x-test-sso-switch']) database.prepare("UPDATE users SET password_hash = '$oidc$' WHERE id = ?").run(req.session.userId);
        if (req.headers['x-test-revoke-session']) database.prepare('DELETE FROM sessions WHERE sid = ?').run(req.sessionID);
        return credentialId;
      } });
    }
    next();
  });
  app.use('/api/v1/auth', router);
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.on('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map(); let csrf = '';
  async function call(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type':'application/json', Origin:origin, 'X-Forwarded-For':clientIP,
      Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '), 'X-CSRF-Token':csrf, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const item = cookie.split(';')[0]; const i=item.indexOf('='); cookies.set(item.slice(0,i),item.slice(i+1)); }
    const data = await response.json(); if(data.csrfToken) csrf=data.csrfToken;
    return { status:response.status, data };
  }
  const route = (p, method, body, headers) => call('/api/v1/auth' + p, method, body, headers);
  return { route, call, cookies, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

const managementRoutes = [
  ['GET', '/passkeys'],
  ['POST', '/passkeys/register/options'],
  ['POST', '/passkeys/register/verify'],
  ['POST', '/passkeys/reauth/options'],
  ['POST', '/passkeys/reauth/verify'],
  ['DELETE', '/passkeys/1'],
];
const publicPasskeyRoutes = [
  ['GET', '/passkeys/config'],
  ['POST', '/passkeys/login/options'],
  ['POST', '/passkeys/login/verify'],
];

test('a guest session cannot manage passkeys but can sign in as a household member with credential proof', async () => {
  const { route, call, close } = await httpFixture();
  const { hashPassword } = await import('../server/utils/password.js');
  const guest = user(); const member = user(); const own = await enroll(member);
  const password = 'Guest-test-password-123!';
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), guest.id);
  database.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(guest.id);
  try {
    assert.equal((await route('/login', 'POST', {username:guest.username, password})).status, 200);
    const before = (await call('/__test/proof')).data;
    const challengeCount = database.prepare('SELECT count(*) AS n FROM passkey_challenges').get().n;
    for (const [method, path] of managementRoutes) {
      const response = await route(path, method, method === 'GET' ? undefined : {});
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.data.reason, 'split_guest_scope');
    }
    assert.equal(database.prepare('SELECT count(*) AS n FROM passkey_challenges').get().n, challengeCount);
    assert.equal(passkeys.list(database, guest.id).length, 0);
    assert.equal((await route('/passkeys/config')).status, 200);
    const options = await route('/passkeys/login/options', 'POST', {});
    assert.equal(options.status, 200);
    const response = await route('/passkeys/login/verify', 'POST', {credential:assertion(options.data.data, own.device, own.handle)});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.user.id, member.id);
    const after = (await call('/__test/proof')).data;
    assert.equal(after.userId, member.id);
    assert.notEqual(after.sessionId, before.sessionId);
    assert.equal((await route('/passkeys')).status, 200);
  } finally {
    await close();
    database.prepare('DELETE FROM users WHERE id = ?').run(guest.id);
  }
});

test('device credentials, scoped tokens and paired displays cannot reach any passkey route', async () => {
  const { route, close } = await httpFixture();
  const person = user();
  const { issuePairingCode, redeemPairingCode } = await import('../server/services/display-accounts.js');
  const display = user();
  database.prepare("UPDATE users SET password_hash = '$display$' WHERE id = ?").run(display.id);
  database.prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(display.id, person.id);
  const paired = redeemPairingCode(issuePairingCode(display.id, person.id, {db:database}).code, {db:database});
  const deviceToken = 'yuvomi_passkey_device_boundary';
  const scopedToken = 'yuvomi_passkey_scoped_boundary';
  database.prepare("INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id, kind, platform, device_id) VALUES (?, ?, ?, ?, ?, 'device', 'test', 'passkey-boundary')")
    .run('Passkey device boundary', digest(deviceToken).toString('hex'), 'yuvomi_test', person.id, person.id);
  database.prepare('INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, scopes) VALUES (?, ?, ?, ?, ?)')
    .run('Passkey scoped boundary', digest(scopedToken).toString('hex'), 'yuvomi_test', person.id, JSON.stringify(['notes:read']));
  const challengeCount = database.prepare('SELECT count(*) AS n FROM passkey_challenges').get().n;
  try {
    for (const [headers, reason] of [
      [{Authorization:`Bearer ${deviceToken}`}, 'device_credential'],
      [{Authorization:`Bearer ${scopedToken}`}, undefined],
      [{Cookie:`yuvomi.display=${paired.token}`}, 'display_account'],
    ]) {
      for (const [method, path] of [...managementRoutes, ...publicPasskeyRoutes]) {
        const response = await route(path, method, method === 'GET' ? undefined : {}, headers);
        assert.equal(response.status, 403, `${reason ?? 'scoped token'}: ${method} ${path}`);
        if (reason) assert.equal(response.data.reason, reason);
      }
    }
    assert.equal(database.prepare('SELECT count(*) AS n FROM passkey_challenges').get().n, challengeCount);
    assert.equal(passkeys.list(database, person.id).length, 0);
  } finally { await close(); }
});

test('HTTP enrollment and sign-in preserve CSRF, session, policy, account and 2FA gates', async () => {
  const { route, call, cookies, close } = await httpFixture();
  const { hashPassword } = await import('../server/utils/password.js');
  const person = user(); const password = 'Test-only-password-123!';
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), person.id);
  try {
    assert.equal((await route('/passkeys')).status,401);
    let response = await route('/login','POST',{username:person.username,password}); assert.equal(response.status,200);
    const legacyToken = 'yuvomi_test_passkey_scope';
    database.prepare('INSERT INTO api_tokens (name, token_hash, token_prefix, created_by) VALUES (?, ?, ?, ?)')
      .run('Legacy test token', digest(legacyToken).toString('hex'), 'yuvomi_test', person.id);
    const tokenResult = await route('/passkeys/register/options', 'POST', {}, { Authorization: `Bearer ${legacyToken}` });
    assert.equal(tokenResult.data.reason, 'browser_session_required', 'even an unscoped API token cannot enroll a credential');
    database.prepare('DELETE FROM api_tokens WHERE name = ?').run('Legacy test token');
    assert.equal((await route('/passkeys/register/options','POST',{}, {'X-CSRF-Token':''})).status,403);
    assert.equal((await route('/passkeys/register/options','POST',{}, {Origin:'https://evil.example.test'})).status,403);
    const options = (await route('/passkeys/register/options','POST',{})).data.data;
    assert.ok(options.challenge);
    const device = authenticator();
    response = await route('/passkeys/register/verify','POST',{credential:registration(options,device),name:'Test phone'});
    assert.equal(response.status,200,JSON.stringify(response.data));
    assert.equal((await route('/passkeys')).data.data.passkeys.length,1);
    await call('/__test/stale','POST',{});
    assert.equal((await route('/passkeys/register/options','POST',{})).data.reason,'passkey_reauth_required');
    await route('/logout','POST',{});
    const authOptions = (await route('/passkeys/login/options','POST',{})).data.data;
    const before = JSON.stringify([...cookies]);
    response = await route('/passkeys/login/verify','POST',{credential:assertion(authOptions,device,options.user.id)});
    assert.equal(response.status,200,JSON.stringify(response.data));
    assert.equal(response.data.user.id,person.id);
    assert.notEqual(JSON.stringify([...cookies]),before,'sign-in regenerates the session');
    const signedIn = (await call('/__test/proof')).data;
    const normalSession = JSON.parse(database.prepare('SELECT sess FROM sessions WHERE sid = ?').get(signedIn.sessionId).sess);
    assert.ok(normalSession.cookie.originalMaxAge > 5 * 60_000, 'successful proof starts the normal session lifetime');
    assert.equal((await route('/me')).data.user.id,person.id);
    const row = passkeys.list(database,person.id)[0];
    // A UV-verified passkey satisfies MFA; the password route keeps its TOTP step.
    database.prepare("INSERT INTO user_totp (user_id, secret, confirmed_at) VALUES (?, 'JBSWY3DPEHPK3PXP', '2026-01-01')").run(person.id);
    await route('/logout','POST',{});
    let next = (await route('/passkeys/login/options','POST',{})).data.data;
    response = await route('/passkeys/login/verify','POST',{credential:assertion(next,device,options.user.id,{counter:2})});
    assert.equal(response.status,200);
    assert.equal(response.data.twoFactorRequired,undefined);
    assert.equal((await route('/me')).data.user.id,person.id);
    assert.ok((await call('/__test/proof')).data.mfaVerifiedAt);
    await route('/logout','POST',{});
    database.prepare('DELETE FROM user_totp WHERE user_id = ?').run(person.id);
    // A valid credential never reactivates a deactivated account.
    next = (await route('/passkeys/login/options','POST',{})).data.data;
    database.prepare("UPDATE users SET deactivated_at = '2026-01-01' WHERE id = ?").run(person.id);
    response = await route('/passkeys/login/verify','POST',{credential:assertion(next,device,options.user.id,{counter:3})});
    assert.equal(response.data.reason,'account_cannot_sign_in');
    assert.equal((await route('/me')).status,401);
    database.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(person.id);
    // The per-account SSO-only flag is independent of the household-wide policy.
    const oldHash = database.prepare('SELECT password_hash FROM users WHERE id = ?').get(person.id).password_hash;
    database.prepare("UPDATE users SET password_hash = '$oidc$' WHERE id = ?").run(person.id);
    next = (await route('/passkeys/login/options','POST',{})).data.data;
    response = await route('/passkeys/login/verify','POST',{credential:assertion(next,device,options.user.id,{counter:4})});
    assert.equal(response.data.reason,'passkey_policy');
    database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(oldHash, person.id);
    // Once SSO-only policy is effective, native passkeys cannot bypass it.
    process.env.OIDC_ISSUER='https://idp.example.test'; process.env.OIDC_CLIENT_ID='test'; process.env.OIDC_CLIENT_SECRET='test'; process.env.OIDC_REDIRECT_URI='https://planner.example.test/callback';
    database.prepare("UPDATE users SET role = 'admin', oidc_sub = 'linked-admin' WHERE id = ?").run(person.id);
    process.env.AUTH_ALLOW_PASSWORD_LOGIN='false';
    assert.equal((await route('/passkeys/login/options','POST',{})).data.reason,'passkey_policy');
    assert.ok(row.id);
  } finally {
    delete process.env.AUTH_ALLOW_PASSWORD_LOGIN;
    for (const key of ['OIDC_ISSUER','OIDC_CLIENT_ID','OIDC_CLIENT_SECRET','OIDC_REDIRECT_URI']) delete process.env[key];
    await close();
  }
});

test('an account cannot enroll more than ten credentials', async () => {
  const person = user();
  for (let n = 0; n < 10; n++) await enroll(person);
  await assert.rejects(passkeys.beginRegistration(database, person, 'over-limit'));
  assert.equal(passkeys.list(database, person.id).length, 10);
});

test('registration checks eligibility again after asynchronous cryptographic verification', async () => {
  const person = user(); const device = authenticator();
  const options = await passkeys.beginRegistration(database, person, 'changed-policy');
  await assert.rejects(passkeys.finishRegistration(database, person.id, 'changed-policy', registration(options, device), 'Phone', () => false));
  assert.equal(passkeys.list(database, person.id).length, 0);
});


test('reauthentication binds challenges to the current account and separates anonymous sign-in', async () => {
  const person = user(); const other = user();
  const own = await enroll(person); const foreign = await enroll(other);
  const session = 'reauth-session';
  let options = await passkeys.beginAuthentication(database, session, person.id);
  assert.deepEqual(options.allowCredentials.map(c => c.id), [own.device.id]);
  await assert.rejects(passkeys.finishAuthentication(database, session, assertion(options, foreign.device, foreign.handle), person.id));
  await assert.rejects(passkeys.finishAuthentication(database, session, assertion(options, own.device, own.handle), person.id), 'failed proof consumes the challenge');
  options = await passkeys.beginAuthentication(database, session);
  await assert.rejects(passkeys.finishAuthentication(database, session, assertion(options, own.device, own.handle), person.id), 'sign-in challenge cannot reauthenticate');
  options = await passkeys.beginAuthentication(database, session, person.id);
  await assert.rejects(passkeys.finishAuthentication(database, session, assertion(options, own.device, own.handle)), 'reauth challenge cannot sign in');
  options = await passkeys.beginAuthentication(database, session, person.id);
  assert.equal((await passkeys.finishAuthentication(database, session, assertion(options, own.device, null), person.id)).userId, person.id, 'allowCredentials may omit the handle');
});

test('HTTP inline reauth refreshes only after correct proof and preserves identity, CSRF, 2FA and policy', async () => {
  const { route, call, close } = await httpFixture();
  const { hashPassword } = await import('../server/utils/password.js');
  const { generateCode } = await import('../server/utils/totp.js');
  const { regenerateRecoveryCodes } = await import('../server/services/two-factor.js');
  const person = user(); const password = 'Reauth-test-only-123!';
  const hash = await hashPassword(password);
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, person.id);
  const own = await enroll(person);
  const secret = 'JBSWY3DPEHPK3PXP';
  try {
    assert.equal((await route('/passkeys/reauth/verify', 'POST', { method:'password', password })).status, 401);
    await route('/login', 'POST', {username:person.username, password});
    await call('/__test/stale', 'POST', {});
    const before = (await call('/__test/proof')).data;
    const checkStale = async () => assert.equal((await route('/passkeys/register/options', 'POST', {})).data.reason, 'passkey_reauth_required');
    await checkStale();
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'password', password:'wrong'})).status, 400);
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'password', password}, {'X-CSRF-Token':''})).status, 403);
    assert.equal((await route('/passkeys/reauth/options', 'POST', {}, {Origin:'https://evil.example.test'})).status, 403);
    await checkStale();
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'password', password})).status, 200);
    assert.ok((await route('/passkeys/register/options', 'POST', {})).data.data.challenge);
    let after = (await call('/__test/proof')).data;
    assert.equal(after.userId, before.userId); assert.equal(after.sessionId, before.sessionId); assert.equal(after.csrf, before.csrf);
    assert.ok(after.authenticatedAt > before.authenticatedAt);
    await call('/__test/stale', 'POST', {});
    database.prepare("INSERT INTO user_totp (user_id, secret, confirmed_at) VALUES (?, ?, '2026-01-01')").run(person.id, secret);
    assert.equal((await route('/passkeys')).data.data.second_factor_required, true);
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'password', password})).status, 400);
    const code = generateCode(secret, Date.now());
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'password', password:'wrong', code})).status, 400);
    assert.equal(database.prepare('SELECT last_step FROM user_totp WHERE user_id = ?').get(person.id).last_step, null, 'wrong password does not consume TOTP');
    await checkStale();
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'password', password, code})).status, 200);
    await call('/__test/stale', 'POST', {});
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'password', password, code})).status, 400, 'TOTP cannot be replayed');
    let options = (await route('/passkeys/reauth/options', 'POST', {})).data.data;
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'passkey', credential:assertion(options, own.device, own.handle, {flags:1})})).status, 400, 'a passkey without UV cannot satisfy MFA');
    await checkStale();
    const recovery = regenerateRecoveryCodes(database, person.id).recovery_codes[0];
    options = (await route('/passkeys/reauth/options', 'POST', {})).data.data;
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'passkey', credential:assertion(options, own.device, null, {counter:2})})).status, 200);
    assert.equal(database.prepare('SELECT used_at FROM user_recovery_codes WHERE user_id = ? AND code_hash = ?').get(person.id, (await import('../server/utils/totp.js')).hashRecoveryCode(recovery)).used_at, null, 'passkey confirmation does not consume recovery codes');
    after = (await call('/__test/proof')).data;
    assert.equal(after.sessionId, before.sessionId); assert.equal(after.userId, person.id);
    assert.ok((await route('/passkeys/register/options', 'POST', {})).data.data.challenge);
    await call('/__test/stale', 'POST', {});
    database.prepare("UPDATE users SET password_hash = '$oidc$' WHERE id = ?").run(person.id);
    assert.equal((await route('/passkeys/reauth/options', 'POST', {})).data.reason, 'passkey_policy');
    assert.equal((await route('/passkeys/reauth/verify', 'POST', {method:'password', password})).data.reason, 'passkey_policy');
    database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, person.id);
    await checkStale();
    const token = 'yuvomi_reauth_api_test';
    database.prepare('INSERT INTO api_tokens (name, token_hash, token_prefix, created_by) VALUES (?, ?, ?, ?)').run('Reauth token', digest(token).toString('hex'), 'yuvomi_test', person.id);
    for (const path of ['/passkeys/reauth/options', '/passkeys/reauth/verify']) {
      assert.equal((await route(path, 'POST', {method:'password', password}, {Authorization:`Bearer ${token}`})).data.reason, 'browser_session_required');
    }
  } finally { await close(); }
});


test('anonymous options count successful requests and expire sessions within the challenge window', async () => {
  const { route, cookies, close } = await httpFixture();
  const previousSessions = new Set(database.prepare('SELECT sid FROM sessions').all().map(row => row.sid));
  const before = previousSessions.size;
  const start = Date.now();
  try {
    for (let n = 0; n < 20; n++) {
      cookies.clear();
      assert.equal((await route('/passkeys/login/options', 'POST', {})).status, 200);
    }
    cookies.clear();
    assert.equal((await route('/passkeys/login/options', 'POST', {})).status, 429);
    assert.equal(database.prepare('SELECT count(*) AS n FROM sessions').get().n - before, 20);
    const anonymous = database.prepare('SELECT sid, sess, expired_at FROM sessions').all().filter(row => !previousSessions.has(row.sid));
    assert.ok(anonymous.length >= 20);
    for (const row of anonymous) {
      const session = JSON.parse(row.sess);
      if (session.userId) continue;
      assert.ok(session.cookie.originalMaxAge <= 5 * 60_000);
      assert.ok(row.expired_at <= Date.now() + 5 * 60_000);
    }
    assert.ok(Date.now() - start < 60_000, 'the limiter window did not reset during the test');
    const other = await httpFixture();
    try { assert.equal((await other.route('/passkeys/login/options', 'POST', {})).status, 200); }
    finally { await other.close(); }
  } finally { await close(); }
});

test('one client can only evict its own anonymous challenges and cannot exhaust a global cap', async () => {
  const person = user(); const own = await enroll(person);
  const protectedOptions = await passkeys.beginAuthentication(database, own.session, person.id);
  const otherOptions = await passkeys.beginAuthentication(database, 'other-client-session', null, 'other-client');
  for (let n = 0; n < 1020; n++) await passkeys.beginAuthentication(database, `flood-${n}`, null, 'one-client');
  assert.ok(database.prepare('SELECT count(*) AS n FROM passkey_challenges WHERE client_hash = ? AND user_id IS NULL').get(digest('one-client').toString('hex')).n <= 20);
  assert.equal((await passkeys.finishAuthentication(database, own.session, assertion(protectedOptions, own.device, null), person.id)).userId, person.id);
  assert.equal((await passkeys.finishAuthentication(database, 'other-client-session', assertion(otherOptions, own.device, own.handle, {counter:2}))).userId, person.id);
  const options = await passkeys.beginAuthentication(database, 'after-flood');
  assert.ok(options.challenge);
});

test('recovery invalidates registration already in cryptographic verification', async () => {
  const person = user(); await enroll(person);
  const options = await passkeys.beginRegistration(database, person, 'recovery-race');
  const pending = passkeys.finishRegistration(database, person.id, 'recovery-race', registration(options, authenticator()), 'Planted key');
  passkeys.revokeAll(database, person.id);
  await assert.rejects(pending);
  assert.equal(passkeys.list(database, person.id).length, 0);
});

test('an account SSO-only change during registration is read again after verification', async () => {
  const { route, close } = await httpFixture();
  const { hashPassword } = await import('../server/utils/password.js');
  const person = user(); const password = 'SSO-race-test-password!';
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), person.id);
  try {
    await route('/login', 'POST', {username:person.username, password});
    const options = (await route('/passkeys/register/options', 'POST', {})).data.data;
    const response = await route('/passkeys/register/verify', 'POST', {credential:registration(options, authenticator()), name:'SSO key'}, {'X-Test-SSO-Switch':'1'});
    assert.equal(response.status, 400);
    assert.equal(database.prepare('SELECT password_hash FROM users WHERE id = ?').get(person.id).password_hash, '$oidc$', 'the policy changed inside credential verification');
    assert.equal(passkeys.list(database, person.id).length, 0);
  } finally { await close(); }
});

test('the four credential-recovery paths revoke planted passkeys and pending enrollment', async () => {
  const { hashPassword } = await import('../server/utils/password.js');
  const { createPasswordResetService } = await import('../server/services/password-reset.js');
  const { generateCode } = await import('../server/utils/totp.js');
  const password = 'Recovery-test-password-123!'; const hash = await hashPassword(password);
  for (const action of ['password-change', 'password-reset', 'admin-password', 'admin-emergency']) {
    const { route, call, close } = await httpFixture();
    const person = user(); const actor = action.startsWith('admin') ? user() : person;
    database.prepare('UPDATE users SET password_hash = ? WHERE id IN (?, ?)').run(hash, person.id, actor.id);
    if (action.startsWith('admin')) database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(actor.id);
    const own = await enroll(person);
    const other = user(); await enroll(other);
    await passkeys.beginRegistration(database, person, `pending-${action}`);
    try {
      assert.equal((await route('/login', 'POST', {username:actor.username, password})).status, 200);
      let response;
      if (action === 'password-change') response = await route('/me/password', 'PATCH', {current_password:password, new_password:'Replacement-password-123!'});
      if (action === 'password-reset') {
        const { token } = createPasswordResetService({db:database}).createToken(person.id);
        response = await route('/reset-password', 'POST', {token, password:'Replacement-password-123!'});
      }
      if (action === 'admin-password') response = await route(`/users/${person.id}`, 'PATCH', {password:'Replacement-password-123!'});
      if (action === 'admin-emergency') response = await route(`/users/${person.id}/devices/sign-out`, 'POST', {});
      assert.equal(response.status, 200, `${action}: ${JSON.stringify(response.data)}`);
      assert.equal(passkeys.list(database, person.id).length, 0, action);
      assert.equal(database.prepare('SELECT count(*) AS n FROM passkey_challenges WHERE user_id = ?').get(person.id).n, 0);
      assert.equal(passkeys.list(database, other.id).length, 1, 'another member keeps their credential');
      const options = await passkeys.beginAuthentication(database, `recovered-${action}`);
      await assert.rejects(passkeys.finishAuthentication(database, `recovered-${action}`, assertion(options, own.device, own.handle)));
      if (action !== 'password-reset') assert.equal((await call('/__test/proof')).data.userId, actor.id);
    } finally { await close(); }
  }
});

test('removing a passkey ends other sessions while preserving the current session and remaining credentials', async () => {
  const { hashPassword } = await import('../server/utils/password.js');
  const person = user(); const password = 'Remove-test-password-123!';
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), person.id);
  await enroll(person); await enroll(person, 'second-key');
  const first = await httpFixture(); const second = await httpFixture();
  try {
    await first.route('/login', 'POST', {username:person.username, password});
    await second.route('/login', 'POST', {username:person.username, password});
    const before = (await first.call('/__test/proof')).data;
    const response = await first.route(`/passkeys/${passkeys.list(database, person.id)[0].id}`, 'DELETE', {});
    assert.equal(response.status, 200);
    assert.equal(response.data.data.ended, 1);
    assert.equal((await second.route('/me')).status, 401);
    assert.equal((await first.call('/__test/proof')).data.sessionId, before.sessionId);
    assert.equal(passkeys.list(database, person.id).length, 1);
    assert.equal((await first.route(`/passkeys/${passkeys.list(database, person.id)[0].id}`, 'DELETE', {})).status, 200, 'the retained password permits removal of the last passkey');
  } finally { await first.close(); await second.close(); }
});


test('enabling TOTP retains passkeys and UV sign-in satisfies MFA alongside password plus TOTP', async () => {
  const { hashPassword } = await import('../server/utils/password.js');
  const { generateCode } = await import('../server/utils/totp.js');
  const person = user(); const password = 'Parallel-MFA-password-123!';
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), person.id);
  const own = await enroll(person);
  const first = await httpFixture(); const other = await httpFixture();
  try {
    await first.route('/login', 'POST', {username:person.username, password});
    await other.route('/login', 'POST', {username:person.username, password});
    const setup = (await first.route('/2fa/setup', 'POST', {})).data.data;
    const enabled = await first.route('/2fa/enable', 'POST', {code:generateCode(setup.secret, Date.now())});
    assert.equal(enabled.status,200);
    assert.equal(passkeys.list(database,person.id).length,1);
    assert.equal((await other.route('/me')).status,401,'enabling TOTP still ends older sessions');
    await first.route('/logout','POST',{});
    let response=await first.route('/login','POST',{username:person.username,password});
    assert.equal(response.data.twoFactorRequired,true,'password authentication retains its second step');
    assert.equal((await first.route('/me')).status,401);
    const totp=generateCode(setup.secret,Date.now()+30_000);
    assert.equal((await first.route('/2fa/verify','POST',{code:totp})).status,200);
    assert.ok((await first.call('/__test/proof')).data.mfaVerifiedAt);
    await first.route('/logout','POST',{});
    let options=(await first.route('/passkeys/login/options','POST',{})).data.data;
    response=await first.route('/passkeys/login/verify','POST',{credential:assertion(options,own.device,own.handle,{flags:1}),mfaVerifiedAt:Date.now()});
    assert.equal(response.status,400,'client claims never replace verified UV');
    assert.equal((await first.route('/me')).status,401);
    options=(await first.route('/passkeys/login/options','POST',{})).data.data;
    response=await first.route('/passkeys/login/verify','POST',{credential:assertion(options,own.device,own.handle)});
    assert.equal(response.status,200);
    assert.equal(response.data.twoFactorRequired,undefined);
    assert.equal(response.data.user.id,person.id);
    assert.ok((await first.call('/__test/proof')).data.mfaVerifiedAt);
    assert.equal(database.prepare('SELECT count(*) AS n FROM user_recovery_codes WHERE user_id=? AND used_at IS NOT NULL').get(person.id).n,0);
  } finally {await first.close();await other.close();}
});

test('new passkeys need a fresh trusted MFA proof when TOTP became enabled after password sign-in', async () => {
  const { hashPassword }=await import('../server/utils/password.js');
  const person=user(); const password='Enrollment-MFA-password!'; const own=await enroll(person);
  database.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password),person.id);
  const {route,call,close}=await httpFixture();
  try {
    await route('/login','POST',{username:person.username,password});
    database.prepare("INSERT INTO user_totp(user_id,secret,confirmed_at) VALUES (?,'JBSWY3DPEHPK3PXP','2026-01-01')").run(person.id);
    assert.equal((await route('/passkeys/register/options','POST',{})).data.reason,'passkey_reauth_required');
    assert.equal((await route('/passkeys/reauth/verify','POST',{method:'password',password})).status,400);
    const options=(await route('/passkeys/reauth/options','POST',{})).data.data;
    assert.equal((await route('/passkeys/reauth/verify','POST',{method:'passkey',credential:assertion(options,own.device,null)})).status,200);
    const proof=(await call('/__test/proof')).data;
    assert.ok(proof.mfaVerifiedAt);
    assert.equal((await route('/passkeys/register/options','POST',{})).status,200);
  } finally {await close();}
});

test('enrollment cannot finish after its browser session is revoked during verification', async () => {
  const { hashPassword }=await import('../server/utils/password.js');
  const person=user(); const password='Revoked-enrollment-password!';
  database.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password),person.id);
  const {route,close}=await httpFixture();
  try {
    await route('/login','POST',{username:person.username,password});
    const options=(await route('/passkeys/register/options','POST',{})).data.data;
    const result=await route('/passkeys/register/verify','POST',{credential:registration(options,authenticator()),name:'Stale session'}, {'X-Test-Revoke-Session':'1'});
    assert.equal(result.status,400);
    assert.equal(passkeys.list(database,person.id).length,0);
    assert.equal((await route('/me')).status,401);
  } finally {await close();}
});

test('passkey sign-in and reauth log verification failures without secrets and distinguish internal errors', async () => {
  const {hashPassword}=await import('../server/utils/password.js');
  const person=user(); const password='Never-log-this-password!'; const own=await enroll(person);
  database.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password),person.id);
  const {route,close}=await httpFixture();
  const warnings=[];const errors=[];const warn=console.warn;const error=console.error;const prepare=database.prepare;
  console.warn=(...args)=>warnings.push(args);console.error=(...args)=>errors.push(args);
  try {
    let options=(await route('/passkeys/login/options','POST',{})).data.data;
    assert.equal((await route('/passkeys/login/verify','POST',{credential:assertion(options,own.device,own.handle,{badSignature:true})})).status,400);
    assert.ok(warnings.some(args=>args[1]==='Passkey sign-in failed'&&args[2].ip&&args[2].reason));
    options=(await route('/passkeys/login/options','POST',{})).data.data;
    database.prepare=function(sql){if(sql.includes('DELETE FROM passkey_challenges WHERE session_hash'))throw new Error('Simulated database failure');return prepare.call(this,sql);};
    const failed=await route('/passkeys/login/verify','POST',{credential:assertion(options,own.device,own.handle)});
    assert.equal(failed.status,500);
    assert.equal(JSON.stringify(failed.data).includes('Simulated'),false);
    assert.ok(errors.some(args=>args[1]==='Passkey sign-in error'&&args[2].reason==='internal_error'));
    database.prepare=prepare;
    await route('/login','POST',{username:person.username,password});
    assert.equal((await route('/passkeys/reauth/verify','POST',{method:'password',password:'Never-log-this-invalid-password!'})).status,400);
    assert.ok(warnings.some(args=>args[2]?.operation==='reauth'));
    database.prepare=function(sql){if(sql.includes('DELETE FROM passkey_challenges WHERE session_hash'))throw new Error('Simulated options failure');return prepare.call(this,sql);};
    assert.equal((await route('/passkeys/reauth/options','POST',{})).status,500);
    assert.ok(errors.some(args=>args[2]?.operation==='reauth'));
    const logged=JSON.stringify([warnings,errors]);
    assert.equal(logged.includes('Never-log-this'),false);
    assert.equal(logged.includes(own.device.id),false);
    assert.equal(logged.includes(own.handle),false);
  } finally {database.prepare=prepare;console.warn=warn;console.error=error;await close();}
});


test('passkey reauthentication cannot revive a session revoked during verification', async () => {
  const {hashPassword}=await import('../server/utils/password.js');
  const person=user();const password='Revoked-reauth-password!';const own=await enroll(person);
  database.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password),person.id);
  const {route,call,close}=await httpFixture();
  try {
    await route('/login','POST',{username:person.username,password});
    await call('/__test/stale','POST',{});
    const options=(await route('/passkeys/reauth/options','POST',{})).data.data;
    const result=await route('/passkeys/reauth/verify','POST',{method:'passkey',credential:assertion(options,own.device,null)},{'X-Test-Revoke-Session':'1'});
    assert.equal(result.status,400);
    assert.equal((await route('/me')).status,401);
  } finally {await close();}
});
