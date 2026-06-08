---
name: release-prep
description: Bump patch version, update CHANGELOG, commit, tag, push and create GitHub release
disable-model-invocation: true
user-invocable: true
argument-hint: "[patch|minor|major]"
allowed-tools:
  - Read
  - Edit
  - Bash(npm version *)
  - Bash(git add *)
  - Bash(git commit *)
  - Bash(git tag *)
  - Bash(git push *)
  - Bash(gh release create *)
  - Bash(git status *)
  - Bash(git log *)
  - Bash(git diff *)
---

Run from inside `oikos/`. Argument selects the semver bump (default: patch).

1. **Pre-flight** — run `git status` and `git diff --staged`. Abort if the tree is dirty with unrelated files. Summarise the pending changes.
2. **CHANGELOG** — open `oikos/CHANGELOG.md`. Insert a new `## [X.Y.Z] - YYYY-MM-DD` block immediately below `## [Unreleased]`. Use today's date from the `currentDate` context. Only use Keep-a-Changelog sections: `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`. One bullet per user-facing change in English. Never invent entries that aren't in the diff.
3. **Version bump** — run `npm version ${1:-patch} --no-git-tag-version`. Read the new version from `oikos/package.json`.
4. **Stage** — `git add oikos/CHANGELOG.md oikos/package.json oikos/package-lock.json` plus any other files from the task. Never use `git add -A` or `git add .`.
5. **Commit** — `git commit -m "chore: release vX.Y.Z"`. Do not pass `--no-verify`. If a hook fails, fix the cause and create a new commit.
6. **Tag** — `git tag vX.Y.Z`.
7. **Push** — `git push && git push --tags`.
8. **GitHub Release** — `gh release create vX.Y.Z --repo ulsklyc/yuvomi --title "vX.Y.Z" --notes "<CHANGELOG block body>"`. Paste the new CHANGELOG section verbatim as notes.

## Guardrails

- Never `--force`, never `--no-verify`, never `--no-gpg-sign`.
- The `GH_TOKEN` must come from the shell environment, never from a hard-coded literal in this file or in commit messages.
- If `gh release create` fails with a 401/403, stop and report — do not paste a token inline.
- If `git status` shows uncommitted work unrelated to the release, stop and ask the user.
