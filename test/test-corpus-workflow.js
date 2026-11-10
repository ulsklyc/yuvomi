/**
 * Module: Test infrastructure - migration corpus workflow
 * Purpose: `.github/workflows/corpus.yml` puts `yuvomi-<version>-corpus.db` and
 *          its `.sha256` on a published release (phase 1b, section B). Besides
 *          release-assets.yml it is the only workflow with write access to
 *          releases, so this guard reads it as text and holds: dispatch only,
 *          the write right only on the job that uploads, no token next to npm
 *          or the tag's code, no checkout in the upload job, no `--clobber`,
 *          pins, timeouts, no expression inside a shell script, the public
 *          test key equal to the restore drill's, and the rule "one database
 *          per schema change" (schema compare, foundation release, `force`).
 * Ausführen: npm run test:corpus-workflow
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORPUS_TEST_KEY } from '../scripts/restore-drill.mjs';

const workflow = readFileSync(new URL('../.github/workflows/corpus.yml', import.meta.url), 'utf8');

/**
 * The text of job `name` (from `  name:` up to the next job or the end).
 * @param {string} name
 */
function jobBlock(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `the workflow needs a job "${name}"`);
  const jobsAt = lines.indexOf('jobs:');
  assert.ok(jobsAt !== -1 && start > jobsAt, `${name} sits under jobs:`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Steps of one job as `{ name, text }`, in file order.
 * @param {string} job
 * @returns {{ name: string, text: string }[]}
 */
function steps(job) {
  const lines = job.split('\n');
  const start = lines.findIndex((l) => l === '    steps:');
  assert.notEqual(start, -1, 'the job needs a steps: list');
  /** @type {{ name: string, text: string }[]} */
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith('      ') && !line.startsWith('#')) break;
    const head = line.match(/^ {6}- name: (.+)$/);
    const last = out.at(-1);
    if (head) out.push({ name: head[1], text: `${line}\n` });
    else if (/^ {6}- /.test(line)) assert.fail(`every step needs a name, got: ${line.trim()}`);
    else if (last) last.text += `${line}\n`;
  }
  return out;
}

/** @param {string} text */
const code = (text) => text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

const JOBS = ['locate', 'seed', 'publish'];
const locateJob = jobBlock('locate');
const seedJob = jobBlock('seed');
const publishJob = jobBlock('publish');
const allSteps = [locateJob, seedJob, publishJob].flatMap((job) => steps(job));

test('starts only by dispatch, with a required tag and an optional force', () => {
  const on = workflow.match(/^on:\n((?: {2}.*\n|\n)+?)(?=^\S)/m)?.[1] ?? '';
  assert.match(on, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(on, /^ {2}(?!workflow_dispatch:)\w+:/m, 'no other trigger: every run attaches files to a published release');
  assert.match(on, /^ {6}tag:\n(?: {8}.*\n)*? {8}required: true\n(?: {8}.*\n)*? {8}type: string$/m);
  assert.match(on, /^ {6}force:\n(?: {8}.*\n)*? {8}default: false\n(?: {8}.*\n)*? {8}type: boolean$/m);
});

test('the workflow grants nothing; only the upload job may write', () => {
  assert.match(workflow, /^permissions: \{\}$/m, 'top level grants nothing; each job names its own');
  /** @param {string} job */
  const perms = (job) => {
    const m = job.match(/^ {4}permissions:\n((?: {6}\S.*\n)+)/m);
    assert.ok(m, 'every job names its permissions');
    return m[1].trim().split('\n').map((l) => l.trim()).sort();
  };
  assert.deepEqual(perms(locateJob), ['contents: read']);
  assert.deepEqual(perms(seedJob), ['contents: read'], 'npm install scripts and the tag\'s code can only read');
  assert.deepEqual(perms(publishJob), ['contents: write'], 'gh release upload, nothing else');
  assert.equal((workflow.match(/: write$/gm) || []).length, 1, 'exactly one write right in the file');
});

test('no token next to project code: seed holds none, locate and publish run none', () => {
  assert.doesNotMatch(seedJob, /GH_TOKEN|github\.token|secrets\.|id-token/, 'no token in the seed job');
  assert.match(seedJob, /run: npm ci/);
  assert.match(seedJob, /ref: refs\/tags\/\$\{\{ env\.TAG \}\}\n {10}persist-credentials: false/,
    'checks out the tag and leaves no credentials in .git');
  for (const job of [locateJob, publishJob]) {
    assert.doesNotMatch(code(job), /\bnpm\b|\bnode\b|actions\/checkout@|actions\/setup-node@/, 'no project code next to a token');
  }
  for (const job of [locateJob, publishJob]) {
    const jobEnv = job.match(/^ {4}env:\n((?: {6}\S.*\n)+)/m)?.[1] ?? '';
    assert.doesNotMatch(jobEnv, /GH_TOKEN/, 'GH_TOKEN on the steps that call gh, never on the job');
    for (const step of steps(job)) {
      if (/\bgh (?:release|api)\b/.test(step.text)) {
        assert.match(step.text, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m, `step "${step.name}" calls gh and names its token`);
      } else {
        assert.doesNotMatch(step.text, /GH_TOKEN/, `step "${step.name}" needs no token`);
      }
    }
  }
});

test('runs from main and checks out the tag; the tag is checked before it is used', () => {
  const find = steps(locateJob)[0];
  assert.match(find.text, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/, 'the first step rejects a tag that is not vX.Y.Z');
  assert.match(find.text, /--json isDraft --jq \.isDraft\)" != "false"/, 'only a published release');
  assert.match(seedJob, /^ {4}needs: locate$/m);
  assert.match(publishJob, /^ {4}needs: \[locate, seed\]$/m);
  assert.doesNotMatch(workflow, /refs\/tags\/\$TAG.*GITHUB_REF|GITHUB_REF.*refs\/tags/,
    'no "run at the tag" check: tags older than this file do not contain it');
});

test('one database per schema change: compare, foundation, force', () => {
  assert.match(seedJob, /^ {4}if: needs\.locate\.outputs\.exists != 'true'$/m, 'a release that has its database is left alone');
  const decide = steps(seedJob).find((s) => /^ {8}id: decide$/m.test(s.text));
  assert.ok(decide, 'a step decides whether to upload');
  assert.match(decide.text, /SELECT MAX\(version\) AS v FROM schema_migrations/);
  assert.match(decide.text, /grep -qx '### Foundation'/, 'a foundation release always gets one');
  assert.match(decide.text, /\[ "\$FORCE" = "true" \] \|\| \[ "\$FOUNDATION" = "true" \] \|\| \[ "\$PREVIOUS_SCHEMA" != "\$SCHEMA" \]/);
  const download = decide.text.indexOf('curl -fsSL --retry 3 -o "$RUNNER_TEMP/previous/previous.db"');
  const compare = decide.text.indexOf('if [ "$EXPECTED" != "$ACTUAL" ]');
  const read = decide.text.indexOf('PREVIOUS_SCHEMA="$(schema_of');
  assert.ok(download !== -1 && compare > download && read > compare, 'the earlier database is checked against its .sha256 before it is read');
  assert.match(publishJob, /^ {4}if: needs\.seed\.outputs\.upload == 'true'$/m);
});

test('the seed job seeds and backs up with the tag\'s own code and the public test key', () => {
  const env = seedJob.match(/^ {6}CORPUS_KEY: (.+)$/m);
  assert.ok(env, 'the key sits in the job env as a literal');
  assert.equal(env[1], CORPUS_TEST_KEY, 'corpus.yml and scripts/restore-drill.mjs use the same public key');
  const run = steps(seedJob).find((s) => /backupToFile/.test(s.text));
  assert.ok(run);
  const seed = run.text.indexOf('node scripts/seed-demo.js --db "$DB_PATH"');
  const backup = run.text.indexOf('DB_ENCRYPTION_KEY="$CORPUS_KEY"');
  assert.ok(seed !== -1 && backup > seed, 'seed without a key, then the backup with it');
  assert.match(run.text, /OUT="yuvomi-\$VERSION-corpus\.db"/);
  assert.match(run.text, /"SQLite format 3"/, 'refuses a plain backup');
  assert.match(run.text, /sha256sum "\$OUT" > "\$OUT\.sha256"/, 'the drill reads <file>.sha256 in sha256sum format');
});

test('publish checks the hash, uploads only what is missing and never replaces', () => {
  const ps = steps(publishJob);
  const down = ps.findIndex((s) => /uses: actions\/download-artifact@[0-9a-f]{40} # v/.test(s.text));
  const check = ps.findIndex((s) => /sha256sum -c "yuvomi-\$VERSION-corpus\.db\.sha256"/.test(s.text));
  const upload = ps.findIndex((s) => /gh release upload "\$TAG" "\$NAME"/.test(s.text));
  assert.ok(down !== -1 && check > down && upload > check, 'download, check, upload');
  assert.doesNotMatch(code(workflow), /--clobber/, 'a corpus database is frozen once it is on a release');
  assert.doesNotMatch(code(workflow), /gh release (?:create|edit|delete)/, 'the release itself is never changed');
  assert.match(ps[upload].text, /grep -qxF "\$NAME"[\s\S]*gh release upload "\$TAG" "\$NAME"/, 'a present file is kept');
});

test('every job has a runtime cap and every action a pinned SHA', () => {
  for (const name of JOBS) assert.match(jobBlock(name), /^ {4}timeout-minutes: \d+$/m, name);
  const uses = workflow.split('\n').filter((l) => /^\s*(?:- )?uses:/.test(l));
  assert.ok(uses.length >= 4, 'checkout, setup-node, upload and download at least');
  for (const line of uses) assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line.trim());
});

test('no step interpolates an expression into a shell script', () => {
  for (const step of allSteps) {
    const run = step.text.split(/^ {8}run: \|\n/m)[1];
    if (run !== undefined) assert.doesNotMatch(run, /\$\{\{/, `step "${step.name}"`);
  }
});
