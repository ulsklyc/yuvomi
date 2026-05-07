# Housekeeping Design

## Goal

Housekeeping adds a simplified mobile/PWA module for the cleaner workflow in Oikos. It keeps the existing private-network, authenticated-session security model and exposes no public endpoints.

## User Experience

The `/housekeeping` route is a focused module that follows the same toolbar, tab, card, and chip patterns used by the rest of Oikos:

- **Dashboard**: staff-specific check-in/check-out actions, visits this month, last visit, pending/finished chores, pending payments, and a compact monthly payment chart.
- **Tasks**: suggested chore templates, custom chore creation, urgency-sorted recurring tasks, and one-tap completion.
- **Reports**: camera upload plus text description for maintenance occurrences.
- **Staff**: one or more housekeeper people, contact data, profile pictures, daily rates, and payment schedules.

Accessibility constraints:

- Primary actions are at least 44px high.
- Check-in/out is a compact top-toolbar action, matching the small action pattern used elsewhere in the app.
- Status is communicated by text and color, not color alone.
- Inputs and buttons have explicit labels or accessible names.
- Icons use the locally bundled Lucide runtime; no external CDN is introduced.

## Data Model

### `housekeeping_work_sessions`

Stores point/finance records:

- `id`
- `worker_id`
- `check_in`
- `check_out`
- `daily_rate`
- `extras`
- `calendar_event_id`
- `created_by`
- `created_at`
- `updated_at`

Monthly amount is calculated as `SUM(daily_rate + extras)` for sessions whose `check_in` belongs to the requested month.
Each check-in creates a linked local calendar event for the selected staff member. Check-out updates that event end time.

### `housekeeping_decay_tasks`

Stores dynamic recurring cleaning tasks:

- `id`
- `name`
- `area`
- `frequency_days`
- `last_completed`
- `created_by`
- `created_at`
- `updated_at`

Urgency is computed at read time:

```text
urgency = (now - last_completed) / frequency_days
```

Status mapping:

- `overdue`: due date is before today.
- `today`: due date is today.
- `ok`: due date is in the future.

Rows with no `last_completed` are treated as overdue.

### `housekeeping_supply_requests`

Stores quick supply requests and links each request to an Oikos shopping item:

- `id`
- `name`
- `quantity`
- `shopping_item_id`
- `created_by`
- `created_at`

The supply request transaction always appends an item to the main `shopping_items` table. If no shopping list exists, the backend creates a private authenticated list named `Housekeeping`.

### `housekeeping_maintenance_log`

Stores maintenance occurrences:

- `id`
- `description`
- `photo_url`
- `created_by`
- `created_at`
- `updated_at`

`photo_url` accepts self-contained `data:image/png|jpeg|webp;base64,...` values only, keeping uploaded camera photos inside the authenticated Oikos database boundary.

### `housekeeping_workers`

Stores housekeeper-specific employment/payment settings while keeping the person unified with Oikos user/contact/birthday data:

- `id`
- `user_id`
- `daily_rate`
- `payment_schedule`
- `calendar_color`
- `notes`
- `created_at`
- `updated_at`

The linked `users` row is excluded from normal Family Management and Family APIs through the `housekeeping_workers` association, but remains synchronized with contacts and birthdays.
Multiple housekeepers can be registered; each has its own linked `users` row.
`calendar_color` controls the default color used for housekeeping visit events. Visit events use the cleaning icon (`sparkles`).

## REST API

All endpoints are mounted under `/api/v1/housekeeping` and inherit the existing `requireAuth` and CSRF middleware.

- `GET /summary?month=YYYY-MM`
- `GET /dashboard`
- `GET /task-templates`
- `GET /worker`
- `GET /workers`
- `POST /worker`
- `GET /work-sessions?month=YYYY-MM`
- `POST /work-sessions/check-in`
- `POST /work-sessions/check-out`
- `GET /decay-tasks`
- `POST /decay-tasks`
- `PATCH /decay-tasks/:taskId`
- `POST /decay-tasks/:taskId/complete`
- `DELETE /decay-tasks/:taskId`
- `POST /supply-requests`
- `GET /maintenance-log`
- `POST /maintenance-log`
