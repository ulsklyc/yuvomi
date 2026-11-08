/**
 * Module: Test infrastructure - release asset workflow
 * Purpose: `.github/workflows/release-assets.yml` is the only workflow that may
 *          write to releases. It builds `yuvomi-<version>-dist.tar.gz` and
 *          `SHA256SUMS`, attests both, uploads them and only then takes the
 *          release out of draft. YunoHost and Proxmox install from that asset;
 *          Proxmox `prebuild` silently falls back to the previous release when
 *          the asset is missing. So the order is the promise: a published
 *          release always carries its asset. This guard reads the workflow as
 *          text and holds trigger, permissions, pins, the attestation subjects,
 *          the publish-last order and the closing check. It starts by
 *          dispatch only: GitHub runs no workflow for a draft's `created`.
 * Ausführen: npm run test:release-assets-workflow
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/release-assets.yml', import.meta.url),
  'utf8',
);
const umbrel = readFileSync(
  new URL('../.github/workflows/umbrel-publish.yml', import.meta.url),
  'utf8',
);

/** Top-level block `key:` up to the next top-level key, without comment lines. */
function topLevelBlock(source, key) {
  const lines = source.split('\n');
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `the workflow needs a top-level "${key}:" block`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(' ') && !line.startsWith('#')) break;
    if (line.trim() && !line.trimStart().startsWith('#')) body.push(line);
  }
  return body;
}

/** Steps of the (single) job as `{ name, text }`, in file order. */
function steps(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l === '    steps:');
  assert.notEqual(start, -1, 'the job needs a steps: list');
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith('      ') && !line.startsWith('#')) break;
    const head = line.match(/^ {6}- name: (.+)$/);
    if (head) out.push({ name: head[1], text: `${line}\n` });
    else if (/^ {6}- /.test(line)) assert.fail(`every step needs a name, got: ${line.trim()}`);
    else if (out.length) out.at(-1).text += `${line}\n`;
  }
  return out;
}

const allSteps = steps(workflow);
const indexOf = (pattern) => allSteps.findIndex((s) => pattern.test(s.text));

test('starts only by dispatch with a tag, never on a release event', () => {
  // GitHub fires no `created`/`edited`/`deleted` run for a DRAFT release, and
  // `published` comes after the release is public. A release trigger would
  // therefore only ever run once the window without asset is already open.
  // release-prep dispatches the workflow right after creating the draft.
  const on = topLevelBlock(workflow, 'on');
  assert.deepEqual(
    on.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim()),
    ['workflow_dispatch:'],
    'workflow_dispatch is the only trigger',
  );
  const block = on.join('\n');
  assert.match(block, /^ {4}inputs:\n {6}tag:\n/m, 'the dispatch takes the tag');
  assert.match(block, /^ {8}required: true$/m, 'the dispatch tag is required');
  assert.match(workflow, /^ {6}TAG: \$\{\{ inputs\.tag \}\}$/m, 'TAG comes from the input alone');
});

test('asks for exactly the permissions it uses, at workflow level only', () => {
  const perms = topLevelBlock(workflow, 'permissions')
    .map((l) => l.trim())
    .sort();
  assert.deepEqual(perms, [
    // dispatch umbrel-publish.yml: the release this job publishes fires no event
    'actions: write',
    // the attestations API stores the signed provenance
    'attestations: write',
    // gh release upload / edit
    'contents: write',
    // the OIDC token Sigstore turns into the short-lived signing certificate
    'id-token: write',
  ]);
  assert.doesNotMatch(workflow, /^ {4}permissions:/m,
    'no job-level permissions: they would replace the reviewed workflow-level set');
});

test('the job has a runtime cap', () => {
  assert.match(workflow, /^ {4}timeout-minutes: \d+$/m);
});

test('every action is pinned to a 40-character commit SHA with a version comment', () => {
  const uses = workflow.split('\n').filter((l) => /^\s*(?:- )?uses:/.test(l));
  assert.ok(uses.length >= 2, 'checkout and attestation at least');
  for (const line of uses) {
    assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line.trim());
  }
});

test('no step interpolates an expression into a shell script', () => {
  // Values reach `run:` only through `env:`; `${{ }}` inside a script is the
  // classic Actions injection. The tag is checked against vX.Y.Z first.
  for (const step of allSteps) {
    const run = step.text.split(/^ {8}run: \|\n/m)[1];
    if (run !== undefined) assert.doesNotMatch(run, /\$\{\{/, `step "${step.name}"`);
  }
  const resolve = allSteps[0];
  assert.match(resolve.text, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/,
    'the first step rejects a tag that is not vX.Y.Z before anything uses it');
});

test('packs the tag with git archive under yuvomi-<version>/ and writes SHA256SUMS', () => {
  const pack = indexOf(/git archive --format=tar --prefix="yuvomi-\$VERSION\/" "refs\/tags\/\$TAG" \| gzip -n > "\$TARBALL"/);
  assert.notEqual(pack, -1, 'the tarball comes from git archive of the tag, gzip -n (no name, no time)');
  assert.match(allSteps[0].text, /tarball=yuvomi-\$VERSION-dist\.tar\.gz/,
    'asset name yuvomi-<version>-dist.tar.gz (decision E2), version without the v');
  const sums = indexOf(/sha256sum "\$TARBALL" > SHA256SUMS/);
  assert.ok(sums > pack, 'SHA256SUMS is written after the tarball');
});

test('attests the tarball and SHA256SUMS before anything is uploaded', () => {
  const attest = allSteps.findIndex((s) =>
    /uses: actions\/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4\.2\.2/.test(s.text));
  assert.notEqual(attest, -1, 'attest-build-provenance v4.2.2 by SHA');
  const subjects = allSteps[attest].text.match(/subject-path: \|\n((?: {12}\S.*\n)+)/);
  assert.ok(subjects, 'subject-path lists the subjects one per line');
  assert.deepEqual(
    subjects[1].trim().split('\n').map((l) => l.trim()),
    ['${{ steps.version.outputs.tarball }}', 'SHA256SUMS'],
  );
  assert.ok(attest > indexOf(/> SHA256SUMS/), 'both subjects exist when the attestation runs');
  assert.ok(attest < indexOf(/gh release upload/), 'nothing reaches the release unattested');
});

test('uploads both files, publishes last, then checks the result', () => {
  const upload = indexOf(/gh release upload "\$TAG" "\$TARBALL" SHA256SUMS --clobber/);
  assert.notEqual(upload, -1, 'upload both files; --clobber makes a rerun replace them');
  const publish = indexOf(/gh release edit "\$TAG" --draft=false/);
  assert.ok(publish > upload, 'the release leaves draft only after the upload');

  // Publishing is the LAST step that changes the release. Anything after it
  // would run while the release is already visible to every channel.
  const changing = allSteps
    .map((s, i) => (/gh release (?:create|upload|edit|delete)/.test(s.text) ? i : -1))
    .filter((i) => i !== -1);
  assert.equal(changing.at(-1), publish, '--draft=false is the last step that changes the release');

  const verify = indexOf(/gh release view "\$TAG" --json assets,isDraft/);
  assert.ok(verify > publish, 'the check runs on the published release');
  const check = allSteps[verify].text;
  assert.match(check, /\.isDraft/, 'it fails on isDraft: true');
  assert.match(check, /for NAME in "\$TARBALL" SHA256SUMS/, 'it fails on a missing asset, both names');
  assert.ok((check.match(/exit 1/g) || []).length >= 2, 'both conditions end the job red');
});

test('starts the Umbrel publish itself when it published the release', () => {
  // A release published with GITHUB_TOKEN fires no `release: published` run.
  const dispatch = indexOf(/gh workflow run umbrel-publish\.yml --ref main -f version="\$VERSION"/);
  assert.ok(dispatch > indexOf(/--json assets,isDraft/), 'only after the check passed');
  assert.match(allSteps[dispatch].text, /if: steps\.version\.outputs\.was-draft == 'true'/,
    'a release created non-draft by hand already fired "published" with a person\'s token');
  assert.match(allSteps[0].text, /was-draft=\$WAS_DRAFT/);
  assert.match(umbrel, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}version:/m,
    'umbrel-publish.yml still takes the version input this step passes');
});
