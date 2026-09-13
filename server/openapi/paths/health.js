import { op, jsonBody, idParam } from '../helpers.js';

export function healthPaths() {
  const instant = { type: 'string', format: 'date-time', pattern: '(Z|[+-][0-9]{2}:[0-9]{2})$', description: 'ISO instant with explicit offset; writes cannot be in the future.' };
  const goal = { type: 'integer', nullable: true, minimum: 60, maximum: 20160, multipleOf: 60 };
  const revision = { type: 'integer', minimum: 1 };
  const recordFields = { start_at: instant, end_at: { ...instant, nullable: true }, start_tzid: { type: 'string', description: 'Runtime-supported IANA zone captured on creation and retained by ordinary edits.' }, goal_minutes: goal, rating: { type: 'integer', nullable: true, minimum: 1, maximum: 5 }, note: { type: 'string', nullable: true, maxLength: 2000 }, visibility: { type: 'string', enum: ['private', 'family'] } };
  const fastingBody = (properties, required = [], mandatory = true) => ({ required: mandatory, content: { 'application/json': { schema: { type: 'object', properties, required } } } });
  const userParam = { name: 'user_id', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'Defaults to the signed-in user. Family visibility and explicit caregiver grants apply.' };
  const dates = ['from', 'to'].map((name) => ({ name, in: 'query', required: false, schema: { type: 'string', format: 'date', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }, description: 'Inclusive completion date in each record\'s captured start_tzid; from must not exceed to.' }));
  const historyParams = [userParam, ...dates, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 } }, { name: 'before_at', in: 'query', schema: instant, description: 'Pass together with before_id from next_cursor.' }, { name: 'before_id', in: 'query', schema: revision, description: 'Pass together with before_at.' }];
  const fastingResponses = (status = 200, description = 'Successful response') => ({
    [status]: { description }, 400: { description: 'Invalid timestamp, zone, goal, date range, cursor, revision or other input.' },
    401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' },
    404: { description: 'FASTING_NOT_FOUND: record does not exist.' },
    409: { description: 'Numeric code: 409; reason: FASTING_REVISION_CONFLICT, FASTING_ACTIVE_EXISTS, FASTING_OVERLAP, FASTING_ALREADY_FINISHED or FASTING_ACK_REQUIRED. Revision/overlap conflicts may include current record.', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'integer', enum: [409] }, reason: { type: 'string' }, current: { type: 'object' } } } } } },
    500: { $ref: '#/components/responses/InternalServerError' },
  });
  const booleanPreference = { oneOf: [{ type: 'boolean' }, { type: 'integer', enum: [0, 1] }, { type: 'string', enum: ['0', '1'] }] };
  return {
    '/api/v1/health/vitals': {
      get: op({ summary: 'List vital measurements', tag: 'Health', description: 'Scoped to the viewer; `?user_id=` filters to a family member (only their `family`-visible rows). Optional `type`, `from`, `to` filters.' }),
      post: op({ summary: 'Create a vital measurement', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/vitals/{id}': {
      patch: op({ summary: 'Update a vital measurement', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a vital measurement', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications': {
      get: op({ summary: 'List medications', tag: 'Health', description: 'Scoped to the viewer; `?user_id=` and `?active=` filters supported.' }),
      post: op({ summary: 'Create a medication', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/medications/{id}': {
      patch: op({ summary: 'Update a medication', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a medication', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/schedules': {
      get: op({ summary: 'List a medication\'s intake schedules', tag: 'Health', params: [idParam()] }),
      post: op({ summary: 'Add an intake schedule to a medication', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/schedules/{id}': {
      patch: op({ summary: 'Update an intake schedule', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an intake schedule', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/logs': {
      get: op({ summary: 'List a medication\'s dose log', tag: 'Health', params: [idParam()], description: 'Optional `from`/`to` filters on `scheduled_at`.' }),
      post: op({ summary: 'Add a dose-log entry', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/logs/{id}': {
      patch: op({
        summary: 'Correct a dose-log entry',
        tag: 'Health',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { status?, taken_at?, dose_qty?, note? } (#701). `status: "pending"` undoes a take or a skip. The timestamp travels with the status rather than beside it: anything other than `taken` clears `taken_at`, because a dose that was not taken cannot carry a time it was taken at - and that entry would end up in the CSV export too. Restricted to the owner of the medication.',
      }),
      delete: op({
        summary: 'Delete a dose-log entry',
        tag: 'Health',
        params: [idParam()],
        stateChanging: true,
        description: 'Only for entries without a schedule, so ad-hoc and as-needed doses (#701). A scheduled entry answers `409`: the scheduler would recreate it on its next run, so deleting it would look like a success and be a return on the instalment plan. Undo it with `PATCH { status: "pending" }` instead.',
      }),
    },
    '/api/v1/health/logs/{id}/take': {
      post: op({ summary: 'Mark a dose as taken', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/logs/{id}/skip': {
      post: op({ summary: 'Mark a dose as skipped', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/labs': {
      get: op({ summary: 'List lab reports (with results)', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Create a lab report with analyte results', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/labs/{id}': {
      get: op({ summary: 'Get a lab report (with results)', tag: 'Health', params: [idParam()] }),
      patch: op({ summary: 'Update lab report header fields', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a lab report', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/labs/{id}/results': {
      post: op({ summary: 'Add an analyte result to a lab report', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/results/{id}': {
      delete: op({ summary: 'Delete an analyte result', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/activities': {
      get: op({ summary: 'List activities', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `type`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Create an activity', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/activities/{id}': {
      patch: op({ summary: 'Update an activity', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an activity', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/export/vitals': {
      get: op({ summary: 'Export vital measurements as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/activities': {
      get: op({ summary: 'Export activities as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/labs': {
      get: op({ summary: 'Export lab reports (one row per analyte) as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/meds-logs': {
      get: op({ summary: 'Export medication dose logs as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/fasting': {
      get: op({ summary: 'List completed fasts', tag: 'Health', params: historyParams, responses: fastingResponses(), description: 'Alias of /fasting/history. Returns data, has_more and next_cursor, ordered by start_at DESC, id DESC.' }),
      post: op({ summary: 'Start or backfill a fast', tag: 'Health', stateChanging: true, responses: fastingResponses(201), requestBody: fastingBody({ ...recordFields, user_id: revision, acknowledge_safety: { type: 'boolean', description: 'true explicitly acknowledges the first-use safety information.' } }, ['start_at', 'start_tzid']), description: 'Omitted/null end_at creates an active fast. At most one active row per person; intervals cannot overlap. Owner or explicitly granted caregiver with both fasting capabilities and Health write access.' }),
    },
    '/api/v1/health/fasting/state': {
      get: op({ summary: 'Get fasting timer state', tag: 'Health', params: [userParam], responses: fastingResponses(), description: 'Active fast, settings, acknowledged, canWrite (owner/caregiver relationship), display_tzid and first ten completed records; history_has_more/history_next_cursor continue through /fasting/history. Health module write access is additionally required for mutations. Ungranted family readers receive null settings and acknowledged. Display zone follows household settings.' }),
    },
    '/api/v1/health/fasting/history': {
      get: op({ summary: 'List fasting history', tag: 'Health', params: historyParams, responses: fastingResponses(), description: 'Returns data, has_more and next_cursor (cursor object or null). Ordered by start_at DESC, id DESC. Date filters select recorded-zone completion dates; malformed/reversed ranges return 400 FASTING_DATE_RANGE_INVALID. Visibility applies on every page.' }),
    },
    '/api/v1/health/fasting/stats': {
      get: op({ summary: 'Get fasting statistics', tag: 'Health', params: [userParam], responses: fastingResponses(), description: 'Completed records only: allTime/year/last30Days summaries, currentStreak/longestStreak, display_tzid, today and seven weekly buckets {date,count,totalMinutes,goalMinutes,goalCount,hasRecord}. Captured non-null goals are summed. Missing days have hasRecord=false and goalMinutes=null. Calendar windows use household display-zone today; completion dates use each captured record zone.' }),
    },
    '/api/v1/health/fasting/settings': {
      get: op({ summary: 'Get fasting settings', tag: 'Health', params: [userParam], responses: fastingResponses(), description: 'Settings or null for an ungranted family reader.' }),
      put: op({ summary: 'Update fasting settings', tag: 'Health', params: [userParam], responses: fastingResponses(), description: 'Sparse personal settings. Caregivers may submit only user_id and acknowledge_safety. clock_mode is stored per user in sync_config. Supplying active_id (null if none) with a default_goal_minutes change also changes that active goal atomically; a matching active row requires expected_revision. Without active_id only the default changes. Completed records remain unchanged. Notification preferences are retained when unavailable; reconciliation is transactional.', stateChanging: true, requestBody: fastingBody({ user_id: revision, default_goal_minutes: goal, zone_mode: { type: 'string', enum: ['timer', 'educational'] }, clock_mode: { type: 'string', enum: ['auto', 'elapsed', 'remaining'] }, acknowledge_safety: { type: 'boolean' }, active_id: { ...revision, nullable: true }, expected_revision: revision, remind_goal: booleanPreference, remind_next_start: booleanPreference }) }),
    },
    '/api/v1/health/fasting/acknowledge-safety': {
      post: op({ summary: 'Acknowledge fasting safety information', tag: 'Health', params: [userParam], stateChanging: true, responses: fastingResponses(), requestBody: fastingBody({ user_id: revision }, [], false) }),
    },
    '/api/v1/health/fasting/{id}': {
      patch: op({ summary: 'Edit or reopen a fasting record', tag: 'Health', params: [idParam()], stateChanging: true, responses: fastingResponses(), description: 'end_at:null reopens the same record; interval and active-row constraints apply. Ownership cannot be reassigned.', requestBody: fastingBody({ ...recordFields, expected_revision: revision }, ['expected_revision']) }),
      delete: op({ summary: 'Delete a fasting record', tag: 'Health', params: [idParam(), { name: 'expected_revision', in: 'query', required: false, schema: revision }], stateChanging: true, responses: fastingResponses(204, 'Deleted; no response body.'), description: 'expected_revision is required in either the query or JSON body. A non-null body value takes precedence.', requestBody: fastingBody({ expected_revision: revision }, [], false) }),
    },
    '/api/v1/health/fasting/{id}/finish': {
      post: op({ summary: 'Finish an active fast', tag: 'Health', params: [idParam()], stateChanging: true, responses: fastingResponses(), description: 'Persists the end immediately; end_at defaults to server now when omitted. Requires an active row.', requestBody: fastingBody({ expected_revision: revision, end_at: instant }, ['expected_revision']) }),
    },
    '/api/v1/health/export/fasting': {
      get: op({ summary: 'Export fasting history as CSV', tag: 'Health', params: [userParam, ...dates], responses: { ...fastingResponses(), 200: { description: 'Visibility-scoped UTF-8 CSV with BOM; spreadsheet formula-safe escaped cells.', content: { 'text/csv': { schema: { type: 'string' } } } } }, description: 'Columns: start_at,end_at,start_tzid,duration_minutes,goal_minutes,goal_reached,rating,note,visibility. Uses the same recorded-zone completion-date filters as history.' }),
    },
    '/api/v1/health/cycle/periods': {
      get: op({ summary: 'List menstrual period episodes', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Log a menstrual period episode', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/cycle/periods/{id}': {
      patch: op({ summary: 'Update a period episode', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a period episode', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/cycle/logs': {
      get: op({ summary: 'List cycle day logs (flow, symptoms, mood)', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Upsert a cycle day log (one per person and day)', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/cycle/logs/{id}': {
      delete: op({ summary: 'Delete a cycle day log', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/cycle/settings': {
      get: op({ summary: 'Get the viewer\'s cycle prediction settings', tag: 'Health' }),
      put: op({ summary: 'Update the viewer\'s cycle prediction settings', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/cycle/feed': {
      get: op({ summary: 'Get own predicted-cycle ICS feed status', tag: 'Health' }),
      delete: op({ summary: 'Disable own predicted-cycle ICS feed', tag: 'Health', stateChanging: true }),
    },
    '/api/v1/health/cycle/feed/regenerate': {
      post: op({ summary: 'Regenerate own predicted-cycle ICS feed token', tag: 'Health', stateChanging: true }),
    },
    '/api/v1/health/export/cycle': {
      get: op({ summary: 'Export period history as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/caregivers/me': {
      get: op({ summary: 'List who the caller may record health data for', tag: 'Health', description: 'Open to every member: it is the answer about their own rights, not about anyone else\'s data.' }),
    },
    '/api/v1/health/caregivers': {
      get: op({ summary: 'List all caregiver relationships', tag: 'Health', admin: true, description: 'Returns `{ subject_id: [caregiver_id, ...] }` for the admin rights matrix.' }),
    },
    '/api/v1/health/caregivers/{subjectId}': {
      put: op({ summary: 'Set who may record health data for one person', tag: 'Health', admin: true, stateChanging: true, params: [idParam('subjectId', 'The person being cared for')], requestBody: jsonBody(null), description: 'Sets the caregivers to exactly the list given. An empty array withdraws care, so removing is the same path as changing and needs no route of its own.' }),
    },
    '/api/v1/health/cycle/visibility': {
      patch: op({ summary: 'Set the visibility of all own cycle entries at once', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Applies one visibility to every period and daily log of the CALLER. Other people\'s entries are untouched, and periods and logs move together in one transaction - either both or neither.' }),
    },
    '/api/v1/health/visibility-defaults': {
      get: op({ summary: 'Get the caller\'s default visibility per health area', tag: 'Health', description: 'Returns only the deviations as `{ scope_key: visibility }`; a missing key means `private`, the shipped value. Scope keys are `vital:<type>` per metric plus `meds`, `labs` and `activities`. The cycle tab keeps its own setting under `/health/cycle/settings`.' }),
      put: op({ summary: 'Set the caller\'s default visibility for one or more areas', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Body `{ defaults: { "vital:bp": "family", ... } }`. Named keys are replaced, unnamed ones stay. Setting `private` DELETES the row rather than storing it, so "no row" remains the only spelling of the default. Affects new entries only; a value given on the entry itself always wins.' }),
    },
    '/api/v1/health/visibility-defaults/apply': {
      patch: op({ summary: 'Move existing entries of one area to a visibility', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Body `{ scope, visibility }`. Touches the CALLER\'s own rows only, and only in the named area - a caregiver may tend individual entries but not relabel somebody else\'s history in one move. The target comes from the request rather than from the stored default, because `private` is not stored at all.' }),
    },
  };
}
