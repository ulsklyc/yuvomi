import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

/**
 * Schichtplan (#786).
 *
 * `/entries` ist die einzige Route, die rechnet statt zu speichern: sie loest
 * Muster und Ausnahmen zum Lesezeitpunkt auf und legt nichts in
 * `calendar_events` ab. Der Zeitraum ist begrenzt - ohne Grenze baut ein Aufruf
 * einen Eintrag je Tag und Mitglied.
 */
export function schedulePaths() {
  return {
    '/api/v1/schedule/entries': {
      get: op({
        summary: 'Resolve schedule entries for a date range',
        description: 'Computed from patterns and overrides at read time; nothing is written to the calendar. The range is capped at 731 days.',
        tag: 'Schedule',
        params: [
          { name: 'from', in: 'query', required: true, description: 'Start date (YYYY-MM-DD)', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, description: 'End date (YYYY-MM-DD), inclusive', schema: { type: 'string', format: 'date' } },
          { name: 'user_id', in: 'query', required: false, description: 'Limit to one household member', schema: { type: 'integer' } },
        ],
      }),
    },
    '/api/v1/schedule/shift-types': {
      get: op({ summary: 'List shift types', tag: 'Schedule' }),
      post: op({ summary: 'Create a shift type', description: 'Any member may add one.', tag: 'Schedule', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/schedule/shift-types/{id}': {
      put: op({ summary: 'Update a shift type', description: 'Only its creator or an administrator.', tag: 'Schedule', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a shift type', description: 'Only its creator or an administrator. Answers 409 while a pattern or override still references it.', tag: 'Schedule', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/schedule/shift-types/{id}/fields': {
      put: op({
        summary: 'Replace which custom fields are attached to a shift type',
        description: 'Deletes and re-inserts the whole attachment set in one transaction, same shape as PUT /patterns/{id}/days. Rejects a custom_field_id that does not exist or repeats within the payload.',
        tag: 'Schedule',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/schedule/household-members': {
      get: op({
        summary: 'List people selectable for the Overview tab',
        description: 'Real household members only - filtered through isHouseholdMember(), so housekeeping staff and split-expense guests never appear.',
        tag: 'Schedule',
      }),
    },
    '/api/v1/schedule/custom-fields': {
      get: op({ summary: 'List custom fields', description: 'Household-wide definitions, defined once and attachable to any number of shift types.', tag: 'Schedule' }),
      post: op({ summary: 'Create a custom field', description: 'Any member may add one.', tag: 'Schedule', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/schedule/custom-fields/{id}': {
      put: op({ summary: 'Rename a custom field', description: 'Only its creator or an administrator.', tag: 'Schedule', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a custom field', description: 'Only its creator or an administrator. Cascades: also removes its shift-type attachments and any values already recorded against it.', tag: 'Schedule', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/schedule/patterns': {
      get: op({ summary: 'List cycle patterns', tag: 'Schedule' }),
      post: op({ summary: 'Create a cycle pattern', tag: 'Schedule', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/schedule/patterns/{id}': {
      put: op({ summary: 'Update a cycle pattern', tag: 'Schedule', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a cycle pattern', description: 'Its cycle days go with it.', tag: 'Schedule', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/schedule/patterns/{id}/days': {
      get: op({ summary: 'List the cycle days of a pattern', tag: 'Schedule', params: [idParam()] }),
      put: op({
        summary: 'Replace all cycle days of a pattern',
        description: 'Deletes and re-inserts every day of the cycle in one transaction. A position may repeat - a cycle day can carry several classes at different times (a timetable), each its own shift type; an omitted position is a free day. The days array is capped at 500 rows.',
        tag: 'Schedule',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/schedule/overrides': {
      get: op({ summary: 'List per-day overrides', tag: 'Schedule' }),
      delete: op({
        summary: 'Remove overrides across a date range',
        description: 'The counterpart to /overrides/fill - a single indexed delete, so it carries the read-side range cap (731 days) rather than the smaller one on fill.',
        tag: 'Schedule',
        params: [
          { name: 'user_id', in: 'query', required: false, description: 'Household member; defaults to the caller', schema: { type: 'integer' } },
          { name: 'from', in: 'query', required: true, description: 'Start date (YYYY-MM-DD)', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, description: 'End date (YYYY-MM-DD), inclusive', schema: { type: 'string', format: 'date' } },
        ],
        stateChanging: true,
      }),
    },
    '/api/v1/schedule/overrides/fill': {
      post: op({
        summary: 'Fill a date range of overrides in one call',
        description: 'Upserts the same shift type (or NULL for a free day) across an inclusive range - e.g. marking a vacation - instead of one PUT per day. Writes real rows, so it is capped separately from /entries at 100 days.',
        tag: 'Schedule',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/schedule/overrides/{dateKey}': {
      put: op({
        summary: 'Set a per-day override',
        description: 'A NULL shift type is an explicit day off, which is why deleting the override is the only way back to the pattern.',
        tag: 'Schedule',
        params: [stringPathParam('dateKey', 'Date (YYYY-MM-DD)')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({ summary: 'Remove a per-day override', tag: 'Schedule', params: [stringPathParam('dateKey', 'Date (YYYY-MM-DD)')], stateChanging: true }),
    },
    '/api/v1/schedule/extras': {
      get: op({ summary: 'List extra shifts (additive to the primary pattern/override slot)', tag: 'Schedule' }),
      post: op({
        summary: 'Add an extra shift on a day',
        description: 'Additive to whatever the primary slot resolves for that day - never an upsert, so multiple extras (even sharing a shift type) may exist on the same date. Addressed by its own id, not by (user_id, date_key) like overrides.',
        tag: 'Schedule',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/schedule/extras/fill': {
      post: op({
        summary: 'Add the same extra shift across a date range in one call',
        description: 'An insert loop, not an upsert - every day in range gets its own new row. Writes real rows, capped at 100 days like /overrides/fill.',
        tag: 'Schedule',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/schedule/extras/{id}': {
      put: op({ summary: 'Update an extra shift', description: 'Any field left out of the body keeps its previous value. user_id may never be reassigned.', tag: 'Schedule', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Remove an extra shift', tag: 'Schedule', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/schedule/feed': {
      get: op({ summary: 'Get own schedule ICS feed status', tag: 'Schedule' }),
      delete: op({ summary: 'Disable own schedule ICS feed', tag: 'Schedule', stateChanging: true }),
    },
    '/api/v1/schedule/feed/regenerate': {
      post: op({ summary: 'Regenerate own schedule ICS feed token', tag: 'Schedule', stateChanging: true }),
    },
    '/api/v1/schedule/preferences': {
      get: op({ summary: 'Get own shift-start reminder offset and weekly-hours target', tag: 'Schedule' }),
      put: op({
        summary: 'Set own shift-start reminder offset and/or weekly-hours target',
        description: 'Either field may be omitted to leave it unchanged; either may be set to null to reset it to its default (reminder off, 40h/week). A change to reminderOffsetMinutes triggers an immediate resync so it takes effect without waiting for the next periodic pass.',
        tag: 'Schedule',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
  };
}
