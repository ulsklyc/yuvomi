/**
 * Test: Backup Scheduler
 * Purpose: Verify automated backup scheduling functionality
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installMiniDom, MiniElement } from './mini-dom.js';

register('./test-browser-loader.mjs', import.meta.url);
installMiniDom();
// mini-dom kennt kein classList; createInfoRow() haengt die Ton-Klasse damit
// an, nicht ueber className direkt.
Object.defineProperty(MiniElement.prototype, 'classList', {
  get() {
    const el = this;
    return {
      add: (...names) => { el.className = [el.className, ...names].filter(Boolean).join(' '); },
    };
  },
});
const { backupErrorRow } = await import('../public/settings/pages/admin-backup.js');

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

/**
 * Run `fn` and return what it logged at error level next to its result.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ result: T, log: string }>}
 */
async function withErrorLog(fn) {
  /** @type {string[]} */
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); };
  try {
    return { result: await fn(), log: logged.join('\n') };
  } finally {
    console.error = realError;
  }
}

describe('Backup Scheduler', () => {
  /** @type {any} the module; its status fields are nullable, the suite asserts on them directly */
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
    if (process.platform === 'win32') {
      t.skip('chmod on Windows only sets the read-only flag, the directory stays writable');
      return;
    }
    assert.equal(path.isAbsolute(TEST_BACKUP_DIR), false,
      'BACKUP_DIR must stay relative - with an absolute path the absolute-path assertion below checks nothing');

    await fs.rm(TEST_BACKUP_DIR, { recursive: true, force: true });
    await fs.chmod(TEST_BACKUP_ROOT, 0o500);

    try {
      const { result, log } = await withErrorLog(() => backupScheduler.triggerBackup());

      assert.strictEqual(result.success, false, 'backup must fail on an unwritable directory');
      // VERANKERT AN DEN ANFUEHRUNGSZEICHEN DER MELDUNG. Der relative BACKUP_DIR fuehrt
      // ueber `../..` bis zur Wurzel und ENDET im absoluten Temp-Pfad. Ein unverankerter
      // Treffer auf den absoluten Pfad fand ihn deshalb auch in einer Meldung, die den
      // RELATIVEN Wert nennt: `${BACKUP_DIR}` statt `${path.resolve(BACKUP_DIR)}` im
      // Server blieb gruen (Review auf #1229).
      // Since Phase 1b section F the text with the path goes to the LOG only.
      // What an admin reads over the API is a reason and a fixed sentence.
      const absolute = path.resolve(TEST_BACKUP_DIR);
      assert.ok(
        log.includes(`"${absolute}"`),
        `the log must name the absolute path in quotes: ${log}`
      );
      assert.ok(
        !log.includes(`"${TEST_BACKUP_DIR}"`),
        `the log must not name the relative path: ${log}`
      );
      assert.match(log, /BACKUP_DIR/, 'the log must point at the BACKUP_DIR setting');
      assert.match(log, /EACCES|EPERM|EROFS/, 'the log must keep the original errno');

      const status = backupScheduler.getStatus();
      assert.strictEqual(result.reason, 'backup_dir_not_writable');
      assert.strictEqual(status.lastError.reason, 'backup_dir_not_writable');
      assert.strictEqual(status.lastError.message, result.error, 'one sentence in both places');
      assert.match(result.error, /BACKUP_DIR/, 'the sentence still points at the BACKUP_DIR setting');
      for (const text of [result.error, status.lastError.message]) {
        assert.ok(!text.includes(absolute) && !text.includes(TEST_BACKUP_ABSOLUTE) && !text.includes(TEST_BACKUP_DIR),
          `no path in what the API shows: ${text}`);
        assert.doesNotMatch(text, /EACCES|EPERM|EROFS/, 'no errno in what the API shows');
      }
    } finally {
      await fs.chmod(TEST_BACKUP_ROOT, 0o755);
    }
  });

  it('a backup that fails the integrity check is discarded, older backups are kept (#2520)', async () => {
    // Die Backup-API kopiert die Seiten der Live-Datenbank, einen kaputten Index
    // also mit: der Eintrag in sqlite_master zeigt auf eine andere Spalte als
    // der Index-B-Baum, `integrity_check` meldet "row ... missing from index".
    // Vor #2520 ging diese Datei als gelungenes Backup durch und rotierte das
    // aelteste gute weg.
    const { get } = await import('../server/db.js');
    const live = get();
    await backupScheduler.triggerBackup();
    const before = (await fs.readdir(TEST_BACKUP_DIR)).sort();
    assert.ok(before.length > 0, 'a good backup must exist before the damaged one');

    live.exec('CREATE TABLE probe_2520 (x INTEGER, y INTEGER); CREATE INDEX probe_2520_x ON probe_2520 (x);');
    const insert = live.prepare('INSERT INTO probe_2520 VALUES (?, ?)');
    for (let i = 0; i < 20; i++) insert.run(i, 1000 - i);
    live.unsafeMode(true);
    live.pragma('writable_schema = ON');
    live.prepare("UPDATE sqlite_master SET sql = 'CREATE INDEX probe_2520_x ON probe_2520 (y)' WHERE name = 'probe_2520_x'").run();
    live.pragma('writable_schema = OFF');
    live.unsafeMode(false);

    try {
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await backupScheduler.triggerBackup();
        assert.strictEqual(result.success, false, 'a damaged backup must not count as a success');
        assert.match(result.error, /integrity check/);
      }
      const status = backupScheduler.getStatus();
      assert.ok(status.lastError, 'the failure must show in the scheduler status');
      assert.match(status.lastError.message, /integrity check/);
      assert.strictEqual(status.lastError.reason, 'backup_verify_failed');
      assert.doesNotMatch(status.lastError.message, /missing from index|probe_2520/,
        'the finding of the check stays in the log');
      assert.deepStrictEqual((await fs.readdir(TEST_BACKUP_DIR)).sort(), before,
        'no damaged file left behind, no good backup rotated away');
      await assert.rejects(backupScheduler.createLocalBackup(), { reason: 'backup_verify_failed' },
        'createLocalBackup (WebDAV "upload now") must refuse before anything is uploaded');
    } finally {
      live.exec('DROP INDEX probe_2520_x; DROP TABLE probe_2520;');
    }
    assert.strictEqual((await backupScheduler.triggerBackup()).success, true,
      'a repaired database backs up again');
  });

  it('should cleanup test directory', async () => {
    await fs.rm(TEST_BACKUP_ROOT, { recursive: true, force: true });
  });
});

describe('Backup status survives a restart', () => {
  // ── Phase 1b section F (E12): the status outlives the process ──────────────
  //
  // A restart is a fresh instance of the module on the same database: the query
  // string gives the import its own module record, with empty memory.
  let restarts = 0;
  const afterRestart = async () => import(`../server/services/backup-scheduler.js?restart=${++restarts}`);
  /** @type {any} the module; its status fields are nullable, the suite asserts on them directly */
  let backupScheduler;
  before(async () => { backupScheduler = await import('../server/services/backup-scheduler.js'); });

  /**
   * Make the next backup fail before anything is written.
   * @param {Error} error
   */
  async function failingBackup(error) {
    const realMkdir = fs.mkdir;
    fs.mkdir = async () => { throw error; };
    const realError = console.error;
    console.error = () => {};
    try {
      return await backupScheduler.triggerBackup();
    } finally {
      fs.mkdir = realMkdir;
      console.error = realError;
    }
  }

  it('the status of a successful run is there after a restart', async () => {
    const result = await backupScheduler.triggerBackup();
    assert.strictEqual(result.success, true);
    const earlier = backupScheduler.getStatus();
    assert.strictEqual(earlier.lastSuccess, earlier.lastBackup.timestamp);

    const status = (await afterRestart()).getStatus();
    assert.ok(status.lastBackup, 'after a restart the last backup is not "never"');
    assert.strictEqual(status.lastBackup.timestamp, earlier.lastBackup.timestamp);
    assert.strictEqual(status.lastBackup.success, true);
    assert.strictEqual(status.lastSuccess, earlier.lastSuccess);
    assert.strictEqual(status.lastError, null);
  });

  it('the status of a failed run is there after a restart, with the last success before it', async () => {
    const lastSuccess = backupScheduler.getStatus().lastSuccess;
    const result = await failingBackup(Object.assign(
      new Error("ENOSPC: no space left on device, mkdir '/srv/secret/backups'"), { code: 'ENOSPC' }));
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'disk_full');
    const earlier = backupScheduler.getStatus();

    const status = (await afterRestart()).getStatus();
    assert.strictEqual(status.lastBackup.success, false);
    assert.strictEqual(status.lastBackup.timestamp, earlier.lastBackup.timestamp);
    assert.deepStrictEqual(status.lastError, earlier.lastError);
    assert.strictEqual(status.lastError.reason, 'disk_full');
    assert.strictEqual(status.lastSuccess, lastSuccess, 'a failure does not move the last success');
    assert.ok(Date.parse(status.lastSuccess) <= Date.parse(status.lastError.timestamp));
  });

  it('a failure the scheduler cannot name is "unknown", and its text reaches neither the API nor the database', async () => {
    const result = await failingBackup(new Error("something broke at /srv/secret/backups on host nas.internal"));
    const status = backupScheduler.getStatus();
    assert.strictEqual(result.reason, 'unknown');
    assert.strictEqual(status.lastError.reason, 'unknown');
    for (const text of [result.error, status.lastError.message]) {
      assert.doesNotMatch(text, /secret|nas\.internal|something broke/);
    }
    const { get } = await import('../server/db.js');
    const stored = get().prepare("SELECT key, value FROM sync_config WHERE key LIKE 'backup\\_last\\_%' ESCAPE '\\' ORDER BY key").all();
    assert.deepStrictEqual(stored.map((/** @type {any} */ row) => row.key), ['backup_last_attempt', 'backup_last_reason', 'backup_last_success']);
    assert.doesNotMatch(JSON.stringify(stored), /secret|nas\.internal|something broke/);
    assert.strictEqual(stored.find((/** @type {any} */ row) => row.key === 'backup_last_reason').value, 'unknown');
  });

  it('the reason is a closed set: every reason has its sentence, and a stored value outside it reads as "unknown"', async () => {
    const reasons = {
      backup_dir_not_writable: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      disk_full: Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }),
      unknown: new Error('?'),
    };
    const sentences = new Set();
    for (const [reason, error] of Object.entries(reasons)) {
      const result = await failingBackup(error);
      assert.strictEqual(result.reason, reason);
      assert.ok(result.error.length > 20, `${reason} has a sentence`);
      sentences.add(result.error);
    }
    assert.strictEqual(sentences.size, 3, 'one sentence per reason');

    const { get } = await import('../server/db.js');
    get().prepare("UPDATE sync_config SET value = 'made_up_reason' WHERE key = 'backup_last_reason'").run();
    const status = (await afterRestart()).getStatus();
    assert.strictEqual(status.lastError.reason, 'unknown');
  });

  it('a fresh process whose first run fails keeps the last success from the database', async () => {
    assert.strictEqual((await backupScheduler.triggerBackup()).success, true);
    const lastSuccess = backupScheduler.getStatus().lastSuccess;
    // No status call before the run: the failure itself has to look the success up.
    const fresh = await afterRestart();
    const realMkdir = fs.mkdir;
    fs.mkdir = async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
    try {
      const { result } = await withErrorLog(() => fresh.triggerBackup());
      assert.strictEqual(result.success, false);
    } finally {
      fs.mkdir = realMkdir;
    }
    assert.strictEqual(fresh.getStatus().lastSuccess, lastSuccess);
    assert.strictEqual((await afterRestart()).getStatus().lastSuccess, lastSuccess, 'and it is still stored');
  });

  it('a backup directory that exists but refuses writes is "backup_dir_not_writable", not "unknown"', async (t) => {
    // The commonest container case: BACKUP_DIR is a mounted folder of another
    // user. mkdir succeeds on a directory that exists; the driver then fails
    // with SQLITE_CANTOPEN, which says nothing about why.
    if ((typeof process.getuid === 'function' && process.getuid() === 0) || process.platform === 'win32') {
      t.skip('needs directory permissions that hold for this user');
      return;
    }
    await fs.mkdir(TEST_BACKUP_DIR, { recursive: true });
    const before = (await fs.readdir(TEST_BACKUP_DIR)).sort();
    await fs.chmod(TEST_BACKUP_DIR, 0o500);
    try {
      const { result, log } = await withErrorLog(() => backupScheduler.triggerBackup());
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'backup_dir_not_writable');
      assert.match(log, /BACKUP_DIR/, 'the log points at the setting');
      assert.ok(log.includes(`"${path.resolve(TEST_BACKUP_DIR)}"`), 'the log names the absolute path');
    } finally {
      await fs.chmod(TEST_BACKUP_DIR, 0o700);
    }
    assert.deepStrictEqual((await fs.readdir(TEST_BACKUP_DIR)).sort(), before, 'nothing left behind');
  });

  it('the status names the next scheduled run while the schedule is on, and null without one', async () => {
    assert.strictEqual(backupScheduler.getStatus().nextRun, null, 'the suite runs with BACKUP_ENABLED=false');
    const env = { BACKUP_ENABLED: process.env.BACKUP_ENABLED, BACKUP_SCHEDULE: process.env.BACKUP_SCHEDULE };
    process.env.BACKUP_ENABLED = 'true';
    process.env.BACKUP_SCHEDULE = '0 3 * * *';
    // The schedule is read when the module loads: a fresh instance sees it.
    const fresh = await afterRestart();
    try {
      fresh.startScheduler();
      const { nextRun } = fresh.getStatus();
      assert.match(nextRun, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const ahead = Date.parse(nextRun) - Date.now();
      assert.ok(ahead > 0 && ahead <= 24 * 60 * 60 * 1000, `a daily schedule fires within a day, got ${nextRun}`);
    } finally {
      fresh.stopScheduler();
      for (const [name, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert.strictEqual(fresh.getStatus().nextRun, null, 'stopped: no next run');
  });

  it('a success after a failure clears the reason, also after a restart', async () => {
    assert.strictEqual((await backupScheduler.triggerBackup()).success, true);
    assert.strictEqual(backupScheduler.getStatus().lastError, null);
    const status = (await afterRestart()).getStatus();
    assert.strictEqual(status.lastError, null);
    assert.strictEqual(status.lastBackup.success, true);
  });
});

// Gegen die echte Karte unter test/mini-dom.js statt gegen den Quelltext
// (#2525): backupErrorRow() ist die Funktion, die loadBackupSchedulerStatus()
// hinter api.get() aufruft, exportiert und von createInfoRow aus baut, mit
// demselben document.createElement, das mini-dom stubbt.
describe('Backup-Karte: der Grund des letzten Fehlschlags (#2525)', () => {
  it('je Grund steht der uebersetzte Satz, als Fehler ausgezeichnet', () => {
    const faelle = {
      backup_dir_not_writable: 'settings.backupSchedulerReasonDirNotWritable',
      disk_full: 'settings.backupSchedulerReasonDiskFull',
      backup_verify_failed: 'settings.backupSchedulerReasonVerifyFailed',
      unknown: 'settings.backupSchedulerReasonUnknown',
    };
    for (const [reason, key] of Object.entries(faelle)) {
      const row = backupErrorRow({ timestamp: '2026-01-01T00:00:00Z', reason, message: 'raw system text' });
      assert.ok(row, reason);
      const [labelEl, valueEl] = row.childNodes;
      assert.equal(labelEl.textContent, 'settings.backupSchedulerLastError', reason);
      // lastError.reason waehlt den uebersetzten Satz (#1909: nie der rohe
      // lastError.message-Text des Systemfehlers, der bleibt im Server-Log).
      assert.equal(valueEl.textContent, key, `${reason} muss auf ${key} zeigen, nicht auf den rohen message-Text`);
      assert.match(valueEl.className, /settings-info-value--danger/, reason);
    }
  });

  it('ein Grund ausserhalb der vier bekannten faellt auf den Allgemeinsatz zurueck', () => {
    const row = backupErrorRow({ timestamp: '2026-01-01T00:00:00Z', reason: 'etwas-neues', message: 'x' });
    assert.equal(row.childNodes[1].textContent, 'common.errorGeneric');
  });

  it('ein erfolgreicher Lauf setzt lastError auf null - die Zeile verschwindet von selbst', () => {
    assert.equal(backupErrorRow(null), null);
  });
});
