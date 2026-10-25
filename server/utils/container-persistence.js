/**
 * Ob ein Ordner im Container ein Update ueberlebt - geteilt von der Modul-Installation
 * (`/app/modules`, siehe MODULES.md) und dem Startcheck der lokalen Dokumentablage
 * (`/documents`, #751). Beide Ordner legt das Image selbst an, also beweist ihre
 * Existenz im Container nichts; erst die Mounttabelle sagt, ob ein Volume darauf liegt.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// WHY. Writable is not the same as kept. The image creates /app/modules and
// /documents and the entrypoint makes them writable, so in a container WITHOUT a
// volume on one of them a write works - and is gone with the next image update,
// because the folder lives in the container's own layer. Umbrel's compose file
// is exactly that case for the modules (no modules mount, and no env marker that
// would name Umbrel); a Portainer Git stack is it for the documents, because its
// documents mount is commented out and cannot be enabled. Both callers warn
// instead of refusing: a test install or a household that reinstalls after
// updates is still served.
//
// HOW (best effort, Linux only). Outside a container the folder is a normal
// directory on the host: persistent. Inside one, /proc/self/mountinfo says
// which mount the folder lives on: the root overlay "/" means the container
// layer, any other mount point at or above it is a volume or bind mount.
// Anything unreadable answers null ("unknown") and the caller stays quiet.

const persistenceProbe = {
  platform: process.platform,
  containerMarkers: ['/.dockerenv', '/run/.containerenv'],
  cgroupPath: '/proc/1/cgroup',
  mountinfoPath: '/proc/self/mountinfo',
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
 * true = `dir` survives an update, false = it is in the container layer,
 * null = cannot tell. Never throws.
 *
 * @param {string} dir
 * @returns {Promise<boolean|null>}
 */
export async function isPathPersistent(dir) {
  try {
    if (persistenceProbe.platform !== 'linux') return true;
    const info = await readTextOrNull(persistenceProbe.mountinfoPath);
    const mounts = info === null ? [] : parseMountinfo(info);
    if (!(await runsInContainer(mounts))) return true;
    if (info === null || !mounts.length) return null;
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
