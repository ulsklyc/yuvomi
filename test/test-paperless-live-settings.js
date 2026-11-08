/** Real SQLite and loopback HTTP: central policy, personal credentials and revocation. */
import assert from 'node:assert/strict';
import test, { beforeEach, after } from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { buildMigratedDatabase } from './helpers/migrated-database.js';
import { sessionModuleAccessRequirement } from '../server/scopes.js';
import { moduleAccessVerdict } from '../server/permissions.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS, _setTestDatabase, _resetTestDatabase } = await import('../server/db.js');
const folders = await import('../server/routes/paperless-folders.js');
const tags = await import('../server/routes/paperless-tags.js');
const settings = await import('../server/routes/paperless-live-settings.js');
const database = buildMigratedDatabase(Database, MIGRATIONS);
_setTestDatabase(database);
const user = (name, role) => database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'test', ?)")
  .run(name, name, role).lastInsertRowid;
const owner = user('live-admin', 'admin'), reader = user('live-reader', 'member'), other = user('live-other', 'member');
const root = '/documents/dms/paperless';
let identity, accountId, folderId, assigned, adapter, credentials, writes;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.authUserId = identity.id; req.authRole = identity.role; req.authMethod = identity.method || 'session';
  req.session = { userId: identity.id, role: identity.role }; req.sessionModuleAccess = identity.access;
  const requirement = sessionModuleAccessRequirement(req.path, req.method);
  if (moduleAccessVerdict(identity.access, requirement.moduleKey, requirement.access) !== 'allow') return res.sendStatus(403);
  next();
});
app.use(root, folders.default);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const call = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${root}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') && content ? JSON.parse(content) : content,
    headers: res.headers };
};
const policy = (mode = 'shared', allowed = null, revision = 0) => call('PUT', `/live-settings/${accountId}`, {
  token_mode: mode, allowed_tag_ids: allowed, expected_revision: revision,
});
const token = (value) => call('PUT', `/live-settings/${accountId}/token`, { api_token: value });
const media = () => `/folders/${folderId}/documents/99/download`;
const tagPath = () => `/folders/${folderId}/documents/99/tags`;
beforeEach(() => {
  identity = { id: owner, role: 'admin' };
  database.prepare('DELETE FROM paperless_view_folders').run();
  database.prepare('DELETE FROM dms_accounts').run();
  accountId = database.prepare("INSERT INTO dms_accounts (provider, name, base_url, api_token) VALUES ('paperless','Live','http://127.0.0.1','CENTRAL_SECRET')").run().lastInsertRowid;
  folderId = database.prepare("INSERT INTO paperless_view_folders (name,account_id,view_id,visibility,created_by) VALUES ('Shared',?,5,'family',?)").run(accountId, owner).lastInsertRowid;
  assigned = [7, 150]; writes = []; credentials = [];
  adapter = {
    async listViewDocuments() { return { results: [{ id: '99', title: 'Receipt', filename: 'receipt.txt' }], count: 1, has_more: false }; },
    async fetchContent() { return { buffer: Buffer.from('Receipt'), mime: 'text/plain' }; },
    async fetchThumbnail() { return { buffer: Buffer.from('image'), mime: 'image/png' }; },
    async getSavedView() { return { id: 5, filter_rules: [] }; },
    async listSavedViews() { return { results: [{ id: 5, name: 'Saved' }], count: 1, has_more: false }; },
    async getDocument() { return { tags: assigned }; },
    async getTags(ids) { return ids.map((id) => ({ id, name: `Tag ${id}` })); },
    async listTags() { return { results: [7, 8, 150].map((id) => ({ id, name: `Tag ${id}` })), count: 3, has_more: false }; },
    async setDocumentTags(id, values) { writes.push(values); assigned = values; return { tags: values }; },
  };
  const factory = (source) => { credentials.push(source.api_token); return adapter; };
  folders._setAdapterFactory(factory); tags._setAdapterFactory(factory); settings._setAdapterFactory(factory);
});
after(async () => {
  folders._setAdapterFactory(null); tags._setAdapterFactory(null); settings._setAdapterFactory(null);
  await new Promise((resolve) => server.close(resolve)); _resetTestDatabase(); database.close();
});

test('new connections default to the shared token and unrestricted tags without exposing secrets', async () => {
  const result = await call('GET', '/live-settings');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data[0], { id: accountId, name: 'Live', token_mode: 'shared',
    has_personal_token: false, allowed_tag_ids: null, revision: 0 });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(result.body).includes('SECRET'));
  identity = { id: reader, role: 'member' };
  assert.equal((await call('GET', media())).status, 200);
  assert.deepEqual(credentials, ['CENTRAL_SECRET']);
  assert.equal((await call('GET', '/live-settings')).body.meta.can_manage, false);
});

test('only Documents-writing administrators can change central policy or browse its catalogue', async () => {
  identity = { id: reader, role: 'member' };
  assert.equal((await policy()).status, 403);
  assert.equal((await call('GET', `/live-settings/${accountId}/tags`)).status, 403);
  identity = { id: owner, role: 'admin', access: { documents: 'read' } };
  assert.equal((await policy()).status, 403);
});

test('central settings validate input, reject stale saves and persist across reads', async () => {
  assert.equal((await policy('wrong')).status, 400);
  assert.equal((await policy('shared', ['7'])).status, 400);
  assert.equal((await policy('personal', [8, 7, 8])).status, 200);
  assert.equal((await policy()).status, 409);
  const value = (await call('GET', '/live-settings')).body.data[0];
  assert.deepEqual(value.allowed_tag_ids, [7, 8]);
  assert.equal(value.token_mode, 'personal'); assert.equal(value.revision, 1);
  assert.equal((await policy('shared', [], 1)).status, 200);
  assert.deepEqual((await call('GET', '/live-settings')).body.data[0].allowed_tag_ids, []);
});

test('personal mode never falls back to the central token, including for administrators', async () => {
  await policy('personal');
  for (const person of [{ id: owner, role: 'admin' }, { id: reader, role: 'member' }]) {
    identity = person;
    for (const path of [`/folders/${folderId}/documents`, media(), tagPath()]) {
      const result = await call('GET', path);
      assert.equal(result.status, 403);
      assert.equal(result.body.reason, 'paperless_personal_token_required');
    }
  }
  assert.equal(credentials.length, 0);
});

test('users manage only their own token, and Documents readers can save personal credentials', async () => {
  await policy('personal');
  identity = { id: reader, role: 'member', access: { documents: 'read' } };
  assert.equal((await token('READER_SECRET')).status, 200);
  assert.equal((await call('GET', media())).status, 200);
  assert.equal(credentials.at(-1), 'READER_SECRET');
  const read = await call('GET', '/live-settings');
  assert.equal(read.body.data[0].has_personal_token, true);
  assert.ok(!JSON.stringify(read.body).includes('SECRET'));
  identity = { id: other, role: 'member' };
  assert.equal((await call('GET', '/live-settings')).body.data[0].has_personal_token, false);
  await call('PUT', `/live-settings/${accountId}/token`, { api_token: 'OTHER_SECRET', user_id: reader });
  assert.equal((await call('GET', media())).status, 200);
  assert.equal(credentials.at(-1), 'OTHER_SECRET');
  assert.equal(database.prepare('SELECT api_token FROM paperless_user_tokens WHERE user_id = ?').get(reader).api_token, 'READER_SECRET');
  await call('DELETE', `/live-settings/${accountId}/token`);
  assert.equal((await call('GET', media())).status, 403);
  identity = { id: reader, role: 'member', access: { documents: 'none' } };
  assert.equal((await token('BLOCKED')).status, 403);
});

test('invalid personal tokens and display principals cannot write credentials', async () => {
  for (const value of ['', ' ', 'bad\r\nheader', 'x'.repeat(501), null]) assert.equal((await token(value)).status, 400);
  identity.method = 'display';
  assert.equal((await token('DISPLAY_SECRET')).status, 403);
});

test('all Live-folder DMS operations use the current personal token', async () => {
  await policy('personal'); await token('ADMIN_SECRET');
  for (const path of [`/saved-views?account_id=${accountId}`, `/folders/${folderId}/documents`, media(), tagPath(),
    `/tags?account_id=${accountId}&folder_id=${folderId}`]) assert.equal((await call('GET', path)).status, 200);
  const created = await call('POST', '/folders', { name: 'New', account_id: accountId, view_id: 5 });
  assert.equal(created.status, 201);
  assert.equal((await call('PUT', tagPath(), { tags: [8, 150], expected_tags: [7, 150] })).status, 200);
  assert.ok(credentials.length >= 7);
  assert.ok(credentials.every((value) => value === 'ADMIN_SECRET'));
});

test('the central catalogue uses the administrative connection even when personal mode is selected', async () => {
  await policy('personal');
  const result = await call('GET', `/live-settings/${accountId}/tags?page=2`);
  assert.equal(result.status, 200); assert.equal(result.body.data.length, 3);
  assert.equal(credentials.at(-1), 'CENTRAL_SECRET');
});

test('Live-folder catalogue is restricted and hidden assignments cannot be added or removed', async () => {
  await policy('shared', [7, 8]);
  const catalogue = await call('GET', `/tags?account_id=${accountId}&folder_id=${folderId}`);
  assert.deepEqual(catalogue.body.data.map((tag) => tag.id), [7, 8]);
  const read = await call('GET', tagPath());
  assert.deepEqual(read.body.data.editable_tag_ids, [7, 8]);
  assert.equal(read.body.data.catalogue_folder_id, folderId);
  assert.deepEqual(read.body.data.tag_ids, [7, 150]);
  assert.equal((await call('PUT', tagPath(), { tags: [8], expected_tags: [7, 150] })).status, 400);
  assert.equal((await call('PUT', tagPath(), { tags: [8, 150, 99], expected_tags: [7, 150] })).status, 400);
  assert.equal(writes.length, 0);
  assert.equal((await call('PUT', tagPath(), { tags: [8, 150], expected_tags: [7, 150] })).status, 200);
  assert.deepEqual(assigned, [8, 150]);
});

test('revoking a personal token during a download prevents content disclosure', async () => {
  await policy('personal');
  identity = { id: reader, role: 'member' }; await token('READER_SECRET');
  adapter.fetchContent = async () => {
    database.prepare('DELETE FROM paperless_user_tokens WHERE account_id = ? AND user_id = ?').run(accountId, reader);
    return { buffer: Buffer.from('PRIVATE_BYTES'), mime: 'text/plain' };
  };
  const result = await call('GET', media());
  assert.equal(result.status, 403); assert.ok(!JSON.stringify(result.body).includes('PRIVATE_BYTES'));
});

test('policy or personal-token changes during tag reads and writes invalidate the operation', async () => {
  await policy('personal'); await token('ADMIN_SECRET');
  adapter.getDocument = async () => {
    database.prepare("UPDATE paperless_user_tokens SET api_token = 'REPLACED'").run();
    return { tags: assigned };
  };
  assert.equal((await call('PUT', tagPath(), { tags: [8, 150], expected_tags: [7, 150] })).status, 409);
  assert.equal(writes.length, 0);
  adapter.getDocument = async () => ({ tags: assigned });
  adapter.getTags = async () => {
    database.prepare('UPDATE paperless_live_settings SET revision = revision + 1').run();
    return [];
  };
  assert.equal((await call('GET', tagPath())).status, 409);
});

test('deleting a DMS account cascades its policy and personal tokens', async () => {
  await policy('personal'); await token('ADMIN_SECRET');
  database.prepare('DELETE FROM dms_accounts WHERE id = ?').run(accountId);
  for (const table of ['paperless_live_settings', 'paperless_user_tokens']) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('DMS rejection of a personal token never retries with the central token', async () => {
  await policy('personal');
  identity = { id: reader, role: 'member' }; await token('DENIED_PERSONAL');
  adapter.listViewDocuments = async () => { throw Object.assign(new Error('UPSTREAM_PRIVATE_BODY'), { status: 403 }); };
  const result = await call('GET', media());
  assert.equal(result.status, 403);
  assert.equal(result.body.reason, 'paperless_dms_forbidden');
  assert.deepEqual(credentials, ['DENIED_PERSONAL']);
  assert.ok(!JSON.stringify(result.body).includes('UPSTREAM_PRIVATE_BODY'));
});

test('changing token mode during document listing prevents disclosure', async () => {
  adapter.listViewDocuments = async () => {
    database.prepare("INSERT INTO paperless_live_settings (account_id,token_mode) VALUES (?,'personal')").run(accountId);
    return { results: [{ id: '99', title: 'PRIVATE_TITLE' }], count: 1, has_more: false };
  };
  identity = { id: reader, role: 'member' };
  const result = await call('GET', `/folders/${folderId}/documents`);
  assert.equal(result.status, 403);
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE_TITLE'));
});

test('an empty allowlist preserves all existing tag assignments', async () => {
  await policy('shared', []);
  assert.equal((await call('PUT', tagPath(), { tags: [], expected_tags: [7, 150] })).status, 400);
  assert.equal((await call('PUT', tagPath(), { tags: [7, 150, 8], expected_tags: [7, 150] })).status, 400);
  assert.deepEqual(assigned, [7, 150]);
});
