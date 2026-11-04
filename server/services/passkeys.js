/**
 * Modul: Passkeys (WebAuthn)
 * Zweck: Registrierung und Authentifizierung über WebAuthn-Credentials.
 *        Der Server verwaltet nur den oeffentlichen Schluessel. Challenges
 *        werden kurzzeitig in der Sitzung gehalten und nach Verbrauch geloescht.
 *
 * Trennung: Diese Datei kapselt die Datenbankoperationen und die
 * simplewebauthn-Aufrufe, damit `auth.js` nur den HTTP-Kontext kennen muss.
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { createLogger } from '../logger.js';

const log = createLogger('Passkeys');

/** Wie lange eine Challenge gueltig bleibt (ms). */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// --------------------------------------------------------
// Konfiguration
// --------------------------------------------------------

/**
 * Liefert die WebAuthn-Konfiguration aus BASE_URL.
 * Gibt null zurueck, wenn keine gueltige BASE_URL gesetzt ist.
 *
 * @returns {{ rpId: string, rpName: string, origin: string } | null}
 */
export function getWebAuthnConfig() {
  const base = process.env.BASE_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    const isLocalhost = (
      url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]'
      || url.hostname.endsWith('.localhost')
    );
    if (url.protocol === 'http:' && !isLocalhost) return null;
    if (url.protocol !== 'https:' && !isLocalhost) return null;
    return {
      rpId: url.hostname,
      rpName: 'Yuvomi',
      origin: url.origin,
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------------
// Datenbankoperationen
// --------------------------------------------------------

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} userId
 * @returns {Array<{ id: number, credential_id: string, name: string, created_at: string, last_used_at: string|null, transports: string[]|null }>}
 */
export function listPasskeys(db, userId) {
  const rows = db.prepare(
    'SELECT id, credential_id, name, created_at, last_used_at, transports FROM user_passkeys WHERE user_id = ? ORDER BY created_at ASC'
  ).all(userId);
  return rows.map((r) => ({
    ...r,
    transports: r.transports ? JSON.parse(r.transports) : null,
  }));
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} passkeyId
 * @param {number} userId
 * @returns {{ id: number, credential_id: string, public_key: Buffer, counter: number, transports: string[]|null } | undefined}
 */
function rowByIdAndUser(db, passkeyId, userId) {
  return db.prepare(
    'SELECT id, credential_id, public_key, counter, transports FROM user_passkeys WHERE id = ? AND user_id = ?'
  ).get(passkeyId, userId);
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {string} credentialId
 * @returns {{ id: number, user_id: number, credential_id: string, public_key: Buffer, counter: number, transports: string[]|null } | undefined}
 */
export function rowByCredentialId(db, credentialId) {
  const r = db.prepare(
    'SELECT id, user_id, credential_id, public_key, counter, transports FROM user_passkeys WHERE credential_id = ?'
  ).get(credentialId);
  if (!r) return undefined;
  return { ...r, transports: r.transports ? JSON.parse(r.transports) : null };
}

/**
 * Wie viele Passkeys hat der Nutzer?
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} userId
 * @returns {number}
 */
export function countPasskeys(db, userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM user_passkeys WHERE user_id = ?').get(userId).n;
}

/**
 * Legt einen neuen Passkey an.
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {{ userId: number, credentialId: string, publicKey: Uint8Array, counter: number, transports: string[]|null, name: string }} opts
 * @returns {number} new row id
 */
export function insertPasskey(db, { userId, credentialId, publicKey, counter, transports, name }) {
  const result = db.prepare(
    `INSERT INTO user_passkeys (user_id, credential_id, public_key, counter, transports, name)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, credentialId, Buffer.from(publicKey), counter, transports ? JSON.stringify(transports) : null, name);
  return result.lastInsertRowid;
}

/**
 * Aktualisiert counter und last_used_at nach erfolgreicher Authentifizierung.
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} passkeyId
 * @param {number} newCounter
 */
export function updatePasskeyUsed(db, passkeyId, newCounter) {
  db.prepare(
    "UPDATE user_passkeys SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(newCounter, passkeyId);
}

/**
 * Benennt einen Passkey um.
 * Gibt false zurueck, wenn der Passkey dem Nutzer nicht gehoert oder nicht gefunden wird.
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} passkeyId
 * @param {number} userId
 * @param {string} name
 * @returns {boolean}
 */
export function renamePasskey(db, passkeyId, userId, name) {
  const result = db.prepare(
    'UPDATE user_passkeys SET name = ? WHERE id = ? AND user_id = ?'
  ).run(name, passkeyId, userId);
  return result.changes > 0;
}

/**
 * Loescht einen Passkey.
 * Gibt false zurueck, wenn der Passkey dem Nutzer nicht gehoert.
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} passkeyId
 * @param {number} userId
 * @returns {boolean}
 */
export function deletePasskey(db, passkeyId, userId) {
  const result = db.prepare(
    'DELETE FROM user_passkeys WHERE id = ? AND user_id = ?'
  ).run(passkeyId, userId);
  return result.changes > 0;
}

// --------------------------------------------------------
// Registrierung
// --------------------------------------------------------

/**
 * Erzeugt Registrierungsoptionen und speichert die Challenge in der Sitzung.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {{ id: number, username: string, display_name: string }} user
 * @param {{ rpId: string, rpName: string, origin: string }} config
 * @param {object} session - express-session Objekt
 * @returns {Promise<object>} PublicKeyCredentialCreationOptionsJSON
 */
export async function beginRegistration(db, user, config, session) {
  const existingCredentials = db.prepare(
    'SELECT credential_id, transports FROM user_passkeys WHERE user_id = ?'
  ).all(user.id).map((r) => ({
    id: r.credential_id,
    transports: r.transports ? JSON.parse(r.transports) : [],
  }));

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: new TextEncoder().encode(String(user.id)),
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    attestationType: 'none',
    excludeCredentials: existingCredentials,
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  session.passkeyRegistrationChallenge = {
    challenge: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };

  return options;
}

/**
 * Verifiziert die Registrierungsantwort und speichert den Passkey.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} userId
 * @param {object} registrationResponse
 * @param {object} session
 * @param {{ rpId: string, origin: string }} config
 * @param {string} name - nutzervergebener Name
 * @returns {Promise<{ id: number, credential_id: string, name: string }>}
 */
export async function completeRegistration(db, userId, registrationResponse, session, config, name) {
  const pending = session.passkeyRegistrationChallenge;
  delete session.passkeyRegistrationChallenge;

  if (!pending || pending.expiresAt < Date.now()) {
    throw Object.assign(new Error('No active registration challenge.'), { code: 400, reason: 'challenge_expired' });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: registrationResponse,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    log.warn('Registration verification failed:', err.message);
    throw Object.assign(new Error('Passkey registration failed.'), { code: 400, reason: 'verification_failed' });
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw Object.assign(new Error('Passkey registration not verified.'), { code: 400, reason: 'not_verified' });
  }

  const { credential } = verification.registrationInfo;

  if (db.prepare('SELECT 1 FROM user_passkeys WHERE credential_id = ?').get(credential.id)) {
    throw Object.assign(new Error('Credential already registered.'), { code: 409, reason: 'already_registered' });
  }

  const passkeyId = insertPasskey(db, {
    userId,
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: registrationResponse.response?.transports ?? null,
    name: name || 'Passkey',
  });

  return { id: passkeyId, credential_id: credential.id, name: name || 'Passkey' };
}

// --------------------------------------------------------
// Authentifizierung
// --------------------------------------------------------

/**
 * Erzeugt Authentifizierungsoptionen (discoverable credential flow).
 * Die Challenge wird in der Sitzung gespeichert.
 *
 * @param {{ rpId: string }} config
 * @param {object} session
 * @returns {Promise<object>} PublicKeyCredentialRequestOptionsJSON
 */
export async function beginAuthentication(config, session) {
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials: [],
  });

  session.passkeyAuthChallenge = {
    challenge: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };

  return options;
}

/**
 * Verifiziert die Authentifizierungsantwort.
 * Gibt die userId bei Erfolg zurueck.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {object} authResponse
 * @param {object} session
 * @param {{ rpId: string, origin: string }} config
 * @returns {Promise<number>} userId
 */
export async function completeAuthentication(db, authResponse, session, config) {
  const pending = session.passkeyAuthChallenge;
  delete session.passkeyAuthChallenge;

  if (!pending || pending.expiresAt < Date.now()) {
    throw Object.assign(new Error('No active authentication challenge.'), { code: 400, reason: 'challenge_expired' });
  }

  const storedCredential = rowByCredentialId(db, authResponse.id);
  if (!storedCredential) {
    throw Object.assign(new Error('Unknown credential.'), { code: 400, reason: 'unknown_credential' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: authResponse,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: storedCredential.credential_id,
        publicKey: new Uint8Array(storedCredential.public_key),
        counter: storedCredential.counter,
        transports: storedCredential.transports ?? undefined,
      },
    });
  } catch (err) {
    log.warn('Authentication verification failed:', err.message);
    throw Object.assign(new Error('Passkey authentication failed.'), { code: 400, reason: 'verification_failed' });
  }

  if (!verification.verified) {
    throw Object.assign(new Error('Passkey not verified.'), { code: 400, reason: 'not_verified' });
  }

  updatePasskeyUsed(db, storedCredential.id, verification.authenticationInfo.newCounter);

  return storedCredential.user_id;
}
