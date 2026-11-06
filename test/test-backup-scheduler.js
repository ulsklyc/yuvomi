/**
 * Test: Backup Scheduler
 * Purpose: Verify automated backup scheduling functionality
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { withoutCommentsKeepingLines } from './source-text.js';
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
    // Ein erfolgreicher Lauf LOESCHT den letzten Fehler: sonst zeigte die
    // Backup-Karte den Grund eines Fehlschlags weiter, obwohl seither ein
    // Backup gelaufen ist (#2525).
    assert.strictEqual(status.lastError, null, 'a successful run clears lastError');
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
    if (process.platform === 'win32') {
      t.skip('chmod on Windows only sets the read-only flag, the directory stays writable');
      return;
    }
    assert.equal(path.isAbsolute(TEST_BACKUP_DIR), false,
      'BACKUP_DIR must stay relative - with an absolute path the absolute-path assertion below checks nothing');

    await fs.rm(TEST_BACKUP_DIR, { recursive: true, force: true });
    await fs.chmod(TEST_BACKUP_ROOT, 0o500);

    try {
      const result = await backupScheduler.triggerBackup();

      assert.strictEqual(result.success, false, 'backup must fail on an unwritable directory');
      // VERANKERT AN DEN ANFUEHRUNGSZEICHEN DER MELDUNG. Der relative BACKUP_DIR fuehrt
      // ueber `../..` bis zur Wurzel und ENDET im absoluten Temp-Pfad. Ein unverankerter
      // Treffer auf den absoluten Pfad fand ihn deshalb auch in einer Meldung, die den
      // RELATIVEN Wert nennt: `${BACKUP_DIR}` statt `${path.resolve(BACKUP_DIR)}` im
      // Server blieb gruen (Review auf #1229).
      const absolute = path.resolve(TEST_BACKUP_DIR);
      assert.ok(
        result.error.includes(`"${absolute}"`),
        `error must name the absolute path in quotes: ${result.error}`
      );
      assert.ok(
        !result.error.includes(`"${TEST_BACKUP_DIR}"`),
        `error must not name the relative path: ${result.error}`
      );
      assert.match(result.error, /BACKUP_DIR/, 'error must point at the BACKUP_DIR setting');
      assert.match(result.error, /EACCES|EPERM|EROFS/, 'error must keep the original errno');

      // DER GRUND MUSS AUS DEM STATUS ZU LESEN SEIN (#2525). `lastBackup`
      // sagt nur "fehlgeschlagen" samt Zeitpunkt; was zu tun ist - volle
      // Platte, unschreibbares BACKUP_DIR - steht allein in `lastError`.
      const status = backupScheduler.getStatus();
      assert.ok(status.lastError, 'a failed run must leave lastError in getStatus()');
      assert.ok(status.lastError.timestamp, 'lastError carries the time of the failure');
      assert.strictEqual(status.lastError.message, result.error,
        'lastError.message is the same sentence the failed run reported');
    } finally {
      await fs.chmod(TEST_BACKUP_ROOT, 0o755);
    }
  });

  it('should cleanup test directory', async () => {
    await fs.rm(TEST_BACKUP_ROOT, { recursive: true, force: true });
  });
});

// WARUM EIN QUELLTEXT-GUARD UND KEIN DOM-TEST: der Fehler, den #2525 meldet,
// war genau diese Luecke - der Scheduler fuehrte `lastError` mit, die Route
// gab ihn mit heraus, und die Karte las ihn nie. Ein Test, der nur den Status
// prueft, bleibt dabei gruen. Die Zeile laeuft in `load()` hinter `api.get()`,
// also liest der Guard die Quelle, mit Kommentaren heraus (ein Kommentar, der
// den Schluessel nennt, darf nicht als Umsetzung zaehlen).
describe('Backup-Karte: der Grund des letzten Fehlschlags (#2525)', () => {
  const source = withoutCommentsKeepingLines(
    readFileSync(new URL('../public/settings/pages/admin-backup.js', import.meta.url), 'utf8')
  );

  it('liest lastError aus dem Scheduler-Status und zeichnet ihn als Fehler aus', () => {
    // lastError direkt entnommen (kein Alias-Rename mehr):
    assert.match(source, /\{[^{}]*\blastError\b[^{}]*\}\s*=\s*scheduler/,
      'admin-backup.js muss lastError aus dem Scheduler-Status lesen');

    // createInfoRow mit Label settings.backupSchedulerLastError AND tone 'danger':
    // beide muessen im selben Aufruf stehen, damit das Entfernen einer der beiden
    // Zeilen den Guard rot macht.
    const aufruf = source
      .split(/(?=createInfoRow)/)
      .find((s) => s.includes('settings.backupSchedulerLastError'));
    assert.ok(aufruf, 'kein createInfoRow mit dem Label settings.backupSchedulerLastError');
    assert.match(aufruf, /tone:\s*'danger'/, 'der Grund eines Fehlschlags ist als Fehler ausgezeichnet');

    // Die rohe Nachricht muss als technisches Detail erscheinen (lastError.message):
    assert.match(source, /lastError\s*\.\s*message/, 'lastError.message erscheint als technisches Detail');
  });

  it('jede Locale kennt das Label und den uebersetzten Grund', () => {
    const dir = new URL('../public/locales/', import.meta.url);
    const fehltLabel = [];
    const fehltGrund = [];
    for (const file of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const json = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
      if (!json.settings?.backupSchedulerLastError) fehltLabel.push(file);
      if (!json.settings?.backupSchedulerReasonDirNotWritable) fehltGrund.push(file);
    }
    assert.deepEqual(fehltLabel, [], `backupSchedulerLastError fehlt in: ${fehltLabel.join(', ')}`);
    assert.deepEqual(fehltGrund, [], `backupSchedulerReasonDirNotWritable fehlt in: ${fehltGrund.join(', ')}`);
  });
});
