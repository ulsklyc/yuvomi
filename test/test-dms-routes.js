/**
 * Modul: DMS-Routen-Test
 * Zweck: Account-CRUD (admin-only), Suche und Link-Flow gegen einen gemockten Adapter.
 * Ausführen: node --test test/test-dms-routes.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';

process.env.DB_PATH = ':memory:';

const {
  MIGRATIONS,
  get,
  _resetTestDatabase,
  _setTestDatabase,
} = await import('../server/db.js');
const {
  default: dmsRouter,
  _setAdapterFactory,
} = await import('../server/routes/dms.js');
const {
  default: documentsRouter,
  _setDmsAdapterFactory,
} = await import('../server/routes/documents.js');

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);
const adminId = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', '$2b$12$x', 'admin')`).run().lastInsertRowid;
const memberId = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('bob', 'Bob', '$2b$12$x', 'member')`).run().lastInsertRowid;

let session = { userId: adminId, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = session.userId;
  req.authRole = session.role;
  req.session = { userId: session.userId, role: session.role };
  next();
});
app.use('/api/v1/documents/dms', dmsRouter);
app.use('/api/v1/documents', documentsRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/documents/dms`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('POST /accounts: Admin legt Account an, Token wird NICHT zurückgegeben', async () => {
  session = { userId: adminId, role: 'admin' };
  const res = await call('POST', '/accounts', {
    provider: 'paperless', name: 'Heim-DMS',
    base_url: 'https://dms.example.com', api_token: 'secret-token',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.name, 'Heim-DMS');
  assert.equal(res.body.data.has_token, true);
  assert.equal(res.body.data.api_token, undefined);
});

test('GET /accounts: listet ohne Token', async () => {
  const res = await call('GET', '/accounts');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].api_token, undefined);
});

test('POST /accounts: Member bekommt 403', async () => {
  session = { userId: memberId, role: 'member' };
  const res = await call('POST', '/accounts', {
    provider: 'paperless', name: 'X', base_url: 'https://y.example.com', api_token: 't',
  });
  assert.equal(res.status, 403);
});

test('GET /accounts: Member bekommt 403', async () => {
  session = { userId: memberId, role: 'member' };
  const res = await call('GET', '/accounts');
  assert.equal(res.status, 403);
  session = { userId: adminId, role: 'admin' };
});

test('DELETE /accounts/:id: Admin entfernt Account', async () => {
  session = { userId: adminId, role: 'admin' };
  const list = await call('GET', '/accounts');
  const res = await call('DELETE', `/accounts/${list.body.data[0].id}`);
  assert.equal(res.status, 204);
  const after = await call('GET', '/accounts');
  assert.equal(after.body.data.length, 0);
});

test('POST /accounts/:id/test: ok=true durchgereicht', async () => {
  session = { userId: adminId, role: 'admin' };
  const acc = (await call('POST', '/accounts', {
    provider: 'paperless', name: 'TestDMS', base_url: 'https://t.example.com', api_token: 'tok',
  })).body.data;
  _setAdapterFactory(() => ({ async testConnection() { return { ok: true, status: 200 }; } }));
  const res = await call('POST', `/accounts/${acc.id}/test`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.ok, true);
});

test('POST /accounts/:id/test: Member bekommt 403', async () => {
  session = { userId: adminId, role: 'admin' };
  const acc = (await call('GET', '/accounts')).body.data[0];
  session = { userId: memberId, role: 'member' };
  const res = await call('POST', `/accounts/${acc.id}/test`);
  assert.equal(res.status, 403);
  session = { userId: adminId, role: 'admin' };
});

test('GET /search: mappt Adapter-Treffer durch', async () => {
  session = { userId: adminId, role: 'admin' };
  _setAdapterFactory(() => ({
    async search(q) { return [{ id: '5', title: `T:${q}`, created: null, filename: 'f.pdf', url: 'https://t/d/5' }]; },
  }));
  const list = await call('GET', '/accounts');
  const accId = list.body.data[0].id;
  const res = await call('GET', `/search?account_id=${accId}&q=brief`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].title, 'T:brief');
});

test('GET /search: 400 ohne Query', async () => {
  session = { userId: adminId, role: 'admin' };
  const list = await call('GET', '/accounts');
  const res = await call('GET', `/search?account_id=${list.body.data[0].id}&q=`);
  assert.equal(res.status, 400);
});

test('GET /search: Member bekommt 403', async () => {
  session = { userId: adminId, role: 'admin' };
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  session = { userId: memberId, role: 'member' };
  const res = await call('GET', `/search?account_id=${accId}&q=brief`);
  assert.equal(res.status, 403);
  session = { userId: adminId, role: 'admin' };
});

test('POST /link: legt external-Referenz in family_documents an', async () => {
  session = { userId: adminId, role: 'admin' };
  _setAdapterFactory(() => ({
    async getDocument(id) {
      return { id, title: 'Stromrechnung', filename: 'strom.pdf', url: `https://t/d/${id}`, correspondent: 7, tags: [3] };
    },
  }));
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const res = await call('POST', '/link', {
    account_id: accId, dms_document_id: '42', category: 'finance', visibility: 'family',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.storage_provider, 'external');
  assert.equal(res.body.data.storage_backend, 'dms');
  assert.equal(res.body.data.storage_key, '42');
  assert.equal(res.body.data.name, 'Stromrechnung');

  const row = db.prepare('SELECT * FROM family_documents WHERE id = ?').get(res.body.data.id);
  assert.equal(row.content_data, '');
  assert.equal(row.storage_backend, 'dms');
  assert.equal(row.dms_account_id, accId);
  assert.equal(row.external_url, 'https://t/d/42');
});

test('POST /link: 409 wenn dasselbe DMS-Dokument schon verlinkt ist', async () => {
  session = { userId: adminId, role: 'admin' };
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const res = await call('POST', '/link', { account_id: accId, dms_document_id: '42' });
  assert.equal(res.status, 409);
});

test('POST /link: Member bekommt 403 und legt keinen Row an', async () => {
  session = { userId: adminId, role: 'admin' };
  const list = await call('GET', '/accounts');
  session = { userId: memberId, role: 'member' };
  const res = await call('POST', '/link', { account_id: list.body.data[0].id, dms_document_id: '99' });
  assert.equal(res.status, 403);
  const count = db.prepare('SELECT COUNT(*) AS n FROM family_documents WHERE storage_key = ?').get('99').n;
  assert.equal(count, 0);
  session = { userId: adminId, role: 'admin' };
});

test('GET /:id/preview: external-Dokument wird aus dem DMS geproxyt', async () => {
  session = { userId: adminId, role: 'admin' };
  // Link a fresh external doc via the dms /link route (needs getDocument), then proxy its content.
  _setAdapterFactory(() => ({
    async getDocument(id) { return { id, title: 'Proxy', filename: 'p.pdf', url: `https://t/d/${id}`, correspondent: null, tags: [] }; },
  }));
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const linked = (await call('POST', '/link', { account_id: accId, dms_document_id: '777' })).body.data;

  _setDmsAdapterFactory(() => ({
    async fetchContent() { return { buffer: Buffer.from('%PDF-1.4 proxied'), mime: 'application/pdf' }; },
  }));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/documents/${linked.id}/preview`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(await res.text(), '%PDF-1.4 proxied');
});

test('GET /:id/preview: charset im DMS-MIME wird normalisiert (PDF bleibt PDF)', async () => {
  session = { userId: adminId, role: 'admin' };
  _setAdapterFactory(() => ({
    async getDocument(id) { return { id, title: 'Charset', filename: 'c.pdf', url: `https://t/d/${id}`, correspondent: null, tags: [] }; },
  }));
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const linked = (await call('POST', '/link', { account_id: accId, dms_document_id: '778' })).body.data;
  _setDmsAdapterFactory(() => ({
    async fetchContent() { return { buffer: Buffer.from('%PDF'), mime: 'application/pdf; charset=binary' }; },
  }));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/documents/${linked.id}/preview`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

test('GET /:id/preview: nicht-vorschaufähiger DMS-MIME wird mit 415 abgelehnt', async () => {
  session = { userId: adminId, role: 'admin' };
  _setAdapterFactory(() => ({
    async getDocument(id) { return { id, title: 'Evil', filename: 'x.html', url: `https://t/d/${id}`, correspondent: null, tags: [] }; },
  }));
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const linked = (await call('POST', '/link', { account_id: accId, dms_document_id: '779' })).body.data;
  _setDmsAdapterFactory(() => ({
    async fetchContent() { return { buffer: Buffer.from('<script>alert(1)</script>'), mime: 'text/html' }; },
  }));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/documents/${linked.id}/preview`);
  assert.equal(res.status, 415);
});

test('POST /push: lädt lokales Dokument hoch, gibt taskId zurück', async () => {
  session = { userId: adminId, role: 'admin' };
  const content = Buffer.from('hello').toString('base64');
  const localId = db.prepare(`INSERT INTO family_documents
    (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES ('Brief', 'other', 'family', 'brief.pdf', 'application/pdf', 5, ?, ?)`)
    .run(content, adminId).lastInsertRowid;

  let uploaded = null;
  _setAdapterFactory(() => ({ async upload(args) { uploaded = args; return { taskId: 'task-1' }; } }));
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const res = await call('POST', '/push', { account_id: accId, document_id: localId });

  assert.equal(res.status, 202);
  assert.equal(res.body.data.taskId, 'task-1');
  assert.equal(uploaded.filename, 'brief.pdf');
  assert.equal(uploaded.buffer.toString(), 'hello');
});

test('POST /push: lädt WebDAV-Dokument auch bei deaktivierten neuen Uploads hoch', async (t) => {
  session = { userId: adminId, role: 'admin' };
  const remoteBytes = Buffer.from('remote dms push bytes');
  const webdav = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('alice:secret').toString('base64')}`);
    if (req.method === 'GET' && req.url === '/documents/archive/push.pdf') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': remoteBytes.length,
      });
      res.end(remoteBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => webdav.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    delete process.env.DOCUMENT_STORAGE_WEBDAV_ENABLED;
    delete process.env.DOCUMENT_STORAGE_WEBDAV_URL;
    delete process.env.DOCUMENT_STORAGE_WEBDAV_USERNAME;
    delete process.env.DOCUMENT_STORAGE_WEBDAV_PASSWORD;
    delete process.env.DOCUMENT_STORAGE_WEBDAV_PATH;
    if (webdav.listening) {
      await new Promise((resolve) => webdav.close(resolve));
    }
  });
  process.env.DOCUMENT_STORAGE_WEBDAV_ENABLED = '0';
  process.env.DOCUMENT_STORAGE_WEBDAV_URL =
    `http://127.0.0.1:${webdav.address().port}`;
  process.env.DOCUMENT_STORAGE_WEBDAV_USERNAME = 'alice';
  process.env.DOCUMENT_STORAGE_WEBDAV_PASSWORD = 'secret';
  process.env.DOCUMENT_STORAGE_WEBDAV_PATH = 'documents';

  const documentId = db.prepare(`
    INSERT INTO family_documents (
      name, category, visibility, original_name, mime_type, file_size,
      content_data, storage_provider, storage_backend, storage_key, created_by
    ) VALUES (
      'Remote brief', 'other', 'family', 'push.pdf', 'application/pdf', ?,
      '', 'external', 'webdav', 'archive/push.pdf', ?
    )
  `).run(remoteBytes.length, adminId).lastInsertRowid;

  let uploaded = null;
  _setAdapterFactory(() => ({
    async upload(args) {
      uploaded = args;
      return { taskId: 'task-webdav' };
    },
  }));
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const res = await call('POST', '/push', {
    account_id: accId,
    document_id: documentId,
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.data.taskId, 'task-webdav');
  assert.equal(uploaded.filename, 'push.pdf');
  assert.deepEqual(uploaded.buffer, remoteBytes);
});

test('POST /push: WebDAV-Lesefehler liefert stabilen Storage-Fehler ohne DMS-Upload', async (t) => {
  session = { userId: adminId, role: 'admin' };
  const webdav = http.createServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  await new Promise((resolve) => webdav.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    delete process.env.DOCUMENT_STORAGE_WEBDAV_ENABLED;
    delete process.env.DOCUMENT_STORAGE_WEBDAV_URL;
    delete process.env.DOCUMENT_STORAGE_WEBDAV_USERNAME;
    delete process.env.DOCUMENT_STORAGE_WEBDAV_PASSWORD;
    delete process.env.DOCUMENT_STORAGE_WEBDAV_PATH;
    if (webdav.listening) {
      await new Promise((resolve) => webdav.close(resolve));
    }
  });
  process.env.DOCUMENT_STORAGE_WEBDAV_ENABLED = '0';
  process.env.DOCUMENT_STORAGE_WEBDAV_URL =
    `http://127.0.0.1:${webdav.address().port}`;
  process.env.DOCUMENT_STORAGE_WEBDAV_USERNAME = 'alice';
  process.env.DOCUMENT_STORAGE_WEBDAV_PASSWORD = 'secret';
  process.env.DOCUMENT_STORAGE_WEBDAV_PATH = 'documents';

  const documentId = db.prepare(`
    INSERT INTO family_documents (
      name, category, visibility, original_name, mime_type, file_size,
      content_data, storage_provider, storage_backend, storage_key, created_by
    ) VALUES (
      'Unreadable remote brief', 'other', 'family', 'missing.pdf',
      'application/pdf', 0, '', 'external', 'webdav', 'missing.pdf', ?
    )
  `).run(adminId).lastInsertRowid;

  let uploadCalled = false;
  _setAdapterFactory(() => ({
    async upload() {
      uploadCalled = true;
      return { taskId: 'must-not-run' };
    },
  }));
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const res = await call('POST', '/push', {
    account_id: accId,
    document_id: documentId,
  });

  assert.equal(res.status, 502);
  assert.equal(res.body.code, 502);
  assert.equal(res.body.storage_code, 'DOCUMENT_STORAGE_READ_FAILED');
  assert.equal(uploadCalled, false);
});

test('POST /push: 400 für bereits im DMS gespeichertes Dokument', async () => {
  session = { userId: adminId, role: 'admin' };
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  const ext = db.prepare(`INSERT INTO family_documents
    (name, category, visibility, original_name, mime_type, file_size, content_data,
     storage_provider, storage_backend, storage_key, dms_account_id, created_by)
    VALUES ('X','other','family','x.pdf','application/pdf',0,'','external','dms','9',?,?)`)
    .run(accId, adminId).lastInsertRowid;
  assert.equal(
    db.prepare('SELECT storage_backend FROM family_documents WHERE id = ?').get(ext).storage_backend,
    'dms'
  );
  const res = await call('POST', '/push', { account_id: accId, document_id: ext });
  assert.equal(res.status, 400);
});

test('POST /push: Member bekommt 403', async () => {
  session = { userId: adminId, role: 'admin' };
  const content = Buffer.from('x').toString('base64');
  const localId = db.prepare(`INSERT INTO family_documents
    (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES ('M','other','family','m.pdf','application/pdf',1,?,?)`).run(content, adminId).lastInsertRowid;
  const accId = (await call('GET', '/accounts')).body.data[0].id;
  session = { userId: memberId, role: 'member' };
  const res = await call('POST', '/push', { account_id: accId, document_id: localId });
  assert.equal(res.status, 403);
  session = { userId: adminId, role: 'admin' };
});

test('DELETE account: verlinktes Dokument verliert dms_account_id (SET NULL) und Preview wird 404', async () => {
  session = { userId: adminId, role: 'admin' };
  // Eigener Account, damit andere Tests unberührt bleiben.
  const acc = (await call('POST', '/accounts', {
    provider: 'paperless', name: 'DelDMS', base_url: 'https://del.example.com', api_token: 'tok',
  })).body.data;
  _setAdapterFactory(() => ({
    async getDocument(id) { return { id, title: 'Wird verwaist', filename: 'orphan.pdf', url: `https://del/d/${id}`, correspondent: null, tags: [] }; },
  }));
  const linked = (await call('POST', '/link', { account_id: acc.id, dms_document_id: '4242' })).body.data;

  // Account löschen → FK ON DELETE SET NULL
  assert.equal((await call('DELETE', `/accounts/${acc.id}`)).status, 204);
  const row = db.prepare(`
    SELECT dms_account_id, storage_provider, storage_backend
    FROM family_documents
    WHERE id = ?
  `).get(linked.id);
  assert.equal(row.dms_account_id, null);
  assert.equal(row.storage_provider, 'external');
  assert.equal(row.storage_backend, 'dms');

  // Preview kann den Inhalt nicht mehr proxen → 404 statt Crash
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/documents/${linked.id}/preview`);
  assert.equal(res.status, 404);
});

// Server schließen, damit der offene Listener die Event-Loop nicht offen hält
// (sonst beendet sich `node --test` nie). Gleiches Muster wie in test-documents.js.
test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  db.close();
  _resetTestDatabase();
  get().close();
});
