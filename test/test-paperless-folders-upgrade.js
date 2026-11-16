/** Stock schema upgrades append folders without touching shipped migrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const Database = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers');
import { buildMigratedDatabase } from './helpers/migrated-database.js';
process.env.DB_PATH = ':memory:';
const { MIGRATIONS, migrate } = await import('../server/db.js');

test('v284 policies and credentials survive the overview field migration', (t) => {
  const db = buildMigratedDatabase(Database, MIGRATIONS.filter((m) => m.version <= 284));
  t.after(() => db.close());
  db.exec(`INSERT INTO users (id,username,display_name,password_hash,role) VALUES (1,'owner','Owner','x','admin');
    INSERT INTO dms_accounts (id,provider,name,base_url,api_token) VALUES (1,'paperless','Archive','http://127.0.0.1','central');
    INSERT INTO paperless_live_settings(account_id,token_mode,allowed_tag_ids,revision) VALUES (1,'personal','[7]',4);
    INSERT INTO paperless_user_tokens(account_id,user_id,api_token) VALUES (1,1,'personal');`);
  migrate(db);
  const row = db.prepare('SELECT * FROM paperless_live_settings').get();
  assert.equal(row.display_fields, '[]');
  assert.equal(row.token_mode, 'personal');
  assert.equal(row.allowed_tag_ids, '[7]');
  assert.equal(row.revision, 4);
  assert.equal(db.prepare('SELECT api_token FROM paperless_user_tokens').get().api_token, 'personal');
});

test('stock v282 gains folder/member tables while existing migration history and rewards remain unchanged', (t) => {
  const db = buildMigratedDatabase(Database, MIGRATIONS.filter((m) => m.version <= 282));
  t.after(() => db.close());
  const before = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version <= 282 ORDER BY version').all(), before);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, MIGRATIONS.at(-1)?.version);
  assert.ok(db.prepare('PRAGMA table_info(reward_ledger)').all().some((/** @type {{name: string}} */ c) => c.name === 'decay_days'));
  assert.ok(db.prepare('PRAGMA table_info(reward_ledger)').all().some((/** @type {{name: string}} */ c) => c.name === 'base_points'));
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

test('v285 folders, member grants, policies and tokens survive tag-source migration and cascades', (t) => {
  const db = buildMigratedDatabase(Database, MIGRATIONS.filter((m) => m.version <= 285));
  t.after(() => db.close());
  db.exec(`INSERT INTO users (id,username,display_name,password_hash,role) VALUES (1,'owner','Owner','x','admin'),(2,'reader','Reader','x','member');
    INSERT INTO dms_accounts (id,provider,name,base_url,api_token) VALUES (1,'paperless','Archive','http://127.0.0.1','central');
    INSERT INTO paperless_view_folders (id,name,account_id,view_id,visibility,created_by) VALUES (42,'Selected',1,5,'restricted',1);
    INSERT INTO paperless_view_folder_access (folder_id,user_id) VALUES (42,2);
    INSERT INTO paperless_live_settings(account_id,token_mode,allowed_tag_ids,revision,display_fields) VALUES (1,'personal','[7]',4,'["tags"]');
    INSERT INTO paperless_user_tokens(account_id,user_id,api_token) VALUES (1,1,'personal');`);
  db.exec(`INSERT INTO paperless_view_folders(id,name,account_id,view_id,created_by) VALUES (99,'Deleted',1,5,1);
    DELETE FROM paperless_view_folders WHERE id = 99;`);
  const before = db.prepare('SELECT * FROM paperless_view_folders').get();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM paperless_view_folders').get(), { ...before, tag_filter: null });
  assert.deepEqual(db.prepare('SELECT * FROM paperless_view_folder_access').all(), [{ folder_id: 42, user_id: 2 }]);
  assert.equal(db.prepare('SELECT display_fields FROM paperless_live_settings').get().display_fields, '["tags"]');
  assert.equal(db.prepare('SELECT api_token FROM paperless_user_tokens').get().api_token, 'personal');
  const folder = db.prepare(`INSERT INTO paperless_view_folders(name,account_id,tag_filter,created_by) VALUES ('Tags',1,'{"match":"all","tag_ids":[7]}',1)`).run();
  assert.ok(folder.lastInsertRowid > 99);
  assert.throws(() => db.prepare(`INSERT INTO paperless_view_folders(name,account_id,created_by) VALUES ('Unfiltered',1,1)`).run());
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.exec('DELETE FROM dms_accounts');
  for (const table of ['paperless_view_folders','paperless_view_folder_access','paperless_live_settings','paperless_user_tokens']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
});
