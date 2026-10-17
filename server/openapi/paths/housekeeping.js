import { op, jsonBody, idParam } from '../helpers.js';

const VISIT_CAPABILITY_NOTE = 'Each visit carries `can_edit` and `can_delete`: true when the caller may write to the Housekeeping module and the visit is either unpaid or the caller is an admin '
  + '(a paid visit is settled), `can_mark_paid`: true when the caller may write, may see amounts and the visit is unpaid, and `can_mark_unpaid`: true when the visit is paid and the caller is an admin. '
  + 'Write access means both the member module permission and, for API tokens, a `housekeeping:write` scope. '
  + 'They are hints for the interface; `PUT`/`DELETE /api/v1/housekeeping/visits/{id}` and `POST .../unpay` check the role themselves. '
  + 'The visit list and report also carry `receipt_document_name`. ';

// Beleg-Felder an jeder Sitzung (#1358): ein Urteil fuer Name und ID.
const RECEIPT_NOTE = 'Every visit or work session carries `has_receipt` (whether a receipt is linked); it is `null` without access to the '
  + 'Documents module (for API tokens a `documents:read` scope), so the visit does not even say that it has one. `receipt_document_id` '
  + '(and, where present, `receipt_document_name`) are set only when the caller may read that document: access to the Documents '
  + 'module, for API tokens a `documents:read` scope, and the document\'s own visibility. Otherwise both are `null`.';

const RECEIPT_WRITE_NOTE = '`receipt_document_id` links a receipt. A caller who cannot see the stored receipt keeps it: '
  + '`null`, an empty value or leaving the field out changes nothing, and any id - the stored one included - is refused with the same 403. A new link needs '
  + 'access to the Documents module (for API tokens a `documents` scope), otherwise 403; a document the caller cannot see is '
  + 'not linked. A caller who can see the stored receipt may clear it with `null`.';

// Der Tag der Haushaltshilfe (#1556): die Haushaltszone vor jeder Angabe des Clients.
const HOUSEHOLD_DAY_NOTE = ' The household day decides `today_session` and the date of the calendar entry and payment task of a check-in. '
  + 'With a household time zone set, that zone decides and client values are ignored. Otherwise the optional `timezone` (IANA name, query or body) '
  + 'the client displays in decides, then the time zone of the server. Clients that send no `timezone` may still send `local_date` with '
  + '`timezone_offset_minutes`; up to v2.69.1 these decided even with a household time zone set.';

// Betraege nur mit `housekeeping_view_amounts` (R20).
const AMOUNTS_NOTE = ' Wages, payments and amounts need the `housekeeping_view_amounts` capability (the default for every account; new '
  + 'child accounts start without it). Without it every amount field is `null` - `daily_rate`, `hourly_rate`, `extras`, `total_amount`, '
  + '`totals`, `paid_at`, `payment_task_id`, `payment_task_status`, `payment_task_title`, `default_daily_rate`, the summary totals, '
  + '`pending_payments`, `paid_this_month` and `monthly_payments` - while visits, times and people stay. ';

const PAYMENT_TASK_NOTE = ' The payment task names the wage: it is created with visibility `assignees`, assigned to the caller when they hold '
  + '`housekeeping_view_amounts` and to every active admin; for a caller without it the first admin is its creator. '
  + 'An older payment task still on `all` moves to the same rule when its visit is updated, checked out, paid or unpaid. '
const AMOUNTS_WRITE_NOTE = ' A caller without `housekeeping_view_amounts` writes no amounts: a check-in takes the rate from the profile, '
  + 'check-out keeps the extras, an update keeps rate, extras and minutes, and payment task texts fall back to the household language. '
  + 'Paying and taking back a payment are refused with 403 and `reason: amounts_hidden`.';

// `last_completed` ist ein Zeitpunkt; ein Offset wird der UTC-Instant (#1364).
const LAST_COMPLETED_INPUT = '`last_completed` with `Z` or a numeric offset is read as an instant and stored as a UTC '
  + 'instant (`YYYY-MM-DDTHH:MM:SS.sssZ`), the same form `/complete` writes. A value without offset is household '
  + 'wall-clock time and is read in the household time zone. Up to v2.68.0 the offset was dropped and its digits '
  + 'kept, and a value without offset was read in the time zone of the server.';

export function housekeepingPaths() {
  return {
    '/api/v1/housekeeping/dashboard': {
      get: op({ summary: 'Get housekeeping dashboard', tag: 'Housekeeping', description: RECEIPT_NOTE + AMOUNTS_NOTE + HOUSEHOLD_DAY_NOTE }),
    },
    '/api/v1/housekeeping/task-templates': {
      get: op({ summary: 'List housekeeping task templates', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/worker': {
      get: op({ summary: 'Get primary housekeeper profile', tag: 'Housekeeping', description: RECEIPT_NOTE + AMOUNTS_NOTE + HOUSEHOLD_DAY_NOTE }),
      post: op({ summary: 'Create or update housekeeper profile', tag: 'Housekeeping', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/workers': {
      get: op({ summary: 'List housekeeper profiles', tag: 'Housekeeping', description: 'Next to `data`, `can_manage` is true when the caller may create and edit profiles (`POST /housekeeping/worker`): write access to the module and the admin role. ' + RECEIPT_NOTE + AMOUNTS_NOTE + HOUSEHOLD_DAY_NOTE }),
    },
    '/api/v1/housekeeping/summary': {
      get: op({ summary: 'Get monthly housekeeping summary', tag: 'Housekeeping', description: RECEIPT_NOTE + AMOUNTS_NOTE }),
    },
    '/api/v1/housekeeping/work-sessions': {
      get: op({ summary: 'List housekeeping work sessions for a month', tag: 'Housekeeping', description: RECEIPT_NOTE + AMOUNTS_NOTE }),
    },
    '/api/v1/housekeeping/work-sessions/check-in': {
      post: op({ summary: 'Check in a housekeeper', tag: 'Housekeeping', description: HOUSEHOLD_DAY_NOTE.trim() + PAYMENT_TASK_NOTE + AMOUNTS_WRITE_NOTE, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/work-sessions/check-out': {
      post: op({ summary: 'Check out a housekeeper', tag: 'Housekeeping', description: AMOUNTS_WRITE_NOTE.trim(), stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/visits': {
      get: op({ summary: 'List housekeeping visits for a month', tag: 'Housekeeping', description: VISIT_CAPABILITY_NOTE + RECEIPT_NOTE + AMOUNTS_NOTE }),
    },
    '/api/v1/housekeeping/visits/{id}': {
      get: op({ summary: 'Get housekeeping visit', tag: 'Housekeeping', params: [idParam()], description: VISIT_CAPABILITY_NOTE + RECEIPT_NOTE + AMOUNTS_NOTE }),
      put: op({
        summary: 'Update housekeeping visit',
        tag: 'Housekeeping',
        params: [idParam()],
        description: RECEIPT_WRITE_NOTE + AMOUNTS_WRITE_NOTE,
        stateChanging: true,
        documentDeleteConflict: true,
        requestBody: jsonBody(null),
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({ summary: 'Delete housekeeping visit', tag: 'Housekeeping', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/housekeeping/visits/{id}/pay': {
      post: op({ summary: 'Mark housekeeping visit as paid', tag: 'Housekeeping', params: [idParam()], description: 'Needs `housekeeping_view_amounts`; without it 403 with `reason: amounts_hidden`.', stateChanging: true }),
    },
    '/api/v1/housekeeping/visits/{id}/unpay': {
      post: op({
        summary: 'Take back the payment of a housekeeping visit',
        description: 'Clears `paid_at` and reopens a linked payment task that is done. A visit that is not paid is returned unchanged. Needs `housekeeping_view_amounts`; without it 403 with `reason: amounts_hidden`.',
        tag: 'Housekeeping',
        admin: true,
        params: [idParam()],
        stateChanging: true,
      }),
    },
    '/api/v1/housekeeping/decay-tasks': {
      get: op({ summary: 'List housekeeping decay tasks', tag: 'Housekeeping' }),
      post: op({ summary: 'Create housekeeping decay task', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null), description: LAST_COMPLETED_INPUT }),
    },
    '/api/v1/housekeeping/decay-tasks/{taskId}': {
      patch: op({ summary: 'Update housekeeping decay task', tag: 'Housekeeping', params: [idParam('taskId', 'Decay task ID')], stateChanging: true, requestBody: jsonBody(null), description: LAST_COMPLETED_INPUT }),
      delete: op({ summary: 'Delete housekeeping decay task', tag: 'Housekeeping', params: [idParam('taskId', 'Decay task ID')], stateChanging: true }),
    },
    '/api/v1/housekeeping/decay-tasks/{taskId}/complete': {
      post: op({ summary: 'Mark housekeeping decay task complete', tag: 'Housekeeping', params: [idParam('taskId', 'Decay task ID')], stateChanging: true }),
    },
    // Der Pfad sagt `housekeeping`, geschrieben wird in den Einkauf - also
    // steht auch die 403 ausgeschrieben, wie bei /meals/{id}/to-shopping-list
    // (#1351, Regel aus #1290).
    '/api/v1/housekeeping/supply-requests': {
      post: op({
        summary: 'Create housekeeping supply request and shopping item',
        tag: 'Housekeeping',
        description: 'Creates a shopping item, and a shopping list when the household has none yet, so it requires write access to the `shopping` module in addition to `housekeeping` - a credential scoped to housekeeping alone is refused with 403.',
        stateChanging: true,
        requestBody: jsonBody(null),
        responses: {
          201: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/housekeeping/maintenance-log': {
      get: op({ summary: 'List housekeeping maintenance log entries', tag: 'Housekeeping' }),
      post: op({ summary: 'Create housekeeping maintenance log entry', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null) }),
    },
  };
}
