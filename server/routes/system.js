/**
 * Module: System (operations)
 * Purpose: `GET /api/v1/system/diagnostics` - what this installation runs on,
 *          for an admin who has to describe it in a bug report or decide
 *          whether a backup is overdue (Phase 1b section F, the server part of
 *          F9). Admin only, never cached.
 *
 *          The field set is fixed. What it never carries: a key or any other
 *          secret, a path, a hostname, the value of an environment variable,
 *          anything about a member. `key_source` is where the database key
 *          comes from, not the key; `backup.local` and `backup.webdav` say
 *          whether a target is on, not where it is. test:system-diagnostics
 *          holds both lists.
 *
 *          Every read is on its own: one part that cannot be read does not
 *          take the rest with it. Such a value is `null` (`schema_version`: 0).
 *          Without a database connection the request does not get this far in
 *          the real app - the login and the restore gate answer first.
 * Dependencies: express, server/db.js, readiness, backup scheduler, modules
 */

// @ts-expect-error express 5 ships no type declarations (TS7016); new code type-checks clean
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import * as db from '../db.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { checkReadiness } from '../services/readiness.js';
import { getStatus as getBackupStatus } from '../services/backup-scheduler.js';
import { listModules } from '../services/modules.js';
import { secretOrigin } from '../utils/auto-secrets.js';
import { createLogger } from '../logger.js';

const log = createLogger('System');

const router = express.Router();

const { version: APP_VERSION } = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
);

// The same shape the service worker accepts for a revision (utils/service-worker.js):
// a commit hash or a tag, nothing that could carry a path or markup.
const SAFE_BUILD_REVISION = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The result of `read`, or `fallback` when it throws.
 * @template T, F
 * @param {() => T} read
 * @param {F} fallback
 * @returns {T | F}
 */
function orElse(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The size of a file in bytes; 0 when it does not exist, null when it cannot be read. */
function fileBytes(/** @type {string} */ file) {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    return /** @type {{ code?: string }} */ (err)?.code === 'ENOENT' ? 0 : null;
  }
}

/** What the database says about itself. Synchronous: nothing may wait between these reads. */
function databaseFacts() {
  const dbPath = db.getPath();
  const onDisk = dbPath !== ':memory:';
  return {
    sqliteVersion: orElse(() => /** @type {{ v: string }} */ (db.get().prepare('SELECT sqlite_version() AS v').get()).v, null),
    schemaVersion: db.currentVersion(),
    lastMigrationAt: orElse(
      () => /** @type {{ at: string } | undefined} */ (db.get()
        .prepare('SELECT applied_at AS at FROM schema_migrations ORDER BY version DESC LIMIT 1').get())?.at ?? null,
      null,
    ),
    databaseBytes: onDisk ? fileBytes(dbPath) : null,
    walBytes: onDisk ? fileBytes(`${dbPath}-wal`) : null,
    dataDir: onDisk ? path.dirname(path.resolve(dbPath)) : null,
  };
}

/** Free bytes for this user on the volume of the data directory, or null. */
async function freeBytes(/** @type {string | null} */ dir) {
  if (dir === null) return null;
  try {
    const stats = await fs.promises.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

router.get('/diagnostics', requireAdmin, async (/** @type {unknown} */ _req, /** @type {any} */ res) => {
  // Everything that reads the database first, in one go; the waits come after.
  const facts = databaseFacts();
  // A part that cannot be read becomes null in the answer, and a line in the
  // log: a broken backup block must not look like "no backup yet" for good.
  const backup = orElse(getBackupStatus, null);
  if (backup === null) log.warn('Diagnostics: the backup status could not be read.');
  const ready = await checkReadiness();
  const [dataDirFreeBytes, modules] = await Promise.all([
    freeBytes(facts.dataDir),
    listModules({ admin: true }).catch((err) => {
      log.warn('Diagnostics: the module list could not be read:', err);
      return null;
    }),
  ]);
  const revision = process.env.APP_BUILD_REVISION;
  const encrypted = Boolean(process.env.DB_ENCRYPTION_KEY);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    data: {
      version: APP_VERSION,
      build_revision: typeof revision === 'string' && SAFE_BUILD_REVISION.test(revision) ? revision : null,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sqlite: { version: facts.sqliteVersion, encrypted },
      schema_version: facts.schemaVersion,
      last_migration_at: facts.lastMigrationAt,
      database_bytes: facts.databaseBytes,
      wal_bytes: facts.walBytes,
      data_dir_free_bytes: dataDirFreeBytes,
      uptime_seconds: Math.floor(process.uptime()),
      backup: {
        last_attempt: backup?.lastBackup?.timestamp ?? null,
        last_success: backup?.lastSuccess ?? null,
        reason: backup?.lastError?.reason ?? null,
        next_run: backup?.nextRun ?? null,
        local: backup?.enabled ?? null,
        webdav: backup ? Boolean(backup.webdav.enabled && backup.webdav.configured) : null,
      },
      key_source: encrypted ? secretOrigin('DB_ENCRYPTION_KEY') : null,
      ready,
      modules_installed: modules ? modules.length : null,
    },
  });
});

export default router;
