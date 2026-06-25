## Quick Install

Three ways to get Yuvomi running from scratch:

### Option A — Web Installer (recommended, all platforms)

```bash
git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
node tools/installer/install-server.js
# Open http://localhost:8090
```

Requires Node.js 18+ on the host. The browser-based wizard is fully localized (20 languages, auto-detected from your browser), detects your container engine (Docker or Podman) first, then configures your `.env` — including optional reverse-proxy/HTTPS, Single Sign-On (OIDC), and automatic backups — starts the container, and creates your admin account. The engine still runs the app itself.

### Option B — CLI Installer (Linux / macOS)

```bash
git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
bash install.sh
```

The script checks prerequisites, generates security keys, configures optional integrations, starts the container (Docker or Podman — auto-detected), and creates your admin account. Like the web installer, it is fully localized in 20 languages and auto-detects yours from the shell environment (`LANG`/`LC_ALL`).

Force a specific language with `--lang` (one of `de en es fr it sv el ru tr zh ja ar hi pt uk pl nl cs vi hu`):

```bash
bash install.sh --lang de
```

Non-interactive mode (CI/provisioning — provide your own `.env`):

```bash
bash install.sh --env-file /path/to/.env
```

### Option C — Manual (Docker or Podman, no clone required)

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/.env.example
cp .env.example .env  # set SESSION_SECRET and DB_ENCRYPTION_KEY
docker compose up -d
```

**Podman (RHEL / Fedora / CentOS Stream):** grab `podman-compose.yml` instead — it
adds the SELinux `:Z` relabel so the rootless container can write to its volumes:

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/podman-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/.env.example
cp .env.example .env  # set SESSION_SECRET and DB_ENCRYPTION_KEY
podman compose -f podman-compose.yml up -d   # or: podman-compose -f podman-compose.yml up -d
```

Then open the WebUI — the first visit guides you through creating your admin account in
the browser. Headless deployments can instead create it from the container console with
`docker compose exec oikos node setup.js` (or the matching `podman compose … exec`).

---

# Installation Guide

Complete setup instructions for Yuvomi - from Docker installation to your first login.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Step-by-Step Installation](#step-by-step-installation)
- [Environment Variables](#environment-variables)
- [HTTPS / Reverse Proxy (Nginx)](#https--reverse-proxy-nginx)
- [Updates](#updates)
- [Backup & Restore](#backup--restore)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

---

## Architecture Overview

Yuvomi is a self-hosted family planner that runs as a single Docker container. The Express.js backend serves both the API and the static frontend files. Application data is stored in a SQLCipher-encrypted SQLite database inside a host-mounted data folder, and automated database backups are written to a separate host-mounted backup folder. Optionally, newly uploaded document files can be stored on a WebDAV server instead of inside SQLite.

```
Browser ──HTTP──▶ Docker Container (Express.js :3000) ──▶ SQLite/SQLCipher (/data/oikos.db)

With HTTPS (recommended for network access):
Browser ──HTTPS──▶ Nginx (Reverse Proxy) ──HTTP──▶ Docker Container (Express.js :3000) ──▶ SQLite/SQLCipher
```

For local-only access, the Docker container is all you need. If you want to access Yuvomi from other devices on your network or the internet, add Nginx as a reverse proxy with SSL.

---

## Prerequisites

### Docker & Docker Compose

Docker packages your application and all its dependencies into a container, so you don't need to install Node.js, SQLCipher, or anything else on your host system. Docker Compose orchestrates the container using a simple configuration file.

Install Docker for your platform:

- **Linux**: [docs.docker.com/engine/install](https://docs.docker.com/engine/install/)
- **macOS**: [docs.docker.com/desktop/install/mac-install](https://docs.docker.com/desktop/install/mac-install/)
- **Windows**: [docs.docker.com/desktop/install/windows-install](https://docs.docker.com/desktop/install/windows-install/)

Verify your installation:

```bash
docker --version           # Docker version 27.x.x or later
docker compose version     # Docker Compose version v2.x.x
```

### Podman (alternative to Docker, RHEL / Fedora / CentOS Stream)

RHEL-based distributions ship **Podman** (often rootless) and **SELinux** instead of
Docker. Yuvomi supports Podman out of the box: both installers auto-detect it, and a
dedicated `podman-compose.yml` adds the SELinux `:Z` volume relabel. Install Podman and
either the `podman compose` subcommand (Podman 4.1+) or the `podman-compose` package:

```bash
sudo dnf install -y podman podman-compose   # Fedora / RHEL 9+ / CentOS Stream
podman --version              # podman version 4.x / 5.x
podman compose version        # or: podman-compose --version
```

No extra SELinux configuration is required — the `:Z` labels in `podman-compose.yml`
(and the Quadlet unit) relabel the bind mounts for the container automatically.

### Git

You need Git to clone the repository and pull updates later.

- **All platforms**: [git-scm.com/downloads](https://git-scm.com/downloads)

```bash
git --version              # git version 2.x.x
```

### System Requirements

- **RAM**: 256 MB minimum (the container is lightweight)
- **Disk**: ~500 MB for the Docker image, plus space for your database

---

## Step-by-Step Installation

There are six ways to get Yuvomi running. **Option A** (web installer) is recommended for most users — it walks you through every step in your browser. **Option B** (pre-built image) is a quick manual alternative. **Option C** (build from source) is for contributors or custom builds. **Options D–F** install directly from a NAS/home-server app store with no terminal required: **Option D** (TrueNAS SCALE), **Option E** (Umbrel), and **Option F** (Unraid).

---

### Option A — Web Installer (Recommended)

Requires Node.js 18+ and Docker on the host.

#### 1. Clone the Repository

```bash
git clone https://github.com/ulsklyc/yuvomi.git
cd yuvomi
```

#### 2. Start the Installer

```bash
node tools/installer/install-server.js
```

#### 3. Open the Wizard

Open your browser and navigate to **http://localhost:8090**. The wizard detects your browser language (20 languages supported), verifies that a container engine is available (Docker with Compose v2, or Podman with `podman compose` / `podman-compose`), and reports any existing `.env` file or running container before you start. It then guides you through:

- Basics — timezone (`TZ`) and HTTP host port (`OIKOS_HTTP_PORT`)
- Security key generation (`SESSION_SECRET`, `DB_ENCRYPTION_KEY`)
- Optional integrations (weather, Google Calendar, Apple CalDAV, WebDAV document storage)
- Advanced settings — reverse-proxy/HTTPS (`SESSION_SECURE`, `TRUST_PROXY`), Single Sign-On (OIDC), and automatic backups
- Writing your `.env` file (an existing `.env` is backed up to `.env.bak-<timestamp>` first)
- Starting the container (via Docker or Podman, whichever was detected)
- Creating your admin account

The installer server shuts down automatically after setup completes (or after 30 minutes of inactivity).

---

### Option B — Pre-built Image

A ready-to-use Docker image is published to the GitHub Container Registry on every release. You only need two files.

#### 1. Download the Compose File and Example Config

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/.env.example
```

#### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and set at minimum the two required secrets:

```bash
SESSION_SECRET=<YOUR-SECRET>
DB_ENCRYPTION_KEY=<YOUR-SECRET>
```

Generate a secure value for each:

```bash
openssl rand -hex 32
```

Run this command **twice** and paste each result. See [Environment Variables](#environment-variables) for all options.

#### 3. Start the Container

```bash
docker compose up -d
```

Docker pulls `ghcr.io/ulsklyc/yuvomi:latest` automatically. No build step, no Node.js installation needed.

Continue with [Step 4 — Verify](#4-verify-the-container-is-running).

---

### Option C — Build from Source

#### 1. Clone the Repository

```bash
git clone https://github.com/ulsklyc/yuvomi.git
cd yuvomi
```

#### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and set the two required secrets (see above). Generate them with `openssl rand -hex 32`.

#### 3. Build and Start the Container

```bash
docker compose up -d --build
```

- `--build` compiles the Docker image locally (SQLCipher dependencies, npm packages).
- `-d` runs the container in the background.

The first build takes a few minutes. Subsequent starts are much faster.

### 4. Verify the Container is Running <a name="4-verify-the-container-is-running"></a>

Check the logs to confirm a successful start:

```bash
docker compose logs -f
```

You should see output like:

```
oikos  | [Yuvomi] Server läuft auf Port 3000
oikos  | [Yuvomi] Umgebung: production
oikos  | [Sync] Auto-Sync alle 15 Minuten aktiv.
```

Press `Ctrl+C` to stop following the logs (the container keeps running).

### 5. Create the First Admin Account

On the first visit, Yuvomi detects that no account exists yet and guides you through
creating your admin account directly in the browser (see step 6). The form asks for:
- **Username** (3–64 characters; letters, numbers, dots, hyphens, underscores)
- **Display name** (e.g. "Jane Doe")
- **Password** (minimum 8 characters, with a confirmation field)

After you submit, Yuvomi creates the admin, signs you in automatically, and the setup
form is no longer reachable.

**Headless alternative (CLI):** if you prefer not to use the browser — or are scripting
a provisioning step — create the admin from the container console instead:

```bash
docker compose exec oikos node setup.js
```

### 6. Open Yuvomi

Open your browser and navigate to:

```
http://localhost:3000
```

Log in with the admin credentials you just created. You can add family members from the **Settings** page.

---

### Option D — TrueNAS SCALE (Community Apps Catalog)

No terminal required. Yuvomi is available directly in the TrueNAS SCALE Community Apps Catalog.

#### 1. Open the Apps Catalog

In your TrueNAS SCALE web UI, go to **Apps → Discover Apps** and search for **Yuvomi**.

#### 2. Configure and Install

Click **Install**. Fill in the configuration form:

- **Session Secret** (required) — use a long random string
- **Database Encryption Key** (recommended) — generate with `openssl rand -hex 32`; back it up, it cannot be recovered or changed on an existing database
- Adjust port and storage paths as needed

Click **Install** to start the container.

#### 3. Open the WebUI

Once the app status shows **Running**, click **WebUI** in the Apps overview. The first visit guides you through creating your admin account in the browser.

---

### Option E — Umbrel (App Store)

No terminal required. Yuvomi is available in the Umbrel App Store — everything runs on, and stays on, your Umbrel.

#### 1. Open the App Store

In your Umbrel dashboard, open the **App Store** and search for **Yuvomi**.

#### 2. Install with One Click

Click **Install**. Umbrel pulls the image and starts the container for you — there are no configuration files to edit.

#### 3. Open Yuvomi

Launch Yuvomi from your Umbrel home screen. The first visit guides you through creating your admin account in the browser.

> **Finish setup right away.** When Umbrel's reverse-proxy authentication is disabled, the unauthenticated first-run setup endpoint is reachable on your LAN until you create the admin account. Complete the first-run setup immediately after installing.

---

### Option F — Unraid (Community Apps)

No terminal required. Yuvomi ships as an Unraid Community Applications template.

#### 1. Open Community Applications

In Unraid, open the **Apps** tab (the Community Applications plugin) and search for **Yuvomi**.

#### 2. Configure the Template

Click **Install**. In the template, set:

- **SESSION_SECRET** (required) — a long random string
- **DB_ENCRYPTION_KEY** (recommended) — generate with `openssl rand -hex 32`; back it up, it cannot be recovered or changed on an existing database
- Adjust the WebUI port and the appdata path if needed

#### 3. Apply and Open

Click **Apply**. Once the container is running, click the Yuvomi icon → **WebUI**. The first visit guides you through creating your admin account in the browser.

---

## Environment Variables

All configuration happens in the `.env` file. The container reads these values on startup.

> **Self-hosting under the GDPR?** Several optional integrations below (weather, Google/OIDC SSO, WebDAV backup, WebDAV document storage) can send data to third parties, some outside the EU/EEA. See [Privacy for self-hosters](PRIVACY-FOR-SELFHOSTERS.md) for per-service third-country assessments, data-processing-agreement notes and log-retention guidance before enabling them.

### Server

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Port the Express server listens on **inside the container** (rarely changed) | `3000` | No |
| `OIKOS_HTTP_PORT` | Host port that the compose file maps to the container's port 3000. Change this to expose Yuvomi on a different host port; the app inside the container always listens on 3000. | `3000` | No |
| `OIKOS_HTTP_BIND` | Host bind address for the published port (`podman-compose.yml` only). Set to `127.0.0.1` for rootless Podman behind a reverse proxy on the same host. | `0.0.0.0` | No |
| `TZ` | Container timezone (e.g. `Europe/Berlin`). Affects timestamps and the automated-backup schedule. | `UTC` | No |
| `NODE_ENV` | Runtime environment | `production` | No |
| `TRUST_PROXY` | Number of reverse-proxy hops to trust, or a subnet string (e.g. `1`, `172.16.0.0/12`, `loopback`). Set to `1` when running behind a single Traefik/Nginx hop so `req.ip` returns the real client IP. Numeric values are treated as a hop count; subnet strings and named values (`loopback`, `linklocal`, `uniquelocal`) work as expected. | `false` | No |

### Security

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SESSION_SECRET` | Secret key for signing session cookies. **Change this!** | - | **Yes** |
| `SESSION_SECURE` | Set to `true` when running behind an HTTPS reverse proxy (Caddy, Nginx, Traefik). Leave unset for direct HTTP access (e.g. TrueNAS, bare Docker). | `false` | No |
| `RATE_LIMIT_WINDOW_MS` | Time window for rate limiting (ms) | `60000` | No |
| `RATE_LIMIT_MAX_ATTEMPTS` | Max login attempts per window | `5` | No |
| `RATE_LIMIT_BLOCK_DURATION_MS` | Block duration after exceeding limit (ms) | `900000` | No |
| `ENABLE_API_DOCS` | API documentation (`/docs`, `/openapi.json`) is admin-only and hidden entirely in production. Set to `true` to expose it to signed-in admins in production too. | `false` (hidden) | No |

Generate a secure `SESSION_SECRET`:

```bash
openssl rand -hex 32
```

### Web Push (Optional)

Push notifications deliver due reminders to a device as system notifications even when the app
is closed. **Requires HTTPS** (the Push API and service workers only work over a secure origin —
see [HTTPS / Reverse Proxy](#https--reverse-proxy-nginx)). Each device opts in under
Settings → Personal → Notifications.

Admins can also add household Gotify or ntfy channels on the same settings page. These channels
are configured in the UI and do not require environment variables. The Yuvomi backend container or
host must be able to reach the configured Gotify/ntfy base URL. HTTPS is recommended; HTTP is
accepted for trusted internal networks such as a private LAN or container network.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `VAPID_PUBLIC_KEY` | VAPID public key. Auto-generated on first use and stored in the database if unset. | auto | No |
| `VAPID_PRIVATE_KEY` | VAPID private key. Set together with the public key to pin a fixed pair across redeployments. | auto | No |
| `VAPID_SUBJECT` | Contact URI (`mailto:` or `https:`) sent to push services. | `mailto:admin@localhost` | No |

Generate a fixed key pair (optional):

```bash
npx web-push generate-vapid-keys
```

### Email / SMTP (Optional)

Configuring an outgoing SMTP server enables the self-service **"Forgot password"** flow on the
login page. Without it, only an admin can reset another user's password. Can also be configured
in Settings → Administration → Email (non-empty env values here override the database).

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `EMAIL_SMTP_HOST` | SMTP server hostname. | - | No |
| `EMAIL_SMTP_PORT` | SMTP server port. | `587` | No |
| `EMAIL_SMTP_SECURE` | Connection security: `ssl`, `starttls`, or `none`. | `starttls` | No |
| `EMAIL_SMTP_USER` | SMTP auth username. | - | No |
| `EMAIL_SMTP_PASS` | SMTP auth password. | - | No |
| `EMAIL_FROM_ADDRESS` | Sender email address. | - | No |
| `EMAIL_FROM_NAME` | Sender display name. | `Yuvomi` | No |
| `BASE_URL` | Absolute origin used to build password-reset links and calendar export-feed URLs, e.g. `https://yuvomi.example.com`. **Required for reset emails to be sent** — the request `Host` header is never trusted as a fallback, to prevent reset-link poisoning. The export feed falls back to the request's protocol/host when unset. | - | No* |

\* Not required to start Yuvomi, but without it the "Forgot password" flow silently sends no email
even when SMTP is otherwise configured.

The "Test connection" button in Settings → Administration → Email verifies the SMTP connection and
sends a probe email to the signed-in admin's own linked address. The SMTP password is never
returned by the API once saved; it is stored in the database the same way as other integration
credentials (e.g. the Apple app-specific password), with encryption-at-rest available via the
optional `DB_ENCRYPTION_KEY`.

### Database & Storage

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DB_PATH` | Path to the SQLite database file inside the container | `/data/oikos.db` | No |
| `DB_ENCRYPTION_KEY` | Encryption key for SQLCipher AES-256. **Change this!** | - | **Yes** |
| `DATA_DIR` | Host directory mounted at `/data` inside the container (set in `.env` or `docker-compose.yml`). | `./data` | No |
| `BACKUP_DIR` | Host directory mounted at `/backups` for scheduled backup files. | `./backups` | No |

Generate a secure `DB_ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

> **Warning**: If you lose this key, you cannot access your database. Keep a backup of your `.env` file in a safe place.

### WebDAV Document Storage (Optional)

Admins can configure **Settings → Documents → WebDAV Storage** as the global destination for all
new document files, including calendar attachments. Existing local documents are not migrated.
Uploads fail closed: if WebDAV cannot accept the file, Yuvomi rejects the upload instead of silently
storing it in SQLite. Disabling WebDAV changes only future uploads; existing WebDAV documents remain
readable and deletable.

The settings UI and the environment use hybrid per-field precedence. Every non-empty environment
value below overrides only its corresponding database value and makes that field read-only in the
UI. Empty values fall back to the database configuration.

For SSRF protection, URLs entered through the admin UI must resolve only to public network
addresses. Private, loopback, link-local, and internal DNS targets are rejected and rechecked when
the connection is opened. To use a trusted WebDAV server on the local network, configure
`DOCUMENT_STORAGE_WEBDAV_URL` through the deployment environment instead.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DOCUMENT_STORAGE_WEBDAV_ENABLED` | Use WebDAV for new document files (`true`/`false`) | `false` | No |
| `DOCUMENT_STORAGE_WEBDAV_URL` | HTTP(S) WebDAV server URL | — | No |
| `DOCUMENT_STORAGE_WEBDAV_USERNAME` | Basic Auth username | — | No |
| `DOCUMENT_STORAGE_WEBDAV_PASSWORD` | Basic Auth password or app password | — | No |
| `DOCUMENT_STORAGE_WEBDAV_PATH` | Base folder for document objects | — | No |

When WebDAV documents already exist, changing the URL, username, password, or base path requires an
explicit confirmation and a successful read test against an existing object. Required connection
data cannot be removed while those documents exist. The connection test performs a temporary
PUT/GET/DELETE roundtrip in the target folder.

> **Important backup boundary:** SQLite/database backups do **not** contain document binaries stored
> on WebDAV. Back up the WebDAV target separately and retain it together with the corresponding
> database backup.

### Weather (Optional)

The weather widget defaults to **Open-Meteo** — free, ECMWF-backed, and requiring **no API key**. Just set your coordinates (find them on [openstreetmap.org](https://www.openstreetmap.org) or Google Maps). You can also configure this in-app under **Settings → Modules → Overview** (admin only), which takes precedence over the environment variables and acts as the household default. Any user can additionally set their own personal location under **Settings → Personal → My Weather**, which overrides the household default just for their own dashboard widget.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `WEATHER_LAT` | Latitude of your location (e.g. `52.52`) | - | No |
| `WEATHER_LON` | Longitude of your location (e.g. `13.41`) | - | No |
| `WEATHER_CITY` | Display name shown on the widget (e.g. `Berlin`) | - | No |
| `WEATHER_UNITS` | Unit system (`metric` or `imperial`) | `metric` | No |

**OpenWeatherMap (legacy, optional).** Existing setups using an OpenWeatherMap API key keep working — these variables are still read when the Open-Meteo coordinates above are not set:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OPENWEATHER_API_KEY` | API key from [openweathermap.org](https://openweathermap.org/api) | - | No |
| `OPENWEATHER_CITY` | City name for weather display | `Berlin` | No |
| `OPENWEATHER_UNITS` | Unit system (`metric` or `imperial`) | `metric` | No |
| `OPENWEATHER_LANG` | Language for weather descriptions | `de` | No |

### Google Calendar Sync (Optional)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID from Google Cloud Console | - | No |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client Secret | - | No |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL | `https://<YOUR-DOMAIN>/api/v1/calendar/google/callback` | No |

### Apple Calendar Sync — Legacy Single-Account (Optional)

> **Note:** Since v0.44.0, multi-account CalDAV (iCloud, Nextcloud, Radicale, Baikal) is managed through **Settings → Synchronization** in the UI. These env vars configure a single Apple CalDAV account at startup and remain supported for backwards compatibility.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `APPLE_CALDAV_URL` | CalDAV server URL | `https://caldav.icloud.com` | No |
| `APPLE_USERNAME` | Apple ID email | - | No |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (generate at [appleid.apple.com](https://appleid.apple.com/)) | - | No |

### Sync

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SYNC_INTERVAL_MINUTES` | Calendar sync interval in minutes | `15` | No |

### SSO / OpenID Connect (Optional)

Enable single sign-on via any OpenID Connect provider (Authentik, Keycloak, Google, Microsoft Entra, etc.).

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OIDC_ISSUER` | OIDC provider issuer URL (e.g. `https://authentik.example.com/application/o/oikos/`) | - | No |
| `OIDC_CLIENT_ID` | Client ID registered with your OIDC provider | - | No |
| `OIDC_CLIENT_SECRET` | Client secret for the registered application | - | No |
| `OIDC_REDIRECT_URI` | OAuth callback URL — must be registered with the provider (e.g. `https://oikos.example.com/api/v1/auth/oidc/callback`) | - | No |
| `OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM` | Set to `true` to allow account linking when the IdP omits the `email_verified` claim entirely. Only enable for IdPs fully under your control that never issue unverified addresses (e.g. older Authentik without an explicit `email_verified` property mapping). | - | No |

When all four OIDC variables are set, a **"Sign in with SSO"** button appears on the login page. The flow uses Authorization Code + PKCE (S256) with a nonce. On first login, the user is matched by their OIDC `sub`. If no match exists, an existing local account is linked automatically **only when the provider reports a verified email (`email_verified: true`) and exactly one local account holds that email address**; otherwise a new account is provisioned. Unverified or ambiguous emails never take over an existing account. If your provider omits the `email_verified` claim, set `OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM=true` to enable linking.

### Subscription Currency Conversion (Optional)

Budget → Subscriptions works fully without external services. Fixer can optionally provide live
exchange rates; this sends only currency codes to the configured provider.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `FIXER_API_KEY` | Fixer API key for live currency conversion. Rates are cached for 12 hours. | — | No |

Logo discovery fetches only public HTTPS sites, rejects private/link-local targets, does not execute
page scripts, and stores only a size-limited image. Service-name logo searches derive likely public
domains and inspect those sites directly; they do not scrape search-engine image results.

### Automated Backups (Optional)

Built-in cron-based database backup (default: 2 AM daily, keep last 7 copies). Status and manual trigger available in **Settings → Administration → Backup and restore**.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `BACKUP_ENABLED` | Enable scheduled backups (`true`/`false`) | `false` | No |
| `BACKUP_SCHEDULE` | Cron expression for backup schedule | `0 2 * * *` | No |
| `BACKUP_DIR` | Directory (inside container) where backup files are written | `/backups` | No |
| `BACKUP_KEEP` | Number of most-recent backup files to retain | `7` | No |

**WebDAV backup target (optional):** After each local backup, Yuvomi can automatically upload the file to any WebDAV-compatible server (Nextcloud, ownCloud, Hetzner Storage Box, Infomaniak kDrive, etc.). Configure in **Settings → Administration → Backup and restore → WebDAV Backup Target**, or via environment variables (env vars take precedence over the UI):

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `WEBDAV_BACKUP_ENABLED` | Enable WebDAV backup uploads (`true`/`false`) | — | No |
| `WEBDAV_BACKUP_URL` | WebDAV server URL (e.g. `https://cloud.example.com/remote.php/dav/files/user/`) | — | No |
| `WEBDAV_BACKUP_USERNAME` | WebDAV username | — | No |
| `WEBDAV_BACKUP_PASSWORD` | WebDAV password | — | No |
| `WEBDAV_BACKUP_PATH` | Remote directory path for backup files | `/oikos/backups/` | No |
| `WEBDAV_BACKUP_KEEP` | Number of remote backup files to keep | `7` | No |

---

## HTTPS / Reverse Proxy (Nginx)

> **Optional for local access, required for network/internet access.** If you only access Yuvomi on the same machine (localhost), you can skip this section.

When exposing Yuvomi to your local network or the internet, you need HTTPS for security. Nginx acts as a reverse proxy that handles SSL termination and forwards requests to the Docker container.

### Install Nginx

On Debian/Ubuntu:

```bash
sudo apt install nginx
```

### Configure Nginx

Yuvomi ships with an example configuration. Copy it to Nginx:

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/oikos
sudo ln -s /etc/nginx/sites-available/oikos /etc/nginx/sites-enabled/
```

Edit the file and replace `deine-domain.de` with your actual domain:

```bash
sudo nano /etc/nginx/sites-available/oikos
```

The configuration includes:
- HTTP-to-HTTPS redirect
- Proxy pass to the Docker container on port 3000
- WebSocket upgrade headers (for connection upgrades)
- Security headers (HSTS, X-Frame-Options, etc.)
- Static asset caching

### Enable HTTPS with Let's Encrypt

Install Certbot and obtain a free SSL certificate:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d <YOUR-DOMAIN>
```

Certbot automatically modifies the Nginx configuration to include your certificates.

Verify auto-renewal is active:

```bash
sudo certbot renew --dry-run
```

### Update Yuvomi for HTTPS

`docker-compose.yml` reads `SESSION_SECURE` from your `.env` (`${SESSION_SECURE:-false}`), so you no longer need to edit the Compose file. When running behind an HTTPS reverse proxy, set these in `.env`:

```bash
SESSION_SECURE=true
TRUST_PROXY=1
```

> The web installer's **Advanced** step and `install.sh` set both values for you when you choose a reverse-proxy deployment.

Then restart the container so the new values take effect:

```bash
docker compose up -d
```

---

## Podman & systemd Autostart (rootless)

On RHEL-based systems you can run Yuvomi as a rootless systemd service via Podman
[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html). Yuvomi
ships a ready-made unit at `tools/quadlet/oikos.container`.

```bash
# 1. Create the data folders and drop your generated .env in place
mkdir -p ~/.local/share/oikos/{data,backups,modules} ~/.config/oikos
cp /path/to/oikos/.env ~/.config/oikos/.env

# 2. Install the Quadlet unit
mkdir -p ~/.config/containers/systemd
cp tools/quadlet/oikos.container ~/.config/containers/systemd/

# 3. Generate and start the service
systemctl --user daemon-reload
systemctl --user start oikos

# 4. Keep it running across reboots (even without an active login session)
loginctl enable-linger "$USER"
```

The unit publishes port 3000, applies the SELinux `:Z` relabel to its volumes, runs the
same healthcheck as Compose, and restarts automatically. Edit the `PublishPort` /
`Volume` paths in the file to taste; for a system-wide (rootful) service, place the unit
in `/etc/containers/systemd/` and use `systemctl` without `--user`.

---

## Updates

### Option B — Pre-built Image

Pull the latest published image and restart:

```bash
docker compose pull
docker compose up -d
```

No rebuild needed. The database volume persists across updates.

### Option C — Build from Source

```bash
cd yuvomi
git pull
docker compose up -d --build
```

### When to Stop First

If the [CHANGELOG](../CHANGELOG.md) mentions database migrations or breaking changes, stop the container before updating:

```bash
# Option B (pre-built)
docker compose pull
docker compose down
docker compose up -d

# Option C (build from source)
docker compose down
git pull
docker compose up -d --build
```

> **Recommendation**: Read the CHANGELOG before every update. Back up your database beforehand (see next section).

---

## Backup & Restore

### Where is the Data?

The SQLite database lives in the host folder configured through `DATA_DIR` and is mounted at `/data` inside the container. The database file is `/data/oikos.db`.

Scheduled backups are written to the host folder configured through `BACKUP_DIR` and mounted at `/backups` inside the container.

> **WebDAV documents are outside the database.** A SQLite/database backup contains their metadata
> and storage keys, but not their binary files. If WebDAV document storage is enabled, back up the
> configured WebDAV target separately. A complete restore requires both matching backups.

### Backup

Use the built-in backup helper to create a consistent SQLite backup from the running container, then copy it to your host:

```bash
docker compose exec oikos node -e "import('./server/db.js').then(async db => { await db.backupToFile('/data/oikos-backup.db'); process.exit(0); })"
docker cp oikos:/data/oikos-backup.db ./oikos-backup-$(date +%Y%m%d).db
```

Admins can also download a backup from **Settings → Administration → Backup and restore**.

If you want to store the database and backups in specific local folders, set these in `.env` before starting Compose:

```bash
DATA_DIR=./data
BACKUP_DIR=./backups
```

### Restore

Admins can restore a backup from **Settings → Administration → Backup and restore**. For operational restores via Docker Compose, stop the running app, mount the backup into a temporary container that uses the same Docker volume, and replace the database file:

```bash
SERVICE=oikos
BACKUP="$PWD/oikos-backup-20260401.db"
docker compose stop "$SERVICE"
docker compose run --rm -v "$BACKUP:/tmp/oikos-restore.db:ro" --entrypoint sh "$SERVICE" -c 'set -eu; target="${DB_PATH:-/data/oikos.db}"; stamp=$(date -u +%Y%m%dT%H%M%SZ); if [ -f "$target" ]; then cp "$target" "$target.pre-restore-$stamp"; fi; rm -f "$target-wal" "$target-shm"; cp /tmp/oikos-restore.db "$target"; chown node:node "$target" 2>/dev/null || true'
docker compose up -d "$SERVICE"
```

If your Compose service is renamed, set `SERVICE` to that name, for example `SERVICE=familyplanner`.

For a local CLI restore outside Docker, set the same environment variables used by the app and run:

```bash
DB_PATH=/path/to/oikos.db node --import dotenv/config scripts/restore-backup.js ./oikos-backup-20260401.db
```

The restore helper validates that the file is an Yuvomi database before replacing the active database. It also keeps a pre-restore copy next to the database file for emergency rollback.

### Automated Backups

Add a cron job to back up daily (adjust the path to your preference):

```bash
crontab -e
```

Add this line:

```
0 3 * * * docker compose exec -T oikos node -e "import('./server/db.js').then(async db => { await db.backupToFile('/data/oikos-cron-backup.db'); process.exit(0); })" && docker cp oikos:/data/oikos-cron-backup.db /path/to/backups/oikos-$(date +\%Y\%m\%d).db
```

This creates a backup at 3:00 AM every day.

---

## Troubleshooting

<details>
<summary>Port already in use</summary>

If port 3000 is already occupied by another application:

```bash
lsof -i :3000
```

Either stop the conflicting process, or change the host port in your `.env` file — `docker-compose.yml` maps `OIKOS_HTTP_PORT` to the container's port 3000 automatically:

```bash
OIKOS_HTTP_PORT=8080
```

Then run `docker compose up -d` to apply it.

</details>

<details>
<summary>Permission denied (Docker)</summary>

If Docker commands fail with "permission denied":

```bash
sudo usermod -aG docker $USER
```

Log out and back in (or reboot) for the group change to take effect.

</details>

<details>
<summary>Permission denied on volumes (Podman / SELinux)</summary>

If the container logs show `EACCES` / permission errors writing to `/data` or `/backups`
on an SELinux system, you started it without the `:Z` relabel. Use `podman-compose.yml`
(which carries `:Z` on every bind mount) instead of `docker-compose.yml`:

```bash
podman compose -f podman-compose.yml up -d
```

To relabel existing host folders manually:

```bash
chcon -Rt container_file_t ./data ./backups ./modules
```

</details>

<details>
<summary>Container starts but page is not reachable</summary>

1. Check the container status:
   ```bash
   docker compose ps
   ```
   The state should show "Up" and "healthy".

2. Check the logs for errors:
   ```bash
   docker compose logs
   ```

3. Verify the port mapping:
   ```bash
   docker port oikos
   ```

4. Check your firewall rules if accessing from another device.

</details>

<details>
<summary>Database encryption error</summary>

If the logs show SQLCipher errors, the `DB_ENCRYPTION_KEY` in your `.env` file is either missing or does not match the key used when the database was created.

If this is a fresh install, delete the volume and start over:

```bash
docker compose down -v
docker compose up -d --build
```

If you have existing data, you need the original encryption key. There is no way to recover data without it.

</details>

<details>
<summary>SQLCipher build fails during Docker build</summary>

> **Tip**: If you hit build issues, switch to the pre-built image (Option B above) — it ships with SQLCipher already compiled and requires no local build step.

The Dockerfile installs these build dependencies: `python3`, `make`, `g++`, `libsqlcipher-dev`. If the build fails, ensure your Docker installation is up to date and has internet access to pull packages.

On resource-constrained systems, the native compilation may run out of memory. Ensure at least 1 GB of RAM is available during the build.

</details>

<details>
<summary>Nginx 502 Bad Gateway</summary>

This means Nginx cannot reach the Docker container. Check:

1. Is the container running?
   ```bash
   docker compose ps
   ```

2. Is the `proxy_pass` port in your Nginx config correct? It should match the host port in `docker-compose.yml` (default: `3000`).

3. Is the container listening on the expected port?
   ```bash
   docker compose logs | grep "Server läuft"
   ```

</details>

---

## Uninstall

Remove the container, volumes, and all data:

```bash
docker compose down -v
```

Remove the repository:

```bash
cd .. && rm -rf yuvomi
```

> **Warning**: `docker compose down -v` permanently deletes all data including the database. Create a backup first if needed.
