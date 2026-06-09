/**
 * Module: Backup Scheduler
 * Purpose: Automated scheduled database backups with rotation
 * Dependencies: node-cron, fs/promises, path, server/db.js
 */

import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backupToFile } from '../db.js';
import { createLogger } from '../logger.js';
import * as webdav from './backup-webdav.js';

const log = createLogger('BackupScheduler');

// Configuration from environment variables
const BACKUP_SCHEDULE = process.env.BACKUP_SCHEDULE || '0 2 * * *'; // Default: 2 AM daily
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || '7', 10); // Default: keep last 7 backups
const BACKUP_ENABLED = process.env.BACKUP_ENABLED !== 'false'; // Default: enabled

let scheduledTask = null;
let lastBackup = null;
let lastError = null;

/**
 * Generate timestamped backup filename
 */
function backupFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `oikos-backup-${stamp}.db`;
}

/**
 * Ensure backup directory exists
 */
async function ensureBackupDir() {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
  } catch (err) {
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
    const backupFiles = files.filter((f) => f.startsWith('oikos-backup-') && f.endsWith('.db'));

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
 * Perform automated backup
 */
async function performBackup() {
  try {
    log.info('Starting scheduled backup...');

    await ensureBackupDir();

    const fileName = backupFileName();
    const filePath = path.join(BACKUP_DIR, fileName);

    await backupToFile(filePath);

    log.info(`Backup created: ${fileName}`);

    // Rotate old local backups
    await rotateBackups();

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

  scheduledTask = cron.schedule(BACKUP_SCHEDULE, performBackup, {
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
export async function triggerBackup() {
  await performBackup();
  return lastBackup;
}
