import { op, jsonBody, idParam } from '../helpers.js';

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
        description: 'Supports optional document-storage attachments via `attachment_name`, `attachment_mime`, `attachment_size`, and `attachment_data` (base64 data URL). New attachments are linked through `attachment_document_id`; legacy events may still return `attachment_data`. Set `target_caldav_account_id` and `target_caldav_calendar_url` to push the event to a CalDAV calendar (omit or null for a local-only event).',
        requestBody: jsonBody(null),
        responses: {
          201: {
            description: 'Calendar event created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
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
    '/api/v1/calendar/google/readonly': { put: op({ summary: 'Set Google Calendar read-only mode', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/apple/status': { get: op({ summary: 'Get Apple Calendar status', tag: 'Calendar' }) },
    '/api/v1/calendar/apple/sync': { post: op({ summary: 'Run Apple Calendar sync', tag: 'Calendar', admin: true, stateChanging: true }) },
    '/api/v1/calendar/apple/connect': { post: op({ summary: 'Connect Apple Calendar', tag: 'Calendar', admin: true, stateChanging: true, requestBody: jsonBody(null) }) },
    '/api/v1/calendar/apple/disconnect': { delete: op({ summary: 'Disconnect Apple Calendar', tag: 'Calendar', admin: true, stateChanging: true }) },
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
        description: 'Available to every authenticated user (#618). Returns `{ data: { google: [{ id, summary }], caldav: [{ accountId, accountName, calendarUrl, calendarName }] } }`, pre-filtered to enabled (and, for Google, writable) calendars. Carries no credentials, server URLs, or usernames - account management stays admin-only. A provider that cannot be reached yields an empty list instead of failing the request.',
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
      put: op({ summary: 'Update Outlook account (name, auto-sync calendar, owner)', tag: 'Calendar', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
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
        description: 'Supports document-storage attachments. Omit attachment fields to preserve the current attachment, send new `attachment_data` to create and link a document, or set `remove_attachment` to true to unlink it without deleting the library document. Legacy events may still return `attachment_data`. Changing a mirrored field (title, description, location, color, all-day, start/end, recurrence) of an event synced to Google pushes the change there, and switching `target_google_calendar_id` moves it to the other Google calendar. The remote call runs after the response and is retried by the next sync run if it fails.',
        requestBody: jsonBody(null),
        responses: {
          200: {
            description: 'Calendar event updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarEventResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Calendar event not found' },
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
  };
}
