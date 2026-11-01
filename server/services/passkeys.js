/** Native passkeys. Origin and RP come only from the administrator's BASE_URL. */
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const WINDOW_MS = 5 * 60_000;
const MAX_PASSKEYS = 10;
const MAX_CHALLENGES = 1000;
const sessionHash = id => createHash('sha256').update(String(id)).digest('hex');
const fail = () => new Error('Passkey verification failed.');

export function configuration() {
  if (process.env.PASSKEYS_ENABLED === 'false') return null;
  try {
    const url = new URL(process.env.BASE_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || isIP(url.hostname)) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) return null;
    return { origin: url.origin, rpID: url.hostname, rpName: 'Yuvomi' };
  } catch { return null; }
}

function config() {
  const value = configuration();
  if (!value) throw fail();
  return value;
}

export function list(database, userId) {
  return database.prepare('SELECT id, name, created_at, last_used_at FROM user_passkeys WHERE user_id = ? ORDER BY id').all(userId);
}

export function remove(database, userId, id) {
  return database.prepare('DELETE FROM user_passkeys WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function remember(database, sessionId, operation, challenge, userId = null) {
  database.transaction(() => {
    database.prepare('DELETE FROM passkey_challenges WHERE expires_at <= ?').run(Date.now());
    database.prepare('DELETE FROM passkey_challenges WHERE session_hash = ? AND operation = ?').run(sessionHash(sessionId), operation);
    if (database.prepare('SELECT COUNT(*) AS n FROM passkey_challenges').get().n >= MAX_CHALLENGES) throw fail();
    database.prepare('INSERT INTO passkey_challenges (challenge, session_hash, operation, user_id, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(challenge, sessionHash(sessionId), operation, userId, Date.now() + WINDOW_MS);
  })();
}

// DELETE RETURNING consumes before any asynchronous verification: concurrent
// requests cannot both spend the same challenge, even with stale session copies.
function consume(database, sessionId, operation, userId = null) {
  const row = database.prepare('DELETE FROM passkey_challenges WHERE session_hash = ? AND operation = ? RETURNING *')
    .get(sessionHash(sessionId), operation);
  if (!row || row.expires_at <= Date.now() || row.user_id !== userId) throw fail();
  return row.challenge;
}

function handle(database, userId) {
  database.prepare('INSERT OR IGNORE INTO user_passkey_handles (user_id, user_handle) VALUES (?, ?)')
    .run(userId, randomBytes(32).toString('base64url'));
  return database.prepare('SELECT user_handle FROM user_passkey_handles WHERE user_id = ?').get(userId).user_handle;
}

export async function beginRegistration(database, user, sessionId) {
  const cfg = config();
  if (list(database, user.id).length >= MAX_PASSKEYS) throw fail();
  const credentials = database.prepare('SELECT credential_id, transports FROM user_passkeys WHERE user_id = ?').all(user.id);
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName, rpID: cfg.rpID, userName: user.username,
    userDisplayName: user.display_name, userID: Buffer.from(handle(database, user.id), 'base64url'),
    attestationType: 'none', timeout: WINDOW_MS,
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: credentials.map(row => ({ id: row.credential_id, transports: JSON.parse(row.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  remember(database, sessionId, 'register', options.challenge, user.id);
  return options;
}

export async function finishRegistration(database, userId, sessionId, response, name, isAllowed = () => true) {
  const cfg = config();
  const challenge = consume(database, sessionId, 'register', userId);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw fail();
  const result = await verifyRegistrationResponse({
    response, expectedChallenge: challenge, expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID, requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257],
  });
  if (!result.verified || !result.registrationInfo) throw fail();
  const { credential } = result.registrationInfo;
  const transports = (response.response.transports ?? []).filter(t => ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(t));
  database.transaction(() => {
    if (!isAllowed() || list(database, userId).length >= MAX_PASSKEYS) throw fail();
    database.prepare('INSERT INTO user_passkeys (user_id, credential_id, public_key, counter, transports, name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, credential.id, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(transports), name.trim());
  })();
}

export async function beginAuthentication(database, sessionId) {
  const cfg = config();
  const options = await generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: 'required', timeout: WINDOW_MS });
  remember(database, sessionId, 'authenticate', options.challenge);
  return options;
}

export async function finishAuthentication(database, sessionId, response) {
  const cfg = config();
  const challenge = consume(database, sessionId, 'authenticate');
  if (typeof response?.id !== 'string' || response.id.length > 2048) throw fail();
  const row = database.prepare(`SELECT p.*, h.user_handle FROM user_passkeys p
    JOIN user_passkey_handles h ON h.user_id = p.user_id WHERE p.credential_id = ?`).get(response.id);
  if (!row || response.response?.userHandle !== row.user_handle) throw fail();
  const result = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpID,
    credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) },
    requireUserVerification: true,
  });
  if (!result.verified) throw fail();
  // A concurrent use or deletion must not be overwritten after verification.
  const changed = database.prepare(`UPDATE user_passkeys SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND counter = ?`)
    .run(result.authenticationInfo.newCounter, row.id, row.counter).changes;
  if (!changed) throw fail();
  return { userId: row.user_id };
}
