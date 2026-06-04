<div align="center">
  <img src="docs/logo.svg" alt="Oikos" width="96" />

  <h1>Oikos</h1>
  <p><strong>The self-hosted family planner. Private, offline-capable, and beautiful.</strong></p>

  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
  <a href="https://github.com/ulsklyc/oikos/releases"><img src="https://img.shields.io/github/v/release/ulsklyc/oikos?style=flat-square&color=007AFF&label=release" alt="Latest Release"></a>
  <a href="https://github.com/ulsklyc/oikos/pkgs/container/oikos"><img src="https://img.shields.io/badge/ghcr.io-oikos-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker Image"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="https://github.com/ulsklyc/oikos/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome"></a>

  <p>
    <a href="docs/installation.md"><strong>→ Install</strong></a> &nbsp;·&nbsp;
    <a href="https://ulsklyc.github.io/oikos/"><strong>Screenshots</strong></a> &nbsp;·&nbsp;
    <a href="docs/SPEC.md"><strong>Docs</strong></a>
  </p>
</div>

<br>

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dashboard-dark-desktop.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/dashboard-light-desktop.png">
    <img src="docs/screenshots/dashboard-light-desktop.png" alt="Oikos Dashboard" width="800">
  </picture>
  <br>
  <sub>Toggle GitHub light/dark mode to see both themes &nbsp;·&nbsp; <a href="https://ulsklyc.github.io/oikos/">View all screenshots</a></sub>
</div>

<br>

Oikos is a self-hosted web app that keeps your household organized — tasks, groceries, meals, calendar, budget, and more — in one private place, without cloud accounts or subscriptions. Runs as a Docker or Podman container on any home server or NAS — including rootless Podman on SELinux-enabled RHEL/Fedora/CentOS Stream. Accessible on every device with a polished mobile-first PWA interface.

Each module is independent. Use what fits, skip what doesn't.

---

## Modules

| | |
|---|---|
| **Tasks** | Shared tasks with deadlines, priorities, subtasks, recurring schedules, multi-member assignment, Kanban, and mobile-friendly bulk controls. Optional read-only import of Apple Reminders lists via CalDAV. |
| **Shopping** | Collaborative lists organized by aisle. Touch-safe quick add, swipe gestures, and meal-plan import in one click. Optional read-only import of Apple Reminders lists via CalDAV. |
| **Meals** | Weekly drag-and-drop planner with direct export to your shopping list. |
| **Recipes** | Create, duplicate, and scale recipes. Pre-fill meal slots or save any meal as a recipe. |
| **Calendar** | Google Calendar (OAuth) and CalDAV sync (iCloud, Nextcloud, Radicale). ICS subscriptions, recurring events, file attachments, and readable month/agenda views. |
| **Documents** | Upload and organize family files. Folders, tags, per-document visibility, drag-and-drop. |
| **Budget** | Income, expenses, recurring entries, trends, CSV export. Split Expenses for shared costs with automatic debt simplification. |
| **Housekeeping** | Manage household staff — schedules, check-in/out, payments, chores, supply requests. |
| **Notes & Contacts** | Colored sticky notes with Markdown. Contact directory with CardDAV sync. |
| **Birthdays** | Birthday tracker with automatic calendar events, age display, and custom reminders. |
| **Family** | Member profiles with roles, photos, phone, email, and birthday — synced to Contacts and Birthdays. |
| **Reminders** | Time-based notifications on tasks and calendar events with in-app badge. |
| **API Tokens** | Named Bearer / X-API-Key tokens for integrations. OpenAPI 3.0 spec included. |
| **Backup** | Manual and scheduled database backup and restore, with automatic pre-restore rollback. |

---

## Design & Technology

- **Disciplined Liquid Glass UI** — readable work surfaces, subtle translucent navigation, spring animations, and module-tinted overlays — built in pure CSS
- **PWA** — installable on any device, works offline, responsive from phone to desktop, with tuned mobile navigation, touch targets, and dark mode
- **Privacy First** — fully self-hosted, SQLCipher AES-256 encrypted database, zero telemetry
- **SSO / OpenID Connect** — optional single sign-on via any OIDC provider (Authentik, Keycloak, Google, Microsoft Entra). Configure with four env vars; Authorization Code + PKCE flow.
- **Zero Build Step** — pure ES modules, no bundler, no transpiler, no framework
- **Multilingual** — 18 languages with automatic locale detection (de, en, es, fr, it, sv, el, ru, tr, zh, ja, ar, hi, pt, uk, pl, nl, cs)

---

## Quick Start

**Option A — Web Installer (recommended)**

```bash
git clone https://github.com/ulsklyc/oikos.git && cd oikos
node tools/installer/install-server.js
```

Open **http://localhost:8090** in your browser. The localized wizard (18 languages) detects your container engine (Docker or Podman), configures your `.env` — including optional reverse proxy/HTTPS, SSO (OIDC), and automatic backups — starts the container, and creates your admin account. Requires Node.js 18+ on the host.

**Option B — Pre-built image (no clone required)**

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/.env.example
cp .env.example .env          # set SESSION_SECRET and DB_ENCRYPTION_KEY
docker compose up -d
```

**Option C — Build from source**

```bash
git clone https://github.com/ulsklyc/oikos.git && cd oikos
cp .env.example .env          # set SESSION_SECRET and DB_ENCRYPTION_KEY
docker compose up -d --build
```

Open `http://localhost:3000` — the first visit guides you through creating your admin account in the browser, then signs you in. (For headless setups you can instead run `docker compose exec oikos node setup.js`.)

**Option D — TrueNAS SCALE (Community Apps Catalog)**

Oikos is available in the TrueNAS SCALE Community Apps Catalog — no terminal required. Open **Apps → Discover Apps**, search for **Oikos**, and install it directly from the UI. Set `SESSION_SECRET` (required) and `DB_ENCRYPTION_KEY` (recommended) during installation. The first visit to the WebUI walks you through creating your admin account.

> **Using Podman (RHEL / Fedora / CentOS Stream)?** Both installers above auto-detect
> Podman and use `podman-compose.yml` (SELinux `:Z` labels, configurable host bind).
> For a manual start, replace `docker compose` with `podman compose -f podman-compose.yml`
> (or `podman-compose -f podman-compose.yml`). For rootless systemd autostart, see the
> Quadlet unit at `tools/quadlet/oikos.container`.

> **New to Docker or Podman?** The **[Installation Guide](docs/installation.md)** covers engine setup, HTTPS, backups, and troubleshooting step by step.

---

## Tech Stack

<p>
  <img src="https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/SQLite%20%2F%20SQLCipher-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Vanilla_JS_(ES_Modules)-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/Plain_CSS-1572B6?style=flat-square&logo=css3&logoColor=white" alt="CSS">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA">
</p>

---

## Documentation

[Installation](docs/installation.md) &nbsp;·&nbsp; [Spec & Data Model](docs/SPEC.md) &nbsp;·&nbsp; [Modules](MODULES.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md) &nbsp;·&nbsp; [Security](SECURITY.md) &nbsp;·&nbsp; [Changelog](CHANGELOG.md) &nbsp;·&nbsp; [Backlog](BACKLOG.md)

---

## License

MIT — see [LICENSE](LICENSE).

<div align="center">
  <sub>Built with care for families who value privacy and simplicity.</sub>
</div>
