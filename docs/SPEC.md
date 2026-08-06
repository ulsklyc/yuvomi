# Yuvomi - Product Specification

Self-hosted family planner web app for a single household (2–6 people). No app store, no public access. Deployment via Docker or Podman (rootless, SELinux-ready) on a private Linux server behind an Nginx reverse proxy with SSL.

> **See also:** [Architecture — God-Nodes: Constraint-Brücken vs. organische Hubs](architecture-hubs.md) — warum `esc()` und `toLocalDateKey()` die zentralsten Frontend-Utilities sind (erzwungen durch das `innerHTML`- bzw. UTC-Slice-Verbot).

---

## Data Model

Every table: `id INTEGER PRIMARY KEY`, `created_at TEXT`, `updated_at TEXT` (ISO 8601).

### Users
| Column | Type | Constraint |
|--------|------|-----------|
| username | TEXT | UNIQUE NOT NULL |
| display_name | TEXT | |
| password_hash | TEXT | bcrypt (cost 12) of the NFC-normalized password (v1.56.1). Legacy hashes from non-normalized input are still verified and migrated to NFC on the next successful login |
| avatar_color | TEXT | HEX color code |
| avatar_data | TEXT | Base64 data URL of profile picture (nullable) |
| role | TEXT | 'admin' or 'member' |
| family_role | TEXT | 'dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other' (default 'other') |
| oidc_sub | TEXT | OIDC subject identifier from the provider, nullable. Populated on first SSO login. |
| oidc_provider | TEXT | OIDC issuer URL of the provider that set `oidc_sub`, nullable. Partial UNIQUE index on `(oidc_sub, oidc_provider)` WHERE NOT NULL. |
| calendar_feed_token | TEXT | Secret token authenticating the user's read-only ICS export feed, nullable. Partial UNIQUE index on `calendar_feed_token` WHERE NOT NULL. |
| calendar_feed_show_assignees | INTEGER | Opt-in flag (0/1, default 0): when set, the read-only ICS export feed appends the assigned members to each event's `SUMMARY`, e.g. `Pool party (Mom, Dad)`. |

### Invites (v1.75.0)

One pending invitation per row. The `users` row is only created when the invitation is accepted, so no half-finished accounts exist.

| Column | Type | Constraint |
|--------|------|-----------|
| token_hash | TEXT | NOT NULL, UNIQUE index. SHA-256 of the invite token; the plaintext token is never stored |
| email | TEXT | Optional. Required only when the invitation is sent by mail; becomes the new member's contact address on acceptance |
| username | TEXT | Optional. When set, the invited person cannot choose a different one |
| display_name | TEXT | Optional, max. 128 characters |
| role | TEXT | 'admin' or 'member' (default 'member'), CHECK constrained |
| family_role | TEXT | Default 'other'. Deliberately no CHECK: the migration is append-only and must not freeze the role list. Validated in the route against `FAMILY_ROLES` |
| created_by | INTEGER | FK → Users, ON DELETE SET NULL |
| expires_at | INTEGER | Unix epoch milliseconds. Fixed TTL of 7 days, no env var |
| accepted_at | TEXT | Set on redemption instead of deleting the row, so "who invited whom" stays traceable |
| accepted_user_id | INTEGER | FK → Users, ON DELETE SET NULL |
| revoked_at | TEXT | Set by an admin revoking the invitation. Also never deleted |

### Tasks
| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | NOT NULL |
| description | TEXT | |
| category | TEXT | FK → Task Categories (by key), NOT NULL default `misc` |
| priority | TEXT | none (default), low, medium, high, urgent |
| status | TEXT | open, in_progress, done, archived |
| due_date | TEXT | DATE, nullable |
| due_time | TEXT | TIME, nullable |
| start_date | TEXT | DATE, nullable — tasks with a future start date are hidden from the default list view |
| assigned_to | INTEGER | FK → Users (legacy single-user field, kept for backwards compat) |
| created_by | INTEGER | FK → Users, NOT NULL |
| is_recurring | INTEGER | 0/1 |
| recurrence_rule | TEXT | iCal RRULE |
| recurrence_from_completion | INTEGER | NOT NULL DEFAULT 0 (migration v127, #658) — 1 anchors the next due date to the day the task was ticked off instead of to its due date |
| parent_task_id | INTEGER | FK → Tasks (max 2 levels) |
| recurrence_origin_id | INTEGER | FK → Tasks, ON DELETE SET NULL (migration v122) — the completed instance whose completion created this one. Deliberately not `parent_task_id`, which means "subtask" |
| points | INTEGER | NOT NULL DEFAULT 0 — reward points credited to assigned members on completion (Rewards module, migration v69) |
| visibility | TEXT | NOT NULL DEFAULT `all` — `all` \| `assignees` \| `private`; who may see the task (migration v78) |

**Visibility (migration v78):** every task carries a `visibility` of `all` (all family members, the default and prior behaviour), `assignees` (creator + assigned members only), or `private` (creator only). Enforcement is **server-side on every read path** (list, detail, dashboard widgets, search, MCP) — there is **no admin bypass**, so a "private" task stays hidden even from a parent/admin (the intended use is preparing a surprise). Set via the visibility selector in the task modal; restricted tasks carry a lock/people icon in the list. The same field and rule apply to calendar events.

Recurring tasks keep only one open instance: the next instance is created on completion, not on a schedule. Both ways of completing a task create it — the checkbox on the card and the status field in the edit dialog — and both ways of undoing a completion withdraw it again. When an overdue recurring task is marked done, its next due date catches up to the next occurrence at or after today (skipping missed periods) instead of advancing a single interval from the old — possibly still overdue — due date. The follow-up instance inherits the tags along with the assignees: tags belong to the task, not to a single run. It also keeps the gap between start date and due date, so a task that begins three days before it is due keeps that head start — which means the follow-up stays out of the default list until its start date arrives, the same as any task with a future start date ("show future tasks" reveals it).

**Which day the interval counts from (migration v127, #658).** Two anchors, chosen per task by the "repeat from completion" switch inside the recurrence fields:

- **From the due date** (default, unchanged behaviour): the grid stays put no matter when the task is ticked off. Right for anything tied to an outside rhythm (bin day, rent, the club evening), and the only mode that needs the catch-up described above.
- **From the completion day**: the interval starts on the day the task was actually ticked off. Right for anything whose interval only begins with the action, such as cleaning the filter or feeding the plants. A weekly task due Saturday and completed on Monday becomes due the Monday after, not five days later. No catch-up is involved: with any positive interval the result already lies in the future. This mode also carries a series that has no due date at all, since the completion day is a usable anchor on its own.

The flag is copied onto the follow-up instance; without that the series would fall back to the due-date grid from its second run on, and it would do so silently, because the follow-up looks complete either way. The completion day is read in the household's own zone (`TZ`, see `server/utils/timezone.js`): ticking a task off at 00:30 must count as the new day, or a weekly task would come back six days later. The anchor is local to Yuvomi and does not travel over CalDAV, because RFC 5545 has no way to express it and a mirrored VTODO carries the rule alone. The shared calculation lives in `nextDueAfterCompletion()` in `server/services/recurrence.js`, deliberately separate from the route because resettable countdowns want the same "counts from the moment you touched it" arithmetic (#647).

**Undoing a completion (migration v122, #650):** ticking a series off is reversible. The follow-up instance records which completion created it (`recurrence_origin_id`), so moving a task back out of `done` — via the checkbox or the edit dialog — removes that follow-up again instead of leaving it standing next to the reopened task. Only an untouched follow-up is withdrawn: one that is still `open`, has no subtasks and has not itself been completed. Once work has accumulated on it, a click on its predecessor must not throw that away. The same link makes the creation idempotent: a completion never adds a second follow-up.

**Category default repaired (migration v114, #586):** v83 moved the categories into their own table and migrated existing rows from `Sonstiges` to the key `misc`, but left the column default at `Sonstiges` — a key that never existed in `task_categories`. Every row created without an explicit category (notably every task arriving through the CalDAV mirror) therefore carried a key that appeared in no dropdown and no filter, and jumped silently to the first real category on the first save. v114 rebuilds the table with the correct default and re-homes every orphaned key.

### Task Tags (migration v115, #586)
Free-form labels on a task, held in a `task_tags` join table (`task_id`, `tag`, `tag_key`; composite PK `(task_id, tag_key)`, `ON DELETE CASCADE`). Deliberately **not** the category: a task sits in exactly one category — a drawer — but carries any number of tags. There is no registry and no management table the way categories have one; a tag exists because a task carries it and disappears with the last one. That is why the values are free text: they arrive from foreign CalDAV servers, and a managed list would fill up with foreign values on every sync and surface them in every category dropdown.

Normalization is shared by every entry point (`server/utils/task-tags.js`): trimmed, empties dropped, capped at 32 tags of 64 characters each, and case-folded so `Garten` and `garten` are one tag (first spelling wins). Each row stores the spelling in `tag` and a comparison key in `tag_key` (NFC-normalized, lower-cased in JS), and every comparison runs on the key. That column is not convenience: SQLite's `COLLATE NOCASE` and `lower()` fold ASCII only, so `Äpfel` would not be found by `äpfel` — in a German-first app whose tags arrive from foreign calendars, that is not an edge case. The primary key is `(task_id, tag_key)`, so one task cannot carry the same label in two spellings. A value that breaks a limit is truncated rather than rejected — a sync run must not fail on one over-long foreign tag.

- **Filtering:** `GET /api/v1/tasks?tag=…` takes the parameter once per tag (`?tag=a&tag=b`); each occurrence is one literal tag, never a comma-separated list, so a tag that itself contains a comma (`Haus, Hof` from `CATEGORIES`) survives. Several tags **narrow** the list (a task must carry all of them), matching how the other filters in the same bar compose.
- **Reading:** `GET /api/v1/tasks/tags` and the `tags` field of `GET /api/v1/tasks/meta/options` return every tag in use with its task count. Both are **visibility-filtered** (#474): a tag is free text and therefore content, so the label of a private task — and its count — stays out of every other member's filter bar.
- **Managing:** `PUT /api/v1/tasks/tags/{tag}` renames across every visible task; renaming onto an existing tag merges the two and applies the typed spelling everywhere, so one label never ends up stored in two spellings. `DELETE /api/v1/tasks/tags/{tag}` detaches it from every visible task, leaving the tasks themselves alone — unlike categories there is no "still in use" guard, because a tag *is* nothing but its uses. `POST /api/v1/tasks/tags/apply` (`{ ids, add?, remove? }`) tags a whole selection at once. All three act **only on tasks the caller can see**; a rename leaves the tag on someone else's private task, because acting on an invisible row would betray its existence through the reported count.
- **UI:** tags are chips on the task card and the Kanban card (three, then a `+N` summary); clicking one filters by it. A tag editor sits in the task dialog, a "Manage tags" modal (`yuvomi-tag-manager`) in the toolbar, and add/remove tag actions in the bulk bar.
- **CalDAV:** mirrored from `CATEGORIES` on VTODO objects and pushed back. `CATEGORIES` is only in the managed property set because Yuvomi holds the **complete** list — mirroring a single value would make every push delete the tags the server knows and Yuvomi never saw.

### Shopping Item Tags (migration v116, #586)
A CalDAV reminder list can target tasks **or** the shopping list (see [CalDAV Reminder Selection](#caldav-reminder-selection)), and until v116 the `CATEGORIES` of a shopping item were dropped silently. They now land in `shopping_item_tags` (`item_id`, `tag`) and appear as chips on the item.

This direction is **inbound only**: the labels belong to the source list, so Yuvomi displays them but neither manages nor writes them back. `icsFieldsForShoppingItem` deliberately omits `CATEGORIES` — a property absent from the patch leaves the server's value untouched. They are also **not** mapped onto `shopping_items.category`: that column is the aisle, a managed list with icon and sort order, and foreign values would make it grow on every sync.

### Task Categories (migration v83)
DB-backed, customizable category list for tasks. Replaces the old hardcoded set. The eight predefined keys (`household`, `school`, `shopping`, `repair`, `health`, `finance`, `leisure`, `misc`) keep a stable slug key and are localized via `label_key`; user-added categories store their display `name`. A "Manage categories" action in the tasks toolbar opens a modal (the reusable `yuvomi-category-manager` component) to add, rename, reorder, and delete categories. Renaming leaves the key stable (so existing tasks are unaffected) and clears `label_key`. Deletion is blocked while a category is still referenced by tasks (`409`) or when it is the last remaining category.

| Column | Type | Constraint |
|--------|------|-----------|
| key | TEXT | PRIMARY KEY — stable slug |
| name | TEXT | custom display name; NULL for predefined (localized) categories |
| label_key | TEXT | i18n key for predefined categories; NULL for custom |
| sort_order | INTEGER | NOT NULL |
| created_at | TEXT | |

### Task Assignments
Join table for multi-person task assignment (migration v32). Existing `assigned_to` values were migrated automatically.

| Column | Type | Constraint |
|--------|------|-----------|
| task_id | INTEGER | FK → Tasks (CASCADE delete), NOT NULL |
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| PRIMARY KEY | | (task_id, user_id) |

### Task Documents (migration v86)
Join table linking documents from the Documents module to a task, so the information needed to complete a task (manuals, policies, service instructions) lives alongside the task itself. Managed from the task modal; linked documents show as chips (opening the document preview/download) and the task card carries a paperclip badge with the count. Both foreign keys cascade on delete — removing either the task or the document drops the link, the other side is untouched. Document visibility from the Documents module is enforced: only documents the current user may see are listed or linkable (no admin bypass), and a replace-set update leaves links to documents the user cannot see intact.

| Column | Type | Constraint |
|--------|------|-----------|
| task_id | INTEGER | FK → Tasks (CASCADE delete), NOT NULL |
| document_id | INTEGER | FK → Family Documents (CASCADE delete), NOT NULL |
| created_by | INTEGER | FK → Users (SET NULL) — who linked it |
| created_at | TEXT | |
| PRIMARY KEY | | (task_id, document_id) |

### Rewards (migration v70)

Points-and-rewards system. A member earns a task's `points` when the task is marked done (awarded to its assigned members; if unassigned, to the acting user — useful for a wall-mounted kiosk tablet on a single account). Participation is **opt-in per member**; redemptions require **parent/admin approval** by default — an admin can disable this household-wide (`rewards_require_approval` preference, Settings → Modules → Rewards) so redemptions are granted immediately. The Rewards module itself is toggleable in Settings → Modules → Rewards (nav visibility). A member's balance is always `SUM(delta)` over `reward_ledger` — there is no separately stored balance that could drift. Point award is idempotent (partial unique index) and reversed when a task leaves the `done` state.

**Default task points (#578, v1.46.0):** a household-wide default (`tasks_default_points` in `sync_config`, admin-gated, `0` = off and the prior behaviour) prefills the points field of new tasks; the value stays overridable per task, and an explicit `0` wins over the default. Subtasks are excluded — they are checklist items of their parent and would otherwise multiply its value. The server applies the default in `POST /api/v1/tasks` only when the request omits `points`, so API and MCP clients inherit it too; system-generated tasks (Housekeeping payments, CalDAV sync) insert directly and are unaffected. When an admin changes the default, the settings page offers to carry existing tasks over: `GET /api/v1/tasks/points/affected?points=N` counts the candidates and `POST /api/v1/tasks/points/rebase` (`{ from, to }`, both admin-only) moves them. "Still on the old default" is decided by the point value itself rather than a hidden flag — the count is shown before confirming, so nothing changes unseen. Tasks in status `done` are excluded because `reward_ledger` already holds an earn entry for their value; every other status (including `archived`) is booking-free and moves along, so a reactivated task never pays out a stale value.

**Reward Participants** — who takes part (opt-in).

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | PRIMARY KEY, FK → Users (CASCADE delete) |
| enabled | INTEGER | 0/1, default 1 |

**Reward Catalog** — household-wide rewards (parent/admin managed).

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| cost | INTEGER | NOT NULL — point price |
| icon | TEXT | optional emoji |
| description | TEXT | |
| is_active | INTEGER | 0/1, default 1 |
| sort_order | INTEGER | NOT NULL DEFAULT 0 |
| created_by | INTEGER | FK → Users (SET NULL) |

**Reward Redemptions** — approval flow. Requesting reserves the points via a `redeem` ledger entry; rejecting or cancelling books them back with a `reversal`. Name/icon/cost are snapshotted so later catalog edits don't rewrite history.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| catalog_id | INTEGER | FK → Reward Catalog (SET NULL), nullable |
| reward_name / reward_icon / cost | TEXT / TEXT / INTEGER | snapshot at request time |
| status | TEXT | pending / fulfilled / rejected / cancelled |
| note | TEXT | optional member note |
| requested_by / decided_by | INTEGER | FK → Users (SET NULL) |
| decided_at | TEXT | ISO timestamp, nullable |

**Reward Ledger** — the single source of truth. Every earn / bonus / redeem / adjust / reversal is one immutable, auditable row.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| delta | INTEGER | NOT NULL — positive = earned/bonus, negative = redeemed/correction |
| type | TEXT | earn / bonus / redeem / adjust / reversal |
| reason | TEXT | e.g. the task title or reward name |
| task_id | INTEGER | FK → Tasks (SET NULL), nullable — partial UNIQUE `(task_id, user_id) WHERE type='earn'` |
| redemption_id | INTEGER | FK → Reward Redemptions (SET NULL), nullable |
| created_by | INTEGER | FK → Users (SET NULL) |

### Shopping Lists
| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL (e.g. "Supermarket", "Hardware store") |

### Shopping Items
| Column | Type | Constraint |
|--------|------|-----------|
| list_id | INTEGER | FK → Shopping Lists, NOT NULL |
| name | TEXT | NOT NULL |
| quantity | TEXT | e.g. "500g", "2 pieces" |
| category | TEXT | FK → Shopping Categories (by name) |
| is_checked | INTEGER | 0/1 |
| added_from_meal | INTEGER | FK → Meals, nullable |
| notes | TEXT | Optional free-text note (brand, size, instructions); searchable |
| url | TEXT | Optional http(s) product/store link (scheme-validated) |

Notes and links are edited in a per-item detail drawer (progressive disclosure); the quick-add row
stays name/quantity/category only. A subtle inline icon marks items that carry a note or link. The
note is indexed in the global search.

### Shopping Categories
Custom, household-wide category list for shopping items. Replaces the old hardcoded category set.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY |
| name | TEXT | NOT NULL UNIQUE |
| icon | TEXT | NOT NULL DEFAULT `tag` — Lucide icon name, shown on the aisle group heading |
| sort_order | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | |

### Meals
| Column | Type | Constraint |
|--------|------|-----------|
| date | TEXT | DATE, NOT NULL |
| meal_type | TEXT | breakfast, lunch, dinner, snack |
| title | TEXT | NOT NULL |
| notes | TEXT | |
| recipe_url | TEXT | nullable, URL to recipe |
| recipe_id | INTEGER | FK → Recipes (ON DELETE SET NULL), nullable |
| recurrence_template_id | INTEGER | FK → Meal Recurrence Templates (ON DELETE SET NULL), nullable |
| created_by | INTEGER | FK → Users, NOT NULL |

### Meal Recurrence Templates
Weekly meal templates created from the meal modal's advanced repeat option (v0.78.1).

| Column | Type | Constraint |
|--------|------|-----------|
| start_date | TEXT | DATE, NOT NULL — first date eligible for materialization |
| end_date | TEXT | DATE, nullable — last date eligible for materialization; NULL means the series never ends (v1.66.0) |
| weekday | INTEGER | 0–6, Monday-based |
| meal_type | TEXT | breakfast, lunch, dinner, snack |
| title | TEXT | NOT NULL |
| notes | TEXT | |
| recipe_url | TEXT | nullable |
| recipe_id | INTEGER | FK → Recipes (ON DELETE SET NULL), nullable |
| created_by | INTEGER | FK → Users, NOT NULL |

### Meal Recurrence Ingredients
Ingredient snapshot copied to each generated weekly meal occurrence.

| Column | Type | Constraint |
|--------|------|-----------|
| template_id | INTEGER | FK → Meal Recurrence Templates (CASCADE delete), NOT NULL |
| name | TEXT | NOT NULL |
| quantity | TEXT | |
| category | TEXT | NOT NULL (default 'Sonstiges') |

### Meal Recurrence Exceptions
Stores individual skipped recurring meal dates so deleting a single occurrence (scope: this date only) does not regenerate it. Deleting the whole series drops the template and cascades these exceptions away; ending a series from a given date (scope: this and all following) clears the exceptions behind the new end, since there is nothing left to skip.

| Column | Type | Constraint |
|--------|------|-----------|
| template_id | INTEGER | FK → Meal Recurrence Templates (CASCADE delete), NOT NULL |
| date | TEXT | DATE, NOT NULL |
| created_by | INTEGER | FK → Users (ON DELETE SET NULL), nullable |
| PRIMARY KEY | | (template_id, date) |

### Recipes
Reusable recipe cards that can be pre-filled into meal slots.

| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | NOT NULL |
| notes | TEXT | |
| recipe_url | TEXT | nullable |
| meal_types | TEXT | NOT NULL, default `breakfast,lunch,dinner,snack` — comma-separated suitability list; drives which planner slots a recipe fits and the week randomizer's candidate pool (v1.3.0) |
| created_by | INTEGER | FK → Users (CASCADE delete) |
| provider_account_id | INTEGER | nullable, FK → Recipe Provider Accounts (CASCADE delete); NULL = native recipe, set = mirrored (migration v118, renamed v132) |
| provider_recipe_id | TEXT | nullable (the provider's own recipe ID; upsert key on repeated syncs, migration v118, renamed v132) |
| provider_updated_at | TEXT | nullable (the provider's `updatedAt`; unchanged recipes are skipped, migration v118, renamed v132) |
| provider_slug | TEXT | nullable, adapter-defined (Mealie: its recipe slug, for rebuilding `recipe_url` without a re-fetch; Tandoor: the relative image path, for the thumbnail proxy; migration v120, renamed v132) |
| provider_has_image | INTEGER | 0/1, NOT NULL default 0 (migration v120, renamed v132) |

UNIQUE partial index on `(provider_account_id, provider_recipe_id)` where `provider_account_id IS NOT NULL`.

### Recipe Ingredients
| Column | Type | Constraint |
|--------|------|-----------|
| recipe_id | INTEGER | FK → Recipes (CASCADE delete), NOT NULL |
| name | TEXT | NOT NULL |
| quantity | TEXT | |
| category | TEXT | NOT NULL (default 'Sonstiges') |

### Recipe Provider Accounts (migration v118, v119, v132)
Connections to a self-hosted recipe provider instance ([Mealie](https://mealie.io) or [Tandoor](https://tandoor.dev))
for the Recipes module. Admin-managed in Settings → Kitchen. The mirror is **read-only**: the provider
stays the source of truth for recipe content, so editing or deleting a mirrored recipe returns 403
server-side (not merely hidden in the UI) — "Duplicate" forks one into an editable native recipe instead.

| Column | Type | Constraint |
|--------|------|-----------|
| provider | TEXT | NOT NULL, default `'mealie'`, CHECK IN (`'mealie'`, `'tandoor'`) (migration v132) |
| name | TEXT | NOT NULL (display name) |
| base_url | TEXT | NOT NULL, UNIQUE — must be reachable **from the server** (often a Docker-internal Compose hostname) |
| external_url | TEXT | nullable (migration v119) — public address used only to build "Open in Mealie/Tandoor" deep links; falls back to `base_url` when blank |
| api_token | TEXT | NOT NULL (write-only; never returned by the API, protected by optional SQLCipher) |
| enabled | INTEGER | 0/1, NOT NULL default 1 |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at / updated_at | TEXT | ISO 8601 (`updated_at` via trigger) |
| last_sync | TEXT | nullable |
| last_error | TEXT | nullable |

`base_url` is UNIQUE so the same provider server cannot be added twice and mirror every recipe in
duplicate. Deleting an account cascades to its mirrored recipes.

**Adapters:** each provider implements a shared interface (`server/services/recipe-providers/index.js`
dispatches on the `provider` column, mirroring the DMS module's paperless/papra pattern) —
`testConnection()`, `listRecipeSummaries()`, `getRecipe()`, `recipeUrl()`, `fetchThumbnail()`. Adding a
third provider means implementing this interface, not touching sync/routes/frontend.

**Sync:** hourly scheduler plus a manual trigger, `server/services/recipe-provider-sync.js`, provider-
agnostic — it iterates every enabled account regardless of provider in one pass. A failed or empty fetch
never prunes existing mirrored recipes — an unreachable provider leaves the local copies alone rather
than emptying the module. Ingredients are matched best-effort to shopping categories on import, so a
mirrored recipe transfers to the shopping list like any other. Routes live under `/recipe-providers`,
registered against the existing `meals` scope module, so per-member restricted access still applies;
account CRUD, manual sync and connection test are admin-only, `GET /recipe-providers/status` is open to
any authenticated user. `GET /recipes/:id/provider-thumbnail` proxies the provider's image server-side
(same MIME allowlist and security headers as the DMS thumbnail proxy) because each provider's media
endpoint requires the same Bearer token as every other endpoint, and that token must never reach the
browser.

### Meal Ingredients
| Column | Type | Constraint |
|--------|------|-----------|
| meal_id | INTEGER | FK → Meals, NOT NULL |
| name | TEXT | NOT NULL |
| quantity | TEXT | |
| on_shopping_list | INTEGER | 0/1 |

### Pantry Locations (migration v108)
Storage places for the pantry. Renameable and sortable like Shopping Categories; seeded in German
and translated for the seeded names only, so a household that renames one keeps its own wording.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL, UNIQUE |
| icon | TEXT | NOT NULL (default 'package') |
| sort_order | INTEGER | NOT NULL (default 0) |

### Pantry Items (migration v108, v109)
What is actually in the house. One row is one batch: two packs of milk with different best-before
dates are two rows, which keeps the model flat instead of nesting batches under a product.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| quantity | REAL | NOT NULL (default 1) — numeric, unlike the free-text `quantity` of recipe/meal ingredients, so the stepper can decrement it and it can be compared against `min_quantity` |
| unit | TEXT | NOT NULL (default 'pcs') — canonical key from `public/utils/pantry-units.js`; deliberately no CHECK constraint, because adding a unit would otherwise mean a SQLite table rebuild |
| location_id | INTEGER | FK → Pantry Locations (SET NULL) — deleting a location never destroys stock |
| category | TEXT | NOT NULL (default 'Sonstiges') — shares the Shopping Categories vocabulary |
| expires_on | TEXT | nullable, `YYYY-MM-DD`; NULL means it does not expire |
| min_quantity | REAL | nullable; at or below this amount the item counts as running low |
| notes | TEXT | |
| created_by | INTEGER | FK → Users (**SET NULL**, nullable since v109) — the pantry is household property, not private property, so removing a member must not delete the household's stock (v1.55.0) |

Expiry and stock status are derived in the client, not stored: "expired" depends on the user's local
calendar day, and the server reasons in UTC. The threshold for "expiring soon" is seven days.

### Calendar Events
| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | NOT NULL |
| description | TEXT | |
| start_datetime | TEXT | DATETIME, NOT NULL |
| end_datetime | TEXT | DATETIME |
| all_day | INTEGER | 0/1 |
| location | TEXT | |
| color | TEXT | HEX |
| icon | TEXT | Lucide icon name, default 'calendar' |
| assigned_to | INTEGER | FK → Users (legacy single-user field, kept for backwards compat) |
| created_by | INTEGER | FK → Users, NOT NULL |
| external_calendar_id | TEXT | ID from external calendar |
| external_source | TEXT | local, google, apple, ics, caldav |
| recurrence_rule | TEXT | iCal RRULE — supported subset `FREQ` (DAILY/WEEKLY/MONTHLY/YEARLY), `INTERVAL`, `BYDAY`, and a mutually-exclusive end condition `UNTIL` **or** `COUNT` |
| tzid | TEXT | IANA time zone of a synced recurring series (e.g. `Europe/Berlin`), nullable (migration v97). Lets the expansion keep the local wall-clock time across DST; NULL = floating/UTC |
| subscription_id | INTEGER | FK → ICS Subscriptions (CASCADE delete) |
| user_modified | INTEGER | 0/1 — prevents sync overwrite when 1 |
| calendar_ref_id | INTEGER | FK → External Calendars (ON DELETE SET NULL) |
| attachment_name | TEXT | Original filename of attached file, nullable |
| attachment_mime | TEXT | MIME type (e.g. image/jpeg, application/pdf), nullable |
| attachment_size | INTEGER | File size in bytes, nullable |
| attachment_data | TEXT | Legacy Base64 data URL of attachment (≤ 5 MB), nullable; new attachments leave this NULL |
| attachment_document_id | INTEGER | FK → Family Documents (SET NULL on delete), nullable (migration v38) |
| target_caldav_account_id | INTEGER | FK → CalDAV Accounts (for outbound sync), nullable |
| target_caldav_calendar_url | TEXT | CalDAV calendar URL (for outbound sync), nullable |
| target_google_calendar_id | TEXT | Google calendar ID for outbound sync, nullable. Mutually exclusive with the CalDAV target columns — an event syncs to at most one destination |
| visibility | TEXT | NOT NULL DEFAULT `all` — `all` \| `assignees` \| `private`; who may see the event (migration v78, same rule as Tasks) |

**Visibility (migration v78):** the same `all` / `assignees` / `private` model and server-side, no-admin-bypass enforcement described under [Tasks](#tasks) applies to calendar events, on every read path (list, detail, upcoming, search, MCP). It is an **in-app** control — the ICS calendar export feed is deliberately not filtered by it. Set via the visibility selector in the event dialog.

### Event Assignments
Join table for multi-person calendar event assignment (migration v32). Existing `assigned_to` values were migrated automatically.

| Column | Type | Constraint |
|--------|------|-----------|
| event_id | INTEGER | FK → Calendar Events (CASCADE delete), NOT NULL |
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| PRIMARY KEY | | (event_id, user_id) |

### Calendar Event Exceptions
Excluded single occurrences of a recurring series (EXDATE, migration v85). One row per excluded instance date.

| Column | Type | Constraint |
|--------|------|-----------|
| event_id | INTEGER | FK → Calendar Events (CASCADE delete), NOT NULL |
| exception_date | TEXT | YYYY-MM-DD — local start date of the excluded instance, NOT NULL |
| created_at | TEXT | DATETIME, default now |
| PRIMARY KEY | | (event_id, exception_date) |

**Editing and deleting occurrences of a recurring series (migration v85 · #532):** deleting *or* editing an event of a recurring series offers the standard scope choice — *only this event*, *this and following*, or the *whole series* — via one shared control (a select defaulting to "only this event", the least-destructive option). **Delete:** "only this event" records an exception (EXDATE) and the series continues; "this and following" truncates the series' RRULE with an `UNTIL` bound at the day before the occurrence (or deletes the whole series when the occurrence is the first); "whole series" deletes the master. **Edit:** "only this event" writes an exception for that date and creates a detached, non-recurring event carrying the edits; "this and following" truncates the master and creates a new series from the occurrence with the edited fields; "whole series" updates the master while preserving its `DTSTART` (the edited instance's time shift is re-applied to the series anchor instead of re-anchoring the series to the instance). The recurrence expansion skips excluded dates on every read path (list, upcoming/dashboard, search), and exceptions are emitted as `EXDATE` lines in the ICS export feed. The scope choice is offered for **local series only** — externally synced series (Google/Apple/CalDAV via `calendar_ref_id`, ICS via `subscription_id`) keep whole-series behavior, since an EXDATE or truncation would return on the next sync. `POST /api/v1/calendar/:id/exceptions { date }` records an exception; series deletion removes its exceptions via CASCADE.

**Finite recurrences via `COUNT` (#513):** a series may end after a fixed number of occurrences (`COUNT=N`) instead of on a date (`UNTIL`) — the two are mutually exclusive. `COUNT` counts from the series start and **includes** excluded occurrences (RFC 5545: the limit applies to the recurrence set *before* `EXDATE` removal), so `COUNT=10` with one excluded date yields nine visible instances. The event dialog exposes this as an *Ends: Never / On date / After N occurrences* selector (calendar only — tasks are completion-driven and keep Never / On date). A one-time ICS import preserves `COUNT` on the stored rule and records the file's `EXDATE` lines as exceptions, so a finite Google/Apple export stays finite instead of becoming an endless series; ICS subscriptions honour `COUNT` and `EXDATE` the same way when expanding the feed.

### Calendar defaults for new events (per-user)
Three per-user preferences prefill the new-event dialog (stored in `sync_config` under a per-user key, like `module_order`):
- **`calendar_default_reminders`** — a list of reminder offsets (minutes before start, subset of the reminder presets, max 5) that new events receive automatically.
- **`calendar_default_assign_me`** — when on, new events are pre-assigned to the current user.
- **`calendar_default_target`** (#620) — the sync target a new event starts out pointing at. Stores the same identifier the event dialog uses: `''` (store locally only), `google:<calendarId>` or `caldav:<accountId>|<calendarUrl>`, built and parsed by the shared isomorphic util `public/utils/sync-target.js` so that server validation and both front-end call sites cannot drift apart. The server validates the *shape* only, never the existence: a calendar may be disabled, deleted or turned read-only long after it was chosen here, and checking on save would pull a Google API call into every settings write without preventing that. Instead the event dialog resolves it at open time — a target that is no longer offered leaves the selection on "store locally only" rather than pointing a new event at a calendar that cannot accept it. The settings field is hidden while no Google or CalDAV calendar is connected, but reappears whenever a target is stored, so a stale one can always be cleared.

All three are configured in Settings → Personal → Event defaults and apply only when creating an event (never on edit); a date-based sync default assignee still takes precedence for imported events. Per-user rather than household-wide by design: which calendar a person feeds is a personal decision, and the inverse mapping already exists as `external_calendars.default_assignee_user_id` (which person imported events from a calendar are assigned to).

### External Calendars
Display metadata (name, color) for synced Google/CalDAV calendars. Populated automatically during sync.

| Column | Type | Constraint |
|--------|------|-----------|
| source | TEXT | 'google' or 'caldav', NOT NULL (legacy 'apple' entries migrated to 'caldav' in v0.44.0) |
| external_id | TEXT | Calendar ID from the provider, NOT NULL |
| name | TEXT | Display name from the provider, NOT NULL |
| color | TEXT | Background color from the provider (HEX) |
| default_assignee_user_id | INTEGER | FK → Users, nullable — default assignee for newly imported events of this calendar (migration v79) |
| UNIQUE | | (source, external_id) |

**Default assignee per sync target (migration v79):** each synced calendar (Google/Apple/CalDAV via `external_calendars`, and each ICS subscription) can carry an optional `default_assignee_user_id`. Newly imported events of that target are automatically assigned to that person — **new events only**, never retroactively, so a manually removed assignment does not reappear on the next sync. Configured per calendar row in Settings → Sync (the picker appears once a calendar has completed its first sync). Nulled automatically when the referenced user is deleted.

### Holiday Cache
Cached public holidays and school holidays from the free [OpenHolidays API](https://openholidaysapi.org)
(no API key). Populated by an admin-configured country/subdivision in Settings → Modules → Calendar and refreshed
by the auto-sync scheduler (covers previous, current, and next two years). Displayed as a read-only
overlay in the calendar; layer visibility is toggled client-side. Outbound requests carry only the
country/subdivision code — no household data leaves the server.

Some multilingual subdivisions (e.g. the Swiss canton `CH-BE`) run more than one school-holiday
regime with differing dates, distinguished only by an OpenHolidays *group* (`CH-BE-VS` German-speaking
vs. `CH-BE-EO` French-speaking Bernese Jura). When such a subdivision is configured, the settings page
offers an optional school-holiday-group picker; the chosen group filters the overlay to that regime so
the calendar shows the correct dates instead of the union of both.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| type | TEXT | 'public' or 'school', NOT NULL |
| country | TEXT | ISO-3166 alpha-2 country code, NOT NULL |
| subdivision | TEXT | Region code (e.g. `DE-BY`), nullable for whole-country |
| start_date | TEXT | YYYY-MM-DD, NOT NULL |
| end_date | TEXT | YYYY-MM-DD, NOT NULL |
| name | TEXT | Localized holiday name, NOT NULL |
| year | INTEGER | Source year (used for scoped re-sync), NOT NULL |
| group_code | TEXT | School-holiday group (e.g. `CH-BE-VS`) for multilingual subdivisions; nullable (applies to the whole subdivision, e.g. public holidays) |

Indexes: `idx_holiday_cache_dates (start_date, end_date)`, `idx_holiday_cache_lookup (type, country, subdivision, year)`.
Configuration lives in `sync_config`: `holiday_country`, `holiday_subdivision`, `holiday_group`, `holiday_show_public`,
`holiday_show_school`, `holiday_public_color`, `holiday_school_color`, `holiday_last_sync` (all admin-only).

### CalDAV Accounts
Multi-account CalDAV integration. Stores credentials for CalDAV servers (iCloud, Nextcloud, Radicale, Baikal, etc.).

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name | TEXT | User-defined label (e.g. "My Radicale", "iCloud"), NOT NULL |
| caldav_url | TEXT | CalDAV server base URL, NOT NULL |
| username | TEXT | CalDAV username, NOT NULL |
| password | TEXT | CalDAV password (encrypted if DB_ENCRYPTION_KEY set), NOT NULL |
| created_at | TEXT | ISO 8601 |
| last_sync | TEXT | ISO 8601, nullable |
| reminders_discovered_at | TEXT | ISO 8601, nullable (migration v125) - `NULL` means no reminder-list discovery has run for this account yet |
| UNIQUE | | (caldav_url, username) |

`reminders_discovered_at` exists because an empty selection is ambiguous on its own: a server with no
`VTODO` collections leaves the table empty forever, so "no rows" cannot distinguish "never looked"
from "looked, found nothing" and every settings-page load would query the server again.

### CalDAV Calendar Selection
Per-account calendar enable/disable state for CalDAV accounts. A collection that does not accept
`VEVENT` is dropped from the selection on the next sync run (v1.75.7 · #617), which is how accounts
created before the component filter shed the task lists they had adopted as calendars. Disabling
happens before the run records the calendar as fetched, so the prune leaves events already mirrored
from it untouched.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| account_id | INTEGER | FK → CalDAV Accounts (CASCADE delete), NOT NULL |
| calendar_url | TEXT | CalDAV calendar URL from provider, NOT NULL |
| calendar_name | TEXT | Display name from provider, NOT NULL |
| calendar_color | TEXT | HEX color code from provider, nullable |
| enabled | INTEGER | 0/1 (default 1), controls sync for this calendar |
| created_at | TEXT | ISO 8601 |
| UNIQUE | | (account_id, calendar_url) |

Index: CREATE INDEX idx_caldav_selection_enabled ON caldav_calendar_selection(account_id, enabled)

**Inbound sync and deletions (#508):** CalDAV calendars are synced by the auto-sync scheduler every
`SYNC_INTERVAL_MINUTES` (default 15), alongside Google, ICS, CalDAV reminders and holidays. Each run
upserts the events of every enabled calendar and then deletes local events whose UID the calendar no
longer returns, so removing an event in iCloud/Nextcloud also removes it in Yuvomi. Deletion is scoped
to `external_source = 'caldav'` rows of that calendar: local events and outbound events still waiting
to be uploaded are never touched, and an event moved between two calendars of the same account is kept
rather than deleted and re-created. If a calendar returns no events at all while local events still
reference it, the deletion step is skipped and a warning is logged, since an empty response is far
more often a transient server or auth error than a genuinely emptied calendar. Calendars whose fetch
fails are never pruned at all.

The same deletion pass runs for the legacy single-account Apple sync (`external_source = 'apple'`);
both providers share `server/services/calendar-prune.js`. Google needs no such pass: its sync-token
delta reports deletions actively as `status: 'cancelled'`. ICS subscriptions prune per feed, guarded
by `user_modified = 0`.

### Google Calendar Selection
Per-calendar enable/disable state for the connected Google account (migration v47). Mirrors the
CalDAV selection model so multiple Google calendars sync and display at once. Each row carries its
own incremental `sync_token`, because Google's `events.list` sync token is per-calendar.

| Column | Type | Constraint |
|--------|------|-----------|
| calendar_id | TEXT | PRIMARY KEY — Google calendar ID (`primary`, email-like, …) |
| name | TEXT | Display name, NOT NULL |
| color | TEXT | HEX color from provider, nullable |
| enabled | INTEGER | 0/1 (default 1), controls sync for this calendar |
| sync_token | TEXT | Per-calendar incremental Google sync token, nullable |
| last_sync | TEXT | ISO 8601, nullable |

Index: CREATE INDEX idx_google_selection_enabled ON google_calendar_selection(enabled)

Disabling a calendar removes its imported events and clears its `sync_token`, so re-enabling
performs a clean full resync. Migration v47 carries any previously single-selected
`sync_config.google_calendar_id` (Issue #220) into one enabled row.

### Calendar Pending Deletions
Tombstones for events deleted in Yuvomi that still exist at the provider (migration v103, #593).
Deleting a mirrored event locally must delete it remotely too, but the provider call is async and
must neither delay the `204` nor let a network error abort the local delete — so the row outlives
the deleted event and is worked off by the sync (at-least-once).

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| source | TEXT | NOT NULL — currently only `google`; the column exists so CalDAV/Apple can reuse the table |
| calendar_external_id | TEXT | NOT NULL — provider calendar the event lives in |
| event_external_id | TEXT | NOT NULL — provider event ID |
| attempts | INTEGER | NOT NULL, default 0 — failed remote deletions so far |
| last_error | TEXT | nullable, truncated to 500 chars |
| created_at | TEXT | ISO 8601, NOT NULL |

Constraints: UNIQUE(source, calendar_external_id, event_external_id) ·
Index: CREATE INDEX idx_cal_pending_del_event ON calendar_pending_deletions(source, event_external_id)

Rows are created **only** by the explicit user delete (`DELETE /api/v1/calendar/:id`), never by a
database trigger: the inbound sync deletes local rows as well (cancelled events, deselected
calendars), and a trigger would turn those into delete calls against the provider.

The counterpart for *edits* lives on the event row itself (migration v104): `outbound_dirty` (0/1)
marks a mirrored event whose local change still has to reach the provider, and `outbound_attempts`
counts failed pushes under the same five-attempt limit. Deliberately **not** `user_modified` — that
flag means "touched locally, don't overwrite the color" permanently and would re-push the event on
every sync run; `outbound_dirty` is a queue, set on edit and cleared after the push. Only changes to
the mirrored fields (`title`, `description`, `location`, `color`, `all_day`, `start_datetime`,
`end_datetime`, `recurrence_rule`) set it — assignment, visibility, icon and attachments are
Yuvomi-internal.

`external_object_url` (migration v106) holds the URL of the CalDAV calendar object an event lives
in. CalDAV has no "change event X in calendar Y" call — an object is addressed by its own URL via
PUT/DELETE — and the inbound sync used to discard it, which is why outbound was limited to creating
there. The column is nullable and not backfilled: for events synced before the upgrade the URL is
simply not known yet, the next inbound run fills it in, and until then a deletion resolves the URL
from the UID of the objects that run just fetched (a backfill would need exactly the same request).

`outbound_move_to` (migration v105) holds the destination calendar of a pending move, `NULL` when
none is queued. It is set from the *change in the request*, never derived by comparing
`target_google_calendar_id` against the actual calendar: existing databases can carry a divergence
there, because the field was always settable but had no effect on already-mirrored events, and a
state comparison would turn that into a silent wave of moves across users' Google calendars on the
first sync after the upgrade.

### CalDAV Reminder Selection
Per-account reminder-list selection for CalDAV accounts. Apple Reminders lists are CalDAV
collections whose supported components include `VTODO`, so any CalDAV server serving `VTODO`
collections works (iCloud, Radicale, Nextcloud), not just Apple. Reuses the same CalDAV Accounts;
each enabled list is mirrored **in both directions** (v1.68.0 · #617) into the Tasks or Shopping
module.

Discovery and the calendar selection share one component rule (v1.75.7 · #617): a collection is
offered as a reminder list if it accepts `VTODO`, and as a calendar if it accepts `VEVENT`, so a
pure task list is never proposed as a place to store appointments. `supported-calendar-component-set`
is optional per RFC 4791 §5.2.3, and when a server omits it every component counts as supported;
filtering strictly on the property instead would hide every collection such a server offers. The
search runs on first open of the reminder page rather than only on the refresh button: adding an
account discovers calendars alone, so the page used to show an empty state while the server was
serving lists all along. A discovered list starts **disabled** on purpose, because switching them on
by default would pull a server's existing VTODOs into the Tasks module unannounced.

A VTODO's `CATEGORIES` arrive as tags (#586): two-way for tasks (see [Task Tags](#task-tags-migration-v115-586)), inbound only for shopping items (see [Shopping Item Tags](#shopping-item-tags-migration-v116-586)). They are never mapped onto the module's own category — a task or item sits in exactly one category, but a VTODO may carry any number of categories, and folding them together would drop every value after the first and pull foreign values into a managed list.

**Subtask hierarchy via `RELATED-TO` (v1.78.1, #671).** Apple Reminders, Nextcloud Tasks and Tasks.org express a subtask by putting `RELATED-TO` on the **child**, carrying the parent's UID. Until v1.78.1 the parser never read the property, so every subtask arrived as a top-level task standing next to its parent — a reporter's five-item checklist showed up as five separate entries. `RELTYPE` is optional and defaults to `PARENT` (RFC 5545 §3.2.15), so a bare `RELATED-TO` is already the parent link; the rarer opposite direction (`RELTYPE=CHILD` on the parent) is read too, `SIBLING` is discarded. Resolution runs as a second pass once every list of the account has been read, because a child may appear before its parent in the object stream and across list boundaries at that. Three deliberate edges: CalDAV allows arbitrarily deep chains while Yuvomi allows one level, so a grandchild is attached to its topmost ancestor rather than dropped; a relation that disappears server-side is written back as `NULL`, otherwise an item pulled out of a sublist would stay a child forever; and a cycle or self-reference leaves the rows flat instead of looping. The outbound direction needs no counterpart — it patches the original calendar object and therefore preserves relations Yuvomi does not manage.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| account_id | INTEGER | FK → CalDAV Accounts (CASCADE delete), NOT NULL |
| list_url | TEXT | CalDAV VTODO collection URL from provider, NOT NULL |
| list_name | TEXT | Display name from provider, NOT NULL |
| target_module | TEXT | 'tasks' or 'shopping' (default 'tasks') |
| target_list_id | INTEGER | FK → Shopping Lists (SET NULL on delete), nullable; auto-created when mapped to Shopping |
| enabled | INTEGER | 0/1 (default 0 — reminders are opt-in), controls sync for this list |
| created_at | TEXT | ISO 8601 |
| UNIQUE | | (account_id, list_url) |

Index: CREATE INDEX idx_caldav_reminder_selection_enabled ON caldav_reminder_selection(account_id, enabled)

The `tasks` and `shopping_items` tables carry `external_uid`, `external_source` (default `'local'`,
set to `'caldav'` for imported reminders), and `external_account_id` columns for this linkage.
Imported rows are keyed on `(external_source, external_account_id, external_uid)`; items that
disappear from the remote list are pruned on the next sync.

**Outbound: local change → server (migration v113 · #617).** Editing, completing or deleting a
mirrored task or shopping item is pushed back to the CalDAV server. Same shape as the calendar
outbound path (#593): the intent is recorded synchronously in the route handler, executed after the
response, and retried by the next sync run (at-least-once, given up after 5 attempts).

- `tasks` and `shopping_items` gain `external_object_url` (CalDAV addresses an object by *its own*
  URL — there is no "change item X in list Y"), `outbound_dirty` and `outbound_attempts`.
- `caldav_todo_pending_deletions` (`account_id`, `module`, `uid`, `object_url`, `attempts`,
  `last_error`, UNIQUE `(account_id, module, uid)`) outlives the deleted row, which is where the UID
  and object URL would otherwise be read from. Separate from `calendar_pending_deletions`, whose key
  is cut for calendars and events; the failure and give-up rules stay shared
  (`calendar-outbound.js: outboundFailureAction`).
- A change is a **patch of the original object**, never a rebuild: only the mirrored properties
  (`SUMMARY`, `DESCRIPTION`, `DUE`, `PRIORITY`, `STATUS`, `COMPLETED`, `PERCENT-COMPLETE`) are
  replaced, so alarms, categories and client-specific properties survive. Mirrored fields are
  title/name, description, priority, status/checked and due date — category, assignment, points,
  visibility and subtasks are Yuvomi-internal and never trigger a push.
- The inbound pass skips rows with a pending push (the stale server state must not overwrite them)
  and does not re-create a locally deleted row while its tombstone is open.
- **Creating** is deliberately out of scope: unlike an event, a task carries no selectable target —
  it belongs to the list it came from. Locally created tasks stay local.
- **Lossy mappings are held from both ends.** Yuvomi has four priority levels and four statuses,
  RFC 5545 three priority bands and no "in progress". `urgent`/`high` share the top band and
  `in_progress`/`archived` both map out as "not completed", so the inbound keeps the finer local
  value whenever the server reports the same band — otherwise every pushed *urgent* task would come
  back as *high* on the next run.
- **`DUE` is an instant, `due_date`/`due_time` are wall-clock (#617).** A task carries no TZID, so a
  due time with a zone is converted into the household zone (`TZ` env → system zone → UTC) on the
  way in and back on the way out. Before the fix a task due at 16:30 showed up as 14:30, shifted by
  exactly the zone offset. A floating `DUE` (no zone at all) is already wall-clock and is left alone.

**Deleting the account detaches its mirrored rows (migration v123 · #617).**
`external_account_id` carries no foreign key, so `CASCADE` reaches only what belongs to the account
itself - calendar and list selection and the open VTODO deletions. The mirrored tasks and shopping
items are user data and stay, but a dangling account ID made them **undeletable**:
`queueTodoDeletion()` records the deletion in `caldav_todo_pending_deletions`, which *does* carry
the foreign key, and that insert runs before the local `DELETE` - so the row could not be removed at
all, while its remote copy was already out of reach. `deleteAccount` now detaches the rows in the
same transaction that removes the account: back to `external_source = 'local'`, with UID, account
ID, object URL and outbound markers cleared, so what remains is an ordinary task or shopping item.
Migration v123 cleans up rows left behind by earlier deletions, and the outbound path additionally
skips any row whose account is gone - the same precondition `acceptsOutbound()` applies to events.
The foreign key is deliberately not retrofitted: SQLite cannot add one to an existing column without
rebuilding `tasks` and `shopping_items` along with their indexes, FTS triggers and referencing
tables.

**Pruning guards (#508):** a reminder list that cannot be fetched suspends the deletion pass for its
whole target module. `tasks` and `shopping_items` only carry the account ID, not the list URL, so a
prune cannot be narrowed to a single list — pruning anyway would delete the rows of the list that
merely looks empty because of a server error. Likewise, an empty result never means "delete
everything": if the server returns no reminders while local rows still exist, nothing is deleted and
a warning is logged. Deleting a mirrored task takes its subtasks, assignments and document links with
it via CASCADE, and a re-import creates a new row, so a wrong deletion is not recoverable by syncing
again. The trade-off is that a genuinely emptied list keeps its local rows until they are removed by
hand.

### Notes
| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | nullable |
| content | TEXT | NOT NULL |
| color | TEXT | HEX |
| pinned | INTEGER | 0/1 |
| created_by | INTEGER | FK → Users, NOT NULL |

### Contacts
| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL — display name, derived from the components below when they are set |
| first_name | TEXT | nullable (migration v94) — vCard `N` given name |
| last_name | TEXT | nullable (migration v94) — vCard `N` family name; the sort key |
| middle_name | TEXT | nullable (migration v94) — vCard `N` additional names |
| name_prefix | TEXT | nullable (migration v94) — vCard `N` prefix (title), stored but not displayed |
| name_suffix | TEXT | nullable (migration v94) — vCard `N` suffix, stored but not displayed |
| category | TEXT | FK → Contact Categories (by key), NOT NULL default `misc` |
| phone | TEXT | legacy single-value field |
| email | TEXT | legacy single-value field |
| address | TEXT | legacy single-value field |
| notes | TEXT | |
| organization | TEXT | nullable |
| job_title | TEXT | nullable |
| birthday | TEXT | DATE, nullable |
| website | TEXT | nullable |
| photo | TEXT | Base64 data URL, nullable |
| nickname | TEXT | nullable |
| family_user_id | INTEGER | FK → Users (CASCADE delete), UNIQUE (one linked user per contact), nullable |
| carddav_account_id | INTEGER | FK → CardDAV Accounts (SET NULL on delete), nullable |
| carddav_uid | TEXT | CardDAV UID from server, nullable |
| carddav_addressbook_url | TEXT | Source addressbook URL, nullable |
| carddav_origin | TEXT | `remote` \| `merged`, nullable (migration v89) — how the CardDAV link came about; drives what a server-side deletion does |

Index: UNIQUE on `(carddav_account_id, carddav_addressbook_url, carddav_uid)` WHERE `carddav_uid IS NOT NULL`

**Structured name components (migration v94, v1.38.0):** CardDAV sources format the vCard `FN`
property however they like — `Given Family`, `Family, Given`, some with titles or nicknames mixed in.
Storing only that string made display and sorting depend on whichever server a contact came from.
Yuvomi now keeps the structured `N` components (family, given, additional, prefix, suffix) and
derives `name` from them as `Given [Additional] Family`; prefix and suffix are preserved for export
but never shown. `FN` remains the fallback for vCards whose `N` carries no name parts at all (an
empty `N:;;;;` on organisation entries, for example). The contact list sorts by
`COALESCE(NULLIF(last_name,''), name)`, so contacts without components fall back to their display
name. Both the REST API (`POST`/`PUT /api/v1/contacts` accept `firstName`, `lastName`, `middleName`,
`namePrefix`, `nameSuffix` and derive `name` from them) and the vCard export (`N` carries the real
components) use the same shared, isomorphic helper `public/utils/contact-name.js`.

Existing contacts are not guessed at: the columns stay `NULL` until a source fills them. A CardDAV
contact gets them on the next sync; one that was created purely from a vCard (`carddav_origin =
'remote'`) also has its display name normalised once at that point, while an adopted (`merged`)
contact keeps its locally maintained name. In the edit dialog, a contact without components is
pre-filled by splitting the display name at its last word — but that guess is only persisted when
the user actually edits a name field, so changing a phone number never invents a surname for
`AutoHaus König`. Mirrored family/guest contacts (whose `name` follows a user's display name) drop
stale components when that display name changes.

**Server-side deletions (migration v89):** contacts sync automatically on the `SYNC_INTERVAL_MINUTES`
schedule, and each run removes contacts the addressbook no longer returns — but not all of them the
same way. The smart-merge logic adopts a pre-existing local contact when a vCard matches its email or
phone, so a CardDAV-linked contact is not necessarily a pure mirror. `carddav_origin` records this:

- `remote` — created solely from a vCard. Deleted when the server drops it (its phones, emails and
  addresses follow via CASCADE).
- `merged` — an already-existing local contact that was only adopted. It carries locally maintained
  data that never existed on the server, so it is **decoupled** instead: the `carddav_*` columns are
  nulled and it stays as a plain local contact. Re-appearing on the server re-adopts it.

Contacts that predate v89 are backfilled to `merged`, deliberately: their origin is no longer
recoverable, and the conservative assumption costs at most a leftover local contact, whereas the
opposite would destroy user data on the first sync after the update. The same guards as the calendar
prune apply: an addressbook that returns nothing at all, or whose fetch fails, or that contains a
single unparsable vCard, suspends deletion entirely and logs a warning — an incomplete list of UIDs
must never be read as "everything else was deleted".

### Contact Categories (migration v84)
DB-backed, customizable category list for contacts. Replaces the old hardcoded German-named set. The seven predefined keys (`doctor`, `school`, `authority`, `insurance`, `craftsman`, `emergency`, `misc`) carry a stable slug key (which also drives the per-category color tint and, together with `icon`, the list grouping), a localizing `label_key`, and a Lucide `icon`; the pre-existing German category values (`Arzt`, `Behörde`, …) are migrated to these keys. User-added categories store their `name` and default to the `tag` icon. A "Manage categories" button in the contacts toolbar opens the shared `yuvomi-category-manager` modal to add, rename, reorder, and delete categories, with the same in-use / last-category deletion guards as Tasks and Budget.

| Column | Type | Constraint |
|--------|------|-----------|
| key | TEXT | PRIMARY KEY — stable slug (also the CSS color-tint slug) |
| name | TEXT | custom display name; NULL for predefined (localized) categories |
| label_key | TEXT | i18n key for predefined categories; NULL for custom |
| icon | TEXT | NOT NULL DEFAULT `tag` — Lucide icon name |
| sort_order | INTEGER | NOT NULL |
| created_at | TEXT | |

### Contact Phones
Multiple phone numbers per contact with label and primary flag.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| contact_id | INTEGER | FK → Contacts (CASCADE delete), NOT NULL |
| label | TEXT | e.g. "mobile", "work", "home", nullable |
| value | TEXT | NOT NULL — the raw user-entered string, the source of truth; never normalized |
| is_primary | INTEGER | 0/1, default 0 |
| value_e164 | TEXT | nullable — E.164 normalization of `value`, additive (migration v95) |

**Phone formatting & E.164 matching (v1.42.0).** Phone numbers are parsed and formatted with
[libphonenumber-js](https://gitlab.com/catamphetamine/libphonenumber-js), shipped self-hosted under
`public/vendor/libphonenumber/` (a single metadata-free `core.min.mjs` ESM bundle plus a separate
`metadata.min.json`, lazy-loaded only in the contacts module — no CDN, per the no-external-frontend-
dependencies constraint; the CSP `script-src 'self'` is unchanged). The stored `value` is **never**
altered — formatting is a display/helper layer only: the contact list shows numbers formatted
(national for the household's own country, international otherwise; non-parsable values fall back to
the raw string 1:1), `tel:` links prefer a runtime-derived E.164, and the edit form offers a
non-blocking AsYouType preview plus a plausibility hint. The household's default country is derived
from the region preference. The additive `value_e164` column (nullable, backfilled where parsable)
lets the CardDAV sync match contacts independent of format variance (`+49 30 12345678` vs.
`030 12345678`), preventing duplicate contacts; the exact raw-value comparison remains as a fallback,
so a NULL `value_e164` degrades gracefully. E.164 computation is server-side (npm `libphonenumber-js`),
kept in sync wherever `contact_phones` is written (contact routes + sync upsert).

### Contact Emails
Multiple email addresses per contact with label and primary flag.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| contact_id | INTEGER | FK → Contacts (CASCADE delete), NOT NULL |
| label | TEXT | e.g. "work", "home", nullable |
| value | TEXT | NOT NULL |
| is_primary | INTEGER | 0/1, default 0 |

### Contact Addresses
Multiple addresses per contact with label and primary flag.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| contact_id | INTEGER | FK → Contacts (CASCADE delete), NOT NULL |
| label | TEXT | e.g. "home", "work", nullable |
| street | TEXT | nullable |
| city | TEXT | nullable |
| state | TEXT | nullable |
| postal_code | TEXT | nullable |
| country | TEXT | nullable |
| is_primary | INTEGER | 0/1, default 0 |

### CardDAV Accounts
Multi-account CardDAV integration. Stores credentials for CardDAV servers (Nextcloud, iCloud, Radicale, Baikal, etc.).

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name | TEXT | User-defined label (e.g. "My Nextcloud", "iCloud"), NOT NULL |
| carddav_url | TEXT | CardDAV server base URL, NOT NULL |
| username | TEXT | CardDAV username, NOT NULL |
| password | TEXT | CardDAV password (encrypted if DB_ENCRYPTION_KEY set), NOT NULL |
| created_at | TEXT | ISO 8601 |
| last_sync | TEXT | ISO 8601, nullable |
| last_error | TEXT | nullable (migration v92) — failures of the last sync run, joined with ` · `, capped at 500 chars. `NULL` means the last run completed cleanly and is set actively after every run |
| last_error_at | TEXT | ISO 8601, nullable (migration v92) — when `last_error` was recorded |
| UNIQUE | | (carddav_url, username) |

### CardDAV Addressbook Selection
Per-account addressbook enable/disable state for CardDAV accounts.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| account_id | INTEGER | FK → CardDAV Accounts (CASCADE delete), NOT NULL |
| addressbook_url | TEXT | CardDAV addressbook URL from provider, NOT NULL |
| addressbook_name | TEXT | Display name from provider, NOT NULL |
| enabled | INTEGER | 0/1 (default 1), controls sync for this addressbook |
| created_at | TEXT | ISO 8601 |
| last_error | TEXT | nullable (migration v93) — why this addressbook failed in the last run, so the UI can mark the row that caused it. `NULL` means it synced cleanly |
| UNIQUE | | (account_id, addressbook_url) |

Index: CREATE INDEX idx_carddav_addressbook_account ON carddav_addressbook_selection(account_id, enabled)

### Budget Entries
| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | NOT NULL |
| amount | REAL | NOT NULL (positive = income, negative = expense) |
| category | TEXT | FK → Budget Categories (by key), NOT NULL |
| subcategory | TEXT | FK → Budget Subcategories (by key), default '' |
| date | TEXT | DATE, NOT NULL |
| is_recurring | INTEGER | 0/1 |
| recurrence_rule | TEXT | iCal RRULE |
| recurrence_interval | TEXT | The unit: `'weekly'` \| `'monthly'` \| `'yearly'`, default `'monthly'` (migration v128, #636) |
| recurrence_interval_count | INTEGER | NOT NULL DEFAULT 1 — how many units lie between two occurrences (migration v128, #636). `'monthly'` + 6 is the former `'half_year'` |
| recurrence_virtual | INTEGER | 0/1 — 1 = virtual budgeting (period amount smoothed evenly across months) |
| recurrence_confirm | INTEGER | NOT NULL DEFAULT 0 (migration v129, #637) — 1 = generated instances wait for confirmation before they count |
| is_pending | INTEGER | NOT NULL DEFAULT 0 (migration v129, #637) — 1 = expected, not yet booked; visible but excluded from every total |
| recurrence_full_amount | REAL | For virtual series: the entered period amount (`amount` then holds the monthly share) |
| recurrence_parent_id | INTEGER | FK → Budget Entries (generated instance points to original) |
| account_id | INTEGER | FK → Budget Accounts, nullable (ON DELETE SET NULL); NULL = not assigned to an account |
| created_by | INTEGER | FK → Users, NOT NULL |
| owner_id | INTEGER | FK → Users, nullable (ON DELETE SET NULL) — the entry's owner, fixed to the creator on insert (migration v88) |
| visibility | TEXT | NOT NULL DEFAULT `shared` — `private` \| `shared` (migration v88) |

Recurring entries are materialised on demand for the month being viewed. **Non-virtual** series post the full amount on each due date, which `occurrenceDatesInMonth()` derives from the series' start date, unit and count; a weekly series therefore posts several times in one month, a monthly one at most once, and a day-of-month past the end of a short month is clamped to its last day. **Virtual** series store the smoothed monthly share on the original and post it once every month regardless of the rhythm, so a 1,200/year bill shows as 100/month in the summary, balance and CSV export; smoothing goes through `occurrencesPerYear(unit, count)`, which counts a year at 52 weeks. A generated instance inherits its owner and visibility from the series original.

**Unit plus count (migration v128, #636).** Until then the interval was a list of three fixed rhythms, so "every two weeks" or "every three months" could not be expressed at all. It is now a unit (`weekly`/`monthly`/`yearly`) with a count of 1 to 99. `half_year` is gone as a key and lives on as `monthly` + 6; the migration converts existing rows, because two spellings for one rhythm would have to be understood by every evaluation forever. The weekday, or the day of the month, is carried by the entry's own `date` - a series starting on the 15th returns on the 15th - so there is deliberately no separate field for it, which would be a second truth beside `date`.

**Booking only after confirmation (migration v129, #637).** A series can require that each generated booking is confirmed before it counts, because not every service debits on the same day or to the cent. Its instances are created with `is_pending = 1`: they appear in the list, marked as expected, but are **excluded from every total** - monthly summary, category breakdown, statistics, plan progress, account balances and the dashboard widget alike. Counting them would leave exactly the discrepancy against the bank statement that the setting exists to remove. What is still outstanding is reported separately (`pending: { count, income, expenses }` on the summary) and shown under the summary cards, so the money does not silently disappear between the list and the totals. `PATCH /api/v1/budget/:id/confirm` books the entry and takes an optional corrected `amount` and `date` - both are editable because their deviation is the whole point; the sign is preserved, so an expected expense cannot become income by typing the amount without a minus. The exclusion lives in one shared SQL fragment (`bookedOnly()`), and `test:budget-structure` asserts the rule over every `SUM` across `budget_entries` rather than over a list of known call sites: a forgotten one would not fail, it would just quietly show a number that is off by one expected booking. The CSV export keeps expected rows but labels them (`Status` column: `Expected` / `Booked`), since the export is a record. Opt-in per series and default 0 together are what protects existing data: without both, every recurring series would have dropped out of the totals on upgrade.

**Skipping is keyed by day, not by month.** Deleting a generated instance records that occurrence in `budget_recurrence_skipped` (`parent_id`, `date`) so it is not silently recreated on the next visit. That table was keyed by month until v128, which was correct while a series had at most one occurrence per month; with weekly series, deleting one Tuesday would have suppressed the rest of the month as well. The migration converts existing month rows to the day the instance would have carried.

**Monthly summary & expenses-only view:** the Budget tab heads each month with three summary cards - income, expenses and the net balance (income − expenses). When a month records only expenses (no income), the balance card renders neutral instead of red, because a bare `−expenses` net misreads as being "in the red" (#504). A per-device **Expenses only** toggle (persisted client-side in `localStorage`, no server preference) collapses the summary to the single expenses card and hides income and the net, for pure expense tracking; the transaction list, category chart and CSV export are unaffected.

**Receipts (migration v112, #583):** an entry can carry documents from the Documents module as receipts — link an existing document or upload a new file straight from the entry modal. Receipts live in `budget_entry_attachments` (`entry_id`, `document_id`, `created_by`, `UNIQUE(entry_id, document_id)`), so one purchase may hold several (till receipt plus invoice plus warranty). The file itself always belongs to the Documents module: deleting the entry drops the link, not the document; deleting the document drops the link and leaves the entry. **Document visibility keeps applying** — a receipt filed as private stays invisible to everyone else even when it hangs on a shared entry, and there is no admin bypass. You can only link what you may see, and saving an entry only removes the links you can see, so another member's private receipt survives your edit. Receipts belong to the single entry, not to a recurring series: updating a series leaves them untouched (each month's bill has its own receipt). The API takes `attachment_document_ids` on create/update — omitting the field leaves existing receipts alone — and returns the visible ones as `attachments`.

**Personal vs. shared budgets (migration v88):** every budget entry (and loan and subscription) carries an immutable `owner_id` (= the creator) and a `visibility` of `shared` (all members) or `private` (owner only). A household-wide **budget mode** setting (`budget_mode` in `sync_config`, `shared` by default, admin-gated) decides whether visibility is enforced at all: in `shared` mode everyone sees everything (the prior, fully backward-compatible behaviour); in `personal` mode the Budget page gains a **My budget / Household** view switcher — *My budget* shows what you own, *Household* shows the shared pot (`visibility = 'shared'`). Enforcement is **server-side on every read path** (entry list, summary, statistics, CSV export, accounts balances, loans, subscriptions, dashboard widget) with **no admin bypass** — a private entry stays hidden even from an admin. Write access to an object requires ownership (owner or creator), also with no admin bypass. New entries default to `private` in personal mode and `shared` in shared mode. This is the lean variant of the split-budget request (#476/#505): a shared entry is one whole row with a "Household" badge, without materialised per-person split rows.

### Budget Accounts
Separate accounts (checking, savings, cash, credit card, investment, other) shown in Budget → Accounts. Each account carries a starting balance; its **current balance** is `starting_balance + Σ assigned entries dated up to today`, and the **projected balance** additionally includes future-dated entries. The Accounts tab shows every account with its current balance plus the household **net worth** (sum of the active accounts' current balances). Entries optionally reference an account (`budget_entries.account_id`); the assignment is set from the entry modal. Deleting an account keeps its entries — their `account_id` is cleared. Account assignment is optional; existing entries stay unassigned. Accounts themselves have no owner or visibility, but in personal budget mode the computed balances and entry counts only include entries the viewer may see, so a private entry never leaks its amount through a shared account's balance.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| type | TEXT | `'checking'` \| `'savings'` \| `'cash'` \| `'credit'` \| `'investment'` \| `'other'`, default `'checking'` |
| starting_balance | REAL | NOT NULL DEFAULT 0 (may be negative, e.g. credit card) |
| currency | TEXT | Optional ISO code; falls back to the household currency |
| color | TEXT | Optional HEX (`#RRGGBB`) |
| archived | INTEGER | 0/1 — archived accounts are hidden by default and excluded from net worth |
| sort_order | INTEGER | NOT NULL DEFAULT 0 |
| created_by | INTEGER | FK → Users, NOT NULL |
| created_at / updated_at | TEXT | ISO 8601 |

### Budget Categories
Expense and income category list, DB-backed. Predefined set: **9 expense** and **5 income**. The expense keys are stable English slugs (`housing`, `food`, `transport`, `personal_health`, `leisure`, `shopping_clothing`, `education`, `financial_other`, `subscriptions`); the ninth, `subscriptions`, is the category the Subscriptions tab mirrors its own categories into as subcategories (migration v59). The five income keys are historically the German display names, not slugs — they predate the slug convention and are left alone because they are the FK value of every existing income entry. Users can add custom categories inline from the entry modal. A "Manage categories" button in the Budget tab header opens a modal (the reusable `yuvomi-category-manager` component) to rename, reorder, and delete categories. Deletion is blocked while a category is still referenced by entries (`409`) or when it is the last category of its type.

| Column | Type | Constraint |
|--------|------|-----------|
| key | TEXT | PRIMARY KEY (stable English slug, e.g. `housing`) |
| name | TEXT | NOT NULL |
| type | TEXT | `'expense'` or `'income'` |
| sort_order | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | ISO 8601 |

### Budget Subcategories
Optional subcategories scoped to an expense category. Predefined set (40 entries); users can add custom subcategories inline. Income categories have no subcategories. The "Manage categories" modal also renames, reorders, and deletes subcategories per expense category (with the same in-use and last-subcategory deletion guards).

| Column | Type | Constraint |
|--------|------|-----------|
| key | TEXT | PRIMARY KEY |
| category_key | TEXT | FK → Budget Categories (CASCADE delete), NOT NULL |
| name | TEXT | NOT NULL |
| sort_order | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | ISO 8601 |
| UNIQUE | | (category_key, name) |

### Budget Recurrence Skipped
Stores instances of a recurring entry deleted by the user so they are not re-generated.

| Column | Type | Constraint |
|--------|------|-----------|
| parent_id | INTEGER | FK → Budget Entries, NOT NULL |
| date | TEXT | YYYY-MM-DD, NOT NULL |
| PRIMARY KEY | | (parent_id, date) |

### Budget Subscriptions
Recurring service and payment records shown in Budget → Subscriptions.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| description | TEXT | nullable — short service description shown on the card |
| notes | TEXT | nullable — free-text note |
| amount | REAL | Native billing amount, CHECK(>= 0) |
| currency | TEXT | ISO 4217 code, NOT NULL |
| billing_cycle | TEXT | `daily` \| `weekly` \| `monthly` \| `yearly` |
| cycle_interval | INTEGER | Every N cycles, 1–365 |
| next_payment_date | TEXT | DATE, NOT NULL |
| category_id | INTEGER | FK → Subscription Categories (SET NULL) |
| payment_method_id | INTEGER | FK → Subscription Payment Methods (SET NULL) |
| reminder_days | INTEGER | Days before renewal, 0–365 |
| enabled | INTEGER | 0/1; disabled records are retained but excluded from totals and reminders |
| end_type | TEXT | NOT NULL DEFAULT `never` — `never` \| `on_date` \| `after_count` (migration v107) |
| end_date | TEXT | DATE, required when `end_type = on_date`; must not precede `next_payment_date` |
| occurrence_count | INTEGER | Target number of payments, required when `end_type = after_count` (1–1200) |
| occurrences_done | INTEGER | NOT NULL DEFAULT 0 — payments already booked; the pending payment is number `occurrences_done + 1` |
| completed_at | TEXT | Timestamp set when the end condition is reached; distinguishes an auto-completed subscription from a manually paused one |
| website_url | TEXT | Optional public service URL |
| logo_data | TEXT | Optional local image data URL, max 500 KB |
| brand_color | TEXT | Optional HEX color |
| budget_entry_id | INTEGER | Linked pending Budget expense (SET NULL on delete) |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| owner_id | INTEGER | FK → Users, nullable (ON DELETE SET NULL) — owner, fixed to creator (migration v88) |
| visibility | TEXT | NOT NULL DEFAULT `shared` — `private` \| `shared` (migration v88); the linked Budget expense inherits both |

**Optional end condition (migration v107 · #594):** a subscription can define when it ends via an *Ends: Never / On a date / After N payments* selector (mirroring the calendar's finite-recurrence control). Renewing advances to the next cycle until the end is reached — the payment on the end date (or the `occurrence_count`-th payment) is the last — after which the subscription is **marked completed** (`completed_at` set, `enabled` cleared): it drops out of the monthly total, its linked Budget expense and renewal reminder are removed, and it stays visible with a distinct "Completed" state instead of looking manually paused. The 6-month renewal forecast only counts occurrences up to the end. Re-enabling a completed subscription clears the completion; an exhausted *after N payments* subscription can only be reactivated by raising `occurrence_count`. Existing subscriptions default to `never` and behave unchanged.

Supporting tables store customizable/sortable categories and payment methods, the single household subscription budget/base-currency setting, and cached exchange rates. A "Manage categories and payment methods" dialog in the Subscriptions toolbar adds, renames, reorders, and removes both categories (name + color) and payment methods. Unlike the shared `yuvomi-category-manager` used elsewhere, removal is not blocked while in use: the FK `SET NULL` detaches referencing subscriptions (they fall back to uncategorized / unspecified) and the confirmation names how many subscriptions are affected. Subscription categories are mirrored under the Budget `Subscription` category, and active renewals use the matching Budget subcategory automatically; removing a category also removes its mirrored Budget subcategory and detaches any linked expense entries from it. Database backup and restore include all subscription data.

### Budget Plans
Planned/estimated budget (Budget → Plan). A **steady monthly plan**: one amount per expense category that applies to every month, compared against the month's actual spending. The reserved key `__savings__` holds the household's monthly savings goal, compared against the month's net balance (income − expenses).

| Column | Type | Constraint |
|--------|------|-----------|
| category | TEXT | PRIMARY KEY — expense category key, or the reserved sentinel `__savings__` for the savings goal |
| amount | REAL | Planned monthly amount, always positive |
| created_by | TEXT | User id that last set the plan, nullable |
| updated_at | TEXT | ISO 8601 datetime, default now |

`GET /api/v1/budget/plans?month=YYYY-MM` returns each category's planned vs. actual (with `remaining`, `ratio`, `over`) and the savings goal's planned vs. net balance (`met`). `PUT /api/v1/budget/plans/:category` upserts a positive amount (validated against real expense category keys or the savings sentinel); `DELETE` removes it. The Statistics tab overlays a category target marker at the planned amount (month range only); the dashboard Budget widget shows savings-goal progress when a goal is set. No FK on the category so category rename/delete never orphans the app.

### Reminders

Per-user reminders attached to tasks, calendar events, or subscriptions.

| Column | Type | Constraint |
|--------|------|-----------|
| entity_type | TEXT | `task`, `event`, or `subscription`, NOT NULL |
| entity_id | INTEGER | Entity identifier, NOT NULL |
| remind_at | TEXT | ISO 8601 datetime, NOT NULL |
| dismissed | INTEGER | 0/1, default 0 |
| pushed_at | TEXT | ISO 8601 datetime, nullable — set once all active notification targets have been sent, skipped, or exhausted, so the reminder is not processed indefinitely |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |

Calendar events support **multiple reminders** (e.g. "15 minutes before" *and* "1 day before").
Each reminder is an independent row and is delivered separately by the notification scheduler.
Every delivery carries the linked entity's title as the notification body (task title, event title,
or subscription name), so the reminder is identifiable without opening the app; the fallback text
only applies once the linked entity has been deleted. Subscription reminders additionally carry the
amount and the renewal date, as `Name - 12.99 EUR - 2026-08-03`. That line is deliberately data
only, with no sentence around it: the notification is assembled on the server, which has no way to
know the **recipient's** language, since locale, date and number formats live in the client's
local storage. The household data language (#631, #632) does not close this gap — it governs what the
server *stores* for everyone, whereas a notification is addressed to one member whose own display
language may differ. Amount and date are dropped individually when a subscription has neither.
The event dialog manages the set via `GET /api/v1/reminders/all?entity_type=event&entity_id=…`
(returns the full list) and `PUT /api/v1/reminders?entity_type=event&entity_id=…` with
`{ remind_ats: [...] }` (replace-set semantics: deduplicated, max 5). Tasks and subscriptions keep
using the single-reminder endpoints (`GET`/`POST /api/v1/reminders`).

### Push Subscriptions

Per-device Web Push subscriptions (one row per browser/device endpoint). Used by the push
scheduler to deliver due reminders as system notifications even when the PWA is closed.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| endpoint | TEXT | Push service endpoint URL, NOT NULL, UNIQUE |
| p256dh | TEXT | Client public key (ECDH), NOT NULL |
| auth | TEXT | Client auth secret, NOT NULL |
| user_agent | TEXT | Nullable — device/browser label |
| created_at | TEXT | ISO 8601 datetime, default now |
| last_used_at | TEXT | ISO 8601 datetime, nullable — updated on each successful push |

VAPID keys are generated on first use and stored in **Sync Config** (`push_vapid_public`,
`push_vapid_private`); they can be overridden via `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` env vars.

The signed token's contact subject resolves to the first **routable** candidate: `VAPID_SUBJECT`,
then the SMTP sender address (`email_from_address`), then `BASE_URL`, then a placeholder. Loopback,
`.local`/`.lan`-style and TLD-less values are discarded rather than passed on, because Apple answers
`403 BadJwtToken` for an unreachable subject — which disabled push on iOS/iPadOS only, while FCM
accepted the same value (v1.66.2).

### Notification Channels

Admin-configured outbound channels for household reminder delivery. Web Push subscriptions stay
per-device in `push_subscriptions`; external providers live in `notification_channels` and can be
enabled or disabled without changing device subscriptions.

| Column | Type | Constraint |
|--------|------|-----------|
| provider | TEXT | Provider ID such as `gotify` or `ntfy`, validated in the service layer |
| name | TEXT | Admin-facing channel name, NOT NULL |
| enabled | INTEGER | 0/1, default 0 |
| scope | TEXT | `household` by default; future user-scoped channels can set `user` |
| user_id | INTEGER | Optional FK → Users (CASCADE delete) |
| config_json | TEXT | Non-secret provider configuration JSON, NOT NULL |
| secret_json | TEXT | Write-only provider credentials JSON, NOT NULL |
| last_test_at | TEXT | ISO 8601 datetime of the latest manual test, nullable |
| last_success_at | TEXT | ISO 8601 datetime of the latest successful test, nullable |
| last_error | TEXT | Sanitized latest test error, nullable |

Provider config uses JSON so future providers can be added without a schema change. Gotify stores
`baseUrl` and `priority` in `config_json`, with `appToken` in `secret_json`. ntfy stores `baseUrl`,
`topic`, `priority`, and `authType` in `config_json`, with token/basic credentials in `secret_json`.
Secrets are accepted by the API on create/update but never returned to clients.

### Notification Deliveries

Durable per-reminder delivery state for Web Push and external channels.

| Column | Type | Constraint |
|--------|------|-----------|
| reminder_id | INTEGER | FK → Reminders (CASCADE delete), NOT NULL |
| provider | TEXT | `webpush`, `gotify`, `ntfy`, or future provider ID |
| channel_id | INTEGER | Optional FK → Notification Channels (SET NULL on delete) |
| target_key | TEXT | Stable target key, unique with reminder/provider |
| status | TEXT | `pending`, `sent`, `failed`, or `skipped` |
| attempt_count | INTEGER | Number of send attempts |
| next_attempt_at | TEXT | ISO 8601 retry time, nullable |
| last_attempt_at | TEXT | ISO 8601 latest attempt time, nullable |
| sent_at | TEXT | ISO 8601 success time, nullable |
| error | TEXT | Sanitized latest error, nullable |

The scheduler retries temporary provider failures with a bounded fixed backoff. A reminder keeps
`pushed_at` empty while any active delivery is still retryable; once every current target is sent,
skipped, or exhausted, `pushed_at` is set as the legacy completion marker.

### Birthdays

Birthday records with optional profile photo and automatic calendar event + reminder.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| birth_date | TEXT | DATE (YYYY-MM-DD), NOT NULL |
| notes | TEXT | nullable |
| photo_data | TEXT | Base64 data URL (≤ 5 MB), nullable |
| calendar_event_id | INTEGER | FK → calendar_events (SET NULL on delete), nullable |
| family_user_id | INTEGER | FK → Users (CASCADE delete), UNIQUE (one linked user per birthday), nullable |
| contact_id | INTEGER | FK → Contacts (SET NULL on delete), UNIQUE partial (one birthday per source contact); set when imported from a contact, nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| reminder_offset | TEXT | Preset offset key (e.g. "1d", "1w") or "custom"; empty/null = no reminder |
| reminder_custom_amount | INTEGER | Amount for custom offset, nullable |
| reminder_custom_unit | TEXT | Unit for custom offset: "minutes", "hours", "days", "weeks", nullable |

### API Tokens
Named Bearer / X-API-Key tokens for non-interactive external integrations. Admin-only creation and revocation. Token values are SHA-256-hashed at rest; the plaintext is shown only once after creation.

Tokens can optionally be **scoped** to individual modules and access levels — a least-privilege allow-list that matters most for tokens handed to an off-device AI/MCP client. Each scope is `<module>:read` or `<module>:write` (write implies read); modules cover `tasks`, `shopping`, `meals`, `pantry`, `calendar`, `notes`, `contacts`, `budget`, `documents`, `health`, `rewards`, `housekeeping`, `weather`, `family`, `dashboard`, `search`. A `NULL` scopes value means no scoping — full role-based access (the default, and the state of every token created before this feature). A scoped token can only reach modules on its allow-list; every other `/api/v1` path is denied. Enforcement is shared across the REST API and MCP: the MCP core tools are checked in-process, `tools/list` hides tools the token cannot use, and the OpenAPI bridge inherits the same limits because it loops back through the REST layer with the same token.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name | TEXT | NOT NULL |
| token_hash | TEXT | NOT NULL UNIQUE (SHA-256) |
| token_prefix | TEXT | NOT NULL (first 8 chars, for display) |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| scopes | TEXT | JSON array of `<module>:read`/`<module>:write`; NULL = full access (nullable) |
| expires_at | TEXT | ISO 8601, nullable |
| revoked_at | TEXT | ISO 8601, nullable |
| last_used_at | TEXT | ISO 8601, nullable |
| created_at | TEXT | ISO 8601 NOT NULL |

### ICS Subscriptions
External calendar feeds subscribed by users (read-only, auto-synced).

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| url | TEXT | NOT NULL (https:// or webcal://) |
| color | TEXT | HEX, default #6366f1 |
| shared | INTEGER | 0/1 — visible to all family members when 1 |
| created_by | INTEGER | FK → Users (SET NULL on delete) |
| etag | TEXT | HTTP ETag for conditional fetch |
| last_modified | TEXT | HTTP Last-Modified for conditional fetch |
| last_sync | TEXT | ISO timestamp of last successful sync |
| default_assignee_user_id | INTEGER | FK → Users, nullable — default assignee for newly imported events of this feed (migration v79, see [External Calendars](#external-calendars)) |
| created_at | TEXT | ISO timestamp |

**One-time import vs. subscription.** `POST /api/v1/calendar/import` imports events from an
uploaded `.ics` file (raw text in the request body) or a shared calendar feed URL (same
SSRF-protected fetch as subscriptions) as **editable local events** (`external_source='local'`,
`subscription_id=NULL`) — the migration path from another calendar. Unlike a subscription, the
events are owned by the importing user and never auto-synced afterwards; recurring events are kept
as a series (RRULE reduced to the locally supported subset), and the source UID is stored in
`external_calendar_id` to skip accidental duplicate re-imports of the same feed.

### Family Documents
Upload and manage family files with per-document access control.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL (display name) |
| description | TEXT | nullable |
| category | TEXT | medical, school, identity, insurance, finance, home, vehicle, legal, travel, pets, warranty, taxes, work, other (default) |
| status | TEXT | active (default), archived |
| visibility | TEXT | family (default), restricted, private |
| original_name | TEXT | NOT NULL (original filename) |
| mime_type | TEXT | NOT NULL |
| file_size | INTEGER | NOT NULL (bytes) |
| content_data | TEXT | NOT NULL — raw binary file payload stored as a BLOB for in-database `local`; empty string for folder-backed `local`, `webdav`, `google_drive`, and `dms`. Binary BLOB since migration v67 (previously Base64 text, ~33 % larger); the column keeps TEXT affinity, and legacy Base64 rows remain readable |
| storage_provider | TEXT | Compatibility field: local (default), external |
| storage_backend | TEXT | Authoritative backend: local (default), webdav, google_drive, dms (discriminator added by migration v51, Google Drive by v98) |
| storage_key | TEXT | nullable (local/WebDAV relative key, opaque Google Drive file ID, or DMS document ID) |
| dms_account_id | INTEGER | FK → DMS Accounts (ON DELETE SET NULL), nullable (migration v50) |
| external_url | TEXT | nullable (deep link to the document in the DMS) |
| external_meta | TEXT | nullable (JSON `{ correspondent, tags }` mirrored from the DMS for display) |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |

`storage_backend` is the authoritative discriminator. Valid compatibility pairs are
`local/local`, `external/webdav`, `external/google_drive`, and `external/dms`; database triggers
reject invalid provider/backend combinations. Existing `external` rows were migrated to `dms`,
including orphaned DMS links. `dms_account_id` is non-null only for `dms` rows.

Preview, download, Calendar attachment access, and DMS/Paperless push read through the shared
document-storage layer. Local bytes come from SQLite or the mounted folder, WebDAV bytes are fetched
from the configured remote object, Google Drive bytes are fetched by opaque file ID, and DMS-linked
documents are proxied through their adapter. The per-document visibility check applies before any
content is read.

Linked DMS documents also show a compact first-page thumbnail (`GET /documents/:id/thumbnail`,
visibility-enforced) and the link picker previews DMS hits before linking
(`GET /documents/dms/thumbnail`, admin-only, keyed by account + DMS document id). Both proxy the
adapter's thumbnail (Paperless `/thumb/`; providers without one degrade to the category glyph),
serve only a raster-image allowlist (`png/jpeg/webp/gif`, no SVG) with `nosniff` and a strict CSP,
and the client falls back to the icon when no thumbnail can be generated. (v1.32.0)

In the link picker the preview is rendered page-shaped (72×96, top-anchored crop) so the header of
the document stays readable, and selecting it opens a full-size preview layered over the picker with
"open in DMS" and "link" actions. The layer is not a second modal — the shared modal system holds
exactly one overlay — so it captures Escape ahead of the modal handler and closes only itself. Where
no thumbnail exists (Papra, or a failed fetch), the tile degrades to the previous direct link into
the DMS. (v1.37.1)

PDF preview renders inline everywhere: browsers with a built-in PDF viewer (desktop) use a
same-origin `<iframe>`, while browsers without one (iOS Safari and most mobile browsers, where an
`<iframe>`/`<embed>` renders blank) fall back to a self-hosted pdf.js canvas viewer. Pages render
lazily (IntersectionObserver, an LRU cap bounds memory on large PDFs), the modal body is the sole
scroller, a sticky page indicator shows position, and a screen-reader note points to the
always-available open-in-tab/download escape (the canvas is graphical, not text). pdf.js plus its
worker and standard fonts ship self-hosted under `public/vendor/pdfjs/` (no CDN, per the no-external-
frontend-dependencies constraint); `isEvalSupported` is disabled so the app CSP (`script-src 'self'`)
is unchanged. (v1.31.0)

### Family Document Access
Allowlist for `visibility = 'restricted'` documents — only listed users can see the document.

| Column | Type | Constraint |
|--------|------|-----------|
| document_id | INTEGER | FK → Family Documents (CASCADE delete), NOT NULL |
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| PRIMARY KEY | | (document_id, user_id) |

### Family Document Folders
Custom folders for organizing family documents (migration v37). A "Hausreinigung" folder is auto-created when a housekeeping worker is first added.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL UNIQUE |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

`family_documents.folder_id` references this table (ON DELETE SET NULL, nullable).

### DMS Accounts
Connections to an external document management system for the Documents module (migration v50, extended v52). Admin-managed in Settings. Supported providers: `paperless` (Paperless-ngx) and `papra` (Papra).

| Column | Type | Constraint |
|--------|------|-----------|
| provider | TEXT | `paperless` \| `papra` (CHECK constraint, migration v52) |
| name | TEXT | NOT NULL (display name) |
| base_url | TEXT | NOT NULL |
| org_id | TEXT | NOT NULL DEFAULT '' (Papra organization ID; empty for Paperless-ngx; migration v52) |
| api_token | TEXT | NOT NULL (write-only; never returned by the API, protected by optional SQLCipher) |
| created_at | TEXT | ISO 8601 |
| last_check | TEXT | nullable (last connection test) |

UNIQUE constraint: `(base_url, org_id)` — allows multiple Papra organizations on the same server; Paperless-ngx uses `org_id = ''` so only one account per server.

**DMS integration:** Admins connect a DMS instance (Paperless-ngx or Papra), then search it and **link** existing DMS documents into the Documents module as `external`/`dms` references (no duplication of the binary), or **push** a local or WebDAV-backed document into the DMS. Only `storage_backend = 'dms'` means a document is already stored in the DMS. All DMS operations (account management, search, link, push) are **admin-only**; searching the DMS is gated because it would otherwise bypass the per-document `restricted`/`private` visibility boundaries. Linked documents are previewed/downloaded by proxying the DMS live. The adapter layer (`server/services/dms/`) is provider-pluggable; Paperless-ngx and Papra are the two built-in adapters. For **Paperless-ngx**, a search term that is a bare number or carries an `asn:` prefix (e.g. `asn:123`) is resolved as an exact **Archive Serial Number (ASN)** lookup (`?archive_serial_number=`) instead of a full-text query, so a stamped ASN maps straight to the single matching document rather than a noisy title/content result set.

### Budget Loans
Instalment-based loans with per-payment tracking. Active loans show remaining balance and due months; paid-off loans are automatically closed. **Interest phases (migration v100, #569):** a loan is optionally modelled as a German-style annuity — from the `principal`, nominal `fixed_rate` and `initial_repayment_rate` the server derives the constant monthly payment and, from that, the term and total cost, storing them in `total_amount`/`installment_count` so the existing instalment/status logic is unchanged. With `interest_mode = 'fixed_then_variable'` a forecast `followup_rate` applies after the `fixed_period_months` fixed period (a longer follow-up rate lengthens the term). `interest_mode = 'variable'` (migration v101, #569) covers a loan with **no fixed-interest period at all**: it is computed single-phase exactly like `fixed`, but `fixed_rate` is treated as the current rate rather than a commitment, so `fixed_period_months`/`followup_rate` stay NULL and the UI labels payment and term as a snapshot of that rate. `interest_mode = 'none'` keeps the prior behaviour (manual `total_amount` + `installment_count`).

**Outstanding principal vs. remaining payments (v1.48.0):** for an interest loan these are two different figures and only the first is what a bank reports as the open amount. `remaining_amount` is the sum of the outstanding instalments (`total_amount` minus what has been paid) and therefore still contains the interest of the remaining term. `remaining_principal` is the open capital, read off the amortisation schedule at the current instalment count, and is the figure the loan cards and the summary card lead with, set against the `principal` as the reference figure so numerator and denominator match. The loan report shows both side by side (*Outstanding balance* and *Still to pay*). The value is a **plan** figure: it assumes every instalment was paid at the annuity amount and in its due month, deliberately not tracking deviating booked amounts, so it belongs to the same forecast as the monthly payment, total interest and term. Interest-free loans have no interest component, so both values are identical and their display is unchanged.

**Own currency per loan (migration v102, #582):** a loan can run in a currency other than the household budget currency. Every monetary field of the loan (`total_amount`, `principal`, and `budget_loan_payments.amount`) stays stored **in that currency**, so the amortisation schedule and the remaining balance stay exact. `currency = NULL` means "follows the budget currency" and is both the legacy state and the normal case; selecting the current budget currency in the UI is stored as NULL rather than the code, so a later household currency change cannot turn the loan into a foreign-currency one at rate 1. `exchange_rate` is a **fixed, manually maintained** rate (1 unit of loan currency = `exchange_rate` units of budget currency), not a daily quote: a 30-year schedule must not move its remaining balance every day, and the live-rate path of the Subscriptions module needs a `FIXER_API_KEY` most installations do not set. Only two places convert: the cross-loan summary card (valued at the stored rate) and the budget entry written for an instalment, which is converted **at booking time** so a later rate change leaves booked instalments untouched. Editing that coupled budget entry converts back into the loan currency, including the remaining-balance check.

**Lending direction (migration v126, #638):** the module was originally built for money the household *lends out*, so an instalment was always booked as income — a positive amount under an income category. The interest fields of #569 made a mortgage expressible, but the booking logic never followed, and a mortgage payment showed up as income in the monthly balance. `direction` now decides sign and category together: `lent` (the default, unchanged for existing rows) writes the instalment as a positive amount under `Geschenke & Transfers`, `borrowed` writes it as a negative amount under `financial_other` / `loans_interest`. Both have to switch together, because the statistics read the type off the sign (`amount > 0` = income) while `budget_categories` carries its own `type` — turning only one of them would file an expense under an income category. Switching an existing loan's direction **re-books the instalments already recorded** (sign and category): a wrong sign is never legitimate history, and this is the repair path for rows the migration defaulted to `lent`. `account_id` gives the loan a default account which every new instalment inherits, so a payment can charge an account at all — the coupled budget entry carried none before. A later account change applies to new instalments only, since re-booking the old ones would falsify historical account balances.

| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | NOT NULL |
| borrower | TEXT | NOT NULL — the counterparty: the borrower with `direction = 'lent'`, the lender with `borrowed` (#638) |
| total_amount | REAL | NOT NULL CHECK(> 0) — for interest loans: derived total repayment (principal + interest) |
| installment_count | INTEGER | NOT NULL CHECK(> 0) — for interest loans: derived term in months |
| start_month | TEXT | YYYY-MM, NOT NULL |
| notes | TEXT | nullable |
| status | TEXT | 'active' (default) or 'paid' |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| owner_id | INTEGER | FK → Users, nullable (ON DELETE SET NULL) — owner, fixed to creator (migration v88) |
| visibility | TEXT | NOT NULL DEFAULT `shared` — `private` \| `shared` (migration v88) |
| interest_mode | TEXT | NOT NULL DEFAULT `none` — `none` \| `fixed` \| `variable` \| `fixed_then_variable` (migration v100; `variable` added in v101, which rebuilds the table because SQLite cannot widen a column CHECK, #569) |
| principal | REAL | nullable — loan principal for interest loans (migration v100) |
| fixed_rate | REAL | nullable — nominal annual interest rate % during the fixed period; with `variable` the current rate (migration v100) |
| initial_repayment_rate | REAL | nullable — initial annual repayment rate %, German annuity (migration v100) |
| fixed_period_months | INTEGER | nullable — fixed-interest period in months (`fixed_then_variable` only) (migration v100) |
| followup_rate | REAL | nullable — forecast annual interest rate % after the fixed period (migration v100) |
| currency | TEXT | nullable — ISO 4217 code the loan runs in; NULL = budget currency (migration v102, #582) |
| exchange_rate | REAL | NOT NULL DEFAULT 1 — fixed rate, 1 loan currency = `exchange_rate` budget currency; forced to 1 whenever `currency` is NULL (migration v102, #582) |
| direction | TEXT | NOT NULL DEFAULT `lent` — `lent` \| `borrowed`; decides sign and category of the coupled budget entry (migration v126, #638) |
| account_id | INTEGER | FK → Budget Accounts, nullable (ON DELETE SET NULL) — default account the instalments charge (migration v126, #638) |

### Budget Loan Payments
Individual payment records for a budget loan. Each installment number is unique per loan.

| Column | Type | Constraint |
|--------|------|-----------|
| loan_id | INTEGER | FK → Budget Loans (CASCADE delete), NOT NULL |
| installment_number | INTEGER | NOT NULL CHECK(> 0), UNIQUE per loan |
| amount | REAL | NOT NULL CHECK(> 0) — in the loan's currency, not the budget currency (#582); always positive, the sign lives on the coupled budget entry and follows `direction` (#638) |
| paid_date | TEXT | DATE, NOT NULL |
| budget_entry_id | INTEGER | FK → Budget Entries (SET NULL on delete), nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |

### Housekeeping Workers
Staff profiles for the Housekeeping module (migrations v34, v48).

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL UNIQUE |
| daily_rate | REAL | NOT NULL DEFAULT 0 CHECK(>= 0) |
| rate_type | TEXT | 'daily' (default) or 'hourly' CHECK(rate_type IN ('daily','hourly')) |
| hourly_rate | REAL | NOT NULL DEFAULT 0 CHECK(>= 0) |
| payment_schedule | TEXT | 'daily', 'twice_monthly', 'monthly' (default) |
| calendar_color | TEXT | HEX, default '#7C3AED' |
| notes | TEXT | nullable |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### Housekeeping Work Sessions
Individual check-in/check-out sessions (migrations v33, v34, v35, v36, v37, v48).

| Column | Type | Constraint |
|--------|------|-----------|
| check_in | TEXT | DATETIME, NOT NULL |
| check_out | TEXT | DATETIME, nullable (open session when NULL) |
| daily_rate | REAL | NOT NULL DEFAULT 0 |
| extras | REAL | NOT NULL DEFAULT 0 |
| rate_type | TEXT | 'daily' (default) or 'hourly'; snapshotted from worker at check-in |
| hourly_rate | REAL | NOT NULL DEFAULT 0; snapshotted from worker at check-in |
| minutes_worked | INTEGER | nullable; computed from check_in/check_out diff on check-out |
| worker_id | INTEGER | FK → Housekeeping Workers (SET NULL on delete), nullable |
| calendar_event_id | INTEGER | FK → Calendar Events (SET NULL on delete), nullable |
| payment_task_id | INTEGER | FK → Tasks (SET NULL on delete), nullable |
| receipt_document_id | INTEGER | FK → Family Documents (SET NULL on delete), nullable |
| paid_at | TEXT | DATETIME, nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### Housekeeping Decay Tasks
Recurring chores with urgency decay indicators (migration v33).

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| area | TEXT | NOT NULL |
| frequency_days | INTEGER | NOT NULL CHECK(> 0) |
| last_completed | TEXT | DATETIME, nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### Housekeeping Supply Requests
Supply requests linked to shopping lists (migration v33).

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| quantity | TEXT | nullable |
| shopping_item_id | INTEGER | FK → Shopping Items (SET NULL on delete), nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at | TEXT | ISO 8601 |

### Housekeeping Maintenance Log
Photo log for maintenance issues (migration v33).

| Column | Type | Constraint |
|--------|------|-----------|
| description | TEXT | NOT NULL |
| photo_url | TEXT | nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### Expense Groups
Split expense groups (migration v39).

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| description | TEXT | nullable |
| type | TEXT | 'household', 'couple', 'travel', 'event', 'shopping', 'general' (default) |
| avatar_color | TEXT | HEX, default '#0F766E' |
| avatar_document_id | INTEGER | FK → Family Documents (SET NULL on delete), nullable |
| default_currency | TEXT | NOT NULL DEFAULT 'EUR' |
| default_split_method | TEXT | NOT NULL DEFAULT 'equal'; split method new expenses in this group start with (#517) |
| default_split_config | TEXT | JSON per-member defaults — `[{user_id, percentage}]` or `[{user_id, shares}]`; NULL for equal/exact (#517) |
| status | TEXT | 'active' (default) or 'archived' |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| archived_at | TEXT | nullable |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### Expense Group Members

| Column | Type | Constraint |
|--------|------|-----------|
| group_id | INTEGER | FK → Expense Groups (CASCADE delete), NOT NULL |
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| role | TEXT | 'owner', 'admin', 'guest' (default) |
| invited_by | INTEGER | FK → Users (SET NULL on delete), nullable |
| joined_at | TEXT | ISO 8601 |
| PRIMARY KEY | | (group_id, user_id) |

### Expenses
Immutable expense records — amounts stored in integer minor currency units (e.g. cents) to avoid floating-point errors.

| Column | Type | Constraint |
|--------|------|-----------|
| group_id | INTEGER | FK → Expense Groups (CASCADE delete), NOT NULL |
| title | TEXT | NOT NULL |
| description | TEXT | nullable |
| amount_minor | INTEGER | NOT NULL CHECK(> 0) |
| currency | TEXT | NOT NULL |
| converted_amount_minor | INTEGER | NOT NULL CHECK(> 0) |
| converted_currency | TEXT | NOT NULL |
| exchange_rate_num | INTEGER | NOT NULL DEFAULT 1 |
| exchange_rate_den | INTEGER | NOT NULL DEFAULT 1 |
| exchange_snapshot | TEXT | JSON, nullable — the rate source as it stood at booking time, so a later rate change never rewrites a recorded expense |
| payer_id | INTEGER | FK → Users (RESTRICT on delete), NOT NULL |
| category | TEXT | NOT NULL DEFAULT 'general' |
| split_method | TEXT | 'equal', 'exact', 'percentage', 'shares' (default 'equal') |
| status | TEXT | 'active' (default) or 'deleted' |
| expense_date | TEXT | DATE, NOT NULL |
| recurring_rule_id | INTEGER | FK → Recurring Expenses, nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| deleted_at | TEXT | nullable |

### Expense Splits

| Column | Type | Constraint |
|--------|------|-----------|
| expense_id | INTEGER | FK → Expenses (CASCADE delete), NOT NULL |
| user_id | INTEGER | FK → Users (RESTRICT on delete), NOT NULL |
| amount_minor | INTEGER | NOT NULL CHECK(>= 0) |
| currency | TEXT | NOT NULL |
| UNIQUE | | (expense_id, user_id) |

### Expense Attachments
Receipts and proofs linked to an expense. The binary itself always stays in the Documents module — this
is a link table, so a receipt is not stored twice and the document's own visibility keeps applying.

| Column | Type | Constraint |
|--------|------|-----------|
| expense_id | INTEGER | FK → Expenses (CASCADE delete), NOT NULL |
| document_id | INTEGER | FK → Family Documents (CASCADE delete), NOT NULL |
| kind | TEXT | NOT NULL DEFAULT `receipt` — CHECK `receipt` \| `proof` \| `other` |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| UNIQUE | | (expense_id, document_id) |

Set on create/update via `attachment_document_ids` on the expense payload; re-sending an existing
link is a no-op. Omitting the field on an update leaves the existing receipts alone, so correcting
an amount never clears them. The expense modal offers both ways in (#583): link a document already
filed under Documents, or upload a new file on the spot.

**Visibility (#583):** linking and reading both run through the Documents module's rules — you can
only link what you may see, a receipt filed as private stays invisible to the rest of the group
(and to admins, since Documents has no admin bypass), and saving an expense only removes the links
you can see, so another member's private receipt survives your edit.

### Expense Comments
Free-text comments on a single expense ("this also covered the taxi"). Each comment additionally
writes a `comment_added` row into [Expense Activity](#expense-activity), so the group feed stays the
one chronological view.

| Column | Type | Constraint |
|--------|------|-----------|
| expense_id | INTEGER | FK → Expenses (CASCADE delete), NOT NULL |
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| comment | TEXT | NOT NULL |
| created_at | TEXT | ISO 8601 |

API: `POST /api/v1/split/expenses/:id/comments`.

### Expense Ledger Entries
Immutable double-entry ledger derived from expense splits and settlements.

| Column | Type | Constraint |
|--------|------|-----------|
| group_id | INTEGER | FK → Expense Groups (CASCADE delete), NOT NULL |
| source_type | TEXT | 'expense', 'expense_reversal', 'settlement', 'settlement_reversal' |
| source_id | INTEGER | NOT NULL |
| user_id | INTEGER | FK → Users (RESTRICT on delete), NOT NULL |
| counterparty_id | INTEGER | FK → Users (SET NULL on delete), nullable |
| amount_minor | INTEGER | NOT NULL |
| currency | TEXT | NOT NULL |
| memo | TEXT | nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |

### Settlements
Debt payments between group members. A debt-simplification algorithm produces the minimal transfer set.

| Column | Type | Constraint |
|--------|------|-----------|
| group_id | INTEGER | FK → Expense Groups (CASCADE delete), NOT NULL |
| payer_id | INTEGER | FK → Users (RESTRICT on delete), NOT NULL |
| payee_id | INTEGER | FK → Users (RESTRICT on delete), NOT NULL |
| amount_minor | INTEGER | NOT NULL CHECK(> 0) |
| currency | TEXT | NOT NULL |
| notes | TEXT | nullable |
| proof_document_id | INTEGER | FK → Family Documents (SET NULL on delete), nullable — one payment proof, set from the settle-up modal; ignored when the document is not visible to the caller (#583) |
| status | TEXT | 'active' (default) or 'deleted' |
| paid_at | TEXT | DATETIME, NOT NULL |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| deleted_at | TEXT | nullable |

### Settlement Entries

| Column | Type | Constraint |
|--------|------|-----------|
| settlement_id | INTEGER | FK → Settlements (CASCADE delete), NOT NULL |
| from_user_id | INTEGER | FK → Users (RESTRICT on delete), NOT NULL |
| to_user_id | INTEGER | FK → Users (RESTRICT on delete), NOT NULL |
| amount_minor | INTEGER | NOT NULL CHECK(> 0) |
| currency | TEXT | NOT NULL |

### Recurring Expenses
Template for automatically generated expenses on a fixed schedule.

| Column | Type | Constraint |
|--------|------|-----------|
| group_id | INTEGER | FK → Expense Groups (CASCADE delete), NOT NULL |
| title | TEXT | NOT NULL |
| description | TEXT | nullable |
| amount_minor | INTEGER | NOT NULL CHECK(> 0) |
| currency | TEXT | NOT NULL |
| payer_id | INTEGER | FK → Users (RESTRICT on delete), NOT NULL |
| category | TEXT | NOT NULL DEFAULT 'general' |
| split_method | TEXT | NOT NULL DEFAULT 'equal' |
| split_snapshot | TEXT | NOT NULL (JSON) |
| frequency | TEXT | 'weekly', 'monthly', 'yearly' |
| next_run_date | TEXT | DATE, NOT NULL |
| paused_at | TEXT | nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |

### Expense Activity
Per-group event log for expenses, settlements, and member events.

| Column | Type | Constraint |
|--------|------|-----------|
| group_id | INTEGER | FK → Expense Groups (CASCADE delete), NOT NULL |
| actor_id | INTEGER | FK → Users (SET NULL on delete), nullable |
| type | TEXT | NOT NULL |
| entity_type | TEXT | NOT NULL |
| entity_id | INTEGER | nullable |
| metadata | TEXT | JSON, nullable |

### Split Expense Guest Users
Tracks which users were created as restricted guests for a split group (migration v40). The row
carries two separate statements: **that** an account is confined - its mere existence, which the
API guard checks - and **which** group it may see. Deleting the group must only clear the second
(migration 124); until then the `group_id` cascade removed the whole row, leaving the account
itself untouched and thereby promoting a guest to a full household member.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), PRIMARY KEY |
| group_id | INTEGER | FK → Expense Groups (SET NULL on delete), nullable - NULL means a guest whose group is gone: still confined, sees nothing |
| created_by | INTEGER | FK → Users (SET NULL on delete), nullable |
| created_at | TEXT | ISO 8601 |

### Password Resets (v0.71.51)
Self-service "Forgot password" tokens (migration 55). One active token per user — issuing a new
one replaces the prior row.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| token_hash | TEXT | SHA-256 hash of the raw token; the raw token is only ever in the emailed link, never stored. UNIQUE index. |
| expires_at | INTEGER | Epoch ms; tokens are valid for 1 hour |
| created_at | TEXT | ISO 8601 datetime, default now |

### Sync Config
Key-value table for OAuth tokens and CalDAV credentials. Also stores SMTP settings
(`email_smtp_host`, `email_smtp_port`, `email_smtp_secure`, `email_smtp_user`, `email_smtp_pass`,
`email_from_address`, `email_from_name`) for the optional email/SMTP feature (v0.71.51) — plaintext,
like `apple_app_password` and Google OAuth tokens; encryption-at-rest is via the optional
`DB_ENCRYPTION_KEY` (SQLCipher). The API never returns `email_smtp_pass`.

| Column | Type | Constraint |
|--------|------|-----------|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

### Health (migration 65)

The Health module stores personal medical data per family member across seven tables (migration
65) plus three menstrual-cycle tables (migration 71). Every owner-scoped table carries `user_id`
(the owning member) and a `visibility` of `private` (owner only) or `family` (all members). Nested
tables (schedules, logs, results) inherit visibility from their parent record. Health data is sensitive — encryption-at-rest via the optional
`DB_ENCRYPTION_KEY` (SQLCipher) is strongly recommended. Yuvomi is **not** a medical device and
makes **no diagnostic claims**; reference ranges and flags are neutral, user-supplied values.

**`health_vitals`** — one row per measurement.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| type | TEXT | NOT NULL — `bp` \| `glucose` \| `weight` \| `spo2` \| `temp` \| `sleep` \| `mood` \| custom slug (pulse is no metric of its own: it is the third `bp` channel, `value_num3`) |
| value_num | REAL | primary value; for `bp` = systolic, `sleep` = decimal hours, `mood` = step 1-5 |
| value_num2 | REAL | `bp` diastolic |
| value_num3 | REAL | `bp` optional pulse |
| unit | TEXT | |
| measured_at | TEXT | NOT NULL |
| note | TEXT | |
| visibility | TEXT | `private` \| `family`, default `private` |
| created_at / updated_at | TEXT | ISO 8601, default now (updated_at via trigger) |

**`health_care_grants`** — who may record for whom (#584). Directed and explicit; never derived from
`family_role`, so an upgrade grants nobody anything until an admin says so.

| Column | Type | Constraint |
|--------|------|-----------|
| subject_id | INTEGER | FK → Users (CASCADE delete), NOT NULL — the person being cared for |
| caregiver_id | INTEGER | FK → Users (CASCADE delete), NOT NULL — the person allowed to record |
| created_at | TEXT | ISO 8601, default now |
| | | PRIMARY KEY (subject_id, caregiver_id); CHECK (subject_id <> caregiver_id) |

A grant covers reading **and** writing the subject's vitals, medications, lab reports and activities,
including their `private` rows: a caregiver who could write but not read would lose sight of the
reading they just entered. The cycle tab is deliberately excluded from grants. Admins manage grants
under Settings → Family; every member can ask `GET /health/caregivers/me` who they may record for.

**`medications`** — medication master data.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| name | TEXT | NOT NULL |
| dosage_text | TEXT | free-text dose |
| form | TEXT | `pill` \| `liquid` \| `injection` \| … |
| active | INTEGER | 0/1, default 1 |
| prn | INTEGER | 0/1 "as needed", default 0 |
| stock_qty / stock_unit | REAL / TEXT | on-hand stock for refill alerts |
| refill_threshold | REAL | warn when stock drops below |
| note | TEXT | |
| visibility | TEXT | `private` \| `family`, default `private` |
| created_at / updated_at | TEXT | ISO 8601, default now |

**`medication_schedules`** — one medication : many time slots.

| Column | Type | Constraint |
|--------|------|-----------|
| medication_id | INTEGER | FK → medications (CASCADE delete), NOT NULL |
| time_of_day | TEXT | `HH:MM` local, NOT NULL |
| days_mask | INTEGER | weekday bitmask Mon=bit0…Sun=bit6, NULL = daily |
| dose_qty | REAL | |
| start_date / end_date | TEXT | optional window |
| active | INTEGER | 0/1, default 1 |
| created_at / updated_at | TEXT | ISO 8601, default now |

**`medication_logs`** — dose events.

| Column | Type | Constraint |
|--------|------|-----------|
| medication_id | INTEGER | FK → medications (CASCADE delete), NOT NULL |
| schedule_id | INTEGER | FK → medication_schedules (SET NULL); NULL for ad-hoc/PRN |
| scheduled_at | TEXT | planned time |
| status | TEXT | `taken` \| `skipped` \| `pending`, default `pending` |
| taken_at | TEXT | |
| dose_qty | REAL | |
| note | TEXT | |
| created_at | TEXT | ISO 8601, default now |

**`health_lab_reports`** — lab report header.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| report_date | TEXT | NOT NULL |
| lab_name | TEXT | |
| note | TEXT | |
| visibility | TEXT | `private` \| `family`, default `private` |
| created_at / updated_at | TEXT | ISO 8601, default now |

**`health_lab_results`** — analyte values per report.

| Column | Type | Constraint |
|--------|------|-----------|
| report_id | INTEGER | FK → health_lab_reports (CASCADE delete), NOT NULL |
| analyte | TEXT | NOT NULL |
| value_num | REAL | |
| unit | TEXT | |
| ref_low / ref_high | REAL | reference range |
| flag | TEXT | `low` \| `normal` \| `high`; derived from value + range when unset |
| created_at | TEXT | ISO 8601, default now |

**`health_activities`** — training / activity log.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| type | TEXT | NOT NULL — preset slug (`running`, `cycling`, …) or custom |
| duration_min / distance_km / calories | REAL | |
| intensity | TEXT | |
| performed_at | TEXT | NOT NULL |
| note | TEXT | |
| visibility | TEXT | `private` \| `family`, default `private` |
| created_at / updated_at | TEXT | ISO 8601, default now |

**Menstrual cycle (migration 71).** Three tables back the Cycle tab; predictions are computed
client-side (calendar method), the server only stores. The Cycle tab is a household opt-in
(`health_cycle_enabled` preference, default on, Settings → Modules → Module options); when disabled the tab
is hidden and its route redirects to the Health overview.

**`cycle_periods`** — one row per menstrual period episode.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| start_date | TEXT | NOT NULL — YYYY-MM-DD |
| end_date | TEXT | nullable — NULL while the period is ongoing |
| note | TEXT | |
| visibility | TEXT | `private` \| `family`, default `private` |
| created_at / updated_at | TEXT | ISO 8601, default now |

**`cycle_day_logs`** — one row per person and day (`UNIQUE(user_id, log_date)` → upsert).

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| log_date | TEXT | NOT NULL — YYYY-MM-DD |
| flow | TEXT | `spotting` \| `light` \| `medium` \| `heavy` (nullable) |
| symptoms | TEXT | comma-separated stable symptom keys |
| mood | TEXT | |
| note | TEXT | |
| visibility | TEXT | `private` \| `family`, default `private` |
| created_at / updated_at | TEXT | ISO 8601, default now |

**`cycle_settings`** — per-member prediction parameters (`user_id` primary key).

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | PK, FK → Users (CASCADE delete) |
| cycle_length_avg / period_length_avg | INTEGER | nullable — NULL derives the average from history |
| luteal_length | INTEGER | default 14 |
| track_fertility | INTEGER | 0/1, default 1 |
| pregnancy_mode | INTEGER | 0/1, default 0 — when 1, all cycle predictions pause (migration 82) |
| pregnancy_due_date | TEXT | nullable YYYY-MM-DD estimated due date; cleared when pregnancy_mode is off |
| default_visibility | TEXT | `private` \| `family`, default `private` (migration 96) — pre-selects the visibility for newly logged periods and day logs; per-entry override always available |
| created_at / updated_at | TEXT | ISO 8601, default now |

Medication reminders reuse the existing push/notification-channel layer (no dedicated reminder
table): `server/services/medication-scheduler.js` turns due schedule slots into `pending` logs and
fans out via Web Push and Gotify/ntfy channels. Medications (`name`, `dosage_text`) and activities
(`type`, `note`) are indexed in the FTS5 `search_index` (migration 66) with the same
owner-or-`family` visibility scoping applied at query time.

### Access Permissions (migration v74)

Role- and member-based access control for interactive users (#467). Governs which modules a
non-admin family member can see/read/edit and which dashboard widgets are available. **Sparse:** only
deviations from the default are stored — a missing row means module `write` (full) and widget
`allow`, so existing installs are unchanged after the migration. Admins bypass the whole system
(always full access; no self-lockout). Resolution for a member: member override → role profile →
default. Widgets inherit their module's lock (module `none` → its widgets blocked); a widget can
also be blocked on its own (e.g. hiding the cycle widget for some members without disabling Health).
Enforcement is **server-side** — the same scope layer that guards API tokens gates interactive
sessions too; the settings UI only maintains the configuration.

| Column | Type | Constraint |
|--------|------|-----------|
| subject_type | TEXT | NOT NULL — `role` (a family_role) \| `user` (a specific member) |
| subject_id | TEXT | NOT NULL — the family_role value or the user id |
| resource_type | TEXT | NOT NULL — `module` \| `widget` |
| resource_key | TEXT | NOT NULL — module key or dashboard widget id |
| access | TEXT | NOT NULL — module: `none` \| `read` \| `write`; widget: `none` \| `allow` |
| updated_at | TEXT | ISO 8601, default now |

Primary key: `(subject_type, subject_id, resource_type, resource_key)`.

---

## Modules

### Dashboard (`/`)

Responsive grid: 1 column on mobile, 2 on tablet, 3 on desktop.

**Today Cockpit (v0.52.40):** a compact summary strip renders above the widget grid that highlights at a glance: the next urgent/high-priority task, the next upcoming calendar event, the open shopping item count, and the planned dinner for today. Tapping any cockpit item navigates directly to the relevant module. The calendar cockpit card deep-links to the next event via `?open=<id>&date=YYYY-MM-DD` so the event detail popup opens immediately on the displayed occurrence.

**Mobile readability (v0.55.7):** on narrow phones, important cockpit cards span the full grid width so long German task/event titles do not split mid-word. Quick actions keep tokenized icon-button dimensions, and the dashboard reserves scroll room for the fixed FAB so it does not cover the first widget.

**Semantic interaction polish (v0.71.34):** the page exposes one primary heading, the greeting is a subordinate section heading, and FAB quick actions are native buttons without nested interactive controls. The customize control keeps a 48 px touch target on phones and a compact 40 px target on desktop.

**Cockpit-first defaults & interaction polish (v0.82.0):** the four cockpit-covered domains (tasks, calendar, shopping, meals) start **hidden** by default so the Today Cockpit is the single orientation layer above the fold and the first screen is not a wall of widgets; they stay one tap away in **Customize**, and a one-time pulse highlights the customize control on first run. Existing saved layouts are untouched. Weather is ordered last in the default grid (the only passive widget no longer leads). Widget reordering works from every input: mouse drag on the live grid, **Up/Down buttons on touch**, and **arrow keys** when the drag handle is focused (`aria-keyshortcuts`); the Customize modal reorders via the same chevron buttons (the old HTML5 row-drag was removed). Resetting the layout asks for confirmation. When every widget is hidden the grid shows a "re-enable via Customize" placeholder instead of an empty screen. Empty Shopping and Budget widgets offer a subtle "+ Create" activation link (the "All done" task state stays deliberately reward-only). The Budget widget leads with the monthly balance, one highlighted savings-rate, and a quiet income/expenses line (no equal-weight metric grid). A **load failure renders a distinct error state with a Retry action** — network, expired-session, and server errors get different copy — instead of empty widgets that look like a calm day.

**Widgets:**
- Greeting: "Good [morning/afternoon/evening], [Name]" + date; auto-refreshes on `visibilitychange` so the greeting stays current during long sessions
- Weather: server-side proxy with two providers — **Open-Meteo** (default, no API key, WMO codes mapped to Lucide icons and translated via `wmo.*` i18n keys) and **OpenWeatherMap** (legacy, via `OPENWEATHER_*`). Provider resolves from DB preferences (Settings → Administration → Household weather) first, then env vars. 5-day preview, refresh every 30 min, hide widget on API error
- Upcoming events: next 3–5, color-coded by person; each row navigates to `/calendar?open=<id>&date=YYYY-MM-DD` so the event detail popup opens on the displayed occurrence, including recurring series instances
- Urgent tasks: priority urgent/high + due_date ≤48h
- Today's meals: meals for the current day
- Pinboard preview: 2–3 pinned notes (Markdown formatting rendered)
- Birthdays, Budget (monthly balance/savings-rate), Family members
- Rewards (v0.96.0): family points leaderboard — top 5 enabled participants by ledger balance, the leader row subtly tinted (no medal/emoji), plus a "N to approve" footer when redemptions are pending
- Health (v0.96.0): today's medication doses as a "taken/total" progress bar with the next open dose and a low-stock reorder chip. **Personal scope (v1.50.1 · #592):** only the signed-in user's **own** medications are aggregated (private *and* family-visible ones); another member's medication never surfaces here, not even with `visibility = 'family'`. Shared medications stay on the Health page, which keeps its family-visible read scope
- Housekeeping (v0.96.0): compact status — currently-present indicator (worker + since-time) or last visit + this-month visit count, plus an outstanding-amount chip
- Cycle (v0.98.0): **owner-only, opt-in** prediction glance — current phase, cycle day in a mini progress ring, and the next period as a countdown + date. Unlike the family-visible widgets, cycle data is **never aggregated into the shared `/dashboard` payload**: the tile fetches the signed-in user's own `/health/cycle` data client-side, and only when the tile is enabled. Default-hidden, offered as an opt-in in Customize; hidden when the Health module is disabled
- Clock (v1.84.0 · #651): time and weekday + date, built for a wall tablet without a system bar. The digits scale with the tile width (container query on the existing `dashboard-widget` container, capped by row count so a one-row tile does not blow the date off the card), follow the user's 12h/24h and date-format preferences, and tick on the minute rather than the second (the display has no seconds). A `visibilitychange` refresh catches up after a throttled background tab. **Default-hidden:** on a device with a system clock a second one is duplication, so it is offered as an opt-in in Customize
- FAB (quick actions): + Task, + Event, + Shopping list item, + Note

The three newer modules (Rewards, Health, Housekeeping) start **hidden** by default — they are specialised and not active in every household, so they are offered as opt-ins in **Customize** rather than adding empty tiles to a fresh dashboard. Existing saved layouts are untouched.

**Widget sizes:** each widget has a configurable size using named presets (Tiny, Narrow, Tall, Standard, Large, Full) that map to `columns × rows` in the CSS grid. List widgets (tasks, calendar) default to the tall/narrow **Tall** (1×2) preset so a short list keeps useful height without occupying a full two-column row. Sizes are persisted in user preferences and survive page reloads.

Skeleton loading instead of spinners (the skeleton mirrors the default-visible widgets at their correct grid-spanning sizes to prevent layout shift). Clicking any widget navigates to that module.

### Tasks (`/tasks`)

**Views:**
- List view (default): grouped by category or due date (toggleable), filter: person, priority, status. **Each of those three axes takes several values at once (v1.78.1, #671)** and combines them with OR — "high or medium" is a question worth asking, while AND across two priorities would always be empty, since a task carries exactly one. The axes still combine with AND among themselves, so every row narrows the list. Tags stay AND-combined (see [Task Tags](#task-tags-migration-v115-586)); there a task really can carry both. `GET /api/v1/tasks` takes each value as its own parameter (`?priority=high&priority=medium`) and keeps accepting a single one
- Kanban: columns Open → In Progress → Done, drag & drop
- View mode persisted in localStorage; URL parameter `?view=kanban` overrides (useful for tablet kiosk setups)

**Features:**
- CRUD + subtasks (max 2 levels, checkbox list, progress bar). Subtasks are tickable **wherever they are visible** — on the task card and, since v1.78.1 (#671), in the detail view too. Read-only rows there had assumed the list next door would carry the interaction, but that list keeps them behind a collapsed progress bar, so a freshly created subtask could end up visible and unreachable at the same time
- **Subtasks expanded by default (#623):** a household-wide preference (`tasks_subtasks_expanded` in `sync_config`, admin-gated, default off) decides whether the subtask list of a task starts open instead of collapsed behind its progress bar. Manual expand and collapse still work per task; the preference only sets the starting state. Settings → Modules → Module options.
- **Multi-person assignment:** tasks can be assigned to multiple family members simultaneously via `UserMultiSelect` checkbox dropdown; stacked avatar circles (up to 3 visible + `+N` overflow badge) shown on task cards and Kanban — each circle shows the member's profile photo if set, otherwise coloured initials
- Priorities shown visually via color/icon
- Recurring: automatically create next instance on completion
- Archive: completed tasks can be archived (status = 'archived'); visible in a separate Archived filter
- Inline reminder presets: offset from due date/time — 15 min, 1 h, 1 d, 2 d, 1 w, 2 w, or fully custom offset
- **Bulk actions (list view only):** select multiple tasks via checkboxes and apply batch operations (mark done, mark open, archive, delete, add tag, remove tag); bulk select toggle in toolbar
- **Tags (#586):** free-form labels alongside the single category — see [Task Tags data model](#task-tags-migration-v115-586). Chips on the task card and the Kanban card (three, then a `+N` summary) filter the list on click; several selected tags narrow it. A tag editor with suggestions sits in the task dialog (Enter or comma confirms, Backspace takes the last one back), and a "Manage tags" action in the toolbar opens the `yuvomi-tag-manager` modal to rename, merge and remove a tag across the whole household. Renaming onto an existing tag merges the two.
- **Start date:** tasks can have an optional start date; tasks with a future start date are hidden from the default list view to reduce cognitive load. A "Show scheduled" toggle chip in the filter bar reveals all upcoming planned tasks. Task cards display a "Starts on …" badge when a start date is set.
- **"Assigned to me" quick filter:** a toggle chip in the filter bar limits the list to tasks assigned to the current user (a shortcut for the person filter); the choice is remembered per device. Shown only in multi-member households.
- **Per-task visibility:** an "all / assignees only / private" selector in the task dialog controls who can see the task (server-enforced, no admin bypass — see [Tasks data model](#tasks)); restricted tasks carry a lock/people icon in the list.
- **Customizable categories:** a "Manage categories" action in the toolbar opens the shared `yuvomi-category-manager` modal to add, rename, reorder, and delete task categories (predefined set localized, custom categories added inline). Deletion is blocked while a category is in use or when it is the last one — see [Task Categories data model](#task-categories-migration-v83).
- **Linked documents:** documents from the Documents module can be optionally linked to a task from the task dialog, so supporting information (manuals, policies, service instructions) is reachable directly from the task. Linked documents appear as chips that open the document preview/download; a paperclip badge with the count shows on the task card. Only documents the user may see are listed or linkable (document visibility enforced, no admin bypass) — see [Task Documents data model](#task-documents-migration-v86).
- **Full-text search (v1.36.0):** a search field in the module head filters the list and the Kanban board instantly by title and description (client-side, on top of the server-side status/priority/person filters). A search without hits names the query instead of claiming the module is empty.
- **Responsive toolbar (v1.36.0):** the toolbar follows the shared Documents/Contacts grammar — a wrapping module head (search, view switch, bulk select, categories) above a permanently visible filter row that carries the filter chips and the grouping choice. The earlier `<details>` overflow panel was removed: it hid the view and grouping controls behind a click without showing their state. Bulk actions remain hidden until at least one task is selected. Checkbox and row actions use the shared touch-target tokens.
- **Operable controls (v1.36.0):** filter chips are `<button aria-pressed>` (the same markup Documents and Contacts already used for the shared `.filter-chip` class), the task title and the Kanban card title are buttons that open the task, and the subtask progress bar is a button with `aria-expanded`. All of these were previously `<div>`s reachable by pointer only — the subtask list (`display: none`) had no keyboard opener at all.
- Mobile swipe: left = done, right = edit
- Badge for overdue tasks

### Shopping Lists (`/shopping`)

- Multiple lists in parallel
- Items: name, category, quantity, checkbox
- Grouping by category (aisle logic)
- Integration with meal plan: "Add ingredients to shopping list" transfers with source reference
- **Bulk import from meal plan (v1.3.0):** a "From meal plan" action in the list header opens a date-range dialog (defaults to the next 7 days) and imports the ingredients of every planned meal in that range into the active list. Repeated ingredients are aggregated before insertion — numeric quantities with a matching unit are summed, purely textual quantities collapse to a `N × …` note. Already-transferred ingredients are skipped via the existing `on_shopping_list` flag (`POST /api/v1/shopping/:listId/import-meal-plan`).
- Checked items shown with strikethrough + moved to bottom
- "Clear list" = remove checked items only
- Autocomplete from previous entries (local)
- **Category management lives in Shopping** (no longer in Settings): a "Manage categories" action opens the shared `yuvomi-category-manager` modal (also reachable directly via `/shopping?manage=categories`) for add, rename, reorder, and delete - the same component as Tasks, Contacts and Budget, resolving default category names through their localization and preserving the API's last-category-deletion guard. The legacy Settings → Shopping tab redirects here.
- Mobile quick-add form uses a resilient grid: item name spans the row, quantity/category/add controls remain touch-safe at 390px width, and autocomplete stays anchored to the input.
- Mobile swipe: left = check/uncheck, right = delete; × delete button hidden on mobile (swipe takes over)
- **Deletion friction follows severity:** removing single items (or the checked ones) is undo-based (5-second toast), while deleting a whole list - which cascades to all its items - asks for confirmation first, mirroring the Budget convention for cascading deletions. **Both, for the list (v1.59.0):** the confirmation now names how much it destroys ("Delete list 'Weekly Shop' and 31 items?", with a separate wording for an empty list) and the deletion afterwards runs through the same 5-second undo as every other deletion in the module. The gradient used to be inverted — a single item had undo and no confirmation, the household's whole list had a confirmation and no undo.
- **Mobile head is one row (v1.59.0):** the three permanent head actions (from meal plan, manage categories, delete list) move into an overflow menu **with labels** below 768 px. They were three unlabelled glyphs before, one of them "Delete list". The two completion actions ("Into pantry", delete checked) move out of the head entirely into the shared `.kitchen-bulkbar` above the list, where a line states what they act on ("3 items checked off"). Measured: head 173 px → 65 px at 393 px width (229 → 65 at 320 px), first data row 439 → 308 px of 852 px, 17 → 11 tab stops.
- **Quick-add is a disclosure on touch (v1.59.0):** the two-line quick-add form is collapsed on pointer-less devices and opened by the FAB, which until then was the only FAB in the kitchen that merely focused an already-visible field instead of opening a form. Esc closes it and returns focus to the FAB. On pointer devices the field stays open — it is faster than any button — and the redundant empty-state CTA is dropped there instead, because the input it points at is visible right above it.
- **Item editor (v1.59.0):** the detail dialog is titled "Edit item" (shared key with the pantry) instead of carrying the data value as its title, offers name, quantity and category besides link and note, and has a Cancel button. Before this it had two fields, no Cancel, and neither name nor quantity could be changed — a typo meant deleting the row and re-creating it. Deleting stays in the row (× on pointer devices, swipe on touch), both with undo.
- **"Apply" is disabled at zero hits (v1.59.0)** in the meal-plan import dialog, matching its sibling action "Randomize plan"; the preview enables it as soon as the range contains ingredients.

### Meal Plan (`/meals`)

**Desktop:** weekly planner board (Mon–Sun) with meal-type rows (breakfast / lunch / dinner / snack): each type is labelled once in a sticky left gutter column and the rows stay aligned across all days. Day columns keep a readable minimum width — when the viewport cannot fit the full week, the board becomes a horizontal scroll-snap window with an edge fade as scroll affordance instead of squeezing the columns (labels and dish names are never hyphen-broken; v1.40.1). **Collapsible recipe column (v1.57.0):** the sidebar costs 272–320 px, which is exactly what the board needs for the sixth and seventh day — with it open, Saturday and Sunday sit behind the scroll edge on a 1280–1440 px window, the two days a household is most likely to plan. A toggle in the week navigation folds it away, and the choice is remembered per browser. **Folded by default when the week does not fit (v1.58.0):** the default is measured, not tied to a viewport breakpoint — the column starts folded whenever the board would overflow with it open, because the number of columns depends on the visible meal types and shifts again with zoom and font size. An explicit toggle still overrides the default permanently. **Start-edge affordance (v1.58.0):** the sticky gutter column carries a hairline once the board is scrolled. The end fade alone was not enough: the board auto-centred on today, which pushed the first weekday behind the gutter's opaque background, and the start mask is deliberately disabled there because it would fade the gutter labels themselves. Auto-centring now only happens when today is actually out of view, so the week starts on Monday. **Empty week (v1.58.0):** a week without meals renders the shared empty state (icon, title, description, cross-tab hint, CTA) instead of up to 28 dashed boxes. **Mobile:** the same full week (Mon–Sun) stacked vertically and scrollable, auto-scrolled to today on open.

- Meal: title + notes + ingredient list
- "→ Shopping list" button: transfer unchecked ingredients of the week to a selected list
- **Ingredients of recipe-based meals (v1.57.0):** a meal planned from a recipe only stores its `recipe_id` and no ingredients of its own, so the shopping-list transfer used to have nothing to hand over and its button stayed hidden on exactly those cards. The week response now reports `recipe_ingredient_count` for such meals, and the first transfer materializes the recipe's ingredients into real `meal_ingredients` — after that the usual `on_shopping_list` flag guards the meal (unlike the reusable recipe) against transferring twice. Meals with ingredients of their own are untouched; theirs take precedence.
- Week navigation forward/back
- Drag & drop between days/slots
- **Recipe sidebar with drag & drop (v1.3.0):** a desktop recipe sidebar lists saved recipes; drag one onto any day/slot to plan it directly, with the recipe's title, notes, URL, and ingredients pre-filled. Slots only accept recipes whose `meal_types` suitability includes that slot. The existing per-slot `+`/add-button flow remains as the keyboard/touch path.
- **Week plan randomizer (v1.3.0):** a "Randomize plan" action fills the visible week's empty (or, opt-in, all) slots with randomly chosen suitable recipes, respecting each recipe's `meal_types` and the household's visible meal types. Reports how many meals were planned; no-op with a notice when the week is already full or no compatible recipes exist.
- Autocomplete from meal history
- **Multiple items per slot:** each day/meal-type cell can hold any number of meals, displayed as stacked cards with a separator. A hover-visible `+` button lets you add another item to an already-filled slot without clearing the existing entry. (v0.63.3)
- **Recipe integration:** Select a saved recipe from the meal modal to auto-fill title, notes, URL, and ingredients. Scale ingredient quantities by a numeric factor. Save the current meal as a new recipe with one click.
- **Weekly meal repeats:** New meals can be marked as weekly repeats from the advanced meal dialog. Yuvomi stores a recurrence template, materializes future occurrences for each loaded week, shows a repeat badge on generated meals, and records per-date skip exceptions when a single occurrence is deleted. Editing or deleting a recurring meal offers a scope choice — **this date only** or the **whole series**: series edits propagate the content fields and ingredients to the template and every materialized occurrence, while series deletion removes the template together with all of its occurrences. (v0.78.1, series scope v1.1.0)
- **Bounded repeats (v1.66.0):** a weekly repeat can carry a **repeat-until** date, set next to the repeat toggle when the meal is created and editable later under the series scope; leaving it empty keeps the series open-ended, as before. Materialization stops at that date, and shortening a running series removes the occurrences already generated behind the new end. Deleting a recurring meal gained a third scope — **this and all following** — which ends the series the day before that occurrence, keeps everything earlier, and stops the regeneration that previously refilled every week the moment it was opened. Ending a series on its very first occurrence drops the template outright. Without a boundary, an open series planted one row per meal into every week a user ever paged through, and the only way back was deleting each occurrence individually while the next week already produced a new one (#619).
- **Customizable meal visibility:** In Settings, users can toggle which meal types (breakfast, lunch, dinner, snack) are shown in the planner and the dashboard's Today Meals widget. Stored as household-wide preference in `sync_config` (key: `visible_meal_types`). At least one type must remain active.

### Recipes (`/recipes`)

Reusable recipe cards linked to meal slots.

- CRUD: title, notes, recipe link, per-ingredient category
- **Meal-type suitability (v1.3.0):** each recipe carries a `meal_types` list (breakfast / lunch / dinner / snack, all selected by default) chosen via checkboxes in the recipe editor. It gates which planner slots accept the recipe (sidebar drag & drop) and scopes the week randomizer's candidate pool.
- Duplicate existing recipes
- **"Add to meal plan" (v1.58.0):** asks for the date and the meal type in a small dialog on the recipe card and creates the meal right there — no navigation, and the meal type is pre-selected from the recipe's own `meal_types` (dinner when the recipe declares several). Before this it navigated to `/meals?recipe=<id>`, where the full 27-field meal form opened with an empty date field and a title that did not name the recipe; escaping left the query parameter behind, so a reload re-opened the form. The parameter no longer exists. This makes all five kitchen transfers one pattern: pick the target in a small dialog, then a toast naming what moved.
- **"Add to shopping list" (v1.57.0):** a second action on every recipe card that carries ingredients puts them straight onto a shopping list — one list transfers without asking, several open the shared selection dialog, the same pattern the meal planner and the pantry already use. Unlike meals, a recipe is **not** marked as transferred: it is a template that gets cooked repeatedly, so a `on_shopping_list` flag would be set forever after the first shop. Instead the server skips ingredients already sitting **unchecked** on the target list and reports `transferred` and `skipped` separately; items ticked off from an earlier shop come along again. Before this, the only route from a recipe to the list was plan → switch tab → "From meal plan" → pick week, four steps across two modules.
- **Row actions collapse on narrow rows (v1.59.0):** edit, duplicate and delete take 152 px of a 262 px row at 320 px width; below 30 rem **row** width (a container query, not a viewport breakpoint) they move into the shared overflow menu with labels, and the ingredient count drops below the title. Without this the recipe name fell to `min-content` — with `overflow-wrap: anywhere` that is the width of the widest single character: 8 px, one character per line, a 448 px tall row, one recipe per screen. Measured after: 182 px name, 69 px row height.
- **Recipe provider mirrors (#530):** with a recipe provider account connected (Settings → Kitchen — Mealie or Tandoor), its recipes appear in the same list as native ones, carrying a source badge in the collapsed row and a thumbnail, so a mixed list is readable without opening each entry. A source filter (all / native / one entry per connected provider) sits in the header as a menu button — the same popover component the row overflow actions use — and only appears once a mirrored recipe exists. Mirrored recipes are read-only: the UI drops the edit affordance and the server returns 403, so the two cannot drift. "Duplicate" forks one into an editable native recipe. They behave like any other recipe everywhere else: meal-plan picker (grouped by source when a mirror exists), shopping-list transfer, scaling. A rename at the source updates the mirrored copy in place instead of replacing it, so its meal-plan links survive. Each provider plugs in behind a shared adapter interface (`server/services/recipe-providers/`), the same pattern the DMS module uses for Paperless/Papra — adding a third provider needs a new adapter, not new sync/route/frontend logic.
- REST API: `GET/POST /api/v1/recipes`, `PUT/DELETE /api/v1/recipes/:id` with ingredient sync (`meal_types` included), `POST /api/v1/recipes/:id/to-shopping-list`, `GET /api/v1/recipes/:id/provider-thumbnail` (proxy). Recipes report `source: native | mealie | tandoor`.

### Pantry (`/pantry`) (v1.55.0)

The fourth tab of the Kitchen group and the fourth side of its cycle: plan (Meals) → cook (Recipes)
→ buy (Shopping) → **store**. Answers "how much do we still have", "where is it" and "what runs out
soon" (#596).

- CRUD: name, quantity + unit, storage location, category, best-before date, minimum stock, note. One row is one batch; a second pack with a different date is a second row.
- **Numeric quantity with a per-unit step:** the ± stepper books stock in and out in one tap. Countable units step by 1, grams/millilitres by 100, kilograms/litres by 0.5, so "+" on flour is not a whole kilo. Updates are optimistic and the PATCH is debounced (450 ms); each request carries a sequence number so a slow response cannot overwrite a newer tap. **On narrow rows the value moves above the buttons (v1.59.0)** — a container query on the **row**, not a viewport breakpoint, because the same row is 720 px wide in the desktop reading column and 286 px on a 320 px phone. Horizontally the stepper took 167 px of a 262 px row (71 px of it the quantity field alone), leaving 31 px for the name: "Olivenöl extra vergine" ran to eight lines and rows to 369 px. Measured after: 106 px name, rows 85–155 px. The value stays with the buttons that change it rather than moving into the meta line.
- **Status is derived, never stored:** expired, expiring within seven days, running low (at or below `min_quantity`), and out of stock. Badges appear **only** on rows that carry one of these states, so the rows that need attention stand out instead of every row wearing a pill.
- **Filter chips** for expired / expiring soon / running low, each with a count. A chip is only rendered when it has hits, and the active filter resets itself when it loses its last one — a chip can never lead to an empty list. Without a filter the list groups by storage location; with one it goes flat and sorts by urgency, and the location moves into the meta line.
- **Storage locations** are their own table, renameable, sortable and deletable through the shared category-manager component. Deleting one keeps the stock and leaves those items location-less.
- **Two-way handover with the shopping list.** Pantry → Shopping: a per-row action on low/empty items and a bulk action in the "running low" filter; the quantity is pre-filled with the shortfall to the minimum stock, or left open when none is set. Shopping → Pantry: everything ticked off after a shop is booked in through a dialog with one shared storage location and a per-item quantity/unit, parsed from the free-text shopping quantity for the language-independent metric units (g, kg, ml, l).
- **Scope separation:** `POST /api/v1/pantry/import-shopping` deliberately does not clear the shopping list — the client calls the existing `DELETE /api/v1/shopping/:listId/items/checked` afterwards, so a `pantry:write` token can never delete shopping data.
- REST API: `GET/POST /api/v1/pantry`, `PUT/PATCH/DELETE /api/v1/pantry/:itemId`, `GET/POST /api/v1/pantry/locations`, `PUT/DELETE /api/v1/pantry/locations/:locId`, `PATCH /api/v1/pantry/locations/reorder`, `POST /api/v1/pantry/import-shopping`, plus `POST /api/v1/shopping/:listId/import-pantry` on the shopping side.

### Calendar (`/calendar`)

**Views:** Month (default on desktop, dot indicators), Week (hour grid), Day (timeline), Agenda (list). On mobile the first load defaults to Agenda view; after the user manually switches views the selected view is persisted for subsequent visits.

- CRUD: title, description, start/end, all-day, location, color, assignment
- **Flexible time entry (Discussion #442):** the time inputs accept compact (`0930`, `930`) and separator (`09.30`, `9,30`, `9h30`) notation in addition to `09:30`, `9`, and `9 am`; on blur the value is normalized to the locale's display format. Centralized in `parseTimeInput()`/`toTimeParts()` (`public/i18n.js`), so it applies to every time input in the app (calendar, tasks).
- **Default appointment duration (Discussion #441):** a household-wide default duration (Settings → Modules → Calendar; `sync_config.calendar_default_duration`, minutes, default 60) sets the end time of new events relative to the start. Inside the event dialog the duration is remembered dynamically: editing the end updates the remembered duration, and a subsequent change to the start re-derives the end from it (with roll-over past midnight). Timed events only.
- **Selectable week start (Discussions #484, #465):** a household-wide setting (Settings → Modules → Calendar → View; `sync_config.week_start`, one of `monday`/`sunday`/`saturday`, default `monday`) chooses the first day of the week across the month grid, week view, and their navigation. Any member can change it. A segmented control shows a live weekday-order preview and saves instantly. The displayed **ISO week number stays Monday-anchored** by design (ISO 8601). Client mapping via `weekStartIndex()`/`weekdayOrder()` (`public/utils/date.js`).
- **Multiple reminders per event (Discussion #436):** an event can carry several reminders (e.g. "15 minutes before" *and* "1 day before"), managed as a row list in the event dialog (add/remove, max 5). See the Reminders data-model section for the API.
- **Multi-person assignment:** events can be assigned to multiple family members via the same `UserMultiSelect` component as tasks. Assigned members appear as an avatar stack (photo or initials, "+N" overflow) on each event across the month, week, day, and agenda views — the same `renderAvatarStack` component as the Tasks list; the assignee names are carried in the chip's `title`/`aria-label` for screen readers. On the mobile month grid, where events collapse to colored dots, the stack is hidden with them.
- Color-coding per person
- **"Assigned to me" quick filter:** a toggle in the calendar toolbar limits every view to events (and calendar-shown tasks) assigned to the current user; remembered per device, shown only in multi-member households
- **Per-event visibility:** an "all / assignees only / private" selector in the event dialog controls who can see the event (server-enforced, no admin bypass — see [Calendar Events data model](#calendar-events)); it is an in-app control and does not filter the ICS export feed
- Recurring via iCal RRULE (daily, weekly, monthly, yearly)
- **Google Calendar:** OAuth 2.0, Calendar API v3, two-way sync of **multiple calendars** at once. After connecting, an admin enables/disables each available calendar via checkboxes in Settings (state in `google_calendar_selection`); enabled calendars are imported together, each in its own color, with its own incremental sync token. Disabling a calendar removes its imported events and clears its token (clean resync on re-enable). Outbound is **per-event**: a local event is only pushed to Google when it carries an explicit target calendar (`calendar_events.target_google_calendar_id`), chosen via the unified sync-target picker in the event dialog; events without a target stay local. The sync-target picker lists only **writable** Google calendars (accessRole `owner` or `writer`); read-only calendars (accessRole `reader` / `freeBusyReader`) are excluded from the picker. The server-side outbound sync additionally guards against writing to a calendar that has lost write permission after the event was created. A **read-only mode** checkbox prevents Yuvomi from pushing any local events back to Google while still reading incoming events normally; the flag is stored as `google_readonly` in `sync_config` and cleared on disconnect. Timed events are stored as local wall-clock time without a zone, so outbound pushes declare the **target calendar's own time zone** (read from the same `calendarList.get` metadata call as color and access role) — the event then shows the same clock time in Google as in Yuvomi, wherever the household lives. If Google reports no zone for that calendar, the server falls back to `TZ`, then the host zone, then UTC (v1.45.11). **Deleting, editing or moving a mirrored event in Yuvomi reaches Google too (v1.51.0 · #593):** before this, outbound was `events.insert` only — an event that had already been pushed was never touched again, so local deletes and edits stayed local. Both now record their intent first (a tombstone in [Calendar Pending Deletions](#calendar-pending-deletions) for deletes, `calendar_events.outbound_dirty` for edits) and then try the `events.delete` / `events.patch` call immediately after answering the request; if that fails, the next sync run retries it. Both run **before** the inbound pass, so a full resync cannot resurrect a deleted event and a local edit reaches Google before the old remote state could be written over it; the inbound pass additionally skips events with an open tombstone or an unpushed edit, so a pending local change is never silently overwritten. A remote `404`/`410` counts as settled (the event is already gone in Google), and after five failed attempts the pending operation is dropped with an error log. An edit whose target calendar is no longer writable is dropped rather than retried forever. Nothing is recorded in read-only mode or without a connected account, and disconnecting discards open tombstones.

**Switching an event's target calendar moves it in Google (`events.move`):** picking a different calendar for an already-mirrored event queues the move in `calendar_events.outbound_move_to`, and the move runs *before* the field patch so the edit lands in the destination, not the old calendar. It requires a writable role on **both** calendars — an unwritable destination drops the queued move and leaves the event where it is, rather than retrying forever. On success the local row follows: `calendar_ref_id` and `external_calendar_id` are updated from the API response, without which a later delete would target the old calendar and leave the event standing in Google. A `400` (Google rejecting the move outright, e.g. for a single instance of a recurring series) is given up on immediately instead of burning five attempts, since it cannot succeed on a retry.

**Recurring series (v1.56.0 · #593):** the inbound list runs with `singleEvents: false`, so a series arrives as **one master** carrying its `RRULE` and is expanded locally — the same shape CalDAV and ICS have always delivered, and the shape Yuvomi stores series in. Until v1.52.1 the list ran with `singleEvents: true` and a series was stored as its individual occurrences, which collided with uploaded series (whose row holds the *master* id) and duplicated every occurrence.

Three details make this work:

- `showDeleted: true` is required, because a single cancelled occurrence is only visible as a cancelled instance; that is what an `EXDATE` is derived from. A cancelled instance removes its date from the series instead of deleting the series.
- **No `timeMin` on a full resync.** Without `singleEvents`, the time window is matched against the *series start*, not its occurrences, so a weekly series begun in 2019 would fall out of the request entirely. Dropping the lower bound costs nothing in volume — one master replaces all of its instances.
- Masters are processed before their deviations regardless of the order Google returns them, since an exception needs its master row to attach the `EXDATE` to. A moved occurrence becomes a standalone event and its *original* date is excluded from the series; the `EXDATE` lines Google carries on the master itself are read as well.

**Migrating existing data (migration v110):** the stored `syncToken` belongs to the old request parameters and is cleared, which makes the first run a full resync. That run folds the previously stored occurrences back into their series: rows the user never touched are removed because the master covers them, while a row carrying an assignment or its own colour is turned into a standalone **local** event with its date excluded from the series — the user's work survives without the appointment appearing twice. The merge runs only on a full resync, where every genuine exception is present in the same response and therefore distinguishable from a leftover; on a delta run nothing is retired. Nothing is guessed from id patterns, and no data is touched by the migration itself.

Because a series now carries the master id, moving it to another calendar and changing its repeat rule work for imported series too — previously both were rejected with `400`, since they addressed a single instance.

Related hardening: the inbound `cancelled` delete is scoped to the reporting calendar. Moving an event between two synced calendars *in Google* makes the source report it as cancelled while the destination still lists it — under the same event ID. An ID-only delete removed whichever row the destination had just written, so the event vanished locally although it existed in Google. Rows without a `calendar_ref_id` (pre-`external_calendars` data) and calendars whose metadata could not be read keep the ID-only behaviour, otherwise genuine deletions would stop arriving there.
- **CalDAV Multi-Account:** Connect multiple CalDAV servers (iCloud, Nextcloud, Radicale, Baikal) with per-account calendar selection via checkboxes, two-way sync (tsdav), optional outbound target selection per event. **Deleting, editing or moving a synced event in Yuvomi reaches the server too (v1.52.0 · #593),** using the same queue-then-sync mechanism as Google. Two things differ, because CalDAV has no per-event API: a change is a PUT of the whole calendar object, so Yuvomi *patches* the original instead of rebuilding it — only the mirrored properties are swapped, while attendees, alarms, categories and any `RECURRENCE-ID` exception in the same object stay byte-for-byte intact. And since CalDAV cannot move an object between collections, switching the target calendar is create-in-destination followed by delete-in-source, in that order: if the delete fails the event exists twice, which is recoverable, whereas the reverse order could lose it. An event whose original object was not fetched in the current run is deferred rather than rebuilt from Yuvomi's fields alone, which would silently drop everything the server knows and Yuvomi does not. As with Google, the change is attempted immediately on save: the immediate attempt fetches only the affected object rather than whole calendars, so a delete is a single DELETE on the stored URL and an edit one targeted GET plus PUT. Events synced before migration v106 have no stored URL yet — for them the immediate attempt does nothing and the next sync run, which reads the calendar anyway, resolves the URL and applies the change
- **Sync target per event, open to every member (v1.66.1 · #618):** the "Sync target" dropdown in the event editor is served by `GET /api/v1/calendar/sync-targets`, available to **every authenticated user**. It returns display name and target key only, for the enabled (and, for Google, writable) calendars — no credentials, server URLs, or usernames; account management stays admin-only. Until then the dropdown read the admin-gated management routes (`/caldav/accounts`, `/google/calendars`) directly, so a member got `403` and was left with "Store locally" as the only option — although `POST`/`PUT /api/v1/calendar` had always accepted a target from any member, which made the restriction an accident of the read path rather than a permission boundary. Each provider falls back to an empty group on its own, so an expired Google token no longer swallows the CalDAV targets, and one request replaces the previous one-per-account round trips
- **Default assignee per sync target (migration v79):** each synced calendar (Google/CalDAV) and each ICS subscription can be given an optional default assignee in Settings → Sync; newly imported events of that target are auto-assigned to that person (new events only — see [External Calendars](#external-calendars)). The per-calendar picker appears once the calendar has completed its first sync
- **ICS Subscriptions:** Subscribe to any public ICS/webcal URL (e.g. public holidays, sports schedules). Per-subscription color, private/shared visibility, manual "Sync now" and automatic sync on the shared interval. Edit name, color, and visibility of any subscription inline. RRULE events expanded into a rolling ±6/+12 month window. SSRF-protected (DNS pre-resolution), ETag/Last-Modified conditional fetch, 10 MB limit, 15 s timeout. User-edited events are protected from being overwritten (`user_modified`); a "Reset to original" link restores them.
- **One-time import (Discussion #437):** Settings → Sync → Calendar → "Kalender importieren" imports events from an uploaded `.ics` file or a shared calendar feed URL as **editable local events** (`external_source='local'`, no subscription) — the migration path when moving from another calendar. Unlike a subscription the events are owned by the importing user and never auto-synced; recurring events are kept as a series (RRULE reduced to the locally supported FREQ/INTERVAL/BYDAY/UNTIL subset), and the source UID is stored in `external_calendar_id` to skip duplicate re-imports of the same feed. The URL path reuses the subscription fetch (SSRF-protected, 10 MB / 15 s limits); `POST /api/v1/calendar/import` returns `{ imported, skipped, total }`.
- **Read-only export feed (Discussion #387):** Settings → Sync → Calendar → "Kalender-Feed exportieren" exposes the user's own visible events (own events, assigned events, and shared/own ICS subscriptions) as a `webcal://`/`https://` ICS feed for subscribing in Apple Calendar, Google Calendar, Thunderbird, etc. Backed by a per-user secret token (`users.calendar_feed_token`); enabling generates the token, "Neuen Link erzeugen" rotates it (invalidating the old URL), "Feed deaktivieren" clears it. The feed itself is served by a public, unauthenticated `GET /feed/calendar/:token.ics` route outside `/api/v1` (no session/CSRF — the token in the URL is the secret), rate-limited to 30 requests/minute per IP, recomputed on every request (no caching). The feed URL uses `BASE_URL` when set, falling back to the request's protocol/host. Token management (`GET/POST regenerate/DELETE /api/v1/calendar/feed`) requires authentication. An opt-in toggle "Zugewiesene Personen im Titel anzeigen" (default off, persisted in `users.calendar_feed_show_assignees` via `PUT /api/v1/calendar/feed`, Discussion #482) appends the assigned members to each event's title in the feed, e.g. `Poolparty (Mama, Papa)` — names are ordered alphabetically and RFC-5545-escaped. Existing subscribers' titles stay unchanged until enabled.
- **External calendar names & colors:** Google and Apple sync stores each calendar's display name and background color in the `external_calendars` table (migration v14). A colored `event-cal-label` badge appears in event popups, agenda, month, week, and day views when `cal_name` is present.
- **Event color sync (Discussion #427):** Each provider preserves per-event colors, not just the calendar color. Inbound, Google's `colorId` is resolved to a hex value via the event color palette (`colors.get`, cached 24 h), and the iCalendar `COLOR` property (RFC 7986 — CSS3 name or hex) is read for CalDAV, Apple, and ICS subscriptions; an event without its own color inherits its calendar's color. Outbound to Google, a local event's hex color is mapped to the nearest of Google's 11 event `colorId`s (perceptual redmean distance). Locally recolored events are protected across syncs by the unified `user_modified` flag: a resync overwrites an event's color only while `user_modified = 0`, so remote color changes still flow in until the user picks their own color, after which it stays fixed. The `COLOR`↔hex mapping lives in `server/utils/ical-color.js`.
- **Event location:** Event popup and dashboard display the location field with RFC 5545 backslash-escape normalization (`\n`, `\,`, `\;`, `\\`) via `fmtLocation()` in `public/utils/html.js`.
- **Custom event icons:** Each event can have an icon chosen from a visual picker; the server validates against a fixed allow-list (`VALID_EVENT_ICONS` in `server/routes/calendar/helpers.js`, currently 104 entries — Lucide names plus the custom `tooth` glyph). Birthday events are automatically assigned the `cake` icon. Icon stored in `calendar_events.icon`.
- **File attachments:** Events support a single file attachment (images, PDFs, Office documents, ≤ 5 MB). Images are displayed inline in the event popup; other files show a download link. Drag-and-drop upload is supported in the event modal. New attachments create one `family_documents` object through the active document-storage backend and link it via `attachment_document_id`; no second binary copy is written to `attachment_data`. Existing legacy Base64 attachments remain readable. Unchanged attachments are not re-uploaded, and removing an attachment only unlinks it from the event.
- **Overlapping events:** In week and day views, timed events that overlap in time are rendered side-by-side using a column-layout algorithm instead of stacking.
- **Task chips:** Open and in-progress tasks with a `due_date` appear as read-only priority-coloured chips in all four calendar views (month, week/day all-day row, agenda). Clicking a chip navigates to `/tasks?open=<id>` and opens the task edit modal. Tasks with `due_time` show the time in the chip label. Done/archived tasks are not shown. No server changes required — tasks are fetched in parallel with events on each range load (`GET /api/v1/tasks?include_future=1`), filtered client-side, and rendered via `renderTaskChip()`.
- **Readability polish (v0.55.10):** month cells use stronger work surfaces, explicit grid/chip boundaries, and clearer today emphasis. Agenda rows and task chips use solid surfaces plus borders for contrast in both themes. Calendar metadata uses Lucide icon placeholders and shared icon classes instead of visible emoji markers.
- Configurable sync interval (default 15 min)
- External events visually distinguishable
- Conflicts: external event wins, local additions are preserved

### Notes (`/notes`)

Responsive grid with colored sticky notes. Phones use one readable column; wider containers progressively use two columns from 520px, three from 720px, four from 900px, and five from 1200px. The title keeps its intrinsic width while search flexes into the remaining toolbar space, preventing clipping on narrow screens.

- CRUD: title (optional), content, color
- Pin → appears at top + on dashboard
- Creator shown (profile photo if set, else coloured avatar with initials)
- Markdown rendering: the card renders the full set the editor toolbar offers — headings (`#`–`###`), ordered/unordered lists, checklists (`- [ ]` / `- [x]`), blockquotes, dividers, inline code, links (safe schemes only), **bold**, *italic*, ~~strikethrough~~, and underline. Shared renderer (`renderMarkdownLight`), so the dashboard pinboard preview shows the same formatting
- Reader mode (v1.25.0): opening an existing note shows a rendered Markdown reader by default; a Read/Edit toggle (segmented control) switches to the editor and back within the same modal. New notes open directly in the editor. Both panes stay mounted, so the toggle never discards unsaved input and the reader reflects live edits. Cancel/Save are hidden in read mode, while **Delete stays available in both modes (v1.36.0)** — previously the whole footer disappeared, leaving an opened note without a single object action
- Full-text search: client-side filter bar, filters instantly by title + content, with a clear (×) control
- **Creator filter (v1.36.0):** a chip row below the module head narrows the board to one author's notes. Shown only when at least two people have written notes; clicking the active chip clears the filter again
- **Pinned grouping (v1.36.0):** pinned notes were always sorted first, but the boundary was only inferable from the ring on the card. Two section headings ("Pinned" / "Other notes") make the existing order legible; they appear only when both groups exist
- **Open action (v1.36.0):** each card carries an explicit open button. The card itself is a `<div>` with a click handler, so keyboard and screen-reader users previously had no way to open a note at all — only pin and delete were reachable
- Card previews are height-capped (`line-clamp`), so a single long note no longer pushes every other note out of view

### Contacts (`/contacts`)

- CRUD with category filter
- **Separate first/last name (v1.38.0):** the contact dialog has two name fields grouped under one required marker ("Name \*") — at least one of them must be filled. The display name is composed as `First [Middle] Last`, and the list sorts by last name, so contacts read the same no matter which CardDAV server they came from. A contact that has no stored components yet is pre-filled by splitting its display name at the last word; that guess is only saved when a name field is actually edited. A category the household does not (or no longer) manages is offered as its own option instead of silently falling back to the first entry — see [structured name components](#contacts)
- **Customizable categories:** a "Manage categories" button in the toolbar opens the shared `yuvomi-category-manager` modal to add, rename, reorder, and delete contact categories (predefined set localized with per-category icons and color tints, custom categories added inline). Deletion is blocked while a category is in use or when it is the last one — see [Contact Categories data model](#contact-categories-migration-v84)
- **Multi-value fields:** multiple phones, emails, and addresses per contact, each with a label (mobile, work, home, etc.) and optional `isPrimary` flag
- **Additional fields:** organization, job_title, birthday, website, photo, nickname
- Phone: `tel:` link, email: `mailto:` link
- Address: Maps link (vendor-neutral OpenStreetMap search)
- Real-time search filter; screen-reader live-region announces the result count
- **Keyboard shortcuts:** `/` focuses search, `n` creates a contact (disabled while a modal is open or while typing in a field)
- **Bulk selection (opt-in):** a toolbar toggle enters selection mode — rows become checkboxes with select-all and batch delete (5-second undo). Family-linked contacts (`family_user_id`) are not selectable, since they can only be removed via their member profile
- Rows are keyboard/screen-reader operable (each row is a focusable button); the mobile secondary-action menu uses the native Popover API (top-layer, no clipping)
- vCard export: each contact downloadable as `.vcf` (`GET /api/v1/contacts/:id/vcard`), including `BDAY` when a birthday is set and a real structured `N` line when the contact carries name components (v1.38.0)
- vCard import: upload a `.vcf` file → client-side parser (FN, **N**, TEL, EMAIL, ADR, NOTE, CATEGORIES, and `BDAY` → `birthday`). The name is taken from the structured `N` components, with `FN` as fallback, so `Family, Given` sources import the same way as `Given Family` ones (v1.38.0); the duplicate guard compares both orders and the comma form, so a re-import of an already-synced contact is still recognised. Files with **multiple contacts** are fully supported: the parser splits every `BEGIN:VCARD…END:VCARD` block. Nothing is created silently — a **selection dialog** lists the parsed contacts with checkboxes; entries whose name already exists are pre-unchecked and badged (duplicate guard), and cards without a name are reported as skipped. Only the confirmed selection is created via `POST /api/v1/contacts` (which now accepts and stores `birthday`). The result is a single composite toast; failed creations name the reason and offer a one-click **retry** of just the failures. When imported contacts carry a birthday, the toast offers a shortcut that jumps straight into the Birthdays import dialog (see Birthdays → *Import from contacts*)
- **CardDAV multi-account sync:** connect multiple CardDAV servers (Nextcloud, iCloud, Radicale, Baikal); per-addressbook enable/disable via checkboxes, plus "enable all / disable all" once an account has more than one addressbook; read-only inbound sync, automatic on the `SYNC_INTERVAL_MINUTES` schedule plus a manual trigger. Accounts are **editable** (`PUT /api/v1/contacts/cardav/accounts/:id`) — a rotated password no longer means deleting and re-adding the account and losing the addressbook selection; leaving the password field empty keeps the stored one, and a URL+username that already belongs to another account is rejected with `409`. API routes under `/api/v1/contacts/cardav/*`: create/update/delete accounts, test connections, discover/refresh addressbooks, toggle addressbook selection, sync contacts. Error responses carry a stable `errorCode` (e.g. `account_duplicate`, `account_not_found`) that the client translates; the `error` string itself is an English developer note (v1.34.0)

### Documents (`/documents`)

Upload and manage family files with per-document access control.

- CRUD: name, description, category, file upload (PDF, images, text, Office documents; ≤ 5 MB per file)
- **Upload dialog (v1.35.0):** the file comes first — it is the object of the action and supplies the name. The name field is optional and falls back to the file name; the category defaults to "other" rather than the first list entry. The file input carries the server's `allowed_mime_types` as `accept` and its `max_file_size` as the client-side limit, so hint text and actual acceptance cannot drift apart. Visibility sits openly in the form (it is the module's core promise), while description and status stay behind "more settings"
- **Multi-file upload (v1.35.0):** several files can be picked or dropped at once. Each becomes its own document with its file name as the title, sharing the chosen category, folder, and visibility; the submit button reports "uploading n of m" while they are processed
- **Folder browser:** documents can be organized into custom folders; a sidebar lists all folders plus "Alle Ordner" and "Kein Ordner". Custom folders can be created, renamed, and deleted (via a per-folder overflow menu); deleting a folder keeps its documents (their folder link is cleared). New uploads are pre-assigned to the currently selected folder. A "Hausreinigung" folder is auto-created when the first housekeeping worker is added
- **Grid / list view** toggle; view mode persisted in localStorage. The list view carries date and file size as their own columns, so switching from grid to list adds information rather than dropping it
- **Sorting (v1.35.0):** last modified (default, matching the server's `updated_at DESC`), name, or size; the choice is persisted in localStorage
- **Category tags:** 14 predefined categories (medical, school, identity, insurance, finance, home, vehicle, legal, travel, pets, warranty, taxes, work, other)
- **Faceted filtering (v1.35.0):** category and folder are client-side facets over the status-filtered set, so filtering is instant and both axes can carry honest hit counts. Only categories that actually hold documents appear as chips (plus the active one), each with its count; each axis counts under the *other* axis but not under itself, so no visible count leads to an empty result. The category row scrolls horizontally in a single line with an edge fade — it never stacks into an unbounded block that pushes content below the fold
- **Empty states (v1.35.0):** four distinguishable states instead of one — no documents at all, no search hits (offers "clear search"), nothing matching the active filters (offers "reset filters"), and an empty archive (offers "show active documents"). Each names its actual cause and the action that resolves it
- **Bulk selection (v1.35.0):** an opt-in selection mode (toolbar toggle) turns cards and rows into toggles and reveals a selection bar with move-to-folder, archive/restore, and delete. Deletion is optimistic with a 5-second undo; direction of the archive action follows the active status view
- **Visibility:** family (all members see it), restricted (only selected members), private (only the uploader)
- **Archive / restore** — archived documents hidden from the main view, accessible via the Archive filter
- **Download** — original file downloaded with its original filename
- **Storage backends:** admins select `local`, `webdav`, or `google_drive` for future Documents and Calendar attachment uploads. Upgraded databases without a selector retain legacy behaviour: enabled WebDAV, otherwise the SQLite BLOB. `DOCUMENT_STORAGE_LOCAL_ENABLED=true` is an environment-managed `local_folder` override and always becomes the active backend without changing the selected value. Connecting Google Drive never selects it. Existing rows remain on and are always read from their recorded backend. Every out-of-database upload is compensated if the following database transaction fails.
- **Google Drive backend:** uses a separate redirect URI, `session.googleDriveOAuthState`, `drive.file` scope and `document_storage_google_drive_*` token namespace; Calendar OAuth state and token records are unchanged. New files are private under `Yuvomi/Documents`, use `external/google_drive`, store the opaque Drive file ID in `storage_key`, keep `content_data=''` and `dms_account_id=NULL`, and never create public permissions. Candidate reconnect credentials must match the stored account and read an existing Drive row before replacing working tokens. Disconnect removes local Drive state without revocation and is blocked while Drive is selected or referenced. Status is combined under `GET /documents/storage/config`; OAuth/test/disconnect routes live under `/documents/storage/google-drive`.
- **WebDAV backend:** upload failures reject the upload without a silent local fallback. Disabling legacy WebDAV selection affects only future uploads, while existing WebDAV files remain readable and deletable.
- **Local folder backend (env-only):** setting `DOCUMENT_STORAGE_LOCAL_ENABLED=true` writes new document binaries to `DOCUMENT_STORAGE_LOCAL_PATH` (default `/documents`, a host mount) as `storage_backend='local'` rows with a relative `storage_key`, instead of the in-DB BLOB. It is resolved from the environment on each upload and takes precedence over every selected backend. Legacy `local` rows without a `storage_key` continue to read from the DB BLOB. Writes fail loudly on an unwritable mount (no silent fallback); the storage key is path-traversal-validated and reads are bounded by the same 5 MB limit as other backends.
- **Shared content access:** preview, download, Calendar attachment access, and Paperless/DMS push use the same storage layer. Backend badges distinguish local folder, WebDAV, Google Drive, DMS, and orphaned/unavailable DMS entries.
- API: `GET /api/v1/documents`, `POST /api/v1/documents`, `GET /api/v1/documents/:id`, `PUT /api/v1/documents/:id`, `DELETE /api/v1/documents/:id`, `GET /api/v1/documents/:id/download`

### Housekeeping (`/housekeeping`)

Module for managing household staff workflows. Navigation uses violet accent theming.

- **Staff profiles:** each worker is linked to a user account; configurable billing model (daily flat rate or hourly), payment schedule (daily / twice monthly / monthly), calendar color, and notes; staff accounts are hidden from task assignment, dashboard member avatars, and the family contact list — their birthdays remain visible in the calendar and birthday list; staff accounts cannot log in to the app (login blocked at authentication layer)
- **Work sessions:** check-in/check-out with timestamps; open sessions shown prominently; automatic local calendar event created on check-in; optional payment task created on check-in (toggle in Settings → Modules → Module options)
- **Hourly billing:** workers with `rate_type = 'hourly'` have their `hourly_rate` and `rate_type` snapshotted at check-in; on check-out the server computes `minutes_worked` from the session duration, rounds to the nearest 15 minutes, and stores the resulting amount in `daily_rate`; the visit editor lets staff adjust `minutes_worked` directly with a live recalculation preview
- **Payment tracking:** mark sessions as paid; monthly visit log with payment summaries and paid/unpaid breakdown; visits can be edited from the housekeeping dashboard (recent visits section) or directly from a calendar event tap (deep-links via `?editVisit=<id>`)
- **Recurring chores (`housekeeping_decay_tasks`):** define chores by name, area, and frequency in days; urgency level computed from elapsed time since `last_completed`; visual decay indicator; chores can be edited, deleted, or undone (clear `last_completed`) directly from the chore list
- **Supply requests:** request supplies with optional quantity; supplies can be linked directly to shopping lists
- **Dashboard integration:** housekeeping widgets show today's open sessions, upcoming chores, and a recent-visits strip with inline edit access
- **Document folder:** a "Hausreinigung" folder in Documents is auto-created on first worker creation; receipts can be linked to individual work sessions
- **API:** `GET /api/v1/housekeeping/visits/:id` returns a single work session with worker name, task list, and linked document

### Health (`/health`)

One page module with six deep-link routes (pattern like Settings, not like the Kitchen cluster), sharing a sub-tab bar: Overview (`/health`), Vitals (`/health/vitals`), Cycle (`/health/cycle`), Medications (`/health/meds`), Labs (`/health/labs`), Activity (`/health/activity`). Toggleable like any module; disabled → router redirects to the dashboard. Health data is sensitive — enable `DB_ENCRYPTION_KEY` (SQLCipher). **Not a medical device; no diagnostic claims.**

- **Per-member scoping:** a person switcher (chip row) filters to one family member; each row is `private` (owner only) or `family` (all members). Editing is limited to the owner's own view; foreign members show family-visible rows read-only.
- **Recording for someone else:** a parent can record for a child (fever, medication) once an admin
  grants it per person under Settings → Family. The person switcher then shows "You are recording for
  X" instead of the read-only banner, and the capture button appears. Grants cover vitals,
  medications, labs and activities, never the cycle diary.
- **Vitals:** capture blood pressure (sys/dia/pulse), glucose, weight, optional SpO₂/temperature, sleep duration and mood; per-metric cards with last value + delta; native SVG trend charts with selectable range. A metric declares how its numbers read (`format`: pair, duration, scale) — sleep is entered as hours + minutes and stored as decimal hours, mood as one of five steps on a scale whose chart axis stays clamped to the full 1-5 range.
- **Medications:** medication list (name, dose, form, active/PRN), schedule editor (time slots + weekday mask + dose), "due today" view with take/skip, 7-day adherence bar, and stock/refill warnings. Reminders are delivered through the existing push/notification-channel layer (`server/services/medication-scheduler.js`) — no separate reminder table.
- **Labs:** reports with multiple analytes (value, unit, reference low/high); `low`/`normal`/`high` flag derived from value + range and colour-coded via tokens; per-analyte trend chart with a reference band; neutral medical disclaimer.
- **Activity:** training log (preset or custom type, duration, optional distance/intensity/calories, note); weekly summary cards and a native SVG bar chart per weekday.
- **Cycle:** menstrual cycle tracking. Period episodes (start/end + flow), per-day logs (flow intensity, symptoms, mood), and calendar-method predictions of the next period, ovulation, and fertile window (luteal length, cycle/period averages derived from history or overridden in settings). A native **SVG cycle-ring** shows the current phase, cycle day, and countdown; a month calendar colour-codes logged and predicted periods, the fertile window, and ovulation; plus prediction stat cards, a period history, and CSV export. A **pregnancy mode** (migration 82) in the cycle settings pauses all predictions (next period, ovulation, fertile window, ring, and calendar projection); with an optional estimated due date it instead shows the gestational week (Naegele rule, 280 days), trimester, countdown, and a progress bar, while daily logging stays available. Cycle data defaults to `private`; a per-member **default-visibility** setting (migration 96) can pre-select `family` for newly logged periods and day logs instead, and an **"apply to all"** action in the cycle settings bulk-updates every existing entry to the chosen visibility (`PATCH /health/cycle/visibility`, strictly own-scoped). The visibility of any single period or day log stays overridable in its own modal. The fertile window carries a clear disclaimer that it is not contraception and no substitute for medical advice. Cycle data is deliberately kept out of global search; the only dashboard surface is an **opt-in, owner-only tile** (v0.98.0) that shows the signed-in user's own next-period countdown and current phase — it is never added to the shared dashboard payload. The calendar distinguishes phases with **non-colour cues** (solid fill, diagonal hatch, ringed day, outline) as well as colour, so it stays legible with colour-vision deficiency.
- **Overview:** aggregated landing view — due-today medications with inline take/skip, latest vitals cards (deep-link to the Vitals tab), adherence rate + streak, quick-capture buttons, upcoming reminders, and a **CSV export** bar (one download per area — vitals, activities, labs, medication logs — with optional date range).
- **Search & shortcuts:** medications and activities appear in global search (FTS5) with the same visibility scoping and deep-link to the Meds/Activity tab; the `g h` keyboard shortcut jumps to the last-visited Health tab.
- **Accessibility:** sub-tab bar and person/range chip rows expose `role="tablist"`/`tab` with arrow-key navigation and roving tabindex; SVG charts carry `role="img"` + `aria-label`; take/skip/save actions announce via the polite/assertive live regions; modals trap focus and restore it on close.
- **API:** `GET/POST/PATCH/DELETE /api/v1/health/{vitals,medications,labs,activities}` (+ nested `…/medications/:id/schedules|logs`, `…/logs/:id/take|skip`, lab results), cycle endpoints `…/cycle/periods`, `…/cycle/logs` (upsert per day), `GET/PUT …/cycle/settings`, and `GET /api/v1/health/export/{vitals,activities,labs,meds-logs,cycle}` (text/csv). All handlers apply `user_id` scoping and `visibility` filtering.

### Rewards (`/rewards`)

Points-and-rewards module for households that want task completion to pay into something. Toggleable
like any module (Settings → Modules → Rewards); disabled → the route and the navigation entry are
gone. The data model, including why the balance is always derived from the ledger, is under
[Rewards data model](#rewards-migration-v70).

- **Three tabs** in the module head (`wireTablist`, arrow keys, roving tabindex): **Overview**
  (balances and pending redemptions), **Catalog** (the rewards on offer), **Ledger** (every booking).
- **Overview:** one flat row per participating member — avatar, name, balance, and a progress bar
  toward the cheapest reward they cannot yet afford ("still 40 points to Cinema evening"), or
  "redeemable now" once anything in the catalog is within reach. Deliberately a **flat list, not a
  ranking**: the dashboard widget carries the leaderboard reading, the module itself is per-member.
  Balances count up on load (suppressed under `prefers-reduced-motion`).
- **First-run guidance:** while the module has no participants, no priced tasks or an empty catalog,
  the overview shows the three open setup steps with a jump into the page that resolves each one.
  It disappears once all three are done — the module is useless in three separate places at once, and
  an empty balance list would not say which one is missing.
- **Redeeming:** members **request** a reward and a parent/admin approves it; an admin redeems
  directly. The verb in the UI follows that (`request` vs. `redeem`). Requesting reserves the points
  immediately as a `redeem` ledger row, so a second request cannot spend the same balance; rejecting
  or cancelling books them back as a `reversal`. `rewards_require_approval = false` (Settings →
  Modules → Rewards) drops the approval step household-wide.
- **Context FAB:** creates a reward on the Catalog tab and grants a bonus on the Ledger tab, both
  admin-only; on the Overview tab, and for members, it is hidden — the module's create actions are
  parent actions.
- **Settings → Modules → Rewards** holds the three household switches: module on/off, approval
  required, and the default point value for new tasks (with the roll-over of existing tasks
  described under [Rewards data model](#rewards-migration-v70)).
- **API:** `GET /api/v1/rewards/overview` (balances, catalog, pending count, setup counters),
  `GET/PUT /api/v1/rewards/participants[/:userId]` (admin), `GET/POST /api/v1/rewards/catalog`,
  `PATCH`/`DELETE /api/v1/rewards/catalog/:id` (admin), `GET /api/v1/rewards/ledger`,
  `GET/POST /api/v1/rewards/redemptions`, `PATCH /api/v1/rewards/redemptions/:id` (approve / reject /
  cancel), `POST /api/v1/rewards/bonus` (admin).

### First-run setup (`/setup`) (v0.58.0)

On a fresh install with no users, the first admin can be created directly in the web UI.

- The public `GET /api/v1/version` endpoint returns `setup_required: true` while the `users` table is empty (fail-safe `false` on any DB error, so setup is never forced erroneously). The exact `version` string is only included when the request carries a valid session or API token; unauthenticated callers receive `app_name` and `setup_required` only.
- The router reads this flag at boot. When `setup_required` is true and nobody is signed in, every route is redirected to `/setup`; once setup is complete, `/setup` is no longer reachable and redirects to `/login`.
- The `/setup` page reuses the login layout and collects username, display name, password, and a password confirmation (client validation mirrors the server rules). On submit it calls `POST /api/v1/auth/setup`, then signs in automatically and lands on the dashboard.
- `POST /api/v1/auth/setup` creates the first admin only while no user exists; the user-count re-check and the `INSERT` run inside a single transaction, so concurrent first-run requests cannot create two admins. Returns `403` once any user exists.
- **CLI fallback:** `node setup.js` still creates the admin from the container console for headless deployments and recovery; both paths share the same database.

### Login (`/login`)

Unauthenticated users are redirected here. No public registration form - the first admin is created via the web first-run setup (`/setup`) or the `setup.js` CLI; further users are created by an admin in Settings.

- Username + password form
- Error display for wrong credentials
- Rate limiting: 5 attempts/min/IP, 15-min lockout
- Password visibility toggle (eye/eye-off icon) to verify input before submitting
- **SSO / OpenID Connect (v0.55.14):** When OIDC is configured (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`), a "Sign in with SSO" button appears below the divider. Clicking it initiates an Authorization Code flow with PKCE (S256) and a nonce; state, nonce, and code verifier are stored in the session and consumed once. On successful callback, the user is matched by `oidc_sub`. With no `sub` match, an existing local account is linked **only when the provider reports `email_verified: true` and exactly one account holds that email** (matched against `contacts.email` / `contact_emails.value`, case-insensitive); unverified or ambiguous emails never link, and a new account is provisioned instead. SSO errors display a localized message. Providers that omit the `email_verified` claim entirely are supported via the opt-in `OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM=true` env var (v0.71.11). **Username of a provisioned account (v1.75.3, #653):** derived from the first usable claim in the order `preferred_username` → `username` (non-standard; Synology DSM SSO carries the plain account name there while `sub` also holds the directory part) → `sub`, each run through a sanitizer that enforces the app-wide `[a-zA-Z0-9._-]{3,64}` format (diacritics transliterated, everything else collapsed to hyphens) and falls through to the next candidate if fewer than three characters survive; collisions get a numeric suffix. The email is deliberately excluded: it is not unique across a household that shares one address, and it dragged its domain part into the identifier. `oidc_provider` stores the `iss` claim of the validated ID token, falling back to `OIDC_ISSUER` only when the claim is absent.
- **Failed-login logging (v0.55.15):** Failed attempts are logged as warnings with IP, username, and failure reason (`user_not_found` / `invalid_password`), enabling fail2ban / CrowdSec integration.
- **Forgot password (v0.71.51):** A "Forgot password?" link opens `/forgot-password`. The link is only shown when the server can actually deliver a reset mail: the public `GET /api/v1/version` response carries a `password_reset_enabled` flag (true when SMTP is configured **and** `BASE_URL` is set) and the login page gates the link on it, so it is never a dead end. On the reset page, entering a username or email always returns a generic "if an account exists…" response (anti-enumeration), regardless of whether the identifier matched a user or whether SMTP is configured. When it does match and the user has a linked email (`contacts.email`), a reset link `${BASE_URL}/reset-password?token=…` is emailed; the token is single-use and expires after 1 hour. `/reset-password` reads the token from the query string and sets a new password (min. 8 characters); on success, the token is consumed and other sessions for that user are invalidated. Requires an admin-configured SMTP server (Settings → Administration → Email) and the `BASE_URL` env var — reset links are only sent when `BASE_URL` is set, since the request `Host` header is never trusted for this purpose (prevents reset-link poisoning). API: `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password` (both public, rate-limited).
- After successful login: redirect to dashboard

### Invitations (`/join`) (v1.75.0)

Admins invite new members with a link instead of setting a password for them and passing it on. The invited person picks their own password, so no admin ever knows it.

- **Creating (Settings → Administration → Family and roles → Invitations):** username and display name are optional; leaving them empty lets the invited person choose. Family role, the system-admin flag and an optional email address are set here. `POST /api/v1/auth/invites` returns the plaintext token exactly once — only its SHA-256 hash is stored, so a lost link cannot be recovered, only revoked and reissued. The admin UI builds `${location.origin}/join?token=…` client-side and shows it once with a copy button; the request `Host` header is fine here because a signed-in admin creates and forwards the link, with no third party in between.
- **Sending by mail (optional):** with "send the invitation by email" the server mails the link itself and therefore uses `BASE_URL`, never the request host — the same rule as the password reset. The response field `email_sent` reports honestly whether delivery worked, so the UI never claims a mail that was not sent; without SMTP or `BASE_URL` the admin simply forwards the link by hand.
- **Accepting (`/join`):** the public page reads the token from the query string, checks it via `GET /api/v1/auth/invites/preview`, and pre-fills whatever the invitation dictates as read-only fields. `POST /api/v1/auth/invites/accept` creates the user; **role and family role always come from the invitation, never from the request body**, so an invited member cannot promote themselves to admin. The invited email becomes the new member's contact address, which is what makes the later password reset reachable. No session is established (like `/setup`); the page redirects to `/login`.
- **Lifecycle:** invitations are valid for 7 days (fixed, no env var). Redeeming marks the row instead of deleting it, which keeps the "who invited whom" trail and drives the admin UI state. Revoking marks it too and kills the link immediately. The hourly cleanup only removes invitations that expired without ever being accepted or revoked. Redemption marks the invitation inside the same transaction that creates the user, so two parallel redemptions of one token produce exactly one account.
- Both public routes (`preview`, `accept`) carry no CSRF, exactly like `/forgot-password` and `/reset-password`: the token is the secret. Both are rate-limited.
- **Direct creation stays:** `POST /api/v1/auth/users` is unchanged and remains the right way for a child with no mail address and no device of their own.

### Settings (`/settings`)

User management and app configuration. Logged-in users only.

- **Profile (Settings → Personal → Account):** one **Profile** card holds picture, display name, avatar colour and the account's own username (read-only — it cannot be changed), with phone, email and birthday grouped below it as **Contact details**; a sibling card changes the password
- **User management (admin):** create new users, edit/delete existing users, assign roles (admin/member). Since v1.75.0 an **Invitations** panel sits below the member list: it creates invite links, shows the pending ones with their expiry date, and revokes them (see "Invitations" below)
- **Roles and permissions (admin, Settings → Administration → Roles and permissions, #467):** granular, backend-enforced access control per **family role** (the default) and per **member** (an override that wins over the role). Each module is set to `No access`, `Read only`, or `Full`, and each dashboard widget to `Available` or `Blocked`; widgets inherit their module's lock and can also be blocked on their own (e.g. hiding the cycle widget for some members without disabling Health). Configuration is **sparse** — only deviations from the default (full access) are stored, so unset roles/members keep full access and existing installs are unchanged. **Admins always bypass** the system (no self-lockout). Enforcement is **server-side** — the same scope layer that guards API tokens returns 403 on a disallowed module/method; the client mirrors it by hiding blocked modules from navigation and the dashboard, and a **read-only module** hides its create affordance (the FAB) and shows an explanatory banner. Stored in `access_permissions`. The settings page shows a role/member switch, a deviation overview, and per-module/-widget access as icon controls with widgets nested under their module. API: `GET /api/v1/permissions/catalog`, `GET/PUT /api/v1/permissions/role/:familyRole`, `GET/PUT /api/v1/permissions/user/:userId` (admin-only); the resolved permission map also ships on `GET /api/v1/auth/me`.
- **Navigation and module controls (Settings → Personal → Navigation):** module order and the three mobile slots are stored per user and open to every member; the module on/off switches are admin-only and are not rendered for members. individual modules (Tasks, Calendar, Shopping, Meals, Recipes, Birthdays, Notes, Contacts, Budget, Documents, Housekeeping) can be disabled to hide them from navigation. Data is preserved and reappears when re-enabled. Dashboard and Settings remain essential and cannot be disabled. Stored as `disabled_modules` in `sync_config`. **Kitchen grouping:** Meals, Recipes, Shopping, and Pantry are presented as one global **Kitchen** destination with four individually toggleable children; local pages keep their individual routes. The group shares one accent (`--module-kitchen`), one page-head component (`.page-toolbar--in-group`), one empty-state renderer, one failure-state renderer (`mountLoadError()`, v1.60.0), one row grammar (`.kitchen-row`, v1.58.0), one bulk-action bar (`.kitchen-bulkbar`, v1.59.0) and one transfer path into the shopping list (`kitchen-transfer.js`, v1.62.0 — see Components), so a tab switch changes the content but not the grammar. Recipes, Shopping and Pantry cap their body at the narrow reading column (`.kitchen-list`, 720px) and their page head follows it via `.page-toolbar--narrow` (v1.65.0), so head controls end where the list ends instead of drifting to the outer edge; Meals is a week board and keeps the full content column. **The tab bar carries the state of the cycle (v1.59.0):** each tab shows what is waiting in that station — open shopping items, pantry items that are expired, empty or running low. Until then the cycle was told only in the four empty states and disappeared with the first record. One request serves both numbers (`GET /api/v1/kitchen/summary?today=YYYY-MM-DD`); `today` comes from the client because "expired" depends on the user's local calendar day while the server computes in UTC. **Meals and Recipes carry no badge (v1.65.0):** a badge says "something is waiting there". A recipe collection has no open state, and the Meals badge counted the opposite of waiting — free slots, i.e. visible meal types × 7 days minus the filled ones. An empty week therefore showed the loudest number in the bar (28 with all four meal types) for the state "nothing planned", and it counted days that had already passed and could no longer be planned. The empty slots on the page itself tell it better. The **active** tab deliberately carries no badge: the page itself shows that state in more detail (list counters, filter chips, empty slots), and a number there would have to be re-fetched after every local mutation. Inactive tabs can only change through one of the four transfers, and those refresh the bar themselves. The web navigation is grouped into Overview, Plan, Home, and Custom modules, and `module_order:user:<id>` only changes order inside each group; Dashboard and Settings stay pinned. The Custom modules group is shown only when enabled third-party modules are loaded. The mobile bottom bar has five stable slots — Overview, three configurable favorites, and More. Favorites default to Calendar, Tasks, and Kitchen, are stored per user as `mobile_nav_order:user:<id>`, and automatically fall back to enabled destinations when a selected module becomes unavailable.
- **Housekeeping (admin):** toggle for automatic payment task creation on work session check-in.
- **Synchronization (Settings → Sync):** organized by data type into five dedicated pages — Calendar, Contacts, Reminders, Document storage, and Document management (DMS) — each opening with a status summary before any setup forms:
  - **Calendar sync (`/settings/sync/calendar`):** CalDAV accounts and Webcal/ICS subscriptions are primary. Manage multiple CalDAV accounts (iCloud, Nextcloud, Radicale, Baikal) with per-account calendar selection via checkboxes, two-way sync, and a unified per-event sync-target picker; manage ICS URL subscriptions (add, delete, sync now, set color and visibility); configure sync interval. Google Calendar (OAuth 2.0, multi-calendar selection, read-only mode) and Apple/iCloud CalDAV live inside an accessible **"More providers"** disclosure that always shows current connection state; Apple carries a **legacy** badge directing new iCloud users to the generic CalDAV setup. OAuth callbacks (`sync_ok` / `sync_error`) render a localized banner, expand the matching provider disclosure, and are then stripped from the URL.
  - **Contact sync (`/settings/sync/contacts`):** manage multiple CardDAV accounts (iCloud, Nextcloud, Radicale, Baikal) — add, **edit** (credentials, URL, name; empty password keeps the stored one) and disconnect; per-addressbook enable/disable plus "enable all / disable all"; automatic sync on the `SYNC_INTERVAL_MINUTES` schedule plus a manual trigger. Each account card is one bordered object carrying its own actions, so "Disconnect" is unambiguously attributable. **Sync failures are visible in the app, not only in the server log** (v1.34.0): a partial failure outranks success in the status line, and the message sits on the address-book row that caused it, with the list auto-expanded. A configuration gap ("no address book enabled") stays neutral and disables the sync action instead of reporting success for a non-event; a real server error is shown in the danger tone. The disconnect confirmation names the account

  - **Reminder sync (`/settings/sync/reminders`):** reuses the CalDAV accounts but exposes only reminder/task collections — per-list enablement, refresh and target mapping to Tasks or Shopping; calendar collections do not appear here, and since v1.75.7 (#617) the reverse holds too: a pure task list no longer shows up in the calendar selection. The page looks for lists itself when it is first opened, so a freshly added account no longer greets you with an empty state; the empty state now means the server really offers none. Enabled lists sync in **both directions** (v1.68.0 · #617): completing, editing or deleting a mirrored task or shopping item reaches the server too, and a VTODO's categories arrive as tags (#586)
- **Weather:** Settings → Administration → Household weather configures the household default Open-Meteo location (latitude/longitude, optional city label, units; no API key) — admin only; saving activates Open-Meteo and supersedes any OpenWeatherMap `.env` configuration. A **"Detect location"** button uses the browser's Geolocation API to auto-fill latitude and longitude (no reverse-geocoding — the optional city field stays whatever was last typed, or the widget falls back to showing raw coordinates). **Automatic location updates:** an opt-in checkbox re-requests the browser's location every 30 minutes while the dashboard is open, silently updating the saved coordinates (and clearing any stale city label) so a moved device's weather stays current without a manual re-detect; skipped silently on permission denial or once the dashboard is closed. **Per-user override (Settings → Personal → My Weather, all users):** any user — not just admins — can set their own latitude/longitude/city/units and their own automatic-location-updates toggle; this personal location is stored separately from the household default and only affects that user's own dashboard widget. A status indicator shows whether a personal location or the household default is currently active, and a **"Use household default"** action clears the override. When a user has no personal override, the household admin's location is used as before.
- **Language:** System (follows `navigator.language`) plus the 24 locales listed under [Supported Languages](#supported-languages) - picked in Settings › Appearance; switch without page reload. A second, separate selector below it sets the household **data language** (see Data language, below) — display and storage are deliberately two decisions
- **API Tokens (admin):** create named Bearer / X-API-Key tokens for external integrations; the full token value is shown only once immediately after creation; tokens can be revoked at any time; support optional expiry and track last-used timestamp; **optional per-module scopes** (`<module>:read`/`<module>:write`, write implies read) restrict a token — e.g. an MCP token that may write the calendar but never read health data — while an unscoped token keeps full role-based access
- **Documents (admin):** one Document storage page shows the selected and effective upload destinations before provider details. A local-folder environment override can therefore be distinguished from the saved selector. The unchanged WebDAV form retains per-field environment overrides, SSRF controls, protected connection changes and PUT/GET/DELETE testing. A sibling Google Drive disclosure shows configured/connected state, account, `Yuvomi/Documents` folder, Drive document count, last test/error, Connect/Reconnect/Test/Disconnect controls, callback banners and the Drive-owner/shared-folder privacy boundary. OAuth success never changes the selector.
- **Backup Management (admin):** download the current database as a file (`GET /api/v1/backup/database`) or restore from a backup file (`POST /api/v1/backup/restore`, drag-and-drop supported). Validates that the uploaded file is a valid Yuvomi database. A rollback copy is created automatically before restore. **Automatic scheduled backups:** configurable via `.env` (`BACKUP_ENABLED`, `BACKUP_SCHEDULE`, `BACKUP_DIR`, `BACKUP_KEEP`); default 2 AM daily, keeps last 7 copies; Settings → Administration → Backup and restore shows scheduler status, schedule, retention policy, last backup timestamp, and a manual trigger button. The schedule is shown **in plain language** ("Daily at 02:00", "Every Monday at 03:30") with the raw cron expression kept alongside as evidence; expressions outside the common daily/weekly/monthly/every-N-hours patterns (lists, ranges, month fields) stay in their raw form rather than being summarised inaccurately (`public/settings/cron-label.js`). **WebDAV backup target:** optional upload of each backup to a WebDAV server (Nextcloud, ownCloud, Hetzner Storage Box, etc.) after each local backup; configurable via Settings → Administration → Backup and restore or env vars (`WEBDAV_BACKUP_ENABLED`, `WEBDAV_BACKUP_URL`, `WEBDAV_BACKUP_USERNAME`, `WEBDAV_BACKUP_PASSWORD`, `WEBDAV_BACKUP_PATH`, `WEBDAV_BACKUP_KEEP`); uses Node 22 native fetch, no extra dependencies; password is masked in the UI and API; upload failures are non-fatal (local backup is always retained).
- **Backup boundary:** SQLite/database backups include external document metadata and storage keys or Drive IDs, but never local-folder, WebDAV, or Google Drive binaries. The selected external target must be backed up separately and restored with the matching database.
- **Email / SMTP (admin, v0.71.51):** Settings → Administration → Email configures an outgoing SMTP server (host, port, `ssl`/`starttls`/`none`, user, password, from-address, from-name) that powers the self-service "Forgot password" flow. Each field follows the same per-field hybrid pattern as other integrations: a non-empty `EMAIL_SMTP_*` / `EMAIL_FROM_*` env var overrides its matching `sync_config` field and the field becomes read-only in the UI. The password is write-only — `GET /api/v1/email/config` never returns it, only a `passwordSet` boolean. A **"Test connection"** button (`POST /api/v1/email/test`, admin-only) verifies the SMTP connection and sends a probe email to the requesting admin's own linked address (or an explicit override). API: `GET/PUT /api/v1/email/config`, `POST /api/v1/email/test`.
- **Information architecture:** Settings is organized into four role-aware domains with 23 leaf pages, addressed by stable routes under `/settings/<domain>/<page>`:
  - **Personal** (all users, 7): Account, Appearance, This device, Notifications, Event defaults, My Weather, Navigation
  - **Modules** (admin, 4): Kitchen, Calendar, Module options, Rewards
  - **Sync** (admin, 5): Calendar sync, Contact sync, Reminder sync, Document storage, Document management (DMS)
  - **Administration** (admin, 7): Family and roles, Roles and permissions, Household weather, API access, Backup and restore, Email (SMTP), System

  A central registry (`public/settings/registry.js`) is the single source of truth for domains, routes, roles, labels, icons, and legacy-tab mappings; each leaf is **lazy-loaded** and owns only its own API domain. Members see only Personal; deep links to admin pages redirect to Personal → Account with a localized notice. Preferences are read once per settings visit through a shared cache (`public/settings/preferences-cache.js`) rather than by each leaf separately.

  **One navigation per mode:** the shared shell (`public/settings/shell.js`) renders the **tile overview** on the settings root (each tile carrying its page description) and the **sticky local navigation column** only inside a leaf (≥ 1024px, with `aria-current="page"` and a focus-managed page heading). Below 1024px it is a **history-aware drill-down** (settings overview → domain overview → leaf, with breadcrumbs and Back traversal); tablet overview pages use two columns from 768–1023px. `/settings` without a stored destination renders the overview instead of redirecting to a page, and the in-leaf Back link names its target ("Back to Administration") rather than the root. Each leaf catches its own load/save errors with inline retry without dropping sibling sections. Legacy `yuvomi:settings:tab` values migrate once to the new paths; the former flat tab bar and `settings-nav.js`/`settings-nav.css` are removed.

  **Finding a page without knowing its domain:** the navigation carries a search field that filters all leaves the current user may see by label, description and domain name, ignoring case and diacritics. While searching, the domain groups give way to a flat result list in which every hit names its own domain; the hit count is announced in a live region and an empty search falls back to the shared "no results" state.

  **Switching leaves:** the container is marked `aria-busy` immediately and shows a skeleton after 120 ms, so a page that loads from the module cache does not flash one. Half-filled forms are no longer discarded silently: a guard on the leaf container (`public/settings/dirty-guard.js`) remembers forms the user actually typed in — and only those with their own submit button, since the many instantly-saving switches never hold an open state — and asks before any navigation out of the leaf; `beforeunload` covers reload and closing the tab.

  Two earlier domains are gone: **Documents** held two admin pages that both connect an external service and now live under Sync, and the former **Modules → Navigation** page moved to Personal because module order and the three mobile slots are stored per user (which modules the household uses stays an admin decision, gated inside the page). Budget, Health and Housekeeping carried one checkbox each and were merged into **Module options**.
- **Region / Format presets (Settings → Personal → Appearance):** a household-wide **Region** selector (admin-only) sets currency, **number**, date and time format together from one BCP-47 region (e.g. Switzerland → `1'234.50`). Number and currency grouping follow the selected region independently of the UI language (v1.29.0) — a German-language household can still display Swiss-formatted amounts — resolved via a `getFormatLocale()` that reads the stored region and falls back to the UI language; choosing **Custom** configures each format individually. Non-admin members see a read-only notice. Budget CSV export uses a dot decimal without grouping so a comma-decimal locale never collides with the comma field delimiter.

  **64 regions (v1.78.0).** `public/settings/region-presets.js` covers Europe, Asia, Oceania and — since v1.78.0 — every sovereign state of the Americas including the Caribbean, plus the Philippines (`en-PH`, `fil-PH`). Each preset's date and time format is taken from the locale's CLDR default rather than estimated, which is why Panama sits on `mdy` and Argentina on `12h`. Dependent territories (Aruba, Curaçao, Cayman, Bermuda) are deliberately absent; those households pick **Custom**. Six states share the East Caribbean dollar and therefore one identical triple — `detectRegion()` can only name a representative for them, while the stored `region` field keeps the selector on the chosen island (#486). The selector sorts by displayed name, not by the order in the preset object. The BCP-47 shape check accepts two- **and** three-letter language subtags (`{2,3}`), since `fil-PH` would otherwise be rejected by the region validator, the household-language resolution and the money formatter alike; a guard in `test:region-presets` reads those regexes out of the source instead of duplicating them.

  **Amount inputs** follow the same region *and* the currency of the value they hold, via `public/utils/money.js` — the single source for money formats. The placeholder is the zero rendered by `Intl` (`0,00` under `de`, `0.00` under `de-CH`, `0` for a zero-decimal currency), and step and lower bound follow the currency's minor unit: EUR steps in cents, JPY, KRW, HUF, IDR, IRR and CLP in whole units. Where the currency is picked in the same form (subscription, shared expense, loan) the field follows that choice. Precision is enforced on save, not just displayed: the budget dialogs are not `<form>` elements and the shared-expense fields are text inputs, so no native check applies. A stored value that predates the currency's grid stays savable as long as it is not touched, so an unrelated edit to a title is never blocked. On input, digits and the decimal separator of the active numbering system are rewritten to ASCII (`۱۲٫۵۰` → `12.50`); a thousands separator is refused rather than interpreted, since `1.000` reads as one thousand in `de-DE` and as one as a decimal — recognized by pattern, so `12.50` still counts as twelve-fifty.

- **Data language (Settings → Personal → Appearance → Language, admin-only, #631, #632):** the language Yuvomi uses when it **stores** content it generates itself — today the titles and descriptions of birthday calendar events. Distinct from the UI language above, which is per user in `localStorage`: a stored row has exactly one wording no matter who reads it later, and that wording is what the REST API, the ICS export feed, the CalDAV/Google outbound sync and the FTS index return. Resolution order: the explicitly chosen `sync_config.language`, else the language part of `region` (`de-DE` → `de`), else English. The middle step is why most households never touch the setting; the last one keeps a household without a region on its previous behaviour instead of silently rewriting its titles on update. `GET /api/v1/preferences` returns three views of it — `language` (what is chosen, `null` for automatic), `language_effective` (what applies) and `language_auto` (what automatic mode alone would yield, which is what the "Automatic (…)" option is labelled with). Changing the language, the region or the date format re-titles the household's existing birthday events inside the same request, so external calendars do not keep the old wording. Server-side translation lives in `server/utils/i18n.js`, which reads `public/locales/*.json` as data rather than importing across the layer boundary.

  **One currency list, four places (v1.61.0).** 54 selectable ISO 4217 codes as of v1.78.0, which added every currency in use across the Americas (ARS, BBD, BOB, BSD, BZD, COP, CRC, CUP, DOP, GTQ, GYD, HNL, HTG, JMD, MXN, NIO, PAB, PEN, PYG, SRD, TTD, UYU, VES, XCD) and the Philippine peso (PHP). The set is declared in `public/settings/currency.js` and has to hold identically in the household preference (`server/routes/preferences.js`), the Subscriptions tab (`public/pages/subscriptions.js`) and Split Expenses (`server/routes/split-expenses.js`) — the two module lists are validated server-side, so a code missing there is not a cosmetic gap but a rejected write. They had silently drifted apart: KRW, IDR and IRR were selectable as the household currency while Subscriptions did not offer them and Split Expenses refused them, stranding those households in two modules. A guard in `test:settings-navigation` now compares all four against the same source.
- **Family management (admin):** assign a `family_role` (Dad, Mom, Parent, Child, Grandparent, Relative, Other) to each user, and set per-member phone, email, and birthday — automatically synced to Contacts and Birthdays. Displayed in the family member list and profile views. The Edit member dialog has an optional "Reset password" field (min. 8 characters, left blank keeps the current password) so an admin can set a new password for a family member who forgot theirs or never got it working — no SMTP/`BASE_URL` setup required, unlike the self-service "Forgot password" flow. On change, all of that member's other sessions are invalidated. `PATCH /api/v1/auth/users/:id` (admin-only) accepts an optional `password` field.
- **Profile picture:** users can upload a personal avatar (PNG/JPEG/WebP, ≤ 5 MB), stored as a Base64 JPEG data URL in `avatar_data` at 256 × 256 px. After selecting a file a **canvas crop dialog** opens: the user can drag the image and zoom (slider or mouse wheel) to choose the square crop region before confirming. Shown in all avatar circles throughout the app — task cards, calendar agenda, user assignment picker, dashboard task widget, dashboard calendar widget, and notes creator badge — with coloured initials as fallback when no photo is set. Housekeeping staff avatars use the same crop dialog.
- **App info:** version, license
- **In-app changelog (v1.3.0):** a Help-adjacent "Changelog" action (available to every logged-in user) opens a modal with the release history. The browser calls Yuvomi's own backend (`GET /api/v1/changelog`), which fetches the GitHub Releases of `ulsklyc/yuvomi` on demand, reduces each release body to plain text, and caches the result in memory for 30 minutes (no scheduler, no polling). The modal shows the installed version alongside the latest available release and highlights the installed version when it appears in the list; if GitHub is unreachable it degrades to a cached/error state (air-gapped installs simply see "could not be loaded"). Rendered entirely via DOM text nodes — no external content is injected as HTML. **Update hint (v1.84.0 · #490):** when the latest release is newer than the installed version, a dot marks the "Changelog" entry in the sidebar and, on mobile, the "More" button that hides it in its sheet; the accessible name of both says which version is available (the dot itself is `aria-hidden`). Opening the modal marks that version as seen and clears the dot until a newer one appears; the modal then leads with "Version X is available" instead of the installed-version note. The comparison is numeric per segment (a string compare would rank 1.9.0 above 1.10.0) and ranks a prerelease below its final release; anything unparseable counts as unknown and never raises the hint. The client asks at most every 6 hours and stores the last known release, so the dot survives a reload without a request; a failed check stays silent and leaves the previous state standing.

### Budget (`/budget`)

**Tabs:** Budget, Accounts, Plan, Statistics, Subscriptions, Loans, Split Expenses.

**Views:**
- Monthly overview: income vs. expenses, balance, bar chart by category (Canvas, no library)
- Transaction list: chronological, filterable
- **Tab capabilities (v1.37.0):** each Budget tab declares whether the month is its frame of reference and whether it has a "new" action. Month navigation (arrows, month label, "current month") therefore appears as a whole or not at all — it shows on the Budget, Plan and Statistics tabs and is absent on Accounts, Subscriptions, Loans and Split Expenses. The floating action button follows the same table: it creates the item that belongs to the active tab (entry, account, budget, subscription, loan, shared expense) and is hidden on Statistics, which has no create action.
- **New entries follow the displayed month (v1.37.0):** the date field of a new entry defaults to today only while the current month is on screen; after paging back it defaults to the first of the month being viewed, so an entry created while looking at March is not silently filed under today.
- **One set of building blocks across the seven tabs (v1.63.0):** the tabs shared the toolbar, the tab bar, the FAB and the module accent, but from the panel edge inward they had diverged into five metric-card variants, five row namespaces, four panel-header class names, three container patterns, three panel paddings and three scroll axes. They now share `.budget-summary-card` (one card, left-aligned, with `__note` for footnotes and `__progress` for the subscription budget bar, which recolours past 100% instead of sitting silently at full width), `.budget-tab-panel` (padding and scroll axis; the Budget tab's own inner scroll region is a named modifier, as is `.budget-panel--reading` for the form-like Plan tab) and `.budget-panel-head` with `.budget-panel-head__title`, which joins the shared eyebrow list in `typography.css` instead of being a sixth heading treatment. Net worth and the loan statistics are ordinary metric cards, and the Loans tab no longer frames itself as a card containing cards. Subscriptions and Split Expenses drop their own page gradient and padding while embedded, so the work surface no longer changes tint at a tab switch. Guards in `test:budget-ui` are written as rules over every file of the module rather than as allow-lists of selectors.
- **One time axis for the module (v1.64.0):** the header slot is never emptied, only rewritten. Tabs without a time frame (Accounts, Subscriptions, Loans, Split Expenses) show a quiet context line in place of the stepper ("Current balances", "All active subscriptions", "All loans", "All groups") instead of leaving a gap that read as "the month I picked still applies". The Statistics tab no longer builds a second period picker of its own: it uses the shared header stepper, and its Week/Month/Year switcher now only picks the resolution the stepper moves in. Both ends are reconciled on a tab switch in either direction, so a March picked on the Budget tab no longer reappears as July under Statistics, and a week stepped into August carries that month back. Month and year are formatted exactly as on the Budget tab (`July 2026`, `2026`); week bounds come from the server, so the week logic exists once. `TAB_CAPS` remains the single source and gained two fields for this (`note`, `range`).
- **One switcher, one behaviour layer (v1.64.0):** the module had four looks for the same question — a tinted capsule, a square accent-filled rectangle inside a rounded container, a white tile and an outlined pill — and two of those bars carried `role="group"`, so the arrow-key navigation learned on Budget and Statistics was silently lost on Loans and Split Expenses. All of them now use `.budget-segmented`, extracted from the Statistics switcher, at the shared touch size (`--target-base`). `wireTablist` gained a `mode`: `tabs` switches a view (`role="tablist"`, `aria-selected`), `select` picks one value from a filter bar (`role="radiogroup"`, `aria-checked`). Loan status, group status and the account colour picker all run through it, so the colour picker gained arrow-key navigation as a side effect. The guard for this is written as a rule over the whole module — no `role="group"` whose children report a selection state, and every `tablist`/`radiogroup` bar found in the markup must be wired to `wireTablist` — replacing an allow-list of three selectors that had not seen the two offending bars.
- **Contrast never depends on the data (v1.64.0):** subscription monograms drew text and surface from the *same* brand colour (a solid tone on a lightened version of itself), so the ratio was purely a matter of which brands a household happens to track: ten WCAG AA failures across seven seeded brands, down to 1.83:1, with no way for a user to fix it other than changing the brand colour. The brand now carries the surface and the border while the label comes from the text token (measured 12.9:1 light, 10.7:1 dark). The same mechanism sat unnoticed in the account tile (`--account-accent` as both icon and fill) and was fixed with it. The rule is guarded: a data colour — one fed in from JS via `style="--x:…"`, as opposed to a token from `tokens.css` — may not supply both foreground and background of the same surface.
- **One money vocabulary (v1.63.0):** `public/utils/money.js` replaces the three separate currency formatters in `budget.js`, `subscriptions.js` and `split-expenses.js`. Every amount carries one of four roles, and the role decides sign and colour together: `flow` (a single account movement — always signed, coloured by sign), `total` (a sum whose direction is already in its label — unsigned), `balance` (signed only when negative) and `plain` (an invoice amount with no account direction: subscription price, shared expense). The sign comes from `Intl`'s `signDisplay`, not a prepended `+`, so it stays on the correct side in RTL locales. Previously the same tab could show `−134.20 €` on a row and `3,046.11 €` unsigned on the summary card above it; that `Math.abs` was a silent exception and is now the `total` role applying to both cards. A net worth of exactly 0 is no longer green, because `balance` resolves zero as neutral. A shared expense deliberately stays unsigned — it is a group invoice line, not a movement on the viewer's account — but that is now a named role rather than an accident.

- CRUD: title, amount, category, subcategory, date
- Categories: DB-backed; 9 predefined expense categories (English slug keys, including the `subscriptions` category the Subscriptions tab mirrors into), 5 income categories; users can add custom categories inline from the entry modal
- Subcategories: 40 predefined subcategories across expense categories; users can add custom subcategories inline; displayed alongside category in each entry's metadata line
- Recurring entries
- **Personal vs. shared budgets (#476/#505):** an admin can switch the household into *personal budget mode* (Settings → Modules → Module options). Each entry, loan and subscription then carries an owner (the creator) and a visibility (`private`/`shared`); the entry modal gains a "Share with the household" toggle (default private), shared rows show a "Household" badge, and a **My budget / Household** view switcher appears in the toolbar. Enforcement is server-side on every read path with no admin bypass; see the [Budget Entries](#budget-entries) data model for the full rule. In the default shared mode nothing changes.
- **Receipts (#583):** the entry modal (under "More options") can attach documents to a transaction — pick one already filed under Documents or upload a new file, several per entry. Attached entries carry a paperclip in the transaction list, and a receipt's name opens its preview. Uploads only leave the browser when the entry is saved, and they are filed under Documents in a *Receipts* folder, so an abandoned form leaves nothing behind. The same field serves shared expenses and settle-up proofs; see [Budget Entries](#budget-entries) for the visibility rules
- Monthly comparison (current vs. previous month)
- CSV export includes a subcategory column and English column headers; the same endpoint accepts an arbitrary date range via `?from=YYYY-MM-DD&to=YYYY-MM-DD` (used by the Statistics tab's export button) in addition to the legacy `?month=YYYY-MM`
- **Category bar chart accessibility:** the chart exposes a concise `.sr-only` summary (number of categories, largest category and its share) for assistive technologies (v0.55.0)
- **Statistics tab:** range view (week, month, year) stepped through the shared Budget header, summary cards for income/expense/balance plus comparison against the previous period, an SVG trend chart of income vs. expenses, category bars, an expense-share donut, and a CSV-export button for the active range. Backed by `GET /api/v1/budget/stats?range=week|month|year&anchor=YYYY-MM-DD`.
- **Statistics accessibility & readability (v1.37.0):** the resolution switcher is a proper WAI-ARIA tablist (arrow keys, roving tabindex). The trend chart labels its scale maximum and the period bounds, and exposes every data point as a focusable hotspot whose accessible name carries the values ("16 Jul 2026: income …, expenses …") — reachable by keyboard, not hover-only, with a single tab stop and arrow-key navigation across the curve, plus a visible readout line. Trend chart and donut each carry an `.sr-only` summary (totals, peak; segment count, largest slice and its share) and the SVGs themselves are decorative. The donut draws at most seven slices from a dedicated data-series palette (`--chart-series-1…7`, ≥3:1 against the page background in both themes) and aggregates any remainder into an "Other" slice, so no two slices ever share a colour.
- **Plan tab:** planned/estimated budget (Discussion #468). A monthly savings-goal card (progress ring, planned vs. net balance, on-track/reached/negative status) plus per-category budgets shown as planned-vs-actual progress bars (under/near/over-budget tone, each backed by a text label so meaning never depends on colour alone). Set/edit/delete via modal; deleting a budget or savings goal is undo-based (5-second "Undo" toast) rather than confirmation-gated, matching entries, loans and instalments — within the Budget module a confirmation dialog is reserved for deletions that cascade, such as accounts (v1.37.0). Month-bound via the shared Budget month navigation. Backed by `GET /api/v1/budget/plans?month=YYYY-MM` and `PUT`/`DELETE /api/v1/budget/plans/:category`. Implications elsewhere: the Statistics tab draws a category target marker at the planned amount (month range only), and the dashboard Budget widget shows savings-goal progress when a goal is set.
- **Accounts tab:** separate accounts (checking, savings, cash, credit card, investment, other), each with a starting balance and an optional accent color. The tab lists every account with its running current balance (starting balance + assigned entries up to today) and the household net worth. **Drill-down:** clicking an account row switches to the Budget tab filtered to that account (a chip clears the filter); a separate pencil icon opens the edit modal. **Archiving:** accounts can be archived from the edit modal — archived accounts are hidden by default (a "show archived" toggle reveals them with a badge) and excluded from net worth, without deleting their history. Entries optionally reference an account from the entry modal, and each transaction shows its account in the metadata line. Deleting an account keeps its entries (their `account_id` is cleared). Backed by `GET/POST /api/v1/budget/accounts` (`?include_archived=1`) and `PUT`/`DELETE /api/v1/budget/accounts/:id`; entries accept an optional `account_id`, and `GET /api/v1/budget?account_id=` filters by account.
- **Loans tab:** create instalment-based loans (borrower, total amount, number of instalments, start month); record individual payments; remaining balance and due months shown automatically; paid-off loans marked as closed; filter budget transactions by loan. **Interest loans (#569):** a loan can instead be entered as a German-style annuity (principal, nominal interest rate, initial repayment rate) rather than a fixed total — the constant monthly payment, term and total interest are derived server-side and shown as a live preview while typing; the loan card then displays the annuity rate and the interest phase. A `fixed_then_variable` mode continues after the fixed-interest period with a forecast follow-up rate (a longer follow-up rate lengthens the term), and a `variable` mode covers loans without any fixed-interest period (same maths as a fixed rate, but the rate field is labelled as the current rate and a hint states that payment and term move with it, so the card reads "3.6 % variable" instead of claiming a commitment, v1.45.12). The server is the single source of the interest maths (no client-side formula); the recorded instalment follows the annuity rate, not the term average. **Own currency (#582):** the loan dialog offers a currency and, as soon as it differs from the budget currency, a fixed conversion rate; the hint spells out the direction (1 loan currency = x budget currency), and switching the currency clears the rate so the previous one is never carried over unnoticed. Loan cards, the loan report and the instalment transactions lead with the loan's own currency and show the budget equivalent quietly underneath; the summary card stays in the budget currency and says that foreign-currency loans were converted at their fixed rate. **Outstanding balance (v1.48.0):** an interest loan leads with its outstanding principal, labelled as such and set against the loan amount, instead of the sum of the outstanding instalments, which includes the interest of the remaining term and was read as the figure the bank reports. The loan report lists both (loan amount, outstanding balance, still to pay, paid, instalments left), and the summary card switches its label to *Outstanding balance* as soon as one interest loan is present. Interest-free loans are unchanged, as both figures are identical there.
- **Subscriptions tab:** recurring service CRUD with daily/weekly/monthly/yearly cycles and exact next-renewal calculation. Every active subscription creates a linked expense on the Budget tab for its next payment; edits synchronize it, disabling removes it from calculations, and renewal preserves the paid expense while creating the next one. Includes custom sortable categories and payment methods, searchable in-modal currency/category/payment controls, uploaded logos plus redirect-aware SSRF-protected public HTTPS logo discovery from site icons and public metadata, configurable reminder timing, filtering, sorting, and responsive analytics. Each filter control carries a visible label; a "Reset filters" button appears only while a filter or search is active, and a filtered-to-empty list shows a distinct "No matches" state with a reset action instead of the "no subscriptions yet" empty state (v1.37.0).
- **Subscription finances:** native billing currencies, configurable base currency and monthly budget, 12-hour exchange-rate cache with optional Fixer refresh, monthly normalization and yearly projection, remaining/over-budget status, and category/payment-method charts.
- **Subscription reminders:** upcoming payments appear in the existing in-app reminder center according to each subscription's reminder timing.
- **Platform inheritance:** Subscriptions uses the application's existing household multi-user authorization, OIDC/OAuth login, SQLCipher option, backup/restore, responsive PWA shell, offline shell caching, themes, and 24-locale i18n system rather than duplicating those controls inside the tab.
- **Split Expenses tab:** shared expense tracking within named groups (household, couple, travel, event, shopping, general). Split methods: equal, exact amounts, percentage, shares. **Split defaults (#517):** each group stores a default split method and, for percentage/shares, per-member default values; new expenses in the group open pre-filled with them (editable in the group dialog once it has at least two members) so recurring same-split expenses need no re-entry. Balances derived from an immutable double-entry ledger — amounts stored as integer minor currency units (cents) to avoid floating-point errors. **Settlements:** record payments between members; a debt-simplification algorithm produces the minimal transfer set. **Recurring expenses:** daily, weekly, monthly, yearly schedule with automatic generation via hourly scheduler. **Guest accounts:** invite people outside the family as restricted users who can only access the Split module and see their invited groups. The restriction belongs to the account, not to its group membership: deleting the group leaves the guest confined and showing nothing rather than releasing it into the rest of the household, and adding a guest to a further group does not widen what it sees. A guest left without a group keeps its login and stays visible under Settings → Administration → Family, where it can be deleted. **Multi-currency:** each group has a default currency; individual expenses can use any currency with historical exchange rate snapshots. **Activity feed:** per-group log of all expense, member, and settlement events. **Receipts (#583):** an expense takes documents from the Documents module as receipts (link an existing one or upload a new file), and a settle-up records exactly one payment proof — the data model holds a single `proof_document_id` there, so the field accepts one document rather than silently dropping a second. Expenses with a receipt carry a paperclip in the list. The backend already had the columns; until now nothing in the UI filled them, and the read path handed out receipt names without checking the document's visibility. **Archive (#574):** the group list has an Active/Archived filter. An archived group stays fully readable — balances, expenses and activity feed — but every writing action is replaced by **Restore**, which returns it to the active list without a confirmation prompt (the step is lossless and reversible by archiving again). Restoring is limited to group owners/admins, like archiving.
- API: `GET /api/v1/budget/categories`, `GET /api/v1/budget/categories/:key/subcategories` (optional `?lang=` localisation), `POST /api/v1/budget/categories`, `POST /api/v1/budget/categories/:key/subcategories`, `GET /api/v1/budget/stats?range=week|month|year&anchor=YYYY-MM-DD` (totals, comparison vs. previous period, per-period series, per-category breakdown), `GET /api/v1/budget/export?from=YYYY-MM-DD&to=YYYY-MM-DD` (range CSV; legacy `?month=YYYY-MM` still supported), `GET /api/v1/budget/plans?month=YYYY-MM` (planned vs. actual per category + savings goal), `PUT`/`DELETE /api/v1/budget/plans/:category`
- Loans API: `GET /api/v1/budget/loans`, `POST /api/v1/budget/loans`, `POST /api/v1/budget/loans/preview` (live interest calculation — monthly payment, term, total interest, remaining balance after the fixed period; no persistence), `GET /api/v1/budget/loans/:id`, `PUT /api/v1/budget/loans/:id`, `DELETE /api/v1/budget/loans/:id`, `GET /api/v1/budget/loans/:id/payments`, `POST /api/v1/budget/loans/:id/payments`, `DELETE /api/v1/budget/loans/:id/payments/:paymentId`
- Subscriptions API: `/api/v1/budget/subscriptions` CRUD and analytics, plus `/meta`, `/settings`, and `/logo-search` for selectable logo candidates from a website URL or service name.
- Split API: `/api/v1/split/*` — CRUD for groups, members, expenses, settlements, recurring expenses, and activity feed

### Birthdays (`/birthdays`)

Personal birthday tracker with automatic calendar integration.

- CRUD: name, birth_date (day/month/year or day/month only for age-unknown entries), notes, photo
- Profile photo upload (PNG/JPEG/WebP/GIF, ≤ 5 MB, stored as Base64 data URL)
- **Upcoming view:** birthdays sorted by days until next occurrence; shows age when year is known
- **Mobile action hierarchy:** phones expose creation through the persistent FAB only; the duplicate header action is hidden so the title retains the available width.
- **Calendar integration:** creating or updating a birthday automatically creates/updates a recurring annual all-day calendar event (cake icon, title `Geburtstag: {Name}` in the household data language, see below); deleting a birthday removes the linked event
- **Localized event title (#631, #632):** the stored title and description follow the **household data language** (Settings → Personal → Appearance → Language, `sync_config.language`). Earlier they were written in English and only translated while rendering, which covered the web UI and nothing else — the REST API, the ICS export feed, the CalDAV/Google outbound sync and the FTS index all read the stored row and showed `Birthday: Oma` in a German household. Server-side translation reuses the same `public/locales/*.json` the client loads, read as data by `server/utils/i18n.js` (no module import across the `public/`↔`server/` layer boundary). The client-side translation in `public/utils/birthday-event.js` stays as the override for members whose display language differs from the household's. Because the description embeds a formatted date, it follows `date_format` as well; changing language, region or date format re-titles the existing events in the same request
- **Configurable reminder:** customizable reminder offset per birthday with preset options (none, at time, 15 min, 1 h, 1 d, 2 d, 1 w, 2 w) and a fully custom interval (amount + unit). Reminder time calculated from offset; auto-dismissed when the birthday passes
- **Import from contacts:** a toolbar action opens a selection dialog listing contacts (from CardDAV sync, vCard import, or local entry) that carry a `BDAY`/birthday. The user picks individual contacts via checkboxes; each import creates a birthday linked to its source contact (`contact_id`). Idempotent — already-imported contacts are shown with a check mark and "already added" badge and cannot be re-selected. Contacts without a stored birthday are listed separately for manual completion. Manual entry stays available for anyone not in an address book. Photos are not carried over (contact photos are raw vCard base64, not the data-URL format birthdays expect)
- Search filter by name
- **Deletion is undo-based** (5-second toast) rather than confirmation-gated, matching Notes, Contacts and Recipes: a birthday is a date with no history and nothing cascades from it. The server delete is held back until the undo window closes, so "Undo" prevents it instead of trying to recreate the record afterwards
- API: `GET /api/v1/birthdays`, `GET /api/v1/birthdays/upcoming`, `GET /api/v1/birthdays/import/candidates`, `GET /api/v1/birthdays/:id`, `POST /api/v1/birthdays`, `POST /api/v1/birthdays/import`, `PUT /api/v1/birthdays/:id`, `DELETE /api/v1/birthdays/:id`

### Reminders (`/reminders`)

Time-based reminders attached to tasks, calendar events, or subscriptions.

- **Tasks and subscriptions keep one reminder per entity** (upsert — creating a new one replaces the previous). **Calendar events carry up to five**, each an independent row delivered separately; the event dialog manages them as a row list (see [Reminders data model](#reminders))
- Reminder time set via the shared `yuvomi-datepicker` in the task or event modal, usually as an offset from the due date/start
- **Pending reminders:** polled on page load and at a fixed interval; displayed as an in-app notification badge/toast
- **Birthday reminders** auto-synced from the Birthdays module (configurable offset per birthday, default 1 day before each occurrence)
- Dismissing a reminder marks it `dismissed = 1`; dismissed reminders are not shown again
- API: `GET /api/v1/reminders/pending`, `GET /api/v1/reminders?entity_type=&entity_id=` (single), `GET /api/v1/reminders/all?entity_type=&entity_id=` (full list for multi-reminder entities), `POST /api/v1/reminders` (upsert one), `PUT /api/v1/reminders?entity_type=&entity_id=` with `{ remind_ats: [...] }` (replace-set, deduplicated, max 5), `PATCH /api/v1/reminders/:id/dismiss`, `DELETE /api/v1/reminders/:id`, `DELETE /api/v1/reminders?entity_type=&entity_id=` (all of one entity)
- **Web Push (PWA):** when a device opts in via Settings → Personal → Notifications, a service-worker push handler shows due reminders as system notifications even while the app is closed. The foreground in-app toast still runs; only the in-page `Notification(...)` is suppressed on devices with an active push subscription (push takes over). **Requires HTTPS** (service workers + Push API). API: `GET /api/v1/push/vapid-public-key`, `POST /api/v1/push/subscribe`, `POST /api/v1/push/unsubscribe`, `POST /api/v1/push/test`
- **Household notification channels:** admins can add Gotify and ntfy channels under Settings → Personal → Notifications. A 60-second server-side scheduler (`server/services/push-scheduler.js`, backed by `server/services/notifications.js`) fans out due, undismissed reminders to Web Push plus every enabled household channel. Delivery state is tracked in `notification_deliveries` for duplicate protection and bounded retries; `reminders.pushed_at` is still set once the active targets are complete or exhausted. API: `GET /api/v1/notifications/providers`, `GET/POST /api/v1/notifications/channels`, `PUT/DELETE /api/v1/notifications/channels/:id`, `POST /api/v1/notifications/channels/:id/test`

### Third-Party Modules (`/modules/<id>`)

Runtime-loadable modules discovered from the `modules/` directory (v0.53.0). Each module lives in its own subfolder and must include a `module.json` manifest.

**Folder layout:**
```
modules/
  my-module/
    module.json   # manifest (required)
    index.js      # render(container, context) export (required)
    style.css     # optional, loaded only for this page
```

**`module.json` manifest fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Lowercase letters, numbers, hyphens. Must match the folder name. |
| `entry` | ✅ | Relative `.js` file exporting `render(container, context)`. |
| `name` | | Display name shown in navigation and Settings. |
| `version` | | Semver string, displayed in Settings. |
| `description` | | Short description shown in Settings. |
| `style` | | Relative `.css` file loaded only for this module's page. |
| `icon` | | Lucide icon name for the module's navigation entry. |
| `accent` | | `#RRGGBB` color used for menu highlighting. |
| `menu.show` | | Set `false` to hide from navigation. |
| `menu.label` | | Navigation label (falls back to `name`). |
| `menu.order` | | Integer sort order in the navigation list. |

**Admin controls (Settings → Personal → Navigation, admin-only section):**
- Admins can enable/disable individual third-party modules without restarting the server.
- Admins can drag-to-reorder navigation entries inside their Overview, Plan, Home, or Custom modules group; entries cannot cross group boundaries.
- Disabled modules are not served to the browser and do not appear in navigation.
- Enabled module pages are registered automatically in the SPA router at startup.

**Docker / Podman:** The default `docker-compose.yml` mounts `${MODULES_DIR:-./modules}` to `/app/modules`. To keep modules outside the Yuvomi checkout set `MODULES_DIR=/absolute/path` in `.env` and restart. No image rebuild is required. On Podman use `podman-compose.yml`, which adds the SELinux `:Z` relabel to the same mount. On Portainer the stack mounts the named volume `oikos_modules` there instead, as that deployment has no checkout to bind-mount from.

**Security rules for module authors:**
- Use `replaceChildren()` and `insertAdjacentHTML()`. Never use `innerHTML`.
- Escape untrusted values with `esc()` from `/utils/html.js`.
- Do not use external CDNs or bypass authentication/CSRF/CSP.
- Prefer `/api.js` for Yuvomi REST calls. It prefixes `/api/v1`, sends session credentials, refreshes CSRF tokens, and uses non-cached fetches for user data.
- External backend services used by browser-side modules should be reverse-proxied under a same-origin `/api/...` path when they return dynamic data. The service worker network-first-caches a small **read-only GET whitelist** of `/api/v1/*` data paths (calendar, tasks, shopping, contacts, dashboard) for offline viewing; all other `/api/` requests — mutations, `/auth/*`, and non-whitelisted GETs — are passed straight to the network and never cached.

---

## API Documentation

An OpenAPI 3.0 specification is served at `/api/v1/openapi.json` and `/openapi.json` to **signed-in admins** (both endpoints require an admin session or API token). Append `?download=1` to download as a file. The spec covers all authenticated endpoints and can be imported into any OpenAPI-compatible client (Insomnia, Postman, etc.). The interactive `/docs` page follows the same admin gate and is hidden entirely in production unless `ENABLE_API_DOCS=true`.

Authentication options for external integrations:
- **Session cookie:** standard browser session after login
- **Bearer token:** `Authorization: Bearer <token>` — tokens created via Settings → Administration → API access (admin only)
- **X-API-Key header:** `X-API-Key: <token>` — alternative header accepted alongside Bearer (the plain `API-Key` header is also accepted for MCP-client compatibility)

### MCP Endpoint

A stateless [Model Context Protocol](https://modelcontextprotocol.io) endpoint is served at `/mcp` (JSON-RPC 2.0 over HTTP). It lets AI agents such as Claude Desktop drive the planner via natural language. Authentication reuses the API tokens above — send the token as `Authorization: Bearer <token>`; no CSRF token is required, and no new port is needed.

- **Methods:** `initialize`, `tools/list`, `tools/call`, `ping`.
- **Curated core tools:** `list_tasks`, `create_task`, `list_shopping_items`, `add_shopping_item`, `list_upcoming_events`, `create_event` — fast, in-process handlers for the most common actions. `list_tasks` returns each task's tags and takes a `tag` filter (several narrow the list); `create_task` accepts `tags` (#586).
- **OpenAPI bridge:** `list_api_operations` and `get_api_operation` discover every documented REST operation; `call_api_operation` invokes any of them over an authenticated loopback call. This exposes the full API through one mechanism instead of a per-route tool, and every call inherits the token's permissions (admin-only routes require an admin token).
- Each call runs as the token's creating user and inherits that user's role. HTTPS is strongly recommended.
- **Token scopes apply here too:** a scoped token only sees the core tools it is allowed to use in `tools/list`, is refused any out-of-scope `tools/call`, and — because `call_api_operation` loops back through the REST layer — cannot reach REST operations outside its allow-list. Use this to hand an AI client a token that, for example, may write the calendar but never read the health module.
- Binary responses through the bridge (e.g. document/backup downloads) are inlined as base64 up to **5 MiB**; larger downloads are rejected and should use the dedicated streaming REST route directly.
- **Optional:** `MCP_INTERNAL_BASE_URL` overrides the base URL the bridge calls back into; it defaults to `BASE_URL` or `http://127.0.0.1:<PORT>` and is only needed for non-standard bind addresses.

---

## Design System

### Colors (CSS Custom Properties)

Source of truth: `public/styles/tokens.css`. The excerpt below carries the values that encode a
decision (palette anchors, severity, module identity) — the glass, chart-series, and neutral-ramp
tokens live only in `tokens.css`, where every value has its measured contrast ratio next to it.
Each public token is a `var(--_private)` indirection there, so light and dark are declared once
instead of being repeated across `@media` and `[data-theme]`. Values as of v1.64.0.

**Palette rationale:** Warm-tinted neutral scale (`#F5F4F1 → #1C1C1A`) anchored by a **Violet primary** (`#6c3aed`) that unifies the brand identity and the Calendar module color. Module colors are semantically separated from severity colors — no hue is shared without explicit documentation in `tokens.css`.

```css
:root {
  /* Neutral canvas — warm linen/unbleached-paper atmosphere */
  --color-bg:              #F5F4F1;   /* neutral-100 */
  --color-surface:         #FFFFFF;
  --color-surface-work:    #FFFFFF;   /* readable productive surfaces */
  --color-surface-raised:  #FAFAF8;   /* subtle elevated surfaces */
  --color-surface-glass:   rgba(255,255,255,0.70); /* decorative/light glass */
  --color-border:          #E8E7E2;   /* neutral-200 */
  --color-text-primary:    #1C1C1A;   /* neutral-900, 14.7:1 on bg */
  --color-text-secondary:  #6C6B67;   /* neutral-600, 5.33:1 on white */
  --color-text-tertiary:   #6A6964;   /* 5.00:1 on bg, 5.50:1 on white */

  /* Primary accent — Violet */
  --color-accent:           #6c3aed;  /* Violet-600, 6.06:1 on white (AA) */
  --color-accent-hover:     #5b2fd4;  /* Violet-700 */
  --color-accent-active:    #4a26bb;  /* Violet-800 */
  --color-accent-deep:      #3d1f9e;  /* deep Violet for gradients/weather */
  --color-accent-secondary: #8b5cf6;  /* Violet-500 — logo gradient */
  --color-accent-light:     #f5f3ff;  /* Violet-50 */
  --color-accent-subtle:    #ede9fe;  /* Violet-100 */
  --color-btn-primary:      #5b2fd4;  /* Violet — WCAG AAA on white */
  --color-btn-primary-hover:#4a26bb;

  /* Severity — hue-separated from module colors */
  --color-success:       #15803D;     /* 4.54:1 */
  --color-warning:       #A15C0A;     /* 5.18:1 — Amber, distinct from --module-meals */
  --color-danger:        #B91C1C;     /* Red-700, 6.47:1 */
  --color-info:          #0B66C3;     /* 5.67:1 — own value, split from --module-contacts */

  /* Module accents — domain-specific, not interchangeable with severity.
     One accent per top-level module, not per tab inside one: the Kitchen group
     is a single sidebar entry with four tabs and therefore carries a single
     accent (v1.58.0). Before that each tab set its own, so the same nav entry
     changed colour on every tab switch — the strongest "you left this module"
     signal the UI has, spent on staying put. The four per-tab tokens remain for
     dashboard widgets and nav icons, which reference them individually. */
  --module-kitchen:         var(--module-meals);  /* Shared by Meals, Recipes,
                                         Shopping and Pantry; orange because
                                         Meals is the group's entry tab */
  --module-dashboard:       #6c3aed;  /* Violet — follows primary accent */
  --module-tasks:           #15803D;  /* Green — intentional share with --color-success */
  --module-calendar:        #4F46E5;  /* Violet-indigo — Appointments, time */
  --module-meals:           #C2410C;  /* Orange-700 — Food, warmth */
  --module-shopping:        #D12370;  /* Pink-600 — distinct from Meals (5.02:1, WCAG AA) */
  --module-recipes:         #0C7C5B;  /* Teal-green (166°) — Recipes, hue-separated from
                                         Budget 186° and Tasks 150° (5.19:1, WCAG AA) */
  --module-pantry:          #4D7C0F;  /* Olive green (86°) — Pantry; fills the only free hue gap
                                         between Notes 36° and Tasks 142° (4.99:1, WCAG AA).
                                         Earthy, not fresh: the pantry is the store, not the harvest */
  --module-notes:           #9F6107;  /* Amber-700 — Notes (5.02:1, WCAG AA) */
  --module-contacts:        #0969DA;  /* Blue — distinct from Violet primary */
  --module-birthdays:       #D02A64;  /* Rose — Birthdays, decoupled from --color-danger (5.01:1) */
  --module-budget:          #0F766E;  /* Teal-700 — Finance, stability */
  --module-split-expenses:  #1976A7;  /* Azure-cyan (201°) — Shared family finance (5.01:1) */
  --module-documents:       #42587E;  /* Steel blue — Secure family documents (7.17:1) */
  --module-housekeeping:    #7C3AED;  /* Violet — Focused service workflow */
  --module-health:          #9E1E88;  /* Berry fuchsia (310°) — Health (7.01:1, WCAG AAA) */
  --module-reminders:       #0E7490;  /* Cyan-700 — Reminders (5.36:1, WCAG AA) */
  --module-rewards:         #BC4569;  /* Rose-copper (342°) — Rewards (5.01:1, WCAG AA) */
  --module-settings:        #677079;  /* Neutral grey (5.03:1, WCAG AA) */

  /* Priority — own values, no longer aliases of --module-meals / --color-danger.
     The priority dot on the dashboard and the mobile calendar encodes rank by
     colour alone, so "high" has to stay separable from "urgent": #B4400E sits
     at ~1.8× the lightness of #991B1B (still perceivable with red-green
     deficiency) and holds 4.79:1 for the badge label on its own tinted badge
     ground — the composed surface the old alias had never been measured against
     (v1.40.4). */
  --color-priority-none:   var(--neutral-400);
  --color-priority-low:    #5F5E5A;
  --color-priority-medium: #854D0E;
  --color-priority-high:   #B4400E;
  --color-priority-urgent: #991B1B;
}
```

**Dark mode** keeps the hue and adjusts lightness/saturation only. Two things are not simply
lightened counterparts and are therefore worth naming here:

- **Edges are set independently, not derived from the neutral ramp** (v1.57.0): `--color-border-subtle: #3A3A37`, `--color-border: #4A4A46`, `--color-border-strong: #6B6B68`. The ramp sits so close to `--color-surface` (`#222220`) that the subtle step resolved to *exactly* the surface colour — see [Components → Edge tokens in dark mode](#components).
- **Accent tints go darker, not lighter**: `--color-accent-light: #1e1040`, `--color-accent-subtle: #160b30`, and `--color-btn-primary: #7c3aed` (hover `#6d28d9`), because a "light" accent surface on a dark canvas has to sit *below* the text, not above it.

The full dark set — including every module accent, the chart-series palette, and the vivid-fill ink
token — lives in `tokens.css`; the glass tokens are described under [Glass Layer](#glass-layer-publicstylesglasscss).

### Typography
- Plus Jakarta Sans is the single self-hosted UI family; headings use weight 600–700.
- Hero: 24px mobile / 30px desktop, reserved for the dashboard greeting.
- Page title: 22px mobile / 28px desktop, one primary title per page or settings leaf.
- Section title: 18px; card title and body: 16px.
- Secondary text and compact controls: 14px.
- Caption/label: 12px for short navigation, badge, chip, kicker, and constrained calendar-grid text only.
- Micro: 10px for numeric counters and notification indicators only.
- Typography is assigned through semantic `--type-*` tokens. Hero and page-title roles switch at the 1024px breakpoint; app headings do not use fluid `clamp()` sizing.
- Inputs and prose stay at 16px. Readable supporting text and interactive controls have a 14px minimum.

### Icons
- Lucide is the single icon family, self-hosted as `public/lucide.min.js`; placeholders are `<i data-lucide="…">` and are replaced by `lucide.createIcons({ el: container })` after insertion.
- Four sizes, one name each, declared as `--icon-*` in `tokens.css` and applied through the utility classes in `layout.css`: `icon-sm` 12px (inline markers in running text, chips), `icon-md` 16px (default: buttons, list rows), `icon-lg` 20px (emphasised actions, toolbars), `icon-xl` 24px (FAB, empty state, dialog head).
- Sizes are never set inline. A `style="width:…"` on an icon bypasses the scale and drifts; `test:frontend-audit` guards both the absence of inline sizing and that no two classes resolve to the same value.

### Responsive Composition
- Phone layouts prioritize one readable content column, complete titles, and one clear primary creation action. Horizontal scrolling is reserved for deliberate tab or timeline patterns, never used to compensate for clipped cards or toolbars.
- Tablet layouts (768–1023px) may wrap dense toolbars and use two-column overview grids while retaining the mobile navigation model.
- Desktop composition starts at 1024px. Full secondary toolbars and persistent local navigation return only when their labels and controls fit without compression.
- Grid tracks that contain variable text use `minmax(0, 1fr)` so long localized content cannot enlarge the page beyond the viewport.
- Cards, rows, and controls that display user-generated text must contain unbroken strings and mixed scripts without creating page-level horizontal overflow. Text blocks use per-paragraph bidirectional resolution where user content can mix RTL and LTR scripts.
- Forward navigation starts a page at the top; browser back and forward resume where the reader was. The scroll port survives every navigation - `#main-content` *is* `.app-content`, and a page change only replaces its children - so without an explicit reset the target page opened at the offset of the page before it. The reset runs *before* render, because modules scroll during build (the calendar day view to the current hour, the meal plan to today) and a reset afterwards would undo that; restoration on `popstate` runs after the render, once the content has its full height. Positions live in `public/utils/scroll-restore.js` and end with the session. The direction comes from the `pushState` flag of `navigate()`, not from the slide direction, which follows route order and reads "backwards" for a forward tap on a nav entry sitting further left.
- **Resuming covers the pages that scroll `.app-content` itself.** Eight module roots (`.budget-page`, `.calendar-page`, `.contacts-page`, `.meals-page`, `.notes-page`, `.pantry-page`, `.recipes-page`, `.shopping-page`) are `overflow: hidden` at full height and scroll an inner container instead, so `#main-content` never leaves 0 there and back returns them to the top. Starting at the top on forward navigation works everywhere, because those inner containers are new elements after every navigation and begin at 0 anyway. Carrying the resume into them needs the module to name its scroll region rather than the router guessing it, and is not part of this behaviour yet.
- Route-level load failures replace the page with a localized recovery state. The state uses `role="alert"`, receives focus without scrolling, and offers a reload action; modules must not convert failed initial loads into misleading empty states.
- The same holds **inside** a module, for a list that fails while the page around it stays usable: the failure is carried into module state and rendered before the empty branch, because after a failure the collection is empty too and the empty branch would otherwise win. A toast is not sufficient on its own — it fades while the misleading state below it remains. See `mountLoadError()` under Components.

### Glass Layer (`public/styles/glass.css`)

Additive CSS file loaded globally after `layout.css`. Implements a Liquid Glass design language inspired by Apple's iOS 26 Liquid Glass, adapted for CSS/web:

**Phase 1-3 (Shell + Components + Polish):**
- **Translucent surfaces:** `backdrop-filter: blur()` on bottom nav, sidebar, modal overlay, cards on hover. All blur effects are inside `@supports (backdrop-filter: blur(1px))` for progressive enhancement.
- **Glass tokens:** Section 16 of `tokens.css` defines `--glass-bg*`, `--glass-border*`, `--blur-2xs` through `--blur-xl`, `--opacity-glass-*`, `--glass-highlight*`, `--glass-shadow-sm/md/lg`, `--radius-glass-card/inner/chip/button`, `--ease-glass`, `--transition-glass`. Full dark mode overrides.
- **Capsule shapes:** Buttons, FAB, and search inputs use `--radius-glass-button` (pill shape).
- **Spring animations:** Modal entrance (`glass-modal-scale-in` / `glass-sheet-in`), page transitions, and list stagger all use `cubic-bezier(0.34, 1.56, 0.64, 1)` spring easing.
- **FAB attention pulse:** `fab-ring-pulse` keyframe expands a ring around the FAB to signal readiness.
- **Persistent mobile navigation:** The bottom bar stays visible while content scrolls so primary destinations never move away from the user's thumb.

**Phase 4 (Vibrancy + Tint):**
- **Deeper glass penetration:** Dashboard widgets, task cards, note items, meal slots, form inputs, toolbars, group toggles, and FAB speed-dial actions all use semi-transparent glass backgrounds (`--glass-bg-card`, 52% opacity) with `backdrop-filter: blur() saturate()` so underlying content shines through.
- **Module tint:** Each glass surface receives a subtle accent color gradient overlay via `::after` pseudo-element using `color-mix(in srgb, var(--module-accent) var(--glass-tint-strength), transparent)`. Strength is 6% in light mode, 8% in dark mode.
- **App vibrancy background:** `.app-shell` (the viewport container, `height: 100dvh`, never scrolls) carries a radial gradient with the active module accent at 3% opacity to provide an ambient color base that glass elements refract. `.app-content` (the scroll container) has a transparent background so the gradient shows through. This split is intentional: placing a complex `color-mix()` gradient on a scrolling `overflow: auto` element causes blank-screen rasterization bugs in iOS WebKit and Android Blink (v0.52.32).
- **Load-order safety:** All Phase 4 glass selectors use parent-scoped specificity (`.dashboard .widget`, `.tasks-page .task-card`, `.meals-page .meal-slot`) to prevent override by on-demand page CSS that loads after `glass.css`.

**Mobile compositor safety (v0.52.26):** a single permanent CSS rule disables `backdrop-filter` for all children of the `.app-content` scroll container. Bottom navigation, modals, and toasts sit outside the scroll container and retain their blur. This prevents mobile WebKit/Blink from creating excessive GPU compositor layers during scroll that would trigger blank-screen rendering bugs on iOS Safari and Android Chrome.

**Phase 5 — Navigation Liquid Glass (v0.54.0):**
- **Sliding glass pill indicator:** The sidebar (desktop) and mobile bottom bar display an animated pill that slides to the active navigation entry. The mobile indicator uses a restrained 200 ms transform/opacity transition without animated width; hovering an inactive sidebar entry shows the destination indicator at 50 % opacity as a preview.
- **Custom monoline SVG icons:** `public/nav-icons.js` provides a full icon set for all navigation entries, built with the DOM API (`createElementNS`) — no `innerHTML`. A Lucide icon is used as fallback for entries without a custom SVG.
- **Grouped sidebar headings:** The sidebar separates Overview (Dashboard), Plan (Calendar, Tasks, Notes), Home (Kitchen and household modules), and Custom modules (enabled third-party modules) with localized labels. User ordering is applied only within each group.
- **Accessibility:** Navigation animations are suppressed when `prefers-reduced-motion` is active; glass pill and blur effects are disabled when `prefers-reduced-transparency` is active.

**Phase 6 — Module CSS Migration (v0.54.1–v0.54.5):** The Liquid Glass design language has been extended to all remaining core modules via targeted CSS-only changes to each module's stylesheet. All `--shadow-*`, `--radius-md/lg`, and `--color-surface` values on card containers have been replaced with the Glass tokens (`--glass-bg-card`, `--glass-border-subtle`, `--radius-glass-card/inner/chip`, `--glass-shadow-sm/md/lg`). Modules completed:
- **Budget** (`budget.css`, v0.54.1) — summary cards, loan cards, list sections, transaction rows; summary cards include module-accent tint via `::after`; overlay backdrop uses `--color-overlay-glass`
- **Settings** (`settings.css`) — responsive settings shell (tile overview on the root, sticky local navigation inside a leaf, mobile drill-down), setting rows, status summaries, accessible disclosures, CalDAV/CardDAV account items, module rows, one shared toggle row
- **Housekeeping** (`housekeeping.css`, v0.54.3) — main cards, inner elements (worker strip, metrics, tasks, photos), staff rows with hover accent tint
- **Meals & Recipes** (`meals.css`, `recipes.css`, v0.54.4) — autocomplete dropdown, drag-ghost card, ingredient rows, recipe cards with hover state; `.meal-slot` unchanged (already in `glass.css` §30)
- **Documents & Split Expenses** (`documents.css`, `split-expenses.css`, v0.54.5) — folder browser, document cards/rows, drop zone, member picker, view toggle; split summary card with module-accent tint via `::after`; split cards, group panels, group headers, participant rows

**Phase 7 — Living Drifting Backdrop (v0.54.10):**
- **`.lg-backdrop` layer:** Four blurred, slowly drifting color blobs are rendered behind the entire app shell on a non-scrolling layer outside `.app-content`. Blob 1 follows `--active-module-accent` so the ambient color shifts per section (e.g. violet on Calendar, teal on Budget); blobs 2–4 use fixed module tints for variety. Because the backdrop lives outside the scroll container, it neither triggers nor is affected by the iOS/Android blank-screen mitigation.
- **`--lg-*` design tokens** (`tokens.css`): `--lg-blob-opacity` (0.4 light / 0.55 dark, collapses to 0 under `prefers-reduced-transparency` / `prefers-contrast: more`), `--lg-glass-saturate`, `--lg-card-radius`, `--lg-density`, `--lg-specular`.
- The drift animation is frozen under `prefers-reduced-motion`; the backdrop is hidden entirely under `prefers-reduced-transparency` / `prefers-contrast: more`.

**Phase 8 — Frontend UI/UX Audit Rollout (v0.55.7–v0.55.10):**
- **Glass discipline:** `tokens.css` now separates `--color-surface-work`, `--color-surface-raised`, and `--color-surface-glass` so productive pages can use stronger, more readable surfaces while nav, modals, dashboard hero, and lightweight widgets keep decorative glass.
- **Mobile ergonomics:** dashboard cockpit cards, Tasks secondary controls, Shopping quick-add controls, and Budget row actions use tokenized touch targets and responsive constraints tested at 390px width.
- **Navigation identity:** Overview and More are fixed in the mobile bar, with three user-selected favorites between them. Kitchen and More keep stable labels/icons; the active subsection is exposed through localized accessible labels instead of replacing the visible identity.
- **Calendar and Settings polish:** calendar month/agenda views use explicit readable surfaces and boundaries; Settings shows a tile overview on its root and a sticky local navigation column inside a leaf on desktop, with a history-aware drill-down on mobile.

**Accessibility:** `prefers-reduced-transparency`, `prefers-reduced-motion`, and `prefers-contrast: more` blocks deactivate blur/animation and restore solid fallbacks across all phases.

### Components
- **Cards:** Glass tokens applied app-wide — `var(--glass-bg-card)` background, `var(--glass-border-subtle)` border, `var(--radius-glass-card)` (20 px) for containers, `var(--radius-glass-inner)` (14 px) for inner rows, `var(--glass-shadow-sm/md/lg)` for elevation. Module tint overlay via `::after` pseudo-element using `color-mix(in srgb, var(--module-accent) var(--glass-tint-strength), transparent)`. Consistent padding `var(--space-4)` (16 px) across all modules. `backdrop-filter` is disabled for all elements inside `.app-content` (see Mobile compositor safety above); glass appearance inside scrolling content is achieved through the semi-transparent background + border + shadow alone. **Work surfaces in the Budget module are opaque (v1.63.0):** `budget.css` had documented the rule at `.budget-summary-card` ("glass stays with overlays and modals, content must be readable at a glance") while `subscriptions.css` and `split-expenses.css` set `--glass-bg-card` on summary cards, charts, list sections, the group header, a search input, and two row-hover states — the module contradicted its own rule inside itself. All of those are now `--color-surface` / `--color-surface-raised`. The guard in `test:budget-ui` does not check an allow-list of selectors: it scans **every** rule in `budget.css`, `subscriptions.css`, and `split-expenses.css` and requires any rule carrying `--glass-bg-card` or `--glass-shadow` to name an overlay role in its selector (`modal`, `dialog`, `popover`, `overlay`, `picker-panel`, `form__section`, `tooltip`, `menu`), so a new work surface cannot quietly reintroduce glass. It found two hover states on the first run.
- **Buttons:** Primary = accent + white. Secondary = outline. Min-height 44px. Capsule shape via `--radius-glass-button`. Submit buttons show success (checkmark, 700ms green via `.btn--success`) and error (shake via `.btn--shaking`).
- **Inputs:** `var(--radius-sm)`, 1.5px border, padding 12px 16px. Search inputs use `--radius-glass-button` and `--glass-border-subtle`. `[required]` fields receive validation status on blur (`.form-field--error` / `.form-field--valid`), and re-validate live on input while marked invalid. **Field-anchored form errors (v1.40.1):** modal save paths report validation failures at the offending field instead of a detached toast — the shared helpers `validateAll` / `reportFieldError(input, message)` (`public/components/modal.js`) render the message directly below the field (`.form-field__error`, `role="alert"`, linked via `aria-describedby`), set `aria-invalid` plus the error border, and focus/scroll the first invalid field into view; custom messages (e.g. "end before start") clear themselves on the next input. Used across the calendar event modal and the meals, notes, recipes, budget, budget-plans, subscriptions, and health modal forms. Enter in a **single-line field** submits the modal form (standard web convention, v0.55.0); in a multi-line textarea Enter inserts a newline.
- **Search field (`public/utils/page-search.js`):** the canonical search affordance for list/filter modules — `renderPageSearch()` emits a `<label for>` with an sr-only name, a leading magnifier, the input (`enterkeyhint="search"`, `autocomplete="off"`, `spellcheck="false"`) and a clear button that appears with the first character; `wirePageSearch()` adds the debounce (200ms default) and returns a handle whose `clear()` also hides that button. Modules pass an id, labels and one `onQuery` callback; only toolbar positioning (flex/max-width) stays a thin per-module class. **Pantry and Recipes joined it in v1.60.0** — they had each rebuilt a bare `<input type="search">` with none of the above, the placeholder carrying the only label, and no debounce in front of a full list re-render. The guard in `test:frontend-audit` no longer checks an allow-list of files but scans **every** page for a hand-built search input, so a new module cannot quietly repeat it; documented exceptions (Calendar's server-FTS bar, Split-expenses' visible label, Subscriptions' server-filtered field) are named with their reason.
- **Date & time picker:** Every date and time field across the app uses one shared `yuvomi-datepicker` web component (calendar appointments, tasks, meal planning, budget, health, birthdays, shopping, split-expenses, housekeeping, subscriptions, settings, and the recurrence "until" date). Free-text entry stays the fast path — locale-aware parsing keeps the flexible shorthands (`0930`/`9h30` → `09:30`, `5.1.2027` → the locale date) — while a trailing icon opens a themed calendar/time popover on desktop and the **native OS picker on touch** (`showPicker()`). The popover renders in the top layer via the native Popover API (never clipped inside a modal), takes the module accent from `--active-module-accent`, marks today and traps focus. The component is **form-associated** (participates in `form.elements`/`FormData`), exposes a canonical ISO `value` (`YYYY-MM-DD` / `HH:MM` / `YYYY-MM-DDTHH:MM`), enforces optional `min`/`max` on both typing and the grid, adopts an associated `<label>` as its accessible name, and mirrors direction for RTL. Weekday/month names come from `Intl`; no dedicated locale strings.
- **FAB (Floating Action Button):** Color follows the module accent token (`--module-accent`) - each module defines its own accent color. Specular inner highlight + attention ring pulse. Hidden when the virtual keyboard is open (`visualViewport.resize`, threshold 75% of window height). Rendered from one shared helper `public/utils/fab.js` (`pageFabHtml` / `createPageFab` / `setPageFabAction`); tab/route modules (Health, Rewards, Housekeeping) drive a **context-aware, permission-gated** FAB whose action follows the active tab/route and hides where no create action applies, and Budget's FAB covers its embedded Subscriptions sub-tab (v0.94.0). **The scroll port ends above the FAB (v1.60.0):** `--fab-safe-zone` shortens `.app-content` by a margin wherever a page carries a FAB, so nothing operable can sit under it at *any* scroll position. The previous answer was `padding-bottom` at the end of the list — padding sits at the end of the *content* and scrolls with it, so it only worked once the user was already at the bottom; at `scrollTop = 0` up to 80.6% of a row action was covered. `--fab-gap` is the single source for both the button's offset and the zone, so moving the FAB moves the free space with it. Three drifted copies of the old token (`--budget-fab-clearance`, `--rw-fab-clearance`, and a third in Shopping) are gone; they recomputed the formula without `--nav-bottom-height` and were over 60px too small on phones. This required module roots to *read* the available height instead of recomputing it from `100dvh` — nine of them did, so they ignored any shortening of the shell.
- **Module accent colors:** `--module-accent` is applied on three visual layers - (1) active nav tab (bottom bar + sidebar stripe), (2) toolbar `border-top: 3px`, (3) cards/rows `border-left: 3px`. The active accent is written to `--active-module-accent` on `:root` on every navigation change. Falls back to `--color-accent` for pages without a module context.
- **Accent text on an accent-tinted ground (v1.48.2):** wherever text sits on a tint of its own accent (active filter chips, count badges, initials avatars, module badges), the text uses `color-mix(in srgb, var(--module-accent) 70%, var(--color-text-primary))` rather than the raw accent. With the raw accent the contrast depends solely on that accent's lightness, and 13 of 17 modules missed AA (Recipes 2.84:1, Shopping 3.21:1 against `--color-bg`); the 30% ink admixture shifts the text away from the ground in a theme-aware direction (darker in light, lighter in dark) because `--color-text-primary` flips with the theme. Worst case 4.99:1 (light, Settings) and 5.32:1 (dark, Health), with the hue unchanged so module identity is preserved. **Text only** — icons keep the full accent, where 3:1 applies. The formula is deliberately not a `:root` token: custom properties are substituted in the defining scope, where `--module-accent` is not yet set, which would freeze the `--color-accent` fallback and tint every module violet.
- **Edge tokens in dark mode (v1.57.0):** the three border steps are set independently under dark instead of being derived from the neutral ramp. The ramp sits so close to `--color-surface` (`#222220`) there that `--color-border-subtle` resolved to **exactly the surface colour** — a card edge in the colour of its own face (1.00:1), which left cards, list rows and form fields without a visible boundary. Dark now carries `--color-border-subtle: #3A3A37` (1.40:1), `--color-border: #4A4A46` (1.79:1) and `--color-border-strong: #6B6B68` (2.98:1), plus `--glass-border-subtle` at 12% white (1.50:1) for the glass-styled search and quick-add fields. Note that the light theme's field edge (`#E8E7E2`, 1.24:1 on white) is still below the 3:1 that WCAG 1.4.11 asks of a control boundary; raising it changes the look of every input in the app and is therefore a separate, deliberate decision.
- **Module head width and bleed (v1.45.15):** the head is a full-bleed rail. Its chrome - accent stripe, divider, background, sticky surface - runs to the shell edge, while the head *content* sits in the same centred content column as the page body below it. The column comes from `--page-inline-pad: max(var(--page-gutter), calc((100% - var(--content-max-width)) / 2))` applied to the direct children of a module root; no module root carries its own `max-width`. Previously each root capped itself at 1280px with the head inside that cap, so the accent stripe ended mid-surface and the modules had drifted onto four different head widths. Dashboard and Settings are the documented exceptions - they have no module head and keep their centred block. Guarded by `page-inline-pad contract holds across every stylesheet (#577)` in `test/test-frontend-audit.js`.
- **Navigation:** The persistent mobile bottom bar contains exactly five destinations: fixed Overview, three configurable favorites (default Calendar, Tasks, Kitchen), and fixed More. Inactive buttons are neutral; the active module alone supplies color to the icon and 200 ms sliding indicator. That indicator is a capsule **behind the icon only**, sized and vertically aligned to the icon well, at most 64 px wide and inset from the slot edges (v1.45.12), so it never crops its own rounding against the bar edge in the first/last slot, never crosses the label baseline, and never reaches into the bottom safe area. The desktop sidebar uses the same glass surface and groups entries under localized headings — Overview (Dashboard), Plan (Calendar, Tasks, Notes), Home (Kitchen, Contacts, Birthdays, Budget, Documents, Housekeeping), and Custom modules when enabled third-party modules are loaded — with Settings pinned at the end. Ordering is user-specific and limited to each group. Custom monoline SVG icons are served from `public/nav-icons.js` (DOM API, no `innerHTML`); Lucide is the fallback. Kitchen and More keep stable visible labels/icons; active subsections use localized `aria-label`/`aria-current`. **Collapsible sidebar (desktop only):** a toggle button collapses the sidebar to icon-only mode (56 px); state persists in `yuvomi.sidebar.collapsed`, and native title tooltips preserve discoverability.
- **Sub-tabs:** `public/utils/sub-tabs.js` renders the sticky pill-style tab bar for Kitchen. It wires `role="tablist"`, `aria-selected`, `aria-controls`, `aria-labelledby`, keyboard arrow navigation, and panel focus coordination from one shared helper. (Settings no longer uses sub-tabs; it has its own responsive shell — see the Settings section.)
- **Tablist behavior:** `public/utils/tablist.js` (`wireTablist`) is the shared WAI-ARIA tablist behavior — roving tabindex, arrow/Home/End keys, `aria-selected`/`aria-current` — for tab navs that live inside a module's `page-toolbar` rather than a standalone sub-tab bar (Budget, Rewards, Housekeeping, and the Calendar month/week/day/agenda view-switcher). It complements `sub-tabs.js` so every tab surface shares one interaction grammar (v0.94.0).
- **Transitions:** Directional slide-X animation on page change (forward = from right, back = from left, 200ms) with spring easing. Respects `prefers-reduced-motion`.
- **Empty states:** Consistent `.empty-state` class across all modules (icon + title + description, centered). Compact variant `.empty-state--compact` for meal slots. `public/utils/empty-state.js` enforces the composition (order, ARIA role, single CTA) for the kitchen tabs; it knows three variants — `empty` (no role, primary CTA), `no-results` (`role="status"`, reset CTA) and `error`.
- **Failure state (v1.60.0):** `mountLoadError()` is the fourth state of any list, next to empty, filled and loading. There was a shared renderer for the first three and none for "failed", so a server error produced four different reactions across the kitchen: Shopping and Meals showed their **empty state including its creating CTA** (with 31 items and 28 planned meals actually stored), Pantry showed a correct error whose explanatory line rendered `[object Object]`, and Recipes tore the whole app into the global error screen. An empty state is the most harmful of those: it claims data loss and offers a writing action as the only way out. The renderer therefore forces two things a plain `variant: 'error'` did not — a retry action (a failure state without a way out is a dead end) and a technical line taken from the *error object*, never from a server text (`data.error` is an unlocalized English "Internal server error." on every route, while the status code is language-neutral and the one useful detail for a self-hoster). Loaders carry the failure into module state so the renderer can tell "nothing created yet" from "could not load"; the guard `die Küchen-Seiten zeigen bei einem Ladefehler den Fehlerzustand` in `test:frontend-audit` holds the order, because after a failure the collection is empty too.
- **Kitchen transfer (`public/utils/kitchen-transfer.js`, v1.62.0):** the one path out of a kitchen tab into a shopping list, shared by Pantry, Recipes and Meals. It owns the *check* and the *answer*, not just the text. Two states had drifted apart. **"There is no shopping list yet"** had four outcomes: two strings, two tones (`warning` in Pantry, `danger` in Recipes and Meals) and exactly one way out — Pantry's. Red claims something is broken, while a list that has not been created yet is a missing precondition; and in the meal modal the same sentence appeared a fourth time as a disabled `<option>` next to a button that did nothing, which is the worst of the four because it *looks* operable. Recipes also borrowed `meals.noShoppingLists`, so a refactor in Meals would have silently taken the recipe text with it. There is now one answer: `warning` tone, one `kitchen.*` key owned by the group rather than by one caller, and a button that goes to Shopping (dropped when the module is disabled, because a dead end is worse than none). `resolveShoppingTarget()` also does the one-vs-many list choice, so the whole precondition lives in one place. **Undo** existed only in Pantry, although all three are one-tap paths that create items in a list the user is not looking at — and Recipes moves the most at once, a whole ingredient list. All three now report through `announceTransfer()`: one toast duration (5 s, longer than the default because the toast carries an action), one refresh of the tab badges, and a real undo built on the `added_ids` the server returns. No delayed commit — the server skips duplicates, so only it knows the count the toast promises. Without ids the toast deliberately appears *without* an action rather than with a button that cannot undo anything. The rollback is one call, `POST /api/v1/shopping/items/undo-transfer`, in a single transaction: N individual deletes can half-fail, and the meal path additionally sets `meal_ingredients.on_shopping_list`, so deleting only the shopping items would leave those ingredients marked as transferred forever — neither on the list nor transferable again. Two guards in `test:frontend-audit` scan the **stock** rather than a file list: every `api.post` in `public/pages/` whose path ends in `to-shopping-list` or `import-*`, and every matching route handler in `server/routes/`. The two flows with their own confirmation dialog (Shopping's meal-plan import and its put-away into the Pantry) are named exceptions with their reason — there the dialog is the protection.
- **Modals:** Centered panel on desktop with glass overlay. On mobile (< 768px) bottom sheet - spring slide-in from below, sheet handle visible, swipe-to-close (> 80px downward). `focusin` scrolls inputs into view when the virtual keyboard is open. The modal lifecycle is managed as an explicit state machine (`idle → open → confirming → closing`) with encapsulated suspend/restore helpers, hardening the unsaved-changes confirmation against double-close and back-navigation races (v0.55.0). The same suspend/restore path also carries **`confirmOverModal()`**: a confirmation asked from *inside* a form modal parks the form instead of replacing it. Plain `confirmModal` runs through `openModal`, and that clears the active overlay with `force: true` — so the cancel path, the only reason to ask at all, destroyed the input without ever touching the dirty guard. Cancelling now returns the form untouched, dirty snapshot, Escape handler and focus included; confirming closes it with `force: true`, because the decision takes the input along anyway (the same rule as after a completed write). While the dialog is up the parked overlay is `inert` — the dialog's focus trap holds the tab focus but not the reading cursor — and its title id is set aside, because a duplicate `shared-modal-title` makes `aria-labelledby` resolve onto the form underneath, which had the confirmation announced with the form's heading. Modal titles and `selectModal` option labels are HTML-escaped centrally to prevent XSS from raw user data reused as modal headings.
- **Destructive dialogs name what they destroy (v1.75.4):** In a self-hosted family instance there is neither support nor undo, so whoever does not read the consequence in the dialog never reads it at all. Every `confirmModal`/`confirmOverModal` marked `danger: true` therefore carries a `detail` naming the concrete outcome, not a second warning: what disappears, what stays, what is reversible. Deleting a budget account keeps its entries but nulls their account link; deleting a folder keeps the documents and drops them into the no-folder view; deleting a medication takes its schedule and the whole intake history along by cascade; disconnecting Google drops pending deletions, so those events stay behind in Google. The rule cuts the other way too: where nothing is irretrievably lost, `danger: true` is the bug. Rejecting a redemption request posts a `reversal` ledger entry and can be asked again while the reward is still active in the catalogue (`POST /redemptions` requires `is_active = 1`), so it is no longer painted red - colour that claims a finality the action does not have is as misleading as a missing consequence. Where that finality is real, it belongs to the act that caused it: deleting the reward carries its own `danger`. The guard in `test:frontend-audit` scans the **stock**: every dialog under `public/`, with the argument list read by bracket balancing rather than a fixed-length window. Both were real gaps in the first version (v1.40.x), which knew five files by name and read 320 characters per call: 25 dialogs stood without a consequence text, eight of them behind `confirmOverModal`, whose name does not contain the shorter one a naive scan looks for. The five original settings dialogs stay pinned by name on top, so removing `danger: true` cannot become the cheap way out of the rule. Shared components state their consequence per caller, never once for everyone: the category manager serves Budget, Tasks, Contacts, Shopping and Pantry, and their servers disagree - the first three reject an in-use category with 409, Shopping moves the items to the first remaining category (`ORDER BY sort_order ASC LIMIT 1`, not the neighbouring one), Pantry leaves them without a storage location. `configure()` therefore takes `deleteDetailKey` (plus `subDeleteDetailKey` where subcategories are on), and a second guard walks the callers in the stock rather than knowing them: whoever embeds the component supplies the text. The same class of bug had already appeared here once, when the shared "New category" placeholder showed up in the storage-location dialog.
- **Look first, edit second (`public/components/detail-view.js`, v1.70.0):** Tapping an appointment or a task opens a read-only view instead of the edit form. The old path raised the virtual keyboard over roughly 40 % of the screen for someone who only wanted to know when the dentist appointment is; tasks had no reading path at all, all five entry points ended in the form. The read view holds no input field, so the keyboard cannot open - a guarantee out of the structure, not a removed autofocus line. "Edit" in the header is a named intent and mounts the form only then. New entries still start in the form, because there typing *is* the intent, so the `pointer: coarse` redirection applies to the switch path only, never globally. Two presentations share one caller API: from 768px **and** with an anchor the view is a popover at the tapped chip, otherwise a bottom sheet over `openModal()`. The appointment view shows three things the old popup withheld - recurrence in plain language (`describeRRule()`), reminders and visibility - and a task's status can be advanced straight out of the read view instead of through a form with seven selects. `showEventPopup` and `.event-popup` are gone.
- **Detail view: what must not be undone (v1.70.0):** The form is mounted lazily and **stays in the DOM** on the way back, so re-entering "Edit" finds the input again; the header button therefore reads "Back", not "Done", because it switches views and saves nothing. A hidden form still counts towards the dirty check, which is why every footer action closes with `force: true` - otherwise "Delete" asked to discard fields the deleted record takes along anyway, and the status advance asked about a write that had already reached the server (the #625 rule from the other side; `closeDetailView({ force })` returns a promise so the caller can wait for the overlay slot before reusing it). Switching into the form awaits `edit.ready`: `saveEvent` reads the reminders out of the form rows and deletes the event's reminders when it finds none, so a form built before the response would lose them on save. Every view carries a token, and a late `update()` discards itself when its view is no longer the active one - otherwise a slow response writes the appointment from a moment ago into the card of now. The switch path runs `mount()` → `mountFooter()` → `refreshDirtySnapshot()` → `focusFirstField()` in exactly that order; a guard in `test:detail-view` holds it. The component is built to be adopted by the remaining modules without new architecture - documents and subscriptions are the clearest remaining wins after contacts (v1.72.0). `sections` takes plain row **descriptors** (`{icon, label, value}`, or `node` for anything that is not text) - `detailBodyEl` runs them through `detailRowEl` itself and drops every row without content, so callers need no conditionals for empty fields. Handing it ready-built elements looks right and fails silently: they arrive at `detailRowEl` as an options object with no `value` and no `node`, and the view renders its title and footer around an empty body. **Deliberately left out:** `interactive-widget=resizes-content` in the viewport meta. The default `resizes-visual` shrinks only the visual viewport and leaves CSS blind, so it is a real lever for the remaining forms - but one that has to be judged across all pages, while the read view solves the keyboard problem at its cause.
- **Contacts read first (v1.72.0):** Tapping a contact opened the edit form, while the chevron at the end of the row promised a detail view that did not exist. Both entry points now open the read view - the list row and the `?open=<id>` deep link from global search, where the hit is something you want to see before you change it. Creating a contact still starts in the form. No anchor is passed, so the view is a centred panel on the desktop too: addresses and several numbers do not fit the 320px of an anchored popover. The gain is larger than the detour saved. The list renders one legacy single value each from `contacts.phone/email/address`, so a contact with a work and a mobile number offered exactly one of them to tap although the second had long been stored in `contact_phones`. The read view carries every number, mail and address with its label, each its own tap target over `tel:`/`mailto:`/map. Organisation and job title arrive over CardDAV and had no display anywhere in the app until now, because the form does not manage them. Switching into the form awaits the single-contact fetch (`edit.ready`): `buildContactForm` reads the multi-value fields out of `contact.phones` and falls back to the legacy single without them, so a form built before the response would write back exactly one number on save and drop the rest. `buildContactForm` is split out of `openContactModal` for the same reason the calendar keeps `edit.standalone` - the identical form has to come into being in two places, and its wiring stays in the closure that owns the markup.
- **List animation:** Staggered spring fade-in on load (`stagger()` from `public/utils/ux.js`) - max 5 elements staggered (30ms gap), rest appear immediately.
- **Vibration:** `vibrate()` from `public/utils/ux.js` - short pulses for light actions (10-40ms), pattern `[30, 50, 30]` for destructive actions (delete). Respects `prefers-reduced-motion`.
- **Global search overlay:** Full-text search across tasks, calendar events, notes, contacts, and shopping items. Results are grouped by module and trigger deep-link navigation: contacts via `?open=<id>` (opens edit modal directly), calendar events via `?open=<id>`, notes via `?open=<id>`, shopping items via `?list=<id>&highlight=<id>` (activates the correct list tab and scrolls the item into view). Opened from the sidebar search item or the `/` shortcut on desktop and the More-Sheet search bar on mobile. The overlay is responsive: a full-screen bottom-sheet on mobile and a centred, top-anchored command-palette (~640px glass card over a blurred module scrim, mirroring the modal grammar) on desktop (≥768px). Before a query it shows an empty-state launcher whose tiles list the searchable areas (tasks, calendar, notes, contacts, shopping, health) and jump straight to the module; during the debounced fetch it shows a loading skeleton and announces progress and result count through an ARIA live region. The FTS5 index is diacritic-insensitive (`unicode61 remove_diacritics 2`, migration 77) and the query expands ß↔ss variants, so "muller"/"strasse" match "Müller"/"Straße". Calendar events are family-visible in search (not scoped to the creator), matching the calendar list. **Tags are part of the indexed text (migration v117, #586)** for tasks and shopping items — a tag is free text and therefore content, and the task list already filters by it, so the same word had to lead to a hit in both places. Because the tags live in their own tables while the existing triggers hang on `tasks`/`shopping_items` and only see that row, the index is maintained from both sides: the row triggers were widened, and `task_tags`/`shopping_item_tags` got triggers of their own, so a pure tag change reaches the index without the task being touched.
- **Calendar search (#471):** An in-context search bar in the calendar toolbar (magnifier button, or the `f` shortcut) finds appointments across the whole timeline — past and future — even when the date is unknown. Matches title, location, and notes/description via `GET /api/v1/calendar/search?q=` (same FTS5 index; event body indexes `location` since migration 76). Results render as a chronological, date-grouped list anchored on the next upcoming hit; recurring events resolve to their next occurrence within a two-year window rather than the series start. Selecting a result jumps to that day and opens the event. Result rows are keyboard-operable (`role="button"`, Enter/Space); the count line reports "N of M" when capped at 100.
- **PWA install prompt:** Appears only after 2 user interactions. Dismiss window 7 days; interaction counter resets after dismiss.
- **PWA offline and update contract (v0.71.34):** Service-worker shell, page, locale, and asset caches are keyed to the package release so every published UI revision installs fresh cache namespaces. The early `/lang-init.js` locale/direction bootstrap is part of the offline shell. When the network is unreachable and `index.html` is not cached, the worker serves `/offline.html` with a reload button. **Precache completeness (v1.64.1):** the precache covers the full static import graph, not just the entry modules - every `/utils/*` and `/components/*` module a page imports is listed alongside it, so an update never installs a page module without the modules it is built against. Precache bucket and fetch routing come from the same lists (`APP_SHELL` → `SHELL_CACHE`, `PAGE_MODULES` → `PAGES_CACHE`); `test:sw-precache` walks the graph and fails on any gap.
- **No page loads across a version boundary (v1.64.1, #616):** a browser keeps one module map per document, so a module loaded once stays bound for the life of that document. If a tab is open while the server is updated, a freshly fetched page module would bind against the already-loaded, older shared modules, and an export added in the new version surfaces as `SyntaxError: does not provide an export named …`. Once an update is announced (`SW_UPDATED`), the router therefore stops importing page modules and prefetching module graphs entirely and resolves the next navigation into a reload instead. A dynamic import that fails with a module-binding error triggers the same reload as a fallback, guarded by a 30-second `sessionStorage` marker so a genuine bug cannot loop.
- **Read-only offline data (v0.78.8):** The service worker network-first-caches a whitelist of read-only `GET /api/v1/*` data paths (calendar, tasks, shopping, contacts, dashboard) in a release-keyed `yuvomi-api-<version>` cache, so the last-seen data stays viewable offline. Mutations, `/auth/*`, and non-whitelisted GETs are never cached; state-changing requests that fail offline surface a clear "changes aren't possible while offline" message instead of a raw network error. The calendar shows a subtle "Offline – as of: {time}" banner (from the cached `x-cached-at` timestamp) when served from cache. The API cache is wiped on logout and session expiry (`CLEAR_API_CACHE` message) so a second user on the same device cannot see the previous user's cached data, and every cache that does not belong to the running release is purged on SW activation — previous `yuvomi-*` versions as well as the legacy `oikos-*` caches from before the rename.
- **User-selected note colors (v0.71.34):** note titles, content, creator metadata, and fallback avatars choose black or white ink from WCAG relative luminance instead of a brightness heuristic; supporting text remains fully opaque so every built-in note color meets AA contrast.

### Breakpoints
Four canonical, structural thresholds, declared as `--bp-*` in `tokens.css` (§11c) and enforced by a guard in `test:frontend-audit` — every `@media` width in the stylesheets must be one of these or its complement:
- Mobile: ≤ 640px (1 column, bottom nav)
- Tablet: 641–767px (portrait tablet; the `min-width: 768px` complement)
- Desktop: ≥ 1024px (sidebar + content, multi-column)
- Wide: ≥ 1440px (optional wide-desktop tuning)

Component-internal reflow — a card or form grid that changes its column count based on its *own* width — belongs in a `@container` query or a fluid `clamp()` value, not in a new viewport breakpoint. Otherwise a component reflows differently depending on which module hosts it.

### Focus Ring (v1.60.0)
One specification, declared as `--focus-ring-*` in `tokens.css` (§7b) and enforced by a guard in `test:frontend-audit`: the colour follows the active module accent, so the ring a keyboard user sees is the colour of the module they are in. Previously there were six — two competing base rules (`reset.css` set 2px/offset 2px, `glass.css` raised the offset to 3px globally) plus around 45 component rules over them, half of which read the module accent and half the app accent. Tabbing through the shopping list alternated purple → orange → purple → orange; a colour change reads as a context change where there is none.

- `--focus-ring-width` / `--focus-ring-color` / `--focus-ring-offset`, plus `--focus-ring-offset-inset` for elements on a clipped edge (`overflow: hidden` on an ancestor cuts a positive offset).
- **No shorthand token.** Custom properties resolve where they are *declared*; a combined `--focus-ring` on `:root` would bake in the root colour and make local overrides silently ineffective.
- **Justified exceptions override `--focus-ring-color` only** and keep reading width and offset from the tokens: the FAB (accent-coloured itself, so it inverts to a light ring plus an accent halo), account rows and colour swatches in Budget, meal slots on the dashboard, danger buttons, and bottom-nav items (which point at *their* module, not the open one).
- `prefers-contrast: more` redefines the tokens rather than setting `outline-width` directly — as a property on `:focus-visible` (0,1,0) it lost against every component rule, so the reinforcement reached the base ring but not the ~45 components people actually operate.

---

## Internationalization (i18n)

All UI strings are managed via `public/i18n.js`. No hardcoded text in JS files outside of locale files.

### Architecture

- **Module:** `public/i18n.js` - exports: `initI18n()`, `setLocale()`, `t(key, params?)`, `getLocale()`, `getSupportedLocales()`, `formatDate(date)`, `formatTime(date)`
- **Locale files:** `public/locales/de.json` (reference), `public/locales/en.json`, `public/locales/es.json`, `public/locales/fr.json`, `public/locales/it.json`, `public/locales/sv.json`, `public/locales/el.json`, `public/locales/ru.json`, `public/locales/tr.json`, `public/locales/zh.json`, `public/locales/ja.json`, `public/locales/ar.json`, `public/locales/hi.json`, `public/locales/pt.json`, `public/locales/uk.json`, `public/locales/pl.json`, `public/locales/nl.json`, `public/locales/cs.json`, `public/locales/vi.json`, `public/locales/hu.json`, `public/locales/fa.json`, `public/locales/fil.json`, `public/locales/id.json`, `public/locales/ko.json` - **nested** by module, one object per module: `{ "tasks": { "newTask": "…" } }`. `t()` resolves the dot path (`t('tasks.newTask')`), so the call site reads flat while the file stays groupable and diffable per module. Files are 4-space indented; never reserialize with `JSON.stringify(obj, null, 2)` — it rewrites all ~3400 lines and buries the actual change
- **Variables:** `{{variable}}` syntax in translation strings, e.g. `t('tasks.assignedTo', { name: 'Anna' })`. Values are **inserted, never interpreted**: substitution runs as a single pass over `/\{\{(\w+)\}\}/g` with a callback, not as a loop of `replaceAll(string, string)`. A string replacement would treat `$&`, `` $` ``, `$'` and `$$` in a value as back-references — a contact named `A $& B` rendered as `A {{name}} B`, and `` $` `` pulled the text preceding the match into the name — and a loop would re-scan an already-inserted value with the next placeholder, so a name of `{{date}}` turned into the date. Unknown placeholders are left standing rather than dropped, so a forgotten parameter is visible instead of silently blanking. Same rule and same reasoning in `server/utils/i18n.js`; guarded by `test:i18n-plural`
- **Plurals (v1.34.0):** a numeric `count` parameter selects the matching CLDR category via `Intl.PluralRules` — `t('key', { count })` looks for `key_one`, `key_few`, … before falling back to `key_other` and then the bare key. Languages that need no distinction (Japanese, Korean, Chinese, Turkish …) or that use a count-agnostic phrasing simply carry no variant, so nothing regresses. Prevents strings like "1 address books enabled"
- **Fallback chain:** active locale → German (`de`) → key itself
- **Date format:** `Intl.DateTimeFormat` with current locale - use `formatDate()` and `formatTime()` from `i18n.js`
- **Server side (#631, #632):** `server/utils/i18n.js` translates the content the server *stores* rather than renders — `translate(locale, key, params)` with the same `{{variable}}` syntax and the same `de` fallback, plus `formatDateKey()` (a port of the client's `formatDateParts()` so a stored date matches the one on screen) and `resolveHouseholdLocale()`. It reads the locale files with `readFileSync` instead of importing them, which keeps the `public/`↔`server/` layer boundary (`test:layer-boundary`) intact and makes it impossible for the two lists of languages to drift apart. No plural handling: stored strings are titles and descriptions of single records, not counts

### Language Detection

Two independent resolutions, because they answer different questions:

**Display language** (per user, what the UI renders):

1. `localStorage` entry `yuvomi-locale` (manual selection)
2. `navigator.languages[0]` (browser language)
3. Fallback: `en`

**Data language** (per household, what the server stores — see Settings → Personal → Appearance):

1. `sync_config.language` (explicit admin choice)
2. Language part of `sync_config.region` (`de-DE` → `de`)
3. Fallback: `en` — deliberately not the `de` reference locale, so a household that never set a region keeps the wording it had before the setting existed

### Supported Languages

| Code | Language | Status |
|------|----------|--------|
| `de` | German | Reference locale (all keys defined here) |
| `en` | English | Full translation |
| `es` | Spanish | Full translation |
| `fr` | French | Full translation (added v0.16.3) |
| `it` | Italian | Full translation (added v0.5.8) |
| `sv` | Swedish | Full translation (added v0.11.3) |
| `el` | Greek | Full translation (added v0.16.3) |
| `ru` | Russian | Full translation (added v0.16.3) |
| `tr` | Turkish | Full translation (added v0.16.3) |
| `zh` | Chinese (Simplified) | Full translation (added v0.16.3) |
| `ja` | Japanese | Full translation (added v0.19.0) |
| `ar` | Arabic | Full translation (added v0.19.0) |
| `hi` | Hindi | Full translation (added v0.19.0) |
| `pt` | Portuguese | Full translation (added v0.19.0) |
| `uk` | Ukrainian | Full translation (added v0.19.0, completed v0.52.3 by @baragoon) |
| `pl` | Polish | Full translation (added v0.50.0) |
| `nl` | Dutch | Full translation |
| `cs` | Czech | Full translation |
| `vi` | Vietnamese | Full translation |
| `hu` | Hungarian | Full translation |
| `ko` | Korean | Full translation (added v0.88.0) |
| `id` | Indonesian | Full translation (added v0.88.0) |
| `fa` | Persian (Farsi) | Full translation, RTL (added v0.88.0) |
| `fil` | Filipino | Full translation (added v1.78.0, #669) |

The table documents `SUPPORTED_LOCALES` in `public/i18n.js` — 24 locales. `de` is the reference: every key exists there first, and `test:i18n` holds the other 23 against it — same key set, same `{{placeholders}}`, same 4-space format. Every locale carries the **full** key set including plural variants for CLDR categories its language does not use (`_few` in English, `_one` in Japanese); `t()` picks the category via `Intl.PluralRules` and falls back to the base key, so an unused variant is inert, while a key set that differed per language would turn every translation diff into a case-by-case review.

### Adding a New Language

1. Create `public/locales/xx.json` (copy of `de.json`, translate)
2. Add `'xx'` to `SUPPORTED_LOCALES` in `public/i18n.js`

There is no third step for the label: the picker names each locale through `Intl.DisplayNames`, in the language the user is currently reading, so a hand-maintained name list would only be a second source that drifts.

### Locale Switching

The early language bootstrap applies both `lang` and writing direction before the app renders (`ar` uses `dir="rtl"`; all other supported locales use `dir="ltr"`). `setLocale(locale)` saves the selection, loads the new locale file, updates both document attributes, and fires the `locale-changed` custom event. The router rebuilds shared navigation and re-renders the active route so every visible label changes without a page reload.
