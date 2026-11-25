/**
 * Module: test infrastructure - lint baseline (phase 1b, section D)
 * Purpose: scripts/check-lint-baseline.ts turns the lint tools into a CI gate that only sinks.
 *          Checked on a fixture project in a temp directory that runs the REAL rule set
 *          (.oxlintrc.json, copied with the plugin path made absolute): an extra finding gives
 *          exit 1 naming file and rule, a fixed one exit 0 with "Baseline can sink", --update
 *          lowers and never raises, a hard rule fails even with --init, a broken tool run is
 *          exit 2, a disable comment is a finding of its own (hard without a rule list or for
 *          no-restricted-syntax). The fixture test/fixtures/lint/ must give exactly its sixteen
 *          findings, the TypeScript layer fixture test/fixtures/lint/layers/ exactly its three
 *          dependency-cruiser violations, the knip fixture test/fixtures/lint/knip/ (run with the
 *          real knip.json) exactly its six findings; a knip entry that names no file is exit 2;
 *          the sender fixture test/fixtures/lint/senders/ exactly its two import violations and
 *          ten lint lines, all hard; no override for a server/ file loses a sender selector
 *          it is not exempt from; every sender the rules name still sends (module graph),
 *          and the lint exceptions name the same files as the import rules;
 *          the real tree has no hard finding (this runs in the required test jobs, next to the
 *          lint job); the real lint-baseline.json is sorted, carries no hard rule and names no
 *          missing file. The rights fixture test/fixtures/lint/rights/ (phase 2, B5, B8c) must give
 *          exactly its marked RIGHTS-SQL, RIGHTS-MODULE and RIGHTS-ROW lines, nothing under
 *          server/authorize/, server/db.js or server/openapi/, and exactly its two imports past
 *          server/authorize/index.ts; RIGHTS-MODULE and both authorize import rules are hard,
 *          a RIGHTS-SQL or RIGHTS-ROW key needs a reason, and a RIGHTS-ROW finding outside the
 *          listed counts is red and never taken in by --update. The fixture test/fixtures/lint/error-text/ must give exactly its
 *          thirty-three ERROR-TEXT findings (the self-test cases of the text reader the rule
 *          replaced, phase 1b section E, and the spellings a probe against that reader
 *          found) and nothing for the lines it must leave alone. A
 *          baseline key of that rule needs a reason in lint-baseline-reasons.json, and a
 *          reason needs its key. The fixture test/fixtures/lint/sql-in-list/ (Refs #2810) must
 *          give exactly its thirteen SQL-IN-LIST lines (one SQL placeholder per value, one line
 *          per spelling) and nothing in server/db.js; a SQL-IN-LIST key needs a reason.
 *          A TX-MANUAL key needs a reason as well (phase 2, F6b: exec or prepare, string or
 *          template literal), and in the server only server/db/tx.ts and the instance lock
 *          carry one. Phase 2, F6c: effectiveSelectors() resolves the overrides as oxlint does
 *          (measured on a fixture), and over it SYNC-ONLY (hard) holds in exactly the files of
 *          the synchronous areas, DB-SINGLETON (a baseline that only sinks) in exactly
 *          server/services/ and server/authorize/, and every server/ file gets the server list
 *          plus its areas minus its named exemptions; the generator's nesting check refuses
 *          two entries of one rank; the fixtures sync-only/ and db-singleton/ give exactly
 *          their marked lines. Phase 2, F6d: TX-DRIVER (hard) holds in server/ only; the fixture
 *          tx-driver/ gives exactly its marked driver calls and the withTx lines with options
 *          under TX-ASYNC-FN and TX-AWAIT-INSIDE, and nothing under test/.
 * Run:     npm run test:lint-baseline
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmp-dir.js';
import { buildOverrides, checkNesting, patternCovers, pushSenders } from '../scripts/generate-oxlint-overrides.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'check-lint-baseline.ts');
const OXLINT = join(REPO, 'node_modules', 'oxlint', 'bin', 'oxlint');
const FIXTURE = join(REPO, 'test', 'fixtures', 'lint');
const DEPCRUISE = join(REPO, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const DEPCRUISE_CONFIG = join(REPO, '.dependency-cruiser.mjs');
const KNIP = join(REPO, 'node_modules', 'knip', 'bin', 'knip.js');
const CONFIG = JSON.parse(readFileSync(join(REPO, '.oxlintrc.json'), 'utf8'));
const HARD_RULES = ['HTML-STRING-WRITE', 'TX-ASYNC-FN', 'TX-AWAIT-INSIDE', 'CHANNEL-SEND', 'PUSH-SEND',
  'push-service-importers', 'web-push-only-in-push-service', 'channel-delivery-importers', 'providers-only-in-channel-delivery',
  'RIGHTS-MODULE', 'rights-only-through-authorize', 'authorize-not-to-db', 'settings-is-a-leaf',
  'blanket-disable', 'disable-no-restricted-syntax', 'SYNC-ONLY', 'TX-DRIVER'];

/** The real rule set for a directory outside the repo: no fixture ignore, plugin by absolute URL. */
function portableConfig() {
  const config = structuredClone(CONFIG);
  delete config.$schema;
  config.ignorePatterns = config.ignorePatterns.filter((/** @type {string} */ p) => p !== 'test/fixtures/lint/**');
  config.jsPlugins = config.jsPlugins.map((/** @type {{ name: string, specifier: string }} */ p) => ({ ...p, specifier: import.meta.resolve(p.specifier) }));
  return config;
}

// A plain debt rule (no reason, not hard) for the ratchet itself: UTC-DAY-KEY. TX-MANUAL served
// here until it became a list of exceptions with reasons (phase 2, F6b).
const ONE_DEBT = 'export const f = (d) => d.toISOString().slice(0, 10);\n';
const TWO_DEBT = 'export const f = (d) => [d.toISOString().slice(0, 10), d.toISOString().slice(0, 10)];\n';
const NONE = 'export function f(db) { return db; }\n';

function project(source = TWO_DEBT) {
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
const DEBT = 'server/x.js\toxlint/no-restricted-syntax/UTC-DAY-KEY';
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
    assert.deepEqual(baselineOf(dir), { [DEBT]: 2 });
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
    assert.match(r.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/UTC-DAY-KEY\s+0 -> 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an extra finding: exit 1, file and rule are named', () => {
  const dir = project(ONE_DEBT);
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), TWO_DEBT);
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/UTC-DAY-KEY\s+1 -> 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new key (another file): exit 1', () => {
  const dir = project();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'y.js'), ONE_DEBT);
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /server\/y\.js\s+oxlint\/no-restricted-syntax\/UTC-DAY-KEY\s+0 -> 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a fixed finding: exit 0 with a hint, the baseline stays', () => {
  const dir = project();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), ONE_DEBT);
    const r = run(dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /Baseline can sink: 1 key/);
    assert.deepEqual(baselineOf(dir), { [DEBT]: 2 }, 'without --update the file stays');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--update lowers and removes, but never raises', () => {
  const dir = project();
  try {
    run(dir, '--init');
    writeFileSync(join(dir, 'server', 'x.js'), ONE_DEBT);
    assert.equal(run(dir, '--update').code, 0);
    assert.deepEqual(baselineOf(dir), { [DEBT]: 1 });
    writeFileSync(join(dir, 'server', 'x.js'), TWO_DEBT);
    assert.equal(run(dir, '--update').code, 1);
    assert.deepEqual(baselineOf(dir), { [DEBT]: 1 });
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
  assert.deepEqual(CONFIG.rules['max-lines-per-function'], ['error', { max: 200, skipComments: true, skipBlankLines: true }]);
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
    writeFileSync(join(dir, 'public', 'utils', 'digits.js'), 'export const d = 1;\n');
    writeFileSync(join(dir, 'public', 'utils', 'u.js'), 'export const u = 1;\n');
    writeFileSync(join(dir, 'server', 'services', 'ok.js'), "import { d } from '../../public/utils/digits.js';\nexport const ok = () => d;\n");
    assert.equal(run(dir, '--init').code, 0);
    assert.deepEqual(baselineOf(dir), {}, 'importing a target on the frozen list (SERVER_PUBLIC_IMPORTS) is allowed');
    writeFileSync(join(dir, 'server', 'services', 'p.js'), "import { p } from '../../public/pages/p.js';\nexport const q = p;\n");
    // The list is frozen (decision E16): a module under public/utils/ that is not on it is a violation.
    writeFileSync(join(dir, 'server', 'services', 'fresh.js'), "import { u } from '../../public/utils/u.js';\nexport const f = u;\n");
    writeFileSync(join(dir, 'public', 'utils', 's.js'), "import { ok } from '../../server/services/ok.js';\nexport const s = ok;\n");
    writeFileSync(join(dir, 'server', 'services', 'gone.js'), "import { x } from './missing.js';\nexport const g = x;\n");
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    for (const [file, rule] of [
      ['server/services/p.js', 'server-not-to-public-except-shared'],
      ['server/services/fresh.js', 'server-not-to-public-except-shared'],
      ['public/utils/s.js', 'public-not-to-server'],
      ['server/services/gone.js', 'unresolved-import'],
    ]) {
      const lines = r.out.split('\n').map((l) => l.trim().split(/\s+/).join(' '));
      assert.ok(lines.includes(`${file} depcruise/${rule} 0 -> 1`), `${file} ${rule}:\n${r.out}`);
    }
    // A sender rule is hard: it is named on its own and never ratchets.
    writeFileSync(join(dir, 'server', 'services', 'w.js'), "import { sendNotification } from 'web-push';\nexport const w = sendNotification;\n");
    const hard = run(dir);
    assert.equal(hard.code, 1, hard.out);
    assert.match(hard.out, /Hard rules[\s\S]*server\/services\/w\.js\s+depcruise\/web-push-only-in-push-service\s+1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server/authorize/ reaching server/db.js, also through another module, is a finding', () => {
  // db.js opens the database on import; the permission module takes the connection
  // as a parameter instead (phase 2, B1). The indirect case is the one that happened.
  const dir = project(NONE);
  try {
    copyFileSync(DEPCRUISE_CONFIG, join(dir, '.dependency-cruiser.mjs'));
    for (const d of ['server/authorize', 'server/services']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'server', 'db.js'), 'export const get = () => null;\n');
    writeFileSync(join(dir, 'server', 'services', 'uses-db.js'), "import { get } from '../db.js';\nexport const u = get;\n");
    writeFileSync(join(dir, 'server', 'authorize', 'index.ts'), 'export const c = 1;\n');
    writeFileSync(join(dir, 'server', 'x.js'), "import { c } from './authorize/index.ts';\nimport { get } from './db.js';\nexport const x = [c, get];\n");
    assert.equal(run(dir, '--init').code, 0);
    assert.deepEqual(baselineOf(dir), {}, 'a module outside server/authorize/ may load db.js');
    writeFileSync(join(dir, 'server', 'authorize', 'actor.ts'), "import { u } from '../services/uses-db.js';\nexport const a = u;\n");
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    // Hard since phase 2, B5: named on its own, never a baseline key.
    assert.match(r.out, /Hard rules[\s\S]*server\/authorize\/actor\.ts\s+depcruise\/authorize-not-to-db\s+1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server/settings/ importing a service, a route or server/db.js is a hard finding (phase 2, C3)', () => {
  // The settings registry is a leaf under the services: every service may ask it,
  // so it must never import one back. module-capabilities.js is the one pure
  // grammar under services/ it may read.
  const dir = project(NONE);
  try {
    copyFileSync(DEPCRUISE_CONFIG, join(dir, '.dependency-cruiser.mjs'));
    for (const d of ['server/settings', 'server/services', 'server/routes', 'server/utils']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'server', 'db.js'), 'export const get = () => null;\n');
    writeFileSync(join(dir, 'server', 'utils', 'zone.js'), 'export const z = 1;\n');
    writeFileSync(join(dir, 'server', 'services', 'module-capabilities.js'), 'export const isWidgetId = () => true;\n');
    writeFileSync(join(dir, 'server', 'services', 'sync.js'), 'export const s = 1;\n');
    writeFileSync(join(dir, 'server', 'routes', 'prefs.js'), 'export const p = 1;\n');
    writeFileSync(join(dir, 'server', 'settings', 'registry.ts'),
      "import { z } from '../utils/zone.js';\nimport { isWidgetId } from '../services/module-capabilities.js';\nexport const r = [z, isWidgetId];\n");
    assert.equal(run(dir, '--init').code, 0);
    assert.deepEqual(baselineOf(dir), {}, 'utils and the widget-id grammar are allowed');
    for (const [file, source] of [
      ['service.ts', "import { s } from '../services/sync.js';\nexport const a = s;\n"],
      ['route.ts', "import { p } from '../routes/prefs.js';\nexport const a = p;\n"],
      ['db.ts', "import { get } from '../db.js';\nexport const a = get;\n"],
    ]) writeFileSync(join(dir, 'server', 'settings', file), source);
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    for (const file of ['service.ts', 'route.ts', 'db.ts']) {
      assert.match(r.out, new RegExp(`Hard rules[\\s\\S]*server/settings/${file.replace('.', '\\.')}\\s+depcruise/settings-is-a-leaf\\s+1`), r.out);
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

test('the fixture gives exactly its sixteen findings, and nothing for the allowed lines', () => {
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
      'tx.js:12 TX-ASYNC-FN', // async function passed to withTx()
      'tx.js:14 TX-AWAIT-INSIDE', // await nested in a synchronous withTx() body
      'tx.js:17 TX-MANUAL', // exec with a string literal
      'tx.js:18 TX-MANUAL', // exec with a template literal (phase 2, F6b)
      'tx.js:19 TX-MANUAL', // prepare with a string literal (phase 2, F6b)
      'tx.js:20 TX-MANUAL', // prepare with a template literal (phase 2, F6b)
      'tx.js:7 TX-ASYNC-FN', // async transaction function
      'tx.js:9 TX-AWAIT-INSIDE', // await nested in a synchronous transaction body
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

/** @typedef {{ selector: string, message: string }} Selector */
/** @typedef {{ files: string[], rules: Record<string, [string, ...Selector[]]> }} Override */
const RESTRICTED = 'eslint-js/no-restricted-syntax';
/** @param {string} file */
const overrideFor = (file) => CONFIG.overrides.find((/** @type {Override} */ o) => o.files.includes(file));
/**
 * The selectors server/ files get: the base rule plus the sender selectors.
 * @returns {[string, ...Selector[]]}
 */
function serverSelectors() {
  const override = overrideFor('server/**');
  assert.ok(override, 'no override for server/**');
  return override.rules[RESTRICTED];
}
/** @param {string} tag @returns {(s: Selector) => boolean} */
const tagged = (tag) => (s) => s.message.startsWith(`${tag}:`);

const SERVER_ONLY = ['CHANNEL-SEND', 'PUSH-SEND', 'RIGHTS-SQL', 'RIGHTS-MODULE', 'RIGHTS-ROW', 'SQL-IN-LIST', 'TX-DRIVER'];
/** @param {Selector} s */
const serverOnly = (s) => SERVER_ONLY.some((tag) => tagged(tag)(s));

test('server/ gets the whole base rule plus the sender, rights and SQL list selectors, nothing else', () => {
  const [severity, ...base] = CONFIG.rules[RESTRICTED];
  const [serverSeverity, ...server] = serverSelectors();
  assert.equal(serverSeverity, severity);
  assert.deepEqual(server.slice(0, base.length), base);
  const extra = server.slice(base.length);
  assert.ok(extra.every(serverOnly), 'only sender, rights and SQL list selectors are added');
  for (const tag of SERVER_ONLY) assert.ok(extra.some(tagged(tag)), `server/** carries no ${tag} selector`);
  // Test files may stub a sender or seed a visibility value; the rules are for server/ only.
  assert.ok(!base.some(serverOnly), 'a server-only selector in the base rule');
});

// Where the rights rules are the rule itself (phase 2, B5, B8c): the permission module and
// the API documentation; the schema and its migrations (server/migrations/, one file each;
// migrations write visibility values, compare a row's level while they move data, and keep
// their SQL as it was applied) have an exception of their own that drops the rights and the
// SQL list selectors (Refs #2810).
const RIGHTS_TAGS = ['RIGHTS-SQL', 'RIGHTS-MODULE', 'RIGHTS-ROW'];
const RIGHTS_HOME = ['server/authorize/**', 'server/openapi/**'];
const SCHEMA_HOME = ['server/db.js', 'server/migrations/**'];

/**
 * The no-restricted-syntax list oxlint applies to `file` (repository-relative, `/`): the LAST
 * override whose `files` match wins whole, else the base rule. This is how oxlint 1.93
 * resolves overrides, measured on a fixture below ("oxlint resolves overrides ...").
 * Patterns: `dir/**` and `*` inside one path segment.
 * @param {any} config @param {string} file @returns {Selector[]}
 */
function effectiveSelectors(config, file) {
  /** @param {string} glob */
  const re = (glob) => new RegExp(`^${glob.replace(/\/\*\*$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}${glob.endsWith('/**') ? '/.*' : ''}$`);
  let list = config.rules[RESTRICTED];
  for (const o of config.overrides ?? []) {
    if (o.rules?.[RESTRICTED] && o.files.some((/** @type {string} */ g) => re(g).test(file))) list = o.rules[RESTRICTED];
  }
  return list.slice(1);
}
/** @param {string} file @param {string} tag */
const hasTag = (file, tag) => effectiveSelectors(CONFIG, file).some(tagged(tag));
/** Every selector with `tag` in any override (the areas add theirs in overrides only). @param {string} tag */
const selectorsTagged = (tag) => [...new Map(CONFIG.overrides
  .flatMap((/** @type {Override} */ o) => o.rules[RESTRICTED].slice(1))
  .filter(tagged(tag)).map((/** @type {Selector} */ s) => [JSON.stringify(s), s])).values()];

/** Every file under server/ that oxlint lints, as oxlint names it. */
const SERVER_FILES = `${spawnSync(process.execPath, [OXLINT, '--debug=files', '.'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 29 }).stdout}`
  .split('\n').map((f) => f.trim().split('\\').join('/')).filter((f) => f.startsWith('server/'));

// The areas of phase 2, F6c, spelled here a second time on purpose: the generator's list
// is what is tested, not what the test reads back.
const SYNC_EXEMPT = ['server/db/backup.ts', 'server/db/restore.ts'];
/** @param {string} f */
const inSyncArea = (f) => !SYNC_EXEMPT.includes(f) && (['server/authorize/', 'server/migrations/', 'server/db/'].some((d) => f.startsWith(d))
  || f === 'server/db.js' || /^server\/services\/[^/]+-slices\.ts$/.test(f));
/** @param {string} f */
const inDbArea = (f) => f.startsWith('server/services/') || f.startsWith('server/authorize/');

test('oxlint resolves overrides as effectiveSelectors() does: the last match wins whole, * stays in one segment', () => {
  const dir = tempDir('yuvomi-oxlint-resolve-');
  try {
    for (const d of ['server/x', 'server/s/sub']) mkdirSync(join(dir, d), { recursive: true });
    const source = 'export async function f(db: any): Promise<number> { return db.get(); }\n';
    const files = ['server/a.ts', 'server/x/b.ts', 'server/s/a-slices.ts', 'server/s/sub/b-slices.ts'];
    for (const f of files) writeFileSync(join(dir, f), source);
    const get = { selector: "CallExpression[arguments.length=0][callee.property.name='get']", message: 'GET: get' };
    const fnA = { selector: ':function[async=true]', message: 'ASYNC-A: async' };
    const fnB = { selector: ':function[async=true]', message: 'ASYNC-B: async' };
    const config = {
      ...portableConfig(), rules: { [RESTRICTED]: ['error'] },
      overrides: [
        { files: ['server/**'], rules: { [RESTRICTED]: ['error', get] } },
        { files: ['server/x/**'], rules: { [RESTRICTED]: ['error', fnA] } },
        { files: ['server/s/*-slices.ts'], rules: { [RESTRICTED]: ['error', fnB, get] } },
      ],
    };
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(config));
    const r = spawnSync(process.execPath, [OXLINT, '--format', 'json', '.'], { cwd: dir, encoding: 'utf8' });
    const found = JSON.parse(r.stdout).diagnostics
      .filter((/** @type {{ code: string }} */ d) => d.code.includes('no-restricted-syntax'))
      .map((/** @type {{ filename: string, message: string }} */ d) => `${d.filename} ${d.message.split(':')[0]}`).sort();
    const predicted = files.flatMap((f) => effectiveSelectors(config, f).map((s) => `${f} ${s.message.split(':')[0]}`)).sort();
    assert.deepEqual(found, predicted);
    // The measurement itself: server/x/b.ts lost GET to the later override; a slice one level
    // deeper is not matched by `*`.
    assert.deepEqual(predicted, [
      'server/a.ts GET', 'server/s/a-slices.ts ASYNC-B', 'server/s/a-slices.ts GET', 'server/s/sub/b-slices.ts GET', 'server/x/b.ts ASYNC-A',
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SYNC-ONLY holds in every real file of the synchronous areas, and nowhere else', () => {
  const sync = SERVER_FILES.filter(inSyncArea);
  for (const [area, min] of /** @type {[string | RegExp, number][]} */ ([
    ['server/authorize/', 5], ['server/migrations/', 100], ['server/db/', 3], ['server/db.js', 1], [/^server\/services\/[^/]+-slices\.ts$/, 10],
  ])) {
    const n = sync.filter((f) => (typeof area === 'string' ? f.startsWith(area) : area.test(f))).length;
    assert.ok(n >= min, `${area}: only ${n} files`);
  }
  const missing = sync.filter((f) => !hasTag(f, 'SYNC-ONLY'));
  assert.deepEqual(missing, [], 'a file of a synchronous area without SYNC-ONLY');
  const stray = SERVER_FILES.filter((f) => !inSyncArea(f) && hasTag(f, 'SYNC-ONLY'));
  assert.deepEqual(stray, [], 'SYNC-ONLY outside its areas');
  for (const f of [...SYNC_EXEMPT, 'server/routes/tasks.js', 'server/index.js', 'public/app.js', 'server/services/push.js']) {
    assert.ok(!hasTag(f, 'SYNC-ONLY'), `${f} carries SYNC-ONLY`);
  }
  assert.equal(selectorsTagged('SYNC-ONLY').length, 3, 'async function, await, for await');
});

test('DB-SINGLETON holds in every real file under server/services/ and server/authorize/, and nowhere else', () => {
  const area = SERVER_FILES.filter(inDbArea);
  assert.ok(area.length > 100, 'too few files in the services and the permission module');
  assert.deepEqual(area.filter((f) => !hasTag(f, 'DB-SINGLETON')), [], 'a service without DB-SINGLETON');
  assert.deepEqual(SERVER_FILES.filter((f) => !inDbArea(f) && hasTag(f, 'DB-SINGLETON')), [], 'DB-SINGLETON outside its areas');
  for (const f of ['server/db/backup.ts', 'server/routes/tasks.js', 'server/index.js', 'public/app.js']) {
    assert.ok(!hasTag(f, 'DB-SINGLETON'), `${f} carries DB-SINGLETON`);
  }
  assert.equal(selectorsTagged('DB-SINGLETON').length, 1);
});

test('the rights exception covers exactly the permission module and the API docs, and drops only the rights selectors', () => {
  for (const file of SERVER_FILES) {
    const inRights = RIGHTS_HOME.some((h) => file.startsWith(h.slice(0, -2)));
    const inSchema = file === 'server/db.js' || file.startsWith('server/migrations/');
    for (const tag of RIGHTS_TAGS) assert.equal(hasTag(file, tag), !inRights && !inSchema, `${file} ${tag}`);
    assert.equal(hasTag(file, 'SQL-IN-LIST'), !inSchema, `${file} SQL-IN-LIST`);
  }
  assert.deepEqual(SCHEMA_HOME, ['server/db.js', 'server/migrations/**']);
});

test('the generator refuses a file under two exceptions (the later list would win whole)', () => {
  assert.throws(() => buildOverrides(CONFIG, ['server/authorize/x.js']), /overlap: server\/authorize\/x\.js and server\/authorize\/\*\*/);
  assert.throws(() => buildOverrides(CONFIG, ['server/utils/timezone.js']), /overlap/);
  assert.throws(() => buildOverrides(CONFIG, ['server/db/backup.ts']), /overlap/);
});

test('the nesting check lets through only an inner entry after its outer one that keeps what it adds', () => {
  const a = { selector: 'A', message: 'A: a' };
  const b = { selector: 'B', message: 'B: b' };
  /** @param {string[]} files @param {object[]} list */
  const entry = (files, list) => ({ files, rules: { [RESTRICTED]: ['error', ...list] } });
  const none = () => [];
  // Same pattern twice, crossing file globs, the outer entry after the inner one: refused.
  assert.throws(() => checkNesting([entry(['server/**'], [a]), entry(['server/**'], [a])], none), /overlap: server\/\*\* and server\/\*\*/);
  assert.throws(() => checkNesting([entry(['server/s/*-a.ts'], [a]), entry(['server/s/b-*.ts'], [a])], none), /overlap/);
  assert.throws(() => checkNesting([entry(['server/x/**'], [a]), entry(['server/**'], [a])], none), /overlap/);
  // Nested, but the inner one loses what the outer one has and may not drop it.
  assert.throws(() => checkNesting([entry(['server/**'], [a, b]), entry(['server/x/**'], [a])], none), /server\/x\/\*\* loses what server\/\*\* adds: B/);
  // Allowed: nested and keeping it, or dropping exactly what its exception names.
  checkNesting([entry(['server/**'], [a]), entry(['server/x/**'], [a, b]), entry(['server/x/y.js'], [a, b])], none);
  checkNesting([entry(['server/**'], [a, b]), entry(['server/x/**'], [a])], () => [b]);
  checkNesting([entry(['server/s/**'], [a]), entry(['server/s/*-slices.ts'], [a, b])], none);
  assert.ok(patternCovers('server/s/*-slices.ts', 'server/s/x-slices.ts'));
  assert.ok(!patternCovers('server/s/*-slices.ts', 'server/s/sub/x-slices.ts'), '* stays in one segment');
});

test('the timezone exception drops only the UTC selector', () => {
  const [, ...selectors] = serverSelectors();
  const kept = new Set(effectiveSelectors(CONFIG, 'server/utils/timezone.js').map((s) => JSON.stringify(s)));
  const lost = selectors.filter((s) => !kept.has(JSON.stringify(s)));
  assert.deepEqual(lost, selectors.filter(tagged('UTC-DAY-KEY')));
});

test('each sender exception drops only its own sender selectors', () => {
  const [, ...selectors] = serverSelectors();
  const push = selectors.filter(tagged('PUSH-SEND'));
  const sendPushToUser = push.filter((s) => s.selector.includes('sendPushToUser'));
  assert.equal(sendPushToUser.length, 1);
  /** @param {string} file */
  const lostBy = (file) => selectors.filter((s) => !effectiveSelectors(CONFIG, file).some((t) => JSON.stringify(t) === JSON.stringify(s)));
  assert.deepEqual(lostBy('server/services/channel-delivery.js'), selectors.filter(tagged('CHANNEL-SEND')));
  assert.deepEqual(lostBy('server/services/push.js'), push);
  for (const file of PUSH_SENDERS) assert.deepEqual(lostBy(file), sendPushToUser, file);
});

test('no server/ file loses a sender, area or other selector it is not exempt from', () => {
  // oxlint replaces the whole option list per override and the later one wins, so an
  // override that copies only the base rule would switch the sender rules off for its files,
  // and one written before an area's override would switch the area's rule off.
  const [, ...selectors] = serverSelectors();
  const channel = selectors.filter(tagged('CHANNEL-SEND'));
  const push = selectors.filter(tagged('PUSH-SEND'));
  const sync = selectorsTagged('SYNC-ONLY');
  const handle = selectorsTagged('DB-SINGLETON');
  assert.ok(channel.length > 0 && push.length > 0, 'the server/** override carries no sender selectors');
  /** @param {string[]} tags */
  const byTags = (tags) => selectors.filter((s) => tags.some((tag) => tagged(tag)(s)));
  /** The documented exemptions: what a file may drop. @param {string} file @returns {Selector[]} */
  const mayDrop = (file) => {
    if (file === 'server/services/channel-delivery.js') return channel;
    if (file === 'server/services/push.js') return push;
    if (PUSH_SENDERS.includes(file)) return push.filter((s) => s.selector.includes('sendPushToUser'));
    if (file === 'server/utils/timezone.js') return byTags(['UTC-DAY-KEY']);
    if (file === 'server/db.js' || file.startsWith('server/migrations/')) return byTags([...RIGHTS_TAGS, 'SQL-IN-LIST']);
    if (RIGHTS_HOME.some((h) => file.startsWith(h.slice(0, -2)))) return byTags(RIGHTS_TAGS);
    return [];
  };
  const key = (/** @type {Selector} */ s) => JSON.stringify(s);
  const wrong = [];
  for (const file of new Set([...SERVER_FILES, ...PUSH_SENDERS])) {
    const expected = [...selectors, ...(inSyncArea(file) ? sync : []), ...(inDbArea(file) ? handle : [])]
      .filter((s) => !mayDrop(file).includes(s)).map(key).sort();
    const actual = effectiveSelectors(CONFIG, file).map(key).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const lost = expected.filter((s) => !actual.includes(s)).map((s) => JSON.parse(s).message.split(':')[0]);
      const extra = actual.filter((s) => !expected.includes(s)).map((s) => JSON.parse(s).message.split(':')[0]);
      wrong.push(`${file}: lost [${lost}] extra [${extra}]`);
    }
  }
  assert.ok(SERVER_FILES.length > 500, 'the server files were not read');
  assert.deepEqual(wrong, [], 'a server/ file gets another list than its areas and exemptions say');
});

/** Files a rule lets through, as the pathNot list of .dependency-cruiser.mjs spells them. */
async function exemptPaths(/** @type {string} */ ruleName) {
  const { default: config } = await import(pathToFileURL(DEPCRUISE_CONFIG).href);
  const rule = config.forbidden.find((/** @type {{ name: string }} */ r) => r.name === ruleName);
  assert.ok(rule, `no rule ${ruleName}`);
  return [rule.from.pathNot].flat().map((/** @type {string} */ p) => new RegExp(p));
}
// The push senders as push-service-importers names them (push.js itself apart). The
// generator reads the same list, so a new sender is named once, in .dependency-cruiser.mjs.
const PUSH_SENDERS = await pushSenders(REPO);
const GENERATOR = join(REPO, 'scripts', 'generate-oxlint-overrides.mjs');

test('the push senders are read from push-service-importers', () => {
  assert.deepEqual([...PUSH_SENDERS].sort(), [
    'server/routes/push.js', 'server/routes/tasks.js',
    'server/services/medication-scheduler.js', 'server/services/notifications.js',
  ]);
});

test('the overrides in .oxlintrc.json are what the generator writes', () => {
  const r = spawnSync(process.execPath, [GENERATOR, '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // Counter-check on a copy: a sender named in .dependency-cruiser.mjs but missing from
  // the lint exceptions is out of date, and a run of the generator brings it in.
  const dir = tempDir('yuvomi-oxlint-overrides-');
  try {
    const depcruise = readFileSync(DEPCRUISE_CONFIG, 'utf8');
    const named = "'^server/routes/push\\\\.[jt]s$',";
    assert.ok(depcruise.includes(named), 'push.js is not named in push-service-importers as expected');
    writeFileSync(join(dir, '.dependency-cruiser.mjs'), depcruise.replace(named, () => `${named} '^server/services/sixth\\\\.[jt]s$',`));
    copyFileSync(join(REPO, '.oxlintrc.json'), join(dir, '.oxlintrc.json'));
    const stale = spawnSync(process.execPath, [GENERATOR, '--check', '--root', dir], { encoding: 'utf8' });
    assert.equal(stale.status, 1, 'a new push sender must make the overrides stale');
    const write = spawnSync(process.execPath, [GENERATOR, '--root', dir], { encoding: 'utf8' });
    assert.equal(write.status, 0, write.stderr);
    const regenerated = JSON.parse(readFileSync(join(dir, '.oxlintrc.json'), 'utf8'));
    // The new sender sits under server/services/, so its entry comes after the services area.
    const at = (/** @type {string} */ f) => regenerated.overrides.findLastIndex((/** @type {Override} */ o) => o.files.includes(f));
    assert.ok(at('server/services/sixth.js') > at('server/services/**'));
    const list = regenerated.overrides[at('server/services/sixth.js')].rules[RESTRICTED].slice(1);
    assert.ok(!list.some((/** @type {Selector} */ s) => s.selector?.includes('sendPushToUser')), 'the new sender may call sendPushToUser');
    assert.ok(list.some(tagged('DB-SINGLETON')), 'the new sender keeps the services area');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lint exceptions name exactly the senders the import rules let through', async () => {
  // The files that may call sendPushToUser, as the overrides resolve.
  const callers = SERVER_FILES.filter((f) => !effectiveSelectors(CONFIG, f).some((s) => s.selector.includes('sendPushToUser')));
  assert.deepEqual(callers.sort(), [...PUSH_SENDERS, 'server/services/push.js'].sort());
  const pushImporters = await exemptPaths('push-service-importers');
  for (const file of [...PUSH_SENDERS, 'server/services/push.js']) assert.ok(pushImporters.some((re) => re.test(file)), `${file} is not a named push importer`);
  assert.equal(pushImporters.length, PUSH_SENDERS.length + 1, 'a push importer without a lint exception');
  const channelOverride = overrideFor('server/services/channel-delivery.js');
  assert.deepEqual(channelOverride?.files, ['server/services/channel-delivery.js']);
});

test('every sender the import rules name still sends (the list may only shrink)', async () => {
  // A stale exception would let the next file in under an old name. Checked on the
  // module graph, not on the spelling: each named importer imports what it is named for.
  const r = spawnSync(process.execPath, [DEPCRUISE, '--config', DEPCRUISE_CONFIG, '--output-type', 'json', 'server'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 29,
  });
  const modules = JSON.parse(r.stdout).modules;
  assert.ok(modules.length > 100, 'dependency-cruiser read too few modules');
  /** @param {string} target */
  const importersOf = (target) => modules
    .filter((/** @type {{ dependencies: { resolved: string }[] }} */ m) => m.dependencies.some((d) => d.resolved === target))
    .map((/** @type {{ source: string }} */ m) => m.source);
  for (const [rule, target] of [
    ['push-service-importers', 'server/services/push.js'],
    ['channel-delivery-importers', 'server/services/channel-delivery.js'],
  ]) {
    const importers = importersOf(target);
    const stale = (await exemptPaths(rule))
      .filter((re) => !re.test(target) && !importers.some((/** @type {string} */ m) => re.test(m)))
      .map(String);
    assert.deepEqual(stale, [], `${rule}: named but no longer importing ${target}`);
  }
  assert.deepEqual(importersOf('server/services/notification-providers/gotify.js'), ['server/services/channel-delivery.js']);
});

test('the sender fixture gives exactly its two import violations', () => {
  const r = spawnSync(process.execPath, [DEPCRUISE, '--config', DEPCRUISE_CONFIG, '--output-type', 'json', 'server'], {
    cwd: join(FIXTURE, 'senders'), encoding: 'utf8',
  });
  const report = JSON.parse(r.stdout);
  assert.equal(report.summary.totalCruised, 8, 'dependency-cruiser does not read the whole sender fixture');
  const found = report.summary.violations
    .map((/** @type {{ rule: { name: string }, from: string, to: string }} */ v) => `${v.rule.name} ${v.from} -> ${v.to}`)
    .sort();
  assert.deepEqual(found, [
    'channel-delivery-importers server/services/fifth.js -> server/services/channel-delivery.js', // a fifth importer
    'providers-only-in-channel-delivery server/routes/sixth.js -> server/services/notification-providers/gotify.js', // past the bottleneck
  ]);
});

test('the sender fixture gives exactly its lint lines, and the ratchet holds them all as hard', () => {
  const dir = tempDir('yuvomi-sender-fixture-');
  try {
    cpSync(join(FIXTURE, 'senders'), dir, { recursive: true });
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    const lint = spawnSync(process.execPath, [OXLINT, '--format', 'json', '.'], { cwd: dir, encoding: 'utf8' });
    const found = JSON.parse(lint.stdout).diagnostics
      .map((/** @type {{ filename: string, message: string, labels: { span: { line: number } }[] }} */ d) => `${d.filename}:${d.labels[0].span.line} ${d.message.split(':')[0]}`)
      .sort();
    const handed = 'server/services/handed.js';
    assert.deepEqual(found, [
      `${handed}:11 CHANNEL-SEND`, `${handed}:11 CHANNEL-SEND`, // provider.send({ channel }): name and shape
      `${handed}:12 CHANNEL-SEND`, `${handed}:12 CHANNEL-SEND`, // providers[x].send({ ..., channel }): name and shape
      `${handed}:13 CHANNEL-SEND`, // p.send({ channel: ... }): the shape under any name
      `${handed}:14 CHANNEL-SEND`, // provider?.send(...): the name, optional call
      `${handed}:15 PUSH-SEND`, // pushService.sendPushToUser(...) handed in as a parameter
      `${handed}:16 PUSH-SEND`, // webpush.sendNotification(...)
      `${handed}:17 CHANNEL-SEND`, // this.providers[x].send(...): the name behind this
      `${handed}:18 CHANNEL-SEND`, // svc.providers[x].send(...): the name behind a member
      `${handed}:19 CHANNEL-SEND`, // deps.provider.send(...): the name as the last member
      `${handed}:20 CHANNEL-SEND`, // svc['providers'][x].send(...): the name as a computed key
    ]);
    copyFileSync(DEPCRUISE_CONFIG, join(dir, '.dependency-cruiser.mjs'));
    const r = run(dir, '--init');
    assert.equal(r.code, 1, r.out);
    const lines = r.out.split('\n').map((l) => l.trim().split(/\s+/).join(' '));
    for (const key of [
      `${handed} oxlint/no-restricted-syntax/CHANNEL-SEND 10`,
      `${handed} oxlint/no-restricted-syntax/PUSH-SEND 2`,
      'server/services/fifth.js depcruise/channel-delivery-importers 1',
      'server/routes/sixth.js depcruise/providers-only-in-channel-delivery 1',
    ]) assert.ok(lines.includes(key), `${key}:\n${r.out}`);
    assert.equal(existsSync(join(dir, 'lint-baseline.json')), false, 'a hard sender finding never enters a baseline');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const RIGHTS = join(FIXTURE, 'rights');

test('the rights fixture gives exactly its marked lint lines, and nothing where the rule lives', () => {
  const dir = tempDir('yuvomi-rights-fixture-');
  try {
    cpSync(RIGHTS, dir, { recursive: true });
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    // The fixture marks every line that must be reported with `rights-N: TAG`.
    const marked = ['server/routes/reads.js', 'server/routes/rows.js'].flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n')
      .flatMap((line, i) => {
        const m = /rights-\d+: ([A-Z-]+)/.exec(line);
        return m ? [`${file}:${i + 1} ${m[1]}`] : [];
      }));
    assert.deepEqual(marked.map((l) => l.split(' ')[1]), [
      ...Array(8).fill('RIGHTS-SQL'), ...Array(4).fill('RIGHTS-MODULE'), ...Array(21).fill('RIGHTS-ROW'),
    ], 'the fixture marks eight SQL, four module and twenty-one row lines');
    const r = spawnSync(process.execPath, [OXLINT, '--format', 'json', '.'], { cwd: dir, encoding: 'utf8' });
    const found = JSON.parse(r.stdout).diagnostics
      .map((/** @type {{ filename: string, message: string, labels: { span: { line: number } }[] }} */ d) => `${d.filename}:${d.labels[0].span.line} ${d.message.split(':')[0]}`)
      .sort();
    // Silent: server/authorize/rows/inside.ts (the rule itself, every spelling of rows.js
    // too), server/db.js (migrations), server/openapi/ (the docs), and the lines without a mark.
    assert.deepEqual(found, [...marked].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the rights fixture gives exactly its two imports past server/authorize/index.ts', () => {
  const r = spawnSync(process.execPath, [DEPCRUISE, '--config', DEPCRUISE_CONFIG, '--output-type', 'json', 'server', 'scripts', 'test'], {
    cwd: RIGHTS, encoding: 'utf8',
  });
  const report = JSON.parse(r.stdout);
  assert.equal(report.summary.totalCruised, 11, 'dependency-cruiser does not read the whole rights fixture');
  const found = report.summary.violations
    .map((/** @type {{ rule: { name: string }, from: string, to: string }} */ v) => `${v.rule.name} ${v.from} -> ${v.to}`)
    .sort();
  // Silent: server/routes/door.js (through index.ts), index.ts itself (inside), and
  // test/test-inner.js (a test checks an inner seam on its own).
  assert.deepEqual(found, [
    'rights-only-through-authorize scripts/tool.js -> server/authorize/rows/inside.ts',
    'rights-only-through-authorize server/routes/inner.js -> server/authorize/modules.ts',
  ]);
});

test('the ratchet holds RIGHTS-MODULE and the import rule as hard, and asks a reason for RIGHTS-SQL', () => {
  const dir = tempDir('yuvomi-rights-ratchet-');
  try {
    cpSync(RIGHTS, dir, { recursive: true });
    rmSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    copyFileSync(DEPCRUISE_CONFIG, join(dir, '.dependency-cruiser.mjs'));
    const hard = run(dir, '--init');
    assert.equal(hard.code, 1, hard.out);
    const lines = hard.out.split('\n').map((l) => l.trim().split(/\s+/).join(' '));
    for (const key of [
      'server/routes/reads.js oxlint/no-restricted-syntax/RIGHTS-MODULE 4',
      'server/routes/inner.js depcruise/rights-only-through-authorize 1',
      'scripts/tool.js depcruise/rights-only-through-authorize 1',
    ]) assert.ok(lines.includes(key), `${key}:\n${hard.out}`);
    assert.doesNotMatch(hard.out, /RIGHTS-SQL/, 'RIGHTS-SQL is a list of exceptions, not a hard rule');
    assert.doesNotMatch(hard.out, /RIGHTS-ROW/, 'RIGHTS-ROW is a list of exceptions, not a hard rule');
    assert.equal(existsSync(join(dir, 'lint-baseline.json')), false, 'a hard finding never enters a baseline');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // RIGHTS-SQL alone: the baseline takes the key, but only with a reason.
  const sql = project("export const f = (db) => db.prepare(`UPDATE t SET visibility = 'private' WHERE id = ?`);\n");
  try {
    const init = run(sql, '--init');
    assert.equal(init.code, 1, init.out);
    assert.match(init.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/RIGHTS-SQL\s+no reason/);
    assert.deepEqual(baselineOf(sql), { 'server/x.js\toxlint/no-restricted-syntax/RIGHTS-SQL': 1 });
    writeReasons(sql, { 'server/x.js\toxlint/no-restricted-syntax/RIGHTS-SQL': 'a write filter: narrows a row to private, reads nothing' });
    const ok = run(sql);
    assert.equal(ok.code, 0, ok.out);
  } finally { rmSync(sql, { recursive: true, force: true }); }
});

const SQL_LIST_FIXTURE = join(FIXTURE, 'sql-in-list');

test('the SQL-IN-LIST fixture gives exactly its thirteen marked lines, and nothing in the schema file', () => {
  const dir = tempDir('yuvomi-sql-in-list-fixture-');
  try {
    cpSync(SQL_LIST_FIXTURE, dir, { recursive: true });
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    // The fixture marks every line that must be reported with `sql-N`.
    const marked = ['server/routes/lists.js', 'server/authorize/rows.ts'].flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n')
      .flatMap((line, i) => (/\/\/ sql-\d+$/.test(line) ? [`${file}:${i + 1} SQL-IN-LIST`] : [])));
    assert.equal(marked.length, 13, 'the fixture marks thirteen spellings');
    const r = spawnSync(process.execPath, [OXLINT, '--format', 'json', '.'], { cwd: dir, encoding: 'utf8' });
    const found = JSON.parse(r.stdout).diagnostics
      .map((/** @type {{ filename: string, message: string, labels: { span: { line: number } }[] }} */ d) => `${d.filename}:${d.labels[0].span.line} ${d.message.split(':')[0]}`)
      .sort();
    // Silent: the function `silent` (one json_each parameter, two columns, a single '?',
    // maps that build something else) and server/db.js (migrations).
    assert.deepEqual(found, [...marked].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a SQL-IN-LIST key stands only with a reason (a fixed column list), never as a hard rule', () => {
  const dir = project("export const f = (db, cols) => db.prepare(`INSERT INTO t (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);\n");
  try {
    const init = run(dir, '--init');
    assert.equal(init.code, 1, init.out);
    assert.match(init.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/SQL-IN-LIST\s+no reason/);
    assert.doesNotMatch(init.out, /Hard rules have no baseline/);
    assert.deepEqual(baselineOf(dir), { 'server/x.js\toxlint/no-restricted-syntax/SQL-IN-LIST': 1 });
    writeReasons(dir, { 'server/x.js\toxlint/no-restricted-syntax/SQL-IN-LIST': 'a fixed column list of the table, not a list of values' });
    const ok = run(dir);
    assert.equal(ok.code, 0, ok.out);
    // A second list in the same file raises the count: red, and --update never takes it in.
    writeFileSync(join(dir, 'server', 'x.js'), "export const f = (db, cols) => db.prepare(`INSERT INTO t (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);\nexport const g = (db, ids) => db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => '?').join(',')})`);\n");
    const more = run(dir);
    assert.equal(more.code, 1, more.out);
    assert.match(more.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/SQL-IN-LIST\s+1 -> 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Lints a copy of a fixture project with the real rule set; returns the marked lines (`// <mark>-N`)
 * and the no-restricted-syntax findings, both as `file:line TAG`.
 * @param {string} name @param {string} mark @param {string} tag
 */
function markedFixture(name, mark, tag) {
  const dir = tempDir(`yuvomi-${name}-fixture-`);
  try {
    cpSync(join(FIXTURE, name), dir, { recursive: true });
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(js|ts)$/.test(f)).map((f) => f.split('\\').join('/'));
    const marked = files.flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n')
      .flatMap((line, i) => (new RegExp(`// ${mark}-\\d+$`).test(line) ? [`${file}:${i + 1} ${tag}`] : []))).sort();
    const r = spawnSync(process.execPath, [OXLINT, '--format', 'json', '.'], { cwd: dir, encoding: 'utf8' });
    const found = JSON.parse(r.stdout).diagnostics
      .filter((/** @type {{ code: string }} */ d) => d.code.includes('no-restricted-syntax'))
      .map((/** @type {{ filename: string, message: string, labels: { span: { line: number } }[] }} */ d) => `${d.filename}:${d.labels[0].span.line} ${d.message.split(':')[0]}`)
      .sort();
    return { marked, found };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the SYNC-ONLY fixture gives exactly its seven marked lines, and nothing outside the areas (phase 2, F6c)', () => {
  const { marked, found } = markedFixture('sync-only', 'sync', 'SYNC-ONLY');
  // async function, async arrow, async IIFE, await, for await, async method, an async read slice.
  assert.equal(marked.length, 7, 'the fixture marks seven spellings');
  // Silent: Promise.resolve(), a Promise type, the words in a comment or string, an async
  // service, a route and server/db/backup.ts.
  assert.deepEqual(found, marked);
});

test('the DB-SINGLETON fixture gives exactly its four marked lines, and nothing in a route (phase 2, F6c)', () => {
  const { marked, found } = markedFixture('db-singleton', 'handle', 'DB-SINGLETON');
  assert.equal(marked.length, 4, 'the fixture marks db.get(), dbModule.get(), a chained db.get() and one in server/authorize/');
  // Silent: map.get(key), db.get(1), calendar.colors.get(), database.prepare(...).get(), a string, a route.
  assert.deepEqual(found, marked);
});

test('the TX-DRIVER fixture gives exactly its marked lines, withTx with options stays under the async rules (phase 2, F6d)', () => {
  const dir = tempDir('yuvomi-tx-driver-fixture-');
  try {
    cpSync(join(FIXTURE, 'tx-driver'), dir, { recursive: true });
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(portableConfig()));
    const file = 'server/routes/tx.js';
    const tags = { tx: 'TX-DRIVER', async: 'TX-ASYNC-FN', await: 'TX-AWAIT-INSIDE' };
    const marked = readFileSync(join(dir, file), 'utf8').split('\n').flatMap((line, i) => {
      const m = /\/\/ (tx|async|await)-\d+$/.exec(line);
      return m ? [`${file}:${i + 1} ${tags[/** @type {'tx' | 'async' | 'await'} */ (m[1])]}`] : [];
    }).sort();
    assert.equal(marked.filter((m) => m.endsWith('TX-DRIVER')).length, 4, 'the fixture marks four driver spellings');
    const r = spawnSync(process.execPath, [OXLINT, '--format', 'json', '.'], { cwd: dir, encoding: 'utf8' });
    const found = JSON.parse(r.stdout).diagnostics
      .filter((/** @type {{ code: string }} */ d) => d.code.includes('no-restricted-syntax'))
      .map((/** @type {{ filename: string, message: string, labels: { span: { line: number } }[] }} */ d) => `${d.filename}:${d.labels[0].span.line} ${d.message.split(':')[0]}`)
      .sort();
    // Silent: withTx(db, fn) with and without options, idb.transactions, transaction as a
    // name, in a string and a comment, and the driver call under test/.
    assert.deepEqual(found, marked);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TX-DRIVER is hard: a driver transaction in the server is red even with --init (phase 2, F6d)', () => {
  const dir = project('export function f(db) { return db.get().transaction(() => 1)(); }\n');
  try {
    const r = run(dir, '--init');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Hard rules[\s\S]*server\/x\.js\s+oxlint\/no-restricted-syntax\/TX-DRIVER\s+1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SYNC-ONLY is hard, DB-SINGLETON an ordinary baseline that only sinks (phase 2, F6c)', () => {
  const dir = project(NONE);
  try {
    mkdirSync(join(dir, 'server', 'db'));
    writeFileSync(join(dir, 'server', 'db', 'x.ts'), 'export async function f(): Promise<void> {}\n');
    const hard = run(dir, '--init');
    assert.equal(hard.code, 1, hard.out);
    assert.match(hard.out, /Hard rules have no baseline/);
    assert.match(hard.out, /server\/db\/x\.ts\s+oxlint\/no-restricted-syntax\/SYNC-ONLY\s+1/);
    assert.equal(existsSync(join(dir, 'lint-baseline.json')), false, 'a hard finding never enters a baseline');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const HANDLE = 'server/services/s.js\toxlint/no-restricted-syntax/DB-SINGLETON';
  const two = "import * as db from '../db.js';\nexport const f = () => [db.get(), db.get()];\n";
  const svc = project(NONE);
  try {
    mkdirSync(join(svc, 'server', 'services'));
    writeFileSync(join(svc, 'server', 'services', 's.js'), two);
    const init = run(svc, '--init');
    assert.equal(init.code, 0, init.out);
    assert.deepEqual(baselineOf(svc), { [HANDLE]: 2 }, 'no reason needed');
    writeFileSync(join(svc, 'server', 'services', 's.js'), two.replace('db.get()]', 'db.get(), db.get()]'));
    const more = run(svc);
    assert.equal(more.code, 1, more.out);
    assert.match(more.out, /server\/services\/s\.js\s+oxlint\/no-restricted-syntax\/DB-SINGLETON\s+2 -> 3/);
    writeFileSync(join(svc, 'server', 'services', 's.js'), two.replace(', db.get()]', ']'));
    assert.equal(run(svc, '--update').code, 0);
    assert.deepEqual(baselineOf(svc), { [HANDLE]: 1 });
  } finally { rmSync(svc, { recursive: true, force: true }); }
});

test('a TX-MANUAL key stands only with a reason, also for a template literal (phase 2, F6b)', () => {
  const MANUAL = 'server/x.js\toxlint/no-restricted-syntax/TX-MANUAL';
  const dir = project("export function f(db, n) { db.exec('BEGIN EXCLUSIVE'); db.exec(`SAVEPOINT ${n}`); }\n");
  try {
    const init = run(dir, '--init');
    assert.equal(init.code, 1, init.out);
    assert.match(init.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/TX-MANUAL\s+no reason/);
    assert.doesNotMatch(init.out, /Hard rules have no baseline/);
    assert.deepEqual(baselineOf(dir), { [MANUAL]: 2 });
    writeReasons(dir, { [MANUAL]: 'too short' });
    assert.equal(run(dir).code, 1, 'a reason under twenty characters');
    writeReasons(dir, { [MANUAL]: 'an exclusive lock on a file of its own; withTx() only issues BEGIN' });
    const ok = run(dir);
    assert.equal(ok.code, 0, ok.out);
    // A prepared BEGIN in the same file raises the count: red, and --update never takes it in.
    writeFileSync(join(dir, 'server', 'x.js'), "export function f(db, n) { db.exec('BEGIN EXCLUSIVE'); db.exec(`SAVEPOINT ${n}`); db.prepare('BEGIN').run(); }\n");
    const more = run(dir);
    assert.equal(more.code, 1, more.out);
    assert.match(more.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/TX-MANUAL\s+2 -> 3/);
    assert.equal(run(dir, '--update').code, 1);
    assert.deepEqual(baselineOf(dir), { [MANUAL]: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const ROW = 'server/x.js\toxlint/no-restricted-syntax/RIGHTS-ROW';
const ROW_FILTER = "export const f = (task, set) => { if (task.visibility === 'all') set(task); if (task.visibility !== 'private') set(task); };\n";

test('a RIGHTS-ROW key stands only with a reason, and only at its count', () => {
  const dir = project(ROW_FILTER);
  try {
    // (d) the baseline takes the key, but a key without a reason is red.
    const init = run(dir, '--init');
    assert.equal(init.code, 1, init.out);
    assert.match(init.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/RIGHTS-ROW\s+no reason/);
    assert.deepEqual(baselineOf(dir), { [ROW]: 2 });
    writeReasons(dir, { [ROW]: 'a write filter: only shared rows are moved, nothing is read' });
    const ok = run(dir);
    assert.equal(ok.code, 0, ok.out);
    // (f) a third comparison in the file with the key: 2 -> 3 is red, --update does not raise it.
    writeFileSync(join(dir, 'server', 'x.js'), `${ROW_FILTER}export const g = (row) => row?.visibility === 'family';\n`);
    const more = run(dir);
    assert.equal(more.code, 1, more.out);
    assert.match(more.out, /server\/x\.js\s+oxlint\/no-restricted-syntax\/RIGHTS-ROW\s+2 -> 3/);
    assert.equal(run(dir, '--update').code, 1);
    assert.deepEqual(baselineOf(dir), { [ROW]: 2 });
    // (e) a finding in a file without a key is red, and --update does not take it in.
    writeFileSync(join(dir, 'server', 'x.js'), ROW_FILTER);
    writeFileSync(join(dir, 'server', 'y.js'), "export const h = (visibility) => visibility === 'restricted';\n");
    const fresh = run(dir);
    assert.equal(fresh.code, 1, fresh.out);
    assert.match(fresh.out, /server\/y\.js\s+oxlint\/no-restricted-syntax\/RIGHTS-ROW\s+0 -> 1/);
    const update = run(dir, '--update');
    assert.equal(update.code, 1, update.out);
    assert.deepEqual(baselineOf(dir), { [ROW]: 2 }, '--update never takes in a new RIGHTS-ROW key');
    assert.deepEqual(reasonsOf(dir), { [ROW]: 'a write filter: only shared rows are moved, nothing is read' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('the real lint-baseline-reasons.json is sorted and explains every error-text, rights-sql, rights-row, sql-in-list and TX-MANUAL key', () => {
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
  const rightsSql = Object.keys(baseline).filter((key) => key.endsWith('\toxlint/no-restricted-syntax/RIGHTS-SQL'));
  assert.deepEqual(rightsSql.filter((key) => !(key in reasons)), [], 'rights-sql keys without a reason');
  const rightsRow = Object.keys(baseline).filter((key) => key.endsWith('\toxlint/no-restricted-syntax/RIGHTS-ROW'));
  assert.ok(rightsRow.length > 0, 'the baseline carries no rights-row key');
  assert.deepEqual(rightsRow.filter((key) => !(key in reasons)), [], 'rights-row keys without a reason');
  const sqlList = Object.keys(baseline).filter((key) => key.endsWith('\toxlint/no-restricted-syntax/SQL-IN-LIST'));
  assert.deepEqual(sqlList.filter((key) => !(key in reasons)), [], 'sql-in-list keys without a reason');
  const txManual = Object.keys(baseline).filter((key) => key.endsWith('\toxlint/no-restricted-syntax/TX-MANUAL'));
  assert.ok(txManual.length > 0, 'the baseline carries no TX-MANUAL key');
  assert.deepEqual(txManual.filter((key) => !(key in reasons)), [], 'TX-MANUAL keys without a reason');
  // F14: in the server only the implementation and the instance lock write transaction statements.
  assert.deepEqual(txManual.filter((key) => key.startsWith('server/')).map((key) => key.split('\t')[0]),
    ['server/db/tx.ts', 'server/utils/instance-lock.js']);
});
