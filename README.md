<div align="center">
  <img src="docs/logo.svg" alt="" width="92" />

  <h1>Yuvomi</h1>

  <p><strong>One private home for everything that keeps a household running.</strong></p>

  <p>
    Tasks, calendar, budget, groceries, meals, health and more - for a family, a couple,
    or just you. Twenty modules for one household, usually two to six people, on a server you
    own, and out of the box the only thing that leaves it is a version check.
  </p>

  <p>
    <a href="https://github.com/ulsklyc/yuvomi/releases"><img src="https://img.shields.io/github/v/release/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=release" alt="Latest release"></a>
    <a href="https://github.com/ulsklyc/yuvomi/stargazers"><img src="https://img.shields.io/github/stars/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=stars" alt="GitHub stars"></a>
    <a href="https://github.com/ulsklyc/yuvomi/pkgs/container/yuvomi"><img src="https://img.shields.io/badge/ghcr.io-yuvomi-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker image"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
  </p>

  <p>
    <a href="#install"><strong>→ Install in minutes</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="https://yuvomi.cloud/"><strong>Screenshots &amp; tour</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="#documentation"><strong>Docs</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="CHANGELOG.md"><strong>Changelog</strong></a>
  </p>

  <sub><a href="README.de.md">Auf Deutsch lesen</a></sub>

  <br><br>

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dashboard-dark-web.webp">
    <img src="docs/screenshots/dashboard-light-web.webp" alt="The Yuvomi dashboard: today's tasks, calendar events, meals and the shopping list on one screen" width="820">
  </picture>

  <sub><b>20</b> modules&nbsp;&nbsp;·&nbsp; <b>24</b> languages&nbsp;&nbsp;·&nbsp; <b>0</b> trackers&nbsp;&nbsp;·&nbsp; optional&nbsp;<b>AES&#8209;256</b>&nbsp;database&nbsp;encryption&nbsp;&nbsp;·&nbsp; <b>MIT</b></sub>
</div>

Most households glue their life together from a dozen paid apps, each with its own account, its
own subscription and its own copy of your data on someone else's server. Yuvomi puts all of it in
one place that belongs to you, running as a container on any home server or NAS. Every module is
independent, so you use what fits and switch off what doesn't.

---

## One app instead of a dozen subscriptions

| Instead of juggling… | Yuvomi gives you |
|---|---|
| a to-do &amp; task app | **Tasks** - Kanban, deadlines, recurring, multi-assignment |
| a shared calendar subscription | **Calendar** - sync, subscriptions, per-event visibility |
| a cost-splitting app | **Shared expenses** - shared costs with debt simplification |
| a budgeting app | **Budget** - income, expenses, accounts, savings goals |
| a meal planner &amp; recipe app | **Meals &amp; Recipes** - weekly planner with shopping export |
| a grocery-list app | **Shopping** - shared, aisle-organized lists |
| a pantry &amp; expiry tracker | **Pantry** - stock, storage location, best-before dates |
| a document manager | **Documents** - tagged, searchable family files |
| a home-inventory app | **Inventory** - owned belongings, purchase price, warranty, linked receipts |
| a notes app &amp; contacts sync | **Notes &amp; Contacts** - Markdown notes, CardDAV sync |

## The modules talk to each other

This is the part a folder full of separate apps cannot do:

- **The week's meal plan writes the shopping list.** Plan Thursday, and the ingredients are on the list before anyone walks to the shop.
- **The last jar out of the pantry is already on the list.** Tick items off after a shop and they book back into the pantry with their quantity.
- **A ticked-off chore pays out.** Points on a task land on the assigned member's account, and the reward catalog spends them.
- **A filed receipt hangs on the booking.** Upload it once and it belongs to the transaction, the shared expense and the inventory item at the same time.

## The twenty modules

Turn on what your household needs; the rest stays out of the way.

| Module | In one line |
|---|---|
| **Tasks** | Kanban board with deadlines, subtasks, recurring chores, comments and a history of who ticked off what. |
| **Shopping** | Shared lists sorted by aisle, with swipe gestures and one-tap import from the meal plan. |
| **Meals** | Weekly drag-and-drop planner with a recipe sidebar and direct export to the shopping list. |
| **Recipes** | Create and scale recipes, fill meal slots, or mirror a Mealie or Tandoor instance read-only. |
| **Pantry** | Amounts, storage locations and best-before dates, with a reminder before something expires. |
| **Calendar** | Two-way Google and CalDAV sync, Outlook push, subscriptions, holidays and per-event visibility. |
| **Documents** | Tagged, searchable family files in folders, stored locally, on WebDAV or in Google Drive. |
| **Inventory** | What you own, with purchase price, warranty, linked receipts and deadline reminders. Off by default. |
| **Budget** | Income, expenses, accounts, loans, subscriptions and shared expenses with debt simplification. |
| **Housekeeping** | Household staff: schedules, check-in/out, billing, chores and supply requests. |
| **Waste collection** | Pickup schedules per waste type, even "the last Friday", or a subscribed municipal ICS calendar. Off by default. |
| **Rewards** | Points from tasks, a parent-approved catalog and an auditable ledger. |
| **Health** | Per-member vitals, medications, labs, activity and cycle tracking, with trend charts. |
| **Schedule** | Rotating shifts and fixed weekly timetables, shown as an overlay in the calendar. Off by default. |
| **Notes &amp; Contacts** | Markdown sticky notes with tappable checklists, plus contacts with CardDAV sync and vCard import/export. |
| **Birthdays** | Birthdays and optional name days, with calendar entries, ages and reminders. |
| **Family** | Member profiles with roles, and invite links where new members pick their own password. |
| **Reminders** | For tasks, events, warranties, best-before dates and pickups - in-app, push, Gotify, ntfy, webhook or email. |
| **API Tokens** | Bearer tokens with an OpenAPI 3.0 spec and a built-in MCP endpoint for AI agents. |
| **Backup** | Manual and scheduled backups with pre-restore rollback and optional cloud upload. |

Two more things you only get on your own server: **wall mode** turns the kitchen tablet into a
readable-from-across-the-room display, and an **Immich screensaver** rotates your own photos when
the screen goes idle. Every module in full detail is in the [spec](docs/SPEC.md); building your own
drop-in module - with its own dashboard widgets, permissions and translations - is covered in the
[module guide](MODULES.md).

---

## Before you commit

**What if this project stops?** Nothing changes on your machine. It is MIT-licensed and
self-hosted, and there is no server of ours anywhere in the path. The container you already pulled
keeps running exactly as it does today, with or without us.

**What if you want your data somewhere else?** Everything lives in one SQLite file on your own
disk, and copying it is the whole export, as long as documents are stored in the database.
Scheduled backups write a restorable archive on top of that, and the documented API pulls anything
out in whatever shape you need.

**What does it cost?** Nothing. Yuvomi is free and MIT-licensed. You provide the server; there is
no subscription, no upsell and no paid tier.

---

## Install

Pick your way in: [Docker or Podman](#docker-or-podman) for full control, the
[guided setup](#guided-setup) wizard in your browser, or your [NAS app store](#from-your-nas-app-store)
without a terminal.

- **Image** - `ghcr.io/ulsklyc/`<wbr>`yuvomi:latest`, about 500 MB.
- **Needs** - 256 MB RAM and one port, 3000 by default.
- **Writes** - four volumes you own: data, backups, modules, documents.
- **Outbound** - out of the box, one update check against the GitHub releases API. Block it and nothing breaks, only the hint about a newer version stays away. Opening the calendar settings loads the list of holiday countries from openholidaysapi.org. Weather, public holidays, calendar and contact sync, push and notification channels, cloud storage and backup reach out only once you switch them on.
- **Your LAN** - calendar subscriptions, WebDAV storage and recipe mirrors on private or internal addresses stay blocked until you opt in ([how](docs/installation.md#environment-variables)).
- **Encryption key** - optional, but there is no way back: a lost or changed key never opens the database again, not by you and not by us. The guided setup and Umbrel generate one for you; with Compose, TrueNAS or Unraid you set it yourself, so write it down.
- **Your data** - one SQLite file at `/data/yuvomi.db`, plus the folder, WebDAV or Drive if you moved documents there.

### Docker or Podman

On Podman, fetch `podman-compose.yml` instead of `docker-compose.yml` and start it with
`podman compose -f podman-compose.yml up -d`; it carries the SELinux `:Z` volume labels that
RHEL, Fedora and CentOS Stream need.

```bash
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/.env.example
cp .env.example .env
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # DB_ENCRYPTION_KEY
```

> **Now open `.env` and replace both `REPLACE_WITH_…` placeholders** with the two values you just
> generated, in that order, and write the second one down: it is the database key, and nothing can
> recover it. To run without encryption, clear the line instead of filling it.

```bash
docker compose up -d
```

Open `http://localhost:3000`. The first visit walks you through creating your admin account. If the
page does not load, `docker compose logs` (on Podman, `podman compose -f podman-compose.yml logs`)
usually names the reason, and the
[troubleshooting guide](docs/installation.md#troubleshooting) covers the common ones.

### Guided setup

A setup wizard in your browser, in 24 languages. It detects Docker or Podman, configures HTTPS,
single sign-on and scheduled backups, then starts the container and creates your admin account.

```bash
git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
node tools/installer/install-server.js
```

Open **http://localhost:8090**. Needs Node.js 22+ on the host; the container ships its own Node 24.

### From your NAS app store

**TrueNAS SCALE**, **Umbrel** and **Unraid** all carry Yuvomi: search for it in the app catalog and
install, no terminal required. New to containers? The **[installation guide](docs/installation.md)**
covers engine setup, HTTPS, backups and troubleshooting step by step.

<details>
<summary><b>Before you go live: health data, Google Drive sharing and GDPR</b></summary>

<br>

> **Health is not a medical device.** No diagnostic claims are made. Health data is sensitive, so enable database encryption (`DB_ENCRYPTION_KEY`, SQLCipher).

> **External document storage needs its own backup.** Database backups hold document metadata and links, not binaries stored in a local folder, on WebDAV, or in Google Drive; back up the selected target separately. Yuvomi visibility settings only control access through Yuvomi. Anyone with access to the connected `Yuvomi/Documents` Google Drive folder can view all files stored there.

> **Self-hosting in a GDPR context?** If you run Yuvomi in the EU/EEA and process other people's data, read [privacy for self-hosters](docs/PRIVACY-FOR-SELFHOSTERS.md) before going live. It covers third-country assessments for every external service, data-processing-agreement notes, log-retention guidance and a records-of-processing template.

</details>

<details>
<summary>Coming from <b>Oikos</b>, or seeing <code>oikos</code> in an app store? Same app, renamed.</summary>

<br>

Yuvomi was renamed from **Oikos** to avoid a trademark conflict with an unrelated product. Same code, same data, same maintainer.

- Old links (`github.com/ulsklyc/oikos`) redirect here automatically.
- The Docker image moved to `ghcr.io/ulsklyc/yuvomi`; the old `ghcr.io/ulsklyc/oikos` keeps working, so update at your convenience.
- Existing data and settings are fully preserved on upgrade.
- Some catalog slugs keep the technical name `oikos` (e.g. Unraid `oikos-…`) so existing installations upgrade seamlessly. Search for **Yuvomi**; an entry still shown as *oikos* is the same app.

</details>

---

## Under the hood

- **No build step** - pure ES modules and plain CSS. No bundler, no transpiler, no framework, no runtime CDN.
- **Apple HIG in the Liquid Glass language** - the system font stack and Apple's type scale, capsule controls, inset-grouped lists and spring motion, verified for WCAG AA in light and dark.
- **Privacy first** - fully self-hosted, optional SQLCipher AES-256 database encryption, zero telemetry.
- **Sign-in that scales to a household** - optional two-factor authentication (TOTP with recovery codes, enforceable household-wide), invite links instead of handed-over passwords, and optional self-service password reset by email. Optional single sign-on works with any OIDC provider. One switch decides whether an unknown identity gets an account, so a provider shared beyond your household opens no door, and another makes SSO the only way in.
- **24 languages** with automatic detection. A separate household setting decides the language of entries Yuvomi creates itself, so an exported calendar speaks your household's language instead of English.

<p align="center">
  <img src="https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/SQLite%20%2F%20SQLCipher-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite / SQLCipher">
  <img src="https://img.shields.io/badge/Vanilla_JS_(ES_Modules)-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/Plain_CSS-1572B6?style=flat-square&logo=css3&logoColor=white" alt="Plain CSS">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/Podman-892CA0?style=flat-square&logo=podman&logoColor=white" alt="Podman">
  <img src="https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA">
</p>

---

## Documentation

- **Run it** - [Installation](docs/installation.md)&nbsp;&nbsp;·&nbsp; [Security](SECURITY.md)&nbsp;&nbsp;·&nbsp; [Privacy for self-hosters](docs/PRIVACY-FOR-SELFHOSTERS.md)&nbsp;&nbsp;·&nbsp; [Notification webhooks](docs/notification-webhooks.md)&nbsp;&nbsp;·&nbsp; [Immich screensaver](docs/immich-screensaver.md)
- **Build on it** - [Spec &amp; data model](docs/SPEC.md)&nbsp;&nbsp;·&nbsp; [Third-party modules](MODULES.md)&nbsp;&nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)
- **Follow the project** - [Changelog](CHANGELOG.md)&nbsp;&nbsp;·&nbsp; [Roadmap](docs/ROADMAP.md)&nbsp;&nbsp;·&nbsp; [Decisions](docs/DECISIONS.md)&nbsp;&nbsp;·&nbsp; [Scope](docs/SCOPE.md)&nbsp;&nbsp;·&nbsp; [Backlog](BACKLOG.md)&nbsp;&nbsp;·&nbsp; [Releasing](docs/RELEASING.md)

**User guide (community-maintained):** @Kyrodan writes a [user documentation site](https://kyrodan.github.io/yuvomi-docs/)
in his own repository. It is not part of this project and can lag behind a release, so where it and
the sources above disagree, the ones above are right.

---

<div align="center">
  <br>
  <img src="docs/logo.svg" alt="" width="48" />
  <p><strong>One home for your household. Yours to keep.</strong></p>
  <p>
    Install it once. No account with us, no subscription,<br>
    and nothing of ours between your household and its data.
  </p>
  <p>
    <a href="#install"><strong>→ Install in minutes</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="https://github.com/ulsklyc/yuvomi/discussions"><strong>Ask a question</strong></a>
  </p>
  <br>
  <sub>MIT licensed, see <a href="LICENSE">LICENSE</a>.</sub>
</div>
