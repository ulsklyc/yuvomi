/** Apply the final Paperless schema to an existing upstream database. */
import assert from 'node:assert/strict';
import test from 'node:test';
import migration from '../server/migrations/0285.ts';
import { migrateTo, openSchemaDb } from './helpers/schema-db.js';

test('the Paperless migration appends the final schema and preserves existing data', (t) => {
  const db = openSchemaDb({ upTo: migration.version - 1 });
  t.after(() => db.close());
  db.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role)
      VALUES (1,'owner','Owner','x','admin'),(2,'reader','Reader','x','member');
    INSERT INTO dms_accounts (id, provider, name, base_url, api_token)
      VALUES (1,'paperless','Archive','http://127.0.0.1','central');
  `);
  const history = db.prepare('SELECT * FROM schema_migrations ORDER BY version');
  const before = history.all();
  migrateTo(db, migration.version);
  const after = history.all();
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, -1), before);
  assert.equal(after.at(-1)?.version, migration.version);
  assert.equal(db.prepare('SELECT name FROM dms_accounts WHERE id = 1').get()?.name, 'Archive');

  db.exec(`
    INSERT INTO paperless_view_folders (id, name, account_id, view_id, visibility, created_by)
      VALUES (1,'Selected',1,5,'restricted',1);
    INSERT INTO paperless_view_folders (name, account_id, tag_filter, created_by)
      VALUES ('Tags',1,'{"match":"all","tag_ids":[7]}',1);
    INSERT INTO paperless_view_folder_access (folder_id, user_id) VALUES (1,2);
    INSERT INTO paperless_live_settings (account_id, token_mode, allowed_tag_ids)
      VALUES (1,'personal','[7]');
    INSERT INTO paperless_user_tokens (account_id, user_id, api_token) VALUES (1,1,'personal');
  `);
  const insert = db.prepare('INSERT INTO paperless_view_folders (name, account_id, view_id, tag_filter, created_by) VALUES (?,1,?,?,1)');
  assert.throws(() => insert.run('No source', null, null), /CHECK constraint failed/);
  assert.throws(() => insert.run('Two sources', 5, '{"match":"all","tag_ids":[7]}'), /CHECK constraint failed/);
  assert.equal(db.prepare('SELECT display_fields FROM paperless_live_settings').get()?.display_fields, '[]');
  migrateTo(db, migration.version);
  assert.deepEqual(history.all(), after);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paperless_view_folders').get()?.count, 2);
  assert.equal(db.prepare('SELECT user_id FROM paperless_view_folder_access').get()?.user_id, 2);
  assert.equal(db.prepare('SELECT api_token FROM paperless_user_tokens').get()?.api_token, 'personal');

  db.exec('DELETE FROM dms_accounts WHERE id = 1');
  for (const table of ['paperless_view_folders', 'paperless_view_folder_access', 'paperless_live_settings', 'paperless_user_tokens']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
