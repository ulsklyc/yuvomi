/**
 * Modul: Einladungs-Service
 * Zweck: Einladungs-Tokens erzeugen (nur Hash gespeichert), prüfen, als eingelöst
 *        markieren, widerrufen, offene auflisten und abgelaufene aufräumen.
 * Abhängigkeiten: node:crypto, server/db.js
 */
import crypto from 'node:crypto';
import * as dbModule from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('Invites');
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Spalten, die nach außen dürfen: token_hash ist hier bewusst nicht dabei.
// `permissions` schon: die Startrechte einer offenen Einladung sind das, was
// der Admin gewählt hat, und die Liste offener Einladungen darf sie zeigen
// (#869). Sie enthalten keine Geheimnisse, nur Modulschlüssel.
const PUBLIC_COLUMNS = `id, email, username, display_name, role, family_role,
  permissions, created_by, expires_at, accepted_at, accepted_user_id, revoked_at,
  created_at`;

export function createInviteService({ db, now = () => Date.now() } = {}) {
  const getDb = () => (db || dbModule.get());

  function hash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // Gleiches Format wie der created_at-Default der Tabelle (ohne Millisekunden).
  function stamp() {
    return new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * `permissions` ist das AUFGELOESTE Startrechte-Set als JSON-Text oder null
   * (#869). null heisst "nichts eigenes" und ist das Verhalten aller
   * Einladungen, die vor Migration 171 entstanden sind - die Spalte ist
   * nullable, damit dieser Fall keinen Wert braucht, den jemand deuten muss.
   */
  function createInvite({
    email = null, username = null, displayName = null,
    role = 'member', familyRole = 'other', createdBy = null, permissions = null,
  } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = now() + INVITE_TTL_MS;
    const info = getDb().prepare(`
      INSERT INTO invites (token_hash, email, username, display_name, role,
                           family_role, permissions, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(hash(token), email, username, displayName, role, familyRole,
           permissions, createdBy, expiresAt);
    return { token, id: Number(info.lastInsertRowid), expiresAt };
  }

  /**
   * Liefert die Einladung nur, wenn sie einlösbar ist. Alle vier Ausschlussgründe
   * gehören hierher: ein vergessener Zweig macht Einladungen mehrfach einlösbar.
   */
  function verifyToken(token) {
    if (!token) return null;
    const row = getDb().prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM invites WHERE token_hash = ?`
    ).get(hash(token));
    if (!row) return null;                    // unbekannt
    if (row.expires_at <= now()) return null; // abgelaufen
    if (row.accepted_at) return null;         // bereits eingelöst
    if (row.revoked_at) return null;          // widerrufen
    return row;
  }

  /**
   * Markiert die Einladung als eingelöst. Die Bedingungen stehen im WHERE, damit
   * der Aufrufer den Ausgang an `changes` erkennt: zwei parallele Einlösungen
   * desselben Tokens sehen so nur einmal changes === 1.
   *
   * Der Ablauf gehört mit ins WHERE, obwohl verifyToken ihn schon geprüft hat:
   * dazwischen liegt beim Einlösen ein Passwort-Hash (Argon2id, rund 20 ms), und in dem
   * Fenster darf die Frist nicht stillschweigend überschritten werden.
   */
  function markAccepted(token, userId) {
    const info = getDb().prepare(`
      UPDATE invites SET accepted_at = ?, accepted_user_id = ?
      WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > ?
    `).run(stamp(), userId, hash(token), now());
    return info.changes;
  }

  /** Widerruft eine offene Einladung. Kein DELETE: die Spur bleibt erhalten. */
  function revoke(id) {
    const info = getDb().prepare(`
      UPDATE invites SET revoked_at = ?
      WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
    `).run(stamp(), id);
    return info.changes;
  }

  /** Offene (nicht eingelöste, nicht widerrufene, nicht abgelaufene) Einladungen. */
  function listOpen() {
    return getDb().prepare(`
      SELECT ${PUBLIC_COLUMNS} FROM invites
      WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, id DESC
    `).all(now());
  }

  /**
   * Räumt abgelaufene Einladungen ab, die nie zu etwas geführt haben.
   * Eingelöste und widerrufene bleiben: beide sind eine Entscheidung, die jemand
   * getroffen hat ("wer hat wen eingeladen", "wer hat das zurückgenommen"), und
   * revoke() löscht aus genau diesem Grund nicht. Ein Aufräumjob, der sie später
   * doch entfernt, hebt die Entscheidung nachträglich auf.
   */
  function cleanupExpired() {
    const info = getDb().prepare(
      'DELETE FROM invites WHERE expires_at <= ? AND accepted_at IS NULL AND revoked_at IS NULL'
    ).run(now());
    if (info.changes) log.info(`Cleaned up ${info.changes} expired invite(s)`);
    return info.changes;
  }

  return { createInvite, verifyToken, markAccepted, revoke, listOpen, cleanupExpired };
}

export const inviteService = createInviteService();
