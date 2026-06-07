---
name: deploy-targets
description: Keep every deploy descriptor (installer schema, Compose, Podman, Unraid, TrueNAS) in sync when env vars, ports, or volumes change
paths:
  - oikos/tools/installer/env-schema.js
  - oikos/.env.example
  - oikos/templates/oikos.xml
  - oikos/ca_profile.xml
  - oikos/docker-compose.yml
  - oikos/podman-compose.yml
  - oikos/docs/docker-compose.portainer.yml
  - oikos/tools/quadlet/oikos.container
  - oikos/deploy/truenas/**
  - oikos/deploy/umbrel/**
---

Oikos ships to several deploy targets that each describe env vars, ports and volumes **separately**. When a task adds, changes, or removes an **env var**, a **port**, or a **volume/mount**, keeping all applicable targets below in sync is **part of that task's definition of done** — do it inline, in the same task, before reporting it complete. Never defer it to a separate step, to `/docs-sync`, or to the user. (`docs-sync` and release-prep are only the release-time backstop.)

**Source of truth:** `tools/installer/env-schema.js`. Start there, then propagate outward. Its tests must stay green: `npm run test:installer-schema` and `npm run test:installer-env-write`.

### A new / changed / removed ENV VAR — update:

- **`tools/installer/env-schema.js`** — the canonical entry (key, type, default, `required`, secret/mask flag). This drives the web + CLI installer.
- **`.env.example`** — keep in lockstep with the schema (matching comment + default).
- **`templates/oikos.xml`** (Unraid CA) — add/edit/remove the matching `<Config ... Type="Variable">`. Unraid enumerates **every** variable by hand and has **no fallback**, so a missing entry means Unraid users cannot set it. Mask secrets with `Mask="true"`; put optional integrations on `Display="advanced"`, required ones on `Display="always"`.
- **Compose / Podman / Quadlet** — `docker-compose.yml`, `podman-compose.yml`, `docs/docker-compose.portainer.yml`, `tools/quadlet/oikos.container`: only when the var needs an explicit passthrough or default there. Follow the existing pattern in each file (most read from the environment / `.env`).
- **TrueNAS** — optional env vars need **no** change to `deploy/truenas/questions.yaml`: they are covered by the generic `additional_envs` list (TrueNAS library convention, and a safety net). Add an explicit question **only** for a new **required** secret (like `SESSION_SECRET`); when you do, also set the env in `deploy/truenas/templates/docker-compose.yaml`.
- **Umbrel** — `deploy/umbrel/docker-compose.yml`: only when the var needs an explicit passthrough or default (e.g. a new **required** secret that Umbrel can satisfy from `${APP_SEED}`/`${APP_PASSWORD}`). Optional integration vars need no change — Umbrel users set them via the app's own settings, not the compose. There is no Umbrel auto-bump bot: any change here only reaches the store via a **manual PR** to `getumbrel/umbrel-apps` (see `deploy/umbrel/README.md`).
- **Docs** — README / `docs/installation.md` / the `## Environment` list in `CLAUDE.md`: handled by `/docs-sync` at release time.

### A new / changed PORT or VOLUME/MOUNT — update **all** of these (no fallback anywhere):

- `docker-compose.yml`, `podman-compose.yml`, `docs/docker-compose.portainer.yml`, `tools/quadlet/oikos.container`.
- `templates/oikos.xml` — `<Config ... Type="Port">` or `Type="Path">`.
- `deploy/truenas/questions.yaml` (the storage / network group) **and** `deploy/truenas/templates/docker-compose.yaml` (the matching `add_storage` / `add_port`).
- `deploy/umbrel/docker-compose.yml` (volume under `${APP_DATA_DIR}`, or `app_proxy` `APP_PORT`) **and** `deploy/umbrel/umbrel-app.yml` (the external `port:` for a new port). Reaches the store only via a manual PR.
- A new volume also needs the directory created in `Dockerfile` (`mkdir -p`) and chowned in `entrypoint.sh` — check both.
- Keep the container's internal port (`3000`) and the mount paths (`/data`, `/backups`, `/app/modules`) **identical across every target**.

### TrueNAS specifics

Files under `deploy/truenas/` are the tracked **source** for the app's TrueNAS catalog config (install form + compose). The published catalog lives in the upstream `truenas/apps` community train and is updated two separate ways:

- **Version bumps are automatic.** TrueNAS's own Renovate bot (`truenasbot`) detects each new `ghcr.io/ulsklyc/oikos` image tag (published by `docker-publish.yml` on release) and opens a catalog-bump PR upstream. Nothing on our side is required — there is no generator and no version-templating anymore.
- **Config changes are not automatic.** A new **required secret**, **port**, or **volume** is not propagated by the bot. Edit `deploy/truenas/questions.yaml` / `templates/docker-compose.yaml` here as the source, then carry those edits to the upstream catalog via a manual PR to `truenas/apps`.
