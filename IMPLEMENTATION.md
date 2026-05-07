# Housekeeping Implementation

## Backend

The module is implemented in `server/routes/housekeeping.js` and registered in `server/index.js` under:

```text
/api/v1/housekeeping
```

The registration happens after the global authenticated `/api/v1` middleware, so the module follows the existing Oikos security model:

- Session or API-token authentication required.
- CSRF required for state-changing session requests.
- API rate limiting inherited from `/api/`.
- No unauthenticated housekeeping route.

Database schema is migration `33` in `server/db.js`. The migration creates:

- `housekeeping_work_sessions`
- `housekeeping_decay_tasks`
- `housekeeping_supply_requests`
- `housekeeping_maintenance_log`

The quick supply endpoint uses a SQLite transaction:

1. Resolve the first existing shopping list, or create `Housekeeping`.
2. Insert a `shopping_items` row.
3. Insert a `housekeeping_supply_requests` row linked to the shopping item.

If any step fails, the transaction rolls back.

## Frontend

The SPA route `/housekeeping` is registered in `public/router.js` and loads:

- `public/pages/housekeeping.js`
- `public/styles/housekeeping.css`

The page uses the existing API wrapper in `public/api.js`, so CSRF tokens and auth expiry behavior remain centralized.

The UI intentionally avoids `innerHTML`; rendering uses `replaceChildren()` and `insertAdjacentHTML()` with escaped dynamic values.

## Localization

The module adds:

- `nav.housekeeping`
- `housekeeping.*`

to every JSON locale under `public/locales`.

Portuguese is the primary text for the cleaner-facing target workflow, with localized strings for the most common existing languages and English fallback text for remaining locales.

## Validation

Backend validation covers:

- Required strings and max lengths.
- Positive integer `frequency_days`.
- Non-negative `daily_rate` and `extras`.
- `YYYY-MM` month filters.
- Maintenance photos limited to PNG, JPEG, or WebP data URLs under 6 MB.

## Manual Use

1. Navigate to `/housekeeping`.
2. On **Home**, set the daily rate and press the large check-in button.
3. Use **Faltou Produto** to append missing supplies to the shopping list.
4. On **Tarefas**, create recurring cleaning tasks with name, area, and frequency in days.
5. Tap the large check icon on a task to update `last_completed`.
6. On **Reportar**, take/upload a photo and submit a maintenance description.
