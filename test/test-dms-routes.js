/**
 * Modul: DMS-Routen-Test
 * Zweck: Account-CRUD (admin-only), Suche und Link-Flow gegen einen gemockten Adapter.
 * Ausführen: node --test test/test-dms-routes.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { MIGRATIONS, _setTestDatabase } from '../server/db.js';
import dmsRouter, { _setAdapterFactory } from '../server/routes/dms.js';

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
app.use((req, _res, next) => { req.session = session; next(); });
app.use('/api/v1/documents/dms', dmsRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
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
  assert.equal(res.body.data.storage_key, '42');
  assert.equal(res.body.data.name, 'Stromrechnung');

  const row = db.prepare('SELECT * FROM family_documents WHERE id = ?').get(res.body.data.id);
  assert.equal(row.content_data, '');
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
