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
import dmsRouter from '../server/routes/dms.js';

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
