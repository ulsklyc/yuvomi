#!/usr/bin/env node
/**
 * Modul: Ist der Build deterministisch? (Phase 1a, Abschnitt D6, Fertig-Kriterium F5)
 * Zweck: Baut denselben Stand zweimal, in zwei frischen Temp-Verzeichnissen
 *        mit verschiedenem Pfad, und vergleicht sha256 jeder Datei unter dist/.
 *        Ein Build, der von Pfad, Uhrzeit oder Reihenfolge abhaengt, macht die
 *        Attestation des Release-Tarballs wertlos: niemand koennte aus dem
 *        Quelltarball nachbauen, was signiert wurde. Rolldown hatte genau
 *        solche Faelle (Sourcemap-Kommentar #11508, Build-Pfad bis #11277).
 *        Exit 0: gleich. Exit 1: Liste der Dateien, die abweichen oder fehlen.
 *        Exit 2: ein Build scheiterte.
 * Quelle: `git archive <ref>` (Standard HEAD) - nur was eingecheckt ist, wie im
 *         Tarball. `--from-dir DIR` kopiert stattdessen einen Baum (ohne .git,
 *         node_modules, dist) - fuer die Gegenprobe mit einer kuenstlich
 *         nichtdeterministischen Konfiguration.
 * node_modules wird aus dem Checkout verlinkt, nicht neu installiert (dasselbe
 * Lockfile, und der Lauf braucht kein Netz). APP_BUILD_REVISION ist fuer beide
 * Builds gleich: die Umgebung, sonst der Commit von <ref>.
 * Aufruf: node scripts/check-build-determinism.mjs [--ref REF | --from-dir DIR] [--keep]
 * Abhaengigkeiten: git, tar (fuer --ref), node:crypto, node:fs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (/** @type {string} */ name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ref = opt('--ref') ?? 'HEAD';
const fromDir = opt('--from-dir');
const keep = args.includes('--keep');

/** @param {string} cmd @param {string[]} argv @param {import('node:child_process').SpawnSyncOptions} [o] */
function run(cmd, argv, o = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
  if (r.status !== 0) {
    console.error(`${cmd} ${argv.join(' ')} failed (${r.status ?? r.error?.message}):\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    process.exit(2);
  }
  return r;
}

/**
 * Tokens a build never needs. The release workflow runs this script in a job
 * without write rights, but a build spawned from here should not hold a token
 * even where one is present (a local shell, another workflow): an install
 * script or a Vite plugin could otherwise write releases or request an OIDC
 * token. Removed before APP_BUILD_REVISION and NODE_ENV are set.
 */
export const SECRET_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NPM_TOKEN'];

/** @param {NodeJS.ProcessEnv} env */
export function buildEnv(env) {
  const clean = { ...env };
  for (const name of SECRET_ENV) delete clean[name];
  return clean;
}

function main() {
  const revision = String(process.env.APP_BUILD_REVISION ?? '').trim()
    || (fromDir ? 'determinism-check' : String(run('git', ['rev-parse', ref], { cwd: REPO }).stdout).trim());

  /**
   * Every file under dir, relative, sorted, with its sha256.
   * @param {string} dir
   */
  function hashes(dir) {
    /** @type {Map<string, string>} */
    const out = new Map();
    const walk = (/** @type {string} */ current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.set(path.relative(dir, full).split(path.sep).join('/'), createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    };
    walk(dir);
    return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
  }

  /**
   * Source tree into a fresh directory, node_modules linked, one build.
   * @param {string} label
   */
  function buildOnce(label) {
    const dir = mkdtempSync(path.join(tmpdir(), `yuvomi-determinism-${label}-`));
    if (fromDir) {
      const src = path.resolve(fromDir);
      cpSync(src, dir, {
        recursive: true,
        filter: (p) => !/(?:^|[\\/])(?:\.git|node_modules|dist)(?:[\\/]|$)/.test(path.relative(src, p)),
      });
    } else {
      const archive = run('git', ['archive', '--format=tar', ref], { cwd: REPO, encoding: 'buffer' });
      run('tar', ['-x', '-C', dir], { input: archive.stdout, encoding: 'buffer' });
    }
    symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const started = Date.now();
    run(process.execPath, [path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], {
      cwd: dir,
      env: { ...buildEnv(process.env), APP_BUILD_REVISION: revision, NODE_ENV: 'production' },
    });
    if (!existsSync(path.join(dir, 'dist', 'sw.js'))) {
      console.error(`${label}: the build wrote no dist/sw.js`);
      process.exit(2);
    }
    return { dir, ms: Date.now() - started };
  }

  const a = buildOnce('a');
  const b = buildOnce('b');
  const ha = hashes(path.join(a.dir, 'dist'));
  const hb = hashes(path.join(b.dir, 'dist'));
  const differ = [...new Set([...ha.keys(), ...hb.keys()])].sort()
    .filter((file) => ha.get(file) !== hb.get(file))
    .map((file) => `${file}${!ha.has(file) ? ' (only in b)' : !hb.has(file) ? ' (only in a)' : ''}`);

  if (keep) console.log(`kept: ${a.dir} ${b.dir}`);
  else for (const d of [a.dir, b.dir]) rmSync(d, { recursive: true, force: true });

  console.log(`builds: ${a.ms} ms, ${b.ms} ms; ${ha.size} files in dist/ (revision ${revision})`);
  if (differ.length) {
    console.error(`The build is not deterministic: ${differ.length} file(s) differ between two builds of the same source:\n  ${differ.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Deterministic: every file in dist/ has the same sha256 in both builds.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
