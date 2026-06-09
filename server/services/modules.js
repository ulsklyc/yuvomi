/**
 * Module: Third-party module registry
 * Purpose: Discover Yuvomi modules from /modules, validate manifests, and expose enabled client modules.
 * Dependencies: node:fs/promises, server/db.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as db from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('Modules');

const MODULES_DIR = path.resolve(process.env.MODULES_DIR || path.join(import.meta.dirname, '..', '..', 'modules'));
const DISABLED_KEY = 'third_party_disabled_modules';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SAFE_RELATIVE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function parseDisabledModules() {
  try {
    const parsed = JSON.parse(cfgGet(DISABLED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function setDisabledModules(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && ID_RE.test(id)))];
  cfgSet(DISABLED_KEY, JSON.stringify(unique));
  return unique;
}

function isSafeRelativeFile(value) {
  if (typeof value !== 'string' || !SAFE_RELATIVE_RE.test(value)) return false;
  if (value.includes('..') || value.startsWith('/') || value.includes('\\')) return false;
  return true;
}

function modulePublicUrl(id, relPath) {
  return `/api/v1/modules/assets/${encodeURIComponent(id)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

function normalizeManifest(raw, folderName) {
  const manifest = raw && typeof raw === 'object' ? raw : {};
  const id = String(manifest.id || folderName || '').trim();
  if (!ID_RE.test(id)) throw new Error('module.json must define a lowercase id using letters, numbers and hyphens.');
  if (id !== folderName) throw new Error('module id must match the folder name.');

  const entry = String(manifest.entry || '').trim();
  if (!isSafeRelativeFile(entry) || !entry.endsWith('.js')) {
    throw new Error('module.json entry must be a safe relative JavaScript file path.');
  }

  const style = manifest.style ? String(manifest.style).trim() : '';
  if (style && (!isSafeRelativeFile(style) || !style.endsWith('.css'))) {
    throw new Error('module.json style must be a safe relative CSS file path.');
  }

  const name = String(manifest.name || id).trim().slice(0, 80);
  const version = String(manifest.version || '').trim().slice(0, 40);
  const description = String(manifest.description || '').trim().slice(0, 240);
  const icon = String(manifest.icon || 'box').trim().slice(0, 40);
  const accent = /^#[0-9a-fA-F]{6}$/.test(manifest.accent || '') ? manifest.accent : '#6366F1';
  const menu = manifest.menu && typeof manifest.menu === 'object' ? manifest.menu : {};
  const showInMenu = menu.show !== false;
  const label = String(menu.label || name).trim().slice(0, 40);
  const menuIcon = String(menu.icon || icon).trim().slice(0, 40);
  const order = Number.isFinite(Number(menu.order)) ? Number(menu.order) : 1000;
  const pathValue = String(menu.path || `/m/${id}`).trim();
  const routePath = pathValue === `/m/${id}` ? pathValue : `/m/${id}`;

  return {
    id,
    name,
    version,
    description,
    icon,
    accent,
    entry,
    style: style || null,
    route: {
      path: routePath,
      entry: modulePublicUrl(id, entry),
      style: style ? modulePublicUrl(id, style) : null,
    },
    menu: {
      show: showInMenu,
      label,
      icon: menuIcon,
      order,
    },
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readModule(folderName, disabledSet) {
  const basePath = path.join(MODULES_DIR, folderName);
  try {
    const stat = await fs.stat(basePath);
    if (!stat.isDirectory()) return null;
    const manifestPath = path.join(basePath, 'module.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const manifest = normalizeManifest(raw, folderName);
    const entryPath = path.resolve(basePath, manifest.entry);
    if (!entryPath.startsWith(`${basePath}${path.sep}`) || !(await pathExists(entryPath))) {
      throw new Error('entry file does not exist.');
    }
    if (manifest.style) {
      const stylePath = path.resolve(basePath, manifest.style);
      if (!stylePath.startsWith(`${basePath}${path.sep}`) || !(await pathExists(stylePath))) {
        throw new Error('style file does not exist.');
      }
    }
    const enabled = !disabledSet.has(manifest.id);
    return {
      ...manifest,
      enabled,
      status: enabled ? 'enabled' : 'disabled',
      error: null,
    };
  } catch (err) {
    return {
      id: folderName,
      name: folderName,
      version: '',
      description: '',
      icon: 'triangle-alert',
      accent: '#EF4444',
      route: null,
      menu: { show: false, label: folderName, icon: 'triangle-alert', order: 1000 },
      enabled: false,
      status: 'error',
      error: err?.message || 'Module could not be loaded.',
    };
  }
}

async function listModules({ admin = false } = {}) {
  await fs.mkdir(MODULES_DIR, { recursive: true });
  const disabledSet = new Set(parseDisabledModules());
  const entries = await fs.readdir(MODULES_DIR).catch((err) => {
    log.error('Could not read modules directory:', err);
    return [];
  });

  const modules = (await Promise.all(entries.map((entry) => readModule(entry, disabledSet))))
    .filter(Boolean)
    .sort((a, b) => (a.menu?.order ?? 1000) - (b.menu?.order ?? 1000) || a.name.localeCompare(b.name));

  return admin ? modules : modules.filter((module) => module.enabled && module.status === 'enabled');
}

async function setModuleEnabled(id, enabled) {
  if (!ID_RE.test(String(id || ''))) {
    const err = new Error('Invalid module id.');
    err.status = 400;
    throw err;
  }

  const modules = await listModules({ admin: true });
  const target = modules.find((module) => module.id === id);
  if (!target) {
    const err = new Error('Module not found.');
    err.status = 404;
    throw err;
  }
  if (target.status === 'error' && enabled) {
    const err = new Error(target.error || 'Module has errors and cannot be enabled.');
    err.status = 400;
    throw err;
  }

  const disabled = new Set(parseDisabledModules());
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  setDisabledModules([...disabled]);
  return (await listModules({ admin: true })).find((module) => module.id === id);
}

async function resolveAssetPath(id, relPath) {
  const modules = await listModules({ admin: false });
  const module = modules.find((item) => item.id === id);
  if (!module) {
    const err = new Error('Module not found or disabled.');
    err.status = 404;
    throw err;
  }
  if (!isSafeRelativeFile(relPath)) {
    const err = new Error('Invalid module asset path.');
    err.status = 400;
    throw err;
  }
  const basePath = path.join(MODULES_DIR, id);
  const assetPath = path.resolve(basePath, relPath);
  if (!assetPath.startsWith(`${basePath}${path.sep}`)) {
    const err = new Error('Invalid module asset path.');
    err.status = 400;
    throw err;
  }
  if (!(await pathExists(assetPath))) {
    const err = new Error('Module asset not found.');
    err.status = 404;
    throw err;
  }
  return assetPath;
}

export { MODULES_DIR, listModules, setModuleEnabled, resolveAssetPath };
