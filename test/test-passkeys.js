import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import test from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'passkey-test-session-secret';
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

test('HTTP enrollment and sign-in preserve CSRF, session, policy, account and 2FA gates', async () => {
  const { default: express } = await import('express');
  const { router, sessionMiddleware } = await import('../server/auth.js');
  const { hashPassword } = await import('../server/utils/password.js');
  const app = express(); app.use(express.json()); app.use(sessionMiddleware);
  app.post('/__test/stale', (req, res) => { req.session.authenticatedAt = 0; res.json({ ok: true }); });
  app.use('/api/v1/auth', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map(); let csrf = '';
  async function call(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type':'application/json', Origin:origin,
      Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '), 'X-CSRF-Token':csrf, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const item = cookie.split(';')[0]; const i=item.indexOf('='); cookies.set(item.slice(0,i),item.slice(i+1)); }
    const data = await response.json(); if(data.csrfToken) csrf=data.csrfToken;
    return { status:response.status, data };
  }
  const route = (p, method, body, headers) => call('/api/v1/auth' + p, method, body, headers);
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
    assert.equal((await route('/me')).data.user.id,person.id);
    const row = passkeys.list(database,person.id)[0];
    // A second factor stays a second step after a successful passkey assertion.
    database.prepare("INSERT INTO user_totp (user_id, secret, confirmed_at) VALUES (?, 'JBSWY3DPEHPK3PXP', '2026-01-01')").run(person.id);
    await route('/logout','POST',{});
    let next = (await route('/passkeys/login/options','POST',{})).data.data;
    response = await route('/passkeys/login/verify','POST',{credential:assertion(next,device,options.user.id,{counter:2})});
    assert.equal(response.data.twoFactorRequired,true);
    assert.equal((await route('/me')).status,401,'pending 2FA is not a signed-in session');
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
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
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
