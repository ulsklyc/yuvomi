#!/usr/bin/env node
/**
 * Restore drill: restores release databases (the migration corpus) through the
 * real restore path and checks that this checkout migrates and serves them.
 *
 * Usage:
 *   node scripts/restore-drill.mjs <corpus.db> [<corpus.db> ...] [--key-file <path>] [--skip-server] [--json]
 *
 * Every <corpus.db> needs `<corpus.db>.sha256` next to it (`sha256sum` format).
 * The key is the public corpus test key (CORPUS_TEST_KEY below) unless
 * `--key-file` names another one. Corpus databases hold demo data only.
 *
 * Steps per database, in this order; the first red step ends that database:
 *   checksum        the file matches its .sha256
 *   check-backup    `node server/check-backup.js` accepts it (the operator's check)
 *   restore         `node scripts/restore-backup.js` into an empty data directory
 *   schema-version  the restored database is at the head of MIGRATIONS
 *   integrity       PRAGMA integrity_check is ok
 *   foreign-keys    PRAGMA foreign_key_check is empty
 *   schema-hash     the schema equals that of a database migrated from zero
 *   rows            no table of the head schema has fewer rows than in the
 *                   corpus file (full-text index tables excluded: derived data)
 *   server          server/index.js starts on it and every endpoint of the
 *                   API probe answers 200 for the demo admin (needs `npm run build`)
 *
 * Exit 0 when every database passed, 1 otherwise. `--json` prints one JSON line
 * per database instead of the text report.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diffFingerprints, fingerprintFile, lostRows, openDatabase } from './rollback-probe/fingerprint.mjs';
import { failedEndpoints, snapshot } from './rollback-probe/api-probe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Public test key of the migration corpus. It is not a secret: corpus
 * databases carry demo data only, and anyone must be able to open them. The
 * corpus workflow (.github/workflows/corpus.yml) seeds with the same literal.
 */
export const CORPUS_TEST_KEY = 'yuvomi-public-corpus-test-key';

/** Fixed session secret for the drill's own server start; nothing leaves the run. */
const DRILL_SESSION_SECRET = 'restore-drill-session-secret-not-used-outside-this-run';

/**
 * @typedef {{ step: string, ok: boolean, detail?: string }} StepResult
 * @typedef {{ file: string, ok: boolean, failedStep: string | null, reason: string | null, steps: StepResult[] }} DrillResult
 */

class StepError extends Error {
  /**
   * @param {string} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Environment for the child processes: PATH and what the step sets, nothing
 * from the caller's shell or a `.env` (children run in the work directory).
 * @param {Record<string, string>} extra
 */
function childEnv(extra) {
  /** @type {Record<string, string>} */
  const env = { PATH: process.env.PATH ?? '', LOG_LEVEL: 'warn', NODE_NO_WARNINGS: '1', ...extra };
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string> }} options
 */
function runNode(args, { cwd, env }) {
  const run = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() };
}

/** @param {string} file */
function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * A database migrated from zero by this checkout, with the same key: the
 * reference for schema version and schema hash.
 * @param {string} work
 * @param {string} key
 */
function referenceFingerprint(work, key) {
  const dir = join(work, 'reference');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'yuvomi.db');
  const run = runNode(['--input-type=module', '-e', `(await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/db.js')).href)})).get().close();`], {
    cwd: dir,
    env: childEnv({ DB_PATH: dbPath, DB_ENCRYPTION_KEY: key, SESSION_SECRET: DRILL_SESSION_SECRET }),
  });
  if (run.status !== 0) throw new Error(`could not migrate a reference database from zero:\n${run.out}`);
  return fingerprintFile(dbPath, key);
}

/**
 * Asks server/db.js for the reason of a refused backup (`err.reason`), the
 * same check server/check-backup.js runs, so a red step names the code
 * (`backup_newer_version`, ...) and not only the sentence.
 * @param {string} file
 * @param {string} cwd
 * @param {string} key
 */
function checkBackupReason(file, cwd, key) {
  const script = `
    globalThis[Symbol.for('yuvomi.db.checkOnly')] = true;
    const { checkBackupFile } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/db.js')).href)});
    try { checkBackupFile(${JSON.stringify(file)}); console.log('REASON none'); }
    catch (err) { console.log('REASON ' + (err?.reason || 'unknown')); }
    process.exit(0);
  `;
  const run = runNode(['--input-type=module', '-e', script], {
    cwd,
    env: childEnv({ DB_PATH: join(cwd, 'unused.db'), DB_ENCRYPTION_KEY: key }),
  });
  return run.out.match(/REASON (\S+)/)?.[1] ?? 'unknown';
}

function freePort() {
  return /** @type {Promise<number>} */ (new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => ok(port));
    });
  }));
}

/**
 * Starts server/index.js on `dbPath`, runs the API probe, stops the server.
 * @param {string} dbPath
 * @param {string} key
 */
async function serverStep(dbPath, key) {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new StepError('server_not_built', 'dist/ is missing: run `npm run build` first, or pass --skip-server');
  }
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: dirname(dbPath),
    env: childEnv({
      NODE_ENV: 'production',
      DB_PATH: dbPath,
      DB_ENCRYPTION_KEY: key,
      DB_ENCRYPTION_AUTO_KEY: 'false',
      SESSION_SECRET: DRILL_SESSION_SECRET,
      SESSION_SECURE: 'false',
      PORT: String(port),
      BIND_ADDRESS: '127.0.0.1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.once('exit', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 60_000;
    let up = false;
    while (!up && Date.now() < deadline && child.exitCode === null) {
      try {
        up = (await fetch(`${base}/health`)).ok;
      } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new StepError('server_start_failed', `server did not come up on ${base}:\n${log.slice(-1500)}`);
    const snap = await snapshot(base);
    const failed = failedEndpoints(snap);
    if (failed.length) throw new StepError('endpoint_failed', `not 200: ${failed.join(', ')}`);
    return `${Object.keys(snap.api).length} endpoints answered 200`;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  }
}

/**
 * Runs every step on one corpus database.
 * @param {string} file
 * @param {{ key: string, work: string, reference: import('./rollback-probe/fingerprint.mjs').Fingerprint, skipServer?: boolean }} options
 * @returns {Promise<DrillResult>}
 */
export async function drillOne(file, { key, work, reference, skipServer = false }) {
  /** @type {StepResult[]} */
  const steps = [];
  const dir = mkdtempSync(join(work, `${basename(file).replace(/[^\w.-]/g, '_')}-`));
  const copy = join(dir, 'corpus.db');
  const dataDir = join(dir, 'data');
  const dbPath = join(dataDir, 'yuvomi.db');
  /** @type {import('./rollback-probe/fingerprint.mjs').Fingerprint | null} */
  let before = null;
  /** @type {import('./rollback-probe/fingerprint.mjs').Fingerprint | null} */
  let after = null;

  /** @type {[string, () => string | void | Promise<string | void>][]} */
  const plan = [
    ['checksum', () => {
      const sumFile = `${file}.sha256`;
      if (!existsSync(sumFile)) throw new StepError('checksum_missing', `${sumFile} is missing`);
      const expected = readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
      const actual = sha256Of(file);
      if (expected !== actual) throw new StepError('checksum_mismatch', `sha256 ${actual}, expected ${expected}`);
      // Work on a copy: opening a WAL database leaves -wal/-shm next to it.
      copyFileSync(file, copy);
      return actual.slice(0, 16);
    }],
    ['check-backup', () => {
      const run = runNode([join(ROOT, 'server', 'check-backup.js'), copy], {
        cwd: dir,
        env: childEnv({ DB_PATH: join(dir, 'unused.db'), DB_ENCRYPTION_KEY: key }),
      });
      if (run.status !== 0) throw new StepError(checkBackupReason(copy, dir, key), run.out);
      before = fingerprintFile(copy, key);
      return run.out.split('\n').pop();
    }],
    ['restore', () => {
      mkdirSync(dataDir, { recursive: true });
      const run = runNode([join(ROOT, 'scripts', 'restore-backup.js'), copy], {
        cwd: dataDir,
        env: childEnv({ DB_PATH: dbPath, DB_ENCRYPTION_KEY: key, SESSION_SECRET: DRILL_SESSION_SECRET }),
      });
      if (run.status !== 0) throw new StepError('restore_failed', run.out);
      after = fingerprintFile(dbPath, key);
      return run.out.split('\n').find((l) => l.startsWith('Restored')) ?? 'restored';
    }],
    ['schema-version', () => {
      const v = /** @type {NonNullable<typeof after>} */ (after).schema_version;
      if (v !== reference.schema_version) {
        throw new StepError('schema_version_mismatch', `schema v${v}, head is v${reference.schema_version}`);
      }
      return `v${v}`;
    }],
    ['integrity', () => {
      const db = openDatabase(dbPath, key);
      try {
        const rows = /** @type {{ integrity_check: string }[]} */ (db.pragma('integrity_check'));
        const result = rows.map((r) => r.integrity_check).join('; ');
        if (result !== 'ok') throw new StepError('integrity_check_failed', result.slice(0, 400));
        return 'ok';
      } finally {
        db.close();
      }
    }],
    ['foreign-keys', () => {
      const db = openDatabase(dbPath, key);
      try {
        const rows = /** @type {{ table: string, parent: string }[]} */ (db.pragma('foreign_key_check'));
        if (rows.length) {
          throw new StepError('foreign_key_check_failed',
            `${rows.length} violations: ${[...new Set(rows.map((r) => `${r.table} -> ${r.parent}`))].join(', ')}`);
        }
        return 'none';
      } finally {
        db.close();
      }
    }],
    ['schema-hash', () => {
      const restored = /** @type {NonNullable<typeof after>} */ (after);
      if (restored.schema_hash !== reference.schema_hash) {
        const tables = diffFingerprints(reference, restored).filter((d) => /only (before|after)$/.test(d));
        throw new StepError('schema_hash_mismatch',
          `schema hash ${restored.schema_hash}, migrated from zero ${reference.schema_hash}`
          + (tables.length ? ` (${tables.join(', ').replaceAll('only before', 'missing').replaceAll('only after', 'extra')})` : ''));
      }
      return restored.schema_hash;
    }],
    ['rows', () => {
      const lost = lostRows(/** @type {NonNullable<typeof before>} */ (before), /** @type {NonNullable<typeof after>} */ (after), reference);
      if (lost.length) throw new StepError('rows_lost', lost.join('; '));
      const total = Object.values(/** @type {NonNullable<typeof after>} */ (after).tables)
        .reduce((sum, t) => sum + ('n' in t ? t.n : 0), 0);
      return `${total} rows in ${Object.keys(/** @type {NonNullable<typeof after>} */ (after).tables).length} tables`;
    }],
  ];
  if (!skipServer) plan.push(['server', () => serverStep(dbPath, key)]);

  for (const [step, fn] of plan) {
    try {
      const detail = await fn();
      steps.push({ step, ok: true, ...(detail ? { detail } : {}) });
    } catch (err) {
      const e = /** @type {Error & { reason?: string }} */ (err);
      steps.push({ step, ok: false, detail: String(e.message).slice(0, 2000) });
      return { file, ok: false, failedStep: step, reason: e.reason ?? 'error', steps };
    }
  }
  return { file, ok: true, failedStep: null, reason: null, steps };
}

/**
 * Drills every file; the reference database is migrated once per run.
 * @param {string[]} files
 * @param {{ key?: string, skipServer?: boolean, work?: string }} [options]
 * @returns {Promise<DrillResult[]>}
 */
export async function drill(files, { key = CORPUS_TEST_KEY, skipServer = false, work } = {}) {
  const ownWork = !work;
  const dir = work ?? mkdtempSync(join(tmpdir(), 'yuvomi-restore-drill-'));
  try {
    const reference = referenceFingerprint(dir, key);
    const results = [];
    for (const file of files) results.push(await drillOne(resolve(file), { key, work: dir, reference, skipServer }));
    return results;
  } finally {
    if (ownWork) rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {DrillResult} result */
function report(result) {
  const lines = [`${result.ok ? 'PASS' : 'FAIL'} ${result.file}${result.ok ? '' : ` (${result.failedStep}: ${result.reason})`}`];
  for (const s of result.steps) lines.push(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.step}${s.detail ? `: ${s.detail.split('\n')[0]}` : ''}`);
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const keyIdx = args.indexOf('--key-file');
  const keyFile = keyIdx === -1 ? null : args[keyIdx + 1];
  const files = args.filter((a, i) => !a.startsWith('--') && !(keyIdx !== -1 && i === keyIdx + 1));
  if (files.length === 0 || (keyIdx !== -1 && !keyFile)) {
    console.error('Usage: node scripts/restore-drill.mjs <corpus.db> [...] [--key-file <path>] [--skip-server] [--json]');
    process.exit(2);
  }
  const key = keyFile ? readFileSync(keyFile, 'utf8').replace(/\r?\n$/, '') : CORPUS_TEST_KEY;
  const results = await drill(files, { key, skipServer: args.includes('--skip-server') });
  for (const r of results) console.log(args.includes('--json') ? JSON.stringify(r) : report(r));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
