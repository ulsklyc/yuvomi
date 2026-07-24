import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'google-drive-storage-test-secret';
process.env.GOOGLE_CLIENT_ID = 'calendar-client';
process.env.GOOGLE_CLIENT_SECRET = 'calendar-secret';
process.env.GOOGLE_DRIVE_REDIRECT_URI = 'https://example.test/api/v1/documents/storage/google-drive/callback';

const databaseModule = await import('../server/db.js');
const driveStorage = await import('../server/services/google-drive-storage.js');
const { default: driveStorageRouter } = await import('../server/routes/document-storage-google-drive.js');
const originalDatabase = databaseModule.get();
const database = new Database(':memory:');
database.exec(`
  CREATE TABLE sync_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE TABLE family_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_backend TEXT NOT NULL,
    storage_key TEXT
  );
`);
databaseModule._setTestDatabase(database);
originalDatabase.close();

function cfg(key) {
  return database.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
}

function setCfg(key, value) {
  database.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(key, value);
}

function createFake() {
  const state = {
    account: { permissionId: 'account-a', emailAddress: 'a@example.test', displayName: 'Account A' },
    tokenResponse: {
      access_token: 'drive-access-a',
      refresh_token: 'drive-refresh-a',
      expiry_date: 2_000_000_000_000,
    },
    authOptions: null,
    clients: [],
    files: new Map(),
    foldersCreated: 0,
  };

  class OAuthClient {
    constructor(clientId, clientSecret, redirectUri) {
      this.config = { clientId, clientSecret, redirectUri };
      this.listeners = new Map();
      state.clients.push(this);
    }

    generateAuthUrl(options) {
      state.authOptions = options;
      return `https://accounts.example.test/auth?state=${options.state}`;
    }

    async getToken() {
      return { tokens: { ...state.tokenResponse } };
    }

    setCredentials(credentials) {
      this.credentials = credentials;
    }

    on(event, listener) {
      this.listeners.set(event, listener);
    }
  }

  const files = {
    async list({ q }) {
      const name = q.match(/name = '([^']+)'/)?.[1];
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const found = [...state.files.entries()].find(([, file]) => (
        file.mimeType === 'application/vnd.google-apps.folder'
        && file.name === name
        && (!parent || file.parents?.includes(parent))
        && !file.trashed
      ));
      return { data: { files: found ? [{ id: found[0], name: found[1].name }] : [] } };
    },
    async create({ requestBody, media }) {
      const id = `file-${state.files.size + 1}`;
      let content = null;
      if (media?.body) {
        const chunks = [];
        for await (const chunk of media.body) chunks.push(Buffer.from(chunk));
        content = Buffer.concat(chunks);
      }
      const mimeType = requestBody.mimeType || media?.mimeType || 'application/octet-stream';
      if (mimeType === 'application/vnd.google-apps.folder') state.foldersCreated += 1;
      state.files.set(id, {
        id,
        name: requestBody.name,
        parents: requestBody.parents || [],
        mimeType,
        size: content?.length ?? null,
        content,
        trashed: false,
      });
      return { data: { id, name: requestBody.name } };
    },
    async get(args) {
      const file = state.files.get(args.fileId);
      if (!file) {
        const error = new Error('not found');
        error.code = 404;
        throw error;
      }
      if (args.alt === 'media') return { data: Readable.from(file.content || Buffer.alloc(0)) };
      return { data: { ...file, content: undefined } };
    },
    async delete({ fileId }) {
      if (!state.files.has(fileId)) {
        const error = new Error('not found');
        error.code = 404;
        throw error;
      }
      state.files.delete(fileId);
      return { data: {} };
    },
  };

  return {
    state,
    factory: {
      createOAuth2: (...args) => new OAuthClient(...args),
      createDrive: () => ({
        about: { get: async () => ({ data: { user: { ...state.account } } }) },
        files,
      }),
    },
  };
}

let fake;
test.beforeEach(() => {
  database.exec('DELETE FROM family_documents; DELETE FROM sync_config;');
  setCfg('google_access_token', 'calendar-access');
  setCfg('google_refresh_token', 'calendar-refresh');
  fake = createFake();
  driveStorage.__setGoogleApiFactoryForTests(fake.factory);
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
});

test.after(() => {
  driveStorage.__setGoogleApiFactoryForTests();
  database.close();
});

test('Drive OAuth falls back only when both Drive-specific credentials are absent', () => {
  const session = { googleOAuthState: 'calendar-state' };
  const url = driveStorage.getAuthUrl(session);
  assert.match(url, /^https:\/\/accounts\.example\.test\/auth/);
  assert.equal(session.googleOAuthState, 'calendar-state');
  assert.match(session.googleDriveOAuthState, /^[a-f0-9]{64}$/);
  assert.equal(fake.state.authOptions.access_type, 'offline');
  assert.equal(fake.state.authOptions.prompt, 'consent');
  assert.deepEqual(fake.state.authOptions.scope, ['https://www.googleapis.com/auth/drive.file']);
  assert.equal('include_granted_scopes' in fake.state.authOptions, false);
  assert.deepEqual(fake.state.clients[0].config, {
    clientId: 'calendar-client',
    clientSecret: 'calendar-secret',
    redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
  });
});

test('Drive OAuth uses the complete Drive-specific credential pair', () => {
  process.env.GOOGLE_DRIVE_CLIENT_ID = 'drive-client';
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'drive-secret';

  driveStorage.getAuthUrl({});

  assert.deepEqual(fake.state.clients[0].config, {
    clientId: 'drive-client',
    clientSecret: 'drive-secret',
    redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
  });
  assert.equal(driveStorage.getStatus().configured, true);
});

test('partial Drive-specific credentials fail closed in status and routes', async (t) => {
  setCfg('document_storage_google_drive_refresh_token', 'drive-refresh');
  setCfg('document_storage_google_drive_account_id', 'account-a');
  setCfg('document_storage_google_drive_folder_id', 'folder-a');
  const app = express();
  app.use((req, _res, next) => {
    req.authRole = 'admin';
    req.session = {};
    next();
  });
  app.use('/', driveStorageRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const message = 'GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET must both be set or both be empty.';

  for (const [clientId, clientSecret] of [
    ['drive-client', ''],
    ['', 'drive-secret'],
  ]) {
    process.env.GOOGLE_DRIVE_CLIENT_ID = clientId;
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = clientSecret;
    assert.throws(
      () => driveStorage.getAuthUrl({}),
      (error) => (
        error.storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
        && error.message === message
      )
    );
    assert.deepEqual(
      {
        configured: driveStorage.getStatus().configured,
        connected: driveStorage.getStatus().connected,
        last_error: driveStorage.getStatus().last_error,
      },
      { configured: false, connected: false, last_error: message }
    );

    for (const [method, pathname] of [
      ['GET', '/auth'],
      ['POST', '/test'],
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        redirect: 'manual',
      });
      assert.equal(response.status, 400, `${method} ${pathname}`);
      assert.deepEqual(await response.json(), {
        error: message,
        code: 400,
        storage_code: 'DOCUMENT_STORAGE_INVALID_CONFIG',
      });
    }
  }
});

test('callback validates the account, creates and reuses Yuvomi/Documents, and never selects Drive', async () => {
  const first = await driveStorage.handleCallback('code');
  assert.equal(first.connected, true);
  assert.equal(first.account_email, 'a@example.test');
  assert.equal(first.folder_name, 'Yuvomi/Documents');
  assert.equal(fake.state.foldersCreated, 2);
  assert.equal(cfg('document_storage_selected_backend'), null);
  assert.equal(cfg('google_access_token'), 'calendar-access');
  assert.equal(cfg('google_refresh_token'), 'calendar-refresh');
  assert.equal(cfg('document_storage_google_drive_refresh_token'), 'drive-refresh-a');

  fake.state.tokenResponse = {
    access_token: 'drive-access-b',
    refresh_token: 'drive-refresh-b',
    expiry_date: 2_000_000_100_000,
  };
  await driveStorage.handleCallback('second-code');
  assert.equal(fake.state.foldersCreated, 2);
  assert.equal(cfg('document_storage_google_drive_refresh_token'), 'drive-refresh-b');
});

test('callback requires a refresh token and preserves existing credentials on account mismatch', async () => {
  await driveStorage.handleCallback('first');
  const fileId = await driveStorage.uploadFile({
    buffer: Buffer.from('existing'),
    mime: 'text/plain',
    originalName: 'existing.txt',
  });
  database.prepare("INSERT INTO family_documents (storage_backend, storage_key) VALUES ('google_drive', ?)")
    .run(fileId);

  fake.state.account = { permissionId: 'account-b', emailAddress: 'b@example.test' };
  fake.state.tokenResponse = {
    access_token: 'replacement-access',
    refresh_token: 'replacement-refresh',
  };
  await assert.rejects(
    driveStorage.handleCallback('replacement'),
    (error) => error.storageCode === 'DOCUMENT_STORAGE_CONFIG_PROTECTED'
  );
  assert.equal(cfg('document_storage_google_drive_refresh_token'), 'drive-refresh-a');

  fake.state.tokenResponse = { access_token: 'no-refresh' };
  await assert.rejects(
    driveStorage.handleCallback('no-refresh'),
    (error) => error.storageCode === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
  );
  assert.equal(cfg('document_storage_google_drive_refresh_token'), 'drive-refresh-a');
});

test('upload, streaming read, token refresh, delete and missing delete are supported', async () => {
  await driveStorage.handleCallback('code');
  const id = await driveStorage.uploadFile({
    buffer: Buffer.from('Drive bytes'),
    mime: 'text/plain',
    originalName: '../unsafe.txt',
  });
  assert.match(id, /^file-/);
  const read = await driveStorage.readFile(id);
  assert.deepEqual(read.buffer, Buffer.from('Drive bytes'));
  assert.equal(read.mime, 'text/plain');

  await driveStorage.uploadFile({ buffer: Buffer.from('refresh'), originalName: 'refresh.bin' });
  const authorisedClient = fake.state.clients.at(-1);
  authorisedClient.listeners.get('tokens')?.({ access_token: 'refreshed', expiry_date: 12345 });
  assert.equal(cfg('document_storage_google_drive_access_token'), 'refreshed');
  assert.equal(cfg('document_storage_google_drive_token_expiry'), '12345');

  await driveStorage.deleteFile(id);
  assert.equal(fake.state.files.has(id), false);
  await driveStorage.deleteFile('already-missing');
});

test('read rejects metadata and streamed content above 5 MiB', async () => {
  await driveStorage.handleCallback('code');
  const folderId = cfg('document_storage_google_drive_folder_id');
  fake.state.files.set('too-large', {
    id: 'too-large',
    name: 'large.bin',
    parents: [folderId],
    mimeType: 'application/octet-stream',
    size: 5 * 1024 * 1024 + 1,
    content: Buffer.alloc(1),
  });
  await assert.rejects(
    driveStorage.readFile('too-large'),
    (error) => error.storageCode === 'DOCUMENT_STORAGE_READ_FAILED'
  );

  fake.state.files.set('stream-too-large', {
    id: 'stream-too-large',
    name: 'large-stream.bin',
    parents: [folderId],
    mimeType: 'application/octet-stream',
    size: null,
    content: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await assert.rejects(
    driveStorage.readFile('stream-too-large'),
    (error) => error.storageCode === 'DOCUMENT_STORAGE_READ_FAILED'
  );
});

test('connection test performs a verified roundtrip and cleans up', async () => {
  await driveStorage.handleCallback('code');
  const before = fake.state.files.size;
  assert.deepEqual(await driveStorage.testConnection(), { ok: true });
  assert.equal(fake.state.files.size, before);
  assert.match(cfg('document_storage_google_drive_last_test'), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(cfg('document_storage_google_drive_last_error'), null);
});

test('disconnect is blocked by selection or rows and clears only Drive keys when safe', async () => {
  await driveStorage.handleCallback('code');
  setCfg('document_storage_selected_backend', 'google_drive');
  assert.throws(
    () => driveStorage.disconnect(),
    (error) => error.storageCode === 'DOCUMENT_STORAGE_CONFIG_PROTECTED'
  );
  database.prepare('DELETE FROM sync_config WHERE key = ?').run('document_storage_selected_backend');
  database.prepare("INSERT INTO family_documents (storage_backend, storage_key) VALUES ('google_drive', 'x')").run();
  assert.throws(
    () => driveStorage.disconnect(),
    (error) => error.storageCode === 'DOCUMENT_STORAGE_CONFIG_PROTECTED'
  );
  database.prepare('DELETE FROM family_documents').run();
  driveStorage.disconnect();
  assert.equal(cfg('document_storage_google_drive_refresh_token'), null);
  assert.equal(cfg('google_refresh_token'), 'calendar-refresh');
});

test('disconnect never sweeps sibling document_storage_* keys', async () => {
  await driveStorage.handleCallback('code');
  // Selecting another backend is what lets disconnect proceed.
  setCfg('document_storage_selected_backend', 'webdav');
  setCfg('document_storage_webdav_url', 'https://dav.example.test/remote.php/dav');
  // Only matches the delete prefix if its underscores are read as LIKE
  // wildcards - the guard against the sweep widening past the literal prefix.
  setCfg('document_storage_google_driveX_wildcard_trap', 'must-survive');
  assert.notEqual(cfg('document_storage_google_drive_refresh_token'), null);

  driveStorage.disconnect();

  assert.equal(cfg('document_storage_google_drive_refresh_token'), null);
  assert.equal(cfg('document_storage_google_drive_account_id'), null);
  assert.equal(cfg('document_storage_selected_backend'), 'webdav');
  assert.equal(cfg('document_storage_webdav_url'), 'https://dav.example.test/remote.php/dav');
  assert.equal(cfg('document_storage_google_driveX_wildcard_trap'), 'must-survive');
});
