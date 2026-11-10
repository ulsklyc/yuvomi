/**
 * Module: Test infrastructure - restore drill workflow
 * Purpose: `.github/workflows/restore-drill.yml` restores every corpus database
 *          of the releases through the real restore path (phase 1b section B,
 *          F10 and F11): every night, by hand, and called from ci.yml for every
 *          pull request. This guard reads it as text and holds: the three
 *          triggers, read rights only, the token only on the steps that call
 *          `gh` and no project code on them, the build before the server step,
 *          the list from scripts/corpus-assets.mjs, the drill running on what
 *          was downloaded even when the list step reports a gap, and the ci.yml
 *          job that calls it.
 * Ausführen: npm run test:restore-drill-workflow
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/restore-drill.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/**
 * The text of job `name` in `source` (from `  name:` up to the next job or the end).
 * @param {string} source
 * @param {string} name
 */
function jobBlock(source, name) {
  const lines = source.split('\n');
  const jobsAt = lines.indexOf('jobs:');
  const start = lines.indexOf(`  ${name}:`, jobsAt);
  assert.ok(jobsAt !== -1 && start > jobsAt, `a job "${name}" under jobs:`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]) && !/^\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Steps of one job as `{ name, text }`, in file order.
 * @param {string} job
 */
function steps(job) {
  const lines = job.split('\n');
  const start = lines.findIndex((l) => l === '    steps:');
  assert.notEqual(start, -1, 'the job needs a steps: list');
  /** @type {{ name: string, text: string }[]} */
  const out = [];
  for (const line of lines.slice(start + 1)) {
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

const drill = jobBlock(workflow, 'drill');
const drillSteps = steps(drill);
const stepAt = (/** @type {RegExp} */ re) => drillSteps.findIndex((s) => re.test(s.text));

test('runs every night, by hand and when ci.yml calls it', () => {
  const on = workflow.match(/^on:\n((?: {2}.*\n|\n)+?)(?=^\S)/m)?.[1] ?? '';
  assert.match(on, /^ {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \*'$/m, 'one run a night (UTC)');
  assert.match(on, /^ {2}workflow_dispatch:$/m);
  assert.match(on, /^ {2}workflow_call:$/m, 'ci.yml runs the same job for every pull request');
  assert.doesNotMatch(on, /pull_request_target|workflow_run|issue_comment/);
});

test('reads only: nothing grants write, the token sits on the gh steps alone', () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(drill, /^ {4}permissions:\n {6}contents: read\n(?! {6}\S)/m);
  assert.doesNotMatch(code(workflow), /: write$/m, 'no write right anywhere');
  assert.doesNotMatch(code(workflow), /secrets\.|id-token/);
  const jobEnv = drill.match(/^ {4}env:\n((?: {6}\S.*\n)+)/m)?.[1] ?? '';
  assert.doesNotMatch(jobEnv, /GH_TOKEN/, 'GH_TOKEN on the steps that call gh, never on the job');
  for (const step of drillSteps) {
    if (/\bgh (?:release|api)\b/.test(code(step.text))) {
      assert.match(step.text, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m, `step "${step.name}" names its token`);
      assert.doesNotMatch(code(step.text), /\bnode\b|\bnpm\b/, `step "${step.name}" runs no project code next to the token`);
    } else {
      assert.doesNotMatch(step.text, /GH_TOKEN/, `step "${step.name}" needs no token`);
    }
  }
  assert.match(drillSteps[0].text, /uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}persist-credentials: false/,
    'checkout first, no credentials left in .git');
});

test('builds, lists, downloads and drills in that order', () => {
  const ci_ = stepAt(/run: npm ci$/m);
  const build = stepAt(/run: npm run build$/m);
  const list = stepAt(/gh api "repos\/\$GH_REPO\/releases\?per_page=100" --paginate/);
  const choose = stepAt(/node scripts\/corpus-assets\.mjs "\$RUNNER_TEMP\/releases\.jsonl" --repo "\$GH_REPO" --out "\$RUNNER_TEMP\/corpus\.txt"/);
  const download = stepAt(/gh release download "\$TAG" --pattern "\$NAME" --dir "\$RUNNER_TEMP\/corpus"/);
  const run = stepAt(/node scripts\/restore-drill\.mjs "\$RUNNER_TEMP"\/corpus\/\*\.db/);
  assert.ok(ci_ !== -1 && build > ci_ && list > build && choose > list && download > choose && run > download,
    `npm ci, build (the server step needs dist/), list, choose, download, drill: ${[ci_, build, list, choose, download, run]}`);
  assert.match(drillSteps[list].text, /select\(\.draft \| not\)/, 'published releases only');
  assert.doesNotMatch(drillSteps[run].text, /--skip-server/, 'the drill starts the server on every database');
});

test('a gap is red, and the databases that are there are still drilled', () => {
  const choose = drillSteps[stepAt(/scripts\/corpus-assets\.mjs/)];
  assert.match(choose.text, /^ {8}id: choose$/m);
  assert.match(choose.text, /\|\| GAP=\$\?/, 'the exit code is kept, not swallowed');
  assert.match(choose.text, /echo "count=\$\(grep -c '\\\.db\$' "\$RUNNER_TEMP\/corpus\.txt" \|\| true\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(choose.text, /exit "\$\{GAP:-0\}"/, 'the step fails on a gap');
  for (const re of [/gh release download/, /restore-drill\.mjs/]) {
    assert.match(drillSteps[stepAt(re)].text, /^ {8}if: \$\{\{ !cancelled\(\) && steps\.choose\.outputs\.count > 0 \}\}$/m,
      'runs after a red list step, as long as something was listed');
  }
});

test('runtime cap, pinned actions, no expression inside a script', () => {
  assert.match(drill, /^ {4}timeout-minutes: \d+$/m);
  for (const line of workflow.split('\n').filter((l) => /^\s*(?:- )?uses:/.test(l))) {
    assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line.trim());
  }
  for (const step of drillSteps) {
    const script = step.text.split(/^ {8}run: \|\n/m)[1];
    if (script !== undefined) assert.doesNotMatch(script, /\$\{\{/, `step "${step.name}"`);
  }
});

test('ci.yml runs the same drill for every pull request, read-only, not as a required name', () => {
  const job = jobBlock(ci, 'restore-drill');
  assert.match(job, /^ {4}uses: \.\/\.github\/workflows\/restore-drill\.yml$/m);
  assert.match(job, /^ {4}permissions:\n {6}contents: read$/m);
  assert.doesNotMatch(job, /^ {4}name: (?:Tests|Typecheck) /m, 'not one of the three required check names');
});
