## Quick Install

Three ways to get Yuvomi running from scratch:

### Option A — Web Installer (recommended, all platforms)

```bash
git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
node tools/installer/install-server.js
# Open http://localhost:8090
```

Requires Node.js 18+ on the host. The browser-based wizard is fully localized (24 languages, auto-detected from your browser), detects your container engine (Docker or Podman) first, then configures your `.env` — including optional reverse-proxy/HTTPS, Single Sign-On (OIDC), and automatic backups — starts the container, and creates your admin account. The engine still runs the app itself.

### Option B — CLI Installer (Linux / macOS)

```bash
git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
bash install.sh
```

The script checks prerequisites, generates security keys, asks for the base URL your household will use, configures optional integrations (weather via Open-Meteo coordinates, calendars, document storage), starts the container (Docker or Podman — auto-detected), and creates your admin account. Like the web installer, it is fully localized in 24 languages and auto-detects yours from the shell environment (`LANG`/`LC_ALL`).

Running it again on an existing installation is safe, in two ways:

- **Security keys are never regenerated.** `SESSION_SECRET` and `DB_ENCRYPTION_KEY` already present in your `.env` are kept, so the database stays readable. Remove a key from `.env` if you deliberately want a new one.
- **Settings the script does not ask about are carried over.** Anything you added by hand or through the web installer — `EMAIL_SMTP_*`, `OIDC_*`, `WEBDAV_BACKUP_*`, `VAPID_SUBJECT`, `LOG_LEVEL` and the rest — is copied from the previous `.env` into the new one, and the script reports how many entries it kept. Only the values the dialog itself asks about are replaced by your answers. The previous file is still backed up to `.env.bak-<timestamp>` first.

> **Base URL.** The script asks for the absolute origin your household will open (default `http://<host>:<port>`) and writes it as `BASE_URL`. Behind a reverse proxy, enter the public address there — for example `https://yuvomi.example.com`. Without it the server sends no password-reset or invitation emails at all, because it deliberately does not trust the request's `Host` header.

Force a specific language with `--lang` (one of `de en es fr it sv el ru tr zh ja ar hi pt uk pl nl cs vi hu ko id fa fil`):

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
`docker compose exec yuvomi node setup.js` (or the matching `podman compose … exec`).

---

# Installation Guide

Complete setup instructions for Yuvomi - from Docker installation to your first login.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Step-by-Step Installation](#step-by-step-installation)
- [Environment Variables](#environment-variables)
- [HTTPS / Reverse Proxy (Nginx)](#https--reverse-proxy-nginx)
- [Podman & systemd Autostart (rootless)](#podman--systemd-autostart-rootless)
- [Updates](#updates)
- [Backup & Restore](#backup--restore)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

---

## Architecture Overview

Yuvomi is a self-hosted family planner that runs as a single Docker container. The Express.js backend serves both the API and the static frontend files. Application data is stored in a SQLCipher-encrypted SQLite database inside a host-mounted data folder, and automated database backups are written to a separate host-mounted backup folder. Optionally, newly uploaded document files can be stored on a mounted host folder or on a WebDAV server instead of inside SQLite.

```
Browser ──HTTP──▶ Docker Container (Express.js :3000) ──▶ SQLite/SQLCipher (/data/yuvomi.db)

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
- **CPU**: `amd64` and `arm64` images are published (x86 servers, Raspberry Pi 4/5, Apple Silicon, most NAS devices)

---

## Step-by-Step Installation

There are seven ways to get Yuvomi running. **Option A** (web installer) is recommended for most users — it walks you through every step in your browser. **Option B** (pre-built image) is a quick manual alternative. **Option C** (build from source) is for contributors or custom builds. **Options D–F** install directly from a NAS/home-server app store with no terminal required: **Option D** (TrueNAS SCALE), **Option E** (Umbrel), and **Option F** (Unraid). **Option G** covers Portainer, whether you paste the stack or let it follow this repository via Git.

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

Open your browser and navigate to **http://localhost:8090**. The wizard detects your browser language (24 languages supported), verifies that a container engine is available (Docker with Compose v2, or Podman with `podman compose` / `podman-compose`), and reports an existing `.env` file as well as a running container before you start. When it finds one, the **simple setup is disabled** and you continue with the advanced setup: the simple path writes fixed values for host, port, `SESSION_SECURE` and `TRUST_PROXY`, which would silently downgrade an installation that already runs behind a reverse proxy. The wizard then guides you through:

- Basics — domain/IP, HTTP host port (`OIKOS_HTTP_PORT`), timezone (`TZ`, which pre-sets the household zone; that one is changeable later under Settings → Personal → Appearance → Region), how Yuvomi is exposed (`SESSION_SECURE`, `TRUST_PROXY`) and the public address (`BASE_URL`). The exposure choice follows the host you enter, and the wizard rejects an `http://` address combined with enforced secure cookies — nobody could sign in to that combination. A typed public address only counts once it names a full `http://` or `https://` origin; until then the wizard keeps the address it derives from host and port
- Security key generation (`SESSION_SECRET`, `DB_ENCRYPTION_KEY`) — on a re-run, keys already present in your `.env` are kept rather than regenerated, so running the wizard again on a live installation cannot lock you out of your encrypted database
- Optional integrations (weather, Google Calendar, Apple CalDAV)
- Email/SMTP for the "forgot password" flow (`EMAIL_SMTP_*`, `EMAIL_FROM_*`)
- Storage & backups — the host data folder (`DATA_DIR`), automatic backups, off-site WebDAV backups and the three document storage options. Everything that decides where data lives
- Advanced settings — Single Sign-On (OIDC), the three home-network permissions (they lift the SSRF protection and are asked as one group), the calendar sync interval, live currency rates and the Web-Push contact. Everything that decides what Yuvomi connects to
- Writing your `.env` file (an existing `.env` is backed up to `.env.bak-<timestamp>` first)
- Starting the container (via Docker or Podman, whichever was detected)
- Creating your admin account

The final screen lets you **download a copy of your `.env`** — keep it safe, as it holds the encryption keys that cannot be recovered if lost. The file is fetched from the server rather than rebuilt in the browser, so it contains the real values, including keys carried over from an earlier run that the browser itself never receives. If the download fails (most likely because the installer has already shut down), the screen says so instead of reporting success, and points you at the `.env` on disk.

Download the file before you close the tab: the installer server shuts down **5 minutes after your admin account is created**, and after 30 minutes of inactivity otherwise.

The final screen also links to the next three steps on your new instance: inviting your family, choosing which modules to enable, and installing Yuvomi on your phones. Running the wizard again on an installation that already has an admin account is a supported case — it writes your `.env`, restarts the container and takes you to that same screen instead of failing.

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
openssl rand -hex 32
```

That prints **two** values: paste one as `SESSION_SECRET` and the other as `DB_ENCRYPTION_KEY`. See [Environment Variables](#environment-variables) for all options.

#### 3. Start the Container

```bash
docker compose up -d
```

Docker pulls `ghcr.io/ulsklyc/yuvomi:latest` automatically. No build step, no Node.js installation needed.

> **Pinning a version.** Every release is also published under immutable tags:
> `2.65.3` (exact version), `2.65` (latest patch of that minor), plus a moving `main`
> tag for the current development state. To pin production to a known-good release,
> set `image: ghcr.io/ulsklyc/yuvomi:2.65.3` in your compose file and bump it
> deliberately; `latest` always points at the newest release.

> **Verifying what you pull.** Every image the publish workflow builds is signed at build
> time with [cosign](https://github.com/sigstore/cosign), keyless, under the identity of
> that workflow, and carries a build provenance attestation and an SBOM. To check that the
> image you are about to run is one GitHub built from a release tag of this repository:
>
> ```bash
> cosign verify ghcr.io/ulsklyc/yuvomi:2.65.3 \
>   --certificate-oidc-issuer https://token.actions.githubusercontent.com \
>   --certificate-identity-regexp '^https://github.com/ulsklyc/yuvomi/.github/workflows/docker-publish.yml@refs/tags/v'
> ```
>
> A passing check prints the certificate's claims, including the tag it was built from;
> anything else means the image is not one this repository released. The `main` tag is
> signed too, under `refs/heads/main`, which the pattern above deliberately excludes. Tags
> published before September 2026 carry no signature. Provenance and SBOM travel inside the
> image: `docker buildx imagetools inspect ghcr.io/ulsklyc/yuvomi:2.65.3 --format '{{ json .Provenance }}'`.

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

- `--build` builds the Docker image locally (npm packages, including the native database module).
- `-d` runs the container in the background.

The first build takes a few minutes. Subsequent starts are much faster.

### 4. Verify the Container is Running <a name="4-verify-the-container-is-running"></a>

Check the logs to confirm a successful start:

```bash
docker compose logs -f
```

You should see output like:

```
yuvomi  | [Yuvomi] Server running on port 3000 | Version 2.65.3
yuvomi  | [Yuvomi] Environment: production
yuvomi  | [Sync] Auto-sync active every 15 minutes.
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
docker compose exec yuvomi node setup.js
```

### 6. Open Yuvomi

Open your browser and navigate to:

```
http://localhost:3000
```

Log in with the admin credentials you just created. You can add family members from the **Settings** page: either invite them with a link so they choose their own password, or create the account directly and hand over the credentials yourself.

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
- **DB_ENCRYPTION_KEY** (recommended) — generate with `openssl rand -hex 32`; back it up, it cannot be recovered or changed on an existing database. If you are upgrading an installation whose database is still unencrypted, it is encrypted once on the next start and the untouched original is kept as `<DB_PATH>.plaintext-backup`; delete that copy once you have verified the app starts and your data is complete
- Adjust the WebUI port and the appdata path if needed

#### 3. Apply and Open

Click **Apply**. Once the container is running, click the Yuvomi icon → **WebUI**. The first visit guides you through creating your admin account in the browser.

---

### Option G — Portainer (Stack or Git/GitOps)

Portainer never places a `.env` file next to the compose file. Whatever you type under **Environment variables** is handed to Compose for `${...}` substitution instead, so the manifest has to list every variable it wants to reach the container. That is exactly what [`docker-compose.portainer.yml`](docker-compose.portainer.yml) does — use it rather than the repository's `docker-compose.yml`.

#### Web editor stack

**Stacks → Add stack → Web editor**, paste the contents of [`docker-compose.portainer.yml`](docker-compose.portainer.yml), then add at least these two under **Environment variables**:

- `SESSION_SECRET` — a long random string (`openssl rand -hex 32`)
- `DB_ENCRYPTION_KEY` — same generator; back it up, it cannot be recovered or changed on an existing database

Every other variable is optional and falls back to the default shown in the file. `BASE_URL` is strongly recommended — without it, password reset and invitation mails are never sent.

#### Git / GitOps stack

**Stacks → Add stack → Repository**, repository `https://github.com/ulsklyc/yuvomi`, branch `main`, and set the **Compose path** to:

```
docs/docker-compose.portainer.yml
```

Add the same environment variables as above. Auto-update then follows `main` on its own.

> **Do not point a Git stack at the repository's `docker-compose.yml`.** That file is written for a local clone with a generated `.env` beside it, so it passes most of its configuration through `env_file` — and Portainer clones the repository without one. The deploy then fails on the missing file, and even if it did not, the container would start without `SESSION_SECRET` and exit (issues #698, #765).

---

## Environment Variables

All configuration happens in the `.env` file. The container reads these values on startup.

> **Self-hosting under the GDPR?** Several optional integrations below (weather, Google/OIDC SSO, the Outlook push via Microsoft Graph, WebDAV backup, WebDAV document storage) can send data to third parties, some outside the EU/EEA. See [Privacy for self-hosters](PRIVACY-FOR-SELFHOSTERS.md) for per-service third-country assessments, data-processing-agreement notes and log-retention guidance before enabling them. The Outlook push deserves a look before you switch it on: event titles, notes and locations leave the server as free text, assigned members' names travel in the title, and a personal Microsoft account cannot be covered by a data-processing agreement (see section 2.16 there).

### Server

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Port the Express server listens on **inside the container** (rarely changed) | `3000` | No |
| `OIKOS_HTTP_PORT` | Host port that the compose file maps to the container's port 3000. Change this to expose Yuvomi on a different host port; the app inside the container always listens on 3000. | `3000` | No |
| `OIKOS_HTTP_BIND` | Host bind address for the published port (`podman-compose.yml` only). Set to `127.0.0.1` for rootless Podman behind a reverse proxy on the same host. | `0.0.0.0` | No |
| `TZ` | Container timezone (e.g. `Europe/Berlin`). Affects log timestamps and the automated-backup schedule, and is the **default** for the household zone. Since v2.34.0 the household zone is a setting of its own (Settings → Personal → Appearance → Region), and where both exist the setting wins: `TZ` lives in the compose file, which is out of reach on Umbrel, TrueNAS and Unraid, and it also drives things that have nothing to do with the family calendar. Whichever applies is the zone used wherever a time carries none of its own: the calendar day server-side jobs call "today" (upcoming events, countdowns, recurring split expenses, birthdays), events pushed to Google Calendar when the target calendar reports no zone, events pushed to Outlook, events pushed to a CalDAV server (#938 - before that they carried no zone at all, leaving every server free to read them on its own clock), the due times of CalDAV reminders synced into Tasks, and the times in the exported calendar feed (`/feed/calendar/<token>.ics`), which subscribers read in this zone - a wrong zone shifts every appointment for everyone subscribed. **Since v2.36.0 the app's own display follows it too**, so a device travelling in another zone shows the household's clock rather than its own; that half applies only when the setting is set, since `TZ` alone leaves the display on the browser as before. | `UTC` | No |
| `NODE_ENV` | Runtime environment | `production` | No |
| `LOG_LEVEL` | Lowest severity written to the container log (`debug`, `info`, `warn`, `error`). Set to `debug` to see the per-run detail of the calendar, contact and holiday sync, which stays quiet at `info` when a run has nothing to do. | `info` | No |
| `TRUST_PROXY` | Number of reverse-proxy hops to trust, or a subnet string (e.g. `1`, `172.16.0.0/12`, `loopback`). The default already trusts a single hop, so `req.ip` returns the real client IP behind one Caddy/Nginx/Traefik proxy without any configuration. Set to `loopback` for direct, proxy-less deployments, or to a subnet/higher hop count behind multiple proxy layers. Numeric values are treated as a hop count; named values (`loopback`, `linklocal`, `uniquelocal`) work as expected. | `1` | No |

### Security

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SESSION_SECRET` | Secret key for signing session cookies. The placeholder that `.env.example` ships (`REPLACE_WITH_...`) is refused at startup: it is printed in this repository, so anyone who can reach your instance could forge a session cookie and sign in as any user. Generate one with `openssl rand -base64 48`. Changing it later only signs everyone out once. | - | **Yes** |
| `SESSION_SECURE` | Set to `true` when running behind an HTTPS reverse proxy (Caddy, Nginx, Traefik). Leave unset for direct HTTP access (e.g. TrueNAS, bare Docker). | `false` | No |
| `RATE_LIMIT_WINDOW_MS` | Time window for rate limiting (ms) | `60000` | No |
| `RATE_LIMIT_MAX_ATTEMPTS` | Max attempts per window on the credential routes: sign-in, the second factor, and password reset | `5` | No |
| `ENABLE_API_DOCS` | API documentation (`/docs`, `/openapi.json`) is admin-only and hidden entirely in production. Set to `true` to expose it to signed-in admins in production too. | `false` (hidden) | No |
| `MCP_INTERNAL_BASE_URL` | Base URL the built-in MCP endpoint (`/mcp`) uses when its `call_api_operation` bridge calls the REST API back over loopback. Only needed for non-standard bind addresses. | `BASE_URL` or `http://127.0.0.1:<PORT>` | No |

Generate a secure `SESSION_SECRET`:

```bash
openssl rand -hex 32
```

### Web Push (Optional)

Push notifications deliver due reminders to a device as system notifications even when the app
is closed. **Requires HTTPS** (the Push API and service workers only work over a secure origin —
see [HTTPS / Reverse Proxy](#https--reverse-proxy-nginx)). Each device opts in under
Settings → Personal → Notifications.

Admins can also add household Gotify, ntfy, generic HTTP webhook or email channels on the same
settings page. These channels are configured in the UI and do not require environment variables. The
Yuvomi backend container or host must be able to reach the configured base URL. HTTPS is recommended;
HTTP is accepted for trusted internal networks such as a private LAN or container network.

An **email** channel is the exception: it has no base URL and no credentials of its own. It reuses
the app-wide SMTP access that already sends password resets and invitations, so configure
Settings → Email (or `EMAIL_SMTP_*`) first - the provider list marks email as not ready until you
have. Each channel holds one recipient address; add a second channel for a second recipient. Set
`BASE_URL` if you want the reminder mails to carry a link back into the app.

A webhook channel posts JSON to any endpoint, with an optional write-only Bearer token. If the
receiver expects a body of its own shape - Discord and Slack do - a payload template produces it
without needing a service-specific adapter; see the
[notification webhook guide](notification-webhooks.md).

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `VAPID_PUBLIC_KEY` | VAPID public key. Auto-generated on first use and stored in the database if unset. | auto | No |
| `VAPID_PRIVATE_KEY` | VAPID private key. Set together with the public key to pin a fixed pair across redeployments. | auto | No |
| `VAPID_SUBJECT` | Contact URI (`mailto:` address or `https:` origin) sent to push services. Must be routable — Apple rejects a `localhost`, `.local` or otherwise unreachable subject with `403 BadJwtToken`, which disables push on iOS while Android keeps working. Falls back to the sender address from Settings → Administration → Email, then to `BASE_URL`, then to a placeholder. | derived, see description | No |

Generate a fixed key pair (optional):

```bash
npx web-push generate-vapid-keys
```

#### iOS and iPadOS

Apple applies extra restrictions that do not exist on Android or desktop browsers:

- **iOS/iPadOS 16.4 or newer** is required.
- **The app must be installed to the Home Screen.** iOS delivers Web Push only to installed
  home-screen web apps, never to a Safari tab. Open Yuvomi in Safari, then Share ->
  "Add to Home Screen".
- **Enable the toggle from inside the home-screen app.** The push subscription belongs to that
  installation, so a toggle enabled in a Safari tab does not carry over.
- **The certificate must be one iOS trusts.** A self-signed certificate or a private CA without an
  installed profile stops the service worker from registering, which silently disables push. A
  plain `http://` LAN address does not work either.
- **Check iOS Settings -> Notifications -> Yuvomi**: "Allow Notifications" must be on, and a Focus
  mode must not be filtering the app.
- **The server needs outbound access to `web.push.apple.com`.** In LAN-only or egress-filtered
  deployments the send fails server-side.
- **The VAPID subject must be routable.** Apple validates the contact URI in the signed token and
  answers `403 BadJwtToken` when it cannot be reached, so push fails on iOS while Android continues
  to work. Yuvomi derives a usable value from the SMTP sender address or `BASE_URL`; set
  [`VAPID_SUBJECT`](#web-push-optional) explicitly if neither is configured.

If a test notification does not arrive, the server log is the authoritative source. Successful
sends are silent; failures are logged as `[Push] Push send failed (host=... status=... body=...)`,
where `host` identifies the push service (`web.push.apple.com` for iOS) and `status`/`body` carry
that service's rejection reason. A rejected token additionally logs `sub=...` plus a line naming
the subject as the likely cause.

A subscription the server no longer knows about (removed after the push service reported it gone,
or lost in a database restore) repairs itself: the app re-registers an existing subscription on
every start, and the test button re-registers and retries once before reporting a failure.

### Email / SMTP (Optional)

Configuring an outgoing SMTP server enables three things: the self-service **"Forgot password"**
flow on the login page (without it, only an admin can reset another user's password), **email as a
household notification channel** next to Gotify, ntfy and webhooks, and **sending a shopping list**
to whichever household member is doing the run. All three share one SMTP configuration - there is
no second set of credentials per channel. Set `BASE_URL` as well if you want reminder mails to
carry a link back into the app; without it they arrive without one rather than with a dead one.
Can also be configured in Settings → Administration → Email. Precedence is per field, like WebDAV document storage
below: every non-empty environment value overrides only its corresponding database value and
makes exactly that field read-only in the settings UI; empty values fall back to the database.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `EMAIL_SMTP_HOST` | SMTP server hostname. | - | No |
| `EMAIL_SMTP_PORT` | SMTP server port. | `587` | No |
| `EMAIL_SMTP_SECURE` | Connection security: `ssl`, `starttls`, or `none`. | `starttls` | No |
| `EMAIL_SMTP_USER` | SMTP auth username. | - | No |
| `EMAIL_SMTP_PASS` | SMTP auth password. | - | No |
| `EMAIL_FROM_ADDRESS` | Sender email address. | - | No |
| `EMAIL_FROM_NAME` | Sender display name. | `Yuvomi` | No |
| `BASE_URL` | Absolute origin used to build password-reset links, invitation links in emails, and calendar export-feed URLs, e.g. `https://yuvomi.example.com`. **Required for password-reset and invitation emails to be sent** — the request `Host` header is never trusted as a fallback, to prevent reset-link poisoning. The invite link shown in the admin UI works without it (it is built from the browser's origin); the export feed falls back to the request's protocol/host when unset. | - | No* |

\* Not required to start Yuvomi. Without it (or without SMTP configured) the self-service reset
cannot deliver a mail, so the login page hides the "Forgot password" link entirely rather than
offering a dead end — an admin can still reset a member's password directly under
Settings → Administration → Family.

The "Test connection" button in Settings → Administration → Email verifies the SMTP connection and
sends a probe email to the signed-in admin's own linked address. The SMTP password is never
returned by the API once saved; it is stored in the database the same way as other integration
credentials (e.g. the Apple app-specific password), with encryption-at-rest available via the
optional `DB_ENCRYPTION_KEY`.

### Immich Photo Screensaver (Optional)

Connect a self-hosted Immich server under **Settings → Administration → Immich** to show random
photos after five minutes without activity. The administration page can test the connection and
open an immediate preview. An optional album UUID limits the selection; otherwise Yuvomi uses the
whole accessible library. The Immich API key needs `asset.read` and `asset.view` permissions.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `IMMICH_URL` | Immich server root or URL ending in `/api` | — | No |
| `IMMICH_API_KEY` | Immich API key with asset read/view permissions | — | No |
| `IMMICH_SCREENSAVER_ALBUM_ID` | Optional album UUID used as the photo source | Entire accessible library | No |

Non-empty environment values override their corresponding database values and make those fields
read-only in Settings. The API key is never returned to the browser. Keys saved in Settings are
encrypted at rest when `DB_ENCRYPTION_KEY` is enabled. See the dedicated
[Immich screensaver guide](immich-screensaver.md) for setup, Docker networking, preview behavior,
security, and troubleshooting.

### Database & Storage

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DB_PATH` | Path to the SQLite database file inside the container | `/data/yuvomi.db` | No |
| `DB_ENCRYPTION_KEY` | SQLCipher AES-256 key for encryption at rest. Leave it empty and the database stays unencrypted. Once set there is no way back: it cannot be recovered and cannot be changed on an existing database. The placeholder that `.env.example` ships (`REPLACE_WITH_...`) is refused on a fresh install, because it is printed in this repository and would protect nothing. | - | No, but strongly recommended |
| `DB_ALLOW_NEWER_SCHEMA` | Emergency switch, normally unset. An older Yuvomi refuses to start on a database a newer version has opened (see [Going back](#going-back)); `1` starts it anyway, at your own risk, with a warning on every start. | - | No |
| `DATA_DIR` | Host directory mounted at `/data` inside the container (set in `.env` or `docker-compose.yml`). | `./data` | No |
| `MODULES_DIR` | Host directory mounted at `/app/modules` inside the container - the drop-in folder for [third-party modules](../MODULES.md). | `./modules` | No |

> **Where the backups go.** There is no `BACKUP_DIR` in the setup wizard, and that is deliberate.
> Unlike `DATA_DIR`, which exists only as a Compose substitution for the mount source, `BACKUP_DIR`
> and `MODULES_DIR` are also read by the application itself - and there they mean the directory
> *inside* the container. A host path such as `./backups` in your `.env` therefore resolves to
> `/app/backups` in the container, outside the mounted volume and not writable, which is why every
> deployment descriptor pins it to `/backups`. To keep the backups on a NAS array, change the
> **mount source**, not the variable:
>
> ```yaml
> volumes:
>   - /mnt/user/appdata/yuvomi/data:/data
>   - /mnt/array/yuvomi-backups:/backups   # host side is yours to choose
> ```
>
> The same applies to the module drop-in folder at `/app/modules`.
| `BACKUP_DIR` | In `.env`/`docker-compose.yml`: the **host** directory mounted at `/backups`. Inside the container the app reads the same name as the **container** path it writes to — the compose files pin it to `/backups`, and the image defaults to `/backups` as well. Only override it inside the container if you mount your backup volume somewhere else. | `./backups` (host) / `/backups` (container) | No |

Generate a secure `DB_ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

> **Warning**: If you lose this key, you cannot access your database. Keep a backup of your `.env` file in a safe place.

> **The placeholder is not a key.** `.env.example` ships
> `DB_ENCRYPTION_KEY=REPLACE_WITH_A_STRONG_ENCRYPTION_KEY`, not an empty line. Copying the file and
> starting without editing it would encrypt the database against a constant that is printed in this
> repository. A fresh installation therefore refuses to start with that value and tells you both ways
> out: put a real key in, or clear the line to run unencrypted. An installation that already runs on
> the placeholder keeps starting - taking a working instance away would not undo anything - and gets
> a warning with the rotation steps on every start instead.

### Local Folder Document Storage (Optional)

Instead of storing document binaries inside SQLite (or on WebDAV), you can write newly uploaded
document files to a plain host folder mounted into the container. This keeps the database small and
lets other self-hosted tools share the same files directly. It is configured purely through the
deployment environment (a mount, analogous to the data and backup folders) and, when enabled, takes
precedence over WebDAV. Existing database/WebDAV documents are not migrated and remain readable; a
write failure (e.g. a read-only mount) fails the upload loudly rather than silently falling back.

Mount a host directory to the container path and enable the backend:

```yaml
# docker-compose.yml
volumes:
  # Both ends come from the .env, so changing the container path moves the mount with it
  - ${DOCUMENT_STORAGE_LOCAL_DIR:-./documents}:${DOCUMENT_STORAGE_LOCAL_PATH:-/documents}
environment:
  - DOCUMENT_STORAGE_LOCAL_ENABLED=true
  - DOCUMENT_STORAGE_LOCAL_PATH=/documents
```

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DOCUMENT_STORAGE_LOCAL_ENABLED` | Write new document files to the mounted folder (`true`/`false`) | `false` | No |
| `DOCUMENT_STORAGE_LOCAL_PATH` | Container path for document files | `/documents` | No |
| `DOCUMENT_STORAGE_LOCAL_DIR` | Compose-only: host folder mounted to `DOCUMENT_STORAGE_LOCAL_PATH` | `./documents` | No |

> Ensure the mounted folder is writable by the container (adjust ownership/permissions as needed).

### Upload Size

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MAX_UPLOAD_MB` | Largest single upload in megabytes, shared by documents, calendar attachments and housekeeping receipts. Supported range 1-100; values outside it are clamped, anything unparseable falls back to the default. The interface reads this value too, so hints and error messages name whatever you configure. | `5` | No |

> **Why there is a ceiling at all.** The request body is buffered in memory before any route sees
> it, and a file travels as base64, which adds a third to its size. The limit therefore protects the
> process, not the disk: on a small single-board machine a very large value can end the container
> mid-upload. Raise it to what your documents actually need rather than to the largest number that
> seems safe.
> Files live on the host volume, so include that folder in your host-level backups — database
> backups hold only document metadata, not these binaries.

> **`_DIR` and `_PATH` are the two ends of one mount and must match.** If `DOCUMENT_STORAGE_LOCAL_PATH`
> points at a path nobody mounted, uploads still succeed: the folder is created inside the container
> layer and the files are gone on the next `pull && up -d`, while the database keeps referencing them.
> Since v2.9.0 the server checks this at startup and warns when the folder is missing or not writable,
> naming the path it looked for. A silent start means the mount is where the app expects it.

### WebDAV Document Storage (Optional)

Admins can configure **Settings → Sync → Document storage** as the global destination for all
new document files, including calendar attachments. Existing local documents are not migrated.
Uploads fail closed: if WebDAV cannot accept the file, Yuvomi rejects the upload instead of silently
storing it in SQLite. Disabling WebDAV changes only future uploads; existing WebDAV documents remain
readable and deletable.

The settings UI and the environment use hybrid per-field precedence. Every non-empty environment
value below overrides only its corresponding database value and makes that field read-only in the
UI. Empty values fall back to the database configuration.

For SSRF protection, URLs entered through the admin UI must resolve only to public network
addresses. Private, loopback, link-local, and internal DNS targets are rejected and rechecked when
the connection is opened. To use a trusted WebDAV server on the local network, either configure
`DOCUMENT_STORAGE_WEBDAV_URL` through the deployment environment (env-provided URLs are trusted and
may be private), or set `DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK=true` to lift the check for
UI-managed URLs as well. Only enable the opt-in in controlled environments.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DOCUMENT_STORAGE_WEBDAV_ENABLED` | Use WebDAV for new document files (`true`/`false`) | `false` | No |
| `DOCUMENT_STORAGE_WEBDAV_URL` | HTTP(S) WebDAV server URL | — | No |
| `DOCUMENT_STORAGE_WEBDAV_USERNAME` | Basic Auth username | — | No |
| `DOCUMENT_STORAGE_WEBDAV_PASSWORD` | Basic Auth password or app password | — | No |
| `DOCUMENT_STORAGE_WEBDAV_PATH` | Base folder for document objects | — | No |
| `DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK` | Allow private/local network WebDAV targets (e.g. Nextcloud in the same Docker network); lifts SSRF protection (`true`/`false`) | `false` | No |

When WebDAV documents already exist, changing the URL, username, password, or base path requires an
explicit confirmation and a successful read test against an existing object. Required connection
data cannot be removed while those documents exist. The connection test performs a temporary
PUT/GET/DELETE roundtrip in the target folder.

> **Important backup boundary:** SQLite/database backups do **not** contain document binaries stored
> on WebDAV. Back up the WebDAV target separately and retain it together with the corresponding
> database backup.

### Google Drive Document Storage (Optional)

Google Drive is a separate Documents OAuth connection, even when it reuses the same Cloud Console
client ID and secret as Google Calendar. Enable the **Google Drive API**, add the exact redirect URI
`https://<YOUR-DOMAIN>/api/v1/documents/storage/google-drive/callback`, and configure the variables
below. Yuvomi requests only `https://www.googleapis.com/auth/drive.file`; it cannot browse arbitrary
Drive files and never creates public permissions.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GOOGLE_DRIVE_CLIENT_ID` | Optional Drive-specific OAuth client ID; set together with the secret | Reuses `GOOGLE_CLIENT_ID` | No |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Optional Drive-specific OAuth client secret | Reuses `GOOGLE_CLIENT_SECRET` | No |
| `GOOGLE_DRIVE_REDIRECT_URI` | Exact Drive Documents callback URL | — | Yes when Drive is configured |

After deployment, open **Settings → Sync → Document storage**, connect Google Drive, test the
connection, then explicitly select Google Drive as the upload destination. Connecting does not
activate it. New files are placed in the visible private `Yuvomi/Documents` folder; the opaque Drive
file ID is stored in SQLite. The environment-managed local-folder backend still takes precedence.

Drive access and refresh tokens use Drive-specific database records and never the Calendar token
keys. They are encrypted at rest only when `DB_ENCRYPTION_KEY` enables SQLCipher; otherwise they are
stored as plaintext in SQLite, so database encryption is strongly recommended. Reconnection validates
the candidate account and an existing Drive-backed file before replacing working credentials.
Disconnect is blocked while Drive is selected or Drive-backed rows exist, and it removes only local
Drive token state without revoking shared Google credentials.

> **Access and backup boundary:** Yuvomi visibility settings only control access through Yuvomi.
> Anyone with access to the connected Google Drive folder can view all files stored there. SQLite backups contain
> metadata and Drive file IDs, not binaries. Back up or export the Drive folder separately and restore
> it with the matching database.

### Weather (Optional)

The weather widget defaults to **Open-Meteo** — free, ECMWF-backed, and requiring **no API key**. Just set your coordinates (find them on [openstreetmap.org](https://www.openstreetmap.org) or Google Maps). You can also configure this in-app under **Settings → Administration → Household weather** (admin only), which takes precedence over the environment variables and acts as the household default. Any user can additionally set their own personal location under **Settings → Personal → My Weather**, which overrides the household default just for their own dashboard widget.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `WEATHER_LAT` | Latitude of your location (e.g. `52.52`) | - | No |
| `WEATHER_LON` | Longitude of your location (e.g. `13.41`) | - | No |
| `WEATHER_CITY` | Display name shown on the widget (e.g. `Berlin`) | - | No |
| `WEATHER_UNITS` | Unit system (`metric` or `imperial`) | `metric` | No |

**OpenWeatherMap (legacy, optional).** Existing setups using an OpenWeatherMap API key keep working — these variables are still read when the Open-Meteo coordinates above are not set. One difference is visible on the dashboard: the card shows today's high and low under the current temperature on Open-Meteo only. OpenWeatherMap returns a three-hour list rather than daily aggregates, and that list starts at the next step - by the afternoon today's bucket is missing the morning, so its maximum can fall below the current reading standing right beside it. The line is left off rather than filled with a range that is only sometimes a range.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OPENWEATHER_API_KEY` | API key from [openweathermap.org](https://openweathermap.org/api) | - | No |
| `OPENWEATHER_CITY` | City name for weather display | `Berlin` | No |
| `OPENWEATHER_UNITS` | Unit system (`metric` or `imperial`) | `metric` | No |
| `OPENWEATHER_LANG` | Language for weather descriptions | `en` | No |

### Calendar Subscriptions — ICS Feeds (Optional)

ICS calendar subscriptions are added in the UI. For SSRF protection, feed URLs must use `https://`
and resolve only to public network addresses; `http://`, private, loopback, link-local, and internal
DNS targets are rejected. To subscribe to a feed on your local network (e.g. Sonarr/Radarr/Home
Assistant, or a self-hosted calendar behind an internal DNS name), set the opt-in below. Only enable
it in controlled environments.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK` | Allow `http://` and private/local network ICS feeds; lifts SSRF protection (`true`/`false`) | `false` | No |
| `RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK` | Allow `http://` and private/local network recipe provider (Mealie/Tandoor) targets; lifts SSRF protection (`true`/`false`) | `false` | No |
| `NOTIFICATION_ALLOW_PRIVATE_NETWORK` | Allow private/local network notification channel targets (Webhook, Gotify, ntfy); lifts SSRF protection (`true`/`false`) | `false` | No |
| `DMS_ALLOW_PRIVATE_NETWORK` | Allow private/local network document management targets (Paperless-ngx, Papra); `false` enforces SSRF protection (`true`/`false`) | `true` | No |

> **Note the inverted default.** `DMS_ALLOW_PRIVATE_NETWORK` is the only switch in this family that
> defaults to `true`. A document management system is self-hosted by definition and normally sits on
> the same LAN or Docker network as Yuvomi, so blocking private targets by default would break
> virtually every existing connection. Set it to `false` to enforce the same protection the other
> integrations have; only an explicit `false` or `0` switches it on, so a typo leaves a working
> setup working.

### Google Calendar Sync (Optional)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID from Google Cloud Console | - | No |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client Secret | - | No |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL | `https://<YOUR-DOMAIN>/api/v1/calendar/google/callback` | No |

After connecting, enable the calendars to sync under **Settings → Sync**. The sync runs both ways:
events created, edited, deleted, or moved to another calendar in Yuvomi are applied in Google as
well, and changes made in Google flow back. Outbound changes are attempted immediately and retried
by the next sync run (`SYNC_INTERVAL_MINUTES`) if Google is unreachable. A calendar is only written
to when the connected account has write access to it, and the **read-only mode** checkbox stops
Yuvomi from changing anything in Google while still importing normally.

Recurring appointments are imported as one series with its repeat rule, and cancelled or moved
occurrences are carried over individually. Upgrading to v1.56.0 makes the first sync run read every
enabled calendar in full once, which takes longer than usual and then returns to the normal
incremental runs. That run also merges appointments that earlier versions had stored as separate
occurrences back into their series; an occurrence you had assigned to someone or given its own
colour is kept as a separate entry instead.

### Outlook Calendar Push — Microsoft Graph (Optional)

One-way push **Yuvomi → Outlook.com** for personal Microsoft accounts (outlook.com, hotmail.com, M365 Family). Outlook.com does not support CalDAV, so this provider uses the Microsoft Graph API. Yuvomi stays the source of truth: pushed events are created/updated/deleted in Outlook, and every sync run also checks the pushed events for remote drift (one cheap `changeKey` listing per calendar) — events edited in Outlook are reset to the Yuvomi state, events deleted in Outlook are re-created. Multiple family accounts can be connected.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MS_CLIENT_ID` | Application (client) ID of your Entra ID app registration | - | No |
| `MS_CLIENT_SECRET` | Client secret of the app registration | - | No |
| `MS_REDIRECT_URI` | OAuth callback URL | `https://<YOUR-DOMAIN>/api/v1/calendar/outlook/callback` | No |

**Entra ID app registration (free of charge, but a directory is required):**

> Microsoft has deprecated creating app registrations *outside a directory* — signing in to Entra with a bare personal account shows a blocking notice. You need an Entra tenant to hold the app: sign up for a **free Azure account** (creates a "Default Directory"; identity verification asks for a credit card, but the app registration and Graph calls stay free). The M365 Developer Program alternative is restricted to Visual Studio Professional/Enterprise subscribers and Microsoft partners. Your family's personal accounts do **not** need to join the tenant — it only hosts the app registration.

1. Sign in at [entra.microsoft.com](https://entra.microsoft.com) with the account that owns the tenant → **Identity → Applications → App registrations → New registration**.
2. Name: e.g. `Yuvomi Calendar Push`. Supported account types: **"Personal Microsoft accounts only"**.
3. Platform: **Web**, redirect URI: `https://<YOUR-DOMAIN>/api/v1/calendar/outlook/callback` (must be HTTPS, or `http://localhost:3000/...` for local testing). This must match `MS_REDIRECT_URI` exactly.
4. After creation, copy the **Application (client) ID** → `MS_CLIENT_ID`.
5. **Certificates & secrets → New client secret** → copy the secret **Value** (shown only once) → `MS_CLIENT_SECRET`. Note the expiry (max. 24 months) — you must create a new secret before it expires.
6. API permissions are requested dynamically via OAuth scopes (`Calendars.ReadWrite`, `User.Read`, `offline_access` — delegated); no admin consent is needed for personal accounts.
7. Set the three `MS_*` variables in `.env`, restart Yuvomi, then connect each family member's account under **Settings → Synchronization → More providers → Outlook** (admin only).
8. After connecting, no calendars are enabled yet. Recommended setup: create a **dedicated calendar in Outlook** (e.g. "Yuvomi"), refresh the calendar list, pick it as the **auto-sync target calendar**, and choose which family member the account belongs to — from then on all Yuvomi events visible to that person are pushed there automatically, with assigned members appended to the title (`Dinner (Anna, Ben)`). Alternatively (or additionally), individual events can pick an explicit Outlook target in the event dialog; an explicit target overrides the auto-sync calendar for that event.

**Limitations (one-way push):** recurring events support Yuvomi's RRULE subset only; excluded single occurrences (EXDATE) are not propagated; no attendees, reminders, attachments, or colors. **Times follow the household zone since v2.34.0 (#829)** - until then `Europe/Berlin` was hard-coded here, justified as parity with the Google outbound sync although that one already read the target calendar's own zone and only fell back to `TZ`; a household in Toronto pushed every appointment six hours out. Refresh tokens for personal accounts expire after ~90 days of inactivity — the account then shows a "reconnect" button.

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
| `SYNC_INTERVAL_MINUTES` | Sync interval in minutes for calendars and contacts | `15` | No |

CalDAV and iCloud sync both ways: events created, edited, deleted, or moved to another calendar in
Yuvomi are applied on the server as well, and changes made there flow back. An outbound change is
attempted right when you save and retried by the next sync run if the server cannot be reached.
Editing preserves everything the server holds that Yuvomi does not — attendees, alarms, categories
and exceptions of a recurring series stay untouched. Events that were already synced before the
upgrade to v1.52.0 need one sync run before edits and deletions can reach them.

### Two-Factor Authentication (Optional)

Nothing to configure — there is no environment variable, and Yuvomi never reaches the network for
this. Each member turns it on for themselves under **Settings → Personal → Account**: scan the QR
code with any authenticator app (or type the secret by hand), enter the six-digit code once, and
store the ten recovery codes that appear. They are shown exactly once; afterwards the server only
holds their hashes.

Signing in then asks for the code after the password. A recovery code works in its place — each one
once — for the case where the device is gone.

**Turning it off asks for a code, not the password.** Against a hijacked session only the second
factor helps, and accounts that sign in via SSO have no password to prove anything with.

**Household-wide requirement.** Under **Settings → Administration → Family**, an admin sees who has
already set it up and can make it mandatory. The requirement blocks *turning off* and puts a notice
on every account page without a second factor — it deliberately does not reject sessions that
already exist, because in a household where nobody has set it up yet that would lock everyone out,
including the admin.

**Single sign-on does not skip it.** If you have a second factor set up, Yuvomi asks for the code
after the OIDC provider sends you back — otherwise the household-wide requirement would only bind
those who sign in with a password.

Time matters: TOTP codes are derived from the clock, and Yuvomi accepts a deviation of ±30 seconds.
If codes are rejected on a device whose clock drifts, sync the clock rather than the app.

### SSO / OpenID Connect (Optional)

Enable single sign-on via any OpenID Connect provider (Authentik, Keycloak, Google, Microsoft Entra, etc.).

Pocket ID documents Yuvomi as one of its [client examples](https://pocket-id.org/docs/client-examples/yuvomi), which is a working set of values for the four variables below if you run that provider.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OIDC_ISSUER` | OIDC provider issuer URL (e.g. `https://authentik.example.com/application/o/yuvomi/`) | - | No |
| `OIDC_CLIENT_ID` | Client ID registered with your OIDC provider | - | No |
| `OIDC_CLIENT_SECRET` | Client secret for the registered application | - | No |
| `OIDC_REDIRECT_URI` | OAuth callback URL — must be registered with the provider (e.g. `https://yuvomi.example.com/api/v1/auth/oidc/callback`) | - | No |
| `OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM` | Set to `true` to allow account linking when the IdP omits the `email_verified` claim entirely. Only enable for IdPs fully under your control that never issue unverified addresses (e.g. older Authentik without an explicit `email_verified` property mapping). | - | No |
| `OIDC_ALLOW_SIGNUP` | Set to `false` so an SSO sign-in never provisions a new account. Sign-in and account linking are unaffected, so the admin creates the account and the user signs in with SSO. Use this when your identity provider serves more people than this household. | `true` | No |
| `AUTH_ALLOW_PASSWORD_LOGIN` | Set to `false` to make SSO the only way in: the login form, password login and password reset are all switched off. Ignored until all four OIDC variables are set **and** at least one account is linked to the provider, so a typo - or a fresh install - can never lock everyone out. | `true` | No |

When all four OIDC variables are set, a **"Sign in with SSO"** button appears on the login page. The flow uses Authorization Code + PKCE (S256) with a nonce. On first login, the user is matched by their OIDC `sub`. If no match exists, an existing local account is linked automatically **only when the provider reports a verified email (`email_verified: true`) and exactly one local account holds that email address**; otherwise a new account is provisioned. Unverified or ambiguous emails never take over an existing account. If your provider omits the `email_verified` claim, set `OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM=true` to enable linking.

**Who gets an account.** By default every identity your provider accepts gets one on first sign-in - convenient for a provider you run for this household alone, but a directory is a list of people, not a list of household members. Set `OIDC_ALLOW_SIGNUP=false` and provisioning stops: an unknown identity is turned away with "There is no account here yet for this SSO sign-in" instead of the generic SSO error, while known accounts sign in as before. Linking still happens too, which is what makes the switch usable: create the account under **Settings → Administration → Family** with the member's email address, and their first SSO sign-in binds the two together (the provider must report `email_verified: true`, or the account owner links it themselves under **Settings → Account → Single sign-on**).

**Making SSO the only way in.** Even with SSO configured, Yuvomi keeps a second door open: the login form stays, password reset stays, and every account carries a password hash. Set `AUTH_ALLOW_PASSWORD_LOGIN=false` and that door closes - the login page shows nothing but the SSO button, `POST /auth/login` is refused outright (the rule sits on the route, not just on the page), and password reset disappears with it rather than staying as a route that can still send mail. **One exception is offered, and only where it applies (#962):** guests of shared expenses stay exempt from the switch, because they are external people with no entry in your identity provider, so a household that has such guests keeps a second button for them. A household that has none sees no second button - it used to appear regardless, which looked like a hole in the bolt you had just closed.

Three things are deliberate:

- **The switch only takes effect once somebody can actually get in through SSO.** Two conditions: all four OIDC variables set, and at least one account already linked to the provider. Until then password login stays on and the server says so on startup. The second condition is what makes a fresh install work - it creates its first administrator through `/setup` with a password, and that account would otherwise be dead the moment it was created, with `/setup` closed behind it. Sign in once through SSO to link the admin account, and the switch takes hold from then on.
- **Invitations adapt.** While the switch is in effect, accepting an invitation creates an account with no password, linked on first SSO sign-in through the invitation's email address. An invitation without an email address is refused rather than consumed into an account nobody can reach.
- **Existing passwords are not touched.** Setting the variable back to `true` restores the form exactly as it was. Removing a password is a per-account decision instead: **Settings → Administration → Family** offers "SSO sign-in only" both when creating a member and when editing one. An account switched this way carries a placeholder no password can ever match; switching it back requires setting a new password in the same step, so the account is never left with no way in at all.
- **Recovery is a documented `.env` change.** If the identity provider becomes unreachable, remove the line and restart. A break-glass admin account with a password would defeat the point of the switch, so there is none.

**Creating an account without a password.** Preparing an account for an SSO user used to mean inventing a password - and the invented password stayed a working credential. With OIDC configured, the "SSO sign-in only" toggle under **Settings → Administration → Family** creates the account without one. Such an account needs an email address, and one that belongs to no other member: an account with no password and no linkable identity could never be signed into, because a matching *username* deliberately never links. This works whether or not `AUTH_ALLOW_PASSWORD_LOGIN` is set, so a household can run mixed: some members with a password, some SSO-only.

**Username of a newly provisioned account.** The name is taken from the first claim that yields something usable: `preferred_username`, then the non-standard `username` claim (Synology DSM SSO sends the plain account name there, where `sub` still carries the directory part), then `sub`. The email address is deliberately not a candidate: a household often shares one address across several members, so it identifies nobody, and its domain part only makes the name unwieldy. Whichever claim wins is reduced to the format every username in Yuvomi follows (`a-z A-Z 0-9 . _ -`, 3 to 64 characters), with accents transliterated and anything else turned into a hyphen. Admins can rename the account afterwards under **Settings → Administration → Family**; sign-in keeps working either way, because the identity hangs on `sub`, not on the name.

**Linking an existing account yourself.** A matching *username* deliberately never links: anyone who names themselves `admin` at the identity provider would otherwise take over the local admin account. If neither the `sub` nor a verified email matches, the first SSO sign-in therefore creates a separate account - same name with a numeric suffix (`test1-1`), and the original account's data stays where it is. The way to merge the two is to sign in locally and open **Settings → Account → Single sign-on**, where "Link SSO account" runs the same provider flow and binds the resulting `sub` to the account you are signed in as. Being signed in is the point: the session names the local account and the provider names the remote one, which together prove ownership of both. Linking is refused when that `sub` already belongs to another account. The same card removes a link again - except on an account that was created through SSO, because it holds no password and the link is its only way in; set a password first.

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
| `BACKUP_ENABLED` | Enable scheduled backups (`true`/`false`) | `true` | No |
| `BACKUP_SCHEDULE` | Cron expression for backup schedule | `0 2 * * *` | No |
| `BACKUP_DIR` | Directory (inside container) where backup files are written. Must be a writable, mounted path, otherwise backups fail with `EACCES`. | `/backups` (container), `./backups` (bare metal) | No |
| `BACKUP_KEEP` | Number of most-recent backup files to retain | `7` | No |
| `BACKUP_UPLOAD_LIMIT` | Maximum size of a backup file uploaded for restore through the admin UI (Express body-limit syntax). Raise it when restoring a database larger than the default. | `100mb` | No |

**WebDAV backup target (optional):** After each local backup, Yuvomi can automatically upload the file to any WebDAV-compatible server (Nextcloud, ownCloud, Hetzner Storage Box, Infomaniak kDrive, etc.). Configure in **Settings → Administration → Backup and restore → WebDAV Backup Target**, or via environment variables (env vars take precedence over the UI):

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `WEBDAV_BACKUP_ENABLED` | Enable WebDAV backup uploads (`true`/`false`) | — | No |
| `WEBDAV_BACKUP_URL` | WebDAV server URL (e.g. `https://cloud.example.com/remote.php/dav/files/user/`) | — | No |
| `WEBDAV_BACKUP_USERNAME` | WebDAV username | — | No |
| `WEBDAV_BACKUP_PASSWORD` | WebDAV password | — | No |
| `WEBDAV_BACKUP_PATH` | Remote directory path for backup files | `/yuvomi/backups/` | No |
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

Yuvomi ships with an example configuration. Copy it and replace `deine-domain.de` with
your actual domain — but do **not** enable the site yet: its HTTPS block references a
certificate that does not exist until the next step, and Nginx refuses to load an
`ssl` listener without one.

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/yuvomi
sudo nano /etc/nginx/sites-available/yuvomi   # replace deine-domain.de
```

The configuration includes:
- HTTP-to-HTTPS redirect
- Proxy pass to the Docker container on port 3000
- WebSocket upgrade headers (for connection upgrades)
- Security headers (HSTS, X-Frame-Options, etc.)
- Static asset caching

> **Using Nginx Proxy Manager instead?** Paste the file's contents into the proxy host's
> **Advanced** tab and you are done — NPM obtains and manages the certificate itself, and
> the commented `ssl_certificate` lines stay commented.

### Enable HTTPS with Let's Encrypt

Obtain the certificate **first**, then activate the site. The standalone method answers
the challenge on port 80 itself, so it works before any site is configured (the hooks
stop and restart Nginx around it, and are remembered for automatic renewals):

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot certonly --standalone -d <YOUR-DOMAIN> \
  --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"
```

Now point the site at the new certificate and enable it: uncomment the two
`ssl_certificate` lines in `/etc/nginx/sites-available/yuvomi`, then link and reload:

```bash
sudo nano /etc/nginx/sites-available/yuvomi   # uncomment ssl_certificate + ssl_certificate_key
sudo ln -s /etc/nginx/sites-available/yuvomi /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

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

> Both installers set these for you. The web installer's **Advanced** step asks for your deployment type; the CLI installer derives them from the scheme of the base URL you enter — `https://` means proxy (`SESSION_SECURE=true`, `TRUST_PROXY=1`), anything else means direct access (`SESSION_SECURE=false`, `TRUST_PROXY=loopback`). A value already present in your `.env` always wins, so a hand-tuned `TRUST_PROXY=2` survives a re-run.

Then restart the container so the new values take effect:

```bash
docker compose up -d
```

### Alternative: Caddy

If you prefer Caddy, certificates are obtained and renewed automatically — the whole
reverse proxy is two lines in a `Caddyfile`:

```
yuvomi.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `SESSION_SECURE=true` and `TRUST_PROXY=1` in `.env` as above, then reload Caddy.

---

## Podman & systemd Autostart (rootless)

On RHEL-based systems you can run Yuvomi as a rootless systemd service via Podman
[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html). Yuvomi
ships a ready-made unit at `tools/quadlet/oikos.container`.

```bash
# 1. Create the data folders and drop your generated .env in place
mkdir -p ~/.local/share/oikos/{data,backups,modules,documents} ~/.config/oikos
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

> **One-time step when upgrading past the container rename (Oikos → Yuvomi):** the Docker/Podman
> service and container were renamed from `oikos` to `yuvomi`. Your data is safe - the database
> volume is unchanged and the app migrates an existing `oikos.db` to `yuvomi.db` automatically on
> first start. But the old `oikos` container lingers as an orphan and keeps holding host port 3000,
> which prevents the new `yuvomi` container from starting. Run the update once with
> `--remove-orphans`:
>
> ```bash
> docker compose up -d --remove-orphans
> # Podman: podman compose -f podman-compose.yml up -d --remove-orphans
> ```
>
> TrueNAS, Unraid and Podman-Quadlet installs keep the legacy `oikos` slug and are unaffected.

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

### Going back

Migrations only run forward. The list is append-only and a CI test keeps it that way, so any
backup from an older Yuvomi restores into any newer one, and a database that a newer version has
opened carries migrations an older version does not know. The way back after a bad update is
therefore the backup you took before it, or the `.pre-restore-*` copy a restore leaves next to the
database, never an older image on the current database: an older version refuses to start on a
database a newer one has opened, because what it writes in the meantime can be lost on the next
update, and a backup written by a newer version is refused with a message to update first.
`DB_ALLOW_NEWER_SCHEMA=1` starts it anyway, at your own risk, and says so on every start.

---

## Backup & Restore

### Where is the Data?

The SQLite database lives in the host folder configured through `DATA_DIR` and is mounted at `/data` inside the container. The database file is `/data/yuvomi.db`.

Scheduled backups are written to the host folder configured through `BACKUP_DIR` and mounted at `/backups` inside the container.

> **WebDAV documents are outside the database.** A SQLite/database backup contains their metadata
> and storage keys, but not their binary files. If WebDAV document storage is enabled, back up the
> configured WebDAV target separately. A complete restore requires both matching backups.

### Backup

Use the built-in backup helper to create a consistent SQLite backup from the running container, then copy it to your host:

```bash
docker compose exec yuvomi node -e "import('./server/db.js').then(async db => { await db.backupToFile('/data/yuvomi-backup.db'); process.exit(0); })"
docker cp yuvomi:/data/yuvomi-backup.db ./yuvomi-backup-$(date +%Y%m%d).db
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
SERVICE=yuvomi
BACKUP="$PWD/yuvomi-backup-20260401.db"
docker compose stop "$SERVICE"
docker compose run --rm -v "$BACKUP:/tmp/yuvomi-restore.db:ro" --entrypoint sh "$SERVICE" -c 'set -eu; target="${DB_PATH:-/data/yuvomi.db}"; case "$target" in */oikos.db) target="${target%/oikos.db}/yuvomi.db";; esac; stamp=$(date -u +%Y%m%dT%H%M%SZ); if [ -f "$target" ]; then cp "$target" "$target.pre-restore-$stamp"; fi; rm -f "$target-wal" "$target-shm"; cp /tmp/yuvomi-restore.db "$target"; chown node:node "$target" 2>/dev/null || true'
docker compose up -d "$SERVICE"
```

If your Compose service is renamed, set `SERVICE` to that name, for example `SERVICE=familyplanner`.

For a local CLI restore outside Docker, set the same environment variables used by the app and run:

```bash
DB_PATH=/path/to/yuvomi.db node --import dotenv/config scripts/restore-backup.js ./yuvomi-backup-20260401.db
```

The restore helper validates that the file is a Yuvomi database, and refuses one written by a newer Yuvomi than the one running (update first, then restore), before replacing the active database. It also keeps a pre-restore copy next to the database file for emergency rollback.

### Automated Backups

Add a cron job to back up daily (adjust the path to your preference):

```bash
crontab -e
```

Add this line:

```
0 3 * * * docker compose exec -T yuvomi node -e "import('./server/db.js').then(async db => { await db.backupToFile('/data/yuvomi-cron-backup.db'); process.exit(0); })" && docker cp yuvomi:/data/yuvomi-cron-backup.db /path/to/backups/yuvomi-$(date +\%Y\%m\%d).db
```

This creates a backup at 3:00 AM every day.

---

## Troubleshooting

<details>
<summary>Container stops at startup: "SESSION_SECRET is still the placeholder"</summary>

Your `.env` still carries `SESSION_SECRET=REPLACE_WITH_A_LONG_RANDOM_STRING` from `.env.example`.
That value is printed in this repository, so anyone who can reach your instance could forge a
session cookie and sign in as any user - which is why the server refuses to start with it rather
than running on in that state.

Generate a real one and put it in `.env`:

```bash
openssl rand -base64 48
```

Then restart the container. Everyone will have to sign in again once; nothing else is lost, and no
data is affected.

</details>

<details>
<summary>Uploads fail with "Request body too large"</summary>

A single upload may be as large as `MAX_UPLOAD_MB` (default 5). Raise it in `.env`, for example
`MAX_UPLOAD_MB=25`, and restart the container - the hints in the interface follow the new value.

Keep in mind what the limit protects: the request body is buffered in memory before any route sees
it, and a file travels as base64, which adds a third to its size. On a small machine a very large
value can end the container mid-upload, so raise it to what your documents need rather than to the
highest number the app accepts (100).

</details>

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
<summary>Backup fails with <code>EACCES: permission denied, mkdir './backups'</code></summary>

The relative path in the message is the giveaway: the app fell back to its bare-metal
default (`./backups`, i.e. `/app/backups` in the container) instead of writing to the
mounted `/backups` volume, and the unprivileged `node` user cannot create it there.
Your host folder is fine — it just was never the target.

This happened on deployments that mounted `/backups` without also setting `BACKUP_DIR`
(Unraid before this fix, hand-rolled `docker run`). Update to the current image, which
defaults `BACKUP_DIR` to `/backups`. If you build or run the container yourself, pass it
explicitly:

```bash
docker run -e BACKUP_DIR=/backups -v /path/on/host/backups:/backups ...
```

Since this fix the error message names the resolved absolute path, so a genuinely
unwritable mount is easy to tell apart from a misconfigured `BACKUP_DIR`.

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
chcon -Rt container_file_t ./data ./backups ./modules ./documents
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
   docker port yuvomi
   ```

4. Check your firewall rules if accessing from another device.

</details>

<details>
<summary>Database encryption error</summary>

If the logs show SQLCipher errors, the `DB_ENCRYPTION_KEY` in your `.env` file is either missing or does not match the key used when the database was created.

If this is a fresh install, remove the database folder and start over. The compose file
uses bind mounts, so `docker compose down -v` does **not** delete anything here — the
encrypted database survives it and the error persists. Remove the host folder itself:

```bash
docker compose down
rm -rf ./data   # your DATA_DIR, if you changed it — this permanently deletes the database
docker compose up -d
```

If you have existing data, you need the original encryption key. There is no way to recover data without it.

</details>

<details>
<summary>Native module build fails during Docker build</summary>

> **Tip**: If you hit build issues, switch to the pre-built image (Option B above) — it ships the database module ready to run and requires no local build step.

The database encryption is built into the `better-sqlite3-multiple-ciphers` module, so no system SQLCipher is needed. The build normally downloads a prebuilt binary for your architecture from GitHub; if that download fails, `node-gyp` compiles the module from source instead. The Dockerfile keeps `python3`, `make` and `g++` installed for exactly that fallback.

So if the build fails, check both: your Docker installation is up to date, and the build has internet access to reach both the Debian package mirrors and GitHub.

On resource-constrained systems, the source fallback may run out of memory. Ensure at least 1 GB of RAM is available during the build.

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
   docker compose logs | grep "Server running"
   ```

</details>

<details>
<summary>"Something went wrong" right after updating, mentioning a module export</summary>

A tab that was left open while the container was updated can end up mixing versions: the
browser keeps one module map per page, so a freshly loaded part of the new version binds
against parts of the old one that are still in memory. The error names the mismatch, for
example `The requested module '/utils/empty-state.js' does not provide an export named
'mountLoadError'`.

Reloading the page clears it - the state cannot survive a reload:

- Desktop: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on macOS)
- Installed PWA: close and reopen the app

Since v1.64.1 the app prevents this by itself: once it learns that a new version is
available, it stops loading further parts of the old page and reloads instead. Updating
**to** that version can still show the error once, because the safeguard only ships with
the version it protects. It does not indicate a damaged database - unrelated errors in
the container log, such as SQLite messages, are worth checking separately.

</details>

<details>
<summary>CalDAV tasks are not syncing</summary>

Adding a CalDAV account only sets up **calendars**. Task lists live on their own page under
**Settings → Synchronization → Reminder sync**, and each list has to be switched on there and
mapped to Tasks or Shopping before anything is mirrored. That step is deliberate: enabling every
list by default would pull a server's existing reminders into your task board unannounced.

After switching a list on, either press "Sync reminders" or wait for the next scheduled run
(`SYNC_INTERVAL_MINUTES`).

Once a list is enabled for **Tasks**, it also becomes a destination: the task dialog gains a "sync
target" field, and a task created in Yuvomi with a target set is uploaded on the next run (or right
away, on save). Each member sets their own default under **Settings → Personal → Task defaults** -
which lists the household mirrors is an admin decision, which of them your new tasks go to is
yours. A task without a target stays local, as every task did before. Lists mapped to **Shopping**
are not offered as task destinations: a task sent there would come back as a shopping item.
Subtasks are never uploaded on their own, and a task that has already been uploaded cannot be moved
to a different list.

One boundary worth knowing if you use both mirroring and the task lock: a **locked** task is closed
to everyone but its creator and admins inside Yuvomi, but an **inbound sync still rewrites its
mirrored fields**. The sync runs with the household's CalDAV credentials rather than as a member,
and whoever holds those has full access to the list anyway; the alternative would be to let the
mirror diverge silently, which is worse. Keep tasks you want locked on a list nobody else can write
to, or leave them local.

If the page shows no lists at all, the server is not advertising any collection that accepts
`VTODO`. Create a task list in your CalDAV server (in Radicale, Nextcloud or your client of
choice), then press "Refresh reminder lists".

Before v1.75.7 the page only looked for lists when that refresh button was pressed, so a freshly
added account showed an empty state even when the server was serving task lists. Upgrading fixes
this without any action on your part. A second bug, fixed in v1.68.1, made the fetch ask for
appointments on task lists, which left the mirror empty against Radicale and Nextcloud.

**iCloud is the exception: Apple Reminders is no longer a CalDAV source.** With iOS 13 and
macOS 10.15 the upgraded Reminders app moved its lists into a private store that no CalDAV client
can read. Over CalDAV, iCloud still serves the task collections that existed *before* that switch -
usually none, sometimes a single orphaned list that the Reminders app itself no longer shows. So an
iCloud account whose calendars sync perfectly can still offer no usable reminder list, and no
setting on either side changes that. The reminders page states this on every iCloud
account. If you want your Apple tasks in Yuvomi, keep them in a CalDAV-backed list (Nextcloud,
Radicale, Baikal) and subscribe to it from the Reminders app's "Other" account rather than iCloud.

</details>

<details>
<summary>Outlook events are not appearing</summary>

Work through this in order — each step rules out one of the four things that stop a push.

**1. Is the provider configured at all?** All three of `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and
`MS_REDIRECT_URI` must be set; with one missing, the Outlook panel stays inactive and nothing is
ever sent. `MS_REDIRECT_URI` has to match the redirect URI in the Entra app registration
character for character, including the scheme and any trailing path.

**2. Is a target calendar picked?** Connecting an account enables nothing on its own — newly
discovered calendars start switched **off** by design, so that the first push cannot land in a
personal main calendar unannounced. Pick an auto-sync target calendar **and** the family member
the account belongs to; without both, the automatic push does not run at all. A calendar that
Microsoft reports as read-only is skipped even when enabled.

**3. Which events are eligible?** Only local events are pushed. Appointments that came in from
Google, CalDAV, iCloud or an ICS subscription are excluded on purpose — they usually already
exist in Outlook natively, and pushing them would duplicate them. The auto-sync also honours
per-event visibility: an event the chosen family member is not allowed to see is not pushed to
their calendar.

**4. Has the sign-in expired?** Refresh tokens for personal Microsoft accounts expire after about
90 days of inactivity, and the client secret of the app registration expires after at most 24
months. In the first case the account shows a "reconnect" button; in the second, every account
stops working at once and a new secret has to be created in Entra and written to
`MS_CLIENT_SECRET`.

A push is not immediate: it happens on the shared sync run (`SYNC_INTERVAL_MINUTES`, 15 minutes by
default), right after connecting, and whenever an admin triggers it manually. The same applies in
reverse — deleting an event in Yuvomi removes it from Outlook on the *next* run, not instantly.

Editing a pushed event in Outlook is pointless: Yuvomi is the source of truth and resets it to its
own state on the next run, and re-creates it if you delete it there. To get rid of an event for
good, delete it in Yuvomi. Note also that disconnecting an account leaves everything already
pushed behind in Outlook — clear those events in Yuvomi *before* disconnecting, or delete them by
hand in Outlook afterwards.

</details>

<details>
<summary>Single CalDAV events never show up, and nothing is logged</summary>

Fixed in v2.47.0 (#883). Update and run a sync; the missing events arrive on the next pass.

Before that, Yuvomi discarded any calendar object whose URL did not contain `.ics`. That extension
is pure convention - RFC 4791 prescribes no name for the object resource, and a server is free to
assign its own. Stalwart, for instance, does so for everything created over JMAP (`NZtPkIOMoK`),
while objects written by a CalDAV `PUT` keep the client-chosen `<uid>.ics`. In the same calendar,
part of the events synced and part did not - and because the discarded ones were never fetched, no
log line could name them: the sync reported success with a plausible event count.

If events are still missing after the update, the server log now names them. Anything the parser
rejects is reported at warn level with its UID and the reason, so a report can point at a concrete
event instead of an absence.

</details>

---

## Uninstall

Stop and remove the container:

```bash
docker compose down
```

The compose file uses bind mounts, so `docker compose down -v` does **not** delete your
data — the folders stay on the host. To remove all data, delete them yourself:

```bash
rm -rf ./data ./backups ./modules ./documents
```

If you cloned the repository (Options A/C), those folders live inside it, so removing the
repository removes everything at once. If you installed with only the downloaded compose
file (Option B), the folders sit next to that file — the `rm` above is the step that
actually deletes your data:

```bash
cd .. && rm -rf yuvomi
```

> **Warning**: Deleting these folders permanently removes all data including the database.
> Create a backup first if needed. Only the Portainer stack uses named volumes; there
> `docker compose down -v` (or deleting the stack incl. volumes) removes the data.
