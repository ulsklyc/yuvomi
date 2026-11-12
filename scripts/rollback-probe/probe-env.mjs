/**
 * Where a rollback probe run keeps its state, read by every CLI in this folder.
 * run.sh sets PROBE_DIR (the work directory) and PROBE_PORT before it calls them.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export function probeDir() {
  const dir = process.env.PROBE_DIR;
  if (!dir) {
    console.error('PROBE_DIR is not set: run the probe through scripts/rollback-probe/run.sh, or export PROBE_DIR=<work dir>.');
    process.exit(2);
  }
  return resolve(dir);
}

/** A path inside the work directory; absolute paths stay as they are. */
export function inProbeDir(/** @type {string} */ path) {
  return isAbsolute(path) ? path : join(probeDir(), path);
}

/** The key the container generated on its first start, from the shared data directory. */
export function probeKey() {
  return readFileSync(join(probeDir(), 'data', '.secrets', 'DB_ENCRYPTION_KEY'), 'utf8').replace(/\n$/, '');
}

export function probeBase() {
  return `http://127.0.0.1:${process.env.PROBE_PORT || '3871'}`;
}
