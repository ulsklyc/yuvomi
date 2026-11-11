/**
 * Module: test infrastructure - text reader inventory (Phase 1b, section C)
 * Purpose: A suite that reads app source as text and checks how it is spelled breaks
 *          when the file is rebuilt, although nothing changes for a user. The inventory
 *          test/text-reader-inventory.json names every such suite with class, number of
 *          spelling blocks, the files it reads and its fate. This guard keeps it
 *          complete and sinking: a new text reader without an entry is red, an entry
 *          without a suite is red, spelling blocks and suites that carry them never
 *          rise, every target exists. The detector (scripts/test-inventory.mjs) is
 *          checked against the forms it must see and the forms it must not count.
 * Run: node --test test/test-text-reader-inventory.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmp-dir.js';
import {
  INVENTORY_FILE, analyzeSuite, entryLine, formatInventory, phases, readInventory, readTrace, readersOf, scan, sums, traceGaps, verify,
} from '../scripts/test-inventory.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'test-inventory.mjs');
const PRELOAD = pathToFileURL(join(REPO, 'scripts', 'trace-test-reads.mjs')).href;

/* ---------- the detector, against a small tree of its own ---------- */

const HEAD = "import { readFileSync, readdirSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n";
const ROOT_CONST = "const ROOT = fileURLToPath(new URL('..', import.meta.url));\n";

/** @param {Record<string, string>} [suites] a tree with app files, two helpers and the given suites */
function tree(suites = {}) {
  const root = tempDir('yuvomi-text-readers-');
  /** @type {Record<string, string>} */
  const files = {
    'public/pages/a.js': 'export const a = 1;\n',
    'public/pages/b.js': 'export const b = 2;\n',
    'public/styles/a.css': '.a { color: red; }\n',
    'public/locales/de.json': '{}\n',
    'public/index.html': '<!doctype html>\n',
    'server/x.js': 'export const x = 1;\n',
    'server/routes/y.js': 'export const y = 1;\n',
    'docs/readme.md': '# docs\n',
    // A helper that reads on its own, and one that only works on what it is given.
    'test/css-rules.js': "import { readFileSync } from 'node:fs';\nexport function* eachRule(css) { yield css; }\n"
      + "export function globalHiddenRule() {\n  return readFileSync(new URL('../public/styles/a.css', import.meta.url), 'utf8');\n}\n",
    'test/source-text.js': 'export function withoutCommentsKeepingLines(src) { return src; }\n',
    // A helper that reads while it loads: a constant taken from the source.
    'test/harness.js': "import { readFileSync } from 'node:fs';\n"
      + "const DELAY = (() => Number(/b = (\\d+)/.exec(readFileSync(new URL('../public/pages/b.js', import.meta.url), 'utf8'))?.[1]))();\n"
      + 'export function wait() { return DELAY; }\n',
  };
  for (const [name, src] of Object.entries(suites)) files[`test/${name}`] = src;
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

/**
 * Measures one suite source inside a fresh tree.
 * @param {string} src
 */
function measure(src) {
  const root = tree({ 'test-probe.js': src });
  try {
    const found = scan(root)['test-probe.js'];
    assert.ok(found, 'the probe suite was not scanned');
    return found;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a literal path under public/ or server/ is a read of source text', () => {
  const found = measure(`${HEAD}const src = readFileSync(new URL('../public/pages/a.js', import.meta.url), 'utf8');\n`);
  assert.equal(found.narrow, true);
  assert.deepEqual(found.targets, ['public/pages/a.js']);
});

test('a path constant is resolved: join(ROOT, "public", "pages") plus a file name', () => {
  const found = measure(`${HEAD}${ROOT_CONST}const PAGES = join(ROOT, 'public', 'pages');\nconst src = readFileSync(join(PAGES, 'b.js'), 'utf8');\n`);
  assert.equal(found.narrow, true);
  assert.deepEqual(found.targets, ['public/pages/b.js']);
});

test('a local wrapper reads what its call sites name', () => {
  const wrapper = `${HEAD}${ROOT_CONST}const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');\n`;
  const app = measure(`${wrapper}const src = read('server/x.js');\n`);
  assert.equal(app.narrow, true);
  assert.deepEqual(app.targets, ['server/x.js']);
  // The same wrapper on a file outside public/ and server/ is no text reader.
  const docs = measure(`${wrapper}const doc = read('docs/readme.md');\n`);
  assert.equal(docs.narrow, false);
});

test('a walker with a default directory reads that directory', () => {
  const found = measure(`${HEAD}${ROOT_CONST}function files(dir = join(ROOT, 'server')) {\n  return readdirSync(dir).map((name) => join(dir, name));\n}\nconst all = files();\n`);
  assert.equal(found.narrow, true);
  assert.deepEqual(found.targets, ['server/']);
});

test('a loop variable and a callback parameter carry their list', () => {
  const loop = measure(`${HEAD}for (const f of ['server/x.js']) readFileSync(new URL(\`../\${f}\`, import.meta.url), 'utf8');\n`);
  assert.deepEqual(loop.targets, ['server/x.js']);
  const callback = measure(`${HEAD}const FILES = ['public/pages/a.js', 'server/routes/y.js'];\nconst all = FILES.map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8'));\n`);
  assert.deepEqual(callback.targets, ['public/pages/a.js', 'server/routes/y.js']);
});

test('a list of names behind one directory is read name by name', () => {
  const found = measure(`${HEAD}const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));\nfor (const page of ['index.html', 'pages/a.js', 'pages/b.js']) readFileSync(PUBLIC + page, 'utf8');\n`);
  assert.deepEqual(found.targets, ['public/index.html', 'public/pages/a.js', 'public/pages/b.js']);
});

test('a helper that reads while it loads reads for every suite that imports it', () => {
  const named = measure("import { wait } from './harness.js';\nconst ms = wait();\n");
  assert.equal(named.narrow, true);
  assert.deepEqual(named.targets, ['public/pages/b.js']);
  const bare = measure("import './harness.js';\n");
  assert.deepEqual(bare.targets, ['public/pages/b.js'], 'the import alone runs the read');
});

test('an aliased read function is still a read', () => {
  const found = measure("const { readFileSync: read } = await import('node:fs');\nconst src = read(new URL('../public/pages/a.js', import.meta.url), 'utf8');\n");
  assert.equal(found.narrow, true);
});

test('a method that is merely called readFile is no read, a spread and a dynamic node:fs import are', () => {
  const foreign = measure("const storage = await import('../server/x.js');\nconst file = await storage.readFile('id');\n");
  assert.equal(foreign.narrow, false, 'neither the method nor the import specifier makes a text reader');
  assert.equal(foreign.wide, false);
  const key = measure("import { storage } from './storage.js';\nconst file = await storage.readFile('server/x.js');\n");
  assert.equal(key.narrow, false, 'a storage key that looks like a path is no read of that file');
  const spread = measure(`${HEAD}const names = [...readdirSync(new URL('../server/routes/', import.meta.url))];\n`);
  assert.deepEqual(spread.targets, ['server/routes/']);
  const dynamic = measure("const src = (await import('node:fs')).readFileSync(new URL('../public/pages/a.js', import.meta.url), 'utf8');\n");
  assert.deepEqual(dynamic.targets, ['public/pages/a.js']);
  const promises = measure("import fs from 'node:fs';\nconst src = await fs.promises.readFile(new URL('../server/x.js', import.meta.url), 'utf8');\n");
  assert.deepEqual(promises.targets, ['server/x.js']);
});

test('a read helper from test/ counts where it is called, a text helper only with a read', () => {
  const reads = measure("import { globalHiddenRule } from './css-rules.js';\nconst rule = globalHiddenRule();\n");
  assert.equal(reads.narrow, true);
  assert.deepEqual(reads.targets, ['public/styles/a.css']);
  // eachRule() on a string of the test itself touches no file.
  // The same helper through a dynamic import: destructured, renamed, called on the import
  // itself, and under the other spelling of the way to it.
  const destructured = measure("const { globalHiddenRule } = await import('./css-rules.js');\nconst rule = globalHiddenRule();\n");
  assert.deepEqual(destructured.targets, ['public/styles/a.css']);
  const renamed = measure("const { eachRule, globalHiddenRule: hidden } = await import('./css-rules.js');\nconst rule = hidden();\n");
  assert.deepEqual(renamed.targets, ['public/styles/a.css']);
  const member = measure("const rule = (await import('../test/css-rules.js')).globalHiddenRule();\n");
  assert.deepEqual(member.targets, ['public/styles/a.css']);
  const unused = measure("const { eachRule } = await import('./css-rules.js');\nconst rules = [...eachRule('.a { color: red }')];\n");
  assert.equal(unused.narrow, false, 'the import alone reads nothing, only the call does');
  const fixture = measure("import { eachRule } from './css-rules.js';\nconst rules = [...eachRule('.a { color: red }')];\n");
  assert.equal(fixture.narrow, false);
  assert.equal(fixture.wide, false);
  const stripped = measure(`${HEAD}import { withoutCommentsKeepingLines } from './source-text.js';\nconst src = withoutCommentsKeepingLines(readFileSync(new URL('../server/x.js', import.meta.url), 'utf8'));\n`);
  assert.deepEqual(stripped.targets, ['server/x.js']);
});

test('a comment is no read', () => {
  const found = measure(`${HEAD}// const src = readFileSync(new URL('../public/pages/a.js', import.meta.url), 'utf8');\n/**\n * readFileSync(join('server', 'x.js'))\n */\nconst doc = readFileSync(new URL('../docs/readme.md', import.meta.url), 'utf8');\n`);
  assert.equal(found.narrow, false);
  assert.equal(found.wide, false, 'a path in a comment does not reach the wide unit either');
});

test('locale JSON is no source text, but it shows in the wide unit', () => {
  const found = measure(`${HEAD}const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));\nconst all = readdirSync(new URL('../public/locales/', import.meta.url));\n`);
  assert.equal(found.narrow, false);
  assert.equal(found.wide, true);
});

test('a path inside a string or a regex is no read, an import specifier no path', () => {
  const quoted = measure(`${HEAD}const doc = readFileSync(new URL('../docs/readme.md', import.meta.url), 'utf8');\nconst hit = doc.includes("readFileSync('../public/pages/a.js')") || /readFileSync\\('..\\/server\\/x.js'\\)/.test(doc);\n`);
  assert.equal(quoted.narrow, false);
  assert.equal(quoted.wide, true, 'reads something and names a path under public/: decided by hand');
  // A call that is only text stays text, even where its argument is a real constant.
  const spelled = measure(`${HEAD}const PAGE = new URL('../public/pages/a.js', import.meta.url);\nconst wanted = ["readFileSync(PAGE)", \`readFileSync(PAGE, 'utf8')\`];\nconst doc = readFileSync(new URL('../docs/readme.md', import.meta.url), 'utf8');\n`);
  assert.equal(spelled.narrow, false);
  const imported = measure(`${HEAD}import { a } from '../public/pages/a.js';\nconst doc = readFileSync(new URL('../docs/readme.md', import.meta.url), 'utf8');\n`);
  assert.equal(imported.wide, false);
});

test('a file under the temp directory is no app file, whatever its folders are called', () => {
  const found = measure(`${HEAD}import { tempDir } from './tmp-dir.js';\nconst dir = tempDir('probe-');\nconst copy = readFileSync(join(dir, 'server', 'x.js'), 'utf8');\n`);
  assert.equal(found.narrow, false);
  // The same through a function of the suite: where it builds the path decides.
  const viaFn = measure(`${HEAD}import { tmpdir } from 'node:os';\nfunction fixture() {\n  return join(tmpdir(), 'probe');\n}\nconst dir = fixture();\nconst copy = readFileSync(join(dir, 'server', 'x.js'), 'utf8');\n`);
  assert.equal(viaFn.narrow, false);
});

test('a regex with slashes and quotes does not derail the lexer', () => {
  const found = measure(`${HEAD}const url = /https?:\\/\\/[^'"\`]+/;\nconst open = /\\/\\*/;\nconst src = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');\n`);
  assert.deepEqual(found.targets, ['public/index.html']);
});

test('blocks are counted, and only those that touch the text are marked', () => {
  const found = measure(`${HEAD}import test from 'node:test';\nconst src = readFileSync(new URL('../public/pages/a.js', import.meta.url), 'utf8');\nconst names = () => src.split('\\n');\n`
    + "test('spelling', () => {\n  if (!/export const a/.test(src)) throw new Error('gone');\n});\n"
    + "test('through a function', () => {\n  if (names().length === 0) throw new Error('empty');\n});\n"
    + "test('behaviour', () => {\n  const state = { src: 1 };\n  if (state.src !== 1) throw new Error('wrong');\n});\n"
    + "it('local name', () => {\n  const health = readFileSync(new URL('../public/styles/a.css', import.meta.url), 'utf8');\n  if (!health) throw new Error('empty');\n});\n"
    + "test('same word, other meaning', () => {\n  const modules = { health: 'write' };\n  if (!modules.health) throw new Error('wrong');\n});\n"
    + "test('same name, own value', () => {\n  const health = '.a { color: red }';\n  const rules = health.split('}');\n  if (rules.length === 0 || !health) throw new Error('empty');\n});\n");
  assert.equal(found.blocks, 6);
  assert.deepEqual(found.textBlocks.map(([from]) => from), [7, 10, 17],
    'the object keys `src:` and `health:` are no names, and a `health` of another block is another constant');
});

test('analyzeSuite() needs no tree for a suite without helpers', () => {
  const found = analyzeSuite(`${HEAD}const src = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');\n`, { root: REPO });
  assert.deepEqual(found.targets, ['server/db.js']);
});

/* ---------- the inventory rules, against a small tree ---------- */

const READER = `${HEAD}import test from 'node:test';\nconst src = readFileSync(new URL('../public/pages/a.js', import.meta.url), 'utf8');\ntest('one', () => { if (!src.includes('a')) throw new Error('gone'); });\ntest('two', () => {});\n`;
const LOCALE_ONLY = `${HEAD}const de = readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8');\n`;

/**
 * @param {string} root
 * @param {object} inventory
 */
function writeInventory(root, inventory) {
  writeFileSync(join(root, INVENTORY_FILE), typeof inventory === 'string' ? inventory : JSON.stringify(inventory));
}

/** @param {string} root */
const problemsOf = (root) => verify(readInventory(root), scan(root), root).problems;

/**
 * @param {string} root
 * @param {...string} args
 */
function run(root, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('an empty inventory names what is missing, as the lines to paste', () => {
  const root = tree({ 'test-reader.js': READER, 'test-locale.js': LOCALE_ONLY, 'test-plain.js': "import test from 'node:test';\ntest('x', () => {});\n" });
  try {
    writeInventory(root, {});
    const problems = problemsOf(root);
    assert.equal(problems.length, 2);
    assert.match(String(problems[0]), /1 suites read source text/);
    assert.ok(String(problems[0]).includes(entryLine('test-reader.js', ['public/pages/a.js'])), 'the entry line with the measured target');
    assert.match(String(problems[1]), /"test-locale\.js": "<what it reads instead>",/);
    assert.ok(!problems.join('\n').includes('test-plain.js'), 'a suite that reads nothing needs no line');
    const cli = run(root);
    assert.equal(cli.code, 1);
    assert.match(cli.out, /Text readers: 1 narrow, 2 wide, 1 wide only/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a complete inventory is green, and the pasted line alone is not', () => {
  const root = tree({ 'test-reader.js': READER, 'test-locale.js': LOCALE_ONLY });
  try {
    const entry = { class: 'M', sBlocks: 1, targets: ['public/pages/a.js'], fate: 'falls-with:public/pages/a.js' };
    writeInventory(root, { ceiling: { sBlocks: 1, suites: 1 }, suites: { 'test-reader.js': entry }, wideOnly: { 'test-locale.js': 'locale JSON' } });
    assert.deepEqual(problemsOf(root), []);
    assert.equal(run(root).code, 0);
    // The placeholder in the pasted line forces a decision.
    const pasted = JSON.parse(`{${entryLine('test-reader.js', ['public/pages/a.js']).replace(/,$/, '')}}`);
    writeInventory(root, { ceiling: { sBlocks: 0, suites: 0 }, suites: pasted, wideOnly: { 'test-locale.js': 'locale JSON' } });
    assert.match(problemsOf(root).join('\n'), /test-reader\.js: fate "stays:<executed\|contract\|coupling\|cascade>" is none of/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spelling blocks and suites that carry them only sink', () => {
  const root = tree({ 'test-reader.js': READER, 'test-second.js': READER });
  try {
    const entry = { class: 'M', sBlocks: 1, targets: ['public/pages/a.js'], fate: 'falls-with:public/pages/a.js' };
    const behaviour = { class: 'V', sBlocks: 0, targets: ['public/pages/a.js'], fate: 'stays:executed' };
    writeInventory(root, { ceiling: { sBlocks: 1, suites: 1 }, suites: { 'test-reader.js': entry, 'test-second.js': entry } });
    const risen = problemsOf(root).join('\n');
    assert.match(risen, /Spelling blocks rose: 2, ceiling 1/);
    assert.match(risen, /Suites with spelling blocks rose: 2, ceiling 1/);
    // A new suite that tests behaviour raises nothing.
    writeInventory(root, { ceiling: { sBlocks: 1, suites: 1 }, suites: { 'test-reader.js': entry, 'test-second.js': behaviour } });
    assert.deepEqual(problemsOf(root), []);
    // --update lowers the ceiling and never raises it.
    writeInventory(root, { ceiling: { sBlocks: 9, suites: 9 }, suites: { 'test-reader.js': entry, 'test-second.js': behaviour } });
    assert.match(run(root).out, /The ceiling can sink to \{"sBlocks":1,"suites":1\}/);
    assert.equal(run(root, '--update').code, 0);
    assert.deepEqual(readInventory(root).ceiling, { sBlocks: 1, suites: 1 });
    writeInventory(root, { ceiling: { sBlocks: 0, suites: 0 }, suites: { 'test-reader.js': entry, 'test-second.js': behaviour } });
    run(root, '--update');
    assert.deepEqual(readInventory(root).ceiling, { sBlocks: 0, suites: 0 }, '--update does not lift a ceiling that is too low');
    assert.equal(run(root).code, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an entry without its suite, a target without its file and a wrong shape are red', () => {
  const root = tree({ 'test-reader.js': READER });
  try {
    const entry = { class: 'M', sBlocks: 1, targets: ['public/pages/a.js'], fate: 'falls-with:public/pages/a.js' };
    const inventory = (/** @type {object} */ change) => writeInventory(root, {
      ceiling: { sBlocks: 9, suites: 9 }, suites: { 'test-reader.js': { ...entry, ...change } },
    });
    writeInventory(root, { ceiling: { sBlocks: 9, suites: 9 }, suites: { 'test-reader.js': entry, 'test-gone.js': entry } });
    assert.match(problemsOf(root).join('\n'), /test-gone\.js: listed, but test\/test-gone\.js does not exist/);
    run(root, '--update');
    assert.deepEqual(Object.keys(readInventory(root).suites), ['test-reader.js'], '--update drops the line of a deleted suite');
    inventory({ targets: ['public/pages/moved.js'] });
    assert.match(problemsOf(root).join('\n'), /target public\/pages\/moved\.js does not exist/);
    inventory({ targets: ['public/pages/b.js'], fate: 'falls-with:public/pages/b.js' });
    assert.match(problemsOf(root).join('\n'), /test-reader\.js: reads public\/pages\/a\.js, which its targets do not name/);
    inventory({ targets: ['public/pages/'] });
    assert.deepEqual(problemsOf(root), [], 'a directory target covers the files below it');
    inventory({ targets: ['public/locales/de.json'] });
    assert.match(problemsOf(root).join('\n'), /target public\/locales\/de\.json is not source text/);
    inventory({ targets: ['public/pages'] });
    assert.match(problemsOf(root).join('\n'), /a directory ends with "\/"/);
    inventory({ class: 'V' });
    assert.match(problemsOf(root).join('\n'), /class V with 1 spelling blocks/);
    inventory({ sBlocks: 3 });
    assert.match(problemsOf(root).join('\n'), /3 spelling blocks, but the suite has 2 blocks/);
    inventory({ fate: 'falls-with:public/pages/gone.js' });
    assert.match(problemsOf(root).join('\n'), /fate names public\/pages\/gone\.js, which does not exist/);
    inventory({ fate: 'later' });
    assert.match(problemsOf(root).join('\n'), /fate "later" is none of/);
    inventory({});
    assert.deepEqual(problemsOf(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an entry the run-time trace found survives --update, and only "trace" marks one', () => {
  const root = tree({ 'test-walker.js': "import { readdirSync } from 'node:fs';\nconst walk = (dir) => readdirSync(dir);\nwalk(process.cwd());\n" });
  try {
    const entry = { class: 'V', sBlocks: 0, targets: ['server/'], fate: 'stays:coupling' };
    writeInventory(root, { ceiling: { sBlocks: 0, suites: 0 }, suites: { 'test-walker.js': { ...entry, seenBy: 'trace' } } });
    assert.deepEqual(problemsOf(root), []);
    run(root, '--update');
    assert.deepEqual(Object.keys(readInventory(root).suites), ['test-walker.js'], 'the detector does not see the read, the entry stays');
    writeInventory(root, { ceiling: { sBlocks: 0, suites: 0 }, suites: { 'test-walker.js': entry } });
    run(root, '--update');
    assert.deepEqual(Object.keys(readInventory(root).suites), [], 'without the mark the line of a suite that reads nothing goes');
    writeInventory(root, { ceiling: { sBlocks: 0, suites: 0 }, suites: { 'test-walker.js': { ...entry, seenBy: 'hand' } } });
    assert.match(problemsOf(root).join('\n'), /seenBy is "hand", the only value is "trace"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a run-time trace is compared with the inventory: no entry, read not covered, covered', () => {
  /** @type {import('../scripts/test-inventory.mjs').Inventory} */
  const inv = {
    ceiling: { sBlocks: 0, suites: 0 },
    sections: {},
    suites: {
      'test-a.js': { class: 'V', sBlocks: 0, targets: ['server/index.js'], fate: 'stays:coupling' },
      'test-b.js': { class: 'V', sBlocks: 0, targets: ['public/'], fate: 'stays:executed' },
      'test-quiet.js': { class: 'V', sBlocks: 0, targets: ['public/sw.js'], fate: 'stays:executed' },
    },
    wideOnly: {},
  };
  const trace = [
    'test-a.js\tserver/index.js', 'test-a.js\tserver/routes/y.js', 'test-a.js\tserver/routes/',
    'test-b.js\tpublic/pages/a.js', 'test-b.js\tpublic/locales/de.json',
    'test-new.js\tpublic/router.js', 'test-locale.js\tpublic/locales/de.json', '',
  ].join('\n');
  assert.deepEqual(traceGaps(inv, trace), {
    traced: 3,
    unlisted: [{ suite: 'test-new.js', paths: ['public/router.js'] }],
    uncovered: [{ suite: 'test-a.js', paths: ['server/routes/', 'server/routes/y.js'] }],
    silent: ['test-quiet.js'],
  });
  inv.suites['test-a.js']?.targets.push('server/');
  assert.deepEqual(traceGaps(inv, trace).uncovered, [], 'a directory target covers what the walk read below it');
});

test('the preload records what test code reads, one file per process, and nothing the app reads', () => {
  const probe = "import { readFileSync, readdirSync } from 'node:fs';\nimport { readFile } from 'node:fs/promises';\n"
    + "import { appRead } from '../server/reader.js';\n"
    + "const at = (rel) => new URL(rel, import.meta.url);\n"
    + "readFileSync(at('../public/pages/a.js'), 'utf8');\nreadFileSync(at('../public/pages/a.js'), 'utf8');\n"
    + "readdirSync(at('../server/routes/'));\nawait readFile(at('../public/index.html'), 'utf8');\n"
    + "readFileSync(at('../public/locales/de.json'), 'utf8');\nreadFileSync(at('../docs/readme.md'), 'utf8');\n"
    + 'appRead();\n';
  // The app module reads a file of its own: that is no read by the suite.
  const root = realpathSync(tree({
    'test-probe.js': probe,
    '../server/reader.js': "import { readFileSync } from 'node:fs';\nexport const appRead = () => readFileSync(new URL('../public/pages/b.js', import.meta.url), 'utf8');\n",
    // Code under test/ that is no suite: a helper run on its own.
    'runner.js': "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('../public/pages/a.js', import.meta.url), 'utf8');\n",
  }));
  const out = join(root, 'trace');
  const node = (/** @type {string} */ file) => spawnSync(process.execPath, ['--import', PRELOAD, file], {
    cwd: root, encoding: 'utf8', env: { ...process.env, TEXT_READER_TRACE: out, TEXT_READER_TRACE_ROOT: root },
  });
  try {
    const first = node('test/test-probe.js');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(node('test/test-probe.js').status, 0);
    assert.equal(node('test/runner.js').status, 0, 'a process that runs no suite records nothing');
    const files = readdirSync(out);
    assert.equal(files.length, 2, `one file per suite process: ${files.join(', ')}`);
    assert.ok(files.every((name) => /^test-probe\.js\.\d+\.tsv$/.test(name)));
    const lines = readFileSync(join(out, String(files[0])), 'utf8').trim().split('\n').sort();
    assert.deepEqual(lines, [
      'test-probe.js\tpublic/index.html', 'test-probe.js\tpublic/locales/de.json',
      'test-probe.js\tpublic/pages/a.js', 'test-probe.js\tserver/routes/',
    ], 'each path once; no docs/, and not public/pages/b.js, which the app module read');
    // The directory is read as one trace; locale JSON drops out in the comparison.
    const gaps = traceGaps({ ceiling: { sBlocks: 0, suites: 0 }, sections: {}, suites: {}, wideOnly: {} }, readTrace(out));
    assert.deepEqual(gaps.unlisted, [{ suite: 'test-probe.js', paths: ['public/index.html', 'public/pages/a.js', 'server/routes/'] }]);
    assert.equal(readTrace(join(out, String(files[0]))).trim().split('\n').length, 4, 'a single file is read as it is');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--target and the phase table answer from the inventory', () => {
  /** @type {import('../scripts/test-inventory.mjs').Inventory} */
  const inv = {
    ceiling: { sBlocks: 9, suites: 3 },
    sections: { 'test-c.js': [
      { title: 'one', lines: [1, 9], blocks: 3, sBlocks: 2, fate: 'lint:no-inner-html' },
      { title: 'two', lines: [10, 20], blocks: 4, sBlocks: 1, fate: 'falls-with:public/styles/' },
    ] },
    suites: {
      'test-a.js': { class: 'S', sBlocks: 4, targets: ['server/routes/y.js'], fate: 'falls-with:server/routes/y.js' },
      'test-b.js': { class: 'V', sBlocks: 0, targets: ['public/pages/'], fate: 'stays:executed' },
      'test-c.js': { class: 'M', sBlocks: 3, targets: ['public/pages/a.js', 'public/styles/'], fate: 'falls-with:public/styles/' },
    },
    wideOnly: {},
  };
  assert.deepEqual(readersOf(inv, 'public/pages/a.js').map((e) => e.name), ['test-b.js', 'test-c.js'], 'a directory target covers its files');
  assert.deepEqual(readersOf(inv, 'server/routes/y.js').map((e) => e.name), ['test-a.js']);
  assert.deepEqual(readersOf(inv, 'server/x.js'), []);
  assert.deepEqual(phases(inv), {
    '1b': { suites: 0, sBlocks: 2 }, 2: { suites: 1, sBlocks: 4 }, 4: { suites: 1, sBlocks: 1 }, stays: { suites: 0, sBlocks: 0 },
  }, 'the blocks of a suite with sections are counted per section');
  assert.deepEqual(sums(inv), { sBlocks: 7, suites: 2 });
});

/* ---------- the real inventory ---------- */

test('the inventory is complete, sinking and names only files that exist', () => {
  const inv = readInventory(REPO);
  const { problems, diff } = verify(inv, scan(REPO), REPO);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
  // Reach before verdict: the detector has to see the readers at all.
  assert.ok(diff.narrow.length > 0 && Object.keys(inv.suites).length >= diff.narrow.length,
    'the detector found no text reader - from here on this test checks nothing');
  assert.ok(diff.narrow.includes('test-frontend-audit.js'), 'the largest text reader is not detected any more');
});

test('the inventory file is sorted, one line per suite', () => {
  const raw = readFileSync(join(REPO, INVENTORY_FILE), 'utf8');
  assert.equal(raw, formatInventory(readInventory(REPO)),
    `${INVENTORY_FILE} is not in its written form: keys sorted, one line per suite (node scripts/test-inventory.mjs --update writes it).`);
});
