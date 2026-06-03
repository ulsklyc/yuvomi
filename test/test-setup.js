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
const { default: app } = await import('../server/index.js');
await new Promise(r => setTimeout(r, 400));

const BASE = 'http://localhost:13099';

function cookieHeader(setCookie) {
  return String(setCookie || '')
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

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

test('POST /api/v1/auth/setup: 400 when display_name too long', async () => {
  const res = await fetch(`${BASE}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', display_name: 'x'.repeat(129), password: 'password123' }),
  });
  assert.equal(res.status, 400);
});

test('GET /api/v1/version: setup_required is true when no users exist', async () => {
  const res = await fetch(`${BASE}/api/v1/version`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.setup_required, true);
  assert.equal(data.version, undefined);
});

test('GET /openapi.json: 401 without authentication', async () => {
  const res = await fetch(`${BASE}/openapi.json`);
  assert.equal(res.status, 401);
});

test('GET /api/v1/openapi.json: 401 without authentication', async () => {
  const res = await fetch(`${BASE}/api/v1/openapi.json`);
  assert.equal(res.status, 401);
});

test('GET /docs: 401 without authentication in development', async () => {
  const res = await fetch(`${BASE}/docs`, { redirect: 'manual' });
  assert.equal(res.status, 401);
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
  assert.ok(typeof data.user.avatar_color === 'string' && data.user.avatar_color.startsWith('#'));
});

test('GET /api/v1/version: setup_required is false after admin exists', async () => {
  const res = await fetch(`${BASE}/api/v1/version`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.setup_required, false);
  assert.equal(data.version, undefined);
});

test('GET /api/v1/version: includes version for authenticated session', async () => {
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password123' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie?.includes('oikos.sid='));

  const res = await fetch(`${BASE}/api/v1/version`, {
    headers: { Cookie: cookieHeader(cookie) },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(typeof data.version, 'string');
  assert.equal(data.setup_required, false);
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
