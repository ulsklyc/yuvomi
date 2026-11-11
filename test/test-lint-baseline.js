/**
 * Module: test infrastructure - lint baseline (phase 1b, section D)
 * Purpose: scripts/check-lint-baseline.ts turns the lint tools into a CI gate that only sinks.
 *          Checked on a fixture project in a temp directory that runs the REAL rule set
 *          (.oxlintrc.json, copied with the plugin path made absolute): an extra finding gives
 *          exit 1 naming file and rule, a fixed one exit 0 with "Baseline can sink", --update
 *          lowers and never raises, a hard rule fails even with --init, a broken tool run is
 *          exit 2, a disable comment is a finding of its own (hard without a rule list or for
 *          no-restricted-syntax). The fixture test/fixtures/lint/ must give exactly its ten
 *          findings, the TypeScript layer fixture test/fixtures/lint/layers/ exactly its three
 *          dependency-cruiser violations, the knip fixture test/fixtures/lint/knip/ (run with the
 *          real knip.json) exactly its six findings; a knip entry that names no file is exit 2;
 *          the real tree has no hard finding (this runs in the required test jobs, next to the
 *          lint job); the real lint-baseline.json is sorted, carries no hard rule and names no
 *          missing file. The fixture test/fixtures/lint/error-text/ must give exactly its
 *          thirty-three ERROR-TEXT findings (the self-test cases of the text reader the rule
 *          replaced, phase 1b section E, and the spellings a probe against that reader
 *          found) and nothing for the lines it must leave alone. A
 *          baseline key of that rule needs a reason in lint-baseline-reasons.json, and a
 *          reason needs its key.
 * Run:     npm run test:lint-baseline
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-dir.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'check-lint-baseline.ts');
const OXLINT = join(REPO, 'node_modules', 'oxlint', 'bin', 'oxlint');
const FIXTURE = join(REPO, 'test', 'fixtures', 'lint');
const DEPCRUISE = join(REPO, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const DEPCRUISE_CONFIG = join(REPO, '.dependency-cruiser.mjs');
const KNIP = join(REPO, 'node_modules', 'knip', 'bin', 'knip.js');
const CONFIG = JSON.parse(readFileSync(join(REPO, '.oxlintrc.json'), 'utf8'));
const HARD_RULES = ['HTML-STRING-WRITE', 'TX-ASYNC-FN', 'TX-AWAIT-INSIDE', 'blanket-disable', 'disable-no-restricted-syntax'];

/** The real rule set for a directory outside the repo: no fixture ignore, plugin by absolute URL. */
function portableConfig() {
  const config = structuredClone(CONFIG);
  delete config.$schema;
  config.ignorePatterns = config.ignorePatterns.filter((/** @type {string} */ p) => p !== 'test/fixtures/lint/**');
  config.jsPlugins = config.jsPlugins.map((/** @type {{ name: string, specifier: string }} */ p) => ({ ...p, specifier: import.meta.resolve(p.specifier) }));
  return config;
}

const ONE_MANUAL = "export function f(db) { db.exec('BEGIN'); }\n";
const TWO_MANUAL = "export function f(db) { db.exec('BEGIN'); db.exec('COMMIT'); }\n";
const NONE = 'export function f(db) { return db; }\n';

function project(source = TWO_MANUAL) {
  const dir = tempDir('yuvomi-lint-baseline-');
  writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server', 'x.js'), source);
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
const baselineOf = (dir) => JSON.parse(readFileSync(join(dir, 'lint-baseline.json'), 'utf8'));
const MANUAL = 'server/x.js\toxlint/no-restricted-syntax/TX-MANUAL';
// Built from parts so that this file does not carry a directive itself.
const DISABLE = `// ${'eslint'}-disable-next-line`;

test('without a baseline file: exit 2 instead of a silent green', () => {
  const dir = project();
  try {
    assert.equal(run(dir).code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--init fills the baseline, after that the run is green', () => {
  const dir = project();
  try {
    assert.equal(run(dir, '--init').code, 0);
    assert.deepEqual(baselineOf(dir), { [MANUAL]: 2 });
    assert.equal(run(dir).code, 0);
    assert.equal(run(dir, '--init').code, 2, '--init does not overwrite a filled baseline');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty baseline names the whole stock and fails', () => {
  const dir = project();
  try {
    writeFileSync(join(dir, 'lint-baseline.json'), '{}\n');
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/TX-MANUAL\s+0 -> 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an extra finding: exit 1, file and rule are named', () => {
  const dir = project(ONE_MANUAL);
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), TWO_MANUAL);
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/TX-MANUAL\s+1 -> 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new key (another file): exit 1', () => {
  const dir = project();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'y.js'), ONE_MANUAL);
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /server\/y\.js\s+oxlint\/no-restricted-syntax\/TX-MANUAL\s+0 -> 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a fixed finding: exit 0 with a hint, the baseline stays', () => {
  const dir = project();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), ONE_MANUAL);
    const r = run(dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /Baseline can sink: 1 key/);
    assert.deepEqual(baselineOf(dir), { [MANUAL]: 2 }, 'without --update the file stays');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--update lowers and removes, but never raises', () => {
  const dir = project();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), ONE_MANUAL);
    assert.equal(run(dir, '--update').code, 0);
    assert.deepEqual(baselineOf(dir), { [MANUAL]: 1 });
    writeFileSync(join(dir, 'server', 'x.js'), TWO_MANUAL);
    assert.equal(run(dir, '--update').code, 1);
    assert.deepEqual(baselineOf(dir), { [MANUAL]: 1 });
    writeFileSync(join(dir, 'server', 'x.js'), NONE);
    assert.equal(run(dir, '--update').code, 0);
    assert.deepEqual(baselineOf(dir), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a hard rule fails even with --init and never enters the baseline', () => {
  const dir = project("export function f(db) { return db.transaction(async () => { await db; }); }\n");
  try {
    const r = run(dir, '--init');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /TX-ASYNC-FN/);
    assert.equal(existsSync(join(dir, 'lint-baseline.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a broken lint run is exit 2 and leaves the baseline alone', () => {
  const dir = project();
  try {
    run(dir, '--init');
    const before = readFileSync(join(dir, 'lint-baseline.json'), 'utf8');
    writeFileSync(join(dir, '.oxlintrc.json'), '{ "jsPlugins": ["./gone.js"] }');
    for (const mode of [[], ['--update']]) assert.equal(run(dir, ...mode).code, 2);
    assert.equal(readFileSync(join(dir, 'lint-baseline.json'), 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a disable comment is counted: a new one fails, a blanket one or one for no-restricted-syntax is hard', () => {
  const dir = project(NONE);
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'y.js'), `${DISABLE} no-unused-vars\nconst unused = 1;\nexport {};\n`);
    const plain = run(dir);
    assert.equal(plain.code, 1, plain.out);
    assert.match(plain.out, /server\/y\.js\s+directive\/disable\s+0 -> 1/);
    for (const [line, kind] of [
      [`${DISABLE}\n`, 'blanket-disable'],
      [`${DISABLE} eslint-js/no-restricted-syntax -- why\n`, 'disable-no-restricted-syntax'],
      [`/* ${'oxlint'}-disable */\n`, 'blanket-disable'],
      [`/* ${'eslint'}-disable no-await-in-loop,\n   eslint-js/no-restricted-syntax */\n`, 'disable-no-restricted-syntax'],
    ]) {
      writeFileSync(join(dir, 'server', 'y.js'), `${line}export function g(el) { el.innerHTML = '<b></b>'; }\n`);
      const r = run(dir, '--init');
      assert.equal(r.code, 1, `${line}: ${r.out}`);
      assert.match(r.out, new RegExp(`Hard rules[\\s\\S]*server/y\\.js\\s+directive/${kind}`));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file oxlint cannot parse is keyed as a parse error, not as an unknown rule', () => {
  const dir = project(NONE);
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'y.js'), 'export function (\n');
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /server\/y\.js\s+oxlint\/parse-error\s+0 -> [1-9]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const LEAK = 'export function f(res, err) { res.status(400).json({ error: err.message }); }\n';
const ERROR_TEXT = 'server/x.js\toxlint/no-restricted-syntax/ERROR-TEXT';
const OWN_TEXT = 'instanceof OwnError, the sentence is ours';
/**
 * @param {string} dir
 * @param {Record<string, string>} reasons
 */
const writeReasons = (dir, reasons) => writeFileSync(join(dir, 'lint-baseline-reasons.json'), `${JSON.stringify(reasons, null, 1)}\n`);
/** @param {string} dir */
const reasonsOf = (dir) => JSON.parse(readFileSync(join(dir, 'lint-baseline-reasons.json'), 'utf8'));

test('a baseline key of the error-text rule needs a reason of twenty characters', () => {
  const dir = project(LEAK);
  try {
    const init = run(dir, '--init');
    assert.equal(init.code, 1, init.out);
    assert.match(init.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/ERROR-TEXT\s+no reason/);
    assert.deepEqual(baselineOf(dir), { [ERROR_TEXT]: 1 }, '--init still wrote the baseline');
    assert.equal(run(dir).code, 1, 'no reasons file');
    writeReasons(dir, { [ERROR_TEXT]: 'own text' });
    const short = run(dir);
    assert.equal(short.code, 1, short.out);
    assert.match(short.out, /ERROR-TEXT\s+no reason/);
    writeReasons(dir, { [ERROR_TEXT]: OWN_TEXT });
    const ok = run(dir);
    assert.equal(ok.code, 0, ok.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a reason without a baseline key is red, and --update drops a reason with its key', () => {
  const dir = project(LEAK);
  try {
    run(dir, '--init');
    writeReasons(dir, { [ERROR_TEXT]: OWN_TEXT, 'server/gone.js\toxlint/no-restricted-syntax/ERROR-TEXT': 'a place that was fixed long ago' });
    const stale = run(dir);
    assert.equal(stale.code, 1, stale.out);
    assert.match(stale.out, /server\/gone\.js\s+oxlint\/no-restricted-syntax\/ERROR-TEXT\s+reason without a baseline key/);
    assert.equal(run(dir, '--update').code, 1, '--update only drops the reason of a key it lowers away');
    writeReasons(dir, { [ERROR_TEXT]: OWN_TEXT });
    assert.equal(run(dir).code, 0);
    // The place is fixed: the key sinks away, and its reason goes with it.
    writeFileSync(join(dir, 'server', 'x.js'), NONE);
    assert.equal(run(dir).code, 0, 'the reason of a key that can sink is not stale yet');
    assert.equal(run(dir, '--update').code, 0);
    assert.deepEqual(baselineOf(dir), {});
    assert.deepEqual(reasonsOf(dir), {});
    writeFileSync(join(dir, 'lint-baseline-reasons.json'), '{ "broken": ');
    assert.equal(run(dir).code, 2, 'a reasons file that is not JSON is a broken run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the size rules stand at the planned limits', () => {
  assert.deepEqual(CONFIG.rules['max-lines'], ['error', { max: 1500 }]);
  assert.deepEqual(CONFIG.rules['max-lines-per-function'], ['error', { max: 200 }]);
});

test('the real tree has no hard finding (runs in the required test jobs)', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 2, out);
  assert.doesNotMatch(out, /Hard rules have no baseline/, out);
});

test('a layer violation is keyed per module and rule, under the same ratchet', () => {
  const dir = project(NONE);
  try {
    copyFileSync(DEPCRUISE_CONFIG, join(dir, '.dependency-cruiser.mjs'));
    mkdirSync(join(dir, 'server', 'routes'));
    writeFileSync(join(dir, 'server', 'routes', 'r.js'), 'export const r = 1;\n');
    assert.equal(run(dir, '--init').code, 0);
    assert.deepEqual(baselineOf(dir), {}, 'no violation yet');
    writeFileSync(join(dir, 'server', 'x.js'), "import { r } from './routes/r.js';\nexport const f = () => r;\n");
    mkdirSync(join(dir, 'server', 'services'));
    writeFileSync(join(dir, 'server', 'services', 's.js'), "import { r } from '../routes/r.js';\nexport const s = () => r;\n");
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /server\/services\/s\.js\s+depcruise\/lower-layers-not-to-routes\s+0 -> 1/);
    assert.doesNotMatch(r.out, /server\/x\.js/, 'a route import from outside the lower layers is allowed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cycle through a browser-root import (/x.js) is a cycle', () => {
  const dir = project(NONE);
  try {
    copyFileSync(DEPCRUISE_CONFIG, join(dir, '.dependency-cruiser.mjs'));
    mkdirSync(join(dir, 'public'));
    copyFileSync(join(REPO, 'public', 'tsconfig.json'), join(dir, 'public', 'tsconfig.json'));
    writeFileSync(join(dir, 'public', 'a.js'), "import { b } from '/b.js';\nexport const a = () => b;\n");
    writeFileSync(join(dir, 'public', 'b.js'), "export const b = 1;\n");
    assert.equal(run(dir, '--init').code, 0);
    writeFileSync(join(dir, 'public', 'b.js'), "import { a } from './a.js';\nexport const b = () => a;\n");
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /public\/(a|b)\.js\s+depcruise\/no-circular\s+0 -> 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('each of the other layer rules fires, and an unresolved local import is keyed', () => {
  const dir = project(NONE);
  try {
    copyFileSync(DEPCRUISE_CONFIG, join(dir, '.dependency-cruiser.mjs'));
    for (const d of ['server/services', 'public/pages', 'public/utils', 'node_modules/web-push']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'web-push', 'package.json'), JSON.stringify({ name: 'web-push', version: '0.0.0', main: 'index.js' }));
    writeFileSync(join(dir, 'node_modules', 'web-push', 'index.js'), 'export const sendNotification = () => {};\n');
    writeFileSync(join(dir, 'public', 'pages', 'p.js'), 'export const p = 1;\n');
    writeFileSync(join(dir, 'public', 'utils', 'u.js'), 'export const u = 1;\n');
    writeFileSync(join(dir, 'server', 'services', 'ok.js'), "import { u } from '../../public/utils/u.js';\nexport const ok = () => u;\n");
    assert.equal(run(dir, '--init').code, 0);
    assert.deepEqual(baselineOf(dir), {}, 'reading public/utils/ is allowed');
    writeFileSync(join(dir, 'server', 'services', 'w.js'), "import { sendNotification } from 'web-push';\nexport const w = sendNotification;\n");
    writeFileSync(join(dir, 'server', 'services', 'p.js'), "import { p } from '../../public/pages/p.js';\nexport const q = p;\n");
    writeFileSync(join(dir, 'public', 'utils', 's.js'), "import { ok } from '../../server/services/ok.js';\nexport const s = ok;\n");
    writeFileSync(join(dir, 'server', 'services', 'gone.js'), "import { x } from './missing.js';\nexport const g = x;\n");
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    for (const [file, rule] of [
      ['server/services/w.js', 'web-push-only-in-push-service'],
      ['server/services/p.js', 'server-not-to-public-except-shared'],
      ['public/utils/s.js', 'public-not-to-server'],
      ['server/services/gone.js', 'unresolved-import'],
    ]) {
      const lines = r.out.split('\n').map((l) => l.trim().split(/\s+/).join(' '));
      assert.ok(lines.includes(`${file} depcruise/${rule} 0 -> 1`), `${file} ${rule}:\n${r.out}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a broken dependency-cruiser config is exit 2', () => {
  const dir = project(NONE);
  try {
    run(dir, '--init');
    writeFileSync(join(dir, '.dependency-cruiser.mjs'), 'module.exports = { forbidden: [{ name: 1 }] };\n');
    assert.equal(run(dir).code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the TypeScript layer fixture gives exactly its three violations', () => {
  // Without a TypeScript parser dependency-cruiser sees 1 of these 5 modules and reports
  // nothing, without an error (measured 10 Nov 2026); @swc/core is that parser.
  const r = spawnSync(process.execPath, [DEPCRUISE, '--config', DEPCRUISE_CONFIG, '--output-type', 'json', 'server', 'public'], {
    cwd: join(FIXTURE, 'layers'), encoding: 'utf8',
  });
  const report = JSON.parse(r.stdout);
  assert.equal(report.summary.totalCruised, 5, 'dependency-cruiser does not read the .ts files');
  const b = report.modules.find((/** @type {{ source: string }} */ m) => m.source === 'server/routes/b.ts');
  assert.ok(b?.dependencies.some((/** @type {{ resolved: string, dependencyTypes: string[] }} */ d) => d.resolved === 'server/services/types.ts'
    && d.dependencyTypes.includes('type-only')), 'the type-only import is not an edge');
  const found = report.summary.violations
    .map((/** @type {{ rule: { name: string }, from: string, to: string }} */ v) => `${v.rule.name} ${v.from} -> ${v.to}`)
    .sort();
  assert.deepEqual(found, [
    'lower-layers-not-to-routes server/services/a.ts -> server/routes/b.ts',
    'no-circular server/routes/b.ts -> server/services/a.ts',
    'push-service-importers server/services/a.ts -> server/services/push.ts', // .js import resolved to the .ts file
  ]);
});

test('the fixture gives exactly its ten findings, and nothing for the allowed lines', () => {
  const dir = tempDir('yuvomi-lint-fixture-');
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    for (const name of readdirSync(FIXTURE).filter((n) => n.endsWith('.js'))) copyFileSync(join(FIXTURE, name), join(dir, name));
    const r = spawnSync(process.execPath, [OXLINT, '--format', 'json', '.'], { cwd: dir, encoding: 'utf8' });
    const found = JSON.parse(r.stdout).diagnostics
      .map((/** @type {{ filename: string, message: string, labels: { span: { line: number } }[] }} */ d) => `${d.filename}:${d.labels[0].span.line} ${d.message.split(':')[0]}`)
      .sort();
    assert.deepEqual(found, [
      'a.js:10 HTML-STRING-WRITE', // dot access, innerHTML, plain assignment
      'a.js:11 HTML-STRING-WRITE', // bracket access, outerHTML, plain assignment
      'a.js:12 HTML-STRING-WRITE', // bracket access with a backtick name, innerHTML, +=
      'a.js:13 HTML-STRING-WRITE', // dot access, outerHTML, ||=
      'a.js:14 HTML-STRING-WRITE', // dot access, innerHTML, ??=
      'a.js:20 UTC-DAY-KEY', // toISOString().slice(0, 10)
      'a.js:21 UTC-DAY-KEY', // toISOString().substring(0, 10)
      'a.js:24 LOG-PLUS-500', // catch block answering 500
      'tx.js:5 TX-ASYNC-FN', // async transaction function
      'tx.js:7 TX-AWAIT-INSIDE', // await nested in a synchronous transaction body
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the error-text fixture gives exactly its thirty-three findings, and nothing for the lines to leave alone', () => {
  const dir = tempDir('yuvomi-lint-error-text-');
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    copyFileSync(join(FIXTURE, 'error-text', 'cases.js'), join(dir, 'cases.js'));
    // The fixture marks every line that must be reported with `et-N`.
    const marked = readFileSync(join(dir, 'cases.js'), 'utf8').split('\n')
      .flatMap((line, i) => (/\/\/ et-\d+:/.test(line) ? [i + 1] : []));
    assert.equal(marked.length, 33, 'the fixture marks thirty-three lines');
    const r = spawnSync(process.execPath, [OXLINT, '--format', 'json', '.'], { cwd: dir, encoding: 'utf8' });
    const found = JSON.parse(r.stdout).diagnostics
      .map((/** @type {{ message: string, labels: { span: { line: number } }[] }} */ d) => ({ line: d.labels[0].span.line, tag: d.message.split(':')[0] }))
      .sort((/** @type {{ line: number }} */ a, /** @type {{ line: number }} */ b) => a.line - b.line)
      .map((/** @type {{ line: number, tag: string }} */ f) => `${f.line} ${f.tag}`);
    assert.deepEqual(found, marked.map((line) => `${line} ERROR-TEXT`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the timezone exception drops only the UTC selector', () => {
  const [severity, ...selectors] = CONFIG.rules['eslint-js/no-restricted-syntax'];
  const override = CONFIG.overrides.find((/** @type {{ files: string[], rules: Record<string, unknown> }} */ o) => o.files.includes('server/utils/timezone.js'));
  assert.ok(override, 'no override for server/utils/timezone.js');
  assert.deepEqual(override.rules['eslint-js/no-restricted-syntax'],
    [severity, ...selectors.filter((/** @type {{ message: string }} */ s) => !s.message.startsWith('UTC-DAY-KEY:'))]);
});

test('oxlint reaches the source tree, but not vendor code or the fixture', () => {
  const r = spawnSync(process.execPath, [OXLINT, '--debug=files', '.'], { cwd: REPO, encoding: 'utf8' });
  const files = `${r.stdout}${r.stderr}`.split('\n').filter(Boolean);
  // Without this floor the gate would be green over nothing after a broken ignore pattern.
  assert.ok(files.filter((f) => f.startsWith('public/')).length >= 100, 'fewer than 100 files under public/');
  assert.ok(files.filter((f) => f.startsWith('server/')).length >= 100, 'fewer than 100 files under server/');
  assert.deepEqual(files.filter((f) => f.startsWith('public/vendor/') || f === 'public/lucide.min.js'
    || f.startsWith('test/fixtures/lint/') || f.startsWith('dist/')), []);
});

/**
 * A knip setup for a fixture project: one entry, the server tree as project.
 * @param {string} dir
 * @param {string[]} [entry]
 */
function knipProject(dir, entry = ['server/index.js']) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module' }));
  writeFileSync(join(dir, 'knip.json'), JSON.stringify({ entry, project: ['server/**/*.js'] }));
  writeFileSync(join(dir, 'server', 'index.js'), "import { f } from './x.js';\nexport const start = f;\n");
}

test('dead code is keyed per file and issue type, under the same ratchet', () => {
  const dir = project(NONE);
  try {
    knipProject(dir);
    // With a CODEOWNERS file knip adds an `owners` list to every report row; it is no finding.
    mkdirSync(join(dir, '.github'));
    writeFileSync(join(dir, '.github', 'CODEOWNERS'), '/server/ @someone\n*.js @someone-else\n');
    assert.equal(run(dir, '--init').code, 0);
    assert.deepEqual(baselineOf(dir), {}, 'no dead code yet');
    writeFileSync(join(dir, 'server', 'x.js'), `${NONE}export const g = 1;\n`);
    writeFileSync(join(dir, 'server', 'orphan.js'), 'export const o = 1;\n');
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    const lines = r.out.split('\n').map((l) => l.trim().split(/\s+/).join(' '));
    assert.ok(lines.includes('server/x.js knip/exports 0 -> 1'), r.out);
    assert.ok(lines.includes('server/orphan.js knip/files 0 -> 1'), r.out);
    assert.doesNotMatch(r.out, /knip\/owners/, 'the CODEOWNERS list on a report row is no finding');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a broken knip config, a failing plugin or a missing entry file is exit 2', () => {
  const dir = project(NONE);
  try {
    knipProject(dir);
    run(dir, '--init');
    writeFileSync(join(dir, 'knip.json'), '{"entry": [\n');
    assert.equal(run(dir).code, 2, 'broken config');
    writeFileSync(join(dir, 'knip.json'), JSON.stringify({ entry: ['server/index.js'], project: ['server/**/*.js'], bogus: 1 }));
    assert.equal(run(dir).code, 2, 'config knip rejects');
    // A plugin that cannot load its config: knip still prints a report, but exits 2.
    knipProject(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', devDependencies: { vite: '8.3.7' } }));
    writeFileSync(join(dir, 'vite.config.js'), "import { defineConfig } from 'vite';\nexport default defineConfig({});\n");
    assert.equal(run(dir).code, 2, 'plugin config that does not load');
    // knip skips an entry that names no file without a word; every file behind it would
    // then count as dead, or, for a CLI entry, its own exports would go unchecked.
    rmSync(join(dir, 'vite.config.js'));
    knipProject(dir, ['server/index.js', 'server/gone.js']);
    const r = run(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /server\/gone\.js/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the knip fixture gives exactly its six findings with the real knip.json', () => {
  const dir = tempDir('yuvomi-knip-fixture-');
  try {
    cpSync(join(FIXTURE, 'knip'), dir, { recursive: true });
    copyFileSync(join(REPO, 'knip.json'), join(dir, 'knip.json'));
    const r = spawnSync(process.execPath, [KNIP, '--reporter', 'json', '--no-exit-code', '--no-progress'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    /** @type {string[]} */
    const found = [];
    for (const issue of JSON.parse(r.stdout).issues) {
      for (const [type, list] of Object.entries(issue)) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const names = (Array.isArray(item) ? item : [item]).map((/** @type {{ name: string }} */ i) => i.name).join('+');
          found.push(`${issue.file} ${type} ${names}`);
        }
      }
    }
    assert.deepEqual(found.sort(), [
      'package.json dependencies left-pad',
      'public/orphan.js files public/orphan.js',
      'public/utils/y.js duplicates escapeText+default',
      'public/utils/y.js exports default',
      'server/services/unlisted.js unlisted chalk',
      'server/services/x.js exports unused',
    ]);
    // The same six through the ratchet: every issue type is keyed, not only exports and files.
    // The named entries the fixture does not have exist as empty files (the script stops on a
    // missing one).
    for (const entry of JSON.parse(readFileSync(join(dir, 'knip.json'), 'utf8')).entry) {
      if (/[*?{]/.test(entry) || existsSync(join(dir, entry))) continue;
      mkdirSync(join(dir, entry, '..'), { recursive: true });
      writeFileSync(join(dir, entry), '');
    }
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    const init = run(dir, '--init');
    assert.equal(init.code, 0, init.out);
    assert.deepEqual(Object.fromEntries(Object.entries(baselineOf(dir)).filter(([key]) => key.includes('\tknip/'))), {
      'package.json\tknip/dependencies': 1,
      'public/orphan.js\tknip/files': 1,
      'public/utils/y.js\tknip/duplicates': 1,
      'public/utils/y.js\tknip/exports': 1,
      'server/services/unlisted.js\tknip/unlisted': 1,
      'server/services/x.js\tknip/exports': 1,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a JSDoc tag that makes knip skip an export is counted like a disable comment', () => {
  const dir = project(NONE);
  try {
    knipProject(dir);
    assert.equal(run(dir, '--init').code, 0);
    // knip ignores an export tagged @public, @beta or @alias without a switch to turn that off.
    // The tags are built from parts so that this file does not carry them itself.
    writeFileSync(join(dir, 'server', 'x.js'), `${NONE}/** Kept for later. ${'@'}public */\nexport const g = 1;\n/** ${'@'}beta */\nexport const h = 1;\n`);
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    const lines = r.out.split('\n').map((l) => l.trim().split(/\s+/).join(' '));
    assert.ok(lines.includes('server/x.js directive/knip-tag 0 -> 2'), r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real lint-baseline.json is sorted, has no hard rule and names only existing files', () => {
  const baseline = JSON.parse(readFileSync(join(REPO, 'lint-baseline.json'), 'utf8'));
  const keys = Object.keys(baseline);
  assert.ok(keys.length > 0, 'empty baseline');
  assert.deepEqual(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'keys not sorted');
  const stale = [];
  for (const key of keys) {
    const [file, rule] = key.split('\t');
    assert.match(rule, /^(oxlint|directive|depcruise|knip)\/[\w/-]+$/, `key without a tool and rule: ${key}`);
    assert.ok(Number.isInteger(baseline[key]) && baseline[key] > 0, `count invalid: ${key}`);
    assert.ok(!HARD_RULES.some((h) => rule.endsWith(`/${h}`)), `hard rule in the baseline: ${key}`);
    assert.ok(!file.includes('/vendor/') && !file.startsWith('test/fixtures/lint/'), `excluded file in the baseline: ${file}`);
    if (!existsSync(join(REPO, file))) stale.push(file);
  }
  assert.deepEqual([...new Set(stale)], [], 'baseline names files that do not exist');
});

test('the real lint-baseline-reasons.json is sorted and explains every error-text key', () => {
  const baseline = JSON.parse(readFileSync(join(REPO, 'lint-baseline.json'), 'utf8'));
  const reasons = JSON.parse(readFileSync(join(REPO, 'lint-baseline-reasons.json'), 'utf8'));
  const keys = Object.keys(reasons);
  assert.deepEqual(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'keys not sorted');
  for (const key of keys) {
    assert.ok(key in baseline, `reason without a baseline key: ${key}`);
    assert.ok(typeof reasons[key] === 'string' && reasons[key].trim().length >= 20, `reason too short: ${key}`);
  }
  const errorText = Object.keys(baseline).filter((key) => key.endsWith('\toxlint/no-restricted-syntax/ERROR-TEXT'));
  assert.ok(errorText.length > 0, 'the baseline carries no error-text key');
  assert.deepEqual(errorText.filter((key) => !(key in reasons)), [], 'error-text keys without a reason');
});
