/**
 * Modul: Dokument-Storage-Migrationstest
 * Zweck: storage_backend-Datenmigration und Provider-/Backend-Invarianten prüfen.
 * Ausführen: npm run test:document-storage
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'document-storage-test-secret';
const {
  MIGRATIONS,
  get,
  _setTestDatabase,
} = await import('../server/db.js');
const storage = await import('../server/services/document-storage.js');
const {
  default: documentsRouter,
  _setDmsAdapterFactory,
} = await import('../server/routes/documents.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

test('route and service tests use an injected in-memory database', () => {
  assert.equal(get().name, ':memory:');
});

const STORAGE_ENV_KEYS = [
  'DOCUMENT_STORAGE_WEBDAV_ENABLED',
  'DOCUMENT_STORAGE_WEBDAV_URL',
  'DOCUMENT_STORAGE_WEBDAV_USERNAME',
  'DOCUMENT_STORAGE_WEBDAV_PASSWORD',
  'DOCUMENT_STORAGE_WEBDAV_PATH',
  'DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK',
];

function clearStorageConfig() {
  get().prepare("DELETE FROM sync_config WHERE key LIKE 'document_storage_webdav_%'").run();
  for (const key of STORAGE_ENV_KEYS) delete process.env[key];
}

test.after(() => {
  clearStorageConfig();
  suiteDatabase.close();
});

test.afterEach(() => {
  clearStorageConfig();
  storage.__setRequestTimeoutForTests?.();
  storage.__setPrivateNetworkAccessForTests?.();
  storage.__setHostnameLookupForTests?.();
  _setDmsAdapterFactory();
});

test.beforeEach(() => {
  storage.__setPrivateNetworkAccessForTests?.(true);
});

function createRouteHarness({ userId = 1, role = 'admin' } = {}) {
  let auth = { userId, role };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = auth.userId;
    req.authRole = auth.role;
    req.session = { userId: auth.userId, role: auth.role };
    next();
  });
  app.use('/api/v1/documents', documentsRouter);
  app.use('/api/v1/calendar', calendarRouter);
  const server = http.createServer(app);

  return {
    app,
    server,
    setAuth(nextAuth) {
      auth = { ...auth, ...nextAuth };
    },
    async listen() {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

async function routeCall(harness, method, pathname, body) {
  const baseUrl = await harness.listen();
  const response = await fetch(`${baseUrl}/api/v1/documents${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await response.text();
  return {
    response,
    body: responseBody ? JSON.parse(responseBody) : null,
  };
}

async function calendarRouteCall(harness, method, pathname, body) {
  const baseUrl = await harness.listen();
  const response = await fetch(`${baseUrl}/api/v1/calendar${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await response.text();
  return {
    response,
    body: responseBody ? JSON.parse(responseBody) : null,
  };
}

function createRouteUser() {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', 'admin')
  `).run(`storage-admin-${randomUUID()}`, 'Storage Admin').lastInsertRowid;
}

function uploadBody(overrides = {}) {
  const bytes = Buffer.from(overrides.bytes ?? 'document bytes');
  return {
    name: overrides.name ?? 'Storage document',
    original_name: overrides.original_name ?? 'document.txt',
    category: overrides.category ?? 'other',
    visibility: overrides.visibility ?? 'family',
    content_data: `data:text/plain;base64,${bytes.toString('base64')}`,
    ...(overrides.allowed_member_ids === undefined
      ? {}
      : { allowed_member_ids: overrides.allowed_member_ids }),
  };
}

function calendarEventBody(overrides = {}) {
  const attachmentBytes = overrides.attachmentBytes ?? 'calendar attachment';
  const attachmentData = Object.hasOwn(overrides, 'attachment_data')
    ? overrides.attachment_data
    : `data:text/plain;base64,${Buffer.from(attachmentBytes).toString('base64')}`;
  return {
    title: overrides.title ?? `Calendar event ${randomUUID()}`,
    start_datetime: overrides.start_datetime ?? '2026-06-10T10:00:00.000Z',
    attachment_name: overrides.attachment_name ?? 'agenda.txt',
    attachment_data: attachmentData,
    ...(overrides.extra ?? {}),
  };
}

function insertRouteDocument(userId, overrides = {}) {
  const values = {
    name: 'Stored document',
    originalName: 'stored.txt',
    mimeType: 'text/plain',
    fileSize: 6,
    contentData: Buffer.from('stored').toString('base64'),
    storageProvider: 'local',
    storageBackend: 'local',
    storageKey: null,
    dmsAccountId: null,
    ...overrides,
  };
  return get().prepare(`
    INSERT INTO family_documents (
      name, category, visibility, original_name, mime_type, file_size,
      content_data, storage_provider, storage_backend, storage_key,
      dms_account_id, created_by
    ) VALUES (
      @name, 'other', 'family', @originalName, @mimeType, @fileSize,
      @contentData, @storageProvider, @storageBackend, @storageKey,
      @dmsAccountId, @userId
    )
  `).run({ ...values, userId }).lastInsertRowid;
}

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') {
    migration.up(db);
  } else {
    db.exec(migration.up);
  }
  if (typeof migration.afterUp === 'function') {
    migration.afterUp(db);
  }
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function buildV50Database(t) {
  const db = buildMigratedDatabase(
    MIGRATIONS.filter(({ version }) => version <= 50)
  );
  t.after(() => db.close());
  return db;
}

function seedUpgradeDocuments(db) {
  const userId = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('admin', 'Admin', 'hash', 'admin')
  `).run().lastInsertRowid;
  const accountId = db.prepare(`
    INSERT INTO dms_accounts (name, base_url, api_token)
    VALUES ('Paperless', 'https://paperless.example.test', 'token')
  `).run().lastInsertRowid;
  const insert = db.prepare(`
    INSERT INTO family_documents (
      name, original_name, mime_type, file_size, content_data,
      storage_provider, storage_key, dms_account_id, created_by
    ) VALUES (?, ?, 'application/pdf', 1, '', ?, ?, ?, ?)
  `);

  const localId = insert.run(
    'Local', 'local.pdf', 'local', 'local-key', null, userId
  ).lastInsertRowid;
  const inconsistentLocalId = insert.run(
    'Inconsistent local', 'inconsistent.pdf', 'local', 'local-key-2', accountId, userId
  ).lastInsertRowid;
  const dmsId = insert.run(
    'DMS', 'dms.pdf', 'external', '42', accountId, userId
  ).lastInsertRowid;
  const orphanId = insert.run(
    'Orphan', 'orphan.pdf', 'external', '99', null, userId
  ).lastInsertRowid;

  return { userId, accountId, localId, inconsistentLocalId, dmsId, orphanId };
}

function insertDocument(db, userId, overrides = {}) {
  const {
    storageProvider = 'local',
    storageBackend = 'local',
    dmsAccountId = null,
  } = overrides;
  return db.prepare(`
    INSERT INTO family_documents (
      name, original_name, mime_type, file_size, content_data,
      storage_provider, storage_backend, dms_account_id, created_by
    ) VALUES ('Test', 'test.pdf', 'application/pdf', 1, '',
      @storageProvider, @storageBackend, @dmsAccountId, @userId)
  `).run({ storageProvider, storageBackend, dmsAccountId, userId });
}

function setConfig(values) {
  const statement = get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [key, value] of Object.entries(values)) {
    statement.run(`document_storage_webdav_${key}`, String(value));
  }
}

function clearWebdavDocuments() {
  get().prepare("DELETE FROM family_documents WHERE storage_backend = 'webdav'").run();
}

async function createWebdavServer(t, {
  username = 'alice',
  password = 'secret',
  handler,
} = {}) {
  const requests = [];
  const files = new Map();
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
    };
    requests.push(request);

    if (handler && await handler(req, res, request, files)) return;
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === 'MKCOL') {
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      files.set(req.url, body);
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      const value = files.get(req.url);
      if (!value) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': value.length,
      });
      res.end(value);
      return;
    }
    if (req.method === 'DELETE') {
      if (!files.has(req.url)) {
        res.writeHead(404);
        res.end();
        return;
      }
      files.delete(req.url);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (!server.listening) return;
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    files,
  };
}

function assertStorageError(error, storageCode) {
  assert.ok(error instanceof storage.StorageError);
  assert.equal(error.storageCode, storageCode);
  return true;
}

test('migration v51 adds storage_backend and migrates all existing documents', (t) => {
  const db = buildV50Database(t);
  const ids = seedUpgradeDocuments(db);
  const migration = MIGRATIONS.find(({ version }) => version === 51);

  assert.ok(migration, 'migration v51 must exist');
  applyMigration(db, migration);

  const columns = db.prepare('PRAGMA table_info(family_documents)').all();
  const storageBackend = columns.find(({ name }) => name === 'storage_backend');
  assert.ok(storageBackend);
  assert.equal(storageBackend.notnull, 1);
  assert.equal(storageBackend.dflt_value, "'local'");

  const rows = db.prepare(`
    SELECT id, storage_provider, storage_backend, dms_account_id
    FROM family_documents
    ORDER BY id
  `).all();
  assert.deepEqual(rows, [
    { id: ids.localId, storage_provider: 'local', storage_backend: 'local', dms_account_id: null },
    {
      id: ids.inconsistentLocalId,
      storage_provider: 'local',
      storage_backend: 'local',
      dms_account_id: null,
    },
    { id: ids.dmsId, storage_provider: 'external', storage_backend: 'dms', dms_account_id: ids.accountId },
    { id: ids.orphanId, storage_provider: 'external', storage_backend: 'dms', dms_account_id: null },
  ]);
});

test('migration v51 permits only the supported provider/backend pairs', (t) => {
  const db = buildV50Database(t);
  const { userId } = seedUpgradeDocuments(db);
  applyMigration(db, MIGRATIONS.find(({ version }) => version === 51));

  assert.doesNotThrow(() => insertDocument(db, userId));
  assert.doesNotThrow(() => insertDocument(db, userId, {
    storageProvider: 'external',
    storageBackend: 'webdav',
  }));
  assert.doesNotThrow(() => insertDocument(db, userId, {
    storageProvider: 'external',
    storageBackend: 'dms',
  }));

  for (const [storageProvider, storageBackend] of [
    ['local', 'webdav'],
    ['local', 'dms'],
    ['external', 'local'],
  ]) {
    assert.throws(
      () => insertDocument(db, userId, { storageProvider, storageBackend }),
      /invalid document storage provider\/backend combination/
    );
  }
  assert.throws(
    () => insertDocument(db, userId, { storageBackend: 'invalid' }),
    /invalid document storage provider\/backend combination|CHECK constraint failed/
  );
});

test('migration v51 rejects dms_account_id outside the dms backend on insert and update', (t) => {
  const db = buildV50Database(t);
  const { userId, accountId } = seedUpgradeDocuments(db);
  applyMigration(db, MIGRATIONS.find(({ version }) => version === 51));

  assert.throws(
    () => insertDocument(db, userId, { dmsAccountId: accountId }),
    /dms_account_id requires dms storage backend/
  );
  assert.throws(
    () => insertDocument(db, userId, {
      storageProvider: 'external',
      storageBackend: 'webdav',
      dmsAccountId: accountId,
    }),
    /dms_account_id requires dms storage backend/
  );

  const localId = insertDocument(db, userId).lastInsertRowid;
  assert.throws(
    () => db.prepare(`
      UPDATE family_documents
      SET storage_provider = 'external'
      WHERE id = ?
    `).run(localId),
    /invalid document storage provider\/backend combination/
  );
  assert.doesNotThrow(() => db.prepare(`
    UPDATE family_documents
    SET storage_provider = 'external', storage_backend = 'dms'
    WHERE id = ?
  `).run(localId));

  const dmsId = insertDocument(db, userId, {
    storageProvider: 'external',
    storageBackend: 'dms',
    dmsAccountId: accountId,
  }).lastInsertRowid;
  assert.throws(
    () => db.prepare(`
      UPDATE family_documents
      SET storage_backend = 'webdav'
      WHERE id = ?
    `).run(dmsId),
    /dms_account_id requires dms storage backend/
  );
});

test('getConfig applies dynamic nonempty per-field env overrides and reports control', () => {
  setConfig({
    enabled: '0',
    url: 'https://db.example.test/dav',
    username: 'db-user',
    password: 'db-pass',
    path: 'db/documents',
    last_test: '2026-06-10T10:00:00.000Z',
    last_error: 'old error',
  });

  process.env.DOCUMENT_STORAGE_WEBDAV_ENABLED = ' true ';
  process.env.DOCUMENT_STORAGE_WEBDAV_URL = ' https://env.example.test/dav ';
  process.env.DOCUMENT_STORAGE_WEBDAV_USERNAME = '   ';
  process.env.DOCUMENT_STORAGE_WEBDAV_PASSWORD = '';
  process.env.DOCUMENT_STORAGE_WEBDAV_PATH = 'env/documents';

  assert.deepEqual(storage.getConfig(), {
    enabled: true,
    url: 'https://env.example.test/dav',
    username: 'db-user',
    password: 'db-pass',
    basePath: 'env/documents',
    lastTest: '2026-06-10T10:00:00.000Z',
    lastError: 'old error',
    envControlled: {
      enabled: true,
      url: true,
      username: false,
      password: false,
      path: true,
    },
  });

  process.env.DOCUMENT_STORAGE_WEBDAV_ENABLED = '0';
  process.env.DOCUMENT_STORAGE_WEBDAV_URL = 'http://changed.example.test';
  const changed = storage.getConfig();
  assert.equal(changed.enabled, false);
  assert.equal(changed.url, 'http://changed.example.test');
});

test('getConfig defaults and normalizes safe paths while rejecting invalid config', async () => {
  setConfig({
    enabled: '1',
    url: 'ftp://files.example.test',
    username: 'user',
    password: 'pass',
  });
  assert.equal(storage.getConfig().basePath, 'yuvomi-documents');
  await assert.rejects(
    storage.stageDocumentUpload({
      buffer: Buffer.from('x'),
      mime: 'text/plain',
      category: 'notes',
      originalName: 'note.txt',
    }),
    (error) => assertStorageError(error, 'DOCUMENT_STORAGE_INVALID_CONFIG')
  );

  for (const unsafePath of [
    '../documents',
    'documents/./private',
    'documents/%2e%2e/private',
    'documents?token=x',
    'documents#fragment',
    'documents/\u0000private',
    'https://evil.example/path',
  ]) {
    assert.throws(
      () => storage.saveConfig({ path: unsafePath }),
      (error) => assertStorageError(error, 'DOCUMENT_STORAGE_INVALID_CONFIG'),
      unsafePath
    );
  }

  storage.saveConfig({ path: '/family//documents/' });
  assert.equal(storage.getConfig().basePath, 'family/documents');
});

test('config update rejects literal private WebDAV targets before persistence', async (t) => {
  storage.__setPrivateNetworkAccessForTests?.(false);
  setConfig({
    enabled: '0',
    url: 'https://files.example.test/dav',
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: 'http://127.0.0.1:8080/webdav',
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_INVALID_CONFIG');
  assert.equal(storage.getConfig().url, 'https://files.example.test/dav');
});

test('config update rejects WebDAV hostnames that resolve to private addresses', async (t) => {
  storage.__setPrivateNetworkAccessForTests?.(false);
  storage.__setHostnameLookupForTests?.(async () => [
    { address: '10.0.0.8', family: 4 },
  ]);
  setConfig({
    enabled: '0',
    url: 'https://files.example.test/dav',
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: 'https://webdav.example.test/dav',
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_INVALID_CONFIG');
  assert.equal(storage.getConfig().url, 'https://files.example.test/dav');
});

test('protected config changes reject DNS rebinding before the WebDAV request', async (t) => {
  storage.__setPrivateNetworkAccessForTests?.(false);
  let lookupCount = 0;
  storage.__setHostnameLookupForTests?.(async () => {
    lookupCount += 1;
    return lookupCount === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }];
  });
  const current = await createWebdavServer(t);
  const privateTarget = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: current.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'protected.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: `http://webdav.example.test:${new URL(privateTarget.url).port}`,
    confirm_existing_access: true,
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_CONFIG_PROTECTED');
  assert.equal(lookupCount, 2);
  assert.equal(privateTarget.requests.length, 0);
  assert.equal(storage.getConfig().url, current.url);
});

test('trusted environment WebDAV targets may use private network addresses', async (t) => {
  storage.__setPrivateNetworkAccessForTests?.(false);
  const webdav = await createWebdavServer(t);
  storage.__setHostnameLookupForTests?.(async () => [
    { address: '127.0.0.1', family: 4 },
  ]);
  process.env.DOCUMENT_STORAGE_WEBDAV_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_WEBDAV_URL =
    `http://nas.local:${new URL(webdav.url).port}`;
  process.env.DOCUMENT_STORAGE_WEBDAV_USERNAME = 'alice';
  process.env.DOCUMENT_STORAGE_WEBDAV_PASSWORD = 'secret';
  process.env.DOCUMENT_STORAGE_WEBDAV_PATH = 'documents';

  const result = await storage.testConnection();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    webdav.requests.map(({ method }) => method),
    ['MKCOL', 'PUT', 'GET', 'DELETE']
  );
});

test('DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK opt-in allows UI-configured private targets', async (t) => {
  storage.__setPrivateNetworkAccessForTests?.(false);
  const webdav = await createWebdavServer(t);
  // Resolve nas.local to 127.0.0.1 so the HTTP agent actually reaches the test server,
  // while the SSRF guard (which would normally block 127.x) must be bypassed by the flag.
  storage.__setHostnameLookupForTests?.(async () => [
    { address: '127.0.0.1', family: 4 },
  ]);
  process.env.DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK = 'true';
  setConfig({
    enabled: '1',
    url: `http://nas.local:${new URL(webdav.url).port}`,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });

  const result = await storage.testConnection();

  assert.deepEqual(result, { ok: true });
  assert.equal(storage.getStatus().allowPrivateNetwork, true);
});

test('DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK=false keeps SSRF protection active', async (t) => {
  storage.__setPrivateNetworkAccessForTests?.(false);
  storage.__setHostnameLookupForTests?.(async () => [
    { address: '192.168.1.50', family: 4 },
  ]);
  process.env.DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK = 'false';
  setConfig({
    enabled: '0',
    url: 'https://files.example.test/dav',
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: 'https://webdav.example.test/dav',
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_INVALID_CONFIG');
  assert.equal(storage.getStatus().allowPrivateNetwork, false);
});

test('document storage avoids ambiguous trailing-slash regular expressions', () => {
  const source = readFileSync(
    new URL('../server/services/document-storage.js', import.meta.url),
    'utf8'
  );

  assert.equal(source.includes("replace(/\\/+$/, '')"), false);
});

test('saveConfig persists values and isWebdavUploadEnabled fails closed on incomplete config', async () => {
  storage.saveConfig({
    enabled: true,
    url: 'https://files.example.test/dav',
    username: 'alice',
    password: 'secret',
    path: 'family/documents',
  });
  assert.equal(storage.isWebdavUploadEnabled(), true);
  assert.equal(storage.getStatus().configured, true);

  storage.saveConfig({ url: '' });
  assert.equal(storage.isWebdavUploadEnabled(), true);
  assert.equal(storage.getStatus().configured, false);
  await assert.rejects(
    storage.stageDocumentUpload({
      buffer: Buffer.from('no fallback'),
      mime: 'text/plain',
      category: 'notes',
      originalName: 'note.txt',
    }),
    (error) => assertStorageError(error, 'DOCUMENT_STORAGE_NOT_CONFIGURED')
  );
});

test('buildStorageKey uses UUIDs and preserves sanitized category, name and extension', () => {
  const first = storage.buildStorageKey({
    category: 'Family Photos',
    originalName: '../Summer 2026.JPG',
  });
  const second = storage.buildStorageKey({
    category: 'Family Photos',
    originalName: '../Summer 2026.JPG',
  });

  assert.match(
    first,
    /^family-photos\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-summer-2026\.jpg$/i
  );
  assert.notEqual(first, second);
  assert.equal(first.includes('..'), false);
});

test('stageDocumentUpload returns local data when disabled', async () => {
  const result = await storage.stageDocumentUpload({
    buffer: Buffer.from('local bytes'),
    mime: 'text/plain',
    category: 'notes',
    originalName: 'note.txt',
  });
  assert.deepEqual(result, {
    storage_backend: 'local',
    storage_provider: 'local',
    storage_key: null,
    content_data: Buffer.from('local bytes'),
  });
});

test('migration 67 converts legacy base64 content_data to a binary BLOB (#332)', () => {
  const db = buildMigratedDatabase(MIGRATIONS.filter(({ version }) => version <= 66));
  const userId = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('m67', 'M67', 'hash', 'admin')
  `).run().lastInsertRowid;
  const insert = db.prepare(`
    INSERT INTO family_documents (
      name, category, visibility, original_name, mime_type, file_size,
      content_data, storage_provider, storage_backend, storage_key, created_by
    ) VALUES (?, 'other', 'family', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bytes = Buffer.from('legacy pdf payload');
  const localId = insert.run(
    'Legacy local', 'legacy.pdf', 'application/pdf', bytes.length,
    bytes.toString('base64'), 'local', 'local', null, userId
  ).lastInsertRowid;
  const webdavId = insert.run(
    'Remote', 'remote.pdf', 'application/pdf', 0,
    '', 'external', 'webdav', 'archive/remote.pdf', userId
  ).lastInsertRowid;

  // Vor der Migration ist der Wert ein base64-TEXT-String.
  assert.equal(typeof db.prepare('SELECT content_data FROM family_documents WHERE id = ?').get(localId).content_data, 'string');

  const migration = MIGRATIONS.find(({ version }) => version === 67);
  applyMigration(db, migration);

  const local = db.prepare('SELECT content_data FROM family_documents WHERE id = ?').get(localId).content_data;
  assert.ok(Buffer.isBuffer(local), 'local content_data is stored as a BLOB after migration');
  assert.deepEqual(local, bytes);
  // WebDAV-Zeile (extern, content_data = '') bleibt unberührt.
  assert.equal(db.prepare('SELECT content_data FROM family_documents WHERE id = ?').get(webdavId).content_data, '');

  // Idempotent: erneuter Lauf der up-Logik lässt bereits binäre Werte unverändert.
  migration.up(db);
  assert.deepEqual(db.prepare('SELECT content_data FROM family_documents WHERE id = ?').get(localId).content_data, bytes);
  db.close();
});

test('stageDocumentUpload creates WebDAV collections and uploads with Basic auth', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'family/documents',
  });

  const staged = await storage.stageDocumentUpload({
    buffer: Buffer.from('remote bytes'),
    mime: 'text/plain',
    category: 'School Notes',
    originalName: 'Math Notes.TXT',
  });

  assert.equal(staged.storage_backend, 'webdav');
  assert.equal(staged.storage_provider, 'external');
  assert.equal(staged.content_data, '');
  assert.match(staged.storage_key, /^school-notes\/.+-math-notes\.txt$/);
  assert.deepEqual(
    webdav.requests.map(({ method, url }) => ({ method, url })),
    [
      { method: 'MKCOL', url: '/family' },
      { method: 'MKCOL', url: '/family/documents' },
      { method: 'MKCOL', url: '/family/documents/school-notes' },
      { method: 'PUT', url: `/family/documents/${staged.storage_key}` },
    ]
  );
  assert.ok(webdav.requests.every(({ authorization }) => authorization ===
    `Basic ${Buffer.from('alice:secret').toString('base64')}`));
  assert.deepEqual(
    webdav.files.get(`/family/documents/${staged.storage_key}`),
    Buffer.from('remote bytes')
  );
});

test('stageDocumentUpload reports upload failures without local fallback', async (t) => {
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method === 'PUT') {
        res.writeHead(503);
        res.end('offline');
        return true;
      }
      return false;
    },
  });
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });

  await assert.rejects(
    storage.stageDocumentUpload({
      buffer: Buffer.from('must stay remote'),
      mime: 'text/plain',
      category: 'notes',
      originalName: 'note.txt',
    }),
    (error) => assertStorageError(error, 'DOCUMENT_STORAGE_UPLOAD_FAILED')
  );
  assert.equal(
    webdav.requests.some(({ method }) => method === 'PUT'),
    true
  );
});

test('stageDocumentUpload never follows cross-origin WebDAV redirects', async (t) => {
  for (const status of [307, 308]) {
    const redirected = await createWebdavServer(t);
    const webdav = await createWebdavServer(t, {
      handler(req, res) {
        if (req.method === 'PUT') {
          res.writeHead(status, { Location: `${redirected.url}/captured` });
          res.end();
          return true;
        }
        return false;
      },
    });
    setConfig({
      enabled: '1',
      url: webdav.url,
      username: 'alice',
      password: 'secret',
      path: `redirect-${status}`,
    });

    await assert.rejects(
      storage.stageDocumentUpload({
        buffer: Buffer.from(`sensitive document ${status}`),
        mime: 'text/plain',
        category: 'notes',
        originalName: 'private.txt',
      }),
      (error) => assertStorageError(error, 'DOCUMENT_STORAGE_UPLOAD_FAILED')
    );
    assert.deepEqual(redirected.requests, []);
  }
});

test('readDocumentContent branches on storage_backend and reads disabled WebDAV documents', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  webdav.files.set('/documents/archive/file.pdf', Buffer.from('webdav pdf'));

  // Binärer BLOB (Regelfall seit Migration 67): better-sqlite3 liefert einen Buffer.
  const local = await storage.readDocumentContent({
    storage_backend: 'local',
    content_data: Buffer.from('local pdf'),
    mime_type: 'application/pdf',
  });
  assert.deepEqual(local, { buffer: Buffer.from('local pdf'), mime: 'application/pdf' });

  // Alt-Zeile (base64-TEXT vor der Migration) wird weiterhin toleriert.
  const localLegacy = await storage.readDocumentContent({
    storage_backend: 'local',
    content_data: Buffer.from('local pdf').toString('base64'),
    mime_type: 'application/pdf',
  });
  assert.deepEqual(localLegacy, { buffer: Buffer.from('local pdf'), mime: 'application/pdf' });

  const remote = await storage.readDocumentContent({
    storage_backend: 'webdav',
    storage_key: 'archive/file.pdf',
    mime_type: 'application/pdf',
  });
  assert.deepEqual(remote, { buffer: Buffer.from('webdav pdf'), mime: 'application/pdf' });

  const dms = await storage.readDocumentContent(
    { storage_backend: 'dms', storage_key: '42', mime_type: 'application/pdf' },
    { dmsResolver: async () => Buffer.from('dms pdf') }
  );
  assert.deepEqual(dms, { buffer: Buffer.from('dms pdf'), mime: 'application/pdf' });
  await assert.rejects(
    storage.readDocumentContent({
      storage_backend: 'dms',
      storage_key: '42',
      mime_type: 'application/pdf',
    }),
    (error) => assertStorageError(error, 'DOCUMENT_STORAGE_READ_FAILED')
  );
});

test('readDocumentContent rejects oversized responses before and during streaming', async (t) => {
  const oversized = 5 * 1024 * 1024 + 1;
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method !== 'GET') return false;
      if (req.url === '/documents/declared.bin') {
        res.writeHead(200, { 'Content-Length': oversized });
        res.end();
        return true;
      }
      if (req.url === '/documents/streamed.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        Readable.from([
          Buffer.alloc(3 * 1024 * 1024),
          Buffer.alloc(3 * 1024 * 1024),
        ]).pipe(res);
        return true;
      }
      return false;
    },
  });
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });

  for (const storageKey of ['declared.bin', 'streamed.bin']) {
    await assert.rejects(
      storage.readDocumentContent({
        storage_backend: 'webdav',
        storage_key: storageKey,
        mime_type: 'application/octet-stream',
      }),
      (error) => assertStorageError(error, 'DOCUMENT_STORAGE_TOO_LARGE')
    );
  }
});

test('WebDAV requests time out with a stable storage error', async (t) => {
  const webdav = await createWebdavServer(t, {
    async handler(req, res) {
      if (req.method !== 'GET') return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
      res.writeHead(200);
      res.end('late');
      return true;
    },
  });
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  storage.__setRequestTimeoutForTests(30);

  await assert.rejects(
    storage.readDocumentContent({
      storage_backend: 'webdav',
      storage_key: 'slow.txt',
      mime_type: 'text/plain',
    }),
    (error) => assertStorageError(error, 'DOCUMENT_STORAGE_READ_FAILED')
  );
});

test('cleanup and delete remove only WebDAV content and accept remote 404', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  webdav.files.set('/documents/present.txt', Buffer.from('present'));

  await storage.cleanupStagedUpload({
    storage_backend: 'local',
    storage_key: null,
  });
  await storage.deleteDocumentContent({
    storage_backend: 'dms',
    storage_key: '42',
  });
  await storage.deleteDocumentContent({
    storage_backend: 'webdav',
    storage_key: 'missing.txt',
  });
  await storage.cleanupStagedUpload({
    storage_backend: 'webdav',
    storage_key: 'present.txt',
  });

  assert.equal(webdav.files.has('/documents/present.txt'), false);
  assert.deepEqual(
    webdav.requests.filter(({ method }) => method === 'DELETE').map(({ url }) => url),
    ['/documents/missing.txt', '/documents/present.txt']
  );
});

test('deleteDocumentContent preserves stable failure codes', async (t) => {
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method === 'DELETE') {
        res.writeHead(500);
        res.end();
        return true;
      }
      return false;
    },
  });
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });

  await assert.rejects(
    storage.deleteDocumentContent({
      storage_backend: 'webdav',
      storage_key: 'keep.txt',
    }),
    (error) => assertStorageError(error, 'DOCUMENT_STORAGE_DELETE_FAILED')
  );
});

test('cleanupStagedUpload maps remote failures to a cleanup-specific code', async (t) => {
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method === 'DELETE') {
        res.writeHead(503);
        res.end();
        return true;
      }
      return false;
    },
  });
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });

  await assert.rejects(
    storage.cleanupStagedUpload({
      storage_backend: 'webdav',
      storage_key: 'staged.txt',
    }),
    (error) => assertStorageError(error, 'DOCUMENT_STORAGE_CLEANUP_FAILED')
  );
});

test('document meta keeps provider compatibility and reports the active upload backend', async (t) => {
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  let result = await routeCall(harness, 'GET', '/meta/options');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data.storage_providers, ['local', 'external']);
  assert.equal(result.body.data.active_upload_backend, 'local');

  setConfig({ enabled: '1' });
  result = await routeCall(harness, 'GET', '/meta/options');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data.storage_providers, ['local', 'external']);
  assert.equal(result.body.data.active_upload_backend, 'webdav');
});

test('document routes store local uploads and return storage_backend in create, list and update', async (t) => {
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const created = await routeCall(harness, 'POST', '/', uploadBody({
    name: 'Local route upload',
    bytes: 'local route bytes',
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.storage_provider, 'local');
  assert.equal(created.body.data.storage_backend, 'local');

  const row = get().prepare(`
    SELECT storage_provider, storage_backend, storage_key, content_data
    FROM family_documents
    WHERE id = ?
  `).get(created.body.data.id);
  assert.deepEqual(row, {
    storage_provider: 'local',
    storage_backend: 'local',
    storage_key: null,
    content_data: Buffer.from('local route bytes'),
  });

  const listed = await routeCall(harness, 'GET', '/');
  assert.equal(listed.response.status, 200);
  assert.equal(
    listed.body.data.find(({ id }) => id === created.body.data.id).storage_backend,
    'local'
  );

  const updated = await routeCall(harness, 'PUT', `/${created.body.data.id}`, {
    name: 'Updated local route upload',
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.storage_backend, 'local');
});

test('document upload stores WebDAV bytes remotely without a SQLite binary copy', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'POST', '/', uploadBody({
    name: 'Remote route upload',
    category: 'school',
    bytes: 'remote route bytes',
  }));
  assert.equal(result.response.status, 201);
  assert.equal(result.body.data.storage_provider, 'external');
  assert.equal(result.body.data.storage_backend, 'webdav');

  const row = get().prepare(`
    SELECT storage_provider, storage_backend, storage_key, content_data
    FROM family_documents
    WHERE id = ?
  `).get(result.body.data.id);
  assert.equal(row.storage_provider, 'external');
  assert.equal(row.storage_backend, 'webdav');
  assert.equal(row.content_data, '');
  assert.deepEqual(
    webdav.files.get(`/documents/${row.storage_key}`),
    Buffer.from('remote route bytes')
  );
});

test('enabled WebDAV upload failures return a stable error and never create a local row', async (t) => {
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method !== 'PUT') return false;
      res.writeHead(503);
      res.end();
      return true;
    },
  });
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'POST', '/', uploadBody({
    name: 'Rejected remote upload',
  }));
  assert.equal(result.response.status, 502);
  assert.equal(result.body.code, 502);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_UPLOAD_FAILED');
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE name = ?')
      .get('Rejected remote upload').count,
    0
  );
});

test('document upload removes staged WebDAV content when the database transaction fails', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'POST', '/', uploadBody({
    name: 'Compensated upload',
    visibility: 'restricted',
    allowed_member_ids: [999_999_999],
  }));
  assert.equal(result.response.status, 500);
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE name = ?')
      .get('Compensated upload').count,
    0
  );
  assert.equal(webdav.files.size, 0);
  assert.equal(webdav.requests.some(({ method }) => method === 'DELETE'), true);
});

test('document upload surfaces cleanup failure after a failed database transaction', async (t) => {
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method !== 'DELETE') return false;
      res.writeHead(503);
      res.end();
      return true;
    },
  });
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'POST', '/', uploadBody({
    name: 'Cleanup failure upload',
    visibility: 'restricted',
    allowed_member_ids: [999_999_999],
  }));
  assert.equal(result.response.status, 502);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_CLEANUP_FAILED');
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE name = ?')
      .get('Cleanup failure upload').count,
    0
  );
  assert.equal(webdav.files.size, 1);
});

test('preview and download read WebDAV documents through the shared storage service', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const documentId = insertRouteDocument(userId, {
    originalName: 'remote.txt',
    fileSize: 12,
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'archive/remote.txt',
  });
  webdav.files.set('/documents/archive/remote.txt', Buffer.from('remote bytes'));
  const harness = createRouteHarness({ userId });
  const baseUrl = await harness.listen();
  t.after(() => harness.close());

  for (const endpoint of ['preview', 'download']) {
    const response = await fetch(
      `${baseUrl}/api/v1/documents/${documentId}/${endpoint}`
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'remote bytes');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal(
    webdav.requests.filter(({ method }) => method === 'GET').length,
    2
  );
});

test('deleting WebDAV documents removes remote content before deleting the database row', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const documentId = insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'delete/present.txt',
  });
  webdav.files.set('/documents/delete/present.txt', Buffer.from('delete me'));
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'DELETE', `/${documentId}`);
  assert.equal(result.response.status, 204);
  assert.equal(webdav.files.has('/documents/delete/present.txt'), false);
  assert.equal(
    get().prepare('SELECT id FROM family_documents WHERE id = ?').get(documentId),
    undefined
  );
});

test('deleting a WebDAV document accepts remote 404 and deletes the database row', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const documentId = insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'delete/missing.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'DELETE', `/${documentId}`);
  assert.equal(result.response.status, 204);
  assert.equal(
    get().prepare('SELECT id FROM family_documents WHERE id = ?').get(documentId),
    undefined
  );
});

test('failed WebDAV delete returns a stable error and preserves the database row', async (t) => {
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method !== 'DELETE') return false;
      res.writeHead(503);
      res.end();
      return true;
    },
  });
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const documentId = insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'delete/keep.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'DELETE', `/${documentId}`);
  assert.equal(result.response.status, 502);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_DELETE_FAILED');
  assert.equal(
    get().prepare('SELECT id FROM family_documents WHERE id = ?').get(documentId).id,
    documentId
  );
});

test('orphaned DMS documents are never resolved as WebDAV content', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const documentId = insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'dms',
    storageKey: 'orphan-id',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'GET', `/${documentId}/preview`);
  assert.equal(result.response.status, 404);
  assert.equal(
    webdav.requests.some(({ method }) => method === 'GET'),
    false
  );
});

test('calendar stores a new local attachment once in document storage', async (t) => {
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await calendarRouteCall(
    harness,
    'POST',
    '/',
    calendarEventBody({ attachmentBytes: 'local calendar bytes' })
  );

  assert.equal(result.response.status, 201);
  assert.equal(result.body.data.attachment_data, null);
  assert.ok(result.body.data.attachment_document_id);
  assert.equal(
    result.body.data.attachment_preview_url,
    `/api/v1/documents/${result.body.data.attachment_document_id}/preview`
  );
  assert.equal(
    result.body.data.attachment_download_url,
    `/api/v1/documents/${result.body.data.attachment_document_id}/download`
  );

  const event = get().prepare(`
    SELECT attachment_data, attachment_document_id
    FROM calendar_events
    WHERE id = ?
  `).get(result.body.data.id);
  assert.equal(event.attachment_data, null);
  const document = get().prepare(`
    SELECT storage_provider, storage_backend, storage_key, content_data
    FROM family_documents
    WHERE id = ?
  `).get(event.attachment_document_id);
  assert.deepEqual(document, {
    storage_provider: 'local',
    storage_backend: 'local',
    storage_key: null,
    content_data: Buffer.from('local calendar bytes'),
  });
});

test('calendar stores a new WebDAV attachment remotely without a SQLite binary copy', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await calendarRouteCall(
    harness,
    'POST',
    '/',
    calendarEventBody({ attachmentBytes: 'remote calendar bytes' })
  );

  assert.equal(result.response.status, 201);
  const event = get().prepare(`
    SELECT attachment_data, attachment_document_id
    FROM calendar_events
    WHERE id = ?
  `).get(result.body.data.id);
  assert.equal(event.attachment_data, null);
  const document = get().prepare(`
    SELECT storage_provider, storage_backend, storage_key, content_data
    FROM family_documents
    WHERE id = ?
  `).get(event.attachment_document_id);
  assert.equal(document.storage_provider, 'external');
  assert.equal(document.storage_backend, 'webdav');
  assert.equal(document.content_data, '');
  assert.deepEqual(
    webdav.files.get(`/documents/${document.storage_key}`),
    Buffer.from('remote calendar bytes')
  );
});

test('calendar rejects failed WebDAV attachment uploads with a stable storage code', async (t) => {
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method !== 'PUT') return false;
      res.writeHead(503);
      res.end();
      return true;
    },
  });
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await calendarRouteCall(
    harness,
    'POST',
    '/',
    calendarEventBody({ title: 'Rejected calendar upload' })
  );

  assert.equal(result.response.status, 502);
  assert.equal(result.body.code, 502);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_UPLOAD_FAILED');
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE title = ?')
      .get('Rejected calendar upload').count,
    0
  );
});

test('calendar edit without attachment fields does not upload or replace the document', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const created = await calendarRouteCall(
    harness,
    'POST',
    '/',
    calendarEventBody({ attachmentBytes: 'unchanged bytes' })
  );
  assert.equal(created.response.status, 201);
  const originalDocumentId = created.body.data.attachment_document_id;
  const putCount = webdav.requests.filter(({ method }) => method === 'PUT').length;

  const updated = await calendarRouteCall(
    harness,
    'PUT',
    `/${created.body.data.id}`,
    { title: 'Updated without attachment payload' }
  );

  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.attachment_document_id, originalDocumentId);
  assert.equal(updated.body.data.attachment_data, null);
  assert.equal(
    webdav.requests.filter(({ method }) => method === 'PUT').length,
    putCount
  );
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE id = ?')
      .get(originalDocumentId).count,
    1
  );
});

test('calendar attachment replacement links a new document and preserves the old one', async (t) => {
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const created = await calendarRouteCall(
    harness,
    'POST',
    '/',
    calendarEventBody({ attachmentBytes: 'first calendar bytes' })
  );
  assert.equal(created.response.status, 201);
  const originalDocumentId = created.body.data.attachment_document_id;

  const updated = await calendarRouteCall(
    harness,
    'PUT',
    `/${created.body.data.id}`,
    {
      attachment_name: 'replacement.txt',
      attachment_data: `data:text/plain;base64,${Buffer.from('replacement bytes').toString('base64')}`,
    }
  );

  assert.equal(updated.response.status, 200);
  assert.notEqual(updated.body.data.attachment_document_id, originalDocumentId);
  assert.equal(updated.body.data.attachment_data, null);
  const documents = get().prepare(`
    SELECT id, content_data
    FROM family_documents
    WHERE id IN (?, ?)
    ORDER BY id
  `).all(originalDocumentId, updated.body.data.attachment_document_id);
  assert.equal(documents.length, 2);
  assert.deepEqual(
    documents.find(({ id }) => id === originalDocumentId).content_data,
    Buffer.from('first calendar bytes')
  );
  assert.deepEqual(
    documents.find(({ id }) => id === updated.body.data.attachment_document_id).content_data,
    Buffer.from('replacement bytes')
  );
});

test('calendar attachment removal unlinks the event without deleting the document', async (t) => {
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const created = await calendarRouteCall(
    harness,
    'POST',
    '/',
    calendarEventBody({ attachmentBytes: 'keep document bytes' })
  );
  assert.equal(created.response.status, 201);
  const documentId = created.body.data.attachment_document_id;

  const removed = await calendarRouteCall(
    harness,
    'PUT',
    `/${created.body.data.id}`,
    { remove_attachment: true }
  );

  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.data.attachment_document_id, null);
  assert.equal(removed.body.data.attachment_name, null);
  assert.equal(removed.body.data.attachment_mime, null);
  assert.equal(removed.body.data.attachment_size, null);
  assert.equal(removed.body.data.attachment_data, null);
  assert.equal(removed.body.data.attachment_preview_url, null);
  assert.equal(removed.body.data.attachment_download_url, null);
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE id = ?')
      .get(documentId).count,
    1
  );

  const deleted = await calendarRouteCall(
    harness,
    'DELETE',
    `/${created.body.data.id}`
  );
  assert.equal(deleted.response.status, 204);
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE id = ?')
      .get(documentId).count,
    1
  );
});

test('calendar explicit null attachment data unlinks without deleting the document', async (t) => {
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const created = await calendarRouteCall(
    harness,
    'POST',
    '/',
    calendarEventBody({ attachmentBytes: 'null unlink bytes' })
  );
  const documentId = created.body.data.attachment_document_id;

  const removed = await calendarRouteCall(
    harness,
    'PUT',
    `/${created.body.data.id}`,
    { attachment_data: null }
  );

  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.data.attachment_document_id, null);
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE id = ?')
      .get(documentId).count,
    1
  );
});

test('calendar keeps legacy attachment blobs readable as data URLs', async (t) => {
  const userId = createRouteUser();
  const eventId = get().prepare(`
    INSERT INTO calendar_events (
      title, start_datetime, created_by,
      attachment_name, attachment_mime, attachment_size, attachment_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Legacy attachment event',
    '2026-06-10T10:00:00.000Z',
    userId,
    'legacy.txt',
    'text/plain',
    12,
    Buffer.from('legacy bytes').toString('base64')
  ).lastInsertRowid;
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await calendarRouteCall(harness, 'GET', `/${eventId}`);

  assert.equal(result.response.status, 200);
  assert.equal(
    result.body.data.attachment_data,
    `data:text/plain;base64,${Buffer.from('legacy bytes').toString('base64')}`
  );
  assert.equal(result.body.data.attachment_document_id, null);
  assert.equal(result.body.data.attachment_preview_url, null);
  assert.equal(result.body.data.attachment_download_url, null);
});

test('calendar cleans up staged WebDAV content when its database transaction fails', async (t) => {
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());
  get().exec(`
    CREATE TRIGGER fail_calendar_attachment_event
    BEFORE INSERT ON calendar_events
    WHEN NEW.title = 'Force calendar DB failure'
    BEGIN
      SELECT RAISE(ABORT, 'forced calendar transaction failure');
    END;
  `);
  t.after(() => {
    get().exec('DROP TRIGGER IF EXISTS fail_calendar_attachment_event');
  });

  const result = await calendarRouteCall(
    harness,
    'POST',
    '/',
    calendarEventBody({
      title: 'Force calendar DB failure',
      extra: { document_name: 'Failure cleanup document' },
    })
  );

  assert.equal(result.response.status, 500);
  assert.equal(
    get().prepare('SELECT COUNT(*) AS count FROM family_documents WHERE name = ?')
      .get('Failure cleanup document').count,
    0
  );
  assert.equal(webdav.files.size, 0);
  assert.equal(
    webdav.requests.some(({ method }) => method === 'DELETE'),
    true
  );
});

test('document storage configuration endpoints are admin-only', async (t) => {
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId, role: 'member' });
  t.after(() => harness.close());

  for (const [method, pathname, body] of [
    ['GET', '/storage/config', undefined],
    ['PUT', '/storage/config', { enabled: false }],
    ['POST', '/storage/test', {}],
  ]) {
    const result = await routeCall(harness, method, pathname, body);
    assert.equal(result.response.status, 403, `${method} ${pathname}`);
    assert.equal(result.body.code, 403);
  }
});

test('document storage config status masks passwords and reports effective env control', async (t) => {
  clearWebdavDocuments();
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: 'https://db.example.test/dav',
    username: 'db-user',
    password: 'db-secret',
    path: 'db/documents',
    last_test: '2026-06-10T12:00:00.000Z',
    last_error: 'previous failure',
  });
  process.env.DOCUMENT_STORAGE_WEBDAV_ENABLED = '1';
  process.env.DOCUMENT_STORAGE_WEBDAV_URL = webdav.url;
  process.env.DOCUMENT_STORAGE_WEBDAV_PATH = 'env/documents';
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'status/file.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'GET', '/storage/config');

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, {
    enabled: true,
    configured: true,
    active_upload_backend: 'webdav',
    effective_target: `${webdav.url}/env/documents`,
    webdav_document_count: 1,
    last_test: '2026-06-10T12:00:00.000Z',
    last_error: 'previous failure',
    url: webdav.url,
    username: 'db-user',
    base_path: 'env/documents',
    password_configured: true,
    env_controlled: {
      enabled: true,
      url: true,
      username: false,
      password: false,
      path: true,
    },
  });
  assert.equal('password' in result.body.data, false);
});

test('disabling WebDAV with existing documents changes only future uploads', async (t) => {
  clearWebdavDocuments();
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'existing.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    enabled: false,
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.enabled, false);
  assert.equal(result.body.data.active_upload_backend, 'local');
  assert.equal(result.body.data.webdav_document_count, 1);
  assert.equal(webdav.requests.length, 0);
  assert.equal(storage.getConfig().url, webdav.url);
  assert.equal(storage.getConfig().password, 'secret');
});

test('existing WebDAV documents prevent required connection data deletion', async (t) => {
  clearWebdavDocuments();
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'protected.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  for (const body of [
    { url: '', confirm_existing_access: true },
    { username: '', confirm_existing_access: true },
    { clear_password: true, confirm_existing_access: true },
    { path: '', confirm_existing_access: true },
  ]) {
    const result = await routeCall(harness, 'PUT', '/storage/config', body);
    assert.equal(result.response.status, 409);
    assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_CONFIG_PROTECTED');
  }
  assert.equal(storage.getConfig().url, webdav.url);
  assert.equal(storage.getConfig().username, 'alice');
  assert.equal(storage.getConfig().password, 'secret');
  assert.equal(storage.getConfig().basePath, 'documents');
  assert.equal(webdav.requests.length, 0);
});

test('protected effective connection changes require explicit confirmation', async (t) => {
  clearWebdavDocuments();
  const current = await createWebdavServer(t);
  const proposed = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: current.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'protected.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: proposed.url,
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_CONFIG_PROTECTED');
  assert.equal(storage.getConfig().url, current.url);
  assert.equal(proposed.requests.length, 0);
});

test('equivalent normalized WebDAV targets do not require confirmation', async (t) => {
  clearWebdavDocuments();
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: `${webdav.url}/`,
    username: 'alice',
    password: 'secret',
    path: '/documents/',
  });
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'same-target.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: webdav.url,
    path: 'documents',
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.effective_target, `${webdav.url}/documents`);
  assert.equal(webdav.requests.length, 0);
});

test('confirmed protected changes are rejected when an existing object is unavailable or oversized', async (t) => {
  clearWebdavDocuments();
  const current = await createWebdavServer(t);
  const proposed = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method === 'GET' && req.url === '/moved/oversized.txt') {
        res.writeHead(200, { 'Content-Length': 5 * 1024 * 1024 + 1 });
        res.end();
        return true;
      }
      return false;
    },
  });
  setConfig({
    enabled: '1',
    url: current.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'oversized.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: proposed.url,
    path: 'moved',
    confirm_existing_access: true,
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_CONFIG_PROTECTED');
  assert.equal(storage.getConfig().url, current.url);
  assert.equal(storage.getConfig().basePath, 'documents');
  assert.deepEqual(
    proposed.requests.map(({ method, url }) => ({ method, url })),
    [{ method: 'GET', url: '/moved/oversized.txt' }]
  );
});

test('confirmed protected changes verify an existing object before persistence', async (t) => {
  clearWebdavDocuments();
  const current = await createWebdavServer(t);
  const proposed = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: current.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'archive/existing.txt',
  });
  proposed.files.set('/moved/archive/existing.txt', Buffer.from('existing bytes'));
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: proposed.url,
    path: 'moved',
    password: '****',
    confirm_existing_access: true,
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.url, proposed.url);
  assert.equal(result.body.data.base_path, 'moved');
  assert.equal(result.body.data.password_configured, true);
  assert.equal(storage.getConfig().password, 'secret');
  assert.deepEqual(
    proposed.requests.map(({ method, url }) => ({ method, url })),
    [{ method: 'GET', url: '/moved/archive/existing.txt' }]
  );
});

test('env-controlled config fields ignore writes without triggering protected changes', async (t) => {
  clearWebdavDocuments();
  const envTarget = await createWebdavServer(t);
  setConfig({
    enabled: '1',
    url: 'https://db.example.test/dav',
    username: 'db-user',
    password: 'db-secret',
    path: 'db/documents',
  });
  process.env.DOCUMENT_STORAGE_WEBDAV_URL = envTarget.url;
  process.env.DOCUMENT_STORAGE_WEBDAV_USERNAME = 'env-user';
  const userId = createRouteUser();
  insertRouteDocument(userId, {
    contentData: '',
    storageProvider: 'external',
    storageBackend: 'webdav',
    storageKey: 'env-controlled.txt',
  });
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: 'https://ignored.example.test/dav',
    username: 'ignored-user',
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.url, envTarget.url);
  assert.equal(result.body.data.username, 'env-user');
  assert.equal(result.body.data.env_controlled.url, true);
  assert.equal(result.body.data.env_controlled.username, true);
  assert.equal(envTarget.requests.length, 0);
});

test('password masks and empty values preserve the stored password unless explicitly cleared', async (t) => {
  clearWebdavDocuments();
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  for (const password of [undefined, '', '****', '••••••••']) {
    const body = password === undefined ? { enabled: false } : { password };
    const result = await routeCall(harness, 'PUT', '/storage/config', body);
    assert.equal(result.response.status, 200);
    assert.equal(storage.getConfig().password, 'secret');
  }

  const cleared = await routeCall(harness, 'PUT', '/storage/config', {
    clear_password: true,
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.data.password_configured, false);
  assert.equal(storage.getConfig().password, null);
});

test('connection test uses hybrid overrides without persisting connection fields', async (t) => {
  clearWebdavDocuments();
  const webdav = await createWebdavServer(t);
  setConfig({
    enabled: '0',
    url: 'https://stored.example.test/dav',
    username: 'stored-user',
    password: 'stored-secret',
    path: 'stored/documents',
  });
  process.env.DOCUMENT_STORAGE_WEBDAV_USERNAME = 'alice';
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'POST', '/storage/test', {
    url: webdav.url,
    username: 'ignored-by-env',
    password: 'secret',
    path: 'test/documents',
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, { ok: true });
  assert.deepEqual(
    webdav.requests.map(({ method }) => method),
    ['MKCOL', 'MKCOL', 'PUT', 'GET', 'DELETE']
  );
  assert.ok(webdav.requests.every(({ authorization }) => authorization ===
    `Basic ${Buffer.from('alice:secret').toString('base64')}`));
  const config = storage.getConfig();
  assert.equal(config.url, 'https://stored.example.test/dav');
  assert.equal(config.username, 'alice');
  assert.equal(config.password, 'stored-secret');
  assert.equal(config.basePath, 'stored/documents');
  assert.match(config.lastTest, /^\d{4}-\d{2}-\d{2}T/);
});

test('connection test returns stable storage codes for invalid overrides', async (t) => {
  clearWebdavDocuments();
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'POST', '/storage/test', {
    url: 'ftp://files.example.test',
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_INVALID_CONFIG');
});

test('config update rejects invalid URLs before persistence', async (t) => {
  clearWebdavDocuments();
  setConfig({
    enabled: '0',
    url: 'https://valid.example.test/dav',
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  const userId = createRouteUser();
  const harness = createRouteHarness({ userId });
  t.after(() => harness.close());

  const result = await routeCall(harness, 'PUT', '/storage/config', {
    url: 'ftp://invalid.example.test',
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.storage_code, 'DOCUMENT_STORAGE_INVALID_CONFIG');
  assert.equal(storage.getConfig().url, 'https://valid.example.test/dav');
});

test('testConnection performs and verifies a temporary PUT GET DELETE roundtrip', async (t) => {
  const webdav = await createWebdavServer(t);
  storage.saveConfig({
    enabled: true,
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'family/documents',
  });

  const result = await storage.testConnection();
  assert.deepEqual(result, { ok: true });

  const methods = webdav.requests.map(({ method }) => method);
  assert.deepEqual(methods, ['MKCOL', 'MKCOL', 'PUT', 'GET', 'DELETE']);
  const temporaryUrl = webdav.requests.find(({ method }) => method === 'PUT').url;
  assert.match(temporaryUrl, /^\/family\/documents\/\.connection-test-[0-9a-f-]+\.bin$/);
  assert.equal(webdav.files.has(temporaryUrl), false);

  const status = storage.getStatus();
  assert.match(status.lastTest, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.lastError, null);
});

test('testConnection deletes its temporary file and persists a stable failure', async (t) => {
  const previousSuccessfulTest = '2026-06-09T08:30:00.000Z';
  const webdav = await createWebdavServer(t, {
    handler(req, res) {
      if (req.method === 'GET') {
        res.writeHead(200);
        res.end('wrong bytes');
        return true;
      }
      return false;
    },
  });
  storage.saveConfig({
    enabled: true,
    url: webdav.url,
    username: 'alice',
    password: 'secret',
    path: 'documents',
  });
  setConfig({ last_test: previousSuccessfulTest });

  await assert.rejects(
    storage.testConnection(),
    (error) => assertStorageError(error, 'DOCUMENT_STORAGE_CONNECTION_TEST_FAILED')
  );
  assert.equal(webdav.requests.some(({ method }) => method === 'DELETE'), true);
  const status = storage.getStatus();
  assert.equal(status.lastTest, previousSuccessfulTest);
  assert.match(status.lastError, /verification/i);
});

// --- Folder-backed local storage (DOCUMENT_STORAGE_LOCAL_* env opt-in) -------

const LOCAL_ENV_KEYS = [
  'DOCUMENT_STORAGE_LOCAL_ENABLED',
  'DOCUMENT_STORAGE_LOCAL_PATH',
];

function withLocalStorage(fn) {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'yuvomi-docs-'));
  const previous = Object.fromEntries(LOCAL_ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;
  return {
    dir,
    async run() {
      try {
        await fn(dir);
      } finally {
        for (const key of LOCAL_ENV_KEYS) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

test('getLocalStorageConfig is disabled with a default base path unless env opts in', () => {
  for (const key of LOCAL_ENV_KEYS) delete process.env[key];
  const off = storage.getLocalStorageConfig();
  assert.equal(off.enabled, false);
  assert.equal(off.basePath, '/documents');

  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = '1';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = '/srv/docs';
  const on = storage.getLocalStorageConfig();
  assert.equal(on.enabled, true);
  assert.equal(on.basePath, '/srv/docs');
  for (const key of LOCAL_ENV_KEYS) delete process.env[key];
});

test('local storage: upload writes to the folder and round-trips through read/delete', () =>
  withLocalStorage(async (dir) => {
    const content = Buffer.from('hello local folder');
    const staged = await storage.stageDocumentUpload({
      buffer: content,
      mime: 'application/pdf',
      category: 'invoices',
      originalName: 'bill.pdf',
    });

    assert.equal(staged.storage_backend, 'local');
    assert.equal(staged.storage_provider, 'local');
    assert.equal(staged.content_data, '');
    assert.ok(staged.storage_key && !staged.storage_key.startsWith('/'));
    assert.ok(!staged.storage_key.includes('__abs__'), 'no absolute-path marker');

    const onDisk = nodePath.join(dir, staged.storage_key);
    assert.ok(existsSync(onDisk), 'file exists under the configured base path');
    assert.deepEqual(readFileSync(onDisk), content);

    const doc = {
      storage_backend: 'local',
      storage_key: staged.storage_key,
      mime_type: 'application/pdf',
    };
    const read = await storage.readDocumentContent(doc);
    assert.deepEqual(read.buffer, content);
    assert.equal(read.mime, 'application/pdf');

    await storage.deleteDocumentContent(doc);
    assert.equal(existsSync(onDisk), false, 'file removed on delete');
  }).run());

test('local storage takes precedence over a configured WebDAV backend', () =>
  withLocalStorage(async (dir) => {
    setConfig({
      enabled: 'true',
      url: 'http://127.0.0.1:1/dav',
      username: 'alice',
      password: 'secret',
      path: 'documents',
    });
    const staged = await storage.stageDocumentUpload({
      buffer: Buffer.from('x'),
      category: 'misc',
      originalName: 'a.txt',
    });
    assert.equal(staged.storage_backend, 'local');
    assert.ok(existsSync(nodePath.join(dir, staged.storage_key)));
  }).run());

test('local storage: a write failure surfaces loudly without a silent fallback', () =>
  withLocalStorage(async (dir) => {
    // Point the base path at a location whose parent is a regular file so the
    // mkdir/writeFile fails; the old fallback to /data/documents is gone.
    const blocker = nodePath.join(dir, 'blocker');
    writeFileSync(blocker, '');
    process.env.DOCUMENT_STORAGE_LOCAL_PATH = nodePath.join(blocker, 'nested');

    await assert.rejects(
      storage.stageDocumentUpload({
        buffer: Buffer.from('x'),
        category: 'misc',
        originalName: 'a.txt',
      }),
      (error) => assertStorageError(error, 'DOCUMENT_STORAGE_UPLOAD_FAILED')
    );
  }).run());

test('local storage: read rejects a traversal storage_key', () =>
  withLocalStorage(async () => {
    await assert.rejects(
      storage.readDocumentContent({
        storage_backend: 'local',
        storage_key: '../../etc/passwd',
        mime_type: 'text/plain',
      }),
      (error) => assertStorageError(error, 'DOCUMENT_STORAGE_INVALID_CONFIG')
    );
  }).run());

test('local storage: read enforces the maximum readable size', () =>
  withLocalStorage(async (dir) => {
    const relKey = 'big/file.bin';
    const full = nodePath.join(dir, relKey);
    mkdirSync(nodePath.dirname(full), { recursive: true });
    writeFileSync(full, '');
    truncateSync(full, 5 * 1024 * 1024 + 1); // sparse file just over MAX_READ_BYTES

    await assert.rejects(
      storage.readDocumentContent({
        storage_backend: 'local',
        storage_key: relKey,
        mime_type: 'application/octet-stream',
      }),
      (error) => assertStorageError(error, 'DOCUMENT_STORAGE_READ_FAILED')
    );
    assert.ok(statSync(full).size > 5 * 1024 * 1024);
  }).run());

test('local storage: delete ignores an already-missing file', () =>
  withLocalStorage(async () => {
    await storage.deleteDocumentContent({
      storage_backend: 'local',
      storage_key: 'gone/missing.bin',
      mime_type: 'application/octet-stream',
    });
  }).run());

test('legacy local rows without a storage_key still read from the DB BLOB', async () => {
  for (const key of LOCAL_ENV_KEYS) delete process.env[key];
  const read = await storage.readDocumentContent({
    storage_backend: 'local',
    storage_key: null,
    content_data: Buffer.from('legacy blob'),
    mime_type: 'text/plain',
  });
  assert.deepEqual(read.buffer, Buffer.from('legacy blob'));
});
