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
    } finally {
      await fs.chmod(TEST_BACKUP_ROOT, 0o755);
    }
  });

  // --------------------------------------------------------
  // #2519: ein gescheiterter Lauf meldet sich bei den Admins
  // --------------------------------------------------------

  /**
   * Eine Datenbank mit genau den Tabellen, die `householdMemberSql()` befragt:
   * `deactivated_at` fuer "aktiv" (NICHT `is_active`), und die drei Tabellen
   * der Ausnahmen - Hauspersonal, Gaeste, Wandtabletts (#1207).
   */
  function dbWithUsers(rows) {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        deactivated_at TEXT
      );
      CREATE TABLE housekeeping_workers (user_id INTEGER);
      CREATE TABLE split_expense_guest_users (user_id INTEGER);
      CREATE TABLE display_accounts (user_id INTEGER);
      CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT);
    `);
    const ins = db.prepare('INSERT INTO users (id, username, role, deactivated_at) VALUES (?, ?, ?, ?)');
    for (const r of rows) ins.run(r.id, r.username, r.role, r.deactivatedAt ?? null);
    const asDisplay = db.prepare('INSERT INTO display_accounts (user_id) VALUES (?)');
    const asWorker = db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)');
    const asGuest = db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)');
    for (const r of rows) {
      if (r.display) asDisplay.run(r.id);
      if (r.worker) asWorker.run(r.id);
      if (r.guest) asGuest.run(r.id);
    }
    return db;
  }

  /**
   * Macht den Sicherungslauf unweigerlich scheitern: an der Stelle des
   * Sicherungsordners steht danach eine Datei, und `mkdir` weist das ab.
   */
  async function blockBackupDir() {
    await fs.rm(TEST_BACKUP_DIR, { recursive: true, force: true });
    await fs.mkdir(path.dirname(TEST_BACKUP_DIR), { recursive: true });
    await fs.writeFile(TEST_BACKUP_DIR, 'kein Ordner');
  }

  /** Nimmt die Sperre zurueck, damit ein Lauf danach gelingen kann. */
  async function unblockBackupDir() {
    await fs.rm(TEST_BACKUP_DIR, { recursive: true, force: true });
  }

  /** Ein Push-Dienst, der nur mitschreibt. */
  function recordingPush() {
    const sent = [];
    return { sent, sendPushToUser: async (userId, payload) => { sent.push({ userId, payload }); return true; } };
  }

  it('ein gescheiterter Lauf meldet sich bei jedem Admin - genau einmal (#2519)', async () => {
    const db = dbWithUsers([
      { id: 1, username: 'admin-a', role: 'admin' },
      { id: 2, username: 'admin-b', role: 'admin' },
      { id: 3, username: 'mitglied', role: 'member' },
    ]);
    const push = recordingPush();

    // EIN FEHLERWEG, DER AUCH ALS ROOT GREIFT. Der #579-Test nimmt dem Ordner
    // die Schreibrechte und UEBERSPRINGT SICH als root, weil root sie ignoriert
    // - als Vorbedingung einer Meldung ist das zu wenig. Hier steht an der
    // Stelle des Ordners eine DATEI: `mkdir` weist das mit EEXIST/ENOTDIR ab,
    // unabhaengig von Benutzer und Betriebssystem.
    await blockBackupDir();
    try {
      // notify: true simuliert den Cron-Weg - manuelle Trigger melden nicht
      const result = await backupScheduler.triggerBackup({ database: db, pushService: push, notify: true });
      assert.strictEqual(result.success, false, 'die Vorbedingung: der Lauf muss scheitern');

      assert.strictEqual(push.sent.length, 2,
        `beide Admins bekommen die Meldung, das Mitglied nicht - gesendet: ${JSON.stringify(push.sent.map((s) => s.userId))}`);
      assert.deepEqual(push.sent.map((s) => s.userId).sort(), [1, 2]);

      const { payload } = push.sent[0];
      assert.ok(payload.title && payload.body, 'Titel und Text muessen stehen');
      // DER TEXT DES FEHLERS GEHOERT NICHT IN DEN PUSH. Er steht im Log und in
      // den Einstellungen; auf einem Sperrbildschirm ist "EACCES: permission
      // denied" kein Satz.
      const text = `${payload.title} ${payload.body}`;
      assert.doesNotMatch(text, /EACCES|EPERM|EROFS/, `der errno darf nicht im Push stehen: ${text}`);
      assert.doesNotMatch(text, /BACKUP_DIR/, `der Variablenname darf nicht im Push stehen: ${text}`);
      assert.ok(!text.includes(path.resolve(TEST_BACKUP_DIR)), 'der Pfad darf nicht im Push stehen');
      // Und der Grund ist trotzdem abrufbar - dort, wohin die Meldung zeigt.
      assert.ok(backupScheduler.getStatus().lastError?.message, 'lastError traegt den Grund weiter');
      assert.match(payload.url, /settings/, 'die Meldung zeigt auf die Seite, die den Grund nennt');
      assert.strictEqual(payload.tag, 'backup-failure',
        'ein gemeinsames Etikett: zwei gescheiterte Naechte ersetzen eine Meldung, sie stapeln nicht');
    } finally {
      await unblockBackupDir();
      db.close();
    }
  });

  it('ein Admin, der ein Wandtablett oder Gast ist, bekommt keine Sicherungsmeldung (#1207)', async () => {
    // householdMemberSql statt activeAccountSql: eine Sicherungsmeldung auf dem
    // Flurbildschirm waere eine technische Meldung an die ganze Wohnung.
    const db = dbWithUsers([
      { id: 1, username: 'admin-a', role: 'admin' },
      { id: 2, username: 'admin-flur', role: 'admin', display: true },
      { id: 3, username: 'admin-hilfe', role: 'admin', worker: true },
      { id: 4, username: 'admin-gast', role: 'admin', guest: true },
      { id: 5, username: 'admin-weg', role: 'admin', deactivatedAt: '2026-01-01T00:00:00Z' },
    ]);
    const push = recordingPush();
    const notified = await backupScheduler._notifyAdminsOfBackupFailure({ database: db, pushService: push });
    assert.strictEqual(notified, 1,
      `nur das Admin-Konto, das ein Mensch im Haushalt ist - gesendet: ${JSON.stringify(push.sent.map((x) => x.userId))}`);
    assert.deepEqual(push.sent.map((x) => x.userId), [1]);
    db.close();
  });

  it('ein erfolgreicher Lauf danach raeumt lastError weg und meldet nichts (#2519)', async () => {
    const db = dbWithUsers([{ id: 1, username: 'admin-a', role: 'admin' }]);
    const push = recordingPush();

    // Erst scheitern lassen (notify: true = Cron-Weg), damit lastError steht.
    await blockBackupDir();
    try {
      await backupScheduler.triggerBackup({ database: db, pushService: push, notify: true });
    } finally {
      await unblockBackupDir();
    }
    assert.ok(backupScheduler.getStatus().lastError, 'die Vorbedingung: lastError steht');
    const afterFailure = push.sent.length;

    // Erfolgreicher Lauf ohne notify - kein Unterschied fuer die Pruefung
    const ok = await backupScheduler.triggerBackup({ database: db, pushService: push });
    assert.strictEqual(ok.success, true, 'der zweite Lauf muss gelingen');
    assert.strictEqual(backupScheduler.getStatus().lastError, null,
      'ein gelungener Lauf raeumt lastError weg - sonst stuende die Warnung fuer immer');
    assert.strictEqual(push.sent.length, afterFailure,
      'und er meldet nichts: eine Meldung gibt es nur fuer das Scheitern');
    db.close();
  });

  it('should cleanup test directory', async () => {
    await fs.rm(TEST_BACKUP_ROOT, { recursive: true, force: true });
  });
});
