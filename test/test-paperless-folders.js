/** Paperless view filters, live pagination, sharing and media authorization. */
import assert from 'node:assert/strict';
import test, { beforeEach, after } from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { buildMigratedDatabase } from './helpers/migrated-database.js';
import { savedViewParams, PaperlessViewError } from '../server/services/dms/paperless-views.js';
import { PaperlessAdapter } from '../server/services/dms/paperless.js';

process.env.DB_PATH = ':memory:';
const { MIGRATIONS, _setTestDatabase, _resetTestDatabase } = await import('../server/db.js');
const { default: router, _setAdapterFactory } = await import('../server/routes/paperless-folders.js');
const database = buildMigratedDatabase(Database, MIGRATIONS);
_setTestDatabase(database);
const insertUser = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'test', ?)");
const adminId = insertUser.run('paperless-admin', 'Admin', 'admin').lastInsertRowid;
const memberId = insertUser.run('paperless-member', 'Member', 'member').lastInsertRowid;
const otherId = insertUser.run('paperless-other', 'Other', 'admin').lastInsertRowid;
let identity;
let adapter;
let accountId;
let mediaCalls;
const realFetch = globalThis.fetch;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = identity.id;
  req.authRole = identity.role;
  req.session = identity.cookieSession || { userId: identity.id, role: identity.role };
  next();
});
app.use('/api/v1/documents/dms/paperless', router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/documents/dms/paperless`;
const doc = (id) => ({ id: String(id), title: `Document ${id}`, filename: `${id}.pdf`, url: `https://paperless.example/documents/${id}` });
const member = () => { identity = { id: memberId, role: 'member' }; };
const admin = () => { identity = { id: adminId, role: 'admin' }; };
async function call(method, path, body) {
  const res = await realFetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text,
    headers: res.headers };
}
async function create(visibility = 'private', viewId = 5) {
  const response = await call('POST', '/folders', { name: 'House documents', account_id: accountId,
    view_id: viewId, visibility, confirm_share: visibility === 'family' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}
beforeEach(() => {
  globalThis.fetch = realFetch;
  admin();
  database.prepare('DELETE FROM family_documents').run();
  database.prepare('DELETE FROM paperless_view_folders').run();
  database.prepare('DELETE FROM dms_accounts').run();
  accountId = database.prepare("INSERT INTO dms_accounts (provider, name, base_url, api_token) VALUES ('paperless','DMS','https://paperless.example','never-return-this-token')").run().lastInsertRowid;
  mediaCalls = 0;
  adapter = {
    async getSavedView(id) { return { id, filter_rules: [] }; },
    async listSavedViews({ page }) { return { results: [{ id: page, name: `View ${page}`, filter_rules: ['secret'] }], count: 51, has_more: page === 1 }; },
    async listViewDocuments(_viewId, { page = 1, documentId = null }) {
      return { results: documentId ? (String(documentId) === '99' ? [doc(99)] : []) : [doc(page === 1 ? 1 : 99)], count: 51, has_more: page === 1 };
    },
    async fetchContent() { mediaCalls++; return { buffer: Buffer.from('%PDF-test'), mime: 'application/pdf' }; },
    async fetchThumbnail() { mediaCalls++; return { buffer: Buffer.from('webp'), mime: 'image/webp' }; },
  };
  _setAdapterFactory(() => adapter);
});
after(async () => {
  globalThis.fetch = realFetch;
  _setAdapterFactory(null);
  await new Promise((resolve) => server.close(resolve));
  _resetTestDatabase();
  database.close();
});

test('rules preserve AND/OR/exclusion tags, nullable fields, booleans, custom query and sorting', () => {
  const params = savedViewParams({ filter_rules: [
    { rule_type: 6, value: '7' }, { rule_type: 6, value: '12' },
    { rule_type: 22, value: '3' }, { rule_type: 22, value: '4' },
    { rule_type: 17, value: '9' }, { rule_type: 3, value: null },
    { rule_type: 25, value: '-1' }, { rule_type: 7, value: 'false' },
    { rule_type: 44, value: '2026-01-01' },
    { rule_type: 42, value: '["due","exists",true]' },
  ], sort_field: 'created', sort_reverse: true });
  assert.equal(params.get('tags__id__all'), '7,12');
  assert.equal(params.get('tags__id__in'), '3,4');
  assert.equal(params.get('tags__id__none'), '9');
  assert.equal(params.get('correspondent__isnull'), '1');
  assert.equal(params.get('storage_path__isnull'), '0');
  assert.equal(params.get('is_tagged'), '0');
  assert.equal(params.get('created__date__gte'), '2026-01-01');
  assert.equal(params.get('custom_field_query'), '["due","exists",true]');
  assert.equal(params.get('ordering'), '-created');
});

test('unknown, malformed and conflicting rules fail closed', () => {
  for (const filter_rules of [undefined, [{ rule_type: 999, value: 'x' }], [{ rule_type: 6, value: {} }],
    [{ rule_type: 7, value: 'maybe' }], [{ rule_type: 3, value: '1' }, { rule_type: 3, value: '2' }]]) {
    assert.throws(() => savedViewParams({ filter_rules }), PaperlessViewError);
  }
});

test('adapter loads fresh filters for page two, preserves sorting and never follows absolute next links', async () => {
  const calls = [];
  let tag = '7';
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    calls.push({ u, options });
    return new Response(JSON.stringify(u.pathname.includes('saved_views')
      ? { id: 5, filter_rules: [{ rule_type: 6, value: tag }], sort_field: 'title', sort_reverse: false }
      : { count: 51, next: 'https://attacker.invalid/steal', results: [{ id: 99, title: 'Later', original_file_name: 'later.pdf' }] }),
    { headers: { 'Content-Type': 'application/json' } });
  };
  const source = new PaperlessAdapter({ base_url: 'http://127.0.0.1:1234/paperless', api_token: 'token' });
  const first = await source.listViewDocuments(5, { page: 1 });
  tag = '12';
  const second = await source.listViewDocuments(5, { page: 2, documentId: 99 });
  assert.equal(first.has_more, true);
  assert.equal(second.results[0].id, '99');
  assert.equal(calls.length, 4);
  assert.equal(calls[3].u.searchParams.get('tags__id__all'), '12');
  assert.equal(calls[3].u.searchParams.get('page'), '2');
  assert.equal(calls[3].u.searchParams.get('id'), '99');
  assert.equal(calls[3].u.searchParams.get('ordering'), 'title');
  for (const call of calls) {
    assert.equal(call.u.origin, 'http://127.0.0.1:1234');
    assert.equal(call.options.headers.Authorization, 'Token token');
    assert.equal(call.options.headers.Accept, 'application/json; version=9');
  }
});

test('adapter rejects an unknown filter before querying documents', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ id: 5, filter_rules: [{ rule_type: 999, value: 'x' }] }));
  };
  const source = new PaperlessAdapter({ base_url: 'http://127.0.0.1:1234', api_token: 'token' });
  await assert.rejects(source.listViewDocuments(5), PaperlessViewError);
  assert.equal(urls.length, 1);
});

test('saved-view picker is admin-only and paginated; strips filters and tokens', async () => {
  const result = await call('GET', `/saved-views?account_id=${accountId}&page=2`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, [{ id: 2, name: 'View 2' }]);
  assert.equal(result.body.meta.count, 51);
  assert.equal(result.body.meta.has_more, false);
  assert.equal(JSON.stringify(result.body).includes('token'), false);
  member();
  assert.equal((await call('GET', `/saved-views?account_id=${accountId}`)).status, 403);
  identity.cookieSession = { userId: adminId, role: 'admin' };
  assert.equal((await call('GET', `/saved-views?account_id=${accountId}`)).status, 403);
});

test('private folders default to private and reveal neither name nor documents to other users', async () => {
  const folder = await create();
  assert.equal(folder.visibility, 'private');
  member();
  assert.deepEqual((await call('GET', '/folders')).body.data, []);
  assert.equal((await call('GET', `/folders/${folder.id}/documents`)).status, 404);
  identity = { id: otherId, role: 'admin' };
  assert.equal((await call('GET', `/folders/${folder.id}/documents`)).status, 404);
});

test('sharing requires explicit consent; members can read the current and subsequent page', async () => {
  const denied = await call('POST', '/folders', { name: 'Share', account_id: accountId, view_id: 5, visibility: 'family' });
  assert.equal(denied.status, 400);
  const folder = await create('family');
  member();
  assert.equal((await call('GET', '/folders')).body.data.length, 1);
  const second = await call('GET', `/folders/${folder.id}/documents?page=2`);
  assert.equal(second.status, 200);
  assert.equal(second.body.data[0].id, '99');
  assert.equal(second.headers.get('cache-control'), 'no-store');
  assert.equal(second.body.meta.has_more, false);
});

test('members cannot create, edit or disconnect a shared folder', async () => {
  const folder = await create('family');
  member();
  for (const [method, path, body] of [['POST', '/folders', {}], ['PUT', `/folders/${folder.id}`, {}], ['DELETE', `/folders/${folder.id}`]]) {
    assert.equal((await call(method, path, body)).status, 403);
  }
});

test('renaming and privacy updates preserve source IDs and require fresh sharing consent', async () => {
  const folder = await create();
  assert.equal((await call('PUT', `/folders/${folder.id}`, { name: 'New', visibility: 'family' })).status, 400);
  const result = await call('PUT', `/folders/${folder.id}`, { name: 'New', visibility: 'family', confirm_share: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.name, 'New');
  assert.equal(result.body.data.view_id, 5);
  assert.equal((await call('PUT', `/folders/${folder.id}`, { name: 'New', visibility: 'family', view_id: 6 })).status, 400);
});

test('downloads outside the current view are denied even with a real document ID', async () => {
  const folder = await create('family');
  member();
  assert.equal((await call('GET', `/folders/${folder.id}/documents/1/download`)).status, 404);
  assert.equal(mediaCalls, 0);
  const result = await call('GET', `/folders/${folder.id}/documents/99/download`);
  assert.equal(result.status, 200);
  assert.equal(mediaCalls, 1);
  assert.match(result.headers.get('content-disposition'), /^attachment/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
});

test('the same Paperless document may appear in multiple independent folders without local references', async () => {
  const first = await create('family', 5);
  const second = await create('family', 6);
  assert.notEqual(first.id, second.id);
  assert.equal(database.prepare("SELECT count(*) AS n FROM family_documents WHERE storage_backend = 'dms'").get().n, 0);
  assert.equal((await call('GET', `/folders/${second.id}/documents/99/preview`)).status, 200);
});

test('revoking sharing during document listing prevents the response from leaking', async () => {
  const folder = await create('family');
  adapter.listViewDocuments = async () => {
    database.prepare("UPDATE paperless_view_folders SET visibility = 'private' WHERE id = ?").run(folder.id);
    return { results: [doc(99)], count: 1, has_more: false };
  };
  member();
  const result = await call('GET', `/folders/${folder.id}/documents`);
  assert.equal(result.status, 404);
  assert.equal(JSON.stringify(result.body).includes('Document 99'), false);
});

test('revoking sharing during content fetch prevents the bytes from leaking', async () => {
  const folder = await create('family');
  adapter.fetchContent = async () => {
    database.prepare("UPDATE paperless_view_folders SET visibility = 'private' WHERE id = ?").run(folder.id);
    return { buffer: Buffer.from('DO NOT LEAK'), mime: 'application/pdf' };
  };
  member();
  const result = await call('GET', `/folders/${folder.id}/documents/99/download`);
  assert.equal(result.status, 404);
  assert.equal(JSON.stringify(result.body).includes('DO NOT LEAK'), false);
});

test('remote view changes are reflected without creating or moving local documents', async () => {
  const folder = await create('family');
  assert.equal((await call('GET', `/folders/${folder.id}/documents`)).body.data.length, 1);
  adapter.listViewDocuments = async () => ({ results: [], count: 0, has_more: false });
  assert.deepEqual((await call('GET', `/folders/${folder.id}/documents`)).body.data, []);
  assert.equal((await call('GET', `/folders/${folder.id}/documents/99/download`)).status, 404);
});

test('preview and thumbnails reject active MIME types but downloads remain available', async () => {
  const folder = await create();
  adapter.fetchContent = adapter.fetchThumbnail = async () => ({ buffer: Buffer.from('<svg/>'), mime: 'image/svg+xml' });
  for (const action of ['preview', 'thumbnail']) assert.equal((await call('GET', `/folders/${folder.id}/documents/99/${action}`)).status, 415);
  assert.equal((await call('GET', `/folders/${folder.id}/documents/99/download`)).status, 200);
});

test('disconnect removes only the binding, not Paperless content or existing Yuvomi links', async () => {
  const folder = await create();
  const local = database.prepare(`INSERT INTO family_documents
    (name, category, visibility, original_name, mime_type, file_size, content_data,
     storage_provider, storage_backend, storage_key, dms_account_id, created_by)
    VALUES ('Existing link', 'other', 'private', '99.pdf', 'application/pdf', 0, '', 'external', 'dms', '99', ?, ?)`)
    .run(accountId, adminId).lastInsertRowid;
  const remove = await call('DELETE', `/folders/${folder.id}`);
  assert.equal(remove.status, 204);
  assert.ok(database.prepare('SELECT id FROM family_documents WHERE id = ?').get(local));
  assert.equal(mediaCalls, 0);
  assert.equal((await call('GET', `/folders/${folder.id}/documents/99/download`)).status, 404);
});

test('account deletion cascades bindings, leaving the remote documents alone', async () => {
  const folder = await create();
  database.prepare('DELETE FROM dms_accounts WHERE id = ?').run(accountId);
  assert.equal((await call('GET', `/folders/${folder.id}/documents`)).status, 404);
  assert.equal(database.prepare('SELECT count(*) AS n FROM paperless_view_folders').get().n, 0);
});

test('malformed pages and IDs fail rather than falling back to an unfiltered request', async () => {
  const folder = await create();
  for (const page of ['0', '-1', '1.5', 'abc', '100001']) {
    assert.equal((await call('GET', `/folders/${folder.id}/documents?page=${page}`)).status, 400);
  }
  assert.equal((await call('GET', `/folders/${folder.id}/documents/1e2/download`)).status, 404);
});

test('Paperless failures are sanitized; unsupported rules return 422', async () => {
  const folder = await create();
  adapter.listViewDocuments = async () => { throw new Error('secret token never-return-this-token'); };
  const failure = await call('GET', `/folders/${folder.id}/documents`);
  assert.equal(failure.status, 502);
  assert.equal(JSON.stringify(failure.body).includes('never-return'), false);
  adapter.listViewDocuments = async () => { throw new PaperlessViewError('unknown'); };
  assert.equal((await call('GET', `/folders/${folder.id}/documents`)).status, 422);
});

test('a different administrator cannot change another creator\'s family delegation', async () => {
  const folder = await create('family');
  identity = { id: otherId, role: 'admin' };
  assert.equal((await call('GET', '/folders')).body.data[0].can_manage, false);
  assert.equal((await call('PUT', `/folders/${folder.id}`, { name: 'Mine', visibility: 'private' })).status, 403);
  assert.equal((await call('DELETE', `/folders/${folder.id}`)).status, 403);
});

test('new API paths inherit Documents token/scope requirements for reads and writes', async () => {
  const { tokenAccessRequirement, tokenAllows } = await import('../server/scopes.js');
  const read = tokenAccessRequirement('/documents/dms/paperless/folders/1/documents/99/download', 'GET');
  const write = tokenAccessRequirement('/documents/dms/paperless/folders', 'POST');
  assert.deepEqual(read, { moduleKey: 'documents', access: 'read' });
  assert.deepEqual(write, { moduleKey: 'documents', access: 'write' });
  assert.equal(tokenAllows(['documents:read'], read.moduleKey, read.access), true);
  assert.equal(tokenAllows(['documents:read'], write.moduleKey, write.access), false);
  assert.equal(tokenAllows(['tasks:read'], read.moduleKey, read.access), false);
});

test('remote reads are refused while restoring, preserving the old database identity', async () => {
  const folder = await create();
  const { setRestoreRunning } = await import('../server/utils/restore-state.js');
  setRestoreRunning(true);
  try {
    for (const path of [`/saved-views?account_id=${accountId}`, `/folders/${folder.id}/documents`, `/folders/${folder.id}/documents/99/download`]) {
      const response = await call('GET', path);
      assert.equal(response.status, 503);
      assert.equal(response.body.reason, 'restore_in_progress');
    }
    assert.equal(mediaCalls, 0);
  } finally { setRestoreRunning(false); }
});

test('a local write failure is 500, not a Paperless connection failure', async () => {
  adapter.getSavedView = async () => {
    database.pragma('query_only = ON');
    return { filter_rules: [] };
  };
  try {
    const response = await call('POST', '/folders', { name: 'Cannot write', account_id: accountId, view_id: 5 });
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Internal server error.');
    assert.equal(response.body.reason, undefined);
  } finally { database.pragma('query_only = OFF'); }
});
