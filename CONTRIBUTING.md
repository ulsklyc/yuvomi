# Contributing to Yuvomi

Thanks for your interest in contributing! Yuvomi is a small, opinionated project with deliberate architectural constraints. This guide covers what you need to know before submitting code.

Have a question before diving in? Start a thread in [Discussions](https://github.com/ulsklyc/yuvomi/discussions).

---

## Hard Constraints

**Yuvomi enforces a strict "no frameworks, no build tools" policy.** This is a permanent architectural decision, not a temporary limitation.

Specifically - the following will **not** be merged:

- Frontend frameworks (React, Vue, Svelte, Angular, etc.)
- Bundlers or transpilers (Webpack, Vite, Rollup, esbuild, TypeScript, etc.)
- CSS libraries (Tailwind, Bootstrap, etc.)
- External frontend dependencies at runtime - no CDN loads, no npm frontend packages. Third-party frontend code is allowed only as hand-copied, committed vendoring under `public/vendor/` (currently PDF.js, SortableJS, libphonenumber - plus Lucide at `public/lucide.min.js`); each vendored package ships its license and a README with update steps

Backend dependencies are evaluated case-by-case but must remain minimal. When in doubt, open an issue before writing code.

---

## Development Setup

### Prerequisites

- Node.js ≥ 22 (required for `--experimental-sqlite` in tests)
- Git

### Getting started

```bash
git clone https://github.com/ulsklyc/yuvomi.git
cd yuvomi
npm install
cp .env.example .env
# Set SESSION_SECRET - and CLEAR the prefilled DB_ENCRYPTION_KEY line
# (empty key = unencrypted dev DB; the placeholder would encrypt it with a
# publicly known string)
npm run dev
```

`npm run dev` starts the server with `--watch` for automatic restarts on file changes.
The app answers on [http://localhost:3000](http://localhost:3000). On the first visit it
guides you through creating the admin account in the browser; headless setups can run
`npm run setup` instead.

### Running tests

```bash
npm test              # All suites
```

Individual suites (faster during development):

```bash
npm run test:db
npm run test:tasks
npm run test:shopping
npm run test:meals
npm run test:calendar
npm run test:ncb            # notes, contacts, budget
npm run test:reminders
npm run test:notifications    # Web Push and external notification channels
npm run test:dashboard
npm run test:screensaver
npm run test:api
npm run test:ics-parser
npm run test:ics-sub
npm run test:modal-utils
npm run test:ux-utils
npm run test:kitchen-tabs
npm run test:setup
npm run test:multi-assignment
npm run test:caldav
npm run test:carddav
npm run test:split-expenses
npm run test:backup-scheduler
npm run test:housekeeping
npm run test:mobile-scroll-layout
npm run test:frontend-audit
npm run test:docker-publish
```

This is a representative selection - run `npm run` to see the full list of suites.
Which suite guards which invariant is catalogued in [docs/test-suites.md](docs/test-suites.md).

Tests run with plain Node and in-memory SQLite (`--experimental-sqlite`) - newer suites
use the built-in `node --test` runner, older ones are plain assertion scripts. No running
server or database required; tests import route handlers directly.

---

## Project Structure

Understanding where things live helps you find the right place for your changes:

```
server/
  index.js             # Express entry point, middleware chain
  db.js                # SQLite connection + migration runner (append-only)
  auth.js              # Session auth + user management
  routes/              # API route handlers - one file per module
  services/            # Business logic (calendar sync, recurrence engine)
public/
  index.html           # SPA shell (single entry point)
  router.js            # Client-side History API router
  api.js               # Fetch wrapper (auth, CSRF, error handling)
  styles/
    tokens.css         # Design tokens - all colors, radii, shadows, fonts
  components/          # Reusable Web Components (yuvomi-* prefix)
  pages/               # Page modules - each exports a render() function
  sw.js                # Service worker
  offline.html         # Offline fallback page (served by service worker)
test/                  # One test file per module (test-[module].js)
docs/                  # Product spec, screenshots
```

**Key patterns:**

- Every API route lives in `server/routes/` and follows the same `try/catch` → JSON response pattern
- Every frontend page is an ES module in `public/pages/` that exports `render()`
- All design values come from `tokens.css` - never hardcode colors, radii, or shadows
- Database migrations are appended to the `MIGRATIONS` array in `server/db.js` - never modify existing entries

---

## Workflow

### 1. Find or create an issue

Before starting work, check the [existing issues](https://github.com/ulsklyc/yuvomi/issues). For anything beyond a trivial fix, open an issue first to discuss the approach. This avoids wasted effort on changes that conflict with the project's direction.

### 2. Fork and branch

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR-USERNAME/yuvomi.git
cd yuvomi
git remote add upstream https://github.com/ulsklyc/yuvomi.git
git checkout -b feat/your-feature-name
```

**Branch naming:**

| Prefix | Use for | Example |
|--------|---------|---------|
| `feat/` | New features | `feat/csv-import-budget` |
| `fix/` | Bug fixes | `fix/calendar-sync-timezone` |
| `refactor/` | Internal changes (no behavior change) | `refactor/extract-date-utils` |
| `docs/` | Documentation only | `docs/improve-setup-guide` |
| `chore/` | Maintenance, CI, dependencies | `chore/update-helmet` |

### 3. Keep your fork in sync

```bash
git fetch upstream
git rebase upstream/main
```

Rebase before opening a PR. After that, do not keep rebasing to stay current.
`main` moves several times a day, and a branch that chases it spends your time
on conflicts that get resolved again at merge anyway. Rebase once more when the
review is done and the PR is about to land. What happens to a stale PR in the
meantime is spelled out under [Review and merge](#6-review-and-merge).

### 4. Commit

Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <description>

[optional body]
[optional footer]
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style` (formatting, not CSS)

**Scope:** The module or area affected - `tasks`, `shopping`, `meals`, `calendar`, `budget`, `notes`, `contacts`, `health`, `documents`, `auth`, `db`, `ui`, `pwa`

**Examples:**

```
feat(meals): add drag & drop between day slots
fix(calendar): handle timezone offset in recurring events
docs(readme): add Apple CalDAV setup instructions
refactor(auth): extract session validation into middleware
test(budget): add CSV export edge cases
chore: update helmet to 8.3
```

**Rules:**

- Subject line: imperative mood, lowercase, no period, max 72 characters
- Body (optional): explain *why*, not *what* - the diff shows the what
- One logical change per commit - don't mix features with formatting

### 5. Open a pull request

- Target branch: `main`
- Title: follows the same Conventional Commits format as your commits
- Description: explain what the PR does, why, and link the related issue (`Closes #123`)
- Keep PRs focused - one feature or fix per PR

**On size.** "One feature" is not a line count, but a branch carrying several
independent decisions is hard to land as one thing: a single objection holds up
all of it. If your branch contains something that would still make sense on its
own - a fix to an unrelated module, a refactor you needed along the way, a new
dependency - open that separately and first. It lands in days instead of waiting
on the review of everything around it.

**On migrations.** Take the next free number in the `MIGRATIONS` array and expect
it to change. Two open PRs regularly claim the same one. The maintainer renumbers
yours as it lands, which does not break the append-only rule: that rule protects
migrations that have shipped, not one that is still in review.

**Before opening:**

```bash
npm test              # All tests pass
```

### 6. Review and merge

PRs are reviewed by the maintainer. Expect feedback within a few days. Same-repo PRs
additionally get an automated AI review comment (Claude Code) shortly after opening, and
mentioning `@claude` in an issue or PR comment triggers an AI assistant. Their findings are
informational; the maintainer's review decides. PRs from forks are excluded from the
automation. Once approved, PRs are merged by the maintainer, usually squashed into a
single commit.

**If your PR goes stale, that is the maintainer's problem before it is yours.**
`main` moves faster than a review cycle, so who cleans up follows from what caused
the mess, not from who has time:

- **Mechanical, and the maintainer resolves it:** rebases onto a moved `main`,
  `CHANGELOG.md` collisions, the version line, `sw.js`, migration numbering, test
  script entries in `package.json`. These exist because this project releases
  often. You did not create them, and you are not expected to keep chasing them.
- **Substantive, and it stays with you:** anything that is a decision inside your
  feature. Which tables it adds, what it names things, whether a dependency earns
  its weight, how it behaves at the edges. Nobody can answer these for you without
  guessing.

Two things follow from that, and both are promises rather than requests:

**Rebase once, after the review, not before.** Rebasing while a review is open
means doing it twice. Wait for the findings, fix them, rebase then. If a PR has
gone so far out of date that the review itself is blocked, the maintainer says so
and does that rebase.

**An open architecture question never blocks your PR.** If a design decision comes
up that is really about the project's direction, the maintainer decides it, or the
PR lands without it. This is written down because it went the other way once:
[#621](https://github.com/ulsklyc/yuvomi/pull/621) was parked on a question its
author could not answer alone, and the contribution died waiting.

**A red `claude-review` check is not a review finding.** Open the job and read which step
failed first - the job goes red for ordinary reasons too (checkout, the action itself, a
GitHub API call), and only one specific failure is about the review staying silent.

That one is the step **"Die Review muss gesprochen haben"**. It exists because for five PRs
the check was green over a review that never happened. Its message says what it saw - refused
tools, a run that stopped at the plugin's own gate, agents it started but never waited for -
and is a lead for the job log, not a proven cause: a run can hit a refusal on the way and still
stop for another reason. The log shows every tool call because `show_full_output` stays on, and
that setting is not only for reading: the step needs the same stream to find the comment the
run posted. The exact rules - including every case in which the review is skipped or silence
stays green - live in `.github/workflows/claude-code-review.yml` and
`.github/scripts/review-verdict.mjs`, and are not repeated here.

**Do not add the tool in the PR that failed.** A PR touching
`.github/workflows/claude-code-review.yml` makes the action skip itself (it only runs when
the workflow matches the default branch) and makes this check stand aside, so it would turn
green without any review having run. Report the denied tool instead and let a maintainer add
it to `claude_args` on `main` - note that the allowed list there **replaces** the review
plugin's own, so existing entries have to stay, and that a second list denies the write forms
of the read-only commands it allows.

Once that has landed, **"Re-run jobs" on the old run will not pick it up.** A rerun replays
the same workflow file at the same commit, so it hits the same denial and looks like the fix
failed. The PR needs a fresh `pull_request` event to be evaluated against the new default
branch: push to it, or merge `main` into the branch, or close and reopen it. A rerun does help
when the refusal came from the path the review happened to take - reading earlier comments one
way rather than another - because the next run may take a different one.

**A later push is reviewed again.** The review does not stop because it already commented on
an earlier push of the same PR: the workflow's prompt lifts that condition on purpose, since a
green check over an unreviewed push is worse than a second review. A run that stops with
"already reviewed this PR" has not reviewed the push it was started for, and the check turns red
unless it finds that the push was reviewed some other way - also when that push only merged
`main` into the branch.

**If the maintainer stops.** There is one maintainer and no succession arrangement: nobody
acquires rights to this repository automatically, and none are needed, because the MIT
licence already allows any fork at any time. What this paragraph adds is the name. If this
repository goes a full year without a release, a commit or a reply from the maintainer,
treat it as unmaintained, fork it, and carry the Yuvomi name with you. Your own installation
is not affected either way; the README's "Before you commit" says why. The release steps are
written down in [docs/RELEASING.md](docs/RELEASING.md), so a fork can cut its first release
without this repository's private tooling.

---

## Code Conventions

### General

- ES modules everywhere (`import`/`export`, never `require`)
- Semicolons: **yes**
- `try/catch` in every route handler - no unhandled promise rejections
- No dynamic code execution. Never write user data directly into an HTML string - use `esc()` from `public/utils/html.js` in template literals, or DOM API (`createElement`, `textContent`). Use `insertAdjacentHTML` to append HTML fragments, `replaceChildren()` to replace content. Direct `innerHTML` assignments are rejected by the frontend audit (`npm run test:frontend-audit`), which runs as part of `npm test`.
- Hyphens, not dashes: write `-`, never `—` or `–`. This holds for text people read rather than execute: the READMEs, the CHANGELOG, commit messages, UI strings and locale values. `npm run test:readme-consistency` enforces it for `README.md` and `README.de.md`; everywhere else it is on you. Existing code comments on `main` are inconsistent about this and are deliberately left alone, so `git grep` is not a reliable guide here.

### Frontend

- Web Component prefix: `yuvomi-` (one component per file)
- All UI text via i18n keys (`t('key')`) - never hardcode text in components. German (`de`) is the reference locale.
- **Adding a new i18n key:** add it to **all** files in `public/locales/` (24 languages; a
  non-German value may start as the English text). The JSON files are 4-space indented
  and nested - edit them in place, never reserialize a whole file. A key interpolating a
  numeric `count` needs an `_one` singular variant (`{{count}}` placeholder), otherwise
  the UI shows "1 Aufgaben". `npm run test:i18n` and `npm run test:i18n-plural` guard all
  of this and run in CI - a UI change without complete locales will not pass.
- Date format: `DD.MM.YYYY` - Time format: `HH:MM` (24h)
- CSS uses design tokens from `public/styles/tokens.css` - never hardcode values
- Pages export a `render()` function, no side effects on import

### Page layout

These rules decide how a page is shaped, and until now they were only written down where
contributors could not see them. They are enforced by `npm run test:frontend-audit`, which is the
authority - this section describes what those guards check, it does not replace them.

- **One reading measure per page, and it hangs on the page.** A page declares its width role
  (`page-measure--narrow` and friends), which sets `--page-measure`; carriers like `.list-group`
  read that variable instead of carrying a width of their own. A carrier that sets its own width
  makes the page's measure a suggestion.
- **The clearance under fixed shell surfaces belongs to whatever actually scrolls.** The app has two
  architectures: some pages set `overflow: hidden` on their root and bring an inner scroller, the
  rest scrolls `.app-content`. A page that brings its own marks it `page-scrollport`, and the
  clearance for FAB, bulk-action pill and install banner rides there rather than on the shell - put
  it on the shell in the first architecture and it shortens the module's reference height instead of
  sitting at the end of the content. A scrollport announces its bottom padding as `--scrollport-pad`
  instead of setting `padding-bottom` itself, and the third value of a `padding` shorthand is
  rejected there: that is exactly how one leftover FAB reserve survived a cleanup unnoticed.
- **No inline width, alignment or margin on a scroller.** An inline value beats every rule in the
  stylesheet, including the ones that keep pages consistent, so the guard rejects it outright.
- **A settings leaf shows the leaf title once.** The shell already prints it above; a heading that
  repeats it is a heading without a statement (`npm run test:typography`).
- **The router loads exactly one page stylesheet per route** (`/styles/<module>.css`). The
  consequence matters more than the rule: styles for a shared component must be linked globally, or
  they fall back to browser defaults the moment that component appears on another page - often black
  in dark mode. A module opened from outside its own page has to ensure its stylesheet itself and
  wait for it.
- **Design values come from tokens** (`public/styles/tokens.css`) - no raw hex, `rgb()`, `rem` or
  `px` where a token exists.

If a change needs an exception, say so in the pull request and give it a reason that would still
convince somebody six months from now. Exceptions that outlive their reason are how a layout system
stops being one.

### Backend

- One route file per module in `server/routes/`
- API responses: `{ data: ... }` on success, `{ error: string, code: number }` on failure
- Database migrations: append to the `MIGRATIONS` array in `server/db.js` - **never modify existing entries**
- New entity tables: `id INTEGER PRIMARY KEY`, `created_at TEXT`, `updated_at TEXT` (ISO 8601). Key/value and join tables (`sync_config`, `task_tags`, …) deviate deliberately
- Any server-side fetch of a URL stored from user/admin input (WebDAV targets, ICS feed URLs, subscription logos, recipe provider `base_url`s, ...) goes through `server/utils/ssrf.js` (`isBlockedAddress`/`createGuardedLookup`), not a bare `fetch()`. This is one classifier so DNS-rebinding and private-network edge cases aren't reimplemented per subsystem; `npm run test:ssrf` pins both the classification logic and which known modules actually call it, and runs as part of `npm test`.

### Testing

- One test file per module in the `test/` directory (`test/test-[module].js`)
- Tests use in-memory SQLite via `--experimental-sqlite`
- Import route handlers directly - no HTTP calls, no running server

---

## Changelog

User-facing changes should be reflected in [`CHANGELOG.md`](CHANGELOG.md). If your PR adds a feature, fixes a bug, or changes behavior, add an entry under `[Unreleased]` in the appropriate category (`Added`, `Changed`, `Fixed`, `Removed`, `Security`).

**Every entry opens with a bolded sentence naming the change.** Prose about the reasoning is welcome underneath it - this file says *why* things were decided the way they were, and that is not written down anywhere else. But somebody who just updated wants to know what changed without reading three paragraphs to find out. The first line answers that; everything after it is for whoever wants the story.

```markdown
### Added
- **Budget entries can be imported from CSV.** The importer maps columns by
  header name rather than by position, because an export from a bank rarely
  puts them in the same order twice ...
```

`npm run test:changelog` enforces the bolded lead-in for `[Unreleased]` and every version from 2.41.0 on. Earlier entries are left as they are: a published changelog does not get rewritten.

Otherwise: user-oriented language, and `-` rather than `—` or `–`. An entry does not stay in this file - it ships as the GitHub release notes and feeds the app store listings.

---

## Release cadence

Yuvomi releases on two tracks. The rule exists because of [#496](https://github.com/ulsklyc/yuvomi/discussions/496): between 13 August and 2 September 2026 there were 92 releases across 19 active days, and **72 of them changed the interface** - roughly three and a half times a day. The complaint was never "too many tags". It was that somebody learning the app watched it move while they were still learning it.

So the limit is on the interface, not on the release count:

| Track | What it carries | When it ships |
|---|---|---|
| **Interface train** | Anything under `public/pages/`, `public/styles/`, `public/utils/`, `public/components/`, `public/settings/` | **Wednesdays and Sundays only** |
| **Everything else** | Server, database, docs, tests, deploy descriptors, translations | Any day, **at most one release per calendar day** |

Two fixed days, since 12 September 2026 (until then the train ran on Tuesdays only). A finished interface change waits at most four days for its train instead of a week, and the interface still moves on two known days rather than whenever something happens to be done.

**Security fixes and data-loss bugs are not held back.** They ship the moment they are ready, on any day. Since v2.64.1 (4 September 2026) a security fix ships as a **patch release cut from the last tag**, carrying the fix, its tests and its documentation and nothing else: the guard judges the whole diff since the last tag, and a branch off that tag is on the second track by construction, so the interface work waiting on `main` for its train is not pulled forward with it. The steps are in [docs/RELEASING.md](docs/RELEASING.md); the `--hotfix` escape hatch below remains for a fix that cannot be separated from what is already on `main`.

`npm run check:release-cadence` decides this, and it runs before the tag rather than after. A release that carries interface changes on a Thursday fails it; so does a second same-day release on the other track. The escape hatch is `--hotfix "<reason>"`, and the reason is mandatory and printed - an exception nobody has to write down is just a rule that quietly stopped applying.

This is a promise the project can keep because it is not a promise: it is a condition that has to pass. That distinction is the whole point. A cadence held by good intentions erodes without anyone noticing except the people who reported the problem.

### The pre-release handrail

`npm run test:document-guards` is the one suite that is deliberately not in `npm test` and not in CI. It drives a real browser against a seeded server and costs around 80 minutes (82 measured on 2 September 2026), which is not a price worth paying on every push for invariants that only change in bursts. It is a handrail run once before a release instead.

**It is required for any release that carries the interface train**, that is, any release whose diff touches `public/pages`, `public/styles`, `public/utils`, `public/components` or `public/settings`. A release on the other track does not need it: those probes measure the rendered document, and a change that never reaches the document cannot move them.

Treat the path list as a heuristic rather than a boundary. What the probes see also depends on how full the test instance is, and that comes from `scripts/seed-demo.js` and from the shape of server responses: a fuller instance makes header filters wider. If you change the seed or a response shape substantially, run the handrail even when no interface path is in your diff.

Every probe starts from the same state ([#1104](https://github.com/ulsklyc/yuvomi/issues/1104)). Before each probe the harness opens a fresh browser context and restarts the server on a snapshot taken after seeding and signing in, so nothing carries over from one probe to the next: not the API rate limit, not rows a probe created and never cleaned up, not its browser storage. A targeted run (`--test-name-pattern`) therefore measures the same preconditions as the full run. The other side of that is deliberate: a probe no longer sees what earlier probes left behind, so a probe that needs a fuller instance gets it from the seed, where every run has the same data.

Read its exit code from a file, never from a pipe:

```bash
npm run test:document-guards > /tmp/dg.log 2>&1; echo $?
```

A `| tail` reports the status of `tail`, not of the run. That is not a hypothetical: v2.64.0 shipped on 2 September without this handrail because the step lived only in `docs/test-suites.md` and not in the release checklist anyone actually followed.

---

## AI Assistance

Asked for in [#687](https://github.com/ulsklyc/yuvomi/discussions/687). Yuvomi holds a household's calendar, health notes, documents and finances, so it is fair to ask who - or what - wrote the code that handles them.

### How this project is built

**AI coding agents are used here, extensively and openly.** Much of the code in this repository was drafted with them. Two of them also review pull requests automatically, and you will see their comments on yours: a Claude Code workflow and an OpenAI Codex connector.

That is worth stating plainly rather than leaving to inference. An automated review comment on your PR is not a maintainer's verdict; it is a second pair of eyes with no authority to merge anything.

### What a human guarantees

**Nothing reaches `main` without a human deciding that it should.** Every merge in this repository is performed by the maintainer, including automated dependency updates and contributions from others. There is no path by which an agent merges its own work.

Beyond that decision, three things are mechanical and hold for every change regardless of who or what wrote it:

- The full test suite runs on every pull request, and a red build is not merged.
- The [Hard Constraints](#hard-constraints) above are enforced by tests, not by good intentions - a framework import or an `innerHTML` call fails the build.
- Behaviour that is claimed to be fixed carries a test that fails against the state before the fix. A guard that was never seen red is not evidence.

**On "a human has read and understood every merged line":** for a one-person project shipping several releases a week, that sentence would be a promise nobody could keep, and a promise that cannot be kept is worse than none - it invites exactly the trust it does not earn. What is true instead: the maintainer reviews every change before merging it, decides whether it goes in, and is answerable for it either way. Where a change touches something sensitive - authentication, permissions, storage, anything reaching the network - that review goes line by line.

### If you contribute

**Say so if an agent wrote it.** One line in the PR description is enough ("drafted with Claude Code", "Copilot-assisted"). It is not a mark against the contribution and it will not slow the review down.

The reason is practical rather than moral: it tells the reviewer where to look. Generated code fails in different places than hand-written code does - plausible-looking APIs that do not exist, tests that assert what the implementation happens to do rather than what it should, an edge case handled in the comment but not in the branch. Knowing to check for that is worth more than any policy about it.

What is expected of the contribution itself does not change: you understand what you are submitting, you can explain why it works, and you can answer questions about it in review. If you cannot, the tool you used is not the problem.

---

## Reporting Issues

### Bugs

[Open an issue](https://github.com/ulsklyc/yuvomi/issues/new/choose) with:

- What you expected vs. what happened
- Steps to reproduce
- Environment (browser, OS, Docker version if relevant)
- Screenshots if applicable

### Feature requests

Describe the **use case** before proposing a solution. There might be a simpler approach that fits the existing architecture.

Features that conflict with the project's [hard constraints](#hard-constraints) or significantly expand scope will likely be declined. Some of those boundaries come up often enough to be written down rather than re-argued - read [what Yuvomi will not become](docs/SCOPE.md) before proposing an integration with an external service, and [the decisions made once](docs/DECISIONS.md) before proposing a change to how privacy or permissions work. When in doubt, ask first.

### Security vulnerabilities

Do **not** open a public issue. Use [GitHub Private Vulnerability Reporting](https://github.com/ulsklyc/yuvomi/security/advisories/new) instead. See [`SECURITY.md`](SECURITY.md) for details.

---

## Questions?

If something in this guide is unclear or you're unsure whether a contribution fits, open a thread in [Discussions](https://github.com/ulsklyc/yuvomi/discussions) or comment on the relevant issue. We're happy to help.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
