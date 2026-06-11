---
name: issue-triage
description: Classify one or all open issues, apply labels, request missing info
disable-model-invocation: true
user-invocable: true
argument-hint: "[<issue-number> | all]"
allowed-tools:
  - Bash(gh issue *)
  - Bash(gh label *)
  - Read
  - Grep
---

Run from inside `oikos/`. `$1` is a specific issue number or the literal `all` (default: `all` → every open issue without labels).

1. **Load** — for a single issue: `gh issue view $1 --repo ulsklyc/yuvomi --comments`. For `all`: `gh issue list --repo ulsklyc/yuvomi --state open --label '' --json number,title,body,author,createdAt`.
2. **Classify** — for each issue, pick ONE primary class and apply labels via `gh issue edit <n> --repo ulsklyc/yuvomi --add-label "<labels>"`:
   - `bug` — reproduction + expected vs. actual behaviour present and plausible against current code
   - `enhancement` — new feature or UX improvement, no existing regression
   - `question` — user needs help using Yuvomi, not a code change
   - `invalid` — spam, duplicate, or out of scope (self-hosted family planner)
   Add area labels where obvious: `calendar`, `tasks`, `shopping`, `meals`, `budget`, `notes`, `contacts`, `reminders`, `i18n`, `pwa`, `security`, `docs`.
3. **Request missing info** — if reproduction steps, expected behaviour, Yuvomi version, or browser are missing on a `bug`, post a single comment asking for exactly what's missing. Apply label `needs-info`.
4. **Close spam/duplicates** — `gh issue close <n> --repo ulsklyc/yuvomi --reason "not planned" --comment "<english explanation>"`. Always leave a reason.

## Guardrails

- Never assign issues to other humans.
- Never post more than one triage comment per issue per run.
- All comments in English.
- If unsure between two classes, default to `question` and ask for clarification — don't guess.
