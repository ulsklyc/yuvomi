<div align="center">
  <img src="docs/logo.svg" alt="Yuvomi logo" width="92" />

  <h1>Yuvomi</h1>

  <p><strong>The self-hosted family planner.<br>One home instead of many subscriptions.</strong></p>

  <p>
    Tasks, calendar, budget, meals, health and more for a family, a couple or just you, on a
    server you own. Out of the box, only a version check leaves it.
  </p>

  <p>
    <a href="https://github.com/ulsklyc/yuvomi/releases"><img src="https://img.shields.io/github/v/release/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=release" alt="Latest release"></a>
    <a href="https://github.com/ulsklyc/yuvomi/stargazers"><img src="https://img.shields.io/github/stars/ulsklyc/yuvomi?style=flat-square&color=6C3AED&label=stars" alt="GitHub stars"></a>
    <a href="https://github.com/ulsklyc/yuvomi/pkgs/container/yuvomi"><img src="https://img.shields.io/badge/ghcr.io-yuvomi-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker image"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
  </p>

  <p>
    <a href="https://yuvomi.cloud/"><strong>→ Take the tour on yuvomi.cloud</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="#install"><strong>Install&nbsp;in&nbsp;minutes</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="#documentation"><strong>Docs</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="CHANGELOG.md"><strong>Changelog</strong></a>
  </p>

  <sub><a href="README.de.md">Auf Deutsch lesen</a></sub>

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dashboard-dark-web.webp">
    <img src="docs/screenshots/dashboard-light-web.webp" alt="The Yuvomi overview: today's events, tasks and shopping for the whole family, with the family, budget and birthdays below" width="820">
  </picture>

  <sub><b>20</b> modules&nbsp;&nbsp;·&nbsp; <b>25</b> languages&nbsp;&nbsp;·&nbsp; <b>0</b> trackers&nbsp;&nbsp;·&nbsp; optional&nbsp;<b>AES&#8209;256</b>&nbsp;database&nbsp;encryption</sub>
</div>

Most households glue their life together from a dozen paid apps, each with its own account, its
own subscription and its own copy of your data on someone else's server. Yuvomi puts all of it in
one place that belongs to you, running as a container on any home server or NAS.

---

## Many apps, one place

| Instead of juggling… | Yuvomi gives you |
|---|---|
| a to-do &amp; task app | **Tasks** - Kanban, deadlines, recurring, multi-assignment |
| a family calendar app | **Calendar** - sync, subscriptions, per-event visibility |
| a meal planner &amp; recipe app | **Meals &amp; Recipes** - weekly planner with shopping export |
| a grocery-list app | **Shopping** - shared, aisle-organized lists |
| a budgeting &amp; cost-splitting app | **Budget** - income, expenses, accounts, savings goals, shared costs with debt simplification |
| a document manager | **Documents** - searchable family files in folders |

## The modules talk to each other

This is the part a folder full of separate apps cannot do:

- **One import turns the week's meal plan into a shopping list.** The next seven days come pre-selected, and every ingredient lands on the shared list, sorted by aisle.
- **The last jar out of the pantry goes on the list with one tap.** After the shop, one button books what you ticked off back into the pantry, with amount and unit.
- **A ticked-off chore pays out.** Points on a task go to whoever did it - the assignee, or the person picked when it is ticked off - and are spent in a reward catalog you control.
- **A filed receipt hangs on the booking.** Upload it once and it belongs to the transaction, the shared expense and the inventory item at the same time.

## On the kitchen wall, in every pocket

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dashboard-wall-dark-web.webp">
    <img src="docs/screenshots/dashboard-wall-light-web.webp" alt="Yuvomi wall mode on a landscape tablet: the time in large type, today's tasks and doses, who is up today, the weather and one-tap kitchen timers" width="720">
  </picture>
</div>

- **The tablet on the kitchen wall** shows today's plan and who is up in wall mode, readable across the room. It has an account of its own: tap a task, pick who did it, and the points go to them. When it sits idle, an Immich screensaver can show your own photos.
- **The app on every phone** goes on the home screen straight from the browser, no app store. Reminders arrive as push notifications even while it is closed (your server needs HTTPS for that), and the last shopping list you opened stays readable without signal.
- **Every member joins by invite link** and picks their own password; a child without a phone gets an account created directly. Per family role, each module is full, read only or not at all.

[More on yuvomi.cloud](https://yuvomi.cloud/#family)

## The twenty modules

Switch off what your household doesn't need, and it disappears from everyone's menu. Inventory,
Waste collection and Schedule start switched off.

- **Plan** - Tasks · Calendar · Schedule · Notes
- **Household** - Meals · Recipes · Shopping · Pantry · Housekeeping · Waste collection · Documents · Inventory · Rewards
- **People** - Health · Contacts · Birthdays
- **Finance** - Budget
- **Settings** - Family · Reminders · API Tokens · Backup

<details>
<summary><b>Every module in one line</b></summary>

| Module | In one line |
|---|---|
| **Tasks** | Kanban board with deadlines, subtasks, recurring chores, comments and a history of who ticked off what. |
| **Shopping** | Shared lists sorted by aisle, with swipe gestures and an import from the meal plan. |
| **Meals** | Weekly drag-and-drop planner with a recipe sidebar and direct export to the shopping list. |
| **Recipes** | Create and scale recipes, fill meal slots, or mirror a Mealie or Tandoor instance read-only. |
| **Pantry** | Amounts, storage locations and best-before dates, with a reminder before something expires. |
| **Calendar** | Two-way Google and CalDAV sync, Outlook push, subscriptions, holidays and per-event visibility. |
| **Documents** | Searchable family files in folders, stored locally, on WebDAV or in Google Drive. |
| **Inventory** | What you own, with purchase price, warranty, linked receipts, a service log and recurring deadline reminders. Off by default. |
| **Budget** | Income, expenses, accounts, loans, subscriptions and shared expenses with debt simplification. |
| **Housekeeping** | Household staff: schedules, check-in/out, billing, chores and supply requests. |
| **Waste collection** | Pickup schedules per waste type, even "the last Friday", or a subscribed municipal ICS calendar. Off by default. |
| **Rewards** | Points from tasks, a parent-approved catalog and an auditable ledger. |
| **Health** | Per-member vitals, medications, preventive care, labs, activity, cycle tracking, a fasting journal and a nutrition log, with trend charts. |
| **Schedule** | Rotating shifts and fixed weekly timetables, shown as an overlay in the calendar. Off by default. |
| **Notes &amp; Contacts** | Markdown sticky notes with tappable checklists, plus contacts with CardDAV sync and vCard import/export. |
| **Birthdays** | Birthdays and optional name days, with calendar entries, ages and reminders. |
| **Family** | Member profiles with roles, and invite links where new members pick their own password. |
| **Reminders** | For tasks, events, medications, warranties, best-before dates, expiring documents and pickups - in-app, push, Gotify, ntfy, webhook or email. |
| **API Tokens** | Bearer tokens with an OpenAPI 3.1 spec and a built-in MCP endpoint for AI agents. |
| **Backup** | Manual and scheduled backups with optional WebDAV upload and pre-restore rollback; a backup from another installation restores right in the browser. |

</details>

Every module in full detail is in the [spec](docs/SPEC.md); building your own drop-in module - with
its own dashboard widgets, permissions and translations - is covered in the [module guide](MODULES.md).

---

## Before you commit

**What if this project stops?** Nothing changes on your machine. It is MIT-licensed and
self-hosted, and there is no server of ours anywhere in the path. The container you already pulled
keeps running exactly as it does today, with or without us.

**What if you want your data somewhere else?** Everything lives in one SQLite file on your own
disk, and copying it is the whole export, as long as documents are stored in the database.
Scheduled backups write a restorable archive on top of that, and the documented API pulls anything
out in whatever shape you need.

**How safe is access from outside?** Every account can add a second factor (TOTP, with recovery
codes), and an admin can require it for the whole household; new members join through an invite
link and pick their own password. With single sign-on through an OIDC provider, password login can
be switched off for the household, and a lost phone is signed out from any of your other devices.

**What does it cost?** Nothing. Yuvomi is free and MIT-licensed. You provide the server; there is
no subscription, no upsell and no paid tier.

---

## Install

Pick your way in: [Docker or Podman](#docker-or-podman) for full control, the
[guided setup](#guided-setup) wizard in your browser, or your [NAS app store](#from-your-nas-app-store)
without a terminal.

- **Image** - `ghcr.io/ulsklyc/`<wbr>`yuvomi:latest`, about 500 MB, for amd64 and arm64 (Raspberry Pi 4/5).
- **Needs** - 256 MB RAM and one port, 3000 by default.
- **Encryption key** - optional, but there is no way back: a lost or changed key never opens the database again, not by you and not by us. The guided setup and Umbrel generate one for you; with Compose, TrueNAS or Unraid you set it yourself, so write it down.

<details>
<summary><b>Requirements, network and your data</b></summary>

- **Browsers** - everything as designed from Chrome and Edge 117, Firefox 129 and Safari 17.5. Down to Chrome 87, Firefox 79 and Safari 14.1 (iOS 14.5) it still starts and scrolls, with a plainer look and some features missing ([measured 21 September 2026](docs/installation.md#browser-support)).
- **Writes** - four volumes you own: data, backups, modules, documents.
- **Outbound** - out of the box, one update check against the GitHub releases API. Block it and nothing breaks, only the hint about a newer version stays away. Everything else reaches out only when you use or switch on a feature that needs it: opening the calendar settings loads the list of holiday countries from openholidaysapi.org, finding a logo for a subscription looks up the service's website, and weather, public holidays, exchange rates, calendar and contact sync, recipe mirrors, Immich, Paperless or Papra, push and notification channels, cloud storage and backup connect once you switch them on.
- **Your LAN** - calendar subscriptions, notification channels (webhook, Gotify, ntfy), WebDAV document storage, recipe mirrors and waste-collection feeds on private or internal addresses stay blocked until you opt in ([how](docs/installation.md#environment-variables)). Paperless and Papra are the exception: they may reach the LAN out of the box.
- **Your data** - one SQLite file at `/data/yuvomi.db`, plus the folder, WebDAV or Drive if you moved documents there.

</details>

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
> recover it. With a placeholder left in, Yuvomi refuses to start. To run without encryption, clear
> the `DB_ENCRYPTION_KEY` line instead of filling it.

```bash
docker compose up -d
```

Open `http://localhost:3000`. The first visit walks you through creating your admin account. If the
page does not load, `docker compose logs` (on Podman, `podman compose -f podman-compose.yml logs`)
usually names the reason, and the
[troubleshooting guide](docs/installation.md#troubleshooting) covers the common ones.

On **Proxmox**, the same steps run inside a small Debian LXC: see the
[Proxmox guide on yuvomi.cloud](https://yuvomi.cloud/install.html#proxmox).

### Guided setup

A setup wizard in your browser, in 25 languages. It detects Docker or Podman, sets up single sign-on
and scheduled backups, prepares Yuvomi for an HTTPS reverse proxy (the certificate stays with your
proxy), then starts the container and creates your admin account.

```bash
git clone https://github.com/ulsklyc/yuvomi.git && cd yuvomi
node tools/installer/install-server.js
```

Open **http://localhost:8090** on the server itself; the wizard answers nowhere else. From another
device, open a tunnel first, `ssh -L 8090:localhost:8090 user@server`, then open the same address
there. Needs Node.js 22+ on the host; the container ships its own Node 24.

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
- **Sign-in for a whole household** - two-factor authentication, invite links, optional password reset by email and single sign-on with any OIDC provider; see [how safe access from outside is](#before-you-commit).
- **25 languages** with automatic detection. A separate household setting decides the language of entries Yuvomi creates itself, so an exported calendar speaks your household's language instead of English.

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

- **See it** - [Tour and screenshots on yuvomi.cloud](https://yuvomi.cloud/)&nbsp;&nbsp;·&nbsp; [Install guide on yuvomi.cloud](https://yuvomi.cloud/install.html)
- **Run it** - [Installation](docs/installation.md)&nbsp;&nbsp;·&nbsp; [Security](SECURITY.md)&nbsp;&nbsp;·&nbsp; [Privacy for self-hosters](docs/PRIVACY-FOR-SELFHOSTERS.md)&nbsp;&nbsp;·&nbsp; [Notification webhooks](docs/notification-webhooks.md)&nbsp;&nbsp;·&nbsp; [Immich screensaver](docs/immich-screensaver.md)
- **Build on it** - [Spec &amp; data model](docs/SPEC.md)&nbsp;&nbsp;·&nbsp; [Third-party modules](MODULES.md)&nbsp;&nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)
- **Follow the project** - [Changelog](CHANGELOG.md)&nbsp;&nbsp;·&nbsp; [Roadmap](docs/ROADMAP.md)&nbsp;&nbsp;·&nbsp; [Decisions](docs/DECISIONS.md)&nbsp;&nbsp;·&nbsp; [Scope](docs/SCOPE.md)&nbsp;&nbsp;·&nbsp; [Backlog](BACKLOG.md)&nbsp;&nbsp;·&nbsp; [Releasing](docs/RELEASING.md)

**User guide (community-maintained):** @Kyrodan writes a [user documentation site](https://kyrodan.github.io/yuvomi-docs/)
in his own repository. It is not part of this project and can lag behind a release, so where it and
the sources above disagree, the ones above are right.

---

<div align="center">
  <br>
  <img src="docs/logo.svg" alt="Yuvomi logo" width="48" />
  <p><strong>One home for your household. Yours to keep.</strong></p>
  <p>
    Install it once. No account with us, no subscription,<br>
    and nothing of ours between your household and its data.
  </p>
  <p>
    <a href="#install"><strong>→ Install in minutes</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="https://yuvomi.cloud/"><strong>Take the tour</strong></a>&nbsp;&nbsp;·&nbsp;
    <a href="https://github.com/ulsklyc/yuvomi/discussions"><strong>Ask a question</strong></a>
  </p>
  <br>
  <sub>MIT licensed, see <a href="LICENSE">LICENSE</a>. More at <a href="https://yuvomi.cloud/">yuvomi.cloud</a>.</sub>
</div>
