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
npm run test:dashboard
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

Tests run with plain Node and in-memory SQLite (`--experimental-sqlite`) — newer suites
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

Rebase before opening a PR and keep the branch conflict-free.

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

**Before opening:**

```bash
npm test              # All tests pass
```

### 6. Review and merge

PRs are reviewed by the maintainer. Expect feedback within a few days. Same-repo PRs
additionally get an automated AI review comment (Claude Code) shortly after opening, and
mentioning `@claude` in an issue or PR comment triggers an AI assistant — both are
informational; the maintainer's review decides. PRs from forks are excluded from the
automation. Once approved, PRs are merged by the maintainer, usually squashed into a
single commit.

---

## Code Conventions

### General

- ES modules everywhere (`import`/`export`, never `require`)
- Semicolons: **yes**
- `try/catch` in every route handler - no unhandled promise rejections
- No dynamic code execution. Never write user data directly into an HTML string — use `esc()` from `public/utils/html.js` in template literals, or DOM API (`createElement`, `textContent`). Use `insertAdjacentHTML` to append HTML fragments, `replaceChildren()` to replace content. Direct `innerHTML` assignments are rejected by the frontend audit (`npm run test:frontend-audit`), which runs as part of `npm test`.

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

Format: imperative mood, one line per change, user-oriented language.

```markdown
### Added
- Add CSV import for budget entries
```

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

Features that conflict with the project's [hard constraints](#hard-constraints) or significantly expand scope will likely be declined. When in doubt, ask first.

### Security vulnerabilities

Do **not** open a public issue. Use [GitHub Private Vulnerability Reporting](https://github.com/ulsklyc/yuvomi/security/advisories/new) instead. See [`SECURITY.md`](SECURITY.md) for details.

---

## Questions?

If something in this guide is unclear or you're unsure whether a contribution fits, open a thread in [Discussions](https://github.com/ulsklyc/yuvomi/discussions) or comment on the relevant issue. We're happy to help.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
