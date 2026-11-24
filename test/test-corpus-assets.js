/**
 * Module: Test infrastructure - choosing the corpus databases
 * Purpose: `scripts/corpus-assets.mjs` reads the release list (the manifest of
 *          the migration corpus, phase 1b section B, F10) and names the corpus
 *          databases the restore drill downloads. It holds:
 *          - a corpus database counts only with its `.sha256`; half a pair is red
 *            (corpus.yml repairs it on the next dispatch);
 *          - no corpus database at all is red;
 *          - the newest release must have one when its schema differs from the
 *            newest corpus database (the gap the drill reports);
 *          - the schema version of a tag is its highest migration, the same
 *            number the restored database reports: the highest `./NNNN.ts` in
 *            server/migrations/index.ts, and for older tags without that file
 *            the highest `version: N,` in server/db.js.
 * Ausführen: npm run test:corpus-assets
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-dir.js';
import { checkGap, compareTags, planCorpus, schemaFromDbSource, schemaFromMigrationIndex, schemaOfTree } from '../scripts/corpus-assets.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/corpus-assets.mjs', import.meta.url));

/** @param {string} tag @param {string[]} [extra] */
const pair = (tag, extra = []) => ({
  tag,
  assets: [`yuvomi-${tag.slice(1)}-corpus.db`, `yuvomi-${tag.slice(1)}-corpus.db.sha256`, ...extra],
});

test('tags compare as versions, not as text', () => {
  assert.ok(compareTags('v2.10.0', 'v2.9.0') > 0);
  assert.ok(compareTags('v2.0.0', 'v10.0.0') < 0);
  assert.equal(compareTags('v2.88.0', 'v2.88.0'), 0);
});

// An old tag (server/db.js with the array) in the format every tag up to the
// move wrote; a new tag (server/migrations/index.ts) like this tree.
const OLD_DB_JS = 'const MIGRATIONS = [\n  {\n    version: 7,\n  },\n  {\n    version: 12,\n  },\n];';
const NEW_INDEX = "import m0001 from './0001.ts';\nimport m0002 from './0002.ts';\n\nexport const MIGRATIONS = [\n  m0001,\n  m0002,\n];\n";

test('the schema version of a tag in the old layout is the highest version in its server/db.js', () => {
  assert.equal(schemaFromDbSource(OLD_DB_JS), 12);
  assert.throws(() => schemaFromDbSource('export const x = 1;'), /no migration/);
});

test('the schema version of a tag in the new layout is the highest migration file its index.ts imports', () => {
  const head = readFileSync(new URL('../server/migrations/index.ts', import.meta.url), 'utf8');
  const files = readdirSync(new URL('../server/migrations/', import.meta.url)).filter((f) => /^\d{4}\.ts$/.test(f));
  assert.ok(files.length > 100, 'the migrations are one file each');
  assert.equal(schemaFromMigrationIndex(head), Math.max(...files.map((f) => Number(f.slice(0, 4)))));
  assert.equal(schemaFromMigrationIndex(NEW_INDEX), 2);
  assert.throws(() => schemaFromMigrationIndex("import x from './helpers.ts';\n"), /no migration/);
});

test('a tree is read in the layout it has: index.ts first, server/db.js only without it', async () => {
  /** @param {Record<string, string>} files */
  const tree = (files) => async (/** @type {string} */ path) => files[path] ?? null;
  assert.equal(await schemaOfTree(tree({ 'server/db.js': OLD_DB_JS })), 12);
  // A new tree still has a server/db.js, without migrations: index.ts decides.
  assert.equal(await schemaOfTree(tree({ 'server/migrations/index.ts': NEW_INDEX, 'server/db.js': 'export const x = 1;' })), 2);
  await assert.rejects(schemaOfTree(tree({})), /neither server\/migrations\/index\.ts nor server\/db\.js/);
});

test('the plan lists every complete pair, newest first, and nothing else', () => {
  const plan = planCorpus([
    pair('v2.0.0'),
    { tag: 'v2.88.1', assets: ['yuvomi-2.88.1-dist.tar.gz'] },
    pair('v2.87.0', ['yuvomi-2.87.0-dist.tar.gz']),
    pair('v2.10.0'),
    { tag: 'v2.9.0', assets: [] },
    { tag: 'nightly', assets: ['yuvomi-nightly-corpus.db'] },
  ]);
  assert.deepEqual(plan.corpus.map((c) => c.tag), ['v2.87.0', 'v2.10.0', 'v2.0.0']);
  assert.deepEqual(plan.corpus[0].files, ['yuvomi-2.87.0-corpus.db', 'yuvomi-2.87.0-corpus.db.sha256']);
  assert.equal(plan.newestRelease, 'v2.88.1', 'only vX.Y.Z tags count');
  assert.deepEqual(plan.incomplete, []);
});

test('half a pair is red with its tag, the other pairs stay in the plan', () => {
  const plan = planCorpus([
    pair('v2.87.0'),
    { tag: 'v2.88.0', assets: ['yuvomi-2.88.0-corpus.db'] },
    { tag: 'v2.78.0', assets: ['yuvomi-2.78.0-corpus.db.sha256'] },
  ]);
  assert.deepEqual(plan.corpus.map((c) => c.tag), ['v2.87.0']);
  assert.deepEqual(plan.incomplete, [
    'v2.88.0: yuvomi-2.88.0-corpus.db.sha256 missing',
    'v2.78.0: yuvomi-2.78.0-corpus.db missing',
  ]);
});

test('the gap rule: the newest release needs a database when its schema moved', async () => {
  /** @type {Record<string, number>} */
  const schemas = { 'v2.89.0': 283, 'v2.88.0': 282, 'v2.87.0': 282 };
  /** @param {string} tag */
  const schemaOf = async (tag) => {
    assert.ok(tag in schemas, `asked for ${tag}`);
    return schemas[tag];
  };
  // The newest release carries a database: nothing to fetch.
  assert.equal(await checkGap(planCorpus([pair('v2.88.0'), pair('v2.87.0')]), async () => assert.fail('no fetch needed')), null);
  // Same schema as the newest corpus database: no database needed.
  assert.equal(await checkGap(planCorpus([{ tag: 'v2.88.0', assets: [] }, pair('v2.87.0')]), schemaOf), null);
  // Schema moved: red, naming both versions.
  assert.equal(
    await checkGap(planCorpus([{ tag: 'v2.89.0', assets: [] }, pair('v2.87.0')]), schemaOf),
    'v2.89.0 has schema 283 but no corpus database; the newest corpus database is v2.87.0 at schema 282 (gh workflow run corpus.yml --ref main -f tag=v2.89.0)',
  );
  // No corpus database at all.
  assert.match(await checkGap(planCorpus([{ tag: 'v2.88.0', assets: [] }]), schemaOf) ?? '', /no corpus database on any release/);
  // Half a pair is red even when the rest is fine.
  assert.match(
    await checkGap(planCorpus([pair('v2.88.0'), { tag: 'v2.87.0', assets: ['yuvomi-2.87.0-corpus.db'] }]), schemaOf) ?? '',
    /v2\.87\.0: yuvomi-2\.87\.0-corpus\.db\.sha256 missing/,
  );
});

test('the CLI writes "<tag> <file>" lines and exits 0 when the newest release has its database', () => {
  const dir = tempDir('corpus-assets-');
  const releases = join(dir, 'releases.jsonl');
  const out = join(dir, 'corpus.txt');
  writeFileSync(releases, [pair('v2.88.0'), pair('v2.0.0'), { tag: 'v2.1.0', assets: [] }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [SCRIPT, releases, '--repo', 'example/repo', '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(out, 'utf8'), [
    'v2.88.0 yuvomi-2.88.0-corpus.db',
    'v2.88.0 yuvomi-2.88.0-corpus.db.sha256',
    'v2.0.0 yuvomi-2.0.0-corpus.db',
    'v2.0.0 yuvomi-2.0.0-corpus.db.sha256',
    '',
  ].join('\n'));
  assert.match(run.stdout, /2 corpus databases: v2\.88\.0, v2\.0\.0/);
});

test('the CLI still writes the list when it exits 1, so the drill can run the rest', () => {
  const dir = tempDir('corpus-assets-');
  const releases = join(dir, 'releases.jsonl');
  const out = join(dir, 'corpus.txt');
  writeFileSync(releases, [{ tag: 'v2.88.0', assets: ['yuvomi-2.88.0-corpus.db'] }, pair('v2.87.0')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [SCRIPT, releases, '--repo', 'example/repo', '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /::error::half a corpus pair .*v2\.88\.0: yuvomi-2\.88\.0-corpus\.db\.sha256 missing/);
  assert.equal(readFileSync(out, 'utf8'), 'v2.87.0 yuvomi-2.87.0-corpus.db\nv2.87.0 yuvomi-2.87.0-corpus.db.sha256\n');
});
