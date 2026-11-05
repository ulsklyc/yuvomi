# Paperless saved-view folders

Documents can connect a saved Paperless view as a live folder with read access
and administrator-controlled tag assignment.
Nothing is copied into `family_documents`, and a document can appear in several
views. This is a core extension, not a scheduled import.

## Use

1. Configure Paperless under Settings -> Documents -> Document management, using
   the server root URL and an API token. The Paperless user must be able to
   read saved views and the documents in them.
2. Create and save the desired view in Paperless.
3. In Documents, use the plus button beside Paperless views. Pick the
   connection, saved view and local name.
4. Keep the default Only me, or select Family and explicitly confirm sharing.
5. Open the folder. Refresh or reopen it to get the current result; use Next
   for further pages. Preview opens a new tab; Download keeps the file's name.
6. Use **Tags** on a document to see its live Paperless tags. The creating
   administrator can select existing tags and save them directly to Paperless.
   Individually linked Paperless documents offer the same **Tags** action in
   their viewer (on mobile, in the actions menu).

## Document tags

The Paperless token needs read permission for documents and tags, and change
permission for documents to save assignments. No new tags are created.
Family readers can see names of the document's assigned tags; they cannot
browse the account-wide tag catalogue or change assignments. Unreadable tag
names appear as `#ID` and their assignment is preserved. Mutations require a
Yuvomi administrator and Documents write access. For view folders, only the
folder's creating administrator may mutate tags. For individually linked
documents, an administrator must be able to see the local document.

The editor loads existing assignments before enabling Save. The catalogue is
paginated in batches of 100; **Load more tags** fetches subsequent pages.
Search filters the loaded catalogue. Assigned tags on unloaded pages remain
selected; unchecking every assigned tag explicitly removes all assignments.
Cancel does not write. No file is copied and no database migration is needed.

Before saving, Yuvomi rechecks visibility, account identity, current view
membership and the previously loaded tag IDs. An intervening source change
returns a conflict and requires Refresh. Paperless does not provide an atomic
compare-and-swap through this implementation: another writer could still
change tags between that check and the PATCH. Only the `tags` field is sent.
After saving, the view is refreshed; a document may disappear if its new tags
no longer match the saved filters. Errors keep the editor open and preserve
the selection. All tag responses use `Cache-Control: no-store`.

Endpoints below `/api/v1/documents/dms/paperless`:

- `GET /tags?account_id=…&page=…`: administrator-only tag catalogue.
- `GET|PUT /folders/:id/documents/:documentId/tags`: current view member.
- `GET|PUT /documents/:id/tags`: visible individually linked local document ID.
- PUT body: `{ "tags": [7, 12], "expected_tags": [7] }` (both arrays required).

Automated validation: `npm run test:paperless-tags` (adapter and route tests),
`npm run test:paperless-tags-browser` (full app and loopback Paperless API).
These tests do not replace an acceptance check against your actual Paperless
instance and its object permissions.

Family sharing delegates permission to read/download **all current and future
matches** to everyone who may read Documents in Yuvomi. This uses the
configured Paperless account, not the visitor's own Paperless identity. A view
with no filters delegates the account's complete readable archive. Later
changes to the source view can expand or narrow that delegation. Only the
creating administrator can rename, share or disconnect their folder. Revoking
sharing takes effect on the next request; already downloaded files cannot be
recalled. Removing the DMS connection also removes its view-folder bindings.

## Design

- Migration 282 adds `paperless_view_folders`; shipped migrations stay intact.
- `server/services/dms/paperless-views.js` translates persisted Paperless rule
  IDs. Unknown or malformed rules fail closed with 422.
- `PaperlessAdapter` reads `/api/saved_views/{id}/` on every document request
  and calls `/api/documents/` with the filters, ordering and page parameters.
  It uses the existing token, request timeout, target guard and API v9 header.
- Page size is 50; no first-page/20-result truncation. Absolute `next` URLs are
  not followed with credentials.
- `/api/v1/documents/dms/paperless` uses core authentication, Documents module
  permissions, token scopes and CSRF middleware. Configuration needs an admin.
- Media routes intersect current view filters with the requested document ID
  before fetching content, and recheck local sharing after remote awaits.
- Responses are `no-store`, upstream errors are sanitized and previews allow
  only PDF, PNG, JPEG, WebP, GIF and plain text. Other types are download-only.
- An account or view cannot be retargeted in-place. Create a new binding for a
  different source to make the new delegation explicit.

Supported rule IDs 0-50 follow Paperless's persisted filter definitions:
text/title/content, ASN, correspondents, types, storage paths, tags (all/any/not),
dates, owners, sharing, custom fields and MIME filters. Legacy API v9 filter
parameters remain in use for legacy rules. A new upstream rule requires a
mapping and tests before it can be used. The actual installed Paperless release
still needs an integration check, especially for newer rule types.

## Limits

These are root-level virtual folders displayed alongside local folders. They
are not nested in the local tree, included in All documents or global search,
archived locally, linked automatically to tasks/budgets, or stored offline.
Local category/archive/search controls are hidden while a source folder is
open. Paperless's source ordering is preserved. This first version shows a
list; source thumbnails have an endpoint but are not downloaded for every row.
Preview opens separately and is not Yuvomi's editable local-document viewer.

There is no push subscription or background poll. Reopening, refreshing or
changing page reads the source again. A changing source can move documents
between pages, as with Paperless's ordinary paginated API. Folder authorization
is checked around remote operations; view membership and fetching content are
separate Paperless requests and cannot form one cross-server transaction.
The existing DMS adapter's target-guard and DNS/redirect limitations are not
changed by this feature.

## Pull request / fork

The implementation starts at Yuvomi commit
`3477e2a1` (release tag `v2.85.0`).
It also supports upgrading a database from the published 2.84 Paperless fork.

1. Clone `aquaneno/yuvomi` and check out `compat/paperless-yuvomi-2.85.0`.
   This branch combines the Paperless extension with release `v2.85.0`.
2. Run `npm ci`, `npm run test:paperless-folders`, `npm run test:paperless-folders-upgrade`, `npm test`, and the browser
   suite `npm run test:paperless-folders-browser` with a supported local Chrome.
3. Follow CONTRIBUTING.md, disclose AI assistance and submit to upstream main.
   The contributor guide asks for a feature issue first; the original DMS issue
   #277 deliberately chose curated document links. A curated, explicitly
   selected saved view is the proposal here, but acceptance is the maintainer's
   decision. No issue or PR is created by applying this patch.
4. The PR branch `feat/paperless-live-folders` integrates upstream main at `284dfecae2a0333e47c16fbb1ba47ff962b2db86`. Migration 276 is now upstream pantry
   minimums and 277 is task rotation. The extension uses 282. Preserve the
   legacy-fork repair hook if integrating another upstream migration later.
   Do not edit any already shipped upstream migration.
5. For an immediate private deployment build your fork's Docker image, rather
   than pulling the official `latest` image over it.

Back up and test a separate installation first. Migration 282 adds a binding table and repairs the published fork collisions. The 2.85 compatibility fork recorded Paperless at 278; the PR restores upstream wall-display settings at 278 without changing existing settings or folder rows. The older 2.84 fork collision: the old folder migration used number 276, which upstream now uses
for pantry product minimums. Existing folder rows are retained; the missing
upstream pantry migration is executed once inside the migration transaction,
and its ledger description is corrected. An older official server refuses a
database with a newer schema. Roll back with the matching pre-upgrade backup; do not manually lower
the schema version. See the German installation guide shipped with the patch
for concrete Git and Compose commands and a suggested PR description.

## Optional own module

`examples/modules/paperless-views/` provides an additional Paperless navigation
page using the same API/component. After applying the core patch, copy it into
`modules/paperless-views/`, restart, and enable it in Settings. It can also be
zipped with `module.json` at the root and uploaded through module installation.
Users need both module access and Documents access. No credentials are stored
in this module.

**It is not standalone on the stock official image.** Yuvomi modules are
browser code. They cannot register server routes or change the database of the
built-in Documents page. An independent stock-image solution would need its
own sidecar backend, credentials and session/permission/CSRF checks described
in MODULES.md; it would be a separate application surface. The supplied module
therefore reuses the core implementation instead of hiding this dependency.
