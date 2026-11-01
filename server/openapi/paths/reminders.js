import { op, jsonBody, idParam, withCaseReasons } from '../helpers.js';
import { ORIGIN_MODULE } from '../../services/reminder-origins.js';

/**
 * Gilt fuer alle vier schreibenden Wege unten, deshalb einmal statt viermal:
 * was mit den Zugewiesenen eines Termins passiert (#921).
 */
const EVENT_FANOUT = ' For `entity_type=event`, a reminder set by the person who CREATED the event is also '
  + 'written for everyone assigned to it, as a row of their own - so it reaches them by push and shows up '
  + 'when they open the event, instead of leaving them an empty field that reads as "none set". A reminder '
  + 'an assignee set for themselves is never overwritten by this, a dismissed one is not resurrected unless '
  + 'the time actually changed, and removing the assignment removes the inherited row. Anyone other than the '
  + 'creator sets reminders for themselves only.';

/**
 * `remind_at` ist naiv-UTC; ein Offset wird dorthin umgerechnet (#1364).
 */
const TARGET_VISIBLE = ' The entity has to exist and be visible to the caller under the rule of its own module '
  + '(task and event visibility, shared calendar subscriptions, private subscriptions in personal budget mode); '
  + 'otherwise the answer is 404, the same for both cases. `GET /reminders/pending` and notifications skip a '
  + 'reminder whose entity is hidden from its recipient; the reminder is kept and resumes once the entity is visible again.';

const REMIND_AT_INPUT = ' `remind_at` is stored as UTC without a zone suffix, always as `YYYY-MM-DDTHH:MM:SS`. A value '
  + 'without offset already is UTC and is only brought into that form: missing seconds become `:00`, fractions '
  + 'are dropped, and a date alone becomes midnight UTC, the moment it fired at before. A value with `Z` or a '
  + 'numeric offset is read as an instant and converted: `2026-09-22T18:00:00+02:00` is stored as '
  + '`2026-09-22T16:00:00`. Up to v2.68.0 values were stored as sent; rows with an offset from then are still '
  + 'read as the instant they name and fire on time.';

const WINDOW_EDGE = ' Without `Z` or an offset the value is UTC, as in `remind_at`; a date alone is midnight UTC; fractions of a '
  + 'second are dropped. Percent-encode a `+` in an offset (`%2B`): unencoded it reads as a space and answers 400.';

const UPCOMING = 'The caller\'s own reminders that are not due yet, for a client that schedules them on the device. '
  + 'Both edges of the window count, and it spans at most 14 days. Only what lies after the current moment comes back, also when '
  + '`from` is in the past: a reminder is in `GET /reminders/pending` from the moment it is due and in this list until then, never in '
  + 'both. Sorted by the moment the reminder fires, at most 200 rows, counted after everything the caller may not see is left out. The '
  + 'list is a snapshot: the server keeps rebuilding derived types, and it does not know what a client scheduled.\n\n'
  + 'The rules of `GET /reminders/pending` apply: own, non-dismissed rows only, nothing whose entity is hidden from the caller, no task '
  + 'or event that is gone, nothing from a module the household switched off, and only origins the caller may read. On top of them, a '
  + 'task that is done or archived is left out, and comes back when it is reopened: what a client schedules fires without asking again. '
  + 'A client still has to cancel its own notification when a task is checked off, because this list only changes at the next fetch. '
  + 'An API token needs `calendar:read` '
  + 'to reach this route and a read scope of the module behind each origin for its rows, for example `tasks:read` for `task`; a row the '
  + 'caller may not read is left out, not refused.\n\n'
  + 'Use `fires_at`, not `remind_at`, to schedule: `remind_at` is UTC without a suffix, and rows written up to v2.68.0 may carry an offset.';

export function remindersPaths() {
  return withCaseReasons('reminders', CASE_REASONS, {
    '/api/v1/reminders/pending': {
      get: op({
        summary: 'List pending reminders',
        tag: 'Reminders',
        description: 'The caller\'s own due reminders. With `audience=household` - the version for a shared surface (wall mode), as in `GET /dashboard` - the list is always empty: a reminder belongs to the person who asked for it, never to the household. The bell of the app sends the parameter while a wall is shown, so no toast and no browser notification appears above it.',
        params: [{
          name: 'audience',
          in: 'query',
          required: false,
          description: '`household` asks for the version for a shared surface; it carries no reminders. Anything else means the personal version.',
          schema: { type: 'string', enum: ['household'] },
        }],
      }),
    },
    '/api/v1/reminders/upcoming': {
      get: op({
        summary: 'List upcoming reminders',
        operationId: 'listUpcomingReminders',
        tag: 'Reminders',
        description: UPCOMING,
        params: [{
          name: 'from',
          in: 'query',
          required: true,
          description: `Start of the window, included.${WINDOW_EDGE}`,
          schema: { type: 'string', format: 'date-time' },
        }, {
          name: 'to',
          in: 'query',
          required: true,
          description: `End of the window, included. At most 14 days after \`from\`.${WINDOW_EDGE}`,
          schema: { type: 'string', format: 'date-time' },
        }, {
          name: 'types',
          in: 'query',
          required: false,
          description: 'Comma-separated origins to keep, for example `task,event`. It only narrows: an origin the caller may not read stays out, and an unknown value answers 400. Without it, every origin the caller may read comes back.',
          style: 'form',
          explode: false,
          schema: { type: 'array', minItems: 1, items: { type: 'string', enum: Object.keys(ORIGIN_MODULE) } },
        }, {
          name: 'audience',
          in: 'query',
          required: false,
          description: '`household` asks for the version for a shared surface; it carries no reminders, as in `GET /reminders/pending`.',
          schema: { type: 'string', enum: ['household'] },
        }],
        responses: {
          200: {
            description: 'The upcoming reminders, earliest first',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UpcomingReminderList' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/reminders/all': { get: op({ summary: 'List all reminders for an entity', tag: 'Reminders', description: 'Returns every non-dismissed reminder for the given entity (calendar events support multiple reminders).' }) },
    '/api/v1/reminders': {
      get: op({ summary: 'List reminders', tag: 'Reminders' }),
      post: op({ summary: 'Create reminder', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null), description: '`pantry_item` is rejected with 400: the notification run rebuilds pantry reminders every pass, so a hand-set date would be gone within a minute. Reading and dismissing work as for any other reminder. Other derived types (subscription, inventory) stay settable - there the module only writes when its object changes.' + TARGET_VISIBLE + REMIND_AT_INPUT + EVENT_FANOUT }),
      put: op({ summary: 'Replace reminder set for an entity', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null), description: 'Replaces all reminders of an entity with the given `remind_ats` list (deduplicated, max 5). `pantry_item` is rejected with 400: the notification run rebuilds pantry reminders every pass, so a hand-set date would be gone within a minute. Reading and dismissing work as for any other reminder. Other derived types (subscription, inventory) stay settable - there the module only writes when its object changes. Entries are deduplicated after conversion, so the same instant in two notations is one reminder.' + TARGET_VISIBLE + REMIND_AT_INPUT + EVENT_FANOUT }),
      delete: op({ summary: 'Delete reminders by filter', tag: 'Reminders', stateChanging: true, description: '`pantry_item` is rejected with 400 - the notification run recreates the row every pass. Dismiss it instead.' + EVENT_FANOUT }),
    },
    '/api/v1/reminders/{id}/dismiss': {
      patch: op({ summary: 'Dismiss reminder', tag: 'Reminders', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/reminders/{id}': {
      delete: op({ summary: 'Delete reminder', tag: 'Reminders', params: [idParam()], stateChanging: true, description: '`pantry_item` is rejected with 400 - the notification run recreates the row every pass. Dismiss it instead.' + EVENT_FANOUT }),
    },
  });
}

// #2267: eine Erinnerung gehoert zum Modul ihres Eintrags (Aufgabe, Termin,
// Abo ...). Wer dieses Modul nicht lesen bzw. schreiben darf - als Mitglied
// per Rechteentzug oder als Token ohne den Scope -, bekommt die Absage.
const ORIGIN_READ = '`module_access_denied` (403, the caller may not read the module the reminder\'s entity belongs to - '
  + 'for an API token a `<module>:read` or `<module>:write` scope of that module, e.g. `tasks:read` for `entity_type=task`)';
const ORIGIN_WRITE = '`module_access_denied` (403, the caller may not write to the module the reminder\'s entity belongs to - '
  + 'for an API token the `<module>:write` scope of that module, e.g. `calendar:write` for `entity_type=event`)';
const CASE_REASONS = {
  '/api/v1/reminders/all': { get: ORIGIN_READ },
  '/api/v1/reminders': { get: ORIGIN_READ, post: ORIGIN_WRITE, put: ORIGIN_WRITE, delete: ORIGIN_WRITE },
  '/api/v1/reminders/{id}/dismiss': { patch: ORIGIN_WRITE },
  '/api/v1/reminders/{id}': { delete: ORIGIN_WRITE },
};
