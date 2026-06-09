/**
 * Module: WebDAV Backup Target
 * Purpose: Upload automated backups to a WebDAV server (Nextcloud, ownCloud,
 *          Hetzner Storage Box, Infomaniak kDrive, etc.)
 * Dependencies: node:fs/promises, node:fetch (Node >=22, built-in), server/db.js
 *
 * No extra npm package needed — uses Node 22 native fetch for all HTTP calls.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as db from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('BackupWebDAV');

// ─── Env-Variable fallbacks (Docker/Compose-only installs) ────────────────────
const ENV_ENABLED  = process.env.WEBDAV_BACKUP_ENABLED;
const ENV_URL      = process.env.WEBDAV_BACKUP_URL;
const ENV_USER     = process.env.WEBDAV_BACKUP_USERNAME;
const ENV_PASS     = process.env.WEBDAV_BACKUP_PASSWORD;
const ENV_PATH     = process.env.WEBDAV_BACKUP_PATH;
const ENV_KEEP     = process.env.WEBDAV_BACKUP_KEEP;

const BACKUP_FILE_PREFIX = 'oikos-backup-';
const BACKUP_FILE_SUFFIX = '.db';

// ─── DB-Helpers ───────────────────────────────────────────────────────────────

function cfgGet(key) {
  try {
    const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function cfgDelete(key) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

// ─── Configuration helpers ────────────────────────────────────────────────────

/**
 * Read effective configuration (env vars take precedence over DB values).
 * @returns {{ enabled: boolean, url: string|null, username: string|null,
 *             password: string|null, remotePath: string, keep: number }}
 */
export function getConfig() {
  const enabled = ENV_ENABLED !== undefined
    ? ENV_ENABLED === 'true' || ENV_ENABLED === '1'
    : cfgGet('webdav_backup_enabled') === '1';

  const url      = ENV_URL  ?? cfgGet('webdav_backup_url')      ?? null;
  const username = ENV_USER ?? cfgGet('webdav_backup_username')  ?? null;
  const password = ENV_PASS ?? cfgGet('webdav_backup_password')  ?? null;

  const rawPath  = ENV_PATH ?? cfgGet('webdav_backup_path') ?? '/oikos/backups/';
  const remotePath = rawPath.endsWith('/') ? rawPath : `${rawPath}/`;

  const keepRaw  = ENV_KEEP ?? cfgGet('webdav_backup_keep') ?? '7';
  const keep     = Math.max(1, parseInt(keepRaw, 10) || 7);

  return { enabled, url, username, password, remotePath, keep };
}

/**
 * Persist configuration to the DB (env-var fields are ignored/read-only).
 * Admin-only — caller must enforce that.
 * @param {{ enabled?: boolean, url?: string, username?: string,
 *           password?: string, remotePath?: string, keep?: number }} data
 */
export function saveConfig(data) {
  if (!process.env.DB_ENCRYPTION_KEY) {
    log.warn('WARNING: DB_ENCRYPTION_KEY is not set — WebDAV password will be stored unencrypted.');
  }

  if (data.enabled !== undefined) {
    cfgSet('webdav_backup_enabled', data.enabled ? '1' : '0');
  }
  if (data.url !== undefined) {
    if (data.url) cfgSet('webdav_backup_url', data.url.trim());
    else cfgDelete('webdav_backup_url');
  }
  if (data.username !== undefined) {
    if (data.username) cfgSet('webdav_backup_username', data.username.trim());
    else cfgDelete('webdav_backup_username');
  }
  // Only overwrite password when a non-empty value is sent
  if (data.password !== undefined && data.password !== '') {
    cfgSet('webdav_backup_password', data.password);
  }
  if (data.remotePath !== undefined) {
    const p = String(data.remotePath).trim() || '/oikos/backups/';
    cfgSet('webdav_backup_path', p.endsWith('/') ? p : `${p}/`);
  }
  if (data.keep !== undefined) {
    const k = Math.max(1, parseInt(data.keep, 10) || 7);
    cfgSet('webdav_backup_keep', String(k));
  }
}

/**
 * Returns whether WebDAV backup is currently enabled and fully configured.
 */
export function isEnabled() {
  const cfg = getConfig();
  return cfg.enabled && Boolean(cfg.url) && Boolean(cfg.username) && Boolean(cfg.password);
}

// ─── Native HTTP helpers (Node 22 fetch) ──────────────────────────────────────

/** Build a Basic-Auth header value. */
function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

/** Ensure base URL + remote path are joined without double slashes. */
function joinUrl(base, remotePath) {
  const b = base.replace(/\/$/, '');
  const p = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
  return `${b}${p}`;
}

/**
 * Generic WebDAV request using Node 22 native fetch.
 */
async function davFetch(method, url, { username, password, headers = {}, body } = {}) {
  return fetch(url, {
    method,
    headers: { Authorization: basicAuth(username, password), ...headers },
    ...(body !== undefined ? { body } : {}),
  });
}

/**
 * Parse a WebDAV PROPFIND Multi-Status XML response.
 * Returns only plain files whose basename matches the oikos backup pattern.
 */
function parsePropfindXml(xml) {
  const results = [];
  const responseRe = /<[Dd](?:av)?:response[^>]*>([\s\S]*?)<\/[Dd](?:av)?:response>/g;
  let m;
  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[1];
    if (/<[Dd](?:av)?:collection\s*\/?>/.test(block)) continue; // skip directories

    const hrefMatch    = block.match(/<[Dd](?:av)?:href[^>]*>\s*(.*?)\s*<\/[Dd](?:av)?:href>/);
    const lastmodMatch = block.match(/<[Dd](?:av)?:getlastmodified[^>]*>\s*(.*?)\s*<\/[Dd](?:av)?:getlastmodified>/);
    if (!hrefMatch) continue;

    const href     = decodeURIComponent(hrefMatch[1].trim());
    const basename = href.split('/').filter(Boolean).pop() ?? '';
    const lastmod  = lastmodMatch ? lastmodMatch[1].trim() : new Date().toUTCString();

    if (basename.startsWith(BACKUP_FILE_PREFIX) && basename.endsWith(BACKUP_FILE_SUFFIX)) {
      results.push({ filename: basename, lastmod, remotePath: href });
    }
  }
  return results.sort((a, b) => new Date(b.lastmod) - new Date(a.lastmod));
}

/**
 * PROPFIND Depth:1 — returns parsed file entries, or null if directory not found (404).
 */
async function propfind(cfg) {
  const url = joinUrl(cfg.url, cfg.remotePath);
  const res = await davFetch('PROPFIND', url, {
    username: cfg.username,
    password: cfg.password,
    headers:  { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body:     `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getlastmodified/></D:prop></D:propfind>`,
  });
  if (res.status === 404) return null;
  if (res.status !== 207) throw new Error(`PROPFIND ${url} failed: ${res.status} ${res.statusText}`);
  return parsePropfindXml(await res.text());
}

/**
 * Create remote directory via MKCOL (405 = already exists → OK).
 */
async function mkcol(cfg) {
  const url = joinUrl(cfg.url, cfg.remotePath);
  const res = await davFetch('MKCOL', url, { username: cfg.username, password: cfg.password });
  if (!res.ok && res.status !== 405) {
    throw new Error(`MKCOL ${url} failed: ${res.status} ${res.statusText}`);
  }
}

// ─── Remote-file helpers ──────────────────────────────────────────────────────

async function ensureRemoteDir(cfg) {
  const entries = await propfind(cfg);
  if (entries === null) {
    await mkcol(cfg);
    log.info(`Created remote directory: ${cfg.remotePath}`);
  }
}

async function listRemoteBackups(cfg) {
  return (await propfind(cfg)) ?? [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Upload a local backup file to the WebDAV server.
 * Updates `webdav_backup_last_upload` / `webdav_backup_last_error` in sync_config.
 * @param {string} localFilePath  Absolute path to the local .db backup
 */
export async function uploadBackup(localFilePath) {
  const cfg = getConfig();
  if (!cfg.enabled) {
    log.info('WebDAV backup is disabled — skipping upload.');
    return;
  }
  if (!cfg.url || !cfg.username || !cfg.password) {
    log.warn('WebDAV backup is enabled but not fully configured — skipping upload.');
    return;
  }

  const fileName   = path.basename(localFilePath);
  const remoteFile = `${cfg.remotePath}${fileName}`;
  log.info(`Uploading ${fileName} → ${cfg.url}${remoteFile}`);

  try {
    await ensureRemoteDir(cfg);

    const buffer = await fs.readFile(localFilePath);
    const putUrl = joinUrl(cfg.url, remoteFile);
    const putRes = await davFetch('PUT', putUrl, {
      username: cfg.username,
      password: cfg.password,
      headers:  { 'Content-Type': 'application/octet-stream' },
      body:     buffer,
    });
    if (!putRes.ok) throw new Error(`PUT ${putUrl} failed: ${putRes.status} ${putRes.statusText}`);

    log.info(`WebDAV upload successful: ${fileName}`);
    cfgSet('webdav_backup_last_upload', new Date().toISOString());
    cfgDelete('webdav_backup_last_error');

    await rotateRemoteBackups(cfg);
  } catch (err) {
    log.error('WebDAV upload failed:', err);
    cfgSet('webdav_backup_last_error', err.message ?? String(err));
    throw err;
  }
}

/**
 * Delete oldest remote backups, keeping only the last cfg.keep files.
 * @param {object} [existingCfg]  Pass already-loaded config to avoid a second read
 */
export async function rotateRemoteBackups(existingCfg) {
  const cfg = existingCfg ?? getConfig();
  try {
    const files = await listRemoteBackups(cfg);
    if (files.length <= cfg.keep) return;

    for (const f of files.slice(cfg.keep)) {
      try {
        const delUrl = joinUrl(cfg.url, f.remotePath);
        const res    = await davFetch('DELETE', delUrl, { username: cfg.username, password: cfg.password });
        if (res.ok || res.status === 404) {
          log.info(`Rotated remote backup: ${f.filename}`);
        } else {
          log.error(`Failed to delete remote backup ${f.filename}: ${res.status}`);
        }
      } catch (err) {
        log.error(`Failed to delete remote backup ${f.filename}: ${err.message}`);
      }
    }
  } catch (err) {
    log.error('Remote backup rotation failed:', err);
  }
}

/**
 * Test the WebDAV connection (PROPFIND on server root).
 * @param {object} [overrides]  Optional field overrides for the test
 * @returns {Promise<{ ok: true, files: number }>}
 */
export async function testConnection(overrides = {}) {
  const cfg = { ...getConfig(), ...overrides };

  if (!cfg.url || !cfg.username || !cfg.password) {
    throw new Error('URL, username and password are required.');
  }

  // Quick auth test — PROPFIND Depth:0 on server root
  const rootUrl = joinUrl(cfg.url, '/');
  const rootRes = await davFetch('PROPFIND', rootUrl, {
    username: cfg.username,
    password: cfg.password,
    headers:  { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body:     `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
  });

  if (rootRes.status === 401) throw new Error('Authentication failed (401). Check username and password.');
  if (!rootRes.ok && rootRes.status !== 207) {
    throw new Error(`WebDAV server not reachable: ${rootRes.status} ${rootRes.statusText}`);
  }

  let fileCount = 0;
  try { fileCount = (await listRemoteBackups(cfg)).length; } catch { /* dir may not exist yet */ }

  return { ok: true, files: fileCount };
}

/**
 * List remote backup files (for the UI).
 */
export async function getRemoteFiles() {
  return listRemoteBackups(getConfig());
}

/**
 * Trigger an immediate upload of the most recent local backup file.
 * @param {string} backupDir  Local directory to look for the latest backup
 */
export async function triggerUpload(backupDir) {
  const entries = await fs.readdir(backupDir);
  const dbFiles = entries.filter(
    (f) => f.startsWith(BACKUP_FILE_PREFIX) && f.endsWith(BACKUP_FILE_SUFFIX)
  );
  if (dbFiles.length === 0) throw new Error('No local backup files found to upload.');

  const withStats = await Promise.all(
    dbFiles.map(async (f) => {
      const fp    = path.join(backupDir, f);
      const stats = await fs.stat(fp);
      return { file: fp, mtime: stats.mtime };
    })
  );
  withStats.sort((a, b) => b.mtime - a.mtime);

  const latestFile = withStats[0].file;
  await uploadBackup(latestFile);
  return path.basename(latestFile);
}

/**
 * Return combined status (config + last upload/error) for the API.
 * Password is always masked.
 */
export function getStatus() {
  const cfg = getConfig();
  return {
    enabled:       cfg.enabled,
    configured:    Boolean(cfg.url && cfg.username && cfg.password),
    url:           cfg.url,
    username:      cfg.username,
    password:      cfg.password ? '****' : null,
    remotePath:    cfg.remotePath,
    keep:          cfg.keep,
    lastUpload:    cfgGet('webdav_backup_last_upload') ?? null,
    lastError:     cfgGet('webdav_backup_last_error')  ?? null,
    envControlled: Boolean(ENV_URL), // true → URL comes from env, UI fields are read-only
  };
}
