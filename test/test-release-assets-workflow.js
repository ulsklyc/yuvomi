/**
 * Module: Test infrastructure - release asset workflow
 * Purpose: `.github/workflows/release-assets.yml` is the only workflow that may
 *          write to releases. It builds `yuvomi-<version>-dist.tar.gz` and
 *          `SHA256SUMS`, attests both, uploads them and only then takes the
 *          release out of draft. YunoHost and Proxmox install from that asset;
 *          Proxmox `prebuild` silently falls back to the previous release when
 *          the asset is missing. So the order is the promise: a published
 *          release always carries its asset. This guard reads the workflow as
 *          text and holds trigger, permissions, pins, the build with its
 *          determinism check, the reproducible pack of tag tree plus dist/,
 *          the attestation subjects, the publish-last order and the closing check. It starts by
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

/**
 * The text of job `name` (from `  name:` up to the next job or the end).
 * @param {string} source
 * @param {string} name
 */
function jobBlock(source, name) {
  const lines = source.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `the workflow needs a job "${name}"`);
  const jobsAt = lines.indexOf('jobs:');
  assert.ok(jobsAt !== -1 && start > jobsAt, `${name} sits under jobs:`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

/** Steps of one job as `{ name, text }`, in file order. */
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

// Phase 1a, section D: two jobs. `build` runs npm and the Vite build with
// read rights only; `publish` holds the write rights and runs no project code.
const buildJob = jobBlock(workflow, 'build');
const publishJob = jobBlock(workflow, 'publish');
const buildSteps = steps(buildJob);
const publishSteps = steps(publishJob);
const allSteps = [...buildSteps, ...publishSteps];
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

test('refuses to run anywhere but at the tag it packs', () => {
  // The attestation takes repository, ref and commit from the run's OIDC
  // token, not from the checkout. A run on main would sign "built from main"
  // for a tarball of the tag, and `--source-ref refs/tags/v...` would fail.
  const resolve = buildSteps[0].text;
  const refCheck = resolve.search(/if \[ "\$GITHUB_REF" != "refs\/tags\/\$TAG" \]; then\n.*\n {12}exit 1/);
  assert.notEqual(refCheck, -1, 'the first step exits unless GITHUB_REF is refs/tags/$TAG');
  assert.ok(refCheck !== -1 && !/gh release/.test(resolve), 'the build job never touches the release');
  const check = publishSteps[0].text;
  const again = check.search(/if \[ "\$GITHUB_REF" != "refs\/tags\/\$TAG" \]; then\n.*\n {12}exit 1/);
  assert.ok(again !== -1 && again < check.indexOf('gh release view'), 'the publish job checks the ref again before it touches the release');
});

test('the workflow grants nothing; build reads, only publish writes', () => {
  assert.match(workflow, /^permissions: \{\}$/m, 'top level grants nothing; each job names its own');
  /** @param {string} job */
  const jobPerms = (job) => {
    const m = job.match(/^ {4}permissions:\n((?: {6}\S.*\n)+)/m);
    assert.ok(m, 'every job names its permissions');
    return m[1].trim().split('\n').map((l) => l.trim()).sort();
  };
  assert.deepEqual(jobPerms(buildJob), ['contents: read'], 'the build job (npm, Vite, plugins) can only read');
  assert.deepEqual(jobPerms(publishJob), [
    // dispatch umbrel-publish.yml: the release this job publishes fires no event
    'actions: write',
    // the attestations API stores the signed provenance
    'attestations: write',
    // gh release upload / edit
    'contents: write',
    // the OIDC token Sigstore turns into the short-lived signing certificate
    'id-token: write',
  ]);
  assert.match(publishJob, /^ {4}needs: build$/m, 'publish runs after build');
});

test('no foreign code next to a token: build holds none, publish runs no npm and no checkout', () => {
  assert.doesNotMatch(buildJob, /GH_TOKEN|github\.token|secrets\./, 'no token in the build job');
  assert.doesNotMatch(buildJob, /id-token|attest-build-provenance/, 'no signing in the build job');
  assert.match(buildJob, /run: npm ci/);
  const publishCode = publishJob.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(publishCode, /\bnpm\b|\bnode\b|actions\/checkout@|actions\/setup-node@/, 'publish runs no project code');
  const jobEnv = publishJob.match(/^ {4}env:\n((?: {6}\S.*\n)+)/m)?.[1] ?? '';
  assert.doesNotMatch(jobEnv, /GH_TOKEN/, 'GH_TOKEN on the steps that call gh, never on the job');
  for (const step of publishSteps) {
    if (/\bgh (?:release|workflow)\b/.test(step.text)) {
      assert.match(step.text, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m, `step "${step.name}" calls gh and names its token`);
    } else {
      assert.doesNotMatch(step.text, /GH_TOKEN/, `step "${step.name}" needs no token`);
    }
  }
  // The handover: build uploads both files, publish takes them and checks the hashes before signing.
  const up = buildSteps.findIndex((st) => /uses: actions\/upload-artifact@[0-9a-f]{40} # v/.test(st.text));
  assert.ok(up > buildSteps.findIndex((st) => /> SHA256SUMS/.test(st.text)), 'uploaded after SHA256SUMS is written');
  assert.match(buildSteps[up].text, /if-no-files-found: error/);
  const down = publishSteps.findIndex((st) => /uses: actions\/download-artifact@[0-9a-f]{40} # v/.test(st.text));
  const check = publishSteps.findIndex((st) => /sha256sum -c SHA256SUMS/.test(st.text));
  const attest = publishSteps.findIndex((st) => /attest-build-provenance@/.test(st.text));
  assert.ok(down !== -1 && check > down && attest > check, 'download, check the hashes, then attest');
});

test('the determinism builds run without any token in their environment', async () => {
  const { SECRET_ENV, buildEnv } = await import('../scripts/check-build-determinism.mjs');
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
    assert.ok(SECRET_ENV.includes(name), name);
  }
  const env = buildEnv({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b', ACTIONS_ID_TOKEN_REQUEST_URL: 'c', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'd', ACTIONS_RUNTIME_TOKEN: 'e', NPM_TOKEN: 'f', PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('both jobs have a runtime cap', () => {
  for (const job of [buildJob, publishJob]) assert.match(job, /^ {4}timeout-minutes: \d+$/m);
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

test('builds dist/ deterministically, then packs the tag tree plus dist/ under yuvomi-<version>/ and writes SHA256SUMS', () => {
  // Phase 1a, section D: the asset is the git archive of the tag PLUS the built
  // web app (the server refuses to start without dist/), packed reproducibly.
  const build = indexOf(/npm run build\n\s+node scripts\/check-build-determinism\.mjs --ref "refs\/tags\/\$TAG"/);
  assert.notEqual(build, -1, 'build, then two more builds of the tag compared file by file');
  assert.match(allSteps[build].text, /APP_BUILD_REVISION: \$\{\{ github\.sha \}\}/, 'the revision is the tagged commit, as in the image');
  assert.ok(indexOf(/run: npm ci/) < build, 'npm ci before the build');
  const pack = indexOf(/git archive --format=tar --prefix="yuvomi-\$VERSION\/" "refs\/tags\/\$TAG" \| tar -x -C stage/);
  assert.notEqual(pack, -1, 'the source part comes from git archive of the tag, under yuvomi-<version>/');
  assert.ok(build < pack, 'packed only after the determinism check');
  const packText = allSteps[pack].text;
  assert.match(packText, /cp -R dist "stage\/yuvomi-\$VERSION\/dist"/, 'dist/ goes in under the same top-level folder');
  assert.match(packText, /SOURCE_DATE_EPOCH="\$\(git log -1 --format=%ct "refs\/tags\/\$TAG"\)"/);
  assert.match(packText, /tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@\$SOURCE_DATE_EPOCH"/, 'reproducible tar: order, owner, time');
  assert.match(packText, /\| gzip -n > "\$TARBALL"/, 'gzip -n (no name, no time)');
  assert.match(packText, /for NEED in index\.html sw\.js THIRD-PARTY-NOTICES\.txt; do/, 'the pack checks that the build is in it');
  assert.match(packText, /sed -n "\\#\^yuvomi-\$VERSION\/#!p"/, 'and that nothing lies outside the top-level folder');
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
    ['${{ needs.build.outputs.tarball }}', 'SHA256SUMS'],
  );
  assert.ok(attest > indexOf(/> SHA256SUMS/), 'both subjects exist when the attestation runs');
  assert.ok(attest < indexOf(/gh release upload/), 'nothing reaches the release unattested');
});

test('uploads both files, publishes last, then checks the result', () => {
  const upload = indexOf(/gh release upload "\$TAG" "\$TARBALL" SHA256SUMS --clobber/);
  assert.notEqual(upload, -1, 'upload both files; --clobber makes a rerun on a draft replace them');
  // `--clobber` deletes before it uploads: on a public release a failed
  // upload would leave it without its file. So replace only on a draft, and
  // on a public release add only what is missing.
  const uploadText = allSteps[upload].text;
  const [draftBranch, publicBranch] = uploadText.split(/^ {10}else$/m);
  assert.ok(publicBranch, 'the upload step has a draft branch and a public branch');
  assert.match(draftBranch, /--json isDraft --jq \.isDraft\)" = "true" \]; then\n {12}gh release upload "\$TAG" "\$TARBALL" SHA256SUMS --clobber/,
    '--clobber sits inside the isDraft == true branch');
  assert.doesNotMatch(publicBranch, /--clobber/, 'a public release never loses an asset');
  assert.match(publicBranch, /grep -qxF "\$NAME"[\s\S]*gh release upload "\$TAG" "\$NAME"$/m,
    'on a public release only a missing file is uploaded');
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

test('hands over to the Umbrel publish on every successful run, at the tag', () => {
  // A release published with GITHUB_TOKEN fires no `release: published` run,
  // so this job starts umbrel-publish.yml itself.
  const dispatch = indexOf(/gh workflow run umbrel-publish\.yml --ref "\$TAG" -f version="\$VERSION"/);
  assert.notEqual(dispatch, -1,
    'dispatched at the TAG: umbrel-publish reads the release notes from its checkout, and the '
    + 'notes for this version live at the tag (on main they may belong to the next release)');
  assert.ok(dispatch > indexOf(/--json assets,isDraft/), 'only after the check passed');
  // No condition: a rerun after a failure past the publish step finds the
  // release already public and must still hand over. umbrel-publish updates
  // its PR in place and refuses older versions itself.
  assert.doesNotMatch(allSteps[dispatch].text, /^ {8}if:/m, 'the handover runs on every successful run');
  // ... for the NEWEST release only: umbrel-publish's own "refuse to walk the
  // store backwards" runs for its release event, not for a dispatch.
  const text = allSteps[dispatch].text;
  const newest = text.search(/gh release list --exclude-drafts .*--json tagName/);
  assert.notEqual(newest, -1, 'it reads the published releases');
  assert.match(text, /sort -V \| tail -1\)"/, 'and takes the highest version');
  assert.match(text, /if \[ "\$NEWEST" != "\$TAG" \]; then\n(?:.*\n)*? {12}exit 0\n {10}fi\n {10}gh workflow run umbrel-publish/,
    'an older tag stops before the dispatch');
  assert.match(umbrel, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}version:/m,
    'umbrel-publish.yml still takes the version input this step passes');
});

test('starts the migration corpus for every published release, from main, without failing the run', () => {
  // Phase 1b, section B: corpus.yml decides itself whether this release
  // changes the schema. It runs from main because tags older than corpus.yml
  // do not contain it; it checks out the tag itself.
  const dispatch = indexOf(/gh workflow run corpus\.yml --ref main -f tag="\$TAG"/);
  assert.notEqual(dispatch, -1, 'the publish job starts corpus.yml with the tag');
  assert.equal(dispatch, allSteps.length - 1, 'it is the last step, after the Umbrel handover');
  assert.ok(dispatch > indexOf(/gh workflow run umbrel-publish\.yml/), 'after the Umbrel handover');
  const text = allSteps[dispatch].text;
  assert.match(text, /^ {8}continue-on-error: true$/m, 'a failed start never turns a published release run red');
  assert.doesNotMatch(text, /^ {8}if:/m, 'on every successful run; corpus.yml skips a release without a schema change');
  const corpus = readFileSync(new URL('../.github/workflows/corpus.yml', import.meta.url), 'utf8');
  assert.match(corpus, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:/m, 'corpus.yml takes the tag input this step passes');
});
