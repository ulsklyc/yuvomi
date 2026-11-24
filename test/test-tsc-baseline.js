/**
 * Modul: Test-Infrastruktur - tsc-Baseline (Phase 1a, Abschnitt C)
 * Zweck: scripts/check-tsc-baseline.ts macht aus `tsc --build` ein CI-Tor, das nur
 *        sinken darf. Geprueft wird an einem Fixture-Projekt im Temp-Verzeichnis
 *        (Solution + server/ mit zwei Dateien), dass ein zusaetzlicher Fehler Exit 1
 *        mit Nennung liefert, ein weggefallener Exit 0 mit dem Hinweis "Baseline
 *        kann sinken", `--update` nur senkt und nie erhoeht, und dass die echte
 *        tsc-baseline.json sortiert ist und keine Datei nennt, die es nicht gibt.
 * Ausfuehren: node --test test/test-tsc-baseline.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-dir.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'check-tsc-baseline.ts');
const TWO_ERRORS = 'export const a = (x) => x;\nexport const b = (y) => y;\n';
const ONE_ERROR = 'export const a = (x) => x;\nexport const b = (y = 1) => y;\n';

function fixture() {
  const dir = tempDir('yuvomi-tsc-baseline-');
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './server' }] }));
  writeFileSync(join(dir, 'server', 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'esnext', module: 'esnext', moduleResolution: 'bundler', types: [], allowJs: true, checkJs: true, strict: true, noEmit: true, skipLibCheck: true },
    include: ['./*.js'],
  }));
  writeFileSync(join(dir, 'server', 'x.js'), TWO_ERRORS);
  return dir;
}

/**
 * @param {string} dir
 * @param {...string} args
 */
function run(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** @param {string} dir */
const baselineOf = (dir) => JSON.parse(readFileSync(join(dir, 'tsc-baseline.json'), 'utf8'));

test('ohne Baseline-Datei: Exit 2 statt stillem Gruen', () => {
  const dir = fixture();
  try {
    assert.equal(run(dir).code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--init fuellt die Baseline, danach ist der Lauf gruen', () => {
  const dir = fixture();
  try {
    assert.equal(run(dir, '--init').code, 0);
    assert.deepEqual(baselineOf(dir), { 'server/x.js\tTS7006': 2 });
    assert.equal(run(dir).code, 0);
    assert.equal(run(dir, '--init').code, 2, '--init ueberschreibt keine gefuellte Baseline');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ein zusaetzlicher Fehler: Exit 1 und die Datei samt Code wird genannt', () => {
  const dir = fixture();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), `${TWO_ERRORS}export const c = (z) => z;\n`);
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /server\/x\.js\s+TS7006\s+2 -> 3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ein neuer Schluessel (andere Datei): Exit 1', () => {
  const dir = fixture();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'y.js'), 'export const q = (w) => w;\n');
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /server\/y\.js\s+TS7006\s+0 -> 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ein weggefallener Fehler: Exit 0 mit Hinweis, Baseline bleibt', () => {
  const dir = fixture();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), ONE_ERROR);
    const r = run(dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /Baseline kann sinken: 1 Schl/);
    assert.deepEqual(baselineOf(dir), { 'server/x.js\tTS7006': 2 }, 'ohne --update bleibt die Datei');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--update senkt und entfernt, erhoeht aber nie', () => {
  const dir = fixture();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), ONE_ERROR);
    assert.equal(run(dir, '--update').code, 0);
    assert.deepEqual(baselineOf(dir), { 'server/x.js\tTS7006': 1 });
    // Mehr Fehler: --update bricht ab und fasst die Datei nicht an.
    writeFileSync(join(dir, 'server', 'x.js'), `${TWO_ERRORS}export const c = (z) => z;\n`);
    assert.equal(run(dir, '--update').code, 1);
    assert.deepEqual(baselineOf(dir), { 'server/x.js\tTS7006': 1 });
    // Alles behoben: der Schluessel verschwindet.
    writeFileSync(join(dir, 'server', 'x.js'), 'export const a = 1;\n');
    assert.equal(run(dir, '--update').code, 0);
    assert.deepEqual(baselineOf(dir), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ein Fehler ohne Quellort (TS2688) ist Exit 2 und laesst die Baseline in Ruhe', () => {
  const dir = fixture();
  try {
    run(dir, '--init');
    const before = readFileSync(join(dir, 'tsc-baseline.json'), 'utf8');
    const cfg = JSON.parse(readFileSync(join(dir, 'server', 'tsconfig.json'), 'utf8'));
    cfg.compilerOptions.types = ['gibtsnicht'];
    writeFileSync(join(dir, 'server', 'tsconfig.json'), JSON.stringify(cfg));
    for (const mode of [[], ['--update']]) {
      const r = run(dir, ...mode);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /TS2688/);
    }
    assert.equal(readFileSync(join(dir, 'tsc-baseline.json'), 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('die echte tsc-baseline.json ist sortiert, ohne Fremdcode und nennt nur vorhandene Dateien', () => {
  const baseline = JSON.parse(readFileSync(join(REPO, 'tsc-baseline.json'), 'utf8'));
  const keys = Object.keys(baseline);
  assert.ok(keys.length > 0, 'leere Baseline');
  assert.deepEqual(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'Schluessel nicht sortiert');
  const stale = [];
  for (const key of keys) {
    const [file, code] = key.split('\t');
    assert.match(code, /^TS\d+$/, `Schluessel ohne TS-Code: ${key}`);
    assert.ok(Number.isInteger(baseline[key]) && baseline[key] > 0, `Zahl ungueltig: ${key}`);
    assert.ok(!file.includes('/vendor/'), `Fremdcode in der Baseline: ${file}`);
    if (!existsSync(join(REPO, file))) stale.push(file);
  }
  assert.deepEqual([...new Set(stale)], [], 'Baseline nennt Dateien, die es nicht gibt');
});

test('der Typecheck erfasst tools/, .github/scripts/ und alle scripts/ (#2637, #2638)', () => {
  // Ohne Kommentare gelesen: server/tsconfig.json ist JSONC.
  const raw = readFileSync(join(REPO, 'server', 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const cfg = JSON.parse(raw);
  for (const dir of ['../scripts/', '../tools/', '../.github/scripts/']) {
    assert.ok(cfg.include.some((/** @type {string} */ g) => g.startsWith(dir)), `${dir} liegt in keinem Projekt`);
  }
  assert.equal(cfg.exclude, undefined, `exclude nimmt Dateien aus dem Typecheck: ${JSON.stringify(cfg.exclude)}`);
  const script = readFileSync(SCRIPT, 'utf8');
  for (const prefix of ["'tools/'", "'.github/'"]) assert.ok(script.includes(prefix), `OWNED kennt ${prefix} nicht`);
  const baseline = Object.keys(JSON.parse(readFileSync(join(REPO, 'tsc-baseline.json'), 'utf8')));
  for (const file of ['scripts/take-screenshots.mjs', 'tools/installer/field-checks.js', '.github/scripts/review-verdict.mjs']) {
    assert.ok(baseline.some((k) => k.startsWith(`${file}\t`)), `${file} fehlt in der Baseline`);
  }
});
