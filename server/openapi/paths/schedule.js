import { op, idParam, withCaseReasons, withValidationRefusal } from '../helpers.js';
import { MAX_TITLE } from '../../api/formats.ts';
import { COLOR_PATTERN, DATE_PATTERN, OPTIONAL_DATE_PATTERN, TIME_PATTERN } from '../../utils/datetime-pattern.js';
import {
  MAX_CUSTOM_FIELD_NAME, MAX_CYCLE_LENGTH, MAX_FIELD_VALUE_LENGTH, MAX_ICON_NAME_LENGTH, MAX_PATTERN_DAY_ROWS,
  MAX_REMINDER_OFFSET_MINUTES, MAX_SCHEDULE_NOTE, MAX_SHORT_CODE, MAX_WEEKLY_HOURS, MIN_CYCLE_LENGTH, MIN_WEEKLY_HOURS,
} from '../../services/schedule-fields.js';

/**
 * Schichtplan (#786).
 *
 * `/entries` ist die einzige Route, die rechnet statt zu speichern: sie loest
 * Muster und Ausnahmen zum Lesezeitpunkt auf und legt nichts in
 * `calendar_events` ab. Der Zeitraum ist begrenzt - ohne Grenze baut ein Aufruf
 * einen Eintrag je Tag und Mitglied.
 *
 * Seit #2810 traegt jede Operation mit Rumpf ein Anfrage-Schema, das
 * validateRequest() vor dem Handler prueft. Unbekannte Felder bleiben
 * erlaubt: die App schickt Formularreste wie `mode` und `shift_preset` mit.
 */

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
const FORBIDDEN = { 403: { $ref: '#/components/responses/Forbidden' } };
/** @param {string} what */
const notFound = (what) => ({ 404: { description: `${what} not found` } });

/**
 * A JSON body. `required: false` for a partial update whose fields are all
 * optional: a request without a body reaches the handler as before.
 * @param {Record<string, unknown>} schema
 * @param {boolean} [required]
 */
const body = (schema, required = true) => ({
  required,
  description: 'JSON request body',
  content: { 'application/json': { schema: { type: 'object', ...schema } } },
});

/** @param {string} name @param {string} what */
const pathId = (name, what) => idParam(name, `${what}, plain decimal digits.`);
const dayKeyParam = {
  name: 'dateKey',
  in: 'path',
  required: true,
  description: 'The day `YYYY-MM-DD`; a day that does not exist is refused by the route.',
  schema: { type: 'string', pattern: DATE_PATTERN },
};

// Ziffern-Text ist eine Altform (#2810): `id()` las die Ids per parseInt.
// Die App schickt Zahlen.
const LEGACY_NOTE = 'Digit text is accepted as a legacy form.';

/**
 * A record id in the body: a whole number, digit text as the legacy form.
 * `0` and below stay the route's own 400.
 * @param {string} description
 * @param {{ nullable?: boolean }} [options]
 */
const bodyId = (description, { nullable = false } = {}) => ({
  anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^[0-9]+$' }, ...(nullable ? [{ type: 'null' }] : [])],
  description: `${description} ${LEGACY_NOTE}`,
});

/**
 * A text of at most `max` characters as sent; the route trims and counts again.
 * @param {number} max
 * @param {boolean} nullable
 * @param {string} description
 */
const text = (max, nullable, description) => ({
  type: nullable ? ['string', 'null'] : 'string',
  maxLength: max,
  description: `${description} At most ${max} characters as sent.`,
});

/** @param {string} pattern */
const optionalPattern = (pattern) => `^(?:${pattern.slice(1, -1)})?$`;
/** @param {string} description */
const day = (description) => ({ type: 'string', pattern: DATE_PATTERN, description: `${description} \`YYYY-MM-DD\`; a day that does not exist is refused by the route.` });
/** @param {string} description */
const optionalDay = (description) => ({ type: ['string', 'null'], pattern: OPTIONAL_DATE_PATTERN, description: `${description} \`YYYY-MM-DD\`; \`null\` or \`""\` means none.` });
/** @param {string} description */
const time = (description) => ({ type: ['string', 'null'], pattern: optionalPattern(TIME_PATTERN), description: `${description} \`HH:MM\`; \`null\` or \`""\` means none. Start and end come together.` });

const fieldValues = {
  type: ['object', 'null'],
  propertyNames: { pattern: '^[0-9]+$' },
  additionalProperties: { type: ['string', 'null'], maxLength: MAX_FIELD_VALUE_LENGTH },
  description: `Values of the custom fields attached to the shift type, keyed by the custom field id (digit text). A value is text of at most ${MAX_FIELD_VALUE_LENGTH} characters as sent; \`null\` or empty means not set.`,
};
const noteField = text(MAX_SCHEDULE_NOTE, true, 'A note; `null` or `""` means none.');
const userIdField = bodyId('The household member, a whole number; `null` or left out is the caller. A member may only name themselves (else 403 before any other check).', { nullable: true });
const optionalShiftTypeId = bodyId('The shift type, a whole number; `null` or left out is a free day.', { nullable: true });
const requiredShiftTypeId = {
  ...bodyId('The shift type, a whole number.'),
  'x-reason': { required: 'schedule_shift_type_required' },
};
const reminderOffset = {
  type: ['integer', 'null'],
  minimum: 0,
  maximum: MAX_REMINDER_OFFSET_MINUTES,
  description: `Minutes before the start to remind, 0-${MAX_REMINDER_OFFSET_MINUTES}; \`null\` or left out is no own reminder.`,
};

const shiftTypeFields = {
  name: text(MAX_TITLE, false, 'The name; empty after trimming spaces is refused.'),
  short_code: text(MAX_SHORT_CODE, true, 'A short code; `null` or `""` means none.'),
  start_time: time('Start time'),
  end_time: time('End time'),
  color: { type: ['string', 'null'], pattern: optionalPattern(COLOR_PATTERN), description: 'A HEX color `#RRGGBB`; `null` or `""` is the default (new) or keeps the stored one (update).' },
  icon: text(MAX_ICON_NAME_LENGTH, true, 'A Lucide icon name of lowercase letters, digits and hyphens (checked by the route); `null` or `""` means none.'),
};

const patternFields = {
  name: text(MAX_TITLE, false, 'The name; empty after trimming spaces is refused.'),
  anchor_date: day('The first day of the cycle'),
  cycle_length: {
    type: 'integer',
    minimum: MIN_CYCLE_LENGTH,
    maximum: MAX_CYCLE_LENGTH,
    description: `Days of one cycle, ${MIN_CYCLE_LENGTH}-${MAX_CYCLE_LENGTH}.`,
  },
  valid_from: optionalDay('First day the pattern applies'),
  valid_until: optionalDay('Last day the pattern applies'),
  is_active: { type: 'boolean', description: 'A boolean, not text or a number.' },
};

const overrideFields = {
  user_id: userIdField,
  shift_type_id: optionalShiftTypeId,
  note: noteField,
  field_values: fieldValues,
};

const extraFields = {
  user_id: userIdField,
  shift_type_id: requiredShiftTypeId,
  note: noteField,
  reminder_offset_minutes: reminderOffset,
  field_values: fieldValues,
};

/**
 * @param {string} name
 * @param {boolean} required
 */
const queryDay = (name, required) => ({
  name,
  in: 'query',
  required,
  description: required ? 'The day `YYYY-MM-DD`.' : 'The day `YYYY-MM-DD`; left out or empty means unbounded.',
  schema: { type: 'string', pattern: required ? DATE_PATTERN : OPTIONAL_DATE_PATTERN },
});
/** @param {string} description */
const queryUserId = (description) => ({
  name: 'user_id', in: 'query', required: false, description: `${description} Plain decimal digits; given twice is refused.`, schema: { type: 'integer' },
});

const ORDER_NOTE = ' A request outside the schema answers 400 before anything is looked up, so it comes before the 404 and 403 of the route.';
const OWNER_NOTE = ' A member who names another member in `user_id` gets 403 before the request is checked any further; an admin may name anyone.';

/** Entries, shift types, their fields and the custom fields. */
function shiftTypePaths() {
  return {
    '/api/v1/schedule/entries': {
      get: op({
        summary: 'Resolve schedule entries for a date range',
        description: 'Computed from patterns and overrides at read time; nothing is written to the calendar. The range is capped at 731 days.',
        tag: 'Schedule',
        params: [queryDay('from', true), queryDay('to', true), queryUserId('Limit to one household member; an unknown one answers 404.')],
        responses: answers(200, 'Entries', notFound('User')),
      }),
    },
    '/api/v1/schedule/shift-types': {
      get: op({ summary: 'List shift types', tag: 'Schedule' }),
      post: op({
        summary: 'Create a shift type',
        description: 'Any member may add one.',
        tag: 'Schedule',
        stateChanging: true,
        requestBody: body({ required: ['name'], properties: shiftTypeFields }),
        responses: answers(201, 'Shift type created'),
      }),
    },
    '/api/v1/schedule/shift-types/{id}': {
      put: op({
        summary: 'Update a shift type',
        description: `Only its creator or an administrator. A partial update: a field left out stays as it is.${ORDER_NOTE}`,
        tag: 'Schedule',
        params: [pathId('id', 'Shift type ID')],
        stateChanging: true,
        requestBody: body({ properties: shiftTypeFields }, false),
        responses: answers(200, 'Shift type updated', { ...FORBIDDEN, ...notFound('Shift type') }),
      }),
      delete: op({
        summary: 'Delete a shift type',
        description: 'Only its creator or an administrator. Answers 409 while a pattern or override still references it.',
        tag: 'Schedule',
        params: [pathId('id', 'Shift type ID')],
        stateChanging: true,
        responses: answers(204, 'Shift type deleted', { ...FORBIDDEN, ...notFound('Shift type'), 409: { description: 'The shift type is still in use' } }),
      }),
    },
    '/api/v1/schedule/shift-types/{id}/fields': {
      put: op({
        summary: 'Replace which custom fields are attached to a shift type',
        description: `Deletes and re-inserts the whole attachment set in one transaction, same shape as PUT /patterns/{id}/days. Rejects a custom_field_id that does not exist or repeats within the payload.${ORDER_NOTE}`,
        tag: 'Schedule',
        params: [pathId('id', 'Shift type ID')],
        stateChanging: true,
        requestBody: body({
          required: ['fields'],
          properties: {
            fields: {
              type: 'array',
              items: {
                type: 'object',
                required: ['custom_field_id', 'position'],
                properties: {
                  custom_field_id: bodyId('The custom field, a whole number.'),
                  position: { type: 'integer', minimum: 0, description: 'The order, a whole number from 0; may repeat.' },
                  show_in_overlay: { type: 'boolean', description: 'Show the value in the overlay; left out is false.' },
                },
              },
            },
          },
        }),
        responses: answers(200, 'Fields replaced', { ...FORBIDDEN, ...notFound('Shift type') }),
      }),
    },
    '/api/v1/schedule/household-members': {
      get: op({
        summary: 'List people selectable for the Overview tab',
        description: 'Real household members only - filtered through the strict household member predicate, so housekeeping staff and split-expense guests never appear.',
        tag: 'Schedule',
      }),
    },
    '/api/v1/schedule/custom-fields': {
      get: op({ summary: 'List custom fields', description: 'Household-wide definitions, defined once and attachable to any number of shift types.', tag: 'Schedule' }),
      post: op({
        summary: 'Create a custom field',
        description: 'Any member may add one.',
        tag: 'Schedule',
        stateChanging: true,
        requestBody: body({ required: ['name'], properties: { name: text(MAX_CUSTOM_FIELD_NAME, false, 'The name; empty after trimming spaces is refused.') } }),
        responses: answers(201, 'Custom field created'),
      }),
    },
    '/api/v1/schedule/custom-fields/{id}': {
      put: op({
        summary: 'Rename a custom field',
        description: `Only its creator or an administrator. \`name\` left out keeps it.${ORDER_NOTE}`,
        tag: 'Schedule',
        params: [pathId('id', 'Custom field ID')],
        stateChanging: true,
        requestBody: body({ properties: { name: text(MAX_CUSTOM_FIELD_NAME, false, 'The name; `null` or empty after trimming spaces is refused.') } }, false),
        responses: answers(200, 'Custom field renamed', { ...FORBIDDEN, ...notFound('Custom field') }),
      }),
      delete: op({
        summary: 'Delete a custom field',
        description: 'Only its creator or an administrator. Cascades: also removes its shift-type attachments and any values already recorded against it.',
        tag: 'Schedule',
        params: [pathId('id', 'Custom field ID')],
        stateChanging: true,
        responses: answers(204, 'Custom field deleted', { ...FORBIDDEN, ...notFound('Custom field') }),
      }),
    },
  };
}

/** Cycle patterns and their days. */
function patternPaths() {
  return {
    '/api/v1/schedule/patterns': {
      get: op({
        summary: 'List cycle patterns',
        tag: 'Schedule',
        params: [queryUserId('Only the patterns of this household member; an unknown one answers 404.')],
        responses: answers(200, 'Patterns', notFound('User')),
      }),
      post: op({
        summary: 'Create a cycle pattern',
        description: OWNER_NOTE.trim(),
        tag: 'Schedule',
        stateChanging: true,
        requestBody: body({ required: ['name', 'anchor_date', 'cycle_length'], properties: { user_id: userIdField, ...patternFields } }),
        responses: answers(201, 'Pattern created', FORBIDDEN),
      }),
    },
    '/api/v1/schedule/patterns/{id}': {
      put: op({
        summary: 'Update a cycle pattern',
        description: `Only the owner or an administrator. A partial update: a field left out stays as it is; \`user_id\` is ignored.${ORDER_NOTE}`,
        tag: 'Schedule',
        params: [pathId('id', 'Pattern ID')],
        stateChanging: true,
        requestBody: body({ properties: { user_id: { description: 'Ignored: a pattern keeps its owner.' }, ...patternFields } }, false),
        responses: answers(200, 'Pattern updated', { ...FORBIDDEN, ...notFound('Pattern') }),
      }),
      delete: op({
        summary: 'Delete a cycle pattern',
        description: 'Its cycle days go with it.',
        tag: 'Schedule',
        params: [pathId('id', 'Pattern ID')],
        stateChanging: true,
        responses: answers(204, 'Pattern deleted', { ...FORBIDDEN, ...notFound('Pattern') }),
      }),
    },
    '/api/v1/schedule/patterns/{id}/days': {
      get: op({ summary: 'List the cycle days of a pattern', tag: 'Schedule', params: [pathId('id', 'Pattern ID')], responses: answers(200, 'Cycle days', notFound('Pattern')) }),
      put: op({
        summary: 'Replace all cycle days of a pattern',
        description: `Deletes and re-inserts every day of the cycle in one transaction. A position may repeat - a cycle day can carry several classes at different times (a timetable), each its own shift type; an omitted position is a free day. The days array is capped at ${MAX_PATTERN_DAY_ROWS} rows; a position must lie below the cycle length.${ORDER_NOTE}`,
        tag: 'Schedule',
        params: [pathId('id', 'Pattern ID')],
        stateChanging: true,
        requestBody: body({
          required: ['days'],
          properties: {
            days: {
              type: 'array',
              maxItems: MAX_PATTERN_DAY_ROWS,
              items: {
                type: 'object',
                required: ['position'],
                properties: {
                  position: { type: 'integer', minimum: 0, description: 'The cycle day, a whole number from 0, below the cycle length.' },
                  shift_type_id: optionalShiftTypeId,
                  field_values: fieldValues,
                },
              },
            },
          },
        }),
        responses: answers(200, 'Cycle days replaced', { ...FORBIDDEN, ...notFound('Pattern') }),
      }),
    },
  };
}

/** Overrides, extra shifts, the feed and the own preferences. */
function dayPaths() {
  return {
    '/api/v1/schedule/overrides': {
      get: op({
        summary: 'List per-day overrides',
        tag: 'Schedule',
        params: [queryUserId('Only the overrides of this household member; an unknown one answers 404.'), queryDay('from', false), queryDay('to', false)],
        responses: answers(200, 'Overrides', notFound('User')),
      }),
      delete: op({
        summary: 'Remove overrides across a date range',
        description: `The counterpart to /overrides/fill - a single indexed delete, so it carries the read-side range cap (731 days) rather than the smaller one on fill. A range whose \`from\` lies after \`to\` is refused with 400 and reason \`range_reversed\`.${OWNER_NOTE}`,
        tag: 'Schedule',
        params: [queryUserId('Household member; defaults to the caller.'), queryDay('from', true), queryDay('to', true)],
        stateChanging: true,
        responses: answers(200, 'Overrides removed', FORBIDDEN),
      }),
    },
    '/api/v1/schedule/overrides/fill': {
      post: op({
        summary: 'Fill a date range of overrides in one call',
        description: `Upserts the same shift type (or NULL for a free day) across an inclusive range - e.g. marking a vacation - instead of one PUT per day. Writes real rows, so it is capped separately from /entries at 100 days. A range whose \`from\` lies after \`to\` is refused with 400 and reason \`range_reversed\`.${OWNER_NOTE}`,
        tag: 'Schedule',
        stateChanging: true,
        requestBody: body({ required: ['from', 'to'], properties: { from: day('The first day'), to: day('The last day, inclusive,'), ...overrideFields } }),
        responses: answers(200, 'Overrides written', FORBIDDEN),
      }),
    },
    '/api/v1/schedule/overrides/{dateKey}': {
      put: op({
        summary: 'Set a per-day override',
        description: `The body is the whole override: \`shift_type_id\`, \`note\` and \`field_values\` are all required (#2810); up to v2.93 a missing shift type made the day free, a missing note wiped the stored one and missing field values were kept. A NULL shift type is an explicit day off, which is why deleting the override is the only way back to the pattern. \`field_values\` replaces the stored values, \`{}\` or \`null\` clears them.${OWNER_NOTE}`,
        tag: 'Schedule',
        params: [dayKeyParam],
        stateChanging: true,
        requestBody: body({ required: ['shift_type_id', 'note', 'field_values'], properties: overrideFields }),
        responses: answers(200, 'Override set', FORBIDDEN),
      }),
      delete: op({
        summary: 'Remove a per-day override',
        description: OWNER_NOTE.trim(),
        tag: 'Schedule',
        params: [dayKeyParam, queryUserId('Household member; defaults to the caller.')],
        stateChanging: true,
        responses: answers(204, 'Override removed', { ...FORBIDDEN, ...notFound('Override') }),
      }),
    },
    '/api/v1/schedule/extras': {
      get: op({
        summary: 'List extra shifts (additive to the primary pattern/override slot)',
        tag: 'Schedule',
        params: [queryUserId('Only the extra shifts of this household member; an unknown one answers 404.'), queryDay('from', false), queryDay('to', false)],
        responses: answers(200, 'Extra shifts', notFound('User')),
      }),
      post: op({
        summary: 'Add an extra shift on a day',
        description: `Additive to whatever the primary slot resolves for that day - never an upsert, so multiple extras (even sharing a shift type) may exist on the same date. Addressed by its own id, not by (user_id, date_key) like overrides.${OWNER_NOTE}`,
        tag: 'Schedule',
        stateChanging: true,
        requestBody: body({ required: ['date_key', 'shift_type_id'], properties: { date_key: day('The day'), ...extraFields } }),
        responses: answers(201, 'Extra shift added', FORBIDDEN),
      }),
    },
    '/api/v1/schedule/extras/fill': {
      post: op({
        summary: 'Add the same extra shift across a date range in one call',
        description: `An insert loop, not an upsert - every day in range gets its own new row. Writes real rows, capped at 100 days like /overrides/fill. A range whose \`from\` lies after \`to\` is refused with 400 and reason \`range_reversed\`.${OWNER_NOTE}`,
        tag: 'Schedule',
        stateChanging: true,
        requestBody: body({ required: ['from', 'to', 'shift_type_id'], properties: { from: day('The first day'), to: day('The last day, inclusive,'), ...extraFields } }),
        responses: answers(200, 'Extra shifts added', FORBIDDEN),
      }),
    },
    '/api/v1/schedule/extras/{id}': {
      put: op({
        summary: 'Update an extra shift',
        description: `Any field left out of the body keeps its previous value. user_id may never be reassigned (it is ignored).${ORDER_NOTE}`,
        tag: 'Schedule',
        params: [pathId('id', 'Extra shift ID')],
        stateChanging: true,
        requestBody: body({
          properties: {
            user_id: { description: 'Ignored: an extra shift keeps its owner.' },
            date_key: day('The day'),
            shift_type_id: bodyId('The shift type, a whole number.'),
            note: noteField,
            reminder_offset_minutes: reminderOffset,
            field_values: fieldValues,
          },
        }, false),
        responses: answers(200, 'Extra shift updated', { ...FORBIDDEN, ...notFound('Extra shift') }),
      }),
      delete: op({
        summary: 'Remove an extra shift',
        tag: 'Schedule',
        params: [pathId('id', 'Extra shift ID')],
        stateChanging: true,
        responses: answers(204, 'Extra shift removed', { ...FORBIDDEN, ...notFound('Extra shift') }),
      }),
    },
    '/api/v1/schedule/feed': {
      get: op({ summary: 'Get own schedule ICS feed status', tag: 'Schedule' }),
      delete: op({ summary: 'Disable own schedule ICS feed', description: 'A body is ignored.', tag: 'Schedule', stateChanging: true }),
    },
    '/api/v1/schedule/feed/regenerate': {
      post: op({ summary: 'Regenerate own schedule ICS feed token', description: 'A body is ignored.', tag: 'Schedule', stateChanging: true }),
    },
    '/api/v1/schedule/preferences': {
      get: op({ summary: 'Get own shift-start reminder offset and weekly-hours target', tag: 'Schedule' }),
      put: withValidationRefusal(op({
        summary: 'Set own shift-start reminder offset, weekly-hours target and overtime tracking',
        description: 'Each field may be omitted to leave it unchanged; `reminderOffsetMinutes` and `weeklyHours` may be set to null to reset them to their default (reminder off, 40h/week). `overtimeEnabled` is a boolean. A change to reminderOffsetMinutes triggers an immediate resync so it takes effect without waiting for the next periodic pass.',
        tag: 'Schedule',
        stateChanging: true,
        requestBody: body({
          properties: {
            reminderOffsetMinutes: { ...reminderOffset, description: `Minutes before a shift starts, 0-${MAX_REMINDER_OFFSET_MINUTES}; \`null\` switches the reminder off.` },
            weeklyHours: { type: ['integer', 'null'], minimum: MIN_WEEKLY_HOURS, maximum: MAX_WEEKLY_HOURS, description: `The weekly target, ${MIN_WEEKLY_HOURS}-${MAX_WEEKLY_HOURS} hours; \`null\` is 40.` },
            overtimeEnabled: { type: 'boolean' },
          },
        }, false),
      })),
    },
  };
}

export function schedulePaths() {
  return withCaseReasons('schedule', CASE_REASONS, { ...shiftTypePaths(), ...patternPaths(), ...dayPaths() });
}

// #1909: die Faelle, die ein Nutzer erreicht, tragen einen `reason` neben dem
// englischen `error` - je Operation der Satz, der sie nennt.
const TYPE_GONE = '`schedule_shift_type_not_found` (404, the shift type was deleted)';
const FIELD_GONE = '`schedule_custom_field_not_found` (404, the custom field was deleted)';
const PATTERN_GONE = '`schedule_pattern_not_found` (404, the pattern was deleted)';
const EXTRA_GONE = '`schedule_extra_shift_not_found` (404, the extra shift was deleted)';
const SELECTED_TYPE_GONE = '`schedule_selected_shift_type_not_found` (400, the chosen `shift_type_id` was deleted)';
const TYPE_REQUIRED = '`schedule_shift_type_required` (400, `shift_type_id` is missing or not a positive number)';
const CASE_REASONS = {
  '/api/v1/schedule/shift-types/{id}': {
    put: TYPE_GONE,
    delete: `${TYPE_GONE}, \`schedule_shift_type_in_use\` (409, a pattern, override or extra shift still uses it)`,
  },
  '/api/v1/schedule/shift-types/{id}/fields': {
    put: `${TYPE_GONE}, \`schedule_selected_custom_field_not_found\` (400, a chosen \`custom_field_id\` was deleted)`,
  },
  '/api/v1/schedule/custom-fields/{id}': { put: FIELD_GONE, delete: FIELD_GONE },
  '/api/v1/schedule/patterns/{id}': {
    put: `${PATTERN_GONE}, \`schedule_cycle_length_conflict\` (400, the new \`cycle_length\` would cut off cycle days that are set)`,
    delete: PATTERN_GONE,
  },
  '/api/v1/schedule/patterns/{id}/days': { get: PATTERN_GONE, put: `${PATTERN_GONE}, ${SELECTED_TYPE_GONE}` },
  '/api/v1/schedule/overrides/fill': { post: SELECTED_TYPE_GONE },
  '/api/v1/schedule/overrides/{dateKey}': {
    put: SELECTED_TYPE_GONE,
    delete: '`schedule_override_not_found` (404, there is no override on that day)',
  },
  '/api/v1/schedule/extras': { post: `${SELECTED_TYPE_GONE}, ${TYPE_REQUIRED}` },
  '/api/v1/schedule/extras/fill': { post: `${SELECTED_TYPE_GONE}, ${TYPE_REQUIRED}` },
  '/api/v1/schedule/extras/{id}': { put: `${EXTRA_GONE}, ${SELECTED_TYPE_GONE}, ${TYPE_REQUIRED}`, delete: EXTRA_GONE },
};
