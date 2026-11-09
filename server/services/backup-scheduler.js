/**
 * Module: Backup Scheduler
 * Purpose: Automated scheduled database backups with rotation
 * Dependencies: node-cron, fs/promises, path, server/db.js
 */

import { runExternalJob } from '../utils/restore-state.js';
import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backupToFile, get as getDb } from '../db.js';
import { createLogger } from '../logger.js';
import * as webdav from './backup-webdav.js';
import { pushService as defaultPushService } from './push.js';
import { householdMemberSql } from './household-members.js';
import { resolveHouseholdLocale, translate } from '../utils/i18n.js';
import { remoteFailure } from '../utils/http.js';

const log = createLogger('BackupScheduler');

// Configuration from environment variables
const BACKUP_SCHEDULE = process.env.BACKUP_SCHEDULE || '0 2 * * *'; // Default: 2 AM daily
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || '7', 10); // Default: keep last 7 backups
const BACKUP_ENABLED = process.env.BACKUP_ENABLED !== 'false'; // Default: enabled

let scheduledTask = null;
let lastBackup = null;
let lastError = null;

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

  await backupToFile(filePath);
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
 * DER TEXT DES FEHLERS STEHT NICHT IM PUSH. Er gehoert ins Log und in
 * Einstellungen > Sicherung, wo `lastError` ihn vollstaendig zeigt. Eine
 * Push-Mitteilung steht auf einem Sperrbildschirm, in der Sprache des
 * Haushalts, und "EACCES: permission denied, open
 * '/backups/yuvomi-backup-...'" ist dort kein Satz - sie sagt DASS und WO
 * nachzusehen ist, der Grund steht in der App.
 *
 * DIE ADMINS ALS HAUSHALTSMITGLIEDER (#1207, householdMemberSql): ein
 * Admin-Konto, das ein Wandtablett oder ein Gast ist, bekommt keine
 * Sicherungsmeldung auf den Flurbildschirm.
 *
 * Best effort: ein Fehler beim Melden wird geloggt und nie weitergeworfen -
 * er darf den Sicherungslauf nicht zusaetzlich zum Scheitern bringen.
 *
 * @param {Object} [opts]
 * @param {import('better-sqlite3-multiple-ciphers').Database} [opts.database]
 * @param {Object} [opts.pushService] - { sendPushToUser }
 * @returns {Promise<number>} Zahl der Admins, bei denen tatsaechlich eine
 *   Push-Mitteilung zugestellt wurde (sendPushToUser liefert 0 ohne
 *   Abonnement, nicht nur die Zahl der erfuellten Promises)
 */
async function notifyAdminsOfBackupFailure({ database, pushService = defaultPushService } = {}) {
  try {
    const activeDb = database ?? getDb();
    const admins = activeDb.prepare(`
      SELECT u.id FROM users u
      WHERE u.role = 'admin' AND ${householdMemberSql('u')}
      ORDER BY u.id ASC
    `).all();
    if (!admins.length) return 0;

    const locale = resolveHouseholdLocale(activeDb);
    const path = [
      translate(locale, 'settings.title'),
      translate(locale, 'settings.domainHousehold'),
      translate(locale, 'settings.pageBackupRestore'),
    ].join(' > ');
    const payload = {
      title: translate(locale, 'settings.backupSchedulerFailedPushTitle'),
      body: translate(locale, 'settings.backupSchedulerFailedPushBody', { path }),
      url: '/settings/admin/backup',
      // EIN EINTRAG, NICHT EINER JE LAUF: zwei Naechte hintereinander
      // gescheitert soll eine Meldung ersetzen, keine zweite daneben legen.
      tag: 'backup-failure',
      priority: 'default',
    };
    const results = await Promise.allSettled(
      admins.map((u) => pushService.sendPushToUser(u.id, payload)),
    );
    return results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
  } catch (err) {
    log.error('Could not notify the administrators about the failed backup:', err);
    return 0;
  }
}

/**
 * Perform automated backup
 */
async function performBackup(opts = {}) {
  try {
    log.info('Starting scheduled backup...');

    const filePath = await createLocalBackup();
    const fileName = path.basename(filePath);

    lastBackup = {
      timestamp: new Date().toISOString(),
      file: fileName,
      success: true,
    };
    lastError = null;

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
    log.error('Scheduled backup failed:', err);
    lastError = {
      timestamp: new Date().toISOString(),
      message: err.message,
    };
    lastBackup = {
      timestamp: new Date().toISOString(),
      success: false,
      error: err.message,
    };
    // Nach dem Setzen von lastError: die Meldung verweist auf die Seite, die
    // ihn zeigt, also muss er dort schon stehen. Nur automatische Laeufe
    // benachrichtigen - ein manueller Klick landet sofort auf der Seite.
    if (opts.notify) await notifyAdminsOfBackupFailure(opts);
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
  return {
    enabled: BACKUP_ENABLED,
    schedule: BACKUP_SCHEDULE,
    backupDir: BACKUP_DIR,
    keepCount: BACKUP_KEEP,
    running: scheduledTask !== null,
    lastBackup,
    lastError,
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
