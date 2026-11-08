/**
 * Module: Release cadence guard (scripts/check-release-cadence.mjs)
 * Purpose: The guard decides before the tag whether a release fits its track:
 *          interface files ship on Wednesdays and Sundays only, everything else
 *          at most once a day. It has two escape hatches with a mandatory
 *          reason, `--hotfix "<reason>"` and `--foundation "<phase>"` (phase 1a,
 *          decision E13). This suite runs the real script against a throwaway
 *          git repository and uses its test seams `--day` and `--since`, so
 *          every branch is seen red and green without depending on today's
 *          date or on this repository's tags.
 * Ausführen: npm run test:release-cadence
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-release-cadence.mjs', import.meta.url));
const OLD_DATE = '2026-01-07T12:00:00+0100';

// Git must see only the fixture: a hook or a parent process can export these.
const env = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
  delete env[key];
}

const repo = mkdtempSync(join(tmpdir(), 'yuvomi-cadence-'));
test.after(() => rmSync(repo, { recursive: true, force: true }));

function git(args, extraEnv = {}) {
  return execFileSync('git', [
    '-c', 'user.name=Cadence Test', '-c', 'user.email=cadence@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    ...args,
  ], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' }).trim();
}

function commitFile(path, content, message) {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(['add', path]);
  // A fixed past date: a lightweight tag takes the commit date as its
  // creator date, and the guard reads "tags created today" from it.
  git(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: OLD_DATE, GIT_COMMITTER_DATE: OLD_DATE });
}

// base (v0.0.1) -> interface file (tag `ui`) -> server file; plus an annotated
// tag created NOW, so the "one release per day" rule of track 2 has a release
// today to count.
git(['init', '-q', '-b', 'main']);
commitFile('README.md', 'fixture\n', 'base');
git(['tag', 'v0.0.1']);
commitFile('public/pages/calendar.js', 'export const page = 1;\n', 'interface change');
git(['tag', 'ui']);
commitFile('server/routes/x.js', 'export const route = 1;\n', 'server change');
git(['tag', '-a', 'v0.0.9', '-m', 'released today', 'v0.0.1']);

function cadence(...args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, env, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

// ISO weekdays: 3 = Wednesday (train), 4 = Thursday (no train).
const INTERFACE = ['--since', 'v0.0.1'];
const SERVER_ONLY = ['--since', 'ui'];

test('normal case: an interface file on a non-train day is refused', () => {
  const r = cadence(...INTERFACE, '--day', '4');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Release-Kadenz: ABGELEHNT/);
  assert.match(r.out, /public\/pages\/calendar\.js/, 'the refusal names the interface file');
});

test('control: the same diff passes on a train day', () => {
  const r = cadence(...INTERFACE, '--day', '3');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Oberflaechen-Zug, 1 Oberflaechen-Datei/);
});

test('track 2: a second release on the same day is refused', () => {
  const r = cadence(...SERVER_ONLY, '--day', '4');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Heute wurde bereits released: v0\.0\.9/);
});

test('--hotfix without a reason is refused', () => {
  for (const reason of [[], [''], ['too short']]) {
    const r = cadence(...INTERFACE, '--day', '4', '--hotfix', ...reason);
    assert.equal(r.code, 1, `--hotfix ${JSON.stringify(reason)}: ${r.out}`);
    assert.match(r.out, /--hotfix braucht einen Grund/);
  }
});

test('--hotfix with a reason lets any day through and prints it', () => {
  const r = cadence(...INTERFACE, '--day', '4', '--hotfix', 'session fixation in the login form');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /HOTFIX-AUSNAHME - session fixation in the login form/);
});

test('--foundation without a phase is refused', () => {
  // A missing value, an empty one, and the next flag taken as the value.
  for (const phase of [[], [''], ['  '], ['--day']]) {
    const r = cadence(...INTERFACE, '--foundation', ...phase, '--day', '4');
    assert.equal(r.code, 1, `--foundation ${JSON.stringify(phase)}: ${r.out}`);
    assert.match(r.out, /--foundation braucht die Phase/);
  }
});

test('--foundation with a phase lets any day through and prints the phase', () => {
  const onThursday = cadence(...INTERFACE, '--day', '4', '--foundation', '1a toolchain');
  assert.equal(onThursday.code, 0, onThursday.out);
  assert.match(onThursday.out, /Release-Kadenz: Fundament-Release 1a toolchain/);
  // Also past the once-a-day rule of track 2.
  const secondToday = cadence(...SERVER_ONLY, '--day', '4', '--foundation', '1a toolchain');
  assert.equal(secondToday.code, 0, secondToday.out);
  assert.match(secondToday.out, /Fundament-Release 1a toolchain/);
});

test('--hotfix and --foundation together are refused', () => {
  const r = cadence(...INTERFACE, '--day', '4', '--hotfix', 'session fixation in the login form',
    '--foundation', '1a toolchain');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /schliessen sich aus/);
});
