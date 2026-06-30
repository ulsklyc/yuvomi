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
  }
}
```

Required fields:

- `id`: lowercase letters, numbers and hyphens only. Must match the module folder.
- `entry`: a relative `.js` file exporting a `render(container, context)` function.

Optional fields:

- `style`: a relative `.css` file loaded only for this module page.
- `menu.show`: set to `false` if the module should not appear in the left menu.
- `menu.label`, `menu.icon`, `menu.order`: left-menu label, Lucide icon name, and order.
- `accent`: a `#RRGGBB` color used for menu highlighting.

## Client Entry

```js
import { api } from '/api.js';
import { esc } from '/utils/html.js';

export async function render(container, context) {
  const me = await api.get('/auth/me');
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="page">
      <div class="page__header">
        <h1 class="page__title">Example Module</h1>
      </div>
      <section class="settings-card">
        <p>Hello, ${esc(me.user.display_name)}</p>
      </section>
    </div>
  `);
}
```

Modules may import public Yuvomi browser libraries such as `/api.js`, `/i18n.js`, and utilities under `/utils/`. For calls to Yuvomi's built-in REST API, prefer `import { api } from '/api.js'`: it prefixes requests with `/api/v1`, sends the current session credentials, handles CSRF tokens, and uses non-cached fetches for user data.

If a module calls a separate backend service through a reverse proxy, expose that service on a same-origin `/api/...` path whenever the response is dynamic. Yuvomi's service worker deliberately bypasses `/api/` requests, while other same-origin GET requests may be handled by the app-shell caching strategy. A dynamic proxy path such as `/ext/myservice/...` can therefore return stale cached responses unless you also change the service-worker strategy.

Modules must follow the same frontend security rules as core Yuvomi:

- Use `replaceChildren()` and `insertAdjacentHTML()`.
- Escape untrusted values before inserting HTML.
- Do not use external CDNs.
- Do not use `innerHTML`.
- Do not bypass authentication, authorization, CSRF, or CSP.

## Loading And Failure Behavior

Yuvomi scans `modules/` and validates each `module.json`. Invalid modules are shown as errored in Settings and are not loaded. Disabled modules are not served to the browser and do not appear in navigation. If a module page fails while rendering, Yuvomi shows an error for that page without changing core application code.

Admins can enable, disable, and order modules in Settings -> Modules -> Navigation. Copying a new folder into `modules/` makes it appear there automatically.

## Docker / Podman

The default `docker-compose.yml` mounts `${MODULES_DIR:-./modules}` to `/app/modules`. To keep modules outside the Yuvomi checkout, set `MODULES_DIR=/absolute/path/to/yuvomi-modules` in `.env` and restart the compose service. New or changed module folders are scanned at runtime; rebuilding the image is not required.

On Podman (RHEL/Fedora/CentOS Stream) use `podman-compose.yml` instead — it mounts the same `/app/modules` path with the SELinux `:Z` relabel so the rootless container can read your modules.
