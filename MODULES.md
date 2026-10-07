# Yuvomi Modules

Yuvomi loads third-party modules from the repository-level `modules/` directory. Each module lives in its own folder and must include a `module.json` manifest. Modules are separate code: do not edit Yuvomi core files to install one.

## Folder Layout

```text
modules/
  example-module/
    module.json
    index.js
    style.css
```

The folder name must match the manifest `id`. A module installed from Settings gets its folder named after the `id` automatically (see [Installing From Settings](#installing-from-settings)), so the folder in a repository or archive may be called anything.

## Manifest

```json
{
  "manifestVersion": 1,
  "id": "example-module",
  "name": "Example Module",
  "version": "1.0.0",
  "description": "Adds a small page to Yuvomi.",
  "entry": "index.js",
  "style": "style.css",
  "icon": "box",
  "accent": "#6366F1",
  "menu": {
    "show": true,
    "label": "Example",
    "icon": "box",
    "order": 100
  },
  "page": {
    "composition": "reading",
    "width": "reading",
    "navigation": "standard",
    "responsive": "standard"
  }
}
```

Required fields:

- `id`: lowercase letters, numbers and hyphens only, 3 to 64 characters, starting and ending with a letter or number. Must match the module folder.
- `entry`: a relative `.js` file exporting a `render(container, context)` function.

Optional fields:

- `style`: a relative `.css` file loaded only for this module page.
- `menu.show`: set to `false` if the module should not appear in the left menu.
- `menu.label`, `menu.icon`, `menu.order`: left-menu label, Lucide icon name, and order.
- `accent`: a `#RRGGBB` color. It is your module's **tone**: the app exposes it as
  `--active-module-accent` while your page is open, so your own content can use it, and it colors
  the browser/PWA status bar on your route. It also fills your module's mark wherever the app names
  your module next to others - the navigation, the settings module list - at full strength; a mark
  that names something carries its color rather than a tint of it (see the full-tone rule in
  `DESIGN.md`). Since v2.2.0 it no longer colors the app's chrome -
  the navigation, the action button and shared controls carry the app's own accent in every module
  (see the one-voice rule in `docs/SPEC.md`), so the frame does not change color when a visitor
  opens your page. Pick a tone that reads against both a light and a dark surface: the mark is
  filled with it and carries a light or dark glyph on top.
- `page.composition`: one of `reading` | `data` | `dashboard` | `form` | `split` | `full`
  (see [`docs/PAGE-COMPOSITION.md`](docs/PAGE-COMPOSITION.md)). The app applies it: the
  `container` your `render()` receives is the `.app-page--<composition>` root, with the page
  measure set. Declare intent; do not invent page width, gutters, or breakpoints. Build the
  header and body with `/utils/page-layout.js`.
- `page.width`: semantic width (`reading` | `content` | `wide`); defaults from composition and
  refines the measure inside `reading`, `form`, `data` and `dashboard`. `split` and `full` own
  their width and ignore it. In `split`, the first two children of the body are the master and
  detail rails once the page is 768px wide (stacked below; the page is measured, not the
  viewport, so the sidebar does not fool it), and the body carries the page gutter like the
  measured modes; `full` and `split` roots take the shell height, so a body section can scroll
  internally without your CSS sizing the page. `full` is the one mode whose body has no gutter.
- `page.navigation` / `page.responsive`: currently `standard` only.

## Client Entry

```js
import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { renderPageHeader, renderPageTitle, renderPageBody, renderPageSection } from '/utils/page-layout.js';

export async function render(container, context) {
  // `container` already is your page root: the app has wrapped it in the
  // composition you declared in module.json (`.app-page.app-page--reading`,
  // `--page-measure` set). Render the header and the body into it; do not
  // call renderAppPage() yourself, that would nest a second page root.
  const me = await api.get('/auth/me');
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend',
    renderPageHeader({ title: renderPageTitle('Example Module') })
    + renderPageBody({
      content: renderPageSection({
        content: `<p>Hello, ${esc(me.user.display_name)}</p>`,
      }),
    }));
}
```

`context` carries `user`, `page` and `signal`. `page` is the normalized declaration from your manifest (`composition`, `width`, `navigation`, `responsive`), so a module can branch on it without reading `module.json` a second time. `signal` is an `AbortSignal` the router aborts as soon as the user leaves your page: pass it to every `addEventListener` (`{ signal }`) and clear timers on its `abort` event, and check `signal.aborted` after each `await` before touching the DOM. Without that, a page keeps polling and re-rendering into a container that is no longer on screen.

Modules may import public Yuvomi browser libraries such as `/api.js`, `/i18n.js`, and utilities under `/utils/`. For calls to Yuvomi's built-in REST API, prefer `import { api } from '/api.js'`: it prefixes requests with `/api/v1`, sends the current session credentials, handles CSRF tokens, and uses non-cached fetches for user data.

If a module calls a separate backend service through a reverse proxy, expose that service on a same-origin `/api/...` path whenever the response is dynamic. Yuvomi's service worker deliberately bypasses `/api/` requests, while other same-origin GET requests may be handled by the app-shell caching strategy. A dynamic proxy path such as `/ext/myservice/...` can therefore return stale cached responses unless you also change the service-worker strategy.

Modules must follow the same frontend security rules as core Yuvomi:

- Use `replaceChildren()` and `insertAdjacentHTML()`.
- Escape untrusted values before inserting HTML.
- Do not use external CDNs.
- Do not use `innerHTML`.
- Do not bypass authentication, authorization, CSRF, or CSP.

## Modules With A Backend Service

A module page is browser code with no server of its own. When a module needs stored state, scheduled work, or a third-party credential, run that as a separate service beside Yuvomi rather than as a patch to core, and leave Yuvomi on its official image. What follows is what such a module needs in order to survive a Yuvomi upgrade.

Serve the service from the same origin under `/api/extensions/<module-id>/`. That path is required, not a convention: `capabilities.api.prefix` is rejected unless it is exactly `/api/extensions/<module-id>`, so an extension cannot take over a core API prefix. Browser requests then carry the Yuvomi session cookie, and the service worker leaves them alone. The stale-cache trap described above applies to any dynamic path outside `/api/`.

Do not open `yuvomi.db`. It is core's private storage: the schema changes between releases without notice, and a second writer breaks Yuvomi's own migrations. Read and write through `/api/v1` instead. If the data a module needs is not reachable through the API, that is a missing endpoint worth an issue, not a reason to reach for the file.

Re-check identity on the server for every request. Forward the incoming Yuvomi session cookie to `GET /api/v1/auth/me` over the internal Yuvomi URL, and trust only that response for the user id, role, and permissions. The browser half of a module is not a trusted caller: never accept a user id or role from a request body.

Cache that answer briefly rather than resolving it on every call. Yuvomi rate-limits `/api/` to 300 requests per minute per IP, and a service that does not forward the caller's address spends that budget from its own container IP for all of its users at once - the first symptom is a `429` for everyone. A few seconds of cache keyed on the session cookie is enough, and short enough that a logout still takes effect.

Yuvomi's CSRF token protects Yuvomi's endpoints, not a module's. State-changing routes on the service should independently require:

- a valid Yuvomi session, verified as above;
- an `Origin` matching the public host;
- the service's own double-submit CSRF cookie and header pair;
- an endpoint-specific role or ownership check.

Scheduled jobs have no session. Issue an API token under Settings -> Household -> API access (admin-only, so a module that needs one has to ask the household's admin for it) with only the scopes the module needs - for core modules `budget:read` and `budget:write`, for extension modules `ext:<module-id>:read` / `:write` - and keep it in the service's secrets, never in the module folder, a Compose file, or browser storage. Keep the service's own state in the service's own database, and treat stored secrets as write-only: expose `has_api_token: true`, never a fragment of the token itself.

When your module declares `capabilities.api.prefix`, enforce household permissions on the sidecar: after resolving the session through `GET /api/v1/auth/me`, deny requests when `permissions.modules['ext:<module-id>'] === 'none'`, and treat `'read'` as read-only for mutating routes.

## Capabilities (permissions, widgets, API)

Optional `capabilities` block in `module.json` registers your module with the same permission and dashboard surfaces core modules use.

```json
{
  "menu": {
    "label": "My Module",
    "labelKey": "menu"
  },
  "capabilities": {
    "permissions": {
      "module": { "label": "My Module", "labelKey": "module", "icon": "box" },
      "widgets": [{ "id": "summary", "label": "Summary tile" }]
    },
    "widgets": [{
      "id": "summary",
      "entry": "widgets/summary.js",
      "label": "Summary tile",
      "labelKey": "widgets.summary",
      "icon": "box",
      "defaultSize": "1x2",
      "defaultVisible": false,
      "optionsSchema": {
        "compact": { "type": "boolean", "title": "Compact mode", "titleKey": "options.compact", "default": false }
      }
    }],
    "api": { "prefix": "/api/extensions/my-module" }
  }
}
```

### Localization

Third-party modules integrate with the same `t('key')` helper as core UI (`import { t } from '/i18n.js'`).

**Supported languages:** the same 26 locales as Yuvomi core (`getSupportedLocales()` / files under `public/locales/`). You may ship all of them, a subset, or only your default - the runtime never shows raw i18n keys in shell UI.

**Ship translation files** under `locales/{locale}.json` in your module folder (for example `locales/de.json`, `locales/en.json`, `locales/ru.json`). Yuvomi scans that folder at module load and exposes metadata on `GET /api/v1/modules`:

```json
"i18n": {
  "defaultLocale": "en",
  "availableLocales": ["de", "en", "ru"],
  "coreLocales": ["ar", "cs", "de", "en", "..."]
}
```

Declare the fallback language in `module.json`:

```json
"i18n": { "defaultLocale": "en" }
```

If omitted, `en` is used. The file `locales/{defaultLocale}.json` should exist whenever you use `labelKey` - it is the last resort before static `label` / `title` strings from the manifest.

**Lookup order** for `extensions.<module-id>.*` keys (and for shell labels via `labelKey`):

1. User's current UI locale (if your module ships that file)
2. Module `i18n.defaultLocale`
3. `en`
4. `de` (core reference locale)
5. Static `label` / `title` from `module.json`

Use flat keys in locale files:

```json
{
  "menu": "My Module",
  "module": "My Module",
  "widgets.summary": "Summary tile",
  "options.compact": "Compact mode"
}
```

In `module.json`, reference them with short `labelKey` / `titleKey` values (`"menu"`, `"widgets.summary"`) or full paths (`extensions.my-module.menu`). Inside your module JavaScript, call `t('extensions.my-module.your.key')` for any other strings.

Core shell surfaces (navigation, dashboard widget chrome, permissions admin, API token scopes) resolve extension labels automatically. Core UI chrome (`common.save`, `nav.settings`, …) still comes from Yuvomi's own locale files.

Rules:

- `manifestVersion` declares the **format** your manifest is written in, not the version of your module (that is `version`). It is an integer; this Yuvomi reads up to **1**. Omit it and 1 is assumed, so manifests written before this field keep working. A manifest declaring a *higher* version is rejected outright rather than read in part: loading it halfway would mean silently ignoring fields it considers essential, and the operator would see a module that runs and does something other than what it says. The error names both numbers.
- **What a version bump means for you:** new optional fields never require one - an older manifest simply omits them and behaves as before. The number only moves when a field is removed or renamed, and when it does, this Yuvomi keeps reading the older format as well. A guard in `test/test-modules.js` enforces that: it drives a manifest carrying every promised field through the real normaliser, so dropping one turns the suite red rather than turning somebody's widget blank.
- Permission module key: `ext:<module-id>` (appears in Settings -> Household -> Roles & permissions).
- Widget id in the dashboard: `<module-id>:<widget-id>` (namespace avoids collisions with core widgets).
- `capabilities.permissions.module` is required when you declare widgets and/or `api.prefix`.
- `capabilities.api.prefix`, when declared, must be exactly `/api/extensions/<module-id>` (trailing slash optional). Any other prefix - including a core path such as `/api/tasks` - is rejected and the module loads as errored.
- Widget `id`: starts with a lowercase letter, then lowercase letters, numbers and hyphens, 32 characters at most. `defaultSize` is one of `1x1` to `4x4` (default `1x2`).
- Widget `entry` must export `renderWidget(container, { size, options, user })`.
- Widgets fetch their own data (typically from your sidecar API). They are not injected into `GET /api/v1/dashboard`.
- `optionsSchema` supports up to 8 keys (lowercase letters, numbers and underscores). A field's `type` is `boolean`, `number`, `string` or `array` (default `string`); an `enum` array on the field (up to 20 values) turns it into a fixed choice.
- Widget chrome (header, module seal, empty states) should follow the dashboard widget patterns in `DESIGN.md` ("Der Widget-Kopf") - core renders error/retry chrome for failed loads; your `renderWidget` owns the happy path inside the mount.

Serve a sidecar from the same origin under `/api/extensions/<module-id>/` (Traefik or an equivalent reverse proxy). `capabilities.api.prefix` must match that path exactly. The Capabilities JSON example above is the canonical minimal manifest; copy it into your own folder under `modules/`.

## Loading And Failure Behavior

Yuvomi scans `modules/` and validates each `module.json`. Invalid modules are shown as errored in Settings and are not loaded. Disabled modules are not served to the browser and do not appear in navigation. If a module page fails while rendering, Yuvomi shows an error for that page without changing core application code.

Admins enable and disable modules in Settings -> Modules -> Active modules. Ordering is a separate, personal matter and lives in Settings -> Modules -> Navigation, where every member also decides which modules they want in their own navigation - hiding one there removes it from that member's sidebar and mobile favourites without taking it from the household. A new module arrives in one of two ways: an admin installs it from Settings -> Modules -> Add custom module (from a GitHub address or a ZIP file, on installations whose operator has switched that on with `MODULES_ALLOW_WEB_INSTALL=true`, see [Installing From Settings](#installing-from-settings)), or somebody with access to the server copies its folder into `modules/`. Either way it appears in both places automatically. A module installed from Settings starts disabled and waits for an admin to approve it in a browser session; that approval is written into the module's folder, so it survives a database restore. A folder copied by hand starts enabled, because whoever copied it has already made that decision on the server.

## Installing From Settings

Admins can install a module without access to the server: Settings -> Modules -> **Add custom module**, the last entry of the Modules group. The page offers two ways, a GitHub address and a ZIP upload, and both end in the same installer.

**The operator switches it on.** The feature is off by default. Set `MODULES_ALLOW_WEB_INSTALL=true` in the environment (`.env`, the Unraid template, the Portainer stack, the installer page; it sits next to `MODULES_DIR`) and restart Yuvomi. Until then the page shows the manual way below and the install and delete routes answer `403 module_web_install_disabled`. The reason it is a choice rather than a default: until now, putting same-origin script into `modules/` needed access to the server's filesystem. With the page, a foothold in an admin's browser session is enough (an XSS, or a module that is already enabled), and what it writes outlives that session, a password change and a revoked token. Nothing in the design closes that completely, so it is a risk for the operator to take where `modules/` is mounted and the household wants it, not something every installation receives with an update ([docs/DECISIONS.md](docs/DECISIONS.md), entry 12).

**Trust first.** A module is same-origin JavaScript: it runs in the browser of every member who opens it, with that member's session, and can do whatever that member can do. Installing one from Settings is the same act as copying its folder onto the server, which is why only an admin can do it and why a new module never goes live on its own. The installer checks that an archive is well-formed and safe to unpack; it does not read or review the module's code. Install only modules whose author you trust.

### From GitHub

Paste the address of a public repository. Accepted forms (`www.github.com`, a trailing `/` or `.git` are fine; a query string or fragment is ignored; `http://` and other hosts are refused):

```text
https://github.com/owner/repo
github.com/owner/repo
owner/repo
https://github.com/owner/repo/releases/latest
https://github.com/owner/repo/releases/tag/v1.2.0
https://github.com/owner/repo/tree/main
https://github.com/owner/repo/tree/main/modules/example
https://github.com/owner/repo/tree/feature/x/modules/example
```

Which version is installed:

- **No tag or branch in the address** (the first four forms): the repository's latest release, as GitHub reports it (drafts and pre-releases do not count). A repository without a release installs its default branch instead. If the latest release has a tag name Yuvomi cannot use, the install is refused rather than quietly taking the default branch; use the release's tag or a `tree/` address.
- **`releases/tag/<tag>`:** exactly that tag.
- **`tree/<ref>/<path>`:** the branch, tag or commit `<ref>`, and the rest of the address is the folder of the module inside the repository. Because a branch name may itself contain slashes, Yuvomi asks GitHub which prefix exists, shortest first and up to three segments: in the last example the branch is `feature/x` if `feature` does not exist, and the folder `modules/example`.

What is installed is the state of that ref at that moment; the commit is recorded (see [Install record](#install-record)). Nothing updates itself later.

Only `github.com` is supported, and only public repositories: no GitLab, Codeberg or self-hosted Git, and no GitHub tokens. The download talks only to `github.com`, `api.github.com` and `codeload.github.com` (every redirect is checked against that list), goes through the same private-network guard as Yuvomi's other outbound requests, and has 30 seconds for the whole exchange. GitHub allows about 60 unauthenticated API calls per hour per server address; when that is used up, the page says so and names the time it resets.

### From a ZIP file

Upload a `.zip` of up to 20 MB. The module folder may sit at the root of the archive or anywhere inside it; an archive with one top folder around everything (what GitHub's "Download ZIP" produces) is handled like a repository.

### How the module is found

- Yuvomi collects every `module.json` in the archive, at most six folders deep counted from the repository root (the one top folder of a GitHub archive does not count), ignoring anything under `node_modules` and under folders whose name starts with `.`.
- Exactly one: that module is installed. None: the install is refused.
- Several (a monorepo, or a repository with examples): the page lists them with name, id, version and folder, and the admin picks one. The ZIP route takes the choice as `?path=<folder>`, the GitHub route as `path`; an empty `path` selects a module at the root of the archive.
- A `tree/<ref>/<path>` address selects the module in exactly that folder. If that folder holds no `module.json` itself but several modules below it, those are offered for choice; if nothing is below it, the install is refused.
- The installed folder is always `modules/<id>`, from the manifest's `id`, whatever the folder in the archive is called.

### What is copied

Only the chosen module folder and its subfolders, never the rest of the repository. A subfolder that holds a `module.json` of its own is another module and is left out (a root module with examples in `plugins/x/` gets no copy of them). Inside the folder, only the file types a browser module is made of:

```text
.js .mjs .css .json .svg .png .jpg .jpeg .webp .gif .ico .woff .woff2 .ttf .md .txt .map
```

plus files named `LICENSE`, `LICENCE`, `NOTICE` or `README` (any letter case, with no extension or one of those above). Everything else, and every file or folder whose name starts with `.`, is skipped and listed after the install; that is not an error, since a module folder often carries a build script or a CI file. A file the manifest refers to (`entry`, `style`, a widget `entry`) must of course survive that filter. Before the folder is moved into place it passes the same validation the loader runs at startup; a module that would load as errored is not installed, and the page shows the loader's message.

### Archive limits

An archive is unpacked in memory and checked completely before anything is written:

| Limit | Value |
|-------|-------|
| Archive size (upload and GitHub download) | 20 MB |
| Unpacked size, all files together | 50 MB |
| Entries | 2000 |
| Single file | 10 MB |
| `module.json` | 64 KiB |
| Compression ratio | 200:1 for a file over 1 MB, and for the archive as a whole once it unpacks to more than 1 MB |

Refused outright: symbolic links and other non-regular files; paths that are absolute, carry a drive letter or `..`, or would land outside the module folder (zip slip); Windows-reserved names (`CON`, `NUL`, `COM1`, ...) and characters (`< > : " | ? *`); names that differ only in letter case or Unicode normalization; ZIP64, multi-part and encrypted archives; compression methods other than stored and deflate; and files whose checksum does not match. Nothing from the archive is executed on the server.

### Disabled until approved, replacing and updating

A newly installed module is **disabled**, and that state lives in the module's folder, not in the database: the install record (`.yuvomi-install.json`, see below) carries `"approved": false`, and a folder whose record lacks an explicit `"approved": true` is off whatever the database says. Restoring a database backup from before the install, or starting a fresh database over a kept modules volume, therefore never switches on a module nobody has looked at. The module appears in Settings -> Modules -> Active modules, where its Details disclosure shows id, version, description, source, install date, who installed it and the folder, and an admin approves it there with the usual switch. **Enabling needs a browser session:** `PATCH /api/v1/modules/:id` with `enabled: true` is refused for API tokens and the MCP endpoint (`403 module_session_required`), the same rule as for installing, because the step that makes installed code live must not be weaker than the step that placed it. Disabling by token stays allowed. Once approved, the switch behaves as it always has, and its state travels with the folder as well: switching off writes `"approved": false` into the record (and the id onto the disabled list), switching on writes `"approved": true` again, so `approved` means "an admin has this version switched on", and a restored database cannot switch on what an admin switched off any more than what nobody has looked at. An install or a replace resets it too. Enabling takes the same lock as installing and deleting, so while one of those runs (a GitHub download may take up to 30 s) the switch answers `409 busy` and can simply be retried; when the record cannot be written (the module folder is read-only) it answers `503 not_writable`. Disabling is never refused for either: the disabled list is written first and the record best effort. Unlike the household switch for built-in modules, which only stops what the server does on its own and leaves their routes open ([docs/DECISIONS.md](docs/DECISIONS.md#11-switching-a-module-off-is-not-a-lock), entry 11), the switch for a third-party module is a hard gate on purpose: a disabled module has no route, is not served, and its assets answer `404`.

Updating a module means installing it again, for example from its new release. When a module with the same `id` is already installed, the page asks before replacing it and names the installed and the incoming version. The new folder replaces the old one in a single rename; if that fails, the old folder is put back unchanged. **Every replacement arrives disabled**, whatever the module's state before and wherever the new copy comes from: a GitHub ref is a branch or a movable tag, so "the same repository" is no proof that the same code arrived, and a ZIP upload shows no origin at all. The replace writes `"approved": false` into the record; review the new version in Active modules and switch it on again there. A module that was copied by hand (no install record) is **not** replaced from Settings: both install routes answer `409 not_web_installed`, and the page shows that message instead of the replace question. Such a folder may be a working checkout with uncommitted work, and the web interface removes or replaces only what it installed. Remove the folder on the server first, then install again.

If `modules/<id>` exists but is a symbolic link or a file rather than a folder, the installer refuses to touch it; fix that on the server. Only one install or delete runs at a time; a second one started meanwhile is refused with "busy" and can simply be retried.

### Deleting

Active modules has a delete button on the row of every third-party module **that was installed from Settings**, that is, whose folder carries an install record, and only while the server would accept the delete: the page reads `GET /api/v1/modules/install/info` like Add custom module does and leaves the button out unless `webInstall` is `true` and `writable` is not `false` (with `MODULES_ALLOW_WEB_INSTALL` unset every delete would end in `403`, on a read-only folder in `503`; when the answer is missing, as from an older server, there is no button either). A hand-copied folder has no record and no delete button, and `DELETE` refuses it with `409 not_web_installed`, as both install routes refuse to replace it: such a folder may be a working checkout with uncommitted work, and the web interface removes or replaces only what it installed. Remove those on the server, as you placed them. The same goes for a folder whose name is not a valid module id (it shows as an errored row). Deleting removes the folder `modules/<id>` and takes the id off the disabled list. It deliberately leaves two things in place, both of which already tolerate a module that is not there: the `ext:<id>` rows in Settings -> Household -> Roles and permissions, and the dashboard widget configurations of `<id>:<widget>` tiles. A later reinstall of the same `id` therefore comes back with its permissions and dashboard layout. A `modules/<id>` that is a symbolic link is not deleted, because deleting through it would remove files outside `modules/`.

### Install record

The installer writes `.yuvomi-install.json` into the module folder:

```json
{
  "source": "github",
  "url": "https://github.com/owner/repo",
  "ref": "v1.2.0",
  "commit": "3f2c...40 hex characters",
  "path": "modules/example",
  "installedAt": "2026-10-02T09:15:00.000Z",
  "installedBy": 1,
  "approved": false
}
```

A ZIP upload records `"source": "zip"` without `url`, `ref` and `commit`. The record is what Details shows as source, install date and installer, and what marks a folder as installed from Settings (so deletable and replaceable from there). `approved` is the review state: `false` on install and on every replace, `true` once an admin has switched the module on in a browser session, `false` again when an admin switches it off (the file is rewritten atomically each time). `GET /api/v1/modules?admin=1` returns the record to admins as `install`, with `approved` and with the user id resolved to `installedByName` (`null` when that account no longer exists; Details then says "a former member"); members never see it, and the asset route does not serve dotfiles. A module without the file was copied by hand, and Details says so. Do not ship your own `.yuvomi-install.json`: dotfiles in an archive are skipped.

### Read-only folders and Umbrel

The page first asks the server about `modules/` (`GET /api/v1/modules/install/info`). Where the folder is not writable (a `:ro` mount, a volume owned by another user, a read-only filesystem), where the operator has not set `MODULES_ALLOW_WEB_INSTALL`, or where the folder would not survive an update, the page explains that and shows no install controls; copy the folder by hand as described under [Docker / Podman](#docker--podman) instead.

Umbrel's package mounts no modules folder at all. The folder inside the container is writable, but a module placed there lives in the container layer and is gone after the next app update, exactly like a folder copied in by hand. The same applies to any container started without a volume on `/app/modules`. The server tries to detect this case, best effort: `GET /api/v1/modules/install/info` reports `persistent: false` when Yuvomi seems to run in a container and `/app/modules` is not its own mount (read from `/proc/self/mountinfo`), and the page then behaves exactly as for a read-only folder: it explains that installed modules would be lost on the next update, points to mounting a volume, and shows no install controls. `persistent` is `null` when the server cannot tell, and `true` when it finds no container. The guess can be wrong: an LXC container may look like a plain host, and a Kubernetes `emptyDir` counts as a mount although it is gone with the pod. On Umbrel, third-party modules are not available.

### Who can install

Only an admin, only from a signed-in browser session, and only where the operator has switched the feature on. API tokens (an admin's included) and the MCP endpoint are refused with `403` and `reason: "module_session_required"`, so a leaked token cannot place code in front of the household; with `MODULES_ALLOW_WEB_INSTALL` unset the same routes answer `403 module_web_install_disabled`, in both cases before the body is read. Enabling an installed module needs the browser session as well (see above). Install and delete are CSRF-protected like every other state-changing request, and the two install routes allow 10 requests per 10 minutes per user. The answers that ask back (`409` already installed, `422` several modules) do not count; failed attempts do.

API, for completeness (session only, as above):

- `GET /api/v1/modules/install/info` returns `{ data: { writable, persistent, webInstall, maxZipMb } }` (admin; readable with a token too). `webInstall` is the operator's switch.
- `POST /api/v1/modules/install/zip?overwrite=1&path=<folder>` takes the archive as the raw request body (`Content-Type: application/zip`).
- `POST /api/v1/modules/install/github` takes `{ url, ref?, path?, overwrite? }`; `ref` and `path` override what the address says.
- `PATCH /api/v1/modules/:id` with `{ enabled: true }` approves (session only; `409 busy` while an install or delete runs, `503 not_writable` when the record cannot be written); `{ enabled: false }` works with a token too and is never refused for either. Its error bodies carry `reason` when there is one.
- `DELETE /api/v1/modules/:id` returns `{ data: { id, deleted: true } }`; only for folders with an install record.

A successful install answers `201` with `{ data: <module>, replaced, skipped }`; the module in `data` is always disabled. Errors carry `{ error, code, reason }`: `409 exists` adds `existing: { id, name, version, install }` (the record, never `null` here) and `incoming: { id, name, version }`, `422 multiple` adds `candidates: [{ path, id, name, version }]`, and a GitHub rate limit adds `resetAt`. Both install routes answer `409 not_web_installed` when `modules/<id>` already exists without an install record (a hand-copied folder; no `existing` in the body, with or without `overwrite`). `not_a_module` (`modules/<id>` is a link or a file) is `409` on install and `400` on delete; delete also answers `400 bad_id` for an id that is not a valid module id and `409 not_web_installed` for a folder without an install record. A record that is present but corrupt is refused by delete and replace alike; that is fixed on the server.

### Preparing a module for installation

If you publish a module, a few habits make it install cleanly:

- **Give `module.json` a folder of its own** (`module/`, or `modules/<id>/` in a larger repository) rather than the repository root. The installer copies the folder that holds the manifest with everything allowed inside it; at the root that would include your docs, tests and example files.
- **One module per folder.** For several modules, use sibling folders, and link each one in your README as `https://github.com/owner/repo/tree/main/<folder>` so admins can install it without choosing from a list.
- **The folder name need not equal the `id`.** The installer names the folder on the server after the manifest; only a hand copy has to match.
- **Tag releases.** A plain repository address installs the latest release, so a tag gives admins a defined version and a meaningful update. Without releases they get whatever the default branch holds at that moment.
- **Ship built files.** Nothing is built or installed on the server: commit the JavaScript and CSS the browser loads, use only the file types listed under [What is copied](#what-is-copied), and stay inside the [archive limits](#archive-limits).

## Compatibility Across Yuvomi Releases

`module.json` records the module's own version, not the Yuvomi version it was written against, and Yuvomi does not gate loading on a compatibility range. A module that calls an endpoint a later release renamed or moved therefore keeps loading and fails at the point of use, in front of the user.

Two endpoints help, though they answer at different times:

- `GET /api/v1/version` returns the running Yuvomi version to any caller holding a session or an API token. Without a credential the response still describes the instance, but omits the version.
- `GET /api/v1/openapi.json` describes the operations that version actually serves. It is admin-only, so treat it as a check you run while developing and against a new release before shipping, not as something every module instance can call at startup.

Compare the operations the module requires - method, path, and the response fields it reads - against that document while building, and again when a Yuvomi release moves. At runtime, where the document is usually out of reach, watch the version instead and read the failure: a `404` or `405` on an endpoint that worked before means the operation moved, and that is the point to degrade rather than retry. Three outcomes cover the realistic cases: run normally; keep stored data, review and export readable while blocking writes; or show a dependency error with a retry control. Refusing a write is better than issuing it against an endpoint whose meaning has changed.

Third-party modules should build on `/api/v1` and the public browser libraries described above; breaking changes to those are called out in the CHANGELOG. Direct database access, private helpers under `server/`, and undocumented response fields sit outside that line and may change in any release without notice.

How long that line holds: before an operation under `/api/v1` changes or goes away, it is named as deprecated in the CHANGELOG and keeps working unchanged for at least 90 days after the release that says so - a span of time rather than a number of releases, because releases here are frequent and a module author reads the CHANGELOG on their own schedule. A fix that makes an operation do what its documentation says - storing correctly a value it used to store wrong without an error - is not a change in this sense: the CHANGELOG names it explicitly, but it is not listed as deprecated first. If an `/api/v2` ever ships, `/api/v1` keeps being served for twelve months after it.

## Docker / Podman

The default `docker-compose.yml` mounts `${MODULES_DIR:-./modules}` to `/app/modules`. To keep modules outside the Yuvomi checkout, set `MODULES_DIR=/absolute/path/to/yuvomi-modules` in `.env` and restart the compose service. The compose file pins `MODULES_DIR` to `/app/modules` inside the container, so the value in `.env` only moves the host folder. New or changed module folders are scanned at runtime; rebuilding the image is not required.

On Podman (RHEL/Fedora/CentOS Stream) use `podman-compose.yml` instead — it mounts the same `/app/modules` path with the SELinux `:Z` relabel so the rootless container can read your modules.

On Portainer the stack mounts a named volume (`oikos_modules`) at `/app/modules`, since a Portainer deployment has no repository checkout to bind-mount from. Copy module folders into that volume (for example via `docker cp` into the running container, or a temporary container mounting the volume); a bind mount to a host path works too if you edit the stack.

Unraid (the template's *Modules* path, `/mnt/user/appdata/yuvomi/modules` by default), TrueNAS (the *Modules Storage* entry) and the Podman Quadlet (`~/.local/share/oikos/modules`) mount `/app/modules` as well. **Umbrel is the exception:** its store package mounts no modules folder, so third-party modules are not available there. A module copied into the running container would sit in the container layer and be gone on the next update, which is why Settings -> Modules -> Add custom module offers no install there either.
