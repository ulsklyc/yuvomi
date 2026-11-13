/**
 * Module: Backup Scheduler
 * Purpose: Automated scheduled database backups with rotation
 * Dependencies: node-cron, fs/promises, path, server/db.js
 */

import { runExternalJob } from '../utils/restore-state.js';
import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import * as webdav from './backup-webdav.js';
import { notifyAdmins } from './admin-notices.js';
import { resolveHouseholdLocale, translate } from '../utils/i18n.js';
import { remoteFailure } from '../utils/http.js';
import {
  BACKUP_FAILURE_LOCALE_KEYS, BACKUP_FAILURE_SENTENCES, BACKUP_STATUS_KEYS,
  backupFailureReason, knownBackupFailureReason,
} from '../utils/backup-status.js';

const log = createLogger('BackupScheduler');

// Configuration from environment variables
const BACKUP_SCHEDULE = process.env.BACKUP_SCHEDULE || '0 2 * * *'; // Default: 2 AM daily
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || '7', 10); // Default: keep last 7 backups
const BACKUP_ENABLED = process.env.BACKUP_ENABLED !== 'false'; // Default: enabled

/** @type {import('node-cron').ScheduledTask | null} */
let scheduledTask = null;
/** @type {{ timestamp: string, success: boolean, file?: string, error?: string, reason?: string, webdav?: object } | null} */
let lastBackup = null;
/** @type {{ timestamp: string, reason: string, message: string } | null} */
let lastError = null;
/**
 * ISO timestamp of the last run that wrote a verified backup, or null.
 * @type {string | null}
 */
let lastSuccess = null;

// ── The status outlives the process (Phase 1b section F, E12) ────────────────
//
// Until then it lived in the three variables above, and after a restart the
// backup page said "never". Three keys in `sync_config` (where the WebDAV
// target keeps its status too) hold the last attempt, the last success and the
// reason of a failed attempt. Written after every run, read once before the
// first answer. What is stored and shown is the reason and a fixed sentence;
// the text of the error names absolute paths and goes to the log only.

let statusLoaded = false;

/** Read the stored status once. With no connection (a restore) it is tried again next time. */
function loadStoredStatus() {
  if (statusLoaded) return;
  /** @type {{ attempt: string | null, success: string | null, failure: string | null }} */
  let stored;
  try {
    const read = db.get().prepare('SELECT value FROM sync_config WHERE key = ?');
    stored = {
      attempt: read.get(BACKUP_STATUS_KEYS.attempt)?.value ?? null,
      success: read.get(BACKUP_STATUS_KEYS.success)?.value ?? null,
      failure: read.get(BACKUP_STATUS_KEYS.reason)?.value ?? null,
    };
  } catch {
    return;
  }
  statusLoaded = true;
  // A run in this process is newer than anything stored.
  if (lastBackup) return;
  lastSuccess = stored.success;
  if (!stored.attempt) return;
  if (stored.failure === null) {
    lastBackup = { timestamp: stored.attempt, success: true };
    return;
  }
  const reason = knownBackupFailureReason(stored.failure);
  const message = BACKUP_FAILURE_SENTENCES[reason];
  lastBackup = { timestamp: stored.attempt, success: false, error: message, reason };
  lastError = { timestamp: stored.attempt, reason, message };
}

/**
 * Store the outcome of a run. A status that cannot be stored must not turn a
 * written backup into a failed one: it is logged, and memory still has it.
 * @param {string} timestamp ISO timestamp of the run
 * @param {string | null} reason null for a success
 */
function storeStatus(timestamp, reason) {
  try {
    const database = db.get();
    const upsert = database.prepare(`
      INSERT INTO sync_config (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `);
    database.transaction(() => {
      upsert.run(BACKUP_STATUS_KEYS.attempt, timestamp);
      if (reason === null) {
        upsert.run(BACKUP_STATUS_KEYS.success, timestamp);
        database.prepare('DELETE FROM sync_config WHERE key = ?').run(BACKUP_STATUS_KEYS.reason);
      } else {
        upsert.run(BACKUP_STATUS_KEYS.reason, reason);
      }
    })();
  } catch (err) {
    log.warn('Could not store the backup status; it is kept in memory until the next restart:', err);
  }
}

// New backups use the `yuvomi-` prefix; pre-rebrand files use `oikos-`.
// Both are still recognised for listing/rotation so legacy backups are not
// orphaned (never rotated, invisible to the UI) after the rename.
const BACKUP_FILE_PREFIX = 'yuvomi-backup-';
const LEGACY_FILE_PREFIX = 'oikos-backup-';

/** Whether a filename is a backup file (new or legacy naming). */
function isBackupFile(name) {
  return (name.startsWith(BACKUP_FILE_PREFIX) || name.startsWith(LEGACY_FILE_PREFIX))
    && name.endsWith('.db');
}

/**
 * Generate timestamped backup filename
 */
function backupFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${BACKUP_FILE_PREFIX}${stamp}.db`;
}

/**
 * Ensure backup directory exists
 */
async function ensureBackupDir() {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    // mkdir succeeds on a directory that exists, also on one this user may not
    // write to (a mounted folder owned by someone else). The driver would then
    // fail with SQLITE_CANTOPEN, which names neither the folder nor the cause.
    await fs.access(BACKUP_DIR, fs.constants.W_OK);
  } catch (err) {
    // Häufigster Praxisfall im Container: BACKUP_DIR zeigt auf einen Pfad ausserhalb
    // des gemounteten Volumes (z. B. den relativen Default './backups' unter /app),
    // den der unprivilegierte Prozess nicht anlegen darf. Der nackte EACCES-Text
    // nennt nur den relativen Pfad und führt beim Debuggen in die Irre.
    if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
      const detailed = new Error(
        `Backup directory "${path.resolve(BACKUP_DIR)}" is not writable (${err.code}). `
        + 'Set BACKUP_DIR to a writable, mounted path (in Docker: /backups) '
        + 'and verify the ownership of the mounted host folder.'
      );
      detailed.code = err.code;
      detailed.cause = err;
      log.error(detailed.message);
      throw detailed;
    }
    log.error('Failed to create backup directory:', err);
    throw err;
  }
}

/**
 * Get all backup files sorted by modification time (newest first)
 */
async function getBackupFiles() {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const backupFiles = files.filter(isBackupFile);

    // Get file stats and sort by modification time
    const filesWithStats = await Promise.all(
      backupFiles.map(async (file) => {
        const filePath = path.join(BACKUP_DIR, file);
        const stats = await fs.stat(filePath);
        return { file, mtime: stats.mtime, path: filePath };
      })
    );

    return filesWithStats.sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Rotate backups - keep only the last N backups
 */
async function rotateBackups() {
  try {
    const files = await getBackupFiles();

    if (files.length <= BACKUP_KEEP) {
      return; // Nothing to delete
    }

    const filesToDelete = files.slice(BACKUP_KEEP);

    for (const { file, path: filePath } of filesToDelete) {
      try {
        await fs.unlink(filePath);
        log.info(`Rotated old backup: ${file}`);
      } catch (err) {
        log.error(`Failed to delete old backup ${file}:`, err);
      }
    }
  } catch (err) {
    log.error('Backup rotation failed:', err);
  }
}

/**
 * Create a fresh timestamped local backup and rotate old local files.
 * Shared by the scheduler and the manual "upload now" flow so that every
 * trigger produces a new, uniquely named snapshot of the current DB state.
 * @returns {Promise<string>} Absolute path to the newly created backup file
 */
export async function createLocalBackup() {
  await ensureBackupDir();

  const fileName = backupFileName();
  const filePath = path.join(BACKUP_DIR, fileName);

  await db.backupToFile(filePath);
  log.info(`Backup created: ${fileName}`);

  // Rotate old local backups
  await rotateBackups();

  return filePath;
}

/**
 * EIN FEHLGESCHLAGENES SICHERUNGSLAUF MELDET SICH BEI DEN ADMINS (#2519).
 *
 * Ohne diese Meldung faellt die naechtliche Sicherung still aus: gesehen wird
 * das erst, wenn jemand Einstellungen > Sicherung aufschlaegt - also meistens
 * dann, wenn die Sicherung gebraucht wird.
 *
 * DER GRUND STEHT IM PUSH, NICHT DER FEHLERTEXT. Seit #2540 ist der Grund
 * einer von vier festen, unbedenklichen Saetzen (BACKUP_FAILURE_LOCALE_KEYS,
 * dieselben, die die Karte in Einstellungen > Sicherung zeigt) - nie die
 * rohe Fehlermeldung mit ihrem absoluten Pfad oder errno, die nur ins Log
 * gehoert.
 *
 * Wer die Meldung bekommt, loest admin-notices.js. Diese Funktion baut nur
 * die Nachricht fuer den Sicherungsfall.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.database]
 * @param {import('./admin-notices.js').PushService} [opts.pushService] - { sendPushToUser }
 * @param {keyof typeof BACKUP_FAILURE_LOCALE_KEYS} [opts.reason]
 * @returns {Promise<number>} Zahl der Admins, bei denen tatsaechlich eine
 *   Push-Mitteilung zugestellt wurde
 */
async function notifyAdminsOfBackupFailure({ database, pushService, reason = 'unknown' } = {}) {
  try {
    const activeDb = database ?? db.get();
    const locale = resolveHouseholdLocale(activeDb);
    const reasonKey = BACKUP_FAILURE_LOCALE_KEYS[reason] ?? BACKUP_FAILURE_LOCALE_KEYS.unknown;
    const payload = {
      title: translate(locale, 'settings.backupSchedulerFailedPushTitle'),
      body: translate(locale, reasonKey),
      url: '/settings/admin/backup',
      // EIN EINTRAG, NICHT EINER JE LAUF: zwei Naechte hintereinander
      // gescheitert soll eine Meldung ersetzen, keine zweite daneben legen.
      tag: 'backup-failure',
      priority: 'default',
    };
    return await notifyAdmins({ database: activeDb, payload, pushService });
  } catch (err) {
    log.error('Could not notify the administrators about the failed backup:', err);
    return 0;
  }
}

/**
 * Perform automated backup
 * @param {Object} [opts]
 * @param {boolean} [opts.notify]
 */
async function performBackup(opts = {}) {
  try {
    log.info('Starting scheduled backup...');

    const filePath = await createLocalBackup();
    const fileName = path.basename(filePath);

    const timestamp = new Date().toISOString();
    lastBackup = {
      timestamp,
      file: fileName,
      success: true,
    };
    lastError = null;
    lastSuccess = timestamp;
    statusLoaded = true;
    storeStatus(timestamp, null);

    // ── WebDAV upload (optional, non-fatal) ──────────────────────────────────
    if (webdav.isEnabled()) {
      try {
        await webdav.uploadBackup(filePath);
        log.info(`WebDAV upload complete: ${fileName}`);
        lastBackup.webdav = { success: true, timestamp: new Date().toISOString() };
      } catch (webdavErr) {
        log.error('WebDAV upload failed (local backup is still intact):', webdavErr);
        // Shown on the backup page: the class of the WebDAV failure, never the
        // server's or fetch's text with its URL (Phase 0 section H).
        lastBackup.webdav = { success: false, error: remoteFailure(webdavErr)?.detail ?? 'WebDAV upload failed.' };
      }
    }
  } catch (err) {
    // The text of the error stays here, in the log. The API and the database
    // get the reason and its fixed sentence (#2525, the `reason` on `lastError`
    // was proposed in #2540).
    log.error('Scheduled backup failed:', err);
    const timestamp = new Date().toISOString();
    const reason = backupFailureReason(err);
    const message = BACKUP_FAILURE_SENTENCES[reason];
    // The last success may still be in the database only.
    loadStoredStatus();
    lastError = { timestamp, reason, message };
    lastBackup = { timestamp, success: false, error: message, reason };
    statusLoaded = true;
    storeStatus(timestamp, reason);
    // Nach dem Setzen von lastError: die Meldung verweist auf die Seite, die
    // ihn zeigt, also muss er dort schon stehen. Nur automatische Laeufe
    // benachrichtigen - ein manueller Klick landet sofort auf der Seite.
    if (opts.notify) await notifyAdminsOfBackupFailure({ ...opts, reason });
  }
}

/**
 * Start the backup scheduler
 */
export function startScheduler() {
  if (!BACKUP_ENABLED) {
    log.info('Automated backups are disabled (BACKUP_ENABLED=false)');
    return;
  }

  if (!cron.validate(BACKUP_SCHEDULE)) {
    log.error(`Invalid cron schedule: ${BACKUP_SCHEDULE}`);
    return;
  }

  // Laedt nach WebDAV hoch: waehrend eines Restores beginnt kein Lauf, ein
  // laufender wird abgewartet (Codex-Befund in #1431).
  scheduledTask = cron.schedule(BACKUP_SCHEDULE, () => runExternalJob(() => performBackup({ notify: true })), {
    timezone: process.env.TZ || 'UTC',
  });

  log.info(`Backup scheduler started: ${BACKUP_SCHEDULE} (keeping last ${BACKUP_KEEP} backups)`);
}

/**
 * Stop the backup scheduler
 */
export function stopScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    log.info('Backup scheduler stopped');
  }
}

/** Nur fuer die Tests: der Melder allein, ohne einen Sicherungslauf. */
export const _notifyAdminsOfBackupFailure = notifyAdminsOfBackupFailure;

/**
 * Get scheduler status
 */
export function getStatus() {
  loadStoredStatus();
  return {
    enabled: BACKUP_ENABLED,
    schedule: BACKUP_SCHEDULE,
    backupDir: BACKUP_DIR,
    keepCount: BACKUP_KEEP,
    running: scheduledTask !== null,
    lastBackup,
    lastError,
    lastSuccess,
    // When the schedule fires next, or null without a running schedule.
    nextRun: scheduledTask?.getNextRun()?.toISOString() ?? null,
    webdav: webdav.getStatus(),
  };
}

/**
 * Trigger an immediate backup (for manual/testing purposes)
 */
export async function triggerBackup(opts = {}) {
  // `opts` reicht die Datenbank und den Push-Dienst an den Melder weiter -
  // sonst waere der Fehlerweg nur ueber den globalen Zustand pruefbar
  // (derselbe Weg wie processDueMedications, services/medication-scheduler.js).
  // Die Route ruft ohne Argumente, dann gelten die echten Dienste.
  await performBackup(opts);
  return lastBackup;
}
