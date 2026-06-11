---
name: docs-sync
description: Sync all user-facing documentation (README, SPEC, installation guide, GitHub Pages landing/install pages, installer README, .env.example, directory listings) plus the CLAUDE.md command/env sections with the latest features and CHANGELOG. Use after completing any task that adds, changes, or removes a user-facing feature, env var, module, or installation step — and before running release-prep.
user-invocable: true
argument-hint: "[version or changelog range, e.g. v0.55.19 or v0.55.18-v0.55.19]"
allowed-tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(grep *)
  - Bash(ls *)
  - Bash(find *)
  - Bash(cat *)
  - Bash(jq *)
---

Synchronize the documentation with the current state of the code. Run from inside `oikos/`.

The **source of truth** is the change being documented: the relevant `CHANGELOG.md` block(s)
(the argument names the version/range; default to the topmost released block) plus the actual
diff/code. Never invent features that aren't real. Read the changelog block first, then walk the
sync targets below and update **only** what the change actually affects.

## Procedure

1. **Establish the delta.** Read the relevant `CHANGELOG.md` block(s). If a version/range was
   passed as an argument, use it; otherwise use the most recent released block. Run
   `git diff <prev-tag>..HEAD --stat` (or inspect the working tree) to see which areas changed:
   features, env vars, modules, data model, installation, or installer.
2. **Walk every sync target** in the table below. For each, decide whether this delta touches it.
   Read the file, update only the affected parts, and skip files the delta does not touch. Make a
   one-line note per file of "updated" or "no change needed (reason)" for the final summary.
3. **Verify version references.** Read the new version from `package.json`. Update the version
   badge in `docs/index.html` (hero proof bar **and** footer). Do **not** bump the feature-anchored
   version notes inside `docs/SPEC.md` (e.g. "(v0.55.10)") — those are historical markers.
4. **Confirm no stale versions linger:** `grep -rn "<old-version>" README.md docs/*.html docs/*.md tools/installer/`.
5. **Report** a concise per-file summary (updated / no change) so the changes are auditable.

## Sync targets

| File | What to check |
|------|---------------|
| `README.md` | Module table, Quick Start (install options), Design & Technology section, doc link row |
| `MODULES.md` | Third-party module manifest fields, loading behavior, Docker mount notes |
| `docs/SPEC.md` | Data model (new columns/tables), feature specs, env/security model. New feature notes may carry a `(vX.Y.Z)` marker; do not rewrite older ones |
| `docs/installation.md` | Env-var tables, install options, HTTPS/reverse-proxy, backup/restore, troubleshooting |
| `.env.example` | Every env var with a sensible comment/default — keep in lockstep with `tools/installer/env-schema.js` |
| `docker-compose.yml` | Port mapping, env passthrough, volumes (only when deployment behavior changed) |
| `podman-compose.yml` | Mirror `docker-compose.yml`: port mapping, env passthrough, volumes |
| `tools/quadlet/oikos.container` | Podman Quadlet — ports, env, volumes (mirror compose) |
| `templates/yuvomi.xml` | Unraid CA template — **every** env var/port/volume is a hand-written `<Config>` (no fallback). Add/edit/remove the matching entry; mask secrets (`Mask="true"`), put optional integrations on `Display="advanced"` |
| `ca_profile.xml` | Unraid CA profile blurb — only when the app overview / module list changed |
| `deploy/truenas/questions.yaml` + `deploy/truenas/templates/docker-compose.yaml` | TrueNAS catalog-config source. Required secrets / new ports / new volumes only — optional env vars are covered by the generic `additional_envs` list. Version bumps reach the upstream `truenas/apps` catalog automatically via the `truenasbot` Renovate bot (new ghcr image tags); config changes need a manual PR carrying these edits |
| `tools/installer/README.md` | Installer steps, requirements, endpoints, localization, design |
| `docs/index.html` | Version badge (hero + footer), feature showcase/grid, social-proof counts. **EN + DE i18n in lockstep** |
| `docs/install.html` | Install options/cards, optional-integration cards. **EN + DE i18n in lockstep** |
| `docs/awesome-selfhosted/yuvomi.yml` | `description` + `tags` reflect current modules |
| `docs/awesome-selfhosted/issue-addition.md` | Directory-submission blurb matches `yuvomi.yml` |
| `CONTRIBUTING.md` | Only when commit format, conventions, or test workflow changed |
| `SECURITY.md` | Only when the security model or supported-version policy changed |
| `CLAUDE.md` | **Only two sections:** the `## Commands` test-script list (keep in lockstep with the `test:*` scripts in `package.json`) and the `## Environment` env-var list (keep in lockstep with `.env.example`). Never touch any other part — architecture, hard constraints, key locations, conventions belong to the separate CLAUDE.md maintenance process |

## Conventions & guardrails

- **i18n parity** in `docs/index.html` / `docs/install.html`: every visible string has both an EN and
  a DE entry. The visible HTML `data-t` defaults use real UTF-8; the JS i18n string objects use
  `\uXXXX` escapes (e.g. `ü`, `—`) — match the surrounding style in each block.
- App locales: when a change adds UI keys, all `public/locales/*.json` must already be updated
  (that's app work, not this skill) — `de` is the reference, `en` the fallback. This skill only
  touches **documentation**, never app strings or code.
- **Never touch historical/working docs:** `docs/archive/**`, `docs/design/**`,
  `docs/UI-UX-AUDIT-2026-05.md`, `docs/installer-*.md`, `BACKLOG.md`, `SECURITY_RESEARCH.md`.
- `CHANGELOG.md` is read-only here — it is the source of truth, maintained by `release-prep`.
- **Deploy descriptors are primarily kept in sync *during implementation*** by the `deploy-targets`
  rule (`.claude/rules/deploy-targets.md`), which fires whenever the env schema, Compose/Podman,
  Unraid, or TrueNAS files are edited and treats those updates as part of the task's definition of
  done. This skill is the release-time backstop — still verify each deploy descriptor row above.
- **`CLAUDE.md` is scoped:** edit **only** the `## Commands` test-script list and the
  `## Environment` env-var list (see sync targets). Everything else in `CLAUDE.md` — architecture,
  hard constraints, key locations, conventions — belongs to its own maintenance process and is
  off-limits here.
- Do not commit/push — that is `release-prep`'s job. This skill only edits files in the working tree.
