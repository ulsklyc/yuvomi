/**
 * Modul: Image-Build - Laufzeit-Abhaengigkeiten (#2006)
 * Zweck: Ein Paket, das der Server laedt, kommt nie still abhanden.
 *        Das Image 2.77.1 startete nicht (`ERR_MODULE_NOT_FOUND googleapis`):
 *        googleapis und tsdav standen unter `optionalDependencies`, und im
 *        Publish-Lauf verwarf `npm ci --omit=dev` sie auf linux/arm64 still
 *        (120 statt 137 Pakete), der Build lief gruen durch.
 *        Vier Proben:
 *          1. Jedes Fremdpaket, das server/ importiert (.js wie .ts; ein
 *             reiner Typ-Import laedt nichts), steht in `dependencies` -
 *             nicht optional, nicht dev.
 *          2. Das Lockfile installiert jede dieser Abhaengigkeiten ohne
 *             optional-/dev-Markierung.
 *          3. scripts/check-runtime-deps.mjs laeuft auf dieser Installation
 *             gruen und wird ROT, wenn googleapis in node_modules fehlt - das
 *             Abbild genau des arm64-Laufs.
 *          4. Das Dockerfile ruft das Skript in der Build-Stage nach
 *             `npm ci --omit=dev`, und .dockerignore laesst es durch.
 * Ausfuehren: node --test test/test-runtime-deps.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-dir.js';
import { findUnloadableDependencies } from '../scripts/check-runtime-deps.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'check-runtime-deps.mjs');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Die Fremdpakete, die eine Quelldatei laedt: statische `import`/`export ...
 * from` am Zeilenanfang und `import('literal')` ausserhalb von Kommentarzeilen
 * (JSDoc-Typen wie `{import('better-sqlite3').Database}` sind kein Laden).
 */
function thirdPartyImports(source) {
  const specifiers = [];
  for (const m of source.matchAll(/^(?:import|export)\s+(?:[\w$*{},\s]+?\sfrom\s*)?['"]([^'"\n]+)['"]/gm)) {
    // `import type ...` / `export type ... from` is stripped by Node and loads
    // nothing; `import type from 'x'` is a default import named `type`.
    if (/^(?:import|export)\s+type(?:\s*[{*]|\s+(?!from\s*['"])[\w$]+\s+from\b)/.test(m[0])) continue;
    specifiers.push(m[1]);
  }
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    for (const m of line.matchAll(/(?<![\w.$])import\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]);
  }
  return [...new Set(specifiers
    .filter((s) => !s.startsWith('.') && !s.startsWith('/') && !isBuiltin(s))
    .map(packageName))];
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(?:js|mjs|cjs|ts)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Every third-party package the source files under `dir` load, checked against
 * the given package.json. The real test and the fixture test both call this, so
 * the fixture proves what the guard over server/ does, not a copy of it.
 * @param {string} dir
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }} manifest
 */
function runtimeImportOffenders(dir, manifest) {
  const offenders = [];
  const seen = new Set();
  for (const file of walk(dir)) {
    for (const name of thirdPartyImports(readFileSync(file, 'utf8'))) {
      seen.add(name);
      const where = relative(ROOT, file);
      if (manifest.optionalDependencies?.[name]) offenders.push(`${name} (${where}) is in optionalDependencies - npm may drop it silently`);
      else if (manifest.devDependencies?.[name] && !manifest.dependencies?.[name]) offenders.push(`${name} (${where}) is a devDependency - npm ci --omit=dev leaves it out`);
      else if (!manifest.dependencies?.[name]) offenders.push(`${name} (${where}) is not declared - it is only there as someone else's dependency`);
    }
  }
  return { offenders, seen };
}

test('the import scanner sees static, multi-line and dynamic imports and skips types, builtins and relatives', () => {
  const found = thirdPartyImports([
    "import express from 'express';",
    'import {',
    '  a,',
    '  b,',
    "} from '@scope/pkg/sub';",
    "import 'side-effect';",
    "export { x } from 're-export';",
    "import path from 'path';",
    "import { readFileSync } from 'node:fs';",
    "import { y } from './local.js';",
    "  const { createDAVClient } = await import('dynamic-pkg');",
    " * @param {import('typed-only').Database} conn",
    "// await import('commented-out')",
    // TypeScript: Node strips a type-only statement and loads nothing ...
    "import type { Shape } from 'ts-type-only';",
    "import type Default from 'ts-type-default';",
    "export type { Shape } from 'ts-type-reexport';",
    'import type {',
    '  Multi,',
    "} from 'ts-type-multiline';",
    // ... but an inline `type` specifier keeps the statement, even with no value left.
    "import { type A, b } from 'ts-mixed';",
    "import { type OnlyType } from 'ts-inline-type-only';",
    "export { type X } from 'ts-inline-reexport';",
    // A default import named `type` is a value import.
    "import type from 'ts-default-named-type';",
  ].join('\n'));
  assert.deepEqual(found.sort(), [
    '@scope/pkg', 'dynamic-pkg', 'express', 're-export', 'side-effect',
    'ts-default-named-type', 'ts-inline-reexport', 'ts-inline-type-only', 'ts-mixed',
  ]);
});

test('the guard reads TypeScript files: an undeclared package imported from a .ts file is reported', () => {
  // server/ holds .ts files since phase 2 (table-owners.ts, authorize/); a walk that
  // only lists .js would pass over them without a word.
  const dir = tempDir('yuvomi-runtime-deps-ts-');
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'loads.ts'), "import { type Options, create } from 'b0-undeclared-pkg';\nexport const x: Options = create();\n");
  writeFileSync(join(dir, 'types-only.ts'), "import type { Shape } from 'b0-type-only-pkg';\nexport type Alias = Shape;\n");
  const { offenders, seen } = runtimeImportOffenders(dir, { dependencies: {} });
  assert.ok(seen.has('b0-undeclared-pkg'), `the .ts import must be seen; seen: ${[...seen].join(', ')}`);
  assert.ok(!seen.has('b0-type-only-pkg'), 'a type-only import loads nothing at runtime');
  assert.equal(offenders.length, 1, offenders.join('\n'));
  assert.match(offenders[0], /^b0-undeclared-pkg \(.*nested\/loads\.ts\) is not declared/);
});

test('every third-party package the server loads is a runtime dependency, not optional or dev', () => {
  const { offenders, seen } = runtimeImportOffenders(join(ROOT, 'server'), pkg);
  // Ein blinder Scanner faende nichts und waere gruen.
  assert.ok(seen.has('express'), 'the scanner must find the server\'s express import');
  assert.deepEqual(offenders, []);
});

test('the lockfile installs every runtime dependency unconditionally', () => {
  const rootEntry = lock.packages[''];
  for (const name of Object.keys(pkg.dependencies)) {
    assert.equal(rootEntry.dependencies?.[name], pkg.dependencies[name], `${name}: lockfile root must list it under dependencies`);
    assert.equal(rootEntry.optionalDependencies?.[name], undefined, `${name}: lockfile root must not list it as optional`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name}: lockfile must contain node_modules/${name}`);
    assert.notEqual(entry.optional, true, `${name}: lockfile marks it optional - npm ci may skip it`);
    assert.notEqual(entry.dev, true, `${name}: lockfile marks it dev - npm ci --omit=dev skips it`);
  }
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), [], 'package.json declares no optionalDependencies');
});

test('the check reports a dependency that does not load and passes one that does', async () => {
  const failures = await findUnloadableDependencies(
    { 'present-pkg': '^1.0.0', 'missing-pkg': '^1.0.0' },
    async (name) => { if (name === 'missing-pkg') throw Object.assign(new Error('gone'), { code: 'ERR_MODULE_NOT_FOUND' }); },
  );
  assert.deepEqual(failures, [{ name: 'missing-pkg', error: 'ERR_MODULE_NOT_FOUND: gone' }]);
  const real = await findUnloadableDependencies({ 'yuvomi-no-such-package-2006': '^1.0.0' });
  assert.equal(real.length, 1);
  assert.match(real[0].error, /ERR_MODULE_NOT_FOUND/);
});

test('the check script passes on this installation', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, new RegExp(`all ${Object.keys(pkg.dependencies).length} runtime dependencies load`));
});

test('the check script fails the build when googleapis is missing from node_modules (the 2.77.1 arm64 image)', () => {
  // Nachbau des arm64-Builds: dieselbe package.json, dasselbe Skript, ein
  // node_modules, in dem alles liegt ausser googleapis.
  const dir = tempDir('yuvomi-runtime-deps-');
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'node_modules'));
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check-runtime-deps.mjs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const entry of readdirSync(join(ROOT, 'node_modules'))) {
    if (entry === 'googleapis' || entry.startsWith('.')) continue;
    // 'junction': unter Windows ein Ordner-Link ohne Sonderrechte, sonst ignoriert.
    symlinkSync(join(ROOT, 'node_modules', entry), join(dir, 'node_modules', entry), 'junction');
  }
  const run = spawnSync(process.execPath, [join(dir, 'scripts', 'check-runtime-deps.mjs')], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1, `the check must fail without googleapis; stdout: ${run.stdout} stderr: ${run.stderr}`);
  assert.match(run.stderr, /- googleapis: ERR_MODULE_NOT_FOUND/);
});

test('the Dockerfile runs the check in the build stage right after the production install', () => {
  // Seit dem Build (Phase 1a, Abschnitt D): `npm ci` mit devDependencies, `npm run
  // build`, dann `npm prune --omit=dev` - erst danach steht der Produktionsstand,
  // den die Runtime-Stage uebernimmt, und genau den prueft das Skript.
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const buildStage = dockerfile.slice(0, dockerfile.lastIndexOf('\nFROM '));
  const build = buildStage.indexOf('npm run build\n');
  const install = buildStage.indexOf('\nRUN npm prune --omit=dev\n');
  const copy = buildStage.indexOf('\nCOPY scripts/check-runtime-deps.mjs ./scripts/\n');
  const check = buildStage.indexOf('\nRUN node scripts/check-runtime-deps.mjs\n');
  assert.ok(buildStage.indexOf('\nRUN npm ci\n') !== -1 && build !== -1, 'the build stage installs everything and builds the web app');
  assert.notEqual(install, -1, 'the build stage drops the devDependencies with npm prune --omit=dev');
  assert.ok(install > build, 'pruned after the build, which needs Vite');
  assert.notEqual(copy, -1, 'the build stage copies the check script');
  assert.notEqual(check, -1, 'the build stage runs the check script');
  assert.ok(check > install && check > copy, 'the check runs after the install and the copy');

  const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  const excluded = ignore.indexOf('scripts/');
  const reincluded = ignore.indexOf('!scripts/check-runtime-deps.mjs');
  assert.notEqual(reincluded, -1, '.dockerignore must let the check script into the build context');
  assert.ok(excluded === -1 || reincluded > excluded, 'the exception must come after the scripts/ exclusion');
});
