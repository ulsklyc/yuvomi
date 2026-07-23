# Yuvomi Web Installer

A browser-based setup wizard for Yuvomi. Run it once to configure your `.env`,
start your container engine, and create your admin account — no hand-editing of
config files. Works with both Docker and Podman (auto-detected).

## Usage

From the repository root:

```bash
node tools/installer/install-server.js
```

Then open **http://localhost:8090** in your browser.

The server shuts down automatically after setup completes (or after 30 minutes of inactivity).

## Requirements

- Node.js 18+ (the installer itself has zero npm dependencies — Node built-ins only)
- A container engine — either **Docker** with Compose v2, or **Podman** with the
  `podman compose` subcommand (4.1+) or the `podman-compose` package
- The repository cloned locally

The wizard auto-detects the engine (Docker preferred, Podman fallback) and verifies
that it plus its compose command are available before it starts, surfacing container
start/spawn errors in the UI instead of failing silently. With Podman it uses the
dedicated `podman-compose.yml` (SELinux `:Z` labels).

## What it does

1. Detects the container engine (Docker or Podman), checks its prerequisites, and
   reports any existing `.env` file or running `oikos` container before you start
2. Lets you pick a setup path on the welcome screen:
   - **Simple setup** (recommended for non-technical users) — auto-generates the
     security keys, applies safe localhost/HTTP defaults, and goes straight to
     creating your admin account. Two or three clicks, no jargon.
   - **Advanced setup** — walks every option, step by step. Security keys are
     still pre-generated (regenerate any time), and each screen is optional:
     - **Basics** — domain/IP, timezone (`TZ`), HTTP host port (`OIKOS_HTTP_PORT`)
     - **Security keys** — `SESSION_SECRET` and `DB_ENCRYPTION_KEY` (pre-filled)
     - **Weather** — Open-Meteo coordinates (no API key)
     - **Calendar** — Google Calendar and Apple CalDAV
     - **Email** — SMTP for the "forgot password" flow (`EMAIL_SMTP_*`,
       `EMAIL_FROM_*`); enables password-reset emails
     - **Advanced** — reverse-proxy/HTTPS (`SESSION_SECURE`, `TRUST_PROXY`),
       Single Sign-On (OIDC), automatic backups, off-site WebDAV backups
       (`WEBDAV_BACKUP_*`), local-folder or WebDAV document storage, live
       currency rates (`FIXER_API_KEY`), and the Web-Push contact (`VAPID_SUBJECT`)
   - Either path derives and writes `BASE_URL` from your host/port/scheme so
     password-reset links work out of the box.
   - A language switcher (top corner) overrides the auto-detected browser
     language and remembers your choice.
3. Backs up any existing `.env` to `.env.bak-<ISO>` before writing
4. Writes `.env` to the project root (keys are allowlisted against the shared
   env schema; values containing line breaks are rejected, and values with
   whitespace, `#`, quotes or `$` are quote-escaped so Docker Compose reads
   them back verbatim)
5. Starts the container (`docker compose up -d`, or `podman compose -f
   podman-compose.yml up -d` / `podman-compose -f podman-compose.yml up -d`)
6. Polls the health endpoint until the container is ready
7. Creates your first admin account via `POST /api/v1/auth/setup`
8. Offers to download a copy of the written `.env` on the final screen — the
   only backup of the encryption keys, which cannot be recovered if lost

The local-folder document-storage fields are optional. Setting `DOCUMENT_STORAGE_LOCAL_ENABLED=true`
writes new document files (including calendar attachments) to `DOCUMENT_STORAGE_LOCAL_PATH` (default
`/documents`, a mounted host folder) instead of the database, and takes precedence over every selected
backend. Mount that folder into the container (see `docker-compose.yml`); existing files are not migrated.

The WebDAV document-storage fields are optional. Non-empty
`DOCUMENT_STORAGE_WEBDAV_ENABLED`, `_URL`, `_USERNAME`, `_PASSWORD`, and `_PATH` values override
their matching in-app settings individually. They control the destination for new document files,
including calendar attachments; existing local files are not migrated. Private or LAN WebDAV
targets must be supplied through these deployment variables because URLs managed in the admin UI
are restricted to public network addresses.

The Google Drive Documents fields configure OAuth only. `GOOGLE_DRIVE_CLIENT_ID` and
`GOOGLE_DRIVE_CLIENT_SECRET` are optional paired overrides; when both are empty, the runtime reuses
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `GOOGLE_DRIVE_REDIRECT_URI` is always Drive-specific
and must exactly match `/api/v1/documents/storage/google-drive/callback`. After installation, connect
and test Drive in **Settings → Documents → Document storage**, then explicitly select it. OAuth
success alone never changes the upload destination.

> SQLite/database backups do not contain document binaries stored in a local folder, on WebDAV, or
> in Google Drive. Back up the selected external target separately.

## Localization

The wizard is fully localized into all 23 languages supported by the app and
detects the browser language automatically (`de` is the reference locale, `en`
the fallback). Translations live in `tools/installer/locales/*.json` and are
loaded by `i18n-mini.js`, which mirrors the app's locale resolution.

The **CLI installer** (`install.sh` at the repo root) is localized into the same
23 languages. It detects the language from the shell environment
(`OIKOS_INSTALLER_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG`) and accepts a
`--lang <code>` override. Its strings live in `tools/installer/locales/cli/<lang>.sh`
— one sourced shell file per language that sets `MSG_*` variables; `en.sh` is the
fallback base, the active language overlays it. Key parity across all 23 files is
enforced by `test-installer-cli-i18n.js`.

## Design

The wizard reuses the app's design language: shared design tokens
(`public/styles/tokens.css`) and the Plus Jakarta Sans variable font are served
read-only from the repo, so the installer matches the app's violet accent,
radii, shadows, and automatic dark mode. An inline fallback token block (with a
dark-mode variant) precedes the `tokens.css` link, so the wizard stays legible
even if that stylesheet cannot be served. The wizard meets WCAG 2.1 AA
(keyboard-operable accordions, ARIA live regions for Docker status, focus
management, labelled controls, a `<main>` landmark, and field-level error
identification — `aria-invalid` plus focus moved to the offending input).

## Architecture

- `install-server.js` — the temporary HTTP server (port 8090), bound to
  loopback. State-changing `POST`s are rejected (403) unless the request's Host
  and any Origin/Referer are loopback, guarding against DNS-rebinding/CSRF while
  the installer runs. Endpoints:
  `GET /api/defaults` (serves `ENV_SCHEMA`), `GET /api/prereqs`,
  `GET /api/preflight` (existing `.env` / running container),
  `POST /api/generate-secret`, `POST /api/save-env` (returns the written path),
  `POST /api/start`, `GET /api/status`, `POST /api/create-admin`.
- `env-schema.js` — the single source of truth (`ENV_SCHEMA`) for every
  configurable variable, its group, default, and whether it is written to `.env`.
- `i18n-mini.js` + `locales/*.json` — web-wizard localization.
- `locales/cli/*.sh` — CLI-installer localization (sourced by `install.sh`).
- `install.html` — the wizard UI.
