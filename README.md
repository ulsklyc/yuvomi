<div align="center">
  <img src="docs/logo.svg" alt="Oikos" width="120" />
  <h1>Oikos</h1>
  <p><strong>Self-hosted family planner for small households</strong></p>

  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
  <a href="https://github.com/ulsklyc/oikos/releases"><img src="https://img.shields.io/github/v/release/ulsklyc/oikos?style=flat-square&color=007AFF&label=release" alt="Latest Release"></a>
  <a href="https://github.com/ulsklyc/oikos/pkgs/container/oikos"><img src="https://img.shields.io/badge/ghcr.io-oikos-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker Image"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="https://github.com/ulsklyc/oikos/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome"></a>
</div>

<br>

<table>
  <tr>
    <td align="center" width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/01-mobile-dark.png">
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/01-mobile-light.png">
        <img src="docs/screenshots/01-mobile-light.png" alt="Mobile Dashboard" width="280">
      </picture>
      <br>
      <sub>Mobile Dashboard</sub>
    </td>
    <td align="center" width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/01-web-dark.png">
        <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/01-web-light.png">
        <img src="docs/screenshots/01-web-light.png" alt="Desktop Dashboard" width="480">
      </picture>
      <br>
      <sub>Desktop Dashboard</sub>
    </td>
  </tr>
</table>

<p align="center">
  <sub>Toggle GitHub light/dark mode to see both themes • <a href="https://ulsklyc.github.io/oikos/">View all screenshots</a></sub>
</p>

Oikos is a self-hosted web app for families who want to organize their everyday life in one place — without cloud accounts, subscriptions, or data leaving the house. It runs as a Docker container on any home server or NAS, is accessible from every device in the household, and can be installed as a PWA on phones and tablets.

The goal is a single, private place for everything that keeps a household running: shared tasks, grocery lists, meal plans, a family calendar, budgets, and more. Each module is independent — use what fits, ignore what doesn't.

## Features

| Module | Description |
|---|---|
| **Tasks** | Shared tasks with deadlines, priorities, subtasks, and recurring schedules. Assign to multiple family members simultaneously with stacked avatar display. Kanban board with touch-friendly one-tap status buttons. Archive completed tasks to keep lists clean. Inline reminder presets (15 min to 2 weeks before due). Schedule tasks with a future start date — future tasks are hidden by default and revealed via a "Show scheduled" toggle. |
| **Shopping Lists** | Collaborative lists organized by aisle. Import ingredients from meal plans in one click. |
| **Meal Planning** | Weekly drag-and-drop planner. Export ingredient lists directly to your shopping list. |
| **Recipes** | Create, duplicate, and scale reusable recipes. Pre-fill meal slots from a recipe or save any meal as a recipe. |
| **Calendar** | Two-way sync with Google Calendar (OAuth) and multiple CalDAV accounts (iCloud, Nextcloud, Radicale, Baikal). Per-account calendar selection with checkboxes. Subscribe to any public ICS/webcal URL with per-subscription color and visibility. Recurring events support daily, weekly, monthly, and yearly frequencies. Overlapping timed events render side-by-side. Events support file attachments (images, PDFs, Office documents). |
| **Documents** | Upload and manage family files (PDF, images, Office documents up to 5 MB). Organize into custom folders with a sidebar browser. Grid/list view, drag-and-drop upload, 14 category tags (medical, school, identity, finance, and more), per-document visibility (family, selected members, private), archive and download. |
| **Budget** | Track income and expenses with recurring entries, monthly trends, and CSV export. 35 predefined categories plus custom ones. Supports 15 currencies. Loans tab for instalment-based loan tracking. **Split Expenses** tab for shared costs within groups — equal, percentage, exact-amount, and shares split methods, multi-currency support, immutable ledger, automatic debt simplification, and recurring expenses. |
| **Housekeeping** | Manage household staff workflows. Staff profiles with daily rate, calendar color, and payment schedule. Work session check-in/check-out with automatic calendar event creation and optional payment task. Recurring chore tracking with urgency decay indicators. Supply requests linked to shopping lists. Monthly visit log with payment summaries. |
| **Notes & Contacts** | Colored sticky notes with Markdown support. Contact directory with multi-account CardDAV sync (Nextcloud, iCloud, Radicale, Baikal), multiple phones/emails/addresses per contact, and vCard import/export. |
| **Birthdays** | Birthday tracker with automatic annual calendar events, age display, profile photos, and customizable reminder offsets (preset or fully custom interval). |
| **Reminders** | Time-based reminders on tasks and calendar events. In-app notification badge. |
| **Family** | Assign family roles, profile pictures, phone, email, and birthday per member. Family details are automatically synced to Contacts and Birthdays. |
| **API Tokens** | Named Bearer / X-API-Key tokens for external integrations. SHA-256-hashed at rest, with optional expiry. OpenAPI 3.0 spec at `/api/v1/openapi.json`. |
| **Backup** | Admin-only database backup and restore via the Settings UI. Download a snapshot or restore from a file upload with an automatic pre-restore rollback copy. Automatic scheduled backups (configurable schedule, rotation, retention). |

## Design & Technology

- **Liquid Glass UI** — translucent surfaces, backdrop blur, module-tinted overlays, spring animations — inspired by Apple's Liquid Glass, built in pure CSS
- **PWA** — installable on any device, works offline, dark mode, responsive from phone to desktop
- **Privacy First** — SQLCipher AES-256 encrypted database, fully self-hosted, zero telemetry
- **Zero Build Step** — pure ES modules, no bundler, no transpiler, no framework
- **Multilingual** — 16 languages with automatic locale detection (de, en, es, fr, it, sv, el, ru, tr, zh, ja, ar, hi, pt, uk, pl)

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

## Tech Stack

<p>
  <img src="https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/SQLite%20%2F%20SQLCipher-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Vanilla_JS_(ES_Modules)-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/Plain_CSS-1572B6?style=flat-square&logo=css3&logoColor=white" alt="CSS">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA">
</p>

## Documentation

| [Installation](docs/installation.md) | [Spec & Data Model](docs/SPEC.md) | [Contributing](CONTRIBUTING.md) | [Security](SECURITY.md) | [Changelog](CHANGELOG.md) | [Backlog](BACKLOG.md) |
|---|---|---|---|---|---|

## License

<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>

<div align="center">
  <sub>Built with care for families who value privacy and simplicity.</sub>
</div>
