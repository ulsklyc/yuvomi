import { op, idParam, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../../api/formats.ts';
import { DATE_PATTERN, OPTIONAL_DATE_PATTERN, OPTIONAL_DATETIME_PATTERN } from '../../utils/datetime-pattern.js';
import { MAX_AVATAR_DATA_LENGTH } from '../../utils/avatar-limits.js';
import {
  HOUSEKEEPING_MONTH_PATTERN, MAX_WORKER_NAME, MAX_WORKER_USERNAME, PAYMENT_SCHEDULES, RATE_TYPES,
} from '../../services/housekeeping-fields.js';

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
  + 'An older payment task still on `all` moves to the same rule when its visit is updated, checked out, paid or unpaid. ';
const AMOUNTS_WRITE_NOTE = ' A caller without `housekeeping_view_amounts` writes no amounts: a check-in takes the rate from the profile, '
  + 'check-out keeps the extras, an update keeps rate, extras and minutes, and payment task texts fall back to the household language. '
  + 'The types of the amount fields are checked for every caller all the same. '
  + 'Paying and taking back a payment are refused with 403 and `reason: amounts_hidden`.';

// `last_completed` ist ein Zeitpunkt; ein Offset wird der UTC-Instant (#1364).
const LAST_COMPLETED_INPUT = '`last_completed` with `Z` or a numeric offset is read as an instant and stored as a UTC '
  + 'instant (`YYYY-MM-DDTHH:MM:SS.sssZ`), the same form `/complete` writes. A value without offset is household '
  + 'wall-clock time and is read in the household time zone. Up to v2.68.0 the offset was dropped and its digits '
  + 'kept, and a value without offset was read in the time zone of the server.';

const BODY_ORDER_NOTE = ' A body outside the schema (a text field that is not text, a number as text, a value outside its list) answers 400 '
  + 'with `fields` before anything is looked up, so it comes before the 404 and 409 of the route.';

/**
 * The answers of an operation with its real success status (#2810).
 * @param {number} status
 * @param {string} description
 * @param {Record<string, unknown>} [extra]
 */
const answers = (status, description, extra = {}) => ({
  [status]: { description },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/InternalServerError' },
  ...extra,
});

/**
 * A JSON body that must be sent.
 * @param {Record<string, unknown>} schema
 */
const body = (schema) => ({
  required: true,
  description: 'JSON request body',
  content: { 'application/json': { schema: { type: 'object', ...schema } } },
});

/** @param {string} name @param {string} what */
const pathId = (name, what) => idParam(name, `${what}, plain decimal digits.`);

// Ziffern-Text ist eine Altform (#2810): aeltere App-Staende schickten die
// Kraft-ID aus einem Formularfeld als Text. Die App schickt heute Zahlen.
const DIGIT_TEXT = { type: 'string', pattern: '^[0-9]+$' };
const LEGACY_NOTE = 'Digit text is accepted as a legacy form (older app versions send it).';

/**
 * A record id in the body: a whole number, digit text as the legacy form.
 * `0` and below stay the route's own 400.
 * @param {string} description
 * @param {{ nullable?: boolean, empty?: boolean }} [options]
 */
const bodyId = (description, { nullable = false, empty = false } = {}) => ({
  anyOf: [
    { type: 'integer' },
    DIGIT_TEXT,
    ...(nullable ? [{ type: 'null' }] : []),
    ...(empty ? [{ const: '' }] : []),
  ],
  description: `${description} ${LEGACY_NOTE}`,
});

/**
 * A text field the route trims. The length counts the text as sent; the
 * route keeps its own check after trimming. `nullable`: `null` and `""`
 * mean none.
 * @param {number} max
 * @param {boolean} nullable
 * @param {string} [description]
 */
const text = (max, nullable, description = '') => ({
  type: nullable ? ['string', 'null'] : 'string',
  maxLength: max,
  description: `${description ? `${description} ` : ''}At most ${max} characters as sent${nullable ? '; `null` or `""` means none' : '; empty after trimming spaces is refused'}.`,
});

/**
 * A value of a fixed list, or `null`/`""` for its default.
 * @param {readonly string[]} values
 * @param {string} fallback
 */
const listed = (values, fallback) => ({
  type: ['string', 'null'],
  enum: [...values, '', null],
  description: `One of ${values.map((v) => `\`${v}\``).join(', ')}; \`null\`, \`""\` or left out is \`${fallback}\`.`,
});

/**
 * An amount: a number, never text. Its bound (not negative) stays the route's.
 * @param {string} description
 * @param {boolean} nullable
 */
const amount = (description, nullable) => ({
  type: nullable ? ['number', 'null'] : 'number',
  description: `${description} A number, not text; below 0 is refused by the route.`,
});

const TIMEZONE_FIELD = { type: 'string', description: 'The IANA time zone the client displays in; an unknown name is ignored.' };
const LOCAL_DATE_FIELD = { type: 'string', pattern: DATE_PATTERN, description: 'Older clients: their day `YYYY-MM-DD` (the shape only, no calendar check), read with `timezone_offset_minutes`.' };
const OFFSET_FIELD = { type: 'integer', description: 'Older clients: their offset from UTC in minutes, read with `local_date`.' };

/** The day context in the query (dashboard, worker profiles). */
const DAY_QUERY = [
  { name: 'timezone', in: 'query', required: false, description: TIMEZONE_FIELD.description, schema: { type: 'string' } },
  { name: 'local_date', in: 'query', required: false, description: LOCAL_DATE_FIELD.description, schema: { type: 'string', pattern: DATE_PATTERN } },
  { name: 'timezone_offset_minutes', in: 'query', required: false, description: `${OFFSET_FIELD.description} Plain decimal digits with an optional minus.`, schema: { type: 'integer' } },
];

const MONTH_QUERY = {
  name: 'month',
  in: 'query',
  required: false,
  description: 'The month `YYYY-MM` (month 01 to 12, year 1001 to 9999); left out or empty is the current household month. Given twice is refused.',
  schema: { type: 'string', pattern: HOUSEKEEPING_MONTH_PATTERN },
};

const WORKER_BODY = body({
  required: ['display_name', 'daily_rate'],
  properties: {
    id: bodyId('The housekeeper to update, a whole number; `null` or left out creates a new one. A full replace: `phone`, `email`, `notes` and `hourly_rate` left out are cleared (0 for the rate).', { nullable: true }),
    display_name: text(MAX_WORKER_NAME, false),
    username: text(MAX_WORKER_USERNAME, true, 'The sign-in name: 3 to 64 letters, digits, dots, hyphens or underscores after trimming (else 400 `housekeeping_username_invalid`); left out keeps the stored one.'),
    phone: text(MAX_SHORT, true),
    email: text(MAX_TITLE, true),
    birth_date: { type: ['string', 'null'], pattern: OPTIONAL_DATE_PATTERN, description: 'The birth date `YYYY-MM-DD`; a day that does not exist is refused. `null` or `""` means none.' },
    birth_year_unknown: { type: 'boolean', description: 'Only day and month of `birth_date` are known (#2095).' },
    daily_rate: amount('The daily rate.', false),
    hourly_rate: amount('The hourly rate; `null` or left out is 0.', true),
    rate_type: listed(RATE_TYPES, 'daily'),
    payment_schedule: listed(PAYMENT_SCHEDULES, 'monthly'),
    calendar_color: { type: ['string', 'null'], description: 'A HEX color `#RRGGBB`; `null`, `""` or left out keeps the stored one (new: `#0891B2`).' },
    avatar_color: { type: ['string', 'null'], description: 'A HEX color `#RRGGBB`; `null`, `""` or left out keeps the stored one (new: `#0891B2`).' },
    avatar_data: {
      type: ['string', 'null'],
      maxLength: MAX_AVATAR_DATA_LENGTH,
      description: `A PNG, JPEG or WebP data URL, at most ${MAX_AVATAR_DATA_LENGTH} characters as sent; \`null\` or \`""\` removes the picture, left out keeps it.`,
    },
    notes: text(MAX_TEXT, true),
  },
});

const CHECK_IN_BODY = body({
  required: ['worker_id'],
  properties: {
    worker_id: bodyId('The housekeeper, a whole number.'),
    daily_rate: amount('The rate of the visit; required with `housekeeping_view_amounts` (0 for an hourly rate).', false),
    extras: amount('Extras; `null` or left out is 0.', true),
    event_title: text(MAX_TITLE, true, 'Title of the calendar entry.'),
    payment_title: text(MAX_TITLE, true, 'Title of the payment task.'),
    payment_description: text(MAX_TEXT, true, 'Description of the payment task.'),
    timezone: TIMEZONE_FIELD,
    local_date: LOCAL_DATE_FIELD,
    timezone_offset_minutes: { ...OFFSET_FIELD, type: ['integer', 'null'] },
  },
});

const CHECK_OUT_BODY = body({
  required: ['worker_id'],
  properties: {
    worker_id: bodyId('The housekeeper, a whole number.'),
    extras: amount('Extras; `null` or left out keeps those of the session.', true),
  },
});

const VISIT_BODY = body({
  required: ['date'],
  properties: {
    date: { type: 'string', pattern: DATE_PATTERN, description: 'The day of the visit `YYYY-MM-DD`; a day that does not exist is refused.' },
    original_date: { type: ['string', 'null'], pattern: OPTIONAL_DATE_PATTERN, description: 'The day the form showed `YYYY-MM-DD`; `null`, `""` or left out: the day of the stored visit.' },
    daily_rate: amount('The rate; required unless the visit has an hourly rate.', true),
    extras: amount('Extras; `null` or left out is 0 (a full replace).', true),
    minutes_worked: { type: ['integer', 'null'], description: 'Worked minutes of a visit with an hourly rate (the amount follows from them); `null` or left out keeps them. Ignored for a daily rate.' },
    event_title: text(MAX_TITLE, true, 'Title of the calendar entry.'),
    payment_title: text(MAX_TITLE, true, 'Title of the payment task.'),
    payment_description: text(MAX_TEXT, true, 'Description of the payment task.'),
    receipt_document_id: bodyId('A document of the Documents module as the receipt, a whole number; `null` or `""` clears it, left out keeps it.', { nullable: true, empty: true }),
  },
});

const TASK_FREQUENCY = { type: 'integer', minimum: 1, description: 'Every how many days, a whole number of at least 1.' };
const LAST_COMPLETED = {
  type: ['string', 'null'],
  pattern: OPTIONAL_DATETIME_PATTERN,
  description: '`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS[.f]]` with an optional `Z` or offset; `null` or `""` means never.',
};

export function housekeepingPaths() {
  return withCaseReasons('housekeeping', CASE_REASONS, {
    '/api/v1/housekeeping/dashboard': {
      get: withValidationRefusal(op({ summary: 'Get housekeeping dashboard', tag: 'Housekeeping', params: DAY_QUERY, description: RECEIPT_NOTE + AMOUNTS_NOTE + HOUSEHOLD_DAY_NOTE })),
    },
    '/api/v1/housekeeping/task-templates': {
      get: op({ summary: 'List housekeeping task templates', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/worker': {
      get: withValidationRefusal(op({ summary: 'Get primary housekeeper profile', tag: 'Housekeeping', params: DAY_QUERY, description: RECEIPT_NOTE + AMOUNTS_NOTE + HOUSEHOLD_DAY_NOTE })),
      post: op({
        summary: 'Create or update housekeeper profile',
        tag: 'Housekeeping',
        admin: true,
        stateChanging: true,
        requestBody: WORKER_BODY,
        responses: answers(200, 'Housekeeper updated', { 201: { description: 'Housekeeper created' } }),
        description: 'With `id` a full replace of the profile: only `display_name` and `daily_rate` are required, and `phone`, `email`, `notes` and `hourly_rate` left out are cleared. '
          + '`birth_year_unknown` (boolean) saves a birthday known by day and month only (#2095): the server stores the placeholder year 2000 whatever year is sent, and profiles return the flag next to `birth_date`. Omitted, the stored flag stays unless a different date arrives. '
          + 'The admin check comes first: a member gets 403, never a 400 that names fields.' + BODY_ORDER_NOTE,
      }),
    },
    '/api/v1/housekeeping/workers': {
      get: withValidationRefusal(op({ summary: 'List housekeeper profiles', tag: 'Housekeeping', params: DAY_QUERY, description: 'Next to `data`, `can_manage` is true when the caller may create and edit profiles (`POST /housekeeping/worker`): write access to the module and the admin role. ' + RECEIPT_NOTE + AMOUNTS_NOTE + HOUSEHOLD_DAY_NOTE })),
    },
    '/api/v1/housekeeping/summary': {
      get: withValidationRefusal(op({ summary: 'Get monthly housekeeping summary', tag: 'Housekeeping', params: [MONTH_QUERY], description: RECEIPT_NOTE + AMOUNTS_NOTE })),
    },
    '/api/v1/housekeeping/work-sessions': {
      get: withValidationRefusal(op({ summary: 'List housekeeping work sessions for a month', tag: 'Housekeeping', params: [MONTH_QUERY], description: RECEIPT_NOTE + AMOUNTS_NOTE })),
    },
    '/api/v1/housekeeping/work-sessions/check-in': {
      post: op({
        summary: 'Check in a housekeeper',
        tag: 'Housekeeping',
        description: HOUSEHOLD_DAY_NOTE.trim() + PAYMENT_TASK_NOTE + AMOUNTS_WRITE_NOTE + BODY_ORDER_NOTE,
        stateChanging: true,
        requestBody: CHECK_IN_BODY,
        responses: answers(201, 'Checked in'),
      }),
    },
    '/api/v1/housekeeping/work-sessions/check-out': {
      post: withValidationRefusal(op({ summary: 'Check out a housekeeper', tag: 'Housekeeping', description: AMOUNTS_WRITE_NOTE.trim() + BODY_ORDER_NOTE, stateChanging: true, requestBody: CHECK_OUT_BODY })),
    },
    '/api/v1/housekeeping/work-sessions/{id}/reopen': {
      post: withValidationRefusal(op({ summary: 'Take a check-out back (undo)', tag: 'Housekeeping', params: [pathId('id', 'Visit ID')], description: 'The undo of a check-out (R23): the visit is open again - no end, and for an hourly rate no worked minutes and an amount of 0, as at check-in. Calendar event and payment task stay. Only within 10 minutes of the check-out, only while unpaid, and only while the housekeeper has no other open session. A body is ignored.', stateChanging: true })),
    },
    '/api/v1/housekeeping/visits': {
      get: withValidationRefusal(op({
        summary: 'List housekeeping visits for a month',
        tag: 'Housekeeping',
        params: [
          MONTH_QUERY,
          { name: 'worker_id', in: 'query', required: false, description: 'Only the visits of this housekeeper, plain decimal digits; 0 or below is refused, an unknown one gives an empty list.', schema: { type: 'integer' } },
        ],
        description: VISIT_CAPABILITY_NOTE + RECEIPT_NOTE + AMOUNTS_NOTE,
      })),
    },
    '/api/v1/housekeeping/visits/{id}': {
      get: withValidationRefusal(op({ summary: 'Get housekeeping visit', tag: 'Housekeeping', params: [pathId('id', 'Visit ID')], description: VISIT_CAPABILITY_NOTE + RECEIPT_NOTE + AMOUNTS_NOTE })),
      put: op({
        summary: 'Update housekeeping visit',
        tag: 'Housekeeping',
        params: [pathId('id', 'Visit ID')],
        description: 'A full replace: `date` is required, `extras` left out is 0. ' + RECEIPT_WRITE_NOTE + AMOUNTS_WRITE_NOTE
          + ' A paid visit can be changed by an admin only (403 `admin_required`); a valid request meets that 403 as before, a request outside the schema is a 400 first.' + BODY_ORDER_NOTE,
        stateChanging: true,
        documentDeleteConflict: true,
        requestBody: VISIT_BODY,
        responses: answers(200, 'Visit updated', { 403: { $ref: '#/components/responses/Forbidden' } }),
      }),
      delete: withValidationRefusal(op({ summary: 'Delete housekeeping visit', tag: 'Housekeeping', params: [pathId('id', 'Visit ID')], stateChanging: true })),
    },
    '/api/v1/housekeeping/visits/{id}/pay': {
      post: withValidationRefusal(op({ summary: 'Mark housekeeping visit as paid', tag: 'Housekeeping', params: [pathId('id', 'Visit ID')], description: 'Needs `housekeeping_view_amounts`; without it 403 with `reason: amounts_hidden`. A body is ignored.', stateChanging: true })),
    },
    '/api/v1/housekeeping/visits/{id}/unpay': {
      post: withValidationRefusal(op({
        summary: 'Take back the payment of a housekeeping visit',
        description: 'Clears `paid_at` and reopens a linked payment task that is done. A visit that is not paid is returned unchanged. Needs `housekeeping_view_amounts`; without it 403 with `reason: amounts_hidden`. A body is ignored.',
        tag: 'Housekeeping',
        admin: true,
        params: [pathId('id', 'Visit ID')],
        stateChanging: true,
      })),
    },
    '/api/v1/housekeeping/decay-tasks': {
      get: op({ summary: 'List housekeeping decay tasks', tag: 'Housekeeping' }),
      post: op({
        summary: 'Create housekeeping decay task',
        tag: 'Housekeeping',
        stateChanging: true,
        requestBody: body({
          required: ['name', 'area', 'frequency_days'],
          properties: { name: text(MAX_TITLE, false), area: text(MAX_SHORT, false), frequency_days: TASK_FREQUENCY, last_completed: LAST_COMPLETED },
        }),
        responses: answers(201, 'Task created'),
        description: LAST_COMPLETED_INPUT,
      }),
    },
    '/api/v1/housekeeping/decay-tasks/{taskId}': {
      patch: withValidationRefusal(op({
        summary: 'Update housekeeping decay task',
        tag: 'Housekeeping',
        params: [pathId('taskId', 'Decay task ID')],
        stateChanging: true,
        requestBody: body({
          properties: { name: text(MAX_TITLE, false), area: text(MAX_SHORT, false), frequency_days: TASK_FREQUENCY, last_completed: LAST_COMPLETED },
        }),
        description: `A partial update: a field left out stays as it is; \`{}\` changes nothing. ${LAST_COMPLETED_INPUT}${BODY_ORDER_NOTE}`,
      })),
      delete: withValidationRefusal(op({ summary: 'Delete housekeeping decay task', tag: 'Housekeeping', params: [pathId('taskId', 'Decay task ID')], stateChanging: true })),
    },
    '/api/v1/housekeeping/decay-tasks/{taskId}/complete': {
      post: withValidationRefusal(op({ summary: 'Mark housekeeping decay task complete', tag: 'Housekeeping', params: [pathId('taskId', 'Decay task ID')], description: 'A body is ignored.', stateChanging: true })),
    },
    // Der Pfad sagt `housekeeping`, geschrieben wird in den Einkauf - also
    // steht auch die 403 ausgeschrieben, wie bei /meals/{id}/to-shopping-list
    // (#1351, Regel aus #1290).
    '/api/v1/housekeeping/supply-requests': {
      post: op({
        summary: 'Create housekeeping supply request and shopping item',
        tag: 'Housekeeping',
        description: 'Creates a shopping item, and a shopping list when the household has none yet, so it requires write access to the `shopping` module in addition to `housekeeping` - a credential scoped to housekeeping alone is refused with 403. That check comes first: without it the answer is 403, also for a body outside the schema.',
        stateChanging: true,
        requestBody: body({
          required: ['name'],
          properties: { name: text(MAX_TITLE, false), quantity: text(MAX_SHORT, true, 'The quantity as free text.') },
        }),
        responses: answers(201, 'Supply request and shopping item created', { 403: { $ref: '#/components/responses/Forbidden' } }),
      }),
    },
    '/api/v1/housekeeping/maintenance-log': {
      get: op({ summary: 'List housekeeping maintenance log entries', tag: 'Housekeeping' }),
      post: op({
        summary: 'Create housekeeping maintenance log entry',
        tag: 'Housekeeping',
        stateChanging: true,
        requestBody: body({
          required: ['description'],
          properties: {
            description: text(MAX_TEXT, false),
            photo_url: { type: ['string', 'null'], description: 'A PNG, JPEG or WebP data URL whose content matches its type, at most 6 MiB after trimming; `null` or `""` means none.' },
          },
        }),
        responses: answers(201, 'Entry created'),
      }),
    },
  });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const WORKER_GONE = '`housekeeping_worker_not_found` (404, the housekeeper was deleted)';
const VISIT_GONE = '`housekeeping_visit_not_found` (404, the visit was deleted)';
const TASK_GONE = '`housekeeping_task_not_found` (404, the task was deleted)';
const SHOPPING_WRITE_REQUIRED = '`cross_module_access` (403, a supply request writes to the shopping list and needs write access to it - for API tokens a `shopping:write` scope)';
const CASE_REASONS = {
  '/api/v1/housekeeping/supply-requests': { post: SHOPPING_WRITE_REQUIRED },
  '/api/v1/housekeeping/worker': {
    post: `${WORKER_GONE}, \`housekeeping_username_invalid\` (400, the username breaks the naming rule), `
      + '`housekeeping_username_taken` (409, another account uses the username)',
  },
  '/api/v1/housekeeping/work-sessions/check-in': {
    post: `${WORKER_GONE}, \`housekeeping_already_checked_in\` (409, the housekeeper has an open session)`,
  },
  '/api/v1/housekeeping/work-sessions/check-out': {
    post: '`housekeeping_open_session_not_found` (404, there is no open session; somebody checked out already)',
  },
  '/api/v1/housekeeping/work-sessions/{id}/reopen': {
    post: `${VISIT_GONE}, \`housekeeping_visit_open\` (409, the visit has no check-out), `
      + '`housekeeping_reopen_expired` (409, paid or checked out more than 10 minutes ago), '
      + '`housekeeping_already_checked_in` (409, the housekeeper has another open session)',
  },
  '/api/v1/housekeeping/visits/{id}': { get: VISIT_GONE, put: VISIT_GONE, delete: VISIT_GONE },
  '/api/v1/housekeeping/visits/{id}/pay': { post: VISIT_GONE },
  '/api/v1/housekeeping/visits/{id}/unpay': { post: VISIT_GONE },
  '/api/v1/housekeeping/decay-tasks/{taskId}': { patch: TASK_GONE, delete: TASK_GONE },
  '/api/v1/housekeeping/decay-tasks/{taskId}/complete': { post: TASK_GONE },
};
