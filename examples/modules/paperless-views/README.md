# Optional Paperless navigation module

This is an additional page for the Paperless view-folder core extension. It is
not a standalone backend and does not work on an unmodified official image.
Install the core patch first. The feature already works inside Documents; this
module is optional if a separate Paperless navigation entry is useful.

Copy this directory to `modules/paperless-views/`, restart Yuvomi, and enable it
under Settings -> Modules. Grant users access to both this module and Documents.
Documents API permissions still apply to every request. Removing this module
only removes the extra page, not the native folders or their configuration.

For installation through Settings, zip this directory with module.json at its
root and upload it. A dedicated module repository should contain exactly these
module files at its root, not the complete Yuvomi fork.

No API tokens are stored in the module. The core extension keeps credentials
server-side. An independent backend on the stock official image would require
a sidecar service and its own session/permission/CSRF checks, as MODULES.md
explains; this package intentionally does not pretend to supply that service.
