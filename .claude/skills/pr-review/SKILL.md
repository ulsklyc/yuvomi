---
name: pr-review
description: Review a PR against the Yuvomi Hard Constraints and decide close/request-changes/merge
disable-model-invocation: true
user-invocable: true
argument-hint: "<pr-number>"
allowed-tools:
  - Bash(gh pr *)
  - Bash(gh api *)
  - Bash(git *)
  - Bash(npm test *)
  - Bash(npm run test:*)
  - Read
  - Grep
  - Glob
---

Run from inside `oikos/`. `$1` is the PR number.

1. **Fetch** — `gh pr view $1 --repo ulsklyc/yuvomi`, `gh pr diff $1 --repo ulsklyc/yuvomi`, `gh pr checks $1 --repo ulsklyc/yuvomi`. Note failing checks. Delegate the deep read to the `pr-reviewer` subagent (`Agent({ subagent_type: "pr-reviewer", ... })`) so main-thread context stays free.
2. **Constraint check** — walk the diff against CLAUDE.md Hard Constraints:
   - No frontend frameworks / bundlers / CSS libraries added
   - No `require`, only `import`/`export`
   - No `eval`, no `innerHTML`
   - All UI text via `t('key')`; `de` locale updated
   - Migrations append-only (`server/db.js`)
   - Design values from `public/styles/tokens.css`
   - Route handlers wrapped in try/catch
   - API shape `{ data }` / `{ error, code }`
   Also check: PR has tests touching the relevant `test-<module>.js`, CHANGELOG entry under `## [Unreleased]`, commit subjects are Conventional Commits.
3. **Decide**
   - **Blocking issue found** → `gh pr review $1 --request-changes --body "<english, grouped by file:line>"` and stop.
   - **Not a fit** → explain politely and `gh pr close $1 --comment "..."`.
   - **Clean** → `gh pr review $1 --approve --body "LGTM"` then `gh pr merge $1 --squash --delete-branch`. After merge, fetch `main` locally and consider running `/release-prep`.

## Guardrails

- Comments and review bodies: always English.
- Never merge with failing required checks. Never force-merge.
- Never close a PR without a reason comment — silent closes burn contributor trust.
- Never push directly to the PR branch. If a small fix is warranted, ask the contributor.
