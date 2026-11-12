/**
 * Module: the stored status of the last local backup
 * Purpose: the vocabulary both sides of it share (Phase 1b section F, E12).
 *          The scheduler (server/services/backup-scheduler.js) writes three
 *          keys into `sync_config` after every run and reads them at its first
 *          status call; a restore (server/db.js) carries them into the
 *          restored database, because they describe this installation's
 *          backups and not those of the file that was restored.
 *
 *          No database import here: server/db.js loads this file.
 */

export const BACKUP_STATUS_KEYS = Object.freeze({
  /** ISO timestamp of the last run, whatever its outcome. */
  attempt: 'backup_last_attempt',
  /** ISO timestamp of the last run that wrote a verified backup. */
  success: 'backup_last_success',
  /** Why the last run failed; no row while the last run succeeded. */
  reason: 'backup_last_reason',
});

/**
 * Why a backup failed, as a closed set: what the API shows and the database
 * keeps. The raw text of the error goes to the log only - it names absolute
 * paths. Each reason has one fixed sentence in English; the client translates
 * by `reason` (`settings.backupSchedulerReason*`).
 */
export const BACKUP_FAILURE_SENTENCES = Object.freeze({
  backup_dir_not_writable: 'The backup directory is not writable. Set BACKUP_DIR to a writable, mounted path '
    + 'and check the ownership of the mounted folder. Details are in the server log.',
  disk_full: 'The backup could not be written because the disk is full. Details are in the server log.',
  backup_verify_failed: 'The backup failed its integrity check and was discarded; older backups were kept. '
    + 'The database this instance runs on may be damaged. Details are in the server log.',
  unknown: 'The backup failed. Details are in the server log.',
});

/**
 * The same four sentences the backup card shows, by locale key - for a push
 * notification, which has no browser to run the client's own i18n map
 * (public/settings/pages/admin-backup.js) against.
 */
export const BACKUP_FAILURE_LOCALE_KEYS = Object.freeze({
  backup_dir_not_writable: 'settings.backupSchedulerReasonDirNotWritable',
  disk_full: 'settings.backupSchedulerReasonDiskFull',
  backup_verify_failed: 'settings.backupSchedulerReasonVerifyFailed',
  unknown: 'settings.backupSchedulerReasonUnknown',
});

/**
 * A stored or thrown value as one of the known reasons.
 * @param {unknown} value
 * @returns {keyof typeof BACKUP_FAILURE_SENTENCES}
 */
export function knownBackupFailureReason(value) {
  return typeof value === 'string' && Object.hasOwn(BACKUP_FAILURE_SENTENCES, value)
    ? /** @type {keyof typeof BACKUP_FAILURE_SENTENCES} */ (value)
    : 'unknown';
}

const NOT_WRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'SQLITE_READONLY']);
const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT', 'SQLITE_FULL']);

/**
 * The reason of a failed backup, from the error and its causes.
 * @param {unknown} err
 * @returns {keyof typeof BACKUP_FAILURE_SENTENCES}
 */
export function backupFailureReason(err) {
  let current = /** @type {any} */ (err);
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.reason === 'backup_verify_failed') return 'backup_verify_failed';
    if (NOT_WRITABLE_CODES.has(current.code)) return 'backup_dir_not_writable';
    if (DISK_FULL_CODES.has(current.code)) return 'disk_full';
    current = current.cause;
  }
  return 'unknown';
}
