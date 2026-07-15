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
| password_hash | TEXT | bcrypt |
| avatar_color | TEXT | HEX color code |
| avatar_data | TEXT | Base64 data URL of profile picture (nullable) |
| role | TEXT | 'admin' or 'member' |
| family_role | TEXT | 'dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other' (default 'other') |
| oidc_sub | TEXT | OIDC subject identifier from the provider, nullable. Populated on first SSO login. |
| oidc_provider | TEXT | OIDC issuer URL of the provider that set `oidc_sub`, nullable. Partial UNIQUE index on `(oidc_sub, oidc_provider)` WHERE NOT NULL. |
| calendar_feed_token | TEXT | Secret token authenticating the user's read-only ICS export feed, nullable. Partial UNIQUE index on `calendar_feed_token` WHERE NOT NULL. |
| calendar_feed_show_assignees | INTEGER | Opt-in flag (0/1, default 0): when set, the read-only ICS export feed appends the assigned members to each event's `SUMMARY`, e.g. `Pool party (Mom, Dad)`. |

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
| parent_task_id | INTEGER | FK → Tasks (max 2 levels) |
| points | INTEGER | NOT NULL DEFAULT 0 — reward points credited to assigned members on completion (Rewards module, migration v69) |
| visibility | TEXT | NOT NULL DEFAULT `all` — `all` \| `assignees` \| `private`; who may see the task (migration v78) |

**Visibility (migration v78):** every task carries a `visibility` of `all` (all family members, the default and prior behaviour), `assignees` (creator + assigned members only), or `private` (creator only). Enforcement is **server-side on every read path** (list, detail, dashboard widgets, search, MCP) — there is **no admin bypass**, so a "private" task stays hidden even from a parent/admin (the intended use is preparing a surprise). Set via the visibility selector in the task modal; restricted tasks carry a lock/people icon in the list. The same field and rule apply to calendar events.

Recurring tasks keep only one open instance: the next instance is created on completion, not on a schedule. When an overdue recurring task is marked done, its next due date catches up to the next occurrence at or after today (skipping missed periods) instead of advancing a single interval from the old — possibly still overdue — due date.

### Task Categories (migration v83)
DB-backed, customizable category list for tasks. Replaces the old hardcoded set. The eight predefined keys (`household`, `school`, `shopping`, `repair`, `health`, `finance`, `leisure`, `misc`) keep a stable slug key and are localized via `label_key`; user-added categories store their display `name`. A "Manage categories" action in the tasks toolbar opens a modal (the reusable `oikos-category-manager` component) to add, rename, reorder, and delete categories. Renaming leaves the key stable (so existing tasks are unaffected) and clears `label_key`. Deletion is blocked while a category is still referenced by tasks (`409`) or when it is the last remaining category.

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
| name | TEXT | NOT NULL |
| sort_order | INTEGER | NOT NULL |
| created_at | TEXT | |
| updated_at | TEXT | |

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
Stores individual skipped recurring meal dates so deleting a single occurrence (scope: this date only) does not regenerate it. Deleting the whole series drops the template and cascades these exceptions away.

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

### Recipe Ingredients
| Column | Type | Constraint |
|--------|------|-----------|
| recipe_id | INTEGER | FK → Recipes (CASCADE delete), NOT NULL |
| name | TEXT | NOT NULL |
| quantity | TEXT | |
| category | TEXT | NOT NULL (default 'Sonstiges') |

### Meal Ingredients
| Column | Type | Constraint |
|--------|------|-----------|
| meal_id | INTEGER | FK → Meals, NOT NULL |
| name | TEXT | NOT NULL |
| quantity | TEXT | |
| on_shopping_list | INTEGER | 0/1 |

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
| recurrence_rule | TEXT | iCal RRULE |
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

**Delete a single occurrence (migration v85):** deleting an event of a recurring series asks whether to remove *only this occurrence* or the *whole series*. "Only this occurrence" records an exception; the recurrence expansion then skips that date on every read path (list, upcoming/dashboard, search) while the series continues. Offered for **local series only** — externally synced series (Google/Apple/CalDAV via `calendar_ref_id`, ICS via `subscription_id`) keep whole-series deletion, since an EXDATE would return on the next sync. Exceptions are also emitted as `EXDATE` lines in the ICS export feed. `POST /api/v1/calendar/:id/exceptions { date }` records an exception; series deletion removes its exceptions via CASCADE.

### Calendar defaults for new events (per-user)
Two per-user preferences prefill the new-event dialog (stored in `sync_config` under a per-user key, like `module_order`):
- **`calendar_default_reminders`** — a list of reminder offsets (minutes before start, subset of the reminder presets, max 5) that new events receive automatically.
- **`calendar_default_assign_me`** — when on, new events are pre-assigned to the current user.

Both are configured in Settings → Calendar and apply only when creating an event (never on edit); a date-based sync default assignee still takes precedence for imported events.

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
| UNIQUE | | (caldav_url, username) |

### CalDAV Calendar Selection
Per-account calendar enable/disable state for CalDAV accounts.

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
more often a transient server or auth error than a genuinely emptied calendar.

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

### CalDAV Reminder Selection
Per-account reminder-list selection for CalDAV accounts. Apple Reminders lists are CalDAV
collections whose supported components include `VTODO`. Reuses the same CalDAV Accounts; each
enabled list is mirrored **read-only** (iCloud → Yuvomi) into the Tasks or Shopping module.

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
| name | TEXT | NOT NULL |
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

Index: UNIQUE on `(carddav_account_id, carddav_addressbook_url, carddav_uid)` WHERE `carddav_uid IS NOT NULL`

### Contact Categories (migration v84)
DB-backed, customizable category list for contacts. Replaces the old hardcoded German-named set. The seven predefined keys (`doctor`, `school`, `authority`, `insurance`, `craftsman`, `emergency`, `misc`) carry a stable slug key (which also drives the per-category color tint and, together with `icon`, the list grouping), a localizing `label_key`, and a Lucide `icon`; the pre-existing German category values (`Arzt`, `Behörde`, …) are migrated to these keys. User-added categories store their `name` and default to the `tag` icon. A "Manage categories" button in the contacts toolbar opens the shared `oikos-category-manager` modal to add, rename, reorder, and delete categories, with the same in-use / last-category deletion guards as Tasks and Budget.

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
| value | TEXT | NOT NULL |
| is_primary | INTEGER | 0/1, default 0 |

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
| recurrence_interval | TEXT | `'monthly'` \| `'half_year'` \| `'yearly'`, default `'monthly'` |
| recurrence_virtual | INTEGER | 0/1 — 1 = virtual budgeting (period amount smoothed evenly across months) |
| recurrence_full_amount | REAL | For virtual series: the entered period amount (`amount` then holds the monthly share) |
| recurrence_parent_id | INTEGER | FK → Budget Entries (generated instance points to original) |
| account_id | INTEGER | FK → Budget Accounts, nullable (ON DELETE SET NULL); NULL = not assigned to an account |
| created_by | INTEGER | FK → Users, NOT NULL |
| owner_id | INTEGER | FK → Users, nullable (ON DELETE SET NULL) — the entry's owner, fixed to the creator on insert (migration v88) |
| visibility | TEXT | NOT NULL DEFAULT `shared` — `private` \| `shared` (migration v88) |

Recurring entries generate one instance per month on demand. Non-virtual series post the full amount only on due months (every `monthsPerInterval(interval)` months); **virtual** series store the smoothed monthly share on the original and post it every month, so a 1,200/year bill shows as 100/month in the summary, balance and CSV export. A generated instance inherits its owner and visibility from the series original.

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
Expense and income category list, DB-backed with stable English slug keys. Predefined set (8 expense, 5 income); users can add custom categories inline from the entry modal. A "Manage categories" button in the Budget tab header opens a modal (the reusable `oikos-category-manager` component) to rename, reorder, and delete categories. Deletion is blocked while a category is still referenced by entries (`409`) or when it is the last category of its type.

| Column | Type | Constraint |
|--------|------|-----------|
| key | TEXT | PRIMARY KEY (stable English slug, e.g. `housing`) |
| name | TEXT | NOT NULL |
| type | TEXT | `'expense'` or `'income'` |
| sort_order | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | ISO 8601 |

### Budget Subcategories
Optional subcategories scoped to an expense category. Predefined set (35 entries); users can add custom subcategories inline. Income categories have no subcategories. The "Manage categories" modal also renames, reorders, and deletes subcategories per expense category (with the same in-use and last-subcategory deletion guards).

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
| month | TEXT | YYYY-MM, NOT NULL |
| PRIMARY KEY | | (parent_id, month) |

### Budget Subscriptions
Recurring service and payment records shown in Budget → Subscriptions.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| amount | REAL | Native billing amount, CHECK(>= 0) |
| currency | TEXT | ISO 4217 code, NOT NULL |
| billing_cycle | TEXT | `daily` \| `weekly` \| `monthly` \| `yearly` |
| cycle_interval | INTEGER | Every N cycles, 1–365 |
| next_payment_date | TEXT | DATE, NOT NULL |
| category_id | INTEGER | FK → Subscription Categories (SET NULL) |
| payment_method_id | INTEGER | FK → Subscription Payment Methods (SET NULL) |
| reminder_days | INTEGER | Days before renewal, 0–365 |
| enabled | INTEGER | 0/1; disabled records are retained but excluded from totals and reminders |
| website_url | TEXT | Optional public service URL |
| logo_data | TEXT | Optional local image data URL, max 500 KB |
| brand_color | TEXT | Optional HEX color |
| budget_entry_id | INTEGER | Linked pending Budget expense (SET NULL on delete) |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| owner_id | INTEGER | FK → Users, nullable (ON DELETE SET NULL) — owner, fixed to creator (migration v88) |
| visibility | TEXT | NOT NULL DEFAULT `shared` — `private` \| `shared` (migration v88); the linked Budget expense inherits both |

Supporting tables store customizable/sortable categories and payment methods, the single household subscription budget/base-currency setting, and cached exchange rates. Subscription categories are mirrored under the Budget `Subscription` category, and active renewals use the matching Budget subcategory automatically. Database backup and restore include all subscription data.

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
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| reminder_offset | TEXT | Preset offset key (e.g. "1d", "1w") or "custom"; empty/null = no reminder |
| reminder_custom_amount | INTEGER | Amount for custom offset, nullable |
| reminder_custom_unit | TEXT | Unit for custom offset: "minutes", "hours", "days", "weeks", nullable |

### API Tokens
Named Bearer / X-API-Key tokens for non-interactive external integrations. Admin-only creation and revocation. Token values are SHA-256-hashed at rest; the plaintext is shown only once after creation.

Tokens can optionally be **scoped** to individual modules and access levels — a least-privilege allow-list that matters most for tokens handed to an off-device AI/MCP client. Each scope is `<module>:read` or `<module>:write` (write implies read); modules cover `tasks`, `shopping`, `meals`, `calendar`, `notes`, `contacts`, `budget`, `documents`, `health`, `rewards`, `housekeeping`, `weather`, `family`, `dashboard`, `search`. A `NULL` scopes value means no scoping — full role-based access (the default, and the state of every token created before this feature). A scoped token can only reach modules on its allow-list; every other `/api/v1` path is denied. Enforcement is shared across the REST API and MCP: the MCP core tools are checked in-process, `tools/list` hides tools the token cannot use, and the OpenAPI bridge inherits the same limits because it loops back through the REST layer with the same token.

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
| content_data | TEXT | NOT NULL — raw binary file payload stored as a BLOB for `local`; empty string for `webdav` and `dms`. Binary BLOB since migration v67 (previously Base64 text, ~33 % larger); the column keeps TEXT affinity, and legacy Base64 rows remain readable |
| storage_provider | TEXT | Compatibility field: local (default), external |
| storage_backend | TEXT | Authoritative backend: local (default), webdav, dms (migration v51) |
| storage_key | TEXT | nullable (WebDAV object key or DMS document ID) |
| dms_account_id | INTEGER | FK → DMS Accounts (ON DELETE SET NULL), nullable (migration v50) |
| external_url | TEXT | nullable (deep link to the document in the DMS) |
| external_meta | TEXT | nullable (JSON `{ correspondent, tags }` mirrored from the DMS for display) |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |

`storage_backend` is the authoritative discriminator. Valid compatibility pairs are
`local/local`, `external/webdav`, and `external/dms`; database triggers reject invalid
provider/backend combinations. Existing `external` rows were migrated to `dms`, including
orphaned DMS links. `dms_account_id IS NULL` is never used to identify WebDAV documents.

Preview, download, and DMS/Paperless push read through the shared document-storage layer. Local
bytes come from SQLite, WebDAV bytes are fetched from the configured remote object, and DMS-linked
documents are proxied through their adapter. The per-document visibility check applies before any
content is read.

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

**DMS integration:** Admins connect a DMS instance (Paperless-ngx or Papra), then search it and **link** existing DMS documents into the Documents module as `external`/`dms` references (no duplication of the binary), or **push** a local or WebDAV-backed document into the DMS. Only `storage_backend = 'dms'` means a document is already stored in the DMS. All DMS operations (account management, search, link, push) are **admin-only**; searching the DMS is gated because it would otherwise bypass the per-document `restricted`/`private` visibility boundaries. Linked documents are previewed/downloaded by proxying the DMS live. The adapter layer (`server/services/dms/`) is provider-pluggable; Paperless-ngx and Papra are the two built-in adapters.

### Budget Loans
Instalment-based loans with per-payment tracking. Active loans show remaining balance and due months; paid-off loans are automatically closed.

| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | NOT NULL |
| borrower | TEXT | NOT NULL |
| total_amount | REAL | NOT NULL CHECK(> 0) |
| installment_count | INTEGER | NOT NULL CHECK(> 0) |
| start_month | TEXT | YYYY-MM, NOT NULL |
| notes | TEXT | nullable |
| status | TEXT | 'active' (default) or 'paid' |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| owner_id | INTEGER | FK → Users, nullable (ON DELETE SET NULL) — owner, fixed to creator (migration v88) |
| visibility | TEXT | NOT NULL DEFAULT `shared` — `private` \| `shared` (migration v88) |

### Budget Loan Payments
Individual payment records for a budget loan. Each installment number is unique per loan.

| Column | Type | Constraint |
|--------|------|-----------|
| loan_id | INTEGER | FK → Budget Loans (CASCADE delete), NOT NULL |
| installment_number | INTEGER | NOT NULL CHECK(> 0), UNIQUE per loan |
| amount | REAL | NOT NULL CHECK(> 0) |
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
| amount_minor | INTEGER | NOT NULL CHECK(> 0) |
| currency | TEXT | NOT NULL |
| converted_amount_minor | INTEGER | NOT NULL CHECK(> 0) |
| converted_currency | TEXT | NOT NULL |
| exchange_rate_num | INTEGER | NOT NULL DEFAULT 1 |
| exchange_rate_den | INTEGER | NOT NULL DEFAULT 1 |
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
| proof_document_id | INTEGER | FK → Family Documents (SET NULL on delete), nullable |
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
Tracks which users were created as restricted guests for a split group (migration v40).

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), PRIMARY KEY |
| group_id | INTEGER | FK → Expense Groups (CASCADE delete), nullable |
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
| type | TEXT | NOT NULL — `bp` \| `glucose` \| `weight` \| `pulse` \| `spo2` \| `temp` \| custom slug |
| value_num | REAL | primary value; for `bp` = systolic |
| value_num2 | REAL | `bp` diastolic |
| value_num3 | REAL | `bp` optional pulse |
| unit | TEXT | |
| measured_at | TEXT | NOT NULL |
| note | TEXT | |
| visibility | TEXT | `private` \| `family`, default `private` |
| created_at / updated_at | TEXT | ISO 8601, default now (updated_at via trigger) |

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
(`health_cycle_enabled` preference, default on, Settings → Modules → Health); when disabled the tab
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
- Weather: server-side proxy with two providers — **Open-Meteo** (default, no API key, WMO codes mapped to Lucide icons and translated via `wmo.*` i18n keys) and **OpenWeatherMap** (legacy, via `OPENWEATHER_*`). Provider resolves from DB preferences (Settings → Modules → Overview) first, then env vars. 5-day preview, refresh every 30 min, hide widget on API error
- Upcoming events: next 3–5, color-coded by person; each row navigates to `/calendar?open=<id>&date=YYYY-MM-DD` so the event detail popup opens on the displayed occurrence, including recurring series instances
- Urgent tasks: priority urgent/high + due_date ≤48h
- Today's meals: meals for the current day
- Pinboard preview: 2–3 pinned notes (Markdown formatting rendered)
- Birthdays, Budget (monthly balance/savings-rate), Family members
- Rewards (v0.96.0): family points leaderboard — top 5 enabled participants by ledger balance, the leader row subtly tinted (no medal/emoji), plus a "N to approve" footer when redemptions are pending
- Health (v0.96.0): today's medication doses as a "taken/total" progress bar with the next open dose and a low-stock reorder chip. Only **family-visible** medications are aggregated — private meds never surface on the (possibly shared) dashboard
- Housekeeping (v0.96.0): compact status — currently-present indicator (worker + since-time) or last visit + this-month visit count, plus an outstanding-amount chip
- Cycle (v0.98.0): **owner-only, opt-in** prediction glance — current phase, cycle day in a mini progress ring, and the next period as a countdown + date. Unlike the family-visible widgets, cycle data is **never aggregated into the shared `/dashboard` payload**: the tile fetches the signed-in user's own `/health/cycle` data client-side, and only when the tile is enabled. Default-hidden, offered as an opt-in in Customize; hidden when the Health module is disabled
- FAB (quick actions): + Task, + Event, + Shopping list item, + Note

The three newer modules (Rewards, Health, Housekeeping) start **hidden** by default — they are specialised and not active in every household, so they are offered as opt-ins in **Customize** rather than adding empty tiles to a fresh dashboard. Existing saved layouts are untouched.

**Widget sizes:** each widget has a configurable size using named presets (Tiny, Narrow, Tall, Standard, Large, Full) that map to `columns × rows` in the CSS grid. List widgets (tasks, calendar) default to the tall/narrow **Tall** (1×2) preset so a short list keeps useful height without occupying a full two-column row. Sizes are persisted in user preferences and survive page reloads.

Skeleton loading instead of spinners (the skeleton mirrors the default-visible widgets at their correct grid-spanning sizes to prevent layout shift). Clicking any widget navigates to that module.

### Tasks (`/tasks`)

**Views:**
- List view (default): grouped by category or due date (toggleable), filter: person, priority, status
- Kanban: columns Open → In Progress → Done, drag & drop
- View mode persisted in localStorage; URL parameter `?view=kanban` overrides (useful for tablet kiosk setups)

**Features:**
- CRUD + subtasks (max 2 levels, checkbox list, progress bar)
- **Multi-person assignment:** tasks can be assigned to multiple family members simultaneously via `UserMultiSelect` checkbox dropdown; stacked avatar circles (up to 3 visible + `+N` overflow badge) shown on task cards and Kanban — each circle shows the member's profile photo if set, otherwise coloured initials
- Priorities shown visually via color/icon
- Recurring: automatically create next instance on completion
- Archive: completed tasks can be archived (status = 'archived'); visible in a separate Archived filter
- Inline reminder presets: offset from due date/time — 15 min, 1 h, 1 d, 2 d, 1 w, 2 w, or fully custom offset
- **Bulk actions (list view only):** select multiple tasks via checkboxes and apply batch operations (mark done, mark open, archive, delete); bulk select toggle in toolbar
- **Start date:** tasks can have an optional start date; tasks with a future start date are hidden from the default list view to reduce cognitive load. A "Show scheduled" toggle chip in the filter bar reveals all upcoming planned tasks. Task cards display a "Starts on …" badge when a start date is set.
- **"Assigned to me" quick filter:** a toggle chip in the filter bar limits the list to tasks assigned to the current user (a shortcut for the person filter); the choice is remembered per device. Shown only in multi-member households.
- **Per-task visibility:** an "all / assignees only / private" selector in the task dialog controls who can see the task (server-enforced, no admin bypass — see [Tasks data model](#tasks)); restricted tasks carry a lock/people icon in the list.
- **Customizable categories:** a "Manage categories" action in the toolbar opens the shared `oikos-category-manager` modal to add, rename, reorder, and delete task categories (predefined set localized, custom categories added inline). Deletion is blocked while a category is in use or when it is the last one — see [Task Categories data model](#task-categories-migration-v83).
- **Linked documents:** documents from the Documents module can be optionally linked to a task from the task dialog, so supporting information (manuals, policies, service instructions) is reachable directly from the task. Linked documents appear as chips that open the document preview/download; a paperclip badge with the count shows on the task card. Only documents the user may see are listed or linkable (document visibility enforced, no admin bypass) — see [Task Documents data model](#task-documents-migration-v86).
- **Responsive toolbar:** secondary controls collapse into a single overflow trigger through phone and tablet widths (≤ 1023px); bulk actions remain hidden until at least one task is selected. Checkbox and row actions use the shared touch-target tokens.
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
- **Category management lives in Shopping** (no longer in Settings): a "Manage categories" action opens the `oikos-shopping-category-manager` component (also reachable directly via `/shopping?manage=categories`) for add, rename, reorder, and delete, preserving the API's last-category-deletion guard. The legacy Settings → Shopping tab redirects here.
- Mobile quick-add form uses a resilient grid: item name spans the row, quantity/category/add controls remain touch-safe at 390px width, and autocomplete stays anchored to the input.
- Mobile swipe: left = check/uncheck, right = delete; × delete button hidden on mobile (swipe takes over)

### Meal Plan (`/meals`)

**Desktop:** full weekly grid (Mon–Sun), slots: breakfast / lunch / dinner / snack. **Mobile:** the same full week (Mon–Sun) stacked vertically and scrollable, auto-scrolled to today on open.

- Meal: title + notes + ingredient list
- "→ Shopping list" button: transfer unchecked ingredients of the week to a selected list
- Week navigation forward/back
- Drag & drop between days/slots
- **Recipe sidebar with drag & drop (v1.3.0):** a desktop recipe sidebar lists saved recipes; drag one onto any day/slot to plan it directly, with the recipe's title, notes, URL, and ingredients pre-filled. Slots only accept recipes whose `meal_types` suitability includes that slot. The existing per-slot `+`/add-button flow remains as the keyboard/touch path.
- **Week plan randomizer (v1.3.0):** a "Randomize plan" action fills the visible week's empty (or, opt-in, all) slots with randomly chosen suitable recipes, respecting each recipe's `meal_types` and the household's visible meal types. Reports how many meals were planned; no-op with a notice when the week is already full or no compatible recipes exist.
- Autocomplete from meal history
- **Multiple items per slot:** each day/meal-type cell can hold any number of meals, displayed as stacked cards with a separator. A hover-visible `+` button lets you add another item to an already-filled slot without clearing the existing entry. (v0.63.3)
- **Recipe integration:** Select a saved recipe from the meal modal to auto-fill title, notes, URL, and ingredients. Scale ingredient quantities by a numeric factor. Save the current meal as a new recipe with one click.
- **Weekly meal repeats:** New meals can be marked as weekly repeats from the advanced meal dialog. Yuvomi stores a recurrence template, materializes future occurrences for each loaded week, shows a repeat badge on generated meals, and records per-date skip exceptions when a single occurrence is deleted. Editing or deleting a recurring meal offers a scope choice — **this date only** or the **whole series**: series edits propagate the content fields and ingredients to the template and every materialized occurrence, while series deletion removes the template together with all of its occurrences. (v0.78.1, series scope v1.1.0)
- **Customizable meal visibility:** In Settings, users can toggle which meal types (breakfast, lunch, dinner, snack) are shown in the planner and the dashboard's Today Meals widget. Stored as household-wide preference in `sync_config` (key: `visible_meal_types`). At least one type must remain active.

### Recipes (`/recipes`)

Reusable recipe cards linked to meal slots.

- CRUD: title, notes, recipe link, per-ingredient category
- **Meal-type suitability (v1.3.0):** each recipe carries a `meal_types` list (breakfast / lunch / dinner / snack, all selected by default) chosen via checkboxes in the recipe editor. It gates which planner slots accept the recipe (sidebar drag & drop) and scopes the week randomizer's candidate pool.
- Duplicate existing recipes
- "Add to meal plan" navigates to `/meals` with the selected recipe pre-filled in the modal
- REST API: `GET/POST /api/v1/recipes`, `PUT/DELETE /api/v1/recipes/:id` with ingredient sync (`meal_types` included)

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
- **Google Calendar:** OAuth 2.0, Calendar API v3, two-way sync of **multiple calendars** at once. After connecting, an admin enables/disables each available calendar via checkboxes in Settings (state in `google_calendar_selection`); enabled calendars are imported together, each in its own color, with its own incremental sync token. Disabling a calendar removes its imported events and clears its token (clean resync on re-enable). Outbound is **per-event**: a local event is only pushed to Google when it carries an explicit target calendar (`calendar_events.target_google_calendar_id`), chosen via the unified sync-target picker in the event dialog; events without a target stay local. The sync-target picker lists only **writable** Google calendars (accessRole `owner` or `writer`); read-only calendars (accessRole `reader` / `freeBusyReader`) are excluded from the picker. The server-side outbound sync additionally guards against writing to a calendar that has lost write permission after the event was created. A **read-only mode** checkbox prevents Yuvomi from pushing any local events back to Google while still reading incoming events normally; the flag is stored as `google_readonly` in `sync_config` and cleared on disconnect.
- **CalDAV Multi-Account:** Connect multiple CalDAV servers (iCloud, Nextcloud, Radicale, Baikal) with per-account calendar selection via checkboxes, two-way sync (tsdav), optional outbound target selection per event
- **Default assignee per sync target (migration v79):** each synced calendar (Google/CalDAV) and each ICS subscription can be given an optional default assignee in Settings → Sync; newly imported events of that target are auto-assigned to that person (new events only — see [External Calendars](#external-calendars)). The per-calendar picker appears once the calendar has completed its first sync
- **ICS Subscriptions:** Subscribe to any public ICS/webcal URL (e.g. public holidays, sports schedules). Per-subscription color, private/shared visibility, manual "Sync now" and automatic sync on the shared interval. Edit name, color, and visibility of any subscription inline. RRULE events expanded into a rolling ±6/+12 month window. SSRF-protected (DNS pre-resolution), ETag/Last-Modified conditional fetch, 10 MB limit, 15 s timeout. User-edited events are protected from being overwritten (`user_modified`); a "Reset to original" link restores them.
- **One-time import (Discussion #437):** Settings → Sync → Calendar → "Kalender importieren" imports events from an uploaded `.ics` file or a shared calendar feed URL as **editable local events** (`external_source='local'`, no subscription) — the migration path when moving from another calendar. Unlike a subscription the events are owned by the importing user and never auto-synced; recurring events are kept as a series (RRULE reduced to the locally supported FREQ/INTERVAL/BYDAY/UNTIL subset), and the source UID is stored in `external_calendar_id` to skip duplicate re-imports of the same feed. The URL path reuses the subscription fetch (SSRF-protected, 10 MB / 15 s limits); `POST /api/v1/calendar/import` returns `{ imported, skipped, total }`.
- **Read-only export feed (Discussion #387):** Settings → Calendar → "Kalender-Feed exportieren" exposes the user's own visible events (own events, assigned events, and shared/own ICS subscriptions) as a `webcal://`/`https://` ICS feed for subscribing in Apple Calendar, Google Calendar, Thunderbird, etc. Backed by a per-user secret token (`users.calendar_feed_token`); enabling generates the token, "Neuen Link erzeugen" rotates it (invalidating the old URL), "Feed deaktivieren" clears it. The feed itself is served by a public, unauthenticated `GET /feed/calendar/:token.ics` route outside `/api/v1` (no session/CSRF — the token in the URL is the secret), rate-limited to 30 requests/minute per IP, recomputed on every request (no caching). The feed URL uses `BASE_URL` when set, falling back to the request's protocol/host. Token management (`GET/POST regenerate/DELETE /api/v1/calendar/feed`) requires authentication. An opt-in toggle "Zugewiesene Personen im Titel anzeigen" (default off, persisted in `users.calendar_feed_show_assignees` via `PUT /api/v1/calendar/feed`, Discussion #482) appends the assigned members to each event's title in the feed, e.g. `Poolparty (Mama, Papa)` — names are ordered alphabetically and RFC-5545-escaped. Existing subscribers' titles stay unchanged until enabled.
- **External calendar names & colors:** Google and Apple sync stores each calendar's display name and background color in the `external_calendars` table (migration v14). A colored `event-cal-label` badge appears in event popups, agenda, month, week, and day views when `cal_name` is present.
- **Event color sync (Discussion #427):** Each provider preserves per-event colors, not just the calendar color. Inbound, Google's `colorId` is resolved to a hex value via the event color palette (`colors.get`, cached 24 h), and the iCalendar `COLOR` property (RFC 7986 — CSS3 name or hex) is read for CalDAV, Apple, and ICS subscriptions; an event without its own color inherits its calendar's color. Outbound to Google, a local event's hex color is mapped to the nearest of Google's 11 event `colorId`s (perceptual redmean distance). Locally recolored events are protected across syncs by the unified `user_modified` flag: a resync overwrites an event's color only while `user_modified = 0`, so remote color changes still flow in until the user picks their own color, after which it stays fixed. The `COLOR`↔hex mapping lives in `server/utils/ical-color.js`.
- **Event location:** Event popup and dashboard display the location field with RFC 5545 backslash-escape normalization (`\n`, `\,`, `\;`, `\\`) via `fmtLocation()` in `public/utils/html.js`.
- **Custom event icons:** Each event can have an icon chosen from 102 validated Lucide icons via a visual picker. Birthday events are automatically assigned the `cake` icon. Icon stored in `calendar_events.icon`.
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
- Full-text search: client-side filter bar, filters instantly by title + content, with a clear (×) control

### Contacts (`/contacts`)

- CRUD with category filter
- **Customizable categories:** a "Manage categories" button in the toolbar opens the shared `oikos-category-manager` modal to add, rename, reorder, and delete contact categories (predefined set localized with per-category icons and color tints, custom categories added inline). Deletion is blocked while a category is in use or when it is the last one — see [Contact Categories data model](#contact-categories-migration-v84)
- **Multi-value fields:** multiple phones, emails, and addresses per contact, each with a label (mobile, work, home, etc.) and optional `isPrimary` flag
- **Additional fields:** organization, job_title, birthday, website, photo, nickname
- Phone: `tel:` link, email: `mailto:` link
- Address: Maps link (vendor-neutral OpenStreetMap search)
- Real-time search filter; screen-reader live-region announces the result count
- **Keyboard shortcuts:** `/` focuses search, `n` creates a contact (disabled while a modal is open or while typing in a field)
- **Bulk selection (opt-in):** a toolbar toggle enters selection mode — rows become checkboxes with select-all and batch delete (5-second undo). Family-linked contacts (`family_user_id`) are not selectable, since they can only be removed via their member profile
- Rows are keyboard/screen-reader operable (each row is a focusable button); the mobile secondary-action menu uses the native Popover API (top-layer, no clipping)
- vCard export: each contact downloadable as `.vcf` (`GET /api/v1/contacts/:id/vcard`)
- vCard import: upload file → client-side parser (FN, TEL, EMAIL, ADR, NOTE, CATEGORIES) → create contact
- **CardDAV multi-account sync:** connect multiple CardDAV servers (Nextcloud, iCloud, Radicale, Baikal); per-addressbook enable/disable via checkboxes; manual sync trigger; bidirectional sync. New API routes under `/api/v1/contacts/cardav/*`: create/delete accounts, test connections, discover/refresh addressbooks, toggle addressbook selection, sync contacts

### Documents (`/documents`)

Upload and manage family files with per-document access control.

- CRUD: name, description, category, file upload (PDF, images, text, Office documents; ≤ 5 MB)
- Drag-and-drop upload in the new-document modal
- **Folder browser:** documents can be organized into custom folders; a sidebar lists all folders plus "Alle Ordner" and "Kein Ordner". Custom folders can be created, renamed, and deleted (via a per-folder overflow menu); deleting a folder keeps its documents (their folder link is cleared). New uploads are pre-assigned to the currently selected folder. A "Hausreinigung" folder is auto-created when the first housekeeping worker is added
- **Grid / list view** toggle; view mode persisted in localStorage
- **Responsive toolbar:** at tablet widths (768–1023px), the search field moves to a full-width second row so the page title, filters, and view controls remain readable.
- **Category tags:** 14 predefined categories (medical, school, identity, insurance, finance, home, vehicle, legal, travel, pets, warranty, taxes, work, other)
- **Visibility:** family (all members see it), restricted (only selected members), private (only the uploader)
- **Archive / restore** — archived documents hidden from the main view, accessible via the Archive filter
- **Download** — original file downloaded with its original filename
- **Storage backends (v0.70.0):** an admin can select WebDAV as the global destination for all new document files, including calendar attachments. Existing local files are not migrated. WebDAV upload failures reject the upload without a silent local fallback; a failed database write after a successful remote upload triggers compensating deletion. Disabling WebDAV affects only future uploads, while existing WebDAV files remain readable and deletable.
- **Local folder backend (env-only):** setting `DOCUMENT_STORAGE_LOCAL_ENABLED=true` writes new document binaries to `DOCUMENT_STORAGE_LOCAL_PATH` (default `/documents`, a host mount) as `storage_backend='local'` rows with a relative `storage_key`, instead of the in-DB BLOB. It is resolved from the environment on each upload and takes precedence over WebDAV. Legacy `local` rows without a `storage_key` continue to read from the DB BLOB. Writes fail loudly on an unwritable mount (no silent fallback); the storage key is path-traversal-validated and reads are bounded by the same 5 MB limit as other backends.
- **Shared content access:** preview, download, calendar attachment access, and Paperless/DMS push use the same storage layer. Backend badges distinguish local, WebDAV, DMS, and orphaned/unavailable DMS entries.
- API: `GET /api/v1/documents`, `POST /api/v1/documents`, `GET /api/v1/documents/:id`, `PUT /api/v1/documents/:id`, `DELETE /api/v1/documents/:id`, `GET /api/v1/documents/:id/download`

### Housekeeping (`/housekeeping`)

Module for managing household staff workflows. Navigation uses violet accent theming.

- **Staff profiles:** each worker is linked to a user account; configurable billing model (daily flat rate or hourly), payment schedule (daily / twice monthly / monthly), calendar color, and notes; staff accounts are hidden from task assignment, dashboard member avatars, and the family contact list — their birthdays remain visible in the calendar and birthday list; staff accounts cannot log in to the app (login blocked at authentication layer)
- **Work sessions:** check-in/check-out with timestamps; open sessions shown prominently; automatic local calendar event created on check-in; optional payment task created on check-in (toggle in Settings → Modules → Housekeeping)
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
- **Vitals:** capture blood pressure (sys/dia/pulse), glucose, weight, pulse, optional SpO₂/temperature; per-metric cards with last value + delta; native SVG trend charts with selectable range.
- **Medications:** medication list (name, dose, form, active/PRN), schedule editor (time slots + weekday mask + dose), "due today" view with take/skip, 7-day adherence bar, and stock/refill warnings. Reminders are delivered through the existing push/notification-channel layer (`server/services/medication-scheduler.js`) — no separate reminder table.
- **Labs:** reports with multiple analytes (value, unit, reference low/high); `low`/`normal`/`high` flag derived from value + range and colour-coded via tokens; per-analyte trend chart with a reference band; neutral medical disclaimer.
- **Activity:** training log (preset or custom type, duration, optional distance/intensity/calories, note); weekly summary cards and a native SVG bar chart per weekday.
- **Cycle:** menstrual cycle tracking. Period episodes (start/end + flow), per-day logs (flow intensity, symptoms, mood), and calendar-method predictions of the next period, ovulation, and fertile window (luteal length, cycle/period averages derived from history or overridden in settings). A native **SVG cycle-ring** shows the current phase, cycle day, and countdown; a month calendar colour-codes logged and predicted periods, the fertile window, and ovulation; plus prediction stat cards, a period history, and CSV export. A **pregnancy mode** (migration 82) in the cycle settings pauses all predictions (next period, ovulation, fertile window, ring, and calendar projection); with an optional estimated due date it instead shows the gestational week (Naegele rule, 280 days), trimester, countdown, and a progress bar, while daily logging stays available. Cycle data defaults to `private`; the fertile window carries a clear disclaimer that it is not contraception and no substitute for medical advice. Cycle data is deliberately kept out of global search; the only dashboard surface is an **opt-in, owner-only tile** (v0.98.0) that shows the signed-in user's own next-period countdown and current phase — it is never added to the shared dashboard payload. The calendar distinguishes phases with **non-colour cues** (solid fill, diagonal hatch, ringed day, outline) as well as colour, so it stays legible with colour-vision deficiency.
- **Overview:** aggregated landing view — due-today medications with inline take/skip, latest vitals cards (deep-link to the Vitals tab), adherence rate + streak, quick-capture buttons, upcoming reminders, and a **CSV export** bar (one download per area — vitals, activities, labs, medication logs — with optional date range).
- **Search & shortcuts:** medications and activities appear in global search (FTS5) with the same visibility scoping and deep-link to the Meds/Activity tab; the `g h` keyboard shortcut jumps to the last-visited Health tab.
- **Accessibility:** sub-tab bar and person/range chip rows expose `role="tablist"`/`tab` with arrow-key navigation and roving tabindex; SVG charts carry `role="img"` + `aria-label`; take/skip/save actions announce via the polite/assertive live regions; modals trap focus and restore it on close.
- **API:** `GET/POST/PATCH/DELETE /api/v1/health/{vitals,medications,labs,activities}` (+ nested `…/medications/:id/schedules|logs`, `…/logs/:id/take|skip`, lab results), cycle endpoints `…/cycle/periods`, `…/cycle/logs` (upsert per day), `GET/PUT …/cycle/settings`, and `GET /api/v1/health/export/{vitals,activities,labs,meds-logs,cycle}` (text/csv). All handlers apply `user_id` scoping and `visibility` filtering.

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
- **SSO / OpenID Connect (v0.55.14):** When OIDC is configured (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`), a "Sign in with SSO" button appears below the divider. Clicking it initiates an Authorization Code flow with PKCE (S256) and a nonce; state, nonce, and code verifier are stored in the session and consumed once. On successful callback, the user is matched by `oidc_sub`. With no `sub` match, an existing local account is linked **only when the provider reports `email_verified: true` and exactly one account holds that email** (matched against `contacts.email` / `contact_emails.value`, case-insensitive); unverified or ambiguous emails never link, and a new account is provisioned instead. SSO errors display a localized message. Providers that omit the `email_verified` claim entirely are supported via the opt-in `OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM=true` env var (v0.71.11).
- **Failed-login logging (v0.55.15):** Failed attempts are logged as warnings with IP, username, and failure reason (`user_not_found` / `invalid_password`), enabling fail2ban / CrowdSec integration.
- **Forgot password (v0.71.51):** A "Forgot password?" link opens `/forgot-password`. The link is only shown when the server can actually deliver a reset mail: the public `GET /api/v1/version` response carries a `password_reset_enabled` flag (true when SMTP is configured **and** `BASE_URL` is set) and the login page gates the link on it, so it is never a dead end. On the reset page, entering a username or email always returns a generic "if an account exists…" response (anti-enumeration), regardless of whether the identifier matched a user or whether SMTP is configured. When it does match and the user has a linked email (`contacts.email`), a reset link `${BASE_URL}/reset-password?token=…` is emailed; the token is single-use and expires after 1 hour. `/reset-password` reads the token from the query string and sets a new password (min. 8 characters); on success, the token is consumed and other sessions for that user are invalidated. Requires an admin-configured SMTP server (Settings → Administration → Email) and the `BASE_URL` env var — reset links are only sent when `BASE_URL` is set, since the request `Host` header is never trusted for this purpose (prevents reset-link poisoning). API: `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password` (both public, rate-limited).
- After successful login: redirect to dashboard

### Settings (`/settings`)

User management and app configuration. Logged-in users only.

- **Profile:** change display name, avatar color, password
- **User management (admin):** create new users, edit/delete existing users, assign roles (admin/member)
- **Roles and permissions (admin, Settings → Administration → Roles and permissions, #467):** granular, backend-enforced access control per **family role** (the default) and per **member** (an override that wins over the role). Each module is set to `No access`, `Read only`, or `Full`, and each dashboard widget to `Available` or `Blocked`; widgets inherit their module's lock and can also be blocked on their own (e.g. hiding the cycle widget for some members without disabling Health). Configuration is **sparse** — only deviations from the default (full access) are stored, so unset roles/members keep full access and existing installs are unchanged. **Admins always bypass** the system (no self-lockout). Enforcement is **server-side** — the same scope layer that guards API tokens returns 403 on a disallowed module/method; the client mirrors it by hiding blocked modules from navigation and the dashboard, and a **read-only module** hides its create affordance (the FAB) and shows an explanatory banner. Stored in `access_permissions`. The settings page shows a role/member switch, a deviation overview, and per-module/-widget access as icon controls with widgets nested under their module. API: `GET /api/v1/permissions/catalog`, `GET/PUT /api/v1/permissions/role/:familyRole`, `GET/PUT /api/v1/permissions/user/:userId` (admin-only); the resolved permission map also ships on `GET /api/v1/auth/me`.
- **Navigation and module controls (admin, Settings → Modules → Navigation):** individual modules (Tasks, Calendar, Shopping, Meals, Recipes, Birthdays, Notes, Contacts, Budget, Documents, Housekeeping) can be disabled to hide them from navigation. Data is preserved and reappears when re-enabled. Dashboard and Settings remain essential and cannot be disabled. Stored as `disabled_modules` in `sync_config`. **Kitchen grouping:** Meals, Recipes, and Shopping are presented as one global **Kitchen** destination with three individually toggleable children; local pages keep their individual routes. The web navigation is grouped into Overview, Plan, Home, and Custom modules, and `module_order:user:<id>` only changes order inside each group; Dashboard and Settings stay pinned. The Custom modules group is shown only when enabled third-party modules are loaded. The mobile bottom bar has five stable slots — Overview, three configurable favorites, and More. Favorites default to Calendar, Tasks, and Kitchen, are stored per user as `mobile_nav_order:user:<id>`, and automatically fall back to enabled destinations when a selected module becomes unavailable.
- **Housekeeping (admin):** toggle for automatic payment task creation on work session check-in.
- **Synchronization (Settings → Sync):** organized by data type into three dedicated pages — Calendar, Contacts, and Reminders — each opening with a status summary before any setup forms:
  - **Calendar sync (`/settings/sync/calendar`):** CalDAV accounts and Webcal/ICS subscriptions are primary. Manage multiple CalDAV accounts (iCloud, Nextcloud, Radicale, Baikal) with per-account calendar selection via checkboxes, two-way sync, and a unified per-event sync-target picker; manage ICS URL subscriptions (add, delete, sync now, set color and visibility); configure sync interval. Google Calendar (OAuth 2.0, multi-calendar selection, read-only mode) and Apple/iCloud CalDAV live inside an accessible **"More providers"** disclosure that always shows current connection state; Apple carries a **legacy** badge directing new iCloud users to the generic CalDAV setup. OAuth callbacks (`sync_ok` / `sync_error`) render a localized banner, expand the matching provider disclosure, and are then stripped from the URL.
  - **Contact sync (`/settings/sync/contacts`):** manage multiple CardDAV accounts (iCloud, Nextcloud, Radicale, Baikal); per-addressbook enable/disable; manual sync trigger; per-account last-sync and latest-error text; real-time status badges (success, error, syncing with animated spinner)
  - **Reminder sync (`/settings/sync/reminders`):** reuses the CalDAV accounts but exposes only reminder/task collections — per-list enablement, refresh, target mapping to Tasks or Shopping, and a read-only explanation; calendar collections do not appear here
- **Weather:** Settings → Modules → Overview configures the household default Open-Meteo location (latitude/longitude, optional city label, units; no API key) — admin only; saving activates Open-Meteo and supersedes any OpenWeatherMap `.env` configuration. A **"Detect location"** button uses the browser's Geolocation API to auto-fill latitude and longitude (no reverse-geocoding — the optional city field stays whatever was last typed, or the widget falls back to showing raw coordinates). **Automatic location updates:** an opt-in checkbox re-requests the browser's location every 30 minutes while the dashboard is open, silently updating the saved coordinates (and clearing any stale city label) so a moved device's weather stays current without a manual re-detect; skipped silently on permission denial or once the dashboard is closed. **Per-user override (Settings → Personal → My Weather, all users):** any user — not just admins — can set their own latitude/longitude/city/units and their own automatic-location-updates toggle; this personal location is stored separately from the household default and only affects that user's own dashboard widget. A status indicator shows whether a personal location or the household default is currently active, and a **"Use household default"** action clears the override. When a user has no personal override, the household admin's location is used as before.
- **Language:** System (follows `navigator.language`), German, English, Spanish, French, Italian, Swedish, Greek, Russian, Turkish, Chinese, Japanese, Arabic, Hindi, Portuguese, Ukrainian, Polish, Dutch, Czech, Vietnamese, Hungarian - via `oikos-locale-picker` web component; switch without page reload
- **API Tokens (admin):** create named Bearer / X-API-Key tokens for external integrations; the full token value is shown only once immediately after creation; tokens can be revoked at any time; support optional expiry and track last-used timestamp; **optional per-module scopes** (`<module>:read`/`<module>:write`, write implies read) restrict a token — e.g. an MCP token that may write the calendar but never read health data — while an unscoped token keeps full role-based access
- **Documents (admin):** separate WebDAV Storage and DMS/Paperless cards show the active upload target, effective destination, stored WebDAV document count, and latest connection test. WebDAV connection fields use per-field hybrid configuration: each non-empty `DOCUMENT_STORAGE_WEBDAV_*` environment value overrides only its matching database field and is read-only in the UI. UI-managed WebDAV URLs must resolve exclusively to public addresses; private, loopback, link-local, internal-DNS, and DNS-rebinding targets are blocked at configuration time and again during socket lookup. Trusted private-network targets require the deployment-controlled `DOCUMENT_STORAGE_WEBDAV_URL` override. When WebDAV documents exist, URL, username, password, and base-path changes require explicit confirmation plus a successful read test against an existing object; required connection data cannot be removed. The connection test performs a temporary PUT/GET/DELETE roundtrip.
- **Backup Management (admin):** download the current database as a file (`GET /api/v1/backup/database`) or restore from a backup file (`POST /api/v1/backup/restore`, drag-and-drop supported). Validates that the uploaded file is a valid Yuvomi database. A rollback copy is created automatically before restore. **Automatic scheduled backups:** configurable via `.env` (`BACKUP_ENABLED`, `BACKUP_SCHEDULE`, `BACKUP_DIR`, `BACKUP_KEEP`); default 2 AM daily, keeps last 7 copies; Settings → Administration → Backup and restore shows scheduler status, schedule, retention policy, last backup timestamp, and a manual trigger button. **WebDAV backup target:** optional upload of each backup to a WebDAV server (Nextcloud, ownCloud, Hetzner Storage Box, etc.) after each local backup; configurable via Settings → Administration → Backup and restore or env vars (`WEBDAV_BACKUP_ENABLED`, `WEBDAV_BACKUP_URL`, `WEBDAV_BACKUP_USERNAME`, `WEBDAV_BACKUP_PASSWORD`, `WEBDAV_BACKUP_PATH`, `WEBDAV_BACKUP_KEEP`); uses Node 22 native fetch, no extra dependencies; password is masked in the UI and API; upload failures are non-fatal (local backup is always retained).
- **Backup boundary:** SQLite/database backups include WebDAV document metadata and storage keys, but never the remote WebDAV binaries. The document-storage WebDAV target must be backed up separately and restored together with the matching database.
- **Email / SMTP (admin, v0.71.51):** Settings → Administration → Email configures an outgoing SMTP server (host, port, `ssl`/`starttls`/`none`, user, password, from-address, from-name) that powers the self-service "Forgot password" flow. Each field follows the same per-field hybrid pattern as other integrations: a non-empty `EMAIL_SMTP_*` / `EMAIL_FROM_*` env var overrides its matching `sync_config` field and the field becomes read-only in the UI. The password is write-only — `GET /api/v1/email/config` never returns it, only a `passwordSet` boolean. A **"Test connection"** button (`POST /api/v1/email/test`, admin-only) verifies the SMTP connection and sends a probe email to the requesting admin's own linked address (or an explicit override). API: `GET/PUT /api/v1/email/config`, `POST /api/v1/email/test`.
- **Information architecture:** Settings is organized into five role-aware domains, each with dedicated leaf pages addressed by stable routes under `/settings/<domain>/<page>`:
  - **Personal** (all users): Account, Appearance, This device, My Weather
  - **Modules** (admin): Navigation, Kitchen, Calendar, Budget, Housekeeping, Overview
  - **Sync** (admin): Calendar sync, Contact sync, Reminder sync
  - **Documents** (admin): Document storage, Document management (DMS)
  - **Administration** (admin): Family and roles, Roles and permissions, API access, Backup and restore, Email (SMTP), System

  A central registry (`public/settings/registry.js`) is the single source of truth for domains, routes, roles, labels, icons, and legacy-tab mappings; each leaf is **lazy-loaded** and owns only its own API domain. Members see only Personal; deep links to admin pages redirect to Personal → Account with a localized notice. The shared responsive shell (`public/settings/shell.js`) renders a **sticky local navigation column** on desktop (≥ 1024px, with `aria-current="page"` and a focus-managed page heading) and a **history-aware drill-down** below 1024px (settings overview → domain overview → leaf, with breadcrumbs and Back traversal). Tablet overview pages use two columns from 768–1023px instead of leaving half the content area empty. Each leaf catches its own load/save errors with inline retry without dropping sibling sections. Legacy `oikos:settings:tab` values migrate once to the new paths; the former flat tab bar and `settings-nav.js`/`settings-nav.css` are removed.
- **Family management (admin):** assign a `family_role` (Dad, Mom, Parent, Child, Grandparent, Relative, Other) to each user, and set per-member phone, email, and birthday — automatically synced to Contacts and Birthdays. Displayed in the family member list and profile views. The Edit member dialog has an optional "Reset password" field (min. 8 characters, left blank keeps the current password) so an admin can set a new password for a family member who forgot theirs or never got it working — no SMTP/`BASE_URL` setup required, unlike the self-service "Forgot password" flow. On change, all of that member's other sessions are invalidated. `PATCH /api/v1/auth/users/:id` (admin-only) accepts an optional `password` field.
- **Profile picture:** users can upload a personal avatar (PNG/JPEG/WebP, ≤ 5 MB), stored as a Base64 JPEG data URL in `avatar_data` at 256 × 256 px. After selecting a file a **canvas crop dialog** opens: the user can drag the image and zoom (slider or mouse wheel) to choose the square crop region before confirming. Shown in all avatar circles throughout the app — task cards, calendar agenda, user assignment picker, dashboard task widget, dashboard calendar widget, and notes creator badge — with coloured initials as fallback when no photo is set. Housekeeping staff avatars use the same crop dialog.
- **App info:** version, license
- **In-app changelog (v1.3.0):** a Help-adjacent "Changelog" action (available to every logged-in user) opens a modal with the release history. The browser calls Yuvomi's own backend (`GET /api/v1/changelog`), which fetches the GitHub Releases of `ulsklyc/yuvomi` on demand, reduces each release body to plain text, and caches the result in memory for 30 minutes (no scheduler, no polling). The modal shows the installed version alongside the latest available release and highlights the installed version when it appears in the list; if GitHub is unreachable it degrades to a cached/error state (air-gapped installs simply see "could not be loaded"). Rendered entirely via DOM text nodes — no external content is injected as HTML.

### Budget (`/budget`)

**Tabs:** Budget, Accounts, Plan, Statistics, Subscriptions, Loans, Split Expenses.

**Views:**
- Monthly overview: income vs. expenses, balance, bar chart by category (Canvas, no library)
- Transaction list: chronological, filterable

- CRUD: title, amount, category, subcategory, date
- Categories: DB-backed with stable English slug keys; 8 predefined expense categories, 5 income categories; users can add custom categories inline from the entry modal
- Subcategories: 35 predefined subcategories across expense categories; users can add custom subcategories inline; displayed alongside category in each entry's metadata line
- Recurring entries
- **Personal vs. shared budgets (#476/#505):** an admin can switch the household into *personal budget mode* (Settings → Modules → Budget). Each entry, loan and subscription then carries an owner (the creator) and a visibility (`private`/`shared`); the entry modal gains a "Share with the household" toggle (default private), shared rows show a "Household" badge, and a **My budget / Household** view switcher appears in the toolbar. Enforcement is server-side on every read path with no admin bypass; see the [Budget Entries](#budget-entries) data model for the full rule. In the default shared mode nothing changes.
- Monthly comparison (current vs. previous month)
- CSV export includes a subcategory column and English column headers; the same endpoint accepts an arbitrary date range via `?from=YYYY-MM-DD&to=YYYY-MM-DD` (used by the Statistics tab's export button) in addition to the legacy `?month=YYYY-MM`
- **Category bar chart accessibility:** the chart exposes a concise `.sr-only` summary (number of categories, largest category and its share) for assistive technologies (v0.55.0)
- **Statistics tab:** dedicated range view (week, month, year) with a period stepper, summary cards for income/expense/balance plus comparison against the previous period, an SVG trend chart of income vs. expenses, category bars, an expense-share donut, and a CSV-export button for the active range. Backed by `GET /api/v1/budget/stats?range=week|month|year&anchor=YYYY-MM-DD`.
- **Plan tab:** planned/estimated budget (Discussion #468). A monthly savings-goal card (progress ring, planned vs. net balance, on-track/reached/negative status) plus per-category budgets shown as planned-vs-actual progress bars (under/near/over-budget tone, each backed by a text label so meaning never depends on colour alone). Set/edit/delete via modal (destructive delete is confirmation-gated). Month-bound via the shared Budget month navigation. Backed by `GET /api/v1/budget/plans?month=YYYY-MM` and `PUT`/`DELETE /api/v1/budget/plans/:category`. Implications elsewhere: the Statistics tab draws a category target marker at the planned amount (month range only), and the dashboard Budget widget shows savings-goal progress when a goal is set.
- **Accounts tab:** separate accounts (checking, savings, cash, credit card, investment, other), each with a starting balance and an optional accent color. The tab lists every account with its running current balance (starting balance + assigned entries up to today) and the household net worth. **Drill-down:** clicking an account row switches to the Budget tab filtered to that account (a chip clears the filter); a separate pencil icon opens the edit modal. **Archiving:** accounts can be archived from the edit modal — archived accounts are hidden by default (a "show archived" toggle reveals them with a badge) and excluded from net worth, without deleting their history. Entries optionally reference an account from the entry modal, and each transaction shows its account in the metadata line. Deleting an account keeps its entries (their `account_id` is cleared). Backed by `GET/POST /api/v1/budget/accounts` (`?include_archived=1`) and `PUT`/`DELETE /api/v1/budget/accounts/:id`; entries accept an optional `account_id`, and `GET /api/v1/budget?account_id=` filters by account.
- **Loans tab:** create instalment-based loans (borrower, total amount, number of instalments, start month); record individual payments; remaining balance and due months shown automatically; paid-off loans marked as closed; filter budget transactions by loan
- **Subscriptions tab:** recurring service CRUD with daily/weekly/monthly/yearly cycles and exact next-renewal calculation. Every active subscription creates a linked expense on the Budget tab for its next payment; edits synchronize it, disabling removes it from calculations, and renewal preserves the paid expense while creating the next one. Includes custom sortable categories and payment methods, searchable in-modal currency/category/payment controls, uploaded logos plus redirect-aware SSRF-protected public HTTPS logo discovery from site icons and public metadata, configurable reminder timing, filtering, sorting, and responsive analytics.
- **Subscription finances:** native billing currencies, configurable base currency and monthly budget, 12-hour exchange-rate cache with optional Fixer refresh, monthly normalization and yearly projection, remaining/over-budget status, and category/payment-method charts.
- **Subscription reminders:** upcoming payments appear in the existing in-app reminder center according to each subscription's reminder timing.
- **Platform inheritance:** Subscriptions uses the application's existing household multi-user authorization, OIDC/OAuth login, SQLCipher option, backup/restore, responsive PWA shell, offline shell caching, themes, and 20-locale i18n system rather than duplicating those controls inside the tab.
- **Split Expenses tab:** shared expense tracking within named groups (household, couple, travel, event, shopping, general). Split methods: equal, exact amounts, percentage, shares. Balances derived from an immutable double-entry ledger — amounts stored as integer minor currency units (cents) to avoid floating-point errors. **Settlements:** record payments between members; a debt-simplification algorithm produces the minimal transfer set. **Recurring expenses:** daily, weekly, monthly, yearly schedule with automatic generation via hourly scheduler. **Guest accounts:** invite people outside the family as restricted users who can only access the Split module and see their invited groups. **Multi-currency:** each group has a default currency; individual expenses can use any currency with historical exchange rate snapshots. **Activity feed:** per-group log of all expense, member, and settlement events.
- API: `GET /api/v1/budget/categories`, `GET /api/v1/budget/categories/:key/subcategories` (optional `?lang=` localisation), `POST /api/v1/budget/categories`, `POST /api/v1/budget/categories/:key/subcategories`, `GET /api/v1/budget/stats?range=week|month|year&anchor=YYYY-MM-DD` (totals, comparison vs. previous period, per-period series, per-category breakdown), `GET /api/v1/budget/export?from=YYYY-MM-DD&to=YYYY-MM-DD` (range CSV; legacy `?month=YYYY-MM` still supported), `GET /api/v1/budget/plans?month=YYYY-MM` (planned vs. actual per category + savings goal), `PUT`/`DELETE /api/v1/budget/plans/:category`
- Loans API: `GET /api/v1/budget/loans`, `POST /api/v1/budget/loans`, `GET /api/v1/budget/loans/:id`, `PUT /api/v1/budget/loans/:id`, `DELETE /api/v1/budget/loans/:id`, `GET /api/v1/budget/loans/:id/payments`, `POST /api/v1/budget/loans/:id/payments`, `DELETE /api/v1/budget/loans/:id/payments/:paymentId`
- Subscriptions API: `/api/v1/budget/subscriptions` CRUD and analytics, plus `/meta`, `/settings`, and `/logo-search` for selectable logo candidates from a website URL or service name.
- Split API: `/api/v1/split/*` — CRUD for groups, members, expenses, settlements, recurring expenses, and activity feed

### Birthdays (`/birthdays`)

Personal birthday tracker with automatic calendar integration.

- CRUD: name, birth_date (day/month/year or day/month only for age-unknown entries), notes, photo
- Profile photo upload (PNG/JPEG/WebP/GIF, ≤ 5 MB, stored as Base64 data URL)
- **Upcoming view:** birthdays sorted by days until next occurrence; shows age when year is known
- **Mobile action hierarchy:** phones expose creation through the persistent FAB only; the duplicate header action is hidden so the title retains the available width.
- **Calendar integration:** creating or updating a birthday automatically creates/updates a recurring annual all-day calendar event (title: "🎂 {Name}"); deleting a birthday removes the linked event
- **Configurable reminder:** customizable reminder offset per birthday with preset options (none, at time, 15 min, 1 h, 1 d, 2 d, 1 w, 2 w) and a fully custom interval (amount + unit). Reminder time calculated from offset; auto-dismissed when the birthday passes
- Search filter by name
- API: `GET /api/v1/birthdays`, `GET /api/v1/birthdays/upcoming`, `GET /api/v1/birthdays/:id`, `POST /api/v1/birthdays`, `PUT /api/v1/birthdays/:id`, `DELETE /api/v1/birthdays/:id`

### Reminders (`/reminders`)

Time-based reminders attached to tasks or calendar events.

- One reminder per entity (upsert — creating a new reminder replaces the previous one)
- Reminder time set via datetime picker in the task or event modal
- **Pending reminders:** polled on page load and at a fixed interval; displayed as an in-app notification badge/toast
- **Birthday reminders** auto-synced from the Birthdays module (1 day before each occurrence)
- Dismissing a reminder marks it `dismissed = 1`; dismissed reminders are not shown again
- API: `GET /api/v1/reminders/pending`, `GET /api/v1/reminders?entity_type=&entity_id=`, `POST /api/v1/reminders`, `DELETE /api/v1/reminders/:id`, `POST /api/v1/reminders/:id/dismiss`
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

**Admin controls (Settings → Modules → Navigation):**
- Admins can enable/disable individual third-party modules without restarting the server.
- Admins can drag-to-reorder navigation entries inside their Overview, Plan, Home, or Custom modules group; entries cannot cross group boundaries.
- Disabled modules are not served to the browser and do not appear in navigation.
- Enabled module pages are registered automatically in the SPA router at startup.

**Docker / Podman:** The default `docker-compose.yml` mounts `${MODULES_DIR:-./modules}` to `/app/modules`. To keep modules outside the Yuvomi checkout set `MODULES_DIR=/absolute/path` in `.env` and restart. No image rebuild is required. On Podman use `podman-compose.yml`, which adds the SELinux `:Z` relabel to the same mount.

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
- **Curated core tools:** `list_tasks`, `create_task`, `list_shopping_items`, `add_shopping_item`, `list_upcoming_events`, `create_event` — fast, in-process handlers for the most common actions.
- **OpenAPI bridge:** `list_api_operations` and `get_api_operation` discover every documented REST operation; `call_api_operation` invokes any of them over an authenticated loopback call. This exposes the full API through one mechanism instead of a per-route tool, and every call inherits the token's permissions (admin-only routes require an admin token).
- Each call runs as the token's creating user and inherits that user's role. HTTPS is strongly recommended.
- **Token scopes apply here too:** a scoped token only sees the core tools it is allowed to use in `tools/list`, is refused any out-of-scope `tools/call`, and — because `call_api_operation` loops back through the REST layer — cannot reach REST operations outside its allow-list. Use this to hand an AI client a token that, for example, may write the calendar but never read the health module.
- Binary responses through the bridge (e.g. document/backup downloads) are inlined as base64 up to **5 MiB**; larger downloads are rejected and should use the dedicated streaming REST route directly.
- **Optional:** `MCP_INTERNAL_BASE_URL` overrides the base URL the bridge calls back into; it defaults to `BASE_URL` or `http://127.0.0.1:<PORT>` and is only needed for non-standard bind addresses.

---

## Design System

### Colors (CSS Custom Properties)

Source of truth: `public/styles/tokens.css`. Key values (as of v0.55.10):

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
  --color-text-secondary:  #6C6B67;   /* neutral-600, 5.0:1 on white */
  --color-text-tertiary:   #6A6964;   /* 4.61:1 on bg */

  /* Primary accent — Violet */
  --color-accent:           #6c3aed;  /* Violet-600, 5.63:1 on white (AA) */
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
  --color-warning:       #A15C0A;     /* 5.23:1 — Amber, distinct from --module-meals */
  --color-danger:        #B91C1C;     /* Red-700, 6.90:1 (AAA) */
  --color-info:          #0969DA;     /* 4.64:1 */

  /* Module accents — domain-specific, not interchangeable with severity */
  --module-dashboard:       #6c3aed;  /* Violet — follows primary accent */
  --module-tasks:           #15803D;  /* Green — intentional share with --color-success */
  --module-calendar:        #8250DF;  /* Violet-600 — Appointments, time */
  --module-meals:           #C2410C;  /* Orange-700 — Food, warmth */
  --module-shopping:        #DB2777;  /* Pink-600 — distinct from Meals/Warning */
  --module-recipes:         #0D9488;  /* Teal-600 — Recipes */
  --module-notes:           #A16207;  /* Amber-700 — Notes (6.3:1, WCAG AA) */
  --module-contacts:        #0969DA;  /* Blue — distinct from Violet primary */
  --module-birthdays:       #E11D48;  /* Rose — Birthdays */
  --module-budget:          #0F766E;  /* Teal-700 — Finance, stability */
  --module-split-expenses:  #2563EB;  /* Blue — Shared family finance */
  --module-documents:       #1D4ED8;  /* Blue — Secure family documents */
  --module-housekeeping:    #7C3AED;  /* Violet — Focused service workflow */
  --module-reminders:       #0E7490;  /* Cyan-700 — Reminders (WCAG AA) */
  --module-settings:        #6E7781;  /* Neutral grey */

  /* Priority */
  --color-priority-medium: #A16207;  /* Amber-700, 6.3:1 — distinct from Warning+Meals */
  --color-priority-high:   #C2410C;  /* = --module-meals (documented share: "hot") */
  --color-priority-urgent: #B91C1C;  /* = --color-danger (documented share: "destructive") */

  /* Glass layer tokens */
  --glass-bg: rgba(255,255,255,0.72);
  --glass-border: rgba(255,255,255,0.55);
  --glass-bg-card: var(--color-surface-glass);
  --blur-2xs: blur(2px);
  --blur-md: 16px;
  --radius-glass-button: 9999px;       /* capsule */
  --ease-glass: cubic-bezier(0.34, 1.56, 0.64, 1); /* spring */

  /* Glass Vibrancy tokens (Phase 4) */
  --glass-bg-card: rgba(255,255,255,0.52);
  --glass-bg-card-hover: rgba(255,255,255,0.65);
  --glass-bg-input: rgba(255,255,255,0.48);
  --glass-bg-toolbar: rgba(255,255,255,0.58);
  --glass-tint-strength: 6%;

  /* Glass inset specular highlights */
  --glass-inset-soft:     inset 0 1px 0 rgba(255,255,255,0.18);
  --glass-inset-base:     inset 0 1px 0 rgba(255,255,255,0.20);
  --glass-inset-medium:   inset 0 1px 0 rgba(255,255,255,0.22);
  --glass-inset-elevated: inset 0 1px 0 rgba(255,255,255,0.28);
  --glass-inset-strong:   inset 0 1px 0 rgba(255,255,255,0.32);
}

/* Dark mode — Hue preserved (Violet-400), only Lightness/Saturation adjusted.
   Private --_name tokens prevent duplication between @media and [data-theme]. */
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #1A1A18;       /* deep warm */
    --color-surface: #222220;
    --color-border: #2C2C2A;
    --color-text-primary: #F5F4F1;
    --color-text-secondary: #AEADB0;
    --color-accent:            #a78bfa;  /* Violet-400, 6.05:1 on dark surface */
    --color-accent-hover:      #9066f5;  /* Violet-500 */
    --color-accent-active:     #7c3aed;  /* Violet-600 — mirrors light primary */
    --color-accent-light:      #2e1065;
    --color-accent-subtle:     #1e1040;
    --color-btn-primary:       #9066f5;  /* Violet-500, good contrast on dark */
    --color-btn-primary-hover: #7c3aed;
    --module-dashboard: #a78bfa;  /* Violet-400 */
    --module-meals:     #FB923C;  /* Orange-400 */
    --module-shopping:  #F472B6;  /* Pink-400 */
    --module-budget:    #2DD4BF;  /* Teal-400 */
    --module-reminders: #22D3EE;  /* Cyan-400 */
    --glass-bg: rgba(28,28,26,0.75);
    --glass-border: rgba(255,255,255,0.12);
    --color-surface-work: #242422;
    --color-surface-raised: #2E2E2B;
    --color-surface-glass: rgba(34,34,32,0.78);
    --glass-bg-card: var(--color-surface-glass);
    --glass-tint-strength: 8%;
  }
}
```

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

### Responsive Composition
- Phone layouts prioritize one readable content column, complete titles, and one clear primary creation action. Horizontal scrolling is reserved for deliberate tab or timeline patterns, never used to compensate for clipped cards or toolbars.
- Tablet layouts (768–1023px) may wrap dense toolbars and use two-column overview grids while retaining the mobile navigation model.
- Desktop composition starts at 1024px. Full secondary toolbars and persistent local navigation return only when their labels and controls fit without compression.
- Grid tracks that contain variable text use `minmax(0, 1fr)` so long localized content cannot enlarge the page beyond the viewport.
- Cards, rows, and controls that display user-generated text must contain unbroken strings and mixed scripts without creating page-level horizontal overflow. Text blocks use per-paragraph bidirectional resolution where user content can mix RTL and LTR scripts.
- Route-level load failures replace the page with a localized recovery state. The state uses `role="alert"`, receives focus without scrolling, and offers a reload action; modules must not convert failed initial loads into misleading empty states.

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
- **Settings** (`settings.css`) — responsive settings shell (desktop sticky local navigation, mobile drill-down overview), setting rows, status summaries, accessible disclosures, CalDAV/CardDAV account items, module rows, toggle/category rows
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
- **Calendar and Settings polish:** calendar month/agenda views use explicit readable surfaces and boundaries; Settings uses a sticky local navigation column on desktop and a history-aware drill-down on mobile.

**Accessibility:** `prefers-reduced-transparency`, `prefers-reduced-motion`, and `prefers-contrast: more` blocks deactivate blur/animation and restore solid fallbacks across all phases.

### Components
- **Cards:** Glass tokens applied app-wide — `var(--glass-bg-card)` background, `var(--glass-border-subtle)` border, `var(--radius-glass-card)` (20 px) for containers, `var(--radius-glass-inner)` (14 px) for inner rows, `var(--glass-shadow-sm/md/lg)` for elevation. Module tint overlay via `::after` pseudo-element using `color-mix(in srgb, var(--module-accent) var(--glass-tint-strength), transparent)`. Consistent padding `var(--space-4)` (16 px) across all modules. `backdrop-filter` is disabled for all elements inside `.app-content` (see Mobile compositor safety above); glass appearance inside scrolling content is achieved through the semi-transparent background + border + shadow alone.
- **Buttons:** Primary = accent + white. Secondary = outline. Min-height 44px. Capsule shape via `--radius-glass-button`. Submit buttons show success (checkmark, 700ms green via `.btn--success`) and error (shake via `.btn--shaking`).
- **Inputs:** `var(--radius-sm)`, 1.5px border, padding 12px 16px. Search inputs use `--radius-glass-button` and `--glass-border-subtle`. `[required]` fields receive validation status on blur (`.form-field--error` / `.form-field--valid`). Enter in a **single-line field** submits the modal form (standard web convention, v0.55.0); in a multi-line textarea Enter inserts a newline.
- **Date & time picker:** Every date and time field across the app uses one shared `yuvomi-datepicker` web component (calendar appointments, tasks, meal planning, budget, health, birthdays, shopping, split-expenses, housekeeping, subscriptions, settings, and the recurrence "until" date). Free-text entry stays the fast path — locale-aware parsing keeps the flexible shorthands (`0930`/`9h30` → `09:30`, `5.1.2027` → the locale date) — while a trailing icon opens a themed calendar/time popover on desktop and the **native OS picker on touch** (`showPicker()`). The popover renders in the top layer via the native Popover API (never clipped inside a modal), takes the module accent from `--active-module-accent`, marks today and traps focus. The component is **form-associated** (participates in `form.elements`/`FormData`), exposes a canonical ISO `value` (`YYYY-MM-DD` / `HH:MM` / `YYYY-MM-DDTHH:MM`), enforces optional `min`/`max` on both typing and the grid, adopts an associated `<label>` as its accessible name, and mirrors direction for RTL. Weekday/month names come from `Intl`; no dedicated locale strings.
- **FAB (Floating Action Button):** Color follows the module accent token (`--module-accent`) - each module defines its own accent color. Specular inner highlight + attention ring pulse. Hidden when the virtual keyboard is open (`visualViewport.resize`, threshold 75% of window height). Rendered from one shared helper `public/utils/fab.js` (`pageFabHtml` / `createPageFab` / `setPageFabAction`); tab/route modules (Health, Rewards, Housekeeping) drive a **context-aware, permission-gated** FAB whose action follows the active tab/route and hides where no create action applies, and Budget's FAB covers its embedded Subscriptions sub-tab (v0.94.0).
- **Module accent colors:** `--module-accent` is applied on three visual layers - (1) active nav tab (bottom bar + sidebar stripe), (2) toolbar `border-top: 3px`, (3) cards/rows `border-left: 3px`. The active accent is written to `--active-module-accent` on `:root` on every navigation change. Falls back to `--color-accent` for pages without a module context.
- **Navigation:** The persistent mobile bottom bar contains exactly five destinations: fixed Overview, three configurable favorites (default Calendar, Tasks, Kitchen), and fixed More. Inactive buttons are neutral; the active module alone supplies color to the icon and 200 ms sliding indicator. The desktop sidebar uses the same glass surface and groups entries under localized headings — Overview (Dashboard), Plan (Calendar, Tasks, Notes), Home (Kitchen, Contacts, Birthdays, Budget, Documents, Housekeeping), and Custom modules when enabled third-party modules are loaded — with Settings pinned at the end. Ordering is user-specific and limited to each group. Custom monoline SVG icons are served from `public/nav-icons.js` (DOM API, no `innerHTML`); Lucide is the fallback. Kitchen and More keep stable visible labels/icons; active subsections use localized `aria-label`/`aria-current`. **Collapsible sidebar (desktop only):** a toggle button collapses the sidebar to icon-only mode (56 px); state persists in `yuvomi.sidebar.collapsed`, and native title tooltips preserve discoverability.
- **Sub-tabs:** `public/utils/sub-tabs.js` renders the sticky pill-style tab bar for Kitchen. It wires `role="tablist"`, `aria-selected`, `aria-controls`, `aria-labelledby`, keyboard arrow navigation, and panel focus coordination from one shared helper. (Settings no longer uses sub-tabs; it has its own responsive shell — see the Settings section.)
- **Tablist behavior:** `public/utils/tablist.js` (`wireTablist`) is the shared WAI-ARIA tablist behavior — roving tabindex, arrow/Home/End keys, `aria-selected`/`aria-current` — for tab navs that live inside a module's `page-toolbar` rather than a standalone sub-tab bar (Budget, Rewards, Housekeeping, and the Calendar month/week/day/agenda view-switcher). It complements `sub-tabs.js` so every tab surface shares one interaction grammar (v0.94.0).
- **Transitions:** Directional slide-X animation on page change (forward = from right, back = from left, 200ms) with spring easing. Respects `prefers-reduced-motion`.
- **Empty states:** Consistent `.empty-state` class across all modules (icon + title + description, centered). Compact variant `.empty-state--compact` for meal slots.
- **Modals:** Centered panel on desktop with glass overlay. On mobile (< 768px) bottom sheet - spring slide-in from below, sheet handle visible, swipe-to-close (> 80px downward). `focusin` scrolls inputs into view when the virtual keyboard is open. The modal lifecycle is managed as an explicit state machine (`idle → open → confirming → closing`) with encapsulated suspend/restore helpers, hardening the unsaved-changes confirmation against double-close and back-navigation races (v0.55.0). Modal titles and `selectModal` option labels are HTML-escaped centrally to prevent XSS from raw user data reused as modal headings.
- **List animation:** Staggered spring fade-in on load (`stagger()` from `public/utils/ux.js`) - max 5 elements staggered (30ms gap), rest appear immediately.
- **Vibration:** `vibrate()` from `public/utils/ux.js` - short pulses for light actions (10-40ms), pattern `[30, 50, 30]` for destructive actions (delete). Respects `prefers-reduced-motion`.
- **Global search overlay:** Full-text search across tasks, calendar events, notes, contacts, and shopping items. Results are grouped by module and trigger deep-link navigation: contacts via `?open=<id>` (opens edit modal directly), calendar events via `?open=<id>`, notes via `?open=<id>`, shopping items via `?list=<id>&highlight=<id>` (activates the correct list tab and scrolls the item into view). Activated from the search bar in the More-Sheet. The FTS5 index is diacritic-insensitive (`unicode61 remove_diacritics 2`, migration 77) and the query expands ß↔ss variants, so "muller"/"strasse" match "Müller"/"Straße". Calendar events are family-visible in search (not scoped to the creator), matching the calendar list.
- **Calendar search (#471):** An in-context search bar in the calendar toolbar (magnifier button, or the `f` shortcut) finds appointments across the whole timeline — past and future — even when the date is unknown. Matches title, location, and notes/description via `GET /api/v1/calendar/search?q=` (same FTS5 index; event body indexes `location` since migration 76). Results render as a chronological, date-grouped list anchored on the next upcoming hit; recurring events resolve to their next occurrence within a two-year window rather than the series start. Selecting a result jumps to that day and opens the event. Result rows are keyboard-operable (`role="button"`, Enter/Space); the count line reports "N of M" when capped at 100.
- **PWA install prompt:** Appears only after 2 user interactions. Dismiss window 7 days; interaction counter resets after dismiss.
- **PWA offline and update contract (v0.71.34):** Service-worker shell, page, locale, and asset caches are keyed to the package release so every published UI revision installs fresh cache namespaces. The early `/lang-init.js` locale/direction bootstrap is part of the offline shell. When the network is unreachable and `index.html` is not cached, the worker serves `/offline.html` with a reload button.
- **Read-only offline data (v0.78.8):** The service worker network-first-caches a whitelist of read-only `GET /api/v1/*` data paths (calendar, tasks, shopping, contacts, dashboard) in a release-keyed `oikos-api-<version>` cache, so the last-seen data stays viewable offline. Mutations, `/auth/*`, and non-whitelisted GETs are never cached; state-changing requests that fail offline surface a clear "changes aren't possible while offline" message instead of a raw network error. The calendar shows a subtle "Offline – as of: {time}" banner (from the cached `x-cached-at` timestamp) when served from cache. The API cache is wiped on logout and session expiry (`CLEAR_API_CACHE` message) so a second user on the same device cannot see the previous user's cached data, and old `oikos-api-*` caches are purged on every SW update.
- **User-selected note colors (v0.71.34):** note titles, content, creator metadata, and fallback avatars choose black or white ink from WCAG relative luminance instead of a brightness heuristic; supporting text remains fully opaque so every built-in note color meets AA contrast.

### Breakpoints
- Mobile: < 768px (1 column, bottom nav)
- Tablet: 768–1024px (2 columns, bottom nav)
- Desktop: > 1024px (sidebar + content)

---

## Internationalization (i18n)

All UI strings are managed via `public/i18n.js`. No hardcoded text in JS files outside of locale files.

### Architecture

- **Module:** `public/i18n.js` - exports: `initI18n()`, `setLocale()`, `t(key, params?)`, `getLocale()`, `getSupportedLocales()`, `formatDate(date)`, `formatTime(date)`
- **Locale files:** `public/locales/de.json` (reference), `public/locales/en.json`, `public/locales/es.json`, `public/locales/fr.json`, `public/locales/it.json`, `public/locales/sv.json`, `public/locales/el.json`, `public/locales/ru.json`, `public/locales/tr.json`, `public/locales/zh.json`, `public/locales/ja.json`, `public/locales/ar.json`, `public/locales/hi.json`, `public/locales/pt.json`, `public/locales/uk.json`, `public/locales/pl.json`, `public/locales/nl.json`, `public/locales/cs.json`, `public/locales/vi.json`, `public/locales/hu.json` - structure: `{ "module.camelCaseKey": "Value" }`
- **Variables:** `{{variable}}` syntax in translation strings, e.g. `t('tasks.assignedTo', { name: 'Anna' })`
- **Fallback chain:** active locale → German (`de`) → key itself
- **Date format:** `Intl.DateTimeFormat` with current locale - use `formatDate()` and `formatTime()` from `i18n.js`

### Language Detection

1. `localStorage` entry `oikos-locale` (manual selection)
2. `navigator.languages[0]` (browser language)
3. Fallback: `en`

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
| `hu` | Hungarian | Full translation |
| `ko` | Korean | Full translation (added v0.88.0) |
| `id` | Indonesian | Full translation (added v0.88.0) |
| `fa` | Persian (Farsi) | Full translation, RTL (added v0.88.0) |

### Adding a New Language

1. Create `public/locales/xx.json` (copy of `de.json`, translate)
2. Add `'xx'` to `SUPPORTED_LOCALES` in `public/i18n.js`
3. Add label in `oikos-locale-picker` (`LOCALE_LABELS['xx'] = 'Name'`)

### Locale Switching

The early language bootstrap applies both `lang` and writing direction before the app renders (`ar` uses `dir="rtl"`; all other supported locales use `dir="ltr"`). `setLocale(locale)` saves the selection, loads the new locale file, updates both document attributes, and fires the `locale-changed` custom event. The router rebuilds shared navigation and re-renders the active route so every visible label changes without a page reload.
