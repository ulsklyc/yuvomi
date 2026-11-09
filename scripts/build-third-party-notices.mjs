#!/usr/bin/env node
/**
 * Modul: Third-party notices of the build (Phase 1a, section D9, ticket 25)
 * Purpose: dist/THIRD-PARTY-NOTICES.txt names every piece of foreign code that
 *          ships to the browser, with version and license text:
 *   - packages whose code the bundler put into a chunk - read from the module
 *     graph (dist/.vite/modules.json, `rendered`), not from `dependencies`:
 *     a dependency the frontend never imports does not ship, and the helpers
 *     the toolchain injects (Vite's preload helper, Rolldown's runtime, Oxc's
 *     lowering helpers) ship although no package.json names them;
 *   - the hand copies under public/vendor/ (copied, not bundled; E12), with
 *     their README and LICENSE files.
 *   Deterministic: sorted, no dates, no absolute paths.
 * Run: node scripts/build-third-party-notices.mjs [distDir]  (the build calls
 *      it through a Vite plugin; standalone it reads <distDir>/.vite/modules.json)
 * Dependencies: node:fs, node:path
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Helpers the toolchain injects: module id prefix -> the package that carries them. */
const VIRTUAL_PACKAGES = [
  { prefix: 'virtual:vite/', name: 'vite' },
  { prefix: 'virtual:rolldown/', name: 'rolldown' },
];
const OXC_RUNTIME = /^virtual:@oxc-project\+runtime@([^/]+)\//;

/**
 * The npm packages whose code is in the bundle, as `{ name, version }`, sorted.
 * @param {string[]} rendered - module ids from modules.json (`rendered`)
 * @param {string} [repoRoot]
 * @returns {{ name: string, version: string, injected: boolean }[]}
 */
export function bundledPackages(rendered, repoRoot = REPO) {
  /** @type {Map<string, { name: string, version: string, injected: boolean }>} */
  const found = new Map();
  for (const id of rendered) {
    const oxc = id.match(OXC_RUNTIME);
    if (oxc) {
      found.set('@oxc-project/runtime', { name: '@oxc-project/runtime', version: String(oxc[1]), injected: true });
      continue;
    }
    const virtual = VIRTUAL_PACKAGES.find((v) => id.startsWith(v.prefix));
    const pkgName = virtual?.name ?? packageOf(id);
    if (!pkgName || found.has(pkgName)) continue;
    const manifest = path.join(repoRoot, 'node_modules', pkgName, 'package.json');
    const version = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : 'unknown';
    found.set(pkgName, { name: pkgName, version, injected: Boolean(virtual) });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `node_modules/@scope/name/...` or `node_modules/name/...` -> package name; else null.
 * @param {string} id
 */
function packageOf(id) {
  const at = id.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const parts = id.slice(at + 'node_modules/'.length).split('/');
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : (parts[0] ?? null);
}

/**
 * The license text a package ships, or null. Vite's LICENSE.md: only its own part.
 * @param {string} repoRoot
 * @param {string} name
 */
function licenseText(repoRoot, name) {
  const dir = path.join(repoRoot, 'node_modules', name);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).filter((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f)).sort()[0];
  if (!file) return null;
  let text = readFileSync(path.join(dir, file), 'utf8');
  const bundledPart = text.indexOf('\n# Licenses of bundled dependencies');
  if (bundledPart > 0) text = text.slice(0, bundledPart);
  return text.trim();
}

/**
 * @param {string} repoRoot
 * @param {string} name
 */
function licenseField(repoRoot, name) {
  const manifest = path.join(repoRoot, 'node_modules', name, 'package.json');
  if (!existsSync(manifest)) return null;
  const { license } = JSON.parse(readFileSync(manifest, 'utf8'));
  return typeof license === 'string' ? license : null;
}

const RULE = '='.repeat(78);

/**
 * The full text of THIRD-PARTY-NOTICES.txt.
 * @param {{ rendered: string[], repoRoot?: string }} input
 */
export function buildNotices({ rendered, repoRoot = REPO }) {
  const out = [
    'Yuvomi - third-party notices',
    '',
    'Foreign code shipped to the browser with this build: npm packages bundled by',
    'Vite (from the module graph of the build) and the hand copies under vendor/.',
    'Yuvomi itself is MIT licensed (LICENSE).',
    '',
  ];
  out.push(RULE, 'BUNDLED NPM PACKAGES', RULE, '');
  for (const pkg of bundledPackages(rendered, repoRoot)) {
    if (pkg.name === '@oxc-project/runtime') {
      // Not installed as a package: Rolldown embeds these helpers (class field
      // and typeof lowering for the browser floor) in its binary.
      out.push(`${pkg.name} ${pkg.version} - MIT`, 'Helpers injected by Rolldown/Oxc while lowering syntax for the browser floor.',
        'Source and license: https://github.com/oxc-project/oxc (LICENSE, MIT).', '');
      continue;
    }
    const field = licenseField(repoRoot, pkg.name) ?? 'see license text';
    out.push(`${pkg.name} ${pkg.version} - ${field}${pkg.injected ? ' (runtime helper injected by the toolchain)' : ''}`);
    const text = licenseText(repoRoot, pkg.name);
    out.push('', text ?? '(no license file in the package)', '');
  }
  out.push(RULE, 'HAND COPIES UNDER vendor/ (copied as they are, see each README)', RULE, '');
  const vendorDir = path.join(repoRoot, 'public', 'vendor');
  for (const name of readdirSync(vendorDir).filter((d) => !d.startsWith('.')).sort()) {
    const dir = path.join(vendorDir, name);
    const files = readdirSync(dir);
    const readme = files.includes('README.md') ? readFileSync(path.join(dir, 'README.md'), 'utf8').trim() : null;
    out.push(`vendor/${name}`, '-'.repeat(`vendor/${name}`.length), '', readme ?? '(no README)', '');
    for (const lic of files.filter((f) => /^licen[cs]e/i.test(f)).sort()) {
      out.push(`--- vendor/${name}/${lic}`, '', readFileSync(path.join(dir, lic), 'utf8').trim(), '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * Writes <distDir>/THIRD-PARTY-NOTICES.txt from <distDir>/.vite/modules.json.
 * @param {string} distDir
 */
export function writeNotices(distDir, repoRoot = REPO) {
  const { rendered } = JSON.parse(readFileSync(path.join(distDir, '.vite', 'modules.json'), 'utf8'));
  writeFileSync(path.join(distDir, 'THIRD-PARTY-NOTICES.txt'), buildNotices({ rendered, repoRoot }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeNotices(path.resolve(process.argv[2] ?? path.join(REPO, 'dist')));
}
