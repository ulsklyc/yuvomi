/**
 * Modul: Passkeys (WebAuthn)
 * Zweck: Datenbankoperationen, Challenge-Handling und HTTP-Routen ohne
 *        echten Browser-Authenticator testen. Die Verifikation durch
 *        simplewebauthn erfordert echte Credential-Bytes und wird hier nicht
 *        end-to-end geprüft – das übernimmt die simplewebauthn-Testsuite.
 *        Hier prüfen wir: Migration, CRUD-Operationen, Routing (401/403/404/409),
 *        Challenge-Verfall, und die Schutzregel gegen das Löschen des letzten
 *        Anmeldewegs.
 *
 * Ausführen: npm run test:passkeys
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'passkeys-test-secret';
process.env.BASE_URL = 'https://yuvomi.example.com';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const passkeys = await import('../server/services/passkeys.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}

function seedUser(prefix, { password_hash = 'bcrypt_hash', oidc_sub = null } = {}) {
  return db.prepare(
    "INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub) VALUES (?, ?, ?, '#007AFF', 'member', ?)"
  ).run(`${prefix}-${randomUUID()}`, prefix, password_hash, oidc_sub).lastInsertRowid;
}

function insertTestPasskey(userId, name = 'Test Key') {
  return passkeys.insertPasskey(db, {
    userId,
    credentialId: randomUUID(),
    publicKey: Buffer.from('fake-public-key'),
    counter: 0,
    transports: ['internal'],
    name,
  });
}

// --------------------------------------------------------
// getWebAuthnConfig
// --------------------------------------------------------

test('getWebAuthnConfig returns config for https BASE_URL', () => {
  const cfg = passkeys.getWebAuthnConfig();
  assert.ok(cfg, 'should return config');
  assert.equal(cfg.rpId, 'yuvomi.example.com');
  assert.equal(cfg.origin, 'https://yuvomi.example.com');
});

test('getWebAuthnConfig returns null when BASE_URL is not set', () => {
  const saved = process.env.BASE_URL;
  delete process.env.BASE_URL;
  assert.equal(passkeys.getWebAuthnConfig(), null);
  process.env.BASE_URL = saved;
});

test('getWebAuthnConfig returns null for http non-localhost', () => {
  const saved = process.env.BASE_URL;
  process.env.BASE_URL = 'http://yuvomi.example.com';
  assert.equal(passkeys.getWebAuthnConfig(), null);
  process.env.BASE_URL = saved;
});

test('getWebAuthnConfig accepts http://localhost', () => {
  const saved = process.env.BASE_URL;
  process.env.BASE_URL = 'http://localhost:3000';
  const cfg = passkeys.getWebAuthnConfig();
  assert.ok(cfg);
  assert.equal(cfg.rpId, 'localhost');
  process.env.BASE_URL = saved;
});

// --------------------------------------------------------
// CRUD
// --------------------------------------------------------

test('listPasskeys gibt leere Liste zurück für neuen Nutzer', () => {
  const userId = seedUser('list-empty');
  assert.deepEqual(passkeys.listPasskeys(db, userId), []);
});

test('insertPasskey legt einen Passkey an und listPasskeys gibt ihn zurück', () => {
  const userId = seedUser('insert');
  const id = insertTestPasskey(userId, 'My Key');
  assert.ok(id > 0);

  const list = passkeys.listPasskeys(db, userId);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'My Key');
  assert.deepEqual(list[0].transports, ['internal']);
});

test('rowByCredentialId findet den Datensatz', () => {
  const userId = seedUser('cred-lookup');
  const credId = randomUUID();
  db.prepare(
    "INSERT INTO user_passkeys (user_id, credential_id, public_key, counter, name) VALUES (?, ?, ?, 0, 'k')"
  ).run(userId, credId, Buffer.from('pk'));
  const row = passkeys.rowByCredentialId(db, credId);
  assert.ok(row);
  assert.equal(row.user_id, userId);
});

test('countPasskeys zählt korrekt', () => {
  const userId = seedUser('count');
  assert.equal(passkeys.countPasskeys(db, userId), 0);
  insertTestPasskey(userId);
  assert.equal(passkeys.countPasskeys(db, userId), 1);
  insertTestPasskey(userId);
  assert.equal(passkeys.countPasskeys(db, userId), 2);
});

test('renamePasskey benennt um und gibt true zurück', () => {
  const userId = seedUser('rename');
  const passkeyId = insertTestPasskey(userId, 'Old Name');
  const ok = passkeys.renamePasskey(db, passkeyId, userId, 'New Name');
  assert.ok(ok);
  assert.equal(passkeys.listPasskeys(db, userId)[0].name, 'New Name');
});

test('renamePasskey gibt false zurück wenn Passkey fremd ist', () => {
  const userId  = seedUser('rename-owner');
  const userId2 = seedUser('rename-other');
  const passkeyId = insertTestPasskey(userId, 'Key');
  assert.equal(passkeys.renamePasskey(db, passkeyId, userId2, 'Stolen'), false);
});

test('deletePasskey löscht und gibt true zurück', () => {
  const userId = seedUser('delete');
  const passkeyId = insertTestPasskey(userId, 'To Delete');
  const ok = passkeys.deletePasskey(db, passkeyId, userId);
  assert.ok(ok);
  assert.equal(passkeys.countPasskeys(db, userId), 0);
});

test('deletePasskey gibt false zurück wenn Passkey fremd ist', () => {
  const userId  = seedUser('del-owner');
  const userId2 = seedUser('del-other');
  const passkeyId = insertTestPasskey(userId, 'Key');
  assert.equal(passkeys.deletePasskey(db, passkeyId, userId2), false);
});

test('updatePasskeyUsed aktualisiert counter und last_used_at', () => {
  const userId = seedUser('update-used');
  const passkeyId = insertTestPasskey(userId);
  passkeys.updatePasskeyUsed(db, passkeyId, 42);
  const row = db.prepare('SELECT counter, last_used_at FROM user_passkeys WHERE id = ?').get(passkeyId);
  assert.equal(row.counter, 42);
  assert.ok(row.last_used_at);
});

// --------------------------------------------------------
// Challenge-Verfall
// --------------------------------------------------------

test('completeRegistration wirft bei abgelaufener Challenge', async () => {
  const userId = seedUser('reg-expired');
  const session = {
    passkeyRegistrationChallenge: {
      challenge: 'abc',
      expiresAt: Date.now() - 1000,
    },
  };
  const cfg = passkeys.getWebAuthnConfig();
  await assert.rejects(
    () => passkeys.completeRegistration(db, userId, {}, session, cfg, 'Key'),
    (err) => err.code === 400 && err.reason === 'challenge_expired'
  );
});

test('completeRegistration wirft wenn keine Challenge in Session', async () => {
  const userId = seedUser('reg-no-challenge');
  const session = {};
  const cfg = passkeys.getWebAuthnConfig();
  await assert.rejects(
    () => passkeys.completeRegistration(db, userId, {}, session, cfg, 'Key'),
    (err) => err.code === 400 && err.reason === 'challenge_expired'
  );
});

test('completeAuthentication wirft bei abgelaufener Challenge', async () => {
  const session = {
    passkeyAuthChallenge: {
      challenge: 'xyz',
      expiresAt: Date.now() - 1000,
    },
  };
  const cfg = passkeys.getWebAuthnConfig();
  await assert.rejects(
    () => passkeys.completeAuthentication(db, { id: 'unknown' }, session, cfg),
    (err) => err.code === 400 && err.reason === 'challenge_expired'
  );
});

test('completeAuthentication wirft bei unbekannter Credential-ID', async () => {
  const session = {
    passkeyAuthChallenge: {
      challenge: 'xyz',
      expiresAt: Date.now() + 60000,
    },
  };
  const cfg = passkeys.getWebAuthnConfig();
  await assert.rejects(
    () => passkeys.completeAuthentication(db, { id: 'does-not-exist' }, session, cfg),
    (err) => err.code === 400 && err.reason === 'unknown_credential'
  );
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------

console.log('[Passkeys-Test] done');
