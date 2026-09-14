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

// New backups use the `yuvomi-` prefix; pre-rebrand files use `oikos-`.
// Both are still recognised for listing/rotation so legacy backups are not
// orphaned (never rotated, invisible to the UI) after the rename.
const BACKUP_FILE_PREFIX = 'yuvomi-backup-';
const LEGACY_FILE_PREFIX = 'oikos-backup-';
const BACKUP_FILE_SUFFIX = '.db';

/** Whether a basename is a backup file (new or legacy naming). */
function isBackupFile(name) {
  return (name.startsWith(BACKUP_FILE_PREFIX) || name.startsWith(LEGACY_FILE_PREFIX))
    && name.endsWith(BACKUP_FILE_SUFFIX);
}

// backupFileName() in backup-scheduler.js baut den Namen aus
// `new Date().toISOString().replace(/[:.]/g, '-')`, also
// `yuvomi-backup-2026-08-25T05-31-04-624Z.db`. Der Stempel im Namen ist die
// verlaesslichste Altersquelle, die es gibt: er kommt von uns, ueberlebt jedes
// Kopieren und haengt an keiner Server-Eigenheit. `getlastmodified` ist nur der
// Rueckfall fuer Dateien, deren Namen wir nicht gebaut haben.
const BACKUP_NAME_STAMP_RE =
  /^(?:yuvomi|oikos)-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/;

/** Zeitpunkt (ms) aus dem Dateinamen, oder null wenn der Name keinen traegt. */
function timestampFromName(name) {
  const m = BACKUP_NAME_STAMP_RE.exec(name);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

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
/**
 * Eine env-Variable zaehlt nur als gesetzt, wenn sie auch einen Wert traegt.
 *
 * Deploy-Descriptoren, die jede Variable von Hand aufzaehlen (Portainer,
 * Unraid), reichen optionale Felder als leeren String durch. Ein leerer String
 * ist definiert und nicht nullish, gewann also gegen alles in der Datenbank:
 * ein Haushalt konnte WebDAV-Backups in den Einstellungen einrichten, die UI
 * nahm es an, und wirksam wurde nichts davon. Dasselbe Kriterium nutzt
 * isEnvControlled() in services/email.js.
 */
function envValue(raw) {
  // Getrimmt wird nur GEPRUEFT, zurueck kommt der Originalwert. Ein Passwort
  // darf mit einem Leerzeichen anfangen oder enden - wer es trimmt, macht aus
  // einer gueltigen Zugangsdatei eine ungueltige, und das faellt erst beim
  // naechsten Backup auf.
  return raw !== undefined && String(raw).trim() !== '' ? String(raw) : undefined;
}

export function getConfig() {
  const envEnabled = envValue(ENV_ENABLED);
  const enabled = envEnabled !== undefined
    ? envEnabled === 'true' || envEnabled === '1'
    : cfgGet('webdav_backup_enabled') === '1';

  const url      = envValue(ENV_URL)  ?? cfgGet('webdav_backup_url')      ?? null;
  const username = envValue(ENV_USER) ?? cfgGet('webdav_backup_username')  ?? null;
  const password = envValue(ENV_PASS) ?? cfgGet('webdav_backup_password')  ?? null;

  const rawPath  = envValue(ENV_PATH) ?? cfgGet('webdav_backup_path') ?? '/yuvomi/backups/';
  const remotePath = rawPath.endsWith('/') ? rawPath : `${rawPath}/`;

  const keepRaw  = envValue(ENV_KEEP) ?? cfgGet('webdav_backup_keep') ?? '7';
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
    const p = String(data.remotePath).trim() || '/yuvomi/backups/';
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

// Das Namespace-Praefix in einer WebDAV-Antwort ist frei waehlbar, und Server
// nutzen das auch: Nextcloud liefert `<d:getlastmodified>`, Apache mod_dav -
// und damit der WebDAV-Server einer Synology - liefert Live-Properties unter
// einem eigenen Praefix als `<lp1:getlastmodified>`. Ein Parser, der auf `D:`
// oder `d:` besteht, liest bei mod_dav KEINEN Zeitstempel; genau daran wurde
// die Rotation blind und loeschte das frisch hochgeladene Backup (#853).
// Darum: Praefix beliebig, auch gar keins.
const NS = '(?:[A-Za-z0-9._-]+:)?';
const RESPONSE_RE = new RegExp(`<${NS}response[^>]*>([\\s\\S]*?)</${NS}response>`, 'gi');
const COLLECTION_RE = new RegExp(`<${NS}collection\\s*/?>`, 'i');
const HREF_RE = new RegExp(`<${NS}href[^>]*>\\s*([\\s\\S]*?)\\s*</${NS}href>`, 'i');
const LASTMOD_RE = new RegExp(`<${NS}getlastmodified[^>]*>\\s*([\\s\\S]*?)\\s*</${NS}getlastmodified>`, 'i');

/**
 * Ein href darf laut RFC 4918 relativ ODER absolut sein. joinUrl() haengt aber
 * an die Basis-URL an - eine absolute Antwort ergaebe `https://host/https://…`.
 * Also hier einmal auf den Pfad normalisieren, damit der Rest des Moduls es mit
 * nur einer Form zu tun hat.
 */
function hrefToPath(href) {
  if (/^https?:\/\//i.test(href)) {
    try { return new URL(href).pathname; } catch { /* fällt unten durch */ }
  }
  return href;
}

/**
 * Sortierschluessel: der Zeitpunkt aus dem Dateinamen, sonst `getlastmodified`,
 * sonst null. Bewusst KEIN Ersatzwert "jetzt" - ein erfundenes Datum ist
 * schlimmer als ein fehlendes, weil es die Sortierung still in eine Gleichheit
 * kippt statt sie erkennbar scheitern zu lassen.
 */
function backupAge(entry) {
  const fromName = timestampFromName(entry.filename);
  if (fromName !== null) return fromName;
  if (!entry.lastmod) return null;
  const parsed = Date.parse(entry.lastmod);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Neueste zuerst; undatierte ans Ende, Gleichstand ueber den Namen. */
function byNewestFirst(a, b) {
  const ka = backupAge(a);
  const kb = backupAge(b);
  if (ka !== null && kb !== null && ka !== kb) return kb - ka;
  // Eine Datei ohne erkennbares Alter darf keine datierte verdraengen: unser
  // Scheduler baut den Stempel immer in den Namen, undatiert ist also fremd.
  if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1;
  // Letzter Anker, damit die Reihenfolge nie von der Server-Reihenfolge abhaengt.
  return b.filename.localeCompare(a.filename);
}

/**
 * Parse a WebDAV PROPFIND Multi-Status XML response.
 * Returns only plain files whose basename matches the backup pattern.
 */
function parsePropfindXml(xml) {
  const results = [];
  RESPONSE_RE.lastIndex = 0;
  let m;
  while ((m = RESPONSE_RE.exec(xml)) !== null) {
    const block = m[1];
    if (COLLECTION_RE.test(block)) continue; // skip directories

    const hrefMatch    = block.match(HREF_RE);
    const lastmodMatch = block.match(LASTMOD_RE);
    if (!hrefMatch) continue;

    const href     = hrefToPath(decodeURIComponent(hrefMatch[1].trim()));
    const basename = href.split('/').filter(Boolean).pop() ?? '';
    const lastmod  = lastmodMatch ? lastmodMatch[1].trim() : null;

    if (isBackupFile(basename)) {
      results.push({ filename: basename, lastmod, remotePath: href });
    }
  }
  return results.sort(byNewestFirst);
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

    await rotateRemoteBackups(cfg, { protect: fileName });
  } catch (err) {
    log.error('WebDAV upload failed:', err);
    cfgSet('webdav_backup_last_error', err.message ?? String(err));
    throw err;
  }
}

/**
 * Delete oldest remote backups, keeping only the last cfg.keep files.
 * @param {object} [existingCfg]  Pass already-loaded config to avoid a second read
 * @param {{ protect?: string }} [opts]  Dateiname, der nie rotiert werden darf
 */
export async function rotateRemoteBackups(existingCfg, opts = {}) {
  const cfg = existingCfg ?? getConfig();
  const { protect } = opts;
  try {
    const files = await listRemoteBackups(cfg);
    if (files.length <= cfg.keep) return;

    // Zweiter Boden unter der Sortierung: was gerade hochgeladen wurde, ist per
    // Definition das juengste Backup und darf denselben Lauf nicht mehr
    // verlassen. Sortiert die Rotation je wieder falsch - weil ein Server ein
    // Feld anders schreibt, als wir es erwarten -, kostet das dann einen
    // ueberzaehligen alten Stand und nicht den einzigen frischen (#853).
    const candidates = files.slice(cfg.keep).filter((f) => f.filename !== protect);

    for (const f of candidates) {
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
  const dbFiles = entries.filter(isBackupFile);
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
    // Dasselbe Kriterium wie getConfig(): nur eine nach dem Trimmen nicht-leere URL
    // kommt aus der Umgebung. Boolean(ENV_URL) sperrte schon bei reinem Leerraum,
    // obwohl getConfig() genau diesen Wert ignoriert und die DB-URL nimmt.
    envControlled: envValue(ENV_URL) !== undefined, // true → URL comes from env, UI fields are read-only
  };
}
