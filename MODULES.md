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

The folder name must match the manifest `id`.

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

Scheduled jobs have no session. Issue an API token under Settings -> Administration -> API access (admin-only, so a module that needs one has to ask the household's admin for it) with only the scopes the module needs - for core modules `budget:read` and `budget:write`, for extension modules `ext:<module-id>:read` / `:write` - and keep it in the service's secrets, never in the module folder, a Compose file, or browser storage. Keep the service's own state in the service's own database, and treat stored secrets as write-only: expose `has_api_token: true`, never a fragment of the token itself.

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

**Supported languages:** the same 24 locales as Yuvomi core (`getSupportedLocales()` / files under `public/locales/`). You may ship all of them, a subset, or only your default - the runtime never shows raw i18n keys in shell UI.

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
- Permission module key: `ext:<module-id>` (appears in Settings -> Administration -> Roles & permissions).
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

Admins enable and disable modules in Settings -> Modules -> Active modules. Ordering is a separate, personal matter and lives in Settings -> Personal -> Navigation, where every member also decides which modules they want in their own navigation - hiding one there removes it from that member's sidebar and mobile favourites without taking it from the household. Copying a new folder into `modules/` makes it appear in both places automatically.

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

Unraid (the template's *Modules* path, `/mnt/user/appdata/yuvomi/modules` by default), TrueNAS (the *Modules Storage* entry) and the Podman Quadlet (`~/.local/share/oikos/modules`) mount `/app/modules` as well. **Umbrel is the exception:** its store package mounts no modules folder, so third-party modules are not available there. A module copied into the running container would sit in the container layer and be gone on the next update.
