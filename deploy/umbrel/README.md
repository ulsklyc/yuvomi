# Oikos — Umbrel App Store source

This folder is the **tracked source** for the Oikos entry in the official Umbrel
App Store ([`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps)).
The initial submission was opened as `getumbrel/umbrel-apps#5732` (manifest +
compose only — Umbrel's app folder holds no images).

Unlike TrueNAS (whose `truenasbot` Renovate bot auto-bumps the catalog from the
GHCR image), **Umbrel has no auto-update bot for third-party apps**. We replace
that with our own workflow.

## Releases are automated

`.github/workflows/umbrel-publish.yml` runs on `release: published`. It resolves
the new multi-arch index digest and opens/updates a single rolling `oikos-update`
PR to `getumbrel/umbrel-apps`, editing the maintainers' upstream files **in
place** (`version`, `releaseNotes` from the release body, `@sha256` image digest)
so any review tweaks (port, gallery, category) are preserved. It needs the
`UMBREL_FORK_TOKEN` secret and stays dormant until #5732 is merged.

Manual fallback (if you ever need it): run the workflow via `workflow_dispatch`,
or get the digest with
`docker buildx imagetools inspect ghcr.io/ulsklyc/oikos:<version>` (top-level
`Digest:`) and bump `version`/`@sha256:` in a fork PR by hand.

## Config notes (why the compose looks like this)

- **`app_proxy`** is mandatory. Oikos has its own login, so `PROXY_AUTH_ADD: "false"`
  prevents a double sign-in. `APP_PORT: 3000` is where Oikos listens inside the
  container; the manifest `port:` is `8181` — a free port (the linter rejects
  collisions; 8090 was taken by Urbit). Reviewers may still reassign it.
- **`SESSION_SECRET=${APP_SEED}`** — Umbrel provides a deterministic per-app secret,
  so no interactive installer step is needed.
- **No `user:` override** — the image entrypoint runs as root only to chown the
  volumes, then drops to the unprivileged `node` user. The app never serves as root.
  (The linter flags this as info-level only.)
- **`SESSION_SECURE=false`** — Umbrel serves apps over plain HTTP on the LAN.
- **`gallery` and icon:** the manifest `gallery` field must be **empty** for
  submission — the Umbrel team populates it. The assets themselves (256×256 square
  `icon.svg` + five 1440×900 screenshots in `gallery/`) were submitted to the
  gallery repo as `getumbrel/umbrel-apps-gallery#90`.

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
