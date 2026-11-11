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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-dir.js';
import {
  INVENTORY_FILE, analyzeSuite, entryLine, formatInventory, phases, readInventory, readersOf, scan, sums, verify,
} from '../scripts/test-inventory.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'test-inventory.mjs');

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
