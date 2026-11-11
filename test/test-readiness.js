/**
 * Test suite: the readiness endpoint `GET /readyz` (Phase 1b section F, E11).
 *
 * `/health` says "the process answers" and stays 200 during a restore, so
 * Docker does not restart the container in the middle of one. `/readyz` says
 * "this instance can serve": 200 `{ status: 'ready' }`, otherwise 503
 * `{ status: 'not_ready', reason }` with one of four reasons. The suite runs
 * the real app (server/index.js as a program) and puts it into each state:
 *
 *   - a restore held where the connection is closed,
 *   - the connection closed without a restore (what a failed restore leaves),
 *   - an applied schema below the one this build knows,
 *   - a data directory the process may not write to.
 *
 * The answer carries nothing else: no version, no path, no timestamp. The
 * endpoint is unauthenticated, so every extra field is a field for everyone.
 *
 * Run: npm run test:readiness
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startTestServer } from './server-ready.js';
import { tempDir } from './tmp-dir.js';

// A directory of its own: the read-only case changes the mode of the data
// directory, and the shared tmpdir belongs to every suite running next to this one.
const dataDir = tempDir('yuvomi-test-readiness-');
const { baseUrl: BASE } = await startTestServer({
  name: 'readiness',
  env: {
    SESSION_SECRET: 'test-readiness-secret-min-32-chars-long',
    DB_PATH: join(dataDir, 'readiness.db'),
  },
});
const dbmod = await import('../server/db.js');

/**
 * @param {string} path
 * @param {Record<string, string>} [headers]
 */
async function probe(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON: the caller asserts on `body` */ }
  return { status: res.status, body, headers: res.headers };
}

/**
 * Start a restore and hold it where the connection is closed (while the
 * rollback copy is written) - as in test/test-restore-gate-routes.js.
 */
async function restoreHeldWithDatabaseClosed() {
  const backupPath = join(tempDir('yuvomi-test-readiness-backup-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  const holdAt = dbmod.getPath();
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  /** @type {(value?: unknown) => void} */
  let reached = () => {};
  const copying = new Promise((resolve) => { reached = resolve; });
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === holdAt) {
      reached();
      await gate;
    }
    return realCopyFile(src, dest, mode);
  };
  const done = dbmod.restoreFromFile(backupPath).finally(() => { fsp.copyFile = realCopyFile; });
  await copying;
  assert.equal(dbmod.isRestoreRunning(), true, 'precondition: the restore is running');
  assert.equal(dbmod.isDatabaseOpen(), false, 'precondition: the connection is closed');
  return { release, done };
}

test('ready: 200 with exactly { status: "ready" }, not cached', async () => {
  const res = await probe('/readyz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ready' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('ready: a browser navigation gets the JSON too, /readyz is no client route', async () => {
  const res = await probe('/readyz', { Accept: 'text/html,application/xhtml+xml' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ready' });
});

test('ready: needs no session and no token', async () => {
  const res = await probe('/readyz', { Authorization: 'Bearer not-a-token' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ready' });
});

test('restore running: 503 restore_in_progress, /health answers 200 at the same time', async () => {
  const restore = await restoreHeldWithDatabaseClosed();
  let ready;
  let health;
  try {
    ready = await probe('/readyz');
    health = await probe('/health');
  } finally {
    restore.release();
    await restore.done;
  }
  assert.equal(ready.status, 503);
  assert.deepEqual(ready.body, { status: 'not_ready', reason: 'restore_in_progress' });
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.equal(health.status, 200, '/health stays 200 during a restore');
  assert.equal(health.body.status, 'ok');
  assert.deepEqual(Object.keys(health.body).sort(), ['status', 'timestamp'], '/health keeps its two fields');

  const after = await probe('/readyz');
  assert.equal(after.status, 200, 'ready again once the restore is through');
  assert.deepEqual(after.body, { status: 'ready' });
});

test('database closed without a restore: 503 database_closed', async () => {
  dbmod._setTestDatabase(null);
  let res;
  try {
    assert.equal(dbmod.isDatabaseOpen(), false, 'precondition: the connection is closed');
    assert.equal(dbmod.isRestoreRunning(), false, 'precondition: no restore is running');
    res = await probe('/readyz');
  } finally {
    dbmod._resetTestDatabase();
  }
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { status: 'not_ready', reason: 'database_closed' });
});

test('applied schema below the known one: 503 schema_behind', async () => {
  const database = dbmod.get();
  const top = database.prepare('SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  const columns = Object.keys(top);
  database.prepare('DELETE FROM schema_migrations WHERE version = ?').run(top.version);
  let res;
  try {
    res = await probe('/readyz');
  } finally {
    database
      .prepare(`INSERT INTO schema_migrations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((column) => top[column]));
  }
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { status: 'not_ready', reason: 'schema_behind' });
  assert.equal((await probe('/readyz')).status, 200, 'ready again with the row back');
});

test('data directory not writable: 503 data_dir_not_writable', { skip: process.getuid?.() === 0 ? 'root may write everywhere' : false }, async () => {
  const dir = dirname(dbmod.getPath());
  assert.equal(dir, dataDir, 'precondition: the suite owns the data directory');
  const mode = fs.statSync(dir).mode & 0o777;
  fs.chmodSync(dir, 0o555);
  let res;
  try {
    res = await probe('/readyz');
  } finally {
    fs.chmodSync(dir, mode);
  }
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { status: 'not_ready', reason: 'data_dir_not_writable' });
  assert.equal((await probe('/readyz')).status, 200, 'ready again once the directory is writable');
});

test('no state leaks a path, a version or a timestamp', async () => {
  const dir = dirname(dbmod.getPath());
  dbmod._setTestDatabase(null);
  let res;
  try {
    res = await fetch(`${BASE}/readyz`);
  } finally {
    dbmod._resetTestDatabase();
  }
  const text = await res.text();
  assert.ok(!text.includes(dir), 'no directory in the answer');
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}|\d+\.\d+\.\d+|version|path/i);
});

test('HEAD answers with the same status and no body', async () => {
  const res = await fetch(`${BASE}/readyz`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(await res.text(), '');
});
