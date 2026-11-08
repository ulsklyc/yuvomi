/** Stock schema upgrades append folders without touching shipped migrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { buildMigratedDatabase } from './helpers/migrated-database.js';
process.env.DB_PATH = ':memory:';
const { MIGRATIONS, migrate } = await import('../server/db.js');

test('stock v282 gains folder/member tables while existing migration history and rewards remain unchanged', (t) => {
  const db = buildMigratedDatabase(Database, MIGRATIONS.filter((m) => m.version <= 282));
  t.after(() => db.close());
  const before = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version <= 282 ORDER BY version').all(), before);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 283);
  assert.ok(db.prepare('PRAGMA table_info(reward_ledger)').all().some((c) => c.name === 'decay_days'));
  assert.ok(db.prepare('PRAGMA table_info(reward_ledger)').all().some((c) => c.name === 'base_points'));
  db.exec(`INSERT INTO users (id,username,display_name,password_hash,role) VALUES (1,'owner','Owner','x','admin'),(2,'reader','Reader','x','member');
    INSERT INTO dms_accounts (id,provider,name,base_url,api_token) VALUES (1,'paperless','Archive','http://127.0.0.1','x');
    INSERT INTO paperless_view_folders (id,name,account_id,view_id,visibility,created_by) VALUES (1,'Selected',1,5,'restricted',1);
    INSERT INTO paperless_view_folder_access (folder_id,user_id) VALUES (1,2);`);
  const history = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), history);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paperless_view_folder_access').get().n, 1);
  db.prepare('DELETE FROM dms_accounts WHERE id = 1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paperless_view_folders').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paperless_view_folder_access').get().n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
