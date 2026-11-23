/**
 * Modul: Passwort-Hashing (Argon2id) mit Unicode-Normalisierung
 * Zweck: Gehasht wird mit Argon2id (RFC 9106) in den Parametern des OWASP
 *        Password Storage Cheat Sheet (m=19456 KiB, t=2, p=1), gespeichert als
 *        PHC-String `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. bcrypt las
 *        nur die ersten 72 Byte: zwei Passwoerter, die sich erst ab Byte 73
 *        unterschieden, waren dasselbe Passwort (bei Emoji ab dem 19. Zeichen),
 *        obwohl das Schema 1024 Zeichen zulaesst. Argon2id liest alles.
 *
 *        Gehasht wird immer die NFC-Form: Browser liefern Passwort-Eingaben
 *        unterschiedlich normalisiert aus (Firefox/macOS NFD, Safari/iOS NFC),
 *        dadurch schlug der Login mit Umlauten je nach Browser fehl (#608).
 *
 *        Alte bcrypt-Hashes (`$2a$`/`$2b$`/`$2y$`) werden nur noch geprueft,
 *        nie mehr erzeugt: `verifyPassword` meldet fuer jeden bcrypt-Treffer
 *        `needsRehash`, und die Anmeldung schreibt dann einen Argon2id-Hash.
 *
 *        Kein Paket: Argon2id liegt seit Node 24.7 in `node:crypto`
 *        (`crypto.argon2`), die engines verlangen `^24.12.0 || >=26.0.0`.
 *        `bcrypt` bleibt Abhaengigkeit, solange eine bcrypt-Zeile existieren
 *        kann - ohne Klartext laesst sich ein Hash nicht umrechnen, er wird
 *        erst bei der naechsten Anmeldung ersetzt. Das ist die Bedingung der
 *        Migration, kein Aufschub (Gruppe 12, Entscheidung 21).
 *
 *        `crypto.argon2` wird erst beim Aufruf vom geteilten Modulobjekt
 *        gelesen (nie `argon2Sync`, nie beim Laden gebunden): Tests haengen
 *        sich dort ein, um Berechnungen zu zaehlen oder anzuhalten.
 * Abhängigkeiten: node:crypto, bcrypt
 */

import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

/** Parameter jedes neuen Hashes (OWASP: m=19456 KiB, t=2, p=1; Tag 32 Byte). */
export const ARGON2_PARAMS = Object.freeze({ memory: 19456, passes: 2, parallelism: 1, tagLength: 32 });

const ARGON2_VERSION = 19; // 0x13
const SALT_BYTES = 16;
// Kuerzere Tags gelten als kaputt, nicht als schwach: ein Tag unter 16 Byte
// ist kein Hash, den diese App je geschrieben hat.
const MIN_TAG_BYTES = 16;
const MIN_SALT_BYTES = 8;
const BCRYPT_PREFIX = /^\$2[aby]\$/;
const BASE64_NO_PAD = /^[A-Za-z0-9+/]+$/;
const PHC_PARAMS = /^m=(\d{1,10}),t=(\d{1,10}),p=(\d{1,10})$/;

/** Kanonische Form eines Passworts: NFC. @param {unknown} password @returns {string} */
export function normalizePassword(password) {
  return String(password ?? '').normalize('NFC');
}

/** Base64 ohne Padding, Standardalphabet (PHC-Referenz). @param {Buffer} buffer */
function encodeB64(buffer) {
  return buffer.toString('base64').replace(/=+$/, '');
}

/** Strenges Gegenstueck: nur kanonisches Base64 ohne Padding, sonst null. @param {string} text */
function decodeB64(text) {
  if (!BASE64_NO_PAD.test(text)) return null;
  const buffer = Buffer.from(text, 'base64');
  return encodeB64(buffer) === text ? buffer : null;
}

/**
 * Eine Argon2id-Berechnung, asynchron im Threadpool.
 * @param {string} message
 * @param {Buffer} nonce
 * @param {{ memory: number, passes: number, parallelism: number, tagLength: number }} params
 * @returns {Promise<Buffer>}
 */
function argon2id(message, nonce, params) {
  return new Promise((resolve, reject) => {
    crypto.argon2('argon2id', { message, nonce, ...params }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Zerlegt einen Argon2id-PHC-String streng; alles Unerwartete ist null.
 * @param {string} hash
 */
function parseArgon2id(hash) {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'argon2id') return null;
  if (parts[2] !== `v=${ARGON2_VERSION}`) return null;
  const match = PHC_PARAMS.exec(parts[3]);
  if (!match) return null;
  const [memory, passes, parallelism] = match.slice(1).map(Number);
  if (!Number.isSafeInteger(memory) || !Number.isSafeInteger(passes) || !Number.isSafeInteger(parallelism)) return null;
  if (memory < 1 || passes < 1 || parallelism < 1) return null;
  const salt = decodeB64(parts[4]);
  const tag = decodeB64(parts[5]);
  if (!salt || !tag || salt.length < MIN_SALT_BYTES || tag.length < MIN_TAG_BYTES) return null;
  return { memory, passes, parallelism, salt, tag };
}

/**
 * Hasht ein Passwort in kanonischer NFC-Form mit Argon2id.
 * @param {unknown} password
 * @returns {Promise<string>} PHC-String
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const tag = await argon2id(normalizePassword(password), salt, ARGON2_PARAMS);
  const { memory, passes, parallelism } = ARGON2_PARAMS;
  return `$argon2id$v=${ARGON2_VERSION}$m=${memory},t=${passes},p=${parallelism}$${encodeB64(salt)}$${encodeB64(tag)}`;
}

/**
 * Ein bcrypt-Vergleich, der an einem kaputten Hash scheitert statt zu werfen.
 * @param {string} candidate @param {string} hash @returns {Promise<boolean>}
 */
async function bcryptMatches(candidate, hash) {
  try {
    return await bcrypt.compare(candidate, hash);
  } catch {
    return false;
  }
}

/**
 * Prüft ein Passwort gegen einen gespeicherten Hash.
 *
 * Argon2id: geprueft wird nur die NFC-Form (jeder Argon2id-Hash ist ueber NFC
 * entstanden). `needsRehash` meldet einen Hash mit schwaecheren Parametern als
 * `ARGON2_PARAMS`.
 *
 * bcrypt (Legacy): zuerst NFC, danach die unveraenderte Eingabe und NFD - die
 * beiden Legacy-Formen decken Hashes aus der Zeit vor #608 ab. Jeder Treffer
 * meldet `needsRehash`, damit die Anmeldung auf Argon2id umstellt. Ein
 * Fehlversuch durchlaeuft immer alle Kandidaten.
 *
 * Jedes andere Format (der SSO-Platzhalter `$oidc$`, leer, null, ein kaputter
 * PHC-String) ist ungueltig und kostet trotzdem eine Argon2id-Berechnung mit
 * den aktuellen Parametern: ein Fehlversuch dauert so lange wie an einem Konto
 * mit Passwort. Geworfen wird nie.
 *
 * @param {unknown} password
 * @param {unknown} hash gespeicherter `password_hash`
 * @returns {Promise<{ valid: boolean, needsRehash: boolean }>}
 */
export async function verifyPassword(password, hash) {
  const raw = String(password ?? '');
  const nfc = raw.normalize('NFC');
  const stored = typeof hash === 'string' ? hash : '';

  if (BCRYPT_PREFIX.test(stored)) {
    const candidates = [nfc];
    for (const variant of [raw, raw.normalize('NFD')]) {
      if (!candidates.includes(variant)) candidates.push(variant);
    }
    for (const candidate of candidates) {
      if (await bcryptMatches(candidate, stored)) return { valid: true, needsRehash: true };
    }
    return { valid: false, needsRehash: false };
  }

  const parsed = stored.startsWith('$argon2id$') ? parseArgon2id(stored) : null;
  if (!parsed) {
    try {
      await argon2id(nfc, crypto.randomBytes(SALT_BYTES), ARGON2_PARAMS);
    } catch {
      // Nur Zeitausgleich - das Ergebnis zaehlt nicht.
    }
    return { valid: false, needsRehash: false };
  }

  let computed;
  try {
    computed = await argon2id(nfc, parsed.salt, {
      memory: parsed.memory,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.tag.length,
    });
  } catch {
    return { valid: false, needsRehash: false };
  }
  if (computed.length !== parsed.tag.length || !crypto.timingSafeEqual(computed, parsed.tag)) {
    return { valid: false, needsRehash: false };
  }
  const needsRehash = parsed.memory < ARGON2_PARAMS.memory
    || parsed.passes < ARGON2_PARAMS.passes
    || parsed.parallelism < ARGON2_PARAMS.parallelism
    || parsed.tag.length < ARGON2_PARAMS.tagLength;
  return { valid: true, needsRehash };
}
