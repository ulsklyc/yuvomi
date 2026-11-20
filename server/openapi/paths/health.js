import { op, idParam, withValidationRefusal } from '../helpers.js';
import { MAX_SHORT, MAX_TEXT, MAX_TITLE } from '../../middleware/validate.js';
import { DATE_PATTERN, DATETIME_PATTERN, OPTIONAL_DATE_PATTERN, OPTIONAL_DATETIME_PATTERN, TIME_PATTERN } from '../../utils/datetime-pattern.js';
import {
  CYCLE_SETTING_RANGES, LAB_FLAGS, LOG_STATUS, MAX_ICON, MAX_INTERVAL_HOURS, MAX_INTERVAL_MONTHS, MAX_NUTRIENT, MAX_OFFSET_DAYS,
  MAX_SCHEDULES_ON_CREATE, MAX_TYPE, MAX_UNIT, MEAL_TYPES, NUTRIENT_KEYS, NUTRITION_VISIBILITIES, PREVENTION_KINDS,
  SCOPE_KEY_PATTERN, FLAT_SCOPE_KEYS, VISIBILITIES,
} from '../../services/health-fields.js';
import {
  BASAL_TEMP_UNITS, CERVIX_MUCUS_VALUES, CONTRACEPTION_VALUES, FLOW_VALUES, INTENSITY_LEVELS, INTIMACY_VALUES, MOOD_VALUES,
  TEST_RESULT_VALUES,
} from '../../../public/utils/health-cycle.js';

// ---------------------------------------------------------------------------
// Bausteine der Anfrage-Schemata (#2810, Gruppe 6). Die Wertelisten und
// Grenzen kommen aus derselben Quelle, aus der die Route prueft
// (server/services/health-fields.js, public/utils/health-cycle.js), nie als
// Abschrift.
// ---------------------------------------------------------------------------

/**
 * A JSON body. `required: true` unless said otherwise: a call without a body
 * is 400, `{}` sent on purpose counts as sent.
 * @param {Record<string, unknown>} schema
 * @param {{ required?: boolean, description?: string }} [options]
 */
const body = (schema, { required = true, description = 'JSON request body. Fields the schema does not name are ignored.' } = {}) => ({
  required,
  description,
  content: { 'application/json': { schema: { type: 'object', ...schema } } },
});

// Ziffern-Text ist eine Altform (#2810): die App schickt Zahlen, aeltere
// Clients die IDs ihrer Formularfelder als Text.
const DIGIT_TEXT = { type: 'string', pattern: '^[0-9]+$' };
const LEGACY_NOTE = 'Digit text is accepted as a legacy form.';

/**
 * A person or record id in the body: a whole number, digit text as the legacy
 * form, `null` where the route reads it as "none".
 * @param {string} description
 * @param {{ nullable?: boolean }} [options]
 */
const bodyId = (description, { nullable = true } = {}) => ({
  anyOf: [{ type: 'integer' }, DIGIT_TEXT, ...(nullable ? [{ type: 'null' }] : [])],
  description: `${description} ${LEGACY_NOTE}`,
});

/** `user_id` in a write body: the caregiver path (#584). */
const OWNER = bodyId('The person the row belongs to - a caregiver records for the person they care for (#584); left out or `null`: the caller. A person the caller may not record for is 403.');

/**
 * A value from a fixed list of the route. Until #2810 several routes replaced
 * an unknown value silently with a default.
 * @param {readonly (string|number)[]} values
 * @param {string} description
 * @param {{ nullable?: boolean, empty?: boolean }} [options]
 */
const oneOf = (values, description, { nullable = false, empty = false } = {}) => {
  const list = [...values, ...(empty ? [''] : []), ...(nullable ? [null] : [])];
  const types = [...new Set(values.map((value) => (typeof value === 'number' ? 'integer' : 'string')))];
  return { type: nullable ? [...types, 'null'] : (types.length === 1 ? types[0] : types), enum: list, description };
};

/**
 * Free text. `maxLength` is the route's limit, counted on the value as sent;
 * the route trims and counts again.
 * @param {number} max
 * @param {string} description
 * @param {{ nullable?: boolean }} [options]
 */
const text = (max, description, { nullable = true } = {}) => ({
  type: nullable ? ['string', 'null'] : 'string',
  maxLength: max,
  description: `${description} At most ${max} characters.`,
});

/** A note: optional, `null` or `""` clears it. */
const NOTE = text(MAX_TEXT, 'Free note; `null` or `""` means none.');

/**
 * A number. Text, a truth value or a list is refused (until #2810 `"0x10"`,
 * `" "`, `[]` and `true` were stored as 16, 0, 0 and 1).
 * @param {string} description
 * @param {Record<string, unknown>} [bounds]
 */
const number = (description, bounds = {}) => ({ type: ['number', 'null'], ...bounds, description: `${description} \`null\` means none.` });

/**
 * A whole number of a range, `null` for none.
 * @param {number} min
 * @param {number} max
 * @param {string} description
 */
const wholeNumber = (min, max, description) => ({ type: ['integer', 'null'], minimum: min, maximum: max, description: `${description} \`null\` means none.` });

/** A switch: `true`/`false` or `1`/`0`. Text and `null` are refused. */
const FLAG = { anyOf: [{ type: 'boolean' }, { type: 'integer', enum: [0, 1] }] };
/** @param {string} description */
const flag = (description) => ({ ...FLAG, description: `${description} \`true\`/\`false\` or \`1\`/\`0\`.` });

/** The visibility of a health row; `null` or left out: the owner's default. */
const VISIBILITY = oneOf(VISIBILITIES, '`private` or `family`; `null` or left out: on create the OWNER\'s default for this area (#958), on update unchanged.', { nullable: true });

/** A household wall-clock time; required, so neither empty nor `null`. */
const WALL_CLOCK = { type: 'string', pattern: DATETIME_PATTERN, description: '`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS[.f]]`, optionally with `Z` or an offset; see the operation text.' };
/** The same, optional: `null` or `""` means none. */
const OPTIONAL_WALL_CLOCK = { type: ['string', 'null'], pattern: OPTIONAL_DATETIME_PATTERN, description: '`YYYY-MM-DDTHH:MM` household wall-clock time (or a date, or with `Z`/offset); `null` or `""` means none.' };
/** A calendar day; required. Whether it exists is the route's check. */
const DAY = { type: 'string', pattern: DATE_PATTERN, description: '`YYYY-MM-DD`; a day that does not exist is refused by the route.' };
/** An optional calendar day; `null` or `""` means none. */
const OPTIONAL_DAY = { type: ['string', 'null'], pattern: OPTIONAL_DATE_PATTERN, description: '`YYYY-MM-DD`; `null` or `""` means none.' };

const QUERY_NOTE = 'A doubled value or a value outside its type is 400.';
/** `?user_id=` of a list. */
const PERSON_QUERY = {
  name: 'user_id', in: 'query', required: false, schema: { type: 'integer', minimum: 1 },
  description: `A family member: only their rows the caller may read (their open rows, or all of them for a caregiver). Plain decimal digits; until #2810 \`0\` or text read as "everybody visible". ${QUERY_NOTE}`,
};
/**
 * `from`/`to` against a stored text column, compared as text: a day or a
 * wall-clock time (`2027-07-01T00:00`) both work.
 * @param {string} name
 * @param {string} column
 */
const boundQuery = (name, column) => ({
  name, in: 'query', required: false, schema: { type: 'string' },
  description: `${name === 'from' ? 'Lower' : 'Upper'} bound (inclusive) on \`${column}\`, compared as text: a day \`YYYY-MM-DD\` or a wall-clock time \`YYYY-MM-DDTHH:MM\`. ${QUERY_NOTE}`,
});
/** @param {string} column */
const boundQueries = (column) => [boundQuery('from', column), boundQuery('to', column)];
/** `from`/`to` of the CSV exports: calendar days only. */
const DAY_QUERIES = ['from', 'to'].map((name) => ({
  name, in: 'query', required: false, schema: { type: 'string', format: 'date', pattern: DATE_PATTERN },
  description: `${name === 'from' ? 'First' : 'Last'} day \`YYYY-MM-DD\` (inclusive). Until #2810 a value that was not a day was ignored silently; now it is 400. ${QUERY_NOTE}`,
}));
/** @param {string} what */
const typeQuery = (what) => ({ name: 'type', in: 'query', required: false, schema: { type: 'string' }, description: `Only ${what} of this type. ${QUERY_NOTE}` });

const ORDER_NOTE = 'A request outside the schema (a value that is not of its type, a number or a list in a text field, a value outside its list, '
  + 'a path id that is not plain decimal digits) answers 400 with `fields` before anything is looked up, so it comes before the 404, 403 and 409 of the route.';
/** @param {string} [description] */
const withOrder = (description) => (description ? `${description}\n\n${ORDER_NOTE}` : ORDER_NOTE);

/**
 * An operation of `op()` with the 400 of validateRequest() and the order note.
 * @param {Parameters<typeof op>[0]} options
 */
const checked = (options) => withValidationRefusal(op({ ...options, description: withOrder(options.description) }));

// Pfad-IDs (#2810): Dezimalziffern bis Number.MAX_SAFE_INTEGER. `0x10`, `7abc`,
// `1e2`, `1.5` und ` 5` trafen bis hierher eine andere Zeile (parseInt bzw.
// Number im Fasten).
/** @param {string} what */
const pathId = (what) => idParam('id', `${what} ID, plain decimal digits.`);
const VITAL_ID = pathId('Vital measurement');
const MED_ID = pathId('Medication');
const SCHEDULE_ID = pathId('Intake schedule');
const LOG_ID = pathId('Dose-log entry');
const LAB_ID = pathId('Lab report');
const RESULT_ID = pathId('Analyte result');
const ACTIVITY_ID = pathId('Activity');
const FAST_ID = pathId('Fasting record');
const PERIOD_ID = pathId('Period episode');
const DAY_LOG_ID = pathId('Cycle day log');
const PREVENTION_TYPE_ID = pathId('Preventive-care type');
const PREVENTION_RECORD_ID = pathId('Preventive-care record');
const NUTRITION_ENTRY_ID = pathId('Nutrition entry');
const SUBJECT_ID = idParam('subjectId', 'The person being cared for, plain decimal digits.');

// ---------------------------------------------------------------------------
// Vitalwerte, Medikamente, Labor, Aktivitaeten
// ---------------------------------------------------------------------------

const VITAL_FIELDS = {
  type: text(MAX_TYPE, 'The metric (`bp`, `weight`, `temp`, ...; free text, not a list).', { nullable: false }),
  value_num: number('The value; for blood pressure the systolic one.'),
  value_num2: number('Second value (blood pressure: diastolic).'),
  value_num3: number('Third value (blood pressure: pulse).'),
  unit: text(MAX_UNIT, 'The unit, see the accepted units below; `null` or `""` means none.'),
  measured_at: WALL_CLOCK,
  note: NOTE,
  visibility: VISIBILITY,
};

const MED_FIELDS = {
  name: text(MAX_TITLE, 'The name; empty after trimming is refused.', { nullable: false }),
  dosage_text: text(MAX_SHORT, 'Dosage as written on the pack; `null` or `""` means none.'),
  form: text(MAX_UNIT, 'Form (tablet, drops ...); `null` or `""` means none.'),
  stock_qty: number('Recorded stock.'),
  stock_unit: text(MAX_UNIT, 'Unit of the stock; `null` or `""` means none.'),
  refill_threshold: number('Stock at which a refill is due.'),
  note: NOTE,
  visibility: VISIBILITY,
  active: flag('Taken currently; left out on create: active. Until #2810 an invalid value on create became the default silently.'),
  prn: flag('As-needed medication; left out on create: not as-needed. Until #2810 an invalid value on create became the default silently.'),
  min_interval_hours: number(`As-needed: the least gap between two doses in hours, above 0 and at most ${MAX_INTERVAL_HOURS}.`, { exclusiveMinimum: 0, maximum: MAX_INTERVAL_HOURS }),
  prn_dose_qty: number('As-needed: the dose, not negative.', { minimum: 0 }),
};

/**
 * One intake schedule.
 * @param {{ create?: boolean }} [options]
 */
const scheduleFields = ({ create = true } = {}) => ({
  time_of_day: { type: 'string', pattern: TIME_PATTERN, description: `\`HH:MM\`.${create ? ' Required.' : ' Cannot be emptied.'}` },
  days_mask: { type: ['integer', 'null'], minimum: 0, maximum: 127, description: 'Weekdays as a bit mask, 0 to 127; `null` means every day.' },
  dose_qty: number('The dose per intake.'),
  start_date: OPTIONAL_DAY,
  end_date: OPTIONAL_DAY,
  active: flag(create ? 'Left out: active. Until #2810 an invalid value became the default silently.' : 'Whether the schedule is active.'),
});

const SCHEDULE_CREATE = { required: ['time_of_day'], properties: scheduleFields() };

/**
 * One analyte result.
 * @param {{ create?: boolean }} [options]
 */
const resultFields = ({ create = true } = {}) => ({
  analyte: text(MAX_SHORT, `The analyte;${create ? ' required,' : ''} empty after trimming is refused.`, { nullable: false }),
  value_num: number(create ? 'The measured value.' : 'The measured value; a stored value cannot be cleared (400).'),
  unit: text(MAX_UNIT, 'The unit; `null` or `""` means none.'),
  ref_low: number('Lower end of the reference range.'),
  ref_high: number('Upper end of the reference range.'),
  flag: oneOf(LAB_FLAGS, '`low`, `normal` or `high`; `null` or left out: derived from value and reference range.', { nullable: true }),
});

const ACTIVITY_FIELDS = {
  type: text(MAX_TYPE, 'The kind of activity (free text, not a list).', { nullable: false }),
  duration_min: number('Duration in minutes.'),
  distance_km: number('Distance in kilometres.'),
  intensity: text(MAX_UNIT, 'Intensity; `null` or `""` means none.'),
  calories: number('Energy burnt in kcal.'),
  performed_at: WALL_CLOCK,
  note: NOTE,
  visibility: VISIBILITY,
};

const DOSE_FIELDS = {
  taken_at: OPTIONAL_WALL_CLOCK,
  stock_deduct: number('What comes off the recorded stock, not negative (#2069).', { minimum: 0 }),
};

// ---------------------------------------------------------------------------
// Zyklus
// ---------------------------------------------------------------------------

const PERIOD_FIELDS = {
  start_date: DAY,
  end_date: { ...OPTIONAL_DAY, description: '`YYYY-MM-DD`, not before `start_date`; `null` or `""` means still running.' },
  note: NOTE,
  visibility: oneOf(VISIBILITIES, '`private` or `family`; `null` or left out: `private` on create, unchanged on update.', { nullable: true }),
};

const SYMPTOM_ENTRY = {
  anyOf: [
    { type: 'string', description: 'A symptom key (older form, intensity none).' },
    {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The symptom key.' },
        intensity: oneOf(INTENSITY_LEVELS.map((level) => level.value), '1 to 3, or `null`.', { nullable: true }),
      },
    },
  ],
};

/**
 * One of the fixed answers of the day log: the route reads `""` and `null` as
 * "not given", the page sends `""` for a choice that is not pressed.
 * @param {readonly string[]} values
 * @param {string} description
 */
const dayChoice = (values, description) => oneOf(values, `${description} \`""\` or \`null\`: not given.`, { nullable: true, empty: true });

const DAY_LOG_FIELDS = {
  log_date: DAY,
  flow: dayChoice(FLOW_VALUES, 'Bleeding strength.'),
  note: NOTE,
  visibility: oneOf(VISIBILITIES, '`private` or `family`; `null` or left out: `private` - also on a day that was `family` before.', { nullable: true }),
  symptoms: {
    anyOf: [{ type: 'array', items: SYMPTOM_ENTRY }, { type: 'string' }, { type: 'null' }],
    description: 'The symptoms of the day: a list of `{ key, intensity }` (or keys), or the older comma-separated text. Unknown keys and doubles fall away; '
      + 'more than 40 after that is 400. Left out, `null` or `""`: none - the stored symptoms are cleared. Until #2810 a number or an object cleared them as well.',
  },
  basal_temp: number('Basal body temperature; with a value `basal_temp_unit` is required and the value must lie in the range of the unit (34-42 °C, 93-108 °F).'),
  basal_temp_unit: oneOf(BASAL_TEMP_UNITS, '`c` or `f`; read only together with `basal_temp`.', { nullable: true }),
  cervix_mucus: dayChoice(CERVIX_MUCUS_VALUES, 'Cervical mucus.'),
  lh_test: dayChoice(TEST_RESULT_VALUES, 'LH test result.'),
  pregnancy_test: dayChoice(TEST_RESULT_VALUES, 'Pregnancy test result.'),
  intimacy: dayChoice(INTIMACY_VALUES, 'Intimacy.'),
  feelings: {
    type: ['array', 'null'],
    items: { type: 'string', enum: [...MOOD_VALUES] },
    description: 'The feelings of the day from the fixed set; named (also as `[]` or `null`) it replaces the stored ones, left out it keeps them.',
  },
  mood: oneOf(MOOD_VALUES, 'Older single feeling, read as `feelings: [mood]` when `feelings` is left out.', { nullable: true, empty: true }),
};

/**
 * A whole number of the cycle settings within its range.
 * @param {keyof typeof CYCLE_SETTING_RANGES} field
 * @param {string} description
 */
const cycleRange = (field, description) => {
  const [min, max] = CYCLE_SETTING_RANGES[field];
  return wholeNumber(min, max, `${description} ${min} to ${max}; left out resets it.`);
};

const CYCLE_SETTINGS_FIELDS = {
  cycle_length_avg: cycleRange('cycle_length_avg', 'Average cycle length in days,'),
  period_length_avg: cycleRange('period_length_avg', 'Average period length in days,'),
  luteal_length: { ...cycleRange('luteal_length', 'Luteal phase in days,'), description: `Luteal phase in days, ${CYCLE_SETTING_RANGES.luteal_length[0]} to ${CYCLE_SETTING_RANGES.luteal_length[1]}; left out or \`null\`: 14.` },
  track_fertility: flag('Predict the fertile window; left out: on.'),
  pregnancy_mode: flag('Pregnancy mode; left out: off.'),
  pregnancy_due_date: OPTIONAL_DAY,
  default_visibility: oneOf(VISIBILITIES, 'Visibility of new periods and imports; `null` or left out: `private`.', { nullable: true }),
  remind_period_days_before: cycleRange('remind_period_days_before', 'Reminder before the predicted period, days ahead,'),
  remind_log_daily: flag('Daily log nudge; left out: off.'),
  contraception: oneOf(CONTRACEPTION_VALUES, 'Contraception; `null` or left out: not stated.', { nullable: true }),
  perimenopause_mode: flag('Perimenopause mode; left out: off.'),
  show_pms: flag('Show the PMS window; left out: on.'),
  notify_partner_user_id: bodyId('Opt-in partner notification: one of `eligible_partners`; `null` or left out clears it.'),
  notify_partner_days_before: cycleRange('notify_partner_days_before', 'Days ahead of the partner notification,'),
};

// ---------------------------------------------------------------------------
// Fasten (eigene Schemata seit #1902, hier unveraendert bis auf user_id)
// ---------------------------------------------------------------------------

// Kein `format: date-time` (#2810): der verlangt Sekunden, der Dienst liest
// auch `2025-02-01T08:00Z` (parseInstant in server/services/fasting.js). Das
// Muster ist genau seine Regel (Z oder +hh:mm am Ende), den Rest prueft er.
const instant = { type: 'string', pattern: '(Z|[+-][0-9]{2}:[0-9]{2})$', description: 'ISO instant with explicit offset (`Z` or `+hh:mm`), seconds optional; writes cannot be in the future.' };
const goal = { type: ['integer', 'null'], minimum: 60, maximum: 20160, multipleOf: 60 };
const revision = { type: 'integer', minimum: 1 };
const recordFields = { start_at: instant, end_at: { ...instant, type: ['string', 'null'] }, start_tzid: { type: 'string', description: 'Runtime-supported IANA zone captured on creation and retained by ordinary edits.' }, goal_minutes: goal, rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 }, note: { type: ['string', 'null'], maxLength: 2000 }, visibility: { type: 'string', enum: [...VISIBILITIES] } };
const fastingBody = (properties, required = [], mandatory = true) => ({ required: mandatory, content: { 'application/json': { schema: { type: 'object', properties, required } } } });
const fastingSubject = bodyId('The person (owner or a person the caller cares for); left out: the caller.', { nullable: false });
const userParam = { name: 'user_id', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'Defaults to the signed-in user. Family visibility and explicit caregiver grants apply.' };
const dates = ['from', 'to'].map((name) => ({ name, in: 'query', required: false, schema: { type: 'string', format: 'date', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }, description: 'Inclusive completion date in the household display time zone; from must not exceed to.' }));
const historyParams = [userParam, ...dates, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 } }, { name: 'before_at', in: 'query', schema: instant, description: 'Pass together with before_id from next_cursor.' }, { name: 'before_id', in: 'query', schema: revision, description: 'Pass together with before_at.' }];
const FASTING_400 = 'A refusal of the fasting service is 400 with its own `reason`: invalid timestamp, zone, goal, note, rating, visibility, date range, cursor or revision (`FASTING_TIMESTAMP_INVALID`, `FASTING_TIMEZONE_INVALID`, `FASTING_GOAL_INVALID`, `FASTING_NOTE_INVALID`, `FASTING_RATING_INVALID`, `FASTING_VISIBILITY_INVALID`, `FASTING_DATE_RANGE_INVALID`, `FASTING_PAGE_INVALID`, `FASTING_REVISION_REQUIRED`, `FASTING_SUBJECT_INVALID`, `FASTING_RANGE_INVALID`, `FASTING_FUTURE`).';
const FASTING_403 = 'Without the fasting capability (`health_use_fasting`) every fasting route answers 403 with `reason: FASTING_CAPABILITY_REQUIRED` first, before the request is checked (#2810).';
const fastingResponses = (status = 200, description = 'Successful response') => ({
  [status]: { description }, 400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' },
  404: { description: 'FASTING_NOT_FOUND: record does not exist.' },
  409: { description: 'Numeric code: 409; reason: FASTING_REVISION_CONFLICT, FASTING_ACTIVE_EXISTS, FASTING_OVERLAP, FASTING_ALREADY_FINISHED or FASTING_ACK_REQUIRED. Revision/overlap conflicts may include current record.', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'integer', enum: [409] }, reason: { type: 'string' }, current: { type: 'object' } } } } } },
  500: { $ref: '#/components/responses/InternalServerError' },
});
/** @param {string} description */
const fastingText = (description) => `${description}\n\n${FASTING_403} ${FASTING_400}`;
const booleanPreference = { oneOf: [{ type: 'boolean' }, { type: 'integer', enum: [0, 1] }, { type: 'string', enum: ['0', '1'] }] };

// ---------------------------------------------------------------------------
// Naehrwerte (#1326). Die acht stehen EINMAL in health-fields.js und werden in
// Ziel wie Eintrag gespreadet. `null` im `type` ist die Aussage der Spalte:
// nicht angegeben ist etwas anderes als null.
// ---------------------------------------------------------------------------

const nutrientSchema = Object.fromEntries(NUTRIENT_KEYS.map((name) => [name, {
  type: ['number', 'null'], minimum: 0, maximum: MAX_NUTRIENT,
  description: 'null means "not stated" and is not the same as 0.',
}]));
const wallClock = { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$', description: 'Household wall-clock time, NOT an instant - "today" is a calendar day in the household zone. Stored as YYYY-MM-DDTHH:MM. A value with Z or a numeric offset is converted into the household zone rather than having its offset dropped.' };
/** @param {{ create?: boolean }} [options] */
const nutritionEntryFields = ({ create = true } = {}) => ({
  title: text(MAX_TITLE, 'What was eaten; empty after trimming is refused.', { nullable: false }),
  consumed_at: wallClock,
  meal_type: oneOf(MEAL_TYPES, `The meal; \`null\`${create ? ' or left out' : ''} means none.`, { nullable: true }),
  note: NOTE,
  visibility: oneOf(NUTRITION_VISIBILITIES, `\`private\` or \`all\`; \`null\` or left out: ${create ? 'the OWNER\'s default' : 'unchanged'}.`, { nullable: true }),
  ...nutrientSchema,
});

// Dieselbe Regel fuer jeden Zeitstempel dieses Bereichs (#1364).
const WALL_CLOCK_INPUT = ' Timestamps (`measured_at`, `performed_at`, `consumed_at`, `scheduled_at`, `taken_at`) are household wall-clock time, stored as `YYYY-MM-DDTHH:MM`. A value without offset is taken as such; a value with `Z` or a numeric offset is read as an instant and converted into the household time zone, so the same moment sent in UTC or with a local offset lands on the same minute. Up to v2.68.0 the offset was dropped and its digits kept.';
// #1909: jede 404 dieses Bereichs, die "gibt es nicht (mehr) fuer dich"
// heisst, nennt ihren Fall - angehaengt an jede Operation auf einer Zeile
// (Pfad mit `{id}`), siehe withNotFoundReasons() am Ende.
const NOT_FOUND = 'A 404 for a row that does not exist or is not writable for the caller carries a `reason` naming the row: `health_vital_not_found`, `health_medication_not_found`, `health_schedule_not_found`, `health_dose_not_found`, `health_lab_report_not_found`, `health_lab_result_not_found`, `health_activity_not_found`, `health_prevention_type_not_found`, `health_prevention_record_not_found`, `health_nutrition_entry_not_found`, `health_cycle_period_not_found` or `health_cycle_log_not_found` (#1909).';
// Critique R19: unmoegliche Vitalwerte (server/routes/health/vital-limits.js).
const VITAL_LIMITS = ' A measurement no person can have is refused with 400 and a `reason`: `health_vital_bp_order` when systolic is not above diastolic, `health_vital_out_of_range` outside the possible range of its type and unit (weight 0.2-700 kg / 0.4-1550 lb, SpO2 at most 100 %, temperature 10-46 °C / 50-115 °F, glucose 10-2000 mg/dL / 0.5-111 mmol/L, blood pressure 40-300 / 20-200 mmHg, pulse 20-300). A PATCH is checked as the row would stand afterwards, and only when it changes the measurement. `unit` is optional and case-insensitive; other units a type can convert are checked after conversion (700001 g is refused like 700.001 kg). Accepted: bp mmHg; glucose mg/dL, mmol/L; weight kg, lb, g, lbs, stone; height and head_circumference cm, in, m, mm; spo2 %; temp °C, °F, C, F; sleep h; mood none. Anything else is refused with 400 and `health_vital_unit_invalid`. A PATCH that changes neither `unit` nor `type` keeps the stored unit, even one from before this rule.';
const TAKEN_NOW = ' A dose that ends up `taken` without a `taken_at` gets the current minute in household wall-clock time, so no path stores `taken` without a time.';
const PARTIAL = 'Only the fields present are changed; `{}` changes nothing, a call without a body is 400.';

// Antwort von DELETE /logs/{id} (#701): die Zeile geht, eine geplante bleibt.
const LOG_DELETE_RESPONSES = {
  200: {
    description: 'Deleted, `{ data: { id } }`.',
    content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } } },
  },
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  409: { description: 'A scheduled entry cannot be deleted, only reset to pending (`PATCH { status: "pending" }`).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
  500: { $ref: '#/components/responses/InternalServerError' },
};

// Antwort von POST /cycle/import: die Zeilenfehler als Liste, ohne `fields`.
const CYCLE_IMPORT_RESPONSES = {
  201: { description: 'Imported, `{ data: { imported, skipped, errors: [] } }`.' },
  400: {
    description: 'A request outside the schema (`fields`, `reason: validation`), a refusal with a `reason` (`health_cycle_import_too_large`, `health_cycle_import_no_rows`, `health_cycle_import_too_many_rows`, with `params`), or invalid rows: `{ error, code, errors: [<sentence per row>] }` with up to ten entries and no `reason`; nothing is imported then.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: { type: 'string' }, code: { type: 'integer', enum: [400] }, reason: { type: 'string' },
            params: { type: 'object', additionalProperties: true },
            fields: { type: 'array', items: { type: 'object', additionalProperties: true } },
            errors: { type: 'array', maxItems: 10, items: { type: 'string' } },
          },
        },
      },
    },
  },
  401: { $ref: '#/components/responses/Unauthorized' },
  500: { $ref: '#/components/responses/InternalServerError' },
};

export function healthPaths() {
  return withNotFoundReasons(NOT_FOUND, {
    '/api/v1/health/vitals': {
      get: checked({ summary: 'List vital measurements', tag: 'Health', params: [PERSON_QUERY, typeQuery('measurements'), ...boundQueries('measured_at')], description: 'Scoped to the viewer; `?user_id=` filters to a family member (only their `family`-visible rows).' }),
      post: checked({ summary: 'Create a vital measurement', tag: 'Health', stateChanging: true, requestBody: body({ required: ['type', 'measured_at'], properties: { ...VITAL_FIELDS, user_id: OWNER } }), description: (WALL_CLOCK_INPUT + VITAL_LIMITS).trim() }),
    },
    '/api/v1/health/vitals/{id}': {
      patch: checked({ summary: 'Update a vital measurement', tag: 'Health', params: [VITAL_ID], stateChanging: true, requestBody: body({ properties: VITAL_FIELDS }), description: `${PARTIAL} \`null\` or \`""\` clears a value, the unit or the note; \`type\` and \`measured_at\` cannot be cleared.${WALL_CLOCK_INPUT}${VITAL_LIMITS}` }),
      delete: checked({ summary: 'Delete a vital measurement', tag: 'Health', params: [VITAL_ID], stateChanging: true }),
    },
    '/api/v1/health/medications': {
      get: checked({
        summary: 'List medications',
        tag: 'Health',
        params: [
          PERSON_QUERY,
          { name: 'active', in: 'query', required: false, schema: { type: 'string', enum: ['1', '0', 'true', 'false'] }, description: `\`1\`/\`true\`: only active medications, \`0\`/\`false\`: only inactive ones. Until #2810 any other value was ignored silently. ${QUERY_NOTE}` },
          { name: 'include', in: 'query', required: false, schema: { type: 'string' }, description: `Comma-separated; the route reads \`schedules\` and \`logs\` and ignores other words. ${QUERY_NOTE}` },
          { name: 'logs_from', in: 'query', required: false, schema: { type: 'string' }, description: `With \`include=logs\`: lower bound like \`from\` on the logs endpoint (\`YYYY-MM-DDTHH:MM\`). ${QUERY_NOTE}` },
          { name: 'logs_to', in: 'query', required: false, schema: { type: 'string' }, description: `With \`include=logs\`: upper bound like \`to\` on the logs endpoint. ${QUERY_NOTE}` },
        ],
        description: 'Scoped to the viewer. `?include=schedules,logs` attaches each medication\'s `schedules` and `logs` (the same rows as the per-medication endpoints, read for exactly the listed medications); `logs_from`/`logs_to` filter the attached logs like `from`/`to` on the logs endpoint.',
      }),
      post: checked({ summary: 'Create a medication', tag: 'Health', stateChanging: true, requestBody: body({ required: ['name'], properties: { ...MED_FIELDS, schedules: { type: ['array', 'null'], maxItems: MAX_SCHEDULES_ON_CREATE, items: { type: 'object', ...SCHEDULE_CREATE }, description: `Up to ${MAX_SCHEDULES_ON_CREATE} intake schedules, same rules as the schedules endpoint.` }, user_id: OWNER } }), description: 'Optional `schedules`: an array of up to 48 intake schedules ({ time_of_day, days_mask?, dose_qty?, start_date?, end_date?, active? }, same rules as the schedules endpoint). The medication and its schedules are written in one transaction: if any schedule is invalid or fails, nothing is created. When `schedules` is sent, the response row carries the created `schedules`.' }),
    },
    '/api/v1/health/medications/{id}': {
      patch: checked({ summary: 'Update a medication', tag: 'Health', params: [MED_ID], stateChanging: true, requestBody: body({ properties: MED_FIELDS }), description: `${PARTIAL} \`null\` or \`""\` clears an optional text or number; \`name\` cannot be cleared. Schedules are changed through their own endpoints.` }),
      delete: checked({ summary: 'Delete a medication', tag: 'Health', params: [MED_ID], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/schedules': {
      get: checked({ summary: 'List a medication\'s intake schedules', tag: 'Health', params: [MED_ID] }),
      post: checked({ summary: 'Add an intake schedule to a medication', tag: 'Health', params: [MED_ID], stateChanging: true, requestBody: body(SCHEDULE_CREATE) }),
    },
    '/api/v1/health/schedules/{id}': {
      patch: checked({ summary: 'Update an intake schedule', tag: 'Health', params: [SCHEDULE_ID], stateChanging: true, requestBody: body({ properties: scheduleFields({ create: false }) }), description: PARTIAL }),
      delete: checked({ summary: 'Delete an intake schedule', tag: 'Health', params: [SCHEDULE_ID], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/logs': {
      get: checked({ summary: 'List a medication\'s dose log', tag: 'Health', params: [MED_ID, ...boundQueries('COALESCE(scheduled_at, taken_at, created_at)')], description: 'Optional `from`/`to` filters on the time of the entry (planned, else taken, else created), cut to minutes.' }),
      post: checked({
        summary: 'Add a dose-log entry',
        tag: 'Health',
        params: [MED_ID],
        stateChanging: true,
        requestBody: body({
          properties: {
            scheduled_at: OPTIONAL_WALL_CLOCK,
            schedule_id: bodyId('The intake schedule of this medication; `null` means none.'),
            status: oneOf(LOG_STATUS, '`taken`, `skipped` or `pending`; `null` or left out: `pending`.', { nullable: true }),
            ...DOSE_FIELDS,
            dose_qty: number('The dose taken.'),
            note: NOTE,
          },
        }),
        description: 'Body: { scheduled_at?, schedule_id?, status?, taken_at?, dose_qty?, note?, stock_deduct? }; `status` defaults to `pending`. Only a `taken` entry keeps `taken_at`: sent alongside `pending` or `skipped`, it is dropped and stored as null. `stock_deduct` (not negative) lowers the recorded stock in the same transaction as the log entry, never below 0, and only for a `taken` entry; a medication without recorded stock keeps none (#2069). One entry per planned occurrence: when an entry for the same `schedule_id` and `scheduled_at` exists, it is updated and the answer is `200`, and stock is deducted only when it turns `taken`. Such a repeat replaces `status` (left out: `pending`, so a taken entry is reset) and `taken_at`; a left-out `dose_qty` or `note` keeps the stored one. Send an `Idempotency-Key` to retry an as-needed dose safely. The answer carries `stock_deducted`: what actually came off the stock (0 without recorded stock, less than asked when the stock ran out) - the amount `POST /logs/{id}/undo` credits back.' + TAKEN_NOW + WALL_CLOCK_INPUT,
      }),
    },
    '/api/v1/health/logs/{id}': {
      patch: checked({
        summary: 'Correct a dose-log entry',
        tag: 'Health',
        params: [LOG_ID],
        stateChanging: true,
        requestBody: body({
          properties: {
            status: oneOf(LOG_STATUS, '`taken`, `skipped` or `pending`; `null` or left out keeps it.', { nullable: true }),
            taken_at: OPTIONAL_WALL_CLOCK,
            dose_qty: number('The dose; `null` keeps the stored one.'),
            note: NOTE,
          },
        }),
        description: 'Body: { status?, taken_at?, dose_qty?, note? } (#701). `status: "pending"` undoes a take or a skip. The timestamp travels with the status rather than beside it: anything other than `taken` clears `taken_at`, because a dose that was not taken cannot carry a time it was taken at - and that entry would end up in the CSV export too. Restricted to the owner of the medication. Switching to `taken` without `taken_at` keeps a time already stored, otherwise the current minute is used.' + TAKEN_NOW + WALL_CLOCK_INPUT,
      }),
      delete: withValidationRefusal(op({
        summary: 'Delete a dose-log entry',
        tag: 'Health',
        params: [LOG_ID],
        stateChanging: true,
        responses: LOG_DELETE_RESPONSES,
        description: withOrder('Only for entries without a schedule, so ad-hoc and as-needed doses (#701). A scheduled entry answers `409`: the scheduler would recreate it on its next run, so deleting it would look like a success and be a return on the instalment plan. Undo it with `PATCH { status: "pending" }` instead.'),
      })),
    },
    '/api/v1/health/logs/{id}/take': {
      post: checked({ summary: 'Mark a dose as taken', tag: 'Health', params: [LOG_ID], stateChanging: true, requestBody: body({ properties: DOSE_FIELDS }), description: 'Body: { taken_at?, stock_deduct? }; `{}` takes the dose now. `stock_deduct` (not negative) lowers the recorded stock in the same transaction, never below 0; an entry that is already taken does not deduct a second time (#2069). The answer carries `stock_deducted` (see the dose-log POST).' + TAKEN_NOW + WALL_CLOCK_INPUT }),
    },
    '/api/v1/health/logs/{id}/skip': {
      post: checked({ summary: 'Mark a dose as skipped', tag: 'Health', params: [LOG_ID], stateChanging: true, description: 'Reads no body; a body sent is ignored.' }),
    },
    '/api/v1/health/logs/{id}/undo': {
      post: checked({ summary: 'Take a recorded dose back (undo)', tag: 'Health', params: [LOG_ID], stateChanging: true, requestBody: body({ properties: { stock_credit: number('What goes back onto the recorded stock, not negative.', { minimum: 0 }) } }), description: 'Body: { stock_credit? } (R23); `{}` credits nothing. The undo of "taken" or "skipped", stock included: a scheduled entry is `pending` again without `taken_at` (deleting it would let the scheduler recreate it), an entry without a schedule (as-needed) is removed and the answer is { id, removed: true }. `stock_credit` (not negative; send the `stock_deducted` of the booking) goes back onto the recorded stock in the same transaction, only for a taken dose, never more than the dose_qty of the entry (or of its schedule), and only where stock is recorded. A pending entry answers 409 with `reason: "health_dose_pending"`. Restricted to who may write the medication.' }),
    },
    '/api/v1/health/labs': {
      get: checked({ summary: 'List lab reports (with results)', tag: 'Health', params: [PERSON_QUERY, ...boundQueries('report_date')], description: 'Scoped to the viewer.' }),
      post: checked({ summary: 'Create a lab report with analyte results', tag: 'Health', stateChanging: true, requestBody: body({ required: ['report_date'], properties: { report_date: DAY, lab_name: text(MAX_TITLE, 'The laboratory; `null` or `""` means none.'), note: NOTE, visibility: VISIBILITY, results: { type: ['array', 'null'], items: { type: 'object', required: ['analyte'], properties: resultFields() }, description: 'Analyte results written with the report, all or nothing. Until #2810 a value that was not a list was dropped silently.' }, user_id: OWNER } }) }),
    },
    '/api/v1/health/labs/{id}': {
      get: checked({ summary: 'Get a lab report (with results)', tag: 'Health', params: [LAB_ID] }),
      patch: checked({ summary: 'Update lab report header fields', tag: 'Health', params: [LAB_ID], stateChanging: true, requestBody: body({ properties: { report_date: DAY, lab_name: text(MAX_TITLE, 'The laboratory; `null` or `""` clears it.'), note: NOTE, visibility: VISIBILITY } }), description: PARTIAL }),
      delete: checked({ summary: 'Delete a lab report', tag: 'Health', params: [LAB_ID], stateChanging: true }),
    },
    '/api/v1/health/labs/{id}/results': {
      post: checked({ summary: 'Add an analyte result to a lab report', tag: 'Health', params: [LAB_ID], stateChanging: true, requestBody: body({ required: ['analyte'], properties: resultFields() }) }),
    },
    '/api/v1/health/results/{id}': {
      patch: checked({ summary: 'Update an analyte result', tag: 'Health', params: [RESULT_ID], stateChanging: true, requestBody: body({ properties: resultFields({ create: false }) }), description: 'Partial body (analyte, value_num, unit, ref_low, ref_high, flag?). The merged row is validated like a new result. A stored value_num cannot be cleared (400). The flag is kept unless the body names one or value or reference range change, in which case it is re-derived.' }),
      delete: checked({ summary: 'Delete an analyte result', tag: 'Health', params: [RESULT_ID], stateChanging: true }),
    },
    '/api/v1/health/activities': {
      get: checked({ summary: 'List activities', tag: 'Health', params: [PERSON_QUERY, typeQuery('activities'), ...boundQueries('performed_at')], description: 'Scoped to the viewer.' }),
      post: checked({ summary: 'Create an activity', tag: 'Health', stateChanging: true, requestBody: body({ required: ['type', 'performed_at'], properties: { ...ACTIVITY_FIELDS, user_id: OWNER } }), description: WALL_CLOCK_INPUT.trim() }),
    },
    '/api/v1/health/activities/{id}': {
      patch: checked({ summary: 'Update an activity', tag: 'Health', params: [ACTIVITY_ID], stateChanging: true, requestBody: body({ properties: ACTIVITY_FIELDS }), description: `${PARTIAL}${WALL_CLOCK_INPUT}` }),
      delete: checked({ summary: 'Delete an activity', tag: 'Health', params: [ACTIVITY_ID], stateChanging: true }),
    },
    '/api/v1/health/export/vitals': {
      get: checked({ summary: 'Export vital measurements as CSV', tag: 'Health', params: [PERSON_QUERY, ...DAY_QUERIES], description: 'Scoped to the viewer. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/activities': {
      get: checked({ summary: 'Export activities as CSV', tag: 'Health', params: [PERSON_QUERY, ...DAY_QUERIES], description: 'Scoped to the viewer. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/labs': {
      get: checked({ summary: 'Export lab reports (one row per analyte) as CSV', tag: 'Health', params: [PERSON_QUERY, ...DAY_QUERIES], description: 'Scoped to the viewer. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/meds-logs': {
      get: checked({ summary: 'Export medication dose logs as CSV', tag: 'Health', params: [PERSON_QUERY, ...DAY_QUERIES], description: 'Scoped to the viewer. Returns `text/csv`.' }),
    },
    '/api/v1/health/fasting': {
      get: withValidationRefusal(op({ summary: 'List completed fasts', tag: 'Health', params: historyParams, responses: fastingResponses(), description: fastingText('Alias of /fasting/history. Returns data, has_more and next_cursor, ordered by start_at DESC, id DESC.') })),
      post: withValidationRefusal(op({ summary: 'Start or backfill a fast', tag: 'Health', stateChanging: true, responses: fastingResponses(201), requestBody: fastingBody({ ...recordFields, user_id: fastingSubject, acknowledge_safety: { type: 'boolean', description: 'true explicitly acknowledges the first-use safety information for the authenticated owner.' } }, ['start_tzid']), description: fastingText('Omitted start_at uses the server time. Omitted/null end_at creates an active fast. At most one active row per person; intervals cannot overlap. Owner or explicitly granted caregiver with both fasting capabilities and Health write access. Safety acknowledgement is personal: a caregiver cannot acknowledge for another person. `goal_minutes`, `rating` and `expected_revision` are numbers; text is 400 (until #2810 digit text was read).') })),
    },
    '/api/v1/health/fasting/state': {
      get: withValidationRefusal(op({ summary: 'Get fasting timer state', tag: 'Health', params: [userParam], responses: fastingResponses(), description: fastingText('Active fast, settings, acknowledged, canWrite (owner/caregiver relationship), server_now, display_tzid and first ten completed records; history_has_more/history_next_cursor continue through /fasting/history. server_now is the UTC instant clients use for a completed-entry default, avoiding phone/server clock skew. Health module write access is additionally required for mutations. Ungranted family readers receive null settings and acknowledged. Display zone follows household settings.') })),
    },
    '/api/v1/health/fasting/history': {
      get: withValidationRefusal(op({ summary: 'List fasting history', tag: 'Health', params: historyParams, responses: fastingResponses(), description: fastingText('Returns data, has_more and next_cursor (cursor object or null). Ordered by start_at DESC, id DESC. Date filters select completion dates in the household display time zone; a value that is not a calendar day is 400 against the schema (`reason: validation`, until #2810 FASTING_DATE_RANGE_INVALID), a reversed range 400 FASTING_DATE_RANGE_INVALID. Visibility applies on every page.') })),
    },
    '/api/v1/health/fasting/stats': {
      get: withValidationRefusal(op({ summary: 'Get fasting statistics', tag: 'Health', params: [userParam], responses: fastingResponses(), description: fastingText('Completed records only: allTime/year/last30Days summaries {count,totalMinutes,averageMinutes}, currentStreak/longestStreak, display_tzid, today and seven weekly buckets {date,count,totalMinutes,goalMinutes,goalCount,hasRecord}. Captured non-null goals are summed. Missing days have hasRecord=false and goalMinutes=null. Statistics, history and CSV date filters use the household display time zone.') })),
    },
    '/api/v1/health/fasting/settings': {
      get: withValidationRefusal(op({ summary: 'Get fasting settings', tag: 'Health', params: [userParam], responses: fastingResponses(), description: fastingText('Settings or null for an ungranted family reader.') })),
      put: withValidationRefusal(op({ summary: 'Update fasting settings', tag: 'Health', params: [userParam], responses: fastingResponses(), description: fastingText('Personal settings are owner-only, including safety acknowledgement. clock_mode is stored per user in sync_config. Supplying active_id (null if none) with a default_goal_minutes change also changes that active goal atomically; a matching active row requires expected_revision. Without active_id only the default changes. Completed records remain unchanged. Notification preferences are retained when unavailable; reconciliation is transactional.'), stateChanging: true, requestBody: fastingBody({ user_id: fastingSubject, default_goal_minutes: goal, zone_mode: { type: 'string', enum: ['timer', 'educational'] }, clock_mode: { type: 'string', enum: ['auto', 'elapsed', 'remaining'] }, acknowledge_safety: { type: 'boolean' }, active_id: { ...revision, type: ['integer', 'null'] }, expected_revision: revision, remind_goal: booleanPreference, remind_next_start: booleanPreference }) })),
    },
    '/api/v1/health/fasting/acknowledge-safety': {
      post: withValidationRefusal(op({ summary: 'Acknowledge fasting safety information', tag: 'Health', params: [userParam], stateChanging: true, responses: fastingResponses(), description: fastingText('Records first-use acknowledgement for the authenticated owner only. A caregiver cannot acknowledge for another person.'), requestBody: fastingBody({ user_id: fastingSubject }, [], false) })),
    },
    '/api/v1/health/fasting/{id}': {
      patch: withValidationRefusal(op({ summary: 'Edit or reopen a fasting record', tag: 'Health', params: [FAST_ID], stateChanging: true, responses: fastingResponses(), description: fastingText('end_at:null reopens the same record; interval and active-row constraints apply. Ownership cannot be reassigned. `visibility` left out keeps the stored one; `null` is 400 (until #2810 it set `private` silently).'), requestBody: fastingBody({ ...recordFields, expected_revision: revision }, ['expected_revision']) })),
      delete: withValidationRefusal(op({ summary: 'Delete a fasting record', tag: 'Health', params: [FAST_ID, { name: 'expected_revision', in: 'query', required: false, schema: revision }], stateChanging: true, responses: fastingResponses(204, 'Deleted; no response body.'), description: fastingText('expected_revision is required in either the query or JSON body. A non-null body value takes precedence.'), requestBody: fastingBody({ expected_revision: revision }, [], false) })),
    },
    '/api/v1/health/fasting/{id}/finish': {
      post: withValidationRefusal(op({ summary: 'Finish an active fast', tag: 'Health', params: [FAST_ID], stateChanging: true, responses: fastingResponses(), description: fastingText('Persists the end immediately; end_at defaults to server now when omitted. Requires an active row.'), requestBody: fastingBody({ expected_revision: revision, end_at: instant }, ['expected_revision']) })),
    },
    '/api/v1/health/export/fasting': {
      get: withValidationRefusal(op({ summary: 'Export fasting history as CSV', tag: 'Health', params: [userParam, ...dates], responses: { ...fastingResponses(), 200: { description: 'Visibility-scoped UTF-8 CSV with BOM; spreadsheet formula-safe escaped cells.', content: { 'text/csv': { schema: { type: 'string' } } } } }, description: fastingText('Columns: start_at,end_at,start_tzid,duration_minutes,goal_minutes,goal_reached,rating,note,visibility. Uses the same household display-zone completion-date filters as history.') })),
    },
    '/api/v1/health/cycle/periods': {
      get: checked({ summary: 'List menstrual period episodes', tag: 'Health', params: [PERSON_QUERY, ...boundQueries('start_date')], description: 'Scoped to the viewer.' }),
      post: checked({ summary: 'Log a menstrual period episode', tag: 'Health', stateChanging: true, requestBody: body({ required: ['start_date'], properties: PERIOD_FIELDS }) }),
    },
    '/api/v1/health/cycle/periods/{id}': {
      patch: checked({ summary: 'Update a period episode', tag: 'Health', params: [PERIOD_ID], stateChanging: true, requestBody: body({ properties: PERIOD_FIELDS }), description: `${PARTIAL} The end must not lie before the start as the row would stand afterwards.` }),
      delete: checked({ summary: 'Delete a period episode', tag: 'Health', params: [PERIOD_ID], stateChanging: true }),
    },
    '/api/v1/health/cycle/logs': {
      get: checked({
        summary: 'List cycle day logs (flow, symptoms, feelings, mucus, tests)',
        tag: 'Health',
        params: [PERSON_QUERY, ...boundQueries('log_date')],
        description: 'Scoped to the viewer. Each row also carries `feelings` (array of mood keys, from the normalized `cycle_day_log_feelings` table); the legacy scalar `mood` is still returned for backward compatibility; it is only written (set to NULL) when a save\'s body includes `feelings` or `mood` as a key, and left untouched otherwise. `cervix_mucus`, `lh_test`, `pregnancy_test` and `intimacy` (all nullable enums, see the POST body) are included ONLY when the caller is the row\'s own owner - stripped from every other read regardless of the row\'s `visibility`, since sharing a day does not imply sharing fertility-test results or a sex-life entry.',
      }),
      post: checked({
        summary: 'Upsert a cycle day log (one per person and day)',
        tag: 'Health',
        stateChanging: true,
        requestBody: body({ required: ['log_date'], properties: DAY_LOG_FIELDS }),
        description: 'Body: { log_date, flow?, note?, visibility?, symptoms?, basal_temp?, basal_temp_unit?, cervix_mucus?, lh_test?, pregnancy_test?, intimacy?, feelings? }. `cervix_mucus` ∈ dry/sticky/creamy/watery/eggwhite; `lh_test`/`pregnancy_test` ∈ negative/positive; `intimacy` ∈ protected/unprotected/solo. `feelings` is an array from a fixed 7-key set (great/good/neutral/sensitive/sad/irritable/anxious, same as the frontend\'s MOOD_TYPES) - any other value is a 400, not stored as free text. The legacy single-value `mood` is still accepted and validated against the same fixed set, treated as `feelings: [mood]` when `feelings` is absent. A save whose body includes either `feelings` or `mood` as a key fully replaces the stored feelings rows (delete + re-insert) and sets the `mood` column to NULL; a save that includes neither key leaves both the existing feelings rows and the `mood` column untouched, so an unrelated field change cannot silently clear a frozen legacy mood value. '
          + 'Every other field is replaced by the save on a day that already has a log: a left-out `flow`, `note`, `basal_temp`, `basal_temp_unit`, `cervix_mucus`, `lh_test`, `pregnancy_test` or `intimacy` is cleared, a left-out `visibility` becomes `private`, and `symptoms` is fully replaced on every save (an omitted `symptoms` array normalizes to empty and clears any existing rows), while `feelings`/`mood` are only replaced when the request actually names one of those two keys. The app sends the whole day every time.',
      }),
    },
    '/api/v1/health/cycle/logs/{id}': {
      delete: checked({ summary: 'Delete a cycle day log', tag: 'Health', params: [DAY_LOG_ID], stateChanging: true }),
    },
    '/api/v1/health/cycle/settings': {
      get: op({
        summary: 'Get the viewer\'s cycle prediction settings',
        tag: 'Health',
        description: 'Includes `contraception`, `perimenopause_mode`, `show_pms`, `notify_partner_user_id` and `notify_partner_days_before` alongside the existing prediction settings, plus `eligible_partners: [{ id, display_name }]` - other household members (excluding the caller and anyone with the family role `child`) who pass the same health-module-access check the partner-reminder sync itself uses. Only these are valid targets for `notify_partner_user_id` below.',
      }),
      put: checked({
        summary: 'Update the viewer\'s cycle prediction settings',
        tag: 'Health',
        stateChanging: true,
        requestBody: body({ properties: CYCLE_SETTINGS_FIELDS }),
        description: 'Full-replace semantics like every other field on this route: an omitted field resets to its default rather than leaving the stored value untouched (`{}` resets every setting). `contraception` ∈ none/pill/hormonal_iud/copper_iud/implant/injection/patch/ring/condom/other; hormonal methods auto-disable fertile-window prediction client-side. `perimenopause_mode`/`show_pms` are booleans. `notify_partner_user_id` (opt-in partner notification) must be one of the `eligible_partners` returned by GET (an existing household member with health-module access, not a child) and must not be the caller themselves - 400 otherwise; empty/absent clears it. `notify_partner_days_before` is an integer 0-14. The response is the same shape as GET, including the `eligible_partners` list.',
      }),
    },
    '/api/v1/health/cycle/feed': {
      get: op({ summary: 'Get own predicted-cycle ICS feed status', tag: 'Health' }),
      delete: op({ summary: 'Disable own predicted-cycle ICS feed', tag: 'Health', stateChanging: true }),
    },
    '/api/v1/health/cycle/feed/regenerate': {
      post: op({ summary: 'Regenerate own predicted-cycle ICS feed token', tag: 'Health', stateChanging: true, description: 'Reads no body.' }),
    },
    '/api/v1/health/export/cycle': {
      get: checked({ summary: 'Export period history as CSV', tag: 'Health', params: [PERSON_QUERY, ...DAY_QUERIES], description: 'Scoped to the viewer. Returns `text/csv`.' }),
    },
    '/api/v1/health/cycle/import': {
      post: withValidationRefusal(op({
        summary: 'Import period history from CSV',
        tag: 'Health',
        stateChanging: true,
        requestBody: body({ required: ['csv'], properties: { csv: { type: 'string', description: 'The CSV text, at most 100 KB (counted by the route in UTF-8 bytes); empty after trimming is refused.' } } }),
        responses: CYCLE_IMPORT_RESPONSES,
        description: withOrder('Body: { csv: string }. Header-tolerant CSV in the export\'s own column order (`start_date`, `end_date` first - see GET /export/cycle); extra columns are ignored. Accepts both comma and semicolon separators (German Excel exports use `;`) and both `YYYY-MM-DD` and `DD.MM.YYYY` dates (again a German-export accommodation). All-or-nothing: any invalid row rejects the whole import with 400 and up to the first 10 row errors, nothing is inserted. A row whose `start_date` matches an existing period of the caller is skipped (counted, not an error); other overlaps are allowed. Rejects with 400 if the payload exceeds 100 KB or 500 data rows. New periods take the caller\'s `default_visibility` from `/cycle/settings` (falls back to `private`). Response: `{ imported, skipped, errors: [] }`. Re-syncs the caller\'s cycle reminders once after commit. A refusal a user reaches with the file carries a `reason` (#1909): `health_cycle_import_too_large` with `params.limit_kb`, `health_cycle_import_no_rows` (header only), `health_cycle_import_too_many_rows` with `params.limit`.'),
      })),
    },
    '/api/v1/health/caregivers/me': {
      get: op({ summary: 'List who the caller may record health data for', tag: 'Health', description: 'Open to every member: it is the answer about their own rights, not about anyone else\'s data.' }),
    },
    '/api/v1/health/caregivers': {
      get: op({ summary: 'List all caregiver relationships', tag: 'Health', admin: true, description: 'Returns `{ subject_id: [caregiver_id, ...] }` for the admin rights matrix.' }),
    },
    '/api/v1/health/caregivers/{subjectId}': {
      put: checked({
        summary: 'Set who may record health data for one person',
        tag: 'Health',
        admin: true,
        stateChanging: true,
        params: [SUBJECT_ID],
        requestBody: body({
          required: ['caregiver_ids'],
          properties: {
            caregiver_ids: {
              type: 'array',
              items: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^0*[1-9][0-9]*$' }], description: `A user id. ${LEGACY_NOTE}` },
              description: 'The caregivers, exactly this list. Doubles and the person themselves fall away. Until #2810 an entry that was not a whole number fell away silently - `["abc"]` withdrew all care; now it is 400.',
            },
          },
        }),
        description: 'Sets the caregivers to exactly the list given. An empty array withdraws care, so removing is the same path as changing and needs no route of its own. A deactivated account cannot become a new caregiver: 400 with `reason: "account_deactivated"`. A member gets 403 before the request is checked.',
      }),
    },
    '/api/v1/health/cycle/visibility': {
      patch: checked({ summary: 'Set the visibility of all own cycle entries at once', tag: 'Health', stateChanging: true, requestBody: body({ required: ['visibility'], properties: { visibility: oneOf(VISIBILITIES, '`private` or `family`.') } }), description: 'Applies one visibility to every period and daily log of the CALLER. Other people\'s entries are untouched, and periods and logs move together in one transaction - either both or neither. Never exposes `cervix_mucus`, `lh_test`, `pregnancy_test` or `intimacy` to anyone else even when logs move to `family`: those four fields are stripped from every non-owner read regardless of visibility (see GET /cycle/logs).' }),
    },
    '/api/v1/health/visibility-defaults': {
      get: op({ summary: 'Get the caller\'s default visibility per health area', tag: 'Health', description: `Returns only the deviations as \`{ scope_key: visibility }\`; a missing key means \`private\`, the shipped value. Scope keys are \`vital:<type>\` per metric plus ${FLAT_SCOPE_KEYS.map((key) => `\`${key}\``).join(', ')}. The cycle tab keeps its own setting under \`/health/cycle/settings\`.` }),
      put: checked({
        summary: 'Set the caller\'s default visibility for one or more areas',
        tag: 'Health',
        stateChanging: true,
        requestBody: body({
          required: ['defaults'],
          properties: {
            defaults: {
              type: 'object',
              propertyNames: { pattern: SCOPE_KEY_PATTERN },
              additionalProperties: oneOf(VISIBILITIES, '`private` or `family`.'),
              description: `Scope key to visibility. Keys: \`vital:<type>\` (type \`[a-z][a-z0-9_]\`, at most 50) or one of ${FLAT_SCOPE_KEYS.map((key) => `\`${key}\``).join(', ')}.`,
            },
          },
        }),
        description: 'Body `{ defaults: { "vital:bp": "family", ... } }`. Named keys are replaced, unnamed ones stay. Setting `private` DELETES the row rather than storing it, so "no row" remains the only spelling of the default. Affects new entries only; a value given on the entry itself always wins. Naming `fasting` without the fasting capability is 403 `FASTING_CAPABILITY_REQUIRED` before the request is checked.',
      }),
    },
    '/api/v1/health/visibility-defaults/apply': {
      patch: checked({ summary: 'Move existing entries of one area to a visibility', tag: 'Health', stateChanging: true, requestBody: body({ required: ['scope', 'visibility'], properties: { scope: { type: 'string', pattern: SCOPE_KEY_PATTERN, description: `\`vital:<type>\` or one of ${FLAT_SCOPE_KEYS.map((key) => `\`${key}\``).join(', ')}.` }, visibility: oneOf(VISIBILITIES, '`private` or `family`.') } }), description: 'Body `{ scope, visibility }`. Touches the CALLER\'s own rows only, and only in the named area - a caregiver may tend individual entries but not relabel somebody else\'s history in one move. The target comes from the request rather than from the stored default, because `private` is not stored at all. `scope: "fasting"` without the fasting capability is 403 `FASTING_CAPABILITY_REQUIRED` before the request is checked.' }),
    },
    '/api/v1/health/prevention/types': {
      get: op({ summary: 'List the household\'s preventive-care type registry', tag: 'Health', description: 'Open to every member. Nothing is seeded - the household names its own vaccination/checkup types.' }),
      post: checked({ summary: 'Add a preventive-care type', tag: 'Health', admin: true, stateChanging: true, requestBody: body({ required: ['name', 'kind'], properties: preventionTypeFields() }), description: 'Body: { name, kind: "vaccination"|"checkup", default_interval_months?, icon?, sort_order? }. `default_interval_months` omitted/null means one-off (no recurrence). A member gets 403 before the request is checked.' }),
    },
    '/api/v1/health/prevention/types/{id}': {
      patch: checked({ summary: 'Update a preventive-care type', tag: 'Health', admin: true, params: [PREVENTION_TYPE_ID], stateChanging: true, requestBody: body({ properties: preventionTypeFields() }), description: `${PARTIAL} A member gets 403 before the request is checked.` }),
      delete: checked({ summary: 'Delete a preventive-care type', tag: 'Health', admin: true, params: [PREVENTION_TYPE_ID], stateChanging: true, description: 'Its records are kept (type_id set to NULL) with a name snapshot taken at delete time, so their history stays readable.' }),
    },
    '/api/v1/health/prevention/records': {
      get: checked({ summary: 'List preventive-care records (vaccinations/check-ups given)', tag: 'Health', params: [PERSON_QUERY, { name: 'type_id', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: `Only records of this type. ${QUERY_NOTE}` }, ...boundQueries('given_on')], description: 'Scoped to the viewer; `?user_id=` filters to a family member (their `family`-visible rows, or all of them if the viewer is a caregiver for that person).' }),
      post: checked({ summary: 'Log a preventive-care record', tag: 'Health', stateChanging: true, requestBody: body({ required: ['given_on'], properties: { ...preventionRecordFields(), user_id: OWNER } }), description: 'Body: { type_id? or name, given_on, dose_number?, batch?, provider?, note?, interval_months?, next_due_on?, reminder_offset_days?, visibility?, user_id? }. `user_id` lets a caregiver log for the person they care for (#584); the row\'s visibility then follows that person\'s own default, not the caller\'s. An unknown `type_id` answers 400 with `reason: health_prevention_selected_type_not_found`.' }),
    },
    '/api/v1/health/prevention/records/{id}': {
      patch: checked({ summary: 'Update a preventive-care record', tag: 'Health', params: [PREVENTION_RECORD_ID], stateChanging: true, requestBody: body({ properties: preventionRecordFields() }), description: `${PARTIAL} An unknown \`type_id\` answers 400 with \`reason: health_prevention_selected_type_not_found\`.` }),
      delete: checked({ summary: 'Delete a preventive-care record', tag: 'Health', params: [PREVENTION_RECORD_ID], stateChanging: true }),
    },
    '/api/v1/health/nutrition/targets': {
      get: checked({ summary: 'Get a daily nutrition target', tag: 'Health', params: [{ ...PERSON_QUERY, description: `Defaults to the signed-in user; somebody else only for a caregiver of that person (403 otherwise). ${QUERY_NOTE}` }], description: 'Defaults to the signed-in user; `?user_id=` asks for somebody the caller is a caregiver for (#584) and is 403 otherwise - a target carries no visibility of its own, so there is nothing to open. Responds `{ user_id, target }` where `target` is null when no row exists. Null is not zero: a missing row means "no target set", while a stored `sugar_g: 0` is a deliberate target of zero and the progress reads against it.' }),
      put: checked({ summary: 'Set or clear a daily nutrition target', tag: 'Health', stateChanging: true, requestBody: body({ properties: { user_id: { ...OWNER, description: `Caregiver path: the person the target belongs to; left out or \`null\`: the caller. ${LEGACY_NOTE}` }, ...nutrientSchema } }), description: 'Replaces the whole target: a nutrient left out is unset afterwards. Sparse like the fasting settings - if all eight are null (also `{}`) the row is DELETED rather than stored as zeros, so "no row" stays the only spelling of "no target". Values are 0 to 100000.' }),
    },
    '/api/v1/health/nutrition/entries': {
      get: checked({ summary: 'List logged nutrition entries', tag: 'Health', params: [PERSON_QUERY, ...DAY_QUERIES, { name: 'meal_type', in: 'query', required: false, schema: { type: 'string', enum: [...MEAL_TYPES] }, description: `Only this meal. ${QUERY_NOTE}` }], description: 'Scoped to the viewer; `?user_id=` filters to a family member (their `all`-visible rows, or every row if the viewer is a caregiver for that person). `from`/`to` compare the DATE part of `consumed_at`, which is household wall-clock time rather than an instant.' }),
      post: checked({ summary: 'Log a nutrition entry', tag: 'Health', stateChanging: true, requestBody: body({ required: ['title', 'consumed_at'], properties: { ...nutritionEntryFields(), user_id: OWNER } }), description: 'The eight nutrients are stored as VALUES, never as a reference to a recipe: editing a recipe next month must not rewrite what somebody ate last week (docs/DECISIONS.md entry 8). A nutrient left out stays null ("not stated") and is not zero. Without `visibility` the row takes the OWNER\'s default, not the caller\'s.' }),
    },
    '/api/v1/health/nutrition/entries/{id}': {
      patch: checked({ summary: 'Update a nutrition entry', tag: 'Health', params: [NUTRITION_ENTRY_ID], stateChanging: true, requestBody: body({ properties: nutritionEntryFields({ create: false }) }), description: 'Only the fields present are changed. Sending a nutrient as null clears it back to "not stated"; sending 0 states zero.' + WALL_CLOCK_INPUT }),
      delete: checked({ summary: 'Delete a nutrition entry', tag: 'Health', params: [NUTRITION_ENTRY_ID], stateChanging: true }),
    },
    '/api/v1/health/nutrition/summary': {
      get: checked({ summary: 'Today\'s nutrition totals against the target', tag: 'Health', params: [PERSON_QUERY, { name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date', pattern: DATE_PATTERN }, description: 'Defaults to today in the HOUSEHOLD time zone, not the UTC day.' }], description: 'Responds `{ date, target, totals, entryCount }`. `totals` sums only the entries the caller may see. `target` is null both when no target exists and when the caller is not a caregiver for that person - the same rule as GET /nutrition/targets. This is the identical computation the dashboard widget receives, so the tab and the tile can never disagree.' }),
    },
    '/api/v1/health/export/nutrition': {
      get: checked({ summary: 'Export nutrition entries as CSV', tag: 'Health', params: [PERSON_QUERY, ...DAY_QUERIES], description: 'Same scoping as the list route. Columns are `consumed_at, meal_type, title, energy_kcal, fat_g, saturated_fat_g, carbs_g, sugar_g, protein_g, salt_g, fiber_g, note, visibility`. A nutrient that was never stated stays an EMPTY cell rather than 0. `energy_kcal` is energy EATEN - `health_activities.calories` in the activities export is energy burnt, which is why neither column is called `calories`.' }),
    },
    '/api/v1/health/prevention/due': {
      get: checked({ summary: 'List preventive-care items due or overdue', tag: 'Health', params: [{ ...PERSON_QUERY, description: `Computes the list for a family member instead of the caller (subject to the same visibility rule as the records list). ${QUERY_NOTE}` }], description: 'Scoped to the viewer. Derived from each type\'s most recent record plus its interval - the same computation the reminder sync uses, never duplicated.' }),
    },
  });
}

/** The fields of a preventive-care type (POST requires `name` and `kind`). */
function preventionTypeFields() {
  return {
    name: text(MAX_TITLE, 'The name; empty after trimming is refused.', { nullable: false }),
    kind: oneOf(PREVENTION_KINDS, '`vaccination` or `checkup`.'),
    default_interval_months: wholeNumber(1, MAX_INTERVAL_MONTHS, `Recurrence in months, 1 to ${MAX_INTERVAL_MONTHS};`),
    icon: text(MAX_ICON, 'Lucide icon name; `null` or `""`: `syringe`.'),
    sort_order: number('Position in the list; `null` or left out: 0.'),
  };
}

/** The fields of a preventive-care record (POST requires `given_on`, and `name` without `type_id`). */
function preventionRecordFields() {
  return {
    type_id: bodyId('A type of the registry; `null` means a record without type (then `name` is required on create).'),
    name: text(MAX_TITLE, 'The name, required on create without `type_id`; `null` or `""` means none.'),
    given_on: DAY,
    dose_number: number('Which dose of a series.'),
    batch: text(MAX_SHORT, 'Batch number; `null` or `""` means none.'),
    provider: text(MAX_SHORT, 'Who gave it; `null` or `""` means none.'),
    note: NOTE,
    interval_months: wholeNumber(1, MAX_INTERVAL_MONTHS, `Own recurrence in months, 1 to ${MAX_INTERVAL_MONTHS};`),
    next_due_on: OPTIONAL_DAY,
    reminder_offset_days: wholeNumber(0, MAX_OFFSET_DAYS, `Reminder lead time in days, 0 to ${MAX_OFFSET_DAYS};`),
    visibility: VISIBILITY,
  };
}

/**
 * Haengt den Satz ueber die `reason`-Werte an jede Operation auf einer Zeile
 * (Pfad mit `{id}`) und beschreibt ihre 404. Das Fasten fuehrt eigene Gruende
 * (FASTING_NOT_FOUND) und bleibt aussen vor.
 */
function withNotFoundReasons(note, paths) {
  for (const [path, operations] of Object.entries(paths)) {
    if (!path.includes('{id}') || path.includes('/fasting/')) continue;
    for (const operation of Object.values(operations)) {
      operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
      operation.responses[404] = { description: note };
    }
  }
  return paths;
}
