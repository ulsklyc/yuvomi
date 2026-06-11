/**
 * Module: Document storage
 * Purpose: Store and retrieve document binaries from SQLite, WebDAV, or DMS.
 */

import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP } from 'node:net';
import fetch from 'node-fetch';
import * as db from '../db.js';

const CONFIG_PREFIX = 'document_storage_webdav_';
const DEFAULT_BASE_PATH = 'yuvomi-documents';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_READ_BYTES = 5 * 1024 * 1024;

const ENV_FIELDS = {
  enabled: 'DOCUMENT_STORAGE_WEBDAV_ENABLED',
  url: 'DOCUMENT_STORAGE_WEBDAV_URL',
  username: 'DOCUMENT_STORAGE_WEBDAV_USERNAME',
  password: 'DOCUMENT_STORAGE_WEBDAV_PASSWORD',
  path: 'DOCUMENT_STORAGE_WEBDAV_PATH',
};
const PASSWORD_MASK_RE = /^(?:\*|•){4,}$/;
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const BLOCKED_NETWORKS = new BlockList();

for (const [address, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['2001:2::', 48, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]) {
  BLOCKED_NETWORKS.addSubnet(address, prefix, type);
}

let requestTimeoutMs = DEFAULT_TIMEOUT_MS;
let hostnameLookup = dnsLookup;
let privateNetworkAccessForTests = false;

export class StorageError extends Error {
  constructor(storageCode, message, options = {}) {
    super(message, options);
    this.name = 'StorageError';
    this.storageCode = storageCode;
  }
}

function cfgGet(field) {
  const row = db.get().prepare(
    'SELECT value FROM sync_config WHERE key = ?'
  ).get(`${CONFIG_PREFIX}${field}`);
  return row?.value ?? null;
}

function cfgSet(field, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(`${CONFIG_PREFIX}${field}`, value);
}

function cfgDelete(field) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?')
    .run(`${CONFIG_PREFIX}${field}`);
}

function readEnv(field) {
  const raw = process.env[ENV_FIELDS[field]];
  if (raw === undefined || raw.trim() === '') {
    return { controlled: false, value: null };
  }
  return {
    controlled: true,
    value: field === 'password' ? raw : raw.trim(),
  };
}

function parseEnabled(value) {
  if (value === null || value === undefined || String(value).trim() === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new StorageError(
    'DOCUMENT_STORAGE_INVALID_CONFIG',
    'WebDAV enabled must be true, false, 1, or 0.'
  );
}

function normalizeBasePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_BASE_PATH;
  if (/[\u0000-\u001f\u007f\\?#]/.test(raw) || raw.includes('://')) {
    throw new StorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      'The WebDAV base path is invalid.'
    );
  }

  const segments = raw.split('/').filter(Boolean).map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch (error) {
      throw new StorageError(
        'DOCUMENT_STORAGE_INVALID_CONFIG',
        'The WebDAV base path contains invalid encoding.',
        { cause: error }
      );
    }
    if (
      decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || decoded.includes(':')
      || /[\u0000-\u001f\u007f?#]/.test(decoded)
    ) {
      throw new StorageError(
        'DOCUMENT_STORAGE_INVALID_CONFIG',
        'The WebDAV base path contains an unsafe segment.'
      );
    }
    return decoded;
  });

  if (segments.length === 0) return DEFAULT_BASE_PATH;
  return segments.join('/');
}

function normalizeStorageKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('/') || /[\u0000-\u001f\u007f\\?#]/.test(raw)) {
    throw new StorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      'The document storage key is invalid.'
    );
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch (error) {
      throw new StorageError(
        'DOCUMENT_STORAGE_INVALID_CONFIG',
        'The document storage key contains invalid encoding.',
        { cause: error }
      );
    }
    if (
      !decoded
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || /[\u0000-\u001f\u007f?#]/.test(decoded)
    ) {
      throw new StorageError(
        'DOCUMENT_STORAGE_INVALID_CONFIG',
        'The document storage key contains an unsafe segment.'
      );
    }
  }
  return segments.join('/');
}

function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function collapsePathSlashes(value) {
  let result = '';
  let previousWasSlash = false;
  for (const char of value) {
    if (char === '/') {
      if (!previousWasSlash) result += char;
      previousWasSlash = true;
    } else {
      result += char;
      previousWasSlash = false;
    }
  }
  return result;
}

function validateUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new StorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      'The WebDAV URL is invalid.',
      { cause: error }
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new StorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      'The WebDAV URL must use HTTP or HTTPS without embedded credentials.'
    );
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = trimTrailingSlashes(parsed.pathname);
  return parsed;
}

function normalizedHostname(hostname) {
  const value = String(hostname).toLowerCase();
  return value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
}

function privateNetworkAllowed(config) {
  return privateNetworkAccessForTests || config.envControlled?.url === true;
}

function assertHostnameAllowed(hostname, allowPrivate = false) {
  const normalized = normalizedHostname(hostname);
  if (
    !allowPrivate
    && (
      normalized === 'localhost'
      || BLOCKED_HOST_SUFFIXES.some((suffix) => (
        normalized === suffix.slice(1) || normalized.endsWith(suffix)
      ))
    )
  ) {
    throw new StorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      'The WebDAV URL must not target a private network host.'
    );
  }
  return normalized;
}

function assertAddressAllowed(address) {
  const normalized = normalizedHostname(address);
  const detectedFamily = isIP(normalized);
  if (
    !detectedFamily
    || BLOCKED_NETWORKS.check(normalized, detectedFamily === 6 ? 'ipv6' : 'ipv4')
  ) {
    throw new StorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      'The WebDAV URL must resolve only to public network addresses.'
    );
  }
}

async function resolveHostAddresses(hostname, options = {}, allowPrivate = false) {
  const normalized = assertHostnameAllowed(hostname, allowPrivate);
  const literalFamily = isIP(normalized);
  if (literalFamily) {
    return [{ address: normalized, family: literalFamily }];
  }
  let addresses;
  try {
    addresses = await hostnameLookup(normalized, {
      all: true,
      family: Number(options.family) || 0,
      verbatim: true,
    });
  } catch (error) {
    throw new StorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      'The WebDAV hostname could not be resolved.',
      { cause: error }
    );
  }
  const results = Array.isArray(addresses) ? addresses : [addresses];
  if (results.length === 0) {
    throw new StorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      'The WebDAV hostname did not resolve to an address.'
    );
  }
  return results;
}

async function validatedHostAddresses(hostname, options, allowPrivate) {
  const addresses = await resolveHostAddresses(hostname, options, allowPrivate);
  if (!allowPrivate) {
    for (const { address } of addresses) {
      assertAddressAllowed(address);
    }
  }
  return addresses;
}

function validatedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    const lookupOptions = typeof options === 'number' ? { family: options } : options;
    validatedHostAddresses(hostname, lookupOptions, allowPrivate)
      .then((addresses) => {
        if (lookupOptions?.all) {
          callback(null, addresses);
          return;
        }
        const [selected] = addresses;
        callback(null, selected.address, selected.family);
      })
      .catch((error) => callback(error));
  };
}

function requestAgent(url, config) {
  const allowPrivate = privateNetworkAllowed(config);
  const hostname = assertHostnameAllowed(url.hostname, allowPrivate);
  const literalFamily = isIP(hostname);
  if (!allowPrivate && literalFamily) {
    assertAddressAllowed(hostname);
  }
  const Agent = url.protocol === 'https:' ? HttpsAgent : HttpAgent;
  return new Agent({ lookup: validatedLookup(allowPrivate) });
}

export async function assertWebdavTargetAllowed(config) {
  if (!config?.url) return;
  const url = validateUrl(config.url);
  if (privateNetworkAllowed(config)) return;
  const addresses = await resolveHostAddresses(url.hostname);
  for (const { address } of addresses) {
    assertAddressAllowed(address);
  }
}

function requireWebdavConfig(config) {
  if (!config.url || !config.username || !config.password) {
    throw new StorageError(
      'DOCUMENT_STORAGE_NOT_CONFIGURED',
      'WebDAV document storage is not fully configured.'
    );
  }
  validateUrl(config.url);
  normalizeBasePath(config.basePath);
  return config;
}

function isPasswordMask(value) {
  return typeof value === 'string' && PASSWORD_MASK_RE.test(value.trim());
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function encodePath(segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function remoteUrl(config, relativeSegments) {
  const url = validateUrl(config.url);
  const basePath = trimTrailingSlashes(url.pathname);
  const suffix = encodePath(relativeSegments);
  url.pathname = collapsePathSlashes(`${basePath}/${suffix}`);
  return url;
}

async function davFetch(config, method, relativeSegments, { body, headers } = {}) {
  const url = remoteUrl(config, relativeSegments);
  const agent = requestAgent(url, config);
  // SSRF-Schutz: URL ist ausschliesslich admin-konfigurierbar; agent nutzt
  // validatedLookup (blockiert private/loopback/link-local IPs zur DNS-Zeit)
  // und assertWebdavTargetAllowed als Pre-Flight. CodeQL js/request-forgery
  // ist als False Positive dismissed (GitHub-Alert #19) — Inline-Suppression-
  // Kommentare werden von GitHub Code Scanning fuer CodeQL nicht ausgewertet.
  return fetch(url, {
    method,
    redirect: 'manual',
    agent,
    headers: {
      Authorization: basicAuth(config.username, config.password),
      ...headers,
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
    ...(body === undefined ? {} : { body }),
  });
}

async function ensureCollections(config, extraSegments = []) {
  const baseSegments = normalizeBasePath(config.basePath).split('/');
  const segments = [...baseSegments, ...extraSegments];
  for (let index = 1; index <= segments.length; index += 1) {
    const response = await davFetch(config, 'MKCOL', segments.slice(0, index));
    if (!response.ok && response.status !== 405) {
      throw new Error(`MKCOL failed with status ${response.status}.`);
    }
  }
}

async function readResponseBuffer(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_READ_BYTES) {
    if (typeof response.body?.cancel === 'function') {
      await response.body.cancel();
    } else {
      response.body?.destroy();
    }
    throw new StorageError(
      'DOCUMENT_STORAGE_TOO_LARGE',
      'The remote document exceeds the 5 MiB read limit.'
    );
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  if (typeof response.body.getReader !== 'function') {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > MAX_READ_BYTES) {
        response.body.destroy();
        throw new StorageError(
          'DOCUMENT_STORAGE_TOO_LARGE',
          'The remote document exceeds the 5 MiB read limit.'
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_READ_BYTES) {
        await reader.cancel();
        throw new StorageError(
          'DOCUMENT_STORAGE_TOO_LARGE',
          'The remote document exceeds the 5 MiB read limit.'
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function slug(value, fallback) {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function filenameParts(originalName) {
  const basename = String(originalName ?? '').split(/[\\/]/).pop() || 'document';
  const extensionMatch = basename.match(/(\.[a-z0-9]{1,16})$/i);
  const extension = extensionMatch ? extensionMatch[1].toLowerCase() : '';
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  return {
    stem: slug(stem, 'document'),
    extension,
  };
}

function toStorageError(error, storageCode, message) {
  if (error instanceof StorageError) {
    if (
      error.storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
      || error.storageCode === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
      || error.storageCode === 'DOCUMENT_STORAGE_TOO_LARGE'
    ) {
      return error;
    }
  }
  return new StorageError(storageCode, message, { cause: error });
}

export function getConfig() {
  const envControlled = {};
  const effective = {};
  for (const field of Object.keys(ENV_FIELDS)) {
    const env = readEnv(field);
    envControlled[field] = env.controlled;
    effective[field] = env.controlled ? env.value : cfgGet(field);
  }

  return {
    enabled: parseEnabled(effective.enabled),
    url: effective.url ? String(effective.url).trim() : null,
    username: effective.username ? String(effective.username).trim() : null,
    password: effective.password || null,
    basePath: normalizeBasePath(effective.path),
    lastTest: cfgGet('last_test'),
    lastError: cfgGet('last_error'),
    envControlled,
  };
}

export function getStatus() {
  const config = getConfig();
  let configured = false;
  try {
    requireWebdavConfig(config);
    configured = true;
  } catch {
    configured = false;
  }
  return {
    enabled: config.enabled,
    url: config.url,
    username: config.username,
    passwordConfigured: Boolean(config.password),
    basePath: config.basePath,
    configured,
    lastTest: config.lastTest,
    lastError: config.lastError,
    envControlled: config.envControlled,
  };
}

export function isWebdavUploadEnabled() {
  return getConfig().enabled;
}

export function resolveConfig(overrides = {}) {
  const current = getConfig();
  const config = { ...current };
  const controlled = current.envControlled;

  if (Object.hasOwn(overrides, 'enabled') && !controlled.enabled) {
    config.enabled = parseEnabled(overrides.enabled);
  }
  if (Object.hasOwn(overrides, 'url') && !controlled.url) {
    const value = String(overrides.url ?? '').trim();
    if (value) validateUrl(value);
    config.url = value || null;
  }
  if (Object.hasOwn(overrides, 'username') && !controlled.username) {
    const value = String(overrides.username ?? '').trim();
    config.username = value || null;
  }
  if (!controlled.password) {
    if (overrides.clear_password === true) {
      config.password = null;
    } else if (Object.hasOwn(overrides, 'password')) {
      const value = String(overrides.password ?? '');
      if (value.trim() && !isPasswordMask(value)) config.password = value;
    }
  }
  if (
    (Object.hasOwn(overrides, 'path') || Object.hasOwn(overrides, 'basePath'))
    && !controlled.path
  ) {
    config.basePath = normalizeBasePath(overrides.path ?? overrides.basePath);
  }

  return config;
}

export function getEffectiveTarget(config = getConfig()) {
  if (!config.url) return null;
  try {
    const url = validateUrl(config.url);
    const basePath = trimTrailingSlashes(url.pathname);
    url.pathname = collapsePathSlashes(`${basePath}/${normalizeBasePath(config.basePath)}`);
    const target = url.toString();
    return target.endsWith('/') ? target.slice(0, -1) : target;
  } catch {
    return null;
  }
}

export function saveConfig(data = {}) {
  const controlled = getConfig().envControlled;
  const fields = {
    enabled: data.enabled,
    url: data.url,
    username: data.username,
    password: data.password,
    path: data.path ?? data.basePath,
  };
  if (fields.enabled !== undefined && !controlled.enabled) {
    cfgSet('enabled', parseEnabled(fields.enabled) ? '1' : '0');
  }
  for (const field of ['url', 'username', 'password']) {
    if (fields[field] === undefined || controlled[field]) continue;
    const value = String(fields[field] ?? '');
    if (field === 'password') {
      if (value.trim() && !isPasswordMask(value)) cfgSet(field, value);
    } else if (value.trim() === '') {
      cfgDelete(field);
    } else {
      cfgSet(field, value.trim());
    }
  }
  if (data.clear_password === true && !controlled.password) {
    cfgDelete('password');
  }
  if (fields.path !== undefined && !controlled.path) {
    const value = String(fields.path);
    if (value.trim() === '') cfgDelete('path');
    else cfgSet('path', normalizeBasePath(value));
  }
  return getStatus();
}

export function buildStorageKey({ category, originalName } = {}) {
  const safeCategory = slug(category, 'documents');
  const { stem, extension } = filenameParts(originalName);
  return `${safeCategory}/${randomUUID()}-${stem}${extension}`;
}

export async function stageDocumentUpload({
  buffer,
  mime = 'application/octet-stream',
  category,
  originalName,
}) {
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const config = getConfig();
  if (!config.enabled) {
    return {
      storage_backend: 'local',
      storage_provider: 'local',
      storage_key: null,
      content_data: content.toString('base64'),
    };
  }

  requireWebdavConfig(config);
  const storageKey = buildStorageKey({ category, originalName });
  const keySegments = normalizeStorageKey(storageKey).split('/');
  try {
    await ensureCollections(config, keySegments.slice(0, -1));
    const response = await davFetch(config, 'PUT', [
      ...config.basePath.split('/'),
      ...keySegments,
    ], {
      body: content,
      headers: { 'Content-Type': mime },
    });
    if (!response.ok) {
      throw new Error(`PUT failed with status ${response.status}.`);
    }
  } catch (error) {
    throw toStorageError(
      error,
      'DOCUMENT_STORAGE_UPLOAD_FAILED',
      'The document could not be uploaded to WebDAV.'
    );
  }

  return {
    storage_backend: 'webdav',
    storage_provider: 'external',
    storage_key: storageKey,
    content_data: '',
  };
}

export async function verifyExistingWebdavDocument(document, config) {
  requireWebdavConfig(config);
  if (document?.storage_backend !== 'webdav') {
    throw new StorageError(
      'DOCUMENT_STORAGE_CONFIG_PROTECTED',
      'An existing WebDAV document is required for configuration verification.'
    );
  }
  try {
    const response = await davFetch(config, 'GET', [
      ...normalizeBasePath(config.basePath).split('/'),
      ...normalizeStorageKey(document.storage_key).split('/'),
    ]);
    if (!response.ok) {
      throw new Error(`GET failed with status ${response.status}.`);
    }
    await readResponseBuffer(response);
    return { ok: true };
  } catch (error) {
    throw new StorageError(
      'DOCUMENT_STORAGE_CONFIG_PROTECTED',
      'The proposed WebDAV configuration cannot read an existing document.',
      { cause: error }
    );
  }
}

export async function readDocumentContent(document, { dmsResolver } = {}) {
  if (document.storage_backend === 'local') {
    return {
      buffer: Buffer.from(document.content_data || '', 'base64'),
      mime: document.mime_type || 'application/octet-stream',
    };
  }
  if (document.storage_backend === 'dms') {
    if (!dmsResolver) {
      throw new StorageError(
        'DOCUMENT_STORAGE_READ_FAILED',
        'The DMS document is not available.'
      );
    }
    try {
      const resolved = await dmsResolver(document);
      if (Buffer.isBuffer(resolved)) {
        return {
          buffer: resolved,
          mime: document.mime_type || 'application/octet-stream',
        };
      }
      return {
        buffer: Buffer.from(resolved.buffer),
        mime: resolved.mime || document.mime_type || 'application/octet-stream',
      };
    } catch (error) {
      throw toStorageError(
        error,
        'DOCUMENT_STORAGE_READ_FAILED',
        'The DMS document could not be read.'
      );
    }
  }
  if (document.storage_backend !== 'webdav') {
    throw new StorageError(
      'DOCUMENT_STORAGE_READ_FAILED',
      'The document storage backend is not supported.'
    );
  }

  const config = requireWebdavConfig(getConfig());
  try {
    const response = await davFetch(config, 'GET', [
      ...config.basePath.split('/'),
      ...normalizeStorageKey(document.storage_key).split('/'),
    ]);
    if (!response.ok) {
      throw new Error(`GET failed with status ${response.status}.`);
    }
    return {
      buffer: await readResponseBuffer(response),
      mime: document.mime_type
        || response.headers.get('content-type')
        || 'application/octet-stream',
    };
  } catch (error) {
    throw toStorageError(
      error,
      'DOCUMENT_STORAGE_READ_FAILED',
      'The WebDAV document could not be read.'
    );
  }
}

export async function deleteDocumentContent(document) {
  if (document.storage_backend !== 'webdav') return;
  const config = requireWebdavConfig(getConfig());
  try {
    const response = await davFetch(config, 'DELETE', [
      ...config.basePath.split('/'),
      ...normalizeStorageKey(document.storage_key).split('/'),
    ]);
    if (!response.ok && response.status !== 404) {
      throw new Error(`DELETE failed with status ${response.status}.`);
    }
  } catch (error) {
    throw toStorageError(
      error,
      'DOCUMENT_STORAGE_DELETE_FAILED',
      'The WebDAV document could not be deleted.'
    );
  }
}

export async function cleanupStagedUpload(staged) {
  try {
    return await deleteDocumentContent(staged);
  } catch (error) {
    throw new StorageError(
      'DOCUMENT_STORAGE_CLEANUP_FAILED',
      'The staged WebDAV document could not be cleaned up.',
      { cause: error }
    );
  }
}

export async function testConnection(overrides = {}) {
  const config = resolveConfig(overrides);
  const testedAt = new Date().toISOString();
  let testKey;
  let primaryError;

  try {
    requireWebdavConfig(config);
    await ensureCollections(config);
    testKey = `.connection-test-${randomUUID()}.bin`;
    const expected = Buffer.from(`yuvomi-document-storage:${randomUUID()}`);
    const putResponse = await davFetch(config, 'PUT', [
      ...config.basePath.split('/'),
      testKey,
    ], {
      body: expected,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!putResponse.ok) {
      throw new Error(`PUT failed with status ${putResponse.status}.`);
    }

    const getResponse = await davFetch(config, 'GET', [
      ...config.basePath.split('/'),
      testKey,
    ]);
    if (!getResponse.ok) {
      throw new Error(`GET failed with status ${getResponse.status}.`);
    }
    const actual = await readResponseBuffer(getResponse);
    if (!actual.equals(expected)) {
      throw new Error('WebDAV connection verification returned different bytes.');
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (testKey) {
      try {
        const response = await davFetch(config, 'DELETE', [
          ...config.basePath.split('/'),
          testKey,
        ]);
        if (!response.ok && response.status !== 404) {
          throw new Error(`DELETE failed with status ${response.status}.`);
        }
      } catch (error) {
        primaryError ||= error;
      }
    }
  }

  if (primaryError) {
    if (primaryError instanceof StorageError) {
      cfgSet('last_error', primaryError.message);
      throw primaryError;
    }
    const error = new StorageError(
      'DOCUMENT_STORAGE_CONNECTION_TEST_FAILED',
      `WebDAV connection test failed: ${primaryError.message}`,
      { cause: primaryError }
    );
    cfgSet('last_error', error.message);
    throw error;
  }
  cfgSet('last_test', testedAt);
  cfgDelete('last_error');
  return { ok: true };
}

export function __setRequestTimeoutForTests(timeoutMs) {
  requestTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

export function __setHostnameLookupForTests(lookup) {
  hostnameLookup = lookup || dnsLookup;
}

export function __setPrivateNetworkAccessForTests(enabled = false) {
  privateNetworkAccessForTests = enabled;
}
