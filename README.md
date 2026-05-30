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

Oikos is a self-hosted web app that keeps your household organized — tasks, groceries, meals, calendar, budget, and more — in one private place, without cloud accounts or subscriptions. Runs as a Docker container on any home server or NAS. Accessible on every device. Installable as a PWA.

Each module is independent. Use what fits, skip what doesn't.

---

## Modules

| | |
|---|---|
| **Tasks** | Shared tasks with deadlines, priorities, subtasks, recurring schedules, and multi-member assignment. |
| **Shopping** | Collaborative lists organized by aisle. Import from meal plans in one click. |
| **Meals** | Weekly drag-and-drop planner with direct export to your shopping list. |
| **Recipes** | Create, duplicate, and scale recipes. Pre-fill meal slots or save any meal as a recipe. |
| **Calendar** | Google Calendar (OAuth) and CalDAV sync (iCloud, Nextcloud, Radicale). ICS subscriptions, recurring events, file attachments. |
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

- **Liquid Glass UI** — translucent surfaces, backdrop blur, spring animations, and module-tinted overlays — built in pure CSS
- **PWA** — installable on any device, works offline, responsive from phone to desktop, dark mode
- **Privacy First** — fully self-hosted, SQLCipher AES-256 encrypted database, zero telemetry
- **Zero Build Step** — pure ES modules, no bundler, no transpiler, no framework
- **Multilingual** — 16 languages with automatic locale detection (de, en, es, fr, it, sv, el, ru, tr, zh, ja, ar, hi, pt, uk, pl)

---

## Quick Start

**Option A — Web Installer (recommended)**

```bash
git clone https://github.com/ulsklyc/oikos.git && cd oikos
node tools/installer/install-server.js
```

Open **http://localhost:8090** in your browser. The wizard configures your `.env`, starts Docker, and creates your admin account. Requires Node.js 18+ on the host.

**Option B — Pre-built image (no clone required)**

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/oikos/main/.env.example
cp .env.example .env          # set SESSION_SECRET and DB_ENCRYPTION_KEY
docker compose up -d
docker compose exec oikos node setup.js
```

**Option C — Build from source**

```bash
git clone https://github.com/ulsklyc/oikos.git && cd oikos
cp .env.example .env          # set SESSION_SECRET and DB_ENCRYPTION_KEY
docker compose up -d --build
docker compose exec oikos node setup.js
```

Open `http://localhost:3000` and sign in with the admin credentials you created above.

> **New to Docker?** The **[Installation Guide](docs/installation.md)** covers Docker setup, HTTPS, backups, and troubleshooting step by step.

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
