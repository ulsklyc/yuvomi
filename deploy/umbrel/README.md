# Oikos — Umbrel App Store source

This folder is the **tracked source** for Oikos in the official Umbrel App Store
([`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps)). The files
here (`umbrel-app.yml`, `docker-compose.yml`) are copied verbatim into
`umbrel-apps/oikos/` when opening or updating the submission PR.

Unlike TrueNAS (whose `truenasbot` Renovate bot auto-bumps the catalog from the
GHCR image), **Umbrel has no auto-update bot for third-party apps**. Every Oikos
release that should reach Umbrel needs a **manual PR** to `getumbrel/umbrel-apps`
that bumps `version`, fills `releaseNotes`, and updates the pinned image digest.

## Per-release update checklist

1. Get the new multi-arch index digest after the image is published:
   ```bash
   docker buildx imagetools inspect ghcr.io/ulsklyc/oikos:<version>
   # use the top-level `Digest:` (the OCI image index), not a per-arch one
   ```
2. In `umbrel-app.yml`: bump `version`, write `releaseNotes`.
3. In `docker-compose.yml`: update the `web.image` tag **and** `@sha256:` digest.
4. Copy both files into a fork of `getumbrel/umbrel-apps` under `oikos/`, open a PR,
   fill the testing checklist, and paste the PR URL back into `submission:`.

## Config notes (why the compose looks like this)

- **`app_proxy`** is mandatory. Oikos has its own login, so `PROXY_AUTH_ADD: "false"`
  prevents a double sign-in. `APP_PORT: 3000` is where Oikos listens inside the
  container; the manifest `port:` (currently `8090`) is the external port Umbrel
  assigns — reviewers may change it to avoid conflicts.
- **`SESSION_SECRET=${APP_SEED}`** — Umbrel provides a deterministic per-app secret,
  so no interactive installer step is needed.
- **No `user:` override** — the image entrypoint runs as root only to chown the
  volumes, then drops to the unprivileged `node` user. The app never serves as root.
- **`SESSION_SECURE=false`** — Umbrel serves apps over plain HTTP on the LAN.
- Assets still to add to the store PR: a 256×256 SVG icon (no rounded corners) and
  3–5 gallery images at 1440×900 (`1.jpg`, `2.jpg`, `3.jpg`). The TrueNAS
  screenshots can be reused after reformatting.

## Local testing before submitting

Umbrel's PR flow expects you to test the app first. You do **not** need physical
hardware — umbrelOS runs in Docker via [`dockur/umbrel`](https://github.com/dockur/umbrel):

```bash
docker run -it --rm --name umbrel --pid=host -p 80:80 \
  -v "${PWD:-.}/umbrel:/data" \
  -v "/var/run/docker.sock:/var/run/docker.sock" \
  --stop-timeout 60 docker.io/dockurr/umbrel
```

Then open <http://localhost>, finish onboarding, and sideload Oikos **before it is
merged** via a temporary Community App Store:

1. Create a throwaway public git repo with this layout:
   ```
   umbrel-app-store.yml      # id: oikos-test, name: Oikos Test
   oikos/umbrel-app.yml      # copy of this folder's manifest
   oikos/docker-compose.yml  # copy of this folder's compose
   ```
2. In umbrelOS → App Store → "Community App Stores", add the repo URL.
3. Install Oikos, create the first account, then **restart the app** and confirm the
   calendar/tasks/budget data persisted (volumes under `${APP_DATA_DIR}`).

Once it runs and persists cleanly, open the PR against `getumbrel/umbrel-apps`.
