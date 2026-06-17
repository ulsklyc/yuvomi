/**
 * Modul: Password-Reset-Service
 * Zweck: Sichere Reset-Tokens erzeugen (nur Hash gespeichert), prüfen, verbrauchen
 *        und abgelaufene Tokens aufräumen.
 * Abhängigkeiten: node:crypto, server/db.js
 */
import crypto from 'node:crypto';
import * as dbModule from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('PasswordReset');
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export function createPasswordResetService({ db, now = () => Date.now() } = {}) {
  const getDb = () => (db || dbModule.get());

  function hash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  function createToken(userId) {
    // One active token per user: drop any prior ones first.
    getDb().prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = now() + TOKEN_TTL_MS;
    getDb().prepare(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(userId, hash(token), expiresAt);
    return { token, expiresAt };
  }

  function verifyToken(token) {
    if (!token) return null;
    const row = getDb().prepare(
      'SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?'
    ).get(hash(token));
    if (!row) return null;
    if (row.expires_at <= now()) return null;
    return row.user_id;
  }

  function consumeToken(token) {
    getDb().prepare('DELETE FROM password_resets WHERE token_hash = ?').run(hash(token));
  }

  function cleanupExpired() {
    const info = getDb().prepare('DELETE FROM password_resets WHERE expires_at <= ?').run(now());
    if (info.changes) log.info(`Cleaned up ${info.changes} expired reset token(s)`);
    return info.changes;
  }

  return { createToken, verifyToken, consumeToken, cleanupExpired };
}

export const passwordResetService = createPasswordResetService();
