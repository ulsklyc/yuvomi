# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Make the weather widget follow the app language, support city IDs, and key its cache per city/units/language.
- Fix janky, laggy scrolling in tall modals (e.g. the event editor) caused by a backdrop-filter on the scroll container.

### Changed
- Scope icon re-rendering to changed subtrees and index calendar day lookups for smoother large lists and month views.
- Debounce the documents and split-expenses search inputs.
- Add database indexes for event/task assignment, loan-payment, and recurring-event lookups.
- Batch split-expense detail loads to remove an N+1 query and sort dashboard tasks in SQL.

## [0.57.6] - 2026-06-03

### Fixed
- Unraid Community Apps template: the Overview section incorrectly told new users to "open the WebUI and create your admin account." Oikos has no web-based first-run signup — the first admin is created via `node setup.js` in the container Console, as documented in the README and installation guide. The template now matches the actual bootstrap flow.

## [0.57.5] - 2026-06-03

### Fixed
- Google Calendar sync: all-day events imported from Google no longer show an extra day. Google Calendar stores exclusive end dates per RFC 5545 (a 2-day event Jan 1–2 has `end.date = "2026-01-03"`); Oikos was storing this value as-is, making every multi-day event appear one day longer than it actually is.
- Google Calendar sync: recurring events with an end date no longer fail to sync to Google with "Invalid recurrence rule." The outbound mapping was sending the recurrence rule without the required `RRULE:` prefix, which Google's API rejects. Both the missing prefix and the incorrect (non-exclusive) all-day end date in the outbound payload are now fixed.

## [0.57.4] - 2026-06-02

### Changed
- Refined the Unraid Community Apps template: the `Registry` link now points to the browsable GitHub Container Registry package page, and added `ExtraSearchTerms` so Oikos is easier to find in the Community Apps store.

## [0.57.3] - 2026-06-02

### Fixed
- Login page now stays centered on desktop browsers. Before the first login no sidebar exists, but at viewports ≥1024px the app shell still switched to its sidebar row layout, which collapsed the sidebar-less login wrapper to its content width and pinned it to the left — making the desktop login look like the mobile layout. The shell now stays in column flow while the login page is mounted, so the form is fully centered again.

## [0.57.2] - 2026-06-02

### Changed
- Moved all `test-*.js` suites from the project root into a dedicated `test/` directory and updated every reference (npm `test:*` scripts, the browser test loader, and test imports of app and root files). No runtime or user-facing behaviour changes; `npm test` is unchanged.

## [0.57.1] - 2026-06-02

### Changed
- Updated `openid-client` to v6. This is an internal rewrite of the OIDC/SSO implementation; the four `OIDC_*` environment variables and the login flow are unchanged (the client-secret token-endpoint authentication method is preserved). Minor bumps to `googleapis` and `puppeteer`.

### Security
- Resolved a transitive denial-of-service advisory in the `qs` dependency (GHSA-q8mj-m7cp-5q26).

## [0.57.0] - 2026-06-02

### Added
- The CLI installer (`install.sh`) is now fully localized into all 16 supported languages, matching the web installer. It auto-detects the language from the shell environment (`OIKOS_INSTALLER_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG`) and accepts a `--lang <code>` override. Translations live in per-language `tools/installer/locales/cli/<lang>.sh` files — `en` is the fallback base, the active language overlays it.

## [0.56.0] - 2026-06-02

### Added
- Podman support for RHEL-based distributions (RHEL, Fedora, CentOS Stream, Rocky, Alma): a dedicated `podman-compose.yml` adds the SELinux `:Z` volume relabel so rootless containers can access their data, and exposes a configurable `OIKOS_HTTP_BIND` host bind address (default `0.0.0.0`).
- `tools/quadlet/oikos.container` — a systemd Quadlet unit for rootless Podman autostart, with `EnvironmentFile`, `:Z` volumes, the same healthcheck as Compose, and boot persistence via `loginctl enable-linger`.
- Both the web installer and the CLI installer now auto-detect the container engine, preferring Docker and falling back to `podman compose` (Podman 4.1+) or `podman-compose`.

### Changed
- Web and CLI installers route every container command (start, inspect, logs, prerequisite checks) through the detected engine instead of a hard-coded `docker`; with Podman they use `podman-compose.yml` automatically.
- Documentation (README, installation guide, SPEC, MODULES, installer README, and the GitHub Pages landing/install pages) now covers the Podman/SELinux install path, the new `OIKOS_HTTP_BIND` variable, and rootless systemd autostart.

## [0.55.19] - 2026-06-02

### Added
- Installer wizard is fully localized into all 16 supported languages with automatic browser-language detection, via its own `tools/installer/locales/*.json` and `i18n-mini.js` (mirrors the app's locale resolution; `de` is the reference, `en` the fallback).
- New optional "Advanced" installer step covering reverse-proxy/HTTPS deployments (sets `SESSION_SECURE`/`TRUST_PROXY`), Single Sign-On (OIDC), and automatic backups — all configurable without hand-editing `.env`.
- Installer verifies Docker prerequisites before the wizard starts and surfaces container start/spawn errors in the UI instead of failing silently.
- `GET /api/preflight` reports whether an existing `.env` file and a running `oikos` container are present.

### Changed
- Installer adopts the app's design language: shared design tokens and Plus Jakarta Sans (violet accent, matching radii/shadows, automatic dark mode), served read-only from the repo.
- Installer wizard now meets WCAG 2.1 AA — keyboard-operable accordion buttons (`aria-expanded`/`aria-controls`), `role="alert"` error banners, a live `role="status"` Docker-status region, focus moved to the active step heading on navigation, labelled password-visibility toggles, a step counter derived from the step list, and a unified error-banner style.
- `docker-compose.yml` maps the chosen host port (`${OIKOS_HTTP_PORT:-3000}:3000`) and derives `SESSION_SECURE` from `.env` (`${SESSION_SECURE:-false}`), so reverse-proxy setups take effect without manual edits; default `3000`/`false` behaviour is unchanged.

### Fixed
- Installer persists the user-selected timezone (`TZ`) and HTTP port (`OIKOS_HTTP_PORT`) to `.env` so the choices actually take effect; `install.sh` gains the same fields for CLI parity.
- Installer backs up an existing `.env` to `.env.bak-<ISO>` before overwriting, so re-runs no longer destroy an existing configuration; `install.sh` does the same.

### Security
- Hardened installer `.env` writing against injection: keys are allowlisted against the shared env schema and values containing newlines are rejected.

## [0.55.18] - 2026-06-02

### Changed
- Installer env configuration extracted into a shared `tools/installer/env-schema.js` module (`ENV_SCHEMA`). Adds `TZ` and `OIKOS_HTTP_PORT` fields (both with `writeToEnv: true`) and a `group` field per entry. `GET /api/defaults` now serves `ENV_SCHEMA` directly; existing UI behaviour is unchanged.

## [0.55.17] - 2026-06-02

### Changed
- **Documentation synced with changelog v0.45.0–v0.55.16:** `SPEC.md` adds `oidc_sub`/`oidc_provider` columns to the Users table and documents the SSO login flow (Authorization Code + PKCE, nonce) and failed-login warning logging; `docs/installation.md` adds `TRUST_PROXY` to the Server section, `DATA_DIR`/`BACKUP_DIR` to the Database section, a new SSO/OIDC env-var section, a new Automated Backups env-var section, and a legacy note on the Apple CalDAV single-account variables; `README.md` adds SSO/OpenID Connect to the Design & Technology section; `docs/index.html` updates the version badge and footer to v0.55.16 and corrects the birthday feature description to mention customizable reminders; `docs/install.html` updates the Calendar Sync optional card to reflect multi-account CalDAV/CardDAV, adds an SSO/OIDC optional card, updates the Automated Backups card to describe the built-in scheduler, and keeps EN and DE i18n strings in sync.

## [0.55.16] - 2026-06-02

### Fixed
- `TRUST_PROXY` environment variable is now parsed correctly: numeric values like `1` are treated as a hop count (not an IP address), so `req.ip` returns the real client IP when running behind a reverse proxy such as Traefik or nginx. Subnet strings (e.g. `172.16.0.0/12`) and named values (`loopback`) continue to work as before.
- `.env.example` documents `TRUST_PROXY` with examples for Traefik/Docker setups.

## [0.55.15] - 2026-06-01

### Fixed
- Failed login attempts are now logged as warnings with IP address, username, and failure reason (`user_not_found` or `invalid_password`), enabling fail2ban/CrowdSec integration.

## [0.55.14] - 2026-06-01

### Added
- OIDC/SSO single sign-on support via any OpenID Connect provider (Authentik, Keycloak, Google, etc.), configurable through four environment variables (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`).
- Authorization Code flow with PKCE (S256) and nonce for secure SSO; state, nonce, and code verifier are stored in the session and consumed once.
- Login page shows an "Sign in with SSO" button only when OIDC is configured; displays a localised error message on failed SSO attempts.
- Database migration v42 adds `oidc_sub` and `oidc_provider` columns to the `users` table with a partial unique index.
- SSO i18n keys (`loginWithSso`, `orDivider`, `ssoError`) added to all 16 supported locales.

## [0.55.13] - 2026-06-01

### Fixed
- Fixed Polish locale offline availability by including `pl.json` in the service worker locale precache and expanded frontend locale audits to cover dynamic keys, `labelKey` usage, and `data-i18n` attributes.

## [0.55.12] - 2026-06-01

### Fixed
- Fixed unresolved frontend translation keys so the PWA install prompt and other UI labels render localized text instead of raw key names.

## [0.55.11] - 2026-06-01

### Changed
- **Documentation refreshed for the completed frontend UI/UX audit rollout:** Updated the README, GitHub Pages copy, product specification, audit notes, and landing-page design docs to reflect the stronger work surfaces, mobile ergonomics, stable Kitchen/More navigation identity, Calendar readability improvements, Settings information architecture, and current release version.

## [0.55.10] - 2026-06-01

### Changed
- **Frontend UI/UX audit rollout completed:** Refined the visual foundation with stronger work surfaces and quieter Liquid Glass treatment, improved mobile dashboard readability, consolidated dense Tasks and Shopping controls, and kept Kitchen/More navigation identity stable across desktop and mobile.
- **Calendar readability improved across views:** Month cells now have clearer boundaries, today emphasis, stronger event/task chips, readable agenda rows, tokenized all-day labels, and Lucide metadata icons instead of visible emoji markers.
- **Settings information architecture tightened:** Added a sticky desktop settings navigation, mobile tab scroll affordances, keyboard-friendly shared sub-tabs, and accented cards for major admin, account, family, API token, and backup sections.
- **Final accessibility and localization polish added:** Replaced remaining inline icon sizing in touched Calendar and Budget actions, kept Budget row actions touch-visible on mobile, improved More sheet focus restoration after navigation, and added regression coverage for locale key consistency.

## [0.55.9] - 2026-06-01

### Changed
- **Navigation identity and icon language tightened:** Kept Kitchen and More bottom-nav labels stable while exposing active subsections through localized accessible labels, replaced isolated inline SVG/icon sizing with Lucide placeholders and icon utility classes in the touched navigation, Kitchen, Shopping, and Settings surfaces, and added More active labels across all locales.

## [0.55.8] - 2026-06-01

### Changed
- **Mobile task and shopping controls refined:** Collapsed secondary task toolbar controls into a compact mobile overflow, kept bulk actions hidden until tasks are selected, and rebuilt the shopping quick-add row for clearer 390px touch ergonomics.

## [0.55.7] - 2026-05-31

### Fixed
- **Mobile dashboard readability improved:** Prevented first-viewport dashboard highlights from splitting German words mid-word, widened mobile cockpit cards, reserved space for the fixed FAB, and kept compact quick actions accessible.

## [0.55.6] - 2026-05-30

### Changed
- **Landing page feature showcase extended with Budget and Shopping rows:** Added two new alternating screenshot rows to `docs/index.html` — "No surprise at the end of the month." (Budget) and "The list everyone actually checks." (Shopping) — each with desktop and mobile screenshots. Both EN and DE locales included.

## [0.55.5] - 2026-05-30

### Changed
- **GitHub Pages landing page redesigned as a narrative marketing page:** Restructured `docs/index.html` from a feature-list into a problem→trust→solution flow targeting privacy-conscious families. Added Social Proof Bar (live GitHub star count, module count, language count, version), new "The Problem" section with three pain-point cards, and moved the Philosophy section up and renamed it "Why Oikos" with reordered cards (Privacy First → Self-Hosted → Open Source → Zero Build Step). Rewrote Hero copy ("Your family. Your data. Your home."), Feature-Showcase titles as benefit statements, and Feature-Grid trimmed to five priority cards. Simplified Setup section with a three-step visual overview and collapsible Docker command block. Updated CTA to three differentiated buttons (Get started, See all screenshots, View on GitHub). Added version, star count, and Install link to Footer. Both EN and DE locales updated throughout.

## [0.55.4] - 2026-05-30

### Changed
- **README redesigned as a professional landing page:** Replaced the dense feature table with a compact two-column module grid, promoted the desktop screenshot to a large hero image (800 px, dark/light adaptive), added a CTA row (Install · Screenshots · Docs) below the badges, refined the tagline to "The self-hosted family planner. Private, offline-capable, and beautiful.", added horizontal-rule section separators for visual rhythm, and replaced the Documentation pipe-table with an inline link row.

## [0.55.3] - 2026-05-30

### Changed
- **SPEC updated to v0.55.2:** Documents the Phase 7 Living Drifting Backdrop (`.lg-backdrop`, `--lg-*` tokens), Enter-submits-modal convention, modal state machine, and budget chart screen-reader summary. Version reference updated to v0.55.2.
- **awesome-selfhosted description updated:** Now reflects CalDAV/CardDAV multi-account sync, split expenses, and housekeeping module.

## [0.55.2] - 2026-05-30

### Fixed
- **Mobile screenshots no longer have a gray bar at the bottom:** The screenshot script now uses a proportionally larger viewport (459×993) instead of CSS `zoom: 0.85` on the root element. CSS zoom shrinks content below the viewport height, leaving an empty gray strip; the larger viewport lets the app fill the frame naturally while still showing the equivalent of 85%-zoomed content.

## [0.55.1] - 2026-05-30

### Fixed
- **Kitchen pages no longer drift under the tab bar while scrolling:** The meal planner and recipes pages did not subtract the kitchen tab bar height from their viewport height, so the outer scroll container overflowed by exactly the tab bar height. On desktop this made the whole page (week navigation and the day header row, e.g. "MO") drift upward while scrolling instead of only the inner content. Both pages now reduce their height by the tab bar height, matching the shopping page, so only the inner grid scrolls and the day headers stick correctly.

## [0.55.0] - 2026-05-29

### Added
- **Screen-reader summary for the budget category chart:** The category bar chart now exposes a concise `.sr-only` summary (number of categories plus the largest category and its share) so assistive technologies can convey the data without parsing the purely visual bars.

### Changed
- **Enter submits modal forms:** Pressing Enter in a single-line field inside a modal now submits the form (the standard web convention) instead of advancing focus to the next field.
- **More robust modal lifecycle:** Reworked the shared modal into an explicit state machine (idle/open/confirming/closing) with encapsulated suspend/restore helpers, hardening the unsaved-changes confirmation against double-close and back-navigation races. Behavior is otherwise unchanged.

### Security
- **Escaped modal titles and option labels:** Modal titles, `selectModal` option labels, and `promptModal` default values are now centrally HTML-escaped, closing an XSS vector where raw user-supplied text (e.g. a task title reused as a modal heading) was injected unescaped.

## [0.54.12] - 2026-05-29

### Added
- **UI/UX audit (May 2026):** Added `docs/UI-UX-AUDIT-2026-05.md` documenting a full review across mobile/desktop and light/dark mode with prioritized findings.

### Fixed
- **PWA theme color mismatched the app accent:** The light-mode `theme-color` meta tag was a stale indigo (`#4F46E5`) while the actual app accent is violet (`#6c3aed`), so the installed PWA's status/address bar rendered a different hue than the UI. Aligned `theme-color` to the brand accent.
- **Login page could overflow horizontally on desktop:** The login screen used `width: 100vw`, which includes the scrollbar width and produced a horizontal scrollbar / clipped edge whenever a vertical scrollbar was present. Switched to `width: 100%`.
- **Sub-12px UI text raised to the 12px readability floor:** The desktop sidebar version label, sidebar section headings, and the reminder count badge still used a 10px font size, below the project's own 12px minimum. Raised them to 12px and aligned the reminder badge box to 18px to match the standard nav badge.

## [0.54.11] - 2026-05-29

### Fixed
- **Calendar – unreadable time-axis labels:** The week and day view time-axis labels used the disabled-text token (`--color-text-disabled`), which fell far below the WCAG AA 4.5:1 contrast ratio against the grid background (~1.2:1 in light mode, ~1.5:1 in dark mode). Switched to `--color-text-tertiary` for legible, AA-compliant times in both themes.
- **Navigation – "Household" section label showed a raw key:** The desktop sidebar section heading rendered as `NAV.SECTION.HOUSEHOLD` instead of the translated label. The locale key was stored as a flat `"section.household"` string inside `nav`, but `t()` resolves dot-paths as nested objects, so it never matched and fell back to the (uppercased) key. Restructured the key to a nested `nav.section.household` object across all 16 locales.
- **Meal plan & list headers scrolled under glass cards:** Sticky section headers in the meal plan (`.day-header`), calendar agenda (`.agenda-day__header`), and contacts list (`.contact-group__header`) sat on the base z-layer (`--z-base`), so translucent Liquid Glass cards rendered above them while scrolling. Raised them to `--z-sticky` so they stay on top.

## [0.54.10] - 2026-05-29

### Added
- **Liquid Glass – living drifting backdrop:** Added a `.lg-backdrop` layer with four blurred, slowly drifting color blobs behind the entire app shell — the "liquid" that the glass surfaces now refract. Blob 1 follows `--active-module-accent`, so the whole ambient subtly recolors per section (e.g. violet on Calendar, teal on Budget), while blobs 2–4 use fixed module tints (shopping, tasks, meals) for variety. The blobs live on the non-scrolling `.app-shell` (outside the `.app-content` scroll container), so they neither trigger nor are affected by the iOS/Android blank-screen mitigation (Issue #166). The drift animation honors `prefers-reduced-motion` (freezes), and `prefers-reduced-transparency` / `prefers-contrast: more` hide the backdrop entirely via tokens.
- **Liquid Glass – design tokens:** Introduced five `--lg-*` tokens in `tokens.css` — `--lg-blob-opacity` (0.4 light / 0.55 dark, 0 in reduced-transparency/contrast), `--lg-glass-saturate`, `--lg-card-radius`, `--lg-density`, and `--lg-specular`.

### Changed
- **Liquid Glass – stronger specular on elevated surfaces:** The sidebar and bottom navigation now carry an inset top-highlight driven by `--lg-specular`, per the canonical glass recipe, giving the elevated glass panels a crisper specular edge.

### Changed
- **Calendar – week view time-slot click opens create-event modal:** Clicking an empty time slot in the week view time grid now opens the create-event modal again (reverts the day-view navigation introduced in v0.54.8). Navigating to the day view on time-slot clicks was too disruptive for users who intentionally tap a specific hour to create an event quickly.

## [0.54.8] - 2026-05-29

### Changed
- **Calendar – day navigation from month and week views:** Tapping a day cell in month view now navigates to the day view for that date instead of immediately opening the create-event modal. In week view, tapping a day header or an empty time-slot column likewise switches to the day view, allowing users to review the day's schedule before adding an event via the "+" button or by tapping a time slot in day view.

## [0.54.7] - 2026-05-29

### Fixed
- **Calendar – recurring event end time shifted by UTC offset:** When expanding recurring events server-side, `end_datetime` for each instance was computed via `.toISOString()`, which always appends a `Z` (UTC) suffix. Stored datetimes use no timezone marker (naive local-time strings), so browsers interpreted the `Z`-suffixed recurring instances as UTC — shifting displayed end times by the user's UTC offset (e.g. +2 h for UTC+2). The fix preserves the format of the original datetime: naive sources produce a timezone-free `YYYY-MM-DDTHH:MM` string; `Z`-suffixed sources (e.g. CalDAV imports) retain the ISO/UTC path.

## [0.54.6] - 2026-05-29

### Fixed
- **Calendar – event assignment for non-admin users:** The `GET /auth/users` endpoint previously required admin privileges, causing the assignee dropdown to silently render empty for child and other non-admin family profiles. Removed the unnecessary `requireAdmin` guard so all authenticated family members can load the user list and assign calendar events.

## [0.54.5] - 2026-05-28

### Changed
- **Liquid Glass – Documents & Split Expenses modules:** Migrated `documents.css` and `split-expenses.css` to Glass design tokens. Document folder browser (`.documents-folder-browser`), document cards (`.document-card`), document rows (`.document-row`), the drop zone (`.document-dropzone`) and its icon, the member picker (`.document-member-picker`), and the view toggle (`.documents-view-toggle`) all use `--glass-bg-card`, `--glass-border-subtle`, `--radius-glass-card`/`--radius-glass-inner`, and `--glass-shadow-*` tokens. Split summary cards (`.split-summary-card`) receive a subtle module-accent tint via `::after`. Split cards (`.split-card`), the groups panel (`.split-groups-panel`), group headers (`.split-group-header`), groups (`.split-group`), and participants (`.split-participants`) are migrated to corresponding Glass tokens. All `--shadow-*` → `--glass-shadow-*`, `--radius-md/lg` → `--radius-glass-card/inner/chip`, and `--color-surface` → `--glass-bg-card` replacements applied.

## [0.54.4] - 2026-05-28

### Changed
- **Liquid Glass – Meals & Recipes modules:** Migrated `meals.css` and `recipes.css` to Glass design tokens. The autocomplete dropdown (`.meal-modal__autocomplete`) now uses `--glass-bg-card`, `--glass-border-subtle`, `--radius-glass-inner`, and `--glass-shadow-md`. The drag-ghost card (`.meal-card--ghost`) uses `--glass-shadow-lg`. Ingredient rows (`.ingredient-row`) receive `--radius-glass-inner` for consistency. Recipe cards (`.recipe-card`) use `--radius-glass-card`, `--glass-bg-card`, `--glass-border-subtle`, and `--glass-shadow-sm`; a hover state adds `--glass-bg-card-hover` and `--glass-shadow-md`. Recipe ingredient rows (`.recipe-ingredient-row`) use `--radius-glass-inner`. `.meal-slot` was already migrated in `glass.css` §30 and is unchanged.

## [0.54.3] - 2026-05-28

### Changed
- **Liquid Glass – Housekeeping module:** Migrated `housekeeping.css` to Glass design tokens. Main cards (`.housekeeping-card`) use `--radius-glass-card`, `--glass-bg-card`, `--glass-border-subtle`, and `--glass-shadow-sm`. Inner elements (`.housekeeping-worker-strip`, `.housekeeping-metric`, `.housekeeping-task`, `.housekeeping-report-item`, `.housekeeping-staff-row`, `.housekeeping-staff-log-row`, `.housekeeping-template`, `.housekeeping-photo`, `.housekeeping-photo-preview`) use `--radius-glass-inner`. Interactive staff rows use `--glass-bg-card-hover` with module-accent tint on hover. The document-dropzone icon inside modals uses `--glass-shadow-sm`.

## [0.54.2] - 2026-05-28

### Changed
- **Liquid Glass – Settings module:** Migrated `settings.css` and `settings-nav.css` to Glass design tokens. Settings cards (`.settings-card`), CalDAV account items, module rows, and the settings sidebar now use `--glass-bg-card`, `--glass-bg-elevated`, `--radius-glass-card`/`--radius-glass-inner`, `--glass-border-subtle`, and `--glass-shadow-*` tokens. Interactive rows (`.toggle-row`, `.cat-row`, `.caldav-calendar-item`) use `--glass-bg-card-hover` on hover. Tooltips use `--glass-shadow-lg`. Sidebar navigation items use `--radius-glass-inner` with glass hover states.

## [0.54.1] - 2026-05-28

### Changed
- **Liquid Glass – Budget module:** Migrated `budget.css` to Glass design tokens. Summary cards (`.budget-summary-card`), the loans panel, individual loan cards, loan transactions, the loan report hero and grid cells, transaction entry hover states, and the inline modal panel now use `--glass-bg-card`, `--radius-glass-card`/`--radius-glass-inner`, `--glass-border-subtle`, and `--glass-shadow-*` tokens. Summary cards receive a subtle module-accent tint via `::after`. The overlay backdrop uses `--color-overlay-glass` instead of a hardcoded `rgba` value.

## [0.54.0] - 2026-05-28

### Added
- **Liquid Glass Navigation:** Sidebar and mobile bottom bar now feature a sliding glass pill indicator that animates to the active entry.
- **Custom nav icons:** `public/nav-icons.js` provides a full set of monoline SVG icons for all navigation entries, built entirely with the DOM API (`createElementNS`) — no `innerHTML`.
- **Desktop hover preview:** Hovering an inactive sidebar entry shows the destination indicator at 50 % opacity before navigation.
- **Household section label:** A "Haushalt" section heading appears between the four primary entries (Dashboard, Calendar, Tasks, Notes) and the module entries in the sidebar.
- **Locale key `nav.section.household`:** Added to all 16 supported locale files.
- **Accessibility:** Navigation animations are suppressed when `prefers-reduced-motion` is active; glass effects are disabled when `prefers-reduced-transparency` is active.
- Lucide icon fallback for any navigation entry that lacks a custom SVG.

## [0.53.1] - 2026-05-28

### Removed
- **pyAmortiza module:** Removed the bundled Brazilian mortgage calculator module from the repository; the module system remains fully functional for externally mounted modules.

### Fixed
- `isIOSInstallFlow()` no longer returns `true` when the app is already running in standalone (installed PWA) mode, restoring the invariant that `getPwaInstallState()` never yields `{installed: true, ios: true}` simultaneously.

## [0.53.0] - 2026-05-27

### Added
- **Module system:** Runtime-loadable third-party modules discovered from a configurable `modules/` directory. Each module declares metadata via `module.json` and is validated server-side before being served.
- **Admin module controls:** Admins can enable/disable individual modules and drag-to-reorder navigation entries in Settings → Modules.
- **Dynamic SPA routing:** Enabled module pages are registered automatically in the router at startup without any code changes to the host app.
- **Docker support:** Mount external modules via the `MODULES_DIR` environment variable.
- **Example module — pyamortiza:** Brazilian mortgage amortization calculator bundled as a reference module implementation.
- **PWA install utility:** `public/utils/pwa-install.js` centralises the install-prompt lifecycle; `oikos-install-prompt` component now imports from it.

### Fixed
- Toast notifications in Settings used the unsupported type `'error'`; corrected to `'danger'` in five call-sites (CardDAV and meal-types sections).
- `PUT /api/v1/preferences` now enforces an admin role check before processing `disabled_modules`; non-admin users receive a 403 response, preventing household-wide module changes.
- `disableFailedThirdPartyModule` now attempts the API call first; on a 403 (non-admin user) the module remains visible in navigation rather than being silently removed.

## [0.52.58] - 2026-05-27

### Added
- **Task chips in Calendar:** Open and in-progress tasks with a due date now appear as priority-coloured chips in all four calendar views (month, week, day, agenda). Clicking a chip navigates directly to the task edit modal. Tasks with a due time show the time in the chip label. Done and archived tasks are not shown.

## [0.52.57] - 2026-05-26

### Fixed
- Restored colored inactive icon wells for the mobile Kitchen and More navigation buttons.

## [0.52.56] - 2026-05-26

### Security
- Updated helmet from 8.1.0 to 8.2.0 (adds `noopener-allow-popups` support for Cross-Origin-Opener-Policy).
- Updated googleapis from 171.4.0 to 172.0.0 (optional dependency for Google Calendar sync; Calendar API v3 unaffected by breaking changes).

## [0.52.55] - 2026-05-25

### Fixed
- Improved mobile bottom navigation spacing with wider pill-shaped icon wells and more reliable label line-height to avoid clipped text on Android.

## [0.52.54] - 2026-05-25

### Fixed
- Allow task date fields to accept slash and hyphen separators when creating or editing tasks.

## [0.52.53] - 2026-05-25

### Fixed
- Mobile bottom navigation now reserves iOS safe-area space while keeping floating action buttons stable.
- Mobile More search now uses a native button with visible keyboard focus styling and focuses immediately when the sheet opens.
- SPA route changes now move keyboard focus to the main content after navigation while leaving login focus behavior untouched.

## [0.52.52] - 2026-05-25

### Fixed
- Mobile More navigation now closes reliably when choosing a route after locale or navigation rebuilds.

## [0.52.51] - 2026-05-25

### Changed
- Bottom navigation icon wells enlarged from 32 × 32 px to 36 × 36 px for a more prominent, touch-friendly appearance.
- Icon well border-radius increased from `--radius-xs` (4 px) to `--radius-sm` (8 px) across all nav contexts, giving a softer squircle shape consistent with the More-sheet wells.

## [0.52.50] - 2026-05-25

### Changed
- Bottom navigation items now display colored icon wells (32 × 32 px rounded squares) matching the style of the "More" sheet, with per-module accent colors applied consistently across all six slots (primary items, Kitchen button, and More button).
- Sidebar navigation items receive smaller icon wells (26 × 26 px) for visual consistency with the iOS-style sidebar pattern.
- Kitchen and More buttons in the bottom bar dynamically adopt the active sub-module's accent color when a kitchen route or a secondary-sheet route is active.
- More button default icon changed from `ellipsis` to `grid-2x2` to match the icon used when no secondary module is active.

## [0.52.49] - 2026-05-24

### Changed
- Dashboard stat icons (tasks, shopping, notes, budget) now render in their respective module accent colors instead of the generic dashboard color.
- Today-overview cockpit cards carry a subtle accent-tinted background and border in their default (non-hover) state; hover state intensity increased for clearer affordance.
- Cockpit card metric values are now rendered in the card's accent color for stronger visual hierarchy.
- Icon wells (cockpit card icons and "More" navigation sheet items) now blend against `--color-surface-elevated` instead of transparent, and gain an inset specular highlight for a raised, glassy appearance.
- Login page ambient background gains a third radial gradient blob and stronger top-glow opacity for more atmospheric depth.

## [0.52.48] - 2026-05-24

### Changed
- Module page content area now carries a subtle top radial gradient tinted with the active module accent color for atmospheric depth.
- Bottom navigation active-item pill opacity raised from 14 % to 20 % and gains an inset specular highlight ring; global active nav-item background raised from 14 % to 18 %.
- FAB entrance animation overshoots to scale 1.07 at 65 % before settling, duration extended to 0.42 s for a spring feel.
- Interactive card hover lift increased from −2 px to −3 px with a fractional scale and a larger shadow.
- Dashboard greeting title now scales fluidly from 18 px to 24 px via `clamp()` instead of a fixed size.

### Added
- Login page gains a dual radial-gradient ambient glow in the accent violet instead of a flat background.

## [0.52.47] - 2026-05-24

### Changed
- Page titles now scale fluidly from 20 px to 30 px across viewport widths via `clamp()` instead of a hard breakpoint override.
- App-shell ambient background gradients now correctly shift hue to match the active module color; a second gradient blob adds bottom-right depth.
- Form input focus rings adopt the active module accent color instead of always using the default violet.
- "More" navigation sheet items now render a colored rounded-square icon well tinted with each module's accent color.

### Fixed
- App-shell background gradient was resolving to the fallback violet because it referenced `--module-accent` (scoped to child page elements) instead of `--active-module-accent` (set on `<html>` by the router).

## [0.52.46] - 2026-05-24

### Added
- Frontend audit coverage now guards Phase 6 touch target sizing and localized bottom navigation label overflow regressions.

### Changed
- Contact action buttons and shopping quick-add controls now use shared target-size tokens for consistent mobile touch sizing.

### Fixed
- Long localized bottom navigation labels no longer create horizontal overflow on narrow mobile screens.

## [0.52.45] - 2026-05-24

### Changed
- Contacts now keep call and email actions prominent on mobile while moving export, maps, and delete into a compact overflow action so rows stay readable and safer to tap.
- Documents and housekeeping empty states now guide setup with direct document, folder, and profile creation actions.
- Budget category labels now normalize known raw category keys into localized display labels in charts and transaction metadata.

## [0.52.44] - 2026-05-24

### Changed
- Kitchen navigation now keeps a stable Kitchen label and utensils icon while announcing the active subpage through localized accessibility labels and the Kitchen tab bar.
- More sheet search now hands off directly to global search with focus in the search input, avoiding a two-step-feeling transition.

## [0.52.43] - 2026-05-24

### Changed
- Tasks now keeps bulk actions hidden during normal list use, shows them only in bulk-select mode, and disables bulk buttons when no tasks are selected.
- Shopping items can now be checked by tapping the row text area while preserving existing delete, input, select, and explicit button behavior.
- Tasks, shopping items, and note pin/delete controls now use tokenized touch target sizing for more comfortable mobile interaction.

## [0.52.42] - 2026-05-24

### Changed
- Calendar now opens in Agenda view on first mobile load while preserving the user's selected calendar view after they change it.
- Meals now presents a mobile-focused Today and next-days layout while keeping the full desktop week grid unchanged.

## [0.52.41] - 2026-05-24

### Added
- Swedish translations for tasks, settings, documents, and housekeeping modules.

## [0.52.40] - 2026-05-24

### Added
- Dashboard now starts with a compact Today cockpit that highlights the next urgent task, upcoming event, open shopping count, and planned dinner before the broader widget grid.

### Changed
- First-run onboarding can now be skipped immediately from the first step, can be dismissed with Escape, and sits lower on mobile so the dashboard remains partially visible.

## [0.52.39] - 2026-05-24

### Added
- Frontend audit regression coverage now guards the accessibility and rendering fixes from this release: audited frontend files must not reintroduce `innerHTML` assignments, Meals and Budget must use local date keys, shared sub-tabs must wire tabs to panels, settings theme buttons must expose pressed state, and router overlays must stay hidden from keyboard focus when closed.
- Shared local date helpers centralize YYYY-MM-DD generation for API payloads, week starts, and day arithmetic without relying on UTC ISO string slicing.

### Changed
- More navigation and global search overlays now behave like proper dialogs: closed overlays are inert, open overlays declare modal semantics, focus moves into the active surface, Escape closes them, and focus returns to the launching control.
- Shared sub-tabs now generate stable tab ids, connect each tab to its matching panel with `aria-controls` and `aria-labelledby`, and keep hidden panel state synchronized with the active tab.
- Settings theme buttons now expose `aria-pressed` and update that pressed state whenever the active theme changes.
- Shopping list creation now uses the existing localized label for its icon-only button instead of a hardcoded German ARIA label.
- Notes, Meals, and the install prompt now render through `replaceChildren()`, `insertAdjacentHTML()`, or DOM APIs instead of assigning `innerHTML`, aligning these frontend paths with the project XSS policy.

### Fixed
- Meals and Budget no longer derive today, week starts, or payment dates through UTC ISO slicing, preventing off-by-one calendar dates for users west of UTC and around local midnight.
- The PWA install prompt now builds its dismiss icon with SVG DOM APIs and clears shadow content safely, avoiding blocked `innerHTML` assignments.
- Hidden More and Search overlay controls are no longer reachable by keyboard or assistive technology while the overlays are closed.

## [0.52.38] - 2026-05-24

### Fixed
- Dashboard blank-screen on mobile scroll — keep the mobile bottom navigation stable on the Dashboard, stop mirroring scroll state onto `<html>`, and remove scroll-time FAB and bottom-nav layout mutations that could trigger mobile WebKit/Blink compositor blanking.

## [0.52.37] - 2026-05-23

### Fixed
- Blank screen on scroll — disabled `filter` effects inside the `.app-content` scroll container to prevent mobile WebKit/Blink from promoting calendar/event elements into compositor layers during scroll, which can still trigger the empty-screen regression.

## [0.52.36] - 2026-05-23

### Fixed
- Dashboard blank-screen on scroll — removed `overflow: auto` from `.widget__body`, which created up to four nested scroll containers inside `.app-content` (one per task/event/birthday/shopping widget). iOS WebKit and Android Blink promote each `overflow:auto` child to its own compositor layer; multiple nested vertical scroll containers in one viewport trigger the blank-screen-on-scroll symptom even with `prefers-reduced-transparency: reduce` active, ruling out the earlier backdrop-filter and `color-mix` gradient theories. Widget content (3–7 list items) fits naturally; `.widget` already has `overflow: hidden` for rounded-corner clipping.

## [0.52.35] - 2026-05-23

### Fixed
- Dashboard blank-screen on scroll — new lead identified after the previous glass/gradient theories were ruled out by an iOS `prefers-reduced-transparency: reduce` test (bug persisted even with reduced transparency, so backdrop-filter and `color-mix` gradients are not the cause). Remaining differentiator: only the dashboard renders a `.fab-backdrop` element — a `position: fixed; inset: 0` full-viewport overlay that was always in the DOM (initial `opacity: 0`) so the FAB speed-dial open/close could cross-fade. iOS Safari and iOS PWA repeatedly composite fixed-positioned full-viewport elements per scroll frame, which is a known trigger for the blank-screen symptom in this exact scenario. Other module pages don't have this overlay and didn't reproduce the bug. Switched `.fab-backdrop` from `opacity: 0` + always-on `position: fixed; inset: 0` to `display: none` when inactive; only laid out when the FAB speed-dial is open. The opacity cross-fade is lost (was barely perceptible) but the dashboard scroll path no longer carries a permanent full-viewport fixed layer.

## [0.52.34] - 2026-05-23

### Fixed
- Dashboard blank-screen on scroll — actual dashboard-specific trigger identified. Each `.dashboard .widget::after` carried a `linear-gradient(135deg, color-mix(...), transparent 70%)` as a full-cover tint overlay (`glass.css` section 25). With many widgets stacked in the dashboard grid, each scrolling instance applied the gradient + `color-mix()` pattern repeatedly across the scroll viewport, reproducing the same WebKit/Blink scroll-rasterization failure that v0.52.32 fixed for `.app-content`. No other module page has a comparable per-card gradient overlay pseudo-element, which is why only the dashboard remained broken after v0.52.32/v0.52.33. Replaced the gradient with a flat translucent `color-mix()` background (half the original tint strength) so the module-accent vibrancy is preserved without a gradient. The pre-existing `@media (prefers-reduced-transparency: reduce) { .dashboard .widget::after { display: none } }` rule was a strong hint at the same conclusion.

## [0.52.33] - 2026-05-23

### Fixed
- Dashboard blank-screen on scroll — final remaining trigger. After v0.52.32 fixed the bug on every other page by moving the `color-mix()` radial gradient off the scroll container, the dashboard still reproduced the symptom because `.dashboard-overview` carried the same problematic pattern: a `linear-gradient(180deg, color-mix(...), color-mix(...))` on a large, scrolled element. Replaced with the solid `var(--color-surface)` background that all other `.widget` elements already use. The dashboard now matches the rest of the app: no scrolled element on any page carries a complex `color-mix()` gradient background.

## [0.52.32] - 2026-05-23

### Fixed
- Blank screen on scroll — sixth attempt, this time targeting the actual root cause. The radial `color-mix()` gradient on `.app-content` introduced in Liquid Glass Phase 4 was painted directly on the scroll container; WebKit (iOS Safari/PWA) and Blink (Android Chrome) both unreliably rasterize complex `color-mix()` gradients on `overflow:auto` elements during scroll, producing the empty-screen symptom on every page. Moved the gradient to `.app-shell` (viewport container, `height: 100dvh`, never scrolls); `.app-content` now has a transparent background so the gradient shows through unchanged. Visually identical, but no scrolling element carries a complex background. Why the five previous fixes (v0.52.22, v0.52.25, v0.52.27, v0.52.29, v0.52.30) failed: each targeted a different downstream symptom (sticky `backdrop-filter`, all `backdrop-filter` inside `.app-content`, `overflow: clip` on `.dashboard`, internal scroll container on the dashboard, `filter: saturate/drop-shadow` on widgets) under the assumption that many GPU compositor layers were the cause — but the bug reproduced on every page including pages without those triggers, and on Android, where the iOS-WebKit-compositor theory cannot apply.

## [0.52.31] - 2026-05-23

### Fixed
- Dashboard scrolling restored. The internal-scroll-container approach introduced in v0.52.29 (`display: flex; height: 100%; overflow: hidden` on `.dashboard`, `flex: 1; overflow-y: auto` on `.dashboard-shell`) caused a scroll regression: `height: 100%` on `.dashboard` resolved against `.page-transition` (its direct parent, `height: auto`), making it equivalent to `height: auto` per CSS spec. As a result `.dashboard-shell` received no height constraint and its `overflow-y: auto` never activated; on iOS, `overscroll-behavior-y: contain` on the unconstrained `.dashboard-shell` additionally blocked touch events from reaching `.app-content`. Fix: reverted to `overflow: visible` on `.dashboard` and removed the internal scroll container from `.dashboard-shell`; scrolling happens via `.app-content` as on every other page.

## [0.52.30] - 2026-05-23

### Fixed
- Dashboard scroll blank-screen fixed on iOS Safari and Android Chrome. Two `filter` properties on dashboard elements (`.event-item__bar { filter: saturate(0.4) }` and `.weather-widget__icon { filter: drop-shadow(...) }`) created GPU compositor layers inside the scroll container that overwhelmed the mobile compositor on both WebKit and Blink. Replaced `filter: saturate(0.4)` with `opacity: 0.5`; removed the drop-shadow filter entirely. The gap between content and bottom nav introduced in v0.52.29 is also fixed: `height: calc(100dvh - nav - safe-areas)` double-subtracted the nav height (`.dashboard` is already inside `.app-content` which excludes the nav), changed to `height: 100%`.

## [0.52.29] - 2026-05-23

### Fixed
- Dashboard no longer goes blank when scrolling on iOS Safari/WebKit (root cause fix). The real cause was that the dashboard was the only page scrolling via `.app-content`; on scroll, `initNavHideOnScroll` applied `transform: translateY(100%)` to `.nav-bottom` which—combined with its `backdrop-filter`—created an iOS 26 WebKit compositor conflict with the active scroll container. Fixed by giving `.dashboard` an internal scroll container (`.dashboard-shell`, analogous to all other pages), so `.app-content` never scrolls and the nav transition is never triggered. `initNavHideOnScroll` updated to use document-level capture scroll delegation and additionally listens to `#dashboard-shell`. Closes #166.

## [0.52.28] - 2026-05-23

### Fixed
- Scrolling on Notes, Contacts, Calendar, and Shopping pages no longer causes a blank screen on iOS Safari and mobile Chrome. `overflow: clip` on the page containers (`.notes-page`, `.contacts-page`, `.calendar-page`, `.shopping-page`) inside the `overflow: auto` scroll container triggered the same iOS WebKit compositor bug fixed for the dashboard in v0.52.27. Changed to `overflow: hidden`, which clips identically without the compositor regression. Closes #166.

## [0.52.27] - 2026-05-23

### Fixed
- Dashboard page no longer goes blank when scrolling on iOS (Safari, WebKit). `overflow: clip` and `isolation: isolate` set by an older skin variant on `.dashboard` were not reset when the Admin Dashboard Layout replaced it; `overflow: clip` inside an `overflow: auto` scroll container prevents WebKit from repainting scroll content, leaving only compositor-promoted elements (the dashboard-overview top border) visible. Both properties are now reset to their initial values.

## [0.52.26] - 2026-05-23

### Fixed
- Scrolling on any page no longer causes a blank/white screen on iOS (Safari, WebKit) and Android (Chrome, Blink). The previous partial fix (v0.52.22) only removed `backdrop-filter` from sticky toolbars; the root cause was broader — `glass.css` applied `backdrop-filter` to task cards, note items, dashboard widgets, form inputs, meal slots, group-toggles, and skeleton loaders inside the `overflow:auto` scroll container, each becoming a separate GPU compositor layer that overwhelmed the mobile compositor on scroll. A single permanent CSS rule now disables `backdrop-filter` for all scroll-container children; the bottom navigation bar, modals, and toasts retain their blur effect as they sit outside the scroll container. Closes #166.

## [0.52.25] - 2026-05-23

### Added
- Kitchen nav button (bottom bar and sidebar) now dynamically shows the icon and label of the last visited kitchen section (Meals / Recipes / Shopping), making the navigation target predictable at a glance
- Offline banner now pushes page content down via `--offline-banner-height` CSS variable, preventing content overlap when the app is offline
- `.grid--2` responsive grid now activates at 600 px instead of 768 px, giving iPad Mini portrait and small tablets a two-column layout

### Changed
- Dashboard greeting text and date label refresh automatically on `visibilitychange`, so "Good Morning" no longer persists into the afternoon on a long-running session
- FAB entry animation counter is now tracked per module instead of globally; the animation reappears when visiting a module for the first time even after it was suppressed on other modules
- Icon size system consolidated from 8 granular sizes to 4 semantic steps — `icon-sm` (12 px), `icon-md` (16 px), `icon-lg` (20 px), `icon-xl` (24 px); old class names kept as backward-compat aliases
- Document, budget loan, and budget loan payment deletions now use an optimistic undo-toast pattern (5 s window) instead of a blocking confirmation dialog, consistent with Tasks, Notes, and Contacts

## [0.52.24] - 2026-05-23

### Changed
- Dashboard widget accent bar is now muted (`color-mix` at 40% saturation) so multiple module colours no longer clash on the widget grid
- Base body font size increased from 15 px to 16 px (`--text-base: 1rem`) for better desktop readability
- Recurring-event weekday buttons enlarged from 40 px to 44 px (Apple HIG minimum) on screens narrower than 1024 px; day-grid uses `space-between` layout to fit all 7 days

### Fixed
- Onboarding overlay no longer shows the "Skip" button on the first step or the last step, reducing premature dismissal before the navigation explanation is seen

## [0.52.23] - 2026-05-23

### Fixed
- Scrolling on mobile Safari (iOS 26+) and narrow-viewport browsers no longer causes the entire page to go blank. Root cause: `backdrop-filter` on `position:sticky` elements inside an `overflow:auto` scroll container triggers a WebKit compositor bug that blanks the whole scroll container. Fixed by removing `backdrop-filter` from all sticky toolbars (Tasks, Notes, Contacts, Calendar, Housekeeping, Shopping list headers) and `.sticky-header`, replacing semi-transparent glass backgrounds with an opaque `var(--color-bg)`.

## [0.52.22] - 2026-05-23

### Added
- `.gitattributes` added to enforce LF line endings for shell scripts and normalize all text files, preventing shebang breakage in Linux containers when the repo is cloned on Windows

## [0.52.21] - 2026-05-21

### Added
- Global search now includes contacts (matched by name, phone, email) and shopping items (matched by name); clicking a result navigates directly to the respective module
- Contacts search results deep-link via `?open=<id>` and open the edit modal immediately on page load
- Shopping search results deep-link via `?list=<id>&highlight=<id>`: the correct list tab is activated and the matched item is scrolled into view
- Calendar search results deep-link via `?open=<id>` and open the event edit modal immediately on page load

### Fixed
- Calendar search results previously navigated to `/calendar` without identifying the specific event; results now carry the event id and open the edit modal directly
- Replaced all `innerHTML` assignments in `calendar.js`, `contacts.js`, and `shopping.js` with `replaceChildren()` and `insertAdjacentHTML` to comply with the project XSS policy

## [0.52.20] - 2026-05-21

### Fixed
- Dashboard skeleton screen now renders all 9 widgets with correct grid-spanning sizes (matching `DEFAULT_WIDGET_CONFIG`) instead of 6 fixed-width placeholders, preventing content layout shift on initial load

## [0.52.19] - 2026-05-21

### Fixed
- FAB no longer floats in the middle of the screen when the bottom navigation bar hides on scroll; it now animates to the bottom edge in sync with the nav bar and returns when the nav reappears

## [0.52.18] - 2026-05-21

### Changed
- Dashboard metric tiles now always display in a 2-column grid on all screen sizes; the single-column layout below 768 px has been removed, reducing the scroll offset on mobile by approximately 200 px

## [0.52.17] - 2026-05-20

### Changed
- Desktop sidebar now shows labels and the app name at 1024 px and wider (previously icon-only between 1024–1279 px); the collapsed icon-only range has been removed

## [0.52.16] - 2026-05-20

### Changed
- Notes is now a primary bottom navigation item (index 4), replacing it in the More-Sheet; the bottom bar order is now Dashboard → Calendar → Tasks → Notes → Kitchen → More
- More-Sheet item count reduced from 7 to 6 by promoting Notes to the primary navigation bar
- Tapping the search bar in the More-Sheet now closes the sheet instantly (no slide-out animation) before opening the search overlay, eliminating the jarring double-animation sequence

## [0.52.15] - 2026-05-20

### Fixed
- Toast notifications for success and default messages no longer interrupt screen reader output immediately; only danger and warning toasts use `aria-live="assertive"`, while success and default use `aria-live="polite"`
- Removed redundant `role="listitem"` attribute from navigation `<a>` elements; the parent container already provides list semantics, and the duplicate role was confusing assistive technologies

## [0.52.14] - 2026-05-20

### Fixed
- Dashboard metric titles now use 12 px (`--text-xs`) instead of 10 px (`--text-2xs`), satisfying WCAG 2.1 minimum text size
- Login form now includes a password visibility toggle (eye/eye-off icon) so users can verify what they are typing before submitting

## [0.52.13] - 2026-05-20

### Fixed
- ICS text fields (SUMMARY, DESCRIPTION, LOCATION) now have RFC 5545 escape sequences unescaped on import; characters like `\,`, `\;`, `\n`, and `\\` are now displayed correctly instead of shown as raw backslash sequences
- When pushing events to a CalDAV server, SUMMARY and DESCRIPTION values are now properly escaped per RFC 5545, preventing corrupted data on round-trip
- CalDAV calendar names now appear correctly in the event edit modal's sync target dropdown; the dropdown was reading `calendar.url` and `calendar.display_name` instead of the API response fields `calendarUrl` and `calendarName`, causing empty or undefined entries

## [0.52.12] - 2026-05-20

### Fixed
- Settings page is accessible again after the v0.52.10 update; a missing closing parenthesis on the `insertAdjacentHTML` call in `settings.js` caused a JavaScript syntax error that prevented the entire settings page from loading

## [0.52.11] - 2026-05-20

### Added
- Tasks can now have a **start date**: tasks with a future start date are hidden from the list by default, reducing cognitive load for children and family members who should focus on current assignments only
- A "Show scheduled" toggle chip in the task filter bar lets parents and admins see all upcoming planned tasks
- Future tasks display a "Starts on …" badge in the task card so the scheduled date is always visible at a glance
- All 16 UI languages include translations for the new start date field and filter toggle

### Changed
- Replaced all remaining `innerHTML` assignments in `tasks.js` with `replaceChildren` / `insertAdjacentHTML` to comply with the project's XSS-safety constraint

## [0.52.10] - 2026-05-20

### Fixed
- CalDAV calendar names are now displayed correctly in Settings > Synchronization; the frontend was reading `cal.url`, `cal.display_name`, and `cal.color` instead of the API response fields `calendarUrl`, `calendarName`, and `calendarColor`, which caused blank calendar entries and an error when toggling a calendar's enabled state
- Replaced remaining `innerHTML` assignments in `settings.js` with `replaceChildren` / `insertAdjacentHTML` to comply with the project's XSS-safety constraint

## [0.52.9] - 2026-05-19

### Changed
- Bumped better-sqlite3 to 12.10.0, express-rate-limit to 8.5.2, and tsdav to 2.2.2
- Bumped puppeteer (dev dependency) to 25.0.4

## [0.52.8] - 2026-05-18

### Fixed
- Pinned notes on the dashboard now render Markdown formatting (bold, italic, lists) instead of displaying raw Markdown syntax

## [0.52.7] - 2026-05-16

### Fixed
- Bottom navigation bar is no longer invisible on mobile; `bottomNav.appendChild(bottomItems)` was accidentally dropped during the split-guest refactor in v0.52.6

## [0.52.6] - 2026-05-16

### Fixed
- Split-guest users on mobile no longer see a broken Kitchen button and an empty More sheet that covered page content; those nav elements are omitted entirely for guest accounts
- Converted `renderError` and toast icon rendering from `innerHTML` to DOM API to comply with the project's XSS-safety constraint

## [0.52.5] - 2026-05-13

### Fixed
- Translate `backupCliHint` string into 10 missing locales (ar, el, es, fr, hi, it, ja, ru, tr, zh)

## [0.52.4] - 2026-05-13

### Added
- Yearly recurrence option in the calendar event repeat dropdown (`FREQ=YEARLY`), with translations in all 16 supported locales

## [0.52.3] - 2026-05-12

### Added
- Complete Ukrainian (uk) localization: all previously untranslated strings in tasks, shopping, meals, calendar, housekeeping, budget, contacts, settings, reminders, documents, and onboarding are now fully translated (contributed by @baragoon)

## [0.52.2] - 2026-05-12

### Fixed
- Regenerated all PWA icon assets (`favicon.ico`, `favicon-32.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-192.png`, `icon-maskable-512.png`, `apple-touch-icon.png`) from `docs/logo.svg` so they show the correct violet gradient (`#8b5cf6` to `#6c3aed`) matching the brand colors in `tokens.css`

## [0.52.1] - 2026-05-12

### Changed
- Bump `express-rate-limit` from 8.5.0 to 8.5.1
- Bump `tsdav` from 2.2.0 to 2.2.1 (fixes CalDAV compatibility with servers that omit `supported-calendar-component-set`)
- Bump `puppeteer` from 24.42.0 to 24.43.1

## [0.52.0] - 2026-05-11

### Added
- **Bike icon**: added `bike` icon to the calendar event icon selector (transport category), with translations for all 16 supported locales.

## [0.51.0] - 2026-05-11

### Added
- **Split Expenses module**: new tab inside Budget for managing shared expenses. Supports expense groups (household, couple, travel, event, shopping, general) with multiple split methods: equal, percentage, exact amounts, and shares. Balances are derived from an immutable ledger — amounts are stored as integer minor currency units (cents) to avoid floating-point errors.
- **Settlements**: record payments between group members with a debt-simplification algorithm that produces the minimal set of transfers to clear all balances.
- **Recurring expenses**: define expenses that repeat on a daily, weekly, monthly, or yearly schedule with automatic generation via an hourly scheduler.
- **Guest accounts**: invite people outside the family as restricted guests who can only access the Split module and see their own invited groups. Guests can be created from scratch or converted from existing contacts.
- **Multi-currency support**: each group has a default currency; individual expenses can use any currency with historical exchange rate snapshots for consistent balance reporting.
- **Activity feed**: per-group log of all expense, member, and settlement events.
- **Polish locale**: split-expenses strings added to the Polish (`pl`) translation.

## [0.50.0] - 2026-05-08

### Added
- **Polish locale**: full Polish (`pl`) translation added, covering all UI strings across all modules (tasks, calendar, shopping, meals, budget, notes, contacts, birthdays, recipes, documents, housekeeping, settings, and more). Polish is now selectable in Settings → Language.

## [0.49.0] - 2026-05-08

### Added
- **Housekeeping module**: new dedicated module for managing household staff workflows. Features include staff profiles (with avatar, daily rate, calendar color, payment schedule), work session check-in/check-out (with automatic local calendar event creation), recurring chore tracking with urgency decay indicators, supply requests (linked to shopping lists), and a monthly visit log with payment summaries.
- **Document folders**: documents can now be organized into custom folders. A "Hausreinigung" folder is auto-created when a housekeeping worker is first added.
- **Calendar icon picker**: calendar events now support a custom icon selected from a curated set of Lucide icons.
- **Payment task integration**: each housekeeping check-in can optionally create a payment task; completing the task marks the visit as paid. Toggle in Settings → Haushaltshilfe.

### Changed
- **Documents page**: added a folder browser sidebar and folder filter; existing documents without a folder remain accessible under "Alle Ordner".
- **Dashboard**: housekeeping widgets show today's open sessions and upcoming chores.
- **Settings**: new "Haushaltshilfe" section for the payment task toggle.
- **Navigation**: housekeeping module appears in the main nav with Violet accent theming.

## [0.48.3] - 2026-05-06

### Changed

- **Brand color**: reverted the primary accent color from Amber back to Violet. The accent is now `#6c3aed` in light mode and `#a78bfa` in dark mode, applied consistently across all design tokens, the logo, all PWA icons (favicon, app icons, maskable icons, Apple touch icon), and the GitHub Pages documentation site. Semantic colors (warnings, notes module, meal-breakfast) remain unchanged.

## [0.48.2] - 2026-05-06

### Changed

- **Brand color refresh**: The primary accent color has been updated from cool indigo (`#4F46E5`) to a rich, warm amber (`#92400E` in light mode, `#FBBF24` in dark mode) across all design tokens, the logo, and the GitHub Pages documentation site.

  **Why this change?** Indigo carried the aesthetic of a productivity tool — focused, corporate, digital. As Oikos has grown into a home for thousands of families, we wanted the visual identity to better reflect what the app actually is: a warm, shared space for everyday life together. Amber — deep and earthy in light environments, bright and inviting in dark ones — communicates exactly that. It evokes warmth, reliability, and the kind of unhurried intimacy that family life deserves.

  From an accessibility standpoint, Amber-800 (`#92400E`) achieves a contrast ratio of 7.20:1 against white, exceeding the WCAG AA threshold and meeting WCAG AAA. The dark mode value (`#FBBF24`) maintains the same readability standard. The transition is purely cosmetic — no data, settings, or behavior has changed.

- **Logo**: updated the gradient on `docs/logo.svg` and all inline SVG instances from violet (`#8B5CF6` to `#6C3AED`) to amber (`#B45309` to `#92400E`).

## [0.48.1] - 2026-05-06

### Fixed
- **Settings**: CalDAV and CardDAV "Add Account" modals now correctly display Cancel and Save buttons. Previously, the `onSave` callback ran immediately on modal open, triggering a required-fields validation error against empty fields and leaving the form with no way to submit.

## [0.48.0] - 2026-05-06

### Added
- **Multi-person assignment**: tasks and calendar events can now be assigned to multiple family members simultaneously. A new `task_assignments` / `event_assignments` join table (migration v32) stores the assignments; existing single-user data is migrated automatically.
- **Avatar stack**: task cards, Kanban cards, and the calendar agenda view display stacked avatars for all assigned users (up to 3 visible, then a `+N` overflow badge).
- **Shared UserMultiSelect component** (`public/components/user-multi-select.js`): checkbox-based dropdown used in both the task modal and the calendar event modal; replaces the previous single-user `<select>`.
- **`assigned_to` filter extended**: `GET /api/v1/tasks?assigned_to=<id>` and `GET /api/v1/calendar?assigned_to=<id>` now match any task/event where the user appears in the assignments list.

### Changed
- API response for tasks and calendar events now includes `assigned_users: [{id, display_name, color}]` array alongside the legacy `assigned_to` / `assigned_name` / `assigned_color` fields.
- Recurring task completion copies all multi-person assignments to the new recurring instance.

## [0.47.5] - 2026-05-06

### Changed
- **Settings — Sync tab**: open standards (CalDAV, CardDAV, ICS subscriptions) are now grouped first under a dedicated "CalDAV & CardDAV" section; cloud services (Google Calendar, Apple Calendar) move to a secondary "Cloud Services" section. Fixes a raw `<h2>` heading inside the CalDAV card (now uses `settings-card__title` like all other cards).
- **Navigation — shared sub-tabs component**: extracted `renderSubTabs()` (`public/utils/sub-tabs.js` + `public/styles/sub-tabs.css`) as the single implementation for all sub-module navigation. Settings tabs and kitchen tabs now share the same pill-style bar (icon + label, sticky, horizontally scrollable, group separators). Removes ~120 lines of duplicated CSS from `kitchen-tabs.css` and `settings.css`.
- **Test loader**: `test-browser-loader.mjs` now resolves browser-absolute `/utils/*.js` imports to the `public/` directory automatically, eliminating the need for per-module stubs.

## [0.47.4] - 2026-05-06

### Fixed
- **Modal**: add `onClose` callback to `openModal()` so promise-based modals (`confirmModal`, `promptModal`, `selectModal`) resolve correctly on Escape and overlay-click without duplicate event listeners.
- **Modal**: fix `_initialFormTimeout` leak — timeout is now tracked and cancelled on re-open or close, preventing stale dirty-check snapshots.
- **Calendar**: replace `popup.innerHTML` with `insertAdjacentHTML` in the event popup (project constraint); add `truncateDescription()` to cap long event descriptions at 500 characters.
- **Validation**: extend `DATETIME_RE` to accept ISO 8601 datetimes with milliseconds and timezone offsets; normalise datetime inputs to `YYYY-MM-DDTHH:MM` before storing.

### Changed
- **Docker**: switch from named Docker volume to host-mounted bind mounts; `DATA_DIR` (default `./data`) and `BACKUP_DIR` (default `./backups`) can be set in `.env` to control storage locations.
- **Startup log**: include app version in the server start message.

## [0.47.3] - 2026-05-06

### Changed
- **Documentation**: SPEC.md updated to reflect v0.45–v0.47 changes — CardDAV Accounts and CardDAV Addressbook Selection tables added; Contacts table expanded with multi-value fields and CardDAV columns; new contact_phones, contact_emails, contact_addresses sub-tables documented; Birthdays table reflects configurable reminder offset columns; External Calendars table notes apple→caldav migration; Tasks module documents bulk actions; Contacts module documents CardDAV multi-account sync; Birthdays module reflects flexible reminder offsets; Settings module updated for Synchronization tab, module toggles, scheduled backups, and CardDAV UI.
- **README**: Birthdays feature description updated to reflect customizable reminder offsets; Backup feature description updated to mention automatic scheduled backups.

### Removed
- **Repository**: archived implemented cleanup plan (`docs/designs/2026-05-04-repo-cleanup-design.md` → `docs/archive/designs/`); removed settings sidebar prototype HTML (`docs/designs/2026-05-04-settings-sidebar-demo.html`).

## [0.47.2] - 2026-05-05

### Changed
- **Dependencies**: updated express-rate-limit from 8.4.1 to 8.5.0 (async store initialization support) and tsdav from 2.1.8 to 2.2.0 (native fetch, enhanced OAuth token handling, improved CalDAV/CardDAV sync reliability, security improvements).

## [0.47.1] - 2026-05-04

### Fixed
- **Settings page crash**: fixed ReferenceError "loadCalDAVAccounts is not defined" when opening Settings. Root cause: loadCalDAVAccounts and loadCardDAVAccounts were defined inside the render function but called from bindIcsEvents (outside render scope). Functions are now top-level exports with user parameter.

## [0.47.0] - 2026-05-04

### Added
- **Settings UX overhaul**: renamed Calendar tab to Synchronization with dedicated sections for Calendar Sync and Contact Sync. Improved information architecture with visual tab grouping using CSS separators between functional areas (module settings, synchronization, personal, administration).
- **CardDAV UI**: complete user interface for CardDAV contact synchronization in Settings. Add/delete CardDAV accounts (iCloud, Nextcloud, Radicale, Baikal), enable/disable individual addressbooks, manual sync trigger, real-time status indicators. Empty state onboarding for first-time setup.
- **Status badges**: visual sync status indicators (success, error, syncing) with animated spinner for active syncs across CalDAV and CardDAV integrations.

### Changed
- **Settings navigation**: Calendar tab replaced by unified Synchronization tab containing both calendar and contact sync options. Existing CalDAV calendar accounts remain accessible in the Calendar Sync section.

## [0.46.0] - 2026-05-04

### Added
- **Flexible birthday reminders** (#123): customizable reminder offsets for birthdays with preset options (none, at time, 15min, 1h, 1d, 2d, 1w, 2w) and custom intervals (minutes, hours, days, weeks). Users can now configure exactly when to be reminded of upcoming birthdays. Database migration 31 adds `reminder_offset`, `reminder_custom_amount`, `reminder_custom_unit` columns to birthdays table. UI component integrated into birthday modal. Backend service calculates reminder time based on offset and supports disabling reminders when offset is empty.

### Fixed
- **Service worker protocol guard**: added check to skip non-HTTP protocols (e.g., chrome-extension://) in fetch handler to prevent errors with browser extensions.

## [0.45.0] - 2026-05-04

### Added
- **CardDAV contacts integration** (#122): generic multi-account CardDAV sync for contacts. Connect multiple CardDAV servers (Nextcloud, iCloud, Radicale, Baikal) simultaneously. 8 new API routes for account management (`/api/v1/contacts/cardav/*`): create/delete accounts, test connections, discover/refresh addressbooks, toggle addressbook selection, sync contacts. Per-addressbook enable/disable via checkboxes. New service: `server/services/cardav-sync.js`. New router: `server/routes/cardav.js`. Database tables: `carddav_accounts`, `carddav_addressbook_selection`.
- **Multi-value contact fields**: contacts now support multiple phones, emails, and addresses per contact. Each entry has a label (e.g., "mobile", "work", "home"), value, and optional `isPrimary` flag. Extends existing contact routes: `GET /contacts/:id`, `POST /contacts`, `PUT /contacts/:id`. Database tables: `contact_phones`, `contact_emails`, `contact_addresses`. Atomic transactions with replacement semantics on update. Backward compatible with legacy single-field contacts. Array validators: `validatePhones()`, `validateEmails()`, `validateAddresses()` with length limits, format checks, and type validation.

## [0.44.1] - 2026-05-04

### Fixed
- **CalDAV migration crash**: fixed CHECK constraint violation during v0.44.0 migration that caused container restart loop. The apple→caldav `external_source` conversion now happens during table rebuild instead of before, preventing the constraint error (#119, #120).

## [0.44.0] - 2026-05-04

### Added
- **Generic CalDAV multi-account sync** (#90): replaced single Apple CalDAV integration with a generic multi-account CalDAV solution. Connect multiple CalDAV servers (iCloud, Nextcloud, Radicale, Baikal) simultaneously. Per-account calendar selection via checkboxes in Settings → Calendar. Bidirectional sync with optional outbound target selection per event. Existing Apple CalDAV data is automatically migrated on upgrade. New database tables: `caldav_accounts`, `caldav_calendar_selection`. New service: `server/services/caldav-sync.js`. New API routes: `/calendar/caldav/*`. Enhanced UI in Settings and Calendar event modal.

### Changed
- **Calendar feature description**: README.md and docs/SPEC.md updated to reflect multi-account CalDAV support instead of single Apple CalDAV integration.

## [0.43.0] - 2026-05-04

### Added
- **Automatic scheduled backups**: database backups are now created automatically on a configurable cron schedule (default: 2 AM daily). Old backups are rotated automatically, keeping only the last N copies (default: 7). Configuration via `.env` variables: `BACKUP_ENABLED`, `BACKUP_SCHEDULE`, `BACKUP_DIR`, `BACKUP_KEEP`. Settings → Backup displays scheduler status, schedule, retention policy, last backup timestamp, and a manual trigger button.

## [0.42.0] - 2026-05-04

### Added
- **Module toggles** (Settings → General, admin-only): individual modules (Tasks, Calendar, Shopping, Meals, Recipes, Birthdays, Notes, Contacts, Budget, Documents) can be disabled to hide them from the navigation. Data is preserved and reappears when the module is re-enabled. Dashboard and Settings remain essential and cannot be disabled.
- **Bulk actions for tasks** (List view only): select multiple tasks via checkboxes and apply batch operations (mark done, mark open, archive, delete). Bulk select toggle appears in the toolbar; selected count and action bar appear when tasks are checked. Kanban view remains single-task oriented.

## [0.41.0] - 2026-05-01

### Added
- **Birthday badge**: the birthdays nav item now shows a badge when any family member has a birthday within the next 3 days.
- **Recent filter chips**: the task filter bar now shows up to three recently used filters as quick-access chips, persisted in `localStorage`.
- **Calendar icon search**: the event icon picker now includes a live search field to quickly find icons by keyword, with results grouped by category.
- **Calendar icon categories**: event icons are now organised into labelled category groups (transport, sports, health, nature, leisure, social, work, home, food, other).
- **Repeat indicator on calendar events**: events with a recurrence rule now display a small repeat icon in both month and week views.
- **3-day week view on mobile**: the calendar week view automatically switches to a 3-day window on screens narrower than 640 px for better readability.
- **Widget size presets**: the dashboard widget size selector uses named presets (Tiny, Narrow, Standard, Large, Full) instead of raw grid dimension values.

### Changed
- **Required-field markers**: title fields in the task, event, and budget modals now show a required-field asterisk via the `.required-marker` CSS class.
- **Modal drag handle touch target**: the bottom-sheet drag handle has a 44 px tall invisible hit area so it can be grabbed comfortably.
- **Swipe affordance**: list rows with swipe actions show a subtle chevron hint to signal the gesture.
- **Budget tab height**: budget tab buttons have a minimum height of 40 px to meet touch-target requirements.

## [0.40.1] - 2026-05-01

### Changed
- **Typography tightening**: page titles and modal titles use tighter letter-spacing (`-0.5 px` / `-0.8 px` on desktop) and `text-wrap: balance` to eliminate orphaned words on wrapped headings.
- **Warm-tinted shadows**: all elevation shadows (`sm` through `xl`) now use a warm-tinted base colour (`rgba(18, 14, 8, …)`) that matches the warm neutral palette instead of pure black.
- **Button radius**: regular buttons use `--radius-md` (12 px) instead of `--radius-sm` (8 px), creating a clear visual distinction from text inputs.
- **Empty-state icons**: icons in empty states pick up a 40 % tint of the current module accent colour, making them feel contextually connected to each module rather than uniformly grey.
- **Search section labels**: category headings inside the search overlay are now sentence-case instead of all-caps, improving readability.

### Fixed
- **Tabular figures**: currency amounts (budget summary cards, transaction list, loan cards, chart rows), weather temperature, dashboard metrics, and calendar time labels now use `font-variant-numeric: tabular-nums` so digit columns remain visually aligned.

## [0.40.0] - 2026-05-01

### Added
- **Budget loans tracker** (PR #117 by @rafaelfoster): a new Loans tab in the Budget module lets you create instalment-based loans, record individual payments, track remaining balance and due months, and filter budget transactions by loan. Paid-off loans are automatically marked as closed. Full CRUD with confirmation modals.
- **Dashboard widget sizes**: each dashboard widget now has a configurable size (columns × rows). Sizes are persisted in user preferences and survive page reloads.
- **Extended date formats**: Settings → General now offers four additional date format options — `MM.DD.YYYY`, `YYYY.MM.DD`, `YYYY/MM/DD`, and `DD/MM/YYYY` — alongside the existing formats.

### Fixed
- **`dmy` date format preserved**: the existing `DD.MM.YYYY` behaviour of the `dmy` preference is unchanged for all current users; a new `DD/MM/YYYY` option (`dmy_slash`) is available for those who want slashes.

## [0.39.2] - 2026-05-01

### Fixed
- **Budget date picker**: the date input in Budget → New Entry / Edit Entry now uses a native date picker on iOS and Android instead of a plain text field.

## [0.39.1] - 2026-05-01

### Added
- **Swedish translation completed** (PR #115 by @olsson82): all previously untranslated strings in `sv.json` now have Swedish equivalents (attachment fields, API token settings, budget categories, backup hint, onboarding, offline banner).
- **i18n gap fix**: calendar and notes colour names, `emptyHint` texts, keyboard-shortcut labels, `tasks.navLabelOverdue`, and `birthdays.photoOptional` added to all 13 non-German locale files (ar, el, en, es, fr, hi, it, ja, pt, ru, tr, uk, zh).

## [0.39.0] - 2026-04-30

### Added
- **Time format preference**: Settings → General now includes a 24-hour / AM·PM toggle. The selected format is persisted in household preferences (backend) and localStorage, and takes effect globally for all time displays in calendar and tasks. Time inputs in modals accept both formats and normalise on blur. The calendar also remembers the last selected view (month / week / day) across sessions.

## [0.38.4] - 2026-04-30

### Fixed
- Dashboard portrait mode on mobile: layout no longer overflows to landscape width; `overflow: visible` override in the Admin Dashboard Layout CSS block has been removed so the correct `overflow: clip` takes effect, and `.app-content` now uses `overflow-x: hidden` (instead of `clip`) to properly contain layout overflow at the scroll container level

## [0.38.3] - 2026-04-30

### Fixed
- Dashboard portrait mode on Android: horizontal scrollbar no longer appears due to subpixel overflow in the main scroll container (`overflow-x: clip` added to `.app-content`)

## [0.38.2] - 2026-04-30

### Fixed
- Recurring calendar events with `FREQ=WEEKLY;INTERVAL=N;BYDAY=...` (N > 1) now correctly skip N−1 weeks between occurrences instead of repeating every week

## [0.38.1] - 2026-04-30

### Changed
- Docs: SPEC.md — `family_documents` and `family_document_access` tables added; `calendar_events` extended with `icon` and four attachment columns; `contacts` and `birthdays` extended with `family_user_id`; Tasks `status` includes `archived`; Documents module section added; Calendar section updated with icons, file attachments, and overlapping event rendering; Settings section updated with Backup Management tab and family member contact fields
- Docs: BACKLOG.md — completed features table brought up to date through v0.38.0 (v0.30.0–v0.38.0 entries added)
- Docs: README.md — Backup entry added to the feature table; Documents entry updated with exact category count
- Docs: CONTRIBUTING.md — `innerHTML` security note updated to reflect current `insertAdjacentHTML`/`replaceChildren`/`esc()` pattern; individual test-suite commands listed

## [0.38.0] - 2026-04-30

### Added
- FAB entry animation now stops after 5 page views (long loop progressive reduction)
- Search keyboard shortcut hint (`/`) hides permanently after first keyboard use
- Success toasts are suppressed after 50 successful saves to reduce noise for power users
- Empty state CTA button fades in with a short delay to draw attention as the primary action
- Form fields pulse with a red glow on the second or subsequent validation failure on the same field
- Shopping quick-add input shows a brief accent-colour glow after each successful item add

## [0.37.2] - 2026-04-30

### Changed
- Search bar in More sheet: added hover, active, and focus states with accent colour highlight and subtle scale feedback
- Search bar icon changes to accent colour on hover and press for clearer trigger affordance
- Keyboard shortcut hint (`/`) shown inside search bar on desktop as discoverability signal

## [0.37.1] - 2026-04-30

### Changed
- Bottom navigation: Tasks replaces Search as a primary tab bar item
- More menu: layout changed from two columns to a three-column grid (two rows of three)
- Search: embedded as a narrow bar at the top of the More sheet instead of a standalone bottom-nav button

## [0.37.0] - 2026-04-30

### Added
- Calendar: drag-and-drop file upload dropzone for event attachments (consistent with Documents module)
- Calendar: popup positioning now fully viewport-aware (flips above anchor if insufficient space below)

### Fixed
- Calendar: event attachments with raw base64 data (no `data:` prefix) now render correctly as images
- Calendar: "file too large" error is now shown correctly when saving an oversized attachment

### Changed
- Theme init script extracted from inline `<script>` to `/theme-init.js` for a stricter Content Security Policy (`'self'` only, no SHA hash)
- Modal overlay is now vertically centered on mobile (with safe-area insets) matching desktop behavior; rounded corners on all sides
- Modal `max-height` is computed from `100dvh` minus safe-area insets for accurate sizing on notched devices

## [0.36.1] - 2026-04-29

### Fixed
- Date input: default date format changed from US (`MM/DD/YYYY`) to day-month-year (`DD.MM.YYYY`) for new users
- Date input: dot-separated dates (`DD.MM.YYYY`) are now accepted in addition to slash-separated dates
- Date input: `dmy` placeholder and display format updated to use dots instead of slashes

## [0.36.0] - 2026-04-29

### Added
- Navigation: Kitchen (Meals/Recipes/Shopping) is now grouped as a single "Küche" entry in the desktop sidebar, consistent with the mobile bottom bar
- UX: empty states in Tasks, Notes, Contacts, Shopping, Recipes and Budget now include a primary CTA button that triggers the page FAB
- UX: `friendlyError(err)` helper added to `window.oikos`; unhandled promise rejections now show status-code-aware messages (offline, forbidden, not found, server error, timeout) instead of raw error text
- i18n: five new `common.error*` keys (offline, forbidden, notFound, server, timeout) added to all 15 locale files

### Changed
- Navigation: more-button icon changed from `grid-2x2` to `ellipsis` (matches the sheet it opens)
- Navigation: desktop sidebar expands labels at 1 280 px instead of 1 440 px
- UX: search overlay input field is now at the top, results below (standard top-to-bottom scan path)
- UX: touch targets for kitchen tabs and shopping list tabs raised to 44 px (iOS minimum)
- UX: dashboard metric values enlarged to `xl`/`bold` and labels styled as `2xs`/`uppercase` for clearer data hierarchy
- Onboarding: step 2 text and icon updated to accurately describe the navigation structure (···-button and module groups); step 3 text and icon updated to explain the FAB and swipe gestures

## [0.35.0] - 2026-04-29

### Added
- Settings: new admin-only "Backup Management" tab with database download and restore via file upload (drag-and-drop supported)
- API: admin-only endpoints `GET /api/v1/backup/database`, `POST /api/v1/backup/restore`, `GET /api/v1/backup/status`
- Database: `backupToFile()` and `restoreFromFile()` helpers with validation against Oikos schema and automatic pre-restore rollback copy
- CLI: `scripts/restore-backup.js` for operational restores outside Docker
- Docs: updated installation guide with Docker Compose backup/restore commands
- i18n: backup management keys added to all 15 locale files

## [0.34.1] - 2026-04-29

### Fixed
- Kitchen tabs bar disappeared after navigating to Shopping, because the page overwrote the container a second time after loading data

## [0.34.0] - 2026-04-29

### Added
- Navigation: new "Küche" (Kitchen) button in the bottom bar groups Meals, Recipes and Shopping behind a single entry point with a persistent tab bar inside each sub-module
- Navigation: new "Suche" (Search) button added to the bottom bar for one-tap access to the search overlay
- Kitchen tabs bar: sticky segment-control (Meals / Recipes / Shopping) injected at the top of each sub-module page; remembers the last active tab via sessionStorage
- Keyboard shortcuts: `g k` navigates to Kitchen (last tab), `g k m` → Meals, `g k r` → Recipes, `g k s` → Shopping
- i18n: `nav.kitchen`, `nav.search` and `shortcuts.goKitchen` keys added to all 15 locale files

### Changed
- Navigation: bottom bar reorganised — Dashboard, Calendar, Kitchen, Search, More (5 items)
- Navigation: Meals, Recipes and Shopping removed from the More sheet; they are accessible via the Kitchen tab bar and the sidebar on desktop
- More sheet: reduced from 3-column to 2-column grid for larger touch targets; search trigger removed
- More sheet: drag-handle added at the top; swipe-down gesture closes the sheet

## [0.33.1] - 2026-04-29

### Changed
- Navigation: removed the dedicated Search button from the bottom bar; the bottom bar now shows three primary module links plus the More button
- Navigation: the More sheet now opens with a full-width pill-shaped search trigger at the top, replacing the grid-cell search item
- Search: the search overlay input field is now positioned at the bottom of the screen (thumb zone) instead of the top

## [0.33.0] - 2026-04-29

### Added
- Calendar: overlapping timed events in week and day views now render side-by-side using a column-layout algorithm instead of stacking on top of each other
- Calendar: events support optional file attachments (images, PDFs, and office documents up to 5 MB); images are shown inline in the event popup, other files as a download link
- Birthdays: redesigned edit modal with photo avatar and name/date fields displayed side by side

### Fixed
- Calendar: attachment i18n keys are fully translated in all 15 locales (German translation added; Portuguese diacritics corrected)

## [0.32.3] - 2026-04-29

### Added
- Typography: Plus Jakarta Sans variable font (200–800 weight) self-hosted under `public/fonts/` — consistent branding across all platforms with no CDN dependency at runtime
- Dashboard: visual hierarchy for primary widgets — Tasks and Calendar always span two columns; Weather and Shopping span two columns at the three-column breakpoint only
- Dashboard: subtle accent border on primary (wide) widgets using the active module accent colour

### Changed
- Module toolbars (Tasks, Notes, Calendar, Contacts, Shopping) are now sticky — they remain visible at the top while scrolling long lists

### Fixed
- Sticky toolbars: changed `overflow: hidden` to `overflow: clip` on Calendar, Notes, Contacts, and Shopping page roots so `position: sticky` works correctly on child toolbar elements
- Dashboard: explicit `grid-column: span 1` for secondary widgets at the 768 px (two-column) breakpoint to prevent implicit layout jumps

## [0.32.2] - 2026-04-29

### Changed
- Bottom navigation restructured: Dashboard, Tasks, Calendar as first three primary slots; Search promoted to a dedicated fourth bottom-nav button (no longer buried in the More sheet)
- Sidebar tooltips added for the collapsed mode (1024–1439 px) — hovering an icon now shows a label tooltip so module names remain discoverable without expanding the sidebar

## [0.32.1] - 2026-04-29

### Fixed
- i18n: complete documents and tasks translations for all 15 locales — gridView, listView, viewToggle, file labels, action labels, toast messages, status labels, and the five new tasks keys (statusArchived, archiveButton, archivedToast, kanbanArchived, reminderNeedsDueDate) were untranslated in all non-English locales (#103)

## [0.32.0] - 2026-04-29

### Added
- Documents: new Family Documents module — upload, search, and manage family files (PDF, images, text, Office) with grid/list view, per-document visibility (family, selected members, private), category tagging (medical, school, identity, insurance, finance, home, vehicle, legal, travel, pets, warranty, taxes, work, other), archive/restore, and download actions (#104)
- Documents: drag-and-drop upload area in the new-document modal (#104)
- Tasks: archive button on task cards; archived status supported in kanban view and filter (#104)
- Tasks: inline reminder preset UI — offset from due date/time with 15 min, 1 h, 1 d, 2 d, 1 w, 2 w, or custom offset presets (#104)
- i18n: Documents and updated Tasks keys translated in all 15 locales

### Fixed
- Modal: discard-changes confirmation no longer corrupts overlay state when a confirm dialog is triggered from within another modal (#104)
- RRule: "Until" date field moved inside the recurrence options row for better layout (#104)

## [0.31.2] - 2026-04-29

### Added
- Settings: edit button (pencil icon) on each ICS subscription row — opens a modal to update name, color, and shared visibility via the existing PATCH endpoint (#100)

## [0.31.1] - 2026-04-29

### Fixed
- Settings: birthday date fields (profile, new member, edit member) now use the native date picker on iOS
- Birthdays: birth date field now uses the native date picker on iOS

## [0.31.0] - 2026-04-29

### Added
- Family: phone, email, and birthday fields on family member records, automatically synced to Contacts and Birthdays
- Settings: dedicated "Family Management" tab (admin-only) for managing family members including contact details
- Settings: dedicated "API Tokens" tab (admin-only) for token management
- Calendar: local tooth SVG icon for dentist events replaces the drill icon (migration 24 restores tooth icon for existing events)
- i18n: `reset`, `tabFamily`, `tabApiTokens`, and family member field keys translated in all 15 locales

### Changed
- Settings: avatar editor uses icon buttons instead of a file input label for a cleaner UX
- Settings: tab bar constrained to standard app width so all tabs fit in one row on desktop
- Family members page moved from Account tab to its own Family tab (admin only); Account tab stays focused on personal profile and password

### Fixed
- Theme toggle: `data-theme` attribute removed when reset to system default (previously left stale)
- Calendar: dentist icon normalised — `tooth` is now the canonical stored value (`drill` accepted as alias for backwards compatibility)
- i18n: missing translations for family member fields added to ar, el, es, fr, hi, it, ja, ru, sv, tr, uk, zh

## [0.30.3] - 2026-04-28

### Changed
- Birthdays: all family members can now view, edit, and delete any birthday entry regardless of who created it

## [0.30.2] - 2026-04-28

### Fixed
- Calendar: date inputs in the event modal reverted from `type="text"` to `type="date"`, restoring the native date picker on iOS and other mobile browsers

## [0.30.1] - 2026-04-28

### Fixed
- i18n/el: corrected typo `Διδαγραφή` → `Διαγραφή` in `recipes.deleteConfirm` (fix was missing from v0.30.0 release build)

## [0.30.0] - 2026-04-28

### Added
- i18n: recipe strings translated in 13 locales (ar, el, es, fr, hi, it, ja, pt, ru, sv, tr, zh, uk) — contributed by @baragoon
- i18n: `emptyHint.recipes` added to all updated locales; Ukrainian locale additionally gains full `emptyHint` translations for all modules
- i18n: `nav.recipes` translated in all 13 locales

## [0.29.3] - 2026-04-28

### Fixed
- Dashboard: weather widget background gradient was overridden by the higher-specificity `.dashboard .widget { background: var(--color-surface) }` rule, causing white text on a white background in light mode

## [0.29.2] - 2026-04-28

### Changed
- Docs: SPEC updated with Reminders, Birthdays, and Family Management tables and module sections; Users table reflects `family_role` and `avatar_data` columns
- Docs: README lists Reminders and Birthdays in the feature tagline and Highlights section
- Docs: BACKLOG completed-features table brought up to date through v0.29.1

## [0.29.1] - 2026-04-28

### Changed
- Dependency: `express-rate-limit` updated from 8.3.2 to 8.4.1

## [0.29.0] - 2026-04-28

### Added
- Calendar: events can now have a custom icon chosen from 102 validated Lucide icons via a visual icon picker — icon is persisted in the database (`calendar_events.icon`)
- Calendar: reminders now offer additional presets (2 days, 1 week, 2 weeks before) plus a fully custom option with configurable number and time unit (minutes/hours/days/weeks)
- Calendar: birthday events are automatically assigned the `cake` icon when synced to the calendar
- i18n: new reminder preset and custom-reminder labels added to all 16 locales

### Changed
- Calendar, Tasks, Meals, Birthdays, Budget: date inputs now use locale-aware text fields (respecting the user's configured date format: MDY / DMY / YMD) instead of native `<input type="date">` — inputs auto-correct format on blur
- Calendar: `formatDate` inside the module now delegates to the i18n-aware `formatDate` from `i18n.js` for consistent locale formatting across all views

### Fixed
- Calendar: dentist icon `tooth` (unavailable in Lucide) replaced by `drill`; existing events with `icon = 'tooth'` are migrated to `drill` via migration 22
- Calendar: reminder `remind_at` is now calculated correctly for all-day events (uses `T09:00` as base time instead of midnight)

### Database
- Migration 21: `ALTER TABLE calendar_events ADD COLUMN icon TEXT NOT NULL DEFAULT 'calendar'`
- Migration 22: normalizes legacy `tooth` icon values to `drill`

## [0.28.1] - 2026-04-27

### Fixed
- Google Calendar: `upsertGoogleEvents` used `db.transaction()` instead of `db.get().transaction()`, causing a `TypeError: Cannot read properties of undefined (reading 'status')` on every initial sync — no events were imported

## [0.28.0] - 2026-04-27

### Added
- Navigation: sidebar nav items now show a native tooltip in the icon-only breakpoint (1024–1279 px), making all 11 modules discoverable without labels
- PWA: offline banner appears at the top of the screen when the device loses connectivity, and hides automatically when the connection is restored
- Desktop: global keyboard shortcuts — `/` (search), `n` (new), `?` (shortcut overview), `g d/t/c/s/n` (navigate to module)
- Dashboard: widget order is now adjustable via drag-and-drop in the Customize modal; order is persisted in user preferences
- UX: `deleteWithUndo` utility in `ux.js` — birthdays deletion now offers an undo toast identical to tasks, notes, contacts, and meals
- UX: contextual onboarding hints added to empty states in all modules (tasks, contacts, notes, budget, shopping, birthdays, recipes)

### Changed
- Dashboard: widget title icons use `--color-text-secondary` instead of the module accent color, reducing visual noise when all widgets are visible
- Performance: `reminders.css` is now lazy-loaded on demand instead of being included in every page load

### Fixed
- UI: modal close button increased from 40 px to 44 px to meet Apple HIG minimum tap target
- UI: `.widget__link` elements now have a 44 px minimum touch target height with correct padding
- CSS: removed dead `.fab` CSS block — all pages use `.page-fab`
- UX: toasts can now be dismissed by swiping horizontally (> 40 px)

## [0.27.1] - 2026-04-27

### Fixed
- Google Calendar: null/undefined items returned by the Google API are now skipped instead of crashing the sync with a `TypeError`
- Google Calendar: the OAuth callback now awaits the initial sync before redirecting, so sync failures are correctly shown as an error in the UI instead of a false success

## [0.27.0] - 2026-04-27

### Added
- Settings: family roles (Dad, Mom, Parent, Child, Grandparent, Relative, Family member) are now separate from system access roles — each family member can have a descriptive family role independent of their admin status
- Settings: profile picture upload for the current user (PNG, JPEG, WebP; auto-resized to 512 px on the client side)
- Settings: admin users can now edit existing family member profiles (name, username, family role, system-admin flag, color, profile picture) via a new Edit button on each member row
- Settings: new System admin checkbox replaces the Admin/Member role dropdown when creating a new family member
- Dashboard: family widget avatars now display profile pictures when available
- API: new read-only `GET /api/v1/family/members` endpoint listing family members without exposing usernames or system roles
- API: `PATCH /api/v1/auth/users/:id` — admin endpoint to update any family member's profile
- API: `PATCH /api/v1/auth/me/profile` — self-service endpoint to update own display name, color, and profile picture
- i18n: new locale keys for all new UI strings across all 16 supported languages

## [0.26.5] - 2026-04-27

### Changed
- Birthdays: increased maximum photo upload size from ~0.9 MB to 5 MB

## [0.26.4] - 2026-04-27

### Changed
- Dashboard: weather widget is now the first entry in the default widget order
- Dashboard: widgets in the same grid row now share the same height (via flex stretch), eliminating the patchwork gaps between shorter and taller widgets

## [0.26.3] - 2026-04-27

### Fixed
- Birthdays: "Discard changes?" dialog appeared immediately after successfully saving a birthday because `closeModal()` was called without `force: true`, triggering the dirty-form check on a programmatic close
- Dashboard (PWA): widget items (tasks, events, meals, notes, birthdays, shopping lists) occasionally blocked vertical swipe-to-scroll; added `touch-action: pan-y` so the browser passes vertical pan gestures through to the scroll container

## [0.26.2] - 2026-04-27

### Fixed
- Dashboard: KPI summary bar removed — it duplicated the same widget categories (tasks, calendar, birthdays…) that are already visible as full widgets directly below
- Dashboard: replaced the two-column main/side workspace layout with the established flat responsive grid so all widgets are consistently left-aligned across all screen sizes in the web view

## [0.26.1] - 2026-04-27

### Fixed
- Dashboard: `path is not defined` crash on every navigation — `renderPage()` referenced a bare `path` variable instead of `route.path`
- Dashboard: shopping lists widget caused a server-side SQL error (`HAVING` clause on non-aggregate query) resulting in an empty widget for all users

## [0.26.0] - 2026-04-27

### Added
- Birthdays module: track family birthdays with name, birth date, optional photo and notes; each entry is automatically synced to the calendar as a yearly recurring event and to the reminder system
- Birthdays dashboard widget: shows the next upcoming birthdays at a glance with age and days-until labels
- Family Participants dashboard widget: displays the number of users added to the family with avatar initials
- Budget Overview dashboard widget: shows monthly income, expenses, balance, savings rate and top expense category
- Dashboard widget customisation extended to include the three new widgets (birthdays, budget, family)
- Settings › General: admin option to set a custom application name shown in the sidebar, browser title and login screen
- Birthday translations across all 16 supported locales

### Changed
- Service worker: mutable JS and CSS assets now use network-first caching to eliminate stale-asset issues after deployments

## [0.25.8] - 2026-04-27

### Fixed
- Test suite: `makeInput` mock in `test-modal-utils.js` now implements `setAttribute`/`removeAttribute` so blur-validation tests correctly verify the new `aria-invalid` attribute behaviour

## [0.25.7] - 2026-04-27

### Added
- Navigation: a dedicated screen-reader announcer (`aria-live="polite"`) announces the page name on every route change instead of reading the entire page content

### Changed
- Color pickers (notes, calendar): swatches now use `role="radiogroup"` with localized color names instead of hex codes, `aria-checked` reflects the selected state, and Arrow keys navigate between options
- Navigation badges: badge counts are now hidden from screen readers (`aria-hidden`); the parent nav link's `aria-label` is updated to include the count in plain text (e.g. "Aufgaben, 3 überfällig")
- Main content area: removed `aria-live="polite"` from `<main>` — it was causing screen readers to read the full page on every navigation

### Fixed
- Form validation: `aria-invalid="true"` is now set on invalid inputs in all modals and on the login form so screen readers can announce field errors

## [0.25.6] - 2026-04-27

### Changed
- Tasks: completing a task now animates the strikethrough line instead of snapping it on instantly
- Modal: save button shows a spinner during async API calls; the spinner disappears immediately if form validation fails, and on API error when the button is re-enabled
- Toast: the Undo button now gives tactile press feedback (scale + removes browser tap highlight) for reliable interaction within the 5-second window

## [0.25.5] - 2026-04-26

### Added
- Navigation: the "More" button now shows the name and icon of the active secondary module instead of the generic label, making it clear which module is open
- Dashboard: first-time onboarding overlay guides new users through the app's three core navigation areas

### Changed
- Navigation: renamed "Pinnwand" to "Notizen" for clarity
- Login: submit button shows a spinner during authentication; empty fields are highlighted individually with red borders instead of a single generic error message

### Fixed
- Modal: closing a modal when the form has unsaved changes no longer double-fires the guard due to a missing `_isClosing` flag; the close button now uses an arrow-function listener to avoid stale closure issues

## [0.25.4] - 2026-04-26

### Added
- Modal: closing a modal (via Escape, swipe, overlay click, or X button) now shows a "Discard changes?" confirmation dialog when the form has been modified since it was opened; saving or deleting bypasses the prompt

## [0.25.3] - 2026-04-26

### Changed
- Delete actions in all seven modules (tasks, notes, budget, calendar, contacts, meals, recipes) and shopping list deletion no longer show a confirmation dialog; instead the item is removed immediately and a toast with an Undo button gives a 5-second window to reverse the action before the API call is made

## [0.25.2] - 2026-04-26

### Changed
- Docs: `SPEC.md` updated to reflect all changes since v0.24.0 — Budget Entries table now documents `subcategory` column and DB-backed `category` FK; new `Budget Categories`, `Budget Subcategories`, and `API Tokens` data-model tables added; Settings section updated with API Tokens tab, corrected language list (added Japanese, Arabic, Hindi, Portuguese), and tab count (six → seven); Budget module section now covers subcategories, custom categories, and all new endpoints; new API Documentation section documents OpenAPI 3.0 spec and authentication options; design tokens `--blur-2xs` and `--module-reminders` added to Colors section
- Docs: `README.md` Highlights updated — Budget Tracking now mentions DB-backed subcategories; new API Tokens entry added

## [0.25.1] - 2026-04-26

### Changed
- Dashboard: empty widget states now render as a compact inline row (icon + text) instead of a centred column, saving ~40px of vertical space per empty widget on mobile

### Fixed
- Dashboard: widget body bottom padding increased from 12px to 16px for slightly more breathing room
- Dashboard: widget reordering in "Anpassen" modal now uses the View Transition API for smooth animations; respects `prefers-reduced-motion`

## [0.25.0] - 2026-04-25

### Added
- API token authentication: admins can create named Bearer / X-API-Key tokens for external integrations; tokens are SHA-256-hashed at rest, support optional expiry and revocation, and track last-used timestamp
- Settings: new "API Tokens" section for admins to create and revoke tokens; the full token value is shown only once immediately after creation
- OpenAPI 3.0 specification served at `/api/v1/openapi.json` and `/openapi.json` (download via `?download=1`)
- Budget: new endpoints `GET /api/v1/budget/categories` and `GET /api/v1/budget/categories/:key/subcategories` with optional `?lang=` localisation

### Changed
- `server/logger.js` now serialises `Error` objects into structured JSON fields (name, message, stack) instead of logging `{}`

## [0.24.4] - 2026-04-26

### Added
- Accessibility: `layout.css` now has a `@media (prefers-contrast: more)` block — ghost and secondary buttons get explicit borders, cards lose decorative shadows, form inputs get a 2px border, focus rings become thicker (3px, 4px offset), and active nav items get an underline as a colour-independent indicator

### Fixed
- Design tokens: corrected `--sidebar-width-expanded` comment from `1280px+` to `1440px+` to match the actual breakpoint in `layout.css`

## [0.24.3] - 2026-04-26

### Added
- Design tokens: `--blur-2xs: blur(2px)` added to the blur scale — fills the gap below `--blur-xs` (4px), used for subtle overlay blurs
- Design tokens: `--module-reminders: #0E7490` (Cyan-700, WCAG AA) added for the reminders feature; dark mode variant `#22D3EE` (Cyan-400)

### Fixed
- Design tokens: hardcoded `blur(16px)`, `blur(2px)`, and `blur(12px)` in `layout.css` replaced with `var(--blur-md)`, `var(--blur-2xs)`, and `var(--blur-sm)` — `prefers-reduced-transparency` now correctly disables all backdrop-filter effects including bottom nav, more-sheet backdrop, and sticky headers
- Accessibility: `layout.css` now has a `prefers-reduced-transparency` block for `.nav-bottom`, `.more-backdrop`, and `.sticky-header` — these three elements previously kept their backdrop-filter active even when the user requested reduced transparency
- Reminders: reminder bell icon in toasts now uses `var(--module-reminders)` instead of the generic `var(--color-accent)`

## [0.24.2] - 2026-04-26

### Fixed
- Design tokens: added missing `--shadow-xl` and `--shadow-xs` tokens (with dark mode variants) — resolves undefined CSS custom property references in kanban drag ghost and dashboard widget toggle
- Design tokens: `--color-surface-raised` replaced with `--color-surface-hover` in `dashboard.css` — was undefined, causing unstyled hover states in the widget customizer
- Design tokens: `--color-text` replaced with `--color-text-primary` in `dashboard.css` — was undefined, causing invisible text on hover in the widget customizer
- Design tokens: hardcoded `font-weight` values (`700`, `500`, `600`) in `reminders.css` replaced with `--font-weight-bold`, `--font-weight-medium`, `--font-weight-semibold`

## [0.24.1] - 2026-04-25

### Fixed
- Accessibility: skip-to-content link added to `index.html` — keyboard users can now bypass navigation and jump directly to main content
- Accessibility: removed `role="presentation"` from modal overlay — restores screen reader access and resolves conflict with existing `aria-label`
- Accessibility: search overlay now traps keyboard focus — tabbing can no longer escape the overlay into the hidden page behind it
- Interaction: modal swipe-to-close — kept `dragging` flag active on upswing so the panel snaps back correctly instead of getting stuck
- Rendering: SVG gradient IDs in the logo are now unique per render — prevents DOM ID collisions when the logo is mounted more than once
- Touch targets: `.btn--icon-sm` minimum size raised from 36×36px to 44×44px (`--target-base`) — meets iOS minimum touch target guideline
- Design tokens: added `--target-base: 44px` and documented `--target-sm: 32px` as visual-only (not a touch target)

## [0.24.0] - 2026-04-25

### Added
- Budget: expense categories are now stored in the database (`budget_categories` table) as stable English slugs, replacing hardcoded German strings
- Budget: subcategory support for all expense entries — 35 predefined subcategories across 8 top-level categories (housing, food, transport, personal_health, leisure, shopping_clothing, education, financial_other)
- Budget: users can add custom categories and subcategories directly from the entry modal via inline "+ category" / "+ subcategory" buttons
- Budget: new API endpoints `POST /api/v1/budget/categories` and `POST /api/v1/budget/categories/:key/subcategories` for custom category/subcategory creation
- Budget: subcategory displayed alongside category in each entry's metadata line
- Budget: CSV export now includes a subcategory column and English column headers
- i18n: all 14 non-German locales extended with new budget category keys (`catHousing`, `catTransport`, `catPersonalHealth`, `catShoppingClothing`, `catFinancialOther`) and all 35 subcategory label keys
- All server-side log messages and API error strings translated from German to English — contributed by @rafaelfoster

### Changed
- Budget category labels for existing entries migrated to new slug keys via DB migration 15; display names remain fully localised through the i18n system

## [0.23.17] - 2026-04-25

### Fixed
- Italian (it) locale: translated all missing strings in the recipes section (`nav.recipes`, `meals.savedRecipeLabel`, `meals.savedRecipePlaceholder`, `meals.saveAsRecipe`, `meals.recipeScaleLabel`, and all `recipes.*` keys) — contributed by @albanobattistella

## [0.23.16] - 2026-04-24

### Changed
- Design tokens: replaced all remaining hardcoded color and size values in `layout.css`, `glass.css`, `dashboard.css`, and `reminders.css` with CSS custom properties
- Design tokens: added `--text-2xs`, `--color-overlay-glass`, `--color-backdrop-glass`, `--glass-border-overlay`, `--glass-highlight-mid`, `--glass-inset-bottom-base`, `--glass-inset-bottom-hover`, `--glass-inset-thumb`, and `--glass-inset-input` to `tokens.css`

## [0.23.15] - 2026-04-24

### Fixed
- All non-German locales (ar, el, en, es, fr, hi, it, ja, pt, ru, sv, tr, uk, zh): added missing translation keys for `nav.more`, `calendar.ics.reset/resetToast`, `settings.ics.*`, `tasks.filter*`, `tasks.swiped*`, `search.*`, and `reminders.*` — these were falling back to German strings for all non-German users

## [0.23.14] - 2026-04-23

### Fixed
- Swedish (sv) locale: corrected five translation errors in the recipes section (`titleRequired`, `copySuffix`, `urlLabel`, `openLink`, `emptyDescription`) — contributed by @olsson82

## [0.23.13] - 2026-04-22

### Security
- Installer: replaced template-literal URL construction with the `URL` constructor when setting the final "Open Oikos" link, eliminating a potential DOM-based XSS vector (CodeQL js/xss-through-dom, GitHub Advisory #7)

## [0.23.12] - 2026-04-22

### Fixed
- iOS PWA: bottom navigation bar gap resolved by removing `overflow: hidden` from `<html>` (iOS Safari bug: this property clips `position: fixed` descendants) and restoring the `body::after` fill approach; nav bar height is no longer inflated by the safe area padding

## [0.23.11] - 2026-04-22

### Fixed
- iOS PWA: bottom navigation bar now extends into the home indicator safe area via `padding-bottom: env(safe-area-inset-bottom)`, reliably eliminating the gap at the screen bottom

## [0.23.10] - 2026-04-22

### Fixed
- iOS PWA: safe area fill now uses the same surface color as the bottom navigation bar, so it matches in both light and dark mode

## [0.23.9] - 2026-04-22

### Fixed
- iOS PWA: a `body::after` pseudo-element now fills the home indicator safe area with the same glass background as the bottom navigation, eliminating the gap between the nav bar and the screen edge

## [0.23.8] - 2026-04-22

### Fixed
- iOS PWA: bottom navigation bar now extends into the home indicator safe area, removing the gap between the nav and the screen edge

## [0.23.7] - 2026-04-22

### Fixed
- Navigation: sidebar logo now uses the official `docs/logo.svg` artwork (house + chimney on gradient background) instead of a generic Lucide home icon; gradient colors are driven by CSS tokens

## [0.23.6] - 2026-04-22

### Changed
- Dashboard: greeting widget now adapts its gradient to the time of day — warm amber-orange in the morning (before 11:00), indigo during the day, and violet in the evening (after 18:00)
- Dashboard: FAB speed-dial open/close rotation now uses a spring cubic-bezier for a more natural feel
- Navigation: sidebar logo is now a proper SVG house icon on a gradient background instead of the CSS letter placeholder

## [0.23.5] - 2026-04-22

### Changed
- Dashboard: each widget now uses its module accent color (green for tasks, violet for calendar, orange for meals, pink for shopping, amber for notes) for its header icon, badge, and link instead of the global indigo accent
- Dashboard: meal slots now display their type-specific color (amber for breakfast, green for lunch, indigo for dinner, orange for snack) on icon and label when a meal is planned
- Dashboard: pinned note cards now show a subtle background tint matching the note's color
- Dashboard: widget and card hover lift increased from 1 px to 2 px for more perceptible feedback on desktop
- Navigation: active bottom-nav tab now shows a pill-shaped highlight behind the icon for a clearer location indicator
- Shopping widget: progress bar height increased from 4 px to 6 px for better visual weight
- Empty state icons inside widgets now use the tertiary text color instead of the disabled color for improved visibility

## [0.23.4] - 2026-04-22

### Changed
- Docs: web installer (`node tools/installer/install-server.js`) is now Option A in all installation guides (`README.md`, `docs/installation.md`, GitHub Pages `docs/install.html`); the pre-built Docker image method is relabelled Option B and the build-from-source method Option C

## [0.23.3] - 2026-04-22

### Fixed
- Weather widget: wind speed is no longer multiplied by 3.6 when `OPENWEATHER_UNITS=imperial` (the API already returns mph; the conversion was only correct for metric/standard)
- Weather widget: wind unit label now shows `mph` for imperial and `km/h` for metric/standard instead of always showing `km/h`

## [0.23.2] - 2026-04-22

### Fixed
- Calendar: ICS-synced events now render at the correct local hour and day in week/day/month/agenda views; day-matching and hour-positioning previously used raw string slices which returned UTC values instead of browser-local time for events stored with a `Z` suffix

## [0.23.1] - 2026-04-22

### Security
- Installer: host and port inputs are now validated against a strict hostname regex and integer range check (1–65535) before being used in any DOM sink or URL template — prevents XSS-through-DOM (CodeQL js/xss-through-dom alert #7)

## [0.23.0] - 2026-04-21

### Added
- Calendar: `external_calendars` DB table (migration v14) stores display name and color per synced Google/Apple calendar; `calendar_events` gains a `calendar_ref_id` FK used for join-based name/color lookup in all calendar and dashboard queries
- Calendar: Google and Apple sync services now fetch the calendar's display name and background color via `upsertExternalCalendar()` and persist them to the new table
- Calendar: event popup, agenda, month, week, and day views now show the external calendar name as a colored `event-cal-label` badge when `cal_name` is present
- Calendar: event popup and dashboard events list now display the event location using `fmtLocation()` which strips RFC 5545 backslash-escapes (`\n`, `\,`, `\;`, `\\`) and normalizes semicolons/newlines to comma-separated inline text
- Utils: `fmtLocation(raw)` helper added to `html.js` for normalizing ICS `LOCATION` property strings
- i18n: task due-date keys (`tasks.overdue`, `tasks.dueSoon`, `tasks.dueToday`, `tasks.dueTomorrow`, `tasks.noDueDate`) added to all 16 supported locale files

### Changed
- Dashboard: widget headers flattened — glass card replaced with transparent surface + bottom border; clock icon added to the urgent-tasks chip; overdue and due-soon counts computed separately using `effectiveDue()` for accuracy
- Glass toolbar (desktop ≥ 1024 px): rounded card style (`border-radius`, full `border`) replaced with flat background + `border-top: 3px solid var(--module-accent)` + bottom border only, consistent with other page toolbars
- Shopping and Budget page headers: `border-top: 3px solid var(--module-accent)` accent stripe added to `.list-tabs-bar` and `.budget-nav`, matching the visual language of all other module headers
- Calendar agenda: event color indicator changed from a 10 px circle to a 3 px full-height left bar (`width: 3px; align-items: stretch`), matching the dashboard upcoming-events style
- Tasks: filter panel now defaults to `status: 'open'` on first load instead of showing all tasks including completed ones
- SW cache: bumped to `oikos-shell-v50` / `oikos-pages-v45` / `oikos-assets-v45`

### Fixed
- Tasks / Dashboard: sort order now strictly follows effective due date ascending; overdue tasks (due date+time in the past) always surface first in all views — list groups, Kanban columns, and the dashboard urgentTasks widget. Priority is used only as a tiebreaker for tasks sharing the same due datetime. Server-side sort moved from SQL to JavaScript using `effectiveDue()` for timezone-correct `due_time` handling (SQLite `DATE('now')` is UTC-only)
- Tasks: due date chip now shows the time component when `due_time` is set; overdue/soon/today/tomorrow states are computed against the current moment rather than midnight
- Dashboard: widget navigation links changed from `<a href>` to `<button type="button">` to prevent iOS Safari from intercepting touch events before the JS click handler fires; `.widget__header` given `position: relative; z-index: 2` to lift it above the backdrop-filter `::after` pseudo-element stacking context
- Dashboard: FAB shortcut buttons now programmatically click the page's primary add-button after navigation, opening the new-item modal directly without requiring a second tap
- Calendar: week-view allday row no longer stretches column widths when event titles are long — `.allday-cell` now has `min-width: 0; overflow: hidden` to constrain grid cells that would otherwise expand to fit `white-space: nowrap` content
- Calendar: incorrect `|| 'var(--color-accent)'` color fallback removed from all five event rendering sites in month, week, allday, and popup views; events without a color now render without an inline `background-color` declaration
- Modal: sheet swipe adds a 10 px dead zone before the `translateY` transform is applied, preventing involuntary micro-transforms on normal taps; the `style.transform = ''` reset in `touchend` is deferred via `requestAnimationFrame` so iOS WebKit does not cancel the subsequent `click` event on child buttons — fixes delete-confirm and edit buttons not responding after a partial swipe
- Modal: `_doClose` now receives and captures the overlay element before any animation; prevents a race condition where opening a new modal (e.g. a confirm dialog) before the previous close animation finished caused `_doClose` to remove the new modal and leave its buttons permanently unresponsive
- Router: page auto-reloads 8 s after the SW-update toast is shown, matching the toast's own display duration so the reload is never missed
- Layout: modal overlay uses `overflow: hidden` and bottom-sheet scroll container uses `overflow-x: hidden` to prevent horizontal scroll bleed on narrow viewports; form inputs get `min-width: 0; box-sizing: border-box` to prevent overflow out of two-column grid containers
- Reminders: field grid changed from `1fr 1fr` to `repeat(2, minmax(0, 1fr))` to prevent content from exceeding the grid track width
- PWA: double `padding-bottom` on PWA bottom nav removed — the safe-area padding in `pwa.css` was applied twice, causing an extra gap on iPhone safe-area screens

## [0.22.3] - 2026-04-21

### Fixed
- Landing page setup commands now render with correct line breaks. The `.code-block` element has no `white-space: pre`, so explicit `<br>` tags are required; they were previously missing, causing all commands to flow as a single line.
## [0.22.2] - 2026-04-21

### Fixed
- Locale file (`de.json`) no longer causes a JSON parse error that made the app completely unusable. The `recipes.deleteConfirm` value contained a bare ASCII double-quote inside a JSON string, which prematurely terminated the string and broke every page load.
- ICS calendar subscriptions now respect the `COUNT` parameter in RRULE (RFC 5545). Previously, events with a limited number of occurrences (e.g. `RRULE:FREQ=WEEKLY;COUNT=3`) were incorrectly shown as upcoming because the expansion loop iterated to the sync window end regardless of the occurrence limit.

## [0.22.1] - 2026-04-21

### Fixed
- App no longer gets stuck on the "Oikos" splash screen when opened in a new tab. Two root causes addressed: (1) `sw.js` was not updated in v0.22.0, so the browser kept the old Service Worker and served stale cached files (old `router.js`, `meals.js`) via Stale-While-Revalidate — cache versions are now bumped (shell v35, pages v30) to force reinstallation and fresh file delivery. (2) A fatal error in `initI18n()` (e.g. locale fetch failure offline) left the splash screen visible forever — the router IIFE now catches such errors, hides the splash screen, and renders a recoverable error state.
- Service Worker now pre-caches `/pages/recipes.js` and `/styles/recipes.css` introduced in v0.22.0, enabling offline access to the Recipes page.

## [0.22.0] - 2026-04-21

### Added
- Recipes module: create, edit, duplicate, and delete reusable recipes with title, notes, a recipe link, and a per-ingredient category. Accessible via the new `/recipes` route and nav entry.
- "Add to meal plan" action on recipe cards navigates to Meals and pre-fills the modal with the selected recipe.
- Meals modal: select a saved recipe to auto-fill title, notes, URL, and ingredients; scale ingredient quantities by a numeric factor; save the current meal as a new recipe in one click.
- `GET/POST /api/v1/recipes`, `PUT/DELETE /api/v1/recipes/:id` REST endpoints with full validation and ingredient sync.
- Migration 13: `recipes` and `recipe_ingredients` tables; `recipe_id` FK column on `meals`.

## [0.21.1] - 2026-04-21

### Fixed
- ICS calendar subscription sync no longer fails with "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint". Migration 12 replaces the partial unique index on `(subscription_id, external_calendar_id)` with a full unique index, which SQLite's upsert conflict-target syntax requires.

## [0.21.0] - 2026-04-21

### Added
- `POST /api/v1/auth/setup` bootstrap endpoint: creates the first admin user when the users table is empty, enabling first-run setup in Docker without shell access to the container volume. Returns 403 once any user exists.
- `install.sh`: interactive CLI wizard (7 steps) guiding users from a blank server to a running Oikos instance — prerequisites check, domain/port/timezone config, auto-generated or manual security secrets, optional weather and calendar integrations, Docker startup with health polling, and admin account creation. Supports `--env-file` for non-interactive/CI deployments.
- Web installer (`tools/installer/`): browser-based setup wizard served by a zero-dependency Node.js server on `localhost:8090`. Covers the same steps as the CLI installer through a single-file SPA. Auto-terminates after successful setup or 30 minutes of inactivity.

## [0.20.43] - 2026-04-21

### Added
- `POST /api/v1/auth/setup` bootstrap endpoint: creates the first admin user when no users exist, enabling Docker-based deployments to initialise via HTTP without direct filesystem DB access. Returns 403 once any user exists.

## [0.20.42] - 2026-04-21

### Added
- `.claude/` tooling committed with the repo: skills (`release-prep`, `fix-issue`, `pr-review`, `issue-triage`), subagents (`pr-reviewer`, `repo-auditor`), path-scoped rules (`server-routes`, `public-pages`, `tests`, `db-migrations`), and a PostToolUse hook (`block-innerhtml.sh`) that enforces the innerHTML ban on save. Contributors using Claude Code now get the same guardrails and workflows automatically.

### Changed
- `.gitignore`: no longer excludes the entire `.claude/` directory — only `.claude/settings.local.json` and `.claude/worktrees/` stay out, so shared tooling is versioned while local permissions remain private.

## [0.20.41] - 2026-04-21

### Fixed
- Race condition in `router.js`: when `auth.me()` failed during initial navigation, `_pendingLoginRedirect` was not cleared before calling `navigate('/login')` from the catch block, causing the `finally` handler to launch a second concurrent navigation. If the second navigation was still in progress when the user submitted the login form, `navigate('/', user)` was silently blocked — login appeared to succeed but the dashboard never loaded (most noticeable on iOS Safari PWA with iCloud Keychain autofill)

### Added
- Version number displayed on the login page (fetched from new `GET /api/v1/version` endpoint, no auth required), so users can verify which release their PWA is running

## [0.20.40] - 2026-04-21

### Changed
- `docs/SPEC.md` Design System → Colors: replaced outdated code block with current Indigo-based palette (`#4F46E5` primary, module color semantics, priority/severity separation, dark mode Indigo-400 accent, `--glass-inset-*` specular tokens); added palette rationale and WCAG contrast notes inline

## [0.20.39] - 2026-04-21

### Changed
- `docs/SPEC.md`: document `ics` as a valid `external_source` value, add `subscription_id` and `user_modified` columns to Calendar Events data model, add ICS Subscriptions table definition, expand Calendar module section with ICS subscription feature details, update Settings section
- `README.md`: update Calendar Sync highlight to mention ICS/webcal URL subscriptions

## [0.20.38] - 2026-04-21

### Added
- ICS-URL calendar subscriptions: any user can subscribe to external calendars via HTTPS or webcal:// URL
- Per-subscription visibility (private or shared with all family members), custom color, and manual sync trigger
- REST API: `GET/POST /api/v1/calendar/subscriptions`, `PATCH/DELETE /api/v1/calendar/subscriptions/:id`, `POST /api/v1/calendar/subscriptions/:id/sync`
- `POST /api/v1/calendar/:id/reset` endpoint to clear `user_modified` on ICS events, allowing the next sync to restore upstream data
- ICS visibility filter on `GET /api/v1/calendar` and `/upcoming`: private subscription events are hidden from other users
- ICS subscription management card in Settings → Kalender tab (below Apple Calendar): subscription list with color dot, visibility badge, last-sync timestamp; inline add form with URL, name, color picker, and shared toggle; sync and delete actions
- "Auf Original zurücksetzen" link in calendar event popup for user-modified ICS events
- `user_modified = 1` is set automatically when any externally-sourced event (ICS, Google, Apple) is edited by the user
- ICS sync integrated into the periodic `runSync()` scheduler alongside Google and Apple Calendar
- All new UI strings in `public/locales/de.json` under `settings.ics.*` and `calendar.ics.*`

## [0.20.37] - 2026-04-20

### Added
- `server/services/ics-subscription.js`: core ICS subscription service with SSRF-protected fetch (DNS pre-resolution against private IP ranges), ETag/Last-Modified conditional fetching, 10 MB response size limit, 15 s timeout, webcal:// → https:// normalization, RRULE expansion via sync window (−6 / +12 months), upsert-on-conflict with `user_modified` guard, stale-event cleanup via `json_each`, and in-memory mutex to prevent concurrent syncs of the same subscription

## [0.20.36] - 2026-04-20

### Added
- Migration v10: new `ics_subscriptions` table with fields for name, URL, color, shared flag, created_by, etag, last_modified, last_sync, and created_at
- Migration v11: `calendar_events` table recreated to extend the `external_source` CHECK constraint to include `'ics'`, and two new columns added — `subscription_id` (FK to `ics_subscriptions` with CASCADE delete) and `user_modified` (integer flag, default 0)
- Unique partial index `idx_calendar_sub_extid` on `(subscription_id, external_calendar_id)` prevents duplicate UIDs within a single ICS subscription while allowing the same UID across different subscriptions
- `test:ics-sub` test suite with 10 tests covering subscription CRUD, ICS event insertion, UNIQUE constraint enforcement, cascade delete, visibility filtering, and CHECK constraint validation

## [0.20.35] - 2026-04-20

### Changed
- Extracted ICS parser functions (`unfoldLines`, `parseICS`, `formatICSDate`, `tzLocalToUTC`, `applyDuration`) from `apple-calendar.js` into a new shared module `server/services/ics-parser.js`, plus a new `expandRRULE` helper — pure refactor, no logic changes
- Added `test:ics-parser` test suite covering line unfolding, all-day/UTC event parsing, and RRULE expansion

## [0.20.34] - 2026-04-20

### Fixed
- Login on Safari/iOS PWA no longer loops back to the login screen when credentials are wrong: `apiFetch` no longer dispatches `auth:expired` for 401 responses from `/auth/login` (where 401 means invalid credentials, not expired session) — the error message is now shown correctly instead of the form being silently re-rendered

## [0.20.33] - 2026-04-20

### Fixed
- Weather widget: forecast min/max temperatures are now aggregated across all 3-hour intervals of each day instead of reading `temp_min`/`temp_max` from a single snapshot — the OWM free-tier `/forecast` endpoint reports near-identical values per 3h window, so min and max were always the same; icon and description still use the noon entry (12:00, fallback 15:00)

## [0.20.32] - 2026-04-20

### Changed
- Dark mode switched from blue-tinted (Option B) to deep warm (Option A): background `#1A1A18`, cards `#222220`, sidebar `#141413` — warmer and more inviting feel

## [0.20.31] - 2026-04-20

### Fixed
- Toast success/warning/danger now use dark text in dark mode — previously white text on vivid lime/amber/pink backgrounds had contrast ratios of ~1.3–1.5:1 (unreadable); now 13–15:1 (WCAG AAA)
- List stagger animation tapers naturally (35→30→25→22→18→15→12→9→7ms steps) and covers 9 items before capping, replacing the abrupt constant 175ms from item 6 onward

## [0.20.30] - 2026-04-20

### Changed
- Desktop body font size increased from 14px to 15px (`--text-base`) for improved readability
- Interactive cards now show a stronger pressed state on touch (scale 0.98 + surface-3 background) instead of the barely-perceptible scale(0.99)

### Fixed
- Added clarifying comment to `--color-surface-2` token explaining its recessed/sunken semantics (darker than background in dark mode, not an elevation level)

## [0.20.29] - 2026-04-20

### Changed
- Dark mode now uses a blue-tinted color palette (Option B): background `#0F1117`, surfaces `#161A26`/`#1E2336`, sidebar `#0B0D14` — creates stronger visual hierarchy and complements the Indigo accent

### Fixed
- Defined missing CSS tokens `--color-surface-elevated` and `--color-surface-hover` used by More-Sheet items, Search overlay inputs and results (previously transparent/invisible backgrounds)

## [0.20.28] - 2026-04-20

### Fixed
- Dark mode "System" setting now reliably follows the OS preference on every page load, even in browsers where JavaScript `matchMedia` is restricted (e.g. Brave with fingerprint protection); CSS `@media (prefers-color-scheme: dark)` now serves as the authoritative source for system preference detection instead of JS

## [0.20.27] - 2026-04-20

### Fixed
- Selecting "System" theme in settings now immediately applies the OS dark/light preference instead of reverting to light mode until the next page reload

## [0.20.26] - 2026-04-20

### Added
- Meals: floating action button (FAB) now appears fixed at the bottom-right corner, opening a quick-add modal for today with the first visible meal type pre-selected

## [0.20.25] - 2026-04-20

### Fixed
- Theme selection no longer reverts to light mode on page reload when "System" is chosen; the init script now correctly resolves the `system` preference to the OS dark/light state instead of treating it as a literal `data-theme` value

## [0.20.24] - 2026-04-20

### Added
- Tasks: subtle green edge indicator on touch devices hints at the swipe-left gesture without requiring an actual swipe (hidden during active swipe)
- Global search: new search overlay accessible from the "More" sheet — searches tasks, calendar events, and notes simultaneously; results link directly to the relevant record
- Navigation: bottom bar now shows 4 primary items plus a "More" button that opens a slide-up sheet with remaining sections and the search entry point; replaces the old 2-page swipe approach

### Changed
- Server: `VALID_CATEGORIES` in tasks route updated to English keys to match the v9 DB migration

## [0.20.23] - 2026-04-20

### Added
- Tasks: filter bar replaced by a compact toggle panel — only active filter chips are shown inline; a "Filter" button (with active-count badge) opens a grouped panel with Status, Priority, and Person sections, plus a clear-all button

### Changed
- Tasks: category values stored in the database are now English keys (`household`, `school`, `shopping`, `repair`, `health`, `finance`, `leisure`, `misc`) instead of German strings — migration v9 converts all existing rows automatically; display labels are unchanged

## [0.20.22] - 2026-04-20

### Added
- Tasks: Kanban board now supports touch drag-and-drop on mobile — a ghost card follows the finger and drops into the target column on release
- Tasks: swipe-left to mark done/open now shows a 5-second undo toast that reverts the status change
- Tasks: opening a task card from the Dashboard now navigates to `/tasks` and immediately opens the edit modal for that task (deep-link via `?open=<id>`)

### Fixed
- Router: query parameters (e.g. `?open=123`) are now stripped before route matching, so parameterised URLs resolve correctly without falling back to the home page

## [0.20.21] - 2026-04-20

### Changed
- Dashboard: eliminated double-render flicker — initial paint uses skeleton widgets and a stat-less greeting; real widgets replace skeletons in-place without resetting `container.innerHTML`
- Dashboard: weather widget now derives temperature unit symbol (°C / °F / K) from the `units` field returned by the weather API instead of always showing °C
- Dark mode: removed duplicate `@media (prefers-color-scheme: dark)` block from `tokens.css`; system-preference detection moved to a `matchMedia` listener in `index.html` for flash-free sync
- Tasks: view-toggle (list / Kanban) fades out at 40% opacity during re-render and fades back in, giving visible feedback of the switch

### Fixed
- Tasks: inline `style="width/height"` on all Lucide icon instances replaced with utility CSS classes (`icon-xs` … `icon-2xl`, `icon-11`) defined in `layout.css`
- Tasks: edit-button inline size overrides removed; replaced with new `.btn--icon-sm` utility class
- Tasks: `textarea` `resize: vertical` and select `min-height: 44px` moved from inline styles to `layout.css`
- Dashboard: `chipIcon` inline style variable eliminated; chip icons now use `class="icon-sm"`
- Dashboard: settings, refresh, chevron, and other action icons converted from inline styles to CSS classes
- Weather API: server now forwards the configured `units` value in the response payload so the frontend can render the correct unit symbol

## [0.20.20] - 2026-04-20

### Fixed
- Accessibility: `--module-notes` color raised from `#CA8A04` (4.08:1) to `#A16207` (6.3:1) — now WCAG AA compliant for normal text including nav labels
- Accessibility: Task status button `aria-label` now reflects actual action — says "mark as open" for completed tasks instead of always "mark as done"
- i18n: Added `tasks.markOpen` key to all 15 locale files for the corrected aria-label

## [0.20.19] - 2026-04-20

### Changed
- Design: two hardcoded color values in `dashboard.css` replaced with design tokens — `drop-shadow(0 2px 4px rgba(0,0,0,0.15))` on `.weather-widget__icon` replaced with new `--shadow-drop-icon` token; `rgba(0,0,0,0.25)` on `.fab-backdrop` replaced with new `--color-backdrop-fab` token
- Design: `--shadow-drop-icon` and `--color-backdrop-fab` added to `tokens.css` (shadow and overlay sections respectively)

## [0.20.18] - 2026-04-20

### Changed
- Meals: ingredient category list in the meal dialog restricted to food-relevant categories; Household and Personal Care categories are now hidden
- Refactoring: category translation logic (`categoryLabel`) and `DEFAULT_CATEGORY_NAME` extracted into a new shared utility `public/utils/shopping-categories.js`; Shopping and Meals pages now use the common implementation

## [0.20.17] - 2026-04-20

### Changed
- Design: dark-mode token architecture refactored to private-variable indirection (`--_name`) in `tokens.css` — all tokens with dark-mode overrides now have a private `--_token` variant that holds the actual value, while public tokens (`--color-*`, `--module-*`, `--glass-*` etc.) are stable `var(--_token)` references. Both dark blocks (`@media prefers-color-scheme: dark` and `[data-theme="dark"]`) now only override the compact private tokens; the public API never needs to be touched again for dark-mode changes. The redundant explicit `--color-surface-2` override was removed from both dark blocks (it is already correctly derived via `var(--neutral-50)`). No visual change.

## [0.20.16] - 2026-04-19

### Changed
- Design: PWA `theme-color` meta tag updated from `#2563EB` to `#4F46E5` (Indigo-600) to match the new primary accent; install-prompt CSS fallback updated from `#2554C7` to `#4338CA`, and hardcoded `#fff` replaced with `var(--color-text-on-accent, #fff)`
- Design: five new `--glass-inset-*` tokens added to `tokens.css` (`--glass-inset-soft` 0.18, `--glass-inset-base` 0.20, `--glass-inset-medium` 0.22, `--glass-inset-elevated` 0.28, `--glass-inset-strong` 0.32); ten hardcoded `inset 0 1px 0 rgba(255,255,255,…)` literals in `glass.css` and `tasks.css` replaced with the corresponding token references — no visual change
- Design: `@media print` block in `layout.css` normalised from CSS shorthand hex (`#fff`, `#000`, `#ddd`) to explicit six-digit notation (`#ffffff`, `#000000`, `#cccccc`) for consistency

## [0.20.15] - 2026-04-19

### Changed
- Design: primary accent migrated from `#2563EB` (Tailwind Blue-600) to `#4F46E5` (Indigo-600) for a warmer, more distinctive tone that harmonises with the existing warm-neutral surface palette and `--color-accent-secondary`; all Indigo-family tokens updated accordingly across light and dark mode
- Design: module accent colours decoupled from severity colours — Meals moved to Orange-700 (`#C2410C`), Shopping to Pink-600 (`#DB2777`), Budget to Teal-700 (`#0F766E`); previous Orange sharing between Meals, Shopping, Warning and Priority-Medium made badges semantically ambiguous
- Design: Warning (`#A15C0A`) and Danger (`#B91C1C`) raised to higher contrast ratios (5.2:1 and 6.9:1 respectively) for improved readability on white
- Design: Priority-Medium separated into Amber-700 (`#A16207`, 6.3:1) so it is visually distinct from Warning and Meals in the same row
- Design: dark-mode accent shifted to Indigo-400/500 (`#818CF8`/`#6366F1`) to preserve hue identity from light mode instead of the previous hue-shifted Sky-Blue

### Fixed
- Tasks: overdue badge base styles (background colour, size, border-radius) moved from the dynamically-unloaded `tasks.css` to `layout.css`, so the badge remains visible in the navigation bar on every page, not just while the Tasks page is active (closes #56)
- Tasks: subtask checkbox icon refactored from inline `style="color:#fff"` to `.subtask-item__checkbox-icon` CSS class using `var(--color-text-on-accent)`
- Reminders: three stale CSS fallback values removed (`var(--color-priority-urgent, #EF4444)`, `var(--color-accent, #2563EB)`, `var(--color-border, rgba(0,0,0,0.1))`); `color: #fff` replaced with `var(--color-text-on-accent)`
- Dashboard: widget customise button glass highlight replaced with existing `--color-glass*` tokens instead of hardcoded `rgba(255,255,255,…)` literals

### Accessibility
- `prefers-contrast: more` block now overrides `--module-notes` to `#A16207` (6.3:1) to meet AA normal-text threshold in high-contrast mode

## [0.20.14] - 2026-04-19

### Fixed
- Tasks: overdue badge now consistently overlays the top-right corner of the nav icon in all three layouts (mobile bottom nav, collapsed sidebar, expanded sidebar). Root cause: the badge was positioned absolutely relative to the full-width `.nav-item` flex container, causing misalignment. Fixed by wrapping the icon SVG in a `.nav-item__icon-wrap` span at runtime and appending the badge there instead (closes #56)

## [0.20.13] - 2026-04-19

### Added
- Budget: income entries now have dedicated categories (Earned Income, Investment Income, Transfer & Gift Income, Government & Social Benefits, Other Income) separate from expense categories; the category dropdown in the budget modal updates dynamically when switching between income and expense types (closes #55)
- Budget: all 15 supported locales include translations for the new income categories

## [0.20.12] - 2026-04-19

### Fixed
- Tasks: active filters are now correctly re-applied when navigating away from and back to the Tasks tab. Previously the filter chip appeared active but all tasks were shown, because the initial data fetch in `render()` always called `/tasks` without query parameters, ignoring the persisted `state.filters`. Fixed by building the filter query in `render()` the same way `loadTasks()` does, so the first fetch already respects the current filter state (closes #49)

## [0.20.11] - 2026-04-19

### Fixed
- PWA: modal header (task / calendar event) no longer scrolls out of view when the form content exceeds the modal height. Root cause: `position: sticky` on `.modal-panel__header` fails on iOS WebKit when the scroll container (`.modal-panel`) has `padding-top` applied (a known WebKit quirk). Fixed by restructuring the modal layout: `.modal-panel` is now a `flex-column` container with `overflow: hidden`, and scrolling is handled by `.modal-panel__body` (`overflow-y: auto; flex: 1`). The header is always visible as a non-scrolled flex sibling. Swipe-to-close updated to read scroll position from `.modal-panel__body` instead of `.modal-panel` (closes #50)

## [0.20.10] - 2026-04-18

### Changed
- Upgraded Express 4 → 5 (`^5.2.1`): modernised wildcard SPA fallback route from `'*'` to `'/{*path}'` for compatibility with path-to-regexp v8; all other Express APIs in the codebase were already Express 5 compatible (closes #54)

## [0.20.9] - 2026-04-18

### Added
- Ukrainian (uk) translation (closes #52)
- Ukrainian Hryvnia (UAH) currency option in budget settings
- Shopping list category names are now translated in the settings panel; rename and delete dialogs also use the translated name

### Fixed
- Server-side `VALID_CURRENCIES` now matches the frontend list — `AED`, `BRL`, `INR`, and `SAR` were accepted by the UI but rejected by the API

## [0.20.8] - 2026-04-18

### Changed
- Dependencies updated: `better-sqlite3` 9 → 12, `dotenv` 16 → 17, `express-rate-limit` 7 → 8, `express-session` 1.18 → 1.19, `helmet` 8.0 → 8.1, `googleapis` 144 → 171, `tsdav` 2.0 → 2.1 (closes #53)
- Added GitHub Dependabot configuration for automated weekly dependency updates

## [0.20.7] - 2026-04-16

### Fixed
- iOS PWA: large empty area visible between the bottom navigation bar and the physical screen edge. Root cause: `body::after` (which covers the home indicator safe area) had the same `z-index` as the nav bar (100) but was painted after all child elements by the browser's compositing order, causing it to render on top of the nav's glass background with a mismatched color (`color-mix` vs `var(--glass-bg)`). Fixed by aligning `body::after` to `var(--glass-bg)` and `var(--blur-md)` (identical to the nav) and lowering its `z-index` to `z-nav - 1` so the nav always renders on top in the overlap area.
- iOS PWA: app zoomed in when the virtual keyboard appeared and remained zoomed after the keyboard was dismissed, causing nav items and other elements to move outside the visible viewport. Added `focusin`/`focusout` listeners in `router.js` that temporarily set `maximum-scale=1` on the viewport meta tag while an `INPUT`, `TEXTAREA`, or `SELECT` is focused (prevents WKWebView auto-zoom), then restore `maximum-scale=5` after a 150 ms delay once the field loses focus (preserves manual zoom for accessibility).

## [0.20.6] - 2026-04-16

### Fixed
- Android PWA: page transitions were taking ~1 second, making navigation feel sluggish. Two root causes addressed: (1) `glass.css` extended the page-in animation duration from `0.20s` to `0.30s` with a spring easing (`ease-glass`) — reverted to `0.20s` in and `0.12s` out to match the layout baseline. (2) During transitions, dozens of `backdrop-filter` composited layers (widgets, task cards, inputs, toolbars) were all rendered simultaneously for both the outgoing and incoming page, overwhelming mid-range Android GPUs. Added `html.navigating` state: `router.js` sets this class for the duration of each page transition, and `glass.css` overrides all `backdrop-filter` in the content area to `none` for that window, then restores them once the animation ends (closes #48).

## [0.20.5] - 2026-04-16

### Fixed
- iOS PWA: persistent gap between the bottom navigation bar and the physical screen edge. Two root causes addressed: (1) `will-change: transform` on the flex-child nav caused iOS WebKit's compositor to misplace the GPU layer — removed permanently; CSS `transform` transitions work with hardware acceleration on modern iOS without this hint. (2) Added `-webkit-fill-available` as a height fallback before `100dvh` on `.app-shell` to guard against iOS WebKit versions where `100dvh` is computed slightly smaller than the actual WKWebView height.

## [0.20.4] - 2026-04-16

### Fixed
- iOS PWA: bottom navigation bar appeared visually higher than on Android. Changed `.nav-bottom` from `position: fixed` to a flex child of `.app-shell` (`position: relative; flex-shrink: 0`). With `position: fixed` and `will-change: transform` (used for the hide/show animation), iOS's compositor could misplace the nav bar. As a flex child at the end of a `height: 100dvh` container, the nav is guaranteed to sit flush at the physical screen bottom on all platforms. Removed the redundant `padding-bottom` clearance from `.app-content`, `.tasks-page`, and `.dashboard` (no longer needed since the nav no longer overlaps the content area).

## [0.20.3] - 2026-04-16

### Fixed
- iOS PWA: two visually distinct color zones at the bottom of the screen (below the bottom navigation bar). The `body::after` pseudo-element that covers the home indicator safe area now matches the bottom nav's appearance exactly - using the same semi-transparent background (`color-mix`) and `backdrop-filter: blur(16px) saturate(180%)` - so the navigation bar blends seamlessly into the bottom edge of the screen.

## [0.20.2] - 2026-04-16

### Fixed
- iOS PWA: "Dashboard kann nicht geladen werden" toast after opening the PWA due to an `auth:expired` race condition. When the session cookie was cleared by iOS between opens, the 401 response triggered `auth:expired` while navigation was still in progress (`isNavigating=true`), causing the redirect to `/login` to be silently dropped. A `_pendingLoginRedirect` flag now defers the redirect until navigation completes.
- SW cache bumped (shell v34, pages v29) to force iOS devices to pick up the previous CSRF fix that may still have been served from stale cache.

## [0.20.1] - 2026-04-15

### Fixed
- iOS PWA: recurring "forbidden" (403) errors caused by CSRF token desync after app resume. The server now sends the correct CSRF token as `X-CSRF-Token` response header on every API response (not just `/auth/me` and `/auth/login`). The client reads the header from every response - including 403 errors - enabling instant self-healing without an extra `/auth/me` round-trip. SW cache bumped to v33 to ensure iOS PWA users pick up the fix.

## [0.20.0] - 2026-04-15

### Added
- Reminders: set time-based reminders on tasks and calendar events (closes #13)
  - Tasks: enable a reminder with a custom date and time via the task edit modal
  - Calendar events: choose an offset (at time, 15 min, 1 hour, or 1 day before) via the event edit dialog
  - In-app toast notifications (built via DOM API, no external dependencies) appear when a reminder is due
  - Browser Notification API support - reminders fire as system notifications when permission is granted
  - Client-side polling every 60 seconds checks for pending reminders
  - Reminders can be dismissed individually; dismissed reminders no longer appear
  - Bell badge on each reminder shows pending count when reminders are due
  - DB migration #8 adds `reminders` table with `entity_type`, `entity_id`, `remind_at`, `dismissed` fields and appropriate indexes

## [0.19.6] - 2026-04-15

### Added
- Meals: ingredient category selection when adding ingredients to a meal - each ingredient can now be assigned a shopping category (e.g. Fruit & Vegetables, Dairy, Meat & Fish) directly in the meal editor. Categories are automatically applied when transferring ingredients to the shopping list, so items appear pre-sorted in their correct category groups (closes #33)

## [0.19.5] - 2026-04-14

### Fixed
- iOS PWA: black gap below bottom navigation in standalone mode - iOS reserves the home indicator area outside the CSS viewport, leaving a visible black strip. A fixed `::after` pseudo-element on `body` now fills this area with the surface color. Also added explicit `background-color` to `body` element.

## [0.19.4] - 2026-04-14

### Fixed
- iOS: persistent "forbidden" (403) errors caused by iOS Safari/PWA not reliably exposing CSRF cookie via `document.cookie`. CSRF token is now returned in the response body of `/auth/login` and `/auth/me` and stored in-memory, bypassing cookie read issues entirely. Cookie is still set as fallback.
- CSRF retry: `/auth/me` refresh now reads the token from the response body instead of relying on the cookie being available. Also handles expired sessions (401) during retry instead of silently failing.

## [0.19.3] - 2026-04-14

### Added
- Docker: multi-architecture image support (linux/amd64 + linux/arm64) - enables self-hosting on Raspberry Pi and other ARM64 devices (closes #44)

## [0.19.2] - 2026-04-14

### Improved
- Accessibility: FAB focus ring now uses a double-ring pattern (inner `--color-bg`, outer `--color-accent`) visible on any background - previously hardcoded `#fff` was invisible on light backgrounds
- Accessibility: added `forced-colors` media query fallback for Windows High Contrast Mode (buttons, cards, modals, active nav items)
- Design tokens: extracted `--color-accent-secondary`, `--content-max-width-narrow`, `--cal-hour-height` - eliminates last hardcoded values in layout, settings, and calendar CSS
- Dark mode: Apple sync logo in settings now uses semantic tokens (`--color-text-primary` / `--color-bg`) instead of fixed neutrals that didn't invert correctly
- Sidebar logo gradient now references `--color-accent-secondary` token instead of hardcoded `#7C5CFC`

## [0.19.1] - 2026-04-14

### Fixed
- iOS PWA: "Forbidden" errors after app resume - CSRF cookie was not renewed on `/auth/me` (the first API call after iOS kills and restarts the standalone webapp). iOS aggressively purges cookies of background webapps, causing CSRF token mismatch on all subsequent POST/PUT/DELETE requests
- CSRF middleware: added try-catch and hex validation to prevent server crash from corrupted token cookies (iOS can mangle cookie values)
- API client: automatic CSRF token refresh and retry on 403 - state-changing requests that fail due to stale CSRF tokens are now transparently retried after renewing the token via `/auth/me`
- Service Worker: added 200ms delay before `controllerchange` reload to prevent blank page on iOS standalone mode (the new SW needs time to complete `clients.claim()` before the page reloads)

## [0.19.0] - 2026-04-14

### Added
- i18n: Japanese (ja) locale - full translation with 567 keys; Hiragana/Katakana/Kanji script
- i18n: Arabic (ar) locale - full translation with 567 keys; RTL-ready text
- i18n: Hindi (hi) locale - full translation with 567 keys; Devanagari script
- i18n: Portuguese (pt) locale - full translation with 567 keys; Brazilian Portuguese
- Budget: AED (UAE Dirham), BRL (Brazilian Real), INR (Indian Rupee), SAR (Saudi Riyal) added to currency list
- Service Worker: new locale files pre-cached in APP_SHELL for offline support (sw v31)

## [0.18.2] - 2026-04-14

### Fixed
- Login failure behind Caddy/nginx reverse proxy in Docker: default `TRUST_PROXY` changed from `'loopback'` to `1` (trust one proxy hop). With `'loopback'`, Express ignored `X-Forwarded-Proto: https` from Caddy (which runs on a Docker bridge IP, not loopback), causing `req.secure = false` and express-session to silently drop the session cookie. The new default of `1` correctly handles any single-proxy setup without requiring manual configuration.
- `docker-compose.yml`: added inline comments explaining reverse proxy vs. direct-access configuration
- `docs/docker-compose.portainer.yml`: added explicit `TRUST_PROXY` variable with default `1`

## [0.18.1] - 2026-04-14

### Added
- Customizable dashboard layout: users can now show/hide individual widgets and reorder them via a settings button in the greeting header
- New "Anpassen" button (settings icon) in the dashboard greeting widget opens a modal with toggle switches and up/down controls for each widget (Tasks, Calendar, Shopping, Meals, Notes, Weather)
- Widget configuration persisted server-side via `dashboard_widgets` preference key in `sync_config` table - survives page reload and applies across all family members
- Reset to default layout button in the customize modal
- New i18n keys for all 10 supported locales: `dashboard.customize`, `dashboard.customizeTitle`, `dashboard.customizeReset`, `dashboard.customizeSaved`, `dashboard.weather`, `dashboard.customizeMoveUp`, `dashboard.customizeMoveDown`
- Backend: `GET /api/v1/preferences` now includes `dashboard_widgets` in the response; `PUT /api/v1/preferences` accepts `dashboard_widgets` array with validation and normalization

## [0.18.0] - 2026-04-14

### Added
- Glass Phase 4: Liquid Glass Vibrancy + Tint - deeper glass penetration across all UI surfaces
- New glass tokens in `tokens.css`: `--glass-bg-card` (52% opacity), `--glass-bg-card-hover`, `--glass-bg-input`, `--glass-bg-toolbar`, `--glass-tint-strength` (6% light / 8% dark) with full dark mode and accessibility overrides
- Dashboard widgets now use semi-transparent glass backgrounds with `backdrop-filter: blur(8px) saturate(180%)` - content beneath widgets shines through
- Module tint: each widget gets a subtle accent color gradient overlay via `::after` pseudo-element using `color-mix(module-accent, 6%, transparent)` - dashboard cards carry a hint of their module's color
- Task cards, note items, and meal slots use glass backgrounds with blur for consistent vibrancy
- Page toolbars (Tasks, Notes, Contacts, Calendar) rendered as glass bars with module accent tint
- Form inputs, group toggles, and FAB speed-dial actions use glass vibrancy backgrounds
- App content background uses a radial gradient with the active module accent for ambient vibrancy
- Skeleton loading states use glass backgrounds for visual consistency
- All new glass effects gated behind `@supports (backdrop-filter)` for progressive enhancement
- Accessibility: all new effects respect `prefers-reduced-transparency` (solid fallbacks) and `prefers-reduced-motion`
- Load-order safety: all glass selectors use parent-scoped specificity (`.dashboard .widget`, `.tasks-page .task-card`) to prevent override by on-demand page CSS

## [0.17.4] - 2026-04-13

### Fixed
- iOS PWA: bottom navigation no longer shifts upward in standalone mode - root cause was `body` having `min-height: 100dvh` and no `overflow: hidden`, which allowed the body to scroll; in iOS WebKit standalone mode, body scroll moves `position: fixed` elements rather than keeping them pinned; fix: `html` and `body` are now `overflow: hidden` with fixed height so all scrolling is confined to `.app-content`
- Service worker: cache bumped to `shell-v30` to ensure iOS devices receive the updated `reset.css`

## [0.17.3] - 2026-04-13

### Fixed
- CSS: `glass.css` now works on Safari < 18 - all `@supports` checks extended to `(backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))` so older Safari (which only understands the `-webkit-` prefix) no longer skips the entire block
- CSS: non-blur glass styles (background-color, border, box-shadow) moved outside `@supports` blocks - they are now always active on all browsers and devices, regardless of `backdrop-filter` support

## [0.17.2] - 2026-04-13

### Fixed
- Auth: session cookie and CSRF cookie changed from `SameSite=Strict` to `SameSite=Lax` - Safari's ITP (Intelligent Tracking Prevention) was blocking `Strict` cookies on certain navigations (direct URL entry, reverse proxy), causing a 401 on login while other browsers worked fine (#46)

## [0.17.1] - 2026-04-13

### Fixed
- Service worker: `glass.css` was missing from the shell cache list - on already-installed PWA instances the file was never loaded and no glass effects were visible; cache bumped to `shell-v29`
- CSS load order: `.widget` glass shadow and border were overridden by `dashboard.css` (module CSS loads after `glass.css`); glass styles moved directly into `dashboard.css`
- CSS load order: `.filter-chip--active` glass state was overridden by `tasks.css`; `@supports backdrop-filter` block moved into `tasks.css`
- CSS load order: `.priority-badge` border-radius was reset to `var(--radius-xs)` by `tasks.css`, losing the capsule shape; corrected to `var(--radius-glass-chip)` in `tasks.css`
- `glass.css`: removed dead `.sticky-header` rule (class is not used anywhere in the HTML)

## [0.17.0] - 2026-04-13

### Added
- Design system: `public/styles/glass.css` - new additive layer (~430 lines) implementing Liquid Glass aesthetics: translucent surfaces, `backdrop-filter` blur, capsule shapes, specular highlights, and spring-based motion; loaded globally after `layout.css`, all blur effects gated behind `@supports (backdrop-filter: blur(1px))`
- Design system: Section 16 "Glass Tokens" added to `tokens.css` - ~50 new custom properties covering `--glass-bg*`, `--glass-border*`, `--blur-xs/sm/md/lg/xl`, `--opacity-glass-*`, `--glass-highlight*`, `--glass-shadow-sm/md/lg`, `--radius-glass-card/inner/chip/button`, `--ease-glass`, `--transition-glass`; full dark mode overrides in both `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]` blocks
- Navigation: bottom bar now auto-hides on scroll-down (mobile only, < 1024px), reappears on scroll-up with 4 px hysteresis; implemented via `initNavHideOnScroll()` in `router.js` and `.nav-bottom--hidden` CSS class in `glass.css`; `will-change: transform` on `.nav-bottom` for smooth GPU-composited animation
- Animations: modal entrance uses spring easing (`glass-modal-scale-in` + `glass-sheet-in` keyframes) instead of linear fade; page transitions use spring-eased translate instead of plain ease-out; list items stagger with spring `cubic-bezier(0.34, 1.56, 0.64, 1)` spring curve
- Accessibility: `prefers-reduced-transparency`, `prefers-reduced-motion`, and `prefers-contrast: more` media query blocks in both `tokens.css` and `glass.css` - glass effects deactivate and solid fallbacks activate automatically

### Changed
- Glass input styles: `.contacts-toolbar__search-input`, `.notes-toolbar__search-input`, and `.quick-add__input` now use `--radius-glass-button`, `--glass-border-subtle`, and a `color-mix` focus ring for visual consistency with the glass layer (applied directly in module CSS files to respect CSS load order)
- Bottom nav / sidebar: glass blur surface, subtle top highlight, elevated shadow via `glass.css`
- Modal: glass overlay, spring entrance, capsule close button, specular FAB ring pulse (`fab-ring-pulse` keyframe)
- Buttons / FAB: capsule shape via `--radius-glass-button`, specular inner highlight on primary buttons, glass hover glow on secondary
- Skeleton loading: upgraded shimmer gradient uses glass highlight colors
- Focus rings: animated expand-contract ring via `glass-focus-ring` keyframe, applied to interactive glass elements
- PWA viewport: `maximum-scale` changed from `1` to `5` (WCAG 1.4.4 - Resize Text, users can pinch-zoom again)
- Theme color meta tag: `#007AFF` → `#2563EB` (light) and `#1C1C1E` → `#222220` (dark) to match updated token palette

### Fixed
- Accessibility: `--color-text-tertiary` corrected from `#737370` to `#6B6B68` (passes WCAG AA 4.5:1 on `--color-bg`)
- Accessibility: `--color-info` corrected from `#54AEFF` to `#0969DA` (passes WCAG AA 4.5:1 on white)
- Accessibility: modal overlay now carries `aria-label` and `role="presentation"` for correct screen-reader semantics
- Settings: fixed three stale token references (`--color-background` → `--color-bg`, `--duration-fast` → `--transition-fast`, `--color-surface-raised` → `--color-surface-2`)
- Notes: fixed stale token reference `--color-text` → `--color-text-primary` in search input border
- Dashboard: weather widget gradient now uses `var(--color-accent-deep)` instead of hardcoded `#1E5CB3`
- Meals: badge padding now uses spacing tokens (`var(--space-0h) var(--space-2)`) instead of hardcoded `2px 8px`

## [0.16.3] - 2026-04-13

### Added
- i18n: five new UI languages - French (fr), Turkish (tr), Russian (ru), Greek (el), and Chinese Simplified (zh) with full translations of all keys
- Budget: TRY (Turkish Lira) and RUB (Russian Ruble) added to the list of selectable currencies in Settings
- i18n: Italian locale now includes the complete `rrule` section (was missing previously)

## [0.16.2] - 2026-04-13

### Added
- Budget: CNY (Chinese Yuan) added to the list of selectable currencies in Settings (#42)

## [0.16.1] - 2026-04-13

### Fixed
- i18n: fallback language for unsupported browser locales changed from German to English (#43)
- Apple CalDAV sync: calendar events with a `TZID` parameter are now correctly converted to UTC instead of being treated as floating local time, fixing wrong start times for events synced from iOS Calendar (#43)

## [0.16.0] - 2026-04-06

### Added
- Settings: categorized tab navigation - six tabs (General, Meals, Budget, Shopping, Calendar, Account) replace the flat scrolling layout (#30)
- Settings: active tab persists across page navigations via sessionStorage
- Settings: Calendar tab is automatically activated when returning from a Google/Apple OAuth callback
- Settings: tab bar is sticky so it stays visible while scrolling through tab content
- Settings: all tab labels fully translated in de, en, es, it, sv

## [0.15.0] - 2026-04-06

### Changed
- Modal: two-column form layouts now use reusable `.modal-grid` and `.modal-grid--2` CSS classes instead of inline `style` attributes - applied across Calendar, Meals, and Tasks modals (#38)
- Modal: panel on mobile now has a subtle border and large shadow for better depth and visual separation (#38)
- Modal: form groups inside grid layouts no longer need inline `margin-bottom:0` overrides - handled by `.modal-grid > .form-group` rule (#38)

## [0.14.4] - 2026-04-06

### Fixed
- PWA iOS: pinch-to-zoom disabled - added `user-scalable=no, maximum-scale=1` to viewport meta tag for native-app feel (#16)
- PWA iOS: residual body scroll fully blocked - added `overflow: hidden` to `html, body` so any minimal content overflow can no longer make the page body scrollable (#16)
- Service worker cache bumped to v28/v27 (#16)

## [0.14.3] - 2026-04-06

### Fixed
- PWA iOS: scroll bleed fully resolved - `padding-top: env(safe-area-inset-top)` moved from `body` to `.app-shell`; body-padding was pushing `.app-shell` (height: 100dvh) beyond the viewport bottom, allowing the page body itself to scroll (#16)
- PWA iOS: all fixed-height page containers (Calendar, Shopping, Meals, Notes, Budget, Contacts) now subtract `--safe-area-inset-top` from their height calculation so they no longer overflow `.app-content` in standalone mode (#16)
- Added `--safe-area-inset-top` CSS token (mirrors `env(safe-area-inset-top, 0px)`) for consistent use across all page layout calculations (#16)
- Service worker cache bumped to v27/v26 to ensure CSS changes are picked up on next update (#16)

## [0.14.2] - 2026-04-06

### Fixed
- Modal: overlay tap now reliably closes the modal on iOS Safari / PWA - added `cursor: pointer` to the overlay (iOS requires this on non-interactive elements to fire click events) and a `touchend` fallback (#29)
- Modal: close button enlarged from 32px to 40px to meet Apple's 44px touch-target recommendation (#29)
- Modal: swipe-to-close no longer triggers when scrolling content inside the sheet - drag only activates from the top handle zone or when the panel is scrolled to the top (#29)

## [0.14.1] - 2026-04-06

### Fixed
- Calendar: toolbar no longer overflows on narrow screens (< 580px) - view buttons (Monat/Woche/Tag/Agenda) now wrap to a second row so navigation and label remain fully visible (#31)
- Tasks: page title no longer visually overlaps action buttons on narrow screens - title now truncates with ellipsis when space is constrained (#31)
- Shopping: list name no longer overlaps action buttons when the name is long or the "clear checked" button is visible - name now truncates cleanly (#31)

## [0.14.0] - 2026-04-05

### Added
- Spanish (Español) translation - all sections fully translated (tasks, calendar, meals, shopping, budget, notes, contacts, settings) (#28)

## [0.13.0] - 2026-04-05

### Added
- Meals: optional recipe link per meal - add a URL in the meal modal and a link icon appears on the card for one-tap access to the recipe (#18)
- Meals: `recipe_url` field stored in the database (migration v6)

## [0.12.0] - 2026-04-05

### Added
- Shopping: custom categories - add, rename, delete and reorder shopping list categories in Settings → Shopping (#26)
- Shopping: categories are now stored in the database (`shopping_categories` table, migration v5) and fully customizable per household
- Shopping: category order in the shopping list reflects the custom sort order from Settings
- Shopping: items belonging to a deleted category are automatically moved to the next available category

## [0.11.9] - 2026-04-05

### Changed
- README: updated highlights to mention Kanban quick-status buttons and configurable budget currency; replaced docker badge with GHCR link
- docs/installation.md: restructured setup into Option A (pre-built GHCR image, no clone needed) and Option B (build from source); updated Updates section accordingly; added tip to SQLCipher troubleshooting entry
- docs/index.html (GitHub Pages): updated Get Started code block to show pre-built image path; updated task and budget feature descriptions (EN + DE) to reflect new features

## [0.11.8] - 2026-04-05

### Changed
- `docker-compose.yml` now references the pre-built GHCR image (`ghcr.io/ulsklyc/oikos:latest`) by default - no local build needed to get started (#25)
- README Quick Start now shows both the pre-built image path (no clone required) and the build-from-source path

## [0.11.7] - 2026-04-05

### Added
- Kanban view: quick-status button on each card to advance status without drag-and-drop (open → in progress → done → open) - useful for touch devices and kiosk browsers (#24)

## [0.11.6] - 2026-04-05

### Fixed
- Swedish translation: added missing rrule keys (recurrence frequency, weekday abbreviations, unit labels) - contributed by @olsson82 (#23)

## [0.11.5] - 2026-04-05

### Fixed
- Shopping list category dropdown now shows translated labels instead of hardcoded German strings (#21)
- Recurrence fields in task and calendar modals now fully translated (labels, frequency options, weekday abbreviations, unit labels) (#21)

## [0.11.3] - 2026-04-05

### Added
- Swedish (Svenska) translation - contributed by @olsson82 (#19)
- Italian (Italiano) is now explicitly listed as a language option in Settings

## [0.11.2] - 2026-04-05

### Added
- Configurable currency for the budget section: choose from 13 currencies (EUR, USD, GBP, SEK, NOK, DKK, CHF, PLN, CZK, HUF, JPY, AUD, CAD) in Settings → Budget (#20)
- Currency preference is stored household-wide via the preferences API and applied to all budget amounts and formatting

## [0.11.1] - 2026-04-05

### Fixed
- Fix dashboard meal widget ignoring meal type visibility settings - todayMeals query now reads visible_meal_types from sync_config and filters accordingly, consistent with the Meals page (#14)

## [0.11.0] - 2026-04-05

### Added
- Microinteraction improvements: subtle entrance animations, hover/active feedback, and transition polish across cards, buttons, FABs, and nav items

### Fixed
- Fix touch scroll on dashboard and all pages - use `height` instead of `min-height` on app-shell to prevent overflow blocking touch scroll on iOS/Android
- Add `inputmode` and `autocomplete` attributes to form inputs for better mobile keyboard and autofill UX
- Resolve design system audit violations: align spacing, color, border-radius, and shadow usage to tokens throughout all pages and components
- Fix touch scrolling regression in calendar, budget, and contacts introduced by layout refactor

## [0.10.0] - 2026-04-04

### Added
- Customizable meal type visibility: toggle breakfast, lunch, dinner, snack on/off in Settings (#14)
- New household-wide preferences API (`GET/PUT /api/v1/preferences`) using existing `sync_config` table
- New "Meal Plan" section in Settings page with checkbox toggles per meal type
- Meals page filters displayed slots based on household preference
- i18n keys for meal visibility settings in DE, EN, IT

## [0.9.1] - 2026-04-04

### Added
- Persist task view mode (list/kanban) across sessions via localStorage (#17)
- Support URL parameter `?view=kanban` to open tasks directly in Kanban view - ideal for tablet kiosk setups
- View toggle button reflects the persisted/URL-driven view on page load

## [0.9.0] - 2026-04-04

### Added
- Optional task priority: new "None" level allows tasks without urgency, reducing visual noise for routine tasks (#15)
- "None" is now the default priority for new tasks
- Tasks with no priority hide the priority badge entirely in list and dashboard views
- DB migration v4 extends priority CHECK constraint to include 'none'
- i18n keys for "None" priority in de, en, it locales

## [0.8.2] - 2026-04-04

### Fixed
- Fix UI overlap and scroll bleed on iOS PWA - remove double safe-area padding from body that caused content to shift under status bar (#16)
- Fix page containers using wrong nav height token (56px instead of 68px including dot indicator), causing content to render behind bottom nav on all pages
- Add `overflow: hidden` to all fixed-height page containers (shopping, meals, notes, budget, contacts) to prevent scroll bleed
- Add `overscroll-behavior-y: contain` to app-content to prevent rubber-banding scroll propagation
- Fix FAB position on all pages to account for full bottom nav height including dot indicator
- Bump service worker cache version to v23

## [0.8.1] - 2026-04-04

### Fixed
- Replace native `prompt()` dialogs with custom modals in shopping (create/rename list), tasks (add subtask), and meals (choose shopping list) - native prompts were unreliable on mobile/PWA, requiring multiple clicks to close (#12)

## [0.8.0] - 2026-04-04

### Added
- Shopping list widget on dashboard - shows lists with open items, progress bar, and item preview (discussion #9)

## [0.7.7] - 2026-04-04

### Fixed
- Fix modal not closing on mobile when tapping Cancel or Save - add fallback timer for cases where CSS animationend event does not fire (prefers-reduced-motion, tab switch, etc.)

## [0.7.6] - 2026-04-04

### Fixed
- Fix untranslated category names in tasks (group headers), budget (bar chart labels, transaction meta) - all displayed category strings now go through i18n mapping (#11)

## [0.7.5] - 2026-04-04

### Fixed
- Fix flash of unstyled content (FOUC) during page transitions - old module stylesheet is now kept until old content is removed from DOM, new content hidden until render completes
- Smooth nav-item tap transition (0.12s ease) instead of abrupt scale snap
- Add `:focus-visible` outline to interactive cards, buttons, FABs, and toggles for keyboard navigation

### Added
- Custom iOS-style toggle switch component (`.toggle`) replacing native checkboxes in calendar, notes, and budget modals
- Toast notification icons - SVG checkmark (success), alert circle (danger), warning triangle (warning) alongside color coding
- Empty-state fade-in animation (0.4s ease-out, respects `prefers-reduced-motion`)
- Swipe haptic feedback at threshold - `vibrate(15)` fires when swipe reaches 80px during touchmove in tasks and shopping
- Interface design system documentation (`.interface-design/system.md`)

## [0.7.4] - 2026-04-04

### Fixed
- Replace hardcoded `box-shadow` values in `.btn--primary` with `--shadow-sm` / `--shadow-md` tokens
- Replace `border-radius: 50%` with `var(--radius-full)` in layout and calendar styles
- Align ~25 off-grid spacing values (5px, 6px, 7px, 14px, 15px, 22px, 26px, 34px) to 4px grid using `--space-*` tokens

### Changed
- Extract 8 hardcoded `rgba()` colors from dashboard, shopping, and weather styles into new design tokens (`--color-glass`, `--color-glass-hover`, `--color-glass-border`, `--color-danger-translucent`)

## [0.7.3] - 2026-04-04

### Accessibility
- Increase font-size to 16px (`--text-md`) on mobile for `quick-add__input`, `quick-add__qty`, `quick-add__cat` (shopping), `notes-toolbar__search-input`, and `contacts-toolbar__search-input` - prevents iOS auto-zoom on input focus (WCAG touch-friendly inputs)

### Performance
- Lazy-load page-specific stylesheets on route change instead of loading all 10 upfront in `index.html` - reduces initial CSS payload; only tokens, reset, pwa, layout, and login styles are render-blocking

## [0.7.2] - 2026-04-04

### Accessibility
- Rename `#page-content` to `#main-content` so the existing skip-to-content link targets the semantic `<main>` landmark correctly
- Add `sr-only` priority labels to dashboard task items - screen readers now announce priority level instead of relying on color alone (WCAG 1.4.1)

### Fixed
- Replace hardcoded hex values in greeting widget gradient with `--color-accent-active` / `--color-accent` tokens - dark mode now correctly themes the greeting banner
- Replace hardcoded `gap: 2px` with `--space-0h` token in greeting widget

## [0.7.1] - 2026-04-04

### Security
- Fix stored XSS across all pages - extract shared `esc()` utility (`public/utils/html.js`) and apply HTML escaping to all user-controlled data in innerHTML templates (titles, names, locations, descriptions, colors, notes content, autocomplete suggestions)
- Remove `user-scalable=no` and `maximum-scale=1` from viewport meta tag - restores pinch-to-zoom accessibility (WCAG 1.4.4)

### Changed
- Deduplicate 8 identical `escHtml()` functions (tasks, shopping, calendar, notes, meals, contacts, budget, settings) into single shared `esc()` import from `utils/html.js`
- Shared `esc()` also escapes single quotes (`'` to `&#39;`) for safer attribute contexts

## [0.7.0] - 2026-04-04

### Security
- Upgrade bcrypt from 5.1.1 to 6.0.0 - resolves 4 HIGH path traversal CVEs in transitive `tar` dependency via `@mapbox/node-pre-gyp`
- Remove hardcoded fallback session secret - server now always throws if `SESSION_SECRET` is unset, regardless of `NODE_ENV`

### Changed
- **Breaking:** Migrate entire server and test suite from CommonJS to ESM - all `require()`/`module.exports` replaced with `import`/`export`; `"type": "module"` added to `package.json`
- Replace 40+ unstructured `console.*` calls with `server/logger.js` - thin wrapper supporting `LOG_LEVEL` env var (debug/info/warn/error), zero new dependencies
- Translate `package.json` description to English for consistency with all other documentation
- Translate `.env.example` comments from German to English for international contributors
- Translate `.gitignore` comments to English

### Removed
- Remove internal audit documents (`docs/claude-md-audit.md`, `docs/repo-audit-2026-04-02.md`) from tracked files
- Remove empty `.worktrees/` leftover directory

### Added
- Add `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1)
- Add `.gitignore` patterns for audit report files (`docs/audit-report-*.md`, `docs/*-audit.md`)

## [0.6.0] - 2026-04-03

### Fixed
- Fix budget entry update failing with "Internal Error" when changing category - `date` validator import shadowed the `date` field from the request body, causing SQLite to receive a function reference instead of a string value (fixes #8)

## [0.5.9] - 2026-04-03

### Security
- Fix stored XSS in task titles and subtask titles - all user-provided text in tasks.js is now escaped via `escHtml()` before insertion into innerHTML templates
- Fix stored XSS in settings page member list - display_name and username are now escaped via `escHtml()` in `memberHtml()`
- Fix rate limiter bypass via X-Forwarded-For IP spoofing - `trust proxy` now defaults to `loopback` instead of unconditional `1`; configurable via `TRUST_PROXY` env var
- Fix Google OAuth CSRF - add cryptographic `state` parameter to OAuth flow, validated on callback
- Fix CSV injection in budget export - fields starting with `=`, `+`, `-`, `@`, tab, or carriage return are now prefixed with apostrophe
- Fix missing session invalidation on user deletion - all active sessions of deleted users are now destroyed
- Restrict username to `[a-zA-Z0-9._-]` with minimum 3 characters, preventing HTML/script injection via usernames
- Restrict Google Calendar sync trigger (`POST /google/sync`) and Apple Calendar sync trigger (`POST /apple/sync`) to admin role
- Add warning log when Apple CalDAV credentials are stored without DB encryption enabled

## [0.5.8] - 2026-04-03

### Added
- Add Italian (Italiano) localization - full translation of all 497 i18n keys (thanks @albanobattistella, PR #7)
- Add Italian as selectable language in Settings locale picker

## [0.5.7] - 2026-04-03

### Fixed
- Fix recurring calendar events not expanding - RRULE parser now strips the `RRULE:` prefix used by ICS/CalDAV, which previously caused all recurrence rules to be silently ignored
- Fix recurring multi-day events not appearing when their start date falls before the view window but the event spans into it
- Fix all-day recurring event instances getting datetime end values instead of date-only format
- Add YEARLY recurrence frequency support for birthday and anniversary events

## [0.5.6] - 2026-04-03

### Fixed
- Fix all-day calendar events appearing on the correct day and the following day - ICS DTEND for DATE values is exclusive per RFC 5545, now correctly adjusted (fixes #5)
- Fix multi-day events not showing when using DURATION instead of DTEND - add ICS DURATION property support in CalDAV parser
- Fix birthdays from Apple Calendar not syncing - birthday calendars are no longer excluded from sync
- Fix outbound ICS builder using inclusive DTEND for all-day events - now correctly emits exclusive DTEND per RFC 5545

## [0.5.5] - 2026-04-03

### Fixed
- Fix iCloud Calendar sync failing with FOREIGN KEY constraint error - `created_by` was hardcoded to user ID 1 instead of resolving dynamically (fixes #4)
- Sync all iCloud calendars instead of only the first one - previously only a single calendar was imported, ignoring Family, subscribed, and other calendars
- Add missing `cfgDel` helper function used by `clearCredentials` - disconnecting Apple Calendar would crash
- Skip unreachable or broken calendars gracefully instead of aborting the entire sync

## [0.5.4] - 2026-04-03

### Fixed
- Fix SQLCipher PRAGMA key syntax error on fresh install - hex-encoded key must be wrapped in double quotes for valid PRAGMA syntax (fixes #3)

## [0.5.3] - 2026-04-03

### Security
- Fix SQLCipher PRAGMA key interpolation - encryption keys containing single quotes no longer crash on startup; key is now hex-encoded
- Enforce minimum password length (8 characters) when admin creates new users - previously any 1-character password was accepted
- Add length bounds on username (64 chars) and display_name (128 chars) to prevent unbounded input
- Add input length bounds on login (username 64 chars, password 1024 chars)
- Invalidate all other sessions when a user changes their password - previously active sessions survived password reset
- Session and CSRF cookies now have `secure: true` by default; HTTP is only allowed when `SESSION_SECURE=false` is explicitly set in `.env` - previously cookies were sent without `Secure` flag in non-production environments
- Document authorization model in SECURITY.md - clarify that all family members share read/write access to all data by design

### Changed
- Use multi-stage Docker build to exclude build tools (python3, make, g++) from runtime image
- Exclude `docs/` directory from Docker image via `.dockerignore`
- Consolidate `dotenv.config()` to single call in `server/index.js` - remove duplicate calls from `server/db.js` and `server/auth.js`

## [0.5.2] - 2026-04-01

### Security
- Add rate limiting to SPA fallback route to prevent file system hammering via unauthenticated wildcard requests
- Add CSRF protection to auth routes that change state (logout, create user, change password, delete user) - previously bypassed global CSRF middleware due to router registration order
- Fix incomplete vCard escaping in contacts export - backslash characters are now escaped first before other special characters (`,`, `;`, newline), preventing injection via contact fields
- Restrict CI workflow GITHUB_TOKEN to `contents: read` (principle of least privilege)

## [0.5.1] - 2026-04-01

### Fixed
- Meals: fixed crash when dragging a meal slot - `dragging` state is now destructured before `cleanup()` runs, preventing a null-reference error on drop
- i18n: `t()` now resolves dot-notation keys against nested locale JSON objects (e.g. `t('nav.tasks')` correctly returns `"Aufgaben"` instead of the raw key string); affects all pages, components, and navigation
- PWA: replaced placeholder "O" icons with the actual Oikos house logo across all icon variants (192, 512, maskable 192, maskable 512, apple-touch-icon, favicon); maskable variants use full-bleed background with logo within the 80% safe zone - fixes Android home screen showing only a blue circle
- PWA: weather widget icons (OpenWeatherMap) now render correctly in installed PWA on Android; service worker no longer intercepts cross-origin image requests (opaque responses caused silent rendering failures in standalone mode)
- Settings: language selector replaced from cramped radio buttons to a native `<select>` dropdown using the standard `form-input` style

### Changed
- PWA manifest: added `id` field and `display_override` array for reliable Chrome Android PWA recognition; `manifest.json` is now served with `Content-Type: application/manifest+json`
- Service worker (v22): `/i18n.js` and locale files added to app-shell cache; cross-origin asset requests excluded from cache-first strategy

## [0.5.0] - 2026-03-31

### Added
- i18n: full internationalisation system (`public/i18n.js`) with German (de) and English (en) support; language auto-detected from `navigator.language`, overridable via Settings
- i18n: all user-facing strings moved to locale files (`public/locales/de.json`, `public/locales/en.json`); 489 translation keys covering all modules
- i18n: locale switch without page reload - all pages, components and navigation re-render via `locale-changed` custom event
- i18n: `oikos-locale-picker` Web Component in Settings - three options: System (follows browser language), Deutsch, English
- i18n: dates and times formatted with `Intl.DateTimeFormat` using the active locale; `formatDate()` and `formatTime()` exported from `i18n.js`
- i18n: fallback chain (active locale → German → key) ensures no untranslated keys are shown even if a future locale file is incomplete
- i18n: adding a new language requires only one JSON file (`public/locales/xx.json`) and one line in `SUPPORTED_LOCALES`

## [0.4.0] - 2026-03-31

### Fixed
- Mobile: toast notifications no longer overlap with the bottom navigation bar - introduced `--nav-bottom-height` token (scroll area 56px + dots indicator 12px) used consistently by toast container and app content padding
- Mobile: FAB and page-FAB are now hidden when the virtual keyboard is open, preventing them from covering form inputs; detection uses `visualViewport.resize` with a 75% height threshold
- UI: added missing dark-mode colour overrides for shopping, notes, contacts, budget, and settings module tokens - accent stripes now render at readable pastel values in dark theme
- UI: meals week-navigation bar now shows module accent top-border stripe; settings page now declares --module-accent for consistency with all other modules

### Added
- Shopping: swipe-left to toggle checked/unchecked, swipe-right to delete items on mobile; × delete button hidden on mobile in favour of swipe gesture
- Notes: client-side full-text search bar in toolbar - filters by title and content instantly; shows "Keine Treffer" empty state when no match
- Dashboard: weather widget refresh button (top-right corner) + automatic 30-minute refresh interval; interval is cleared when navigating away
- Contacts: vCard export button per contact (downloads .vcf file); vCard import via file input in toolbar (parses FN, TEL, EMAIL, ADR, NOTE, CATEGORIES fields)
- PWA: offline fallback page (`/offline.html`) served by service worker when network is unavailable and index.html is not cached; page includes a reload button
- UI: module accent colours now applied to three visual layers - active nav tab (bottom bar + sidebar), toolbar top-border stripe, and list/card left-border stripe - giving each module a distinct colour identity

## [0.3.0] - 2026-03-31

### Added
- Calendar: recurring events are now expanded in GET /api/v1/calendar - all occurrences within the requested date window are returned as virtual instances; duration is preserved; instances are marked with is_recurring_instance=1 and shown with a ↻ icon in the agenda view; /upcoming also expands recurring events within a 90-day window
- Budget: recurring entries auto-generate instances for each viewed month; instances deleted by the user are skipped permanently via `budget_recurrence_skipped` table; generated instances are marked with ↩ in the transaction list
- Budget: month-over-month comparison in summary cards - each card (Einnahmen, Ausgaben, Saldo) shows a trend line (▲/▼ + delta amount vs. previous month); previous month summary is fetched in parallel with current month
- Meals: drag & drop between slots and days using Pointer Events (touch + mouse); ghost element follows pointer; drop on occupied slot swaps meals; reduced-motion: no ghost animation, interaction still works
- Settings: Apple CalDAV credentials form (URL, Apple-ID, app-specific password) with live connection test; admin can connect and disconnect via UI without restarting the server; DB-stored credentials take precedence over .env vars; auto-sync runs every 15 min (configurable via SYNC_INTERVAL_MINUTES)

## [0.2.1] - 2026-03-30

### Fixed
- Accumulating click listeners on `#notes-grid`: listener is now registered once in `render()` via event delegation instead of re-registered in every `renderGrid()` call
- Accumulating anonymous `document` click listener in dashboard FAB: `initFab()` now accepts an AbortSignal; `render()` aborts the previous signal before creating a new one, eliminating listener leaks across navigation cycles
- Add `btnError()` shake feedback to notes.js save error handler for consistency with other modules
- Calendar event popup `closePopup` listener now checks `popup.isConnected` to self-remove correctly after navigation without a click

### Added
- CSS alias `.form-label` alongside `.label` to cover usage in `notes.js` and `settings.js` without requiring a mass-rename
- Tests for `wireBlurValidation`, `btnSuccess`, and `btnError` (12 cases) in `test-modal-utils.js`

## [0.2.0] - 2026-03-30

### Changed
- Directional slide-x page transitions (forward = right, backward = left) with race condition guard
- PWA install prompt delayed until 2 user interactions; dismiss window reduced from 30 to 7 days; interaction counter resets on dismiss
- Unified card padding to 16px (`--space-4`) across tasks, contacts, budget, and meals modules

### Added
- Staggered fade-in animation for list items on page load across all modules (tasks, shopping, meals, contacts, budget, notes, calendar agenda)
- Unified empty states using shared `.empty-state` class across all modules (replaces per-module CSS)
- `stagger()` and `vibrate()` UX utilities in `public/utils/ux.js` with full test coverage
- Proportional opacity on swipe-reveal action areas in tasks (already implemented, confirmed)
- FAB colors tied to per-module accent tokens via CSS custom properties
- `scrollIntoView` for focused inputs when virtual keyboard opens in modals (300ms delay)
- Consistent vibration feedback via `vibrate()` utility across tasks, shopping, contacts, budget, and notes
- Bottom sheet modal on mobile (< 768px) with drag handle, slide-in animation, and swipe-to-close
- Enter-key navigation between form fields in modals; Enter on last field triggers submit
- Blur-triggered inline validation for required fields with error/success border states
- `wireBlurValidation()`, `btnSuccess()`, and `btnError()` exported from `modal.js`
- Submit button checkmark-success (700ms) and shake-error feedback animations

## [0.1.0] - 2026-03-29

Initial release of Oikos - a self-hosted family planner for 2–6 person households. Runs as a Docker container behind Nginx with SSL, no cloud dependency.

### Added

- **Dashboard** with time-of-day greeting, urgent tasks, upcoming events, today's meals, pinned notes, and weather widget (OpenWeatherMap integration with 3–5 day forecast scaling by screen size)
- **Task management** with categories, priorities, due dates, subtasks (max 2 levels), list and Kanban views, swipe gestures on mobile (swipe left = toggle done, swipe right = edit), and recurring tasks via iCal RRULE
- **Shopping lists** with multiple named lists, supermarket-aisle sorting, autocomplete from history, optimistic checkbox toggle, and bulk-clear of checked items
- **Weekly meal planner** with breakfast/lunch/dinner/snack grid (Mon–Sun), ingredient tracking per meal, and one-click transfer of ingredients to shopping lists
- **Calendar** with month, week, day, and agenda views, multi-day event support, color-coded entries, and family member assignment
- **Google Calendar sync** via OAuth 2.0 with incremental sync tokens and **Apple CalDAV sync** via tsdav, both bidirectional
- **Pinboard** (notes) with color-coded sticky notes, pin-to-top, Markdown formatting toolbar (bold, italic, lists, headings, code, links), and automatic text contrast based on background color
- **Contacts** directory with category filtering (doctor, emergency, trades, etc.), full-text search, and direct tel:/mailto:/maps: links
- **Budget tracker** with income/expense logging, monthly navigation, category breakdown bar charts (pure CSS), and CSV export
- **Settings page** for password change, calendar sync status, and family member management
- **Authentication** with session-based login (bcrypt, httpOnly/secure/sameSite cookies, 7-day TTL), admin-only user creation, and rate-limited login (5 attempts/min with 15-min lockout)
- **CSRF protection** using Double Submit Cookie pattern with timing-safe comparison
- **Progressive Web App** with app-shell caching (service worker with stale-while-revalidate for static assets, network-first for navigation, network-only for API), custom install prompt for Android and iOS, dynamic theme-color per module, safe area inset handling, and offline fallback
- **Responsive design** with mobile bottom navigation (swipeable pages with dot indicator), collapsible sidebar on tablet, and full sidebar on desktop
- **Dark mode** with system preference detection and manual toggle, warm-tinted neutral color scale
- **Design system** with CSS custom properties (tokens for colors, spacing, typography, shadows, radii, z-indices), module-specific accent colors, and consistent component patterns
- **Accessibility** improvements: skip link, sr-only headings on all pages, aria-hidden decorative icons, aria-label on icon-only buttons, token-based touch targets (44–48px), 12px minimum font size, and prefers-reduced-motion support
- **Docker deployment** with docker-compose, optional SQLCipher encryption (AES-256), and nginx.conf example
- **Setup script** (`node setup.js`) for initial admin account creation with LAN-reachable URL display
- **Input validation** middleware with centralized rules (string length, date/time format, enum, color) across all API routes
- **Content Security Policy** via Helmet with strict CSP, self-hosted Lucide Icons (no CDN at runtime)
- **Lazy loading** with per-page ES module imports cached in memory, Cache-Control headers (immutable for assets, must-revalidate for code), and service worker update notification

### Security

- Fail-fast on missing `SESSION_SECRET` in production
- Rate limiting on login endpoint and global API limiter (300 req/min/IP)
- No user data cached by service worker (API requests are network-only)
- Hardened `.gitignore` and `.dockerignore` to prevent accidental secret or binary leakage

[Unreleased]: https://github.com/ulsklyc/oikos/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/ulsklyc/oikos/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ulsklyc/oikos/compare/v0.5.9...v0.6.0
[0.5.9]: https://github.com/ulsklyc/oikos/compare/v0.5.8...v0.5.9
[0.5.8]: https://github.com/ulsklyc/oikos/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/ulsklyc/oikos/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/ulsklyc/oikos/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/ulsklyc/oikos/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/ulsklyc/oikos/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/ulsklyc/oikos/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/ulsklyc/oikos/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/ulsklyc/oikos/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ulsklyc/oikos/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ulsklyc/oikos/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ulsklyc/oikos/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/ulsklyc/oikos/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ulsklyc/oikos/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ulsklyc/oikos/releases/tag/v0.1.0
