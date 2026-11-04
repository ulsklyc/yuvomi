/**
 * Module: Backup Scheduler
 * Purpose: Automated scheduled database backups with rotation, age-based
 *          retention, generational tiers (daily / weekly / monthly), and
 *          admin push-notification on failure.
 * Dependencies: node-cron, fs/promises, path, server/db.js
 */

import { runExternalJob } from '../utils/restore-state.js';
import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backupToFile, get as getDb } from '../db.js';
import { createLogger } from '../logger.js';
import * as webdav from './backup-webdav.js';

const log = createLogger('BackupScheduler');

// Configuration from environment variables
const BACKUP_SCHEDULE = process.env.BACKUP_SCHEDULE || '0 2 * * *'; // Default: 2 AM daily
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || '7', 10); // Default: keep last 7 backups
const BACKUP_ENABLED = process.env.BACKUP_ENABLED !== 'false'; // Default: enabled

// Age-based retention: delete files older than this many days (0 = disabled)
const BACKUP_KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || '0', 10);

// Generational tiers (grandfather-father-son)
// BACKUP_GENERATIONS=true  keeps: last BACKUP_KEEP dailies + 4 weeklies + 3 monthlies
// Set BACKUP_GENERATIONS=false to disable (default: disabled)
const BACKUP_GENERATIONS = process.env.BACKUP_GENERATIONS === 'true';
const BACKUP_KEEP_WEEKLY = parseInt(process.env.BACKUP_KEEP_WEEKLY || '4', 10);
const BACKUP_KEEP_MONTHLY = parseInt(process.env.BACKUP_KEEP_MONTHLY || '3', 10);

let scheduledTask = null;
let lastBackup = null;
let lastError = null;

// Injected by startScheduler; allows tests to pass a mock.
let _pushService = null;

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
 * Parse a Date from a backup filename (yuvomi-backup-<ISO8601>.db).
 * Returns null when the name does not match.
 */
function dateFromFilename(name) {
  const stem = name
    .replace(/^(yuvomi|oikos)-backup-/, '')
    .replace(/\.db$/, '');
  // ISO8601 with colons replaced by dashes: 2026-11-04T02-00-00-000Z
  const iso = stem
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
    .replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Generational rotation: grandfather-father-son (monthly / weekly / daily).
 *
 * Keeps up to BACKUP_KEEP_MONTHLY representatives per calendar-month,
 * BACKUP_KEEP_WEEKLY representatives per ISO-week, and BACKUP_KEEP daily
 * files.  A file qualifies as the monthly/weekly representative only when it
 * is the newest one in that period.
 *
 * Returns the set of file paths to DELETE.
 */
function generationalFilesToDelete(files) {
  // files: sorted newest-first, each has { file, mtime, path }
  const keep = new Set();

  const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const weekKey = (d) => {
    // ISO week: find the Thursday of the week (Thu stays in the same week as Mon–Sun)
    const thu = new Date(d);
    thu.setUTCDate(d.getUTCDate() + (4 - (d.getUTCDay() || 7)));
    return `${thu.getUTCFullYear()}-W${String(Math.ceil(((thu - new Date(Date.UTC(thu.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)).padStart(2, '0')}`;
  };

  const monthlyCounts = {};
  const weeklyCounts = {};
  let dailyCount = 0;

  for (const f of files) {
    const d = dateFromFilename(f.file) || f.mtime;
    const mk = monthKey(d);
    const wk = weekKey(d);

    const isMonthlyRep = (monthlyCounts[mk] || 0) < BACKUP_KEEP_MONTHLY;
    const isWeeklyRep  = (weeklyCounts[wk]  || 0) < BACKUP_KEEP_WEEKLY;
    const isDailyRep   = dailyCount < BACKUP_KEEP;

    if (isMonthlyRep || isWeeklyRep || isDailyRep) {
      keep.add(f.path);
      if (isMonthlyRep) monthlyCounts[mk] = (monthlyCounts[mk] || 0) + 1;
      if (isWeeklyRep)  weeklyCounts[wk]  = (weeklyCounts[wk]  || 0) + 1;
      if (isDailyRep)   dailyCount++;
    }
  }

  return files.filter((f) => !keep.has(f.path));
}

/**
 * Rotate backups.
 *
 * Modes (applied in order, most-specific first):
 *  1. Generational (BACKUP_GENERATIONS=true): GFS tiers, then age prune.
 *  2. Count-only (default): keep last BACKUP_KEEP files.
 *
 * In all modes, age pruning (BACKUP_KEEP_DAYS > 0) also runs AFTER the
 * primary policy, but never removes the last BACKUP_KEEP files regardless
 * of age.
 */
async function rotateBackups() {
  try {
    const files = await getBackupFiles();
    if (files.length === 0) return;

    const toDelete = new Set(
      BACKUP_GENERATIONS
        ? generationalFilesToDelete(files).map((f) => f.path)
        : files.slice(BACKUP_KEEP).map((f) => f.path)
    );

    // Age pruning: remove files older than BACKUP_KEEP_DAYS, but keep the
    // last BACKUP_KEEP regardless of age.
    if (BACKUP_KEEP_DAYS > 0) {
      const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400 * 1000;
      files.slice(BACKUP_KEEP).forEach((f) => {
        if (f.mtime.getTime() < cutoff) toDelete.add(f.path);
      });
    }

    for (const { file, path: filePath } of files) {
      if (!toDelete.has(filePath)) continue;
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
export { dateFromFilename, generationalFilesToDelete };

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
 * Send a Web Push notification to all admin users.
 * Best-effort: errors are logged but never rethrown.
 */
async function notifyAdminsOfFailure(message) {
  if (!_pushService) return;
  try {
    const db = getDb();
    const admins = db.prepare(
      "SELECT id FROM users WHERE role = 'admin' AND deactivated_at IS NULL"
    ).all();
    const payload = {
      title: 'Yuvomi backup failed',
      body: message,
      tag: 'backup-failure',
    };
    await Promise.allSettled(admins.map((u) => _pushService.sendPushToUser(u.id, payload)));
  } catch (err) {
    log.error('Failed to notify admins of backup failure:', err);
  }
}

/**
 * Perform automated backup
 */
async function performBackup() {
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
        lastBackup.webdav = { success: false, error: webdavErr.message };
        await notifyAdminsOfFailure(`WebDAV upload failed: ${webdavErr.message}`);
      }
    }
  } catch (err) {
    log.error('Scheduled backup failed:', err);
    const now = new Date().toISOString();
    lastError = { timestamp: now, message: err.message };
    lastBackup = { timestamp: now, success: false, error: err.message };
    await notifyAdminsOfFailure(err.message);
  }
}

/**
 * Start the backup scheduler.
 * @param {object} [opts]
 * @param {object} [opts.pushService]  - { sendPushToUser } for admin failure alerts
 */
export function startScheduler({ pushService } = {}) {
  if (pushService) _pushService = pushService;

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
  scheduledTask = cron.schedule(BACKUP_SCHEDULE, () => runExternalJob(performBackup), {
    timezone: process.env.TZ || 'UTC',
  });

  const retentionDesc = BACKUP_GENERATIONS
    ? `GFS tiers (${BACKUP_KEEP} daily / ${BACKUP_KEEP_WEEKLY} weekly / ${BACKUP_KEEP_MONTHLY} monthly)`
    : `last ${BACKUP_KEEP} backups${BACKUP_KEEP_DAYS > 0 ? `, max ${BACKUP_KEEP_DAYS} days` : ''}`;
  log.info(`Backup scheduler started: ${BACKUP_SCHEDULE} (${retentionDesc})`);
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

/**
 * Get scheduler status
 */
export function getStatus() {
  return {
    enabled: BACKUP_ENABLED,
    schedule: BACKUP_SCHEDULE,
    backupDir: BACKUP_DIR,
    keepCount: BACKUP_KEEP,
    keepDays: BACKUP_KEEP_DAYS > 0 ? BACKUP_KEEP_DAYS : null,
    generations: BACKUP_GENERATIONS
      ? { weekly: BACKUP_KEEP_WEEKLY, monthly: BACKUP_KEEP_MONTHLY }
      : null,
    running: scheduledTask !== null,
    lastBackup,
    lastError,
    webdav: webdav.getStatus(),
  };
}

/**
 * Trigger an immediate backup (for manual/testing purposes)
 */
export async function triggerBackup() {
  await performBackup();
  return lastBackup;
}
