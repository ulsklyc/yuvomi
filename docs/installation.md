## Quick Install

Three ways to get Oikos running from scratch:

### Option A — Web Installer (recommended, all platforms)

```bash
git clone https://github.com/ulsklyc/oikos.git && cd oikos
node tools/installer/install-server.js
# Open http://localhost:8090
```

Requires Node.js 18+ on the host. The browser-based wizard is fully localized (18 languages, auto-detected from your browser), detects your container engine (Docker or Podman) first, then configures your `.env` — including optional reverse-proxy/HTTPS, Single Sign-On (OIDC), and automatic backups — starts the container, and creates your admin account. The engine still runs the app itself.

### Option B — CLI Installer (Linux / macOS)

```bash
git clone https://github.com/ulsklyc/oikos.git && cd oikos
bash install.sh
```

The script checks prerequisites, generates security keys, configures optional integrations, starts the container (Docker or Podman — auto-detected), and creates your admin account. Like the web installer, it is fully localized in 18 languages and auto-detects yours from the shell environment (`LANG`/`LC_ALL`).

Force a specific language with `--lang` (one of `de en es fr it sv el ru tr zh ja ar hi pt uk pl nl`):

```bash
bash install.sh --lang de
```

Non-interactive mode (CI/provisioning — provide your own `.env`):

```bash
bash install.sh --env-file /path/to/.env
```

### Option C — Manual (Docker or Podman, no clone required)

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/.env.example
cp .env.example .env  # set SESSION_SECRET and DB_ENCRYPTION_KEY
docker compose up -d
```

**Podman (RHEL / Fedora / CentOS Stream):** grab `podman-compose.yml` instead — it
adds the SELinux `:Z` relabel so the rootless container can write to its volumes:

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/podman-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/.env.example
cp .env.example .env  # set SESSION_SECRET and DB_ENCRYPTION_KEY
podman compose -f podman-compose.yml up -d   # or: podman-compose -f podman-compose.yml up -d
```

Then open the WebUI — the first visit guides you through creating your admin account in
the browser. Headless deployments can instead create it from the container console with
`docker compose exec oikos node setup.js` (or the matching `podman compose … exec`).

---

# Installation Guide

Complete setup instructions for Oikos - from Docker installation to your first login.

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

Oikos is a self-hosted family planner that runs as a single Docker container. The Express.js backend serves both the API and the static frontend files. All data is stored in a SQLCipher-encrypted SQLite database inside a host-mounted data folder, and automated backups are written to a separate host-mounted backup folder.

```
Browser ──HTTP──▶ Docker Container (Express.js :3000) ──▶ SQLite/SQLCipher (/data/oikos.db)

With HTTPS (recommended for network access):
Browser ──HTTPS──▶ Nginx (Reverse Proxy) ──HTTP──▶ Docker Container (Express.js :3000) ──▶ SQLite/SQLCipher
```

For local-only access, the Docker container is all you need. If you want to access Oikos from other devices on your network or the internet, add Nginx as a reverse proxy with SSL.

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
Docker. Oikos supports Podman out of the box: both installers auto-detect it, and a
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

There are four ways to get Oikos running. **Option A** (web installer) is recommended for most users — it walks you through every step in your browser. **Option B** (pre-built image) is a quick manual alternative. **Option C** (build from source) is for contributors or custom builds. **Option D** (TrueNAS SCALE) installs directly from the Community Apps Catalog with no terminal required.

---

### Option A — Web Installer (Recommended)

Requires Node.js 18+ and Docker on the host.

#### 1. Clone the Repository

```bash
git clone https://github.com/ulsklyc/oikos.git
cd oikos
```

#### 2. Start the Installer

```bash
node tools/installer/install-server.js
```

#### 3. Open the Wizard

Open your browser and navigate to **http://localhost:8090**. The wizard detects your browser language (18 languages supported), verifies that a container engine is available (Docker with Compose v2, or Podman with `podman compose` / `podman-compose`), and reports any existing `.env` file or running container before you start. It then guides you through:

- Basics — timezone (`TZ`) and HTTP host port (`OIKOS_HTTP_PORT`)
- Security key generation (`SESSION_SECRET`, `DB_ENCRYPTION_KEY`)
- Optional integrations (weather, Google Calendar, Apple CalDAV)
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
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/.env.example
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

Docker pulls `ghcr.io/ulsklyc/oikos:latest` automatically. No build step, no Node.js installation needed.

Continue with [Step 4 — Verify](#4-verify-the-container-is-running).

---

### Option C — Build from Source

#### 1. Clone the Repository

```bash
git clone https://github.com/ulsklyc/oikos.git
cd oikos
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
oikos  | [Oikos] Server läuft auf Port 3000
oikos  | [Oikos] Umgebung: production
oikos  | [Sync] Auto-Sync alle 15 Minuten aktiv.
```

Press `Ctrl+C` to stop following the logs (the container keeps running).

### 5. Create the First Admin Account

On the first visit, Oikos detects that no account exists yet and guides you through
creating your admin account directly in the browser (see step 6). The form asks for:
- **Username** (3–64 characters; letters, numbers, dots, hyphens, underscores)
- **Display name** (e.g. "Jane Doe")
- **Password** (minimum 8 characters, with a confirmation field)

After you submit, Oikos creates the admin, signs you in automatically, and the setup
form is no longer reachable.

**Headless alternative (CLI):** if you prefer not to use the browser — or are scripting
a provisioning step — create the admin from the container console instead:

```bash
docker compose exec oikos node setup.js
```

### 6. Open Oikos

Open your browser and navigate to:

```
http://localhost:3000
```

Log in with the admin credentials you just created. You can add family members from the **Settings** page.

---

### Option D — TrueNAS SCALE (Community Apps Catalog)

No terminal required. Oikos is available directly in the TrueNAS SCALE Community Apps Catalog.

#### 1. Open the Apps Catalog

In your TrueNAS SCALE web UI, go to **Apps → Discover Apps** and search for **Oikos**.

#### 2. Configure and Install

Click **Install**. Fill in the configuration form:

- **Session Secret** (required) — use a long random string
- **Database Encryption Key** (recommended) — generate with `openssl rand -hex 32`; back it up, it cannot be recovered or changed on an existing database
- Adjust port and storage paths as needed

Click **Install** to start the container.

#### 3. Open the WebUI

Once the app status shows **Running**, click **WebUI** in the Apps overview. The first visit guides you through creating your admin account in the browser.

---

## Environment Variables

All configuration happens in the `.env` file. The container reads these values on startup.

### Server

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Port the Express server listens on **inside the container** (rarely changed) | `3000` | No |
| `OIKOS_HTTP_PORT` | Host port that the compose file maps to the container's port 3000. Change this to expose Oikos on a different host port; the app inside the container always listens on 3000. | `3000` | No |
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

### Weather (Optional)

The weather widget defaults to **Open-Meteo** — free, ECMWF-backed, and requiring **no API key**. Just set your coordinates (find them on [openstreetmap.org](https://www.openstreetmap.org) or Google Maps). You can also configure this in-app under **Settings → Weather** (admin only), which takes precedence over the environment variables.

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

When all four variables are set, a **"Sign in with SSO"** button appears on the login page. The flow uses Authorization Code + PKCE (S256) with a nonce. A matching Oikos user account (same `oidc_sub`) must already exist — automatic provisioning is not supported.

### Automated Backups (Optional)

Built-in cron-based database backup (default: 2 AM daily, keep last 7 copies). Status and manual trigger available in **Settings → Backup Management**.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `BACKUP_ENABLED` | Enable scheduled backups (`true`/`false`) | `false` | No |
| `BACKUP_SCHEDULE` | Cron expression for backup schedule | `0 2 * * *` | No |
| `BACKUP_DIR` | Directory (inside container) where backup files are written | `/backups` | No |
| `BACKUP_KEEP` | Number of most-recent backup files to retain | `7` | No |

---

## HTTPS / Reverse Proxy (Nginx)

> **Optional for local access, required for network/internet access.** If you only access Oikos on the same machine (localhost), you can skip this section.

When exposing Oikos to your local network or the internet, you need HTTPS for security. Nginx acts as a reverse proxy that handles SSL termination and forwards requests to the Docker container.

### Install Nginx

On Debian/Ubuntu:

```bash
sudo apt install nginx
```

### Configure Nginx

Oikos ships with an example configuration. Copy it to Nginx:

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

### Update Oikos for HTTPS

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

On RHEL-based systems you can run Oikos as a rootless systemd service via Podman
[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html). Oikos
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
cd oikos
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

### Backup

Use the built-in backup helper to create a consistent SQLite backup from the running container, then copy it to your host:

```bash
docker compose exec oikos node -e "import('./server/db.js').then(async db => { await db.backupToFile('/data/oikos-backup.db'); process.exit(0); })"
docker cp oikos:/data/oikos-backup.db ./oikos-backup-$(date +%Y%m%d).db
```

Admins can also download a backup from **Settings → Backup Management**.

If you want to store the database and backups in specific local folders, set these in `.env` before starting Compose:

```bash
DATA_DIR=./data
BACKUP_DIR=./backups
```

### Restore

Admins can restore a backup from **Settings → Backup Management**. For operational restores via Docker Compose, stop the running app, mount the backup into a temporary container that uses the same Docker volume, and replace the database file:

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

The restore helper validates that the file is an Oikos database before replacing the active database. It also keeps a pre-restore copy next to the database file for emergency rollback.

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
cd .. && rm -rf oikos
```

> **Warning**: `docker compose down -v` permanently deletes all data including the database. Create a backup first if needed.
