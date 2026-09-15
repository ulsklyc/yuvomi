/**
 * Test: Backup Scheduler
 * Purpose: Verify automated backup scheduling functionality
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Nested under a root we control, so one test can revoke write access on the
// parent and exercise the "backup directory is not writable" path (issue #579).
//
// EIN EIGENER ORDNER JE PROZESS, NICHT `./test-backups` IM CHECKOUT. Bis
// 2026-09-15 teilten sich zwei Laeufe im selben Checkout (zwei parallele
// Runner, ein Runner neben `npm test`) diesen Ordner: der eine loeschte ihn
// (Anfang, #579-Test, Aufraeumen) oder nahm ihm per chmod die Schreibrechte,
// waehrend der andere darin rotierte. Zwei Kopien gleichzeitig: in fuenf
// Runden neun von zehn Laeufen rot (ENOENT, falsche Dateizahl).
//
// Der Pfad bleibt trotzdem RELATIV zum Arbeitsverzeichnis. #579 prueft, dass
// die Fehlermeldung den absoluten Pfad nennt statt des konfigurierten
// relativen; mit einem absoluten BACKUP_DIR waere diese Zusicherung leer.
const TEST_BACKUP_ABSOLUTE = mkdtempSync(path.join(os.tmpdir(), 'yuvomi-backup-scheduler-'));
const TEST_BACKUP_ROOT = path.relative(process.cwd(), TEST_BACKUP_ABSOLUTE);
const TEST_BACKUP_DIR = path.join(TEST_BACKUP_ROOT, 'store');

// Auch wenn die Suite unterwegs abbricht - dann womoeglich mit entzogenen Schreibrechten.
process.on('exit', () => {
  try { chmodSync(TEST_BACKUP_ABSOLUTE, 0o700); } catch { /* schon weg */ }
  rmSync(TEST_BACKUP_ABSOLUTE, { recursive: true, force: true });
});

// Mock environment variables
process.env.BACKUP_ENABLED = 'false'; // Disable scheduler for tests
process.env.BACKUP_DIR = TEST_BACKUP_DIR;
process.env.BACKUP_KEEP = '3';

describe('Backup Scheduler', () => {
  let backupScheduler;

  it('should load the backup scheduler module', async () => {
    backupScheduler = await import('../server/services/backup-scheduler.js');
    assert.ok(backupScheduler.getStatus, 'getStatus function should exist');
    assert.ok(backupScheduler.triggerBackup, 'triggerBackup function should exist');
  });

  it('should report correct status when disabled', () => {
    const status = backupScheduler.getStatus();
    assert.strictEqual(status.enabled, false, 'Scheduler should be disabled');
    assert.strictEqual(status.schedule, '0 2 * * *', 'Default schedule should be set');
    assert.strictEqual(status.backupDir, TEST_BACKUP_DIR, 'Backup directory should match');
    assert.strictEqual(status.keepCount, 3, 'Keep count should be 3');
    assert.strictEqual(status.running, false, 'Scheduler should not be running');
  });

  it('should create backup directory if it does not exist', async () => {
    // Clean up any existing test directory
    try {
      await fs.rm(TEST_BACKUP_DIR, { recursive: true, force: true });
    } catch {}

    // Trigger a backup
    const result = await backupScheduler.triggerBackup();

    assert.ok(result, 'Trigger should return result');
    assert.ok(result.timestamp, 'Result should have timestamp');

    // Check if directory was created
    const dirExists = await fs.access(TEST_BACKUP_DIR).then(() => true).catch(() => false);
    assert.ok(dirExists, 'Backup directory should be created');
  });

  it('should create a backup file with timestamp', async () => {
    const beforeFiles = await fs.readdir(TEST_BACKUP_DIR).catch(() => []);

    await backupScheduler.triggerBackup();

    const afterFiles = await fs.readdir(TEST_BACKUP_DIR);
    const newFiles = afterFiles.filter(f => !beforeFiles.includes(f));

    assert.strictEqual(newFiles.length, 1, 'Should create exactly one new backup file');
    assert.ok(newFiles[0].startsWith('yuvomi-backup-'), 'Backup file should have correct prefix');
    assert.ok(newFiles[0].endsWith('.db'), 'Backup file should have .db extension');
  });

  it('should rotate old backups (keep only last N)', async () => {
    // Create 5 backups (more than BACKUP_KEEP=3)
    for (let i = 0; i < 5; i++) {
      await backupScheduler.triggerBackup();
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const files = await fs.readdir(TEST_BACKUP_DIR);
    const backupFiles = files.filter(f => f.startsWith('yuvomi-backup-') && f.endsWith('.db'));

    assert.strictEqual(backupFiles.length, 3, 'Should keep only last 3 backups');
  });

  it('should update lastBackup status after trigger', async () => {
    await backupScheduler.triggerBackup();

    const status = backupScheduler.getStatus();
    assert.ok(status.lastBackup, 'Should have lastBackup info');
    assert.ok(status.lastBackup.timestamp, 'Last backup should have timestamp');
    assert.strictEqual(status.lastBackup.success, true, 'Last backup should be successful');
    assert.ok(status.lastBackup.file, 'Last backup should have filename');
  });

  it('createLocalBackup() should create a fresh, uniquely named file each call', async () => {
    // Regression: the manual WebDAV "upload now" flow relies on this producing a
    // new, distinct snapshot every time so remote uploads never overwrite each other.
    assert.ok(backupScheduler.createLocalBackup, 'createLocalBackup function should exist');

    const first = await backupScheduler.createLocalBackup();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await backupScheduler.createLocalBackup();

    assert.ok(first.endsWith('.db'), 'first call returns a .db path');
    assert.ok(second.endsWith('.db'), 'second call returns a .db path');
    assert.notStrictEqual(
      path.basename(first),
      path.basename(second),
      'consecutive backups must have distinct filenames'
    );

    const existsSecond = await fs.access(second).then(() => true).catch(() => false);
    assert.ok(existsSecond, 'newest backup file should exist on disk');
  });

  it('should surface an actionable error when the backup directory is not writable', async (t) => {
    // Regression (issue #579): container deployments that left BACKUP_DIR unset fell
    // back to the relative default './backups' under /app, where the unprivileged
    // node user cannot create anything. The raw EACCES only named the relative path,
    // which sent people looking at their (correctly mounted) host folder.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('running as root bypasses directory permissions');
      return;
    }
    assert.equal(path.isAbsolute(TEST_BACKUP_DIR), false,
      'BACKUP_DIR must stay relative - with an absolute path the absolute-path assertion below checks nothing');

    await fs.rm(TEST_BACKUP_DIR, { recursive: true, force: true });
    await fs.chmod(TEST_BACKUP_ROOT, 0o500);

    try {
      const result = await backupScheduler.triggerBackup();

      assert.strictEqual(result.success, false, 'backup must fail on an unwritable directory');
      assert.match(
        result.error,
        new RegExp(path.resolve(TEST_BACKUP_DIR).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'error must name the absolute path, not the relative one'
      );
      assert.match(result.error, /BACKUP_DIR/, 'error must point at the BACKUP_DIR setting');
      assert.match(result.error, /EACCES|EPERM|EROFS/, 'error must keep the original errno');
    } finally {
      await fs.chmod(TEST_BACKUP_ROOT, 0o755);
    }
  });

  it('should cleanup test directory', async () => {
    await fs.rm(TEST_BACKUP_ROOT, { recursive: true, force: true });
  });
});
