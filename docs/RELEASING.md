# Releasing Yuvomi

This is the public version of the release procedure. It exists for two readers: a contributor who
wants to know what happens between "merged" and "the image updated on my NAS", and whoever cuts the
first release of a fork under the clause in [CONTRIBUTING.md](../CONTRIBUTING.md#6-review-and-merge)
("If the maintainer stops"). Nothing here needs tooling outside this repository: `git`, `npm`,
`gh` and a browser are enough.

A release is a tag `vX.Y.Z` on this repository. Everything downstream hangs on that tag:

- `docker-publish.yml` runs on every `v*` tag, from any branch, and pushes the multi-arch image
  to `ghcr.io/ulsklyc/yuvomi` and to the legacy mirror `ghcr.io/ulsklyc/oikos` (the mirror must
  stay: installations from before the rename pull it and are updated through it).
- `release-assets.yml` is started by hand right after the GitHub release was created as a
  **draft** (GitHub runs no workflow for a draft's `created` event, so there is no automatic
  trigger that fires before the release is public). It packs the tag into `yuvomi-X.Y.Z-dist.tar.gz` (top-level folder `yuvomi-X.Y.Z/`, for now the same
  content as `git archive`), writes `SHA256SUMS`, attests both with a build provenance
  attestation, uploads them and only then publishes the release. YunoHost and the Proxmox script
  install from that asset, and neither sees a draft, so no channel ever sees a release without
  its tarball. If the job fails or was never started, the release stays a draft; start it with
  `gh workflow run release-assets.yml --ref vX.Y.Z -f tag=vX.Y.Z`.
- `umbrel-publish.yml` runs when the GitHub release is published and opens, or renames, the
  store PR against `getumbrel/umbrel-apps`. A release that `release-assets.yml` publishes with
  the workflow token fires no `published` run of its own, so that job starts this one explicitly.
- TrueNAS picks up the new image tag on its own; the Unraid template points at `latest`.

The in-app changelog reads the GitHub release, not `CHANGELOG.md`, so a release without notes is
visible to every household on the next start.

## Two tracks, and the check that decides

Releases run on two tracks, described in [CONTRIBUTING.md](../CONTRIBUTING.md#release-cadence):
anything under `public/pages`, `public/styles`, `public/utils`, `public/components` or
`public/settings` ships on Wednesdays and Sundays only; everything else ships any day, at most once
per calendar day. `npm run check:release-cadence` decides, and it runs **before the tag**, because it compares
`git describe --tags` with `HEAD` and an already-set tag makes that diff empty. It judges the whole
release, not the last commit: a server-only fix on a `main` that also carries interface work since
the last tag is an interface release.

## The ordinary release, from `main`

1. **Version.** `npm version <patch|minor|major> --no-git-tag-version`, then read the new number
   from `package.json`. The bump comes before the changelog: `test:changelog` accepts a version
   heading that has no tag yet only when it equals the version in `package.json`, so that an
   ordinary pull request cannot file its entry under a release heading of its own.
2. **Changelog.** Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty
   `## [Unreleased]` above it, keep every bullet. Only Keep-a-Changelog sections (`Added`,
   `Changed`, `Fixed`, `Removed`, `Security`), one bullet per user-facing change, in English. Do
   not touch the file header; `npm run test:changelog` checks the structure, and that no section
   released earlier differs from its tag.
3. **Service worker.** Nothing to set by hand any more: `npm run build` writes `APP_RELEASE` from
   `package.json`, the build revision and the precache list into `dist/sw.js`
   (`scripts/build/service-worker.ts`). If a file was added under `public/`, `test:static-copy-list`
   and `test:sw-precache` have to be green: a file the module graph does not reach must be on the
   copy list in `scripts/build/static-files.ts`.
4. **Version literals in the docs.** The landing pages and the installation guide carry the
   version and the release date as text: `docs/index.html` (hero bar and footer, with
   `data-released`), `docs/install.html` (footer, with `data-released`), and `docs/installation.md`
   (pinning example, compose line, `cosign verify` and `imagetools inspect` examples, sample
   startup log). Both footers carry the date twice, in `data-released` and as visible text, and the
   version grep finds neither. Treat that list as a hint and the grep as the authority - it has
   been wrong twice:

   ```bash
   grep -rn "<old version>" README.md README.de.md docs/*.html docs/*.md tools/installer/
   ```

   Historical `(vX.Y.Z)` markers inside `docs/SPEC.md` stay as they are.
5. **Star count on the landing pages.** `node scripts/update-gh-stars.mjs`, then stage
   `docs/index.html` and `docs/install.html` if it changed anything. Both carry the number in
   `[data-gh-stars]` elements and the script writes both - staging only `index.html` leaves
   `install.html` behind at the old count. It is embedded here, at release time, on purpose: the
   page never calls `api.github.com` from a visitor's browser, so opening it transmits no visitor
   data to a third country (`docs/datenschutz.html`). A weekly workflow did this until 7 September
   2026. It was removed because `main` requires status checks that a push from Actions cannot
   bring: the push was rejected, and the count silently stopped moving after 24 August.

6. **Umbrel store notes.** Fill `.github/umbrel-release-notes.md` and move its
   `<!-- version: X.Y.Z -->` marker. The publish workflow takes the text verbatim and aborts if the
   marker does not match the release, which is deliberate: a stale note describes an update a
   household is not getting. The rules for the text are in the head of the file.
7. **Cadence.** `npm run check:release-cadence`. Red is an answer, not an obstacle: wait for the
   next Wednesday or Sunday, take the interface change out, or - for a security or data-loss fix that cannot be
   separated from `main` - pass `--hotfix "<reason>"`; the reason is mandatory and printed. A
   foundation release of the architecture roadmap (build, runtime and rules, no feature
   interface) passes `--foundation "<phase>"` instead, for example `--foundation "1a toolchain"`;
   it is allowed on any day and prints `Fundament-Release <phase>`. A foundation release is
   announced one release ahead (a paragraph under the previous release block and an
   Announcements discussion), its CHANGELOG block starts with `### Foundation`, and before its
   tag the way back is tried once: the previous image and the foundation build run in turn on a
   copy of the same database (the demo seed does), a backup made on the new build restores on
   the previous one, and the service worker switches both ways without an error screen.
   `scripts/rollback-probe/run.sh <previous-image> <new-image>` runs exactly that (Docker, curl and
   `npm ci` in the checkout; it prints a protocol per stage and keeps fingerprints, API snapshots
   and screenshots in its work directory). The result goes into the release notes. The
   foundation does not change the database, so an operator can pin the previous tag
   (installation.md, "Pinning a version").
8. **Handrail, interface releases only.** If the diff since the last tag touches the interface
   paths above, run the browser suite once, and read its exit code from a file rather than a
   pipe (`| tail` reports the status of `tail`):

   ```bash
   npm run test:document-guards > /tmp/dg.log 2>&1; echo $?
   ```

9. **The whole chain.** `npm test`, green. A green single suite is not evidence; the guards that
   went red in the past (`test:sw-precache`, `test:document-folder-keys`, `test:changelog`) were
   never in anyone's "relevant" list.
10. **Commit, fetch, tag, push - in that order.** `git commit -m "chore: release vX.Y.Z"` with
    `CHANGELOG.md`, `package.json`, `package-lock.json`, the docs from steps 4 and 5 and
    the Umbrel notes staged by name (never `git add -A`). Then `git fetch origin` **before**
    `git tag vX.Y.Z`: the fetch brings in a tag somebody else may have set for the same version,
    and the tag command fails before anything is pushed. Then `git push && git push --tags`.
11. **GitHub release, as a draft.** Write the new changelog block to a file and pass it with
    `--notes-file`; a failed shell substitution yields an empty string that `gh` accepts without a
    word. Create the release with `--draft`, read the body back (a successful `create` reports the
    URL either way), then start the asset job, which publishes the release once the tarball is on
    it:

    ```bash
    gh release create vX.Y.Z --repo ulsklyc/yuvomi --title "vX.Y.Z" --notes-file <file> --draft
    gh release view vX.Y.Z --repo ulsklyc/yuvomi --json body --jq .body
    gh workflow run release-assets.yml --repo ulsklyc/yuvomi --ref vX.Y.Z -f tag=vX.Y.Z
    ```

    The job runs **at the tag** (`--ref vX.Y.Z`), not at `main`, and refuses any other ref: the
    attestation names the ref and commit the run sits on, and an operator checking
    `--source-ref refs/tags/vX.Y.Z` must find the tag there. A patch release from a branch
    works the same way, as long as its tag contains `release-assets.yml`.

    Wait for the job and check that the release came out of draft with both files on it:

    ```bash
    gh run list --repo ulsklyc/yuvomi --workflow=release-assets.yml --limit 1
    gh run watch <run-id> --repo ulsklyc/yuvomi --exit-status
    gh release view vX.Y.Z --repo ulsklyc/yuvomi --json assets,isDraft
    ```

    Expected: `isDraft: false`, assets `yuvomi-X.Y.Z-dist.tar.gz` and `SHA256SUMS`. A release that
    is still a draft is invisible to every channel; fix the cause and start the job again with
    the same command. Never publish the draft by hand to get past it.
12. **Downstream.** `gh run list --workflow=docker-publish.yml --limit 1` must show success (a
    failed image build silently stalls TrueNAS too). Check the tarball the way an operator would,
    from an empty directory:

    ```bash
    gh release download vX.Y.Z --repo ulsklyc/yuvomi --pattern 'yuvomi-*-dist.tar.gz' --pattern SHA256SUMS
    sha256sum -c SHA256SUMS
    gh attestation verify yuvomi-X.Y.Z-dist.tar.gz -R ulsklyc/yuvomi
    ```

    YunoHost's daily bump PR (`ulsklyc/yuvomi_ynh`) and the Proxmox script pick the asset up from
    there. The asset job also starts `corpus.yml`, which attaches `yuvomi-X.Y.Z-corpus.db` (plus
    `.sha256`) when the release changes the database schema or is a foundation release; check it
    with `gh run list --repo ulsklyc/yuvomi --workflow=corpus.yml --limit 1`. A red run does not
    touch the release; the restore drill names the missing database. Then look the Umbrel PR up rather than
    assuming a number - the workflow renames the open PR if there is one and opens a new one only
    once the previous one was merged:

    ```bash
    gh pr list --repo getumbrel/umbrel-apps --author ulsklyc --state all --limit 5
    ```

## A security fix: patch release from the last tag

Since v2.64.1 (4 September 2026) a security fix does not wait for `main` to be releasable and
does not pull the interface work waiting there forward with it. It ships from a branch off the
last tag, carrying the fix, its tests and its documentation and nothing else:

1. `git switch -c release/X.Y.Z vX.Y.(Z-1)` - the branch starts at the tag, not at `main`.
2. Cherry-pick the fix commits. On the branch `## [Unreleased]` holds only the `### Security`
   block; expect a conflict there if `main`'s Unreleased section is not empty, and resolve it to
   the security entries alone.
3. Steps 1 to 6 above, by hand where the version bump tooling assumes `main`. The Umbrel notes are
   part of it: the publish workflow aborts on a stale version marker whichever branch the release
   came from. A guard that landed after the tag (the cadence check itself was such a case in
   September 2026) is absent on the branch; run it from a copy taken off `main`.
4. `npm test` on the branch, then commit, fetch, tag, push, release, downstream - steps 9 to 12.
   The cadence check passes on the second track by construction: the diff since the last tag is
   the fix.
5. Merge the branch back: `git switch main && git merge --no-ff release/X.Y.Z`. One conflict
   is normal - `CHANGELOG.md`, where the new block goes below `## [Unreleased]` and the
   Unreleased bullets stay. A branch off a tag before 2.88.0 also conflicts in `public/sw.js`,
   which carried the version by hand until then; `main`'s shape of the file wins. After resolving, check that `CHANGELOG.md` contains no conflict markers and that
   its heading structure is what you meant (`git add` checks neither; `test:changelog` compares
   every released section with the new tag and so catches a bullet that slid into or out of the
   new block, but not one that landed under the wrong heading inside `[Unreleased]`), run
   `npm test` on the merge, push.

Publish the advisory after the image is out, with the fixed version, the reporter's credit and a
CVE requested through GitHub. The response times this has to fit are in
[SECURITY.md](../SECURITY.md#reporting-a-vulnerability).

## What a fork has to change

- The image names in `docker-publish.yml` follow `github.repository` and
  `github.repository_owner`, so a fork publishes under its own account without edits; the `oikos`
  mirror line then publishes `<owner>/oikos`, which a fork can drop.
- `umbrel-publish.yml` needs the `UMBREL_FORK_TOKEN` secret (a classic token with the `public_repo`
  scope and nothing else; a fine-grained token cannot open the pull request in
  `getumbrel/umbrel-apps`) and pushes to a fork of that repository; without the secret the job fails and nothing
  else is affected. Only its last job, `publish`, sees the token: the catalog's linter and its npm
  dependencies run in a job of their own with no secret and no rights. A manual run with
  `-f dry_run=true` prepares and lints without pushing.
- `release-assets.yml` needs no secret: the workflow token uploads the assets, and the
  attestation is signed through GitHub's OIDC token and Sigstore. Attestations are free for public
  repositories only; a private fork has to drop that step.
- The Claude review workflows need their own API key or can be deleted; they merge nothing.
- The image runs Node 24 (`Dockerfile`, pinned to a digest that Dependabot moves), and CI tests
  Node 24 and 26; `test:docker-publish` keeps the CI matrix and the image's major together.
- Every action in `.github/workflows/` is pinned to a commit SHA with the version as a comment;
  `test:workflow-pins` refuses a floating tag, and Dependabot updates the SHA and the comment
  together.
