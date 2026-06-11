---
name: fix-issue
description: Take a GitHub issue from triage through a PR on a fix/<id> branch
disable-model-invocation: true
user-invocable: true
argument-hint: "<issue-number>"
allowed-tools:
  - Bash(gh issue *)
  - Bash(gh pr *)
  - Bash(git checkout *)
  - Bash(git add *)
  - Bash(git commit *)
  - Bash(git push *)
  - Bash(npm test *)
  - Bash(npm run test:*)
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---

Run from inside `oikos/`. `$1` is the issue number.

1. **Load context** — `gh issue view $1 --repo ulsklyc/yuvomi --comments`. Read linked PRs, commits, related issues. Stop and report if the issue is already closed or duplicated.
2. **Triage before coding** — classify: bug, enhancement, question, invalid. If reproduction steps are missing or scope is unclear, post a question via `gh issue comment $1 --body "..."` and stop. Do not guess intent.
3. **Branch + implement** — `git checkout -b fix/$1`. Make the minimal change that solves the reported problem. Respect the Hard Constraints from CLAUDE.md. Add or extend a `test-<module>.js` suite that would have caught the bug. Run `npm test` — all suites must pass before moving on.
4. **Ship** — `git add` only the files actually changed by this fix, commit with a Conventional Commit subject (`fix: <short summary> (#$1)`), push `git push -u origin fix/$1`, then `gh pr create --fill --base main` with a body that closes the issue (`Closes #$1`) and summarises root cause + fix.

## Guardrails

- Never work on `main` directly. If you're accidentally on `main`, stop and switch.
- Never bypass the PostToolUse innerHTML hook. If it fires, fix the DOM code — don't disable the hook.
- Never `git add -A` or `git add .`. Stage files by name.
- If the fix needs a DB change, it goes into a NEW entry at the end of the `migrations` array in `server/db.js`. Never edit existing entries.
- Do not run the `release-prep` skill here — releases happen after the PR is merged, on `main`.
