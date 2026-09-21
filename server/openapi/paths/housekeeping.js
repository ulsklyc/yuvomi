import { op, jsonBody, idParam } from '../helpers.js';

const VISIT_CAPABILITY_NOTE = 'Each visit carries `can_edit` and `can_delete`: true when the caller may write to the Housekeeping module and the visit is either unpaid or the caller is an admin '
  + '(a paid visit is settled), `can_mark_paid`: true when the caller may write and the visit is unpaid, and `can_mark_unpaid`: true when the visit is paid and the caller is an admin. '
  + 'Write access means both the member module permission and, for API tokens, a `housekeeping:write` scope. '
  + 'They are hints for the interface; `PUT`/`DELETE /api/v1/housekeeping/visits/{id}` and `POST .../unpay` check the role themselves.';

// `last_completed` ist ein Zeitpunkt; ein Offset wird der UTC-Instant (#1364).
const LAST_COMPLETED_INPUT = '`last_completed` with `Z` or a numeric offset is read as an instant and stored as a UTC '
  + 'instant (`YYYY-MM-DDTHH:MM:SS.sssZ`), the same form `/complete` writes. A value without offset is household '
  + 'wall-clock time and is read in the household time zone. Up to v2.68.0 the offset was dropped and its digits '
  + 'kept, and a value without offset was read in the time zone of the server.';

export function housekeepingPaths() {
  return {
    '/api/v1/housekeeping/dashboard': {
      get: op({ summary: 'Get housekeeping dashboard', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/task-templates': {
      get: op({ summary: 'List housekeeping task templates', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/worker': {
      get: op({ summary: 'Get primary housekeeper profile', tag: 'Housekeeping' }),
      post: op({ summary: 'Create or update housekeeper profile', tag: 'Housekeeping', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/workers': {
      get: op({ summary: 'List housekeeper profiles', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/summary': {
      get: op({ summary: 'Get monthly housekeeping summary', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/work-sessions': {
      get: op({ summary: 'List housekeeping work sessions for a month', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/work-sessions/check-in': {
      post: op({ summary: 'Check in a housekeeper', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/work-sessions/check-out': {
      post: op({ summary: 'Check out a housekeeper', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/visits': {
      get: op({ summary: 'List housekeeping visits for a month', tag: 'Housekeeping', description: VISIT_CAPABILITY_NOTE }),
    },
    '/api/v1/housekeeping/visits/{id}': {
      get: op({ summary: 'Get housekeeping visit', tag: 'Housekeeping', params: [idParam()], description: VISIT_CAPABILITY_NOTE }),
      put: op({ summary: 'Update housekeeping visit', tag: 'Housekeeping', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete housekeeping visit', tag: 'Housekeeping', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/housekeeping/visits/{id}/pay': {
      post: op({ summary: 'Mark housekeeping visit as paid', tag: 'Housekeeping', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/housekeeping/visits/{id}/unpay': {
      post: op({
        summary: 'Take back the payment of a housekeeping visit',
        description: 'Clears `paid_at` and reopens a linked payment task that is done. A visit that is not paid is returned unchanged.',
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
