/**
 * Tests: OIDC/SSO-Integration
 * Ausführen: node --experimental-sqlite test-oidc.js
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion fehlgeschlagen');
}

// ─── Hilfsfunktion: Schema-DB aufbauen ───────────────────────────────────────

function buildSchemaDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  // MIGRATIONS_SQL[1] ist ein zusammengeführter Basis-Snapshot aller Tabellen
  // bis v10 (kein sequentielles Replay — db-schema-test.js ist kein inkrementeller
  // Migrations-Log). Migration 42 wird danach als echter Schritt angewendet.
  db.exec(MIGRATIONS_SQL[1]);
  if (MIGRATIONS_SQL[42]) db.exec(MIGRATIONS_SQL[42]);
  return db;
}

console.log('\n[OIDC-Test] Migration v42 — Schema\n');

test('users-Tabelle hat oidc_sub-Spalte', () => {
  const db = buildSchemaDb();
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const colNames = cols.map(c => c.name);
  assert(colNames.includes('oidc_sub'), `oidc_sub fehlt in: ${colNames.join(', ')}`);
});

test('users-Tabelle hat oidc_provider-Spalte', () => {
  const db = buildSchemaDb();
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const colNames = cols.map(c => c.name);
  assert(colNames.includes('oidc_provider'), `oidc_provider fehlt in: ${colNames.join(', ')}`);
});

test('Eindeutiger Index idx_users_oidc_sub existiert', () => {
  const db = buildSchemaDb();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_oidc_sub'").get();
  assert(idx !== undefined, 'Index idx_users_oidc_sub nicht gefunden');
});

test('OIDC-Nutzer kann ohne Passwort angelegt werden', () => {
  const db = buildSchemaDb();
  db.exec(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub, oidc_provider)
    VALUES ('oidcuser', 'OIDC User', '$oidc$', '#007AFF', 'member', 'sub-abc-123', 'oidc')
  `);
  const user = db.prepare("SELECT * FROM users WHERE oidc_sub = 'sub-abc-123'").get();
  assert(user !== undefined, 'Nutzer nicht gefunden');
  assert(user.password_hash === '$oidc$', `Falscher password_hash: ${user.password_hash}`);
});

test('oidc_sub ist unique — doppelter sub wird abgelehnt', () => {
  const db = buildSchemaDb();
  db.exec(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub, oidc_provider)
    VALUES ('user1', 'User One', '$oidc$', '#007AFF', 'member', 'sub-duplicate', 'oidc')
  `);
  let threw = false;
  try {
    db.exec(`
      INSERT INTO users (username, display_name, password_hash, avatar_color, role, oidc_sub, oidc_provider)
      VALUES ('user2', 'User Two', '$oidc$', '#34C759', 'member', 'sub-duplicate', 'oidc')
    `);
  } catch {
    threw = true;
  }
  assert(threw, 'UNIQUE-Verletzung auf oidc_sub hätte einen Fehler werfen müssen');
});

// ─── isOidcEnabled ────────────────────────────────────────────────────────────
// Hinweis: Da server/services/oidc.js process.env beim Import liest,
// setzen wir die Vars vor dem Import und testen synchron.

console.log('\n[OIDC-Test] isOidcEnabled\n');

// Alle vier Vars gesetzt → aktiviert
{
  process.env.OIDC_ISSUER         = 'https://idp.example.com';
  process.env.OIDC_CLIENT_ID      = 'oikos';
  process.env.OIDC_CLIENT_SECRET  = 'secret';
  process.env.OIDC_REDIRECT_URI   = 'https://app.example.com/callback';

  const { isOidcEnabled } = await import('../server/services/oidc.js');

  test('isOidcEnabled() → true wenn alle vier Vars gesetzt', () => {
    assert(isOidcEnabled() === true, 'Erwartet true');
  });

  delete process.env.OIDC_CLIENT_SECRET;

  test('isOidcEnabled() → false wenn OIDC_CLIENT_SECRET fehlt', () => {
    assert(isOidcEnabled() === false, 'Erwartet false');
  });

  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_REDIRECT_URI;
}

// ─── findOrCreateOidcUser ─────────────────────────────────────────────────────

console.log('\n[OIDC-Test] findOrCreateOidcUser\n');

// Seiteneffekte von server/auth.js neutralisieren, bevor importiert wird:
process.env.SESSION_SECRET = 'test-oidc-secret-minimum-32-chars-xx';
process.env.SESSION_SECURE = 'false';

const { _setTestDatabase } = await import('../server/db.js');
const sessionDb = buildSchemaDb(); // schema_migrations + alle Migrationen; die sessions-Tabelle legt der BetterSQLiteStore-Konstruktor selbst per CREATE TABLE IF NOT EXISTS an
_setTestDatabase(sessionDb);

const { findOrCreateOidcUser } = await import('../server/auth.js');

function buildOidcTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  // Minimales Schema für findOrCreateOidcUser-Tests
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color  TEXT NOT NULL DEFAULT '#007AFF',
      role          TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      family_role   TEXT,
      avatar_data   TEXT,
      oidc_sub      TEXT,
      oidc_provider TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE UNIQUE INDEX idx_users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
    CREATE TABLE split_expense_guest_users (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE contacts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      email          TEXT,
      family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE contact_emails (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      label      TEXT,
      value      TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

// Legt einen lokalen (Nicht-OIDC) Family-User samt Kontakt-E-Mail an.
function addLocalUserWithEmail(db, username, email) {
  const { lastInsertRowid: userId } = db.prepare(
    "INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, '$2b$12$fakehash')",
  ).run(username, username);
  db.prepare(
    'INSERT INTO contacts (name, email, family_user_id) VALUES (?, ?, ?)',
  ).run(username, email, userId);
  return userId;
}

test('legt neuen Nutzer aus OIDC-Userinfo an', () => {
  const db = buildOidcTestDb();
  const userinfo = { sub: 'new-sub-001', email: 'alice@example.com', name: 'Alice', preferred_username: 'alice' };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.oidc_sub === 'new-sub-001', `Falscher oidc_sub: ${user.oidc_sub}`);
  assert(user.display_name === 'Alice', `Falscher display_name: ${user.display_name}`);
  assert(user.password_hash === '$oidc$', `Falscher password_hash: ${user.password_hash}`);
  assert(user.role === 'member', `Falscher role: ${user.role}`);
});

test('findet bestehenden Nutzer über oidc_sub', () => {
  const db = buildOidcTestDb();
  db.exec(`INSERT INTO users (username, display_name, password_hash, oidc_sub, oidc_provider)
           VALUES ('bob', 'Bob', '$oidc$', 'existing-sub-002', 'oidc')`);
  const userinfo = { sub: 'existing-sub-002', email: 'bob@example.com', name: 'Bob' };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Es darf kein zweiter Nutzer angelegt werden');
  assert(user.oidc_sub === 'existing-sub-002', 'Falscher oidc_sub');
});

test('verknüpft bestehenden Account bei verifizierter E-Mail (email_verified=true)', () => {
  const db = buildOidcTestDb();
  const localId = addLocalUserWithEmail(db, 'charlie', 'charlie@example.com');
  const userinfo = { sub: 'link-sub-003', email: 'charlie@example.com', email_verified: true, name: 'Charlie' };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Es darf KEIN zweiter Account angelegt werden — Linking erwartet');
  assert(user.id === localId, `Falscher User verknüpft: ${user.id} statt ${localId}`);
  assert(user.oidc_sub === 'link-sub-003', `oidc_sub nicht gesetzt: ${user.oidc_sub}`);
});

test('verknüpft auch über sekundäre contact_emails-Adresse', () => {
  const db = buildOidcTestDb();
  const userId = addLocalUserWithEmail(db, 'cora', 'cora.primary@example.com');
  const contact = db.prepare('SELECT id FROM contacts WHERE family_user_id = ?').get(userId);
  db.prepare("INSERT INTO contact_emails (contact_id, label, value, is_primary) VALUES (?, 'work', ?, 0)")
    .run(contact.id, 'cora.work@example.com');
  const userinfo = { sub: 'link-sub-sec', email: 'cora.work@example.com', email_verified: true };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Sekundär-E-Mail muss verknüpfen, nicht neu anlegen');
  assert(user.id === userId, `Falscher User verknüpft: ${user.id}`);
});

test('matcht E-Mail case-insensitiv', () => {
  const db = buildOidcTestDb();
  const localId = addLocalUserWithEmail(db, 'carol', 'Carol@Example.com');
  const userinfo = { sub: 'link-sub-ci', email: 'carol@example.COM', email_verified: true };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.id === localId, 'Case-insensitiver E-Mail-Match fehlgeschlagen');
});

test('verknüpft NICHT bei unverifizierter E-Mail (Takeover-Schutz)', () => {
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'charlie', 'charlie@example.com');
  const userinfo = { sub: 'link-sub-004', email: 'charlie@example.com', email_verified: false, name: 'Charlie' };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 2, 'Ohne email_verified muss ein separater Account entstehen');
  assert(user.oidc_sub === 'link-sub-004', `oidc_sub nicht gesetzt: ${user.oidc_sub}`);
  const local = db.prepare("SELECT * FROM users WHERE username = 'charlie'").get();
  assert(local.oidc_sub === null, 'Unverifizierte E-Mail darf keinen Account übernehmen');
});

test('verknüpft NICHT wenn email_verified fehlt (Standard — sicherer Default)', () => {
  delete process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM;
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'charlie', 'charlie@example.com');
  const userinfo = { sub: 'link-sub-005', email: 'charlie@example.com' }; // kein email_verified
  findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 2, 'Fehlendes email_verified darf ohne Opt-in nicht verknüpfen');
});

test('verknüpft wenn email_verified fehlt und OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM=true', () => {
  process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM = 'true';
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'charlie', 'charlie@example.com');
  const userinfo = { sub: 'link-sub-005b', email: 'charlie@example.com' }; // kein email_verified
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 1, 'Mit Opt-in soll fehlender Claim verknüpfen');
  assert(user.oidc_sub === 'link-sub-005b', `oidc_sub nicht gesetzt: ${user.oidc_sub}`);
  delete process.env.OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM;
});

test('verknüpft NICHT bei mehrdeutiger E-Mail (mehrere Treffer)', () => {
  const db = buildOidcTestDb();
  addLocalUserWithEmail(db, 'twin-a', 'twins@example.com');
  addLocalUserWithEmail(db, 'twin-b', 'twins@example.com');
  const userinfo = { sub: 'link-sub-006', email: 'twins@example.com', email_verified: true };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 3, 'Mehrdeutige E-Mail muss neuen Account erzeugen, nicht raten');
  assert(user.oidc_sub === 'link-sub-006', 'Neuer Account muss oidc_sub tragen');
});

test('verknüpft NICHT mit bereits OIDC-gebundenem Account', () => {
  const db = buildOidcTestDb();
  const { lastInsertRowid: userId } = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, oidc_sub, oidc_provider) VALUES ('linked', 'Linked', '$oidc$', 'other-sub', 'oidc')",
  ).run();
  db.prepare('INSERT INTO contacts (name, email, family_user_id) VALUES (?, ?, ?)')
    .run('linked', 'shared@example.com', userId);
  const userinfo = { sub: 'link-sub-007', email: 'shared@example.com', email_verified: true };
  const user = findOrCreateOidcUser(db, userinfo);
  const count = db.prepare('SELECT count(*) as n FROM users').get();
  assert(count.n === 2, 'Ein bereits gebundener Account darf nicht erneut verknüpft werden');
  assert(user.oidc_sub === 'link-sub-007', 'Neuer Account muss eigenen sub tragen');
});

test('vergibt eindeutigen username bei Kollision', () => {
  const db = buildOidcTestDb();
  db.exec(`INSERT INTO users (username, display_name, password_hash)
           VALUES ('dana', 'Dana Local', '$2b$12$fakehash')`);
  const userinfo = { sub: 'collide-sub', preferred_username: 'dana', email: 'dana@example.com' };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.username !== 'dana', `Username-Kollision nicht aufgelöst: ${user.username}`);
  assert(user.username.startsWith('dana-'), `Unerwarteter Username: ${user.username}`);
});

test('legt Nutzer ohne Name mit preferred_username als display_name an', () => {
  const db = buildOidcTestDb();
  const userinfo = { sub: 'no-name-sub', preferred_username: 'dana', email: 'dana@example.com' };
  const user = findOrCreateOidcUser(db, userinfo);
  assert(user.display_name === 'dana', `Falscher display_name: ${user.display_name}`);
});

// ─── Abschluss ────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
