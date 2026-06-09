/**
 * Module: Database Backup
 * Purpose: Authenticated admin-only database backup and restore endpoints.
 * Dependencies: express, server/db.js
 */

import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { backupToFile, currentVersion, restoreFromFile } from '../db.js';
import { requireAdmin } from '../auth.js';
import { createLogger } from '../logger.js';
import { getStatus as getSchedulerStatus, triggerBackup } from '../services/backup-scheduler.js';
import * as webdavBackup from '../services/backup-webdav.js';

const router = express.Router();
const log = createLogger('Backup');
const RESTORE_LIMIT = process.env.BACKUP_UPLOAD_LIMIT || '100mb';

function backupFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `oikos-backup-${stamp}.db`;
}

router.get('/status', requireAdmin, (req, res) => {
  const schedulerStatus = getSchedulerStatus();
  res.json({
    data: {
      schema_version: currentVersion(),
      restore_upload_limit: RESTORE_LIMIT,
      scheduler: schedulerStatus,
    },
  });
});

router.get('/database', requireAdmin, async (req, res) => {
  let tmpPath = null;
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oikos-backup-'));
    tmpPath = path.join(dir, backupFileName());
    await backupToFile(tmpPath);

    res.setHeader('Cache-Control', 'no-store');
    res.download(tmpPath, path.basename(tmpPath), async (err) => {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      if (err && !res.headersSent) {
        log.error('Backup download failed:', err);
      }
    });
  } catch (err) {
    log.error('Database backup failed:', err);
    if (tmpPath) {
      try { await fs.rm(path.dirname(tmpPath), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    res.status(500).json({ error: 'Database backup failed.', code: 500 });
  }
});

router.post(
  '/restore',
  requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: RESTORE_LIMIT }),
  async (req, res) => {
    let dir = null;
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Backup file is required.', code: 400 });
      }

      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oikos-restore-'));
      const uploadPath = path.join(dir, 'restore.db');
      await fs.writeFile(uploadPath, req.body);
      const result = await restoreFromFile(uploadPath);

      res.json({
        ok: true,
        data: {
          schema_version: result.schemaVersion,
        },
      });
    } catch (err) {
      log.error('Database restore failed:', err);
      const message = err?.message || 'Database restore failed.';
      res.status(400).json({ error: message, code: 400 });
    } finally {
      if (dir) {
        try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }
);

router.post('/trigger', requireAdmin, async (req, res) => {
  try {
    const result = await triggerBackup();
    res.json({ data: result });
  } catch (err) {
    log.error('Manual backup trigger failed:', err);
    res.status(500).json({ error: 'Backup trigger failed.', code: 500 });
  }
});

// ─── WebDAV backup target ──────────────────────────────────────────────────────

/**
 * GET /api/v1/backup/webdav/config
 * Returns current WebDAV configuration (password masked).
 */
router.get('/webdav/config', requireAdmin, (req, res) => {
  res.json({ data: webdavBackup.getStatus() });
});

/**
 * PUT /api/v1/backup/webdav/config
 * Persists WebDAV configuration.
 * Body: { enabled?, url?, username?, password?, remotePath?, keep? }
 */
router.put('/webdav/config', requireAdmin, async (req, res) => {
  try {
    const { enabled, url, username, password, remotePath, keep } = req.body;

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.', code: 400 });
    }
    if (url !== undefined && url !== null && url !== '' && typeof url !== 'string') {
      return res.status(400).json({ error: 'url must be a string.', code: 400 });
    }
    if (url && !/^https?:\/\/.+/.test(url.trim())) {
      return res.status(400).json({ error: 'url must start with http:// or https://.', code: 400 });
    }
    if (keep !== undefined && (typeof keep !== 'number' || keep < 1)) {
      return res.status(400).json({ error: 'keep must be a positive integer.', code: 400 });
    }

    webdavBackup.saveConfig({ enabled, url, username, password, remotePath, keep });
    res.json({ data: webdavBackup.getStatus() });
  } catch (err) {
    log.error('WebDAV config save failed:', err);
    res.status(500).json({ error: 'Failed to save WebDAV config.', code: 500 });
  }
});

/**
 * POST /api/v1/backup/webdav/test
 * Tests the WebDAV connection.
 * Body: { url?, username?, password?, remotePath? }  (optional overrides)
 */
router.post('/webdav/test', requireAdmin, async (req, res) => {
  try {
    const { url, username, password, remotePath } = req.body ?? {};
    const overrides = {};
    if (url)        overrides.url        = url;
    if (username)   overrides.username   = username;
    if (password && password !== '****') overrides.password = password;
    if (remotePath) overrides.remotePath = remotePath;

    const result = await webdavBackup.testConnection(overrides);
    res.json({ data: result });
  } catch (err) {
    log.error('WebDAV connection test failed:', err);
    res.status(400).json({ error: err.message ?? 'Connection test failed.', code: 400 });
  }
});

/**
 * GET /api/v1/backup/webdav/files
 * Lists backup files stored on the remote WebDAV server.
 */
router.get('/webdav/files', requireAdmin, async (req, res) => {
  try {
    const files = await webdavBackup.getRemoteFiles();
    res.json({ data: files });
  } catch (err) {
    log.error('WebDAV file listing failed:', err);
    res.status(500).json({ error: err.message ?? 'Failed to list remote files.', code: 500 });
  }
});

/**
 * POST /api/v1/backup/webdav/trigger
 * Uploads the most recent local backup to WebDAV immediately.
 */
router.post('/webdav/trigger', requireAdmin, async (req, res) => {
  try {
    const backupDir = process.env.BACKUP_DIR || './backups';
    const fileName  = await webdavBackup.triggerUpload(backupDir);
    res.json({ data: { file: fileName, timestamp: new Date().toISOString() } });
  } catch (err) {
    log.error('WebDAV manual upload failed:', err);
    res.status(500).json({ error: err.message ?? 'WebDAV upload failed.', code: 500 });
  }
});

router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: `Backup file is too large. Maximum upload size is ${RESTORE_LIMIT}.`, code: 413 });
  }
  next(err);
});

export default router;
