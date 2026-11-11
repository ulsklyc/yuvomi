/**
 * Test suite: the diagnostics endpoint `GET /api/v1/system/diagnostics`
 * (Phase 1b section F, the server part of F9).
 *
 * One answer for an admin who has to say what this installation runs on:
 * version, runtime, schema, sizes, the status of the last backup, readiness.
 * The field set is fixed, and so is what it must never carry: a key, a path, a
 * hostname, the value of an environment variable, anything about a member.
 *
 * Two servers, one database: the real app (server/index.js as a program) shows
 * that the path sits behind the login, and the router on a small app with a
 * stub identity shows what an admin, a member and a signed-in device get.
 *
 * Run: npm run test:system-diagnostics
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error express 5 ships no type declarations (TS7016); new code type-checks clean
import express from 'express';
import { startTestServer } from './server-ready.js';
import { tempDir } from './tmp-dir.js';

const dataDir = tempDir('yuvomi-test-diagnostics-data-');
const backupDir = tempDir('yuvomi-test-diagnostics-backups-');
const SECRETS = {
  SESSION_SECRET: 'diagnostics-sentinel-session-secret-0123456789',
  DB_ENCRYPTION_KEY: 'diagnostics-sentinel-database-key-0123456789',
  SMTP_PASS: 'diagnostics-sentinel-smtp-password',
  WEBDAV_BACKUP_PASSWORD: 'diagnostics-sentinel-webdav-password',
};
const { baseUrl: REAL } = await startTestServer({
  name: 'system-diagnostics',
  env: {
    ...SECRETS,
    DB_PATH: join(dataDir, 'diagnostics.db'),
    BACKUP_DIR: backupDir,
    APP_BUILD_REVISION: 'rev-abc123',
  },
});
const dbmod = await import('../server/db.js');
const { default: systemRouter } = await import('../server/routes/system.js');
const scheduler = await import('../server/services/backup-scheduler.js');

/** @type {{ role: string, deviceId: number | null }} */
let identity = { role: 'admin', deviceId: null };
const app = express();
app.use((/** @type {object} */ req, /** @type {unknown} */ _res, /** @type {() => void} */ next) => {
  Object.assign(req, { authUserId: 1, authRole: identity.role, session: { userId: 1 } });
  if (identity.deviceId !== null) Object.assign(req, { authDeviceId: identity.deviceId });
  next();
});
app.use('/api/v1/system', systemRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }));
const STUB = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

/**
 * @param {{ role: string, deviceId?: number | null }} as
 */
async function diagnostics(as) {
  identity = { role: as.role, deviceId: as.deviceId ?? null };
  const res = await fetch(`${STUB}/api/v1/system/diagnostics`);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) };
}

const ADMIN = { role: 'admin' };

const FIELDS = [
  'arch', 'backup', 'build_revision', 'data_dir_free_bytes', 'database_bytes', 'key_source',
  'last_migration_at', 'modules_installed', 'node', 'platform', 'ready', 'schema_version',
  'sqlite', 'uptime_seconds', 'version', 'wal_bytes',
];
const BACKUP_FIELDS = ['last_attempt', 'last_success', 'local', 'next_run', 'reason', 'webdav'];

test('the path sits behind the login: without a credential the real app answers 401', async () => {
  const res = await fetch(`${REAL}/api/v1/system/diagnostics`);
  assert.equal(res.status, 401);
  assert.doesNotMatch(await res.text(), /schema_version|uptime_seconds/);
});

test('an admin gets exactly the field set, not cached', async () => {
  const res = await diagnostics(ADMIN);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(res.body).sort(), ['data']);
  const d = res.body.data;
  assert.deepEqual(Object.keys(d).sort(), FIELDS);
  assert.deepEqual(Object.keys(d.sqlite).sort(), ['encrypted', 'version']);
  assert.deepEqual(Object.keys(d.backup).sort(), BACKUP_FIELDS);
  assert.deepEqual(Object.keys(d.ready).sort(), ['status']);
});

test('the values are those of this process and this database', async () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const d = (await diagnostics(ADMIN)).body.data;
  assert.equal(d.version, version);
  assert.equal(d.build_revision, 'rev-abc123');
  assert.equal(d.node, process.version);
  assert.equal(d.platform, process.platform);
  assert.equal(d.arch, process.arch);
  assert.match(d.sqlite.version, /^\d+\.\d+\.\d+/);
  assert.equal(d.sqlite.encrypted, true, 'the suite runs with DB_ENCRYPTION_KEY');
  assert.equal(d.schema_version, dbmod.currentVersion());
  assert.ok(d.schema_version > 0);
  assert.match(d.last_migration_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Number.isInteger(d.database_bytes) && d.database_bytes > 0);
  assert.ok(Number.isInteger(d.wal_bytes) && d.wal_bytes >= 0);
  assert.ok(Number.isInteger(d.data_dir_free_bytes) && d.data_dir_free_bytes > 0);
  assert.ok(Number.isInteger(d.uptime_seconds) && d.uptime_seconds >= 0);
  assert.ok(Number.isInteger(d.modules_installed) && d.modules_installed >= 0);
  // The secrets handshake does not run in a test process: the origin is unknown.
  assert.ok(d.key_source === null || ['env', 'file', 'stored', 'generated'].includes(d.key_source));
  assert.deepEqual(d.ready, { status: 'ready' });
});

test('backup: never before the first run, then the last run and its success', async () => {
  const before = (await diagnostics(ADMIN)).body.data.backup;
  // The suite runs with BACKUP_ENABLED=false: no schedule, so no next run.
  assert.deepEqual(before, {
    last_attempt: null, last_success: null, reason: null, next_run: null, local: false, webdav: false,
  });

  assert.equal((await scheduler.triggerBackup())?.success, true);
  const status = scheduler.getStatus();
  const after = (await diagnostics(ADMIN)).body.data.backup;
  assert.equal(after.last_attempt, status.lastBackup?.timestamp);
  assert.equal(after.last_success, status.lastSuccess);
  assert.equal(after.reason, null);
});

test('a member gets 403 and none of the fields', async () => {
  const res = await diagnostics({ role: 'member' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Permission denied.', code: 403 });
});

test('a signed-in device gets 403 with its reason, also when its person is an admin elsewhere', async () => {
  const res = await diagnostics({ role: 'member', deviceId: 7 });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'device_credential');
  assert.doesNotMatch(res.text, /schema_version|uptime_seconds/);
});

test('negative list: no key, no path, no hostname, no environment value', async () => {
  const { text } = await diagnostics(ADMIN);
  const dbPath = dbmod.getPath();
  const never = {
    'the database path': dbPath,
    'the data directory': dirname(dbPath),
    'the backup directory': backupDir,
    'the temp directory': os.tmpdir(),
    'the home directory': os.homedir(),
    'the working directory': process.cwd(),
    'the hostname': os.hostname(),
    ...Object.fromEntries(Object.entries(SECRETS).map(([name, value]) => [`the value of ${name}`, value])),
  };
  for (const [what, value] of Object.entries(never)) {
    assert.ok(value.length >= 3, `precondition: ${what} is long enough to look for`);
    assert.ok(!text.includes(value), `the answer carries ${what}`);
  }
  // Every environment value long enough not to collide with a version or a
  // platform name. A new field that passes one through is red here.
  const leaked = Object.entries(process.env)
    .filter(([, value]) => typeof value === 'string' && value.length >= 12 && text.includes(value))
    .map(([name]) => name);
  assert.deepEqual(leaked, [], 'environment variables whose value is in the answer');
  assert.doesNotMatch(text, /[A-Za-z]:\\|\/(?:home|Users|var|tmp|data|app|private)\//, 'nothing that looks like a path');
  assert.doesNotMatch(text, /password|secret|token|cookie|username|email/i, 'no field about credentials or members');
});

test('a build revision that is not a plain identifier is not passed on', async () => {
  const real = process.env.APP_BUILD_REVISION;
  process.env.APP_BUILD_REVISION = '../../etc/passwd <script>';
  try {
    assert.equal((await diagnostics(ADMIN)).body.data.build_revision, null);
  } finally {
    if (real === undefined) delete process.env.APP_BUILD_REVISION;
    else process.env.APP_BUILD_REVISION = real;
  }
});

test('without a database connection the answer still comes, and says not ready', async () => {
  dbmod._setTestDatabase(null);
  let res;
  try {
    res = await diagnostics(ADMIN);
  } finally {
    dbmod._resetTestDatabase();
  }
  assert.equal(res.status, 200);
  const d = res.body.data;
  assert.deepEqual(Object.keys(d).sort(), FIELDS);
  assert.deepEqual(d.ready, { status: 'not_ready', reason: 'database_closed' });
  assert.equal(d.schema_version, 0);
  assert.equal(d.last_migration_at, null);
  assert.equal(d.sqlite.version, null);
  assert.equal(d.version.length > 0, true, 'what does not need the database is still there');
});
