/**
 * Module: Test infrastructure - Umbrel catalog workflow
 * Purpose: `.github/workflows/umbrel-publish.yml` runs code from a foreign
 *          repository at a moving branch (the catalog's linter, its npm
 *          dependencies) and holds a token that writes to more than the
 *          catalog fork. This guard reads the workflow as text and holds the
 *          separation: three jobs, the token only in `publish`, foreign code
 *          only in `lint`, which has no secret and no rights, and the checksum
 *          from `prepare` checked before the edited files are used.
 * Ausführen: npm run test:umbrel-publish-workflow
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/umbrel-publish.yml', import.meta.url), 'utf8');
const lines = workflow.split('\n');

/** @param {string} text */
const code = (text) => text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

/** Names of the jobs, in file order. */
function jobNames() {
  const jobsAt = lines.indexOf('jobs:');
  assert.notEqual(jobsAt, -1, 'the workflow needs jobs:');
  return lines.slice(jobsAt + 1).filter((l) => /^ {2}[a-z][a-z0-9_-]*:$/.test(l)).map((l) => l.trim().slice(0, -1));
}

/**
 * The text of job `name` without comments (from `  name:` up to the next job or the end).
 * @param {string} name
 */
function job(name) {
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `the workflow needs a job "${name}"`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end += 1;
  return code(lines.slice(start, end).join('\n'));
}

/**
 * Does the script text call one of the tools that run foreign code? Only in
 * command position: `npm test` inside a printf string is text, not a call.
 * @param {string} text
 */
function runsPackageCode(text) {
  return text.split('\n').some((l) => /(^|[;&|(]\s*|\b(if|then|else|do)\s+)(npm|npx|node|yarn|pnpm)\s/.test(l.trim()));
}

test('no right at the top, and the two triggers with a dry run', () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));
  assert.match(on, /release:\n\s+types: \[published\]/);
  assert.match(on, /workflow_dispatch:/);
  assert.match(on, /\n {6}version:/);
  assert.match(on, /\n {6}dry_run:\n(?: {8}.*\n)*? {8}type: boolean\n(?: {8}.*\n)*? {8}default: false/);
});

test('three jobs: prepare, lint, publish', () => {
  assert.deepEqual(jobNames(), ['prepare', 'lint', 'publish']);
  for (const name of jobNames()) {
    assert.match(job(name), /\n {4}timeout-minutes: \d+\n/, `${name} needs a timeout`);
  }
});

test('the fork token is named in the job publish and nowhere else', () => {
  assert.match(job('publish'), /secrets\.UMBREL_FORK_TOKEN/);
  for (const name of ['prepare', 'lint']) {
    assert.doesNotMatch(job(name), /UMBREL_FORK_TOKEN/, `${name} must not see the fork token`);
  }
});

test('publish holds the token and runs no package code, nothing from the catalog and no checkout', () => {
  const publish = job('publish');
  assert.match(publish, /\n {4}permissions: \{\}\n/);
  assert.match(publish, /\n {4}needs: \[prepare, lint\]\n/);
  assert.match(publish, /\n {4}if: needs\.prepare\.outputs\.proceed == 'true' && github\.event\.inputs\.dry_run != 'true'\n/);
  assert.equal(runsPackageCode(publish), false, 'no npm, npx or node call next to the token');
  assert.doesNotMatch(publish, /actions\/checkout@/);
});

test('publish checks the files against the checksum from prepare before the token is used', () => {
  const publish = job('publish');
  assert.match(publish, /BUNDLE_SHA256: \$\{\{ needs\.prepare\.outputs\.bundle_sha256 \}\}/);
  assert.match(publish, /BASE_SHA: \$\{\{ needs\.prepare\.outputs\.base_sha \}\}/);
  const check = publish.indexOf('echo "$BUNDLE_SHA256  umbrel-update.tar.gz" | sha256sum -c -');
  assert.notEqual(check, -1, 'the checksum is checked');
  for (const use of ['gh api user', 'gh repo fork', 'git clone', 'tar -xzf', 'git push']) {
    const at = publish.indexOf(use);
    assert.notEqual(at, -1, `publish still does: ${use}`);
    assert.ok(check < at, `the checksum comes before: ${use}`);
  }
  // The files land on the commit prepare named, and only these two.
  assert.match(publish, /git fetch --depth 1 upstream "\$BASE_SHA"\n\s+git checkout -B "\$BRANCH" FETCH_HEAD/);
  assert.match(publish, /tar -xzf "\$BUNDLE" yuvomi\/umbrel-app\.yml yuvomi\/docker-compose\.yml\n/);
  assert.match(publish, /git status --porcelain \| grep -vE/);
});

test('lint runs the foreign code with no secret, no rights and no install scripts', () => {
  const lint = job('lint');
  assert.match(lint, /\n {4}permissions: \{\}\n/);
  assert.match(lint, /\n {4}needs: prepare\n/);
  assert.doesNotMatch(lint, /secrets\./);
  assert.doesNotMatch(lint, /github\.token|GH_TOKEN|GITHUB_TOKEN/);
  assert.doesNotMatch(lint, /actions\/checkout@/);
  assert.match(lint, /npm ci --ignore-scripts /);
  assert.doesNotMatch(lint, /npm (install|i) /);
  const check = lint.indexOf('echo "$BUNDLE_SHA256  umbrel-update.tar.gz" | sha256sum -c -');
  assert.notEqual(check, -1, 'the checksum is checked');
  for (const use of ['tar -xzf', 'npm ci', 'node .tools/lint-apps.mjs']) {
    assert.ok(check < lint.indexOf(use), `the checksum comes before: ${use}`);
  }
  assert.match(lint, /git fetch -q --depth 1 origin "\$BASE_SHA"/);
});

test('prepare edits as text: no package code, no token left in the checkout, the checksum as an output', () => {
  const prepare = job('prepare');
  assert.match(prepare, /\n {4}permissions:\n {6}contents: read\n/);
  assert.equal(runsPackageCode(prepare), false, 'prepare runs no npm, npx or node');
  assert.match(prepare, /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n {8}with:\n {10}persist-credentials: false/);
  assert.match(prepare, /git clone --depth 1 --branch master "https:\/\/github\.com\/\$UPSTREAM\.git" catalog/);
  assert.match(prepare, /\n {6}base_sha: \$\{\{ steps\.edit\.outputs\.base_sha \}\}\n/);
  assert.match(prepare, /\n {6}bundle_sha256: \$\{\{ steps\.edit\.outputs\.bundle_sha256 \}\}\n/);
  assert.match(prepare, /tar -czf "\$BUNDLE" yuvomi\/umbrel-app\.yml yuvomi\/docker-compose\.yml\n/);
});

test('no expression is expanded inside a shell script', () => {
  let scriptIndent = -1;
  lines.forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    if (scriptIndent >= 0 && line.trim() !== '' && indent <= scriptIndent) scriptIndent = -1;
    if (scriptIndent >= 0) {
      assert.ok(!line.includes('${{'), `line ${i + 1} expands an expression inside a run script`);
    } else if (/^\s*run: \|/.test(line)) {
      scriptIndent = indent;
    }
  });
});
