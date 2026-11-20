/**
 * Module: the value lists and limits of the health input (#2810)
 * Purpose: ONE source for what a health request may carry, read by two sides
 *          that must not drift apart: the route handlers under
 *          server/routes/health/ (their hand checks) and the OpenAPI document
 *          (server/openapi/paths/health.js), whose schemas validateRequest()
 *          checks before the handler runs. Up to #2810 the lists stood as
 *          literals in the route files and the document named none of them;
 *          a value outside the list fell back silently in some routes.
 *
 *          This file imports nothing: server/openapi.js must load without
 *          node_modules (the packaging contract), and the route files reach
 *          the database. The lists of the cycle tab live in
 *          public/utils/health-cycle.js (the page builds its choices from
 *          them; it is on the frozen list of public files the server may
 *          import), the nutrient keys and meal types stay exported from
 *          server/services/health-nutrition.js as well.
 */

/** Visibility of a health row outside nutrition: the person alone or the household. */
export const VISIBILITIES = ['private', 'family'];

/**
 * Visibility of a nutrition entry: the canonical pair of docs/DECISIONS.md
 * section 5 (`all` is OPEN_ALL of server/authorize/care.ts, the open value of
 * that table).
 */
export const NUTRITION_VISIBILITIES = ['private', 'all'];

/** Status of a dose-log entry. */
export const LOG_STATUS = ['taken', 'skipped', 'pending'];

/** Flag of a lab result against its reference range (the page keeps its own in public/utils/health-labs.js). */
export const LAB_FLAGS = ['low', 'normal', 'high'];

/** Kind of a preventive-care type. */
export const PREVENTION_KINDS = ['vaccination', 'checkup'];

/** Units and short labels: vital unit, medication form and stock unit, activity intensity, lab unit. */
export const MAX_UNIT = 30;

/** A vital or activity type (free text, no list). */
export const MAX_TYPE = 50;

/** The icon name of a preventive-care type. */
export const MAX_ICON = 50;

/**
 * The longest gap of an as-needed dose, in hours: four weeks. More is a
 * schedule, not an as-needed dose (#700).
 */
export const MAX_INTERVAL_HOURS = 24 * 28;

/** Intake schedules a medication brings along when it is created (#2054). */
export const MAX_SCHEDULES_ON_CREATE = 48;

/** A recurrence interval of preventive care in months; null is one-off. */
export const MAX_INTERVAL_MONTHS = 600;

/** The lead time of a preventive-care reminder in days. */
export const MAX_OFFSET_DAYS = 365;

/** Upper bound of one nutrient value (#1326). */
export const MAX_NUTRIENT = 100000;

/**
 * The eight nutrients in the order of the EU nutrition table on the pack:
 * form, CSV header and display read them in this order.
 */
export const NUTRIENT_KEYS = [
  'energy_kcal',
  'fat_g',
  'saturated_fat_g',
  'carbs_g',
  'sugar_g',
  'protein_g',
  'salt_g',
  'fiber_g',
];

/** The meal types an entry may carry. */
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * The ranges of the cycle settings, inclusive, in days (PUT /cycle/settings).
 * @type {Record<string, [number, number]>}
 */
export const CYCLE_SETTING_RANGES = {
  cycle_length_avg: [15, 60],
  period_length_avg: [1, 15],
  luteal_length: [8, 18],
  remind_period_days_before: [0, 14],
  notify_partner_days_before: [0, 14],
};

/** Symptoms per cycle day, counted after duplicates fall away. */
export const MAX_SYMPTOMS_COUNT = 40;

/**
 * The areas of a personal visibility default besides the vitals (#958). A
 * vital metric is `vital:<type>`, the type matching VITAL_TYPE_PATTERN.
 */
export const FLAT_SCOPE_KEYS = ['meds', 'labs', 'activities', 'fasting', 'prevention', 'nutrition'];
export const VITAL_SCOPE_PREFIX = 'vital:';
/** A vital type inside a scope key, as text (the document carries it). */
const VITAL_TYPE_PATTERN = '^[a-z][a-z0-9_]{0,49}$';

/** Every scope key a visibility default may have, as one pattern. */
export const SCOPE_KEY_PATTERN = `^(?:${VITAL_SCOPE_PREFIX}${VITAL_TYPE_PATTERN.slice(1, -1)}|${FLAT_SCOPE_KEYS.join('|')})$`;
