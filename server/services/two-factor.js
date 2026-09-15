// --------------------------------------------------------
// Zwei-Faktor-Anmeldung: Einrichtung, Pruefung, Wiederherstellung (#672).
//
// Die Rechenarbeit steht in `utils/totp.js`, hier steht, was mit der Datenbank
// geschieht. Getrennt von `auth.js`, weil die Datei dort bereits alles von
// OIDC bis API-Token traegt - und weil sich diese Regeln so ohne HTTP testen
// lassen.
//
// Zwei Entscheidungen, die den Rest erklaeren:
//
//  1. Ein unbestaetigtes Geheimnis liegt in derselben Zeile wie ein
//     bestaetigtes, nur mit `confirmed_at IS NULL`. Ein Geheimnis, das noch
//     niemand mit einem Code belegt hat, schuetzt nichts und kann gefahrlos
//     herumliegen, bis es ersetzt wird. Dafuer ueberlebt die Einrichtung einen
//     Reload, und der Nutzer muss den QR nicht erneut scannen.
//
//  2. Das Abschalten verlangt einen zweiten Faktor, kein Passwort. Wer die
//     Sitzung gekapert hat, kommt so nicht daran vorbei; wer das Geraet
//     verloren hat, nimmt einen Wiederherstellungscode. Ein Passwort waere
//     hier zusaetzlich der falsche Nachweis: OIDC-Konten haben keins.
// --------------------------------------------------------

import {
  generateSecret, verifyCode, otpauthUri,
  generateRecoveryCodes, hashRecoveryCode, RECOVERY_CODE_COUNT,
} from '../utils/totp.js';
import { qrToDataUrl } from '../utils/qrcode.js';
import { createLogger } from '../logger.js';

const log = createLogger('2fa');

const CONFIG_KEY_REQUIRED = 'require_two_factor';

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} userId
 * @returns {{ user_id: number, secret: string, confirmed_at: string|null, last_step: number|null }|undefined}
 */
function row(db, userId) {
  return db.prepare('SELECT * FROM user_totp WHERE user_id = ?').get(userId);
}

/**
 * Ist die Zwei-Faktor-Anmeldung fuer diesen Nutzer scharf?
 * @param {object} db
 * @param {number} userId
 * @returns {boolean}
 */
export function isEnabled(db, userId) {
  const entry = row(db, userId);
  return Boolean(entry && entry.confirmed_at);
}

/**
 * Verlangt der Haushalt die Zwei-Faktor-Anmeldung von allen?
 * @param {object} db
 * @returns {boolean}
 */
export function isRequiredForHousehold(db) {
  const cfg = db.prepare('SELECT value FROM sync_config WHERE key = ?').get(CONFIG_KEY_REQUIRED);
  return cfg?.value === '1';
}

/**
 * Setzt oder loescht die haushaltsweite Pflicht.
 * @param {object} db
 * @param {boolean} required
 */
export function setRequiredForHousehold(db, required) {
  if (required) {
    db.prepare(`
      INSERT INTO sync_config (key, value)
      VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(CONFIG_KEY_REQUIRED);
  } else {
    db.prepare('DELETE FROM sync_config WHERE key = ?').run(CONFIG_KEY_REQUIRED);
  }
}

/**
 * Zustand fuer die Oberflaeche.
 * @param {object} db
 * @param {number} userId
 * @returns {{ enabled: boolean, pending: boolean, recovery_remaining: number, required: boolean }}
 */
export function getStatus(db, userId) {
  const entry = row(db, userId);
  const remaining = db.prepare(
    'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL'
  ).get(userId);
  return {
    enabled: Boolean(entry && entry.confirmed_at),
    pending: Boolean(entry && !entry.confirmed_at),
    recovery_remaining: remaining?.n ?? 0,
    required: isRequiredForHousehold(db),
  };
}

/**
 * Beginnt die Einrichtung: neues Geheimnis, QR-Bild, Klartext zum Abtippen.
 *
 * Ein bereits bestaetigtes Geheimnis wird NICHT ueberschrieben - sonst
 * genuegte ein versehentlicher Klick, um den zweiten Faktor eines aktiven
 * Kontos zu ersetzen. Wer wechseln will, schaltet erst ab.
 *
 * @param {object} db
 * @param {{ id: number, username: string }} user
 * @returns {{ secret: string, uri: string, qr: string }}
 */
export function beginSetup(db, user) {
  if (isEnabled(db, user.id)) {
    const err = new Error('Two-factor authentication is already enabled.');
    err.code = 'already_enabled';
    throw err;
  }

  const secret = generateSecret();
  db.prepare(`
    INSERT INTO user_totp (user_id, secret, confirmed_at, last_step)
    VALUES (?, ?, NULL, NULL)
    ON CONFLICT(user_id) DO UPDATE SET secret       = excluded.secret,
                                       confirmed_at = NULL,
                                       last_step    = NULL
  `).run(user.id, secret);

  const uri = otpauthUri({ secret, account: user.username });
  return { secret, uri, qr: qrToDataUrl(uri, { moduleSize: 6 }) };
}

/**
 * Schliesst die Einrichtung ab. Der Code beweist, dass die App wirklich
 * dasselbe Geheimnis traegt und die Uhren zusammenpassen.
 *
 * @param {object} db
 * @param {number} userId
 * @param {string} code
 * @param {{ nowMs?: number }} [opts] Zeitpunkt, gegen den geprueft wird - der
 *        Test setzt ihn, damit er nicht an der Wanduhr haengt.
 * @returns {{ recovery_codes: string[] }}
 */
export function confirmSetup(db, userId, code, { nowMs = Date.now() } = {}) {
  const entry = row(db, userId);
  if (!entry) {
    const err = new Error('No pending setup.');
    err.code = 'no_pending_setup';
    throw err;
  }
  if (entry.confirmed_at) {
    const err = new Error('Two-factor authentication is already enabled.');
    err.code = 'already_enabled';
    throw err;
  }

  const result = verifyCode(entry.secret, code, { nowMs, afterStep: entry.last_step });
  if (!result.valid) {
    const err = new Error('Invalid code.');
    err.code = 'invalid_code';
    throw err;
  }

  const codes = generateRecoveryCodes();
  const insert = db.prepare('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)');

  db.transaction(() => {
    db.prepare(`
      UPDATE user_totp
         SET confirmed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), last_step = ?
       WHERE user_id = ?
    `).run(result.step, userId);
    db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
    for (const plain of codes) insert.run(userId, hashRecoveryCode(plain));
  })();

  log.info('Two-factor authentication enabled', { userId });
  return { recovery_codes: codes };
}

/**
 * Prueft einen zweiten Faktor: erst als TOTP, dann als Wiederherstellungscode.
 *
 * @param {object} db
 * @param {number} userId
 * @param {string} code
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ valid: boolean, method: 'totp'|'recovery'|null, recovery_remaining: number }}
 */
export function verifySecondFactor(db, userId, code, { nowMs = Date.now() } = {}) {
  const entry = row(db, userId);
  if (!entry || !entry.confirmed_at) return { valid: false, method: null, recovery_remaining: 0 };

  const totp = verifyCode(entry.secret, code, { nowMs, afterStep: entry.last_step });
  if (totp.valid) {
    db.prepare('UPDATE user_totp SET last_step = ? WHERE user_id = ?').run(totp.step, userId);
    return { valid: true, method: 'totp', recovery_remaining: countRecovery(db, userId) };
  }

  // Wiederherstellungscode: der Vergleich laeuft ueber den Hash, also holt die
  // Abfrage genau die eine passende, noch unbenutzte Zeile.
  const hash = hashRecoveryCode(code);
  const match = db.prepare(`
    SELECT id FROM user_recovery_codes
     WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
  `).get(userId, hash);

  if (!match) return { valid: false, method: null, recovery_remaining: countRecovery(db, userId) };

  db.prepare(`
    UPDATE user_recovery_codes
       SET used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `).run(match.id);

  const remaining = countRecovery(db, userId);
  log.warn('Two-factor recovery code used', { userId, remaining });
  return { valid: true, method: 'recovery', recovery_remaining: remaining };
}

/**
 * @param {object} db
 * @param {number} userId
 * @returns {number}
 */
function countRecovery(db, userId) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL'
  ).get(userId)?.n ?? 0;
}

/**
 * Schaltet die Zwei-Faktor-Anmeldung ab. Der Aufrufer hat den zweiten Faktor
 * bereits geprueft.
 *
 * @param {object} db
 * @param {number} userId
 */
export function disable(db, userId) {
  db.transaction(() => {
    db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  })();
  log.info('Two-factor authentication disabled', { userId });
}

/**
 * Wirft alle Wiederherstellungscodes weg und legt einen frischen Satz an.
 * Die alten sind danach wertlos, auch die noch unbenutzten - das ist der Sinn.
 *
 * @param {object} db
 * @param {number} userId
 * @returns {{ recovery_codes: string[] }}
 */
export function regenerateRecoveryCodes(db, userId) {
  if (!isEnabled(db, userId)) {
    const err = new Error('Two-factor authentication is not enabled.');
    err.code = 'not_enabled';
    throw err;
  }
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const insert = db.prepare('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
    for (const plain of codes) insert.run(userId, hashRecoveryCode(plain));
  })();
  log.info('Two-factor recovery codes regenerated', { userId });
  return { recovery_codes: codes };
}

/**
 * Wer im Haushalt hat den zweiten Faktor eingerichtet - fuer die
 * Familienverwaltung. Ohne diese Sicht ist die Pflicht blind: ein Admin
 * schaltete sie ein, ohne zu wissen, wen er damit vor eine Aufgabe stellt.
 *
 * JEDES KONTO, NICHT NUR DIE MITGLIEDER (#1207): der zweite Faktor schuetzt
 * Konten, nicht Mitgliedschaft. Die Admin-Uebersicht listet deshalb jedes
 * Konto, und die Liste steht in der Allowlist des Guards.
 *
 * Bewusst nur der Ja-Nein-Zustand, keine Zeitstempel und keine Zahl der
 * Wiederherstellungscodes - das geht auch einen Admin nichts an.
 *
 * @param {object} db
 * @returns {Array<{ user_id: number, display_name: string, enabled: boolean }>}
 */
export function householdOverview(db) {
  return db.prepare(`
    SELECT u.id                          AS user_id,
           u.display_name                AS display_name,
           (t.confirmed_at IS NOT NULL)  AS enabled
      FROM users u
      LEFT JOIN user_totp t ON t.user_id = u.id
     ORDER BY u.display_name
  `).all().map((row) => ({ ...row, enabled: row.enabled === 1 }));
}
