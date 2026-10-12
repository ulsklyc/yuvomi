import { op, jsonBody, idParam } from '../helpers.js';

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

export function remindersPaths() {
  return {
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
  };
}
