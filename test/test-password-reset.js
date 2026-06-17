/**
 * Modul: Password-Reset-Test
 * Zweck: Token-Lebenszyklus (create/verify/consume/cleanup) + Forgot/Reset-Routen.
 * Ausführen: node --experimental-sqlite test/test-password-reset.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPasswordResetService } from '../server/services/password-reset.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE UNIQUE INDEX idx_password_resets_hash ON password_resets(token_hash);
  `);
  db.prepare("INSERT INTO users (id, username) VALUES (1,'alice')").run();
  return db;
}

test('createToken stores only the hash, not the raw token', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db });
  const { token } = svc.createToken(1);
  const row = db.prepare('SELECT token_hash FROM password_resets WHERE user_id = 1').get();
  assert.ok(token.length >= 40);
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('verifyToken returns user id for a valid token, null for unknown', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db });
  const { token } = svc.createToken(1);
  assert.equal(svc.verifyToken(token), 1);
  assert.equal(svc.verifyToken('nope'), null);
});

test('verifyToken returns null for an expired token', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db, now: () => 1000 });
  const { token } = svc.createToken(1); // expires at 1000 + 3600_000
  const svcLater = createPasswordResetService({ db, now: () => 1000 + 3_600_001 });
  assert.equal(svcLater.verifyToken(token), null);
});

test('consumeToken removes the row', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db });
  const { token } = svc.createToken(1);
  svc.consumeToken(token);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets').get().c, 0);
});

test('createToken invalidates prior tokens for the same user', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db });
  const first = svc.createToken(1).token;
  svc.createToken(1);
  assert.equal(svc.verifyToken(first), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets WHERE user_id = 1').get().c, 1);
});

test('cleanupExpired deletes only stale rows', () => {
  const db = makeDb();
  const svc = createPasswordResetService({ db, now: () => 1000 });
  svc.createToken(1);
  const later = createPasswordResetService({ db, now: () => 1000 + 3_600_001 });
  assert.equal(later.cleanupExpired(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets').get().c, 0);
});
