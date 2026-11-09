/**
 * Modul: Vendor-Politik des Builds (Phase 1a, Abschnitt D9, Ticket 25, E12)
 * Zweck: Fremdcode im Browser kommt als npm-Abhaengigkeit mit EXAKTER Version
 *        (kein `^`, kein `~`; `.npmrc` save-exact=true), Lockfile und `npm ci`
 *        - und jedes Paket, das im Bundle landet, steht in
 *        dist/THIRD-PARTY-NOTICES.txt. Welche Pakete im Bundle landen, sagt
 *        der Modulgraph des Builds (dist/.vite/modules.json), nicht
 *        `dependencies`. Die Handkopien unter public/vendor/ bleiben bis Ende
 *        Phase 4 (Mischform mit Enddatum) und stehen ebenfalls in den Notizen.
 * Ausfuehren: npm run build && node --test test/test-vendor-policy.js
 * Abhaengigkeiten: dist/ (npm run build)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { bundledPackages, buildNotices } from '../scripts/build-third-party-notices.mjs';
import { distModules, readDist } from './dist-build.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Pakete, die App-Code importiert und die der Build buendelt. Startet leer:
 * vite, lightningcss und typescript sind Werkzeuge, kein Code im Browser.
 * Wer hier eines eintraegt, hat vorher ein Issue (CONTRIBUTING, Vendor-Politik).
 */
/** @type {string[]} */
const IMPORTED_PACKAGES = [];

/**
 * Laufzeit-Helfer, die die Werkzeugkette selbst in die Chunks legt (Preload,
 * Modul-Laufzeit, Absenkung fuer die Browser-Untergrenze). Gepinnt ueber vite
 * (exakt) und dessen Lockfile-Eintraege.
 */
const TOOLCHAIN_HELPERS = ['@oxc-project/runtime', 'rolldown', 'vite'];

/**
 * Verstoesse gegen die Pin-Regel: ein gebuendeltes Paket, das package.json
 * nicht exakt pinnt.
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} manifest
 * @param {string[]} names
 */
function pinViolations(manifest, names) {
  const all = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  return names.filter((name) => name in all && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(all[name]))
    .map((name) => `${name}@${all[name]}`);
}

test('der Pruefer erkennt ein Caret und ein unbekanntes gebuendeltes Paket (Fixture)', () => {
  const fixture = { dependencies: { 'lit-html': '^3.3.0' }, devDependencies: { vite: '8.3.7' } };
  assert.deepEqual(pinViolations(fixture, ['lit-html', 'vite']), ['lit-html@^3.3.0']);
  assert.deepEqual(pinViolations({ dependencies: { a: '~1.2.3' } }, ['a']), ['a@~1.2.3']);
  const found = bundledPackages(['public/router.js', 'node_modules/lit-html/lit-html.js', 'node_modules/@scope/x/index.js']).map((p) => p.name);
  assert.deepEqual(found, ['@scope/x', 'lit-html']);
});

test('.npmrc pinnt neue Abhaengigkeiten exakt', () => {
  const npmrc = readFileSync(new URL('../.npmrc', import.meta.url), 'utf8');
  assert.match(npmrc, /^save-exact=true$/m);
});

test('was der Build buendelt, ist bekannt und exakt gepinnt', () => {
  const bundled = bundledPackages(distModules('rendered'));
  const imported = bundled.filter((p) => !p.injected && p.name !== '@oxc-project/runtime').map((p) => p.name);
  assert.deepEqual(imported, IMPORTED_PACKAGES,
    'Diese npm-Pakete landen im Bundle, stehen aber nicht in IMPORTED_PACKAGES (oder umgekehrt) - '
    + 'neue Frontend-Abhaengigkeit nur mit Issue, exaktem Pin und Eintrag hier');
  const helpers = bundled.filter((p) => p.injected || p.name === '@oxc-project/runtime').map((p) => p.name);
  assert.deepEqual(helpers, TOOLCHAIN_HELPERS, 'die Werkzeugkette legt andere Helfer in die Chunks als bekannt');
  assert.deepEqual(pinViolations(pkg, [...IMPORTED_PACKAGES, ...TOOLCHAIN_HELPERS]), [],
    'ein gebuendeltes Paket steht mit ^ oder ~ in package.json');
  assert.deepEqual(pinViolations(pkg, ['vite', 'lightningcss', 'typescript']), [], 'die Build-Werkzeuge sind exakt gepinnt');
});

test('THIRD-PARTY-NOTICES.txt nennt jedes gebuendelte Paket und jede Handkopie', () => {
  const notices = readDist('THIRD-PARTY-NOTICES.txt');
  const missing = bundledPackages(distModules('rendered'))
    .filter((p) => !notices.includes(`${p.name} ${p.version} - `))
    .map((p) => `${p.name} ${p.version}`);
  assert.deepEqual(missing, [], 'diese gebuendelten Pakete fehlen in den Notizen');
  const vendor = readdirSync(new URL('../public/vendor/', import.meta.url)).filter((d) => !d.startsWith('.'));
  assert.ok(vendor.length >= 4, `nur ${vendor.length} Handkopien gelesen`);
  assert.deepEqual(vendor.filter((d) => !notices.includes(`\nvendor/${d}\n`)), [], 'eine Handkopie fehlt in den Notizen');
  // Der Build schreibt genau das, was das Skript aus dem Modulgraphen bildet.
  assert.equal(notices, buildNotices({ rendered: distModules('rendered') }), 'dist/THIRD-PARTY-NOTICES.txt ist nicht die Fassung des Skripts');
});
