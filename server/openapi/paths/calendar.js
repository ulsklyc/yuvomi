import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

/**
 * Gilt fuer POST und PUT gleich (#1364), deshalb einmal: ein Offset wird
 * umgerechnet statt abgeschnitten, und PUT speichert den geprueften Wert.
 */
/**
 * Ein Anhang ist ein Dokument im Dokumente-Modul (#1358, DECISIONS.md Eintrag 10).
 */
const ATTACHMENT_RIGHTS = ' A new attachment creates a document in the Documents module and therefore needs write access '
  + 'there (member right, for API tokens a `documents:write` scope); without it any non-empty `attachment_data` is refused with 403 '
  + 'before the event is looked up. Replacing or removing an attachment needs read access to the Documents module and sight of the '
  + 'stored document; otherwise the same 403, and the attachment stays. The 403 bodies carry `reason` `ATTACHMENT_UPLOAD_REFUSED` or '
  + '`ATTACHMENT_CHANGE_REFUSED`. Saving an event carries its visibility and assignees over to the attachment\'s document; it opens the '
  + 'document further only for a caller with write access to documents who can see it and may manage it (its creator - for an attachment the event creator - or an admin), otherwise it only narrows. The default-assignee sync of connected calendars never changes document rights, with one exception: when the event is visible to its assignees and the document is already shared with selected members, the new assignee is added to those shares. Otherwise nothing changes - no document becomes visible to the family, none is opened, narrowed or made private, and no share is removed. A copy made on split or detach belongs to the owner of its source document. A split or a '
  + 'detach copies the attachment for the new series or event only for such a caller; otherwise the new one has no attachment and '
  + 'the original stays on the original series.';

const DATETIME_INPUT = ' `start_datetime` and `end_datetime` take the forms of `CalendarDateOrDateTimeInput`: '
  + 'a value without offset is household wall-clock time, a value with `Z` or a numeric offset is read as an '
  + 'instant and converted into the household time zone (`2026-09-21T16:00:00Z` in a Europe/Berlin household is '
  + 'stored as `2026-09-21T18:00`). For an all-day event only the date of such a value counts. Up to v2.68.0 '
  + 'the offset was dropped and its digits kept as wall-clock time.';

export function calendarPaths() {
  return {
    '/api/v1/calendar': {
      get: op({
        summary: 'List calendar events',
        tag: 'Calendar',
        description: 'Events generated from the birthdays module carry `birthday_name` and `birthday_date`. Their `title` is stored in the household data language (see `language` in `/preferences`), so API consumers, the ICS feed and calendar sync all read the same wording; clients that display in a different language can re-render the title from `birthday_name`.',
        responses: {
          200: {
            description: 'Calendar events',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create calendar event',
        tag: 'Calendar',
        stateChanging: true,
        description: 'Supports optional document-storage attachments via `attachment_name`, `attachment_mime`, `attachment_size`, and `attachment_data` (base64 data URL). New attachments are linked through `attachment_document_id`; legacy events may still return `attachment_data`. Set `target_caldav_account_id` and `target_caldav_calendar_url` to push the event to a CalDAV calendar (omit or null for a local-only event).' + ATTACHMENT_RIGHTS + DATETIME_INPUT,
        requestBody: jsonBody(null),
        responses: {
          201: {
            description: 'Calendar event created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: apiError('A new attachment without write access to the Documents module.'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/calendar/upcoming': { get: op({ summary: 'List upcoming events', tag: 'Calendar' }) },
    '/api/v1/calendar/search': { get: op({ summary: 'Search events by title, location, or notes', tag: 'Calendar', description: 'Diacritic-insensitive full-text search across all family-visible calendar events (`q`, min 2 chars). Returns `{ data: Event[], total }` sorted chronologically; recurring matches resolve to their next occurrence. Backs the calendar toolbar search (#471).' }) },
    '/api/v1/calendar/holidays': { get: op({ summary: 'List public & school holidays in a date range', tag: 'Calendar', description: 'Reads cached OpenHolidays entries that overlap `from`/`to` (both `YYYY-MM-DD`, required). Returns `{ data: [{ id, type (`public`|`school`), start_date, end_date, name, color }] }`. Empty when no holiday country is configured.' }) },
    '/api/v1/calendar/google/auth': { get: op({ summary: 'Start Google Calendar OAuth', tag: 'Calendar', admin: true }) },
    '/api/v1/calendar/google/callback': { get: op({ summary: 'Google Calendar OAuth callback', tag: 'Calendar' }) },
    '/api/v1/calendar/google/sync': { post: op({ summary: 'Run Google Calendar sync', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/google/status': { get: op({ summary: 'Get Google Calendar status', tag: 'Calendar' }) },
    '/api/v1/calendar/google/calendars': {
      get: op({ summary: 'List available Google calendars', tag: 'Calendar', admin: true }),
      patch: op({ summary: 'Enable/disable a Google calendar to sync', tag: 'Calendar', admin: true, stateChanging: true }),
    },
    '/api/v1/calendar/google/disconnect': { delete: op({ summary: 'Disconnect Google Calendar', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/google/mirrored-events': { delete: op({ summary: 'Delete locally mirrored Google events', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/google/readonly': { put: op({ summary: 'Set Google Calendar read-only mode', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/apple/status': { get: op({ summary: 'Get Apple Calendar status', tag: 'Calendar' }) },
    '/api/v1/calendar/apple/sync': { post: op({ summary: 'Run Apple Calendar sync', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/apple/connect': { post: op({ summary: 'Connect Apple Calendar', tag: 'Calendar', admin: true, stateChanging: true, requestBody: jsonBody(null) }) },
    '/api/v1/calendar/apple/disconnect': { delete: op({ summary: 'Disconnect Apple Calendar', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/apple/mirrored-events': { delete: op({ summary: 'Delete locally mirrored Apple events', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/subscriptions': {
      get: op({ summary: 'List ICS subscriptions', tag: 'Calendar' }),
      post: op({ summary: 'Create ICS subscription', tag: 'Calendar', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/calendar/subscriptions/{id}': {
      patch: op({ summary: 'Update ICS subscription', tag: 'Calendar', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete ICS subscription', tag: 'Calendar', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar/subscriptions/{id}/sync': {
      post: op({ summary: 'Sync ICS subscription', tag: 'Calendar', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar/import': {
      post: op({ summary: 'Import events from an ICS file or shared calendar feed as editable local events', tag: 'Calendar', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/calendar/feed': {
      get: op({ summary: 'Get personal ICS export feed status', tag: 'Calendar' }),
      put: op({ summary: 'Set personal ICS export feed options (showAssignees)', tag: 'Calendar', stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Disable personal ICS export feed', tag: 'Calendar', stateChanging: true }),
    },
    '/api/v1/calendar/feed/regenerate': {
      post: op({ summary: 'Regenerate personal ICS export feed token', tag: 'Calendar', stateChanging: true }),
    },
    '/api/v1/calendar/sync-targets': {
      get: op({
        summary: 'List selectable sync targets for the event editor',
        tag: 'Calendar',
        description: 'Available to every authenticated user (#618). Returns `{ data: { google: [{ id, summary, defaultAssigneeUserId }], caldav: [{ accountId, accountName, calendarUrl, calendarName, defaultAssigneeUserId }], outlook: [{ accountId, accountName, calendarId, calendarName }] } }`, pre-filtered to enabled (and, for Google, writable) calendars. `defaultAssigneeUserId` is the default assignee set on that calendar (#459), or null; the event editor reads it backwards to pick the calendar of the person a new event is assigned to (#1060). Carries no credentials, server URLs, or usernames - account management stays admin-only. A provider that cannot be reached yields an empty list instead of failing the request.',
      }),
    },
    '/api/v1/calendar/caldav/accounts': {
      get: op({ summary: 'List CalDAV accounts', tag: 'Calendar', admin: true }),
      post: op({ summary: 'Create CalDAV account', tag: 'Calendar', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/calendar/caldav/accounts/{id}': {
      put: op({ summary: 'Update CalDAV account', tag: 'Calendar', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete CalDAV account', tag: 'Calendar', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar/caldav/accounts/{id}/calendars': {
      get: op({ summary: 'List calendars for a CalDAV account', tag: 'Calendar', admin: true, params: [idParam()] }),
      patch: op({ summary: 'Enable or disable a CalDAV calendar', tag: 'Calendar', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/calendar/caldav/sync': {
      post: op({ summary: 'Run CalDAV event sync', tag: 'Calendar', admin: true, stateChanging: true }),
    },
    '/api/v1/calendar/caldav/status': {
      get: op({ summary: 'Get CalDAV event sync status', tag: 'Calendar' }),
    },
    '/api/v1/calendar/caldav/accounts/{id}/reminder-lists': {
      get: op({ summary: 'List reminder lists for a CalDAV account', tag: 'Calendar', admin: true, params: [idParam()] }),
      patch: op({ summary: 'Enable/disable a CalDAV reminder list and target module', tag: 'Calendar', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/calendar/caldav/reminders/sync': {
      post: op({ summary: 'Run CalDAV reminders sync', tag: 'Calendar', admin: true, stateChanging: true }),
    },
    '/api/v1/calendar/caldav/reminders/status': {
      get: op({ summary: 'Get CalDAV reminders sync status', tag: 'Calendar' }),
    },
    '/api/v1/calendar/outlook/auth': { get: op({ summary: 'Start Outlook (Microsoft) OAuth', tag: 'Calendar', admin: true }) },
    '/api/v1/calendar/outlook/callback': { get: op({ summary: 'Outlook OAuth callback', tag: 'Calendar' }) },
    '/api/v1/calendar/outlook/accounts': {
      get: op({ summary: 'List connected Outlook accounts', tag: 'Calendar', admin: true }),
    },
    '/api/v1/calendar/outlook/accounts/{id}': {
      put: op({
        summary: 'Update Outlook account (name, auto-sync calendar, owner)',
        tag: 'Calendar',
        admin: true,
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        responses: {
          200: { description: 'Outlook account updated' },
          401: { $ref: '#/components/responses/Unauthorized' },
          409: {
            description: 'Auto-sync activation conflicts with recurring series that have linked occurrence overrides',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OutlookAutoSyncOverrideConflict' } } },
          },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({ summary: 'Disconnect and delete Outlook account', tag: 'Calendar', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar/outlook/accounts/{id}/calendars': {
      get: op({ summary: 'List calendars for an Outlook account', tag: 'Calendar', admin: true, params: [idParam()] }),
      patch: op({ summary: 'Enable or disable an Outlook calendar as push target', tag: 'Calendar', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/calendar/outlook/sync': {
      post: op({ summary: 'Run Outlook one-way push', tag: 'Calendar', admin: true, stateChanging: true }),
    },
    '/api/v1/calendar/outlook/status': {
      get: op({ summary: 'Get Outlook push status', tag: 'Calendar' }),
    },
    '/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}': {
      put: op({
        summary: 'Update one recurring calendar occurrence',
        tag: 'Calendar',
        params: [
          idParam('seriesId', 'Recurring series ID'),
          stringPathParam('recurrenceId', 'Original occurrence date in YYYY-MM-DD format'),
        ],
        stateChanging: true,
        description: 'Creates or updates a linked replacement for one original slot of an eligible local-only series. Scalar fields, assignments, attachments, and `reminder_offsets` are compared with the expanded series defaults. Saving no actual difference restores the normal series occurrence only when a linked replacement existed for that slot; a slot excluded by a deletion or detached replacement remains excluded.' + ATTACHMENT_RIGHTS,
        requestBody: jsonBody('#/components/schemas/CalendarOccurrenceOnlyMutation'),
        responses: {
          200: {
            description: 'Resolved calendar occurrence',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarOccurrenceResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: apiError('Calendar series not found'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete one recurring calendar occurrence',
        tag: 'Calendar',
        params: [
          idParam('seriesId', 'Recurring series ID'),
          stringPathParam('recurrenceId', 'Original occurrence date in YYYY-MM-DD format'),
        ],
        stateChanging: true,
        description: 'Deletes a linked replacement when present and keeps an EXDATE on the master so the original slot remains suppressed.',
        responses: {
          204: { description: 'Occurrence deleted' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: apiError('Calendar series not found'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}/following': {
      put: op({
        summary: 'Split a recurring calendar series',
        tag: 'Calendar',
        params: [
          idParam('seriesId', 'Recurring series ID'),
          stringPathParam('recurrenceId', 'Original occurrence date in YYYY-MM-DD format'),
        ],
        stateChanging: true,
        description: 'Truncates the original series before the selected original slot, creates a successor series, transfers every later exclusion except the selected slot, and reparents later linked replacements atomically.' + ATTACHMENT_RIGHTS,
        requestBody: jsonBody('#/components/schemas/CalendarOccurrenceFollowingMutation'),
        responses: {
          200: {
            description: 'First occurrence updated as the whole series',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarOccurrenceResponse' } } },
          },
          201: {
            description: 'Successor calendar series created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarOccurrenceResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: apiError('Calendar series not found'),
          409: {
            description: 'Linked occurrence replacements require exact-count orphan confirmation',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarOverrideOrphanConflict' } } },
          },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete this and following recurring occurrences',
        tag: 'Calendar',
        params: [
          idParam('seriesId', 'Recurring series ID'),
          stringPathParam('recurrenceId', 'Original occurrence date in YYYY-MM-DD format'),
        ],
        stateChanging: true,
        description: 'Truncates immediately before the selected original slot, removes later linked replacements, and preserves later exclusions. Selecting the first slot deletes the whole series.',
        responses: {
          204: { description: 'Selected and following occurrences deleted' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: apiError('Calendar series not found'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/calendar/{id}': {
      get: op({
        summary: 'Get calendar event',
        tag: 'Calendar',
        params: [idParam()],
        responses: {
          200: {
            description: 'Calendar event',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Calendar event not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      put: op({
        summary: 'Update calendar event',
        tag: 'Calendar',
        params: [idParam()],
        stateChanging: true,
        description: 'Supports document-storage attachments. Omit attachment fields to preserve the current attachment, send new `attachment_data` to create and link a document, or set `remove_attachment` to true to unlink it without deleting the library document. Legacy events may still return `attachment_data`. A recurrence-rule or anchor change that would orphan linked replacements returns 409 with `calendar_override_orphans` and the exact `orphaned_override_count`; retry with the same value in `confirmed_orphan_count` to preserve those replacements as standalone events. The same confirmation is required before assigning an outbound target to a series with linked replacements. Changing a mirrored field (title, description, location, color, all-day, start/end, recurrence) of an event synced to Google pushes the change there, and switching `target_google_calendar_id` moves it to the other Google calendar. The remote call runs after the response and is retried by the next sync run if it fails. PUT stores the validated start and end, exactly as POST does; up to v2.68.0 it wrote the raw request value. `start_datetime` may be omitted to keep it, but an empty or null start is rejected with 400; an empty or null `end_datetime` clears the end.' + ATTACHMENT_RIGHTS + DATETIME_INPUT,
        requestBody: jsonBody(null),
        responses: {
          200: {
            description: 'Calendar event updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: apiError('A new attachment without write access to the Documents module, or a change to an attachment whose document the caller cannot read.'),
          404: { description: 'Calendar event not found' },
          409: {
            description: 'Linked occurrence replacements require exact-count orphan confirmation',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarOverrideOrphanConflict' } } },
          },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete calendar event',
        tag: 'Calendar',
        params: [idParam()],
        stateChanging: true,
        description: 'An event mirrored to Google Calendar is deleted there as well. The remote call runs after the response; if it fails, the next sync run retries it.',
      }),
    },
    '/api/v1/calendar/{id}/reset': {
      post: op({ summary: 'Reset external calendar event to source state', tag: 'Calendar', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/calendar/{id}/exceptions': {
      post: op({ summary: 'Exclude a single occurrence of a recurring event (EXDATE)', tag: 'Calendar', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/calendar/external-calendars': {
      patch: op({ summary: 'Set the default assignee of an external calendar', tag: 'Calendar', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Body: { source, external_id, default_assignee_user_id }. Events arriving from that calendar are assigned to this member. Without it the first batch of a newly enabled calendar came in unassigned and had to be filled in by hand (#730). The sync only refreshes name and colour on conflict, so the assignment set here stays.' }),
    },
    '/api/v1/calendar/external-calendars/default-assignee-backfill': {
      get: op({ summary: 'Count imported events a default-assignee backfill would fill', tag: 'Calendar', admin: true, description: 'Query: `moved_after` (optional) - the `moved_next` of the previous page. Response: { data: { count, token, moved, moved_total, moved_offset, moved_next } }. `count` counts already imported events from calendars of every account that carry a default assignee and are not assigned to anyone yet (#1154). `token` fingerprints exactly that set - which events, and which person each would get - and is meant to be sent back as `expected_token` (#1171). `moved` lists, one entry per event, events whose only assignee is still the untouched default assignee of another calendar of the same account (same provider; for CalDAV the same account), in a calendar with a different default assignee, never edited in Yuvomi and not pushed out (#1307): { event_id, title, start_datetime, all_day, calendar_name, from_user_id, from_name, to_user_id, to_name }. Only events the requesting admin may see under the calendar visibility rule are listed, counted or changed (no admin bypass, as everywhere in the calendar); `count` and `token` only count and name no event, as before. The list comes in pages of at most 5000 entries, oldest start first: `moved_total` counts all, `moved_offset` those before this page, and `moved_next` is the cursor for the next page (null on the last), so a page left entirely unticked does not hide the ones after it. Such an event may have been moved between calendars before the move started carrying the assignment along, or it may sit in a calendar whose default assignee was changed later; the data cannot tell the two apart, so these events are not part of `count` and change only when picked one by one.' }),
      post: op({ summary: 'Apply default assignees to already imported events', tag: 'Calendar', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Body: { expected_count, expected_token?, moves? } - the count and the token the confirmation was based on; when the candidate set changed since, the call answers 409 with { data: { count, token, moved, moved_total, moved_offset, moved_next } } (the first page) and changes nothing. With `expected_token` a change of the same size is caught as well (an event assigned by hand while a new import takes its place, or a calendar switched to another person); without it only the count is compared (#1171). `moves` is the list of `moved` entries the admin picked, each as { event_id, from_user_id, to_user_id } exactly as listed, each event at most once and at most 5000 entries, as many as the preview lists; a longer list answers 400 with a message naming the limit (#1307); each entry is checked on its own against the same rule and visibility as the preview, without loading the list and without needing a page, and an entry that does not match that way also answers 409. Without `moves` no existing assignment is changed. Only the confirmed candidate list and the picked moves are processed, each event re-checked when written, so `assigned` can be lower than expected if events changed in the meantime. Response: { data: { assigned } }. Runs in batches so a long history does not block other requests; inherited reminders whose time has passed are marked dismissed. A default assignee only reaches events imported after it was set. This one-off action assigns it to the events already imported from that calendar, across all accounts, but only where an event is not assigned to anyone yet: an assignment made by hand is left alone (#1154). It cannot tell a never-assigned event from one whose assignment was removed by hand. ICS subscriptions are not included.' }),
    },
  };
}
