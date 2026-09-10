import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

const schemaResponse = (schema, description = 'Successful response', status = 200, extra = {}) => ({
  [status]: {
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
  },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  500: { $ref: '#/components/responses/InternalServerError' },
  ...extra,
});

const noContentResponse = (description, extra = {}) => ({
  204: { description },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  500: { $ref: '#/components/responses/InternalServerError' },
  ...extra,
});

const includeArchivedParam = {
  name: 'include_archived',
  in: 'query',
  required: false,
  description: 'Include archived types. Defaults to false.',
  schema: { type: 'boolean', default: false },
};

const typeIdParam = {
  name: 'type_id',
  in: 'query',
  required: false,
  description: 'Filter to one waste type.',
  schema: { type: 'integer' },
};

export function wastePaths() {
  return {
    '/api/v1/waste/types': {
      get: op({
        summary: 'List waste types',
        tag: 'Waste',
        params: [includeArchivedParam],
        responses: schemaResponse('WasteTypeListResponse'),
      }),
      post: op({
        summary: 'Create a waste type',
        tag: 'Waste',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteTypeInput'),
        responses: schemaResponse('WasteTypeResponse', 'Type created', 201),
      }),
    },
    '/api/v1/waste/types/{id}': {
      get: op({
        summary: 'Get a waste type',
        tag: 'Waste',
        params: [idParam()],
        responses: schemaResponse('WasteTypeResponse', 'Type', 200, { 404: apiError('Type not found') }),
      }),
      put: op({
        summary: 'Update a waste type',
        tag: 'Waste',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteTypeInput'),
        responses: schemaResponse('WasteTypeResponse', 'Type updated', 200, { 404: apiError('Type not found') }),
      }),
      delete: op({
        summary: 'Delete a waste type',
        tag: 'Waste',
        description: 'Refused with 409 while any schedule or one-off pickup still references this type; archive it instead (PUT with archived: true).',
        params: [idParam()],
        stateChanging: true,
        responses: noContentResponse('Type deleted', {
          404: apiError('Type not found'),
          409: apiError('Type has schedules or pickups and cannot be deleted'),
        }),
      }),
    },
    '/api/v1/waste/schedules': {
      get: op({
        summary: 'List waste schedules',
        tag: 'Waste',
        params: [typeIdParam, {
          name: 'include_inactive', in: 'query', required: false,
          description: 'Include paused (active=0) schedules. Defaults to true.',
          schema: { type: 'boolean', default: true },
        }],
        responses: schemaResponse('WasteScheduleListResponse'),
      }),
      post: op({
        summary: 'Create a waste schedule',
        tag: 'Waste',
        description: 'A weekly schedule requires weekdays; a monthly_fixed_day schedule requires month_day and an anchor_date whose own day-of-month matches it (or, for month_day=-1, is the actual last day of its month). type_id must reference an existing waste type, or the request is refused with 400.',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteScheduleInput'),
        responses: schemaResponse('WasteScheduleResponse', 'Schedule created', 201),
      }),
    },
    '/api/v1/waste/schedules/{id}': {
      get: op({
        summary: 'Get a waste schedule',
        tag: 'Waste',
        params: [idParam()],
        responses: schemaResponse('WasteScheduleResponse', 'Schedule', 200, { 404: apiError('Schedule not found') }),
      }),
      put: op({
        summary: 'Update a waste schedule',
        tag: 'Waste',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteScheduleInput'),
        responses: schemaResponse('WasteScheduleResponse', 'Schedule updated', 200, { 404: apiError('Schedule not found') }),
      }),
      delete: op({
        summary: 'Delete a waste schedule',
        tag: 'Waste',
        description: 'Cascades this schedule\'s own overrides only. The type itself and any other schedule/one-off referencing it are untouched.',
        params: [idParam()],
        stateChanging: true,
        responses: noContentResponse('Schedule deleted', { 404: apiError('Schedule not found') }),
      }),
    },
    '/api/v1/waste/schedules/{id}/overrides/{originalDate}': {
      put: op({
        summary: 'Move or skip one calculated occurrence',
        tag: 'Waste',
        description: 'Sets an override for the schedule\'s calculated occurrence on original_date: a replacement_date moves it, null explicitly skips it. Refused with 400 if original_date is not really one of the schedule\'s own calculated dates.',
        params: [idParam(), stringPathParam('originalDate', 'The occurrence\'s own calculated date (YYYY-MM-DD), not the replacement date')],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteScheduleOverrideInput'),
        responses: schemaResponse('WasteScheduleOverrideResponse', 'Override set', 200, { 404: apiError('Schedule not found') }),
      }),
      delete: op({
        summary: 'Restore one calculated occurrence to its schedule-computed date',
        tag: 'Waste',
        params: [idParam(), stringPathParam('originalDate', 'The occurrence\'s own calculated date (YYYY-MM-DD)')],
        stateChanging: true,
        responses: noContentResponse('Override removed', { 404: apiError('No override exists for this schedule/date') }),
      }),
    },
    '/api/v1/waste/pickups': {
      get: op({
        summary: 'List manual one-off pickups',
        tag: 'Waste',
        params: [typeIdParam],
        responses: schemaResponse('WasteOneOffPickupListResponse'),
      }),
      post: op({
        summary: 'Create a manual one-off pickup',
        tag: 'Waste',
        description: 'For an irregular or special collection that is a fact on its own, not a schedule with a fake recurrence. type_id must reference an existing waste type, or the request is refused with 400.',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteOneOffPickupInput'),
        responses: schemaResponse('WasteOneOffPickupResponse', 'Pickup created', 201, { 409: apiError('A pickup already exists for this type and date') }),
      }),
    },
    '/api/v1/waste/pickups/{id}': {
      get: op({
        summary: 'Get a one-off pickup',
        tag: 'Waste',
        params: [idParam()],
        responses: schemaResponse('WasteOneOffPickupResponse', 'Pickup', 200, { 404: apiError('Pickup not found') }),
      }),
      put: op({
        summary: 'Update a one-off pickup',
        tag: 'Waste',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteOneOffPickupInput'),
        responses: schemaResponse('WasteOneOffPickupResponse', 'Pickup updated', 200, { 404: apiError('Pickup not found'), 409: apiError('A pickup already exists for this type and date') }),
      }),
      delete: op({
        summary: 'Delete a one-off pickup',
        tag: 'Waste',
        params: [idParam()],
        stateChanging: true,
        responses: noContentResponse('Pickup deleted', { 404: apiError('Pickup not found') }),
      }),
    },
    '/api/v1/waste/occurrences': {
      get: op({
        summary: 'Resolved, coalesced occurrences for a date range',
        tag: 'Waste',
        description: 'Inclusive on both ends; the range must not exceed 731 days (matching Schedule\'s own ceiling). Combines every active schedule and one-off pickup, across every type (including archived ones, so history stays visible).',
        params: [
          { name: 'from', in: 'query', required: true, description: 'YYYY-MM-DD', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, description: 'YYYY-MM-DD', schema: { type: 'string', format: 'date' } },
        ],
        responses: schemaResponse('WasteOccurrenceListResponse'),
      }),
    },
    '/api/v1/waste/occurrences/next': {
      get: op({
        summary: 'One next occurrence per active (non-archived) waste type',
        tag: 'Waste',
        description: 'From today onward, within the same 731-day ceiling as /occurrences. A type with nothing upcoming in that window reports next: null.',
        responses: schemaResponse('WasteNextPerTypeResponse'),
      }),
    },
    '/api/v1/waste/import/preview': {
      post: op({
        summary: 'Preview a fresh ICS import (stateless)',
        tag: 'Waste',
        description: 'Parses the given ICS text and returns candidate pickups, per-label mapping suggestions, and diagnostics. Writes nothing; a "blocking" diagnostic excludes its event\'s instances from the preview and must be explicitly acknowledged via skip_event_keys on commit, or the whole commit is refused.',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteImportPreviewInput'),
        responses: schemaResponse('WasteImportPreviewResponse'),
      }),
    },
    '/api/v1/waste/import/commit': {
      post: op({
        summary: 'Commit a fresh ICS import as a new source',
        tag: 'Waste',
        description: 'Re-parses the ICS text (never trusts a client-supplied candidate list) and atomically creates the source, its label mappings, and its imported pickups. Every distinct label reported by a preview of this same file must have exactly one mapping decision: an existing type_id, a new_type to create inline, or ignored.',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteImportCommitInput'),
        responses: schemaResponse('WasteImportCommitResponse', 'Source created', 201),
      }),
    },
    '/api/v1/waste/sources': {
      get: op({
        summary: 'List import sources',
        tag: 'Waste',
        description: 'A URL source\'s url field is omitted entirely for a caller without module write access (it is a credential, not merely masked).',
        responses: schemaResponse('WasteSourceListResponse'),
      }),
      post: op({
        summary: 'Add a subscribed ICS URL source',
        tag: 'Waste',
        description: 'Creates the source, then performs its first fetch synchronously (same feedback as a fresh file import) - a first-fetch failure does not fail creation; the source is created either way and the scheduler retries per its own backoff. Fresh FILE sources are still created via POST /waste/import/commit.',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteUrlSourceCreateInput'),
        responses: schemaResponse('WasteUrlSourceCreateResponse', 'Source created', 201),
      }),
    },
    '/api/v1/waste/sources/{id}': {
      get: op({
        summary: 'Get an import source, including its label mappings',
        tag: 'Waste',
        params: [idParam()],
        responses: schemaResponse('WasteSourceDetailResponse', 'Source', 200, { 404: apiError('Source not found') }),
      }),
      put: op({
        summary: 'Rename an import source',
        tag: 'Waste',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteSourceRenameInput'),
        responses: schemaResponse('WasteSourceDetailResponse', 'Source renamed', 200, { 404: apiError('Source not found') }),
      }),
      delete: op({
        summary: 'Delete an import source',
        tag: 'Waste',
        description: 'Cascades this source\'s own label mappings and imported pickups only. Other sources, manual schedules/one-offs, and the waste types themselves are untouched.',
        params: [idParam()],
        stateChanging: true,
        responses: noContentResponse('Source deleted', { 404: apiError('Source not found') }),
      }),
    },
    '/api/v1/waste/sources/{id}/refresh': {
      post: op({
        summary: 'Manually refresh a URL source now',
        tag: 'Waste',
        description: 'Runs the exact same fetch/auto-commit/needs-mapping logic the scheduler uses, outside its own schedule. 400 if the source is not kind=url (use re-import for a file source instead).',
        params: [idParam()],
        stateChanging: true,
        responses: schemaResponse('WasteUrlSourceRefreshResponse', 'Refresh attempted', 200, {
          400: apiError('Not a URL source'),
          404: apiError('Source not found'),
        }),
      }),
    },
    '/api/v1/waste/sources/{id}/mappings/{mappingId}': {
      put: op({
        summary: 'Edit one label\'s mapping decision without a re-import',
        tag: 'Waste',
        description: 'Changes only the mapping row. Already-committed imported pickups for this label keep their existing type_id until the next re-import commit applies the changed mapping to the data.',
        params: [idParam('id', 'Source ID'), idParam('mappingId', 'Mapping ID')],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteSourceMappingUpdateInput'),
        responses: schemaResponse('WasteSourceMappingResponse', 'Mapping updated', 200, { 404: apiError('Source or mapping not found') }),
      }),
    },
    '/api/v1/waste/sources/{id}/reimport/preview': {
      post: op({
        summary: 'Preview a re-import of an existing source (stateless)',
        tag: 'Waste',
        description: 'Same as /import/preview, but prefills each label\'s remembered_type_id/remembered_ignored from this source\'s existing mappings and returns expected_version for the commit\'s concurrency check.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteImportPreviewInput'),
        responses: schemaResponse('WasteImportPreviewResponse', 'Preview', 200, { 404: apiError('Source not found') }),
      }),
    },
    '/api/v1/waste/sources/{id}/reimport/commit': {
      post: op({
        summary: 'Commit a re-import onto an existing source',
        tag: 'Waste',
        description: 'Requires expected_version to match the source\'s current version (409 on mismatch - invariant #9, two editors cannot silently replace each other\'s reviewed snapshot). Applies additions/changes/removals atomically; a failure preserves the last good snapshot.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteImportCommitInput'),
        responses: schemaResponse('WasteImportCommitResponse', 'Import applied', 200, {
          404: apiError('Source not found'),
          409: apiError('The source changed since the preview, or the file content changed since the preview'),
        }),
      }),
    },
    '/api/v1/waste/reminder-settings': {
      get: op({
        summary: "List the calling user's own pickup reminder settings",
        tag: 'Waste',
        description: 'One entry per active (non-archived) type, synthesizing an all-disabled default for a type the caller has never configured. Personal, not household-wide - same shape as GET /schedule/preferences.',
        responses: schemaResponse('WasteReminderSettingsListResponse'),
      }),
    },
    '/api/v1/waste/reminder-settings/{typeId}': {
      put: op({
        summary: "Upsert the calling user's own reminder setting for one waste type",
        tag: 'Waste',
        description: 'Applies immediately - triggers a synchronous reminder-sync for this user in addition to the periodic one, so a change is not left waiting for the next scheduler tick.',
        params: [idParam('typeId', 'Waste type ID')],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteReminderSettingUpdateInput'),
        responses: schemaResponse('WasteReminderSettingResponse', 'Setting saved', 200, { 404: apiError('Waste type not found') }),
      }),
    },
    '/api/v1/waste/sources/{id}/mapping-profile/export': {
      get: op({
        summary: 'Export one source\'s label -> type mappings as a portable profile',
        tag: 'Waste',
        description: 'Only mapped, non-ignored labels are included. No municipal/provider catalog ships with the app - a profile only ever carries a household\'s own prior decisions, for reuse on another source or import elsewhere.',
        params: [idParam()],
        responses: schemaResponse('WasteMappingProfileExportResponse', 'Profile', 200, { 404: apiError('Source not found') }),
      }),
    },
    '/api/v1/waste/sources/{id}/mapping-profile/import/preview': {
      post: op({
        summary: 'Preview applying a mapping profile to a source (stateless)',
        tag: 'Waste',
        description: 'Resolves each profile entry against this source\'s own mapping rows (by pattern) and this household\'s own types (by name). Never creates a mapping row or type that does not already exist - an unrelated profile reports everything unmatched instead.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteMappingProfileImportPreviewInput'),
        responses: schemaResponse('WasteMappingProfileImportPreviewResponse', 'Preview', 200, { 404: apiError('Source not found') }),
      }),
    },
    '/api/v1/waste/sources/{id}/mapping-profile/import/commit': {
      post: op({
        summary: 'Apply a previewed mapping profile to a source',
        tag: 'Waste',
        description: 'Requires profile_digest to match the profile being committed (409 on mismatch, same guard as the ICS import digest). Re-runs the preview server-side before applying, so a mapping row changed since the preview is never silently overwritten with a stale decision.',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteMappingProfileImportCommitInput'),
        responses: schemaResponse('WasteMappingProfileImportCommitResponse', 'Applied', 200, {
          404: apiError('Source not found'),
          409: apiError('The mapping profile changed since it was last previewed'),
        }),
      }),
    },
    '/api/v1/waste/feed': {
      get: op({
        summary: "Get the calling user's own waste ICS feed status",
        tag: 'Waste',
        description: 'null when the feed was never enabled. The feed content is household-wide (waste data has no owner/visibility column); the token is personal, so revoking it only affects this one subscription.',
        responses: schemaResponse('WasteFeedStatusResponse'),
      }),
      delete: op({
        summary: "Revoke the calling user's own waste feed subscription",
        tag: 'Waste',
        stateChanging: true,
        responses: schemaResponse('WasteFeedStatusResponse', 'Revoked'),
      }),
    },
    '/api/v1/waste/feed/regenerate': {
      post: op({
        summary: 'Issue a new feed token, invalidating the previous URL',
        tag: 'Waste',
        description: 'Keeps the existing type selection; only the token (and therefore the URL) changes.',
        stateChanging: true,
        responses: schemaResponse('WasteFeedStatusResponse', 'New token issued'),
      }),
    },
    '/api/v1/waste/feed/types': {
      put: op({
        summary: "Set the calling user's optional type selection for their waste feed",
        tag: 'Waste',
        description: 'Requires the feed to already be enabled. Stored alongside the token, not the public URL, so the subscription URL stays stable when the selection changes.',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/WasteFeedTypeSelectionInput'),
        responses: schemaResponse('WasteFeedStatusResponse', 'Selection saved', 200, { 404: apiError('Feed not enabled yet') }),
      }),
    },
  };
}
