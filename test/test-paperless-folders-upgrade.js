/** Real database upgrades from upstream and the published 2.84 Paperless fork. */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { buildMigratedDatabase } from './helpers/migrated-database.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS, migrate } = await import('../server/db.js');
const OLD_DESCRIPTION = 'Documents: read-only Paperless saved-view folders';
// Frozen schema shipped by commit 7c1c8e4; do not derive it from migration 282.
const OLD_FOLDERS = `
  CREATE TABLE paperless_view_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    account_id INTEGER NOT NULL REFERENCES dms_accounts(id) ON DELETE CASCADE,
    view_id INTEGER NOT NULL CHECK(view_id > 0),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'family')),
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX idx_paperless_view_folders_account ON paperless_view_folders(account_id);
`;

function databaseAt(t, version, fork = false) {
  const db = buildMigratedDatabase(Database, MIGRATIONS.filter((m) => m.version <= version));
  t.after(() => db.close());
  if (fork) {
    db.exec(OLD_FOLDERS);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (276, ?)').run(OLD_DESCRIPTION);
    db.exec(`
      INSERT INTO users (id, username, display_name, password_hash, role)
        VALUES (1, 'owner', 'Owner', 'test', 'admin');
      INSERT INTO dms_accounts (id, provider, name, base_url, api_token)
        VALUES (1, 'paperless', 'Archive', 'https://paperless.example', 'secret');
      INSERT INTO paperless_view_folders (id, name, account_id, view_id, visibility, created_by)
        VALUES (7, 'Hausakte', 1, 42, 'family', 1);
    `);
  }
  return db;
}

function seedPantry(db) {
  db.exec(`
    INSERT INTO pantry_products (id, name, name_key, unit, updated_at)
      VALUES (1, 'Milk', 'milk', 'l', '2026-01-02T08:00:00Z'),
             (2, 'Tea', 'tea', 'pkg', '2026-01-02T08:00:00Z');
    INSERT INTO pantry_items (name, unit, quantity, min_quantity, product_id)
      VALUES ('Milk', 'l', 1, 3, 1), ('Milk', 'l', 2, 5, 1);
  `);
}

const columnExists = (db) => db.prepare('PRAGMA table_info(pantry_products)').all()
  .some((column) => column.name === 'min_quantity');
const folder = (db) => db.prepare('SELECT * FROM paperless_view_folders WHERE id = 7').get();
const ledger = (db) => db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();

function compatibilityFork(t) {
  const db = databaseAt(t, 277);
  db.exec(OLD_FOLDERS);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (278, ?)').run(OLD_DESCRIPTION);
  db.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role)
      VALUES (1, 'owner', 'Owner', 'test', 'admin');
    INSERT INTO dms_accounts (id, provider, name, base_url, api_token)
      VALUES (1, 'paperless', 'Archive', 'https://paperless.example', 'secret');
    INSERT INTO paperless_view_folders (id, name, account_id, view_id, visibility, created_by)
      VALUES (7, 'Hausakte', 1, 42, 'family', 1);
  `);
  return db;
}

test('published 2.85 fork preserves bindings and repairs the upstream display migration', (t) => {
  const db = compatibilityFork(t);
  const before = folder(db);
  migrate(db);
  assert.deepEqual(folder(db), before);
  assert.ok(db.prepare('PRAGMA table_info(display_accounts)').all().some((c) => c.name === 'device_settings'));
  assert.equal(db.prepare('SELECT description FROM schema_migrations WHERE version = 278').get().description,
    MIGRATIONS.find((m) => m.version === 278).description);
  const after = ledger(db);
  migrate(db);
  assert.deepEqual(ledger(db), after);
});

test('a repaired 2.85 fork preserves administrator display settings', (t) => {
  const db = compatibilityFork(t);
  db.exec(MIGRATIONS.find((m) => m.version === 278).up);
  const settings = JSON.stringify({ nightEnabled: true, nightStart: '22:00' });
  db.prepare('INSERT INTO display_accounts (user_id, created_by, device_settings) VALUES (1, 1, ?)').run(settings);
  migrate(db);
  assert.equal(db.prepare('SELECT device_settings FROM display_accounts WHERE user_id = 1').get().device_settings, settings);
  assert.ok(db.prepare('PRAGMA table_info(display_accounts)').all().some((c) => c.name === 'device_settings'));
  assert.equal(folder(db).visibility, 'family');
});

test('a failed 2.85 marker repair rolls back the display column and retries safely', (t) => {
  const db = compatibilityFork(t);
  const before = folder(db);
  db.exec(`CREATE TRIGGER refuse_display_marker BEFORE UPDATE ON schema_migrations
    WHEN OLD.version = 278 BEGIN SELECT RAISE(ABORT, 'test display repair failure'); END`);
  assert.throws(() => migrate(db), /test display repair failure/);
  assert.equal(db.prepare('PRAGMA table_info(display_accounts)').all().some((c) => c.name === 'device_settings'), false);
  assert.equal(db.prepare('SELECT description FROM schema_migrations WHERE version = 278').get().description, OLD_DESCRIPTION);
  assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version = 282').get(), undefined);
  assert.deepEqual(folder(db), before);
  db.exec('DROP TRIGGER refuse_display_marker');
  migrate(db);
  assert.deepEqual(folder(db), before);
});

function assertPantry(db) {
  const rows = db.prepare('SELECT id, min_quantity, updated_at FROM pantry_products ORDER BY id').all();
  assert.deepEqual(rows.map((row) => row.min_quantity), [5, null]);
  assert.ok(rows.every((row) => row.updated_at === '2026-01-02T08:00:00Z'));
  assert.equal(db.prepare('SELECT description FROM schema_migrations WHERE version = 276').get().description,
    MIGRATIONS.find((m) => m.version === 276).description);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 282);
  assert.ok(db.prepare('PRAGMA table_info(tasks)').all().some((column) => column.name === 'rotation_mode'));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}

test('upstream 2.84 upgrades both pantry and the new folder table', (t) => {
  const db = databaseAt(t, 275);
  seedPantry(db);
  migrate(db);
  assertPantry(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paperless_view_folders').get().n, 0);
});

test('upstream 2.85 adds folders without overwriting the current product minimum', (t) => {
  const db = databaseAt(t, 277);
  seedPantry(db);
  db.exec('UPDATE pantry_products SET min_quantity = 11 WHERE id = 1');
  const before = ledger(db);
  migrate(db);
  assert.equal(db.prepare('SELECT min_quantity FROM pantry_products WHERE id = 1').get().min_quantity, 11);
  assert.deepEqual(ledger(db).filter((row) => row.version <= 277), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paperless_view_folders').get().n, 0);
});

test('published fork v276 keeps the folder and repairs the skipped upstream backfill once', (t) => {
  const db = databaseAt(t, 275, true);
  seedPantry(db);
  const before = folder(db);
  assert.equal(columnExists(db), false);
  migrate(db);
  assertPantry(db);
  assert.deepEqual(folder(db), before);
  const migratedLedger = ledger(db);
  db.exec('UPDATE pantry_products SET min_quantity = 12 WHERE id = 1');
  migrate(db);
  assert.equal(db.prepare('SELECT min_quantity FROM pantry_products WHERE id = 1').get().min_quantity, 12);
  assert.deepEqual(ledger(db), migratedLedger);
  assert.deepEqual(folder(db), before);
});

test('legacy fork with an already repaired pantry keeps the chosen minimum', (t) => {
  const db = databaseAt(t, 275, true);
  seedPantry(db);
  db.exec(MIGRATIONS.find((m) => m.version === 276).up);
  db.exec('UPDATE pantry_products SET min_quantity = 13 WHERE id = 1');
  const before = folder(db);
  migrate(db);
  assert.equal(db.prepare('SELECT min_quantity FROM pantry_products WHERE id = 1').get().min_quantity, 13);
  assert.deepEqual(folder(db), before);
  assert.notEqual(db.prepare('SELECT description FROM schema_migrations WHERE version = 276').get().description,
    OLD_DESCRIPTION);
});

test('a failed legacy backfill rolls back its column and ledger and can be retried', (t) => {
  const db = databaseAt(t, 275, true);
  seedPantry(db);
  const before = folder(db);
  db.exec(`CREATE TRIGGER refuse_test_backfill BEFORE UPDATE ON pantry_products
    BEGIN SELECT RAISE(ABORT, 'test backfill failure'); END`);
  assert.throws(() => migrate(db), /test backfill failure/);
  assert.equal(columnExists(db), false);
  assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version = 282').get(), undefined);
  assert.equal(db.prepare('SELECT description FROM schema_migrations WHERE version = 276').get().description,
    OLD_DESCRIPTION);
  assert.deepEqual(folder(db), before);
  db.exec('DROP TRIGGER refuse_test_backfill');
  migrate(db);
  assertPantry(db);
  assert.deepEqual(folder(db), before);
});
