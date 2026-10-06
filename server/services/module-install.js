/**
 * Module: Third-party module installation
 * Purpose: Install a module from an archive (uploaded ZIP or GitHub zipball), replace
 *          or delete it - the server half of Settings → Modules → Add custom module.
 * Dependencies: node:fs/promises, server/services/zip-reader.js, server/services/modules.js
 *
 * TRUST MODEL (DECISIONS.md, 12). A module is same-origin JavaScript that runs with
 * the session of every member who opens it. Until this feature, putting such script
 * on the server took filesystem access; with it, a foothold in an admin's browser
 * session is enough, and what it writes outlives the session, a password change and
 * a revoked token. No design closes that, so the feature is the OPERATOR'S choice:
 * off unless MODULES_ALLOW_WEB_INSTALL is set (isWebInstallEnabled). With it on, the
 * routes are admin-only and session-only, and every install and every replace
 * lands DISABLED: the install record in the folder says `approved: false` until an
 * admin switches the module on in a browser session (modules.js setModuleEnabled).
 * The record travels with the folder, so a restored or fresh database cannot turn
 * on what nobody looked at. The web interface deletes only folders that carry such
 * a record; a hand-copied folder is the operator's and stays.
 * Nothing from the archive is ever executed on the server; it is only written to disk
 * and validated as data by the same code the loader uses.
 *
 * TRANSACTION. Files are staged in `MODULES_DIR/.install-<random>/<id>/` (same
 * filesystem, so the final step is a rename), validated with loadModuleDir(), and only
 * then moved into place. A replace moves the old folder aside first and puts it back
 * if anything fails. listModules() ignores dot-entries, so a half-written staging
 * folder is never mistaken for a module.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../logger.js';
import { readPrivateNetworkOptIn } from '../utils/ssrf.js';
import { readZipArchive, ZipError, ZIP_LIMITS, isWindowsReservedName } from './zip-reader.js';
import { MODULE_ID_RE } from './module-capabilities.js';
import {
  MODULES_DIR,
  INSTALL_META_FILE,
  listModules,
  loadModuleDir,
  readInstallMeta,
  setModuleDisabledFlag,
} from './modules.js';

const log = createLogger('ModuleInstall');

// One number for the HTTP body limit, the GitHub download cap and the reader.
export const MAX_ZIP_BYTES = ZIP_LIMITS.maxCompressed;
export const MAX_ZIP_MB = MAX_ZIP_BYTES / (1024 * 1024);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CANDIDATE_DEPTH = 6;
const STALE_STAGING_MS = 60 * 60 * 1000;

// ── The switch ──────────────────────────────────────────────────────────────
// Read once at startup, like every other operator flag, and parsed by the rule
// the private-network opt-ins use: exactly `true` or `1` opens it, anything
// else (unset included) keeps it shut. Not a runtime read: the operator sets it
// in .env, the Unraid template or the Portainer stack, and a value that could
// change under a running server would be a second switch nobody documented.
export const WEB_INSTALL_ENV = 'MODULES_ALLOW_WEB_INSTALL';
let webInstallEnabled = readPrivateNetworkOptIn(WEB_INSTALL_ENV);

/** Whether the operator opened installing and deleting modules from Settings. */
export function isWebInstallEnabled() {
  return webInstallEnabled;
}

export function __setWebInstallEnabledForTests(value) {
  const previous = webInstallEnabled;
  webInstallEnabled = Boolean(value);
  return () => { webInstallEnabled = previous; };
}

// What a browser module can legitimately consist of. Everything else (shell
// scripts, binaries, server code in other languages, dotfiles) is skipped and
// reported - not an error, because a GitHub repo often carries CI files or a
// build script next to the module folder, and refusing the whole install for a
// Makefile would only teach admins to repack archives by hand.
const ALLOWED_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.md', '.txt', '.map',
]);
const LEGAL_FILE_RE = /^(license|licence|notice|readme)(\.[a-z0-9]+)?$/i;

// HTTP status per stable reason. One table for zip, GitHub and filesystem
// errors so the route never has to know which layer failed.
const REASON_STATUS = {
  bad_url: 400,
  not_zip: 400,
  unsafe_path: 400,
  symlink: 400,
  encrypted: 400,
  zip64: 400,
  method: 400,
  crc: 400,
  duplicate: 400,
  corrupt: 400,
  bad_manifest: 400,
  no_manifest: 400,
  path_not_found: 400,
  bad_id: 400,
  // 400 on delete (the id names something that is not a module folder); an
  // install that runs into the same thing answers 409, see installFilesUnlocked.
  not_a_module: 400,
  // The two 403s of this feature (the switch, the browser session) are sent by
  // the route before anything here runs; they are not InstallError reasons.
  exists: 409,
  busy: 409,
  // Delete: the folder has no install record, so the web did not put it there
  // and will not take it away (deleteModule).
  not_web_installed: 409,
  too_large: 413,
  too_many_entries: 413,
  bomb: 413,
  unsupported_encoding: 415,
  multiple: 422,
  repo_not_found: 404,
  ref_not_found: 404,
  not_found: 404,
  rate_limited: 429,
  install_rate_limited: 429,
  github_failed: 502,
  not_writable: 503,
};

export class InstallError extends Error {
  /**
   * @param {string} reason  stable machine-readable code (see REASON_STATUS)
   * @param {string} message human-readable English message
   * @param {object} [extra] extra JSON fields for the response (candidates, existing, …)
   * @param {number} [status] overrides the table, for the one reason whose status
   *        depends on the operation (not_a_module)
   */
  constructor(reason, message, extra = {}, status = undefined) {
    super(message);
    this.name = 'InstallError';
    this.reason = reason;
    this.status = status || REASON_STATUS[reason] || 500;
    this.extra = extra;
  }
}

// ── Test hooks ──────────────────────────────────────────────────────────────
// Three failure modes cannot be produced reliably on every OS: a read-only
// modules folder (chmod is a no-op for directories on Windows), a rename that
// fails halfway through a replace, and a file name the filesystem refuses
// (which names those are depends on the filesystem). Tests swap these
// primitives instead.
const fsOps = {
  access: (p, mode) => fs.access(p, mode),
  rename: (from, to) => fs.rename(from, to),
  writeFile: (p, data, opts) => fs.writeFile(p, data, opts),
};

export function __setInstallFsOpsForTests(overrides = {}) {
  const previous = { ...fsOps };
  Object.assign(fsOps, overrides);
  return () => Object.assign(fsOps, previous);
}

// ── Lock ────────────────────────────────────────────────────────────────────
// One install or delete at a time. A second one is refused instead of queued:
// two admins replacing the same module at once would otherwise race on the
// backup folder, and the second would silently overwrite the first.
let busy = false;

export function withInstallLock(fn) {
  if (busy) {
    return Promise.reject(new InstallError('busy', 'Another module install or delete is in progress. Try again in a moment.'));
  }
  busy = true;
  return Promise.resolve().then(fn).finally(() => { busy = false; });
}

// ── Writability ─────────────────────────────────────────────────────────────

const NOT_WRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

export async function assertWritable() {
  try {
    await fs.mkdir(MODULES_DIR, { recursive: true });
    await fsOps.access(MODULES_DIR, fsConstants.W_OK);
  } catch (err) {
    if (NOT_WRITABLE_CODES.has(err?.code)) {
      throw new InstallError('not_writable',
        'The modules folder on the server is not writable. Install the module by copying its folder into modules/ instead.');
    }
    throw err;
  }
}

export async function isWritable() {
  try {
    await assertWritable();
    return true;
  } catch {
    return false;
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────
// WHY. Writable is not the same as kept. The image creates /app/modules and the
// entrypoint makes it writable, so in a container WITHOUT a volume on it an
// install works - and is gone with the next image update, because the folder
// lives in the container's own layer. Umbrel's compose file is exactly that
// case (no modules mount, and no env marker that would name Umbrel). The page
// warns instead of refusing: a test install or a household that reinstalls
// after updates is still served.
//
// HOW (best effort, Linux only). Outside a container the folder is a normal
// directory on the host: persistent. Inside one, /proc/self/mountinfo says
// which mount the folder lives on: the root overlay "/" means the container
// layer, any other mount point at or above it is a volume or bind mount.
// Anything unreadable answers null ("unknown") and the page stays quiet.

const persistenceProbe = {
  platform: process.platform,
  containerMarkers: ['/.dockerenv', '/run/.containerenv'],
  cgroupPath: '/proc/1/cgroup',
  mountinfoPath: '/proc/self/mountinfo',
  modulesDir: null, // null = MODULES_DIR
  realpath: (p) => fs.realpath(p),
};

export function __setPersistenceProbeForTests(overrides = {}) {
  const previous = { ...persistenceProbe, containerMarkers: [...persistenceProbe.containerMarkers] };
  Object.assign(persistenceProbe, overrides);
  // Back to exactly the previous shape: a key a test added (a typo, a probe
  // field that no longer exists) must not leak into the next test.
  return () => {
    for (const key of Object.keys(persistenceProbe)) {
      if (!(key in previous)) delete persistenceProbe[key];
    }
    Object.assign(persistenceProbe, previous);
  };
}

// mountinfo escapes space, tab, newline and backslash as \ooo.
function unescapeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/** `[{ mountPoint, fsType }]` from /proc/self/mountinfo text. */
export function parseMountinfo(text) {
  const mounts = [];
  for (const line of String(text).split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const fields = line.slice(0, sep).split(' ');
    if (fields.length < 5) continue;
    mounts.push({ mountPoint: unescapeMountPath(fields[4]), fsType: line.slice(sep + 3).split(' ')[0] || '' });
  }
  return mounts;
}

async function readTextOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function runsInContainer(mounts) {
  for (const marker of persistenceProbe.containerMarkers) {
    if (await fs.access(marker).then(() => true, () => false)) return true;
  }
  const cgroup = await readTextOrNull(persistenceProbe.cgroupPath);
  if (cgroup && /docker|containerd|kubepods|libpod|lxc/i.test(cgroup)) return true;
  // cgroup v2 shows only "0::/" inside Docker; the root filesystem being an
  // overlay is then the remaining hint.
  return mounts.some((m) => m.mountPoint === '/' && m.fsType === 'overlay');
}

/**
 * true = the modules folder survives an update, false = it is in the container
 * layer, null = cannot tell. Never throws.
 */
export async function isPersistent() {
  try {
    if (persistenceProbe.platform !== 'linux') return true;
    const info = await readTextOrNull(persistenceProbe.mountinfoPath);
    const mounts = info === null ? [] : parseMountinfo(info);
    if (!(await runsInContainer(mounts))) return true;
    if (info === null || !mounts.length) return null;
    const dir = persistenceProbe.modulesDir || MODULES_DIR;
    let real;
    try {
      real = await persistenceProbe.realpath(dir);
    } catch {
      real = path.posix.resolve(dir);
    }
    real = String(real).replace(/\/+$/, '') || '/';
    // The innermost mount at or above the folder decides.
    let best = null;
    for (const { mountPoint } of mounts) {
      const mp = mountPoint.replace(/\/+$/, '') || '/';
      const covers = mp === '/' || real === mp || real.startsWith(`${mp}/`);
      if (covers && (!best || mp.length > best.length)) best = mp;
    }
    if (!best) return null;
    return best !== '/';
  } catch {
    return null;
  }
}

// ── Locating the module inside the archive ─────────────────────────────────

function isIgnoredSegment(seg) {
  return seg === 'node_modules' || seg.startsWith('.');
}

function dirOf(name) {
  const i = name.lastIndexOf('/');
  return i < 0 ? '' : name.slice(0, i);
}

/** The single top folder every file lives in (GitHub zipballs always have one), or ''. */
function commonTopFolder(files) {
  let top = null;
  for (const f of files) {
    const i = f.name.indexOf('/');
    if (i < 0) return '';
    const seg = f.name.slice(0, i);
    if (top === null) top = seg;
    else if (top !== seg) return '';
  }
  return top || '';
}

function parseJsonSafe(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** Normalizes a repo-relative sub-path option; returns '' for the root, null if invalid. */
export function normalizeSubPath(value) {
  if (value === undefined || value === null) return '';
  const p = String(value).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!p) return '';
  if (p.length > 500) return null;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.includes(':'))) return null;
  return segs.join('/');
}

/**
 * Picks the folder that holds the module. Returns `{ dir, relDir }`: `dir` is the
 * folder inside the archive ('' = archive root), `relDir` the same relative to the
 * stripped top folder (what the user calls the path).
 */
export function locateModule(files, { path: subPath } = {}) {
  const top = commonTopFolder(files);
  const strip = (dir) => {
    if (!top) return dir;
    if (dir === top) return '';
    return dir.startsWith(`${top}/`) ? dir.slice(top.length + 1) : dir;
  };

  const candidates = [];
  for (const f of files) {
    const base = f.name.slice(f.name.lastIndexOf('/') + 1);
    if (base !== 'module.json') continue;
    const dir = dirOf(f.name);
    const relDir = strip(dir);
    // Depth counts from below the stripped top folder: that is the path the
    // admin sees in the repository, and what "six folders deep" in MODULES.md
    // means. Counted on the raw name, a GitHub zipball would lose one level.
    const depth = relDir ? relDir.split('/').length : 0;
    if (depth > MAX_CANDIDATE_DEPTH) continue;
    if ((dir ? dir.split('/') : []).some(isIgnoredSegment)) continue;
    // The size limit applies to every candidate, not only to the chosen one:
    // multipleError() parses each candidate for its name and version, and a
    // 10 MB module.json (the per-file limit) would be parsed for a question
    // the admin has not even been asked yet. Refused, not skipped: an archive
    // with such a file in a module folder is not one to pick from.
    if (f.data.length > MAX_MANIFEST_BYTES) {
      throw new InstallError('bad_manifest', `module.json is larger than 64 KiB: ${relDir || '(archive root)'}`);
    }
    candidates.push({ dir, relDir, file: f });
  }

  // An explicit '' is a real choice - "the module at the archive root" - and
  // not the same as no path at all: the candidate list offers the root as `''`
  // next to nested modules, and picking it must not loop back into `multiple`.
  if (subPath !== undefined && subPath !== null) {
    const wanted = normalizeSubPath(subPath);
    if (wanted === null) {
      throw new InstallError('path_not_found', 'The module path is not a valid folder path.');
    }
    // The stripped form is what a repository URL shows; the raw form is what a
    // hand-made ZIP with a top folder shows. Accept both, stripped first.
    const hit = candidates.find((c) => c.relDir === wanted) || candidates.find((c) => c.dir === wanted);
    if (hit) return hit;
    // A tree URL often points at the folder that HOLDS the modules
    // (`.../tree/main/modules`). Offer what is below it instead of a dead end.
    const under = candidates.filter((c) => wanted === ''
      || c.relDir.startsWith(`${wanted}/`) || c.dir.startsWith(`${wanted}/`));
    if (under.length) throw multipleError(under);
    if (wanted === '') throw new InstallError('no_manifest', 'The archive does not contain a module.json.');
    throw new InstallError('path_not_found', `No module.json found in folder "${wanted}" of the archive.`);
  }

  if (candidates.length === 0) {
    throw new InstallError('no_manifest', 'The archive does not contain a module.json.');
  }
  if (candidates.length > 1) throw multipleError(candidates);
  return candidates[0];
}

function multipleError(candidates) {
  const list = candidates.map((c) => {
    const m = parseJsonSafe(c.file.data) || {};
    const s = (v) => (typeof v === 'string' ? v.slice(0, 80) : null);
    return { path: c.relDir, id: s(m.id), name: s(m.name), version: s(m.version) };
  });
  return new InstallError('multiple', 'The archive contains several modules. Choose one.', { candidates: list });
}

function isAllowedFile(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  if (LEGAL_FILE_RE.test(base)) {
    const ext = path.extname(base).toLowerCase();
    if (!ext || ALLOWED_EXTENSIONS.has(ext)) return true;
  }
  return ALLOWED_EXTENSIONS.has(path.extname(base).toLowerCase());
}

/**
 * Splits the chosen folder's subtree into files to write and skipped paths.
 * Paths with a dot segment are always skipped: `.yuvomi-install.json` belongs to
 * the installer, and `.git`/`.github` are never part of a module.
 */
function selectFiles(files, dir) {
  const prefix = dir ? `${dir}/` : '';
  // Every other folder below with its own module.json is another module (a
  // repo whose root module ships examples in plugins/x/), and it is installed
  // on its own if at all. Copying it along would put a second module's code,
  // unreviewed, inside this one's folder and serve it under this module's id.
  // All of them, not only the offered candidates: one too deep to be offered
  // is still not part of this module.
  const nested = [];
  for (const f of files) {
    if (f.name.slice(f.name.lastIndexOf('/') + 1) !== 'module.json') continue;
    const other = dirOf(f.name);
    if (other !== dir && (prefix === '' || other.startsWith(prefix))) nested.push(`${other}/`);
  }
  const keep = [];
  const skipped = [];
  for (const f of files) {
    if (prefix && !f.name.startsWith(prefix)) continue;
    if (nested.some((n) => f.name.startsWith(n))) continue;
    const rel = f.name.slice(prefix.length);
    if (rel.split('/').some((s) => s.startsWith('.')) || !isAllowedFile(rel)) {
      skipped.push(rel);
      continue;
    }
    keep.push({ rel, data: f.data });
  }
  skipped.sort();
  return { keep, skipped };
}

function readManifest(file) {
  if (file.data.length > MAX_MANIFEST_BYTES) {
    throw new InstallError('bad_manifest', 'module.json is larger than 64 KiB.');
  }
  const raw = parseJsonSafe(file.data);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InstallError('bad_manifest', 'module.json is not a valid JSON object.');
  }
  if (typeof raw.id !== 'string' || !MODULE_ID_RE.test(raw.id)) {
    throw new InstallError('bad_manifest',
      'module.json must define an id of 3 to 64 lowercase letters, digits and hyphens.');
  }
  // The id becomes the folder name under modules/. MODULE_ID_RE lets `con`,
  // `nul`, `aux`, `prn`, `com1`-`com9` and `lpt1`-`lpt9` through, which the
  // archive reader refuses for every entry; the same list applies to the one
  // name the installer itself creates. An id has no dot, so the whole id is
  // the name.
  if (isWindowsReservedName(raw.id)) {
    throw new InstallError('bad_manifest', `module.json id "${raw.id}" is a reserved device name on Windows.`);
  }
  return raw;
}

/** Name and version of the installed module, for the replace question. Never throws. */
async function readExistingManifest(target) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(target, 'module.json'), 'utf8'));
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    return { name: str(raw?.name, 80), version: str(raw?.version, 40) };
  } catch {
    return { name: '', version: '' };
  }
}

async function lstatOrNull(p) {
  try {
    return await fs.lstat(p);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Removes staging folders a crashed install left behind. Only `.install-*`:
 * a `.backup-*` folder exists only if a rollback itself failed, and then it may
 * be the last copy of the admin's module - that one is left for a human.
 */
export async function cleanupStaleStaging(now = Date.now()) {
  let entries = [];
  try {
    entries = await fs.readdir(MODULES_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('.install-')) continue;
    const full = path.join(MODULES_DIR, name);
    try {
      const st = await fs.lstat(full);
      if (st.isDirectory() && now - st.mtimeMs > STALE_STAGING_MS) {
        await fs.rm(full, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
}

// What the filesystem says when a name the zip reader let through still cannot
// be written as given: EEXIST from `wx` when two names fold onto one file
// (case, Unicode or 8.3 rules of this particular filesystem), EINVAL/ENOENT for
// a name the OS refuses, ENAMETOOLONG for a deep path. All of them are a
// problem of the archive, not of the server, and the admin gets the archive's
// 400 instead of a bare 500.
const UNWRITABLE_NAME_CODES = new Set(['EEXIST', 'ENOENT', 'EINVAL', 'ENAMETOOLONG']);

async function writeStaged(stageDir, keep, meta) {
  await fs.mkdir(stageDir, { recursive: true, mode: 0o755 });
  for (const f of keep) {
    const dest = path.join(stageDir, ...f.rel.split('/'));
    // The zip reader already refused `..` and absolute names; this is the second
    // lock on the same door, because a path that escapes here writes anywhere
    // the server process may write.
    if (!dest.startsWith(`${stageDir}${path.sep}`)) {
      throw new InstallError('unsafe_path', `Unsafe path in archive: ${f.rel}`);
    }
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
      await fsOps.writeFile(dest, f.data, { flag: 'wx', mode: 0o644 });
    } catch (err) {
      if (UNWRITABLE_NAME_CODES.has(err?.code)) {
        throw new InstallError('unsafe_path', `The archive contains a file name this server cannot write: ${f.rel}`);
      }
      throw err;
    }
  }
  await fs.writeFile(path.join(stageDir, INSTALL_META_FILE), JSON.stringify(meta, null, 2), { flag: 'wx', mode: 0o644 });
}

/**
 * Installs from already-unpacked files. Caller holds the lock.
 *
 * @param {{ name: string, data: Buffer }[]} files
 * @param {object} opts
 * @param {boolean} [opts.overwrite]
 * @param {string}  [opts.path]      sub-folder inside the archive
 * @param {'zip'|'github'} opts.source
 * @param {number}  [opts.userId]
 * @param {object}  [opts.meta]      { url, ref, commit } for GitHub installs
 * @returns {Promise<{ module: object, replaced: boolean, skipped: string[] }>}
 *   The module is disabled either way: a fresh install and a replace both
 *   write `approved: false` into the install record (see TRUST MODEL).
 */
export async function installFilesUnlocked(files, opts = {}) {
  await assertWritable();
  await cleanupStaleStaging();

  const located = locateModule(files, { path: opts.path });
  const rawManifest = readManifest(located.file);
  const id = rawManifest.id;
  const { keep, skipped } = selectFiles(files, located.dir);

  const meta = {
    source: opts.source === 'github' ? 'github' : 'zip',
    ...(opts.meta?.url ? { url: String(opts.meta.url) } : {}),
    ...(opts.meta?.ref ? { ref: String(opts.meta.ref) } : {}),
    ...(opts.meta?.commit ? { commit: String(opts.meta.commit) } : {}),
    ...(located.relDir ? { path: located.relDir } : {}),
    installedAt: new Date().toISOString(),
    installedBy: opts.userId ?? null,
    // The review state, in the folder. Every install and every replace starts
    // here, whatever the module's switch said before: a replace from "the
    // same" GitHub repository is a branch that moved, a tag that was re-pointed
    // or an owner name that changed hands, and none of that is the code the
    // admin once looked at. Only setModuleEnabled() in a browser session
    // turns it to true.
    approved: false,
  };

  const stagingRoot = path.join(MODULES_DIR, `.install-${randomBytes(8).toString('hex')}`);
  const stageDir = path.join(stagingRoot, id);
  try {
    await fs.mkdir(stagingRoot, { mode: 0o755 });
    await writeStaged(stageDir, keep, meta);

    let validated;
    try {
      validated = await loadModuleDir(stageDir, id);
    } catch (err) {
      throw new InstallError('bad_manifest', `The module is not valid: ${err?.message || 'unknown error'}`);
    }

    const target = path.join(MODULES_DIR, id);
    const existing = await lstatOrNull(target);
    let replaced = false;
    if (existing) {
      // No `existing` in this body on purpose: the UI offers "replace" whenever
      // it sees one, and replacing a link or a file is refused anyway.
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new InstallError('not_a_module',
          `modules/${id} exists but is not a regular module folder. Remove it on the server first.`, {}, 409);
      }
      if (!opts.overwrite) {
        const current = await readExistingManifest(target);
        throw new InstallError('exists', `A module with the id "${id}" is already installed.`, {
          existing: { id, name: current.name, version: current.version, install: await readInstallMeta(target) },
          incoming: {
            id,
            name: typeof rawManifest.name === 'string' ? rawManifest.name.slice(0, 80) : '',
            version: typeof rawManifest.version === 'string' ? rawManifest.version.slice(0, 40) : '',
          },
        });
      }
      // The staged folder already carries `approved: false`, so the moment the
      // rename lands the new code is off - no switch to flip before the swap,
      // and nothing to put back when the swap fails and the old folder returns
      // with its own record.
      const backup = path.join(MODULES_DIR, `.backup-${id}-${Date.now()}`);
      await fsOps.rename(target, backup);
      try {
        await fsOps.rename(stageDir, target);
      } catch (err) {
        try {
          await fsOps.rename(backup, target);
        } catch (restoreErr) {
          log.error(`Restoring modules/${id} from ${path.basename(backup)} failed - restore it by hand:`, restoreErr);
        }
        throw err;
      }
      await fs.rm(backup, { recursive: true, force: true }).catch((err) => {
        log.warn(`Could not remove backup folder ${path.basename(backup)}:`, err?.message);
      });
      replaced = true;
    } else {
      // Off before the folder appears: the record inside says so. There is no
      // moment in which the new module is already served to members.
      await fsOps.rename(stageDir, target);
    }

    const modules = await listModules({ admin: true });
    const module = modules.find((m) => m.id === id) || null;
    log.info(`Module ${replaced ? 'replaced' : 'installed'}: id=${id} version=${validated.manifest.version || '-'} `
      + `source=${meta.source}${meta.url ? ` url=${meta.url}` : ''}${meta.ref ? ` ref=${meta.ref}` : ''} `
      + `by user ${opts.userId ?? '?'} (disabled until approved)`);
    return { module, replaced, skipped };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function zipToInstallError(err) {
  if (err instanceof ZipError) return new InstallError(REASON_STATUS[err.code] ? err.code : 'corrupt', err.message);
  return err;
}

/** Unpacks an archive buffer. Converts ZipError to InstallError. */
export function unpackArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new InstallError('not_zip', 'Send the module as a ZIP file.');
  }
  if (buffer.length > MAX_ZIP_BYTES) {
    throw new InstallError('too_large', `The module archive is too large. The limit is ${MAX_ZIP_MB} MB.`);
  }
  try {
    return readZipArchive(buffer);
  } catch (err) {
    throw zipToInstallError(err);
  }
}

/** Installs from an archive buffer (uploaded ZIP). Takes the lock. */
export function installFromZip(buffer, opts = {}) {
  return withInstallLock(async () => {
    const { files } = unpackArchive(buffer);
    return installFilesUnlocked(files, { ...opts, source: opts.source || 'zip' });
  });
}

/**
 * Deletes a module folder that the web interface installed. Leaves `ext:<id>`
 * permission rows and dashboard widget configs alone: both already tolerate
 * unknown modules, and keeping them means a reinstall of the same id comes
 * back with its settings.
 */
export function deleteModule(id, { userId } = {}) {
  return withInstallLock(async () => {
    if (!MODULE_ID_RE.test(String(id || ''))) {
      throw new InstallError('bad_id', 'Invalid module id.');
    }
    await assertWritable();
    const target = path.join(MODULES_DIR, id);
    const st = await lstatOrNull(target);
    if (!st) throw new InstallError('not_found', 'Module not found.');
    // A symlink is something the operator set up by hand (a dev checkout, a
    // shared volume). `rm -r` through it would delete files outside modules/.
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new InstallError('not_a_module',
        `modules/${id} is not a regular folder (for example a symbolic link). Remove it on the server.`);
    }
    // Only what the web put there. A hand-copied folder can be a working
    // checkout with uncommitted work, and `rm -r` has no undo; the symlink
    // rule above covers only the linked case. Without the record the folder is
    // the operator's, and the page shows no delete button for it.
    if (!(await readInstallMeta(target))) {
      throw new InstallError('not_web_installed',
        `modules/${id} was not installed from Settings. Remove the folder on the server.`);
    }
    await fs.rm(target, { recursive: true, force: true });
    // The household switch is cleared so that a later reinstall of the same id
    // is judged by its own record, not by a stale entry.
    setModuleDisabledFlag(id, false);
    await listModules({ admin: true });
    log.info(`Module deleted: id=${id} by user ${userId ?? '?'}`);
    return { id, deleted: true };
  });
}
