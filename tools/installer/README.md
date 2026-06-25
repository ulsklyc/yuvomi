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
2. Guides you through all configuration options, grouped into steps:
   - **Basics** — timezone (`TZ`) and HTTP host port (`OIKOS_HTTP_PORT`)
   - **Security keys** — generates `SESSION_SECRET` and `DB_ENCRYPTION_KEY`
   - **Optional integrations** — weather (Open-Meteo coordinates, no API key), Google Calendar, Apple CalDAV, and WebDAV document storage
   - **Advanced** — reverse-proxy/HTTPS (`SESSION_SECURE`, `TRUST_PROXY`),
     Single Sign-On (OIDC), and automatic backups
3. Backs up any existing `.env` to `.env.bak-<ISO>` before writing
4. Writes `.env` to the project root (keys are allowlisted against the shared
   env schema; values containing line breaks are rejected)
5. Starts the container (`docker compose up -d`, or `podman compose -f
   podman-compose.yml up -d` / `podman-compose -f podman-compose.yml up -d`)
6. Polls the health endpoint until the container is ready
7. Creates your first admin account via `POST /api/v1/auth/setup`

The WebDAV document-storage fields are optional. Non-empty
`DOCUMENT_STORAGE_WEBDAV_ENABLED`, `_URL`, `_USERNAME`, `_PASSWORD`, and `_PATH` values override
their matching in-app settings individually. They control the destination for new document files,
including calendar attachments; existing local files are not migrated. Private or LAN WebDAV
targets must be supplied through these deployment variables because URLs managed in the admin UI
are restricted to public network addresses.

> SQLite/database backups do not contain document binaries stored on WebDAV. Back up the WebDAV
> target separately.

## Localization

The wizard is fully localized into all 20 languages supported by the app and
detects the browser language automatically (`de` is the reference locale, `en`
the fallback). Translations live in `tools/installer/locales/*.json` and are
loaded by `i18n-mini.js`, which mirrors the app's locale resolution.

The **CLI installer** (`install.sh` at the repo root) is localized into the same
20 languages. It detects the language from the shell environment
(`OIKOS_INSTALLER_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG`) and accepts a
`--lang <code>` override. Its strings live in `tools/installer/locales/cli/<lang>.sh`
— one sourced shell file per language that sets `MSG_*` variables; `en.sh` is the
fallback base, the active language overlays it. Key parity across all 20 files is
enforced by `test-installer-cli-i18n.js`.

## Design

The wizard reuses the app's design language: shared design tokens
(`public/styles/tokens.css`) and the Plus Jakarta Sans variable font are served
read-only from the repo, so the installer matches the app's violet accent,
radii, shadows, and automatic dark mode. The wizard meets WCAG 2.1 AA
(keyboard-operable accordions, ARIA live regions for Docker status, focus
management, and labelled controls).

## Architecture

- `install-server.js` — the temporary HTTP server (port 8090). Endpoints:
  `GET /api/defaults` (serves `ENV_SCHEMA`), `GET /api/prereqs`,
  `GET /api/preflight` (existing `.env` / running container),
  `POST /api/generate-secret`, `POST /api/save-env`, `POST /api/start`,
  `GET /api/status`, `POST /api/create-admin`.
- `env-schema.js` — the single source of truth (`ENV_SCHEMA`) for every
  configurable variable, its group, default, and whether it is written to `.env`.
- `i18n-mini.js` + `locales/*.json` — web-wizard localization.
- `locales/cli/*.sh` — CLI-installer localization (sourced by `install.sh`).
- `install.html` — the wizard UI.
