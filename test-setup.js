import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'oikos-setup-test-'));

process.env.SESSION_SECRET = 'test-setup-secret-minimum-32-chars-x';
process.env.DB_PATH = join(tmpDir, 'test.db');
process.env.SESSION_SECURE = 'false';
process.env.PORT = '13099';

// Dynamic import so env vars are set before module initialization
const { default: app } = await import('./server/index.js');
await new Promise(r => setTimeout(r, 400));

const BASE = 'http://localhost:13099';

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
});

// Validation tests run first (DB is empty at this point)

test('POST /api/v1/auth/setup: 400 when required fields missing', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/v1/auth/setup: 400 when username invalid', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'a!b', display_name: 'Test', password: 'password123' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/v1/auth/setup: 400 when password too short', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', display_name: 'Test', password: 'short' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/v1/auth/setup: 201 creates first admin', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', display_name: 'Test Admin', password: 'password123' }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.user.username, 'admin');
  assert.equal(data.user.display_name, 'Test Admin');
  assert.equal(data.user.role, 'admin');
  assert.ok(typeof data.user.id === 'number');
});

test('POST /api/v1/auth/setup: 403 when users already exist', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin2', display_name: 'Another', password: 'password123' }),
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.code, 403);
});
