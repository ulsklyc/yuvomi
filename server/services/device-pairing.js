/**
 * Modul: Kopplung eines angemeldeten Geraets (Refs #255)
 * Zweck: Der kurze Code, mit dem eine Browser-Sitzung ein Telefon anmeldet. Ein
 *        Haushalt nur mit SSO hat kein Passwort, das jemand in eine App tippen
 *        koennte.
 *
 * EINE EIGENE TABELLE, NICHT `display_pairing_codes`. `redeemPairingCode()` fragt
 * nicht nach einem Zweck: ein Personen-Code dort liesse sich ueber
 * `POST /displays/pair` einloesen, und diese Route legt ein Display-Geraet an und
 * beendet Sitzungen. Zwei Tabellen machen die Verwechslung unmoeglich.
 *
 * Das Credential selbst entsteht in `server/auth.js`, bei den anderen Wegen zu
 * einem Geraet. Hier liegt nur, was am Code haengt.
 */

import crypto from 'node:crypto';

import { generatePairingCode, normalizePairingCode } from './display-accounts.js';

/** Fuenf Minuten statt der 15 beim Display: dieser Code oeffnet ein persoenliches Konto. */
export const DEVICE_PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

const MAX_ENCODED_ORIGIN_LENGTH = 170;

function hash(code) {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Stellt einen Code aus und entwertet den vorherigen derselben Person: wer auf
 * "neuer Code" tippt, weil der alte verloren ging, erwartet genau das.
 *
 * @returns {{ code: string, expiresAt: string }} der Klartext, genau einmal
 */
export function issueDevicePairingCode(database, userId) {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + DEVICE_PAIRING_CODE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  database.transaction(() => {
    endDevicePairingCodes(database, userId);
    database.prepare(`
      INSERT INTO device_pairing_codes (user_id, code_hash, expires_at) VALUES (?, ?, ?)
    `).run(userId, hash(code), expiresAt);
  })();
  return { code, expiresAt };
}

/**
 * Verbraucht einen Code und nennt die Person dahinter. Laeuft in der Transaktion
 * des Aufrufers: Pruefen, Entwerten und Ausstellen des Credentials sind eine
 * Einheit, und zwischen ihnen liegt kein `await`.
 *
 * @returns {number|null} null fuer unbekannt, abgelaufen und benutzt: EIN
 *          Ergebnis fuer alle drei, damit die Antwort keinen Fall verraet.
 */
export function spendDevicePairingCode(database, rawCode) {
  if (typeof rawCode !== 'string') return null;
  const now = isoNow();
  const row = database.prepare(`
    SELECT id, user_id FROM device_pairing_codes
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
  `).get(hash(normalizePairingCode(rawCode)), now);
  if (!row) return null;
  database.prepare('UPDATE device_pairing_codes SET used_at = ? WHERE id = ?').run(now, row.id);
  return row.user_id;
}

/** Entwertet offene Codes einer Person. `used_at` statt Loeschen, wie beim Display. */
export function endDevicePairingCodes(database, userId) {
  database.prepare(`
    UPDATE device_pairing_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL
  `).run(isoNow(), userId);
}

/**
 * Der App-Link. Dieselbe Zeichenkette steckt im QR-Code und hinter "In der App
 * oeffnen", damit jemand mit nur einem Telefon denselben Weg hat wie mit zweien.
 */
export function devicePairingLink(server, code) {
  return `yuvomi://pair?server=${encodeURIComponent(server)}&code=${code}`;
}

/**
 * Ist das die blosse Adresse einer Instanz, also genau `window.location.origin`?
 * Nur http(s) und ohne Pfad: der Wert landet in einem Link, den eine App oeffnet
 * und dem sie danach ein Credential anvertraut.
 *
 * Die Grenze kommt vom QR-Code und gilt fuer die kodierte Form, in der die
 * Herkunft im Link steht: `qrcode.js` traegt bis Version 10 gut 210 Bytes, Praefix
 * und Code brauchen davon 37. Ohne sie antwortete die Route erst nach dem
 * Ausstellen mit 500, und der vorherige Code waere schon entwertet.
 */
export function isInstanceOrigin(value) {
  if (typeof value !== 'string' || encodeURIComponent(value).length > MAX_ENCODED_ORIGIN_LENGTH) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}
