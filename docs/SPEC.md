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
| onboarding_version | INTEGER | NOT NULL, default 0 (migration v168) — the walkthrough version this account has seen |
| changelog_seen_version | TEXT | Nullable (migration v173) — the INSTALLED version at this account's last look at the changelog. Drives the "New in your app" list |
| changelog_seen_latest | TEXT | Nullable (migration v173) — the last known PUBLISHED version this account saw. Drives the update dot in the navigation |

**The onboarding walkthrough is remembered per account, not per browser (v2.52.0).** The marker used
to live only in `localStorage`, so a new device or a private window showed the walkthrough again to
an account that had long dismissed it. `/auth/me` and `/auth/login` therefore carry
`onboarding_pending`, computed as `onboarding_version < CURRENT_ONBOARDING_VERSION`
(`server/auth.js`); `POST /api/v1/auth/onboarding-seen` records the current version on the calling
account.

A number rather than a flag, because "seen" alone allows no later extension: if a future release
warrants showing the walkthrough again, a maintenance commit raises `CURRENT_ONBOARDING_VERSION` and
every account below it sees it once more — no further migration. Migration v168 backfills existing
accounts to 1 (they have seen the current walkthrough by definition) while the column default stays
0, so every future `INSERT INTO users` gets the right behaviour for a new account without its own
change. The `localStorage` key remains as an **additional** condition rather than a replacement: it
is how the visual-probe harness suppresses the dialog without marking a test account server-side.
The install-to-home-screen banner is deliberately untouched — whether a device has the PWA installed
is a property of that device, so it keeps its local 7-day snooze.

**The changelog marks follow the same reasoning (v173, #496).** Both lived in `localStorage`, so
reading the changes on the desktop left the tablet showing the same dot and the same "New in your
app" list again. **Two columns, because they answer two questions:** `changelog_seen_version` is the
installed version at the last look and bounds the list — an instance on 2.55 must not be told what
2.61 brought, because for that household none of it happened; `changelog_seen_latest` is the last
known published version and drives the dot. Merging them would answer one of the two wrongly as soon
as an instance runs behind the release.

`POST /api/v1/auth/changelog-seen` records both. The installed version comes from the **server**
rather than the request body — which version runs here is server knowledge, and a client could claim
the wrong one; an absent `latest` leaves the stored value alone instead of clearing it. Unlike the
onboarding column, existing accounts are **not** backfilled: `NULL` means "never looked", which is a
different state from "seen everything", and the list stays empty on a first look rather than
declaring the entire history missed. What stays in `localStorage` is the cached GitHub answer and
the timestamp of the last check — a scratchpad for something the server said, not a state belonging
to a person.

**What the view does with them:** the changelog opens with a "New in your app" block listing the
lead sentences of everything that changed between `changelog_seen_version` and the running version,
each expandable for the reasoning underneath. Those lead sentences exist because every entry has
opened with a bolded one since v2.41.0, enforced by `npm run test:changelog` (#850) — the route
previously stripped that emphasis and merged the follow-up lines back into prose, so the structure
never reached the screen. `/api/v1/changelog` therefore carries `entries` (`{ lead, detail }`)
beside the unchanged `items`, additively: a promised surface does not change shape because the UI
wants a nicer one. Long gaps are capped at twelve lines with the remainder counted out loud.

### Two-Factor Authentication (migration v159, #672)

Optional TOTP as a second factor, opt-in per user. Two tables instead of columns on `users`, because
both are lists that come and go together with the feature and neither is a property of the account.

`user_totp` — one row per user, therefore `user_id` is the primary key.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | PK, FK → Users, ON DELETE CASCADE |
| secret | TEXT | NOT NULL. Base32, 160 bit. Stored as-is: TOTP verification needs the secret itself, so a hash is not an option — it is protected by `DB_ENCRYPTION_KEY`, like every other secret in this database |
| confirmed_at | TEXT | NULL while setup is in progress. A secret nobody has proven with a code protects nothing, so the half-finished state can safely sit in the database — which is why the setup survives a page reload |
| last_step | INTEGER | The TOTP time step last redeemed. RFC 6238 §5.2 requires this: without it an intercepted code stays valid for the full ±1 tolerance window and can be replayed |
| created_at | TEXT | |

`user_recovery_codes` — ten per user, regenerated as a set.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users, ON DELETE CASCADE, indexed |
| code_hash | TEXT | NOT NULL. SHA-256, deliberately not bcrypt: the code is not a password but a ~49-bit random value from Yuvomi's own generator. Key stretching protects weak secrets; here there is nothing weak to protect, while ten bcrypt runs per sign-in attempt would make the sign-in itself the target |
| used_at | TEXT | Set instead of deleting the row, so the UI can say "7 of 10 left" without counting |
| created_at | TEXT | |

**Sign-in flow.** `POST /auth/login` with a correct password answers `{ twoFactorRequired: true }` and
creates **no session**. The waiting state lives in `req.session.pendingTwoFactor` — deliberately a
different key from `userId`, so `requireAuth` is blind to it — and expires after five minutes.
`POST /auth/2fa/verify` accepts the TOTP code or a recovery code and builds the session through
`setupAuthSession`, which regenerates it (session fixation).

**Turning it off requires a second factor, not the password.** Against a hijacked session only the
factor itself helps, and OIDC accounts have no password to prove anything with. Whoever lost their
device uses a recovery code.

**SSO is not a way around it.** `/auth/oidc/callback` runs the same check before creating a
session. One could argue the provider already authenticated, possibly with its own second factor —
but a promise that depends on how you signed in is not a promise, and more importantly the
household-wide requirement would otherwise be a request to whoever takes the password route rather
than a rule. A guard in `test-two-factor.js` asserts the rule rather than the one call site: every
`setupAuthSession` that establishes a fresh sign-in sits behind an `isEnabled` check, except where
no second factor can exist by construction (first-run setup, invite redemption, the verify route
itself).

**Household-wide requirement** (`sync_config.require_two_factor`, set through `PUT /auth/2fa/require`
with `requireAdmin` as middleware rather than a field on `PUT /preferences`) blocks *turning off*
and puts a notice on every account page without one. It deliberately does not reject existing
sessions: in a household with no devices set up yet, that would lock everyone out, including the
admin.

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
| permissions | TEXT | Nullable JSON (migration v171) — the resolved starting permissions chosen at invite time, in the shape `normalizePermissionInput()` accepts. `NULL` = no override, which is how every invitation before v171 behaves |

### Tasks
| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | NOT NULL |
| description | TEXT | |
| category | TEXT | FK → Task Categories (by key), NOT NULL default `misc` |
| priority | TEXT | none (default), low, medium, high, urgent |
| status | TEXT | open, in_progress, done — the CHECK still permits the retired `archived` value, but nothing writes it since migration v132. Settable **on creation** since v2.60.0 (#807): the dialog offered the field only when editing, and `POST /tasks` validated a supplied status without ever writing it, so a value that passed validation was silently dropped. Creating with a status runs through the same transition helpers as PUT and PATCH (reward ledger, completion history, recurrence follow-up), because a creation with a status *is* a status change — it merely starts from `open`. A `null`, an empty string or `archived` all fall back to the first status |
| archived_at | TEXT | ISO timestamp, nullable (migration v132, #688) — `NULL` means the task is in play. Archiving is a separate axis from `status`, so a filed-away task keeps whatever status it had |
| due_date | TEXT | DATE, nullable |
| due_time | TEXT | TIME, nullable |
| start_date | TEXT | DATE, nullable — tasks with a future start date are hidden from the default list view |
| assigned_to | INTEGER | FK → Users (legacy single-user field, kept for backwards compat) |
| created_by | INTEGER | FK → Users, NOT NULL |
| is_recurring | INTEGER | 0/1 |
| recurrence_rule | TEXT | iCal RRULE |
| recurrence_from_completion | INTEGER | NOT NULL DEFAULT 0 (migration v127, #658) — 1 anchors the next due date to the day the task was ticked off instead of to its due date |
| parent_task_id | INTEGER | FK → Tasks (max 2 levels) |
| recurrence_origin_id | INTEGER | FK → Tasks, ON DELETE SET NULL (migration v122) — the completed instance whose completion created this one. Deliberately not `parent_task_id`, which means "subtask". **The column carries two meanings and `parent_task_id` tells them apart** (v2.52.1, #924): on a root task it means "I am the next run of X", on a subtask copied into a follow-up (v2.8.4, #742) it means "I am the copy of Y in this run". Only the first is a follow-up, so every read that acts on one must filter for `parent_task_id IS NULL` |
| points | INTEGER | NOT NULL DEFAULT 0 — reward points credited to assigned members on completion (Rewards module, migration v69) |
| visibility | TEXT | NOT NULL DEFAULT `all` — `all` \| `assignees` \| `private`; who may see the task (migration v78) |
| locked | INTEGER | NOT NULL DEFAULT 0 (migration v155, #830) — 1 closes the task **definition** to everyone but its creator and admins, while ticking off, commenting, and assigning oneself stay open for all. A subtask inherits its parent's lock |
| countdown | INTEGER | NOT NULL DEFAULT 0 (migration v150, #647) — 1 puts the task on the Countdown widget, counting down to its `due_date`. A recurring task carries the flag into the instance its completion creates, which is what makes "always another N years" (driving licence) or "N days after cleaning" (air filter) work together with `recurrence_from_completion` |
| target_caldav_account_id | INTEGER | FK → CalDAV Accounts (for the first upload of a locally created task), nullable (migration v136, #695) |
| target_caldav_list_url | TEXT | CalDAV reminder-list URL for that upload, nullable (migration v136, #695). Both columns are cleared once the task has been uploaded — from then on it is an ordinary mirror and carries `external_uid` instead |

**Visibility (migration v78):** every task carries a `visibility` of `all` (all family members, the default and prior behaviour), `assignees` (creator + assigned members only), or `private` (creator only). Enforcement is **server-side on every read path** (list, detail, dashboard widgets, search, MCP) **and, since v2.12.0, on every write path** (`PUT`/`DELETE` answer 404 for a task the caller cannot see, since its existence is itself information) — there is **no admin bypass**, so a "private" task stays hidden even from a parent/admin (the intended use is preparing a surprise). Set via the visibility selector in the task modal; restricted tasks carry a lock/people icon in the list. The same field and rule apply to calendar events. **In a household of one the selector is not shown** (v2.0.2): it would have exactly one sensible answer. The field keeps its stored value and returns as soon as a second member joins — the rule changes what is asked, never what is stored. The same applies to "assigned to" and to the visibility of documents. A **subtask carries its own visibility** and is filtered by it independently of its parent (**v2.12.0**): a private subtask under a shared parent stays out of another member's list, out of its `subtask_total`/`subtask_done` counts, and out of the progress bar derived from them. Both dates matter for anyone auditing an older install: the detail view had filtered correctly for a long time, but the **list** returned every subtask of a shared parent with its title regardless of the subtask's own visibility, and the write paths acted on a row loaded by id alone — so before v2.12.0 a known or guessed id was enough to edit or delete another member's private task.

Recurring tasks keep only one open instance: the next instance is created on completion, not on a schedule. Both ways of completing a task create it — the checkbox on the card and the status field in the edit dialog — and both ways of undoing a completion withdraw it again. When an overdue recurring task is marked done, its next due date catches up to the next occurrence at or after today (skipping missed periods) instead of advancing a single interval from the old — possibly still overdue — due date. The follow-up instance inherits the tags along with the assignees: tags belong to the task, not to a single run. **Subtasks come along too (v2.8.4, #742):** each one is copied under the new parent with its status reset to `open` and its own assignees and tags, so a recurring task that works as a checklist keeps its steps instead of losing them after the first run. Their dates shift with the parent, keeping the gap each subtask had to the parent's due date; a completion-anchored series without a parent due date falls back to the subtask's own date rather than leaving the copy at its predecessor's. It also keeps the gap between start date and due date, so a task that begins three days before it is due keeps that head start — which means the follow-up stays out of the default list until its start date arrives, the same as any task with a future start date ("show future tasks" reveals it).

**Which day the interval counts from (migration v127, #658).** Two anchors, chosen per task by the "repeat from completion" switch inside the recurrence fields:

- **From the due date** (default, unchanged behaviour): the grid stays put no matter when the task is ticked off. Right for anything tied to an outside rhythm (bin day, rent, the club evening), and the only mode that needs the catch-up described above.
- **From the completion day**: the interval starts on the day the task was actually ticked off. Right for anything whose interval only begins with the action, such as cleaning the filter or feeding the plants. A weekly task due Saturday and completed on Monday becomes due the Monday after, not five days later. No catch-up is involved: with any positive interval the result already lies in the future. This mode also carries a series that has no due date at all, since the completion day is a usable anchor on its own.

The flag is copied onto the follow-up instance; without that the series would fall back to the due-date grid from its second run on, and it would do so silently, because the follow-up looks complete either way. The completion day is read in the household's own zone (`TZ`, see `server/utils/timezone.js`): ticking a task off at 00:30 must count as the new day, or a weekly task would come back six days later. The anchor is local to Yuvomi and does not travel over CalDAV, because RFC 5545 has no way to express it and a mirrored VTODO carries the rule alone. The shared calculation lives in `nextDueAfterCompletion()` in `server/services/recurrence.js`, deliberately separate from the route because resettable countdowns want the same "counts from the moment you touched it" arithmetic (#647).

**Undoing a completion (migration v122, #650):** ticking a series off is reversible. The follow-up instance records which completion created it (`recurrence_origin_id`), so moving a task back out of `done` — via the checkbox or the edit dialog — removes that follow-up again instead of leaving it standing next to the reopened task. Only an untouched follow-up is withdrawn: one that is still `open` and has not itself been completed. Since the follow-up carries copied subtasks of its own (v2.8.4, #742), "untouched" is a comparison rather than a head count: each subtask is checked against the one it was copied from, and any difference — a changed status, an edited field or date, one added or removed — keeps the follow-up standing. Merely *having* subtasks no longer protects it, or a checklist series could never be un-ticked; editing one still does, because that is work a click on the predecessor must not discard. Once work has accumulated on it, a click on its predecessor must not throw that away. The same link makes the creation idempotent: a completion never adds a second follow-up. **Only a whole occurrence counts as a follow-up** (v2.52.1, #924): the copied subtasks carry `recurrence_origin_id` as well, so until then unticking a subtask *on the finished occurrence* looked up its own copy in the next one, found an untouched row, and deleted it — a four-step series came back as 0/4 and dropped to 0/3, then 0/2. The lookup is restricted to root tasks; a tick on a past run is a fact about that run alone. Occurrences that already lost a step this way stay as they are, since the row was really deleted.

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

**Uploading from the task (#733).** Until v2.17.0 the task modal carried its own picker, and it could
only link what was already filed: attaching a photo of a note meant leaving the task, uploading it in
Documents and coming back. The field is now the shared `components/document-attach.js` — the same one
Budget, Shared Expenses and Inventory use, and which has been able to upload since #583 — so a file
can be picked, dropped onto the field or chosen from the existing documents; new uploads land in the
Documents module (folder `documents.tasksFolder`) and stay linked. Dropping is new to the shared
component and therefore applies to all four modules.

The read view lists the linked documents by name and shows images as previews, which is the second
half of the request: what usually hangs off a task is a photographed note, and a filename does not
answer the question the photo was attached for. `GET /api/v1/tasks/{id}` now returns a `documents`
array (same visibility rule as `GET /{id}/documents`) — the detail view had been rendering that field
since it was built, but the API never filled it, so the row was always empty.

### Task Comments (migration v149, #734)
A conversation about a task, next to the task. Modelled on `expense_comments` (v44), which answers the
same question for a shared expense.

| Column | Type | Constraint |
|--------|------|-----------|
| task_id | INTEGER | FK → Tasks (CASCADE delete), NOT NULL |
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| comment | TEXT | NOT NULL, max 5000 characters |
| created_at | TEXT | ISO 8601, default now |
| updated_at | TEXT | NULL until someone edits — only a corrected comment carries the mark |

API: `GET/POST /api/v1/tasks/{id}/comments`, `PATCH/DELETE /api/v1/tasks/{id}/comments/{commentId}`.
Whoever may see the task may read and write; editing is the author's alone, deleting is the author's
or an admin's (otherwise nobody could moderate a post). A task the caller cannot see answers `404`
for its comments as well — its existence is itself information.

**Mentions.** `@Name` against the member list, read from the **text** and not from a second field
alongside it: otherwise the highlighted name and the notified person would be two truths that drift
apart as soon as someone types the name instead of picking it from the suggestions. The parser
(`public/utils/mentions.js`) is shared by both sides — the browser highlights with it, the server
picks the push recipients with it. Longest matching name wins (`@Anna Maria` over `@Anna`), matching
is case-insensitive, and a word character before the `@` disqualifies it, so `info@example.org` is not
a mention. A mentioned member is only notified if they may see the task: a mention is not a way to
deliver the title of a private task.

### Task Completions (migration v161, #791)

Ticking a task off is an **event**, not just a state. `status = 'done'` answers "is this still
outstanding"; it cannot answer what was completed today, what yesterday, when a recurring chore was
last done, or who did it. This table records the transition.

| Column | Type | Constraint |
|--------|------|-----------|
| task_id | INTEGER | FK → Tasks (CASCADE delete), NOT NULL, UNIQUE |
| series_id | INTEGER | NOT NULL — root of the repetition chain, or the task itself. No FK: the root may be deleted without taking later entries with it |
| user_id | INTEGER | FK → Users (SET NULL) — **who ticked it off** |
| completed_at | TEXT | ISO 8601 UTC, default now |

**Why a table and not two columns.** A completed recurring task spawns a follow-up instance
(`recurrence_origin_id`), so the history of one series is spread across a chain of rows whose links
can be deleted individually. "When was this last done" hangs on exactly that chain, which is why
`series_id` is resolved once on write (walking the chain to its root) rather than on every read: an
entry stays with its series even if the chain later breaks.

**No snapshot of title, category or member.** A copy would be a second truth beside the task — and
the dangerous one, because **visibility** is a truth too. Someone who sets a task to private later
has hidden it; an entry carrying its own copy of the old level would keep giving it away. Both read
paths join `tasks` and apply the same `visibilityWhere` as every other task list. The price, paid
deliberately, is `ON DELETE CASCADE`: deleting a task deletes its completions.

**Who, not whom.** `user_id` is the acting person, which is deliberately different from
`reward_ledger`, where points go to the *assignees* (`rewardTargets`). Points are a merit and can be
shared; a completion is an occurrence — it happens once, through one click.

**Subtasks are never recorded.** A subtask is a checklist item of the same instruction; the event of
the series is the parent being ticked off. Filing a task away (`archived`) is not a status change
(#688) and writes nothing either.

Reverting deletes the row rather than posting a counter-entry — the same decision as
`reverseTaskEarnings`, for the same reason: a checkbox toggled three times is noise, not history.
The UNIQUE index on `task_id` is also the idempotency net if the same transition arrives twice.

**Known boundary:** the inbound CalDAV sync writes `status` straight into the row and does not pass
through this path, so ticking a mirrored task off in Apple Reminders does not appear in the history.
The reward ledger has the same gap for the same reason: that run has no acting person - it uses the
household's credentials, not a member's. An entry without a person is possible (the column allows
NULL) but needs its own presentation, since "no longer in the household" would be the wrong answer
for a sync. Stated here as a decision rather than inherited silently.

API: `GET /api/v1/tasks/completions` (household feed, newest first, cursor-paged over
`(completed_at, id)` because a bulk action puts several completions in the same second), and
`GET /api/v1/tasks/{id}/completions` (the whole series behind one task). No date range on either:
which calendar day an instant belongs to is a question for the display timezone
(`public/utils/timezone.js`), and a server taking a `from` day would have to keep a second clock for
it. **The history starts empty** — recording began with this migration, and nothing wrote down what
was completed before it.

### Rewards (migration v70)

Points-and-rewards system. A member earns a task's `points` when the task is marked done (awarded to its assigned members; if unassigned, to the acting user — useful for a wall-mounted kiosk tablet on a single account). Participation is **opt-in per member**; redemptions require **parent/admin approval** by default — an admin can disable this household-wide (`rewards_require_approval` preference, Settings → Modules → Rewards) so redemptions are granted immediately. The Rewards module itself is toggleable in Settings → Modules → Rewards (nav visibility). A member's balance is always `SUM(delta)` over `reward_ledger` — there is no separately stored balance that could drift. Point award is idempotent (partial unique index) and reversed when a task leaves the `done` state.

**Default task points (#578, v1.46.0):** a household-wide default (`tasks_default_points` in `sync_config`, admin-gated, `0` = off and the prior behaviour) prefills the points field of new tasks; the value stays overridable per task, and an explicit `0` wins over the default. Subtasks are excluded — they are checklist items of their parent and would otherwise multiply its value. The server applies the default in `POST /api/v1/tasks` only when the request omits `points`, so API and MCP clients inherit it too; system-generated tasks (Housekeeping payments, CalDAV sync) insert directly and are unaffected. When an admin changes the default, the settings page offers to carry existing tasks over: `GET /api/v1/tasks/points/affected?points=N` counts the candidates and `POST /api/v1/tasks/points/rebase` (`{ from, to }`, both admin-only) moves them. "Still on the old default" is decided by the point value itself rather than a hidden flag — the count is shown before confirming, so nothing changes unseen. Tasks in status `done` are excluded because `reward_ledger` already holds an earn entry for their value; every other status is booking-free and moves along, so a reactivated task never pays out a stale value. The archive plays no part here (since #688 it is not a status): an archived-and-done task is already excluded by its status, an archived-and-open one is booking-free like any other open task.

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
| sort_order | INTEGER | NOT NULL DEFAULT 0 — manual rank **within (list, category)** (migration v133, #678) |

Notes and links are edited in a per-item detail drawer (progressive disclosure); the quick-add row
stays name/quantity/category only. A subtle inline icon marks items that carry a note or link. The
note is indexed in the global search.

`sort_order` is the rank inside one aisle; the aisle order itself is
`shopping_categories.sort_order`. Read order is category → `is_checked` → `sort_order` →
`created_at`, so checked items stay at the end of their group regardless of rank. Ranks start at 1:
0 means "not yet placed" and is the marker an `AFTER INSERT` trigger watches, which appends new rows
to the end of their category. The trigger, rather than the callers, owns that rule because nine
insert sites across six modules (shopping, meals, recipes, housekeeping, `mcp/tools`,
`caldav-reminders-sync`) write into this table, and a row left at 0 would silently jump to the top.
Changing an item's category re-ranks it to the end of the target, as does the fallback move when a
category is deleted — that offset is computed per list *before* the update, since a subquery would
already count the row it is moving. Migration v133 backfills existing rows by `created_at`, so the
order a list shows today survives the upgrade.

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
| meal_types | TEXT | NOT NULL, default `breakfast,lunch,dinner,snack` — comma-separated suitability list; drives which planner slots a recipe fits and the week randomizer's candidate pool (v1.3.0). **Empty means "no meal"**, not "all" (v2.8.1): a recipe with every box cleared is deliberately kept out of the randomizer and the meal filters. An absent field in a request still defaults to all four, so a client that never sends one is unaffected |
| created_by | INTEGER | FK → Users (CASCADE delete) |
| provider_account_id | INTEGER | nullable, FK → Recipe Provider Accounts (CASCADE delete); NULL = native recipe, set = mirrored (migration v118, renamed v134) |
| provider_recipe_id | TEXT | nullable (the provider's own recipe ID; upsert key on repeated syncs, migration v118, renamed v134) |
| provider_updated_at | TEXT | nullable (the provider's `updatedAt`; unchanged recipes are skipped, migration v118, renamed v134) |
| provider_slug | TEXT | nullable, adapter-defined (Mealie: its recipe slug, for rebuilding `recipe_url` without a re-fetch; Tandoor: the relative image path, for the thumbnail proxy; migration v120, renamed v134) |
| provider_has_image | INTEGER | 0/1, NOT NULL default 0 (migration v120, renamed v134) |

UNIQUE partial index on `(provider_account_id, provider_recipe_id)` where `provider_account_id IS NOT NULL`.

### Recipe Ingredients
| Column | Type | Constraint |
|--------|------|-----------|
| recipe_id | INTEGER | FK → Recipes (CASCADE delete), NOT NULL |
| name | TEXT | NOT NULL |
| quantity | TEXT | |
| category | TEXT | NOT NULL (default 'Sonstiges') |

### Recipe Provider Accounts (migration v118, v119, v134)
Connections to a self-hosted recipe provider instance ([Mealie](https://mealie.io) or [Tandoor](https://tandoor.dev))
for the Recipes module. Admin-managed in Settings → Kitchen. The mirror is **read-only**: the provider
stays the source of truth for recipe content, so editing or deleting a mirrored recipe returns 403
server-side (not merely hidden in the UI) - "Duplicate" forks one into an editable native recipe instead.

| Column | Type | Constraint |
|--------|------|-----------|
| provider | TEXT | NOT NULL, default `'mealie'`, CHECK IN (`'mealie'`, `'tandoor'`) (migration v134) |
| name | TEXT | NOT NULL (display name) |
| base_url | TEXT | NOT NULL, UNIQUE — must be reachable **from the server** (often a Docker-internal Compose hostname) |
| external_url | TEXT | nullable (migration v119) - public address used only to build "Open in Mealie/Tandoor" deep links; falls back to `base_url` when blank |
| api_token | TEXT | NOT NULL (write-only; never returned by the API, protected by optional SQLCipher) |
| enabled | INTEGER | 0/1, NOT NULL default 1 |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at / updated_at | TEXT | ISO 8601 (`updated_at` via trigger) |
| last_sync | TEXT | nullable |
| last_error | TEXT | nullable |

`base_url` is UNIQUE so the same provider server cannot be added twice and mirror every recipe in
duplicate. Deleting an account cascades to its mirrored recipes.

**Adapters:** each provider implements a shared interface (`server/services/recipe-providers/index.js`
dispatches on the `provider` column, mirroring the DMS module's paperless/papra pattern) -
`testConnection()`, `listRecipeSummaries()`, `getRecipe()`, `recipeUrl()`, `fetchThumbnail()`. Adding a
third provider means implementing this interface, not touching sync/routes/frontend.

**Sync:** hourly scheduler plus a manual trigger, `server/services/recipe-provider-sync.js`, provider-
agnostic - it iterates every enabled account regardless of provider in one pass. A failed or empty fetch
never prunes existing mirrored recipes - an unreachable provider leaves the local copies alone rather
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

**Best-before notification (#811, v2.45.0).** A `pantry_item` reminder is created for every item
that carries an `expires_on`, has a `created_by` who may see the pantry, and holds a quantity above
zero. The lead time is the same seven days that turn the row yellow - two numbers for one question
would put the notification on a day when nothing is marked; a guard in `test/test-frontend-audit.js`
keeps both definitions together, and the same guard covers the inventory warranty threshold. There
is no per-item lead time on purpose: an inventory deadline is maintained one at a time, a pantry is
bulk goods.

The date itself is the switch - salt and rice stay silent without one. An empty pack does not
notify: the chip may show "expiring soon" at quantity 0 because a list is passive, but a
notification interrupts, and there is nothing left to save. Refilling brings the reminder back,
because every write path goes through `syncPantryExpiryReminder()`.

**Fresh produce is the main case here, not the exception.** Milk and yoghurt usually have fewer
than seven days left when bought, so their lead time has already passed at entry. Discarding such a
reminder - which is what inventory warranties do, where it only happens for a back-dated appliance -
would silence the feature for exactly the items it exists for. On a write the reminder is therefore
**clamped** to the next 09:00 that still falls on or before the best-before date, computed in
calendar days of the household time zone; what has already expired does not notify at all.

The notification run reconciles the whole pantry once per pass (`syncAllPantryExpiryReminders()`):
stock that predates the feature was never saved through the app and would otherwise never notify.
That pass only **adds and clears** - it never replaces a delivered or dismissed row, and it does not
clamp, so an upgrade cannot fire every soon-expiring item at once on the first morning.

`pantry_item` reminders are **derived, not entered**: `POST`, `PUT` and both `DELETE` paths reject
them with 400 (see the Reminders section), because the run would recreate them within a minute.

### Calendar Events
| Column | Type | Constraint |
|--------|------|-----------|
| title | TEXT | NOT NULL |
| description | TEXT | |
| start_datetime | TEXT | DATETIME, NOT NULL |
| end_datetime | TEXT | DATETIME |
| all_day | INTEGER | 0/1 |
| location | TEXT | |
| color | TEXT | HEX, **nullable** (migration v166). `NULL` means "this appointment has no colour of its own" and is the state a new appointment starts in - it then borrows the assignee's colour, see the colour-sync section. Was `NOT NULL DEFAULT '#007AFF'` until v2.48.0, which made every appointment carry one and left the fallbacks in `resolveEventColor()` unreachable |
| icon | TEXT | Lucide icon name, default 'calendar' |
| assigned_to | INTEGER | FK → Users (legacy single-user field, kept for backwards compat) |
| created_by | INTEGER | FK → Users, NOT NULL |
| external_calendar_id | TEXT | ID from external calendar |
| external_source | TEXT | local, google, apple, ics, caldav |
| recurrence_rule | TEXT | iCal RRULE — supported subset `FREQ` (DAILY/WEEKLY/MONTHLY/YEARLY), `INTERVAL`, `BYDAY`, `BYMONTHDAY` (only `-1`, and only under MONTHLY; v2.61.0), and a mutually-exclusive end condition `UNTIL` **or** `COUNT`. Stored in **both spellings**: locally created series hold the bare rule body, series read in from CalDAV/ICS hold the full line including its `RRULE:` prefix. Unifying them would cost more than a migration is worth, so every *output* path has to resolve the ambiguity instead — through `rruleValue()` (bare value, for APIs that want the value) and `rruleLine()` (the ICS line with exactly one prefix), both in `server/services/recurrence.js` since **v2.12.0** (#761). Until then each of six modules built the line for itself, five correctly and one not: the export feed put a prefix in front of a rule that already had one and emitted `RRULE:RRULE:FREQ=...`, which Apple tolerates and strict parsers reject. An unchanged rule is written back verbatim rather than rebuilt from the form, so parts outside the supported subset (`WKST`, `BYMONTHDAY`, `BYSETPOS`) survive an edit to any other field (v2.8.1, #756). **A monthly series on the 29th to 31st clamps to the last day of a short month rather than skipping it (v2.60.0).** Until then the clamp never took effect: `setUTCMonth()` had already rolled over on a date still carrying the 31st, so `lastDay` was computed for the month the overflow had landed in, and February simply fell out — a monthly task on the 31st arrived in seven months out of twelve, and with `INTERVAL=2` the skipped month shifted the rhythm as well. It affects tasks and calendar events alike, since `expandRecurringEvents` walks the same function. **Both remaining halves of that were closed in v2.61.0** (#960, #978), because they had one cause: the intended day was derived from the *previous* occurrence, and a clamp in a short month therefore rewrote it for good. Two ways out, and the code carries both. The **rule** can name the day: `BYMONTHDAY=-1`, "on the last day of the month", and nothing else. That is the one statement a start date cannot express, since it means a different day every month; "on the 15th" needs no field, because you create the series on the 15th. **Reading the wider range was tried and taken back** in review: accepting values the engine cannot honour opened seven failure cases at once - RFC 5545 wants `BYMONTHDAY=31` to be *omitted* in February rather than clamped, `1,15` means two days a month, `FREQ=YEARLY;BYMONTHDAY=-1` means twelve occurrences a year rather than one, and under DAILY/WEEKLY the component filters days instead of setting them. A value that is read but computed wrongly moves appointments silently, while one that is ignored leaves the series on its DTSTART day - which is what it did before. So the parser, the validator regex and the ICS import reducer all accept exactly `-1` under `FREQ=MONTHLY`; everything else passes through untouched, and an edit returns it verbatim (#756). The **caller** can name it instead: whoever knows DTSTART passes it as an anchor, which the calendar expansion, the ICS parser and the series arithmetic all do - they iterate from the series start anyway. `nextDueAfterCompletion` cannot, because a task series is a chain of separate rows that does not know its origin, and there the previous behaviour stands. One consequence worth naming: **the Outlook push drops the recurrence entirely for such a series** rather than sending a different one. Graph has no absolute last-day pattern, and the obvious substitute is not one - `relativeMonthly` with `index: "last"` over all seven weekdays reads like "the last day" but selects the first day matching the pattern, and it would come back through ICS as a `BYSETPOS` rule this engine does not read. A single appointment in Outlook is visibly incomplete; a series on the wrong day is not. Because the sync updates via PATCH, where an omitted field is left unchanged, the payload sets `recurrence: null` explicitly - otherwise the remote copy would keep its previous recurrence while the content hash recorded the update as converged |
| tzid | TEXT | IANA time zone of a synced recurring series (e.g. `Europe/Berlin`), nullable (migration v97). Lets the expansion keep the local wall-clock time across DST; NULL = floating/UTC. Written by CalDAV, Apple and - since v2.27.0 (#829) - Google, which sends the zone in `start.timeZone` |
| subscription_id | INTEGER | FK → ICS Subscriptions (CASCADE delete) |
| user_modified | INTEGER | 0/1 — prevents sync overwrite when 1. Set on **any** edit to a mirrored appointment, which is why it no longer gates the colour, see below |
| color_modified | INTEGER | 0/1 (migration v167, #899) — the colour's own state: `1` means "this colour is managed locally", set only when `color` actually changes and by the upload paths for a colour they just sent to a provider. Inbound gates the colour column on this instead of `user_modified`, which a mere title edit already flips; and `color IS NULL AND color_modified = 1` is the *cleared* state the outbound may mirror, as opposed to a colour that was never learned. Backfilled as `color_modified = user_modified` |
| calendar_ref_id | INTEGER | FK → External Calendars (ON DELETE SET NULL) |
| attachment_name | TEXT | Original filename of attached file, nullable |
| attachment_mime | TEXT | MIME type (e.g. image/jpeg, application/pdf), nullable |
| attachment_size | INTEGER | File size in bytes, nullable |
| attachment_data | TEXT | Legacy Base64 data URL of attachment (≤ 5 MB), nullable; new attachments leave this NULL |
| attachment_document_id | INTEGER | FK → Family Documents (SET NULL on delete), nullable (migration v38) |
| target_caldav_account_id | INTEGER | FK → CalDAV Accounts (for outbound sync), nullable |
| target_caldav_calendar_url | TEXT | CalDAV calendar URL (for outbound sync), nullable |
| target_google_calendar_id | TEXT | Google calendar ID for outbound sync, nullable. Mutually exclusive with the CalDAV target columns — an event syncs to at most one destination |
| target_outlook_account_id | INTEGER | Outlook account ID for the one-way push (migration v134), nullable. Mutually exclusive with the other target columns |
| target_outlook_calendar_id | TEXT | Microsoft Graph calendar ID for the one-way push (migration v134), nullable |
| visibility | TEXT | NOT NULL DEFAULT `all` — `all` \| `assignees` \| `private`; who may see the event (migration v78, same rule as Tasks) |
| countdown | INTEGER | NOT NULL DEFAULT 0 (migration v150, #647) — 1 puts the event on the Countdown widget. A Yuvomi-only display setting in the same group as `icon` and `visibility`: it is not in `MIRRORED_FIELDS`, so setting it pushes nothing to Google or CalDAV, and the inbound path writes a fixed column list, so it survives every sync run. For a recurring series the widget counts to the **next** occurrence, skipping any date excluded via [Calendar Event Exceptions](#calendar-event-exceptions) |

**Countdown (migration v150, #647):** a countdown is a flag on something that already exists, not an object of its own. The **Key dates** widget on the overview (`dashboard.countdownTitle`) merges the flagged calendar events and the flagged tasks into one list sorted by how near they are, and each row leads back to its own object — a task row opens the task quick-action, an event row deep-links to `/calendar?open=<id>&date=<next occurrence>`.

The wording is coarse while the date is far off and exact once it is near (`public/utils/countdown.js`): exact days up to 30, then about-weeks, about-months, about-years. The switch is built in rather than offered as a setting — "10 days until the licence expires" has to stay 10 days, and a threshold for a display detail is a question nobody wants to be asked.

**Colour carries urgency, not origin** (`countdownRank()`, four ranks): `overdue` red, `now` (today/tomorrow) amber, `soon` (≤30 days, the exactly-counted band) label colour, `later` secondary. The 30-day boundary is the same one at which the wording switches, so the tile has one idea of "near" rather than two. The origin colour stays on the mark at the left, where the 16%-tint/35%-mix recipe applies — the same one the calendar uses for `--ev-color`, because a user-chosen event colour is not a curated module tone (see the limit of the accent-on-tint rule under Colors).

**A passed date stays for `OVERDUE_GRACE_DAYS` (7)** and is shown as "3 days ago", sorted to the top because its day count is negative. It used to drop out immediately; for events "overdue" exists nowhere else, and the thread's own motivating case is an expiry date, so the countdown vanished exactly when the consequence began. **Recurring entries are exempt** — a yearly renewal is never "expired", it has a next turn. What does not fit the tile is named (`+N more`) rather than cut silently; `countdownTotal` travels beside the list for that, like `birthdayCount` beside `birthdays`.

**The task switch requires a due date** and is disabled without one (`wireCountdownGate`), and the detail row is conditioned on `countdown && due_date` — it previously saved a flag that could never surface and then asserted "counts down on the overview" about it.

The widget is not offered at all while nothing is flagged, in the same way the Family widget is absent in a single-person household. It is deliberately **not** in the agenda view: the agenda answers "what is happening in the coming days", and a countdown that resolves in 2027 would be noise at the bottom of every view.

**A disabled module drops out server-side**, before the sort, the cut to five and `countdownTotal` — unlike every other tile, whose module filter can safely sit in the browser because the tile itself belongs to that module and disappears with it. This one belongs to two, and its mere availability is derived from the filtered set: with the calendar disabled and the five nearest countdowns being events, a browser-side-only filter discarded all five and took the tile out of the grid *and* the Customize tray, while the flagged task behind them had never been sent. The browser filter stays as a second instance, for a module toggled without a reload. **A module withheld from the member** (`access_permissions`, #467) is filtered in the same place and by the same cut: household-wide disabling and per-member rights are two axes of one question here — may this viewer see this row — so `getCountdowns()` merges both into one hidden-module set rather than applying two filters in sequence, which would give the cut and `countdownTotal` different ideas of the set. The two sources stay independent of each other: a member without calendar access keeps the task countdowns.

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

**Editing and deleting occurrences of a recurring series (migration v85 · #532):** deleting *or* editing an event of a recurring series offers the standard scope choice — *only this event*, *this and following*, or the *whole series* — via one shared control (a select defaulting to "only this event", the least-destructive option). **Delete:** "only this event" records an exception (EXDATE) and the series continues; "this and following" truncates the series' RRULE with an `UNTIL` bound at the day before the occurrence (or deletes the whole series when the occurrence is the first); "whole series" deletes the master. **Edit:** "only this event" writes an exception for that date and creates a detached, non-recurring event carrying the edits; "this and following" truncates the master and creates a new series from the occurrence with the edited fields; "whole series" updates the master while preserving its `DTSTART` (the edited instance's time shift is re-applied to the series anchor instead of re-anchoring the series to the instance). The recurrence expansion skips excluded dates on every read path (list, upcoming/dashboard, search), and exceptions are emitted as `EXDATE` lines in the ICS export feed. The scope choice is offered for **local series only** — externally synced series (Google/Apple/CalDAV via `calendar_ref_id`, ICS via `subscription_id`) keep whole-series behavior, since an EXDATE or truncation would return on the next sync. **Those now say so before they do it (v2.47.0 · #880):** whole-series delete is the right scope, but doing it wordlessly is not - tapping one occurrence in the month view and pressing delete made every occurrence disappear without a prompt. A foreign series asks for confirmation that *names* the reach rather than offering a choice (a dialog with one selectable answer would be a prop), and the wording follows what actually happens, because promising something that does not hold is worse than promising nothing: a **birthday event** mirrors a `birthdays` row and `syncBirthdayCalendarEvent` recreates and re-uploads it on the next run, so it says the entry has to go via the birthday itself; an **ICS subscription** event cannot be deleted at the source at all (`OUTBOUND_SOURCES` has no `ics`) and `ics-subscription.js` keeps no tombstones, so the next fetch inserts it again; everything else is told that the whole series falls, with all its occurrences - **not** that it also falls in the source calendar, since `acceptsOutbound()` requires a writing connection that a read-only Google account or a removed CalDAV account does not have. `isLocalRecurringSeries`/`isExternalRecurringSeries` live in `public/utils/recurrence-scope.js` next to the scope arithmetic rather than in the page: a rule that decides over data loss has to be testable without half a browser, and until then it had no test at all. `POST /api/v1/calendar/:id/exceptions { date }` records an exception; series deletion removes its exceptions via CASCADE. **"The first occurrence" stopped meaning "the stored date" in v2.61.0 (#960).** A start may sit off its own rule - a `BYMONTHDAY=-1` series begun on the 15th, or the older case of a `BYDAY=MO` series begun on a Saturday (#549, how some calendars serialise it). The first appointment shown is then a date the master does not carry, and the scope flow asked `is_recurring_instance` - "does this differ from the stored date?" - which had been indistinguishable from "is this not the beginning" only because every start used to sit on its rule. Truncating there writes an `UNTIL` in front of the first occurrence and leaves a series with nothing in it: the appointment vanishes while its row stays behind with its assignments and exceptions. The expansion therefore marks the first occurrence as `is_series_start` (it counts occurrences for `COUNT` anyway), and `followingMeansWholeSeries()` in `public/utils/recurrence-scope.js` answers the question once for both flows rather than each deciding for itself - the same wrong assumption stood twice, and a third call site would have inherited it. `is_series_start` is computed per expanded instance and is not a stored column.

**Finite recurrences via `COUNT` (#513):** a series may end after a fixed number of occurrences (`COUNT=N`) instead of on a date (`UNTIL`) — the two are mutually exclusive. `COUNT` counts from the series start and **includes** excluded occurrences (RFC 5545: the limit applies to the recurrence set *before* `EXDATE` removal), so `COUNT=10` with one excluded date yields nine visible instances. The event dialog exposes this as an *Ends: Never / On date / After N occurrences* selector (calendar only — tasks are completion-driven and keep Never / On date). **The interval says that it is adjustable (#862):** `INTERVAL` lives in the detail block, which carries `hidden` until a frequency is picked, so the four options read like fixed values - a reporter opened a thread asking for custom intervals and only found them by picking one on the off chance. A line under the select now states that the interval is free to set and names two examples; it and the detail block are complements, never both shown and never both hidden. `aria-describedby` ties it to the select and is **removed along with it** - a node referenced directly by `aria-describedby` counts towards the accessible description even while hidden (accname 1.2 §4.3.1 exempts exactly the directly-referenced ones from the hidden rule), so leaving the reference in place would keep reading the hint to screen-reader users after sighted ones stopped seeing it. Task and appointment forms share `renderRRuleFields()`, so both carry it. A one-time ICS import preserves `COUNT` on the stored rule and records the file's `EXDATE` lines as exceptions, so a finite Google/Apple export stays finite instead of becoming an endless series; ICS subscriptions honour `COUNT` and `EXDATE` the same way when expanding the feed.

**`COUNT` is enforced by whoever knows the series start (#877).** `nextOccurrence()` is stateless and cannot know which occurrence it is producing, so the limit is applied by the callers that hold the start: the expansion (`expandRecurringEvents`, which counts from DTSTART) and, since v2.45.x, `nextOccurrenceAfter(..., { seriesStart })`. Without the second one the key-dates tile counted a finite series forever and even named a date in the future. It is deliberately an argument rather than an assumption: `nextDueAfterCompletion()` passes the due date of the instance just ticked off, not the series start, and counting from there would make a series grow with every completion. For monthly and yearly series starting after the 28th the limit is not applied - such a series does not run on a fixed grid (June 31st does not exist, so it slides and then drifts), and a limit set too early would cut off occurrences that still exist. Catching a long-running series up to today jumps in interval steps rather than counting one by one, with the same after-the-28th exception; before that, a daily series older than roughly three years ran out of steps and vanished from the tile.

### Calendar defaults for new events (per-user)
Three per-user preferences prefill the new-event dialog (stored in `sync_config` under a per-user key, like `module_order`):
- **`calendar_default_reminders`** — a list of reminder offsets (minutes before start, subset of the reminder presets, max 5) that new events receive automatically.
- **`calendar_default_assign_me`** — when on, new events are pre-assigned to the current user.
- **`calendar_default_target`** (#620) — the sync target a new event starts out pointing at. Stores the same identifier the event dialog uses: `''` (store locally only), `google:<calendarId>`, `caldav:<accountId>|<calendarUrl>` or `outlook:<accountId>|<calendarId>`, built and parsed by the shared isomorphic util `public/utils/sync-target.js` so that server validation and both front-end call sites cannot drift apart. The server validates the *shape* only, never the existence: a calendar may be disabled, deleted or turned read-only long after it was chosen here, and checking on save would pull a Google API call into every settings write without preventing that. Instead the event dialog resolves it at open time — a target that is no longer offered leaves the selection on "store locally only" rather than pointing a new event at a calendar that cannot accept it. The settings field is hidden while no Google, CalDAV or Outlook calendar is connected, but reappears whenever a target is stored, so a stale one can always be cleared.

All three are configured in Settings → Personal → Event defaults and apply only when creating an event (never on edit); a date-based sync default assignee still takes precedence for imported events. Per-user rather than household-wide by design: which calendar a person feeds is a personal decision, and the inverse mapping already exists as `external_calendars.default_assignee_user_id` (which person imported events from a calendar are assigned to).

### Task defaults for new tasks (per-user)
- **`tasks_default_target`** (#695) — the CalDAV reminder list a new task starts out pointing at, in the same identifier format as `calendar_default_target` (`''` or `caldav:<accountId>|<listUrl>`; a `google:` value is rejected, because the VTODO sync runs over CalDAV only). The server validates the shape here and the *eligibility* in `POST/PUT /api/v1/tasks` — a list that was deselected in the meantime must not make the setting unsavable, but it must not silently park a task in a queue that will never drain either.

Configured in Settings → **Personal** → Task defaults, deliberately not next to the reminder lists in Settings → Sync: which lists the household syncs at all is an admin decision, which of them *my* new tasks go to is mine, and the value is written per user. The field is replaced by a hint while no list is enabled for tasks.

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

**Default assignee per sync target (migration v79):** each synced calendar (Google/Apple/CalDAV via `external_calendars`, and each ICS subscription) can carry an optional `default_assignee_user_id`. Newly imported events of that target are automatically assigned to that person — **new events only**, never retroactively, so a manually removed assignment does not reappear on the next sync. Configured per calendar row in Settings → Sync. The picker stands on **every** calendar of a connected account, including before it is ticked (v2.8.1, #730): `PATCH /api/v1/calendar/external-calendars` creates the `external_calendars` row itself when it does not exist yet, taking the display name from the provider's own selection list — which is also the limit, since only a calendar the connected account actually offers can get a row this way. Before that the picker appeared only after the first sync, by which time the first and usually largest batch of events had already arrived unassigned. `POST /api/v1/calendar/subscriptions` accepts `default_assignee_user_id` for the same reason: creating a subscription syncs immediately. Nulled automatically when the referenced user is deleted.

### Holiday Cache
Cached public holidays and school holidays from the free [OpenHolidays API](https://openholidaysapi.org)
(no API key). Populated by an admin-configured country/subdivision in Settings → Modules → Calendar and refreshed
by the auto-sync scheduler (covers previous, current, and next two years - plus, whenever the scope changes, any further year still sitting in the cache from an earlier run, since `getForRange()` has no window and would otherwise keep showing those in the old language forever). Displayed as a read-only
overlay in the calendar; layer visibility is toggled client-side. Outbound requests carry only the
country/subdivision code — no household data leaves the server.

**Names follow the data language, not the country (v2.57.0, #946).** A holiday is content Yuvomi stores itself, so it falls under the "language of stored entries" setting (`resolveHouseholdLocale`) - the same source birthdays, loan instalments and notifications use. Previously the service derived the language from the *country*: picking Spain stored "Navidad" even for a household that had explicitly chosen English, while the hint under the setting promises it affects "the API, calendar feed and synchronisation". The request deliberately omits `languageIsoCode`: with it, OpenHolidays returns exactly one name per holiday and falls back to the country language when the requested one is missing, leaving nothing to choose from. Without it the full `name` array arrives and the cascade runs here - requested language, else English (which OpenHolidays carries for nearly every country), else the first offered. `sync_config.holiday_last_sync_scope` records what the last **complete** run covered, and the scope is the full identity of that run: **language, country, subdivision and the enabled layers**. Change any one of them and the next scheduler pass syncs, because each of the four decides what ends up in the cache - the marker held only the language at first, which left a re-enabled layer and a changed country showing their old names. The cache stores translated names rather than keys, so without this a change would otherwise keep the old wording for up to 30 days.

A run that fails any fetch **deletes** the marker rather than leaving the old one: a partial run leaves the cache *mixed*, and keeping the previous scope would make switching back to it look unchanged, freezing the already-converted parts for a month. With no marker every scope counts as new until one run completes. Against a runaway loop, a failed run writes `holiday_retry_after` (one hour out) with `holiday_retry_scope`, which throttles **only that exact attempt** - any other scope proceeds immediately, and the scheduler runs every `SYNC_INTERVAL_MINUTES` (15 by default), so an outage of the free upstream API must not trigger a fresh attempt each pass.

Syncs are **serialized** inside the service: the scheduler and the manual "sync now" route both call in without coordination, and across the await points of the year loop an older run could overwrite years a newer one had already converted while the newer one recorded its scope as complete - a two-language cache treated as current for 30 days. A second caller waits and then runs itself rather than receiving the first one's result, so it reads its configuration when its turn comes and sees the current selection.

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
`holiday_show_school`, `holiday_public_color`, `holiday_school_color`, `holiday_last_sync`, `holiday_last_sync_scope`, `holiday_retry_after`, `holiday_retry_scope` (all admin-only).

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
| enabled | INTEGER | 0/1, controls sync for this calendar. **Opt-in since v2.10.0:** connecting an account stores every calendar it finds as unticked, and so does a calendar the server newly reports on a refresh — before that, an account with work, birthday and holiday calendars pushed all of them into the household on connect, and each one had to be emptied by hand afterwards. Refreshing the list (and changing the account's credentials) rebuilds these rows but **keeps the stored state per `calendar_url`**; until v2.8.1 both paths wrote everything back as enabled, so a deliberately unticked calendar returned to the sync unasked, along with its events on the next run (#732) |
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

### Outlook Accounts
Connected personal Microsoft accounts (outlook.com / M365 Family) for the one-way Outlook push
(migration v134). Multi-account like CalDAV Accounts; OAuth tokens live per account row, **not** in
`sync_config`. Reconnecting the same Microsoft account (matched via `ms_user_id`) replaces the
tokens instead of creating a duplicate.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name | TEXT | Display name (defaults to the Graph profile name), NOT NULL |
| ms_user_id | TEXT | Graph `/me` id, nullable; partial UNIQUE index for reconnect-upsert |
| email | TEXT | Graph `mail`/`userPrincipalName`, nullable |
| access_token / refresh_token | TEXT | OAuth tokens, NOT NULL (refresh tokens rotate; ~90-day sliding expiry for MSA) |
| token_expiry | TEXT | ISO 8601 access-token expiry, nullable |
| needs_reauth | INTEGER | 0/1 — set on `invalid_grant`; sync skips the account until reconnect |
| auto_sync_calendar_id | TEXT | Graph calendar id of the auto-sync target, nullable |
| owner_user_id | INTEGER | FK → users, nullable — whose "visible events" the auto-sync pushes |
| created_at / last_sync / last_error | TEXT | Bookkeeping, nullable |

**Auto-sync:** when both `auto_sync_calendar_id` and `owner_user_id` are set, every **local** event
visible to the owner (per `visibilityWhere()`, the same enforcement as all read paths) is pushed
automatically into that one calendar — the recommended setup is a dedicated "Yuvomi" calendar in
Outlook. Externally synced events (google/caldav/ics/apple) are deliberately excluded (they
typically already exist natively in Outlook and would duplicate). Assigned members appear as a
title suffix `Titel (Anna, Ben)` (alphabetical, same convention as the ICS export feed #482);
since the names are part of the pushed payload, assignment changes trigger a `PATCH` via the
content hash. An explicit per-event target on the same account overrides the auto-sync calendar.

### Outlook Calendar Selection
Calendars of a connected Outlook account, loaded from Graph on connect (refreshable); `enabled`
calendars appear as push targets. Newly discovered calendars start **disabled**: the connect flow
guides the admin to create a dedicated target calendar and pick exactly one auto-sync target,
which is enabled implicitly when chosen.

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| account_id | INTEGER | FK → Outlook Accounts (CASCADE delete), NOT NULL |
| calendar_id | TEXT | Microsoft Graph calendar id, NOT NULL |
| calendar_name / calendar_color | TEXT | Display metadata (color from Graph `hexColor`), color nullable |
| can_edit | INTEGER | 0/1 from Graph `canEdit` — read-only calendars are never pushed to |
| enabled | INTEGER | 0/1, offers the calendar as push target |
| UNIQUE | | (account_id, calendar_id) |

### Outlook Event Links
Push state per (event, account) for the one-way Outlook push — one event can sync into several
accounts' calendars. **Deliberately no FK on `calendar_events`**: the row must survive deletion of
the local event so the next sync can delete the remote event in Outlook (tombstone). Unlike the
Google/CalDAV outbound there is **no handoff** to `external_source='outlook'` — without an inbound
sync the event would freeze after the first push, so pushed events stay `external_source='local'`
permanently (and the `calendar_pending_deletions` / `outbound_dirty` mechanism of #593 does not
apply to them).

| Column | Type | Constraint |
|--------|------|-----------|
| event_id | INTEGER | Part of PRIMARY KEY (event_id, account_id); no FK — tombstone semantics |
| account_id | INTEGER | Part of PRIMARY KEY; FK → Outlook Accounts (CASCADE delete), NOT NULL |
| outlook_calendar_id | TEXT | Graph calendar the event was pushed to, NOT NULL |
| outlook_event_id | TEXT | Graph event id, NOT NULL |
| content_hash | TEXT | SHA-256 of the last pushed payload — unchanged events are no-ops |
| outlook_change_key | TEXT | Graph ETag after Yuvomi's last own write, nullable — the basis of drift reconciliation |
| last_pushed_at / last_error | TEXT | Bookkeeping, nullable |

**Drift reconciliation:** every sync run lists each linked calendar once
(`GET …/events?$select=id,changeKey`, paged — one small request per calendar per run). An event
whose remote `changeKey` no longer matches the stored one was edited in Outlook and is `PATCH`ed
back to the Yuvomi state; an event missing from the listing was deleted in Outlook and is
re-created. Events without a link row (created directly in Outlook) are never touched, and a
failed listing only skips reconciliation for that run — the push itself still works. This is what
makes "Yuvomi is the source of truth" hold against remote edits at every interval, at the cost of
roughly one extra request per calendar per run.

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

**iCloud is not a source for Apple Reminders (#677).** With iOS 13 / macOS 10.15 the upgraded
Reminders app moved its lists into a private store; over CalDAV iCloud still serves only the VTODO
collections that predate that switch - usually none, sometimes a single orphaned one that the
Reminders app itself no longer shows. The effect reads exactly like broken discovery, because the
calendars of the same account arrive in full, and no amount of client-side searching can widen it.
The reminders leaf therefore states the limitation on every account whose URL is an iCloud host,
and only there: Nextcloud, Radicale and Baikal publish their task lists normally, and a blanket
note would teach their users to distrust a working sync.

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
- **Creating: outbound since migration v136 (#695).** Until then this was out of scope, on the
  grounds that a task carried no selectable target. That reason had expired: events have had a
  per-person default target since v1.79.0 (#620), and the interface promised sync "in both
  directions" the whole time. A task created in Yuvomi now names its destination in
  `target_caldav_account_id` + `target_caldav_list_url`; the sync uploads it and turns it into an
  ordinary mirror, after which it runs through the change and deletion paths above unchanged. Four
  rules hold it together:
  - Only lists the household enabled **for tasks** are offered (`caldav_reminder_selection`,
    `target_module = 'tasks'`), checked in the route *and* again in the service. A list mapped to
    Shopping would send a task out and bring it back as a shopping item.
  - The upload is the **last** step of a sync run. The prune before it removes mirrors the server
    does not list, and a task uploaded any earlier would be deleted seconds after it arrived.
  - The UID is derived from the task id (`yuvomi-task-<id>@yuvomi.local`), not drawn at random: a
    run that dies between the upload and the bookkeeping overwrites its own object next time
    instead of leaving a duplicate.
  - **Subtasks are excluded.** As standalone VTODOs they would stand beside their parent as equals,
    and the relation that makes them subtasks would be lost — `RELATED-TO` exists in RFC 5545 but
    the inbound does not read it, so the round trip would return them as loose tasks.

  A failed upload is neither counted nor given up on: unlike a change it has no state that could go
  stale, so it stays queued until it succeeds or the target list disappears (in which case the task
  is released back to local rather than retried forever). Moving an *already uploaded* task between
  lists remains out of scope — a task belongs to the list it came from.
  `tasks_default_target` (per user, same `caldav:<accountId>|<listUrl>` identifier as
  `calendar_default_target`) preselects the destination in the dialog.
- **Lossy mappings are held from both ends.** Yuvomi has four priority levels and three statuses,
  RFC 5545 three priority bands and no "in progress". `urgent`/`high` share the top band and
  `in_progress` maps out as "not completed", so the inbound keeps the finer local value whenever the
  server reports the same band — otherwise every pushed *urgent* task would come back as *high* on
  the next run. The archive never enters this mapping: since #688 it lives in `archived_at`, so a
  filed-away task syncs on its real status and the sync cannot overwrite the filing.
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
DB-backed, customizable category list for contacts. Replaces the old hardcoded German-named set. The seven predefined keys (`doctor`, `school`, `authority`, `insurance`, `craftsman`, `emergency`, `misc`) carry a stable slug key (which, together with `icon`, drives the list grouping), a localizing `label_key`, a Lucide `icon`, and a `color`; the pre-existing German category values (`Arzt`, `Behörde`, …) are migrated to these keys. User-added categories store their `name` and default to the `tag` icon. A "Manage categories" button in the contacts toolbar opens the shared `yuvomi-category-manager` modal to add, rename, recolor, reorder, and delete categories, with the same in-use / last-category deletion guards as Tasks and Budget.

| Column | Type | Constraint |
|--------|------|-----------|
| key | TEXT | PRIMARY KEY — stable slug |
| name | TEXT | custom display name; NULL for predefined (localized) categories |
| label_key | TEXT | i18n key for predefined categories; NULL for custom |
| icon | TEXT | NOT NULL DEFAULT `tag` — Lucide icon name |
| color | TEXT | nullable (migration v152) — one of the seven curated tones, stored as the token expression (`var(--color-success)`); NULL means no tone |
| sort_order | INTEGER | NOT NULL |
| created_at | TEXT | |

**Category colour (migration v152):** the tone was written as seven CSS rules keyed by the slug
(`.contact-group--<key>`), which by construction could only ever match the predefined keys — every
user-added category fell back to the module tint, so two of them were indistinguishable. It now
lives with the category. Stored is the **token expression**, not a hex value: the tones are
theme-dependent (`--color-success` is `#1E7B35` in light and `#30D158` in dark) and a hex could not
serve dark mode; the same convention the budget account colours use. The seven selectable tones are
an **allowlist** served by `GET /api/v1/contacts/meta` as `categoryColors`, and `PUT
/api/v1/contacts/categories/:key` rejects anything outside it with 400. The allowlist is not a
limitation but the precondition for the mark: the category disc is a full-tone mark whose ink is the
fixed `--color-ink-on-vivid`, which only holds over curated tones (see the full-tone rule in
DESIGN.md). Sending `{ color }` without `name` changes only the tone — a predefined category keeps
its `label_key` and stays localized.

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
| visibility | TEXT | NOT NULL DEFAULT `shared` — `private` \| `shared` (migration v88) \| `shared_amount` (migration v156, #659) |

Recurring entries are materialised on demand for the month being viewed. **Non-virtual** series post the full amount on each due date, which `occurrenceDatesInMonth()` derives from the series' start date, unit and count; a weekly series therefore posts several times in one month, a monthly one at most once, and a day-of-month past the end of a short month is clamped to its last day. **Virtual** series store the smoothed monthly share on the original and post it once every month regardless of the rhythm, so a 1,200/year bill shows as 100/month in the summary, balance and CSV export; smoothing goes through `occurrencesPerYear(unit, count)`, which counts a year at 52 weeks. A generated instance inherits its owner and visibility from the series original.

**Unit plus count (migration v128, #636).** Until then the interval was a list of three fixed rhythms, so "every two weeks" or "every three months" could not be expressed at all. It is now a unit (`weekly`/`monthly`/`yearly`) with a count of 1 to 99. `half_year` is gone as a key and lives on as `monthly` + 6; the migration converts existing rows, because two spellings for one rhythm would have to be understood by every evaluation forever. The weekday, or the day of the month, is carried by the entry's own `date` - a series starting on the 15th returns on the 15th - so there is deliberately no separate field for it, which would be a second truth beside `date`.

**Booking only after confirmation (migration v129, #637).** A series can require that each generated booking is confirmed before it counts, because not every service debits on the same day or to the cent. Its instances are created with `is_pending = 1`: they appear in the list, marked as expected, but are **excluded from every total** - monthly summary, category breakdown, statistics, plan progress, account balances and the dashboard widget alike. Counting them would leave exactly the discrepancy against the bank statement that the setting exists to remove. What is still outstanding is reported separately (`pending: { count, income, expenses }` on the summary) and shown under the summary cards, so the money does not silently disappear between the list and the totals. `PATCH /api/v1/budget/:id/confirm` books the entry and takes an optional corrected `amount` and `date` - both are editable because their deviation is the whole point; the sign is preserved, so an expected expense cannot become income by typing the amount without a minus. The exclusion lives in one shared SQL fragment (`bookedOnly()`), and `test:budget-structure` asserts the rule over every `SUM` across `budget_entries` rather than over a list of known call sites: a forgotten one would not fail, it would just quietly show a number that is off by one expected booking. The CSV export keeps expected rows but labels them (`Status` column: `Expected` / `Booked`), since the export is a record. Opt-in per series and default 0 together are what protects existing data: without both, every recurring series would have dropped out of the totals on upgrade.

**Skipping is keyed by day, not by month.** Deleting a generated instance records that occurrence in `budget_recurrence_skipped` (`parent_id`, `date`) so it is not silently recreated on the next visit. That table was keyed by month until v128, which was correct while a series had at most one occurrence per month; with weekly series, deleting one Tuesday would have suppressed the rest of the month as well. The migration converts existing month rows to the day the instance would have carried.

**Monthly summary & expenses-only view:** the Budget tab heads each month with three summary cards - income, expenses and the net balance (income − expenses). When a month records only expenses (no income), the balance card renders neutral instead of red, because a bare `−expenses` net misreads as being "in the red" (#504). A per-device **Expenses only** toggle (persisted client-side in `localStorage`, no server preference) collapses the summary to the single expenses card and hides income and the net, for pure expense tracking; the transaction list, category chart and CSV export are unaffected.

**Receipts (migration v112, #583):** an entry can carry documents from the Documents module as receipts — link an existing document or upload a new file straight from the entry modal. Receipts live in `budget_entry_attachments` (`entry_id`, `document_id`, `created_by`, `UNIQUE(entry_id, document_id)`), so one purchase may hold several (till receipt plus invoice plus warranty). The file itself always belongs to the Documents module: deleting the entry drops the link, not the document; deleting the document drops the link and leaves the entry. **Document visibility keeps applying** — a receipt filed as private stays invisible to everyone else even when it hangs on a shared entry, and there is no admin bypass. You can only link what you may see, and saving an entry only removes the links you can see, so another member's private receipt survives your edit. Receipts belong to the single entry, not to a recurring series: updating a series leaves them untouched (each month's bill has its own receipt). The API takes `attachment_document_ids` on create/update — omitting the field leaves existing receipts alone — and returns the visible ones as `attachments`.

**Personal vs. shared budgets (migration v88):** every budget entry (and loan and subscription) carries an immutable `owner_id` (= the creator) and a `visibility` of `shared` (all members) or `private` (owner only). A household-wide **budget mode** setting (`budget_mode` in `sync_config`, `shared` by default, admin-gated) decides whether visibility is enforced at all: in `shared` mode everyone sees everything (the prior, fully backward-compatible behaviour); in `personal` mode the Budget page gains a **My budget / Household** view switcher — *My budget* shows what you own, *Household* shows the shared pot (`visibility = 'shared'`). Enforcement is **server-side on every read path** (entry list, summary, statistics, CSV export, accounts balances, loans, subscriptions, dashboard widget) with **no admin bypass** — a private entry stays hidden even from an admin. Write access to an object requires ownership (owner or creator), also with no admin bypass. New entries default to `private` in personal mode and `shared` in shared mode. This is the lean variant of the split-budget request (#476/#505): a shared entry is one whole row with a "Household" badge, without materialised per-person split rows.

**Amount shared, purpose private (migration v156, #659).** `private` and `shared` answered two questions with one word: whether an entry counts towards the **totals**, and whether it shows its **details**. On a shared account that is too coarse. Someone booking a private expense usually wants to hide what it was *for*, not that money left the account - and hiding both is exactly why everyone else's balance is then wrong, because the account really does hold less. The third level, **`shared_amount`**, splits the two questions apart:

| level | counts towards totals | shows its details |
| --- | --- | --- |
| `private` | owner only | owner only |
| `shared` | everyone | everyone |
| `shared_amount` | everyone | owner only |

Another member sees such a row **with its date, amount and account, but with a neutral placeholder instead of the title, category and receipts**, plus an "Amount only" badge. Leaving the row out entirely was the cheaper option and is the wrong one: the visible rows would then no longer add up to the displayed balance, which reads as a bug rather than as a promise being kept. Because the row carries nothing to open, it is not an edit surface either - no `role="button"`, no delete or confirm action.

The distinction runs through **every** read path, and the two questions need different filters. `budgetVisibilityWhere()` answers *does it count* and lets `shared_amount` through like `shared`; `budgetDetailsVisibleWhere()` answers *may I see what it was for* and is as strict as `private`. Anything that aggregates **by category** needs special care, since a correct total can still leak the purpose through the breakdown: the monthly summary and the statistics tab therefore file another member's `shared_amount` entries under a neutral collecting bucket (`__private__`, translated client-side) rather than under their real category. The CSV export is masked as well - otherwise it would be the most convenient way to read out precisely what the interface hides. In the **Inventory** module the level behaves like `private` and the entry stays invisible: a link between a booking and an object *is* a statement about what the money was for, and unlike a balance, nothing there adds up wrong if the booking is missing.

`shared_amount` sits on the **individual entry** only; loans and subscriptions keep their two levels, and they act through the entries they generate anyway. A value sent to them is rounded **down** to `private`, never up to `shared` - whoever picks the level wants the purpose hidden, so rounding towards the more open level would turn the wish into its opposite.

**Deliberately not a household setting.** That would have been much cheaper - one config value, private amounts count everywhere - and it was rejected for a specific reason: whoever flips it removes the guarantee for *everyone* in the household, including members who wanted it, and an admin could do so unilaterally. A privacy promise a third party can switch off is not one. Keeping the choice per entry leaves it with the person whose privacy it is.

### Budget Accounts
Separate accounts (checking, savings, cash, credit card, investment, other) shown in Budget → Accounts. Each account carries a starting balance; its **current balance** is `starting_balance + Σ assigned entries dated up to today`, and the **projected balance** additionally includes future-dated entries. The Accounts tab shows every account with its current balance plus the household **net worth** (sum of the active accounts' current balances). Entries optionally reference an account (`budget_entries.account_id`); the assignment is set from the entry modal. Deleting an account keeps its entries — their `account_id` is cleared. Account assignment is optional; existing entries stay unassigned. Accounts themselves have no owner or visibility, but in personal budget mode the computed balances and entry counts only include entries the viewer may see, so a private entry never leaks its amount through a shared account's balance. An entry set to `shared_amount` (migration v156, #659) is the deliberate exception: its amount *does* enter everyone's balance and the household net worth, while its title, category and receipts stay with the owner - which is what makes a shared account's balance match the bank again.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| type | TEXT | `'checking'` \| `'savings'` \| `'cash'` \| `'credit'` \| `'investment'` \| `'other'`, default `'checking'` |
| starting_balance | REAL | NOT NULL DEFAULT 0 (may be negative, e.g. credit card) |
| currency | TEXT | Optional ISO code; falls back to the household currency |
| color | TEXT | Optional HEX (`#RRGGBB`) |
| archived | INTEGER | 0/1 — archived accounts are hidden by default and excluded from net worth |
| sort_order | INTEGER | NOT NULL DEFAULT 0 |
| credit_bank | TEXT | Issuing bank, credit cards only (migration v131 · #541) |
| credit_limit | REAL | Agreed credit limit, credit cards only; never negative (migration v131 · #541) |
| created_by | INTEGER | FK → Users, NOT NULL |
| created_at / updated_at | TEXT | ISO 8601 |

**Credit-card metadata (migration v131 · #541).** A credit-card account additionally carries its
issuing bank and the agreed credit limit. From the two, `listAccounts` derives a computed
`available_limit` = `credit_limit - max(0, debt)`, clamped at `0`: only what is owed reduces the
figure, so a balance in favour (credit sitting on the card) never raises it above the limit, and a
card drawn past its limit reads `0` rather than a negative amount. It is `null` for every account
that is not a credit card or has no limit filled in. Both fields belong to the type, not to the
account: the account dialog sends them only while the type is `credit` and `null` otherwise, so
switching an account to another type clears them. In `PUT`, `undefined` leaves a field untouched
while `''`/`null` clears it - a partial update that only changes the name must not silently discard
the bank. A negative limit is rejected with `400`.

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
| logo_data | TEXT | Optional local image data URL, max 500 KB; the UI accepts PNG/JPEG/WebP/SVG and deliberately skips the square crop (transparency, SVG) |
| brand_color | TEXT | Optional HEX color |
| budget_entry_id | INTEGER | Linked pending Budget expense (SET NULL on delete) |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| owner_id | INTEGER | FK → Users, nullable (ON DELETE SET NULL) — owner, fixed to creator (migration v88) |
| visibility | TEXT | NOT NULL DEFAULT `shared` — `private` \| `shared` (migration v88); the linked Budget expense inherits both |

**Optional end condition (migration v107 · #594):** a subscription can define when it ends via an *Ends: Never / On a date / After N payments* selector (mirroring the calendar's finite-recurrence control). Renewing advances to the next cycle until the end is reached — the payment on the end date (or the `occurrence_count`-th payment) is the last — after which the subscription is **marked completed** (`completed_at` set, `enabled` cleared): it drops out of the monthly total, its linked Budget expense and renewal reminder are removed, and it stays visible with a distinct "Completed" state instead of looking manually paused. The 6-month renewal forecast only counts occurrences up to the end. Re-enabling a completed subscription clears the completion; an exhausted *after N payments* subscription can only be reactivated by raising `occurrence_count`. Existing subscriptions default to `never` and behave unchanged.

**Seeded names carry a translation key (migration v170 · #950):** both supporting tables have a `label_key` column, resolved as `label_key ? t(label_key) : name` — the same shape `task_categories`, `contact_categories` and `inventory_categories` already use. The six seeded categories and seven seeded payment methods are stored as English text, and without a key on the row the only thing a client can match on is that text: the categories had such a name table in the frontend, the payment methods had none, so the dialog showed one list translated and the other in English. A name match also cannot tell a default apart from a row the household created under the same name. **Renaming clears the key**, so a name that was typed stays the name that is shown; a colour change is not a rename and leaves it intact. The backfill pairs each seed key with **its own** canonical name — categories via the `budget_subcategory_key` from migration v145, payment methods via the name alone, since brands and fixed terms translate to the same thing — so a deleted-and-recreated default, a renamed one, and one renamed onto another's freed name all keep what the household typed. The cost breakdowns `by_category` / `by_payment_method` group by **row**, not by display text: each entry is `{ id, name, label_key, amount }`, and the catch-all bucket carries `id: null` with the wording left to the caller instead of the former literal `"Uncategorized"` / `"Unspecified"`.

Supporting tables store customizable/sortable categories and payment methods, the single household subscription budget/base-currency setting, and cached exchange rates. A "Manage categories and payment methods" dialog in the Subscriptions toolbar adds, renames, reorders, and removes both categories (name + color) and payment methods. Unlike the shared `yuvomi-category-manager` used elsewhere, removal is not blocked while in use: the FK `SET NULL` detaches referencing subscriptions (they fall back to uncategorized / unspecified) and the confirmation names how many subscriptions are affected. Subscription categories are mirrored under the Budget `Subscription` category, and active renewals use the matching Budget subcategory automatically; removing a category also removes its mirrored Budget subcategory and detaches any linked expense entries from it. Database backup and restore include all subscription data.

### Budget Plans
Planned/estimated budget (Budget → Plan). A **steady monthly plan**: one amount per expense category that applies to every month, compared against the month's actual spending. The reserved key `__savings__` holds the household's monthly savings goal, compared against the month's net balance (income − expenses).

| Column | Type | Constraint |
|--------|------|-----------|
| category | TEXT | PRIMARY KEY — expense category key, or the reserved sentinel `__savings__` for the savings goal |
| amount | REAL | Planned monthly amount, always positive |
| created_by | TEXT | User id that last set the plan, nullable |
| updated_at | TEXT | ISO 8601 datetime, default now |

`GET /api/v1/budget/plans?month=YYYY-MM` returns each category's planned vs. actual (with `remaining`, `ratio`, `over`) and the savings goal's planned vs. net balance (`met`), plus `isCurrentMonth` for the requested month. **The verdict fields are scoped to the current month (v2.64.0):** because the table holds one amount per category with no time axis, nothing records what the plan said in an earlier month, so editing a plan today would otherwise rewrite the "over budget" answer for months that have long closed. For any month other than the current one, `over` and `met` are therefore `null` while `planned`, `actual`, `remaining` and `ratio` are still returned - the facts stay, the judgement does not. A real plan history would remove the distinction again. `PUT /api/v1/budget/plans/:category` upserts a positive amount (validated against real expense category keys or the savings sentinel); `DELETE` removes it. The Statistics tab overlays a category target marker at the planned amount (month range only); the dashboard Budget widget shows savings-goal progress when a goal is set. No FK on the category so category rename/delete never orphans the app.

### Reminders

Per-user reminders attached to tasks, calendar events, subscriptions, inventory items, inventory tracked dates, or pantry items.

| Column | Type | Constraint |
|--------|------|-----------|
| entity_type | TEXT | `task`, `event`, `subscription`, `inventory_item`, `inventory_tracked_date`, or `pantry_item`, NOT NULL |
| entity_id | INTEGER | Entity identifier, NOT NULL |
| remind_at | TEXT | ISO 8601 datetime, NOT NULL |
| dismissed | INTEGER | 0/1, default 0 |
| pushed_at | TEXT | ISO 8601 datetime, nullable — set once all active notification targets have been sent, skipped, or exhausted, so the reminder is not processed indefinitely |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL — whose reminder this row *is*: who gets notified, and who may change or dismiss it |
| assigned_from | INTEGER | FK → Users (SET NULL), nullable (migration v169) — whose action the row was derived from. `NULL` means self-set, which is what every pre-v169 row is |

All types except `pantry_item` can be set and deleted through `POST`/`PUT`/`DELETE
/api/v1/reminders`. Four of them are **derived** - their module recreates the reminder whenever the
underlying object is written (renewal date, warranty end, inventory deadline, best-before date) - but
only the pantry is additionally rebuilt on **every notification run**. A hand-set `pantry_item`
reminder is therefore gone within a minute and a deleted one is back, so all four write paths
(`POST`, `PUT`, `DELETE /:id`, `DELETE` by filter) answer 400 for it; for the other three derived types a hand-set date survives until the next change to
their object, which is a half-life you can work with, and closing them would break a published
`/api/v1` surface for no reason.

Reading and **dismissing** (`PATCH /:id/dismiss`) stay open for all six - the reminder toast has to
show a derived notification and let the user wave it away, and dismissing holds precisely because
the row stays.

Calendar events support **multiple reminders** (e.g. "15 minutes before" *and* "1 day before").
Each reminder is an independent row and is delivered separately by the notification scheduler.
Every delivery carries the linked entity's title as the notification body (task title, event title,
subscription name, inventory item, `item · label` for a tracked date, pantry item), so the reminder
is identifiable without opening the app; the fallback text only applies once the linked entity has
been deleted. Some origins add the date the reminder is about: subscription reminders carry amount
and renewal date as `Name - 12.99 EUR - 2026-08-03`, warranty reminders the warranty end, tracked
dates and pantry items their date as `Name - 2026-09-01`. That line is deliberately data
only, with no sentence around it: the notification is assembled on the server, which has no way to
know the **recipient's** language, since locale, date and number formats live in the client's
local storage. The household data language (#631, #632) does not close this gap — it governs what the
server *stores* for everyone, whereas a notification is addressed to one member whose own display
language may differ. Amount and date are dropped individually when a subscription has neither.
The event dialog manages the set via `GET /api/v1/reminders/all?entity_type=event&entity_id=…`
(returns the full list) and `PUT /api/v1/reminders?entity_type=event&entity_id=…` with
`{ remind_ats: [...] }` (replace-set semantics: deduplicated, max 5). Tasks and subscriptions keep
using the single-reminder endpoints (`GET`/`POST /api/v1/reminders`).

**A reminder on a shared event reaches its assignees (v2.52.0).** A reminder set by the member who
**created** the event is written for everyone assigned to it as a row of their own, so it is
delivered to them and appears when they open the event. Rows of their own rather than one row with a
recipient list, because everything hanging off a reminder is per-person: `dismissed`, `pushed_at`,
and the time itself, which each member may move. A shared row would have needed a second table for
each of those three, and the delivery path already keys on `created_by`.

Only the event's author distributes. Anyone else setting a reminder on a shared event sets it for
themselves — otherwise one member making a note would notify the household. Four rules bound the
fan-out, all of them about what must *not* happen:

- A reminder an assignee set for themselves (`assigned_from IS NULL`) is never overwritten, and its
  presence stops the fan-out to that person entirely: they have already decided when to be reminded.
- A dismissed row is not resurrected while the set of times is unchanged. Dismissing means "I have
  seen this", not "I want nothing about this event", so a *changed* time does reach them.
- Removing someone from the event deletes their inherited rows, but not one they set themselves.
- Deleting the author's own reminders removes the inherited ones with them — leaving a notification
  standing that the author just abolished would be a promise without cover.

Both triggers — writing a reminder (`server/routes/reminders.js`) and changing the assignment
(`setEventAssignments` in `server/routes/calendar/helpers.js`) — go through one service,
`server/services/event-reminder-fanout.js`. Two implementations would be unusually expensive here: a
reminder that does **not** arrive does not announce itself.

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
| provider | TEXT | Provider ID such as `gotify`, `ntfy`, `webhook` or `email`, validated in the service layer |
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
The generic **webhook** provider stores `baseUrl` and an optional `payloadTemplate` in `config_json`,
with an optional bearer `token` in `secret_json`.
The **email** provider stores only `toAddress` in `config_json` and nothing in `secret_json`.
Secrets are accepted by the API on create/update but never returned to clients.

**Webhook payload template.** An empty template sends Yuvomi's own body shape, which suits receivers
that accept arbitrary JSON (Home Assistant, n8n). Receivers with a schema of their own reject it - a
Discord webhook requires `content` or `embeds` - so the template lets the channel produce whatever
body the service expects, keeping one generic provider instead of one adapter per service. It
supports the placeholders `{{title}}`, `{{body}}`, `{{url}}` and `{{tag}}`; values are JSON-escaped
on substitution, so a reminder title carrying a quote, backslash or line break cannot break the
surrounding JSON. The template is validated on save rather than on delivery (valid JSON, known
placeholders only, max 4096 characters), because a template that first fails at 3 a.m. costs both the
notification and the diagnosis. Validation matches anything placeholder-*shaped* (`{{…}}`), not just
the well-formed names, so a typo like `{{task-title}}` is rejected instead of being delivered
verbatim. Unlike Gotify and ntfy, whose `baseUrl` is a base the provider appends its own path to, a
webhook URL is the complete endpoint and keeps a trailing slash if one was entered.

**Email channel (#944).** Unlike the other three, an email channel carries no endpoint and no
credentials of its own - only `toAddress`. The SMTP access is app-wide (Settings → Email, or
`EMAIL_SMTP_*`) and already carries password resets and invitations; a second set per channel would
be a second spelling of the same thing, with two places to update on a server change and one of them
forgotten. The channel is therefore a *transport*, not a second addressing model: who receives a
reminder is still answered by `scope` (`household` vs. a user-scoped channel), exactly as for the
other providers. One address per channel, so each can be disabled and tested on its own.

Because the recipient's inbox shows only the subject line, the mail puts both origin and subject
there (`Calendar: Dentist`), where Web Push splits them across title and body. Reminder titles are
user data, so the HTML part escapes them. The link needs an absolute origin: it is built from
`BASE_URL` and omitted entirely when that is unset, rather than shipping a dead relative path - the
request Host is deliberately not consulted (there is no request during a background run). Since
nodemailer honours no `AbortSignal`, the provider races its send against the orchestrator's timeout,
so one unresponsive SMTP server cannot stall a run that processes every due reminder in sequence.
`GET /api/v1/notifications/providers` reports `ready: false` for email while SMTP is unconfigured, so
the settings form can say so before a test send fails behind a generic error.

### Notification Deliveries

Durable per-reminder delivery state for Web Push and external channels.

| Column | Type | Constraint |
|--------|------|-----------|
| reminder_id | INTEGER | FK → Reminders (CASCADE delete), NOT NULL |
| provider | TEXT | `webpush`, `gotify`, `ntfy`, `webhook`, `email`, or future provider ID |
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

Birthday records with optional profile photo (same crop dialog as member avatars, see Profile picture),
an optional name day, and automatic calendar events + reminders. A name day is stored as a canonical
`MM-DD` value rather than a date with an invented year. When present, it creates a second yearly event
in the same calendar layer and uses the birthday's existing reminder offset; clearing it removes only
that generated event and reminder. The dashboard expands one person into separate birthday and
name-day occurrence rows ordered by proximity, while the Birthdays module itself remains one row per
person. No country- or name-based lookup is performed.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| birth_date | TEXT | DATE (YYYY-MM-DD), NOT NULL |
| name_day | TEXT | Month and day (`MM-DD`), nullable |
| notes | TEXT | nullable |
| photo_data | TEXT | Base64 data URL (≤ 5 MB), nullable |
| calendar_event_id | INTEGER | FK → calendar_events (SET NULL on delete), nullable |
| name_day_calendar_event_id | INTEGER | FK → calendar_events (SET NULL on delete), nullable |
| family_user_id | INTEGER | FK → Users (CASCADE delete), UNIQUE (one linked user per birthday), nullable |
| contact_id | INTEGER | FK → Contacts (SET NULL on delete), UNIQUE partial (one birthday per source contact); set when imported from a contact, nullable |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| reminder_offset | TEXT | Preset offset key (e.g. "1d", "1w") or "custom"; empty/null = no reminder |
| reminder_custom_amount | INTEGER | Amount for custom offset, nullable |
| reminder_custom_unit | TEXT | Unit for custom offset: "minutes", "hours", "days", "weeks", nullable |

### API Tokens
Named Bearer / X-API-Key tokens for non-interactive external integrations. Admin-only creation and revocation. Token values are SHA-256-hashed at rest; the plaintext is shown only once after creation.

Tokens can optionally be **scoped** to individual modules and access levels — a least-privilege allow-list that matters most for tokens handed to an off-device AI/MCP client. Each scope is `<module>:read` or `<module>:write` (write implies read); modules cover `tasks`, `shopping`, `meals`, `pantry`, `calendar`, `notes`, `contacts`, `budget`, `documents`, `health`, `rewards`, `housekeeping`, `weather`, `family`, `dashboard`, `search`. A `NULL` scopes value means no scoping — full role-based access (the default, and the state of every token created before this feature). A scoped token can only reach modules on its allow-list; every other `/api/v1` path is denied. Enforcement is shared across the REST API and MCP: the MCP core tools are checked in-process, `tools/list` hides tools the token cannot use, and the OpenAPI bridge inherits the same limits because it loops back through the REST layer with the same token. Scopes narrow, they never grant: the module permissions of the user behind the token apply on top of them, on both surfaces (#823).

| Column | Type | Constraint |
|--------|------|-----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name | TEXT | NOT NULL |
| token_hash | TEXT | NOT NULL UNIQUE (SHA-256) |
| token_prefix | TEXT | NOT NULL (first 8 chars, for display) |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| subject_user_id | INTEGER | FK → Users (CASCADE delete), nullable (migration v135) - the member the token acts as; NULL falls back to `created_by` |
| scopes | TEXT | JSON array of `<module>:read`/`<module>:write`; NULL = full access (nullable) |
| expires_at | TEXT | ISO 8601, nullable |
| revoked_at | TEXT | ISO 8601, nullable |
| last_used_at | TEXT | ISO 8601, nullable |
| created_at | TEXT | ISO 8601 NOT NULL |

**Subject vs. creator (v2.4.0 · migration v135):** only an admin can mint a token, so without a subject every request it makes is the admin's - and `budget_entries.owner_id` is fixed to whoever creates the entry (see [Budget Entries](#budget-entries), migration v88). A bank-import connector could therefore only ever file transactions under the administrator, never under the household member they belong to. The two roles are now separate: `created_by` stays with the admin who is accountable for the credential and is what the token list shows for audit, while `subject_user_id` supplies the identity, role, ownership and module permissions of the requests. Making `owner_id` settable per request would have been the alternative and is the weaker one - it lets any caller claim any ownership on every call, where the subject is fixed once by an admin and not selectable afterwards.

The subject can only narrow, never widen: module permissions (#467) are resolved for the subject on every request, a non-admin subject cannot reach admin-only routes, and token scopes remain an additional allow-list on top. A split-expense guest cannot be a subject (the household guard would refuse its requests anyway). Deleting either user removes the token via `ON DELETE CASCADE`, and existing tokens keep behaving as before because the migration backfills `subject_user_id = created_by`.

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

**Share from the viewer (D#1014):** the document viewer offers Share through the device's native
share sheet (Web Share API), and only there - a row action would have to fetch the file after the
click, which is exactly where iOS drops the transient user activation. Whether Share is possible is
decided once, in `public/utils/web-share.js`, before a byte is loaded: the type must be on the Web
Share API's file list (PDF, PNG, JPEG, WebP, plain text, CSV - no Office formats), the context must
be secure (HTTPS or localhost), and `navigator.canShare({ files })` must accept an empty probe file
of that type; `'share' in navigator` is deliberately not the gate, since it is true wherever links
are shareable. When the answer is yes, the viewer fetches the file from the authenticated download
endpoint in the background, shows the Share button busy until it is there, and the click goes
straight into `navigator.share()`; closing the viewer aborts the fetch and drops the file. When the
answer is no, no dead control is shown: a line under the metadata says why (type, or browser and
context) and Download stays the path that works everywhere.

### Family Document Access
Allowlist for `visibility = 'restricted'` documents — only listed users can see the document.

| Column | Type | Constraint |
|--------|------|-----------|
| document_id | INTEGER | FK → Family Documents (CASCADE delete), NOT NULL |
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| PRIMARY KEY | | (document_id, user_id) |

### Family Document Folders
Custom folders for organizing family documents (migration v37). The housekeeping folder is auto-created when a housekeeping worker is first added.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL, unique **per sibling row** since v164 (display label only since v157) |
| parent_id | INTEGER | nullable, FK → this table (ON DELETE CASCADE, migration v164, #785) - NULL = root level |
| module_key | TEXT | nullable, UNIQUE where set (migration v157) - `budget`, `tasks`, `splitExpenses`, `inventory`, `housekeeping`, `calendarItems` |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

`family_documents.folder_id` references this table (ON DELETE SET NULL, nullable).

**Folders nest since migration v164 (#785).** The uniqueness of `name` moved with it: it was global
until then, which is the wrong assurance for a tree - "Invoices" under "Car" and "Invoices" under
"Apartment" are two folders. The index is now `UNIQUE(COALESCE(parent_id, 0), name)`; `COALESCE`
rather than a plain `UNIQUE(parent_id, name)`, because SQLite treats each NULL in a UNIQUE as
distinct and would allow any number of same-named root folders - no assurance on exactly the level
that had one before. The migration cannot fail on existing data, and that is a derivation rather
than a hope: every carried-over row gets `parent_id NULL`, so `COALESCE(parent_id, 0)` is 0 for all
of them and the new index checks precisely the condition the old global UNIQUE checked. It is
deliberately **not** `COLLATE NOCASE` - that would be stricter than before and could break on a
household holding "Auto" next to "auto".

Nesting is capped at **five** levels, and the depth check counts the *height of the moved subtree*,
not just the folder itself: a three-level branch does not fit under level three. A folder cannot be
moved into its own descendant - without that check the branch cuts itself off the tree, unreachable
but still there. Both rules, plus "which folders lie beneath this one", live once in
`public/utils/folder-tree.js` and are used by the sidebar and the route alike (see the isomorphic
allowlist in `test/test-layer-boundary.js`); two formulations would produce a count on the left that
does not match the list on the right, with neither half looking wrong.

`module_key` is unaffected by nesting: it carries the identity of a module's system folder, not its
position, so such a folder may be moved without the six modules losing their filing place.

**`module_key` carries the identity of a module's system folder, `name` is a label (migration v157).**
Until then the folder was looked up by its translated name, which the client sent in its own
language: two members with different language settings created two folders holding half the receipts
each, every correction to a translation split the folder again (migration v146 had to clean that up
once), and a folder someone renamed came back under its old name with the next upload. The migration
binds existing folders to their key through written-out name lists per language; where a household
holds the same folder in two languages the **older** one takes the key and nothing is merged.
Resolution lives in `server/services/document-folders.js` - it previously existed as two copies, in
the documents route and in the calendar helper. Folders without a `module_key` are the ones people
created themselves and keep matching by name.

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

**DMS integration:** Admins connect a DMS instance (Paperless-ngx or Papra), then search it and **link** existing DMS documents into the Documents module as `external`/`dms` references (no duplication of the binary), or **push** a local or WebDAV-backed document into the DMS. Only `storage_backend = 'dms'` means a document is already stored in the DMS. All DMS operations (account management, search, link, push) are **admin-only**; searching the DMS is gated because it would otherwise bypass the per-document `restricted`/`private` visibility boundaries. Linked documents are previewed/downloaded by proxying the DMS live. The adapter layer (`server/services/dms/`) is provider-pluggable; Paperless-ngx and Papra are the two built-in adapters. For **Paperless-ngx**, a search term carrying an `asn:` prefix (e.g. `asn:123`, `asn 123`, `asn#123`) is resolved as an exact **Archive Serial Number (ASN)** lookup (`?archive_serial_number=`) instead of a full-text query, so a stamped ASN maps straight to the single matching document rather than a noisy title/content result set. A **bare number** is ambiguous (it may be a stamped ASN, but equally a street number, year or invoice number in the title), so it runs both queries in parallel and returns the ASN hit first, followed by the deduplicated full-text results, capped at the requested limit. A failing ASN lookup does not fail the search: the full-text results still come back.

**Target validation (#809):** the account's `base_url` is checked before every outbound request, in
`server/services/dms/guard.js`. Every adapter method routes through it — including Papra's
`testConnection()`, which builds its own request and would otherwise be the one gap. `DMS_ALLOW_PRIVATE_NETWORK`
governs it and is the **only** `*_ALLOW_PRIVATE_NETWORK` switch that defaults to `true`: a DMS is
self-hosted by definition and normally sits on the same LAN or Docker network, so shipping this as an
opt-in would have cut off virtually every existing connection. Only an explicit `false` or `0` turns
the guard on; a typo leaves a working setup working. When on, the hostname is checked against the
blocklist before DNS and **every** resolved address is validated, so one public address next to a
private one does not pass. This is a pre-flight check of the configured URL, not the per-connection
anti-rebinding lookup `server/utils/http.js` provides: the adapters need `FormData` and `res.json()`,
which `safeRequest()` does not offer, and global `fetch()` has no per-connection `lookup`. That
residual gap is documented in the module header.

### Budget Loans
Instalment-based loans with per-payment tracking. Active loans show remaining balance and due months; paid-off loans are automatically closed. **Interest phases (migration v100, #569):** a loan is optionally modelled as a German-style annuity — from the `principal`, nominal `fixed_rate` and `initial_repayment_rate` the server derives the constant monthly payment and, from that, the term and total cost, storing them in `total_amount`/`installment_count` so the existing instalment/status logic is unchanged. With `interest_mode = 'fixed_then_variable'` a forecast `followup_rate` applies after the `fixed_period_months` fixed period (a longer follow-up rate lengthens the term). `interest_mode = 'variable'` (migration v101, #569) covers a loan with **no fixed-interest period at all**: it is computed single-phase exactly like `fixed`, but `fixed_rate` is treated as the current rate rather than a commitment, so `fixed_period_months`/`followup_rate` stay NULL and the UI labels payment and term as a snapshot of that rate. `interest_mode = 'none'` keeps the prior behaviour (manual `total_amount` + `installment_count`).

**Outstanding principal vs. remaining payments (v1.48.0):** for an interest loan these are two different figures and only the first is what a bank reports as the open amount. `remaining_amount` is the sum of the outstanding instalments (`total_amount` minus what has been paid) and therefore still contains the interest of the remaining term. `remaining_principal` is the open capital and is the figure the loan cards and the summary card lead with, set against the `principal` as the reference figure so numerator and denominator match. The loan report shows both side by side (*Outstanding balance* and *Still to pay*). Interest-free loans have no interest component, so both values are identical and their display is unchanged.

Until #954 the value was a plan figure, read off the amortisation schedule at the current instalment count - which made it wrong the moment a booked amount deviated from the annuity. Since #954 it is **replayed from the booked payments**: per recorded instalment the interest share on the real balance at that instalment's phase rate (fixed rate inside the binding period, follow-up rate after), the rest amortises. An extra payment lowers the balance one to one, a payment below the interest share raises it, and a gap in the instalment numbers (a deleted payment, a later number booked directly) counts as a zero payment whose period interest accrues. A loan whose replayed balance reaches zero is settled: `is_settled` is true, `status` flips to `paid`, `next_installment_number` becomes `null` and a further payment is refused with 409 - the future plan interest of an early payoff is nobody's debt, even though plan instalments were never booked. The forecast figures next to it (monthly payment, total interest, term, remaining balance after the binding period) deliberately stay plan-based: they describe the contract, not the account. Paying exactly the annuity yields the same balance as the old plan read.

**Own currency per loan (migration v102, #582):** a loan can run in a currency other than the household budget currency. Every monetary field of the loan (`total_amount`, `principal`, and `budget_loan_payments.amount`) stays stored **in that currency**, so the amortisation schedule and the remaining balance stay exact. `currency = NULL` means "follows the budget currency" and is both the legacy state and the normal case; selecting the current budget currency in the UI is stored as NULL rather than the code, so a later household currency change cannot turn the loan into a foreign-currency one at rate 1. `exchange_rate` is a **fixed, manually maintained** rate (1 unit of loan currency = `exchange_rate` units of budget currency), not a daily quote: a 30-year schedule must not move its remaining balance every day, and the live-rate path of the Subscriptions module needs a `FIXER_API_KEY` most installations do not set. Only two places convert: the cross-loan summary card (valued at the stored rate) and the budget entry written for an instalment, which is converted **at booking time** so a later rate change leaves booked instalments untouched. Editing that coupled budget entry converts back into the loan currency, including the remaining-balance check; the instalment stays positive there and takes its sign from the direction (see below). Editing an instalment from the loan list loads that budget entry rather than deriving one from the payment row, because the two carry different currencies - a stand-in built from the payment would put the loan-currency figure where the budget-currency one belongs and convert it a second time on save (v2.41.2).

**Lending direction (migration v126, #638):** the module was originally built for money the household *lends out*, so an instalment was always booked as income — a positive amount under an income category. The interest fields of #569 made a mortgage expressible, but the booking logic never followed, and a mortgage payment showed up as income in the monthly balance. `direction` now decides sign and category together: `lent` (the default, unchanged for existing rows) writes the instalment as a positive amount under `Geschenke & Transfers`, `borrowed` writes it as a negative amount under `financial_other` / `loans_interest`. Both have to switch together, because the statistics read the type off the sign (`amount > 0` = income) while `budget_categories` carries its own `type` — turning only one of them would file an expense under an income category. Switching an existing loan's direction **re-books the instalments already recorded** (sign and category): a wrong sign is never legitimate history, and this is the repair path for rows the migration defaulted to `lent`. `account_id` gives the loan a default account which every new instalment inherits, so a payment can charge an account at all — the coupled budget entry carried none before. A later account change applies to new instalments only, since re-booking the old ones would falsify historical account balances.

**The sign belongs to the loan, not to the request (v2.41.2, #859).** Booking, re-booking and *editing* all derive it from the same rule. Until v2.41.2 the entry route enforced the pre-#638 rule instead - a coupled entry had to stay positive - which made an instalment of a borrowed loan uneditable: it is negative by design, so every amount the dialog could send was rejected. Editing now normalises the amount to the direction rather than refusing it, and two checks that the old rule had masked came into effect with it: the cap against paying off more than the loan still owes compares the **absolute** amount (against a signed one it was always satisfied on a borrowed loan and stopped nothing), and an amount of zero is refused on its own terms instead of reaching `CHECK(amount > 0)` as a 500. In the entry dialog the income/expense switch is inert on a coupled instalment and says why: the direction is a property of the loan and is changed there.

**The instalment title follows the household data language (v2.41.2).** `budget.loanPaymentTitle`, resolved server-side via `resolveHouseholdLocale`, exactly as birthday events are (#524/#631/#632) and for the same reason: the `budget_entries` row is what the REST API, the CSV export, the search index and MCP read, and none of those paths pass through the browser's translation. It was a fixed English string before, and the translated client-side fallback only ever applied to entries with an empty title - which is why it worked for backfilled instalments (#813, no coupled entry at all) and never for booked ones. Existing titles are **not** rewritten on a language change: unlike a birthday event, the title of a budget entry is a field the household edits.

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
| budget_entry_id | INTEGER | FK → Budget Entries (SET NULL on delete), nullable — **NULL for installments backfilled at loan creation** (#813), see below |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |

**Backfilling a running loan (#813):** `POST /loans` accepts an optional `paid_installments` count and
writes that many payment rows straight away, numbered from 1, dated to their own due month
(`start_month` + n-1), each carrying the loan's `installment_amount` with the last one capped at the
remaining total. Those rows deliberately have **no coupled budget entry**: a regular installment books
into the budget because it is being paid now, whereas these were paid before Yuvomi existed and never
went through the household — booking them would fill past months with expenses that never happened and
move account balances with them. The form derives a suggestion from the first due month but does not
enforce it, since a payment-free start or a deferral makes the computed number wrong.

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

### Inventory Locations (migration v136)
Storage places for owned belongings. Two-level hierarchy via `parent_id` (top-level place →
sub-location, e.g. "Garage" → "Werkzeugschrank"); a sub-location cannot itself have children, and
the API rejects re-parenting, so a cycle through this self-reference is unreachable in practice.
Renameable and sortable like Pantry Locations, but seeded empty rather than pre-populated.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| parent_id | INTEGER | FK → Inventory Locations (SET NULL) — top-level when NULL |
| icon | TEXT | NOT NULL (default 'package') |
| sort_order | INTEGER | NOT NULL (default 0) — reordering only applies within one level (top-level locations, or the children of one parent) |
| created_at / updated_at | TEXT | ISO 8601 |

Deleting a location is never blocked: its items become location-less and its sub-locations become
parent-less, rather than being reassigned or blocking the delete — the same "deletion always
succeeds, references dangle safely" pattern as Pantry Locations.

### Inventory Categories (migrations v136, v142)
DB-backed, customizable category list for inventory items, seeded with five defaults (Electronics,
Vehicles, Household, Sports, Other) analogous to Task Categories. `other` is protected and cannot be
deleted. The five seeded categories keep a stable slug `key` and are localized via `label_key`
(migration v142, same pattern as [Task Categories](#task-categories-migration-v83)); user-added
categories store their display `name` instead. Renaming a seeded category clears its `label_key`
and makes it custom — the same "renaming leaves the key stable" behavior Task Categories has — so a
typed name is never silently overwritten by the translation on the next language switch.

| Column | Type | Constraint |
|--------|------|-----------|
| key | TEXT | NOT NULL, UNIQUE — stable slug, the actual foreign key `inventory_items.category` points at |
| name | TEXT | nullable — custom display name; NULL for seeded (localized) categories |
| label_key | TEXT | nullable — i18n key for seeded categories; NULL for custom ones |
| icon | TEXT | NOT NULL (default 'package') |
| sort_order | INTEGER | NOT NULL (default 0) |
| created_at | TEXT | ISO 8601 |

`inventory_items.category` is deliberately not a real foreign key: deleting a category reassigns
its items to `other` in the route layer, which a DB constraint cannot express without a concrete
fallback value (only `NULL`).

**A known, accepted limit (same one Task Categories has):** name-uniqueness checks on create/rename
compare `COALESCE(name, key)`, not the translated display text — a server route has no way to know
the caller's UI language. Creating a category named "Electronics" therefore does not conflict with
the seeded `electronics` category once it carries a `label_key`; it only conflicts with another
*custom* category sharing that name (case-insensitively). Migration v142 required a full table
rebuild rather than a plain `ADD COLUMN`, since `name` had been `NOT NULL` since v136 and needed to
become nullable — unlike `task_categories`, which declared it nullable from the start.

### Inventory Items (migrations v136, v141)
One row per owned belonging.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| brand / model / serial_number | TEXT | all nullable |
| category | TEXT | NOT NULL (default 'other') — see [Inventory Categories](#inventory-categories-migrations-v136-v142) |
| location_id | INTEGER | FK → Inventory Locations (SET NULL) |
| purchase_date | TEXT | nullable, `YYYY-MM-DD` |
| purchase_price | REAL | nullable, CHECK `>= 0` |
| currency | TEXT | nullable |
| vendor | TEXT | nullable |
| warranty_months | INTEGER | nullable, CHECK `0–600` |
| condition | TEXT | NOT NULL (default 'good'), CHECK `new`\|`good`\|`fair`\|`poor` |
| status | TEXT | NOT NULL (default 'active'), CHECK `active`\|`sold`\|`disposed`\|`lost` |
| notes | TEXT | nullable |
| photo_data | TEXT | nullable (v141) — a single Base64 data URL, same storage pattern as `birthdays.photo_data`; server-validated MIME type and a ~5 MB cap (`server/routes/inventory/items.js`). The UI sends a 256 × 256 JPEG via `pickCroppedImage()`; the wider server cap keeps accepting larger legacy values and API writes |
| created_by | INTEGER | FK → Users (**SET NULL**) — inventory is household property like the pantry; unlike `pantry_items` (which needed a follow-up migration, v109, to fix this) it starts SET NULL from the beginning |
| created_at / updated_at | TEXT | ISO 8601 |

`GET /api/v1/inventory/items` supports filtering by `category`, `location_id`, `status`, and a
full-text search `q` across name, brand, model, and serial number. `PUT` is a full replace: an
omitted field is not preserved, matching the semantics of `PUT /api/v1/inventory/items/:id` rather
than a partial `PATCH`.

### Inventory Item Documents (migration v137)
Links an item to documents from the Documents module (receipts, warranty cards, manuals) — mirrors
[Budget Entry Attachments](#budget-entries) 1:1: same column shape, same cascade reasoning. Deleting
an item removes only the link, never the document itself.

| Column | Type | Constraint |
|--------|------|-----------|
| item_id | INTEGER | FK → Inventory Items (CASCADE delete), NOT NULL |
| document_id | INTEGER | FK → Family Documents (CASCADE delete), NOT NULL |
| created_by | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| created_at | TEXT | ISO 8601 |
| UNIQUE | | (item_id, document_id) |

Document visibility is enforced exactly as in Budget: only documents the current user may see are
listed, linkable, or returned, with no admin bypass, and a replace-set update on `PUT` leaves links
to documents the caller cannot see intact.

### Inventory Item Entries (migration v138)
Links an item to Budget entries — a purchase, a refund, a repair, an accessory bought later.

| Column | Type | Constraint |
|--------|------|-----------|
| item_id | INTEGER | FK → Inventory Items (CASCADE delete), NOT NULL |
| entry_id | INTEGER | FK → Budget Entries (CASCADE delete), NOT NULL |
| role | TEXT | NOT NULL (default 'purchase'), CHECK `purchase`\|`refund`\|`instalment`\|`maintenance`\|`accessory` |
| amount_share | REAL | nullable, CHECK `>= 0` — reserved for a later stage that splits an entry's amount across several linked items; nothing writes it yet |
| created_by | INTEGER | FK → Users (**SET NULL**, not CASCADE — a booking link is household property like the item itself, not a personal annotation the way a document attachment is) |
| created_at | TEXT | ISO 8601 |
| UNIQUE | | (item_id, entry_id, role) — the same pair can carry several roles (e.g. `purchase` and later `maintenance`) but not the same role twice |

Visibility follows Budget's own rules exactly: in personal budget mode a private booking stays
invisible to other members even when linked to a household-visible item, and linking a recurring
series' materialized instance or an `is_pending` (expected) entry is rejected. Creating an item with
`entry_id` prefills `purchase_price` from that booking's amount — but only for the **first** item
linked to it, so a collective receipt split across several items does not silently copy its total
onto each one.

### Inventory Item Dates (migration v140)
Custom, per-item tracked dates beyond the built-in warranty deadline — TÜV, service, insurance
renewal, or anything else with a date and its own reminder lead time.

| Column | Type | Constraint |
|--------|------|-----------|
| item_id | INTEGER | FK → Inventory Items (CASCADE delete), NOT NULL |
| label | TEXT | NOT NULL |
| date | TEXT | NOT NULL, `YYYY-MM-DD` |
| reminder_offset_days | INTEGER | NOT NULL (default 30), CHECK `0–365` — an explicit `0` ("remind me on the day") is preserved, not coerced to the default |
| created_by | INTEGER | FK → Users (SET NULL) |
| created_at / updated_at | TEXT | ISO 8601 |

Capped at 10 rows per item (`MAX_TRACKED_DATES_PER_ITEM`). `PUT /api/v1/inventory/items/:id` treats
`tracked_dates` as a full replace-set like `attachment_document_ids`: omitting the field leaves
existing rows untouched, an empty array clears all of them, and an invalid or over-the-cap payload
rejects the whole write with no partial insert. Each row drives its own [reminder](#reminders),
recreated whenever the item is saved.

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
| type | TEXT | NOT NULL — `bp` \| `glucose` \| `weight` \| `height` \| `head_circumference` \| `spo2` \| `temp` \| `sleep` \| `mood` \| custom slug (pulse is no metric of its own: it is the third `bp` channel, `value_num3`) |
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

**`health_visibility_defaults`** — what a person's NEW entries start as (migration v172, #958).
Sparse like `access_permissions`: only deviations from the shipped `private` are stored, so an
account without a row behaves exactly as before the migration.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| scope_key | TEXT | NOT NULL — `vital:<type>` per metric, plus `meds`, `labs`, `activities`. No CHECK: the metric list grows and an append-only migration must not freeze it |
| visibility | TEXT | NOT NULL, CHECK IN ('private', 'family') |
| updated_at | TEXT | ISO 8601, default now |
| | | PRIMARY KEY (user_id, scope_key) |

The request was to flip the shipped default for blood pressure to `family`, so that in an emergency
somebody knows the usual values. The shipped value stays `private` and the choice moves to the
household instead: stored rows carry their own visibility, so nothing leaks retroactively, but
somebody who learned that health readings are private would, after an update, record one and share
it without doing anything. **Per metric for vitals, not per area** — sharing a blood pressure is not
sharing a mood, and both live in `VITAL_METRICS`; medications, lab reports and activities get one
each, because each is one kind of entry. The cycle tab keeps its own switch
(`cycle_settings.default_visibility`), which is where this pattern came from.

Writing routes read the **owner's** choice, not the recording person's: when a caregiver records for
somebody else, the row belongs to the subject and so does the decision. Setting an area back to
`private` deletes the row rather than storing it, keeping "no row" the only spelling of the default.
API: `GET/PUT /api/v1/health/visibility-defaults`, and `PATCH /api/v1/health/visibility-defaults/apply`
to move the existing entries of one area — own rows only, and the target comes from the request
because `private` is never stored. Settings → Personal → Health carries the choice; after a change it
offers to move that area's existing entries too.

**`medications`** — medication master data.

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | FK → Users (CASCADE delete), NOT NULL |
| name | TEXT | NOT NULL |
| dosage_text | TEXT | free-text dose |
| form | TEXT | `pill` \| `liquid` \| `injection` \| … |
| active | INTEGER | 0/1, default 1 |
| prn | INTEGER | 0/1 "as needed", default 0 |
| min_interval_hours | REAL | minimum gap between two as-needed doses (v148), NULL = none |
| prn_dose_qty | REAL | usual amount per as-needed dose (v148) |
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

**Taking an as-needed dose (#700).** "As needed" existed as a column, a form field and a badge since
v65 — but there was no button anywhere: both booking paths hang off `data-schedule-id`, and a PRN
medication is by definition not one of a schedule's entries. The Meds tab and the Overview now share **one** "As needed"
section listing every active PRN medication with a *Take now* button that posts a log without a
schedule (`POST /medications/:id/logs`, `{ status: 'taken', taken_at }`); `prn_dose_qty` is deducted
from stock like a scheduled dose. `min_interval_hours` plus the last taken dose produce the readout
next to it — the **absolute** time first ("earliest 18:40"), the remaining duration second, because
the absolute one still holds three hours later. It is derived from the stored timestamp, not from a
timer in one tab, so it survives a reload and a second device. Taking a dose early is not blocked but
asked about: the minimum gap comes from a package insert, and a dose actually taken early should be
recordable rather than hidden.

`prn` and a schedule are **not** mutually exclusive, and deliberately so: a fixed base dose plus an
extra one when the pain comes back is a common prescription, so such a medication appears in both
"Due today" and "As needed" and can be logged from either. The minimum interval counts both, because
it is a statement about the body and not about which list the button sat in - the countdown runs from
the last dose actually *taken*, scheduled or not. Adherence is the other way round: it measures a
plan being kept, so it counts only entries that carry a `scheduled_at`. That column, not
`schedule_id`, is what makes an entry a planned one - the schedule reference is cleared by
`ON DELETE SET NULL` when an old schedule is removed, and reading the past through it would turn
every historical dose into an as-needed one and collapse last month's adherence retroactively.

The same discussion exposed a filter bug: `GET /medications/:id/logs` and `GET /export/meds-logs`
compared `scheduled_at` against the range, which is NULL for an as-needed dose — so it fell out of
*every* range, including the CSV somebody prints for a doctor. Both now filter on
`COALESCE(scheduled_at, taken_at, created_at)` truncated to minutes (the column holds wall-clock
times *and* `…Z` timestamps).

**Correcting an entry (#695 sibling, #701).** `POST /logs/{id}/take` and `/skip` were the only ways
to change an entry, so a mistap was permanent — and not only on screen: the wrong time goes into
`GET /export/meds-logs` as well, which is the file somebody prints for a doctor.
`PATCH /api/v1/health/logs/{id}` (`{ status?, taken_at?, dose_qty?, note? }`) corrects it, and
`status: 'pending'` takes a take or a skip back. The timestamp travels **with** the status: anything
other than `taken` clears `taken_at`, because an entry that says not-taken while carrying a time it
was taken at contradicts itself in the app and in the export.
`DELETE /api/v1/health/logs/{id}` removes an entry **only when it has no `schedule_id`** (ad-hoc and
PRN doses). A scheduled entry answers `409`: the scheduler recreates it on its next run because the
dose is still planned for that time, so deleting it would look like a success and be a return on the
instalment plan. Both are restricted to the owner of the medication — seeing a medication and
rewriting its record are different rights.

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
is hidden and its route redirects to the Health overview. On top of that, every member can hide the
tab for themselves (`health_cycle_enabled_user`, default on, Settings → Personal → Health) - not
everyone in a household has a cycle. The two combine with AND into the read-only
`health_cycle_effective`, which is what the client renders: the personal switch can only narrow the
household setting, never widen it, and the household switch stays admin-only while the personal one
is writable by anyone for themselves.

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
fans out via Web Push and the household channels (Gotify, ntfy, webhook, email). Medications (`name`, `dosage_text`) and activities
(`type`, `note`) are indexed in the FTS5 `search_index` (migration 66) with the same
owner-or-`family` visibility scoping applied at query time.

### Schedule (migration 165, #786)

Rotating shift patterns and fixed weekly timetables. **One cycle model, not two features:** a
"week A / week B" timetable is a 14-day cycle, so it and an eight-day rotation share the same
arithmetic instead of duplicating it. A pattern is not calendar recurrence — a rotation is a
repeating sequence of *different* entries, which an RRULE cannot express without splitting it into
several unrelated series.

**Entries are computed on read, never materialized.** Nothing is copied into Calendar Events, so
editing a pattern cannot leave stale appointments behind, and a two-year rotation costs one row
instead of ~700. Resolution priority per day: an override beats the newest applicable pattern (by
`valid_from`) beats nothing. A `NULL` override is an explicit free day, not a missing one.

The module ships **disabled by default**, the same way Inventory does.

#### Schedule Shift Types

Reusable shifts belonging to the household, not to a person — they appear in every member's
patterns. Any member may add one; renaming or deleting one is the creator's call, or an admin's
(`created_by`). A type left orphaned by `ON DELETE SET NULL` falls to the admins.

| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL |
| short_code | TEXT | optional, max 12 chars — the compact calendar strip shows this |
| start_time / end_time | TEXT | HH:MM, both or neither (`CHECK`). `end <= start` means the shift crosses midnight; it stays on its start day |
| color | TEXT | NOT NULL (default `#6C3AED`) |
| created_by | INTEGER | FK → Users (SET NULL) — decides who may change it |
| created_at / updated_at | TEXT | ISO 8601 |

#### Schedule Patterns

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | NOT NULL, FK → Users (CASCADE) |
| name | TEXT | NOT NULL |
| anchor_date | TEXT | NOT NULL — day zero of the cycle; positions before it wrap backwards |
| cycle_length | INTEGER | NOT NULL, `CHECK` 1–366 |
| valid_from / valid_until | TEXT | optional bounds; NULL means open-ended |
| is_active | INTEGER | NOT NULL (default 1) |
| created_at / updated_at | TEXT | ISO 8601 |

Overlapping patterns are not rejected — the newest `valid_from` wins and the response carries a
`warnings[]` entry naming the date and the patterns, which the calendar surfaces as a chip. A hard
rejection would block the ordinary case of a pattern that starts before the previous one is
formally closed.

#### Schedule Pattern Days

| Column | Type | Constraint |
|--------|------|-----------|
| pattern_id | INTEGER | NOT NULL, FK → Schedule Patterns (CASCADE) |
| position | INTEGER | NOT NULL, `CHECK >= 0` — 0 … cycle_length-1; multiple blocks may share a position |
| shift_type_id | INTEGER | FK → Schedule Shift Types (RESTRICT) — NULL is a free block within the cycle |
| subject / room / instructor | TEXT | Optional timetable details |
| category | TEXT | `school`, `work`, `activity`, or `other` |
| color / period_number / notes | TEXT / INTEGER / TEXT | Optional block color, lesson period, and notes |

Shortening a pattern is refused while days sit beyond the new length, rather than silently dropping
them.

#### Schedule Overrides

| Column | Type | Constraint |
|--------|------|-----------|
| user_id | INTEGER | NOT NULL, FK → Users (CASCADE), `UNIQUE (user_id, date_key)` |
| date_key | TEXT | NOT NULL, YYYY-MM-DD |
| shift_type_id | INTEGER | FK → Schedule Shift Types (RESTRICT) — **NULL is an explicit free day**, which is why deleting the override is the only way back to the pattern |
| note | TEXT | optional |
| created_at | TEXT | ISO 8601 |

`POST /overrides/fill` (`user_id`, `from`, `to`, `shift_type_id`, `note`) writes the same upsert
across an inclusive date range in one call, for covering an absence (vacation, a temporary
reassignment) instead of one `PUT` per day. Its cap is a separate constant from `/entries`'
`MAX_RANGE_DAYS` (731 days) — `MAX_FILL_DAYS` (100 days) is deliberately smaller, because a fill
*writes* real rows, cutting against the "computed on read, never materialized" rule above if it
were allowed to run for years at a time; the number is sized for an absence, not a shadow pattern.

### Access Permissions (migration v74)

Role- and member-based access control for interactive users (#467). Governs which modules a
non-admin family member can see/read/edit and which dashboard widgets are available. **Sparse:** only
deviations from the default are stored — a missing row means module `write` (full) and widget
`allow`, so existing installs are unchanged after the migration. Admins bypass the whole system
(always full access; no self-lockout). Resolution for a member: member override → role profile →
default. Widgets inherit their module's lock (module `none` → its widgets blocked); a widget can
also be blocked on its own (e.g. hiding the cycle widget for some members without disabling Health).
Enforcement is **server-side** — the same scope layer that guards API tokens gates interactive
sessions too; the settings UI only maintains the configuration. The rule itself lives in
one function (`moduleAccessVerdict` in `server/permissions.js`) that every data-bearing surface
calls: the `/api/v1` middleware and the [MCP tool layer](#mcp-endpoint). It had been spelled out
inline in the middleware only, and the MCP core tools — which run in-process against SQLite and
never see express — therefore had no module check at all (#823).

| Column | Type | Constraint |
|--------|------|-----------|
| subject_type | TEXT | NOT NULL — `role` (a family_role) \| `user` (a specific member) |
| subject_id | TEXT | NOT NULL — the family_role value or the user id |
| resource_type | TEXT | NOT NULL — `module` \| `widget` \| `capability` (v175, #996) |
| resource_key | TEXT | NOT NULL — module key, dashboard widget id, or capability key |
| access | TEXT | NOT NULL — module: `none` \| `read` \| `write`; widget and capability: `none` \| `allow` |
| updated_at | TEXT | ISO 8601, default now |

Primary key: `(subject_type, subject_id, resource_type, resource_key)`. **`capability` is a schema-level
allowance only (migration v175, #996):** the CHECK admits the value, `resolvePermissions()` and
`getSubjectPermissions()` still read `module` and `widget` rows alone, and an ordinary save of the
permission matrix deletes and rewrites only those two kinds, so a capability row written by a later
feature survives it. No capability is registered by the core; the first one arrives with the feature
that needs it.

### Quick Links (migration v160, #469)
| Column | Type | Constraint |
|--------|------|-----------|
| name | TEXT | NOT NULL - what the tile is called; also the source of its monogram when no picture is set |
| url | TEXT | NOT NULL - normalised `http`/`https` address (see below) |
| icon_data | TEXT | nullable - the tile picture as a data URL (`image/png\|jpeg\|webp`), capped at **128 KB** |
| icon_name | TEXT | nullable (migration v163, #873) - the Lucide name of a built-in symbol (`film`, `server`). Validated by FORM only (`[a-z0-9-]`, max 48), never against a name list: the server does not know the Lucide inventory and a list of 1743 names would be a second truth that goes stale on the next update. An unknown name breaks nothing - the tile falls back to its monogram |
| color | TEXT | nullable - HEX; the ground the monogram or symbol sits on |
| visibility | TEXT | NOT NULL DEFAULT `all` - `all` \| `private` |
| created_by | INTEGER | FK → Users |
| position | INTEGER | NOT NULL DEFAULT 0 - household-wide order, dragged rather than sorted |
| created_at / updated_at | TEXT | ISO 8601 |

A household may hold at most **24** quick links.

**Three faces, in this order: picture, symbol, letter (#873).** Whoever uploaded a picture made the more laborious choice, so it wins over a symbol that may still sit in the same row. The order lives in the read path, not in the schema - a CHECK allowing only one of the two columns would be stricter than needed and would turn every switch between faces into two writes instead of one. A symbol costs the length of its name instead of the 20-40 KB of a data URL, stays sharp, takes the tile colour and follows the light/dark switch.

**A row, not a module (#469).** The thread ran twice over the question of whether this becomes a
bookmark library, and #759 was closed in favour of the small version four people had converged on:
a tile row on the overview with a name, an address, a picture and the question of who sees it.
There is deliberately no table for collections, tags or folders - a collection would be one more
column here, not a rebuild.

**No catalogue of known apps.** Anything keyed to a list of supported services is wrong the day
somebody runs one that is not on it, so a quick link is only an address. `192.168.1.5:8096` is a
valid entry: a missing scheme is filled in with `https://`, which is how anybody actually writes
down a machine on their own network.

**Only `http` and `https` reach an `href`.** The check lives in `public/utils/quick-link-url.js`
and is called by **both** sides - the form, so it objects immediately, and the route, because a
client-side check is not a boundary (it is on the `test:layer-boundary` allowlist for exactly that
reason). The actual guard is the protocol allowlist *after* parsing; the scheme detection in front
of it decides the **reason**: a `javascript:` value is recognised as a scheme and refused as such
rather than being turned into `https://javascript:…` and merely failing to parse, and `vbscript:1`
is refused instead of being stored as a valid `https://vbscript:1/` nobody meant.

**The picture is uploaded, never fetched.** A favicon would mean the household reaches out to every
linked host on every build of the overview - the quiet outbound traffic this app does not do. It is
stored inline as a data URL like `users.avatar_data`, and both caps exist because these pictures
travel differently than an avatar: they ship with *every* overview response, all at once. Without a
picture the tile carries the first letter of its name on `color`, and that letter picks its own text
colour via `prefersInkText` (`utils/contrast.js`) - white on a light tile measures 2.7:1.

**`private` means private.** A quick link that is not shared is visible to its author alone; the
admin is expressly not an exception, and it is not merely hidden in the browser - `listQuickLinksFor`
filters it out of the payload, including the aggregated `/dashboard` response. Editing follows the
same rule and ships with the row: `can_edit` is computed on the server by the same function that
draws the boundary (`mayEdit`), so the client does not restate the rule from its own idea of who it
is. A foreign private link answers `404` rather than `403` - the latter would confirm it exists.

API: `GET/POST /api/v1/quick-links`, `PUT/DELETE /api/v1/quick-links/:id`, `PUT /api/v1/quick-links/order`.
The scope key is `dashboard` (`scopes.js`), not one of its own: the row is not a permissions module,
but without a mapping the route would be locked for *every* scoped token, since `tokenAllows`
refuses unknown modules.

---

## Modules

### Default date for a new entry

One rule, shared by every module whose screen has a time frame: **a new entry defaults to today
only while the displayed period contains today; otherwise it defaults to the first day of that
period.** `defaultDateInPeriod(from, to, today)` in `public/utils/date.js` makes the decision, and
`monthPeriodKeys()` next to it answers the case that recurs everywhere — the calendar month, never
the six-week display grid of a month view, which begins in the previous month.

The caller supplies the period, because only the caller knows what "displayed" means: Budget passes
the month it shows, the Calendar maps its four views (day, week, month, agenda) onto one. Anything
without a time frame keeps today and does not call this — the Loans tab of Budget declares
`month: false` in `TAB_CAPS` and pre-fills the current month on purpose.

The rule is older than its shared home: Budget carried it from **v1.37.0**, the Calendar only got
it in **v2.10.1** after a bug report (#737), and until then each module wrote it out by hand. That
is why the guard in `test:date-utils` is a rule over every page rather than a list of the two known
sites — the next module with a period frame should inherit it instead of rediscovering it. The
behaviour itself (both directions: today inside the period, and today outside it) is pinned in the
same suite.

### Dashboard (`/`)

Responsive grid: 1 column on mobile, 2 on tablet, 3 on desktop.

**Today Cockpit (v0.52.40):** a compact summary strip renders above the widget grid that highlights at a glance: the next urgent/high-priority task, the next upcoming calendar event, the open shopping item count, and the planned dinner for today. Tapping any cockpit item navigates directly to the relevant module. The calendar cockpit card deep-links to the next event via `?open=<id>&date=YYYY-MM-DD` so the event detail popup opens immediately on the displayed occurrence.

**Mobile readability (v0.55.7):** on narrow phones, important cockpit cards span the full grid width so long German task/event titles do not split mid-word. Quick actions keep tokenized icon-button dimensions. The dashboard used to reserve its own scroll room for the fixed FAB; since its speed dial became a `.page-fab` the shell-wide `--fab-safe-zone` carries that room, and the module's own reserve was removed because two of them stack into dead space at the end of the page. Since **v2.6.1** that room is a **trailing pad inside the scroll port** (`padding-block-end`), not a shortened scroll port: as a margin it cut the widget grid 96 px above the window edge and left a dead band below it (12% of a 900px window, 25% more scrolling on the default board). The guarantee is "nothing is unreachable" (at the scroll end the pad sits under the button), not "nothing is ever covered" - both measured failures were at the scroll end, where nothing can be pushed aside any more, and a mis-tap lands on the button's own create action rather than on the row action beneath it. On phones nothing changes: the pad is 0 there because the FAB sits inside the nav capsule.

**Semantic interaction polish (v0.71.34):** the page exposes one primary heading, the greeting is a subordinate section heading, and FAB quick actions are native buttons without nested interactive controls. The customize control keeps a 48 px touch target on phones and a compact 40 px target on desktop.

**Cockpit-first defaults & interaction polish (v0.82.0):** the four cockpit-covered domains (tasks, calendar, shopping, meals) start **hidden** by default so the Today Cockpit is the single orientation layer above the fold and the first screen is not a wall of widgets; they stay one tap away in **Customize**, and a one-time pulse highlights the customize control on first run. Existing saved layouts are untouched. Weather is ordered last in the default grid (the only passive widget no longer leads). Widget reordering works from every input: mouse drag on the live grid, **Up/Down buttons on touch**, and **arrow keys** when the drag handle is focused (`aria-keyshortcuts`); the Customize modal reorders via the same chevron buttons (the old HTML5 row-drag was removed). Resetting the layout asks for confirmation. When every widget is hidden the grid shows a "re-enable via Customize" placeholder instead of an empty screen. Empty Shopping and Budget widgets offer a subtle "+ Create" activation link (the "All done" task state stays deliberately reward-only). The Budget widget leads with the monthly balance, one highlighted savings-rate, and a quiet income/expenses line (no equal-weight metric grid). A **load failure renders a distinct error state with a Retry action** — network, expired-session, and server errors get different copy — instead of empty widgets that look like a calm day.

**The day program (v2.4.0):** "Today at a glance" is a chronological day program instead of three module aggregates: today's remaining appointments (with their time), tasks due today ("by 17:00"; overdue first, then all-day, then date-only), the next planned meal at a nominal slot time, and open shopping as a timeless closing row — each row carrying its module seal, the assignee's avatar (seal∩avatar mark) and `data-object-kind`/`data-object-id` anchors. The task row opens the same quick-action dialog as the tasks widget (done/edit); the calendar row keeps its `?open=` deep link; the meal row needs no special path because `/meals` already scrolls today's slot into view. Capped at 6 rows with a "+N more today" footnote. An empty day answers instead of disappearing: "Free today" / "All done for today", with an outlook naming whichever comes first — the next appointment or the next due task; a complete program closes with "Nothing else today", which names tomorrow's first due task when one exists. The echo rule still applies throughout: a visible widget of a domain removes that domain's cockpit rows and carries its own warnings. Two server slices feed this: `memberTodayTasks` (per-member open count due today or overdue, visibility-filtered for the viewer) and `tasksDoneToday` (needed to tell "all done" from "nothing was ever due"). Weather moved from a card into a quiet masthead line under the greeting; the card remains as a wall-tablet opt-in and, when visible, silences the line (no echo). The family widget shows per member what today holds (next appointment, open-task count) and, on free days, each member's next upcoming appointment instead of stacking identical "Free today" lines. Dashboard content refreshes silently on tab reactivation and every 15 minutes while the tab stays visible (never while customizing). The module hairline sits on every widget card regardless of size, and a card whose action link and origin diverge names its seal tone explicitly (family → contacts).

**The task row opens the whole task (v2.53.0, #918):** the note above says a task row opens "the same
quick-action dialog as the tasks widget (done/edit)". That dialog is gone. Both the cockpit row and
the rows of the tasks and countdown widgets now open the full reading view from
`components/task-detail.js` — the same one the Tasks module opens — with subtasks, comments,
documents, the tickable checkboxes in the description and the complete action set, and the dashboard
refreshes its own tiles afterwards instead of navigating anywhere. The two-button card was never a
design decision; it was the only thing reachable while that view lived inside `pages/tasks.js`. See
[Tasks](#tasks-tasks) for what the view needs from its surroundings. The `data-object-kind` /
`data-object-id` anchors keep their meaning and gained a second reader: deleting a task hides every
representation of it for the length of the undo strip, and the Overview names its objects with those
attributes while the widget rows use `data-task-id` — the same task can stand in two tiles at once.

**The board carries its module colours (v2.6.0):** module identity on a widget card was a 2px hairline along its top edge, which the dark theme swallowed - seventeen modules' worth of colour read as a wall of grey rectangles. The card header carries the family tone as a wash band (`--tint-wash`, the scale rung defined for a tint sitting *under* foreign content), and the seal on that band receives the band as its own `--seal-base`; without it the disc mixes against the card surface and sits at 1.06:1 on the tint. The hairline stays. The day programme takes the larger card radius and one elevation step above the grid - it had been sitting one step *below* the widgets it leads - and its rows tint in their own module tone on hover instead of neutral grey. On phones the programme no longer shrinks in padding or title size; only the page gutter narrows. The minimum grid column is 280px, because at 270 the ellipse cut through real names ("Aunt Claire Bec…").

**The header band is as tall as its title line (v2.6.1):** the band measured 73px for a 17px title and a 24px seal - between 18% and 29.9% of the card at 390×844 - because the "Alle" link claimed a full 48px touch box inside a 12px-padded row. A free-standing target owes its size in **one** axis, so the link takes it in the width (`min-width: --target-lg`) while its box drops to `--target-sm` and its hit area stays 48px through a `::before` that bleeds into the header padding. Band 73px → 49px at an unchanged 48px hit height; the title line carries the measure so the error tile without a link lands on the same value. The title stays 17px - the row was bulky, not the type.

**The band is gone, and the seal has one face (v2.19.0 / v2.20.0):** the two notes above describe a
header band that no longer exists. It was rolled back in v2.19.0 - band, tinted divider and the 2px
top edge alike - at its own yardstick: a tint cannot carry colour on a dark ground, it only lightens
(`dark-chroma.mjs` splits the mix into lightness and chroma; 4-8 of the full tone's 24-73, with
`records` even losing chroma on the warm charcoal). The sender of a card is now the seal beside the
title, filled with the module tone at full strength, on widget heads and stat tiles alike; padding
and height come from the plain `.widget__header` rule, and `--seal-base` fell away with the mix it
parameterised. v2.20.0 generalised that to every seal in the app - day programme, search, wall rows,
module head, the "More" grid - so the mark has exactly one face. The light-mode half of the same
measurement: Notes, Documents and Inventory share the `records` family, and at `--tint-surface`
their discs resolved to byte-identical `#E1E4EA`, i.e. the tint erased the very difference it was
meant to show. Measured under the sheen (the least favourable spot, where 16% white lightens the
tone): light 3.65-5.18:1, dark 7.42-12.24:1, all above the 3:1 asked of graphics.

**A card's surplus height is breathing room, not a hole (v2.6.0):** row heights follow the 1×1 tiles, so a 1×2 tile receives the sum of two rows plus the gap - measured 489px of slot against 319px of content. The card body stretches and anchors its footer to the bottom, so the surplus falls *between* content and closing line rather than behind it, and the rule holds for every card with a footer. Two cards gained substance to go with it: the family card closes with the household's task tally for the day (from the same `memberTodayTasks`/`tasksDoneToday` slices its rows use, never counted off the rendered rows), and the savings rate gained a second channel - a track where the month's income is the full width and the filled part is exactly the percentage printed beside it.

**The header band can be switched off (v2.14.0 · #740):** "Today at a glance" summarises what is due in tasks, calendar, meals and shopping - useful when those areas are not on the board as tiles anyway, and a repetition otherwise. Until now it only disappeared indirectly, by showing all four domains as widgets, which nobody guesses as a route to "I do not want this section". It now carries the same hide button as any tile in customize mode and returns through the same restore chip row, persisted in `dashboard_today_glance` (per user since #585, default on, no admin check - matching `dashboard_widgets` next to it: whoever may rearrange the tiles of their own board may switch off its header band). Save, cancel, undo and reset all carry it along, and both keys travel in one `PUT /preferences` so a failure cannot write half the state. In customize mode the band stays visible even when switched off and even when empty, since otherwise the switch that brings it back would only exist while it is not needed.

**Customize says whose board it is, before the change (#585):** the reassurance that others keep their own arrangement used to arrive only in the toast *after* saving, while the doubt sits before it - while dragging the family tile away and not knowing whether the children lose it too. A line in the customize toolbar answers it in the moment it comes up. **"Reset" now says what it does:** since the arrangement became personal the word carries two plausible readings ("back to my last state", "back to what the household had") and delivers a third, the factory layout; the confirmation carries a detail line naming it.

**The board belongs to the member, not to the household (#585):** which tiles are shown, in which order and at which size (`dashboard_widgets`) and whether the header band appears (`dashboard_today_glance`) are stored **per user** in `sync_config` under `<key>:user:<id>` - the same shape `module_order`, `mobile_nav_order` and the calendar defaults already use. Both keys are read with a **household fallback**: a member who has never customised the board inherits whatever the household had saved before, which is why the change needs no migration and why an existing installation looks unchanged until someone rearranges something. Writing only ever goes to the personal key, deliberately: a key that takes both paths is undecidable for the `adminOnly` guard in `test:settings-admin-gate`, and that budget is already spent on weather and the cycle switch. This is the self-service counterpart to the admin-set widget locks in `member_permissions` (a parent hiding the cycle tile for a child) - the lock decides what a member *may* see, the personal board what they *want* to see. The `localStorage` layout hint that feeds the loading skeleton belongs to the device, not the account, and is therefore dropped on logout (`utils/dashboard-layout-hint.js`); without that, a shared wall tablet would predict the previous member's grid.

**The household may still set a default, and "reset" is the way back to it (v2.35.0 · #827):** most family members will never open customize mode, so the arrangement they get should be the one an admin chose rather than whatever the app ships with. The mechanism was almost entirely there - the household value was read on every request - and what was missing was that nothing ever wrote it. An admin now arranges the overview the way they want it and publishes that arrangement from the customize toolbar ("Set as household default", admin-only, `dashboard_widgets_default` / `dashboard_today_glance_default` on `PUT /preferences`). **It never overwrites anyone:** it applies to members who have no arrangement of their own, which is the point - a household setting that flattens personal layouts is the kind of switch that gets used once and regretted. The consequence is that "reset" has to exist, and it works by **deleting** the personal keys (`dashboard_widgets: null`), not by copying the default into them: copying would freeze today's default onto the account and the member would silently stop following every later change. `GET /preferences` answers three questions rather than one - `dashboard_widgets` (what applies to me), `dashboard_widgets_default` (what the household published, `null` if nothing) and `dashboard_follows_default` (whether I have anything of my own) - so the toolbar can hide "reset" from someone who has nothing to reset. Publishing deliberately does **not** write a personal copy for an admin who is currently following the default, or they would detach themselves from their own default and miss the next change a second admin makes. **The default has its own key rather than reusing the household `dashboard_widgets`**, for two reasons: that older key is a fossil from before #585 carrying whatever was last saved by anyone, so promoting it would present an accident as a decision and make "no default set" indistinguishable from "this is how it should be"; and a key written on both paths would push `test:settings-admin-gate` past its ambiguity budget. The fossil stays as the last step of the chain (personal → published default → pre-#585 household value → shipped default), so existing installations look unchanged.

**Per-widget options: what a tile shows, not just whether and how big (v2.35.0 · #814):** the calendar widget can be limited to appointments assigned to me, and the tasks widget to chosen categories. Both live in the same per-user object as order, visibility and size - a widget entry is now `{id, visible, order, size, options?}` - so narrowing your own overview cannot change what anyone else sees. **The server stores `options` without knowing what is in them.** It validates the storage form only (a flat object, at most 8 keys, values boolean / finite number / short string / list of short strings, no nesting) and rejects everything else; which widget understands which option is the browser's business, the same way widget ids have always been the browser's business, so that adding a widget never requires a matching backend change. An empty options object is dropped on both sides, so a layout that opened the dialog and chose nothing is stored identically to one that never saw it. The browser translates the options into query parameters the route already understands - `?events_scope=mine`, `?tasks_category=` (repeatable) - rather than filtering the response: `urgentTasks` caps at five while the metric tiles count without a limit, so filtering afterwards would put two rows under a tile that says seven (the #647 lesson, one level up). For the same reason the filters apply to **every** task slice of the payload (the countdown tile excepted: an entry is there because somebody explicitly marked it, not because it is in a list, and a category filter that made a marked task disappear would undo a deliberate decision), not only the tasks widget's list - tasks appear in four places on that page and events in three, and a page that filters some of them contradicts itself. "Assigned to me" means exactly what it means in the calendar module (`belongsToMe`): among the assignees, so an unassigned event is not "mine". The filters go into the SQL through the same shared fragment the Tasks module uses (`taskCategoryWhere` in `services/task-scope.js`, which is why the category filter moved into that service - it stopped being a wish only one side knew); `GET /api/v1/tasks?category=` now accepts several values, OR-combined like status, priority and assignee (#671), where before a second `category` parameter made the statement fail outright. The two tiles that carry options are hidden by default - the cockpit already covers their domains - so the options button sits on the tile **and** on its chip in the hidden-widgets tray: their filters keep applying to the cockpit and the header band while the tile is away, and having to un-hide a tile in order to configure what it does not show would be the wrong way round (`test:frontend-audit` holds that rule, keyed to the overlap between `COCKPIT_COVERED_WIDGETS` and the widgets that have options). Since the options only arrive with the preferences response, the first dashboard request would not know them - so the device-scoped layout hint (`utils/dashboard-layout-hint.js`, already used to predict the skeleton, dropped on logout) remembers the query path too; a wrong prediction is corrected before the first render, and the steady state stays at one request.

**Birthdays in the calendar tile (#927):** the calendar widget's options dialog carries a second switch, "Birthdays", worded exactly as the layer switch in the calendar module's filter sheet. A household that keeps the Birthdays tile on the overview otherwise reads every birthday twice - once there, once between the next appointments. It is a widget option and **not** a reading of the calendar module's layer switch, which lives in `localStorage` under `yuvomi:calendar:layer:birthdays`: that one is scoped to the device, widget options are scoped to the account, and one value with two scopes would mean unchecking it on the phone silently decided what the wall tablet shows - or did not, depending on which of the two is read. Only the removal travels (`?events_birthdays=hide`), the same rule under which `scope: 'all'` is not stored: birthdays are in unless somebody takes them out. `getUpcomingEvents` filters them **before** the cap, next to the `assignedTo` filter and for the same reason, so the freed rows fill with the next real appointments rather than leaving a shorter list. A birthday is recognised by `birthday_name` - the `LEFT JOIN` on `birthdays`, the same condition `isVisibleLayer` uses in the calendar module - never by its title, which is stored in the household's data language (#524) and would match nothing in a household that does not speak German. The Birthdays tile, the birthday metric and the countdowns are untouched: they are their own domain with their own switch, and this option is about the one place where birthdays ride along.

**The overview selects the same tasks as the module (v2.32.0 · #825):** both answer "what is up?", and each had its own copy of the rules. `GET /api/v1/tasks` leaves out subtasks (`parent_task_id IS NULL`) and anything whose `start_date` is still ahead; the dashboard route knew neither, so a subtask stood in the list as a context-free row of its own and a task starting next week was already there today. The two shared rules now live in `server/services/task-scope.js` and are applied by the tasks route, all five task queries of the dashboard and the MCP tool - the same arrangement `calendar-events.js` has always had between the calendar route and the dashboard. **The metric tiles run the filter too, not just the list:** `urgentTasks` caps at five while `openTaskCount`, `overdueTaskCount`, `memberTodayTasks` and `tasksDoneToday` count without a limit, so filtering only the list would leave two rows under a tile claiming four. What stays with the individual route are the viewer's filters - status, priority, person, category, tags and the archive axis - because those say what someone wants to see, not what a list may contain. The day is passed in as a local calendar key rather than read from SQLite's `date('now')`: `start_date` is a locally entered day, and the UTC one differs from it for part of every day west and east of UTC.

**Widgets:**
- Greeting: "Good [morning/afternoon/evening], [Name]" + date; auto-refreshes on `visibilitychange` so the greeting stays current during long sessions. Since v2.4.0 a quiet weather line ("25° Mostly clear") sits under the greeting whenever the weather card is not visible in the grid; since v2.21.0 its glyph carries the condition's tone (and nothing else - the line stays incidental context, without light or movement), so the two displays never name the same weather in two colours
- Weather: server-side proxy with two providers — **Open-Meteo** (default, no API key, WMO codes mapped to Lucide icons and translated via `wmo.*` i18n keys) and **OpenWeatherMap** (legacy, via `OPENWEATHER_*`). Provider resolves from DB preferences (Settings → Administration → Household weather) first, then env vars. 5-day preview, refresh every 30 min, hide widget on API error. **Default-hidden since v2.4.0:** the masthead line carries the current weather; the card with its forecast is the wall-tablet opt-in in Customize. **Weather-derived tone and motion (v2.21.0):** the widget's colour comes from the condition instead of `--module-dashboard` - six tones (clear, night, cloud, rain, snow, storm) derived from the **icon key**, not from the description (that one is localised and, in the OWM branch, free prose), so both providers resolve through one map. A parallel domain family, not a tenth family tone: no condition shares a family tone's value and none appears outside a weather surface. All twelve values (light + dark) are measured to **4.5:1** against their three real grounds rather than the 3:1 an icon would need, because the same tone also carries the forecast's high temperature. A soft radial light sits behind the glyph in that tone (`--tint-surface` core, `--tint-wash` field); it belongs to the backdrop-blob family and shares its switches (`--weather-glow-opacity`, 0 under `prefers-reduced-transparency` / `prefers-contrast`), and it is anchored to the glyph rather than to the card because above 860px container width the glyph moves into the middle of the card. Four gaits keyed on the **icon** and not on the tone (`sun` and `cloud-sun` share a tone and move oppositely): rays rotate, clouds drift, precipitation falls, a storm flashes the light instead of the symbol. All motion lives inside a `prefers-reduced-motion: no-preference` block instead of being switched off by a `reduce` counter-rule - the counter-rule lost on specificity against the `:not(:first-child)` in the precipitation selector and left the rain falling while the sun stood still. The forecast row carries a **temperature-span bar** normalised across the whole forecast (position = where the day falls in the week, length = its swing, colour = one of five named bands; five bands rather than an interpolated ramp, because an interpolated mix would have needed its value at the element and would then sit outside the tint scale's guard), and every column is named from **its own date** rather than its position (#851). The server hands the running day over as its own `today` field - the calendar day **at the weather location**, which neither the browser nor the household zone can know - and `forecast` holds only the days after it. Naming the first column "Today" regardless was therefore off by a day: the row started at tomorrow and read as though a day were missing. `today` also carries that day's high and low, which the main block now shows beside the current reading; without them the card carried a span for every day except the one it was actually describing
- Upcoming events: next 3–5, color-coded by person; each row navigates to `/calendar?open=<id>&date=YYYY-MM-DD` so the event detail popup opens on the displayed occurrence, including recurring series instances
- Urgent tasks: priority urgent/high + due_date ≤48h
- Today's meals: meals for the current day
- Pinboard preview: pinned notes first, then the most recently changed, with Markdown formatting rendered. The payload supplies five and the tile decides how many appear (`listRowCap`, same as birthdays) - three rows for a one-row tile, five for a taller one. It used to cut at three on the server for every size, which made three the ceiling for the 1×2 default the tile ships at: a household with five pinned notes saw three, with the metric tile beside it saying "5 pinned" (#928). The list is a **preview and not a filter** - past what the tile holds, `/notes` is where the rest lives, and the pin ordering plus the `updated_at` touch a pin write causes means a freshly pinned note is always at the front of it
- Birthdays: the payload supplies the five nearest; how many appear is the tile's decision (`listRowCap`, v2.6.0) - three rows for a one-row tile, five for a taller one. The server used to cut at three for every size, which left the 1×2 default a third empty with no material to fill it
- Key dates (v2.18.0 · #647): the flagged calendar events and the flagged tasks in one list sorted by how near they are, each row leading back to its own **object** — the task quick-action for a task, the calendar day for an event. The wording is coarse while the date is far off and exact once it is near — exact days up to 30, then about-weeks / about-months / about-years, with no threshold setting — and the **colour says how soon**, while the origin colour sits on the mark at the left. A date that has passed stays a week as "3 days ago" and sorts to the top; recurring entries are exempt and point at their next turn. Unlike every other tile it has **no "All" link in its header**: it belongs to two modules, so a header link would have to pick one and be wrong for the other half of the list; what does not fit is named as "+N more" instead. It is **not offered while nothing is flagged** — like Family in a single-person household it then falls out of both the grid and the Customize tray, rather than rendering an empty card on every dashboard, and it returns to its saved position with the first countdown. Its `permissions.js` entry carries `module: null` for the same reason as the metrics row; the individual rows check their own module
- Budget: the monthly balance as a stacked readout (label above, 28px figure below - it used to be a 22px amount at the right end of a caption line, built like the supporting metric under it), the savings rate with its track, and a quiet income/expenses line
- Family members: since v2.4.0 a per-member "today" card — avatar, name, and what today holds (next own appointment, open-task count from `memberTodayTasks`); on free days the member's next upcoming appointment. Since v2.6.0 a footer closes the card with the household's task tally for the day ("Tasks today: 3 open, 2 done", or "No tasks assigned for today" when both are zero). Not offered in a household of one. The "Manage" header link leads to Settings while the seal deliberately speaks the contacts tone (people, not administration)
- Rewards (v0.96.0): family points leaderboard — top 5 enabled participants by ledger balance, the leader row subtly tinted (no medal/emoji), plus a "N to approve" footer when redemptions are pending
- Health (v0.96.0): today's medication doses as a "taken/total" progress bar with the next open dose and a low-stock reorder chip. **Personal scope (v1.50.1 · #592):** only the signed-in user's **own** medications are aggregated (private *and* family-visible ones); another member's medication never surfaces here, not even with `visibility = 'family'`. Shared medications stay on the Health page, which keeps its family-visible read scope
- Housekeeping (v0.96.0): compact status — currently-present indicator (worker + since-time) or last visit + this-month visit count, plus an outstanding-amount chip
- Schedule (Schedule v2): who is on shift or free today, one row per member with a resolved entry (the widget reuses `resolveEntries()`'s own rule — a member with neither a pattern nor an override for today has no row at all, the same as the module's own "today" card). Like Cycle, its own slice: `/dashboard` never carries it, the tile fetches `GET /schedule/entries` (household-wide, no owner scoping needed) plus the shift-type list client-side, and only when the tile is enabled. Default-hidden, offered as an opt-in in Customize; hidden when the Schedule module is disabled
- Cycle (v0.98.0): **owner-only, opt-in** prediction glance — current phase, cycle day in a mini progress ring, and the next period as a countdown + date. Unlike the family-visible widgets, cycle data is **never aggregated into the shared `/dashboard` payload**: the tile fetches the signed-in user's own `/health/cycle` data client-side, and only when the tile is enabled. Default-hidden, offered as an opt-in in Customize; hidden when the Health module is disabled
- Clock (v1.84.0 · #651): time and weekday + date, built for a wall tablet without a system bar. The digits scale with the tile width (container query on the existing `dashboard-widget` container, capped by row count so a one-row tile does not blow the date off the card), follow the user's 12h/24h and date-format preferences, and tick on the minute rather than the second (the display has no seconds). A `visibilitychange` refresh catches up after a throttled background tab. **Default-hidden:** on a device with a system clock a second one is duplication, so it is offered as an opt-in in Customize
- Metrics row: up to four module tiles in one row, each carrying a count and a jump target, for the modules that are reachable only through "More". The row shows what is **not already on the screen**: a module the "Heute" panel already summarises is skipped, and so is one whose own widget is visible, so it follows the current layout instead of holding its own idea of it. In practice it leads with the modules a standard dashboard has no widget for at all - rewards, health and the housekeeping log. Where a household does not use those, no tile appears and the widget renders nothing. Counts come from the shared `/dashboard` payload (`openTaskCount` and the per-module figures beside it), not from one request per module. It is a widget like any other: it moves, hides and resizes in Customize, and it can be locked for a member. Its `permissions.js` entry carries `module: null`, like Family, Weather and Clock - it belongs to no single module, and it does not need to, because **each tile checks its own module** and a locked budget therefore never produces a budget tile. What the row-level lock adds is the ability to take away the row as such
- Quick links (#469): a row of household links - name, address, picture, and who sees it. Not a module and therefore without a page of its own: managing them starts from the tile, because whoever sees the row is already where it belongs. Each tile opens in a new tab with `rel="noopener noreferrer"` and `referrerpolicy="no-referrer"`, so a target on the home network learns nothing about where this household runs its Yuvomi. A private link carries a lock mark. **Default-hidden:** on day one the row has nothing to show, and a tile that only asks to be set up is not worth adding to every existing dashboard unasked - it is offered as an opt-in in Customize. Its `permissions.js` entry carries `module: null`, like Family, Weather and Clock
- FAB (quick actions): + Task, + Event, + Shopping list item, + Note

The newer modules (Rewards, Health, Housekeeping, Schedule) start **hidden** by default — they are specialised and not active in every household, so they are offered as opt-ins in **Customize** rather than adding empty tiles to a fresh dashboard. Existing saved layouts are untouched.

**Widget sizes:** each widget has a configurable size using named presets (Tiny, Narrow, Tall, Standard, Large, Full) that map to `columns × rows` in the CSS grid. List widgets (tasks, calendar) default to the tall/narrow **Tall** (1×2) preset so a short list keeps useful height without occupying a full two-column row. Sizes are persisted in user preferences and survive page reloads.

Skeleton loading instead of spinners (the skeleton mirrors the default-visible widgets at their correct grid-spanning sizes to prevent layout shift). Clicking any widget navigates to that module.

**Immich photo screensaver (v2.3.0 · #693):** a dashboard left on a wall tablet burns itself into the panel, so after five minutes without input an overlay takes over the screen and rotates a photo every 20 seconds until the next touch, pointer, key or scroll. The dismissing gesture belongs to the overlay and does not reach the control underneath it. The caption (date, city, country) moves between the four corners so the protection introduces no fixed bright area of its own.

The credentials never reach the browser: `GET /api/v1/screensaver/photos` returns only asset ids plus that caption metadata, and `GET /api/v1/screensaver/photos/:id` proxies Immich's `preview` thumbnail — deliberately not `fullsize`, which would additionally require `asset.download`. Both refuse an id that is not a UUID before building an outgoing request, and the proxy rejects a response that is not `image/*`. Configuration lives in `sync_config` (`immich_url`, `immich_api_key`, `immich_screensaver_album_id`) behind admin-only routes with a connection test and a preview; `IMMICH_URL`, `IMMICH_API_KEY` and `IMMICH_SCREENSAVER_ALBUM_ID` set the same values and win over the database, as everywhere else. Without a URL and key the feature reports itself disabled and the overlay never starts. Split-expense guests are refused by the household guard like every other module route.

**Wall mode (v2.5.0):** the *awake* counterpart to the screensaver's *resting* state — the dashboard in a different gait for someone walking past a hallway or kitchen tablet who wants to know, in two to three seconds and from two metres away, what is still on for today, without touching the device. It is a **state of the dashboard, not a route**: same `/`, same data, same silent refresh, same echo rule; only scale, density and operability change. A second place that builds "today" would be a second truth.

It is **device-local and switched on by hand** (`localStorage` key `yuvomi-wall-mode`, like theme and locale). A server-stored setting would flip the phone dashboard for everyone in a household that shares one account, and auto-detection by device shape would create a state on a laptop that nobody asked for. The switch lives in **Settings → Appearance**, next to the two other device-local settings, not in Customize (which writes the signed-in member's widget configuration, see below). **Since v2.60.0 (#915) the overview carries a second, shorter way in**: an icon button in its toolbar, the literal counterpart to the exit on the wall surface. Until then the mode could only be switched on in the settings but was left on the overview — you walked out where you could not walk in. There is deliberately no switch governing whether that button appears: it would sit in the same settings the mode itself lives in, and you would have to find the second switch to be rid of the first.

The surface carries four things, in this order: **the time**, large (this is where the 48/72px display steps get the role Typography reserves for them, `clamp(--text-5xl, 9vw, --text-6xl)`); the **day program**; **who's up today**; and the **weather** with its forecast. Sidebar, tab bar, FAB and the install prompt all step aside — at two metres they are a row of unreadable targets and an invitation nobody accepts.

- **Read state, not operate.** The program rows are text: no link, no button, no quick-action dialog. Touchable rows would need distance-sized hit targets and lead into views built for arm's length; anyone who actually wants to act is one tap from the dashboard. This also makes the single touch point of the surface unambiguous.
- **The way out is quietly present, never hidden.** A control in the bottom-right corner sits in the DOM at all times, is reachable by keyboard, and shows only its glyph in secondary ink at rest; any pointer or key activity raises it to a full labelled capsule for six seconds (`data-wall-awake`). `Escape` leaves as well. A visible button would contradict the calm surface; an invisible one would be a trap.
- **Night dimming, 22:00 to 06:00.** The tablet hangs in the hallway and glows at three in the morning, and the problem is luminance, not colour mode — a dark theme still glows. The dark ground is therefore *forced* (`data-theme="dark"` on the root, without touching the stored preference, which `wall-mode.js` restores from at 06:00), and the only filled surface of the page — the program list — becomes a hairline while the ink steps back one notch. Since v2.21.0 the weather gives up its colour and its movement here as well: at two metres every one of the four forecast days normally carries its own condition tone (unlike the card, where a span bar takes that job and the forecast glyphs stay secondary), but an amber sun glyph at three in the morning would be the brightest point in the hallway. Nothing is hidden: whoever walks past at 06:05 reads the same surface as at 18:00, only quieter. All states stay ≥ 4.9:1.
- **Its own cap.** Four program rows plus the timeless shopping row, not the cockpit's six: a distance row is ~88px, and six of them plus clock, section head and footer measured 892px — off the bottom of the smallest realistic wall tablet (1280×800), exit included. A wall cannot scroll. The overflow does not lie: "+N more today" counts from the same model.
- **Who's up today** shows faces, not name lines — a face is recognised faster at two metres than a row of text — each with a counter of how much of today is theirs. It counts across the *whole* day, not the capped rows, so nobody disappears behind the cap. What the items *are* stays in the program on the left (no echo). Not offered in a household of one.
- **Self-healing instead of a retry button.** The wall error state is a distance-readable line with the clock still running beside it (the clock needs no network and proves the device is alive); the surface retries itself every 60 seconds rather than showing a button nobody at a wall will press. An empty day speaks with the same copy as the cockpit — at distance, an empty area reads as a defect.
- **Sizing hangs on the short side.** Everything except the clock scales with `vmin`, not `vh`: with `vh`, rows grew on a *portrait* tablet (768×1024), where height is plentiful, and pushed the footer out of frame. The stage splits into two columns above a container width of 768px; below that the aside places "who" and "weather" side by side so the stacked layout still fits. Guarded in `test-frontend-audit.js`.
- **Kitchen timer (v2.60.0, #844).** A hand-started short timer, five presets, mm:ss in distance-readable
  type, a chime built from three synthesised tones rather than a shipped audio file. It was asked for as a
  timer *plus* a cross-device notification, and it is exactly that notification that would have forced a
  server-side timer, because a phone suspends the page as soon as the screen locks. The reporter scaled the
  wish back himself, and what remains runs in the browser of the device that hangs on the wall anyway: no
  endpoint, no table, no migration. Its whole state is one number in `localStorage` (the deadline), which is
  what lets it survive the silent refresh that rebuilds the surface.
- The screensaver lays itself over the wall mode after its idle time, exactly as it does over the normal
  dashboard — **except while a timer runs** (v2.60.0): a countdown that expires behind a photo is not a
  timer. It reads the same `data-wall-timer` attribute the timer sets, one source and two readers, and the
  attribute drops the moment the timer rings so an unacknowledged timer cannot disable the screensaver for
  good.
- **"Display only" does not mean "no buttons".** The exit has been on the surface since day one and the
  entry point joined it in #915; the promise is narrower and therefore holds: the wall leads nowhere and
  changes nothing in the household. The kitchen timer was the first case to test that edge, so the header of
  `public/utils/wall-mode.js` carries an **admission rule** rather than a named exception — an expiry date on
  something meant to stay would be a lie in a comment. A control may go on the wall when it (a) does not
  navigate, (b) changes nothing server-side, (c) stays on this device, and (d) is operable from two metres.
  `test-wall-timer.js` checks those four against the built markup rather than against the intent.

### Tasks (`/tasks`)

**Views:**
- List view (default): grouped by category or due date (toggleable), filter: person, priority, status. **Category groups follow the managed order (v2.39.0, #845):** their sequence is the position in the category list the server returns, i.e. the `sort_order` set by dragging in **Manage categories** - not the alphabet. Until then the groups were sorted with `localeCompare(b, 'de')`, which ignored that order, compared the internal key rather than the visible label (`misc` sorts under M while the page shows "Sonstiges"), and applied German collation to every language. A category missing from the list sorts last, and only among those does the label decide, in the active locale. **Each of those three axes takes several values at once (v1.78.1, #671)** and combines them with OR — "high or medium" is a question worth asking, while AND across two priorities would always be empty, since a task carries exactly one. The axes still combine with AND among themselves, so every row narrows the list. Tags stay AND-combined (see [Task Tags](#task-tags-migration-v115-586)); there a task really can carry both. `GET /api/v1/tasks` takes each value as its own parameter (`?priority=high&priority=medium`) and keeps accepting a single one
- **Collapsible groups (v2.28.0, #812):** each group header is a button (`aria-expanded`, keyboard-reachable) that folds its rows away; the count stays on the collapsed header, so the size of a folded group is still readable. Collapsed groups are stored per device in `localStorage` (`yuvomi:taskCollapsedGroups`) as `<mode>:<id>` — the mode belongs in the key because a category may be named like a due-date group, and the id is the category key or a fixed name (`overdue`/`today`/`thisWeek`/`nextWeek`/`later`/`noDate`), never the translated label: `groupBy()` returns `{ id, label, tasks }` for exactly that reason, otherwise "Heute" and "Today" would be two groups and every language switch would unfold everything. Only collapsed state is stored, so a newly created category appears open.
- Kanban: columns Open → In Progress → Done plus the archive, drag & drop. **The board drags through the shared sortable wrapper since v2.60.0 (#808)**, which distinguishes a long press from a short one (`delay: 120`, `delayOnTouchOnly`): holding picks a card up, swiping stays scrolling, and the mouse still drags immediately. Before that the board carried two drag implementations of its own — native HTML5 DnD for the mouse and a hand-written touch simulation beside it — and the touch half had a threshold of the wrong kind: eight pixels of distance and no time, so scrolling over a card took it along. The board stores no order *within* a column, so it offers none (`sort: false`); the advance-status button on each card is excluded from dragging and remains the keyboard path
- **History (v2.44.0, #791):** the third view, and the only one that does not show tasks but
  occurrences: who ticked off what, and when. Grouped by calendar day in the display timezone
  (`zonedDateKey`, not `completed_at.slice(0, 10)` — the stored instant is UTC, so a tick at 23:30
  local time would land under the next day west of it), newest first, with an optional filter by
  person and a "Show more" cursor. Search, the filter bar, grouping and bulk select disappear here:
  they all ask about tasks, and a status filter over a list of completions would be a choice that
  cannot change anything. See [Task Completions](#task-completions-migration-v161-791) for the data
  model and why the view starts empty. A recurring task additionally carries **Last completed** in
  its detail view, across the whole repetition chain rather than just the instance currently open.
- View mode persisted in localStorage; URL parameter `?view=kanban` (or `?view=history`) overrides (useful for tablet kiosk setups)

**Features:**
- CRUD + subtasks (max 2 levels, checkbox list, progress bar). Subtasks are tickable **wherever they are visible** — on the task card and, since v1.78.1 (#671), in the detail view too. Read-only rows there had assumed the list next door would carry the interaction, but that list keeps them behind a collapsed progress bar, so a freshly created subtask could end up visible and unreachable at the same time. **Adding one works wherever the task is open, including the first** (v2.52.1, #925): the detail view offers "add subtask" on the same terms as the card row (may edit the task, not archived, not itself a subtask), and its section now stands even when empty — the same rule the comments below it follow. The card hides its inline actions below 640px by design, and the "add" button for the *first* subtask hung on nothing else, so on a phone every later subtask could be added and the first could not. This is the second instance of one pattern: a view that assumes the view next door carries the interaction, while that one is closed on exactly the device in question. `test:frontend-audit` reads the card's inline actions out of the markup and requires a reachable path for each in the detail view
- **One reading view, wherever a task is shown (v2.53.0, #918):** clicking a task in the **Overview**
  or on a task chip in any of the four **Calendar** views opens the same detail view the Tasks module
  opens, in place. Before this, the Overview brought up a card with two buttons ("Edit", which
  navigated into the Tasks module, and "Mark as done"), and a calendar chip navigated away outright —
  everything else a task carries (subtasks, comments, attached documents, the tickable checkboxes in
  its description, due date, assignee, points, history) was neither visible nor reachable from there.
  That weighed more than two missing buttons sound like: the Overview is where the app stands open
  during the day, the Tasks module is where tasks get created and groomed, and the view with fewer
  capabilities was the one used more often. The view lives in `public/components/task-detail.js` and
  the surrounding view tells it what it cannot know — who is looking (`currentUserId`, `isAdmin`),
  what it can resolve (`users`, `categories`), and how to refresh itself (`onChanged`, so the
  calendar refreshes its day and the widget its tile rather than navigating anywhere). What a field
  of a task *means* (archived, editable under the lock, how its due date reads, its category label)
  moved alongside into `public/utils/task-fields.js`; those rules had already been copied into
  `dashboard.js` once, which is the drift this prevents. Permission checks travel with the view: a
  locked task (#830) stays uneditable from the Overview, and a read-only member gets the conversation
  without an input field. **The edit form stays with its module** and is handed to the view as a
  mounter — a caller that gives none gets a reading view without an Edit button rather than one that
  leads nowhere, and the same applies when `/tasks/meta/options` fails, since a category select with
  no options produces a save the server rejects. `pages/tasks.js` exports `openTaskById(taskId, {
  user, container, onChanged })` as the single outside entry point, loaded dynamically so the task
  form's weight stays out of the Overview's startup — **and it ensures `/styles/tasks.css` and waits
  for it**, because the router keeps exactly one page stylesheet loaded and both the reading view and
  the form take their appearance from there.
- **Renaming and removing a subtask (v2.12.0 · #748):** each subtask row carries a rename and a delete action beside its checkbox, at the same size and in the same restrained tone as the actions on the task row above it. Deliberately **not hover-only** — a touch device has no hover, and correcting a typo is exactly where a phone is the likely device. Deleting asks first and names what it removes, since ticking off is reversible and this is not. The server needed nothing for this: a subtask is an ordinary task with a `parent_task_id`, so `PUT`/`DELETE /api/v1/tasks/:id` already covered both.
- **Subtasks expanded by default (#623):** a household-wide preference (`tasks_subtasks_expanded` in `sync_config`, admin-gated, default off) decides whether the subtask list of a task starts open instead of collapsed behind its progress bar. Manual expand and collapse still work per task; the preference only sets the starting state. Settings → Modules → Module options.
- **Multi-person assignment:** tasks can be assigned to multiple family members simultaneously via `UserMultiSelect` checkbox dropdown; stacked avatar circles (up to 3 visible + `+N` overflow badge) shown on task cards and Kanban — each circle shows the member's profile photo if set, otherwise coloured initials
- Priorities shown visually via color/icon
- Recurring: automatically create next instance on completion
- **Archive (#688, migration v132):** archiving is its own axis (`tasks.archived_at`, `NULL` = in play), not a status value. It used to be a fourth status, so filing a finished task away overwrote its `done` — the task came back as unfinished, `syncTaskRewards` reversed the points earned for it, and it then showed up in "Today at a glance" where it could not be opened because every list hides the archive. A task now keeps the status it had: archived-and-done stays done, archived-and-open stays open. `PATCH /api/v1/tasks/:id/archive` (`{ archived }`) files and restores; `PATCH /:id/status` with `archived` and `PUT /:id` with `status: 'archived'` keep working for existing clients and mean "file away", never "overwrite the status". Lists hide the archive unless asked: `?archived=1` includes it, `?archived=only` and `?status=archived` (the filter chip) return just the archive. The Kanban archive column and the dashboard both go through the same axis. Migration v132 backfills existing archived rows to `done` — the previous status is not recoverable, and "archived means finished" is the only defensible reading; no reward is booked retroactively.
- **Locking a task (#830, migration v155):** module permissions only know read-only for the whole module, and read-only also stops a child from ticking anything off — which defeats the purpose. The lock therefore sits on the individual task and splits two things that used to be one: the **definition** (title, description, category, priority, dates, recurrence, points, visibility, tags, sync target, linked documents, archiving, deleting, and the lock itself) is closed, while the **interaction** (viewing, ticking off, commenting, personal reminders, assigning *oneself*) stays open to everyone. Deliberately **not** derived from `family_role`: a family role says who somebody is, not what they may do, and "parent" is not a single value there — `dad`, `mom`, `parent` certainly, `grandparent` depending on the household. #584 already replaced that inference with explicit grants; here the holders are the **creator plus admins**.
  - Assigning *other* members is definition, assigning *oneself* is interaction — otherwise a child would simply push the task onto a sibling, which is the case the lock exists for.
  - A **subtask inherits its parent's lock**: it is a point of the same instruction, so a free subtask would make the parent's lock worthless. Adding a subtask to a locked parent needs the same rights.
  - `PUT /:id` compares the **resolved outcome against the stored row**, not which fields were sent: the edit dialog always posts the whole task back, so "field present = attempted change" would reject the very tick-off the lock is meant to preserve.
  - The three bulk tag routes (`POST /tags/apply`, `PUT|DELETE /tags/{tag}`) **skip** locked tasks instead of rejecting the whole call, and report the count as `skipped`. Tagging 40 tasks should not fail because one of them is locked — but a silent partial run would be worse than an error, so the toast says what was left out.
  - Known boundary: an **inbound CalDAV sync** can still rewrite a locked task's mirrored fields. That sync runs with household credentials rather than per member, and anyone holding them has full access to the list anyway; forcing the mirror to diverge silently would be worse than the gap.
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
- **Mobile swipe (sides swapped in this release):** swiping towards the row's **start** (right in LTR, left in RTL) marks the task done or reopens it; swiping towards its **end** opens the task. The panels are addressed as `leading`/`trailing` in `public/utils/swipe-row.js`, not as left/right, so the gesture mirrors correctly in RTL. Existing users are told once via `common.swipeSidesSwapped`.
- **Sync target on a new task (#695):** the task dialog carries a "sync target" field, the same shape the event dialog has had since #620, listing only the reminder lists the household enabled *for tasks*. Prefilled from `tasks_default_target`. It is absent for subtasks (they carry no target of their own) and replaced by a sentence on a task that is already mirrored — moving a task between lists is deliberately not offered, so a dropdown there would promise something the sync does not do. `GET /api/v1/tasks/sync-targets` serves the options to every logged-in member, with no credentials or server URLs in the payload.
- **The note is a note (#731):** the free-text field is six rows, not two, and the read view renders it as Markdown through the same `renderMarkdownLight()` the notes module and the dashboard use — so a checklist, a heading or a bold word looks the same wherever it appears. The editor carries the same `.md-toolbar` the notes module does — not a copy of it but the shared component both draw from, so a checkbox written in a task is the same characters as one written in a note.
- **Tappable checklists in the description (#917, v2.52.0):** the rendered `- [ ]` boxes are real
  controls in the task detail view, the same way they have been in Notes since #704 — the same rule
  from `public/utils/markdown-checklist.js`, imported by both browser and server, one more caller
  rather than a second implementation. `PATCH /api/v1/tasks/:id/check` rewrites exactly the one
  source line, so two members ticking different items in the same minute both keep their tick; a
  full-body `PUT` would have let the later save drop the earlier one silently. Addressed by source
  line number (`data-md-line`), never by item text, with the line the client saw sent as `expect` and
  a mismatch answered `409`.

  Two rules diverge from a plain description edit. **The lock (#830) does not stop a tick:** it
  covers what the task *is*, not how far it has come — `PATCH /:id/status` deliberately has no lock
  check either, and `toggleChecklistLine` cannot change anything but the one character between the
  brackets. **Visibility does apply**, answering 404 rather than 403 so a guessed id says nothing.
  And because `description` is a *mirrored* CalDAV field, a tick marks the row for outbound push —
  without that it would stay local and the next inbound would bring the unticked line back. A
  repeated tick on an item already in that state changes nothing and announces nothing.
- Badge for overdue tasks

### Shopping Lists (`/shopping`)

- Multiple lists in parallel
- Items: name, category, quantity, checkbox
- Grouping by category (aisle logic)
- Integration with meal plan: "Add ingredients to shopping list" transfers with source reference
- **Bulk import from meal plan (v1.3.0):** a "From meal plan" action (in the list header until v2.2.3, since then in the chip row's overflow menu) opens a date-range dialog (defaults to the next 7 days) and imports the ingredients of every planned meal in that range into the active list. Repeated ingredients are aggregated before insertion — numeric quantities with a matching unit are summed, purely textual quantities collapse to a `N × …` note. Already-transferred ingredients are skipped via the existing `on_shopping_list` flag (`POST /api/v1/shopping/:listId/import-meal-plan`).
- Checked items shown with strikethrough + moved to bottom
- **Manual item order within an aisle (v1.87.0, #678):** every row carries a drag handle next to its edit and delete actions. Dragging reorders within the category group only — a drag across groups would be a category change, which the item dialog already does, and ranks are per category anyway. The handle is a real button and takes ArrowUp/ArrowDown once focused, sharing one persistence path with the drag; that keyboard route is required of every `makeSortable` caller (see the header of `public/utils/sortable.js`) and is guarded in `test:frontend-audit`. Its `aria-label` carries the position, and a `role="status"` live region announces each move, reusing `category.reorderAnnounce`. Checked rows are filtered out of the drag and their handle is disabled — they sort last in their group regardless of rank. A category holding a single row hides its handle via `:only-child`. `PATCH /api/v1/shopping/:listId/items/reorder` takes `{ category, order }` and requires the **complete** group: a partial list would leave the omitted ranks colliding with the newly assigned ones. Requests are serialised per category with at most one follow-up queued, so rapid moves settle in the order they were made instead of letting the arrival order at the server decide; the follow-up reads the DOM when it starts, so any number of moves costs two requests. The list id is captured when a move is queued, so switching lists mid-flight neither misroutes the write nor overwrites the new list's state.
- **Send the list to a member by email (#944):** an entry in the overflow menu mails the list's open
  items to one household member, grouped by category in the same shop order the screen shows.
  Deliberately a **snapshot and not an access route**: no link, no token, nothing that outlives the
  message. A read-only share URL would have been the first unauthenticated HTML view of household
  data in Yuvomi, and a leaked link stays leaked; someone who needs the list continuously is a member
  and already has the app. The mail says which moment it captured, because whoever carries it around
  the shop cannot see what is being ticked off at home.
  The recipient is a `userId`, never an address. `POST /api/v1/shopping/:listId/send` resolves the
  address from that member's contact - the same source the password reset uses (`services/member-email.js`,
  shared with `auth.js` so "how do I reach this member" has exactly one answer). Accepting an address
  from the request body would turn the instance into an open mail relay for any signed-in user.
  Sending to yourself is allowed and drops the "X sent you this list" line.

  **A `users` row is not the same as a household member,** and that distinction is the security boundary
  here. Two kinds of account sit beside the household and both carry a contact with an address:
  housekeeping staff (an account so they see their own chores, not so they read the household's
  shopping) and shared-expense guests, who are external - `server/index.js` blocks them from every
  `/api/v1/*` route except `/split-expenses`, yet the guest sync gives them a contact row. Asking only
  "does this users row exist" treats both as reachable. The predicate therefore lives once in
  `member-email.js` (`isHouseholdMember`) and serves both the picker
  (`GET /api/v1/shopping/send-recipients`) and the route's own check, so the picker cannot offer someone
  the server rejects nor hide someone it accepts - a boundary drawn only in the interface is no boundary.
  It is deliberately *not* folded into `memberEmail()`: the password reset uses that same lookup and
  applies expressly to shared-expense guests too (`auth.js` names `isSplitExpenseGuest` as its own
  reason to send), so a guest must keep the route back into their own account. Callers needing both
  ask both. The picker endpoint returns names without
  addresses. `contacts.email` is free text and partly comes from CardDAV, so a value holding a list
  (`a@x,b@y`) makes a member *unreachable* rather than reaching both: nodemailer would treat `to` as a
  recipient list, and a password reset can be redone while a sent mail cannot be recalled. Requires the app-wide
  SMTP access (see [Email channel](#notification-channels)), and carries its own rate limit of 10 per
  minute per IP - the general API limit of 300 is right for reading and ticking off, and far too
  generous for something that puts mail in someone's inbox. Three distinguishable refusals rather
  than one "it failed": no address on the member, SMTP unconfigured, nothing open to send.
- "Clear list" = remove checked items only
- Autocomplete from previous entries (local)
- **Category management lives in Shopping** (no longer in Settings): a "Manage categories" action opens the shared `yuvomi-category-manager` modal (also reachable directly via `/shopping?manage=categories`) for add, rename, reorder, and delete - the same component as Tasks, Contacts and Budget, resolving default category names through their localization and preserving the API's last-category-deletion guard. The legacy Settings → Shopping tab redirects here.
- Mobile quick-add form uses a resilient grid: item name spans the row, quantity/category/add controls remain touch-safe at 390px width, and autocomplete stays anchored to the input.
- **Mobile swipe (sides swapped in this release):** swiping towards the row's **start** (right in LTR, left in RTL) checks or unchecks the item; swiping towards its **end** deletes it. The × delete button is hidden on mobile, the swipe takes over. Same `leading`/`trailing` vocabulary as Tasks, so the gesture mirrors correctly in RTL.
- **Deletion friction follows severity:** removing single items (or the checked ones) is undo-based (5-second toast), while deleting a whole list - which cascades to all its items - asks for confirmation first, mirroring the Budget convention for cascading deletions. **Both, for the list (v1.59.0):** the confirmation now names how much it destroys ("Delete list 'Weekly Shop' and 31 items?", with a separate wording for an empty list) and the deletion afterwards runs through the same 5-second undo as every other deletion in the module. The gradient used to be inverted — a single item had undo and no confirmation, the household's whole list had a confirmation and no undo.
- **Mobile head is one row (v1.59.0):** the three permanent head actions (from meal plan, manage categories, delete list) move into an overflow menu **with labels** below 768 px. They were three unlabelled glyphs before, one of them "Delete list". The two completion actions ("Into pantry", delete checked) move out of the head entirely into the shared `.list-bulkbar` above the list, where a line states what they act on ("3 items checked off"). Measured: head 173 px → 65 px at 393 px width (229 → 65 at 320 px), first data row 439 → 308 px of 852 px, 17 → 11 tab stops.
- **The head is gone entirely (v2.2.3):** it showed the selected list's name a second time — the active chip in the list picker above it already carries it — which is the no-visible-title-repetition rule (`DESIGN.md`). The chip *is* the title; the actions moved to the trailing end of the chip row, into one overflow menu that is now the same on every width and leads with **rename**. Rename had been the only affordance the head held that was not reachable elsewhere: it hung on the title as a `<span role="button">` with a pencil icon, which is why the head could not simply be hidden on mobile. As a real `<button>` in the menu it takes Enter and Space from the browser and needs no keydown handler. The menu trigger is sticky at the end of the horizontally scrolling chip row (the counterpart to the sticky list marker at its start) and names the list in its accessible label, so "Delete list" cannot be read out of context. Its panel uses the native popover API and therefore is not clipped by the row's `overflow-x`. Measured at 375×812 with quick-add collapsed: 53% → 64% content area, level with `/tasks` and `/budget`. Two special cases disappeared with the head — the actions no longer exist twice in the DOM with CSS choosing a version per width, and a `max-height: 499px` media query that forced picker and head into a two-column grid in landscape is gone, since there is no longer one row of chrome too many.
- **Quick-add is a disclosure on touch (v1.59.0):** the two-line quick-add form is collapsed on pointer-less devices and opened by the FAB, which until then was the only FAB in the kitchen that merely focused an already-visible field instead of opening a form. Esc closes it and returns focus to the FAB. On pointer devices the field stays open — it is faster than any button — and the redundant empty-state CTA is dropped there instead, because the input it points at is visible right above it.
- **Item editor (v1.59.0):** the detail dialog is titled "Edit item" (shared key with the pantry) instead of carrying the data value as its title, offers name, quantity and category besides link and note, and has a Cancel button. Before this it had two fields, no Cancel, and neither name nor quantity could be changed — a typo meant deleting the row and re-creating it. Deleting stays in the row (× on pointer devices, swipe on touch), both with undo.
- **"Apply" is disabled at zero hits (v1.59.0)** in the meal-plan import dialog, matching its sibling action "Randomize plan"; the preview enables it as soon as the range contains ingredients.

### Meal Plan (`/meals`)

**Desktop:** weekly planner board (Mon–Sun) with meal-type rows (breakfast / lunch / dinner / snack): each type is labelled once in a sticky left gutter column and the rows stay aligned across all days. Day columns keep a readable minimum width — when the viewport cannot fit the full week, the board becomes a horizontal scroll-snap window with an edge fade as scroll affordance instead of squeezing the columns (labels and dish names are never hyphen-broken; v1.40.1). **Collapsible recipe column (v1.57.0):** the sidebar costs 272–320 px, which is exactly what the board needs for the sixth and seventh day — with it open, Saturday and Sunday sit behind the scroll edge on a 1280–1440 px window, the two days a household is most likely to plan. A toggle in the week navigation folds it away, and the choice is remembered per browser. **Folded by default when the week does not fit (v1.58.0):** the default is measured, not tied to a viewport breakpoint — the column starts folded whenever the board would overflow with it open, because the number of columns depends on the visible meal types and shifts again with zoom and font size. An explicit toggle still overrides the default permanently. **Start-edge affordance (v1.58.0):** the sticky gutter column carries a hairline once the board is scrolled. The end fade alone was not enough: the board auto-centred on today, which pushed the first weekday behind the gutter's opaque background, and the start mask is deliberately disabled there because it would fade the gutter labels themselves. Auto-centring now only happens when today is actually out of view, so the week starts on Monday. **Empty week (v1.58.0):** a week without meals renders the shared empty state (icon, title, description, cross-tab hint, CTA) instead of up to 28 dashed boxes. **Mobile:** the same full week (Mon–Sun) stacked vertically and scrollable, auto-scrolled to today on open. **A meal is a row, not a stacked card (v2.24.1):** below 640 px the planner is a list, so it speaks the same row grammar as the three neighbouring Kitchen tabs — a text column with `min-width: 0` and a non-shrinking action zone at its end, in one line. Meals was the last of the four tabs that stacked instead (title, action row, add strip), which cost 172 px of slot height for sixteen characters of content and made one week 5830 px tall in a 454 px viewport. Measured after: slot 73 px, week grid 3056 px. The actions stay permanently visible — the row grammar's standing decision (contrast, not invisibility) is unchanged; it simply no longer costs a line of its own.

- Meal: title + notes + ingredient list
- "→ Shopping list" button: transfer unchecked ingredients of the week to a selected list
- **Ingredients of recipe-based meals (v1.57.0):** a meal planned from a recipe only stores its `recipe_id` and no ingredients of its own, so the shopping-list transfer used to have nothing to hand over and its button stayed hidden on exactly those cards. The week response now reports `recipe_ingredient_count` for such meals, and the first transfer materializes the recipe's ingredients into real `meal_ingredients` — after that the usual `on_shopping_list` flag guards the meal (unlike the reusable recipe) against transferring twice. Meals with ingredients of their own are untouched; theirs take precedence.
- Week navigation forward/back
- **The linked recipe has a way out (#936):** a meal can be tied to a recipe of the household's own (`recipe_id`) - the field is in the form, it is stored, and the shopping-list transfer reads it. The action button on the card, though, existed only for an **external** address (`recipe_url`), so the internal link had no exit: it could be created and never used, and anyone wanting to cook from the plan landed in the edit dialog. A second button now points at `/recipes?open=<id>`, the same deep-link spelling Contacts and the Overview already use; `/recipes` reads it, expands the recipe and scrolls it into view. Expanded rather than opened for editing - whoever comes from the meal plan wants to cook, which is the decision the recipe list already makes when a row is tapped. An `<a href>` rather than a button, so command-click, middle-click and "copy link" keep working; the handler only intercepts the plain click. A meal carrying both shows the internal recipe, since that jump stays inside the app.
- Drag & drop between days/slots
- **Recipe sidebar with drag & drop (v1.3.0):** a desktop recipe sidebar lists saved recipes; drag one onto any day/slot to plan it directly, with the recipe's title, notes, URL, and ingredients pre-filled. Slots only accept recipes whose `meal_types` suitability includes that slot — **except a recipe that declares no meal at all, which any slot accepts** (v2.8.1): the empty state keeps a recipe out of the automatic pick, it is not meant to make it unusable, and dragging it onto Tuesday evening *is* the decision. The two rules are separate helpers (`recipeSupportsMealType` for anything that selects without the user, `recipeAllowsMealType` for what the user does by hand). The existing per-slot `+`/add-button flow remains as the keyboard/touch path.
- **Week plan randomizer (v1.3.0):** a "Randomize plan" action fills the visible week's empty (or, opt-in, all) slots with randomly chosen suitable recipes, respecting each recipe's `meal_types` and the household's visible meal types. Reports how many meals were planned; no-op with a notice when the week is already full or no compatible recipes exist.
- Autocomplete from meal history
- **Multiple items per slot:** each day/meal-type cell can hold any number of meals, displayed as stacked cards with a separator. A hover-visible `+` button lets you add another item to an already-filled slot without clearing the existing entry. (v0.63.3) **Not on phones (v2.24.1):** below 640 px the empty slots are hidden and a labelled “Add meal” button sits under every day instead, so the per-slot button was a second visible path to the same action — 34 add affordances on a screen showing 27 meals, each one a full touch target tall. It disappears under exactly the condition that makes the per-day button appear; where the empty slots are visible it remains the only way to put a second meal in one slot.
- **Recipe integration:** Select a saved recipe from the meal modal to auto-fill title, notes, URL, and ingredients. Scale ingredient quantities by a numeric factor. Save the current meal as a new recipe with one click.
- **Weekly meal repeats:** New meals can be marked as weekly repeats from the advanced meal dialog. Yuvomi stores a recurrence template, materializes future occurrences for each loaded week, shows a repeat badge on generated meals, and records per-date skip exceptions when a single occurrence is deleted. Editing or deleting a recurring meal offers a scope choice — **this date only** or the **whole series**: series edits propagate the content fields and ingredients to the template and every materialized occurrence, while series deletion removes the template together with all of its occurrences. (v0.78.1, series scope v1.1.0)
- **Bounded repeats (v1.66.0):** a weekly repeat can carry a **repeat-until** date, set next to the repeat toggle when the meal is created and editable later under the series scope; leaving it empty keeps the series open-ended, as before. Materialization stops at that date, and shortening a running series removes the occurrences already generated behind the new end. Deleting a recurring meal gained a third scope — **this and all following** — which ends the series the day before that occurrence, keeps everything earlier, and stops the regeneration that previously refilled every week the moment it was opened. Ending a series on its very first occurrence drops the template outright. Without a boundary, an open series planted one row per meal into every week a user ever paged through, and the only way back was deleting each occurrence individually while the next week already produced a new one (#619).
- **Customizable meal visibility:** In Settings, users can toggle which meal types (breakfast, lunch, dinner, snack) are shown in the planner and the dashboard's Today Meals widget. Stored as household-wide preference in `sync_config` (key: `visible_meal_types`). At least one type must remain active.

### Recipes (`/recipes`)

Reusable recipe cards linked to meal slots.

- CRUD: title, notes, recipe link, per-ingredient category
- **Meal-type suitability (v1.3.0):** each recipe carries a `meal_types` list (breakfast / lunch / dinner / snack, all selected by default) chosen via checkboxes in the recipe editor. It gates which planner slots accept the recipe (sidebar drag & drop) and scopes the week randomizer's candidate pool. **Clearing every box means "no meal" and is kept** (v2.8.1, #750) — until then it silently turned into all four, which the editor only revealed when the recipe was opened again, and which made it impossible to hold a stock or a base sauce out of the randomizer. Such a recipe shows a neutral "no meal" badge in the recipe list and the planner sidebar, is skipped by the randomizer and the meal filters, and stays fully plannable by hand.
- Duplicate existing recipes
- **"Add to meal plan" (v1.58.0):** asks for the date and the meal type in a small dialog on the recipe card and creates the meal right there — no navigation, and the meal type is pre-selected from the recipe's own `meal_types` (dinner when the recipe declares several, and all four are offered when it declares none — see meal-type suitability). Before this it navigated to `/meals?recipe=<id>`, where the full 27-field meal form opened with an empty date field and a title that did not name the recipe; escaping left the query parameter behind, so a reload re-opened the form. The parameter no longer exists. This makes all five kitchen transfers one pattern: pick the target in a small dialog, then a toast naming what moved.
- **"Add to shopping list" (v1.57.0):** a second action on every recipe card that carries ingredients puts them straight onto a shopping list — one list transfers without asking, several open the shared selection dialog, the same pattern the meal planner and the pantry already use. Unlike meals, a recipe is **not** marked as transferred: it is a template that gets cooked repeatedly, so a `on_shopping_list` flag would be set forever after the first shop. Instead the server skips ingredients already sitting **unchecked** on the target list and reports `transferred` and `skipped` separately; items ticked off from an earlier shop come along again. Before this, the only route from a recipe to the list was plan → switch tab → "From meal plan" → pick week, four steps across two modules.
- **Row actions collapse on narrow rows (v1.59.0):** edit, duplicate and delete take 152 px of a 262 px row at 320 px width; below 30 rem **row** width (a container query, not a viewport breakpoint) they move into the shared overflow menu with labels, and the ingredient count drops below the title. Without this the recipe name fell to `min-content` — with `overflow-wrap: anywhere` that is the width of the widest single character: 8 px, one character per line, a 448 px tall row, one recipe per screen. Measured after: 182 px name, 69 px row height.
- **Recipe provider mirrors (#530):** with a recipe provider account connected (Settings → Kitchen - Mealie or Tandoor), its recipes appear in the same list as native ones, carrying a source badge in the collapsed row and a thumbnail, so a mixed list is readable without opening each entry. A source filter (all / native / one entry per connected provider) sits in the header as a menu button - the same popover component the row overflow actions use - and only appears once a mirrored recipe exists. Mirrored recipes are read-only: the UI drops the edit affordance and the server returns 403, so the two cannot drift. "Duplicate" forks one into an editable native recipe. They behave like any other recipe everywhere else: meal-plan picker (grouped by source when a mirror exists), shopping-list transfer, scaling. A rename at the source updates the mirrored copy in place instead of replacing it, so its meal-plan links survive. Each provider plugs in behind a shared adapter interface (`server/services/recipe-providers/`), the same pattern the DMS module uses for Paperless/Papra - adding a third provider needs a new adapter, not new sync/route/frontend logic.
- **"Planned this week" note:** every recipe that appears in the current week's meal plan carries a quiet secondary note next to its ingredient count, separated by the shared midpoint divider. Derived client-side from `meals.recipe_id` over the server's current week — no schema change, and a load error simply drops the note. The recipe list finally shows its own connection to the plan; on narrow rows the note yields and the ingredient count keeps its place.
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

**Choosing a view persists it, drilling into one does not (v2.51.0).** Tapping a day cell opens the day view for that date, but leaves the stored default alone - `setSavedCalendarView()` belongs in the tablist's `onChange`, where the user *chooses*, and nowhere else. Until v2.51.0 the drill-in wrote it too, so a navigation gesture silently changed a setting: three taps on a month cell and the calendar opened in day view from then on, with no feedback and no way back other than noticing it.

**The view switcher is a real tablist (v2.51.1).** The bar carries `role="tablist"` with one `role="tab"` per view, and `#cal-body` is its `tabpanel`. The relationship is deliberately asymmetric: the calendar has **one** body whose content is replaced, not four panels to show and hide, so the panel names the tab that currently labels it (`aria-labelledby`) and only the *active* tab carries `aria-controls`. An inactive tab pointing at the same element would promise that it holds *its* content. The shared `syncTabPanels()` helper (`utils/sub-tabs.js`) is therefore not used here - it manages N panels and hides the inactive ones.

**The agenda shows today even when today is empty (v2.51.1).** It otherwise lists only days that hold something, which is right for the weeks ahead and wrong for the first day: the header announces "From \<date\>" and the first row was the day after. A day that goes missing exactly when the answer is "nothing" reads as a loading error, not as a free day; it now carries a quiet `calendar.agendaDayEmpty` line instead. The exception is **today only** - every empty day as a row would be a list of emptiness. The `agenda-day__header--today` rule existed long before this and simply could never fire.

- CRUD: title, description, start/end, all-day, location, color, assignment
- **Flexible time entry (Discussion #442):** the time inputs accept compact (`0930`, `930`) and separator (`09.30`, `9,30`, `9h30`) notation in addition to `09:30`, `9`, and `9 am`; on blur the value is normalized to the locale's display format. Centralized in `parseTimeInput()`/`toTimeParts()` (`public/i18n.js`), so it applies to every time input in the app (calendar, tasks).
- **Default appointment duration (Discussion #441):** a household-wide default duration (Settings → Modules → Calendar; `sync_config.calendar_default_duration`, minutes, default 60) sets the end time of new events relative to the start. Inside the event dialog the duration is remembered dynamically: editing the end updates the remembered duration, and a subsequent change to the start re-derives the end from it (with roll-over past midnight). Timed events only.
- **New events follow the displayed period (v2.10.1 · #737):** where no day was clicked — the toolbar "+", the FAB, the empty state of the agenda — the date field defaults to today only while the current view actually shows today; otherwise it defaults to the first day of the period on screen (the displayed day, the week start in the household's week start, the first of the month, the start of the agenda list). Before this, every one of them fell back to today, so paging three days ahead in day view and reaching for "+" created the appointment behind the user, and "+" in a September month grid filed it under August. The decision itself is the household-wide rule `defaultDateInPeriod()` — see [Default date for a new entry](#default-date-for-a-new-entry); the calendar only maps its four views onto a period, deliberately using the calendar month rather than `getRangeForView()`, whose month span is the 42-day grid and would propose 31 August for September. The empty state of the **search** keeps falling back to today: a result list is not a period. Guarded in `test:calendar` as a rule over every create call, not an allow-list of call sites.
- **Selectable week start (Discussions #484, #465):** a household-wide setting (Settings → Modules → Calendar → View; `sync_config.week_start`, one of `monday`/`sunday`/`saturday`, default `monday`) chooses the first day of the week across the month grid, week view, and their navigation. Any member can change it. A segmented control shows a live weekday-order preview and saves instantly. The displayed **ISO week number stays Monday-anchored** by design (ISO 8601). Client mapping via `weekStartIndex()`/`weekdayOrder()` (`public/utils/date.js`).
- **Multiple reminders per event (Discussion #436):** an event can carry several reminders (e.g. "15 minutes before" *and* "1 day before"), managed as a row list in the event dialog (add/remove, max 5). See the Reminders data-model section for the API.
- **Multi-person assignment:** events can be assigned to multiple family members via the same `UserMultiSelect` component as tasks. Assigned members appear as an avatar stack (photo or initials, "+N" overflow) on each event across the month, week, day, and agenda views — the same `renderAvatarStack` component as the Tasks list; the assignee names are carried in the chip's `title`/`aria-label` for screen readers. On the mobile month grid, where events collapse to colored dots, the stack is hidden with them.
- Color-coding per person
- **Filter sheet (v2.51.0):** one button in the header (with the number of active filters) opens a sheet holding every filter the calendar has: the layers (public holidays, school holidays, shift overlay, birthdays), the people, and the shift overlay's display mode. It replaces the up-to-five toggle chips that used to sit in the header itself — measured, they cost a header row of their own (56px, 6.6% of the viewport at 390px), lost their labels below 640px, and carried their on/off state as a 1.085:1 surface difference through a `--active` rule that set the same border as the resting state and therefore did nothing; four of the five also had no `aria-pressed`. Layer state stays where it was, per device in `localStorage`.
- **Person filter (v2.51.0):** a row per household member, each carrying that member's own colour, limiting every view to their events and calendar-shown tasks. **An empty selection means everyone, not no one** — the inverse would produce a state the empty calendar itself offers no way out of. Deselecting the first person therefore selects the remaining ones; selecting everyone again clears the filter. Unknown ids (a member who has since left) are dropped on load, so a stored filter can never empty the calendar without a visible cause. Stored per device in `localStorage` (`yuvomi:calendar:people`). **Deliberately the person and not the calendar:** an event's colour comes from three sources in rank order (its own, the primary assignee, the calendar — `resolveEventColor()`), so a colour legend would be wrong for every event using one of the first two. The person is the one unambiguous axis.
- **"Assigned to me" quick filter:** limits every view to events (and calendar-shown tasks) assigned to the current user; remembered per device, shown only in multi-member households. Lives in the filter sheet since v2.51.0
- **Per-event visibility:** an "all / assignees only / private" selector in the event dialog controls who can see the event (server-enforced, no admin bypass — see [Calendar Events data model](#calendar-events)); it is an in-app control and does not filter the ICS export feed
- Recurring via iCal RRULE (daily, weekly, monthly, yearly)
- **Google Calendar:** OAuth 2.0, Calendar API v3, two-way sync of **multiple calendars** at once. After connecting, an admin enables/disables each available calendar via checkboxes in Settings (state in `google_calendar_selection`); enabled calendars are imported together, each in its own color, with its own incremental sync token. Disabling a calendar removes its imported events and clears its token (clean resync on re-enable). Outbound is **per-event**: a local event is only pushed to Google when it carries an explicit target calendar (`calendar_events.target_google_calendar_id`), chosen via the unified sync-target picker in the event dialog; events without a target stay local. The sync-target picker lists only **writable** Google calendars (accessRole `owner` or `writer`); read-only calendars (accessRole `reader` / `freeBusyReader`) are excluded from the picker. The server-side outbound sync additionally guards against writing to a calendar that has lost write permission after the event was created. A **read-only mode** checkbox prevents Yuvomi from pushing any local events back to Google while still reading incoming events normally; the flag is stored as `google_readonly` in `sync_config` and cleared on disconnect. Timed events are stored as local wall-clock time without a zone, so outbound pushes declare the **target calendar's own time zone** (read from the same `calendarList.get` metadata call as color and access role) — the event then shows the same clock time in Google as in Yuvomi, wherever the household lives. If Google reports no zone for that calendar, the server falls back to the household zone - the `household_timezone` setting, then `TZ`, then the host zone, then UTC (v1.45.11, setting added in v2.34.0 · #829). **Deleting, editing or moving a mirrored event in Yuvomi reaches Google too (v1.51.0 · #593):** before this, outbound was `events.insert` only — an event that had already been pushed was never touched again, so local deletes and edits stayed local. Both now record their intent first (a tombstone in [Calendar Pending Deletions](#calendar-pending-deletions) for deletes, `calendar_events.outbound_dirty` for edits) and then try the `events.delete` / `events.patch` call immediately after answering the request; if that fails, the next sync run retries it. Both run **before** the inbound pass, so a full resync cannot resurrect a deleted event and a local edit reaches Google before the old remote state could be written over it; the inbound pass additionally skips events with an open tombstone or an unpushed edit, so a pending local change is never silently overwritten. A remote `404`/`410` counts as settled (the event is already gone in Google), and after five failed attempts the pending operation is dropped with an error log. An edit whose target calendar is no longer writable is dropped rather than retried forever. Nothing is recorded in read-only mode or without a connected account, and disconnecting discards open tombstones. **Disconnecting can take the mirrored events with it (v2.24.3 · #820):** disconnecting clears tokens, calendar selection and open tombstones, but the events already pulled in used to stay — orphaned, since their `calendar_ref_id` now points nowhere, no sync ever touches them again, and reconnecting inserts them a second time as visible duplicates (most obvious on recurring series). Removing them by hand meant one event at a time. `DELETE /api/v1/calendar/google/disconnect?deleteEvents=true` now removes them in the same transaction as the disconnect, and `DELETE /api/v1/calendar/google/mirrored-events` does the same afterwards for anyone already disconnected — the settings panel shows that entry only while disconnected, because a running sync would fetch everything straight back. `GET /google/status` carries `mirroredEvents` so the confirmation can name the number before deleting. The scope is `external_source`, not the calendar (after a disconnect the calendar link is precisely what is missing): local events stay, including ones waiting to be uploaded, and so do the other sync sources, which have their own routes. Like the CalDAV cleanup (#732) this is a plain local `DELETE` with **no tombstone** — clearing your own copy must not delete the calendar at the provider. Apple mirrors all of this (`/apple/disconnect?deleteEvents=`, `/apple/mirrored-events`, `mirroredEvents` in its status), except that its disconnect keeps returning `204`: the status code is promised API surface, and `204 → 200` would break existing clients for nothing. **A failed run is visible now (v2.24.3 · #820):** Google and Apple recorded sync failures in the server log only, so a run that broke — an expired refresh token, a revoked app password — looked from the outside like a calendar that quietly stopped updating; the reporter noticed after roughly two weeks, and only from the duplicates that reconnecting left behind. Both providers now keep `<provider>_last_error` and `<provider>_last_error_at` in `sync_config` (no migration: their whole connection lives there as key/value, which is what `carddav_accounts.last_error` is for CardDAV), surface them as `lastError`/`lastErrorAt` on `GET /<provider>/status`, and the settings panel prints the message right below the status line it explains, reusing CardDAV's `settings.syncErrorDetail`. **A clean run clears the record actively** — "no entry" has to mean "the last run went through", otherwise the panel keeps reporting an outage the next run already fixed and the household learns to ignore the warning. The wrapper sits *around* the sync rather than inside it, so the earliest exit — throwing before a client even exists, the likeliest failure when a token is gone — is caught too; the error is re-thrown afterwards, so the manual "Sync now" button still shows it as a toast. Recording never breaks the sync: a write failure is logged and swallowed. Disconnecting clears the record along with the connection it belongs to.

**Switching an event's target calendar moves it in Google (`events.move`):** picking a different calendar for an already-mirrored event queues the move in `calendar_events.outbound_move_to`, and the move runs *before* the field patch so the edit lands in the destination, not the old calendar. It requires a writable role on **both** calendars — an unwritable destination drops the queued move and leaves the event where it is, rather than retrying forever. On success the local row follows: `calendar_ref_id` and `external_calendar_id` are updated from the API response, without which a later delete would target the old calendar and leave the event standing in Google. A `400` (Google rejecting the move outright, e.g. for a single instance of a recurring series) is given up on immediately instead of burning five attempts, since it cannot succeed on a retry.

**Recurring series (v1.56.0 · #593):** the inbound list runs with `singleEvents: false`, so a series arrives as **one master** carrying its `RRULE` and is expanded locally — the same shape CalDAV and ICS have always delivered, and the shape Yuvomi stores series in. Until v1.52.1 the list ran with `singleEvents: true` and a series was stored as its individual occurrences, which collided with uploaded series (whose row holds the *master* id) and duplicated every occurrence.

Three details make this work:

- `showDeleted: true` is required, because a single cancelled occurrence is only visible as a cancelled instance; that is what an `EXDATE` is derived from. A cancelled instance removes its date from the series instead of deleting the series.
- **No `timeMin` on a full resync.** Without `singleEvents`, the time window is matched against the *series start*, not its occurrences, so a weekly series begun in 2019 would fall out of the request entirely. Dropping the lower bound costs nothing in volume — one master replaces all of its instances.
- Masters are processed before their deviations regardless of the order Google returns them, since an exception needs its master row to attach the `EXDATE` to. A moved occurrence becomes a standalone event and its *original* date is excluded from the series; the `EXDATE` lines Google carries on the master itself are read as well.

**Migrating existing data (migration v110):** the stored `syncToken` belongs to the old request parameters and is cleared, which makes the first run a full resync. That run folds the previously stored occurrences back into their series: rows the user never touched are removed because the master covers them, while a row carrying an assignment or its own colour is turned into a standalone **local** event with its date excluded from the series — the user's work survives without the appointment appearing twice. The merge runs only on a full resync, where every genuine exception is present in the same response and therefore distinguishable from a leftover; on a delta run nothing is retired. Nothing is guessed from id patterns, and no data is touched by the migration itself.

Because a series now carries the master id, moving it to another calendar and changing its repeat rule work for imported series too — previously both were rejected with `400`, since they addressed a single instance.

Related hardening: the inbound `cancelled` delete is scoped to the reporting calendar. Moving an event between two synced calendars *in Google* makes the source report it as cancelled while the destination still lists it — under the same event ID. An ID-only delete removed whichever row the destination had just written, so the event vanished locally although it existed in Google. Rows without a `calendar_ref_id` (pre-`external_calendars` data) and calendars whose metadata could not be read keep the ID-only behaviour, otherwise genuine deletions would stop arriving there.
- **CalDAV Multi-Account:** Connect multiple CalDAV servers (iCloud, Nextcloud, Radicale, Baikal) with per-account calendar selection via checkboxes, two-way sync (tsdav), optional outbound target selection per event. **The object's name does not decide whether an event arrives (v2.47.0 · #883):** tsdav filters the hrefs of a `calendar-query` response on `.ics` in the path by default, but the extension is pure convention - RFC 4791 prescribes no name for the object resource, and a server may assign its own. Stalwart does exactly that for everything created over JMAP (`NZtPkIOMoK`), while objects written by a CalDAV `PUT` keep the client-chosen `<uid>.ics`; in the same calendar part of the events synced and part did not, and because the filtered-out ones were never fetched, no log line could mention them. Yuvomi replaces that filter with the one tsdav itself uses on the CardDAV side - let everything through except the collection itself - and applies it at the **client**, not at the call sites: five places fetch calendar objects, and a sixth would lose the rule again. The same filter also runs on the outbound path, where tsdav applies it to an explicitly passed `objectUrls`. Whether a URL is a collection is decided by its path (a trailing slash and no query), which resource it is by path *and* query, since a server may distinguish collection from member by the query alone. **Deleting, editing or moving a synced event in Yuvomi reaches the server too (v1.52.0 · #593),** using the same queue-then-sync mechanism as Google. Two things differ, because CalDAV has no per-event API: a change is a PUT of the whole calendar object, so Yuvomi *patches* the original instead of rebuilding it - only the mirrored properties are swapped, while attendees, alarms, categories and any `RECURRENCE-ID` exception in the same object stay byte-for-byte intact. And since CalDAV cannot move an object between collections, switching the target calendar is create-in-destination followed by delete-in-source, in that order: if the delete fails the event exists twice, which is recoverable, whereas the reverse order could lose it. An event whose original object was not fetched in the current run is deferred rather than rebuilt from Yuvomi's fields alone, which would silently drop everything the server knows and Yuvomi does not. As with Google, the change is attempted immediately on save: the immediate attempt fetches only the affected object rather than whole calendars, so a delete is a single DELETE on the stored URL and an edit one targeted GET plus PUT. Events synced before migration v106 have no stored URL yet - for them the immediate attempt does nothing and the next sync run, which reads the calendar anyway, resolves the URL and applies the change. **Outgoing events carry a time zone (#938):** a locally created event has no `tzid` - its zone belongs to the household, not to the row - so it fell through every branch of all three outgoing paths (new object via CalDAV, new object via Apple, change via the patcher) and went out as `DTSTART:20260830T100000`. That is RFC 5545 *floating* time: valid, and treacherous for exactly that reason, because it means "ten o'clock on the clock of whoever reads it". iOS Calendar and eM Client substitute the system zone and guess right; a Synology with a DAViCal backend accepts the object, returns it unchanged over `PROPFIND`, and never shows it in its own web front-end, because its index needs an instant and is handed none. The same answer the export feed already gave in #818 applies here: digits without an offset mean the household's clock, so they now carry its zone, with the exception for series (#549) whose zone sits on the event. Where the household zone equals UTC or cannot be resolved, the value gets a plain `Z` rather than nothing - the poorer of the two correct answers, but an instant every server places identically. The second half was invisible: RFC 5545 §3.2.19 admits a `TZID` parameter only with a matching `VTIMEZONE` in the same `VCALENDAR`, and the series path had been writing its `TZID` since #549 without ever emitting the component, which a strict server may reject. The field mapping therefore returns the zone *together* with the fields and `patchICSEvent` takes it as an option; separate return values invite forgetting the second one, which is what happened for years. The `VTIMEZONE` generator moved from `ics-export.js` to `server/utils/vtimezone.js` rather than being copied - DST transitions are the kind of arithmetic one gets right once
- **Outlook one-way push (Microsoft Graph, migration v134):** Push Yuvomi events to Outlook.com calendars of personal Microsoft accounts (outlook.com / M365 Family — Outlook.com has no CalDAV, so this uses the Graph API with plain `fetch`, no SDK). Multi-account: each family member's Microsoft account is connected via OAuth (Entra ID app registration, `/consumers` endpoint, `MS_CLIENT_ID`/`MS_CLIENT_SECRET`/`MS_REDIRECT_URI`); account management is admin-only, members pick enabled Outlook calendars through the shared `/calendar/sync-targets` route (#618) and the `outlook:<accountId>|<calendarId>` value format in `public/utils/sync-target.js` — which also makes an Outlook calendar selectable as the per-member default sync target (#620). The primary mode is **auto-sync**: one dedicated target calendar plus an owner per account pushes all events visible to that person automatically (see [Outlook Accounts](#outlook-accounts)). **One-way only, Yuvomi is the source of truth:** pushed events stay `external_source='local'`, their Graph event id and a content hash live in `outlook_event_links` (unchanged events are no-ops; edits become `PATCH`es; deleting the local event, losing visibility, or clearing the target deletes the remote event via the tombstone link row). Remote drift is reconciled every run via the stored Graph `changeKey` — one `$select=id,changeKey` listing per linked calendar detects events edited (→ reasserted via `PATCH`) or deleted (→ re-created) in Outlook, so the source-of-truth guarantee holds without per-event polling. Recurrence maps Yuvomi's RRULE subset onto Graph's `pattern`/`range` model (monthly `BYDAY` degrades to the absolute day of month); EXDATEs are not propagated; timed events are pushed with the **household zone** (v2.34.0 · #829 - until then a hard-coded `Europe/Berlin`, justified as parity with the Google outbound although that one already read the target calendar's own zone and only fell back; a household in Toronto pushed every appointment six hours out); attendees, reminders, attachments and colors are not pushed. On `invalid_grant` (MSA refresh tokens expire after ~90 days of inactivity) the account is flagged `needs_reauth` and skipped until reconnected via the settings UI. Sync runs on the shared interval plus a manual trigger; empty runs stay below the default log level (#601).
- **Sync target per event, open to every member (v1.66.1 · #618):** the "Sync target" dropdown in the event editor is served by `GET /api/v1/calendar/sync-targets`, available to **every authenticated user**. It returns display name and target key only, for the enabled (and, for Google, writable) calendars — no credentials, server URLs, or usernames; account management stays admin-only. Until then the dropdown read the admin-gated management routes (`/caldav/accounts`, `/google/calendars`) directly, so a member got `403` and was left with "Store locally" as the only option — although `POST`/`PUT /api/v1/calendar` had always accepted a target from any member, which made the restriction an accident of the read path rather than a permission boundary. Each provider falls back to an empty group on its own, so an expired Google token no longer swallows the CalDAV targets, and one request replaces the previous one-per-account round trips
- **Default assignee per sync target (migration v79):** each synced calendar (Google/CalDAV) and each ICS subscription can be given an optional default assignee in Settings → Sync; newly imported events of that target are auto-assigned to that person (new events only — see [External Calendars](#external-calendars)). The per-calendar picker appears once the calendar has completed its first sync
- **ICS Subscriptions** (Settings → Personal → Calendar subscriptions)**:** Subscribe to any public ICS/webcal URL (e.g. public holidays, sports schedules). Per-subscription color, private/shared visibility, manual "Sync now" and automatic sync on the shared interval. Edit name, color, and visibility of any subscription inline. RRULE events expanded into a rolling ±6/+12 month window. SSRF-protected (DNS pre-resolution), ETag/Last-Modified conditional fetch, 10 MB limit, 15 s timeout. User-edited events are protected from being overwritten (`user_modified`); a "Reset to original" link restores them.
- **One-time import (Discussion #437):** Settings → Personal → Calendar subscriptions → "Kalender importieren" imports events from an uploaded `.ics` file or a shared calendar feed URL as **editable local events** (`external_source='local'`, no subscription) — the migration path when moving from another calendar. Unlike a subscription the events are owned by the importing user and never auto-synced; recurring events are kept as a series (RRULE reduced to the locally supported FREQ/INTERVAL/BYDAY/UNTIL subset), and the source UID is stored in `external_calendar_id` to skip duplicate re-imports of the same feed. The URL path reuses the subscription fetch (SSRF-protected, 10 MB / 15 s limits); `POST /api/v1/calendar/import` returns `{ imported, skipped, total }`.
- **Read-only export feed (Discussion #387):** Settings → Personal → Feed subscriptions → "Kalender-Feed exportieren" exposes the user's own visible events (own events, assigned events, and shared/own ICS subscriptions) as a `webcal://`/`https://` ICS feed for subscribing in Apple Calendar, Google Calendar, Thunderbird, etc. Backed by a per-user secret token (`users.calendar_feed_token`); enabling generates the token, "Neuen Link erzeugen" rotates it (invalidating the old URL), "Feed deaktivieren" clears it. The feed itself is served by a public, unauthenticated `GET /feed/calendar/:token.ics` route outside `/api/v1` (no session/CSRF — the token in the URL is the secret), rate-limited to 30 requests/minute per IP, recomputed on every request (no caching). The feed URL uses `BASE_URL` when set, falling back to the request's protocol/host. Token management (`GET/POST regenerate/DELETE /api/v1/calendar/feed`) requires authentication. An opt-in toggle "Zugewiesene Personen im Titel anzeigen" (default off, persisted in `users.calendar_feed_show_assignees` via `PUT /api/v1/calendar/feed`, Discussion #482) appends the assigned members to each event's title in the feed, e.g. `Poolparty (Mama, Papa)` — names are ordered alphabetically and RFC-5545-escaped. Existing subscribers' titles stay unchanged until enabled. **Times carry their zone (v2.24.3 · #818):** locally created events store bare wall-clock time with no offset, and the feed used to export them as RFC-5545 *floating* local time — valid, and meant to be read on the viewer's own clock. In practice Google Calendar, Apple Calendar, Thunderbird, Outlook and Home Assistant all resolve floating values to UTC, so a 16:00 appointment in `TZ=Europe/Madrid` showed up at 18:00. The digits are now anchored instead of left open: `DTSTART;TZID=<household zone>:20260820T160000` plus a matching `VTIMEZONE` component and an `X-WR-TIMEZONE` calendar header, with the zone taken from `serverTimeZone()` (the `TZ` env var, then the system zone). Events that already carry an explicit offset — anything synced in from Google or CalDAV — keep their unambiguous UTC `…Z` form, and all-day events stay `VALUE=DATE`. When the household zone *is* UTC (or cannot be resolved), the naive values get a plain `Z` rather than a `VTIMEZONE` over a zone many clients do not carry: it says the same thing in a form everyone reads. `EXDATE` follows the same anchoring, otherwise an exception would no longer land on its own occurrence.
- **External calendar names & colors:** Google and Apple sync stores each calendar's display name and background color in the `external_calendars` table (migration v14). A colored `event-cal-label` badge appears in event popups, agenda, month, week, and day views when `cal_name` is present.
- **Event color sync (Discussion #427):** Each provider preserves per-event colors, not just the calendar color. Inbound, Google's `colorId` is resolved to a hex value via the event color palette (`colors.get`, cached 24 h), and the iCalendar `COLOR` property (RFC 7986 — CSS3 name or hex) is read for CalDAV, Apple, and ICS subscriptions. **An event without its own colour is stored without one** (v2.48.0 · #891): the calendar's colour is *inherited*, so writing it into the per-event column would make it indistinguishable from an explicit choice - which is exactly how it displaced the assignee's colour. It reaches the display as `cal_color` instead, read from `external_calendars` via `calendar_ref_id` or, for ICS subscriptions (which have no `external_calendars` row), from `ics_subscriptions` via `subscription_id`. The one deliberate exception is the one-off "import to local" of a subscription: those events become local and keep no source to inherit from, so the colour chosen for that import is a choice and belongs in the column. Outbound to Google, a local event's hex color is mapped to the nearest of Google's 11 event `colorId`s (perceptual redmean distance); an event whose colour the user **cleared** sends an explicit `colorId: null`, because the update push is an `events.patch` and an omitted field means "leave it alone" rather than "clear it" - the two sides would otherwise diverge permanently (v2.48.0 · #891). Until #899 that `null` went out for *every* event without a colour, including one that never had one, so any edit could strip a colour another client had set in Google; it is now gated on `color_modified`. A colour that merely cannot be mapped (palette unavailable) is the opposite case and omits the field, so an unrelated remote colour is not thrown away. **Outbound to CalDAV and Apple, the same colour goes out as an `RFC 7986 COLOR` property** (#897) - as a CSS3 colour *name*, because §5.9 permits nothing else and a strict server may reject a hex value, mapped by the same redmean distance across the 147 Level-3 names. Before this the field list claimed a mirroring that never happened for those two providers: `COLOR` was read and never written, so a recolouring cost an empty `PUT`. Only `rebeccapurple` is excluded: it arrived with Level 4 in 2014, so a strict server may reject it, and a rejected `PUT` would take the appointment's other edits with it. Inbound still accepts the name. `COLOR` is *managed* in `ics-patch.js`, so an emitted value survives the patch. **An appointment whose colour was never learned sends no `COLOR` field** - "leave it alone", not "remove it", and the same for a stored value that cannot be mapped (the appointment *has* a colour there, it just fits no CSS3 word). **A colour the user cleared does go out, as a removed `COLOR` property** (#899): `color IS NULL AND color_modified = 1` is the state that says so. Before that column existed the two were indistinguishable and #898 could only ship the setting half.

**Which flag protects the colour, and why it is not `user_modified` (#899).** `user_modified` means "something about this appointment was edited locally" - it is set on *any* edit to a mirrored appointment. All three inbound syncs read it as "the colour is managed locally", so renaming an appointment froze its colour column forever: a recolouring on the server afterwards never arrived, and no later run reconciled the two. The colour therefore carries `color_modified`, set only when `color` actually changes (re-sending the unchanged value with the rest of a form is not a recolouring, and the comparison ignores hex case because the sync stores its own values uppercase) and by the three upload paths for a colour they just sent out - without that last part the next inbound run would replace the chosen hex with the mapped one, since both mappings are lossy. The one other place that writes a colour of Yuvomi's own choosing claims the flag with it: a housekeeping visit takes its worker's colour, which would otherwise come back rounded to the nearest CSS3 name on the next sync. A resync overwrites an event's colour only while `color_modified = 0`, so remote colour changes keep flowing in until somebody picks their own, after which it stays fixed. Migration 167 backfills `color_modified = user_modified`: conservative on purpose, because in existing data a frozen colour and a deliberately chosen one look the same, and throwing away the deliberate one is the more expensive mistake. Resetting an ICS appointment to its original (`POST /:id/reset`) clears both flags - the feed manages it again, colour included. The `COLOR`↔hex mapping lives in `server/utils/ical-color.js`. **Which of the available colours is actually drawn (v2.36.0 · #815):** `resolveEventColor()` resolves the appointment's own colour first, then the first assignee's, then the calendar's, then a neutral grey. Until v2.35.0 the assignee came first, which treated an *inherited* calendar colour and an *explicit* per-event one as equally overridable - so a CalDAV appointment that brought its own `COLOR` was invisible the moment its calendar was assigned to someone, and the sync described above looked broken when it was not. Who an appointment belongs to is carried by the avatar stack regardless, which is how *multiple* assignees have always been shown. `test:calendar` pins the order behaviourally.

  **The lower two branches were unreachable until v2.48.0 (#856, resolved by #891).** `calendar_events.color` was `NOT NULL` and rejected an empty string, so an appointment read from the database always carried a colour and the first branch always won - the assignee's colour and the calendar's tinted nothing between v2.36.0 and v2.48.0. That was not a display bug but a missing state: an appointment for which nobody ever chose a colour looked exactly like one that carried a deliberate choice, so a never-made choice permanently displaced the person's colour.

  **What #891 changed.** Migration v166 makes the column nullable, the import paths stop writing the inherited calendar colour into it, and the event dialog gains an explicit first swatch, "colour of the assigned person", which is the default a new appointment starts on. The rule stays the one from #815 - an explicit value beats a derived one - it is only that "no explicit value" is now expressible. `PUT` distinguishes the two falsy cases by whether the `color` field is present at all: omitted means untouched (an older client must not silently clear a colour), `null` means deliberately cleared. Existing rows are left alone: `#007AFF` looks like a default but was the first entry of `EVENT_COLORS` before the OKLCH switch, so a v1-era appointment may carry it deliberately - synced appointments normalise themselves on the next sync, local ones through the dialog. `test:calendar` pins the order, `test:calendar-routes` the two `PUT` cases, and `test:calendar-inherited-color` the migration and the import paths.

  Two consequences were fixed with #856. The colour picker used to grey itself out whenever someone was assigned, with a note that the assignee's colour would override - a promise the code had stopped keeping; both the note and the greying are gone, and the picker is always usable. And because the picker matched the stored colour against its ten palette swatches to find the active one, any colour from outside that palette - an avatar colour, an `RFC 7986 COLOR` from a server, the pre-OKLCH `#007AFF` - matched nothing, so saving fell back to the first swatch and silently repainted the event. The picker now shows a colour outside its palette as an extra swatch of its own, matching is case-insensitive (CalDAV sends lower-case hex), and `colorToSave()` holds the rule that a save which did not touch the colour does not change it.
- **Event location:** Event popup and dashboard display the location field with RFC 5545 backslash-escape normalization (`\n`, `\,`, `\;`, `\\`) via `fmtLocation()` in `public/utils/html.js`.
- **Custom event icons:** Each event can have an icon chosen from a visual picker; the server validates against a fixed allow-list (`VALID_EVENT_ICONS` in `server/routes/calendar/helpers.js`, currently 105 entries — Lucide names plus the custom `tooth` and `balloon` glyphs). Birthday events are automatically assigned the `cake` icon and name-day events the `balloon` icon. Icon stored in `calendar_events.icon`.
- **Birthday layer (v2.28.0, #778):** birthdays reach the calendar from the contacts and, with a large address book, fill it with entries nobody planned as appointments; deleting one did not help because the next sync recreated it. A toggle hides them, alongside the public- and school-holiday toggles, remembered per device in `localStorage` (`yuvomi:calendar:layer:birthdays`). The marker is the `birthday_name` field the read route attaches, not the title - an appointment of the user's own that mentions a birthday is unaffected. **Since v2.51.0 the toggles live in the filter sheet rather than the toolbar**, and the birthday row is shown unconditionally: the old "only while birthdays are in range or the layer is off" condition existed so the control that brings them back could never disappear, and in a sheet a row costs no header space, while a switch that comes and goes with the data is harder to find than one that always sits in the same place.
- **File attachments:** Events support a single file attachment (images, PDFs, Office documents, up to `MAX_UPLOAD_MB`, default 5 MB — the shared upload ceiling since v2.28.0, #806). Images are displayed inline in the event popup; other files show a download link. Drag-and-drop upload is supported in the event modal. New attachments create one `family_documents` object through the active document-storage backend and link it via `attachment_document_id`; no second binary copy is written to `attachment_data`. Existing legacy Base64 attachments remain readable. Unchanged attachments are not re-uploaded, and removing an attachment only unlinks it from the event.
- **Overlapping events:** In week and day views, timed events that overlap in time are rendered side-by-side using a column-layout algorithm instead of stacking.
- **An end at midnight closes the day it ends (v2.21.1 · #804):** the last calendar day an event occupies is derived by `eventEndDate()`, not by its raw end date. For a timed event ending at exactly 00:00 local time, that is the previous day — 21:00–24:00 on Friday is a Friday appointment. Without this the end counted as inclusive, so the event entered the next day's bucket *and* was classified as multi-day, which pushed it through `isAllDayLike()` into the all-day row as a bar across both days. **All-day events are deliberately exempt:** they store the same `T00:00` stamp but mean their end inclusively (a trip from 07.–09.09. is stored as `'2026-09-09T00:00'`), so the rule applies to timed events only. An end one minute later still books the following day. The helper is the single source for all four places that map events onto days (`buildDayIndex`, `eventsOnDay`, `isMultiDayEvent`, `agendaSegmentKind`); the server's range filter stays inclusive on purpose, since it selects what to load rather than what to display.
- **Task chips:** Open and in-progress tasks with a `due_date` appear as read-only priority-coloured chips in all four calendar views (month, week/day all-day row, agenda). Clicking a chip navigates to `/tasks?open=<id>` and opens the task edit modal. Tasks with `due_time` show the time in the chip label. Done and archived tasks are not shown — since #688 the archive is `archived_at`, and the server already leaves it out of the fetch. No server changes required — tasks are fetched in parallel with events on each range load (`GET /api/v1/tasks?include_future=1`), filtered client-side, and rendered via `renderTaskChip()`.
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
- **Shared formatting toolbar (#731):** the toolbar above the content field is `.md-toolbar`, a shared component (`public/utils/markdown-toolbar.js`, `public/styles/markdown-toolbar.css`) rather than part of this module, because task notes carry the same one. Its labels live under `markdown.*` for the same reason. The placeholder text a button inserts on an empty selection — `Text`, `Code`, `Link text`, `url` — is translated: it lands in the note itself, so it is interface text like any other
- **Tappable checklists (#704):** a rendered `- [ ]` box is a real control on the card and in the reader, not decoration. Ticking one rewrites exactly its own source line via `PATCH /api/v1/notes/:id/check`, so two members ticking different items in the same minute both keep their tick — a full-body `PUT` would have let the later save drop the earlier one silently. The box is addressed by the source line number the renderer leaves on it (`data-md-line`), never by its text, because two items reading "Milk" are otherwise indistinguishable; the client sends the line it saw as `expect`, and a mismatch is answered with `409` instead of a tick in the wrong row. The renderer keeps the inert `aria-hidden` box unless a caller opts in, so the dashboard — which shows a truncated excerpt whose line numbers are not the note's — stays decorative, and so does the reader while the editor holds unsaved text. The box names itself after its item (markers stripped) rather than wrapping it: an item may contain a link, and an `<a>` inside a `<button>` is not valid HTML. The route states a target rather than a toggle, so a repeated request is a no-op rather than a second flip - relevant because `PATCH` is deliberately outside the `Idempotency-Key` mechanism (see [Retry-safe writes](#retry-safe-writes-idempotency-key-822))
- Reader mode (v1.25.0): opening an existing note shows a rendered Markdown reader by default; a Read/Edit toggle (segmented control) switches to the editor and back within the same modal. New notes open directly in the editor. Both panes stay mounted, so the toggle never discards unsaved input and the reader reflects live edits. Cancel/Save are hidden in read mode, while **Delete stays available in both modes (v1.36.0)** — previously the whole footer disappeared, leaving an opened note without a single object action
- Full-text search: client-side filter bar, filters instantly by title + content, with a clear (×) control
- **Creator filter (v1.36.0):** a chip row below the module head narrows the board to one author's notes. Shown only when at least two people have written notes; clicking the active chip clears the filter again
- **Pinned grouping (v1.36.0):** pinned notes were always sorted first, but the boundary was only inferable from the ring on the card. Two section headings ("Pinned" / "Other notes") make the existing order legible; they appear only when both groups exist
- **Open action (v1.36.0):** each card carries an explicit open button. The card itself is a `<div>` with a click handler, so keyboard and screen-reader users previously had no way to open a note at all — only pin and delete were reachable
- Card previews are height-capped (`line-clamp`), so a single long note no longer pushes every other note out of view

### Contacts (`/contacts`)

- CRUD with category filter
- **Separate first/last name (v1.38.0):** the contact dialog has two name fields grouped under one required marker ("Name \*") — at least one of them must be filled. The display name is composed as `First [Middle] Last`, and the list sorts by last name, so contacts read the same no matter which CardDAV server they came from. A contact that has no stored components yet is pre-filled by splitting its display name at the last word; that guess is only saved when a name field is actually edited. A category the household does not (or no longer) manages is offered as its own option instead of silently falling back to the first entry — see [structured name components](#contacts)
- **Customizable categories:** a "Manage categories" button in the toolbar opens the shared `yuvomi-category-manager` modal to add, rename, recolor, reorder, and delete contact categories (predefined set localized with per-category icons and tones, custom categories added inline). Each row shows its own mark — the same full-tone disc the contact list draws, so the row is the preview — and opens a seven-tone palette on demand; the palette is a `radiogroup` with arrow-key navigation. Deletion is blocked while a category is in use or when it is the last one — see [Contact Categories data model](#contact-categories-migration-v84)
- **A linked household member outranks their category:** a contact with `family_user_id` shows that member's photo or initials in their **own** avatar colour, not the category disc — the same person, the same colour, everywhere (see the identity-colour rule in DESIGN.md). `GET /api/v1/contacts` and `GET /api/v1/contacts/:id` carry `family_display_name`, `family_avatar_color` and `family_avatar_data` for that purpose; they are `NULL` on unlinked contacts. Because the avatar colour is freely chosen, the initials take a computed readable ink rather than the fixed one used over curated tones
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

- CRUD: name, description, category, file upload (PDF, images, text, Office documents; up to `MAX_UPLOAD_MB` per file, default 5 MB)
- **Upload dialog (v1.35.0):** the file comes first — it is the object of the action and supplies the name. The name field is optional and falls back to the file name; the category defaults to "other" rather than the first list entry. The file input carries the server's `allowed_mime_types` as `accept` and its `max_file_size` as the client-side limit, so hint text and actual acceptance cannot drift apart. Visibility sits openly in the form (it is the module's core promise), while description and status stay behind "more settings"
- **The content has to match the declared type (#937):** every upload arrives as a data URL, and its prefix - `data:application/pdf;base64,...` - comes from the sender's browser and can be set freely. Uploads are therefore checked against the file's own signature (`server/utils/file-signature.js`): PDF, PNG, JPEG, WebP, GIF, the OLE formats (doc/xls) and the ZIP formats (docx/xlsx). `text/plain` and `text/csv` pass unchecked because text has no header, and a heuristic would reject a CSV whose first cell holds angle brackets. The delivery path was already hardened against the execution consequences (fixed content type, `nosniff`, a narrow CSP); what the check adds is the quiet case - a file filed as an insurance policy that is not one surfaces years later, when whoever uploaded it is long gone. The same rule covers the four image uploads outside this module (birthday photo, housekeeper picture, quick-link icon, subscription logo), each of which validated only its own declaration before.
- **Multi-file upload (v1.35.0):** several files can be picked or dropped at once. Each becomes its own document with its file name as the title, sharing the chosen category, folder, and visibility; the submit button reports "uploading n of m" while they are processed
- **Folder browser:** documents can be organized into custom folders; a sidebar lists all folders plus "Alle Dokumente" and "Kein Ordner". The first row is the neutral state of a filter, not an overview of folders, and it is named for what it selects: it carries a document count, and calling it "Alle Ordner" next to that count read as a number of folders (v2.8.2, #757). **Folders nest (migration v164, #785).** They were flat until then, and the request was to hang them under the categories - which does not work, because the two axes are independent: a folder "Apartment" holds documents categorised `home`, `insurance` and `legal` at the same time, so under a category it would stand three times or carry a membership that does not exist. The hierarchy therefore sits where it belongs - `family_document_folders.parent_id`, capped at **five** levels (where the indentation stops leaving room for the name on a phone) - and the category stays a cross-cutting label on the document. `name` lost its global UNIQUE in the same migration and is now unique per sibling row (`COALESCE(parent_id, 0), name`): "Invoices" under "Car" and under "Apartment" are two folders. `COALESCE` and not a plain `UNIQUE(parent_id, name)`, because SQLite treats each NULL in a UNIQUE as distinct and would allow any number of same-named root folders. Selecting a folder shows the documents of its whole subtree, and the count beside it answers the same question - the rule for that lives once, in `public/utils/folder-tree.js`, and is used by both the sidebar and the route. Custom folders can be created, renamed, and deleted (via a per-folder overflow menu); deleting a folder keeps its documents (their folder link is cleared) but takes its whole subtree with it (`ON DELETE CASCADE` on `parent_id`, v164) - the confirmation names how many subfolders go along, because the sidebar only shows the collapsed root. New uploads are pre-assigned to the currently selected folder. Six modules file their receipts in a system folder of their own (Budget, Tasks, Shared expenses, Inventory, Housekeeping, calendar attachments); since v157 that folder is identified by `family_document_folders.module_key`, not by its translated name, so two members with different languages file into the SAME folder and renaming either the folder or its translation no longer creates a second one. The name is a label and may be changed freely. The housekeeping folder is auto-created when the first housekeeping worker is added
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
- **Local folder backend (env-only):** setting `DOCUMENT_STORAGE_LOCAL_ENABLED=true` writes new document binaries to `DOCUMENT_STORAGE_LOCAL_PATH` (default `/documents`, a host mount) as `storage_backend='local'` rows with a relative `storage_key`, instead of the in-DB BLOB. It is resolved from the environment on each upload and takes precedence over every selected backend. Legacy `local` rows without a `storage_key` continue to read from the DB BLOB. Writes fail loudly on an unwritable mount (no silent fallback); the storage key is path-traversal-validated and reads are bounded by the same `MAX_UPLOAD_MB` limit as other backends.
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
- **Document folder:** a folder for the module is auto-created in Documents on first worker creation and carries the `housekeeping` key (migration v157), so it is the same folder regardless of the uploader's language; receipts can be linked to individual work sessions
- **API:** `GET /api/v1/housekeeping/visits/:id` returns a single work session with worker name, task list, and linked document

### Inventory (`/inventory`)

Tracks owned belongings — what you have, where it is, what it's worth, and when something about
it needs attention. Lives in the Household section of the sidebar alongside Documents and
Housekeeping, sharing their `records` accent tone (moved there from Budget's `money` family once
the module's own weight settled: it is primarily a record of long-lived household items, not a
finance tool that happens to track objects).

- **Two-level browse:** the landing page shows metric cards (item count, total purchase value, items needing attention) plus a category overview; tapping a category shows its items grouped by storage location, with "All" / "Needs attention" filter chips scoped to that category. Tapping an item opens a read-only detail view — with a colored accent stripe — before editing.
- **CRUD:** name, brand, model, serial number, category, storage location, purchase date and price, currency, vendor, warranty length, condition, status, notes, and an optional single photo (same storage pattern as a birthday photo: one Base64 data URL, no gallery). Deliberately no current-value/resale-estimate field — a manually maintained number nobody updates is worse than none.
- **Storage locations** are a two-level hierarchy (e.g. "Garage" → "Werkzeugschrank"), renameable and sortable through the shared category-manager component, same as Pantry Locations. Deleting one never blocks — items and sub-locations become location-/parent-less instead of moving.
- **Categories** are a manageable list (five seeded defaults: Electronics, Vehicles, Household, Sports, Other), same pattern as Task Categories; deleting one reassigns its items to the protected `other` category.
- **Linked documents:** attach receipts, warranty cards, or manuals from the Documents module, reusing the same visibility-filtered linking mechanism Budget entries already use.
- **Linked budget entries:** connect a purchase, a refund, a repair, or an accessory bought later, with a role per link (`purchase`/`refund`/`instalment`/`maintenance`/`accessory`). Creating an item directly from a booking (the Budget entry modal's "Add to inventory" hook) prefills the purchase price automatically — but only for the first item linked to that booking, so a collective receipt split across several items doesn't copy its total onto each one. Visibility follows Budget's own rules exactly, including in personal budget mode.
- **Derived warranty deadline:** a proactive in-app reminder 30 days before the warranty ends, computed on the fly from the purchase date and warranty length rather than stored. Surfaced as a status badge (valid / expiring / expired) on the list and detail view.
- **Custom tracked dates:** an item can carry up to 10 additional dates beyond the warranty — TÜV, service, insurance renewal, anything with a date — each with its own configurable reminder lead time (default 30 days, explicit `0` allowed). Replace-set semantics on save, like linked documents.
- **Deadlines ICS feed:** a dedicated, admin-managed, subscribable read-only calendar feed (`webcal://`/`https://`) exporting both warranty end dates and custom tracked dates as VEVENTs, following the same admin-only token-rotation pattern as the calendar export feed (see Calendar). Text follows the household data language, not a fixed locale.
- **Nav badge:** the sidebar icon carries a badge for items with a soon-expiring or overdue warranty or tracked date.
- REST API: `GET/POST /api/v1/inventory/items` (filters: `category`, `location_id`, `status`; full-text search `q`), `GET/PUT/DELETE /api/v1/inventory/items/:id`, `POST/DELETE /api/v1/inventory/items/:id/entries[/:entryId]`, `GET /api/v1/inventory/entries/:entryId/items`, `GET/POST /api/v1/inventory/locations` (plus `/:id`, `/reorder`, and the `/subcategories` sub-tree for two-level locations), `GET/POST /api/v1/inventory/categories` (plus `/:key`, `/reorder`), `GET/POST/DELETE /api/v1/inventory/deadlines-feed` (per user, like the calendar feed - each member manages only their own token, so a subscription can be revoked individually; the feed content itself stays household-wide).

### Health (`/health`)

One page module with six deep-link routes (pattern like Settings, not like the Kitchen cluster), sharing a sub-tab bar: Overview (`/health`), Vitals (`/health/vitals`), Cycle (`/health/cycle`), Medications (`/health/meds`), Labs (`/health/labs`), Activity (`/health/activity`). Toggleable like any module; disabled → router redirects to the dashboard. Health data is sensitive — enable `DB_ENCRYPTION_KEY` (SQLCipher). **Not a medical device; no diagnostic claims.**

- **Per-member scoping:** a person switcher filters to one family member. Since v2.58.0 it is a single button carrying the active person, opening the shared popover menu with `menuitemradio` entries - the same vocabulary and single-select check mark as the recipe source filter. It replaced a permanent 48px pill row that stood above all six views, where a household of four met ten choices before the first piece of content. A household with only one visible person gets no switcher at all. Each row is `private` (owner only) or `family` (all members). Editing is limited to the owner's own view; foreign members show family-visible rows read-only.
- **Recording for someone else:** a parent can record for a child (fever, medication) once an admin
  grants it per person under Settings → Family. The person switcher then shows "You are recording for
  X" instead of the read-only banner, and the capture button appears. Grants cover vitals,
  medications, labs and activities, never the cycle diary.
- **Vitals:** capture blood pressure (sys/dia/pulse), glucose, weight, height and head circumference (v1.86.0 · #683 - the infant measurements, kept next to weight because the three are taken together; deliberately raw numbers, since a percentile would need reference data per sex and age and carries medical weight), optional SpO₂/temperature, sleep duration and mood; per-metric cards with last value + delta; native SVG trend charts with selectable range. A metric declares how its numbers read (`format`: pair, duration, scale) — sleep is entered as hours + minutes and stored as decimal hours, mood as one of five steps on a scale whose chart axis stays clamped to the full 1-5 range.
- **Medications:** medication list (name, dose, form, active/PRN), schedule editor (time slots + weekday mask + dose), "due today" view with take/skip, 7-day adherence bar, and stock/refill warnings. Reminders are delivered through the existing push/notification-channel layer (`server/services/medication-scheduler.js`) — no separate reminder table.
- **Labs:** reports with multiple analytes (value, unit, reference low/high); `low`/`normal`/`high` flag derived from value + range and colour-coded via tokens; per-analyte trend chart with a reference band; neutral medical disclaimer.
- **Activity:** training log (preset or custom type, duration, optional distance/intensity/calories, note); weekly summary cards and a native SVG bar chart per weekday.
- **Cycle:** menstrual cycle tracking. Period episodes (start/end + flow), per-day logs (flow intensity, symptoms, mood), and calendar-method predictions of the next period, ovulation, and fertile window (luteal length, cycle/period averages derived from history or overridden in settings). A native **SVG cycle-ring** shows the current phase, cycle day, and countdown; a month calendar colour-codes logged and predicted periods, the fertile window, and ovulation; plus prediction stat cards, a period history, and CSV export. A **pregnancy mode** (migration 82) in the cycle settings pauses all predictions (next period, ovulation, fertile window, ring, and calendar projection); with an optional estimated due date it instead shows the gestational week (Naegele rule, 280 days), trimester, countdown, and a progress bar, while daily logging stays available. Cycle data defaults to `private`; a per-member **default-visibility** setting (migration 96) can pre-select `family` for newly logged periods and day logs instead, and an **"apply to all"** action in the cycle settings bulk-updates every existing entry to the chosen visibility (`PATCH /health/cycle/visibility`, strictly own-scoped). The visibility of any single period or day log stays overridable in its own modal. The fertile window carries a clear disclaimer that it is not contraception and no substitute for medical advice. Cycle data is deliberately kept out of global search; the only dashboard surface is an **opt-in, owner-only tile** (v0.98.0) that shows the signed-in user's own next-period countdown and current phase — it is never added to the shared dashboard payload. The calendar distinguishes phases with **non-colour cues** (solid fill, diagonal hatch, ringed day, outline) as well as colour, so it stays legible with colour-vision deficiency. **Today carries the app accent, not the module tone (v2.24.1):** its ring used the Health colour, which is the tone in that grid closest to the period colour — and today is frequently a logged day, so both rings met on the same cell. Measured (CIEDE2000, JND 2.3) the distance to `--cycle-period` rose from 17.23 light / 14.33 dark to 31.50 / 25.97, and the grid's smallest pairwise distance from 17.23 / 14.33 to 26.60 / 25.97. It is also the mark the calendar and the datepicker already use for the current day; the 2 px ring width stays, because 1.5 px already belongs to a predicted period.
- **Overview:** aggregated landing view — due-today medications with inline take/skip, latest vitals cards (deep-link to the Vitals tab), adherence rate + streak, quick-capture buttons, upcoming reminders, and a **CSV export** bar (one download per area — vitals, activities, labs, medication logs — with optional date range).
- **Search & shortcuts:** medications and activities appear in global search (FTS5) with the same visibility scoping and deep-link to the Meds/Activity tab; the `g h` keyboard shortcut jumps to the last-visited Health tab.
- **Accessibility:** the sub-tab bar and the range chip row expose `role="tablist"`/`tab` with arrow-key navigation and roving tabindex; the person menu carries the menu keyboard behaviour from the shared `popover-menu` (focus moves onto the active choice on open, arrows wrap, Home/End, Tab leaves) and hands focus back to the freshly rendered trigger after a switch; SVG charts carry `role="img"` + `aria-label`; take/skip/save actions announce via the polite/assertive live regions; modals trap focus and restore it on close.
- **API:** `GET/POST/PATCH/DELETE /api/v1/health/{vitals,medications,labs,activities}` (+ nested `…/medications/:id/schedules|logs`, `…/logs/:id/take|skip`, lab results), cycle endpoints `…/cycle/periods`, `…/cycle/logs` (upsert per day), `GET/PUT …/cycle/settings`, and `GET /api/v1/health/export/{vitals,activities,labs,meds-logs,cycle}` (text/csv). All handlers apply `user_id` scoping and `visibility` filtering.

### Schedule (`/schedule`)

Off by default. Four tabs (shift types, patterns, overrides, statistics) plus a "today" card.

- **Scoping:** every household member may *read* the whole overlay — the family mostly needs to know
  that one person is unavailable on Tuesday evening. A member writes only their own schedule; an
  admin writes for anyone. Shift types are the exception, because they are shared: anyone may add
  one, only the creator or an admin may change or remove it.
- **Calendar overlay:** a separate, explicitly toggleable, **read-only** layer — never ordinary
  editable events. It defaults to a compact strip rather than a full block, and the choice persists
  per browser. Its colour comes from `--module-schedule` in `tokens.css`, not from the markup: the
  holiday layers next to it carry an inline value because theirs is a *user setting*, and this one
  is not.
- **Overnight shifts** stay on their start day, so a night shift does not smear across two calendar
  days. `end_time <= start_time` is what marks one; `end == start` is a 24-hour shift.
- **Quick-start presets:** the Shift Types tab's empty state offers a one-click "quick start" that
  creates seven common presets (Early/Late/Night/Day/24-hour, plus Vacation/Sick) client-side,
  sequentially, against the existing unrestricted `POST /shift-types` — reusing the same preset
  values that already prefill the create-shift-type form, rather than a dedicated bulk-create
  endpoint. Vacation and Sick carry no start/end time on purpose - a shift type without times is
  already a valid, "all day" type (`start_time`/`end_time` are nullable as a pair), so an absence
  reason is just a shift type nobody works, not a new concept or column.
- **Fill a date range:** `POST /overrides/fill` writes an override across an inclusive range in one
  call (e.g. a vacation), instead of one `PUT` per day — see Schedule Overrides above for its cap.
  The client always confirms before submitting, since it silently overwrites any existing overrides
  in range the way the single-date `PUT` already does, just at a larger blast radius.
- **Grouped display and range editing:** the Overrides tab groups consecutive days for the same
  member with the same shift type (or free day) and note into a single row — display and
  bulk-action only, the table stays exactly one row per day. Editing a group shows its current
  From/To as editable fields; saving reconciles automatically (`POST /overrides/fill` for the new
  span, `DELETE /overrides` for whatever fell outside it) rather than requiring a manual
  delete-then-refill. Deleting a group removes its whole span in one `DELETE /overrides` call and
  always confirms first, unlike the original single-day delete (now just a group of size one).
- **Dashboard widget:** an opt-in "who's working today" tile (off by default, like the module
  itself), reusing `GET /entries?from=<today>&to=<today>` (no `user_id` → the whole household) —
  the same query the page's own "today" card uses. It lists only members who have a resolved entry
  today (a pattern or an override), matching `resolveEntries()`'s own rule that a member with
  neither produces no entry at all; a household with shift types but nothing resolved today shows
  its own "nothing today" state, distinct from "the module isn't set up yet."
- **API:** `GET /api/v1/schedule/entries?from=&to=&user_id=`, `GET/POST/PUT/DELETE
  /api/v1/schedule/shift-types[/:id]`, `GET/POST/PUT/DELETE /api/v1/schedule/patterns[/:id]`,
  `GET/PUT /api/v1/schedule/patterns/:id/days[/:position]`, `GET /api/v1/schedule/overrides`,
  `POST /api/v1/schedule/overrides/fill`, `DELETE /api/v1/schedule/overrides` (a date range, for a
  grouped row), `PUT/DELETE /api/v1/schedule/overrides/:dateKey`.

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
- **`PATCH catalog/:id` field vocabulary:** an absent field means "leave this alone", a field sent as
  `null` means "clear this". The two readings cannot be collapsed into one, because the edit form
  always sends every field and the empty ones as `null`: read as "leave alone", an icon could never
  be removed again; read as "clear", a partial update would wipe what it never touched. Treating the
  `null` as a value instead of as a case of its own is what once wrote the literal text `null` into
  `icon` and `description` (#789); migration 147 clears the rows that got it, in the catalog and in
  the redemption snapshot both.

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
- **SSO / OpenID Connect (v0.55.14):** When OIDC is configured (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`), a "Sign in with SSO" button appears below the divider. Clicking it initiates an Authorization Code flow with PKCE (S256) and a nonce; state, nonce, and code verifier are stored in the session and consumed once. On successful callback, the user is matched by `oidc_sub`. With no `sub` match, an existing local account is linked **only when the provider reports `email_verified: true` and exactly one account holds that email** (matched against `contacts.email` / `contact_emails.value`, case-insensitive); unverified or ambiguous emails never link, and a new account is provisioned instead. SSO errors display a localized message. Providers that omit the `email_verified` claim entirely are supported via the opt-in `OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM=true` env var (v0.71.11). **Username of a provisioned account (v1.75.3, #653):** derived from the first usable claim in the order `preferred_username` → `username` (non-standard; Synology DSM SSO carries the plain account name there while `sub` also holds the directory part) → `sub`, each run through a sanitizer that enforces the app-wide `[a-zA-Z0-9._-]{3,64}` format (diacritics transliterated, everything else collapsed to hyphens) and falls through to the next candidate if fewer than three characters survive; collisions get a numeric suffix. The email is deliberately excluded: it is not unique across a household that shares one address, and it dragged its domain part into the identifier. `oidc_provider` stores the `iss` claim of the validated ID token, falling back to `OIDC_ISSUER` only when the claim is absent. **Linking an existing account (v2.27.0, #832):** a matching username never links - anyone naming themselves `admin` at the IdP would otherwise take the local admin account - so a user who owns both accounts merges them himself from **Settings → Account → Single sign-on**. `POST /api/v1/auth/oidc/link/start` (requires auth + CSRF, deliberately not a plain link: as a GET a forged request could attach an attacker-owned identity to the signed-in session) returns the provider URL and stores `linkUserId` next to state/nonce/PKCE in the same session; the callback then binds the validated `sub` to that account instead of signing in. Refused when the `sub` already belongs to another account (`sub_taken`) or the account is linked to a different one (`already_linked`); re-binding the same `sub` is idempotent. `DELETE /api/v1/auth/oidc/link` removes a link, except on an account whose `password_hash` is still the `$oidc$` sentinel - the link is its only way in (`no_password`). `GET /api/v1/auth/oidc/link` reports `{ enabled, linked, provider, can_unlink }`. **Provisioning is optional (v2.39.0, #654):** `OIDC_ALLOW_SIGNUP=false` drops step 3 - matching by `sub` and linking by verified email both stay, so an admin-created account still binds on first SSO sign-in, but an identity that matches neither is turned away. `findOrCreateOidcUser()` returns `null` in that case and the callback redirects to `/login?error=oidc_signup_disabled`, which the login page renders as its own message (`login.ssoNoAccount`) rather than the generic `login.ssoError`: the sign-in at the provider did work, only the account is missing, and the collective wording sends the user to their password instead of to their admin. The default is `true`, so an existing installation behaves exactly as before after the update.
- **SSO as the only way in (#847):** `AUTH_ALLOW_PASSWORD_LOGIN=false` switches off the login form, the password login route and password reset together. The check sits on `POST /auth/login` itself, not only on the page - a rule the login screen alone knows is bypassed by `curl`. `GET /api/v1/auth/oidc/config` reports the capabilities (`enabled`, `password_login_enabled`, `guest_password_login_enabled`) in the single blocking call the login page already makes before it paints, so no form is ever shown that then disappears. **The guest exemption is only offered where it applies (#962):** split-expense guests stay exempt from the switch, but a household without a single such guest used to see a "guest sign-in with password" button anyway - an entrance nobody could walk through, which from the outside is indistinguishable from an open one, and was reported as a hole in the bolt the operator had just closed. The server answers with one bit and only where the question arises: with password login open the field is false without the guest table ever being read, so the public endpoint reveals nothing in the normal configuration that it does not already say.

  **Two fail-open conditions, both deliberate.** The switch is ignored unless all four OIDC variables are set *and* at least one account with `role = 'admin'` carries an `oidc_sub`. The second one is what keeps a fresh installation usable: its first administrator is created through `/setup` with a password, and a switch taking hold before that would kill the account in the moment it was created, with `/setup` closed behind it. An ordinary member linking first is not enough either - the way in has to stay open for whoever could open it again. Both states are logged as a warning on startup, because a security switch that silently does nothing is worse than none.

  Because the household's state hangs on that linked administrator, the last one cannot disappear unnoticed: unlinking (`DELETE /auth/oidc/link`), demoting (`PATCH /auth/users/:id`) and deleting (`DELETE /auth/users/:id`) all refuse while the switch is configured. All three are ordinary administration, and any one of them would otherwise reopen every retained password without an environment change or a restart.

  **Two kinds of account are exempt.** Guests of shared expenses (`split_expense_guest_users`) keep password login and reset - they are external people an admin creates with an assigned password and have no presence in the household's directory; the login page keeps a secondary way to their form. Invitations adapt instead of breaking: while the switch is in effect, `POST /auth/invites/accept` creates an account without a password and `GET /auth/invites/preview` reports `password_required: false` so `/join` does not ask for one. An invitation without an email address is refused rather than consumed, because that address is the only way the account can later be linked.

- **Accounts without a password (#847):** `sso_only` on `POST /auth/users` and `PATCH /auth/users/:id` stores the `$oidc$` placeholder instead of a hash - the same value an SSO-provisioned account carries. Deliberately an explicit flag rather than an omitted password: a forgotten field must never quietly produce an account nobody can sign into. It requires OIDC to be configured, rejects a password sent alongside it, and requires an email address that no other unlinked member holds - checked with exactly the linker's own condition (`lower()` over `contacts.email` and `contact_emails.value`), because a narrower check here would wave through the cases the linking later fails on. Switching back off requires setting a password in the same request. `GET /auth/users` reports `sso_only` per member **to administrators only**, on the same reasoning that keeps the 2FA overview a separate admin endpoint.

- **Failed-login logging (v0.55.15):** Failed attempts are logged as warnings with IP, username, and failure reason (`user_not_found` / `invalid_password`), enabling fail2ban / CrowdSec integration.
- **Forgot password (v0.71.51, hardened in #847):** A "Forgot password?" link opens `/forgot-password`. The link is only shown when the server can actually deliver a reset mail: the public `GET /api/v1/version` response carries a `password_reset_enabled` flag (true when SMTP is configured **and** `BASE_URL` is set) and the login page gates the link on it, so it is never a dead end. On the reset page, entering a username or email always returns a generic "if an account exists…" response (anti-enumeration), regardless of whether the identifier matched a user or whether SMTP is configured. When it does match and the user has a linked email (`contacts.email`), a reset link `${BASE_URL}/reset-password?token=…` is emailed; the token is single-use and expires after 1 hour. `/reset-password` reads the token from the query string and sets a new password (min. 8 characters); on success, the token is consumed and other sessions for that user are invalidated. Requires an admin-configured SMTP server (Settings → Administration → Email) and the `BASE_URL` env var — reset links are only sent when `BASE_URL` is set, since the request `Host` header is never trusted for this purpose (prevents reset-link poisoning). API: `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password` (both public, rate-limited).
- After successful login: redirect to dashboard

### Invitations (`/join`) (v1.75.0)

Admins invite new members with a link instead of setting a password for them and passing it on. The invited person picks their own password, so no admin ever knows it.

- **Creating (Settings → Administration → Family and roles → Invitations):** username and display name are optional; leaving them empty lets the invited person choose. Family role, the system-admin flag and an optional email address are set here. `POST /api/v1/auth/invites` returns the plaintext token exactly once — only its SHA-256 hash is stored, so a lost link cannot be recovered, only revoked and reissued. The admin UI builds `${location.origin}/join?token=…` client-side and shows it once with a copy button; the request `Host` header is fine here because a signed-in admin creates and forwards the link, with no third party in between.
- **Sending by mail (optional):** with "send the invitation by email" the server mails the link itself and therefore uses `BASE_URL`, never the request host — the same rule as the password reset. The response field `email_sent` reports honestly whether delivery worked, so the UI never claims a mail that was not sent; without SMTP or `BASE_URL` the admin simply forwards the link by hand.
- **Starting permissions (v171, #869):** the form carries a **starting permissions** choice next to
  the family role, and its preselection is the narrow one. *Without personal areas* locks Health,
  Budget and Documents; *As the role profile* is the behaviour up to v2.61. Underneath, the form
  states what the choice means right now — which modules the template locks, or which ones the
  chosen role already restricts, read from the stored profile via
  `GET /api/v1/permissions/role/:familyRole`. The **stored default is untouched**: what changed is
  the preselected value of a form, not `access_permissions`. Turning the default around would have
  locked out exactly the households migration v74 set out to protect. The **resolved set** is stored
  with the invitation, not the name of the template, so what the admin saw when sending it is what
  applies at first login even if the role profile changes in between. There is deliberately no "full
  access" template: sparse storage means a member override cannot *widen* a role profile — a stored
  `write` does not exist, so no row can overrule a restricting role. To give everyone in a role more,
  change the role profile.

- **Accepting (`/join`):** the public page reads the token from the query string, checks it via `GET /api/v1/auth/invites/preview`, and pre-fills whatever the invitation dictates as read-only fields. `POST /api/v1/auth/invites/accept` creates the user; **role and family role always come from the invitation, never from the request body**, so an invited member cannot promote themselves to admin. The invited email becomes the new member's contact address, which is what makes the later password reset reachable. No session is established (like `/setup`); the page redirects to `/login`.
- **Lifecycle:** invitations are valid for 7 days (fixed, no env var). Redeeming marks the row instead of deleting it, which keeps the "who invited whom" trail and drives the admin UI state. Revoking marks it too and kills the link immediately. The hourly cleanup only removes invitations that expired without ever being accepted or revoked. Redemption marks the invitation inside the same transaction that creates the user, so two parallel redemptions of one token produce exactly one account.
- Both public routes (`preview`, `accept`) carry no CSRF, exactly like `/forgot-password` and `/reset-password`: the token is the secret. Both are rate-limited.
- **Direct creation stays:** `POST /api/v1/auth/users` is unchanged and remains the right way for a child with no mail address and no device of their own.

### Settings (`/settings`)

User management and app configuration. Logged-in users only.

- **Profile (Settings → Personal → Account):** one **Profile** card holds picture, display name, avatar colour and the account's own username (read-only — it cannot be changed), with phone, email and birthday grouped below it as **Contact details**; a sibling card changes the password
- **User management (admin):** create new users, edit/delete existing users, assign roles (admin/member). Since v1.75.0 an **Invitations** panel sits below the member list: it creates invite links, shows the pending ones with their expiry date, and revokes them (see "Invitations" below)
- **Roles and permissions (admin, Settings → Administration → Roles and permissions, #467):** granular, backend-enforced access control per **family role** (the default) and per **member** (an override that wins over the role). Each module is set to `No access`, `Read only`, or `Full`, and each dashboard widget to `Available` or `Blocked`; widgets inherit their module's lock and can also be blocked on their own (e.g. hiding the cycle widget for some members without disabling Health). Configuration is **sparse** — only deviations from the default (full access) are stored, so unset roles/members keep full access and existing installs are unchanged. **Admins always bypass** the system (no self-lockout). Enforcement is **server-side** — the same scope layer that guards API tokens returns 403 on a disallowed module/method; the client mirrors it by hiding blocked modules from navigation and the dashboard, and a **read-only module** hides its create affordance (the FAB) and shows an explanatory banner. **Aggregating endpoints filter their own payload**, because the path-based guard cannot cover them. It resolves a request path to a module via `moduleForPath()`, and an endpoint that serves a dozen modules resolves to its own name: `dashboard` and `search` are scope modules but not permission modules, so they are never in the access map, and `kitchen` is not even a scope module — all three are waved through whatever is blocked. Each therefore filters itself, before the queries run, driven by one table naming which part of the answer belongs to which module:

| Endpoint | Table | What a blocked module yields |
| --- | --- | --- |
| `GET /api/v1/dashboard` | `DENIED_PAYLOAD` (`server/routes/dashboard.js`) | its empty shape (`[]`, `0`); `budget.month` stays, as it is the labelled period rather than a figure |
| `GET /api/v1/search` | `BUCKET_MODULE` (`server/services/search.js`) | an empty result bucket |
| `GET /api/v1/kitchen/summary` | inline, two modules (`server/routes/kitchen.js`) | zeroed counts, same shape |

The shape stays stable in every case — a blocked module yields an empty list, never a missing field, since `/api/v1` is a promised surface for third-party modules. The client-side lock (`canSeeWidget`, `canAccessNavModule`) is a display rule and is not enough on its own, because the payload is readable in the network tab and the service-worker cache. The one part that belongs to two modules — the Countdown list (#647) — is filtered per row instead, so a member without calendar access keeps the task countdowns. `Read only` is not a block: the data is still delivered, only writing is taken away. The shared helper is `deniedModules(req.sessionModuleAccess)` in `server/permissions.js`, which reads what the auth layer already resolved rather than resolving the rights a second time. Stored in `access_permissions`. The settings page shows a role/member switch, a deviation overview, and per-module/-widget access as icon controls with widgets nested under their module. API: `GET /api/v1/permissions/catalog`, `GET/PUT /api/v1/permissions/role/:familyRole`, `GET/PUT /api/v1/permissions/user/:userId` (admin-only); the resolved permission map also ships on `GET /api/v1/auth/me`.

- **Household size (v2.0.2):** `GET /api/v1/auth/me` and `POST /api/v1/auth/login` return `householdSize`, the number of members excluding split-expense guests (they are external participants of a shared expense, not household members — the same line `access_scope` draws). The client holds it in `utils/household.js` and mirrors it to a root class, so the interface can leave out what has only one sensible answer in a household of one. It is a **presentation** signal: no stored value depends on it.
- **One sheet, one reach (Settings → Personal → Navigation, and Settings → Modules → Active modules):** the two decisions about a module live on two sheets, because they have very different consequences. *Personal → Navigation* is entirely the signed-in member's: module order, the three mobile slots, and **hiding a module from one's own navigation (#673)** - an eye button per row writing `hidden_modules:user:<id>` (same allowlist as the household switch, so Overview and Settings stay). *Modules → Active modules* is admin-only and decides what the household has at all (`disabled_modules`). Until the 2026-08-16 critique both stood in the same row, twelve pixels apart, both unlabelled, the more dangerous one the louder: the household switch has no confirmation and no undo, so a misgrab takes a module from six people. The split is the fix - a labelled column would have described the collision rather than removing it. `test:settings-navigation` asserts the two payloads stay disjoint in both directions.
  Hiding is deliberately **not** wired into the route guard the household switch uses: it is tidying, not withdrawal, so a deep link from a notification, a dashboard widget or the search still opens the page - what a member may *not* reach is decided by `member_permissions`. Hidden modules also drop out of the mobile favourite slots, and because that silently rewrites the bottom bar, the toast names the slot that changed. The button keeps a **fixed `eye-off` icon and a stable, module-naming accessible name** (`aria-pressed` carries the state alone): a swapping `eye`/`eye-off` inverted the register the rest of the app uses - `eye` means "show me this" in Documents, Health and Backup - and a name that also carried the state announced itself as "show for me, toggle button, pressed". Toggling updates the row in place instead of re-rendering the sheet, so keyboard focus survives a run of several modules, and a disabled button on a top-level row points at its reason with `aria-describedby` - the four Kitchen children carry no status chip, so theirs would point at nothing and is omitted. The Kitchen row carries one button for the group with its own name, resolving to the four children the way `expandModuleOrder` does for the order; its expanded panel is wired through the shared `bindDisclosure()`, which also assigns the `id` and `aria-controls` both sheets were missing. Both sheets read the module list, the navigation groups and the third-party status wording from the shared layer (`settings/module-order.js`, `settings/components.js`) rather than keeping a copy each - the same drift that once split the Kitchen child lists. **`--fixed` means three grid columns, not "locked":** the phone rule that hides a switch belongs to `--locked`, the two rows whose switch is inert; while it hung off `--fixed`, the new admin sheet lost all eleven of its switches below 640px. individual modules (Tasks, Calendar, Shopping, Meals, Recipes, Pantry, Inventory, Birthdays, Notes, Contacts, Budget, Documents, Housekeeping, Rewards, Health) can be disabled to hide them from navigation. Data is preserved and reappears when re-enabled. Dashboard and Settings remain essential and cannot be disabled. Stored as `disabled_modules` in `sync_config`. **Inventory is the one module that ships disabled** (migration 145): every module is a permanent line item in every household's navigation, including the households that will never track a bike, and Inventory is the first whose audience is visibly a subset. A household that wants it switches it on once; one that does not never sees it. The default is a single migration and can be reversed just as cheaply if it turns out most installs use it. **Kitchen grouping:** Meals, Recipes, Shopping, and Pantry are presented as one global **Kitchen** destination with four individually toggleable children; local pages keep their individual routes. The group shares one accent (`--module-kitchen`), one page-head component (`.page-toolbar--in-group`), one empty-state renderer, one failure-state renderer (`mountLoadError()`, v1.60.0), one row grammar (`.list-row`, v1.58.0), one bulk-action bar (`.list-bulkbar`, v1.59.0) and one transfer path into the shopping list (`kitchen-transfer.js`, v1.62.0 — see Components), so a tab switch changes the content but not the grammar. Recipes, Shopping and Pantry cap their body at the narrow reading column (`.list-scroller`, 720px) and their page head follows it via `.page-toolbar--narrow` (v1.65.0), so head controls end where the list ends instead of drifting to the outer edge - **as a shrinkable slot rather than a margin since v2.47.0 (#882)**, because a margin counts towards the flex container's line occupancy and never yields: at 1960px it claimed 560px of a 1280px row and left 315px for seal, title and search where they needed 441px, which made the wrap arithmetically unavoidable rather than content-dependent (Tasks, Contacts, Budget, Birthdays and the Calendar agenda built two rows at every window width). From 1024px up a `--wrap` head no longer wraps at all - flex splits rows by the *hypothetical* sizes, i.e. before anything has shrunk, so the head broke while yielding slots stood next to it - and the page title is the last to give way, being the only one that cannot come back; Meals is a week board and keeps the full content column. **The tab bar carries the state of the cycle (v1.59.0):** each tab shows what is waiting in that station - open shopping items, pantry items that are expired, empty or running low. Until then the cycle was told only in the four empty states and disappeared with the first record. One request serves both numbers (`GET /api/v1/kitchen/summary?today=YYYY-MM-DD`); `today` comes from the client because "expired" depends on the user's local calendar day while the server computes in UTC. **Meals and Recipes carry no badge (v1.65.0):** a badge says "something is waiting there". A recipe collection has no open state, and the Meals badge counted the opposite of waiting - free slots, i.e. visible meal types × 7 days minus the filled ones. An empty week therefore showed the loudest number in the bar (28 with all four meal types) for the state "nothing planned", and it counted days that had already passed and could no longer be planned. The empty slots on the page itself tell it better. The **active** tab deliberately carries no badge: the page itself shows that state in more detail (list counters, filter chips, empty slots), and a number there would have to be re-fetched after every local mutation. Inactive tabs can only change through one of the four transfers, and those refresh the bar themselves. The web navigation is grouped into Overview, Plan, Home, and Custom modules, and `module_order:user:<id>` only changes order inside each group; Dashboard and Settings stay pinned. The Custom modules group is shown only when enabled third-party modules are loaded. The mobile bottom bar has five stable slots - Overview, three configurable favorites, and More. Favorites default to Calendar, Tasks, and Kitchen, are stored per user as `mobile_nav_order:user:<id>`, and automatically fall back to enabled destinations when a selected module becomes unavailable.
- **Housekeeping (admin):** toggle for automatic payment task creation on work session check-in.
- **Synchronization (Settings → Sync):** organized by data type into five dedicated pages — Calendar, Contacts, Reminders, Document storage, and Document management (DMS) — each opening with a status summary before any setup forms:
  - **Calendar sync (`/settings/sync/calendar`):** CalDAV accounts and Webcal/ICS subscriptions are primary. Manage multiple CalDAV accounts (iCloud, Nextcloud, Radicale, Baikal) with per-account calendar selection via checkboxes, two-way sync, and a unified per-event sync-target picker; manage ICS URL subscriptions (add, delete, sync now, set color and visibility); configure sync interval. Google Calendar (OAuth 2.0, multi-calendar selection, read-only mode), the Outlook one-way push (Microsoft Graph, multi-account with per-account auto-sync target + owner selects, per-account calendar checkboxes and a reconnect action for expired sign-ins) and Apple/iCloud CalDAV live inside an accessible **"More providers"** disclosure that always shows current connection state; Apple carries a **legacy** badge directing new iCloud users to the generic CalDAV setup. OAuth callbacks (`sync_ok` / `sync_error`) render a localized banner, expand the matching provider disclosure, and are then stripped from the URL.
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

  **The currency sits outside the collapsible format card (#934).** It used to live inside it, and that card is hidden while a region preset matches the stored values exactly. Since `resolveRegion()` reads the currency as one of its distinguishing features, the consequence was circular: a default installation (EUR/dmy/24h) resolves to `de-DE`, the card stays shut, and the field is invisible - but change the currency to USD and no preset matches any more, the card opens, and the field appears. It became visible only once you had already changed it, so anyone looking for it never found one. The pointer in Module options ("the currency is now set under Appearance → Region / Format") led straight to the spot where nothing was shown. It now sits in the always-visible region card, which is also where it belongs: date and time say *how* a value is written and follow a place, while a currency follows the money, and a household can have German formats and an account in dollars. A preset still fills it in. Because changing it alone pushes the region to Custom, `syncRegionSelect()` now carries the card's visibility with it - otherwise the selector would claim a state the page does not show until the next reload.

  **69 regions.** `public/settings/region-presets.js` covers Europe, Asia, Oceania and — since v1.78.0 — every sovereign state of the Americas including the Caribbean, plus the Philippines (`en-PH`, `fil-PH`). **Every shipped language has had at least one region since #297**, which added `el-GR`, `hu-HU` and `vi-VN`: until then Greek, Hungarian and Vietnamese households always landed on Custom and had to guess currency, date and time individually, and a guard in `test:region-presets` now holds each locale file against the preset list so the next language cannot ship without one. (This count read 64 from v1.78.0 until #297, two regions behind - `he-IL` and `ms-MY` arrived without it following them.) Each preset's date and time format is taken from the locale's CLDR default rather than estimated, which is why Panama sits on `mdy` and Argentina on `12h`. Dependent territories (Aruba, Curaçao, Cayman, Bermuda) are deliberately absent; those households pick **Custom**. Six states share the East Caribbean dollar and therefore one identical triple — `detectRegion()` can only name a representative for them, while the stored `region` field keeps the selector on the chosen island (#486). The selector sorts by displayed name, not by the order in the preset object. The BCP-47 shape check accepts two- **and** three-letter language subtags (`{2,3}`), since `fil-PH` would otherwise be rejected by the region validator, the household-language resolution and the money formatter alike; a guard in `test:region-presets` reads those regexes out of the source instead of duplicating them.

  **Amount inputs** follow the same region *and* the currency of the value they hold, via `public/utils/money.js` — the single source for money formats. The placeholder is the zero rendered by `Intl` (`0,00` under `de`, `0.00` under `de-CH`, `0` for a zero-decimal currency), and step and lower bound follow the currency's minor unit: EUR steps in cents, JPY, KRW, HUF, IDR, IRR and CLP in whole units. Where the currency is picked in the same form (subscription, shared expense, loan) the field follows that choice. Precision is enforced on save, not just displayed: the budget dialogs are not `<form>` elements and the shared-expense fields are text inputs, so no native check applies. A stored value that predates the currency's grid stays savable as long as it is not touched, so an unrelated edit to a title is never blocked. On input, digits and the decimal separator of the active numbering system are rewritten to ASCII (`۱۲٫۵۰` → `12.50`); a thousands separator is refused rather than interpreted, since `1.000` reads as one thousand in `de-DE` and as one as a decimal — recognized by pattern, so `12.50` still counts as twelve-fifty.

- **Data language (Settings → Personal → Appearance → Language, admin-only, #631, #632):** the language Yuvomi uses when it **stores** content it generates itself — today the titles and descriptions of birthday calendar events. Distinct from the UI language above, which is per user in `localStorage`: a stored row has exactly one wording no matter who reads it later, and that wording is what the REST API, the ICS export feed, the CalDAV/Google outbound sync and the FTS index return. Resolution order: the explicitly chosen `sync_config.language`, else the language part of `region` (`de-DE` → `de`), else English. The middle step is why most households never touch the setting; the last one keeps a household without a region on its previous behaviour instead of silently rewriting its titles on update. `GET /api/v1/preferences` returns three views of it — `language` (what is chosen, `null` for automatic), `language_effective` (what applies) and `language_auto` (what automatic mode alone would yield, which is what the "Automatic (…)" option is labelled with). Changing the language, the region or the date format re-titles the household's existing birthday events inside the same request, so external calendars do not keep the old wording. Server-side translation lives in `server/utils/i18n.js`, which reads `public/locales/*.json` as data rather than importing across the layer boundary.

- **Household time zone (Settings → Personal → Appearance → Region, admin-only, v2.34.0 · #829):** the one zone this household lives in. Resolution order: `sync_config.household_timezone`, else the `TZ` env var, else the host zone, else UTC - so an installation that never touches the setting keeps behaving exactly as before. It exists as a setting because `TZ` is the wrong home for it: `TZ` lives in the compose file, which is out of reach on Umbrel, TrueNAS and Unraid, it is lost by a redeploy that drops the environment, and it also drives log timestamps and the backup cron, which have nothing to do with the family calendar. `GET /api/v1/preferences` returns two views - `timezone` (what is chosen, `null` for automatic) and `timezone_effective` (what applies), which is never null because the "Automatic (…)" option has to be able to name it. Validation is against ICU (`isValidTimeZone`, a `new Intl.DateTimeFormat({timeZone})` probe) rather than `Intl.supportedValuesOf('timeZone')`, which lists canonical names only and would reject a valid alias like `Europe/Kiev`; the dropdown is built from the **browser's** ICU so several hundred option strings stay out of every settings response. Admin-gated like region and data language, for the same reason: the zone decides which calendar day server-side jobs call "today", which zone subscribers read the exported ICS feed in, and what clock time an appointment arrives with in Google and Outlook.

  **Before this there were five answers to "which clock applies here", and three of them were wrong most of the time.** Display followed the browser; the feed, VTODO due times and the Google outbound fallback followed `TZ` via `serverTimeZone()`; the upcoming-events widget, the recurring-split-expense scheduler, budget account balances and the calendar's default month derived "today" from `new Date().toISOString().slice(0, 10)`, which is **always UTC regardless of `TZ`**; the dashboard's date basis used the container's local getters; and the Outlook push carried a hard-coded `Europe/Berlin`. Server-side these are now one: `householdTimeZone(database)` and `todayKey(database)` in `server/utils/timezone.js`; the display joined them in v2.36.0 (see below). **The seventh clock, found in the wake of #851:** both due-date labels - `formatDueDate` on the dashboard and its namesake in the Tasks module - built a `new Date()` out of `due_date`/`due_time` and read its browser getters. Two errors in one: a zoneless wall-clock time became an instant in the *browser's* zone, which the formatters then converted into the display zone (household on Honolulu, browser in Berlin: a task entered for 21:00 read 9:00), and the same clock decided "today"/"tomorrow". In the Tasks module that put two clocks in one view, because the grouping beside it has followed `todayKey()` since #829 - a task could sit under "Tomorrow" and read "Due today". Both now compare wall-clock stamps as text and pass the stamp, not a `Date`, to the formatters. The guard in `test:display-timezone` did not catch it: it matched `new Date(x).getHours()`, and a getter on a variable (`const now = new Date(); now.getHours()`) reads differently. **Widening it turned up seven more**, all fixed alongside: the date picker's "today" ring, the running month in Budget and Inventory, `relativeDateLabel` on the dashboard (which is handed real instants and therefore converted them into the wrong zone), the open-medication window in Health, and the pre-filled date of a new shared expense. The widened guard looks for the **argument-less** `new Date()` - that is a question to the clock, and it has one answer - whether its getters sit on the expression or on a binding. It stays a rule rather than an allowlist: `getSeconds`/`getMilliseconds` are outside the pattern because they read the same in every zone, and the only two exempt files are `utils/timezone.js`, which answers the question, and `theme-init.js`, which runs in the `<head>` before any zone has been mirrored and decides something about the device rather than the household. A second guard covers `toDateString()`, which is the same clock under another name and slips past the first because it uses no getter at all. **`relativeDateLabel` is the cautionary case of the whole sweep:** its first fix routed everything through `zonedDateKey()`, which is right for a real instant and right for a zoneless key *string* - but wrong for `parseLocalDateKey('2026-08-25')`, a browser-midnight `Date` that looks like an instant and means a calendar day. Converting that reintroduced the very off-by-one the sweep was closing. The obligation therefore sits with the **caller**: whoever holds a day key passes the key, and does not build a `Date` out of it first. The connection is **passed in** rather than imported, because `server/db.js` connects and migrates on import and this module hangs off the ICS parser and the recurrence expansion - the same injection `resolveHouseholdLocale(database)` uses. Three guards in `test:household-timezone` keep the count at one: no server module outside `timezone.js` calls `serverTimeZone()` directly, none derives "today" from `new Date().toISOString()` (the named `utcDateKey()` stays allowed - the OpenWeatherMap forecast really is keyed in UTC days, and a name states that intent where an allowlist would only record an exception; since #851 the OWM branch shifts the instant by the location's own offset before taking that key, because the *day* it needs to drop is the one at the weather location, not the one in UTC - far west of it the UTC day dropped the wrong entry and the forecast began at the day after tomorrow), and the Outlook push carries no fixed zone.

  **The sixth clock: the display (v2.36.0 · #829).** The zone above governed the server; the browser still read every value in its own. That only shows up where the two storage forms of `calendar_events.start_datetime` meet: a locally created appointment is bare wall-clock time, a synced one is an instant, and a browser leaves the first alone while converting the second - so outside the household's zone the same clock time rendered two different ways depending on the appointment's origin. `public/utils/timezone.js` is the client-side counterpart and states the deciding rule once: **only a value that carries its own zone is converted.** Wall-clock strings and bare dates are parsed, never routed through `new Date()`, which would first turn them into an instant of the browser's zone and then convert that. Two separations hold the design up. `todayKey()` is a **question to the clock** and follows the household zone; `toLocalDateKey`/`parseLocalDateKey` remain a **converter pair** and must not see it, because the round trip key → Date → key only returns its key unchanged while both directions read the same clock - moving both would have shifted every date key in the app by a day. And the value mirrored into the browser is `timezone` (the choice), not `timezone_effective` (the resolution chain, which is never empty): mirroring the latter would silently move an existing installation's display onto its container's `TZ`. Six guards in `test:display-timezone` keep the count at one, among them that no module outside `timezone.js` derives a day or a time from the browser getters of an instant, and that no second zone-bearing `Intl` formatter exists (`timeZone: 'UTC'` stays allowed - that is not a zone but the assurance *not* to convert). The guards read the source with comments stripped; the first run reported the sentence explaining why `timeZone: 'UTC'` is allowed as a violation.

  **Fixed with it (v2.36.0 · #829):** the setting's own field showed "Automatic (UTC)" again on the next visit even though the choice had been stored. `render()` in `personal-appearance.js` composes the object it hands to the form field by field, and neither `timezone` nor `timezone_effective` was among them - an explicitly composed hand-over object is an allowlist, and a new field falls through it silently.

  **The bug this surfaced (v2.34.0 · #829):** `getUpcomingEvents` compared the two storage forms that live in one column - bare wall-clock time for locally created events, instants for synced ones - as **strings**. Lexicographically `'2026-08-21T21:00'` sorts before `'2026-08-22T00:00:00.000Z'` even though that appointment is still an hour away, so from the early evening onwards a household west of UTC lost the rest of its day from the dashboard widget. Comparison now runs on instants (`storedToInstantMs`), with zone-less values read in the household zone. The display side is untouched and still follows the browser; making it follow the household zone is the open half of this question. Not changed either: the backup cron stays on `TZ`, because its schedule (`BACKUP_SCHEDULE`) is an env setting too and the two belong together.

  **One currency list, one place (v1.61.0, unified in v2.35.0 · #841).** 57 selectable ISO 4217 codes as of #297, which brought back the Vietnamese dong (VND) - dropped when the four copies were unified (#340) while `vi.json` kept shipping, so a Vietnamese household could run the app in its language and not pick its currency. #841 added the Israeli new shekel (ILS) and the `he-IL` region preset (ILS · DD.MM.YYYY · 24h, the CLDR default) before it. The set lives in `public/utils/currency-codes.js` and is read by everything that offers or validates a currency: the household preference (`server/routes/preferences.js`), the currency picker (`public/settings/currency.js`), the Subscriptions tab (`public/pages/subscriptions.js`) and Shared expenses (`server/routes/split-expenses.js`). It used to be four literal copies held together by two guards that compared the four source files by regex - which is why KRW, IDR and IRR were once selectable as the household currency while Subscriptions did not offer them and Shared expenses refused them, stranding those households in two modules; the module lists are validated server-side, so a missing code is a rejected write, not a cosmetic gap. Adding a currency is now one line, and the guard in `test:settings-navigation` no longer compares copies but asserts that **no second list exists** anywhere under `public/` or `server/` - a rule instead of a roll call of the three files anyone happened to know about. Decimal places and symbols stay out of it: `Intl.NumberFormat` has them from CLDR (JPY without decimals, ILS as ₪), and a table of our own would be the next second truth.
- **Family management (admin):** assign a `family_role` (Dad, Mom, Parent, Child, Grandparent, Relative, Other) to each user, and set per-member phone, email, and birthday — automatically synced to Contacts and Birthdays. Displayed in the family member list and profile views. The Edit member dialog has an optional "Reset password" field (min. 8 characters, left blank keeps the current password) so an admin can set a new password for a family member who forgot theirs or never got it working — no SMTP/`BASE_URL` setup required, unlike the self-service "Forgot password" flow. On change, all of that member's other sessions are invalidated. `PATCH /api/v1/auth/users/:id` (admin-only) accepts an optional `password` field.
- **Profile picture:** users can upload a personal avatar (PNG/JPEG/WebP, ≤ 5 MB), stored as a Base64 JPEG data URL in `avatar_data` at 256 × 256 px. After selecting a file a **canvas crop dialog** opens: the user can drag the image and zoom (slider or mouse wheel) to choose the square crop region before confirming. Shown in all avatar circles throughout the app — task cards, calendar agenda, user assignment picker, dashboard task widget, dashboard calendar widget, and notes creator badge — with coloured initials as fallback when no photo is set. Every picture the user crops to a square goes through the same picker, `pickCroppedImage()` in `public/utils/avatar-crop.js`: household member avatars, housekeeping staff avatars, birthday photos, inventory item photos and quick-link tile images. The one image field that deliberately stays outside is the subscription logo: logos live off transparency and may be SVG, and the crop always returns an opaque JPEG - that path validates type and size itself instead. Only the output cap and the wording differ per caller - 768 KB for a portrait, 128 KB for a tile. The dialog itself is module-private, so a caller cannot skip the type check, the 5 MB file cap or the crop; before #901 five hand-written variants of that path had drifted, and the birthday one had no crop at all. GIF is accepted by the server but not offered in the UI: the crop always returns a JPEG, so an animation would silently become a still.
- **App info:** version, license
- **In-app changelog (v1.3.0):** a Help-adjacent "Changelog" action (available to every logged-in user) opens a modal with the release history. The browser calls Yuvomi's own backend (`GET /api/v1/changelog`), which fetches the GitHub Releases of `ulsklyc/yuvomi` on demand, reduces each release body to plain text, and caches the result in memory for 30 minutes (no scheduler, no polling). The modal shows the installed version alongside the latest available release and highlights the installed version when it appears in the list. **Falls back to the bundled file when GitHub does not answer (v2.33.0 · #838):** `CHANGELOG.md` ships in the image (`.dockerignore` excludes `*.md` and makes an exception for it) and runs through the same parser, so an air-gapped install sees the same thirty releases up to its own version instead of an error with no content. It says so, and it reports the latest version as unknown rather than claiming the install is up to date - the bundled file cannot know about anything newer than itself, and the client does not record the check as done. A failed fetch is also backed off for 5 minutes; before that only successes were cached, so once GitHub started failing every request went out again and a household could push itself into the unauthenticated rate limit and keep the failure alive. Rendered entirely via DOM text nodes — no external content is injected as HTML. **Update hint (v1.84.0 · #490):** when the latest release is newer than the installed version, a dot marks the "Changelog" entry in the sidebar and, on mobile, the "More" button that hides it in its sheet; the accessible name of both says which version is available (the dot itself is `aria-hidden`). Opening the modal marks that version as seen and clears the dot until a newer one appears; the modal then leads with "Version X is available" instead of the installed-version note. The comparison is numeric per segment (a string compare would rank 1.9.0 above 1.10.0) and ranks a prerelease below its final release; anything unparseable counts as unknown and never raises the hint. The client asks at most every 6 hours and stores the last known release, so the dot survives a reload without a request; a failed check stays silent and leaves the previous state standing.

### Budget (`/budget`)

**Tabs:** Budget, Accounts, Plan, Statistics, Subscriptions, Loans, Shared expenses.

> **One module, one name - with one deliberate exception.** The module is called `splitExpenses.title` ("Shared expenses", "Gemeinsame Ausgaben") everywhere it has room: page heading, receipt folder in Documents, README, landing page and this spec. Its tab strip label stays the short `splitExpenses.tabLabel` ("Split", "Aufteilung"), because it sits seventh in a row of tabs whose other six are four to eleven characters long. That is the only place a second wording is allowed, and it is the label, not the name. `nav.splitExpenses` was a third wording that no code ever read; it was removed rather than renamed.

**Views:**
- Monthly overview: income vs. expenses, balance, bar chart by category (Canvas, no library)
- Transaction list: chronological, filterable
- **Tab capabilities (v1.37.0):** each Budget tab declares whether the month is its frame of reference and whether it has a "new" action. Month navigation (arrows, month label, "current month") therefore appears as a whole or not at all — it shows on the Budget, Plan and Statistics tabs and is absent on Accounts, Subscriptions, Loans and Shared expenses. The floating action button follows the same table: it creates the item that belongs to the active tab (entry, account, budget, subscription, loan, shared expense) and is hidden on Statistics, which has no create action.
- **New entries follow the displayed month (v1.37.0):** the date field of a new entry defaults to today only while the current month is on screen; after paging back it defaults to the first of the month being viewed, so an entry created while looking at March is not silently filed under today. Since v2.10.1 this is the shared rule described under [Default date for a new entry](#default-date-for-a-new-entry) rather than a copy living in `budget.js`; the Loans tab is the deliberate exception, having no month frame.
- **One set of building blocks across the seven tabs (v1.63.0):** the tabs shared the toolbar, the tab bar, the FAB and the module accent, but from the panel edge inward they had diverged into five metric-card variants, five row namespaces, four panel-header class names, three container patterns, three panel paddings and three scroll axes. They now share one metric card (with `__note` for footnotes and `__progress` for the subscription budget bar, which recolours past 100% instead of sitting silently at full width), `.budget-tab-panel` (padding and scroll axis; the Budget tab's own inner scroll region is a named modifier, as is the form-like Plan tab) and one panel head with its own title role, instead of a sixth heading treatment. **The names moved in v2.0.0:** these blocks turned out to be shared beyond Budget and now live in `panel.css` as `.metric-card`, `.metric-grid`, `.segmented` and `.panel-head` - a component that three modules use should not carry the name of the one it was born in. Net worth and the loan statistics are ordinary metric cards, and the Loans tab no longer frames itself as a card containing cards. Subscriptions and Shared expenses drop their own page gradient and padding while embedded, so the work surface no longer changes tint at a tab switch. Guards in `test:budget-ui` are written as rules over every file of the module rather than as allow-lists of selectors.
- **One time axis for the module (v1.64.0):** the header slot is never emptied, only rewritten. Tabs without a time frame (Accounts, Subscriptions, Loans, Shared expenses) show a quiet context line in place of the stepper ("Current balances", "All active subscriptions", "All loans", "All groups") instead of leaving a gap that read as "the month I picked still applies". The Statistics tab no longer builds a second period picker of its own: it uses the shared header stepper, and its Week/Month/Year switcher now only picks the resolution the stepper moves in. Both ends are reconciled on a tab switch in either direction, so a March picked on the Budget tab no longer reappears as July under Statistics, and a week stepped into August carries that month back. Month and year are formatted exactly as on the Budget tab (`July 2026`, `2026`); week bounds come from the server, so the week logic exists once. `TAB_CAPS` remains the single source and gained two fields for this (`note`, `range`).
- **One switcher, one behaviour layer (v1.64.0):** the module had four looks for the same question — a tinted capsule, a square accent-filled rectangle inside a rounded container, a white tile and an outlined pill — and two of those bars carried `role="group"`, so the arrow-key navigation learned on Budget and Statistics was silently lost on Loans and Shared expenses. All of them now use the shared segmented control, extracted from the Statistics switcher, at the shared touch size (`--target-base`); since v2.0.0 it is `.segmented` in `panel.css`. `wireTablist` gained a `mode`: `tabs` switches a view (`role="tablist"`, `aria-selected`), `select` picks one value from a filter bar (`role="radiogroup"`, `aria-checked`). Loan status, group status and the account colour picker all run through it, so the colour picker gained arrow-key navigation as a side effect. The guard for this is written as a rule over the whole module — no `role="group"` whose children report a selection state, and every `tablist`/`radiogroup` bar found in the markup must be wired to `wireTablist` — replacing an allow-list of three selectors that had not seen the two offending bars.
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
- **Accounts tab:** separate accounts (checking, savings, cash, credit card, investment, other), each with a starting balance and an optional accent color. The tab lists every account with its running current balance (starting balance + assigned entries up to today) and the household net worth. **Drill-down:** clicking an account row switches to the Budget tab filtered to that account (a chip clears the filter); a separate pencil icon opens the edit modal. **Archiving:** accounts can be archived from the edit modal — archived accounts are hidden by default (a "show archived" toggle reveals them with a badge) and excluded from net worth, without deleting their history. Entries optionally reference an account from the entry modal, and each transaction shows its account in the metadata line. Deleting an account keeps its entries (their `account_id` is cleared). Backed by `GET/POST /api/v1/budget/accounts` (`?include_archived=1`) and `PUT`/`DELETE /api/v1/budget/accounts/:id`; entries accept an optional `account_id`, and `GET /api/v1/budget?account_id=` filters by account. **Credit cards** additionally show the issuing bank and what is still available on the card (limit minus the current debt) in a second line under the account type; the two fields appear in the account dialog as soon as the type is set to credit card, and the row stays single-line for a card that has neither (v1.86.0 · #541, see [Budget Accounts](#budget-accounts)).
- **Loans tab:** create instalment-based loans (borrower, total amount, number of instalments, start month); record individual payments; remaining balance and due months shown automatically; paid-off loans marked as closed; filter budget transactions by loan. **Interest loans (#569):** a loan can instead be entered as a German-style annuity (principal, nominal interest rate, initial repayment rate) rather than a fixed total — the constant monthly payment, term and total interest are derived server-side and shown as a live preview while typing; the loan card then displays the annuity rate and the interest phase. A `fixed_then_variable` mode continues after the fixed-interest period with a forecast follow-up rate (a longer follow-up rate lengthens the term), and a `variable` mode covers loans without any fixed-interest period (same maths as a fixed rate, but the rate field is labelled as the current rate and a hint states that payment and term move with it, so the card reads "3.6 % variable" instead of claiming a commitment, v1.45.12). The server is the single source of the interest maths (no client-side formula); the recorded instalment follows the annuity rate, not the term average. **Own currency (#582):** the loan dialog offers a currency and, as soon as it differs from the budget currency, a fixed conversion rate; the hint spells out the direction (1 loan currency = x budget currency), and switching the currency clears the rate so the previous one is never carried over unnoticed. Loan cards, the loan report and the instalment transactions lead with the loan's own currency and show the budget equivalent quietly underneath; the summary card stays in the budget currency and says that foreign-currency loans were converted at their fixed rate. **Outstanding balance (v1.48.0):** an interest loan leads with its outstanding principal, labelled as such and set against the loan amount, instead of the sum of the outstanding instalments, which includes the interest of the remaining term and was read as the figure the bank reports. The loan report lists both (loan amount, outstanding balance, still to pay, paid, instalments left), and the summary card switches its label to *Outstanding balance* as soon as one interest loan is present. Interest-free loans are unchanged, as both figures are identical there.
- **Subscriptions tab:** recurring service CRUD with daily/weekly/monthly/yearly cycles and exact next-renewal calculation. Every active subscription creates a linked expense on the Budget tab for its next payment; edits synchronize it, disabling removes it from calculations, and renewal preserves the paid expense while creating the next one. Includes custom sortable categories and payment methods, searchable in-modal currency/category/payment controls, uploaded logos plus redirect-aware SSRF-protected public HTTPS logo discovery from site icons and public metadata, configurable reminder timing, filtering, sorting, and responsive analytics. Each filter control carries a visible label; a "Reset filters" button appears only while a filter or search is active, and a filtered-to-empty list shows a distinct "No matches" state with a reset action instead of the "no subscriptions yet" empty state (v1.37.0). **Mobile swipe:** swiping towards the row's **start** marks the subscription as renewed, towards its **end** deletes it (same `leading`/`trailing` vocabulary as Tasks and Shopping). The per-row enable/disable buttons were dropped with the gesture rollout; the toggle stays in the edit dialog.
- **Subscription finances:** native billing currencies, configurable base currency and monthly budget, 12-hour exchange-rate cache with optional Fixer refresh, monthly normalization and yearly projection, remaining/over-budget status, and category/payment-method charts.
- **Subscription reminders:** upcoming payments appear in the existing in-app reminder center according to each subscription's reminder timing.
- **Platform inheritance:** Subscriptions uses the application's existing household multi-user authorization, OIDC/OAuth login, SQLCipher option, backup/restore, responsive PWA shell, offline shell caching, themes, and 24-locale i18n system rather than duplicating those controls inside the tab.
- **Shared expenses tab:** shared expense tracking within named groups (household, couple, travel, event, shopping, general). Split methods: equal, exact amounts, percentage, shares. **Split defaults (#517):** each group stores a default split method and, for percentage/shares, per-member default values; new expenses in the group open pre-filled with them (editable in the group dialog once it has at least two members) so recurring same-split expenses need no re-entry. Balances derived from an immutable double-entry ledger — amounts stored as integer minor currency units (cents) to avoid floating-point errors. **Settlements:** record payments between members; a debt-simplification algorithm produces the minimal transfer set. **Recurring expenses:** daily, weekly, monthly, yearly schedule with automatic generation via hourly scheduler. **Guest accounts:** invite people outside the family as restricted users who can only access the Shared expenses module and see their invited groups. The restriction belongs to the account, not to its group membership: deleting the group leaves the guest confined and showing nothing rather than releasing it into the rest of the household, and adding a guest to a further group does not widen what it sees. A guest left without a group keeps its login and stays visible under Settings → Administration → Family, where it can be deleted. **Multi-currency:** each group has a default currency; individual expenses can use any currency with historical exchange rate snapshots. **Activity feed:** per-group log of all expense, member, and settlement events. **Receipts (#583):** an expense takes documents from the Documents module as receipts (link an existing one or upload a new file), and a settle-up records exactly one payment proof — the data model holds a single `proof_document_id` there, so the field accepts one document rather than silently dropping a second. Expenses with a receipt carry a paperclip in the list. The backend already had the columns; until now nothing in the UI filled them, and the read path handed out receipt names without checking the document's visibility. **Archive (#574):** the group list has an Active/Archived filter. An archived group stays fully readable — balances, expenses and activity feed — but every writing action is replaced by **Restore**, which returns it to the active list without a confirmation prompt (the step is lossless and reversible by archiving again). Restoring is limited to group owners/admins, like archiving.
- API: `GET /api/v1/budget/categories`, `GET /api/v1/budget/categories/:key/subcategories` (optional `?lang=` localisation), `POST /api/v1/budget/categories`, `POST /api/v1/budget/categories/:key/subcategories`, `GET /api/v1/budget/stats?range=week|month|year&anchor=YYYY-MM-DD` (totals, comparison vs. previous period, per-period series, per-category breakdown), `GET /api/v1/budget/export?from=YYYY-MM-DD&to=YYYY-MM-DD` (range CSV; legacy `?month=YYYY-MM` still supported), `GET /api/v1/budget/plans?month=YYYY-MM` (planned vs. actual per category + savings goal), `PUT`/`DELETE /api/v1/budget/plans/:category`
- Loans API: `GET /api/v1/budget/loans`, `POST /api/v1/budget/loans`, `POST /api/v1/budget/loans/preview` (live interest calculation — monthly payment, term, total interest, remaining balance after the fixed period; no persistence), `GET /api/v1/budget/loans/:id`, `PUT /api/v1/budget/loans/:id`, `DELETE /api/v1/budget/loans/:id`, `GET /api/v1/budget/loans/:id/payments`, `POST /api/v1/budget/loans/:id/payments`, `DELETE /api/v1/budget/loans/:id/payments/:paymentId`
- Subscriptions API: `/api/v1/budget/subscriptions` CRUD and analytics, plus `/meta`, `/settings`, and `/logo-search` for selectable logo candidates from a website URL or service name.
- Split API: `/api/v1/split/*` — CRUD for groups, members, expenses, settlements, recurring expenses, and activity feed

### Birthdays (`/birthdays`)

Personal birthday tracker with automatic calendar integration.

- CRUD: name, birth_date (day/month/year or day/month only for age-unknown entries), notes, photo
- Profile photo upload (PNG/JPEG/WebP, ≤ 5 MB source file; cropped in the shared dialog and stored as a 256 × 256 Base64 JPEG data URL - see Profile picture). The server still accepts GIF unchanged for API clients, but the UI does not offer it: the crop always returns a JPEG, and an animation would silently become a still
- **Upcoming view:** people stay sorted by days until their next birthday; an optional name day adds metadata to that person but never changes the order. The birthday age is shown when the birth year is known.
- **A linked household member shows that person, not a placeholder:** an entry with `family_user_id` displays the member's photo or their initials in that member's **own** avatar colour — the same rule Contacts follows, so one person carries one colour across the overview, the calendar, tasks, contacts and here (see the identity-colour rule in DESIGN.md). Entries that belong to nobody in the household stay deliberately neutral: they have no identity colour, and the disc says so. `GET /api/v1/birthdays`, `GET /api/v1/birthdays/upcoming` and the single-record responses all carry `family_display_name`, `family_avatar_color` and `family_avatar_data`, `NULL` on unlinked entries. Because the avatar colour is freely chosen, the initials take a computed readable ink rather than the fixed one used over curated tones
- **Countdown chip:** three steps that look like three — today carries the module colour at full strength, "within the next seven days" steps forward into the primary text colour, everything further out stays secondary. No tinted field on any of them (the scale rule in DESIGN.md)
- **Mobile action hierarchy:** phones expose creation through the persistent FAB only; the duplicate header action is hidden so the title retains the available width.
- **Mobile swipe:** swiping towards the row's **start** opens the entry for editing, towards its **end** deletes it (same `leading`/`trailing` vocabulary as Tasks and Shopping, so the gesture mirrors in RTL).
- **Calendar integration:** creating or updating a birthday automatically creates/updates a recurring annual all-day calendar event (cake icon, title `Geburtstag: {Name}` in the household data language, see below). An optional name day creates a separate recurring event with a balloon icon and the same reminder offset; removing the name day removes only that generated event. Deleting the person removes both linked events.
- **Localized event title (#631, #632):** the stored title and description follow the **household data language** (Settings → Personal → Appearance → Language, `sync_config.language`). Earlier they were written in English and only translated while rendering, which covered the web UI and nothing else — the REST API, the ICS export feed, the CalDAV/Google outbound sync and the FTS index all read the stored row and showed `Birthday: Oma` in a German household. Server-side translation reuses the same `public/locales/*.json` the client loads, read as data by `server/utils/i18n.js` (no module import across the `public/`↔`server/` layer boundary). The client-side translation in `public/utils/birthday-event.js` stays as the override for members whose display language differs from the household's. Because the description embeds a formatted date, it follows `date_format` as well; changing language, region or date format re-titles the existing events in the same request
- **Configurable reminder:** customizable reminder offset per birthday with preset options (none, at time, 15 min, 1 h, 1 d, 2 d, 1 w, 2 w) and a fully custom interval (amount + unit). Reminder time calculated from offset; auto-dismissed when the birthday passes
- **Import from contacts:** a toolbar action opens a selection dialog listing contacts (from CardDAV sync, vCard import, or local entry) that carry a `BDAY`/birthday. The user picks individual contacts via checkboxes; each import creates a birthday linked to its source contact (`contact_id`). Idempotent — already-imported contacts are shown with a check mark and "already added" badge and cannot be re-selected. Contacts without a stored birthday are listed separately for manual completion. Manual entry stays available for anyone not in an address book. Photos are not carried over (contact photos are raw vCard base64, not the data-URL format birthdays expect)
- Search filter by name
- **Deletion is undo-based** (5-second toast) rather than confirmation-gated, matching Notes, Contacts and Recipes: a birthday is a date with no history and nothing cascades from it. The server delete is held back until the undo window closes, so "Undo" prevents it instead of trying to recreate the record afterwards
- API: `GET /api/v1/birthdays`, `GET /api/v1/birthdays/upcoming`, `GET /api/v1/birthdays/import/candidates`, `GET /api/v1/birthdays/:id`, `POST /api/v1/birthdays`, `POST /api/v1/birthdays/import`, `PUT /api/v1/birthdays/:id`, `DELETE /api/v1/birthdays/:id`

### Reminders (`/reminders`)

Time-based reminders attached to tasks, calendar events, subscriptions, or inventory items.

- **Tasks and subscriptions keep one reminder per entity** (upsert — creating a new one replaces the previous). **Calendar events carry up to five**, each an independent row delivered separately; the event dialog manages them as a row list (see [Reminders data model](#reminders))
- **Inventory items** derive one reminder from their warranty end date (30 days before, if purchase date and warranty length are both set) and one **per custom tracked date** (see [Inventory Item Dates](#inventory-item-dates-migration-v140)), each with its own configurable lead time. Both are recomputed whenever the item is saved — deleting the underlying date or clearing the warranty fields removes the reminder too
- Reminder time set via the shared `yuvomi-datepicker` in the task or event modal, usually as an offset from the due date/start
- **Pending reminders:** polled on page load and at a fixed interval; displayed as an in-app notification badge/toast
- **Birthday reminders** auto-synced from the Birthdays module (configurable offset per birthday, default 1 day before each occurrence)
- Dismissing a reminder marks it `dismissed = 1`; dismissed reminders are not shown again
- API: `GET /api/v1/reminders/pending`, `GET /api/v1/reminders?entity_type=&entity_id=` (single), `GET /api/v1/reminders/all?entity_type=&entity_id=` (full list for multi-reminder entities), `POST /api/v1/reminders` (upsert one), `PUT /api/v1/reminders?entity_type=&entity_id=` with `{ remind_ats: [...] }` (replace-set, deduplicated, max 5), `PATCH /api/v1/reminders/:id/dismiss`, `DELETE /api/v1/reminders/:id`, `DELETE /api/v1/reminders?entity_type=&entity_id=` (all of one entity)
- **Web Push (PWA):** when a device opts in via Settings → Personal → Notifications, a service-worker push handler shows due reminders as system notifications even while the app is closed. The foreground in-app toast still runs; only the in-page `Notification(...)` is suppressed on devices with an active push subscription (push takes over). **Requires HTTPS** (service workers + Push API). API: `GET /api/v1/push/vapid-public-key`, `POST /api/v1/push/subscribe`, `POST /api/v1/push/unsubscribe`, `POST /api/v1/push/test`
- **Household notification channels:** admins can add Gotify, ntfy, generic HTTP webhook and email channels under Settings → Personal → Notifications. A 60-second server-side scheduler (`server/services/push-scheduler.js`, backed by `server/services/notifications.js`) fans out due, undismissed reminders to Web Push plus every enabled household channel. Delivery state is tracked in `notification_deliveries` for duplicate protection and bounded retries; `reminders.pushed_at` is still set once the active targets are complete or exhausted. API: `GET /api/v1/notifications/providers`, `GET/POST /api/v1/notifications/channels`, `PUT/DELETE /api/v1/notifications/channels/:id`, `POST /api/v1/notifications/channels/:id/test`

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
| `menu.labelKey` | | i18n key for the navigation label, resolved through the module's locale files (#919). |
| `manifestVersion` | | Integer format number of the manifest itself, not of the module. Omitted means 1; a higher number than this Yuvomi reads is rejected outright, never read in part. |
| `page.composition` | | Composition mode of the module page: `reading` \| `data` \| `dashboard` \| `form` \| `split` \| `full` (#929, [`PAGE-COMPOSITION.md`](PAGE-COMPOSITION.md)). The router mounts the module in the declared `.app-page--<mode>` root; `render()` receives that root as `container`. |
| `page.width` | | `reading` \| `content` \| `wide`; refines the measure inside a measured mode, ignored by `split` and `full`. `page.navigation` / `page.responsive` accept `standard` only. |
| `capabilities.permissions` | | Registers the module as `ext:<module-id>` in household permissions, with optional per-widget keys (#919). Required when widgets or an API prefix are declared. |
| `capabilities.widgets[]` | | Dashboard widgets (`<module-id>:<widget-id>`): `entry` exporting `renderWidget(container, { size, options, user })`, `defaultSize`, `defaultVisible`, optional `optionsSchema` (up to 8 keys). |
| `capabilities.api.prefix` | | Exactly `/api/extensions/<module-id>`; any other prefix, including a core path, is rejected and the module loads as errored, so it cannot take over a core token scope. |
| `i18n.defaultLocale` | | Fallback language for `locales/{locale}.json` shipped with the module; lookup order is UI locale, this default, `en`, `de`, then the static manifest labels. |

The full contract for every optional block lives in [`MODULES.md`](../MODULES.md); this table names the fields so the data model is complete.

**Where a third-party module is controlled:**
- **Settings → Modules → Active modules** (admin-only): enable/disable an individual third-party module without restarting the server.
- **Settings → Personal → Navigation** (every member): drag-to-reorder navigation entries inside the Overview, Plan, Home or Custom modules group - entries cannot cross group boundaries - and hide built-in modules from one's own navigation. Third-party modules carry no hide button: `hidden_modules` validates against the same allowlist as the household switch, which knows only the built-in slugs.
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

**"Covers all endpoints" is now a checked claim (v2.52.0).** It had not been one: 40 of 297 routes
were missing, among them four entire modules that had never had a line of specification — quick
links, screensaver, recipe providers, and the permissions endpoints behind the rights matrix. The
existing guard (`test:openapi-structure`) verifies that the spec's own fragment files are imported
and spread, never that they match the routers. `test:openapi-coverage` compares the two in both
directions: a route without documentation fails, and so does a documented route no router serves —
the second kind is otherwise found only by the integrator who calls it.

The guard follows the *routers* rather than a file list, which matters because four modules split
their routes across sub-files and `inventory/index.js` mounts five sub-routers under prefixes of
their own. Three blind spots had to be closed while building it, and each would have made the guard
look **greener** rather than redder: sub-mounts (without them it invents paths and reports those as
gaps), named imports (`import { router as authRouter }` — missing it drops the whole `/auth` branch
from the check), and the router variable that is called `targetRouter` in `server/auth.js`. Its
exception list is empty and each entry would have to carry its reason on the spot: an exception
without a justification is a gap with better camouflage.

Authentication options for external integrations:
- **Session cookie:** standard browser session after login
- **Bearer token:** `Authorization: Bearer <token>` — tokens created via Settings → Administration → API access (admin only)
- **X-API-Key header:** `X-API-Key: <token>` — alternative header accepted alongside Bearer (the plain `API-Key` header is also accepted for MCP-client compatibility)

### Retry-safe writes (`Idempotency-Key`, #822)

Every `POST` under `/api/v1` accepts an optional `Idempotency-Key` request header (printable ASCII, max 255 characters). The one exception is `/api/v1/auth/*`, which is mounted ahead of the middleware. It exists for the case a client cannot resolve on its own: the request went out, the response was lost, and the caller now cannot tell whether the record was created. Retrying may duplicate it; not retrying may lose it.

- **Same key, same body** → the original response is returned verbatim, with its original status code and an `Idempotent-Replayed: true` response header. Nothing is created a second time.
- **Same key, different body** → `409`. A key that stands for two different requests is a client bug, and returning someone else's response would hide it.
- **Same key while the first attempt is still running** → `409`. The record is claimed *before* the route executes, so a concurrent retry collides instead of racing alongside it.
- **The first attempt failed (4xx/5xx)** → the key is released. A caller must be able to fix the payload and retry with the same key rather than stay bound to their own bad input.
- **Different accounts** → different scopes. The key belongs to the authenticated actor, not to the path.

The body fingerprint is taken over a canonical serialization, so re-ordering fields in the JSON body is not a different request - otherwise the retry case, of all cases, would draw a conflict. Records live in `idempotency_keys` (migration v153) and therefore survive a restart; they expire after **24 hours** and are swept on the next keyed request, so no cron is involved. A stuck in-flight record is taken over after 60 seconds, since a process that died mid-request must not block its key until the TTL runs out.

`PUT` and `DELETE` are idempotent by HTTP definition and are not covered. `PATCH` is deliberately left out: whether a repeat is safe depends on the patch, and a half-kept promise is worse than none.

### MCP Endpoint

A stateless [Model Context Protocol](https://modelcontextprotocol.io) endpoint is served at `/mcp` (JSON-RPC 2.0 over HTTP). It lets AI agents such as Claude Desktop drive the planner via natural language. Authentication reuses the API tokens above — send the token as `Authorization: Bearer <token>`; no CSRF token is required, and no new port is needed.

- **Methods:** `initialize`, `tools/list`, `tools/call`, `ping`.
- **Curated core tools:** `list_tasks`, `create_task`, `list_shopping_items`, `add_shopping_item`, `list_upcoming_events`, `create_event` — fast, in-process handlers for the most common actions. `list_tasks` returns each task's tags and takes a `tag` filter (several narrow the list) plus `include_future` (v2.32.0 · #825), which is off by default so the tool selects exactly what the app shows - subtasks and not-yet-started tasks stay out unless asked for; `create_task` accepts `tags` (#586).
- **OpenAPI bridge:** `list_api_operations` and `get_api_operation` discover every documented REST operation; `call_api_operation` invokes any of them over an authenticated loopback call. This exposes the full API through one mechanism instead of a per-route tool, and every call inherits the token's permissions (admin-only routes require an admin token).
- Each call runs as the token's creating user and inherits that user's role. HTTPS is strongly recommended.
- **Token scopes apply here too:** a scoped token only sees the core tools it is allowed to use in `tools/list`, is refused any out-of-scope `tools/call`, and — because `call_api_operation` loops back through the REST layer — cannot reach REST operations outside its allow-list. Use this to hand an AI client a token that, for example, may write the calendar but never read the health module.
- **Role/member module permissions apply here too (#823).** Scopes and [access permissions](#access-permissions-migration-v74) are two independent limits and both must agree: a member configured with `tasks: none` is refused `list_tasks` and `create_task` no matter what the token's scopes say, and a member on `tasks: read` may list but not create. A scope can only narrow what the member already has — issuing a token can never widen it. `tools/list` hides what the account may not call, so an agent is never offered a tool its next request would refuse. **Split-expense guest accounts** reach no core tool at all, mirroring the `/api/v1` guard that confines them to `/split-expenses`. Until this fix the core tools ran in-process against SQLite and never met the `/api/v1` middleware, so MCP answered a request that REST denied for the same person — the rule itself now lives in `server/permissions.js` (`moduleAccessVerdict`) and both surfaces call it rather than each spelling it out.
- Binary responses through the bridge (e.g. document/backup downloads) are inlined as base64 up to **5 MiB**; larger downloads are rejected and should use the dedicated streaming REST route directly.
- **Optional:** `MCP_INTERNAL_BASE_URL` overrides the base URL the bridge calls back into; it defaults to `BASE_URL` or `http://127.0.0.1:<PORT>` and is only needed for non-standard bind addresses.

---

## Design System

### Colors (CSS Custom Properties)

**Source of truth: `public/styles/tokens.css`** — and only there. Every value carries its measured
contrast ratio next to it, and every public token is a `var(--_private)` indirection, so light and
dark are declared once instead of being repeated across `@media` and `[data-theme]`. This section
describes the *decisions*; it deliberately no longer reprints the values. The excerpt it used to
carry was a second spelling of the palette, and by v2.0.0 twenty-three of its forty-five hex values
no longer existed anywhere in the codebase.

**The stage is a warm neutral ramp.** The app ground is the grouped background (`--color-bg`,
warm paper in light, warm charcoal in dark); cards, cells and work areas sit on `--color-surface`
and its work/raised variants. One inset-well fill (`--color-surface-3`) is the only permitted tint
for a tile *inside* a card. **(v2.2.0)** The ramp was Apple's cool system greys until then; the
light ground was swapped at equal luminance (L 0.8962 against 0.8910) so no documented AA value
could shift, and the dark ground came off the near-black floor it stood on, where cards had nothing
to separate from.

**The voice is one accent: the violet of the app icon** (`--color-accent`), 6.10:1 on white and
5.49:1 on the grouped ground. Its tinted twin `--color-accent-light` carries focus glows and
today-chips. **(v2.2.0)** It was Apple's indigo until then - correctly measured, but a second brand
colour beside a violet icon.

**The one-voice rule (v2.2.0).** Whatever does the same thing in every module carries the voice:
the tab bar and sidebar, the FAB, buttons, switches, the focus ring, the datepicker, shell
overlays. **The module tints** (`--module-*`, one per module plus the shared kitchen, overview and settings tones) carry what says *where you are*: the module
seal, the module's own bars and segments, its chips and section marks, its row hovers, its widget,
its icon in the navigation legend (v2.20.0: both bars - the sidebar and the mobile tab bar; it was
the sidebar alone until then, which made the legend a desktop rule by accident). The router sets `--active-module-accent` on `<html>` and components
in the content read `var(--module-accent, var(--color-accent))`; the shell never does. Before this,
the tint reached the chrome, and switching module repainted the whole frame. The four kitchen
modules deliberately share the meals tint — a colour change on a tab switch would be the strongest
"you have left the context" signal in the app. Dark mode flips these to vivid light variants
carrying dark ink (`--color-ink-on-vivid`), not white. Guards: `die Shell traegt die Stimme, nicht
den Modulton` and `kein geteiltes Bedienelement wird unter seinem eigenen Namen umgefaerbt`
(`test:frontend-audit`).

**Severity is hue-separated from module identity**, and warning is kept distinct from danger for
colour-vision deficiency. Chart series have their **own** palette (`--chart-series-1..7`) rather
than borrowing module tints, because a module colour means something that would be wrong in a
spending donut. **Borrowed means the same value, not the same token name (v2.2.3):** the original
guard checked that no `--module-*` appeared in the palette, which held while `--chart-series-2` was
byte-identical to `--_family-money` in both themes — the tone the budget itself wears, and the
palette only ever runs there. Series 2 is petrol since; the guard now measures perceptually
(CIEDE2000, threshold 2.3 = just-noticeable difference) and only against modules that actually
render charts, deriving them from `router.js`. Series 3 and 7 still carry the kitchen and tasks
tones and deliberately stay: neither module has a chart, so nobody sees the overlap, and the series
double as named account colours whose names would have to move across every locale. That exemption
expires by itself — the run in which a kitchen or tasks page gains a chart is the run that fails.
Priorities encode rank by colour alone on the dashboard and the mobile calendar, so
"high" stays separable from "urgent" by lightness as well as hue.

**The evaluation surface (v2.24.0).** A chart with a value axis carries one coordinate system
across the app (`public/utils/chart.js`): fixed margins, a five-tick value axis inside the picture,
three time marks along the bottom. It was extracted from Health rather than designed - that module
had solved it for its three charts, while the budget trend and the subscription area chart had each
answered the same question their own way, both by stretching the box (`preserveAspectRatio="none"`)
and moving the axis outside it. Those two are one fault, not two: without fixed margins there is no
room for an axis inside, and outside it drifts against its own grid lines whenever the chart
resizes. What stays with the module is the **vocabulary** - whether a tick reads "8:24", "126" or
"5.050 €" is only knowable there, so the shared helper takes a format callback. A value axis
labels a scale, not a balance, so money on one drops its cents.

Not every chart is that shape. A **proportion bar** carries a neutral track with a fill whose share
comes from the data as a 0..1 custom property, never as a pixel height computed in the markup - the
weather forecast span and the housekeeping payment bars are the reference. A distribution donut is a
third form again. The three do not share a component; they share the four promises in DESIGN.md.

**The per-background rule.** AA holds *per background*, not per colour. A tint that passes on white
can break on the grouped ground — seven module tints did exactly that and were deepened. Every new
colour/surface pairing is measured against its real ground, in light **and** dark, never estimated
and never carried over from another palette. Probe 2 of `test:document-guards` measures the
composed contrast on the rendered document.

**Dark mode** keeps the hue and adjusts lightness and saturation, with two deliberate exceptions:

- **Edges are set independently, not derived from the neutral ramp.** The ramp sits too close to
  the surface colour in dark, so the subtle step would resolve to the surface itself.
- **Accent tints go darker, not lighter** — a "light" accent surface on a dark canvas has to sit
  *below* the text, not above it. The hover step of the semantics, by contrast, goes **up**: a
  darkened light colour on a near-black ground was three AA breaks from one cause.

One known, documented deviation: the edges of controls do not reach the 3:1 of WCAG 1.4.11
(measured 1.26:1 light on surface, 1.60:1 dark), as with Apple's own grouped-list separators. Text
contrast is without violation throughout.


### Typography

The voice is the operating system's. `--font-sans` is a system stack (`-apple-system`,
`BlinkMacSystemFont`, `"SF Pro Text"`, then the platform grotesques), `--font-mono` the matching
monospace stack — **no self-hosted UI webfont**. Until v2.0.0 this was Plus Jakarta Sans. The
files under `public/fonts/` outlived it by one release, kept alive only by the installer's
`/fonts/` route and a test asserting that route's 200; nothing in `public/` declared an
`@font-face` for them, no service worker precached them, no manifest named them. Files, route and
test are gone. Plus Jakarta Sans survives in exactly one place — `docs/fonts/`, embedded as
base64 by the two image generators — because a committed picture has to render the same on every
machine, which a system stack cannot promise.

Sizes follow Apple's type scale, assigned through semantic `--type-*` tokens in `tokens.css` and
taken up either by a `u-*` utility class or by the BEM selector registered for that role in
`typography.css`. Each role is defined exactly once.

- **Large Title** 34px bold — page titles and the dashboard greeting. Stays 34px on desktop
  instead of growing, and always carries `--color-text-primary`.
- **Title 2** 22px bold — the module head title in the canonical page head, one role for every
  module, settings leaf and split view.
- **Title 3** 20px semibold — section headings, in sentence case.
- **Headline / Body** 17px — card and item titles (semibold) and running text (regular, line
  height 1.47 = Apple's 17/25). `.u-compact` drops the headline to 15px where density is a
  deliberate decision rather than a per-selector override.
- **Subheadline** 15px — secondary lines. **Footnote** 13px medium — meta rows, field labels.
  **Caption 2** 11px semibold — badges and counters.
- **All-caps micro label** 12px semibold with `--tracking-label` (0.05em) — the section head of a
  grouped list, and the only place caps are used. Navigation grouping labels (sidebar sections,
  settings domains, task groups) stay in sentence case: whole phrases read as shouting in caps.
- Inputs never go below 16px (`--text-base`, the iOS zoom threshold). The heading scale ends at
  34px on purpose; the 48/72px display steps exist only for readouts on a wall tablet.

Two rules decide which head role applies, both written out in `typography.css`: a head that names
a **section** of the page is a sentence-case heading, while one that repeats with a changing value
over **one list** is an all-caps micro label — what is named decides, not what carries it. And a
heading that a bar above it already names is not shown at all; it stays as `.sr-only` so the
document outline survives.

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
- **Resuming covers the pages that scroll `.app-content` itself.** Eight module roots (`.budget-page`, `.calendar-page`, `.contacts-page`, `.meals-page`, `.notes-page`, `.pantry-page`, `.recipes-page`, `.shopping-page`) are `overflow: hidden` at full height and scroll an inner container instead, so `#main-content` never leaves 0 there and back returns them to the top. Starting at the top on forward navigation works everywhere, because those inner containers are new elements after every navigation and begin at 0 anyway. Carrying the resume into them needs the module to name its scroll region rather than the router guessing it - **that naming now exists** (`.page-scrollport`, below), so the missing piece is the restore itself, not a way to find the region.

- **Two scroll-port architectures, one role.** A page either scrolls `.app-content` as a whole (Tasks, Rewards, Documents, Health, the Dashboard) or keeps a fixed frame and scrolls one container inside it (the eight roots above). Anything fixed above the scroll port - the FAB, the bulk-action pill, the install banner - needs trailing room at the scroll end, and that room only works **inside** whatever actually scrolls. Applied to the frame instead, it shortens the real scroll port at every scroll position and leaves a strip below it that carries nothing and cannot be scrolled; measured 76px per module on a desktop, 80px on a phone. `.page-scrollport` is the role "I am my page's scroll port": every module with an inner container carries it, `--fab-tail`, `--bulk-pill-tail` and `--install-prompt-tail` add up to `--shell-tail`, and one rule applies the sum to the role - or to `.app-content` where a page brings no role of its own (`:not(:has(.page-scrollport))`). The same exclusion resolves nesting: Budget swaps its scroll port at 640px, both elements carry the role, and the room goes to the innermost. A scroll port with a floor pad of its own declares it as `--scrollport-pad` rather than `padding-bottom`, so the trailing room adds to it instead of replacing it. `test:frontend-audit` enforces both directions - every root that cannot scroll itself hands out the role, and no `.app-content` rule reserves a zone without excluding the pages that bring their own port.
- Route-level load failures replace the page with a localized recovery state. The state uses `role="alert"`, receives focus without scrolling, and offers a reload action; modules must not convert failed initial loads into misleading empty states.
- The same holds **inside** a module, for a list that fails while the page around it stays usable: the failure is carried into module state and rendered before the empty branch, because after a failure the collection is empty too and the empty branch would otherwise win. A toast is not sufficient on its own — it fades while the misleading state below it remains. See `mountLoadError()` under Components.

### Glass Layer (`public/styles/glass.css`)

Additive stylesheet loaded globally after `layout.css`. It implements the Liquid Glass design
philosophy — introduced by Apple with iOS 26 / macOS 26 at WWDC25 — adapted for CSS. The line is
**readability before transparency**: the glass is diffuse and saturated rather than raw-transparent.

**Glass is chrome, and only chrome.** `backdrop-filter` exists on the tab-bar capsule, the sidebar,
sheets and modals, the toast, the date-picker popover, and the FAB with its backdrop and actions.
Content — cards, lists, widgets, text — is opaque. Until v2.0.0 the opposite was true: dashboard
widgets, task cards, note items, meal slots, form inputs and toolbars all carried a translucent
card background with a module-tint overlay. Probe 12 of `test:document-guards` measures the rule on
the rendered document.

**The module head deliberately carries no glass**, and that is an argued deviation from the canon
rather than an omission. Two measured reasons: the collapsing large-title bar depends on it (glass
would show a surface at the very start of the scroll where none should be), and `position: sticky`
plus `backdrop-filter` inside an `overflow: auto` container blanks the whole scroll port on
iOS 26+ (a WebKit compositor bug). A guard learns the head classes from the markup, so a module
that gave glass to its *own* head class would still be caught.

**Blur steps** are `--blur-2xs` (2px) through `--blur-lg` (32px) — five steps, no `--blur-xl`. The
token **is** the accessibility switch: under `prefers-reduced-transparency` and
`prefers-contrast: more` every step collapses to `blur(0px)` in `tokens.css`, so a fallback does
not depend on the `@supports` block.

**The fallback rule.** Every glass surface has an opaque fallback. Non-blur styles (background,
border, shadow) sit **outside** `@supports` and apply everywhere; only `backdrop-filter` sits
inside — always in both spellings, standard and `-webkit-`, because Safari < 18 knows only the
prefix and iOS is this PWA's primary device. Both are guarded in `test:frontend-audit`.

**Specular edges** come from `--glass-inset-*` (top light edge), `--glass-inset-bottom-*` (dark
lower edge) and `--glass-inset-bottom-lift` (a faint light edge for surfaces that float free and
have nothing below them to cast onto). All of them carry the factor `--glass-inset-strength`, which
drops to 0 under the two accessibility states — a raw `rgba` at these places would survive the
switch, and a guard forbids it.

**Mobile compositor safety (#166).** One permanent rule disables `backdrop-filter` and `filter`
for every element inside the `.app-content` scroll container. With many blurred compositor layers
in a scrolling container, mobile WebKit and Blink fail and render a blank screen. Elements outside
the scroll container — tab bar, modals, toasts — keep their blur. Note the consequence for guards:
this rule enforces "glass is chrome" in the document *as a side effect*, so a probe that only asks
the rendered document can pass tautologically; the written rule is checked in the stylesheet as
well.

**The drifting backdrop** (`.lg-backdrop`) remains the app's only chromatic drama: four slowly
moving blurred blobs on a non-scrolling layer inside `.app-shell`, the first following
`--active-module-accent`. `--lg-blob-opacity` is deliberately low (0.16 light / 0.20 dark) so
content dominates, and collapses to 0 under `prefers-reduced-transparency` / `prefers-contrast`.
The drift freezes under `prefers-reduced-motion`.

**Navigation** keeps its sliding pill indicator on the sidebar and the mobile bar, and its custom
monoline SVG icon set (`public/nav-icons.js`), with Lucide as the fallback for entries without a
custom glyph.

**One module, one glyph, one hand (v2.20.0).** `nav-icons.js` is the MODULE icon set, not just the
navigation's: wherever a module identifies itself — navigation, "More" sheet, widget head, stat
tile, day programme, search, wall, the module list in Settings — the glyph comes from
`moduleIconEl()` / `moduleIconHTML()`. Action and state glyphs (chevron, plus, a meal's time-of-day
mark) stay Lucide; they do not answer "which module". The mapping module → glyph lives in exactly
one place (`MODULE_ICON`), and `widgetHeader()` takes a **widget id** rather than a glyph name, so
the two cannot disagree. It had lived in five places and had drifted: Notes was `sticky-note` in
the navigation and `pin` in the widget head, Housekeeping `paintbrush` and `sparkles`.
Each icon is a **description** (`[tag, attributes]`) rather than a DOM sequence — the string-building
callers (dashboard, settings) must not need a `document` — from which both the element and the
markup are derived; neither form is built from the other, and neither uses `innerHTML`.
The stroke weight is a token (`--icon-stroke`, applied with `vector-effect: non-scaling-stroke` via
the `.module-glyph` mark both helpers attach). Before that it was a coincidence: the own set draws
at 1.6 on a 24 viewBox and Lucide at 2, which at 20 px and 16 px respectively both rendered 1.333 px
— the agreement hung on the sizes, and broke as soon as an own glyph was used at 16 px.


### Components
- **Cards:** Opaque and borderless on the grouped ground — `var(--color-surface)`, `var(--radius-md)` (12 px) for the card, `var(--radius-lg)` (16 px) for a row carrier, `var(--shadow-sm)` at rest. **The separation is done by the shadow, not by an edge**, which is why nothing inside a card carries an edge of its own: a row becomes a hairline (`+` combinator), a tile becomes an inset well (`--color-fill-well`, no border, radius kept). Real controls — inputs, buttons, chips, checkboxes, steppers, drop targets — keep their edge; they are handles, not boxes. Nested radii are concentric, written out as `calc(var(--radius-*) - Npx)`. Internal padding `var(--space-4)`, compact 12 px. Until v2.0.0 cards carried `--glass-bg-card` with a module-tint `::after` overlay app-wide; glass is now chrome only (see Glass Layer).
- **Buttons:** One shape for every variant — the capsule (`--radius-full`), declared once in the `.btn` base rule, min-height 48 px. `--radius-glass-button` is gone: a token of its own suggested there was a second, non-glass button shape. Primary is the app's voice slightly deepened (88 % mix with `--neutral-950`) carrying `--color-ink-on-vivid`; it read the module accent until v2.2.0, when the one-voice rule made a shared variant the same colour everywhere, which is white in light and dark ink in dark — not static white. Secondary is an outline. The rule holds for buttons that are not `.btn` too, and it is guarded by the signature of the variant rather than by its name. Submit buttons show success (checkmark, 700 ms) and error (shake).
- **Inputs:** `var(--radius-sm)`, 1.5px border, padding 12px 16px. Search inputs take the same capsule as every other control. `[required]` fields receive validation status on blur (`.form-field--error` / `.form-field--valid`), and re-validate live on input while marked invalid. **Field-anchored form errors (v1.40.1):** modal save paths report validation failures at the offending field instead of a detached toast — the shared helpers `validateAll` / `reportFieldError(input, message)` (`public/components/modal.js`) render the message directly below the field (`.form-field__error`, `role="alert"`, linked via `aria-describedby`), set `aria-invalid` plus the error border, and focus/scroll the first invalid field into view; custom messages (e.g. "end before start") clear themselves on the next input. Used across the calendar event modal and the meals, notes, recipes, budget, budget-plans, subscriptions, and health modal forms. Enter in a **single-line field** submits the modal form (standard web convention, v0.55.0); in a multi-line textarea Enter inserts a newline.
- **Search field (`public/utils/page-search.js`):** the canonical search affordance for list/filter modules — `renderPageSearch()` emits a `<label for>` with an sr-only name, a leading magnifier, the input (`enterkeyhint="search"`, `autocomplete="off"`, `spellcheck="false"`) and a clear button that appears with the first character; `wirePageSearch()` adds the debounce (200ms default) and returns a handle whose `clear()` also hides that button. Modules pass an id, labels and one `onQuery` callback; only toolbar positioning (flex/max-width) stays a thin per-module class. **Pantry and Recipes joined it in v1.60.0** — they had each rebuilt a bare `<input type="search">` with none of the above, the placeholder carrying the only label, and no debounce in front of a full list re-render. The guard in `test:frontend-audit` no longer checks an allow-list of files but scans **every** page for a hand-built search input, so a new module cannot quietly repeat it; documented exceptions (Calendar's server-FTS bar, Split-expenses' visible label, Subscriptions' server-filtered field) are named with their reason.
- **Date & time picker:** Every date and time field across the app uses one shared `yuvomi-datepicker` web component (calendar appointments, tasks, meal planning, budget, health, birthdays, shopping, split-expenses, housekeeping, subscriptions, settings, and the recurrence "until" date). Free-text entry stays the fast path — locale-aware parsing keeps the flexible shorthands (`0930`/`9h30` → `09:30`, `5.1.2027` → the locale date) — while a trailing icon opens a themed calendar/time popover on desktop and the **native OS picker on touch** (`showPicker()`). The popover renders in the top layer via the native Popover API (never clipped inside a modal), takes the app's voice from `--color-accent` (it read `--active-module-accent` until v2.2.0 - a shared control that coloured its selected day differently in every module), marks today and traps focus. The component is **form-associated** (participates in `form.elements`/`FormData`), exposes a canonical ISO `value` (`YYYY-MM-DD` / `HH:MM` / `YYYY-MM-DDTHH:MM`), enforces optional `min`/`max` on both typing and the grid, adopts an associated `<label>` as its accessible name, and mirrors direction for RTL. Weekday/month names come from `Intl`; no dedicated locale strings.
- **FAB (Floating Action Button):** Colour is the app's voice (`--color-accent`), the same in every module - it read `--active-module-accent` until v2.2.0, which made the most prominent button on the screen change colour with the route. Specular inner highlight + attention ring pulse. Hidden while the virtual keyboard is open, which counts as open only when a text field has the focus *and* the visual viewport is shrunk (v1.73.1; the viewport alone also shrinks for the iOS address bar, which took the button away without any keyboard). **The FAB lives in the app shell, not in the page (#634):** a page creates it in its own root, but the router lifts it into `#fab-layer`, a sibling of the scrolling `.app-content`, and drops it again with the outgoing page. A fixed element inside a scrolling container is not reliably viewport-anchored on iOS - it resolves against the scrolled content and drifts out of sight as a list loads. The bottom nav left `position: fixed` for the same reason; the FAB was the last fixed element in the scroll port. Consequences: modules look it up document-wide via `findPageFab()` (a `container.querySelector('#fab-…')` returns null silently and leaves a visible button that does nothing), and no stylesheet may address it through a module context - only `html`, `body`, `:root`, `.app-shell`, `.fab-layer` or `.keyboard-visible` survive the move, which `test:frontend-audit` enforces as a rule over every stylesheet. Rendered from one shared helper `public/utils/fab.js` (`pageFabHtml` / `createPageFab` / `findPageFab` / `setPageFabAction`); tab/route modules (Health, Rewards, Housekeeping) drive a **context-aware, permission-gated** FAB whose action follows the active tab/route and hides where no create action applies, and Budget's FAB covers its embedded Subscriptions sub-tab (v0.94.0). **A FAB may bring a fly-out (v2.0.1):** the Dashboard's speed dial is a `.page-fab-group` wrapping a real `.page-fab`, and `adoptPageFab()` lifts the *group* so the action list and its backdrop - both positioned, both invisible from the page's point of view - travel with the button instead of staying behind in the scroll port. Inside a group the button gives up its own anchoring and the group carries it, which keeps the geometry in one place (`layout.css`); the list hangs absolutely above the button so the group's box stays exactly the size of the button and catches nothing that is not the button. Until then the Dashboard built its own `.fab-container`, so it was the only FAB in the app that the #634 hardening never reached, and its own hand-written 52px never learned about the touch step of `--fab-size`. **The FAB sits inside the tab bar wherever there is one (v2.2.0):** below 1024px it is anchored at the trailing end of the navigation capsule, which reserves that end via `padding-inline-end` under the same `:has()` condition - a page without a FAB gets the width back. `--nav-capsule-inset` is the one source for the capsule's centring and the button's position, so they cannot drift apart. **`--fab-safe-zone` is therefore 0 there:** the button stands over chrome, not over the scroll port, and the #634 guarantee holds structurally instead of through a reserved strip (measured: 0 overlaps across pantry/contacts/shopping x 375x375, 640x400, 1280x800). It cost 92px of full-width scroll port on every mobile screen. **On the desktop the FAB still floats and keeps its zone**, so nothing operable can end up unreachable under it. Where that zone is applied has changed twice, and both changes were corrections of the same misconception. It began as `padding-bottom` at the end of the list, which sits at the end of the *content* and scrolls with it - at `scrollTop = 0` up to 80.6% of a row action was covered. It then became a margin on `.app-content`, which shortened the scroll port at every scroll position and cost the dashboard grid 96px of full-width room. Since **v2.6.1** it is a trailing pad again, but with the invariant corrected from "never covered" to "never unreachable" (see the Dashboard section). **The pad now goes to whatever actually scrolls** (`.page-scrollport`, under Responsive Composition), not to `.app-content`, which on eight of the module roots is a fixed frame around the real scroll port. `--fab-gap` is the single source for both the button's offset and the zone, so moving the FAB moves the free space with it. Three drifted copies of the old token (`--budget-fab-clearance`, `--rw-fab-clearance`, and a third in Shopping) are gone; they recomputed the formula without `--nav-bottom-height` and were over 60px too small on phones. This required module roots to *read* the available height instead of recomputing it from `100dvh` — nine of them did, so they ignored any shortening of the shell.
- **Module accent colors (rewritten v2.2.0):** `--module-accent` colours what says *where you are*, all of it inside the page: the module seal, the module's own bars and segments, its chips and section marks, its row hovers, its widget on the dashboard, its icon in the navigation legend (both bars since v2.20.0). It no longer touches the shell - the nav bar, the sidebar's active pill, the FAB, buttons, switches and the focus ring carry `--color-accent` in every module (one-voice rule, see Colors). The active tone is still written to `--active-module-accent` on `:root` on every navigation change, for content that sits outside the module root (modals in the top layer). Falls back to `--color-accent` for pages without a module context. The three layers listed here before v2.2.0 - active nav tab, toolbar `border-top: 3px`, cards/rows `border-left: 3px` - are historical: the two stripes went with the redesign, and the nav tab went with the one-voice rule.
- **The tint scale (Runde 9):** every tint — surface, state, edge, ink, shadow — takes a *named step* from `tokens.css` (section 6b) rather than writing its own percentage. Measured beforehand, the app tinted in **214 places across 37 percentage steps** while the rule said "16 %, one recipe, app-wide" and described 23 of them. The seven steps come from measurements, not from a series: `--tint-wash` (8 %) undercuts *foreign* content — bars, banners, whole rows, calendar cells; `--tint-state` (12 %) is a state on an untinted surface; `--tint-surface` (16 %) is a tint that *is* the element — chip, badge, icon well, note card, event bar; `--tint-raised` (24 %) a state on top of one of those; `--tint-hint` (50 %) a hint (edge, line, empty-state icon); `--tint-ink` (70 %) text on a tinted surface; `--tint-shadow` (20 %) a shadow derived from a tint.

  The four surface steps form a **ladder, and a state climbs one rung** — exactly how the existing code had computed it by hand four times (16→24, 16→24, 18→26, 12→20). The wash/surface split is measured, not stylistic: the low-percentage places are a median of **47,520 px²** in the rendered document, the high ones **1,764 px²** — a factor of 27. A bar carries visible colour at 1.11:1 where a 24px badge at the same ratio disappears. The edge got a single step because no tinted edge holds 3:1 in light mode, not even at 70 % — it accompanies, it never carries alone.

  Three things are **not** tints, each excluded by a signature rather than a selector list: opaque values from 45 % up (the colour *is* the surface there and is being darkened), user colours as text (the user-colour rule applies, since the formula breaks at the ends of the lightness axis), and animation steps inside `@keyframes`. Guarded by `jede Toenung nimmt eine Stufe der Toenungsskala` (`test:frontend-audit`).

- **Accent text on an accent-tinted ground (v1.48.2):** wherever text sits on a tint of its own accent (active filter chips, count badges, initials avatars, module badges), the text uses `color-mix(in srgb, var(--module-accent) 70%, var(--color-text-primary))` rather than the raw accent. With the raw accent the contrast depends solely on that accent's lightness, and 13 of 17 modules missed AA (Recipes 2.84:1, Shopping 3.21:1 against `--color-bg`); the 30% ink admixture shifts the text away from the ground in a theme-aware direction (darker in light, lighter in dark) because `--color-text-primary` flips with the theme. Worst case 4.99:1 (light, Settings) and 5.32:1 (dark, Health), with the hue unchanged so module identity is preserved. **Text only** — icons keep the full accent, where 3:1 applies. The FORMULA is deliberately not a `:root` token: custom properties are substituted in the defining scope, where `--module-accent` is not yet set, which would freeze the `--color-accent` fallback and tint every module violet. The **percentage**, however, is one — `var(--tint-ink)` from the tint scale (see below). Formula and value are two questions, and reading the sentence above as covering both is what produced 37 percentage steps across the app.
- **Edge tokens in dark mode:** the three border steps are set independently under dark instead of being derived from the neutral ramp. The ramp sits so close to `--color-surface` there that `--color-border-subtle` resolved to **exactly the surface colour** (1.00:1) - a card edge in the colour of its own face, which left cards, list rows and form fields without a visible boundary. Dark therefore carries its own three values, each with its measured ratio next to it in `tokens.css`. **Known and deliberate:** the edges of controls stay below the 3:1 that WCAG 1.4.11 asks of a control boundary, in both themes (measured 1.26:1 light on surface, 1.13:1 on the grouped ground, 1.60:1 dark), as with Apple's own grouped-list separators. Raising `--color-border` globally would harden every card edge in the app along with it; the clean route would be a separate `--color-border-control`. Text contrast is without violation.
- **Module head width and bleed (v1.45.15):** the head is a full-bleed rail. Its chrome - accent stripe, divider, background, sticky surface - runs to the shell edge, while the head *content* sits in the same centred content column as the page body below it. The column comes from `--page-inline-pad: max(var(--page-gutter), calc((100% - var(--content-max-width)) / 2))` applied to the direct children of a module root; no module root carries its own `max-width`. Previously each root capped itself at 1280px with the head inside that cap, so the accent stripe ended mid-surface and the modules had drifted onto four different head widths. Dashboard and Settings are the documented exceptions - they have no module head and keep their centred block. Guarded by `page-inline-pad contract holds across every stylesheet (#577)` in `test/test-frontend-audit.js`.
- **Navigation:** The persistent mobile bottom bar contains exactly five destinations: fixed Overview, three configurable favorites (default Calendar, Tasks, Kitchen), and fixed More. **Each icon carries its own module tone and the active tab takes the voice back (v2.20.0)** — the same legend the sidebar has carried since v2.2.0, and for the same reason; before that the bar was neutral throughout, so the legend was a desktop rule by accident and phones showed no module colour in the navigation at all. The tone sits on the bare glyph only: no seal in the capsule (the origin rule reserves that for places that answer "where from"), and the capsule, sliding indicator, labels, focus ring and FAB keep `--color-accent`. "More" is not a module and stays tertiary. Measured against the effective capsule ground (glass over page, `#F9F9FA` / `#2B2825`): light 4.79-6.81:1, dark 4.57-8.41:1, i.e. above the 4.5:1 text threshold, not merely the 3:1 for graphics. The active module supplies the colour of the 200 ms sliding indicator. That indicator is a capsule **behind the icon only**, sized and vertically aligned to the icon well, at most 64 px wide and inset from the slot edges (v1.45.12), so it never crops its own rounding against the bar edge in the first/last slot, never crosses the label baseline, and never reaches into the bottom safe area. The desktop sidebar uses the same glass surface and groups entries under localized headings — Overview (Dashboard), Plan (Calendar, Tasks, Notes), Home (Kitchen, Contacts, Birthdays, Budget, Documents, Housekeeping), and Custom modules when enabled third-party modules are loaded — with Settings pinned at the end. Ordering is user-specific and limited to each group. Custom monoline SVG icons are served from `public/nav-icons.js` (DOM API, no `innerHTML`); Lucide is the fallback. Kitchen and More keep stable visible labels/icons; active subsections use localized `aria-label`/`aria-current`. **The "More" sheet is one four-column grid (v2.14.2):** every module that is not in the bottom bar sits in a single flat launcher grid — no section headings, because the items already arrive sorted by section and the headings only labelled an order the grid has anyway, at the cost of roughly a whole tile row in height. Settings, Help, Changelog and Sign out share the last row of that same grid, kept monochrome against the coloured module seals; Sign out lost the full-width row it had held since the sheet's bottom edge moved above the tab bar, which is what made the original overlap with the More button impossible in the first place. Labels use the tab bar's recipe — Caption 2, two lines, `hyphens: auto` with `hyphenate-limit-chars: 6 4 4` so a German compound breaks as "Haushalts-hilfe" and never as "Haushaltshil-fe" — and reserve both lines, so grid rows stay flush regardless of which names land in them. Measured at 390x844 with eight modules: 735 px → 354 px, i.e. 87.1% → 41.9% of the viewport. **Collapsible sidebar (desktop only):** a toggle button collapses the sidebar to icon-only mode (56 px); state persists in `yuvomi.sidebar.collapsed`, and native title tooltips preserve discoverability.
- **Sub-tabs:** `public/utils/sub-tabs.js` renders the sticky pill-style bar used by Kitchen and Health. One look, **two semantics**, and the caller must declare which via the mandatory `semantics` option — there is no default, because a default is how the wrong variant spreads silently. `semantics: 'nav'` (Kitchen) builds a `<nav>` of real `<a href>` links with `aria-current="page"`: the four kitchen routes are four independent modules with their own `module:` value, so a click changes the module, and cmd/middle-click behave like anywhere else in the shell; arrow keys move focus only. `semantics: 'tabs'` (Health) builds a WAI-ARIA tablist — `role="tablist"`/`role="tab"`, `aria-selected`, roving tabindex, arrow keys activate — and wires `aria-controls`/`aria-labelledby` **only against panels the caller hands in** via `panelFor(id)`; without a resolved panel the attribute is omitted rather than pointing nowhere. `'tabs'` without `panelFor` throws. Until v1.87.0 the helper wrote `role="tab"` unconditionally and guessed panels via `[data-panel]`, an attribute the frontend guard forbids — ten tabs pointed at panels that never existed, four of them were module switches, and the panel sync was a no-op (audit 2026-08-08, P1-1). (Settings no longer uses sub-tabs; it has its own responsive shell — see the Settings section.)
- **Tablist behavior:** `public/utils/tablist.js` (`wireTablist`) is the shared WAI-ARIA tablist behavior — roving tabindex, arrow/Home/End keys, `aria-selected`/`aria-current` — for tab navs that live inside a module's `page-toolbar` rather than a standalone sub-tab bar (Budget, Rewards, Housekeeping, and the Calendar month/week/day/agenda view-switcher). It complements `sub-tabs.js` so every tab surface shares one interaction grammar (v0.94.0).
- **Transitions:** Directional slide-X animation on page change (forward = from right, back = from left, 200ms) with spring easing. Respects `prefers-reduced-motion`.
- **Empty states:** Consistent `.empty-state` class across all modules (icon + title + description, centered). Compact variant `.empty-state--compact` for meal slots and for section-level hints whose heading already carries the context. `public/utils/empty-state.js` enforces the composition (order, heading semantics of the title, ARIA role, call to action); it knows three variants - `empty` (no role, primary CTA), `no-results` (`role="status"`, reset CTA) and `error` (`role="alert"`, retry). **App-wide since v2.38.0:** the renderer was limited to the four kitchen tabs until then, and the remaining 15 pages assembled the markup by hand - 52 hand-rolled states, none of them carrying a role, 48 with a `<div>` where the title should be a heading. The renderer is the only place that may produce this markup, held by a guard over the whole frontend rather than an allow-list of files. It also serves callers that build template strings (`emptyStateHTML()`, deliberately `emptyStateEl(...).outerHTML` so no second composition can drift), a rarer two-way state (`actions`, plural), and a collapsible technical block (`details`) used by the global error screen. `mountLoadError()` stays the entry point for a failed load: it forces both a way out and the status code, and a load error must be checked **before** the empty branch - after a failure the collection is empty too, so only the order separates "nothing created" from "not loaded".
- **Failure state (v1.60.0):** `mountLoadError()` is the fourth state of any list, next to empty, filled and loading. There was a shared renderer for the first three and none for "failed", so a server error produced four different reactions across the kitchen: Shopping and Meals showed their **empty state including its creating CTA** (with 31 items and 28 planned meals actually stored), Pantry showed a correct error whose explanatory line rendered `[object Object]`, and Recipes tore the whole app into the global error screen. An empty state is the most harmful of those: it claims data loss and offers a writing action as the only way out. The renderer therefore forces two things a plain `variant: 'error'` did not — a retry action (a failure state without a way out is a dead end) and a technical line taken from the *error object*, never from a server text (`data.error` is an unlocalized English "Internal server error." on every route, while the status code is language-neutral and the one useful detail for a self-hoster). Loaders carry the failure into module state so the renderer can tell "nothing created yet" from "could not load"; the guard `die Küchen-Seiten zeigen bei einem Ladefehler den Fehlerzustand` in `test:frontend-audit` holds the order, because after a failure the collection is empty too.
- **Kitchen transfer (`public/utils/kitchen-transfer.js`, v1.62.0):** the one path out of a kitchen tab into a shopping list, shared by Pantry, Recipes and Meals. It owns the *check* and the *answer*, not just the text. Two states had drifted apart. **"There is no shopping list yet"** had four outcomes: two strings, two tones (`warning` in Pantry, `danger` in Recipes and Meals) and exactly one way out — Pantry's. Red claims something is broken, while a list that has not been created yet is a missing precondition; and in the meal modal the same sentence appeared a fourth time as a disabled `<option>` next to a button that did nothing, which is the worst of the four because it *looks* operable. Recipes also borrowed `meals.noShoppingLists`, so a refactor in Meals would have silently taken the recipe text with it. There is now one answer: `warning` tone, one `kitchen.*` key owned by the group rather than by one caller, and a button that goes to Shopping (dropped when the module is disabled, because a dead end is worse than none). `resolveShoppingTarget()` also does the one-vs-many list choice, so the whole precondition lives in one place. **Undo** existed only in Pantry, although all three are one-tap paths that create items in a list the user is not looking at — and Recipes moves the most at once, a whole ingredient list. All three now report through `announceTransfer()`: one toast duration (5 s, longer than the default because the toast carries an action), one refresh of the tab badges, and a real undo built on the `added_ids` the server returns. No delayed commit — the server skips duplicates, so only it knows the count the toast promises. Without ids the toast deliberately appears *without* an action rather than with a button that cannot undo anything. The rollback is one call, `POST /api/v1/shopping/items/undo-transfer`, in a single transaction: N individual deletes can half-fail, and the meal path additionally sets `meal_ingredients.on_shopping_list`, so deleting only the shopping items would leave those ingredients marked as transferred forever — neither on the list nor transferable again. Two guards in `test:frontend-audit` scan the **stock** rather than a file list: every `api.post` in `public/pages/` whose path ends in `to-shopping-list` or `import-*`, and every matching route handler in `server/routes/`. The two flows with their own confirmation dialog (Shopping's meal-plan import and its put-away into the Pantry) are named exceptions with their reason — there the dialog is the protection.
- **Toast gesture (`wireSwipeToDismiss` in `public/utils/ux.js`, #821):** the toast can be swiped away sideways, and it carries the app-wide "Undo" action. Both live in one helper because they collide: capturing the pointer on `pointerdown` also redirects the resulting `click` to the capturing element, so the action button never saw its own click - the undo was dead for mouse users in every module while keyboard and touch, which reach `click` by another route, kept working. The pointer is therefore captured only once the press has actually become a drag; below that threshold a button stays a button. Two conditions belong to the same gesture: `pointermove` fires with the button up as well, so movement is only read while a press is active (otherwise merely crossing the toast pushed it off-screen at `opacity: 0`), and `.toast` needs `touch-action: pan-y`, or the browser claims the horizontal swipe for scrolling and ends the pointer with `pointercancel` before the threshold is reached.
- **Modals:** Centered panel on desktop with glass overlay. On mobile (< 768px) bottom sheet - spring slide-in from below, sheet handle visible, swipe-to-close (> 80px downward). `focusin` scrolls inputs into view when the virtual keyboard is open. The modal lifecycle is managed as an explicit state machine (`idle → open → confirming → closing`) with encapsulated suspend/restore helpers, hardening the unsaved-changes confirmation against double-close and back-navigation races (v0.55.0). The same suspend/restore path also carries **`confirmOverModal()`**: a confirmation asked from *inside* a form modal parks the form instead of replacing it. Plain `confirmModal` runs through `openModal`, and that clears the active overlay with `force: true` — so the cancel path, the only reason to ask at all, destroyed the input without ever touching the dirty guard. Cancelling now returns the form untouched, dirty snapshot, Escape handler and focus included; confirming closes it with `force: true`, because the decision takes the input along anyway (the same rule as after a completed write). While the dialog is up the parked overlay is `inert` — the dialog's focus trap holds the tab focus but not the reading cursor — and its title id is set aside, because a duplicate `shared-modal-title` makes `aria-labelledby` resolve onto the form underneath, which had the confirmation announced with the form's heading. Modal titles and `selectModal` option labels are HTML-escaped centrally to prevent XSS from raw user data reused as modal headings.
- **Only the modal body scrolls (#805):** neither the panel nor the overlay may be a scroll box. `overflow: hidden` creates one that no reader can operate - it has no scrollbar - while the browser still scrolls it programmatically: Chrome calls `scrollIntoView` on every ancestor of a `<select>` when it opens one, which pushed the whole panel, title and close button included, off the screen with no way back. Both are clipped with `overflow: clip` instead, which is visually identical and creates no scroll box at all. The panel also carries `position: relative` **on the base rule** rather than only in the mobile media query, so it stays the containing block of its absolutely positioned descendants (the task form's `.sr-only` input) on every width. The first round (v2.21.1) fixed the panel alone and moved the fault one level up: above 768px the panel held that role only through the transform left behind by its entry animation, and `prefers-reduced-motion: reduce` removes it - the inflated scroll box (1259px inside a 700px viewport) reappeared on the overlay, with the same 507px shove and the same unreachable close button. `test:modal-utils` guards all four ends.
- **Destructive dialogs name what they destroy (v1.75.4):** In a self-hosted family instance there is neither support nor undo, so whoever does not read the consequence in the dialog never reads it at all. Every `confirmModal`/`confirmOverModal` marked `danger: true` therefore carries a `detail` naming the concrete outcome, not a second warning: what disappears, what stays, what is reversible. Deleting a budget account keeps its entries but nulls their account link; deleting a folder keeps the documents and drops them into the no-folder view; deleting a medication takes its schedule and the whole intake history along by cascade; disconnecting Google drops pending deletions, so those events stay behind in Google. The rule cuts the other way too: where nothing is irretrievably lost, `danger: true` is the bug. Rejecting a redemption request posts a `reversal` ledger entry and can be asked again while the reward is still active in the catalogue (`POST /redemptions` requires `is_active = 1`), so it is no longer painted red - colour that claims a finality the action does not have is as misleading as a missing consequence. Where that finality is real, it belongs to the act that caused it: deleting the reward carries its own `danger`. The guard in `test:frontend-audit` scans the **stock**: every dialog under `public/`, with the argument list read by bracket balancing rather than a fixed-length window. Both were real gaps in the first version (v1.40.x), which knew five files by name and read 320 characters per call: 25 dialogs stood without a consequence text, eight of them behind `confirmOverModal`, whose name does not contain the shorter one a naive scan looks for. The five original settings dialogs stay pinned by name on top, so removing `danger: true` cannot become the cheap way out of the rule. Shared components state their consequence per caller, never once for everyone: the category manager serves Budget, Tasks, Contacts, Shopping and Pantry, and their servers disagree - the first three reject an in-use category with 409, Shopping moves the items to the first remaining category (`ORDER BY sort_order ASC LIMIT 1`, not the neighbouring one), Pantry leaves them without a storage location. `configure()` therefore takes `deleteDetailKey` (plus `subDeleteDetailKey` where subcategories are on), and a second guard walks the callers in the stock rather than knowing them: whoever embeds the component supplies the text. The same class of bug had already appeared here once, when the shared "New category" placeholder showed up in the storage-location dialog.
- **Look first, edit second (`public/components/detail-view.js`, v1.70.0):** Tapping an appointment or a task opens a read-only view instead of the edit form. The old path raised the virtual keyboard over roughly 40 % of the screen for someone who only wanted to know when the dentist appointment is; tasks had no reading path at all, all five entry points ended in the form. The read view holds no input field, so the keyboard cannot open - a guarantee out of the structure, not a removed autofocus line. "Edit" in the header is a named intent and mounts the form only then. New entries still start in the form, because there typing *is* the intent, so the `pointer: coarse` redirection applies to the switch path only, never globally. Two presentations share one caller API: from 768px **and** with an anchor the view is a popover at the tapped chip, otherwise a bottom sheet over `openModal()`. The appointment view shows three things the old popup withheld - recurrence in plain language (`describeRRule()`), reminders and visibility - and a task's status can be advanced straight out of the read view instead of through a form with seven selects. `showEventPopup` and `.event-popup` are gone.
- **Detail view: what must not be undone (v1.70.0):** The form is mounted lazily and **stays in the DOM** on the way back, so re-entering "Edit" finds the input again; the header button therefore reads "Back", not "Done", because it switches views and saves nothing. A hidden form still counts towards the dirty check, which is why every footer action closes with `force: true` - otherwise "Delete" asked to discard fields the deleted record takes along anyway, and the status advance asked about a write that had already reached the server (the #625 rule from the other side; `closeDetailView({ force })` returns a promise so the caller can wait for the overlay slot before reusing it). Switching into the form awaits `edit.ready`: `saveEvent` reads the reminders out of the form rows and deletes the event's reminders when it finds none, so a form built before the response would lose them on save. Every view carries a token, and a late `update()` discards itself when its view is no longer the active one - otherwise a slow response writes the appointment from a moment ago into the card of now. The switch path runs `mount()` → `mountFooter()` → `refreshDirtySnapshot()` → `focusFirstField()` in exactly that order; a guard in `test:detail-view` holds it. The component is built to be adopted by the remaining modules without new architecture - documents and subscriptions are the clearest remaining wins after contacts (v1.72.0). `sections` takes plain row **descriptors** (`{icon, label, value}`, or `node` for anything that is not text) - `detailBodyEl` runs them through `detailRowEl` itself and drops every row without content, so callers need no conditionals for empty fields. Handing it ready-built elements looks right and fails silently: they arrive at `detailRowEl` as an options object with no `value` and no `node`, and the view renders its title and footer around an empty body. **Deliberately left out:** `interactive-widget=resizes-content` in the viewport meta. The default `resizes-visual` shrinks only the visual viewport and leaves CSS blind, so it is a real lever for the remaining forms - but one that has to be judged across all pages, while the read view solves the keyboard problem at its cause.
- **Contacts read first (v1.72.0):** Tapping a contact opened the edit form, while the chevron at the end of the row promised a detail view that did not exist. Both entry points now open the read view - the list row and the `?open=<id>` deep link from global search, where the hit is something you want to see before you change it. Creating a contact still starts in the form. No anchor is passed, so the view is a centred panel on the desktop too: addresses and several numbers do not fit the 320px of an anchored popover. The gain is larger than the detour saved. The list renders one legacy single value each from `contacts.phone/email/address`, so a contact with a work and a mobile number offered exactly one of them to tap although the second had long been stored in `contact_phones`. The read view carries every number, mail and address with its label, each its own tap target over `tel:`/`mailto:`/map. Organisation and job title arrive over CardDAV and had no display anywhere in the app until now, because the form does not manage them. Switching into the form awaits the single-contact fetch (`edit.ready`): `buildContactForm` reads the multi-value fields out of `contact.phones` and falls back to the legacy single without them, so a form built before the response would write back exactly one number on save and drop the rest. `buildContactForm` is split out of `openContactModal` for the same reason the calendar keeps `edit.standalone` - the identical form has to come into being in two places, and its wiring stays in the closure that owns the markup.
- **List animation:** Staggered spring fade-in on load (`stagger()` from `public/utils/ux.js`) - max 5 elements staggered (30ms gap), rest appear immediately.
- **Vibration:** `vibrate()` from `public/utils/ux.js` - short pulses for light actions (10-40ms), pattern `[30, 50, 30]` for destructive actions (delete). Respects `prefers-reduced-motion`.
- **Global search overlay:** Full-text search across tasks, calendar events, notes, contacts, and shopping items. Results are grouped by module and trigger deep-link navigation: contacts via `?open=<id>` (opens edit modal directly), calendar events via `?open=<id>`, notes via `?open=<id>`, shopping items via `?list=<id>&highlight=<id>` (activates the correct list tab and scrolls the item into view). Opened from the sidebar search item or the `/` shortcut on desktop and the More-Sheet search bar on mobile. The overlay is responsive: a full-screen bottom-sheet on mobile and a centred, top-anchored command-palette (~640px glass card over a blurred module scrim, mirroring the modal grammar) on desktop (≥768px). Before a query it shows an empty-state launcher whose tiles list the searchable areas (tasks, calendar, notes, contacts, shopping, health) and jump straight to the module; during the debounced fetch it shows a loading skeleton and announces progress and result count through an ARIA live region. The FTS5 index is diacritic-insensitive (`unicode61 remove_diacritics 2`, migration 77) and the query expands ß↔ss variants, so "muller"/"strasse" match "Müller"/"Straße". Calendar events are family-visible in search (not scoped to the creator), matching the calendar list. **Tags are part of the indexed text (migration v117, #586)** for tasks and shopping items — a tag is free text and therefore content, and the task list already filters by it, so the same word had to lead to a hit in both places. Because the tags live in their own tables while the existing triggers hang on `tasks`/`shopping_items` and only see that row, the index is maintained from both sides: the row triggers were widened, and `task_tags`/`shopping_item_tags` got triggers of their own, so a pure tag change reaches the index without the task being touched. **An index trigger deletes before it inserts (migration v151)**, so writing the same row twice cannot leave two entries behind. That is not belt-and-braces: SQLite gives no guarantee about the order of two `AFTER INSERT` triggers on one table (measured, it is reverse creation order), and `shopping_items` carries a second one — `trg_shopping_items_sort_order` (v133) updates the row it was just given whenever `sort_order` is 0, which is every insert the app makes. Running before the index trigger, its update wrote one entry and the insert trigger then added a second. It healed itself the moment anyone touched the item, since the update trigger clears by `(entity, entity_id)` and caught both — so the duplicates were exactly the freshly created, untouched items, and the per-kind cap of five delivered half of what it claimed. `(entity, entity_id)` is unique across the index, which is the assumption every update trigger already makes; v151 also drops the rows that had accumulated.
- **Calendar search (#471):** An in-context search bar in the calendar toolbar (magnifier button, or the `f` shortcut) finds appointments across the whole timeline — past and future — even when the date is unknown. Matches title, location, and notes/description via `GET /api/v1/calendar/search?q=` (same FTS5 index; event body indexes `location` since migration 76). Results render as a chronological, date-grouped list anchored on the next upcoming hit; recurring events resolve to their next occurrence within a two-year window rather than the series start. Selecting a result jumps to that day and opens the event. Result rows are keyboard-operable (`role="button"`, Enter/Space); the count line reports "N of M" when capped at 100.
- **PWA install prompt:** Appears only after 2 user interactions. Dismiss window 7 days; interaction counter resets after dismiss.
- **PWA offline and update contract (v0.71.34):** Service-worker shell, page, locale, and asset caches are keyed to the package release so every published UI revision installs fresh cache namespaces. The early `/lang-init.js` locale/direction bootstrap is part of the offline shell. When the network is unreachable and `index.html` is not cached, the worker serves `/offline.html` with a reload button. **Precache completeness (v1.64.1):** the precache covers the full static import graph, not just the entry modules - every `/utils/*` and `/components/*` module a page imports is listed alongside it, so an update never installs a page module without the modules it is built against. Precache bucket and fetch routing come from the same lists (`APP_SHELL` → `SHELL_CACHE`, `PAGE_MODULES` → `PAGES_CACHE`); `test:sw-precache` walks the graph and fails on any gap.
- **No page loads across a version boundary (v1.64.1, #616):** a browser keeps one module map per document, so a module loaded once stays bound for the life of that document. If a tab is open while the server is updated, a freshly fetched page module would bind against the already-loaded, older shared modules, and an export added in the new version surfaces as `SyntaxError: does not provide an export named …`. Once an update is announced (`SW_UPDATED`), the router therefore stops importing page modules and prefetching module graphs entirely and resolves the next navigation into a reload instead. A dynamic import that fails with a module-binding error triggers the same reload as a fallback, guarded by a 30-second `sessionStorage` marker so a genuine bug cannot loop.
- **Read-only offline data (v0.78.8):** The service worker network-first-caches a whitelist of read-only `GET /api/v1/*` data paths (calendar, tasks, shopping, contacts, dashboard) in a release-keyed `yuvomi-api-<version>` cache, so the last-seen data stays viewable offline. Mutations, `/auth/*`, and non-whitelisted GETs are never cached; state-changing requests that fail offline surface a clear "changes aren't possible while offline" message instead of a raw network error. The calendar shows a subtle "Offline – as of: {time}" banner (from the cached `x-cached-at` timestamp) when served from cache. The API cache is wiped on logout and session expiry (`CLEAR_API_CACHE` message) so a second user on the same device cannot see the previous user's cached data, and every cache that does not belong to the running release is purged on SW activation — previous `yuvomi-*` versions as well as the legacy `oikos-*` caches from before the rename.
- **User-selected note colors (v0.71.34):** note titles, content, creator metadata, and fallback avatars choose black or white ink from WCAG relative luminance instead of a brightness heuristic; supporting text remains fully opaque so every built-in note color meets AA contrast.

### Breakpoints
Four canonical, structural thresholds, declared as `--bp-*` in `tokens.css` (§11c) and enforced by a guard in `test:frontend-audit` — every `@media` width in the stylesheets must be one of these or its complement:
- Mobile: ≤ 639px (1 column, bottom nav)
- Tablet: 640–767px (portrait tablet; the `min-width: 768px` complement)
- Desktop: ≥ 1024px (sidebar + content, multi-column)
- Wide: ≥ 1440px (optional wide-desktop tuning)

**The boundary belongs to the larger side:** upward `min-width: 640px`, downward `max-width: 639px`. A `max-width` written on the canonical value itself makes both halves of a pair apply at that exact width — measured at 640px, the mobile compaction rules and the three-column board applied together. `test:typography` rejects a `max-width` on any of the four values inside a `@media` prelude (element widths are not thresholds and are not its business), and the guard in `test:frontend-audit` compares JavaScript `matchMedia` calls against the CSS as *thresholds with a direction* rather than as bare numbers, so a script cannot switch at 640 while its stylesheet switches at 639.

Component-internal reflow — a card or form grid that changes its column count based on its *own* width — belongs in a `@container` query or a fluid `clamp()` value, not in a new viewport breakpoint. Otherwise a component reflows differently depending on which module hosts it.

### Focus Ring (v1.60.0)
One specification, declared as `--focus-ring-*` in `tokens.css` (§7b) and enforced by a guard in `test:frontend-audit`: the colour is the app's voice (`--color-accent`), so a keyboard user sees one ring everywhere. **It followed the active module accent until v2.2.0** - which meant this single token, on which every focusable element in the app hangs, was the largest single place where the module tone reached the chrome. Previously there were six — two competing base rules (`reset.css` set 2px/offset 2px, `glass.css` raised the offset to 3px globally) plus around 45 component rules over them, half of which read the module accent and half the app accent. Tabbing through the shopping list alternated purple → orange → purple → orange; a colour change reads as a context change where there is none.

- `--focus-ring-width` / `--focus-ring-color` / `--focus-ring-offset`, plus `--focus-ring-offset-inset` for elements on a clipped edge (`overflow: hidden` on an ancestor cuts a positive offset).
- **No shorthand token.** Custom properties resolve where they are *declared*; a combined `--focus-ring` on `:root` would bake in the root colour and make local overrides silently ineffective.
- **Justified exceptions override `--focus-ring-color` only** and keep reading width and offset from the tokens: the FAB (accent-coloured itself, so it inverts to a light ring plus an accent halo), account rows and colour swatches in Budget, meal slots on the dashboard, and danger buttons. The bottom-nav exception is gone with v2.2.0: a ring that changes colour per tab turns one keyboard affordance into five.
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
