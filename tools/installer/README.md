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

The server shuts down **5 minutes after your admin account is created** (or after 30 minutes
of inactivity otherwise). Download the generated `.env` before you close the tab.

## Requirements

- Node.js 22+, the version the repository targets and CI tests (the installer itself has zero npm dependencies - Node built-ins only)
- A container engine — either **Docker** with Compose v2, or **Podman** with the
  `podman compose` subcommand (4.1+) or the `podman-compose` package
- The repository cloned locally

The wizard auto-detects the engine (Docker preferred, Podman fallback) and verifies
that it plus its compose command are available before it starts, surfacing container
start/spawn errors in the UI instead of failing silently. With Podman it uses the
dedicated `podman-compose.yml` (SELinux `:Z` labels).

## What it does

1. Detects the container engine (Docker or Podman), checks its prerequisites, and
   reports an existing `.env` file **and a running `yuvomi` container** before you
   start - a running container matters because saving restarts it, so the household
   is briefly cut off. When it finds an existing `.env`, the **simple
   path is disabled** and you continue with the advanced setup: the simple path writes
   fixed values for host, port, `SESSION_SECURE` and `TRUST_PROXY`, which would
   silently downgrade an installation that already runs behind a reverse proxy
2. Lets you pick a setup path on the welcome screen:
   - **Simple setup** (recommended for non-technical users) — auto-generates the
     security keys, applies safe localhost/HTTP defaults, and goes straight to
     creating your admin account. Two or three clicks, no jargon.
   - **Advanced setup** — walks every option, step by step. Security keys are
     still pre-generated (regenerate any time), and each screen is optional:
     - **Basics** — domain/IP, HTTP host port (`OIKOS_HTTP_PORT`), timezone (`TZ`,
       which also pre-sets the household zone - changeable later in the app),
       how Yuvomi is exposed (`SESSION_SECURE`, `TRUST_PROXY`) and the public
       address (`BASE_URL`). The exposure choice follows the host you enter, and the
       combination of an `http://` address with enforced secure cookies is rejected -
       nobody could sign in to that. A timezone the browser does not recognise
       (`Europe/Berln`) is refused on the spot instead of falling back to UTC
     - **Security keys** — `SESSION_SECRET` and `DB_ENCRYPTION_KEY` (pre-filled
       on a fresh install; existing keys are kept, see below)
     - **Weather** — Open-Meteo coordinates (no API key)
     - **Calendar** — Google Calendar and Apple CalDAV
     - **Email** — SMTP (`EMAIL_SMTP_*`, `EMAIL_FROM_*`); enables password-reset
       emails, email as a household notification channel, and sending a shopping
       list to a member; a port outside 1-65535 is refused on the spot
     - **Storage & backups** — the host data folder (`DATA_DIR`), automatic backups,
       off-site WebDAV backups (`WEBDAV_BACKUP_*`), and local-folder, WebDAV or
       Google Drive document storage. Everything that decides *where data lives*
     - **Advanced** — Single Sign-On (OIDC, including whether SSO becomes the only
       way in), the four home-network permissions
       (calendar subscriptions, recipe mirrors, waste collection feeds, WebDAV
       target - they lift the SSRF protection and are asked as one group), the calendar sync interval, live
       currency rates (`FIXER_API_KEY`) and the Web-Push contact (`VAPID_SUBJECT`).
       Everything that decides *what Yuvomi connects to*
   - The advanced path asks for `BASE_URL` (pre-filled from host, port and the
     exposure choice); the simple path derives it. A typed value only wins over
     the pre-fill when it names a full `http://` or `https://` origin.
     Every redirect URI the wizard
     shows - Google Calendar, Google Drive, OIDC - is built from that one value, so
     what you copy into a provider console is what the app will send.
   - A language switcher (top corner) overrides the auto-detected browser
     language and remembers your choice.
   - Reloading or closing the page mid-setup asks for confirmation first: the
     wizard deliberately keeps no form state (the fields carry secrets), so a
     stray reload used to discard everything silently.
   - **Existing keys survive a re-run.** If `SESSION_SECRET` or
     `DB_ENCRYPTION_KEY` are already in your `.env`, no new value is generated
     for them: the encryption key opens your current database, and a fresh one
     would leave the app unable to start. Their fields stay empty on the
     security-keys screen and the old values are written back unchanged. Typing
     a value anyway overrides this, which is the deliberate way to start over.
     The wizard never receives the existing values — the server reports only
     which keys exist and restores them when it writes the file.
3. Backs up any existing `.env` to `.env.bak-<ISO>` before writing
4. Writes `.env` to the project root (keys are allowlisted against the shared
   env schema; values containing line breaks are rejected, and values with
   whitespace, `#`, quotes or `$` are quote-escaped so Docker Compose reads
   them back verbatim)
5. Starts the container (`docker compose up -d`, or `podman compose -f
   podman-compose.yml up -d` / `podman-compose -f podman-compose.yml up -d`)
6. Polls the health endpoint until the container is ready
7. Creates your first admin account via `POST /api/v1/auth/setup`
8. Offers to download the written `.env` on the final screen — the only backup
   of newly generated encryption keys, which cannot be recovered if lost. The
   download is served from disk (`GET /api/env-file`), so it is the file itself,
   including values carried over from a previous run and the two secrets the
   wizard itself never sees. Same loopback guard as every other API route

The local-folder document-storage fields are optional. Setting `DOCUMENT_STORAGE_LOCAL_ENABLED=true`
writes new document files (including calendar attachments) to `DOCUMENT_STORAGE_LOCAL_PATH` (default
`/documents`) instead of the database, and takes precedence over every selected backend. Existing
files are not migrated.

The two local-storage paths are the two ends of one mount and must not drift apart:
`DOCUMENT_STORAGE_LOCAL_DIR` is the **host** folder, `DOCUMENT_STORAGE_LOCAL_PATH` the **container**
path the app writes to. The Compose files derive both ends from the `.env`
(`${DOCUMENT_STORAGE_LOCAL_DIR}:${DOCUMENT_STORAGE_LOCAL_PATH}`), because a mount fixed at
`/documents` would send uploads into the container layer as soon as anyone changes the path — gone on
the next image update, while the database keeps referencing them.

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
and test Drive in **Settings → Sync → Document storage**, then explicitly select it. OAuth
success alone never changes the upload destination.

> SQLite/database backups do not contain document binaries stored in a local folder, on WebDAV, or
> in Google Drive. Back up the selected external target separately.

## Localization

The wizard is fully localized into all 24 languages supported by the app and
detects the browser language automatically (`de` is the reference locale, `en`
the fallback). Translations live in `tools/installer/locales/*.json` and are
loaded by `i18n-mini.js`, which mirrors the app's locale resolution.

The **CLI installer** (`install.sh` at the repo root) is localized into the same
24 languages. It detects the language from the shell environment
(`OIKOS_INSTALLER_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG`) and accepts a
`--lang <code>` override. Its strings live in `tools/installer/locales/cli/<lang>.sh`
— one sourced shell file per language that sets `MSG_*` variables; `en.sh` is the
fallback base, the active language overlays it. Key parity across all 24 files is
enforced by `test-installer-cli-i18n.js`, which also checks that every value is a
`printf` format matching its call site (each value is passed to `printf` as the
format string, so a stray `%` or a wrong `%s` count is a runtime bug).

Unlike the wizard, the CLI installer writes `.env` from a fixed template. Every
key it does **not** ask about is carried over from the previous file rather than
dropped, so an installation configured by hand or through the wizard survives a
re-run; the set of keys the dialog owns is the `MANAGED_KEYS` array in
`install.sh`, and `test-installer-env-write.js` enforces that it matches the
template in both directions. It asks for `BASE_URL` instead of deriving it,
because behind a reverse proxy the public origin differs from the host and port
the container listens on — and it reads `SESSION_SECURE` and `TRUST_PROXY` back
out of that answer, since both server defaults are wrong for the other mode
(no HSTS behind HTTPS; `X-Forwarded-For` trusted without a proxy in front,
which is what the per-IP login rate limit counts). An existing value in `.env`
wins over the derivation.

## Design

The wizard reuses the app's design language: the shared design tokens
(`public/styles/tokens.css`) are served read-only from the repo, so the
installer matches the app's violet accent, radii, shadows, and automatic dark
mode. No font is served any more - the app took the system font stack with the
v2.0.0 redesign, and the `/fonts/` route went with the typeface it carried.
An inline fallback token block (with a dark-mode variant) precedes the
`tokens.css` link, so the wizard stays legible even if that stylesheet cannot be
served; its values mirror the current tokens, because a fallback that shows the
previous release sends the diagnosis in the wrong direction. The wizard meets WCAG 2.1 AA
(keyboard-operable accordions, ARIA live regions for Docker status, focus
management, labelled controls, a `<main>` landmark, and field-level error
identification - `aria-invalid` plus focus, with the error banner relocated
beneath the offending field and linked to it via `aria-describedby`). The step
counter is announced together with each step heading, the container log is
keyboard-focusable and scrollable, and the irreversible save step arms visibly
(accent ring), audibly (live region) and with a short cooldown so a literal
double-click cannot pass both confirmation stages at once.

## Architecture

- `install-server.js` — the temporary HTTP server (port 8090), bound to
  loopback. State-changing `POST`s are rejected (403) unless the request's Host
  and any Origin/Referer are loopback, guarding against DNS-rebinding/CSRF while
  the installer runs. Endpoints:
  `GET /api/defaults` (serves `ENV_SCHEMA`), `GET /api/prereqs`,
  `GET /api/preflight` (existing `.env` / running container),
  `POST /api/generate-secret`, `POST /api/save-env` (returns the written path),
  `POST /api/start`, `GET /api/status`, `POST /api/create-admin`,
  `GET /api/env-file` (serves the written `.env` for the final download - same
  loopback guard, since the file carries the encryption keys).
- `env-schema.js` — the single source of truth (`ENV_SCHEMA`) for every
  configurable variable, its group, default, and whether it is written to `.env`.
- `i18n-mini.js` + `locales/*.json` — web-wizard localization.
- `locales/cli/*.sh` — CLI-installer localization (sourced by `install.sh`).
- `install.html` — the wizard UI.
