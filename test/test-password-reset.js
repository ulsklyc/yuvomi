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

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

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

// --- Routes (forgot/reset) ------------------------------------------------
import express from 'express';
import bcrypt from 'bcrypt';

function makeAuthApp(db, { baseUrl = 'https://oikos.test' } = {}) {
  // Lazy import so the route module reads our injected services.
  return import('../server/auth.js').then(({ buildResetRoutes }) => {
    const sent = [];
    const app = express();
    app.use(express.json());
    const router = express.Router();
    buildResetRoutes(router, {
      database: db,
      emailService: { isConfigured: () => true, sendMail: async (m) => { sent.push(m); } },
      resetService: createPasswordResetService({ db }),
      baseUrl,
      limiter: (_req, _res, next) => next(), // bypass rate limiting in tests
    });
    app.use('/auth', router);
    return { app, sent };
  });
}

async function callJson(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, json };
}

function seedContactsAndEmail(db) {
  db.exec(`CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT,
    family_user_id INTEGER, email TEXT);`);
  db.prepare("INSERT INTO contacts (family_user_id, email) VALUES (1, 'alice@test')").run();
}

test('forgot-password returns generic ok for unknown user (no email sent)', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app, sent } = await makeAuthApp(db);
  const { status, json } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'ghost' });
  assert.equal(status, 200);
  assert.equal(json.data.ok, true);
  assert.equal(sent.length, 0);
});

test('forgot-password sends a reset link for a known username', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app, sent } = await makeAuthApp(db);
  const { status, json } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  assert.equal(status, 200);
  assert.equal(json.data.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'alice@test');
  assert.match(sent[0].html, /https:\/\/oikos\.test\/reset-password\?token=[a-f0-9]+/);
});

test('forgot-password sends no link when no trusted BASE_URL is configured (no host-header fallback)', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app, sent } = await makeAuthApp(db, { baseUrl: '' });
  const { status, json } = await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  assert.equal(status, 200);
  assert.equal(json.data.ok, true);
  assert.equal(sent.length, 0);
});

test('forgot-password runs the rate limiter on every request (counts 200 responses)', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  let calls = 0;
  const { buildResetRoutes } = await import('../server/auth.js');
  const app = express();
  app.use(express.json());
  const router = express.Router();
  buildResetRoutes(router, {
    database: db,
    emailService: { isConfigured: () => true, sendMail: async () => {} },
    resetService: createPasswordResetService({ db }),
    baseUrl: 'https://oikos.test',
    limiter: (_req, _res, next) => { calls += 1; next(); },
  });
  app.use('/auth', router);
  // Two known-user requests both return 200 — the limiter must still count both.
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  assert.equal(calls, 2);
});

test('forgot-password also resolves a user by email', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice@test' });
  assert.equal(sent.length, 1);
});

test('reset-password rejects an invalid token', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const { app } = await makeAuthApp(db);
  const { status } = await callJson(app, 'POST', '/auth/reset-password', { token: 'bad', password: 'longenough' });
  assert.equal(status, 400);
});

test('reset-password rejects a short password', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  const svc = createPasswordResetService({ db });
  const { token } = svc.createToken(1);
  const { app } = await makeAuthApp(db);
  const { status } = await callJson(app, 'POST', '/auth/reset-password', { token, password: 'short' });
  assert.equal(status, 400);
});

test('reset-password updates the hash and consumes the token', async () => {
  const db = makeDb();
  seedContactsAndEmail(db);
  // Re-issue the token through the same service instance the route uses:
  const { app, sent } = await makeAuthApp(db);
  await callJson(app, 'POST', '/auth/forgot-password', { identifier: 'alice' });
  const token = sent[0].html.match(/token=([a-f0-9]+)/)[1];
  const { status } = await callJson(app, 'POST', '/auth/reset-password', { token, password: 'brandnewpw' });
  assert.equal(status, 200);
  const hash = db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash;
  assert.equal(await bcrypt.compare('brandnewpw', hash), true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM password_resets').get().c, 0);
});
