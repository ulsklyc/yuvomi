import assert from 'node:assert/strict';
import test, { beforeEach, after } from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { buildMigratedDatabase } from './helpers/migrated-database.js';
import { PaperlessAdapter } from '../server/services/dms/paperless.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS, _setTestDatabase, _resetTestDatabase } = await import('../server/db.js');
const { default: router, _setAdapterFactory } = await import('../server/routes/paperless-tags.js');
const database = buildMigratedDatabase(Database, MIGRATIONS);
_setTestDatabase(database);
const user = (name, role) => database.prepare("INSERT INTO users (username,display_name,password_hash,role) VALUES (?,?,'x',?)").run(name,name,role).lastInsertRowid;
const owner = user('tag-owner', 'admin');
const member = user('tag-reader', 'member');
const other = user('tag-admin', 'admin');
let identity, accountId, folderId, linkId, adapter, assigned, writes, inView;
const realFetch = globalThis.fetch;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = identity.id; req.authRole = identity.role;
  req.session = { userId: identity.id, role: identity.role };
  req.sessionModuleAccess = identity.access;
  next();
});
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
async function call(method, path, body) {
  const res = await realFetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const folderPath = () => `/folders/${folderId}/documents/99/tags`;
const linkPath = () => `/documents/${linkId}/tags`;
beforeEach(() => {
  globalThis.fetch = realFetch;
  identity = { id: owner, role: 'admin' };
  database.prepare('DELETE FROM family_documents').run();
  database.prepare('DELETE FROM paperless_view_folders').run();
  database.prepare('DELETE FROM dms_accounts').run();
  accountId = database.prepare("INSERT INTO dms_accounts (provider,name,base_url,api_token) VALUES ('paperless','Test','https://paperless.example','SECRET')").run().lastInsertRowid;
  folderId = database.prepare("INSERT INTO paperless_view_folders (name,account_id,view_id,visibility,created_by) VALUES ('House',?,5,'family',?)").run(accountId,owner).lastInsertRowid;
  linkId = database.prepare(`INSERT INTO family_documents (name,category,visibility,original_name,mime_type,file_size,content_data,
    storage_provider,storage_backend,storage_key,dms_account_id,created_by)
    VALUES ('Receipt','other','family','receipt.pdf','application/pdf',0,'','external','dms','99',?,?)`).run(accountId,owner).lastInsertRowid;
  assigned = [7, 150]; writes = []; inView = true;
  adapter = {
    async getDocument() { return { tags: [...assigned] }; },
    async getTag(id) { return { id, name: id === 7 ? 'House' : 'Off-page tag' }; },
    async listTags({ page }) { return { results: [{ id: page === 1 ? 7 : 150, name: 'Tag' }], count: 101, has_more: page === 1 }; },
    async listViewDocuments() { return { results: inView ? [{ id: '99' }] : [] }; },
    async setDocumentTags(id, tags) { writes.push({ id, tags }); assigned = tags; return { tags }; },
  };
  _setAdapterFactory(() => adapter);
});
after(async () => {
  globalThis.fetch = realFetch; _setAdapterFactory(null);
  await new Promise((resolve) => server.close(resolve)); _resetTestDatabase(); database.close();
});

test('visible links and view members show live tag names; off-page assignments are retained', async () => {
  for (const path of [folderPath(), linkPath()]) {
    const result = await call('GET', path);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.tag_ids, [7, 150]);
    assert.equal(result.body.data.tags[1].name, 'Off-page tag');
    assert.equal(result.body.data.can_edit, true);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(result.body).includes('SECRET'));
  }
  assigned = [];
  assert.deepEqual((await call('GET', linkPath())).body.data.tags, []);
});
test('readers see assigned tags only, cannot browse catalogue or write, including stale admin session', async () => {
  identity = { id: member, role: 'member' };
  for (const path of [folderPath(), linkPath()]) {
    const result = await call('GET', path);
    assert.equal(result.status, 200); assert.equal(result.body.data.can_edit, false);
    assert.equal(result.body.data.account_id, undefined);
    assert.equal((await call('PUT', path, { tags: [], expected_tags: assigned })).status, 403);
  }
  assert.equal((await call('GET', `/tags?account_id=${accountId}`)).status, 403);
  assert.equal(writes.length, 0);
});
test('other admins cannot mutate a delegated folder; read-only module access also prevents writes', async () => {
  identity = { id: other, role: 'admin' };
  assert.equal((await call('PUT', folderPath(), { tags: [], expected_tags: assigned })).status, 403);
  identity = { id: owner, role: 'admin', access: { documents: 'read' } };
  assert.equal((await call('GET', linkPath())).body.data.can_edit, false);
  assert.equal((await call('PUT', linkPath(), { tags: [], expected_tags: assigned })).status, 403);
});
test('private links/folders and documents no longer in the view remain inaccessible', async () => {
  database.prepare("UPDATE family_documents SET visibility='private'").run();
  database.prepare("UPDATE paperless_view_folders SET visibility='private'").run();
  identity = { id: member, role: 'member' };
  assert.equal((await call('GET', linkPath())).status, 404);
  assert.equal((await call('GET', folderPath())).status, 404);
  identity = { id: owner, role: 'admin' }; inView = false;
  assert.equal((await call('GET', folderPath())).status, 404);
  assert.equal((await call('PUT', folderPath(), { tags: [], expected_tags: assigned })).status, 404);
  assert.equal(writes.length, 0);
});
test('catalogue pagination, add/remove and explicit empty selection', async () => {
  assert.equal((await call('GET', `/tags?account_id=${accountId}&page=2`)).body.data[0].id, 150);
  let result = await call('PUT', folderPath(), { tags: [8, 150, 8], expected_tags: [150, 7] });
  assert.equal(result.status, 200); assert.deepEqual(assigned, [8, 150]);
  result = await call('PUT', linkPath(), { tags: [], expected_tags: [8, 150] });
  assert.equal(result.status, 200); assert.deepEqual(assigned, []);
});
test('stale selections and malformed bodies cannot overwrite tags', async () => {
  assert.equal((await call('PUT', linkPath(), { tags: [], expected_tags: [7] })).status, 409);
  for (const tags of [undefined, null, ['7'], [-1], [1.2], Array(1001).fill(7)]) {
    assert.equal((await call('PUT', linkPath(), { tags, expected_tags: assigned })).status, 400);
  }
  assert.equal((await call('PUT', linkPath(), { tags: [] })).status, 400);
  assert.equal(writes.length, 0);
});
test('revocation or account change during reads prevents writes and disclosure', async () => {
  adapter.getDocument = async () => {
    database.prepare("UPDATE paperless_view_folders SET visibility='private'").run();
    return { tags: assigned };
  };
  assert.equal((await call('PUT', folderPath(), { tags: [], expected_tags: assigned })).status, 409);
  assert.equal(writes.length, 0);
  adapter.getDocument = async () => {
    database.prepare("UPDATE dms_accounts SET api_token='changed'").run();
    return { tags: assigned };
  };
  assert.equal((await call('GET', linkPath())).status, 409);
});
test('upstream permission and availability failures are sanitized; hidden tag IDs are preserved', async () => {
  adapter.getTag = async () => { throw Object.assign(new Error('SECRET'), { status: 403 }); };
  assert.equal((await call('GET', linkPath())).body.data.tags[0].name, '#7');
  adapter.setDocumentTags = async () => { throw Object.assign(new Error('SECRET'), { status: 403 }); };
  const denied = await call('PUT', linkPath(), { tags: [], expected_tags: assigned });
  assert.equal(denied.status, 403); assert.ok(!JSON.stringify(denied.body).includes('SECRET'));
  adapter.getDocument = async () => { throw new Error('SECRET'); };
  assert.equal((await call('GET', linkPath())).status, 502);
});
test('adapter uses guarded paginated tag paths and PATCH changes tags alone', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const body = url.includes('/api/tags/?') ? { results: [{ id: 7, name: 'House', owner: 99 }], count: 101, next: 'https://evil.example' }
      : url.includes('/api/tags/7/') ? { id: 7, name: 'House', owner: 99 } : { tags: [7] };
    return new Response(JSON.stringify(body));
  };
  const adapter = new PaperlessAdapter({ base_url: 'http://127.0.0.1:1234/paperless', api_token: 'test' });
  assert.equal((await adapter.listTags({ page: 2 })).has_more, true);
  assert.deepEqual(await adapter.getTag(7), { id: 7, name: 'House' });
  await adapter.setDocumentTags(99, [7]);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes('page=2'));
  assert.equal(calls[2].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[2].options.body), { tags: [7] });
  for (const call of calls) assert.ok(call.url.startsWith('http://127.0.0.1:1234/paperless/api/'));
});
