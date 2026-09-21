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
const REMIND_AT_INPUT = ' `remind_at` is UTC without a zone suffix (`YYYY-MM-DDTHH:MM:SS`), and a value without offset is '
  + 'stored as sent. A value with `Z` or a numeric offset is read as an instant and converted into that form: '
  + '`2026-09-22T18:00:00+02:00` is stored as `2026-09-22T16:00:00`. Up to v2.68.0 such a value was stored '
  + 'unchanged; those rows are still read as the instant they name and fire on time.';

export function remindersPaths() {
  return {
    '/api/v1/reminders/pending': { get: op({ summary: 'List pending reminders', tag: 'Reminders' }) },
    '/api/v1/reminders/all': { get: op({ summary: 'List all reminders for an entity', tag: 'Reminders', description: 'Returns every non-dismissed reminder for the given entity (calendar events support multiple reminders).' }) },
    '/api/v1/reminders': {
      get: op({ summary: 'List reminders', tag: 'Reminders' }),
      post: op({ summary: 'Create reminder', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null), description: '`pantry_item` is rejected with 400: the notification run rebuilds pantry reminders every pass, so a hand-set date would be gone within a minute. Reading and dismissing work as for any other reminder. Other derived types (subscription, inventory) stay settable - there the module only writes when its object changes.' + REMIND_AT_INPUT + EVENT_FANOUT }),
      put: op({ summary: 'Replace reminder set for an entity', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null), description: 'Replaces all reminders of an entity with the given `remind_ats` list (deduplicated, max 5). `pantry_item` is rejected with 400: the notification run rebuilds pantry reminders every pass, so a hand-set date would be gone within a minute. Reading and dismissing work as for any other reminder. Other derived types (subscription, inventory) stay settable - there the module only writes when its object changes. Entries are deduplicated after conversion, so the same instant in two notations is one reminder.' + REMIND_AT_INPUT + EVENT_FANOUT }),
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
