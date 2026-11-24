/**
 * Module: the values of the settings registry (phase 2, C3)
 * Purpose: the allowed values, defaults and parsers of the settings in
 *          server/settings/registry.ts - kept apart only to keep each file
 *          readable (oxlint max-lines). Pure: no database, no side effect.
 *          Same leaf rules as the registry (`settings-is-a-leaf`).
 *
 * Erasable TS syntax only (runs through type stripping, no build).
 */

import { isWidgetId } from '../services/module-capabilities.js';
import { getSupportedLocales, isRegionTag } from '../utils/i18n.js';

export const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
export const DEFAULT_MEAL_TYPES = VALID_MEAL_TYPES.join(',');

/* THE HOUSEHOLD'S NAMES OF THE FOUR SLOTS (#1058).
 *
 * One name per slot, as the household types it - NO translation. It reads the
 * same in every language: `fr`, `fr-CA` and `fr-BE` do not agree on dinner, and
 * no locale file can settle that per household. An empty name means "take the
 * built-in word".
 *
 * AS JSON, NOT COMMA-SEPARATED like `visible_meal_types` next to it: a name may
 * contain a comma ("Znuni, spaet"), and a `split(',')` would make two of it. The
 * same reason a key with a colon does not survive a `split(':')`.
 *
 * The slot KEY stays untouched - `meals.meal_type` carries a CHECK constraint,
 * recipe suitability and the Mealie/Tandoor mapping hang on it. Renaming is a
 * display name over a stable value and migrates nothing (#514). */
export const MAX_MEAL_TYPE_NAME = 40;

/** Stored names as an object - unknown slots and empty values fall away. */
export function parseMealTypeNames(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const source = parsed as Record<string, unknown>;
  const out: Record<string, string> = {};
  // An allowlist, not a denylist: a slot that does not exist (any more) does
  // not come through, whatever stands in the row.
  for (const type of VALID_MEAL_TYPES) {
    const value = typeof source[type] === 'string' ? (source[type] as string).trim() : '';
    if (value) out[type] = value.slice(0, MAX_MEAL_TYPE_NAME);
  }
  return out;
}

export const DEFAULT_CURRENCY = 'EUR';
export const DEFAULT_APP_NAME = 'Yuvomi';

export const VALID_DATE_FORMATS = ['mdy', 'dmy', 'ymd', 'mdy_dot', 'dmy_dot', 'dmy_slash', 'dmy_dash', 'ymd_dot', 'ymd_slash'];
// The default follows the other European defaults (EUR, 24h) and the client's
// i18n default (dmy): an unconfigured account shows 30.06.2026, not 06/30/2026.
// US users can still choose mdy in the settings.
export const DEFAULT_DATE_FORMAT = 'dmy';
export const VALID_TIME_FORMATS = ['24h', '12h'];
export const DEFAULT_TIME_FORMAT = '24h';

// Week start (household-wide): the weekday calendar views begin with. Monday is
// the former fixed behaviour; Sunday/Saturday on repeated requests (#484, #465).
// Stored as plain text - the client maps it to the getDay() index.
export const VALID_WEEK_STARTS = ['monday', 'sunday', 'saturday'];
export const DEFAULT_WEEK_START = 'monday';
// Budget mode (#476/#505): 'shared' = one household budget (former behaviour),
// 'personal' = personal/shared entries with a Mine/Household view.
export const VALID_BUDGET_MODES = ['shared', 'personal'];
export const DEFAULT_BUDGET_MODE = 'shared';

// The household's data language (#631, #632): the language the server STORES
// content in that it creates itself - today the titles and descriptions of the
// birthday events. Unlike the UI language (per user, in localStorage) this has to
// be household-wide: a calendar_events row has exactly one title, and the REST
// API, the ICS feed, CalDAV/Google outbound and the search read it.
// Not set = derived from the region, else English (resolveHouseholdLocale).
export const VALID_LANGUAGES = getSupportedLocales();

// The region is a display hint (a locale code like "fr-FR", or "custom"). The
// client falls back on detectRegion() for an unknown value anyway, so a check of
// the form is enough instead of a fixed list.
//
// The form comes from `isRegionTag` in utils/i18n.js and is no literal of its
// own here: the same form is READ when the data language is derived, for the
// number format and for the region question. A pattern that grows only here lets
// a value into the database that none of these readers recognises - stored and
// without effect at once.
//
// `custom` stands next to it, not inside: it is no region tag but the absence of
// a region, and exactly for that none of the three readers reads it.
export const isValidRegionValue = (value: unknown) => value === 'custom' || isRegionTag(value);

// The household's time zone (#829, household-wide). Before it the only answer to
// "where does this household live" was the container variable `TZ` - a compose
// switch a user cannot reach on Umbrel, TrueNAS or Unraid, which at the same time
// steers log timestamps and the backup cron. As a setting it can be changed,
// survives a deployment that loses the env, and can be checked.
//
// An empty value = not set = the former fallback (TZ -> system zone -> UTC), so
// an existing household notices nothing on the update.
//
// Checked against ICU (`isValidTimeZone`), not against a list in the repo: a
// maintained constant would drift from what `Intl` actually knows, exactly where
// nobody notices. On purpose not against `Intl.supportedValuesOf('timeZone')` -
// it returns only the canonical names and would refuse a valid alias like
// `Europe/Kiev`. The client builds the dropdown from its own ICU; a value only it
// knows gets a 400 here instead of landing silently.

// Default event duration (minutes): sets the end of new calendar events relative
// to the start and is the modal's starting duration. Limits: 5 min to 24 h.
export const DEFAULT_CALENDAR_DURATION = 60;
export const MIN_CALENDAR_DURATION = 5;
export const MAX_CALENDAR_DURATION = 1440;

// Default reminders for new events (#497, per user): allowed offsets in minutes
// before the start (match the presets in the event modal). Cap = 5, like
// MAX_REMINDERS_PER_ENTITY in server/routes/reminders.js.
export const VALID_REMINDER_OFFSETS = [0, 15, 60, 1440, 2880, 10080, 20160];
export const MAX_DEFAULT_REMINDERS = 5;

// Default sync target for one's own new events (#620, per user). Stored is
// exactly the id the event modal carries anyway: '' (save locally),
// 'google:<calendarId>' or 'caldav:<accountId>|<calendarUrl>'. Checked with
// parseSyncTargetValue from the shared util - the same function the frontend
// builds and reads the id with, so server and client do not grow separate ideas
// of the format.
//
// Only the FORM is checked, not the existence. A calendar can be switched off,
// deleted or made read-only long after somebody chose it here; a check of
// existence on save would not prevent that, but pull a Google API call into every
// settings save. Instead the modal decides on opening: if the target is no longer
// in the list, the preselection stays on "Local" (see applyDefaultSyncTarget).
//
// Per user, no admin gate: the neighbour keys calendar_default_reminders and
// calendar_default_assign_me are per user for the same reason (#497/#498) - who
// fills which calendar is a personal decision.
export const MAX_CALENDAR_TARGET_LENGTH = 500;

// Default points for new tasks (#578, household-wide). 0 = no default, the
// points field stays empty as before. The maximum is the one of a task,
// TASK_MAX_POINTS in server/services/task-fields.js (the settings stay a leaf
// and import no service, depcruise `settings-is-a-leaf`); test:validate-tasks
// holds the two equal.
const DEFAULT_TASK_POINTS = 0;
export const MAX_TASK_POINTS = 10000;

/**
 * This many days an expired countdown stays before it drops out silently - as
 * long as the household sets nothing else (#969).
 *
 * Seven, because the grace period should cover a week of everyday life: who does
 * not look on Friday still finds the missed deadline on Monday. Longer would be
 * no grace period but a second task list - and this tile is expressly none.
 *
 * It stands here, in the registry of the setting, and services/countdowns.js
 * reads it from here: one answer, not two (docs/DECISIONS.md #2).
 */
export const DEFAULT_OVERDUE_GRACE_DAYS = 7;
// The maximum grace period in days (#969, household-wide).
export const MAX_COUNTDOWN_GRACE_DAYS = 90;

/** Stored default reminders as a sorted number array (empty = none). */
export function parseDefaultReminders(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.map(Number).filter((n) => VALID_REMINDER_OFFSETS.includes(n)))]
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Stored default points as a whole number in the valid range. */
export function parseTaskDefaultPoints(raw: string | null): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TASK_POINTS;
  return Math.min(n, MAX_TASK_POINTS);
}

/**
 * Stored countdown grace period - unlike parseTaskDefaultPoints, `0` is a valid,
 * deliberately set value here ("no grace period") and does not fall back on the
 * default.
 */
export function parseCountdownGraceDays(raw: string | null): number {
  if (raw === null || raw === undefined) return DEFAULT_OVERDUE_GRACE_DAYS;
  const n = Math.trunc(Number(raw));
  if (!Number.isInteger(n) || n < 0) return DEFAULT_OVERDUE_GRACE_DAYS;
  return Math.min(n, MAX_COUNTDOWN_GRACE_DAYS);
}

export const VALID_WEATHER_PROVIDERS = ['open-meteo', 'openweathermap'];
export const VALID_WEATHER_UNITS = ['metric', 'imperial'];

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const COUNTRY_ISO_RE = /^[A-Z]{2}$/;
export const SUBDIVISION_RE = /^[A-Z]{2}-[A-Z0-9-]{1,10}$/;

// Widget ids are client-owned. The server checks only a safe storage shape, so
// adding or removing dashboard widgets never needs a matching backend registry
// change. The grammar itself stands in services/module-capabilities.js - where
// `fullWidgetId()` puts it together. A second version here caused #1013: it did
// not know the colon of third-party module ids.
const MAX_DASHBOARD_WIDGETS = 64;
const VALID_WIDGET_SIZES = ['1x1', '1x2', '1x3', '1x4', '2x1', '2x2', '2x3', '2x4', '3x1', '3x2', '3x3', '3x4', '4x1', '4x2', '4x3', '4x4'];
const DEFAULT_WIDGET_CONFIG = '[]';
// Limits of the widget options (#814). They describe the STORAGE FORM, not the
// meaning: which options a widget knows only the frontend knows.
const WIDGET_OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_WIDGET_OPTION_KEYS = 8;
const MAX_WIDGET_OPTION_VALUES = 50;
const MAX_WIDGET_OPTION_LENGTH = 64;

// Which quick-start templates the shift plan offers
// (public/pages/schedule.js#PRESET_TEMPLATES) - household-wide and admin-only
// like disabled_modules, not per user like hidden_modules: the templates create
// shared shift types, and the question which buttons show for it has the same
// reach. A household that needs only work should not see school/university
// buttons forever (user request).
export const SCHEDULE_TEMPLATE_KEYS = ['work', 'school', 'university'];

/**
 * Module slugs the settings can switch off. Dashboard and settings are left out
 * on purpose - they are essential. Exported for
 * test/test-disabled-module-reminders.js: every reminder origin must point at
 * one of these keys, or the household switch never reaches it (#1279).
 */
export const TOGGLEABLE_MODULES = [
  'tasks', 'calendar', 'meals', 'recipes', 'shopping', 'pantry', 'inventory',
  'birthdays', 'notes', 'contacts', 'budget', 'documents',
  'housekeeping', 'waste', 'rewards', 'health', 'schedule',
];
export const MODULE_ORDER_RE = /^(dashboard|tasks|calendar|meals|recipes|shopping|pantry|inventory|birthdays|notes|contacts|budget|documents|housekeeping|waste|rewards|health|schedule|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const MOBILE_NAV_ORDER_RE = /^(tasks|calendar|kitchen|meals|recipes|shopping|pantry|inventory|birthdays|notes|contacts|budget|documents|housekeeping|waste|rewards|health|schedule|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const KITCHEN_NAV_IDS = new Set(['kitchen', 'meals', 'recipes', 'shopping', 'pantry']);

type Widget = { id: string; visible: boolean; order: number; size: string; options?: Record<string, unknown> };

/**
 * The options of a widget - the server checks their FORM and nothing else (#814).
 *
 * Widget ids belong to the frontend since ever: a new widget costs no backend
 * change, because no registry stands here that would have to know it. The same
 * holds for the options, for the same reason - a server-side list "which widget
 * knows which option" would be the cheap start and then the price of every
 * further widget. What the server must prevent is only that unlimited foreign
 * content lands in `sync_config`.
 *
 * Allowed are booleans, finite numbers, short strings and lists of short strings
 * OR whole numbers (#1063 phase 10: the waste tile filters by type ids, not
 * category keys - so a list may no longer carry strings only; ids are integers,
 * so the list lets only integers through instead of any finite number like 1e308
 * or fractions). Nested objects not: they would have no depth limit, and no
 * widget needs them.
 *
 * @returns the normalised options, or null when the form is wrong
 */
function normalizeWidgetOptions(input: unknown): Record<string, unknown> | null {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length > MAX_WIDGET_OPTION_KEYS) return null;

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!WIDGET_OPTION_KEY_RE.test(key)) return null;
    const value = source[key];
    if (typeof value === 'boolean') { out[key] = value; continue; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      out[key] = value; continue;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_WIDGET_OPTION_LENGTH) return null;
      out[key] = value; continue;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_WIDGET_OPTION_VALUES) return null;
      if (!value.every((v) => (typeof v === 'string' && v.length <= MAX_WIDGET_OPTION_LENGTH)
        || (typeof v === 'number' && Number.isInteger(v)))) return null;
      out[key] = [...value];
      continue;
    }
    return null;
  }
  return out;
}

export function normalizeWidgetConfig(input: unknown): Widget[] | null {
  if (!Array.isArray(input) || input.length > MAX_DASHBOARD_WIDGETS) return null;

  const seenIds = new Set<unknown>();
  const normalized: Widget[] = [];
  for (const [index, entry] of input.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const widget = entry as Record<string, unknown>;
    if (!isWidgetId(widget.id) || seenIds.has(widget.id)) return null;
    if (widget.visible !== undefined && typeof widget.visible !== 'boolean') return null;
    if (widget.order !== undefined && !Number.isFinite(Number(widget.order))) return null;
    if (widget.size !== undefined && !VALID_WIDGET_SIZES.includes(widget.size as string)) return null;
    const options = normalizeWidgetOptions(widget.options);
    if (options === null) return null;

    seenIds.add(widget.id);
    normalized.push({
      id: widget.id as string,
      visible: widget.visible !== false,
      order: widget.order === undefined ? index : Number(widget.order),
      size: (widget.size as string | undefined) ?? '1x1',
      // An empty options object is not carried along: it would be the same empty
      // brace in every stored layout and a field that says nothing in every answer.
      ...(Object.keys(options).length ? { options } : {}),
    });
  }

  return normalized
    .sort((a, b) => a.order - b.order)
    .map((widget, order) => ({ ...widget, order }));
}

export function parseWidgetConfig(raw: string | null): Widget[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? DEFAULT_WIDGET_CONFIG);
    return normalizeWidgetConfig(parsed) ?? [];
  } catch {
    return JSON.parse(DEFAULT_WIDGET_CONFIG);
  }
}

// The phone arrangement: only { id, visible, order }, no size and no options.
// Checked through normalizeWidgetConfig (knows every valid id, checks duplicates).
export function parsePhoneWidgetConfig(raw: string): Array<Pick<Widget, 'id' | 'visible' | 'order'>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeWidgetConfig(parsed);
    if (!normalized) return [];
    return normalized.map(({ id, visible, order }) => ({ id, visible, order }));
  } catch {
    return [];
  }
}

export function parseDisabledModules(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m));
  } catch {
    return [];
  }
}

// TWO DIFFERENT QUESTIONS TO THE SAME MODULE LIST (#673).
//
// `disabled_modules` (household-wide, admin) means: this module does not exist
// here - it disappears from the navigation AND the route guard sends everyone
// back to the dashboard. `hidden_modules` (per user, no admin check) means: I do
// not need it on my screen. It tidies the navigation and takes NOTHING away: a
// deep link from a notification or a jump from a dashboard widget still opens the
// page. Who really wants to withdraw something has the rights in
// `member_permissions` for it - hiding is tidying, not withdrawing, and the two
// must not melt into one mechanism.
//
// The same allowlist as the household switch: overview and settings cannot be
// hidden personally either, or somebody hides the way back to exactly this switch.
export function parseHiddenModules(raw: string | null): string[] {
  return parseDisabledModules(raw);
}

export function parseScheduleHiddenTemplates(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key) => typeof key === 'string' && SCHEDULE_TEMPLATE_KEYS.includes(key));
  } catch {
    return [];
  }
}

export function parseModuleOrder(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id) => typeof id === 'string' && MODULE_ORDER_RE.test(id)))];
  } catch {
    return [];
  }
}

export function normalizeMobileNavOrder(order: unknown): string[] {
  const normalized: string[] = [];

  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id !== 'string' || !MOBILE_NAV_ORDER_RE.test(id)) continue;
    const normalizedId = KITCHEN_NAV_IDS.has(id) ? 'kitchen' : id;
    if (!normalized.includes(normalizedId)) normalized.push(normalizedId);
    if (normalized.length === 3) break;
  }

  return normalized;
}

export function parseMobileNavOrder(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return normalizeMobileNavOrder(JSON.parse(raw));
  } catch {
    return [];
  }
}

